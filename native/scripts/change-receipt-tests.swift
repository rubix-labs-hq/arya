import Foundation

var assertions = 0
func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    assertions += 1
    guard condition() else { fatalError(message) }
}
func receipt(_ before: [String: Any]?, _ after: [String: Any], previous: Int = 7, version: Int = 8, who: String = "agent") -> NativeChangeReceipt? {
    NativeChangeReceipt.make(before: before, after: after, previousVersion: previous, version: version, who: who, at: 123)
}
func fixture() -> [String: Any] {
    ["name": "Receipt fixture", "fps": 30, "tracks": [["id": "V1", "clips": [
        ["id": "c1", "kind": "title", "start": 0, "dur": 4, "title": ["text": "Opening", "size": 80]],
        ["id": "shared", "kind": "shape", "start": 0, "dur": 2]
    ]]], "comps": ["k1": ["name": "Brand lockup", "width": 1080, "tracks": [["id": "V2", "clips": [
        ["id": "shared", "kind": "shape", "label": "Figma mark", "start": 1, "dur": 3, "x": 20, "anim": ["opacity": [[0, 0], [1, 1]]]]
    ]]]]]]
}
func changedFixture() -> [String: Any] {
    var project = fixture(), comps = project["comps"] as! [String: Any], comp = comps["k1"] as! [String: Any]
    var tracks = comp["tracks"] as! [[String: Any]], clips = tracks[0]["clips"] as! [[String: Any]]
    clips[0]["anim"] = ["opacity": [[0, 0], [0.5, 1]]]
    clips[0]["x"] = 45
    tracks[0]["clips"] = clips; comp["tracks"] = tracks; comps["k1"] = comp; project["comps"] = comps
    return project
}

let before = fixture(), after = changedFixture()
let original = try JSONSerialization.data(withJSONObject: before, options: [.sortedKeys])
let change = receipt(before, after)!
expect(change.totalClips == 1 && change.totalScopes == 0, "Only committed changed layers should be counted.")
expect(change.clips[0].composition == "k1", "The changed layer must retain its composition ID.")
expect(change.clips[0].compositionName == "Brand lockup", "The receipt must name the actual composition.")
expect(change.clips[0].changes.map(\.property) == ["/anim/opacity", "/x"], "Nested changes must use exact JSON pointer paths.")
expect(change.clips[0].changes[0].before == "[[0,0],[1,1]]" && change.clips[0].changes[0].after == "[[0,0],[0.5,1]]", "The diff must show committed keyframe values.")
expect(NativeChangeReceipt.selection(for: change.clips[0], in: after)?.composition == "k1", "Reused clip IDs must select inside the changed composition.")
expect(NativeChangeReceipt.selection(for: change.clips[0], in: after)?.start == 1, "Selection must use the surviving object's time.")
expect(receipt(nil, after) == nil && receipt(before, after, previous: -1) == nil, "The first snapshot must not create an assistant receipt.")
expect(receipt(before, after, who: "you") == nil && receipt(before, after, who: "disk") == nil && receipt(before, after, who: "unknown") == nil, "Only the agent and claude actors may create assistant receipts.")
expect(receipt(before, after, who: "claude") != nil, "The direct Claude API actor must remain supported.")
expect(receipt(before, after, version: 7) == nil && receipt(before, after, version: 6) == nil, "Duplicate and stale versions must not create receipts.")
expect(receipt(before, before) == nil, "A no-op project event must not invent changes.")
let unchangedBytes = try JSONSerialization.data(withJSONObject: before, options: [.sortedKeys])
expect(original == unchangedBytes, "Receipts must not mutate project data.")

var removed = after, comps = removed["comps"] as! [String: Any]
comps.removeValue(forKey: "k1"); removed["comps"] = comps
let deletion = receipt(after, removed)!
expect(deletion.clips[0].status == "deleted" && deletion.scopes[0].status == "deleted", "Deleted compositions and layers must be reported as deleted.")
expect(NativeChangeReceipt.selection(for: deletion.clips[0], in: before) == nil, "Deleted receipt entries must never select reused IDs.")
expect(NativeChangeReceipt.selection(for: change.clips[0], in: removed) == nil, "A removed composition must not fall back to the main timeline.")
var removedLayer = after, nested = (after["comps"] as! [String: Any])["k1"] as! [String: Any]
nested["tracks"] = [["id": "V2", "clips": []]]; removedLayer["comps"] = ["k1": nested]
expect(NativeChangeReceipt.selection(for: change.clips[0], in: removedLayer) == nil, "A historical receipt must disable a layer that no longer survives.")

