import Foundation
import CoreGraphics

@main struct VectorEventChecks {
    static var count = 0
    static func check(_ value: @autoclosure () -> Bool, _ message: String = "", line: UInt = #line) {
        precondition(value(), "Vector event check failed at line \(line): \(message)"); count += 1
    }
    static func near(_ actual: Double, _ expected: Double, line: UInt = #line) { check(abs(actual - expected) < 1e-7, "\(actual) != \(expected)", line: line) }
    @MainActor static func fixture(mode: String = "path", composition: String? = "nested") -> (NativeEditorModel, VectorEventHarness) {
        let m = NativeEditorModel()
        m.composition = composition; m.displayedComposition = composition
        let clip: [String: Any] = ["id": "c1", "kind": "shape", "start": 0.0, "dur": 4.0, "x": 150.0, "y": 150.0, "scale": 1.0, "rotation": 0.0, "anchorX": 0.0, "anchorY": 0.0,
            "shape": ["type": "path", "path": ["vertices": [[-40.0, -30.0], [40.0, -30.0], [0.0, 50.0]], "in": [[-12.0, -8.0], [-15.0, 0.0], [0.0, 0.0]], "out": [[15.0, 0.0], [12.0, 8.0], [0.0, 0.0]], "closed": false], "stroke": ["color": "#ff0000", "width": 6.0]]]
        m.tracks = [NativeTrack(fields: ["id": "V1", "kind": "video", "clips": [clip]])]
        m.metalFrame = FixtureFrame([["id": "c1", "kind": "shape", "width": 140.0, "height": 140.0,
            "matrix": [1.0, 0, 0, 1, 150, 150], "pose": ["x": 150.0, "y": 150.0, "scale": 1.0, "rotation": 0.0, "anchorX": 0.0, "anchorY": 0.0, "parentMatrix": [1.0, 0, 0, 1, 0, 0]]]])
        let viewport = NativeViewerGeometry.Viewport(size: CGSize(width: 300, height: 300), canvas: CGSize(width: 300, height: 300), scale: 1, imageAspect: 1)!
        return (m, VectorEventHarness(model: m, mode: mode, viewport: viewport))
    }
    @MainActor static func screen(_ h: VectorEventHarness, _ local: CGPoint) -> CGPoint {
        h.viewport.screen(NativeViewerGeometry.apply(h.layer()!.matrix, local))
    }
    @MainActor static func mutateClip(_ m: NativeEditorModel, _ update: (inout [String: Any]) -> Void) {
        var track = m.tracks[0].fields, clip = track.objects("clips")[0]
        update(&clip); track["clips"] = [clip]; m.tracks = [NativeTrack(fields: track)]
    }
    @MainActor static func mutateTrack(_ m: NativeEditorModel, _ update: (inout [String: Any]) -> Void) {
        var track = m.tracks[0].fields; update(&track); m.tracks = [NativeTrack(fields: track)]
    }
    @MainActor static func queue(_ m: NativeEditorModel, _ h: VectorEventHarness) {
        let start = screen(h, CGPoint(x: -40, y: -30)), last = screen(h, CGPoint(x: -32, y: -24)), end = screen(h, CGPoint(x: -27, y: -21))
        h.pointerChanged(start: start, location: last)
        check(h.source != nil && m.previewCapture != nil && m.previewOperations != nil)
        h.pointerEnded(location: end)
        check(h.source == nil && h.queued != nil && !h.attempted)
        check(m.previewCapture == nil && m.previewOperations == nil && m.batches.isEmpty && m.deferred.count == 1)
    }
    @MainActor static func main() async throws {
        for mode in ["anchor", "path"] {
            let (m, h) = fixture(mode: mode)
            let origin = mode == "anchor" ? CGPoint.zero : CGPoint(x: -40, y: -30)
            let start = screen(h, origin), changed = screen(h, CGPoint(x: origin.x + 8, y: origin.y + 6)), end = screen(h, CGPoint(x: origin.x + 13, y: origin.y + 9))
            h.pointerChanged(start: start, location: changed)
            check(h.source != nil && h.operations.count == 1 && m.previewing)
            let owner = h.source!.capture.id
            h.pointerEnded(location: end)
            check(m.batches.isEmpty && h.queued?.capture.id == owner && m.previewCapture == nil)
            try await m.dispatch(repeatAction: true)
            check(m.batches.count == 1 && h.queued == nil)
            let batch = m.batches[0], set = batch.operations[0].dictionary("set")
            check(batch.route == "/api/ops" && batch.version == 7 && batch.captureCleared && batch.body.flag("returnProject"))
            check(batch.operations.count == 1 && batch.operations[0].string("comp") == "nested")
            if mode == "anchor" {
                near(set.number("anchorX"), 13); near(set.number("anchorY"), 9); near(set.number("x"), 163); near(set.number("y"), 159)
                check(Set(set.keys) == Set(["anchorX", "anchorY", "x", "y"]))
            } else {
                let path = set.dictionary("shape").dictionary("path"), vertices = path["vertices"] as! [[Double]]
                near(vertices[0][0], -27); near(vertices[0][1], -21)
                check(path["closed"] as? Bool == false && Set(set.keys) == Set(["shape"]))
                check(NSDictionary(dictionary: h.model.selected!.fields.dictionary("shape").dictionary("path")).isEqual(to: path) == false)
            }
            h.pointerEnded(location: end); try await m.dispatch()
            check(m.batches.count == 1 && h.source == nil && h.queued == nil)

            let (returned, returning) = fixture(mode: mode)
            let begin = screen(returning, origin), away = screen(returning, CGPoint(x: origin.x + 15, y: origin.y + 10))
            returning.pointerChanged(start: begin, location: away)
            check(returned.previewOperations != nil)
            returning.pointerChanged(start: begin, location: begin)
            check(returning.source != nil && returning.operations.isEmpty && returned.previewOperations == nil && !returned.previewing, "return-to-origin in \(mode) mode")
            returning.pointerEnded(location: begin)
            check(returning.source == nil && returning.queued == nil && returned.previewCapture == nil && returned.deferred.isEmpty)
            try await returned.dispatch(); check(returned.batches.isEmpty)

            let (tap, tapped) = fixture(mode: mode)
            let p = screen(tapped, origin)
            tapped.pointerChanged(start: p, location: p); tapped.pointerEnded(location: p)
            check(tap.deferred.isEmpty && tap.batches.isEmpty && tap.previewCapture == nil)
        }

        for target in [NativeVectorEditPlan.Target.incoming(0), .outgoing(0)] {
            let (m, h) = fixture(), incoming = target == .incoming(0)
            let local = CGPoint(x: incoming ? -52 : -25, y: incoming ? -38 : -30)
            let start = screen(h, local), end = screen(h, CGPoint(x: -61, y: -45))
            h.pointerChanged(start: start, location: start)
            check(h.source?.target == target && h.operations.isEmpty)
            h.pointerEnded(location: end); try await m.dispatch()
            let path = m.batches[0].operations[0].dictionary("set").dictionary("shape").dictionary("path")
            let vectors = path[incoming ? "in" : "out"] as! [[Double]], vertices = path["vertices"] as! [[Double]]
            near(vectors[0][0], -21); near(vectors[0][1], -15); near(vertices[0][0], -40); near(vertices[0][1], -30)
        }

        let (second, selectedSecond) = fixture()
        let secondPoint = screen(selectedSecond, CGPoint(x: 40, y: -30))
        selectedSecond.pointerChanged(start: secondPoint, location: secondPoint)
        check(selectedSecond.selectedPoint == 1 && selectedSecond.source?.point == 1 && selectedSecond.source?.target == .vertex(1))
        selectedSecond.pointerEnded(location: screen(selectedSecond, CGPoint(x: 47, y: -22)))
        try await second.dispatch(); check(second.batches.count == 1)

        let (miss, missed) = fixture()
        missed.pointerChanged(start: CGPoint(x: 280, y: 280), location: CGPoint(x: 110, y: 120))
        check(missed.attempted && missed.source == nil && miss.previewCapture == nil)
        missed.pointerChanged(start: CGPoint(x: 110, y: 120), location: CGPoint(x: 119, y: 126))
        check(missed.source == nil)
        missed.pointerEnded(location: CGPoint(x: 119, y: 126)); check(!missed.attempted && miss.deferred.isEmpty)
        missed.pointerChanged(start: CGPoint(x: 110, y: 120), location: CGPoint(x: 119, y: 126))
        check(missed.source != nil); missed.cancel()

        let (cancel, cancelled) = fixture()
        cancelled.pointerChanged(start: CGPoint(x: 110, y: 120), location: CGPoint(x: 119, y: 126))
        cancel.time = 2; cancelled.cancelInvalid()
        check(cancelled.source == nil && cancelled.attempted && cancel.previewCapture == nil)
        cancel.time = 1
        cancelled.pointerChanged(start: CGPoint(x: 110, y: 120), location: CGPoint(x: 120, y: 128))
        check(cancelled.source == nil && cancel.previewCapture == nil)
        cancelled.pointerEnded(location: CGPoint(x: 120, y: 128)); try await cancel.dispatch()
        check(cancel.batches.isEmpty && !cancelled.attempted)

        for axis in 0..<28 {
            let (m, h) = fixture()
            h.pointerChanged(start: CGPoint(x: 110, y: 120), location: CGPoint(x: 119, y: 126))
            check(h.source != nil)
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
            case 12: m.displayedTime = 0
            case 13: m.displayedVersion = 6
            case 14: m.displayedRevision = UUID()
            case 15: m.displayedGeneration = UUID()
            case 16: m.displayedFolder = URL(fileURLWithPath: "/other")
            case 17: m.displayedComposition = "other"
            case 18: m.displayedPreviewID = UUID()
            case 19: m.drawing = 1
            case 20: m.viewerColorPicker = 1
            case 21: m.backend = FixtureBackend()
            case 22: m.renderError = "failed frame"
            case 23: m.metalFrame = nil
            case 24: m.showingSource = true
            case 25: h.updateLayout(NativeViewerGeometry.Layout(size: CGSize(width: 400, height: 300), canvas: h.viewport.canvas, scale: 1))
            case 26: mutateClip(m) { $0["label"] = "Changed" }
            default: h.selectedPoint = 1
            }
            h.pointerEnded(location: CGPoint(x: 123, y: 129))
            try await m.dispatch()
            check(m.batches.isEmpty && m.deferred.isEmpty && h.source == nil && h.queued == nil, "active axis \(axis)")
        }

        for axis in 0..<43 {
            let (m, h) = fixture(); queue(m, h)
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
            case 20: mutateTrack(m) { $0["locked"] = true }
            case 21: mutateClip(m) { $0["locked"] = true }
            case 22: mutateClip(m) { $0["x"] = 200.0 }
            case 23: mutateTrack(m) { $0["name"] = "Changed" }
            case 24: m.tracks.append(m.tracks[0])
            case 25: mutateTrack(m) { let clips = $0.objects("clips"); $0["clips"] = clips + clips }
            case 26: m.panel = .color
            case 27: m.width = 400
            case 28: m.height = 400
            case 29: h.updateLayout(NativeViewerGeometry.Layout(size: CGSize(width: 400, height: 300), canvas: h.viewport.canvas, scale: 1))
            case 30: h.updateLayout(NativeViewerGeometry.Layout(size: h.viewport.size, canvas: CGSize(width: 400, height: 300), scale: 1))
            case 31: h.updateLayout(NativeViewerGeometry.Layout(size: h.viewport.size, canvas: h.viewport.canvas, scale: 0.5))
            case 32: h.cancel()
            case 33: h.currentModelID = nil
            case 34: h.model = NativeEditorModel()
            case 35: m.displayedPreviewID = UUID()
            case 36: _ = m.beginRenderPreview(renderedVersion: m.version)
            case 37: let next = m.beginRenderPreview(renderedVersion: m.version)!; m.discardRenderPreview(next)
            case 38: m.backend = FixtureBackend()
            case 39: m.backend = nil
            case 40: h.mode = "anchor"
            case 41: h.selectedPoint = 1
            default: mutateClip(m) { $0["expr"] = ["x": "value + time"] }
            }
            try await m.dispatch(repeatAction: true)
            check(m.batches.isEmpty && h.queued == nil, "queued axis \(axis)")
        }

