import CoreFoundation
import Foundation

/// Preview and delivery automation use absolute time. Reverb kernels update at curve corners and a 250 ms grid.
enum NativeAudioAutomation {
    static let reverbStep = 0.25
    static let limiterTaps = 12
    static let limiterMarginDB = 0.001
    static let limiterScratchBytes = 16_384
    private static let limits: [String: [String: ClosedRange<Double>]] = [
        "limiter": ["ceiling": -24...0, "release": 1...1000, "lookahead": 1...20],
        "reverb": ["size": 0...1, "decay": 0.1...10, "predelay": 0...250, "mix": 0...1]
    ]

    static func validate(effect: [String: Any]) throws {
        if let params = effect["params"], !(params is [String: Any]) {
            throw ReelBackend.APIError("Native audio effect params must be an object.")
        }
        if let curves = effect["curves"], !(curves is [String: Any]) {
            throw ReelBackend.APIError("Native audio effect curves must be an object.")
        }
        let type = effect["type"] as? String ?? "", parameters = effect["params"] as? [String: Any] ?? [:]
        let curves = effect["curves"] as? [String: Any] ?? [:]
        for (key, range) in limits[type] ?? [:] {
            if let raw = parameters[key] {
                guard let value = number(raw), range.contains(value) else {
                    throw ReelBackend.APIError("Native \(type) \(key) must be a finite number between \(range.lowerBound) and \(range.upperBound).")
                }
            }
        }
        for (key, raw) in curves {
            if let supported = limits[type], supported[key] == nil {
                throw ReelBackend.APIError("Native \(type) has no \(key) automation parameter.")
            }
            guard let curve = raw as? [String: Any], let rawValues = curve["values"] as? [Any],
                  !rawValues.isEmpty, rawValues.count <= 180_001,
                  let from = number(curve["from"] ?? 0), abs(from) <= 86_400,
                  let step = number(curve["step"] ?? 0.02), step >= 0.0001, step <= 3600 else {
                throw ReelBackend.APIError("Native audio \(key) automation has invalid timing or samples.")
            }
            for (index, rawValue) in rawValues.enumerated() {
                if index % 8192 == 0 { try Task.checkCancellation() }
                guard let value = number(rawValue), limits[type]?[key]?.contains(value) ?? true else {
                    throw ReelBackend.APIError("Native audio \(key) automation contains an invalid value.")
                }
            }
        }
    }

    private static func number(_ raw: Any) -> Double? {
        guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
        return value.doubleValue
    }

    static func workingBytes(effect: [String: Any], frames: Double, rate: Int) -> Double {
        switch effect["type"] as? String ?? "" {
        case "limiter":
            let ratios = frames + Double(limiterTaps)
            var capacity = 1.0
            while capacity < ratios { capacity *= 2 }
            // Admit both ratio arrays, the gain profile, one tree and the bounded support cache.
            return ratios * 16 + frames * 8 + capacity * 16 + Double(limiterScratchBytes)
        case "reverb":
            let params = effect["params"] as? [String: Any] ?? [:], curves = effect["curves"] as? [String: Any] ?? [:]
            let values = (curves["decay"] as? [String: Any])?["values"] as? [Double] ?? []
            let decay = values.max() ?? (params["decay"] as? NSNumber)?.doubleValue ?? 1.8
            let length = max(64, ceil(Double(rate) * min(12, max(0.1, min(10, decay)) * 1.1 + 0.05)))
            var fft = 1.0
            while fft < max(8192, length * 2) { fft *= 2 }
            // Two stereo kernels, stereo wet output, FFT copies and two segment results.
            let controls = ["size", "decay"].reduce(0) { total, key in
                total + (((curves[key] as? [String: Any])?["values"] as? [Double])?.count ?? 0)
            }
            let anchors = (Double(controls) + ceil(frames / Double(rate) / reverbStep) + 2) * 64
            return length * 16 + frames * 8 + fft * 112 + ceil(Double(rate) * reverbStep + 2) * 8 + anchors
        default: return 0
        }
    }

