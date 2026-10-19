import SwiftUI
import AVFoundation
import ReelKit

enum NativeSourceViewerLayout {
    struct Regions {
        let header: Double
        let picture: Double
        let controls: Double
    }

    static func regions(height: Double, hasRange: Bool, requestedHeader: Double = 32) -> Regions {
        let height = height.isFinite ? max(0, height) : 0
        let header = min(requestedHeader.isFinite ? max(0, requestedHeader) : 32, height)
        let available = height - header
        let controls = hasRange ? min(236, available * 0.6) : 0
        return Regions(header: header, picture: available - controls, controls: controls)
    }

    static func macRegions(width: Double, height: Double, hasRange: Bool) -> Regions {
        let safeHeight = height.isFinite ? max(0, height) : 0
        let safeWidth = width.isFinite ? max(0, width) : 0
        let header = min(32, safeHeight)
        let available = safeHeight - header
        let preferredControls = safeWidth >= 600 ? 116.0 : 184.0
        let controls = hasRange ? min(preferredControls, available * 0.5) : 0
        return Regions(header: header, picture: available - controls, controls: controls)
    }
}

enum NativeTimelineViewerLayout {
    struct Regions {
        let header: Double
        let picture: Double
        let transport: Double
        let divider: Double
    }

    static func regions(height: Double, requestedHeader: Double, requestedTransport: Double) -> Regions {
        let height = height.isFinite ? max(0, height) : 0
        let requestedHeader = requestedHeader.isFinite ? max(0, requestedHeader) : 52
        let requestedTransport = requestedTransport.isFinite ? max(0, requestedTransport) : 88
        let divider = min(1, height)
        let available = height - divider
        let pictureFloor = min(40, max(0, available - 88))
        let controls = max(0, available - pictureFloor)
        if requestedHeader + requestedTransport <= controls {
            return Regions(header: requestedHeader, picture: available - requestedHeader - requestedTransport,
                           transport: requestedTransport, divider: divider)
        }
        let header = min(requestedHeader, controls >= 88 ? controls - 44 : controls * 0.4)
        return Regions(header: header, picture: pictureFloor, transport: controls - header, divider: divider)
    }
}

enum NativeViewerGeometry {
    struct Layout: Equatable {
        let size: CGSize
        let canvas: CGSize
        let scale: Double
    }

    struct Viewport: Equatable {
        let size: CGSize
        let canvas: CGSize
        let scale: Double
        let imageRect: CGRect
        var layout: Layout { Layout(size: size, canvas: canvas, scale: scale) }

        init?(size: CGSize, canvas: CGSize, scale: Double, imageAspect: Double) {
            guard [size.width, size.height, canvas.width, canvas.height, scale, imageAspect].allSatisfy({ $0.isFinite && $0 > 0 && $0 <= 1e8 }) else { return nil }
            let width = canvas.width * scale, height = canvas.height * scale
            let fittedWidth = min(width, height * imageAspect), fittedHeight = fittedWidth / imageAspect
            guard [fittedWidth, fittedHeight].allSatisfy({ $0.isFinite && $0 > 0 && $0 <= 1e8 }) else { return nil }
            self.size = size; self.canvas = canvas; self.scale = scale
            imageRect = CGRect(x: (size.width - fittedWidth) / 2, y: (size.height - fittedHeight) / 2, width: fittedWidth, height: fittedHeight)
        }

        func screen(_ point: CGPoint) -> CGPoint {
            CGPoint(x: imageRect.minX + point.x / canvas.width * imageRect.width, y: imageRect.minY + point.y / canvas.height * imageRect.height)
        }
        func project(_ point: CGPoint) -> CGPoint {
            CGPoint(x: (point.x - imageRect.minX) / imageRect.width * canvas.width, y: (point.y - imageRect.minY) / imageRect.height * canvas.height)
        }
        func visible(_ point: CGPoint) -> Bool {
            point.x.isFinite && point.y.isFinite && point.x >= 0 && point.y >= 0 && point.x < size.width && point.y < size.height
        }
        func normalized(_ point: CGPoint) -> CGPoint? {
            guard visible(point) else { return nil }
            let p = CGPoint(x: (point.x - imageRect.minX) / imageRect.width, y: (point.y - imageRect.minY) / imageRect.height)
            return p.x >= 0 && p.y >= 0 && p.x < 1 && p.y < 1 ? p : nil
        }
    }

    struct Layer {
        let id: String
        let kind: String
        let pose: [String: Any]
        let matrix: [Double]
        let inverse: [Double]
        let localRect: CGRect
        var corners: [CGPoint] { [CGPoint(x: localRect.minX, y: localRect.minY), CGPoint(x: localRect.maxX, y: localRect.minY), CGPoint(x: localRect.maxX, y: localRect.maxY), CGPoint(x: localRect.minX, y: localRect.maxY)].map { NativeViewerGeometry.apply(matrix, $0) } }
        var anchor: CGPoint { NativeViewerGeometry.apply(matrix, CGPoint(x: pose.number("anchorX"), y: pose.number("anchorY"))) }

        init?(_ record: [String: Any]) {
            let id = record.string("id"), kind = record.string("kind"), width = record.number("width", .nan), height = record.number("height", .nan)
            let matrix = (record["matrix"] as? [NSNumber])?.map(\.doubleValue) ?? []
            guard !id.isEmpty, ["color", "title", "shape", "comp", "image", "video", "multicam"].contains(kind),
                  width.isFinite, height.isFinite, width > 0, height > 0, width <= 1e8, height <= 1e8,
                  let inverse = NativeViewerGeometry.inverse(matrix), let pose = record["pose"] as? [String: Any] else { return nil }
            let crop = record.dictionary("crop"), left = crop.number("l"), right = crop.number("r"), top = crop.number("t"), bottom = crop.number("b")
            guard [left, right, top, bottom].allSatisfy(\.isFinite) else { return nil }
            let x0 = width * (max(0, left) - 0.5), x1 = width * (min(1, 1 - right) - 0.5)
            let y0 = height * (max(0, top) - 0.5), y1 = height * (min(1, 1 - bottom) - 0.5)
            guard x1 > x0, y1 > y0 else { return nil }
            self.id = id; self.kind = kind; self.pose = pose; self.matrix = matrix; self.inverse = inverse
            localRect = CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
            guard corners.allSatisfy({ $0.x.isFinite && $0.y.isFinite && abs($0.x) <= 1e8 && abs($0.y) <= 1e8 }), anchor.x.isFinite, anchor.y.isFinite else { return nil }
        }
        func contains(_ point: CGPoint) -> Bool {
            guard point.x.isFinite, point.y.isFinite else { return false }
            let local = NativeViewerGeometry.apply(inverse, point)
            return local.x >= localRect.minX && local.x <= localRect.maxX && local.y >= localRect.minY && local.y <= localRect.maxY
        }
        func handles(in viewport: Viewport) -> [CGPoint] {
            let p = corners.map(viewport.screen), midpoint = CGPoint(x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2)
            let center = CGPoint(x: p.map(\.x).reduce(0, +) / 4, y: p.map(\.y).reduce(0, +) / 4)
            let dx = midpoint.x - center.x, dy = midpoint.y - center.y, length = hypot(dx, dy)
            let rotation = CGPoint(x: midpoint.x + (length > 1e-8 ? dx / length : 0) * 28, y: midpoint.y + (length > 1e-8 ? dy / length : -1) * 28)
            return p + [rotation]
        }
    }

    enum Target: Equatable { case move, scale(Int), rotate }
    struct Drag {
        let layer: Layer
        let target: Target
        let start: CGPoint
        let parentInverse: [Double]
        let parentAnchor: CGPoint

        init?(layer: Layer, target: Target, start: CGPoint) {
            guard start.x.isFinite, start.y.isFinite,
                  let inverse = NativeViewerGeometry.inverse((layer.pose["parentMatrix"] as? [NSNumber])?.map(\.doubleValue) ?? []) else { return nil }
            self.layer = layer; self.target = target; self.start = start; parentInverse = inverse
            parentAnchor = NativeViewerGeometry.apply(inverse, layer.anchor)
            if target != .move {
                let p = NativeViewerGeometry.apply(inverse, start)
                guard hypot(p.x - parentAnchor.x, p.y - parentAnchor.y) > 1e-6 else { return nil }
            }
        }
        func values(at point: CGPoint) -> (dx: Double, dy: Double, magnification: Double, rotation: Double)? {
            guard point.x.isFinite, point.y.isFinite else { return nil }
            if target == .move { return (Double(point.x - start.x), Double(point.y - start.y), 1, 0) }
            let a = NativeViewerGeometry.apply(parentInverse, start), b = NativeViewerGeometry.apply(parentInverse, point)
            let ax = a.x - parentAnchor.x, ay = a.y - parentAnchor.y, bx = b.x - parentAnchor.x, by = b.y - parentAnchor.y
            let dot = ax * bx + ay * by, cross = ax * by - ay * bx
            if target == .rotate {
                guard hypot(bx, by) > 1e-6 else { return nil }
                return (0, 0, 1, Double(atan2(cross, dot) * 180 / .pi))
            }
            let ratio = dot / (ax * ax + ay * ay)
            guard ratio.isFinite, ratio > 1e-6, ratio <= 1e6 else { return nil }
            return (0, 0, Double(ratio), 0)
        }
    }

