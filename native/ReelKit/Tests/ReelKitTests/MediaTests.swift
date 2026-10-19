import AVFoundation
import Foundation
import ImageIO
@testable import ReelKit
import XCTest

final class MediaProbeTests: XCTestCase {
    func probe(_ name: String) async throws -> [String: Any] {
        parse(try await MediaProbe.probe(Support.fixture(name)).text)
    }

    func testVideoWithAudio() async throws {
        let a = try await probe("clip.mp4")
        XCTAssertEqual(a["duration"] as? Double ?? 0, 2, accuracy: 0.05)
        XCTAssertEqual(a["width"] as? Int, 320)
        XCTAssertEqual(a["height"] as? Int, 180)
        XCTAssertEqual(a["fps"] as? Double, 30)
        XCTAssertEqual(a["codec"] as? String, "h264")
        XCTAssertEqual(a["hasVideo"] as? Bool, true)
        XCTAssertEqual(a["hasAudio"] as? Bool, true)
        XCTAssertEqual(a["channels"] as? Int, 1)
        XCTAssertNil(a["still"])
        XCTAssertNil(a["rotation"])
        XCTAssertNil(a["proxy"])
        XCTAssertGreaterThan(a["size"] as? Int ?? 0, 1000)
    }

    func testRotationSwapsTheDisplaySize() async throws {
        let a = try await probe("rotated.mov")
        XCTAssertEqual(a["width"] as? Int, 180)
        XCTAssertEqual(a["height"] as? Int, 320)
        XCTAssertTrue([90, 270].contains(a["rotation"] as? Int ?? 0))
        XCTAssertEqual(a["fps"] as? Double, 25)
        XCTAssertEqual(a["hasAudio"] as? Bool, false)
    }

    func testAudioOnly() async throws {
        let a = try await probe("tone.m4a")
        XCTAssertEqual(a["codec"] as? String, "aac")
        XCTAssertEqual(a["hasVideo"] as? Bool, false)
        XCTAssertEqual(a["channels"] as? Int, 2)
        XCTAssertEqual(a["duration"] as? Double ?? 0, 1.5, accuracy: 0.05)
        XCTAssertNil(a["width"])
    }

    func testStill() async throws {
        let a = try await probe("still.png")
        XCTAssertEqual(a["still"] as? Bool, true)
        XCTAssertEqual(a["width"] as? Int, 64)
        XCTAssertEqual(a["height"] as? Int, 48)
        XCTAssertEqual(a["codec"] as? String, "png")
        XCTAssertNil(a["duration"])
    }

    func testUnreadableFileThrows() async throws {
        let bad = try Support.tempFolder().appendingPathComponent("bad.mp4")
        try Data("not a movie".utf8).write(to: bad)
        do {
            _ = try await MediaProbe.probe(bad)
            XCTFail("expected an error")
        } catch {}
    }
}

