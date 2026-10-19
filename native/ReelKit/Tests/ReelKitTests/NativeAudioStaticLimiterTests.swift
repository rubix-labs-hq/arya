import Foundation
import XCTest
@testable import ReelKit

private final class StaticLimiterScanProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var indices: [Int] = []
    func checkpoint(_ index: Int) {
        lock.lock(); indices.append(index); lock.unlock()
        if index == 8192 { withUnsafeCurrentTask { $0?.cancel() } }
    }
    func snapshot() -> [Int] { lock.lock(); defer { lock.unlock() }; return indices }
}

private struct StaticLimiterScanOutcome: Sendable {
    let bits: [[UInt32]]
    let cancelled: Bool
    let error: String?
}

final class NativeAudioStaticLimiterTests: XCTestCase {
    private func original(_ audio: inout [[Float]], rate: Int = 48000, from: Double = 0,
                          ceiling: Double = -1, lookahead: Double = 5, release: Double = 60) throws {
        try NativeAudioAutomation.limit(&audio, rate: rate, from: from,
            ceiling: { _ in ceiling }, lookahead: { _ in lookahead }, release: { _ in release })
    }

    func testQuietFixedControlsPreserveOriginalSampleBitsAndSignedZeroAtSupportedRates() throws {
        let left = (0..<257).map { Float(0.4 * sin(Double($0) * 0.01)) } + [Float(-0.0), 0]
        let input = [left, left.map { -0.5 * $0 }]
        for rate in [8000, 48000, 192000] {
            var expected = input, actual = input
            try original(&expected, rate: rate, from: 8)
            try NativeAudioAutomation.limit(&actual, rate: rate, from: 8, ceiling: -1, lookahead: 5, release: 60)
            XCTAssertEqual(actual.map { $0.map(\.bitPattern) }, expected.map { $0.map(\.bitPattern) })
            XCTAssertEqual(actual.map { $0.map(\.bitPattern) }, input.map { $0.map(\.bitPattern) })
            try NativeAudioAutomation.verifyLimited(actual, rate: rate, from: 8, ceiling: { _ in -1 })
        }
    }

    func testFixedControlsOutsideUnityProofKeepOriginalRefinementAndShortTailBytes() throws {
        let signs = NativeAudioProcessing.peakPhases[1].reversed().map { Float($0 >= 0 ? 0.49 : -0.49) }
        for count in [1, 2, 7, 11, 12, 13, 17, 127] {
            let left = (0..<count).map { signs[$0 % signs.count] }
            let input = [left, left.map { -0.7 * $0 }]
            for controls in [(ceiling: -6.0, lookahead: 1.0, release: 1.0), (-24.0, 20.0, 1000.0)] {
                var expected = input, actual = input
                try original(&expected, ceiling: controls.0, lookahead: controls.1, release: controls.2)
                try NativeAudioAutomation.limit(&actual, rate: 48000, from: 0,
                    ceiling: controls.0, lookahead: controls.1, release: controls.2)
                XCTAssertEqual(actual.map { $0.map(\.bitPattern) }, expected.map { $0.map(\.bitPattern) })
                try NativeAudioAutomation.verifyLimited(actual, rate: 48000, from: 0, ceiling: { _ in controls.0 })
            }
        }
    }

    func testUnityProofBoundaryNeverChangesOriginalGainBytes() throws {
        let largest = NativeAudioProcessing.peakPhases.map { $0.reduce(0) { $0 + abs($1) } }.max()!
        let boundary = Float(pow(10, -6.0 / 20) / (largest * pow(10, NativeAudioAutomation.limiterMarginDB / 20)))
        let signs = NativeAudioProcessing.peakPhases[1].reversed().map { $0 >= 0 }
        for amplitude in [boundary.nextDown, boundary, boundary.nextUp] {
            let input = [(0..<127).map { signs[$0 % signs.count] ? amplitude : -amplitude }]
            var expected = input, actual = input
            try original(&expected, ceiling: -6)
            try NativeAudioAutomation.limit(&actual, rate: 48000, from: 0, ceiling: -6, lookahead: 5, release: 60)
            XCTAssertEqual(actual[0].map(\.bitPattern), expected[0].map(\.bitPattern))
        }
    }

    func testFixedVerifierUsesExactFallbackForSafeSignalsOutsideConservativeBound() throws {
        let source = (0..<257).map { Float(0.3 * sin(Double($0) * 0.1)) }
        let input = [source, source.map { -$0 }]
        let before = input.map { $0.map(\.bitPattern) }
        try NativeAudioAutomation.verifyLimited(input, rate: 48000, from: 3, ceiling: -6)
        try NativeAudioAutomation.verifyLimited(input, rate: 48000, from: 3, ceiling: { _ in -6 })
        XCTAssertEqual(input.map { $0.map(\.bitPattern) }, before)
    }

    func testFixedVerifierRejectsSampleAndFIRTailOvershootWithoutMutatingBytes() throws {
        let signs = NativeAudioProcessing.peakPhases[1].reversed().map { Float($0 >= 0 ? 0.49 : -0.49) }
        for input in [[[Float](repeating: 0.8, count: 64)], [signs]] {
            let before = input.map { $0.map(\.bitPattern) }
            XCTAssertThrowsError(try NativeAudioAutomation.verifyLimited(input, rate: 48000, from: 0, ceiling: -6))
            XCTAssertThrowsError(try NativeAudioAutomation.verifyLimited(input, rate: 48000, from: 0, ceiling: { _ in -6 }))
            XCTAssertEqual(input.map { $0.map(\.bitPattern) }, before)
        }
    }

