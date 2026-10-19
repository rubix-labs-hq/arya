import Foundation
import XCTest
@testable import ReelKit

final class RenderPreviewTests: XCTestCase {
    func testTransientPixelsRestoreWithoutProjectOrHistoryWrites() async throws {
        let root = try Support.tempFolder("render-preview"), folder = ProjectFolder(root: root)
        let core = try ReelCore(scriptURL: Support.core())
        var base = parse(try core.newProject(name: "Preview", options: #"{"width":160,"height":90}"#))
        base["background"] = "transparent"
        let project = try core.applyOps(project: JSON(any: base).text, ops: ##"[{"op":"add_shape","dur":3,"shape":{"type":"rect","width":20,"height":20,"fill":{"color":"#ff0000"}},"set":{"x":40,"y":45}}]"##).project
        let file = root.appendingPathComponent("project.json")
        try project.write(to: file, atomically: true, encoding: .utf8)
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let before = try await renderer.render(project: project, at: 1)
        let preview = try await renderer.renderPreview(project: project, operations: #"[{"op":"update","id":"c1","comp":null,"set":{"x":120}}]"#, at: 1)
        let restored = try await renderer.render(project: project, at: 1)
        XCTAssertEqual(pixel(before.pixelBuffer, 40, 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(preview.pixelBuffer, 120, 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(preview.pixelBuffer, 40, 45)[3], 0)
        XCTAssertEqual(pixel(restored.pixelBuffer, 40, 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(restored.pixelBuffer, 120, 45)[3], 0)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), project)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["project.json"])
    }

    func testEvaluatedPoseAndParentDeltaFollowSharedCore() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("preview-parent")), core = try ReelCore(scriptURL: Support.core())
        var base = parse(try core.newProject(name: "Parent", options: #"{"width":160,"height":90}"#)); base["background"] = "transparent"
        let project = try core.applyOps(project: JSON(any: base).text, ops: ##"[{"op":"add_shape","dur":3,"shape":{"type":"rect","width":20,"height":20,"fill":{"color":"#ff0000"}},"set":{"x":40,"y":45}},{"op":"add_null","track":"V2","dur":3,"set":{"x":80,"y":45}},{"op":"parent","id":"c1","parent":"c2"},{"op":"expression","id":"c2","prop":"x","expr":"value + time * 60"},{"op":"keyframe","id":"c1","prop":"scale","at":0,"value":1,"local":true},{"op":"keyframe","id":"c1","prop":"scale","at":2,"value":2,"local":true}]"##).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let frame = try await renderer.render(project: project, at: 1)
        let transforms = try JSON.parse(frame.editTransforms.text) as! [[String: Any]]
        let pose = transforms.first { $0.string("id") == "c1" }!.object("pose")
        XCTAssertEqual(pose.number("x"), 40, accuracy: 0.00001)
        XCTAssertEqual(pose.number("scale"), 1.5, accuracy: 0.00001)
        let parent = pose["parentMatrix"] as! [Double]
        XCTAssertEqual(parent[0], 1, accuracy: 0.00001)
        XCTAssertEqual(parent[4], 60, accuracy: 0.00001)
        XCTAssertEqual(pixel(frame.pixelBuffer, 100, 45), [255, 0, 0, 255])
        let draft = try await renderer.renderPreview(project: project, operations: #"[{"op":"update","id":"c1","set":{"x":60}},{"op":"keyframe","id":"c1","prop":"scale","at":1,"local":true,"value":0.5}]"#, at: 1)
        XCTAssertEqual(pixel(draft.pixelBuffer, 120, 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(draft.pixelBuffer, 100, 45)[3], 0)
        let p = try JSON.parse(draft.editTransforms.text) as! [[String: Any]]
        XCTAssertEqual(p.first { $0.string("id") == "c1" }!.object("pose").number("scale"), 0.5)
    }

    func testNestedScopeAndNodeGradeDraftsRenderWithoutChangingOtherScope() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("preview-scope")), core = try ReelCore(scriptURL: Support.core())
        let base = try core.newProject(name: "Scoped", options: #"{"width":160,"height":90}"#)
        let project = try core.applyOps(project: base, ops: ##"[{"op":"add_color","color":"#ff0000","dur":2},{"op":"add_comp","width":160,"height":90},{"op":"add_color","comp":"k1","color":"#00ff00","dur":2,"set":{"id":"c1"}},{"op":"node_add","comp":"k1","id":"c1","node":{"type":"corrector"}}]"##).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let gray = try await renderer.renderPreview(project: project, operations: #"[{"op":"node_update","comp":"k1","id":"c1","node":"n4","set":{"grade":{"saturation":0}}}]"#, at: 1, comp: "k1")
        let rgb = pixel(gray.pixelBuffer, 80, 45)
        XCTAssertLessThanOrEqual(abs(Int(rgb[0]) - Int(rgb[1])), 2)
        XCTAssertLessThanOrEqual(abs(Int(rgb[1]) - Int(rgb[2])), 2)
        let main = try await renderer.render(project: project, at: 1)
        let nested = try await renderer.render(project: project, at: 1, comp: "k1")
        XCTAssertEqual(pixel(main.pixelBuffer, 80, 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(nested.pixelBuffer, 80, 45), [0, 255, 0, 255])
    }

    func testMotionEasingDraftChangesPixelsWithoutSaving() async throws {
        let root = try Support.tempFolder("preview-easing"), folder = ProjectFolder(root: root)
        let core = try ReelCore(scriptURL: Support.core())
        var base = parse(try core.newProject(name: "Easing", options: #"{"width":160,"height":90}"#))
        base["background"] = "transparent"
        let project = try core.applyOps(project: JSON(any: base).text, ops: ##"[{"op":"add_shape","dur":3,"shape":{"type":"rect","width":20,"height":20,"fill":{"color":"#ff0000"}},"set":{"x":40,"y":45}},{"op":"keyframe","id":"c1","prop":"x","local":true,"at":0,"value":40},{"op":"keyframe","id":"c1","prop":"x","local":true,"at":2,"value":120}]"##).project
        let file = folder.projectFile
        try project.write(to: file, atomically: true, encoding: .utf8)
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let original = try await renderer.render(project: project, at: 1)
        let eased = try await renderer.renderPreview(project: project, operations: #"[{"op":"keyframe_ease","id":"c1","prop":"x","index":0,"ease":"hold","comp":null}]"#, at: 1)
        XCTAssertEqual(pixel(original.pixelBuffer, 80, 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(eased.pixelBuffer, 40, 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(eased.pixelBuffer, 80, 45)[3], 0)
        let restored = try await renderer.render(project: project, at: 1)
        XCTAssertEqual(pixel(restored.pixelBuffer, 80, 45), [255, 0, 0, 255])
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), project)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["reel.project.json"])
    }

    func testDraftLimitsAndCancellationRejectBeforeRendering() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("preview-limits")), core = try ReelCore(scriptURL: Support.core())
        let project = try core.newProject(name: "Limits", options: #"{"width":160,"height":90}"#)
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        for ops in ["[]", "{}", #"[{"op":"add_title","text":"unexpected"}]"#, JSON(any: Array(repeating: ["op": "update", "id": "c1"], count: 257)).text, String(repeating: " ", count: 256 * 1024 + 1)] {
            do { _ = try await renderer.renderPreview(project: project, operations: ops, at: 0); XCTFail("Invalid preview accepted") } catch { }
        }
        let gate = PreviewGate()
        let task = Task { () throws -> ReelRenderedFrame in
            await gate.wait()
            return try await renderer.renderPreview(project: project, operations: #"[{"op":"update","id":"c1","set":{"x":20}}]"#, at: 0)
        }
        while !(await gate.entered) { await Task.yield() }
        task.cancel(); await gate.release()
        do { _ = try await task.value; XCTFail("Cancelled preview accepted") } catch is CancellationError { }
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: folder.root.path).isEmpty)
    }
}

private actor PreviewGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var entered = false
    func wait() async { await withCheckedContinuation { continuation = $0; entered = true } }
    func release() { continuation?.resume(); continuation = nil }
}
