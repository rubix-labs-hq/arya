import Foundation
import XCTest
@testable import ReelKit

/// Prepared offline storage fixtures. Not compiled or executed in the source-only lane.
final class NativeAssistantChatHistoryTests: XCTestCase {
    private func folder(_ label: String = "assistant-history") throws -> ProjectFolder {
        let root = try Support.tempFolder(label)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return ProjectFolder(root: root)
    }
    private func message(_ text: String, provider: String? = nil) -> JSON {
        .compact([("role", "user"), ("text", .string(text)), ("at", 1791082561003), ("provider", provider.map(JSON.string))])
    }
    private func fields(_ value: JSON) throws -> [String: Any] { try XCTUnwrap(JSON.parse(value.text) as? [String: Any]) }
    private func file(_ folder: ProjectFolder) -> URL { folder.dotDir.appendingPathComponent("assistant-chat.json") }

    func testAssistantRoleAndLegacyClaudeRoleRoundTripWithProviderIdentity() throws {
        for role in ["assistant", "claude"] {
            let message = JSON.object([("role", .string(role)), ("text", "Provider reply"), ("at", 1), ("provider", "codex")])
            let displayed = try NativeAssistantChatHistory.displayMessage(message)
            let encoded = Data((JSON.object([("version", 1), ("messages", .array([displayed]))]).text + "\n").utf8)
            let restored = try NativeAssistantChatHistory.parse(encoded)
            XCTAssertEqual(restored.count, 1)
            XCTAssertEqual(restored[0].text, displayed.text)
        }
    }

