import CryptoKit
import Darwin
import Foundation

/// Retain a bounded forward crop, never a rendered origin prefix or a caller's WAV.
/// Cold fills use the unchanged origin DSP. Native decoder and crop parity are release gates.
enum NativeAudioPreviewReuse {
    static let store = Store()
    static let revision = "origin-forward-crop-1"
    static let maximumSources = 16
    static let maximumSourceBytes: UInt64 = 64 * 1024 * 1024
    static let maximumPlanBytes = 512 * 1024
    static let maximumEntryBytes: UInt64 = 64 * 1024 * 1024
    static let maximumRetainedBytes = min(maximumEntryBytes, NativeAudioMixer.memoryLimitBytes / 8)

    struct Identity: Equatable, Sendable {
        let owner: UUID, generation: UUID
        let version: Int
        let composition: String?
        let projectDigest: String, snapshotDigest: String, diskDigest: String
        let root: String, rootIdentity: String, parentIdentity: String
        let revision: String
    }
    struct SourceIdentity: Equatable, Sendable {
        let source: NativeAudioMixCapture.Source
        let digest: String
    }
    struct Leaf: Equatable, Sendable {
        let id: String, source: String
        let from: Double, to: Double, sourceIn: Double, speed: Double, gain: Double, pan: Double
        func ending(at end: Double) -> Self {
            .init(id: id, source: source, from: from, to: min(to, end), sourceIn: sourceIn, speed: speed, gain: gain, pan: pan)
        }
    }
    struct Bus: Equatable, Sendable {
        let id: String
        let gain: Double, pan: Double
        let items: [Leaf]
    }
    struct Profile: Sendable {
        let end: Double, gain: Double, ceiling: Double, release: Double, lookahead: Double
        let buses: [Bus]
        let planBytes: Int
        var origins: [String: Double] {
            var result: [String: Double] = [:]
            for item in buses.flatMap(\.items) { result[item.source] = min(result[item.source] ?? item.sourceIn, item.sourceIn) }
            return result
        }
        /// Compare exact leaf controls and lifetimes over the shorter plan's entire DSP support.
        func containsPrefix(_ shorter: Profile) -> Bool {
            guard end >= shorter.end, gain == shorter.gain, ceiling == shorter.ceiling,
                  release == shorter.release, lookahead == shorter.lookahead else { return false }
            let prefix = buses.compactMap { bus -> Bus? in
                let items = bus.items.filter { $0.from < shorter.end }.map { $0.ending(at: shorter.end) }
                return items.isEmpty ? nil : .init(id: bus.id, gain: bus.gain, pan: bus.pan, items: items)
            }
            guard prefix == shorter.buses else { return false }
            // Extending a reader backwards changes its converter/codec origin.
            let extendedOrigins = origins
            return shorter.origins.allSatisfy { extendedOrigins[$0.key] == $0.value }
        }
        func retentionBytes(frames: Int, sources: [NativeAudioMixCapture.Source]) -> UInt64? {
            guard frames > 0, frames <= 4_320_000,
                  let meters = ReelAudioBusMeters.storageBytes(tracks: buses.map(\.id), bins: (frames - 1) / 2400 + 1) else { return nil }
            let strings = buses.reduce(0) { sum, bus in sum + bus.id.utf8.count + bus.items.reduce(0) { $0 + $1.id.utf8.count + $1.source.utf8.count + 256 } }
                + sources.reduce(0) { $0 + $1.alias.utf8.count + $1.path.utf8.count + 256 }
            // Include allocation slack, immutable metadata, hash buffers and parsed plan copies.
            let bytes = UInt64(frames) * 16 + UInt64(meters) * 2 + UInt64(strings + planBytes) * 8 + 128 * 1024
            return bytes <= NativeAudioPreviewReuse.maximumEntryBytes ? bytes : nil
        }
    }