    static func inverse(_ matrix: [Double]) -> [Double]? {
        guard matrix.count == 6, matrix.allSatisfy(\.isFinite) else { return nil }
        let det = matrix[0] * matrix[3] - matrix[1] * matrix[2]
        guard det.isFinite, abs(det) > 1e-9 else { return nil }
        let result = [matrix[3] / det, -matrix[1] / det, -matrix[2] / det, matrix[0] / det, (matrix[2] * matrix[5] - matrix[3] * matrix[4]) / det, (matrix[1] * matrix[4] - matrix[0] * matrix[5]) / det]
        return result.allSatisfy(\.isFinite) ? result : nil
    }
    static func apply(_ matrix: [Double], _ p: CGPoint) -> CGPoint { CGPoint(x: matrix[0] * p.x + matrix[2] * p.y + matrix[4], y: matrix[1] * p.x + matrix[3] * p.y + matrix[5]) }
    static func unwrappedRotation(_ angle: Double, previous: Double) -> Double { angle + 360 * ((previous - angle) / 360).rounded() }
    static func layers(_ records: [[String: Any]]) -> [Layer] {
        guard records.count <= 4096 else { return [] }
        return records.compactMap(Layer.init)
    }
    static func pick(_ point: CGPoint, viewport: Viewport, layers: [Layer]) -> String? {
        guard viewport.normalized(point) != nil else { return nil }
        return layers.reversed().first(where: { $0.contains(viewport.project(point)) })?.id
    }
    static func canEdit(_ mode: String, clip: [String: Any]) -> Bool {
        let properties = mode == "move" ? ["x", "y"] : [mode == "scale" ? "scale" : "rotation"]
        return !clip.flag("locked") && properties.allSatisfy { clip.dictionary("expr")[$0] == nil }
    }
    static func target(_ point: CGPoint, viewport: Viewport, layer: Layer, clip: [String: Any], hitSize: Double) -> Target? {
        guard viewport.visible(point), hitSize.isFinite, hitSize > 0 else { return nil }
        let handles = layer.handles(in: viewport)
        let candidates = handles.indices.filter { index in
            viewport.visible(handles[index]) && canEdit(index == 4 ? "rotate" : "scale", clip: clip) && abs(point.x - handles[index].x) <= hitSize / 2 && abs(point.y - handles[index].y) <= hitSize / 2
        }.sorted {
            let a = hypot(point.x - handles[$0].x, point.y - handles[$0].y), b = hypot(point.x - handles[$1].x, point.y - handles[$1].y)
            return abs(a - b) < 1e-8 ? $0 > $1 : a < b
        }
        if let index = candidates.first { return index == 4 ? .rotate : .scale(index) }
        return viewport.normalized(point) != nil && layer.contains(viewport.project(point)) && canEdit("move", clip: clip) ? .move : nil
    }
}

enum NativeViewerOverlayDispatch: Equatable { case interaction, colorWindow, vector }

