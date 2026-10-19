import CoreGraphics
import CoreVideo
import Foundation
import XCTest
@testable import ReelKit

final class BezierRasterBoundsTests: XCTestCase {
    private func curve(_ control: Double = 300, negative: Bool = false) -> [String: Any] {
        let c = negative ? -control : control
        return ["type": "path", "fill": NSNull(), "path": ["closed": false, "vertices": [[-10.0, -10], [10, 10]],
                  "out": [[c + 10, 0], [0, 0]], "in": [[0.0, 0], [c - 10, 0]]],
                "stroke": ["color": "#ff0000", "width": 8.0, "cap": "round", "join": "round"]]
    }
    private func blank(_ core: ReelCore, side: Int = 640) throws -> String {
        var project = parse(try core.newProject(name: "Bezier bounds", options: JSON(any: ["width": side, "height": side]).text))
        project["background"] = "transparent"
        return JSON(any: project).text
    }
    private func rasterAlpha(_ raster: NativeRaster, local: CGPoint) throws -> UInt8 {
        let x = Int((Double(raster.image.width) / 2 + Double(local.x) * Double(raster.image.width) / raster.width).rounded(.down))
        let y = Int((Double(raster.image.height) / 2 + Double(local.y) * Double(raster.image.height) / raster.height).rounded(.down))
        guard x >= 0, x < raster.image.width, y >= 0, y < raster.image.height else { return 0 }
        let bytes = try XCTUnwrap(raster.image.dataProvider?.data) as Data
        return bytes[y * raster.image.bytesPerRow + x * 4 + 3]
    }
    private func maximumAlpha(_ frame: ReelRenderedFrame, at point: CGPoint) -> UInt8 {
        var result: UInt8 = 0
        let x = Int(point.x.rounded()), y = Int(point.y.rounded())
        for yy in max(0, y - 2)...min(CVPixelBufferGetHeight(frame.pixelBuffer) - 1, y + 2) {
            for xx in max(0, x - 2)...min(CVPixelBufferGetWidth(frame.pixelBuffer) - 1, x + 2) { result = max(result, pixel(frame.pixelBuffer, xx, yy)[3]) }
        }
        return result
    }
    private func packedPixels(_ frame: ReelRenderedFrame) -> Data {
        let buffer = frame.pixelBuffer
        CVPixelBufferLockBaseAddress(buffer, .readOnly); defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let base = CVPixelBufferGetBaseAddress(buffer)!, row = CVPixelBufferGetBytesPerRow(buffer), width = CVPixelBufferGetWidth(buffer)
        var result = Data()
        for y in 0..<CVPixelBufferGetHeight(buffer) { result.append(base.advanced(by: y * row).assumingMemoryBound(to: UInt8.self), count: width * 4) }
        return result
    }

    func testCubicExtremaAndSolidPaintExtendPastVertexBounds() throws {
        let raster = try NativeRasterizer().shape(curve(2_000), scale: 1)
        XCTAssertGreaterThan(raster.width, 3_000, "the curve extends far beyond its ten-pixel vertex bounds")
        XCTAssertLessThan(raster.width, 3_050, "cubic extrema avoid allocating the entire control-point hull")
        XCTAssertGreaterThan(try rasterAlpha(raster, local: CGPoint(x: 1_500, y: 0)), 200,
                             "the solid stroke must paint beyond the previous 1,024-pixel paint rectangle")
        let negative = try NativeRasterizer().shape(curve(2_000, negative: true), scale: 1)
        XCTAssertEqual(negative.width, raster.width, accuracy: 0.00001)
        XCTAssertGreaterThan(try rasterAlpha(negative, local: CGPoint(x: -1_500, y: 0)), 200)
    }

