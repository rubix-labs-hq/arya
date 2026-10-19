import Foundation
import XCTest
@testable import ReelKit

private actor LimiterCancellationGate {
    private var entered = false
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async { entered = true; if !released { await withCheckedContinuation { continuation = $0 } } }
    func arrived() -> Bool { entered }
    func release() { released = true; continuation?.resume(); continuation = nil }
}

/// Queued behavior tests. Compile and run only after source review and runtime authorization.
final class NativeAudioLimiterParityTests: XCTestCase {
    func testCoefficientSignsStereoAndPaddedTailRemainVerifiedAtSupportedRates() throws {
        let signs = NativeAudioProcessing.peakPhases[1].reversed().map { Float($0 >= 0 ? 0.49 : -0.49) }
        let source = [Float](repeating: 0, count: 32) + signs + [Float](repeating: 0, count: 64)
        for rate in [8000, 48000, 192000] {
            var output = [source, source.map { -$0 }]
            try limit(&output, rate: rate)
            XCTAssertLessThanOrEqual(try NativeAudioAutomation.peakRatio(output, rate: rate, from: 0, ceiling: { _ in -6 }), 1.000001)
            XCTAssertGreaterThan(output[0].map(abs).max() ?? 0, 0)
            for i in source.indices { XCTAssertEqual(output[0][i], -output[1][i]) }
        }
    }

    func testShortMonoWindowsIncludeAllFIRTailSupports() throws {
        for count in [1, 2, 7, 11, 12, 13, 17] {
            var output = [(0..<count).map { Float($0 % 2 == 0 ? 0.99 : -0.9) }]
            try limit(&output, rate: 48000)
            XCTAssertEqual(output[0].count, count)
            try NativeAudioAutomation.verifyLimited(output, rate: 48000, from: 0, ceiling: { _ in -6 })
        }
        var largest = [[Float.greatestFiniteMagnitude]]
        try NativeAudioAutomation.limit(&largest, rate: 48000, from: 0, ceiling: { _ in -24 }, lookahead: { _ in 1 }, release: { _ in 1 })
        try NativeAudioAutomation.verifyLimited(largest, rate: 48000, from: 0, ceiling: { _ in -24 })
    }

    func testChangingCeilingLookaheadAndReleaseVerifyBeforeAndAfterCrop() throws {
        let rate = 48000, count = 4096
        let source = (0..<count).map { Float(1.8 * sin(Double($0) * 0.719)) }
        func ceiling(_ time: Double) -> Double { Int(time * Double(rate) / 101) % 2 == 0 ? -24 : 0 }
        var output = [source, source.reversed().map { $0 }]
        try NativeAudioAutomation.limit(&output, rate: rate, from: 0, ceiling: ceiling,
            lookahead: { 1 + 19 * pow(sin($0 * 179), 2) }, release: { 1 + 999 * pow(sin($0 * 91), 2) })
        try NativeAudioAutomation.verifyLimited(output, rate: rate, from: 0, ceiling: ceiling)
        let crop = output.map { Array($0[501..<530]) }
        try NativeAudioAutomation.verifyLimited(crop, rate: rate, from: 501.0 / Double(rate), ceiling: ceiling)
    }

    func testQuietSignalKeepsUnityGainWithoutABlanketTrim() throws {
        let source = [[Float](repeating: 0.2, count: 1024), [Float](repeating: 0.2, count: 1024)]
        var output = source
        try limit(&output, rate: 48000)
        XCTAssertEqual(output, source)
    }

    func testNearCeilingGainRecoversWithoutBreakingCropVerification() throws {
        let source = [[Float](repeating: 0.49, count: 1024), [Float](repeating: 0.49, count: 1024)]
        var output = source
        try limit(&output, rate: 48000)
        let loss = 20 * log10(Double(output[0][500] / source[0][500]))
        XCTAssertLessThan(loss, -1.6)
        XCTAssertGreaterThan(loss, -1.76)
        try NativeAudioAutomation.verifyLimited(output, rate: 48000, from: 0, ceiling: { _ in -6 })
        for length in 1...17 {
            let crop = output.map { Array($0[500..<(500 + length)]) }
            try NativeAudioAutomation.verifyLimited(crop, rate: 48000, from: 500.0 / 48000, ceiling: { _ in -6 })
        }
    }

