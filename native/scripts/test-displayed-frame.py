#!/usr/bin/env python3
"""Exercise production displayed-frame guards with real Core Graphics images."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
model = (root / 'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()


def block(marker):
    start = model.index(marker)
    begin = model.index('{', start)
    end, depth = begin + 1, 1
    while depth:
        depth += (model[end] == '{') - (model[end] == '}')
        end += 1
    return model[start:end]


source = '''import Foundation
import CoreGraphics
final class ReelRenderedFrame {
    let image: CGImage
    init(red: CGFloat) {
        let context = CGContext(data: nil, width: 160, height: 90, bitsPerComponent: 8, bytesPerRow: 640,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)!
        context.setFillColor(CGColor(colorSpace: context.colorSpace!, components: [red, 0, 0, 1])!)
        context.fill(CGRect(x: 0, y: 0, width: 160, height: 90))
        image = context.makeImage()!
    }
    func cgImage() throws -> CGImage { image }
}
'''
for marker in ['struct NativeRenderPreviewCapture {', 'struct NativeDisplayedFrameCapture {', 'struct NativeViewerComparison {']:
    source += block(marker) + '\n'
source += '''
@MainActor final class Model {
    var generation = UUID(), projectRevision = UUID()
    var folder: URL? = URL(fileURLWithPath: "/fixture"), version = 7
    var composition: String? = "nested", selectedIDs: Set<String> = ["c1"], selectedID: String? = "c1", time = 1.0
    var width = 1920.0, height = 1080.0
    var project: Int? = 1, renderer: Int? = 1
    var playing = false, scrubbing = false, busy = false, rendering = false, showingSource = false
    var metalFrame: ReelRenderedFrame? = ReelRenderedFrame(red: 1), renderError: String?
    var displayedTime: Double? = 1, displayedVersion: Int? = 7, displayedRevision: UUID?, displayedComposition: String? = "nested", displayedPreviewID: UUID?
    var previewCapture: NativeRenderPreviewCapture?, previewOperations: String?
    var displayedGeneration: UUID?, displayedFolder: URL?
    init() { displayedRevision = projectRevision; displayedGeneration = generation; displayedFolder = folder }
'''
for marker in ['    func renderPreviewMatches(', '    func viewerGeometryIsCurrent(', '    func captureDisplayedCommittedFrame(', '    func frameCaptureMatches(', '    func viewerComparisonMatches(']:
    source += block(marker) + '\n'
source += '''
}
@main struct Checks {
    static var count = 0
    static var phase = "initial"
    static func check(_ value: @autoclosure () -> Bool, line: Int = #line) { if !value() { fatalError("Failed check \\(count + 1), phase \\(phase), line \\(line)") }; count += 1 }
    @MainActor static func main() {
        let model = Model(), capture = model.captureDisplayedCommittedFrame()!
        check(capture.width == 160 && capture.height == 90)
        check(capture.canvasAspect == 1920.0 / 1080.0)
        check(capture.colorSpace == (CGColorSpace.sRGB as String))
        check(model.frameCaptureMatches(capture))
        let pixels = capture.image.dataProvider!.data! as Data
        check(pixels[0] == 255 && pixels[1] == 0 && pixels[2] == 0)
        for axis in 0..<22 {
            phase = "capture axis \\(axis)"
            let m = Model(), c = m.captureDisplayedCommittedFrame()!
            switch axis {
            case 0: m.generation = UUID()
            case 1: m.projectRevision = UUID()
            case 2: m.folder = URL(fileURLWithPath: "/other")
            case 3: m.version += 1
            case 4: m.composition = nil
            case 5: m.selectedIDs = ["c1", "c2"]
            case 6: m.selectedID = "c2"
            case 7: m.time = 2
            case 8: m.playing = true
            case 9: m.scrubbing = true
            case 10: m.busy = true
            case 11: m.rendering = true
            case 12: m.showingSource = true
            case 13: m.displayedTime = 0
            case 14: m.displayedVersion = 6
            case 15: m.displayedRevision = UUID()
            case 16: m.displayedComposition = nil
            case 17: m.displayedPreviewID = UUID()
            case 18: m.metalFrame = ReelRenderedFrame(red: 0)
            case 19: m.renderError = "Failed frame"
            case 20: m.previewOperations = "[]"
            default: m.previewCapture = c.context
            }
            check(!m.frameCaptureMatches(c))
            if ![5,6,18].contains(axis) { check(m.captureDisplayedCommittedFrame() == nil) }
        }
        phase = "draft"
        let draft = Model(), context = draft.captureDisplayedCommittedFrame()!.context
        draft.previewCapture = context; draft.previewOperations = "[]"; draft.rendering = true
        check(draft.viewerGeometryIsCurrent(capture: context))
        check(!draft.viewerGeometryIsCurrent())
        draft.displayedPreviewID = context.id; check(draft.viewerGeometryIsCurrent(capture: context))
        draft.displayedPreviewID = UUID(); check(!draft.viewerGeometryIsCurrent(capture: context))
        phase = "still"
        let stillModel = Model(), stillCapture = stillModel.captureDisplayedCommittedFrame()!
        let still = NativeViewerComparison(id: UUID(), context: stillCapture.context, image: stillCapture.image,
                                           canvasAspect: stillCapture.canvasAspect, caption: "Fixture still")
        check(stillModel.viewerComparisonMatches(still))
        stillModel.version += 1; stillModel.projectRevision = UUID(); stillModel.time = 3
        stillModel.selectedID = "c2"; stillModel.selectedIDs = ["c2"]
        check(stillModel.viewerComparisonMatches(still))
        for axis in 0..<5 {
            let m = Model(), c = m.captureDisplayedCommittedFrame()!
            let comparison = NativeViewerComparison(id: UUID(), context: c.context, image: c.image, canvasAspect: c.canvasAspect, caption: "Still")
            switch axis {
            case 0: m.generation = UUID()
            case 1: m.folder = URL(fileURLWithPath: "/other")
            case 2: m.composition = nil
            case 3: m.width = 1080
            default: m.showingSource = true
            }
            check(!m.viewerComparisonMatches(comparison))
        }
        print("Passed \\(count) production committed-frame, picker and comparison guard checks.")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='reel-displayed-frame-') as temp:
    path = Path(temp)
    swift = path / 'Checks.swift'
    swift.write_text(source)
    subprocess.run(['xcrun', 'swiftc', '-parse-as-library', '-module-cache-path', str(path / 'cache'), str(swift), '-o', str(path / 'checks')], check=True)
    subprocess.run([str(path / 'checks')], check=True)
