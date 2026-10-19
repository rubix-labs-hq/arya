import AVFoundation
import Foundation
import ReelKit

struct NativeMasterAudioMeterSnapshot: Equatable, Sendable {
    struct Channel: Equatable, Sendable {
        let peakDB: Double
        let rmsDB: Double
        static let silence = Channel(peakDB: -.infinity, rmsDB: -.infinity)
    }
    let left: Channel
    let right: Channel?
    let available: Bool
    static let silence = NativeMasterAudioMeterSnapshot(left: .silence, right: .silence, available: true)
    static let unavailable = NativeMasterAudioMeterSnapshot(left: .silence, right: nil, available: false)
}

struct NativeBusAudioMeterSnapshot: Equatable, Sendable {
    let composition: String?
    let version: Int?
    let requestID: UUID
    let contextID: UUID?
    let meters: [ReelAudioBusMeterKey: NativeMasterAudioMeterSnapshot]
    let available: Bool
}

struct NativeAudioBusMeterTimeline {
    private struct Record {
        let first: Int64, count: Int64, rate: Double
        let composition: String?, version: Int?, requestID: UUID, contextID: UUID?
        let meters: ReelAudioBusMeters
    }
    private var records: [UUID: Record] = [:]
    private var lastPublish: UInt64?
    private static let interval: UInt64 = 66_666_667
    var retainedBins: Int { records.values.reduce(0) { $0 + $1.meters.buses.values.reduce(0) { $0 + $1.count } } }
    var retainedBytes: Int { records.values.reduce(0) { $0 + $1.meters.estimatedBytes } }
    var retainedSegments: Int { records.count }
    mutating func append(_ preview: ReelAudioPreview?, id: UUID, first: Int64, count: Int64, rate: Double, contextID: UUID?) {
        guard let preview else { return }
        guard first >= 0, count > 0, first <= Int64.max - count, rate.isFinite, rate > 0, rate <= 384_000 else { return }
        var meters = preview.meters
        let bins = meters.buses.values.reduce(0) { $0 + $1.count }
        let validTiming = first >= 0 && count > 0 && rate.isFinite && rate > 0 && rate <= 384_000 &&
            count <= Int64(Int.max) && meters.rate == Int(rate) && meters.frameCount == Int(count) &&
            preview.duration.isFinite && preview.offset == 0 && abs(preview.duration - Double(count) / rate) <= 1 / rate
        if !validTiming || preview.version.map({ $0 >= 0 }) != true || !meters.valid || records.count >= 8 ||
            bins > ReelAudioBusMeters.maximumBins - retainedBins || meters.estimatedBytes > ReelAudioBusMeters.maximumBytes - retainedBytes {
            meters = .unavailable(rate: meters.rate, frameCount: 0, reason: "Scheduled track envelopes are unavailable or exceed the playback budget.")
        }
        records[id] = Record(first: first, count: count, rate: rate, composition: preview.composition, version: preview.version,
                             requestID: preview.requestID, contextID: contextID, meters: meters)
    }
    mutating func remove(_ id: UUID) { records[id] = nil }
    mutating func clear() { records = [:]; lastPublish = nil }
    mutating func sample(at sampleTime: Int64, rate: Double, contextID: UUID?, now: UInt64 = DispatchTime.now().uptimeNanoseconds) -> NativeBusAudioMeterSnapshot? {
        guard sampleTime >= 0, rate.isFinite, rate > 0,
              lastPublish == nil || now >= lastPublish! && now - lastPublish! >= Self.interval else { return nil }
        let position = Double(sampleTime) / rate
        guard let record = records.values.filter({ record in
            guard record.contextID == contextID else { return false }
            if rate == record.rate { return sampleTime >= record.first && sampleTime <= record.first + record.count }
            return position >= Double(record.first) / record.rate && position <= Double(record.first + record.count) / record.rate
        }).max(by: { $0.first < $1.first }) else { return nil }
        lastPublish = now
        var values: [ReelAudioBusMeterKey: NativeMasterAudioMeterSnapshot] = [:]
        if record.meters.available {
            let relative = rate == record.rate ? Int(sampleTime - record.first) : Int((position * record.rate - Double(record.first)).rounded(.down))
            let played = min(record.meters.frameCount, max(0, relative))
            let completed = played == record.meters.frameCount ? (played - 1) / record.meters.binFrames : played / record.meters.binFrames - 1
            for (track, bins) in record.meters.buses {
                let key = ReelAudioBusMeterKey(composition: record.composition, trackID: track)
                guard completed >= 0, bins.indices.contains(completed) else { values[key] = .silence; continue }
                let bin = bins[completed]
                func channel(_ peak: Double, _ power: Double) -> NativeMasterAudioMeterSnapshot.Channel {
                    .init(peakDB: peak > 0 ? 20 * log10(peak) : -.infinity, rmsDB: power > 0 ? 10 * log10(power / Double(bin.frameCount)) : -.infinity)
                }
                values[key] = .init(left: channel(bin.leftPeak, bin.leftSumSquares), right: channel(bin.rightPeak, bin.rightSumSquares), available: true)
            }
        }
        return .init(composition: record.composition, version: record.version, requestID: record.requestID, contextID: contextID, meters: values, available: record.meters.available)
    }
}

final class NativeMasterAudioMeterAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var generation = UUID()
    private var pending = false
    private var lastPublish: UInt64 = 0
    private var frames = 0
    private var channels = 0
    private var leftPeak = 0.0, rightPeak = 0.0
    private var leftPower = 0.0, rightPower = 0.0
    private var valid = true
    private static let interval: UInt64 = 66_666_667
    private static let maximumFrames = 65_536

    func reset(_ token: UUID) {
        lock.lock(); defer { lock.unlock() }
        generation = token; pending = false; lastPublish = 0; clearWindow()
    }
    func didPublish(_ token: UUID) {
        lock.lock(); defer { lock.unlock() }
        if generation == token { pending = false }
    }
    func ingest(_ buffer: AVAudioPCMBuffer, token: UUID, now: UInt64 = DispatchTime.now().uptimeNanoseconds) -> NativeMasterAudioMeterSnapshot? {
        lock.lock(); defer { lock.unlock() }
        guard generation == token else { return nil }
        let count = Int(buffer.frameLength), channelCount = Int(buffer.format.channelCount)
        guard count > 0 else { return nil }
        if frames + count > Self.maximumFrames || channels != channelCount { clearWindow() }
        channels = channelCount
        if count > 16_384 || !(1...2).contains(channelCount) || buffer.format.commonFormat != .pcmFormatFloat32 || buffer.floatChannelData == nil {
            valid = false
        } else if let data = buffer.floatChannelData {
            let interleaved = buffer.format.isInterleaved
            let left = data[0], right = channelCount == 2 ? (interleaved ? data[0] : data[1]) : data[0]
            for frame in 0..<count {
                let a = Double(left[interleaved ? frame * channelCount : frame])
                let b = channelCount == 2 ? Double(right[interleaved ? frame * channelCount + 1 : frame]) : 0
                if !a.isFinite || !b.isFinite { valid = false; continue }
                leftPeak = max(leftPeak, abs(a)); leftPower += a * a
                if channelCount == 2 { rightPeak = max(rightPeak, abs(b)); rightPower += b * b }
            }
            frames += count
        }
        guard !pending, lastPublish == 0 || now >= lastPublish && now - lastPublish >= Self.interval else { return nil }
        let snapshot: NativeMasterAudioMeterSnapshot
        if valid, frames > 0 {
            func channel(_ peak: Double, _ power: Double) -> NativeMasterAudioMeterSnapshot.Channel {
                .init(peakDB: peak > 0 ? 20 * log10(peak) : -.infinity, rmsDB: power > 0 ? 10 * log10(power / Double(frames)) : -.infinity)
            }
            snapshot = .init(left: channel(leftPeak, leftPower), right: channels == 2 ? channel(rightPeak, rightPower) : nil, available: true)
        } else { snapshot = .unavailable }
        pending = true; lastPublish = now; clearWindow()
        return snapshot
    }
    private func clearWindow() {
        frames = 0; channels = 0; leftPeak = 0; rightPeak = 0; leftPower = 0; rightPower = 0; valid = true
    }
}

