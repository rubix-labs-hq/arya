import Accelerate
import AVFoundation
import Foundation
import CoreFoundation

public enum NativeAudioProcessing {
    public struct PCM: Sendable {
        public var channels: [[Float]]
        public let rate: Int
        public var count: Int { channels.first?.count ?? 0 }
        public var duration: Double { Double(count) / Double(rate) }
        public init(channels: [[Float]], rate: Int = 48000) { self.channels = channels; self.rate = rate }
    }

    public struct Loudness: Sendable {
        public let integrated: Double
        public let range: Double
        public let peak: Double
        public let threshold: Double
        public let rangeAvailable: Bool
        public var json: JSON { .object([("i", finite(integrated)), ("tp", finite(peak)), ("lra", rangeAvailable ? .number(range) : .null), ("lraAvailable", .bool(rangeAvailable)), ("thresh", finite(threshold))]) }
    }

    public static func decode(_ file: URL, rate: Int = 48000, channels: Int = 2, from: Double = 0, duration: Double? = nil) async throws -> PCM {
        try Task.checkCancellation()
        guard (4000...192000).contains(rate), (1...2).contains(channels), from.isFinite, from >= 0,
              duration == nil || duration!.isFinite && duration! > 0 else { throw ReelBackend.APIError("Invalid audio range or format.") }
        let asset = AVURLAsset(url: file)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { throw ReelBackend.APIError("\(file.lastPathComponent) has no audio.") }
        let channelGain = try await stereoDecodeGain(track: track, channels: channels)
        let assetDuration = try await asset.load(.duration)
        try Task.checkCancellation()
        guard assetDuration.isNumeric, assetDuration.epoch == 0 else { throw ReelBackend.APIError("The audio source has no finite asset duration.") }
        let window = try DecodeWindow(assetDuration: assetDuration, rate: rate, channels: channels, from: from, duration: duration)
        var timeline = try DecodeTimeline(window: window)
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(start: window.start, duration: window.span)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: Double(rate), AVNumberOfChannelsKey: channels, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false])
        guard reader.canAdd(output) else { throw ReelBackend.APIError("Cannot read the requested audio format.") }
        reader.add(output)
        try Task.checkCancellation()
        guard reader.startReading() else { throw reader.error ?? ReelBackend.APIError("Cannot decode the audio.") }
        defer { if reader.status == .reading { reader.cancelReading() } }
        while let buffer = output.copyNextSampleBuffer() {
            try Task.checkCancellation()
            try timeline.place(buffer, gain: channelGain)
        }
        try Task.checkCancellation()
        if reader.status == .cancelled { throw CancellationError() }
        guard reader.status == .completed else { throw reader.error ?? ReelBackend.APIError("Audio decoding did not complete.") }
        return timeline.pcm
    }

    // Match the browser FFmpeg decoder's equal-energy mono-to-stereo conversion.
    // Existing stereo and mono output retain their original channel levels.
    static func stereoDecodeGain(track: AVAssetTrack, channels: Int) async throws -> Float {
        guard channels == 2 else { return 1 }
        let formats = try await track.load(.formatDescriptions)
        guard !formats.isEmpty else { return 1 }
        let mono = formats.allSatisfy { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee.mChannelsPerFrame == 1 }
        return mono ? Float(1 / sqrt(2.0)) : 1
    }

    // The window stays inside the asset boundary. Gaps inside it retain zero samples.
    struct DecodeWindow {
        let start: CMTime, span: CMTime
        let frames: Int, rate: Int, channels: Int
        let outputBytes: UInt64, limit: UInt64

        init(assetDuration: CMTime, rate: Int, channels: Int, from: Double, duration: Double?, limit: UInt64 = NativeAudioMixer.memoryLimitBytes) throws {
            guard assetDuration.isNumeric, assetDuration.epoch == 0, assetDuration.seconds.isFinite, assetDuration.seconds > 0,
                  from.isFinite, from >= 0, from < assetDuration.seconds, (4000...192000).contains(rate), (1...2).contains(channels),
                  duration == nil || duration!.isFinite && duration! > 0 else { throw ReelBackend.APIError("Invalid audio range or format.") }
            let start = try Self.sourceTime(from, rate: rate)
            let remaining = CMTimeSubtract(assetDuration, start)
            guard remaining.isNumeric, remaining.epoch == 0, remaining.seconds > 0 else { throw ReelBackend.APIError("The audio window has no available source span.") }
            let seconds = min(duration ?? remaining.seconds, remaining.seconds)
            try validateMemory(seconds: seconds, rate: rate, channels: channels, limit: limit)
            let frames: Int
            if let duration, duration < remaining.seconds {
                frames = try Self.sampleCount(seconds: duration, rate: rate)
            } else {
                let count = CMTimeConvertScale(remaining, timescale: Int32(rate), method: .roundTowardPositiveInfinity)
                guard count.isNumeric, count.value > 0, count.value <= Int64(Int.max / (channels * MemoryLayout<Float>.stride)) else { throw ReelBackend.APIError("The audio window exceeds the sample count limit.") }
                frames = Int(count.value)
            }
            let sampleSpan = CMTime(value: Int64(frames), timescale: Int32(rate))
            // Include a partial final frame, while the asset boundary remains exact.
            let span = CMTimeCompare(sampleSpan, remaining) < 0 ? sampleSpan : remaining
            let bytes = UInt64(frames) * UInt64(channels * MemoryLayout<Float>.stride)
            let scratch = UInt64(min(frames, 4096)) * UInt64(channels * MemoryLayout<Float>.stride)
            guard bytes <= limit, scratch <= limit - bytes else { throw ReelBackend.APIError("The audio window exceeds the decoder memory budget.") }
            self.start = start; self.span = span; self.frames = frames; self.rate = rate; self.channels = channels
            self.outputBytes = bytes; self.limit = limit
        }

        // Four Double ulps absorb divide/multiply error, capped at one millionth of a frame.
        private static func snappedCoordinate(_ value: Double) -> Double {
            let nearest = value.rounded()
            let tolerance = min(0.000001, 4 * max(value.ulp, nearest.ulp))
            return abs(value - nearest) <= tolerance ? nearest : value
        }

        static func sampleCount(seconds: Double, rate: Int) throws -> Int {
            guard seconds.isFinite, seconds > 0, seconds <= 3600, (4000...192000).contains(rate) else { throw ReelBackend.APIError("Invalid audio sample span.") }
            let count = ceil(snappedCoordinate(seconds * Double(rate)))
            guard count.isFinite, count > 0, count <= Double(3600 * 192000) else { throw ReelBackend.APIError("The audio window exceeds the sample count limit.") }
            return Int(count)
        }

        private static func sourceTime(_ seconds: Double, rate: Int) throws -> CMTime {
            let scaled = seconds * Double(rate)
            guard scaled.isFinite, scaled >= 0, scaled < Double(Int64.max / 4) else { throw ReelBackend.APIError("The source start exceeds the sample coordinate limit.") }
            let coordinate = snappedCoordinate(scaled)
            let time = coordinate == coordinate.rounded() ? CMTime(value: Int64(coordinate), timescale: Int32(rate)) : CMTime(seconds: seconds, preferredTimescale: 1_000_000_000)
            guard time.isNumeric, time.epoch == 0 else { throw ReelBackend.APIError("The source start cannot be represented as a finite time.") }
            return time
        }
    }

    struct DecodeTimeline {
        let window: DecodeWindow
        private(set) var pcm: PCM
        private var previousEnd: Int?

        init(window: DecodeWindow) throws {
            try Task.checkCancellation()
            self.window = window
            var channels: [[Float]] = []
            for _ in 0..<window.channels {
                try Task.checkCancellation()
                channels.append([Float](repeating: 0, count: window.frames))
            }
            self.pcm = PCM(channels: channels, rate: window.rate)
        }

        mutating func place(_ buffer: CMSampleBuffer, gain: Float = 1) throws {
            try Task.checkCancellation()
            guard CMSampleBufferIsValid(buffer), !CMSampleBufferHasDataFailed(buffer, statusOut: nil),
                  CMSampleBufferDataIsReady(buffer) else { throw ReelBackend.APIError("The decoded audio buffer is invalid or not ready.") }
            let frames = CMSampleBufferGetNumSamples(buffer)
            // A ready, empty marker carries no PCM and leaves the timeline gap unchanged.
            if frames == 0 {
                let bytes = CMSampleBufferGetDataBuffer(buffer).map { CMBlockBufferGetDataLength($0) } ?? 0
                guard bytes == 0, CMSampleBufferGetTotalSampleSize(buffer) == 0, CMSampleBufferGetImageBuffer(buffer) == nil else { throw ReelBackend.APIError("The zero-sample audio buffer contains unexpected media data.") }
                return
            }
            let bytesPerFrame = window.channels * MemoryLayout<Float>.stride
            guard frames > 0, frames <= Int.max / bytesPerFrame,
                  let format = CMSampleBufferGetFormatDescription(buffer), CMFormatDescriptionGetMediaType(format) == kCMMediaType_Audio,
                  let description = CMAudioFormatDescriptionGetStreamBasicDescription(format),
                  let block = CMSampleBufferGetDataBuffer(buffer) else { throw ReelBackend.APIError("The decoded audio buffer is incomplete.") }
            let asbd = description.pointee
            guard asbd.mFormatID == kAudioFormatLinearPCM, asbd.mSampleRate.isFinite, asbd.mSampleRate == Double(window.rate),
                  asbd.mChannelsPerFrame == UInt32(window.channels), asbd.mBitsPerChannel == 32,
                  asbd.mFramesPerPacket == 1, asbd.mBytesPerFrame == UInt32(bytesPerFrame), asbd.mBytesPerPacket == UInt32(bytesPerFrame),
                  asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mFormatFlags & kAudioFormatFlagIsPacked != 0,
                  asbd.mFormatFlags & (kAudioFormatFlagIsBigEndian | kAudioFormatFlagIsNonInterleaved | kAudioFormatFlagIsSignedInteger) == 0 else { throw ReelBackend.APIError("The decoded audio format is not the requested interleaved Float32 PCM.") }
            let length = CMBlockBufferGetDataLength(block)
            guard length == frames * bytesPerFrame else { throw ReelBackend.APIError("The decoded audio sample count does not match its data.") }
            let scratchBytes = UInt64(min(frames, 4096) * bytesPerFrame)
            guard window.outputBytes <= window.limit, UInt64(length) <= window.limit - window.outputBytes,
                  scratchBytes <= window.limit - window.outputBytes - UInt64(length) else { throw ReelBackend.APIError("The decoded audio buffer exceeds the memory budget.") }
            var timing = CMSampleTimingInfo(), entries = 0
            guard CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: 1, arrayToFill: &timing, entriesNeededOut: &entries) == noErr,
                  entries == 1, timing.duration.isNumeric, timing.duration.epoch == 0,
                  abs(timing.duration.seconds * Double(window.rate) - 1) <= 0.000001 else { throw ReelBackend.APIError("The decoded audio buffer has unsupported sample timing.") }
            if let value = CMGetAttachment(buffer, key: kCMSampleBufferAttachmentKey_Reverse, attachmentModeOut: nil) {
                guard let flag = value as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID(), !flag.boolValue else { throw ReelBackend.APIError("Reversed audio buffers are not supported.") }
            }
            if let value = CMGetAttachment(buffer, key: kCMSampleBufferAttachmentKey_SpeedMultiplier, attachmentModeOut: nil) {
                guard let speed = value as? NSNumber, CFGetTypeID(speed) != CFBooleanGetTypeID(), speed.doubleValue == 1 else { throw ReelBackend.APIError("Stretched audio buffers are not supported.") }
            }
            let head = try trimFrames(buffer, key: kCMSampleBufferAttachmentKey_TrimDurationAtStart, maximum: frames)
            let tail = try trimFrames(buffer, key: kCMSampleBufferAttachmentKey_TrimDurationAtEnd, maximum: frames - head)
            let usable = frames - head - tail
            let pts = CMSampleBufferGetPresentationTimeStamp(buffer), outputPTS = CMSampleBufferGetOutputPresentationTimeStamp(buffer)
            guard pts.isNumeric, pts.epoch == 0, outputPTS.isNumeric, outputPTS.epoch == 0 else { throw ReelBackend.APIError("The decoded audio timestamp is invalid.") }
            if usable == 0 { return }
            let offset = CMTimeConvertScale(CMTimeSubtract(outputPTS, window.start), timescale: Int32(window.rate), method: .roundHalfAwayFromZero)
            guard offset.isNumeric, offset.epoch == 0, offset.value > Int64(Int.min / 4), offset.value < Int64(Int.max / 4) else { throw ReelBackend.APIError("The decoded audio timestamp exceeds the sample coordinate limit.") }
            let begin = Int(offset.value), end = begin + usable
            if let previousEnd, begin < previousEnd - 1 { throw ReelBackend.APIError("Decoded audio buffers overlap or arrive out of presentation order.") }
            let first = max(max(0, begin), previousEnd ?? begin), last = min(window.frames, end)
            previousEnd = end
            guard last > first else { return }
            var copied = 0
            let needed = last - first, capacity = min(4096, needed)
            var samples = [Float](repeating: 0, count: capacity * window.channels)
            while copied < needed {
                try Task.checkCancellation()
                let count = min(capacity, needed - copied), sourceFrame = head + first - begin + copied
                let status = samples.withUnsafeMutableBytes { bytes in
                    CMBlockBufferCopyDataBytes(block, atOffset: sourceFrame * bytesPerFrame, dataLength: count * bytesPerFrame, destination: bytes.baseAddress!)
                }
                guard status == kCMBlockBufferNoErr else { throw ReelBackend.APIError("Cannot copy the decoded PCM data.") }
                for frame in 0..<count { for channel in 0..<window.channels {
                    let value = samples[frame * window.channels + channel]
                    guard value.isFinite else { throw ReelBackend.APIError("The decoded audio contains a non-finite sample.") }
                    pcm.channels[channel][first + copied + frame] = value * gain
                } }
                copied += count
            }
            try Task.checkCancellation()
        }

        private func trimFrames(_ buffer: CMSampleBuffer, key: CFString, maximum: Int) throws -> Int {
            guard let value = CMGetAttachment(buffer, key: key, attachmentModeOut: nil) else { return 0 }
            guard let dictionary = value as? [String: Any] else { throw ReelBackend.APIError("The audio trim attachment is invalid.") }
            let time = CMTimeMakeFromDictionary(dictionary as CFDictionary)
            guard time.isNumeric, time.epoch == 0, time.seconds >= 0 else { throw ReelBackend.APIError("The audio trim duration is invalid.") }
            let frames = CMTimeConvertScale(time, timescale: Int32(window.rate), method: .roundHalfAwayFromZero)
            guard frames.isNumeric, frames.value >= 0, frames.value <= Int64(maximum) else { throw ReelBackend.APIError("The audio trim exceeds the decoded buffer.") }
            return Int(frames.value)
        }
    }

    public static func validateMemory(seconds: Double, rate: Int = 48000, channels: Int = 2, paddingSeconds: Double = 0, limit: UInt64 = NativeAudioMixer.memoryLimitBytes) throws {
        guard seconds.isFinite, seconds > 0, paddingSeconds.isFinite, paddingSeconds >= 0, rate >= 4000, rate <= 192000, channels >= 1, channels <= 2 else { throw ReelBackend.APIError("The selected audio range contains no samples.") }
        let bytes = (seconds + paddingSeconds) * Double(rate * channels * MemoryLayout<Float>.stride) * 6 * 1.25
        guard seconds <= 3600, bytes <= Double(limit) else { throw ReelBackend.APIError(String(format: "This audio range needs about %.0f MB of processing memory; this device's budget is %.0f MB. Select a shorter source or range.", bytes / 1048576, Double(limit) / 1048576)) }
    }

    public static func write(_ pcm: PCM, to file: URL) throws {
        guard pcm.count > 0, pcm.channels.allSatisfy({ $0.count == pcm.count }) else { throw ReelBackend.APIError("The processed audio is empty or has uneven channels.") }
        var bytes = Data(capacity: pcm.count * pcm.channels.count * 2)
        for i in 0..<pcm.count {
            if i % 8192 == 0 { try Task.checkCancellation() }
            for channel in pcm.channels {
                let sample = channel[i].isFinite ? max(-1, min(1, channel[i])) : 0
                var value = Int16((sample * (sample >= 0 ? 32767 : 32768)).rounded()).littleEndian
                bytes.append(Data(bytes: &value, count: 2))
            }
        }
        try (MediaDerivatives.wavHeader(dataBytes: bytes.count, sampleRate: pcm.rate, channels: pcm.channels.count) + bytes).write(to: file, options: .atomic)
    }

    /// Cleanup intermediates retain Float32 samples, including headroom above full scale.
    /// The shared PCM16 writer remains the delivery and video-mux writer.
    public static func writeCleanup(_ pcm: PCM, to file: URL) throws {
        guard pcm.count > 0, (1...2).contains(pcm.channels.count), (4000...192000).contains(pcm.rate),
              pcm.channels.allSatisfy({ $0.count == pcm.count }), pcm.count <= Int(UInt32.max - 50) / (pcm.channels.count * 4) else { throw ReelBackend.APIError("Cleanup needs equally sized mono or stereo channels within the WAV size limit.") }
        var bytes = Data(capacity: pcm.count * pcm.channels.count * 4)
        for i in 0..<pcm.count {
            if i % 8192 == 0 { try Task.checkCancellation() }
            for channel in pcm.channels {
                guard channel[i].isFinite else { throw ReelBackend.APIError("Cleanup contains a non-finite sample.") }
                var value = channel[i].bitPattern.littleEndian
                bytes.append(Data(bytes: &value, count: 4))
            }
        }
        var header = Data()
        func u32(_ value: Int) { var word = UInt32(value).littleEndian; header.append(Data(bytes: &word, count: 4)) }
        func u16(_ value: Int) { var word = UInt16(value).littleEndian; header.append(Data(bytes: &word, count: 2)) }
        header.append(contentsOf: "RIFF".utf8); u32(50 + bytes.count)
        header.append(contentsOf: "WAVEfmt ".utf8); u32(18); u16(3); u16(pcm.channels.count); u32(pcm.rate)
        u32(pcm.rate * pcm.channels.count * 4); u16(pcm.channels.count * 4); u16(32); u16(0)
        header.append(contentsOf: "fact".utf8); u32(4); u32(pcm.count)
        header.append(contentsOf: "data".utf8); u32(bytes.count)
        try Task.checkCancellation()
        try (header + bytes).write(to: file, options: .atomic)
    }

    /// Cancels the worker and waits for it to stop before releasing its captured PCM.
    static func cancellableTask<Value: Sendable>(_ operation: @escaping @Sendable () throws -> Value) async throws -> Value {
        try Task.checkCancellation()
        let worker = Task.detached {
            try Task.checkCancellation()
            return try operation()
        }
        return try await withTaskCancellationHandler {
            let result = try await worker.value
            try Task.checkCancellation()
            return result
        } onCancel: { worker.cancel() }
    }

    public static func measure(_ pcm: PCM) throws -> Loudness {
        try Task.checkCancellation()
        guard pcm.count > 0, (1...2).contains(pcm.channels.count),
              pcm.channels.allSatisfy({ $0.count == pcm.count }) else { throw ReelBackend.APIError("Loudness measurement needs non-empty, equally sized mono or stereo channels.") }
        try validateMemory(seconds: pcm.duration, rate: pcm.rate, channels: pcm.channels.count, paddingSeconds: 1.5)
        let fs = Double(pcm.rate)
        let filters = kWeighting(fs)
        // File measurements include the trailing silence required by the short-term window.
        var energies = [Double](repeating: 0, count: pcm.count + Int(ceil(fs * 1.5)))
        var peak = 0.0
        for samples in pcm.channels {
            var shelf = filters[0], hp = filters[1]
            var history = [Double](repeating: 0, count: 12), position = 0
            for i in 0..<energies.count {
                if i % 8192 == 0 { try Task.checkCancellation() }
                let x = i < samples.count ? Double(samples[i]) : 0
                guard x.isFinite else { throw ReelBackend.APIError("The audio contains a non-finite sample.") }
                let y = hp.next(shelf.next(x))
                energies[i] += y * y
                if i < samples.count { peak = max(peak, abs(x)) }
                if i < samples.count + 12 {
                    history[position] = x
                    for phase in peakPhases {
                        var y = 0.0
                        for j in 0..<12 { y += phase[j] * history[(position - j + 12) % 12] }
                        peak = max(peak, abs(y))
                    }
                    position = (position + 1) % 12
                }
            }
        }
        var prefix = [Double](repeating: 0, count: energies.count + 1)
        for i in energies.indices {
            if i % 8192 == 0 { try Task.checkCancellation() }
            prefix[i + 1] = prefix[i] + energies[i]
        }
        func blocks(_ seconds: Double, hop: Double, length: Int) throws -> [Double] {
            let n = min(length, max(1, Int(fs * seconds))), step = max(1, Int(fs * hop))
            var result: [Double] = []
            for offset in stride(from: 0, through: max(0, length - n), by: step) {
                if result.count % 64 == 0 { try Task.checkCancellation() }
                result.append((prefix[offset + n] - prefix[offset]) / Double(n))
            }
            return result
        }
        let absolute = try blocks(0.4, hop: 0.1, length: pcm.count).filter { lufs($0) > -70 }
        let threshold = absolute.isEmpty ? -.infinity : lufs(absolute.reduce(0, +) / Double(absolute.count)) - 10
        let gated = absolute.filter { lufs($0) > threshold }
        let integrated = gated.isEmpty ? -.infinity : lufs(gated.reduce(0, +) / Double(gated.count))
        let rangeAvailable = pcm.duration >= 3
        let short: [Double]
        if rangeAvailable { short = try blocks(3, hop: 0.1, length: energies.count).map(lufs) }
        else { short = [] }
        let range = try loudnessRange(short)
        return Loudness(integrated: integrated, range: range, peak: db(peak), threshold: threshold, rangeAvailable: rangeAvailable)
    }

    // EBU Tech 3342 uses the short-term population for its relative gate and percentiles.
    static func loudnessRange(_ shortTerm: [Double]) throws -> Double {
        try Task.checkCancellation()
        let absolute = shortTerm.filter { $0.isFinite && $0 >= -70 }
        guard !absolute.isEmpty else { return 0 }
        var power = 0.0
        for (index, level) in absolute.enumerated() {
            if index % 64 == 0 { try Task.checkCancellation() }
            power += pow(10, level / 10)
        }
        let threshold = 10 * log10(power / Double(absolute.count)) - 20
        let gated = absolute.filter { $0 >= threshold }.sorted()
        guard !gated.isEmpty else { return 0 }
        let low = Int((Double(gated.count - 1) * 0.10).rounded())
        let high = Int((Double(gated.count - 1) * 0.95).rounded())
        try Task.checkCancellation()
        return max(0, gated[high] - gated[low])
    }

    public static func silence(_ pcm: PCM, noise: Double = -32, minimum: Double = 0.45) throws -> [[Double]] {
        try Task.checkCancellation()
        let hop = max(1, pcm.rate / 100)
        var ranges: [[Double]] = [], start: Int?
        for offset in stride(from: 0, to: pcm.count, by: hop) {
            try Task.checkCancellation()
            let end = min(pcm.count, offset + hop)
            var energy = 0.0
            for c in pcm.channels { for i in offset..<end { energy += Double(c[i] * c[i]) } }
            let level = db(sqrt(energy / Double((end - offset) * pcm.channels.count)))
            if level <= noise { if start == nil { start = offset } }
            else if let begin = start {
                if Double(offset - begin) / Double(pcm.rate) >= minimum { ranges.append([Double(begin) / Double(pcm.rate), Double(offset) / Double(pcm.rate)]) }
                start = nil
            }
        }
        if let begin = start, Double(pcm.count - begin) / Double(pcm.rate) >= minimum { ranges.append([Double(begin) / Double(pcm.rate), pcm.duration]) }
        return ranges
    }

    public static func beats(_ pcm: PCM) throws -> (times: [Double], bpm: Int?) {
        try Task.checkCancellation()
        let hop = max(1, Int(Double(pcm.rate) * 256 / 11025))
        var filter = Biquad.make("lowpass", fs: Double(pcm.rate), frequency: 180), envelope: [Double] = []
        var square = 0.0, n = 0
        for i in 0..<pcm.count {
            if i % 8192 == 0 { try Task.checkCancellation() }
            let mono = pcm.channels.reduce(0.0) { $0 + Double($1[i]) } / Double(pcm.channels.count)
            let x = filter.next(mono)
            square += x * x; n += 1
            if n == hop { envelope.append(sqrt(square / Double(n))); square = 0; n = 0 }
        }
        let flux = envelope.enumerated().map { max(0, $0.element - ($0.offset > 0 ? envelope[$0.offset - 1] : 0)) }
        var times: [Double] = [], last = -1.0
        for i in flux.indices {
            if i % 256 == 0 { try Task.checkCancellation() }
            let lo = max(0, i - 43), hi = min(flux.count, i + 43)
            let mean = flux[lo..<hi].reduce(0, +) / Double(hi - lo)
            let t = Double(i * hop) / Double(pcm.rate)
            if flux[i] > max(0.004, mean * 2.2), flux[i] >= (i > 0 ? flux[i - 1] : 0), flux[i] >= (i + 1 < flux.count ? flux[i + 1] : 0), t - last > 0.22 {
                times.append((t * 1000).rounded() / 1000); last = t
            }
        }
        let gaps = zip(times.dropFirst(), times).map(-).filter { $0 > 0.25 && $0 < 1.5 }.sorted()
        return (times, gaps.isEmpty ? nil : Int((60 / gaps[gaps.count / 2]).rounded()))
    }

    public struct CleanOptions: Sendable {
        public var strength: Double, detail: Double, quality: String, noiseFrom: Double?, noiseTo: Double?
        public init(strength: Double = 1, detail: Double = 0.5, quality: String = "balanced", noiseFrom: Double? = nil, noiseTo: Double? = nil) { self.strength=strength; self.detail=detail; self.quality=quality; self.noiseFrom=noiseFrom; self.noiseTo=noiseTo }
        public init(request: [String: Any]) throws {
            strength = try NativeAudioProcessing.requestNumber(request, "strength") ?? 0.75
            detail = try NativeAudioProcessing.requestNumber(request, "detail") ?? 0.7
            quality = try NativeAudioProcessing.requestString(request, "quality") ?? "balanced"
            noiseFrom = try NativeAudioProcessing.requestNumber(request, "noiseFrom")
            noiseTo = try NativeAudioProcessing.requestNumber(request, "noiseTo")
            try validate()
        }
        public var settings: [String: Any] {
            var result: [String: Any] = ["strength": strength, "detail": detail, "quality": quality]
            if let noiseFrom { result["noiseFrom"] = noiseFrom }
            if let noiseTo { result["noiseTo"] = noiseTo }
            return result
        }
        public func validate(duration: Double? = nil) throws {
            guard strength.isFinite, (0...1).contains(strength), detail.isFinite, (0...1).contains(detail), ["fast","balanced","high"].contains(quality) else { throw ReelBackend.APIError("Audio cleanup needs strength and detail from zero to one, and fast, balanced or high quality.") }
            if noiseFrom != nil || noiseTo != nil { guard let from=noiseFrom, let to=noiseTo, from.isFinite, to.isFinite, from>=0, to-from>=0.1-1e-9, duration.map({ to<=$0 }) ?? true else { throw ReelBackend.APIError("Choose at least 0.1 seconds of noise-only audio inside the source.") } }
        }
    }

    public struct CleanupRequest: Sendable {
        public let mode: String, options: CleanOptions, useOriginal: Bool, apply: Bool
        public init(_ request: [String: Any]) throws {
            mode = try NativeAudioProcessing.requestString(request, "mode") ?? "denoise"
            guard ["voice", "denoise"].contains(mode) else { throw ReelBackend.APIError("mode must be denoise or voice") }
            options = try CleanOptions(request: request)
            useOriginal = try NativeAudioProcessing.requestBoolean(request, "useOriginal") ?? true
            apply = try NativeAudioProcessing.requestBoolean(request, "apply") ?? true
            _ = try NativeAudioProcessing.requestBoolean(request, "wait")
            for key in ["src", "id", "clip", "comp"] { _ = try NativeAudioProcessing.requestString(request, key) }
            if request["expectedVersion"] != nil { _ = try NativeAudioMixCapture.strictVersion(request["expectedVersion"]) }
        }
    }

    static func requestNumber(_ request: [String: Any], _ key: String) throws -> Double? {
        guard let value = request[key] else { return nil }
        if value is NSNull, ["noiseFrom", "noiseTo"].contains(key) { return nil }
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { throw ReelBackend.APIError("\(key) must be a finite JSON number.") }
        return number.doubleValue
    }
    static func requestBoolean(_ request: [String: Any], _ key: String) throws -> Bool? {
        guard let value = request[key] else { return nil }
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw ReelBackend.APIError("\(key) must be a JSON Boolean.") }
        return number.boolValue
    }
    static func requestString(_ request: [String: Any], _ key: String) throws -> String? {
        guard let value = request[key] else { return nil }
        if key == "comp", value is NSNull { return nil }
        guard let text = value as? String, !text.isEmpty else { throw ReelBackend.APIError("\(key) must be a nonempty string.") }
        return text
    }

    public static func cleanupSource(clip: [String: Any], assets: [String: Any], useOriginal: Bool = true) throws -> String {
        guard let current = clip["src"] as? String, !current.isEmpty else { throw ReelBackend.APIError("Choose an audio source before cleanup.") }
        guard useOriginal, let recipe = clip["audioCleanup"] as? [String: Any], recipe["output"] as? String == current else { return current }
        guard try requestNumber(recipe, "version") == 1 else { throw ReelBackend.APIError("This saved cleanup recipe version is unsupported. Keep it until the editor can restore its original source.") }
        guard let source = recipe["source"] as? String, !source.isEmpty, source != current,
              let asset = assets[source] as? [String: Any], (try? requestBoolean(asset, "hasAudio")) == true else { throw ReelBackend.APIError("Restore the original audio asset before adjusting this cleanup. The saved recipe has been retained.") }
        return source
    }

    public static func cleanupRecipe(source: String, output: String, mode: String, options: CleanOptions) -> [String: Any] {
        ["version": 1, "source": source, "output": output, "mode": mode, "engine": "accelerate-spectral-cpu", "settings": options.settings]
    }

    private static func quietestWindows(_ input: [(Int, Double)], count: Int) throws -> [(Int, Double)] {
        var heap: [(Int, Double)] = []
        let size = max(1, count)
        for (offset, value) in input.enumerated() {
            if offset % 256 == 0 { try Task.checkCancellation() }
            if heap.count < size {
                heap.append(value)
                var child = heap.count - 1
                while child > 0 { let parent = (child - 1) / 2; if heap[parent].1 >= heap[child].1 { break }; heap.swapAt(parent, child); child = parent }
            } else if value.1 < heap[0].1 {
                heap[0] = value
                var parent = 0
                while parent * 2 + 1 < heap.count {
                    var child = parent * 2 + 1
                    if child + 1 < heap.count, heap[child + 1].1 > heap[child].1 { child += 1 }
                    if heap[parent].1 >= heap[child].1 { break }
                    heap.swapAt(parent, child); parent = child
                }
            }
        }
        try Task.checkCancellation()
        return heap
    }

    public static func clean(_ pcm: PCM, mode: String, options: CleanOptions = .init()) throws -> PCM {
        try Task.checkCancellation()
        guard ["denoise", "voice"].contains(mode) else { throw ReelBackend.APIError("Unknown clean mode. Choose denoise or voice.") }
        guard pcm.count > 0, (1...2).contains(pcm.channels.count), pcm.channels.allSatisfy({ $0.count == pcm.count }) else { throw ReelBackend.APIError("Cleanup needs equally sized mono or stereo channels.") }
        try validateMemory(seconds: pcm.duration, rate: pcm.rate, channels: pcm.channels.count)
        try options.validate(duration: pcm.duration)
        for input in pcm.channels { for i in input.indices { if i % 8192 == 0 { try Task.checkCancellation() }; guard input[i].isFinite else { throw ReelBackend.APIError("The audio contains a non-finite sample.") } } }
        if options.strength == 0 && mode == "denoise" { return pcm }
        let n = options.quality == "high" ? 4096 : options.quality == "fast" ? 1024 : 2048, hop = n / 4
        if options.strength > 0, pcm.count < n { throw ReelBackend.APIError("This source is shorter than the selected cleanup analysis window. Choose a faster quality or zero strength.") }
        let fft: ComplexFFT?
        if options.strength > 0 { fft = try ComplexFFT(size: n) } else { fft = nil }
        let window = (0..<n).map { 0.5 - 0.5 * cos(2 * .pi * Double($0) / Double(n)) }
        var channels: [[Float]] = []
        for input in pcm.channels {
            try Task.checkCancellation()
            var samples = input
            if let fft {
                let padded = [Float](repeating: 0, count: n) + input + [Float](repeating: 0, count: n)
                let positions = stride(from: 0, through: padded.count - n, by: hop)
                var levels: [(Int, Double)] = []
                for offset in positions where offset >= n && offset + n <= n + input.count {
                    try Task.checkCancellation()
                    if let from = options.noiseFrom, let to = options.noiseTo,
                       Double(offset - n) / Double(pcm.rate) < from || Double(offset) / Double(pcm.rate) > to { continue }
                    var energy = 0.0
                    for i in 0..<n { let value = Double(padded[offset + i]); energy += value * value }
                    if options.noiseFrom != nil || energy > 1e-12 { levels.append((offset, energy / Double(n))) }
                }
                let profile: [(Int, Double)]
                if options.noiseFrom != nil {
                    guard !levels.isEmpty else { throw ReelBackend.APIError("The noise profile must contain at least one complete analysis window.") }
                    profile = levels
                } else { profile = try quietestWindows(levels, count: max(1, levels.count / 5)) }
                var noise = [Double](repeating: 0, count: n)
                for (offset, _) in profile {
                    try Task.checkCancellation()
                    let (real, imag) = fft.transform((0..<n).map { Double(padded[offset + $0]) * window[$0] })
                    for k in 0..<n { noise[k] += (real[k] * real[k] + imag[k] * imag[k]) / Double(profile.count) }
                }
                var output = [Double](repeating: 0, count: padded.count), weights = output
                var previousGain = [Double](repeating: 1, count: n)
                for offset in positions {
                    try Task.checkCancellation()
                    var (real, imag) = fft.transform((0..<n).map { Double(padded[offset + $0]) * window[$0] })
                    for k in 0..<n {
                        let power = real[k] * real[k] + imag[k] * imag[k]
                        let target = max(0.02 + 0.08 * options.detail, 1 - 3 * sqrt(noise[k] / max(1e-20, power)))
                        let smoothed = options.quality == "fast" ? target : target * 0.7 + previousGain[k] * 0.3
                        previousGain[k] = smoothed
                        let gain = 1 - options.strength + options.strength * smoothed
                        real[k] *= gain; imag[k] *= gain
                    }
                    let result = fft.inverse(real: real, imag: imag)
                    for i in 0..<n { output[offset + i] += result[i] * window[i]; weights[offset + i] += window[i] * window[i] }
                }
                for i in input.indices { if i % 8192 == 0 { try Task.checkCancellation() }; samples[i] = Float(output[n + i] / max(1e-9, weights[n + i])) }
            }
            if mode == "voice" {
                var hp = Biquad.make("highpass", fs: Double(pcm.rate), frequency: 80)
                var lp = Biquad.make("lowpass", fs: Double(pcm.rate), frequency: min(12000, Double(pcm.rate) * 0.45))
                var reduction = 0.0
                let attack = exp(-1 / (0.01 * Double(pcm.rate))), release = exp(-1 / (0.15 * Double(pcm.rate)))
                for i in samples.indices {
                    if i % 8192 == 0 { try Task.checkCancellation() }
                    let x = lp.next(hp.next(Double(samples[i])))
                    let over = db(abs(x) + 1e-12) + 24
                    let target = over > 0 ? over / 2.5 - over : 0
                    let a = target < reduction ? attack : release
                    reduction = a * reduction + (1 - a) * target
                    samples[i] = Float(x * pow(10, (reduction + 2) / 20))
                }
            }
            channels.append(samples)
        }
        try Task.checkCancellation()
        return PCM(channels: channels, rate: pcm.rate)
    }

    public static func validateSyncMemory(sampleCounts: [Int], rate: Int, limit: UInt64 = NativeAudioMixer.memoryLimitBytes) throws {
        guard (4000...16000).contains(rate), (2...32).contains(sampleCounts.count), sampleCounts.allSatisfy({ $0 >= 0 && $0 <= rate * 600 }) else { throw ReelBackend.APIError("Audio sync supports at most 32 tracks of ten minutes.") }
        let largest = sampleCounts.sorted(by: >).prefix(2).reduce(0, +)
        let fftSize = nextPowerOfTwo(max(2, largest))
        let inputBytes = sampleCounts.reduce(0.0) { $0 + Double($1) * 4 }
        let estimate = (inputBytes + Double(largest) * 8 + Double(fftSize) * 64) * 1.25
        guard estimate <= Double(limit) else { throw ReelBackend.APIError(String(format: "Audio sync needs about %.0f MB; this device's audio budget is %.0f MB. Choose a shorter range, fewer sources or a lower analysis rate.", estimate / 1048576, Double(limit) / 1048576)) }
    }

    public static func sync(_ signals: [[Float]], rate: Int, window: Double) throws -> JSON {
        try Task.checkCancellation()
        guard (4000...16000).contains(rate), window.isFinite, window > 0, window <= 120, signals.count <= 32,
              signals.allSatisfy({ $0.count <= rate * 600 }) else { throw ReelBackend.APIError("Audio sync supports at most 32 tracks of ten minutes and a finite search window.") }
        try validateSyncMemory(sampleCounts: signals.map(\.count), rate: rate)
        guard signals.count >= 2, let reference = signals.firstIndex(where: { $0.count > rate }) else { throw ReelBackend.APIError("At least two sources and one usable audio track are required.") }
        func prepare(_ x: [Float]) throws -> [Double] {
            var sum = 0.0
            for i in x.indices { if i % 8192 == 0 { try Task.checkCancellation() }; sum += Double(x[i]) }
            let mean = sum / Double(max(1, x.count))
            var previous = 0.0
            var prepared = [Double](repeating: 0, count: x.count)
            for i in x.indices {
                if i % 8192 == 0 { try Task.checkCancellation() }
                let next = Double(x[i]) - mean; prepared[i] = next - 0.95 * previous; previous = next
            }
            return prepared
        }
        let a = try prepare(signals[reference])
        var lags = [Double](repeating: 0, count: signals.count), confidence = lags, sharpness = lags
        var inverted = [Bool](repeating: false, count: signals.count), warnings: [String] = []
        for i in signals.indices {
            try Task.checkCancellation()
            if i == reference { confidence[i] = 1; sharpness[i] = 1; continue }
            if signals[i].count <= rate { warnings.append("Source \(i + 1) has no usable audio; check its offset."); continue }
            let b = try prepare(signals[i]), size = nextPowerOfTwo(a.count + b.count)
            let fft = try ComplexFFT(size: size)
            try Task.checkCancellation()
            var (ar, ai) = fft.transform(a), (br, bi) = fft.transform(b)
            for k in 0..<size {
                if k % 8192 == 0 { try Task.checkCancellation() }
                let real = ar[k] * br[k] + ai[k] * bi[k]
                ai[k] = ar[k] * bi[k] - ai[k] * br[k]; ar[k] = real
            }
            let correlation = fft.inverse(real: ar, imag: ai)
            try Task.checkCancellation()
            let maxLag = min(Int(window * Double(rate)), a.count + b.count - 2)
            var best = 0, peak = 0.0
            for lag in -maxLag...maxLag {
                if lag % 8192 == 0 { try Task.checkCancellation() }
                let value = abs(correlation[(lag + size) % size])
                if value > peak { peak = value; best = lag }
            }
            var aa = 0.0, bb = 0.0, ab = 0.0, second = 0.0
            let lo = max(0, -best), hi = min(a.count, b.count - best)
            if hi > lo { for j in lo..<hi { if j % 8192 == 0 { try Task.checkCancellation() }; aa += a[j] * a[j]; bb += b[j + best] * b[j + best]; ab += a[j] * b[j + best] } }
            for lag in -maxLag...maxLag {
                if lag % 8192 == 0 { try Task.checkCancellation() }
                if abs(lag - best) > rate / 20 { second = max(second, abs(correlation[(lag + size) % size])) }
            }
            lags[i] = Double(best) / Double(rate)
            confidence[i] = aa * bb > 0 ? abs(ab) / sqrt(aa * bb) : 0
            sharpness[i] = peak > 0 ? 1 - second / peak : 0
            inverted[i] = ab < 0
            if confidence[i] < 0.2 || sharpness[i] < 0.1 { warnings.append("Source \(i + 1) has an ambiguous audio match; check its offset.") }
        }
        let base = lags[0]; lags = lags.map { $0 - base }
        let minimum = lags.min() ?? 0
        return JSON(any: ["lags": lags, "offsets": lags.map { $0 - minimum }, "confidence": confidence, "sharpness": sharpness, "inverted": inverted, "rate": rate, "window": window, "warnings": warnings])
    }

    static func finite(_ x: Double) -> JSON { x.isFinite ? .number(x) : .null }
    static func db(_ x: Double) -> Double { x > 0 ? 20 * log10(x) : -.infinity }
    static func lufs(_ x: Double) -> Double { x > 0 ? -0.691 + 10 * log10(x) : -.infinity }
    static func nextPowerOfTwo(_ n: Int) -> Int { var size = 2; while size < n { size *= 2 }; return size }

    static func kWeighting(_ fs: Double) -> [Biquad] {
        var k = tan(.pi * 1681.974450955533 / fs)
        let q = 0.7071752369554196, vh = pow(10, 3.999843853973347 / 20), vb = pow(vh, 0.4996667741545416)
        var a = 1 + k / q + k * k
        let shelf = Biquad(b0: (vh + vb * k / q + k * k) / a, b1: 2 * (k * k - vh) / a, b2: (vh - vb * k / q + k * k) / a, a1: 2 * (k * k - 1) / a, a2: (1 - k / q + k * k) / a)
        k = tan(.pi * 38.13547087602444 / fs); a = 1 + k / 0.5003270373238773 + k * k
        return [shelf, Biquad(b0: 1, b1: -2, b2: 1, a1: 2 * (k * k - 1) / a, a2: (1 - k / 0.5003270373238773 + k * k) / a)]
    }

    static let peakPhases: [[Double]] = [
        [0.001708984375,0.010986328125,-0.0196533203125,0.033203125,-0.0594482421875,0.1373291015625,0.97216796875,-0.102294921875,0.047607421875,-0.026611328125,0.014892578125,-0.00830078125],
        [-0.0291748046875,0.029296875,-0.0517578125,0.089111328125,-0.16650390625,0.465087890625,0.77978515625,-0.2003173828125,0.1015625,-0.0582275390625,0.0330810546875,-0.0189208984375],
        [-0.0189208984375,0.0330810546875,-0.0582275390625,0.1015625,-0.2003173828125,0.77978515625,0.465087890625,-0.16650390625,0.089111328125,-0.0517578125,0.029296875,-0.0291748046875],
        [-0.00830078125,0.014892578125,-0.026611328125,0.047607421875,-0.102294921875,0.97216796875,0.1373291015625,-0.0594482421875,0.033203125,-0.0196533203125,0.010986328125,0.001708984375]
    ]
}