    func testTextureLimitRetainsLongCurveAtOriginalLayerOrigin() throws {
        XCTAssertThrowsError(try NativeRasterizer().shape(curve(20_000), scale: 1)) { error in
            XCTAssertEqual((error as? ReelRenderingError)?.message,
                           "The full raster exceeds the resolution or memory limit; reduce the source or output size")
        }
        let scale = 1.0 / 8.0
        let raster = try NativeRasterizer().shape(curve(20_000), scale: scale)
        XCTAssertEqual(Double(raster.image.width), raster.width * scale, accuracy: 0.00001)
        XCTAssertEqual(Double(raster.image.height), raster.height * scale, accuracy: 0.00001)
        XCTAssertLessThanOrEqual(raster.image.width, 4_096); XCTAssertLessThanOrEqual(raster.image.height, 4_096)
        XCTAssertGreaterThan(raster.width, 30_000)
        XCTAssertGreaterThan(try rasterAlpha(raster, local: CGPoint(x: 15_000, y: 0)), 0)
        XCTAssertThrowsError(try NativeRasterizer().shape(curve(), scale: .nan))
    }

    func testMetalDrawsOpenAndClosingCubicExtrema() async throws {
        let core = try ReelCore(scriptURL: Support.core()), base = try blank(core)
        let renderer = try ReelMetalRenderer(folder: ProjectFolder(root: Support.tempFolder("bezier-extrema")), coreScriptURL: Support.core())
        for negative in [false, true] {
            let project = try core.applyOps(project: base, ops: JSON(any: [["op": "add_shape", "dur": 3, "shape": curve(300, negative: negative)]]).text).project
            let frame = try await renderer.render(project: project, at: 1)
            XCTAssertGreaterThan(maximumAlpha(frame, at: CGPoint(x: 320 + (negative ? -225 : 225), y: 320)), 240)
            let entries = try JSON.parse(frame.drawGeometry.text) as! [[String: Any]]
            XCTAssertGreaterThan(entries[0].number("width"), 450)
            XCTAssertEqual((entries[0]["matrix"] as! [Double])[4], 320, accuracy: 0.00001)
        }
        let closing: [String: Any] = ["type": "path", "fill": NSNull(),
            "path": ["closed": true, "vertices": [[0.0, 0], [20, 0], [0, 20]],
                     "in": [[0.0, 300], [0, 0], [0, 0]], "out": [[0.0, 0], [0, 0], [0, 300]]],
            "stroke": ["color": "#ff0000", "width": 8]]
        let project = try core.applyOps(project: base, ops: JSON(any: [["op": "add_shape", "dur": 3, "shape": closing]]).text).project
        let frame = try await renderer.render(project: project, at: 1)
        XCTAssertGreaterThan(maximumAlpha(frame, at: CGPoint(x: 320, y: 555)), 240, "the closing segment's tangents contribute to raster bounds")
    }

    func testMiterJoinsAndDiagonalSquareCapsDoNotClip() async throws {
        let core = try ReelCore(scriptURL: Support.core()), base = try blank(core)
        let renderer = try ReelMetalRenderer(folder: ProjectFolder(root: Support.tempFolder("bezier-stroke-extents")), coreScriptURL: Support.core())
        let cases: [([String: Any], CGPoint)] = [
            (["type": "path", "fill": NSNull(), "path": ["closed": false, "vertices": [[-12.0, 100], [0, 0], [12, 100]]],
              "stroke": ["color": "#ff0000", "width": 40, "join": "miter", "cap": "butt"]], CGPoint(x: 320, y: 180)),
            (["type": "path", "fill": NSNull(), "path": ["closed": false, "vertices": [[-50.0, -50], [50, 50]]],
              "stroke": ["color": "#ff0000", "width": 40, "join": "round", "cap": "square"]], CGPoint(x: 395, y: 370))
        ]
        // The miter ratio is sqrt(100 * 100 + 12 * 12) / 12, below the limit of ten.
        XCTAssertGreaterThan(try NativeRasterizer().shape(cases[0].0, scale: 1).height, 330)
        for (shape, point) in cases {
            let project = try core.applyOps(project: base, ops: JSON(any: [["op": "add_shape", "dur": 3, "shape": shape]]).text).project
            let frame = try await renderer.render(project: project, at: 1)
            XCTAssertGreaterThan(maximumAlpha(frame, at: point), 240, "stroke bounds include the configured cap and join at \(point)")
        }
    }

