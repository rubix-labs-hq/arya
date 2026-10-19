import Foundation
import XCTest
@testable import ReelKit

final class NativeAudioAutomationTests: XCTestCase {
    func testRangeMaximumHandlesShrinkingAndExpandingWindows() throws {
        let values = [0.2, 0.3, 0.4, 5, 0.6, 0.7, 2, 0.1, 0.2]
        let query = try NativeAudioAutomation.RangeMaximum(values)
        XCTAssertEqual(query.maximum(0..<7), 5)
        XCTAssertEqual(query.maximum(1..<3), 0.4)
        XCTAssertEqual(query.maximum(4..<5), 0.6)
        XCTAssertEqual(query.maximum(4..<9), 2)
        for begin in values.indices { for end in (begin + 1)...values.count {
            XCTAssertEqual(query.maximum(begin..<end), values[begin..<end].max() ?? 0)
        } }
    }

    func testLimiterTracksCeilingAndVerifiesReconstructedPeaks() throws {
        let rate = 8000, count = rate * 2
        let signal = (0..<count).map { Float(1.5 * sin(2 * .pi * 83 * Double($0) / Double(rate))) }
        var audio = [signal, signal]
        func ceiling(_ time: Double) -> Double { time < 1 ? -18 : -1 }
        try NativeAudioAutomation.limit(&audio, rate: rate, from: 0,
            ceiling: ceiling, lookahead: { _ in 5 }, release: { _ in 1 })
        let ratio = try NativeAudioAutomation.peakRatio(audio, rate: rate, from: 0, ceiling: ceiling)
        XCTAssertLessThanOrEqual(ratio, 1.00001)
        let quiet = rms(audio[0][(rate / 4)..<(rate / 2)]), loud = rms(audio[0][(rate * 3 / 2)..<(rate * 7 / 4)])
        XCTAssertGreaterThan(loud, quiet * 5)
    }

    func testShrinkingLookaheadStopsReadingTheRemovedFuturePeak() throws {
        let rate = 1000
        var signal = [Float](repeating: 0.2, count: 1000); signal[510] = 10
        var audio = [signal, signal]
        try NativeAudioAutomation.limit(&audio, rate: rate, from: 0,
            ceiling: { _ in -6 }, lookahead: { $0 < 0.491 ? 20 : 1 }, release: { _ in 1 })
        XCTAssertGreaterThan(audio[0][491], audio[0][490] * 5)
        XCTAssertLessThanOrEqual(abs(audio[0][510]), Float(pow(10, -6.0 / 20)) + 0.00001)
    }

    func testChangingReleaseControlsRecoveryAfterAPeak() throws {
        let rate = 1000
        var signal = [Float](repeating: 0.2, count: 1000); signal[100] = 10
        var slow = [signal, signal], fast = slow
        try NativeAudioAutomation.limit(&slow, rate: rate, from: 0,
            ceiling: { _ in -6 }, lookahead: { _ in 1 }, release: { _ in 1000 })
        try NativeAudioAutomation.limit(&fast, rate: rate, from: 0,
            ceiling: { _ in -6 }, lookahead: { _ in 1 }, release: { $0 < 0.2 ? 1000 : 1 })
        XCTAssertGreaterThan(fast[0][210], slow[0][210] * 4)
    }

    func testRangeConvolutionRetainsCausalHistoryAcrossSegments() throws {
        let signal = (0..<1200).map { Float(sin(Double($0) * 0.13)) }
        let impulse = (0..<73).map { Float(exp(-Double($0) / 20) * cos(Double($0) * 0.7)) }
        let range = 390..<910
        let result = try NativeAudioAutomation.convolveRange(signal, impulse, range: range)
        for i in range {
            let expected = (0..<min(impulse.count, i + 1)).reduce(0.0) { $0 + Double(signal[i - $1]) * Double(impulse[$1]) }
            XCTAssertEqual(Double(result[i - range.lowerBound]), expected, accuracy: 0.00001)
        }
    }

