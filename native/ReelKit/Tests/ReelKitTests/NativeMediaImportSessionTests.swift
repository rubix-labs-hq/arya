import Foundation
import XCTest
@testable import ReelKit

final class NativeMediaImportSessionTests: XCTestCase {
    private actor ProbeGate {
        private var entered = false
        private var released = false
        private var waiter: CheckedContinuation<Void, Never>?
        func pause() async { entered = true; if !released { await withCheckedContinuation { waiter = $0 } } }
        func waitForEntry() async throws {
            let deadline = Date().addingTimeInterval(5)
            while !entered {
                guard Date() < deadline else { throw ReelBackend.APIError("The root import probe did not start.") }
                await Task.yield()
            }
        }
        func release() { released = true; waiter?.resume(); waiter = nil }
    }
    private func root(_ name: String = "Organized") throws -> NativeMediaImportRoot {
        try .init(id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!, name: name)
    }
    private func batch(_ root: NativeMediaImportRoot, subfolder: String = "", version: Int = 0, existing: Bool = false) throws -> NativeMediaImportSession {
        try .init(root: root, subfolder: subfolder, expectedVersion: version, requiresExistingRoot: existing)
    }
    private func asset(_ location: NativeMediaImportLocation) -> [String: Any] {
        ["still": true, NativeMediaImportLocation.metadataKey: location.fields]
    }
    private func source(_ folder: URL, _ path: String) throws -> URL {
        let url = folder.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: Support.fixture("still.png"), to: url)
        return url
    }
    private func backend(_ folder: URL, probe: ReelBackend.MediaProber? = nil) throws -> ReelBackend {
        try ReelBackend(folder: ProjectFolder(root: folder), coreScript: Support.core(), probe: probe) { _, _ in }
    }
    private func saved(_ b: ReelBackend) async throws -> [String: Any] {
        let value = await b.currentProject()
        return object(parse(try XCTUnwrap(value))["assets"])
    }

    func testExplicitRootAndRelativePathRoundTripWithoutChangingSourceID() throws {
        let root = try root("100% 日本語")
        let location = try batch(root, subfolder: "Camera A").location(relativePath: "Scene 🎬 %2F.png")
        XCTAssertEqual(location.relativePath, "Camera A/Scene 🎬 %2F.png")
        XCTAssertEqual(NativeMediaImportLocation.read(asset: asset(location)), location)
        let id = "media/Camera A-2/Scene 🎬 %2F.png"
        let browser = NativeMediaBrowser(sources: [.init(id: id, name: "Scene", kind: "image", importLocation: location)], selectedFolder: "Camera A", query: "", kind: "All", rootID: root.id)
        XCTAssertEqual(browser.visibleIDs, [id])
        XCTAssertEqual(browser.selectedRootID, root.id)
    }

    func testInvalidRootNamesAndLogicalPathsAreRejected() throws {
        for name in ["", "  ", ".", "..", "Camera/A", "Camera\\A", "bad\0name", String(repeating: "x", count: 129)] {
            XCTAssertThrowsError(try NativeMediaImportRoot(name: name))
        }
        let root = try root()
        for path in ["/outside", "../escape", "take/../escape", "take//file", "take/", "take/./file", "take\\file", "take\nfile", String(repeating: "x", count: 8193)] {
            XCTAssertThrowsError(try batch(root, subfolder: path))
        }
        XCTAssertThrowsError(try batch(root).location(relativePath: ""))
        XCTAssertThrowsError(try batch(root, version: -1))
        XCTAssertThrowsError(try batch(root, version: Int.max))
        let deep = Array(repeating: "level", count: 64).joined(separator: "/")
        XCTAssertThrowsError(try batch(root, subfolder: deep).location(relativePath: "file.png"))
    }

    func testMissingMalformedAndBooleanSchemaMetadataDoesNotOfferARoot() throws {
        let location = try batch(root()).location(relativePath: "take/file.png")
        for invalid in [["schema": true], ["schema": 2], ["rootID": "bad"], ["rootName": "../bad"], ["relativePath": "../file.png"]] as [[String: Any]] {
            var fields = location.fields
            fields.merge(invalid) { _, new in new }
            XCTAssertNil(NativeMediaImportLocation.read(asset: [NativeMediaImportLocation.metadataKey: fields]))
        }
        XCTAssertTrue(NativeMediaImportLocation.roots(assets: ["media/copy.png": ["still": true]]).isEmpty)
    }

    func testSessionChecksVersionExistingRootAndNameConflict() throws {
        let root = try root(), location = try batch(root).location(relativePath: "Camera A/a.png")
        let assets: [String: Any] = ["media/a.png": asset(location)]
        XCTAssertNoThrow(try batch(root, existing: true).validate(assets: assets, version: 0))
        XCTAssertThrowsError(try batch(root, version: 1, existing: true).validate(assets: assets, version: 0))
        XCTAssertThrowsError(try batch(root, existing: true).validate(assets: [:], version: 0))
        XCTAssertThrowsError(try batch(root).validate(assets: assets, version: 0))
        let sameName = try NativeMediaImportRoot(name: root.name)
        XCTAssertThrowsError(try batch(sameName).validate(assets: assets, version: 0))
        let renamed = try NativeMediaImportRoot(id: UUID(uuidString: root.id)!, name: "Renamed")
        XCTAssertThrowsError(try batch(renamed, existing: true).validate(assets: assets, version: 0))
        let conflicting: [String: Any] = ["one": asset(location), "two": asset(try batch(renamed).location(relativePath: "b.png"))]
        XCTAssertTrue(NativeMediaImportLocation.roots(assets: conflicting).isEmpty)
        XCTAssertThrowsError(try batch(root, existing: true).validate(assets: conflicting, version: 0))
    }

    func testRootCountIsBoundedAndExistingRootCanContinue() throws {
        var assets: [String: Any] = [:]
        var first: NativeMediaImportRoot?
        for index in 0..<NativeMediaImportSession.maximumRoots {
            let root = try NativeMediaImportRoot(name: "Root \(index)")
            if first == nil { first = root }
            assets["media/\(index).png"] = asset(try batch(root).location(relativePath: "file.png"))
        }
        XCTAssertThrowsError(try batch(root("Extra")).validate(assets: assets, version: 0))
        XCTAssertNoThrow(try batch(XCTUnwrap(first), existing: true).validate(assets: assets, version: 0))
    }

    func testConfirmationRejectsWrongRootPrefixAndProjectMetadata() throws {
        let root = try root(), batch = try batch(root, subfolder: "Camera A")
        let location = try batch.location(relativePath: "a.png"), good: [String: Any] = ["media/a.png": asset(location)]
        XCTAssertNoThrow(try batch.confirm(receiptAssets: good, projectAssets: good))
        XCTAssertThrowsError(try batch.confirm(receiptAssets: good, projectAssets: [:]))
        let sibling = try NativeMediaImportLocation(root: root, relativePath: "Camera A-other/a.png")
        let wrong: [String: Any] = ["media/a.png": asset(sibling)]
        XCTAssertThrowsError(try batch.confirm(receiptAssets: wrong, projectAssets: wrong))
        let other = try NativeMediaImportLocation(root: NativeMediaImportRoot(name: "Other"), relativePath: "Camera A/a.png")
        XCTAssertThrowsError(try batch.confirm(receiptAssets: ["media/a.png": asset(other)], projectAssets: good))
        XCTAssertNoThrow(try batch.confirm(receiptAssets: [:], projectAssets: [:]))
    }

    func testRootBrowserExcludesOtherRootsAndUsesLogicalComponentBoundary() throws {
        let root = try root(), other = try NativeMediaImportRoot(name: "Other")
        let sources: [NativeMediaBrowser.Source] = [
            .init(id: "media/copied/a.png", name: "Shared", kind: "image", importLocation: try batch(root).location(relativePath: "Camera A/deep/shared.png")),
            .init(id: "media/copied/b.png", name: "Shared", kind: "image", importLocation: try batch(root).location(relativePath: "Camera A-other/shared.png")),
            .init(id: "media/copied/c.png", name: "Shared", kind: "image", importLocation: try batch(other).location(relativePath: "Camera A/shared.png")),
            .init(id: "media/unrooted.png", name: "Shared", kind: "image")
        ]
        let rootBrowser = NativeMediaBrowser(sources: sources, selectedFolder: nil, query: "", kind: "All", rootID: root.id)
        XCTAssertEqual(Set(rootBrowser.childFolders.map(\.path)), ["Camera A", "Camera A-other"])
        let searched = NativeMediaBrowser(sources: sources, selectedFolder: "Camera A", query: "shared", kind: "Image", rootID: root.id)
        XCTAssertEqual(searched.visibleIDs, ["media/copied/a.png"])
        let stale = NativeMediaBrowser(sources: [], selectedFolder: "Camera A", query: "", kind: "All", rootID: root.id)
        XCTAssertNil(stale.selectedRootID)
        XCTAssertNil(stale.selectedFolder)
        XCTAssertEqual(NativeMediaBrowser(sources: sources, selectedFolder: nil, query: "", kind: "All").visibleIDs, Set(sources.map(\.id)))
        let conflictingRoot = try NativeMediaImportRoot(id: UUID(uuidString: root.id)!, name: "Conflicting")
        let conflicting = sources + [.init(id: "media/conflict.png", name: "Conflict", kind: "image", importLocation: try batch(conflictingRoot).location(relativePath: "Camera A/conflict.png"))]
        XCTAssertNil(NativeMediaBrowser(sources: conflicting, selectedFolder: nil, query: "", kind: "All", rootID: root.id).selectedRootID)
    }

    func testSeparateSubfolderBatchesKeepOneRootAcrossUndoRedoAndReopen() async throws {
        let project = try Support.tempFolder("session-project"), selected = try Support.tempFolder("Organized")
        defer { for folder in [project, selected] { try? FileManager.default.removeItem(at: folder) } }
        let a = try source(selected, "Camera A/shared.png"), b = try source(selected, "Camera B/shared.png")
        let original = try Data(contentsOf: a), root = try root(), backend = try backend(project)
        try await backend.start()
        let versionA = await backend.currentVersion()
        let aBatch = try batch(root, subfolder: "Camera A", version: versionA)
        let receiptA = parse(try await backend.copyIn([a.deletingLastPathComponent()], importSession: aBatch).text)
        let assetsA = object(receiptA["assets"])
        XCTAssertEqual(assetsA.count, 1)
        let versionB = await backend.currentVersion()
        let bBatch = try batch(root, subfolder: "Camera B", version: versionB, existing: true)
        let receiptB = parse(try await backend.copyIn([b.deletingLastPathComponent()], importSession: bBatch).text)
        let assetsB = object(receiptB["assets"]), all = try await saved(backend)
        XCTAssertEqual(assetsB.count, 1)
        try bBatch.confirm(receiptAssets: assetsB, projectAssets: all)
        XCTAssertEqual(NativeMediaImportLocation.roots(assets: all), [root])
        XCTAssertEqual(Set(all.values.compactMap { NativeMediaImportLocation.read(asset: object($0))?.relativePath }), ["Camera A/shared.png", "Camera B/shared.png"])
        XCTAssertEqual(Set(all.keys), ["media/Camera A/shared.png", "media/Camera B/shared.png"])
        let beforeBrowse = try Data(contentsOf: project.appendingPathComponent("reel.project.json"))
        let sources = all.map { NativeMediaBrowser.Source(id: $0.key, name: "Shared", kind: "image", importLocation: NativeMediaImportLocation.read(asset: object($0.value))) }
        XCTAssertEqual(NativeMediaBrowser(sources: sources, selectedFolder: "Camera B", query: "", kind: "All", rootID: root.id).visibleIDs, Set(assetsB.keys))
        XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent("reel.project.json")), beforeBrowse)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let undone = try await saved(backend)
        XCTAssertEqual(Set(undone.keys), Set(assetsA.keys))
        XCTAssertEqual(NativeMediaImportLocation.roots(assets: undone), [root])
        _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}")
        let redone = try await saved(backend)
        XCTAssertEqual(Set(redone.keys), Set(all.keys))
        await backend.stop()
        let reopened = try self.backend(project); try await reopened.start()
        let restored = try await saved(reopened)
        XCTAssertEqual(NativeMediaImportLocation.roots(assets: restored), [root])
        for path in restored.keys { XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent(path)), original) }
        XCTAssertEqual(try Data(contentsOf: a), original); XCTAssertEqual(try Data(contentsOf: b), original)
        await reopened.stop()
    }

    func testLogicalDuplicateIsReportedWithoutReplacingOrRegisteringACopy() async throws {
        let project = try Support.tempFolder("duplicate-project"), selected = try Support.tempFolder("duplicate-source")
        defer { for folder in [project, selected] { try? FileManager.default.removeItem(at: folder) } }
        let file = try source(selected, "shared.png"), root = try root(), b = try backend(project)
        try await b.start()
        let firstVersion = await b.currentVersion()
        _ = try await b.copyIn([file], importSession: batch(root, subfolder: "Camera A", version: firstVersion))
        let before = try Data(contentsOf: project.appendingPathComponent("reel.project.json")), version = await b.currentVersion()
        let receipt = parse(try await b.copyIn([file], importSession: batch(root, subfolder: "Camera A", version: version, existing: true)).text)
        XCTAssertTrue(object(receipt["assets"]).isEmpty)
        XCTAssertEqual((receipt["failures"] as? [Any])?.count, 1)
        XCTAssertEqual((receipt["unregisteredCopies"] as? [Any])?.count, 0)
        XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent("reel.project.json")), before)
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: project.appendingPathComponent("media").path)), ["shared.png"])
        let after = await b.currentVersion(); XCTAssertEqual(after, version)
        await b.stop()
    }

    func testPartialProbeFailureAddsLocationOnlyToConfirmedAsset() async throws {
        let project = try Support.tempFolder("partial-root"), selected = try Support.tempFolder("partial-source")
        defer { for folder in [project, selected] { try? FileManager.default.removeItem(at: folder) } }
        let good = try source(selected, "good.png"), bad = selected.appendingPathComponent("bad.mp4")
        try Data("invalid video".utf8).write(to: bad)
        let root = try root(), b = try backend(project); try await b.start()
        let version = await b.currentVersion()
        let receipt = parse(try await b.copyIn([good, bad], importSession: batch(root, subfolder: "Camera A", version: version)).text)
        let assets = object(receipt["assets"])
        XCTAssertEqual(Set(assets.keys), ["media/good.png"])
        XCTAssertEqual(NativeMediaImportLocation.read(asset: object(assets["media/good.png"]))?.relativePath, "Camera A/good.png")
        XCTAssertEqual((receipt["failures"] as? [Any])?.count, 1)
        XCTAssertEqual(receipt["unregisteredCopies"] as? [String], ["media/bad.mp4"])
        let saved = try await saved(b)
        XCTAssertEqual(Set(saved.keys), ["media/good.png"])
        XCTAssertEqual(NativeMediaImportLocation.roots(assets: saved), [root])
        await b.stop()
    }

    func testFailedOnlyBatchDoesNotCreateAPersistentRoot() async throws {
        let project = try Support.tempFolder("failed-root"), selected = try Support.tempFolder("failed-source")
        defer { for folder in [project, selected] { try? FileManager.default.removeItem(at: folder) } }
        let bad = selected.appendingPathComponent("bad.mp4"); try Data("invalid video".utf8).write(to: bad)
        let root = try root(), b = try backend(project); try await b.start()
        let version = await b.currentVersion()
        let receipt = parse(try await b.copyIn([bad], importSession: batch(root, version: version)).text)
        XCTAssertTrue(object(receipt["assets"]).isEmpty)
        let current = await b.currentProject(); XCTAssertNil(current)
        let after = await b.currentVersion(); XCTAssertEqual(after, version)
        XCTAssertTrue(FileManager.default.fileExists(atPath: project.appendingPathComponent("media/bad.mp4").path))
        await b.stop()
    }

    func testStaleSessionAndOversizedSelectionFailBeforeDestinationCreation() async throws {
        let project = try Support.tempFolder("guard-root"), selected = try Support.tempFolder("guard-source")
        defer { for folder in [project, selected] { try? FileManager.default.removeItem(at: folder) } }
        let file = try source(selected, "photo.png"), root = try root(), b = try backend(project)
        try await b.start()
        let version = await b.currentVersion()
        for (urls, session, message) in [(Array(repeating: file, count: 33), try batch(root, version: version), "1 to 32"), ([file], try batch(root, version: version + 1), "project changed")] {
            do { _ = try await b.copyIn(urls, importSession: session); XCTFail("Invalid root batch copied") }
            catch { XCTAssertTrue(error.localizedDescription.contains(message)) }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: project.appendingPathComponent("media/photo.png").path))
        let current = await b.currentProject(); XCTAssertNil(current)
        await b.stop()
    }

    func testCancelledProbeRetainsCopyWithoutRootMetadataOrHistory() async throws {
        let project = try Support.tempFolder("cancel-root"), selected = try Support.tempFolder("cancel-source")
        defer { for folder in [project, selected] { try? FileManager.default.removeItem(at: folder) } }
        let file = try source(selected, "photo.png"), original = try Data(contentsOf: file)
        let b = try backend(project, probe: { _ in throw CancellationError() }); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let before = try Data(contentsOf: project.appendingPathComponent("reel.project.json")), version = await b.currentVersion()
        do { _ = try await b.copyIn([file], importSession: batch(root(), version: version)); XCTFail("Cancelled root import succeeded") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent("reel.project.json")), before)
        let saved = try await saved(b); XCTAssertTrue(NativeMediaImportLocation.roots(assets: saved).isEmpty)
        XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent("media/photo.png")), original)
        XCTAssertEqual(try Data(contentsOf: file), original)
        await b.stop()
    }

    func testProjectChangeDuringProbeKeepsCopyUnregisteredAndRootAbsent() async throws {
        let project = try Support.tempFolder("changed-root"), selected = try Support.tempFolder("changed-source")
        defer { for folder in [project, selected] { try? FileManager.default.removeItem(at: folder) } }
        let file = try source(selected, "photo.png"), original = try Data(contentsOf: file), gate = ProbeGate()
        let b = try backend(project, probe: { _ in
            await gate.pause()
            return .object([("still", true), ("hasVideo", false), ("hasAudio", false)])
        })
        try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Before\"}")
        let version = await b.currentVersion(), batch = try batch(root(), version: version)
        let pending = Task { try await b.copyIn([file], importSession: batch) }
        defer { pending.cancel(); Task { await gate.release() } }
        try await gate.waitForEntry()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Replacement\"}")
        let replacement = try Data(contentsOf: project.appendingPathComponent("reel.project.json"))
        await gate.release()
        do { _ = try await pending.value; XCTFail("Stale root batch registered") }
        catch { XCTAssertTrue(error.localizedDescription.contains("project changed")) }
        XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent("reel.project.json")), replacement)
        let assets = try await saved(b)
        XCTAssertTrue(assets.isEmpty); XCTAssertTrue(NativeMediaImportLocation.roots(assets: assets).isEmpty)
        XCTAssertEqual(try Data(contentsOf: project.appendingPathComponent("media/photo.png")), original)
        XCTAssertEqual(try Data(contentsOf: file), original)
        await b.stop()
    }

    func testLargeFolderCanContinueInSameRootWithBoundedReceipts() async throws {
        let project = try Support.tempFolder("large-root"), selected = try Support.tempFolder("Large")
        defer { for folder in [project, selected] { try? FileManager.default.removeItem(at: folder) } }
        let paths = (0..<35).map { String(format: "take/file%03d.png", $0) }
        for path in paths { _ = try source(selected, path) }
        let root = try root(), b = try backend(project); try await b.start()
        let firstVersion = await b.currentVersion()
        let first = parse(try await b.copyIn([selected], importSession: batch(root, version: firstVersion)).text)
        XCTAssertEqual(object(first["assets"]).count, 32)
        XCTAssertEqual((first["failures"] as? [Any])?.count, 3)
        let secondVersion = await b.currentVersion()
        let second = parse(try await b.copyIn([selected], importSession: batch(root, version: secondVersion, existing: true)).text)
        XCTAssertEqual(object(second["assets"]).count, 3)
        XCTAssertEqual((second["failures"] as? [Any])?.count, 32)
        XCTAssertEqual((second["unregisteredCopies"] as? [Any])?.count, 0)
        let registered = try await saved(b)
        XCTAssertEqual(registered.count, 35)
        XCTAssertEqual(Set(registered.values.compactMap { NativeMediaImportLocation.read(asset: object($0))?.relativePath }), Set(paths))
        XCTAssertEqual(NativeMediaImportLocation.roots(assets: registered), [root])
        let sources = registered.map { NativeMediaBrowser.Source(id: $0.key, name: "File", kind: "image", importLocation: NativeMediaImportLocation.read(asset: object($0.value))) }
        XCTAssertEqual(NativeMediaBrowser(sources: sources, selectedFolder: "take", query: "", kind: "All", rootID: root.id).visibleIDs, Set(registered.keys))
        await b.stop()
    }

    func testSelectedLinkCreatesNoRootEntryAndDoesNotReadTargetAsImport() async throws {
        let project = try Support.tempFolder("link-root"), selected = try Support.tempFolder("link-source")
        defer { for folder in [project, selected] { try? FileManager.default.removeItem(at: folder) } }
        let original = try source(selected, "photo.png"), bytes = try Data(contentsOf: original)
        let link = selected.appendingPathComponent("alias.png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: original)
        let b = try backend(project); try await b.start()
        let version = await b.currentVersion()
        let receipt = parse(try await b.copyIn([link], importSession: batch(root(), version: version)).text)
        XCTAssertTrue(object(receipt["assets"]).isEmpty)
        XCTAssertEqual((receipt["failures"] as? [Any])?.count, 1)
        let current = await b.currentProject(); XCTAssertNil(current)
        XCTAssertEqual(try Data(contentsOf: original), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: project.appendingPathComponent("media/alias.png").path))
        await b.stop()
    }

    func testOrdinaryReprobePreservesSavedImportLocation() async throws {
        let project = try Support.tempFolder("reprobe-root"), selected = try Support.tempFolder("reprobe-source")
        defer { for folder in [project, selected] { try? FileManager.default.removeItem(at: folder) } }
        let file = try source(selected, "photo.png"), root = try root(), b = try backend(project); try await b.start()
        let version = await b.currentVersion()
        let first = parse(try await b.copyIn([file], importSession: batch(root, subfolder: "Camera A", version: version)).text)
        let path = try XCTUnwrap(object(first["assets"]).keys.first)
        let originalLocation = NativeMediaImportLocation.read(asset: object(object(first["assets"])[path]))
        let reprobed = parse(try await b.importMedia([path]).text)
        XCTAssertEqual(NativeMediaImportLocation.read(asset: object(object(reprobed["assets"])[path])), originalLocation)
        let current = try await saved(b)
        XCTAssertEqual(NativeMediaImportLocation.roots(assets: current), [root])
        XCTAssertEqual(NativeMediaImportLocation.read(asset: object(current[path])), originalLocation)
        await b.stop()
    }
}
