import Foundation
@testable import ReelKit
import XCTest

/// The backend parts of the assistant's plain description, previews and one-step undo.
final class AssistantChangeTests: XCTestCase {
    var root: URL!
    var backend: ReelBackend!

    override func setUp() async throws {
        root = try Support.tempFolder()
        try FileManager.default.createDirectory(at: root.appendingPathComponent("media"), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: Support.fixture("clip.mp4"), to: root.appendingPathComponent("media/clip.mp4"))
        backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: try Support.core()) { _, _ in }
        try await backend.start()
        _ = try await call("POST", "/api/new", JSON.object([("name", "Changes"), ("width", 320), ("height", 180)]).text)
        _ = try await call("POST", "/api/ops", JSON.object([("ops", .array([.object([("op", "append"), ("src", "media/clip.mp4"), ("track", "V1"), ("audio", false)])])), ("who", "agent")]).text)
    }

    override func tearDown() async throws { await backend.stop(); await backend.pageProcessingWorkersExited() }

    func call(_ method: String, _ path: String, _ body: String? = nil) async throws -> [String: Any] {
        (try JSON.parse(try await backend.handle(method: method, path: path, body: body).text) as? [String: Any]) ?? [:]
    }

    func testOutlineFocusAndDescribeUseTheEditorState() async throws {
        _ = try await call("POST", "/api/ui-state", JSON.object([("selection", .array(["c1"])), ("playhead", 0.5)]).text)
        let outline = try await call("GET", "/api/outline")
        let focus = try XCTUnwrap(outline["focus"] as? String)
        XCTAssertTrue(focus.contains("Selection: 1 clip."), focus)
        XCTAssertTrue(focus.contains("c1 video \"clip.mp4\""), focus)
        let described = try await call("GET", "/api/describe?ids=c1&at=0.5")
        XCTAssertTrue((described["text"] as? String ?? "").hasPrefix("At 00:00:00:15 (0.5 s) in Main timeline:"))
        do { _ = try await call("GET", "/api/describe?ids=../x"); XCTFail("should refuse a bad ID") } catch {}
    }

    func testCommitOwnersPreviewAndRestore() async throws {
        let base = await backend.currentVersion()
        let current = await backend.currentProject()
        let before = try XCTUnwrap(current)
        let preview = try await backend.previewAssistantChange(ops: #"[{"op":"update","id":"c1","set":{"opacity":0.5}}]"#,
                                                               steps: [#"{"path":"/api/stabilize/render","body":{"src":"media/clip.mp4","clip":"c1"}}"#, #"{"path":"/api/ops","body":{}}"#])
        let version = await backend.currentVersion()
        XCTAssertEqual(version, base, "a preview saves nothing")
        XCTAssertTrue(preview.project.contains("\"opacity\":0.5"))
        XCTAssertTrue(preview.steps[0].contains("Stabilize (deshake render)"), preview.steps[0])
        XCTAssertTrue(preview.steps[1].contains("cannot be a preview step"), preview.steps[1])
        _ = try await call("POST", "/api/ops", JSON.object([("ops", .array([.object([("op", "update"), ("id", "c1"), ("set", .object([("opacity", 0.5)]))])])), ("who", "agent")]).text)
        let afterAgent = await backend.commitOwners(after: base)
        XCTAssertEqual(afterAgent, ["agent"])
        let changed = await backend.currentProject()
        let after = try XCTUnwrap(changed)
        _ = try await backend.restoreAssistantChange(before, expected: after, line: "Undo assistant change")
        let restored = await backend.currentProject()
        XCTAssertEqual(restored, before)
        let owners = await backend.commitOwners(after: base)
        XCTAssertEqual(owners, ["agent", "you"])
        do { _ = try await backend.restoreAssistantChange(before, expected: after, line: "again"); XCTFail("should refuse a changed project") } catch {}
        _ = try await call("POST", "/api/undo", "{}")
        let redone = await backend.currentProject()
        XCTAssertEqual(redone, after, "the one-step undo is itself undoable")
    }

    /// "Undo this change" on a request where the assistant pressed Undo brings the project back as a
    /// Redo, so the user's own Redo history survives instead of being cleared by a new edit.
    func testRestoringAnAssistantUndoIsARedoThatKeepsRedoHistory() async throws {
        func current() async throws -> String { let project = await backend.currentProject(); return try XCTUnwrap(project) }
        func edit(_ opacity: Double) async throws -> String {
            _ = try await call("POST", "/api/ops", JSON.object([("ops", .array([.object([("op", "update"), ("id", "c1"), ("set", .object([("opacity", .number(opacity))]))])])), ("who", "agent")]).text)
            return try await current()
        }
        let first = try await current()
        let second = try await edit(0.5)
        let third = try await edit(0.25)
        _ = try await call("POST", "/api/undo", "{}")
        let base = await backend.currentVersion()
        _ = try await backend.handleAssistant(method: "POST", path: "/api/undo", body: #"{"who":"agent"}"#)
        let moves = await backend.historyMoves(after: base)
        XCTAssertEqual(moves, ["undo"])
        let owners = await backend.commitOwners(after: base)
        XCTAssertEqual(owners, ["agent"], "an agent's Undo is the agent's commit")
        _ = try await backend.restoreAssistantChange(second, expected: first, line: "Undo assistant change")
        let restored = try await current()
        XCTAssertEqual(restored, second)
        _ = try await call("POST", "/api/redo", "{}")
        let redone = try await current()
        XCTAssertEqual(redone, third, "the Redo the user had before the request still works")
        _ = try await call("POST", "/api/undo", "{}"); _ = try await call("POST", "/api/undo", "{}")
        let undone = try await current()
        XCTAssertEqual(undone, first, "and Undo still walks back through every project")

        // Two assistant Undos come back together, each passed project returning to Undo history.
        let twice = await backend.currentVersion()
        _ = try await call("POST", "/api/redo", "{}"); _ = try await call("POST", "/api/redo", "{}")
        let top = try await current()
        XCTAssertEqual(top, third)
        let agentBase = await backend.currentVersion()
        XCTAssertGreaterThan(agentBase, twice)
        _ = try await backend.handleAssistant(method: "POST", path: "/api/undo", body: #"{"who":"agent"}"#); _ = try await backend.handleAssistant(method: "POST", path: "/api/undo", body: #"{"who":"agent"}"#)
        let both = await backend.historyMoves(after: agentBase)
        XCTAssertEqual(both, ["undo", "undo"])
        _ = try await backend.restoreAssistantChange(third, expected: first, line: "Undo assistant change")
        _ = try await call("POST", "/api/undo", "{}")
        let back = try await current()
        XCTAssertEqual(back, second)

        // A request with an edit among its commits is not a history move.
        let mixed = await backend.currentVersion()
        _ = try await backend.handleAssistant(method: "POST", path: "/api/undo", body: #"{"who":"agent"}"#)
        _ = try await edit(0.75)
        let none = await backend.historyMoves(after: mixed)
        XCTAssertNil(none)
    }

    /// The same for a request where the assistant pressed Redo: it goes back as an Undo, so Redo
    /// still holds what it held.
    func testRestoringAnAssistantRedoIsAnUndoThatKeepsRedoHistory() async throws {
        func current() async throws -> String { let project = await backend.currentProject(); return try XCTUnwrap(project) }
        let first = try await current()
        for opacity in [0.5, 0.25] {
            _ = try await call("POST", "/api/ops", JSON.object([("ops", .array([.object([("op", "update"), ("id", "c1"), ("set", .object([("opacity", .number(opacity))]))])])), ("who", "agent")]).text)
        }
        let third = try await current()
        _ = try await call("POST", "/api/undo", "{}"); _ = try await call("POST", "/api/undo", "{}")
        let base = await backend.currentVersion()
        _ = try await backend.handleAssistant(method: "POST", path: "/api/redo", body: #"{"who":"agent"}"#)
        let second = try await current()
        let moves = await backend.historyMoves(after: base)
        XCTAssertEqual(moves, ["redo"])
        _ = try await backend.restoreAssistantChange(first, expected: second, line: "Undo assistant change", historyMove: true)
        let restored = try await current()
        XCTAssertEqual(restored, first)
        _ = try await call("POST", "/api/redo", "{}"); _ = try await call("POST", "/api/redo", "{}")
        let redone = try await current()
        XCTAssertEqual(redone, third, "both Redo steps survive")
    }

    /// A request that pressed Undo and then Redo ends where it began. "Undo this change" then has
    /// nothing to restore, so it must not commit an identical project as a new edit.
    func testRestoringAnUndoThenRedoRequestChangesNothing() async throws {
        func current() async throws -> String { let project = await backend.currentProject(); return try XCTUnwrap(project) }
        let first = try await current()
        _ = try await call("POST", "/api/ops", JSON.object([("ops", .array([.object([("op", "update"), ("id", "c1"), ("set", .object([("opacity", 0.5)]))])])), ("who", "agent")]).text)
        let second = try await current()
        let base = await backend.currentVersion()
        _ = try await backend.handleAssistant(method: "POST", path: "/api/undo", body: #"{"who":"agent"}"#)
        _ = try await backend.handleAssistant(method: "POST", path: "/api/redo", body: #"{"who":"agent"}"#)
        let moves = await backend.historyMoves(after: base)
        XCTAssertEqual(moves, ["undo", "redo"])
        let after = try await current()
        XCTAssertEqual(after, second)
        let before = await backend.currentVersion()
        let restored = try await backend.restoreAssistantChange(second, expected: after, line: "Undo assistant change", historyMove: true)
        XCTAssertEqual(restored, before, "nothing is committed")
        let version = await backend.currentVersion()
        XCTAssertEqual(version, before)
        _ = try await call("POST", "/api/undo", "{}")
        let undone = try await current()
        XCTAssertEqual(undone, first, "Undo history is as it was")
        _ = try await call("POST", "/api/redo", "{}")
        let redone = try await current()
        XCTAssertEqual(redone, second, "and so is Redo")
    }

    func testHistoryChangeTitlesCountTheNetMove() {
        XCTAssertEqual(ReelBackend.historyChangeTitle(moves: ["undo"]), "Undid 1 edit")
        XCTAssertEqual(ReelBackend.historyChangeTitle(moves: ["undo", "undo", "undo", "redo"]), "Undid 2 edits")
        XCTAssertEqual(ReelBackend.historyChangeTitle(moves: ["redo"]), "Redid 1 edit")
        XCTAssertEqual(ReelBackend.historyChangeTitle(moves: ["undo", "redo"]), "Undid and redid 1 edit")
    }

    /// A preview staged on one project must not apply to the next. Every project opens in its own
    /// backend at version 1, so two projects can share a version and even identical text.
    func testAssistantBaseNamesItsProjectNotOnlyItsVersion() async throws {
        let otherRoot = try Support.tempFolder("other")
        try FileManager.default.createDirectory(at: otherRoot.appendingPathComponent("media"), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: Support.fixture("clip.mp4"), to: otherRoot.appendingPathComponent("media/clip.mp4"))
        let other = try ReelBackend(folder: ProjectFolder(root: otherRoot), coreScript: try Support.core()) { _, _ in }
        try await other.start()
        _ = try await other.handle(method: "POST", path: "/api/new", body: JSON.object([("name", "Changes"), ("width", 320), ("height", 180)]).text)
        _ = try await other.handle(method: "POST", path: "/api/ops", body: JSON.object([("ops", .array([.object([("op", "append"), ("src", "media/clip.mp4"), ("track", "V1"), ("audio", false)])])), ("who", "agent")]).text)
        let captured = await backend.assistantBase()
        let base = try XCTUnwrap(captured)
        let otherVersion = await other.currentVersion()
        XCTAssertEqual(otherVersion, base.version, "both projects are at the same version")
        let onSame = await backend.isCurrent(base)
        let onOther = await other.isCurrent(base)
        XCTAssertTrue(onSame)
        XCTAssertFalse(onOther, "a preview from the first project is stale in the second")
        XCTAssertTrue(base.belongs(to: backend))
        XCTAssertFalse(base.belongs(to: other))
        XCTAssertFalse(base.belongs(to: nil))
        _ = try await call("POST", "/api/ops", JSON.object([("ops", .array([.object([("op", "update"), ("id", "c1"), ("set", .object([("opacity", 0.5)]))])]))]).text)
        let afterEdit = await backend.isCurrent(base)
        XCTAssertFalse(afterEdit, "an edit makes the preview stale")
        await other.stop(); await other.pageProcessingWorkersExited()
    }

    /// A stabilize step applied from a preview sends who:"agent"; both of its commits (the new
    /// media and the placement) are the assistant's, so "Undo this change" stays available.
    func testProcessingTheAssistantAskedForIsRecordedAsTheAssistants() async throws {
        let text = await backend.currentProject()
        let project = try XCTUnwrap(try JSON.parse(try XCTUnwrap(text)) as? [String: Any])
        let clip = try XCTUnwrap(((project["tracks"] as? [[String: Any]])?.first { $0["id"] as? String == "V1" }?["clips"] as? [[String: Any]])?.first)
        let length = ((clip["dur"] as? NSNumber)?.doubleValue ?? 0) * ((clip["speed"] as? NSNumber)?.doubleValue ?? 1)
        let base = await backend.currentVersion()
        let result = try await call("POST", "/api/stabilize/render", JSON.object([("src", "media/clip.mp4"), ("clip", "c1"), ("comp", .null), ("in", 0), ("dur", .number(length)),
                                                                                ("expectedVersion", .int(base)), ("who", "agent"), ("wait", true)]).text)
        XCTAssertEqual(result["state"] as? String, "done", "\(result)")
        XCTAssertEqual(result["applied"] as? Bool, true, "\(result)")
        let owners = await backend.commitOwners(after: base)
        XCTAssertEqual(owners, ["agent", "agent"])
        let placed = await backend.currentProject()
        XCTAssertTrue(placed?.contains("media/stabilized/") == true)
    }

    /// The shared instructions name a clip for stabilization analysis; the app finds its source.
    func testStabilizationAnalysisMeasuresANamedClip() async throws {
        let measured = try await call("POST", "/api/analyze", JSON.object([("kind", "stabilization"), ("clip", "c1"), ("comp", .null)]).text)
        XCTAssertEqual(measured["kind"] as? String, "stabilization", "\(measured)")
        XCTAssertNotNil(measured["measurements"])
    }
}
