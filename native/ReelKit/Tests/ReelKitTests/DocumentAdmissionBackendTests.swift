import Foundation
import XCTest
@testable import ReelKit

final class DocumentAdmissionBackendTests: XCTestCase {
    private func rejects(_ action: () async throws -> Void) async {
        do { try await action(); XCTFail("Expected read-only admission rejection") }
        catch { XCTAssertTrue(error.localizedDescription.contains("read-only"), error.localizedDescription) }
    }

    func testSynchronousTokenBlocksAllProjectMutationEntrypointsAndPreservesReadControls() async throws {
        let root = try Support.tempFolder("document-admission")
        defer { try? FileManager.default.removeItem(at: root) }
        let admission = ProjectWriteAdmission(), folder = ProjectFolder(root: root)
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), writeAdmission: { try admission.requireWritable() }, events: { _, _ in })
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let bytes = try Data(contentsOf: folder.projectFile), version = await backend.currentVersion()
        // No actor hop occurs between changing the host token and calling the backend.
        admission.setBlockedReason("Resolve the conflict in Files.")
        for route in ["/api/new", "/api/import", "/api/ops", "/api/undo", "/api/redo", "/api/forget", "/api/transcript"] {
            await rejects { _ = try await backend.handle(method: "POST", path: route, body: "{}") }
        }
        await rejects { _ = try await backend.importMedia([]) }
        await rejects { _ = try await backend.editOperations(ops: []) }
        await rejects { _ = try await backend.copyIn([]) }
        await rejects { _ = try await backend.upload(name: "test.png", data: Data([1]), id: nil, done: true) }
        _ = try await backend.handle(method: "GET", path: "/api/project", body: nil)
        _ = try await backend.handle(method: "GET", path: "/api/state", body: nil)
        _ = try await backend.handle(method: "POST", path: "/api/jobs/cancel", body: "{}")
        _ = try await backend.handle(method: "POST", path: "/api/analysis/jobs/cancel", body: "{}")
        _ = try await backend.handle(method: "POST", path: "/api/ui-state", body: "{\"playhead\":2}")
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), bytes)
        let after = await backend.currentVersion(); XCTAssertEqual(after, version)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.mediaDir.path))
        admission.setBlockedReason(nil)
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Recovered\"}")
        let recovered = await backend.currentProject(); XCTAssertEqual(parse(try XCTUnwrap(recovered))["name"] as? String, "Recovered")
        await backend.stop()
    }

    func testConflictDuringProbeBlocksFinalCommitWithoutChangingHistoryOrBytes() async throws {
        let root = try Support.tempFolder("document-probe")
        defer { try? FileManager.default.removeItem(at: root) }
        let admission = ProjectWriteAdmission(), folder = ProjectFolder(root: root)
        try Data([1]).write(to: root.appendingPathComponent("source.png"))
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), probe: { _ in
            admission.setBlockedReason("Files disabled editing during processing.")
            return .object([("kind", "image"), ("width", 2), ("height", 2)])
        }, writeAdmission: { try admission.requireWritable() }, events: { _, _ in })
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Before\"}")
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let bytes = try Data(contentsOf: folder.projectFile), before = await backend.currentVersion()
        await rejects { _ = try await backend.importMedia(["source.png"]) }
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), bytes)
        let after = await backend.currentVersion(); XCTAssertEqual(after, before)
        admission.setBlockedReason(nil)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let undone = await backend.currentProject(); XCTAssertEqual(parse(try XCTUnwrap(undone))["name"] as? String, "Before")
        _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}")
        let redone = await backend.currentProject(); XCTAssertEqual(parse(try XCTUnwrap(redone))["name"] as? String, "Keep")
        await backend.stop()
    }

    func testHostTokensAreIndependentAcrossBackendReplacement() async throws {
        let roots = try [Support.tempFolder("document-old"), Support.tempFolder("document-new")]
        defer { roots.forEach { try? FileManager.default.removeItem(at: $0) } }
        let old = ProjectWriteAdmission(), current = ProjectWriteAdmission()
        let first = try ReelBackend(folder: ProjectFolder(root: roots[0]), coreScript: Support.core(), writeAdmission: { try old.requireWritable() }, events: { _, _ in })
        let next = try ReelBackend(folder: ProjectFolder(root: roots[1]), coreScript: Support.core(), writeAdmission: { try current.requireWritable() }, events: { _, _ in })
        try await first.start(); try await next.start()
        old.setBlockedReason("The old project was closed.")
        await rejects { _ = try await first.handle(method: "POST", path: "/api/new", body: "{}") }
        _ = try await next.handle(method: "POST", path: "/api/new", body: "{\"name\":\"New\"}")
        XCTAssertNil(current.blockedReason)
        await first.stop(); await next.stop()
    }

    func testTranscriptionCompletionCannotPersistAfterHostDisablesEditing() async throws {
        let root = try Support.tempFolder("document-transcript")
        defer { try? FileManager.default.removeItem(at: root) }
        let admission = ProjectWriteAdmission(), folder = ProjectFolder(root: root)
        try FileManager.default.copyItem(at: Support.fixture("tone.m4a"), to: root.appendingPathComponent("tone.m4a"))
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), transcribe: { _, _, _, _ in
            admission.setBlockedReason("A conflict arrived during recognition.")
            return JSON(any: ["words": [["start": 0.0, "end": 0.1, "text": "Keep"]]])
        }, writeAdmission: { try admission.requireWritable() }, events: { _, _ in })
        try await backend.start()
        _ = try await backend.importMedia(["tone.m4a"])
        let bytes = try Data(contentsOf: folder.projectFile)
        await rejects { _ = try await backend.handle(method: "POST", path: "/api/analyze", body: "{\"src\":\"tone.m4a\",\"kind\":\"transcript\",\"locale\":\"en-US\"}") }
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: try NativeTranscriptStore.file(src: "tone.m4a", locale: "en-US", folder: folder).path))
        let transcript = try NativeTranscriptStore.read(src: "tone.m4a", locale: "en-US", folder: folder)
        XCTAssertEqual(parse(transcript.text)["revision"] as? Int ?? 0, 0)
        await backend.stop()
    }

    func testLUTImportRespectsReadOnlyAdmissionAndChangedProjectBeforeCreatingFiles() async throws {
        let root = try Support.tempFolder("document-lut-admission")
        defer { try? FileManager.default.removeItem(at: root) }
        let admission = ProjectWriteAdmission(), folder = ProjectFolder(root: root)
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), writeAdmission: { try admission.requireWritable() }, events: { _, _ in })
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let original = try Data(contentsOf: folder.projectFile), version = await backend.currentVersion()
        let cube = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n"
        let body = JSON(any: ["name": "identity.cube", "text": cube]).text
        let directory = root.appendingPathComponent("luts")
        admission.setBlockedReason("Resolve the conflict in Files.")
        await rejects { _ = try await backend.handle(method: "POST", path: "/api/luts/import", body: body) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), original)
        let blockedVersion = await backend.currentVersion(); XCTAssertEqual(blockedVersion, version)
        admission.setBlockedReason(nil)
        try Data("damaged external bytes".utf8).write(to: folder.projectFile)
        do { _ = try await backend.handle(method: "POST", path: "/api/luts/import", body: body); XCTFail("An unreadable project must refuse LUT import") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Could not edit the project file"), error.localizedDescription) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        try original.write(to: folder.projectFile)
        let receipt = try await backend.handle(method: "POST", path: "/api/luts/import", body: body)
        let imported = parse(receipt.text)
        XCTAssertEqual(imported["imported"] as? Bool, true)
        let importedPath = try XCTUnwrap(imported["path"] as? String)
        XCTAssertEqual(try String(contentsOf: folder.resolve(importedPath), encoding: .utf8), cube)
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), original)
        let finalVersion = await backend.currentVersion(); XCTAssertEqual(finalVersion, version)
        await backend.stop()
    }
}
