import Foundation
import XCTest
@testable import ReelKit

final class NativeMediaPresentationTests: XCTestCase {
    private typealias Source = NativeMediaBrowser.Source
    private let organized: [Source] = [
        .init(id: "media/Organized/Camera A/shared.png", name: "Shared A", kind: "image"),
        .init(id: "media/Organized/Camera B/shared.png", name: "Shared B", kind: "image"),
        .init(id: "media/Organized/intro.mov", name: "Opening", kind: "video"),
        .init(id: "media/Organized/Audio/bed.wav", name: "Music bed", kind: "audio"),
        .init(id: "media/Organized-other/shared.png", name: "Shared sibling", kind: "image"),
        .init(id: "loose.png", name: "Loose", kind: "image")
    ]

    private func browse(_ sources: [Source], folder: String? = nil, query: String = "", kind: String = "All") -> NativeMediaBrowser {
        NativeMediaBrowser(sources: sources, selectedFolder: folder, query: query, kind: kind)
    }

    func testAllMediaRetainsEverySourceAndOffersActualRootFolders() {
        let result = browse(organized)
        XCTAssertNil(result.selectedFolder)
        XCTAssertEqual(result.visibleIDs, Set(organized.map(\.id)))
        XCTAssertEqual(result.childFolders.map(\.path), ["media"])
        XCTAssertEqual(result.childFolders.map(\.sourceCount), [5])
        XCTAssertFalse(result.isSearching)
    }

    func testSelectedFolderShowsDirectSourcesAndImmediateChildren() {
        let result = browse(organized, folder: "media/Organized")
        XCTAssertEqual(result.selectedFolder, "media/Organized")
        XCTAssertEqual(result.visibleIDs, ["media/Organized/intro.mov"])
        XCTAssertEqual(result.childFolders.map(\.path), ["media/Organized/Audio", "media/Organized/Camera A", "media/Organized/Camera B"])
        XCTAssertEqual(result.childFolders.map(\.sourceCount), [1, 1, 1])
        XCTAssertEqual(result.childFolders.map(\.name), ["Audio", "Camera A", "Camera B"])
    }

    func testDrillingIntoCollidingBasenamesKeepsSourceIdentity() {
        XCTAssertEqual(browse(organized, folder: "media/Organized/Camera A").visibleIDs, ["media/Organized/Camera A/shared.png"])
        XCTAssertEqual(browse(organized, folder: "media/Organized/Camera B").visibleIDs, ["media/Organized/Camera B/shared.png"])
    }

    func testFolderSearchIncludesDescendantsAndExcludesSiblingPrefix() {
        let result = browse(organized, folder: "media/Organized", query: "  SHARED\n")
        XCTAssertTrue(result.isSearching)
        XCTAssertTrue(result.childFolders.isEmpty)
        XCTAssertEqual(result.visibleIDs, ["media/Organized/Camera A/shared.png", "media/Organized/Camera B/shared.png"])
    }

    func testSearchCombinesNamePathFolderAndMediaType() {
        XCTAssertEqual(browse(organized, folder: "media/Organized", query: "music", kind: "Audio").visibleIDs, ["media/Organized/Audio/bed.wav"])
        XCTAssertEqual(browse(organized, folder: "media/Organized", query: "AUDIO/", kind: "Audio").visibleIDs, ["media/Organized/Audio/bed.wav"])
        XCTAssertTrue(browse(organized, folder: "media/Organized", query: "music", kind: "Image").visibleIDs.isEmpty)
        XCTAssertEqual(browse(organized, query: "opening", kind: "Video").visibleIDs, ["media/Organized/intro.mov"])
    }

    func testWhitespaceSearchKeepsNormalFolderNavigation() {
        let result = browse(organized, folder: "media/Organized", query: " \n\t")
        XCTAssertFalse(result.isSearching)
        XCTAssertEqual(result.visibleIDs, ["media/Organized/intro.mov"])
        XCTAssertEqual(result.childFolders.count, 3)
    }

    func testTypeFilterDoesNotInventOrRenameFolders() {
        let result = browse(organized, folder: "media/Organized", kind: "Audio")
        XCTAssertTrue(result.visibleIDs.isEmpty)
        XCTAssertEqual(result.childFolders.map(\.sourceCount), [1, 1, 1])
        XCTAssertEqual(browse(organized, folder: "media/Organized/Audio", kind: "Audio").visibleIDs, ["media/Organized/Audio/bed.wav"])
    }

