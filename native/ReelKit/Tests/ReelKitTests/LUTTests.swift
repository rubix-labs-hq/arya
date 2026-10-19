import CoreVideo
import XCTest
@testable import ReelKit

final class LUTTests: XCTestCase {
    func testCubeDomainMapsInputWithoutChangingTableOutputs() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("lut-domain"))
        let rows = (0..<8).map { i in "\(i & 1) \((i >> 1) & 1) \((i >> 2) & 1)" }.joined(separator: "\n")
        try "LUT_3D_SIZE 2\nDOMAIN_MIN 0.25 0.25 0.25\nDOMAIN_MAX 0.75 0.75 0.75\n\(rows)\n".write(to: folder.output("domain.cube"), atomically: true, encoding: .utf8)
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let project = try lutProject(color: "#606060", path: "domain.cube")
        let samples = try await renderer.render(project: project, at: 0).scopeSamples(maximumSide: 1)
        for channel in samples.rgba.prefix(3) { XCTAssertEqual(channel, Float((96.0 / 255 - 0.25) / 0.5), accuracy: 1.0 / 255) }
    }

    func testCubePreservesHalfPrecisionAndExtendedOutputRange() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("lut-precision"))
        let rows = Array(repeating: "0.12345 1.2345 -0.25", count: 8).joined(separator: "\n")
        try "LUT_3D_SIZE 2\n\(rows)\n".write(to: folder.output("precision.cube"), atomically: true, encoding: .utf8)
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let core = try ReelCore(scriptURL: Support.core())
        let project = try core.applyOps(project: lutProject(color: "#ffffff", path: "precision.cube"), ops: #"[{"op":"update","id":"c1","set":{"grade":{"lutSpace":"working"}}}]"#).project
        let samples = try await renderer.renderHDR(project: project, at: 0).scopeSamples(maximumSide: 1)
        XCTAssertEqual(samples.rgba[0], 0.12345, accuracy: 0.0001)
        XCTAssertEqual(samples.rgba[1], 1.2345, accuracy: 0.001)
        XCTAssertEqual(samples.rgba[2], 0, accuracy: 0.001)
        XCTAssertEqual(try NativeCube(text: "LUT_3D_SIZE 2\n\(rows)\n").values[2], -0.25)
    }

    private func lutProject(color: String, path: String) throws -> String {
        let core = try ReelCore(scriptURL: Support.core())
        return try core.applyOps(project: core.newProject(name: "LUT pixels", options: #"{"width":160,"height":90}"#), ops: JSON(any: [["op": "add_color", "track": "V1", "color": color, "dur": 1, "set": ["grade": ["lut": path]]]]).text).project
    }

    func testSDRCubeColorsAreConvertedIntoHDRWorkingPrimaries() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("lut-hdr-space"))
        let rows = Array(repeating: "1 0 0", count: 8).joined(separator: "\n")
        try "LUT_3D_SIZE 2\n\(rows)\n".write(to: folder.output("red.cube"), atomically: true, encoding: .utf8)
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let samples = try await renderer.renderHDR(project: lutProject(color: "#ffffff", path: "red.cube"), at: 0).scopeSamples(maximumSide: 1)
        for (actual, expected) in zip(samples.rgba.prefix(3), NativeHDR.linear([1, 0, 0, 1]).prefix(3)) { XCTAssertEqual(actual, expected, accuracy: 0.0005) }
    }
}
