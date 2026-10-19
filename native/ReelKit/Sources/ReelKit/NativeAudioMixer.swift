import Foundation

/// Offline rendering of the shared core's audio plan, using stereo Float32 PCM.
public enum NativeAudioMixer {
    public static var memoryLimitBytes: UInt64 {
        #if os(iOS)
        return max(128 * 1024 * 1024, min(512 * 1024 * 1024, ProcessInfo.processInfo.physicalMemory / 8))
        #else
        return max(512 * 1024 * 1024, min(4 * 1024 * 1024 * 1024, ProcessInfo.processInfo.physicalMemory / 4))
        #endif
    }

    public static func validate(plan: JSON, limit: UInt64 = memoryLimitBytes, additionalBytes: UInt64 = 0) throws {
        let estimate = try estimatedMemoryBytes(plan: plan, additionalBytes: additionalBytes)
        guard estimate <= limit else { throw ReelBackend.APIError(String(format: "This audio mix needs about %.0f MB; this device's native audio budget is %.0f MB. Export a shorter range or fewer simultaneous audio layers.", Double(estimate) / 1048576, Double(limit) / 1048576)) }
    }

    /// Rendering and concurrent mix reservations use the same curve-aware estimate.
    static func estimatedMemoryBytes(plan: JSON, additionalBytes: UInt64 = 0) throws -> UInt64 {
        let graph=(try JSON.parse(plan.text) as? [String:Any]) ?? [:]
        let from=graph["from"] as? Double ?? 0,to=graph["to"] as? Double ?? 0,rate=graph["rate"] as? Int ?? 48000
        guard from.isFinite,to.isFinite,to>from,(8000...192000).contains(rate),to-from<=3600,ceil((to-from)*Double(rate))<=172_800_000 else { throw ReelBackend.APIError("The native offline audio range must be non-empty and under one hour.") }
        try validateAutomation(graph)
        var ranges:[String:(Double,Double)]=[:],depth=0,effectBytes=0.0
        let frames = ceil((to-from)*Double(rate))
        func effects(_ list:[[String:Any]]) {
            for effect in list { effectBytes = max(effectBytes, NativeAudioAutomation.workingBytes(effect: effect, frames: frames, rate: rate)) }
        }
        func walk(_ buses:[[String:Any]],level:Int) throws {
            guard buses.isEmpty || level <= 16 else { throw ReelBackend.APIError("The audio graph exceeds the supported composition depth.") }
            depth=max(depth,level)
            for bus in buses { effects(bus["chain"] as? [[String:Any]] ?? []); for item in bus["items"] as? [[String:Any]] ?? [] {
                effects(item["chain"] as? [[String:Any]] ?? [])
                if let src=item["src"] as? String { let a=max(0,item["sourceIn"] as? Double ?? 0),b=a+max(0,(item["to"] as? Double ?? to)-(item["from"] as? Double ?? from))*(item["speed"] as? Double ?? 1)+2/Double(rate),old=ranges[src]; ranges[src]=(min(old?.0 ?? a,a),max(old?.1 ?? b,b)) }
                try walk(item["buses"] as? [[String:Any]] ?? [],level:level+1)
            } }
        }
        try walk(graph["buses"] as? [[String:Any]] ?? [],level:0)
        let master = graph["master"] as? [String:Any] ?? [:]
        effects(master["chain"] as? [[String:Any]] ?? [])
        if let limiter = master["limiter"] as? [String:Any] { effects([limiter]) }
        let sourceFrames=ranges.values.reduce(0.0) { $0+($1.1-$1.0)*Double(rate) }
        let estimate=(frames*Double(5+2*depth)*8+sourceFrames*8+effectBytes)*1.25 + Double(additionalBytes)
        guard estimate.isFinite, estimate >= 0, estimate < Double(UInt64.max) else { throw ReelBackend.APIError("The audio working set exceeds its supported size.") }
        return UInt64(ceil(estimate))
    }

