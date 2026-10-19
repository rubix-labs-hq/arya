import Foundation

var assertions = 0
func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    assertions += 1
    guard condition() else { fatalError(message) }
}

let title: [String: Any] = ["id": "cText", "kind": "title", "label": "Headline", "dur": 5.0, "start": 0.0, "note": "figma 12:34", "title": ["text": "Hello", "font": "Avenir Next"]]
let shape: [String: Any] = ["id": "cShape", "kind": "shape", "dur": 5.0, "start": 0.0, "note": "figma 12:35"]
let nested: [String: Any] = ["id": "cNested", "kind": "comp", "comp": "kNested", "label": "Card", "dur": 5.0, "start": 0.0, "note": "figma 12:30"]
let root: [String: Any] = ["name": "Imported frame", "tracks": [["id": "V1", "kind": "video", "clips": [nested]]]]
let project: [String: Any] = ["name": "Test", "tracks": [["id": "V1", "kind": "video", "clips": [nested]]], "comps": ["kRoot": root, "kNested": ["name": "Card", "tracks": [["id": "V1", "kind": "video", "clips": [title, shape]]]], "kEmpty": ["tracks": []]]]
let before = try JSONSerialization.data(withJSONObject: project, options: [.sortedKeys])
let context = NativeSelectionAIContext.make(project: project, clipID: "cNested", composition: "kRoot", time: 2)!
let selection = context.refs["sourceSelection"] as! [String: Any]
expect(selection["composition"] as? String == "kNested", "The selected composition must remain exact.")
expect(Set(selection["nativeLayerIDs"] as! [String]) == Set(["cNested", "cText", "cShape"]), "Nested source layers must all be attached.")
expect(selection["figmaSourceNodeIDs"] as? [String] == ["12:30", "12:34", "12:35"], "Figma node IDs must come from import metadata.")
let layers = selection["layers"] as! [[String: Any]]
expect(layers.first { $0["id"] as? String == "cText" }?["composition"] as? String == "kNested", "Nested layer scopes must be preserved.")
expect(context.references(intent: "Fade the card")?["intent"] as? String == "Fade the card", "The user's intent must be attached to the references.")
expect(context.references(intent: String(repeating: "x", count: 60_000)) == nil, "Oversized reference requests must be rejected rather than truncated.")
var oversizedTitle = title; oversizedTitle["label"] = String(repeating: "x", count: 60_000)
let oversizedProject: [String: Any] = ["tracks": [["clips": [oversizedTitle]]]]
expect(NativeSelectionAIContext.make(project: oversizedProject, clipID: "cText", composition: nil, time: 0) == nil, "Oversized source snapshots must be rejected before the assistant opens.")
let versioned = NativeSelectionAIContext.make(project: project, clipID: "cNested", composition: "kRoot", time: 2, version: 7, folder: "/project/a")!
expect(versioned.matches(project: project, folder: "/project/a", version: 7), "A request must match its captured project and version.")
expect(!versioned.matches(project: project, folder: "/project/b", version: 7), "A project switch must invalidate a captured request even when IDs and versions match.")
expect(!versioned.matches(project: project, folder: "/project/a", version: 8), "An edit while the request is open must require a source refresh.")
expect(NativeSelectionAIContext.figmaNode(["note": "figma 12:34 imported text"]) == "12:34", "Only the source node ID belongs in assistant references.")
expect(context.refs["intent"] == nil, "Adding intent must preserve the captured source context.")
expect(context.suggestions.contains { $0.contains("text") }, "Text suggestions must depend on real selected text.")
expect(context.suggestions.contains { $0.contains("Stagger") }, "Layer staggering requires multiple selected layers.")
expect(NativeSelectionAIContext.make(project: project, clipID: "missing", composition: "kNested", time: 0) == nil, "A stale selection must not become a different request.")
expect(NativeSelectionAIContext.make(project: project, clipID: nil, composition: "missing", time: 0) == nil, "A missing composition must not fall back to another timeline.")
expect(NativeSelectionAIContext.make(project: project, clipID: nil, composition: nil, time: 0) == nil, "The main timeline without a selected layer must not imply a source composition.")
expect(NativeSelectionAIContext.importedCompositions(in: project) == ["kNested", "kRoot"], "Only imported compositions and their containing compositions should appear.")
let cyclic: [String: Any] = ["comps": ["a": ["tracks": [["clips": [["id": "cLoop", "kind": "comp", "comp": "a"]]]]]]]
expect(NativeSelectionAIContext.importedCompositions(in: cyclic).isEmpty, "Composition cycles must terminate without invented Figma sources.")
let after = try JSONSerialization.data(withJSONObject: project, options: [.sortedKeys])
expect(after == before, "Reading selection context must not mutate imported geometry or fonts.")

