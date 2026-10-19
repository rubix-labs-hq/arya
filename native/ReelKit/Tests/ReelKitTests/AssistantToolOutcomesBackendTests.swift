import Foundation
import XCTest
@testable import ReelKit

private actor ToolOutcomeMusicRenderGate {
    private var entered = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var permit: CheckedContinuation<Void, Never>?
    private(set) var renderCount = 0
    func waitForRender() async {
        if entered { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() { permit?.resume(); permit = nil }
    func render(folder: ProjectFolder, score: String, script: URL) async throws -> NativeMusicComposer.Rendered {
        entered = true; renderCount += 1
        for waiter in waiters { waiter.resume() }; waiters = []
        await withCheckedContinuation { permit = $0 }
        try Task.checkCancellation()
        return try await NativeMusicComposer.render(folder: folder, scoreJSON: score, scriptURL: script)
    }
}

final class AssistantToolOutcomesBackendTests: XCTestCase {
    func testActualSavedMusicReceiptAndReviewedRetryRecoverOnlyMusicOutcomeWithoutRegeneration() async throws {
        let root = try Support.tempFolder("music-outcome-retry"), gate = ToolOutcomeMusicRenderGate()
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), renderMusic: { folder, score, script in
            try await gate.render(folder: folder, score: score, script: script)
        }) { _, _ in }
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"name":"Outcome retry"}"#)
        let version = await backend.currentVersion()
        let score: [String: Any] = ["version": 1, "title": "Original outcome test cue", "bpm": 120, "lengthBeats": 2, "seed": 17, "room": 0,
                                    "parts": [["id": "keys", "instrument": "keys", "gainDb": -12, "pan": 0,
                                               "notes": [["at": 0.25, "duration": 1.5, "pitch": 62, "velocity": 0.7]]]]]
        let request: [String: Any] = ["score": score, "track": "A3", "start": 0, "comp": NSNull(), "expectedVersion": version]
        let compose = Task { try await backend.handleAssistant(method: "POST", path: "/api/audio/compose", body: JSON(any: request).text) }
        await gate.waitForRender()
        _ = try await backend.editOperations(ops: .raw(#"[{"op":"project","set":{"name":"User reviewed target"}}]"#))
        await gate.release()
        let ready = parse(try await compose.value.text)
        XCTAssertEqual(ready["state"] as? String, "asset_ready"); XCTAssertEqual(ready["applied"] as? Bool, false)
        let path = try XCTUnwrap(ready["path"] as? String), originalBytes = try Data(contentsOf: root.appendingPathComponent(path))
        let retainedText = await backend.currentProject(), retained = parse(try XCTUnwrap(retainedText))
        XCTAssertNotNil(object(retained["assets"])[path])
        var outcomes = AssistantToolOutcomes()
        outcomes.record(method: "POST", path: "/api/audio/compose", body: request, result: ready)
        XCTAssertTrue(outcomes.unresolvedMessage?.contains("saved in Media") == true)
        let nextVersion = await backend.currentVersion()
        let retry: [String: Any] = ["path": path, "track": "A3", "start": 2, "comp": NSNull(), "expectedVersion": nextVersion]
        let placed = parse(try await backend.handleAssistant(method: "POST", path: "/api/audio/compose/place", body: JSON(any: retry).text).text)
        XCTAssertEqual(placed["state"] as? String, "complete")
        outcomes.record(method: "POST", path: "/api/audio/compose/place", body: retry, result: placed)
        XCTAssertNil(outcomes.unresolvedMessage)
        XCTAssertEqual(outcomes.completionMessage(failedJobCount: 1, projectChanged: true), "1 processing result(s) were not applied. Review saved assets and any committed edits.")
        let renderCount = await gate.renderCount
        XCTAssertEqual(renderCount, 1); XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(path)), originalBytes)
        let placedText = await backend.currentProject(), placedProject = parse(try XCTUnwrap(placedText))
        XCTAssertEqual(object(placedProject["assets"]).count, object(retained["assets"]).count)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let undoneText = await backend.currentProject(), undone = parse(try XCTUnwrap(undoneText))
        XCTAssertNotNil(object(undone["assets"])[path])
        let track = (undone["tracks"] as? [[String: Any]] ?? []).first { $0["id"] as? String == "A3" }
        XCTAssertTrue((track?["clips"] as? [Any] ?? []).isEmpty)
        await backend.stop()
    }
}
