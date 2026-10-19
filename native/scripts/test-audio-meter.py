#!/usr/bin/env python3
"""Check production master metering through offline AVAudioEngine playback."""
from pathlib import Path
import argparse
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--reelkit-build', type=Path, default=root / 'native/ReelKit/.build/debug')
args = parser.parse_args()
products = args.reelkit_build.resolve()
objects = sorted((products / 'ReelKit.build').glob('*.o'))
module_dir = products / 'Modules'
link = list(map(str, objects))
if link: link += list(map(str, sorted((products / 'NativeProjectIO.build').glob('*.o'))))
if (products / 'libReelKit.a').exists():
    module_dir = products
    link = ['-L', str(products), '-lReelKit']
if not link or not (module_dir / 'ReelKit.swiftmodule').exists():
    raise SystemExit('Build or test native/ReelKit first, then pass its debug products directory with --reelkit-build.')
model = (root / 'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()
start = model.index('        playbackAudio.onMeter = {')
end = model.index('{', start) + 1
depth = 1
while depth:
    depth += (model[end] == '{') - (model[end] == '}'); end += 1
binding = model[start:end]
adapter = '''
import Foundation
@MainActor final class MeterPublisher {
    var onMeter: ((NativeMasterAudioMeterSnapshot, UUID?) -> Void)?
}
@MainActor final class MeterModelAdapter {
    let playbackAudio: MeterPublisher
    var generation = UUID()
    var masterAudioMeter: NativeMasterAudioMeterSnapshot = .silence
    init(_ playbackAudio: MeterPublisher) {
        self.playbackAudio = playbackAudio
'''+binding+'''
    }
}
'''
source = r'''
import AVFoundation
import Foundation
import ReelKit

@main struct AudioMeterChecks {
    @MainActor static func main() async throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            checks += 1; precondition(condition(), message)
        }
        func near(_ actual: Double, _ expected: Double, _ message: String, tolerance: Double = 0.001) {
            check(abs(actual - expected) <= tolerance, "\(message): \(actual), expected \(expected)")
        }
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
        func buffer(_ left: Float, _ right: Float, frames: AVAudioFrameCount = 1024, interleaved: Bool = false, mono: Bool = false) -> AVAudioPCMBuffer {
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: mono ? 1 : 2, interleaved: interleaved)!
            let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
            pcm.frameLength = frames
            let data = pcm.floatChannelData!, channels = Int(format.channelCount)
            for frame in 0..<Int(frames) {
                if interleaved { data[0][frame * channels] = left; if !mono { data[0][frame * channels + 1] = right } }
                else { data[0][frame] = left; if !mono { data[1][frame] = right } }
            }
            return pcm
        }
        let meter = NativeMasterAudioMeterAccumulator(), token = UUID()
        meter.reset(token)
        let half = buffer(0.5, 0.25), silence = buffer(0, 0)
        let first = meter.ingest(half, token: token, now: 1000)!
        near(first.left.peakDB, 20 * log10(0.5), "Left sample peak")
        near(first.right!.rmsDB, 20 * log10(0.25), "Right RMS")
        check(meter.ingest(half, token: token, now: 1_000_000_000) == nil, "Only one callback may be pending")
        meter.didPublish(token)
        let weighted = meter.ingest(buffer(0, 0, frames: 2048), token: token, now: 2_000_000_000)!
        near(weighted.left.rmsDB, 10 * log10(0.25 / 3), "RMS weights sample count")
        meter.didPublish(token)
        let quiet = meter.ingest(silence, token: token, now: 3_000_000_000)!
        check(quiet.left.peakDB == -.infinity && quiet.right!.rmsDB == -.infinity, "Silence clears both channels")
        meter.didPublish(token)
        let stereo = meter.ingest(buffer(0.5, 0.25, interleaved: true), token: token, now: 4_000_000_000)!
        near(stereo.right!.peakDB, 20 * log10(0.25), "Interleaved channel mapping")
        meter.didPublish(token)
        let mono = meter.ingest(buffer(0.5, 0, mono: true), token: token, now: 5_000_000_000)!
        check(mono.right == nil && mono.available, "Mono is not labeled as a second output channel")
        meter.didPublish(token)
        check(!meter.ingest(buffer(.nan, 0), token: token, now: 6_000_000_000)!.available, "Nonfinite PCM is unavailable")
        let next = UUID(); meter.reset(next)
        check(meter.ingest(half, token: token, now: 7_000_000_000) == nil, "Old generation samples are discarded")
        _ = meter.ingest(half, token: next, now: 7_000_000_000)
        meter.didPublish(token)
        check(meter.ingest(half, token: next, now: 8_000_000_000) == nil, "Old completion cannot release the new generation's pending callback")
        meter.reset(next)
        var publishes = 0
        for millisecond in 1...1000 {
            if meter.ingest(half, token: next, now: UInt64(millisecond) * 1_000_000) != nil { publishes += 1; meter.didPublish(next) }
        }
        check(publishes <= 15 && publishes >= 14, "Meter publishes at most 15 times per second")
        meter.reset(next)
        _ = meter.ingest(half, token: next, now: 1)
        for n in 1...200 { _ = meter.ingest(half, token: next, now: UInt64(n) * 1_000_000) }
        meter.didPublish(next)
        let bounded = meter.ingest(silence, token: next, now: 1_000_000_000)!
        check(bounded.available && bounded.left.rmsDB.isFinite, "A blocked publisher keeps a bounded scalar window")

        let publisher = MeterPublisher()
        var modelAdapter: MeterModelAdapter? = MeterModelAdapter(publisher)
        let origin = modelAdapter!.generation
        publisher.onMeter?(first, origin)
        check(modelAdapter!.masterAudioMeter == first, "Model accepts its originating processing context")
        modelAdapter!.generation = UUID()
        publisher.onMeter?(stereo, origin)
        check(modelAdapter!.masterAudioMeter == first, "Model discards samples queued before a project reset")
        publisher.onMeter?(.silence, modelAdapter!.generation)
        check(modelAdapter!.masterAudioMeter == .silence, "Model accepts silence for the current context")
        weak var weakModel = modelAdapter
        modelAdapter = nil
        check(weakModel == nil, "Meter callbacks do not retain the editor model")
        publisher.onMeter?(stereo, origin)

        let folder = ProjectFolder(root: URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true))
        let rate = 48_000
        let signal = (0..<rate).map { Float(0.4 * sin(Double($0) * 2 * .pi * 700 / Double(rate))) }
        let right = (0..<rate).map { Float(0.2 * sin(Double($0) * 2 * .pi * 1100 / Double(rate))) }
        try NativeAudioProcessing.write(.init(channels: [signal, right], rate: rate), to: folder.root.appendingPathComponent("source.wav"))
        func render(_ name: String, pan: Double = 0, gain: Double = 1, limited: Bool = false) async throws -> URL {
            var master: [String: Any] = ["gain": 1]
            if limited { master["limiter"] = ["type": "limiter", "params": ["ceiling": -18, "lookahead": 5, "release": 60]] }
            let plan: [String: Any] = ["from": 0, "to": 1, "rate": rate, "buses": [["gain": gain, "pan": pan, "items": [["src": "source.wav", "sourceIn": 0, "from": 0, "to": 1, "speed": 1]]]], "master": master]
            let pcm = try await NativeAudioMixer.render(plan: JSON(any: plan), folder: folder, preview: true)
            let url = folder.root.appendingPathComponent(name + ".wav")
            try NativeAudioProcessing.write(pcm, to: url); return url
        }
        let normal = try await render("normal"), panned = try await render("panned", pan: 1)
        let muted = try await render("muted", gain: 0), limited = try await render("limited", limited: true)
        let engine = AVAudioEngine(), playback = NativePlaybackAudio(engine: engine)
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 1024)
        var events: [(NativeMasterAudioMeterSnapshot, UUID?)] = []
        playback.onMeter = { events.append(($0, $1)) }
        func play(_ file: URL, origin: UUID) async throws -> NativeMasterAudioMeterSnapshot {
            events.removeAll()
            try playback.load(file, start: 0, end: 1, contextID: origin)
            try playback.play()
            let output = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 1024)!
            for _ in 0..<47 {
                let status = try engine.renderOffline(1024, to: output)
                check(status == .success || status == .insufficientDataFromInputNode, "Offline playback renders")
                try await Task.sleep(for: .milliseconds(3))
            }
            check(events.contains { $0.1 == origin }, "Every playback publishes originating PCM, including silence")
            let samples = events.filter { $0.1 == origin && $0.0.left.peakDB.isFinite || $0.1 == origin && $0.0.right?.peakDB.isFinite == true }
            guard let sample = samples.max(by: { max($0.0.left.peakDB, $0.0.right?.peakDB ?? -.infinity) < max($1.0.left.peakDB, $1.0.right?.peakDB ?? -.infinity) })?.0 else {
                if file == muted { return events.last!.0 }
                preconditionFailure("The actual playback tap must publish nonzero PCM")
            }
            check(events.allSatisfy { $0.1 == origin || $0.0 == .silence }, "Meter samples retain the originating context")
            return sample
        }
        let normalSample = try await play(normal, origin: UUID())
        near(normalSample.left.peakDB, 20 * log10(0.4), "Actual playback left peak", tolerance: 0.03)
        near(normalSample.right!.peakDB, 20 * log10(0.2), "Actual playback right peak", tolerance: 0.03)
        let panSample = try await play(panned, origin: UUID())
        check(panSample.left.peakDB < -100 && panSample.right!.peakDB > normalSample.right!.peakDB + 4, "Rendered pan changes the measured stereo output")
        let mutedSample = try await play(muted, origin: UUID())
        check(mutedSample.left.peakDB == -.infinity && mutedSample.right!.rmsDB == -.infinity, "Rendered mute measures silence")
        let limitedSample = try await play(limited, origin: UUID())
        check(limitedSample.left.peakDB <= -17.9 && limitedSample.left.peakDB < normalSample.left.peakDB - 8, "Rendered limiter reduces measured master peak")
        playback.stop()
        check(events.last!.0 == .silence, "Pause or clear synchronously resets the master meter")
        let stale = UUID(), fresh = UUID()
        try playback.load(normal, start: 0, end: 1, contextID: stale); try playback.play()
        let output = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 1024)!
        for _ in 0..<10 { _ = try engine.renderOffline(1024, to: output) }
        playback.stop(); let stoppedAt = events.count
        for _ in 0..<20 { await Task.yield() }
        check(events.dropFirst(stoppedAt).allSatisfy { $0.0 == .silence }, "Queued stale tap tasks cannot restore meters after stop")
        _ = try await play(normal, origin: fresh)
        playback.stop()
        do { try playback.load(folder.root.appendingPathComponent("missing.wav"), start: 0, end: 1, contextID: fresh); preconditionFailure("Missing audio should fail") } catch {}
        check(events.last!.0 == .silence, "Load failures leave a silent meter")
        print("Passed \(checks) master meter checks, including processed PCM, offline playback, pan, mute, limiter, reload, silence and stale callbacks.")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='reel-master-meter-') as temporary:
    folder = Path(temporary)
    swift = folder / 'checks.swift'
    swift.write_text(adapter + source)
    binary = folder / 'checks'
    # ReelKit imports its NativeProjectIO C target. Expose that module to this client from the tracked header.
    project_io = folder / 'NativeProjectIO'; project_io.mkdir()
    (project_io / 'module.modulemap').write_text('module NativeProjectIO {\n    umbrella header "%s"\n    export *\n}\n' % (root / 'native/ReelKit/Sources/NativeProjectIO/include/NativeProjectIO.h'))
    subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(folder / 'cache'), '-I', str(module_dir), '-I', str(project_io), str(root / 'native/App/Shared/NativeEditor/NativePlaybackAudio.swift'), str(swift), *link, '-o', str(binary)], check=True)
    subprocess.run([str(binary), str(folder)], check=True)
