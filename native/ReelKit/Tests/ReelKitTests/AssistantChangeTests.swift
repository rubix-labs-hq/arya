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
