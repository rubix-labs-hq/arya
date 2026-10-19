#!/usr/bin/env python3
"""Exercise the production transcript controller across panel and backend lifetimes."""
from pathlib import Path
import subprocess
import tempfile
from native_transcript_fixture import foundation_support, seek_word_method

import argparse
parser=argparse.ArgumentParser()
parser.add_argument('--repo-root',type=Path,default=Path(__file__).resolve().parents[2])
parser.add_argument('--source-root',type=Path)
parser.add_argument('--helper-root', type=Path)
parser.add_argument('--prepare-only', type=Path, help='Write the real controller fixture without compiling or executing it')
args=parser.parse_args()
repo=args.repo_root.resolve()
candidate=(args.source_root or repo).resolve()
source_root=candidate
editor = repo / 'native/App/Shared/NativeEditor'
panel = (candidate / 'native/App/Shared/NativeEditor/NativeTranscriptPanel.swift').read_text()
project = (editor / 'NativeProject.swift').read_text()
model = (editor / 'NativeEditorModel.swift').read_text()
workflow = panel.split('// BEGIN SHORTS WORKFLOW\n', 1)[1].split('// END SHORTS WORKFLOW', 1)[0]
file_identity = model[model.index('struct NativeSourceFileIdentity:'):model.index('enum NativePanel:')]
controller = panel.split('// BEGIN TRANSCRIPT CONTROLLER\n', 1)[1].split('// END TRANSCRIPT CONTROLLER', 1)[0]
helpers = project[project.index('extension Dictionary where Key == String, Value == Any {'):project.index('// Foundation-only receipt helpers')]
# Extract the real root ownership/reset hooks; the view itself is not replaced by a fake pass.
ownership = next(line.strip() for line in model.splitlines() if 'let transcript = NativeTranscriptState()' in line)
assert 'transcript.projectDidChange()' in model.split('func reset()', 1)[1].split('func refresh()', 1)[0]
assert '@ObservedObject private var transcript: NativeTranscriptState' in panel
assert 'self.transcript = model.transcript' in panel
assert '.onDisappear { transcript.suspend() }' in panel
assert '.onChange(of: model.processingContextID)' in panel
assert 'Button("Copy retained corrections", action: copyRetainedCorrections)' in panel
assert 'UIPasteboard.general.string = transcript.retainedCorrectionsText' in panel
assert 'NSPasteboard.general.setString(transcript.retainedCorrectionsText, forType: .string)' in panel
assert 'Button("Recheck saved transcript")' in panel
timestamp = panel.split('Button(transcript.words[index].from.formatted',1)[1].split('TextField("Word',1)[0]
assert '.disabled(transcript.busy)' in timestamp
handoff = seek_word_method(panel)
# Execute the actual iOS handoff branch inside a Foundation-only presentation harness.
handoff = handoff.replace('#if os(iOS)', '').replace('#endif', '')
projections = project[project.index('struct NativeProject {'):project.index('enum NativeProcessingRequests {')]
source = 'import Foundation\nimport CoreFoundation\nimport Combine\nimport Darwin\n' + helpers + projections + file_identity + workflow + controller
source += foundation_support(repo, source_root, args.helper_root, controller)
source += r'''
@MainActor final class ReelBackend {
    struct APIError: LocalizedError { let message:String; init(_ message:String){self.message=message}; var errorDescription:String?{message} }
    var calls:[(String,String,String?)]=[]
    var response:[String:Any]=[:]
    var handler:((String,String,String?) async throws -> JSON)?
    func handle(method:String,path:String,body:String?) async throws -> JSON {
        calls.append((method,path,body))
        if let handler {return try await handler(method,path,body)}
        return JSON(any:response)
    }
}
@MainActor final class EditorSession {
    var backend:ReelBackend?,folder:URL?
    init(_ backend:ReelBackend,_ path:String){self.backend=backend;folder=URL(fileURLWithPath:path)}
    func request(method:String,path:String,body:String?) async throws -> JSON {
        guard let backend else {throw ReelBackend.APIError("Closed")}
        return try await backend.handle(method:method,path:path,body:body)
    }
}
@MainActor final class NativeEditorModel {
    let session:EditorSession
    __ROOT_TRANSCRIPT_OWNERSHIP__
    init(_ session:EditorSession){self.session=session}
    var folder:URL? {session.folder}
    var project:NativeProject?
    enum Panel: String { case transcript, edit }
    var panel:Panel = .transcript
    var selectedIDs:Set<String> = []
    var processingContextID=UUID()
    var version=0
    var composition:String?
    var capabilities:[String:Any]=["shorts":["available":true]]
    func mediaURL(_ source:String) throws -> URL {guard let folder else {throw ReelBackend.APIError("Closed")};return folder.appendingPathComponent(source)}
    func markSourceIn(_ value:Double?=nil){}
    func markSourceOut(_ value:Double?=nil){}
    func refresh() async {}
    var tracks:[NativeTrack] {project?.tracks ?? []}
    var showingSource=false
    var mobilePanel:String?="transcript"
    var selectedID:String?
    var sourceAssetID:String?
    var sourceError:String?
    var sourceTimes:[Double]=[],timelineTimes:[Double]=[],opened:[String]=[]
    var openError:String?
    func openSource(_ asset:NativeAsset){opened.append(asset.id);showingSource=true;sourceAssetID=openError == nil ? asset.id:nil;sourceError=openError}
    func seekSource(_ value:Double){sourceTimes.append(value)}
    func seek(_ value:Double){timelineTimes.append(value)}
    func call(_ path:String,_ body:[String:Any]?=nil) async throws -> [String:Any] {
        guard let backend=session.backend else {throw ReelBackend.APIError("Closed")}
        let value=try await session.request(method:body == nil ? "GET":"POST",path:path,body:body.map {JSON(any:$0).text})
        guard session.backend === backend, !Task.isCancelled else {throw CancellationError()}
        return try JSON.parse(value.text) as! [String:Any]
    }
}
@MainActor struct PreviewPresentation {
    let transcript:NativeTranscriptState
    let model:NativeEditorModel
    let session:EditorSession
    __PREVIEW_HANDOFF__
    func tap(_ index:Int){seekWord(index)}
}
@main struct Checks {
    @MainActor static func main() async throws {
        var count=0
        func check(_ value:Bool,_ label:String){precondition(value,label);count += 1}
        func record(_ text:String="saved",status:String="complete")->[String:Any] {
            ["src":"a","locale":"en-US","status":status,"revision":1,"fingerprint":"source-v1","words":[["t":2.0,"end":2.5,"text":text]]]
        }
        let backend=ReelBackend(),session=EditorSession(backend,"/project-a"),model=NativeEditorModel(session)
        let state=model.transcript
        state.attach(session:session);state.locale="en-US";state.source="a"
        try state.accept(record(),identity:state.identity,backend:backend)
        // Source-only preview runs the actual candidate controller, with AVPlayer calls recorded at its boundary.
        model.project=NativeProject(fields:["assets":["a":["duration":10.0,"hasAudio":true]],"tracks":[]])
        state.words=[NativeTranscriptWord(id:0,from:2.0,to:2.5,text:"preview")]
        state.updateWord(0,text:"keep this draft")
        let callsBeforePreview=backend.calls.count
        var waiting:CheckedContinuation<Void,Never>?
        var activeCompleted=false
        state.perform(model:model,session:session){token,capturedBackend in
            await withCheckedContinuation{waiting=$0}
            try state.check(token,backend:capturedBackend,session:session)
            activeCompleted=true
        }
        while waiting==nil {await Task.yield()}
        let presentation=PreviewPresentation(transcript:state,model:model,session:session)
        presentation.tap(0)
        check(state.busy && model.mobilePanel=="transcript","Busy word preview must not dismiss the actual iOS handoff route")
        check(model.opened.isEmpty && model.sourceTimes.isEmpty && model.timelineTimes.isEmpty,"Busy preview must not open or seek a viewer")
        check(backend.calls.count==callsBeforePreview && state.dirty,"Busy preview must preserve work and draft without cancellation writes")
        waiting!.resume()
        while state.busy {await Task.yield()}
        check(activeCompleted,"Busy preview must not cancel/invalidate the active production operation")

        check(state.previewWord(0,model:model,session:session),"Unplaced transcript word must preview")
        check(model.opened==["a"] && model.sourceTimes==[2.0] && model.showingSource,"Source fallback must open exact source and use source seconds")
        check(state.dirty && state.words[0].text=="keep this draft" && backend.calls.count==callsBeforePreview,"Preview must keep corrections and not issue a write")
        state.suspend()
        check(state.dirty && state.words[0].text=="keep this draft","Preview sheet dismissal must retain corrections")
        model.project=NativeProject(fields:["assets":["a":["duration":10.0,"hasAudio":true]],"tracks":[["id":"v1","clips":[["id":"clip","src":"a","in":1.0,"start":5.0,"dur":3.0,"speed":2.0]]]]])
        check(state.previewWord(0,model:model,session:session),"Placed word must retain timeline preview route")
        check(model.timelineTimes==[5.5] && model.selectedID=="clip" && !model.showingSource,"Timeline preview must convert speed and in-point while selecting the matching placement")
        model.project=NativeProject(fields:["assets":["a":["duration":10.0,"hasAudio":true]],"tracks":[["id":"v1","clips":[["id":"reverse","src":"a","dur":10.0,"reverse":true],["id":"freeze","src":"a","dur":10.0,"freeze":1.0]]]]])
        check(state.previewWord(0,model:model,session:session) && model.opened.count==2,"Reverse/freeze placements must fall back to source seconds")
        model.openError="Missing file"
        check(!state.previewWord(0,model:model,session:session) && state.message=="Missing file" && model.sourceTimes.count==2,"Unavailable source must surface its error without seeking or discarding")
        model.openError=nil
        model.project=NativeProject(fields:["assets":[:]])
        check(!state.previewWord(0,model:model,session:session),"Removed source must not preview")
        session.backend=ReelBackend()
        let attempts=model.opened.count
        check(!state.previewWord(0,model:model,session:session) && model.opened.count==attempts,"Replacement backend at the same project path must reject old words")
        session.backend=backend;session.folder=URL(fileURLWithPath:"/project-b")
        check(!state.previewWord(0,model:model,session:session) && model.opened.count==attempts,"Project switch must not route old transcript into another source with the same ID")
        session.folder=URL(fileURLWithPath:"/project-a")
        model.project=NativeProject(fields:["assets":["a":["duration":1.0,"hasAudio":true]]])
        check(!state.previewWord(0,model:model,session:session) && state.dirty,"Out-of-duration words must not clamp to unrelated source content or discard corrections")
        check(!state.previewWord(99,model:model,session:session),"Stale word indices must not seek")
        model.project=NativeProject(fields:["assets":["a":["duration":10.0,"hasAudio":true]]])
        state.words=[NativeTranscriptWord(id:0,from:Double.nan,to:3,text:"invalid")]
        check(!state.previewWord(0,model:model,session:session),"Non-finite word time must not seek")
        state.words=[NativeTranscriptWord(id:0,from:-1,to:1,text:"invalid")]
        check(!state.previewWord(0,model:model,session:session),"Negative word time must not seek")
        state.discardDraft();try state.accept(record(status:"stale"),identity:state.identity,backend:backend)
        check(!state.previewWord(0,model:model,session:session),"A stale transcript source must require revalidation before preview")
        // Non-scalar and unavailable timeline placements must never use the scalar seek formula.
        try state.accept(record(),identity:state.identity,backend:backend)
        for fields in [
            ["id":"time-map","src":"a","in":0.0,"start":4.0,"dur":5.0,"timeMap":[[0.0,0.0],[5.0,10.0]]] as [String:Any],
            ["id":"disabled","src":"a","in":0.0,"start":4.0,"dur":5.0,"enabled":false] as [String:Any],
            ["id":"nonfinite-speed","src":"a","in":0.0,"start":4.0,"dur":5.0,"speed":Double.infinity] as [String:Any]
        ] {
            model.project=NativeProject(fields:["assets":["a":["duration":10.0,"hasAudio":true]],"tracks":[["id":"v1","clips":[fields]]]])
            let timelineBefore=model.timelineTimes.count, sourceBefore=model.sourceTimes.count
            check(state.previewWord(0,model:model,session:session),"Unsupported timeline placement must still allow source preview")
            check(model.timelineTimes.count==timelineBefore && model.sourceTimes.count==sourceBefore+1 && model.sourceTimes.last==2.0 && model.showingSource,"Non-scalar/disabled placement must fall back to exact source time")
        }
        print("PASS: \(count) candidate transcript-preview controller assertions")
    }
}
'''
source = source.replace('__ROOT_TRANSCRIPT_OWNERSHIP__', ownership).replace('__PREVIEW_HANDOFF__', handoff)
if args.prepare_only:
    args.prepare_only.parent.mkdir(parents=True, exist_ok=True)
    args.prepare_only.write_text(source)
    print('Prepared actual controller and Foundation helper fixture; Swift was not compiled or executed.')
    raise SystemExit(0)

with tempfile.TemporaryDirectory(prefix='arya-transcript-preview-') as temp:
    folder=Path(temp);swift=folder/'Checks.swift';binary=folder/'checks'
    swift.write_text(source)
    subprocess.run(['swiftc','-j1','-parse-as-library','-module-cache-path',str(folder/'cache'),str(repo/'native/ReelKit/Sources/ReelKit/JSON.swift'),str(swift),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)
