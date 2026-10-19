import Foundation
@testable import ReelKit
import XCTest

final class LibraryCoreTests: XCTestCase {
    func testEditableTitleCopyAndAnimationSurviveJavaScriptCore() throws {
        let core = try ReelCore(scriptURL: Support.core())
        let base = try core.newProject(name: "Native library", options: #"{"width":320,"height":180,"fps":30}"#)
        let source = try core.applyOps(project: base, ops: #"[{"op":"add_title","track":"V3","text":"Native heading","dur":4,"title":{"font":"Inter","size":28,"anim":"none"}},{"op":"keyframe","id":"c1","prop":"x","local":true,"at":0,"value":20},{"op":"keyframe","id":"c1","prop":"x","local":true,"at":2,"value":100},{"op":"add_mask","id":"c1","mask":{"type":"rect","x":0,"y":0,"w":100,"h":40}}]"#).project
        let saved = try core.applyOps(project: source, ops: #"[{"op":"library_save","category":"title","name":"Native heading","source":{"clip":"c1"}}]"#).project
        let library = try XCTUnwrap(object(parse(saved)["library"])["items"] as? [[String: Any]])
        let template = try XCTUnwrap(library.first)
        let id = try XCTUnwrap(template["id"] as? String)
        let applied = try core.applyOps(project: saved, ops: JSON(any: [["op": "library_apply", "item": id, "track": "V2", "start": 8]]).text).project
        let copy = try XCTUnwrap(clips(applied).first { $0["id"] as? String != "c1" })
        let copyID = try XCTUnwrap(copy["id"] as? String)
        XCTAssertEqual(copy["kind"] as? String, "title")
        XCTAssertEqual(copy["start"] as? Double, 8)
        XCTAssertEqual(object(copy["title"])["font"] as? String, "Inter")
        let originalMask = try XCTUnwrap((clips(source).first?["masks"] as? [[String: Any]])?.first?["id"] as? String)
        let copyMask = try XCTUnwrap((copy["masks"] as? [[String: Any]])?.first?["id"] as? String)
        XCTAssertNotEqual(originalMask, copyMask)
        let frame = parse(try core.framePlan(project: applied, at: 9))
        let layer = try XCTUnwrap((frame["layers"] as? [[String: Any]])?.first)
        let matrix = try XCTUnwrap(object(layer["clip"])["matrix"] as? [Double])
        XCTAssertEqual(matrix[4], 60, accuracy: 0.000001)
        let edited = try core.applyOps(project: applied, ops: JSON(any: [["op": "update", "id": copyID, "set": ["title": ["text": "Copy changed"]]]]).text).project
        XCTAssertEqual(object(clips(edited).first { $0["id"] as? String == "c1" }?["title"])["text"] as? String, "Native heading")
        let savedBody = object(object((object(parse(edited)["library"])["items"] as? [[String: Any]])?.first?["body"])["clip"])
        XCTAssertEqual(object(savedBody["title"])["text"] as? String, "Native heading")
        XCTAssertEqual(try core.migrate(fileText: core.fileText(project: edited)), edited)
        XCTAssertThrowsError(try core.applyOps(project: edited, ops: JSON(any: [["op": "library_apply", "item": id, "track": "V2", "start": 12], ["op": "library_remove", "item": "missing"]]).text))
        XCTAssertEqual(object(clips(applied).first { $0["id"] as? String == copyID }?["title"])["text"] as? String, "Native heading")
    }

    func testAuthoredTransitionCopiesEditableLayersAndRendersAcrossTheCut() throws {
        let core = try ReelCore(scriptURL: Support.core())
        let base = try core.newProject(name: "Native custom transition", options: #"{"width":320,"height":180,"fps":30}"#)
        let source = try core.applyOps(project: base, ops: ##"[{"op":"add_color","track":"V1","start":0,"dur":4,"color":"#ff0000"},{"op":"add_color","track":"V1","start":4,"dur":4,"color":"#0000ff"},{"op":"add_comp","name":"Authored curtain","duration":2},{"op":"add_shape","comp":"k1","track":"V1","dur":2,"shape":{"type":"rect","width":320,"height":180,"fill":{"color":"#ffffff"}}},{"op":"keyframe","id":"c3","prop":"opacity","local":true,"at":0,"value":0},{"op":"keyframe","id":"c3","prop":"opacity","local":true,"at":1,"value":1},{"op":"keyframe","id":"c3","prop":"opacity","local":true,"at":2,"value":0},{"op":"library_save","category":"transition","name":"Authored curtain","source":{"composition":"k1"}}]"##).project
        let template = try XCTUnwrap((object(parse(source)["library"])["items"] as? [[String: Any]])?.first)
        let id = try XCTUnwrap(template["id"] as? String)
        let result = try core.applyOps(project: source, ops: JSON(any: [["op": "library_apply", "item": id, "id": "c2"]]).text)
        let overlay = try XCTUnwrap(clips(result.project).first { $0["kind"] as? String == "comp" })
        let overlayID = try XCTUnwrap(overlay["id"] as? String)
        let compID = try XCTUnwrap(overlay["comp"] as? String)
        XCTAssertNotEqual(compID, "k1")
        XCTAssertEqual(overlay["start"] as? Double, 3)
        XCTAssertEqual(overlay["dur"] as? Double, 2)
        let target = try XCTUnwrap(clips(result.project).first { $0["id"] as? String == "c2" })
        XCTAssertEqual(target as NSDictionary, try XCTUnwrap(clips(source).first { $0["id"] as? String == "c2" }) as NSDictionary)
        let comp = object(object(parse(result.project)["comps"])[compID])
        let child = try XCTUnwrap((comp["tracks"] as? [[String: Any]])?.flatMap { $0["clips"] as? [[String: Any]] ?? [] }.first)
        XCTAssertEqual(child["kind"] as? String, "shape")
        XCTAssertNotEqual(child["id"] as? String, "c3")
        XCTAssertEqual(object(child["shape"])["width"] as? Double, 320)
        let created = try XCTUnwrap(try JSON.parse(result.created) as? [String])
        XCTAssertTrue(created.contains(overlayID))
        XCTAssertTrue(created.contains(compID))
        XCTAssertTrue(created.contains(try XCTUnwrap(child["id"] as? String)))
        for (time, expected) in [(3.5, 0.5), (4.0, 1.0), (4.5, 0.5)] {
            let frame = parse(try core.framePlan(project: result.project, at: time))
            let layer = try XCTUnwrap((frame["layers"] as? [[String: Any]])?.first { object($0["clip"])["id"] as? String == overlayID })
            let inner = object(object(layer["clip"])["composition"])
            let rendered = try XCTUnwrap((inner["layers"] as? [[String: Any]])?.first)
            XCTAssertEqual(try XCTUnwrap(object(rendered["clip"])["opacity"] as? Double), expected, accuracy: 0.000001)
        }
        XCTAssertThrowsError(try core.applyOps(project: source, ops: JSON(any: [["op": "library_apply", "item": id, "id": "c1"]]).text))
    }

    private func clips(_ project: String) -> [[String: Any]] {
        (parse(project)["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }
    }
}

final class NativeLibraryHistoryTests: XCTestCase {
    private var root: URL!
    private var backend: ReelBackend!

    override func setUp() async throws {
        root = try Support.tempFolder("library")
        backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core()) { _, _ in }
        try await backend.start()
    }

    override func tearDown() async throws {
        if let backend { await backend.stop() }
        if let root { try FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
    }

    func testSaveApplyUndoRedoAndReloadPreserveLibraryAndEditableCopies() async throws {
        _ = try await call("POST", "/api/new", #"{"name":"Native library history","width":320,"height":180,"fps":30}"#)
        let original = try await call("POST", "/api/ops", #"{"ops":[{"op":"add_title","text":"History title","dur":4,"title":{"font":"Inter","size":28,"anim":"none"}}]}"#)
        let saved = try await call("POST", "/api/ops", #"{"ops":[{"op":"library_save","category":"title","name":"Reusable history title","source":{"clip":"c1"}}]}"#)
        let savedProject = object(saved["project"])
        let entries = try XCTUnwrap(object(savedProject["library"])["items"] as? [[String: Any]])
        let id = try XCTUnwrap(entries.first?["id"] as? String)
        let applyBody = JSON(any: ["ops": [["op": "library_apply", "item": id, "track": "V2", "start": 6]]]).text
        let applied = try await call("POST", "/api/ops", applyBody)
        let appliedProject = object(applied["project"])
        XCTAssertEqual(clips(appliedProject).count, 2)
        XCTAssertEqual(try diskProject(), appliedProject as NSDictionary)
        let undoApply = try await call("POST", "/api/undo", "{}")
        XCTAssertEqual(object(undoApply["project"]) as NSDictionary, savedProject as NSDictionary)
        let redoApply = try await call("POST", "/api/redo", "{}")
        XCTAssertEqual(object(redoApply["project"]) as NSDictionary, appliedProject as NSDictionary)
        _ = try await call("POST", "/api/undo", "{}")
        let undoSave = try await call("POST", "/api/undo", "{}")
        XCTAssertEqual(object(undoSave["project"]) as NSDictionary, object(original["project"]) as NSDictionary)
        _ = try await call("POST", "/api/redo", "{}")
        _ = try await call("POST", "/api/redo", "{}")
        let before = try await call("GET", "/api/project")
        let invalid = JSON(any: ["ops": [["op": "library_apply", "item": id, "track": "V2", "start": 12], ["op": "library_rename", "item": "missing", "name": "Rejected"]]]).text
        do {
            _ = try await call("POST", "/api/ops", invalid)
            XCTFail("accepted an invalid library batch")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("item does not exist"))
        }
        let after = try await call("GET", "/api/project")
        XCTAssertEqual(after["version"] as? Int, before["version"] as? Int)
        XCTAssertEqual(object(after["project"]) as NSDictionary, appliedProject as NSDictionary)
        XCTAssertEqual(try diskProject(), appliedProject as NSDictionary)
        await backend.stop()
        backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core()) { _, _ in }
        try await backend.start()
        let reloaded = try await call("GET", "/api/project")
        XCTAssertEqual(object(reloaded["project"]) as NSDictionary, appliedProject as NSDictionary)
        XCTAssertEqual(object((clips(object(reloaded["project"])).first { $0["id"] as? String != "c1" })?["title"])["text"] as? String, "History title")
    }

    private func call(_ method: String, _ path: String, _ body: String? = nil) async throws -> [String: Any] {
        parse(try await backend.handle(method: method, path: path, body: body).text)
    }

    private func diskProject() throws -> NSDictionary {
        parse(try String(contentsOf: root.appendingPathComponent("reel.project.json"), encoding: .utf8)) as NSDictionary
    }

    private func clips(_ project: [String: Any]) -> [[String: Any]] {
        (project["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }
    }
}
