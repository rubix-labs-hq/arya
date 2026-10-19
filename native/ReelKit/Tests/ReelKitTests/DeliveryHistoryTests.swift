import Foundation
import XCTest
@testable import ReelKit

final class DeliveryHistoryTests: XCTestCase {
    private func fixture(_ body: (ProjectFolder, (String, String) throws -> URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("arya-delivery-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root)
        try body(folder) { output, contents in
            let file = folder.root.appendingPathComponent(output)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(contents.utf8).write(to: file)
            return file
        }
    }
    private func rows(_ history: NativeDeliveryHistory) throws -> [[String: Any]] {
        (try JSON.parse(history.list().text) as? [String: Any])?["deliveries"] as? [[String: Any]] ?? []
    }
    func testCompletionSurvivesNewStoreAndPersistsOnlyRelativeFields() throws {
        try fixture { folder, write in
            let file = try write("renders/final.mp4", "fixture")
            try NativeDeliveryHistory(folder: folder).record(output: "renders/final.mp4", preset: "hevc", finished: 1234)
            let reopened = NativeDeliveryHistory(folder: folder), row = try XCTUnwrap(rows(reopened).first)
            XCTAssertEqual(row["provenance"] as? String, "completed"); XCTAssertEqual(row["available"] as? Bool, true)
            XCTAssertEqual(row["finished"] as? Double, 1234)
            XCTAssertEqual(try reopened.resolve(id: XCTUnwrap(row["id"] as? String), root: folder.root.path), file)
            let text = try String(contentsOf: folder.dotDir.appendingPathComponent("deliveries.json"), encoding: .utf8)
            XCTAssertFalse(text.contains(folder.root.path))
        }
    }
    func testExistingOutputDiscoveryDoesNotInventCompletion() throws {
        try fixture { folder, write in
            _ = try write("renders/old.mov", "fixture"); _ = try write("media/original.mov", "original")
            _ = try write("renders/.private.mp4", "private"); _ = try write("renders/unfinished.mp4.part", "partial")
            _ = try write("renders/empty.mp4", "")
            let found = try rows(NativeDeliveryHistory(folder: folder))
            XCTAssertEqual(found.count, 1); XCTAssertEqual(found.first?["output"] as? String, "renders/old.mov")
            XCTAssertEqual(found.first?["provenance"] as? String, "existing")
        }
    }
    func testInterchangeOutputsReopenAsExistingAndResolveWithoutInventingCompletion() throws {
        try fixture { folder, write in
            let contents = ["srt": "1\n00:00:00,100 --> 00:00:00,300\nHello\n", "vtt": "WEBVTT\n\n00:00.100 --> 00:00.300\nHello\n", "otio": "{\"OTIO_SCHEMA\":\"Timeline.1\"}", "fcpxml": "<?xml version=\"1.0\"?><fcpxml version=\"1.10\"/>"]
            var files: [String: URL] = [:], bytes: [String: Data] = [:]
            for format in contents.keys.sorted() {
                let output = "renders/final." + format, file = try write(output, try XCTUnwrap(contents[format]))
                files[output] = file; bytes[output] = try Data(contentsOf: file)
            }
            let first = try rows(NativeDeliveryHistory(folder: folder))
            let reopened = NativeDeliveryHistory(folder: ProjectFolder(root: folder.root)), found = try rows(reopened)
            XCTAssertEqual(found.count, 4)
            XCTAssertEqual(Set(found.compactMap { $0["output"] as? String }), Set(files.keys))
            XCTAssertEqual(Set(found.compactMap { $0["id"] as? String }), Set(first.compactMap { $0["id"] as? String }))
            for row in found {
                let output = try XCTUnwrap(row["output"] as? String), id = try XCTUnwrap(row["id"] as? String)
                XCTAssertEqual(row["provenance"] as? String, "existing"); XCTAssertEqual(row["available"] as? Bool, true)
                XCTAssertNil(row["finished"]); XCTAssertEqual(row["sequence"] as? Bool, false)
                XCTAssertEqual(try reopened.resolve(id: id, root: folder.root.path), try XCTUnwrap(files[output]))
                XCTAssertEqual(try Data(contentsOf: XCTUnwrap(files[output])), try XCTUnwrap(bytes[output]))
            }
            XCTAssertFalse(FileManager.default.fileExists(atPath: folder.dotDir.appendingPathComponent("deliveries.json").path))
        }
    }
    func testInterchangeDiscoveryAndAccessKeepConfinementSourceAndAvailabilityGuards() throws {
        try fixture { folder, write in
            let file = try write("renders/final.srt", "1\n00:00:00,100 --> 00:00:00,300\nHello\n")
            _ = try write("renders/empty.vtt", ""); _ = try write("renders/unfinished.otio.part", "partial")
            _ = try write("renders/.private.fcpxml", "private"); _ = try write("renders/generic.xml", "unsupported")
            let original = try write("media/original.fcpxml", "source"), originalBytes = try Data(contentsOf: original)
            try FileManager.default.createSymbolicLink(at: folder.rendersDir.appendingPathComponent("linked.fcpxml"), withDestinationURL: original)
            var referenced: [String] = []
            for format in ["srt", "vtt", "otio", "fcpxml"] {
                let output = "renders/source." + format
                _ = try write(output, "referenced source"); referenced.append(output)
            }
            let history = NativeDeliveryHistory(folder: folder, sources: referenced), found = try rows(history)
            XCTAssertEqual(found.count, 1); XCTAssertEqual(found.first?["output"] as? String, "renders/final.srt")
            let id = try XCTUnwrap(found.first?["id"] as? String)
            XCTAssertEqual(try history.resolve(id: id, root: folder.root.path), file)
            XCTAssertThrowsError(try history.resolve(id: id, root: folder.root.path + "-different"))
            XCTAssertThrowsError(try history.resolve(id: "../media/original.fcpxml", root: folder.root.path))
            for output in referenced + ["renders/linked.fcpxml", "renders/empty.vtt", "renders/generic.xml"] {
                XCTAssertThrowsError(try history.record(output: output, preset: nil, finished: 1))
            }
            try FileManager.default.removeItem(at: file)
            XCTAssertThrowsError(try history.resolve(id: id, root: folder.root.path))
            XCTAssertEqual(try Data(contentsOf: original), originalBytes)
        }
    }
    func testCopiedFolderReopensRelativeReceiptButRejectsOldIDsAndRoot() throws {
        try fixture { folder, write in
            _ = try write("renders/final.mp4", "fixture")
            let history = NativeDeliveryHistory(folder: folder); try history.record(output: "renders/final.mp4", preset: nil, finished: 1)
            let first = try XCTUnwrap(rows(history).first)
            try fixture { copy, _ in
                try FileManager.default.copyItem(at: folder.rendersDir, to: copy.rendersDir)
                try FileManager.default.copyItem(at: folder.dotDir, to: copy.dotDir)
                let moved = NativeDeliveryHistory(folder: copy), entry = try XCTUnwrap(rows(moved).first)
                XCTAssertEqual(entry["provenance"] as? String, "completed")
                let old = try XCTUnwrap(first["id"] as? String), id = try XCTUnwrap(entry["id"] as? String)
                XCTAssertNotEqual(id, old)
                XCTAssertThrowsError(try moved.resolve(id: old, root: copy.root.path))
                XCTAssertThrowsError(try moved.resolve(id: id, root: folder.root.path))
                XCTAssertEqual(try moved.resolve(id: id, root: copy.root.path).path, copy.rendersDir.appendingPathComponent("final.mp4").path)
            }
        }
    }
    func testMissingReceiptOutputRemainsVisibleAndIsNotAccessible() throws {
        try fixture { folder, write in
            let file = try write("renders/final.mp4", "fixture"), history = NativeDeliveryHistory(folder: folder)
            try history.record(output: "renders/final.mp4", preset: nil, finished: 1)
            let id = try XCTUnwrap(rows(history).first?["id"] as? String)
            try FileManager.default.removeItem(at: file)
            XCTAssertEqual(try rows(history).first?["available"] as? Bool, false)
            XCTAssertThrowsError(try history.resolve(id: id, root: folder.root.path))
            _ = try write("renders/final.mp4", "restored")
            XCTAssertEqual(try history.resolve(id: id, root: folder.root.path), file)
        }
    }
    func testTraversalAndOutsidePathsCannotBecomeReceiptsOrAccess() throws {
        try fixture { folder, _ in
            let history = NativeDeliveryHistory(folder: folder)
            for output in ["../original.mp4", "media/original.mp4", "/tmp/else.mp4", "renders/../original.mp4", "renders//a.mp4", "renders/.secret.mp4", "renders/a\\b.mp4", "renders/a\0.mp4"] {
                XCTAssertThrowsError(try history.record(output: output, preset: nil, finished: 1))
            }
            XCTAssertThrowsError(try history.resolve(id: "../original.mp4", root: folder.root.path))
        }
    }
    func testOutputAndHistorySymlinksCannotEscapeOrOverwrite() throws {
        try fixture { folder, write in
            let original = try write("media/original.mp4", "original")
            try FileManager.default.createDirectory(at: folder.rendersDir, withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(at: folder.rendersDir.appendingPathComponent("linked.mp4"), withDestinationURL: original)
            let history = NativeDeliveryHistory(folder: folder)
            XCTAssertTrue(try rows(history).isEmpty)
            XCTAssertThrowsError(try history.record(output: "renders/linked.mp4", preset: nil, finished: 1))
            _ = try write("renders/final.mp4", "fixture")
            let secret = try write("private.json", "do not touch")
            try FileManager.default.createDirectory(at: folder.dotDir, withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(at: folder.dotDir.appendingPathComponent("deliveries.json"), withDestinationURL: secret)
            XCTAssertThrowsError(try history.record(output: "renders/final.mp4", preset: nil, finished: 1))
            XCTAssertEqual(try String(contentsOf: secret, encoding: .utf8), "do not touch")
        }
    }
    func testReferencedSourcesAndProxyAliasesAreExcluded() throws {
        try fixture { folder, write in
            let original = try write("renders/original.mp4", "original"); _ = try write("renders/proxy.mp4", "proxy")
            try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(at: folder.mediaDir.appendingPathComponent("alias.mp4"), withDestinationURL: original)
            let history = NativeDeliveryHistory(folder: folder, sources: ["media/alias.mp4", "renders/proxy.mp4"])
            XCTAssertTrue(try rows(history).isEmpty)
            XCTAssertThrowsError(try history.record(output: "renders/original.mp4", preset: nil, finished: 1))
        }
    }
    func testSequenceReceiptMissingFramesAndMixedFolders() throws {
        try fixture { folder, write in
            _ = try write("renders/film.frames/frame_00001.png", "one")
            let second = try write("renders/film.frames/frame_00002.png", "two"), history = NativeDeliveryHistory(folder: folder)
            try history.record(output: "renders/film.frames", preset: "png-seq", finished: 1, expectedFrames: 2)
            let entry = try XCTUnwrap(rows(history).first)
            XCTAssertEqual(entry["sequence"] as? Bool, true)
            try FileManager.default.removeItem(at: second)
            XCTAssertEqual(try rows(history).first?["available"] as? Bool, false)
            XCTAssertThrowsError(try history.resolve(id: XCTUnwrap(entry["id"] as? String), root: folder.root.path))
            _ = try write("renders/mixed/frame_00001.png", "one"); _ = try write("renders/mixed/credentials.txt", "private")
            XCTAssertFalse(try rows(history).contains { $0["output"] as? String == "renders/mixed" })
            XCTAssertThrowsError(try history.record(output: "renders/mixed", preset: "png-seq", finished: 1))
        }
    }
    func testMalformedHistorySurvivesAndDiscoveryIsExplicit() throws {
        try fixture { folder, write in
            _ = try write("renders/final.mp4", "fixture"); let file = try write(".reel/deliveries.json", "{broken")
            let history = NativeDeliveryHistory(folder: folder)
            XCTAssertEqual(try rows(history).first?["provenance"] as? String, "existing")
            XCTAssertFalse(((try JSON.parse(history.list().text) as? [String: Any])?["warnings"] as? [String] ?? []).isEmpty)
            XCTAssertThrowsError(try history.record(output: "renders/final.mp4", preset: nil, finished: 1))
            XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "{broken")
        }
    }
    func testRepeatedReceiptUpdatesOneOutputAndRejectsInvalidTime() throws {
        try fixture { folder, write in
            _ = try write("renders/final.mp4", "fixture"); let history = NativeDeliveryHistory(folder: folder)
            try history.record(output: "renders/final.mp4", preset: "hevc", finished: 1)
            try history.record(output: "renders/final.mp4", preset: "h264-high", finished: 2)
            XCTAssertEqual(try rows(history).count, 1); XCTAssertEqual(try rows(history).first?["finished"] as? Double, 2)
            XCTAssertThrowsError(try history.record(output: "renders/final.mp4", preset: nil, finished: .nan))
        }
    }
    func testCompletedHiddenOutputNeedsReceiptWhilePrivateHiddenFilesStayUndiscovered() throws {
        try fixture { folder, write in
            _ = try write("renders/.master.mp4", "completed fixture"); _ = try write("renders/.private.mp4", "private fixture")
            let history = NativeDeliveryHistory(folder: folder)
            XCTAssertTrue(try rows(history).isEmpty)
            try history.record(output: "renders/.master.mp4", preset: "hevc", finished: 1)
            let entry = try XCTUnwrap(rows(history).first)
            XCTAssertEqual(entry["output"] as? String, "renders/.master.mp4")
            XCTAssertEqual(entry["provenance"] as? String, "completed")
            XCTAssertEqual(try history.resolve(id: XCTUnwrap(entry["id"] as? String), root: folder.root.path).lastPathComponent, ".master.mp4")
            XCTAssertFalse(try rows(history).contains { $0["output"] as? String == "renders/.private.mp4" })
        }
    }

}
