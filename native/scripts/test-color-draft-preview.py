#!/usr/bin/env python3
"""Exercise extracted Color draft methods and type-check their SwiftUI callers."""
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
    color = (editor / 'NativeColorPanel.swift').read_text()
    model = (editor / 'NativeEditorModel.swift').read_text()
    controls = (editor / 'NativeControls.swift').read_text()
    editor_view = (editor / 'NativeEditorView.swift').read_text()
    source = 'import Foundation\nimport SwiftUI\n'
    source += block(model, 'struct NativeRenderPreviewCapture {') + '\n'
    source += block(color, 'struct NativePanelGestureContext: Equatable') + '\n@MainActor ' + block(color, 'func nativeGestureRetry(') + '\n'
    source += block(color, 'struct NativeColorDraftPreview {') + '\n'
    source += block(color, 'enum NativeColorQualifier {') + '\n'
    fixture = r'''
struct NativeClip { let id: String }
enum ReelBackend { struct APIError:Error,LocalizedError {let errorDescription:String?;init(_ text:String) {errorDescription=text}} }
@MainActor final class NativeEditorModel: ObservableObject {
    var folder: URL? = URL(fileURLWithPath:"/project")
    var version = 7
    var composition: String? = "nested"
    var selectedID: String? = "clip1"
    var selectedIDs: Set<String> = ["clip1","clip2"]
    var generation = UUID(), revision = UUID()
    var time = 1.0
    var playing = false, scrubbing = false, busy = false, frameReady = true, rejectsPreview = false
    var status = ""
    var previewCapture: NativeRenderPreviewCapture?
    var previewOperations: [[String:Any]] = []
    var edits: [[String:Any]] = []
    var events: [String] = []
    func beginRenderPreview(renderedVersion: Int) -> NativeRenderPreviewCapture? {
        guard frameReady, renderedVersion == version, !playing, !scrubbing, !busy, let folder else { return nil }
        let capture = NativeRenderPreviewCapture(id:UUID(),generation:generation,revision:revision,folder:folder,version:version,composition:composition,selection:selectedIDs,time:time)
        previewCapture = capture; events.append("begin"); return capture
    }
    func renderPreviewMatches(_ capture: NativeRenderPreviewCapture) -> Bool {
        previewCapture?.id == capture.id && capture.matches(generation:generation,revision:revision,folder:folder,version:version,composition:composition,selection:selectedIDs,time:time) && !playing && !scrubbing && !busy
    }
    func preview(_ operations: [[String:Any]],capture: NativeRenderPreviewCapture) -> Bool {
        guard renderPreviewMatches(capture), !rejectsPreview else { return false }
        previewOperations = operations.map { edit in var edit=edit; edit["comp"]=capture.composition as Any? ?? NSNull(); return edit }; events.append("preview"); return true
    }
    func discardRenderPreview(_ capture: NativeRenderPreviewCapture? = nil,redraw: Bool = true) {
        if let capture, previewCapture?.id != capture.id { return }
        events.append("discard"); previewCapture=nil; previewOperations=[]
    }
    func edit(_ operation: [String:Any],expectedVersion: Int? = nil) {
        precondition(previewCapture == nil,"Preview survived into real commit")
        precondition(expectedVersion == version,"Captured version missing")
        edits.append(operation); events.append("edit")
    }
}
@MainActor final class Panel {
    let model: NativeEditorModel
    var nodeID = "n2", curveChannel = "master"
    var gradePreview: NativeColorDraftPreview?
    var gradeGestureID = UUID()
    init(_ model:NativeEditorModel) { self.model=model }
'''
    methods = ['private func captureGradeGesture(', 'private func beginGradePreview(', 'private func previewGradeDraft(', 'private func commitGradePreview(', 'private func discardGradePreview(', 'private func invalidateGradePreview(', 'private func commitGradeGesture(']
    for marker in methods:
        fixture += block(color,marker) + '\n'
    fixture += '}\n'
    fixture += '@MainActor final class Number { var attempted=false; var context:NativePanelGestureContext?; var resetID=UUID(); var begin:()->NativePanelGestureContext? = {nil}; var preview:((Double,NativePanelGestureContext)->Void)?; var end:((NativePanelGestureContext?)->Void)?; var commit:(Double,NativePanelGestureContext)->Void = {_,_ in}\n'
    for marker in ['private func beginNumberGesture(', 'private func previewNumberGesture(', 'private func endNumberGesture(', 'private func commitNumberGesture(']:
        fixture += block(color,marker) + '\n'
    fixture += '}\n'
    fixture += '@MainActor final class Wheel { var draft:[Double]?; var dragStart:[Double]?; var gestureContext:NativePanelGestureContext?; var masterEditing=false,gestureAttempted=false; var source=[0.0,0,0]; var end:(NativePanelGestureContext?)->Void={_ in}; var commit:([Double],NativePanelGestureContext)->Void={_,_ in}\n'
    for marker in ['private func clearWheelGesture(', 'private func finishWheelGesture(']:
        fixture += block(color,marker) + '\n'
    fixture += '}\n'
    fixture += '@MainActor final class Curve { var draft:[[Double]]?; var dragging:Int?; var gestureContext:NativePanelGestureContext?; var gestureAttempted=false; var selected:Int?; var points=[[0.0,0],[1,1]]; var end:(NativePanelGestureContext?)->Void={_ in}; var commit:([[Double]],NativePanelGestureContext)->Void={_,_ in}\n'
    for marker in ['private func clearCurveGesture(', 'private func finishCurveGesture(']:
        fixture += block(color,marker) + '\n'
    fixture += '}\n'
    tests = r'''
func require(_ value:Bool,_ message:String) { if !value { fatalError(message) } }
@main struct PreviewChecks {
    @MainActor static func main() throws {
        var count=0, replay:[[String:Any]]=[]
        func check(_ yes:Bool,_ message:String) { require(yes,message); count += 1 }
        func fresh(_ kind:String="clipGrade",_ property:String="lift") -> (NativeEditorModel,Panel,NativePanelGestureContext) {
            let model=NativeEditorModel(), panel=Panel(model)
            let context=panel.captureGradeGesture(NativeClip(id:"clip1"),primary:kind=="clipGrade",property:property,renderedVersion:7,renderedNode:"n2")!
            require(panel.beginGradePreview(context) != nil,"Fresh preview did not begin")
            return (model,panel,context)
        }
        for kind in ["clipGrade","nodeGrade"] {
            let (model,panel,context)=fresh(kind)
            panel.previewGradeDraft([0.2,-0.1,-0.1],context:context)
            check(model.edits.isEmpty && model.previewOperations.count==1,"Draft committed history or failed to preview")
            let operation=model.previewOperations[0]
            check(operation.string("op")==((kind=="clipGrade") ? "update":"node_update") && operation.string("comp")=="nested","Draft lost target type/composition")
            replay.append(["kind":kind,"ops":model.previewOperations])
            panel.commitGradePreview([0.2,-0.1,-0.1],context:context)
            check(model.events.suffix(2)==["discard","edit"] && model.edits.count==1 && panel.gradePreview==nil,"Preview was not discarded before the only commit")
        }
        for axis in 0..<13 {
            let (model,panel,context)=fresh("nodeGrade","curves.master")
            panel.previewGradeDraft([[0.0,0],[0.5,0.7],[1,1]],context:context)
            switch axis {
            case 0:model.version=8
            case 1:model.folder=URL(fileURLWithPath:"/other")
            case 2:model.composition=nil
            case 3:model.selectedID="clip2"
            case 4:panel.nodeID="n3"
            case 5:panel.curveChannel="r"
            case 6:model.time=2
            case 7:model.revision=UUID()
            case 8:model.generation=UUID()
            case 9:model.selectedIDs=["clip1"]
            case 10:model.playing=true
            case 11:model.scrubbing=true
            default:model.busy=true
            }
            panel.commitGradePreview([[0.0,0],[0.5,0.7],[1,1]],context:context)
            check(model.edits.isEmpty && model.previewCapture==nil && panel.gradePreview==nil,"Stale draft committed or survived (axis \(axis))")
        }
        let (model,panel,context)=fresh()
        model.rejectsPreview=true; let initialID=panel.gradeGestureID
        panel.previewGradeDraft([0.2,0,0],context:context)
        check(panel.gradePreview==nil && model.previewCapture==nil && initialID != panel.gradeGestureID,"Rejected preview did not invalidate local gesture")
        panel.commitGradePreview([0.2,0,0],context:context)
        check(model.edits.isEmpty,"Rejected preview later committed")
        let unavailable=NativeEditorModel(), waiting=Panel(unavailable)
        unavailable.frameReady=false
        check(waiting.beginGradePreview(waiting.captureGradeGesture(NativeClip(id:"clip1"),primary:true,property:"contrast",renderedVersion:7,renderedNode:"n2"))==nil && unavailable.edits.isEmpty,"Stale displayed frame began preview")
        check(NativeColorDraftPreview.curve([[0,0],[0.5,0.6],[0.5005,0.8],[1,1]])?.count==3,"Curve preview did not share commit deduplication")
        for bad in [[[0.0,0],[1,Double.nan]],[[0.0],[1,1]],[[0.0,0],[0.0005,0.3]]] {
            check(NativeColorDraftPreview.curve(bad)==nil,"Invalid/degenerate preview curve accepted")
        }
        check(NativeColorDraftPreview.operation(Double.nan,context:context)==nil && NativeColorDraftPreview.operation([0.0,Double.infinity,0],context:context)==nil,"Nonfinite grade preview accepted")
        let (curveModel,curvePanel,curveContext)=fresh("clipGrade","curves.master")
        curvePanel.previewGradeDraft([[1.0,1],[0.5,0.7],[0,0]],context:curveContext)
        replay.append(["kind":"curve","ops":curveModel.previewOperations])
        check(curveModel.previewOperations[0].dictionary("set").dictionary("grade").dictionary("curves")["master"] as? [[Double]] == [[0.0,0],[0.5,0.7],[1,1]],"Curve preview patch did not target captured channel")
        let curve=Curve(); curve.gestureContext=curveContext; curve.draft=[[0,0],[0.5,0.7],[1,1]]; curve.dragging=1; curve.gestureAttempted=true
        curve.end={curvePanel.discardGradePreview($0)}; curve.commit={curvePanel.commitGradePreview($0,context:$1)}; curve.finishCurveGesture()
        check(curveModel.edits.count==1 && curve.draft==nil && curve.gestureContext==nil && !curve.gestureAttempted,"Curve end ordering lost commit or draft cleanup")
        let (wheelModel,wheelPanel,wheelContext)=fresh()
        let wheel=Wheel(); wheel.gestureContext=wheelContext; wheel.draft=[0.2,0,0]; wheel.dragStart=[0,0,0]; wheel.gestureAttempted=true
        wheel.end={wheelPanel.discardGradePreview($0)}; wheel.commit={wheelPanel.commitGradePreview($0,context:$1)}; wheel.finishWheelGesture()
        check(wheelModel.edits.count==1 && wheel.draft==nil && wheel.gestureContext==nil && !wheel.gestureAttempted,"Wheel end ordering lost commit or draft cleanup")
        let (noOpModel,noOpPanel,noOpContext)=fresh()
        let noOp=Wheel(); noOp.gestureContext=noOpContext; noOp.draft=[0,0,0]; noOp.end={noOpPanel.discardGradePreview($0)}; noOp.commit={noOpPanel.commitGradePreview($0,context:$1)}; noOp.finishWheelGesture()
        check(noOpModel.edits.isEmpty && noOpPanel.gradePreview==nil,"No-op wheel retained preview or committed")
        let (numberModel,numberPanel,numberContext)=fresh("clipGrade","contrast")
        let number=Number(); var begins=0
        number.begin={ begins += 1; return numberContext }; number.preview={numberPanel.previewGradeDraft($0,context:$1)}; number.end={numberPanel.discardGradePreview($0)}; number.commit={numberPanel.commitGradePreview($0,context:$1)}
        number.beginNumberGesture(); number.beginNumberGesture(); number.previewNumberGesture(1.5)
        check(begins==1 && numberModel.edits.isEmpty && numberModel.previewOperations.count==1,"Numeric draft recaptured or committed")
        number.commitNumberGesture(1.5)
        check(numberModel.edits.count==1 && numberPanel.gradePreview==nil && !number.attempted && number.context==nil,"Numeric preview end lost commit/cleanup")
        let (cancelModel,cancelPanel,cancelContext)=fresh("clipGrade","contrast")
        number.begin={cancelContext}; number.end={cancelPanel.discardGradePreview($0)}; number.beginNumberGesture(); number.endNumberGesture()
        check(cancelModel.edits.isEmpty && cancelPanel.gradePreview==nil,"Canceled numeric edit committed or retained preview")
        var captures=0; number.begin={captures += 1; return nil}; number.beginNumberGesture(); number.beginNumberGesture(); number.previewNumberGesture(2)
        check(captures==1 && number.context==nil,"Failed numeric capture retried mid-edit")
        number.endNumberGesture(); number.beginNumberGesture(); check(captures==2,"Next numeric edit did not recapture")
        let (disappearModel,disappearPanel,disappearContext)=fresh(); disappearPanel.previewGradeDraft([0.1,0,0],context:disappearContext); disappearPanel.invalidateGradePreview()
        check(disappearModel.edits.isEmpty && disappearModel.previewCapture==nil && disappearPanel.gradePreview==nil,"Invalidation/disappear did not discard draft")
        let (mainModel,mainPanel,_)=fresh(); mainPanel.discardGradePreview(); mainModel.composition=nil
        let mainContext=mainPanel.captureGradeGesture(NativeClip(id:"clip1"),primary:true,property:"exposure",renderedVersion:7,renderedNode:"n2")!; _=mainPanel.beginGradePreview(mainContext); mainPanel.previewGradeDraft(1.0,context:mainContext)
        check(mainModel.previewOperations[0]["comp"] is NSNull,"Main composition preview omitted explicit null")
        let qualifierModel=NativeEditorModel(),qualifierPanel=Panel(qualifierModel)
        let qualifierContext=NativePanelGestureContext(folder:qualifierModel.folder!,version:7,composition:"nested",selection:"clip1",targetKind:"nodeQualifier",targetID:"clip1",nodeID:"n2",busID:nil,property:"qualifier.hue.0")
        require(qualifierPanel.beginGradePreview(qualifierContext) != nil,"Qualifier preview did not begin")
        qualifierPanel.previewGradeDraft(["hue":[350.0,10.0]],context:qualifierContext)
        check(qualifierModel.edits.isEmpty && qualifierModel.previewOperations.count==1 && qualifierModel.previewOperations[0].dictionary("set").dictionary("grade").isEmpty,"Qualifier numeric draft committed history or patched grade instead of qualifier")
        replay.append(["kind":"qualifier","ops":qualifierModel.previewOperations])
        qualifierPanel.commitGradePreview(["hue":[350.0,10.0]],context:qualifierContext)
        check(qualifierModel.events.last=="discard" && qualifierModel.edits.isEmpty && qualifierPanel.gradePreview==nil,"Qualifier bypassed the captured workflow commit path or retained a rejected draft")
        print("Passed \(count) production Color GPU draft integration safeguards")
        try JSONSerialization.data(withJSONObject:replay).write(to:URL(fileURLWithPath:CommandLine.arguments[1]))
    }
}
extension Dictionary where Key==String,Value==Any {
    func string(_ key:String)->String { self[key] as? String ?? "" }
    func dictionary(_ key:String)->[String:Any] { self[key] as? [String:Any] ?? [:] }
    func number(_ key:String,_ fallback:Double=0)->Double { (self[key] as? NSNumber)?.doubleValue ?? fallback }
}
'''
    with tempfile.TemporaryDirectory(prefix='reel-color-draft-') as directory:
        temp=Path(directory); swift=temp/'DraftChecks.swift'; binary=temp/'DraftChecks'; cache=temp/'cache'; replay=temp/'replay.json'
        swift.write_text(source+fixture+tests)
        subprocess.run(['xcrun','swiftc','-parse-as-library','-module-cache-path',str(cache),str(swift),'-o',str(binary)],check=True)
        subprocess.run([str(binary),str(replay)],check=True)
        js=r'''import fs from 'node:fs';import assert from 'node:assert/strict';import {applyOps} from './editor/core/project.js';
const rows=JSON.parse(fs.readFileSync(process.argv[1]));
const input={version:3,fps:30,width:1920,height:1080,tracks:[],assets:{},comps:{nested:{fps:30,width:1920,height:1080,tracks:[{id:'V1',kind:'video',clips:[{id:'clip1',kind:'video',start:0,dur:1,nodes:{list:[{id:'n1',type:'source'},{id:'n2',type:'corrector'},{id:'n3',type:'output'}],links:[{from:'n1',to:'n2',input:0},{from:'n2',to:'n3',input:0}]}}]}]}}};
for(const row of rows){const baseline=structuredClone(input);const {project}=applyOps(baseline,row.ops);assert.deepEqual(baseline,input);const clip=project.comps.nested.tracks[0].clips[0];const grade=row.kind==='nodeGrade'?clip.nodes.list[1].grade:clip.grade;if(row.kind==='qualifier')assert.deepEqual(clip.nodes.list[1].qualifier.hue,[350,10]);else if(row.kind==='curve')assert.deepEqual(grade.curves.master,[[0,0],[.5,.7],[1,1]]);else assert.deepEqual(grade.lift,[.2,-.1,-.1]);assert.deepEqual(project.tracks,[]);}
console.log(`Passed ${rows.length} Color draft patches through production shared applyOps`);'''
        subprocess.run(['node','--input-type=module','-e',js,str(replay)],cwd=repo,check=True)
        ui=source+fixture+'\n'+block(controls,'enum NativeEditorStyle {')+'\n'+block(controls,'enum NativeType {')+'\n'+block(controls,'enum NativeRadius {')+'\n'+block(controls,'struct NativeToolbarButtonStyle: ButtonStyle {')+'\n'+block(controls,'struct NativeNumberRow: View {')
        # The iOS gesture context stores a NativePanelInteractionStamp from the production interaction policy.
        ui+='\n#if os(iOS)\n'+color.split('// BEGIN PANEL INTERACTION POLICY\n',1)[1].split('// END PANEL INTERACTION POLICY',1)[0]+block(editor_view,'struct NativeContextInteractionLayout: Equatable')+'\n#endif\n'
        for marker in ['struct NativeGestureNumberRow: View {','private struct NativeGradeWheel: View {','private struct NativeColorCurveEditor: View {']:
            ui+='\n'+block(color,marker)
        ui+='\nextension Dictionary where Key==String,Value==Any { func number(_ key:String,_ fallback:Double=0)->Double {(self[key] as? NSNumber)?.doubleValue ?? fallback} }\n'
        ui+='struct GradePreviewViews: View { let model:NativeEditorModel; @State private var nodeID="n2"; @State private var curveChannel="master"; @State private var gradePreview:NativeColorDraftPreview?; @State private var gradeGestureID=UUID(); var body:some View {EmptyView()}\n'
        for marker in methods+['private func wheel(','private func gradeControl(']:
            ui+=block(color,marker)+'\n'
        ui+='}\n'; swift.write_text(ui)
        for sdk,target in [('macosx','arm64-apple-macos14.0'),('iphonesimulator','arm64-apple-ios17.0-simulator')]:
            path=subprocess.check_output(['xcrun','--sdk',sdk,'--show-sdk-path'],text=True).strip()
            subprocess.run(['xcrun','swiftc','-typecheck','-sdk',path,'-target',target,'-module-cache-path',str(cache),str(swift)],check=True)
        print('Production wheel, curve, numeric and draft caller views type-check for macOS 14 and iOS 17 Simulator. No app build or UI launch ran.')


if __name__=='__main__':
    main()
