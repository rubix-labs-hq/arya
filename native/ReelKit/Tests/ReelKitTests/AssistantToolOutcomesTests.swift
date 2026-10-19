import Foundation
import XCTest
@testable import ReelKit

final class AssistantToolOutcomesTests: XCTestCase {
    private let sourceA = "media/generated/music/11111111-1111-4111-8111-111111111111/score.wav"
    private let sourceB = "media/generated/music/22222222-2222-4222-8222-222222222222/score.wav"
    private func body(_ path: String? = nil, track: String = "A3", comp: String? = nil, start: Double = 0) -> [String: Any] {
        var value: [String: Any] = ["track": track, "comp": comp as Any? ?? NSNull(), "start": start]
        if let path { value["path"] = path }
        return value
    }
    private func receipt(_ path: String, state: String = "asset_ready", fields: [String: Any] = [:]) -> [String: Any] {
        var value: [String: Any] = ["path": path, "state": state, "asset": ["generated": ["kind": "original-music", "renderer": "arya-score-synth/1"]]]
        if state == "asset_ready" { value["applied"] = false }
        return value.merging(fields) { _, replacement in replacement }
    }

    func testSavedUnplacedMusicGetsAnExplicitUnresolvedSummary() {
        var outcomes = AssistantToolOutcomes()
        outcomes.record(method: "POST", path: "/api/audio/compose", body: body(), result: receipt(sourceA))
        XCTAssertTrue(outcomes.unresolvedMessage?.contains("saved in Media") == true)
        XCTAssertTrue(outcomes.completionMessage(failedJobCount: 0, projectChanged: true).contains("Retry placement without regenerating"))
    }

    func testAReviewedRetryClearsOnlyItsMatchingAssetFailure() {
        var outcomes = AssistantToolOutcomes()
        for path in [sourceA, sourceB] { outcomes.record(method: "POST", path: "/api/audio/compose", body: body(), result: receipt(path)) }
        outcomes.record(method: "POST", path: "/api/audio/compose/place", body: body(sourceA, start: 4), result: receipt(sourceA, state: "complete"))
        XCTAssertNotNil(outcomes.unresolvedMessage)
        outcomes.record(method: "POST", path: "/api/audio/compose/place", body: body(sourceB, start: 8), result: receipt(sourceB, state: "complete"))
        XCTAssertNil(outcomes.unresolvedMessage)
    }

    func testPlacementOnAnotherTrackOrCompositionDoesNotRecoverTheRequestedScope() {
        var outcomes = AssistantToolOutcomes()
        outcomes.record(method: "POST", path: "/api/audio/compose", body: body(track: "A3", comp: "sceneA"), result: receipt(sourceA))
        for attempt in [body(sourceA, track: "A2", comp: "sceneA"), body(sourceA, track: "A3", comp: "sceneB"), body(sourceA)] {
            outcomes.record(method: "POST", path: "/api/audio/compose/place", body: attempt, result: receipt(sourceA, state: "complete"))
            XCTAssertNotNil(outcomes.unresolvedMessage)
        }
        outcomes.record(method: "POST", path: "/api/audio/compose/place", body: body(sourceA, comp: "sceneA", start: 12), result: receipt(sourceA, state: "complete"))
        XCTAssertNil(outcomes.unresolvedMessage)
    }

    func testMismatchedResultPathTrackCompositionOrProvenanceCannotClearFailure() {
        var outcomes = AssistantToolOutcomes()
        outcomes.record(method: "POST", path: "/api/audio/compose", body: body(), result: receipt(sourceA))
        let attempts = [receipt(sourceB, state: "complete"), receipt(sourceA, state: "complete", fields: ["track": "A2"]),
                        receipt(sourceA, state: "complete", fields: ["comp": "sceneA"]),
                        receipt(sourceA, state: "complete", fields: ["asset": ["generated": ["kind": "original-music", "renderer": "different-renderer"]]])]
        for result in attempts {
            outcomes.record(method: "POST", path: "/api/audio/compose/place", body: body(sourceA), result: result)
            XCTAssertNotNil(outcomes.unresolvedMessage)
        }
    }

    func testUnverifiedReceiptRemainsUnresolvedAfterAnotherVerifiedRetry() {
        var outcomes = AssistantToolOutcomes()
        outcomes.record(method: "POST", path: "/api/audio/compose", body: body(), result: ["state": "asset_ready", "path": sourceA])
        outcomes.record(method: "POST", path: "/api/audio/compose/place", body: body(sourceA), result: receipt(sourceA, state: "complete"))
        XCTAssertNotNil(outcomes.unresolvedMessage)
    }

