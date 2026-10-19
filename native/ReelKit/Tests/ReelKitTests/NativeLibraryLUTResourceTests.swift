import CryptoKit
import Foundation
@testable import ReelKit
import XCTest

final class NativeLibraryLUTResourceTests: XCTestCase {
    private let cube = "TITLE \"Library green\"\r\nLUT_3D_SIZE 2\r\n" + Array(repeating: "0 1 0", count: 8).joined(separator: "\r\n") + "\r\n"
    private var roots: [URL] = []
    private var backends: [ReelBackend] = []

    override func tearDown() async throws {
        for backend in backends { await backend.stop() }
        for root in roots { try FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
    }

    func testLUTSaveApplyHistoryAndReloadPreserveEditableGradeAndResource() async throws {
        let (root, backend, path) = try await fixture()
        let original = try await snapshot(backend)
        let source = try clip(object(original["project"]), "c1")
        let saved = try await edit(backend, [saveOperation()])
        let savedProject = object(saved["project"])
        let item = try libraryItem(savedProject)
        let itemID = try XCTUnwrap(item["id"] as? String)
        let resource = object(object(object(item["body"])["resources"])[path])
        XCTAssertEqual(resource["type"] as? String, "lut")
        XCTAssertEqual(resource["size"] as? Int, 2)
        XCTAssertEqual(resource["sourceHash"] as? String, hash(Data(cube.utf8)))
        XCTAssertTrue(object(savedProject["assets"]).isEmpty)
        let targetBefore = try clip(savedProject, "c2")
        let applied = try await edit(backend, [["op": "library_apply", "item": itemID, "id": "c2"]])
        let appliedProject = object(applied["project"])
        let node = try assertApplied(appliedProject, path: path, targetBefore: targetBefore)
        XCTAssertEqual(try clip(appliedProject, "c1") as NSDictionary, source as NSDictionary)
        XCTAssertEqual(try libraryItem(appliedProject) as NSDictionary, item as NSDictionary)
        XCTAssertEqual(try disk(root), appliedProject as NSDictionary)

        var editedGrade = object(node["grade"])
        editedGrade["exposure"] = 1.25
        _ = try await edit(backend, [["op": "node_update", "id": "c2", "node": try XCTUnwrap(node["id"] as? String), "set": ["grade": editedGrade]]])
        let edited = object(try await snapshot(backend)["project"])
        let editedNode = try corrector(try clip(edited, "c2"))
        XCTAssertEqual(object(editedNode["grade"])["exposure"] as? Double, 1.25)
        XCTAssertEqual(object(object(object(try libraryItem(edited)["body"])["settings"])["grade"])["exposure"] as? Double, 0.25)
        XCTAssertEqual(try clip(edited, "c1") as NSDictionary, source as NSDictionary)
        let undoEdit = try await call(backend, "POST", "/api/undo", [:])
        XCTAssertEqual(object(undoEdit["project"]) as NSDictionary, appliedProject as NSDictionary)
        let undoApply = try await call(backend, "POST", "/api/undo", [:])
        XCTAssertEqual(object(undoApply["project"]) as NSDictionary, savedProject as NSDictionary)
        let undoSave = try await call(backend, "POST", "/api/undo", [:])
        XCTAssertEqual(object(undoSave["project"]) as NSDictionary, object(original["project"]) as NSDictionary)
        _ = try await call(backend, "POST", "/api/redo", [:])
        let redoApply = try await call(backend, "POST", "/api/redo", [:])
        XCTAssertEqual(object(redoApply["project"]) as NSDictionary, appliedProject as NSDictionary)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(path)), Data(cube.utf8))
        await backend.stop()
        let reopened = try makeBackend(root)
        try await reopened.start()
        let reloaded = object(try await snapshot(reopened)["project"])
        XCTAssertEqual(reloaded as NSDictionary, appliedProject as NSDictionary)
        _ = try assertApplied(reloaded, path: path, targetBefore: targetBefore)
        XCTAssertEqual(try disk(root), reloaded as NSDictionary)
    }

    func testExactLUTExportImportAndDeclarativeRebindPreserveReusableEditableLook() async throws {
        let (sourceRoot, sourceBackend, sourcePath) = try await fixture()
        let saved = try await edit(sourceBackend, [saveOperation()])
        var item = try libraryItem(object(saved["project"]))
        let beforeExport = try await snapshot(sourceBackend)
        let bytes = try Data(contentsOf: sourceRoot.appendingPathComponent(sourcePath))
        let exported = try await sourceBackend.handle(method: "POST", path: "/api/luts/export", body: JSON(any: ["path": sourcePath, "expectedInputHash": hash(bytes)]).text)
        let text = try ReelLUTInspection.exportText(from: exported)
        XCTAssertEqual(Data(text.utf8), bytes)
        XCTAssertEqual(parse(exported.text)["sourceHash"] as? String, hash(bytes))
        let afterExport = try await snapshot(sourceBackend)
        XCTAssertEqual(afterExport as NSDictionary, beforeExport as NSDictionary)
        XCTAssertEqual(try disk(sourceRoot), object(beforeExport["project"]) as NSDictionary)

        let (targetRoot, targetBackend, importedPath) = try await fixture(name: "relocated.cube", text: text)
        XCTAssertNotEqual(importedPath, sourcePath)
        XCTAssertFalse(FileManager.default.fileExists(atPath: targetRoot.appendingPathComponent(sourcePath).path))
        XCTAssertEqual(try Data(contentsOf: targetRoot.appendingPathComponent(importedPath)), bytes)
        item.removeValue(forKey: "id")
        var body = object(item["body"])
        var settings = object(body["settings"])
        var grade = object(settings["grade"])
        grade["lut"] = importedPath
        settings["grade"] = grade
        body["settings"] = settings
        let resource = try XCTUnwrap(object(body["resources"])[sourcePath])
        body["resources"] = [importedPath: resource]
        item["body"] = body
        let registered = try await edit(targetBackend, [["op": "library_register", "item": item]])
        let registeredProject = object(registered["project"])
        let registeredItem = try libraryItem(registeredProject)
        XCTAssertEqual(object(registeredItem["body"]) as NSDictionary, body as NSDictionary)
        XCTAssertTrue(object(registeredProject["assets"]).isEmpty)
        let targetBefore = try clip(registeredProject, "c2")
        let applied = try await edit(targetBackend, [["op": "library_apply", "item": try XCTUnwrap(registeredItem["id"] as? String), "id": "c2"]])
        let finalProject = object(applied["project"])
        _ = try assertApplied(finalProject, path: importedPath, targetBefore: targetBefore)
        XCTAssertEqual(try libraryItem(finalProject) as NSDictionary, registeredItem as NSDictionary)
        XCTAssertEqual(try disk(targetRoot), finalProject as NSDictionary)
        let unchangedSource = try await snapshot(sourceBackend)
        XCTAssertEqual(unchangedSource as NSDictionary, beforeExport as NSDictionary)
        XCTAssertEqual(try Data(contentsOf: sourceRoot.appendingPathComponent(sourcePath)), bytes)
    }

    func testMissingChangedInvalidAndMismatchedLUTResourcesRejectWholeBatchWithoutHistory() async throws {
        let (root, backend, path) = try await fixture()
        let beforeSave = try await snapshot(backend)
        let saved = try await edit(backend, [saveOperation()])
        let item = try libraryItem(object(saved["project"]))
        let itemID = try XCTUnwrap(item["id"] as? String)
        let resources = object(object(item["body"])["resources"])
        let file = root.appendingPathComponent(path)
        let original = Data(cube.utf8)
        let alternate = Data(cube.replacingOccurrences(of: "0 1 0", with: "1 0 0").utf8)
        XCTAssertNotEqual(hash(alternate), hash(original))
        let outside = root.deletingLastPathComponent().appendingPathComponent("outside.cube")
        try original.write(to: outside)
        for kind in ["missing", "changed valid CUBE", "malformed CUBE", "invalid UTF-8", "symlink"] {
            try FileManager.default.removeItem(at: file)
            switch kind {
            case "changed valid CUBE": try alternate.write(to: file)
            case "malformed CUBE": try Data("LUT_3D_SIZE 2\n0 1 0".utf8).write(to: file)
            case "invalid UTF-8": try Data([0xff, 0x80]).write(to: file)
            case "symlink": try FileManager.default.createSymbolicLink(at: file, withDestinationURL: outside)
            default: break
            }
            var registering = item
            registering.removeValue(forKey: "id")
            var saving = saveOperation()
            if kind == "changed valid CUBE" { saving["resources"] = resources }
            for operation in [saving, ["op": "library_register", "item": registering], ["op": "library_apply", "item": itemID, "id": "c2"]] {
                try await assertRejectedBatch(backend, root: root, operation: operation, label: kind)
            }
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
            try original.write(to: file)
        }
        for badReceipt in [
            ["type": "lut", "size": 2, "sourceHash": String(repeating: "0", count: 64)] as [String: Any],
            ["type": "lut", "size": 3, "sourceHash": hash(original)] as [String: Any],
        ] {
            var saving = saveOperation()
            saving["resources"] = [path: badReceipt]
            var registering = item
            registering.removeValue(forKey: "id")
            var body = object(registering["body"])
            body["resources"] = [path: badReceipt]
            registering["body"] = body
            for operation in [saving, ["op": "library_register", "item": registering]] {
                try await assertRejectedBatch(backend, root: root, operation: operation, label: "mismatched resource receipt")
            }
        }
        let undo = try await call(backend, "POST", "/api/undo", [:])
        XCTAssertEqual(object(undo["project"]) as NSDictionary, object(beforeSave["project"]) as NSDictionary)
        XCTAssertEqual(try disk(root), object(beforeSave["project"]) as NSDictionary)
        let redo = try await call(backend, "POST", "/api/redo", [:])
        XCTAssertEqual(object(redo["project"]) as NSDictionary, object(saved["project"]) as NSDictionary)
        XCTAssertEqual(try Data(contentsOf: file), original)
    }

    private func fixture(name: String = "green.cube", text: String? = nil) async throws -> (URL, ReelBackend, String) {
        let root = try Support.tempFolder("library-lut")
        roots.append(root)
        let backend = try makeBackend(root)
        try await backend.start()
        _ = try await call(backend, "POST", "/api/new", ["name": "Library LUT", "width": 160, "height": 90, "fps": 30])
        let imported = try await call(backend, "POST", "/api/luts/import", ["name": name, "text": text ?? cube])
        let path = try XCTUnwrap(imported["path"] as? String)
        XCTAssertEqual(imported["sourceHash"] as? String, hash(Data((text ?? cube).utf8)))
        _ = try await edit(backend, [
            ["op": "add_color", "track": "V1", "color": "#ff0000", "start": 0, "dur": 2],
            ["op": "update", "id": "c1", "set": ["grade": ["lut": path, "lutMix": 0.6, "exposure": 0.25]]],
            ["op": "add_color", "track": "V1", "color": "#0000ff", "start": 6, "dur": 4],
        ])
        return (root, backend, path)
    }

    private func makeBackend(_ root: URL) throws -> ReelBackend {
        let backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), probe: { _ in
            throw ReelBackend.APIError("A CUBE must not be probed as Media.")
        }, events: { _, _ in })
        backends.append(backend)
        return backend
    }

    private func saveOperation() -> [String: Any] {
        ["op": "library_save", "category": "effect", "name": "Reusable green look", "source": ["clip": "c1"]]
    }

    private func call(_ backend: ReelBackend, _ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        parse(try await backend.handle(method: method, path: path, body: body.map { JSON(any: $0).text }).text)
    }

    private func snapshot(_ backend: ReelBackend) async throws -> [String: Any] {
        try await call(backend, "GET", "/api/project")
    }

    private func edit(_ backend: ReelBackend, _ ops: [[String: Any]]) async throws -> [String: Any] {
        try await call(backend, "POST", "/api/ops", ["ops": ops, "expectedVersion": await backend.currentVersion()])
    }

    private func assertRejectedBatch(_ backend: ReelBackend, root: URL, operation: [String: Any], label: String) async throws {
        let before = try await snapshot(backend)
        let diskBefore = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        do {
            _ = try await edit(backend, [["op": "project", "set": ["name": "Must not commit"]], operation])
            XCTFail("Accepted \(label) in a library batch")
        } catch {
            XCTAssertFalse(error.localizedDescription.isEmpty)
        }
        let after = try await snapshot(backend)
        XCTAssertEqual(after as NSDictionary, before as NSDictionary, label)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), diskBefore, label)
    }

    private func libraryItem(_ project: [String: Any]) throws -> [String: Any] {
        try XCTUnwrap((object(project["library"])["items"] as? [[String: Any]])?.first)
    }

    private func clip(_ project: [String: Any], _ id: String) throws -> [String: Any] {
        try XCTUnwrap((project["tracks"] as? [[String: Any]])?.flatMap { $0["clips"] as? [[String: Any]] ?? [] }.first { $0["id"] as? String == id })
    }

    private func corrector(_ clip: [String: Any]) throws -> [String: Any] {
        try XCTUnwrap((object(clip["nodes"])["list"] as? [[String: Any]])?.first { $0["type"] as? String == "corrector" })
    }

    @discardableResult
    private func assertApplied(_ project: [String: Any], path: String, targetBefore: [String: Any]) throws -> [String: Any] {
        let target = try clip(project, "c2")
        for key in ["start", "dur", "color"] {
            XCTAssertEqual(JSON(any: target[key]).text, JSON(any: targetBefore[key]).text, key)
        }
        let node = try corrector(target)
        let grade = object(node["grade"])
        XCTAssertEqual(grade["lut"] as? String, path)
        XCTAssertEqual(grade["lutMix"] as? Double, 0.6)
        XCTAssertEqual(grade["exposure"] as? Double, 0.25)
        XCTAssertTrue(object(project["assets"]).isEmpty)
        return node
    }

    private func disk(_ root: URL) throws -> NSDictionary {
        parse(try String(contentsOf: root.appendingPathComponent("reel.project.json"), encoding: .utf8)) as NSDictionary
    }

    private func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