@MainActor
final class NativePlaybackAudio {
    private let engine: AVAudioEngine
    private let player = AVAudioPlayerNode()
    private struct Segment { let file: AVAudioFile; let url: URL; let folder: ProjectFolder? }
    private var segments: [UUID: Segment] = [:]
    private var generation = UUID()
    private let meter = NativeMasterAudioMeterAccumulator()
    private var meterInstalled = false
    private var contextID: UUID?
    private var busMeterTimeline = NativeAudioBusMeterTimeline()
    private var scheduledFrames: Int64 = 0
    var onMeter: ((NativeMasterAudioMeterSnapshot, UUID?) -> Void)?
    private var scheduled = 0
    private var consumed = 0
    private(set) var start: Double = 0
    private(set) var end: Double = 0
    private(set) var completedSegments = 0
    var time: Double? {
        guard let rendered = player.lastRenderTime, rendered.isSampleTimeValid || rendered.isHostTimeValid,
              let clock = player.playerTime(forNodeTime: rendered), clock.isSampleTimeValid, clock.sampleTime >= 0, clock.sampleRate.isFinite, clock.sampleRate > 0 else { return nil }
        return min(end, start + Double(clock.sampleTime) / clock.sampleRate)
    }
    var finished: Bool { scheduled > 0 && consumed == scheduled }
    var busMeters: NativeBusAudioMeterSnapshot? {
        guard player.isPlaying, let rendered = player.lastRenderTime, rendered.isSampleTimeValid || rendered.isHostTimeValid,
              let clock = player.playerTime(forNodeTime: rendered), clock.isSampleTimeValid else { return nil }
        return busMeterTimeline.sample(at: clock.sampleTime, rate: clock.sampleRate, contextID: contextID)
    }