struct NativeViewer: View {
    @ObservedObject var model: NativeEditorModel
    var timelineVisible = true
    var toggleTimeline: (() -> Void)? = nil
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .caption) private var viewerReadoutHeight: CGFloat = 16
    @State private var canvasZoom = "Fit"
    @AppStorage("editor.viewer.guides") private var guides = false
    @State private var gesture: GestureSource?
    @State private var attempted = false
    @State private var activeInput: String?
    @State private var multipleSelection = false
    @State private var queuedCommit: GestureSource?
    @State private var viewerLayout: NativeViewerGeometry.Layout?
    @State private var viewerModelID: ObjectIdentifier?
    @State private var vectorMode: String?

    private struct GestureSource {
        let clip: NativeClip
        let track: NativeTrack
        let pose: [String: Any]
        let viewport: NativeViewerGeometry.Viewport
        let drag: NativeViewerGeometry.Drag
        let capture: NativeRenderPreviewCapture
        let mode: String
        let input: String
        let modelID: ObjectIdentifier
        let backendID: ObjectIdentifier
        let panel: NativePanel
        let zoom: String
        var rotation: Double = 0
    }

    private func beginGesture(viewport: NativeViewerGeometry.Viewport, layer: NativeViewerGeometry.Layer, target: NativeViewerGeometry.Target, point: CGPoint, input: String = "pointer") -> GestureSource? {
        let mode = target == .move ? "move" : target == .rotate ? "rotate" : "scale"
        guard let backendID = model.renderPreviewBackendID, gesture == nil, queuedCommit == nil, viewerModelID == ObjectIdentifier(model), viewerLayout == viewport.layout, model.drawing == nil, model.viewerColorPicker == nil, model.selectedIDs.count == 1,
              model.viewerGeometryIsCurrent(), let clip = model.selected, clip.id == layer.id, clip.kind == layer.kind, NativeViewerGeometry.canEdit(mode, clip: clip.fields),
              model.tracks.flatMap(\.clips).filter({ $0.id == clip.id }).count == 1,
              let track = model.tracks.first(where: { $0.clips.contains(where: { $0.id == clip.id }) }), !track.locked, !clip.fields.flag("locked"),
              let drag = NativeViewerGeometry.Drag(layer: layer, target: target, start: point),
              let capture = model.beginRenderPreview(renderedVersion: model.version) else { return nil }
        return GestureSource(clip: clip, track: track, pose: layer.pose, viewport: viewport, drag: drag, capture: capture, mode: mode, input: input, modelID: ObjectIdentifier(model), backendID: backendID, panel: model.panel, zoom: canvasZoom)
    }

    private func gestureOperations(_ source: GestureSource, point: CGPoint? = nil, magnification: Double = 1) throws -> [[String: Any]] {
        guard let values = point.map({ source.drag.values(at: source.viewport.project($0)) }) ?? (0, 0, magnification, 0) else {
            throw NativeViewerTransformEdits.Failure(message: "Keep the scale handle on the same side of the layer's anchor.")
        }
        let rotation = NativeViewerGeometry.unwrappedRotation(values.3, previous: source.rotation)
        if gesture?.capture.id == source.capture.id { gesture?.rotation = rotation }
        return try NativeViewerTransformEdits.make(clip: source.clip.fields, pose: source.pose, at: source.capture.time,
                                                  deltaX: values.0, deltaY: values.1, magnification: values.2, rotationDelta: rotation, mode: source.mode)
    }

    private func gestureContextMatches(_ source: GestureSource) -> Bool {
        guard ObjectIdentifier(model) == source.modelID, viewerModelID == source.modelID, model.renderPreviewBackendID == source.backendID, model.project != nil, model.metalFrame != nil, model.renderError == nil, model.panel == source.panel, canvasZoom == source.zoom,
              viewerLayout == source.viewport.layout, model.width == source.viewport.canvas.width, model.height == source.viewport.canvas.height,
              model.drawing == nil, model.viewerColorPicker == nil, model.selectedID == source.clip.id, let clip = model.selected,
              model.tracks.flatMap(\.clips).filter({ $0.id == clip.id }).count == 1,
              model.tracks.filter({ $0.id == source.track.id }).count == 1,
              let track = model.tracks.first(where: { $0.id == source.track.id }), !track.locked, !clip.fields.flag("locked") else { return false }
        return NSDictionary(dictionary: clip.fields).isEqual(to: source.clip.fields) && NSDictionary(dictionary: track.fields).isEqual(to: source.track.fields)
    }

    private func gestureMatches(_ source: GestureSource, viewport: NativeViewerGeometry.Viewport? = nil) -> Bool {
        (viewport == nil || source.viewport.layout == viewport?.layout) &&
            gestureContextMatches(source) && model.viewerGeometryIsCurrent(capture: source.capture)
    }

    private func queuedCommitMatches(_ source: GestureSource) -> Bool {
        gestureContextMatches(source) && model.renderPreviewCommitMatches(source.capture)
    }

    private func endGesture(_ source: GestureSource, operations: [[String: Any]], viewport: NativeViewerGeometry.Viewport) {
        guard queuedCommit == nil, gestureMatches(source, viewport: viewport) else { model.discardRenderPreview(source.capture); model.status = "The project, selection or viewer changed during the gesture. Try again."; return }
        model.discardRenderPreview(source.capture)
        guard !operations.isEmpty else { return }
        queuedCommit = source
        let scoped = operations.map { operation -> [String: Any] in
            var operation = operation; operation["comp"] = source.capture.composition as Any? ?? NSNull(); return operation
        }
        let body: [String: Any] = ["ops": scoped, "who": "you", "summary": "\(source.mode.capitalized) selected layer",
                                   "expectedVersion": source.capture.version, "returnProject": true]
        model.perform { [self] in
            guard queuedCommit?.capture.id == source.capture.id else { return }
            queuedCommit = nil
            guard queuedCommitMatches(source) else { model.status = "The project, selection or viewer changed before the gesture was applied. Try again."; return }
            _ = try await model.call("/api/ops", body)
        }
    }

    private func cancelGesture(resetAttempt: Bool = true) {
        if let gesture { model.discardRenderPreview(gesture.capture) }
        gesture = nil; queuedCommit = nil
        if resetAttempt { attempted = false; activeInput = nil }
    }

    private func cancelInvalidGesture() {
        model.viewerColorWindow?.invalidateIfChanged()
        if let gesture, !gestureMatches(gesture) { cancelGesture(resetAttempt: false) }
        if let queuedCommit, !queuedCommitMatches(queuedCommit) { cancelGesture(resetAttempt: false) }
    }

    private func updateViewerLayout(_ layout: NativeViewerGeometry.Layout?) {
        if viewerLayout != layout { cancelGesture(resetAttempt: false); viewerLayout = layout }
    }

    private var extendingSelection: Bool {
        #if os(macOS)
        multipleSelection || NSEvent.modifierFlags.contains(.shift) || NSEvent.modifierFlags.contains(.command)
        #else
        multipleSelection
        #endif
    }

    private var handleHitSize: Double {
        #if os(iOS)
        44
        #else
        28
        #endif
    }

    private func layers() -> [NativeViewerGeometry.Layer] {
        guard model.viewerGeometryIsCurrent(capture: gesture?.capture), let frame = model.metalFrame,
              let records = try? JSON.parse(frame.drawGeometry.text) as? [[String: Any]] else { return [] }
        return NativeViewerGeometry.layers(records)
    }

    private func selectedLayer(_ layers: [NativeViewerGeometry.Layer]) -> NativeViewerGeometry.Layer? {
        guard model.selectedIDs.count == 1 else { return nil }
        return layers.first { $0.id == model.selectedID }
    }

    private func editable(_ clip: NativeClip) -> Bool {
        !clip.fields.flag("locked") && model.tracks.first(where: { $0.clips.contains { $0.id == clip.id } })?.locked == false
    }

    private func tap(_ point: CGPoint, viewport: NativeViewerGeometry.Viewport, layers: [NativeViewerGeometry.Layer]) {
        if let picker = model.viewerColorPicker {
            guard model.frameCaptureMatches(picker.capture), let normalized = viewport.normalized(point) else { return }
            picker.onPick(normalized.x, normalized.y)
            return
        }
        guard model.drawing == nil, model.viewerGeometryIsCurrent() else { return }
        if let layer = selectedLayer(layers), let clip = model.selected, editable(clip),
           let target = NativeViewerGeometry.target(point, viewport: viewport, layer: layer, clip: clip.fields, hitSize: handleHitSize), target != .move { return }
        model.select(id: NativeViewerGeometry.pick(point, viewport: viewport, layers: layers), extending: extendingSelection)
    }

    private func interaction(viewport: NativeViewerGeometry.Viewport, layers: [NativeViewerGeometry.Layer]) -> some Gesture {
        DragGesture(minimumDistance: 3).exclusively(before: SpatialTapGesture())
            .onChanged { value in
                guard case .first(let drag) = value, model.viewerColorPicker == nil, model.drawing == nil else { return }
                if !attempted {
                    attempted = true; activeInput = "pointer"
                    guard model.viewerGeometryIsCurrent() else { return }
                    if let selected = selectedLayer(layers), let clip = model.selected, editable(clip),
                       let target = NativeViewerGeometry.target(drag.startLocation, viewport: viewport, layer: selected, clip: clip.fields, hitSize: handleHitSize) {
                        if extendingSelection && target == .move { model.select(id: selected.id, extending: true) }
                        else { gesture = beginGesture(viewport: viewport, layer: selected, target: target, point: viewport.project(drag.startLocation)) }
                    } else if let id = NativeViewerGeometry.pick(drag.startLocation, viewport: viewport, layers: layers), let layer = layers.first(where: { $0.id == id }) {
                        model.select(id: id, extending: extendingSelection)
                        if !extendingSelection { gesture = beginGesture(viewport: viewport, layer: layer, target: .move, point: viewport.project(drag.startLocation)) }
                    }
                }
                guard let source = gesture, source.input == "pointer" else { return }
                guard gestureMatches(source, viewport: viewport) else { cancelGesture(resetAttempt: false); return }
                do { _ = model.preview(try gestureOperations(source, point: drag.location), capture: source.capture) }
                catch { cancelGesture(resetAttempt: false); model.status = error.localizedDescription }
            }
            .onEnded { value in
                switch value {
                case .first(let drag):
                    guard activeInput == "pointer" else { return }
                    defer { gesture = nil; attempted = false; activeInput = nil }
                    guard let source = gesture else { return }
                    guard source.viewport.layout == viewport.layout else { model.discardRenderPreview(source.capture); return }
                    do { endGesture(source, operations: try gestureOperations(source, point: drag.location), viewport: viewport) }
                    catch { model.discardRenderPreview(source.capture); model.status = error.localizedDescription }
                case .second(let value):
                    guard gesture == nil else { return }
                    attempted = false; activeInput = nil; tap(value.location, viewport: viewport, layers: layers)
                }
            }
    }

    private func accessibleEdit(_ mode: String, amount: Double, vertical: Bool = false, viewport: NativeViewerGeometry.Viewport, layer: NativeViewerGeometry.Layer) {
        guard let point = layer.corners.first(where: { hypot($0.x - layer.anchor.x, $0.y - layer.anchor.y) > 1e-6 }),
              let source = beginGesture(viewport: viewport, layer: layer, target: mode == "move" ? .move : mode == "rotate" ? .rotate : .scale(0), point: point) else { return }
        do {
            let edits = try NativeViewerTransformEdits.make(clip: source.clip.fields, pose: source.pose, at: source.capture.time,
                                                            deltaX: mode == "move" && !vertical ? amount : 0, deltaY: mode == "move" && vertical ? amount : 0, magnification: mode == "scale" ? amount : 1,
                                                            rotationDelta: mode == "rotate" ? amount : 0, mode: mode)
            endGesture(source, operations: edits, viewport: viewport)
        } catch { model.discardRenderPreview(source.capture); model.status = error.localizedDescription }
    }

    @ViewBuilder private func interactionOverlay(viewport: NativeViewerGeometry.Viewport, layers: [NativeViewerGeometry.Layer]) -> some View {
        ZStack {
            Canvas { context, _ in
                for layer in layers where model.selectedIDs.contains(layer.id) {
                    let points = layer.corners.map(viewport.screen)
                    var path = Path(); path.move(to: points[0]); points.dropFirst().forEach { path.addLine(to: $0) }; path.closeSubpath()
                    context.stroke(path, with: .color(NativeEditorStyle.accent.opacity(layer.id == model.selectedID ? 1 : 0.6)), lineWidth: 1.5)
                    if model.selectedIDs.count == 1, let clip = model.selected, editable(clip) {
                        let handles = layer.handles(in: viewport)
                        if NativeViewerGeometry.canEdit("rotate", clip: clip.fields) {
                            var stem = Path(); stem.move(to: CGPoint(x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2)); stem.addLine(to: handles[4])
                            context.stroke(stem, with: .color(NativeEditorStyle.accent), lineWidth: 1)
                        }
                        for index in handles.indices where viewport.visible(handles[index]) && NativeViewerGeometry.canEdit(index == 4 ? "rotate" : "scale", clip: clip.fields) {
                            let rect = CGRect(x: handles[index].x - 4, y: handles[index].y - 4, width: 8, height: 8)
                            context.fill(index == 4 ? Path(ellipseIn: rect) : Path(rect), with: .color(NativeEditorStyle.accent))
                        }
                    }
                }
            }.allowsHitTesting(false).accessibilityHidden(true)
            Color.clear.contentShape(Rectangle()).gesture(interaction(viewport: viewport, layers: layers))
                .simultaneousGesture(MagnifyGesture().onChanged { value in
                    if !attempted {
                        attempted = true; activeInput = "pinch"
                        if let layer = selectedLayer(layers), let point = layer.corners.first(where: { hypot($0.x - layer.anchor.x, $0.y - layer.anchor.y) > 1e-6 }) {
                            gesture = beginGesture(viewport: viewport, layer: layer, target: .scale(0), point: point, input: "pinch")
                        }
                    }
                    guard let source = gesture, source.input == "pinch" else { return }
                    guard gestureMatches(source, viewport: viewport) else { cancelGesture(resetAttempt: false); return }
                    do { _ = model.preview(try gestureOperations(source, magnification: value.magnification), capture: source.capture) }
                    catch { cancelGesture(resetAttempt: false); model.status = error.localizedDescription }
                }.onEnded { value in
                    guard activeInput == "pinch" else { return }
                    defer { gesture = nil; attempted = false; activeInput = nil }
                    guard let source = gesture else { return }
                    guard source.viewport.layout == viewport.layout else { model.discardRenderPreview(source.capture); return }
                    do { endGesture(source, operations: try gestureOperations(source, magnification: value.magnification), viewport: viewport) }
                    catch { model.discardRenderPreview(source.capture); model.status = error.localizedDescription }
                })
                .accessibilityLabel("Viewer layer selection")
            VStack {
                HStack {
                    Spacer()
                    Menu {
                        Button(multipleSelection ? "Use single selection" : "Use multiple selection") { multipleSelection.toggle() }
                        if let layer = selectedLayer(layers), let clip = model.selected, editable(clip) {
                            Divider()
                            Button("Edit anchor point") { cancelGesture(); vectorMode = "anchor" }
                            if clip.kind == "shape", clip.fields.dictionary("shape").string("type") == "path" {
                                Button("Edit vector path points") { cancelGesture(); vectorMode = "path" }
                            }
                            Divider()
                            Group {
                                Button("Move left one canvas pixel") { accessibleEdit("move", amount: -1, viewport: viewport, layer: layer) }
                                Button("Move right one canvas pixel") { accessibleEdit("move", amount: 1, viewport: viewport, layer: layer) }
                                Button("Move up one canvas pixel") { accessibleEdit("move", amount: -1, vertical: true, viewport: viewport, layer: layer) }
                                Button("Move down one canvas pixel") { accessibleEdit("move", amount: 1, vertical: true, viewport: viewport, layer: layer) }
                            }.disabled(!NativeViewerGeometry.canEdit("move", clip: clip.fields))
                            Group {
                                Button("Scale up five percent") { accessibleEdit("scale", amount: 1.05, viewport: viewport, layer: layer) }
                                Button("Scale down five percent") { accessibleEdit("scale", amount: 1 / 1.05, viewport: viewport, layer: layer) }
                            }.disabled(!NativeViewerGeometry.canEdit("scale", clip: clip.fields))
                            Group {
                                Button("Rotate left one degree") { accessibleEdit("rotate", amount: -1, viewport: viewport, layer: layer) }
                                Button("Rotate right one degree") { accessibleEdit("rotate", amount: 1, viewport: viewport, layer: layer) }
                            }.disabled(!NativeViewerGeometry.canEdit("rotate", clip: clip.fields))
                        }
                    } label: { Image(systemName: multipleSelection ? "cursorarrow.and.square.on.square.dashed" : "cursorarrow.square") }
                    .buttonStyle(NativeToolbarButtonStyle(selected: multipleSelection)).accessibilityLabel("Viewer layer controls")
                    .disabled(model.viewerColorPicker != nil || gesture != nil || queuedCommit != nil)
                }
                Spacer()
            }.padding(8)
        }.frame(width: viewport.size.width, height: viewport.size.height)
    }

    @ViewBuilder private func comparisonOverlay(viewport: NativeViewerGeometry.Viewport) -> some View {
        if model.viewerColorPicker == nil, let comparison = model.viewerComparison, model.viewerComparisonMatches(comparison) {
            let fraction = model.viewerComparisonFraction.isFinite ? min(1, max(0, model.viewerComparisonFraction)) : 0.5
            Image(decorative: comparison.image, scale: 1).resizable().aspectRatio(contentMode: .fit)
                .frame(width: viewport.imageRect.width, height: viewport.imageRect.height)
                .mask(alignment: .leading) { Rectangle().frame(width: viewport.imageRect.width * fraction) }
                .position(x: viewport.imageRect.midX, y: viewport.imageRect.midY).allowsHitTesting(false)
            VStack { Spacer(); HStack { Text(comparison.caption).font(.caption2).padding(5).background(NativeEditorStyle.panel.opacity(0.9), in: RoundedRectangle(cornerRadius: 4)); Spacer() } }
                .padding(8).allowsHitTesting(false)
        }
    }

    @ViewBuilder private func comparisonHandle(viewport: NativeViewerGeometry.Viewport) -> some View {
        if model.viewerColorPicker == nil, let comparison = model.viewerComparison, model.viewerComparisonMatches(comparison) {
            let fraction = model.viewerComparisonFraction.isFinite ? min(1, max(0, model.viewerComparisonFraction)) : 0.5
            let x = viewport.imageRect.minX + viewport.imageRect.width * fraction
            let visibleRect = viewport.imageRect.intersection(CGRect(origin: .zero, size: viewport.size))
            if !visibleRect.isNull, x >= 0, x < viewport.size.width {
                Rectangle().fill(.white.opacity(0.8)).frame(width: 1, height: visibleRect.height).position(x: x, y: visibleRect.midY).allowsHitTesting(false)
                Image(systemName: "arrow.left.and.right").font(.caption.weight(.semibold)).foregroundStyle(.black)
                    .frame(width: 28, height: 24).background(NativeEditorStyle.accent, in: RoundedRectangle(cornerRadius: 4))
                    .frame(width: 44, height: 44).contentShape(Rectangle()).position(x: x, y: visibleRect.midY)
                    .gesture(DragGesture(coordinateSpace: .named("nativeViewerViewport")).onChanged { value in
                        guard model.viewerComparison?.id == comparison.id, model.viewerComparisonMatches(comparison), model.viewerColorPicker == nil else { return }
                        model.viewerComparisonFraction = min(1, max(0, (value.location.x - viewport.imageRect.minX) / viewport.imageRect.width))
                    }).accessibilityLabel("Comparison divider")
                    .accessibilityValue("\(Int(fraction * 100)) percent")
                    .accessibilityAdjustableAction { direction in
                        guard model.viewerComparison?.id == comparison.id, model.viewerComparisonMatches(comparison) else { return }
                        model.viewerComparisonFraction = min(1, max(0, fraction + (direction == .increment ? 0.05 : -0.05)))
                    }
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            #if os(iOS)
            if model.showingSource {
                HStack(spacing: 8) {
                    mobileViewerMode
                    Spacer(minLength: 0)
                    mobileViewerFocusButton
                }.padding(.horizontal, 6)
                    .background(NativeEditorStyle.panel)
                NativeSourceViewer(model: model)
            } else { timelineViewer }
            #else
            Picker("Viewer", selection: $model.showingSource) {
                Text("Timeline").tag(false)
                Text("Source").tag(true)
            }.pickerStyle(.segmented).labelsHidden().frame(width: 168).tint(NativeEditorStyle.accent).padding(6).frame(maxWidth: .infinity, alignment: .leading)
                .background(NativeEditorStyle.panel)
            if model.showingSource { NativeSourceViewer(model: model) }
            else { timelineViewer }
            #endif
        }
    }

    #if os(iOS)
    @ViewBuilder private var mobileViewerMode: some View {
        ViewThatFits(in: .horizontal) {
            if !dynamicTypeSize.isAccessibilitySize {
                HStack(spacing: 2) {
                    viewerModeButton("Timeline", source: false)
                    viewerModeButton("Source", source: true)
                }.fixedSize(horizontal: true, vertical: false).padding(.horizontal, 4)
            }
            Menu {
                Picker("Viewer", selection: $model.showingSource) {
                    Text("Timeline").tag(false)
                    Text("Source").tag(true)
                }
            } label: { Image(systemName: model.showingSource ? "play.rectangle" : "film") }
                .buttonStyle(NativeViewerChromeButtonStyle())
                .accessibilityLabel("Viewer mode").accessibilityValue(model.showingSource ? "Source" : "Timeline")
                .accessibilityIdentifier("viewer.mode")
        }.background(NativeEditorStyle.panel)
    }

    private func viewerModeButton(_ title: String, source: Bool) -> some View {
        Button { model.showingSource = source } label: {
            Text(title).font(.caption.weight(.semibold)).padding(.horizontal, 12)
                .frame(minWidth: 72, minHeight: 44)
                .foregroundStyle(model.showingSource == source ? NativeEditorStyle.accent : NativeEditorStyle.muted)
                .background(model.showingSource == source ? NativeEditorStyle.selectionFill : .clear, in: RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain)
            .accessibilityLabel("\(title) viewer")
            .accessibilityAddTraits(model.showingSource == source ? [.isSelected] : [])
            .accessibilityIdentifier(source ? "viewer.mode.source" : "viewer.mode.timeline")
    }

    private var mobileTimelineHeader: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                mobileViewerMode
                Text(model.project?.compositions.first(where: { $0.id == model.composition })?.name ?? "Main timeline")
                    .font(.caption.weight(.semibold)).fixedSize(horizontal: true, vertical: false)
                Spacer(minLength: 0)
                mobileViewerSettings
                mobileViewerFocusButton
            }
            HStack(spacing: 8) { mobileViewerMode; Spacer(minLength: 0); mobileViewerSettings; mobileViewerFocusButton }
        }.padding(.horizontal, 6).frame(minHeight: 44).background(NativeEditorStyle.panel)
    }

    @ViewBuilder private var mobileViewerFocusButton: some View {
        if let toggleTimeline {
            Button(action: toggleTimeline) {
                Image(systemName: timelineVisible ? "arrow.up.left.and.arrow.down.right" : "arrow.down.right.and.arrow.up.left")
            }.buttonStyle(NativeViewerChromeButtonStyle())
                .accessibilityLabel(timelineVisible ? "Expand viewer" : "Show timeline")
                .accessibilityHint(timelineVisible ? "Hides the timeline so you can inspect the picture" : "Restores the timeline below or beside the viewer")
                .accessibilityIdentifier("viewer.expand")
        }
    }

    private var mobileViewerSettings: some View {
        Menu {
            Text(model.project?.compositions.first(where: { $0.id == model.composition })?.name ?? "Main timeline")
            Text("\(Int(model.width)) × \(Int(model.height)) · \(model.fps.formatted()) fps")
            Picker("Viewer zoom", selection: $canvasZoom) {
                ForEach(["Fit", "25%", "50%", "100%"], id: \.self) { Text($0).tag($0) }
            }
            Toggle("Safe-area guides", isOn: $guides)
        } label: { Image(systemName: "slider.horizontal.3") }
            .buttonStyle(NativeViewerChromeButtonStyle())
            .accessibilityLabel("Viewer settings")
            .accessibilityValue("\(canvasZoom) zoom, safe-area guides \(guides ? "on" : "off")")
            .accessibilityIdentifier("viewer.settings")
    }
    #endif

    @ViewBuilder private var timelineHeader: some View {
        #if os(iOS)
        mobileTimelineHeader
        #else
        HStack(spacing: 10) {
            Text(model.project?.compositions.first(where: { $0.id == model.composition })?.name ?? "Main timeline")
                .font(.caption.weight(.semibold)).lineLimit(1)
            Spacer(minLength: 0)
            Text("\(Int(model.width)) × \(Int(model.height)) · \(model.fps.formatted()) fps")
                .font(.caption2).monospacedDigit().foregroundStyle(NativeEditorStyle.muted).lineLimit(1)
            Picker("Viewer zoom", selection: $canvasZoom) {
                ForEach(["Fit", "25%", "50%", "100%"], id: \.self) { Text($0).tag($0) }
            }.labelsHidden().frame(width: 65)
            Button { guides.toggle() } label: { Image(systemName: "viewfinder") }
                .buttonStyle(NativeToolbarButtonStyle(selected: guides)).help("Safe-area guides").accessibilityLabel("Safe-area guides")
        }.padding(.horizontal, 10).frame(height: 40).background(NativeEditorStyle.panel)
        #endif
    }

    private func overlayDispatch() -> NativeViewerOverlayDispatch {
        if model.viewerColorPicker != nil { return .interaction }
        if model.panel == .color, let controller = model.viewerColorWindow {
            return controller.plane() == nil ? .interaction : .colorWindow
        }
        return vectorMode == nil ? .interaction : .vector
    }

    @ViewBuilder private var timelineCanvas: some View {
        GeometryReader { geometry in
            let fit = min(geometry.size.width / model.width, geometry.size.height / model.height)
            let scale = canvasZoom == "Fit" ? fit : (Double(canvasZoom.replacingOccurrences(of: "%", with: "")) ?? 100) / 100
            let viewport = NativeViewerGeometry.Viewport(size: geometry.size, canvas: CGSize(width: model.width, height: model.height), scale: scale, imageAspect: model.metalFrame.map { Double($0.width) / Double($0.height) } ?? model.width / model.height)
            let visibleLayers = layers()
            ZStack {
                // A flat neutral surround, as in Final Cut and Resolve. A pattern beside
                // the frame makes edges and exposure harder to judge.
                NativeEditorStyle.viewer
                if let frame = model.metalFrame {
                    NativeMetalViewer(texture: frame.texture)
                        .frame(width: model.width * scale, height: model.height * scale)
                        .allowsHitTesting(false)
                    if guides {
                        ZStack {
                            Rectangle().stroke(.white.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [5, 4])).padding(.horizontal, model.width * scale * 0.05).padding(.vertical, model.height * scale * 0.05)
                            Rectangle().stroke(.white.opacity(0.2), style: StrokeStyle(lineWidth: 1, dash: [5, 4])).padding(.horizontal, model.width * scale * 0.1).padding(.vertical, model.height * scale * 0.1)
                        }.frame(width: model.width * scale, height: model.height * scale).allowsHitTesting(false)
                    }
                } else if let error = model.renderError, !timelineIsEmpty {
                    Text(error).font(.callout).foregroundStyle(.white).multilineTextAlignment(.center).padding()
                } else if model.project != nil, !timelineIsEmpty {
                    ProgressView("Rendering frame").tint(.white).foregroundStyle(.white)
                } else if model.project == nil {
                    VStack(spacing: 10) {
                        Text("Create a project in this folder").foregroundStyle(.white)
                        Button("Create project") { model.perform { _ = try await model.call("/api/new", ["name": model.folder?.lastPathComponent ?? "Untitled"]); await model.refresh() } }
                    }
                }
                if timelineIsEmpty {
                    ScrollView(.vertical) { emptyTimelineCard.padding(12) }
                        .scrollBounceBehavior(.basedOnSize)
                        .frame(maxWidth: 440, maxHeight: geometry.size.height)
                }
                if let viewport, model.metalFrame != nil, model.duration > 0, !timelineIsEmpty, model.drawing == nil {
                    comparisonOverlay(viewport: viewport)
                    let dispatch = overlayDispatch()
                    if let controller = model.viewerColorWindow, model.panel == .color {
                        ZStack {
                            if dispatch == .interaction { interactionOverlay(viewport: viewport, layers: visibleLayers) }
                            NativeColorWindowOverlay(controller: controller, viewport: viewport)
                                .allowsHitTesting(dispatch == .colorWindow)
                        }
                    } else if dispatch == .vector, let vectorMode {
                        NativeVectorEditingOverlay(model: model, mode: vectorMode, viewport: viewport, onDone: { self.vectorMode = nil })
                            .id("\(vectorMode):\(canvasZoom)")
                    } else { interactionOverlay(viewport: viewport, layers: visibleLayers) }
                    comparisonHandle(viewport: viewport)
                }
                if model.rendering, model.metalFrame != nil {
                    VStack { HStack { Spacer(); ProgressView().controlSize(.small).padding(10) }; Spacer() }
                }
                if let mode = model.drawing {
                    NativeDrawingOverlay(model: model, mode: mode)
                        .frame(width: model.width * scale, height: model.height * scale)
                }
            }.frame(width: geometry.size.width, height: geometry.size.height).coordinateSpace(name: "nativeViewerViewport").clipped()
            .overlay(alignment: .topLeading) {
                if model.viewerColorPicker != nil {
                    HStack {
                        Text("Pick a color in the viewer").font(.caption)
                        Button("Cancel") { model.viewerColorPicker = nil }.buttonStyle(NativeToolbarButtonStyle())
                    }.padding(8).background(NativeEditorStyle.panel, in: RoundedRectangle(cornerRadius: 6)).padding(8)
                } else if let mode = model.drawing {
                    HStack {
                        Text(mode.name).font(.caption)
                        Button("Cancel") { model.drawing = nil }.buttonStyle(NativeToolbarButtonStyle())
                    }.padding(.horizontal, 8).background(NativeEditorStyle.panel, in: RoundedRectangle(cornerRadius: 6)).padding(8)
                }
            }
            .onAppear { viewerModelID = ObjectIdentifier(model); updateViewerLayout(viewport?.layout) }
            .onChange(of: viewport?.layout) { _, layout in updateViewerLayout(layout) }
        }
    }

    private var timelineIsEmpty: Bool {
        guard let project = model.project else { return false }
        if let composition = model.composition {
            guard project.fields.dictionary("comps")[composition] is [String: Any] else { return false }
        }
        return model.tracks.allSatisfy { $0.clips.isEmpty }
    }

    private var emptyTimelineCard: some View {
        VStack(spacing: 12) {
            Image(systemName: "film").font(.system(size: 30)).foregroundStyle(NativeEditorStyle.muted).accessibilityHidden(true)
            Text("Your timeline is ready").font(.subheadline.weight(.semibold))
            Text("Import footage or add an editable title to begin.").font(.caption).foregroundStyle(NativeEditorStyle.muted)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { emptyTimelineActions }.fixedSize(horizontal: true, vertical: false)
                VStack(spacing: 8) { emptyTimelineActions }
            }
            if let error = model.renderError {
                Text(error).font(.caption).foregroundStyle(NativeEditorStyle.warning)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Preview error: \(error)")
            }
        }.padding(24).frame(maxWidth: .infinity)
            .background(NativeEditorStyle.panel.opacity(0.94), in: RoundedRectangle(cornerRadius: 10))
            .accessibilityIdentifier("editor.viewer.emptyTimeline")
    }

    @ViewBuilder private var emptyTimelineActions: some View {
        Button { model.showFiles = true } label: {
            Text("Import media").frame(minHeight: NativeEditorStyle.minimumControlHeight).contentShape(Rectangle())
        }.buttonStyle(NativeToolbarButtonStyle(selected: true))
        Button { model.edit(["op": "add_title", "text": "Your title", "start": 0, "dur": 5, "title": ["size": min(model.width, model.height) * 0.09]]) } label: {
            Text("Add title").frame(minHeight: NativeEditorStyle.minimumControlHeight).contentShape(Rectangle())
        }.buttonStyle(NativeToolbarButtonStyle())
            .disabled(model.busy || model.projectReadOnlyReason != nil)
    }

    @ViewBuilder private var timelineTransport: some View {
        #if os(iOS)
        mobileTimelineTransport(showReadouts: true)
        #else
        GeometryReader { transport in
        HStack(spacing: 6) {
            // Click the playhead timecode, type a time and press Return to move there.
            NativeTimecodeField(label: "Playhead", seconds: model.time, fps: model.fps, range: 0...max(0, model.duration),
                                stepper: false, playhead: true) { model.seek($0) }
            Spacer(minLength: 0)
            if transport.size.width >= 600 {
                Button { model.seek(0) } label: { Image(systemName: "backward.end.alt") }.help("Go to start").accessibilityLabel("Go to start")
            }
            Button { model.step(-1) } label: { Image(systemName: "backward.end") }.help("Previous frame")
            Button { model.togglePlayback() } label: { Image(systemName: model.playing ? "pause.fill" : "play.fill") }
                .keyboardShortcut(.space, modifiers: []).help(model.playing ? "Pause" : "Play")
            Button { model.step(1) } label: { Image(systemName: "forward.end") }.help("Next frame")
            if transport.size.width >= 600 {
                Button { model.seek(model.duration) } label: { Image(systemName: "forward.end.alt") }.help("Go to end").accessibilityLabel("Go to end")
            }
            Spacer(minLength: 0)
            if transport.size.width >= 600 {
                Text(nativeTimecode(model.duration, fps: model.fps)).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
            }
            Menu {
                ForEach(NativeDrawingMode.allCases) { mode in
                    Button(mode.name) {
                        model.pause()
                        if mode == .trackingBox, let clip = model.selected { model.seek(clip.start) }
                        model.drawing = mode
                    }
                    .disabled(mode != .shapePath && (model.selected == nil || model.selected?.kind == "audio") || mode == .trackingBox && (!model.hasCapability("analysis", "tracking") || model.selected?.kind != "video"))
                }
            } label: { Image(systemName: "pencil.tip") }.help("Draw a mask, path, or tracking region")
        }.buttonStyle(NativeToolbarButtonStyle()).padding(.horizontal, 10).frame(height: 44)
        }.frame(height: 44).background(NativeEditorStyle.panel)
        #endif
    }

    #if os(iOS)
    private func mobileTimelineTransport(showReadouts: Bool, inlineReadout: Bool = false) -> some View {
        VStack(spacing: 2) {
            if showReadouts && !inlineReadout {
                NativeViewerTimeReadouts(current: nativeTimecode(model.time, fps: model.fps),
                                       duration: nativeTimecode(model.duration, fps: model.fps), scope: "Timeline",
                                       entry: (model.time, model.fps, model.duration, { model.seek($0) }))
            }
            HStack(spacing: 6) {
                if inlineReadout {
                    // Tap the playhead timecode, type a time and press Return to move there.
                    NativeTimecodeField(label: "Timeline playhead", seconds: model.time, fps: model.fps,
                                        range: 0...max(0, model.duration), stepper: false, playhead: true) { model.seek($0) }
                        .fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 0)
                }
                Button { model.step(-1) } label: { Image(systemName: "backward.end") }
                    .accessibilityLabel("Previous frame")
                Button { model.togglePlayback() } label: { Image(systemName: model.playing ? "pause.fill" : "play.fill") }
                    .keyboardShortcut(.space, modifiers: [])
                    .accessibilityLabel(model.playing ? "Pause timeline" : "Play timeline")
                    .accessibilityIdentifier("viewer.timeline.play")
                Button { model.step(1) } label: { Image(systemName: "forward.end") }
                    .accessibilityLabel("Next frame")
                Menu {
                    Text("Playhead \(nativeTimecode(model.time, fps: model.fps))")
                    Text("Duration \(nativeTimecode(model.duration, fps: model.fps))")
                    Button("Go to start") { model.seek(0) }
                    Button("Go to end") { model.seek(model.duration) }
                    Divider()
                    ForEach(NativeDrawingMode.allCases) { mode in
                        Button(mode.name) {
                            model.pause()
                            if mode == .trackingBox, let clip = model.selected { model.seek(clip.start) }
                            model.drawing = mode
                        }
                        .disabled(mode != .shapePath && (model.selected == nil || model.selected?.kind == "audio") || mode == .trackingBox && (!model.hasCapability("analysis", "tracking") || model.selected?.kind != "video"))
                    }
                } label: { Image(systemName: "ellipsis") }
                    .accessibilityLabel("Timeline navigation and drawing tools")
                    .accessibilityValue("Playhead \(nativeTimecode(model.time, fps: model.fps)), duration \(nativeTimecode(model.duration, fps: model.fps))")
                    .accessibilityIdentifier("viewer.timeline.tools")
            }.buttonStyle(NativeViewerChromeButtonStyle()).frame(maxWidth: .infinity)
        }.padding(.horizontal, 10).padding(.vertical, 4).background(NativeEditorStyle.panel)
    }
    #endif

    @ViewBuilder private var timelineContent: some View {
        #if os(iOS)
        GeometryReader { geometry in
            let inlineReadout = geometry.size.width >= 340 && dynamicTypeSize <= .large
            let showReadouts = geometry.size.height >= (dynamicTypeSize.isAccessibilitySize ? 220 : 160)
            let headerRequest = max(44, Double(viewerReadoutHeight) + 8)
            let transportRequest = showReadouts && !inlineReadout ? 56 + Double(viewerReadoutHeight) * 2 : 52
            let regions = NativeTimelineViewerLayout.regions(height: geometry.size.height, requestedHeader: headerRequest, requestedTransport: transportRequest)
            VStack(spacing: 0) {
                ScrollView(.vertical) { timelineHeader.frame(minHeight: headerRequest) }
                    .scrollBounceBehavior(.basedOnSize).frame(height: regions.header)
                Rectangle().fill(NativeEditorStyle.line).frame(height: regions.divider)
                timelineCanvas.frame(height: regions.picture)
                ScrollView(.vertical) {
                    mobileTimelineTransport(showReadouts: showReadouts, inlineReadout: inlineReadout).frame(minHeight: transportRequest)
                }.defaultScrollAnchor(.bottom).scrollBounceBehavior(.basedOnSize).frame(height: regions.transport)
            }.frame(width: geometry.size.width, height: geometry.size.height)
        }
        #else
        VStack(spacing: 0) {
            timelineHeader
            Divider().overlay(NativeEditorStyle.line)
            timelineCanvas
            timelineTransport
        }
        #endif
    }

    @ViewBuilder private var timelineProjectObservers: some View {
        timelineContent
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Composition viewer")
        .onChange(of: ObjectIdentifier(model)) { _, identity in cancelGesture(); model.viewerColorWindow?.cancel(); viewerModelID = identity }
        .onChange(of: canvasZoom) { _, _ in cancelGesture(); model.viewerColorWindow?.cancel() }
        .onChange(of: model.renderPreviewBackendID) { _, _ in cancelGesture(); model.viewerColorWindow?.cancel() }
        .onChange(of: model.processingContextID) { _, _ in cancelGesture(); model.viewerColorWindow?.cancel() }
        .onChange(of: model.folder) { _, _ in cancelInvalidGesture() }
    }

    @ViewBuilder private var timelineSelectionObservers: some View {
        timelineProjectObservers
        .onChange(of: model.scrubbing) { _, _ in cancelInvalidGesture() }
        .onChange(of: model.busy) { _, _ in cancelInvalidGesture() }
        .onChange(of: model.selectedID) { _, _ in cancelInvalidGesture() }
        .onChange(of: model.selectedIDs) { _, _ in cancelInvalidGesture() }
        .onChange(of: model.composition) { _, _ in cancelInvalidGesture() }
        .onChange(of: model.version) { _, _ in cancelInvalidGesture() }
        .onChange(of: model.time) { _, _ in cancelInvalidGesture() }
    }

    @ViewBuilder private var timelineViewer: some View {
        timelineSelectionObservers
        .onChange(of: model.panel) { _, _ in cancelInvalidGesture() }
        .onChange(of: model.playing) { _, _ in cancelInvalidGesture() }
        .onChange(of: model.showingSource) { _, _ in cancelGesture(); model.viewerColorWindow?.invalidateIfChanged() }
        .onChange(of: model.drawing) { _, _ in cancelInvalidGesture() }
        .onChange(of: model.viewerColorPicker?.id) { _, _ in cancelInvalidGesture() }
        .onDisappear { cancelGesture(); model.viewerColorWindow?.updateViewport(nil); viewerLayout = nil }
        #if os(macOS)
        .onExitCommand { model.viewerColorPicker = nil; cancelGesture(); model.viewerColorWindow?.cancel() }
        #endif

    }

}

