#!/usr/bin/env python3
"""Exercise production captured reference matching without modifying app state."""
from pathlib import Path
import subprocess
import tempfile


def block(text, marker):
    start=text.index(marker); end=text.index('{',start)+1; depth=1
    while depth:
        depth+=(text[end]=='{')-(text[end]=='}'); end+=1
    return text[start:end].replace('private func ','func ').replace('private var ','var ')


def main():
    repo=Path(__file__).resolve().parents[2]; editor=repo/'native/App/Shared/NativeEditor'; kit=repo/'native/ReelKit/Sources/ReelKit'
    color=(editor/'NativeColorPanel.swift').read_text(); deliver=(editor/'NativeDeliverPanel.swift').read_text(); project=(editor/'NativeProject.swift').read_text(); textures=(kit/'Rendering/NativeGradeTextures.swift').read_text(); controls=(editor/'NativeControls.swift').read_text()
    source='import Foundation\nimport SwiftUI\nimport CryptoKit\nimport CoreGraphics\nimport Darwin\n'
    source+=(kit/'JSON.swift').read_text()+'\n'+block((kit/'ProjectFolder.swift').read_text(),'public struct ProjectFolder: Sendable')+'\n'
    source+=project[project.index('struct NativeProject {'):project.index('enum NativeProcessingRequests {')]+'\n'+block(project,'extension Dictionary where Key == String, Value == Any')+'\n'+block(project,'func nativeTimecode(')+'\n'
    for marker in ['struct NativeInterchangeSource: Sendable','struct NativeInterchangeOptions: Equatable','struct NativeInterchangeOrigin: Equatable']:
        source+=block(deliver,marker)+'\n'
    for marker in ['struct NativeColorWorkflowCapture {','struct NativeColorGraphPlanner {','extension NativeColorGraphPlanner {','enum NativeColorWorkflows {','struct NativeColorLookSettings: Equatable','struct NativeColorLookCapture {','struct NativeColorReferenceInput: Equatable, Sendable','struct NativeColorLUTPreview {']:
        source+=block(color,marker)+'\n'
    source+=block(textures,'public enum ReelLUTInspection {')+'\n'+block(textures,'struct NativeCube {')+'\n'+block(textures,'struct NativeLUTSource {')+'\n'
    fixture=r'''
struct ReelRenderingError: LocalizedError { let errorDescription:String?; init(_ text:String) {errorDescription=text} }
@MainActor final class ReelBackend {
    struct APIError: Error,LocalizedError { let errorDescription:String?; init(_ text:String) {errorDescription=text} }
    var calls:[(String,[String:Any])]=[], running=0
    var responder:((String,[String:Any]) async throws->JSON)!
    func handle(method:String,path:String,body:String?) async throws->JSON {
        let fields=try JSON.parse(body ?? "{}") as? [String:Any] ?? [:]
        calls.append((path,fields)); running += 1; defer {running -= 1}; return try await responder(path,fields)
    }
}
@MainActor final class EditorSession:ObservableObject {var folder:URL?; var backend:ReelBackend?}
enum PanelMode {case assistant}
@MainActor final class NativeEditorModel:ObservableObject {
    var folder:URL?,project:NativeProject?
    var version=7, time=1.0
    var composition:String?="nested",selectedID:String?="c1",selectedIDs:Set<String>=["c1","c2"]
    var tracks:[NativeTrack] {project?.tracks(in:composition) ?? []}
    var selected:NativeClip? {tracks.flatMap(\.clips).first {$0.id==selectedID}}
    var lookReference:String?="reference.png",status="",receives=0
    var importedReferences:[URL]=[], referenceImportError:Error?, pickerTasks=0
    var assistantDraft="",assistantInputKind=""; var panel=PanelMode.assistant; var mobilePanel:PanelMode?
    func receive(_ event:String,_ text:String) { receives += 1; let fields=try! JSON.parse(text) as! [String:Any]; version=Int(fields.number("version")); project=NativeProject(fields:fields.dictionary("project")) }
    func perform(_ action:@escaping @MainActor () async throws->Void) {
        pickerTasks += 1
        Task { defer {pickerTasks -= 1}; do {try await action()} catch {status=error.localizedDescription} }
    }
    func importReference(_ url:URL) async throws->String {
        if let referenceImportError {throw referenceImportError}
        importedReferences.append(url); return url.lastPathComponent
    }
}
@MainActor final class Panel {
    let model:NativeEditorModel,session:EditorSession
    var nodeID="n2",lookName="Reference look",lookStrength=0.75,lookMix=1.0
    var matchingLook=false,lookApplying=false
    var lookTask:Task<Void,Never>?,lookOrigin:NativeInterchangeOrigin?
    var lookGeneration=UUID(),lookWarnings:[String]=[],luts:[String]=[]
    init(_ model:NativeEditorModel,_ session:EditorSession) {self.model=model;self.session=session}
'''
    methods=['private var lookSettings: NativeColorLookSettings','private func createReferenceLook(','private func cancelReferenceLook(','private func importLookReference(']
    for marker in methods:
        fixture+=block(color,marker).replace('lookTask = Task { @MainActor in','lookTask = Task { @MainActor [self] in').replace('model.perform {','model.perform { [self] in')+'\n'
    fixture+='}\n'
    tests=r'''
func require(_ yes:Bool,_ message:String) {if !yes {fatalError(message)}}
@main struct LookChecks {
    @MainActor static func main() async throws {
        var count=0,replay:[[String:Any]]=[]
        func check(_ yes:Bool,_ message:String) {require(yes,message);count += 1}
        let root=URL(fileURLWithPath:CommandLine.arguments[1]); try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        let folder=ProjectFolder(root:root),reference=root.appendingPathComponent("reference.png")
        let original=Data([1,2,3,4,5]);try original.write(to:reference)
        let input=try NativeColorReferenceInput.capture(reference:"reference.png",folder:root.path)
        check(input.sourceHash.count==64 && input.path=="reference.png","Reference identity did not capture exact source")
        try input.verify(); count += 1
        try Data([8,9,10]).write(to:reference)
        do {try input.verify();fatalError("Reference drift accepted")} catch {count += 1}
        try original.write(to:reference)
        let large=root.appendingPathComponent("huge.png");FileManager.default.createFile(atPath:large.path,contents:nil);let file=try FileHandle(forWritingTo:large);try file.truncate(atOffset:32*1024*1024+1);try file.close()
        for path in ["huge.png","../outside.png"] {do {_=try NativeColorReferenceInput.capture(reference:path,folder:root.path);fatalError("Invalid reference accepted")} catch {count += 1}}
        let alias=root.appendingPathComponent("alias.png");try FileManager.default.createSymbolicLink(at:alias,withDestinationURL:reference)
        let aliased=try NativeColorReferenceInput.capture(reference:"alias.png",folder:root.path)
        let alternate=root.appendingPathComponent("alternate.png");try original.write(to:alternate);try FileManager.default.removeItem(at:alias);try FileManager.default.createSymbolicLink(at:alias,withDestinationURL:alternate)
        do {try aliased.verify();fatalError("Alias retarget accepted")} catch {count += 1}
        let backend=ReelBackend(),session=EditorSession(),model=NativeEditorModel();session.backend=backend;session.folder=root;model.folder=root
        let picker=Panel(model,session)
        func settlePicker() async throws {for _ in 0..<1000 {if model.pickerTasks==0 {return};try await Task.sleep(nanoseconds:1_000_000)};fatalError("Picker task timed out")}
        picker.importLookReference(.success([reference,alternate]));try await settlePicker()
        check(model.importedReferences==[reference],"Production picker callback did not import exactly the first selected URL")
        picker.importLookReference(.success([]));try await settlePicker()
        check(model.importedReferences==[reference],"Empty picker result imported a reference")
        picker.importLookReference(.failure(ReelBackend.APIError("Picker canceled")));try await settlePicker()
        check(model.importedReferences==[reference] && model.status=="Picker canceled","Failed picker result imported a reference or hid its error")
        model.referenceImportError=ReelBackend.APIError("Reference copy failed")
        picker.importLookReference(.success([alternate]));try await settlePicker()
        check(model.importedReferences==[reference] && model.status=="Reference copy failed","Reference import error was hidden or accepted")
        check(try Data(contentsOf:reference)==original,"Picker callback changed the original reference")
        model.referenceImportError=nil;model.status=""
        let graph=NativeColorGraphPlanner.defaultGraph
        let clips:[[String:Any]]=[["id":"c1","kind":"video","start":0,"dur":2,"nodes":graph],["id":"c2","kind":"image","start":0,"dur":1]]
        let project:[String:Any]=["version":3,"name":"Reference test","width":1920,"height":1080,"fps":30,"tracks":[["id":"V1","kind":"video","clips":clips]],"assets":[:],"comps":["nested":["width":1920,"height":1080,"fps":30,"tracks":[["id":"V1","kind":"video","clips":clips]]]]]
        model.project=NativeProject(fields:project);let panel=Panel(model,session)
        func reset() throws {
            model.folder=root;session.folder=root;session.backend=backend;model.project=NativeProject(fields:project);model.version=7;model.composition="nested";model.selectedID="c1";model.selectedIDs=["c1","c2"];model.time=1;model.lookReference="reference.png";panel.nodeID="n2";panel.lookName="Reference look";panel.lookStrength=0.75;panel.lookMix=1;try original.write(to:reference)
        }
        func capture()->NativeColorLookCapture {NativeColorLookCapture.capture(model:model,session:session,node:panel.nodeID,settings:panel.lookSettings)!}
        func settle() async throws {for _ in 0..<2000 {if panel.lookTask==nil && backend.running==0{return};try await Task.sleep(nanoseconds:1_000_000)};fatalError("Reference task timed out")}
        let cube="LUT_3D_SIZE 2\n"+(0..<8).map {"\($0&1) \(($0>>1)&1) \(($0>>2)&1)"}.joined(separator:"\n")+"\n"
        let lutPath="luts/generated.cube";try FileManager.default.createDirectory(at:folder.output("luts"),withIntermediateDirectories:true);try Data(cube.utf8).write(to:folder.output(lutPath))
        let inspected=try JSON.parse(ReelLUTInspection.inspect(text:cube).text) as! [String:Any]
        func response(_ path:String,_ body:[String:Any]) throws -> JSON {
            if path=="/api/looks/match" {
                let grade:[String:Any]=["lut":lutPath,"lutMix":body.number("mix"),"lutSpace":"srgb"]
                var op:[String:Any]=["set":["grade":grade]]
                if let id=body["clip"] as? String {op["op"]="update";op["id"]=id}
                else {op["op"]="adjustment";op["start"]=0;op["dur"]=2;op["set"]=["grade":grade,"label":"Reference look"]}
                return JSON(any:["path":lutPath,"lut":lutPath,"ops":[op],"warnings":["Reference warning"]])
            }
            if path=="/api/luts/inspect" {var fields=inspected;fields["path"]=lutPath;return JSON(any:fields)}
            if path=="/api/ops" {replay.append(["project":project,"body":body]);return JSON(any:["version":8,"project":project])}
            fatalError("Unexpected API path")
        }
        backend.responder={try response($0,$1)}
        let first=capture(),request=first.request(reference:input.path)
        check(request["apply"] as? Bool==false && request.string("comp")=="nested" && Int(request.number("expectedVersion"))==7 && request.string("clip")=="c1","Reference generation could mutate or lost captured destination")
        panel.createReferenceLook(first);try await settle()
        check(backend.calls.map(\.0).suffix(3)==["/api/looks/match","/api/luts/inspect","/api/ops"] && model.receives==1,"Reference pipeline did not generate, inspect and apply once")
        let applied=backend.calls.last!.1
        check(applied.objects("expectedInputs")[0].string("sourceHash")==inspected.string("sourceHash") && applied.objects("ops")[0].string("comp")=="nested","Reference apply omitted actual LUT hash or comp")
        check(try Data(contentsOf:reference)==original && panel.lookWarnings==["Reference warning"] && model.status.hasPrefix("Applied"),"Reference input changed or successful result was not delivered")
        for axis in 0..<12 {
            try reset();let source=capture(),calls=backend.calls.count,receives=model.receives
            switch axis {
            case 0:model.version=8
            case 1:model.composition=nil
            case 2:model.selectedIDs=["c1"]
            case 3:model.selectedID="c2"
            case 4:panel.nodeID="n4"
            case 5:panel.lookName="Other"
            case 6:panel.lookStrength=0.2
            case 7:panel.lookMix=0.2
            case 8:model.time=2
            case 9:session.backend=ReelBackend()
            case 10:model.folder=root.appendingPathComponent("other")
            default:model.project=NativeProject(fields:["name":"other","tracks":[]])
            }
            panel.createReferenceLook(source);try await settle()
            check(backend.calls.count==calls && model.receives==receives && !panel.matchingLook,"Stale captured reference action dispatched (axis \(axis))")
        }
        for stage in ["/api/looks/match","/api/luts/inspect"] {
            try reset();let receives=model.receives,beforeOps=backend.calls.filter {$0.0=="/api/ops"}.count
            backend.responder={path,body in if path==stage {model.selectedIDs=["c1"]};return try response(path,body)}
            panel.createReferenceLook(capture());try await settle()
            check(backend.calls.filter {$0.0=="/api/ops"}.count==beforeOps && model.receives==receives && !model.status.hasPrefix("Applied"),"Async reference drift reached apply at \(stage)")
        }
        try reset();let beforeDrift=backend.calls.filter {$0.0=="/api/ops"}.count
        backend.responder={path,body in if path=="/api/looks/match" {try Data([6,7,8]).write(to:reference)};return try response(path,body)}
        panel.createReferenceLook(capture());try await settle()
        check(backend.calls.filter {$0.0=="/api/ops"}.count==beforeDrift && model.status.contains("reference image changed"),"Source drift applied generated reference")
        try reset();let beforeCancel=backend.calls.filter {$0.0=="/api/ops"}.count
        backend.responder={path,body in if path=="/api/looks/match" {try await Task.sleep(nanoseconds:60_000_000)};return try response(path,body)}
        panel.createReferenceLook(capture());for _ in 0..<1000 {if backend.running>0{break};try await Task.sleep(nanoseconds:1_000_000)};panel.cancelReferenceLook();try await settle()
        check(backend.calls.filter {$0.0=="/api/ops"}.count==beforeCancel && !panel.matchingLook && model.status.contains("canceled"),"Canceled generation applied or stayed pending")
        try reset();let beforeLate=model.receives
        backend.responder={path,body in if path=="/api/ops" {model.time=2};return try response(path,body)}
        panel.createReferenceLook(capture());try await settle()
        check(model.receives==beforeLate && model.status.contains("captured project") && !model.status.hasPrefix("Applied"),"Late changed editor accepted application result")
        try reset();model.composition=nil;model.selectedID=nil;model.selectedIDs=[];backend.responder={try response($0,$1)}
        let adjustment=capture();check(adjustment.request(reference:input.path)["comp"] is NSNull && adjustment.clip==nil,"No-selection reference omitted main composition null")
        panel.createReferenceLook(adjustment);try await settle()
        check(backend.calls.last!.1.objects("ops")[0].string("op")=="adjustment" && backend.calls.last!.1.objects("ops")[0]["comp"] is NSNull,"No-selection reference lost adjustment workflow")
        let wrong:[[String:Any]]=[["op":"update","id":"other","set":["grade":["lut":lutPath,"lutMix":1,"lutSpace":"srgb"]]]]
        do {_=try first.operations(wrong,lut:lutPath);fatalError("Wrong generated target accepted")} catch {count += 1}
        try reset();var lockedProject=project;var comps=lockedProject["comps"] as! [String:[String:Any]];var tracks=comps["nested"]!.objects("tracks");tracks[0]["locked"]=true;comps["nested"]!["tracks"]=tracks;lockedProject["comps"]=comps;model.project=NativeProject(fields:lockedProject)
        check(NativeColorLookCapture.capture(model:model,session:session,node:panel.nodeID,settings:panel.lookSettings)==nil,"Locked selected reference target accepted")
        model.selectedID=nil;model.selectedIDs=[]
        check(NativeColorLookCapture.capture(model:model,session:session,node:panel.nodeID,settings:panel.lookSettings)==nil,"Locked adjustment destination accepted")
        let badSettings=NativeColorLookSettings(reference:"reference.png",name:"x",strength:.nan,mix:1,at:0)
        check(!badSettings.valid,"Nonfinite reference form accepted")
        try JSON(any:replay).text.write(toFile:CommandLine.arguments[2],atomically:true,encoding:.utf8)
        print("Passed \(count) production reference-look request, source, cancellation and late-result safeguards")
    }
}
'''
    with tempfile.TemporaryDirectory(prefix='reel-color-reference-') as directory:
        temp=Path(directory);swift=temp/'ReferenceChecks.swift';binary=temp/'ReferenceChecks';cache=temp/'cache';replay=temp/'replay.json'
        swift.write_text(source+fixture+tests)
        subprocess.run(['xcrun','swiftc','-parse-as-library','-module-cache-path',str(cache),str(swift),'-o',str(binary)],check=True)
        subprocess.run([str(binary),str(temp/'project'),str(replay)],check=True)
        js="""import fs from 'node:fs';import assert from 'node:assert/strict';import {applyOps} from './editor/core/project.js';const rows=JSON.parse(fs.readFileSync(process.argv[1]));for(const row of rows){const before=structuredClone(row.project);const {project}=applyOps(before,row.body.ops);assert.deepEqual(before,row.project);assert.equal(row.body.expectedInputs.length,1);assert.equal(row.body.expectedVersion,7);const op=row.body.ops[0];if(op.op==='update')assert.equal(project.comps.nested.tracks[0].clips[0].grade.lut,'luts/generated.cube');else assert.ok(project.tracks.some(t=>t.clips.some(c=>c.kind==='adjustment'&&c.grade.lut==='luts/generated.cube')));}console.log(`Passed ${rows.length} reference application batches through production shared applyOps`);"""
        subprocess.run(['node','--input-type=module','-e',js,str(replay)],cwd=repo,check=True)
        ui=source+fixture+'\n'+block(controls,'enum NativeEditorStyle {')+'\n'+block(controls,'enum NativeType {')+'\n'+block(controls,'enum NativeRadius {')+'\n'+block(controls,'struct NativeToolbarButtonStyle: ButtonStyle {')+'\n'+block(controls,'struct NativeNumberRow: View {')
        ui+='\nstruct ReferenceLookViews:View { let model:NativeEditorModel;let session:EditorSession;@State private var nodeID="n2";@State private var lookName="Reference look";@State private var lookStrength=0.75;@State private var lookMix=1.0;@State private var matchingLook=false;@State private var lookApplying=false;@State private var lookTask:Task<Void,Never>?;@State private var lookOrigin:NativeInterchangeOrigin?;@State private var lookGeneration=UUID();@State private var lookWarnings:[String]=[];@State private var luts:[String]=[];@State private var importReference=false;@State private var lookPrompt="";var body:some View {lookControls}\n'
        for marker in methods+['private var lookControls: some View']:
            ui+=block(color,marker)+'\n'
        ui+='}\n';swift.write_text(ui)
        for sdk,target in [('macosx','arm64-apple-macos14.0'),('iphonesimulator','arm64-apple-ios17.0-simulator')]:
            path=subprocess.check_output(['xcrun','--sdk',sdk,'--show-sdk-path'],text=True).strip()
            subprocess.run(['xcrun','swiftc','-typecheck','-sdk',path,'-target',target,'-module-cache-path',str(cache),str(swift)],check=True)
        print('Production reference-look controls type-check for macOS 14 and iOS 17 Simulator. No app build or UI launch ran.')


if __name__=='__main__':
    main()
