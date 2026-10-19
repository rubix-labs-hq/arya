import Darwin
import Foundation
import XCTest
@testable import ReelKit

final class OrdinaryImportIdentityTests: XCTestCase {
    private actor ProbeGate {
        private var entered = false
        private var released = false
        private var waiter: CheckedContinuation<Void, Never>?
        func pause() async { entered = true; if !released { await withCheckedContinuation { waiter = $0 } } }
        func waitForEntry() async throws {
            let deadline = Date().addingTimeInterval(5)
            while !entered {
                guard Date() < deadline else { throw ReelBackend.APIError("The synthetic probe did not start.") }
                await Task.yield()
            }
        }
        func release() { released = true; waiter?.resume(); waiter = nil }
    }
    private func source(_ folder: URL, name: String = "source.png", bytes: Int = 131_073) throws -> URL {
        let file = folder.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(repeating: 0x5a, count: bytes).write(to: file)
        return file
    }
    private func backend(_ root: URL, gate: ProbeGate? = nil) throws -> ReelBackend {
        try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), probe: { file in
            if let gate { await gate.pause() }
            return .object([("size", .int(try Data(contentsOf: file).count)), ("width", 1), ("height", 1),
                            ("still", true), ("hasVideo", false), ("hasAudio", false)])
        }) { _, _ in }
    }
    private func newProject(_ backend: ReelBackend, name: String) async throws {
        _ = try await backend.handle(method: "POST", path: "/api/new", body: JSON(any: ["name": name]).text)
    }
    private func fields(_ value: JSON) throws -> [String: Any] { try XCTUnwrap(JSON.parse(value.text) as? [String: Any]) }

    func testHeldSourceProducesPrivateExactSnapshotAndRetainsExternalCopy() throws {
        let project = try Support.tempFolder("import-owned"), outside = try Support.tempFolder("import-selection")
        defer { for dir in [project, outside] { try? FileManager.default.removeItem(at: dir) } }
        let selected = try source(outside), bytes = try Data(contentsOf: selected)
        var snapshot: NativeMediaImportSource.Snapshot? = try NativeMediaImportSource.prepareSync(selected, root: .init(ProjectFolder(root: project)), destination: "media/source.png")
        XCTAssertEqual(try Data(contentsOf: snapshot!.file), bytes)
        XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent("media/source.png")), bytes)
        XCTAssertEqual(try Data(contentsOf: selected), bytes)
        try snapshot!.validate()
        let stage = snapshot!.file
        snapshot = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: stage.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: project.appendingPathComponent("media/source.png").path))
    }
    func testFIFOIsRejectedBeforeAnyByteRead() throws {
        let project = try Support.tempFolder("import-fifo"), outside = try Support.tempFolder("import-fifo-source")
        defer { for dir in [project, outside] { try? FileManager.default.removeItem(at: dir) } }
        let file = outside.appendingPathComponent("fifo.mp4")
        XCTAssertEqual(mkfifo(file.path, 0o600), 0)
        XCTAssertThrowsError(try NativeMediaImportSource.selectedStamp(file))
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(file, root: .init(ProjectFolder(root: project))))
    }
    func testFolderSelectedFileSwitchedToFIFOIsRejected() throws {
        let project = try Support.tempFolder("import-selected-fifo"), outside = try Support.tempFolder("import-selected-fifo-source")
        defer { for dir in [project, outside] { try? FileManager.default.removeItem(at: dir) } }
        let selected = try source(outside)
        let selection = try NativeMediaFolderSelection.collect(outside, project: ProjectFolder(root: project))
        let item = try XCTUnwrap(selection.items.first)
        try FileManager.default.removeItem(at: selected); XCTAssertEqual(mkfifo(selected.path, 0o600), 0)
        XCTAssertThrowsError(try NativeMediaFolderSelection.validate(item, root: selection.root))
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(selected, root: .init(ProjectFolder(root: project)), expected: item.identity,
                                                                  selectionRoot: selection.root, selectionIdentity: item.rootIdentity))
    }
    func testLeafAndParentSymlinksAreRejectedWithoutReadingTarget() throws {
        let project = try Support.tempFolder("import-links"), outside = try Support.tempFolder("import-link-source")
        defer { for dir in [project, outside] { try? FileManager.default.removeItem(at: dir) } }
        let selected = try source(outside, name: "original/source.png"), bytes = try Data(contentsOf: selected)
        let link = outside.appendingPathComponent("leaf.png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: selected)
        let alias = outside.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: selected.deletingLastPathComponent())
        for file in [link, alias.appendingPathComponent("source.png")] {
            XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(file, root: .init(ProjectFolder(root: project))))
        }
        XCTAssertEqual(try Data(contentsOf: selected), bytes)
    }
    func testSameSizeSourceReplacementAfterDescriptorCaptureIsRejected() throws {
        let project = try Support.tempFolder("import-replace"), outside = try Support.tempFolder("import-replace-source")
        defer { for dir in [project, outside] { try? FileManager.default.removeItem(at: dir) } }
        let selected = try source(outside), retained = outside.appendingPathComponent("retained.png")
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(selected, root: .init(ProjectFolder(root: project)), afterDescriptorValidation: {
            try FileManager.default.moveItem(at: selected, to: retained)
            try Data(repeating: 0x41, count: 131_073).write(to: selected)
        }))
        XCTAssertEqual(try Data(contentsOf: retained), Data(repeating: 0x5a, count: 131_073))
    }
    func testMidCopyMutationRejectsRegistrationAndRemovesOwnedIncompleteCopy() throws {
        let project = try Support.tempFolder("import-mutate"), outside = try Support.tempFolder("import-mutate-source")
        defer { for dir in [project, outside] { try? FileManager.default.removeItem(at: dir) } }
        let selected = try source(outside)
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(selected, root: .init(ProjectFolder(root: project)), destination: "media/source.png", afterChunk: { total in
            if total == Int64(NativeMediaImportSource.bufferBytes) {
                let handle = try FileHandle(forWritingTo: selected); defer { try? handle.close() }
                try handle.seek(toOffset: 0); try handle.write(contentsOf: Data([0x41]))
            }
        }))
        XCTAssertFalse(FileManager.default.fileExists(atPath: project.appendingPathComponent("media/source.png").path))
        XCTAssertEqual(try Data(contentsOf: selected).first, 0x41)
    }
    func testCancelledCopyRemovesOnlyItsIncompleteOutputs() throws {
        let project = try Support.tempFolder("import-copy-cancel"), outside = try Support.tempFolder("import-copy-cancel-source")
        defer { for dir in [project, outside] { try? FileManager.default.removeItem(at: dir) } }
        let selected = try source(outside), original = try Data(contentsOf: selected)
        do {
            _ = try NativeMediaImportSource.prepareSync(selected, root: .init(ProjectFolder(root: project)), destination: "media/source.png", afterChunk: { _ in throw CancellationError() })
            XCTFail("Cancelled copy returned a snapshot")
        } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(try Data(contentsOf: selected), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: project.appendingPathComponent("media/source.png").path))
    }
    func testExclusiveCopyRefusesExistingAndDanglingLinkedDestination() throws {
        let project = try Support.tempFolder("import-collision"), outside = try Support.tempFolder("import-collision-source")
        defer { for dir in [project, outside] { try? FileManager.default.removeItem(at: dir) } }
        let selected = try source(outside), occupied = try source(project, name: "media/occupied.png", bytes: 11)
        let original = try Data(contentsOf: occupied)
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(selected, root: .init(ProjectFolder(root: project)), destination: "media/occupied.png"))
        XCTAssertEqual(try Data(contentsOf: occupied), original)
        let dangling = project.appendingPathComponent("media/dangling.png")
        try FileManager.default.createSymbolicLink(atPath: dangling.path, withDestinationPath: "missing.png")
        XCTAssertThrowsError(try NativeMediaImportSource.prepareSync(selected, root: .init(ProjectFolder(root: project)), destination: "media/dangling.png"))
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: dangling.path), "missing.png")
    }
    func testReplacedProjectRootAndSelectedParentAreRejected() throws {
        let parent = try Support.tempFolder("import-parent"), outside = try Support.tempFolder("import-parent-source")
        defer { for dir in [parent, outside] { try? FileManager.default.removeItem(at: dir) } }
        let project = parent.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let selected = try source(outside, name: "original/source.png")
        let root = try NativeMediaImportSource.Root(ProjectFolder(root: project))
        let held = try NativeMediaImportSource.prepareSync(selected, root: root)
        let moved = outside.appendingPathComponent("moved")
        try FileManager.default.moveItem(at: selected.deletingLastPathComponent(), to: moved)
        _ = try source(outside, name: "original/source.png")
        XCTAssertThrowsError(try held.validate())
        try FileManager.default.moveItem(at: project, to: parent.appendingPathComponent("prior-project"))
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        XCTAssertThrowsError(try root.validate())
    }
    func testCopiedDestinationReplacementIsDetectedAndReplacementIsNotDeleted() throws {
        let project = try Support.tempFolder("import-dest-replace"), outside = try Support.tempFolder("import-dest-replace-source")
        defer { for dir in [project, outside] { try? FileManager.default.removeItem(at: dir) } }
        let selected = try source(outside)
        var held: NativeMediaImportSource.Snapshot? = try NativeMediaImportSource.prepareSync(selected, root: .init(ProjectFolder(root: project)), destination: "media/source.png")
        let target = project.appendingPathComponent("media/source.png")
        try FileManager.default.removeItem(at: target); try Data("replacement".utf8).write(to: target)
        XCTAssertThrowsError(try held!.validate()); held = nil
        XCTAssertEqual(try Data(contentsOf: target), Data("replacement".utf8))
    }
    func testNewProjectWhileOrdinaryProbeWaitsReceivesNoImportedAsset() async throws {
        let project = try Support.tempFolder("import-probe-project")
        defer { try? FileManager.default.removeItem(at: project) }
        _ = try source(project)
        let gate = ProbeGate(), b = try backend(project, gate: gate)
        try await b.start(); try await newProject(b, name: "Before")
        let pending = Task { try await b.importMedia(["source.png"]) }
        defer { pending.cancel(); Task { await gate.release() } }
        try await gate.waitForEntry(); try await newProject(b, name: "Replacement")
        let replacement = try Data(contentsOf: project.appendingPathComponent("reel.project.json")), version = await b.currentVersion()
        await gate.release()
        do { _ = try await pending.value; XCTFail("Stale ordinary import registered") }
        catch { XCTAssertTrue(error.localizedDescription.contains("project changed")) }
        XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent("reel.project.json")), replacement)
        let after = await b.currentVersion(); XCTAssertEqual(after, version)
        let currentValue = await b.currentProject()
        let current = try XCTUnwrap(currentValue)
        XCTAssertTrue(((try JSON.parse(current) as? [String: Any])?["assets"] as? [String: Any] ?? [:]).isEmpty)
        await b.stop()
    }
    func testNewProjectWhileCopiedProbeWaitsRetainsUnregisteredExactCopy() async throws {
        let project = try Support.tempFolder("import-copy-project"), outside = try Support.tempFolder("import-copy-outside")
        defer { for dir in [project, outside] { try? FileManager.default.removeItem(at: dir) } }
        let selected = try source(outside), original = try Data(contentsOf: selected)
        let gate = ProbeGate(), b = try backend(project, gate: gate)
        try await b.start(); try await newProject(b, name: "Before")
        let pending = Task { try await b.copyIn([selected]) }
        defer { pending.cancel(); Task { await gate.release() } }
        try await gate.waitForEntry(); try await newProject(b, name: "Replacement")
        let replacement = try Data(contentsOf: project.appendingPathComponent("reel.project.json"))
        await gate.release()
        do { _ = try await pending.value; XCTFail("Stale copied import registered") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Completed copies remain unregistered")) }
        XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent("reel.project.json")), replacement)
        XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent("media/source.png")), original)
        XCTAssertEqual(try Data(contentsOf: selected), original)
        await b.stop()
    }
    func testProbeCancellationKeepsCompletedCopyAndProjectHistory() async throws {
        let project = try Support.tempFolder("import-cancel-project"), outside = try Support.tempFolder("import-cancel-outside")
        defer { for dir in [project, outside] { try? FileManager.default.removeItem(at: dir) } }
        let selected = try source(outside), original = try Data(contentsOf: selected)
        let b = try ReelBackend(folder: ProjectFolder(root: project), coreScript: Support.core(), probe: { _ in throw CancellationError() }) { _, _ in }
        try await b.start(); try await newProject(b, name: "Keep")
        let before = try Data(contentsOf: project.appendingPathComponent("reel.project.json")), version = await b.currentVersion()
        do { _ = try await b.copyIn([selected]); XCTFail("Cancellation returned success") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent("reel.project.json")), before)
        let after = await b.currentVersion(); XCTAssertEqual(after, version)
        XCTAssertEqual(try Data(contentsOf: selected), original)
        XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent("media/source.png")), original)
        await b.stop()
    }
    func testPartialProbeSuccessNamesRetainedUnregisteredCopy() async throws {
        let project = try Support.tempFolder("import-partial-project"), outside = try Support.tempFolder("import-partial-outside")
        defer { for dir in [project, outside] { try? FileManager.default.removeItem(at: dir) } }
        let good = try source(outside, name: "good.png"), bad = try source(outside, name: "bad.png")
        let b = try ReelBackend(folder: ProjectFolder(root: project), coreScript: Support.core(), probe: { file in
            if file.lastPathComponent == "bad.png" { throw ReelBackend.APIError("Synthetic probe failure") }
            return .object([("size", 131_073), ("hasVideo", false), ("hasAudio", false)])
        }) { _, _ in }
        try await b.start()
        let receipt = try fields(await b.copyIn([good, bad]))
        XCTAssertEqual(Set((receipt["assets"] as? [String: Any] ?? [:]).keys), ["media/good.png"])
        XCTAssertEqual(receipt["unregisteredCopies"] as? [String], ["media/bad.png"])
        let issues = try XCTUnwrap(receipt["failures"] as? [[String: Any]])
        XCTAssertTrue((issues.first?["error"] as? String ?? "").contains("not registered in Media"))
        XCTAssertEqual(try Data(contentsOf: bad), try Data(contentsOf: project.appendingPathComponent("media/bad.png")))
        await b.stop()
    }
    func testReadOnlyAdmissionAfterProbeKeepsCopiesAndRejectsRegistration() async throws {
        final class Admission: @unchecked Sendable {
            let lock = NSLock(); var denied = false
            func deny() { lock.lock(); denied = true; lock.unlock() }
            func check() throws { lock.lock(); defer { lock.unlock() }; if denied { throw ReelBackend.APIError("Read-only document") } }
        }
        let project = try Support.tempFolder("import-admission"), outside = try Support.tempFolder("import-admission-source")
        defer { for dir in [project, outside] { try? FileManager.default.removeItem(at: dir) } }
        let selected = try source(outside), admission = Admission(), gate = ProbeGate()
        let b = try ReelBackend(folder: ProjectFolder(root: project), coreScript: Support.core(), probe: { file in
            await gate.pause(); return .object([("size", .int(try Data(contentsOf: file).count)), ("hasVideo", false), ("hasAudio", false)])
        }, writeAdmission: { try admission.check() }) { _, _ in }
        try await b.start(); try await newProject(b, name: "Keep")
        let before = try Data(contentsOf: project.appendingPathComponent("reel.project.json"))
        let pending = Task { try await b.copyIn([selected]) }
        defer { pending.cancel(); Task { await gate.release() } }
        try await gate.waitForEntry(); admission.deny(); await gate.release()
        do { _ = try await pending.value; XCTFail("Read-only import registered") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Read-only document")) }
        XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent("reel.project.json")), before)
        XCTAssertEqual(try Data(contentsOf: selected), try Data(contentsOf: project.appendingPathComponent("media/source.png")))
        await b.stop()
    }
    func testGeneratedMusicChangedDuringLaterOrdinaryProbeHasOneNamedFailure() async throws {
        let project = try Support.tempFolder("import-music-late-change")
        defer { try? FileManager.default.removeItem(at: project) }
        _ = try source(project, name: "ordinary.png")
        let gate = ProbeGate()
        let b = try ReelBackend(folder: ProjectFolder(root: project), coreScript: Support.core(), probe: { file in
            if file.lastPathComponent == "ordinary.png" { await gate.pause() }
            return .object([("size", .int(try Data(contentsOf: file).count)), ("duration", 1), ("channels", 2),
                            ("hasVideo", false), ("hasAudio", true)])
        }) { _, _ in }
        try await b.start(); try await newProject(b, name: "Keep")
        let score: [String: Any] = ["version": 1, "title": "Import identity cue", "bpm": 120, "lengthBeats": 2,
                                  "seed": 17, "room": 0, "parts": [["id": "keys", "instrument": "keys", "gainDb": -12,
                                  "pan": 0, "notes": [["at": 0.25, "duration": 1.5, "pitch": 62, "velocity": 0.7]]]]]
        let version = await b.currentVersion()
        let composed = try fields(await b.handleAssistant(method: "POST", path: "/api/audio/compose",
                                                         body: JSON(any: ["score": score, "track": "A3", "start": 0,
                                                                          "comp": NSNull(), "expectedVersion": version]).text))
        let path = try XCTUnwrap(composed["path"] as? String)
        let pending = Task { try await b.importMedia([path, "ordinary.png"]) }
        defer { pending.cancel(); Task { await gate.release() } }
        try await gate.waitForEntry()
        let handle = try FileHandle(forUpdating: project.appendingPathComponent(path))
        try handle.seek(toOffset: 44)
        var changed = try XCTUnwrap(handle.read(upToCount: 1)); changed[0] ^= 1
        try handle.seek(toOffset: 44); try handle.write(contentsOf: changed); try handle.close()
        await gate.release()
        let receipt = try fields(await pending.value)
        let issues = try XCTUnwrap(receipt["failures"] as? [[String: Any]])
        XCTAssertEqual(issues.count, 1); XCTAssertEqual(issues.first?["path"] as? String, path)
        XCTAssertEqual(Set((receipt["assets"] as? [String: Any] ?? [:]).keys), ["ordinary.png"])
        await b.stop()
    }
}
