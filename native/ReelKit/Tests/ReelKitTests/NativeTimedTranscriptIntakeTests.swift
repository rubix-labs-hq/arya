import Foundation
@testable import ReelKit
import XCTest

// Endpoint fixtures for timed transcript intake against the real native backend.
extension TranscriptTests {
    private func timedIntakeFixture() async throws -> (ReelBackend, ProjectFolder, [String: Any]) {
        let (backend, folder) = try await makeBackend()
        let version = await backend.currentVersion()
        return (backend, folder, ["src": "media/talk.mp4", "locale": "en-US", "expectedVersion": version,
                                 "expectedSourceFingerprint": try NativeTranscriptStore.fingerprint("media/talk.mp4", folder: folder), "expectedTranscriptRevision": 0])
    }
    private func importedSaveBody(_ preview: [String: Any]) -> [String: Any] {
        ["src": preview["src"]!, "locale": preview["locale"]!, "words": preview["words"]!, "revision": preview["transcriptRevision"]!,
         "expectedVersion": preview["version"]!, "expectedSourceFingerprint": preview["sourceFingerprint"]!]
    }

    func testTimedJSONPreviewDoesNotSaveThenGuardedSaveReopensExactWords() async throws {
        let (backend, folder, capture) = try await timedIntakeFixture()
        defer { Task { await backend.stop() } }
        let before = await backend.currentProject(), version = await backend.currentVersion()
        let input: [[String: Any]] = [["t": 0.05, "end": 0.15, "text": "Exact", "confidence": 0.75], ["t": 0.18, "end": 0.68, "text": "timing"]]
        var body = capture; body["words"] = input
        let preview = parse(try await backend.handle(method: "POST", path: "/api/transcript/import-preview", body: JSON(any: body).text).text)
        let untouched = parse(try NativeTranscriptStore.read(src: "media/talk.mp4", locale: "en-US", folder: folder).text)
        XCTAssertEqual(untouched["revision"] as? Int, 0)
        let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
        XCTAssertEqual(before, after); XCTAssertEqual(version, afterVersion)
        XCTAssertEqual(JSON(any: preview["words"]).text, JSON(any: input).text)
        _ = try await backend.handle(method: "POST", path: "/api/transcript", body: JSON(any: importedSaveBody(preview)).text)
        let reopened = parse(try NativeTranscriptStore.read(src: "media/talk.mp4", locale: "en-US", folder: folder).text)
        XCTAssertEqual(reopened["revision"] as? Int, 1)
        XCTAssertEqual(JSON(any: reopened["words"]).text, JSON(any: input).text)
    }

    func testTimedSubtitlesEstimateEvenlyAndWarnBeforeSaving() async throws {
        let (backend, folder, capture) = try await timedIntakeFixture()
        defer { Task { await backend.stop() } }
        for format in ["srt", "vtt"] {
            var body = capture; body["format"] = format
            let timing = format == "vtt" ? "00:00:00.100 --> 00:00:00.700" : "00:00:00,100 --> 00:00:00,700"
            body["text"] = (format == "vtt" ? "WEBVTT\n\n" : "1\n") + timing + "\na bb\n"
            let preview = parse(try await backend.handle(method: "POST", path: "/api/transcript/import-preview", body: JSON(any: body).text).text)
            let words = preview["words"] as? [[String: Any]] ?? []
            XCTAssertEqual(words.count, 2)
            XCTAssertEqual((words.first?["t"] as? NSNumber)?.doubleValue ?? -1, 0.1, accuracy: 0.000001)
            XCTAssertEqual((words.first?["end"] as? NSNumber)?.doubleValue ?? -1, 0.4, accuracy: 0.000001)
            XCTAssertEqual((words.last?["end"] as? NSNumber)?.doubleValue ?? -1, 0.7, accuracy: 0.000001)
            XCTAssertTrue((preview["warnings"] as? [String] ?? []).contains { $0.contains("estimated") })
        }
        XCTAssertEqual(parse(try NativeTranscriptStore.read(src: "media/talk.mp4", locale: "en-US", folder: folder).text)["revision"] as? Int, 0)
    }