    struct RangeMaximum {
        private let capacity: Int
        private var tree: [Double]
        init(_ values: [Double]) throws {
            var size = 1
            while size < values.count { size *= 2 }
            capacity = size
            tree = [Double](repeating: 0, count: size * 2)
            for i in values.indices {
                if i % 8192 == 0 { try Task.checkCancellation() }
                tree[size + i] = values[i]
            }
            if size > 1 { for i in stride(from: size - 1, through: 1, by: -1) {
                if i % 8192 == 0 { try Task.checkCancellation() }
                tree[i] = max(tree[i * 2], tree[i * 2 + 1])
            } }
        }
        func maximum(_ range: Range<Int>) -> Double {
            var left = range.lowerBound + capacity, right = range.upperBound + capacity, result = 0.0
            while left < right {
                if left % 2 == 1 { result = max(result, tree[left]); left += 1 }
                if right % 2 == 1 { right -= 1; result = max(result, tree[right]) }
                left /= 2; right /= 2
            }
            return result
        }
    }

    private struct LimiterSupports {
        private let channels: Int
        private let phases: [[Double]]
        private let margin: Double
        private var prefixes: [Double]
        private var ceilings: [Double]
        private var ceilingHistory: [Double]

        init(audio: [[Float]], gains: [Double], phases: [[Double]], margin: Double,
             top: (Int) throws -> Double) throws {
            let taps = NativeAudioAutomation.limiterTaps
            channels = audio.count; self.phases = phases; self.margin = margin
            prefixes = [Double](repeating: 0, count: taps * audio.count * phases.count * (taps + 1))
            ceilings = [Double](repeating: 0, count: taps)
            ceilingHistory = [Double](repeating: try top(0), count: taps)
            for k in 0..<taps { try reset(k, audio: audio, gains: gains, top: top) }
        }

        private func offset(_ slot: Int, _ channel: Int, _ phase: Int) -> Int {
            (slot * channels * phases.count + channel * phases.count + phase) * (NativeAudioAutomation.limiterTaps + 1)
        }

        mutating func reset(_ k: Int, audio: [[Float]], gains: [Double], top: (Int) throws -> Double) throws {
            let taps = NativeAudioAutomation.limiterTaps, slot = k % taps
            ceilingHistory[slot] = try top(k)
            ceilings[slot] = (ceilingHistory.min() ?? 1) / margin
            let channels = self.channels, phases = self.phases, phaseCount = phases.count
            prefixes.withUnsafeMutableBufferPointer { storage in
                let prefix = storage.baseAddress!
                for ch in 0..<channels { for p in phases.indices {
                    let base = (slot * channels * phaseCount + ch * phaseCount + p) * (taps + 1)
                    prefix.advanced(by: base).pointee = 0
                    for j in 0..<taps {
                        let index = k - j
                        let value = index >= 0 && index < gains.count ? Double(audio[ch][index]) * gains[index] : 0
                        prefix.advanced(by: base + j + 1).pointee = prefix.advanced(by: base + j).pointee + phases[p][j] * value
                    }
                } }
            }
        }

        func maximumIncrease(at i: Int, audio: [[Float]], proposed: Double) -> Double {
            guard proposed > 0 else { return 0 }
            let taps = NativeAudioAutomation.limiterTaps
            return prefixes.withUnsafeBufferPointer { storage in
                let prefix = storage.baseAddress!
                var increase = proposed
                for j in 0..<taps { for ch in 0..<channels { for p in phases.indices {
                    let slope = phases[p][j] * Double(audio[ch][i])
                    if slope == 0 { continue }
                    let slot = (i + j) % taps, base = offset(slot, ch, p)
                    var leftMin = prefix.advanced(by: base).pointee, leftMax = prefix.advanced(by: base).pointee
                    for k in 0...j {
                        let value = prefix.advanced(by: base + k).pointee
                        leftMin = min(leftMin, value); leftMax = max(leftMax, value)
                    }
                    var rightMin = prefix.advanced(by: base + j + 1).pointee, rightMax = rightMin
                    for k in (j + 1)...taps {
                        let value = prefix.advanced(by: base + k).pointee
                        rightMin = min(rightMin, value); rightMax = max(rightMax, value)
                    }
                    // These two sums bound every retained contiguous interval containing this sample.
                    let upper = rightMax - leftMin, lower = rightMin - leftMax
                    let allowed = slope > 0 ? (ceilings[slot] - upper) / slope : (-ceilings[slot] - lower) / slope
                    increase = min(increase, max(0, allowed))
                    if increase == 0 { return increase }
                } } }
                return increase
            }
        }

