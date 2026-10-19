#!/usr/bin/env python3
"""Run production preview captures and viewer transform planning against stale contexts."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
model = (root / 'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()
viewer = (root / 'native/App/Shared/NativeEditor/NativeViewer.swift').read_text()
projection = (root / 'native/App/Shared/NativeEditor/NativeProject.swift').read_text()
def block(source, marker):
    start = source.index(marker); begin = source.index('{', start); end = begin + 1; depth = 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}'); end += 1
    return source[start:end]

source = 'import Foundation\n' + block(projection, 'extension Dictionary where Key == String, Value == Any {') + '\n'
source += block(model, 'struct NativeRenderPreviewCapture {') + '\n' + block(viewer, 'enum NativeViewerTransformEdits {')
source += '''
@MainActor final class Model {
    var generation = UUID(), projectRevision = UUID()
    var folder: URL? = URL(fileURLWithPath: "/fixture"), version = 7
    var composition: String? = "nested", selectedIDs: Set<String> = ["c1"], time: Double = 1
    var project: Int? = 1, renderer: Int? = 1, metalFrame: Int? = 1
    var renderError: String?, previewOwnershipID: UUID?
    var playing = false, scrubbing = false, busy = false, previewing = false
    var displayedTime: Double? = 1, displayedVersion: Int? = 7, displayedRevision: UUID?, displayedComposition: String? = "nested", displayedPreviewID: UUID?
    var previewCapture: NativeRenderPreviewCapture?, previewOperations: String?
    var viewerColorPicker: Int?
    var showingSource = false
    var displayedGeneration: UUID?, displayedFolder: URL?
    var requests = 0
    init() { displayedRevision = projectRevision; displayedGeneration = generation; displayedFolder = folder }
    func requestFrame() { requests += 1 }
'''
for marker in ['    func beginRenderPreview(', '    func renderPreviewMatches(', '    func renderPreviewCommitMatches(', '    func preview(', '    func discardRenderPreview(']:
    source += block(model, marker) + '\n'
source += '''
}
@main struct Checks {
    static var count = 0
    static func check(_ value: @autoclosure () -> Bool) { precondition(value()); count += 1 }
    @MainActor static func main() throws {
        let m = Model(), op: [[String: Any]] = [["op": "update", "id": "c1", "set": ["x": 10]]]
        let c = m.beginRenderPreview(renderedVersion: 7)!
        check(m.preview(op, capture: c)); check(m.previewing)
        let edits = try JSON.parse(m.previewOperations!) as! [[String: Any]]
        check(edits[0]["comp"] as? String == "nested"); check(m.renderPreviewMatches(c))
        check(m.preview([], capture: c)); check(!m.previewing && m.previewOperations == nil && m.renderPreviewMatches(c))
        check(m.preview(op, capture: c)); m.discardRenderPreview(c); check(!m.previewing && !m.renderPreviewMatches(c))
        check(m.renderPreviewCommitMatches(c))
        let nextCapture = m.beginRenderPreview(renderedVersion: 7)!
        check(!m.renderPreviewCommitMatches(c)); check(m.renderPreviewCommitMatches(nextCapture))
        m.discardRenderPreview(nextCapture)
        for axis in 0..<16 {
            let dispatch = Model(), capture = dispatch.beginRenderPreview(renderedVersion: 7)!
            dispatch.discardRenderPreview(capture)
            switch axis {
            case 0: dispatch.generation = UUID()
            case 1: dispatch.projectRevision = UUID()
            case 2: dispatch.folder = URL(fileURLWithPath: "/other")
            case 3: dispatch.version += 1
            case 4: dispatch.composition = nil
            case 5: dispatch.selectedIDs = ["c2"]
            case 6: dispatch.time = 2
            case 7: dispatch.playing = true
            case 8: dispatch.scrubbing = true
            case 9: dispatch.showingSource = true
            case 10: dispatch.renderer = nil
            case 11: dispatch.metalFrame = nil
            case 12: dispatch.renderError = "Failed"
            case 13: dispatch.displayedPreviewID = UUID()
            case 14: dispatch.project = nil
            default:
                let newer = dispatch.beginRenderPreview(renderedVersion: 7)!
                dispatch.discardRenderPreview(newer)
            }
            check(!dispatch.renderPreviewCommitMatches(capture))
        }
        let easing = Model(), easeCapture = easing.beginRenderPreview(renderedVersion: 7)!
        check(easing.preview([["op":"keyframe_ease","id":"c1","prop":"x","index":0,"ease":"smooth"]],capture:easeCapture))
        check(easing.previewOperations != nil)
        for axis in 0..<11 {
            let m = Model(), c = m.beginRenderPreview(renderedVersion: 7)!
            switch axis {
            case 0: m.generation = UUID()
            case 1: m.projectRevision = UUID()
            case 2: m.folder = URL(fileURLWithPath: "/other")
            case 3: m.version += 1
            case 4: m.composition = nil
            case 5: m.selectedIDs = ["c2"]
            case 6: m.time = 2
            case 7: m.playing = true
            case 8: m.scrubbing = true
            case 9: m.busy = true
            default: m.previewCapture = nil
            }
            check(!m.renderPreviewMatches(c)); check(!m.preview(op, capture: c)); check(m.requests == 0 && !m.previewing)
        }
        for axis in 0..<7 {
            let m = Model()
            switch axis {
            case 0: m.displayedTime = 0
            case 1: m.displayedVersion = 6
            case 2: m.displayedRevision = UUID()
            case 3: m.displayedComposition = nil
            case 4: m.busy = true
            case 5: m.renderer = nil
            default: m.displayedPreviewID = UUID()
            }
            check(m.beginRenderPreview(renderedVersion: 7) == nil)
        }
        let stale = Model(), draftCapture = stale.beginRenderPreview(renderedVersion: 7)!
        check(stale.preview(op, capture: draftCapture)); stale.displayedPreviewID = draftCapture.id
        stale.discardRenderPreview(draftCapture); check(stale.requests == 2)
        check(stale.beginRenderPreview(renderedVersion: 7) == nil)
        stale.displayedPreviewID = nil; check(stale.beginRenderPreview(renderedVersion: 7) != nil)
        let returning = Model(), returnCapture = returning.beginRenderPreview(renderedVersion: 7)!
        check(returning.preview(op, capture: returnCapture)); returning.displayedPreviewID = returnCapture.id
        check(returning.preview([], capture: returnCapture)); check(returning.previewOperations == nil)
        returning.discardRenderPreview(returnCapture); check(returning.requests == 3)
        check(returning.beginRenderPreview(renderedVersion: 7) == nil)
        let other = m.beginRenderPreview(renderedVersion: 7)!
        m.discardRenderPreview(c); check(m.renderPreviewMatches(other))
        check(!m.preview([["op": "add_title"]], capture: other)); check(m.previewCapture == nil)
        let limited = m.beginRenderPreview(renderedVersion: 7)!
        check(!m.preview(Array(repeating: op[0], count: 257), capture: limited))
        let size = m.beginRenderPreview(renderedVersion: 7)!
        check(!m.preview([["op": "update", "id": "c1", "set": ["label": String(repeating: "a", count: 256 * 1024)]]], capture: size))
        m.composition = nil; m.displayedComposition = nil
        let main = m.beginRenderPreview(renderedVersion: 7)!
        check(m.preview(op, capture: main)); let mainEdits = try JSON.parse(m.previewOperations!) as! [[String: Any]]
        check(mainEdits[0]["comp"] is NSNull)
        let clip: [String: Any] = ["id": "c1", "start": 0, "dur": 4]
        let pose: [String: Any] = ["x": 40.0, "y": 45.0, "scale": 1.5, "parentMatrix": [0.0, 2.0, -3.0, 0.0, 60.0, 0.0]]
        let move = try NativeViewerTransformEdits.make(clip: clip, pose: pose, at: 1, deltaX: 12, deltaY: 10, mode: "move")
        let fields = move[0].dictionary("set"); check(fields.number("x") == 45); check(fields.number("y") == 41)
        let scale = try NativeViewerTransformEdits.make(clip: clip, pose: pose, at: 1, magnification: 2, mode: "scale")
        check(scale[0].dictionary("set").number("scale") == 3)
        var animated = clip; animated["anim"] = ["x": [[0, 10], [1, 40, "smooth"]] as [[Any]], "scale": [[0, 1], [2, 2]] as [[Any]]]
        let keyed = try NativeViewerTransformEdits.make(clip: animated, pose: pose, at: 1, deltaX: 12, deltaY: 10, mode: "move")
        check(keyed.count == 2); check(keyed[0].dictionary("set").number("y") == 41)
        check(keyed[1].string("op") == "keyframe" && keyed[1].string("prop") == "x" && keyed[1].string("ease") == "smooth")
        check(keyed[1].number("at") == 1 && keyed[1].flag("local"))
        let keyedScale = try NativeViewerTransformEdits.make(clip: animated, pose: pose, at: 1, magnification: 2, mode: "scale")
        check(keyedScale[0].string("op") == "keyframe" && keyedScale[0].number("value") == 3)
        let noMove = try NativeViewerTransformEdits.make(clip: clip, pose: pose, at: 1, mode: "move"); check(noMove.isEmpty)
        for invalid in 0..<8 {
            var input = clip, values = pose; var time = 1.0, dx = 12.0, mag = 2.0
            switch invalid {
            case 0: input["expr"] = ["x": "value + time"]
            case 1: values["parentMatrix"] = [0.0, 0, 0, 0, 0, 0]
            case 2: values["parentMatrix"] = [1.0, 0]
            case 3: values["x"] = Double.nan
            case 4: time = 4
            case 5: dx = .infinity
            case 6: mag = 0
            default: input["id"] = ""
            }
            do { _ = try NativeViewerTransformEdits.make(clip: input, pose: values, at: time, deltaX: dx, magnification: mag, mode: "move"); fatalError("Invalid viewer edit accepted") } catch { count += 1 }
        }
        print("Passed \\(count) production preview, stale-context and evaluated viewer transform checks.")
    }
}
'''
# Source reads remain tied to the production publication guards.
assert 'projectRevision == request.revision' in model
assert 'previewCapture?.id == request.previewID' in model
assert 'displayedVersion = request.version' in model
assert 'displayedPreviewID = request.operations == nil ? nil : request.previewID' in model
assert 'model.discardRenderPreview(source.capture)' in viewer
assert 'redraw: operations.isEmpty' not in viewer
assert '.onDisappear { cancelGesture()' in viewer
with tempfile.TemporaryDirectory(prefix='reel-render-preview-') as temp:
    folder = Path(temp); script = folder / 'Checks.swift'; script.write_text(source); binary = folder / 'check'
    subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(folder / 'cache'), str(root / 'native/ReelKit/Sources/ReelKit/JSON.swift'), str(script), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
