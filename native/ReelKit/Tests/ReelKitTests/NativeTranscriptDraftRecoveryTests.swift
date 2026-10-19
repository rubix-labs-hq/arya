import Darwin
import Foundation
import XCTest
@testable import ReelKit

final class NativeTranscriptDraftRecoveryTests: XCTestCase {
    private let words: [[String: Any]] = [["t": 0.0, "end": 1.0, "text": "Hello"], ["t": 1.0, "end": 2.0, "text": "world"]]
    private func fixture() throws -> ProjectFolder {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("reel-draft-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root)
        try Data("{\"assets\":{\"media.wav\":{}}}\n".utf8).write(to: folder.projectFile)
        try Data("fixture source".utf8).write(to: root.appendingPathComponent("media.wav"))
        _ = try NativeTranscriptStore.save(src: "media.wav", locale: "en-US", words: words, expectedRevision: 0, duration: 2, folder: folder)
        return folder
    }
    private func fields(_ value: JSON) throws -> [String: Any] { try JSON.parse(value.text) as? [String: Any] ?? [:] }
    private func context(_ folder: ProjectFolder) throws -> [String: Any] { try fields(NativeTranscriptDraftStore.handle(action: "context", body: ["src": "media.wav", "locale": "en-US"], folder: folder)) }
    private func checkpoint(_ folder: ProjectFolder, session: String = UUID().uuidString.lowercased(), sequence: Int = 1, parent: String? = nil, words: [[String: Any]]? = nil, publication: () throws -> Void = {}) throws -> [String: Any] {
        var body: [String: Any] = ["src": "media.wav", "locale": "en-US", "sessionID": session, "sequence": sequence, "words": words ?? self.words, "basis": try context(folder)["basis"]!]
        if let parent { body["parent"] = parent }
        return try fields(NativeTranscriptDraftStore.handle(action: "checkpoint", body: body, folder: folder, assertPublication: publication))
    }
    private func action(_ action: String, id: String, folder: ProjectFolder) throws -> [String: Any] { try fields(NativeTranscriptDraftStore.handle(action: action, body: ["src": "media.wav", "locale": "en-US", "id": id], folder: folder)) }

    func testReopenOffersExactWhitespaceAndEmptyTextWithoutChangingSavedWords() throws {
        let folder = try fixture(), saved = try Data(contentsOf: NativeTranscriptStore.file(src: "media.wav", locale: "en-US", folder: folder))
        let edited: [[String: Any]] = [["t": 0.0, "end": 1.0, "text": " \t Hello \n"], ["t": 1.0, "end": 2.0, "text": ""]]
        let receipt = try checkpoint(folder, words: edited), reopened = ProjectFolder(root: folder.root)
        let offer = try XCTUnwrap((context(reopened)["offers"] as? [[String: Any]])?.first)
        XCTAssertEqual(offer["id"] as? String, receipt["id"] as? String); XCTAssertEqual(offer["recoverable"] as? Bool, true)
        let recovered = try action("recover", id: receipt["id"] as! String, folder: reopened)
        XCTAssertEqual((recovered["words"] as? [[String: Any]])?.map { $0["text"] as? String }, [" \t Hello \n", ""])
        XCTAssertEqual(try Data(contentsOf: NativeTranscriptStore.file(src: "media.wav", locale: "en-US", folder: folder)), saved)
        XCTAssertEqual(try String(contentsOf: folder.root.appendingPathComponent("media.wav"), encoding: .utf8), "fixture source")
    }
    func testSourceRewriteIsCopyOnlyAndRecoveryRejectsOldTimestamps() throws {
        let folder = try fixture(), receipt = try checkpoint(folder), id = receipt["id"] as! String
        try Data("replacement source".utf8).write(to: folder.root.appendingPathComponent("media.wav"))
        XCTAssertEqual((try context(folder)["offers"] as? [[String: Any]])?.first?["recoverable"] as? Bool, false)
        XCTAssertThrowsError(try action("recover", id: id, folder: folder))
        XCTAssertEqual((try action("read", id: id, folder: folder)["words"] as? [[String: Any]])?.count, 2)
    }
    func testProjectAndSavedRevisionChangesRejectExplicitRecovery() throws {
        for savedRevision in [false, true] {
            let folder = try fixture(), receipt = try checkpoint(folder), id = receipt["id"] as! String
            if savedRevision { _ = try NativeTranscriptStore.save(src: "media.wav", locale: "en-US", words: words, expectedRevision: 1, duration: 2, folder: folder) }
            else { try Data("{\"assets\":{\"media.wav\":{}}} \n".utf8).write(to: folder.projectFile) }
            XCTAssertThrowsError(try action("recover", id: id, folder: folder))
            XCTAssertEqual((try action("read", id: id, folder: folder)["words"] as? [[String: Any]])?.count, 2)
        }
    }
    func testTwoSessionsAndStaleParentDoNotOverwriteEachOther() throws {
        let folder = try fixture(), first = try checkpoint(folder), other = try checkpoint(folder)
        let next = try checkpoint(folder, session: first["sessionID"] as! String, sequence: 2, parent: first["id"] as? String)
        XCTAssertThrowsError(try checkpoint(folder, session: first["sessionID"] as! String, sequence: 2, parent: first["id"] as? String))
        _ = try action("discard", id: next["id"] as! String, folder: folder)
        XCTAssertEqual((try context(folder)["offers"] as? [[String: Any]])?.map { $0["id"] as? String }, [other["id"] as? String])
    }
    func testFailedPublicationKeepsPriorHeadAndHonorsCurrentWriteAdmission() throws {
        let folder = try fixture(), first = try checkpoint(folder)
        XCTAssertThrowsError(try checkpoint(folder, session: first["sessionID"] as! String, sequence: 2, parent: first["id"] as? String) { throw ReelBackend.APIError("fixture ProjectWriteAdmission refusal") })
        XCTAssertEqual((try context(folder)["offers"] as? [[String: Any]])?.first?["id"] as? String, first["id"] as? String)
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.root.appendingPathComponent(".reel/transcript-drafts").path)
        XCTAssertEqual(names, [(first["id"] as! String) + ".json"])
    }
    func testEditedTimestampAndLinkedRecordAreRefused() throws {
        let folder = try fixture(), first = try checkpoint(folder)
        XCTAssertThrowsError(try checkpoint(folder, words: [["t": 0.0, "end": 0.5, "text": "Hello"], words[1]]))
        let dir = folder.root.appendingPathComponent(".reel/transcript-drafts"), linked = UUID().uuidString.lowercased()
        try FileManager.default.createSymbolicLink(atPath: dir.appendingPathComponent(linked + ".json").path, withDestinationPath: dir.appendingPathComponent((first["id"] as! String) + ".json").path)
        XCTAssertEqual((try context(folder)["warnings"] as? [String])?.count, 1)
        XCTAssertThrowsError(try action("read", id: linked, folder: folder))
    }
    func testHeldSharedLockRefusesAnotherCheckpointBeforeCreatingAnyDraftRecord() throws {
        let folder = try fixture(), recovery = try NativeProjectRecovery.Store(folder: folder)
        let lock = try NativeProjectRecovery.PublicationLock(directory: recovery.directoryFD)
        defer { withExtendedLifetime(lock) {} }
        XCTAssertThrowsError(try checkpoint(folder))
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.root.appendingPathComponent(".reel/transcript-drafts").path))
    }
    func testFifoAndExternalHardlinkAreRefusedWithoutReadingTheirContents() throws {
        let folder = try fixture(), receipt = try checkpoint(folder), dir = folder.root.appendingPathComponent(".reel/transcript-drafts")
        let fifo = dir.appendingPathComponent(UUID().uuidString.lowercased() + ".json")
        XCTAssertEqual(Darwin.mkfifo(fifo.path, 0o600), 0)
        let record = dir.appendingPathComponent((receipt["id"] as! String) + ".json"), link = folder.root.appendingPathComponent("external-hardlink")
        XCTAssertEqual(Darwin.link(record.path, link.path), 0)
        let result = try context(folder)
        XCTAssertEqual((result["warnings"] as? [String])?.count, 2)
        XCTAssertTrue((result["offers"] as? [[String: Any]])?.isEmpty == true)
    }

    func testExhaustedDiscardSequencePreservesLastReadableHead() throws {
        let folder = try fixture(), receipt = try checkpoint(folder), id = receipt["id"] as! String
        let file = folder.root.appendingPathComponent(".reel/transcript-drafts/" + id + ".json")
        var record = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        record["sequence"] = 1_000_000_000
        let bytes = try JSONSerialization.data(withJSONObject: record); try bytes.write(to: file)
        XCTAssertThrowsError(try action("discard", id: id, folder: folder))
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        XCTAssertEqual((try action("read", id: id, folder: folder)["words"] as? [[String: Any]])?.count, 2)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path), [id + ".json"])
    }

}
