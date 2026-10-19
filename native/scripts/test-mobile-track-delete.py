#!/usr/bin/env python3
"""Run captured track deletion, real edit dispatch, and the existing backend revision guard."""
from pathlib import Path
import argparse
import subprocess
import tempfile
parser=argparse.ArgumentParser()
parser.add_argument('--repo-root',type=Path,default=Path(__file__).resolve().parents[2])
parser.add_argument('--source-root',type=Path)
args=parser.parse_args();repo=args.repo_root;candidate=args.source_root or repo
editor=repo/'native/App/Shared/NativeEditor'
timeline=(candidate/'native/App/Shared/NativeEditor/NativeTimeline.swift').read_text()
project=(editor/'NativeProject.swift').read_text();model=(editor/'NativeEditorModel.swift').read_text()
backend=(repo/'native/ReelKit/Sources/ReelKit/ReelBackend.swift').read_text()
controller=timeline.split('// BEGIN TRACK DELETION CONTROLLER\n',1)[1].split('// END TRACK DELETION CONTROLLER',1)[0]
helpers=project[project.index('extension Dictionary where Key == String, Value == Any {'):project.index('// Foundation-only receipt helpers')]
projections=project[project.index('struct NativeProject {'):project.index('enum NativeProcessingRequests {')]
call=model[model.index('    @discardableResult\n    func call('):model.index('    func ops(')]
# The confirmed marker commit sits between editBatch and update; this harness never calls it.
edits=model[model.index('    func edit(_ operation:'):model.index('    // BEGIN CONFIRMED MARKER COMMIT')]
haptics=model.split('// BEGIN HAPTIC POLICY\n',1)[1].split('// END HAPTIC POLICY',1)[0]
version_guard=next(line.strip() for line in backend.splitlines() if 'if let expected = b["expectedVersion"] as? Int, expected != version' in line)
assert 'generation = UUID()' in model.split('func reset()',1)[1].split('func refresh()',1)[0]
mobile=timeline.split('private func trackHeader(_ track: NativeTrack)',1)[1].split('#else',1)[0]
assert 'let deletion = NativeTrackDeletion(track: track, model: model)' in mobile
assert 'Button("Delete track", role: .destructive) { deletion?.delete(model: model) }' in mobile
assert '.disabled(deletion == nil)' in mobile
# Instrument the actual encoding boundary rather than timing a synthetic initializer.
# Repeated closed-menu captures must do no canonical JSON work at all.
assert controller.count('private static func state(_ fields: [String: Any]) -> Data? {') == 1
controller=controller.replace('private static func state(_ fields: [String: Any]) -> Data? {',
    'static var encodingCalls = 0\n    private static func state(_ fields: [String: Any]) -> Data? {\n        encodingCalls += 1')