    func testLiteralPercentUnicodeAndCasePathsRemainDistinct() {
        let sources: [Source] = [
            .init(id: "media/Camera/shared.png", name: "Shared", kind: "image"),
            .init(id: "media/camera/shared.png", name: "Shared", kind: "image"),
            .init(id: "media/100% %2F/Scene 🎬.png", name: "Scene", kind: "image"),
            .init(id: "media/日本語/photo.png", name: "Photo", kind: "image")
        ]
        let result = browse(sources, folder: "media")
        XCTAssertEqual(Set(result.childFolders.map(\.path)), ["media/Camera", "media/camera", "media/100% %2F", "media/日本語"])
        XCTAssertEqual(browse(sources, folder: "media/100% %2F").visibleIDs, ["media/100% %2F/Scene 🎬.png"])
        XCTAssertEqual(browse(sources, folder: "media/camera").visibleIDs, ["media/camera/shared.png"])
        XCTAssertEqual(sources.map(\.id), ["media/Camera/shared.png", "media/camera/shared.png", "media/100% %2F/Scene 🎬.png", "media/日本語/photo.png"])
    }

    func testInvalidPathsStayAccessibleWithoutPhantomFolders() {
        let ids = ["/private/photo.png", "../photo.png", "media/../photo.png", "media/./photo.png", "media//photo.png", "media/photo.png/", "media/\0/photo.png", "", "flat.png"]
        let result = browse(ids.map { Source(id: $0, name: "Photo", kind: "image") })
        XCTAssertEqual(result.visibleIDs, Set(ids))
        XCTAssertTrue(result.childFolders.isEmpty)
        for id in ids { XCTAssertNil(NativeMediaBrowser.parentPath(of: id)) }
    }

    func testDisappearingFolderFallsBackToAllAndRedoCanBrowseItAgain() {
        let withoutCamera = organized.filter { !$0.id.hasPrefix("media/Organized/Camera A/") }
        let undone = browse(withoutCamera, folder: "media/Organized/Camera A")
        XCTAssertNil(undone.selectedFolder)
        XCTAssertEqual(undone.visibleIDs, Set(withoutCamera.map(\.id)))
        XCTAssertEqual(browse(organized, folder: "media/Organized/Camera A").visibleIDs, ["media/Organized/Camera A/shared.png"])
    }

    func testDuplicateIdentityCountsOnceAndKeepsFirstMetadata() {
        let sources: [Source] = [
            .init(id: "media/take/photo.png", name: "First", kind: "image"),
            .init(id: "media/take/photo.png", name: "Later", kind: "video")
        ]
        XCTAssertEqual(browse(sources).childFolders.map(\.sourceCount), [1])
        XCTAssertEqual(browse(sources, query: "first", kind: "Image").visibleIDs, ["media/take/photo.png"])
        XCTAssertTrue(browse(sources, query: "later").visibleIDs.isEmpty)
        XCTAssertEqual(sources.count, 2)
    }

    func testUpNavigationUsesExactParentComponents() {
        XCTAssertNil(NativeMediaBrowser.parentPath(of: "media"))
        XCTAssertEqual(NativeMediaBrowser.parentPath(of: "media/Organized"), "media")
        XCTAssertEqual(NativeMediaBrowser.parentPath(of: "media/Organized/Camera A"), "media/Organized")
    }

    func testEmptyProjectHasNoFoldersAndClearsStaleSelection() {
        let result = browse([], folder: "media/Organized")
        XCTAssertNil(result.selectedFolder)
        XCTAssertTrue(result.visibleIDs.isEmpty)
        XCTAssertTrue(result.childFolders.isEmpty)
    }

    func testPathBoundsLimitGroupingWithoutHidingSources() {
        let long = String(repeating: "a", count: 8193) + "/image.png"
        let deep = Array(repeating: "nested", count: 65).joined(separator: "/") + "/image.png"
        let sources = [long, deep].map { Source(id: $0, name: "Image", kind: "image") }
        XCTAssertEqual(browse(sources).visibleIDs, Set([long, deep]))
        XCTAssertTrue(browse(sources).childFolders.isEmpty)
        XCTAssertNil(NativeMediaBrowser.parentPath(of: long))
        XCTAssertNil(NativeMediaBrowser.parentPath(of: deep))
    }

