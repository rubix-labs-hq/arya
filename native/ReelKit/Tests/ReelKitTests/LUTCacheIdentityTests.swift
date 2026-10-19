import CryptoKit
import Foundation
import XCTest
@testable import ReelKit

final class LUTCacheIdentityTests: XCTestCase {
    private func cube(_ value: Int, size: Int = 2) -> String {
        "LUT_3D_SIZE \(size)\n" + Array(repeating: "\(value) \(value) \(value)", count: size * size * size).joined(separator: "\n") + "\n"
    }

    func testSourceIdentityPreservesBOMAndCRLFAndRejectsInvalidUTF8() throws {
        let lf = cube(0), crlf = lf.replacingOccurrences(of: "\n", with: "\r\n")
        let variants = [lf, "\u{FEFF}" + lf, crlf, "\u{FEFF}" + crlf, "# \u{FFFD} cafe\u{301} 🐈\n" + lf]
        var hashes = Set<String>()
        for retained in variants {
            let bytes = Data(retained.utf8), exact = try NativeLUTSource(data: Data(retained.utf8))
            XCTAssertEqual(exact.text, retained)
            XCTAssertEqual(Data(exact.text.utf8), bytes)
            XCTAssertEqual(exact.byteCount, bytes.count)
            let expected = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            XCTAssertEqual(exact.sourceHash, expected)
            let inspected = try JSON.parse(ReelLUTInspection.inspect(text: exact.text).text) as! [String: Any]
            XCTAssertEqual(exact.sourceHash, inspected["sourceHash"] as? String)
            XCTAssertEqual(inspected["size"] as? Int, 2)
            hashes.insert(exact.sourceHash)
        }
        XCTAssertEqual(hashes.count, variants.count)
        let invalid: [[UInt8]] = [[0xff], [0x80], [0xc2], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xef, 0xbb, 0xbf, 0xff]]
        for bytes in invalid {
            XCTAssertThrowsError(try NativeLUTSource(data: Data(bytes))) { error in
                XCTAssertEqual(error.localizedDescription, "CUBE file must contain UTF-8 text")
            }
        }
    }

    func testSamePathSameLengthSameMTimeReplacementUsesFreshContent() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("lut-cache-replacement"))
        let url = try folder.output("look.cube")
        try Data(cube(0).utf8).write(to: url)
        let modified = try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate]!
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let first = try await renderer.lutTexture("look.cube")
        let same = try await renderer.lutTexture("look.cube")
        XCTAssertTrue(first.texture === same.texture)
        try Data(cube(1).utf8).write(to: url)
        try FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: url.path)
        let replaced = try await renderer.lutTexture("look.cube")
        XCTAssertNotEqual(replaced.sourceHash, first.sourceHash)
        XCTAssertFalse(replaced.texture === first.texture)
        let current = try await renderer.lutTexture("look.cube")
        XCTAssertTrue(replaced.texture === current.texture)
    }

    func testMissingAndMalformedReplacementsDoNotUseCachedTexture() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("lut-cache-invalid")), url = try folder.output("look.cube")
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        for malformed in [false, true] {
            try Data(cube(0).utf8).write(to: url)
            _ = try await renderer.lutTexture("look.cube")
            if malformed { try Data("LUT_3D_SIZE 2\n0 0 0".utf8).write(to: url) }
            else { try FileManager.default.removeItem(at: url) }
            do { _ = try await renderer.lutTexture("look.cube"); XCTFail("A replacement must not reuse the previous texture") } catch {}
            let retained = await renderer.lutCache["look.cube"]
            XCTAssertNil(retained)
        }
    }

    func testTaskScopedSnapshotRefusesMutationAndCacheRelease() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("lut-cache-snapshot")), url = try folder.output("look.cube")
        try Data(cube(0).utf8).write(to: url)
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let snapshot = try await renderer.captureLUTSnapshot(paths: ["look.cube"])
        try Data(cube(1).utf8).write(to: url)
        do {
            _ = try await NativeLUTContext.$snapshot.withValue(snapshot) { try await renderer.lutTexture("look.cube") }
            XCTFail("The captured transform must not change within a render or export")
        } catch {}
        do { try await renderer.validateLUTSnapshot(snapshot); XCTFail("Publication must refuse a replaced source") } catch {}
        try Data(cube(0).utf8).write(to: url)
        let fresh = try await renderer.captureLUTSnapshot(paths: ["look.cube"])
        await renderer.releaseCaches()
        do { try await renderer.validateLUTSnapshot(fresh); XCTFail("Released render ownership must be invalid") } catch {}
    }

    func testLRUCacheAndBlankIdentityHaveSeparateBounds() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("lut-cache-budget"))
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let blank = try await renderer.lutTexture("")
        for i in 0..<9 {
            let path = "look-\(i).cube"
            try Data(cube(i, size: 64).utf8).write(to: folder.output(path))
            _ = try await renderer.lutTexture(path)
            let bytes = await renderer.lutCacheBytes
            XCTAssertLessThanOrEqual(bytes, 16 * 1024 * 1024)
        }
        let keys = await Set(renderer.lutCache.keys)
        XCTAssertEqual(keys.count, 8)
        XCTAssertFalse(keys.contains("look-0.cube"))
        let identity = try await renderer.lutTexture("")
        XCTAssertTrue(blank.texture === identity.texture)
        await renderer.releaseCaches()
        let bytes = await renderer.lutCacheBytes, retained = await renderer.identityLUT
        XCTAssertEqual(bytes, 0); XCTAssertNil(retained)
    }

    func testFramePlanDependenciesExcludeDormantInputsAndDisabledNodes() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("lut-cache-dependencies"))
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let core = try ReelCore(scriptURL: Support.core())
        let project = try core.applyOps(project: core.newProject(name: "LUT dependencies", options: #"{"width":160,"height":90}"#), ops: ##"[{"op":"add_color","track":"V1","color":"#ffffff","dur":1,"set":{"grade":{"lut":"active.cube"}}},{"op":"add_color","track":"V1","color":"#ffffff","start":5,"dur":1,"set":{"grade":{"lut":"future-missing.cube"}}}]"##).project
        let plan = try JSON.parse(core.framePlan(project: project, at: 0)) as! [String: Any]
        let paths = await renderer.lutPaths(plan)
        XCTAssertEqual(paths, ["active.cube"])
        let graph: [String: Any] = ["layers": [["clip": ["kind": "color", "grade": ["lut": "unused-primary"], "nodes": ["list": [["id":"s","type":"source"],["id":"off","type":"lut","enabled":false,"grade":["lut":"disabled-missing"]],["id":"lut","type":"lut","grade":["lut":"active-node"]]],"links":[["from":"s","to":"off"],["from":"off","to":"lut"]]]]]]]
        let nodePaths = await renderer.lutPaths(graph)
        XCTAssertEqual(nodePaths, ["active-node"])
    }

    func testSourceKeyAndInputlessNativeGradePassesAreCaptured() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("lut-cache-all-native-passes"))
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let graph: [String: Any] = ["layers": [["clip": ["kind": "color", "nodes": ["list": [
            ["id": "s", "type": "source", "enabled": false, "grade": ["lut": "source.cube"]],
            ["id": "key", "type": "key", "grade": ["lut": "key.cube"]],
            ["id": "empty", "type": "lut", "grade": ["lut": "inputless.cube"]],
            ["id": "disabled", "type": "corrector", "enabled": false, "grade": ["lut": "disabled-missing.cube"]]
        ], "links": []]]]]]
        let paths = await renderer.lutPaths(graph)
        XCTAssertEqual(paths, ["source.cube", "key.cube", "inputless.cube"])
    }

    func testSourceAndKeyLUTGradesRenderWithoutSnapshotAdmissionFailure() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("lut-cache-source-key-pixels"))
        try Data(cube(1).utf8).write(to: folder.output("source.cube"))
        try Data(cube(0).utf8).write(to: folder.output("key.cube"))
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let core = try ReelCore(scriptURL: Support.core())
        let project = try core.applyOps(project: core.newProject(name: "Source and key LUTs", options: #"{"width":160,"height":90}"#), ops: ##"[{"op":"add_color","track":"V1","color":"#ffffff","dur":1},{"op":"node_add","id":"c1","node":{"type":"key"}},{"op":"node_update","id":"c1","node":"n1","set":{"enabled":false,"grade":{"lut":"source.cube"}}},{"op":"node_update","id":"c1","node":"n4","set":{"grade":{"lut":"key.cube"}}}]"##).project
        let samples = try await renderer.render(project: project, at: 0).scopeSamples(maximumSide: 1)
        for component in samples.rgba.prefix(3) { XCTAssertEqual(component, 0, accuracy: 1.0 / 255) }
    }

}
