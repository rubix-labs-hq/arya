import Foundation
import XCTest
@testable import ReelKit

private actor RangeTrimGate {
    private var ready = false
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        ready = true
        if !released { await withCheckedContinuation { continuation = $0 } }
    }
    func arrived() -> Bool { ready }
    func release() { released = true; continuation?.resume(); continuation = nil }
}

/// Queued native behavior tests. These require the recipe, DSP and range patches together.
final class NativeAudioRangeHistoryTests: XCTestCase {
    private let rate = 48000
    private let quantization = Float(2.0 / 32768)

    func testRangeKeepsDeliveryCeilAndPlaybackRoundWithBoundedHistory() throws {
        let history = NativeAudioMixer.History(seconds: 0.3, future: 0.02225, requiresOrigin: false)
        let from = 2.0, to = from + 48000.4 / 48000
        let playback = try NativeAudioRenderRange(from: from, to: to, history: history, rounding: .playback)
        let delivery = try NativeAudioRenderRange(from: from, to: to, history: history, rounding: .delivery)
        XCTAssertEqual(playback.cropCount, 48000); XCTAssertEqual(delivery.cropCount, 48001)
        XCTAssertEqual(delivery.cropStart, 14400)
        XCTAssertGreaterThanOrEqual(delivery.end, to + history.future)
        XCTAssertEqual(delivery.historySeconds, 0.3, accuracy: 1e-9)
        for bad in [Double.nan, .infinity, -1] {
            XCTAssertThrowsError(try NativeAudioRenderRange(from: bad, to: 3, history: history, rounding: .delivery))
        }
        XCTAssertThrowsError(try NativeAudioRenderRange(from: 0, to: 3600, history: history, rounding: .delivery))
        XCTAssertThrowsError(try NativeAudioRenderRange(from: 3600, to: 3601,
            history: .init(seconds: 0, future: 0, requiresOrigin: true), rounding: .delivery))
    }

    func testTrimCopiesOnlyRequestedStereoSamplesAndRejectsShortPCM() throws {
        let window = try NativeAudioRenderRange(from: 1, to: 1.001,
            history: .init(seconds: 1, future: 0.002, requiresOrigin: true), rounding: .delivery)
        let samples = (0..<Int(ceil(window.end * Double(rate)))).map { Float($0) }
        let pcm = NativeAudioProcessing.PCM(channels: [samples, samples], rate: rate)
        let trim = try window.trim(pcm)
        XCTAssertEqual(trim.count, window.cropCount)
        XCTAssertEqual(trim.channels[0], Array(samples[window.samples]))
        XCTAssertThrowsError(try window.trim(.init(channels: [samples], rate: rate)))
        XCTAssertThrowsError(try window.trim(.init(channels: [[0], [0]], rate: rate)))
    }

    func testCanceledTrimDoesNotReturnPCM() async throws {
        let gate = RangeTrimGate()
        let window = try NativeAudioRenderRange(from: 0, to: 1,
            history: .init(seconds: 0, future: 0, requiresOrigin: false), rounding: .delivery)
        let pcm = NativeAudioProcessing.PCM(channels: [[Float](repeating: 0, count: rate), [Float](repeating: 0, count: rate)], rate: rate)
        let worker = Task { await gate.wait(); return try window.trim(pcm) }
        for _ in 0..<1000 { if await gate.arrived() { break }; await Task.yield() }
        let arrived = await gate.arrived()
        XCTAssertTrue(arrived)
        worker.cancel(); await gate.release()
        do { _ = try await worker.value; XCTFail("Canceled cropping returned samples") }
        catch is CancellationError { }
    }

    func testMidTailDelayDeliveryAndPreviewMatchContinuousRender() async throws {
        try await verifyTail("delay", params: ["time": 100, "feedback": 0.2, "mix": 0.8])
    }

    func testMidTailReverbDeliveryAndPreviewMatchContinuousRender() async throws {
        try await verifyTail("reverb", params: ["size": 0.5, "decay": 0.5, "predelay": 20, "mix": 0.7])
    }

