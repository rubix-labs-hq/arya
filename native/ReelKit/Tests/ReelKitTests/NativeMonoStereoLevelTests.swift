import Foundation
import XCTest
@testable import ReelKit

final class NativeMonoStereoLevelTests: XCTestCase {
    private func fixture() throws -> (URL, URL, [Float]) {
        let root = try Support.tempFolder("mono-stereo-level")
        let source = root.appendingPathComponent("mono.wav")
        let tone = (0..<48000).map { Float(0.25 * sin(2 * Double.pi * 1000 * Double($0) / 48000)) }
        try NativeAudioProcessing.write(.init(channels: [tone]), to: source)
        return (root, source, tone)
    }

    func testFloatDecodeMatchesBrowserMonoToStereoLevel() async throws {
        let (root, source, tone) = try fixture()
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let decoded = try await NativeAudioProcessing.decode(source)
        XCTAssertEqual(decoded.channels.count, 2)
        XCTAssertEqual(decoded.count, tone.count)
        let expected = Double(tone[12012]) / sqrt(2)
        XCTAssertEqual(Double(decoded.channels[0][12012]), expected, accuracy: 0.00001)
        XCTAssertEqual(Double(decoded.channels[1][12012]), expected, accuracy: 0.00001)
        let mono = try await NativeAudioProcessing.decode(source, channels: 1)
        XCTAssertEqual(mono.channels[0][12012], tone[12012], accuracy: 0.00001)
    }

    func testPreviewDerivativeMatchesBrowserMonoToStereoLevel() async throws {
        let (root, source, tone) = try fixture()
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let folder = ProjectFolder(root: root)
        let legacyKey = try ProjectFolder.cacheKey(source, "wav", "0.000", "1.000")
        let legacy = folder.cacheDir.appendingPathComponent("audio/\(legacyKey).wav")
        try FileManager.default.createDirectory(at: legacy.deletingLastPathComponent(), withIntermediateDirectories: true)
        try NativeAudioProcessing.write(.init(channels: [tone, tone]), to: legacy)
        let derivative = try await MediaDerivatives.audioRange(file: source, from: 0, dur: 1, cacheDir: folder.cacheDir, projectFolder: folder)
        XCTAssertNotEqual(derivative, legacy)
        let decoded = try await NativeAudioProcessing.decode(derivative)
        let expected = Double(tone[12012]) / sqrt(2)
        XCTAssertEqual(Double(decoded.channels[0][12012]), expected, accuracy: 0.0001)
        XCTAssertEqual(Double(decoded.channels[1][12012]), expected, accuracy: 0.0001)
    }

    func testCompressedMonoDecodeMatchesBrowserFFmpegReference() async throws {
        let (root, source, _) = try fixture()
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let compressed = root.appendingPathComponent("mono.m4a")
        let reference = root.appendingPathComponent("browser.wav")
        try ffmpeg(["-i", source.path, "-c:a", "aac", "-b:a", "192k", compressed.path])
        try ffmpeg(["-ss", "0.1", "-t", "0.5", "-i", compressed.path, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_f32le", reference.path])
        let actual = try await NativeAudioProcessing.decode(compressed, from: 0.1, duration: 0.5)
        let expected = try await NativeAudioProcessing.decode(reference)
        XCTAssertEqual(actual.count, 24000)
        XCTAssertGreaterThan(expected.count, 18000)
        // Compare steady audio inside both ranges, excluding AAC seek-edge padding.
        let interior = 4800..<18000
        for channel in 0..<2 {
            let actualRMS = sqrt(actual.channels[channel][interior].reduce(0.0) { $0 + Double($1) * Double($1) } / Double(interior.count))
            let referenceRMS = sqrt(expected.channels[channel][interior].reduce(0.0) { $0 + Double($1) * Double($1) } / Double(interior.count))
            XCTAssertEqual(actualRMS, referenceRMS, accuracy: 0.0001)
        }
    }

    private func ffmpeg(_ arguments: [String]) throws {
        let process = Process(), errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["ffmpeg", "-nostdin", "-y", "-loglevel", "error"] + arguments
        process.standardError = errors
        try process.run()
        let output = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw NSError(domain: "FFmpegFixture", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: String(decoding: output, as: UTF8.self)])
        }
    }

    func testStereoDecodePreservesExistingChannelLevels() async throws {
        let root = try Support.tempFolder("stereo-level")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let source = root.appendingPathComponent("stereo.wav")
        let left = [Float](repeating: 0.25, count: 48000)
        let right = [Float](repeating: -0.125, count: 48000)
        try NativeAudioProcessing.write(.init(channels: [left, right]), to: source)
        let decoded = try await NativeAudioProcessing.decode(source)
        XCTAssertEqual(decoded.channels[0][12012], 0.25, accuracy: 0.00001)
        XCTAssertEqual(decoded.channels[1][12012], -0.125, accuracy: 0.00001)
    }
}
