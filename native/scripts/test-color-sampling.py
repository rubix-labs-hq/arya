#!/usr/bin/env python3
"""Exercise production displayed-pixel sampling, qualifier callbacks and still capture."""
from pathlib import Path
import argparse
import shutil
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', type=Path, help='Keep the actual web vectors and captured operation requests here.')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    editor = repo / 'native/App/Shared/NativeEditor'
    kit = repo / 'native/ReelKit/Sources/ReelKit'
    color = (editor / 'NativeColorPanel.swift').read_text()
    model = (editor / 'NativeEditorModel.swift').read_text()
    project = (editor / 'NativeProject.swift').read_text()
    deliver = (editor / 'NativeDeliverPanel.swift').read_text()
    source = 'import Foundation\nimport SwiftUI\nimport CoreGraphics\nimport CryptoKit\nimport Darwin\n'
    source += (kit / 'JSON.swift').read_text() + '\n'
    source += project[project.index('struct NativeProject {'):project.index('enum NativeProcessingRequests {')] + '\n'
    source += block(project, 'extension Dictionary where Key == String, Value == Any') + '\n'
    source += block(project, 'func nativeTimecode(') + '\n'
    for marker in ['struct NativeInterchangeSource: Sendable', 'struct NativeInterchangeOptions: Equatable', 'struct NativeInterchangeOrigin: Equatable', 'enum NativeInterchangeDisplay {']:
        source += block(deliver, marker) + '\n'
    for marker in ['struct NativeRenderPreviewCapture {', 'struct NativeDisplayedFrameCapture {', 'struct NativeViewerColorPicker {', 'struct NativeViewerComparison {']:
        source += block(model, marker) + '\n'
    for marker in ['struct NativeColorWorkflowCapture {', 'struct NativeColorGraphPlanner {', 'extension NativeColorGraphPlanner {', 'enum NativeColorWorkflows {', 'enum NativeColorQualifier {', 'struct NativeColorPixelBuffer {', 'struct NativeColorGalleryProvenance {', 'struct NativeColorSampleTarget {', '@MainActor final class NativeColorSampleAction {', 'struct NativeColorGalleryStill: Identifiable', 'final class NativeColorGalleryStore: ObservableObject', 'struct NativePanelGestureContext: Equatable', 'struct NativeColorDraftPreview {']:
        source += block(color, marker) + '\n'
    fixture = r'''
@MainActor func nativeGestureRetry(_ model:NativeEditorModel) {model.status="Changed gesture"}
final class ReelRenderedFrame {
    let image:CGImage
    init(_ image:CGImage) {self.image=image}
    func cgImage() throws->CGImage {image}
}
@MainActor final class ReelBackend {
    struct APIError:Error,LocalizedError {let errorDescription:String?;init(_ text:String) {errorDescription=text}}
    var calls:[[String:Any]]=[]
    var responder:(([String:Any]) async throws->JSON)?
    func handle(method:String,path:String,body:String?) async throws->JSON {
        precondition(method=="POST" && path=="/api/ops")
        let fields=try JSON.parse(body ?? "{}") as? [String:Any] ?? [:]
        calls.append(fields);return try await responder?(fields) ?? JSON(any:[:])
    }
}
@MainActor final class EditorSession:ObservableObject {var folder:URL?;var backend:ReelBackend?;var sessionID="one"}
@MainActor final class NativeEditorModel:ObservableObject {
    let colorGallery=NativeColorGalleryStore()
    var project:NativeProject?
    var version=7,composition:String?="nested",selectedID:String?="c1",selectedIDs:Set<String>=["c1"]
    var folder:URL?=URL(fileURLWithPath:"/captured-project")
    var time=1.0,width=24.0,height=24.0
    var fps:Double {composition.flatMap {project?.fields.dictionary("comps").dictionary($0).number("fps",30)} ?? project?.fps ?? 30}
    var tracks:[NativeTrack] {project?.tracks(in:composition) ?? []}
    var selected:NativeClip? {tracks.flatMap(\.clips).first {$0.id==selectedID}}
    var generation=UUID(),projectRevision=UUID()
    var processingContextID:UUID {generation}
    var playing=false,scrubbing=false,busy=false,showingSource=false,rendering=false
    var renderer:Int?=1,renderError:String?
    var displayedTime:Double?,displayedVersion:Int?,displayedComposition:String?,displayedRevision:UUID?,displayedFolder:URL?,displayedGeneration:UUID?,displayedPreviewID:UUID?
    var previewOwnershipID:UUID?
    var previewCapture:NativeRenderPreviewCapture?,previewOperations:[[String:Any]]?
    func discardRenderPreview(_ capture:NativeRenderPreviewCapture?=nil,redraw:Bool=true) {if capture==nil || capture?.id==previewCapture?.id {previewCapture=nil;previewOperations=nil}}
    var frame:CGImage?,metalFrame:ReelRenderedFrame?
    @Published var viewerColorPicker:NativeViewerColorPicker?
    @Published var viewerComparison:NativeViewerComparison?
    @Published var viewerComparisonFraction=0.5
    var mobilePanel:Int?=1,status="",receives=0,pending=0
    var lutReply:(() async throws->[String:Any])?
    func call(_ path:String) async throws->[String:Any] {precondition(path=="/api/luts");return try await lutReply?() ?? [:]}
    func painted(_ image:CGImage) {
        frame=image;metalFrame=ReelRenderedFrame(image);displayedTime=time;displayedVersion=version
        displayedComposition=composition;displayedRevision=projectRevision;displayedFolder=folder;displayedGeneration=generation;displayedPreviewID=nil
    }
    func perform(_ action:@escaping @MainActor () async throws->Void) {
        pending += 1
        Task {defer {pending -= 1};do {try await action()} catch {status=error.localizedDescription}}
    }
    func receive(_ event:String,_ text:String) {
        receives += 1
        let fields=try! JSON.parse(text) as! [String:Any]
        version=Int(fields.number("version"));project=NativeProject(fields:fields.dictionary("project"));projectRevision=UUID()
    }
MODEL_METHODS
}
@MainActor final class Gallery {
    let model:NativeEditorModel
    let session:EditorSession
    @ObservedObject var colorGallery:NativeColorGalleryStore
    var stills:[NativeColorGalleryStill] {get {colorGallery.stills} set {colorGallery.stills=newValue}}
    var comparisonID:UUID?
    var luts:[String]=[]
    var nodeID="n2",curveChannel="master"
    var gradePreview:NativeColorDraftPreview?
    let sharedContextHeader:Bool
    convenience init(_ model:NativeEditorModel,session:EditorSession?=nil) {self.init(model:model,session:session ?? EditorSession())}
GALLERY_METHODS
}
'''
    methods = ['func renderPreviewMatches(', 'func renderPreviewCommitMatches(', 'func viewerGeometryIsCurrent(', 'func captureDisplayedCommittedFrame(', 'func frameCaptureMatches(', 'func viewerComparisonMatches(']
    fixture = fixture.replace('MODEL_METHODS', '\n'.join(block(model, marker) for marker in methods))
    fixture = fixture.replace('GALLERY_METHODS', '\n'.join(block(color, marker) for marker in ['init(model: NativeEditorModel, session: EditorSession, sharedContextHeader: Bool = false)', 'private func grabColorStill(', 'private func compareColorStill(', 'private func loadColorLUTs(', 'private func commitQualifierPreview(', 'private func discardGradePreview(', 'private func submitColorOperations('])).replace('model.perform {', 'model.perform { [self] in')
    checks = r'''
func require(_ yes:Bool,_ message:String) {if !yes {fatalError(message)}}
func image(_ width:Int,_ height:Int,_ rgba:[UInt8],space:CGColorSpace=CGColorSpace(name:CGColorSpace.sRGB)!) -> CGImage {
    let provider=CGDataProvider(data:Data(rgba) as CFData)!
    return CGImage(width:width,height:height,bitsPerComponent:8,bitsPerPixel:32,bytesPerRow:width*4,space:space,bitmapInfo:CGBitmapInfo(rawValue:CGBitmapInfo.byteOrder32Big.rawValue|CGImageAlphaInfo.premultipliedLast.rawValue),provider:provider,decode:nil,shouldInterpolate:false,intent:.defaultIntent)!
}
@main struct SamplingChecks {
    @MainActor static func main() async throws {
        var count=0,replay:[[String:Any]]=[]
        func check(_ yes:Bool,_ message:String) {require(yes,message);count += 1}
        func near(_ a:[Double],_ b:[Double],_ epsilon:Double=1e-9)->Bool {a.count==b.count && zip(a,b).allSatisfy {abs($0-$1)<=epsilon}}
        let vectors=try JSON.parse(String(contentsOfFile:CommandLine.arguments[1],encoding:.utf8)) as! [[String:Any]]
        for row in vectors {
            let rgb=row["rgb"] as! [Double],expected=row["hsl"] as! [Double]
            check(near(try NativeColorQualifier.hsl(rgb),expected),"Production HSL differs from web")
            let around=try NativeColorQualifier.around(rgb),expanded=try NativeColorQualifier.expand(row.dictionary("input"),rgb:rgb)
            for key in ["hue","sat","lum"] {
                check(near(around[key] as! [Double],row.dictionary("around")[key] as! [Double]),"Production centered qualifier differs from web")
                check(near(expanded[key] as! [Double],row.dictionary("expanded")[key] as! [Double]),"Production expanded qualifier differs from web")
            }
            check(expanded.flag("invert") && expanded.flag("show") && expanded.number("soft")==0.17,"Qualifier add lost flags or softness")
        }
        var quadrants:[UInt8]=[]
        for y in 0..<14 {for x in 0..<14 {quadrants += y<7 ? (x<7 ? [255,0,0,255]:[0,255,0,255]) : (x<7 ? [0,0,255,255]:[255,255,255,255])}}
        let normalized=try NativeColorPixelBuffer.normalized(image(14,14,quadrants))
        for (u,v,color) in [(0.2,0.2,[1.0,0,0]),(0.8,0.2,[0.0,1,0]),(0.2,0.8,[0.0,0,1]),(0.8,0.8,[1.0,1,1])] {
            check(near(try normalized.sample(u:u,v:v),color),"CGImage normalized top-left orientation or channels differ")
        }
        let alpha=try NativeColorPixelBuffer.normalized(image(1,1,[64,0,0,128]))
        check(near(try alpha.sample(u:0,v:0),[0.5,0,0],0.01),"Premultiplied alpha was not converted to straight RGB")
        let padded=NativeColorPixelBuffer(width:1,height:1,bytesPerRow:8,data:Data([32,64,96,255,255,255,255,255]))
        check(near(try padded.sample(u:0,v:0),[32.0/255,64.0/255,96.0/255]),"RGBA row stride ignored")
        var neighborhood=Array(repeating:UInt8(0),count:7*7*4)
        for i in 0..<49 {neighborhood[i*4+2]=255;neighborhood[i*4+3]=255}
        neighborhood[(3*7+3)*4]=255;neighborhood[(3*7+3)*4+2]=0
        let patch=NativeColorPixelBuffer(width:7,height:7,bytesPerRow:28,data:Data(neighborhood))
        check(near(try patch.sample(u:0.5,v:0.5),[1.0/25,0,24.0/25]),"5x5 sample neighborhood differs")
        let corner=NativeColorPixelBuffer(width:1,height:1,bytesPerRow:4,data:Data([255,0,0,255]))
        check(near(try corner.sample(u:0.999,v:0.999),[1,0,0]),"Edge sampling overflowed or used missing neighbors")
        for (u,v) in [(1.0,0.0),(0.0,1.0),(-0.1,0.0),(0.0,-0.1),(.nan,0.0),(0.0,.infinity)] {
            do {_=try corner.sample(u:u,v:v);fatalError("Invalid coordinates accepted")} catch {count += 1}
        }
        for invalid in [NativeColorPixelBuffer(width:1,height:1,bytesPerRow:4,data:Data([0,0,0,0])),NativeColorPixelBuffer(width:2,height:2,bytesPerRow:8,data:Data([255,0,0,255]))] {
            do {_=try invalid.sample(u:0,v:0);fatalError("Transparent or truncated image accepted")} catch {count += 1}
        }
        let p3=CGColorSpace(name:CGColorSpace.displayP3)!,p3Color=CGColor(colorSpace:p3,components:[128.0/255,80.0/255,20.0/255,1])!
        let expectedP3=p3Color.converted(to:CGColorSpace(name:CGColorSpace.sRGB)!,intent:.defaultIntent,options:nil)!.components!
        let converted=try NativeColorPixelBuffer.normalized(image(1,1,[128,80,20,255],space:p3))
        check(near(try converted.sample(u:0,v:0),expectedP3.prefix(3).map {min(1,max(0,Double($0)))},0.008),"Display P3 pixels were mislabeled as sRGB without conversion")
        check(normalized.hash.count==64 && normalized.hash != corner.hash,"Pixel signature omitted geometry or pixel identity")
        let large=image(1300,2,Array(repeating:[UInt8(128),128,128,255],count:2600).flatMap {$0})
        let small=try NativeColorPixelBuffer.normalized(large).image()
        check(small.width==1280 && small.height==1,"Gallery downsample was not bounded or preserved dimension scaling")
        let qualifier:[String:Any]=["hue":[350.0,10.0],"sat":[0.2,0.6],"lum":[0.1,0.9],"soft":0.17,"invert":true,"show":true]
        check(NativeColorQualifier.pair(["sat":[0.9,0.2]],"sat")==[0.2,0.9] && NativeColorQualifier.pair(["hue":[350.0,10]],"hue")==[350,10],"Numeric qualifier ranges invert or reject valid hue wrap")
        check(NativeColorQualifier.pair(["lum":[Double.nan,1]],"lum")==[0,1],"Nonfinite range can create invalid slider bounds")
        check(NativeColorQualifier.numeric(.nan,key:"soft",index:nil,qualifier:qualifier)==nil,"Nonfinite numeric qualifier draft accepted")
        let numeric=NativeColorQualifier.numeric(0.99,key:"sat",index:0,qualifier:qualifier)!
        check(numeric["sat"] as! [Double]==[0.6,0.6],"Numeric qualifier endpoint crossed its counterpart")
        let draft=NativePanelGestureContext(folder:URL(fileURLWithPath:"/captured-project"),version:7,composition:"nested",selection:"c1",targetKind:"nodeQualifier",targetID:"c1",nodeID:"n2",busID:nil,property:"qualifier.sat.0")
        check(NativeColorDraftPreview.operation(numeric,context:draft)?.dictionary("set").dictionary("qualifier")["sat"] as? [Double] == [0.6,0.6],"Numeric qualifier draft failed to produce actual node_update preview")
        for bad in [["lum":[0.0,1]], ["sat":[Double.nan,1]], ["sat":[0.9,0.2]], ["sat":[-1.0,0.2]], ["sat":[0.1,0.2],"soft":0.1]] as [[String:Any]] {
            check(NativeColorDraftPreview.operation(bad,context:draft)==nil,"Numeric qualifier draft changed uncaptured field or accepted invalid range")
        }
        let graph:[String:Any]=["list":[["id":"n1","type":"source"],["id":"n2","type":"corrector","qualifier":["hue":[350.0,10.0],"sat":[0.2,0.6],"lum":[0.1,0.9],"soft":0.17,"invert":true]],["id":"n3","type":"output"]],"links":[["from":"n1","to":"n2","input":0],["from":"n2","to":"n3","input":0]]]
        let clip:[String:Any]=["id":"c1","kind":"color","color":"#ff0000","start":0,"dur":3,"nodes":graph]
        let project:[String:Any]=["name":"Pixel origin","width":24,"height":24,"fps":30,"tracks":[["id":"M1","kind":"video","clips":[clip]]],"comps":["nested":["name":"Nested color","width":24,"height":24,"fps":24,"tracks":[["id":"V1","kind":"video","clips":[clip]]]]]]
        let red=image(24,24,Array(repeating:[UInt8(255),0,0,255],count:576).flatMap {$0})
        func fresh()->(NativeEditorModel,EditorSession,ReelBackend) {
            let model=NativeEditorModel(),session=EditorSession(),backend=ReelBackend()
            model.project=NativeProject(fields:project);model.painted(red);session.folder=model.folder;session.backend=backend
            backend.responder={_ in JSON(any:["version":8,"project":project])};return (model,session,backend)
        }
        func settle(_ model:NativeEditorModel) async throws {for _ in 0..<1000 {if model.pending==0 {return};try await Task.sleep(nanoseconds:1_000_000)};fatalError("Picker apply timed out")}
        for adding in [false,true] {
            let (model,session,backend)=fresh()
            check(NativeColorSampleAction.begin(model:model,session:session,node:"n2",adding:adding) && model.mobilePanel==nil && backend.calls.isEmpty,"Picker start mutated history or hid the viewer on mobile")
            let callback=model.viewerColorPicker!.onPick;callback(0.5,0.5);callback(0.5,0.5);try await settle(model)
            check(backend.calls.count==1 && model.receives==1 && model.viewerColorPicker==nil && model.status.contains("Undo"),"Picker did not apply exactly one accepted update")
            let body=backend.calls[0],op=body.objects("ops")[0]
            check(body.number("expectedVersion")==7 && op.string("comp")=="nested" && op.string("id")=="c1" && op.string("node")=="n2","Sample apply lost captured node/composition/version")
            check(op.dictionary("set").dictionary("qualifier").flag("invert"),"Sample set/add lost existing invert flag")
            replay.append(["project":project,"body":body])
        }
        let (main,mainSession,mainBackend)=fresh();main.composition=nil;main.painted(red)
        check(NativeColorSampleAction.begin(model:main,session:mainSession,node:"n2",adding:false),"Main picker rejected")
        main.viewerColorPicker!.onPick(0.5,0.5);try await settle(main)
        check(mainBackend.calls[0].objects("ops")[0]["comp"] is NSNull,"Main sample scope omitted explicit null")
        replay.append(["project":project,"body":mainBackend.calls[0]])
        for axis in 0..<22 {
            let (model,session,backend)=fresh()
            require(NativeColorSampleAction.begin(model:model,session:session,node:"n2",adding:false),"Fresh picker rejected")
            let callback=model.viewerColorPicker!.onPick
            switch axis {
            case 0:model.version=8
            case 1:model.time=2
            case 2:model.projectRevision=UUID()
            case 3:model.generation=UUID()
            case 4:model.selectedID=nil
            case 5:model.selectedIDs=["c1","other"]
            case 6:model.composition=nil
            case 7:model.folder=URL(fileURLWithPath:"/other")
            case 8:session.folder=URL(fileURLWithPath:"/other")
            case 9:session.backend=ReelBackend()
            case 10:model.metalFrame=ReelRenderedFrame(red)
            case 11:model.displayedVersion=6
            case 12:model.displayedTime=0
            case 13:model.rendering=true
            case 14:model.busy=true
            case 15:model.playing=true
            case 16:model.scrubbing=true
            case 17:model.showingSource=true
            case 18:model.previewOperations=[]
            case 19:model.displayedPreviewID=UUID()
            case 20:model.viewerColorPicker=nil
            default:var changed=project;changed["name"]="Edited without version event";model.project=NativeProject(fields:changed)
            }
            callback(0.5,0.5);try await settle(model)
            check(backend.calls.isEmpty && model.receives==0,"Stale/canceled picker committed axis \(axis)")
        }
        for cancel in [false,true] {
            let (model,session,backend)=fresh();require(NativeColorSampleAction.begin(model:model,session:session,node:"n2",adding:false),"Picker start failed")
            model.viewerColorPicker!.onPick(0.5,0.5)
            if cancel {model.viewerColorPicker=nil} else {model.time=2}
            try await settle(model)
            check(backend.calls.isEmpty && model.receives==0 && model.viewerColorPicker==nil,"Cancel/context drift before queued dispatch committed")
        }
        for late in 0..<5 {
            let (model,session,backend)=fresh()
            backend.responder={_ in
                if late==0 {session.backend=ReelBackend()} else if late==1 {model.time=2} else if late==2 {model.version=9} else if late==3 {model.generation=UUID()}
                if late==4 {return JSON(any:["version":8])}
                return JSON(any:["version":8,"project":project])
            }
            require(NativeColorSampleAction.begin(model:model,session:session,node:"n2",adding:false),"Picker start failed")
            model.viewerColorPicker!.onPick(0.5,0.5);try await settle(model)
            check(backend.calls.count==1 && model.receives==0 && !model.status.contains("Undo"),"Late qualifier result published into changed context")
        }
        for badNode in ["n1","missing"] {let (model,session,backend)=fresh();check(!NativeColorSampleAction.begin(model:model,session:session,node:badNode,adding:false) && backend.calls.isEmpty,"Forbidden qualifier target accepted")}
        let (locked,lockedSession,_)=fresh();var lockedProject=project;var comps=lockedProject["comps"] as! [String:[String:Any]];var tracks=comps["nested"]!.objects("tracks");tracks[0]["locked"]=true;comps["nested"]!["tracks"]=tracks;lockedProject["comps"]=comps;locked.project=NativeProject(fields:lockedProject)
        check(!NativeColorSampleAction.begin(model:locked,session:lockedSession,node:"n2",adding:false),"Locked qualifier target accepted")
        func draftPanel(_ model:NativeEditorModel,_ session:EditorSession)->(Gallery,NativePanelGestureContext,NativeColorWorkflowCapture) {
            let panel=Gallery(model,session:session),workflow=NativeColorWorkflowCapture.capture(model:model,session:session,node:"n2",renderedVersion:7)!
            let context=NativePanelGestureContext.capture(model,renderedVersion:7,targetKind:"nodeQualifier",targetID:"c1",nodeID:"n2",property:"qualifier.sat.0")!
            let render=model.captureDisplayedCommittedFrame()!.context
            model.previewCapture=render;model.previewOwnershipID=render.id;model.previewOperations=[];panel.gradePreview=NativeColorDraftPreview(gesture:context,render:render)
            return (panel,context,workflow)
        }
        for composition in ["nested",nil] as [String?] {
            let (model,session,backend)=fresh();model.composition=composition;model.painted(red)
            let (panel,context,workflow)=draftPanel(model,session)
            panel.commitQualifierPreview(numeric,context:context,workflow:workflow)
            check(model.previewCapture==nil && panel.gradePreview==nil && backend.calls.isEmpty,"Numeric qualifier did not discard preview before queued commit")
            try await settle(model)
            check(backend.calls.count==1 && model.receives==1,"Numeric qualifier failed one guarded atomic commit")
            let body=backend.calls[0],operation=body.objects("ops")[0]
            check(body.number("expectedVersion")==7 && operation.string("node")=="n2" && operation.dictionary("set").dictionary("qualifier")["sat"] as? [Double]==[0.6,0.6],"Numeric qualifier changed uncaptured property/node/version")
            check(composition==nil ? operation["comp"] is NSNull:operation.string("comp")==composition,"Numeric qualifier lost explicit composition scope")
            replay.append(["project":project,"body":body])
        }
        for axis in 0..<11 {
            let (model,session,backend)=fresh(),(panel,context,workflow)=draftPanel(model,session)
            panel.commitQualifierPreview(numeric,context:context,workflow:workflow)
            switch axis {
            case 0:model.time=2
            case 1:model.generation=UUID()
            case 2:model.projectRevision=UUID()
            case 3:model.selectedIDs=["c1","other"]
            case 4:session.backend=ReelBackend()
            case 5:model.busy=true
            case 6:model.previewCapture=NativeRenderPreviewCapture(id:UUID(),generation:model.generation,revision:model.projectRevision,folder:model.folder!,version:7,composition:model.composition,selection:model.selectedIDs,time:model.time)
            case 7:model.folder=URL(fileURLWithPath:"/other")
            case 8:panel.nodeID="n3"
            case 9:model.showingSource=true
            default:model.composition=nil
            }
            try await settle(model)
            check(backend.calls.isEmpty && model.receives==0 && panel.gradePreview==nil,"Numeric qualifier accepted stale queued context axis \(axis)")
        }
        for axis in 0..<4 {
            let (model,session,backend)=fresh(),(panel,context,workflow)=draftPanel(model,session)
            backend.responder={_ in
                if axis==0 {model.time=2} else if axis==1 {model.generation=UUID()} else if axis==2 {session.backend=ReelBackend()}
                if axis==3 {return JSON(any:["version":8])}
                return JSON(any:["version":8,"project":project])
            }
            panel.commitQualifierPreview(numeric,context:context,workflow:workflow);try await settle(model)
            check(backend.calls.count==1 && model.receives==0,"Late numeric qualifier result published into changed context")
        }
        let (invalidDraft,invalidSession,invalidBackend)=fresh(),(invalidPanel,invalidContext,invalidWorkflow)=draftPanel(invalidDraft,invalidSession)
        invalidPanel.commitQualifierPreview(["lum":[0.0,1]],context:invalidContext,workflow:invalidWorkflow);try await settle(invalidDraft)
        check(invalidBackend.calls.isEmpty && invalidPanel.gradePreview==nil,"Numeric qualifier committed an uncaptured property or retained canceled preview")
        let (galleryModel,_,galleryBackend)=fresh(),gallery=Gallery(galleryModel)
        gallery.grabColorStill()
        let still=gallery.stills[0]
        check(still.provenance.context.version==7 && still.provenance.context.time==1 && still.provenance.context.composition=="nested" && still.provenance.fps==24 && still.provenance.selectedClip=="c1","Still provenance guessed playhead/project instead of committed paint")
        let redHash = try NativeColorPixelBuffer.normalized(red).hash
        check(still.provenance.projectHash.count==64 && still.hash == redHash && still.label.contains("Nested color") && still.label.contains("v7"),"Still provenance lacked actual project/pixel identity")
        check(galleryBackend.calls.isEmpty && galleryModel.receives==0 && galleryModel.version==7,"Gallery capture mutated project/history")
        gallery.compareColorStill(still)
        check(galleryModel.viewerComparison?.id==still.id && galleryModel.viewerComparisonFraction==0.5 && galleryModel.mobilePanel==nil,"Gallery did not create the real viewer wipe")
        galleryModel.version=8;galleryModel.time=2
        check(galleryModel.viewerComparisonMatches(galleryModel.viewerComparison!),"Comparison wrongly rejected intended grade/time changes")
        galleryModel.composition=nil
        check(!galleryModel.viewerComparisonMatches(galleryModel.viewerComparison!),"Comparison crossed composition provenance")
        galleryModel.viewerComparison=nil;gallery.compareColorStill(still)
        check(galleryModel.viewerComparison==nil && galleryModel.status.contains("another project"),"Gallery activated a stale composition still")
        let (waiting,_,_)=fresh(),waitingGallery=Gallery(waiting);waiting.displayedVersion=6;waitingGallery.grabColorStill()
        check(waitingGallery.stills.isEmpty && waiting.status.contains("committed frame"),"Gallery accepted a stale committed paint")
        let store=NativeColorGalleryStore()
        for _ in 0..<25 {store.append(still)}
        check(store.stills.count==24,"Session gallery count bound failed")
        let largeSnapshot=try NativeColorPixelBuffer.normalized(image(1280,1280,Array(repeating:[UInt8(128),128,128,255],count:1280*1280).flatMap {$0})).image()
        let largeStill=NativeColorGalleryStill(image:largeSnapshot,label:still.label,hash:still.hash,provenance:still.provenance)
        for _ in 0..<24 {store.append(largeStill)}
        check(store.stills.count<24 && store.stills.reduce(0,{$0+$1.image.bytesPerRow*$1.image.height})<=NativeColorPixelBuffer.maximumBytes,"Session gallery failed its retained byte cap")
        let reopened=Gallery(galleryModel)
        check(reopened.colorGallery === gallery.colorGallery && reopened.stills.first?.id==still.id,"Recreating the actual Color initializer discarded the model-owned gallery")
        store.clear();check(store.stills.isEmpty,"Project-session reset retained gallery")
        for axis in 0..<6 {
            let (model,session,_)=fresh(),panel=Gallery(model,session:session)
            panel.luts=["keep.cube"]
            model.lutReply={
                if axis==1 {session.sessionID="two"}
                if axis==2 {model.folder=URL(fileURLWithPath:"/other")}
                if axis==3 {session.backend=ReelBackend()}
                if axis==5 {model.generation=UUID()}
                return ["luts":["loaded.cube"]]
            }
            if axis==4 {let task=Task {await panel.loadColorLUTs()};task.cancel();await task.value}
            else {await panel.loadColorLUTs()}
            check(panel.luts==(axis==0 ? ["loaded.cube"]:["keep.cube"]),"Typed LUT loader accepted stale/canceled project response axis \(axis)")
            check(model.version==7 && model.receives==0,"Typed LUT loader changed project")
        }
        try JSON(any:replay).text.write(toFile:CommandLine.arguments[2],atomically:true,encoding:.utf8)
        print("Passed \(count) production pixel, qualifier, captured callback and gallery checks, including \(vectors.count) web reference colors")
    }
}
'''
    with tempfile.TemporaryDirectory(prefix='reel-color-sampling-') as directory:
        temp = Path(directory)
        vectors = temp / 'web-colors.json'
        replay = temp / 'qualifier-requests.json'
        js_vectors = '''import fs from 'node:fs';import {rgbToHsl,qualifierAround,expandQualifier} from './editor/web/ui/color/graph.js';
let seed=2137;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296};
const colors=[[1,0,0],[0,1,0],[0,0,1],[0.5,0.5,0.5],[0,0,0],[1,1,1],[1,0,0.1],[0.51,0.5,0.5]];
for(let i=0;i<256;i++)colors.push([random(),random(),random()]);
const rows=colors.map(rgb=>{const input={hue:[350,10],sat:[0.2,0.6],lum:[0.1,0.9],soft:0.17,invert:true,show:true};return {rgb,hsl:rgbToHsl(rgb),input,around:qualifierAround(rgb),expanded:expandQualifier(input,rgb)}});
fs.writeFileSync(process.argv[1],JSON.stringify(rows));'''
        subprocess.run(['node', '--input-type=module', '-e', js_vectors, str(vectors)], cwd=repo, check=True)
        swift = temp / 'SamplingChecks.swift'
        binary = temp / 'SamplingChecks'
        swift.write_text(source + fixture + checks)
        subprocess.run(['xcrun', 'swiftc', '-parse-as-library', '-module-cache-path', str(temp / 'cache'), str(swift), '-o', str(binary)], check=True)
        subprocess.run([str(binary), str(vectors), str(replay)], check=True)
        js_replay = '''import fs from 'node:fs';import assert from 'node:assert/strict';import {applyOps} from './editor/core/project.js';
const rows=JSON.parse(fs.readFileSync(process.argv[1]));
for(const row of rows){const before=structuredClone(row.project);const {project}=applyOps(before,row.body.ops);assert.deepEqual(before,row.project);assert.equal(row.body.expectedVersion,7);assert.equal(row.body.ops.length,1);const op=row.body.ops[0];const tracks=op.comp===null?project.tracks:project.comps[op.comp].tracks;const node=tracks[0].clips[0].nodes.list.find(n=>n.id==='n2');assert.equal(node.qualifier.invert,true);assert.ok(node.qualifier.hue[0]>node.qualifier.hue[1]);const untouched=op.comp===null?project.comps.nested.tracks:project.tracks;const original=op.comp===null?row.project.comps.nested.tracks:row.project.tracks;assert.deepEqual(untouched,original)}
console.log(`Passed ${rows.length} sampled qualifier requests through shared applyOps with main/nested scope and unrelated tracks preserved`);'''
        subprocess.run(['node', '--input-type=module', '-e', js_replay, str(replay)], cwd=repo, check=True)
        if args.evidence_dir:
            args.evidence_dir.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(vectors, args.evidence_dir / vectors.name)
            shutil.copyfile(replay, args.evidence_dir / replay.name)


if __name__ == '__main__':
    main()
