import Foundation
var checks = 0
func check(_ value: @autoclosure () -> Bool, _ message: String) { checks += 1; if !value() { fatalError(message) } }
func near(_ value: Double?, _ expected: Double, _ message: String) { check(value.map { abs($0-expected)<0.0001 } ?? false,message) }
func fails(_ message: String, _ action: () throws -> Void) { checks += 1; do { try action(); fatalError("Expected rejection: \(message)") } catch {} }
let file = ["path":"/fixture/a.mp4","device":"1","inode":"2","size":"100","seconds":"1","nanoseconds":"2"]
let clip: [String: Any] = ["id":"c1","kind":"video","src":"a.mp4","start":10,"dur":4,"in":2,"speed":2,"link":"L1"]
var audio = clip; audio["id"] = "c1a"; audio["kind"] = "audio"
let fields: [String:Any] = ["name":"test","version":3,"fps":30,"width":1920,"height":1080,"nextId":10,"markers":[],"range":NSNull(),"comps":[:],
    "assets":["a.mp4":["duration":20,"fps":30,"hasVideo":true,"hasAudio":true]],
    "tracks":[["id":"V1","kind":"video","clips":[clip]],["id":"A1","kind":"audio","clips":[audio]]]]
let caps: [String:Any] = ["analysis":["scenes":true,"silence":true,"beats":true,"processingRecommendations":true,"opticalFlow":true,"personMask":true,"autoReframe":true],
    "processing":["videoDenoise":true,"deshake":true,"preservesAlpha":true,"codecs":["auto","h264","hevc","prores-422hq","prores-4444"]]]
