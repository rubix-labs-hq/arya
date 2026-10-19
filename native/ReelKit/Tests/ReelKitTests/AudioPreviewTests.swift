import Foundation
@testable import ReelKit
import XCTest

final class AudioPreviewTests: XCTestCase {
    func testConstantMixCurvesMatchInterpolatedPCMBitForBit() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("constant-mix-curves")), rate = 8000
        let samples = (0..<800).map { Float(sin(Double($0) * 0.07) * 0.3) }
        try NativeAudioProcessing.write(.init(channels: [samples, samples.reversed().map { $0 }], rate: rate), to: folder.root.appendingPathComponent("tone.wav"))
        func plan(gain: [Double], pan: [Double]) -> JSON {
            JSON(any: ["from": 0, "to": 0.1, "rate": rate, "buses": [["items": [["src": "tone.wav", "sourceIn": 0, "from": 0, "to": 0.1, "speed": 1,
                "gain": ["from": 0, "step": 1, "values": gain], "pan": ["from": 0, "step": 1, "values": pan]]]]], "master": ["gain": 1]])
        }
        for (gain, pan) in [(0.25, -0.5), (1.0, 0.0), (-0.0, -0.0), (0.7, 0.5)] {
            // The changing curve's last point lies beyond this render. Its first segment is flat.
            let reference = try await NativeAudioMixer.render(plan: plan(gain: [gain, gain, 0.9], pan: [pan, pan, 0.8]), folder: folder)
            for count in [1, 4] {
                let actual = try await NativeAudioMixer.render(plan: plan(gain: Array(repeating: gain, count: count), pan: Array(repeating: pan, count: count)), folder: folder)
                XCTAssertEqual(actual.channels.map { $0.map(\.bitPattern) }, reference.channels.map { $0.map(\.bitPattern) })
            }
        }
        let empty = try await NativeAudioMixer.render(plan: plan(gain: [], pan: []), folder: folder)
        XCTAssertTrue(empty.channels.flatMap { $0 }.allSatisfy { $0 == 0 })
    }

    func testHistoryIncludesCascadedDelayReverbAndAnimatedOrigin() throws {
        let graph: [String:Any] = ["rate":16000,"buses":[["chain":[["type":"reverb","params":["decay":2,"predelay":20]]],"items":[["chain":[["type":"delay","params":["time":100,"feedback":0.5]]]]]]],"master":["chain":[]]]
        let history = try NativeAudioMixer.previewHistory(plan:JSON(any:graph))
        XCTAssertGreaterThan(history.seconds,4.8)
        var animated=graph
        animated["master"]=["chain":[["type":"eq","params":["bands":[]],"curves":["bands.0.freq":["values":[100,200]]]]]]
        XCTAssertTrue(try NativeAudioMixer.previewHistory(plan:JSON(any:animated)).requiresOrigin)
    }

    // This admission test requires the paired native audio DSP extension.
    func testChangingEffectParametersAdmitAtEveryScopeInComposedDSP() throws {
        for (type, keys) in [("limiter", ["ceiling", "release", "lookahead"]), ("reverb", ["size", "decay"])] {
            for key in keys {
                let values: [Double] = key == "ceiling" ? [-12, -3] : key == "release" ? [30, 90] : key == "lookahead" ? [1, 5] : [0.5, 0.8]
                let effect: [String: Any] = ["type": type, "curves": [key: ["from": 0, "step": 0.02, "values": values]]]
                let locations = type == "limiter" ? ["clip", "track", "nested", "master", "masterLimiter"] : ["clip", "track", "nested", "master"]
                for location in locations {
                    var leaf: [String: Any] = ["kind": "leaf", "src": "missing.wav", "sourceIn": 0, "speed": 1, "from": 0, "to": 1]
                    if location == "clip" { leaf["chain"] = [effect] }
                    let bus: [String: Any] = ["items": [leaf], "chain": location == "track" ? [effect] : []]
                    var graph: [String: Any] = ["from": 0, "to": 1, "rate": 48000, "buses": [bus], "master": ["chain": location == "master" ? [effect] : []]]
                    if location == "nested" { graph["buses"] = [["items": [["kind": "comp", "buses": [bus], "chain": [effect]]]]] }
                    if location == "masterLimiter" { graph["master"] = ["limiter": effect] }
                    XCTAssertNoThrow(try NativeAudioMixer.validate(plan: JSON(any: graph)), "Changing \(type) \(key) at \(location)")
                    XCTAssertTrue(try NativeAudioMixer.previewHistory(plan: JSON(any: graph)).requiresOrigin)
                }
            }
        }
    }

    func testDeesserDetectorBandAutomationAndReverbPredelayChangeActualOutput() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("native-effect-curves")), rate = 48000
        let tone = (0..<rate).map { Float(0.1 * sin(2 * .pi * 6000 * Double($0) / Double(rate))) }
        try NativeAudioProcessing.write(.init(channels: [tone], rate: rate), to: folder.root.appendingPathComponent("tone.wav"))
        func plan(_ source: String, _ effect: [String: Any]) -> JSON {
            JSON(any: ["from": 0, "to": 1, "rate": rate, "buses": [["items": [["kind": "leaf", "src": source, "sourceIn": 0, "speed": 1, "from": 0, "to": 1, "chain": [effect]]]]], "master": ["gain": 1]])
        }
        var deesser: [String: Any] = ["type": "deesser", "params": ["lo": 2000, "hi": 4000, "threshold": -35, "ratio": 4, "range": 12]]
        let fixed = try await NativeAudioMixer.render(plan: plan("tone.wav", deesser), folder: folder, preview: true)
        deesser["curves"] = ["lo": ["from": 0, "step": 0.5, "values": [2000, 5000, 5000]], "hi": ["from": 0, "step": 0.5, "values": [4000, 8000, 8000]]]
        let moving = try await NativeAudioMixer.render(plan: plan("tone.wav", deesser), folder: folder, preview: true)
        func energy(_ values: [Float]) -> Double { values[(rate * 3 / 4)..<rate].reduce(0) { $0 + Double($1 * $1) } }
        XCTAssertLessThan(energy(moving.channels[0]), energy(fixed.channels[0]) * 0.8)
        var impulse = [Float](repeating: 0, count: rate); impulse[0] = 0.5
        try NativeAudioProcessing.write(.init(channels: [impulse], rate: rate), to: folder.root.appendingPathComponent("impulse.wav"))
        var reverb: [String: Any] = ["type": "reverb", "params": ["mix": 1, "predelay": 0, "decay": 0.3, "size": 0.5]]
        let dryDelay = try await NativeAudioMixer.render(plan: plan("impulse.wav", reverb), folder: folder, preview: true)
        reverb["curves"] = ["predelay": ["from": 0, "step": 0.5, "values": [0, 100, 100]]]
        let movingDelay = try await NativeAudioMixer.render(plan: plan("impulse.wav", reverb), folder: folder, preview: true)
        let difference = zip(dryDelay.channels[0], movingDelay.channels[0]).reduce(0.0) { $0 + abs(Double($1.0 - $1.1)) }
        XCTAssertGreaterThan(difference, 0.001)
        XCTAssertEqual(movingDelay.count, rate); XCTAssertTrue(movingDelay.channels.flatMap { $0 }.allSatisfy(\.isFinite))
        XCTAssertTrue(try NativeAudioMixer.previewHistory(plan: plan("impulse.wav", reverb)).requiresOrigin)
    }

    func testWarmedPreviewMatchesContinuousDSPAcrossBoundary() async throws {
        let folder=ProjectFolder(root:try Support.tempFolder("preview")), rate=16000, file=folder.root.appendingPathComponent("tone.wav")
        let signal=(0..<rate*12).map { i -> Float in let t=Double(i)/Double(rate); return Float((t < 6 ? 0.3 : 0.07)*sin(t*2*Double.pi*173)) }
        try NativeAudioProcessing.write(.init(channels:[signal],rate:rate),to:file)
        let chain:[[String:Any]]=[
            ["type":"eq","params":["bands":[["type":"peaking","freq":500,"gain":4,"q":1]]]],
            ["type":"delay","params":["time":80,"feedback":0.2,"mix":0.3]],
            ["type":"reverb","params":["decay":0.5,"predelay":10,"mix":0.2]],
            ["type":"compressor","params":["threshold":-24,"ratio":3,"release":60,"attack":5]],
        ]
        func plan(_ from:Double,_ to:Double)->JSON { JSON(any:["from":from,"to":to,"rate":rate,"buses":[["items":[["src":"tone.wav","sourceIn":from,"from":from,"to":to,"speed":1,"chain":chain]],"chain":[]]],"master":["chain":[],"gain":1]]) }
        let history=try NativeAudioMixer.previewHistory(plan:plan(0,12))
        let start=max(0,floor((8-history.seconds)*Double(rate))/Double(rate))
        let full=try await NativeAudioMixer.render(plan:plan(0,10),folder:folder,preview:true)
        let warmed=try await NativeAudioMixer.render(plan:plan(start,10),folder:folder,preview:true)
        let offset=Int(((8-start)*Double(rate)).rounded()), fullOffset=8*rate
        var error=0.0, power=0.0
        for i in 0..<2*rate { let a=Double(full.channels[0][fullOffset+i]), b=Double(warmed.channels[0][offset+i]); error+=(a-b)*(a-b); power+=a*a }
        XCTAssertLessThan(10*log10(max(error,1e-30)/max(power,1e-30)),-90)
    }

    func testGateHysteresisPreviewRetainsEarlierOpenState() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("preview-gate")), rate = 16000
        let signal = (0..<rate*4).map { Float(pow(10, $0 < rate/4 ? -30.0/20 : -47.0/20)) }
        // Keep each channel at -47 dB, inside the gate's -49 to -45 dB hysteresis band.
        // Mono-to-stereo conversion has its own level regressions.
        try NativeAudioProcessing.write(.init(channels: [signal, signal], rate: rate), to: folder.root.appendingPathComponent("gate.wav"))
        let chain: [[String: Any]] = [["type": "gate", "params": ["threshold": -45, "range": -60]]]
        func plan(_ from: Double) -> JSON {
            JSON(any: ["from": from, "to": 4, "rate": rate, "buses": [["items": [["src": "gate.wav", "sourceIn": from, "from": from, "to": 4, "speed": 1, "chain": chain]]]], "master": ["gain": 1]])
        }
        let history = try NativeAudioMixer.previewHistory(plan: plan(0))
        XCTAssertTrue(history.requiresOrigin)
        let begin = history.requiresOrigin ? 0 : max(0, 3-history.seconds)
        let full = try await NativeAudioMixer.render(plan: plan(0), folder: folder, preview: true)
        let warmed = try await NativeAudioMixer.render(plan: plan(begin), folder: folder, preview: true)
        let reset = try await NativeAudioMixer.render(plan: plan(2), folder: folder, preview: true)
        let warmOffset = Int((3-begin)*Double(rate))
        XCTAssertGreaterThan(full.channels[0][rate*3], 0.004)
        XCTAssertLessThan(reset.channels[0][rate], full.channels[0][rate*3] / 500)
        for i in 0..<rate {
            XCTAssertEqual(warmed.channels[0][warmOffset+i], full.channels[0][rate*3+i], accuracy: 0.0000001)
        }
    }

    func testBackendPreviewProducesOnlyRequestedRangeWithSharedVerifiedLimiter() async throws {
        let root=try Support.tempFolder("preview-backend"), folder=ProjectFolder(root:root), rate=48000
        let source=folder.root.appendingPathComponent("speech.wav")
        let samples=(0..<rate*25).map { Float(sin(Double($0)*0.01)*0.4) }
        try NativeAudioProcessing.write(.init(channels:[samples],rate:rate),to:source)
        let backend=try ReelBackend(folder:folder,coreScript:Support.core()) { _,_ in }
        try await backend.start(); defer { Task { await backend.stop() } }
        _ = try await backend.handle(method:"POST",path:"/api/new",body:"{}")
        _ = try await backend.handle(method:"POST",path:"/api/import",body:"{\"paths\":[\"speech.wav\"]}")
        _ = try await backend.editOperations(ops:.array([.object([("op","add_clip"),("src","speech.wav"),("kind","audio"),("dur",25)]),.object([("op","project"),("set",.object([("master",.object([("limiter",.object([("enabled",true),("ceiling",-1),("release",60),("lookahead",5)]))]))]))])]))
        let before=Date(), preview=try await backend.renderAudioPreview(from:8,to:16)
        let elapsed=Date().timeIntervalSince(before)
        let pcm=try await NativeAudioProcessing.decode(preview.url)
        XCTAssertEqual(preview.offset,0); XCTAssertEqual(preview.duration,8,accuracy:0.001); XCTAssertEqual(pcm.count,rate*8)
        XCTAssertNil(preview.composition)
        let capturedVersion = await backend.currentVersion()
        XCTAssertEqual(preview.version, capturedVersion)
        XCTAssertTrue(preview.meters.valid)
        XCTAssertEqual(preview.meters.frameCount, pcm.count)
        XCTAssertEqual(preview.meters.binFrames, rate / 20)
        XCTAssertGreaterThan(preview.meters.buses["A1"]?.first?.leftPeak ?? 0, 0.1)
        XCTAssertEqual(preview.meters.buses["A2"]?.first?.leftPeak, 0)
        XCTAssertGreaterThan(preview.historySeconds,1)
        print("Native 8-second warmed limiter preview prepared in \(elapsed) seconds")
        XCTAssertLessThan(elapsed,8)
    }

    func testNestedPreviewMeterIdentityAndCropAreImmutable() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("preview-scoped-metadata")), rate = 48000
        let samples = (0..<(rate * 3)).map { Float(0.1 * sin(2 * .pi * 1000 * Double($0) / Double(rate))) }
        try NativeAudioProcessing.write(.init(channels: [samples, samples]), to: folder.root.appendingPathComponent("tone.wav"))
        let backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _, _ in }
        try await backend.start()
        do {
            _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}")
            _ = try await backend.handle(method: "POST", path: "/api/import", body: #"{"paths":["tone.wav"]}"#)
            let ops = #"[{"op":"add_clip","kind":"audio","src":"tone.wav","dur":3},{"op":"add_comp","width":80,"height":80,"fps":24},{"op":"add_clip","comp":"k1","kind":"audio","track":"A1","src":"tone.wav","dur":3,"set":{"id":"c1","volume":6}},{"op":"update_track","comp":"k1","id":"V1","set":{"muted":true}}]"#
            _ = try await backend.editOperations(ops: .raw(ops))
            let main = try await backend.renderAudioPreview(from: 0.125, to: 1.1375)
            let nested = try await backend.renderAudioPreview(from: 0.125, to: 1.1375, comp: "k1")
            XCTAssertNil(main.composition); XCTAssertEqual(nested.composition, "k1")
            XCTAssertEqual(main.version, nested.version)
            XCTAssertNotEqual(main.requestID, nested.requestID)
            XCTAssertEqual(nested.meters.frameCount, 48600)
            XCTAssertEqual(nested.meters.buses["A1"]?.last?.frameCount, 600)
            XCTAssertEqual(nested.meters.buses["V1"]?.first?.leftPeak, 0)
            let mainPeak = try XCTUnwrap(main.meters.buses["A1"]?.first?.leftPeak)
            let nestedPeak = try XCTUnwrap(nested.meters.buses["A1"]?.first?.leftPeak)
            XCTAssertEqual(20 * log10(nestedPeak / mainPeak), 6, accuracy: 0.05)
            let capturedMeters = nested.meters, capturedVersion = nested.version
            _ = try await backend.editOperations(ops: .raw(#"[{"op":"update","comp":"k1","id":"c1","set":{"volume":-20}}]"#))
            XCTAssertEqual(nested.meters, capturedMeters)
            XCTAssertEqual(nested.version, capturedVersion)
            let changedVersion = await backend.currentVersion()
            XCTAssertNotEqual(nested.version, changedVersion)
            await backend.stop()
        } catch { await backend.stop(); throw error }
    }
}
