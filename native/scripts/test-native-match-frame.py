#!/usr/bin/env python3
"""Prepare or execute actual Match Frame planning/controller extraction.

Source lanes must use --prepare-only. The integration owner alone may compile/run.
The source-player boundary is stubbed; this does not certify AVPlayer/UI playback.
"""
from pathlib import Path
import argparse
import subprocess
import tempfile

parser=argparse.ArgumentParser()
parser.add_argument('--repo-root',type=Path,default=Path(__file__).resolve().parents[2])
parser.add_argument('--source-root',type=Path)
parser.add_argument('--receipt',type=Path,required=True)
parser.add_argument('--prepare-only',type=Path)
args=parser.parse_args()
repo=args.repo_root.resolve(); source=(args.source_root or repo).resolve()
model=(source/'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()
project=(repo/'native/App/Shared/NativeEditor/NativeProject.swift').read_text()
timeline=(source/'native/App/Shared/NativeEditor/NativeTimeline.swift').read_text()
def block(begin,end):
    if begin not in model: raise SystemExit('Missing actual Match Frame source: '+begin)
    return model.split(begin,1)[1].split(end,1)[0]
def declaration(marker):
    start=model.index(marker);begin=model.index('{',start);end=begin+1;depth=1
    while depth:
        depth+=(model[end]=='{')-(model[end]=='}');end+=1
    return model[start:end]
planning=block('// BEGIN MATCH FRAME PLANNING\n','// END MATCH FRAME PLANNING')
controller=block('    // BEGIN MATCH FRAME CONTROLLER\n','    // END MATCH FRAME CONTROLLER')
# These are source availability gates only; prepared controller assertions below own behavior.
for name in ['editor.matchFrame.toolbar','editor.matchFrame.precision','editor.matchFrame.context']:
    assert name in timeline,name
assert 'model.matchFrame(try matchFrame.get())' in timeline
assert '.disabled(!model.canRequestMatchFrame)' in timeline
projections=project[project.index('struct NativeProject {'):project.index('enum NativeProcessingRequests {')]
helpers=project[project.index('extension Dictionary where Key == String, Value == Any {'):project.index('// Foundation-only receipt helpers')]
program='import Foundation\nimport CoreFoundation\nimport Darwin\n'+projections+helpers+declaration('struct NativeSourceRange:')+'\n'+declaration('struct NativeSourceFileIdentity:')+'\n'+planning
program+=r'''
@MainActor final class ReelBackend {}
@MainActor final class Session { var backend:ReelBackend?=ReelBackend() }
@MainActor final class NativeEditorModel {
 let session:Session?=Session()
 var folder:URL?, project:NativeProject?, version=7, composition:String?="k1"
 var generation=UUID(),projectRevision=UUID(),selectedIDs:Set<String>=["v","a"],selectedID:String?="v",time:Double=5
 var busy=false,showingSource=false,previewing=false,scrubbing=false,playing=false
 var sourceError:String?,sourceAssetID:String?,sourceRange:NativeSourceRange?,sourceFileIdentity:NativeSourceFileIdentity?,status=""
 var opened:[String]=[],seeks:[Double]=[],clears=0,editCount=0,failOpen=false,replaceWhileOpening=false
 var fps:Double {30}
 func mediaURL(_ source:String) throws -> URL {guard let folder else{throw NativeMatchFrame.Failure("Closed")};return folder.appendingPathComponent(source)}
 func openSource(_ asset:NativeAsset) {
   opened.append(asset.id);showingSource=true
   if failOpen {sourceError="Player refused source";return}
   if replaceWhileOpening {try! Data("changed while opening".utf8).write(to:mediaURL(asset.id))}
   sourceAssetID=asset.id;sourceRange=NativeSourceRange(duration:asset.kind=="image" ? 5:asset.duration,fps:asset.fields.number("fps",fps))
   sourceFileIdentity=try? NativeSourceFileIdentity(file:mediaURL(asset.id))
 }
 func clearSource(){clears += 1;sourceAssetID=nil;sourceRange=nil;sourceFileIdentity=nil;showingSource=false}
 func seekSource(_ at:Double){sourceRange?.seek(at);seeks.append(at)}
 func editBatch(_ operations:[[String:Any]]){editCount += 1;preconditionFailure("Match Frame must not submit an edit")}
'''+controller+r'''
}
@main struct Checks {
 @MainActor static func main() throws {
  var count=0
  func check(_ ok:Bool,_ message:String){precondition(ok,message);count += 1}
  func rejects(_ message:String,_ action:()throws->Void){do{try action();preconditionFailure(message)}catch{count += 1}}
  let receipt=try JSON.parse(String(contentsOfFile:CommandLine.arguments[1],encoding:.utf8)) as! [String:Any]
  let cases=receipt.objects("cases"),root=FileManager.default.temporaryDirectory.appendingPathComponent("arya-native-match-frame-\(UUID())")
  try FileManager.default.createDirectory(at:root.appendingPathComponent("media"),withIntermediateDirectories:true)
  defer{try? FileManager.default.removeItem(at:root)}
  let file=root.appendingPathComponent("media/source.mov")
  func model(_ record:[String:Any])throws->NativeEditorModel {
   try Data("owned source identity fixture; no encoded media".utf8).write(to:file)
   let m=NativeEditorModel();m.folder=root;m.project=NativeProject(fields:record.dictionary("project"));m.composition=record["composition"] as? String
   m.selectedIDs=Set(record["selection"] as? [String] ?? []);m.selectedID=record.string("primary");m.time=record.number("time");return m
  }
  for record in cases {
   let m=try model(record),before=m.project!.text,selection=m.selectedIDs,primary=m.selectedID,time=m.time,composition=m.composition
   let capture=try m.captureMatchFrame()
   check(abs(capture.target.seconds-record.number("seconds"))<1e-9,"Native source mapping must equal actual shared-core oracle")
   check(abs(capture.target.viewerSeconds-record.number("viewerSeconds"))<1e-9,"Viewer mapping must stay on the final readable source frame")
   m.matchFrame(capture)
   check(m.showingSource && m.opened==[record.string("source")] && m.seeks.count==1,"Match must open actual source viewer exactly once")
   check(abs(m.seeks[0]-record.number("viewerSeconds"))<1e-9,"Match must seek exact mapped source frame")
   check(m.project!.text==before && m.selectedIDs==selection && m.selectedID==primary && m.time==time && m.composition==composition && m.version==7 && m.editCount==0,"Navigation must retain timeline/comp/selection/version and make no undo edit")
  }
  let base=cases[2]
  for axis in ["backend","folder","version","context","revision","composition","selection","primary","time","project","asset","busy","sourceMode","preview","scrub","playback","sourceBytes","sourceInode"] {
   let m=try model(base),capture=try m.captureMatchFrame()
   switch axis {
   case "backend":m.session!.backend=ReelBackend()
   case "folder":m.folder=root.appendingPathComponent("other")
   case "version":m.version += 1
   case "context":m.generation=UUID()
   case "revision":m.projectRevision=UUID()
   case "composition":m.composition=nil
   case "selection":m.selectedIDs.remove("a")
   case "primary":m.selectedID="a"
   case "time":m.time += 1/30
   case "project":var p=m.project!.fields;p["name"]="replacement";m.project=NativeProject(fields:p)
   case "asset":var p=m.project!.fields;var assets=p.dictionary("assets");var a=assets.dictionary("media/source.mov");a["duration"]=59;assets["media/source.mov"]=a;p["assets"]=assets;m.project=NativeProject(fields:p)
   case "busy":m.busy=true
   case "sourceMode":m.showingSource=true
   case "preview":m.previewing=true
   case "scrub":m.scrubbing=true
   case "playback":m.playing=true
   case "sourceBytes":try Data("replacement bytes".utf8).write(to:file)
   case "sourceInode":let copy=root.appendingPathComponent("copy");try FileManager.default.copyItem(at:file,to:copy);try FileManager.default.removeItem(at:file);try FileManager.default.moveItem(at:copy,to:file)
   default:preconditionFailure("Unknown axis")
   }
   m.matchFrame(capture);check(m.opened.isEmpty && m.seeks.isEmpty && m.editCount==0,"Stale captured callback must not open, seek or edit: \(axis)")
  }
  for mode in ["missingPrimary","unselectedPrimary","missingComposition","duplicateClip","outsideBefore","outsideAfter","nonlinear","zeroSpeed","boolSpeed","nanInput","missingAsset","missingSource"] {
   let m=try model(base);var p=m.project!.fields;var comps=p.dictionary("comps"),scope=comps.dictionary("k1"),tracks=scope.objects("tracks"),clips=tracks[0].objects("clips"),clip=clips[0]
   switch mode {
   case "missingPrimary":m.selectedID=nil
   case "unselectedPrimary":m.selectedIDs=["a"]
   case "missingComposition":m.composition="deleted"
   case "duplicateClip":clips.append(clip)
   case "outsideBefore":m.time=2
   case "outsideAfter":m.time=11
   case "nonlinear":clip["timeMap"]=["points":[]]
   case "zeroSpeed":clip["speed"]=0
   case "boolSpeed":clip["speed"]=true
   case "nanInput":clip["in"]=Double.nan
   case "missingAsset":p["assets"]=[String:Any]()
   case "missingSource":try FileManager.default.removeItem(at:file)
   default:break
   }
   clips[0]=clip;tracks[0]["clips"]=clips;scope["tracks"]=tracks;comps["k1"]=scope;p["comps"]=comps;m.project=NativeProject(fields:p)
   rejects("Invalid source context must refuse before opening: \(mode)"){_ = try m.captureMatchFrame()}
   check(m.opened.isEmpty && m.seeks.isEmpty && m.editCount==0,"Invalid capture must preserve timeline")
  }
  let image=try model(base);var imageProject=image.project!.fields;var imageAssets=imageProject.dictionary("assets"),imageAsset=imageAssets.dictionary("media/source.mov");imageAsset["still"]=true;imageAsset["duration"]=0;imageAssets["media/source.mov"]=imageAsset;imageProject["assets"]=imageAssets
  var imageComps=imageProject.dictionary("comps"),imageScope=imageComps.dictionary("k1"),imageTracks=imageScope.objects("tracks"),imageClips=imageTracks[0].objects("clips");imageClips[0]["kind"]="image";imageTracks[0]["clips"]=imageClips;imageScope["tracks"]=imageTracks;imageComps["k1"]=imageScope;imageProject["comps"]=imageComps;image.project=NativeProject(fields:imageProject)
  let imageCapture=try image.captureMatchFrame();image.matchFrame(imageCapture);check(image.showingSource && image.seeks==[0] && image.editCount==0,"Still sources must open at source zero")
  imageClips[0]["kind"]="comp";imageClips[0]["comp"]="child";imageClips[0].removeValue(forKey:"src");imageTracks[0]["clips"]=imageClips;imageScope["tracks"]=imageTracks;imageComps["k1"]=imageScope;imageProject["comps"]=imageComps;image.project=NativeProject(fields:imageProject);image.showingSource=false
  rejects("Container must explain opening the composition rather than guess a layer"){_ = try image.captureMatchFrame()}
  let changed=try model(base),changeCapture=try changed.captureMatchFrame();changed.replaceWhileOpening=true;changed.matchFrame(changeCapture)
  check(changed.opened.count==1 && changed.clears==1 && changed.seeks.isEmpty && !changed.showingSource,"File identity drift during open must clear source before seeking")
  let failed=try model(base),failedCapture=try failed.captureMatchFrame();failed.failOpen=true;failed.matchFrame(failedCapture)
  check(failed.seeks.isEmpty && failed.status=="Player refused source" && failed.editCount==0,"Source-player failure must remain visible and cannot seek or edit")
  print("Prepared actual-controller checks passed when compiled: \(count). AVPlayer/UI boundary is stubbed.")
 }
}
'''
if args.prepare_only:
    args.prepare_only.parent.mkdir(parents=True,exist_ok=True)
    args.prepare_only.write_text(program)
    print('Prepared actual native Match Frame planning/controller fixture; no Swift/compiler/runtime invocation.')
else:
    with tempfile.TemporaryDirectory(prefix='arya-match-frame-controller-') as temporary:
        work=Path(temporary);file=work/'Checks.swift';file.write_text(program);binary=work/'checks'
        subprocess.run(['swiftc','-parse-as-library','-module-cache-path',str(work/'cache'),str(file),str(repo/'native/ReelKit/Sources/ReelKit/JSON.swift'),'-o',str(binary)],check=True)
        subprocess.run([str(binary),str(args.receipt.resolve())],check=True)
