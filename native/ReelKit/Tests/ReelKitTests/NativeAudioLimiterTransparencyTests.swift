import Foundation
import XCTest
@testable import ReelKit

private final class LimiterRefinementProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var checkpoints: [Int] = []
    private var cancellationRequested = false

    func checkpoint(_ index: Int) {
        lock.lock()
        checkpoints.append(index)
        lock.unlock()
        guard index == 256 else { return }
        let requested = withUnsafeCurrentTask { task in
            guard let task else { return false }
            task.cancel()
            return task.isCancelled
        }
        lock.lock()
        cancellationRequested = requested
        lock.unlock()
    }

    func snapshot() -> (checkpoints: [Int], cancellationRequested: Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (checkpoints, cancellationRequested)
    }
}

private struct LimiterRefinementOutcome: Sendable {
    let audio: [[Float]]
    let cancelled: Bool
    let unexpectedError: String?
}

final class NativeAudioLimiterTransparencyTests: XCTestCase {
    private let rate = 48000

    private func limit(_ audio: inout [[Float]], lookahead: Double = 1, release: Double = 1) throws {
        try NativeAudioAutomation.limit(&audio, rate: rate, from: 0, ceiling: { _ in -6 },
            lookahead: { _ in lookahead }, release: { _ in release })
    }

    private func cropSafeConstantGain(amplitude: Double) -> Double {
        var largest = 1.0
        for phase in NativeAudioProcessing.peakPhases {
            for begin in phase.indices {
                var sum = 0.0
                for end in begin..<phase.count {
                    sum += phase[end]
                    largest = max(largest, abs(sum))
                }
            }
        }
        return min(1, pow(10, -6.0 / 20) / (amplitude * largest * pow(10, 0.001 / 20)))
    }

    func testNearCeilingMatchesIndependentSignedCropReference() throws {
        let input = Float(0.49), reference = cropSafeConstantGain(amplitude: Double(input))
        var output = [[Float](repeating: input, count: 1024), [Float](repeating: input, count: 1024)]
        try limit(&output)
        let gain = Double(output[0][500]) / Double(input)
        XCTAssertEqual(20 * log10(gain), 20 * log10(reference), accuracy: 0.002)
        XCTAssertGreaterThan(gain, 0.81)
        let plateau = output[0][512..<768]
        XCTAssertLessThan(Double((plateau.max() ?? 0) - (plateau.min() ?? 0)), 0.00001)
        try NativeAudioAutomation.verifyLimited(output, rate: rate, from: 0, ceiling: { _ in -6 })
        for offset in [0, 1, 31, 499, 500, 501, 1006] { for length in 1...17 {
            let crop = output.map { Array($0[offset..<(offset + length)]) }
            try NativeAudioAutomation.verifyLimited(crop, rate: rate, from: Double(offset) / Double(rate), ceiling: { _ in -6 })
        } }
    }

    func testNearCeilingTonePreservesWaveShapeAndStereoBalance() throws {
        let source = (0..<4096).map { Float(0.49 * sin(2 * Double.pi * 1000 * Double($0) / Double(rate))) }
        var output = [source, source.map { -0.7 * $0 }]
        try limit(&output, lookahead: 5, release: 60)
        var inputEnergy = 0.0, outputEnergy = 0.0, cross = 0.0
        for i in 1024..<source.count {
            let input = Double(source[i]), value = Double(output[0][i])
            inputEnergy += input * input; outputEnergy += value * value; cross += input * value
        }
        let gain = cross / inputEnergy
        var residual = 0.0
        for i in 1024..<source.count { residual += pow(Double(output[0][i]) - gain * Double(source[i]), 2) }
        XCTAssertGreaterThan(gain, 0.8)
        XCTAssertLessThan(sqrt(residual / outputEnergy), 0.002)
        for i in source.indices { XCTAssertEqual(output[1][i], -0.7 * output[0][i], accuracy: 0.000001) }
        try NativeAudioAutomation.verifyLimited(output, rate: rate, from: 0, ceiling: { _ in -6 })
        for offset in [1024, 1025, 1031, 2000] { for length in 1...17 {
            let crop = output.map { Array($0[offset..<(offset + length)]) }
            try NativeAudioAutomation.verifyLimited(crop, rate: rate, from: Double(offset) / Double(rate), ceiling: { _ in -6 })
        } }
    }

    func testNearCeilingPrefixMatchesWithDeclaredFutureSupport() throws {
        let graph: [String: Any] = ["from": 0, "to": 2, "rate": rate, "buses": [],
            "master": ["chain": [], "limiter": ["type": "limiter", "params": ["ceiling": -6, "release": 1, "lookahead": 1]]]]
        let history = try NativeAudioMixer.previewHistory(plan: JSON(any: graph))
        XCTAssertTrue(history.requiresOrigin)
        XCTAssertEqual(history.future, 0.0035, accuracy: 1e-12)
        let source = [Float](repeating: 0.49, count: 2048)
        let prefixCount = 600 + Int(ceil(history.future * Double(rate)))
        var whole = [source, source], prefix = [Array(source.prefix(prefixCount)), Array(source.prefix(prefixCount))]
        try limit(&whole); try limit(&prefix)
        XCTAssertEqual(Array(whole[0][500..<600]), Array(prefix[0][500..<600]))
        XCTAssertEqual(Array(whole[1][500..<600]), Array(prefix[1][500..<600]))
    }

    func testQuietSignalRemainsBitIdenticalAtSupportedRates() throws {
        let input = [[Float](repeating: 0.2, count: 1024), [Float](repeating: -0.2, count: 1024)]
        for rate in [8000, 48000, 192000] {
            var output = input
            try NativeAudioAutomation.limit(&output, rate: rate, from: 0, ceiling: { _ in -6 }, lookahead: { _ in 1 }, release: { _ in 1 })
            XCTAssertEqual(output.map { $0.map(\.bitPattern) }, input.map { $0.map(\.bitPattern) })
            try NativeAudioAutomation.verifyLimited(output, rate: rate, from: 0, ceiling: { _ in -6 })
        }
    }

    func testCancellationDuringRefinementDrainsWithoutMutatingInput() async {
        let input = [[Float](repeating: 0.49, count: 4096), [Float](repeating: -0.343, count: 4096)]
        let originalBits = input.map { $0.map(\.bitPattern) }
        let probe = LimiterRefinementProbe()
        let worker = Task.detached { () -> LimiterRefinementOutcome in
            var output = input
            do {
                try NativeAudioAutomation.limit(&output, rate: 48000, from: 0,
                    ceiling: { _ in -6 }, lookahead: { _ in 1 }, release: { _ in 1 },
                    refinementCheckpoint: { probe.checkpoint($0) })
                return .init(audio: output, cancelled: false, unexpectedError: nil)
            } catch is CancellationError {
                return .init(audio: output, cancelled: true, unexpectedError: nil)
            } catch {
                return .init(audio: output, cancelled: false, unexpectedError: String(describing: error))
            }
        }
        let result = await worker.value
        let observation = probe.snapshot()
        XCTAssertTrue(observation.cancellationRequested, "The current worker task must be cancelled at refinement index 256.")
        XCTAssertEqual(observation.checkpoints, [0, 256], "The cancelled worker must stop before another refinement checkpoint.")
        XCTAssertTrue(result.cancelled, "Cancellation must throw from the refinement checkpoint.")
        XCTAssertNil(result.unexpectedError)
        XCTAssertEqual(result.audio.map { $0.map(\.bitPattern) }, originalBits)
    }
}
