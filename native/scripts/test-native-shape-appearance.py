#!/usr/bin/env python3
"""Prepare or run actual shape appearance planning/controller checks.

Source lanes use --prepare-only. The integration owner may compile and execute.
These checks stub the backend boundary and do not certify SwiftUI interaction.
"""
from pathlib import Path
import argparse
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--repo-root', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--source-root', type=Path)
parser.add_argument('--receipt', type=Path, required=True)
parser.add_argument('--prepare-only', type=Path)
args = parser.parse_args()
repo = args.repo_root.resolve()
source = (args.source_root or repo).resolve()
inspector = (source / 'native/App/Shared/NativeEditor/NativeInspector.swift').read_text()
project = (repo / 'native/App/Shared/NativeEditor/NativeProject.swift').read_text()
model = (source / 'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()
readonly = '    var projectReadOnlyReason: String? { session?.projectReadOnlyReason }'
assert readonly in model
assert 'private weak var session:' in model or 'private var session:' in model

def block(name):
    begin = '// BEGIN SHAPE APPEARANCE ' + name + '\n'
    end = '// END SHAPE APPEARANCE ' + name
    assert begin in inspector and end in inspector
    return inspector.split(begin, 1)[1].split(end, 1)[0]

assert 'NativeShapeAppearanceControls(model: model, clip: clip)' in inspector
assert '.disabled(capture == nil).id(capture?.data)' in inspector
assert 'NativeTextRow("Fill"' in inspector and 'NativeTextRow("Stroke"' in inspector
assert 'Toggle("Fill enabled"' in inspector and 'Toggle("Stroke enabled"' in inspector
projections = project[project.index('struct NativeProject {'):project.index('enum NativeProcessingRequests {')]
helpers = project[project.index('extension Dictionary where Key == String, Value == Any {'):project.index('// Foundation-only receipt helpers')]
program = 'import Foundation\nimport CoreFoundation\n' + projections + helpers + block('PLANNING')
program += r'''
@MainActor final class Backend {}
@MainActor final class Session {
 var backend:Backend?=Backend(),projectReadOnlyReason:String?
}
@MainActor final class NativeEditorModel {
 private let session:Session?=Session()
 var folder:URL?=URL(fileURLWithPath:"/owned/shape"),project:NativeProject?,version=7,composition:String?
 var selectedIDs:Set<String>=[],selectedID:String?,busy=false,status=""
 var processingContextID=UUID(),audioProjectRevision=UUID()
 var renderPreviewBackendID:ObjectIdentifier? {session?.backend.map {ObjectIdentifier($0)}}
 var actions:[@MainActor ()async throws->Void]=[],requests:[[[String:Any]]]=[],versions:[Int?]=[]
 READONLY_QUERY
 func testBackend(){session!.backend=Backend()}
 func testReadOnly(){session!.projectReadOnlyReason="Read only"}
 func perform(_ action:@escaping @MainActor ()async throws->Void){actions.append(action)}
 func drain()async {while !actions.isEmpty{let action=actions.removeFirst();do{try await action()}catch{status=error.localizedDescription}}}
 func ops(_ operations:[[String:Any]],summary:String?=nil,expectedVersion:Int?=nil)async throws {
  guard expectedVersion==version else{throw NativeShapeAppearance.Failure("CAS conflict")}
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
   m.selectedIDs=Set(record["selection"] as? [String] ?? []);m.selectedID=record.string("primary");return m
  }
  for record in cases {
   let m=model(record),before=m.project!.text,capture=try NativeShapeAppearanceController.capture(m,primary:m.selectedID)
   let action=NativeShapeAppearance.Action(rawValue:record.string("action"))!,value=record["value"]!
   let operations=try capture.operations(action,value:value)
   check(try canonical(operations)==canonical(record.objects("ops")),"Native operation must equal actual browser planner oracle")
   NativeShapeAppearanceController.commit(m,capture:capture,action:action,value:value);await m.drain()
   check(m.requests.count==1 && m.versions[0]==7 && m.version==8,"One gesture must submit one expected-version request")
   check(try canonical(m.requests[0])==canonical(operations),"Controller must send the captured scoped operation exactly")
   check(m.project!.text==before,"Controller must let the backend own project changes")
  }
  let base=cases[0]
  for axis in ["backend","folder","version","context","revision","composition","selection","primary","clip","track","busy","readOnly"] {
   let m=model(base),capture=try NativeShapeAppearanceController.capture(m,primary:m.selectedID)
   NativeShapeAppearanceController.commit(m,capture:capture,action:.fillColor,value:"#d95d18")
   switch axis {
   case "backend":m.testBackend()
   case "folder":m.folder=URL(fileURLWithPath:"/owned/other")
   case "version":m.version += 1
   case "context":m.processingContextID=UUID()
   case "revision":m.audioProjectRevision=UUID()
   case "composition":m.composition=nil
   case "selection":m.selectedIDs=[]
   case "primary":m.selectedID="other"
   case "busy":m.busy=true
   case "readOnly":m.testReadOnly()
   default:
    var p=m.project!.fields,comps=p.dictionary("comps"),scope=comps.dictionary(m.composition!),tracks=scope.objects("tracks")
    let ti=tracks.firstIndex(where:{$0.objects("clips").contains(where:{$0.string("id")==m.selectedID})})!
    if axis=="track" {tracks[ti]["locked"]=true}
    else {var clips=tracks[ti].objects("clips");let ci=clips.firstIndex(where:{$0.string("id")==m.selectedID})!;clips[ci]["note"]="changed";tracks[ti]["clips"]=clips}
    scope["tracks"]=tracks;comps[m.composition!]=scope;p["comps"]=comps;m.project=NativeProject(fields:p)
   }
   await m.drain();check(m.requests.isEmpty && !m.status.isEmpty,"Stale queued edit must refuse before request: \(axis)")
  }
  for (action,value) in [(NativeShapeAppearance.Action.fillColor,"url(bad)" as Any),(.fillColor,"#d95d18\n" as Any),(.strokeWidth,Double.nan as Any),(.strokeWidth,-1 as Any),(.strokeWidth,101 as Any),(.strokeWidth,true as Any),(.fillEnabled,1 as Any)] {
   let m=model(base),capture=try NativeShapeAppearanceController.capture(m,primary:m.selectedID)
   NativeShapeAppearanceController.commit(m,capture:capture,action:action,value:value);await m.drain()
   check(m.requests.isEmpty && !m.status.isEmpty,"Malformed paint value must not send an edit")
  }
  let duplicate=model(base),capture=try NativeShapeAppearanceController.capture(duplicate,primary:duplicate.selectedID)
  NativeShapeAppearanceController.commit(duplicate,capture:capture,action:.fillColor,value:"#d95d18")
  NativeShapeAppearanceController.commit(duplicate,capture:capture,action:.fillColor,value:"#d95d18");await duplicate.drain()
  check(duplicate.requests.count==1,"Repeated submit/blur callback must keep one backend edit")
  let mixed=model(base);mixed.selectedIDs.insert("missing")
  rejects("Mixed selection must disable appearance"){_ = try NativeShapeAppearanceController.capture(mixed,primary:mixed.selectedID)}
  let absent=model(base);absent.composition="deleted"
  rejects("Missing composition must refuse"){_ = try NativeShapeAppearanceController.capture(absent,primary:absent.selectedID)}
  print("Actual extracted shape planning/controller checks passed when compiled: \(count). Backend and UI boundaries are stubbed.")
 }
}
'''
if args.prepare_only:
    args.prepare_only.parent.mkdir(parents=True, exist_ok=True)
    args.prepare_only.write_text(program)
    print('Prepared actual native shape appearance planning/controller fixture. No compiler or native execution ran.')
else:
    with tempfile.TemporaryDirectory(prefix='arya-shape-controller-') as temporary:
        work=Path(temporary); file=work/'Checks.swift'; file.write_text(program); binary=work/'checks'
        subprocess.run(['swiftc','-parse-as-library','-module-cache-path',str(work/'cache'),str(file),str(repo/'native/ReelKit/Sources/ReelKit/JSON.swift'),'-o',str(binary)],check=True)
        subprocess.run([str(binary),str(args.receipt.resolve())],check=True)
