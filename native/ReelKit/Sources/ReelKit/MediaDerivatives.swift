import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Thumbnails, waveforms and audio ranges, made with AVFoundation and cached under
/// `.reel/cache` with the same layout and JSON as the Node server's ffmpeg versions.
public enum MediaDerivatives {
    public struct Failed: Error, LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
    }

    private static func cacheGuard(_ cacheDir: URL, projectFolder: ProjectFolder?) throws -> (ProjectFolder, URL) {
        let guardFolder = projectFolder ?? ProjectFolder(root: cacheDir.deletingLastPathComponent())
        let requested = projectFolder == nil ? guardFolder.root.appendingPathComponent(cacheDir.lastPathComponent) : cacheDir
        return (guardFolder, try guardFolder.output(requested.path))
    }

    // MARK: filmstrip

    /// Timeline sprites are 72 px high. Media-bin sprites use up to 640 by 360 px and 24 frames.
    /// `{ url: "/cache/<key>/strip.jpg", interval, count, w, h }`.
    public static func filmstrip(file: URL, asset: [String: Any], cacheDir: URL, highQuality: Bool = false, projectFolder: ProjectFolder? = nil) async throws -> JSON {
        let (guardFolder, cache) = try cacheGuard(cacheDir, projectFolder: projectFolder)
        let key = try ProjectFolder.cacheKey(file, highQuality ? "strip4-high" : "strip4")
        let dir = try guardFolder.output(cache.appendingPathComponent(key, isDirectory: true).path)
        let meta = try guardFolder.output(dir.appendingPathComponent("strip.json").path)
        let jpeg = try guardFolder.output(dir.appendingPathComponent("strip.jpg").path)
        if let data = try? Data(contentsOf: meta), let text = String(data: data, encoding: .utf8) { return .raw(text) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let inputWidth = (asset["width"] as? NSNumber)?.doubleValue ?? 16
        let inputHeight = (asset["height"] as? NSNumber)?.doubleValue ?? 9
        let aw = inputWidth.isFinite && inputWidth > 0 ? inputWidth : 16
        let ah = inputHeight.isFinite && inputHeight > 0 ? inputHeight : 9
        let scale = min((highQuality ? 360.0 : 72.0) / ah, (highQuality ? 640.0 : 288.0) / aw, highQuality ? 1 : .infinity)
        let h = max(2, Int((ah * scale / 2).rounded()) * 2)
        let w = max(2, Int((aw * scale / 2).rounded()) * 2)
        let inputDuration = (asset["duration"] as? NSNumber)?.doubleValue ?? 0
        let duration = inputDuration.isFinite && inputDuration > 0 ? inputDuration : 0
        let still = (asset["still"] as? Bool) ?? false

        let count: Int
        let interval: Double
        var frames: [CGImage?]
        if still || duration <= 0 {
            count = 1
            interval = 0
            frames = [try stillImage(file, maxPixelSize: highQuality ? 720 : 512)]
        } else {
            count = max(1, Int(min(highQuality ? 24 : 120, duration.rounded(.up))))
            interval = duration / Double(count)
            frames = try await videoFrames(file: file, times: (0..<count).map { Double($0) * interval }, tolerance: highQuality ? 0 : interval / 2, maxHeight: highQuality ? h : h * 2, maxWidth: highQuality ? w : w * 2)
        }
        guard frames.contains(where: { $0 != nil }) else { throw Failed(message: "no frames could be read from \(file.lastPathComponent)") }
        // Fill gaps (a frame the decoder skipped) with the nearest earlier frame.
        var last: CGImage? = frames.first { $0 != nil } ?? nil
        for i in frames.indices {
            if let f = frames[i] { last = f } else { frames[i] = last }
        }
        try writeSprite(frames.compactMap { $0 }, tileWidth: w, tileHeight: h, to: guardFolder.output(jpeg.path), quality: highQuality ? 0.9 : 0.72)
        let result = JSON.compact([
            ("url", .string("/cache/\(key)/strip.jpg")),
            ("interval", .number(interval)),
            ("count", .int(count)),
            ("w", .int(w)),
            ("h", .int(h)),
        ])
        try Data(result.text.utf8).write(to: guardFolder.output(meta.path), options: .atomic)
        return result
    }

    static func stillImage(_ url: URL, maxPixelSize: Int = 512) throws -> CGImage {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
              ] as CFDictionary) else { throw Failed(message: "cannot decode \(url.lastPathComponent)") }
        return image
    }

    static func videoFrames(file: URL, times: [Double], tolerance: Double, maxHeight: Int, maxWidth: Int? = nil) async throws -> [CGImage?] {
        let asset = AVURLAsset(url: file)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maxWidth ?? maxHeight * 4, height: maxHeight)
        let tol = CMTime(seconds: max(tolerance, 0), preferredTimescale: 600)
        generator.requestedTimeToleranceBefore = tol
        generator.requestedTimeToleranceAfter = tol
        try Task.checkCancellation()
        let requested = times.map { CMTime(seconds: $0, preferredTimescale: 600) }
        // The owned task drains the complete image sequence even if its caller is
        // canceled. cancelAll requests cancellation but does not release admission.
        let worker = Task.detached(priority: .utility) {
            var out = [CGImage?](repeating: nil, count: times.count)
            var index = 0
            for await result in generator.images(for: requested) {
                if index < out.count, let image = try? result.image { out[index] = image }
                index += 1
            }
            return out
        }
        let out = await withTaskCancellationHandler { await worker.value } onCancel: { generator.cancelAllCGImageGeneration() }
        try Task.checkCancellation()
        return out
    }

    static func writeSprite(_ frames: [CGImage], tileWidth w: Int, tileHeight h: Int, to url: URL, quality: Double = 0.72) throws {
        guard let ctx = CGContext(data: nil, width: w * frames.count, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
            throw Failed(message: "cannot allocate the filmstrip")
        }
        ctx.interpolationQuality = .high
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w * frames.count, height: h))
        for (i, frame) in frames.enumerated() {
            ctx.draw(frame, in: CGRect(x: i * w, y: 0, width: w, height: h)) // scaled to the tile, as ffmpeg's scale=w:h does
        }
        let data = NSMutableData()
        guard let image = ctx.makeImage(),
              let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw Failed(message: "cannot encode the filmstrip")
        }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw Failed(message: "cannot write \(url.lastPathComponent)") }
        try (data as Data).write(to: url, options: .atomic)
    }

    // MARK: waveform peaks

    /// Peak levels, 100 per second, 0-255, of the first audio track downmixed to mono at
    /// 16 kHz: `{ perSec: 100, peaks: [...] }`.
    public static func peaks(file: URL, cacheDir: URL, projectFolder: ProjectFolder? = nil) async throws -> JSON {
        let (guardFolder, cache) = try cacheGuard(cacheDir, projectFolder: projectFolder)
        let key = try ProjectFolder.cacheKey(file, "peaks2")
        let out = try guardFolder.output(cache.appendingPathComponent(key, isDirectory: true).appendingPathComponent("peaks.json").path)
        if let data = try? Data(contentsOf: out), let text = String(data: data, encoding: .utf8) { return .raw(text) }
        let rate = 16000
        let perSec = 100
        let bucket = rate / perSec
        var peaks: [Int] = []
        var max: Int32 = 0
        var inBucket = 0
        try await readPCM(file: file, sampleRate: Double(rate), channels: 1, range: nil) { samples in
            for s in samples {
                let v = abs(Int32(s))
                if v > max { max = v }
                inBucket += 1
                if inBucket == bucket {
                    guard peaks.count < 360_000 else { throw Failed(message: "Waveform generation supports sources of at most one hour.") }
                    peaks.append(Int((Double(max) / 32768 * 255).rounded()))
                    max = 0
                    inBucket = 0
                }
            }
        }
        if inBucket > 0 { peaks.append(Int((Double(max) / 32768 * 255).rounded())) }
        let result = JSON.compact([("perSec", .int(perSec)), ("peaks", .raw("[" + peaks.map(String.init).joined(separator: ",") + "]"))])
        try FileManager.default.createDirectory(at: guardFolder.output(out.deletingLastPathComponent().path), withIntermediateDirectories: true)
        try Data(result.text.utf8).write(to: guardFolder.output(out.path), options: .atomic)
        return result
    }

    // MARK: audio ranges

    /// A 48 kHz stereo 16-bit WAV of [from, from + dur) of the source's audio, cached.
    public static func audioRange(file: URL, from: Double, dur: Double, cacheDir: URL, projectFolder: ProjectFolder? = nil, cacheRevision: String? = nil) async throws -> URL {
        let (guardFolder, cache) = try cacheGuard(cacheDir, projectFolder: projectFolder)
        let key: String
        if let cacheRevision {
            guard !cacheRevision.isEmpty, cacheRevision.utf8.count <= 128,
                  cacheRevision.range(of: "^[a-zA-Z0-9_.-]+$", options: .regularExpression) != nil else { throw Failed(message: "Invalid export audio cache revision") }
            key = try ProjectFolder.cacheKey(file, "wav-stereo-energy-v2", String(format: "%.3f", from), String(format: "%.3f", dur), "export-cohort:" + cacheRevision)
        } else {
            key = try ProjectFolder.cacheKey(file, "wav-stereo-energy-v2", String(format: "%.3f", from), String(format: "%.3f", dur))
        }
        let dir = try guardFolder.output(cache.appendingPathComponent("audio", isDirectory: true).path)
        let out = try guardFolder.output(dir.appendingPathComponent("\(key).wav").path)
        if FileManager.default.fileExists(atPath: out.path) { return out }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var pcm = Data()
        let start = CMTime(seconds: Swift.max(0, from), preferredTimescale: 48000)
        let range = CMTimeRange(start: start, duration: CMTime(seconds: Swift.max(0, dur), preferredTimescale: 48000))
        try await readPCM(file: file, sampleRate: 48000, channels: 2, range: range) { samples in
            samples.withUnsafeBufferPointer { pcm.append(Data(buffer: $0)) }
        }
        let part = try guardFolder.output(dir.appendingPathComponent("\(key)-\(UUID().uuidString).part.wav").path)
        try (wavHeader(dataBytes: pcm.count, sampleRate: 48000, channels: 2) + pcm).write(to: part, options: .withoutOverwriting)
        defer { if let owned = try? guardFolder.output(part.path) { try? FileManager.default.removeItem(at: owned) } }
        let target = try guardFolder.output(out.path)
        if !FileManager.default.fileExists(atPath: target.path) { try FileManager.default.moveItem(at: guardFolder.output(part.path), to: target) }
        return out
    }

    static func wavHeader(dataBytes: Int, sampleRate: Int, channels: Int) -> Data {
        var d = Data()
        func u32(_ v: Int) { var x = UInt32(v).littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: Int) { var x = UInt16(v).littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + dataBytes)
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(channels); u32(sampleRate)
        u32(sampleRate * channels * 2); u16(channels * 2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(dataBytes)
        return d
    }

    /// Decodes the first audio track to interleaved signed 16-bit PCM and hands it over in chunks.
    static func readPCM(file: URL, sampleRate: Double, channels: Int, range: CMTimeRange?, chunk: ([Int16]) throws -> Void) async throws {
        let asset = AVURLAsset(url: file)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
            throw Failed(message: "\(file.lastPathComponent) has no audio")
        }
        let channelGain = try await NativeAudioProcessing.stereoDecodeGain(track: track, channels: channels)
        let reader = try AVAssetReader(asset: asset)
        if let range { reader.timeRange = range }
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: channels,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else { throw Failed(message: "cannot read \(file.lastPathComponent): \(reader.error?.localizedDescription ?? "unknown")") }
        defer { if reader.status == .reading { reader.cancelReading() } }
        while let buffer = output.copyNextSampleBuffer() {
            try Task.checkCancellation()
            guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
            let length = CMBlockBufferGetDataLength(block)
            var samples = [Int16](repeating: 0, count: length / 2)
            samples.withUnsafeMutableBytes { raw in
                _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
            }
            if channelGain != 1 {
                for i in samples.indices {
                    if i % 8192 == 0 { try Task.checkCancellation() }
                    samples[i] = Int16((Float(samples[i]) * channelGain).rounded())
                }
            }
            try chunk(samples)
        }
        if reader.status == .failed { throw Failed(message: "decoding \(file.lastPathComponent) failed: \(reader.error?.localizedDescription ?? "unknown")") }
    }
}
