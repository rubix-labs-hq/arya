import Foundation
import XCTest
@testable import ReelKit

final class MotionDraftPreviewTests: XCTestCase {
    func testGroupedKeyDraftPixelsAndOneExactScopedUndo() async throws {
        for scope in [nil, "k1"] as [String?] {
            let root = try Support.tempFolder("motion-draft-undo"), folder = ProjectFolder(root: root)
            let core = try ReelCore(scriptURL: Support.core())
            var base = parse(try core.newProject(name: "Motion", options: #"{"width":160,"height":90,"fps":30}"#))
            base["background"] = "transparent"
            let project = try core.applyOps(project: JSON(any: base).text, ops: ##"[{"op":"add_shape","dur":4,"shape":{"type":"rect","width":12,"height":12,"fill":{"color":"#ff0000"}},"set":{"x":20,"y":35}},{"op":"keyframe","id":"c1","prop":"x","local":true,"at":0,"value":20,"ease":"linear"},{"op":"keyframe","id":"c1","prop":"x","local":true,"at":2,"value":120},{"op":"keyframe","id":"c1","prop":"y","local":true,"at":0,"value":35,"ease":"hold"},{"op":"keyframe","id":"c1","prop":"y","local":true,"at":2,"value":55},{"op":"add_comp","width":160,"height":90,"fps":24},{"op":"add_shape","comp":"k1","dur":4,"shape":{"type":"rect","width":12,"height":12,"fill":{"color":"#00ff00"}},"set":{"id":"c1","x":20,"y":35}},{"op":"keyframe","comp":"k1","id":"c1","prop":"x","local":true,"at":0,"value":20,"ease":"linear"},{"op":"keyframe","comp":"k1","id":"c1","prop":"x","local":true,"at":2,"value":120},{"op":"keyframe","comp":"k1","id":"c1","prop":"y","local":true,"at":0,"value":35,"ease":"hold"},{"op":"keyframe","comp":"k1","id":"c1","prop":"y","local":true,"at":2,"value":55}]"##).project
            try core.fileText(project: project).write(to: folder.projectFile, atomically: true, encoding: .utf8)
            let backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _, _ in }
            try await backend.start()
            do {
                let state = parse(try await backend.handle(method: "GET", path: "/api/project", body: nil).text)
                let version = try XCTUnwrap(state["version"] as? Int)
                let before = try Data(contentsOf: folder.projectFile)
                let scopeValue: Any = scope as Any? ?? NSNull()
                let operations: [[String: Any]] = [
                    ["op": "keyframe", "comp": scopeValue, "id": "c1", "prop": "x", "local": true, "at": 0, "remove": true],
                    ["op": "keyframe", "comp": scopeValue, "id": "c1", "prop": "y", "local": true, "at": 0, "remove": true],
                    ["op": "keyframe", "comp": scopeValue, "id": "c1", "prop": "x", "local": true, "at": 0.5, "value": 25, "ease": "linear"],
                    ["op": "keyframe", "comp": scopeValue, "id": "c1", "prop": "y", "local": true, "at": 0.5, "value": 35, "ease": "hold"]
                ]
                let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
                let original = try await renderer.render(project: project, at: 1, comp: scope)
                let draft = try await renderer.renderPreview(project: project, operations: JSON(any: operations).text, at: 1, comp: scope)
                let color: [UInt8] = scope == nil ? [255, 0, 0, 255] : [0, 255, 0, 255]
                XCTAssertEqual(pixel(original.pixelBuffer, 70, 35), color)
                XCTAssertEqual(pixel(draft.pixelBuffer, 57, 35), color)
                XCTAssertEqual(pixel(draft.pixelBuffer, 70, 35)[3], 0)
                XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
                let afterPreview = parse(try await backend.handle(method: "GET", path: "/api/project", body: nil).text)
                XCTAssertEqual(afterPreview["version"] as? Int, version)
                let restored = try await renderer.render(project: project, at: 1, comp: scope)
                XCTAssertEqual(pixel(restored.pixelBuffer, 70, 35), color)
                XCTAssertEqual(pixel(restored.pixelBuffer, 57, 35)[3], 0)
                let committed = parse(try await backend.handle(method: "POST", path: "/api/ops", body: JSON(any: ["ops": operations, "expectedVersion": version, "returnProject": true]).text).text)
                XCTAssertEqual(committed["version"] as? Int, version + 1)
                let scopedProject = JSON(any: committed["project"]!).text
                let unchangedScope = scope == nil ? "k1" : nil
                let other = try await renderer.render(project: scopedProject, at: 1, comp: unchangedScope)
                XCTAssertEqual(pixel(other.pixelBuffer, 70, 35), scope == nil ? [0, 255, 0, 255] : [255, 0, 0, 255])
                let applied = try await renderer.render(project: scopedProject, at: 1, comp: scope)
                XCTAssertEqual(pixel(applied.pixelBuffer, 57, 35), color)
                _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
                XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
                let undone = try await renderer.render(project: try String(contentsOf: folder.projectFile, encoding: .utf8), at: 1, comp: scope)
                XCTAssertEqual(pixel(undone.pixelBuffer, 70, 35), color)
                let secondUndo = parse(try await backend.handle(method: "POST", path: "/api/undo", body: "{}").text)
                XCTAssertEqual(secondUndo["version"] as? Int, version + 2)
                XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
                await backend.stop()
            } catch {
                await backend.stop()
                throw error
            }
        }
    }

    func testCustomBezierDraftRendersSharedCorePoseAndRestores() async throws {
        let root = try Support.tempFolder("motion-bezier"), folder = ProjectFolder(root: root)
        let core = try ReelCore(scriptURL: Support.core())
        var base = parse(try core.newProject(name: "Bezier", options: #"{"width":160,"height":90}"#))
        base["background"] = "transparent"
        let project = try core.applyOps(project: JSON(any: base).text, ops: ##"[{"op":"add_shape","dur":3,"shape":{"type":"rect","width":12,"height":12,"fill":{"color":"#ff0000"}},"set":{"x":20,"y":45}},{"op":"keyframe","id":"c1","prop":"x","local":true,"at":0,"value":20},{"op":"keyframe","id":"c1","prop":"x","local":true,"at":2,"value":120},{"op":"expression","id":"c1","prop":"x","expr":"value + time * 2"}]"##).project
        try project.write(to: folder.projectFile, atomically: true, encoding: .utf8)
        let operations = #"[{"op":"keyframe_ease","id":"c1","prop":"x","index":0,"ease":[0.2,0,0.8,0.1],"comp":null}]"#
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let before = try await renderer.render(project: project, at: 1)
        let draft = try await renderer.renderPreview(project: project, operations: operations, at: 1)
        let projected = try core.applyOps(project: project, ops: operations).project
        let projectedFrame = try await renderer.render(project: projected, at: 1)
        let transform = try XCTUnwrap((try JSON.parse(draft.editTransforms.text) as? [[String: Any]])?.first { $0["id"] as? String == "c1" })
        let pose = transform.object("pose")
        let x = try XCTUnwrap(pose["x"] as? Double)
        XCTAssertLessThan(x, 45)
        XCTAssertGreaterThan(x, 20)
        XCTAssertEqual(pixel(before.pixelBuffer, 72, 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(draft.pixelBuffer, Int(x.rounded()), 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(draft.pixelBuffer, 72, 45)[3], 0)
        XCTAssertEqual(pixel(draft.pixelBuffer, Int(x.rounded()), 45), pixel(projectedFrame.pixelBuffer, Int(x.rounded()), 45))
        let clips = (parse(projected)["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }
        let clip = try XCTUnwrap(clips.first { $0["id"] as? String == "c1" })
        XCTAssertEqual(clip.object("expr")["x"] as? String, "value + time * 2")
        let restored = try await renderer.render(project: project, at: 1)
        XCTAssertEqual(pixel(restored.pixelBuffer, 72, 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(restored.pixelBuffer, Int(x.rounded()), 45)[3], 0)
        XCTAssertEqual(try String(contentsOf: folder.projectFile, encoding: .utf8), project)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["reel.project.json"])
    }
}
