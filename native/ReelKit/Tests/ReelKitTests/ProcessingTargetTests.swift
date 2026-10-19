import Foundation
@testable import ReelKit
import XCTest

final class ProcessingTargetTests: XCTestCase {
    private func backend(duplicate: Bool = true, video: Bool = false, probe: ReelBackend.MediaProber? = nil) async throws -> ReelBackend {
        let root = try Support.tempFolder("processing-targets"), folder = ProjectFolder(root: root)
        try FileManager.default.createDirectory(at: folder.mediaDir, withIntermediateDirectories: true)
        let samples = (0..<12000).map { Float(0.1 * sin(2 * .pi * 500 * Double($0) / 48000)) }
        try NativeAudioProcessing.write(.init(channels: [samples, samples]), to: folder.mediaDir.appendingPathComponent("tone.wav"))
        try FileManager.default.copyItem(at: folder.mediaDir.appendingPathComponent("tone.wav"), to: folder.mediaDir.appendingPathComponent("other.wav"))
        if video { try FileManager.default.copyItem(at: Support.fixture("clip.mp4"), to: folder.mediaDir.appendingPathComponent("clip.mp4")) }
        let core = try ReelCore(scriptURL: Support.core())
        var project = parse(try core.newProject(name: "Scoped processing"))
        var assets: [String: Any] = ["media/tone.wav": ["duration": 0.25, "hasAudio": true, "hasVideo": false], "media/other.wav": ["duration": 0.25, "hasAudio": true, "hasVideo": false]]
        if video { assets["media/clip.mp4"] = try JSON.parse(await MediaProbe.probe(folder.mediaDir.appendingPathComponent("clip.mp4")).text) }
        project["assets"] = assets
        let kind = video ? "video" : "audio", trackID = video ? "V1" : "A1"
        let clip: [String: Any] = ["id": "same", "kind": kind, "src": video ? "media/clip.mp4" : "media/tone.wav", "in": 0, "start": 0, "dur": 0.25]
        project["tracks"] = [["id": trackID, "kind": kind, "clips": [clip]]]
        project["comps"] = ["nested": ["name": "Nested", "width": 640, "height": 480, "fps": 24, "tracks": [["id": trackID, "kind": kind, "clips": duplicate ? [clip] : []]]]]
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), probe: probe) { _, _ in }
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: "{}")
        _ = try await backend.editOperations(ops: .array([JSON(any: ["op": "replace", "project": project])]))
        return backend
    }

    private func clip(_ text: String, comp: String?) -> [String: Any] {
        let project = parse(text), scope = comp.map { object(object(project["comps"])[ $0 ]) } ?? project
        return (scope["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }.first { $0["id"] as? String == "same" } ?? [:]
    }

    func testCleanupHonorsNestedScopeWithReusedClipIDAndExactUndo() async throws {
        let backend = try await backend()
        let beforeSnapshot = await backend.currentProject(), before = try XCTUnwrap(beforeSnapshot)
        let result = parse(try await backend.handle(method: "POST", path: "/api/audio/clean", body: #"{"src":"media/tone.wav","id":"same","comp":"nested"}"#).text)
        let afterSnapshot = await backend.currentProject(), after = try XCTUnwrap(afterSnapshot)
        XCTAssertEqual(clip(after, comp: nil)["src"] as? String, "media/tone.wav")
        XCTAssertEqual(clip(after, comp: "nested")["src"] as? String, result["path"] as? String)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let admission = await backend.currentProject()
        XCTAssertNotNil(object(parse(try XCTUnwrap(admission))["assets"])[result["path"] as? String ?? ""])
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let restored = await backend.currentProject()
        XCTAssertEqual(restored, before)
        await backend.stop()
    }

    func testCleanupRecipeRetainsProfileRerendersOriginalAndRestoresWithExactUndo() async throws {
        let backend = try await backend(), source = "media/tone.wav"
        let initial = await backend.currentProject(), original = try XCTUnwrap(initial)
        let first = parse(try await backend.handle(method: "POST", path: "/api/audio/clean", body: JSON(any: ["src": source, "id": "same", "comp": "nested", "mode": "voice", "strength": 0, "detail": 0.9, "quality": "high", "noiseFrom": 0.01, "noiseTo": 0.2]).text).text)
        let firstPath = try XCTUnwrap(first["path"] as? String), firstRecipe = object(first["recipe"])
        XCTAssertEqual(first["engine"] as? String, "accelerate-spectral-cpu")
        XCTAssertEqual(first["intermediate"] as? String, "float32-wav")
        XCTAssertEqual(firstRecipe["source"] as? String, source)
        XCTAssertEqual(object(firstRecipe["settings"])["noiseFrom"] as? Double, 0.01)
        XCTAssertEqual(object(firstRecipe["settings"])["noiseTo"] as? Double, 0.2)
        let firstProject = await backend.currentProject(), firstSnapshot = try XCTUnwrap(firstProject)
        XCTAssertEqual(JSON(any: clip(firstSnapshot, comp: "nested")["audioCleanup"]).text, JSON(any: firstRecipe).text)
        let second = parse(try await backend.handle(method: "POST", path: "/api/audio/clean", body: JSON(any: ["src": firstPath, "id": "same", "comp": "nested", "useOriginal": true, "strength": 0]).text).text)
        let secondPath = try XCTUnwrap(second["path"] as? String)
        XCTAssertEqual(object(second["recipe"])["source"] as? String, source)
        XCTAssertNil(object(object(second["recipe"])["settings"])["noiseFrom"])
        let secondProject = await backend.currentProject(), secondSnapshot = try XCTUnwrap(secondProject), applied = clip(secondSnapshot, comp: "nested")
        XCTAssertNil(object(object(applied["audioCleanup"])["settings"])["noiseTo"])
        for key in ["in", "start", "dur"] { XCTAssertEqual(JSON(any: applied[key]).text, JSON(any: clip(original, comp: "nested")[key]).text) }
        XCTAssertEqual(clip(secondSnapshot, comp: nil)["src"] as? String, source)
        let restoreVersion = await backend.currentVersion()
        let restored = parse(try await backend.handle(method: "POST", path: "/api/audio/restore", body: JSON(any: ["id": "same", "comp": "nested", "src": secondPath, "expectedVersion": restoreVersion]).text).text)
        XCTAssertEqual(restored["applied"] as? Bool, true); XCTAssertEqual(restored["restored"] as? Bool, true)
        let restoredProject = await backend.currentProject(), restoredSnapshot = try XCTUnwrap(restoredProject)
        XCTAssertEqual(clip(restoredSnapshot, comp: "nested")["src"] as? String, source)
        XCTAssertNil(clip(restoredSnapshot, comp: "nested")["audioCleanup"])
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let undoProject = await backend.currentProject(); XCTAssertEqual(undoProject, secondSnapshot)
        _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}")
        let redoProject = await backend.currentProject(); XCTAssertEqual(redoProject, restoredSnapshot)
        await backend.stop()
    }

    func testMissingOriginalRejectsQueuedCleanupAndRestoreWithoutLosingRecipe() async throws {
        let backend = try await backend()
        _ = try await backend.handle(method: "POST", path: "/api/audio/clean", body: #"{"id":"same","comp":"nested","strength":0}"#)
        let snapshot = await backend.currentProject()
        var project = parse(try XCTUnwrap(snapshot)), assets = object(project["assets"])
        assets.removeValue(forKey: "media/tone.wav"); project["assets"] = assets
        _ = try await backend.editOperations(ops: .array([JSON(any: ["op": "replace", "project": project])]))
        let before = await backend.currentProject(), version = await backend.currentVersion()
        let files = try FileManager.default.contentsOfDirectory(atPath: backend.folder.mediaDir.appendingPathComponent("cleaned").path)
        for route in ["/api/audio/clean", "/api/audio/restore"] {
            do { _ = try await backend.handle(method: "POST", path: route, body: #"{"id":"same","comp":"nested","wait":false}"#); XCTFail("Unavailable original accepted") }
            catch { XCTAssertTrue(error.localizedDescription.contains("original audio asset"), error.localizedDescription) }
        }
        let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(nextVersion, version)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: backend.folder.mediaDir.appendingPathComponent("cleaned").path), files)
        await backend.stop()
    }

    func testStrictCleanupAdmissionRejectsBeforeJobOrOutputCreation() async throws {
        let backend = try await backend(), before = await backend.currentProject(), version = await backend.currentVersion()
        for route in ["/api/audio/clean", "/api/audio/denoise", "/api/audio/restore"] {
            for invalid: [String: Any] in [["wait": 0], ["apply": 1], ["strength": true], ["detail": "0.5"], ["comp": false], ["expectedVersion": pow(2.0, Double(63))]] {
                var body = invalid; body["id"] = "same"
                if body["comp"] == nil { body["comp"] = "nested" }
                do { _ = try await backend.handle(method: "POST", path: route, body: JSON(any: body).text); XCTFail("Coerced \(invalid)") }
                catch { XCTAssertTrue(error.localizedDescription.contains("must be"), error.localizedDescription) }
            }
        }
        let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(nextVersion, version)
        XCTAssertFalse(FileManager.default.fileExists(atPath: backend.folder.mediaDir.appendingPathComponent("cleaned").path))
        await backend.stop()
    }

    func testRepeatedCleanupCapturesBothOriginalAndCurrentSourceAndRecipe() async throws {
        for change in ["original", "current", "recipe"] {
            let gate = ProcessingProbeGate(skips: 1)
            let backend = try await backend(probe: { url in
                let metadata = try await MediaProbe.probe(url)
                if url.lastPathComponent.hasPrefix("clean-") { await gate.suspend() }
                return metadata
            })
            let first = parse(try await backend.handle(method: "POST", path: "/api/audio/clean", body: #"{"id":"same","comp":"nested","strength":0}"#).text)
            let current = try XCTUnwrap(first["path"] as? String)
            let task = Task { try await backend.handle(method: "POST", path: "/api/audio/clean", body: JSON(any: ["id": "same", "comp": "nested", "src": current, "strength": 0, "useOriginal": true]).text) }
            await gate.wait()
            if change == "recipe" {
                _ = try await backend.editOperations(ops: .array([JSON(any: ["op": "update", "id": "same", "comp": "nested", "set": ["audioCleanup": ["settings": ["detail": 0.1]]]])]))
            } else {
                let file = try backend.folder.resolve(change == "original" ? "media/tone.wav" : current)
                var data = try Data(contentsOf: file); data.append(0); try data.write(to: file, options: .atomic)
            }
            let before = await backend.currentProject(), version = await backend.currentVersion()
            await gate.resume()
            if change == "original" || change == "current" {
                do { _ = try await task.value; XCTFail("Changed captured source admitted") }
                catch { XCTAssertTrue(error.localizedDescription.contains(change == "original" ? "cleanup input source changed" : "source changed during processing"), error.localizedDescription) }
                let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
                XCTAssertEqual(after, before); XCTAssertEqual(nextVersion, version)
            } else {
                let result = parse(try await task.value.text)
                XCTAssertEqual(result["applied"] as? Bool, false); XCTAssertNotNil(result["applyError"])
                let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
                try assertCleanupAdmissionOnly(result, before: before, after: after, version: version, nextVersion: nextVersion)
                XCTAssertEqual(clip(try XCTUnwrap(after), comp: "nested")["src"] as? String, current)
            }
            await backend.stop()
        }
    }

    func testHostedSourceOnlyCleanupAdmitsEditableNativeRecipeWithoutPlacement() async throws {
        let backend = try await backend(), before = await backend.currentProject(), version = await backend.currentVersion()
        let result = parse(try await backend.handle(method: "POST", path: "/api/audio/clean", body: #"{"src":"media/tone.wav","mode":"denoise","strength":0,"noiseFrom":0.01,"noiseTo":0.2}"#).text)
        XCTAssertEqual(result["engine"] as? String, "accelerate-spectral-cpu")
        XCTAssertEqual(object(result["recipe"])["source"] as? String, "media/tone.wav")
        XCTAssertEqual(object(result["settings"])["noiseTo"] as? Double, 0.2)
        XCTAssertNil(result["processingTarget"]); XCTAssertNil(result["applied"]); XCTAssertEqual(result["placementRequested"] as? Bool, false)
        let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
        try assertCleanupAdmissionOnly(result, before: before, after: after, version: version, nextVersion: nextVersion)
        await backend.stop()
    }

    private func assertCleanupAdmissionOnly(_ result: [String: Any], before: String?, after: String?, version: Int, nextVersion: Int) throws {
        XCTAssertEqual(result["assetRegistered"] as? Bool, true)
        XCTAssertEqual(nextVersion, version + 1)
        let path = try XCTUnwrap(result["path"] as? String), asset = object(result["asset"])
        var expected = parse(try XCTUnwrap(before)), assets = object(expected["assets"])
        assets[path] = asset; expected["assets"] = assets
        XCTAssertEqual(JSON(any: parse(try XCTUnwrap(after))).text, JSON(any: expected).text)
        XCTAssertEqual(object(asset["processing"])["source"] as? String, object(result["recipe"])["source"] as? String)
        XCTAssertEqual(object(asset["processing"])["engine"] as? String, "accelerate-spectral-cpu")
    }

    func testCleanupRejectsInvalidOutputProbeBeforeMediaAdmission() async throws {
        for measured: [String: Any] in [["duration": 0.25, "hasAudio": false], ["duration": 0, "hasAudio": true], ["duration": -1, "hasAudio": true], ["duration": "0.25", "hasAudio": true], ["duration": true, "hasAudio": true], ["duration": 0.25, "hasAudio": 1]] {
            let probeResult = JSON(any: measured)
            let backend = try await backend(probe: { url in
                if url.lastPathComponent.hasPrefix("clean-") { return probeResult }
                return try await MediaProbe.probe(url)
            })
            let before = await backend.currentProject(), version = await backend.currentVersion()
            do { _ = try await backend.handle(method: "POST", path: "/api/audio/clean", body: #"{"src":"media/tone.wav","strength":0}"#); XCTFail("accepted invalid output metadata") }
            catch { XCTAssertTrue(error.localizedDescription.contains("no valid audio duration")) }
            let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
            XCTAssertEqual(after, before); XCTAssertEqual(nextVersion, version)
            await backend.stop()
        }
    }

    func testCleanupRejectsPositiveTruncatedOrExtendedOutputBeforeMoveAndAdmission() async throws {
        for duration in [0.1, 0.5] {
            let probeResult = JSON(any: ["duration": duration, "hasAudio": true])
            let backend = try await backend(probe: { url in
                if url.lastPathComponent.hasPrefix("clean-") { return probeResult }
                return try await MediaProbe.probe(url)
            })
            let before = await backend.currentProject(), version = await backend.currentVersion()
            do { _ = try await backend.handle(method: "POST", path: "/api/audio/clean", body: #"{"src":"media/tone.wav","id":"same","comp":"nested","strength":0}"#); XCTFail("accepted incomplete output duration") }
            catch { XCTAssertTrue(error.localizedDescription.contains("duration does not match the complete source")) }
            let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
            XCTAssertEqual(after, before); XCTAssertEqual(nextVersion, version)
            await backend.stop()
        }
    }

    func testCleanupApplyFalseWithNestedTargetAdmitsMediaWithoutPlacement() async throws {
        let backend = try await backend(), before = await backend.currentProject(), version = await backend.currentVersion()
        let result = parse(try await backend.handle(method: "POST", path: "/api/audio/clean", body: #"{"src":"media/tone.wav","id":"same","comp":"nested","apply":false,"strength":0}"#).text)
        XCTAssertNil(result["applied"]); XCTAssertNil(result["processingTarget"])
        XCTAssertEqual(result["placementRequested"] as? Bool, false)
        let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
        try assertCleanupAdmissionOnly(result, before: before, after: after, version: version, nextVersion: nextVersion)
        await backend.stop()
    }

    func testCleanupPlacementUndoRetainsReusableMediaAndAdmissionUndoRemovesIt() async throws {
        let backend = try await backend(), initial = await backend.currentProject(), version = await backend.currentVersion()
        let result = parse(try await backend.handle(method: "POST", path: "/api/audio/clean", body: #"{"id":"same","comp":"nested","strength":0}"#).text)
        let path = try XCTUnwrap(result["path"] as? String), nextVersion = await backend.currentVersion()
        XCTAssertEqual(nextVersion, version + 2); XCTAssertEqual(result["assetRegistered"] as? Bool, true)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let undo = await backend.currentProject()
        XCTAssertEqual(clip(try XCTUnwrap(undo), comp: "nested")["src"] as? String, "media/tone.wav")
        XCTAssertNotNil(object(parse(try XCTUnwrap(undo))["assets"])[path])
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let unregistered = await backend.currentProject(); XCTAssertEqual(unregistered, initial)
        _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}")
        _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}")
        let restored = await backend.currentProject(); XCTAssertEqual(clip(try XCTUnwrap(restored), comp: "nested")["src"] as? String, path)
        await backend.stop()
    }

    func testMainScopeAndLegacyUniqueIDNormalizationAreUndoable() async throws {
        for duplicate in [true, false] {
            let backend = try await backend(duplicate: duplicate)
            let snapshot = await backend.currentProject(), before = try XCTUnwrap(snapshot), version = await backend.currentVersion()
            var body: [String: Any] = ["src": "media/tone.wav", "id": "same", "target": -23]
            if duplicate { body["comp"] = NSNull() }
            let result = parse(try await backend.handle(method: "POST", path: "/api/audio/loudnorm", body: JSON(any: body).text).text)
            let afterSnapshot = await backend.currentProject(), after = try XCTUnwrap(afterSnapshot), nextVersion = await backend.currentVersion()
            XCTAssertEqual(result["applied"] as? Bool, true)
            XCTAssertEqual(result["target"] as? Double, -23)
            XCTAssertEqual(clip(after, comp: nil)["volume"] as? Double, result["gain"] as? Double)
            XCTAssertNil(clip(after, comp: "nested")["volume"])
            XCTAssertEqual(nextVersion, version + 1)
            _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
            let restored = await backend.currentProject()
            XCTAssertEqual(restored, before)
            await backend.stop()
        }
    }

    func testLegacyUniqueNestedIDKeepsItsCompositionAndExactUndo() async throws {
        let backend = try await backend(duplicate: false), initial = await backend.currentProject()
        var project = parse(try XCTUnwrap(initial)), tracks = project["tracks"] as! [[String: Any]], comps = object(project["comps"])
        var nested = object(comps["nested"]), nestedTracks = nested["tracks"] as! [[String: Any]]
        nestedTracks[0]["clips"] = tracks[0]["clips"]; tracks[0]["clips"] = []
        nested["tracks"] = nestedTracks; comps["nested"] = nested; project["tracks"] = tracks; project["comps"] = comps
        _ = try await backend.editOperations(ops: .array([JSON(any: ["op": "replace", "project": project])]))
        let before = await backend.currentProject()
        let result = parse(try await backend.handle(method: "POST", path: "/api/audio/clean", body: #"{"src":"media/tone.wav","id":"same"}"#).text)
        XCTAssertEqual(object(result["processingTarget"])["comp"] as? String, "nested")
        let snapshot = await backend.currentProject(), after = try XCTUnwrap(snapshot)
        XCTAssertEqual(clip(after, comp: "nested")["src"] as? String, result["path"] as? String)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let admission = await backend.currentProject()
        XCTAssertNotNil(object(parse(try XCTUnwrap(admission))["assets"])[result["path"] as? String ?? ""])
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let restored = await backend.currentProject(); XCTAssertEqual(restored, before)
        await backend.stop()
    }

    func testAmbiguousIDUnknownScopeAndWrongScopeRejectBeforeProcessing() async throws {
        let backend = try await backend(), before = await backend.currentProject(), version = await backend.currentVersion()
        let bodies: [[String: Any]] = [
            ["src": "media/tone.wav", "id": "same"],
            ["src": "media/tone.wav", "id": "same", "comp": "missing"],
            ["src": "media/tone.wav", "id": "absent", "comp": "nested"],
            ["src": "media/other.wav", "id": "same", "comp": "nested"],
        ]
        for route in ["/api/audio/clean", "/api/audio/loudnorm", "/api/analysis/track", "/api/retime"] {
            for var body in bodies {
                body["apply"] = true
                do { _ = try await backend.handle(method: "POST", path: route, body: JSON(any: body).text); XCTFail("accepted \(route) \(body)") }
                catch { XCTAssertTrue(["ambiguous", "no composition", "no clip", "does not match", "valid processing range", "Vision framing needs"].contains { error.localizedDescription.localizedCaseInsensitiveContains($0) }, error.localizedDescription) }
            }
        }
        let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(nextVersion, version)
        XCTAssertFalse(FileManager.default.fileExists(atPath: backend.folder.mediaDir.appendingPathComponent("cleaned").path))
        await backend.stop()
    }

    func testSuspendedCleanupRejectsClipScopeProjectAndSourceDriftButKeepsOutput() async throws {
        let changes: [[String: Any]] = [["src": "media/other.wav"], ["in": 0.05], ["dur": 0.2], ["speed": 2], ["reverse": true], ["freeze": 0.1], ["timeMap": [["t": 0, "source": 0]]], ["volume": -6]]
        for index in 0..<(changes.count + 3) {
            let gate = ProcessingProbeGate()
            let backend = try await backend(probe: { url in
                let metadata = try await MediaProbe.probe(url)
                if url.lastPathComponent.hasPrefix("clean-") { await gate.suspend() }
                return metadata
            })
            let initial = await backend.currentProject(), original = try XCTUnwrap(initial)
            let task = Task { try await backend.handle(method: "POST", path: "/api/audio/clean", body: #"{"src":"media/tone.wav","id":"same","comp":"nested","wait":true}"#) }
            await gate.wait()
            if index < changes.count {
                _ = try await backend.editOperations(ops: .array([JSON(any: ["op": "update", "id": "same", "comp": "nested", "set": changes[index]])]))
            } else if index == changes.count {
                var project = parse(original), comps = object(project["comps"])
                comps["moved"] = comps.removeValue(forKey: "nested"); project["comps"] = comps
                _ = try await backend.editOperations(ops: .array([JSON(any: ["op": "replace", "project": project])]))
            } else if index == changes.count + 1 {
                _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"name":"Replacement"}"#)
            } else {
                let file = backend.folder.mediaDir.appendingPathComponent("tone.wav")
                var data = try Data(contentsOf: file); data.append(0)
                try data.write(to: file, options: .atomic)
            }
            let before = await backend.currentProject(), version = await backend.currentVersion()
            await gate.resume()
            if index >= changes.count {
                do { _ = try await task.value; XCTFail("Replacement project accepted cleanup output") }
                catch { XCTAssertTrue(error.localizedDescription.contains(index == changes.count + 2 ? "cleanup input source changed" : index == changes.count ? "No composition" : "project was replaced"), error.localizedDescription) }
                let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
                XCTAssertEqual(after, before); XCTAssertEqual(nextVersion, version)
            } else {
                let result = parse(try await task.value.text), after = await backend.currentProject(), nextVersion = await backend.currentVersion()
                XCTAssertEqual(result["applied"] as? Bool, false, "case \(index)")
                XCTAssertNotNil(result["applyError"], "case \(index)")
                XCTAssertTrue(FileManager.default.fileExists(atPath: try backend.folder.resolve(XCTUnwrap(result["path"] as? String)).path))
                try assertCleanupAdmissionOnly(result, before: before, after: after, version: version, nextVersion: nextVersion)
            }
            await backend.stop()
        }
    }

    func testCancelledCleanupJobCannotPublishOrApplyAfterProbe() async throws {
        let gate = ProcessingProbeGate()
        let backend = try await backend(probe: { url in
            let metadata = try await MediaProbe.probe(url)
            if url.lastPathComponent.hasPrefix("clean-") { await gate.suspend() }
            return metadata
        })
        let before = await backend.currentProject(), version = await backend.currentVersion()
        let job = parse(try await backend.handle(method: "POST", path: "/api/audio/clean", body: #"{"src":"media/tone.wav","id":"same","comp":"nested","wait":false}"#).text)
        await gate.wait()
        _ = try await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": job["id"]!]).text)
        await gate.resume()
        let result = parse(try await backend.handle(method: "GET", path: "/api/jobs/wait?id=\(job["id"] as! String)&timeout=5000", body: nil).text)
        XCTAssertEqual(result["state"] as? String, "failed"); XCTAssertEqual(result["error"] as? String, "cancelled")
        let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(nextVersion, version)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: backend.folder.mediaDir.appendingPathComponent("cleaned").path).isEmpty)
        await backend.stop()
    }

    func testCleanupJobRetainsSavedOutputAndApplyErrorAfterProjectEdit() async throws {
        let gate = ProcessingProbeGate()
        let backend = try await backend(probe: { url in
            let metadata = try await MediaProbe.probe(url)
            if url.lastPathComponent.hasPrefix("clean-") { await gate.suspend() }
            return metadata
        })
        let job = parse(try await backend.handle(method: "POST", path: "/api/audio/clean", body: #"{"src":"media/tone.wav","id":"same","comp":"nested","wait":false}"#).text)
        await gate.wait()
        _ = try await backend.editOperations(ops: .array([JSON(any: ["op": "project", "set": ["name": "Edited during cleanup"]])]))
        let before = await backend.currentProject(), version = await backend.currentVersion()
        await gate.resume()
        let result = parse(try await backend.handle(method: "GET", path: "/api/jobs/wait?id=\(job["id"] as! String)&timeout=5000", body: nil).text)
        XCTAssertEqual(result["state"] as? String, "done"); XCTAssertEqual(result["applied"] as? Bool, false)
        XCTAssertNotNil(result["applyError"])
        XCTAssertEqual(object(result["result"])["path"] as? String, result["output"] as? String)
        XCTAssertEqual(object(result["processingTarget"])["comp"] as? String, "nested")
        let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
        try assertCleanupAdmissionOnly(object(result["result"]), before: before, after: after, version: version, nextVersion: nextVersion)
        await backend.stop()
    }

    func testCancelledRenderCannotPublishOrApplyAfterProbe() async throws {
        let gate = ProcessingProbeGate()
        let backend = try await backend(video: true, probe: { url in
            let metadata = try await MediaProbe.probe(url)
            if url.deletingLastPathComponent().lastPathComponent == "processing" { await gate.suspend() }
            return metadata
        })
        let before = await backend.currentProject(), version = await backend.currentVersion()
        let job = parse(try await backend.handle(method: "POST", path: "/api/retime", body: #"{"src":"media/clip.mp4","id":"same","comp":"nested","in":0,"dur":0.25,"speed":0.5,"fps":8}"#).text)
        await gate.wait()
        _ = try await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": job["id"]!]).text)
        await gate.resume()
        let result = parse(try await backend.handle(method: "GET", path: "/api/jobs/wait?id=\(job["id"] as! String)&timeout=5000", body: nil).text)
        XCTAssertEqual(result["state"] as? String, "failed"); XCTAssertEqual(result["error"] as? String, "cancelled")
        XCTAssertNil(result["output"])
        let after = await backend.currentProject(), nextVersion = await backend.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(nextVersion, version)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: backend.folder.mediaDir.appendingPathComponent("retimed").path).isEmpty)
        await backend.stop()
    }

    func testRetimeUsesCapturedNestedScopeAndPlacementUndoKeepsReusableMedia() async throws {
        let backend = try await backend(video: true), initial = await backend.currentProject(), before = try XCTUnwrap(initial), version = await backend.currentVersion()
        let result = parse(try await backend.handle(method: "POST", path: "/api/retime", body: #"{"src":"media/clip.mp4","id":"same","comp":"nested","in":0,"dur":0.25,"speed":0.5,"fps":8,"wait":true}"#).text)
        XCTAssertEqual(result["state"] as? String, "done", result.description)
        XCTAssertEqual(result["applied"] as? Bool, true, result.description)
        let snapshot = await backend.currentProject(), after = try XCTUnwrap(snapshot), nextVersion = await backend.currentVersion()
        XCTAssertEqual(clip(after, comp: nil)["src"] as? String, "media/clip.mp4")
        XCTAssertEqual(clip(after, comp: nil)["dur"] as? Double, 0.25)
        XCTAssertEqual(clip(after, comp: "nested")["src"] as? String, result["output"] as? String)
        XCTAssertEqual(clip(after, comp: "nested")["dur"] as? Double ?? 0, 0.5, accuracy: 0.001)
        XCTAssertEqual(result["assetRegistered"] as? Bool, true)
        let output = try XCTUnwrap(result["output"] as? String)
        XCTAssertNotNil(object(parse(after)["assets"])[output])
        XCTAssertEqual(nextVersion, version + 2) // One Media registration, one scoped placement.
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let restoredSnapshot = await backend.currentProject(), restored = try XCTUnwrap(restoredSnapshot)
        var restoredFields = parse(restored), beforeFields = parse(before)
        let restoredAssets = object(restoredFields.removeValue(forKey: "assets"))
        let beforeAssets = object(beforeFields.removeValue(forKey: "assets"))
        XCTAssertEqual(restoredFields as NSDictionary, beforeFields as NSDictionary)
        XCTAssertEqual(restoredAssets.count, beforeAssets.count + 1)
        XCTAssertNotNil(restoredAssets[output])
        for (path, metadata) in beforeAssets {
            XCTAssertEqual(object(restoredAssets[path]) as NSDictionary, object(metadata) as NSDictionary)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: try backend.folder.resolve(output).path))
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let original = await backend.currentProject()
        XCTAssertEqual(original, before)
        await backend.stop()
    }

    func testRenderedJobExposesSavedUnappliedOutputAfterTrimChange() async throws {
        let gate = ProcessingProbeGate()
        let backend = try await backend(video: true, probe: { url in
            let metadata = try await MediaProbe.probe(url)
            if url.deletingLastPathComponent().lastPathComponent == "processing" { await gate.suspend() }
            return metadata
        })
        let job = parse(try await backend.handle(method: "POST", path: "/api/retime", body: #"{"src":"media/clip.mp4","id":"same","comp":"nested","in":0,"dur":0.25,"speed":0.5,"fps":8}"#).text)
        await gate.wait()
        _ = try await backend.editOperations(ops: .array([JSON(any: ["op": "update", "id": "same", "comp": "nested", "set": ["in": 0.1]])]))
        let before = await backend.currentProject(), version = await backend.currentVersion()
        await gate.resume()
        let result = parse(try await backend.handle(method: "GET", path: "/api/jobs/wait?id=\(job["id"] as! String)&timeout=5000", body: nil).text)
        XCTAssertEqual(result["state"] as? String, "done"); XCTAssertEqual(result["applied"] as? Bool, false)
        XCTAssertNotNil(result["applyError"]); XCTAssertNotNil(result["measurements"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: try backend.folder.resolve(XCTUnwrap(result["output"] as? String)).path))
        let afterSnapshot = await backend.currentProject(), after = try XCTUnwrap(afterSnapshot), nextVersion = await backend.currentVersion()
        var afterFields = parse(after), beforeFields = parse(try XCTUnwrap(before))
        let afterAssets = object(afterFields.removeValue(forKey: "assets"))
        let beforeAssets = object(beforeFields.removeValue(forKey: "assets"))
        XCTAssertEqual(afterFields as NSDictionary, beforeFields as NSDictionary)
        XCTAssertEqual(nextVersion, version + 1)
        XCTAssertEqual(result["assetRegistered"] as? Bool, true)
        XCTAssertEqual(afterAssets.count, beforeAssets.count + 1)
        XCTAssertNotNil(afterAssets[try XCTUnwrap(result["output"] as? String)])
        for (path, metadata) in beforeAssets {
            XCTAssertEqual(object(afterAssets[path]) as NSDictionary, object(metadata) as NSDictionary)
        }
        await backend.stop()
    }

    func testVisionUsesNestedCanvasAndScopedKeysWithOneUndo() async throws {
        let backend = try await backend(video: true), initial = await backend.currentProject(), before = try XCTUnwrap(initial)
        let result = parse(try await backend.handle(method: "POST", path: "/api/analysis/autoreframe", body: #"{"src":"media/clip.mp4","id":"same","comp":"nested","apply":true,"in":0,"dur":0.25,"fps":4}"#).text)
        XCTAssertEqual(result["width"] as? Double, 640); XCTAssertEqual(result["height"] as? Double, 480)
        XCTAssertEqual(result["applied"] as? Bool, true, result.description)
        let snapshot = await backend.currentProject(), after = try XCTUnwrap(snapshot)
        XCTAssertNil(clip(after, comp: nil)["anim"])
        XCTAssertFalse(object(clip(after, comp: "nested")["anim"]).isEmpty)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let restored = await backend.currentProject()
        XCTAssertEqual(restored, before)
        await backend.stop()
    }

    func testRenderApplicationRejectsUnsupportedMappingsAndPartialRanges() async throws {
        for change: [String: Any] in [["reverse": true], ["freeze": 0.1], ["timeMap": [["t": 0, "source": 0]]], ["speed": -1]] {
            let backend = try await backend(video: true)
            _ = try await backend.editOperations(ops: .array([JSON(any: ["op": "update", "id": "same", "comp": "nested", "set": change])]))
            let before = await backend.currentProject()
            do { _ = try await backend.handle(method: "POST", path: "/api/retime", body: #"{"src":"media/clip.mp4","id":"same","comp":"nested","in":0,"dur":0.25}"#); XCTFail("accepted unsupported mapping") }
            catch { XCTAssertTrue(error.localizedDescription.contains("forward video clip")) }
            let after = await backend.currentProject(); XCTAssertEqual(after, before)
            await backend.stop()
        }
        let backend = try await backend(video: true)
        do { _ = try await backend.handle(method: "POST", path: "/api/retime", body: #"{"src":"media/clip.mp4","id":"same","comp":"nested","in":0.1,"dur":0.1}"#); XCTFail("accepted partial replacement") }
        catch { XCTAssertTrue(error.localizedDescription.contains("complete source range")) }
        do { _ = try await backend.handle(method: "POST", path: "/api/retime", body: #"{"src":"media/clip.mp4","id":"same","comp":"nested","in":0,"dur":0.25,"speed":0.01}"#); XCTFail("accepted output speed below the shared timeline minimum") }
        catch { XCTAssertTrue(error.localizedDescription.contains("at least 0.05")) }
        await backend.stop()
    }
}

private actor ProcessingProbeGate {
    private var skips: Int
    init(skips: Int = 0) { self.skips = skips }
    private var reached = false
    private var waiter: CheckedContinuation<Void, Never>?
    private var release: CheckedContinuation<Void, Never>?
    func suspend() async {
        if skips > 0 { skips -= 1; return }
        reached = true; waiter?.resume(); waiter = nil
        await withCheckedContinuation { release = $0 }
    }
    func wait() async {
        if reached { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func resume() { release?.resume(); release = nil }
}