    func testTimedSubtitleMalformedBlocksNeverAcceptPartialImport() async throws {
        let (backend, folder, capture) = try await timedIntakeFixture()
        defer { Task { await backend.stop() } }
        let before = await backend.currentProject(), version = await backend.currentVersion()
        let valid = "1\n00:00:00,100 --> 00:00:00,300\nValid\n"
        let invalid = [
            valid + "\n2\n00:00:not-a-time --> 00:00:00,600\nBroken\n",
            valid + "\n2\n00:00:00,500 --> 00:00:00,400\nReversed\n",
            valid + "\n2\n00:00:00,400 --> 00:00:00,400\nZero\n",
            valid + "\n2\n00:00:00,400 --> 00:00:90,500\nBad seconds\n",
            valid + "\n2\n00:00:00,400 --> 00:00:30,500\nOutside source\n",
            "1\n00:00:00,500 --> 00:00:00,600\nLater\n\n2\n00:00:00,100 --> 00:00:00,300\nEarlier\n",
            valid + "\n2\n00:00:00,400 --> 00:00:00,600\n<i></i>\n"
        ]
        for text in invalid {
            var body = capture; body["text"] = text; body["format"] = "srt"
            do { _ = try await backend.handle(method: "POST", path: "/api/transcript/import-preview", body: JSON(any: body).text); XCTFail("Malformed subtitles must reject the whole import.") }
            catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        }
        var vtt = capture; vtt["text"] = "WEBVTT\n\n00:00.100 --> 00:00.300\nValid\n\nbroken\nnot a timestamp\nLost words\n"; vtt["format"] = "vtt"
        do { _ = try await backend.handle(method: "POST", path: "/api/transcript/import-preview", body: JSON(any: vtt).text); XCTFail("A malformed VTT cue cannot be silently omitted.") }
        catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(afterVersion, version)
        XCTAssertEqual(parse(try NativeTranscriptStore.read(src: "media/talk.mp4", locale: "en-US", folder: folder).text)["revision"] as? Int, 0)
    }

    func testImportedFirstSaveRejectsChangedSourceAndKeepsRecordMissing() async throws {
        let (backend, folder, capture) = try await timedIntakeFixture()
        defer { Task { await backend.stop() } }
        var body = capture; body["words"] = words
        let preview = parse(try await backend.handle(method: "POST", path: "/api/transcript/import-preview", body: JSON(any: body).text).text)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(100)], ofItemAtPath: folder.resolve("media/talk.mp4").path)
        do { _ = try await backend.handle(method: "POST", path: "/api/transcript", body: JSON(any: importedSaveBody(preview)).text); XCTFail("A first imported save must bind its captured source.") }
        catch { XCTAssertTrue(error.localizedDescription.contains("source changed")) }
        XCTAssertEqual(parse(try NativeTranscriptStore.read(src: "media/talk.mp4", locale: "en-US", folder: folder).text)["revision"] as? Int, 0)
    }

    func testImportedSaveRejectsChangedRevisionAndProject() async throws {
        let (backend, _, capture) = try await timedIntakeFixture()
        defer { Task { await backend.stop() } }
        var body = capture; body["words"] = words
        let preview = parse(try await backend.handle(method: "POST", path: "/api/transcript/import-preview", body: JSON(any: body).text).text)
        _ = try await backend.handle(method: "POST", path: "/api/transcript", body: JSON(any: ["src": "media/talk.mp4", "locale": "en-US", "words": words, "revision": 0]).text)
        do { _ = try await backend.handle(method: "POST", path: "/api/transcript", body: JSON(any: importedSaveBody(preview)).text); XCTFail("Intervening saved words invalidate the imported draft.") }
        catch { XCTAssertTrue(error.localizedDescription.contains("saved transcript changed")) }
        _ = try await backend.editOperations(ops: JSON(any: [["op": "project", "set": ["name": "Changed project"]]]))
        do { _ = try await backend.handle(method: "POST", path: "/api/transcript/import-preview", body: JSON(any: body).text); XCTFail("Intervening project changes invalidate the picker capture.") }
        catch { XCTAssertTrue(error.localizedDescription.contains("project")) }
    }

    func testTimedPreviewRejectsExtraFieldsOversizeAndBooleanTiming() async throws {
        let (backend, _, capture) = try await timedIntakeFixture()
        defer { Task { await backend.stop() } }
        var invalid = capture; invalid["words"] = [["t": true, "end": 0.7, "text": "Bool"]]
        do { _ = try await backend.handle(method: "POST", path: "/api/transcript/import-preview", body: JSON(any: invalid).text); XCTFail("Bool is not a timestamp.") } catch { }
        invalid = capture; invalid["words"] = words; invalid["apply"] = true
        do { _ = try await backend.handle(method: "POST", path: "/api/transcript/import-preview", body: JSON(any: invalid).text); XCTFail("Preview cannot request an edit.") } catch { }
        invalid = capture; invalid["format"] = "srt"; invalid["text"] = String(repeating: "x", count: NativeTimedTranscriptImport.maximumBytes + 1)
        do { _ = try await backend.handle(method: "POST", path: "/api/transcript/import-preview", body: JSON(any: invalid).text); XCTFail("Oversized bodies must reject.") } catch { }
    }
}
