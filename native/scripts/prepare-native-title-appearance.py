#!/usr/bin/env python3
"""Extract actual title appearance planning/controller checks without compilation."""
from pathlib import Path
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
source = args.source_root.resolve()
inspector = (source / 'native/App/Shared/NativeEditor/NativeInspector.swift').read_text()
project = (source / 'native/App/Shared/NativeEditor/NativeProject.swift').read_text()
model = (source / 'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()
readonly = '    var projectReadOnlyReason: String? { session?.projectReadOnlyReason }'
assert readonly in model and 'private weak var session:' in model
assert 'func ops(_ operations: [[String: Any]], summary: String? = nil, expectedVersion: Int? = nil)' in model
assert 'body["expectedVersion"] = expectedVersion' in model
assert 'NativeTitleAppearanceControls(model: model, clip: clip)' in inspector
for binding in ['let rounded = (local * 10_000).rounded(.toNearestOrAwayFromZero) / 10_000', 'abs(at.doubleValue - rounded) <= 1e-3', 'guard replaced.count <= 1', 'operation["ease"] = key[2]']:
    assert binding in inspector, binding
assert '.disabled(capture == nil).id(capture?.formIdentity(transportActive: model.playing || model.scrubbing))' in inspector
for label in ['Gradient', 'Outline', 'Shadow', 'Plate', 'Italic']:
    assert f'Toggle("{label}"' in inspector
for label in ['Line height', 'Outline width', 'Shadow blur', 'Shadow X', 'Shadow Y', 'Padding', 'Corner radius']:
    assert f'numeric("{label}"' in inspector

def block(name):
    begin, end = '// BEGIN TITLE APPEARANCE ' + name + '\n', '// END TITLE APPEARANCE ' + name
    assert inspector.count(begin) == 1 and inspector.count(end) == 1
    return inspector.split(begin, 1)[1].split(end, 1)[0]

projections = project[project.index('struct NativeProject {'):project.index('enum NativeProcessingRequests {')]
helpers = project[project.index('extension Dictionary where Key == String, Value == Any {'):project.index('// Foundation-only receipt helpers')]
program = 'import Foundation\nimport CoreFoundation\n' + projections + helpers + block('PLANNING')
program += r'''
@MainActor final class Backend {}
@MainActor final class Session { var backend:Backend?=Backend(),projectReadOnlyReason:String? }
@MainActor final class NativeEditorModel {
 private weak var session:Session?
 private let ownedSession=Session()
 init(){session=ownedSession}
 var folder:URL?=URL(fileURLWithPath:"/owned/title"),project:NativeProject?,version=7,composition:String?
 var selectedIDs:Set<String>=[],selectedID:String?,busy=false,showingSource=false,status="",time=0.0
 var processingContextID=UUID(),audioProjectRevision=UUID()
 var renderPreviewBackendID:ObjectIdentifier? {session?.backend.map {ObjectIdentifier($0)}}
 var actions:[@MainActor ()async throws->Void]=[],requests:[[[String:Any]]]=[],versions:[Int?]=[]
 READONLY_QUERY
 func testBackend(){session!.backend=Backend()}
 func testReadOnly(){session!.projectReadOnlyReason="Read only"}
 func perform(_ action:@escaping @MainActor ()async throws->Void){actions.append(action)}
 func drain()async {while !actions.isEmpty{let action=actions.removeFirst();do{try await action()}catch{status=error.localizedDescription}}}
 func ops(_ operations:[[String:Any]],summary:String?=nil,expectedVersion:Int?=nil)async throws {
  guard expectedVersion==version else{throw NativeTitleAppearance.Failure("CAS conflict")}
  requests.append(operations);versions.append(expectedVersion);version += 1;audioProjectRevision=UUID()
 }
}
'''.replace(' READONLY_QUERY', readonly) + block('CONTROLLER') + r'''
@main struct Checks {
 @MainActor static func main()async throws {
  var count=0
  func check(_ condition:Bool,_ text:String){precondition(condition,text);count += 1}
  func rejects(_ text:String,_ action:()throws->Void){do{try action();preconditionFailure(text)}catch{count += 1}}
  func canonical(_ object:Any)throws->Data {try JSONSerialization.data(withJSONObject:object,options:[.sortedKeys])}
  let receipt=try JSON.parse(String(contentsOfFile:CommandLine.arguments[1],encoding:.utf8)) as! [String:Any]
  let cases=receipt.objects("cases")
  func model(_ record:[String:Any])->NativeEditorModel {
   let m=NativeEditorModel();m.project=NativeProject(fields:record.dictionary("project"));m.composition=record["composition"] as? String
   m.selectedIDs=Set(record["selection"] as? [String] ?? []);m.selectedID=record.string("primary");m.time=record.number("time");return m
  }
  func mutate(_ m:NativeEditorModel,_ action:(inout [String:Any],inout [String:Any])->Void) {
   var p=m.project!.fields,comps=p.dictionary("comps"),scope=m.composition.map{comps.dictionary($0)} ?? p,tracks=scope.objects("tracks")
   let ti=tracks.firstIndex(where:{$0.objects("clips").contains(where:{$0.string("id")==m.selectedID})})!
   var track=tracks[ti],clips=track.objects("clips");let ci=clips.firstIndex(where:{$0.string("id")==m.selectedID})!;var clip=clips[ci]
   action(&clip,&track);clips[ci]=clip;track["clips"]=clips;tracks[ti]=track;scope["tracks"]=tracks
   if let comp=m.composition {comps[comp]=scope;p["comps"]=comps}else{p=scope};m.project=NativeProject(fields:p)
  }
  for record in cases {
   let m=model(record),before=m.project!.text,capture=try NativeTitleAppearanceController.capture(m,primary:m.selectedID)
   let action=NativeTitleAppearance.Action(rawValue:record.string("action"))!,value=record["value"]!
   let operations=try capture.operations(action,value:value)
   check(try canonical(operations)==canonical(record.objects("ops")),"Native operation must equal the actual core receipt")
   NativeTitleAppearanceController.commit(m,capture:capture,action:action,value:value);await m.drain()
   check(m.requests.count==1 && m.versions[0]==7 && m.version==8,"One control commit must submit one versioned batch")
   check(try canonical(m.requests[0])==canonical(operations),"Controller must send the exact captured scoped operations")
   check(m.project!.text==before,"Backend owns project changes")
  }
  let base=cases.first(where:{$0["composition"] as? String != nil})!
  let playbackModel=model(base),first=try NativeTitleAppearanceController.capture(playbackModel,primary:playbackModel.selectedID)
  playbackModel.time += 0.5
  let advanced=try NativeTitleAppearanceController.capture(playbackModel,primary:playbackModel.selectedID)
  check(first.data != advanced.data,"Edit receipts retain the exact playhead despite stable playback UI identity")
  check(first.formIdentity(transportActive:true)==advanced.formIdentity(transportActive:true),"Playback and scrub ticks retain the title form and its focus/drafts")
  check(first.formIdentity(transportActive:false) != advanced.formIdentity(transportActive:false),"A paused seek still resets the title form")
  check(first.formIdentity(transportActive:true) != first.formIdentity(transportActive:false),"Starting or pausing playback still refreshes the form context")
  for axis in ["backend","folder","version","context","revision","composition","selection","primary","time","clip","track","busy","readOnly","source"] {
   let m=model(base),capture=try NativeTitleAppearanceController.capture(m,primary:m.selectedID)
   NativeTitleAppearanceController.commit(m,capture:capture,action:.color,value:"#d95d18")
   switch axis {
   case "backend":m.testBackend()
   case "folder":m.folder=URL(fileURLWithPath:"/owned/other")
   case "version":m.version += 1
   case "context":m.processingContextID=UUID()
   case "revision":m.audioProjectRevision=UUID()
   case "composition":m.composition=nil
   case "selection":m.selectedIDs=[]
   case "primary":m.selectedID="other"
   case "time":m.time += 0.5
   case "busy":m.busy=true
   case "readOnly":m.testReadOnly()
   case "source":m.showingSource=true
   case "track":mutate(m){_,track in track["locked"]=true}
   default:mutate(m){clip,_ in clip["note"]="Changed source metadata"}
   }
   if let changed=try? NativeTitleAppearanceController.capture(m,primary:m.selectedID),axis != "time" {
    check(capture.formIdentity(transportActive:true) != changed.formIdentity(transportActive:true),"Playback form identity still invalidates changed context: \(axis)")
   }
   await m.drain();check(m.requests.isEmpty && !m.status.isEmpty,"Stale queued appearance edit must refuse: \(axis)")
  }
  for (action,value) in [(NativeTitleAppearance.Action.color,"url(bad)" as Any),(.color,"#d95d18\n" as Any),(.lineHeight,Double.nan as Any),(.lineHeight,0 as Any),(.lineHeight,6 as Any),(.strokeWidth,true as Any),(.italic,1 as Any),(.shadowX,-501 as Any),(.shadowY,501 as Any),(.padding,-1 as Any),(.radius,501 as Any)] {
   let m=model(base),capture=try NativeTitleAppearanceController.capture(m,primary:m.selectedID)
   NativeTitleAppearanceController.commit(m,capture:capture,action:action,value:value);await m.drain()
   check(m.requests.isEmpty && !m.status.isEmpty,"Malformed appearance input must not submit")
  }
  for (action,prop,value) in [(NativeTitleAppearance.Action.strokeEnabled,"title.stroke.width",false as Any),(.shadowEnabled,"title.shadow.blur",false as Any),(.gradientEnabled,"title.gradient.0",false as Any),(.italic,"title.italic",false as Any),(.color,"title.color","#d95d18" as Any)] {
   let m=model(base);mutate(m){clip,_ in clip["anim"]=[prop:[[0,3],[1,5]]]}
   let capture=try NativeTitleAppearanceController.capture(m,primary:m.selectedID)
   rejects("Animated appearance toggle must not delete or hide its owner"){_ = try capture.operations(action,value:value)}
  }
  for action in [NativeTitleAppearance.Action.lineHeight,.strokeWidth,.shadowBlur,.shadowX,.shadowY,.padding,.radius] {
   let m=model(base);mutate(m){clip,_ in clip["expr"]=[action.property!:"value * 2"]}
   let capture=try NativeTitleAppearanceController.capture(m,primary:m.selectedID)
   check(capture.expressionOwns(action.property!),"Expression field is disabled")
   rejects("Expression must keep ownership"){_ = try capture.operations(action,value:1)}
  }
  let invalidExistingKeys: [[[Any]]] = [[[2,1,"hold"],[2.0009,2,"inOut"],[5,3]], [[true,1,"hold"]], [[2]]]
  for frames in invalidExistingKeys {
   let m=model(base);mutate(m){clip,_ in clip["anim"]=["title.lineHeight":frames]}
   let capture=try NativeTitleAppearanceController.capture(m,primary:m.selectedID)
   rejects("Ambiguous or malformed existing keys must refuse before any edit"){_ = try capture.operations(.lineHeight,value:2)}
  }
  let duplicate=model(base),capture=try NativeTitleAppearanceController.capture(duplicate,primary:duplicate.selectedID)
  NativeTitleAppearanceController.commit(duplicate,capture:capture,action:.color,value:"#d95d18")
  NativeTitleAppearanceController.commit(duplicate,capture:capture,action:.color,value:"#d95d18");await duplicate.drain()
  check(duplicate.requests.count==1,"Repeated stale callback must keep one batch")
  for fault in ["mixed","locked","kind","missingTitle","timing","missingComp"] {
   let m=model(base)
   switch fault {
   case "mixed":m.selectedIDs.insert("missing")
   case "locked":mutate(m){_,track in track["locked"]=true}
   case "kind":mutate(m){clip,_ in clip["kind"]="shape"}
   case "missingTitle":mutate(m){clip,_ in clip.removeValue(forKey:"title")}
   case "timing":mutate(m){clip,_ in clip["dur"]=0}
   default:m.composition="deleted"
   }
   rejects("Invalid selection must not capture: \(fault)"){_ = try NativeTitleAppearanceController.capture(m,primary:m.selectedID)}
  }
  print("Extracted native title planning/controller checks passed when compiled: \(count). Backend boundaries are stubbed; SwiftUI is not executed.")
 }
}
'''
args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.write_text(program)
print('Prepared actual native title planning/controller fixture. No compiler or native execution ran.')