    func testLimiterReleaseHistorySurvivesSelectedRangeDelivery() async throws {
        let source = (0..<(rate * 4)).map { i -> Float in
            if ((rate / 4)..<(rate / 4 + 480)).contains(i) { return 0.9 }
            return 0.05
        }
        try await fixture("range-limiter", source: source,
            fx: effect("limiter", ["ceiling": -6, "release": 1000, "lookahead": 5])) { folder, backend, core, project in
            let whole = try await NativeAudioMixer.render(plan: .raw(core.audioPlan(project: project, from: 0, to: 4)), folder: folder)
            let url = try await backend.renderAudio(from: 2, to: 3)
            let selected = try await NativeAudioProcessing.decode(url)
            assertSamples(selected, match: whole, at: rate * 2)
            let preview = try await backend.renderAudioPreview(from: 2, to: 3)
            let playback = try await NativeAudioProcessing.decode(preview.url)
            assertSamples(playback, match: whole, at: rate * 2)
            XCTAssertGreaterThan(preview.historySeconds, 1.9)
        }
    }

    func testNestedScopeAndOuterCompositionRetainEndedChildTailAndMeterCrop() async throws {
        let fx = effect("delay", ["time": 100, "feedback": 0.2, "mix": 0.8])
        try await fixture("range-nested", source: burst(), fx: fx, clipDuration: 1.95, nested: true) { folder, backend, core, project in
            for comp in [nil, "nested"] as [String?] {
                let scoped = try scope(project, comp: comp)
                let whole = try await NativeAudioMixer.render(plan: .raw(core.audioPlan(project: scoped, from: 0, to: 4)), folder: folder)
                let url = try await backend.renderAudio(from: 2, to: 3, comp: comp)
                let selected = try await NativeAudioProcessing.decode(url)
                assertSamples(selected, match: whole, at: rate * 2)
                XCTAssertGreaterThan(rms(selected.channels[0]), 0.0001)
                let preview = try await backend.renderAudioPreview(from: 2, to: 3, comp: comp)
                let playback = try await NativeAudioProcessing.decode(preview.url)
                assertSamples(playback, match: whole, at: rate * 2)
                XCTAssertEqual(preview.composition, comp)
                XCTAssertEqual(preview.meters.frameCount, rate)
                XCTAssertTrue(preview.meters.valid)
                let bins = try XCTUnwrap(preview.meters.buses[comp == nil ? "N" : "A"])
                XCTAssertEqual(bins.reduce(0) { $0 + $1.frameCount }, rate)
                let meterPower = bins.reduce(0.0) { $0 + $1.leftSumSquares }
                let expectedPower = whole.channels[0][(rate * 2)..<(rate * 3)].reduce(0.0) { $0 + Double($1) * Double($1) }
                XCTAssertEqual(meterPower, expectedPower, accuracy: max(1e-8, expectedPower * 1e-6))
            }
        }
    }

    func testReverbControlRiseAfterRequestedEndUsesSameAbsoluteAnchorAsContinuousRender() async throws {
        let fx = effect("reverb", ["size": 0.1, "decay": 0.5, "predelay": 0, "mix": 1])
        let animation: [String: Any] = [
            "fx.0.params.size": [[0, 0.1], [3, 0.1], [3.4, 0.9], [4, 0.9]],
            "fx.0.params.decay": [[0, 0.5], [3, 0.5], [3.4, 1.2], [4, 1.2]]
        ]
        try await fixture("range-reverb-future", source: burst(at: 2.9), fx: fx, animation: animation) { folder, backend, core, project in
            let overview = try core.audioPlan(project: project, from: 0, to: 3.11)
            let history = try NativeAudioMixer.previewHistory(plan: .raw(overview))
            XCTAssertTrue(history.requiresOrigin); XCTAssertGreaterThanOrEqual(history.future, 0.272)
            let whole = try await NativeAudioMixer.render(plan: .raw(core.audioPlan(project: project, from: 0, to: 4)), folder: folder)
            let url = try await backend.renderAudio(from: 3, to: 3.11)
            let selected = try await NativeAudioProcessing.decode(url)
            assertSamples(selected, match: whole, at: rate * 3)
            XCTAssertGreaterThan(rms(selected.channels[0]), 0.00001)
            let unwarmed = try await NativeAudioMixer.render(plan: .raw(overview), folder: folder)
            let window: Range<Int> = (rate * 3)..<(rate * 3 + selected.count)
            let unwarmedWindow: ArraySlice<Float> = unwarmed.channels[0][window]
            let wholeWindow: ArraySlice<Float> = whole.channels[0][window]
            var difference = 0.0
            for (a, b) in zip(unwarmedWindow, wholeWindow) { difference += abs(Double(a) - Double(b)) }
            XCTAssertGreaterThan(difference, 0.0001, "The fixture must exercise the missing right kernel control")
        }
    }

