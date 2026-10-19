#!/usr/bin/env python3
"""Exercise production color copy, batch, preset, LUT and local comparison helpers."""
from pathlib import Path
import json
import subprocess
import tempfile


def block(text, marker):
    start = text.index(marker)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end].replace('private func ', 'func ').replace('private var ', 'var ')


def main():
    repo = Path(__file__).resolve().parents[2]
    editor = repo / 'native/App/Shared/NativeEditor'
    kit = repo / 'native/ReelKit/Sources/ReelKit'
    color = (editor / 'NativeColorPanel.swift').read_text()
    deliver = (editor / 'NativeDeliverPanel.swift').read_text()
    project = (editor / 'NativeProject.swift').read_text()
    controls = (editor / 'NativeControls.swift').read_text()
    textures = (kit / 'Rendering/NativeGradeTextures.swift').read_text()
    source = 'import Foundation\nimport SwiftUI\nimport CoreGraphics\nimport CryptoKit\nimport Darwin\nimport UniformTypeIdentifiers\n'
    source += (kit / 'JSON.swift').read_text() + '\n' + block((kit / 'ProjectFolder.swift').read_text(), 'public struct ProjectFolder: Sendable')
    source += '\n' + project[project.index('struct NativeProject {'):project.index('enum NativeProcessingRequests {')]
    source += '\n' + block(project, 'extension Dictionary where Key == String, Value == Any') + '\n' + block(project, 'func nativeTimecode(')
    source += '\n' + block(deliver, 'struct NativeInterchangeSource: Sendable') + '\n' + block(deliver, 'struct NativeInterchangeOptions: Equatable') + '\n' + block(deliver, 'struct NativeInterchangeOrigin: Equatable') + '\n' + block(deliver, 'enum NativeInterchangeDisplay {')
    source += '\n' + block(color, 'struct NativeColorGraphPlanner {') + '\n' + block(color, 'extension NativeColorGraphPlanner {')
    model_source = (editor / 'NativeEditorModel.swift').read_text()
    for marker in ['struct NativeRenderPreviewCapture {','struct NativeDisplayedFrameCapture {','struct NativeViewerColorPicker {','struct NativeViewerComparison {']:
        source += '\n' + block(model_source, marker)
    for marker in ['struct NativeColorWorkflowCapture {','struct NativeColorGradeClipboard {','enum NativeColorWorkflows {','struct NativeColorLUTSource: Sendable','enum NativeColorLUTFile {','struct NativeColorLUTPreview {','struct NativeColorLUTExportDocument: FileDocument {','struct NativeColorPixelBuffer {','struct NativeColorGalleryProvenance {','struct NativeColorGalleryStill: Identifiable','final class NativeColorGalleryStore: ObservableObject']:
        source += '\n' + block(color, marker)
    source += '\n' + block(color, 'enum NativeColorBuiltinPresets {')
    source += '\n' + block(textures, 'public enum ReelLUTInspection {') + '\n' + block(textures, 'struct NativeLUTSource {') + '\n' + block(textures, 'struct NativeCube {')
    fixture = '''
struct ReelRenderingError: LocalizedError { let errorDescription: String?; init(_ message: String) { errorDescription = message } }
final class ReelRenderedFrame { let image:CGImage;init(_ image:CGImage) {self.image=image} }
@MainActor final class ReelBackend {
    struct APIError: Error, LocalizedError { let errorDescription: String?; init(_ text: String) { errorDescription = text } }
    var calls: [(String,[String:Any])] = []
    var responder: ((String,[String:Any]) async throws -> JSON)?
    func handle(method: String,path: String,body: String?) async throws -> JSON {
        let fields = try body.map { try JSON.parse($0) as? [String:Any] ?? [:] } ?? [:]
        calls.append((path,fields)); return try await responder?(path,fields) ?? JSON(any:[:])
    }
}
@MainActor final class EditorSession: ObservableObject {
    @Published var folder: URL?
    var backend: ReelBackend?
    var sessionID = "one"
}
@MainActor final class NativeEditorModel: ObservableObject {
    @Published var project: NativeProject?
    @Published var version = 7
    @Published var selectedID: String? = "c1"
    @Published var selectedIDs: Set<String> = ["c1","c2","a1"]
    var folder: URL?
    var composition: String? = "nested"
    var tracks: [NativeTrack] { project?.tracks(in:composition) ?? [] }
    var selected: NativeClip? { tracks.flatMap(\\.clips).first { $0.id == selectedID } }
    var status = ""
    var pending = 0
    var receives = 0
    var fps = 30.0
    var time = 1.0
    var displayedTime: Double? = 1.0
    var frame: CGImage?
    var frameGeneration=UUID(),frameRevision=UUID()
    var processingContextID:UUID {frameGeneration}
    func renderPreviewCommitMatches(_ capture:NativeRenderPreviewCapture)->Bool {capture.matches(generation:frameGeneration,revision:frameRevision,folder:folder,version:version,composition:composition,selection:selectedIDs,time:time) && !playing && !scrubbing && !busy}
    @Published var viewerColorPicker:NativeViewerColorPicker?
    @Published var viewerComparison:NativeViewerComparison?
    @Published var viewerComparisonFraction=0.5
    var mobilePanel:Int?
    var playing=false,scrubbing=false,busy=false,previewing=false
    func captureDisplayedCommittedFrame()->NativeDisplayedFrameCapture? {
        guard let frame,let folder else {return nil}
        let context=NativeRenderPreviewCapture(id:UUID(),generation:frameGeneration,revision:frameRevision,folder:folder,version:version,composition:composition,selection:selectedIDs,time:time)
        return NativeDisplayedFrameCapture(context:context,image:frame,renderedFrame:ReelRenderedFrame(frame),canvasAspect:Double(frame.width)/Double(frame.height),colorSpace:"Fixture readback",selectedID:selectedID)
    }
    func frameCaptureMatches(_ capture:NativeDisplayedFrameCapture)->Bool {
        capture.context.matches(generation:frameGeneration,revision:frameRevision,folder:folder,version:version,composition:composition,selection:selectedIDs,time:time)
    }
    func viewerComparisonMatches(_ comparison:NativeViewerComparison)->Bool {comparison.context.generation==frameGeneration && comparison.context.folder==folder && comparison.context.composition==composition}
    func perform(_ action: @escaping @MainActor () async throws -> Void) {
        pending += 1
        Task { defer { pending -= 1 }; do { try await action() } catch { status = error.localizedDescription } }
    }
    func receive(_ event: String,_ text: String) {
        receives += 1
        let fields = try! JSON.parse(text) as! [String:Any]
        version = Int(fields.number("version")); project = NativeProject(fields:fields.dictionary("project"))
    }
}
@MainActor final class PanelChecks {
    let model: NativeEditorModel
    let session: EditorSession
    var nodeID = "n2"
    var lutSelectionCapture: NativeColorWorkflowCapture?
    var inspectedLUT: NativeColorLUTPreview?
    var inspectingLUT = false
    var lutGeneration = UUID()
    var luts: [String] = []
    var lutMix = 0.75
    var lutSpace = "srgb"
    var lutBatch = false
    var lutSectionExpanded = false
    var exportingLUT = false
    var lutExportDocument: NativeColorLUTExportDocument?
    var lutExportCapture: NativeColorWorkflowCapture?
    let colorGallery=NativeColorGalleryStore()
    var stills:[NativeColorGalleryStill] {get {colorGallery.stills} set {colorGallery.stills=newValue}}
    var comparisonID: UUID?
    init(model: NativeEditorModel,session: EditorSession) { self.model = model; self.session = session }
'''
    for marker in ['private func clearGradeLUT(','private func submitColorOperations(','private func batchGrade(','private func applyNodePreset(','private func saveNodePreset(','private func removeNodePreset(','private func lutTargetKind(','private func inspectColorLUT(','private func importColorLUT(','private func exportColorLUT(','private func applyColorLUT(','private func grabColorStill(','private func compareColorStill(']:
        fixture += block(color,marker).replace('model.perform {', 'model.perform { [self] in') + '\n'
    fixture += '}\n'
    tests = r'''
func require(_ yes: Bool,_ message: String) { if !yes { fatalError(message) } }
@main struct WorkflowChecks {
    @MainActor static func main() async throws {
        var count = 0
        func check(_ yes: Bool,_ message: String) { require(yes,message); count += 1 }
        let root = URL(fileURLWithPath:CommandLine.arguments[1]), external = root.appendingPathComponent("external"), folderURL = root.appendingPathComponent("project")
        try FileManager.default.createDirectory(at:external,withIntermediateDirectories:true)
        try FileManager.default.createDirectory(at:folderURL,withIntermediateDirectories:true)
        let folder = ProjectFolder(root:folderURL)
        let backend = ReelBackend(), session = EditorSession(), model = NativeEditorModel()
        session.backend = backend; session.folder = folderURL; model.folder = folderURL
        let graph = NativeColorGraphPlanner.defaultGraph
        let tracks: [[String:Any]] = [["id":"V1","kind":"video","clips":[["id":"c1","kind":"video","start":0,"dur":1,"grade":["contrast":1.2],"nodes":graph],["id":"c2","kind":"image","start":1,"dur":1,"grade":["exposure":1]]]], ["id":"A1","kind":"audio","clips":[["id":"a1","kind":"audio","start":0,"dur":2]]]]
        let project: [String:Any] = ["name":"Original","width":1920,"height":1080,"fps":30,"tracks":[],"assets":[:],"comps":["nested":["width":1920,"height":1080,"fps":30,"tracks":tracks]]]
        model.project = NativeProject(fields:project)
        let panel = PanelChecks(model:model,session:session)
        let capture = NativeColorWorkflowCapture.capture(model:model,session:session,node:"n2",renderedVersion:7)!
        check(capture.matches(model:model,session:session,node:"n2"),"Fresh workflow capture mismatches")
        for axis in 0..<7 {
            model.project = NativeProject(fields:project); model.version = 7; model.selectedID = "c1"; model.selectedIDs = ["c1","c2","a1"]; model.folder = folderURL; model.composition = "nested"; session.backend = backend; panel.nodeID = "n2"
            switch axis {
            case 0: model.version = 8
            case 1: model.selectedIDs = ["c1"]
            case 2: model.selectedID = "c2"
            case 3: model.composition = nil
            case 4: session.backend = ReelBackend()
            case 5: model.project = NativeProject(fields:["name":"Changed"])
            default: panel.nodeID = "n4"
            }
            check(!capture.matches(model:model,session:session,node:panel.nodeID),"Stale workflow accepted axis \(axis)")
            let before = backend.calls.count
            panel.submitColorOperations([["op":"update","id":"c1","set":["grade":NSNull()]]],capture:capture,summary:"Stale")
            check(backend.calls.count == before,"Stale workflow dispatched")
        }
        model.project = NativeProject(fields:project); model.version = 7; model.selectedID = "c1"; model.selectedIDs = ["c1","c2","a1"]; model.folder = folderURL; model.composition = "nested"; session.backend = backend; panel.nodeID = "n2"
        let clipboard = NativeColorGradeClipboard(grade:["contrast":1.2,"curves":["master":[[0,0],[1,1]]]],label:"Source")
        check(clipboard.valid && clipboard.grade?.number("contrast") == 1.2,"Grade clipboard did not preserve exact settings")
        let neutral = NativeColorGradeClipboard(grade:nil,label:"Neutral")
        check(neutral.valid && neutral.grade == nil,"Neutral grade copy failed")
        let targets = try NativeColorWorkflows.targets(tracks:model.tracks,selection:capture.selection)
        check(targets.map(\.id) == ["c1","c2"],"Batch included audio or lost selected visuals")
        do { _ = try NativeColorWorkflows.targets(tracks:model.tracks,selection:["missing"]); fatalError("Missing selection accepted") } catch { count += 1 }
        var locked = tracks; locked[0]["locked"] = true
        do { _ = try NativeColorWorkflows.targets(tracks:locked.map(NativeTrack.init),selection:["c1"]); fatalError("Locked selection accepted") } catch { count += 1 }
        for bad in ["","   ","__proto__","id"," id ",String(repeating:"x",count:121)] {
            do { _ = try NativeColorWorkflows.validName(bad); fatalError("Bad preset name accepted") } catch { count += 1 }
        }
        let preset = try NativeColorWorkflows.snapshot(model.selected!,name:"Saved graph")
        check(preset.string("name") == "Saved graph" && preset.dictionary("nodes").objects("list").count == 3 && preset.dictionary("grade").number("contrast") == 1.2,"Preset snapshot omitted graph/primary")
        let presetOps = try NativeColorWorkflows.preset(preset,targets:targets)
        check(presetOps.count == 6 && presetOps[1].dictionary("set")["grade"] is NSNull,"Preset did not replace each graph and primary grade atomically")
        do { _ = try NativeColorWorkflows.preset(preset,targets:[NativeClip(fields:["id":"adj","kind":"adjustment"])]); fatalError("Unrendered adjustment nodes accepted") } catch { count += 1 }
        var invalid = graph; invalid["links"] = [["from":"n3","to":"n2","input":0]]
        do { _ = try NativeColorWorkflows.validatedGraph(invalid); fatalError("Forbidden graph accepted") } catch { count += 1 }
        let lutFile = external.appendingPathComponent("Identity.cube")
        let cube = "TITLE \"Identity\"\r\nLUT_3D_SIZE 2\r\n" + (0..<8).map { "\($0 & 1) \(($0 >> 1) & 1) \(($0 >> 2) & 1)" }.joined(separator:"\r\n") + "\r\n"
        let cubeData = Data([0xef,0xbb,0xbf]) + Data(cube.utf8)
        try cubeData.write(to:lutFile)
        let sourceCopy = try NativeColorLUTFile.copy(lutFile,into:folder)
        check(try Data(contentsOf:lutFile) == cubeData && Data(contentsOf:folder.resolve(sourceCopy.path)) == cubeData,"LUT source/copy bytes changed")
        let actual = try JSON.parse(ReelLUTInspection.inspect(text:ReelLUTInspection.sourceText(from:Data(contentsOf:folder.resolve(sourceCopy.path)))).text) as! [String:Any]
        check(actual.string("sourceHash") == sourceCopy.sourceHash && sourceCopy.rawHash == sourceCopy.sourceHash,"LUT hash did not preserve the source BOM and exact bytes")
        let copy2 = try NativeColorLUTFile.copy(lutFile,into:folder)
        check(sourceCopy.path != copy2.path,"LUT destination was reused")
        func rejects(_ file: URL,_ destination: ProjectFolder = folder) throws {
            do { _ = try NativeColorLUTFile.copy(file,into:destination); fatalError("Bad CUBE accepted") } catch { count += 1 }
        }
        let bad = external.appendingPathComponent("Bad.cube"); try Data("LUT_1D_SIZE 2\n0 0 0\n1 1 1".utf8).write(to:bad); try rejects(bad)
        let binary = external.appendingPathComponent("Binary.cube"); try Data([0xff]).write(to:binary); try rejects(binary)
        let link = external.appendingPathComponent("Link.cube"); try FileManager.default.createSymbolicLink(at:link,withDestinationURL:lutFile); try rejects(link)
        let huge = external.appendingPathComponent("Huge.cube"); FileManager.default.createFile(atPath:huge.path,contents:nil)
        let handle = try FileHandle(forWritingTo:huge); try handle.truncate(atOffset:UInt64(NativeColorLUTFile.maximumBytes+1)); try handle.close(); try rejects(huge)
        let linkedRoot = root.appendingPathComponent("linked-project"); try FileManager.default.createDirectory(at:linkedRoot,withIntermediateDirectories:true)
        try FileManager.default.createSymbolicLink(at:linkedRoot.appendingPathComponent("luts"),withDestinationURL:external); try rejects(lutFile,ProjectFolder(root:linkedRoot))
        let paths = try NativeColorWorkflows.lutPaths([["op":"update","set":["grade":["lut":"alias.cube"],"nodes":["list":[["lut":"alias.cube"],["grade":["lut":"second.cube"]]]]]]])
        check(paths == ["alias.cube","second.cube"],"Referenced LUT paths were not deduplicated")
        let normalized = NativeColorWorkflows.canonicalLUTs(["grade":["lut":"alias.cube"],"nodes":["list":[["lut":"alias.cube"]]]],paths:["alias.cube":sourceCopy.path])
        check(normalized.dictionary("grade").string("lut") == sourceCopy.path && normalized.dictionary("nodes").objects("list")[0].string("lut") == sourceCopy.path,"LUT aliases were not canonicalized")
        func settle() async throws { for _ in 0..<1000 { if model.pending == 0 { return }; try await Task.sleep(nanoseconds:1_000_000) }; fatalError("Color task timed out") }
        for builtIn in NativeColorBuiltinPresets.values {
            check(try NativeColorWorkflows.preset(builtIn,targets:targets).count == 2,"Built-in preset overwrote primary grades")
        }
        try NativeColorBuiltinPresets.text.write(toFile:CommandLine.arguments[3],atomically:true,encoding:.utf8)
        var replay: [[String:Any]] = []
        backend.responder = { path,body in
            if path == "/api/luts/inspect" {
                let file = try folder.resolve(body.string("path")); var result = try JSON.parse(ReelLUTInspection.inspect(text:ReelLUTInspection.sourceText(from:Data(contentsOf:file))).text) as! [String:Any]; result["path"] = folder.relative(file); return JSON(any:result)
            }
            if path == "/api/ops" { replay.append(["project":model.project!.fields,"body":body]); return JSON(any:["version":8,"project":model.project!.fields]) }
            return JSON(any:["applied":true,"version":8,"project":project])
        }
        panel.batchGrade(clipboard,capture:capture); try await settle()
        let batch = backend.calls.last!.1
        check(batch.objects("ops").count == 4 && batch.objects("ops").allSatisfy { $0.string("comp") == "nested" } && Int(batch.number("expectedVersion")) == 7,"Batch lost atomic request or captured comp/version")
        model.version = 7; model.project = NativeProject(fields:project)
        panel.saveNodePreset(preset,capture:capture); try await settle()
        check(backend.calls.last!.1.objects("ops")[0]["comp"] is NSNull,"Project preset was incorrectly scoped to a composition")
        model.version = 7; model.project = NativeProject(fields:project)
        var legacy = preset; legacy["name"] = "id"
        let callsBeforeReservedSave = backend.calls.count
        panel.saveNodePreset(legacy,capture:capture); try await settle()
        check(backend.calls.count == callsBeforeReservedSave && model.status.contains("reserved"),"Direct reserved-name save dispatched")
        var keep = preset; keep["name"] = "Keep"
        var legacyProject = project; legacyProject["nodePresets"] = ["id":legacy,"Keep":keep]
        model.project = NativeProject(fields:legacyProject)
        let legacyCapture = NativeColorWorkflowCapture.capture(model:model,session:session,node:panel.nodeID,renderedVersion:model.version)!
        panel.removeNodePreset(legacy,capture:legacyCapture); try await settle()
        let legacyRemoval = backend.calls.last!.1.objects("ops")
        check(legacyRemoval.count == 2 && legacyRemoval[0].dictionary("set")["nodePresets"] is NSNull,"Legacy reserved preset removal did not replace the map atomically")
        check(legacyRemoval[1].dictionary("set").dictionary("nodePresets").count == 1 && legacyRemoval[1].dictionary("set").dictionary("nodePresets")["Keep"] != nil,"Legacy removal lost another preset")
        replay[replay.count-1]["deletedPreset"] = "id"
        model.version = 7; model.project = NativeProject(fields:project)
        panel.removeNodePreset(preset,capture:capture); try await settle()
        model.version = 7; model.project = NativeProject(fields:project)
        panel.applyNodePreset(preset,capture:capture); try await settle()
        check(backend.calls.last!.1.objects("ops").count == 6,"Preset application was not one batch")
        model.version = 7; model.project = NativeProject(fields:project)
        panel.submitColorOperations([["op":"update","id":"c1","set":["grade":["lut":sourceCopy.path]]]],capture:capture,summary:"Referenced LUT")
        try await settle()
        let guarded = backend.calls.last!.1
        check(guarded.objects("expectedInputs").count == 1 && guarded.objects("expectedInputs")[0].string("sourceHash") == sourceCopy.sourceHash,"Batch did not include actual inspected LUT hash")
        model.version = 7; model.project = NativeProject(fields:project)
        let before = backend.calls.filter { $0.0 == "/api/ops" }.count
        backend.responder = { _,_ in model.version = 8; return JSON(any:["path":sourceCopy.path,"sourceHash":sourceCopy.sourceHash]) }
        panel.submitColorOperations([["op":"update","id":"c1","set":["grade":["lut":sourceCopy.path]]]],capture:capture,summary:"Stale referenced LUT")
        try await settle()
        check(backend.calls.filter { $0.0 == "/api/ops" }.count == before && model.status.contains("changed"),"Edit during LUT inspection dispatched batch")
        model.version = 7; model.project = NativeProject(fields:project)
        var response = actual; response["path"] = sourceCopy.path
        let preview = try NativeColorLUTPreview(response:JSON(any:response),capture:capture,targetKind:"clipGrade")
        let request = try preview.request(mix:0.5,space:"working",targets:[["id":"c1","kind":"clipGrade"]])
        check(request.string("expectedInputHash") == sourceCopy.sourceHash && request.string("comp") == "nested" && Int(request.number("expectedVersion")) == 7,"LUT apply request lost source/destination guard")
        do { _ = try preview.request(mix:.nan,space:"srgb",targets:[["id":"c1"]]); fatalError("Invalid mix accepted") } catch { count += 1 }
        let exportText = try ReelLUTInspection.sourceText(from:cubeData)
        var exported=actual; exported["path"]=sourceCopy.path; exported["text"]=exportText
        let document=try NativeColorLUTExportDocument(response:JSON(any:exported),preview:preview)
        check(document.data==cubeData && document.filename==(sourceCopy.path as NSString).lastPathComponent,"Export document changed CUBE bytes or filename")
        for mutation:[String:Any] in [["text":cube],["path":"luts/another.cube"],["sourceHash":String(repeating:"0",count:64)],["size":3],["domainMin":[0.1,0,0]],["domainMax":[2,1,1]]] {
            do { _=try NativeColorLUTExportDocument(response:JSON(any:exported.merging(mutation){_,next in next}),preview:preview);fatalError("Mismatched LUT export accepted") } catch {count += 1}
        }
        backend.responder = { _,_ in JSON(any:exported) }
        panel.exportColorLUT(preview);try await settle()
        check(backend.calls.last!.0=="/api/luts/export" && backend.calls.last!.1.string("expectedInputHash")==sourceCopy.sourceHash,"LUT export did not require the inspected hash")
        check(panel.exportingLUT && panel.lutExportDocument?.data==cubeData && model.version==7,"Export did not prepare an exact snapshot without editing")
        panel.exportingLUT=false;panel.lutExportDocument=nil;panel.lutExportCapture=nil
        backend.responder = { _,_ in model.selectedIDs=["c1"];return JSON(any:exported) }
        panel.exportColorLUT(preview);try await settle()
        check(!panel.exportingLUT && panel.lutExportDocument==nil && model.version==7,"Selection drift opened the wrong LUT export")
        model.selectedIDs=capture.selection
        backend.responder = { _,_ in JSON(any:["applied":true,"version":8,"project":project]) }
        panel.inspectedLUT = preview; panel.lutBatch = true; panel.applyColorLUT(preview); try await settle()
        check(backend.calls.last!.0 == "/api/luts/apply" && backend.calls.last!.1.objects("targets").map { $0.string("id") } == ["c1","c2"],"LUT batch did not use captured visual targets")
        check(panel.inspectedLUT == nil && model.version == 8,"LUT apply left stale preview")
        model.version = 7; model.project = NativeProject(fields:project)
        let beforeApply = backend.calls.count
        model.selectedIDs = ["c1"]; panel.applyColorLUT(preview)
        check(backend.calls.count == beforeApply,"Selection drift applied inspected LUT")
        model.selectedIDs = capture.selection
        backend.responder = { _,body in var result=actual; result["path"]=body.string("path"); return JSON(any:result) }
        panel.inspectedLUT=nil; let initialReceives=model.receives
        panel.inspectColorLUT(sourceCopy.path,capture:capture); try await settle()
        check(panel.inspectedLUT?.sourceHash==sourceCopy.sourceHash && model.version==7 && model.receives==initialReceives,"Inspection mutated project or lost actual parser hash")
        panel.inspectedLUT=nil
        backend.responder = { _,body in model.selectedIDs=["c1"]; var result=actual; result["path"]=body.string("path"); return JSON(any:result) }
        panel.inspectColorLUT(sourceCopy.path,capture:capture); try await settle()
        check(panel.inspectedLUT==nil && model.receives==initialReceives && model.status.contains("changed"),"Async inspection accepted changed selection")
        model.selectedIDs=capture.selection
        func lutFiles() throws -> [String] { try FileManager.default.contentsOfDirectory(atPath:folderURL.appendingPathComponent("luts").path).sorted() }
        let filesBefore=try lutFiles(), callsBeforePicker=backend.calls.count
        panel.lutSelectionCapture=capture; model.version=8; panel.importColorLUT(.success([lutFile])); try await settle()
        check(try lutFiles()==filesBefore && backend.calls.count==callsBeforePicker && panel.lutSelectionCapture==nil,"Stale picker copied a source or dispatched inspection")
        model.version=7; panel.lutSelectionCapture=capture; panel.importColorLUT(.success([])); try await settle()
        check(try lutFiles()==filesBefore && backend.calls.count==callsBeforePicker && panel.lutSelectionCapture==nil,"Empty picker selection mutated state")
        panel.lutSelectionCapture=capture; panel.importColorLUT(.failure(CocoaError(.userCancelled))); try await settle()
        check(try lutFiles()==filesBefore && backend.calls.count==callsBeforePicker && !panel.inspectingLUT,"Canceled picker performed import")
        backend.responder = { _,body in
            let file=try folder.resolve(body.string("path")); var result=try JSON.parse(ReelLUTInspection.inspect(text:ReelLUTInspection.sourceText(from:Data(contentsOf:file))).text) as! [String:Any]; result["path"]=folder.relative(file); return JSON(any:result)
        }
        panel.lutSelectionCapture=capture; panel.importColorLUT(.success([lutFile])); try await settle()
        let imported=panel.inspectedLUT!
        check(try lutFiles().count==filesBefore.count+1 && imported.sourceHash==sourceCopy.sourceHash && imported.path != sourceCopy.path && model.version==7 && model.receives==initialReceives,"Actual picker import changed project or reused source path")
        check(try Data(contentsOf:lutFile)==cubeData && Data(contentsOf:folder.resolve(imported.path))==cubeData,"Actual picker import modified original/copied bytes")
        try FileManager.default.removeItem(at:folder.resolve(imported.path)); panel.inspectedLUT=nil
        backend.responder = { _,body in var result=actual; result["path"]=body.string("path"); result["sourceHash"]=String(repeating:"0",count:64); return JSON(any:result) }
        panel.lutSelectionCapture=capture; panel.importColorLUT(.success([lutFile])); try await settle()
        check(try lutFiles()==filesBefore && panel.inspectedLUT==nil && !panel.inspectingLUT && model.status.contains("changed"),"Changed copied hash retained source or preview")
        backend.responder = { _,body in model.selectedIDs=["c1"]; var result=actual; result["path"]=body.string("path"); return JSON(any:result) }
        panel.lutSelectionCapture=capture; panel.importColorLUT(.success([lutFile])); try await settle()
        check(try lutFiles()==filesBefore && panel.inspectedLUT==nil && model.receives==initialReceives,"Async import selection drift retained copy or changed project")
        model.selectedIDs=capture.selection; panel.lutBatch=true
        backend.responder = { _,_ in panel.lutMix=0.5; return JSON(any:["applied":true,"version":8,"project":project]) }
        panel.inspectedLUT=preview; panel.applyColorLUT(preview); try await settle()
        check(panel.inspectedLUT==nil && model.receives==initialReceives && model.status.contains("changed"),"Changed LUT form accepted response into current editor")
        panel.lutMix=0.75
        backend.responder = { _,_ in JSON(any:["version":9,"project":project]) }
        panel.clearGradeLUT(model.selected!,primary:true,capture:capture); try await settle()
        check(model.receives==initialReceives && model.status.contains("changed"),"Unexpected operation result version replaced editor")
        var nodeProject=project; var nodeComp=nodeProject["comps"] as! [String:[String:Any]]; var nodeTracks=tracks; var nodeClips=nodeTracks[0].objects("clips"); var nodes=graph
        for (type,kind) in [("corrector","nodeGrade"),("lut","lutNode")] {
            var list=graph.objects("list"); list[1]["type"]=type; nodes["list"]=list; nodeClips[0]["nodes"]=nodes; nodeTracks[0]["clips"]=nodeClips; nodeComp["nested"]!["tracks"]=nodeTracks; nodeProject["comps"]=nodeComp; model.project=NativeProject(fields:nodeProject)
            let nodeCapture=NativeColorWorkflowCapture.capture(model:model,session:session,node:"n2",renderedVersion:7)!
            check(panel.lutTargetKind(nodeCapture)==kind,"LUT inspection chose wrong node destination kind")
        }
        model.project=NativeProject(fields:project)
        let bitmap = CGContext(data:nil,width:32,height:18,bitsPerComponent:8,bytesPerRow:128,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
        bitmap.setFillColor(CGColor(gray:0.5,alpha:1)); bitmap.fill(CGRect(x:0,y:0,width:32,height:18)); model.frame = bitmap.makeImage()
        for _ in 0..<25 { panel.grabColorStill() }
        check(panel.stills.count == 24 && panel.stills.allSatisfy { !$0.hash.isEmpty && $0.image.width <= 1280 && $0.image.height <= 1280 },"Gallery snapshot bounds/hash failed")
        check(model.version == 7,"Gallery capture changed project")
        NativeColorLUTFile.discard(sourceCopy); NativeColorLUTFile.discard(copy2)
        try JSON(any:replay).text.write(toFile:CommandLine.arguments[2],atomically:true,encoding:.utf8)
        print("Passed \(count) production Color workflow and LUT safeguards")
    }
}
'''
    with tempfile.TemporaryDirectory(prefix='reel-color-workflows-') as temp:
        temp = Path(temp)
        swift = temp / 'WorkflowChecks.swift'
        binary = temp / 'WorkflowChecks'
        cache = temp / 'module-cache'
        replay = temp / 'replay.json'
        builtins = temp / 'builtins.json'
        swift.write_text(source + '\n' + fixture + '\n' + tests)
        subprocess.run(['xcrun','swiftc','-parse-as-library','-module-cache-path',str(cache),str(swift),'-o',str(binary)],check=True)
        subprocess.run([str(binary),str(temp / 'fixtures'),str(replay),str(builtins)],check=True)
        subprocess.run(['node','--input-type=module','-e',"import fs from 'node:fs';import assert from 'node:assert/strict';import {BUILTIN_PRESETS} from './editor/web/ui/color/presets.js';assert.deepEqual(JSON.parse(fs.readFileSync(process.argv[1])),BUILTIN_PRESETS);console.log('Passed 5 built-in preset data comparisons against production web presets');",str(builtins)],cwd=repo,check=True)
        js = '''import fs from 'node:fs'; import assert from 'node:assert/strict'; import {applyOps} from './editor/core/project.js';
const rows=JSON.parse(fs.readFileSync(process.argv[1]));
for(const row of rows){const before=structuredClone(row.project);const {project}=applyOps(before,row.body.ops);assert.deepEqual(before,row.project);assert.deepEqual(project.tracks,row.project.tracks);assert.deepEqual(project.comps.nested.tracks[1],row.project.comps.nested.tracks[1]);assert.ok(row.body.expectedVersion===7);if(row.deletedPreset){assert.equal(project.nodePresets[row.deletedPreset],undefined);assert.deepEqual(project.nodePresets.Keep,row.project.nodePresets.Keep);assert.equal(Object.keys(project.nodePresets).length,1);}}
console.log(`Passed ${rows.length} native workflow batches through production shared applyOps`);'''
        subprocess.run(['node','--input-type=module','-e',js,str(replay)],cwd=repo,check=True)
        ui = source + '\n' + fixture + '\n' + block(controls,'enum NativeEditorStyle {') + '\n' + block(controls,'enum NativeType {') + '\n' + block(controls,'enum NativeRadius {') + '\n' + block(controls,'struct NativeToolbarButtonStyle: ButtonStyle {') + '\n' + block(controls,'struct NativeNumberRow: View {')
        ui += '\n' + block(color,'struct NativeColorPresetDestination: Identifiable') + '\n' + block(color,'struct NativeColorPresetSaveSheet: View {') + '\n' + block(color,'struct NativeColorComparisonControls: View {')
        ui += '\nstruct ColorWorkflowViews: View { let model: NativeEditorModel; let session: EditorSession; @State private var nodeID="n2"; @State private var copiedGrade:NativeColorGradeClipboard?; @State private var savingPreset:NativeColorPresetDestination?; @StateObject private var colorGallery=NativeColorGalleryStore(); var stills:[NativeColorGalleryStill] {get {colorGallery.stills} nonmutating set {colorGallery.stills=newValue}}; @State private var comparisonID:UUID?; @State private var inspectedLUT:NativeColorLUTPreview?; @State private var lutMix=1.0; @State private var lutSpace="srgb"; @State private var lutBatch=false; @State private var lutSectionExpanded=false; @State private var exportingLUT=false; @State private var lutExportDocument:NativeColorLUTExportDocument?; @State private var lutExportCapture:NativeColorWorkflowCapture?; @State private var inspectingLUT=false; @State private var lutGeneration=UUID(); @State private var luts:[String]=[]; @State private var importLUT=false; @State private var lutSelectionCapture:NativeColorWorkflowCapture?; var body: some View {EmptyView()}\n'
        for marker in ['private func colorWorkflowControls(','private func clearGradeLUT(','private var lutAcquisitionControls: some View','private var galleryControls: some View','private func submitColorOperations(','private func batchGrade(','private func applyNodePreset(','private func saveNodePreset(','private func removeNodePreset(','private func lutTargetKind(','private func inspectColorLUT(','private func importColorLUT(','private func exportColorLUT(','private func applyColorLUT(','private func grabColorStill(','private func compareColorStill(']:
            ui += block(color,marker) + '\n'
        ui += '}\n'
        swift.write_text(ui)
        for sdk,target in [('macosx','arm64-apple-macos14.0'),('iphonesimulator','arm64-apple-ios17.0-simulator')]:
            sdk_path = subprocess.check_output(['xcrun','--sdk',sdk,'--show-sdk-path'],text=True).strip()
            subprocess.run(['xcrun','swiftc','-typecheck','-sdk',sdk_path,'-target',target,'-module-cache-path',str(cache),str(swift)],check=True)
        print('Production Color workflow views type-check for macOS 14 and iOS 17 Simulator. No app build or UI launch ran.')


if __name__ == '__main__':
    main()