enum NativeViewerTransformEdits {
    struct Failure: Error, LocalizedError { let message: String; var errorDescription: String? { message } }

    static func make(clip: [String: Any], pose: [String: Any], at: Double, deltaX: Double = 0, deltaY: Double = 0, magnification: Double = 1, rotationDelta: Double = 0, mode: String) throws -> [[String: Any]] {
        let id = clip.string("id"), start = clip.number("start"), end = start + clip.number("dur")
        guard !id.isEmpty, at.isFinite, start.isFinite, end.isFinite, start <= at, at < end,
              !clip.flag("locked"), deltaX.isFinite, deltaY.isFinite, magnification.isFinite, magnification > 0, rotationDelta.isFinite,
              ["move", "scale", "rotate"].contains(mode) else { throw Failure(message: "Choose a visible unlocked layer at the current playhead.") }
        var values: [String: Double] = [:]
        if mode == "move" {
            let matrix = (pose["parentMatrix"] as? [NSNumber])?.map(\.doubleValue) ?? []
            guard matrix.count == 6, matrix.allSatisfy(\.isFinite) else { throw Failure(message: "The parent transform is unavailable.") }
            let det = matrix[0] * matrix[3] - matrix[1] * matrix[2]
            guard det.isFinite, abs(det) > 1e-9 else { throw Failure(message: "The parent transform has zero scale. Change its scale before moving this layer.") }
            if abs(deltaX) + abs(deltaY) < 1e-8 { return [] }
            values["x"] = pose.number("x", .nan) + (matrix[3] * deltaX - matrix[2] * deltaY) / det
            values["y"] = pose.number("y", .nan) + (-matrix[1] * deltaX + matrix[0] * deltaY) / det
        } else if mode == "scale" {
            if abs(magnification - 1) < 1e-8 { return [] }
            values["scale"] = pose.number("scale", .nan) * magnification
            guard abs(values["scale"]!) >= 1e-6 else { throw Failure(message: "The layer scale is too close to zero.") }
        } else {
            if abs(rotationDelta) < 1e-8 { return [] }
            values["rotation"] = pose.number("rotation", .nan) + rotationDelta
        }
        guard values.values.allSatisfy({ $0.isFinite && abs($0) <= 1e8 }) else { throw Failure(message: "The transform is outside the supported range.") }
        let expressions = clip.dictionary("expr"), animation = clip.dictionary("anim")
        guard values.keys.allSatisfy({ expressions[$0] == nil }) else { throw Failure(message: "This transform uses an expression. Edit its expression or remove it before dragging.") }
        var edits: [[String: Any]] = [], fields: [String: Any] = [:]
        let local = at - start
        for prop in values.keys.sorted() {
            let value = values[prop]!
            let keys = animation[prop] as? [[Any]] ?? []
            if !keys.isEmpty {
                var op: [String: Any] = ["op": "keyframe", "id": id, "prop": prop, "at": local, "local": true, "value": value]
                if let key = keys.first(where: { ($0.first as? NSNumber).map { abs($0.doubleValue - local) <= 1e-3 } ?? false }), key.count > 2 { op["ease"] = key[2] }
                edits.append(op)
            } else { fields[prop] = value }
        }
        if !fields.isEmpty { edits.insert(["op": "update", "id": id, "set": fields], at: 0) }
        return edits
    }
}