struct Biquad {
    var b0: Double, b1: Double, b2: Double, a1: Double, a2: Double
    var z1 = 0.0, z2 = 0.0
    static let identity = Biquad(b0: 1, b1: 0, b2: 0, a1: 0, a2: 0)
    mutating func set(_ filter: Biquad) { b0=filter.b0; b1=filter.b1; b2=filter.b2; a1=filter.a1; a2=filter.a2 }
    static func make(_ type: String, fs: Double, freq: Double, gain: Double = 0, q: Double = 0.7071067811865476) -> Biquad { make(type, fs: fs, frequency: freq, q: q, gain: gain) }
    mutating func next(_ x: Double) -> Double { let y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b2 * x - a2 * y; return y }
    static func make(_ type: String, fs: Double, frequency: Double, q: Double = 0.7071067811865476, gain: Double = 0) -> Biquad {
        let w = 2 * Double.pi * max(10, min(fs * 0.49, frequency)) / fs, c = cos(w), s = sin(w), a = s / (2 * max(0.05, q)), A = pow(10, gain / 40)
        var b0 = 1.0, b1 = 0.0, b2 = 0.0, a0 = 1.0, a1 = 0.0, a2 = 0.0
        switch type {
        case "highpass": b0 = (1+c)/2; b1 = -1-c; b2 = b0; a0 = 1+a; a1 = -2*c; a2 = 1-a
        case "lowpass": b0 = (1-c)/2; b1 = 1-c; b2 = b0; a0 = 1+a; a1 = -2*c; a2 = 1-a
        case "notch": b0 = 1; b1 = -2*c; b2 = 1; a0 = 1+a; a1 = -2*c; a2 = 1-a
        case "peaking": b0 = 1+a*A; b1 = -2*c; b2 = 1-a*A; a0 = 1+a/A; a1 = -2*c; a2 = 1-a/A
        case "lowshelf":
            let d = sqrt(2*A)*s
            b0=A*((A+1)-(A-1)*c+d); b1=2*A*((A-1)-(A+1)*c); b2=A*((A+1)-(A-1)*c-d)
            a0=(A+1)+(A-1)*c+d; a1 = -2*((A-1)+(A+1)*c); a2=(A+1)+(A-1)*c-d
        case "highshelf":
            let d = sqrt(2*A)*s
            b0=A*((A+1)+(A-1)*c+d); b1 = -2*A*((A-1)+(A+1)*c); b2=A*((A+1)+(A-1)*c-d)
            a0=(A+1)-(A-1)*c+d; a1=2*((A-1)-(A+1)*c); a2=(A+1)-(A-1)*c-d
        default: break
        }
        return Biquad(b0:b0/a0,b1:b1/a0,b2:b2/a0,a1:a1/a0,a2:a2/a0)
    }
}