    func testInvariantFailureRejectsOvershootWithoutAWindowScalarRepair() throws {
        let output = [[Float](repeating: 0.8, count: 64), [Float](repeating: 0.8, count: 64)]
        let before = output
        XCTAssertThrowsError(try NativeAudioAutomation.verifyLimited(output, rate: 48000, from: 0, ceiling: { _ in -6 })) { error in
            XCTAssertTrue(String(describing: error).contains("invariant failed"))
        }
        XCTAssertEqual(output, before)
    }

    func testMalformedVerificationInputRejectsWithoutAnIndexTrap() throws {
        for output in [[], [[]], [[Float(0)], []], [[Float.nan]], [[Float.infinity]]] as [[[Float]]] {
            XCTAssertThrowsError(try NativeAudioAutomation.peakRatio(output, rate: 48000, from: 0, ceiling: { _ in -6 }))
        }
        XCTAssertThrowsError(try NativeAudioAutomation.peakRatio([[0]], rate: 0, from: 0, ceiling: { _ in -6 }))
        XCTAssertThrowsError(try NativeAudioAutomation.peakRatio([[0]], rate: 48000, from: .nan, ceiling: { _ in -6 }))
        XCTAssertThrowsError(try NativeAudioAutomation.peakRatio([[0]], rate: 48000, from: 0, ceiling: { _ in .nan }))
    }

    func testWorkingEstimateIncludesTailAtTreeCapacityBoundaries() {
        for frames in [1023, 1024, 1025, 2047, 2048] {
            var capacity = 1
            while capacity < frames + 12 { capacity *= 2 }
            let expected = Double((frames + 12) * 16 + frames * 8 + capacity * 16 + 16_384)
            XCTAssertEqual(NativeAudioAutomation.workingBytes(effect: ["type": "limiter"], frames: Double(frames), rate: 48000), expected)
        }
    }

    func testStaticLimiterRequiresExactOriginAndRejectsAnOverlongWarmup() throws {
        let graph: [String: Any] = ["from": 0, "to": 2, "rate": 48000, "buses": [],
            "master": ["chain": [], "limiter": ["type": "limiter", "params": ["ceiling": -6, "release": 1, "lookahead": 1]]]]
        let history = try NativeAudioMixer.previewHistory(plan: JSON(any: graph))
        XCTAssertTrue(history.requiresOrigin)
        XCTAssertGreaterThanOrEqual(history.future, 0.00125)
        let window = try NativeAudioRenderRange(from: 2, to: 2.25, history: history, rounding: .delivery)
        XCTAssertEqual(window.begin, 0)
        XCTAssertThrowsError(try NativeAudioRenderRange(from: 3600, to: 3600.1, history: history, rounding: .delivery))
    }

    func testCanceledLimiterAndVerifierReturnNoResult() async throws {
        for verify in [false, true] {
            let gate = LimiterCancellationGate()
            let worker = Task {
                await gate.wait()
                var output = [[Float](repeating: 0.2, count: 10000), [Float](repeating: 0.2, count: 10000)]
                if verify { try NativeAudioAutomation.verifyLimited(output, rate: 48000, from: 0, ceiling: { _ in -6 }) }
                else { try limit(&output, rate: 48000) }
                return output
            }
            for _ in 0..<1000 { if await gate.arrived() { break }; await Task.yield() }
            let arrived = await gate.arrived(); XCTAssertTrue(arrived)
            worker.cancel(); await gate.release()
            do { _ = try await worker.value; XCTFail("Canceled limiter returned a signal") }
            catch is CancellationError { }
        }
    }

    func testOriginPrefixAndAdjacentSelectionsMatchContinuousEnvelope() throws {
        let rate = 8000
        var source = [Float](repeating: 0, count: rate * 3)
        let signs = NativeAudioProcessing.peakPhases[1].reversed().map { Float($0 >= 0 ? 0.49 : -0.49) }
        source.replaceSubrange((rate / 2)..<(rate / 2 + signs.count), with: signs)
        for i in rate..<source.count { source[i] = 0.2 }
        var whole = [source, source]
        let prefix = source.prefix(Int(ceil(2.3 * Double(rate)))).map { $0 }
        try limit(&whole, rate: rate)
        var warmed = [prefix, prefix]; try limit(&warmed, rate: rate)
        for range in [(rate * 2)..<(rate * 2 + rate / 8), (rate * 2 + rate / 8)..<(rate * 2 + rate / 4)] {
            XCTAssertEqual(Array(whole[0][range]), Array(warmed[0][range]))
        }
        XCTAssertEqual(whole[0][rate * 2], Float(0.2))
    }