    func testUnknownFailedReceiptDoesNotInventSavedMedia() {
        var outcomes = AssistantToolOutcomes()
        outcomes.record(method: "POST", path: "/api/audio/compose", body: body(), result: ["applied": false])
        XCTAssertTrue(outcomes.unresolvedMessage?.hasPrefix("A processing result") == true)
        XCTAssertFalse(outcomes.unresolvedMessage?.contains("saved in Media") == true)
    }

    func testInvalidAssetAndTargetIdentityCannotProduceARecoverableScope() {
        for (request, result) in [(body(), receipt("/tmp/score.wav")), (body(track: "../A3"), receipt(sourceA)), (body(comp: "scene/other"), receipt(sourceA))] {
            var outcomes = AssistantToolOutcomes()
            outcomes.record(method: "POST", path: "/api/audio/compose", body: request, result: result)
            outcomes.record(method: "POST", path: "/api/audio/compose/place", body: body(sourceA), result: receipt(sourceA, state: "complete"))
            XCTAssertNotNil(outcomes.unresolvedMessage)
        }
    }

    func testNullAndAbsentMainCompositionMatchAndAGapMoveIsAllowed() {
        var outcomes = AssistantToolOutcomes(), original = body()
        let retry = body(sourceA, start: 6)
        original.removeValue(forKey: "comp")
        outcomes.record(method: "POST", path: "/api/audio/compose", body: original, result: receipt(sourceA, fields: ["comp": NSNull()]))
        outcomes.record(method: "POST", path: "/api/audio/compose/place", body: retry, result: receipt(sourceA, state: "complete", fields: ["comp": NSNull()]))
        XCTAssertNil(outcomes.unresolvedMessage)
    }

    func testCompleteStateWithAppliedFalseDoesNotEraseFailure() {
        var outcomes = AssistantToolOutcomes()
        outcomes.record(method: "POST", path: "/api/audio/compose", body: body(), result: receipt(sourceA))
        outcomes.record(method: "POST", path: "/api/audio/compose/place", body: body(sourceA), result: receipt(sourceA, state: "complete", fields: ["applied": false]))
        XCTAssertNotNil(outcomes.unresolvedMessage)
    }

    func testAsyncJobResultsStaySeparatelyCountedAfterSuccessfulMusicRecovery() {
        var outcomes = AssistantToolOutcomes()
        outcomes.record(method: "POST", path: "/api/video/denoise", body: [:], result: ["state": "done", "applied": false])
        outcomes.record(method: "GET", path: "/api/jobs/wait", body: [:], result: ["state": "done", "applied": false])
        XCTAssertNil(outcomes.unresolvedMessage)
        outcomes.record(method: "POST", path: "/api/audio/compose", body: body(), result: receipt(sourceA))
        XCTAssertTrue(outcomes.completionMessage(failedJobCount: 2, projectChanged: true).contains("2 other processing result(s)"))
        outcomes.record(method: "POST", path: "/api/audio/compose/place", body: body(sourceA), result: receipt(sourceA, state: "complete"))
        XCTAssertEqual(outcomes.completionMessage(failedJobCount: 2, projectChanged: true), "2 processing result(s) were not applied. Review saved assets and any committed edits.")
    }

    func testReadOnlyOrUnrelatedCompleteResultsNeverClearAPlacementFailure() {
        var outcomes = AssistantToolOutcomes()
        outcomes.record(method: "POST", path: "/api/audio/compose", body: body(), result: receipt(sourceA))
        outcomes.record(method: "GET", path: "/api/audio/compose/place", body: body(sourceA), result: receipt(sourceA, state: "complete"))
        outcomes.record(method: "POST", path: "/api/ops", body: body(sourceA), result: receipt(sourceA, state: "complete"))
        XCTAssertNotNil(outcomes.unresolvedMessage)
    }

    func testNewRequestStartsWithNoUnresolvedReceipts() {
        XCTAssertEqual(AssistantToolOutcomes().completionMessage(failedJobCount: 0, projectChanged: false), "No project edits were applied during this request.")
        XCTAssertEqual(AssistantToolOutcomes().completionMessage(failedJobCount: 0, projectChanged: true), "The project changed during this request. Review edits in the timeline.")
    }
}
