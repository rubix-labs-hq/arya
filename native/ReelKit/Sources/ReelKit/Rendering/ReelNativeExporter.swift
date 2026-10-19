import AVFoundation
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

public struct ReelNativeExportSpec: Sendable {
    public let body: String
    public init(body: String = "{}") throws { _ = try JSON.parse(body); self.body = body }
}

extension ReelMetalRenderer {
    public func still(project: String, at: Double, comp: String? = nil, width: Int? = nil, name: String = "frame.png", out: String? = nil, beforePublish: @escaping @Sendable () async throws -> Void = {}) async throws -> URL {
        try await still(project: project, at: at, comp: comp, width: width, name: name, out: out, outputPublication: nil, beforePublish: beforePublish, publishOutput: { try $0.publish() })
    }

    func still(project: String, at: Double, comp: String? = nil, width: Int? = nil, name: String = "frame.png", out: String? = nil, outputPublication: NativeExportOutput?, beforePublish: @escaping @Sendable () async throws -> Void, publishOutput: @escaping @Sendable (NativeExportOutput) async throws -> URL) async throws -> URL {
        let output = try safeOutput(out ?? ".reel/frames/" + ProjectFolder.cleanFileName(name))
        guard output.path.hasPrefix(folder.dotDir.appendingPathComponent("frames").path + "/") else { throw ReelRenderingError("still outputs must stay under .reel/frames/") }
        let sources = try NativeExportSources.capture(project: project, folder: folder)
        let publication = try outputPublication ?? NativeExportOutput(folder: folder, destination: output)
        guard publication.destination == output else { throw ReelRenderingError("the accepted still output changed") }
        defer { publication.cleanup() }
        releaseCaches()
        let frame = try await render(project: project, at: at, comp: comp, width: width)
        try Task.checkCancellation()
        try writeImage(frame.cgImage(), to: publication.part, type: UTType.png.identifier)
        try await beforePublish()
        try sources.validate(folder: folder)
        return try await publishOutput(publication)
    }

