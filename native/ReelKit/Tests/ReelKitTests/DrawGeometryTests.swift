import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import ReelKit

final class DrawGeometryTests: XCTestCase {
    private func records(_ frame: ReelRenderedFrame) throws -> [[String: Any]] { try JSON.parse(frame.drawGeometry.text) as! [[String: Any]] }
    private func first(_ frame: ReelRenderedFrame) throws -> [String: Any] { try XCTUnwrap(records(frame).first) }
    private func blank(_ core: ReelCore) throws -> String {
        var project = parse(try core.newProject(name: "Draw geometry", options: #"{"width":160,"height":90}"#))
        project["background"] = "transparent"
        return JSON(any: project).text
    }

    func testActualShapeCropAndParentPoseMatchDrawnPixels() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("draw-shape")), core = try ReelCore(scriptURL: Support.core())
        let project = try core.applyOps(project: blank(core), ops: ##"[{"op":"add_shape","dur":3,"shape":{"type":"rect","width":20,"height":10,"fill":{"color":"#ff0000"}},"set":{"x":40,"y":45,"crop":{"l":0.25}}},{"op":"add_null","track":"V2","dur":3,"set":{"x":80,"y":45}},{"op":"parent","id":"c1","parent":"c2"},{"op":"expression","id":"c2","prop":"x","expr":"value + time * 20"}]"##).project
        let frame = try await ReelMetalRenderer(folder: folder, coreScriptURL: Support.core()).render(project: project, at: 1)
        let entries = try records(frame)
        XCTAssertEqual(entries.count, 1)
        let entry = entries[0], matrix = entry["matrix"] as! [Double]
        XCTAssertEqual(entry.string("id"), "c1"); XCTAssertEqual(entry.string("kind"), "shape")
        XCTAssertEqual(entry.number("width"), 24); XCTAssertEqual(entry.number("height"), 14)
        XCTAssertEqual(entry.object("crop").number("l"), 0.25)
        XCTAssertEqual(matrix[4], 60, accuracy: 0.00001)
        XCTAssertEqual(entry.object("pose").number("x"), 40)
        XCTAssertEqual(pixel(frame.pixelBuffer, 60, 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(frame.pixelBuffer, 53, 45)[3], 0)
        XCTAssertEqual(pixel(frame.pixelBuffer, 72, 45)[3], 0)
    }

    func testOrientedImageContainAndCoverUseActualDecodedDimensions() async throws {
        let root = try Support.tempFolder("draw-orientation"), folder = ProjectFolder(root: root), core = try ReelCore(scriptURL: Support.core())
        let context = CGContext(data: nil, width: 40, height: 20, bitsPerComponent: 8, bytesPerRow: 160, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 40, height: 20))
        let url = root.appendingPathComponent("oriented.jpg"), destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, [kCGImagePropertyOrientation: 6] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let project = try core.applyOps(project: blank(core), ops: #"[{"op":"import","assets":{"oriented.jpg":{"still":true,"hasVideo":true,"width":40,"height":20}}},{"op":"append","src":"oriented.jpg","dur":3}]"#).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let contained = try await renderer.render(project: project, at: 1)
        let contain = try first(contained)
        XCTAssertEqual(contain.number("width"), 45, accuracy: 0.00001)
        XCTAssertEqual(contain.number("height"), 90, accuracy: 0.00001)
        XCTAssertGreaterThan(pixel(contained.pixelBuffer, 80, 45)[3], 250)
        XCTAssertEqual(pixel(contained.pixelBuffer, 55, 45)[3], 0)
        let coveredProject = try core.applyOps(project: project, ops: #"[{"op":"update","id":"c1","set":{"fit":"cover"}}]"#).project
        let covered = try await renderer.render(project: coveredProject, at: 1)
        let cover = try first(covered)
        XCTAssertEqual(cover.number("width"), 160, accuracy: 0.00001)
        XCTAssertEqual(cover.number("height"), 320, accuracy: 0.00001)
        XCTAssertGreaterThan(pixel(covered.pixelBuffer, 5, 45)[3], 250)
    }

    func testNestedCompositionPublishesOnlyItsOuterTarget() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("draw-nested")), core = try ReelCore(scriptURL: Support.core())
        let project = try core.applyOps(project: blank(core), ops: ##"[{"op":"add_comp","width":80,"height":80,"duration":3},{"op":"add_shape","comp":"k1","dur":3,"shape":{"type":"rect","width":80,"height":80,"fill":{"color":"#ff0000"}}},{"op":"comp_clip","target":"k1","dur":3}]"##).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let main = try await renderer.render(project: project, at: 1), inner = try await renderer.render(project: project, at: 1, comp: "k1")
        let outerEntries = try records(main), innerEntries = try records(inner)
        XCTAssertEqual(outerEntries.count, 1); XCTAssertEqual(outerEntries[0].string("kind"), "comp")
        XCTAssertEqual(outerEntries[0].number("width"), 90); XCTAssertEqual(outerEntries[0].number("height"), 90)
        XCTAssertEqual(innerEntries.count, 1); XCTAssertEqual(innerEntries[0].string("kind"), "shape")
        XCTAssertNotEqual(outerEntries[0].string("id"), innerEntries[0].string("id"))
        XCTAssertEqual(pixel(main.pixelBuffer, 80, 45), [255, 0, 0, 255])
        XCTAssertEqual(pixel(main.pixelBuffer, 30, 45)[3], 0)
    }

    func testTitleUsesCoreTextRasterExtentsAndStableTypewriterLayout() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("draw-title")), core = try ReelCore(scriptURL: Support.core())
        let project = try core.applyOps(project: blank(core), ops: ##"[{"op":"add_title","text":"Golden","dur":3,"title":{"font":"Helvetica Neue","size":120,"weight":700,"plate":"#ffffff","padding":24,"shadow":{"color":"#000000","blur":12,"x":3,"y":4},"anim":"typewriter"}}]"##).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let first = try await renderer.render(project: project, at: 0.2), last = try await renderer.render(project: project, at: 1)
        let a = try self.first(first), b = try self.first(last)
        let plan = parse(try core.framePlan(project: project, at: 1, comp: nil)), clip = (plan["layers"] as! [[String: Any]])[0].object("clip")
        let raster = try NativeRasterizer().title(clip.object("title"), state: clip.object("titleState"), scale: 90.0 / 1080)
        XCTAssertEqual(b.number("width"), raster.width * 90 / 1080, accuracy: 0.00001)
        XCTAssertEqual(b.number("height"), raster.height * 90 / 1080, accuracy: 0.00001)
        XCTAssertEqual(a.number("width"), b.number("width")); XCTAssertEqual(a.number("height"), b.number("height"))
        XCTAssertGreaterThan(pixel(last.pixelBuffer, 80, 45)[3], 0)
    }

    func testMatteSourcesAndTransitionWarpsDoNotPublishTargets() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("draw-exclusions")), core = try ReelCore(scriptURL: Support.core()), base = try blank(core)
        let matted = try core.applyOps(project: base, ops: ##"[{"op":"add_shape","dur":3,"shape":{"type":"rect","width":40,"height":40,"fill":{"color":"#ff0000"}}},{"op":"add_shape","track":"V2","dur":3,"shape":{"type":"rect","width":20,"height":20,"fill":{"color":"#ffffff"}}},{"op":"matte","id":"c1","matte":{"mode":"alpha","source":"c2"}}]"##).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let matte = try await renderer.render(project: matted, at: 1)
        XCTAssertEqual(try records(matte).map { $0.string("id") }, ["c1"])
        XCTAssertEqual(try records(matte)[0].number("width"), 44)
        XCTAssertEqual(pixel(matte.pixelBuffer, 80, 45), [255, 0, 0, 255]); XCTAssertEqual(pixel(matte.pixelBuffer, 95, 45)[3], 0)
        let transitioned = try core.applyOps(project: base, ops: ##"[{"op":"add_shape","start":0,"dur":2,"shape":{"type":"rect","width":20,"height":20,"fill":{"color":"#ff0000"}}},{"op":"add_shape","start":2,"dur":2,"shape":{"type":"rect","width":20,"height":20,"fill":{"color":"#00ff00"}}},{"op":"transition","id":"c2","type":"slideLeft","dur":1}]"##).project
        let transition = try await renderer.render(project: transitioned, at: 2)
        XCTAssertTrue(try records(transition).isEmpty)
    }

    func testPreviewGeometryIsImmutableAndRestoresWithoutWrites() async throws {
        let root = try Support.tempFolder("draw-preview"), folder = ProjectFolder(root: root), core = try ReelCore(scriptURL: Support.core())
        let project = try core.applyOps(project: blank(core), ops: ##"[{"op":"add_shape","dur":3,"shape":{"type":"rect","width":20,"height":10,"fill":{"color":"#ff0000"}},"set":{"x":40,"y":45}}]"##).project
        let file = root.appendingPathComponent("project.json"); try project.write(to: file, atomically: true, encoding: .utf8)
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core()), operations = #"[{"op":"update","id":"c1","comp":null,"set":{"x":120,"rotation":90}}]"#
        async let originalRequest = renderer.render(project: project, at: 1)
        async let draftRequest = renderer.renderPreview(project: project, operations: operations, at: 1)
        let original = try await originalRequest, draft = try await draftRequest
        let originalJSON = original.drawGeometry.text, draftJSON = draft.drawGeometry.text
        XCTAssertEqual((try records(original)[0]["matrix"] as! [Double])[4], 40)
        XCTAssertEqual((try records(draft)[0]["matrix"] as! [Double])[4], 120)
        XCTAssertEqual(try records(draft)[0].object("pose").number("rotation"), 90)
        let restored = try await renderer.render(project: project, at: 1)
        XCTAssertEqual(restored.drawGeometry.text, originalJSON); XCTAssertEqual(draft.drawGeometry.text, draftJSON)
        XCTAssertEqual(pixel(restored.pixelBuffer, 40, 45), [255, 0, 0, 255]); XCTAssertEqual(pixel(restored.pixelBuffer, 120, 45)[3], 0)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), project)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["project.json"])
    }
}