    static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func directoryIdentity(_ url: URL) throws -> String {
        var value = Darwin.stat()
        guard url.path.withCString({ Darwin.lstat($0, &value) }) == 0, value.st_mode & S_IFMT == S_IFDIR else {
            throw ReelBackend.APIError("The audio preview folder changed identity.")
        }
        return "\(value.st_dev)|\(value.st_ino)"
    }
    static func exactSamples(from: Double, to: Double, window: NativeAudioRenderRange) -> Range<Int>? {
        guard window.begin == 0 else { return nil }
        func onGrid(_ seconds: Double, _ sample: Int) -> Bool {
            let value = seconds * 48000
            return value.isFinite && abs(value - Double(sample)) <= min(0.000001, max(value.ulp, Double(sample).ulp) * 4)
        }
        guard onGrid(from, window.cropStart), onGrid(to, window.samples.upperBound) else { return nil }
        return window.samples
    }
    static func scopeIsStatic(_ scope: [String: Any]) -> Bool {
        for track in scope["tracks"] as? [[String: Any]] ?? [] {
            for clip in track["clips"] as? [[String: Any]] ?? [] {
                // Visual-only compositions do not enter the audio plan. profile() rejects
                // composition items when they actually carry audio.
                for key in ["fadeIn", "fadeOut"] { if ((clip[key] as? NSNumber)?.doubleValue ?? 0) != 0 { return false } }
                for key in ["anim", "expr"] {
                    let fields = clip[key] as? [String: Any] ?? [:]
                    if fields["volume"] != nil || fields["pan"] != nil { return false }
                }
            }
        }
        return true
    }
    static func profile(_ plan: String) throws -> Profile? {
        try Task.checkCancellation()
        guard plan.utf8.count <= maximumPlanBytes,
              let graph = try JSON.parse(plan) as? [String: Any], graph["from"] as? Double == 0,
              graph["rate"] as? Int == 48000, let end = graph["to"] as? Double, end.isFinite, end > 0,
              let master = graph["master"] as? [String: Any], (master["chain"] as? [[String: Any]] ?? []).isEmpty,
              let gain = master["gain"] as? Double, gain.isFinite,
              let limiter = master["limiter"] as? [String: Any], limiter["type"] as? String == "limiter",
              (limiter["curves"] as? [String: Any] ?? [:]).isEmpty,
              let params = limiter["params"] as? [String: Any], let ceiling = params["ceiling"] as? Double,
              let release = params["release"] as? Double, let lookahead = params["lookahead"] as? Double,
              ceiling.isFinite, (-24...0).contains(ceiling), release.isFinite, (1...1000).contains(release),
              lookahead.isFinite, (1...20).contains(lookahead) else { return nil }
        func constant(_ value: Any?) -> Double? {
            guard let curve = value as? [String: Any], let values = curve["values"] as? [Double],
                  values.count == 1, values[0].isFinite else { return nil }
            return values[0]
        }
        var buses: [Bus] = [], totalItems = 0
        for bus in graph["buses"] as? [[String: Any]] ?? [] {
            try Task.checkCancellation()
            guard let id = bus["id"] as? String, !id.isEmpty, id.utf8.count <= 1024,
                  (bus["chain"] as? [[String: Any]] ?? []).isEmpty,
                  let gain = bus["gain"] as? Double, gain.isFinite, let pan = bus["pan"] as? Double, pan.isFinite else { return nil }
            var items: [Leaf] = []
            for item in bus["items"] as? [[String: Any]] ?? [] {
                totalItems += 1
                guard totalItems <= 256, item["kind"] as? String == "leaf", item["buses"] == nil,
                      (item["chain"] as? [[String: Any]] ?? []).isEmpty,
                      let id = item["id"] as? String, id.utf8.count <= 1024,
                      let source = item["src"] as? String, !source.isEmpty, source.utf8.count <= 4096,
                      let from = item["from"] as? Double, let to = item["to"] as? Double,
                      let sourceIn = item["sourceIn"] as? Double, let speed = item["speed"] as? Double,
                      [from, to, sourceIn, speed].allSatisfy(\.isFinite), from >= 0, to > from, to <= end, sourceIn >= 0, speed > 0,
                      let gain = constant(item["gain"]), let pan = constant(item["pan"]) else { return nil }
                items.append(.init(id: id, source: source, from: from, to: to, sourceIn: sourceIn, speed: speed, gain: gain, pan: pan))
            }
            buses.append(.init(id: id, gain: gain, pan: pan, items: items))
        }
        guard buses.count <= 256, Set(buses.map(\.id)).count == buses.count else { return nil }
        return .init(end: end, gain: gain, ceiling: ceiling, release: release, lookahead: lookahead, buses: buses, planBytes: plan.utf8.count)
    }
    static func sourceIdentities(_ sources: [NativeAudioMixCapture.Source], folder: ProjectFolder,
                                 afterDescriptorValidation: (@Sendable () throws -> Void)? = nil) throws -> [SourceIdentity] {
        try sources.map { source in
            try Task.checkCancellation()
            return .init(source: source, digest: try NativeAudioMixCapture.stream(source: source, folder: folder, maximumBytes: maximumSourceBytes,
                                                                               afterDescriptorValidation: afterDescriptorValidation))
        }
    }
    static func canHashSources(_ sources: [NativeAudioMixCapture.Source]) -> Bool {
        guard sources.count <= maximumSources else { return false }
        var bytes: UInt64 = 0
        for source in sources {
            guard source.stamp.bytes >= 0 else { return false }
            let added = bytes.addingReportingOverflow(UInt64(source.stamp.bytes))
            guard !added.overflow, added.partialValue <= maximumSourceBytes else { return false }
            bytes = added.partialValue
        }
        return true
    }
    static func freshSources(_ identities: [SourceIdentity], folder: ProjectFolder) throws -> [NativeAudioMixCapture.Source] {
        try identities.map { identity in
            try Task.checkCancellation()
            let alias = identity.source.alias, path = try folder.resolve(alias).path
            return .init(alias: alias, path: path, stamp: try NativeAudioMixCapture.fileStamp(path))
        }
    }

