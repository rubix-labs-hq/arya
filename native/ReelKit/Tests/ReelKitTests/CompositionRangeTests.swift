import Foundation
@testable import ReelKit
import XCTest

/// Execute scoped marks through the actual JavaScriptCore bridge used by native edits.
final class CompositionRangeTests: XCTestCase {
    private func fixture(_ core: ReelCore) throws -> String {
        let project = try core.newProject(name: "Main")
        return try core.applyOps(project: project, ops: #"[{"op":"add_title","text":"Main","dur":20},{"op":"range","in":1,"out":7},{"op":"add_comp","name":"Scene","duration":5,"fps":25}]"#).project
    }
    private func fields(_ text: String) throws -> [String: Any] { try XCTUnwrap(JSON.parse(text) as? [String: Any]) }
    private func scene(_ fields: [String: Any]) throws -> [String: Any] { try XCTUnwrap((fields["comps"] as? [String: Any])?["k1"] as? [String: Any]) }
    private func marks(_ fields: [String: Any]) throws -> [String: Double] {
        let range = try XCTUnwrap(fields["range"] as? [String: NSNumber])
        return range.mapValues(\.doubleValue)
    }
    func testScopedPartialMarksUseCompositionRateDurationAndPriorEndpoints() throws {
        let core = try ReelCore(scriptURL: Support.core()), project = try fixture(core)
        let marked = try core.applyOps(project: project, ops: #"[{"op":"range","comp":"k1","in":1.021}]"#).project
        let values = try fields(marked)
        XCTAssertEqual(try marks(values), ["in": 1, "out": 7])
        XCTAssertEqual(try marks(scene(values)), ["in": 1.04, "out": 5])
        let ended = try core.applyOps(project: marked, ops: #"[{"op":"range","comp":"k1","out":3}]"#).project
        XCTAssertEqual(try marks(scene(fields(ended))), ["in": 1.04, "out": 3])
    }
    func testScopedClearAndExplicitMainClearDoNotCrossDestinations() throws {
        let core = try ReelCore(scriptURL: Support.core()), project = try fixture(core)
        let marked = try core.applyOps(project: project, ops: #"[{"op":"range","comp":"k1","in":2,"out":4}]"#).project
        let compClear = try fields(core.applyOps(project: marked, ops: #"[{"op":"range","comp":"k1","in":null}]"#).project)
        XCTAssertTrue(try scene(compClear)["range"] is NSNull)
        XCTAssertEqual(try marks(compClear), ["in": 1, "out": 7])
        let mainClear = try fields(core.applyOps(project: marked, ops: #"[{"op":"range","comp":null,"in":null}]"#).project)
        XCTAssertTrue(mainClear["range"] is NSNull)
        XCTAssertEqual(try marks(scene(mainClear)), ["in": 2, "out": 4])
    }
    func testMissingCompositionThrowsWithoutPublishingAnEarlierMark() throws {
        let core = try ReelCore(scriptURL: Support.core()), project = try fixture(core)
        XCTAssertThrowsError(try core.applyOps(project: project, ops: #"[{"op":"range","comp":"k1","in":2},{"op":"range","comp":"missing","in":null}]"#))
        XCTAssertEqual(try marks(fields(project)), ["in": 1, "out": 7])
        XCTAssertNil(try scene(fields(project))["range"])
    }
}
