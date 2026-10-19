import Foundation
import Darwin
import XCTest
@testable import ReelKit

/// Real backend and disposable bytes. These tests do not invoke a codec or renderer.
final class DirectExportSafetyTests: XCTestCase {
    private let original = Data("owned original fixture bytes".utf8)
    private let first = Data("first ".utf8), second = Data("second".utf8)

    private func call(_ backend: ReelBackend, _ route: String, _ body: [String: Any] = [:]) async throws -> [String: Any] {
        var request = body
        if route == "/api/export/finish" { request["drained"] = true }
        let result = parse(try await backend.handle(method: "POST", path: route, body: JSON(any: request).text).text)
        if route == "/api/export", let id = result["id"] as? String { try await waitForPageWorker(backend, id) }
        return result
    }

    private func waitForPageWorker(_ backend: ReelBackend, _ id: String) async throws {
        for _ in 0..<500 {
            let response = try await backend.handle(method: "POST", path: "/api/export/progress", body: JSON(any: ["id": id, "progress": 0]).text)
            let state = parse(response.text)
            if state["state"] as? String == "running" { return }
            if state["cancelled"] as? Bool == true { throw ReelBackend.APIError("The fixture export failed before dispatch.") }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw ReelBackend.APIError("The fixture export did not acquire admission.")
    }

    private func fixture(_ name: String, _ action: (URL, ReelBackend, ProjectWriteAdmission) async throws -> Void) async throws {
        let root = try Support.tempFolder("direct-output-" + name)
        defer { try? FileManager.default.removeItem(at: root) }
        let admission = ProjectWriteAdmission()
        let backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), writeAdmission: { try admission.requireWritable() }, processingAdmission: .init(), events: { _, _ in })
        try await backend.start()
        do {
            _ = try await call(backend, "/api/new", ["name": "Before", "width": 64, "height": 64, "fps": 1])
            _ = try await call(backend, "/api/new", ["name": "Keep", "width": 64, "height": 64, "fps": 1])
            try await action(root, backend, admission)
            await backend.stop(); await backend.pageProcessingWorkersExited()
        } catch { await backend.stop(); await backend.pageProcessingWorkersExited(); throw error }
    }

    private func rejects(_ action: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await action(); XCTFail("Unsafe direct output must be rejected", file: file, line: line) }
        catch {}
    }

    private func save(_ backend: ReelBackend, _ path: String, _ position: UInt64 = 0, _ data: Data? = nil) async throws {
        _ = try await backend.saveExport(job: nil, name: path, position: position, data: data ?? second)
    }

    private func reference(_ backend: ReelBackend, source: String, proxy: String? = nil) async throws {
        var asset: [String: Any] = ["kind": "video", "duration": 1, "width": 64, "height": 64]
        if let proxy { asset["proxy"] = proxy }
        _ = try await backend.editOperations(ops: JSON(any: [["op": "import", "assets": [source: asset]]]))
    }

    func testSequentialChunksPreserveProjectBytesVersionAndUndoRedo() async throws {
        try await fixture("sequential") { root, backend, _ in
            let file = root.appendingPathComponent("reel.project.json"), output = root.appendingPathComponent(".reel/frames/owned.png")
            let bytes = try Data(contentsOf: file), version = await backend.currentVersion()
            try await self.save(backend, ".reel/frames/owned.png", 0, self.first)
            try await self.save(backend, output.path, UInt64(self.first.count), self.second)
            XCTAssertEqual(try Data(contentsOf: output), self.first + self.second)
            XCTAssertEqual(try Data(contentsOf: file), bytes)
            let after = await backend.currentVersion(); XCTAssertEqual(after, version)
            let undone = try await self.call(backend, "/api/undo"); XCTAssertEqual((undone["project"] as? [String: Any])?["name"] as? String, "Before")
            let redone = try await self.call(backend, "/api/redo"); XCTAssertEqual((redone["project"] as? [String: Any])?["name"] as? String, "Keep")
            XCTAssertEqual(try Data(contentsOf: output), self.first + self.second)
        }
    }

    func testExistingRegularAndZeroByteOutputsCannotBeReplaced() async throws {
        try await fixture("existing") { root, backend, _ in
            try FileManager.default.createDirectory(at: root.appendingPathComponent("renders"), withIntermediateDirectories: true)
            for bytes in [self.original, Data()] {
                let output = root.appendingPathComponent("renders/existing.png")
                try bytes.write(to: output, options: .atomic)
                await self.rejects { try await self.save(backend, "renders/existing.png") }
                XCTAssertEqual(try Data(contentsOf: output), bytes)
            }
        }
    }

    func testMissingSourceAndProxyAreNeverFilledByDirectSave() async throws {
        for proxy in [false, true] {
            try await fixture("missing-reference") { root, backend, _ in
                let path = ".reel/frames/missing.png"
                try await self.reference(backend, source: proxy ? "media/origin.mp4" : path, proxy: proxy ? path : nil)
                let before = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
                await self.rejects { try await self.save(backend, path) }
                XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(path).path))
                XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), before)
            }
        }
    }

    func testReferencedHardLinkCannotBeChanged() async throws {
        try await fixture("existing-source") { root, backend, _ in
            let source = root.appendingPathComponent("media/origin.png"), output = root.appendingPathComponent("renders/alias.png")
            try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
            try self.original.write(to: source)
            try FileManager.default.linkItem(at: source, to: output)
            try await self.reference(backend, source: "media/origin.png")
            await self.rejects { try await self.save(backend, "renders/alias.png") }
            XCTAssertEqual(try Data(contentsOf: source), self.original)
            XCTAssertEqual(try Data(contentsOf: output), self.original)
        }
    }

    func testContinuationNeedsInitialSaveAndExactNextPosition() async throws {
        try await fixture("position") { root, backend, _ in
            await self.rejects { try await self.save(backend, "renders/new.png", 1) }
            try await self.save(backend, "renders/new.png", 0, self.first)
            for position in [UInt64(0), UInt64(1), UInt64(self.first.count + 1)] {
                await self.rejects { try await self.save(backend, "renders/new.png", position) }
                XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("renders/new.png")), self.first)
            }
        }
    }

    func testReplacedOutputRejectsContinuationAndPreservesReplacement() async throws {
        try await fixture("replaced") { root, backend, _ in
            let path = "renders/new.png", output = root.appendingPathComponent(path)
            try await self.save(backend, path, 0, self.first)
            try self.original.write(to: output, options: .atomic)
            await self.rejects { try await self.save(backend, path, UInt64(self.first.count)) }
            XCTAssertEqual(try Data(contentsOf: output), self.original)
        }
    }

    func testMetadataAndHardLinkChangesRejectContinuation() async throws {
        for link in [false, true] {
            try await fixture("changed-identity") { root, backend, _ in
                let path = "renders/new.png", output = root.appendingPathComponent(path)
                try await self.save(backend, path, 0, self.first)
                if link { try FileManager.default.linkItem(at: output, to: root.appendingPathComponent("owned-alias.png")) }
                else { try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)], ofItemAtPath: output.path) }
                await self.rejects { try await self.save(backend, path, UInt64(self.first.count)) }
                XCTAssertEqual(try Data(contentsOf: output), self.first)
            }
        }
    }

    func testNewSourceReferenceBetweenChunksRejectsContinuation() async throws {
        try await fixture("late-reference") { root, backend, _ in
            let path = ".reel/frames/new.png"
            try await self.save(backend, path, 0, self.first)
            try await self.reference(backend, source: path)
            await self.rejects { try await self.save(backend, path, UInt64(self.first.count)) }
            XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(path)), self.first)
        }
    }

    func testProjectReplacementRejectsContinuation() async throws {
        try await fixture("new-project") { root, backend, _ in
            let path = "renders/new.png"
            try await self.save(backend, path, 0, self.first)
            _ = try await self.call(backend, "/api/new", ["name": "Replacement"])
            let bytes = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
            await self.rejects { try await self.save(backend, path, UInt64(self.first.count)) }
            XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(path)), self.first)
            XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), bytes)
        }
    }

    func testReadOnlyAndInvalidExternalProjectBlockInitialAndLaterWrites() async throws {
        for corruption in [false, true] {
            try await fixture("admission") { root, backend, admission in
                let path = "renders/new.png"
                try await self.save(backend, path, 0, self.first)
                if corruption { try Data("{broken external project".utf8).write(to: root.appendingPathComponent("reel.project.json"), options: .atomic) }
                else { admission.setBlockedReason("Fixture Files conflict.") }
                let bytes = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
                await self.rejects { try await self.save(backend, "renders/another.png") }
                await self.rejects { try await self.save(backend, path, UInt64(self.first.count)) }
                XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(path)), self.first)
                XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("renders/another.png").path))
                XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), bytes)
            }
        }
    }

    func testLeafAndAncestorSymlinksRejectWithoutChangingTargets() async throws {
        for ancestor in [false, true] {
            try await fixture("symlinks") { root, backend, _ in
                let source = root.appendingPathComponent("owned.png")
                try self.original.write(to: source)
                if ancestor { try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("renders"), withDestinationURL: root) }
                else {
                    try FileManager.default.createDirectory(at: root.appendingPathComponent("renders"), withIntermediateDirectories: true)
                    try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("renders/owned.png"), withDestinationURL: source)
                }
                await self.rejects { try await self.save(backend, "renders/owned.png") }
                XCTAssertEqual(try Data(contentsOf: source), self.original)
            }
        }
    }

    func testFIFOContinuationRejectsBeforeWriteOpenCanBlock() async throws {
        try await fixture("fifo-continuation") { root, backend, _ in
            let path = "renders/owned.png", file = root.appendingPathComponent(path)
            try await self.save(backend, path, 0, self.first)
            let preserved = root.appendingPathComponent("renders/preserved.png")
            try FileManager.default.moveItem(at: file, to: preserved)
            XCTAssertEqual(Darwin.mkfifo(file.path, 0o600), 0)
            let clock = ContinuousClock(), began = clock.now
            await self.rejects { try await self.save(backend, path, UInt64(self.first.count), self.second) }
            XCTAssertLessThan(began.duration(to: clock.now), .seconds(1))
            XCTAssertEqual(try Data(contentsOf: preserved), self.first)
        }
    }

    func testStoppedBackendRejectsDirectWrites() async throws {
        try await fixture("closed") { root, backend, _ in
            await backend.stop()
            await self.rejects { try await self.save(backend, "renders/closed.png") }
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("renders/closed.png").path))
        }
    }

    func testQueuedJobStillAcceptsPatchWritesToANewRender() async throws {
        try await fixture("queued") { root, backend, admission in
            let output = root.appendingPathComponent("renders/Final.mp4")
            try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
            let job = try await self.call(backend, "/api/export", ["renderer": "webcodecs", "preset": "h264-high", "name": "Final", "width": 64, "height": 64, "fps": 1, "range": ["in": 0, "out": 1]])
            let id = try XCTUnwrap(job["id"] as? String)
            admission.setBlockedReason("Fixture conflict keeps publication blocked.")
            _ = try await backend.saveExport(job: id, name: nil, position: 0, data: self.first)
            _ = try await backend.saveExport(job: id, name: nil, position: UInt64(self.first.count), data: self.second)
            _ = try await backend.saveExport(job: id, name: nil, position: 0, data: Data("F".utf8))
            admission.setBlockedReason(nil)
            let done = try await self.call(backend, "/api/export/finish", ["id": id])
            XCTAssertEqual(done["state"] as? String, "done")
            XCTAssertEqual(try Data(contentsOf: output), Data("First second".utf8))
        }
    }
    func testDirectSaveReportsPartialUntilExplicitFinalChunkAndKeepsCancelledBytes() async throws {
        try await fixture("partial") { root, backend, _ in
            let first = try await backend.saveExport(job: nil, name: "renders/partial.png", position: 0, data: self.first)
            XCTAssertEqual(parse(first.text)["state"] as? String, "partial")
            XCTAssertEqual(parse(first.text)["complete"] as? Bool, false)
            await backend.stop()
            XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("renders/partial.png")), self.first)
        }
        try await fixture("done") { root, backend, _ in
            _ = try await backend.saveExport(job: nil, name: "renders/done.png", position: 0, data: self.first)
            let done = try await backend.saveExport(job: nil, name: "renders/done.png", position: UInt64(self.first.count), data: self.second, done: true)
            XCTAssertEqual(parse(done.text)["state"] as? String, "done")
            await self.rejects { _ = try await backend.saveExport(job: nil, name: "renders/done.png", position: UInt64(self.first.count + self.second.count), data: self.second) }
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".reel/deliveries.json").path))
        }
    }

    func testChangedSourceBetweenDirectChunksKeepsPartialOutput() async throws {
        try await fixture("source-between-chunks") { root, backend, _ in
            let source = root.appendingPathComponent("source.wav")
            try self.original.write(to: source)
            try await self.reference(backend, source: "source.wav")
            _ = try await backend.saveExport(job: nil, name: "renders/partial.png", position: 0, data: self.first)
            try self.second.write(to: source)
            await self.rejects { _ = try await backend.saveExport(job: nil, name: "renders/partial.png", position: UInt64(self.first.count), data: self.second, done: true) }
            XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("renders/partial.png")), self.first)
            XCTAssertEqual(try Data(contentsOf: source), self.second)
        }
    }

}