    init(engine: AVAudioEngine = AVAudioEngine()) { self.engine = engine; engine.attach(player) }
    func load(_ preview: ReelAudioPreview, start: Double, end: Double, ownedIn folder: ProjectFolder? = nil, contextID: UUID? = nil) throws {
        try load(preview.url, start: start, end: end, offset: preview.offset, ownedIn: folder, contextID: contextID, meterPreview: preview)
    }
    func load(_ url: URL, start: Double, end: Double, offset: Double = 0, ownedIn folder: ProjectFolder? = nil, contextID: UUID? = nil, meterPreview: ReelAudioPreview? = nil) throws {
        stop()
        self.contextID = contextID
        do {
            #if os(iOS)
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try AVAudioSession.sharedInstance().setActive(true)
            #endif
            let file = try AVAudioFile(forReading: url)
            engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)
            self.start = start; self.end = start
            try schedule(file, url: url, start: start, end: end, offset: offset, folder: folder, preview: meterPreview)
            installMeter()
            engine.prepare()
        } catch { stop(); throw error }
    }
    func queue(_ preview: ReelAudioPreview, start: Double, end: Double, ownedIn folder: ProjectFolder? = nil) throws {
        try queue(preview.url, start: start, end: end, offset: preview.offset, ownedIn: folder, meterPreview: preview)
    }
    func queue(_ url: URL, start: Double, end: Double, offset: Double = 0, ownedIn folder: ProjectFolder? = nil, meterPreview: ReelAudioPreview? = nil) throws {
        guard abs(start - self.end) < 0.001 else { throw failure("The queued audio preview is not contiguous.") }
        let file = try AVAudioFile(forReading: url)
        guard file.processingFormat.sampleRate == player.outputFormat(forBus: 0).sampleRate,
              file.processingFormat.channelCount == player.outputFormat(forBus: 0).channelCount else { throw failure("The queued audio preview changed its audio format.") }
        try schedule(file, url: url, start: start, end: end, offset: offset, folder: folder, preview: meterPreview)
    }
    private func schedule(_ file: AVAudioFile, url: URL, start: Double, end: Double, offset: Double, folder: ProjectFolder?, preview: ReelAudioPreview?) throws {
        let offsetFrames = (offset * file.processingFormat.sampleRate).rounded()
        let requestedFrames = ((end - start) * file.processingFormat.sampleRate).rounded()
        guard start.isFinite, end.isFinite, offset.isFinite, offset >= 0, end > start,
              offsetFrames.isFinite, offsetFrames >= 0, offsetFrames < Double(file.length), offsetFrames < Double(Int64.max),
              requestedFrames.isFinite, requestedFrames >= 1, requestedFrames <= Double(UInt32.max) else { throw failure("The audio preview range is invalid.") }
        let firstFrame = AVAudioFramePosition(offsetFrames), requested = AVAudioFramePosition(requestedFrames)
        let remaining = file.length - firstFrame
        guard requestedFrames <= Double(remaining) + 1 else { throw failure("The audio preview is shorter than its requested range.") }
        let count = min(remaining, requested)
        let id = UUID(), token = generation
        guard scheduledFrames <= Int64.max - count else { throw failure("The audio preview sample clock overflowed.") }
        busMeterTimeline.append(preview, id: id, first: scheduledFrames, count: count, rate: file.processingFormat.sampleRate, contextID: contextID)
        scheduledFrames += count
        segments[id] = Segment(file: file, url: url, folder: folder); scheduled += 1; self.end = end
        player.scheduleSegment(file, startingFrame: firstFrame, frameCount: AVAudioFrameCount(count), at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.generation == token else { return }
                self.consumed += 1; self.completedSegments += 1
                self.busMeterTimeline.remove(id)
                if let segment = self.segments.removeValue(forKey: id) { Self.removeOwned(segment.url, folder: segment.folder) }
            }
        }
    }
    private func installMeter() {
        let token = generation, origin = contextID, meter = self.meter
        meter.reset(token)
        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
            guard let snapshot = meter.ingest(buffer, token: token) else { return }
            Task { @MainActor [weak self] in
                defer { meter.didPublish(token) }
                guard let self, self.generation == token, self.contextID == origin else { return }
                self.onMeter?(snapshot, origin)
            }
        }
        meterInstalled = true
    }
    func play() throws {
        do { try engine.start(); player.play() }
        catch { stop(); throw error }
    }
    func stop() {
        let origin = contextID
        generation = UUID(); meter.reset(generation); player.stop(); engine.stop()
        if meterInstalled { engine.mainMixerNode.removeTap(onBus: 0); meterInstalled = false }
        onMeter?(.silence, origin); contextID = nil
        for segment in segments.values { Self.removeOwned(segment.url, folder: segment.folder) }
        segments.removeAll(); scheduled = 0; consumed = 0
        busMeterTimeline.clear(); scheduledFrames = 0
    }
    static func removeOwned(_ url: URL, folder: ProjectFolder?) {
        guard let folder, url.deletingLastPathComponent().standardizedFileURL == folder.cacheDir.standardizedFileURL,
              url.pathExtension == "wav", url.deletingPathExtension().lastPathComponent.hasPrefix("mix-"),
              UUID(uuidString: String(url.deletingPathExtension().lastPathComponent.dropFirst(4))) != nil,
              let safe = try? folder.output(url.path) else { return }
        try? FileManager.default.removeItem(at: safe)
    }
    private func failure(_ message: String) -> NSError { NSError(domain: "Reel", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
