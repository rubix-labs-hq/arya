import Foundation
import Darwin
import XCTest
@testable import ReelKit

private actor RestorationProbeGate {
    private var reached = false, released = false
    private var entrants: [CheckedContinuation<Void, Never>] = []
    private var pending: CheckedContinuation<Void, Never>?
    func enter() async {
        reached = true; entrants.forEach { $0.resume() }; entrants = []
        if !released { await withCheckedContinuation { pending = $0 } }
    }
    func waitUntilEntered() async { if !reached { await withCheckedContinuation { entrants.append($0) } } }
    func release() { released = true; pending?.resume(); pending = nil }
}

final class MissingMediaRestoreTests: XCTestCase {
    private let src = "media/camera/take.wav"
    private let bytes = Data([1, 2, 3, 4])
    private func facts() -> JSON { .object([("size", 4), ("hasAudio", true), ("hasVideo", false), ("duration", 10), ("channels", 2), ("codec", "pcm")]) }
    private func fixture(probe: ReelBackend.MediaProber? = nil, admission: ProjectWriteAdmission = ProjectWriteAdmission()) async throws -> (URL, URL, ReelBackend) {
        let root = try Support.tempFolder("missing-original")
        let original = root.appendingPathComponent(src)
        try FileManager.default.createDirectory(at: original.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: original)
        let fields = facts()
        let backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), probe: probe ?? { _ in fields }, writeAdmission: { try admission.requireWritable() }, events: { _, _ in })
        try await backend.start()
        _ = try await backend.importMedia([src])
        _ = try await backend.editOperations(ops: .array([.object([("op", "add_clip"), ("src", .string(src)), ("track", "A1"), ("start", 0), ("dur", 3)])]))
        try FileManager.default.removeItem(at: original)
        let selected = root.deletingLastPathComponent().appendingPathComponent("selected-original.wav")
        try bytes.write(to: selected)
        return (root, selected, backend)
    }
    private func cleanup(_ root: URL, _ backend: ReelBackend) async { await backend.stop(); try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
    private func assertRejected(_ task: Task<JSON, Error>, file: StaticString = #filePath, line: UInt = #line) async {
        do { _ = try await task.value; XCTFail("Unsafe restoration must reject", file: file, line: line) } catch { }
    }
    private func assertNoStaging(_ root: URL, file: StaticString = #filePath, line: UInt = #line) throws {
        let entries = try FileManager.default.contentsOfDirectory(atPath: ProjectFolder(root: root).cacheDir.path)
        XCTAssertFalse(entries.contains { $0.hasPrefix("restore-") }, file: file, line: line)
    }

    func testRestorationPreservesExactProjectBytesVersionAndExistingRedoBranch() async throws {
        let (root, selected, backend) = try await fixture()
        _ = try await backend.editOperations(ops: .array([.object([("op", "project"), ("set", .object([("name", "After")]))])]))
        let renamed = await backend.currentProject()
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let file = ProjectFolder(root: root).projectFile, before = try Data(contentsOf: file)
        let version = await backend.currentVersion(), project = await backend.currentProject()
        let receipt = try await backend.restoreMissingMedia(source: src, from: selected, expectedVersion: version)
        XCTAssertEqual(parse(receipt.text)["restored"] as? Bool, true)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(src)), bytes)
        XCTAssertEqual(try Data(contentsOf: selected), bytes)
        XCTAssertEqual(try Data(contentsOf: file), before)
        let afterVersion = await backend.currentVersion(), after = await backend.currentProject()
        XCTAssertEqual(afterVersion, version); XCTAssertEqual(after, project)
        _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}")
        let redone = await backend.currentProject(); XCTAssertEqual(redone, renamed)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let undone = await backend.currentProject(); XCTAssertEqual(undone, project)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(src)), bytes, "Project Undo never deletes a restored original")
        try assertNoStaging(root); await cleanup(root, backend)
    }

    func testExistingDestinationAndDanglingLeafLinkAreNeverReplaced() async throws {
        for link in [false, true] {
            let (root, selected, backend) = try await fixture(), target = root.appendingPathComponent(src)
            if link { try FileManager.default.createSymbolicLink(atPath: target.path, withDestinationPath: "absent.wav") }
            else { try Data([9]).write(to: target) }
            let before = try Data(contentsOf: ProjectFolder(root: root).projectFile), version = await backend.currentVersion()
            await assertRejected(Task { try await backend.restoreMissingMedia(source: self.src, from: selected, expectedVersion: version) })
            if link { XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: target.path), "absent.wav") }
            else { XCTAssertEqual(try Data(contentsOf: target), Data([9])) }
            XCTAssertEqual(try Data(contentsOf: ProjectFolder(root: root).projectFile), before)
            try assertNoStaging(root); await cleanup(root, backend)
        }
    }

    func testStaleVersionAndReadOnlyAdmissionRejectBeforeCopy() async throws {
        let admission = ProjectWriteAdmission(), (root, selected, backend) = try await fixture(admission: admission)
        let version = await backend.currentVersion()
        await assertRejected(Task { try await backend.restoreMissingMedia(source: self.src, from: selected, expectedVersion: version-1) })
        admission.setBlockedReason("Document conflict")
        await assertRejected(Task { try await backend.restoreMissingMedia(source: self.src, from: selected, expectedVersion: version) })
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(src).path))
        try assertNoStaging(root); await cleanup(root, backend)
    }

    func testSuspendedProbeRejectsProjectReplacementConflictAndRacingDestination() async throws {
        for mode in ["new", "replace", "external-invalid", "external-zero", "external-valid", "conflict", "destination", "cancel", "staged-bytes"] {
            let gate = RestorationProbeGate(), fields = facts(), admission = ProjectWriteAdmission()
            let (root, selected, backend) = try await fixture(probe: { url in
                if url.path.contains("/restore-") { await gate.enter(); if mode == "staged-bytes" { try Data([5,6,7,8]).write(to: url) } }
                return fields
            }, admission: admission)
            let file = ProjectFolder(root: root).projectFile, target = root.appendingPathComponent(src)
            let before = try Data(contentsOf: file), version = await backend.currentVersion()
            let task = Task { try await backend.restoreMissingMedia(source: self.src, from: selected, expectedVersion: version) }
            await gate.waitUntilEntered()
            var expected = before
            if mode == "new" { _ = try await backend.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Different\"}"); expected = try Data(contentsOf: file) }
            if mode == "replace" {
                var p = parse(String(data: before, encoding: .utf8)!); p["name"] = "Replaced"
                _ = try await backend.editOperations(ops: .array([.object([("op", "replace"), ("project", JSON(any: p))])]))
                expected = try Data(contentsOf: file)
            }
            if mode == "external-invalid" || mode == "external-zero" { expected = mode == "external-zero" ? Data() : Data("{invalid".utf8); try expected.write(to: file, options: .atomic) }
            if mode == "external-valid" { var p = parse(String(data: before, encoding: .utf8)!); p["name"] = "External"; expected = try JSONSerialization.data(withJSONObject: p); try expected.write(to: file, options: .atomic) }
            if mode == "conflict" { admission.setBlockedReason("Conflict detected while probing") }
            if mode == "destination" { try Data([9]).write(to: target) }
            if mode == "cancel" { task.cancel() }
            await gate.release(); await assertRejected(task)
            XCTAssertEqual(try Data(contentsOf: file), expected, mode)
            if mode == "destination" { XCTAssertEqual(try Data(contentsOf: target), Data([9])) }
            else { XCTAssertFalse(FileManager.default.fileExists(atPath: target.path), mode) }
            XCTAssertEqual(try Data(contentsOf: selected), bytes)
            try assertNoStaging(root); await cleanup(root, backend)
        }
    }

    func testSelectedSymlinkAndChangedMediaFactsRejectWithoutDestination() async throws {
        for mismatch in [false, true] {
            let fields = facts()
            let (root, selected, backend) = try await fixture(probe: { url in
                if mismatch && url.path.contains("/restore-") { return .object([("size", 4), ("hasAudio", true), ("hasVideo", false), ("duration", 9), ("channels", 2)]) }
                return fields
            })
            let chosen = mismatch ? selected : selected.deletingLastPathComponent().appendingPathComponent("linked.wav")
            if !mismatch { try FileManager.default.createSymbolicLink(at: chosen, withDestinationURL: selected) }
            let version = await backend.currentVersion(), before = try Data(contentsOf: ProjectFolder(root: root).projectFile)
            await assertRejected(Task { try await backend.restoreMissingMedia(source: self.src, from: chosen, expectedVersion: version) })
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(src).path))
            XCTAssertEqual(try Data(contentsOf: ProjectFolder(root: root).projectFile), before)
            try assertNoStaging(root); await cleanup(root, backend)
        }
    }

    func testMissingInterchangeStyleAssetWithoutMeasuredSizeCanRestore() async throws {
        let (root, selected, backend) = try await fixture(), file = ProjectFolder(root: root).projectFile
        var p = parse(try String(contentsOf: file, encoding: .utf8)), assets = object(p["assets"]), asset = object(assets[src])
        asset.removeValue(forKey: "size"); assets[src] = asset; p["assets"] = assets
        let text = try JSONSerialization.data(withJSONObject: p); try text.write(to: file, options: .atomic)
        try await backend.refreshProjectFile()
        let version = await backend.currentVersion()
        _ = try await backend.restoreMissingMedia(source: src, from: selected, expectedVersion: version)
        XCTAssertEqual(try Data(contentsOf: file), text)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(src)), bytes)
        try assertNoStaging(root); await cleanup(root, backend)
    }

    func testSameByteProjectFolderReplacementDoesNotRestoreIntoAnotherFolder() async throws {
        let (root, selected, backend) = try await fixture(), saved = root.deletingLastPathComponent().appendingPathComponent("old-project")
        let version = await backend.currentVersion(), before = try Data(contentsOf: ProjectFolder(root: root).projectFile)
        try FileManager.default.moveItem(at: root, to: saved)
        try FileManager.default.copyItem(at: saved, to: root)
        await assertRejected(Task { try await backend.restoreMissingMedia(source: self.src, from: selected, expectedVersion: version) })
        XCTAssertEqual(try Data(contentsOf: ProjectFolder(root: root).projectFile), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(src).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: saved.appendingPathComponent(src).path))
        try assertNoStaging(root); await cleanup(root, backend)
    }

    func testFIFOSelectedOriginalRejectsBeforeAReadCanBlock() async throws {
        let (root, selected, backend) = try await fixture()
        let regular = selected.deletingLastPathComponent().appendingPathComponent("preserved-regular.wav")
        try FileManager.default.moveItem(at: selected, to: regular)
        XCTAssertEqual(Darwin.mkfifo(selected.path, 0o600), 0)
        let version = await backend.currentVersion(), clock = ContinuousClock(), began = ContinuousClock.now
        await assertRejected(Task { try await backend.restoreMissingMedia(source: self.src, from: selected, expectedVersion: version) })
        XCTAssertLessThan(began.duration(to: clock.now), .seconds(1))
        XCTAssertEqual(try Data(contentsOf: regular), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(src).path))
        try assertNoStaging(root); await cleanup(root, backend)
    }

    func testStagedFIFORejectsIdentityAndDigestChecksBeforeBlocking() async throws {
        let root = try Support.tempFolder("staged-fifo"), folder = ProjectFolder(root: root)
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(at: folder.cacheDir, withIntermediateDirectories: true)
        let selected = root.appendingPathComponent("selected.wav"); try bytes.write(to: selected)
        let identity = try NativeMissingMediaRestore.rootIdentity(folder)
        let stage = try await NativeMissingMediaRestore.stageAsync(selected, folder: folder, expectedRoot: (identity.st_dev, identity.st_ino))
        try FileManager.default.removeItem(at: stage.file)
        XCTAssertEqual(Darwin.mkfifo(stage.file.path, 0o600), 0)
        let clock = ContinuousClock(), began = clock.now
        XCTAssertThrowsError(try stage.validateIdentity())
        XCTAssertThrowsError(try stage.validate())
        XCTAssertLessThan(began.duration(to: clock.now), .seconds(1))
        XCTAssertEqual(try Data(contentsOf: selected), bytes)
    }

    func testAncestorSymlinkNeverReceivesRestoredOriginal() async throws {
        let (root, selected, backend) = try await fixture()
        let camera = root.appendingPathComponent("media/camera"), other = root.appendingPathComponent("other")
        try FileManager.default.removeItem(at: camera); try FileManager.default.createDirectory(at: other, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: camera, withDestinationURL: other)
        let version = await backend.currentVersion()
        await assertRejected(Task { try await backend.restoreMissingMedia(source: self.src, from: selected, expectedVersion: version) })
        XCTAssertFalse(FileManager.default.fileExists(atPath: other.appendingPathComponent("take.wav").path))
        try assertNoStaging(root); await cleanup(root, backend)
    }
}
