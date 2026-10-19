import Foundation
import XCTest
@testable import ReelKit

final class ColorSamplingRenderingTests: XCTestCase {
    func testCapturedQualifierRequestsRenderScopedMattesAndUndoExactly() async throws {
        let evidence = try Data(contentsOf: Support.fixture("qualifier-sampling-requests.json"))
        let rows = try XCTUnwrap(try JSONSerialization.jsonObject(with: evidence) as? [[String: Any]])
        for row in rows {
            let folder = ProjectFolder(root: try Support.tempFolder("qualifier-sampling"))
            let core = try ReelCore(scriptURL: Support.core())
            var project = parse(try core.newProject(name: "Qualifier", options: #"{"width":24,"height":24}"#))
            project.merge(try XCTUnwrap(row["project"] as? [String: Any])) { _, captured in captured }
            let migrated = try core.migrate(fileText: JSON(any: project).text)
            let projectText = try core.fileText(project: migrated)
            try projectText.write(to: folder.projectFile, atomically: true, encoding: .utf8)
            let backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _, _ in }
            try await backend.start()
            do {
                let state = parse(try await backend.handle(method: "GET", path: "/api/project", body: nil).text)
                let version = try XCTUnwrap(state["version"] as? Int)
                let before = try Data(contentsOf: folder.projectFile)
                var body = try XCTUnwrap(row["body"] as? [String: Any])
                let operations = try XCTUnwrap(body["ops"] as? [[String: Any]])
                let operation = try XCTUnwrap(operations.first)
                let scope = operation["comp"] as? String
                let otherScope: String? = scope == nil ? "nested" : nil
                let original = JSON(any: try XCTUnwrap(state["project"])).text
                let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
                let otherBefore = try await renderer.render(project: original, at: 0.5, comp: otherScope)
                body["expectedVersion"] = version
                let committed = parse(try await backend.handle(method: "POST", path: "/api/ops", body: JSON(any: body).text).text)
                XCTAssertEqual(committed["version"] as? Int, version + 1)
                let edited = JSON(any: try XCTUnwrap(committed["project"])).text
                let otherAfter = try await renderer.render(project: edited, at: 0.5, comp: otherScope)
                XCTAssertEqual(pixel(otherBefore.pixelBuffer, 12, 12), pixel(otherAfter.pixelBuffer, 12, 12))
                let fields = try XCTUnwrap(operation["set"] as? [String: Any])
                let qualifier = try XCTUnwrap(fields["qualifier"] as? [String: Any])
                if qualifier["invert"] != nil {
                    XCTAssertEqual(qualifier["invert"] as? Bool, true)
                    for inverted in [false, true] {
                    for color in ["#ff0000", "#0000ff"] {
                        var shown = qualifier
                        shown["show"] = true; shown["invert"] = inverted
                        let matteOps: [[String: Any]] = [
                            ["op": "node_update", "comp": scope as Any? ?? NSNull(), "id": "c1", "node": "n2", "set": ["qualifier": shown]],
                            ["op": "update", "comp": scope as Any? ?? NSNull(), "id": "c1", "set": ["color": color]],
                        ]
                        let matte = try await renderer.renderPreview(project: edited, operations: JSON(any: matteOps).text, at: 0.5, comp: scope)
                        let expected: UInt8 = (color == "#ff0000") != inverted ? 255 : 0
                        let actual = pixel(matte.pixelBuffer, 12, 12)
                        for channel in actual.prefix(3) { XCTAssertLessThanOrEqual(abs(Int(channel) - Int(expected)), 2) }
                        XCTAssertEqual(actual[3], 255)
                    }
                }
                }
                _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
                XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
                let undone = try await renderer.render(project: try String(contentsOf: folder.projectFile, encoding: .utf8), at: 0.5, comp: otherScope)
                XCTAssertEqual(pixel(otherBefore.pixelBuffer, 12, 12), pixel(undone.pixelBuffer, 12, 12))
                await backend.stop()
            } catch { await backend.stop(); throw error }
        }
    }

    func testCapturedStillPixelsRemainIndependentOfLaterGradeDraft() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("gallery-still")), core = try ReelCore(scriptURL: Support.core())
        let base = try core.newProject(name: "Gallery", options: #"{"width":24,"height":24}"#)
        let project = try core.applyOps(project: base, ops: ##"[{"op":"add_color","dur":2,"color":"#ff0000"},{"op":"node_add","id":"c1","node":{"type":"corrector"}}]"##).project
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let original = try await renderer.render(project: project, at: 0.5)
        let still = try original.cgImage()
        let originalData = try XCTUnwrap(still.dataProvider?.data)
        let bytes = CFDataGetLength(originalData)
        let saved = Data(bytes: CFDataGetBytePtr(originalData)!, count: bytes)
        let gray = try await renderer.renderPreview(project: project, operations: #"[{"op":"node_update","id":"c1","node":"n4","comp":null,"set":{"grade":{"saturation":0}}}]"#, at: 0.5)
        let pixelGray = pixel(gray.pixelBuffer, 12, 12)
        XCTAssertLessThanOrEqual(abs(Int(pixelGray[0]) - Int(pixelGray[1])), 2)
        XCTAssertLessThanOrEqual(abs(Int(pixelGray[1]) - Int(pixelGray[2])), 2)
        let stillData = try XCTUnwrap(still.dataProvider?.data)
        XCTAssertEqual(Data(bytes: CFDataGetBytePtr(stillData)!, count: CFDataGetLength(stillData)), saved)
        XCTAssertEqual(pixel(original.pixelBuffer, 12, 12), [255, 0, 0, 255])
    }
}
