#!/usr/bin/env python3
"""Run the production Motion draft controller and numeric lifecycle with the shared core."""
from pathlib import Path
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
editor = repo / 'native/App/Shared/NativeEditor'
motion = (editor / 'NativeMotionPanel.swift').read_text()
model = (editor / 'NativeEditorModel.swift').read_text()
project = (editor / 'NativeProject.swift').read_text()

def block(text, marker):
    start = text.index(marker); end = text.index('{', start) + 1; depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}'); end += 1
    return text[start:end].replace('private func ', 'func ')

source = 'import Foundation\nimport CoreGraphics\n'
source += project[project.index('struct NativeProject {'):project.index('enum NativeProcessingRequests {')]
source += '\n' + block(project, 'extension Dictionary where Key == String, Value == Any {')
source += '\n' + block(model, 'struct NativeRenderPreviewCapture {')
source += '\n' + motion[motion.index('private struct NativeMotionKeyRef:'):motion.index('// End production motion helpers.')].replace('private struct ', 'struct ').replace('private enum ', 'enum ')
source += '\n' + block(motion, 'private struct NativeMotionDraft {').replace('private struct ', 'struct ')
source += r'''
enum ReelBackend { struct APIError: LocalizedError { let message:String;init(_ message:String){self.message=message};var errorDescription:String?{message} } }
@MainActor final class Session { var error:String? }
@MainActor final class NativeEditorModel {
    var project:NativeProject?,folder:URL?,composition:String?,version=7,selectedID:String?="c1",selectedIDs:Set<String>=["c1"]
    var generation=UUID(),projectRevision=UUID()
    var processingContextID:UUID {generation}
    var playing=false,scrubbing=false,busy=false,showingSource=false,previewing=false
    var renderer:Int?=1,metalFrame:Int?=1,time=1.0,status="",renderError:String?,session:Session?=Session()
    var displayedTime:Double?=1,displayedVersion:Int?=7,displayedRevision:UUID?,displayedComposition:String?,displayedPreviewID:UUID?
    var displayedFolder:URL?,displayedGeneration:UUID?
    var previewOwnershipID:UUID?
    var previewCapture:NativeRenderPreviewCapture?,previewOperations:String?,requests=0,calls:[[String:Any]]=[],callError:Error?,viewerColorPicker:Int?
    var onCall:(()->Void)?,suspendCall=false,suspendedCall:CheckedContinuation<Void,Never>?
    let core:ReelCore
    init(_ fields:[String:Any],folder:URL,comp:String?,core:ReelCore) {
        project=NativeProject(fields:fields);self.folder=folder;composition=comp;self.core=core
        displayedRevision=projectRevision;displayedComposition=comp;displayedFolder=folder;displayedGeneration=generation
    }
    var tracks:[NativeTrack] {project?.tracks(in:composition) ?? []}
    var selected:NativeClip? {tracks.flatMap(\.clips).first {$0.id==selectedID}}
    var fps:Double {composition.flatMap {project?.fields.dictionary("comps")[$0] as? [String:Any]}?.number("fps",30) ?? project?.fps ?? 30}
    func requestFrame() {requests += 1}
    func call(_ path:String,_ body:[String:Any]) async throws -> [String:Any] {
        precondition(path=="/api/ops" && body["expectedVersion"] as? Int==version)
        calls.append(body);onCall?();if let callError {throw callError}
        if suspendCall {await withCheckedContinuation {suspendedCall=$0}}
        let applied=try core.applyOps(project:project!.text,ops:JSON(any:body["ops"]!).text)
        project=NativeProject(fields:try JSON.parse(applied.project) as! [String:Any]);version += 1;projectRevision=UUID()
        return [:]
    }
'''
for marker in ['    func perform(', '    func beginRenderPreview(', '    func renderPreviewMatches(', '    func renderPreviewCommitMatches(', '    func preview(', '    func discardRenderPreview(']:
    source += '\n' + block(model, marker)
source += r'''
}
@MainActor func nativeGestureRetry(_ model:NativeEditorModel) {model.status="Retry"}
@MainActor final class Panel {
    let model:NativeEditorModel
    var property="x",keySelection=Set<NativeMotionKeyRef>(),selectedKeyTime:Double?
    var motionDraft:NativeMotionDraft?,motionCommit:NativeMotionDraft?,motionApplying:NativeMotionDraft?,motionControlID=UUID()
    init(_ model:NativeEditorModel){self.model=model}
'''
for marker in ['private func keys(', 'private func allKeys(', 'private func isLocked(', 'private func captureMotion(', 'private func matchesMotion(', 'private func beginMotionDraft(', 'private func previewMotionMove(', 'private func previewMotionEase(', 'private func previewMotionOperations(', 'private func finishMotionMove(', 'private func finishMotionEase(', 'private func finishMotionDraft(', 'private func discardMotionDraft(', 'private func invalidateMotionDraft()', 'private func invalidateMotionDraftIfStale()']:
    source += '\n' + block(motion, marker)