    func testConstantKernelSegmentsMatchWholeRangeConvolution() throws {
        let rate = 8000, signal = (0..<rate).map { Float(sin(Double($0) * 0.13)) }
        var whole = [signal, signal], segments = whole
        try reverb(&whole, rate: rate, changing: false, size: { _ in 0.5 }, decay: { _ in 0.5 })
        try reverb(&segments, rate: rate, changing: true, size: { _ in 0.5 }, decay: { _ in 0.5 })
        for ch in whole.indices { for i in signal.indices {
            XCTAssertEqual(segments[ch][i], whole[ch][i], accuracy: 0.000001)
        } }
    }

    func testSizeAndDecayAutomationChangesWetOutputWithoutLosingTheTail() throws {
        let rate = 8000
        var signal = [Float](repeating: 0, count: rate); signal[1900] = 1; signal[3900] = 1
        var automated = [signal, signal], fixed = automated
        try reverb(&automated, rate: rate, changing: true, size: { min(1, $0) }, decay: { 0.1 + $0 })
        try reverb(&fixed, rate: rate, changing: false, size: { _ in 0 }, decay: { _ in 0.1 })
        let difference = zip(automated[0], fixed[0]).reduce(0.0) { $0 + abs(Double($1.0) - Double($1.1)) }
        XCTAssertGreaterThan(difference, 0.01)
        XCTAssertGreaterThan(abs(automated[0][2000]), 0)
        XCTAssertTrue(automated.flatMap { $0 }.allSatisfy { $0.isFinite })
    }

    func testReverbKeepsAnExcursionInsideOneControlGridInterval() throws {
        let curve: [String: Any] = ["from": 0, "step": 0.1, "values": [0.0, 1.0, 0.0]]
        let corners = try NativeAudioAutomation.kernelCorners(["size": curve])
        XCTAssertTrue(corners.contains(0.1)); XCTAssertTrue(corners.contains(0.2))
        let rate = 8000
        var signal = [Float](repeating: 0, count: 2000); signal[700] = 1
        var animated = [signal, signal], fixed = animated
        func size(_ time: Double) -> Double { max(0, time < 0.1 ? time * 10 : 2 - time * 10) }
        func impulse(_ size: Double, _ decay: Double) -> [[Float]] {
            var signal = [Float](repeating: 0, count: 200); signal[0] = 1; signal[100] = Float(0.1 + size)
            return [signal, signal]
        }
        try NativeAudioAutomation.reverb(&animated, rate: rate, from: 0, changingKernel: true, corners: corners,
            size: size, decay: { _ in 0.5 }, predelay: { _ in 0 }, mix: { _ in 1 }, impulse: impulse)
        try NativeAudioAutomation.reverb(&fixed, rate: rate, from: 0, changingKernel: false,
            size: { _ in 0 }, decay: { _ in 0.5 }, predelay: { _ in 0 }, mix: { _ in 1 }, impulse: impulse)
        XCTAssertGreaterThan(animated[0][800], fixed[0][800] * 4)
    }

    func testSubsampleCurveCornersAdvanceToTheCurrentOutputTime() throws {
        let values = (0...150).map { $0 % 2 == 0 ? 0.0 : 1.0 }, step = 0.0001
        let corners = try NativeAudioAutomation.kernelCorners(["size": ["from": 0, "step": step, "values": values]])
        var source = [Float](repeating: 0, count: 2000); source[0] = 1
        var animated = [source, source], fixed = animated
        func size(_ time: Double) -> Double {
            let position = max(0, min(Double(values.count - 1), time / step)), index = Int(position)
            return values[index] + (values[min(values.count - 1, index + 1)] - values[index]) * (position - Double(index))
        }
        func impulse(_ size: Double, _ decay: Double) -> [[Float]] {
            var signal = [Float](repeating: 0, count: 200); signal[0] = 1; signal[100] = Float(0.1 + size)
            return [signal, signal]
        }
        try NativeAudioAutomation.reverb(&animated, rate: 8000, from: 0, changingKernel: true, corners: corners,
            size: size, decay: { _ in 0.5 }, predelay: { _ in 0 }, mix: { _ in 1 }, impulse: impulse)
        try NativeAudioAutomation.reverb(&fixed, rate: 8000, from: 0, changingKernel: false,
            size: { _ in 0 }, decay: { _ in 0.5 }, predelay: { _ in 0 }, mix: { _ in 1 }, impulse: impulse)
        XCTAssertGreaterThan(animated[0][100], fixed[0][100] * 4)
    }

