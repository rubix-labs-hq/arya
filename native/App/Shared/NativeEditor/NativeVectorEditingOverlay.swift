import SwiftUI
import ReelKit

enum NativeVectorEditPlan {
    struct Failure: Error, LocalizedError { let message: String; var errorDescription: String? { message } }
    enum Target: Equatable { case anchor, vertex(Int), incoming(Int), outgoing(Int) }
    static let transformProperties = ["x", "y", "scale", "scaleX", "scaleY", "rotation", "anchorX", "anchorY"]

    static func validate(clip: [String: Any], tracks: [NativeTrack], anchor: Bool) throws {
        guard !clip.flag("locked"), clip.string("kind") != "audio", clip.string("kind") != "null" else { throw Failure(message: "Choose an unlocked visible layer.") }
        if clip.string("kind") == "title", clip.dictionary("title").string("anim", "none") != "none" { throw Failure(message: "Turn off the title animator before editing its anchor.") }
        var current = clip, seen = Set<String>()
        while true {
            guard seen.insert(current.string("id")).inserted, seen.count <= 32 else { throw Failure(message: "The parent chain cannot be edited.") }
            let expressions = current.dictionary("expr")
            guard transformProperties.allSatisfy({ expressions[$0] == nil }) else { throw Failure(message: "Remove transform expressions before editing points.") }
            if anchor, current.string("id") == clip.string("id") {
                guard transformProperties.allSatisfy({ current.dictionary("anim")[$0] == nil }) else { throw Failure(message: "Anchor compensation requires a layer without transform keyframes.") }
            }
            let parent = current.string("parent")
            if parent.isEmpty { break }
            let matches = tracks.flatMap(\.clips).filter { $0.id == parent }
            guard matches.count == 1 else { throw Failure(message: "The evaluated parent is unavailable.") }
            current = matches[0].fields
        }
        if !anchor {
            guard clip.dictionary("nodes").isEmpty, !clip.objects("effects").contains(where: { $0.string("type") == "mirror" && $0["enabled"] as? Bool != false }) else {
                throw Failure(message: "Turn off the node graph and mirror effect before editing vector points.")
            }
            guard clip.string("kind") == "shape", clip.dictionary("shape").string("type") == "path",
                  !Array(clip.dictionary("anim").keys).contains(where: { $0.hasPrefix("shape.") }),
                  !Array(clip.dictionary("expr").keys).contains(where: { $0.hasPrefix("shape.") }) else { throw Failure(message: "Select a vector path without shape keyframes or expressions.") }
            _ = try path(clip)
        }
    }

    static func path(_ clip: [String: Any]) throws -> [String: Any] {
        let path = clip.dictionary("shape").dictionary("path")
        guard let vertices = path["vertices"] as? [[Double]], vertices.count >= 2, vertices.count <= 512,
              vertices.allSatisfy(validPoint), path["closed"] == nil || path["closed"] is Bool,
              Set(path.keys).isSubset(of: ["vertices", "in", "out", "closed"]) else { throw Failure(message: "The path needs two to 512 finite vertices.") }
        for key in ["in", "out"] {
            if let raw = path[key] {
                guard let tangents = raw as? [[Double]], tangents.count <= vertices.count, tangents.allSatisfy(validPoint) else { throw Failure(message: "The path has invalid tangent vectors.") }
            }
        }
        return path
    }

    static func validPoint(_ point: [Double]) -> Bool { point.count == 2 && point.allSatisfy { $0.isFinite && abs($0) <= 1e6 } }
    static func samePoint(_ a: [Double], _ b: [Double]) -> Bool { abs(a[0] - b[0]) + abs(a[1] - b[1]) < 1e-8 }

