import Foundation
@testable import ReelKit
import XCTest

// These run against copied synthetic media and the real native backend.
extension TranscriptTests {
    private func reviewedCaptionFixture() async throws -> (ReelBackend, ProjectFolder, [String: Any]) {
        let (backend, folder) = try await makeBackend()
        _ = try await backend.editOperations(ops: JSON(any: [["op": "add_comp", "name": "Caption review", "width": 640, "height": 360],
            ["op": "add_clip", "comp": "k1", "src": "media/talk.mp4", "start": 2, "in": 0, "dur": 0.8, "set": ["speed": 2]]]))
        let supplied = words.map { $0.merging(["confidence": 0.8]) { _, new in new } }
        let saved = parse(try await backend.handle(method: "POST", path: "/api/transcript", body: JSON(any: ["src": "media/talk.mp4", "locale": "en-US", "words": supplied, "revision": 0]).text).text)
        let version = await backend.currentVersion()
        let body: [String: Any] = ["src": "media/talk.mp4", "locale": "en-US", "words": supplied, "comp": "k1", "id": "c1",
            "style": "karaoke", "maxChars": 16, "maxLines": 1, "track": "C2", "replace": false, "burnIn": false, "apply": false,
            "expectedVersion": version, "expectedSourceFingerprint": saved["fingerprint"]!, "expectedTranscriptRevision": saved["revision"]!]
        return (backend, folder, body)
    }

    func testReviewedCaptionApplyRejectsSavedCorrectionAfterClientPreview() async throws {
        let (backend, _, body) = try await reviewedCaptionFixture()
        defer { Task { await backend.stop() } }
        let preview = parse(try await backend.handle(method: "POST", path: "/api/captions/from-transcript", body: JSON(any: body).text).text)
        XCTAssertEqual(preview["transcriptRevision"] as? Int, 1)
        let before = await backend.currentProject(), version = await backend.currentVersion()
        var corrected = words; corrected[0]["text"] = "Corrected"
        _ = try await backend.handle(method: "POST", path: "/api/transcript", body: JSON(any: ["src": "media/talk.mp4", "locale": "en-US", "words": corrected, "revision": 1]).text)
        var apply = body; apply["apply"] = true
        do {
            _ = try await backend.handle(method: "POST", path: "/api/captions/from-transcript", body: JSON(any: apply).text)
            XCTFail("A changed saved revision must invalidate the caption preview.")
        } catch { XCTAssertTrue(error.localizedDescription.contains("transcript changed")) }
        let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(afterVersion, version)
    }

    func testReviewedCaptionApplyRejectsReplacedCopiedSource() async throws {
        let (backend, folder, body) = try await reviewedCaptionFixture()
        defer { Task { await backend.stop() } }
        _ = try await backend.handle(method: "POST", path: "/api/captions/from-transcript", body: JSON(any: body).text)
        let before = await backend.currentProject(), version = await backend.currentVersion()
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(100)], ofItemAtPath: folder.resolve("media/talk.mp4").path)
        var apply = body; apply["apply"] = true
        do {
            _ = try await backend.handle(method: "POST", path: "/api/captions/from-transcript", body: JSON(any: apply).text)
            XCTFail("A changed copied source must invalidate the caption preview.")
        } catch { XCTAssertTrue(error.localizedDescription.contains("source changed")) }
        let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(afterVersion, version)
    }

    func testReviewedCaptionApplyKeepsGroupingConfidenceAndBurnInAndCanUndo() async throws {
        let (backend, folder, body) = try await reviewedCaptionFixture()
        defer { Task { await backend.stop() } }
        let before = await backend.currentProject(), version = await backend.currentVersion()
        let preview = parse(try await backend.handle(method: "POST", path: "/api/captions/from-transcript", body: JSON(any: body).text).text)
        let items = preview["items"] as? [[String: Any]] ?? []
        XCTAssertFalse(items.isEmpty)
        XCTAssertEqual((items.first?["t"] as? NSNumber)?.doubleValue ?? -1, 2.05, accuracy: 0.0001)
        XCTAssertEqual(preview["sourceFingerprint"] as? String, body["expectedSourceFingerprint"] as? String)
        var apply = body; apply["apply"] = true
        let created = parse(try await backend.handle(method: "POST", path: "/api/captions/from-transcript", body: JSON(any: apply).text).text)
        XCTAssertEqual(created["applied"] as? Bool, true)
        XCTAssertEqual(created["version"] as? Int, version + 1)
        let projectSnapshot = await backend.currentProject()
        let projectText = try XCTUnwrap(projectSnapshot)
        let tracks = object(object(parse(projectText)["comps"])["k1"])["tracks"] as? [[String: Any]] ?? []
        let track = try XCTUnwrap(tracks.first { $0["id"] as? String == "C2" })
        XCTAssertEqual(track["burnIn"] as? Bool, false)
        XCTAssertEqual(object(track["style"])["preset"] as? String, "karaoke")
        XCTAssertEqual((track["clips"] as? [[String: Any]])?.count, items.count)
        let saved = parse(try NativeTranscriptStore.read(src: "media/talk.mp4", locale: "en-US", folder: folder).text)
        XCTAssertEqual(saved["revision"] as? Int, 1)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let restored = await backend.currentProject()
        XCTAssertEqual(restored, before)
    }

    func testReviewedCaptionWordsCannotBypassComparisonWithCaptionsFalse() async throws {
        let (backend, _, body) = try await reviewedCaptionFixture()
        defer { Task { await backend.stop() } }
        let before = await backend.currentProject()
        var changed = body, supplied = words; supplied[0]["text"] = "Unsaved"
        changed["words"] = supplied; changed["captions"] = false; changed["apply"] = true
        do {
            _ = try await backend.handle(method: "POST", path: "/api/captions/from-transcript", body: JSON(any: changed).text)
            XCTFail("The caption endpoint must compare supplied words even when captions:false is present.")
        } catch { XCTAssertTrue(error.localizedDescription.contains("reviewed transcript words changed")) }
        let after = await backend.currentProject()
        XCTAssertEqual(after, before)
    }
}
