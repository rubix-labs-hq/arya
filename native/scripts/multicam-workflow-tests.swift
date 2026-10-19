import Foundation
var checks = 0
func check(_ value: @autoclosure () -> Bool, _ message: String) { checks += 1; if !value() { fatalError(message) } }
func near(_ value: Double, _ expected: Double, _ message: String) { check(abs(value - expected) < 0.00001, message) }
func fails(_ message: String, _ action: () throws -> Void) { checks += 1; do { try action(); fatalError("Expected rejection: \(message)") } catch {} }
func n(_ fields: [String:Any], _ key: String, _ fallback: Double = 0) -> Double { NativeMulticamPlanning.number(fields,key,fallback) }
let context = "01234567-89AB-CDEF-0123-456789ABCDEF"
let assets: [String:Any] = ["a.mp4":["duration":20,"hasVideo":true,"hasAudio":true],"b.mp4":["duration":18.01,"hasVideo":true,"hasAudio":true]]
let original:[String:Any] = ["id":"c1","kind":"video","src":"a.mp4","start":0,"dur":20,"in":0]
let fields:[String:Any] = ["name":"test","version":3,"fps":30,"width":1920,"height":1080,"markers":[],"range":NSNull(),"assets":assets,
    "tracks":[["id":"V1","kind":"video","clips":[original]],["id":"A1","kind":"audio","clips":[]]],
    "comps":["nested":["fps":24,"width":1280,"height":720,"tracks":[["id":"V1","kind":"video","clips":[["id":"c15","kind":"video","src":"a.mp4","start":0,"dur":2,"in":0]]],["id":"A1","kind":"audio","clips":[]]]]]]
