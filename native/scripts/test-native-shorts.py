#!/usr/bin/env python3
"""Compile the actual Shorts/transcript controller against real shared-planner receipts.

Integration-owner gate only: this invokes swiftc. Source lanes must not execute it.
"""
from pathlib import Path
import argparse
import os
import subprocess
import tempfile
from native_transcript_fixture import foundation_support, seek_word_method

parser = argparse.ArgumentParser()
parser.add_argument('--repo-root', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--source-root', type=Path)
parser.add_argument('--helper-root', type=Path)
parser.add_argument('--prepare-only', type=Path, help='Write the extracted actual-controller Swift fixture without compiling or running it')
args = parser.parse_args()
repo = args.repo_root.resolve()
source_root = (args.source_root or repo).resolve()
panel = (source_root / 'native/App/Shared/NativeEditor/NativeTranscriptPanel.swift').read_text()
project = (repo / 'native/App/Shared/NativeEditor/NativeProject.swift').read_text()
model = (repo / 'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()
workflow = panel.split('// BEGIN SHORTS WORKFLOW\n', 1)[1].split('// END SHORTS WORKFLOW', 1)[0]
controller = panel.split('// BEGIN TRANSCRIPT CONTROLLER\n', 1)[1].split('// END TRANSCRIPT CONTROLLER', 1)[0]
helpers = project[project.index('extension Dictionary where Key == String, Value == Any {'):project.index('// Foundation-only receipt helpers')]
projections = project[project.index('struct NativeProject {'):project.index('enum NativeProcessingRequests {')]
file_identity = model[model.index('struct NativeSourceFileIdentity:'):model.index('enum NativePanel:')]
# UI bindings are inspection gates only; the executable assertions below use actual controllers.
assert 'Button("Review selected clips")' in panel
assert 'Button("Create reviewed compositions")' in panel
assert 'TextField("Clip \\(index + 1) name"' in panel
assert 'Toggle("Include editable captions"' in panel

program = 'import Foundation\nimport CoreFoundation\nimport Combine\nimport Darwin\n' + helpers + projections + file_identity + workflow + controller
program += foundation_support(repo, source_root, args.helper_root, controller)
program += r'''
@MainActor final class ReelBackend {
    struct APIError: LocalizedError { let message:String; init(_ message:String){self.message=message}; var errorDescription:String?{message} }
    var calls:[(String,String,String?)]=[]
    var handler:((String,String,String?) async throws -> JSON)?
    func handle(method:String,path:String,body:String?) async throws -> JSON {
        calls.append((method,path,body)); return try await handler?(method,path,body) ?? JSON(any:[:])
    }
}
@MainActor final class EditorSession {
    var backend:ReelBackend?,folder:URL?
    init(_ backend:ReelBackend,_ folder:URL){self.backend=backend;self.folder=folder}
    func request(method:String,path:String,body:String?) async throws -> JSON {
        guard let backend else {throw ReelBackend.APIError("Closed")}
        return try await backend.handle(method:method,path:path,body:body)
    }
}
@MainActor final class NativeEditorModel {
    let session:EditorSession
    init(_ session:EditorSession){self.session=session}
    var folder:URL? {session.folder}
    var project:NativeProject?
    enum Panel: String { case transcript, edit }
    var panel:Panel = .transcript
    var selectedIDs:Set<String> = []
    var processingContextID=UUID()
    var version=12
    var composition:String?="k1"
    var capabilities:[String:Any]=["shorts":["available":true]]
    var latestProject:NativeProject?,latestVersion=12
    var tracks:[NativeTrack] {project?.tracks(in:composition) ?? []}
    var showingSource=false
    var mobilePanel:String?="transcript"
    var selectedID:String?,sourceAssetID:String?,sourceError:String?
    var preview:[Double]=[]
    func mediaURL(_ source:String) throws -> URL {guard let folder else {throw ReelBackend.APIError("Closed")};return folder.appendingPathComponent(source)}
    func openSource(_ asset:NativeAsset){sourceAssetID=asset.id;showingSource=true}
    func seekSource(_ value:Double){preview.append(value)}
    func markSourceIn(_ value:Double?=nil){if let value {preview.append(value)}}
    func markSourceOut(_ value:Double?=nil){if let value {preview.append(value)}}
    func seek(_ value:Double){}
    func refresh() async {if let latestProject {project=latestProject};version=latestVersion}
    func call(_ path:String,_ body:[String:Any]?=nil) async throws -> [String:Any] {
        guard let backend=session.backend else {throw ReelBackend.APIError("Closed")}
        let value=try await session.request(method:body == nil ? "GET":"POST",path:path,body:body.map {JSON(any:$0).text})
        guard session.backend === backend,!Task.isCancelled else {throw CancellationError()}
        return try JSON.parse(value.text) as! [String:Any]
    }
}
@main struct Checks {
    @MainActor static func main() async throws {
        var count=0
        func check(_ value:Bool,_ message:String){precondition(value,message);count += 1}
        func rejects(_ message:String,_ block:() throws -> Void){do {try block();preconditionFailure(message)}catch {count += 1}}
        let receipt=try JSON.parse(String(contentsOfFile:CommandLine.arguments[1],encoding:.utf8)) as! [String:Any]
        let context=receipt.dictionary("context"),request=receipt.dictionary("request"),response=receipt.dictionary("response"),saved=receipt.dictionary("saved")
        let capture=try NativeShortsWorkflow.Capture(context),settings=NativeShortsWorkflow.Settings(format:"vertical",captions:false,captionStyle:"karaoke")
        let body=try NativeShortsWorkflow.reviewBody(capture:capture,ranges:request.objects("ranges"),settings:settings)
        check(body["apply"] as? Bool == false && body["expectedVersion"] as? Int == 12,"Preflight must not apply")
        check(body["captions"] as? Bool == false && body.objects("words").isEmpty,"Optional captions must be omitted explicitly")
        try capture.verifyTranscript(saved);count += 1 // Confidence metadata must not create a false text/timing conflict.
        for name in receipt.objects("unicodeNames") {
            let normalized=NativeShortsWorkflow.normalizedName(name.string("input"),index:0)
            check(normalized==name.string("normalized") && normalized.utf16.count<=200,"Native name must survive JavaScript UTF-16 truncation unchanged")
            var range=request.objects("ranges")[0];range["name"]=name.string("input")
            let unicodeBody=try NativeShortsWorkflow.reviewBody(capture:capture,ranges:[range],settings:settings)
            _ = try NativeShortsWorkflow.Review(capture:capture,settings:settings,body:unicodeBody,response:name.dictionary("response"));count += 1
        }
        let review=try NativeShortsWorkflow.Review(capture:capture,settings:settings,body:body,response:response)
        let creation=try review.creationBody(current:capture,settings:settings)
        check(creation["apply"] as? Bool == true && creation.objects("ranges").first?.string("name")=="Edited opening","Creation reuses the exact reviewed ranges/names")
        for key in ["folder","backend","version","comp","file","revision","fingerprint","words","project"] {
            var changed=context
            if key=="version" {changed[key]=13} else if key=="revision" {changed[key]=4}
            else if key=="words" {changed[key]=[["t":1.0,"end":2.0,"text":"changed"]]}
            else if key=="project" {var p=changed.dictionary(key);p["name"]="changed";changed[key]=p}
            else if key=="file" {changed[key]=["path":"changed"]} else {changed[key]="changed"}
            let newer=try NativeShortsWorkflow.Capture(changed)
            rejects("Reject changed \(key)"){_ = try review.creationBody(current:newer,settings:settings)}
        }
        rejects("Caption choice invalidates review"){_ = try review.creationBody(current:capture,settings:.init(format:"vertical",captions:true,captionStyle:"karaoke"))}
        var stale=saved;stale["status"]="stale";rejects("Stale source rejects saved transcript"){try capture.verifyTranscript(stale)}
        var wrong=response;wrong["version"]=13;rejects("Old plan version rejects"){_ = try NativeShortsWorkflow.Review(capture:capture,settings:settings,body:body,response:wrong)}
        for range in [["from":-1.0,"to":2.0],["from":1.0,"to":Double.infinity],["from":119.0,"to":121.0]] {
            rejects("Invalid edited range refuses preflight"){_ = try NativeShortsWorkflow.reviewBody(capture:capture,ranges:[range],settings:settings)}
        }
        // Exercise actual asynchronous transcript controller through a recorded backend boundary.
        let root=URL(fileURLWithPath:CommandLine.arguments[2]),source=root.appendingPathComponent(context.string("src"))
        try FileManager.default.createDirectory(at:source.deletingLastPathComponent(),withIntermediateDirectories:true)
        try Data("owned fixture source".utf8).write(to:source)
        let backend=ReelBackend(),session=EditorSession(backend,root),model=NativeEditorModel(session),state=NativeTranscriptState()
        model.project=NativeProject(fields:context.dictionary("project"));model.latestProject=model.project
        state.attach(session:session);state.source=context.string("src");state.locale="en-US"
        try state.accept(saved,identity:state.identity,backend:backend)
        state.candidates=request.objects("ranges");state.selectedCandidates=[0]
        check(state.previewShortRange(0,model:model,session:session) && model.showingSource,"Actual edited-range preview enters the source viewer")
        check(model.preview==[20.25,38.75,20.25],"Edited-range preview marks source bounds without a timeline write")
        var applied=0
        var loseCreationReply=false
        backend.handler={method,path,text in
            if method=="GET" {return JSON(any:saved)}
            let b=try JSON.parse(text ?? "{}") as! [String:Any]
            check(b["expectedVersion"] as? Int == 12 && b["expectedTranscriptRevision"] as? Int == 3,"Real controller sends captured version/revision")
            check(b["expectedSourceFingerprint"] as? String == "source-v1","Real controller sends inspected source identity")
            if b["apply"] as? Bool == true {applied += 1;let created=receipt.dictionary("created");model.latestProject=NativeProject(fields:created.dictionary("project"));model.latestVersion=13;if loseCreationReply {throw ReelBackend.APIError("Fixture reply lost after commit")};return JSON(any:created)}
            return JSON(any:response)
        }
        func preflight() async {
            state.perform(model:model,session:session){token,owner in try await state.reviewShorts(model:model,session:session,settings:settings,token:token,backend:owner)}
            while state.busy {await Task.yield()}
        }
        func create(_ settings:NativeShortsWorkflow.Settings) async {
            state.perform(model:model,session:session){token,owner in try await state.createReviewedShorts(model:model,session:session,settings:settings,token:token,backend:owner)}
            while state.busy {await Task.yield()}
        }
        await create(settings);check(applied==0,"No creation without actual preflight")
        await preflight();check(state.shortsReview != nil && applied==0,"Actual preflight returns a review without applying")
        state.updateCandidate(0,key:"name",value:"changed")
        check(state.shortsReview==nil,"Editing name invalidates actual state review")
        state.updateCandidate(0,key:"name",value:"Edited opening");await preflight()
        await create(.init(format:"square",captions:false,captionStyle:"karaoke"));check(applied==0,"Changed UI format cannot apply captured review")
        try Data("source changed".utf8).write(to:source)
        await create(settings);check(applied==0,"Actual source inode/size/time drift refuses creation")
        await preflight();check(state.shortsReview != nil,"Fresh preflight uses current file identity")
        let originalTracks=JSON(any:model.project?.fields["tracks"]).text,originalComp=JSON(any:model.project?.fields.dictionary("comps")["k1"]).text
        await create(settings)
        check(applied==1 && state.shortsReview==nil && model.version==13 && model.composition=="k2" && !model.showingSource,"Create consumes reviewed plan once and visibly opens the new composition after source preview")
        check(JSON(any:model.project?.fields["tracks"]).text==originalTracks && JSON(any:model.project?.fields.dictionary("comps")["k1"]).text==originalComp,"Original nested refs/timing remain unchanged")
        check(state.words.count==saved.objects("words").count && !state.dirty,"Short creation preserves saved transcript")
        // An uncertain reply may follow a committed edit. It must not offer a second automatic creation.
        model.project=NativeProject(fields:context.dictionary("project"));model.latestProject=model.project
        model.version=12;model.latestVersion=12;model.composition="k1"
        state.candidates=request.objects("ranges");state.selectedCandidates=[0]
        await preflight();check(state.shortsReview != nil,"Fresh fixture project can receive a preflight review")
        loseCreationReply=true
        await create(settings);check(applied==2 && state.shortsReview==nil,"Committed edit with lost reply still consumes the review")
        await create(settings);check(applied==2,"Create after a lost reply cannot dispatch again without fresh preflight")
        print("PASS: \(count) actual Shorts/transcript controller assertions")
    }
}
'''
if args.prepare_only:
    args.prepare_only.parent.mkdir(parents=True, exist_ok=True)
    args.prepare_only.write_text(program)
    print('Prepared actual-controller Swift fixture; not compiled or executed.')
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix='arya-native-shorts-') as temp:
    folder=Path(temp);receipt=folder/'receipt.json';swift=folder/'Checks.swift';binary=folder/'checks'
    env=dict(os.environ,ARYA_SHORTS_RECEIPT=str(receipt))
    subprocess.run(['node','--test',str(source_root/'editor/test/native-shorts-planner.test.mjs')],env=env,check=True)
    swift.write_text(program)
    subprocess.run(['swiftc','-j1','-parse-as-library','-module-cache-path',str(folder/'cache'),str(repo/'native/ReelKit/Sources/ReelKit/JSON.swift'),str(swift),'-o',str(binary)],check=True)
    subprocess.run([str(binary),str(receipt),str(folder/'project')],check=True)
