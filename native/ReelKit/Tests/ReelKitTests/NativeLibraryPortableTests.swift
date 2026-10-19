import XCTest
import CryptoKit
@testable import ReelKit

final class NativeLibraryPortableTests: XCTestCase {
    private let cube = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n"
    private func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func parse(_ text: String) throws -> [String: Any] { try XCTUnwrap(JSON.parse(text) as? [String: Any]) }
    private func request(_ backend: ReelBackend, _ path: String, _ body: [String: Any] = [:]) async throws -> [String: Any] {
        try parse(try await backend.handle(method: path == "/api/project" ? "GET" : "POST", path: path, body: JSON(any: body).text).text)
    }

    func testExportImportEditableLookWithRealFilesHistoryAndFreshBackend() async throws {
        let sourceFolder = ProjectFolder(root: try Support.tempFolder("portable-source"))
        let destinationFolder = ProjectFolder(root: try Support.tempFolder("portable-destination"))
        let source = try ReelBackend(folder: sourceFolder, coreScript: Support.core(), events: { _, _ in })
        let destination = try ReelBackend(folder: destinationFolder, coreScript: Support.core(), events: { _, _ in })
        try await source.start(); try await destination.start()
        _ = try await request(source, "/api/new", ["name": "Original"])
        let imported = try await request(source, "/api/luts/import", ["name": "Original.cube", "text": cube])
        let path = try XCTUnwrap(imported["path"] as? String)
        _ = try await request(source, "/api/ops", ["ops": [["op": "add_color", "dur": 2], ["op": "update", "id": "c1", "set": ["grade": ["lut": path, "lutMix": 0.65]]], ["op": "library_save", "category": "effect", "name": "Reusable look", "source": ["clip": "c1"]]]])
        let sourceState = try await request(source, "/api/project")
        let exported = try await request(source, "/api/library/export", ["item": "lib1", "expectedVersion": sourceState["version"]!])
        // A real JSON file carries the item and exact resource bytes between copied projects.
        let packageFile = sourceFolder.root.appendingPathComponent("Look.arya-component")
        try Data(JSON(any: exported).text.utf8).write(to: packageFile)
        let reopenedPackage = try parse(String(contentsOf: packageFile, encoding: .utf8))
        var item = try XCTUnwrap(reopenedPackage["item"] as? [String: Any]); item.removeValue(forKey: "id")
        _ = try await request(destination, "/api/new", ["name": "Destination"])
        _ = try await request(destination, "/api/ops", ["ops": [["op": "add_color", "dur": 2]]])
        let before = try await request(destination, "/api/project")
        let result = try await request(destination, "/api/library/import", ["item": item, "resources": reopenedPackage["resources"]!, "expectedVersion": before["version"]!])
        let paths = try XCTUnwrap(result["resourcePaths"] as? [String: String]); let destinationPath = try XCTUnwrap(paths[path])
        XCTAssertEqual(try Data(contentsOf: destinationFolder.resolve(destinationPath)), Data(cube.utf8))
        let saved = try await request(destination, "/api/project")
        _ = try await request(destination, "/api/undo")
        let undone = try await request(destination, "/api/project")
        XCTAssertEqual(JSON(any: undone["project"]).text, JSON(any: before["project"]).text)
        XCTAssertEqual(try Data(contentsOf: destinationFolder.resolve(destinationPath)), Data(cube.utf8))
        _ = try await request(destination, "/api/redo")
        let redone = try await request(destination, "/api/project")
        XCTAssertEqual(JSON(any: redone["project"]).text, JSON(any: saved["project"]).text)
        _ = try await request(destination, "/api/ops", ["ops": [["op": "library_apply", "item": "lib1", "id": "c1"]]])
        let applied = try await request(destination, "/api/project")
        XCTAssertTrue(JSON(any: applied["project"]).text.contains(destinationPath))
        XCTAssertTrue(JSON(any: applied["project"]).text.contains("lutMix"))
        await source.stop(); await destination.stop()
        let fresh = try ReelBackend(folder: destinationFolder, coreScript: Support.core(), events: { _, _ in })
        try await fresh.start()
        let reopened = try await request(fresh, "/api/project")
        XCTAssertEqual(JSON(any: reopened["project"]).text, JSON(any: applied["project"]).text)
        XCTAssertEqual(try Data(contentsOf: sourceFolder.resolve(path)), Data(cube.utf8))
        await fresh.stop()
    }