    func testExactBrowserCorpusRestoresOnlyDisplayRows() throws {
        let folder = try folder(), fixture = try XCTUnwrap(Bundle.module.url(forResource: "AssistantHistoryContract", withExtension: "json", subdirectory: "Fixtures"))
        let bytes = try Data(contentsOf: fixture)
        try FileManager.default.createDirectory(at: folder.dotDir, withIntermediateDirectories: true)
        try bytes.write(to: file(folder))
        let history = NativeAssistantChatHistory(folder: folder)
        let expected = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])["messages"] as? [[String: Any]] ?? []
        XCTAssertEqual(history.messages.count, expected.count)
        for (actual, row) in zip(history.messages, expected) { XCTAssertEqual(JSON(any: try fields(actual)), JSON(any: row)) }
        XCTAssertEqual(try fields(history.status)["restored"] as? Int, 3)
        XCTAssertEqual(try fields(history.status)["savingAvailable"] as? Bool, true)
    }
    func testNativeRichContextProjectsToDisplayLabelsAndDoesNotRetainConsentRunOrCredentials() throws {
        let row: [String: Any] = ["role": "you", "text": "Build this script.", "at": 1791082561003, "provider": "codex",
                                  "refs": ["inputKind": "script", "clips": ["c1"], "composition": "k1", "reference": "media/look.png", "token": "never-retain", "intent": "private source", "project": ["private": true]],
                                  "sharing": ["approved": true], "state": "working", "runID": "never-retain", "route": ["model": "Alpha"]]
        let projected = try NativeAssistantChatHistory.displayMessage(JSON(any: row)), fields = try fields(projected)
        XCTAssertEqual(fields["role"] as? String, "user")
        XCTAssertEqual((fields["refs"] as? [[String: Any]])?.count, 4)
        XCTAssertFalse(projected.text.contains("never-retain")); XCTAssertFalse(projected.text.contains("private source"))
        XCTAssertFalse(projected.text.contains("working")); XCTAssertFalse(projected.text.contains("Alpha"))
        XCTAssertEqual(Set(fields.keys), ["role", "text", "at", "provider", "refs"])
    }
    func testMalformedEnvelopeAndUnknownSavedFieldsRemainUntouched() throws {
        let invalid = ["{", #"{"version":2,"messages":[]}"#, #"{"version":1,"messages":[],"state":"working"}"#,
                       #"{"version":1,"messages":[{"role":"user","text":"Keep","at":1,"sharing":{"approved":true}}]}"#,
                       #"{"version":1,"messages":[{"role":"user","text":"Keep","at":true}]}"#,
                       #"{"version":1,"messages":[{"role":"user","text":"Keep","at":1,"provider":"Claude Code"}]}"#,
                       #"{"version":1,"messages":[{"role":"user","text":"Keep","at":1,"refs":[{"kind":"clip","id":"c1","label":"Title","token":"private"}]}]}"#]
        for saved in invalid {
            let folder = try folder()
            try FileManager.default.createDirectory(at: folder.dotDir, withIntermediateDirectories: true)
            try Data(saved.utf8).write(to: file(folder))
            let history = NativeAssistantChatHistory(folder: folder)
            XCTAssertTrue(history.messages.isEmpty); XCTAssertEqual(try fields(history.status)["savingAvailable"] as? Bool, false)
            try history.append(message("Visible only here."))
            XCTAssertEqual(try String(contentsOf: file(folder), encoding: .utf8), saved)
            XCTAssertTrue((try fields(history.status)["warning"] as? String)?.contains("existing file is unchanged") == true)
            XCTAssertEqual(history.messages.count, 1)
        }
    }
    func testOversizeSavedFileRemainsUntouched() throws {
        let folder = try folder(), bytes = Data(repeating: 120, count: NativeAssistantChatHistory.maximumBytes + 1)
        try FileManager.default.createDirectory(at: folder.dotDir, withIntermediateDirectories: true)
        try bytes.write(to: file(folder))
        let history = NativeAssistantChatHistory(folder: folder)
        try history.append(message("Local only."))
        XCTAssertEqual(try Data(contentsOf: file(folder)), bytes)
        XCTAssertEqual(try fields(history.status)["savingAvailable"] as? Bool, false)
    }
    func testParentAndFileSymlinksCannotReadOrOverwriteAnotherProject() throws {
        for parent in [true, false] {
            let folder = try folder(), other = try self.folder("other-history")
            let target = other.root.appendingPathComponent("assistant-chat.json"), bytes = Data(#"{"version":1,"messages":[{"role":"user","text":"Other project only.","at":1}]}"#.utf8)
            try bytes.write(to: target)
            if parent { try FileManager.default.createSymbolicLink(at: folder.dotDir, withDestinationURL: other.root) }
            else {
                try FileManager.default.createDirectory(at: folder.dotDir, withIntermediateDirectories: true)
                try FileManager.default.createSymbolicLink(at: file(folder), withDestinationURL: target)
            }
            let history = NativeAssistantChatHistory(folder: folder)
            XCTAssertTrue(history.messages.isEmpty); try history.append(message("Local only."))
            XCTAssertEqual(try Data(contentsOf: target), bytes)
            XCTAssertEqual(try fields(history.status)["savingAvailable"] as? Bool, false)
        }
    }
    func testHardlinkedFileCannotReadOrOverwriteAnotherProject() throws {
        let folder = try folder(), other = try self.folder("other-history"), target = other.root.appendingPathComponent("assistant-chat.json")
        let bytes = Data(#"{"version":1,"messages":[{"role":"user","text":"Other project only.","at":1}]}"#.utf8)
        try bytes.write(to: target); try FileManager.default.createDirectory(at: folder.dotDir, withIntermediateDirectories: true)
        try FileManager.default.linkItem(at: target, to: file(folder))
        let history = NativeAssistantChatHistory(folder: folder)
        XCTAssertTrue(history.messages.isEmpty); try history.append(message("Local only."))
        XCTAssertEqual(try Data(contentsOf: target), bytes)
    }
    func testChangedFileCannotBeOverwrittenByAStaleWriter() throws {
        let folder = try folder(), first = NativeAssistantChatHistory(folder: folder), stale = NativeAssistantChatHistory(folder: folder)
        try first.append(message("First writer.")); let saved = try Data(contentsOf: file(folder))
        try stale.append(message("Stale writer."))
        XCTAssertEqual(try Data(contentsOf: file(folder)), saved)
        XCTAssertTrue((try fields(stale.status)["warning"] as? String)?.contains("previous saved file is unchanged") == true)
        XCTAssertEqual(stale.messages.count, 1)
    }
    func testCountAndEncodedByteLimitsRetainLatestCompleteRows() throws {
        let rows = (0..<250).map { message("Message \($0)") }
        let bounded = try NativeAssistantChatHistory.bounded(rows)
        XCTAssertEqual(bounded.count, 200); XCTAssertEqual(try fields(bounded[0])["text"] as? String, "Message 50")
        let large = (0..<4).map { message("\($0):" + String(repeating: "x", count: 650_000)) }
        let byteBounded = try NativeAssistantChatHistory.bounded(large)
        XCTAssertEqual(byteBounded.count, 3)
        XCTAssertTrue((try fields(byteBounded[0])["text"] as? String)?.hasPrefix("1:") == true)
        let oversize = try NativeAssistantChatHistory.displayMessage(message(String(repeating: "\n", count: NativeAssistantChatHistory.maximumBytes)))
        XCTAssertTrue(try NativeAssistantChatHistory.bounded([oversize]).isEmpty)
    }
    func testProjectIsolationAndSafePrivateRoundTrip() throws {
        let first = try folder(), other = try folder("second-history"), history = NativeAssistantChatHistory(folder: first)
        try history.append(message("First project."))
        XCTAssertTrue(NativeAssistantChatHistory(folder: other).messages.isEmpty)
        XCTAssertEqual(NativeAssistantChatHistory(folder: first).messages, history.messages)
        let mode = try FileManager.default.attributesOfItem(atPath: file(first).path)[.posixPermissions] as? NSNumber
        XCTAssertEqual((mode?.intValue ?? 0) & 0o777, 0o600)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: first.dotDir.path).contains { $0.contains(".part.") })
    }
    func testDeniedWriteKeepsVisibleMessageAndPriorFile() throws {
        struct Denied: Error {}
        let folder = try folder(), history = NativeAssistantChatHistory(folder: folder)
        try history.append(message("Saved first.")); let previous = try Data(contentsOf: file(folder))
        try history.append(message("Visible but not saved."), admitWrite: { throw Denied() })
        XCTAssertEqual(history.messages.count, 2); XCTAssertEqual(try Data(contentsOf: file(folder)), previous)
        XCTAssertTrue((try fields(history.status)["warning"] as? String)?.contains("Messages remain visible") == true)
    }
    func testCredentialPatternsAreRedactedInTextAndDisplayReferences() throws {
        let value = try NativeAssistantChatHistory.displayMessage(.raw(#"{"role":"user","text":"sk-ant-abcdefghijklmnop Bearer abcdefghijklmnopqrstuvwxyz012345","at":1,"refs":[{"kind":"clip","id":"c1","label":"sk-ant-abcdefghijklmnop"}]}"#))
        XCTAssertFalse(value.text.contains("sk-ant-")); XCTAssertFalse(value.text.contains("Bearer ")); XCTAssertTrue(value.text.contains("[redacted]"))
    }
    func testChangedHistoryDuringFinalAdmissionIsNeverReplaced() throws {
        let folder = try folder(), history = NativeAssistantChatHistory(folder: folder)
        try history.append(message("Original."))
        let changed = Data(#"{"version":1,"messages":[{"role":"user","text":"Concurrent owner.","at":2}]}"#.utf8)
        var admissionCount = 0
        try history.append(message("Local pending."), admitWrite: {
            admissionCount += 1
            if admissionCount == 2 { try changed.write(to: self.file(folder)) }
        })
        XCTAssertEqual(admissionCount, 2)
        XCTAssertEqual(try Data(contentsOf: file(folder)), changed)
        XCTAssertTrue((try fields(history.status)["warning"] as? String)?.contains("previous saved file is unchanged") == true)
    }
    func testChangedStagingBytesDuringFinalAdmissionAreNeverPublished() throws {
        let folder = try folder(), history = NativeAssistantChatHistory(folder: folder)
        try history.append(message("Original.")); let original = try Data(contentsOf: file(folder))
        var admissionCount = 0
        try history.append(message("Local pending."), admitWrite: {
            admissionCount += 1
            if admissionCount == 2 {
                let names = try FileManager.default.contentsOfDirectory(atPath: folder.dotDir.path)
                let staged = try XCTUnwrap(names.first { $0.contains(".part.") })
                try Data("changed staging bytes".utf8).write(to: folder.dotDir.appendingPathComponent(staged))
            }
        })
        XCTAssertEqual(admissionCount, 2)
        XCTAssertEqual(try Data(contentsOf: file(folder)), original)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: folder.dotDir.path).contains { $0.contains(".part.") })
    }

    func testJavaScriptBoundaryAndWhitespaceRedactionForUnicodePrefixAndBOM() throws {
        let prompt = "前SK-ANT-ABCDEFGHIJKLMNOP Bearer\u{FEFF}abcdefghijklmnopqrstuvwxyz012345 wordsk-ant-abcdefghijklmnop"
        let value = try NativeAssistantChatHistory.displayMessage(message(prompt))
        let text = try XCTUnwrap(fields(value)["text"] as? String)
        XCTAssertEqual(text, "前[redacted] [redacted] wordsk-ant-abcdefghijklmnop")
    }

    func testAcceptedLargeGraphemePromptRemainsInLiveConversationAlongsideReply() throws {
        let prompt = String(repeating: "👨‍👩‍👧‍👦", count: 90_000)
        XCTAssertEqual(prompt.count, 90_000)
        XCTAssertLessThanOrEqual(prompt.count, 128_000)
        XCTAssertEqual(prompt.utf8.count, 2_250_000)
        let user = message(prompt, provider: "codex"), reply = JSON.object([("role", "claude"), ("text", "Which title should I use?"), ("at", 1791082561004), ("provider", "codex")])
        XCTAssertEqual(NativeAssistantChatHistory.boundedLive([user]), [user])
        XCTAssertEqual(NativeAssistantChatHistory.boundedLive([user, reply]), [user, reply])
        XCTAssertTrue(try NativeAssistantChatHistory.bounded([user]).isEmpty)
        XCTAssertEqual(NativeAssistantChatHistory.boundedLive((0..<120).map { message("Message \($0)") }).count, 100)
    }

    func testOversizePromptAndReplyPreserveSavedFileAndWarningAfterLaterSuccessfulSave() throws {
        for role in ["you", "claude"] {
            let folder = try folder(), history = NativeAssistantChatHistory(folder: folder)
            try history.append(message("Saved first.")); let previous = try Data(contentsOf: file(folder))
            let prompt = String(repeating: "👨‍👩‍👧‍👦", count: 90_000)
            let large = JSON.object([("role", .string(role)), ("text", .string(prompt)), ("at", 1791082561004), ("provider", "codex")])
            let live = NativeAssistantChatHistory.boundedLive([large])
            try history.append(large)
            XCTAssertEqual(live, [large]); XCTAssertEqual(history.messages.count, 1)
            XCTAssertEqual(try Data(contentsOf: file(folder)), previous)
            XCTAssertTrue((try fields(history.status)["warning"] as? String)?.contains("was not saved") == true)
            try history.append(message("A later saved message."))
            XCTAssertEqual(history.messages.count, 2)
            XCTAssertTrue((try fields(history.status)["warning"] as? String)?.contains("will not appear after reopening") == true)
            XCTAssertEqual(try fields(history.status)["savingAvailable"] as? Bool, true)
            let saved = try Data(contentsOf: file(folder))
            XCTAssertLessThanOrEqual(saved.count, NativeAssistantChatHistory.maximumBytes)
            XCTAssertEqual(NativeAssistantChatHistory(folder: folder).messages.count, 2)
            XCTAssertEqual(NativeAssistantChatHistory.boundedLive(live + [message("Small reply.")]).count, 2)
        }
    }

}