func capture(_ fields: [String:Any] = fields, comp: String? = nil) throws -> NativeInspectorWorkflow.Capture {
    try .init(fields:fields,folder:"/fixture",composition:comp,version:4,id:"c1",file:file)
}
let source = try capture()
near(source.timeline(2),10,"Trim input maps to timeline start")
near(source.timeline(4),11,"Scalar speed maps source event")
near(source.timeline(10),14,"Source window end maps to clip end")
check(source.timeline(1)==nil,"Source event before trim is excluded")
check(source.timeline(11)==nil,"Source event beyond trim is excluded")
check(source.timeline(.nan)==nil,"NaN event is excluded")
let request = try source.request(route:"/api/analyze",options:["kind":"scenes","threshold":10],capabilities:caps)
check(request["in"]==nil && request["dur"]==nil,"Whole-source detection has no selected-range claim")
check(request["wait"] as? Bool == false,"Detection uses a persistent async job")
check(request["comp"] is NSNull,"Main request has explicit main scope")
check((request["expectedVersion"] as? NSNumber)?.intValue==4,"Expected version is captured")
check(request["uiCapture"] is [String:Any],"Persistent job retains captured target")
let result = NativeInspectorWorkflow.results(["times":[1,4,6,10,12]],kind:"scenes")
check(result.events.count==5 && result.total==5,"Source results include out-of-clip events")
let marks = try source.operations(events:result.events,selected:[0,1,2,3,4],split:false)
let markers = marks[0]["markers"] as! [[String:Any]]
check(markers.count==3,"Markers filter to source window")
near(NativeInspectorWorkflow.number(markers[0],"t"),11,"First marker maps source event")
near(NativeInspectorWorkflow.number(markers[1],"t"),12,"Second marker maps source event")
let splits = try source.operations(events:result.events,selected:[0,1,2,3,4],split:true)
check(splits.count==2,"Splits exclude clip edges")
near(NativeInspectorWorkflow.number(splits[0],"at"),12,"Splits run rightmost first on original ID")
near(NativeInspectorWorkflow.number(splits[1],"at"),11,"Later operation still targets remaining original clip")
let duplicate = NativeInspectorWorkflow.results(["times":[4,4.001,4.002]],kind:"beats")
let duplicateSplits = try source.operations(events:duplicate.events,selected:[0,1,2],split:true)
check(duplicateSplits.count==1,"Frame-grid duplicates collapse")
let silence = NativeInspectorWorkflow.results(["ranges":[[1,4],[6,12]]],kind:"silence")
let silenceSplits = try source.operations(events:silence.events,selected:[0,1],split:true)
check(silenceSplits.count==2,"Silence boundaries map independently into clip")
check(NativeInspectorWorkflow.results(["times":[]],kind:"scenes").events.isEmpty,"No scenes is an explicit empty result")
let bounded = NativeInspectorWorkflow.results(["times":Array(0..<1200)],kind:"beats")
check(bounded.events.count==1000 && bounded.total==1200 && bounded.truncated,"Result inspection is bounded without losing total count")
fails("too many chosen events") { _ = try source.operations(events:bounded.events,selected:Set(0..<300),split:false) }
fails("empty apply") { _ = try source.operations(events:result.events,selected:[],split:false) }
fails("only outside events") { _ = try source.operations(events:result.events,selected:[0,4],split:false) }
fails("unsupported analysis") { _ = try source.request(route:"/api/analyze",options:["kind":"unknown"],capabilities:caps) }
fails("missing capability") { _ = try source.request(route:"/api/analyze",options:["kind":"beats"],capabilities:[:]) }
fails("NaN threshold") { _ = try source.request(route:"/api/analyze",options:["kind":"scenes","threshold":Double.nan],capabilities:caps) }
fails("negative silence duration") { _ = try source.request(route:"/api/analyze",options:["kind":"silence","min":-1],capabilities:caps) }
func altered(_ key: String, _ value: Any) -> [String:Any] {
    var result=fields, changed=clip;changed[key]=value
    result["tracks"]=[["id":"V1","kind":"video","clips":[changed]],["id":"A1","kind":"audio","clips":[audio]]]
    return result
}
func matches(_ fields:[String:Any]=fields, folder:String="/fixture",comp:String?=nil,version:Int=4,primary:String?="c1",file:[String:String]=file) -> Bool {
    source.matches(fields:fields,folder:folder,composition:comp,version:version,primary:primary,file:file)
}
check(matches(),"Exact capture matches")
check(!matches(folder:"/other"),"Folder drift rejected")
check(!matches(comp:"nested"),"Scope drift rejected")
check(!matches(version:5),"Version drift rejected")
check(!matches(primary:"c1a"),"Selection drift rejected")
check(!matches(file:["path":"/fixture/a.mp4","size":"200"]),"Source replacement rejected")
for key in ["src","dur","in","speed","x","note"] {
    let value: Any = key=="src" ? "other.mp4" : key=="note" ? "new note" : 9
    check(!matches(altered(key,value)),"Complete clip metadata drift rejected: \(key)")
}
var linkedDrift=fields; var changedAudio=audio;changedAudio["volume"]=0.1
linkedDrift["tracks"]=[["id":"V1","kind":"video","clips":[clip]],["id":"A1","kind":"audio","clips":[changedAudio]]]
check(!matches(linkedDrift),"Linked metadata drift rejected")
var locked=fields; locked["tracks"]=[["id":"V1","kind":"video","clips":[clip]],["id":"A1","kind":"audio","locked":true,"clips":[audio]]]
fails("locked linked splits") { _ = try capture(locked).operations(events:result.events,selected:[1],split:true) }
fails("locked linked render") { _ = try capture(locked).request(route:"/api/retime",options:["speed":0.5],capabilities:caps,format:.init(hdr:false,alpha:false)) }
for (key,value) in [("reverse",true as Any),("freeze",2 as Any),("timeMap",[] as Any),("speed",0 as Any)] {
    let capture=try capture(altered(key,value))
    check(!capture.linear && capture.timeline(4)==nil,"Unsupported source map is rejected: \(key)")
    fails("unsupported source render") { _ = try capture.request(route:"/api/retime",options:["speed":0.5],capabilities:caps,format:.init(hdr:false,alpha:false)) }
}
let retime = try source.request(route:"/api/retime",options:["speed":0.5,"codec":"auto","apply":true],capabilities:caps,format:.init(hdr:false,alpha:false))
near(NativeInspectorWorkflow.number(retime,"in"),2,"Render uses captured source in")
near(NativeInspectorWorkflow.number(retime,"dur"),8,"Render uses full scalar source duration")
near(NativeInspectorWorkflow.number(retime,"speed"),0.5,"Requested output speed is immutable")
let person = try source.request(route:"/api/analysis/person-mask",options:["codec":"h264"],capabilities:caps,format:.init(hdr:false,alpha:false))
check(person["codec"] as? String=="prores-4444","Person mask requires alpha-capable output")
let alpha = try source.request(route:"/api/video/denoise",options:["codec":"h264"],capabilities:caps,format:.init(hdr:false,alpha:true))
check(alpha["codec"] as? String=="prores-4444","Source alpha forces preservation codec")
fails("HDR H264") { _ = try source.request(route:"/api/retime",options:["codec":"h264"],capabilities:caps,format:.init(hdr:true,alpha:false)) }
fails("unknown format") { _ = try source.request(route:"/api/retime",options:[:],capabilities:caps) }
fails("unsupported codec") { _ = try source.request(route:"/api/retime",options:["codec":"bad"],capabilities:caps,format:.init(hdr:false,alpha:false)) }
fails("speed below core floor") { _ = try source.request(route:"/api/retime",options:["speed":0.01],capabilities:caps,format:.init(hdr:false,alpha:false)) }
let measured = try source.request(route:"/api/analyze",options:["kind":"noise"],capabilities:caps)
near(NativeInspectorWorkflow.number(measured,"dur"),8,"Measured source range uses scalar speed")
check(NativeInspectorWorkflow.jobStatus(["state":"done","output":"derived.mov","applied":true])=="Saved and applied","Applied output reported accurately")
check(NativeInspectorWorkflow.jobStatus(["state":"done","output":"derived.mov","applied":false,"applyError":"stale"])=="Saved, not applied","Saved stale output remains distinct")
check(NativeInspectorWorkflow.jobStatus(["state":"done","output":"derived.mov"])=="Saved. Application not reported.","Missing application status does not imply application")
check(NativeInspectorWorkflow.jobStatus(["state":"done","output":"derived.mov","spec":["apply":false]])=="Saved, not applied","Preview-only job is saved without application")
check(NativeInspectorWorkflow.jobStatus(["state":"failed","error":"cancelled"])=="Cancelled","Cancellation recognized in backend failed state")
check(NativeInspectorWorkflow.jobStatus(["state":"running"])=="Running","Running status is explicit")
check(NativeInspectorWorkflow.jobStatus(["state":"done","result":["times":[]]])=="Analysis complete. No timeline edit.","Read-only analysis is not an edit")
var compFields=fields;compFields["comps"]=["nested":["fps":24,"width":1280,"height":720,"tracks":fields["tracks"]!]]
let nested = try capture(compFields,comp:"nested")
let nestedSplits = try nested.operations(events:result.events,selected:[1,2],split:true)
check(nestedSplits.allSatisfy { $0["comp"] as? String=="nested" },"Each split carries captured composition")
let nestedRequest = try nested.request(route:"/api/analyze",options:["kind":"beats"],capabilities:caps)
check(nestedRequest["comp"] as? String=="nested","Persistent analysis request carries exact composition")
let restored = try NativeInspectorWorkflow.Capture(record:nested.record)
check(restored.data==nested.data,"Persistent capture restores without loss")
var badLink = fields; var nonlinearAudio = audio; nonlinearAudio["reverse"] = true
badLink["tracks"] = [["id":"V1","kind":"video","clips":[clip]],["id":"A1","kind":"audio","clips":[nonlinearAudio]]]
fails("nonlinear linked split") { _ = try capture(badLink).operations(events:result.events,selected:[1],split:true) }
fails("nonlinear applied linked retime") { _ = try capture(badLink).request(route:"/api/retime",options:["speed":0.5],capabilities:caps,format:.init(hdr:false,alpha:false)) }
_ = try capture(badLink).request(route:"/api/retime",options:["speed":0.5,"apply":false],capabilities:caps,format:.init(hdr:false,alpha:false))
var mismatched = fields; var slowerAudio = audio; slowerAudio["speed"] = 1
mismatched["tracks"] = [["id":"V1","kind":"video","clips":[clip]],["id":"A1","kind":"audio","clips":[slowerAudio]]]
fails("different linked speed would desync") { _ = try capture(mismatched).request(route:"/api/retime",options:["speed":0.5],capabilities:caps,format:.init(hdr:false,alpha:false)) }
var history: [[String:Any]] = [["id":"running","kind":"retime","state":"running"]]
history += (0..<30).map { ["id":"done-\($0)","kind":"scenes","state":"done"] }
history += [["id":"export","kind":"export","state":"running"]]
let visible = NativeInspectorWorkflow.visibleJobs(history)
check(visible.count==21 && visible.first?["id"] as? String=="running","All active jobs remain visible above bounded completed history")
check(visible.last?["id"] as? String=="done-10","Only latest 20 completed jobs are shown")
check(!visible.contains { $0["kind"] as? String=="export" },"Unrelated export jobs do not enter inspector list")
var processedFields = fields, processedClip = clip
processedClip["src"] = "derived.mp4"; processedClip["in"] = 0.5
processedClip["noiseReduction"] = ["src": "a.mp4", "in": 2, "dur": 9, "output": "derived.mp4", "settings": ["strength": 0.3, "sigma": 0.08]]
processedFields["assets"] = ["a.mp4": ["duration": 20, "hasVideo": true], "derived.mp4": ["duration": 9, "hasVideo": true]]
processedFields["comps"] = ["nested": ["fps": 30, "tracks": [["id": "V1", "kind": "video", "clips": [processedClip]]]]]
let processedCapture = try capture(processedFields, comp: "nested")
let sourceRestore = try processedCapture.restoreProcessing("noiseReduction", fields: processedFields)
let restoreSet = sourceRestore[0]["set"] as! [String: Any]
check(sourceRestore[0]["comp"] as? String == "nested", "Processing restore keeps the captured composition")
check(restoreSet["src"] as? String == "a.mp4", "Processing restore uses the retained original")
near(NativeInspectorWorkflow.number(restoreSet, "in"), 2.5, "Trimmed derived range restores at the matching source offset")
check(restoreSet["noiseReduction"] is NSNull, "Processing restore clears the applied recipe in one edit")
check(restoreSet["speed"] == nil, "Processing restore keeps the existing positive scalar speed")
let reopenedData = try JSONSerialization.data(withJSONObject: processedFields, options: [.sortedKeys])
let reopened = try JSONSerialization.jsonObject(with: reopenedData) as! [String: Any]
let reopenedCapture = try capture(reopened, comp: "nested")
check(reopenedCapture.data == processedCapture.data, "The retained processing recipe survives JSON reopen")
var missingOriginal = processedFields; missingOriginal["assets"] = ["derived.mp4": ["duration": 9, "hasVideo": true]]
fails("missing original source") { _ = try processedCapture.restoreProcessing("noiseReduction", fields: missingOriginal) }
var staleOutputClip = processedClip; staleOutputClip["noiseReduction"] = ["src": "a.mp4", "in": 2, "dur": 9, "output": "other.mp4"]
var staleOutputFields = processedFields; staleOutputFields["comps"] = ["nested": ["fps": 30, "tracks": [["id": "V1", "clips": [staleOutputClip]]]]]
fails("recipe belongs to another output") { _ = try capture(staleOutputFields, comp: "nested").restoreProcessing("noiseReduction", fields: staleOutputFields) }
var expandedClip = processedClip; expandedClip["dur"] = 5
var expandedFields = processedFields; expandedFields["comps"] = ["nested": ["fps": 30, "tracks": [["id": "V1", "clips": [expandedClip]]]]]
fails("derived range exceeds retained handles") { _ = try capture(expandedFields, comp: "nested").restoreProcessing("noiseReduction", fields: expandedFields) }
var lockedFields = processedFields; lockedFields["comps"] = ["nested": ["fps": 30, "tracks": [["id": "V1", "locked": true, "clips": [processedClip]]]]]
fails("locked processing restore") { _ = try capture(lockedFields, comp: "nested").restoreProcessing("noiseReduction", fields: lockedFields) }
let nestedMarks = try nested.operations(events:result.events,selected:[1,2,3],split:false)
let plans:[[String:Any]]=[
    ["name":"mapped linked cuts","kind":"split","project":fields,"operations":splits,"comp":NSNull()],
    ["name":"nested cuts with reused IDs","kind":"split","project":compFields,"operations":nestedSplits,"comp":"nested"],
    ["name":"mapped source markers","kind":"markers","project":fields,"operations":marks,"comp":NSNull()],
    ["name":"nested mapped source markers","kind":"markers","project":compFields,"operations":nestedMarks,"comp":"nested"]
]
try JSONSerialization.data(withJSONObject:plans,options:[.sortedKeys]).write(to:URL(fileURLWithPath:CommandLine.arguments[1]))
print("Inspector workflow: \(checks) assertions passed")