    /// Validate bounded effect curves before decoding sources or allocating DSP buffers.
    static func validateAutomation(_ graph: [String: Any]) throws {
        func chain(_ effects: [[String: Any]]) throws {
            for effect in effects { try NativeAudioAutomation.validate(effect: effect) }
        }
        func buses(_ list: [[String: Any]]) throws {
            for bus in list {
                try chain(bus["chain"] as? [[String: Any]] ?? [])
                for item in bus["items"] as? [[String: Any]] ?? [] {
                    try chain(item["chain"] as? [[String: Any]] ?? [])
                    try buses(item["buses"] as? [[String: Any]] ?? [])
                }
            }
        }
        try buses(graph["buses"] as? [[String: Any]] ?? [])
        let master = graph["master"] as? [String: Any] ?? [:]
        try chain(master["chain"] as? [[String: Any]] ?? [])
        if let limiter = master["limiter"] as? [String: Any] { try chain([limiter]) }
    }

    /// The preview flag keeps existing call sites compatible; both paths use verified DSP.
    public static func render(plan: JSON, folder: ProjectFolder, preview _: Bool = false) async throws -> NativeAudioProcessing.PCM {
        try await renderResult(plan: plan, folder: folder, meterRange: nil).pcm
    }

    public struct RenderWithMetersResult: Sendable {
        public let pcm: NativeAudioProcessing.PCM
        public let meters: ReelAudioBusMeters
        public var metersAvailable: Bool { meters.available }
    }

    public static func renderWithMeters(plan: JSON, folder: ProjectFolder, preview _: Bool = false, meterRange: Range<Int>) async throws -> RenderWithMetersResult {
        try await renderResult(plan: plan, folder: folder, meterRange: meterRange)
    }

    private static func renderResult(plan: JSON, folder: ProjectFolder, meterRange: Range<Int>?) async throws -> RenderWithMetersResult {
        try Task.checkCancellation()
        try validate(plan: plan)
        guard let graph = try JSON.parse(plan.text) as? [String: Any], let from = graph["from"] as? Double, let to = graph["to"] as? Double, to > from else { throw ReelBackend.APIError("The audio plan has no range.") }
        let rate = graph["rate"] as? Int ?? 48000
        let count = Int(ceil((to-from)*Double(rate)))
        guard count > 0, count <= 172_800_000 else { throw ReelBackend.APIError("The offline audio mix range must be under one hour.") }
        var sources: [String: NativeAudioProcessing.PCM] = [:]
        func collect(_ buses: [[String: Any]], into out: inout [String: (Double, Double)]) {
            for bus in buses { for item in bus["items"] as? [[String: Any]] ?? [] {
                if let src = item["src"] as? String {
                    let begin=max(0,item["sourceIn"] as? Double ?? 0), speed=item["speed"] as? Double ?? 1, span=max(0,(item["to"] as? Double ?? to)-(item["from"] as? Double ?? from))
                    let end=begin+span*speed+2/Double(rate), old=out[src]
                    out[src]=(min(old?.0 ?? begin,begin),max(old?.1 ?? end,end))
                }
                collect(item["buses"] as? [[String: Any]] ?? [],into:&out)
            } }
        }
        let buses = graph["buses"] as? [[String: Any]] ?? []
        let meterBudget = meterRange != nil && (try? validate(plan: plan, additionalBytes: UInt64(ReelAudioBusMeters.maximumBytes))) != nil
        var ranges:[String:(Double,Double)]=[:]
        collect(buses,into:&ranges)
        for (src,range) in ranges {
            let audio = try await NativeAudioProcessing.decode(folder.resolve(src), rate: rate, from: range.0, duration: range.1-range.0)
            sources[src] = audio
        }
        let decoded = sources
        let processing = Task.detached {
            try Task.checkCancellation()
            let collector = AudioBusMeterCollector(tracks: buses.map { $0["id"] as? String ?? "" }, count: count, rate: rate, range: meterRange, budget: meterBudget)
            let context = MixContext(from: from, count: count, rate: rate, sources: decoded, sourceOffsets: ranges.mapValues { $0.0 })
            var mixed = try context.buses(buses, meters: collector)
            let master = graph["master"] as? [String: Any] ?? [:]
            try context.effects(&mixed, master["chain"] as? [[String: Any]] ?? [])
            context.volumePan(&mixed, gain: master["gain"] as? Double ?? 1, pan: 0)
            if let limiter = master["limiter"] as? [String: Any] { try context.effects(&mixed, [limiter]) }
            try Task.checkCancellation()
            return RenderWithMetersResult(pcm: NativeAudioProcessing.PCM(channels: mixed, rate: rate), meters: collector.result)
        }
        return try await withTaskCancellationHandler { try await processing.value } onCancel: { processing.cancel() }
    }
}

