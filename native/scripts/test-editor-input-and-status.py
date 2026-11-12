#!/usr/bin/env python3
"""Check the production helpers behind scroll-safe editing, export repeats, graph labels and status copy.

Each helper is extracted from the shipping Swift source and run without SwiftUI:
- a pan across the color curve or viewer is not an edit, while a tap or a held drag is
- motion graph labels stay distinct for small ranges such as Scale 1.00 to 1.08
- stills without sound are told apart from clips with real audio
- a repeated Export tap is ignored, a deliberate later export is not
- activity lines become plain status text without internal IDs, failures keep their detail
- curve and timeline guidance use touch words on iPhone and iPad, pointer words on Mac

Pass --source-root <repo> to run the same checks against another checkout.
"""
from pathlib import Path
import argparse
import re
import subprocess
import tempfile


def block(text, marker):
    start = text.index(marker)
    end = text.index('{', start) + 1
    depth = 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


HARNESS = r'''
import Foundation
import CoreGraphics
var checks = 0
func require(_ value: Bool, _ message: String) { checks += 1; if !value { fatalError(message) } }

@main struct EditorInputAndStatusChecks {
    static func main() {
        // Color curve: only a tap or a drag that starts on a point can change the curve.
        let size = CGSize(width: 300, height: 220)
        let curve: [[Double]] = [[0, 0], [1, 1]]
        if case .add(let next, let index)? = NativeCurveHit.tap(curve, at: CGPoint(x: 150, y: 60), size: size) {
            require(next.count == 3 && index == 1, "A tap on empty graph space adds one point in order")
        } else { require(false, "A tap on empty graph space adds a point") }
        require(NativeCurveHit.tap(curve, at: NativeCurveHit.position([1, 1], size: size), size: size) == .select(1), "A tap on a point selects it")
        require(NativeCurveHit.tap(Array(repeating: [0.5, 0.5], count: 16).enumerated().map { [Double($0.offset) / 16, 0.5] }, at: CGPoint(x: 155, y: 30), size: size) == nil, "A full curve ignores taps")
        require(NativeCurveHit.nearest(curve, to: CGPoint(x: 150, y: 110), size: size, radius: NativeCurveHit.handleSize / 2) == nil, "Empty graph space under a swipe has no point to drag")
        require(NativeCurveHit.handleSize <= 44, "Curve handles stay small enough for a swipe to pass between them")
        // A touch on a point that does not travel is a tap. It must not move the point or commit.
        require(!NativeCurveHit.dragStarts(.zero), "A touch that does not move is not a drag")
        require(!NativeCurveHit.dragStarts(CGSize(width: 2, height: 2)), "A tiny wobble is not a drag")
        require(NativeCurveHit.dragStarts(CGSize(width: 0, height: NativeCurveHit.dragSlop)), "Travel past the slop is a drag")
        // A drag that starts 10 points off a point's centre moves it by the drag only, with no jump to the finger.
        let middle: [Double] = [0.5, 0.5]
        require(NativeCurveHit.dragged(middle, by: .zero, size: size) == middle, "A drag of zero leaves the point where it was")
        let nudged = NativeCurveHit.dragged(middle, by: CGSize(width: 28, height: 0), size: size)
        require(abs(nudged[0] - 0.6) < 1e-9 && abs(nudged[1] - 0.5) < 1e-9, "A 28 point drag on a 280 point chart moves the point by 0.1: \(nudged)")
        require(NativeCurveHit.dragged(middle, by: CGSize(width: 900, height: -900), size: size) == [1, 1], "Dragged points stay inside the graph")
        // Mac pointer: a click on a point only selects it. Only travel past the slop moves it.
        let beside = NativeCurveHit.position(middle, size: size)
        let near = CGPoint(x: beside.x + 10, y: beside.y)
        let three: [[Double]] = [[0, 0], middle, [1, 1]]
        require(NativeCurveHit.press(three, at: near, translation: .zero, size: size) == .wait, "A click 10 points from a point waits instead of moving it")
        require(NativeCurveHit.press(three, at: near, translation: CGSize(width: 2, height: 0), size: size) == .wait, "A wobble under the slop still waits")
        require(NativeCurveHit.press(three, at: near, translation: CGSize(width: 6, height: 0), size: size) == .move(1), "A drag past the slop moves the nearest point")
        require(NativeCurveHit.press(three, at: CGPoint(x: 80, y: 40), translation: .zero, size: size) == .add, "A press on empty graph space adds a point")
        require(NativeCurveHit.press((0..<16).map { [Double($0) / 16, 0.5] }, at: CGPoint(x: 155, y: 30), translation: .zero, size: size) == nil, "A full curve ignores presses on empty space")

        // Viewer: a quick pan on a layer body scrolls; a held drag moves; handles edit at once.
        typealias G = NativeViewerGeometry
        require(G.touchIntent(target: .move, held: 0.05, moved: 40) == .ignore, "A quick swipe over a layer must not move it")
        require(G.touchIntent(target: .move, held: 0.3, moved: 40) == .edit, "A held drag on a layer moves it")
        require(G.touchIntent(target: nil, held: 1, moved: 40) == .ignore, "A drag over empty viewer space edits nothing")
        require(G.touchIntent(target: .scale(0), held: 0, moved: 6) == .edit, "A drag on a scale handle edits at once")
        require(G.touchIntent(target: .rotate, held: 0, moved: 6) == .edit, "A drag on the rotate handle edits at once")
        require(G.touchIntent(target: .move, held: 0.05, moved: 1) == .undecided, "Movement under the slop does not decide")
        require(G.touchIntent(target: .move, held: .nan, moved: 40) == .undecided, "Invalid timing does not decide")

        // Motion graph labels.
        let scale = NativeMotionGraphLayout.axisLabels(upper: 1.08, lower: 1.0, steps: 4)
        require(Set(scale).count == scale.count, "Scale labels from 1.00 to 1.08 must be distinct: \(scale)")
        require(scale.first == "1.08" && scale.last == "1.00", "Scale labels show the actual ends: \(scale)")
        let position = NativeMotionGraphLayout.axisLabels(upper: 1000, lower: 0, steps: 4)
        require(position == ["1,000", "750", "500", "250", "0"] || position == ["1000", "750", "500", "250", "0"], "Wide ranges keep whole numbers: \(position)")
        let around = NativeMotionGraphLayout.axisLabels(upper: 0.5, lower: -0.5, steps: 4)
        require(around.contains("0.0") || around.contains("0.00") || around.contains("0"), "Zero shows without a minus sign: \(around)")
        require(!around.contains { $0.hasPrefix("-0") && Double($0) == 0 }, "Negative zero never shows: \(around)")
        require(NativeMotionGraphLayout.axisLabels(upper: 1, lower: 1, steps: 4).count == 5, "A flat range still gives one label per step")
        // Huge but finite key values: the range between them overflows if subtracted directly.
        let huge = NativeMotionGraphLayout.axisLabels(upper: 9.28e307, lower: -9.28e307, steps: 4)
        require(huge.count == 5, "Huge finite bounds still give labels: \(huge)")
        let hugeKeys = [NativeMotionKey(property: "x", index: 0, at: 0, value: -8e307, ease: nil), NativeMotionKey(property: "x", index: 1, at: 1, value: 8e307, ease: nil)]
        let hugeLayout = NativeMotionGraphLayout(keys: hugeKeys, duration: 1, mode: .value)
        require(hugeLayout.upper.isFinite && hugeLayout.lower.isFinite && (hugeLayout.upper - hugeLayout.lower).isFinite, "Huge keys give a finite graph range")
        require(hugeLayout.valueLabels.count == 5, "Huge keys still give axis labels")
        let flatHuge = NativeMotionGraphLayout(keys: [NativeMotionKey(property: "x", index: 0, at: 0, value: 1e300, ease: nil)], duration: 1, mode: .value)
        require(flatHuge.upper > flatHuge.lower && flatHuge.valueLabels.count == 5, "A flat huge value still gives a range")

        // Motion property kept from another clip.
        let standard = ["x", "y", "scale"]
        require(NativeMotionPropertyChoice.resolved("mask.mk1.feather", standard: standard, animated: []) == "x", "A custom property the clip lacks falls back to the first standard one")
        require(NativeMotionPropertyChoice.resolved("mask.mk1.feather", standard: standard, animated: ["mask.mk1.feather"]) == "mask.mk1.feather", "A custom property the clip has stays")
        require(NativeMotionPropertyChoice.resolved("scale", standard: standard, animated: []) == "scale", "A standard property stays")

        // Audio presence.
        let project: [String: Any] = [
            "assets": ["clip.mov": ["hasAudio": true], "still.png": ["hasAudio": false], "silent.mov": ["hasAudio": false]],
            "comps": ["k1": ["tracks": [["kind": "audio", "clips": [["id": "c9", "kind": "audio"]]]]], "k2": ["tracks": [["kind": "video", "clips": []]]]]
        ]
        require(!NativeAudioPresence.clipHasAudio(["kind": "image", "src": "still.png"], project: project), "A still has no audio controls")
        require(!NativeAudioPresence.clipHasAudio(["kind": "title"], project: project), "A title has no audio controls")
        require(!NativeAudioPresence.clipHasAudio(["kind": "video", "src": "silent.mov"], project: project), "Silent video has no audio controls")
        require(NativeAudioPresence.clipHasAudio(["kind": "video", "src": "clip.mov"], project: project), "Video with sound keeps audio controls")
        require(!NativeAudioPresence.clipHasAudio(["kind": "video", "src": "clip.mov", "audioDetached": true], project: project), "Detached video audio lives on its audio clip")
        require(NativeAudioPresence.clipHasAudio(["kind": "audio", "src": "clip.mov", "mute": true], project: project), "A muted audio clip keeps its controls so it can be unmuted")
        require(NativeAudioPresence.clipHasAudio(["kind": "comp", "comp": "k1"], project: project), "A composition with audio keeps audio controls")
        require(!NativeAudioPresence.clipHasAudio(["kind": "comp", "comp": "k2"], project: project), "A composition without audio has none")
        let layered: [String: Any] = [
            "assets": ["clip.mov": ["hasAudio": true], "still.png": ["hasAudio": false]],
            "comps": [
                "k3": ["tracks": [["kind": "video", "clips": [["id": "c3", "kind": "video", "src": "clip.mov"]]]]],
                "k4": ["tracks": [["kind": "video", "clips": [["id": "c4", "kind": "comp", "comp": "k3"]]]]],
                "k5": ["tracks": [["kind": "video", "clips": [["id": "c5", "kind": "image", "src": "still.png"]]]]],
                "k6": ["tracks": [["kind": "video", "clips": [["id": "c6", "kind": "comp", "comp": "k6"]]]]]
            ]
        ]
        require(NativeAudioPresence.clipHasAudio(["kind": "comp", "comp": "k3"], project: layered), "A composition whose video carries sound has audio controls")
        require(NativeAudioPresence.clipHasAudio(["kind": "comp", "comp": "k4"], project: layered), "Sound from a nested composition counts")
        require(!NativeAudioPresence.clipHasAudio(["kind": "comp", "comp": "k5"], project: layered), "A composition of stills has no sound")
        require(!NativeAudioPresence.clipHasAudio(["kind": "comp", "comp": "k6"], project: layered), "A composition that contains itself ends the search")

        // Export repeats.
        var guardrail = NativeExportRepeatGuard()
        let request: [String: Any] = ["preset": "h264", "name": "Export", "width": 1920, "height": 1080]
        let signature = NativeExportRepeatGuard.signature(request, version: 4)
        let start = Date(timeIntervalSince1970: 1000)
        require(!guardrail.isRepeat(signature, at: start), "The first export starts")
        guardrail.record(signature, at: start)
        require(guardrail.isRepeat(signature, at: start.addingTimeInterval(0.12)), "A second tap 120 ms later is the same export")
        require(!guardrail.isRepeat(signature, at: start.addingTimeInterval(3)), "A deliberate export a few seconds later starts")
        var renamed = request; renamed["name"] = "Export 2"
        require(!guardrail.isRepeat(NativeExportRepeatGuard.signature(renamed, version: 4), at: start.addingTimeInterval(0.5)), "Changed settings start at once")
        require(!guardrail.isRepeat(NativeExportRepeatGuard.signature(request, version: 5), at: start.addingTimeInterval(0.5)), "A changed project starts at once")
        require(NativeExportRepeatGuard.signature(["b": 1, "a": 2], version: 1) == NativeExportRepeatGuard.signature(["a": 2, "b": 1], version: 1), "Signatures ignore key order")
        require(!guardrail.isRepeat(signature, at: start.addingTimeInterval(0.5), ended: true), "An accepted export that failed or was cancelled can be retried at once")
        guardrail.accept(signature, job: "j7")
        require(guardrail.job == "j7", "The guard remembers which job the export became")
        guardrail.accept("other", job: "j8")
        require(guardrail.job == "j7", "Another export's job does not replace it")
        require(NativeExportRepeatGuard.ended("failed") && NativeExportRepeatGuard.ended("cancelled"), "Failed and cancelled jobs are over")
        require(!NativeExportRepeatGuard.ended("running") && !NativeExportRepeatGuard.ended(nil), "Running or unknown jobs are not over")
        guardrail.forget(signature)
        require(!guardrail.isRepeat(signature, at: start.addingTimeInterval(0.5)), "A failed start can be retried at once")
        guardrail.record(signature, at: start)
        guardrail.accept(signature, job: "j9")
        require(guardrail.isRepeat(signature, at: start.addingTimeInterval(0.5)), "A running or finished export still blocks an exact repeat")
        guardrail.reset()
        require(!guardrail.isRepeat(signature, at: start.addingTimeInterval(0.5)) && guardrail.job == nil, "A discarded queued export can be started again at once")

        // Status text.
        let named: [String: Any] = ["tracks": [["id": "V1", "name": "Video 1", "clips": [["id": "c1", "kind": "image", "src": "media/coastal-arrival.png", "label": "Coastal arrival"]]], ["id": "A1", "name": "Music", "clips": []]]]
        func status(_ line: String, who: String = "you") -> String { NativeStatusText.activity(line, who: who, project: named) }
        let idPattern = try! NSRegularExpression(pattern: #"\b[cVAkm]\d+[a-z]?\b"#)
        func hasID(_ text: String) -> Bool { idPattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil }
        let grade = status("updated c1: grade")
        require(grade.contains("Coastal arrival") && grade.contains("color grade") && !hasID(grade), "Grade edits read plainly: \(grade)")
        let gone = status("updated c44: x, y")
        require(gone == "Changed the position of a clip.", "Deleted clips do not show IDs: \(gone)")
        require(status("updated c1, c44: opacity") == "Changed the opacity of 2 clips.", "Several clips are counted")
        require(status("undo") == "Undid the last change.", "Undo reads plainly")
        let exported = status("exported renders/Export-2.mp4", who: "reel")
        require(exported == "Export finished: Export-2.mp4.", "Exports name the file, not the folder: \(exported)")
        require(status("exported renders/Export.mp4 in 4.2s", who: "reel") == "Export finished: Export.mp4.", "Timed exports read plainly")
        let failed = status("job failed: Disk full while writing renders/Export.mp4", who: "reel")
        require(failed.contains("Disk full while writing renders/Export.mp4"), "Failures keep their detail")
        let warning = status("The project opened, but its recovery snapshot failed: no space", who: "reel")
        require(warning == "The project opened, but its recovery snapshot failed: no space", "Warnings stay whole")
        let moved = status("moved c1 to 2.5s on V1")
        require(!hasID(moved) && moved.contains("Coastal arrival") && moved.contains("Video 1"), "Commit lines replace IDs: \(moved)")
        require(!hasID(status("deleted c8, c9")), "Unknown IDs become plain nouns: \(status("deleted c8, c9"))")
        require(status("updated track V1: locked") == "Updated “Video 1”.", "Track edits use the track name")
        // Lines written for people keep their paths and names exactly.
        let cancelled = status("Media import cancelled. A partial copy was kept at media/c1.mov.")
        require(cancelled == "Media import cancelled. A partial copy was kept at media/c1.mov.", "Paths in cancellation details stay whole: \(cancelled)")
        require(status("moved c1 to 2.5s on V1 from media/c1.mov").contains("media/c1.mov"), "A path inside a commit line stays whole")
        require(status("added title c1 \"c1 intro\"").contains("\"c1 intro\""), "Quoted text inside a commit line stays whole")
        // Property suffixes are not file names, so the clip still gets its name.
        let keyframes = status("cleared keyframes on c1.x")
        require(keyframes == "Cleared the position keyframes of “Coastal arrival”.", "Keyframe lines name the clip and property: \(keyframes)")
        require(status("cleared keyframes on c1") == "Cleared the keyframes of “Coastal arrival”.", "Keyframe lines without a property read plainly")
        let expression = status("expression on c1.x: time")
        require(expression == "Set an expression on the position of “Coastal arrival”.", "Expression lines name the clip and property: \(expression)")
        require(status("removed expression on c1, c44.opacity") == "Removed the expression on the opacity of 2 clips.", "Removed expressions count clips")
        require(!hasID(status("moved c1 to 2s from media/c1.mpg on V1").replacingOccurrences(of: "c1.mpg", with: "")) && status("moved c1 to 2s from media/c1.mpg on V1").contains("c1.mpg"), "Older video types still count as file names")
        require(status("relinked c1 to c1.MOV").hasSuffix("c1.MOV."), "A real file name stays whole in any case")
        // The backend's music placement line names its track. Other lines written for people stay whole.
        let music = status("Placed original music on A1")
        require(music == "Placed original music on “Music”.", "Music placement names the track: \(music)")
        require(status("Placed original music on A9") == "Placed original music on a track.", "A missing track becomes a plain noun")
        let restored = status("Restored missing original Promo V1 final.mov. Project edits and Undo history were preserved.")
        require(restored == "Restored missing original Promo V1 final.mov. Project edits and Undo history were preserved.", "File names in backend lines stay whole: \(restored)")
        // Track IDs repeat across timelines, and activity lines do not say which one they edited.
        let nested: [String: Any] = [
            "tracks": [["id": "V1", "name": "Main picture", "clips": []], ["id": "V2", "name": "Titles", "clips": []]],
            "comps": ["k1": ["name": "Inset", "tracks": [["id": "V1", "name": "Inset picture", "clips": []]]]]
        ]
        require(NativeStatusText.activity("updated track V1: muted", who: "agent", project: nested) == "Updated a track.", "A track ID shared by two timelines is not named after either")
        require(NativeStatusText.activity("updated track V2: muted", who: "agent", project: nested) == "Updated “Titles”.", "A track ID in one timeline keeps its name")
        let unnamed: [String: Any] = [
            "tracks": [["id": "V1", "name": "", "clips": []]],
            "comps": ["k1": ["name": "Inset", "tracks": [["id": "V1", "name": "Inset picture", "clips": []]]]]
        ]
        require(NativeStatusText.activity("updated track V1: name", who: "you", project: unnamed) == "Updated a track.", "An unnamed track does not borrow a nested timeline's name")
        require(status("", who: "reel").isEmpty, "Empty lines stay empty")
        // Nudge, delete and blade name the clip and round the time.
        let video: [String: Any] = ["id": "c1", "kind": "video", "src": "media/arya-test-clip.mp4", "link": "L1"]
        let sound: [String: Any] = ["id": "c2", "kind": "audio", "src": "media/arya-test-clip.mp4", "link": "L1"]
        let other: [String: Any] = ["id": "c3", "kind": "video", "src": "media/second.mov"]
        let nudgedRight = status(NativeStatusText.moved([video], by: 1.0 / 30))
        require(nudgedRight == "Moved “arya-test-clip.mp4” +0.03 s.", "A nudge names the clip: \(nudgedRight)")
        require(status(NativeStatusText.moved([sound, video], by: -1.0 / 30)) == "Moved “arya-test-clip.mp4” -0.03 s.", "A linked clip and its sound count as one clip")
        require(status(NativeStatusText.moved([video, sound, other], by: 0.5)) == "Moved 2 clips +0.50 s.", "Several clips are counted")
        let deleted = status(NativeStatusText.deleted([video, sound], ripple: false))
        require(deleted == "Deleted “arya-test-clip.mp4”.", "A delete names the clip: \(deleted)")
        require(status(NativeStatusText.deleted([video, other], ripple: true)) == "Ripple deleted 2 clips.", "A ripple delete counts clips")
        require(status(NativeStatusText.deleted([["id": "c9", "label": "c9 intro"]], ripple: false)) == "Deleted “c9 intro”.", "A clip name that looks like an ID stays whole")
        let cutProject: [String: Any] = ["tracks": [["id": "V1", "name": "Video 1", "clips": [video, ["id": "c4", "kind": "video", "src": "media/arya-test-clip.mp4"]]]]]
        let bladed = NativeStatusText.activity("bladed c1 at 3.0333333s → c4", who: "you", project: cutProject)
        require(bladed == "Bladed “arya-test-clip.mp4” at 3.03 s → “arya-test-clip.mp4”.", "Blade rounds the cut time and names both parts: \(bladed)")
        require(NativeStatusText.activity("bladed c1 at 4s → c4", who: "you", project: cutProject) == "Bladed “arya-test-clip.mp4” at 4.00 s → “arya-test-clip.mp4”.", "Whole-second cuts read the same way")
        require(!hasID(NativeStatusText.activity("bladed c1 at 2.5s → c4", who: "you", project: named)), "A cut part that is gone becomes a plain noun")

        // Device words.
        require(NativeCurveHit.hint.hasPrefix(HOST_CURVE_WORD), "Curve hint uses the platform's word: \(NativeCurveHit.hint)")
        require(NativeTimelineWords.selectHint.hasPrefix(HOST_TIMELINE_WORD), "Timeline hint uses the platform's word: \(NativeTimelineWords.selectHint)")
        print("editor input and status checks passed (\(checks))")
    }
}
'''


