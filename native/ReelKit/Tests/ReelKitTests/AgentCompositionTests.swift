#if os(macOS)
import CoreVideo
import Foundation
import XCTest
@testable import ReelKit

final class AgentCompositionTests: XCTestCase {
    func testRealCompanionAndStdioAgentEditRenderMixAndSelectedTweak() async throws {
        if let provider = ProcessInfo.processInfo.environment["REEL_LIVE_AGENT_PROVIDER"] {
            try await liveAcceptance(provider: provider)
            return
        }
        let repo = Support.nativeDir.deletingLastPathComponent(), root = try Support.tempFolder("agent-native"), folder = ProjectFolder(root: root)
        let node = try agentNode(), process = Process(), pipe = Pipe()
        process.executableURL = node
        process.arguments = [repo.appendingPathComponent("editor/test/fixtures/sharing-bridge-runner.mjs").path,
                             repo.appendingPathComponent("editor/test/fixtures/agent-cli.mjs").path, repo.appendingPathComponent("editor/agent/mcp.mjs").path]
        process.standardOutput = pipe; process.standardError = FileHandle.standardError
        try process.run()
        defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
        var line = Data()
        while line.count < 2048, let byte = try pipe.fileHandleForReading.read(upToCount: 1), !byte.isEmpty {
            if byte[0] == 10 { break }; line.append(byte)
        }
        let pairing = parse(String(decoding: line, as: UTF8.self))
        let port = try XCTUnwrap(pairing["port"] as? Int), token = try XCTUnwrap(pairing["token"] as? String)
        let endpoint = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/"))
        let bridge = try AgentBridge(configuration: .init(endpoint: endpoint, token: token))
        let sharing = try AssistantSharingScope(models: [.init(provider: "claude-code", model: "")], companion: endpoint)
        let receipt = CompositionSharingReceipt(scope: sharing)
        try await receipt.approve(sharing.envelope)
        let core = try ReelCore(scriptURL: Support.core()), renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core())
        let samples = (0..<144000).map { Float(sin(Double($0) * 2 * Double.pi * 440 / 48000) * 0.2) }
        try NativeAudioProcessing.write(.init(channels: [samples, samples]), to: folder.output("tone.wav"))
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), events: { _, _ in })
        try await backend.start()
        _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"name":"Agent native fixture","width":160,"height":90,"fps":30}"#)
        let tool: Assistant.ToolHandler = { method, path, body in try await backend.handle(method: method, path: path, body: body) }
        let still: Assistant.StillHandler = { options in
            let response = parse(try await backend.handle(method: "POST", path: "/api/frame", body: options.text).text)
            return Assistant.Image(data: try Data(contentsOf: folder.resolve(response.string("path"))))
        }
        let first = try await bridge.run("Build a three-second editable scene.", provider: "claude-code", sharing: sharing, authorize: { try await receipt.authorize() }, context: .object([("projectID", "fixture")]), tool: tool, still: still)
        XCTAssertEqual(first.toolCalls, 5)
        let beforeOptional = await backend.currentProject(), before = try XCTUnwrap(beforeOptional)
        XCTAssertTrue(before.contains("EDITABLE SCENE")); XCTAssertTrue(before.contains("Agent scene")); XCTAssertTrue(before.contains("tone.wav"))
        let at0 = try await renderer.render(project: before, at: 0), at1 = try await renderer.render(project: before, at: 1)
        XCTAssertEqual(pixel(at0.pixelBuffer, 30, 60), [255, 0, 0, 255]); XCTAssertEqual(pixel(at1.pixelBuffer, 130, 60), [255, 0, 0, 255])
        XCTAssertEqual(pixel(at1.pixelBuffer, 30, 60), [16, 32, 48, 255])
        let pcm = try await NativeAudioMixer.render(plan: .raw(core.audioPlan(project: before, from: 0, to: 3)), folder: folder)
        XCTAssertEqual(pcm.duration, 3, accuracy: 0.001)
        let rms = sqrt(pcm.channels[0].reduce(0.0) { $0 + Double($1 * $1) } / Double(pcm.count))
        XCTAssertEqual(rms, 0.2 / sqrt(2) * pow(10, 0.5 / 20), accuracy: 0.002)
        let second = try await bridge.run("Change only the selected title.", provider: "claude-code", sharing: sharing, authorize: { try await receipt.authorize() }, context: .object([("projectID", "fixture"), ("selection", .array(["c2"])), ("comp", "k1")]), tool: tool, still: still)
        XCTAssertEqual(second.toolCalls, 5)
        let afterOptional = await backend.currentProject(), after = try XCTUnwrap(afterOptional)
        XCTAssertTrue(after.contains("SELECTED TWEAK")); XCTAssertFalse(after.contains("EDITABLE SCENE"))
        let oldComp = object(object(parse(before)["comps"])["k1"]), newComp = object(object(parse(after)["comps"])["k1"])
        let shape = { (comp: [String: Any]) in (comp["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }.first { $0.string("kind") == "shape" }! }
        XCTAssertEqual(JSON(any: shape(oldComp)).text, JSON(any: shape(newComp)).text)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let undo = await backend.currentProject(); XCTAssertEqual(undo, before)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(at: folder.output(".reel/frames"), includingPropertiesForKeys: nil).count, 4)
        await backend.stop()
    }

    private func liveAcceptance(provider: String) async throws {
        guard ["claude-code", "codex", "antigravity"].contains(provider) else { throw ReelRenderingError("Live acceptance requires claude-code, codex or antigravity") }
        let repo = Support.nativeDir.deletingLastPathComponent()
        let root = repo.appendingPathComponent("build/agent-native-live-\(provider)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let folder = ProjectFolder(root: root), process = Process(), pipe = Pipe()
        process.executableURL = try agentNode()
        process.arguments = [repo.appendingPathComponent("editor/agent/bridge.mjs").path, "--port", "0", "--pair"]
        process.standardOutput = pipe; process.standardError = FileHandle.standardError
        try process.run()
        defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
        var line = Data()
        while line.count < 2048, let byte = try pipe.fileHandleForReading.read(upToCount: 1), !byte.isEmpty { if byte[0] == 10 { break }; line.append(byte) }
        let pairing = parse(String(decoding: line, as: UTF8.self))
        let port = try XCTUnwrap(pairing["port"] as? Int), token = try XCTUnwrap(pairing["token"] as? String)
        let bridge = try AgentBridge(configuration: .init(endpoint: URL(string: "http://127.0.0.1:\(port)")!, token: token))
        let samples = (0..<144000).map { Float(sin(Double($0) * 2 * Double.pi * 440 / 48000) * 0.2) }
        try NativeAudioProcessing.write(.init(channels: [samples, samples]), to: folder.output("tone.wav"))
        let core = try ReelCore(scriptURL: Support.core())
        let renderer = try ReelMetalRenderer(folder: folder, coreScriptURL: Support.core(), fontURLs: [repo.appendingPathComponent("editor/web/fonts/InterVariable.ttf")])
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), events: { _, _ in })
        try await backend.start()
        defer { Task { await backend.stop() } }
        _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"name":"Live subscription acceptance","width":160,"height":90,"fps":30}"#)
        _ = try await backend.handle(method: "POST", path: "/api/ops", body: #"{"ops":[{"op":"import","assets":{"tone.wav":{"assetKind":"audio","hasAudio":true,"duration":3}}}],"summary":"Register generated QA tone"}"#)
        let tool: Assistant.ToolHandler = { method, path, body in try await backend.handle(method: method, path: path, body: body) }
        let still: Assistant.StillHandler = { options in
            let response = parse(try await backend.handle(method: "POST", path: "/api/frame", body: options.text).text)
            return Assistant.Image(data: try Data(contentsOf: folder.resolve(response.string("path"))))
        }
        let prompt = """
        Build a synthetic three-second QA scene as editable native Reel objects. Create a 160x90 reusable composition named Subscription QA scene. Add a full-frame #102030 color background, a 20x20 solid #ff0000 rectangle centered at x 30, y 60, and an editable Inter title SUBSCRIPTION QA at x 80, y 20. Set title.size to 144, which yields a 12-pixel font at this canvas height. Animate the rectangle x from 30 at local time 0 to 130 at time 1 with linear keyframes, keeping y 60. Put existing tone.wav on an audio track from 0 for 3 seconds at volume 0 dB. Place the composition on the main timeline from 0 for 3 seconds. Keep the scene duration 3 seconds. Read the outline operation reference to get valid operation shapes and IDs. Batch related operations atomically. Inspect actual frames at 0 and 1 with reel_frame, then finish. Use only supplied synthetic assets and project tools.
        """
        let first = try await bridge.run(prompt, provider: provider, context: .object([("projectID", "synthetic-subscription-qa")]), tool: tool, still: still)
        try Data(JSON(any: ["provider": provider, "toolCalls": first.toolCalls, "reply": first.text]).text.utf8).write(to: folder.output("first-provider-reply.json"))
        if first.toolCalls == 0 { print("Provider returned without project tools:", first.text) }
        XCTAssertGreaterThanOrEqual(first.toolCalls, 3)
        let beforeOptional = await backend.currentProject(), before = try XCTUnwrap(beforeOptional)
        let project = parse(before), comps = object(project["comps"])
        let key = try XCTUnwrap(comps.keys.first { object(comps[$0]).string("name") == "Subscription QA scene" })
        let comp = object(comps[key]), clips = (comp["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }
        let title = try XCTUnwrap(clips.first { object($0["title"]).string("text") == "SUBSCRIPTION QA" }), titleID = title.string("id")
        XCTAssertFalse(titleID.isEmpty); XCTAssertTrue(clips.contains { $0.string("kind") == "shape" })
        XCTAssertTrue(clips.contains { $0.string("src") == "tone.wav" })
        let frame0 = try await renderer.render(project: before, at: 0), frame1 = try await renderer.render(project: before, at: 1)
        XCTAssertEqual(pixel(frame0.pixelBuffer, 30, 60), [255, 0, 0, 255]); XCTAssertEqual(pixel(frame1.pixelBuffer, 130, 60), [255, 0, 0, 255])
        XCTAssertEqual(pixel(frame1.pixelBuffer, 30, 60), [16, 32, 48, 255])
        let titleRows = (0..<40).filter { y in (0..<160).contains { x in let p = pixel(frame0.pixelBuffer, x, y); return p[0] > 180 && p[1] > 180 && p[2] > 180 } }.count
        XCTAssertGreaterThanOrEqual(titleRows, 6, "The actual native Inter title must have readable glyph height")
        let pcm = try await NativeAudioMixer.render(plan: .raw(core.audioPlan(project: before, from: 0, to: 3)), folder: folder)
        let rms = sqrt(pcm.channels[0].reduce(0.0) { $0 + Double($1 * $1) } / Double(pcm.count))
        XCTAssertEqual(pcm.duration, 3, accuracy: 0.001); XCTAssertEqual(rms, 0.2 / sqrt(2), accuracy: 0.003)
        let second = try await bridge.run("Change only the selected title text to SELECTED SUBSCRIPTION QA in one atomic ops batch. Preserve every other clip and all its motion/audio settings. Inspect the resulting frame and finish.", provider: provider,
            context: .object([("projectID", "synthetic-subscription-qa"), ("selection", .array([.string(titleID)])), ("comp", .string(key))]), tool: tool, still: still)
        let afterOptional = await backend.currentProject(), after = try XCTUnwrap(afterOptional)
        let changedComp = object(object(parse(after)["comps"])[key]), changedClips = (changedComp["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }
        let changedTitle = try XCTUnwrap(changedClips.first { $0.string("id") == titleID })
        XCTAssertEqual(object(changedTitle["title"]).string("text"), "SELECTED SUBSCRIPTION QA")
        XCTAssertNil(changedTitle["title.text"])
        let nonselected = { (source: String) -> String in
            let p = parse(source); var values = object(p["comps"]); var selectedComp = object(values[key])
            var tracks = selectedComp["tracks"] as? [[String: Any]] ?? []
            for i in tracks.indices { tracks[i]["clips"] = (tracks[i]["clips"] as? [[String: Any]] ?? []).filter { $0.string("id") != titleID } }
            selectedComp["tracks"] = tracks; values[key] = selectedComp
            return JSON(any: ["comps": values, "tracks": p["tracks"] ?? [], "assets": p["assets"] ?? [:]]).text
        }
        XCTAssertEqual(nonselected(before), nonselected(after))
        try Data(after.utf8).write(to: folder.output("accepted.project.json"))
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let undone = await backend.currentProject(); XCTAssertEqual(undone, before)
        let frames = try FileManager.default.contentsOfDirectory(at: folder.output(".reel/frames"), includingPropertiesForKeys: nil).filter { $0.pathExtension == "png" }
        XCTAssertGreaterThanOrEqual(frames.count, 3)
        let report = JSON(any: ["provider": provider, "firstToolCalls": first.toolCalls, "secondToolCalls": second.toolCalls, "firstReply": first.text, "secondReply": second.text, "audioRMS": rms, "titleGlyphRows": titleRows, "nativeFrames": frames.map(\.lastPathComponent), "selectedTitle": titleID, "composition": key])
        try Data(report.text.utf8).write(to: folder.output("acceptance-report.json"))
        if let speech = ProcessInfo.processInfo.environment["REEL_LIVE_SPEECH_FIXTURE"], let wordsFile = ProcessInfo.processInfo.environment["REEL_LIVE_SPEECH_WORDS"] {
            let source = URL(fileURLWithPath: speech), bytes = try Data(contentsOf: source)
            let copied = try folder.output("speech.aiff")
            try bytes.write(to: copied)
            _ = try await backend.handle(method: "POST", path: "/api/import", body: #"{"paths":["speech.aiff"]}"#)
            let raw = parse(try String(contentsOfFile: wordsFile)), segments = raw["transcription"] as? [[String: Any]] ?? []
            let words: [[String: Any]] = segments.compactMap { segment in
                let offsets = object(segment["offsets"]), from = offsets.number("from") / 1000, to = offsets.number("to") / 1000, text = segment.string("text").trimmingCharacters(in: .whitespacesAndNewlines)
                return text.isEmpty || to <= from ? nil : ["t": from, "end": to, "text": text]
            }
            XCTAssertGreaterThan(words.count, 20)
            _ = try await backend.handle(method: "POST", path: "/api/transcript", body: JSON(any: ["src":"speech.aiff","locale":"en-US","words":words,"revision":0]).text)
            let snapshot = await backend.currentProject(), beforeShort = try XCTUnwrap(snapshot)
            let third = try await bridge.run("Read the saved source transcript for speech.aiff in bounded pages. Choose one coherent passage lasting 3 to 8 seconds about editable captions or the transcript workflow. Use the actual source words and times as evidence. Preview /api/shorts/build with apply:false and then apply with its expectedVersion to create one 180x320 composition with karaoke native captions. Preserve all existing compositions and main tracks. Inspect an actual frame in the new composition, then finish with the quoted passage and reason. Do not invent speech or predict virality.", provider:provider, context:.object([("projectID","synthetic-speech-shorts-qa")]),tool:tool,still:still)
            let shortSnapshot = await backend.currentProject(), afterShort = try XCTUnwrap(shortSnapshot)
            let oldComps = object(parse(beforeShort)["comps"]), newComps = object(parse(afterShort)["comps"])
            let added = newComps.keys.filter { oldComps[$0] == nil }
            XCTAssertEqual(added.count,1)
            let shortID = try XCTUnwrap(added.first), short = object(newComps[shortID])
            XCTAssertEqual(short.number("width"),180); XCTAssertEqual(short.number("height"),320)
            XCTAssertTrue((3...8).contains(short.number("duration")))
            let shortTracks = short["tracks"] as? [[String:Any]] ?? [], shortClips = shortTracks.flatMap { $0["clips"] as? [[String:Any]] ?? [] }
            XCTAssertTrue(shortClips.contains { $0.string("kind") == "caption" && !$0.string("text").isEmpty })
            XCTAssertTrue(shortClips.contains { $0.string("kind") == "audio" && $0.string("src") == "speech.aiff" })
            for (id,value) in oldComps { XCTAssertEqual(JSON(any:value).text,JSON(any:newComps[id]).text) }
            XCTAssertEqual(JSON(any:parse(beforeShort)["tracks"]).text,JSON(any:parse(afterShort)["tracks"]).text)
            let mixFile = try await backend.renderAudio(from:0,to:short.number("duration"),comp:shortID)
            let mix = try await NativeAudioProcessing.decode(mixFile)
            try FileManager.default.removeItem(at: mixFile)
            XCTAssertGreaterThan(mix.channels[0].map { abs($0) }.max() ?? 0,0.01)
            let cue = try XCTUnwrap(shortClips.first { $0.string("kind") == "caption" })
            let rendered = try await renderer.render(project:afterShort,at:cue.number("start")+cue.number("dur")/2,comp:shortID)
            XCTAssertGreaterThan((0..<320).filter { y in (0..<180).contains { x in let p=pixel(rendered.pixelBuffer,x,y); return p[0]>150 && p[1]>150 } }.count,5)
            _ = try await backend.handle(method:"POST",path:"/api/undo",body:"{}")
            let shortUndo = await backend.currentProject(); XCTAssertEqual(shortUndo,beforeShort)
            XCTAssertEqual(try Data(contentsOf:source),bytes); XCTAssertEqual(try Data(contentsOf:copied),bytes)
            try Data(JSON(any:["provider":provider,"toolCalls":third.toolCalls,"reply":third.text,"composition":short,"wordCount":words.count]).text.utf8).write(to:folder.output("shorts-acceptance-report.json"))
        }
        print("Live subscription acceptance evidence: \(root.path)")
        await backend.stop()
    }
}

// Only this local synthetic composition fixture uses this receipt.
private actor CompositionSharingReceipt {
    private let scope: AssistantSharingScope
    private var approved: JSON?
    init(scope: AssistantSharingScope) { self.scope = scope }
    func approve(_ envelope: JSON) throws {
        guard scope.matchesEnvelope(envelope) else { throw Assistant.Failure.sharingRequired }
        approved = envelope
    }
    func authorize() throws {
        guard let approved, scope.matchesEnvelope(approved) else { throw Assistant.Failure.sharingRequired }
    }
}

private func agentNode() throws -> URL {
    let paths = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { String($0) + "/node" }
    guard let value = ([ProcessInfo.processInfo.environment["NODE"]].compactMap { $0 } + paths + ["/opt/homebrew/bin/node", "/usr/local/bin/node"]).first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { throw ReelRenderingError("Agent integration tests require Node.js on PATH") }
    return URL(fileURLWithPath: value)
}
#endif