    func testFilesPreselectionLimitsUseBackendBounds() {
        XCTAssertEqual(NativeMediaImportLimits.filesPerBatch, NativeMediaImportSource.maximumRetainedFiles)
        XCTAssertEqual(NativeMediaImportLimits.filesPerBatch, 32)
        XCTAssertEqual(NativeMediaImportLimits.bytesPerBatch, NativeMediaImportSource.maximumBytes)
        XCTAssertEqual(NativeMediaImportLimits.bytesPerBatch, 64 * 1024 * 1024 * 1024)
        XCTAssertFalse(NativeMediaImportLimits.byteLimitLabel.isEmpty)
        XCTAssertTrue(NativeMediaImportLimits.acceptsFileSelection(count: 1))
        XCTAssertTrue(NativeMediaImportLimits.acceptsFileSelection(count: 32))
        XCTAssertFalse(NativeMediaImportLimits.acceptsFileSelection(count: 0))
        XCTAssertFalse(NativeMediaImportLimits.acceptsFileSelection(count: -1))
        XCTAssertFalse(NativeMediaImportLimits.acceptsFileSelection(count: 33))
        XCTAssertFalse(NativeMediaImportLimits.acceptsFileSelection(count: Int.max))
    }

    func testImportedFolderBrowserTracksUndoRedoAndReopenWithoutWritingMetadata() async throws {
        let root = try Support.tempFolder("browser-project"), source = try Support.tempFolder("Organized")
        defer { for folder in [root, source] { try? FileManager.default.removeItem(at: folder) } }
        let relative = ["Camera A/shared.png", "Camera B/shared.png"]
        let original = try Data(contentsOf: Support.fixture("still.png"))
        for path in relative {
            let file = source.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try original.write(to: file)
        }
        let backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core()) { _, _ in }
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Browser\"}")
        let receipt = parse(try await backend.copyIn([source]).text)
        XCTAssertEqual((receipt["failures"] as? [Any])?.count, 0)
        let paths = Set(relative.map { "media/Organized/" + $0 })
        XCTAssertEqual(Set(object(receipt["assets"]).keys), paths)
        let currentValue = await backend.currentProject()
        let current = try XCTUnwrap(currentValue)
        let projectFile = root.appendingPathComponent("reel.project.json")
        let before = try Data(contentsOf: projectFile)
        let registered = object(parse(current)["assets"]).keys.sorted().map { Source(id: $0, name: "Shared", kind: "image") }
        XCTAssertEqual(browse(registered, folder: "media/Organized").childFolders.map(\.name), ["Camera A", "Camera B"])
        XCTAssertEqual(browse(registered, folder: "media/Organized/Camera A").visibleIDs, ["media/Organized/Camera A/shared.png"])
        XCTAssertEqual(browse(registered, folder: "media/Organized", query: "shared").visibleIDs, paths)
        XCTAssertEqual(try Data(contentsOf: projectFile), before)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let undoneValue = await backend.currentProject()
        let undoneJSON = try XCTUnwrap(undoneValue)
        let undone = object(parse(undoneJSON)["assets"]).keys.map { Source(id: $0, name: "Shared", kind: "image") }
        XCTAssertNil(browse(undone, folder: "media/Organized/Camera A").selectedFolder)
        XCTAssertTrue(browse(undone).visibleIDs.isEmpty)
        for path in paths { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(path)), original) }
        _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}")
        let redoneValue = await backend.currentProject()
        let redoneJSON = try XCTUnwrap(redoneValue)
        XCTAssertEqual(Set(object(parse(redoneJSON)["assets"]).keys), paths)
        await backend.stop()
        let reopened = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core()) { _, _ in }
        try await reopened.start()
        let reopenedValue = await reopened.currentProject()
        let reopenedJSON = try XCTUnwrap(reopenedValue)
        let reopenedSources = object(parse(reopenedJSON)["assets"]).keys.map { Source(id: $0, name: "Shared", kind: "image") }
        XCTAssertEqual(browse(reopenedSources, folder: "media/Organized/Camera B").visibleIDs, ["media/Organized/Camera B/shared.png"])
        for path in relative { XCTAssertEqual(try Data(contentsOf: source.appendingPathComponent(path)), original) }
        for path in paths { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(path)), original) }
        await reopened.stop()
    }
}