        let (root, rootScope) = fixture(composition: nil); queue(root, rootScope)
        try await root.dispatch()
        check(root.batches.count == 1 && root.batches[0].operations.allSatisfy { $0["comp"] is NSNull })

        for mode in ["anchor", "path"] {
            let (m, h) = fixture(mode: mode)
            m.width = 1080; m.height = 1920
            let size = CGSize(width: 400, height: 600), canvas = CGSize(width: 1080, height: 1920)
            let committed = NativeViewerGeometry.Viewport(size: size, canvas: canvas, scale: 600.0 / 1920, imageAspect: 1280.0 / 2276)!
            let draft = NativeViewerGeometry.Viewport(size: size, canvas: canvas, scale: 600.0 / 1920, imageAspect: 480.0 / 853)!
            h.viewport = committed; h.updateLayout(committed.layout)
            let original = mode == "anchor" ? CGPoint.zero : CGPoint(x: -40, y: -30)
            let start = screen(h, original), destination = screen(h, CGPoint(x: original.x + 18, y: original.y + 14))
            h.pointerChanged(start: start, location: destination)
            check(h.source != nil && h.operations.count == 1)
            let expected = h.operations[0], capture = h.source!.capture
            m.displayedPreviewID = capture.id
            var records = try JSON.parse(m.metalFrame!.drawGeometry.text) as! [[String: Any]]
            records[0]["matrix"] = [0.7, 0.2, -0.1, 0.8, 160.0, 165.0]
            records[0]["width"] = 250.0
            m.metalFrame = FixtureFrame(records)
            h.viewport = draft; h.updateLayout(draft.layout)
            h.pointerChanged(start: start, location: destination)
            check(h.source?.capture.id == capture.id && NSDictionary(dictionary: h.operations[0]).isEqual(to: expected))
            h.pointerEnded(location: destination)
            try await m.dispatch(repeatAction: true)
            check(m.batches.count == 1 && m.batches[0].version == 7 && m.batches[0].captureCleared)
        }

