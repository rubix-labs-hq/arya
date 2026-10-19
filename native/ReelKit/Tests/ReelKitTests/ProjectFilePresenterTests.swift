import Darwin
import Foundation
import XCTest
@testable import ReelKit

final class ProjectFilePresenterTests: XCTestCase {
    final class Presenter: NSObject, NSFilePresenter, @unchecked Sendable {
        let presentedItemURL: URL?
        let presentedItemOperationQueue: OperationQueue
        let writes: ProjectWriteAdmission
        let onWriter: @Sendable () -> Void
        let busy: Bool
        private let lock = NSLock()
        private var count = 0, bytes = Data()
        var writerCount: Int { lock.withLock { count } }
        var published: Data { lock.withLock { bytes } }
        init(file: URL, writes: ProjectWriteAdmission, busy: Bool = false, onWriter: @escaping @Sendable () -> Void = {}) {
            presentedItemURL = file; self.writes = writes; self.busy = busy; self.onWriter = onWriter
            presentedItemOperationQueue = OperationQueue(); presentedItemOperationQueue.maxConcurrentOperationCount = 1
            super.init()
        }
        func projectFileDidPublish(_ data: Data) { lock.withLock { bytes = data } }
        func relinquishPresentedItem(toWriter writer: @escaping @Sendable ((@Sendable () -> Void)?) -> Void) {
            lock.withLock { count += 1 }
            if busy { writes.setBlockedReason("Files is updating the project document.") }
            onWriter()
            writer { [self] in
                if busy, writes.blockedReason == "Files is updating the project document." { writes.setBlockedReason(nil) }
            }
        }
    }
    private func backend(_ folder: ProjectFolder, _ writes: ProjectWriteAdmission, associated: Bool) throws -> ReelBackend {
        #if ARYA_PRESENTER_BASELINE
        return try ReelBackend(folder: folder, coreScript: Support.core(), writeAdmission: { try writes.requireWritable() }, events: { _, _ in })
        #else
        return try ReelBackend(folder: folder, coreScript: Support.core(), writeAdmission: { try writes.requireWritable() }, projectFileAccess: associated ? writes.projectFileAccess : ProjectFileAccess(), events: { _, _ in })
        #endif
    }
    private func bind(_ presenter: Presenter, _ writes: ProjectWriteAdmission) {
        #if !ARYA_PRESENTER_BASELINE
        writes.projectFileAccess.setPresenter(presenter, for: presenter.presentedItemURL!)
        #endif
        NSFileCoordinator.addFilePresenter(presenter)
    }
    func testUnassociatedRegisteredPresenterActuallyBlocksImportAndRetainsCompletedCopy() async throws {
        let root = try Support.tempFolder("presenter-control"), folder = ProjectFolder(root: root), writes = ProjectWriteAdmission()
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = try backend(folder, writes, associated: false)
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Control\"}")
        let before = try Data(contentsOf: folder.projectFile), version = await backend.currentVersion()
        let source = Support.fixture("tone.m4a"), original = try Data(contentsOf: source)
        let presenter = Presenter(file: folder.projectFile, writes: writes, busy: true)
        NSFileCoordinator.addFilePresenter(presenter)
        defer { NSFileCoordinator.removeFilePresenter(presenter) }
        do { _ = try await backend.copyIn([source]); XCTFail("The unassociated writer must receive a real presenter busy rejection") }
        catch {
            XCTAssertTrue(error.localizedDescription.contains("Files is updating the project document."), error.localizedDescription)
            XCTAssertTrue(error.localizedDescription.contains("Completed copies remain unregistered"), error.localizedDescription)
        }
        XCTAssertGreaterThan(presenter.writerCount, 0)
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
        XCTAssertEqual(try Data(contentsOf: folder.mediaDir.appendingPathComponent("tone.m4a")), original)
        XCTAssertEqual(try Data(contentsOf: source), original)
        let after = await backend.currentVersion(); XCTAssertEqual(after, version)
        await backend.stop()
    }
    /// Root runs this same test on frozen V26 with ARYA_PRESENTER_BASELINE for the causal red result.
    func testOwnedPresenterImportRegistersAndPublishesCacheWithoutOwnBusyCallback() async throws {
        let root = try Support.tempFolder("presenter-owner"), folder = ProjectFolder(root: root), writes = ProjectWriteAdmission()
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = try backend(folder, writes, associated: true)
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Owned\"}")
        let source = Support.fixture("tone.m4a"), original = try Data(contentsOf: source)
        let presenter = Presenter(file: folder.projectFile, writes: writes, busy: true)
        bind(presenter, writes)
        defer { NSFileCoordinator.removeFilePresenter(presenter) }
        do { _ = try await backend.copyIn([source]) }
        catch { NSFileCoordinator.removeFilePresenter(presenter); await backend.stop(); throw error }
        let current = await backend.currentProject()
        let project = try XCTUnwrap(current)
        let assets = try XCTUnwrap(parse(project)["assets"] as? [String: Any])
        XCTAssertNotNil(assets["media/tone.m4a"])
        XCTAssertEqual(presenter.writerCount, 0)
        #if !ARYA_PRESENTER_BASELINE
        XCTAssertEqual(presenter.published, try Data(contentsOf: folder.projectFile))
        #endif
        XCTAssertEqual(try Data(contentsOf: source), original)
        // A second atomic replacement proves the anchor advanced from the staged descriptor.
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Second publication\"}")
        #if !ARYA_PRESENTER_BASELINE
        XCTAssertEqual(presenter.published, try Data(contentsOf: folder.projectFile))
        #endif
        await backend.stop()
        NSFileCoordinator.removeFilePresenter(presenter)
        let reopened = try ReelBackend(folder: folder, coreScript: Support.core(), events: { _, _ in })
        try await reopened.start()
        let currentReopened = await reopened.currentProject()
        let loaded = try XCTUnwrap(currentReopened)
        XCTAssertEqual(parse(loaded)["name"] as? String, "Second publication")
        await reopened.stop()
    }
    #if !ARYA_PRESENTER_BASELINE
    func testExternalPresenterConflictAndCloseStillBlockInsideCoordinatedWrite() async throws {
        for reason in ["This project has a Files conflict.", "The project was closed."] {
            let root = try Support.tempFolder("presenter-external"), folder = ProjectFolder(root: root), writes = ProjectWriteAdmission()
            defer { try? FileManager.default.removeItem(at: root) }
            let backend = try backend(folder, writes, associated: true)
            try await backend.start()
            _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
            let before = try Data(contentsOf: folder.projectFile), version = await backend.currentVersion()
            let owner = Presenter(file: folder.projectFile, writes: writes, busy: true)
            bind(owner, writes)
            let external = Presenter(file: folder.projectFile, writes: writes, onWriter: { writes.setBlockedReason(reason) })
            NSFileCoordinator.addFilePresenter(external)
            defer { NSFileCoordinator.removeFilePresenter(owner); NSFileCoordinator.removeFilePresenter(external) }
            do { _ = try await backend.copyIn([Support.fixture("tone.m4a")]); XCTFail("External admission must still reject") }
            catch { XCTAssertTrue(error.localizedDescription.contains(reason), error.localizedDescription) }
            XCTAssertEqual(owner.writerCount, 0); XCTAssertGreaterThan(external.writerCount, 0)
            XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
            XCTAssertTrue(owner.published.isEmpty)
            let after = await backend.currentVersion(); XCTAssertEqual(after, version)
            await backend.stop()
        }
    }
    func testSameByteReplacementCannotBeAdoptedBeforeCommitIdentityCapture() async throws {
        let root = try Support.tempFolder("presenter-replaced"), folder = ProjectFolder(root: root), writes = ProjectWriteAdmission()
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = try backend(folder, writes, associated: true)
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let before = try Data(contentsOf: folder.projectFile), version = await backend.currentVersion()
        let owner = Presenter(file: folder.projectFile, writes: writes)
        bind(owner, writes); defer { NSFileCoordinator.removeFilePresenter(owner) }
        try FileManager.default.moveItem(at: folder.projectFile, to: root.appendingPathComponent("moved-project.json"))
        try before.write(to: folder.projectFile)
        do { _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}"); XCTFail("The old URL must not adopt a different inode") }
        catch { XCTAssertTrue(error.localizedDescription.contains("replaced or moved"), error.localizedDescription) }
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("moved-project.json")), before)
        let after = await backend.currentVersion(); XCTAssertEqual(after, version)
        await backend.stop()
    }
    func testReplacementWhileExternalPresenterRelinquishesRejectsInsideAccessor() async throws {
        let root = try Support.tempFolder("presenter-accessor-replaced"), folder = ProjectFolder(root: root), writes = ProjectWriteAdmission()
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = try backend(folder, writes, associated: true)
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let before = try Data(contentsOf: folder.projectFile)
        let owner = Presenter(file: folder.projectFile, writes: writes)
        bind(owner, writes)
        let external = Presenter(file: folder.projectFile, writes: writes, onWriter: {
            do { try before.write(to: folder.projectFile, options: .atomic) }
            catch { XCTFail(error.localizedDescription) }
        })
        NSFileCoordinator.addFilePresenter(external)
        defer { NSFileCoordinator.removeFilePresenter(owner); NSFileCoordinator.removeFilePresenter(external) }
        do { _ = try await backend.copyIn([Support.fixture("tone.m4a")]); XCTFail("Accessor must recheck its pinned identity") }
        catch { XCTAssertTrue(error.localizedDescription.contains("replaced or moved"), error.localizedDescription) }
        XCTAssertGreaterThan(external.writerCount, 0)
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
        XCTAssertTrue(owner.published.isEmpty)
        await backend.stop()
    }
    func testCancellationWhileRealPresenterWaitsPreservesProjectAndRetainedCopy() async throws {
        let root = try Support.tempFolder("presenter-cancel"), folder = ProjectFolder(root: root), writes = ProjectWriteAdmission()
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = try backend(folder, writes, associated: true)
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let before = try Data(contentsOf: folder.projectFile)
        let owner = Presenter(file: folder.projectFile, writes: writes)
        bind(owner, writes)
        let entered = expectation(description: "Foundation invoked external writer relinquish"), release = DispatchSemaphore(value: 0)
        let external = Presenter(file: folder.projectFile, writes: writes, onWriter: { entered.fulfill(); release.wait() })
        NSFileCoordinator.addFilePresenter(external)
        defer { release.signal(); NSFileCoordinator.removeFilePresenter(owner); NSFileCoordinator.removeFilePresenter(external) }
        let importing = Task { try await backend.copyIn([Support.fixture("tone.m4a")]) }
        await fulfillment(of: [entered], timeout: 10)
        importing.cancel(); release.signal()
        do { _ = try await importing.value; XCTFail("Cancellation must survive Foundation coordination") }
        catch { XCTAssertTrue(error is CancellationError, error.localizedDescription) }
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
        XCTAssertTrue(owner.published.isEmpty)
        XCTAssertEqual(try Data(contentsOf: folder.mediaDir.appendingPathComponent("tone.m4a")), try Data(contentsOf: Support.fixture("tone.m4a")))
        await backend.stop()
    }
    func testPublicationPreparationFailureAndFinalAdmissionDoNotPublishOrUpdateCache() async throws {
        let root = try Support.tempFolder("presenter-prepare-failure"), folder = ProjectFolder(root: root), writes = ProjectWriteAdmission()
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = try backend(folder, writes, associated: true)
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let before = try Data(contentsOf: folder.projectFile)
        let store = try NativeProjectRecovery.Store(folder: folder), expected = try store.currentRead()
        var published = false
        XCTAssertThrowsError(try store.replace(before, expected: before, expectedIdentity: expected, preserveOriginal: false,
            admission: {}, validate: { _ = try JSONSerialization.jsonObject(with: Data($0.utf8)) },
            preparePublication: { _ in throw ReelBackend.APIError("Descriptor preparation failed") }))
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
        var checks = 0
        XCTAssertThrowsError(try store.replace(before, expected: before, expectedIdentity: expected, preserveOriginal: false,
            admission: { checks += 1; if checks == 2 { throw ReelBackend.APIError("Closed before final admission") } },
            validate: { _ = try JSONSerialization.jsonObject(with: Data($0.utf8)) }, preparePublication: { fd in
                var held = Darwin.stat(); XCTAssertEqual(fstat(fd, &held), 0)
                return { published = true }
            }))
        XCTAssertFalse(published); XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
        await backend.stop()
    }
    func testClearedAndReleasedOwnersDoNotLeakAssociationAcrossSessions() throws {
        let root = try Support.tempFolder("presenter-lifetime"), folder = ProjectFolder(root: root), writes = ProjectWriteAdmission()
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("{}".utf8).write(to: folder.projectFile)
        var owner: Presenter? = Presenter(file: folder.projectFile, writes: writes)
        weak var released = owner
        writes.projectFileAccess.setPresenter(owner!, for: folder.projectFile)
        owner = nil; XCTAssertNil(released)
        XCTAssertThrowsError(try writes.projectFileAccess.coordinate(for: folder.projectFile) { _ in () })
        writes.setBlockedReason("The project was closed."); writes.projectFileAccess.clearPresenter()
        XCTAssertThrowsError(try writes.requireWritable())
        let other = ProjectWriteAdmission(), current = Presenter(file: folder.projectFile, writes: other)
        other.projectFileAccess.setPresenter(current, for: folder.projectFile)
        XCTAssertNoThrow(try other.projectFileAccess.coordinate(for: folder.projectFile) { try $0.requireCurrent() })
    }
    #endif
}
#if !ARYA_PRESENTER_BASELINE
extension ProjectFilePresenterTests.Presenter: ProjectFilePresenter {}
#endif
