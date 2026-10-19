import Foundation

var assertions = 0
func check(_ value: @autoclosure () -> Bool, _ message: String) {
    assertions += 1
    if !value() { fatalError(message) }
}
func near(_ actual: Double, _ expected: Double, _ message: String) { check(abs(actual - expected) < 0.00011, message) }
func fails(_ message: String, _ action: () throws -> Void) {
    assertions += 1
    do { try action(); fatalError("Expected rejection: \(message)") } catch { }
}
func value(_ object: [String: Any], _ key: String) -> Double { (object[key] as? NSNumber)?.doubleValue ?? -.infinity }
func media(_ id: String, start: Double, duration: Double, input: Double = 2, link: String = "", kind: String = "video", speed: Double = 1) -> [String: Any] {
    var result: [String: Any] = ["id": id, "kind": kind, "src": "a.mp4", "start": start, "dur": duration, "in": input, "speed": speed]
    if !link.isEmpty { result["link"] = link }
    return result
}
func track(_ id: String, kind: String = "video", clips: [[String: Any]], locked: Bool = false) -> [String: Any] {
    ["id": id, "kind": kind, "clips": clips, "locked": locked]
}
func project(_ tracks: [[String: Any]], fps: Double = 30) -> [String: Any] {
    ["name": "Planner test", "version": 3, "fps": fps, "width": 1920, "height": 1080, "tracks": tracks,
     "assets": ["a.mp4": ["duration": 20, "hasVideo": true, "hasAudio": true]], "comps": [:], "markers": [], "range": NSNull(), "nextId": 10]
}
func capture(_ fields: [String: Any], lead: String = "b", selected: Set<String> = ["b"], composition: String? = nil, snapping: Bool = false, zoom: Double = 100, time: Double = 0) throws -> NativeTimelinePlanning.Capture {
    try .init(fields: fields, folder: "/fixture", composition: composition, version: 4, selected: selected, primary: lead, lead: lead, zoom: zoom, time: time, snapping: snapping)
}
let a = media("a", start: 0, duration: 4, input: 0, link: "la")
let b = media("b", start: 4, duration: 4, link: "lb")
let c = media("c", start: 8, duration: 4, link: "lc")
func audio(_ clip: [String: Any]) -> [String: Any] { var result = clip; result["id"] = "\(clip["id"]!)x"; result["kind"] = "audio"; return result }
let fields = project([track("V1", clips: [a, b, c]), track("V2", clips: []), track("A1", kind: "audio", clips: [audio(a), audio(b), audio(c)])])
let source = try capture(fields, selected: ["b", "bx", "c", "cx"])
check(source.affectedSelection.count == 4, "Selected linked families are complete")
let moved = try source.plan(mode: .move, delta: 1, destination: "V2")
check(moved.operations.count == 2, "One operation per link group")
check(moved.operations.first?["id"] as? String == "b", "Lead operation is first")
check(moved.operations.first?["track"] as? String == "V2", "Lead changes destination")
check(moved.operations.last?["track"] == nil, "Other groups retain tracks like the browser")
check(moved.offsets.count == 4, "Linked previews follow the common move")
near(value(moved.operations[0], "start"), 5, "Lead moves by one second")
near(value(moved.operations[1], "start"), 9, "Second selected family keeps its offset")
check(source.hasChanges(moved), "Destination move changes state")
fails("audio destination") { _ = try source.plan(mode: .move, delta: 1, destination: "A1") }
fails("missing destination") { _ = try source.plan(mode: .move, delta: 1, destination: "gone") }
let lockedDestination = project([track("V1", clips: [b]), track("V2", clips: [], locked: true)])
fails("locked destination") { _ = try capture(lockedDestination).plan(mode: .move, delta: 1, destination: "V2") }
let zero = try capture(fields).plan(mode: .move, delta: 0)
check(!source.hasChanges(zero), "Exact no-op does not commit")
let clampedMove = try source.plan(mode: .move, delta: -100)
near(value(clampedMove.operations[0], "start"), 0, "Move stops at earliest affected start")
near(value(clampedMove.operations[1], "start"), 4, "Move preserves selected offset at origin")
fails("NaN delta") { _ = try source.plan(mode: .move, delta: .nan) }
fails("infinite delta") { _ = try source.plan(mode: .move, delta: .infinity) }
fails("oversized delta") { _ = try source.plan(mode: .move, delta: 1e20) }
fails("empty selection") { _ = try capture(fields, selected: []) }
fails("missing selection") { _ = try capture(fields, selected: ["gone"]) }
fails("lead outside selection") { _ = try capture(fields, selected: ["c"]) }
fails("missing comp") { _ = try capture(fields, composition: "gone") }
fails("NaN zoom") { _ = try capture(fields, zoom: .nan) }
fails("zero zoom") { _ = try capture(fields, zoom: 0) }
var locked = fields
locked["tracks"] = [track("V1", clips: [a,b,c]), track("V2", clips: []), track("A1", kind: "audio", clips: [audio(a),audio(b),audio(c)], locked: true)]
fails("locked linked track") { _ = try capture(locked) }
var changed = fields
changed["tracks"] = [track("V1", clips: [a,media("b",start:4,duration:3,link:"lb"),c]), track("V2", clips: []), track("A1",kind:"audio",clips:[audio(a),audio(b),audio(c)])]
func matches(_ fields: [String: Any], folder: String = "/fixture", composition: String? = nil, version: Int = 4, selected: Set<String> = ["b", "bx", "c", "cx"], primary: String? = "b", zoom: Double = 100) -> Bool {
    source.matches(fields: fields, folder: folder, composition: composition, version: version, selected: selected, primary: primary, zoom: zoom)
}
check(matches(fields), "Same complete state matches")
check(!matches(changed), "Changed clip at the same version is rejected")
check(!matches(locked), "Changed locked track at the same version is rejected")
check(!matches(fields, folder: "/other"), "Folder change rejected")
check(!matches(fields, composition: "comp"), "Composition change rejected")
check(!matches(fields, version: 5), "Version change rejected")
check(!matches(fields, selected: ["b"]), "Selection change rejected")
check(!matches(fields, primary: "c"), "Primary change rejected")
check(!matches(fields, zoom: 50), "Geometry change rejected")
var assetChanged = fields; assetChanged["assets"] = ["a.mp4": ["duration": 3]]
check(!matches(assetChanged), "Source bounds change at the same version rejected")
var removed = fields; removed["tracks"] = [track("V1", clips: [a,c])]
check(!matches(removed), "Removed selected target rejected")
var properties = fields; properties["mixer"] = ["volume": 0.5]
check(!matches(properties), "Project properties change rejected")
let rows = ["V2","V1","A1"]
let otherRow = try NativeTimelinePlanning.destination(rows: rows, source: "V1", verticalDelta: -65, rowHeight: 65)
check(otherRow == "V2", "Cross-track row geometry")
let sameRow = try NativeTimelinePlanning.destination(rows: rows, source: "V1", verticalDelta: 30, rowHeight: 65)
check(sameRow == "V1", "Small vertical motion retains source")
fails("offscreen destination") { _ = try NativeTimelinePlanning.destination(rows: rows, source: "V1", verticalDelta: -200, rowHeight: 65) }
fails("NaN vertical geometry") { _ = try NativeTimelinePlanning.destination(rows: rows, source: "V1", verticalDelta: .nan, rowHeight: 65) }
fails("huge finite vertical geometry") { _ = try NativeTimelinePlanning.destination(rows: rows, source: "V1", verticalDelta: 1e100, rowHeight: 65) }
fails("zero row height") { _ = try NativeTimelinePlanning.destination(rows: rows, source: "V1", verticalDelta: 1, rowHeight: 0) }
var snapFields = fields; snapFields["markers"] = [["t": 5.05]]
let snapSource = try capture(snapFields, snapping: true, time: 100)
let snapped = try snapSource.plan(mode: .move, delta: 1.04)
near(value(snapped.operations[0], "start"), 5.06667, "Snap to marker then backend frame grid")
near(snapped.snapLine ?? 0, 5.05, "Snap line identifies actual marker")
let unsnapped = try capture(snapFields, time: 100).plan(mode: .move, delta: 1.02)
near(value(unsnapped.operations[0], "start"), 5.03333, "Snapping off retains frame alignment")
check(unsnapped.snapLine == nil, "Snapping off hides guide")
let marqueeTracks = [track("V1",clips:[a,b,c]), track("A1",kind:"audio",clips:[audio(a),audio(b),audio(c)])]
let marqueeIDs = NativeTimelinePlanning.marquee(tracks:marqueeTracks,x0:450,x1:750,y0:29,y1:159,zoom:100,rowHeight:65)
check(marqueeIDs == ["b","bx"], "Marquee intersects time and both track rows")
check(NativeTimelinePlanning.marquee(tracks:marqueeTracks,x0:750,x1:450,y0:159,y1:29,zoom:100,rowHeight:65) == marqueeIDs, "Marquee works in reverse direction")
check(NativeTimelinePlanning.marquee(tracks:marqueeTracks,x0:450,x1:750,y0:29,y1:93,zoom:100,rowHeight:65) == ["b"], "Marquee excludes the next track")
check(NativeTimelinePlanning.marquee(tracks:marqueeTracks,x0:.nan,x1:750,y0:29,y1:159,zoom:100,rowHeight:65).isEmpty, "Marquee rejects nonfinite geometry")
check(NativeTimelinePlanning.marquee(tracks:marqueeTracks,x0:450,x1:750,y0:29,y1:159,zoom:0,rowHeight:65).isEmpty, "Marquee rejects zero scale")
let trim = try capture(fields).plan(mode: .trim, delta: 1, edge: "right")
near(value(trim.operations[0], "to"), 8, "Linked right trim stops at the next clip")
let trimIntoGap = try capture(fields).plan(mode: .trim, delta: -1, edge: "right")
near(value(trimIntoGap.operations[0], "to"), 7, "Linked right trim shortens freely")
check(trim.operations[0]["ripple"] as? Bool == false, "Normal trim leaves later timing")
let ripple = try capture(fields).plan(mode: .ripple, delta: -1, edge: "right")
near(value(ripple.operations[0], "to"), 7, "Ripple right edge planned")
check(ripple.operations[0]["ripple"] as? Bool == true, "Ripple flag reaches backend")
near(ripple.offsets["c"] ?? 0, -1, "Later video previews ripple")
near(ripple.offsets["cx"] ?? 0, -1, "Later linked audio previews ripple")
let leftRipple = try capture(fields).plan(mode:.ripple,delta:1,edge:"left")
near(value(leftRipple.operations[0],"to"),5,"Left ripple head change is planned")
near(leftRipple.offsets["c"] ?? 0,-1,"Left ripple later cut follows head change")
let leftRippleExtend = try capture(fields).plan(mode:.ripple,delta:-1,edge:"left")
near(value(leftRippleExtend.operations[0],"to"),3,"Left ripple extends with source handles")
let zeroHead = media("b",start:0,duration:4,input:2)
let zeroHeadNext = media("c",start:4,duration:4,input:2)
let zeroHeadFields = project([track("V1",clips:[zeroHead,zeroHeadNext])])
let zeroHeadSource = try capture(zeroHeadFields)
let zeroHeadRipple = try zeroHeadSource.plan(mode:.ripple,delta:-1,edge:"left")
near(value(zeroHeadRipple.operations[0],"to"),-1,"Left ripple at zero may extend into source handles")
let zeroNormalTrim = try zeroHeadSource.plan(mode:.trim,delta:-1,edge:"left")
near(value(zeroNormalTrim.operations[0],"to"),0,"Normal trim retains timeline-zero clamp")
check(!zeroHeadSource.hasChanges(zeroNormalTrim),"Clamped normal left trim is a no-op")
let loneFields = project([track("V1", clips: [b])])
let leftTrim = try capture(loneFields).plan(mode: .trim, delta: -100, edge: "left")
near(value(leftTrim.operations[0], "to"), 2, "Left trim stops at source input zero")
near(value(try capture(fields).plan(mode: .trim, delta: -100, edge: "left").operations[0], "to"), 4, "Left trim stops at the previous clip")
let shortTrim = try capture(fields).plan(mode: .trim, delta: -100, edge: "right")
near(value(shortTrim.operations[0], "to"), 4 + 1.0/30, "Trim retains minimum frame")
let boundedTrim = try capture(loneFields).plan(mode: .trim, delta: 100, edge: "right")
near(value(boundedTrim.operations[0], "to"), 22, "Right trim stops at source duration")
fails("trim without edge") { _ = try capture(fields).plan(mode: .trim, delta: 1) }
var unlinkedRipple = fields
var unlinkedB = b; unlinkedB.removeValue(forKey: "link")
unlinkedRipple["tracks"] = [track("V1", clips: [a,unlinkedB,c]), track("A1",kind:"audio",clips:[audio(a),audio(c)])]
fails("ripple desynchronizes later links") { _ = try capture(unlinkedRipple).plan(mode: .ripple, delta: -1, edge: "right") }
let roll = try capture(fields).plan(mode: .roll, delta: 1, edge: "right")
check(roll.operations.count == 2, "Roll batches linked track pairs")
near(value(roll.operations[0], "to"), 9, "Roll cut planned")
check(roll.operations[0]["a"] as? String == "b" && roll.operations[0]["b"] as? String == "c", "Roll uses adjacent IDs")
check(roll.operations[1]["a"] as? String == "bx" && roll.operations[1]["b"] as? String == "cx", "Roll includes audio counterpart")
let leftRoll = try capture(fields).plan(mode: .roll, delta: 1, edge: "left")
check(leftRoll.operations.first?["a"] as? String == "a", "Left roll locates preceding cut")
var gapFields = fields
var gapC = c; gapC["start"] = 8.5
gapFields["tracks"] = [track("V1", clips: [a,b,gapC])]
fails("roll gap") { _ = try capture(gapFields).plan(mode: .roll, delta: 1, edge: "right") }
var incomplete = fields; incomplete["tracks"] = [track("V1", clips: [a,b,c]),track("A1",kind:"audio",clips:[audio(a),audio(b)])]
fails("missing roll partner") { _ = try capture(incomplete).plan(mode: .roll, delta: 1, edge: "right") }
let slip = try capture(fields).plan(mode: .slip, delta: -1)
near(value(slip.operations[0], "delta"), 1, "Slip reverses pointer delta into source movement")
let slipLow = try capture(fields).plan(mode: .slip, delta: 100)
near(value(slipLow.operations[0], "delta"), -2, "Slip stops at source origin")
let slipHigh = try capture(fields).plan(mode: .slip, delta: -100)
near(value(slipHigh.operations[0], "delta"), 14, "Slip stops at source end")
let slide = try capture(fields).plan(mode: .slide, delta: 1)
check(slide.operations.count == 2, "Slide batches linked target clips")
near(value(slide.operations[0], "delta"), 1, "Slide moves one second")
let slideLow = try capture(fields).plan(mode: .slide, delta: -100)
near(value(slideLow.operations[0], "delta"), -2, "Slide stops at following clip's source origin")
let slideHigh = try capture(fields).plan(mode: .slide, delta: 100)
near(value(slideHigh.operations[0], "delta"), 4 - 1.0/30, "Slide keeps a frame in following clip")
fails("slide without neighbor") { _ = try capture(incomplete).plan(mode: .slide, delta: 1) }
fails("slide gap") { _ = try capture(gapFields).plan(mode: .slide, delta: 1) }
var reverse = b; reverse["reverse"] = true
let reverseFields = project([track("V1",clips:[a,reverse,c])])
fails("reverse slip") { _ = try capture(reverseFields).plan(mode: .slip, delta: 1) }
fails("reverse roll") { _ = try capture(reverseFields).plan(mode: .roll, delta: 1, edge: "right") }
var frozen = b; frozen["freeze"] = 3
fails("frozen trim") { _ = try capture(project([track("V1",clips:[frozen])])).plan(mode: .trim, delta: 1, edge:"right") }
var wrongSpeed = b; wrongSpeed["speed"] = 0
fails("zero speed") { _ = try capture(project([track("V1",clips:[wrongSpeed])])).plan(mode:.slip, delta:1) }
var unknown = fields; unknown["assets"] = [:]
fails("unknown source duration") { _ = try capture(unknown).plan(mode:.slip, delta:1) }
var badTiming = b; badTiming["dur"] = 0
fails("zero duration") { _ = try capture(project([track("V1",clips:[badTiming])])) }
var duplicate = fields; duplicate["tracks"] = [track("V1",clips:[b,b])]
fails("duplicate IDs") { _ = try capture(duplicate) }
let compFields: [String: Any] = {
    var result = fields
    result["tracks"] = [track("V1",clips:[])]
    result["comps"] = ["nested": ["fps": 24,"tracks": fields["tracks"]!]]
    return result
}()
let compCapture = try capture(compFields, composition: "nested")
let compMove = try compCapture.plan(mode: .move, delta: 0.04, destination:"V2")
check(compMove.operations.allSatisfy { $0["comp"] as? String == "nested" }, "Every composition operation carries captured scope")
near(value(compMove.operations[0],"start"), 4 + 1.0/24, "Composition fps supplies frame grid")
let compTiny = try compCapture.plan(mode:.trim,delta:-100,edge:"right")
near(value(compTiny.operations[0],"to"),4+1.0/24,"Composition minimum duration uses scoped fps")
check(trim.operations[0]["comp"] is NSNull,"Main timeline operations carry explicit main scope")
let compRoll = try compCapture.plan(mode:.roll, delta:1, edge:"right")
check(compRoll.operations.allSatisfy { $0["comp"] as? String == "nested" }, "Multi-operation roll is composition scoped")

