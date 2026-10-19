import Foundation

/// The DSP window includes history and future. Only the requested samples leave this window.
struct NativeAudioRenderRange: Sendable {
    enum Rounding: Sendable, Equatable { case playback, delivery }
    let begin: Double, end: Double, historySeconds: Double
    let cropStart: Int, cropCount: Int
    let rate = 48000
    var samples: Range<Int> { cropStart..<cropStart + cropCount }
    var cropBytes: UInt64 { UInt64(cropCount) * 2 * UInt64(MemoryLayout<Float>.stride) }

    init(from: Double, to: Double, history: NativeAudioMixer.History, rounding: Rounding) throws {
        let rate = 48000.0
        guard from.isFinite, from >= 0, to.isFinite, to > from, to - from <= 3600,
              history.seconds.isFinite, history.seconds >= 0, history.future.isFinite, history.future >= 0 else {
            throw ReelBackend.APIError("Choose a finite, non-empty audio range under one hour with finite effect history.")
        }
        begin = history.requiresOrigin ? 0 : floor(max(0, from - history.seconds) * rate) / rate
        end = ceil((to + history.future) * rate) / rate
        historySeconds = from - begin
        let span = ceil((end - begin) * rate)
        let start = ((from - begin) * rate).rounded()
        let count = rounding == .playback ? ((to - from) * rate).rounded() : ceil((to - from) * rate)
        guard begin.isFinite, end.isFinite, end > begin, end - begin <= 3600,
              span <= 172_800_000, start >= 0, count > 0, start + count <= span,
              let checkedStart = Int(exactly: start), let checkedCount = Int(exactly: count) else {
            throw ReelBackend.APIError("The requested audio and its effect history exceed the supported render window. Choose a shorter range.")
        }
        cropStart = checkedStart; cropCount = checkedCount
    }

    func trim(_ pcm: NativeAudioProcessing.PCM) throws -> NativeAudioProcessing.PCM {
        try Self.trim(pcm, samples: samples)
    }

    static func trim(_ pcm: NativeAudioProcessing.PCM, samples: Range<Int>) throws -> NativeAudioProcessing.PCM {
        try Task.checkCancellation()
        guard samples.lowerBound >= 0, !samples.isEmpty, pcm.rate == 48000, pcm.channels.count == 2,
              pcm.channels.allSatisfy({ $0.count >= samples.upperBound }) else {
            throw ReelBackend.APIError("The prepared audio returned an invalid sample range.")
        }
        let cropCount = samples.count
        var channels: [[Float]] = []
        for input in pcm.channels {
            var output: [Float] = []; output.reserveCapacity(cropCount)
            for offset in stride(from: samples.lowerBound, to: samples.upperBound, by: 8192) {
                try Task.checkCancellation()
                output.append(contentsOf: input[offset..<min(samples.upperBound, offset + 8192)])
            }
            channels.append(output)
        }
        try Task.checkCancellation()
        return .init(channels: channels, rate: pcm.rate)
    }
}