final class MediaDerivativeTests: XCTestCase {
    func testDerivativeCacheCannotReadOrWriteThroughLinkedChildren() async throws {
        let file = Support.fixture("clip.mp4")
        let asset = parse(try await MediaProbe.probe(file).text)
        for kind in ["strip", "peaks", "audio"] {
            let folder = ProjectFolder(root: try Support.tempFolder("linked-cache"))
            try FileManager.default.createDirectory(at: folder.cacheDir, withIntermediateDirectories: true)
            let outside = try Support.tempFolder("outside-cache")
            let sentinel = outside.appendingPathComponent("sentinel")
            let original = Data("Keep this original".utf8)
            try original.write(to: sentinel)
            let name = kind == "strip" ? try ProjectFolder.cacheKey(file, "strip4-high") : kind == "peaks" ? try ProjectFolder.cacheKey(file, "peaks2") : "audio"
            try FileManager.default.createSymbolicLink(at: folder.cacheDir.appendingPathComponent(name), withDestinationURL: outside)
            do {
                if kind == "strip" { _ = try await MediaDerivatives.filmstrip(file: file, asset: asset, cacheDir: folder.cacheDir, highQuality: true, projectFolder: folder) }
                else if kind == "peaks" { _ = try await MediaDerivatives.peaks(file: file, cacheDir: folder.cacheDir, projectFolder: folder) }
                else { _ = try await MediaDerivatives.audioRange(file: file, from: 0, dur: 1, cacheDir: folder.cacheDir, projectFolder: folder) }
                XCTFail("accepted linked \(kind) cache")
            } catch is ProjectFolder.LinkedOutput {} catch { XCTFail("unexpected \(kind) error: \(error)") }
            XCTAssertEqual(try Data(contentsOf: sentinel), original)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), ["sentinel"])
        }
    }

    func testMediaBinStripPreservesSourceResolutionAndUsesSeparateCache() async throws {
        let cache = try Support.tempFolder("cache")
        let file = Support.fixture("clip.mp4")
        let original = try Data(contentsOf: file)
        let asset = parse(try await MediaProbe.probe(file).text)
        let low = parse(try await MediaDerivatives.filmstrip(file: file, asset: asset, cacheDir: cache).text)
        let high = parse(try await MediaDerivatives.filmstrip(file: file, asset: asset, cacheDir: cache, highQuality: true).text)
        XCTAssertEqual(high["w"] as? Int, 320)
        XCTAssertEqual(high["h"] as? Int, 180)
        XCTAssertNotEqual(high["url"] as? String, low["url"] as? String)
        let jpeg = cache.appendingPathComponent(String(try XCTUnwrap(high["url"] as? String).dropFirst("/cache/".count)))
        let image = try XCTUnwrap(CGImageSourceCreateWithURL(jpeg as CFURL, nil))
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any])
        XCTAssertEqual(properties[kCGImagePropertyPixelWidth] as? Int, 640)
        XCTAssertEqual(properties[kCGImagePropertyPixelHeight] as? Int, 180)
        XCTAssertEqual(try Data(contentsOf: file), original)
    }

    func testHighQualityRotatedVideoKeepsPortraitAspect() async throws {
        let file = Support.fixture("rotated.mov")
        let asset = parse(try await MediaProbe.probe(file).text)
        let strip = parse(try await MediaDerivatives.filmstrip(file: file, asset: asset, cacheDir: try Support.tempFolder("cache"), highQuality: true).text)
        XCTAssertEqual(strip["w"] as? Int, 180)
        XCTAssertEqual(strip["h"] as? Int, 320)
    }

    func testFilmstrip() async throws {
        let cache = try Support.tempFolder("cache")
        let asset = parse(try await MediaProbe.probe(Support.fixture("clip.mp4")).text)
        let strip = parse(try await MediaDerivatives.filmstrip(file: Support.fixture("clip.mp4"), asset: asset, cacheDir: cache).text)
        XCTAssertEqual(strip["count"] as? Int, 2)
        XCTAssertEqual(strip["h"] as? Int, 72)
        XCTAssertEqual(strip["w"] as? Int, 128) // round(72 * 320 / 180 / 2) * 2
        XCTAssertEqual(strip["interval"] as? Double ?? 0, 1, accuracy: 0.05)
        let url = try XCTUnwrap(strip["url"] as? String)
        XCTAssertTrue(url.hasPrefix("/cache/") && url.hasSuffix("/strip.jpg"))
        let jpeg = cache.appendingPathComponent(String(url.dropFirst("/cache/".count)))
        let src = try XCTUnwrap(CGImageSourceCreateWithURL(jpeg as CFURL, nil))
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as! [CFString: Any]
        XCTAssertEqual(props[kCGImagePropertyPixelWidth] as? Int, 256)
        XCTAssertEqual(props[kCGImagePropertyPixelHeight] as? Int, 72)
        // Second call answers from the cache with the same JSON.
        let again = try await MediaDerivatives.filmstrip(file: Support.fixture("clip.mp4"), asset: asset, cacheDir: cache)
        XCTAssertEqual(parse(again.text)["url"] as? String, url)
    }

    func testStillFilmstrip() async throws {
        let cache = try Support.tempFolder("cache")
        let asset = parse(try await MediaProbe.probe(Support.fixture("still.png")).text)
        let strip = parse(try await MediaDerivatives.filmstrip(file: Support.fixture("still.png"), asset: asset, cacheDir: cache).text)
        XCTAssertEqual(strip["count"] as? Int, 1)
        XCTAssertEqual(strip["interval"] as? Double, 0)
        XCTAssertEqual(strip["w"] as? Int, 96) // round(72 * 64 / 48 / 2) * 2
    }

    func testPeaks() async throws {
        let cache = try Support.tempFolder("cache")
        let result = parse(try await MediaDerivatives.peaks(file: Support.fixture("clip.mp4"), cacheDir: cache).text)
        XCTAssertEqual(result["perSec"] as? Int, 100)
        let peaks = try XCTUnwrap(result["peaks"] as? [Int])
        XCTAssertEqual(Double(peaks.count), 200, accuracy: 6)
        XCTAssertTrue(peaks.allSatisfy { (0 ... 255).contains($0) })
        // ffmpeg's sine source is at 1/8 full scale: about 32 of 255.
        let middle = peaks[50 ..< 150].sorted()[50]
        XCTAssertEqual(Double(middle), 32, accuracy: 6)
    }

    func testNoAudioThrows() async throws {
        do {
            _ = try await MediaDerivatives.peaks(file: Support.fixture("rotated.mov"), cacheDir: try Support.tempFolder("cache"))
            XCTFail("expected an error")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("no audio"))
        }
    }

    func testAudioRangeWav() async throws {
        let cache = try Support.tempFolder("cache")
        let wav = try await MediaDerivatives.audioRange(file: Support.fixture("tone.m4a"), from: 0.5, dur: 0.5, cacheDir: cache)
        let data = try Data(contentsOf: wav)
        XCTAssertEqual(String(data: data[0 ..< 4], encoding: .ascii), "RIFF")
        XCTAssertEqual(String(data: data[8 ..< 12], encoding: .ascii), "WAVE")
        let rate = data[24 ..< 28].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        let channels = data[22 ..< 24].withUnsafeBytes { $0.loadUnaligned(as: UInt16.self) }
        let dataBytes = data[40 ..< 44].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        XCTAssertEqual(rate, 48000)
        XCTAssertEqual(channels, 2)
        XCTAssertEqual(Double(dataBytes), 0.5 * 48000 * 4, accuracy: 48000 * 4 * 0.05)
        XCTAssertEqual(Int(dataBytes) + 44, data.count)
        // AVFoundation can read what was written.
        let file = try AVAudioFile(forReading: wav)
        XCTAssertEqual(file.fileFormat.sampleRate, 48000)
    }
}
