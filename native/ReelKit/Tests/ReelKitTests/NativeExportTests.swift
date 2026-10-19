import AVFoundation
import CoreVideo
import ImageIO
import XCTest
@testable import ReelKit

final class NativeExportTests: XCTestCase {
    func testRec709MiddleGrayExportAndVideoReimportPreserveLevels() async throws {
        let root = try Support.tempFolder("rec709-gray"), folder = ProjectFolder(root: root), core = try ReelCore(scriptURL: Support.core())
        let base = try core.newProject(name: "Rec709 gray", options: #"{"width":160,"height":90,"fps":10}"#)
        let project = try core.applyOps(project: base, ops: ##"[{"op":"add_color","color":"#404040","dur":1}]"##).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let original = try await renderer.render(project: project, at: 0.5)
        XCTAssertEqual(pixel(original.pixelBuffer, 80, 45), [64, 64, 64, 255])
        let movie = try await renderer.export(project: project, spec: ReelNativeExportSpec(body: #"{"preset":"h264-high","name":"gray","to":1,"fps":10}"#))
        let asset = AVURLAsset(url: movie), tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first), formats = try await track.load(.formatDescriptions)
        let format = try XCTUnwrap(formats.first), extensions = try XCTUnwrap(CMFormatDescriptionGetExtensions(format)) as NSDictionary
        XCTAssertEqual(extensions[kCMFormatDescriptionExtension_ColorPrimaries] as? String, kCMFormatDescriptionColorPrimaries_ITU_R_709_2 as String)
        XCTAssertEqual(extensions[kCMFormatDescriptionExtension_TransferFunction] as? String, kCMFormatDescriptionTransferFunction_ITU_R_709_2 as String)
        let src = folder.relative(movie), ops: [[String: Any]] = [
            ["op": "import", "assets": [src: ["assetKind": "video", "duration": 1, "width": 160, "height": 90, "fps": 10, "hasVideo": true]]],
            ["op": "append", "src": src, "track": "V1", "dur": 1, "audio": false]
        ]
        let imported = try core.applyOps(project: base, ops: JSON(any: ops).text).project
        let decoded = try await renderer.render(project: imported, at: 0.5), gray = pixel(decoded.pixelBuffer, 80, 45)
        for channel in 0..<3 { XCTAssertEqual(gray[channel], 64, accuracy: 3, "Rec709 middle gray must survive export and native decode") }
        print("Rec709 middle-gray export/reimport:", gray)
    }

    func testExportCacheResetKeepsNewSnapshotValidWithAndWithoutLUT() async throws {
        let root = try Support.tempFolder("export-lut-cache-reset"), folder = ProjectFolder(root: root)
        defer { try? FileManager.default.removeItem(at: root) }
        let core = try ReelCore(scriptURL: Support.core())
        let base = try core.newProject(name: "Export LUT ownership", options: #"{"width":32,"height":32,"fps":1}"#)
        let ungraded = try core.applyOps(project: base, ops: ##"[{"op":"add_color","color":"#404040","dur":1}]"##).project
        let cube = "LUT_3D_SIZE 2\n" + Array(repeating: "1 1 1", count: 8).joined(separator: "\n") + "\n"
        try Data(cube.utf8).write(to: folder.output("white.cube"))
        let graded = try core.applyOps(project: ungraded, ops: #"[{"op":"update","id":"c1","set":{"grade":{"lut":"white.cube"}}}]"#).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        for (name, project, expected) in [("ungraded", ungraded, 64), ("graded", graded, 255)] {
            _ = try await renderer.render(project: project, at: 0)
            let previous = try await renderer.captureLUTSnapshot(paths: name == "graded" ? ["white.cube"] : [])
            let output = try await renderer.export(project: project, spec: ReelNativeExportSpec(body: JSON(any: ["preset": "png-seq", "name": name, "from": 0, "to": 1, "fps": 1]).text))
            let files = try FileManager.default.contentsOfDirectory(at: output, includingPropertiesForKeys: nil)
            XCTAssertEqual(files.map(\.lastPathComponent), ["frame_00001.png"])
            let source = try XCTUnwrap(CGImageSourceCreateWithURL(output.appendingPathComponent("frame_00001.png") as CFURL, nil))
            let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
            XCTAssertEqual(image.width, 32); XCTAssertEqual(image.height, 32)
            var rgba = [UInt8](repeating: 0, count: 4)
            try rgba.withUnsafeMutableBytes { bytes in
                let context = try XCTUnwrap(CGContext(data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
                context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            }
            for channel in 0..<3 { XCTAssertEqual(Double(rgba[channel]), Double(expected), accuracy: 1, "The published frame must preserve its captured grade") }
            XCTAssertEqual(rgba[3], 255)
            do {
                try await renderer.validateLUTSnapshot(previous)
                XCTFail("Export must still invalidate snapshots owned before its cache reset")
            } catch { XCTAssertEqual(error.localizedDescription, "LUT render was invalidated") }
        }
    }

    func testCodecsAudioAlphaGIFAndPNGFrames() async throws {
        let root = try Support.tempFolder("exports"), folder = ProjectFolder(root: root), core = try ReelCore(scriptURL: Support.core())
        var p = parse(try core.newProject(name: "Native export", options: #"{"width":160,"height":90,"fps":10}"#)); p["background"] = "transparent"
        let project = try core.applyOps(project: JSON(any: p).text, ops: ##"[{"op":"add_shape","start":0,"dur":1,"shape":{"type":"rect","width":80,"height":60,"fill":{"color":"#3366ff"}}}]"##).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let samples = (0..<48000).map { Float(sin(Double($0) * 2 * Double.pi * 440 / 48000) * 0.2) }
        let audio = root.appendingPathComponent("mix.wav"); try NativeAudioProcessing.write(.init(channels: [samples, samples]), to: audio)
        for preset in ["h264-high", "hevc", "prores-422", "prores-422hq", "prores-4444", "gif", "png-seq", "audio-wav", "audio-m4a"] {
            let output = try await renderer.export(project: project, spec: ReelNativeExportSpec(body: JSON(any: ["preset": preset, "name": preset, "from": 0, "to": 1, "fps": 10]).text), audioURL: audio)
            print("Native export fixture \(preset): \(output.path)")
            if preset == "png-seq" {
                let files = try FileManager.default.contentsOfDirectory(at: output, includingPropertiesForKeys: nil)
                XCTAssertEqual(files.count, 10)
                let source = try XCTUnwrap(CGImageSourceCreateWithURL(files[0] as CFURL, nil)), image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
                XCTAssertEqual(image.width, 160); XCTAssertEqual(image.height, 90); XCTAssertTrue(image.alphaInfo != .none)
            } else if preset == "gif" {
                let source = try XCTUnwrap(CGImageSourceCreateWithURL(output as CFURL, nil)); XCTAssertEqual(CGImageSourceGetCount(source), 10)
                let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any]), gif = object(props[kCGImagePropertyGIFDictionary as String])
                XCTAssertEqual(try XCTUnwrap(gif[kCGImagePropertyGIFUnclampedDelayTime as String] as? Double), 0.1, accuracy: 0.001)
            } else {
                let asset = AVURLAsset(url: output), length = try await asset.load(.duration).seconds
                XCTAssertEqual(length, 1, accuracy: 0.035)
                let tracks = try await asset.loadTracks(withMediaType: .video)
                if !preset.hasPrefix("audio-") {
                    let track = try XCTUnwrap(tracks.first), size = try await track.load(.naturalSize), format = try await track.load(.formatDescriptions).first
                    XCTAssertEqual(size.width, 160); XCTAssertEqual(size.height, 90)
                    let expected = preset == "hevc" ? "hvc1" : preset == "prores-422" ? "apcn" : preset == "prores-422hq" ? "apch" : preset == "prores-4444" ? "ap4h" : "avc1"
                    XCTAssertEqual(fourCC(CMFormatDescriptionGetMediaSubType(try XCTUnwrap(format))), expected)
                    if preset == "prores-4444" {
                        let reader = try AVAssetReader(asset: asset), output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]); reader.add(output); XCTAssertTrue(reader.startReading())
                        let sample = try XCTUnwrap(output.copyNextSampleBuffer()), buffer = try XCTUnwrap(CMSampleBufferGetImageBuffer(sample))
                        XCTAssertEqual(pixel(buffer, 5, 5)[3], 0); XCTAssertGreaterThan(pixel(buffer, 80, 45)[3], 250); reader.cancelReading()
                        let src=folder.relative(asset.url), assets=[src:["duration":1,"width":160,"height":90,"fps":10,"hasVideo":true,"codec":"prores","assetKind":"video"] as [String:Any]]
                        let imported=try core.applyOps(project:JSON(any:p).text,ops:JSON(any:[["op":"import","assets":assets],["op":"append","src":src,"track":"V1","audio":false,"dur":1]]).text).project
                        let played=try await renderer.render(project:imported,at:0.5)
                        XCTAssertEqual(pixel(played.pixelBuffer,5,5)[3],0,"imported ProRes4444 retains video alpha during native playback")
                        XCTAssertGreaterThan(pixel(played.pixelBuffer,80,45)[3],250)

                    }
                } else { XCTAssertTrue(tracks.isEmpty) }
                let decoded = try await NativeAudioProcessing.decode(output)
                XCTAssertEqual(decoded.duration, 1, accuracy: 0.035)
                let rms = sqrt(decoded.channels[0].reduce(0.0) { $0 + Double($1 * $1) } / Double(decoded.count))
                XCTAssertEqual(rms, 0.2 / sqrt(2), accuracy: 0.015)
            }
        }
    }

    func testAncestorSwapPreservesOutsideSentinelDuringCleanup() async throws {
        let root = try Support.tempFolder("swap"), outside = try Support.tempFolder("sentinel"), folder = ProjectFolder(root: root), core = try ReelCore(scriptURL: Support.core())
        let project = try core.applyOps(project: core.newProject(name: "Swap", options: #"{"width":160,"height":90,"fps":10}"#), ops: #"[{"op":"add_color","dur":1}]"#).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core()), probe = ExportAncestorSwap(root:root,outside:outside)
        do { _ = try await renderer.export(project: project, spec: ReelNativeExportSpec(body:#"{"preset":"png-seq","name":"swap","to":1}"#), progress: { _ in probe.swapOnce() }); XCTFail("swapped ancestor was accepted") } catch {}
        XCTAssertNil(probe.error)
        let sentinel = try XCTUnwrap(probe.sentinel)
        XCTAssertEqual(try Data(contentsOf:sentinel),Data("outside stays untouched".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath:outside.appendingPathComponent("swap.frames").path))
    }

    func testLinkedOutputParentAndCancellationDoNotPublish() async throws {
        let root = try Support.tempFolder("confined"), outside = try Support.tempFolder("outside"), folder = ProjectFolder(root: root), core = try ReelCore(scriptURL: Support.core())
        let project = try core.applyOps(project: core.newProject(name: "Paths", options: #"{"width":160,"height":90}"#), ops: #"[{"op":"add_color","dur":1}]"#).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("renders"), withDestinationURL: outside)
        do { _ = try await renderer.export(project: project, spec: ReelNativeExportSpec(body: #"{"out":"renders/not-created/nested.mp4","to":1}"#)); XCTFail("linked export parent was accepted") } catch {}
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty)
        try FileManager.default.removeItem(at: root.appendingPathComponent("renders"))
        let task = Task { try await renderer.export(project: project, spec: ReelNativeExportSpec(body: #"{"name":"cancelled","to":30}"#)) }; task.cancel()
        do { _ = try await task.value; XCTFail("cancelled export succeeded") } catch is CancellationError {} catch { XCTFail("wrong cancellation error \(error)") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("renders/cancelled.mp4").path))
    }
}

private func fourCC(_ value: FourCharCode) -> String { String(bytes: [UInt8((value >> 24) & 255), UInt8((value >> 16) & 255), UInt8((value >> 8) & 255), UInt8(value & 255)], encoding: .ascii) ?? "" }

private final class ExportAncestorSwap: @unchecked Sendable {
    let root:URL,outside:URL
    var sentinel:URL?,error:Error?
    init(root:URL,outside:URL) {self.root=root;self.outside=outside}
    func swapOnce() {
        guard sentinel == nil && error == nil else {return}
        do {
            let renders=root.appendingPathComponent("renders"), part=try XCTUnwrap(FileManager.default.contentsOfDirectory(at: renders,includingPropertiesForKeys:nil).first)
            try FileManager.default.moveItem(at:renders,to:root.appendingPathComponent("held-renders"))
            let matching=outside.appendingPathComponent(part.lastPathComponent)
            try FileManager.default.createDirectory(at:matching,withIntermediateDirectories:true)
            let file=matching.appendingPathComponent("sentinel.txt");try Data("outside stays untouched".utf8).write(to:file);sentinel=file
            try FileManager.default.createSymbolicLink(at:renders,withDestinationURL:outside)
        } catch {self.error=error}
    }
}