expect(NativeLibrarySelection.source(category: .title, project: project, selected: nested, composition: nil)?["clip"] == "cNested", "A comp-backed title must save its selected wrapper and dependencies.")
expect(NativeLibrarySelection.source(category: .composition, project: project, selected: nested, composition: nil)?["clip"] == "cNested", "A selected composition must preserve its wrapper transforms and timing.")
expect(NativeLibrarySelection.source(category: .title, project: project, selected: title, composition: "kNested")?["clip"] == "cText", "Saving a selected native title must use the selected layer.")
expect(NativeLibrarySelection.source(category: .effect, project: project, selected: shape, composition: nil) == nil, "An uneffected visual layer must not be offered as an effect.")
var effected = shape; effected["effects"] = [["type": "glow", "params": ["amount": 0.5]]]
expect(NativeLibrarySelection.source(category: .effect, project: project, selected: effected, composition: nil)?["clip"] == "cShape", "A visual effect must use its native source layer.")
var masked = shape; masked["anim"] = ["mask.mk1.x": [[0, 0], [1, 30]]]
expect(NativeLibrarySelection.source(category: .motion, project: project, selected: masked, composition: nil) == nil, "Mask animation must be saved with its dependent objects.")

let motion = NativeLibraryItem(fields: ["id": "lib1", "name": "Reveal", "category": "motion", "body": ["settings": ["kind": "title", "dur": 5, "anim": ["title.size": [[0, 20], [1, 40]]]]]])
let titleTrack: [[String: Any]] = [["id": "V1", "kind": "video", "clips": [title]]]
expect(NativeLibrarySelection.applyReason(item: motion, selected: title, tracks: titleTrack, fps: 30) == nil, "Title motion must fit a native title.")
expect(NativeLibrarySelection.applyReason(item: motion, selected: shape, tracks: [["clips": [shape]]], fps: 30) != nil, "Title-specific motion must reject shape targets.")
var animated = title; animated["anim"] = ["title.size": [[0, 40]]]
expect(NativeLibrarySelection.applyReason(item: motion, selected: animated, tracks: [["clips": [animated]]], fps: 30) != nil, "Applying motion must preserve existing keyframes.")
var expressed = title; expressed["expr"] = ["title.size": "value + 10"]
expect(NativeLibrarySelection.applyReason(item: motion, selected: expressed, tracks: [["clips": [expressed]]], fps: 30) != nil, "Applying motion must preserve existing expressions.")
expect(NativeLibrarySelection.applyReason(item: motion, selected: title, tracks: [["locked": true, "clips": [title]]], fps: 30) != nil, "Locked tracks must reject an apply action.")