source += r'''
}
@MainActor final class Number {
    var context:NativeMotionEditCapture?,attempted=false,resetID=UUID()
    var begin:()->NativeMotionEditCapture?={nil},preview:((Double,NativeMotionEditCapture)->Void)?,end:((NativeMotionEditCapture?)->Void)?,commit:(Double,NativeMotionEditCapture)->Void={_,_ in}
'''
for marker in ['private func beginNumberGesture()', 'private func previewNumberGesture(', 'private func endNumberGesture()', 'private func finishNumberGesture(']:
    source += '\n' + block(motion, marker)
source += r'''
}
@main struct Checks {
    @MainActor static func main() async throws {
        var count=0
        func check(_ yes:Bool,_ message:String){precondition(yes,message);count += 1}
        func drain() async {for _ in 0..<50 {await Task.yield()}}
        let folder=URL(fileURLWithPath:CommandLine.arguments[2]),core=try ReelCore(scriptURL:URL(fileURLWithPath:CommandLine.arguments[1]))
        var base=try JSON.parse(core.newProject(name:"Motion",options:#"{"width":160,"height":90,"fps":30}"#)) as! [String:Any]
        let clip:[String:Any]=["id":"c1","kind":"shape","start":0,"dur":4,"in":0,"x":20,"y":45,
            "shape":["type":"rect","width":10,"height":10,"fill":["color":"#ff0000"]],
            "anim":["x":[[0,20,[0.2,0.1,0.8,0.9]],[2,120,"linear"]] as [[Any]],"y":[[0,45,"hold"],[2,60]] as [[Any]]],
            "expr":["x":"value + time"],"masks":[["id":"m1","type":"rect","x":0,"y":0,"w":10,"h":10]]]
        let tracks:[[String:Any]]=[["id":"V1","kind":"video","clips":[clip]]]
        base["tracks"]=tracks;base["comps"]=["nested":["fps":24,"width":160,"height":90,"tracks":tracks]]
        func fresh(_ comp:String?=nil,fields:[String:Any]?=nil)->(NativeEditorModel,Panel) {
            let model=NativeEditorModel(fields ?? base,folder:folder,comp:comp,core:core),panel=Panel(model)
            panel.keySelection=[NativeMotionKeyRef(property:"x",time:0),NativeMotionKeyRef(property:"y",time:0)]
            return (model,panel)
        }
        func begin(_ model:NativeEditorModel,_ panel:Panel,moving:Bool=true)->NativeMotionEditCapture {
            panel.beginMotionDraft(model.selected!,property:"x",renderedVersion:7,movingKeys:moving)!
        }
        for comp in [nil,"nested"] as [String?] {
            let (model,panel)=fresh(comp),before=model.project!.text,context=begin(model,panel)
            panel.previewMotionMove(deltaTime:0.5,deltaValue:5,valueProperty:"x",context:context)
            check(model.calls.isEmpty && model.project!.text==before,"Drafts must not commit or replace the project")
            let operations=try JSON.parse(model.previewOperations!) as! [[String:Any]]
            check(operations.count==4,"Multi-property move must use one complete remove/add batch")
            check(operations.allSatisfy {comp==nil ? $0["comp"] is NSNull:$0["comp"] as? String==comp},"Every preview operation must have explicit captured scope")
            let projected=try core.applyOps(project:before,ops:model.previewOperations!).project
            let expected=NativeProject(fields:try JSON.parse(projected) as! [String:Any]).tracks(in:comp)[0].clips[0]
            check(expected.fields.dictionary("expr").string("x")=="value + time" && expected.fields.objects("masks").count==1,"Draft projection must preserve expressions and masks")
            let movedX=expected.fields.dictionary("anim")["x"] as! [[Any]],movedY=expected.fields.dictionary("anim")["y"] as! [[Any]]
            check((movedX[0][0] as! NSNumber).doubleValue==0.5 && (movedX[0][1] as! NSNumber).doubleValue==25,"Projection must use captured local key time and property value")
            check(movedX[0][2] as? [Double]==[0.2,0.1,0.8,0.9] && movedY[0][2] as? String=="hold","Move must preserve each property's stored easing")
            panel.finishMotionDraft(context)
            check(model.previewCapture==nil && !model.previewing && model.requests>=2,"Committed pixels must be requested before async commit")
            await drain()
            check(model.calls.count==1 && model.version==8,"A completed gesture must dispatch exactly one atomic edit")
            check(NSDictionary(dictionary:model.project!.fields).isEqual(to:try JSON.parse(projected) as! [String:Any]),"Committed operations must equal the last temporary projection")
            check(panel.keySelection==[NativeMotionKeyRef(property:"x",time:0.5),NativeMotionKeyRef(property:"y",time:0.5)],"Successful completion must preserve the moved group selection")
            if comp != nil {check(JSON(any:model.project!.fields["tracks"]!).text==JSON(any:base["tracks"]!).text,"Nested operations must leave reused main IDs untouched")}
        }
        for mode in ["value","speed","numeric"] {
            let (model,panel)=fresh(),context=begin(model,panel,moving:false),before=model.project!.text
            let keys=panel.motionDraft!.keys.filter {$0.property=="x"}
            let ease:Any = mode=="speed" ? NativeMotionMath.draggedSpeed(keys[0],keys[1],incoming:false,point:CGPoint(x:0.8,y:100)) : mode=="value" ? NativeMotionMath.draggedHandle(keys[0],keys[1],incoming:true,point:CGPoint(x:1.4,y:105),flat:1) : [0.3,-0.2,0.7,1.2]
            panel.previewMotionEase(index:0,ease:ease,context:context)
            check(model.calls.isEmpty && model.project!.text==before,"Tangent/numeric easing drafts must preserve the committed baseline")
            check((try JSON.parse(model.previewOperations!) as! [[String:Any]])[0]["op"] as? String=="keyframe_ease","Easing preview must use the exact indexed shared operation")
            panel.finishMotionEase(index:0,ease:ease,context:context);await drain()
            check(model.calls.count==1,"Each easing gesture must dispatch one edit")
        }
        for axis in 0..<18 {
            let (model,panel)=fresh(),context=begin(model,panel)
            panel.previewMotionMove(deltaTime:0.5,context:context);panel.finishMotionDraft(context)
            switch axis {
            case 0:model.version=8
            case 1:model.folder=folder.appendingPathComponent("other")
            case 2:model.composition="nested"
            case 3:model.selectedID="other"
            case 4:model.selectedIDs=["c1","other"]
            case 5:model.time=2
            case 6:model.projectRevision=UUID()
            case 7:model.generation=UUID()
            case 8:model.playing=true
            case 9:model.scrubbing=true
            case 10:model.busy=true
            case 11:model.showingSource=true
            case 12:panel.property="y"
            case 13:panel.keySelection=[]
            case 14:panel.invalidateMotionDraft()
            case 15:model.previewCapture=NativeRenderPreviewCapture(id:UUID(),generation:model.generation,revision:model.projectRevision,folder:folder,version:7,composition:nil,selection:model.selectedIDs,time:1)
            case 16:var fields=model.project!.fields;fields["tracks"]=[["id":"V1","kind":"video","locked":true,"clips":[clip]]];model.project=NativeProject(fields:fields)
            default:model.callError=ReelBackend.APIError("Backend rejected the edit")
            }
            await drain()
            check(model.calls.count==(axis==17 ? 1:0),"Every queued context change must prevent dispatch, without retrying backend errors")
            check(!model.previewing,"No stale or failed edit may leave a temporary draft active")
        }
        for axis in 0..<7 {
            let (model,panel)=fresh()
            switch axis {
            case 0:model.displayedTime=0
            case 1:model.displayedVersion=6
            case 2:model.displayedRevision=UUID()
            case 3:model.displayedComposition="nested"
            case 4:model.displayedPreviewID=UUID()
            case 5:model.displayedFolder=folder.appendingPathComponent("stale")
            default:model.displayedGeneration=UUID()
            }
            check(panel.beginMotionDraft(model.selected!,property:"x",renderedVersion:7,movingKeys:true)==nil,"A stale displayed frame must reject capture")
            check(model.calls.isEmpty && !model.previewing,"Rejected readiness must not fall back to a write")
        }
        for axis in 0..<8 {
            let (model,panel)=fresh(),context=begin(model,panel)
            model.suspendCall=true
            panel.previewMotionMove(deltaTime:0.5,context:context);panel.finishMotionDraft(context)
            while model.suspendedCall==nil {await Task.yield()}
            switch axis {
            case 0:model.selectedID="other"
            case 1:model.selectedIDs=["c1","other"]
            case 2:panel.property="y"
            case 3:panel.keySelection=[NativeMotionKeyRef(property:"x",time:2)]
            case 4:model.time=2
            case 5:model.composition="nested"
            case 6:model.folder=folder.appendingPathComponent("other")
            default:model.generation=UUID()
            }
            model.suspendedCall?.resume();model.suspendedCall=nil;await drain()
            check(model.calls.count==1 && !model.previewing,"A dispatched edit must complete once without resurrecting its temporary preview")
            check(panel.keySelection != [NativeMotionKeyRef(property:"x",time:0.5),NativeMotionKeyRef(property:"y",time:0.5)] && panel.selectedKeyTime==nil,"Suspended completion must not publish moved selection into a changed context")
        }
        for total in [128,129] {
            var fields=base,bulk=clip;bulk["anim"]=["x":(0..<total).map{[Double($0)/100,Double($0)]}]
            fields["tracks"]=[["id":"V1","kind":"video","clips":[bulk]]]
            let (model,panel)=fresh(fields:fields)
            panel.keySelection=Set(panel.allKeys(model.selected!).map(\.ref))
            let context=panel.beginMotionDraft(model.selected!,property:"x",renderedVersion:7,movingKeys:true)
            check((context != nil)==(total==128),"128 selected keys must succeed and 129 must reject before any partial draft")
            if let context {panel.previewMotionMove(deltaTime:0,deltaValue:1,valueProperty:"x",context:context);check((try JSON.parse(model.previewOperations!) as! [[String:Any]]).count==256,"The largest move must remain exactly 256 bounded operations");panel.finishMotionDraft(context);await drain();check(model.calls.count==1,"The maximum valid group must still commit atomically")}
            else {check(model.previewOperations==nil && model.calls.isEmpty,"Over-capacity selection must leave preview and project untouched")}
        }
        let (originModel,originPanel)=fresh(),origin=begin(originModel,originPanel)
        originPanel.previewMotionMove(deltaTime:0.5,context:origin);originModel.displayedPreviewID=originPanel.motionDraft!.render.id
        originPanel.previewMotionMove(deltaTime:0,context:origin);originPanel.finishMotionDraft(origin);await drain()
        check(originModel.calls.isEmpty && !originModel.previewing && originModel.requests>=3,"Return to the original keys must restore pixels and create no history entry")
        let (numericModel,numericPanel)=fresh(),number=Number()
        number.begin={numericPanel.beginMotionDraft(numericModel.selected!,property:"x",renderedVersion:7,movingKeys:true)}
        number.preview={numericPanel.previewMotionMove(deltaTime:0,deltaValue:$0-20,valueProperty:"x",context:$1)}
        number.commit={numericPanel.finishMotionMove(deltaTime:0,deltaValue:$0-20,valueProperty:"x",context:$1)}
        number.end={numericPanel.discardMotionDraft($0)}
        number.beginNumberGesture();let token=number.context;number.beginNumberGesture()
        check(number.context==token,"Repeated numeric draft changes must retain the original capture")
        number.previewNumberGesture(35);number.finishNumberGesture(35);number.endNumberGesture();number.finishNumberGesture(35);await drain()
        check(numericModel.calls.count==1,"Submit followed by focus loss must create exactly one numeric group edit")
        let (cancelModel,cancelPanel)=fresh(),cancel=begin(cancelModel,cancelPanel)
        cancelPanel.previewMotionMove(deltaTime:0.5,context:cancel);cancelPanel.discardMotionDraft(cancel);await drain()
        check(cancelModel.calls.isEmpty && !cancelModel.previewing,"Cancellation must discard the draft without committing")
        let (newModel,newPanel)=fresh(),old=begin(newModel,newPanel),new=begin(newModel,newPanel)
        newPanel.discardMotionDraft(old)
        check(newPanel.motionDraft?.context==new,"An old control's disappearance must not discard a new capture with identical target fields")
        print("Motion production draft, numeric lifecycle and shared-core checks: \(count) assertions passed")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='reel-motion-drafts-') as temp:
    folder=Path(temp); core=folder/'reel-core.js';swift=folder/'Checks.swift';binary=folder/'checks'
    subprocess.run(['node',str(repo/'native/scripts/bundle-core.mjs'),'--out',str(core)],check=True)
    swift.write_text(source)
    subprocess.run(['swiftc','-parse-as-library','-module-cache-path',str(folder/'cache'),str(repo/'native/ReelKit/Sources/ReelKit/JSON.swift'),str(repo/'native/ReelKit/Sources/ReelKit/ReelCore.swift'),str(swift),'-o',str(binary)],check=True)
    subprocess.run([str(binary),str(core),str(folder)],check=True)