    func testPreviewDeliveryAndSelectedBackendPathsShareVerifiedOutputAtEveryStage() async throws {
        let rate = 48000, length = rate * 3
        var source = [Float](repeating: 0.2, count: length)
        let signs = NativeAudioProcessing.peakPhases[1].reversed().map { Float($0 >= 0 ? 0.49 : -0.49) }
        source.replaceSubrange((rate / 2)..<(rate / 2 + signs.count), with: signs)
        for stage in ["clip", "track", "master", "nested"] {
            let folder = ProjectFolder(root: try Support.tempFolder("limiter-parity-\(stage)")), core = try ReelCore(scriptURL: Support.core())
            try NativeAudioProcessing.write(.init(channels: [source, source], rate: rate), to: folder.root.appendingPathComponent("source.wav"))
            var project = try JSON.parse(core.newProject(name: "limiter parity")) as! [String: Any]
            project["assets"] = ["source.wav": ["duration": 3, "hasAudio": true]]
            let fx: [String: Any] = ["type": "limiter", "enabled": true, "params": ["ceiling": -6, "release": 100, "lookahead": 5]]
            let clip: [String: Any] = ["id": "source", "kind": "audio", "src": "source.wav", "start": 0, "dur": 3, "in": 0, "fx": stage == "clip" || stage == "nested" ? [fx] : []]
            let tracks: [[String: Any]] = [["id": "A", "kind": "audio", "clips": [clip], "fx": stage == "track" ? [fx] : []]]
            if stage == "nested" {
                project["comps"] = ["nested": ["width": 160, "height": 90, "fps": 10, "tracks": tracks]]
                project["tracks"] = [["id": "N", "kind": "audio", "clips": [["id": "nest", "kind": "comp", "comp": "nested", "start": 0, "dur": 3, "in": 0]]]]
            } else { project["tracks"] = tracks }
            let masterLimiter: [String: Any] = stage == "master" ? ["enabled": true, "ceiling": -6, "release": 100, "lookahead": 5] : ["enabled": false]
            let master: [String: Any] = ["volume": 0, "fx": [] as [Any], "limiter": masterLimiter]
            project["master"] = master
            let text = JSON(any: project).text
            try core.fileText(project: text).write(to: folder.projectFile, atomically: true, encoding: .utf8)
            let backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _, _ in }
            try await backend.start()
            do {
                let plan = JSON.raw(try core.audioPlan(project: text, from: 0, to: 3))
                let whole = try await NativeAudioMixer.render(plan: plan, folder: folder)
                let previewWhole = try await NativeAudioMixer.render(plan: plan, folder: folder, preview: true)
                XCTAssertEqual(whole.channels, previewWhole.channels)
                let before = await backend.currentProject(), version = await backend.currentVersion()
                let deliveryURL = try await backend.renderAudio(from: 2, to: 2.25)
                let playback = try await backend.renderAudioPreview(from: 2, to: 2.25)
                for url in [deliveryURL, playback.url] {
                    let selected = try await NativeAudioProcessing.decode(url)
                    XCTAssertEqual(selected.count, rate / 4)
                    for ch in 0..<2 { for i in 0..<selected.count {
                        XCTAssertEqual(selected.channels[ch][i], whole.channels[ch][rate * 2 + i], accuracy: Float(2.0 / 32768))
                    } }
                }
                let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
                XCTAssertEqual(before, after); XCTAssertEqual(version, afterVersion)
                XCTAssertGreaterThanOrEqual(playback.historySeconds, 2)
                await backend.stop()
            } catch { await backend.stop(); throw error }
        }
    }

    func testSelectedMeasurementAndNativeMovieUseTheSameLimiterEnvelope() async throws {
        let rate = 48000
        let folder = ProjectFolder(root: try Support.tempFolder("limiter-delivery-consumers")), core = try ReelCore(scriptURL: Support.core())
        var source = [Float](repeating: 0.2, count: rate * 3)
        let signs = NativeAudioProcessing.peakPhases[1].reversed().map { Float($0 >= 0 ? 0.49 : -0.49) }
        source.replaceSubrange((rate / 2)..<(rate / 2 + signs.count), with: signs)
        try NativeAudioProcessing.write(.init(channels: [source, source], rate: rate), to: folder.root.appendingPathComponent("source.wav"))
        var project = try JSON.parse(core.newProject(name: "limiter delivery")) as! [String: Any]
        project["width"] = 160; project["height"] = 90; project["fps"] = 10
        project["assets"] = ["source.wav": ["duration": 3, "hasAudio": true]]
        project["tracks"] = [["id": "A", "kind": "audio", "clips": [["id": "source", "kind": "audio", "src": "source.wav", "start": 0, "dur": 3, "in": 0]]]]
        project["master"] = ["volume": 0, "fx": [], "limiter": ["enabled": true, "ceiling": -6, "release": 100, "lookahead": 5]]
        let text = JSON(any: project).text
        try core.fileText(project: text).write(to: folder.projectFile, atomically: true, encoding: .utf8)
        let backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _, _ in }
        try await backend.start()
        do {
            let whole = try await NativeAudioMixer.render(plan: .raw(core.audioPlan(project: text, from: 0, to: 3)), folder: folder)
            let expected = NativeAudioProcessing.PCM(channels: whole.channels.map { Array($0[(rate * 2)..<(rate * 2 + rate / 4)]) }, rate: rate)
            let measured = try NativeAudioProcessing.measure(expected)
            let before = await backend.currentProject(), version = await backend.currentVersion()
            let request = try await call(backend, "/api/audio/measure-mix", ["from": 2, "to": 2.25, "semantics": "export", "output": ["kind": "master"], "comp": NSNull(), "expectedVersion": version, "uiAudioRequestID": UUID().uuidString, "wait": false])
            let job = try await finish(backend, id: XCTUnwrap(request["id"] as? String))
            XCTAssertEqual(job["state"] as? String, "done", JSON(any: job).text)
            let result = try XCTUnwrap(job["result"] as? [String: Any])
            XCTAssertEqual(result["sampleCount"] as? Int, rate / 4)
            XCTAssertEqual((result["lufs"] as? NSNumber)?.doubleValue ?? 0, measured.integrated, accuracy: 1e-6)
            XCTAssertEqual((result["truePeak"] as? NSNumber)?.doubleValue ?? 0, measured.peak, accuracy: 1e-6)
            let movieRequest = try await call(backend, "/api/export", ["renderer": "native", "preset": "h264-high", "name": "Limiter selection", "width": 160, "height": 90, "fps": 10, "range": ["in": 2, "out": 2.25]])
            let movieJob = try await finish(backend, id: XCTUnwrap(movieRequest["id"] as? String))
            XCTAssertEqual(movieJob["state"] as? String, "done", JSON(any: movieJob).text)
            let movie = try await NativeAudioProcessing.decode(folder.resolve(XCTUnwrap(movieJob["output"] as? String)))
            let expectedRMS = sqrt(expected.channels[0].reduce(0.0) { $0 + Double($1) * Double($1) } / Double(expected.count))
            let actualRMS = sqrt(movie.channels[0].reduce(0.0) { $0 + Double($1) * Double($1) } / Double(movie.count))
            XCTAssertEqual(movie.duration, 0.25, accuracy: 0.1)
            XCTAssertEqual(actualRMS, expectedRMS, accuracy: expectedRMS * 0.1 + 0.0001)
            let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
            XCTAssertEqual(before, after); XCTAssertEqual(version, afterVersion)
            await backend.stop()
        } catch { await backend.stop(); throw error }
    }

    private func call(_ backend: ReelBackend, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        let response = try await backend.handle(method: body == nil ? "GET" : "POST", path: path, body: body.map { JSON(any: $0).text })
        return try JSON.parse(response.text) as? [String: Any] ?? [:]
    }
    private func finish(_ backend: ReelBackend, id: String) async throws -> [String: Any] {
        for _ in 0..<600 {
            let job = try await call(backend, "/api/jobs/wait?id=\(id)&timeout=100")
            if ["done", "failed"].contains(job["state"] as? String ?? "") { return job }
        }
        throw ReelBackend.APIError("The queued limiter consumer did not finish")
    }

    private func limit(_ audio: inout [[Float]], rate: Int) throws {
        try NativeAudioAutomation.limit(&audio, rate: rate, from: 0, ceiling: { _ in -6 }, lookahead: { _ in 1 }, release: { _ in 1 })
    }
}
