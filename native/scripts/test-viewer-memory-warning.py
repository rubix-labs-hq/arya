#!/usr/bin/env python3
"""A memory warning frees the viewer frame. While the scene stays active it must draw the frame again.

On the Mac App Store edition the scene stays active through a system memory warning, so no scene change
asks for a new frame. Before the fix the viewer then showed "Rendering frame" until the next edit or step.
This runs the production releasePreview body against a stub model and renderer.
"""
from pathlib import Path
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
editor = root / 'native/App/Shared/NativeEditor'
model = (editor / 'NativeEditorModel.swift').read_text()
view = (editor / 'NativeEditorView.swift').read_text()


def block(text, marker):
    start = text.index(marker)
    begin = text.index('{', start)
    end, depth = begin + 1, 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    return text[start:end]


warning = re.search(r'didReceiveMemoryWarningNotification\)\) \{ _ in ([^\n]*) \}', view)
assert warning, 'memory warning handler not found'
assert warning.group(1) == 'model.releasePreview(redraw: scenePhase == .active)', \
    f'memory warning must redraw while the scene is active, found: {warning.group(1)}'
scene = re.search(r'\.onChange\(of: scenePhase\) \{ _, phase in ([^\n]*) \}', view)
assert scene and 'model.releasePreview()' in scene.group(1) and 'model.requestFrame()' in scene.group(1), \
    'scene changes must still release in the background and redraw when active'

source = '''import Foundation
actor Renderer {
    var released = 0
    func releaseCaches() { released += 1 }
}
final class Frame {}
@MainActor final class Model {
    var renderer: Renderer? = Renderer()
    var generation = UUID(), projectRevision = UUID(), renderWorkerID = UUID(), renderGeneration = UUID()
    var previewOwnershipID: UUID? = UUID(), viewerComparison: Int? = 1
    var renderTask: Task<Void, Never>?, pendingFrame: Int? = 1
    var rendering = true, scrubbing = true
    var frame: Int? = 1, metalFrame: Frame? = Frame()
    var displayedTime: Double? = 1, displayedPreviewID: UUID?, displayedVersion: Int? = 1, displayedRevision: UUID?
    var displayedComposition: String?, displayedFolder: URL?, displayedGeneration: UUID?
    var requests = 0
    func discardRenderPreview(redraw: Bool) {}
    func clearSource() {}
    func pause() {}
    func clearScopes() {}
    func requestFrame() { requests += 1; metalFrame = Frame() }
'''
source += block(model, '    func releasePreview(') + '\n'
source += '''
}
@main struct Checks {
    static var count = 0
    static func check(_ value: Bool, _ name: String) { if !value { fatalError("Failed: \\(name)") }; count += 1 }
    @MainActor static func settle() async { for _ in 0..<50 { await Task.yield() }; try? await Task.sleep(for: .milliseconds(50)) }
    @MainActor static func main() async {
        // Memory warning while active: the frame is freed, then drawn again once the caches are released.
        var model = Model()
        model.releasePreview(redraw: true)
        check(model.metalFrame == nil && model.renderTask == nil, "frame freed at once")
        await settle()
        check(await model.renderer!.released == 1, "caches released")
        check(model.requests == 1 && model.metalFrame != nil, "active memory warning redraws once")

        // Leaving the scene, or a warning while inactive: release only.
        model = Model()
        model.releasePreview()
        await settle()
        check(model.requests == 0 && model.metalFrame == nil, "background release does not redraw")

        // The project changed before the caches were released: no redraw of the old one.
        model = Model()
        model.releasePreview(redraw: true)
        model.generation = UUID()
        await settle()
        check(model.requests == 0, "no redraw after the project changed")

        // The scene went inactive before the caches were released: its release cancels the redraw.
        model = Model()
        model.releasePreview(redraw: true)
        model.releasePreview()
        await settle()
        check(model.requests == 0 && model.metalFrame == nil, "a later background release cancels the redraw")

        // Two warnings while active: the later one redraws, once.
        model = Model()
        model.releasePreview(redraw: true)
        model.releasePreview(redraw: true)
        await settle()
        check(model.requests == 1 && model.metalFrame != nil, "repeated warnings redraw once")

        // A frame was drawn meanwhile, for example by an edit: no second request.
        model = Model()
        model.releasePreview(redraw: true)
        model.metalFrame = Frame()
        await settle()
        check(model.requests == 0, "no redraw when a frame is already shown")

        // A render started meanwhile: let it finish instead of queueing another.
        model = Model()
        model.releasePreview(redraw: true)
        model.renderTask = Task {}
        await settle()
        check(model.requests == 0, "no redraw while a render is running")

        // The renderer was replaced: the new one draws for itself.
        model = Model()
        model.releasePreview(redraw: true)
        model.renderer = Renderer()
        await settle()
        check(model.requests == 0, "no redraw for a replaced renderer")

        // No renderer yet: nothing to release or redraw.
        model = Model()
        model.renderer = nil
        model.releasePreview(redraw: true)
        await settle()
        check(model.requests == 0 && model.metalFrame == nil, "no renderer, no redraw")
        print("viewer memory warning: \\(count) checks passed")
    }
}
'''

with tempfile.TemporaryDirectory(prefix='arya-memory-warning.') as temp:
    path = Path(temp) / 'main.swift'
    path.write_text(source)
    binary = Path(temp) / 'checks'
    subprocess.run(['xcrun', 'swiftc', '-parse-as-library', '-swift-version', '5', str(path), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