var settings = before
settings["fps"] = 24; settings["library"] = ["version": 1, "items": []]
let settingsChange = receipt(before, settings)!
expect(settingsChange.totalClips == 0 && settingsChange.scopes[0].changes.map(\.property) == ["/fps", "/library"], "Format and library edits must not invent changed layers.")
var renamed = before, renamedComps = before["comps"] as! [String: Any], renamedComp = renamedComps["k1"] as! [String: Any]
renamedComp["name"] = "New name"; renamedComps["k1"] = renamedComp; renamed["comps"] = renamedComps
expect(receipt(before, renamed)?.scopes[0].changes[0].property == "/name", "Composition settings must report their changed properties.")
var addedComp = before; addedComp["comps"] = ["empty": ["name": "Empty", "tracks": []]]
expect(receipt(["tracks": []], addedComp)?.scopes.contains { $0.composition == "empty" && $0.status == "added" } == true, "An added empty composition must receive a factual receipt.")

let audioClip: [String: Any] = ["id": "audio", "kind": "audio", "start": 0, "dur": 3]
let audioTrack: [String: Any] = ["id": "A1", "name": "Dialogue", "kind": "audio", "volume": 0, "pan": 0, "muted": false, "solo": false, "fx": [], "clips": [audioClip]]
let secondTrack: [String: Any] = ["id": "A2", "name": "Music", "kind": "audio", "clips": []]
let mixerBefore: [String: Any] = ["tracks": [audioTrack, secondTrack], "master": ["volume": 0, "limiter": ["enabled": false, "ceiling": -1], "eq": ["low": 0], "fx": []]]
var changedTrack = audioTrack
changedTrack["volume"] = -6; changedTrack["pan"] = -0.25; changedTrack["muted"] = true; changedTrack["solo"] = true
changedTrack["fx"] = [["id": "eq1", "type": "eq", "bands": [["freq": 220, "gain": -3]]]]
var mixerAfter = mixerBefore; mixerAfter["tracks"] = [changedTrack, secondTrack]
let trackReceipt = receipt(mixerBefore, mixerAfter)!
expect(trackReceipt.totalClips == 0 && trackReceipt.totalScopes == 1, "Track-only mixer edits must produce a receipt without invented clip changes.")
expect(trackReceipt.scopes[0].trackID == "A1" && trackReceipt.scopes[0].composition == nil && trackReceipt.scopes[0].name.contains("Dialogue"), "Track settings must retain the actual track identity, name and timeline.")
expect(Set(trackReceipt.scopes[0].changes.map(\.property)) == Set(["/fx", "/muted", "/pan", "/solo", "/volume"]), "A track receipt must include effects, volume, pan, mute and solo changes.")
expect(trackReceipt.scopes[0].changes.contains { $0.property == "/volume" && $0.before == "0" && $0.after == "-6" }, "Track level differences must preserve both committed values.")
expect(trackReceipt.scopes[0].changes.contains { $0.property == "/muted" && $0.before == "false" && $0.after == "true" }, "Track mute differences must preserve JSON booleans.")
var nestedMixerBefore = mixerBefore, nestedMixerAfter = mixerBefore
nestedMixerBefore["comps"] = ["mix": ["name": "Nested audio", "tracks": [audioTrack]]]
nestedMixerAfter["comps"] = ["mix": ["name": "Nested audio", "tracks": [changedTrack]]]
let nestedTrackReceipt = receipt(nestedMixerBefore, nestedMixerAfter)!
expect(nestedTrackReceipt.totalClips == 0 && nestedTrackReceipt.scopes[0].composition == "mix" && nestedTrackReceipt.scopes[0].trackID == "A1", "A reused track ID must keep the changed composition rather than imply the main timeline.")
var masterAfter = mixerBefore
masterAfter["master"] = ["volume": -2, "limiter": ["enabled": true, "ceiling": -2], "eq": ["low": -3], "fx": [["id": "masterEQ", "type": "eq", "bands": [["freq": 1400, "gain": 2]]]]]
let masterReceipt = receipt(mixerBefore, masterAfter)!
expect(masterReceipt.totalClips == 0 && masterReceipt.totalScopes == 1 && masterReceipt.scopes[0].trackID == nil, "Master-only edits must produce a project scope receipt.")
expect(Set(masterReceipt.scopes[0].changes.map(\.property)) == Set(["/master/eq/low", "/master/fx", "/master/limiter/ceiling", "/master/limiter/enabled", "/master/volume"]), "Master volume, limiter, EQ and effects must each appear in the actual diff.")
expect(masterReceipt.scopes[0].changes.contains { $0.property == "/master/limiter/enabled" && $0.before == "false" && $0.after == "true" }, "Limiter enablement must display its committed before and after values.")
var reorderedMixer = mixerBefore; reorderedMixer["tracks"] = [secondTrack, audioTrack]
let orderReceipt = receipt(mixerBefore, reorderedMixer)!
expect(orderReceipt.totalClips == 0 && orderReceipt.scopes[0].changes.contains { $0.property == "Track order" && $0.before == "[\"A1\",\"A2\"]" && $0.after == "[\"A2\",\"A1\"]" }, "Reordering tracks must show their actual ordered IDs without inventing layer changes.")
var addedTrackMixer = mixerBefore; addedTrackMixer["tracks"] = [audioTrack, secondTrack, ["id": "A3", "name": "Empty bus", "kind": "audio", "volume": -12, "clips": []]]
expect(receipt(mixerBefore, addedTrackMixer)?.scopes.contains { $0.trackID == "A3" && $0.status == "added" } == true, "An added empty mixer bus must remain visible in receipts.")
expect(receipt(addedTrackMixer, mixerBefore)?.scopes.contains { $0.trackID == "A3" && $0.status == "deleted" } == true, "A deleted empty mixer bus must remain visible in receipts.")
var extraMetadata = mixerBefore
extraMetadata["assets"] = ["dialogue.wav": ["duration": 3]]; extraMetadata["customMetadata"] = ["label": "Reviewed"]
let metadataReceipt = receipt(mixerBefore, extraMetadata)!
expect(metadataReceipt.totalClips == 0 && Set(metadataReceipt.scopes.flatMap { $0.changes.map(\.property) }) == Set(["/assets/dialogue.wav/duration", "/customMetadata"]), "Assets and future root metadata fields must retain their exact scopes and paths.")
var compMetadataBefore: [String: Any] = ["tracks": [], "comps": ["meta": ["name": "Meta", "tracks": [], "customMetadata": ["label": "Old"]]]]
var compMetadataAfter = compMetadataBefore; compMetadataAfter["comps"] = ["meta": ["name": "Meta", "tracks": [], "customMetadata": ["label": "New"]]]
expect(receipt(compMetadataBefore, compMetadataAfter)?.scopes[0].changes[0].property == "/customMetadata/label", "Future composition metadata must retain exact changed-property paths.")
let mixerJSON = try JSONSerialization.jsonObject(with: Data(trackReceipt.displayJSON.utf8)) as! [String: Any]
expect((mixerJSON["scopes"] as! [[String: Any]])[0]["track"] as? String == "A1", "JSON inspection must include the exact track identity alongside relative track property paths.")