        let (bad, invalid) = fixture()
        invalid.pointerChanged(start: CGPoint(x: 110, y: 120), location: CGPoint(x: Double.nan, y: 130))
        check(invalid.source == nil && invalid.attempted && bad.previewCapture == nil)
        invalid.pointerEnded(location: CGPoint(x: 120, y: 130)); check(bad.deferred.isEmpty)
        for axis in 0..<9 {
            let (m, h) = fixture(mode: axis == 8 ? "anchor" : "path")
            switch axis {
            case 0: m.selectedIDs = ["c1", "c2"]
            case 1: m.drawing = 1
            case 2: m.viewerColorPicker = 1
            case 3: m.displayedPreviewID = UUID()
            case 4: m.rendering = true
            case 5: mutateTrack(m) { $0["locked"] = true }
            case 6: mutateClip(m) { $0["expr"] = ["shape.path": "value"] }
            case 7: mutateClip(m) { $0["effects"] = [["type": "mirror"]] }
            default: mutateClip(m) { $0["anim"] = ["rotation": [[0, 0], [1, 10]]] }
            }
            let p = axis == 8 ? CGPoint(x: 150, y: 150) : CGPoint(x: 110, y: 120)
            h.pointerChanged(start: p, location: CGPoint(x: p.x + 10, y: p.y + 10))
            h.pointerEnded(location: p); try await m.dispatch()
            check(h.source == nil && h.queued == nil && m.previewCapture == nil && m.batches.isEmpty, "begin axis \(axis)")
        }
        print("Passed \(count) extracted production vector pointer, preview, final-position, return-to-origin, portrait publication and deferred ownership assertions. No SwiftUI app or renderer ran.")
    }
}
