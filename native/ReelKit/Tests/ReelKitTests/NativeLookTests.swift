import CoreGraphics
import Foundation
import ImageIO
import XCTest
@testable import ReelKit

final class NativeLookTests: XCTestCase {
    func testGeneratedLookIsAnEditableLUTWithUndoAndActualGrayscalePixels() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder())
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), events: { _, _ in })
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"name":"Look","width":64,"height":64}"#)
        _ = try await backend.handle(method: "POST", path: "/api/ops", body: ##"{"ops":[{"op":"add_color","color":"#cf4226","dur":1}]}"##)
        let state = parse(try await backend.handle(method: "GET", path: "/api/project", body: nil).text)
        let project = try XCTUnwrap(state["project"] as? [String: Any])
        let tracks = try XCTUnwrap(project["tracks"] as? [[String: Any]])
        let id = try XCTUnwrap(tracks.flatMap { $0["clips"] as? [[String: Any]] ?? [] }.first?["id"] as? String)
        let look = try await backend.handle(method: "POST", path: "/api/looks/match", body: JSON(any: ["grade": ["saturation": 0], "name": "Monochrome", "size": 17, "clip": id, "apply": true]).text)
        let path = try XCTUnwrap(parse(look.text)["lut"] as? String)
        XCTAssertTrue(FileManager.default.fileExists(atPath: try folder.resolve(path).path))
        let current = try await backend.handle(method: "GET", path: "/api/project", body: nil)
        XCTAssertTrue(current.text.contains(path))
        let rendered = parse(try await backend.handle(method: "POST", path: "/api/frame", body: #"{"at":0,"width":64}"#).text)
        let imagePath = try XCTUnwrap(rendered["path"] as? String)
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(folder.resolve(imagePath) as CFURL, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        var pixel = [UInt8](repeating: 0, count: 4)
        pixel.withUnsafeMutableBytes { bytes in
            let context = CGContext(data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        XCTAssertLessThanOrEqual(abs(Int(pixel[0]) - Int(pixel[1])), 2)
        XCTAssertLessThanOrEqual(abs(Int(pixel[1]) - Int(pixel[2])), 2)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let undone = try await backend.handle(method: "GET", path: "/api/project", body: nil)
        XCTAssertFalse(undone.text.contains(path))
        await backend.stop()
    }

    func testGeneratedWholeTimelineLookUsesActualAdjustmentOperationAndExactUndo() async throws {
        try await assertNoTargetLook(comp: nil)
    }

    func testGeneratedNestedLookKeepsMainTimelineAndExactUndo() async throws {
        try await assertNoTargetLook(comp: "k1")
    }

    private func assertNoTargetLook(comp: String?) async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("whole-look"))
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), events: { _, _ in })
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"name":"Whole look","width":64,"height":64}"#)
        _ = try await backend.handle(method: "POST", path: "/api/ops", body: ##"{"ops":[{"op":"add_color","color":"#cf4226","dur":2},{"op":"add_comp","width":64,"height":64},{"op":"add_color","comp":"k1","color":"#2244cc","dur":2}]}"##)
        let before = parse(try await backend.handle(method: "GET", path: "/api/project", body: nil).text)
        let original = JSON(any: before["project"]).text
        let options: [String: Any] = ["grade": ["saturation": 0], "size": 17, "comp": comp as Any? ?? NSNull(), "expectedVersion": before["version"]!, "apply": false]
        let generated = parse(try await backend.handle(method: "POST", path: "/api/looks/match", body: JSON(any: options).text).text)
        let ops = try XCTUnwrap(generated["ops"] as? [[String: Any]])
        XCTAssertEqual(ops.first?.string("op"), "adjustment")
        if let comp { XCTAssertEqual(ops.first?["comp"] as? String, comp) }
        else { XCTAssertTrue(ops.first?["comp"] is NSNull) }
        let still = parse(try await backend.handle(method: "GET", path: "/api/project", body: nil).text)
        XCTAssertEqual(JSON(any: still["project"]).text, original)
        XCTAssertEqual(still["version"] as? Int, before["version"] as? Int)
        let applied = parse(try await backend.handle(method: "POST", path: "/api/ops", body: JSON(any: ["ops": ops, "expectedVersion": before["version"]!]).text).text)
        XCTAssertEqual(applied["version"] as? Int, before.int("version") + 1)
        let current = parse(try await backend.handle(method: "GET", path: "/api/project", body: nil).text)
        let root = try XCTUnwrap(current["project"] as? [String: Any])
        let timeline = comp.flatMap { root.object("comps")[$0] as? [String: Any] } ?? root
        let adjustments = (timeline["tracks"] as! [[String: Any]]).flatMap { $0["clips"] as! [[String: Any]] }.filter { $0.string("kind") == "adjustment" }
        XCTAssertEqual(adjustments.count, 1)
        XCTAssertEqual(adjustments[0].number("dur"), 2)
        XCTAssertEqual(adjustments[0].object("grade").string("lut"), generated.string("lut"))
        if comp != nil { XCTAssertEqual(JSON(any: root["tracks"]).text, JSON(any: (before["project"] as! [String: Any])["tracks"]).text) }
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let gray = try await renderer.render(project: JSON(any: root).text, at: 1, comp: comp)
        let values = pixel(gray.pixelBuffer, 32, 32)
        XCTAssertLessThanOrEqual(abs(Int(values[0]) - Int(values[1])), 2)
        XCTAssertLessThanOrEqual(abs(Int(values[1]) - Int(values[2])), 2)
        if comp != nil {
            let main = try await renderer.render(project: JSON(any: root).text, at: 1)
            XCTAssertEqual(pixel(main.pixelBuffer, 32, 32), [207, 66, 38, 255])
        }
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let undone = parse(try await backend.handle(method: "GET", path: "/api/project", body: nil).text)
        XCTAssertEqual(JSON(any: undone["project"]).text, original)
        await backend.stop()
    }

    func testMatchingIdenticalReferencePreservesColorsAndRejectsLinkedOutput() throws {
        let folder = ProjectFolder(root: try Support.tempFolder()), outside = try Support.tempFolder("original")
        try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: true)
        let file = folder.mediaDir.appendingPathComponent("reference.png")
        try FileManager.default.copyItem(at: Support.fixture("still.png"), to: file)
        let before = try Data(contentsOf: file)
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(file as CFURL, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let core = try ReelCore(scriptURL: Support.core())
        let result = try NativeLook.generate(folder: folder, core: core, body: ["reference": "media/reference.png", "size": 17], source: image)
        XCTAssertEqual(try Data(contentsOf: file), before)
        XCTAssertTrue(result.measurements.text.contains("trimmed-rgb-mean-deviation"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: try folder.resolve(result.manifest).path))
        let options = parse(try String(contentsOf: folder.resolve(result.manifest)))["options"] as? [String: Any]
        let transfer = options?["transfer"] as? [String: Any]
        let gain = try XCTUnwrap(transfer?["gain"] as? [Double])
        for value in gain { XCTAssertEqual(value, 1, accuracy: 0.05) }
        try FileManager.default.removeItem(at: folder.root.appendingPathComponent("luts"))
        try FileManager.default.createSymbolicLink(at: folder.root.appendingPathComponent("luts"), withDestinationURL: outside)
        XCTAssertThrowsError(try NativeLook.generate(folder: folder, core: core, body: ["grade": ["temperature": 0.2]], source: nil))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), [])
    }
}
