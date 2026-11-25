import Foundation
import XCTest
@testable import ReelKit

final class ReviewPromptTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_770_000_000)
    private let day: TimeInterval = 24 * 60 * 60

    func testCanRequestIsReadOnlyUntilRecordRequestIsCalled() {
        var state = ReviewPromptState()
        XCTAssertTrue(ReviewPromptPolicy.canRequest(state: state, now: start, version: "1.4.1", channelAvailable: true, supportPromptActive: false))
        XCTAssertNil(state.lastRequested)
        XCTAssertNil(state.lastVersion)
        ReviewPromptPolicy.recordRequest(&state, now: start, version: "1.4.1")
        XCTAssertEqual(state.lastVersion, "1.4.1")
        XCTAssertEqual(state.lastRequested, start)
        XCTAssertFalse(ReviewPromptPolicy.canRequest(state: state, now: start + 200 * day, version: "1.4.1", channelAvailable: true, supportPromptActive: false))
    }

    func testDoesNotFireWhenSupportPromptIsVisibleOrPending() {
        let state = ReviewPromptState()
        XCTAssertFalse(ReviewPromptPolicy.canRequest(state: state, now: start, version: "1.4.1", channelAvailable: true, supportPromptActive: true))
        XCTAssertTrue(ReviewPromptPolicy.canRequest(state: state, now: start, version: "1.4.1", channelAvailable: true, supportPromptActive: false))
    }

    func testWaits120DaysEvenAcrossVersions() {
        var state = ReviewPromptState()
        ReviewPromptPolicy.recordRequest(&state, now: start, version: "1.4.1")
        XCTAssertFalse(ReviewPromptPolicy.canRequest(state: state, now: start + 119 * day, version: "1.4.2", channelAvailable: true, supportPromptActive: false))
        XCTAssertTrue(ReviewPromptPolicy.canRequest(state: state, now: start + 120 * day, version: "1.4.2", channelAvailable: true, supportPromptActive: false))
    }

    func testUnavailableChannelOrEmptyVersionNeverAsks() {
        let state = ReviewPromptState()
        XCTAssertFalse(ReviewPromptPolicy.canRequest(state: state, now: start, version: "1.4.1", channelAvailable: false, supportPromptActive: false))
        XCTAssertFalse(ReviewPromptPolicy.canRequest(state: state, now: start, version: "   ", channelAvailable: true, supportPromptActive: false))
    }

    func testSavedStateRoundTripsAndDamagedDataStartsFresh() {
        let state = ReviewPromptState(lastRequested: start, lastVersion: "1.4.1")
        XCTAssertEqual(ReviewPromptPolicy.decode(ReviewPromptPolicy.encode(state)), state)
        XCTAssertEqual(ReviewPromptPolicy.decode(Data("{".utf8)), ReviewPromptState())
        XCTAssertEqual(ReviewPromptPolicy.decode(nil), ReviewPromptState())
    }
}
