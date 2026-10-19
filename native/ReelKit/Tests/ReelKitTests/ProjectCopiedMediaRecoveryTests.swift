import Foundation
import XCTest
@testable import ReelKit

final class ProjectCopiedMediaRecoveryTests: XCTestCase {
    private func backend(_ root: URL) throws -> ReelBackend {
        try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), probe: { url in
            let bytes = try Data(contentsOf: url)
            return .object([("size", .int(bytes.count)), ("width", 1), ("height", 1), ("still", true), ("hasVideo", false), ("hasAudio", false)])
        }) { _, _ in }
    }
    private func file(_ root: URL, _ name: String = "café take.png") throws -> URL {
        let folder = root.appendingPathComponent("media")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(name)
        try Data(repeating: 0x61, count: 100).write(to: url)
        return url
    }
    private func parse(_ value: JSON) throws -> [String: Any] { try XCTUnwrap(try JSON.parse(value.text) as? [String: Any]) }
    private func copies(_ value: JSON) throws -> ([String], [String: String], Int, String) {
        let fields = try parse(value)
        return (try XCTUnwrap(fields["unregisteredCopies"] as? [String]),
                try XCTUnwrap(fields["retainedCopyIdentities"] as? [String: String]),
                try XCTUnwrap(fields["version"] as? Int), try XCTUnwrap(fields["recoveryID"] as? String))
    }
    func testReadOnlyInventoryThenExactRegistrationAndDuplicateAvoidance() async throws {
        let root = try Support.tempFolder("copied-recovery-success")
        defer { try? FileManager.default.removeItem(at: root) }
        let b = try backend(root); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Recover\"}")
        let url = try file(root), bytes = try Data(contentsOf: url)
        let saved = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        let version = await b.currentVersion(), before = await b.currentProject()
        let inventory = try await b.recoveryMediaCandidates(expectedVersion: version)
        let (paths, identities, capturedVersion, recoveryID) = try copies(inventory)
        XCTAssertEqual(paths, ["media/café take.png"]); XCTAssertEqual(Set(identities.keys), Set(paths))
        let fields = try parse(inventory)
        XCTAssertEqual(fields["rootPath"] as? String, root.standardizedFileURL.path)
        XCTAssertEqual(fields["project"] as? NSDictionary, try JSON.parse(try XCTUnwrap(before)) as? NSDictionary)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), saved)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        let unchangedVersion = await b.currentVersion(); XCTAssertEqual(unchangedVersion, version)
        let receipt = try parse(try await b.registerRecoveryMedia(paths, recoveryID: recoveryID, expectedVersion: capturedVersion, retainedCopyIdentities: identities))
        XCTAssertEqual(Set((receipt["assets"] as? [String: Any] ?? [:]).keys), Set(paths))
        XCTAssertEqual(receipt["version"] as? Int, version + 1)
        let currentProject = await b.currentProject()
        let project = try XCTUnwrap(currentProject)
        let refreshed = try XCTUnwrap(try JSON.parse(project) as? [String: Any])
        XCTAssertNotNil((refreshed["assets"] as? [String: Any])?[paths[0]])
        let currentVersion = await b.currentVersion()
        let after = try copies(try await b.recoveryMediaCandidates(expectedVersion: currentVersion))
        XCTAssertTrue(after.0.isEmpty); XCTAssertTrue(after.1.isEmpty)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("media").path), ["café take.png"])
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        await b.stop()
    }
    func testStaleAdmissionAndChangedProjectRejectBeforeRegistering() async throws {
        let root = try Support.tempFolder("copied-recovery-stale")
        defer { try? FileManager.default.removeItem(at: root) }
        let b = try backend(root); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"First\"}")
        _ = try file(root)
        let version = await b.currentVersion()
        let (paths, identities, _, recoveryID) = try copies(try await b.recoveryMediaCandidates(expectedVersion: version))
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Second\"}")
        let saved = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        do { _ = try await b.recoveryMediaCandidates(expectedVersion: version); XCTFail("Stale recovery inventory admitted") } catch { XCTAssertTrue(error.localizedDescription.contains("project changed")) }
        do { _ = try await b.registerRecoveryMedia(paths, recoveryID: recoveryID, expectedVersion: version, retainedCopyIdentities: identities); XCTFail("Recovery registered into a changed project") } catch { XCTAssertTrue(error.localizedDescription.contains("project changed")) }
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), saved)
        await b.stop()
    }
    func testReplacedFileIdentityRejectsAndPreservesBothFiles() async throws {
        let root = try Support.tempFolder("copied-recovery-drift")
        defer { try? FileManager.default.removeItem(at: root) }
        let b = try backend(root); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let url = try file(root), version = await b.currentVersion()
        let (paths, identities, _, recoveryID) = try copies(try await b.recoveryMediaCandidates(expectedVersion: version))
        let held = root.appendingPathComponent("kept-original.png")
        try FileManager.default.moveItem(at: url, to: held)
        try Data(repeating: 0x62, count: 100).write(to: url)
        let saved = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        do { _ = try await b.registerRecoveryMedia(paths, recoveryID: recoveryID, expectedVersion: version, retainedCopyIdentities: identities); XCTFail("Replaced identity registered") } catch { XCTAssertTrue(error.localizedDescription.contains("changed or was replaced")) }
        XCTAssertEqual(try Data(contentsOf: held), Data(repeating: 0x61, count: 100))
        XCTAssertEqual(try Data(contentsOf: url), Data(repeating: 0x62, count: 100))
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), saved)
        await b.stop()
    }
    func testDirectoryReplacementDoesNotExpandIntoUnrequestedFiles() async throws {
        let root = try Support.tempFolder("copied-recovery-directory")
        defer { try? FileManager.default.removeItem(at: root) }
        let b = try backend(root); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let url = try file(root), version = await b.currentVersion()
        let (paths, identities, _, recoveryID) = try copies(try await b.recoveryMediaCandidates(expectedVersion: version))
        try FileManager.default.moveItem(at: url, to: root.appendingPathComponent("kept-original.png"))
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        let child = url.appendingPathComponent("unexpected.png"); try Data(repeating: 0x61, count: 100).write(to: child)
        do { _ = try await b.registerRecoveryMedia(paths, recoveryID: recoveryID, expectedVersion: version, retainedCopyIdentities: identities); XCTFail("Recovery recursively expanded a directory") } catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        let currentProject = await b.currentProject()
        let actual = try XCTUnwrap(currentProject)
        XCTAssertTrue(((try JSON.parse(actual) as? [String: Any])?["assets"] as? [String: Any] ?? [:]).isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: child.path))
        await b.stop()
    }
    func testInventoryExcludesLinksHiddenFilesAndSubdirectories() async throws {
        let root = try Support.tempFolder("copied-recovery-confined"), outside = try Support.tempFolder("copied-recovery-outside")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: outside) }
        let b = try backend(root); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        _ = try file(root, "good.png"); _ = try file(root, ".hidden.png")
        let original = try file(outside, "original.png"), bytes = try Data(contentsOf: original)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("media/link.png"), withDestinationURL: original)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("media/nested.png"), withIntermediateDirectories: false)
        let version = await b.currentVersion()
        let inventory = try copies(try await b.recoveryMediaCandidates(expectedVersion: version))
        XCTAssertEqual(inventory.0, ["media/good.png"])
        XCTAssertEqual(try Data(contentsOf: original), bytes)
        await b.stop()
    }
    func testSymlinkMediaRootIsRejectedWithoutReadingExternalFiles() async throws {
        let root = try Support.tempFolder("copied-recovery-root"), outside = try Support.tempFolder("copied-recovery-root-outside")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: outside) }
        let b = try backend(root); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let media = root.appendingPathComponent("media")
        if FileManager.default.fileExists(atPath: media.path) { try FileManager.default.moveItem(at: media, to: root.appendingPathComponent("kept-media")) }
        let external = try file(outside, "outside.png"), bytes = try Data(contentsOf: external)
        try FileManager.default.createSymbolicLink(at: media, withDestinationURL: outside.appendingPathComponent("media"))
        let version = await b.currentVersion()
        do { _ = try await b.recoveryMediaCandidates(expectedVersion: version); XCTFail("Linked media root admitted") } catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        XCTAssertEqual(try Data(contentsOf: external), bytes)
        await b.stop()
    }
    func testInventoryIsBoundedAndCancellationDoesNotMutate() async throws {
        let root = try Support.tempFolder("copied-recovery-bounds")
        defer { try? FileManager.default.removeItem(at: root) }
        let b = try backend(root); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        for number in 0..<33 { _ = try file(root, "take\(number).png") }
        let version = await b.currentVersion(), saved = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        let fields = try parse(try await b.recoveryMediaCandidates(expectedVersion: version))
        XCTAssertEqual((fields["unregisteredCopies"] as? [String])?.count, 32); XCTAssertEqual(fields["limited"] as? Bool, true)
        let task = Task { withUnsafeCurrentTask { $0?.cancel() }; return try await b.recoveryMediaCandidates(expectedVersion: version) }
        do { _ = try await task.value; XCTFail("Cancelled inventory completed") } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), saved)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("media").path).count, 33)
        await b.stop()
    }
    func testReplacementMediaDirectoryWithSameFileInodeIsRejected() async throws {
        let root = try Support.tempFolder("copied-recovery-parent-drift")
        defer { try? FileManager.default.removeItem(at: root) }
        let b = try backend(root); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let url = try file(root), version = await b.currentVersion()
        let (paths, identities, _, recoveryID) = try copies(try await b.recoveryMediaCandidates(expectedVersion: version))
        let media = root.appendingPathComponent("media"), kept = root.appendingPathComponent("kept-media")
        try FileManager.default.moveItem(at: media, to: kept)
        try FileManager.default.createDirectory(at: media, withIntermediateDirectories: false)
        try FileManager.default.linkItem(at: kept.appendingPathComponent(url.lastPathComponent), to: url)
        do { _ = try await b.registerRecoveryMedia(paths, recoveryID: recoveryID, expectedVersion: version, retainedCopyIdentities: identities); XCTFail("Changed media parent with same files admitted") }
        catch { XCTAssertTrue(error.localizedDescription.contains("media folder changed")) }
        let actual = await b.currentProject()
        XCTAssertTrue(((try JSON.parse(try XCTUnwrap(actual)) as? [String: Any])?["assets"] as? [String: Any] ?? [:]).isEmpty)
        XCTAssertEqual(try Data(contentsOf: url), Data(repeating: 0x61, count: 100))
        await b.stop()
    }
    func testSupersededInventoryAndUnlistedPathAreRejected() async throws {
        let root = try Support.tempFolder("copied-recovery-receipt")
        defer { try? FileManager.default.removeItem(at: root) }
        let b = try backend(root); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        _ = try file(root); let version = await b.currentVersion()
        let (paths, identities, _, oldID) = try copies(try await b.recoveryMediaCandidates(expectedVersion: version))
        let (_, _, _, freshID) = try copies(try await b.recoveryMediaCandidates(expectedVersion: version))
        do { _ = try await b.registerRecoveryMedia(paths, recoveryID: oldID, expectedVersion: version, retainedCopyIdentities: identities); XCTFail("Superseded inventory admitted") }
        catch { XCTAssertTrue(error.localizedDescription.contains("expired")) }
        do { _ = try await b.registerRecoveryMedia(["media/unlisted.png"], recoveryID: freshID, expectedVersion: version, retainedCopyIdentities: ["media/unlisted.png": "forged"]); XCTFail("Unlisted path admitted") }
        catch { XCTAssertTrue(error.localizedDescription.contains("expired")) }
        let freshVersion = await b.currentVersion(); XCTAssertEqual(freshVersion, version)
        await b.stop()
    }
    private final class AdmissionSwap: @unchecked Sendable {
        private let lock = NSLock()
        private var calls = 0, probes = 0
        private var action: (() throws -> Void)?
        func arm(_ action: @escaping () throws -> Void) { lock.lock(); calls = 0; self.action = action; lock.unlock() }
        func admission() throws {
            lock.lock()
            if action != nil { calls += 1 }
            let pending = calls == 2 ? action : nil
            if pending != nil { action = nil }
            lock.unlock()
            try pending?()
        }
        func probe() { lock.lock(); probes += 1; lock.unlock() }
        func probeCount() -> Int { lock.lock(); defer { lock.unlock() }; return probes }
    }
    func testDirectorySwapAtImporterHandoffRejectsBeforeSnapshotOrProbe() async throws {
        let root = try Support.tempFolder("copied-recovery-handoff")
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = AdmissionSwap()
        let b = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), probe: { url in
            gate.probe()
            return .object([("size", .int(try Data(contentsOf: url).count)), ("width", 1), ("height", 1), ("still", true), ("hasVideo", false), ("hasAudio", false)])
        }, writeAdmission: { try gate.admission() }) { _, _ in }
        try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let url = try file(root), media = root.appendingPathComponent("media")
        let replacement = root.appendingPathComponent("replacement-media"), kept = root.appendingPathComponent("kept-media")
        try FileManager.default.createDirectory(at: replacement, withIntermediateDirectories: false)
        try FileManager.default.linkItem(at: url, to: replacement.appendingPathComponent(url.lastPathComponent))
        let identity = try NativeMediaImportSource.selectedStamp(url), version = await b.currentVersion()
        let (paths, identities, _, recoveryID) = try copies(try await b.recoveryMediaCandidates(expectedVersion: version))
        let saved = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        // First admission precedes the recovery media gate. The second is inside
        // importer capture, before selectedStamp or prepare can capture a new parent.
        gate.arm {
            try FileManager.default.moveItem(at: media, to: kept)
            try FileManager.default.moveItem(at: replacement, to: media)
        }
        do { _ = try await b.registerRecoveryMedia(paths, recoveryID: recoveryID, expectedVersion: version, retainedCopyIdentities: identities); XCTFail("Recovery rebound at the importer handoff") }
        catch { XCTAssertTrue(error.localizedDescription.contains("media folder changed during registration")) }
        XCTAssertEqual(try NativeMediaImportSource.selectedStamp(url), identity)
        XCTAssertEqual(gate.probeCount(), 0)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), saved)
        XCTAssertEqual(try Data(contentsOf: url), Data(repeating: 0x61, count: 100))
        XCTAssertEqual(try Data(contentsOf: kept.appendingPathComponent(url.lastPathComponent)), Data(repeating: 0x61, count: 100))
        let current = await b.currentProject()
        XCTAssertTrue(((try JSON.parse(try XCTUnwrap(current)) as? [String: Any])?["assets"] as? [String: Any] ?? [:]).isEmpty)
        await b.stop()
    }
    private actor ProbePause {
        private var entered = false
        private var continuation: CheckedContinuation<Void, Never>?
        private var arrival: CheckedContinuation<Void, Never>?
        func pause() async {
            entered = true; arrival?.resume(); arrival = nil
            await withCheckedContinuation { continuation = $0 }
        }
        // Waits for the probe without a wall-clock deadline, which expired under full-suite load.
        func wait() async throws {
            if !entered { await withCheckedContinuation { arrival = $0 } }
        }
        func release() { continuation?.resume(); continuation = nil }
    }
    func testRecoveryDirectoryGateIsCheckedAfterAwaitedProbe() async throws {
        let root = try Support.tempFolder("copied-recovery-probe-gate")
        defer { try? FileManager.default.removeItem(at: root) }
        let pause = ProbePause()
        let b = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), probe: { url in
            await pause.pause()
            return .object([("size", .int(try Data(contentsOf: url).count)), ("width", 1), ("height", 1), ("still", true), ("hasVideo", false), ("hasAudio", false)])
        }) { _, _ in }
        try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let url = try file(root), media = root.appendingPathComponent("media")
        let replacement = root.appendingPathComponent("replacement-media"), kept = root.appendingPathComponent("kept-media")
        try FileManager.default.createDirectory(at: replacement, withIntermediateDirectories: false)
        try FileManager.default.linkItem(at: url, to: replacement.appendingPathComponent(url.lastPathComponent))
        let version = await b.currentVersion(), saved = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        let (paths, identities, _, recoveryID) = try copies(try await b.recoveryMediaCandidates(expectedVersion: version))
        let registration = Task { try await b.registerRecoveryMedia(paths, recoveryID: recoveryID, expectedVersion: version, retainedCopyIdentities: identities) }
        do {
            try await pause.wait()
            try FileManager.default.moveItem(at: media, to: kept)
            try FileManager.default.moveItem(at: replacement, to: media)
        } catch { registration.cancel(); await pause.release(); _ = try? await registration.value; throw error }
        await pause.release()
        do { _ = try await registration.value; XCTFail("Recovery committed after directory drift during probe") }
        catch { XCTAssertTrue(error.localizedDescription.contains("media folder changed during registration")) }
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), saved)
        XCTAssertEqual(try Data(contentsOf: url), Data(repeating: 0x61, count: 100))
        XCTAssertEqual(try Data(contentsOf: kept.appendingPathComponent(url.lastPathComponent)), Data(repeating: 0x61, count: 100))
        let actualVersion = await b.currentVersion(); XCTAssertEqual(actualVersion, version)
        await b.stop()
    }
}