let thumbnail = NativeTimelinePlanning.thumbnailPlan(imageWidth:19200,imageHeight:54,width:96,count:200,interval:1)
check(thumbnail?.count == 180,"Thumbnail work is capped at 180 tiles")
check(NativeTimelinePlanning.thumbnailPlan(imageWidth:96,imageHeight:54,width:96,count:10,interval:0)?.count == 1,"Thumbnail count cannot exceed strip width")
check(NativeTimelinePlanning.thumbnailPlan(imageWidth:96,imageHeight:54,width:0.1,count:1,interval:1) == nil,"Subpixel thumbnail width cannot divide by zero")
check(NativeTimelinePlanning.thumbnailPlan(imageWidth:96,imageHeight:54,width:.nan,count:1,interval:1) == nil,"NaN thumbnail metadata rejected")
check(NativeTimelinePlanning.thumbnailPlan(imageWidth:96,imageHeight:54,width:96,count:.infinity,interval:1) == nil,"Infinite thumbnail count rejected")
check(NativeTimelinePlanning.thumbnailPlan(imageWidth:96,imageHeight:54,width:96,count:1,interval:-1) == nil,"Negative thumbnail interval rejected")
check(!NativeTimelinePlanning.imageAllowed(width:100000,height:100000),"Oversized strip rejected before image decode")
check(!NativeTimelinePlanning.imageAllowed(width:.nan,height:54),"NaN strip geometry rejected")
check(!NativeTimelinePlanning.imageAllowed(width:96,height:0),"Zero strip geometry rejected")
check(NativeTimelinePlanning.imageAllowed(width:7680,height:54),"Default strip geometry accepted")
var offsetAudio = audio(b); offsetAudio["start"] = 0.71
let offsetFields = project([track("V1",clips:[b]),track("A1",kind:"audio",clips:[offsetAudio])])
let offsetSource = try capture(offsetFields)
let offsetMove = try offsetSource.plan(mode:.move,delta:-100)
near(value(offsetMove.operations[0],"start"),3.3,"Move clamp respects frame grid before moving linked clips")
near(offsetMove.offsets["bx"] ?? 0,-0.7,"Linked partner retains offset instead of individually clamping to zero")
var fixtures: [[String: Any]] = []
func fixture(_ name: String, _ fields: [String: Any], _ source: NativeTimelinePlanning.Capture, _ plan: NativeTimelinePlanning.Plan, _ expected: [String: [String: Any]]) {
    fixtures.append(["name": name,"project":fields,"operations":plan.operations,"expected":expected,"composition":source.composition as Any? ?? NSNull(),"preview":plan.clipFields,"offsets":plan.offsets])
}
fixture("offset linked move at origin",offsetFields,offsetSource,offsetMove,["b":["start":3.3],"bx":["start":0.01]])
fixture("selected linked cross-track move", fields, source, moved, ["b":["start":5,"track":"V2"],"bx":["start":5,"track":"A1"],"c":["start":9,"track":"V1"],"cx":["start":9,"track":"A1"]])
fixture("linked trim stops at the next clip",fields,try capture(fields),trim,["b":["dur":4,"start":4],"bx":["dur":4,"start":4],"c":["start":8]])
fixture("linked trim shortens",fields,try capture(fields),trimIntoGap,["b":["dur":3,"start":4],"bx":["dur":3,"start":4],"c":["start":8]])
fixture("linked ripple trim",fields,try capture(fields),ripple,["b":["dur":3],"bx":["dur":3],"c":["start":7],"cx":["start":7]])
fixture("linked left ripple",fields,try capture(fields),leftRipple,["b":["start":4,"in":3,"dur":3],"bx":["start":4,"in":3,"dur":3],"c":["start":7],"cx":["start":7]])
fixture("linked left ripple extension",fields,try capture(fields),leftRippleExtend,["b":["start":4,"in":1,"dur":5],"bx":["start":4,"in":1,"dur":5],"c":["start":9],"cx":["start":9]])
fixture("left ripple extension at timeline zero",zeroHeadFields,zeroHeadSource,zeroHeadRipple,["b":["start":0,"in":1,"dur":5],"c":["start":5]])
fixture("left source bounded trim",loneFields,try capture(loneFields),leftTrim,["b":["start":2,"in":0,"dur":6]])
fixture("linked roll",fields,try capture(fields),roll,["b":["dur":5],"bx":["dur":5],"c":["start":9,"dur":3,"in":3],"cx":["start":9,"dur":3,"in":3]])
fixture("linked slip",fields,try capture(fields),slip,["b":["in":3,"start":4,"dur":4],"bx":["in":3,"start":4,"dur":4]])
fixture("linked slide",fields,try capture(fields),slide,["a":["dur":5],"ax":["dur":5],"b":["start":5,"dur":4],"bx":["start":5,"dur":4],"c":["start":9,"dur":3,"in":3],"cx":["start":9,"dur":3,"in":3]])
fixture("composition cross-track move",compFields,compCapture,compMove,["b":["start":4+1.0/24,"track":"V2"],"bx":["start":4+1.0/24,"track":"A1"]])
fixture("composition linked roll",compFields,compCapture,compRoll,["b":["dur":5],"bx":["dur":5],"c":["start":9,"dur":3],"cx":["start":9,"dur":3]])
let output = try JSONSerialization.data(withJSONObject:fixtures,options:[.sortedKeys])
try output.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
print("Timeline planner: \(assertions) assertions passed")
