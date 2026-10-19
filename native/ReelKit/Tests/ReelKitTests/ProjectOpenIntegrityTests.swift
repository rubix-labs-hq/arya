import Foundation
import XCTest
@testable import ReelKit

final class ProjectOpenIntegrityTests: XCTestCase {
    private func backend(_ root: URL, events: EventLog = EventLog()) throws -> ReelBackend {
        try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core()) { name, text in events.add(name, text) }
    }

    private func rejects(_ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Operation must reject unsafe project state", file: file, line: line) }
        catch { XCTAssertTrue(error.localizedDescription.contains("project"), error.localizedDescription, file: file, line: line) }
    }

    private func rejectsMutations(_ backend: ReelBackend, root: URL) async {
        for (route, body) in [("/api/new", "{}"), ("/api/import", "{\"paths\":[]}"), ("/api/ops", "{\"ops\":[]}"), ("/api/undo", "{}"), ("/api/redo", "{}"), ("/api/forget", "{\"paths\":[]}")] {
            await rejects { _ = try await backend.handle(method: "POST", path: route, body: body) }
        }
        await rejects { _ = try await backend.importMedia([]) }
        await rejects { _ = try await backend.editOperations(ops: []) }
        let source = root.appendingPathComponent("incoming.png")
        try? Data([1, 2, 3]).write(to: source)
        await rejects { _ = try await backend.copyIn([source]) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("media").path))
    }

    func testMalformedExistingFileRejectsOpenAndAllCreationMutationPaths() async throws {
        let root = try Support.tempFolder("malformed-project")
        defer { try? FileManager.default.removeItem(at: root) }
        let file = ProjectFolder(root: root).projectFile, bytes = Data("{broken json".utf8), events = EventLog()
        try bytes.write(to: file)
        let backend = try backend(root, events: events)
        await rejects { try await backend.start() }
        await rejectsMutations(backend, root: root)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        let project = await backend.currentProject(), version = await backend.currentVersion()
        XCTAssertNil(project); XCTAssertEqual(version, 0)
        XCTAssertFalse(events.names().contains("project"))
        await backend.stop()
    }

    func testUnreadableUTF8AndNonObjectJSONAreNotEmptyFolders() async throws {
        for bytes in [Data([0xff, 0xfe, 0xfd]), Data("[]".utf8), Data("null".utf8)] {
            let root = try Support.tempFolder("unreadable-project")
            defer { try? FileManager.default.removeItem(at: root) }
            let file = ProjectFolder(root: root).projectFile
            try bytes.write(to: file)
            let backend = try backend(root)
            await rejects { try await backend.start() }
            await rejects { _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}") }
            XCTAssertEqual(try Data(contentsOf: file), bytes)
            await backend.stop()
        }
    }

    func testUnsupportedAndInvalidFormatVersionsPreserveBytes() async throws {
        for value: Any in [999, 0, -1, true, "3", 1.5] {
            let root = try Support.tempFolder("unsupported-project")
            defer { try? FileManager.default.removeItem(at: root) }
            let file = ProjectFolder(root: root).projectFile
            let bytes = try JSONSerialization.data(withJSONObject: ["version": value, "name": "Keep", "tracks": []])
            try bytes.write(to: file)
            let backend = try backend(root)
            await rejects { try await backend.start() }
            await rejects { _ = try await backend.importMedia([]) }
            XCTAssertEqual(try Data(contentsOf: file), bytes)
            await backend.stop()
        }
    }

    func testDirectoryAndDanglingProjectLinksRejectInsteadOfInitializing() async throws {
        for makeDirectory in [true, false] {
            let root = try Support.tempFolder("not-regular-project")
            defer { try? FileManager.default.removeItem(at: root) }
            let file = ProjectFolder(root: root).projectFile
            if makeDirectory { try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false) }
            else { try FileManager.default.createSymbolicLink(atPath: file.path, withDestinationPath: "missing-project.json") }
            let backend = try backend(root)
            await rejects { try await backend.start() }
            await rejects { _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}") }
            if makeDirectory { XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: file.path), []) }
            else { XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: file.path), "missing-project.json") }
            await backend.stop()
        }
    }

    func testFreshFolderCanCreateImportAndReopenValidProject() async throws {
        let root = try Support.tempFolder("fresh-project")
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try backend(root)
        try await first.start()
        let absent = await first.currentProject(); XCTAssertNil(absent)
        let version = await first.currentVersion()
        let empty = parse(try await first.importMedia([]).text)
        XCTAssertTrue(object(empty["assets"]).isEmpty)
        let stillAbsent = await first.currentProject(); XCTAssertNil(stillAbsent)
        let unchangedVersion = await first.currentVersion(); XCTAssertEqual(unchangedVersion, version)
        XCTAssertFalse(FileManager.default.fileExists(atPath: ProjectFolder(root: root).projectFile.path))
        let source = root.appendingPathComponent("still.png")
        let original = try Data(contentsOf: Support.fixture("still.png"))
        try original.write(to: source)
        let imported = parse(try await first.importMedia(["still.png"]).text)
        XCTAssertEqual(Set(object(imported["assets"]).keys), ["still.png"])
        XCTAssertEqual(try Data(contentsOf: source), original)
        let created = await first.currentProject(); XCTAssertNotNil(created)
        _ = try await first.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Chosen\"}")
        _ = try await first.handle(method: "POST", path: "/api/undo", body: "{}")
        _ = try await first.handle(method: "POST", path: "/api/redo", body: "{}")
        await first.stop()
        let bytes = try Data(contentsOf: ProjectFolder(root: root).projectFile)
        let reopened = try backend(root)
        try await reopened.start()
        let project = await reopened.currentProject()
        XCTAssertEqual(parse(try XCTUnwrap(project))["name"] as? String, "Chosen")
        XCTAssertEqual(try Data(contentsOf: ProjectFolder(root: root).projectFile), bytes)
        await reopened.stop()
    }

    func testExternalCorruptionRetainsLastGoodProjectAndBlocksMutationsBeforeWatcher() async throws {
        let root = try Support.tempFolder("external-corruption")
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = try backend(root), file = ProjectFolder(root: root).projectFile
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let before = await backend.currentProject(), version = await backend.currentVersion()
        let bad = Data("{externally corrupted".utf8)
        try bad.write(to: file, options: .atomic)
        await rejectsMutations(backend, root: root)
        await rejects { try await backend.refreshProjectFile() }
        _ = try await backend.handle(method: "POST", path: "/api/jobs/cancel", body: "{}")
        _ = try await backend.handle(method: "POST", path: "/api/analysis/jobs/cancel", body: "{}")
        _ = try await backend.handle(method: "POST", path: "/api/ui-state", body: "{\"playhead\":2}")
        let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(afterVersion, version)
        XCTAssertEqual(try Data(contentsOf: file), bad)
        await backend.stop()
    }

    func testMissingPreviouslyLoadedFileBlocksRecreationAndExplicitRestoreRecovers() async throws {
        let root = try Support.tempFolder("deleted-project")
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = try backend(root), file = ProjectFolder(root: root).projectFile
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Restore\"}")
        let bytes = try Data(contentsOf: file), before = await backend.currentProject()
        try FileManager.default.removeItem(at: file)
        await rejects { try await backend.refreshProjectFile() }
        await rejects { _ = try await backend.importMedia([]) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        let retained = await backend.currentProject(); XCTAssertEqual(retained, before)
        try bytes.write(to: file)
        try await backend.refreshProjectFile()
        XCTAssertEqual(try Data(contentsOf: file), bytes)
        _ = try await backend.handle(method: "POST", path: "/api/ops", body: "{\"ops\":[]}")
        XCTAssertEqual(parse(try String(contentsOf: file, encoding: .utf8))["name"] as? String, "Restore")
        await backend.stop()
    }

    func testValidExternalChangeRequiresRefreshAndPreservesUndoRedo() async throws {
        let root = try Support.tempFolder("external-valid-change")
        defer { try? FileManager.default.removeItem(at: root) }
        let backend = try backend(root), file = ProjectFolder(root: root).projectFile
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Before\"}")
        var fields = parse(try String(contentsOf: file, encoding: .utf8)); fields["name"] = "External"
        let external = try JSONSerialization.data(withJSONObject: fields)
        try external.write(to: file)
        await rejects { _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}") }
        XCTAssertEqual(try Data(contentsOf: file), external)
        try await backend.refreshProjectFile()
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let undone = await backend.currentProject(); XCTAssertEqual(parse(try XCTUnwrap(undone))["name"] as? String, "Before")
        _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}")
        let redone = await backend.currentProject(); XCTAssertEqual(parse(try XCTUnwrap(redone))["name"] as? String, "External")
        fields["name"] = "Café"
        let composed = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        try composed.write(to: file)
        try await backend.refreshProjectFile()
        fields["name"] = "Cafe\u{301}"
        let decomposed = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        XCTAssertNotEqual(composed, decomposed)
        XCTAssertEqual(String(data: composed, encoding: .utf8), String(data: decomposed, encoding: .utf8), "Swift String equality alone is not a byte identity check")
        try decomposed.write(to: file)
        await rejects { _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}") }
        XCTAssertEqual(try Data(contentsOf: file), decomposed)
        await backend.stop()
    }

    func testProbeTimeCorruptionBlocksFinalCommit() async throws {
        let root = try Support.tempFolder("probe-time-corruption")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root), bad = Data("{corrupt while probing".utf8)
        try Data([1]).write(to: root.appendingPathComponent("source.png"))
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), probe: { _ in
            try bad.write(to: folder.projectFile, options: .atomic)
            return .object([("kind", "image"), ("width", 2), ("height", 2)])
        }, events: { _, _ in })
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}")
        let before = await backend.currentProject(), version = await backend.currentVersion()
        await rejects { _ = try await backend.importMedia(["source.png"]) }
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), bad)
        let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(afterVersion, version)
        await backend.stop()
    }
    func testFailedOpenCanBeRetriedAfterRepairAndLegacyFilesStillMigrate() async throws {
        for legacyVersion in [1, 2] {
            let root = try Support.tempFolder("repaired-project")
            defer { try? FileManager.default.removeItem(at: root) }
            let file = ProjectFolder(root: root).projectFile, backend = try backend(root)
            try Data("{broken".utf8).write(to: file)
            await rejects { try await backend.start() }
            let repaired = try JSONSerialization.data(withJSONObject: ["version": legacyVersion, "name": "Legacy", "width": 640, "height": 360, "fps": 24, "tracks": []])
            try repaired.write(to: file)
            try await backend.start()
            let loaded = await backend.currentProject()
            XCTAssertEqual(parse(try XCTUnwrap(loaded))["name"] as? String, "Legacy")
            XCTAssertEqual(try Data(contentsOf: file), repaired)
            _ = try await backend.handle(method: "POST", path: "/api/ops", body: "{\"ops\":[]}")
            await backend.stop()
        }
    }

    func testWatcherRetriesRepairWithUnchangedMetadataAfterFailure() async throws {
        let root = try Support.tempFolder("watcher-retry")
        defer { try? FileManager.default.removeItem(at: root) }
        let events = EventLog(), backend = try backend(root, events: events), file = ProjectFolder(root: root).projectFile
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Before\"}")
        var fields = parse(try String(contentsOf: file, encoding: .utf8)); fields["name"] = "Recovered"
        let repaired = try JSONSerialization.data(withJSONObject: fields), bad = Data(repeating: UInt8(ascii: "x"), count: repaired.count)
        try bad.write(to: file)
        let date = try XCTUnwrap(try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date)
        await rejects { try await backend.refreshProjectFile() }
        try repaired.write(to: file)
        try FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: file.path)
        var recovered = false
        for _ in 0..<30 {
            let project = await backend.currentProject()
            if project.map({ parse($0)["name"] as? String == "Recovered" }) == true { recovered = true; break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(recovered, "The real watcher must retry even when repair preserves the failed file's size and modification date")
        XCTAssertEqual(events.last("project")?["who"] as? String, "disk")
        XCTAssertEqual(try Data(contentsOf: file), repaired)
        await backend.stop()
    }

    func testZeroByteExistingFileRejectsColdOpenAndAllMutations() async throws {
        let root = try Support.tempFolder("zero-byte-existing")
        defer { try? FileManager.default.removeItem(at: root) }
        let file = ProjectFolder(root: root).projectFile, backend = try backend(root)
        try Data().write(to: file)
        await rejects { try await backend.start() }
        await rejectsMutations(backend, root: root)
        XCTAssertEqual(try Data(contentsOf: file), Data())
        let project = await backend.currentProject(), version = await backend.currentVersion()
        XCTAssertNil(project); XCTAssertEqual(version, 0)
        await backend.stop()
    }

    func testZeroByteFileAppearingAfterFreshLoadCannotBeOverwrittenByCreation() async throws {
        let root = try Support.tempFolder("zero-byte-appeared")
        defer { try? FileManager.default.removeItem(at: root) }
        let file = ProjectFolder(root: root).projectFile, backend = try backend(root)
        try await backend.start()
        let initial = await backend.currentProject(); XCTAssertNil(initial)
        try Data().write(to: file)
        await rejectsMutations(backend, root: root)
        await rejects { try await backend.refreshProjectFile() }
        XCTAssertEqual(try Data(contentsOf: file), Data())
        let project = await backend.currentProject(), version = await backend.currentVersion()
        XCTAssertNil(project); XCTAssertEqual(version, 0)
        await backend.stop()
    }

}
