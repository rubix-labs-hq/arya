import CoreVideo
import Foundation
import XCTest
@testable import ReelKit

final class ShortsRenderingTests: XCTestCase {
    func testPortraitShortFillsCanvasAndVisionUsesNestedDimensions() async throws {
        let root = try Support.tempFolder("portrait-short"), folder = ProjectFolder(root: root)
        try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: true)
        let file = folder.mediaDir.appendingPathComponent("talk.mp4")
        try FileManager.default.copyItem(at: Support.fixture("clip.mp4"), to: file)
        let original = try Data(contentsOf: file)
        let core = try ReelCore(scriptURL: Support.core())
        let backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _,_ in }
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"width":320,"height":180}"#)
        _ = try await backend.handle(method: "POST", path: "/api/import", body: #"{"paths":["media/talk.mp4"]}"#)
        let beforeSnapshot = await backend.currentProject()
        let before = try XCTUnwrap(beforeSnapshot)
        let built = parse(try await backend.handle(method: "POST", path: "/api/shorts/build", body: #"{"src":"media/talk.mp4","ranges":[{"from":0,"to":0.7}],"width":180,"height":320,"captions":false,"apply":true}"#).text)
        let compID = try XCTUnwrap((built["comps"] as? [[String: Any]])?.first?["id"] as? String)
        let projectSnapshot = await backend.currentProject()
        let project = try XCTUnwrap(projectSnapshot)
        let comp = object(object(parse(project)["comps"])[compID])
        let clip = try XCTUnwrap((comp["tracks"] as? [[String: Any]])?.flatMap { $0["clips"] as? [[String: Any]] ?? [] }.first { $0["kind"] as? String == "video" })
        let clipID = try XCTUnwrap(clip["id"] as? String)
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let filled = try await renderer.render(project: project, at: 0.2, comp: compID)
        let contained = try core.applyOps(project: project, ops: JSON(any: [["op":"update","id":clipID,"set":["fit":"contain"]]]).text).project
        let letterboxed = try await renderer.render(project: contained, at: 0.2, comp: compID)
        for y in [5, 315] {
            XCTAssertTrue((0..<180).allSatisfy { pixel(letterboxed.pixelBuffer, $0, y).prefix(3).allSatisfy { $0 < 3 } })
            XCTAssertGreaterThan((0..<180).filter { pixel(filled.pixelBuffer, $0, y).prefix(3).contains { $0 > 30 } }.count, 30, "A portrait short has visible source pixels at both canvas edges.")
        }
        let version = try XCTUnwrap(built["version"] as? Int)
        let options: [String: Any] = ["id":clipID,"src":"media/talk.mp4","dur":0.5,"fps":2,"apply":true,"expectedVersion":version]
        let framed = parse(try await backend.handle(method:"POST",path:"/api/analysis/autoreframe",body:JSON(any:options).text).text)
        XCTAssertEqual(framed["width"] as? Double,180)
        XCTAssertEqual(framed["height"] as? Double,320)
        let updatedSnapshot = await backend.currentProject()
        let updated = parse(try XCTUnwrap(updatedSnapshot))
        let changedComp = object(object(updated["comps"])[compID])
        let changed = try XCTUnwrap((changedComp["tracks"] as? [[String: Any]])?.flatMap { $0["clips"] as? [[String: Any]] ?? [] }.first { $0["id"] as? String == clipID })
        XCTAssertEqual(changed["fit"] as? String,"cover")
        XCTAssertEqual(changed["scale"] as? Double,1,"Cover fit supplies the crop without a second zoom.")
        XCTAssertFalse(object(changed["anim"]).isEmpty)
        do { _ = try await backend.handle(method:"POST",path:"/api/analysis/autoreframe",body:JSON(any:options).text); XCTFail("Accepted a stale project version") } catch { XCTAssertTrue(error.localizedDescription.contains("changed")) }
        _ = try await backend.handle(method:"POST",path:"/api/undo",body:"{}")
        let undoFraming = await backend.currentProject()
        XCTAssertEqual(try XCTUnwrap(undoFraming),project)
        _ = try await backend.handle(method:"POST",path:"/api/undo",body:"{}")
        let undoShort = await backend.currentProject()
        XCTAssertEqual(try XCTUnwrap(undoShort),before)
        XCTAssertEqual(try Data(contentsOf:file),original)
        await backend.stop()
    }

    func testCoverFitAppliesToNestedCompositionPixels() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("cover-comp")), core = try ReelCore(scriptURL: Support.core())
        let project = try core.newProject(name:"Cover",options:#"{"width":160,"height":90}"#)
        let contain = try core.applyOps(project:project,ops:##"[{"op":"add_comp","width":80,"height":20,"duration":1},{"op":"add_shape","comp":"k1","track":"V1","dur":1,"shape":{"type":"rect","width":80,"height":20,"fill":{"color":"#ff0000"}}},{"op":"comp_clip","target":"k1","track":"V1","dur":1}]"##).project
        let cover = try core.applyOps(project:contain,ops:#"[{"op":"update","id":"c2","set":{"fit":"cover"}}]"#).project
        let renderer = try ReelMetalRenderer(folder:folder,coreScriptURL:Support.core())
        let a = try await renderer.render(project:contain,at:0), b = try await renderer.render(project:cover,at:0)
        XCTAssertEqual(pixel(a.pixelBuffer,80,5).prefix(3),[0,0,0])
        XCTAssertEqual(pixel(b.pixelBuffer,80,5),[255,0,0,255])
    }
}
