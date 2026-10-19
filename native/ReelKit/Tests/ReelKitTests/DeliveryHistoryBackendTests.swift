import Foundation
import XCTest
@testable import ReelKit

final class DeliveryHistoryBackendTests: XCTestCase {
    private func call(_ backend: ReelBackend, _ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        var request = body
        if path == "/api/export/finish" { request?["drained"] = true }
        let reply = try await backend.handle(method: method, path: path, body: request.map { JSON(any: $0).text })
        let result = (try JSON.parse(reply.text) as? [String: Any]) ?? [:]
        if path == "/api/export", let id = result["id"] as? String {
            for _ in 0..<500 {
                let status = try await backend.handle(method: "POST", path: "/api/export/progress", body: JSON(any: ["id": id]).text)
                let fields = parse(status.text)
                if fields["state"] as? String == "running" { return result }
                if fields["cancelled"] as? Bool == true { throw ReelBackend.APIError("Fixture export failed before dispatch.") }
                try await Task.sleep(for: .milliseconds(10))
            }
            throw ReelBackend.APIError("Fixture export did not acquire admission.")
        }
        return result
    }
    private func export(_ backend: ReelBackend) async throws -> [String: Any] {
        _ = try await call(backend, "POST", "/api/new", ["name": "Owned delivery fixture", "width": 64, "height": 64, "fps": 1])
        let job = try await call(backend, "POST", "/api/export", ["renderer": "webcodecs", "preset": "h264-high", "name": "Final", "width": 64, "height": 64, "fps": 1, "range": ["in": 0, "out": 1]])
        let id = try XCTUnwrap(job["id"] as? String)
        _ = try await backend.saveExport(job: id, name: nil, position: 0, data: Data("owned fixture bytes; no media decoder is invoked".utf8))
        return try await call(backend, "POST", "/api/export/finish", ["id": id])
    }
    func testCompletedWebCodecDeliverySurvivesBackendRecreationWithEmptyJobQueue() async throws {
        let root = try Support.tempFolder("delivery-cold-reopen")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root), backend = try ReelBackend(folder: folder, coreScript: Support.core(), events: { _, _ in })
        try await backend.start()
        do {
            let done = try await export(backend)
            XCTAssertEqual(done["state"] as? String, "done"); XCTAssertNil(done["deliveryWarning"])
            let first = try await call(backend, "GET", "/api/deliveries")
            let row = try XCTUnwrap((first["deliveries"] as? [[String: Any]])?.first)
            XCTAssertEqual(row["provenance"] as? String, "completed")
            await backend.stop(); await backend.pageProcessingWorkersExited()
            let reopened = try ReelBackend(folder: folder, coreScript: Support.core(), events: { _, _ in })
            try await reopened.start()
            do {
                let jobs = try await call(reopened, "GET", "/api/jobs")
                XCTAssertTrue((jobs["jobs"] as? [Any] ?? []).isEmpty)
                let history = try await call(reopened, "GET", "/api/deliveries")
                XCTAssertEqual(history["deliveries"] as? NSArray, first["deliveries"] as? NSArray)
                XCTAssertEqual(history["actions"] as? [String], ["share"])
                let id = try XCTUnwrap(row["id"] as? String)
                let url = try await reopened.deliveryURL(id: id, root: folder.root.path)
                try FileManager.default.removeItem(at: url)
                do { _ = try await reopened.deliveryURL(id: id, root: folder.root.path); XCTFail("Missing output was returned") } catch {}
                let missing = try await call(reopened, "GET", "/api/deliveries")
                XCTAssertEqual((missing["deliveries"] as? [[String: Any]])?.first?["available"] as? Bool, false)
                await reopened.stop(); await reopened.pageProcessingWorkersExited()
            } catch { await reopened.stop(); await reopened.pageProcessingWorkersExited(); throw error }
        } catch { await backend.stop(); await backend.pageProcessingWorkersExited(); throw error }
    }
    func testReceiptFailureDoesNotErasePublishedExportOrCorruptHistory() async throws {
        let root = try Support.tempFolder("delivery-history-failure")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root), backend = try ReelBackend(folder: folder, coreScript: Support.core(), events: { _, _ in })
        try await backend.start()
        do {
            let history = folder.dotDir.appendingPathComponent("deliveries.json")
            try Data("{broken".utf8).write(to: history)
            let done = try await export(backend)
            XCTAssertEqual(done["state"] as? String, "done"); XCTAssertNotNil(done["deliveryWarning"])
            XCTAssertTrue(FileManager.default.fileExists(atPath: folder.rendersDir.appendingPathComponent("Final.mp4").path))
            XCTAssertEqual(try String(contentsOf: history, encoding: .utf8), "{broken")
            let list = try await call(backend, "GET", "/api/deliveries")
            XCTAssertEqual((list["deliveries"] as? [[String: Any]])?.first?["provenance"] as? String, "existing")
            await backend.stop(); await backend.pageProcessingWorkersExited()
        } catch { await backend.stop(); await backend.pageProcessingWorkersExited(); throw error }
    }
    private actor CapturePlatform: ReelPlatform {
        var files: [URL] = []
        func reveal(_ url: URL, open: Bool) async throws { files.append(url) }
        func count() -> Int { files.count }
    }
    func testReadOnlyDeliveryAccessIsConfinedAndClosedBackendCannotPublishUIAccess() async throws {
        let root = try Support.tempFolder("delivery-read-only")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root)
        try FileManager.default.createDirectory(at: folder.rendersDir, withIntermediateDirectories: true)
        try Data("fixture".utf8).write(to: folder.rendersDir.appendingPathComponent("old.mp4"))
        let platform = CapturePlatform()
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), platform: platform, writeAdmission: { throw ReelBackend.APIError("fixture read-only") }, events: { _, _ in })
        try await backend.start()
        do {
            let list = try await call(backend, "GET", "/api/deliveries")
            let row = try XCTUnwrap((list["deliveries"] as? [[String: Any]])?.first), id = try XCTUnwrap(row["id"] as? String)
            _ = try await call(backend, "POST", "/api/deliveries/access", ["id": id, "root": folder.root.path, "action": "open"])
            let count = await platform.count(); XCTAssertEqual(count, 1)
            for body in [["id": "../private", "root": folder.root.path, "action": "open"], ["id": id, "root": "wrong-project", "action": "open"], ["id": id, "root": folder.root.path, "action": "share"]] {
                do { _ = try await call(backend, "POST", "/api/deliveries/access", body); XCTFail("Unsafe access accepted") } catch {}
            }
            let after = await platform.count(); XCTAssertEqual(after, 1)
            await backend.stop(); await backend.pageProcessingWorkersExited()
            do { _ = try await backend.deliveryURL(id: id, root: folder.root.path); XCTFail("Closed backend resolved a delivery") } catch {}
        } catch { await backend.stop(); await backend.pageProcessingWorkersExited(); throw error }
    }
}