#if os(macOS)
private struct NativeMonitorButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        MonitorButton(configuration: configuration)
    }

    private struct MonitorButton: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var enabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovered = false

        var body: some View {
            configuration.label
                .font(.system(size: 11, weight: .medium)).lineLimit(1)
                .foregroundStyle(NativeEditorStyle.text)
                .padding(.horizontal, 7).frame(minWidth: 28, minHeight: 28)
                .background(hovered ? NativeEditorStyle.panelRaised : .clear)
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .overlay { RoundedRectangle(cornerRadius: 4).stroke(hovered ? NativeEditorStyle.line : .clear) }
                .opacity(enabled ? 1 : 0.4)
                .scaleEffect(!reduceMotion && configuration.isPressed ? 0.96 : 1)
                .contentShape(Rectangle())
                .onHover { hovered = $0 }
        }
    }
}
#endif

private struct NativeSourceViewer: View {
    @ObservedObject var model: NativeEditorModel
    @FocusState private var editingMarks: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .caption) private var sourceHeaderHeight: CGFloat = 32

    var body: some View {
        GeometryReader { geometry in
            #if os(macOS)
            let layout = NativeSourceViewerLayout.macRegions(width: geometry.size.width, height: geometry.size.height, hasRange: model.sourceRange != nil)
            #else
            let layout = NativeSourceViewerLayout.regions(height: geometry.size.height, hasRange: model.sourceRange != nil, requestedHeader: Double(sourceHeaderHeight))
            #endif
            VStack(spacing: 0) {
                HStack {
                    Text(model.sourceAsset?.name ?? "Source viewer").font(.caption.weight(.semibold)).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                    if let range = model.sourceRange {
                        Text("\(range.fps.formatted()) fps").font(.caption2).foregroundStyle(NativeEditorStyle.muted)
                    }
                }.padding(.horizontal, 10).frame(height: layout.header).background(NativeEditorStyle.panel)
                ZStack {
                    Color.black
                    if let image = model.sourceImage { Image(decorative: image, scale: 1).resizable().aspectRatio(contentMode: .fit) }
                    else if model.sourceAsset?.kind == "video" { NativeSourcePlayerView(player: model.sourcePlayer) }
                    else if model.sourceAsset?.kind == "audio" { Image(systemName: "waveform").font(.system(size: 48)).foregroundStyle(.green.opacity(0.8)) }
                    else { Text("Choose a media asset to preview and mark a source range.").font(.callout).foregroundStyle(NativeEditorStyle.muted).multilineTextAlignment(.center).padding() }
                    if model.sourceLoading { ProgressView("Opening source").tint(.white).foregroundStyle(.white) }
                    if let error = model.sourceError { Text(error).font(.callout).foregroundStyle(.white).multilineTextAlignment(.center).padding().background(.black.opacity(0.8)) }
                }.frame(maxWidth: .infinity).frame(height: layout.picture).clipped()
                if let range = model.sourceRange {
                    VStack(spacing: 0) {
                    ScrollView(.vertical) {
                        VStack(spacing: 8) {
                            Slider(value: Binding(get: { model.sourceRange?.time ?? 0 }, set: { model.seekSource($0, exact: false) }), in: 0...range.duration) { editing in
                                if !editing { model.seekSource(model.sourceRange?.time ?? 0) }
                            }.accessibilityLabel("Source playhead").tint(NativeEditorStyle.accent)
                            #if os(iOS)
                            mobileSourceTransport(range)
                            #else
                            HStack(spacing: 6) {
                                Text(nativeTimecode(range.time, fps: range.fps)).font(.system(.caption, design: .monospaced)).foregroundStyle(NativeEditorStyle.text)
                                Spacer(minLength: 0)
                                Button { model.seekSource(range.time - range.frame) } label: { Image(systemName: "backward.end") }.accessibilityLabel("Previous source frame")
                                Button { model.toggleSourcePlayback() } label: { Image(systemName: model.sourcePlaying ? "pause.fill" : "play.fill") }
                                .keyboardShortcut(.space, modifiers: []).accessibilityLabel(model.sourcePlaying ? "Pause source" : "Play source")
                                .disabled(editingMarks || model.sourceLoading || model.sourceError != nil || model.sourceAsset?.kind == "image")
                                Button { model.seekSource(range.time + range.frame) } label: { Image(systemName: "forward.end") }.accessibilityLabel("Next source frame")
                                Spacer(minLength: 0)
                                Text(nativeTimecode(range.duration, fps: range.fps)).font(.system(.caption2, design: .monospaced)).foregroundStyle(NativeEditorStyle.muted)
                            }
                            #endif
                            #if os(iOS)
                            mobileSourceActions(range)
                            #else
                            macRangeControls(range)
                            #endif
                        }
                        #if os(macOS)
                        .buttonStyle(NativeMonitorButtonStyle()).padding(8)
                        #else
                        .buttonStyle(NativeToolbarButtonStyle()).padding(10)
                        #endif
                        .frame(maxWidth: .infinity)
                    }
                    #if os(iOS)
                    ScrollView(.vertical) {
                        mobileSourcePlacementActions.padding(.horizontal, 10).padding(.vertical, 6)
                    }.scrollBounceBehavior(.basedOnSize).frame(height: min(56, layout.controls * 0.5))
                    #endif
                    }.frame(height: layout.controls).background(NativeEditorStyle.panel)
                }
            }.frame(width: geometry.size.width, height: geometry.size.height)
        }.accessibilityElement(children: .contain).accessibilityLabel("Source viewer")
        .onDisappear { model.pauseSource() }
    }

    #if os(iOS)
    private func mobileSourceTransport(_ range: NativeSourceRange) -> some View {
        VStack(spacing: 2) {
            NativeViewerTimeReadouts(current: nativeTimecode(range.time, fps: range.fps),
                                   duration: nativeTimecode(range.duration, fps: range.fps), scope: "Source")
            HStack(spacing: 6) {
                Button { model.seekSource(range.time - range.frame) } label: { Image(systemName: "backward.end") }
                    .accessibilityLabel("Previous source frame")
                Button { model.toggleSourcePlayback() } label: { Image(systemName: model.sourcePlaying ? "pause.fill" : "play.fill") }
                    .keyboardShortcut(.space, modifiers: []).accessibilityLabel(model.sourcePlaying ? "Pause source" : "Play source")
                    .disabled(editingMarks || model.sourceLoading || model.sourceError != nil || model.sourceAsset?.kind == "image")
                    .accessibilityIdentifier("viewer.source.play")
                Button { model.seekSource(range.time + range.frame) } label: { Image(systemName: "forward.end") }
                    .accessibilityLabel("Next source frame")
            }.buttonStyle(NativeViewerChromeButtonStyle()).frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder private func mobileSourceActions(_ range: NativeSourceRange) -> some View {
        VStack(spacing: 8) {
            sourceMarkRow("In", value: Binding(get: { model.sourceRange?.inPoint ?? 0 }, set: { model.markSourceIn($0) })) { model.markSourceIn() }
            sourceMarkRow("Out", value: Binding(get: { model.sourceRange?.outPoint ?? 0 }, set: { model.markSourceOut($0) })) { model.markSourceOut() }
            Menu {
                Button("Clear source marks") { model.clearSourceMarks() }
                Text("Duration \(nativeTimecode(range.length, fps: range.fps))")
                Text("Drag the playhead slider to preview a frame. Mark in and Mark out set the range to add.")
            } label: { Label("Range options", systemImage: "ellipsis") }
                .buttonStyle(NativeViewerActionButtonStyle()).accessibilityLabel("Source range options")
        }
    }

    private var mobileSourcePlacementActions: some View {
        HStack(spacing: 8) {
            Button { model.placeSource("append") } label: { Label("Append to timeline", systemImage: "plus") }
                .buttonStyle(NativeViewerActionButtonStyle())
                .accessibilityLabel("Append marked source to timeline")
                .accessibilityIdentifier("viewer.source.append")
            Menu {
                ForEach(["insert", "overwrite", "connect"], id: \.self) { mode in
                    Button(mode.capitalized) { model.placeSource(mode) }
                }
            } label: { Image(systemName: "chevron.down") }
                .buttonStyle(NativeViewerChromeButtonStyle())
                .accessibilityLabel("Other source placement options")
                .accessibilityHint("Insert, overwrite or connect the marked source")
                .accessibilityIdentifier("viewer.source.placementOptions")
        }.disabled(model.sourceLoading || model.sourceError != nil || model.busy)
            .background(NativeEditorStyle.panel)
    }

    private func sourceMarkRow(_ label: String, value: Binding<Double>, mark: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Button(label == "In" ? "Mark in" : "Mark out", action: mark).keyboardShortcut(label == "In" ? "i" : "o", modifiers: [])
                .buttonStyle(.plain).font(.caption.weight(.semibold))
                .frame(minWidth: 76, minHeight: 44).contentShape(Rectangle()).disabled(editingMarks)
                .accessibilityLabel(label == "In" ? "Mark source in" : "Mark source out, exclusive")
                .accessibilityHint("Uses the current source playhead. Enter seconds in the field for an exact value.")
            TextField("Source \(label.lowercased()) seconds", value: value, format: .number.precision(.fractionLength(2)))
                .textFieldStyle(.roundedBorder).font(.body).focused($editingMarks)
                .frame(maxWidth: .infinity, minHeight: 44)
                .accessibilityLabel("Source \(label.lowercased()) seconds")
        }
    }
    #endif

    #if os(macOS)
    private func macRangeControls(_ range: NativeSourceRange) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                HStack(spacing: 6) { markControls(range) }.fixedSize(horizontal: true, vertical: false)
                Spacer(minLength: 0)
                HStack(spacing: 4) { placementControls }.fixedSize(horizontal: true, vertical: false)
            }
            VStack(spacing: 8) {
                HStack(spacing: 6) { markControls(range) }
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 4) { placementControls }
            }
        }
    }
    #endif

    private func markControls(_ range: NativeSourceRange) -> some View {
        Group {
            Button("In") { model.markSourceIn() }.keyboardShortcut("i", modifiers: []).help("Mark source in").disabled(editingMarks)
            TextField("Source in seconds", value: Binding(get: { model.sourceRange?.inPoint ?? 0 }, set: { model.markSourceIn($0) }), format: .number.precision(.fractionLength(2)))
                .frame(width: 56).textFieldStyle(.roundedBorder).font(.caption).focused($editingMarks).accessibilityLabel("Source in seconds")
            Button("Out") { model.markSourceOut() }.keyboardShortcut("o", modifiers: []).help("Mark source out, exclusive").disabled(editingMarks)
            TextField("Source out seconds", value: Binding(get: { model.sourceRange?.outPoint ?? 0 }, set: { model.markSourceOut($0) }), format: .number.precision(.fractionLength(2)))
                .frame(width: 56).textFieldStyle(.roundedBorder).font(.caption).focused($editingMarks).accessibilityLabel("Source out seconds")
            Menu { Button("Clear source marks") { model.clearSourceMarks() }; Text("Duration \(nativeTimecode(range.length, fps: range.fps))") } label: { Image(systemName: "ellipsis") }.accessibilityLabel("Source range options")
        }
    }

    private var placementControls: some View {
        ForEach(["append", "insert", "overwrite", "connect"], id: \.self) { mode in
            Button(mode.capitalized) { model.placeSource(mode) }
                .disabled(model.sourceLoading || model.sourceError != nil || model.busy)
                .help(mode == "connect" ? "Place the marked source on an upper video track at the timeline playhead" : "\(mode.capitalized) the marked source into the timeline")
        }
    }
}