    static func operations(clip: [String: Any], layer: NativeViewerGeometry.Layer, target: Target, local: CGPoint) throws -> [[String: Any]] {
        let localX = Double(local.x), localY = Double(local.y)
        guard validPoint([localX, localY]), clip.string("id") == layer.id else { throw Failure(message: "The edited point is outside the supported range.") }
        if target == .anchor {
            let pose = layer.pose, dx = localX - pose.number("anchorX"), dy = localY - pose.number("anchorY")
            if abs(dx) + abs(dy) < 1e-8 { return [] }
            let r = pose.number("rotation", .nan) * .pi / 180, sx = pose.number("scale", .nan) * pose.number("scaleX", 1), sy = pose.number("scale", .nan) * pose.number("scaleY", 1)
            guard [r, sx, sy].allSatisfy(\.isFinite), abs(sx * sy) > 1e-9 else { throw Failure(message: "The evaluated transform is unavailable.") }
            let x = pose.number("x", .nan) + cos(r) * sx * dx - sin(r) * sy * dy
            let y = pose.number("y", .nan) + sin(r) * sx * dx + cos(r) * sy * dy
            guard validPoint([x, y]) else { throw Failure(message: "The compensated position is outside the supported range.") }
            return [["op": "update", "id": layer.id, "set": ["anchorX": localX, "anchorY": localY, "x": x, "y": y]]]
        }
        var path = try path(clip)
        var vertices = path["vertices"] as! [[Double]], key: String, index: Int
        switch target {
        case .vertex(let i): key = "vertices"; index = i
        case .incoming(let i): key = "in"; index = i
        case .outgoing(let i): key = "out"; index = i
        case .anchor: return []
        }
        guard vertices.indices.contains(index) else { throw Failure(message: "Select an existing path point.") }
        if key == "vertices" {
            if samePoint([localX, localY], vertices[index]) { return [] }
            vertices[index] = [localX, localY]; path[key] = vertices
        }
        else {
            var tangents = path[key] as? [[Double]] ?? []
            let next = [localX - vertices[index][0], localY - vertices[index][1]]
            if samePoint(next, index < tangents.count ? tangents[index] : [0, 0]) { return [] }
            while tangents.count < vertices.count { tangents.append([0, 0]) }
            tangents[index] = next
            guard validPoint(tangents[index]) else { throw Failure(message: "The tangent is outside the supported range.") }
            path[key] = tangents
        }
        if NSDictionary(dictionary: path).isEqual(to: clip.dictionary("shape").dictionary("path")) { return [] }
        return [["op": "update", "id": layer.id, "set": ["shape": ["path": path]]]]
    }
}

struct NativeVectorEditingOverlay: View {
    @ObservedObject var model: NativeEditorModel
    let mode: String
    let viewport: NativeViewerGeometry.Viewport
    let onDone: () -> Void
    @State private var source: Source?
    @State private var queued: Source?
    @State private var operations: [[String: Any]] = []
    @State private var attempted = false
    @State private var selectedPoint = 0
    @State private var layout: NativeViewerGeometry.Layout?
    @State private var currentModelID: ObjectIdentifier?

    private struct Source {
        let modelID: ObjectIdentifier
        let backendID: ObjectIdentifier
        let panel: NativePanel
        let clip: NativeClip
        let track: NativeTrack
        let layer: NativeViewerGeometry.Layer
        let viewport: NativeViewerGeometry.Viewport
        let capture: NativeRenderPreviewCapture
        let target: NativeVectorEditPlan.Target
        let point: Int
        let mode: String
    }

