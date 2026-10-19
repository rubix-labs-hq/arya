import Foundation
@testable import ReelKit
import XCTest

/// Prepared JavaScriptCore tests. The creative lane does not compile or execute Swift.
final class CompositionMarkerTests: XCTestCase {
    private func fixture(_ core: ReelCore) throws -> String {
        let project = try core.newProject(name: "Marker scopes")
        return try core.applyOps(project: project, ops: #"[{"op":"marker","t":4,"label":"Main four"},{"op":"marker","t":8,"label":"Main eight"},{"op":"add_comp","name":"Four seconds","duration":4,"fps":25},{"op":"add_comp","name":"Other","duration":12,"fps":24},{"op":"marker","comp":"k2","t":2,"label":"Other two"}]"#).project
    }
    private func fields(_ text: String) throws -> [String: Any] { try XCTUnwrap(JSON.parse(text) as? [String: Any]) }
    private func scene(_ p: [String: Any], _ id: String = "k1") throws -> [String: Any] { try XCTUnwrap((p["comps"] as? [String: Any])?[id] as? [String: Any]) }
    private func markers(_ p: [String: Any]) -> [[String: Any]] { p["markers"] as? [[String: Any]] ?? [] }
    private func ids(_ p: [String: Any]) -> [String] { markers(p).compactMap { $0["id"] as? String } }

    func testUnmarkedCompositionHasNoMainMarkersAndMainRemainsIntact() throws {
        let core = try ReelCore(scriptURL: Support.core()), p = try fields(fixture(core))
        XCTAssertEqual(markers(p).compactMap { ($0["t"] as? NSNumber)?.doubleValue }, [4, 8])
        XCTAssertTrue(markers(try scene(p)).isEmpty)
        XCTAssertEqual(markers(try scene(p, "k2")).first?["label"] as? String, "Other two")
    }
    func testLocalCreateUpdateDeleteUseLocalRateAndDoNotChangeMainOrSibling() throws {
        let core = try ReelCore(scriptURL: Support.core()), project = try fixture(core)
        let created = try core.applyOps(project: project, ops: #"[{"op":"marker","comp":"k1","t":1.019,"label":"Local"}]"#).project
        let values = try fields(created)
        XCTAssertEqual(ids(try scene(values)), ["m4"])
        XCTAssertEqual((markers(try scene(values)).first?["t"] as? NSNumber)?.doubleValue, 1)
        let changed = try core.applyOps(project: created, ops: #"[{"op":"update_marker","comp":"k1","id":"m4","set":{"label":"Edited"}},{"op":"delete_marker","comp":"k1","id":"m4"}]"#).project
        let final = try fields(changed)
        XCTAssertTrue(markers(try scene(final)).isEmpty)
        XCTAssertEqual(ids(final), ["m1", "m2"])
        XCTAssertEqual(ids(try scene(final, "k2")), ["m3"])
    }
    func testIDsStayUniqueAcrossInterleavedScopesAndBatchCreates() throws {
        let core = try ReelCore(scriptURL: Support.core()), project = try fixture(core)
        let result = try core.applyOps(project: project, ops: #"[{"op":"markers","comp":"k1","markers":[{"t":1,"label":"First"},{"t":2,"label":"Second","dur":0.5}]},{"op":"marker","comp":null,"t":3,"label":"Root"},{"op":"marker","comp":"k2","t":4,"label":"Other"}]"#).project
        let p = try fields(result), all = ids(p) + ids(try scene(p)) + ids(try scene(p, "k2"))
        XCTAssertEqual(Set(all).count, all.count)
        XCTAssertEqual(ids(try scene(p)), ["m4", "m5"])
        XCTAssertEqual((markers(try scene(p)).last?["dur"] as? NSNumber)?.doubleValue, 0.5)
    }
    func testMissingCompositionRejectsAnEntireMarkerBatchAndFileTextPreservesScopes() throws {
        let core = try ReelCore(scriptURL: Support.core()), project = try fixture(core)
        XCTAssertThrowsError(try core.applyOps(project: project, ops: #"[{"op":"marker","comp":"k1","t":1},{"op":"marker","comp":"missing","t":2}]"#))
        let reloaded = try fields(core.migrate(fileText: core.fileText(project: project)))
        XCTAssertEqual(ids(reloaded), ["m1", "m2"])
        XCTAssertTrue(markers(try scene(reloaded)).isEmpty)
        XCTAssertEqual(ids(try scene(reloaded, "k2")), ["m3"])
    }
}