let files = ["a.mp4":["path":"/fixture/a.mp4","inode":"1844674407370955","size":"20"],"b.mp4":["path":"/fixture/b.mp4","inode":"4","size":"30"]]
func capture(_ project:[String:Any] = fields, comp:String? = nil, target:String? = nil) throws -> NativeMulticamPlanning.Capture {
    try .init(fields:project,folder:"/fixture",composition:comp,version:4,context:context,selection:[],sources:["a.mp4","b.mp4"],target:target,files:files)
}
let creation = try capture()
let body = try creation.syncRequest()
check(body["wait"] as? Bool == false && body["comp"] is NSNull,"Sync is a persistent explicit-main request")
check((body["expectedVersion"] as? NSNumber)?.intValue==4,"Sync freezes version")
check(body["uiMulticamCapture"] is [String:Any],"Job keeps immutable captured project context")
let sync = try NativeMulticamPlanning.Sync(result:["offsets":[0,2],"confidence":[1,0.8],"sharpness":[1,0.2],"warnings":["ambiguous"]],count:2)
check(sync.offsets==[0,2] && sync.warnings==["ambiguous"],"Sync offsets and warnings remain explicit")
fails("NaN offsets") { _ = try NativeMulticamPlanning.Sync(result:["offsets":[Double.nan,2],"confidence":[1,1],"sharpness":[1,1]],count:2) }
fails("Incomplete offsets") { _ = try NativeMulticamPlanning.Sync(result:["offsets":[0],"confidence":[1,1],"sharpness":[1,1]],count:2) }
fails("Missing confidence") { _ = try NativeMulticamPlanning.Sync(result:["offsets":[0,2]],count:2) }
func matches(_ project:[String:Any]=fields,folder:String="/fixture",comp:String?=nil,version:Int=4,context:String=context,selection:Set<String>=[],files:[String:[String:String]]=files) -> Bool {
    creation.matches(fields:project,folder:folder,composition:comp,version:version,context:context,selection:selection,files:files)
}
check(matches(),"Exact project capture matches")
check(!matches(folder:"/other"),"Folder change rejected")
check(!matches(comp:"nested"),"Composition change rejected")
check(!matches(version:5),"Version change rejected")
check(!matches(context:UUID().uuidString),"Reopened backend context rejected")
check(!matches(selection:["c1"]),"Selection change rejected")
var renamed=fields;renamed["name"]="changed";check(!matches(renamed),"Whole project metadata drift rejected")
var replaced=files;replaced["b.mp4"]=["inode":"5"];check(!matches(files:replaced),"Any source file replacement rejected")
let restored = try NativeMulticamPlanning.Capture(record:creation.record)
let restoredData = try NativeMulticamPlanning.data(restored.record), originalData = try NativeMulticamPlanning.data(creation.record)
check(restoredData==originalData,"Capture round trips without integer loss")
var noAudio=fields;var silentAssets=assets;silentAssets["b.mp4"]=["duration":18,"hasVideo":true,"hasAudio":false];noAudio["assets"]=silentAssets
let silent = try capture(noAudio)
fails("Sync needs audio in every source") { _ = try silent.syncRequest() }
fails("Chosen audio angle has no audio") { _ = try silent.creation(fields:noAudio,offsets:[0,0],at:10,audioAngle:1) }
_ = try silent.creation(fields:noAudio,offsets:[0,0],at:10,audioAngle:nil)
fails("No overlap") { _ = try creation.creation(fields:fields,offsets:[0,100],at:10,audioAngle:0) }
fails("Negative offset") { _ = try creation.creation(fields:fields,offsets:[-1,0],at:10,audioAngle:0) }
fails("Nonfinite playhead") { _ = try creation.creation(fields:fields,offsets:[0,0],at:.infinity,audioAngle:0) }
let mainBatch = try creation.commitBody([["op":"make_multicam","comp":NSNull()]],summary:"Create")
check(mainBatch["returnProject"] as? Bool==true && mainBatch["who"] as? String=="you","Atomic commit uses normal user history and returns committed project")
check((mainBatch["expectedVersion"] as? NSNumber)?.intValue==4,"Queued atomic commit freezes expected version")
fails("Unscoped commit") { _ = try creation.commitBody([["op":"make_multicam"]],summary:"Create") }
fails("Wrong composition commit") { _ = try creation.commitBody([["op":"make_multicam","comp":"nested"]],summary:"Create") }
fails("Oversized atomic batch") { _ = try creation.commitBody(Array(repeating:["op":"marker","comp":NSNull()],count:65),summary:"Create") }
check(!creation.matches(fields:fields,folder:"/fixture",composition:nil,version:4,context:context,selection:[],primary:"c1",files:files),"Primary selection change is rejected even with the same selected set")
let core = try ReelCore(scriptURL:URL(fileURLWithPath:CommandLine.arguments[1]))
func apply(_ project:[String:Any], _ ops:[[String:Any]]) throws -> (fields:[String:Any], created:[String]) {
    let result = try core.applyOps(project:JSON(any:project).text,ops:JSON(any:ops).text)
    return (try JSON.parse(result.project) as! [String:Any],try JSON.parse(result.created) as! [String])
}
for comp in [nil,"nested"] as [String?] {
    let capture=try capture(comp:comp), base=try capture.creation(fields:fields,offsets:[0,2],at:10.01,audioAngle:0)
    let dry=try apply(fields,base)
    let ops=try capture.finishCreation(base,created:dry.created,withAudio:true)
    let committed=try apply(fields,ops).fields
    let scope=comp.map { (committed["comps"] as! [String:Any])[$0] as! [String:Any] } ?? committed
    let tracks=scope["tracks"] as! [[String:Any]], clips=tracks.flatMap { $0["clips"] as! [[String:Any]] }
    let mc=clips.first { $0["kind"] as? String=="multicam" }!, audio=clips.first { $0["kind"] as? String=="audio" }!
    check(mc["id"] as? String=="c16" && audio["id"] as? String=="c17","Bundled core dry run yields exact globally unique IDs")
    check(mc["link"] as? String==audio["link"] as? String && mc["mute"] as? Bool==true,"Multicam and audio link atomically without double audio")
    near(n(mc,"dur"),floor(16.01*capture.fps)/capture.fps,"Creation floors overlap to safe complete frames")
    check(clips.contains { $0["id"] as? String==(comp==nil ? "c1":"c15") },"Creation preserves original selected clips")
    if comp != nil { let committedTracks = try NativeMulticamPlanning.data(["tracks":committed["tracks"]!]), originalTracks = try NativeMulticamPlanning.data(["tracks":fields["tracks"]!]); check(committedTracks==originalTracks,"Nested creation leaves main unchanged") }
    check(base.allSatisfy { ($0["comp"] as? String)==comp },"Each planned operation carries captured composition")
}
let base=try creation.creation(fields:fields,offsets:[0,0],at:30,audioAngle:nil), dry=try apply(fields,base)
let muteOnly=try creation.finishCreation(base,created:dry.created,withAudio:false)
let muted=try apply(fields,muteOnly).fields
let mutedClips=(muted["tracks"] as! [[String:Any]]).flatMap { $0["clips"] as! [[String:Any]] }
check(mutedClips.first { $0["kind"] as? String=="multicam" }?["mute"] as? Bool==true,"Create without audio remains silent")
let mc:[String:Any]=["id":"c20","kind":"multicam","start":10,"dur":4,"in":2,"speed":2,"link":"L20","mute":true,"audioAngle":0,
    "angles":[["src":"a.mp4","offset":1,"label":"A"],["src":"b.mp4","offset":2,"label":"B"]],"cuts":[["t":0,"angle":0],["t":4,"angle":1],["t":6,"angle":0]]]