    private func layer() -> NativeViewerGeometry.Layer? {
        guard model.selectedIDs.count == 1, model.viewerGeometryIsCurrent(capture: source?.capture), let frame = model.metalFrame,
              let records = try? JSON.parse(frame.drawGeometry.text) as? [[String: Any]] else { return nil }
        return NativeViewerGeometry.layers(records).first { $0.id == model.selectedID }
    }
    private func matches(_ source: Source, completed: Bool = false) -> Bool {
        guard currentModelID == source.modelID, ObjectIdentifier(model) == source.modelID, model.renderPreviewBackendID == source.backendID,
              layout == source.viewport.layout, model.width == source.viewport.canvas.width, model.height == source.viewport.canvas.height,
              mode == source.mode, selectedPoint == source.point, model.panel == source.panel, model.drawing == nil, model.viewerColorPicker == nil,
              model.selectedID == source.clip.id, let selected = model.selected,
              model.tracks.flatMap(\.clips).filter({ $0.id == source.clip.id }).count == 1,
              model.tracks.filter({ $0.id == source.track.id }).count == 1,
              let track = model.tracks.first(where: { $0.id == source.track.id }), !track.locked, !selected.fields.flag("locked"),
              NSDictionary(dictionary: selected.fields).isEqual(to: source.clip.fields), NSDictionary(dictionary: track.fields).isEqual(to: source.track.fields) else { return false }
        return completed ? model.renderPreviewCommitMatches(source.capture) : model.viewerGeometryIsCurrent(capture: source.capture)
    }
    private func begin(_ target: NativeVectorEditPlan.Target, layer: NativeViewerGeometry.Layer) -> Source? {
        guard source == nil, queued == nil, layout == viewport.layout, currentModelID == ObjectIdentifier(model), model.viewerGeometryIsCurrent(),
              model.drawing == nil, model.viewerColorPicker == nil, model.selectedIDs.count == 1,
              let backendID = model.renderPreviewBackendID, let clip = model.selected, clip.id == layer.id,
              let track = model.tracks.first(where: { $0.clips.contains { $0.id == clip.id } }), !track.locked else { return nil }
        do { try NativeVectorEditPlan.validate(clip: clip.fields, tracks: model.tracks, anchor: mode == "anchor") }
        catch { model.status = error.localizedDescription; return nil }
        guard let capture = model.beginRenderPreview(renderedVersion: model.version) else { return nil }
        return Source(modelID: ObjectIdentifier(model), backendID: backendID, panel: model.panel, clip: clip, track: track, layer: layer,
                      viewport: viewport, capture: capture, target: target, point: selectedPoint, mode: mode)
    }
    private func edit(_ source: Source, screen: CGPoint) throws -> [[String: Any]] {
        guard matches(source), source.viewport.layout == viewport.layout, screen.x.isFinite, screen.y.isFinite else { throw NativeVectorEditPlan.Failure(message: "The project or viewer changed. Try again.") }
        let local = NativeViewerGeometry.apply(source.layer.inverse, source.viewport.project(screen))
        return try NativeVectorEditPlan.operations(clip: source.clip.fields, layer: source.layer, target: source.target, local: local)
    }
    private func finish(_ source: Source, operations: [[String: Any]]) {
        guard queued == nil, matches(source), source.viewport.layout == viewport.layout else { cancel(); model.status = "The project or viewer changed. Try again."; return }
        model.discardRenderPreview(source.capture); self.source = nil; self.operations = []
        guard !operations.isEmpty else { return }
        queued = source
        let scoped = operations.map { operation -> [String: Any] in var operation = operation; operation["comp"] = source.capture.composition as Any? ?? NSNull(); return operation }
        let body: [String: Any] = ["ops": scoped, "expectedVersion": source.capture.version, "who": "you", "returnProject": true,
                                   "summary": source.mode == "anchor" ? "Move anchor without moving layer" : "Edit vector path"]
        model.perform { [self] in
            guard queued?.capture.id == source.capture.id else { return }
            queued = nil
            guard matches(source, completed: true) else { model.status = "The project or viewer changed before the point edit was applied. Try again."; return }
            _ = try await model.call("/api/ops", body)
        }
    }
    private func cancel(resetAttempt: Bool = true) {
        if let source { model.discardRenderPreview(source.capture) }
        source = nil; queued = nil; operations = []; if resetAttempt { attempted = false }
    }
    private func cancelInvalid() {
        if let source, !matches(source) { cancel(resetAttempt: false) }
        if let queued, !matches(queued, completed: true) { cancel(resetAttempt: false) }
    }
    private func updateLayout(_ next: NativeViewerGeometry.Layout) {
        if layout != next { cancel(resetAttempt: false); layout = next }
    }
    private func shownClip() -> [String: Any] {
        guard let source, let path = operations.first?.dictionary("set").dictionary("shape")["path"] as? [String: Any] else { return model.selected?.fields ?? [:] }
        var clip = source.clip.fields, shape = clip.dictionary("shape"); shape["path"] = path; clip["shape"] = shape; return clip
    }
    private func controls(layer: NativeViewerGeometry.Layer) -> [(NativeVectorEditPlan.Target, CGPoint)] {
        if mode == "anchor" {
            let set = operations.first?.dictionary("set") ?? [:]
            let point = CGPoint(x: set.number("anchorX", layer.pose.number("anchorX")), y: set.number("anchorY", layer.pose.number("anchorY")))
            return [(.anchor, viewport.screen(NativeViewerGeometry.apply(layer.matrix, point)))]
        }
        guard let path = try? NativeVectorEditPlan.path(shownClip()), let vertices = path["vertices"] as? [[Double]] else { return [] }
        var result: [(NativeVectorEditPlan.Target, CGPoint)] = []
        for (i, vertex) in vertices.enumerated() {
            let local = CGPoint(x: vertex[0], y: vertex[1])
            if layer.localRect.contains(local) { result.append((.vertex(i), viewport.screen(NativeViewerGeometry.apply(layer.matrix, local)))) }
            if i == selectedPoint {
                for key in ["in", "out"] {
                    let vectors = path[key] as? [[Double]] ?? []
                    if i < vectors.count, hypot(vectors[i][0], vectors[i][1]) > 1e-5 {
                        let tangent = CGPoint(x: vertex[0] + vectors[i][0], y: vertex[1] + vectors[i][1])
                        if layer.localRect.contains(tangent) { result.append((key == "in" ? .incoming(i) : .outgoing(i), viewport.screen(NativeViewerGeometry.apply(layer.matrix, tangent)))) }
                    }
                }
            }
        }
        return result.filter { viewport.visible($0.1) }
    }
    private func target(_ point: CGPoint, layer: NativeViewerGeometry.Layer) -> NativeVectorEditPlan.Target? {
        controls(layer: layer).reversed().filter { hypot($0.1.x - point.x, $0.1.y - point.y) <= 22 }.min { hypot($0.1.x - point.x, $0.1.y - point.y) < hypot($1.1.x - point.x, $1.1.y - point.y) }?.0
    }
    private func select(_ target: NativeVectorEditPlan.Target) {
        switch target { case .anchor: break; case .vertex(let i), .incoming(let i), .outgoing(let i): selectedPoint = i }
    }
    private func discrete(_ target: NativeVectorEditPlan.Target, layer: NativeViewerGeometry.Layer, delta: CGPoint) {
        guard let source = begin(target, layer: layer) else { return }
        do {
            let local: CGPoint
            if target == .anchor { local = CGPoint(x: layer.pose.number("anchorX") + delta.x, y: layer.pose.number("anchorY") + delta.y) }
            else {
                let path = try NativeVectorEditPlan.path(source.clip.fields), vertices = path["vertices"] as! [[Double]]
                guard vertices.indices.contains(selectedPoint) else { throw NativeVectorEditPlan.Failure(message: "Select an existing path point.") }
                let vertex = vertices[selectedPoint]
                local = CGPoint(x: vertex[0] + delta.x, y: vertex[1] + delta.y)
            }
            finish(source, operations: try NativeVectorEditPlan.operations(clip: source.clip.fields, layer: layer, target: target, local: local))
        } catch { model.discardRenderPreview(source.capture); model.status = error.localizedDescription }
    }

