import Foundation

public struct ReelAudioBusMeterKey: Hashable, Sendable {
    public let composition: String?
    public let trackID: String
    public init(composition: String?, trackID: String) { self.composition = composition; self.trackID = trackID }
}

public struct ReelAudioMeterBin: Equatable, Sendable {
    public let frameCount: Int
    public let leftPeak: Double, rightPeak: Double
    public let leftSumSquares: Double, rightSumSquares: Double
    public init(frameCount: Int, leftPeak: Double, rightPeak: Double, leftSumSquares: Double, rightSumSquares: Double) {
        self.frameCount = frameCount; self.leftPeak = leftPeak; self.rightPeak = rightPeak
        self.leftSumSquares = leftSumSquares; self.rightSumSquares = rightSumSquares
    }
    static func silence(_ count: Int) -> Self { .init(frameCount: count, leftPeak: 0, rightPeak: 0, leftSumSquares: 0, rightSumSquares: 0) }
    var valid: Bool { frameCount > 0 && [leftPeak, rightPeak, leftSumSquares, rightSumSquares].allSatisfy { $0.isFinite && $0 >= 0 } }
}

public struct ReelAudioBusMeters: Equatable, Sendable {
    public static let maximumBins = 65_536
    public static let maximumTracks = 256
    public static let maximumBytes = 4 * 1024 * 1024
    public let rate: Int, frameCount: Int, binFrames: Int
    public let buses: [String: [ReelAudioMeterBin]]
    public let available: Bool
    public let unavailableReason: String?
    public init(rate: Int, frameCount: Int, binFrames: Int, buses: [String: [ReelAudioMeterBin]], available: Bool, unavailableReason: String? = nil) {
        self.rate = rate; self.frameCount = frameCount; self.binFrames = binFrames; self.buses = buses
        self.available = available; self.unavailableReason = unavailableReason
    }
    public static func unavailable(rate: Int, frameCount: Int, reason: String) -> Self {
        .init(rate: rate, frameCount: frameCount, binFrames: max(1, rate / 20), buses: [:], available: false, unavailableReason: reason)
    }
    static func storageBytes(tracks: [String], bins: Int) -> Int? {
        guard bins >= 0, tracks.count <= maximumTracks, Set(tracks).count == tracks.count,
              tracks.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 }),
              bins == 0 || tracks.count <= maximumBins / bins else { return nil }
        let bytes = tracks.count * bins * MemoryLayout<ReelAudioMeterBin>.stride + tracks.reduce(0) { $0 + $1.utf8.count + 128 }
        return bytes <= maximumBytes ? bytes : nil
    }
    public var estimatedBytes: Int {
        guard available, frameCount > 0, binFrames > 0 else { return 0 }
        return Self.storageBytes(tracks: Array(buses.keys), bins: (frameCount - 1) / binFrames + 1) ?? 0
    }
    public var valid: Bool {
        guard available, rate > 0, frameCount > 0, binFrames == max(1, rate / 20) else { return false }
        let count = (frameCount - 1) / binFrames + 1
        guard Self.storageBytes(tracks: Array(buses.keys), bins: count) != nil else { return false }
        return buses.values.allSatisfy { bins in
            bins.count == count && bins.enumerated().allSatisfy { index, bin in
                bin.valid && bin.frameCount == min(binFrames, frameCount - index * binFrames)
            }
        }
    }
    public func includingSilence(trackIDs: [String]) -> Self {
        guard valid else { return Self.unavailable(rate: rate, frameCount: frameCount, reason: unavailableReason ?? "Track meter data is invalid.") }
        let tracks = Array(Set(trackIDs).union(buses.keys)), count = (frameCount - 1) / binFrames + 1
        guard Self.storageBytes(tracks: tracks, bins: count) != nil else { return Self.unavailable(rate: rate, frameCount: frameCount, reason: "Track meters exceed the bounded envelope budget.") }
        var filled = buses
        for id in tracks where filled[id] == nil { filled[id] = (0..<count).map { .silence(min(binFrames, frameCount - $0 * binFrames)) } }
        return .init(rate: rate, frameCount: frameCount, binFrames: binFrames, buses: filled, available: true)
    }
}

public struct ReelAudioPreview: Sendable {
    public let url: URL
    public let offset: Double
    public let duration: Double
    public let historySeconds: Double
    public let residualDB: Double
    public let composition: String?
    public let version: Int?
    public let requestID: UUID
    public let meters: ReelAudioBusMeters
    public init(url: URL, offset: Double, duration: Double, historySeconds: Double, residualDB: Double,
                composition: String? = nil, version: Int? = nil, requestID: UUID = UUID(), meters: ReelAudioBusMeters? = nil) {
        self.url = url; self.offset = offset; self.duration = duration; self.historySeconds = historySeconds; self.residualDB = residualDB
        self.composition = composition; self.version = version; self.requestID = requestID
        self.meters = meters ?? .unavailable(rate: 48000, frameCount: 0, reason: "This preview has no track envelopes.")
    }
}

extension NativeAudioMixer {
    struct History { let seconds: Double, future: Double, requiresOrigin: Bool }