#if os(iOS)
private struct NativeViewerTimeReadouts: View {
    let current: String
    let duration: String
    let scope: String
    /// Time, frame rate, duration and seek action when the playhead timecode accepts typing.
    var entry: (Double, Double, Double, (Double) -> Void)? = nil

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { currentReadout; Spacer(minLength: 8); durationReadout }
            VStack(alignment: .leading, spacing: 2) { currentReadout; durationReadout }
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private var currentReadout: some View {
        if let entry {
            NativeTimecodeField(label: "\(scope) playhead", seconds: entry.0, fps: entry.1, range: 0...max(0, entry.2),
                                stepper: false, playhead: true, commit: entry.3)
                .fixedSize(horizontal: true, vertical: false)
        } else {
            Text(current).font(.system(.caption, design: .monospaced).weight(.semibold))
                .foregroundStyle(NativeEditorStyle.text).fixedSize(horizontal: true, vertical: false)
                .accessibilityLabel("\(scope) playhead").accessibilityValue(current)
        }
    }

    private var durationReadout: some View {
        Text(duration).font(.system(.caption, design: .monospaced))
            .foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: true, vertical: false)
            .accessibilityLabel("\(scope) duration").accessibilityValue(duration)
    }
}

private struct NativeViewerChromeButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @ScaledMetric(relativeTo: .body) private var symbolSize: CGFloat = 18

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: min(symbolSize, 24), weight: .medium))
            .foregroundStyle(NativeEditorStyle.text).frame(width: 44, height: 44)
            .opacity(enabled ? 1 : 0.4)
            .background(configuration.isPressed ? NativeEditorStyle.selectionFill : .clear, in: RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
    }
}

