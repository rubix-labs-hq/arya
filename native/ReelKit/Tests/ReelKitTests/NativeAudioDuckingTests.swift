import Foundation
import XCTest
@testable import ReelKit

final class NativeAudioDuckingTests: XCTestCase {
    func testManyDistantDialogueIntervalsDoNotChangeShortMusicEnvelopes() throws {
        let clips: [[String: Any]] = (0..<256).map { ["id": "music-\($0)", "kind": "audio", "start": 0, "dur": 1] }
        let scope: [String: Any] = ["tracks": [["id": "D", "clips": []], ["id": "M", "clips": clips]]]
        let dialogue: [[String: Any]] = (0..<1024).map { index -> [String: Any] in
            let offset: Double = Double(index) * 3
            let start: Double = 0.2 + offset
            let end: Double = 0.5 + offset
            return ["kind": "leaf", "from": start, "to": end]
        }
        let request: [String: Any] = ["comp": NSNull(), "expectedVersion": 1, "from": 0, "to": 3600,
            "dialogueTrackIDs": ["D"], "musicClipIDs": clips.map { $0["id"] as! String },
            "settings": ["amount": 12, "attack": 0.15, "hold": 0, "mergeGap": 0, "release": 0.4]]
        func expanded(_ items: [[String: Any]]) -> [String: Any] {
            ["from": 0, "to": 3600.4, "buses": [["id": "D", "items": items], ["id": "M", "items": clips]]]
        }
        let full = try NativeAudioDucking.plan(scopedProject: scope, expandedPlan: expanded(dialogue), request: request)
        let nearby = try NativeAudioDucking.plan(scopedProject: scope, expandedPlan: expanded([dialogue[0]]), request: request)
        XCTAssertEqual((full["operations"] as? [Any])?.count, 256)
        try assertJSON(full["operations"]!, nearby["operations"]!)
        XCTAssertEqual(full["pointCount"] as? Int, nearby["pointCount"] as? Int)
    }

    func testCanceledDuckingStopsBeforeProducingOperations() async throws {
        let fixtures = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Support.fixture("duck-fixtures.json"))) as? [[String: Any]])
        let fixtureText = JSON(any: try XCTUnwrap(fixtures.first)).text
        await Task.detached {
            withUnsafeCurrentTask { $0?.cancel() }
            do {
                let fixture = try JSON.parse(fixtureText) as! [String: Any]
                _ = try NativeAudioDucking.plan(scopedProject: fixture["scopedProject"] as! [String: Any], expandedPlan: fixture["expandedPlan"] as! [String: Any], request: fixture["request"] as! [String: Any])
                XCTFail("Canceled ducking produced an edit.")
            } catch is CancellationError { }
            catch { XCTFail("Cancellation returned a different error: \(error)") }
        }.value
    }

    func testRejectsInvalidCaptureAndDuckingSettings() throws {
        let fixtures = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Support.fixture("duck-fixtures.json"))) as? [[String: Any]])
        let fixture = try XCTUnwrap(fixtures.first)
        let scope = try XCTUnwrap(fixture["scopedProject"] as? [String: Any])
        let plan = try XCTUnwrap(fixture["expandedPlan"] as? [String: Any])
        let original = try XCTUnwrap(fixture["request"] as? [String: Any])
        for axis in 0..<9 {
            var request = original
            switch axis {
            case 0: request["expectedVersion"] = true
            case 1: request["expectedVersion"] = 7.25
            case 2: request["expectedVersion"] = "7"
            case 3: request.removeValue(forKey: "comp")
            case 4: request["from"] = Double.nan
            case 5: request["to"] = request["from"]
            case 6:
                var settings = try XCTUnwrap(request["settings"] as? [String: Any])
                settings["attack"] = 0
                request["settings"] = settings
            case 7: request["dialogueTrackIDs"] = ["duplicate", "duplicate"]
            default: request["manualPolicy"] = "replace-all"
            }
            XCTAssertThrowsError(try NativeAudioDucking.plan(scopedProject: scope, expandedPlan: plan, request: request), "Invalid request axis \(axis) was accepted")
        }
    }

    func testSharedCoreFixturesPreserveOriginalAutomationAndRepeatWithoutStacking() throws {
        let url = Support.fixture("duck-fixtures.json")
        let fixtures = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        let core = try ReelCore(scriptURL: Support.core())
        for fixture in fixtures {
            let scope = try XCTUnwrap(fixture["scopedProject"] as? [String: Any])
            let plan = try XCTUnwrap(fixture["expandedPlan"] as? [String: Any])
            let request = try XCTUnwrap(fixture["request"] as? [String: Any])
            let expected = try XCTUnwrap(fixture["expected"] as? [String: Any])
            let result = try NativeAudioDucking.plan(scopedProject: scope, expandedPlan: plan, request: request)
            try assertJSON(result, expected)
            let projectText = JSON(any: fixture["project"]!).text
            let applied = try core.applyOps(project: projectText, ops: JSON(any: result["operations"]!).text)
            try assertJSON(try JSON.parse(applied.project), fixture["applied"]!)
        }
    }
    private func assertJSON(_ a: Any, _ b: Any, file: StaticString = #filePath, line: UInt = #line) throws {
        if let a = a as? [String: Any], let b = b as? [String: Any] {
            XCTAssertEqual(Set(a.keys), Set(b.keys), file: file, line: line)
            for key in a.keys { try assertJSON(a[key]!, b[key]!, file: file, line: line) }
        } else if let a = a as? [Any], let b = b as? [Any] {
            XCTAssertEqual(a.count, b.count, file: file, line: line)
            for index in 0..<min(a.count, b.count) { try assertJSON(a[index], b[index], file: file, line: line) }
        } else if let a = a as? NSNumber, let b = b as? NSNumber {
            XCTAssertEqual(a.doubleValue, b.doubleValue, accuracy: 1e-8, file: file, line: line)
        } else if a is NSNull, b is NSNull { return }
        else { XCTAssertEqual(a as? String, b as? String, file: file, line: line) }
    }
}
