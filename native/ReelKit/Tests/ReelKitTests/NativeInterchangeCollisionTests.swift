import Foundation
import XCTest
@testable import ReelKit

final class NativeInterchangeCollisionTests: XCTestCase {
    private func fixture(_ action: (URL, ReelBackend) async throws -> Void) async throws {
        let root = try Support.tempFolder("interchange-collision")
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), processingAdmission: .init(), events: { _, _ in })
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: JSON(any: ["name": "Owned interchange", "width": 64, "height": 64, "fps": 1]).text)
        do { try await action(root, backend); await backend.stop() }
        catch { await backend.stop(); throw error }
    }

    func testExistingNamedAndExplicitInterchangeFilesArePreserved() async throws {
        try await fixture { root, backend in
            let renders = root.appendingPathComponent("renders")
            try FileManager.default.createDirectory(at: renders, withIntermediateDirectories: false)
            let requests: [[String: Any]] = [["format": "otio", "name": "Keep"], ["format": "otio", "out": "renders/explicit.otio"]]
            for body in requests {
                let file = renders.appendingPathComponent(body["out"] == nil ? "Keep.otio" : "explicit.otio")
                let original = Data("owned original interchange".utf8)
                try original.write(to: file)
                do { _ = try await backend.handle(method: "POST", path: "/api/interchange/export", body: JSON(any: body).text); XCTFail("An existing interchange file was replaced") } catch {}
                XCTAssertEqual(try Data(contentsOf: file), original)
            }
        }
    }

    func testNewExplicitInterchangeOutputKeepsProjectAndHistoryBytes() async throws {
        try await fixture { root, backend in
            let project = root.appendingPathComponent("reel.project.json"), before = try Data(contentsOf: project)
            let version = await backend.currentVersion()
            let reply = try await backend.handle(method: "POST", path: "/api/interchange/export", body: #"{"format":"otio","out":"renders/nested/owned.otio"}"#)
            XCTAssertEqual(parse(reply.text)["path"] as? String, "renders/nested/owned.otio")
            XCTAssertEqual(try Data(contentsOf: project), before)
            let after = await backend.currentVersion(); XCTAssertEqual(after, version)
            XCTAssertGreaterThan(try Data(contentsOf: root.appendingPathComponent("renders/nested/owned.otio")).count, 0)
        }
    }

    func testMissingReferencedInterchangeOutputIsNeverFilled() async throws {
        try await fixture { root, backend in
            _ = try await backend.editOperations(ops: JSON(any: [["op": "import", "assets": ["renders/missing.otio": ["assetKind": "image", "width": 64, "height": 64]]]]))
            do { _ = try await backend.handle(method: "POST", path: "/api/interchange/export", body: #"{"format":"otio","out":"renders/missing.otio"}"#); XCTFail("A missing referenced source was filled") } catch {}
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("renders/missing.otio").path))
        }
    }

    func testMissingRecursiveLUTNodeAndAngleSourcesAreNeverFilled() async throws {
        try await fixture { root, backend in
            let references: [(String, [String: Any])] = [
                ("lut", ["grade": ["lut": "renders/missing-lut.otio"]]),
                ("node", ["nodes": ["list": [["id": "n1", "type": "source", "src": "renders/missing-node.otio"]], "links": []]]),
                ("angle", ["angles": [["src": "renders/missing-angle.otio"]]])
            ]
            for (kind, set) in references {
                _ = try await backend.editOperations(ops: JSON(any: [["op": "add_color", "track": "V1", "color": "#202020", "dur": 1, "set": set]]))
                let path = "renders/missing-\(kind).otio"
                let project = try String(contentsOf: root.appendingPathComponent("reel.project.json"), encoding: .utf8)
                XCTAssertTrue(try NativeExportSources.references(project).contains(path))
                XCTAssertNil((parse(project)["assets"] as? [String: Any])?[path])
                do { _ = try await backend.handle(method: "POST", path: "/api/interchange/export", body: JSON(any: ["format": "otio", "out": path]).text); XCTFail("A missing recursive \(kind) source was filled") } catch {}
                XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(path).path))
            }
        }
    }
}