private struct NativeViewerActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.caption.weight(.semibold)).multilineTextAlignment(.center)
            .foregroundStyle(NativeEditorStyle.text).padding(.horizontal, 8).padding(.vertical, 6)
            .frame(maxWidth: .infinity, minHeight: 44)
            .opacity(enabled ? 1 : 0.4)
            .background(configuration.isPressed ? NativeEditorStyle.selectionFill : NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
    }
}
#endif



#if os(macOS)
private final class NativeSourcePlayerHost: NSView {
    let playerLayer = AVPlayerLayer()
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect); wantsLayer = true; layer = playerLayer; playerLayer.videoGravity = .resizeAspect
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}
private struct NativeSourcePlayerView: NSViewRepresentable {
    let player: AVPlayer
    func makeNSView(context: Context) -> NativeSourcePlayerHost { NativeSourcePlayerHost(frame: .zero) }
    func updateNSView(_ view: NativeSourcePlayerHost, context: Context) { view.playerLayer.player = player }
    static func dismantleNSView(_ view: NativeSourcePlayerHost, coordinator: ()) { view.playerLayer.player = nil }
}
#else
private final class NativeSourcePlayerHost: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
private struct NativeSourcePlayerView: UIViewRepresentable {
    let player: AVPlayer
    func makeUIView(context: Context) -> NativeSourcePlayerHost { let view = NativeSourcePlayerHost(); view.playerLayer.videoGravity = .resizeAspect; return view }
    func updateUIView(_ view: NativeSourcePlayerHost, context: Context) { view.playerLayer.player = player }
    static func dismantleUIView(_ view: NativeSourcePlayerHost, coordinator: ()) { view.playerLayer.player = nil }
}
#endif
