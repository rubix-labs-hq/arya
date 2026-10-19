import Foundation
import Darwin

var assertions = 0
func expect(_ value: @autoclosure () -> Bool, _ message: String) {
    assertions += 1
    if !value() { fatalError(message) }
}
var selection = NativeEditorSelection()
selection.select(id: "a")
expect(selection.ids == ["a"] && selection.primary == "a", "A plain click selects one clip.")
selection.select(id: "b", extending: true)
expect(selection.ids == ["a", "b"] && selection.primary == "b", "An extending click preserves the existing selection.")
selection.select(id: "b", extending: true)
expect(selection.ids == ["a"] && selection.primary == "a", "Toggling the primary clip chooses a surviving primary.")
selection.select(ids: ["a", "b"], primary: "missing")
expect(selection.primary == "a", "A primary must belong to the selection.")
selection.reconcile(validIDs: ["b", "c"])
expect(selection.ids == ["b"] && selection.primary == "b", "Project changes remove deleted clips from the selection.")
selection.select(id: nil)
expect(selection.ids.isEmpty && selection.primary == nil, "Clearing selection clears its primary.")
for duration in [Double.nan, Double.infinity, -1, 0, 0.001] {
    expect(NativeSourceRange(duration: duration, fps: 30) == nil, "Invalid or sub-frame sources cannot produce a range.")
}
for fps in [Double.nan, Double.infinity, -1, 0, 1001] {
    expect(NativeSourceRange(duration: 10, fps: fps) == nil, "Invalid frame rates cannot produce a range.")
}
var range = NativeSourceRange(duration: 10.019, fps: 30)!
expect(range.duration == 10, "Source bounds must not round beyond available media.")
range.seek(2.017)
expect(abs(range.time - 2.033333333333333) < 1e-10, "Source seeks snap to frames.")
range.markIn(2); range.markOut(6)
expect(range.inPoint == 2 && range.outPoint == 6 && range.length == 4, "Marks retain a usable source window.")
range.markIn(9)
expect(abs(range.inPoint - (6 - 1.0 / 30)) < 1e-10, "An in mark cannot cross the out mark.")
range.markOut(0)
expect(abs(range.length - 1.0 / 30) < 1e-10, "An out mark keeps at least one source frame.")
range.seek(Double.nan); range.markIn(Double.infinity); range.markOut(Double.nan)
expect(range.time.isFinite && range.inPoint.isFinite && range.outPoint.isFinite, "Invalid numeric input cannot corrupt marks.")
range.clearMarks()
expect(range.inPoint == 0 && range.outPoint == 10, "Clearing marks restores the complete source.")
range.seek(-1); expect(range.time == 0, "Source seeks clamp at the start.")
range.seek(20); expect(range.time == 10, "Source seeks clamp at the end.")
range.markIn(2); range.markOut(6)
let tracks: [[String: Any]] = [["id": "V1", "kind": "video"], ["id": "V2", "kind": "video"], ["id": "A1", "kind": "audio"], ["id": "A2", "kind": "audio"]]
let modes = ["append", "insert", "overwrite", "connect"]
let operations = modes.map { range.operation($0, source: "media/source.mov", kind: "video", hasAudio: true, tracks: tracks, at: 3)! }
expect(operations[0]["start"] == nil, "Append uses the destination track end.")
expect(operations[1]["start"] as? Double == 3 && operations[1]["op"] as? String == "insert", "Insert uses the captured timeline playhead.")
expect(operations[2]["track"] as? String == "V1", "Overwrite targets the primary video track.")
expect(operations[3]["track"] as? String == "V2" && operations[3]["op"] as? String == "overwrite", "Connect places footage above the primary video track.")
expect(operations.allSatisfy { $0["in"] as? Double == 2 && $0["out"] as? Double == 6 }, "Each placement preserves both source marks.")
expect(range.operation("connect", source: "a", kind: "video", tracks: [tracks[0]], at: 0) == nil, "Connect cannot silently overwrite the primary track.")
expect(range.operation("insert", source: "a", kind: "video", tracks: [["id": "V1", "kind": "video", "locked": true]], at: 0) == nil, "Locked destinations cannot receive media.")
expect(range.operation("insert", source: "a", kind: "audio", tracks: tracks, at: 0)?["track"] as? String == "A1", "Audio sources use audio tracks.")
expect(range.operation("insert", source: "a", kind: "image", tracks: tracks, at: 0)?["dur"] as? Double == 4, "Image marks define timeline duration.")
expect(range.operation("insert", source: "a", kind: "image", tracks: tracks, at: 0)?["in"] as? Int == 0, "Image placement does not create a source offset.")
expect(range.operation("unknown", source: "a", kind: "video", tracks: tracks, at: 0) == nil, "Unsupported placements are rejected.")
expect(range.operation("insert", source: "", kind: "video", tracks: tracks, at: 0) == nil, "An absent source cannot be inserted.")
expect(range.operation("insert", source: "a", kind: "video", tracks: tracks, at: Double.nan) == nil, "A nonfinite timeline position cannot be inserted.")
expect(operations[3]["audioTrack"] as? String == "A2", "Connected footage keeps linked audio above the existing audio bed.")
expect(range.operation("connect", source: "a", kind: "video", hasAudio: true, tracks: Array(tracks.prefix(3)), at: 0) == nil, "Connected audio cannot overwrite the primary audio bed without an upper destination.")
let temporary = URL(fileURLWithPath: CommandLine.arguments[1]).deletingLastPathComponent()
let sourceFile = temporary.appendingPathComponent("source-a.bin"), replacementFile = temporary.appendingPathComponent("source-b.bin")
try Data([1, 2, 3]).write(to: sourceFile)
try Data([1, 2, 3]).write(to: replacementFile)
let identity = try NativeSourceFileIdentity(file: sourceFile)
let unchangedIdentity = try NativeSourceFileIdentity(file: sourceFile)
expect(identity == unchangedIdentity, "Unchanged source identity must remain stable.")
let symbolic = temporary.appendingPathComponent("source-link.bin")
try FileManager.default.createSymbolicLink(at: symbolic, withDestinationURL: sourceFile)
let linkIdentity = try NativeSourceFileIdentity(file: symbolic)
expect(identity == linkIdentity, "A source identity must include the resolved file.")
try FileManager.default.removeItem(at: symbolic)
try FileManager.default.createSymbolicLink(at: symbolic, withDestinationURL: replacementFile)
let retargetedIdentity = try NativeSourceFileIdentity(file: symbolic)
expect(identity != retargetedIdentity, "Retargeting a source link must invalidate its identity.")
var timestamp = [timespec(tv_sec: Int(identity.seconds), tv_nsec: Int(identity.nanoseconds)), timespec(tv_sec: Int(identity.seconds), tv_nsec: Int(identity.nanoseconds + 1))]
if timestamp[1].tv_nsec == 1_000_000_000 { timestamp[1].tv_sec += 1; timestamp[1].tv_nsec = 0 }
let changedStamp = sourceFile.path.withCString { Darwin.utimensat(AT_FDCWD, $0, &timestamp, 0) }
expect(changedStamp == 0, "The fixture must change its modification time.")
let changedIdentity = try NativeSourceFileIdentity(file: sourceFile)
expect(identity != changedIdentity, "A one-nanosecond source change must invalidate a source preview.")
let json = try JSONSerialization.data(withJSONObject: operations, options: [.sortedKeys])
try json.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
print("Passed \(assertions) native source-range and selection assertions.")
