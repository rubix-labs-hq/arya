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
        guardrail.forget(signature)
        require(!guardrail.isRepeat(signature, at: start.addingTimeInterval(0.5)), "A failed start can be retried at once")

        // Status text.
        let named: [String: Any] = ["tracks": [["id": "V1", "name": "Video 1", "clips": [["id": "c1", "kind": "image", "src": "media/coastal-arrival.png", "label": "Coastal arrival"]]]]]
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
        require(status("", who: "reel").isEmpty, "Empty lines stay empty")

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
    for marker in ['struct NativeMotionKeyRef:', 'struct NativeMotionKey:', 'enum NativeMotionGraphMode', 'enum NativeMotionMath {']:
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