        mutating func increase(at i: Int, audio: [[Float]], by step: Double) {
            let taps = NativeAudioAutomation.limiterTaps
            let channels = self.channels, phases = self.phases, phaseCount = phases.count
            prefixes.withUnsafeMutableBufferPointer { storage in
                let prefix = storage.baseAddress!
                for j in 0..<taps { for ch in 0..<channels { for p in phases.indices {
                    let base = ((i + j) % taps * channels * phaseCount + ch * phaseCount + p) * (taps + 1)
                    let delta = phases[p][j] * Double(audio[ch][i]) * step
                    for k in (j + 1)...taps { prefix.advanced(by: base + k).pointee += delta }
                } } }
            }
        }
    }

    /// Fixed controls can retain unity gain when an upward-rounded support bound proves it.
    /// A signal outside that bound uses the original FIR, envelope and refinement path.
    static func limit(_ audio: inout [[Float]], rate: Int, from: Double,
                      ceiling: Double, lookahead: Double, release: Double,
                      validationCheckpoint: (@Sendable (Int) -> Void)? = nil) throws {
        try Task.checkCancellation()
        // Keep the original empty-input admission and error behavior.
        if audio.first?.isEmpty == true {
            try limit(&audio, rate: rate, from: from, ceiling: { _ in ceiling },
                      lookahead: { _ in lookahead }, release: { _ in release })
            return
        }
        guard lookahead.isFinite, (1...20).contains(lookahead), release.isFinite, (1...1000).contains(release) else {
            throw ReelBackend.APIError("The limiter lookahead or release is outside its supported finite range.")
        }
        let ratio = try constantPeakUpperBound(audio, rate: rate, from: from, ceiling: ceiling,
                                               validationCheckpoint: validationCheckpoint)
        let margin = pow(10, limiterMarginDB / 20)
        if (ratio * margin).nextUp <= 1 {
            // Every original absolute-support ratio times its margin is at most one.
            // Its desired gain and release state therefore remain exactly one.
            try verifyLimited(audio, rate: rate, from: from, ceiling: ceiling)
            return
        }
        try limit(&audio, rate: rate, from: from, ceiling: { _ in ceiling },
                  lookahead: { _ in lookahead }, release: { _ in release })
    }

    /// This bound covers signed FIR sums, contiguous crops and their zero-padded tails.
    /// Each product and sum rounds upward, so accepting it cannot hide a FIR overshoot.
    private static func constantPeakUpperBound(_ audio: [[Float]], rate: Int, from: Double, ceiling: Double,
                                               validationCheckpoint: (@Sendable (Int) -> Void)? = nil) throws -> Double {
        try Task.checkCancellation()
        guard (1...2).contains(audio.count), !audio[0].isEmpty,
              audio.allSatisfy({ $0.count == audio[0].count }), (1...192000).contains(rate), from.isFinite, from >= 0,
              audio[0].count <= 172_800_000, (from + Double(audio[0].count) / Double(rate)).isFinite else {
            throw ReelBackend.APIError("The true-peak verifier needs a bounded, finite, equal-channel signal.")
        }
        guard ceiling.isFinite, (-24...0).contains(ceiling) else {
            throw ReelBackend.APIError("The true-peak verifier received an invalid ceiling.")
        }
        let phases = NativeAudioProcessing.peakPhases
        guard phases.count == 4, phases.allSatisfy({ $0.count == limiterTaps && $0.allSatisfy(\.isFinite) }) else {
            throw ReelBackend.APIError("The true-peak limiter has invalid FIR coefficients.")
        }
        var magnitude = 0.0
        for samples in audio { for i in samples.indices {
            if i % 8192 == 0 { validationCheckpoint?(i); try Task.checkCancellation() }
            let sample = Double(samples[i])
            guard sample.isFinite else { throw ReelBackend.APIError("The limiter input contains a non-finite sample.") }
            magnitude = max(magnitude, abs(sample))
        } }
        var bound = magnitude
        for phase in phases {
            var sum = 0.0
            for coefficient in phase { sum = (sum + (abs(coefficient) * magnitude).nextUp).nextUp }
            bound = max(bound, sum)
        }
        try Task.checkCancellation()
        return (bound / pow(10, ceiling / 20)).nextUp
    }

