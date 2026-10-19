import CryptoKit
import Foundation
@testable import ReelKit
import XCTest

final class BackendTests: XCTestCase {
    var root: URL!
    var events: EventLog!
    var backend: ReelBackend!

    override func setUp() async throws {
        root = try Support.tempFolder()
        try FileManager.default.createDirectory(at: root.appendingPathComponent("media"), withIntermediateDirectories: true)
        for name in ["clip.mp4", "tone.m4a", "still.png"] {
            try FileManager.default.copyItem(at: Support.fixture(name), to: root.appendingPathComponent("media/\(name)"))
        }
        let log = EventLog()
        events = log
        backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: try Support.core()) { name, json in log.add(name, json) }
        try await backend.start()
    }

    override func tearDown() async throws {
        await backend.stop(); await backend.pageProcessingWorkersExited()
    }

    func call(_ method: String, _ path: String, _ body: String? = nil) async throws -> [String: Any] {
        var request = body
        if method == "POST", path == "/api/export" {
            var fields = (try JSON.parse(body ?? "{}") as? [String: Any]) ?? [:]
            fields["renderer"] = "webcodecs"
            request = JSON(any: fields).text
        }
        if method == "POST", path == "/api/export/finish" {
            var fields = (try JSON.parse(request ?? "{}") as? [String: Any]) ?? [:]
            fields["drained"] = true; request = JSON(any: fields).text
        }
        var result = parse(try await backend.handle(method: method, path: path, body: request).text)
        if method == "POST", path == "/api/export", let id = result["id"] as? String {
            for _ in 0..<500 {
                let status = parse(try await backend.handle(method: "POST", path: "/api/export/progress", body: JSON(any: ["id": id]).text).text)
                if status["state"] as? String == "running" { result["state"] = "running"; return result }
                if status["cancelled"] as? Bool == true { throw ReelBackend.APIError("Fixture export failed before dispatch.") }
                try await Task.sleep(for: .milliseconds(10))
            }
            throw ReelBackend.APIError("Fixture export did not acquire admission.")
        }
        return result
    }

    func fileProject() throws -> [String: Any] {
        parse(try String(contentsOf: root.appendingPathComponent("reel.project.json"), encoding: .utf8))
    }

    func testEmptyFolderHasNoProject() async throws {
        let r = try await call("GET", "/api/project")
        XCTAssertTrue(r["project"] is NSNull)
        XCTAssertEqual(r["version"] as? Int, 0)
        XCTAssertEqual(r["root"] as? String, ProjectFolder(root: root).root.path)
        XCTAssertEqual((r["claude"] as? [String: Any])?["state"] as? String, "idle")
        let state = try await call("GET", "/api/state")
        XCTAssertEqual(state["bridgeAlive"] as? Bool, false)
    }

    func testNewImportEditUndoRedo() async throws {
        let created = try await call("POST", "/api/new", "{\"name\":\"Film\",\"width\":1280,\"height\":720,\"fps\":25}")
        XCTAssertEqual(object(created["project"])["name"] as? String, "Film")
        XCTAssertEqual(try fileProject()["width"] as? Int, 1280)
        // The file is the core's own text: two-space JSON with a trailing newline, as the Node server writes.
        let text = try String(contentsOf: root.appendingPathComponent("reel.project.json"), encoding: .utf8)
        XCTAssertTrue(text.hasPrefix("{\n  \"version\": ") && text.hasSuffix("}\n"))
        let core = try ReelCore(scriptURL: try Support.core())
        let current = await backend.currentProject()
        XCTAssertEqual(text, try core.fileText(project: try XCTUnwrap(current)))

        let imported = try await call("POST", "/api/import", "{\"paths\":[\"media\"]}")
        XCTAssertEqual(Set(object(imported["assets"]).keys), ["media/clip.mp4", "media/tone.m4a", "media/still.png"])
        XCTAssertEqual(object(object(try fileProject()["assets"])["media/clip.mp4"])["codec"] as? String, "h264")

        let edited = try await call("POST", "/api/ops", "{\"ops\":[{\"op\":\"append\",\"src\":\"media/clip.mp4\",\"track\":\"V1\"}],\"who\":\"you\"}")
        XCTAssertEqual(edited["created"] as? [String], ["c1", "c1a"]) // the clip and its linked audio
        let v1 = try XCTUnwrap(edited["version"] as? Int)
        let clips = { (p: [String: Any]) in ((p["tracks"] as? [[String: Any]])?.first { $0["id"] as? String == "V1" }?["clips"] as? [Any])?.count ?? 0 }
        XCTAssertEqual(clips(try fileProject()), 1)
        XCTAssertEqual(events.last("project")?["version"] as? Int, v1)
        XCTAssertEqual(events.last("project")?["who"] as? String, "you")

        let undone = try await call("POST", "/api/undo", "{}")
        XCTAssertEqual(clips(object(undone["project"])), 0)
        XCTAssertEqual(clips(try fileProject()), 0)
        XCTAssertEqual(undone["version"] as? Int, v1 + 1)

        let redone = try await call("POST", "/api/redo", "{}")
        XCTAssertEqual(clips(object(redone["project"])), 1)
        XCTAssertEqual(clips(try fileProject()), 1)

        // Ops naming media the project has not seen probe and import it first.
        let fresh = try await call("POST", "/api/ops", "{\"ops\":[{\"op\":\"append\",\"src\":\"media/still.png\",\"dur\":2}],\"returnProject\":false}")
        XCTAssertNil(fresh["project"])
        XCTAssertNotNil(object(try fileProject()["assets"])["media/still.png"])

        let outline = try await call("GET", "/api/outline")
        XCTAssertTrue((outline["outline"] as? String ?? "").hasPrefix("Film: 1280x720 @25fps"))
        XCTAssertTrue((outline["opsDoc"] as? String ?? "").contains("- append|insert|overwrite"))

        _ = try await call("POST", "/api/forget", "{\"paths\":[\"media/tone.m4a\"]}")
        XCTAssertNil(object(try fileProject()["assets"])["media/tone.m4a"])
        XCTAssertTrue(events.names().contains("activity"))
    }

    func testBadOpLeavesTheProjectAlone() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"x\"}")
        let before = try String(contentsOf: root.appendingPathComponent("reel.project.json"), encoding: .utf8)
        do {
            _ = try await call("POST", "/api/ops", "{\"ops\":[{\"op\":\"update\",\"id\":\"c9\",\"set\":{\"x\":1}}]}")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error.localizedDescription, "no clip c9")
        }
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("reel.project.json"), encoding: .utf8), before)
    }

    func testMalformedRequestCannotReplaceTheProject() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"Keep this\"}")
        for body in ["[]", "null", "{broken"] {
            do { _ = try await call("POST", "/api/new", body); XCTFail("accepted a malformed body") } catch {}
        }
        XCTAssertEqual(try fileProject()["name"] as? String, "Keep this")
    }

    func testOpsOnMediaOutsideTheProjectAreRefused() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"x\"}")
        do {
            _ = try await call("POST", "/api/ops", "{\"ops\":[{\"op\":\"append\",\"src\":\"../../etc/passwd\"}]}")
            XCTFail("expected an error")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("outside the project"))
        }
    }

    func testChangesOnDiskArePickedUp() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"Before\"}")
        var p = try fileProject()
        p["name"] = "After"
        try JSONSerialization.data(withJSONObject: p).write(to: root.appendingPathComponent("reel.project.json"))
        for _ in 0 ..< 30 where events.last("project")?["who"] as? String != "disk" { try await Task.sleep(nanoseconds: 100_000_000) }
        XCTAssertEqual(events.last("project")?["who"] as? String, "disk")
        let reloaded = try await call("GET", "/api/project")
        XCTAssertEqual(object(reloaded["project"])["name"] as? String, "After")
        // And the edit made on disk can be undone like any other.
        _ = try await call("POST", "/api/undo", "{}")
        XCTAssertEqual(try fileProject()["name"] as? String, "Before")
    }

    func testFilesStripPeaksAndResources() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"x\"}")
        let files = try await call("GET", "/api/files?dir=media")
        XCTAssertEqual(files["dir"] as? String, "media")
        XCTAssertEqual((files["entries"] as? [[String: Any]])?.map { $0["path"] as? String }, ["media/clip.mp4", "media/still.png", "media/tone.m4a"])
        let top = try await call("GET", "/api/files?dir=.")
        XCTAssertEqual((top["entries"] as? [[String: Any]])?.first?["dir"] as? Bool, true)
        do {
            _ = try await call("GET", "/api/files?dir=..")
            XCTFail("listed a folder outside the project")
        } catch {}

        let strip = try await call("GET", "/api/strip?src=media%2Fclip.mp4")
        let url = try XCTUnwrap(strip["url"] as? String)
        guard case .file(let jpeg, let type)? = try await backend.resource(path: url, query: [:]) else { return XCTFail("no strip file") }
        XCTAssertEqual(type, "image/jpeg")
        XCTAssertTrue(FileManager.default.fileExists(atPath: jpeg.path))
        let missing = try await backend.resource(path: "/cache/../../reel.project.json", query: [:])
        XCTAssertNil(missing)

        let peaks = try await call("GET", "/api/peaks?src=media/tone.m4a")
        XCTAssertEqual(peaks["perSec"] as? Int, 100)

        guard case .file(let media, let mtype)? = try await backend.resource(path: "/media", query: ["path": "media/clip.mp4"]) else { return XCTFail("no media") }
        XCTAssertEqual(media.lastPathComponent, "clip.mp4")
        XCTAssertEqual(mtype, "video/mp4")
        do {
            _ = try await backend.resource(path: "/media", query: ["path": "../outside.mp4"])
            XCTFail("served a file outside the project")
        } catch {}
        guard case .file(let wav, _)? = try await backend.resource(path: "/api/audio", query: ["src": "media/clip.mp4", "in": "0", "dur": "1"]) else { return XCTFail("no audio") }
        XCTAssertEqual(wav.pathExtension, "wav")
    }

    func testUnavailableFeaturesSaySo() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"x\"}")
        for (method, path, body) in [("POST", "/api/bridge/send", "{\"text\":\"hi\"}"),
                                     ("POST", "/api/export", "{\"preset\":\"prores-422\"}"), ("GET", "/api/nope", nil)] {
            do {
                _ = try await call(method, path, body)
                XCTFail("\(path) should fail")
            } catch {
                XCTAssertFalse(error.localizedDescription.isEmpty)
            }
        }
        let caps = try await call("GET", "/api/caps")
        XCTAssertEqual(caps["presets"] as? [String], ReelBackend.nativePresets)
        XCTAssertEqual(caps["chrome"] as? Bool, false)
        XCTAssertEqual(object(caps["analysis"])["scenes"] as? Bool, true)
        XCTAssertEqual(object(caps["export"])["renderer"] as? String, "metal")
    }

    func testFreeExportNameNumbersTakenNames() {
        XCTAssertEqual(ReelBackend.freeExportName(base: "Export", ext: "mp4") { _ in false }, "Export.mp4")
        let taken: Set<String> = ["Export.mp4", "Export-2.mp4", "Export-3.mp4"]
        XCTAssertEqual(ReelBackend.freeExportName(base: "Export", ext: "mp4") { taken.contains($0) }, "Export-4.mp4")
        XCTAssertEqual(ReelBackend.freeExportName(base: "Export", ext: "mov") { taken.contains($0) }, "Export.mov", "Another extension is a different file")
        XCTAssertEqual(ReelBackend.freeExportName(base: "Export", ext: "mp4") { _ in true }, "Export.mp4", "When every number is taken the exclusive publish refuses the first name")
    }

    func testExportsWithATakenNameAreNumbered() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"x\"}")
        let renders = root.appendingPathComponent("renders")
        try FileManager.default.createDirectory(at: renders, withIntermediateDirectories: true)
        try Data("old".utf8).write(to: renders.appendingPathComponent("Cut.mp4"))
        func start(_ body: [String: Any]) async throws -> [String: Any] {
            parse(try await backend.handle(method: "POST", path: "/api/export", body: JSON(any: body).text).text)
        }
        func out(_ job: [String: Any]) -> String? { object(job["spec"])["out"] as? String }
        // Browser-renderer exports: an existing file and a queued export both hold their names.
        let first = try await start(["preset": "h264-high", "name": "Cut", "renderer": "webcodecs", "fps": 30, "range": ["in": 0, "out": 1]])
        XCTAssertEqual(out(first), "renders/Cut-2.mp4")
        let second = try await start(["preset": "h264-high", "name": "Cut", "renderer": "webcodecs", "fps": 30, "range": ["in": 0, "out": 1]])
        XCTAssertEqual(out(second), "renders/Cut-3.mp4", "A name held by a queued or running export is taken")
        // Native-renderer exports number the same way and see the browser jobs' names.
        let native = try await start(["preset": "h264-high", "name": "Cut", "fps": 30, "range": ["in": 0, "out": 1]])
        XCTAssertEqual(out(native), "renders/Cut-4.mp4")
        // An explicit output path is never renamed; an existing one is still refused.
        do {
            _ = try await start(["preset": "h264-high", "out": "renders/Cut.mp4", "renderer": "webcodecs", "fps": 30, "range": ["in": 0, "out": 1]])
            XCTFail("An explicit existing output path was replaced or renamed")
        } catch {}
        XCTAssertEqual(try String(contentsOf: renders.appendingPathComponent("Cut.mp4"), encoding: .utf8), "old")
        for job in [first, second, native] {
            if let id = job["id"] as? String { _ = try? await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": id]).text) }
        }
    }

    func testExportJobLifecycle() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"x\"}")
        let job = try await call("POST", "/api/export", "{\"preset\":\"h264-high\",\"name\":\"My Cut!\",\"width\":1920,\"height\":1080,\"fps\":30,\"range\":{\"in\":0,\"out\":2}}")
        let id = try XCTUnwrap(job["id"] as? String)
        XCTAssertEqual(job["state"] as? String, "running")
        XCTAssertEqual(object(job["spec"])["out"] as? String, "renders/My-Cut-.mp4")
        XCTAssertEqual(object(job["spec"])["frames"] as? Int, 60)
        XCTAssertEqual(events.last("job")?["id"] as? String, id)

        _ = try await backend.saveExport(job: id, name: nil, position: 0, data: Data("hello ".utf8))
        _ = try await backend.saveExport(job: id, name: nil, position: 6, data: Data("world".utf8))
        _ = try await backend.saveExport(job: id, name: nil, position: 0, data: Data("H".utf8)) // a patch back at the start
        let progress = try await call("POST", "/api/export/progress", "{\"id\":\"\(id)\",\"progress\":0.5}")
        XCTAssertEqual(progress["cancelled"] as? Bool, false)
        let done = try await call("POST", "/api/export/finish", "{\"id\":\"\(id)\"}")
        XCTAssertEqual(done["state"] as? String, "done")
        XCTAssertEqual(done["output"] as? String, "renders/My-Cut-.mp4")
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("renders/My-Cut-.mp4"), encoding: .utf8), "Hello world")
        let listed = try await call("GET", "/api/jobs/wait?id=\(id)&timeout=100")
        XCTAssertEqual(listed["state"] as? String, "done")

        // A cancelled job stops taking bytes and leaves no file.
        let second = try await call("POST", "/api/export", "{\"preset\":\"hevc\",\"name\":\"two\",\"fps\":30,\"range\":{\"in\":0,\"out\":1}}")
        let id2 = try XCTUnwrap(second["id"] as? String)
        _ = try await backend.saveExport(job: id2, name: nil, position: 0, data: Data("x".utf8))
        _ = try await call("POST", "/api/jobs/cancel", "{\"id\":\"\(id2)\"}")
        let after = parse(try await backend.saveExport(job: id2, name: nil, position: 1, data: Data("y".utf8)).text)
        XCTAssertEqual(after["cancelled"] as? Bool, true)
        let late = try await call("POST", "/api/export/progress", "{\"id\":\"\(id2)\",\"progress\":0.9}")
        XCTAssertEqual(late["cancelled"] as? Bool, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("renders/two.mp4").path))
        XCTAssertEqual(events.last("job")?["error"] as? String, "cancelled")

        // Named saves land only under renders/ or .reel/frames/.
        let still = parse(try await backend.saveExport(job: nil, name: ".reel/frames/frame-1.000.png", position: 0, data: Data([0x89])).text)
        XCTAssertEqual(still["path"] as? String, ".reel/frames/frame-1.000.png")
        do {
            _ = try await backend.saveExport(job: nil, name: "reel.project.json", position: 0, data: Data())
            XCTFail("overwrote the project file")
        } catch {}
    }

    func testUploadsAndCopyIn() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"x\"}")
        _ = try await backend.upload(name: "../drop?.bin", data: Data("ab".utf8), id: "u1", done: false)
        let done = parse(try await backend.upload(name: "../drop?.bin", data: Data("cd".utf8), id: "u1", done: true).text)
        XCTAssertEqual(done["path"] as? String, "media/drop_.bin")
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("media/drop_.bin"), encoding: .utf8), "abcd")
        let single = parse(try await backend.upload(name: "one.txt", data: Data("z".utf8), id: nil, done: true).text)
        XCTAssertEqual(single["path"] as? String, "media/one.txt")

        let outside = try Support.tempFolder("elsewhere").appendingPathComponent("dropped clip.mp4")
        try FileManager.default.copyItem(at: Support.fixture("clip.mp4"), to: outside)
        let imported = parse(try await backend.copyIn([outside]).text)
        XCTAssertEqual(Array(object(imported["assets"]).keys), ["media/dropped clip.mp4"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("media/dropped clip.mp4").path))
    }

    func testInterchangeRoutesShareConversionsAndUndo() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"Round trip\",\"width\":640,\"height\":360,\"fps\":24}")
        _ = try await call("POST", "/api/ops", "{\"ops\":[{\"op\":\"append\",\"src\":\"media/clip.mp4\",\"dur\":1},{\"op\":\"add_caption\",\"text\":\"A caption\",\"start\":0,\"dur\":1}]}")
        for format in ["fcpxml", "otio", "srt", "vtt"] {
            let exported = try await call("POST", "/api/interchange/export", "{\"format\":\"\(format)\"}")
            let path = try XCTUnwrap(exported["path"] as? String)
            XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(path).path))
            let preview = try await call("POST", "/api/interchange/import", "{\"path\":\"\(path)\"}")
            if ["srt", "vtt"].contains(format) {
                XCTAssertEqual((preview["captions"] as? [[String: Any]])?.first?["text"] as? String, "A caption")
            } else {
                XCTAssertEqual(object(preview["project"])["width"] as? Int, 640)
                XCTAssertEqual(preview["missing"] as? [String], [])
            }
        }
        let list = try await call("GET", "/api/interchange/files?dir=renders&kind=timeline")
        XCTAssertEqual((list["entries"] as? [[String: Any]])?.count, 2)
        _ = try await call("POST", "/api/interchange/import", "{\"path\":\"renders/Round-trip.otio\",\"apply\":true}")
        let before = try fileProject()["name"] as? String
        _ = try await call("POST", "/api/undo", "{}")
        XCTAssertEqual(try fileProject()["name"] as? String, before)
        do {
            _ = try await call("POST", "/api/interchange/import", "{\"path\":\"../../escape.srt\"}")
            XCTFail("read interchange outside the project")
        } catch {}
    }

    func testInterchangePreviewHashesExactTextAndScopedCaptionsUndoExactly() async throws {
        _ = try await call("POST", "/api/new", #"{"name":"Caption scopes"}"#)
        _ = try await call("POST", "/api/ops", #"{"ops":[{"op":"add_comp","name":"Nested captions","width":640,"height":480},{"op":"add_caption","text":"Main cue","start":0,"dur":1}]}"#)
        let text = "1\r\n00:00:00,200 --> 00:00:00,900\r\nCaf\u{00e9} cue\r\n\r\n"
        let path = "media/captions.srt", file = root.appendingPathComponent(path)
        try text.write(to: file, atomically: true, encoding: .utf8)
        let expectedHash = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        for scope in [JSON.string("k1"), .null] {
            let before = await backend.currentProject(), version = await backend.currentVersion(), beforeFile = try Data(contentsOf: backend.folder.projectFile)
            let preview = try await call("POST", "/api/interchange/import", JSON(any: ["path": path, "comp": scope, "track": "C1", "apply": false]).text)
            let actualHash = try XCTUnwrap(preview["sourceHash"] as? String)
            XCTAssertEqual(actualHash, expectedHash)
            XCTAssertEqual(preview["sourcePath"] as? String, path)
            XCTAssertEqual(preview["version"] as? Int, version)
            let previewProject = await backend.currentProject(), previewVersion = await backend.currentVersion()
            XCTAssertEqual(previewProject, before); XCTAssertEqual(previewVersion, version)
            XCTAssertEqual(try Data(contentsOf: backend.folder.projectFile), beforeFile)
            let applied = try await call("POST", "/api/interchange/import", JSON(any: ["path": path, "comp": scope, "track": "C1", "replace": true, "apply": true, "expectedVersion": version, "expectedInputHash": expectedHash]).text)
            XCTAssertEqual(applied["applied"] as? Bool, true)
            let after = try fileProject(), mainCues = (after["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }.filter { $0["kind"] as? String == "caption" }
            let nestedCues = (object(object(after["comps"])["k1"])["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }.filter { $0["kind"] as? String == "caption" }
            if scope == .null { XCTAssertEqual(mainCues.count, 1); XCTAssertEqual(nestedCues.count, 0) }
            else {
                XCTAssertEqual(mainCues.count, 1); XCTAssertEqual(nestedCues.count, 1)
                XCTAssertEqual(try XCTUnwrap(mainCues.first)["text"] as? String, "Main cue")
                XCTAssertEqual(try XCTUnwrap(nestedCues.first)["text"] as? String, "Caf\u{00e9} cue")
            }
            _ = try await call("POST", "/api/undo", "{}")
            let restored = await backend.currentProject()
            XCTAssertEqual(restored, before)
            XCTAssertEqual(try Data(contentsOf: backend.folder.projectFile), beforeFile)
        }
    }

    func testInterchangeChangedInputAndUnknownCaptionScopeLeaveProjectUntouched() async throws {
        _ = try await call("POST", "/api/new", #"{"name":"Keep this project"}"#)
        let path = "media/captions.srt", file = root.appendingPathComponent(path)
        try "1\n00:00:00,000 --> 00:00:01,000\nBefore\n".write(to: file, atomically: true, encoding: .utf8)
        let preview = try await call("POST", "/api/interchange/import", JSON(any: ["path": path]).text)
        let hash = try XCTUnwrap(preview["sourceHash"] as? String), before = await backend.currentProject(), version = await backend.currentVersion()
        try "not a subtitle".write(to: file, atomically: true, encoding: .utf8)
        do { _ = try await call("POST", "/api/interchange/import", JSON(any: ["path": path, "apply": true, "expectedVersion": version, "expectedInputHash": hash]).text); XCTFail("applied changed preview input") }
        catch { XCTAssertTrue(error.localizedDescription.contains("input changed"), error.localizedDescription) }
        try "1\n00:00:00,000 --> 00:00:01,000\nBefore\n".write(to: file, atomically: true, encoding: .utf8)
        do { _ = try await call("POST", "/api/interchange/import", JSON(any: ["path": path, "apply": true, "expectedInputHash": hash, "comp": "missing"]).text); XCTFail("applied captions in unknown scope") }
        catch { XCTAssertTrue(error.localizedDescription.lowercased().contains("no composition"), error.localizedDescription) }
        do { _ = try await call("POST", "/api/interchange/import", JSON(any: ["path": path, "apply": true, "expectedVersion": version - 1, "expectedInputHash": hash]).text); XCTFail("applied captions with stale version") }
        catch { XCTAssertTrue(error.localizedDescription.contains("project changed")) }
        let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(afterVersion, version)
    }

    func testInterchangeInputChangedDuringProbeCannotReplaceProject() async throws {
        _ = try await call("POST", "/api/new", #"{"name":"Timeline input"}"#)
        _ = try await call("POST", "/api/ops", #"{"ops":[{"op":"append","src":"media/clip.mp4","dur":1}]}"#)
        let exported = try await call("POST", "/api/interchange/export", #"{"format":"otio"}"#), path = try XCTUnwrap(exported["path"] as? String)
        await backend.stop()
        let gate = ProbeGate(), log = events!
        backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), probe: { url in
            await gate.pauseOnce()
            return try await MediaProbe.probe(url)
        }) { name, json in log.add(name, json) }
        try await backend.start()
        let owner = backend!, before = await owner.currentProject(), version = await owner.currentVersion(), beforeFile = try Data(contentsOf: owner.folder.projectFile)
        let preview = try await call("POST", "/api/interchange/import", JSON(any: ["path": path]).text), hash = try XCTUnwrap(preview["sourceHash"] as? String)
        let pending = Task { try await owner.handle(method: "POST", path: "/api/interchange/import", body: JSON(any: ["path": path, "apply": true, "expectedVersion": version, "expectedInputHash": hash]).text) }
        await gate.waitUntilEntered()
        let file = root.appendingPathComponent(path), text = try String(contentsOf: file, encoding: .utf8)
        try (text + "\n").write(to: file, atomically: true, encoding: .utf8)
        await gate.resume()
        do { _ = try await pending.value; XCTFail("a changed input committed after probing") }
        catch { XCTAssertTrue(error.localizedDescription.contains("input changed"), error.localizedDescription) }
        let after = await owner.currentProject(), afterVersion = await owner.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(afterVersion, version)
        XCTAssertEqual(try Data(contentsOf: owner.folder.projectFile), beforeFile)
        let fresh = try await call("POST", "/api/interchange/import", JSON(any: ["path": path]).text)
        _ = try await call("POST", "/api/interchange/import", JSON(any: ["path": path, "apply": true, "expectedVersion": version, "expectedInputHash": fresh["sourceHash"]!]).text)
        _ = try await call("POST", "/api/undo", "{}")
        let restored = await owner.currentProject(); XCTAssertEqual(restored, before)
    }

    func testCompositionCaptionExportsUseLocalTimesAndPreserveProject() async throws {
        _ = try await call("POST", "/api/new", #"{"name":"Main timeline","width":640,"height":360,"fps":30}"#)
        _ = try await call("POST", "/api/ops", #"{"ops":[{"op":"add_caption","text":"Main timeline cue","start":12,"dur":2},{"op":"add_comp","name":"Portrait short","width":180,"height":320,"duration":2},{"op":"add_caption","comp":"k1","text":"Short composition cue","start":0.2,"dur":1.5}]}"#)
        let before = await backend.currentProject()
        for format in ["srt", "vtt"] {
            let exported = try await call("POST", "/api/interchange/export", JSON(any: ["format": format, "comp": "k1", "track": "C1"]).text)
            XCTAssertEqual(exported.string("path"), "renders/Portrait-short.\(format)")
            let content = try String(contentsOf: root.appendingPathComponent(exported.string("path")), encoding: .utf8)
            XCTAssertTrue(content.contains("Short composition cue")); XCTAssertFalse(content.contains("Main timeline cue"))
            let preview = try await call("POST", "/api/interchange/import", JSON(any: ["path": exported.string("path")]).text)
            let cue = try XCTUnwrap((preview["captions"] as? [[String: Any]])?.first)
            XCTAssertEqual(cue.number("t"), 0.2, accuracy: 0.001); XCTAssertEqual(cue.number("end"), 1.7, accuracy: 0.001)
        }
        let timeline = try await call("POST", "/api/interchange/export", #"{"format":"otio","comp":"k1"}"#)
        let imported = try await call("POST", "/api/interchange/import", JSON(any: ["path": timeline.string("path")]).text)
        XCTAssertEqual(object(imported["project"]).string("name"), "Portrait short")
        XCTAssertEqual(object(imported["project"]).number("width"), 180)
        XCTAssertEqual(object(imported["project"]).number("height"), 320)
        do { _ = try await call("POST", "/api/interchange/export", #"{"format":"srt","comp":"missing"}"#); XCTFail("Accepted a missing composition") }
        catch { XCTAssertTrue(error.localizedDescription.contains("no composition")) }
        let after = await backend.currentProject(); XCTAssertEqual(after, before)
    }

    func testInterchangeImportRejectsEditsMadeDuringProbeAndAllowsRetry() async throws {
        _ = try await call("POST", "/api/new", #"{"name":"Imported timeline","width":640,"height":360,"fps":24}"#)
        _ = try await call("POST", "/api/ops", #"{"ops":[{"op":"append","src":"media/clip.mp4","dur":1}]}"#)
        let exported = try await call("POST", "/api/interchange/export", #"{"format":"otio"}"#)
        let path = try XCTUnwrap(exported["path"] as? String)

        await backend.stop()
        let gate = ProbeGate(), log = events!
        backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: try Support.core(), probe: { url in
            await gate.pauseOnce()
            return try await MediaProbe.probe(url)
        }) { name, json in log.add(name, json) }
        try await backend.start()
        let owner = backend!
        let initialVersion = await owner.currentVersion()
        let pending = Task {
            try await owner.handle(method: "POST", path: "/api/interchange/import", body: JSON(any: ["path": path, "apply": true]).text)
        }
        await gate.waitUntilEntered()
        _ = try await call("POST", "/api/ops", #"{"ops":[{"op":"project","set":{"name":"Concurrent edit"}},{"op":"add_caption","text":"Keep this newer cue","start":0,"dur":1}]}"#)
        let editedProject = await owner.currentProject(), editedVersion = await owner.currentVersion()
        let editedFile = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        await gate.resume()

        do { _ = try await pending.value; XCTFail("A suspended interchange import replaced a newer edit") }
        catch { XCTAssertTrue(error.localizedDescription.contains("project changed")) }
        let afterProject = await owner.currentProject(), afterVersion = await owner.currentVersion()
        XCTAssertEqual(afterProject, editedProject)
        XCTAssertEqual(afterVersion, editedVersion)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), editedFile)

        let preview = try await call("POST", "/api/interchange/import", JSON(any: ["path": path, "expectedVersion": initialVersion]).text)
        XCTAssertEqual(object(preview["project"]).string("name"), "Imported timeline")
        do {
            _ = try await call("POST", "/api/interchange/import", JSON(any: ["path": path, "apply": true, "expectedVersion": initialVersion]).text)
            XCTFail("An explicit stale version was accepted")
        } catch { XCTAssertTrue(error.localizedDescription.contains("project changed")) }
        let beforeRetryProject = await owner.currentProject(), beforeRetryVersion = await owner.currentVersion()
        XCTAssertEqual(beforeRetryProject, editedProject)
        XCTAssertEqual(beforeRetryVersion, editedVersion)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), editedFile)

        let retried = try await call("POST", "/api/interchange/import", JSON(any: ["path": path, "apply": true, "expectedVersion": editedVersion]).text)
        XCTAssertEqual(retried["applied"] as? Bool, true)
        XCTAssertEqual(retried["probed"] as? [String], ["media/clip.mp4"])
        XCTAssertEqual(object(retried["project"]).string("name"), "Imported timeline")
        _ = try await call("POST", "/api/undo", "{}")
        let undone = await owner.currentProject()
        XCTAssertEqual(undone, editedProject)
    }

    func testExportRejectsInvalidSettingsBeforeRegisteringJob() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"x\"}")
        for body in ["{\"fps\":0,\"range\":{\"in\":0,\"out\":1}}", "{\"width\":-10,\"range\":{\"in\":0,\"out\":1}}", "{\"range\":{\"in\":2,\"out\":1}}"] {
            do { _ = try await call("POST", "/api/export", body); XCTFail("accepted invalid export settings") } catch {}
        }
        let jobs = try await call("GET", "/api/jobs")
        XCTAssertEqual((jobs["jobs"] as? [Any])?.count, 0)
    }

    func testReloadCancelsPartialExport() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"x\"}")
        let job = try await call("POST", "/api/export", "{\"name\":\"partial\",\"range\":{\"in\":0,\"out\":1}}")
        let id = try XCTUnwrap(job["id"] as? String)
        _ = try await backend.saveExport(job: id, name: nil, position: 0, data: Data("partial".utf8))
        await backend.cancelExports(reason: "the editor was reloaded")
        let jobs = try await call("GET", "/api/jobs")
        XCTAssertEqual((jobs["jobs"] as? [[String: Any]])?.first?["error"] as? String, "the editor was reloaded")
        do { _ = try await call("POST", "/api/export/finish", "{\"id\":\"\(id)\"}"); XCTFail("published a partial render") } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("renders/partial.mp4").path))
    }

    func testClosedProjectCannotCommitAnImportThatWasAlreadyProbing() async throws {
        await backend.stop()
        let gate = ProbeGate()
        let log = events!
        backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: try Support.core(), probe: { url in
            await gate.pause()
            return try await MediaProbe.probe(url)
        }) { name, json in log.add(name, json) }
        try await backend.start()
        _ = try await call("POST", "/api/new", "{\"name\":\"Project A\"}")
        let old = backend!
        let before = try String(contentsOf: root.appendingPathComponent("reel.project.json"), encoding: .utf8)
        let pending = Task { try await old.importMedia(["media/clip.mp4"]) }
        await gate.waitUntilEntered()
        await old.stop()
        let eventCount = events.names().count

        let nextRoot = try Support.tempFolder("project-b")
        let next = try ReelBackend(folder: ProjectFolder(root: nextRoot), coreScript: try Support.core()) { _, _ in }
        try await next.start()
        _ = try await next.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Project B\"}")
        await next.subscribe()
        await gate.resume()
        do { _ = try await pending.value; XCTFail("a closed project committed its suspended import") }
        catch { XCTAssertEqual(error.localizedDescription, "the project was closed") }
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("reel.project.json"), encoding: .utf8), before)
        XCTAssertEqual(events.names().count, eventCount)
        let nextProject = await next.currentProject()
        XCTAssertEqual(parse(try XCTUnwrap(nextProject))["name"] as? String, "Project B")
        await next.stop()
    }

    func testExportTemporaryFilesStayInsideTheProject() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"x\"}")
        let outside = try Support.tempFolder("outside")
        let exports = root.appendingPathComponent(".reel/exports")
        try FileManager.default.createSymbolicLink(at: exports, withDestinationURL: outside)
        do { _ = try await call("POST", "/api/export", "{\"range\":{\"in\":0,\"out\":1}}"); XCTFail("registered an export outside the project") }
        catch { XCTAssertTrue(error.localizedDescription.contains("outside the project") || error.localizedDescription.contains("symbolic links")) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), [])

        try FileManager.default.removeItem(at: exports)
        let job = try await call("POST", "/api/export", "{\"name\":\"confined\",\"range\":{\"in\":0,\"out\":1}}")
        let id = try XCTUnwrap(job["id"] as? String)
        let ownedPart = await backend.exportPartForTesting(id)
        let part = try XCTUnwrap(ownedPart)
        _ = try await backend.saveExport(job: id, name: nil, position: 0, data: Data("first".utf8))
        let sentinel = outside.appendingPathComponent("keep.txt")
        try Data("untouched".utf8).write(to: sentinel)
        try FileManager.default.removeItem(at: part)
        try FileManager.default.createSymbolicLink(at: part, withDestinationURL: sentinel)
        do { _ = try await backend.saveExport(job: id, name: nil, position: 0, data: Data("replace".utf8)); XCTFail("wrote through a changed temporary symlink") }
        catch { XCTAssertTrue(error.localizedDescription.contains("outside the project") || error.localizedDescription.contains("symbolic links")) }
        do { _ = try await call("POST", "/api/export/finish", "{\"id\":\"\(id)\"}"); XCTFail("published a temporary symlink outside the project") }
        catch { XCTAssertTrue(error.localizedDescription.contains("outside the project") || error.localizedDescription.contains("symbolic links")) }
        _ = try await call("POST", "/api/jobs/cancel", "{\"id\":\"\(id)\"}")
        XCTAssertEqual(try String(contentsOf: sentinel, encoding: .utf8), "untouched")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("renders/confined.mp4").path))
    }

    func testExportSymlinksCannotReplaceOrRemoveTheProjectFile() async throws {
        _ = try await call("POST", "/api/new", "{\"name\":\"Keep this project\"}")
        let projectFile = root.appendingPathComponent("reel.project.json")
        let before = try Data(contentsOf: projectFile)
        let renders = root.appendingPathComponent("renders")
        try FileManager.default.createDirectory(at: renders, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: renders.appendingPathComponent("unsafe.mp4"), withDestinationURL: projectFile)
        do { _ = try await call("POST", "/api/export", "{\"out\":\"renders/unsafe.mp4\",\"range\":{\"in\":0,\"out\":1}}"); XCTFail("registered an output linked to the project") }
        catch { XCTAssertTrue(error.localizedDescription.contains("symbolic links")) }

        let job = try await call("POST", "/api/export", "{\"name\":\"safe\",\"range\":{\"in\":0,\"out\":1}}")
        let id = try XCTUnwrap(job["id"] as? String)
        let ownedPart = await backend.exportPartForTesting(id)
        let part = try XCTUnwrap(ownedPart)
        try FileManager.default.createSymbolicLink(at: part, withDestinationURL: projectFile)
        do { _ = try await backend.saveExport(job: id, name: nil, position: 0, data: Data("bad".utf8)); XCTFail("wrote into the project through a temporary link") }
        catch { XCTAssertTrue(error.localizedDescription.contains("symbolic links")) }
        do { _ = try await call("POST", "/api/export/finish", "{\"id\":\"\(id)\"}"); XCTFail("moved the project into renders") }
        catch { XCTAssertTrue(error.localizedDescription.contains("symbolic links")) }
        _ = try await call("POST", "/api/jobs/cancel", "{\"id\":\"\(id)\"}")
        let frames = root.appendingPathComponent(".reel/frames")
        try FileManager.default.createSymbolicLink(at: frames, withDestinationURL: root)
        do { _ = try await backend.saveExport(job: nil, name: ".reel/frames/reel.project.json", position: 0, data: Data("bad".utf8)); XCTFail("saved a still through a linked frames directory") }
        catch { XCTAssertTrue(error.localizedDescription.contains("symbolic links")) }
        XCTAssertEqual(try Data(contentsOf: projectFile), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: renders.appendingPathComponent("safe.mp4").path))
        // A named export whose name the link holds is numbered instead, and leaves the link alone.
        try FileManager.default.removeItem(at: frames)
        let numbered = parse(try await backend.handle(method: "POST", path: "/api/export", body: "{\"name\":\"unsafe\",\"renderer\":\"webcodecs\",\"range\":{\"in\":0,\"out\":1}}").text)
        XCTAssertEqual(object(numbered["spec"])["out"] as? String, "renders/unsafe-2.mp4")
        if let id = numbered["id"] as? String { _ = try? await backend.handle(method: "POST", path: "/api/jobs/cancel", body: "{\"id\":\"\(id)\"}") }
        XCTAssertEqual(try Data(contentsOf: projectFile), before)
    }

    func testUiStateMerges() async throws {
        _ = try await call("POST", "/api/ui-state", "{\"playhead\":2.5,\"page\":\"color\"}")
        let outline = try await call("GET", "/api/outline")
        let ui = object(outline["uiState"])
        XCTAssertEqual(ui["playhead"] as? Double, 2.5)
        XCTAssertEqual(ui["page"] as? String, "color")
        XCTAssertEqual((ui["selection"] as? [Any])?.count, 0)
    }
}

private actor ProbeGate {
    private var entered = false
    private var started: CheckedContinuation<Void, Never>?
    private var release: CheckedContinuation<Void, Never>?

    func pause() async {
        entered = true
        started?.resume()
        started = nil
        await withCheckedContinuation { release = $0 }
    }

    func pauseOnce() async {
        if !entered { await pause() }
    }

    func waitUntilEntered() async {
        if entered { return }
        await withCheckedContinuation { started = $0 }
    }

    func resume() {
        release?.resume()
        release = nil
    }
}
