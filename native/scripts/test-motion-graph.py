#!/usr/bin/env python3
"""Check production native motion math and operation builders against the shared core.

The extracted Swift helpers are the implementations used by NativeMotionPanel.
These checks run the production graph event methods without launching SwiftUI.
"""
from pathlib import Path
import json
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PANEL = ROOT / 'native/App/Shared/NativeEditor/NativeMotionPanel.swift'

HARNESS = r'''
import Foundation
func require(_ value: Bool, _ message: String) { if !value { fatalError(message) } }
@main struct MotionChecks {
    @MainActor static func main() async throws {
        let a = NativeMotionKey(property:"x", index:0, at:1, value:100, ease:[0.25,0.1,0.75,0.9])
        let b = NativeMotionKey(property:"x", index:1, at:3, value:500, ease:nil)
        let h = NativeMotionMath.handles(a,b,flat:1)
        require(h.out.x == 1.5 && h.out.y == 140 && h.incoming.x == 2.5 && h.incoming.y == 460, "Value handles must use segment-local units")
        let zero = NativeMotionKey(property:"x",index:0,at:0.234567,value:0.123456789,ease:[0.2,0.1,0.8,0.9])
        let other = NativeMotionKey(property:"y",index:0,at:1,value:30,ease:"hold")
        let selected:Set<NativeMotionKeyRef> = [zero.ref,other.ref]
        let valueOnly = NativeMotionOperations.move(keys:[zero,other], selected:selected,id:"c1",deltaTime:0,deltaValue:5,valueProperty:"x",duration:4,fps:30)
        require(valueOnly.ops[2]["at"] as? Double == zero.at, "Value edits must preserve off-frame key times")
        require(valueOnly.ops[3]["value"] as? Double == other.value, "Value edits must not change another property's units")
        let timeOnly = NativeMotionOperations.move(keys:[zero], selected:[zero.ref],id:"c1",deltaTime:0.5,deltaValue:0,valueProperty:nil,duration:4,fps:30)
        require(timeOnly.ops[1]["value"] as? Double == zero.value, "Time edits must preserve exact stored key values")
        for invalid in [Double.nan,Double.infinity,-Double.infinity] {
            require(NativeMotionOperations.move(keys:[zero],selected:[zero.ref],id:"c1",deltaTime:invalid,deltaValue:0,valueProperty:nil,duration:4,fps:30).ops.isEmpty,"Invalid moves must not emit operations")
        }
        let folder=URL(fileURLWithPath:"/tmp/project-a"), capture=NativeMotionEditCapture(folder:folder,version:7,composition:"k1",layerID:"c1",property:"x",selection:selected)
        require(capture.matches(folder:folder,version:7,composition:"k1",layerID:"c1",property:"x",selection:selected),"Unchanged capture must match")
        require(!capture.matches(folder:URL(fileURLWithPath:"/tmp/project-b"),version:7,composition:"k1",layerID:"c1",property:"x",selection:selected),"Changed folders must reject")
        require(!capture.matches(folder:folder,version:8,composition:"k1",layerID:"c1",property:"x",selection:selected),"Intervening edits must reject")
        require(!capture.matches(folder:folder,version:7,composition:"k2",layerID:"c1",property:"x",selection:selected),"Changed compositions must reject")
        require(!capture.matches(folder:folder,version:7,composition:"k1",layerID:"c2",property:"x",selection:selected),"Changed layers must reject")
        require(!capture.matches(folder:folder,version:7,composition:"k1",layerID:"c1",property:"y",selection:selected),"Changed properties must reject")
        require(!capture.matches(folder:folder,version:7,composition:"k1",layerID:"c1",property:"x",selection:[zero.ref]),"Changed key selections must reject")
        let eases:[Any] = NativeMotionKey.eases + [[0.3,-0.2,0.6,1.3],[0,0.2,1,0.8],[1,0,0,1],[0,0,1,1]]
        var samples:[[String:Any]]=[]
        for ease in eases {
            let first=NativeMotionKey(property:"x",index:0,at:1,value:100,ease:ease)
            let list=[first,b]
            let points=NativeMotionMath.handles(first,b,flat:1)
            let endpoints=NativeMotionMath.endpointSpeeds(first,b)
            let outgoing=NativeMotionMath.draggedHandle(first,b,incoming:false,point:CGPoint(x:1.8,y:30),flat:1)
            let incoming=NativeMotionMath.draggedHandle(first,b,incoming:true,point:CGPoint(x:2.4,y:650),flat:1)
            let speedOut=NativeMotionMath.draggedSpeed(first,b,incoming:false,point:CGPoint(x:2,y:100))
            let speedIn=NativeMotionMath.draggedSpeed(first,b,incoming:true,point:CGPoint(x:2.2,y:250))
            samples.append(["ease":ease,"progress":(0...100).map{NativeMotionMath.progress(ease,Double($0)/100)},"speeds":(0...48).map{NativeMotionMath.speed(list,segment:0,fraction:Double($0)/48)},"handles":[points.out.x,points.out.y,points.incoming.x,points.incoming.y],"endpoints":[endpoints.out,endpoints.incoming],"dragOut":outgoing,"dragIn":incoming,"speedOut":speedOut,"speedIn":speedIn])
        }
        let x1=NativeMotionKey(property:"x",index:0,at:0.5,value:100,ease:[0.2,0.1,0.8,0.9])
        let x2=NativeMotionKey(property:"x",index:1,at:2,value:300,ease:nil)
        let y1=NativeMotionKey(property:"y",index:0,at:0.5,value:10,ease:"hold")
        let moved=NativeMotionOperations.move(keys:[x1,x2,y1],selected:[x1.ref,y1.ref],id:"c1",deltaTime:1.5,deltaValue:0,valueProperty:nil,duration:4,fps:30)
        let clamped=NativeMotionOperations.move(keys:[x1,x2,y1],selected:[x1.ref,x2.ref,y1.ref],id:"c1",deltaTime:10,deltaValue:0,valueProperty:nil,duration:4,fps:30)
        let layout=NativeMotionGraphLayout(keys:[a,b],duration:4,mode:.value)
        let graphRect=CGRect(x:42,y:12,width:200,height:160)
        let graphPoint=CGPoint(x:2,y:300)
        let roundTrip=layout.value(layout.position(graphPoint,in:graphRect),in:graphRect)
        require(abs(roundTrip.x-graphPoint.x)<1e-9 && abs(roundTrip.y-graphPoint.y)<1e-9,"Graph coordinates must round trip in actual property units")
        let hold=NativeMotionKey(property:"x",index:0,at:1,value:100,ease:"hold")
        let holdPoints=NativeMotionGraphLayout.curves([hold,b],start:0,end:4,mode:.value).flatMap{$0}
        require(holdPoints.contains{$0.x==3 && $0.y==100} && holdPoints.contains{$0.x==3 && $0.y==500},"The value graph must draw the actual hold jump")
        let speedPoints=NativeMotionGraphLayout.curves([hold,b],start:0,end:4,mode:.speed).flatMap{$0}
        require(speedPoints.allSatisfy{$0.y==0},"The speed graph must not invent a finite hold jump speed")
        var hitChecks=0
        func hitCheck(_ condition:Bool,_ message:String) { require(condition,message);hitChecks += 1 }
        let collisions:[(Any?,Bool)] = [("linear",false),("linear",true),(nil,false),(nil,true),("in",true),("out",false)]
        for mode in [NativeMotionGraphMode.value,.speed] {
            for (ease,incoming) in collisions {
                let first=NativeMotionKey(property:"x",index:0,at:1,value:100,ease:ease)
                let keys=[first,b], selected=incoming ? b : first
                let layout=NativeMotionGraphLayout(keys:keys,duration:4,mode:mode)
                let graph=MotionGraphHarness(keys:keys,mode:mode,selection:[selected.ref])
                let handle=graph.handles(keys,layout:layout).first { $0.incoming == incoming }!
                let point=layout.position(handle.point,in:graphRect)
                hitCheck(graph.markers(keys,layout:layout).contains { hypot(layout.position($0.1,in:graphRect).x-point.x,layout.position($0.1,in:graphRect).y-point.y)<1e-9 },"The regression must test a tangent that actually coincides with a key marker")
                graph.start(at:point,rect:graphRect,layout:layout)
                if let active=graph.drag,case let .handle(segment,side)=active.kind {
                    hitCheck(segment == 0 && side == incoming,"A coincident tangent must capture the correct segment and side")
                    hitCheck(active.capture.selection == [selected.ref],"Handle start must preserve the existing selected key context")
                } else { fatalError("A visible selected tangent must win over its coincident key in \(mode.rawValue)") }
                hitCheck(graph.beginCount == 1 && graph.selectCount == 0,"Tangent start must capture once and must not reselect or seek the key")
                hitCheck(graph.attempted && graph.keyHit,"A tangent hit must prevent the gesture from falling through to scrubbing")
            }
            let keys=[a,b], layout=NativeMotionGraphLayout(keys:keys,duration:4,mode:mode)
            let unselected=MotionGraphHarness(keys:keys,mode:mode,selection:[])
            let point=layout.position(unselected.markers(keys,layout:layout)[0].1,in:graphRect)
            unselected.start(at:point,rect:graphRect,layout:layout)
            hitCheck(unselected.selectCount == 1 && unselected.selection == [a.ref],"An unselected key must remain selectable")
            if mode == .value {
                if let active=unselected.drag,case .key(a.ref)=active.kind { hitCheck(unselected.beginCount == 1,"Value key movement must still capture once") }
                else { fatalError("An unselected value key must remain movable") }
            } else { hitCheck(unselected.drag == nil && unselected.beginCount == 0,"Speed markers select a key without creating value-key movement") }
            let outside=MotionGraphHarness(keys:keys,mode:mode,selection:[a.ref])
            outside.start(at:CGPoint(x:-100,y:-100),rect:graphRect,layout:layout)
            hitCheck(!outside.keyHit && outside.drag == nil && outside.beginCount == 0,"Empty graph space must remain available for scrubbing")

            let linear=NativeMotionKey(property:"x",index:0,at:1,value:100,ease:"linear")
            let linearKeys=[linear,b], linearLayout=NativeMotionGraphLayout(keys:linearKeys,duration:4,mode:mode)
            for additive in [false,true] {
                let graph=MotionGraphHarness(keys:linearKeys,mode:mode,selection:[linear.ref])
                graph.selectingKeys = !additive; NativeMotionModifiers.additive = additive
                let point=linearLayout.position(graph.markers(linearKeys,layout:linearLayout)[0].1,in:graphRect)
                graph.start(at:point,rect:graphRect,layout:linearLayout)
                NativeMotionModifiers.additive = false
                hitCheck(graph.selectCount == 1 && graph.selection.isEmpty,"Shift and Select multiple must retain key-first toggle selection at a coincident handle")
                hitCheck(graph.drag == nil,"Removing a selected key must not accidentally begin an easing drag")
            }
            for editable in [false,true] {
                let graph=MotionGraphHarness(keys:linearKeys,mode:mode,selection:[linear.ref])
                graph.editable=editable;graph.acceptsCapture=false
                let point=linearLayout.position(graph.handles(linearKeys,layout:linearLayout)[0].point,in:graphRect)
                graph.start(at:point,rect:graphRect,layout:linearLayout)
                hitCheck(graph.drag == nil && graph.selectCount == 0 && graph.keyHit,"Read-only or rejected handle capture must not move or reselect the coincident key")
                hitCheck(graph.beginCount == (editable ? 1 : 0),"Locked handle hits must not attempt an edit capture")
            }
            let held=MotionGraphHarness(keys:[hold,b],mode:mode,selection:[hold.ref])
            let heldLayout=NativeMotionGraphLayout(keys:[hold,b],duration:4,mode:mode)
            hitCheck(held.handles([hold,b],layout:heldLayout).isEmpty,"Hold easing must expose no tangent")
            held.start(at:heldLayout.position(held.markers([hold,b],layout:heldLayout)[0].1,in:graphRect),rect:graphRect,layout:heldLayout)
            hitCheck(held.selectCount == 1,"A selected hold key must remain a key hit")

            let narrow=CGRect(x:42,y:12,width:16,height:160)
            let closest=MotionGraphHarness(keys:linearKeys,mode:mode,selection:[linear.ref,b.ref])
            let incoming=closest.handles(linearKeys,layout:linearLayout).first { $0.incoming }!
            closest.start(at:linearLayout.position(incoming.point,in:narrow),rect:narrow,layout:linearLayout)
            if let active=closest.drag,case let .handle(segment,side)=active.kind { hitCheck(segment == 0 && side,"Nearby tangents must choose the nearest visible handle") }
            else { fatalError("A close incoming tangent must remain reachable") }
        }
        var eventChecks=0
        func eventCheck(_ condition:Bool,_ message:String) { require(condition,message);eventChecks += 1 }
        for mode in [NativeMotionGraphMode.value,.speed] {
            for incoming in [false,true] {
                let easingCases:[Any?] = [nil,"linear","smooth",[0.25,0.1,0.75,0.9]]
                for easing in easingCases {
                    let first=NativeMotionKey(property:"x",index:0,at:1,value:100,ease:easing)
                    let keys=[first,b], selected=incoming ? b : first
                    let graph=MotionGraphHarness(keys:keys,mode:mode,selection:[selected.ref])
                    let layout=NativeMotionGraphLayout(keys:keys,duration:4,mode:mode)
                    let handle=graph.handles(keys,layout:layout).first { $0.incoming == incoming }!
                    let origin=layout.position(handle.point,in:graphRect)
                    graph.changeGraphDrag(start:origin,location:origin,translation:.zero,rect:graphRect,layout:layout)
                    graph.changeGraphDrag(start:origin,location:CGPoint(x:origin.x+1,y:origin.y),translation:CGSize(width:1,height:0),rect:graphRect,layout:layout)
                    eventCheck(graph.previewEases.isEmpty,"Initial subthreshold tangent events must not edit")
                    graph.changeGraphDrag(start:origin,location:CGPoint(x:origin.x+20,y:origin.y-15),translation:CGSize(width:20,height:-15),rect:graphRect,layout:layout)
                    eventCheck(graph.drag?.hasMoved == true && graph.drag?.easing != nil,"Tangent movement must populate the production event state")
                    graph.changeGraphDrag(start:origin,location:origin,translation:.zero,rect:graphRect,layout:layout)
                    eventCheck(graph.drag?.easing == nil,"Returning a tangent to its pointer origin must clear the previous easing")
                    eventCheck(NativeMotionMath.bezier(graph.previewEases.last) == NativeMotionMath.bezier(easing),"Returning a tangent must restore its captured curve preview")
                    graph.finishGraphDrag()
                    eventCheck(graph.easeCommits.isEmpty && graph.endCount == 1,"A tangent released at its origin must end without committing")
                    eventCheck(graph.drag == nil && !graph.attempted && !graph.keyHit,"Finishing must clear the graph event state")
                }
            }
        }
        for terminalOnly in [false,true] {
            let graph=MotionGraphHarness(keys:[a,b],mode:.value,selection:[])
            let layout=NativeMotionGraphLayout(keys:[a,b],duration:4,mode:.value)
            let origin=layout.position(CGPoint(x:a.at,y:a.value),in:graphRect)
            graph.changeGraphDrag(start:origin,location:origin,translation:.zero,rect:graphRect,layout:layout)
            graph.changeGraphDrag(start:origin,location:CGPoint(x:origin.x+1,y:origin.y),translation:CGSize(width:1,height:0),rect:graphRect,layout:layout)
            eventCheck(graph.previewMoves.isEmpty,"Initial subthreshold key events must not edit")
            graph.changeGraphDrag(start:origin,location:CGPoint(x:origin.x+20,y:origin.y-15),translation:CGSize(width:20,height:-15),rect:graphRect,layout:layout)
            eventCheck(graph.previewMoves.count == 1 && graph.drag?.hasMoved == true,"Moving a key must populate the production event state")
            if !terminalOnly {
                graph.changeGraphDrag(start:origin,location:CGPoint(x:origin.x+1,y:origin.y),translation:CGSize(width:1,height:0),rect:graphRect,layout:layout)
                eventCheck(abs(graph.drag!.deltaTime-1/Double(graphRect.width)*(layout.timeEnd-layout.timeStart))<1e-9,"A subthreshold return after movement must update the key delta")
            }
            graph.changeGraphDrag(start:origin,location:origin,translation:.zero,rect:graphRect,layout:layout)
            graph.finishGraphDrag()
            eventCheck(graph.previewMoves.last!.0 == 0 && graph.previewMoves.last!.1 == 0,"The terminal pointer event must restore the original key preview")
            eventCheck(graph.moveCommits.isEmpty && graph.endCount == 1,"A key released at its origin must end without committing")
        }
        let model=MotionModel(), panel=MotionHarness(model)
        model.folder=folder; model.version=7; model.composition="k1"; model.selectedID="c1"; panel.keySelection=selected
        let guarded=panel.captureMotion(MotionClip(id:"c1",start:1),property:"x",renderedVersion:7)!
        panel.commitMotion(moved.ops,context:guarded)
        require(model.queued.count == 1,"A valid batch must queue once")
        try await model.queued.removeFirst()()
        require(model.calls.count == 1 && model.calls[0]["expectedVersion"] as? Int == 7,"The batch must retain its captured version")
        require((model.calls[0]["ops"] as! [[String:Any]]).allSatisfy{$0["comp"] as? String == "k1"},"The batch must scope every operation to its captured composition")
        model.calls=[]
        for axis in 0..<6 {
            model.version=7; model.folder=folder; model.composition="k1"; model.selectedID="c1"; panel.property="x"; panel.keySelection=selected
            panel.commitMotion(moved.ops,context:guarded)
            require(model.queued.count == 1,"A valid batch must queue before a dispatch race")
            switch axis {
            case 0: model.version=8
            case 1: model.folder=URL(fileURLWithPath:"/tmp/project-b")
            case 2: model.composition="k2"
            case 3: model.selectedID="c2"
            case 4: panel.property="y"
            default: panel.keySelection=[zero.ref]
            }
            try await model.queued.removeFirst()()
            require(model.calls.isEmpty,"A dispatch-time context change must reject before the request")
            panel.commitMotion(moved.ops,context:guarded)
            require(model.queued.isEmpty,"A stale context must reject before queueing")
        }
        model.version=8; model.selectedID="c1"; model.folder=folder; panel.property="x"
        require(panel.captureMotion(MotionClip(id:"c1",start:1),property:"x",renderedVersion:7)==nil,"An old displayed version must reject at capture")
        let output:[String:Any] = ["samples":samples,"move":moved.ops,"clamp":clamped.ops,"valueOnly":valueOnly.ops,"timeOnly":timeOnly.ops,"hitChecks":hitChecks,"eventChecks":eventChecks]
        let data=try JSONSerialization.data(withJSONObject:output,options:[.sortedKeys])
        print(String(decoding:data,as:UTF8.self))
    }
}
'''
NODE = r'''
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
registerHooks({ resolve(spec,ctx,next) { return next(spec.startsWith('/core/') ? new URL('.'+spec, new URL('./editor/',import.meta.url)).href : spec,ctx) } })
const core=await import('./editor/core/project.js')
const ease=await import('./editor/web/ui/motion/ease.js')
const actual=JSON.parse(readFileSync(0,'utf8'))
let assertions=0
const close=(a,b,message)=>{assert.ok(Math.abs(a-b)<1e-7 || Math.abs(a-b)<Math.abs(b)*1e-9, `${message}: ${a} vs ${b}`);assertions++}
const equal=(a,b,message)=>{assert.deepEqual(a,b,message);assertions++}
for(const s of actual.samples) {
  s.progress.forEach((v,i)=>close(v,core.ease(s.ease,i/100),'progress parity'))
  const a=[1,100,s.ease],b=[3,500]
  const view={...core.newProject('graph'),width:1920,height:1080}
  const clip={start:0,anim:{x:[a,b]}}
  s.speeds.forEach((v,i)=>{const u=i/48,lo=Math.max(0,u-.002),hi=Math.min(1,u+.002);const expected=s.ease==='hold'?0:(core.valueAt(view,clip,'x',1+hi*2)-core.valueAt(view,clip,'x',1+lo*2))/((hi-lo)*2||1e-9);close(v,expected,'speed parity')})
  const handles=ease.handlesOf(a,b,s.ease)
  equal(s.handles,[...handles.out,...handles.in],'value handle parity')
  const speeds=ease.segmentSpeeds(a,b,s.ease)
  equal(s.endpoints,[speeds.out,speeds.in],'endpoint speed parity')
  equal(s.dragOut,ease.dragHandle(a,b,s.ease,'out',[1.8,30]),'outgoing handle mutation parity')
  equal(s.dragIn,ease.dragHandle(a,b,s.ease,'in',[2.4,650]),'incoming handle mutation parity')
  equal(s.speedOut,ease.bezierFromSpeed(a,b,s.ease,'out',.5,100),'outgoing speed mutation parity')
  equal(s.speedIn,ease.bezierFromSpeed(a,b,s.ease,'in',.4,250),'incoming speed mutation parity')
}
let p=core.applyOps(core.newProject('ops'),[{op:'add_comp',name:'Comp',duration:5},{op:'add_shape',comp:'k1',track:'V1',start:1,dur:4}]).project
p=core.applyOps(p,[{op:'keyframe',id:'c1',prop:'x',at:.5,local:true,value:100,ease:[.2,.1,.8,.9]},{op:'keyframe',id:'c1',prop:'x',at:2,local:true,value:300},{op:'keyframe',id:'c1',prop:'y',at:.5,local:true,value:10,ease:'hold'}]).project
const scoped=ops=>ops.map(op=>({...op,comp:'k1'}))
const moved=core.applyOps(p,scoped(actual.move)).project
const c=core.findClip(moved,'c1').clip
equal(c.anim.x,[[2,100,[.2,.1,.8,.9]]],'group collision must replace the unselected destination')
equal(c.anim.y,[[2,10,'hold']],'group move must preserve each property and easing')
const clamped=core.findClip(core.applyOps(p,scoped(actual.clamp)).project,'c1').clip
equal(clamped.anim.x,[[4,300]],'clamped selected-key collisions must follow shared operation ordering')
equal(clamped.anim.y,[[4,10,'hold']],'group clamp must preserve hold')
assert.ok(actual.move.slice(0,2).every(op=>op.remove));assertions++
assert.ok(actual.move.slice(2).every(op=>!op.remove&&op.local===true));assertions++
console.log(`Passed ${assertions} Swift/shared-core parity assertions, ${actual.hitChecks} production graph hit-selection checks, ${actual.eventChecks} production graph event checks and Swift production guard/value-preservation checks.`)
'''


