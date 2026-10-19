import Foundation
import XCTest
@testable import ReelKit

/// Prepared actor/backend fixtures. Not compiled or executed in the source-only lane.
final class AssistantHistoryBackendTests: XCTestCase {
    func testLocalAndCompanionProjectReadsRestoreSameDisplayHistoryWithoutRunState() async throws {
        let root = try Support.tempFolder("assistant-history-backend")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root), history = NativeAssistantChatHistory(folder: folder)
        try history.append(.raw(#"{"role":"user","text":"Review the title.","at":1,"refs":[{"kind":"clip","id":"c1","label":"Title"}]}"#))
        let backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _, _ in }
        try await backend.start()
        let local = parse(try await backend.handle(method: "GET", path: "/api/project", body: nil).text)
        let companion = parse(try await backend.handleAssistant(method: "GET", path: "/api/project", body: nil).text)
        XCTAssertEqual(JSON(any: local["chat"]), JSON(any: companion["chat"]))
        XCTAssertEqual((local["chat"] as? [Any])?.count, 1)
        XCTAssertEqual(object(local["claude"])["state"] as? String, "idle")
        XCTAssertNil(object(local["claude"])["routing"]); XCTAssertNil(local["sharing"])
        let restored = try await backend.assistantHistorySnapshot()
        XCTAssertEqual(object(parse(restored.text)["status"])["restored"] as? Int, 1)
        await backend.stop()
    }
    func testAdmittedAppendIsAvailableToNextCompanionReadAndReopen() async throws {
        let root = try Support.tempFolder("assistant-history-append")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root), backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _, _ in }
        try await backend.start()
        let user = JSON.raw(#"{"role":"you","text":"Review this script.","at":1,"refs":{"inputKind":"script","clips":["c1"],"token":"never-retain"},"sharing":{"approved":true},"runID":"never-retain"}"#)
        _ = try await backend.appendAssistantHistory(user)
        let reply = JSON.raw(#"{"role":"claude","text":"Which title should I use?","at":2,"provider":"codex"}"#)
        _ = try await backend.appendAssistantHistory(reply)
        let project = try await backend.handleAssistant(method: "GET", path: "/api/project", body: nil)
        XCTAssertEqual((parse(project.text)["chat"] as? [Any])?.count, 2)
        XCTAssertFalse(project.text.contains("never-retain")); XCTAssertFalse(project.text.contains("approved"))
        await backend.stop()
        let reopened = NativeAssistantChatHistory(folder: folder)
        XCTAssertEqual(reopened.messages.count, 2)
        XCTAssertEqual(parse(reopened.messages[0].text)["role"] as? String, "user")
    }
    func testClosedOrAlreadyCancelledOwnerCannotAppend() async throws {
        let root = try Support.tempFolder("assistant-history-closed")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root), backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _, _ in }
        try await backend.start()
        let row = JSON.raw(#"{"role":"user","text":"Never admitted.","at":1}"#)
        let pending = Task { () throws -> JSON in
            withUnsafeCurrentTask { $0?.cancel() }
            return try await backend.appendAssistantHistory(row)
        }
        do { _ = try await pending.value; XCTFail("Cancelled owner appended.") } catch { XCTAssertTrue(error is CancellationError) }
        await backend.stop()
        do { _ = try await backend.appendAssistantHistory(row); XCTFail("Closed owner appended.") } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.dotDir.appendingPathComponent("assistant-chat.json").path))
    }
    func testProjectReadDisplaysLatest100WhileStorageRetains200() async throws {
        let root = try Support.tempFolder("assistant-history-window")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root)
        let rows: [JSON] = (0..<200).map { .object([("role", "user"), ("text", .string("Message \($0)")), ("at", .int($0))]) }
        try FileManager.default.createDirectory(at: folder.dotDir, withIntermediateDirectories: true)
        try Data(JSON.object([("version", 1), ("messages", .array(rows))]).text.utf8).write(to: folder.dotDir.appendingPathComponent("assistant-chat.json"))
        let backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _, _ in }
        try await backend.start()
        let project = parse(try await backend.handleAssistant(method: "GET", path: "/api/project", body: nil).text)
        let visible = project["chat"] as? [[String: Any]] ?? []
        XCTAssertEqual(visible.count, 100); XCTAssertEqual(visible.first?["text"] as? String, "Message 100")
        let retained = parse(try await backend.assistantHistorySnapshot().text)
        XCTAssertEqual((retained["messages"] as? [Any])?.count, 200)
        await backend.stop()
    }

}