private final class AudioBusMeterCollector {
    private let rate: Int, range: Range<Int>, binFrames: Int
    private var reason: String?
    private var captured: [String: [ReelAudioMeterBin]] = [:]
    init(tracks: [String], count: Int, rate: Int, range: Range<Int>?, budget: Bool) {
        let validRange = range.flatMap { $0.lowerBound >= 0 && $0.upperBound <= count && !$0.isEmpty ? $0 : nil }
        self.rate = rate; self.range = validRange ?? 0..<0; binFrames = max(1, rate / 20)
        guard let range = validRange else { reason = "The preview has no valid meter slice."; return }
        guard budget else { reason = "Track meter allocation exceeds the audio render budget."; return }
        let bins = (range.count - 1) / binFrames + 1
        guard ReelAudioBusMeters.storageBytes(tracks: tracks, bins: bins) != nil else { reason = "Track meters exceed the bounded envelope budget."; return }
    }
    func capture(_ signal: [[Float]], trackID: String) throws {
        guard reason == nil else { return }
        guard signal.count == 2, signal.allSatisfy({ $0.count >= range.upperBound }) else { reason = "Track meter PCM has an unsupported format."; captured = [:]; return }
        var bins: [ReelAudioMeterBin] = []; bins.reserveCapacity((range.count - 1) / binFrames + 1)
        var begin = range.lowerBound
        while begin < range.upperBound {
            try Task.checkCancellation()
            let end = min(range.upperBound, begin + binFrames)
            var leftPeak = 0.0, rightPeak = 0.0, leftPower = 0.0, rightPower = 0.0
            for i in begin..<end {
                let l = Double(signal[0][i]), r = Double(signal[1][i])
                guard l.isFinite, r.isFinite else { reason = "Track meter PCM contains non-finite samples."; captured = [:]; return }
                leftPeak = max(leftPeak, abs(l)); rightPeak = max(rightPeak, abs(r)); leftPower += l * l; rightPower += r * r
            }
            bins.append(.init(frameCount: end - begin, leftPeak: leftPeak, rightPeak: rightPeak, leftSumSquares: leftPower, rightSumSquares: rightPower))
            begin = end
        }
        captured[trackID] = bins
    }
    var result: ReelAudioBusMeters {
        if let reason { return .unavailable(rate: rate, frameCount: range.count, reason: reason) }
        return .init(rate: rate, frameCount: range.count, binFrames: binFrames, buses: captured, available: true)
    }
}

private struct MixCurve {
    let from: Double, step: Double, values: [Double]
    let constant: Double?
    init(_ value: Any?, fallback: Double) {
        let data = value as? [String: Any] ?? [:]
        from = data["from"] as? Double ?? 0
        step = max(0.0001, data["step"] as? Double ?? 0.02)
        values = data["values"] as? [Double] ?? [fallback]
        if let first = values.first, first.isFinite, values.allSatisfy({ $0 == first }) {
            // Match interpolation's signed-zero result without repeating it for each sample.
            constant = first + (first - first) * 0
        } else { constant = values.isEmpty ? 0 : nil }
    }
    func at(_ time: Double) -> Double {
        if let constant { return constant }
        guard !values.isEmpty else { return 0 }
        let p = max(0, min(Double(values.count-1), (time-from)/step))
        let i = Int(p), f = p-Double(i)
        return values[i] + (values[min(values.count-1,i+1)]-values[i])*f
    }
}