def main():
    text=PANEL.read_text()
    start=text.index('private struct NativeMotionKeyRef:')
    end=text.index('// End production motion helpers.')
    helpers=text[start:end].replace('private struct ','struct ').replace('private enum ','enum ')
    def declaration(marker, search_start=0):
        start=text.index(marker,search_start); position=text.index('{',start)+1; depth=1
        while depth:
            if text[position]=='{': depth+=1
            elif text[position]=='}': depth-=1
            position+=1
        return text[start:position].replace('private func ','func ').replace('NativeClip','MotionClip')
    graph_layout=declaration('private enum NativeMotionGraphMode:').replace('private enum ','enum ')+'\n'+declaration('private struct NativeMotionGraphLayout').replace('private struct ','struct ')
    graph_layout += '\n'+declaration('private struct NativeMotionGraphHandle').replace('private struct ','struct ')
    graph_layout += '\n'+declaration('private struct NativeMotionGraphDrag').replace('private struct ','struct ')
    graph_start=text.index('private struct NativeMotionGraph:')
    graph_methods='\n'.join(declaration(marker,graph_start) for marker in ['private func markers(', 'private func handles(', 'private func start(at point:', 'private func changeGraphDrag(', 'private func finishGraphDrag(', 'private func clear(cancelled:'])
    assert 'if cancelled, let drag' in declaration('private func clear(cancelled:',graph_start)
    graph_body=text[graph_start:text.index('    private func changeGraphDrag(',graph_start)]
    changed,ended=graph_body.split('}.onEnded { value in',1)
    assert 'changeGraphDrag(start: value.startLocation, location: value.location, translation: value.translation, rect: rect, layout: layout)' in changed
    assert 'changeGraphDrag(start: value.startLocation, location: value.location, translation: value.translation, rect: rect, layout: layout)' in ended
    assert ended.index('changeGraphDrag(') < ended.index('finishGraphDrag()')
    guards='\n'.join(declaration(marker) for marker in ['private func captureMotion(', 'private func matchesMotion(', 'private func commitMotion('])
    fixture=r"""
struct MotionClip { let id:String; let start:Double; var duration:Double { 4 } }
@MainActor final class MotionModel {
    var folder:URL?; var version=7; var composition:String?; var selectedID:String?; var status=""
    var time=0.0
    func scrub(_ at:Double,finished:Bool=false) { time=at }
    var selected:MotionClip? { selectedID.map { MotionClip(id:$0,start:1) } }
    var queued:[@MainActor () async throws -> Void]=[]
    var calls:[[String:Any]]=[]
    func perform(_ action:@escaping @MainActor () async throws -> Void) { queued.append(action) }
    func call(_ path:String,_ body:[String:Any]) async throws -> [String:Any] { calls.append(body); return [:] }
    func seek(_ at:Double) {}
}
@MainActor func nativeGestureRetry(_ model:MotionModel) { model.status="Retry" }
@MainActor final class MotionHarness {
    let model:MotionModel; var property="x"; var keySelection=Set<NativeMotionKeyRef>(); var selectedKeyTime:Double?
    init(_ model:MotionModel) { self.model=model }
    func isLocked(_ clip:MotionClip)->Bool { false }
"""+guards+'\n}\n'+r"""
@MainActor enum NativeMotionModifiers { static var additive=false }
@MainActor final class MotionGraphHarness {
    let keys:[NativeMotionKey],mode:NativeMotionGraphMode
    var selection:Set<NativeMotionKeyRef>
    var editable=true,selectingKeys=false,acceptsCapture=true,attempted=false,keyHit=false
    var drag:NativeMotionGraphDrag?
    var beginCount=0,selectCount=0,endCount=0
    let model=MotionModel(),clip=MotionClip(id:"c1",start:0)
    var previewMoves:[(Double,Double)]=[],moveCommits:[(Double,Double)]=[]
    var previewEases:[Any]=[],easeCommits:[Any]=[]
    func previewMove(_ time:Double,_ value:Double,_ capture:NativeMotionEditCapture) { previewMoves.append((time,value)) }
    func previewEase(_ index:Int,_ easing:Any,_ capture:NativeMotionEditCapture) { previewEases.append(easing) }
    func move(_ time:Double,_ value:Double,_ capture:NativeMotionEditCapture) { moveCommits.append((time,value)) }
    func ease(_ index:Int,_ easing:Any,_ capture:NativeMotionEditCapture) { easeCommits.append(easing) }
    func end(_ capture:NativeMotionEditCapture?) { endCount += 1 }
    init(keys:[NativeMotionKey],mode:NativeMotionGraphMode,selection:Set<NativeMotionKeyRef>) { self.keys=keys;self.mode=mode;self.selection=selection }
    func select(_ key:NativeMotionKey) {
        selectCount += 1
        if selectingKeys || NativeMotionModifiers.additive { if !selection.insert(key.ref).inserted { selection.remove(key.ref) } }
        else { selection=[key.ref] }
    }
    func begin(_ movingKeys:Bool)->NativeMotionEditCapture? {
        beginCount += 1
        guard acceptsCapture else { return nil }
        return NativeMotionEditCapture(folder:URL(fileURLWithPath:"/fixture"),version:7,composition:"k1",layerID:"c1",property:"x",selection:selection)
    }
"""+graph_methods+'\n}\n'
    with tempfile.TemporaryDirectory(prefix='reel-motion-graph-') as directory:
        temporary=Path(directory)
        source=temporary/'MotionGraph.swift'
        binary=temporary/'motion-graph'
        source.write_text('import Foundation\nimport CoreGraphics\n'+helpers+graph_layout+fixture+HARNESS)
        subprocess.run(['swiftc','-parse-as-library','-module-cache-path',str(temporary/'module-cache'),str(source),'-o',str(binary)],check=True,cwd=ROOT)
        result=subprocess.run([str(binary)],text=True,capture_output=True,cwd=ROOT)
        if result.returncode:
            print(result.stderr,file=sys.stderr)
            raise SystemExit(result.returncode)
        json.loads(result.stdout)
        subprocess.run(['node','--input-type=module','-e',NODE],input=result.stdout,text=True,check=True,cwd=ROOT)


if __name__=='__main__':
    main()