    private func pointerChanged(start: CGPoint, location: CGPoint) {
        if !attempted {
            attempted = true
            if let layer = layer() ?? source?.layer, let target = target(start, layer: layer) {
                select(target); source = begin(target, layer: layer)
            }
        }
        guard let source else { return }
        do { operations = try edit(source, screen: location); if !model.preview(operations, capture: source.capture) { cancel(resetAttempt: false) } }
        catch { cancel(resetAttempt: false); model.status = error.localizedDescription }
    }
    private func pointerEnded(location: CGPoint) {
        defer { attempted = false }
        guard let source else { return }
        do { finish(source, operations: try edit(source, screen: location)) }
        catch { cancel(resetAttempt: false); model.status = error.localizedDescription }
    }

    private func overlayCanvas(layer: NativeViewerGeometry.Layer?) -> some View {
        Canvas { context, _ in
            guard let layer else { return }
            if mode == "path", let path = try? NativeVectorEditPlan.path(shownClip()), let vertices = path["vertices"] as? [[Double]] {
                func screen(_ point: [Double]) -> CGPoint { viewport.screen(NativeViewerGeometry.apply(layer.matrix, CGPoint(x: point[0], y: point[1]))) }
                let incoming = path["in"] as? [[Double]] ?? [], outgoing = path["out"] as? [[Double]] ?? []
                func tangent(_ vectors: [[Double]], _ i: Int) -> [Double] { i < vectors.count ? vectors[i] : [0, 0] }
                var outline = Path(); outline.move(to: screen(vertices[0]))
                let count = path["closed"] as? Bool != false && vertices.count > 2 ? vertices.count : vertices.count - 1
                for i in 0..<count {
                    let next = (i + 1) % vertices.count, a = vertices[i], b = vertices[next], o = tangent(outgoing, i), n = tangent(incoming, next)
                    outline.addCurve(to: screen(b), control1: screen([a[0] + o[0], a[1] + o[1]]), control2: screen([b[0] + n[0], b[1] + n[1]]))
                }
                if count == vertices.count { outline.closeSubpath() }
                context.stroke(outline, with: .color(NativeEditorStyle.accent.opacity(0.75)), lineWidth: 1)
                if vertices.indices.contains(selectedPoint) {
                    for vectors in [incoming, outgoing] where selectedPoint < vectors.count {
                        let v = vertices[selectedPoint], d = vectors[selectedPoint]
                        var stem = Path(); stem.move(to: screen(v)); stem.addLine(to: screen([v[0] + d[0], v[1] + d[1]]))
                        context.stroke(stem, with: .color(.white.opacity(0.6)), lineWidth: 1)
                    }
                }
            }
            for (target, point) in controls(layer: layer) {
                let rect = CGRect(x: point.x - 5, y: point.y - 5, width: 10, height: 10)
                context.fill(target == .anchor ? Path(ellipseIn: rect) : Path(rect), with: .color(NativeEditorStyle.accent))
            }
        }.allowsHitTesting(false).accessibilityHidden(true)
    }