    /// Verify fixed-ceiling audio with a conservative proof or the original exact FIR scan.
    static func verifyLimited(_ audio: [[Float]], rate: Int, from: Double, ceiling: Double,
                              validationCheckpoint: (@Sendable (Int) -> Void)? = nil) throws {
        let bound = try constantPeakUpperBound(audio, rate: rate, from: from, ceiling: ceiling,
                                              validationCheckpoint: validationCheckpoint)
        if bound <= 1 { try Task.checkCancellation(); return }
        try verifyLimited(audio, rate: rate, from: from, ceiling: { _ in ceiling })
    }

    static func limit(_ audio: inout [[Float]], rate: Int, from: Double,
                      ceiling: (Double) -> Double, lookahead: (Double) -> Double, release: (Double) -> Double,
                      refinementCheckpoint: (@Sendable (Int) -> Void)? = nil) throws {
        try Task.checkCancellation()
        guard (1...2).contains(audio.count), rate > 0, rate <= 192000, from.isFinite, from >= 0,
              audio.allSatisfy({ $0.count == audio[0].count }) else { throw ReelBackend.APIError("The limiter needs equal mono or stereo channels and a finite sample rate and origin.") }
        let count = audio[0].count
        guard count > 0 else { return }
        guard count <= 172_800_000, (from + Double(count) / Double(rate)).isFinite else { throw ReelBackend.APIError("The limiter exceeds its supported sample range.") }
        func time(_ i: Int) -> Double { from + Double(i) / Double(rate) }
        func top(_ i: Int) throws -> Double {
            let value = ceiling(time(max(0, min(count - 1, i))))
            guard value.isFinite, (-24...0).contains(value) else { throw ReelBackend.APIError("The limiter ceiling is outside its supported finite range.") }
            return pow(10, value / 20)
        }
        let phases = NativeAudioProcessing.peakPhases
        guard phases.count == 4, phases.allSatisfy({ $0.count == limiterTaps && $0.allSatisfy(\.isFinite) }) else { throw ReelBackend.APIError("The true-peak limiter has invalid FIR coefficients.") }
        var ratios = [Double](repeating: 0, count: count + limiterTaps)
        var signedRatios = [Double](repeating: 0, count: count + limiterTaps)
        var history = audio.map { _ in [Double](repeating: 0, count: limiterTaps) }
        var ceilings = [Double](repeating: try top(0), count: limiterTaps), position = 0
        for i in ratios.indices {
            if i % 8192 == 0 { try Task.checkCancellation() }
            ceilings[position] = try top(i)
            let minimum = ceilings.min() ?? 1
            var required = 0.0
            var signedRequired = 0.0
            for ch in audio.indices {
                let sample = i < count ? Double(audio[ch][i]) : 0
                guard sample.isFinite else { throw ReelBackend.APIError("The limiter input contains a non-finite sample.") }
                history[ch][position] = sample
                required = max(required, abs(sample) / ceilings[position])
                signedRequired = max(signedRequired, abs(sample) / ceilings[position])
                for phase in phases {
                    var bound = 0.0, prefix = 0.0, low = 0.0, high = 0.0, partial = 0.0
                    for j in 0..<limiterTaps {
                        let term = phase[j] * history[ch][(position - j + limiterTaps) % limiterTaps]
                        bound += abs(term); prefix += term
                        partial = max(partial, max(prefix - low, high - prefix))
                        low = min(low, prefix); high = max(high, prefix)
                    }
                    required = max(required, bound / minimum)
                    signedRequired = max(signedRequired, partial / minimum)
                }
            }
            guard required.isFinite, signedRequired.isFinite else { throw ReelBackend.APIError("The limiter support bound is not finite.") }
            ratios[i] = required
            signedRatios[i] = signedRequired
            position = (position + 1) % limiterTaps
        }
        let margin = pow(10, limiterMarginDB / 20)
        func control(_ i: Int) throws -> (ahead: Int, coefficient: Double) {
            let aheadMS = lookahead(time(i)), releaseMS = release(time(i))
            guard aheadMS.isFinite, (1...20).contains(aheadMS), releaseMS.isFinite, (1...1000).contains(releaseMS) else { throw ReelBackend.APIError("The limiter lookahead or release is outside its supported finite range.") }
            return (max(1, Int((aheadMS / 1000 * Double(rate)).rounded())), exp(-1 / (releaseMS / 1000 * Double(rate))))
        }
        var gains = [Double](repeating: 1, count: count), needsRefinement = false
        do {
            let maximum = try RangeMaximum(ratios)
            var gain = 1.0
            for i in 0..<count {
                if i % 8192 == 0 { try Task.checkCancellation() }
                let controls = try control(i)
                let desired = 1 / max(1, maximum.maximum(i..<min(ratios.count, i + controls.ahead + limiterTaps)) * margin)
                gain = desired < gain ? desired : gain + (desired - gain) * (1 - controls.coefficient)
                gains[i] = gain; needsRefinement = needsRefinement || gain < 1
            }
        }
        if needsRefinement {
            let maximum = try RangeMaximum(signedRatios)
            var supports = try LimiterSupports(audio: audio, gains: gains, phases: phases, margin: margin, top: top)
            var previous = 1.0
            for i in 0..<count {
                if i % 256 == 0 {
                    refinementCheckpoint?(i)
                    try Task.checkCancellation()
                }
                let controls = try control(i)
                let desired = 1 / max(1, maximum.maximum(i..<min(signedRatios.count, i + controls.ahead + limiterTaps)) * margin)
                let released = desired < previous ? desired : previous + (desired - previous) * (1 - controls.coefficient)
                var step = max(0, released - gains[i])
                let sampleTop = try top(i) / margin
                for ch in audio.indices {
                    let magnitude = abs(Double(audio[ch][i]))
                    if magnitude > 0 { step = min(step, max(0, sampleTop / magnitude - gains[i])) }
                }
                step = supports.maximumIncrease(at: i, audio: audio, proposed: step)
                guard step.isFinite else { throw ReelBackend.APIError("The limiter gain refinement is not finite.") }
                gains[i] += step; previous = gains[i]
                if step > 0 { supports.increase(at: i, audio: audio, by: step) }
                if i + 1 < count { try supports.reset(i + limiterTaps, audio: audio, gains: gains, top: top) }
            }
        }
        for i in 0..<count {
            if i % 8192 == 0 { try Task.checkCancellation() }
            for ch in audio.indices { audio[ch][i] = Float(Double(audio[ch][i]) * gains[i]) }
        }
        try verifyLimited(audio, rate: rate, from: from, ceiling: ceiling)
    }