private struct MixContext {
    let from: Double, count: Int, rate: Int, sources: [String: NativeAudioProcessing.PCM]
    let sourceOffsets: [String: Double]
    func zero() -> [[Float]] { [[Float](repeating: 0, count: count), [Float](repeating: 0, count: count)] }
    func time(_ i: Int) -> Double { from + Double(i)/Double(rate) }

    func buses(_ input: [[String: Any]], meters: AudioBusMeterCollector? = nil) throws -> [[Float]] {
        var output = zero()
        for bus in input {
            try Task.checkCancellation()
            var sum = zero()
            for item in bus["items"] as? [[String: Any]] ?? [] {
                var signal: [[Float]]
                if item["kind"] as? String == "comp" { signal = try buses(item["buses"] as? [[String: Any]] ?? []) }
                else {
                    signal = zero()
                    guard let src = item["src"] as? String, let source = sources[src] else { continue }
                    let start = item["from"] as? Double ?? from, end = item["to"] as? Double ?? from
                    let sourceIn = item["sourceIn"] as? Double ?? 0, speed = item["speed"] as? Double ?? 1
                    let a = max(0, Int(ceil((start-from)*Double(rate)))), b = min(count, Int(ceil((end-from)*Double(rate))))
                    if b > a { for i in a..<b {
                        if i % 8192 == 0 { try Task.checkCancellation() }
                        let p = (sourceIn - (sourceOffsets[src] ?? 0) + (time(i)-start)*speed)*Double(rate), k = Int(floor(p)), f = Float(p-Double(k))
                        guard k >= 0, k < source.count else { continue }
                        for ch in 0..<2 { let data = source.channels[min(ch,source.channels.count-1)]; signal[ch][i] = data[k] + (data[min(k+1,data.count-1)]-data[k])*f }
                    } }
                }
                try effects(&signal, item["chain"] as? [[String: Any]] ?? [])
                let gain = MixCurve(item["gain"], fallback: 1), pan = MixCurve(item["pan"], fallback: 0)
                for i in 0..<count { applyPan(&signal, i, gain.at(time(i)), pan.at(time(i))) }
                for ch in 0..<2 { for i in 0..<count { sum[ch][i] += signal[ch][i] } }
            }
            try effects(&sum, bus["chain"] as? [[String: Any]] ?? [])
            volumePan(&sum, gain: bus["gain"] as? Double ?? 1, pan: bus["pan"] as? Double ?? 0)
            try meters?.capture(sum, trackID: bus["id"] as? String ?? "")
            for ch in 0..<2 { for i in 0..<count { output[ch][i] += sum[ch][i] } }
        }
        return output
    }

    func volumePan(_ audio: inout [[Float]], gain: Double, pan: Double) { for i in 0..<count { applyPan(&audio,i,gain,pan) } }
    func applyPan(_ audio: inout [[Float]], _ i: Int, _ gain: Double, _ position: Double) {
        let pan = max(-1,min(1,position)), l = Double(audio[0][i]), r = Double(audio[1][i])
        // StereoPannerNode preserves both inputs at center, then folds the opposite input.
        if pan <= 0 { let a = (pan+1)*Double.pi/2; audio[0][i] = Float((l+r*cos(a))*gain); audio[1][i] = Float(r*sin(a)*gain) }
        else { let a = pan*Double.pi/2; audio[0][i] = Float(l*cos(a)*gain); audio[1][i] = Float((r+l*sin(a))*gain) }
    }