    /// Bounds recursive effect tails and static filter settling. Animated filters restart at origin.
    static func previewHistory(plan: JSON) throws -> History {
        let graph = try JSON.parse(plan.text) as? [String: Any] ?? [:], rate = (graph["rate"] as? NSNumber)?.doubleValue ?? 48000
        var origin = false, future = 0.0, controlFuture = 0.0
        func controls(_ value: Any?) {
            guard let curve = value as? [String: Any], let values = curve["values"] as? [Double], !values.isEmpty else { return }
            // A one-value overview may be an animated clip shorter than one control step.
            controlFuture = 0.02
            if values.count > 1 { origin = true }
        }
        func filter(_ type: String, _ frequency: Double, _ gain: Double = 0, _ q: Double = 0.70710678) throws -> Double {
            let b = Biquad.make(type, fs: rate, freq: frequency, gain: gain, q: q)
            let discriminant = b.a1*b.a1-4*b.a2
            let radius = discriminant < 0 ? sqrt(abs(b.a2)) : max(abs((-b.a1+sqrt(discriminant))/2),abs((-b.a1-sqrt(discriminant))/2))
            guard radius.isFinite, radius < 1 else { throw ReelBackend.APIError("The audio filter does not have a finite settling time.") }
            if radius <= 0 { return 0 }
            return ceil(log(1e-8)/log(radius))/rate
        }
        func chain(_ list: [[String: Any]]) throws -> Double {
            var history = 0.0
            for fx in list {
                let p = fx["params"] as? [String: Any] ?? [:], curves = fx["curves"] as? [String: Any] ?? [:], type = fx["type"] as? String ?? ""
                if !curves.isEmpty { origin = true; controlFuture = 0.02 }
                func v(_ key: String, _ fallback: Double) -> Double { (p[key] as? NSNumber)?.doubleValue ?? fallback }
                func maximum(_ key: String, _ fallback: Double) -> Double {
                    let values = (curves[key] as? [String: Any])?["values"] as? [Double] ?? []
                    return values.max() ?? v(key, fallback)
                }
                switch type {
                case "eq":
                    for band in p["bands"] as? [[String: Any]] ?? [] { history += try filter(band["type"] as? String ?? "peaking",(band["freq"] as? NSNumber)?.doubleValue ?? 1000,(band["gain"] as? NSNumber)?.doubleValue ?? 0,(band["q"] as? NSNumber)?.doubleValue ?? 0.70710678) }
                case "compressor": history += max(v("attack",10),v("release",150))/1000*18
                case "deesser": history += max(v("attack",1),v("release",60))/1000*18 + (try filter("highpass",v("lo",4000))) + (try filter("lowpass",v("hi",9000)))
                case "gate":
                    // A level within the hysteresis band can retain the open state indefinitely.
                    origin = true
                case "limiter":
                    // Preserve the exact release state and all preceding FIR input supports.
                    origin = true
                    history += max(1,min(1000,maximum("release",60)))/1000*18
                    // The overview can end before a curve rises inside the lookahead window.
                    let lookahead = curves["lookahead"] != nil ? 20 : maximum("lookahead",5)
                    // Refinement reads future base gains, each of which has its own FIR support.
                    future += max(1,min(20,lookahead))/1000+24/rate
                case "delay":
                    let time = max(1/rate,min(2.5,v("time",350)/1000)), feedback=max(0,min(0.95,v("feedback",0.35)))
                    let repeats = feedback > 0 ? ceil(log(1e-8*(1-feedback))/log(feedback))+2 : 1
                    history += time*repeats
                case "reverb":
                    history += min(12,max(0.1,min(10,maximum("decay",1.8)))*1.1+0.05)+max(0,min(250,maximum("predelay",20)))/1000
                    if curves["size"] != nil || curves["decay"] != nil {
                        // The next absolute kernel anchor also receives controlFuture below.
                        future += NativeAudioAutomation.reverbStep
                    }
                default: break
                }
            }
            guard history.isFinite, history >= 0 else { throw ReelBackend.APIError("The audio graph has invalid preview timing.") }
            return history
        }
        func buses(_ list: [[String: Any]]) throws -> Double {
            var longest = 0.0
            for bus in list {
                controls(bus["gain"]); controls(bus["pan"])
                var input = 0.0
                for item in bus["items"] as? [[String: Any]] ?? [] {
                    controls(item["gain"]); controls(item["pan"])
                    input = max(input, try chain(item["chain"] as? [[String: Any]] ?? []) + buses(item["buses"] as? [[String: Any]] ?? []))
                }
                longest = max(longest,input + (try chain(bus["chain"] as? [[String: Any]] ?? [])))
            }
            return longest
        }
        let master = graph["master"] as? [String: Any] ?? [:]
        var seconds = try buses(graph["buses"] as? [[String: Any]] ?? []) + chain(master["chain"] as? [[String: Any]] ?? [])
        if let limiter = master["limiter"] as? [String: Any] { seconds += try chain([limiter]) }
        return .init(seconds: seconds+0.05, future: future+controlFuture+0.002, requiresOrigin: origin)
    }
}
