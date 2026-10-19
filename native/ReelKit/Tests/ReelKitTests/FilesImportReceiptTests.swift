import Foundation
import XCTest
@testable import ReelKit

final class FilesImportReceiptTests: XCTestCase {
    private func backend(_ root: URL, probe: ReelBackend.MediaProber? = nil) throws -> ReelBackend {
        try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), probe: probe) { _, _ in }
    }

    func testActualProbePartialSuccessRetainsGoodAssetAndNamesInvalidMedia() async throws {
        let root = try Support.tempFolder("files-partial"), outside = try Support.tempFolder("files-source")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: outside) }
        let good = outside.appendingPathComponent("good movie.mp4"), bad = outside.appendingPathComponent("broken movie.mp4")
        try FileManager.default.copyItem(at: Support.fixture("clip.mp4"), to: good)
        try Data("Not a movie".utf8).write(to: bad)
        let b = try backend(root); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let receipt = parse(try await b.copyIn([good, bad]).text)
        XCTAssertEqual(Set(object(receipt["assets"]).keys), ["media/good movie.mp4"])
        let issues = try XCTUnwrap(receipt["failures"] as? [[String: Any]])
        XCTAssertEqual(issues.count, 1); XCTAssertEqual(issues[0]["name"] as? String, "broken movie.mp4")
        XCTAssertEqual(issues[0]["stage"] as? String, "probe"); XCTAssertFalse((issues[0]["error"] as? String ?? "").isEmpty)
        let saved = parse(try String(contentsOf: root.appendingPathComponent("reel.project.json"), encoding: .utf8))
        XCTAssertEqual(Set(object(saved["assets"]).keys), ["media/good movie.mp4"])
        await b.stop()
        let reopened = try backend(root); try await reopened.start()
        let current = await reopened.currentProject(); XCTAssertEqual(Set(object(parse(try XCTUnwrap(current))["assets"]).keys), ["media/good movie.mp4"])
        await reopened.stop()
    }

    func testCopyFailureDoesNotPreventOtherSuccessfulSourcesOrHideProbeFailure() async throws {
        let root = try Support.tempFolder("files-copy"), outside = try Support.tempFolder("files-copy-source")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: outside) }
        let missing = outside.appendingPathComponent("missing.png"), bad = outside.appendingPathComponent("invalid.mp4")
        try Data([1, 2, 3]).write(to: bad)
        let b = try backend(root); try await b.start()
        let receipt = parse(try await b.copyIn([missing, Support.fixture("still.png"), bad]).text)
        XCTAssertEqual(Set(object(receipt["assets"]).keys), ["media/still.png"])
        let issues = try XCTUnwrap(receipt["failures"] as? [[String: Any]])
        XCTAssertEqual(issues.count, 2)
        XCTAssertEqual(issues.map { $0["stage"] as? String }, ["copy", "probe"])
        XCTAssertEqual(issues.map { $0["name"] as? String }, ["missing.png", "invalid.mp4"])
        let current = await b.currentProject(); XCTAssertTrue(object(parse(try XCTUnwrap(current))["assets"])["media/still.png"] != nil)
        await b.stop()
    }

    func testReadFailureAndDuplicatePathsHaveTruthfulAdditiveReceipt() async throws {
        let root = try Support.tempFolder("files-read")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.copyItem(at: Support.fixture("still.png"), to: root.appendingPathComponent("still.png"))
        let b = try backend(root); try await b.start()
        let receipt = parse(try await b.importMedia(["missing.png", "still.png", "still.png", "../outside.png"]).text)
        XCTAssertEqual(Set(object(receipt["assets"]).keys), ["still.png"])
        let issues = try XCTUnwrap(receipt["failures"] as? [[String: Any]])
        XCTAssertEqual(issues.count, 2); XCTAssertTrue(issues.allSatisfy { $0["stage"] as? String == "read" })
        XCTAssertTrue((issues[1]["error"] as? String ?? "").contains("outside"))
        await b.stop()
    }

    func testFailedOnlyBatchDoesNotPublishAnEmptyEditOrChangeUndoHistory() async throws {
        let root = try Support.tempFolder("files-all-failed")
        defer { try? FileManager.default.removeItem(at: root) }
        try Data([1]).write(to: root.appendingPathComponent("invalid.mp4"))
        let b = try backend(root); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Before\"}")
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let bytes = try Data(contentsOf: root.appendingPathComponent("reel.project.json")), version = await b.currentVersion()
        let receipt = parse(try await b.importMedia(["invalid.mp4"]).text)
        XCTAssertTrue(object(receipt["assets"]).isEmpty); XCTAssertEqual((receipt["failures"] as? [Any])?.count, 1)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), bytes)
        let after = await b.currentVersion(); XCTAssertEqual(version, after)
        _ = try await b.handle(method: "POST", path: "/api/undo", body: "{}")
        let undone = await b.currentProject(); XCTAssertEqual(parse(try XCTUnwrap(undone))["name"] as? String, "Before")
        await b.stop()
    }

    func testFailedOnlyCopyDoesNotInitializeFreshFolder() async throws {
        let root = try Support.tempFolder("files-no-copy"), outside = try Support.tempFolder("files-no-source")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: outside) }
        let b = try backend(root); try await b.start()
        let receipt = parse(try await b.copyIn([outside.appendingPathComponent("missing.mp4")]).text)
        XCTAssertTrue(object(receipt["assets"]).isEmpty); XCTAssertEqual((receipt["failures"] as? [Any])?.count, 1)
        let project = await b.currentProject(); XCTAssertNil(project)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("reel.project.json").path))
        await b.stop()
    }

    func testProbeCancellationIsNotReportedAsSuccessfulPartialImport() async throws {
        let root = try Support.tempFolder("files-cancel")
        defer { try? FileManager.default.removeItem(at: root) }
        try Data([1]).write(to: root.appendingPathComponent("source.png"))
        let b = try backend(root, probe: { _ in throw CancellationError() }); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let bytes = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        do { _ = try await b.importMedia(["source.png"]); XCTFail("Cancellation became a partial receipt") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), bytes)
        await b.stop()
    }
}