final class ComplexFFT {
    let size: Int
    private let setup: FFTSetupD
    init(size: Int) throws {
        self.size = size
        guard size >= 2, size.nonzeroBitCount == 1, let s = vDSP_create_fftsetupD(vDSP_Length(log2(Double(size))), FFTRadix(kFFTRadix2)) else { throw ReelBackend.APIError("Cannot allocate the audio FFT.") }
        setup = s
    }
    convenience init(_ size: Int) throws { try self.init(size: size) }
    func forward(_ input: [Double]) -> ([Double], [Double]) { transform(input) }
    func inverse(_ real: [Double], _ imag: [Double]) -> [Double] { inverse(real: real, imag: imag) }
    deinit { vDSP_destroy_fftsetupD(setup) }
    func transform(_ input: [Double]) -> ([Double], [Double]) {
        var real = [Double](repeating: 0, count: size), imag = real
        for i in 0..<min(input.count,size) { real[i] = input[i] }
        run(&real,&imag,FFTDirection(FFT_FORWARD))
        return (real,imag)
    }
    func inverse(real: [Double], imag: [Double]) -> [Double] {
        var r = real, i = imag
        run(&r,&i,FFTDirection(FFT_INVERSE))
        return r.map { $0 / Double(size) }
    }
    private func run(_ real: inout [Double], _ imag: inout [Double], _ direction: FFTDirection) {
        real.withUnsafeMutableBufferPointer { r in imag.withUnsafeMutableBufferPointer { i in
            var split = DSPDoubleSplitComplex(realp:r.baseAddress!,imagp:i.baseAddress!)
            vDSP_fft_zipD(setup,&split,1,vDSP_Length(log2(Double(size))),direction)
        } }
    }
}
