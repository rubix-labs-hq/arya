#!/usr/bin/env python3
"""Check the source route, then optionally execute the extracted Swift controller."""
import argparse
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument("--contracts-only", action="store_true")
args = parser.parse_args()
editor = args.root / "native/App/Shared/NativeEditor"
timeline = (editor / "NativeTimeline.swift").read_text()
view = (editor / "NativeEditorView.swift").read_text()
checks = 0

def check(value, detail):
    global checks
    checks += 1
    if not value:
        raise AssertionError(detail)

def block(source, marker):
    start = source.index(marker)
    end = source.index("{", start) + 1
    depth = 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]

check('Button("Edit motion") { action("motion") }' in timeline, "Visual timeline clips need a manual Edit motion action")
helper = block(timeline, "    private func editMotion(")
check('!["audio", "caption"].contains(clip.kind)' in timeline, "The visual action must not appear for raw audio or caption clips")
check("model.processingContextID == context" in helper and "model.version == version" in helper and "model.composition == composition" in helper, "The controller must reject project, revision and composition drift")
check("expected == actual" in helper, "The controller must reject a changed or reused clip identity")
check("model.select(current)" in helper and helper.index("model.select(current)") < helper.index("openMotion()"), "The target layer must become primary before opening Motion")
check("model.showingSource = false" in helper, "The timeline viewer must replace the source viewer")
check("model.edit" not in helper and "model.call" not in helper, "Opening Motion must not dispatch an edit or provider request")
check("context: motionContext, version: motionVersion, composition: motionComposition" in timeline, "The menu must use its rendered identity capture")
timeline_calls = [line for line in view.splitlines() if "NativeTimeline(model: model," in line]
check(bool(timeline_calls) and all("openMotion:" in line for line in timeline_calls), "Every mounted timeline must provide Motion navigation")
check("openMotion: { select(.motion) }" in view, "Desktop navigation must restore the visible inspector")
compact_timeline = block(view, "    private func compactTimeline(")
# One timeline instance serves every iPad layout; it routes as compact unless a regular layout passes compact: false.
check("compact: Bool = true" in compact_timeline.split("{", 1)[0] and compact_timeline.count("openMotion: { select(.motion, compact: compact) }") == 2, "The persistent compact timeline must use the contextual workspace route")
compact_canvas = block(view, "    private func compactCanvas(")
canvas_call = compact_canvas.split("compactTimeline(height: layout.timelineHeight,", 1)[1].split(".frame(width: layout.timelineWidth)", 1)[0] if "compactTimeline(height: layout.timelineHeight," in compact_canvas else None
check(canvas_call is not None and "compact:" not in canvas_call, "The persistent compact canvas timeline must keep the compact default route")
select = block(view, "    private func select(_ panel:")
check("inspectorVisible = true" in select, "Desktop Motion must restore the inspector")
check("NativeCompactWorkspaceRouting.inlineWorkspaces.contains(panel)" in select and "model.panel = panel" in select and "setCompactToolsExpanded(true)" in select, "Compact Motion must select its workspace and expand contextual controls")
print(f"Native Motion route source contracts: {checks} assertions passed")
if args.contracts_only:
    raise SystemExit(0)

source = r'''
import Foundation
struct NativeClip {
    var fields: [String: Any]
    var id: String { fields["id"] as? String ?? "" }
    var kind: String { fields["kind"] as? String ?? "" }
}
struct NativeTrack { var clips: [NativeClip] }
final class NativeEditorModel {
    var processingContextID = UUID(), version = 4
    var composition: String?
    var tracks: [NativeTrack] = []
    var showingSource = true, status = "", selectedID = "", panel = "edit"
    var selectedIDs: Set<String> = ["other"], selections = 0
    var inspectorVisible = false, mobilePanel: String?
    func select(_ clip: NativeClip) { selectedID = clip.id; selectedIDs = [clip.id]; selections += 1 }
}
final class TimelineController {
    let model: NativeEditorModel
    var compact: Bool, routes = 0
    init(_ model: NativeEditorModel, compact: Bool) { self.model = model; self.compact = compact }
    func openMotion() {
        routes += 1; model.panel = "motion"
        if compact { model.mobilePanel = "motion" } else { model.inspectorVisible = true }
    }
'''
source += helper.replace("private func editMotion", "func editMotion")
source += r'''
}
var checks = 0
func check(_ condition: @autoclosure () -> Bool, _ detail: String) {
    checks += 1
    if !condition() { fatalError(detail) }
}
func setup(_ kind: String = "shape", compact: Bool = false) -> (NativeEditorModel, TimelineController, NativeClip) {
    let model = NativeEditorModel(), clip = NativeClip(fields: ["id": "c1", "kind": kind, "start": 0, "dur": 5])
    model.tracks = [NativeTrack(clips: [clip])]
    return (model, TimelineController(model, compact: compact), clip)
}
for compact in [false, true] {
    for kind in ["shape", "title", "image", "video", "null", "comp", "adjustment", "color"] {
        let (model, controller, clip) = setup(kind, compact: compact)
        controller.editMotion(clip: clip, context: model.processingContextID, version: model.version, composition: model.composition)
        check(controller.routes == 1 && model.selectedID == "c1" && model.selectedIDs == ["c1"], "Motion must open the exact selected visual layer")
        check(!model.showingSource && model.panel == "motion", "Motion must show the timeline viewer and Motion panel")
        check(compact ? model.mobilePanel == "motion" : model.inspectorVisible, "Motion must restore the correct existing navigation route")
    }
}
let drifts: [(String, (NativeEditorModel) -> Void)] = [
    ("project", { $0.processingContextID = UUID() }),
    ("revision", { $0.version += 1 }),
    ("composition", { $0.composition = "k1" }),
    ("removed clip", { $0.tracks = [] }),
    ("reused clip", { $0.tracks[0].clips[0].fields["dur"] = 8 }),
    ("invalid fields", { $0.tracks[0].clips[0].fields["x"] = Double.nan }),
]
for (name, drift) in drifts {
    let (model, controller, clip) = setup()
    let context = model.processingContextID, version = model.version, composition = model.composition
    drift(model)
    controller.editMotion(clip: clip, context: context, version: version, composition: composition)
    check(controller.routes == 0 && model.selections == 0 && model.showingSource, "Stale \(name) must not change navigation, viewer or selection")
    check(!model.status.isEmpty, "Stale \(name) must explain why the menu needs reopening")
}
for kind in ["audio", "caption"] {
    let (model, controller, clip) = setup(kind)
    controller.editMotion(clip: clip, context: model.processingContextID, version: model.version, composition: nil)
    check(controller.routes == 0 && model.selections == 0, "Nonvisual target must not open the visual motion route")
}
print("Extracted Native Motion controller: \(checks) assertions passed")
'''
with tempfile.TemporaryDirectory(prefix="arya-native-motion-route-") as temporary:
    scratch = Path(temporary)
    swift = scratch / "main.swift"
    swift.write_text(source)
    binary = scratch / "motion-route"
    subprocess.run(["swiftc", "-module-cache-path", str(scratch / "module-cache"), str(swift), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