    final class Credit: @unchecked Sendable {
        let bytes: UInt64
        private let pool: Pool
        fileprivate init(_ bytes: UInt64, pool: Pool) { self.bytes = bytes; self.pool = pool }
        deinit { pool.release(bytes) }
    }
    fileprivate final class Pool: @unchecked Sendable {
        let limit: UInt64
        private let lock = NSLock()
        private var used: UInt64 = 0
        init(_ limit: UInt64) { self.limit = limit }
        var reserved: UInt64 { lock.lock(); defer { lock.unlock() }; return used }
        func reserve(_ bytes: UInt64) -> Credit? {
            lock.lock(); defer { lock.unlock() }
            guard bytes > 0, bytes <= limit, used <= limit - bytes else { return nil }
            used += bytes; return Credit(bytes, pool: self)
        }
        func release(_ bytes: UInt64) { lock.lock(); used -= bytes; lock.unlock() }
    }
    final class Entry: @unchecked Sendable {
        let identity: Identity, sources: [SourceIdentity], profile: Profile
        let samples: Range<Int>, pcm: NativeAudioProcessing.PCM, meters: ReelAudioBusMeters
        let credit: Credit
        init(identity: Identity, sources: [SourceIdentity], profile: Profile, samples: Range<Int>,
             pcm: NativeAudioProcessing.PCM, meters: ReelAudioBusMeters, credit: Credit) {
            self.identity = identity; self.sources = sources; self.profile = profile; self.samples = samples
            self.pcm = pcm; self.meters = meters; self.credit = credit
        }
        func canSlice(_ requested: Range<Int>) -> Bool {
            guard !requested.isEmpty, requested.lowerBound >= samples.lowerBound, requested.upperBound <= samples.upperBound,
                  meters.valid, meters.frameCount == samples.count, meters.rate == 48000,
                  pcm.rate == 48000, pcm.channels.count == 2, pcm.channels.allSatisfy({ $0.count == samples.count }) else { return false }
            return (requested.lowerBound - samples.lowerBound) % meters.binFrames == 0 &&
                ((requested.upperBound - samples.lowerBound) % meters.binFrames == 0 || requested.upperBound == samples.upperBound)
        }
        func slice(_ requested: Range<Int>) throws -> (NativeAudioProcessing.PCM, ReelAudioBusMeters) {
            try Task.checkCancellation()
            guard canSlice(requested) else { throw ReelBackend.APIError("The retained audio has no exact meter slice for this range.") }
            let local = requested.lowerBound - samples.lowerBound..<requested.upperBound - samples.lowerBound
            let selected = try NativeAudioRenderRange.trim(pcm, samples: local)
            try NativeAudioAutomation.verifyLimited(selected.channels, rate: selected.rate, from: Double(requested.lowerBound) / 48000, ceiling: profile.ceiling)
            let a = local.lowerBound / meters.binFrames, b = (local.upperBound - 1) / meters.binFrames + 1
            var buses: [String: [ReelAudioMeterBin]] = [:]
            for (id, bins) in meters.buses { try Task.checkCancellation(); buses[id] = Array(bins[a..<b]) }
            let selectedMeters = ReelAudioBusMeters(rate: meters.rate, frameCount: requested.count, binFrames: meters.binFrames, buses: buses, available: true)
            guard selectedMeters.valid else { throw ReelBackend.APIError("The retained audio meter crop is invalid.") }
            return (selected, selectedMeters)
        }
    }
    final class Store: @unchecked Sendable {
        private struct Slot { let entry: Entry; var nextFrame: Int }
        private let lock = NSLock(), pool: Pool
        private let maximumEntries: Int
        private var epoch = UUID()
        private var slots: [UUID: Slot] = [:]
        init(limit: UInt64 = NativeAudioPreviewReuse.maximumRetainedBytes, maximumEntries: Int = 8) {
            precondition(limit > 0 && maximumEntries > 0)
            pool = Pool(limit); self.maximumEntries = maximumEntries
        }
        var reservedBytes: UInt64 { pool.reserved }
        var entryCount: Int { lock.lock(); defer { lock.unlock() }; return slots.count }
        func reserve(_ bytes: UInt64) -> Credit? { pool.reserve(bytes) }
        func publicationToken() -> UUID { lock.lock(); defer { lock.unlock() }; return epoch }
        func discard(owner: UUID) {
            lock.lock(); let removed = slots.removeValue(forKey: owner); epoch = UUID(); lock.unlock()
            withExtendedLifetime(removed) {}
        }
        func evictBeforeOtherProcessing() {
            lock.lock(); let removed = slots; slots.removeAll(keepingCapacity: false); epoch = UUID(); lock.unlock()
            withExtendedLifetime(removed) {}
        }
        func borrow(identity: Identity, samples: Range<Int>, profile: Profile) -> Entry? {
            lock.lock(); defer { lock.unlock() }
            guard let slot = slots[identity.owner], slot.entry.identity == identity, slot.nextFrame == samples.lowerBound,
                  slot.entry.profile.containsPrefix(profile), slot.entry.canSlice(samples) else { return nil }
            return slot.entry
        }
        @discardableResult func publish(_ entry: Entry, nextFrame: Int, token: UUID) -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard token == epoch, entry.canSlice(entry.samples), nextFrame >= entry.samples.lowerBound, nextFrame < entry.samples.upperBound,
                  slots[entry.identity.owner] != nil || slots.count < maximumEntries else { return false }
            slots[entry.identity.owner] = Slot(entry: entry, nextFrame: nextFrame)
            return true
        }
        func consumed(_ entry: Entry, through end: Int) {
            lock.lock()
            var removed: Slot?
            if var slot = slots[entry.identity.owner], slot.entry === entry {
                // The one frame retained for support rounding has no next full-bin
                // request. Drop it after the nominal block is consumed.
                if end >= entry.samples.upperBound - 1 { removed = slots.removeValue(forKey: entry.identity.owner) }
                else { slot.nextFrame = end; slots[entry.identity.owner] = slot }
            }
            lock.unlock(); withExtendedLifetime(removed) {}
        }
    }
}