    func testLookaheadRiseAfterRequestedEndIncludesTheNextControlSample() async throws {
        var source = [Float](repeating: 0.2, count: rate * 4)
        source[Int(3.011 * Double(rate))] = 0.99
        let animation: [String: Any] = ["fx.0.params.lookahead": [[0, 1], [2.99, 1], [3.02, 20], [4, 20]]]
        try await fixture("range-limiter-future", source: source,
            fx: effect("limiter", ["ceiling": -6, "release": 60, "lookahead": 1]), animation: animation) { folder, backend, core, project in
            let overview = try core.audioPlan(project: project, from: 0, to: 3.005)
            let history = try NativeAudioMixer.previewHistory(plan: .raw(overview))
            XCTAssertGreaterThanOrEqual(history.future, 0.02225)
            let whole = try await NativeAudioMixer.render(plan: .raw(core.audioPlan(project: project, from: 0, to: 4)), folder: folder, preview: true)
            let preview = try await backend.renderAudioPreview(from: 2.98, to: 3.005)
            let selected = try await NativeAudioProcessing.decode(preview.url)
            assertSamples(selected, match: whole, at: Int((2.98 * Double(rate)).rounded()))
            XCTAssertLessThan(try XCTUnwrap(selected.channels[0].last), 0.15)
        }
    }

    func testAnimatedGainAndPanMatchContinuousSamplingAtBothRangeBoundaries() async throws {
        let source = (0..<(rate * 4)).map { Float(0.1 * sin(2 * .pi * 173 * Double($0) / Double(rate))) }
        let animation: [String: Any] = [
            "volume": [[0, -24], [2.98, -24], [3, 0], [3.02, -24], [4, -24]],
            "pan": [[0, -0.8], [2.98, -0.8], [3, 0.8], [3.02, -0.8], [4, -0.8]]
        ]
        try await fixture("range-gain-pan", source: source, fx: effect("gain", ["gain": 0]), animation: animation) { folder, backend, core, project in
            let overview = try core.audioPlan(project: project, from: 0, to: 3.005)
            let history = try NativeAudioMixer.previewHistory(plan: .raw(overview))
            XCTAssertTrue(history.requiresOrigin); XCTAssertGreaterThanOrEqual(history.future, 0.022)
            let whole = try await NativeAudioMixer.render(plan: .raw(core.audioPlan(project: project, from: 0, to: 4)), folder: folder)
            let url = try await backend.renderAudio(from: 2.981, to: 3.005)
            let delivery = try await NativeAudioProcessing.decode(url)
            assertSamples(delivery, match: whole, at: Int((2.981 * Double(rate)).rounded()))
            let preview = try await backend.renderAudioPreview(from: 2.981, to: 3.005)
            let playback = try await NativeAudioProcessing.decode(preview.url)
            assertSamples(playback, match: whole, at: Int((2.981 * Double(rate)).rounded()))
        }
    }