let transition = NativeLibraryItem(fields: ["id": "lib2", "category": "transition", "body": ["settings": ["transitionIn": ["type": "crossDissolve", "dur": 1]]]])
let preceding: [String: Any] = ["id": "cBefore", "kind": "video", "start": 0.0, "dur": 5.0]
var next = shape; next["start"] = 5.0
expect(NativeLibrarySelection.applyReason(item: transition, selected: next, tracks: [["clips": [preceding, next]]], fps: 30) == nil, "Adjacent visual clips should accept a transition.")
var gapped = next; gapped["start"] = 5.01
expect(NativeLibrarySelection.applyReason(item: transition, selected: gapped, tracks: [["clips": [preceding, gapped]]], fps: 30) != nil, "A transition must reject a gap even inside one frame.")
var transitioned = next; transitioned["transitionIn"] = ["type": "wipeLeft", "dur": 0.4]
expect(NativeLibrarySelection.applyReason(item: transition, selected: transitioned, tracks: [["clips": [preceding, transitioned]]], fps: 30) != nil, "Applying a transition must preserve an existing transition.")
expect(NativeLibrarySelection.source(category: .transition, project: project, selected: nested, composition: nil)?["clip"] == "cNested", "An authored transition must preserve its selected composition wrapper.")
expect(NativeLibrarySelection.source(category: .transition, project: project, selected: nil, composition: "kNested")?["composition"] == "kNested", "An open composition must be available as an authored transition.")
expect(NativeLibrarySelection.source(category: .transition, project: project, selected: transitioned, composition: "kNested")?["clip"] == "cShape", "A selected incoming transition must take priority over its containing composition.")
let customTransition = NativeLibraryItem(fields: ["id": "libOverlay", "category": "transition", "body": ["composition": "kNested", "comps": project["comps"]!]])
expect(customTransition.isCompositionTransition, "The native browser must distinguish editable overlay transitions.")
expect(customTransition.detail == "Editable overlay transition · 2 layers · 5 s", "Authored transition details must use real native layer counts and duration.")
expect(NativeLibrarySelection.applyReason(item: customTransition, selected: nil, tracks: [["kind": "video", "clips": []]], fps: 30) != nil, "An authored transition must require a target cut, rather than ordinary placement.")
expect(NativeLibrarySelection.applyReason(item: customTransition, selected: next, tracks: [["clips": [preceding, next]]], fps: 30) == nil, "An authored transition must accept adjacent native visual clips.")
expect(NativeLibrarySelection.applyReason(item: customTransition, selected: gapped, tracks: [["clips": [preceding, gapped]]], fps: 30) != nil, "An authored transition must reject a gap before its target.")
expect(NativeLibrarySelection.applyReason(item: customTransition, selected: transitioned, tracks: [["clips": [preceding, transitioned]]], fps: 30) != nil, "An authored transition must preserve the target's existing incoming transition.")
var wrapper = nested; wrapper["dur"] = 2.5
let wrappedTransition = NativeLibraryItem(fields: ["id": "libWrapped", "category": "transition", "body": ["clip": wrapper, "comps": project["comps"]!]])
expect(wrappedTransition.detail == "Editable overlay transition · 2 layers · 2.5 s", "An authored transition saved from a clip must describe its wrapper duration.")
var shortBefore = preceding; shortBefore["start"] = 4.0; shortBefore["dur"] = 1.0
expect(NativeLibrarySelection.applyReason(item: customTransition, selected: next, tracks: [["clips": [shortBefore, next]]], fps: 30)?.contains("Shorten") == true, "An authored transition must have enough duration before its cut.")
var shortAfter = next; shortAfter["dur"] = 1.0
expect(NativeLibrarySelection.applyReason(item: wrappedTransition, selected: shortAfter, tracks: [["clips": [preceding, shortAfter]]], fps: 30)?.contains("Shorten") == true, "An authored transition must have enough duration after its cut.")
let savedTitle = NativeLibraryItem(fields: ["id": "lib3", "category": "title", "body": ["clip": title]])
expect(savedTitle.detail == "Avenir Next · Hello", "Library rows must describe the actual title and font.")
expect(NativeLibrarySelection.applyReason(item: savedTitle, selected: nil, tracks: [["kind": "video", "locked": true]], fps: 30) != nil, "Placement needs an unlocked video track.")
expect(NativeLibrarySelection.items(in: ["library": ["version": 1, "items": [["id": "lib3", "category": "title", "body": ["clip": title]]]]]).count == 1, "Durable library rows must appear in their native category.")
var libraryProject = project
libraryProject["library"] = ["version": 1, "items": [savedTitle.fields]]
let libraryCapture = NativeLibraryCapture(project: libraryProject, selected: title, composition: "kNested", folder: "/project/a", version: 20)
expect(libraryCapture.matches(project: libraryProject, folder: "/project/a", version: 20), "An unchanged source must retain its pending library action.")
expect(!libraryCapture.matches(project: libraryProject, folder: "/project/a", version: 21), "Undo or edits while a library dialog is open must invalidate the captured version.")
var replacementItem = savedTitle.fields; replacementItem["name"] = "Replacement with reused ID"
var replacementProject = libraryProject
replacementProject["library"] = ["version": 1, "items": [replacementItem]]
expect(!libraryCapture.matches(project: replacementProject, folder: "/project/a", version: 20), "Reloading the same folder with reused library IDs and version must invalidate a pending action.")
expect(!NativeLibraryCapture.itemMatches(savedTitle, project: replacementProject), "A stale row must not apply, rename or remove a replacement with the same ID.")
expect(NativeLibraryCapture.itemMatches(savedTitle, project: libraryProject), "An unchanged library entry must remain usable.")
var replacementSource = title; replacementSource["title"] = ["text": "Replacement clip with reused ID", "font": "Avenir Next"]
var changedSourceProject = libraryProject
changedSourceProject["tracks"] = [["id": "V1", "kind": "video", "clips": [replacementSource]]]
expect(!libraryCapture.matches(project: changedSourceProject, folder: "/project/a", version: 20), "A Save form must reject replaced native sources even when the project version is reused.")
expect(!versioned.matches(project: changedSourceProject, folder: "/project/a", version: 7), "An AI intent form must reject same-folder source replacement even when the source version and layer IDs are reused.")
expect(libraryCapture.selected?["id"] as? String == "cText", "The Save form's source selection must stay captured rather than following later selection changes.")
expect(libraryCapture.matchesSelection(selected: title, composition: "kNested"), "An unchanged target selection must remain valid.")
expect(!libraryCapture.matchesSelection(selected: shape, composition: "kNested"), "Changing the selected layer without editing the project must invalidate a captured apply action.")
expect(!libraryCapture.matchesSelection(selected: title, composition: "kRoot"), "Changing composition scope must invalidate a captured apply action.")
let firstBackend = NSObject(), replacementBackend = NSObject()
let importCapture = NativeFigmaImportCapture(backend: firstBackend, folder: "/project/a")
expect(importCapture.matches(backend: firstBackend, folder: "/project/a", expectedVersion: 21, currentVersion: 21), "An import may open its composition in its original backend at the returned version.")
expect(!importCapture.matches(backend: replacementBackend, folder: "/project/a", expectedVersion: 21, currentVersion: 21), "A completed import must not select a reused composition ID after reopening the same folder.")
expect(!importCapture.matches(backend: firstBackend, folder: "/project/b", expectedVersion: 21, currentVersion: 21), "An import must not select a composition after switching folders.")
expect(!importCapture.matches(backend: firstBackend, folder: "/project/a", expectedVersion: 21, currentVersion: 22), "Edits during import refresh must invalidate automatic composition selection.")
expect(!importCapture.matches(backend: firstBackend, folder: "/project/a", expectedVersion: nil, currentVersion: 21), "An import without its applied version must not open an ambiguous composition.")
let multiContext = NativeSelectionAIContext.make(project: project, clipID: "cText", clipIDs: ["cText", "cShape"], composition: "kNested", time: 2, version: 7, folder: "/project/a")!
let multiSource = multiContext.refs["sourceSelection"] as! [String: Any]
expect(multiContext.refs["clips"] as? [String] == ["cText", "cShape"], "Multiple AI targets must retain timeline order.")
expect(multiSource["composition"] as? String == "kNested", "Multiple layers must retain their containing composition.")
expect(multiSource["nativeLayerIDs"] as? [String] == ["cText", "cShape"], "Multiple targets must attach every selected native layer.")
expect(multiContext.label == "2 selected layers", "The intent dialog must identify a multiple selection.")
expect(NativeSelectionAIContext.make(project: project, clipID: "cText", clipIDs: ["cText", "missing"], composition: "kNested", time: 0) == nil, "A partly stale selection must reject rather than silently omit a target.")
expect(!multiContext.matches(project: project, folder: "/project/b", version: 7), "Multiple AI targets must reject a project switch.")
print("Passed \(assertions) native library and source-selection assertions.")
