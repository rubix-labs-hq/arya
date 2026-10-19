import CoreVideo
import CryptoKit
import Foundation
@testable import ReelKit
import XCTest

final class LUTImportTests: XCTestCase {
    private let green = "TITLE \"Green\"\nLUT_3D_SIZE 2\n" + Array(repeating: "0 1 0", count: 8).joined(separator: "\n")

    private func setup(prober: ReelBackend.MediaProber? = nil) async throws -> (URL, ReelBackend) {
        let root = try Support.tempFolder("lut-import")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("luts"), withIntermediateDirectories: true)
        try green.write(to: root.appendingPathComponent("luts/green.cube"), atomically: true, encoding: .utf8)
        let backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), probe: prober) { _, _ in }
        try await backend.start()
        _ = try await request(backend, "/api/new", ["name": "LUT import", "width": 160, "height": 90])
        _ = try await request(backend, "/api/ops", ["ops": [["op": "add_color", "track": "V1", "color": "#ff0000", "dur": 2]]])
        return (root, backend)
    }

    private func request(_ backend: ReelBackend, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        let response = try await backend.handle(method: body == nil ? "GET" : "POST", path: path, body: body.map { JSON(any: $0).text })
        return try responseFields(response, path: path)
    }

    private func responseFields(_ response: JSON, path: String) throws -> [String: Any] {
        var fields = parse(response.text)
        if path == "/api/luts/export" { fields["text"] = try ReelLUTInspection.exportText(from: response) }
        return fields
    }

    private func applyBody(_ snapshot: [String: Any], hash: String, targets: [[String: Any]], comp: String? = nil) -> [String: Any] {
        ["path": "luts/green.cube", "expectedInputHash": hash, "expectedVersion": snapshot["version"]!,
         "comp": comp as Any? ?? NSNull(), "targets": targets, "mix": 1, "space": "srgb"]
    }

    func testRendererParserInspectionAndExactTextHashes() throws {
        let result = parse(try ReelLUTInspection.inspect(text: green).text)
        XCTAssertEqual(result["size"] as? Int, 2)
        XCTAssertEqual(result["domainMin"] as? [Double], [0, 0, 0])
        XCTAssertEqual(result["domainMax"] as? [Double], [1, 1, 1])
        let expected = SHA256.hash(data: Data(green.utf8)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(result["sourceHash"] as? String, expected)
        let crlf = green.replacingOccurrences(of: "\n", with: "\r\n")
        XCTAssertNotEqual(result["sourceHash"] as? String, parse(try ReelLUTInspection.inspect(text: crlf).text)["sourceHash"] as? String)
        for text in ["LUT_3D_SIZE 2\n0 1 0", green + "\n0 1 0", green.replacingOccurrences(of: "0 1 0", with: "nan 1 0"), "LUT_1D_SIZE 2\n0 0 0\n1 1 1"] {
            XCTAssertThrowsError(try ReelLUTInspection.inspect(text: text))
        }
    }

    func testLUTTextDecodersPreserveExactBytesAndRejectInvalidInput() throws {
        let texts = [
            "\u{FEFF}", "\u{FEFF}" + green.replacingOccurrences(of: "\n", with: "\r\n"),
            "\u{FEFF}\u{FEFF}start", "prefix\u{FEFF}middle", "end\u{FEFF}",
            "\n\u{FEFF}after newline", "\"\u{FEFF}after quote", "\\\u{FEFF}after backslash",
            "e\u{301}😀\u{FEFF}\u{FFFD}",
        ]
        for text in texts {
            XCTAssertEqual(Data(try ReelLUTInspection.sourceText(from: Data(text.utf8)).utf8), Data(text.utf8))
            let response = JSON.object([("text", .string(text))])
            let escaped = JSON.raw(response.text.replacingOccurrences(of: "\u{FEFF}", with: "\\ufeff"))
            for payload in [response, escaped] {
                let decoded = try ReelLUTInspection.exportText(from: payload)
                XCTAssertEqual(Data(decoded.utf8), Data(text.utf8))
            }
        }
        for invalid in ["{}", "null", "[]", #"{"text":null}"#, #"{"text":false}"#,
                        #"{"text":1}"#, #"{"text":[]}"#, #"{"text":{}}"#, #"{"text":"unterminated}"#] {
            XCTAssertThrowsError(try ReelLUTInspection.exportText(from: .raw(invalid)))
        }
        let malformed: [[UInt8]] = [[0xff], [0x80], [0xc2], [0xc0, 0x80], [0xed, 0xa0, 0x80],
                                   [0xf4, 0x90, 0x80, 0x80], [0xef, 0xbb, 0xbf, 0xff]]
        for bytes in malformed {
            XCTAssertThrowsError(try ReelLUTInspection.sourceText(from: Data(bytes)))
        }
    }

    func testExportPreservesInspectedTextAndProjectStateIncludingBOMAndCRLF() async throws {
        let (root, backend) = try await setup()
        let before = try await request(backend, "/api/project")
        let original = JSON(any: before["project"]).text
        let file = root.appendingPathComponent("luts/green.cube")
        for text in [green, "\u{FEFF}" + green.replacingOccurrences(of: "\n", with: "\r\n")] {
            let bytes = Data(text.utf8)
            try bytes.write(to: file)
            let inspected = try await request(backend, "/api/luts/inspect", ["path": "luts/green.cube"])
            let expected = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            XCTAssertEqual(inspected.string("sourceHash"), expected)
            let response = try await backend.handle(method: "POST", path: "/api/luts/export", body: JSON(any: ["path": "luts/green.cube", "expectedInputHash": expected]).text)
            let wirePrefix = "\"text\":\"" + (text.hasPrefix("\u{FEFF}") ? "\u{FEFF}" : "") + "TITLE"
            XCTAssertNotNil(Data(response.text.utf8).range(of: Data(wirePrefix.utf8)))
            let exported = try responseFields(response, path: "/api/luts/export")
            XCTAssertEqual(exported.string("text"), text)
            XCTAssertEqual(Data(exported.string("text").utf8), bytes)
            XCTAssertEqual(exported.string("sourceHash"), expected)
            XCTAssertEqual(exported["size"] as? Int, 2)
            XCTAssertEqual(exported["domainMin"] as? [Double], [0, 0, 0])
            XCTAssertEqual(exported["domainMax"] as? [Double], [1, 1, 1])
            let after = try await request(backend, "/api/project")
            XCTAssertEqual(after["version"] as? Int, before["version"] as? Int)
            XCTAssertEqual(JSON(any: after["project"]).text, original)
            XCTAssertEqual(try Data(contentsOf: file), bytes)
        }
        await backend.stop()
    }

    func testExportRejectsChangedOrUninspectedLUTAndExportsGeneratedLook() async throws {
        let (root, backend) = try await setup()
        let before = try await request(backend, "/api/project")
        let inspected = try await request(backend, "/api/luts/inspect", ["path": "luts/green.cube"])
        for body: [String: Any] in [["path": "luts/green.cube"], ["path": "luts/green.cube", "expectedInputHash": "bad"], ["path": "luts/missing.cube", "expectedInputHash": inspected.string("sourceHash")]] {
            do { _ = try await request(backend, "/api/luts/export", body); XCTFail("Invalid LUT export accepted") } catch { }
        }
        try (green + "\n# changed\n").write(to: root.appendingPathComponent("luts/green.cube"), atomically: true, encoding: .utf8)
        do { _ = try await request(backend, "/api/luts/export", ["path": "luts/green.cube", "expectedInputHash": inspected.string("sourceHash")]); XCTFail("Changed LUT exported") } catch { }
        let generated = try await request(backend, "/api/looks/match", ["grade": ["saturation": 0], "size": 17, "name": "Monochrome", "apply": false])
        let path = generated.string("path"), info = try await request(backend, "/api/luts/inspect", ["path": generated.string("path")])
        let exported = try await request(backend, "/api/luts/export", ["path": path, "expectedInputHash": info.string("sourceHash")])
        XCTAssertEqual(Data(exported.string("text").utf8), try Data(contentsOf: root.appendingPathComponent(path)))
        let after = try await request(backend, "/api/project")
        XCTAssertEqual(after["version"] as? Int, before["version"] as? Int)
        XCTAssertEqual(JSON(any: after["project"]).text, JSON(any: before["project"]).text)
        let caps = try await request(backend, "/api/caps")
        XCTAssertEqual(caps.object("color")["lutExport"] as? Bool, true)
        XCTAssertEqual(caps.object("color")["referenceEngine"] as? String, "trimmed-rgb-mean-deviation")
        await backend.stop()
    }

    func testScopedGradeAndNodesRenderActualLUTPixelsWithOneUndo() async throws {
        let (root, backend) = try await setup()
        _ = try await request(backend, "/api/ops", ["ops": [
            ["op": "add_comp", "width": 160, "height": 90, "fps": 24],
            ["op": "add_color", "comp": "k1", "track": "V1", "color": "#ff0000", "dur": 2, "set": ["id": "c1", "grade": ["contrast": 1.2]]],
            ["op": "node_add", "comp": "k1", "id": "c1", "node": ["type": "corrector", "grade": ["exposure": 0.2]]],
            ["op": "node_add", "comp": "k1", "id": "c1", "node": ["type": "lut"]]
        ]])
        let before = try await request(backend, "/api/project")
        let original = JSON(any: before["project"]).text
        let inspection = try await request(backend, "/api/luts/inspect", ["path": "luts/green.cube"])
        let targets: [[String: Any]] = [["id": "c1", "kind": "clipGrade"], ["id": "c1", "kind": "nodeGrade", "node": "n4"], ["id": "c1", "kind": "lutNode", "node": "n5"]]
        let result = try await request(backend, "/api/luts/apply", applyBody(before, hash: inspection.string("sourceHash"), targets: targets, comp: "k1"))
        XCTAssertEqual(result["applied"] as? Bool, true)
        XCTAssertEqual(result["version"] as? Int, (before["version"] as! Int) + 1)
        let project = result["project"] as! [String: Any]
        let main = (project["tracks"] as! [[String: Any]]).flatMap { $0["clips"] as! [[String: Any]] }.first!
        XCTAssertNil(main["grade"])
        let nested = (project["comps"] as! [String: [String: Any]])["k1"]!
        let clip = (nested["tracks"] as! [[String: Any]]).flatMap { $0["clips"] as! [[String: Any]] }.first!
        let grade = clip["grade"] as! [String: Any]
        XCTAssertEqual(grade["contrast"] as? Double, 1.2)
        XCTAssertEqual(grade["lut"] as? String, "luts/green.cube")
        let nodes = (clip["nodes"] as! [String: Any])["list"] as! [[String: Any]]
        XCTAssertEqual((nodes.first { $0["id"] as? String == "n4" }!["grade"] as! [String: Any])["exposure"] as? Double, 0.2)
        XCTAssertEqual(nodes.first { $0["id"] as? String == "n5" }!["lut"] as? String, "luts/green.cube")
        let renderer = try ReelMetalRenderer(folder: ProjectFolder(root: root), coreScriptURL: Support.core())
        let frame = try await renderer.render(project: JSON(any: project).text, at: 0.5, comp: "k1", width: 160)
        CVPixelBufferLockBaseAddress(frame.pixelBuffer, .readOnly)
        let offset = 45 * CVPixelBufferGetBytesPerRow(frame.pixelBuffer) + 80 * 4
        let pixel = CVPixelBufferGetBaseAddress(frame.pixelBuffer)!.assumingMemoryBound(to: UInt8.self) + offset
        XCTAssertEqual(Array(UnsafeBufferPointer(start: pixel, count: 4)), [0, 255, 0, 255])
        CVPixelBufferUnlockBaseAddress(frame.pixelBuffer, .readOnly)
        _ = try await request(backend, "/api/undo", [:])
        let restored = try await request(backend, "/api/project")
        XCTAssertEqual(JSON(any: restored["project"]).text, original)
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("luts/green.cube"), encoding: .utf8), green)
        await backend.stop()
    }

    func testInvalidOrChangedTargetsAndInputsNeverCommit() async throws {
        let (root, backend) = try await setup()
        let before = try await request(backend, "/api/project")
        let original = JSON(any: before["project"]).text
        let inspected = try await request(backend, "/api/luts/inspect", ["path": "luts/green.cube"])
        let valid = applyBody(before, hash: inspected.string("sourceHash"), targets: [["id": "c1", "kind": "clipGrade"]])
        var invalid: [[String: Any]] = []
        for mutation: [String: Any] in [["expectedVersion": -1], ["expectedInputHash": String(repeating: "0", count: 64)], ["comp": "missing"], ["mix": 2], ["space": "unknown"], ["path": "../outside.cube"], ["targets": [["id": "missing", "kind": "clipGrade"]]], ["targets": [["id": "c1", "kind": "nodeGrade", "node": "missing"]]], ["targets": [["id": "c1", "kind": "clipGrade"], ["id": "c1", "kind": "clipGrade"]]]] {
            invalid.append(valid.merging(mutation) { _, next in next })
        }
        var omitted = valid; omitted.removeValue(forKey: "comp"); invalid.append(omitted)
        for body in invalid {
            do { _ = try await request(backend, "/api/luts/apply", body); XCTFail("Invalid LUT apply accepted") } catch { }
            let current = try await request(backend, "/api/project")
            XCTAssertEqual(current["version"] as? Int, before["version"] as? Int)
            XCTAssertEqual(JSON(any: current["project"]).text, original)
        }
        try green.replacingOccurrences(of: "0 1 0", with: "0 0 1").write(to: root.appendingPathComponent("luts/green.cube"), atomically: true, encoding: .utf8)
        do { _ = try await request(backend, "/api/luts/apply", valid); XCTFail("Changed LUT applied") } catch { }
        _ = try await request(backend, "/api/ops", ["ops": [["op": "update_track", "id": "V1", "set": ["locked": true]]]])
        let locked = try await request(backend, "/api/project")
        let latestHash = try await request(backend, "/api/luts/inspect", ["path": "luts/green.cube"]).string("sourceHash")
        do { _ = try await request(backend, "/api/luts/apply", applyBody(locked, hash: latestHash, targets: [["id": "c1", "kind": "clipGrade"]])); XCTFail("Locked target applied") } catch { }
        await backend.stop()
    }

    func testOpsRejectLUTRetargetAfterSuspendedMediaProbe() async throws {
        let gate = LUTProbeGate()
        let (root, backend) = try await setup(prober: { url in
            await gate.pause()
            return try await MediaProbe.probe(url)
        })
        try FileManager.default.createDirectory(at: root.appendingPathComponent("media"), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: Support.fixture("still.png"), to: root.appendingPathComponent("media/new.png"))
        let alternate = root.appendingPathComponent("luts/alternate.cube")
        try green.write(to: alternate, atomically: true, encoding: .utf8)
        let link = root.appendingPathComponent("luts/link.cube")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: root.appendingPathComponent("luts/green.cube"))
        let before = try await request(backend, "/api/project")
        let inspected = try await request(backend, "/api/luts/inspect", ["path": "luts/link.cube"])
        let task = Task { try await self.request(backend, "/api/ops", ["expectedVersion": before["version"]!, "expectedInputs": [["path": "luts/link.cube", "sourceHash": inspected.string("sourceHash")]],
            "ops": [["op": "add_clip", "src": "media/new.png", "track": "V2", "dur": 2], ["op": "update", "id": "c1", "set": ["grade": ["lut": "luts/link.cube"]]]]]) }
        await gate.wait()
        try FileManager.default.removeItem(at: link)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: alternate)
        await gate.resume()
        do { _ = try await task.value; XCTFail("Retargeted LUT committed") } catch { }
        let after = try await request(backend, "/api/project")
        XCTAssertEqual(after["version"] as? Int, before["version"] as? Int)
        XCTAssertEqual(JSON(any: after["project"]).text, JSON(any: before["project"]).text)
        await backend.stop()
    }
}

private actor LUTProbeGate {
    private var waiting = false
    private var entered: CheckedContinuation<Void, Never>?
    private var released: CheckedContinuation<Void, Never>?
    func pause() async {
        waiting = true; entered?.resume(); entered = nil
        await withCheckedContinuation { released = $0 }
    }
    func wait() async { if !waiting { await withCheckedContinuation { entered = $0 } } }
    func resume() { released?.resume(); released = nil }
}