    public func export(project: String, spec: ReelNativeExportSpec, audioURL: URL? = nil, progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> URL {
        try await export(project: project, spec: spec, audioURL: audioURL, outputPublication: nil, beforePublish: {}, publishOutput: { try $0.publish() }, progress: progress)
    }

    func export(project: String, spec: ReelNativeExportSpec, audioURL: URL? = nil, outputPublication: NativeExportOutput?, beforePublish: @escaping @Sendable () async throws -> Void, publishOutput: @escaping @Sendable (NativeExportOutput) async throws -> URL, progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> URL {
        let p = try JSON.parse(project) as? [String: Any] ?? [:]
        let b = try JSON.parse(spec.body) as? [String: Any] ?? [:]
        let range = b.object("range").isEmpty ? p.object("range") : b.object("range")
        let from = b.number("from", range.number("in")), to = b.number("to", range.number("out", try core.duration(project: project)))
        let fps = b.number("fps", p.number("fps", 30))
        guard from.isFinite && to.isFinite && to > from && fps.isFinite && fps > 0 && fps <= 240 else { throw ReelRenderingError("invalid export range or frame rate") }
        let frames = max(1, Int(((to - from) * fps).rounded()))
        var paths = Set<String>()
        if !b.string("preset", "h264-high").hasPrefix("audio-") {
            for i in 0..<frames {
                try Task.checkCancellation()
                let plan = try JSON.parse(core.framePlan(project: project, at: from + Double(i) / fps)) as? [String: Any] ?? [:]
                paths.formUnion(lutPaths(plan))
            }
        }
        releaseCaches()
        let snapshot = try captureLUTSnapshot(paths: paths)
        return try await NativeLUTContext.$snapshot.withValue(snapshot) {
            try await exportCapturedLUTs(project: project, spec: spec, audioURL: audioURL, outputPublication: outputPublication, beforePublish: beforePublish, publishOutput: publishOutput, progress: progress, snapshot: snapshot)
        }
    }

    private func exportCapturedLUTs(project: String, spec: ReelNativeExportSpec, audioURL: URL?, outputPublication: NativeExportOutput?, beforePublish: @escaping @Sendable () async throws -> Void, publishOutput: @escaping @Sendable (NativeExportOutput) async throws -> URL, progress: @escaping @Sendable (Double) -> Void, snapshot: NativeLUTSnapshot) async throws -> URL {
        let b = try JSON.parse(spec.body) as? [String: Any] ?? [:], p = try JSON.parse(project) as? [String: Any] ?? [:]
        let preset = b.string("preset", "h264-high"), range = b.object("range").isEmpty ? p.object("range") : b.object("range")
        let from = b.number("from", range.number("in")), to = b.number("to", range.number("out", try core.duration(project: project)))
        let fps = b.number("fps", p.number("fps", 30)), width = b.int("width", p.int("width", 1920))
        guard from.isFinite && to.isFinite && to > from && fps.isFinite && fps > 0 && fps <= 240 && width >= 2 && width <= 16384 else { throw ReelRenderingError("invalid export range, frame rate or width") }
        let hdr = try NativeHDR.transfer(b)
        let hdrMaximum = hdr == nil ? 1 : NativeHDR.relativeMaximum(nits: b.number("maxLuminance", 1000), context: hdrContext)
        if hdr != nil && preset != "hevc" && !preset.hasPrefix("prores-") { throw ReelRenderingError("HDR export requires HEVC or Apple ProRes") }
        let ext: String
        switch preset {
        case "h264-high", "h264-web", "h264-fast", "hevc": ext = "mp4"
        case "prores-422", "prores-422hq", "prores-4444": ext = "mov"
        case "gif": ext = "gif"
        case "png-seq": ext = "frames"
        case "audio-wav": ext = "wav"
        case "audio-m4a": ext = "m4a"
        default: throw ReelRenderingError("unknown native export preset \(preset)")
        }
        let base = (ProjectFolder.cleanFileName(b.string("name", p.string("name", "reel"))) as NSString).deletingPathExtension
        try FileManager.default.createDirectory(at: folder.output(folder.rendersDir.path), withIntermediateDirectories: true)
        let output = try safeOutput(b.string("out", "renders/\(base).\(ext)"))
        guard output.path.hasPrefix(folder.rendersDir.path + "/") else { throw ReelRenderingError("export outputs must stay under renders/") }
        let publication = try outputPublication ?? NativeExportOutput(folder: folder, destination: output)
        guard publication.destination == output else { throw ReelRenderingError("the accepted export output changed") }
        defer { publication.cleanup() }
        let sources = try NativeExportSources.capture(project: project, folder: folder)
        let part = publication.part
        let frames = max(1, Int(((to - from) * fps).rounded()))
        if preset == "png-seq" {
            try FileManager.default.createDirectory(at: folder.output(part.path), withIntermediateDirectories: true)
            for i in 0..<frames {
                try Task.checkCancellation()
                let frame = try await render(project: project, at: from + Double(i) / fps, width: width)
                try writeImage(frame.cgImage(), to: part.appendingPathComponent(String(format: "frame_%05d.png", i + 1)), type: UTType.png.identifier)
                progress(Double(i + 1) / Double(frames))
            }
        } else if preset == "gif" {
            guard let destination = CGImageDestinationCreateWithURL(try folder.output(part.path) as CFURL, UTType.gif.identifier as CFString, frames, nil) else { throw ReelRenderingError("could not create GIF") }
            CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
            for i in 0..<frames {
                try Task.checkCancellation()
                let frame = try await render(project: project, at: from + Double(i) / fps, width: width)
                CGImageDestinationAddImage(destination, try frame.cgImage(), [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 1 / fps, kCGImagePropertyGIFUnclampedDelayTime: 1 / fps]] as CFDictionary)
                progress(Double(i + 1) / Double(frames))
            }
            _ = try folder.output(part.path)
            guard CGImageDestinationFinalize(destination) else { throw ReelRenderingError("could not finish GIF") }
        } else {
            let audio = try audioURL.map { try folder.resolve($0.path) }
            let audioOnly = preset.hasPrefix("audio-")
            if audioOnly && audio == nil { throw ReelRenderingError("audio export requires the native mixed audio file") }
            let writer = try AVAssetWriter(outputURL: folder.output(part.path), fileType: audioOnly ? (preset == "audio-wav" ? .wav : .m4a) : ext == "mov" ? .mov : .mp4)
            var video: AVAssetWriterInput?, adaptor: AVAssetWriterInputPixelBufferAdaptor?
            if !audioOnly {
                let codec: AVVideoCodecType = preset == "hevc" ? .hevc : preset == "prores-422" ? .proRes422 : preset == "prores-422hq" ? .proRes422HQ : preset == "prores-4444" ? .proRes4444 : .h264
                let height = b.int("height", max(2, Int((Double(width) * p.number("height", 1080) / p.number("width", 1920) / 2).rounded()) * 2))
                guard height >= 2 && height <= 16384 else { throw ReelRenderingError("invalid export height") }
                var settings: [String: Any] = [AVVideoCodecKey: codec, AVVideoWidthKey: width, AVVideoHeightKey: height, AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2, AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2]]
                if !preset.hasPrefix("prores") { settings[AVVideoCompressionPropertiesKey] = [AVVideoAverageBitRateKey: b.int("bitrate", max(1_000_000, width * height * (preset == "h264-web" ? 4 : 8))), AVVideoExpectedSourceFrameRateKey: fps, AVVideoMaxKeyFrameIntervalKey: max(1, Int(fps * 2))] }
                if let hdr { settings = try NativeHDR.settings(settings, transfer: hdr, body: b) }
                guard writer.canApply(outputSettings: settings, forMediaType: .video) else { throw ReelRenderingError("\(preset) encoding is unavailable on this device") }
                let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings); input.expectsMediaDataInRealTime = false
                guard writer.canAdd(input) else { throw ReelRenderingError("could not add native video encoder") }; writer.add(input); video = input
                adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: hdr == nil ? kCVPixelFormatType_32BGRA : preset == "prores-4444" ? kCVPixelFormatType_64RGBAHalf : kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height, kCVPixelBufferMetalCompatibilityKey as String: true])
            }
            var audioInput: AVAssetWriterInput?
            if audio != nil {
                let pcm = preset.hasPrefix("prores") || preset == "audio-wav"
                let settings: [String: Any] = pcm ? [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 24, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false] : [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 256000]
                guard writer.canApply(outputSettings: settings, forMediaType: .audio) else { throw ReelRenderingError("native audio encoder is unavailable") }
                let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings); input.expectsMediaDataInRealTime = false
                guard writer.canAdd(input) else { throw ReelRenderingError("could not add native audio encoder") }; writer.add(input); audioInput = input
            }
            guard writer.startWriting() else { throw writer.error ?? ReelRenderingError("could not start native export") }
            writer.startSession(atSourceTime: .zero)
            do {
                try await withThrowingTaskGroup(of: Void.self) { group in
                    if let audio, let audioInput { group.addTask { try await appendNativeAudio(audio, to: audioInput, writer: writer, duration: Double(frames) / fps) } }
                    if let video, let adaptor {
                        for i in 0..<frames {
                            try Task.checkCancellation()
                            let frame = try await hdr == nil ? render(project: project, at: from + Double(i) / fps, width: width) : renderHDR(project: project, at: from + Double(i) / fps, width: width)
                            guard frame.height == (adaptor.sourcePixelBufferAttributes?[kCVPixelBufferHeightKey as String] as? Int) else { throw ReelRenderingError("custom export height must match the project aspect ratio") }
                            while !video.isReadyForMoreMediaData { try Task.checkCancellation(); if writer.status == .failed { throw writer.error! }; try await Task.sleep(nanoseconds: 1_000_000) }
                            let buffer = try hdr.map { try NativeHDR.encode(frame.pixelBuffer, transfer: $0, maximum: hdrMaximum, context: hdrContext, alpha: preset == "prores-4444") } ?? frame.pixelBuffer
                            guard adaptor.append(buffer, withPresentationTime: CMTime(seconds: Double(i) / fps, preferredTimescale: 600000)) else { throw writer.error ?? ReelRenderingError("native encoder rejected frame \(i)") }
                            progress(Double(i + 1) / Double(frames))
                        }
                        video.markAsFinished()
                    }
                    try await group.waitForAll()
                }
                writer.endSession(atSourceTime: CMTime(seconds: Double(frames) / fps, preferredTimescale: 600000))
                _ = try folder.output(part.path)
                await writer.finishWriting()
                guard writer.status == .completed else { throw writer.error ?? ReelRenderingError("native export did not finish") }
            } catch { writer.cancelWriting(); throw error }
        }
        try Task.checkCancellation()
        try validateLUTSnapshot(snapshot)
        try await beforePublish()
        try sources.validate(folder: folder)
        return try await publishOutput(publication)
    }

    func writeImage(_ image: CGImage, to url: URL, type: String) throws {
        let checked = try folder.output(url.path)
        guard let destination = CGImageDestinationCreateWithURL(checked as CFURL, type as CFString, 1, nil) else { throw ReelRenderingError("could not create image output") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw ReelRenderingError("could not finish image output") }
    }

    func safeOutput(_ path: String) throws -> URL {
        try folder.output(path)
    }
}

private func appendNativeAudio(_ url: URL, to input: AVAssetWriterInput, writer: AVAssetWriter, duration: Double) async throws {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .audio).first else { throw ReelRenderingError("mixed audio file has no audio track") }
    let reader = try AVAssetReader(asset: asset), output = AVAssetReaderTrackOutput(track: track, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false])
    reader.timeRange = CMTimeRange(start: .zero, duration: CMTime(seconds: duration, preferredTimescale: 48000)); reader.add(output)
    guard reader.startReading() else { throw reader.error ?? ReelRenderingError("could not read mixed audio") }
    defer { reader.cancelReading() }
    while let sample = output.copyNextSampleBuffer() {
        try Task.checkCancellation()
        while !input.isReadyForMoreMediaData { try Task.checkCancellation(); if writer.status == .failed { throw writer.error! }; try await Task.sleep(nanoseconds: 1_000_000) }
        guard input.append(sample) else { throw writer.error ?? ReelRenderingError("native encoder rejected mixed audio") }
    }
    guard reader.status != .failed else { throw reader.error! }
    input.markAsFinished()
}
