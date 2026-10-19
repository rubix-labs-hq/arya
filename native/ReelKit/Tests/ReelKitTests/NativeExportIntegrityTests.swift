import Darwin
import Foundation
import XCTest
@testable import ReelKit

final class NativeExportIntegrityTests: XCTestCase {
    private let original = Data("synthetic original bytes".utf8)
    private let rendered = Data("synthetic output bytes".utf8)

    private func fixture(_ action: (URL, ProjectFolder) throws -> Void) throws {
        let root = try Support.tempFolder("native-export-integrity")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("media"), withIntermediateDirectories: true)
        try action(root, ProjectFolder(root: root))
    }
    private func sourceProject(_ src: String, proxy: String? = nil, lut: String? = nil) -> String {
        var asset: [String: Any] = ["assetKind": "video"]
        if let proxy { asset["proxy"] = proxy }
        return JSON(any: ["assets": [src: asset], "tracks": [["clips": [["src": src, "grade": ["lut": lut ?? ""]]]]]]).text
    }

    func testSourceReplacementWithRestoredSizeAndMtimeRejects() throws {
        try fixture { root, folder in
            let src = root.appendingPathComponent("media/source.mov")
            try original.write(to: src)
            let before = try FileManager.default.attributesOfItem(atPath: src.path)
            let capture = try NativeExportSources.capture(project: sourceProject("media/source.mov"), folder: folder)
            try Data(repeating: 65, count: original.count).write(to: src)
            try FileManager.default.setAttributes([.modificationDate: before[.modificationDate]!], ofItemAtPath: src.path)
            XCTAssertThrowsError(try capture.validate(folder: folder))
            XCTAssertEqual(try Data(contentsOf: src), Data(repeating: 65, count: original.count))
        }
    }

    func testSourceDirectoryReplacementRejectsSameFileMovedToNewParent() throws {
        try fixture { root, folder in
            let src = root.appendingPathComponent("media/source.mov")
            try original.write(to: src)
            let capture = try NativeExportSources.capture(project: sourceProject("media/source.mov"), folder: folder)
            let old = root.appendingPathComponent("media-before")
            try FileManager.default.moveItem(at: root.appendingPathComponent("media"), to: old)
            try FileManager.default.createDirectory(at: root.appendingPathComponent("media"), withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: old.appendingPathComponent("source.mov"), to: src)
            XCTAssertThrowsError(try capture.validate(folder: folder))
            XCTAssertEqual(try Data(contentsOf: src), original)
        }
    }

    func testAudioProxyAndLUTAreCapturedAndChangedLUTRejects() throws {
        try fixture { root, folder in
            for name in ["source.wav", "proxy.mov", "grade.cube"] { try original.write(to: root.appendingPathComponent("media/" + name)) }
            let capture = try NativeExportSources.capture(project: sourceProject("media/source.wav", proxy: "media/proxy.mov", lut: "media/grade.cube"), folder: folder)
            XCTAssertEqual(capture.files.map(\.alias), ["media/grade.cube", "media/proxy.mov", "media/source.wav"])
            try rendered.write(to: root.appendingPathComponent("media/grade.cube"))
            XCTAssertThrowsError(try capture.validate(folder: folder))
        }
    }

    func testMissingAndFIFOSourcesRejectWithoutReading() throws {
        try fixture { root, folder in
            XCTAssertThrowsError(try NativeExportSources.capture(project: sourceProject("media/missing.mov"), folder: folder))
            let fifo = root.appendingPathComponent("media/fifo.mov")
            XCTAssertEqual(Darwin.mkfifo(fifo.path, 0o600), 0)
            XCTAssertThrowsError(try NativeExportSources.capture(project: sourceProject("media/fifo.mov"), folder: folder))
        }
    }

    func testExistingEmptyRegularDirectoryFIFOAndDanglingLinkOutputsReject() throws {
        try fixture { root, folder in
            try FileManager.default.createDirectory(at: root.appendingPathComponent("renders"), withIntermediateDirectories: true)
            for name in ["full.png", "empty.png"] {
                let url = root.appendingPathComponent("renders/" + name)
                try (name == "full.png" ? original : Data()).write(to: url)
                XCTAssertThrowsError(try NativeExportOutput(folder: folder, destination: url))
                XCTAssertEqual(try Data(contentsOf: url), name == "full.png" ? original : Data())
            }
            let dir = root.appendingPathComponent("renders/sequence.frames")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            XCTAssertThrowsError(try NativeExportOutput(folder: folder, destination: dir))
            let fifo = root.appendingPathComponent("renders/fifo.png")
            XCTAssertEqual(Darwin.mkfifo(fifo.path, 0o600), 0)
            XCTAssertThrowsError(try NativeExportOutput(folder: folder, destination: fifo))
            let link = root.appendingPathComponent("renders/link.png")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: root.appendingPathComponent("missing"))
            XCTAssertThrowsError(try NativeExportOutput(folder: folder, destination: link))
        }
    }

    func testLateCollisionPreservesOriginalAndOwnedPart() throws {
        try fixture { root, folder in
            let output = root.appendingPathComponent("renders/final.mp4")
            let publication = try NativeExportOutput(folder: folder, destination: output)
            try rendered.write(to: publication.part)
            try original.write(to: output)
            XCTAssertThrowsError(try publication.publish())
            XCTAssertEqual(try Data(contentsOf: output), original)
            XCTAssertEqual(try Data(contentsOf: publication.part), rendered)
            publication.cleanup()
            XCTAssertFalse(FileManager.default.fileExists(atPath: publication.part.path))
        }
    }

    func testExclusiveSequencePublicationAndCancellationCleanup() throws {
        try fixture { root, folder in
            let output = root.appendingPathComponent("renders/final.frames")
            let publication = try NativeExportOutput(folder: folder, destination: output)
            try FileManager.default.createDirectory(at: publication.part, withIntermediateDirectories: false)
            try rendered.write(to: publication.part.appendingPathComponent("frame_00001.png"))
            XCTAssertEqual(try publication.publish(), output)
            XCTAssertEqual(try Data(contentsOf: output.appendingPathComponent("frame_00001.png")), rendered)
            publication.cleanup()
            let cancelled = try NativeExportOutput(folder: folder, destination: root.appendingPathComponent("renders/cancelled.mp4"))
            try rendered.write(to: cancelled.part)
            cancelled.cleanup()
            XCTAssertFalse(FileManager.default.fileExists(atPath: cancelled.destination.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: cancelled.part.path))
        }
    }

    func testOutputParentSwapRejectsAndCleansOnlyDetachedOwnedStaging() throws {
        try fixture { root, folder in
            let publication = try NativeExportOutput(folder: folder, destination: root.appendingPathComponent("renders/final.mp4"))
            try rendered.write(to: publication.part)
            let old = root.appendingPathComponent("renders-before")
            try FileManager.default.moveItem(at: root.appendingPathComponent("renders"), to: old)
            try FileManager.default.createDirectory(at: root.appendingPathComponent("renders"), withIntermediateDirectories: false)
            let sentinel = root.appendingPathComponent("renders/keep.mp4")
            try original.write(to: sentinel)
            XCTAssertThrowsError(try publication.publish())
            publication.cleanup()
            XCTAssertEqual(try Data(contentsOf: sentinel), original)
            XCTAssertFalse(FileManager.default.fileExists(atPath: publication.destination.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: old.appendingPathComponent(publication.part.deletingLastPathComponent().lastPathComponent + "/output.part").path))
        }
    }

    func testStillSourceChangeAtPublicationRejectsAndKeepsExistingSources() async throws {
        let root = try Support.tempFolder("still-source-suspend")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root), core = try ReelCore(scriptURL: Support.core())
        var fields = parse(try core.newProject(name: "Source capture", options: #"{"width":64,"height":64,"fps":1}"#))
        let source = root.appendingPathComponent("source.wav")
        try original.write(to: source)
        fields["assets"] = ["source.wav": ["assetKind": "audio", "duration": 1]]
        let project = try core.applyOps(project: JSON(any: fields).text, ops: #"[{"op":"add_color","dur":1}]"#).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let replacement = rendered
        do {
            _ = try await renderer.still(project: project, at: 0, name: "changed.png") { try replacement.write(to: source) }
            XCTFail("A source changed before still publication")
        } catch { XCTAssertTrue(error.localizedDescription.contains("source changed")) }
        XCTAssertEqual(try Data(contentsOf: source), replacement)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".reel/frames/changed.png").path))
    }
}
