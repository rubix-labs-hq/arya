import Foundation
import XCTest
@testable import ReelKit

final class NativeTimedTranscriptImportTests: XCTestCase {
    private let words: [[String: Any]] = [
        ["t": 0.1, "end": 0.8, "text": "Caf\u{e9}", "confidence": 0.8],
        ["t": 0.6, "end": 1.2, "text": "overlap"]
    ]

    private func withFile(_ bytes: Data, format: String = "json", _ action: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("timed-import-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("transcript.\(format)")
        try bytes.write(to: url)
        try action(url)
    }

    private func importedWords(_ document: NativeTimedTranscriptImport.Document?) throws -> [[String: Any]] {
        guard case .words(let words, let warnings)? = document else { throw NSError(domain: "timed-import-test", code: 1) }
        XCTAssertTrue(warnings.isEmpty)
        return words
    }

    func testActualArrayAndObjectJSONFilesKeepTextTimingAndConfidence() throws {
        let documents: [Any] = [words, ["words": words, "provider": "external"]]
        for value in documents {
            try withFile(JSONSerialization.data(withJSONObject: value)) { url in
                let imported = try importedWords(NativeTimedTranscriptImport.read(.success([url]), duration: 2, isCurrent: { true }))
                XCTAssertEqual(imported.count, 2)
                XCTAssertEqual(imported[0]["text"] as? String, "Caf\u{e9}")
                XCTAssertEqual((imported[0]["t"] as? NSNumber)?.doubleValue, 0.1)
                XCTAssertEqual((imported[0]["confidence"] as? NSNumber)?.doubleValue, 0.8)
                XCTAssertEqual((imported[1]["t"] as? NSNumber)?.doubleValue, 0.6)
            }
        }
    }

    func testSubtitleFilesReturnRawUTF8ForTheSharedParser() throws {
        for (format, text) in [("SRT", "1\n00:00:00,100 --> 00:00:01,200\nCaf\u{e9} overlap\n"),
                               ("vtt", "WEBVTT\n\n00:00.100 --> 00:01.200\nCaf\u{e9} overlap\n")] {
            try withFile(Data(text.utf8), format: format) { url in
                guard case .subtitles(let actual, let actualFormat)? = try NativeTimedTranscriptImport.read(.success([url]), duration: 2, isCurrent: { true }) else {
                    XCTFail("A subtitle file must be handed to the shared parser."); return
                }
                XCTAssertEqual(actual, text); XCTAssertEqual(actualFormat, format.lowercased())
            }
        }
    }

    func testPublicValidatorRejectsBooleanStringAndNonfiniteNumericValues() throws {
        let invalidNumbers: [Any] = [true, false, "0.5", Double.nan, Double.infinity, -Double.infinity]
        for key in ["t", "end", "confidence"] {
            for value in invalidNumbers {
                var changed = words; changed[0][key] = value
                XCTAssertThrowsError(try NativeTimedTranscriptImport.validateWords(changed, duration: 2), key)
            }
        }
        let invalidJSONNumbers: [Any] = [true, "0.5"]
        for value in invalidJSONNumbers {
            var changed = words; changed[0]["t"] = value
            try withFile(JSONSerialization.data(withJSONObject: changed)) { url in
                XCTAssertThrowsError(try NativeTimedTranscriptImport.read(.success([url]), duration: 2, isCurrent: { true }))
            }
        }
    }

    func testPublicValidatorEnforcesExactBoundsOrderTextAndFiniteDuration() throws {
        for (key, value) in [("t", -0.1), ("end", 0.1), ("end", 2.001)] {
            var changed = words; changed[0][key] = value
            XCTAssertThrowsError(try NativeTimedTranscriptImport.validateWords(changed, duration: 2))
        }
        var unordered = words; unordered[1]["t"] = 0.05
        XCTAssertThrowsError(try NativeTimedTranscriptImport.validateWords(unordered, duration: 2))
        for text in [" ", String(repeating: "a", count: 1001)] {
            var changed = words; changed[0]["text"] = text
            XCTAssertThrowsError(try NativeTimedTranscriptImport.validateWords(changed, duration: 2))
        }
        for duration in [0, -1, Double.nan, Double.infinity] {
            XCTAssertThrowsError(try NativeTimedTranscriptImport.validateWords(words, duration: duration))
        }
        XCTAssertEqual(try NativeTimedTranscriptImport.validateWords(words, duration: 10 * 60 * 60).count, 2)
        var boundary: [[String: Any]] = [["t": 0, "end": 2, "text": "Entire", "confidence": 2]]
        XCTAssertEqual((try NativeTimedTranscriptImport.validateWords(boundary, duration: 2)[0]["confidence"] as? NSNumber)?.doubleValue, 1)
        boundary[0]["confidence"] = -1
        XCTAssertEqual((try NativeTimedTranscriptImport.validateWords(boundary, duration: 2)[0]["confidence"] as? NSNumber)?.doubleValue, 0)
    }

    func testActualJSONLoaderRejectsEmptyWrongShapeInvalidJSONAndInvalidUTF8() throws {
        for bytes in [Data("[]".utf8), Data("{}".utf8), Data("{\"words\":[1]}".utf8), Data("{\"words\":true}".utf8), Data("not JSON".utf8), Data([0xff])] {
            try withFile(bytes) { url in
                XCTAssertThrowsError(try NativeTimedTranscriptImport.read(.success([url]), duration: 2, isCurrent: { true }))
            }
        }
        for format in ["srt", "vtt"] {
            try withFile(Data(" \n".utf8), format: format) { url in
                XCTAssertThrowsError(try NativeTimedTranscriptImport.read(.success([url]), duration: 2, isCurrent: { true }))
            }
        }
    }

    func testPublicValidatorUsesTheSharedHundredThousandWordLimit() throws {
        let word: [String: Any] = ["t": 0, "end": 0.1, "text": "word"]
        XCTAssertEqual(try NativeTimedTranscriptImport.validateWords(Array(repeating: word, count: 100_000), duration: 2).count, 100_000)
        XCTAssertThrowsError(try NativeTimedTranscriptImport.validateWords(Array(repeating: word, count: 100_001), duration: 2))
    }

    func testActualReaderAcceptsExactByteBudgetAndRejectsAnExtraByte() throws {
        let header = "WEBVTT\n\nNOTE ", cue = "\n\n00:00.100 --> 00:00.800\nCaption\n"
        let text = Data((header + String(repeating: "a", count: NativeTimedTranscriptImport.maximumBytes - header.utf8.count - cue.utf8.count) + cue).utf8)
        try withFile(text, format: "vtt") { url in
            guard case .subtitles(let actual, _)? = try NativeTimedTranscriptImport.read(.success([url]), duration: 2, isCurrent: { true }) else {
                XCTFail("The exact byte budget should be accepted."); return
            }
            XCTAssertEqual(actual.utf8.count, NativeTimedTranscriptImport.maximumBytes)
        }
        try withFile(text + Data([0x61]), format: "vtt") { url in
            XCTAssertThrowsError(try NativeTimedTranscriptImport.read(.success([url]), duration: 2, isCurrent: { true })) { error in
                guard let failure = error as? NativeTimedTranscriptImport.Failure, case .fileTooLarge = failure else { XCTFail("Expected fileTooLarge"); return }
            }
        }
    }

    func testActualBoundedReaderRejectsFileGrowthAfterAttributes() throws {
        try withFile(Data("Initial".utf8), format: "vtt") { url in
            var checks = 0, growthError: Error?
            XCTAssertThrowsError(try NativeTimedTranscriptImport.read(.success([url]), duration: 2, isCurrent: {
                checks += 1
                if checks == 2 {
                    do { try Data(repeating: 0x61, count: NativeTimedTranscriptImport.maximumBytes + 1).write(to: url) }
                    catch { growthError = error }
                }
                return true
            })) { error in
                guard let failure = error as? NativeTimedTranscriptImport.Failure, case .fileTooLarge = failure else { XCTFail("Expected fileTooLarge"); return }
            }
            XCTAssertNil(growthError)
        }
    }

    func testReaderSuppressesStaleSuccessAndFailuresBeforeTouchingFiles() throws {
        let results: [Result<[URL], Error>] = [.success([URL(fileURLWithPath: "/does-not-exist/transcript.json")]),
                                             .failure(NSError(domain: "timed-import-test", code: 4)), .failure(CancellationError())]
        for result in results {
            XCTAssertNil(try NativeTimedTranscriptImport.read(result, duration: 2, isCurrent: { false }))
        }
        XCTAssertNil(try NativeTimedTranscriptImport.read(.success([]), duration: 2, isCurrent: { true }))
    }

    func testReaderDiscardsAChangedOwnerDuringReadAndAfterParsing() throws {
        for invalidateAt in [3, 6] {
            try withFile(JSONSerialization.data(withJSONObject: words)) { url in
                var checks = 0
                XCTAssertNil(try NativeTimedTranscriptImport.read(.success([url]), duration: 2, isCurrent: {
                    checks += 1
                    return checks < invalidateAt
                }))
                XCTAssertEqual(checks, invalidateAt)
            }
        }
    }

    func testCurrentAndLateFailuresKeepOwnershipAndFeedbackRules() throws {
        let original = NSError(domain: "timed-import-test", code: 4)
        XCTAssertThrowsError(try NativeTimedTranscriptImport.read(.failure(original), duration: 2, isCurrent: { true })) { error in
            XCTAssertEqual((error as NSError).domain, original.domain); XCTAssertEqual((error as NSError).code, original.code)
        }
        var checks = 0
        XCTAssertNil(try NativeTimedTranscriptImport.read(.failure(original), duration: 2, isCurrent: { checks += 1; return checks == 1 }))
        let directory = FileManager.default.temporaryDirectory
        XCTAssertThrowsError(try NativeTimedTranscriptImport.read(.success([directory]), duration: 2, isCurrent: { true }))
    }

    func testAlreadyCancelledTaskReturnsNoDocument() async throws {
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            _ = try NativeTimedTranscriptImport.read(.success([URL(fileURLWithPath: "/does-not-exist/transcript.json")]), duration: 2, isCurrent: { true })
        }
        do { try await task.value; XCTFail("Cancellation returned a document.") }
        catch { XCTAssertTrue(error is CancellationError) }
    }

