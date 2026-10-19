import Foundation
import XCTest
@testable import ReelKit

final class ColorWindowRenderingTests: XCTestCase {
    private func record(_ frame: ReelRenderedFrame, clip: String = "c1") throws -> [String: Any] {
        let records = try JSON.parse(frame.drawGeometry.text) as! [[String: Any]]
        return try XCTUnwrap(records.first { $0.string("id") == clip })
    }
    private func project(_ core: ReelCore, window: String = "circle") throws -> String {
        let initial = try core.newProject(name: "Window coordinates", options: #"{"width":1920,"height":1080}"#)
        let ops: [[String: Any]] = [
            ["op": "add_shape", "track": "V1", "dur": 3, "shape": ["type": "rect", "width": 4000, "height": 900, "fill": ["color": "#404040"]], "set": ["scale": 0.22]],
            ["op": "node_add", "id": "c1", "node": ["type": "corrector", "grade": ["exposure": 1], "window": ["type": window, "x": 0.5, "y": 0.5, "w": 0.3, "h": 0.3, "rotation": 35, "softness": 0.01]]]
        ]
        return try core.applyOps(project: initial, ops: JSON(any: ops).text).project
    }
    private func screen(_ uv: (Double, Double), record: [String: Any]) -> (Int, Int) {
        let m = (record["matrix"] as! [NSNumber]).map(\.doubleValue)
        let x = (uv.0 - 0.5) * record.number("width"), y = (uv.1 - 0.5) * record.number("height")
        return (Int((m[0]*x+m[2]*y+m[4]).rounded()), Int((m[1]*x+m[3]*y+m[5]).rounded()))
    }
    private func boundary(_ node: [String: Any], dx: Double, dy: Double) -> (Double, Double) {
        let window = node.object("window"), aspect = node.number("nodePlaneWidth") / node.number("nodePlaneHeight")
        let angle = window.number("rotation") * .pi / 180
        let x = dx * max(1e-4, window.number("w") * aspect / 2), y = dy * max(1e-4, window.number("h") / 2)
        return (window.number("x") + (cos(angle)*x-sin(angle)*y)/aspect, window.number("y") + sin(angle)*x+cos(angle)*y)
    }
    func testFullResolutionPlaneAndRotatedWindowMatchActualPixels() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("window-resolution")), core = try ReelCore(scriptURL: Support.core())
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        for type in ["circle", "rect"] {
            let source = try project(core, window: type), frame = try await renderer.render(project: source, at: 1, width: 1920)
            let entry = try record(frame), planes = entry.object("nodePlanes")
            let node = try XCTUnwrap(planes.values.compactMap { $0 as? [String: Any] }.first { $0.string("nodeType") == "corrector" })
            XCTAssertEqual(node.string("coordinateSpace"), "nodeGraph-output-normalized-v1")
            XCTAssertGreaterThan(node.number("nodePlaneWidth"), 4000)
            XCTAssertLessThan(node.number("nodePlaneHeight"), 1000)
            XCTAssertEqual(entry.number("width")/entry.number("height"), node.number("nodePlaneWidth")/node.number("nodePlaneHeight"), accuracy: 0.0001)
            for index in 0..<8 {
                let angle = Double(index)*2 * .pi/8, x = cos(angle), y = sin(angle)
                let normalizer = type == "rect" ? max(abs(x),abs(y)) : 1
                for (distance, graded) in [(0.65,true),(1.3,false)] {
                    let uv = boundary(node, dx: x/normalizer*distance, dy: y/normalizer*distance), point = screen(uv, record: entry)
                    let red = pixel(frame.pixelBuffer, point.0, point.1)[0]
                    if graded { XCTAssertGreaterThan(red,100,"\(type) inside boundary \(index)") }
                    else { XCTAssertLessThan(red,80,"\(type) outside boundary \(index)") }
                }
            }
        }
    }
    func testUnsupportedNodesAndUpperAdjustmentEffectsRemoveCoordinateEvidence() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("window-evidence")), core = try ReelCore(scriptURL: Support.core())
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core()), source = try project(core)
        let supported = try await renderer.render(project: source, at: 1, width: 320)
        XCTAssertFalse(try record(supported).object("nodePlanes").isEmpty)
        let blur = try core.applyOps(project: source, ops: #"[{"op":"node_add","id":"c1","node":{"type":"blur","radius":2}}]"#).project
        let unsupported = try await renderer.render(project: blur, at: 1, width: 320)
        XCTAssertTrue(try record(unsupported).object("nodePlanes").isEmpty)
        let adjusted = try core.applyOps(project: source, ops: #"[{"op":"adjustment","track":"V2","dur":3,"set":{"effects":[{"type":"mirror","params":{"axis":"x"}}]}}]"#).project
        let upperPlan = parse(try core.framePlan(project: adjusted, at: 1, comp: nil))
        let upperLayers = upperPlan["layers"] as! [[String: Any]]
        XCTAssertEqual(upperLayers.map { $0.object("clip").string("kind") }, ["shape", "adjustment"])
        XCTAssertEqual(upperLayers[1].object("clip").object("fx").string("mirror"), "x")
        let warped = try await renderer.render(project: adjusted, at: 1, width: 320)
        XCTAssertTrue(try record(warped).object("nodePlanes").isEmpty)
        let above = try core.applyOps(project: adjusted, ops: #"[{"op":"move","id":"c1","start":0,"track":"V3"}]"#).project
        let lowerPlan = parse(try core.framePlan(project: above, at: 1, comp: nil))
        XCTAssertEqual((lowerPlan["layers"] as! [[String: Any]]).map { $0.object("clip").string("kind") }, ["adjustment", "shape"])
        let unaffected = try await renderer.render(project: above, at: 1, width: 320)
        XCTAssertFalse(try record(unaffected).object("nodePlanes").isEmpty)
    }
    func testPreviewWindowCoordinatesStayImmutableAndRestoreWithoutWrites() async throws {
        let root = try Support.tempFolder("window-preview"), folder = ProjectFolder(root: root), core = try ReelCore(scriptURL: Support.core())
        let source = try project(core), file = root.appendingPathComponent("project.json")
        try source.write(to: file, atomically: true, encoding: .utf8)
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let original = try await renderer.render(project: source, at: 1, width: 320)
        let planes = try record(original).object("nodePlanes"), id = try XCTUnwrap(planes.keys.first { (planes[$0] as? [String: Any])?.string("nodeType") == "corrector" })
        let operation: [String: Any] = ["op":"node_update","id":"c1","node":id,"comp":NSNull(),"set":["window":["x":0.6,"rotation":-25]]]
        let draft = try await renderer.renderPreview(project: source, operations: JSON(any:[operation]).text, at: 1, width: 320)
        let draftWindow = try record(draft).object("nodePlanes").object(id).object("window")
        XCTAssertEqual(draftWindow.number("x"),0.6);XCTAssertEqual(draftWindow.number("rotation"),-25)
        XCTAssertEqual(draftWindow.number("softness"),0.01)
        let restored = try await renderer.render(project: source, at: 1, width: 320)
        XCTAssertEqual(original.drawGeometry,restored.drawGeometry)
        XCTAssertEqual(try String(contentsOf:file,encoding:.utf8),source)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath:root.path),["project.json"])
    }
}
