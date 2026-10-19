import Foundation
import CoreGraphics

@main struct ColorWindowControllerChecks {
    @MainActor static var count = 0
    @MainActor static func check(_ value: Bool, _ message: String) { precondition(value, message); count += 1 }
    @MainActor static func fixture(comp: String? = nil, portrait: Bool = false) -> (NativeEditorModel, EditorSession, NativeColorWindowController, NativeViewerGeometry.Viewport) {
        let window: [String:Any] = ["type":"circle","x":0.5,"y":0.5,"w":0.3,"h":0.3,"rotation":0.0,"softness":0.15]
        let clip:[String:Any] = ["id":"c1","kind":"shape","start":0.0,"dur":4.0,"nodes":["list":[["id":"n4","type":"corrector","window":window,"qualifier":["hue":[12,40]]]],"links":[]]]
        let tracks:[[String:Any]] = [["id":"V1","kind":"video","clips":[clip]]]
        let w=portrait ? 1080.0 : 1920.0,h=portrait ? 1920.0 : 1080.0
        let scope:[String:Any] = ["width":w,"height":h,"tracks":tracks]
        let project = NativeProject(fields:comp == nil ? scope : ["width":1920,"height":1080,"tracks":[],"comps":[comp!:scope]])
        let node:[String:Any] = ["nodeID":"n4","nodeType":"corrector","coordinateSpace":NativeColorWindowGeometry.coordinateSpace,"nodePlaneWidth":480,"nodePlaneHeight":853,"window":window]
        let record:[String:Any] = ["id":"c1","kind":"shape","width":500.0,"height":500.0,"matrix":[1.0,0,0,1,w/2,h/2],"crop":[:],"nodePlanes":["n4":node]]
        let session=EditorSession();session.backend=ReelBackend()
        let model=NativeEditorModel(session:session,project:project,geometry:JSON(any:[record]));model.composition=comp;model.displayedComposition=comp
        let controller=NativeColorWindowController(model:model,session:session,nodeID:"n4");model.viewerColorWindow=controller
        let viewport=NativeViewerGeometry.Viewport(size:CGSize(width:1000,height:1000),canvas:CGSize(width:w,height:h),scale:0.4,imageAspect:w/h)!
        controller.updateViewport(viewport)
        return (model,session,controller,viewport)
    }
    @MainActor static func queue(_ controller:NativeColorWindowController, property:String="x", value:String="0.6") -> UUID {
        let token=controller.beginNumeric()!;check(controller.previewNumeric(token:token,text:value,property:property),"Valid numeric GPU draft")
        check(controller.previewWidth==1280,"Window preview retains actual captured pixel width")
        controller.commit(token:token);return token
    }
    @MainActor static func windowType(_ model: NativeEditorModel, _ type: String) throws {
        var fields = model.project!.fields, tracks = fields.objects("tracks"), clips = tracks[0].objects("clips")
        var nodes = clips[0].dictionary("nodes"), list = nodes.objects("list"), window = list[0].dictionary("window")
        window["type"] = type; list[0]["window"] = window; nodes["list"] = list; clips[0]["nodes"] = nodes
        tracks[0]["clips"] = clips; fields["tracks"] = tracks; model.project = NativeProject(fields: fields)
        var records = try JSON.parse(model.metalFrame!.drawGeometry.text) as! [[String: Any]]
        var planes = records[0].dictionary("nodePlanes"), node = planes.dictionary("n4")
        node["window"] = window; planes["n4"] = node; records[0]["nodePlanes"] = planes
        model.metalFrame!.drawGeometry = JSON(any: records)
    }
    @MainActor static func overlayDispatchChecks() async throws {
        for type in ["circle", "rect", "none", "linear", "polygon", "unknown"] {
            let (model, _, controller, _) = fixture()
            try windowType(model, type)
            let viewer = ViewerOverlayDispatchHarness(model: model); viewer.vectorMode = "anchor"
            let supported = type == "circle" || type == "rect"
            check((controller.plane() != nil) == supported, "Actual controller plane support for \(type)")
            check(viewer.overlayDispatch() == (supported ? .colorWindow : .interaction), "Installed controller dispatch for \(type)")
            model.viewerColorPicker = 1
            check(viewer.overlayDispatch() == .interaction, "Picker takes interaction priority for installed \(type) controller")
            model.viewerColorWindow = nil
            check(viewer.overlayDispatch() == .interaction, "Picker takes interaction priority without controller and with prior vector mode")
            model.viewerColorPicker = nil
            check(viewer.overlayDispatch() == .vector, "Existing vector editing route survives absent controller")
            viewer.vectorMode = nil
            check(viewer.overlayDispatch() == .interaction, "Absent controller falls back to normal interaction")
        }
        for stale in ["frame", "disabled-node", "missing-plane", "unsupported-space", "oversized-plane", "locked"] {
            let (model, _, _, _) = fixture(), viewer = ViewerOverlayDispatchHarness(model: model)
            switch stale {
            case "frame": model.displayedVersion = 6
            case "disabled-node", "locked":
                var fields = model.project!.fields, tracks = fields.objects("tracks"), clips = tracks[0].objects("clips")
                if stale == "locked" { clips[0]["locked"] = true }
                else { var nodes = clips[0].dictionary("nodes"), list = nodes.objects("list"); list[0]["enabled"] = false; nodes["list"] = list; clips[0]["nodes"] = nodes }
                tracks[0]["clips"] = clips; fields["tracks"] = tracks; model.project = NativeProject(fields: fields)
            default:
                var records = try JSON.parse(model.metalFrame!.drawGeometry.text) as! [[String: Any]]
                var planes = records[0].dictionary("nodePlanes"), node = planes.dictionary("n4")
                if stale == "missing-plane" { planes = [:] }
                else if stale == "unsupported-space" { node["coordinateSpace"] = "unsupported"; planes["n4"] = node }
                else { node["nodePlaneWidth"] = 8193; planes["n4"] = node }
                records[0]["nodePlanes"] = planes; model.metalFrame!.drawGeometry = JSON(any: records)
            }
            check(viewer.overlayDispatch() == .interaction, "Inactive or unsupported \(stale) plane keeps normal interaction")
        }
        let (other, _, _, _) = fixture(), nonColor = ViewerOverlayDispatchHarness(model: other)
        other.panel = .edit
        check(nonColor.overlayDispatch() == .interaction, "Installed Color controller cannot intercept another panel")
        nonColor.vectorMode = "path"
        check(nonColor.overlayDispatch() == .vector, "Vector route works outside Color panel")
        let (queued, session, controller, _) = fixture(), pending = ViewerOverlayDispatchHarness(model: queued)
        _ = queue(controller)
        check(controller.plane() == nil && controller.submitting, "Queued commit has no interactive plane")
        for _ in 0..<3 { check(pending.overlayDispatch() == .interaction, "Queued plane transition restores interaction") }
        check(controller.submitting && queued.deferred.count == 1 && session.backend!.requests.isEmpty, "Dispatch preserves queued ownership")
        try await queued.flush()
        check(session.backend!.requests.count == 1 && !controller.submitting, "Queued window edit still commits once")
    }
    @MainActor static func main() async throws {
        try await overlayDispatchChecks()
        let (model,session,controller,_) = fixture(comp:"nested")
        let original=model.project!.text
        let token=queue(controller)
        check(model.project!.text==original,"Preview does not persist")
        check(model.previewOperations==nil && !model.previewing,"Preview clears before queue")
        check(controller.previewWidth==nil,"Captured pixel width clears with preview")
        check(session.backend!.requests.isEmpty,"Commit defers the write")
        controller.commit(token:token)
        check(model.deferred.count==1,"Token queues one submission")
        try await model.flush()
        check(session.backend!.requests.count==1,"One atomic submission")
        let body=session.backend!.requests[0],op=body.objects("ops")[0]
        check(body.number("expectedVersion")==7,"Captured expected version")
        check(op.string("comp")=="nested" && op.string("node")=="n4","Captured composition and node")
        check(Set(op.dictionary("set").keys)==["window"] && Set(op.dictionary("set").dictionary("window").keys)==["x"],"Partial window patch only")
        check(!controller.submitting,"Submission unlocks")
        for change in ["version","time","folder","selection","backend","session","ownership","panel","controller","clip"] {
            let (m,s,c,_)=fixture();_ = queue(c)
            switch change {
            case "version":m.version+=1
            case "time":m.time+=1
            case "folder":m.folder=URL(fileURLWithPath:"/different")
            case "selection":m.selectedIDs=[]
            case "backend":s.backend=ReelBackend()
            case "session":s.sessionID="new-session"
            case "ownership":m.previewOwnershipID=UUID()
            case "panel":m.panel = .edit
            case "controller":m.viewerColorWindow=nil
            default:
                var fields=m.project!.fields,tracks=fields.objects("tracks"),clips=tracks[0].objects("clips")
                clips[0]["locked"]=true;tracks[0]["clips"]=clips;fields["tracks"]=tracks;m.project=NativeProject(fields:fields)
            }
            do {try await m.flush()} catch {}
            check(s.backend!.requests.isEmpty,"Queued \(change) change rejects write")
        }
        let (portrait,pSession,pController,pViewport)=fixture(portrait:true)
        let center=pViewport.screen(CGPoint(x:540,y:960))
        let pointer=pController.beginPointer(point:center,viewport:pViewport,hitSize:28)!
        let rounded=NativeViewerGeometry.Viewport(size:pViewport.size,canvas:pViewport.canvas,scale:pViewport.scale,imageAspect:320.0/569)!
        check(pViewport != rounded && pViewport.layout == rounded.layout,"Portrait rounded draft has stable layout")
        pController.updateViewport(rounded)
        portrait.displayedPreviewID=pointer
        check(pController.previewPointer(token:pointer,point:CGPoint(x:center.x+5,y:center.y+2),viewport:rounded),"Own rounded portrait draft stays active")
        check(pController.geometryViewport(rounded)==pViewport,"Overlay retains capture projection")
        pController.commit(token:pointer,viewport:rounded)
        let zoomed=NativeViewerGeometry.Viewport(size:pViewport.size,canvas:pViewport.canvas,scale:0.5,imageAspect:1080.0/1920)!
        pController.updateViewport(zoomed)
        try await portrait.flush()
        check(pSession.backend!.requests.isEmpty,"Queued viewport change rejects write")
        let (foreign,_,foreignController,_)=fixture()
        let owned=foreignController.beginNumeric()!
        check(foreignController.previewWidth==1280,"Current owner keeps captured render width")
        foreign.discardRenderPreview(redraw:false)
        let replacement=foreign.beginRenderPreview(renderedVersion:foreign.version)!
        check(replacement.id != owned && foreignController.previewWidth==nil,"Foreign preview cannot keep window render width")
        let (n,_,numeric,_)=fixture();let invalid=numeric.beginNumeric()!
        check(!numeric.previewNumeric(token:invalid,text:"nan",property:"x"),"Nonfinite numeric text rejects")
        numeric.cancel(token:invalid);check(n.previewOperations==nil,"Invalid numeric cancellation restores")
        let (o,os,oc,_)=fixture();_ = queue(oc);oc.cancel();try await o.flush();check(os.backend!.requests.isEmpty,"Explicit cancellation invalidates queued token")
        let (lock,_,lc,_)=fixture();lock.selectedIDs=["c1","c2"];check(lc.beginNumeric()==nil,"Multi-selection fails closed")
        for property in ["anim","expr"] {
            let (a,_,ac,_)=fixture();var fields=a.project!.fields,tracks=fields.objects("tracks"),clips=tracks[0].objects("clips")
            clips[0][property] = ["node.n4.window.x":property=="anim" ? [["at":0,"value":0.5]] as Any : "value" as Any]
            tracks[0]["clips"]=clips;fields["tracks"]=tracks;a.project=NativeProject(fields:fields)
            check(ac.beginNumeric()==nil,"Animated or expression window fails closed")
        }
        let (late,lateSession,lateController,_)=fixture();_ = queue(lateController)
        lateSession.backend!.beforeReply = { lateSession.sessionID="replaced" }
        do {try await late.flush()} catch {}
        check(lateSession.backend!.requests.count==1 && late.version==7,"Late session reply cannot replace the editor project")
        print("Passed \(count) production controller and preview-ownership checks.")
    }
}
