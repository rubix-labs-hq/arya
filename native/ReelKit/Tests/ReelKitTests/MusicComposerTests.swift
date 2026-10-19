import AVFoundation
import CryptoKit
import Foundation
import XCTest
@testable import ReelKit

private actor MusicRenderGate {
    var entered = false
    var waiters: [CheckedContinuation<Void, Never>] = []
    var permit: CheckedContinuation<Void, Never>?
    func waitForRender() async {
        if entered { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() { permit?.resume(); permit = nil }
    func render(folder: ProjectFolder, score: String, script: URL) async throws -> NativeMusicComposer.Rendered {
        entered = true
        for waiter in waiters { waiter.resume() }; waiters = []
        await withCheckedContinuation { permit = $0 }
        try Task.checkCancellation()
        return try await NativeMusicComposer.render(folder: folder, scoreJSON: score, scriptURL: script)
    }
}

private actor MusicRetryDiagnosticGate {
    private var entered = false
    private var finished = false
    private var released = false
    private var waiters: [CheckedContinuation<Bool, Never>] = []
    private var permit: CheckedContinuation<Void, Never>?
    private(set) var renderCount = 0

    func waitForRender() async -> Bool {
        if entered { return true }
        if finished { return false }
        return await withCheckedContinuation { waiters.append($0) }
    }
    func requestFinished() {
        finished = true
        if !entered { for waiter in waiters { waiter.resume(returning: false) }; waiters = [] }
    }
    func release() { released = true; permit?.resume(); permit = nil }
    func render(folder: ProjectFolder, score: String, script: URL) async throws -> NativeMusicComposer.Rendered {
        renderCount += 1
        guard renderCount == 1 else { throw NativeMusicComposer.Failure(message: "Retry unexpectedly invoked a second score render") }
        entered = true
        for waiter in waiters { waiter.resume(returning: true) }; waiters = []
        if !released { await withCheckedContinuation { permit = $0 } }
        try Task.checkCancellation()
        return try await NativeMusicComposer.render(folder: folder, scoreJSON: score, scriptURL: script)
    }
}

final class MusicComposerTests: XCTestCase {
    private var score: [String: Any] { ["version": 1, "title": "Original native QA cue", "bpm": 120, "lengthBeats": 2, "seed": 17, "room": 0, "parts": [["id": "keys", "instrument": "keys", "gainDb": -12, "pan": -0.2, "notes": [["at": 0.25, "duration": 1.5, "pitch": 62, "velocity": 0.7]]]]] }
    private func musicScript() throws -> URL { try Support.core().deletingLastPathComponent().appendingPathComponent("arya-music.js") }
    private func currentProject(_ backend: ReelBackend) async throws -> String {
        let value = await backend.currentProject(); return try XCTUnwrap(value)
    }
    private func values(_ value: Any?) -> [Any] { value as? [Any] ?? [] }
    private func request(version: Int, comp: String? = nil, track: String = "A3", start: Double = 0) -> String {
        JSON(any: ["score": score, "track": track, "start": start, "expectedVersion": version, "comp": comp as Any? ?? NSNull()]).text
    }
    private func backend(_ root: URL, renderer: ReelBackend.MusicRenderer? = nil) throws -> ReelBackend {
        let core = try Support.core()
        if let renderer { return try ReelBackend(folder: ProjectFolder(root: root), coreScript: core, renderMusic: renderer) { _, _ in } }
        return try ReelBackend(folder: ProjectFolder(root: root), coreScript: core) { _, _ in }
    }

    func testAssistantAllowlistAdmitsOnlyIntendedMusicMethods() {
        XCTAssertTrue(Assistant.allows(method: "GET", path: "/api/audio/compose/capabilities"))
        XCTAssertTrue(Assistant.allows(method: "POST", path: "/api/audio/compose"))
        XCTAssertTrue(Assistant.allows(method: "POST", path: "/api/audio/compose/place"))
        XCTAssertFalse(Assistant.allows(method: "GET", path: "/api/audio/compose"))
        XCTAssertFalse(Assistant.allows(method: "POST", path: "/api/audio/compose/capabilities"))
        XCTAssertFalse(Assistant.allows(method: "POST", path: "/api/assistant/config"))
        XCTAssertFalse(Assistant.allows(method: "POST", path: "/api/reveal"))
    }

    func testActualJSCAndAVFoundationRenderStereoPCM24AndPersistNormalizedScore() async throws {
        let root = try Support.tempFolder("score-worker")
        defer { try? FileManager.default.removeItem(at: root) }
        let result = try await NativeMusicComposer.render(folder: ProjectFolder(root: root), scoreJSON: JSON(any: score).text, scriptURL: musicScript())
        let file = try AVAudioFile(forReading: root.appendingPathComponent(result.path))
        XCTAssertEqual(file.length, 48000); XCTAssertEqual(file.fileFormat.sampleRate, 48000); XCTAssertEqual(file.fileFormat.channelCount, 2)
        let bytes = try Data(contentsOf: root.appendingPathComponent(result.path))
        XCTAssertEqual(bytes.count, 288044); XCTAssertEqual(String(data: bytes.prefix(4), encoding: .utf8), "RIFF")
        XCTAssertTrue(bytes.dropFirst(44).prefix(6000 * 6).allSatisfy { $0 == 0 }, "note onset is at 0.125 seconds")
        XCTAssertTrue(bytes.dropFirst(44 + 6000 * 6).contains { $0 != 0 })
        let asset = parse(try NativeMusicComposer.assetRecord(rendered: result, script: String(contentsOf: musicScript(), encoding: .utf8)))
        XCTAssertEqual(asset["codec"] as? String, "pcm_s24le")
        let generated = object(asset["generated"])
        XCTAssertEqual(generated["renderer"] as? String, "arya-score-synth/1")
        XCTAssertEqual(object(generated["score"])["title"] as? String, "Original native QA cue")
    }

    func testMediaRegistrationAndRequestedPlacementPreserveOtherTracksAndUndoRetainsAsset() async throws {
        let root = try Support.tempFolder("music-backend")
        defer { try? FileManager.default.removeItem(at: root) }
        let b = try backend(root); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: #"{"name":"Preserve me"}"#)
        _ = try await b.editOperations(ops: .raw(#"[{"op":"add_title","track":"V3","start":0,"dur":3,"title":{"text":"Original"}}]"#))
        let before = try await currentProject(b), version = await b.currentVersion()
        let reply = parse(try await b.handleAssistant(method: "POST", path: "/api/audio/compose", body: request(version: version, start: 1)).text)
        XCTAssertEqual(reply["state"] as? String, "complete")
        let path = try XCTUnwrap(reply["path"] as? String)
        let composed = parse(try await currentProject(b))
        let oldTracks = values(parse(before)["tracks"]).map(object), tracks = values(composed["tracks"]).map(object)
        XCTAssertEqual(JSON(any: Array(tracks.prefix(5))).text, JSON(any: Array(oldTracks.prefix(5))).text)
        XCTAssertEqual(values(tracks[5]["clips"]).count, 1); XCTAssertNotNil(object(composed["assets"])[path])
        _ = try await b.handle(method: "POST", path: "/api/undo", body: "{}")
        let undone = parse(try await currentProject(b))
        XCTAssertTrue(values(object(values(undone["tracks"])[5])["clips"]).isEmpty); XCTAssertNotNil(object(undone["assets"])[path])
        _ = try await b.handle(method: "POST", path: "/api/redo", body: "{}")
        await b.stop()
        let reopened = try backend(root); try await reopened.start()
        let saved = parse(try await currentProject(reopened))
        XCTAssertNotNil(object(object(object(saved["assets"])[path])["generated"])["score"])
        await reopened.stop()
    }

    func testChangedTargetRetainsMediaAndRetryDoesNotRegenerate() async throws {
        let root = try Support.tempFolder("music-retry"), gate = MusicRenderGate()
        defer { try? FileManager.default.removeItem(at: root) }
        let b = try backend(root, renderer: { folder, score, script in try await gate.render(folder: folder, score: score, script: script) }); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: #"{"name":"Retry"}"#)
        let version = await b.currentVersion(), body = request(version: version)
        let task = Task { try await b.handle(method: "POST", path: "/api/audio/compose", body: body) }
        await gate.waitForRender()
        _ = try await b.editOperations(ops: .raw(#"[{"op":"project","set":{"name":"User edited"}}]"#))
        await gate.release()
        let ready = parse(try await task.value.text)
        XCTAssertEqual(ready["state"] as? String, "asset_ready"); XCTAssertEqual(ready["applied"] as? Bool, false)
        let path = try XCTUnwrap(ready["path"] as? String), original = try Data(contentsOf: root.appendingPathComponent(path))
        let retained = parse(try await currentProject(b)); XCTAssertNotNil(object(retained["assets"])[path])
        let next = await b.currentVersion()
        let placed = parse(try await b.handleAssistant(method: "POST", path: "/api/audio/compose/place", body: JSON(any: ["path": path, "track": "A3", "start": 2, "comp": NSNull(), "expectedVersion": next]).text).text)
        XCTAssertEqual(placed["state"] as? String, "complete"); XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(path)), original)
        _ = try await b.handle(method: "POST", path: "/api/undo", body: "{}")
        let undone = parse(try await currentProject(b)); XCTAssertNotNil(object(undone["assets"])[path])
        await b.stop()
    }

    func testFreshAndExistingMusicDirectoriesRetainVerifiedMediaAndRetryWithoutRendering() async throws {
        for directoryState in ["absent", "media", "music-tree"] {
            let root = try Support.tempFolder("music-directory-\(directoryState)")
            let gate = MusicRetryDiagnosticGate()
            let b = try backend(root, renderer: { folder, score, script in
                do {
                    let rendered = try await gate.render(folder: folder, score: score, script: script)
                    print("Real music render completed: \(root.path); state=\(directoryState); output=\(rendered.path)")
                    return rendered
                } catch {
                    print("Real music renderer escaped error: \(root.path); state=\(directoryState); error=\(error)")
                    throw error
                }
            })
            var completed = false
            var ownedTask: Task<JSON, Error>?
            defer { if completed { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) } }
            do {
                let sentinel = root.appendingPathComponent("media/keep.txt")
                if directoryState != "absent" {
                    let directory = directoryState == "media" ? "media" : "media/generated/music"
                    try FileManager.default.createDirectory(at: root.appendingPathComponent(directory), withIntermediateDirectories: true)
                    try Data("User-owned file".utf8).write(to: sentinel)
                }
                try await b.start()
                _ = try await b.handle(method: "POST", path: "/api/new", body: #"{"name":"Directory retry"}"#)
                _ = try await b.editOperations(ops: .raw(#"[{"op":"add_title","track":"V3","dur":3,"title":{"text":"Keep editable title"}}]"#))
                let version = await b.currentVersion(), body = request(version: version)
                let task = Task {
                    do {
                        let response = try await b.handle(method: "POST", path: "/api/audio/compose", body: body)
                        await gate.requestFinished()
                        return response
                    } catch {
                        await gate.requestFinished()
                        throw error
                    }
                }
                ownedTask = task
                guard await gate.waitForRender() else {
                    _ = try await task.value
                    throw NativeMusicComposer.Failure(message: "Compose finished before entering the real renderer")
                }
                _ = try await b.editOperations(ops: .raw(#"[{"op":"project","set":{"name":"User edited"}}]"#))
                await gate.release()
                let ready = parse(try await task.value.text)
                ownedTask = nil
                XCTAssertEqual(ready["state"] as? String, "asset_ready", directoryState)
                XCTAssertEqual(ready["applied"] as? Bool, false, directoryState)
                let path = try XCTUnwrap(ready["path"] as? String)
                let bytes = try Data(contentsOf: root.appendingPathComponent(path))
                let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
                let retained = parse(try await currentProject(b))
                let asset = object(object(retained["assets"])[path])
                XCTAssertFalse(asset.isEmpty, directoryState)
                XCTAssertEqual(object(asset["generated"])["contentSHA256"] as? String, digest, directoryState)
                XCTAssertEqual(object(object(asset["generated"])["score"])["title"] as? String, "Original native QA cue")
                XCTAssertEqual(retained["name"] as? String, "User edited")
                let a3Before = try XCTUnwrap(values(retained["tracks"]).map(object).first { $0["id"] as? String == "A3" })
                XCTAssertTrue(values(a3Before["clips"]).isEmpty)
                let next = await b.currentVersion()
                let placed = parse(try await b.handleAssistant(method: "POST", path: "/api/audio/compose/place", body: JSON(any: ["path": path, "track": "A3", "start": 2, "comp": NSNull(), "expectedVersion": next]).text).text)
                XCTAssertEqual(placed["state"] as? String, "complete", directoryState)
                let final = parse(try await currentProject(b))
                let a3 = try XCTUnwrap(values(final["tracks"]).map(object).first { $0["id"] as? String == "A3" })
                let clips = values(a3["clips"]).map(object)
                XCTAssertEqual(clips.count, 1)
                XCTAssertEqual(clips.first?["src"] as? String, path)
                XCTAssertEqual(clips.first?["start"] as? Double, 2)
                XCTAssertEqual(clips.first?["dur"] as? Double, 1)
                let count = await gate.renderCount
                XCTAssertEqual(count, 1, "Retry must reuse verified bytes without a second score render")
                XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(path)), bytes)
                _ = try await b.handle(method: "POST", path: "/api/undo", body: "{}")
                let undone = parse(try await currentProject(b))
                XCTAssertEqual(undone as NSDictionary, retained as NSDictionary)
                XCTAssertNotNil(object(undone["assets"])[path])
                XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(path)), bytes)
                if directoryState != "absent" { XCTAssertEqual(try Data(contentsOf: sentinel), Data("User-owned file".utf8)) }
                await b.stop()
                completed = true
            } catch {
                if let task = ownedTask {
                    task.cancel()
                    await gate.release()
                    _ = try? await task.value
                }
                await b.stop()
                print("Retained owned music retry fixture: \(root.path); state=\(directoryState); error=\(error)")
                throw error
            }
        }
    }

    func testProjectReplacementAndCancellationCannotRegisterMusicInAnotherProject() async throws {
        let root = try Support.tempFolder("music-replaced"), gate = MusicRenderGate()
        defer { try? FileManager.default.removeItem(at: root) }
        let b = try backend(root, renderer: { folder, score, script in try await gate.render(folder: folder, score: score, script: script) }); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: #"{"name":"Original"}"#)
        let version = await b.currentVersion(), body = request(version: version)
        let task = Task { try await b.handle(method: "POST", path: "/api/audio/compose", body: body) }
        await gate.waitForRender()
        _ = try await b.handle(method: "POST", path: "/api/new", body: #"{"name":"Replacement"}"#)
        await gate.release()
        do { _ = try await task.value; XCTFail("registered into replacement") } catch { XCTAssertTrue(error.localizedDescription.contains("replaced")) }
        let replacement = parse(try await currentProject(b)); XCTAssertEqual(replacement["name"] as? String, "Replacement"); XCTAssertTrue(object(replacement["assets"]).isEmpty)
        await b.stop()
        let c = try backend(root, renderer: { _, _, _ in throw CancellationError() }); try await c.start()
        let current = await c.currentVersion(), before = await c.currentProject()
        do { _ = try await c.handle(method: "POST", path: "/api/audio/compose", body: request(version: current)); XCTFail("cancel returned success") } catch { XCTAssertTrue(error is CancellationError) }
        let after = await c.currentProject(); XCTAssertEqual(after, before)
        await c.stop()
    }

    func testAdmissionRejectsInvalidScoreAndWrongTrackWithoutHistoryOrFiles() async throws {
        let root = try Support.tempFolder("music-noop")
        defer { try? FileManager.default.removeItem(at: root) }
        let b = try backend(root); try await b.start(); _ = try await b.handle(method: "POST", path: "/api/new", body: #"{"name":"Untouched"}"#)
        let before = await b.currentProject(), v = await b.currentVersion()
        for bad in [request(version: v, track: "V1"), JSON(any: ["score": ["version": 1], "track": "A3", "start": 0, "expectedVersion": v]).text] {
            do { _ = try await b.handle(method: "POST", path: "/api/audio/compose", body: bad); XCTFail("accepted invalid request") } catch {}
        }
        let after = await b.currentProject(), afterVersion = await b.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(afterVersion, v)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("media/generated/music").path))
        await b.stop()
    }
    func testOccupiedAudioGapIsRejectedBeforeRenderingAndPreservesOriginalClip() async throws {
        let root = try Support.tempFolder("music-overlap")
        defer { try? FileManager.default.removeItem(at: root) }
        let b = try backend(root); try await b.start()
        _ = try await b.copyIn([Support.fixture("tone.m4a")])
        _ = try await b.editOperations(ops: .raw(#"[{"op":"add_clip","kind":"audio","src":"media/tone.m4a","track":"A3","start":0,"dur":1}]"#))
        let version = await b.currentVersion(), before = await b.currentProject()
        do { _ = try await b.handle(method: "POST", path: "/api/audio/compose", body: request(version: version, start: 0.5)); XCTFail("overwrote occupied audio") }
        catch { XCTAssertTrue(error.localizedDescription.contains("overlaps")) }
        let after = await b.currentProject(), afterVersion = await b.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(afterVersion, version)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("media/generated/music").path))
        await b.stop()
    }
}