    func testChangingReverbMixIncludesItsNextControlAfterRangeEnd() async throws {
        let animation: [String: Any] = ["fx.0.params.mix": [[0, 0.1], [3.1, 0.1], [3.12, 0.9], [4, 0.9]]]
        try await fixture("range-reverb-mix", source: burst(at: 2.9),
            fx: effect("reverb", ["size": 0.5, "decay": 0.5, "predelay": 0, "mix": 0.1]), animation: animation) { folder, backend, core, project in
            let history = try NativeAudioMixer.previewHistory(plan: .raw(core.audioPlan(project: project, from: 0, to: 3.105)))
            XCTAssertGreaterThanOrEqual(history.future, 0.022)
            let whole = try await NativeAudioMixer.render(plan: .raw(core.audioPlan(project: project, from: 0, to: 4)), folder: folder)
            let url = try await backend.renderAudio(from: 3.08, to: 3.105)
            let selected = try await NativeAudioProcessing.decode(url)
            assertSamples(selected, match: whole, at: Int((3.08 * Double(rate)).rounded()))
            XCTAssertGreaterThan(rms(selected.channels[0]), 0.00001)
        }
    }

    func testChangingLimiterCeilingIncludesItsNextControlAfterRangeEnd() async throws {
        let animation: [String: Any] = ["fx.0.params.ceiling": [[0, -6], [3.1, -6], [3.12, -18], [4, -18]]]
        try await fixture("range-limiter-ceiling", source: [Float](repeating: 0.2, count: rate * 4),
            fx: effect("limiter", ["ceiling": -6, "release": 60, "lookahead": 1]), animation: animation) { folder, backend, core, project in
            let history = try NativeAudioMixer.previewHistory(plan: .raw(core.audioPlan(project: project, from: 0, to: 3.105)))
            XCTAssertGreaterThanOrEqual(history.future, 0.02325)
            let whole = try await NativeAudioMixer.render(plan: .raw(core.audioPlan(project: project, from: 0, to: 4)), folder: folder, preview: true)
            let preview = try await backend.renderAudioPreview(from: 3.08, to: 3.105)
            let selected = try await NativeAudioProcessing.decode(preview.url)
            assertSamples(selected, match: whole, at: Int((3.08 * Double(rate)).rounded()))
        }
    }

    func testSelectedExportMeasurementUsesTailAndOnlyRequestedSamplesWithoutAnEdit() async throws {
        try await fixture("range-measure", source: burst(), fx: effect("delay", ["time": 100, "feedback": 0.2, "mix": 0.8]), clipDuration: 1.95) { folder, backend, core, project in
            let before = await backend.currentProject(), version = await backend.currentVersion()
            let disk = try Data(contentsOf: folder.projectFile)
            let whole = try await NativeAudioMixer.render(plan: .raw(core.audioPlan(project: project, from: 0, to: 4)), folder: folder)
            let expected = try NativeAudioProcessing.measure(.init(channels: whole.channels.map { Array($0[(rate * 2)..<(rate * 3)]) }, rate: rate))
            let response = try await call(backend, "/api/audio/measure-mix", ["from": 2, "to": 3, "semantics": "export", "output": ["kind": "master"], "comp": NSNull(), "expectedVersion": version, "uiAudioRequestID": UUID().uuidString, "wait": false])
            let job = try await finish(backend, id: XCTUnwrap(response["id"] as? String))
            XCTAssertEqual(job["state"] as? String, "done"); XCTAssertNil(job["output"])
            let result = try XCTUnwrap(job["result"] as? [String: Any])
            XCTAssertEqual(result["sampleCount"] as? Int, rate)
            XCTAssertGreaterThan(result["sampleStart"] as? Int ?? 0, 0)
            XCTAssertEqual((result["lufs"] as? NSNumber)?.doubleValue ?? 0, expected.integrated, accuracy: 1e-6)
            XCTAssertEqual((result["truePeak"] as? NSNumber)?.doubleValue ?? 0, expected.peak, accuracy: 1e-6)
            let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
            XCTAssertEqual(after, before); XCTAssertEqual(afterVersion, version)
            XCTAssertEqual(try Data(contentsOf: folder.projectFile), disk)
            XCTAssertFalse(FileManager.default.fileExists(atPath: folder.rendersDir.path))
        }
    }