let audio:[String:Any]=["id":"c21","kind":"audio","src":"a.mp4","start":10,"dur":4,"in":3,"speed":2,"link":"L20"]
var existing=fields;existing["tracks"]=[["id":"V1","kind":"video","clips":[mc]],["id":"A1","kind":"audio","clips":[audio]]]
let captured=try capture(existing,target:"c20")
let cuts=try captured.cut(fields:existing,at:11.5,angle:0)
near(n(cuts[0],"at"),3,"Cut operation maps playhead through positive scalar speed")
check(cuts[0]["local"] as? Bool==true,"Core receives source-local cut time")
let afterCut=try apply(existing,cuts).fields
let cutClip=((afterCut["tracks"] as! [[String:Any]])[0]["clips"] as! [[String:Any]])[0]
let cutValues=cutClip["cuts"] as! [[String:Any]]
check(cutValues.contains { n($0,"t")==5 && n($0,"angle")==0 },"Actual core places cut at multicam source time including trim in")
near(NativeMulticamPlanning.angleTime(clip:mc,angle:(mc["angles"] as! [[String:Any]])[1],asset:assets["b.mp4"] as! [String:Any],at:11.5) ?? -1,7,"Angle preview matches source in/speed/offset mapping")
check(NativeMulticamPlanning.activeAngle(clip:mc,at:11)==1,"Active angle follows shared cut time")
check(NativeMulticamPlanning.angleTime(clip:mc,angle:[:],asset:[:],at:.nan)==nil,"Invalid preview time rejected")
fails("Cut at clip end") { _ = try captured.cut(fields:existing,at:14,angle:1) }
fails("Invalid cut angle") { _ = try captured.cut(fields:existing,at:12,angle:9) }
fails("Initial cut removal") { _ = try captured.removeCut(fields:existing,index:0) }
var invalidCuts=existing, badCutClip=mc;badCutClip["cuts"]=[["t":0,"angle":1e20]];invalidCuts["tracks"]=[["id":"V1","kind":"video","clips":[badCutClip]],["id":"A1","kind":"audio","clips":[audio]]]
fails("Extreme imported cut index") { _ = try capture(invalidCuts,target:"c20") }
check(NativeMulticamPlanning.activeAngle(clip:badCutClip,at:11)==nil,"Invalid imported cut cannot trap frame preview")
let switchAudio=try captured.audio(fields:existing,angle:1)
check(switchAudio.count==2,"Audio angle and linked audio use one two-op batch")
let switched=try apply(existing,switchAudio).fields
let switchedAudio=((switched["tracks"] as! [[String:Any]])[1]["clips"] as! [[String:Any]])[0]
check(switchedAudio["src"] as? String=="b.mp4","Linked audio follows chosen source")
near(n(switchedAudio,"in"),4,"Linked audio preserves source in plus chosen angle offset")
let resync=try captured.angles(fields:existing,offsets:[2,3])
check(resync.count==2,"Resync includes linked audio input atomically")
near(n(resync[1]["set"] as! [String:Any],"in"),4,"Resync updates selected audio source window")
for (key,value) in [("reverse",true as Any),("freeze",3 as Any),("timeMap",[] as Any),("speed",0 as Any)] {
    var changed=existing, nonlinear=mc;nonlinear[key]=value;changed["tracks"]=[["id":"V1","kind":"video","clips":[nonlinear]],["id":"A1","kind":"audio","clips":[audio]]]
    fails("Unsupported multicam mapping: \(key)") { _ = try capture(changed,target:"c20") }
}
var locked=existing;locked["tracks"]=[["id":"V1","kind":"video","clips":[mc]],["id":"A1","kind":"audio","locked":true,"clips":[audio]]]
fails("Locked linked audio target") { _ = try capture(locked,target:"c20") }
fails("Out-of-range angle offset") { _ = try captured.angles(fields:existing,offsets:[0,100]) }
var mismatched=existing, shiftedAudio=audio;shiftedAudio["start"]=11;mismatched["tracks"]=[["id":"V1","kind":"video","clips":[mc]],["id":"A1","kind":"audio","clips":[shiftedAudio]]]
let mismatch=try capture(mismatched,target:"c20")
fails("Unaligned partner update") { _ = try mismatch.audio(fields:mismatched,angle:1) }
check(NativeMulticamPlanning.index(1e20,count:9)==nil && NativeMulticamPlanning.index(.nan,count:9)==nil,"Integer conversion rejects extreme and nonfinite values")
let history:[[String:Any]] = [["id":"active","kind":"sync","state":"running","spec":["uiMulticamCapture":creation.record]]] + (0..<30).map { ["id":"done-\($0)","kind":"sync","state":"done","spec":["uiMulticamCapture":creation.record]] }
let visible=NativeMulticamPlanning.syncJobs(history)
check(visible.count==21 && visible.first?["id"] as? String=="active","Active sync remains visible above bounded completed history")
print("Multicam production planning and bundled core: \(checks) assertions passed")
