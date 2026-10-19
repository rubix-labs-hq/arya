import Foundation
@testable import ReelKit
import XCTest

final class NativeAudioProcessingTests: XCTestCase {
    func testSyncRejectsAggregatePCMAndFFTOverBudgetBeforeDecoding() async throws {
        XCTAssertThrowsError(try NativeAudioProcessing.validateSyncMemory(sampleCounts: [Int](repeating: 16000 * 600, count: 32), rate: 16000, limit: 512 * 1024 * 1024))
        XCTAssertThrowsError(try NativeAudioProcessing.validateSyncMemory(sampleCounts: [16000 * 600, 16000 * 600], rate: 16000, limit: 512 * 1024 * 1024))
        XCTAssertNoThrow(try NativeAudioProcessing.validateSyncMemory(sampleCounts: [8000 * 30, 8000 * 30], rate: 8000, limit: 128 * 1024 * 1024))
        let folder = ProjectFolder(root: try Support.tempFolder("sync-budget"))
        let backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _,_ in }
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}")
        do {
            _ = try await backend.handle(method: "POST", path: "/api/multicam/sync", body: JSON(any: ["srcs": [String](repeating: "absent.wav", count: 32), "rate": 16000, "maxSeconds": 600]).text)
            XCTFail("Accepted an oversized sync request")
        } catch { XCTAssertTrue(error.localizedDescription.contains("audio budget"), "The aggregate budget rejects before source resolution or decode: \(error)") }
        await backend.stop()
    }

    func testCancellationReachesDetachedAnalysisBeforeItFinishes() async throws {
        let pcm = NativeAudioProcessing.PCM(channels: [[Float](repeating: 0.1, count: 16000)], rate: 16000)
        for kind in ["silence", "beats", "loudness", "sync", "cleanup", "voice"] {
            let started = expectation(description: "Started \(kind)")
            let release = DispatchSemaphore(value: 0)
            let completed = AnalysisCompletionFlag()
            let task = Task {
                try await NativeAudioProcessing.cancellableTask {
                    started.fulfill()
                    guard release.wait(timeout: .now()+5) == .success else { throw ReelBackend.APIError("The test did not release analysis.") }
                    switch kind {
                    case "silence": _ = try NativeAudioProcessing.silence(pcm)
                    case "beats": _ = try NativeAudioProcessing.beats(pcm)
                    case "sync": _ = try NativeAudioProcessing.sync([pcm.channels[0], pcm.channels[0]], rate: pcm.rate, window: 1)
                    case "cleanup": _ = try NativeAudioProcessing.clean(pcm, mode: "denoise")
                    case "voice": _ = try NativeAudioProcessing.clean(pcm, mode: "voice", options: .init(strength: 0))
                    default: _ = try NativeAudioProcessing.measure(pcm)
                    }
                    completed.mark()
                }
            }
            await fulfillment(of: [started], timeout: 5)
            task.cancel(); release.signal()
            do { try await task.value; XCTFail("Cancelled \(kind) returned a result") }
            catch { XCTAssertTrue(error is CancellationError, error.localizedDescription) }
            XCTAssertFalse(completed.value, "\(kind) continued after cancellation")
        }
    }

    func testNativeMixRejectsOversizedGraphBeforeDecoding() throws {
        XCTAssertThrowsError(try NativeAudioProcessing.validateMemory(seconds: 60, limit: 16 * 1024 * 1024))
        XCTAssertNoThrow(try NativeAudioProcessing.validateMemory(seconds: 60, limit: 256 * 1024 * 1024))
        let leaf:[String:Any]=["kind":"leaf","src":"missing.wav","from":0,"to":120,"sourceIn":0,"speed":1]
        let plan=JSON(any:["from":0,"to":120,"rate":48000,"buses":[["items":[leaf]]]])
        XCTAssertThrowsError(try NativeAudioMixer.validate(plan:plan,limit:32*1024*1024))
        XCTAssertNoThrow(try NativeAudioMixer.validate(plan:plan,limit:1024*1024*1024))
    }
    func testLoudnessCalibrationAndGain() throws {
        let rate = 48000
        let samples = (0..<(rate * 4)).map { Float(0.1 * sin(2 * .pi * 1000 * Double($0) / Double(rate))) }
        let pcm = NativeAudioProcessing.PCM(channels: [samples,samples])
        let measured = try NativeAudioProcessing.measure(pcm)
        XCTAssertEqual(measured.integrated,-20,accuracy:0.2)
        XCTAssertEqual(measured.peak,-20,accuracy:0.2)
        let gain = pow(10,(-23 - measured.integrated)/20)
        let normalized = NativeAudioProcessing.PCM(channels: pcm.channels.map { $0.map { Float(Double($0)*gain) } })
        XCTAssertEqual(try NativeAudioProcessing.measure(normalized).integrated,-23,accuracy:0.05)
        XCTAssertEqual(try NativeAudioProcessing.measure(.init(channels: [[Float](repeating:0,count:rate)])).integrated,-.infinity)
    }

    func testSpectralDenoisePreservesToneAndDuration() throws {
        let rate = 48000
        var seed: UInt32 = 17
        let samples = (0..<(rate * 4)).map { i -> Float in
            seed = 1664525 &* seed &+ 1013904223
            let noise = (Double(seed)/Double(UInt32.max)*2-1)*0.008
            let tone = i >= rate && i < rate*3 ? 0.15*sin(2 * .pi * 1000 * Double(i)/Double(rate)) : 0
            return Float(tone+noise)
        }
        let original = NativeAudioProcessing.PCM(channels:[samples])
        let clean = try NativeAudioProcessing.clean(original,mode:"denoise")
        XCTAssertEqual(clean.count,original.count)
        func rms(_ s:[Float],_ a:Int,_ b:Int)->Double { sqrt(s[a..<b].reduce(0) { $0+Double($1*$1) }/Double(b-a)) }
        let before = rms(samples,rate/4,rate*3/4), after = rms(clean.channels[0],rate/4,rate*3/4)
        XCTAssertLessThan(20*log10(after/before),-10)
        let toneBefore = rms(samples,rate*3/2,rate*5/2), toneAfter = rms(clean.channels[0],rate*3/2,rate*5/2)
        XCTAssertEqual(20*log10(toneAfter/toneBefore),0,accuracy:3)
        let voice = try NativeAudioProcessing.clean(original,mode:"voice")
        XCTAssertEqual(voice.count,samples.count)
        XCTAssertTrue(voice.channels[0].allSatisfy(\.isFinite))
    }

    func testAdjustableCleanupUsesKnownNoiseProfileAndImprovesSignalError() throws {
        let rate=48000;var seed:UInt32=97
        let clean=(0..<rate*3).map { i -> Float in
            let t=Double(i)/Double(rate),gate=t>0.5 && t<2.5 ? pow(sin(.pi*(t-0.5)/2),0.5) : 0
            return Float(gate*(0.12*sin(2 * .pi * 180*t)+0.05*sin(2 * .pi * 540*t)+0.03*sin(2 * .pi * 1080*t)))
        }
        let noisy=clean.map { value -> Float in seed=1664525 &* seed &+ 1013904223;return value+Float((Double(seed)/Double(UInt32.max)*2-1)*0.025) },pcm=NativeAudioProcessing.PCM(channels:[noisy])
        let strong=try NativeAudioProcessing.clean(pcm,mode:"denoise",options:.init(strength:1,detail:0.7,quality:"high",noiseFrom:0.05,noiseTo:0.45))
        let weak=try NativeAudioProcessing.clean(pcm,mode:"denoise",options:.init(strength:0.25,detail:0.7,quality:"high",noiseFrom:0.05,noiseTo:0.45))
        func energy(_ samples:[Float],_ start:Int,_ end:Int)->Double { samples[start..<end].reduce(0) { $0+Double($1)*Double($1) } }
        let quiet=rate/10..<rate*4/10
        let strongFloor=energy(strong.channels[0],quiet.lowerBound,quiet.upperBound),weakFloor=energy(weak.channels[0],quiet.lowerBound,quiet.upperBound),originalFloor=energy(noisy,quiet.lowerBound,quiet.upperBound)
        XCTAssertLessThan(10*log10(strongFloor/originalFloor),-15);XCTAssertLessThan(strongFloor,weakFloor/5)
        func error(_ data:[Float])->Double { zip(data[rate..<rate*2],clean[rate..<rate*2]).reduce(0) { $0+pow(Double($1.0-$1.1),2) } }
        let improvement=10*log10(error(noisy)/error(strong.channels[0]));print("Audio cleanup known-signal error improvement dB",improvement);XCTAssertGreaterThan(improvement,7)
        XCTAssertEqual(try NativeAudioProcessing.clean(pcm,mode:"denoise",options:.init(strength:0)).channels[0],noisy)
        XCTAssertThrowsError(try NativeAudioProcessing.clean(pcm,mode:"denoise",options:.init(noiseFrom:0,noiseTo:4)))
        let analysis=try JSON.parse(NativeProcessingRecommendations.audio(pcm).text) as? [String:Any]
        XCTAssertGreaterThan(analysis?["levelRangeDB"] as? Double ?? 0,10)
    }

    func testSilenceIncludesTrailingRangeAndBeatsRecoverTempo() throws {
        let rate = 48000
        var samples = [Float](repeating:0,count:rate*4)
        for i in rate..<rate*2 { samples[i]=Float(0.2*sin(2 * .pi * 200 * Double(i)/Double(rate))) }
        let ranges = try NativeAudioProcessing.silence(.init(channels:[samples]),noise:-40,minimum:0.4)
        XCTAssertEqual(ranges.count,2)
        XCTAssertEqual(ranges[0][0],0,accuracy:0.01)
        XCTAssertEqual(ranges[0][1],1,accuracy:0.02)
        XCTAssertEqual(ranges[1][0],2,accuracy:0.02)
        XCTAssertEqual(ranges[1][1],4,accuracy:0.01)
        var pulses = [Float](repeating:0,count:rate*6)
        for beat in 0..<12 {
            let start=beat*rate/2
            for i in 0..<(rate/12) { pulses[start+i]=Float(0.8*exp(-Double(i)/1200)*sin(2 * .pi * 100 * Double(i)/Double(rate))) }
        }
        let result = try NativeAudioProcessing.beats(.init(channels:[pulses]))
        XCTAssertEqual(result.bpm ?? 0,120,accuracy:3)
        XCTAssertGreaterThanOrEqual(result.times.count,10)
        for time in result.times { XCTAssertEqual(time*2,(time*2).rounded(),accuracy:0.08) }
    }

    func testCorrelationRecoversDelayAndPolarity() throws {
        let rate = 8000
        var seed: UInt32 = 7
        let source = (0..<(rate*2)).map { _ -> Float in seed=1664525 &* seed &+ 1013904223; return Float(Double(seed)/Double(UInt32.max)*0.4-0.2) }
        let late = [Float](repeating:0,count:rate/5)+source
        let early = Array(source.dropFirst(rate/10)).map { -$0 }
        let result=parse(try NativeAudioProcessing.sync([source,late,early],rate:rate,window:0.5).text)
        let lags=try XCTUnwrap(result["lags"] as? [Double])
        XCTAssertEqual(lags[1],0.2,accuracy:2/Double(rate))
        XCTAssertEqual(lags[2],-0.1,accuracy:2/Double(rate))
        XCTAssertEqual((result["inverted"] as? [Bool])?[2],true)
        XCTAssertGreaterThan((result["confidence"] as? [Double])?[1] ?? 0,0.99)
    }

    func testWritesAndDecodesARealWav() async throws {
        let rate=48000, root=try Support.tempFolder("native-audio")
        let samples=(0..<rate).map { Float(0.2*sin(2 * .pi * 500 * Double($0)/Double(rate))) }
        let file=root.appendingPathComponent("fixture.wav")
        try NativeAudioProcessing.write(.init(channels:[samples,samples]),to:file)
        let decoded=try await NativeAudioProcessing.decode(file)
        XCTAssertEqual(decoded.count,rate)
        XCTAssertEqual(decoded.channels.count,2)
        XCTAssertEqual(decoded.channels[0][2400],samples[2400],accuracy:1/32768)
    }

    func testCleanupRequestRejectsCoercionAndIntegerOverflow() throws {
        let invalid: [[String: Any]] = [
            ["strength": true], ["strength": "0.5"], ["detail": false], ["detail": NSNull()], ["quality": 1], ["mode": true],
            ["noiseFrom": 0, "noiseTo": 0.05], ["noiseFrom": 0, "noiseTo": true], ["noiseFrom": 1],
            ["apply": 0], ["wait": 1], ["useOriginal": "true"], ["apply": NSNull()],
            ["expectedVersion": true], ["expectedVersion": "1"], ["expectedVersion": -1], ["expectedVersion": 0.5],
            ["expectedVersion": NSNumber(value: UInt64.max)], ["expectedVersion": pow(2.0, Double(63))], ["src": 1], ["comp": false],
        ]
        for body in invalid { XCTAssertThrowsError(try NativeAudioProcessing.CleanupRequest(body), "Accepted \(body)") }
        let defaults = try NativeAudioProcessing.CleanupRequest([:])
        XCTAssertEqual(defaults.options.strength, 0.75); XCTAssertEqual(defaults.options.detail, 0.7)
        XCTAssertTrue(defaults.useOriginal); XCTAssertTrue(defaults.apply)
        XCTAssertNoThrow(try NativeAudioProcessing.CleanOptions(request: ["noiseFrom": 1.1, "noiseTo": 1.2]))
        let selected = try NativeAudioProcessing.CleanupRequest(["mode": "voice", "strength": 0, "detail": 1, "noiseFrom": 1.25, "noiseTo": 1.75, "expectedVersion": 1, "comp": NSNull()])
        XCTAssertEqual(selected.options.settings["noiseFrom"] as? Double, 1.25)
        XCTAssertEqual(selected.options.settings["noiseTo"] as? Double, 1.75)
    }

    func testCleanupOriginalSelectionRefusesMissingOrInvalidRecoveryAssets() throws {
        let options = try NativeAudioProcessing.CleanOptions(request: ["strength": 0.4, "detail": 0.9, "quality": "high", "noiseFrom": 1, "noiseTo": 1.5])
        let recipe = NativeAudioProcessing.cleanupRecipe(source: "original.wav", output: "cleaned.wav", mode: "denoise", options: options)
        let clip: [String: Any] = ["src": "cleaned.wav", "audioCleanup": recipe]
        let assets: [String: Any] = ["original.wav": ["hasAudio": true, "duration": 3], "cleaned.wav": ["hasAudio": true, "duration": 3]]
        XCTAssertEqual(try NativeAudioProcessing.cleanupSource(clip: clip, assets: assets), "original.wav")
        XCTAssertEqual(try NativeAudioProcessing.cleanupSource(clip: clip, assets: assets, useOriginal: false), "cleaned.wav")
        XCTAssertThrowsError(try NativeAudioProcessing.cleanupSource(clip: clip, assets: ["cleaned.wav": assets["cleaned.wav"]!]))
        XCTAssertThrowsError(try NativeAudioProcessing.cleanupSource(clip: clip, assets: ["original.wav": ["hasAudio": false]]))
        XCTAssertThrowsError(try NativeAudioProcessing.cleanupSource(clip: clip, assets: ["original.wav": ["hasAudio": 1]]))
        var invalid = recipe; invalid["source"] = "cleaned.wav"
        XCTAssertThrowsError(try NativeAudioProcessing.cleanupSource(clip: ["src": "cleaned.wav", "audioCleanup": invalid], assets: assets))
        XCTAssertEqual(recipe["engine"] as? String, "accelerate-spectral-cpu")
        XCTAssertEqual((recipe["settings"] as? [String: Any])?["noiseTo"] as? Double, 1.5)
    }

    func testCleanupFloatWAVKeepsQuietSamplesAndHeadroomWithoutChangingSharedPCM16Writer() async throws {
        let root = try Support.tempFolder("cleanup-float"), samples: [Float] = [0, 0.0000001, 0.1234567, -0.7654321, 1.5, -1.25]
        let pcm = NativeAudioProcessing.PCM(channels: [samples, samples], rate: 48000), file = root.appendingPathComponent("cleanup.wav")
        try NativeAudioProcessing.writeCleanup(pcm, to: file)
        let bytes = try Data(contentsOf: file)
        XCTAssertEqual(String(data: bytes[12..<16], encoding: .utf8), "fmt ")
        XCTAssertEqual(Array(bytes[16..<20]), [18, 0, 0, 0])
        XCTAssertEqual(Array(bytes[20..<22]), [3, 0]); XCTAssertEqual(Array(bytes[34..<38]), [32, 0, 0, 0])
        XCTAssertEqual(String(data: bytes[38..<42], encoding: .utf8), "fact")
        XCTAssertEqual(String(data: bytes[50..<54], encoding: .utf8), "data")
        let decoded = try await NativeAudioProcessing.decode(file)
        XCTAssertEqual(decoded.count, samples.count); XCTAssertEqual(decoded.channels.count, 2)
        for channel in decoded.channels { for i in samples.indices { XCTAssertEqual(channel[i], samples[i], accuracy: 0.00000001) } }
        let legacy = root.appendingPathComponent("delivery.wav")
        try NativeAudioProcessing.write(pcm, to: legacy)
        let old = try Data(contentsOf: legacy)
        XCTAssertEqual(Array(old[20..<22]), [1, 0]); XCTAssertEqual(Array(old[34..<36]), [16, 0])
        XCTAssertThrowsError(try NativeAudioProcessing.writeCleanup(.init(channels: [[.nan]]), to: file))
    }

    func testShortCleanupFailsExplicitlyAndZeroStrengthVoiceStillWorks() throws {
        let pcm = NativeAudioProcessing.PCM(channels: [[Float](repeating: 0.1, count: 100)], rate: 48000)
        XCTAssertThrowsError(try NativeAudioProcessing.clean(pcm, mode: "denoise", options: .init(strength: 0.5)))
        XCTAssertEqual(try NativeAudioProcessing.clean(pcm, mode: "denoise", options: .init(strength: 0)).channels, pcm.channels)
        XCTAssertEqual(try NativeAudioProcessing.clean(pcm, mode: "voice", options: .init(strength: 0)).count, pcm.count)
    }

}

private final class AnalysisCompletionFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false
    var value: Bool { lock.lock(); defer { lock.unlock() }; return completed }
    func mark() { lock.lock(); completed = true; lock.unlock() }
}