    /// Verification is mandatory in preview and delivery. A violation never adds a global trim.
    static func verifyLimited(_ audio: [[Float]], rate: Int, from: Double, ceiling: (Double) -> Double) throws {
        try Task.checkCancellation()
        guard (1...2).contains(audio.count), !audio[0].isEmpty,
              audio.allSatisfy({ $0.count == audio[0].count }), rate > 0, from.isFinite, from >= 0 else { throw ReelBackend.APIError("The true-peak verifier needs a finite, equal-channel signal.") }
        let ratio = try peakRatio(audio, rate: rate, from: from, ceiling: ceiling)
        guard ratio.isFinite, ratio <= 1.000001 else { throw ReelBackend.APIError("The native true-peak limiter invariant failed. The audio result was discarded.") }
    }

    static func peakRatio(_ audio: [[Float]], rate: Int, from: Double, ceiling: (Double) -> Double) throws -> Double {
        try Task.checkCancellation()
        guard (1...2).contains(audio.count), !audio[0].isEmpty,
              audio.allSatisfy({ $0.count == audio[0].count }), (1...192000).contains(rate), from.isFinite, from >= 0,
              audio[0].count <= 172_800_000, (from + Double(audio[0].count) / Double(rate)).isFinite else {
            throw ReelBackend.APIError("The true-peak verifier needs a bounded, finite, equal-channel signal.")
        }
        let count = audio[0].count
        func top(_ i: Int) throws -> Double {
            let value = ceiling(from + Double(max(0, min(count - 1, i))) / Double(rate))
            guard value.isFinite, (-24...0).contains(value) else { throw ReelBackend.APIError("The true-peak verifier received an invalid ceiling.") }
            return pow(10, value / 20)
        }
        var ratio = 0.0
        for samples in audio {
            var history = [Double](repeating: 0, count: 12), ceilings = [Double](repeating: try top(0), count: 12), position = 0
            for i in 0..<(count + 12) {
                if i % 8192 == 0 { try Task.checkCancellation() }
                let value = i < count ? Double(samples[i]) : 0
                guard value.isFinite else { throw ReelBackend.APIError("The limiter output contains a non-finite sample.") }
                history[position] = value; ceilings[position] = try top(i)
                if i < count { ratio = max(ratio, abs(value) / ceilings[position]) }
                let minimum = ceilings.min() ?? 1
                for phase in NativeAudioProcessing.peakPhases {
                    var peak = 0.0
                    for j in 0..<12 { peak += phase[j] * history[(position - j + 12) % 12] }
                    ratio = max(ratio, abs(peak) / minimum)
                }
                position = (position + 1) % 12
            }
        }
        return ratio
    }

