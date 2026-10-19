#!/usr/bin/env python3
"""Execute the production audio capture and job controller with suspended requests."""
from pathlib import Path
import argparse
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--reelkit-build', type=Path, default=root / 'native/ReelKit/.build/debug')
args = parser.parse_args()
products = args.reelkit_build.resolve()
module_dir = products / 'Modules'
link = list(map(str, sorted((products / 'ReelKit.build').glob('*.o'))))
if link: link += list(map(str, sorted((products / 'NativeProjectIO.build').glob('*.o'))))
if (products / 'libReelKit.a').exists():
    module_dir = products; link = ['-L', str(products), '-lReelKit']
if not link or not (module_dir / 'ReelKit.swiftmodule').exists():
    raise SystemExit('Build or test native/ReelKit first, then pass its debug products directory with --reelkit-build.')
base = root / 'native/App/Shared/NativeEditor'
project = (base / 'NativeProject.swift').read_text().split('// Foundation-only receipt helpers')[0]
inspector = (base / 'NativeInspector.swift').read_text()
workflow = inspector.split('// BEGIN INSPECTOR WORKFLOW\n')[1].split('// END INSPECTOR WORKFLOW')[0]
adapters = inspector.split('private func NativeInspectorFile')[1].split('\nenum NativeInspectorNavigation {')[0]
adapters = 'private func NativeInspectorFile' + adapters
panel = (base / 'NativeAudioPanel.swift').read_text().split('\nstruct NativeAudioPanel: View')[0].replace('import SwiftUI', 'import Combine')
model = (base / 'NativeEditorModel.swift').read_text()
def declaration(marker):
    start = model.index(marker); begin = model.index('{', start); end = begin + 1; depth = 1
    while depth:
        depth += (model[end] == '{') - (model[end] == '}'); end += 1
    return model[start:end]