    private var pointerInput: some View {
        Color.clear.contentShape(Rectangle()).gesture(DragGesture(minimumDistance: 0)
            .onChanged { pointerChanged(start: $0.startLocation, location: $0.location) }
            .onEnded { pointerEnded(location: $0.location) }).accessibilityLabel(mode == "anchor" ? "Layer anchor editor" : "Vector path point editor")
    }

    private func overlayToolbar(layer: NativeViewerGeometry.Layer?) -> some View {
        VStack {
            HStack {
                Text(mode == "anchor" ? "Anchor" : "Vector path").font(.caption.weight(.semibold))
                if mode == "path", let path = try? NativeVectorEditPlan.path(shownClip()), let vertices = path["vertices"] as? [[Double]] {
                    Picker("Path point", selection: $selectedPoint) { ForEach(vertices.indices, id: \.self) { Text("Point \($0 + 1)").tag($0) } }.frame(width: 110)
                }
                if let layer {
                    Menu("Point controls") {
                        let target: NativeVectorEditPlan.Target = mode == "anchor" ? .anchor : .vertex(selectedPoint)
                        Button("Move left one layer pixel") { discrete(target, layer: layer, delta: CGPoint(x: -1, y: 0)) }
                        Button("Move right one layer pixel") { discrete(target, layer: layer, delta: CGPoint(x: 1, y: 0)) }
                        Button("Move up one layer pixel") { discrete(target, layer: layer, delta: CGPoint(x: 0, y: -1)) }
                        Button("Move down one layer pixel") { discrete(target, layer: layer, delta: CGPoint(x: 0, y: 1)) }
                        if mode == "path" {
                            Button("Set incoming handle twenty pixels left") { discrete(.incoming(selectedPoint), layer: layer, delta: CGPoint(x: -20, y: 0)) }
                            Button("Set outgoing handle twenty pixels right") { discrete(.outgoing(selectedPoint), layer: layer, delta: CGPoint(x: 20, y: 0)) }
                            Button("Collapse incoming handle") { discrete(.incoming(selectedPoint), layer: layer, delta: .zero) }
                            Button("Collapse outgoing handle") { discrete(.outgoing(selectedPoint), layer: layer, delta: .zero) }
                        }
                    }
                }
                Spacer()
                Button("Done") { cancel(); onDone() }
            }.padding(8).background(NativeEditorStyle.panel.opacity(0.9))
            Spacer()
        }.disabled(source != nil || queued != nil)
    }

    private var overlayContent: some View {
        let layer = layer() ?? source?.layer
        return ZStack {
            overlayCanvas(layer: layer)
            pointerInput
            overlayToolbar(layer: layer)
        }.frame(width: viewport.size.width, height: viewport.size.height).clipped()
    }

    private var identityObservers: some View {
        overlayContent
        .onAppear { currentModelID = ObjectIdentifier(model); updateLayout(viewport.layout) }
        .onChange(of: viewport.layout) { _, next in updateLayout(next) }
        .onChange(of: ObjectIdentifier(model)) { _, next in cancel(resetAttempt: false); currentModelID = next }
        .onChange(of: model.renderPreviewBackendID) { _, _ in cancel(resetAttempt: false) }
        .onChange(of: model.processingContextID) { _, _ in cancel(resetAttempt: false) }
    }

    private var selectionObservers: some View {
        identityObservers
        .onChange(of: model.selectedID) { _, _ in cancelInvalid() }
        .onChange(of: model.selectedIDs) { _, _ in cancelInvalid() }
        .onChange(of: model.folder) { _, _ in cancelInvalid() }
        .onChange(of: model.version) { _, _ in cancelInvalid() }
        .onChange(of: model.composition) { _, _ in cancelInvalid() }
        .onChange(of: model.time) { _, _ in cancelInvalid() }
    }

    var body: some View {
        selectionObservers
        .onChange(of: model.panel) { _, _ in cancelInvalid() }
        .onChange(of: model.playing) { _, _ in cancelInvalid() }
        .onChange(of: model.scrubbing) { _, _ in cancelInvalid() }
        .onChange(of: model.busy) { _, _ in cancelInvalid() }
        .onChange(of: model.drawing) { _, _ in cancelInvalid() }
        .onChange(of: model.viewerColorPicker?.id) { _, _ in cancelInvalid() }
        .onChange(of: selectedPoint) { _, _ in cancelInvalid() }
        .onDisappear { cancel() }
        #if os(macOS)
        .onExitCommand { cancel(); onDone() }
        #endif
    }
}