    static func kernelCorners(_ curves: [String: Any]) throws -> [Double] {
        var output: [Double] = []
        for key in ["size", "decay"] {
            guard let curve = curves[key] as? [String: Any], let values = curve["values"] as? [Double], values.count > 1 else { continue }
            let from = (curve["from"] as? NSNumber)?.doubleValue ?? 0, step = (curve["step"] as? NSNumber)?.doubleValue ?? 0.02
            output.append(from); output.append(from + Double(values.count - 1) * step)
            if values.count > 2 { for i in 1..<(values.count - 1) {
                if i % 8192 == 0 { try Task.checkCancellation() }
                let before = values[i] - values[i - 1], after = values[i + 1] - values[i]
                if abs(before - after) > 1e-9 * max(1, max(abs(before), abs(after))) { output.append(from + Double(i) * step) }
            } }
        }
        return output
    }

    static func reverb(_ audio: inout [[Float]], rate: Int, from: Double, changingKernel: Bool, corners: [Double] = [],
                       size: (Double) -> Double, decay: (Double) -> Double, predelay: (Double) -> Double, mix: (Double) -> Double,
                       impulse: (Double, Double) throws -> [[Float]]) throws {
        let count = audio[0].count
        guard count > 0 else { return }
        func kernel(_ time: Double) throws -> [[Float]] {
            var result = try impulse(size(time), decay(time))
            var energy = 0.0
            for channel in result { for i in channel.indices {
                if i % 8192 == 0 { try Task.checkCancellation() }
                energy += Double(channel[i]) * Double(channel[i])
            } }
            energy /= Double(result[0].count * result.count)
            let scale = 0.00125 * 44100 / Double(rate) / max(0.000125, sqrt(energy))
            for ch in result.indices { for i in result[ch].indices {
                if i % 8192 == 0 { try Task.checkCancellation() }
                result[ch][i] *= Float(scale)
            } }
            return result
        }
        var wet = audio.map { [Float](repeating: 0, count: $0.count) }
        if !changingKernel {
            let fixed = try kernel(from)
            for ch in audio.indices { wet[ch] = try convolveRange(audio[ch], fixed[ch], range: 0..<count) }
        } else {
            // Each output segment has complete causal IR history for both bounding kernels.
            // Crossfades use absolute time, so partial render ranges retain the same controls.
            let start = floor(from / reverbStep) * reverbStep, finish = ceil((from + Double(count) / Double(rate)) / reverbStep) * reverbStep
            var times = Set(corners.filter { $0 >= start && $0 <= finish }.map { time in
                let grid = (time / reverbStep).rounded() * reverbStep
                return abs(time - grid) < 1e-9 ? grid : time
            })
            for (index, time) in stride(from: start, through: finish, by: reverbStep).enumerated() {
                if index % 8192 == 0 { try Task.checkCancellation() }
                times.insert(time)
            }
            let anchors = times.sorted()
            var index = anchors.lastIndex(where: { $0 <= from }) ?? 0
            var anchor = anchors[index], left = try kernel(anchors[index])
            var begin = 0
            while begin < count {
                try Task.checkCancellation()
                let sampleTime = from + Double(begin) / Double(rate)
                let previous = index
                while index + 1 < anchors.count && anchors[index + 1] <= sampleTime { index += 1 }
                if index != previous { anchor = anchors[index]; left = try kernel(anchor) }
                let next = anchors[index + 1]
                let end = min(count, max(begin + 1, Int(ceil((next - from) * Double(rate) - 1e-8))))
                let equal = size(anchor) == size(next) && decay(anchor) == decay(next)
                let right = try (equal ? left : kernel(next))
                for ch in audio.indices {
                    let a = try convolveRange(audio[ch], left[ch], range: begin..<end)
                    let b = try (equal ? a : convolveRange(audio[ch], right[ch], range: begin..<end))
                    for i in begin..<end {
                        if i % 8192 == 0 { try Task.checkCancellation() }
                        let fraction = Float(max(0, min(1, (from + Double(i) / Double(rate) - anchor) / (next - anchor))))
                        wet[ch][i] = a[i - begin] * (1 - fraction) + b[i - begin] * fraction
                    }
                }
                begin = end; index += 1; anchor = next; left = right
            }
        }
        for ch in audio.indices { for i in 0..<count {
            if i % 8192 == 0 { try Task.checkCancellation() }
            let time = from + Double(i) / Double(rate), amount = Float(max(0, min(1, mix(time))))
            let read = Double(i) - max(0, min(250, predelay(time))) / 1000 * Double(rate)
            let at = Int(floor(read)), fraction = Float(read - Double(at))
            let delayed = at >= 0 ? wet[ch][at] + (wet[ch][min(count - 1, at + 1)] - wet[ch][at]) * fraction : 0
            audio[ch][i] = audio[ch][i] * (1 - amount) + delayed * amount
        } }
    }