    func testExpandedBoundsKeepDefaultGradientCoordinates() async throws {
        let core = try ReelCore(scriptURL: Support.core()), base = try blank(core)
        let shape: [String: Any] = ["type": "path", "stroke": ["width": 0],
            "path": ["closed": true, "vertices": [[-20.0, -20], [20, -20], [20, 20], [-20, 20]],
                     "out": [[0.0, -240], [0, 0], [0, 0], [0, 0]], "in": [[0.0, 0], [0, -240], [0, 0], [0, 0]]],
            "fill": ["gradient": ["type": "linear", "angle": 90, "stops": [[0, "#ff0000"], [1, "#0000ff"]]]]]
        let project = try core.applyOps(project: base, ops: JSON(any: [["op": "add_shape", "dur": 3, "shape": shape]]).text).project
        let frame = try await ReelMetalRenderer(folder: ProjectFolder(root: Support.tempFolder("bezier-gradient")), coreScriptURL: Support.core()).render(project: project, at: 1)
        let far = pixel(frame.pixelBuffer, 320, 220), center = pixel(frame.pixelBuffer, 320, 320)
        XCTAssertGreaterThan(far[3], 250); XCTAssertGreaterThan(far[0], 250); XCTAssertLessThan(far[2], 5)
        XCTAssertGreaterThan(center[3], 250); XCTAssertEqual(Double(center[0]), 128, accuracy: 8); XCTAssertEqual(Double(center[2]), 128, accuracy: 8)
        let primitive = try NativeRasterizer().shape(["type": "rect", "width": 20, "height": 10, "fill": ["color": "#ff0000"]], scale: 1)
        XCTAssertEqual(primitive.width, 24); XCTAssertEqual(primitive.height, 14)
    }

    func testParentShearMirroredScaleAndAnchorCompensationPreservePathPixels() async throws {
        let core = try ReelCore(scriptURL: Support.core()), base = try blank(core)
        var shape = curve(200); shape["stroke"] = ["color": "#ff0000", "width": 18]
        let operations: [[String: Any]] = [
            ["op": "add_shape", "track": "V1", "dur": 3, "shape": shape,
             "set": ["x": 320, "y": 320, "rotation": -17, "scale": -0.6, "scaleX": 1.1, "scaleY": 0.7, "anchorX": 5, "anchorY": -7]],
            ["op": "add_null", "track": "V2", "dur": 3, "set": ["x": 320, "y": 320]],
            ["op": "parent", "id": "c1", "parent": "c2"],
            ["op": "update", "id": "c2", "set": ["rotation": 28, "scaleX": 1.5, "scaleY": 0.6]]]
        let project = try core.applyOps(project: base, ops: JSON(any: operations).text).project
        let renderer = try ReelMetalRenderer(folder: ProjectFolder(root: Support.tempFolder("bezier-parent-origin")), coreScriptURL: Support.core())
        let first = try await renderer.render(project: project, at: 1)
        let entries = try JSON.parse(first.drawGeometry.text) as! [[String: Any]], record = entries[0]
        let pose = record.object("pose"), matrix = record["matrix"] as! [Double]
        let point = CGPoint(x: matrix[0] * 150 + matrix[4], y: matrix[1] * 150 + matrix[5])
        XCTAssertGreaterThan(maximumAlpha(first, at: point), 220, "the transformed long-tangent stroke survives rasterization")
        let dx = 24.0, dy = -19.0, r = pose.number("rotation") * Double.pi / 180
        let sx = pose.number("scale") * pose.number("scaleX", 1), sy = pose.number("scale") * pose.number("scaleY", 1)
        let update: [[String: Any]] = [["op": "update", "id": "c1", "set": [
            "anchorX": pose.number("anchorX") + dx, "anchorY": pose.number("anchorY") + dy,
            "x": pose.number("x") + cos(r) * sx * dx - sin(r) * sy * dy,
            "y": pose.number("y") + sin(r) * sx * dx + cos(r) * sy * dy]]]
        let moved = try core.applyOps(project: project, ops: JSON(any: update).text).project
        let second = try await renderer.render(project: moved, at: 1)
        XCTAssertTrue(packedPixels(first) == packedPixels(second), "anchor compensation preserves every transformed rendered pixel")
        XCTAssertEqual(record.number("width"), (try JSON.parse(second.drawGeometry.text) as! [[String: Any]])[0].number("width"))
    }
}