identity = declaration('struct NativeSourceFileIdentity:')
perform = declaration('    func perform(')
stubs = r'''
@MainActor final class AudioSessionStub { var error: String? }
@MainActor final class NativeEditorModel {
    var project: NativeProject?
    var folder: URL?
    var composition: String?
    var version = 4
    var selectedID: String? = "c1"
    var selectedIDs: Set<String> = ["c1"]
    var generation = UUID()
    var processingContextID: UUID { generation }
    var capabilities: [String: Any] = ["analysis": ["loudness": true, "processingRecommendations": true], "processing": ["audioClean": true]]
    var tracks: [NativeTrack] { project?.tracks(in: composition) ?? [] }
    var status = ""
    var session: AudioSessionStub? = AudioSessionStub()
    var calls: [(String, [String: Any]?)] = []
    var handler: ((String, [String: Any]?) async throws -> [String: Any])?
    var onRefresh: (() -> Void)?
    func mediaURL(_ source: String) throws -> URL { folder!.appendingPathComponent(source) }
    func call(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        calls.append((path, body))
        let result = try await handler!(path, body)
        try Task.checkCancellation()
        return result
    }
    func refresh() async { onRefresh?() }
'''+perform+r'''
}
'''
tests = r'''
@main struct AudioWorkflowChecks {
    @MainActor static func main() async throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) { checks += 1; precondition(condition(), message) }
        func rejects(_ message: String, _ action: () throws -> Void) { checks += 1; do { try action(); preconditionFailure(message) } catch {} }
        func drain() async { for _ in 0..<20 { await Task.yield() }; try? await Task.sleep(for: .milliseconds(10)) }
        let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let file = folder.appendingPathComponent("source.wav")
        try Data("source bytes".utf8).write(to: file)
        let core = try ReelCore(source: String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8))
        var fields = try JSON.parse(core.newProject(name: "audio")) as! [String: Any]
        let clip: [String: Any] = ["id": "c1", "kind": "audio", "src": "source.wav", "start": 2, "dur": 2, "in": 1, "speed": 2, "volume": -3]
        fields["assets"] = ["source.wav": ["duration": 10, "hasAudio": true, "hasVideo": false]]
        fields["tracks"] = [["id": "A1", "kind": "audio", "volume": 0, "pan": 0, "clips": [clip]]]
        fields["comps"] = ["nested": ["name": "Nested", "width": 640, "height": 480, "fps": 24, "duration": 10, "tracks": fields["tracks"]!]]
        fields = try JSON.parse(core.applyOps(project: JSON(any: fields).text, ops: "[]").project) as! [String: Any]
        func model(_ comp: String? = nil) -> NativeEditorModel {
            let model = NativeEditorModel(); model.folder = folder; model.project = NativeProject(fields: fields); model.composition = comp
            model.handler = { _, _ in ["id": "j1", "state": "done", "result": ["integrated": -18]] }
            return model
        }
        let m = model(), capture = try NativeAudioRequestCapture(model: m, id: "c1")
        let main = try capture.request(route: "/api/audio/loudnorm", options: ["target": -14, "tp": -1], capabilities: m.capabilities)
        check(main["comp"] is NSNull && main.number("expectedVersion") == 4, "Main scope and version are explicit")
        check(main.number("in") == 1 && main.number("dur") == 4 && main.flag("apply") && !main.flag("wait"), "Normalization freezes the scalar source range and async mode")
        let whole = try capture.request(route: "/api/analyze", options: ["kind": "loudness", "in": 99, "dur": 99], capabilities: m.capabilities)
        check(whole["in"] == nil && whole["dur"] == nil, "Whole-file loudness has no selected-range claim")
        let noise = try capture.request(route: "/api/analyze", options: ["kind": "audio-noise"], capabilities: m.capabilities)
        check(noise.number("in") == 1 && noise.number("dur") == 4, "Noise recommendations use captured source time")
        let nestedModel = model("nested"), nested = try NativeAudioRequestCapture(model: nestedModel, id: "c1")
        check(try nested.request(route: "/api/audio/clean", options: ["mode": "denoise", "quality": "high", "strength": 0.3, "detail": 0.5], capabilities: nestedModel.capabilities).string("comp") == "nested", "Reused IDs retain the exact nested scope")
        let compatible = NativeProcessingRequests.audio(clip: NativeClip(fields: clip), mode: "voice", quality: "balanced", strength: 0.5, detail: 0.5)
        check(compatible["comp"] is NSNull && compatible["expectedVersion"] == nil, "Legacy smoke callers keep a compatible explicit main default")
        let versioned = NativeProcessingRequests.audio(clip: NativeClip(fields: clip), mode: "voice", quality: "balanced", strength: 0.5, detail: 0.5, comp: "nested", version: 4)
        check(versioned.string("comp") == "nested" && versioned.number("expectedVersion") == 4 && versioned.flag("useOriginal"), "Cleanup helper carries explicit scope, version and original-source selection")
        for bad: [String: Any] in [["strength": true], ["strength": "0.3"], ["detail": false], ["quality": 1], ["noiseFrom": 1, "noiseTo": 1.05]] {
            rejects("Cleanup request rejects coercion before dispatch") { _ = try capture.request(route: "/api/audio/clean", options: bad, capabilities: m.capabilities) }
        }
        rejects("Unavailable capability") { _ = try capture.request(route: "/api/audio/loudnorm", options: [:], capabilities: [:]) }
        rejects("Invalid noise profile") { _ = try capture.request(route: "/api/audio/clean", options: ["mode": "denoise", "quality": "high", "strength": 0.3, "detail": 0.5, "noiseFrom": 9, "noiseTo": 11], capabilities: m.capabilities) }
        var linkedFields = fields, linkedClip = clip, video = clip
        linkedClip["link"] = "linked"; video["link"] = "linked"; video["kind"] = "video"; video["id"] = "video"
        linkedFields["tracks"] = [["id": "A1", "kind": "audio", "clips": [linkedClip]], ["id": "V1", "kind": "video", "locked": true, "clips": [video]]]
        m.project = NativeProject(fields: linkedFields)
        let linked = try NativeAudioRequestCapture(model: m, id: "c1")
        _ = try linked.request(route: "/api/audio/loudnorm", options: ["target": -14], capabilities: m.capabilities)
        check(true, "Audio-only normalization preserves an untouched locked linked video")
        linkedFields["tracks"] = [["id": "A1", "kind": "audio", "locked": true, "clips": [linkedClip]], ["id": "V1", "kind": "video", "clips": [video]]]
        m.project = NativeProject(fields: linkedFields)
        let lockedTarget = try NativeAudioRequestCapture(model: m, id: "c1")
        rejects("Locked primary target") { _ = try lockedTarget.request(route: "/api/audio/loudnorm", options: ["target": -14], capabilities: m.capabilities) }
        m.project = NativeProject(fields: fields)
        check(capture.matchesBefore(m), "Exact request context matches")
        m.version += 1; check(!capture.matchesBefore(m), "Version drift rejected"); m.version = 4
        m.selectedIDs.insert("secondary"); check(!capture.matchesBefore(m), "Complete selection drift rejected"); m.selectedIDs = ["c1"]
        m.composition = "nested"; check(!capture.matchesBefore(m), "Composition drift rejected"); m.composition = nil
        m.folder = folder.appendingPathComponent("other"); check(!capture.matchesBefore(m), "Folder drift rejected"); m.folder = folder
        let generation = m.generation; m.generation = UUID(); check(!capture.matchesBefore(m), "Backend generation drift rejected"); m.generation = generation
        var edited = fields; edited["name"] = "changed elsewhere"; m.project = NativeProject(fields: edited)
        check(!capture.matchesBefore(m), "Unrelated project drift rejected before dispatch"); m.project = NativeProject(fields: fields)
        for key in ["src", "in", "dur", "speed", "reverse", "freeze", "timeMap"] {
            var changed = fields, c = clip; c[key] = key == "src" ? "other.wav" as Any : key == "timeMap" ? [] as Any : 3 as Any
            changed["tracks"] = [["id": "A1", "kind": "audio", "volume": 0, "pan": 0, "clips": [c]]]; m.project = NativeProject(fields: changed)
            check(!capture.matchesBefore(m), "Full clip drift rejected: \(key)")
        }
        m.project = NativeProject(fields: fields)
        for (key, value) in [("reverse", true as Any), ("freeze", 2 as Any), ("timeMap", [] as Any), ("speed", 0 as Any)] {
            var changed = fields, c = clip; c[key] = value
            changed["tracks"] = [["id": "A1", "kind": "audio", "clips": [c]]]
            m.project = NativeProject(fields: changed)
            let mapped = try NativeAudioRequestCapture(model: m, id: "c1")
            rejects("Normalization rejects unsupported source mapping: \(key)") { _ = try mapped.request(route: "/api/audio/loudnorm", options: ["target": -14], capabilities: m.capabilities) }
            rejects("Noise recommendations reject unsupported source mapping: \(key)") { _ = try mapped.request(route: "/api/analyze", options: ["kind": "audio-noise"], capabilities: m.capabilities) }
        }
        m.project = NativeProject(fields: fields)
        try Data("replaced source bytes".utf8).write(to: file)
        check(!capture.matchesBefore(m), "Source replacement rejected")
        try Data("source bytes".utf8).write(to: file)
        let current = try NativeAudioRequestCapture(model: m, id: "c1")
        for comp in [nil, "nested"] as [String?] {
            for route in ["/api/audio/clean", "/api/audio/loudnorm"] {
                let targetModel = model(comp), target = try NativeAudioRequestCapture(model: targetModel, id: "c1")
                let asset: [String: Any] = ["duration": 10, "hasAudio": true, "hasVideo": false]
                let recipe = NativeAudioProcessing.cleanupRecipe(source: "source.wav", output: "clean.wav", mode: "denoise", options: try NativeAudioProcessing.CleanOptions(request: ["strength": 0.3, "noiseFrom": 1.25, "noiseTo": 1.75]))
                let result: [String: Any] = route.hasSuffix("clean") ? ["applied": true, "assetRegistered": true, "admissionVersion": 5, "version": 6, "path": "clean.wav", "asset": asset, "recipe": recipe] : ["applied": true, "gain": 3.2]
                var operations: [[String: Any]] = []
                if route.hasSuffix("clean") { operations.append(["op": "import", "assets": ["clean.wav": asset]]) }
                let set: [String: Any] = route.hasSuffix("clean") ? ["src": "clean.wav", "audioCleanup": recipe] : ["volume": 3.2]
                operations.append(["op": "update", "id": "c1", "comp": comp as Any? ?? NSNull(), "set": set])
                let applied = try core.applyOps(project: targetModel.project!.text, ops: JSON(any: operations).text).project
                let actual = NativeInspectorWorkflow.canonical(try JSON.parse(applied) as! [String: Any])
                check(target.expectedProject(result: result, route: route) == actual, "Expected mutation equals production core for \(route), \(comp ?? "main")")
                let ownedVersion = route.hasSuffix("clean") ? 6 : 5
                targetModel.project = NativeProject(fields: try JSON.parse(applied) as! [String: Any]); targetModel.version = ownedVersion
                check(target.matchesResult(targetModel, result: result, route: route), "Only the owned admission and placement commits may publish the cleanup result")
                if route.hasSuffix("clean") {
                    try Data("cleaned bytes".utf8).write(to: folder.appendingPathComponent("clean.wav"))
                    let appliedCapture = try NativeAudioRequestCapture(model: targetModel, id: "c1")
                    let rerender = try appliedCapture.request(route: "/api/audio/clean", options: ["mode": "denoise", "strength": 0.2], capabilities: targetModel.capabilities)
                    check(rerender.string("src") == "clean.wav" && rerender.flag("useOriginal"), "Rerender owns the current clip while asking the backend for its original")
                    let restore = try appliedCapture.request(route: "/api/audio/restore", options: [:], capabilities: targetModel.capabilities)
                    check(restore.string("id") == "c1" && restore.flag("useOriginal"), "Restore owns the same scoped selected clip")
                    let restoreResult: [String: Any] = ["applied": true, "restored": true, "path": "source.wav"]
                    let restored = try core.applyOps(project: applied, ops: JSON(any: [["op": "update", "id": "c1", "comp": comp as Any? ?? NSNull(), "set": ["src": "source.wav", "audioCleanup": NSNull()]]]).text).project
                    let restoredFields = try JSON.parse(restored) as! [String: Any]
                    check(appliedCapture.expectedProject(result: restoreResult, route: "/api/audio/restore") == NativeInspectorWorkflow.canonical(restoredFields), "Restore expected mutation equals the actual core")
                    var unavailable = targetModel.project!.fields, catalog = unavailable.dictionary("assets")
                    catalog.removeValue(forKey: "source.wav"); unavailable["assets"] = catalog; targetModel.project = NativeProject(fields: unavailable)
                    let missingCapture = try NativeAudioRequestCapture(model: targetModel, id: "c1")
                    rejects("Missing original stops a repeated request") { _ = try missingCapture.request(route: "/api/audio/clean", options: [:], capabilities: targetModel.capabilities) }
                    targetModel.project = NativeProject(fields: try JSON.parse(applied) as! [String: Any])
                }
                targetModel.version = ownedVersion + 1; check(!target.matchesResult(targetModel, result: result, route: route), "Intervening commit after processing suppresses result")
                targetModel.version = ownedVersion; var other = targetModel.project!.fields; other["name"] = "unrelated drift"; targetModel.project = NativeProject(fields: other)
                check(!target.matchesResult(targetModel, result: result, route: route), "Intervening same-version content drift suppresses result")
            }
        }
        for comp in [nil, "nested"] as [String?] {
            let targetModel = model(comp), target = try NativeAudioRequestCapture(model: targetModel, id: "c1")
            let asset: [String: Any] = ["duration": 10, "hasAudio": true, "processing": ["kind": "audio-cleanup", "source": "source.wav", "engine": "accelerate-spectral-cpu", "compute": "cpu"]]
            let recipe = NativeAudioProcessing.cleanupRecipe(source: "source.wav", output: "retained.wav", mode: "denoise", options: try NativeAudioProcessing.CleanOptions(request: [:]))
            let receipt: [String: Any] = ["assetRegistered": true, "placementRequested": true, "applied": false, "admissionVersion": 5, "version": 5, "path": "retained.wav", "asset": asset, "recipe": recipe, "applyError": "Placement refused"]
            let admitted = try core.applyOps(project: targetModel.project!.text, ops: JSON(any: [["op": "import", "assets": ["retained.wav": asset]]]).text).project
            targetModel.project = NativeProject(fields: try JSON.parse(admitted) as! [String: Any]); targetModel.version = 5
            check(target.matchesResult(targetModel, result: receipt, route: "/api/audio/clean"), "Owned admission-only receipt is accepted with one version increment")
            check(target.expectedProject(result: receipt, route: "/api/audio/clean") == NativeInspectorWorkflow.canonical(targetModel.project!.fields), "Refused placement expects only the Media import")
            targetModel.version = 6
            check(!target.matchesResult(targetModel, result: receipt, route: "/api/audio/clean"), "An edit after admission suppresses a stale receipt")
        }
        let queuedModel = model(), queuedWork = NativeAudioWork()
        queuedWork.start(queuedModel, id: "c1", route: "/api/analyze", options: ["kind": "loudness"])
        queuedModel.composition = "nested"
        await drain()
        check(queuedModel.calls.isEmpty && !queuedWork.running, "Changed queued target is rejected before dispatch")
        let acceptedModel = model(), acceptedWork = NativeAudioWork()
        acceptedWork.start(acceptedModel, id: "c1", route: "/api/analyze", options: ["kind": "loudness"])
        await drain()
        check(acceptedWork.visibleResult(acceptedModel).number("integrated") == -18, "Captured analysis publishes to its original selection")
        acceptedModel.selectedIDs.insert("secondary")
        check(acceptedWork.visibleResult(acceptedModel).isEmpty, "Recommendations disappear on another selection")
        let normalizeModel = model("nested"), normalizeWork = NativeAudioWork()
        let normalizeResult: [String: Any] = ["applied": true, "gain": 3.2]
        let normalizeFields = try JSON.parse(core.applyOps(project: normalizeModel.project!.text, ops: JSON(any: [["op": "update", "id": "c1", "comp": "nested", "set": ["volume": 3.2]]]).text).project) as! [String: Any]
        normalizeModel.handler = { _, _ in ["id": "normalization", "state": "done", "result": normalizeResult] }
        normalizeModel.onRefresh = { normalizeModel.project = NativeProject(fields: normalizeFields); normalizeModel.version = 5 }
        normalizeWork.start(normalizeModel, id: "c1", route: "/api/audio/loudnorm", options: ["target": -14, "tp": -1])
        await drain()
        check(normalizeWork.visibleResult(normalizeModel).number("gain") == 3.2, "Controller refresh publishes its own scoped atomic commit")
        normalizeModel.version = 6; normalizeWork.clearStaleResult(normalizeModel)
        check(normalizeWork.visibleResult(normalizeModel).isEmpty, "Controller clears measurements after a later edit")
        let pendingModel = model(), pendingWork = NativeAudioWork()
        var gate: CheckedContinuation<Void, Never>?
        pendingModel.handler = { path, _ in
            if path == "/api/analyze" { await withCheckedContinuation { gate = $0 }; return ["id": "analysis", "state": "done", "result": ["suggested": ["strength": 0.7]]] }
            return ["jobs": []]
        }
        pendingWork.start(pendingModel, id: "c1", route: "/api/analyze", options: ["kind": "audio-noise"])
        await drain(); pendingModel.version = 5; gate!.resume(); await drain()
        check(pendingWork.visibleResult(pendingModel).isEmpty, "Late measurement cannot publish after another edit")
        let cancelModel = model(), cancelWork = NativeAudioWork()
        var cancelGate: CheckedContinuation<Void, Never>?, registered: [String: Any] = [:], cancelled: [String] = []
        cancelModel.handler = { path, body in
            if path == "/api/audio/clean" {
                registered = ["id": "owned", "spec": body!, "state": "queued"]
                await withCheckedContinuation { cancelGate = $0 }; return registered
            }
            if path == "/api/analyze" { return ["id": "new", "state": "done", "result": ["integrated": -20]] }
            if path == "/api/jobs" { return ["jobs": [["id": "unrelated", "spec": ["uiAudioRequestID": "other"]], registered]] }
            if path == "/api/jobs/cancel" { cancelled.append(body!.string("id")); return [:] }
            return [:]
        }
        var settings: [String: Any] = ["mode": "denoise", "quality": "high", "strength": 0.3, "detail": 0.5]
        cancelWork.start(cancelModel, id: "c1", route: "/api/audio/clean", options: settings)
        settings["strength"] = 0.9
        await drain()
        check(registered.dictionary("spec").number("strength") == 0.3, "Options are frozen before scheduling")
        cancelWork.cancel(cancelModel); await drain(); cancelGate!.resume(); await drain()
        check(!cancelled.isEmpty && cancelled.allSatisfy { $0 == "owned" }, "Cancellation before the job response finds only its immutable request ID")
        check(!cancelWork.running && cancelWork.visibleResult(cancelModel).isEmpty, "Cancellation cannot publish a measurement")
        cancelWork.start(cancelModel, id: "c1", route: "/api/analyze", options: ["kind": "loudness"])
        await drain()
        check(cancelWork.visibleResult(cancelModel).number("integrated") == -20, "A canceled controller can start a new independent job")
        let resetModel = model(), resetWork = NativeAudioWork()
        resetWork.start(resetModel, id: "c1", route: "/api/analyze", options: ["kind": "loudness"])
        resetModel.generation = UUID(); resetWork.cancel(resetModel, clear: true); await drain()
        check(resetModel.calls.isEmpty, "Project reset prevents queued dispatch into a different backend")
        check(current.matchesBefore(m), "A newly captured unchanged source remains valid")
        print("Passed \(checks) production audio request, mutation, async selection and cancellation checks.")
    }
}
'''
source = 'import Foundation\nimport Darwin\nimport Combine\nimport ReelKit\n' + workflow + '\n' + project + '\n' + identity + '\n' + stubs + '\n' + adapters + '\n' + panel + '\n' + tests
source = source.replace('check(try nested.request(route:', 'check(try! nested.request(route:')
with tempfile.TemporaryDirectory(prefix='reel-audio-workflows-') as temporary:
    folder = Path(temporary); swift = folder / 'checks.swift'; swift.write_text(source); binary = folder / 'checks'
    # ReelKit imports its NativeProjectIO C target. Expose that module to this client from the tracked header.
    project_io = folder / 'NativeProjectIO'; project_io.mkdir()
    (project_io / 'module.modulemap').write_text('module NativeProjectIO {\n    umbrella header "%s"\n    export *\n}\n' % (root / 'native/ReelKit/Sources/NativeProjectIO/include/NativeProjectIO.h'))
    subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(folder / 'cache'), '-I', str(module_dir), '-I', str(project_io), str(swift), *link, '-o', str(binary)], check=True)
    core = folder / 'reel-core.js'
    subprocess.run(['node', str(root / 'native/scripts/bundle-core.mjs'), '--out', str(core), '--parity', str(folder / 'parity.json')], check=True)
    subprocess.run([str(binary), str(folder), str(core)], check=True)