    func testFixedControlsRejectMalformedInputAndControls() throws {
        for input in [[], [[]], [[Float(0)], []], [[Float.nan]], [[Float.infinity]]] as [[[Float]]] {
            XCTAssertThrowsError(try NativeAudioAutomation.verifyLimited(input, rate: 48000, from: 0, ceiling: -1))
        }
        for controls in [(ceiling: Double.nan, lookahead: 5.0, release: 60.0), (-25.0, 5.0, 60.0),
                         (-1.0, .infinity, 60.0), (-1.0, 0.0, 60.0), (-1.0, 5.0, .nan), (-1.0, 5.0, 1001.0)] {
            var audio: [[Float]] = [[0.2]]
            XCTAssertThrowsError(try NativeAudioAutomation.limit(&audio, rate: 48000, from: 0,
                ceiling: controls.0, lookahead: controls.1, release: controls.2))
            XCTAssertEqual(audio, [[0.2]])
        }
        for rate in [0, 192001] {
            var audio: [[Float]] = [[0.2]]
            XCTAssertThrowsError(try NativeAudioAutomation.limit(&audio, rate: rate, from: 0, ceiling: -1, lookahead: 5, release: 60))
        }
        for from in [Double.nan, .infinity, -1] {
            XCTAssertThrowsError(try NativeAudioAutomation.verifyLimited([[0.2]], rate: 48000, from: from, ceiling: -1))
        }
    }

    func testCancellationInsideFixedLimitAndVerifierScanLeavesInputBytesUnchanged() async {
        let input = [[Float](repeating: 0.2, count: 10000), [Float](repeating: -0.2, count: 10000)]
        let before = input.map { $0.map(\.bitPattern) }
        for verify in [false, true] {
            let probe = StaticLimiterScanProbe()
            let worker = Task.detached { () -> StaticLimiterScanOutcome in
                var audio = input
                do {
                    if verify {
                        try NativeAudioAutomation.verifyLimited(audio, rate: 48000, from: 0, ceiling: -1,
                            validationCheckpoint: { probe.checkpoint($0) })
                    } else {
                        try NativeAudioAutomation.limit(&audio, rate: 48000, from: 0, ceiling: -1, lookahead: 5, release: 60,
                            validationCheckpoint: { probe.checkpoint($0) })
                    }
                    return .init(bits: audio.map { $0.map(\.bitPattern) }, cancelled: false, error: nil)
                } catch is CancellationError {
                    return .init(bits: audio.map { $0.map(\.bitPattern) }, cancelled: true, error: nil)
                } catch {
                    return .init(bits: audio.map { $0.map(\.bitPattern) }, cancelled: false, error: String(describing: error))
                }
            }
            let result = await worker.value
            XCTAssertEqual(probe.snapshot(), [0, 8192])
            XCTAssertTrue(result.cancelled)
            XCTAssertNil(result.error)
            XCTAssertEqual(result.bits, before)
        }
    }

    func testMixerFixedControlsMatchEquivalentConstantAutomationWAVBytesAndMeters() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("static-limiter-mixer")), rate = 48000, count = 4800
        defer { try? FileManager.default.removeItem(at: folder.root.deletingLastPathComponent()) }
        let source = (0..<count).map { Float(0.4 * sin(Double($0) * 0.01)) }
        try NativeAudioProcessing.write(.init(channels: [source, source.map { -0.5 * $0 }], rate: rate),
                                        to: folder.root.appendingPathComponent("source.wav"))
        func plan(automated: Bool) -> JSON {
            let limiter: [String: Any] = ["type": "limiter", "params": ["ceiling": -1, "release": 60, "lookahead": 5],
                "curves": automated ? ["ceiling": ["values": [-1]], "release": ["values": [60]], "lookahead": ["values": [5]]] : [:]]
            let bus: [String: Any] = ["id": "A1", "gain": 1, "pan": 0,
                "items": [["src": "source.wav", "sourceIn": 0, "from": 0, "to": 0.1, "speed": 1]]]
            return JSON(any: ["from": 0, "to": 0.1, "rate": rate, "buses": [bus], "master": ["gain": 1, "limiter": limiter]])
        }
        let fixed = try await NativeAudioMixer.renderWithMeters(plan: plan(automated: false), folder: folder, preview: true, meterRange: 0..<count)
        let original = try await NativeAudioMixer.renderWithMeters(plan: plan(automated: true), folder: folder, preview: true, meterRange: 0..<count)
        XCTAssertEqual(fixed.pcm.channels.map { $0.map(\.bitPattern) }, original.pcm.channels.map { $0.map(\.bitPattern) })
        XCTAssertEqual(fixed.meters, original.meters)
        XCTAssertTrue(fixed.meters.valid)
        let a = folder.root.appendingPathComponent("fixed.wav"), b = folder.root.appendingPathComponent("original.wav")
        try NativeAudioProcessing.write(fixed.pcm, to: a); try NativeAudioProcessing.write(original.pcm, to: b)
        XCTAssertEqual(try Data(contentsOf: a), try Data(contentsOf: b))
        try NativeAudioAutomation.verifyLimited(fixed.pcm.channels, rate: rate, from: 0, ceiling: { _ in -1 })
    }
}