    func testResourceAdmissionRefusesConflictsLinksAndLateReplacement() throws {
        let folder = ProjectFolder(root: try Support.tempFolder("portable-file-guards"))
        let root = try NativeMediaImportSource.Root(folder), data = Data(cube.utf8), digest = hash(data)
        let admitted = try NativeLibraryResources.admit(root: root, hash: digest, data: data)
        try admitted.validate()
        let duplicate = try NativeLibraryResources.admit(root: root, hash: digest, data: data)
        try duplicate.validate()
        let file = try folder.resolve(admitted.path)
        try Data("corrupt".utf8).write(to: file)
        XCTAssertThrowsError(try admitted.validate())
        XCTAssertThrowsError(try NativeLibraryResources.admit(root: root, hash: digest, data: data))
        XCTAssertEqual(try Data(contentsOf: file), Data("corrupt".utf8))
        try FileManager.default.removeItem(at: file)
        let external = folder.root.appendingPathComponent("original.cube"); try data.write(to: external)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: external)
        XCTAssertThrowsError(try NativeLibraryResources.admit(root: root, hash: digest, data: data))
        XCTAssertEqual(try Data(contentsOf: external), data)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.linkItem(at: external, to: file)
        XCTAssertThrowsError(try NativeLibraryResources.admit(root: root, hash: digest, data: data))
        XCTAssertEqual(try Data(contentsOf: external), data)
        XCTAssertEqual(try Data(contentsOf: file), data)
    }

    func testResourceDirectoryEscapeAndInvalidDigestRefused() throws {
        let folder = ProjectFolder(root: try Support.tempFolder("portable-directory-guard"))
        let outside = try Support.tempFolder("portable-untouched-originals")
        try FileManager.default.createSymbolicLink(at: folder.root.appendingPathComponent("luts"), withDestinationURL: outside)
        let root = try NativeMediaImportSource.Root(folder), data = Data(cube.utf8)
        XCTAssertThrowsError(try NativeLibraryResources.admit(root: root, hash: hash(data), data: data))
        XCTAssertThrowsError(try NativeLibraryResources.admit(root: root, hash: String(repeating: "0", count: 64), data: data))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty)
    }

    func testLUTMutationAtFinalPersistenceAdmissionDoesNotCommit() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("portable-final-admission"))
        let digest = hash(Data(cube.utf8)), path = "luts/Original.cube"
        let file = folder.root.appendingPathComponent("luts/Component-\(digest).cube")
        let mutation = PortableAdmissionMutation(file: file)
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), writeAdmission: { try mutation.check() }, events: { _, _ in })
        try await backend.start()
        _ = try await request(backend, "/api/new", ["name": "Destination"])
        let before = try await request(backend, "/api/project")
        let originalBytes = try Data(contentsOf: folder.projectFile)
        let receipt: [String: Any] = ["type": "lut", "size": 2, "sourceHash": digest]
        let item: [String: Any] = ["category": "effect", "name": "Look", "body": ["assets": [String: Any](), "resources": [path: receipt], "settings": ["grade": ["lut": path]]]]
        var resource = receipt; resource["text"] = cube
        mutation.arm()
        do { _ = try await request(backend, "/api/library/import", ["item": item, "resources": [path: resource], "expectedVersion": before["version"]!]); XCTFail("A LUT changed at final publication was committed") }
        catch {}
        XCTAssertEqual(mutation.observedCalls, 3)
        XCTAssertEqual(try Data(contentsOf: file), Data("changed at final admission".utf8))
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), originalBytes)
        let current = try await request(backend, "/api/project")
        XCTAssertEqual(JSON(any: current["project"]).text, JSON(any: before["project"]).text)
        XCTAssertEqual(current["version"] as? Int, before["version"] as? Int)
        await backend.stop()
    }

    func testMalformedHostPackagesAndDestinationConflictDoNotCommit() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("portable-package-refusals"))
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), events: { _, _ in })
        try await backend.start()
        _ = try await request(backend, "/api/new", ["name": "Destination"])
        let before = try await request(backend, "/api/project"), digest = hash(Data(cube.utf8)), path = "luts/Original.cube"
        let receipt: [String: Any] = ["type": "lut", "size": 2, "sourceHash": digest]
        let item: [String: Any] = ["category": "effect", "name": "Look", "body": ["assets": [String: Any](), "resources": [path: receipt], "settings": ["grade": ["lut": path]]]]
        var resource = receipt; resource["text"] = cube
        var corrupt = resource; corrupt["text"] = cube + "# changed\n"
        var escapedItem = item
        escapedItem["body"] = ["assets": [String: Any](), "resources": ["../outside.cube": receipt], "settings": ["grade": ["lut": "../outside.cube"]]]
        let cases: [[String: Any]] = [
            ["item": item, "resources": [String: Any](), "expectedVersion": before["version"]!],
            ["item": item, "resources": [path: corrupt], "expectedVersion": before["version"]!],
            ["item": escapedItem, "resources": ["../outside.cube": resource], "expectedVersion": before["version"]!],
            ["item": item, "resources": [path: resource], "expectedVersion": -1],
        ]
        for body in cases {
            do { _ = try await request(backend, "/api/library/import", body); XCTFail("Malformed or stale component imported") }
            catch {}
            let current = try await request(backend, "/api/project")
            XCTAssertEqual(JSON(any: current["project"]).text, JSON(any: before["project"]).text)
            XCTAssertEqual(current["version"] as? Int, before["version"] as? Int)
        }
        let directory = folder.root.appendingPathComponent("luts")
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let conflict = directory.appendingPathComponent("Component-\(digest).cube"); try Data("conflict".utf8).write(to: conflict)
        do { _ = try await request(backend, "/api/library/import", ["item": item, "resources": [path: resource], "expectedVersion": before["version"]!]); XCTFail("Conflicting destination overwritten") }
        catch {}
        let current = try await request(backend, "/api/project")
        XCTAssertEqual(JSON(any: current["project"]).text, JSON(any: before["project"]).text)
        XCTAssertEqual(try Data(contentsOf: conflict), Data("conflict".utf8))
        await backend.stop()
    }
}

// The writable gate first sees the copied LUT at commit entry. Its next two
// calls run inside coordinated persistence, with the third at publication.
private final class PortableAdmissionMutation: @unchecked Sendable {
    private let file: URL, lock = NSLock()
    private var armed = false, calls = 0
    init(file: URL) { self.file = file }
    func arm() { lock.lock(); defer { lock.unlock() }; armed = true; calls = 0 }
    var observedCalls: Int { lock.lock(); defer { lock.unlock() }; return calls }
    func check() throws {
        lock.lock(); defer { lock.unlock() }
        guard armed, FileManager.default.fileExists(atPath: file.path) else { return }
        calls += 1
        if calls == 3 { try Data("changed at final admission".utf8).write(to: file) }
    }
}