    func testCurveAwareReservationsShareRenderEstimateAndRejectExactUndersizedBudget() throws {
        func plan(_ fx: [String: Any]) -> String {
            JSON(any: ["from": 0, "to": 1, "rate": rate, "buses": [["id": "A", "items": [], "chain": [fx]]], "master": ["gain": 1, "chain": []]]).text
        }
        let fixed = plan(effect("reverb", ["decay": 0.1]))
        var changing = effect("reverb", ["decay": 0.1])
        changing["curves"] = ["decay": ["from": 0, "step": 0.02, "values": [0.1, 10]]]
        let animated = plan(changing)
        let small = try NativeAudioMixCapture.reservationBytes(plan: fixed, croppedFrames: rate)
        let large = try NativeAudioMixCapture.reservationBytes(plan: animated, croppedFrames: rate)
        XCTAssertGreaterThan(large, small)
        let working = try NativeAudioMixer.estimatedMemoryBytes(plan: .raw(animated))
        XCTAssertGreaterThan(large, working)
        try NativeAudioMixCapture.validateMemory(plan: animated, croppedFrames: rate, limit: large)
        XCTAssertThrowsError(try NativeAudioMixCapture.validateMemory(plan: animated, croppedFrames: rate, limit: large - 1))
        let limiter = plan(effect("limiter", ["ceiling": -6]))
        XCTAssertGreaterThan(try NativeAudioMixer.estimatedMemoryBytes(plan: .raw(limiter)), try NativeAudioMixer.estimatedMemoryBytes(plan: .raw(plan(effect("gain", ["gain": 0])))))
    }

    func testNativeMovieMuxStartsAtRequestedTailInsteadOfHistory() async throws {
        try await fixture("range-movie", source: burst(), fx: effect("delay", ["time": 350, "feedback": 0.25, "mix": 1]), clipDuration: 1.95, nested: true) { folder, backend, _, _ in
            let referenceURL = try await backend.renderAudio(from: 2, to: 3)
            let reference = try await NativeAudioProcessing.decode(referenceURL)
            let response = try await call(backend, "/api/export", ["renderer": "native", "preset": "h264-high", "name": "Selected tail", "width": 160, "height": 90, "fps": 10, "range": ["in": 2, "out": 3]])
            let job = try await finish(backend, id: XCTUnwrap(response["id"] as? String))
            XCTAssertEqual(job["state"] as? String, "done", JSON(any: job).text)
            let output = try XCTUnwrap(job["output"] as? String)
            let movie = try await NativeAudioProcessing.decode(folder.resolve(output))
            XCTAssertEqual(movie.duration, 1, accuracy: 0.1)
            let expectedRMS = rms(reference.channels[0]), actualRMS = rms(movie.channels[0])
            XCTAssertGreaterThan(actualRMS, 0.0001)
            XCTAssertEqual(actualRMS, expectedRMS, accuracy: expectedRMS * 0.25 + 0.0001)
        }
    }

    private func verifyTail(_ type: String, params: [String: Any]) async throws {
        try await fixture("range-\(type)", source: burst(), fx: effect(type, params), clipDuration: 1.95) { folder, backend, core, project in
            let whole = try await NativeAudioMixer.render(plan: .raw(core.audioPlan(project: project, from: 0, to: 4)), folder: folder)
            let url = try await backend.renderAudio(from: 2, to: 3)
            let selected = try await NativeAudioProcessing.decode(url)
            XCTAssertEqual(selected.count, rate)
            assertSamples(selected, match: whole, at: rate * 2)
            XCTAssertGreaterThan(rms(selected.channels[0]), 0.00001)
            let preview = try await backend.renderAudioPreview(from: 2, to: 3)
            let playback = try await NativeAudioProcessing.decode(preview.url)
            assertSamples(playback, match: whole, at: rate * 2)
            XCTAssertEqual(preview.meters.frameCount, rate)
        }
    }