    func testCurveBoundsDriveMemoryAndPreviewFutureAdmission() throws {
        let fixed: [String: Any] = ["type": "reverb", "params": ["decay": 0.1]]
        let animated: [String: Any] = ["type": "reverb", "params": ["decay": 0.1], "curves": ["decay": ["from": 0, "step": 1, "values": [0.1, 10]]]]
        XCTAssertGreaterThan(NativeAudioAutomation.workingBytes(effect: animated, frames: 48000, rate: 48000), NativeAudioAutomation.workingBytes(effect: fixed, frames: 48000, rate: 48000))
        let limiter: [String: Any] = ["type": "limiter", "params": ["lookahead": 1], "curves": ["lookahead": ["from": 0, "step": 1, "values": [1, 20]], "release": ["values": [1, 1000]]]]
        let graph: [String: Any] = ["from": 0, "to": 2, "rate": 48000, "buses": [], "master": ["chain": [animated], "limiter": limiter]]
        let history = try NativeAudioMixer.previewHistory(plan: JSON(any: graph))
        XCTAssertTrue(history.requiresOrigin)
        XCTAssertGreaterThanOrEqual(history.future, 0.02025)
        XCTAssertGreaterThan(history.seconds, 29)
        XCTAssertThrowsError(try NativeAudioMixer.validate(plan: JSON(any: graph), limit: 1024))
        try NativeAudioMixer.validateAutomation(graph)
    }

    func testMalformedAutomationRejectsBeforeRendering() throws {
        let invalid: [[Any]] = [[true, false], [1, "2"], [1, Double.infinity], [], [1, 21]]
        for values in invalid {
            let effect: [String: Any] = ["type": "limiter", "curves": ["lookahead": ["values": values]]]
            XCTAssertThrowsError(try NativeAudioAutomation.validate(effect: effect))
        }
        XCTAssertThrowsError(try NativeAudioAutomation.validate(effect: ["type": "reverb", "params": ["decay": false]]))
        XCTAssertThrowsError(try NativeAudioAutomation.validate(effect: ["type": "reverb", "curves": ["size": ["step": 0, "values": [0, 1]]]]))
        XCTAssertThrowsError(try NativeAudioAutomation.validate(effect: ["type": "limiter", "curves": true]))
        XCTAssertThrowsError(try NativeAudioAutomation.validate(effect: ["type": "reverb", "params": "bad"]))
        XCTAssertThrowsError(try NativeAudioAutomation.validate(effect: ["type": "reverb", "curves": ["damping": ["values": [0, 1]]]]))
    }

    private func rms(_ values: ArraySlice<Float>) -> Double {
        sqrt(values.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(values.count))
    }

    private func reverb(_ audio: inout [[Float]], rate: Int, changing: Bool, size: @escaping (Double) -> Double, decay: @escaping (Double) -> Double) throws {
        try NativeAudioAutomation.reverb(&audio, rate: rate, from: 0, changingKernel: changing, size: size, decay: decay,
            predelay: { _ in 0 }, mix: { _ in 1 }, impulse: { size, decay in
                var impulse = [Float](repeating: 0, count: 200)
                impulse[0] = 1; impulse[100] = Float(0.1 + size); impulse[150] = Float(decay)
                return [impulse, impulse]
            })
    }
}