let one: [String: Any] = ["tracks": [["id": "V1", "clips": [["id": "c", "enabled": true, "value": NSNull()]]]]]
let other: [String: Any] = ["tracks": [["id": "V2", "clips": [["id": "c", "enabled": 1, "a/b~c": 10]]]]]
let kinds = receipt(one, other)!
expect(kinds.clips[0].changes.contains { $0.property == "/track" && $0.before == "\"V1\"" && $0.after == "\"V2\"" }, "A track move must report both actual track IDs.")
expect(kinds.clips[0].changes.contains { $0.property == "/enabled" && $0.before == "true" && $0.after == "1" }, "JSON booleans must remain distinct from numbers.")
expect(kinds.clips[0].changes.contains { $0.property == "/value" && $0.before == "null" && $0.after == "Absent" }, "A removed null value must remain distinct from an absent value.")
expect(kinds.clips[0].changes.contains { $0.property == "/a~1b~0c" }, "Property paths must escape slash and tilde keys.")
expect(receipt(["fps": 30, "name": "A"], ["name": "A", "fps": 30]) == nil, "JSON dictionary order must not create a false change.")

let long = String(repeating: "界\n\"", count: 5_000)
var large: [String: Any] = ["tracks": [["id": "V1", "clips": (0..<100).map { ["id": "new\($0)", "label": long, "title": ["text": long]] as [String: Any] }]]]
let largeReceipt = receipt(["tracks": []], large)!
expect(largeReceipt.totalClips == 100 && largeReceipt.clips.count <= NativeChangeReceipt.maximumClips && largeReceipt.truncated, "Large receipts must retain the real count while limiting changed objects.")
expect(largeReceipt.displayBytes <= NativeChangeReceipt.maximumReceiptBytes, "The inspectable UTF-8 JSON must obey the receipt byte limit.")
expect(largeReceipt.clips.allSatisfy { $0.name.utf8.count <= NativeChangeReceipt.maximumNameBytes && $0.changes.allSatisfy { $0.before.utf8.count <= NativeChangeReceipt.maximumPreviewBytes && $0.after.utf8.count <= NativeChangeReceipt.maximumPreviewBytes } }, "Names and value previews must have UTF-8 byte bounds.")
let inspectedJSON = try JSONSerialization.jsonObject(with: Data(largeReceipt.displayJSON.utf8))
expect(inspectedJSON is [String: Any], "A shortened receipt must still produce valid JSON for inspection.")
large["tracks"] = [["clips": [["id": String(repeating: "x", count: 600), "label": "Do not truncate an identity"]]]]
let oversizedID = receipt(["tracks": []], large)!
expect(oversizedID.totalClips == 1 && oversizedID.clips.isEmpty && oversizedID.truncated, "Oversized IDs must omit selection details rather than target a truncated ID.")
var manyBefore: [String: Any] = ["id": "many"], manyAfter = manyBefore
for index in 0..<80 { manyBefore["p\(index)"] = 0; manyAfter["p\(index)"] = 1 }
let many = receipt(["tracks": [["clips": [manyBefore]]]], ["tracks": [["clips": [manyAfter]]]])!
expect(many.clips[0].changes.count == NativeChangeReceipt.maximumChanges && many.truncated, "One object must not exceed its changed-property limit.")
let hugeKey = String(repeating: "x", count: 600)
let longPath = receipt(["tracks": [["clips": [["id": "path", "value": [hugeKey: 0]]]]]], ["tracks": [["clips": [["id": "path", "value": [hugeKey: 1]]]]]])!
expect(longPath.truncated && longPath.clips[0].changes.allSatisfy { $0.property.utf8.count <= NativeChangeReceipt.maximumPathBytes }, "Oversized property names must not defeat the path bound.")
expect(longPath.clips[0].changes[0].property == "/value", "A shortened path must report its exact parent rather than invent a truncated property name.")

