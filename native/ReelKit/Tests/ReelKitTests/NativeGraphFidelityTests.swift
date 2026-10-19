import CoreGraphics
import ImageIO
import Metal
import XCTest
@testable import ReelKit

final class NativeGraphFidelityTests: XCTestCase {
    func testResolutionAdmissionPreservesFourKAndRejectsOverBudget() throws {
        let size = try NativeRenderResolution.raster(width: 3840, height: 2160, surfaces: 3)
        XCTAssertEqual(size.width, 3840); XCTAssertEqual(size.height, 2160)
        let portrait = try NativeRenderResolution.raster(width: 2160, height: 3840)
        XCTAssertEqual(portrait.width, 2160); XCTAssertEqual(portrait.height, 3840)
        try NativeRenderResolution.admit(width: 3840, height: 2160, gpuBytesPerPixel: 32, cpuBytesPerPixel: 8, allocated: 0, recommended: 4 * 1024 * 1024 * 1024)
        XCTAssertThrowsError(try NativeRenderResolution.raster(width: .nan, height: 2160))
        XCTAssertThrowsError(try NativeRenderResolution.raster(width: 3840, height: .infinity))
        XCTAssertThrowsError(try NativeRenderResolution.raster(width: 8193, height: 2))
        XCTAssertThrowsError(try NativeRenderResolution.raster(width: 3840, height: 2160, surfaces: 9))
        XCTAssertThrowsError(try NativeRenderResolution.admit(width: 3840, height: 2160, gpuBytesPerPixel: 128, allocated: 0, recommended: 4 * 1024 * 1024 * 1024))
        XCTAssertThrowsError(try NativeRenderResolution.admit(width: 3840, height: 2160, gpuBytesPerPixel: 16, allocated: 512 * 1024 * 1024, recommended: 1024 * 1024 * 1024))
    }

    func testSoftwareVideoPlaneFormatsRemainAdmitted() async throws {
        let root = try Support.tempFolder("graph-plane-formats")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let renderer = try ReelMetalRenderer(folder: ProjectFolder(root: root), coreScriptURL: Support.core())
        let luma = try await renderer.texture(4, 4, format: .r8Unorm)
        let chroma = try await renderer.texture(2, 2, format: .rg8Unorm)
        XCTAssertEqual(luma.pixelFormat, .r8Unorm); XCTAssertEqual(chroma.pixelFormat, .rg8Unorm)
    }

    func testFourKGraphRetainsAdjacentPixelStripesAndPlaneAspect() async throws {
        let root = try Support.tempFolder("graph-four-k"), core = try ReelCore(scriptURL: Support.core())
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let image = try NativeRasterizer().image(width: 3840, height: 2160) { context in
            for x in 0..<3840 { context.setFillColor(CGColor(gray: x % 2 == 0 ? 0 : 1, alpha: 1)); context.fill(CGRect(x: x, y: 0, width: 1, height: 2160)) }
        }
        let url = root.appendingPathComponent("stripes.png")
        let writer = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(writer, image, nil); XCTAssertTrue(CGImageDestinationFinalize(writer))
        let base = try core.newProject(name: "Graph stripes", options: #"{"width":3840,"height":2160}"#)
        let ops: [[String: Any]] = [
            ["op": "import", "assets": ["stripes.png": ["assetKind": "image", "hasVideo": true, "width": 3840, "height": 2160]]],
            ["op": "append", "src": "stripes.png", "track": "V1", "dur": 2],
            ["op": "node_add", "id": "c1", "node": ["type": "corrector", "grade": ["exposure": 0]]]
        ]
        let project = try core.applyOps(project: base, ops: JSON(any: ops).text).project
        let renderer = try ReelMetalRenderer(folder: ProjectFolder(root: root), coreScriptURL: Support.core())
        let frame = try await renderer.render(project: project, at: 0.5, width: 3840)
        XCTAssertEqual(frame.width, 3840); XCTAssertEqual(frame.height, 2160)
        let records = try JSON.parse(frame.drawGeometry.text) as! [[String: Any]]
        let record = try XCTUnwrap(records.first), planes = record.object("nodePlanes")
        let node = try XCTUnwrap(planes.values.compactMap { $0 as? [String: Any] }.first { $0.string("nodeType") == "corrector" })
        XCTAssertEqual(node.number("nodePlaneWidth"), 3840); XCTAssertEqual(node.number("nodePlaneHeight"), 2160)
        let difference = (1800..<1900).reduce(0.0) { $0 + abs(Double(pixel(frame.pixelBuffer, $1, 1080)[0]) - Double(pixel(frame.pixelBuffer, $1 + 1, 1080)[0])) } / 100
        XCTAssertGreaterThan(difference, 200, "The full-resolution identity graph must retain adjacent black and white pixels")
        let reopened = try await renderer.render(project: String(data: Data(project.utf8), encoding: .utf8)!, at: 0.5, width: 3840)
        XCTAssertEqual(reopened.drawGeometry, frame.drawGeometry)
    }

    func testFourKGraphMaskKeepsLogicalBoundaryAndOpacity() async throws {
        let root = try Support.tempFolder("graph-four-k-mask"), core = try ReelCore(scriptURL: Support.core())
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let base = try core.newProject(name: "Graph mask", options: ##"{"width":3840,"height":2160,"background":"#000000"}"##)
        let ops: [[String: Any]] = [
            ["op": "add_color", "track": "V1", "dur": 2, "color": "#ff0000", "set": ["opacity": 0.5]],
            ["op": "node_add", "id": "c1", "node": ["type": "corrector", "grade": ["exposure": 0]]],
            ["op": "add_mask", "id": "c1", "mask": ["type": "rect", "w": 1920, "h": 1080, "x": 0, "y": 0]]
        ]
        let project = try core.applyOps(project: base, ops: JSON(any: ops).text).project
        let renderer = try ReelMetalRenderer(folder: ProjectFolder(root: root), coreScriptURL: Support.core())
        let frame = try await renderer.render(project: project, at: 0.5, width: 3840)
        XCTAssertEqual(Double(pixel(frame.pixelBuffer, 1920, 1080)[0]), 128, accuracy: 2)
        XCTAssertLessThan(pixel(frame.pixelBuffer, 952, 1080)[0], 2)
        XCTAssertGreaterThan(pixel(frame.pixelBuffer, 968, 1080)[0], 125)
        XCTAssertLessThan(pixel(frame.pixelBuffer, 1920, 532)[0], 2)
        XCTAssertGreaterThan(pixel(frame.pixelBuffer, 1920, 548)[0], 125)
    }
}