    func effects(_ audio: inout [[Float]], _ chain: [[String: Any]]) throws {
        for fx in chain {
            try Task.checkCancellation()
            let type = fx["type"] as? String ?? "", p = fx["params"] as? [String: Any] ?? [:], curves = fx["curves"] as? [String: Any] ?? [:]
            let sampled = curves.mapValues { MixCurve($0, fallback: 0) }
            func at(_ key: String, _ time: Double, _ fallback: Double) -> Double {
                sampled[key]?.at(time) ?? (p[key] as? NSNumber)?.doubleValue ?? fallback
            }
            func value(_ key: String, _ i: Int, _ fallback: Double) -> Double { at(key, time(i), fallback) }
            switch type {
            case "gain": for i in 0..<count { let g = Float(pow(10,value("gain",i,0)/20)); audio[0][i] *= g; audio[1][i] *= g }
            case "eq":
                for (index, band) in (p["bands"] as? [[String: Any]] ?? []).enumerated() {
                    var filters = [Biquad.identity, Biquad.identity]
                    for i in 0..<count {
                        if i % 128 == 0 {
                            let prefix = "bands.\(index)."
                            func bval(_ key: String,_ fallback: Double) -> Double { MixCurve(curves[prefix+key],fallback:(band[key] as? NSNumber)?.doubleValue ?? fallback).at(time(i)) }
                            let next = Biquad.make(band["type"] as? String ?? "peaking",fs:Double(rate),freq:bval("freq",1000),gain:bval("gain",0),q:bval("q",0.70710678))
                            for ch in 0..<2 { filters[ch].set(next) }
                        }
                        for ch in 0..<2 { audio[ch][i] = Float(filters[ch].next(Double(audio[ch][i]))) }
                    }
                }
            case "compressor", "deesser", "gate":
                var reduction = 0.0, envelope = 0.0, opened = false, hold = 0, gateDB = value("range",0,-60)
                var hp = (0..<2).map { _ in Biquad.make("highpass",fs:Double(rate),freq:value("lo",0,4000)) }
                var lp = (0..<2).map { _ in Biquad.make("lowpass",fs:Double(rate),freq:value("hi",0,9000)) }
                for i in 0..<count {
                    if i % 8192 == 0 { try Task.checkCancellation() }
                    if type == "deesser", i % 128 == 0 {
                        let highpass = Biquad.make("highpass", fs: Double(rate), freq: value("lo", i, 4000))
                        let lowpass = Biquad.make("lowpass", fs: Double(rate), freq: value("hi", i, 9000))
                        for ch in 0..<2 { hp[ch].set(highpass); lp[ch].set(lowpass) }
                    }
                    var level = max(abs(Double(audio[0][i])),abs(Double(audio[1][i])))
                    if type == "deesser" { level = max(abs(lp[0].next(hp[0].next(Double(audio[0][i])))),abs(lp[1].next(hp[1].next(Double(audio[1][i]))))) }
                    let threshold = value("threshold",i,type == "gate" ? -45 : type == "deesser" ? -30 : -18)
                    let attack = max(0.1,value("attack",i,type == "compressor" ? 10 : 1)), release = max(1,value("release",i,type == "deesser" ? 60 : 150))
                    var g: Double
                    if type == "gate" {
                        let range = -abs(value("range",i,-60))
                        envelope = level > envelope ? level : envelope*exp(-1/(0.01*Double(rate)))
                        if envelope >= pow(10,threshold/20) { opened = true; hold = Int(value("hold",i,50)/1000*Double(rate)) }
                        else if envelope < pow(10,(threshold-4)/20) { if hold > 0 { hold -= 1 } else { opened = false } }
                        let target = opened ? 0 : range, span = max(1,-range)
                        gateDB = gateDB < target ? min(target,gateDB+span/(attack/1000*Double(rate))) : max(target,gateDB-span/(release/1000*Double(rate)))
                        g = pow(10,gateDB/20)
                    } else {
                        let ratio = max(1,value("ratio",i,type == "deesser" ? 4 : 3)), knee = max(0,type == "deesser" ? 2 : value("knee",i,6)), over = 20*log10(level+1e-12)-threshold
                        var target = over > 0 ? over/ratio-over : 0
                        if knee > 0, 2*abs(over) <= knee { target = (1/ratio-1)*pow(over+knee/2,2)/(2*knee) }
                        if type == "deesser" { target = max(-abs(value("range",i,12)),target) }
                        let a = exp(-1/((target < reduction ? attack : release)/1000*Double(rate)))
                        reduction = a*reduction+(1-a)*target
                        g = pow(10,(reduction+(type == "deesser" ? 0 : value("makeup",i,0)))/20)
                    }
                    audio[0][i] *= Float(g); audio[1][i] *= Float(g)
                }
            case "limiter":
                if curves.isEmpty {
                    try NativeAudioAutomation.limit(&audio, rate: rate, from: from,
                        ceiling: at("ceiling", from, -1), lookahead: at("lookahead", from, 5), release: at("release", from, 60))
                } else {
                    try NativeAudioAutomation.limit(&audio, rate: rate, from: from,
                        ceiling: { at("ceiling", $0, -1) }, lookahead: { at("lookahead", $0, 5) }, release: { at("release", $0, 60) })
                }
            case "delay":
                var history = zero()
                for i in 0..<count {
                    if i % 8192 == 0 { try Task.checkCancellation() }
                    let delay = max(1,min(Double(rate)*2.5,value("time",i,350)/1000*Double(rate))), read = Double(i)-delay
                    let k = Int(floor(read)), f = Float(read-Double(k)), feedback = Float(max(0,min(0.95,value("feedback",i,0.35)))), mix = Float(max(0,min(1,value("mix",i,0.25))))
                    for ch in 0..<2 {
                        let wet: Float = k >= 0 ? history[ch][k] + (history[ch][min(i,k+1)]-history[ch][k])*f : 0
                        history[ch][i] = audio[ch][i]+wet*feedback
                        audio[ch][i] = audio[ch][i]*(1-mix)+wet*mix
                    }
                }
            case "reverb":
                let changingKernel = ["size", "decay"].contains { key in
                    guard let curve = sampled[key], let first = curve.values.first else { return false }
                    return curve.values.contains { $0 != first }
                }
                let corners = try (changingKernel ? NativeAudioAutomation.kernelCorners(curves) : [])
                try NativeAudioAutomation.reverb(&audio, rate: rate, from: from, changingKernel: changingKernel, corners: corners,
                    size: { at("size", $0, 0.5) }, decay: { at("decay", $0, 1.8) },
                    predelay: { at("predelay", $0, 20) }, mix: { at("mix", $0, 0.2) }, impulse: impulse)
            default: throw ReelBackend.APIError("Unknown audio effect \(type).")
            }
        }
    }