var history: [NativeChangeReceipt] = []
for version in 8..<48 {
    history = NativeChangeReceipt.appending(receipt(before, after, version: version)!, to: history)
}
expect(history.count == 30 && history.first?.version == 18 && history.last?.version == 47, "Receipt history must retain only the latest 30 commits.")
let inflated = NativeChangeReceipt(version: 50, who: "agent", at: 123, totalClips: 1, totalScopes: 0, clips: change.clips, scopes: [], truncated: true, displayJSON: String(repeating: "x", count: 200_000))
history = []
for _ in 0..<30 { history = NativeChangeReceipt.appending(inflated, to: history) }
expect(history.reduce(0) { $0 + $1.displayBytes } <= NativeChangeReceipt.maximumHistoryBytes && history.count < 30, "The history byte limit must hold independently of the receipt count.")

// Prepared fixtures call the actual NativeChangeReceipt builder. They do not read
// the referenced WAV or establish playback, listening quality or provider identity.
let assetPath = "media/generated/music/6bfc46a0-6b8d-4bcc-8a9d-9a08bdf45fb7/score.wav"
let assetPointer = "/assets/media~1generated~1music~16bfc46a0-6b8d-4bcc-8a9d-9a08bdf45fb7~1score.wav"
let registeredAsset = try JSONSerialization.jsonObject(with: Data(#"{"duration":12,"fps":0,"codec":"pcm_s24le","hasVideo":false,"hasAudio":true,"channels":2,"size":3456044,"name":"Quiet Water — Calm Instrumental","generated":{"kind":"original-music","renderer":"arya-score-synth/1","score":{"version":1,"title":"Quiet Water — Calm Instrumental","bpm":80,"lengthBeats":16,"seed":1042026,"masterDb":-3,"room":0.24,"parts":[{"id":"warm-keys","instrument":"keys","gainDb":-5,"pan":-0.12,"notes":[{"at":0,"duration":3.5,"pitch":60,"velocity":0.46},{"at":0,"duration":3.5,"pitch":64,"velocity":0.46},{"at":0,"duration":3.5,"pitch":67,"velocity":0.46},{"at":0,"duration":3.5,"pitch":71,"velocity":0.46},{"at":4,"duration":3.5,"pitch":57,"velocity":0.44},{"at":4,"duration":3.5,"pitch":60,"velocity":0.44},{"at":4,"duration":3.5,"pitch":64,"velocity":0.44},{"at":4,"duration":3.5,"pitch":67,"velocity":0.44},{"at":8,"duration":3.5,"pitch":53,"velocity":0.43},{"at":8,"duration":3.5,"pitch":57,"velocity":0.43},{"at":8,"duration":3.5,"pitch":60,"velocity":0.43},{"at":8,"duration":3.5,"pitch":64,"velocity":0.43},{"at":12,"duration":3,"pitch":55,"velocity":0.42},{"at":12,"duration":3,"pitch":60,"velocity":0.42},{"at":12,"duration":3,"pitch":64,"velocity":0.42},{"at":12,"duration":3,"pitch":67,"velocity":0.42}]},{"id":"soft-pad","instrument":"pad","gainDb":-15,"pan":0.1,"notes":[{"at":0,"duration":7.5,"pitch":48,"velocity":0.4},{"at":0,"duration":7.5,"pitch":55,"velocity":0.4},{"at":8,"duration":6.5,"pitch":53,"velocity":0.36},{"at":8,"duration":6.5,"pitch":60,"velocity":0.36}]},{"id":"gentle-melody","instrument":"pluck","gainDb":-10,"pan":0.18,"notes":[{"at":1,"duration":1.5,"pitch":76,"velocity":0.4},{"at":3,"duration":1,"pitch":74,"velocity":0.34},{"at":5,"duration":2,"pitch":72,"velocity":0.4},{"at":8.5,"duration":1.5,"pitch":69,"velocity":0.36},{"at":10.5,"duration":1,"pitch":67,"velocity":0.34},{"at":12.5,"duration":2,"pitch":72,"velocity":0.38}]}]},"measurement":{"samplePeakDb":-7.43242032732476,"rmsDb":-23.313517954124023,"samples":1152000},"provenance":"Locally synthesized from an original structured score; no external music model or recordings.","contentSHA256":"f8a00f31dae445190dd9eb185f64a1de86033f74e3b929551683626fd61791e5","contentBytes":3456044}}"#.utf8)) as! [String: Any]
let assetBefore: [String: Any] = ["assets": [:] as [String: Any], "tracks": [["id": "A3", "name": "Music", "kind": "audio", "clips": []]]]
var assetSaved = assetBefore; assetSaved["assets"] = [assetPath: registeredAsset]
let assetReceipt = receipt(assetBefore, assetSaved)!
expect(assetReceipt.totalClips == 0 && assetReceipt.totalScopes == 1, "Registration must not invent placement.")
expect(assetReceipt.summary == "Media assets changed", "Asset-only registration must not be called project settings.")
expect(assetReceipt.hasAssetChanges && assetReceipt.scopes[0].status == "added", "Registration must retain the added status.")
expect(assetReceipt.scopes[0].name.contains(assetPath), "The asset group must identify the actual path.")
expect(assetReceipt.scopes[0].changes.contains { $0.property == assetPointer + "/generated/provenance" && $0.after.contains("Locally synthesized") }, "Local provenance must survive the large score preview.")
expect(assetReceipt.scopes[0].changes.contains { $0.property == assetPointer + "/generated/contentSHA256" && $0.after.contains("f8a00f31dae445190dd9eb185f64a1de86033f74e3b929551683626fd61791e5") }, "The receipt must show the recorded digest without replacing identity.")
expect(assetReceipt.scopes[0].changes.contains { $0.property == assetPointer + "/codec" && $0.before == "Absent" && $0.after == "\"pcm_s24le\"" }, "Format metadata must retain exact before and after values.")
expect(assetReceipt.truncated && assetReceipt.displayBytes <= NativeChangeReceipt.maximumReceiptBytes, "A shortened score must declare its existing display bound.")
var mixedAssets = assetSaved; mixedAssets["fps"] = 24
let mixedAssetReceipt = receipt(assetBefore, mixedAssets)!
expect(mixedAssetReceipt.summary == "Media assets changed · Project or track settings changed", "Mixed settings and asset changes must retain both labels.")
expect(mixedAssetReceipt.scopes.contains { $0.changes.contains { $0.property == "/fps" } }, "The original settings difference must survive.")
var placedAsset = assetSaved
placedAsset["tracks"] = [["id": "A3", "name": "Music", "kind": "audio", "clips": [["id": "c17", "kind": "audio", "src": assetPath, "start": 12, "dur": 12]]]]
let placementReceipt = receipt(assetSaved, placedAsset)!
expect(placementReceipt.summary == "1 object changed" && !placementReceipt.hasAssetChanges, "Placement-only retry must not claim new asset registration.")
expect(NativeChangeReceipt.selection(for: placementReceipt.clips[0], in: placedAsset)?.start == 12, "The existing selection action must preserve the actual placement time.")
let combinedReceipt = receipt(assetBefore, placedAsset)!
expect(combinedReceipt.summary == "1 object changed · Media assets changed", "A combined receipt must distinguish registration and the editable object.")
let deletedAsset = receipt(assetSaved, assetBefore)!
expect(deletedAsset.scopes[0].status == "deleted" && deletedAsset.hasAssetChanges, "Removal must retain its deleted Media status.")
expect(deletedAsset.scopes[0].changes.contains { $0.property == assetPointer + "/generated/provenance" && $0.after == "Absent" }, "Removed metadata must preserve the absent value.")
var revisedAsset = registeredAsset; revisedAsset["name"] = "Revised cue"
var revisedProject = assetSaved; revisedProject["assets"] = [assetPath: revisedAsset]
let revisedReceipt = receipt(assetSaved, revisedProject)!
expect(revisedReceipt.scopes[0].status == "changed" && revisedReceipt.scopes[0].changes.count == 1, "Changing asset metadata must preserve one exact changed field.")
expect(receipt(assetSaved, assetSaved) == nil, "An unchanged registration must remain a no-op.")
var unusualAsset = assetBefore; unusualAsset["assets"] = ["a/b~c.wav": ["generated": NSNull()]]
expect(receipt(assetBefore, unusualAsset)!.scopes[0].changes.contains { $0.property == "/assets/a~1b~0c.wav/generated" && $0.after == "null" }, "Asset paths and null values must retain JSON pointer escaping.")
var emptyAsset = assetBefore; emptyAsset["assets"] = ["empty": [:] as [String: Any]]
expect(receipt(assetBefore, emptyAsset)!.scopes[0].changes.contains { $0.property == "/assets/empty" && $0.before == "Absent" && $0.after == "{}" }, "An empty record addition must not disappear.")
let unchangedAsset = try JSONSerialization.data(withJSONObject: registeredAsset, options: [.sortedKeys])
let preservedAsset = try JSONSerialization.data(withJSONObject: (assetSaved["assets"] as! [String: Any])[assetPath]!, options: [.sortedKeys])
expect(unchangedAsset == preservedAsset, "Receipt construction must preserve the captured metadata.")

print("Passed \(assertions) native change-receipt assertions.")