    /// Computes only the requested convolution outputs and the preceding causal input history.
    static func convolveRange(_ signal: [Float], _ impulse: [Float], range: Range<Int>) throws -> [Float] {
        guard !range.isEmpty else { return [] }
        var size = 1
        while size < max(8192, impulse.count * 2) { size *= 2 }
        let fft = try ComplexFFT(size), block = size - impulse.count + 1
        let (hr, hi) = fft.forward(impulse.map(Double.init) + [Double](repeating: 0, count: size - impulse.count))
        var output = [Float](repeating: 0, count: range.count)
        let first = max(0, range.lowerBound - impulse.count + 1), last = min(signal.count, range.upperBound)
        for start in stride(from: first, to: last, by: block) {
            try Task.checkCancellation()
            let length = min(block, last - start)
            let data = signal[start..<(start + length)].map(Double.init) + [Double](repeating: 0, count: size - length)
            var (real, imaginary) = fft.forward(data)
            for i in 0..<size {
                if i % 8192 == 0 { try Task.checkCancellation() }
                let a = real[i], b = imaginary[i]
                real[i] = a * hr[i] - b * hi[i]; imaginary[i] = a * hi[i] + b * hr[i]
            }
            let result = fft.inverse(real, imaginary)
            let begin = max(range.lowerBound, start), end = min(range.upperBound, start + size)
            if begin < end { for i in begin..<end {
                if i % 8192 == 0 { try Task.checkCancellation() }
                output[i - range.lowerBound] += Float(result[i - start])
            } }
        }
        return output
    }
}
