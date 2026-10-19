#!/usr/bin/env python3
"""Exercise the production transcript controller across panel and backend lifetimes."""
from pathlib import Path
import subprocess
import tempfile
from native_transcript_fixture import foundation_support

repo = Path(__file__).resolve().parents[2]
editor = repo / 'native/App/Shared/NativeEditor'
panel = (editor / 'NativeTranscriptPanel.swift').read_text()
project = (editor / 'NativeProject.swift').read_text()
model = (editor / 'NativeEditorModel.swift').read_text()
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
assert 'Button("Recover corrections")' in panel
assert 'Button("Copy recovery text")' in panel
assert 'Button("Discard recovery copy", role: .destructive)' in panel
assert 'recoverySession?.update(words)' in panel
projections = project[project.index('struct NativeProject {'):project.index('enum NativeProcessingRequests {')]
workflow = panel.split('// BEGIN SHORTS WORKFLOW\n', 1)[1].split('// END SHORTS WORKFLOW', 1)[0]
source_identity = model[model.index('struct NativeSourceFileIdentity: Equatable {'):model.index('enum NativePanel:')]
source = 'import Foundation\nimport Combine\nimport Darwin\n' + helpers + projections + source_identity + workflow + controller
# Real ReelKit locale/validation and timed-import helpers used by the controller.
source += foundation_support(repo, repo, None, controller)
source += r'''
extension NativeTranscriptState {
    var fixtureRevision: Any? { revision }
}

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
    var capabilities:[String:Any]=[:]
    var version=1
    var composition:String?
    enum Panel: String { case transcript, edit }
    var panel:Panel = .transcript
    var selectedIDs:Set<String> = []
    var processingContextID=UUID()
    func mediaURL(_ source:String) throws -> URL {guard let folder else {throw ReelBackend.APIError("Closed")};return folder.appendingPathComponent(source)}
    func refresh() async {}
    func markSourceIn(_ value:Double){preconditionFailure("Unexpected short clip playback")}
    func markSourceOut(_ value:Double){preconditionFailure("Unexpected short clip playback")}
    var tracks:[NativeTrack] {project?.tracks ?? []}
    var showingSource=false
    var selectedID:String?
    var sourceAssetID:String?
    var sourceError:String?
    // Lifecycle checks never request playback; the separate preview test exercises it.
    func openSource(_ asset:NativeAsset){preconditionFailure("Unexpected playback during draft lifecycle")}
    func seekSource(_ value:Double){preconditionFailure("Unexpected source seek during draft lifecycle")}
    func seek(_ value:Double){preconditionFailure("Unexpected timeline seek during draft lifecycle")}
    func call(_ path:String,_ body:[String:Any]?=nil) async throws -> [String:Any] {
        guard let backend=session.backend else {throw ReelBackend.APIError("Closed")}
        let value=try await session.request(method:body == nil ? "GET":"POST",path:path,body:body.map {JSON(any:$0).text})
        guard session.backend === backend, !Task.isCancelled else {throw CancellationError()}
        return try JSON.parse(value.text) as! [String:Any]
    }
}
@main struct Checks {
    @MainActor static func main() async throws {
        var count=0
        func check(_ value:Bool,_ label:String){precondition(value,label);count += 1}
        func drain() async {for _ in 0..<100 {await Task.yield()}}
        func record(_ text:String="saved",revision:Int=1,fingerprint:String="source-v1",status:String="complete")->[String:Any] {
            ["src":"a","locale":"en-US","status":status,"revision":revision,"fingerprint":fingerprint,"words":[["t":0.0,"end":1.0,"text":text]]]
        }
        let backend=ReelBackend(),session=EditorSession(backend,"/project-a"),model=NativeEditorModel(session)
        let state=model.transcript
        state.attach(session:session);state.locale="en-US";state.source="a"
        try state.accept(record(),identity:state.identity,backend:backend)
        state.updateWord(0,text:"corrected");state.selectedWords=[0];state.query="correct"
        state.suspend()
        let recreated=model.transcript
        recreated.attach(session:session)
        check(recreated === state,"Panel recreation must use root-owned production state")
        check(state.dirty && state.words[0].text=="corrected" && state.selectedWords==[0] && state.query=="correct","Dismiss/recreate must retain correction, passage and search")
        check(state.source=="a" && state.locale=="en-US" && state.hasCurrentTranscript,"Resize must retain source/locale/current identity")
        check(backend.calls.isEmpty,"Dismiss/recreate must not save automatically")

        state.source="b"
        try state.accept(record("other"),identity:state.identity,backend:backend)
        state.source="a"
        try state.accept(record(),identity:state.identity,backend:backend)
        check(state.dirty && state.words[0].text=="corrected" && !state.draftConflict,"Changing source then returning must restore its guarded draft")
        state.locale="es-ES"
        try state.accept(record("otra"),identity:state.identity,backend:backend)
        state.locale="en-US"
        try state.accept(record(),identity:state.identity,backend:backend)
        check(state.dirty && state.words[0].text=="corrected","Locale drafts must remain independent")

        let foreign=ReelBackend()
        session.backend=foreign;session.folder=URL(fileURLWithPath:"/project-b")
        do {_ = try state.requireCurrentTranscript(session:session);preconditionFailure("Foreign backend save allowed")}catch {}
        state.projectDidChange();state.attach(session:session);state.source="a"
        try state.accept(record("project-b"),identity:state.identity,backend:foreign)
        check(!state.dirty && state.words[0].text=="project-b","Same source ID in another project must not inherit corrections")
        check(foreign.calls.isEmpty,"Switching project must not silently save old words")
        state.projectDidChange();let reopened=ReelBackend();session.backend=reopened;session.folder=URL(fileURLWithPath:"/project-a")
        state.attach(session:session)
        check(state.source=="a" && state.locale=="en-US","Returning to a project must retain its last source/locale")
        try state.accept(record(),identity:state.identity,backend:reopened)
        check(state.dirty && state.words[0].text=="corrected" && state.hasCurrentTranscript,"Reopened backend must validate then recover its matching draft")
        do {try state.accept(record("late-old"),identity:state.identity,backend:backend);preconditionFailure("Old backend result allowed")}catch {}
        check(state.words[0].text=="corrected","Old backend acceptance must not replace recovered corrections")

        for changed in [record(revision:2),record(fingerprint:"source-v2"),record(status:"stale")] {
            try state.accept(changed,identity:state.identity,backend:reopened)
            check(state.dirty && state.draftConflict && !state.hasCurrentTranscript,"Changed revision/source must retain draft while blocking save")
            check(state.words[0].text=="corrected","Conflicting source must not erase unsaved text")
            do {_ = try state.requireCurrentTranscript(session:session);preconditionFailure("Conflict save allowed")}catch {}
            state.updateWord(0,text:"must-not-change")
            check(state.words[0].text=="corrected","Conflicting words must not be treated as a current editable transcript")
        }
        reopened.response=record()
        state.load(model:model,session:session)
        await drain()
        check(state.dirty && !state.draftConflict && state.hasCurrentTranscript,"Explicit recheck may validate without autosaving")
        check(reopened.calls.allSatisfy {$0.0=="GET"},"Revalidation must never write")

        var late:CheckedContinuation<JSON,Error>?
        reopened.handler={_,_,_ in try await withCheckedThrowingContinuation {late=$0}}
        state.load(model:model,session:session);await drain()
        check(late != nil,"Production load must actually enter suspended request")
        state.suspend();let before=state.words[0].text
        late!.resume(returning:JSON(any:record("late-recognition",revision:5)));await drain()
        check(state.words[0].text==before && state.dirty,"Dismissed late recognition must not replace draft")
        check(!state.busy,"Cancelled load must clear busy state")

        reopened.handler=nil;reopened.response=record()
        state.load(model:model,session:session);await drain()
        let messageBefore=state.message
        var lateError:CheckedContinuation<Void,Error>?
        state.perform(model:model,session:session){_,_ in try await withCheckedThrowingContinuation {lateError=$0}}
        await drain();check(lateError != nil,"Production operation must enter delayed failure")
        state.projectDidChange();session.backend=foreign;session.folder=URL(fileURLWithPath:"/project-b");state.attach(session:session);state.source="a"
        try state.accept(record("new-project"),identity:state.identity,backend:foreign)
        let newMessage=state.message
        lateError!.resume(throwing:ReelBackend.APIError("late old-project error"));await drain()
        check(state.message==newMessage && state.words[0].text=="new-project","Late failure must not pollute a different project")
        check(messageBefore != "late old-project error","Old errors must not pre-exist")

        // A loaded-panel save conflict must enter recovery even without a backend rebind.
        state.projectDidChange();session.backend=reopened;session.folder=URL(fileURLWithPath:"/project-a");state.attach(session:session)
        try state.accept(record(),identity:state.identity,backend:reopened)
        reopened.handler={method,_,_ in
            if method=="POST" {throw ReelBackend.APIError("The transcript changed. Reload it before saving corrections.")}
            return JSON(any:record("external",revision:2))
        }
        state.perform(model:model,session:session){token,owner in try await state.save(model:model,session:session,token:token,backend:owner)}
        await drain()
        check(state.dirty && state.draftConflict && !state.hasCurrentTranscript,"Live save conflict must block blind retry and expose recovery")
        check(state.words[0].text=="corrected","Failed save must retain unsaved corrections")
        let recoveryText=state.retainedCorrectionsText
        check(recoveryText.contains("Source: a") && recoveryText.contains("Language: en-US") && recoveryText.contains("[0.0–1.0 s] corrected"),"Production recovery text must include retained words and source timings")
        check(!recoveryText.contains("external") && !recoveryText.contains("project-b"),"Copy must contain the retained draft, not conflicting backend words")
        state.load(model:model,session:session);await drain()
        check(state.draftConflict && state.words[0].text=="corrected","Explicit recheck must preserve conflicting corrections")
        check(state.retainedCorrectionsText==recoveryText,"Revalidation must not destroy the copy route")

        // An error after a real backend commit is an uncertain outcome, not a safe retry.
        state.discardDraft();try state.accept(record(),identity:state.identity,backend:reopened);state.updateWord(0,text:"response-lost")
        var committed=record(),writeCount=0
        reopened.handler={method,_,body in
            if method=="POST" {
                writeCount += 1
                let request=try JSON.parse(body!) as! [String:Any]
                committed=record("response-lost",revision:2)
                committed["words"]=request["words"]
                throw ReelBackend.APIError("Connection lost after commit")
            }
            return JSON(any:committed)
        }
        state.perform(model:model,session:session){token,owner in try await state.save(model:model,session:session,token:token,backend:owner)}
        await drain()
        check(writeCount==1 && state.dirty && state.draftConflict,"Uncertain committed save must retain words and block another write")
        state.perform(model:model,session:session){token,owner in try await state.save(model:model,session:session,token:token,backend:owner)}
        await drain()
        check(writeCount==1,"A blocked retry must not reach the backend")
        state.load(model:model,session:session);await drain()
        check(state.dirty && state.draftConflict && state.words[0].text=="response-lost","Recheck must explain the revision conflict without discarding words")
        check(state.retainedCorrectionsText.contains("response-lost"),"Copy route must remain usable after uncertain commit")
        state.discardDraft();state.load(model:model,session:session);await drain()
        check(!state.dirty && state.words[0].text=="response-lost" && state.hasCurrentTranscript,"Explicit discard/load may recover the committed backend record")

        // Cancel while the save response is pending, after the backend wrote it.
        state.updateWord(0,text:"cancelled-response")
        var saveResponse:CheckedContinuation<JSON,Error>?
        reopened.handler={method,_,body in
            if method=="POST" {
                let request=try JSON.parse(body!) as! [String:Any]
                committed=record("cancelled-response",revision:3);committed["words"]=request["words"]
                return try await withCheckedThrowingContinuation {saveResponse=$0}
            }
            return JSON(any:committed)
        }
        state.perform(model:model,session:session){token,owner in try await state.save(model:model,session:session,token:token,backend:owner)}
        await drain();check(saveResponse != nil,"Save must actually wait on its response")
        state.suspend();saveResponse!.resume(returning:JSON(any:committed));await drain()
        check(state.dirty && state.draftConflict && state.words[0].text=="cancelled-response","Cancelled response must preserve recoverable draft and require recheck")
        state.load(model:model,session:session);await drain()
        check(state.draftConflict && state.retainedCorrectionsText.contains("cancelled-response"),"Cancelled committed save must remain recoverable after recheck")
        state.discardDraft();try state.accept(record(),identity:state.identity,backend:reopened);state.updateWord(0,text:"corrected");state.suspend()

        // A cancelled transcription submission must cancel its returned job and never apply a late result.
        state.projectDidChange();session.backend=reopened;session.folder=URL(fileURLWithPath:"/project-a");state.attach(session:session)
        try state.accept(record(),identity:state.identity,backend:reopened)
        var submission:CheckedContinuation<JSON,Error>?
        reopened.handler={_,path,_ in
            if path=="/api/analyze" {return try await withCheckedThrowingContinuation {submission=$0}}
            return JSON(any:["state":"cancelled"])
        }
        state.perform(model:model,session:session){token,owner in
            let requested=state.identity
            let result=try await state.startJob("/api/analyze",body:["src":requested.source,"wait":false],model:model,session:session)
            try state.check(token,backend:owner,session:session)
            try state.accept(result,identity:requested,backend:owner)
        }
        await drain();check(submission != nil,"Transcription must reach real production submission path")
        let recognitionBefore=state.words[0].text
        state.suspend();submission!.resume(returning:JSON(any:["id":"late-job","state":"running"]))
        await drain()
        check(state.words[0].text==recognitionBefore && state.dirty,"Cancelled submission must preserve retained correction")
        check(reopened.calls.contains {$0.1=="/api/jobs/cancel" && $0.2?.contains("late-job")==true},"Late cancelled job must be cancelled on its original backend")
        reopened.handler=nil

        // Save must go through the production captured operation, preserve revision, and clear only this draft.
        state.projectDidChange();session.backend=reopened;session.folder=URL(fileURLWithPath:"/project-a");state.attach(session:session)
        try state.accept(record(),identity:state.identity,backend:reopened)
        reopened.response=record("corrected",revision:2)
        state.perform(model:model,session:session){token,owner in try await state.save(model:model,session:session,token:token,backend:owner)}
        await drain()
        let saved=reopened.calls.last(where: {$0.0=="POST" && $0.1=="/api/transcript"})!
        let body=try JSON.parse(saved.2!) as! [String:Any]
        check(saved.0=="POST" && body["revision"] as? Int==1,"Save must retain original transcript revision")
        check((body["words"] as! [[String:Any]])[0]["text"] as? String=="corrected","Only explicit save may write retained words")
        check(!state.dirty && state.hasCurrentTranscript,"Successful current save must clear draft only after completion")
        state.suspend();state.source="b";try state.accept(record("b"),identity:state.identity,backend:reopened);state.source="a"
        try state.accept(record("corrected",revision:2),identity:state.identity,backend:reopened)
        check(!state.dirty,"Saved draft must not resurrect after source switch")
        state.updateWord(0,text:"discard-this");state.suspend();state.discardDraft();try state.accept(record("corrected",revision:2),identity:state.identity,backend:reopened)
        check(!state.dirty && state.words[0].text=="corrected","Explicit discard must reload saved words without writing")

        // Recreate the actual owner after disk offers exist. A GET must never apply them.
        let diskBackend=ReelBackend(),diskSession=EditorSession(diskBackend,"/project-durable"),diskModel=NativeEditorModel(diskSession)
        let diskState=diskModel.transcript,offerID=UUID().uuidString.lowercased()
        let captured:[String:Any]=["revision":1,"fingerprint":"source-v1"]
        let offer:[String:Any]=["id":offerID,"sessionID":UUID().uuidString.lowercased(),"sequence":1,"createdAt":1,"wordCount":1,"recoverable":true]
        var exactText=" \t recovered \n",checkpointBodies:[[String:Any]]=[]
        diskBackend.handler={method,path,body in
            if method=="GET",path.hasPrefix("/api/transcript/drafts") {return JSON(any:["basis":captured,"offers":[offer]])}
            if method=="GET" {return JSON(any:record())}
            let value=try JSON.parse(body ?? "{}") as! [String:Any]
            if path=="/api/transcript/drafts/checkpoint" {
                checkpointBodies.append(value)
                return JSON(any:["id":UUID().uuidString.lowercased(),"sequence":value["sequence"]!])
            }
            if path=="/api/transcript/drafts/read" || path=="/api/transcript/drafts/recover" {return JSON(any:["basis":captured,"words":[["t":0.0,"end":1.0,"text":exactText]]])}
            return JSON(any:[:])
        }
        diskState.attach(session:diskSession);diskState.locale="en-US";diskState.source="a"
        diskState.load(model:diskModel,session:diskSession);await drain()
        check(diskState.words[0].text=="saved" && !diskState.dirty && diskState.recoveryOffers.count==1,"A reopened owner must offer disk recovery without applying it")
        check(diskBackend.calls.allSatisfy {$0.0=="GET"},"Loading an offer must never checkpoint or save words")
        var copied=""
        diskState.recoveryAction("copy",offer:offer,model:diskModel,session:diskSession,copy:{copied=$0});await drain()
        check(copied==exactText && diskState.words[0].text=="saved" && !diskState.dirty,"Copy must preserve exact text and leave current timestamps untouched")
        diskState.recoveryAction("recover",offer:offer,model:diskModel,session:diskSession);await drain()
        check(diskState.dirty && diskState.words[0].text==exactText && diskState.words[0].from==0 && diskState.words[0].to==1,"Only explicit guarded recovery may load unsaved words")
        check(checkpointBodies.count==1 && (checkpointBodies[0]["words"] as! [[String:Any]])[0]["text"] as? String==exactText,"Actual native edits must call the durable checkpoint path with exact text")
        check(!diskBackend.calls.contains {$0.1=="/api/transcript" && $0.0=="POST"},"Recovery must not publish a saved transcript")
        diskState.updateWord(0,text:"");await drain()
        check((checkpointBodies.last!["words"] as! [[String:Any]])[0]["text"] as? String=="","An empty native correction must remain recoverable")
        diskState.suspend()
        check(diskState.words[0].text=="" && diskState.dirty,"Panel dismissal must retain the current recovery owner")
        exactText="stale-only-copy"
        diskState.discardDraft();diskState.load(model:diskModel,session:diskSession);await drain()
        diskBackend.handler={method,path,_ in
            if path=="/api/transcript/drafts/recover" {throw ReelBackend.APIError("The source changed. Copy its text instead.")}
            if path=="/api/transcript/drafts/read" {return JSON(any:["words":[["t":20.0,"end":21.0,"text":exactText]]])}
            return JSON(any:record())
        }
        diskState.recoveryAction("recover",offer:offer,model:diskModel,session:diskSession);await drain()
        check(diskState.words[0].text=="saved" && !diskState.dirty,"A stale server rejection must not apply old source timestamps")
        diskState.recoveryAction("copy",offer:offer,model:diskModel,session:diskSession,copy:{copied=$0});await drain()
        check(copied=="stale-only-copy" && diskState.words[0].from==0,"Stale text remains copyable without rewriting native source timestamps")


        // An old retirement may finish after the same folder/source gets a new backend owner.
        for saving in [false,true] {
            let old=ReelBackend(),owner=EditorSession(old,"/same-key"),ownerModel=NativeEditorModel(owner),ownerState=ownerModel.transcript
            var retirement:CheckedContinuation<JSON,Error>?
            old.handler={method,path,body in
                if method=="GET",path.hasPrefix("/api/transcript/drafts") {return JSON(any:["basis":captured,"offers":[]])}
                if method=="GET" {return JSON(any:record())}
                if path=="/api/transcript/drafts/checkpoint" {let value=try JSON.parse(body!) as! [String:Any];return JSON(any:["id":UUID().uuidString.lowercased(),"sequence":value["sequence"]!])}
                if path=="/api/transcript/drafts/discard" {return try await withCheckedThrowingContinuation {retirement=$0}}
                return JSON(any:record("old-saved",revision:2))
            }
            ownerState.attach(session:owner);ownerState.locale="en-US";ownerState.source="a";ownerState.load(model:ownerModel,session:owner);await drain()
            ownerState.updateWord(0,text:"old-correction");await drain()
            ownerState.perform(model:ownerModel,session:owner) {token,backend in
                if saving {try await ownerState.save(model:ownerModel,session:owner,token:token,backend:backend)}
                else {try await ownerState.discardDurableDraft(model:ownerModel,session:owner,token:token,backend:backend)}
            }
            await drain();check(retirement != nil && ownerState.busy,"Save/discard must keep the old owner busy until retirement returns")
            let oldCheckpointBody=try JSON.parse(old.calls.first {$0.0=="POST" && $0.1=="/api/transcript/drafts/checkpoint"}!.2!) as! [String:Any]
            let oldRecoverySessionID=oldCheckpointBody.string("sessionID")
            check(!oldRecoverySessionID.isEmpty,"The suspended old owner must have a recovery session before replacement")
            let next=ReelBackend();var newCheckpoints=0;var newCheckpointBodies:[[String:Any]]=[];var newCheckpointIDs:[String]=[]
            next.handler={method,path,body in
                if method=="GET",path.hasPrefix("/api/transcript/drafts") {return JSON(any:["basis":captured,"offers":[]])}
                if method=="GET" {return JSON(any:record())}
                if path=="/api/transcript/drafts/checkpoint" {newCheckpoints += 1;let value=try JSON.parse(body!) as! [String:Any];newCheckpointBodies.append(value);let id=UUID().uuidString.lowercased();newCheckpointIDs.append(id);return JSON(any:["id":id,"sequence":value["sequence"]!])}
                return JSON(any:[:])
            }
            owner.backend=next;ownerState.attach(session:owner);ownerState.source="a";ownerState.load(model:ownerModel,session:owner);await drain()
            FileHandle.standardError.write(Data("OWNER-CHECK saving=\(saving) phase=restored checkpoints=\(newCheckpoints) busy=\(ownerState.busy) dirty=\(ownerState.dirty) word=\(ownerState.words.first?.text ?? "<none>")\n".utf8))
            check(newCheckpoints==1 && newCheckpointBodies.count==1 && newCheckpointIDs.count==1,"The replacement load must checkpoint the retained corrections exactly once")
            let replacementSessionID=newCheckpointBodies[0].string("sessionID")
            check(!replacementSessionID.isEmpty && replacementSessionID != oldRecoverySessionID,"The restored draft must belong to a new backend recovery session")
            check(newCheckpointBodies[0].objects("words").map {$0.string("text")}==["old-correction"] && newCheckpointBodies[0]["sequence"] as? Int==1 && newCheckpointBodies[0]["parent"] is NSNull,"The replacement recovery session must start with the exact retained words and a fresh checkpoint chain")
            ownerState.updateWord(0,text:"new-owner-first");await drain()
            FileHandle.standardError.write(Data("OWNER-CHECK saving=\(saving) phase=first-edit checkpoints=\(newCheckpoints) busy=\(ownerState.busy) dirty=\(ownerState.dirty) word=\(ownerState.words.first?.text ?? "<none>")\n".utf8))
            check(newCheckpoints==2 && newCheckpointBodies.count==2 && newCheckpointIDs.count==2,"The replacement same-key owner must create its own recovery session")
            check(newCheckpointBodies[1].objects("words").map {$0.string("text")}==["new-owner-first"] && newCheckpointBodies[1]["sequence"] as? Int==2 && newCheckpointBodies[1]["sessionID"] as? String==replacementSessionID && newCheckpointBodies[1]["parent"] as? String==newCheckpointIDs[0],"The first replacement edit must extend its own retained-draft checkpoint chain")
            let beforeMessage=ownerState.recoveryMessage
            retirement!.resume(returning:JSON(any:[:]));await drain()
            FileHandle.standardError.write(Data("OWNER-CHECK saving=\(saving) phase=old-retired checkpoints=\(newCheckpoints) busy=\(ownerState.busy) dirty=\(ownerState.dirty) word=\(ownerState.words.first?.text ?? "<none>")\n".utf8))
            check(newCheckpoints==2 && newCheckpointBodies.count==2 && newCheckpointIDs.count==2,"The old retirement must not create a replacement-owner checkpoint")
            check(ownerState.words[0].text=="new-owner-first" && ownerState.dirty,"The old retirement must never clear replacement owner words")
            check(ownerState.recoveryMessage==beforeMessage,"The old retirement must never write status into a replacement owner")
            ownerState.updateWord(0,text:"new-owner-second");await drain()
            FileHandle.standardError.write(Data("OWNER-CHECK saving=\(saving) phase=second-edit checkpoints=\(newCheckpoints) busy=\(ownerState.busy) dirty=\(ownerState.dirty) word=\(ownerState.words.first?.text ?? "<none>")\n".utf8))
            check(newCheckpoints==3 && newCheckpointBodies.count==3 && newCheckpointIDs.count==3,"Old retirement must not remove the replacement recovery session from the same dictionary key")
            check(newCheckpointBodies[2].objects("words").map {$0.string("text")}==["new-owner-second"] && newCheckpointBodies[2]["sequence"] as? Int==3 && newCheckpointBodies[2]["sessionID"] as? String==replacementSessionID && newCheckpointBodies[2]["parent"] as? String==newCheckpointIDs[1],"The second replacement edit must retain the same recovery owner after the old retirement")
        }
        // The actual discard action uses perform. Edits cannot be admitted during its awaited flush/retirement.
        let discardBackend=ReelBackend(),discardSession=EditorSession(discardBackend,"/discard-pending"),discardModel=NativeEditorModel(discardSession),discardState=discardModel.transcript
        var pendingCheckpoint:CheckedContinuation<JSON,Error>?,pendingBody:[String:Any]=[:]
        discardBackend.handler={method,path,body in
            if method=="GET",path.hasPrefix("/api/transcript/drafts") {return JSON(any:["basis":captured,"offers":[]])}
            if method=="GET" {return JSON(any:record())}
            if path=="/api/transcript/drafts/checkpoint" {pendingBody=try JSON.parse(body!) as! [String:Any];return try await withCheckedThrowingContinuation {pendingCheckpoint=$0}}
            return JSON(any:[:])
        }
        discardState.attach(session:discardSession);discardState.locale="en-US";discardState.source="a";discardState.load(model:discardModel,session:discardSession);await drain()
        discardState.updateWord(0,text:"pending-correction");await drain()
        discardState.perform(model:discardModel,session:discardSession) {token,backend in try await discardState.discardDurableDraft(model:discardModel,session:discardSession,token:token,backend:backend)}
        await drain();check(discardState.busy && pendingCheckpoint != nil,"Discard must block editing while its checkpoint is pending")
        discardState.updateWord(0,text:"must-not-be-cleared");check(discardState.words[0].text=="pending-correction","Editing must be refused while discard awaits the retained checkpoint")
        pendingCheckpoint!.resume(returning:JSON(any:["id":UUID().uuidString.lowercased(),"sequence":pendingBody["sequence"]!]));await drain()
        check(!discardState.busy && !discardState.dirty && discardState.words[0].text=="saved","Only the confirmed owned draft is cleared after retirement and reload")


        for retirementFails in [false,true] {
        let freshBackend=ReelBackend(),freshSession=EditorSession(freshBackend,"/fresh-save"),freshModel=NativeEditorModel(freshSession),freshState=freshModel.transcript
        var freshRecord=record(),freshCopies:[[String:Any]]=[]
        freshBackend.handler={method,path,body in
            if method=="GET",path.hasPrefix("/api/transcript/drafts") {return JSON(any:["basis":["revision":freshRecord["revision"]!,"fingerprint":"source-v1"],"offers":[]])}
            if method=="GET" {return JSON(any:freshRecord)}
            let value=try JSON.parse(body ?? "{}") as! [String:Any]
            if path=="/api/transcript/drafts/checkpoint" {freshCopies.append(value);return JSON(any:["id":UUID().uuidString.lowercased(),"sequence":value["sequence"]!])}
            if path=="/api/transcript/drafts/discard",retirementFails {throw ReelBackend.APIError("fixture old recovery discard unavailable")}
            if path=="/api/transcript" {freshRecord=record("first-saved",revision:2);freshRecord["words"]=value["words"];return JSON(any:freshRecord)}
            return JSON(any:[:])
        }
        freshState.attach(session:freshSession);freshState.locale="en-US";freshState.source="a";freshState.load(model:freshModel,session:freshSession);await drain()
        freshState.updateWord(0,text:"first-saved");await drain()
        freshState.perform(model:freshModel,session:freshSession) {token,backend in try await freshState.save(model:freshModel,session:freshSession,token:token,backend:backend)}
        await drain();check(!freshState.busy && !freshState.dirty && freshState.fixtureRevision as? Int==2,"Successful save must reload the observed revision before accepting another edit")
        freshState.updateWord(0,text:"next-unsaved");await drain()
        check(freshCopies.count==2 && (freshCopies.last!["basis"] as! [String:Any])["revision"] as? Int==2,"The next native correction must checkpoint with the newly saved revision and basis")
        check((freshCopies.last!["words"] as! [[String:Any]])[0]["text"] as? String=="next-unsaved","The fresh recovery session must retain the exact next correction")
        }

        print("PASS: \(count) production transcript lifecycle assertions")
    }
}
'''
source = source.replace('__ROOT_TRANSCRIPT_OWNERSHIP__', ownership)
with tempfile.TemporaryDirectory(prefix='arya-transcript-drafts-') as temp:
    folder=Path(temp);swift=folder/'Checks.swift';binary=folder/'checks'
    swift.write_text(source)
    subprocess.run(['swiftc','-j1','-parse-as-library','-module-cache-path',str(folder/'cache'),str(repo/'native/ReelKit/Sources/ReelKit/JSON.swift'),str(swift),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)