def compile_and_run(source, temp, label):
    path = temp / f'{label}.swift'
    path.write_text(source)
    binary = temp / label
    subprocess.run(['xcrun', 'swiftc', '-parse-as-library', '-module-cache-path', str(temp / 'cache'), str(path), '-o', str(binary)], check=True)
    print(subprocess.run([str(binary)], check=True, capture_output=True, text=True).stdout.strip(), f'[{label}]')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
    repo = parser.parse_args().source_root.resolve()
    editor = repo / 'native/App/Shared/NativeEditor'
    read = lambda name: (editor / name).read_text()
    project, color, viewer, motion = read('NativeProject.swift'), read('NativeColorPanel.swift'), read('NativeViewer.swift'), read('NativeMotionPanel.swift')
    audio, deliver, model, timeline = read('NativeAudioPanel.swift'), read('NativeDeliverPanel.swift'), read('NativeEditorModel.swift'), read('NativeTimeline.swift')

    viewer_geometry = block(viewer, 'enum NativeViewerGeometry {')
    helpers = '\n'.join([
        'import Foundation\nimport CoreGraphics',
        block(project, 'extension Dictionary where Key == String, Value == Any {'),
        block(color, 'enum NativeCurveHit {'),
        viewer_geometry,
        block(motion, 'struct NativeMotionGraphLayout'),
        block(audio, 'enum NativeAudioPresence {'),
        block(deliver, 'struct NativeExportRepeatGuard {'),
        block(model, 'enum NativeStatusText {'),
        block(timeline, 'enum NativeTimelineWords {'),
    ])
    # NativeViewerGeometry and NativeMotionGraphLayout reference neighbours that the checks do not use.
    for marker in ['struct NativeMotionKeyRef:', 'struct NativeMotionKey:', 'enum NativeMotionGraphMode', 'enum NativeMotionMath {', 'enum NativeMotionPropertyChoice {']:
        if marker in motion and marker not in helpers:
            helpers += '\n' + block(motion, marker)
    with tempfile.TemporaryDirectory(prefix='editor-input-status-') as raw:
        temp = Path(raw)
        harness = HARNESS.replace('HOST_CURVE_WORD', '"Click"').replace('HOST_TIMELINE_WORD', '"Click"')
        compile_and_run(helpers + '\n' + harness, temp, 'pointer')
        # The touch branch: what iPhone and iPad compile.
        touch = re.sub(r'#if (os\(macOS\) \|\| targetEnvironment\(macCatalyst\)|targetEnvironment\(macCatalyst\) \|\| os\(macOS\))', '#if false', helpers)
        harness = HARNESS.replace('HOST_CURVE_WORD', '"Tap"').replace('HOST_TIMELINE_WORD', '"Tap"')
        compile_and_run(touch + '\n' + harness, temp, 'touch')


if __name__ == '__main__':
    main()