    func testSubtitlePreflightCountsCuesAndPermitsOmittedMetadataAndSettings() throws {
        let vtt = "\u{feff}WEBVTT description\r\n\r\nNOTE Ignore this comment\r\n\r\nSTYLE\r\n::cue { color: red; }\r\n\r\nREGION\r\nid:one\r\n\r\nfirst\r\n00:00.100 --> 00:00.800 align:start line:10%\r\n<b>Caption</b>\r\n\r\n00:00:00.600 --> 00:00:01.200\r\nOverlap\r\n"
        XCTAssertEqual(try NativeTimedTranscriptImport.validateSubtitles(text: vtt, format: "vtt", duration: 2), 2)
        XCTAssertEqual(try NativeTimedTranscriptImport.validateSubtitles(text: "7\n00:00:00,100 --> 00:00:02,000\nCaption\n", format: "srt", duration: 2), 1)
        XCTAssertEqual(try NativeTimedTranscriptImport.validateSubtitles(text: "WEBVTT\n \n \n\n00:00.100 --> 00:00.800\nCaption\n", format: "vtt", duration: 2), 1)
    }

    func testSubtitlePreflightRejectsEveryMalformedCueInsteadOfAcceptingAPartialFile() throws {
        let good = "1\n00:00:00,100 --> 00:00:00,800\nGood\n\n"
        for broken in ["2\n00:00:00,800 --> broken\nBroken", "2\n00:00:60,000 --> 00:01:01,000\nBroken",
                       "2\n00:60:00,000 --> 01:00:01,000\nBroken", "2\n00:00:00,900 --> 00:00:00,800\nBackwards",
                       "2\n00:00:00,900 --> 00:00:02,001\nOutside", "2\n00:00:00,050 --> 00:00:00,900\nUnordered",
                       "2\n00:00:00,900 --> 00:00:01,200", "2\n00:00:00,900 --> 00:00:01,200\n<b></b>",
                       "not a cue", "2\n00:00:00,900 --> 00:00:01,200\nSecond\n3\n00:00:01,200 --> 00:00:01,500\nNo separator",
                       "2\n00:00:00.900 --> 00:00:01.200\nWrong separator", "2\n00:00:00,90 --> 00:00:01,200\nWrong precision",
                       "2\n00:00:00,900 --> 00:00:01,200 garbage\nBad setting"] {
            XCTAssertThrowsError(try NativeTimedTranscriptImport.validateSubtitles(text: good + broken, format: "srt", duration: 2), broken)
        }
        for broken in ["00:00.100 --> 00:00.800\nNo header", "WEBVTT\n00:00.100 --> 00:00.800\nMissing separator",
                       "WEBVTT\n\nunknown block", "WEBVTT\n\nNOTE\n00:00.100 --> 00:00.800\nDisguised cue",
                       "WEBVTT\n\n00:00,100 --> 00:00,800\nWrong separator", "WEBVTT\n\n00:00.100 --> 00:00.800 --> 00:01.000\nBad timing",
                       "WEBVTT\n\nSTYLE\n::cue { color:red; }"] {
            XCTAssertThrowsError(try NativeTimedTranscriptImport.validateSubtitles(text: broken, format: "vtt", duration: 2), broken)
        }
        try withFile(Data((good + "2\nmalformed\nBroken").utf8), format: "srt") { url in
            XCTAssertThrowsError(try NativeTimedTranscriptImport.read(.success([url]), duration: 2, isCurrent: { true }))
        }
    }

    func testSubtitlePreflightEnforcesTheCueAndByteBudgets() throws {
        let cue = "00:00.100 --> 00:00.800\nWord\n\n"
        XCTAssertEqual(try NativeTimedTranscriptImport.validateSubtitles(text: "WEBVTT\n\n" + String(repeating: cue, count: 100_000), format: "vtt", duration: 2), 100_000)
        XCTAssertThrowsError(try NativeTimedTranscriptImport.validateSubtitles(text: "WEBVTT\n\n" + String(repeating: cue, count: 100_001), format: "vtt", duration: 2))
        XCTAssertThrowsError(try NativeTimedTranscriptImport.validateSubtitles(text: String(repeating: "a", count: NativeTimedTranscriptImport.maximumBytes + 1), format: "vtt", duration: 2))
    }
}