#if INSPECTOR_CONTROLLER_CHECKS
// BEGIN INSPECTOR CONTROLLER CHECKS
@main struct InspectorControllerChecks {
    @MainActor static func main() async throws {
        var checks = 0
        func check(_ value: @autoclosure () -> Bool, _ message: String) {
            checks += 1
            if !value() { fatalError(message) }
        }
        func drain() async { for _ in 0..<40 { await Task.yield() } }
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        var fixture = 0
        func setup(composition: String? = nil) throws -> (NativeEditorModel, ResultsAdapter, URL) {
            fixture += 1
            let folder = root.appendingPathComponent("fixture-\(fixture)", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let source = folder.appendingPathComponent("source.mp4")
            try Data("original source".utf8).write(to: source)
            let clip: [String: Any] = ["id": "c1", "kind": "video", "src": "source.mp4", "start": 10, "dur": 4, "in": 2, "speed": 2, "link": "L1"]
            var audio = clip; audio["id"] = "a1"; audio["kind"] = "audio"
            let tracks: [[String: Any]] = [["id": "V1", "kind": "video", "clips": [clip]], ["id": "A1", "kind": "audio", "clips": [audio]]]
            var nestedClip = clip; nestedClip["start"] = 20
            var nestedAudio = audio; nestedAudio["start"] = 20
            let nestedTracks: [[String: Any]] = [["id": "V1", "kind": "video", "clips": [nestedClip]], ["id": "A1", "kind": "audio", "clips": [nestedAudio]]]
            let fields: [String: Any] = ["version": 3, "fps": 30, "width": 1920, "height": 1080,
                                         "assets": ["source.mp4": ["hasVideo": true, "hasAudio": true, "duration": 20, "fps": 30]],
                                         "tracks": tracks, "comps": ["nested": ["fps": 24, "tracks": nestedTracks]]]
            let model = NativeEditorModel()
            model.folder = folder; model.project = NativeProject(fields: fields); model.composition = composition
            let capture = try NativeInspectorWorkflow.Capture(model: model, id: "c1")
            return (model, ResultsAdapter(model, capture), source)
        }
        func alter(_ model: NativeEditorModel, clip key: String, value: Any) {
            var fields = model.project!.fields
            var tracks = fields["tracks"] as! [[String: Any]]
            var clips = tracks[0]["clips"] as! [[String: Any]]
            clips[0][key] = value; tracks[0]["clips"] = clips; fields["tracks"] = tracks
            model.project = NativeProject(fields: fields)
        }
        for split in [false, true] {
            let (model, controller, source) = try setup()
            controller.apply(split: split)
            try Data("replacement with different source-time events".utf8).write(to: source)
            await drain()
            check(model.calls.isEmpty, "Source replacement between action and dispatch must reject markers and splits")
            check(!controller.error.isEmpty && model.status == controller.error, "Queued source rejection must reach the results sheet and model status")

            let (selectionModel, selectionController, _) = try setup()
            selectionController.apply(split: split); selectionModel.selectedID = "a1"
            await drain()
            check(selectionModel.calls.isEmpty, "Primary selection drift between action and dispatch must reject markers and splits")
            check(!selectionController.error.isEmpty, "Selection rejection must be visible in the results sheet")
        }
        let drifts: [(String, (NativeEditorModel) -> Void)] = [
            ("project version", { $0.version += 1 }),
            ("project folder", { $0.folder = root.appendingPathComponent("another-project") }),
            ("composition", { $0.composition = "nested" }),
            ("source id", { alter($0, clip: "src", value: "other.mp4") }),
            ("trim", { alter($0, clip: "in", value: 3) }),
            ("speed", { alter($0, clip: "speed", value: 1) }),
            ("reverse", { alter($0, clip: "reverse", value: true) }),
            ("linked clip", { model in
                var fields = model.project!.fields, tracks = fields["tracks"] as! [[String: Any]]
                var clips = tracks[1]["clips"] as! [[String: Any]]
                clips[0]["volume"] = 0.25; tracks[1]["clips"] = clips; fields["tracks"] = tracks
                model.project = NativeProject(fields: fields)
            }),
            ("source metadata", { model in
                var fields = model.project!.fields, assets = fields["assets"] as! [String: Any]
                assets["source.mp4"] = ["hasVideo": true, "hasAudio": true, "duration": 22, "fps": 30]
                fields["assets"] = assets; model.project = NativeProject(fields: fields)
            })
        ]
        for (name, drift) in drifts {
            let (model, controller, _) = try setup()
            controller.apply(split: false); drift(model)
            await drain()
            check(model.calls.isEmpty, "Queued \(name) drift must reject the edit")
            check(!controller.error.isEmpty, "Queued \(name) rejection must be visible")
        }
        let (resetModel, resetController, _) = try setup()
        resetController.apply(split: true); resetModel.generation = UUID()
        await drain()
        check(resetModel.calls.isEmpty, "The actual model.perform generation guard must discard queued work after reset")

        for composition: String? in [nil, "nested"] {
            for split in [false, true] {
                let (model, controller, _) = try setup(composition: composition)
                controller.apply(split: split)
                controller.selected = []; controller.results = .init(events: [], total: 0, truncated: false)
                await drain()
                check(model.calls.count == 1, "An unchanged target must dispatch exactly one frozen request")
                let call = model.calls[0], body = call.body, operations = body["ops"] as! [[String: Any]]
                check(call.path == "/api/ops", "Both actions must use the atomic operations endpoint")
                check((body["expectedVersion"] as? NSNumber)?.intValue == 4, "Request must use the captured version")
                check(body["who"] as? String == "you" && body["returnProject"] as? Bool == true, "Request must retain normal edit provenance and project return")
                check(body["summary"] as? String == (split ? "Split clip from source analysis" : "Add source-analysis markers"), "Request must retain the chosen action")
                check(operations.count == 1 && operations[0]["op"] as? String == (split ? "blade" : "markers"), "Later result selection changes must not alter queued operations")
                if let composition { check(operations.allSatisfy { $0["comp"] as? String == composition }, "Every operation must keep its captured nested scope with reused IDs") }
                else { check(operations.allSatisfy { $0["comp"] is NSNull }, "Every main operation must carry explicit null scope despite reused nested IDs") }
                let at = split ? (operations[0]["at"] as! NSNumber).doubleValue : ((operations[0]["markers"] as! [[String: Any]])[0]["t"] as! NSNumber).doubleValue
                check(abs(at - (composition == nil ? 11 : 21)) < 0.000001, "Controller must freeze mapped source time in the captured scope")
                check(controller.error.isEmpty, "Successful dispatch must leave no sheet error")
            }
        }
        let (failedModel, failedController, _) = try setup()
        failedModel.callError = ReelBackend.APIError("The project changed at the backend.")
        failedController.apply(split: true)
        await drain()
        check(failedModel.calls.count == 1, "Backend rejection must not retry a frozen operation")
        check(failedController.error == "The project changed at the backend." && failedModel.status == failedController.error, "Backend rejection must reach the results sheet and model status")

        let (staleModel, staleController, source) = try setup()
        try FileManager.default.removeItem(at: source)
        staleController.apply(split: false)
        await drain()
        check(staleModel.calls.isEmpty && !staleController.error.isEmpty, "An already missing source must fail before scheduling")
        print("Inspector production controller dispatch: \(checks) assertions passed")
    }
}
// END INSPECTOR CONTROLLER CHECKS
#endif