    private func effect(_ type: String, _ params: [String: Any]) -> [String: Any] { ["type": type, "enabled": true, "params": params] }
    private func burst(at: Double = 1.9) -> [Float] {
        let start = Int((at * Double(rate)).rounded())
        return (0..<(rate * 4)).map { i in
            (start..<(start + 480)).contains(i) ? Float(0.2 * sin(2 * .pi * 350 * Double(i - start) / Double(rate))) : 0
        }
    }
    private func scope(_ project: String, comp: String?) throws -> String {
        guard let comp else { return project }
        var p = try JSON.parse(project) as! [String: Any]
        let c = try XCTUnwrap((p["comps"] as? [String: [String: Any]])?[comp])
        p["tracks"] = c["tracks"]; p["compId"] = comp
        for key in ["width", "height", "fps", "background"] { if let value = c[key] { p[key] = value } }
        return JSON(any: p).text
    }
    private func fixture(_ name: String, source: [Float], fx: [String: Any], clipDuration: Double = 4,
                         animation: [String: Any] = [:], nested: Bool = false,
                         action: (ProjectFolder, ReelBackend, ReelCore, String) async throws -> Void) async throws {
        let folder = ProjectFolder(root: try Support.tempFolder(name)), core = try ReelCore(scriptURL: Support.core())
        try NativeAudioProcessing.write(.init(channels: [source, source], rate: rate), to: folder.root.appendingPathComponent("source.wav"))
        var p = try JSON.parse(core.newProject(name: name)) as! [String: Any]
        p["width"] = 160; p["height"] = 90; p["fps"] = 10
        p["assets"] = ["source.wav": ["duration": 4, "hasAudio": true]]
        let clip: [String: Any] = ["id": "source", "kind": "audio", "src": "source.wav", "start": 0, "dur": clipDuration, "in": 0, "fx": [fx], "anim": animation]
        let tracks: [[String: Any]] = [["id": "A", "kind": "audio", "clips": [clip]]]
        if nested {
            p["comps"] = ["nested": ["width": 160, "height": 90, "fps": 10, "tracks": tracks]]
            p["tracks"] = [["id": "N", "kind": "audio", "clips": [["id": "nest", "kind": "comp", "comp": "nested", "start": 0, "dur": 4, "in": 0]]]]
        } else { p["tracks"] = tracks }
        p["master"] = ["volume": 0, "fx": [], "limiter": ["enabled": false]]
        let project = JSON(any: p).text
        try core.fileText(project: project).write(to: folder.projectFile, atomically: true, encoding: .utf8)
        let backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _, _ in }
        try await backend.start()
        do { try await action(folder, backend, core, project); await backend.stop() }
        catch { await backend.stop(); throw error }
    }
    private func assertSamples(_ actual: NativeAudioProcessing.PCM, match expected: NativeAudioProcessing.PCM, at offset: Int,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.rate, expected.rate, file: file, line: line)
        XCTAssertEqual(actual.channels.count, 2, file: file, line: line)
        guard actual.channels.count == 2, expected.channels.count == 2, offset >= 0,
              expected.count >= offset + actual.count else { XCTFail("Comparison PCM is too short", file: file, line: line); return }
        var error: Float = 0
        for channel in 0..<2 { for i in 0..<actual.count { error = max(error, abs(actual.channels[channel][i] - expected.channels[channel][offset + i])) } }
        XCTAssertLessThanOrEqual(error, quantization, file: file, line: line)
    }
    private func rms(_ values: [Float]) -> Double { sqrt(values.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(max(1, values.count))) }
    private func call(_ backend: ReelBackend, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        let response = try await backend.handle(method: body == nil ? "GET" : "POST", path: path, body: body.map { JSON(any: $0).text })
        return try JSON.parse(response.text) as? [String: Any] ?? [:]
    }
    private func finish(_ backend: ReelBackend, id: String) async throws -> [String: Any] {
        for _ in 0..<600 {
            let job = try await call(backend, "/api/jobs/wait?id=\(id)&timeout=100")
            if ["done", "failed"].contains(job["state"] as? String ?? "") { return job }
        }
        throw ReelBackend.APIError("The selected-range job did not finish")
    }
}
