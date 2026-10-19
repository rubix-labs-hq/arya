import Foundation
import XCTest
@testable import ReelKit

final class FigmaPlacementTests: XCTestCase {
    func testImportPlanPreservesMainTimelineAndPlacesInPortraitComposition() async throws {
        let core = try ReelCore(scriptURL: Support.core())
        let base = try core.newProject(name: "Nested Figma")
        let project = try core.applyOps(project: base, ops: #"[{"op":"add_title","text":"Main stays here","dur":10},{"op":"add_comp","name":"Portrait","width":480,"height":720,"fps":25,"duration":12}]"#).project
        let nodes = #"{"id":"1:1","type":"FRAME","name":"Editable frame","absoluteBoundingBox":{"x":0,"y":0,"width":240,"height":180},"children":[{"id":"1:2","type":"TEXT","name":"Heading","characters":"Keep this editable","absoluteBoundingBox":{"x":20,"y":30,"width":200,"height":40},"style":{"fontFamily":"Inter","fontSize":24},"fills":[{"type":"SOLID","color":{"r":1,"g":1,"b":1}}]}]}"#
        let prepared = Figma.PreparedImport(nodes: nodes, options: #"{"comp":"k1","start":1.021,"duration":6,"placeOnTimeline":true}"#, warnings: [])
        let client = try Figma(coreScript: Support.core(), readCredential: { nil }, writeCredential: { _ in })
        let plan = try await client.importPlan(project: project, prepared: prepared)
        let fields = try XCTUnwrap(JSON.parse(plan.text) as? [String: Any])
        let imported = try XCTUnwrap(fields["comp"] as? String)
        let result = try core.applyOps(project: project, ops: JSON(any: fields["ops"]).text)
        let before = try XCTUnwrap(JSON.parse(project) as? [String: Any])
        let after = try XCTUnwrap(JSON.parse(result.project) as? [String: Any])
        XCTAssertEqual(JSON(any: after["tracks"]).text, JSON(any: before["tracks"]).text)
        let comps = try XCTUnwrap(after["comps"] as? [String: Any])
        let portrait = try XCTUnwrap(comps["k1"] as? [String: Any])
        let tracks = try XCTUnwrap(portrait["tracks"] as? [[String: Any]])
        let placed = try XCTUnwrap(tracks.flatMap { $0["clips"] as? [[String: Any]] ?? [] }.first { $0["comp"] as? String == imported })
        XCTAssertEqual(placed["start"] as? Double, 1.04)
        XCTAssertEqual(placed["scale"] as? Double, 0.5)
        let content = try XCTUnwrap(comps[imported] as? [String: Any])
        XCTAssertTrue(JSON(any: content).text.contains("Keep this editable"))
        XCTAssertTrue(JSON(any: content).text.contains("figma 1:2"))
    }
}
