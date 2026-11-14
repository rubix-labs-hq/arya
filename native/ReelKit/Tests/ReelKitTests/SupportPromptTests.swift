import Foundation
import XCTest
@testable import ReelKit

final class SupportPromptTests: XCTestCase {
    private let day: TimeInterval = 24 * 60 * 60
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    func testFirstExportNeverPromptsAndSecondDoes() {
        var state = SupportPromptState()
        XCTAssertFalse(SupportPromptPolicy.successfulExport(&state, now: start, channelAvailable: true))
        XCTAssertTrue(SupportPromptPolicy.successfulExport(&state, now: start, channelAvailable: true))
        XCTAssertEqual(state, SupportPromptState(successfulExports: 2, timesShown: 1, lastShown: start))
    }

    func testNotNowWaitsSixtyDaysAndStopsAfterThreeShowings() {
        var state = SupportPromptState(successfulExports: 1)
        var shown: [Int] = []
        for offset in [0, 10, 59, 60, 61, 125, 200, 400] {
            if SupportPromptPolicy.successfulExport(&state, now: start + Double(offset) * day, channelAvailable: true) {
                shown.append(offset)
                SupportPromptPolicy.record(.notNow, in: &state)
            }
        }
        XCTAssertEqual(shown, [0, 60, 125])
        XCTAssertFalse(state.finished)
    }

    func testOpeningSupportOrNeverEndsThePrompt() {
        for choice in [SupportPromptChoice.support, .never] {
            var state = SupportPromptState(successfulExports: 1)
            XCTAssertTrue(SupportPromptPolicy.successfulExport(&state, now: start, channelAvailable: true))
            SupportPromptPolicy.record(choice, in: &state)
            XCTAssertFalse(SupportPromptPolicy.successfulExport(&state, now: start + 400 * day, channelAvailable: true), "\(choice)")
            XCTAssertEqual(state.timesShown, 1)
        }
    }

    func testUnavailableChannelCountsExportsWithoutShowing() {
        var state = SupportPromptState()
        for _ in 0..<3 { XCTAssertFalse(SupportPromptPolicy.successfulExport(&state, now: start, channelAvailable: false)) }
        XCTAssertEqual(state, SupportPromptState(successfulExports: 3))
        XCTAssertTrue(SupportPromptPolicy.successfulExport(&state, now: start, channelAvailable: true))
    }

    func testSavedStateRoundTripsAndDamagedDataStartsFresh() {
        let state = SupportPromptState(successfulExports: 4, timesShown: 2, lastShown: start, finished: true)
        XCTAssertEqual(SupportPromptPolicy.decode(SupportPromptPolicy.encode(state)), state)
        XCTAssertEqual(SupportPromptPolicy.decode(Data("{".utf8)), SupportPromptState())
        XCTAssertEqual(SupportPromptPolicy.decode(nil), SupportPromptState())
    }
}
