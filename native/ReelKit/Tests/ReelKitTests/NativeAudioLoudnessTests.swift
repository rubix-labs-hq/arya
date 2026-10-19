import Foundation
@testable import ReelKit
import XCTest

final class NativeAudioLoudnessTests: XCTestCase {
    // Analytic signals generated here from the level-step descriptions in EBU Tech 3342.
    // https://tech.ebu.ch/docs/tech/tech3342.pdf
    func testGeneratedStereoLevelStepsMeetPublishedRangeTolerances() throws {
        let cases: [([Double], Double)] = [([-20, -30], 10), ([-20, -15], 5), ([-40, -20], 20), ([-50, -35, -20, -35, -50], 15)]
        let rate = 8000
        for (levels, expected) in cases {
            var samples: [Float] = []
            samples.reserveCapacity(rate * 20 * levels.count)
            for level in levels {
                let amplitude = pow(10, level / 20)
                for index in 0..<(rate * 20) {
                    samples.append(Float(amplitude * sin(2 * .pi * 1000 * Double(index) / Double(rate))))
                }
            }
            let result = try NativeAudioProcessing.measure(.init(channels: [samples, samples], rate: rate))
            XCTAssertTrue(result.rangeAvailable)
            XCTAssertEqual(result.range, expected, accuracy: 1, "Levels \(levels)")
            print("Generated EBU level-step range", levels, result.range)
        }
    }

    func testRangeGatesShortTermEnergyAndUsesRoundedPercentileRanks() throws {
        XCTAssertEqual(try NativeAudioProcessing.loudnessRange(Array(-40 ... -21).map(Double.init)), 16)
        XCTAssertEqual(try NativeAudioProcessing.loudnessRange([Double](repeating: -60, count: 90) + [Double](repeating: -20, count: 10)), 0)
        XCTAssertEqual(try NativeAudioProcessing.loudnessRange([-80, -.infinity, .nan, .infinity, -30, -20]), 10)
        XCTAssertEqual(try NativeAudioProcessing.loudnessRange([-70, -70, -70]), 0)
        XCTAssertEqual(try NativeAudioProcessing.loudnessRange([-71, -.infinity]), 0)
        XCTAssertEqual(try NativeAudioProcessing.loudnessRange([]), 0)
        let levels = [Double](repeating: -46, count: 60) + [Double](repeating: -27, count: 40)
        XCTAssertEqual(try NativeAudioProcessing.loudnessRange(levels), 19)
        XCTAssertEqual(try NativeAudioProcessing.loudnessRange(levels.map { $0 + 12 }), 19)
    }

    func testShortSourceReportsAbsentRangeWhileSilenceHasNoFiniteLoudness() throws {
        let rate = 8000
        let short = try NativeAudioProcessing.measure(.init(channels: [[Float](repeating: 0.05, count: rate * 2)], rate: rate))
        XCTAssertFalse(short.rangeAvailable)
        let fields = try XCTUnwrap(try JSON.parse(short.json.text) as? [String: Any])
        XCTAssertTrue(fields["lra"] is NSNull)
        XCTAssertEqual(fields["lraAvailable"] as? Bool, false)
        let silence = try NativeAudioProcessing.measure(.init(channels: [[Float](repeating: 0, count: rate * 3)], rate: rate))
        XCTAssertTrue(silence.rangeAvailable)
        XCTAssertEqual(silence.range, 0)
        XCTAssertEqual(silence.integrated, -.infinity)
        XCTAssertEqual(silence.peak, -.infinity)
        let silentJSON = try XCTUnwrap(try JSON.parse(silence.json.text) as? [String: Any])
        XCTAssertTrue(silentJSON["i"] is NSNull)
        XCTAssertTrue(silentJSON["tp"] is NSNull)
    }

    func testMalformedPCMRejectsBeforeMeasurement() throws {
        let cases: [NativeAudioProcessing.PCM] = [
            .init(channels: [], rate: 8000),
            .init(channels: [[]], rate: 8000),
            .init(channels: [[0], [0, 0]], rate: 8000),
            .init(channels: [[0], [0], [0]], rate: 8000),
            .init(channels: [[0]], rate: 0),
            .init(channels: [[.nan]], rate: 8000),
            .init(channels: [[.infinity]], rate: 8000),
        ]
        for pcm in cases { XCTAssertThrowsError(try NativeAudioProcessing.measure(pcm)) }
    }

    func testAnalysisPaddingCountsMemoryWithoutReducingTheContentLimit() throws {
        let ampleBudget: UInt64 = 64 * 1024 * 1024 * 1024
        XCTAssertNoThrow(try NativeAudioProcessing.validateMemory(seconds: 3600, paddingSeconds: 1.5, limit: ampleBudget))
        XCTAssertThrowsError(try NativeAudioProcessing.validateMemory(seconds: 3600.01, paddingSeconds: 1.5, limit: ampleBudget))
        XCTAssertThrowsError(try NativeAudioProcessing.validateMemory(seconds: 1, paddingSeconds: .infinity, limit: ampleBudget))
        XCTAssertThrowsError(try NativeAudioProcessing.validateMemory(seconds: 1, paddingSeconds: -1, limit: ampleBudget))
        let exactUnpaddedBytes = UInt64(1.0 * 48000 * 2 * 4 * 6 * 1.25)
        XCTAssertNoThrow(try NativeAudioProcessing.validateMemory(seconds: 1, limit: exactUnpaddedBytes))
        XCTAssertThrowsError(try NativeAudioProcessing.validateMemory(seconds: 1, paddingSeconds: 1.5, limit: exactUnpaddedBytes))
    }
}
