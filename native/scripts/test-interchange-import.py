#!/usr/bin/env python3
"""Run the production native import copy, capture and request safeguards."""
from pathlib import Path
import subprocess
import tempfile


def block(text, marker):
    start = text.index(marker)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


def main():
    repo = Path(__file__).resolve().parents[2]
    editor = repo / 'native/App/Shared/NativeEditor'
    deliver = (editor / 'NativeDeliverPanel.swift').read_text()
    project = (editor / 'NativeProject.swift').read_text()
    model_source = (editor / 'NativeEditorModel.swift').read_text()
    selection = block(model_source, 'struct NativeEditorSelection: Equatable')
    # Selection and edit feedback run through the production haptic policy.
    selection += '\n' + model_source.split('// BEGIN HAPTIC POLICY\n', 1)[1].split('// END HAPTIC POLICY', 1)[0]
    editor_view = (editor / 'NativeEditorView.swift').read_text()
    selection += '\n#if os(iOS)\nimport CoreHaptics\n' + block(editor_view, 'enum NativeHapticAvailability {') + '\n#endif\n'
    model_implementation = model_source[model_source.index('final class NativeEditorModel: ObservableObject'):]
    edit_methods = '\n'.join(block(model_implementation, marker) for marker in [
        'func select(ids: Set<String>, primary: String? = nil, feedback: Bool = true)',
        'private func applySelection(_ selection: NativeEditorSelection, feedback: Bool)',
        'private func emitHaptic(_ kind: NativeHapticKind?)',
        'func seek(_ at: Double)',
        'func call(_ path: String,',
        'func perform(_ action:',
        'func editBatch(_ operations:',
    ])
    kit = repo / 'native/ReelKit/Sources/ReelKit'
    json_source = (kit / 'JSON.swift').read_text()
    folder = block((kit / 'ProjectFolder.swift').read_text(), 'public struct ProjectFolder: Sendable')
    projections = project[project.index('struct NativeProject {'):project.index('enum NativeProcessingRequests {')]
    dictionary = block(project, 'extension Dictionary where Key == String, Value == Any')
    implementation = deliver[deliver.index('struct NativeInterchangeSource: Sendable'):deliver.index('struct NativeInterchangeImportSheet: View')]
    fixture = '''
@MainActor final class ReelBackend {
    struct APIError: Error, LocalizedError { let errorDescription: String?; init(_ text: String) { errorDescription = text } }
    var calls: [(String, String, [String: Any])] = []
    var responder: ((String, String, [String: Any]) async throws -> JSON)?
    func handle(method: String, path: String, body: String?) async throws -> JSON {
        let fields = try body.map { try JSON.parse($0) as? [String: Any] ?? [:] } ?? [:]
        calls.append((method, path, fields))
        return try await responder?(method, path, fields) ?? JSON(any: [:])
    }
}
@MainActor final class EditorSession: ObservableObject {
    var backend: ReelBackend?
    var folder: URL?
    var error = ""
    var previewRequests = 0
    func request(method: String, path: String, body: String?) async throws -> JSON {
        previewRequests += 1
        return try await backend!.handle(method: method, path: path, body: body)
    }
}
@MainActor final class NativeEditorModel: ObservableObject {
    var folder: URL?
    var project: NativeProject?
    var version = 7
    var composition: String? = "compA"
    var selectedID: String?
    private(set) var selectedIDs: Set<String> = []
    private var applyingSelection = false
    var time = 0.0
    var playing = false
    var generation = UUID()
    var session: EditorSession?
    var status = ""
    private(set) var hapticSignal = NativeHapticSignal()
    var receives = 0
    var receivedCompositions: [String?] = []
    var requestedFrames = 0
    var tracks: [NativeTrack] { project?.tracks(in: composition) ?? [] }
    var fps: Double { project?.fps ?? 30 }
    var duration: Double { project?.duration(in: composition) ?? 0 }
    func discardRenderPreview(redraw: Bool = true) { }
    func pause() { playing = false }
    func requestFrame() { requestedFrames += 1 }
    func receive(_ event: String, _ text: String) {
        receives += 1
        receivedCompositions.append(composition)
        let fields = try! JSON.parse(text) as! [String: Any]
        project = NativeProject(fields: fields.dictionary("project")); version = Int(fields.number("version"))
    }
    EDIT_METHODS
}
'''
    fixture = fixture.replace('    EDIT_METHODS', edit_methods)
    checks = r'''
func require(_ yes: Bool, _ text: String) { if !yes { fatalError(text) } }
@main struct ImportChecks {
    @MainActor static func main() async throws {
        var count = 0
        func check(_ yes: Bool, _ text: String) { require(yes, text); count += 1 }
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), external = root.appendingPathComponent("external")
        let projectFolder = root.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: external, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: projectFolder, withIntermediateDirectories: true)
        let folder = ProjectFolder(root: projectFolder)
        let input = external.appendingPathComponent("Captions.srt"), data = Data("1\n00:00:00,000 --> 00:00:01,000\nHello\n".utf8)
        try data.write(to: input)
        let copied = try NativeInterchangeFile.copy(input, into: folder)
        check(try Data(contentsOf: input) == data, "Source was changed")
        check(try Data(contentsOf: folder.resolve(copied.path)) == data, "Copy bytes changed")
        check(copied.path.hasPrefix(".reel/imports/") && copied.format == "srt" && copied.originalName == "Captions.srt", "Copy destination or format")
        check(copied.hash == SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), "Copy hash differs from exact bytes")
        let unicode = external.appendingPathComponent("Unicode.vtt")
        let unicodeData = Data([0xef,0xbb,0xbf]) + Data("WEBVTT\r\n\r\n00:00:00.000 --> 00:00:01.000\r\nCafé 🪶\r\n".utf8)
        try unicodeData.write(to:unicode)
        let unicodeCopy = try NativeInterchangeFile.copy(unicode,into:folder)
        let parsedText = try String(contentsOf:folder.resolve(unicodeCopy.path),encoding:.utf8)
        check(unicodeCopy.hash == SHA256.hash(data:Data(parsedText.utf8)).map { String(format:"%02x",$0) }.joined(), "Copy hash differs from backend text decoding for BOM/CRLF/Unicode")
        check(try Data(contentsOf:unicode) == unicodeData && Data(contentsOf:folder.resolve(unicodeCopy.path)) == unicodeData, "Unicode/BOM source or copy changed")
        NativeInterchangeFile.discard(unicodeCopy)
        let second = try NativeInterchangeFile.copy(input, into: folder)
        check(copied.path != second.path, "Copy paths were reused")
        let bundle = external.appendingPathComponent("Edit.fcpxmld")
        try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true)
        try Data("<fcpxml version=\"1.10\"></fcpxml>".utf8).write(to: bundle.appendingPathComponent("Info.fcpxml"))
        try Data("Private metadata".utf8).write(to: bundle.appendingPathComponent("Other.txt"))
        let xml = try NativeInterchangeFile.copy(bundle, into: folder)
        check(xml.format == "fcpxml" && xml.path.hasSuffix(".fcpxml"), "FCPXMLD did not copy Info.fcpxml")
        check(!FileManager.default.fileExists(atPath: folder.root.appendingPathComponent(".reel/imports/Other.txt").path), "FCPXMLD copied extra files")
        func rejects(_ file: URL, _ destination: ProjectFolder = folder) throws {
            do { _ = try NativeInterchangeFile.copy(file, into: destination); fatalError("Unsupported source accepted: \(file.path)") }
            catch { count += 1 }
        }
        let unsupported = external.appendingPathComponent("unsupported.mp4"); try data.write(to: unsupported); try rejects(unsupported)
        let binary = external.appendingPathComponent("binary.otio"); try Data([0xff,0x00]).write(to: binary); try rejects(binary)
        let empty = external.appendingPathComponent("empty.vtt"); try Data().write(to: empty); try rejects(empty)
        let huge = external.appendingPathComponent("huge.srt"); FileManager.default.createFile(atPath: huge.path, contents: nil)
        let hugeHandle = try FileHandle(forWritingTo: huge); try hugeHandle.truncate(atOffset: UInt64(NativeInterchangeFile.maximumBytes + 1)); try hugeHandle.close(); try rejects(huge)
        let linked = external.appendingPathComponent("linked.srt"); try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: input); try rejects(linked)
        let linkBundle = external.appendingPathComponent("Linked.fcpxmld"); try FileManager.default.createDirectory(at: linkBundle, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: linkBundle.appendingPathComponent("Info.fcpxml"), withDestinationURL: bundle.appendingPathComponent("Info.fcpxml")); try rejects(linkBundle)
        let linkedRoot = root.appendingPathComponent("linked-project"); try FileManager.default.createDirectory(at: linkedRoot.appendingPathComponent(".reel"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: linkedRoot.appendingPathComponent(".reel/imports"), withDestinationURL: external); try rejects(input, ProjectFolder(root: linkedRoot))
        let copyDirectory = external.appendingPathComponent("Directory.srt")
        try FileManager.default.createDirectory(at:copyDirectory,withIntermediateDirectories:true); try rejects(copyDirectory)
        let cleanupCopy = try NativeInterchangeFile.copy(input,into:folder)
        let cleanupURL = try folder.output(cleanupCopy.path)
        try FileManager.default.removeItem(at:cleanupURL)
        try FileManager.default.createSymbolicLink(at:cleanupURL,withDestinationURL:input)
        NativeInterchangeFile.discard(cleanupCopy)
        check(try Data(contentsOf:input) == data && FileManager.default.destinationOfSymbolicLink(atPath:cleanupURL.path) == input.path, "Cleanup followed a replaced symlink")
        try FileManager.default.removeItem(at:cleanupURL)
        NativeInterchangeFile.discard(second)
        check(!FileManager.default.fileExists(atPath: folder.root.appendingPathComponent(second.path).path) && FileManager.default.fileExists(atPath: input.path), "Cancel cleanup removed the original")
        check(NativeInterchangeDisplay.time(.infinity,fps:30) == "Unavailable" && NativeInterchangeDisplay.time(1,fps:.nan) == "Unavailable", "Untrusted time display can trap")
        check(NativeInterchangeDisplay.time(Double.greatestFiniteMagnitude,fps:120) == "Unavailable" && NativeInterchangeDisplay.time(1,fps:0) == "Unavailable", "Untrusted time display bound")
        let backend = ReelBackend(), session = EditorSession(), model = NativeEditorModel()
        let project: [String: Any] = ["name":"Original", "width":1920, "height":1080, "fps":30, "tracks":[], "comps":["compA":["name":"Nested", "tracks":[["id":"C1","kind":"caption","clips":[["id":"old-selection","kind":"caption","start":0,"dur":10]]],["id":"C2","kind":"caption","locked":true,"clips":[]],["id":"C3","kind":"video","clips":[]]]]]]
        session.backend = backend; session.folder = projectFolder; model.folder = projectFolder; model.project = NativeProject(fields: project); model.session = session
        let origin = NativeInterchangeOrigin.capture(model: model, session: session)!
        check(origin.matches(model: model, session: session), "Fresh capture mismatches")
        for axis in 0..<6 {
            session.backend = backend; session.folder = projectFolder; model.folder = projectFolder; model.composition = "compA"; model.version = 7; model.project = NativeProject(fields: project)
            switch axis {
            case 0: session.backend = ReelBackend()
            case 1: model.folder = external
            case 2: session.folder = external
            case 3: model.composition = nil
            case 4: model.version = 8
            default: model.project = NativeProject(fields: ["name":"Changed"])
            }
            check(!origin.matches(model: model, session: session), "Capture accepted stale identity axis \(axis)")
        }
        session.backend = backend; session.folder = projectFolder; model.folder = projectFolder; model.composition = "compA"; model.version = 7; model.project = NativeProject(fields: project)
        let options = NativeInterchangeOptions.initial(tracks: model.tracks)
        check(options.track == "C1" && options.valid(tracks: model.tracks), "Initial caption destination")
        check(NativeInterchangeOptions.nextTrack(model.tracks) == "C4", "New caption track reused an ID")
        check(!NativeInterchangeOptions(track:"C2").valid(tracks:model.tracks), "Locked caption target accepted")
        check(!NativeInterchangeOptions(track:"C3").valid(tracks:model.tracks), "Video track accepted for captions")
        check(!NativeInterchangeOptions(track:"C4",replace:true).valid(tracks:model.tracks), "Replace accepted for absent target")
        let request = origin.request(source:copied, options:options, apply:true)
        check(request.string("path") == copied.path && request.string("track") == "C1" && request.string("comp") == "compA" && Int(request.number("expectedVersion")) == 7, "Apply lost captured destination/version")
        check(request.string("expectedInputHash") == copied.hash && request.flag("apply") && !request.flag("replace"), "Apply lost preview hash/options")
        let mainOrigin = NativeInterchangeOrigin(backend:origin.backend,folder:origin.folder,composition:nil,version:7,project:origin.project)
        check(mainOrigin.request(source:copied,options:options,apply:true)["comp"] is NSNull, "Main composition was omitted")
        check(origin.request(source:xml,options:options,apply:true)["track"] == nil, "Timeline replace carried caption options")
        var previewFields: [String: Any] = ["sourcePath":copied.path,"sourceHash":copied.hash,"version":7,"captions":[["t":0,"end":1,"text":"Hello"]],"warnings":["Warning"]]
        let validPreview = try NativeInterchangePreview(origin:origin,options:options,source:copied,response:JSON(any:previewFields))
        check(validPreview.captions.count == 1 && validPreview.warnings == ["Warning"], "Preview content missing")
        for key in ["sourcePath","sourceHash","version","applied"] {
            var bad = previewFields
            bad[key] = key == "version" ? 8 : key == "applied" ? true : "changed"
            do { _ = try NativeInterchangePreview(origin:origin,options:options,source:copied,response:JSON(any:bad)); fatalError("Bad preview accepted") }
            catch { count += 1 }
        }
        let controller = NativeInterchangeImport()
        func settle() async throws { for _ in 0..<1000 { if !controller.busy { return }; try await Task.sleep(nanoseconds: 1_000_000) }; fatalError("Import task timed out") }
        check(controller.choose(model:model,session:session), "Picker could not capture")
        controller.selected(.success([input]),model:model,session:session); try await settle()
        check(controller.source != nil && controller.preview == nil && model.receives == 0, "Copy changed project or lacked source")
        let controllerSource = controller.source!
        previewFields["sourcePath"] = controllerSource.path; previewFields["sourceHash"] = controllerSource.hash
        backend.responder = { _,_,_ in JSON(any:previewFields) }
        controller.loadPreview(model:model,session:session); try await settle()
        check(controller.preview != nil && session.previewRequests == 1 && model.project?.text == origin.project && model.version == 7 && model.receives == 0, "Preview mutated local project")
        check(backend.calls.last!.2.flag("apply") == false, "Preview requested apply")
        backend.responder = { _,_,_ in throw ReelBackend.APIError("Malformed timeline") }
        controller.loadPreview(model:model,session:session); try await settle()
        check(controller.preview == nil && controller.message == "Malformed timeline" && model.receives == 0, "Preview parse error was hidden or mutated project")
        backend.responder = { _,_,_ in JSON(any:previewFields) }
        controller.loadPreview(model:model,session:session); try await settle()
        controller.options.replace = true; controller.settingsChanged()
        check(controller.preview == nil && controller.message.contains("options changed"), "Changed settings retained preview")
        controller.options.replace = false
        controller.loadPreview(model:model,session:session); try await settle()
        model.version = 8
        let beforeCalls = backend.calls.count
        controller.apply(model:model,session:session)
        check(backend.calls.count == beforeCalls && controller.preview == nil && controller.message.contains("changed"), "Stale apply dispatched")
        model.version = 7
        backend.responder = { _,_,_ in model.version = 8; return JSON(any:previewFields) }
        controller.loadPreview(model:model,session:session); try await settle()
        check(controller.preview == nil && model.receives == 0 && controller.message.contains("changed"), "Project drift during preview accepted")
        model.version = 7
        backend.responder = { method,_,body in
            if method == "GET" { return JSON(any:["version":8,"project":project]) }
            if body.flag("apply") { return JSON(any:["applied":true,"version":8]) }
            return JSON(any:previewFields)
        }
        controller.loadPreview(model:model,session:session); try await settle()
        model.select(ids:["old-selection"],primary:"old-selection"); model.time = 6
        let appliedBefore = backend.calls.filter { $0.2.flag("apply") }.count
        controller.apply(model:model,session:session); controller.apply(model:model,session:session); try await settle()
        check(backend.calls.filter { $0.2.flag("apply") }.count == appliedBefore + 1 && model.receives == 1 && model.version == 8, "Apply was not one request/one accepted snapshot")
        check(controller.preview == nil && controller.source == nil && controller.message.contains("Undo"), "Successful apply left reusable preview")
        check(model.composition == "compA" && model.selectedIDs == ["old-selection"] && model.selectedID == "old-selection" && model.time == 6 && model.requestedFrames == 0, "Scoped caption apply reset composition, selection or playhead")
        model.version = 7; model.project = NativeProject(fields:project)
        check(controller.choose(model:model,session:session), "New picker capture failed")
        controller.selected(.success([input]),model:model,session:session); controller.cancel(); try await Task.sleep(nanoseconds:100_000_000)
        check(controller.source == nil && controller.preview == nil && !controller.busy && model.receives == 1, "Cancellation accepted late copy")
        check(controller.choose(model:model,session:session), "Picker capture failed")
        model.version = 8; controller.selected(.success([input]),model:model,session:session)
        check(controller.source == nil && controller.message.contains("picker"), "Picker drift copied into new project")
        model.version = 7
        check(controller.choose(model:model,session:session), "Picker capture failed")
        controller.selected(.success([input]),model:model,session:session); try await settle()
        let lastSource = controller.source!
        previewFields["sourcePath"] = lastSource.path; previewFields["sourceHash"] = lastSource.hash
        backend.responder = { method,_,body in
            if body.flag("apply") { session.backend = ReelBackend(); return JSON(any:["applied":true,"version":8]) }
            return JSON(any:previewFields)
        }
        controller.loadPreview(model:model,session:session); try await settle()
        controller.apply(model:model,session:session); try await settle()
        check(controller.preview == nil && model.receives == 1 && controller.message.contains("editor changed"), "Reopened backend accepted apply result")
        controller.cancel(); session.backend = backend; model.version = 7; model.project = NativeProject(fields:project)
        check(controller.choose(model:model,session:session), "Late-edit picker capture failed")
        controller.selected(.success([input]),model:model,session:session); try await settle()
        let lateSource = controller.source!
        previewFields["sourcePath"] = lateSource.path; previewFields["sourceHash"] = lateSource.hash
        backend.responder = { method,_,body in
            if method == "GET" { model.version = 9; return JSON(any:["version":9,"project":["name":"Agent edit"]]) }
            if body.flag("apply") { return JSON(any:["applied":true,"version":8]) }
            return JSON(any:previewFields)
        }
        controller.loadPreview(model:model,session:session); try await settle()
        controller.apply(model:model,session:session); try await settle()
        check(controller.preview == nil && model.receives == 1 && controller.message.contains("after the import"), "Late agent edit was overwritten by import refresh")
        controller.cancel(); model.version = 7; model.project = NativeProject(fields:project)
        check(controller.choose(model:model,session:session), "Timeline picker capture failed")
        let timeline = external.appendingPathComponent("Timeline.otio")
        try Data("{\"OTIO_SCHEMA\":\"Timeline.1\"}".utf8).write(to:timeline)
        controller.selected(.success([timeline]),model:model,session:session); try await settle()
        let timelineSource = controller.source!
        let imported: [String: Any] = ["name":"Imported","width":1280,"height":720,"fps":24,"tracks":[["id":"V1","kind":"video","clips":[]]],"comps":[:]]
        let timelinePreview: [String: Any] = ["sourcePath":timelineSource.path,"sourceHash":timelineSource.hash,"version":7,"project":imported,"missing":["media/missing.mov"],"warnings":["Offline media"]]
        backend.responder = { method,_,body in
            if method == "GET" { model.version = 9; return JSON(any:["version":9,"project":imported]) }
            if body.flag("apply") { return JSON(any:["applied":true,"version":8]) }
            return JSON(any:timelinePreview)
        }
        controller.loadPreview(model:model,session:session); try await settle()
        controller.apply(model:model,session:session); try await settle()
        check(model.receives == 1 && model.project?.name == "Original" && model.composition == "compA" && model.selectedIDs == ["old-selection"] && model.time == 6 && model.requestedFrames == 0, "Rejected timeline snapshot reset current editor context")
        check(controller.preview == nil && controller.message.contains("after the import"), "Stale timeline snapshot retained apply preview")
        model.version = 7
        backend.responder = { method,_,body in
            if method == "GET" { return JSON(any:["version":8,"project":imported]) }
            if body.flag("apply") { return JSON(any:["applied":true,"version":8,"project":imported]) }
            return JSON(any:timelinePreview)
        }
        controller.loadPreview(model:model,session:session); try await settle()
        check(model.project?.name == "Original" && controller.preview?.project?.name == "Imported" && controller.preview?.missing == ["media/missing.mov"], "Timeline preview replaced local project")
        controller.apply(model:model,session:session); try await settle()
        check(model.project?.name == "Imported" && model.version == 8 && model.receives == 2, "Timeline apply did not open actual replacement")
        check(model.composition == nil && model.selectedID == nil && model.selectedIDs.isEmpty && model.time == 0 && model.requestedFrames == 1, "Timeline replacement retained obsolete editor context")
        check(model.receivedCompositions.last! == nil, "Timeline replacement was published under an obsolete composition")
        check(backend.calls.filter { $0.2.flag("apply") }.last!.2["track"] == nil && controller.message.contains("Project replaced from timeline"), "Timeline apply carried caption options or mislabeled action")
        backend.responder = { _,_,_ in JSON(any:[:]) }
        let beforeEditCalls = backend.calls.count
        model.editBatch([["op":"add_title","text":"After import","track":"V1","start":0,"dur":1]],summary:"Edit imported main timeline",expectedVersion:8)
        for _ in 0..<1000 { if backend.calls.count > beforeEditCalls { break }; try await Task.sleep(nanoseconds:1_000_000) }
        check(backend.calls.count == beforeEditCalls + 1 && backend.calls.last!.1 == "/api/ops", "First edit after replacement was not dispatched once")
        let editRequest = backend.calls.last!.2
        check(Int(editRequest.number("expectedVersion")) == 8 && editRequest.objects("ops").first!["comp"] is NSNull, "First edit retained removed composition or wrong version")
        try Data(JSON(any:["project":imported,"body":editRequest]).text.utf8).write(to:URL(fileURLWithPath:CommandLine.arguments[2]))
        controller.cancel(); model.version = 7; model.project = NativeProject(fields:project); model.composition = "compA"
        check(controller.choose(model:model,session:session), "Options capture failed")
        controller.selected(.success([input]),model:model,session:session); try await settle()
        previewFields["sourcePath"] = controller.source!.path; previewFields["sourceHash"] = controller.source!.hash
        backend.responder = { _,_,_ in controller.options.replace = true; return JSON(any:previewFields) }
        controller.loadPreview(model:model,session:session); try await settle()
        check(controller.preview == nil && model.receives == 2 && controller.message.contains("options changed"), "Changed options accepted async preview")
        controller.options.replace = false
        backend.responder = { _,_,_ in var changed = previewFields; changed["sourceHash"] = "changed"; return JSON(any:changed) }
        controller.loadPreview(model:model,session:session); try await settle()
        check(controller.preview == nil && controller.message.contains("source or project changed"), "Changed copied input hash accepted preview")
        controller.cancel(); NativeInterchangeFile.discard(copied); NativeInterchangeFile.discard(xml)
        print("Passed \(count) production interchange copy, preview, request and guard checks")
    }
}
'''
    source = 'import Foundation\nimport CryptoKit\nimport Darwin\nimport SwiftUI\n' + json_source + '\n' + folder + '\n' + projections + '\n' + dictionary + '\n' + selection + '\n' + fixture + '\n' + implementation + '\n' + block(project, 'func nativeTimecode(') + '\n' + checks
    with tempfile.TemporaryDirectory(prefix='reel-import-tests-') as temp:
        temp = Path(temp)
        swift = temp / 'ImportChecks.swift'
        binary = temp / 'ImportChecks'
        cache = temp / 'module-cache'
        swift.write_text(source)
        subprocess.run(['xcrun','swiftc','-j1','-parse-as-library','-module-cache-path',str(cache),str(swift),'-o',str(binary)],check=True)
        replay = temp / 'post-import-edit.json'
        subprocess.run([str(binary),str(temp / 'fixtures'),str(replay)],check=True)
        js = '''import fs from 'node:fs'; import assert from 'node:assert/strict'; import {applyOps} from './editor/core/project.js';
const row=JSON.parse(fs.readFileSync(process.argv[1]));
const before=structuredClone(row.project);
assert.equal(row.body.expectedVersion,8);
assert.equal(row.body.ops[0].comp,null);
assert.equal(row.project.comps.compA,undefined);
const {project}=applyOps(before,row.body.ops);
assert.deepEqual(before,row.project);
assert.equal(project.tracks[0].clips.length,1);
assert.equal(project.tracks[0].clips[0].kind,'title');
assert.equal(project.tracks[0].clips[0].title.text,'After import');
assert.deepEqual(project.comps,{});
assert.throws(()=>applyOps(row.project,row.body.ops.map(op=>({...op,comp:'compA'}))),/no composition compA/);
console.log('Passed post-import production editBatch request through shared applyOps; obsolete composition rejects.');'''
        subprocess.run(['node','--input-type=module','-e',js,str(replay)],cwd=repo,check=True)
        # The same production sheet is type-checked with narrow observable fixtures.
        ui_fixture = fixture.replace('var folder: URL?', '@Published var folder: URL?').replace('var project: NativeProject?', '@Published var project: NativeProject?').replace('var version = 7', '@Published var version = 7').replace('var composition: String?', '@Published var composition: String?')
        model_helpers = '''
    var busy = false
    var capabilities: [String: Any] = [:]
    var jobs: [[String: Any]] = []
    var metalFrame: Int?
    var width = 1920.0
    var height = 1080.0
    func mediaURL(_ path: String) throws -> URL { URL(fileURLWithPath:path) }
    private var hapticPolicy = NativeHapticPolicy()
'''
        # The Deliver panel registers export jobs for completion feedback through the production model methods.
        model_helpers += '\n'.join(block(model_implementation, marker) for marker in ['func registerExportFeedback(', 'func confirmExportFeedback(']) + '\n'
        ui_fixture = ui_fixture.replace('    var receives = 0', model_helpers + '    var receives = 0')
        # Delivery UI is type-checked here too; only its backend access seam is inert.
        # Real output/read-only/reopen behavior belongs to DeliveryHistoryBackendTests.
        ui_fixture = ui_fixture.replace('    var previewRequests = 0', '    let sessionID = \"import-fixture\"\n    var previewRequests = 0')
        ui_fixture = ui_fixture.replace('    var calls:', '    let folder = ProjectFolder(root: FileManager.default.temporaryDirectory)\n    func deliveryURL(id: String, root: String) async throws -> URL { throw APIError("No delivery interaction in the import fixture") }\n    var calls:')
        mobile_fixture = '''
@MainActor final class NativeMobileExport: ObservableObject {
    static let shared = NativeMobileExport()
    var message = ""
    var pending = false
    var canResume = false
    func resume() { }
    func discard() { }
    func start(session: EditorSession, body: [String: Any]) async throws -> [String: Any] { [:] }
}
'''
        controls = (editor / 'NativeControls.swift').read_text()
        style = block(controls, 'enum NativeEditorStyle {') + '\n' + block(controls, 'enum NativeType {') + '\n' + block(controls, 'enum NativeRadius {')
        toolbar = block(controls, 'struct NativeToolbarButtonStyle: ButtonStyle {')
        number_row = block(controls, 'struct NativeNumberRow: View {')
        padding = block(controls, 'extension View {')
        ui_source = 'import Foundation\nimport CryptoKit\nimport Darwin\nimport SwiftUI\nimport UniformTypeIdentifiers\n' + json_source + '\n' + folder + '\n' + projections + '\n' + dictionary + '\n' + selection + '\n' + ui_fixture + '\n' + implementation + '\n' + style + '\n' + toolbar + '\nfunc nativeTimecode(_ time: Double, fps: Double) -> String { String(time) }\n' + block(deliver, 'struct NativeInterchangeImportSheet: View {') + '\n' + number_row + '\n' + padding + '\n' + mobile_fixture + '\n' + block(deliver, 'enum NativeExportDimensions {') + '\n' + block(deliver, 'struct NativeInterchangeSheetDestination: Identifiable {') + '\n' + block(deliver, 'private struct NativeDeliveryHistoryView: View {') + '\n' + block(deliver, 'struct NativeDeliverPanel: View {')
        swift.write_text(ui_source)
        for sdk,target in [('macosx','arm64-apple-macos14.0'),('iphonesimulator','arm64-apple-ios17.0-simulator')]:
            sdk_path = subprocess.check_output(['xcrun','--sdk',sdk,'--show-sdk-path'],text=True).strip()
            subprocess.run(['xcrun','swiftc','-j1','-typecheck','-sdk',sdk_path,'-target',target,'-module-cache-path',str(cache),str(swift)],check=True)
        print('Production Deliver panel and import sheet type-check for macOS 14 and iOS 17 Simulator. No app build or UI launch ran.')


if __name__ == '__main__':
    main()