    func impulse(size: Double, decay: Double) throws -> [[Float]] {
        let d=max(0.1,min(10,decay)), sz=max(0,min(1,size)), length=max(64,Int((Double(rate)*min(12,d*1.1+0.05)).rounded()))
        var out=[[Float](repeating:0,count:length),[Float](repeating:0,count:length)], seed:UInt32=1
        func random()->Double { seed=seed &+ 0x6d2b79f5; var t=seed; t=(t ^ (t>>15)) &* (t|1); t ^= t &+ ((t ^ (t>>7)) &* (t|61)); return Double(t ^ (t>>14))/4294967296 }
        let k=log(1000)/d, taps=Int((6+sz*12).rounded())
        for i in 0..<taps { for ch in 0..<2 { let t=0.004+random()*(0.012+0.08*sz), at=min(length-1,Int((t*Double(rate)).rounded())); out[ch][at]+=Float((0.7-0.5*Double(i)/Double(taps))*(random()<0.5 ? -1:1)*exp(-k*t)) } }
        let build=0.004+sz*0.05; var lp=[0.0,0.0]
        for i in 0..<length { if i % 8192 == 0 { try Task.checkCancellation() }; let t=Double(i)/Double(rate), env=exp(-k*t)*min(1,t/build), a=1-min(0.92,(0.15+0.85*(t/d))*0.9); for ch in 0..<2 { lp[ch]+=a*(random()*2-1-lp[ch]); out[ch][i]+=Float(lp[ch]*env*0.5) } }
        return out
    }

}
