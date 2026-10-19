import Foundation
import CoreGraphics

@main struct ViewerGestureChecks {
    static var count = 0
    static func check(_ value: @autoclosure () -> Bool, line: UInt = #line) { precondition(value(), "Gesture check failed at line \(line)"); count += 1 }
    @MainActor static func fixture() -> (NativeEditorModel, ViewerGestureHarness, NativeViewerGeometry.Viewport, NativeViewerGeometry.Layer) {
        let model = NativeEditorModel(), harness = ViewerGestureHarness(model: model)
        let viewport = NativeViewerGeometry.Viewport(size: CGSize(width: 300, height: 300), canvas: CGSize(width: 300, height: 300), scale: 1, imageAspect: 1)!
        let record: [String: Any] = ["id": "c1", "kind": "shape", "width": 100.0, "height": 60.0, "matrix": [1.0, 0, 0, 1, 100, 100],
            "pose": ["x": 100.0, "y": 100.0, "scale": 1.0, "rotation": 0.0, "parentMatrix": [1.0, 0, 0, 1, 0, 0]]]
        harness.updateViewerLayout(viewport.layout)
        return (model, harness, viewport, NativeViewerGeometry.Layer(record)!)
    }
    @MainActor static func main() async throws {
        let (model, harness, viewport, layer) = fixture()
        let source = harness.beginGesture(viewport: viewport, layer: layer, target: .move, point: CGPoint(x: 100, y: 100))!
        harness.gesture = source
        let edits = try harness.gestureOperations(source, point: CGPoint(x: 112, y: 110))
        check(edits.count == 1 && abs(edits[0].dictionary("set").number("x") - 112) < 1e-6 && abs(edits[0].dictionary("set").number("y") - 110) < 1e-6)
        check(model.preview(edits, capture: source.capture))
        model.displayedPreviewID = source.capture.id
        harness.endGesture(source, operations: edits, viewport: viewport)
        check(model.batches.isEmpty && model.deferred.count == 1 && harness.queuedCommit?.capture.id == source.capture.id)
        try await model.dispatch(repeatAction: true)
        check(model.batches.count == 1 && model.batches[0].version == 7)
        check(model.batches[0].route == "/api/ops" && model.batches[0].body.flag("returnProject"))
        check(model.batches[0].operations.allSatisfy { $0.string("comp") == "nested" })
        check(harness.queuedCommit == nil)
        check(model.batches[0].operations.count == 1 && model.batches[0].captureCleared)
        check(model.previewCapture == nil && model.previewOperations == nil && model.requests == 2)
        harness.gesture = nil
        check(harness.beginGesture(viewport: viewport, layer: layer, target: .move, point: .zero) == nil)
        model.displayedPreviewID = nil
        check(harness.beginGesture(viewport: viewport, layer: layer, target: .move, point: .zero) != nil)

        for axis in 0..<28 {
            let (m, h, v, l) = fixture()
            let s = h.beginGesture(viewport: v, layer: l, target: .move, point: CGPoint(x: 100, y: 100))!
            let ops = try h.gestureOperations(s, point: CGPoint(x: 112, y: 110))
            var currentViewport = v
            switch axis {
            case 0: m.generation = UUID()
            case 1: m.projectRevision = UUID()
            case 2: m.folder = URL(fileURLWithPath: "/other")
            case 3: m.version += 1
            case 4: m.composition = "other"
            case 5: m.selectedIDs = ["c2"]
            case 6: m.time = 2
            case 7: m.playing = true
            case 8: m.scrubbing = true
            case 9: m.busy = true
            case 10: m.project = nil
            case 11: m.renderer = nil
            case 12: m.metalFrame = nil
            case 13: m.showingSource = true
            case 14: m.displayedFolder = URL(fileURLWithPath: "/other")
            case 15: m.displayedGeneration = UUID()
            case 16: m.displayedTime = 0
            case 17: m.displayedVersion = 6
            case 18: m.displayedRevision = UUID()
            case 19: m.displayedComposition = "other"
            case 20: m.renderError = "failed frame"
            case 21: m.drawing = 1
            case 22: m.viewerColorPicker = 1
            case 23: m.tracks = []
            case 24: var t = m.tracks[0].fields; t["locked"] = true; m.tracks = [NativeTrack(fields: t)]
            case 25: var t = m.tracks[0].fields; var c = t.objects("clips")[0]; c["locked"] = true; t["clips"] = [c]; m.tracks = [NativeTrack(fields: t)]
            case 26: var t = m.tracks[0].fields; var c = t.objects("clips")[0]; c["expr"] = ["x": "value + time"]; t["clips"] = [c]; m.tracks = [NativeTrack(fields: t)]
            default: currentViewport = NativeViewerGeometry.Viewport(size: CGSize(width: 400, height: 300), canvas: CGSize(width: 300, height: 300), scale: 1, imageAspect: 1)!
            }
            h.endGesture(s, operations: ops, viewport: currentViewport)
            check(m.batches.isEmpty); check(m.previewCapture == nil)
        }
        for axis in 0..<7 {
            let (m, h, v, l) = fixture()
            switch axis {
            case 0: m.selectedIDs = ["c1", "c2"]
            case 1: m.drawing = 1
            case 2: m.viewerColorPicker = 1
            case 3: m.displayedPreviewID = UUID()
            case 4: m.rendering = true
            case 5: var t = m.tracks[0].fields; t["locked"] = true; m.tracks = [NativeTrack(fields: t)]
            default: var t = m.tracks[0].fields; var c = t.objects("clips")[0]; c["expr"] = ["x": "value + time"]; t["clips"] = [c]; m.tracks = [NativeTrack(fields: t)]
            }
            check(h.beginGesture(viewport: v, layer: l, target: .move, point: .zero) == nil)
        }
        let (cancel, cancelled, v, l) = fixture()
        let c = cancelled.beginGesture(viewport: v, layer: l, target: .move, point: .zero)!
        cancelled.gesture = c; cancelled.attempted = true; cancelled.activeInput = "pointer"
        check(cancel.preview([["op": "update", "id": "c1", "set": ["x": 110]]], capture: c.capture))
        cancel.time = 2; cancelled.cancelInvalidGesture()
        check(cancelled.gesture == nil && cancelled.attempted && cancelled.activeInput == "pointer")
        check(cancel.previewCapture == nil && cancel.batches.isEmpty)
        cancelled.cancelGesture(); check(!cancelled.attempted && cancelled.activeInput == nil)

        let (rotationModel, rotationHarness, rv, rl) = fixture()
        let rotation = rotationHarness.beginGesture(viewport: rv, layer: rl, target: .rotate, point: CGPoint(x: 130, y: 100))!
        rotationHarness.gesture = rotation
        for angle in [90.0, 179, 181, 270, 359, 361] {
            let r = angle * Double.pi / 180
            let source = rotationHarness.gesture!
            let ops = try rotationHarness.gestureOperations(source, point: CGPoint(x: 100 + 30 * cos(r), y: 100 + 30 * sin(r)))
            check(abs(ops[0].dictionary("set").number("rotation") - angle) < 1e-6)
        }
        let finalSource = rotationHarness.gesture!, finalOps = try rotationHarness.gestureOperations(finalSource, point: CGPoint(x: 130, y: 100))
        rotationHarness.endGesture(finalSource, operations: finalOps, viewport: rv)
        try await rotationModel.dispatch()
        check(rotationModel.batches.count == 1 && rotationModel.batches[0].operations[0].dictionary("set").number("rotation") == 360)
        for axis in 0..<40 {
            let (m, h, v, l) = fixture()
            let s = h.beginGesture(viewport: v, layer: l, target: .move, point: CGPoint(x: 100, y: 100))!
            let ops = try h.gestureOperations(s, point: CGPoint(x: 112, y: 110))
            h.endGesture(s, operations: ops, viewport: v)
            check(m.batches.isEmpty && m.deferred.count == 1 && h.queuedCommit != nil)
            switch axis {
            case 0: m.generation = UUID()
            case 1: m.projectRevision = UUID()
            case 2: m.folder = URL(fileURLWithPath: "/other")
            case 3: m.version += 1
            case 4: m.composition = "other"
            case 5: m.selectedIDs = ["c2"]
            case 6: m.selectedID = "c2"
            case 7: m.selectedIDs = ["c1", "c2"]
            case 8: m.time = 2
            case 9: m.playing = true
            case 10: m.scrubbing = true
            case 11: m.busy = true
            case 12: m.project = nil
            case 13: m.renderer = nil
            case 14: m.metalFrame = nil
            case 15: m.showingSource = true
            case 16: m.renderError = "failed frame"
            case 17: m.drawing = 1
            case 18: m.viewerColorPicker = 1
            case 19: m.tracks = []
            case 20: var t = m.tracks[0].fields; t["locked"] = true; m.tracks = [NativeTrack(fields: t)]
            case 21: var t = m.tracks[0].fields; var c = t.objects("clips")[0]; c["locked"] = true; t["clips"] = [c]; m.tracks = [NativeTrack(fields: t)]
            case 22: var t = m.tracks[0].fields; var c = t.objects("clips")[0]; c["x"] = 200.0; t["clips"] = [c]; m.tracks = [NativeTrack(fields: t)]
            case 23: var t = m.tracks[0].fields; t["name"] = "Renamed"; m.tracks = [NativeTrack(fields: t)]
            case 24: m.tracks.append(m.tracks[0])
            case 25: m.panel = .color
            case 26: h.canvasZoom = "100%"
            case 27: m.width = 400
            case 28: m.height = 400
            case 29: h.updateViewerLayout(NativeViewerGeometry.Layout(size: CGSize(width: 400, height: 300), canvas: v.canvas, scale: v.scale))
            case 30: h.updateViewerLayout(NativeViewerGeometry.Layout(size: v.size, canvas: CGSize(width: 400, height: 300), scale: v.scale))
            case 31: h.updateViewerLayout(NativeViewerGeometry.Layout(size: v.size, canvas: v.canvas, scale: 0.5))
            case 32: h.cancelGesture()
            case 33: h.viewerModelID = ObjectIdentifier(NativeEditorModel())
            case 34: m.displayedPreviewID = UUID()
            case 35: _ = m.beginRenderPreview(renderedVersion: m.version)
            case 36:
                let next = m.beginRenderPreview(renderedVersion: m.version)!
                m.discardRenderPreview(next)
            case 37: h.updateViewerLayout(nil)
            case 38: m.backend = FixtureBackend()
            default: m.backend = nil
            }
            try await m.dispatch(repeatAction: true)
            check(m.batches.isEmpty && h.queuedCommit == nil)
        }

        for input in ["pointer", "pinch"] {
            let (m, h, _, l) = fixture()
            m.width = 1080; m.height = 1920
            let size = CGSize(width: 400, height: 600), canvas = CGSize(width: 1080, height: 1920)
            let committed = NativeViewerGeometry.Viewport(size: size, canvas: canvas, scale: 600.0 / 1920, imageAspect: 1280.0 / 2276)!
            let draft = NativeViewerGeometry.Viewport(size: size, canvas: canvas, scale: 600.0 / 1920, imageAspect: 480.0 / 853)!
            h.updateViewerLayout(committed.layout)
            let s = h.beginGesture(viewport: committed, layer: l, target: input == "pointer" ? .move : .scale(0), point: CGPoint(x: 130, y: 100), input: input)!
            h.gesture = s
            let destination = committed.screen(CGPoint(x: 142, y: 110))
            let before = try h.gestureOperations(s, point: input == "pointer" ? destination : nil, magnification: 1.2)
            check(m.preview(before, capture: s.capture))
            m.displayedPreviewID = s.capture.id; m.rendering = false
            h.updateViewerLayout(draft.layout)
            check(h.gesture?.capture.id == s.capture.id && h.gestureMatches(s, viewport: draft))
            let after = try h.gestureOperations(s, point: input == "pointer" ? destination : nil, magnification: 1.2)
            check(NSDictionary(dictionary: before[0]).isEqual(to: after[0]))
            h.endGesture(s, operations: after, viewport: draft)
            h.gesture = nil
            check(m.batches.isEmpty && h.queuedCommit != nil)
            try await m.dispatch(repeatAction: true)
            check(m.batches.count == 1 && m.batches[0].version == 7 && m.batches[0].captureCleared)
        }

        let (rootModel, rootHarness, rootViewport, rootLayer) = fixture()
        rootModel.composition = nil; rootModel.displayedComposition = nil
        let rootSource = rootHarness.beginGesture(viewport: rootViewport, layer: rootLayer, target: .move, point: CGPoint(x: 100, y: 100))!
        rootHarness.endGesture(rootSource, operations: try rootHarness.gestureOperations(rootSource, point: CGPoint(x: 112, y: 110)), viewport: rootViewport)
        try await rootModel.dispatch()
        check(rootModel.batches.count == 1 && rootModel.batches[0].operations.allSatisfy { $0["comp"] is NSNull })

        let (emptyModel, emptyHarness, emptyViewport, emptyLayer) = fixture()
        let empty = emptyHarness.beginGesture(viewport: emptyViewport, layer: emptyLayer, target: .move, point: CGPoint(x: 100, y: 100))!
        emptyHarness.endGesture(empty, operations: [], viewport: emptyViewport)
        check(emptyModel.deferred.isEmpty && emptyHarness.queuedCommit == nil && emptyModel.previewCapture == nil)
        print("Passed \(count) extracted production gesture, deferred dispatch, portrait publication, atomic batch, rotation and stale-context assertions.")
    }
}
