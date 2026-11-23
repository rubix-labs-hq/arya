import Foundation
import XCTest
@testable import ReelKit

final class ReviewPromptTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_770_000_000)
    private let day: TimeInterval = 24 * 60 * 60

    func testFirstSuccessfulExportAsksOncePerVersion() {
        var state = ReviewPromptState()
        XCTAssertTrue(ReviewPromptPolicy.successfulExport(&state, now: start, version: "1.4.1", channelAvailable: true, supportPromptShown: false))
        XCTAssertEqual(state.successfulExports, 1)
        XCTAssertEqual(state.lastVersion, "1.4.1")
        XCTAssertEqual(state.lastRequested, start)
        XCTAssertFalse(ReviewPromptPolicy.successfulExport(&state, now: start + 200 * day, version: "1.4.1", channelAvailable: true, supportPromptShown: false))
    }

    func testDoesNotFireAlongsideSupportPrompt() {
        var state = ReviewPromptState()
        XCTAssertFalse(ReviewPromptPolicy.successfulExport(&state, now: start, version: "1.4.1", channelAvailable: true, supportPromptShown: true))
        XCTAssertEqual(state.successfulExports, 1)
        XCTAssertNil(state.lastRequested)
        XCTAssertTrue(ReviewPromptPolicy.successfulExport(&state, now: start, version: "1.4.1", channelAvailable: true, supportPromptShown: false))
    }

    func testWaits120DaysEvenAcrossVersions() {
        var state = ReviewPromptState()
        XCTAssertTrue(ReviewPromptPolicy.successfulExport(&state, now: start, version: "1.4.1", channelAvailable: true, supportPromptShown: false))
        XCTAssertFalse(ReviewPromptPolicy.successfulExport(&state, now: start + 119 * day, version: "1.4.2", channelAvailable: true, supportPromptShown: false))
        XCTAssertTrue(ReviewPromptPolicy.successfulExport(&state, now: start + 120 * day, version: "1.4.2", channelAvailable: true, supportPromptShown: false))
        XCTAssertEqual(state.lastVersion, "1.4.2")
    }

    func testUnavailableChannelOrEmptyVersionNeverAsks() {
        var state = ReviewPromptState()
        XCTAssertFalse(ReviewPromptPolicy.successfulExport(&state, now: start, version: "1.4.1", channelAvailable: false, supportPromptShown: false))
        XCTAssertFalse(ReviewPromptPolicy.successfulExport(&state, now: start, version: "   ", channelAvailable: true, supportPromptShown: false))
        XCTAssertEqual(state.successfulExports, 2)
        XCTAssertNil(state.lastRequested)
    }

    func testSavedStateRoundTripsAndDamagedDataStartsFresh() {
        let state = ReviewPromptState(successfulExports: 3, lastRequested: start, lastVersion: "1.4.1")
        XCTAssertEqual(ReviewPromptPolicy.decode(ReviewPromptPolicy.encode(state)), state)
        XCTAssertEqual(ReviewPromptPolicy.decode(Data("{".utf8)), ReviewPromptState())
        XCTAssertEqual(ReviewPromptPolicy.decode(nil), ReviewPromptState())
    }
}