source='import Foundation\n'+haptics+helpers+projections+controller+r'''
@MainActor final class ReelBackend {
 struct APIError:LocalizedError{let message:String;init(_ message:String){self.message=message};var errorDescription:String?{message}}
 var version=7,writes=0
 var requests:[[String:Any]]=[]
 var wait:CheckedContinuation<Void,Never>?
 var shouldWait=false
 func handle(method:String,path:String,body:String?) async throws -> JSON {
  let b=try JSON.parse(body!) as! [String:Any]
  requests.append(b)
  __VERSION_GUARD__
  if shouldWait {await withCheckedContinuation {wait=$0}}
  __VERSION_GUARD__
  writes += 1
  return JSON(any:[:])
 }
}
@MainActor final class EditorSession {
 var folder:URL?=URL(fileURLWithPath:"/project-a")
 var backend:ReelBackend?=ReelBackend()
 var error:String?
 func request(method:String,path:String,body:String?) async throws -> JSON {try await backend!.handle(method:method,path:path,body:body)}
}
@MainActor final class NativeEditorModel {
 var session:EditorSession?
 var generation=UUID()
 var processingContextID:UUID{generation}
 var folder:URL?{session?.folder}
 var composition:String?
 var version=7
 var project:NativeProject?
 var tracks:[NativeTrack]{project?.tracks(in:composition) ?? []}
 var status=""
 init(_ session:EditorSession){self.session=session}
 func receive(_ event:String,_ text:String){}
 func emitHaptic(_ kind:NativeHapticKind?){}
 __REAL_MODEL_DISPATCH__
}
@main struct Checks {
 @MainActor static func main() async throws {
  var count=0
  func check(_ ok:Bool,_ label:String){precondition(ok,label);count += 1}
  func drain() async {for _ in 0..<100{await Task.yield()}}
  func fields(_ locked:Bool=false,_ label:String="Video 2")->[String:Any] {
   ["name":"A","tracks":[["id":"V1","kind":"video","clips":[]],["id":"V2","kind":"video","name":label,"locked":locked,"clips":[]],["id":"A1","kind":"audio","clips":[]]]]
  }
  let session=EditorSession(),model=NativeEditorModel(session),backend=session.backend!
  func reset(){model.project=NativeProject(fields:fields());model.version=7;model.composition=nil;session.folder=URL(fileURLWithPath:"/project-a");model.status="";backend.version=7}
  func capture()->NativeTrackDeletion {NativeTrackDeletion(track:model.tracks.first{$0.id=="V2"}!,model:model)!}
  reset()
  var large=fields()
  large["assets"]=["media/large.mov":["metadata":String(repeating:"media",count:20_000)]]
  var largeTracks=large["tracks"] as! [[String:Any]]
  largeTracks[1]["clips"]=(0..<500).map{["id":"C\($0)","src":"media/large.mov","start":$0,"dur":1] as [String:Any]}
  large["tracks"]=largeTracks;model.project=NativeProject(fields:large)
  for _ in 0..<120 {_ = capture()}
  check(NativeTrackDeletion.encodingCalls==0,"Repeated closed-menu captures must never serialize a large project or track")
  reset()
  let valid=capture()
  check(valid.delete(model:model),"Current unlocked target must dispatch")
  check(NativeTrackDeletion.encodingCalls==5,"Canonical captured/live project and exact target checks must run only at delete dispatch")
  await drain()
  check(backend.writes==1 && backend.requests.count==1,"Current deletion must use real editBatch/call path exactly once")
  let request=backend.requests[0],op=(request["ops"] as! [[String:Any]])[0]
  check(request["expectedVersion"] as? Int==7 && op["id"] as? String=="V2" && op["op"] as? String=="delete_track" && op["comp"] is NSNull,"Atomic request must carry captured revision and exact main-timeline target")
  let writes=backend.writes,requests=backend.requests.count

  reset();let staleProjection=model.tracks.first{$0.id=="V2"}!
  model.project=NativeProject(fields:fields(false,"Reused before capture"))
  let preCaptureReplacement=NativeTrackDeletion(track:staleProjection,model:model)!
  check(!preCaptureReplacement.delete(model:model),"A stale projected track at capture must fail exact current-field comparison at dispatch")
  reset();let invalidProject=capture();var invalid=fields();invalid["invalid"]=Double.nan;model.project=NativeProject(fields:invalid)
  check(!invalidProject.delete(model:model),"Invalid live project JSON must not pass canonical comparison")
  let invalidCapture=capture()
  check(!invalidCapture.delete(model:model),"Invalid captured JSON must fail closed even when live fields are identical")
  reset();let copiedSnapshot=capture();var edited=model.project!.fields
  var editedTracks=edited["tracks"] as! [[String:Any]];editedTracks[1]["name"]="Changed through value copy";edited["tracks"]=editedTracks
  model.project=NativeProject(fields:edited)
  check(!copiedSnapshot.delete(model:model),"A nested value edit must not mutate the retained capture into matching replacement state")
  reset();let newlyLocked=capture();model.project=NativeProject(fields:fields(true))
  check(!newlyLocked.delete(model:model),"A newly locked target with an unchanged version must be rejected from live state")
  check(NativeTrackDeletion(track:model.tracks.first{$0.id=="V2"}!,model:model)==nil,"A fresh locked menu must not offer deletion")
  reset();let replaced=capture();model.project=NativeProject(fields:fields(false,"Replacement with reused ID"))
  check(!replaced.delete(model:model),"A reused target ID with changed exact fields must not inherit deletion")
  reset();let unrelated=capture();var changed=fields();changed["name"]="Replaced project";model.project=NativeProject(fields:changed)
  check(!unrelated.delete(model:model),"Same track ID/version in a different project snapshot must be rejected")
  reset();let reopened=capture();model.generation=UUID()
  check(!reopened.delete(model:model),"Reopening the same folder/version must invalidate the old context")
  reset();let moved=capture();session.folder=URL(fileURLWithPath:"/project-b")
  check(!moved.delete(model:model),"Another project folder must not receive old menu deletion")
  reset();let revision=capture();model.version=8
  check(!revision.delete(model:model),"Menu must reject a newer local version")
  reset();let comp=capture();model.composition="nested"
  check(!comp.delete(model:model),"Composition switch must invalidate the old target scope")
  reset();let removed=capture();var sole=fields();sole["tracks"]=[["id":"V1","kind":"video","clips":[]]];model.project=NativeProject(fields:sole)
  check(!removed.delete(model:model),"Removed track must reject an old menu")
  check(NativeTrackDeletion(track:model.tracks[0],model:model)==nil,"Last track of a kind must not be deletable")
  reset();let last=capture();var lastFields=fields();lastFields["tracks"]=[["id":"V2","kind":"video","name":"Video 2","locked":false,"clips":[]]];model.project=NativeProject(fields:lastFields)
  check(!last.delete(model:model),"Live kind-count reduction must reject capture even when target fields match")
  model.project=nil
  check(!last.delete(model:model),"Closing a project must reject deletion")
  await drain()
  check(backend.writes==writes && backend.requests.count==requests,"All stale menu paths must stop before a backend request")

  reset();let queuedRevision=capture();check(queuedRevision.delete(model:model),"Valid capture may queue")
  model.version=8
  await drain()
  check(backend.requests.count==requests && session.error != nil,"Real queued edit must reject a version change before request execution")
  reset();let queuedProject=capture();check(queuedProject.delete(model:model),"Valid capture may queue before reset")
  model.generation=UUID()
  await drain()
  check(backend.requests.count==requests,"Real generation guard must stop queued old-project edits")
  reset();let queuedScope=capture();check(queuedScope.delete(model:model),"Valid capture may queue before composition change")
  model.composition="nested"
  await drain()
  check(backend.requests.count==requests,"Real queued edit must stop before a changed composition request")

  reset();backend.shouldWait=true;let serverRace=capture()
  check(serverRace.delete(model:model),"Current menu may reach revision-guarded backend")
  while backend.wait==nil{await Task.yield()}
  backend.version=8
  backend.wait!.resume();backend.shouldWait=false
  await drain()
  check(backend.writes==writes && backend.requests.count==requests+1,"Extracted production backend revision guard must reject a late server change before applying deletion")

  reset();var nested=fields();nested["comps"]=["nested":fields()];model.project=NativeProject(fields:nested);model.composition="nested"
  check(capture().delete(model:model),"Current nested composition must support deletion")
  await drain()
  let nestedOp=(backend.requests.last!["ops"] as! [[String:Any]])[0]
  check(nestedOp["comp"] as? String=="nested" && backend.requests.last!["expectedVersion"] as? Int==7,"Real dispatch must preserve captured nested scope and revision")
  print("PASS: \(count) candidate track deletion/controller/dispatch revision assertions (native undo UI untested)")
 }
}
'''
source=source.replace('__REAL_MODEL_DISPATCH__',call+edits).replace('__VERSION_GUARD__',version_guard)
with tempfile.TemporaryDirectory(prefix='arya-track-delete-') as temp:
 d=Path(temp);swift=d/'Checks.swift';binary=d/'checks';swift.write_text(source)
 subprocess.run(['swiftc','-j1','-parse-as-library','-module-cache-path',str(d/'cache'),str(repo/'native/ReelKit/Sources/ReelKit/JSON.swift'),str(swift),'-o',str(binary)],check=True)
 subprocess.run([str(binary)],check=True)
