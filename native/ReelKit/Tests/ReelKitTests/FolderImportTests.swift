import Foundation
import XCTest
@testable import ReelKit

final class FolderImportTests: XCTestCase {
    private func backend(_ root: URL, probe: ReelBackend.MediaProber? = nil) throws -> ReelBackend {
        try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), probe: probe) { _, _ in }
    }
    private func image(_ root: URL, _ path: String) throws -> URL {
        let file = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: Support.fixture("still.png"), to: file)
        return file
    }
    func testSystemTemporaryFolderAliasesHaveIdenticalExactRelativePathsAndBytes() throws {
        // This case requires the real system alias, independent of the verifier's TMPDIR.
        let systemTemporary = URL(fileURLWithPath: "/var/tmp", isDirectory: true)
        guard let alias = try? FileManager.default.destinationOfSymbolicLink(atPath: "/var"),
              ["private/var", "/private/var"].contains(alias) else {
            throw XCTSkip("This platform does not expose the /var temporary-directory alias")
        }
        let ownedSourceRoot = systemTemporary.appendingPathComponent("reelkit-alias-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: ownedSourceRoot, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: ownedSourceRoot) }
        let source = ownedSourceRoot.appendingPathComponent("Organized", isDirectory: true)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: false)
        let project = try Support.tempFolder("alias-project")
        defer { try? FileManager.default.removeItem(at: project) }
        let original = try image(source, "Camera A/100% shared.png")
        let path = source.path
        let alternate: URL
        if path.hasPrefix("/private/var/") { alternate = URL(fileURLWithPath: String(path.dropFirst("/private".count)), isDirectory: true) }
        else if path.hasPrefix("/var/") { alternate = URL(fileURLWithPath: "/private" + path, isDirectory: true) }
        else { throw XCTSkip("This platform does not expose the /var temporary-directory alias") }
        XCTAssertTrue(FileManager.default.fileExists(atPath: alternate.path))
        for selected in [source, alternate] {
            let selection = try NativeMediaFolderSelection.collect(selected, project: ProjectFolder(root: project))
            XCTAssertEqual(selection.items.map(\.relativePath), ["Camera A/100% shared.png"])
            XCTAssertTrue(selection.issues.isEmpty)
            let item = try XCTUnwrap(selection.items.first)
            try NativeMediaFolderSelection.validate(item, root: selection.root)
            XCTAssertEqual(try Data(contentsOf: item.url), try Data(contentsOf: original))
        }
    }
    func testComponentConfinementRejectsSiblingPrefixAndForgedRelativePath() throws {
        let project = try Support.tempFolder("component-project"), source = try Support.tempFolder("Sequence % №1")
        defer { for folder in [project, source] { try? FileManager.default.removeItem(at: folder) } }
        let original = try image(source, "Camera A/Scene 🎬.png")
        let selection = try NativeMediaFolderSelection.collect(source, project: ProjectFolder(root: project))
        XCTAssertEqual(selection.items.map(\.relativePath), ["Camera A/Scene 🎬.png"])
        let sibling = source.deletingLastPathComponent().appendingPathComponent(source.lastPathComponent + "-other").appendingPathComponent("photo.png")
        XCTAssertThrowsError(try NativeMediaFolderSelection.relativePath(sibling, root: source))
        XCTAssertThrowsError(try NativeMediaFolderSelection.relativePath(source, root: source))
        let forged = NativeMediaFolderSelection.Item(url: original, relativePath: "../photo.png",
                                                    identity: try NativeMediaImportSource.selectedStamp(original),
                                                    rootIdentity: try NativeMediaImportSource.directoryIdentity(source))
        XCTAssertThrowsError(try NativeMediaFolderSelection.validate(forged, root: selection.root))
    }
    func testRejectedLinksDoNotSkipUnrelatedDirectoryDescendants() throws {
        let project = try Support.tempFolder("link-enumeration-project"), source = try Support.tempFolder("Batch"), outside = try Support.tempFolder("Outside")
        defer { for folder in [project, source, outside] { try? FileManager.default.removeItem(at: folder) } }
        _ = try image(source, "take/good.png"); _ = try image(source, "take/deeper/other.png")
        let secret = try image(outside, "secret.png")
        try FileManager.default.createSymbolicLink(at: source.appendingPathComponent("escape.png"), withDestinationURL: secret)
        try FileManager.default.createSymbolicLink(at: source.appendingPathComponent("outside"), withDestinationURL: outside)
        let selection = try NativeMediaFolderSelection.collect(source, project: ProjectFolder(root: project))
        XCTAssertEqual(selection.items.map(\.relativePath), ["take/deeper/other.png", "take/good.png"])
        XCTAssertEqual(Set(selection.issues.map(\.path)), ["escape.png", "outside"])
        XCTAssertTrue(selection.items.allSatisfy { !$0.url.path.contains("Outside/") })
        for item in selection.items { try NativeMediaFolderSelection.validate(item, root: selection.root) }
    }
    func testNestedFolderKeepsCollidingNamesOriginalBytesAndOneUndoRedoBatch() async throws {
        let root = try Support.tempFolder("nested-project"), source = try Support.tempFolder("Organized")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: source) }
        let a = try image(source, "Camera A/shared.png"), b = try image(source, "Camera B/shared.png")
        let original = try Data(contentsOf: a)
        let backend = try backend(root); try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let receipt = parse(try await backend.copyIn([source]).text)
        let paths: Set<String> = ["media/Organized/Camera A/shared.png", "media/Organized/Camera B/shared.png"]
        XCTAssertEqual(Set(object(receipt["assets"]).keys), paths)
        XCTAssertEqual((receipt["failures"] as? [Any])?.count, 0)
        for path in paths { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(path)), original) }
        XCTAssertEqual(try Data(contentsOf: a), original); XCTAssertEqual(try Data(contentsOf: b), original)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        var project = await backend.currentProject(); XCTAssertTrue(object(parse(try XCTUnwrap(project))["assets"]).isEmpty)
        _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}")
        project = await backend.currentProject(); XCTAssertEqual(Set(object(parse(try XCTUnwrap(project))["assets"]).keys), paths)
        await backend.stop()
        let reopened = try self.backend(root); try await reopened.start()
        project = await reopened.currentProject(); XCTAssertEqual(Set(object(parse(try XCTUnwrap(project))["assets"]).keys), paths)
        await reopened.stop()
    }
    func testInvalidNestedMovieAndLinksDoNotDiscardValidMedia() async throws {
        let root = try Support.tempFolder("partial-folder"), source = try Support.tempFolder("Batch"), outside = try Support.tempFolder("outside-links")
        defer { for folder in [root, source, outside] { try? FileManager.default.removeItem(at: folder) } }
        _ = try image(source, "take/good.png"); let original = try image(outside, "secret.png")
        try Data("Not a movie".utf8).write(to: source.appendingPathComponent("take/bad.mp4"))
        try FileManager.default.createSymbolicLink(at: source.appendingPathComponent("escape.png"), withDestinationURL: original)
        try FileManager.default.createSymbolicLink(at: source.appendingPathComponent("outside"), withDestinationURL: outside)
        let backend = try backend(root); try await backend.start()
        let receipt = parse(try await backend.copyIn([source]).text)
        XCTAssertEqual(Set(object(receipt["assets"]).keys), ["media/Batch/take/good.png"])
        let failures = try XCTUnwrap(receipt["failures"] as? [[String: Any]])
        XCTAssertEqual(failures.count, 3)
        XCTAssertEqual(failures.filter { $0["stage"] as? String == "probe" }.first?["name"] as? String, "bad.mp4")
        XCTAssertEqual(failures.filter { $0["stage"] as? String == "read" }.count, 2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("media/Batch/escape.png").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("media/Batch/outside").path))
        XCTAssertEqual(try Data(contentsOf: original), try Data(contentsOf: Support.fixture("still.png")))
        await backend.stop()
    }
    func testRepeatedFolderNamesAreUniqueAndInProjectFolderIsReferencedWithoutCopy() async throws {
        let root = try Support.tempFolder("folders-project"), a = try Support.tempFolder("Same"), b = try Support.tempFolder("Same")
        defer { for folder in [root,a,b] { try? FileManager.default.removeItem(at: folder) } }
        _ = try image(a, "nested/image.png"); _ = try image(b, "nested/image.png")
        _ = try image(root, "owned/sub/image.png")
        let backend = try backend(root); try await backend.start()
        let receipt = parse(try await backend.copyIn([a,b,root.appendingPathComponent("owned")]).text)
        XCTAssertEqual(Set(object(receipt["assets"]).keys), ["media/Same/nested/image.png", "media/Same-1/nested/image.png", "owned/sub/image.png"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("media/owned").path))
        await backend.stop()
    }
    func testEmptyAndUnsupportedFolderDoesNotInitializeFreshProject() async throws {
        let root = try Support.tempFolder("fresh-folder"), source = try Support.tempFolder("No-media")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: source) }
        try Data("keep".utf8).write(to: source.appendingPathComponent("notes.txt"))
        let backend = try backend(root); try await backend.start()
        let version = await backend.currentVersion()
        let receipt = parse(try await backend.copyIn([source]).text)
        XCTAssertTrue(object(receipt["assets"]).isEmpty); XCTAssertEqual((receipt["failures"] as? [Any])?.count, 0)
        let current = await backend.currentProject(); XCTAssertNil(current)
        let after = await backend.currentVersion(); XCTAssertEqual(after, version)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("reel.project.json").path))
        await backend.stop()
    }
    func testProjectAncestorAndSelectedRootLinkAreRejectedWithoutCopying() async throws {
        let parent = try Support.tempFolder("Ancestor"), source = try Support.tempFolder("source")
        let root = parent.appendingPathComponent("Project")
        defer { try? FileManager.default.removeItem(at: parent); try? FileManager.default.removeItem(at: source) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        _ = try image(source, "image.png")
        let link = parent.appendingPathComponent("linked"); try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source)
        let backend = try backend(root); try await backend.start()
        let receipt = parse(try await backend.copyIn([parent,link]).text)
        XCTAssertTrue(object(receipt["assets"]).isEmpty); XCTAssertEqual((receipt["failures"] as? [Any])?.count, 2)
        let current = await backend.currentProject(); XCTAssertNil(current)
        await backend.stop()
    }
    func testRecursiveInProjectRouteUsesNestedAssetsAndReportsLink() async throws {
        let root = try Support.tempFolder("api-folder")
        defer { try? FileManager.default.removeItem(at: root) }
        let source = try image(root, "owned/deep/image.png")
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("owned/link.png"), withDestinationURL: source)
        let backend = try backend(root); try await backend.start()
        let receipt = parse(try await backend.importMedia(["owned"]).text)
        XCTAssertEqual(Set(object(receipt["assets"]).keys), ["owned/deep/image.png"])
        XCTAssertEqual((receipt["failures"] as? [Any])?.count, 1)
        await backend.stop()
    }
    func testCancelledProbeDoesNotPublishFolderImportOrClaimPartialSuccess() async throws {
        let root = try Support.tempFolder("cancel-folder"), source = try Support.tempFolder("Cancelled")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: source) }
        _ = try image(source, "nested/image.png")
        let backend = try backend(root, probe: { _ in throw CancellationError() }); try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let before = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        do { _ = try await backend.copyIn([source]); XCTFail("Cancellation returned success") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), before)
        await backend.stop()
    }
    func testHiddenNonMediaAndPackageContentsAreSkipped() throws {
        let project = try Support.tempFolder("package-project"), source = try Support.tempFolder("Package-batch")
        defer { for folder in [project, source] { try? FileManager.default.removeItem(at: folder) } }
        _ = try image(source, "visible/photo.png")
        _ = try image(source, ".hidden.png")
        _ = try image(source, ".hidden-folder/photo.png")
        _ = try image(source, "Private.app/photo.png")
        try Data("screenplay".utf8).write(to: source.appendingPathComponent("script.txt"))
        let selection = try NativeMediaFolderSelection.collect(source, project: ProjectFolder(root: project))
        XCTAssertEqual(selection.items.map(\.relativePath), ["visible/photo.png"])
        XCTAssertTrue(selection.issues.isEmpty)
        XCTAssertThrowsError(try NativeMediaFolderSelection.collect(source.appendingPathComponent("Private.app"), project: ProjectFolder(root: project)))
    }
    func testEntryAndDepthLimitsReturnTruthfulPartialSelection() throws {
        let project = try Support.tempFolder("bounded-project"), source = try Support.tempFolder("Bounded")
        defer { for folder in [project, source] { try? FileManager.default.removeItem(at: folder) } }
        for name in ["a.png", "b.png", "c.png"] { _ = try image(source, name) }
        let limited = try NativeMediaFolderSelection.collect(source, project: ProjectFolder(root: project), maximumEntries: 2)
        XCTAssertEqual(limited.items.count, 2)
        XCTAssertEqual(limited.issues.count, 1)
        XCTAssertTrue(limited.issues[0].error.localizedDescription.contains("after 2 entries"))
        _ = try image(source, "one/two/three/photo.png")
        let deep = try NativeMediaFolderSelection.collect(source, project: ProjectFolder(root: project), maximumDepth: 2)
        XCTAssertEqual(deep.items.count, 3)
        XCTAssertEqual(deep.issues.map(\.path), ["one/two"])
        XCTAssertTrue(deep.issues[0].error.localizedDescription.contains("2 levels"))
    }
    func testReplacedSourceCannotEscapeSelectedFolder() throws {
        let project = try Support.tempFolder("replacement-project"), source = try Support.tempFolder("Source"), outside = try Support.tempFolder("Outside")
        defer { for folder in [project, source, outside] { try? FileManager.default.removeItem(at: folder) } }
        let original = try image(source, "nested/photo.png"), secret = try image(outside, "secret.png")
        let selection = try NativeMediaFolderSelection.collect(source, project: ProjectFolder(root: project))
        let item = try XCTUnwrap(selection.items.first)
        try FileManager.default.removeItem(at: original)
        try FileManager.default.createSymbolicLink(at: original, withDestinationURL: secret)
        XCTAssertThrowsError(try NativeMediaFolderSelection.validate(item, root: selection.root))
        XCTAssertEqual(try Data(contentsOf: secret), try Data(contentsOf: Support.fixture("still.png")))
    }

    func testConfinedProjectRootImportRemainsAvailableWithoutCopying() async throws {
        let root = try Support.tempFolder("root-import")
        defer { try? FileManager.default.removeItem(at: root) }
        _ = try image(root, "root.png")
        _ = try image(root, "media/nested/image.png")
        let backend = try backend(root); try await backend.start()
        let receipt = parse(try await backend.importMedia(["."]).text)
        XCTAssertEqual(Set(object(receipt["assets"]).keys), ["root.png", "media/nested/image.png"])
        XCTAssertEqual((receipt["failures"] as? [Any])?.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("media/root.png").path))
        await backend.stop()
    }

}
