import SwiftUI

enum NativeCanvasCoordinates {
    static func canvas(_ point: CGPoint, size: CGSize, width: Double, height: Double) -> CGPoint? {
        guard width.isFinite, height.isFinite, width > 0, height > 0, size.width.isFinite, size.height.isFinite,
              size.width > 0, size.height > 0, point.x.isFinite, point.y.isFinite else { return nil }
        let scale = min(size.width / width, size.height / height)
        let origin = CGPoint(x: (size.width - width * scale) / 2, y: (size.height - height * scale) / 2)
        return CGPoint(x: (point.x - origin.x) / scale, y: (point.y - origin.y) / scale)
    }
}

enum NativeDrawingMode: String, CaseIterable, Identifiable {
    case maskRectangle, maskPath, shapePath, trackingBox
    var id: String { rawValue }
    var name: String {
        switch self {
        case .maskRectangle: return "Draw rectangle mask"
        case .maskPath: return "Draw path mask"
        case .shapePath: return "Draw shape path"
        case .trackingBox: return "Draw tracking box"
        }
    }
}

struct NativeDrawingOverlay: View {
    @ObservedObject var model: NativeEditorModel
    let mode: NativeDrawingMode
    @State private var points: [CGPoint] = []
    @State private var source: DrawingSource?
    @State private var attempted = false
    private struct DrawingSource {
        let folder: URL?
        let composition: String?
        let version: Int
        let clip: NativeClip?
        let size: CGSize
        let width: Double
        let height: Double
        let time: Double
        let snapshot: NativeLibraryCapture
        let tracking: NativeInspectorWorkflow.Capture?
    }

    var body: some View {
        let renderedVersion = model.version
        GeometryReader { geometry in
            Canvas { context, _ in
                guard let first = points.first else { return }
                var path = Path()
                if mode == .maskRectangle || mode == .trackingBox, let last = points.last {
                    path.addRect(CGRect(x: min(first.x, last.x), y: min(first.y, last.y), width: abs(last.x - first.x), height: abs(last.y - first.y)))
                } else {
                    path.move(to: first)
                    for point in points.dropFirst() { path.addLine(to: point) }
                    path.closeSubpath()
                }
                context.fill(path, with: .color(.cyan.opacity(0.15)))
                context.stroke(path, with: .color(.cyan), lineWidth: 2)
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                if !attempted {
                    attempted = true
                    if renderedVersion == model.version, let project = model.project {
                        let capture = NativeLibraryCapture(project: project.fields, selected: model.selected?.fields, composition: model.composition, folder: model.folder?.path, version: model.version)
                        let tracking = mode == .trackingBox ? model.selectedID.flatMap { try? NativeInspectorWorkflow.Capture(model: model, id: $0) } : nil
                        source = DrawingSource(folder: model.folder, composition: model.composition, version: model.version, clip: model.selected, size: geometry.size, width: model.width, height: model.height, time: model.time, snapshot: capture, tracking: tracking)
                    }
                }
                guard source != nil else { return }
                if points.isEmpty { points = [value.startLocation] }
                if mode == .maskRectangle || mode == .trackingBox { points = [points[0], value.location] }
                else if let last = points.last, hypot(value.location.x - last.x, value.location.y - last.y) >= 2, points.count < 512 { points.append(value.location) }
            }.onEnded { value in
                if points.isEmpty { points = [value.startLocation] }
                points.append(value.location)
                apply(size: geometry.size)
                points = []; source = nil; attempted = false; model.drawing = nil
            })
        }
        .accessibilityLabel("\(mode.name). Draw with your finger or Apple Pencil.")
    }

    private func apply(size: CGSize) {
        guard let source, source.folder == model.folder, source.composition == model.composition,
              source.version == model.version, source.clip?.id == model.selectedID, source.size == size,
              let project = model.project,
              source.snapshot.matches(project: project.fields, folder: model.folder?.path, version: model.version),
              source.snapshot.matchesSelection(selected: model.selected?.fields, composition: model.composition) else {
            model.status = "The project or viewer changed during drawing. Try again."; return
        }
        guard points.count >= 2 else { return }
        let canvas = points.compactMap { NativeCanvasCoordinates.canvas($0, size: source.size, width: source.width, height: source.height) }
        guard canvas.count == points.count else { return }
        if mode == .shapePath {
            let x = canvas.map(\.x).reduce(0, +) / Double(canvas.count), y = canvas.map(\.y).reduce(0, +) / Double(canvas.count)
            let vertices = canvas.map { [$0.x - x, $0.y - y] }
            guard let track = model.tracks.last(where: { $0.kind == "video" && !$0.locked }) else { return }
            model.edit(["op": "add_shape", "track": track.id, "start": source.time, "dur": 5, "shape": ["type": "path", "path": ["closed": true, "vertices": vertices], "fill": ["color": "#ffffff00"], "stroke": ["color": "#ffffff", "width": 4]], "set": ["x": x, "y": y]], expectedVersion: source.version)
            return
        }
        guard let clip = source.clip else { return }
        let angle = -clip.fields.number("rotation") * .pi / 180, scaleX = max(0.001, clip.fields.number("scale", 1) * clip.fields.number("scaleX", 1)), scaleY = max(0.001, clip.fields.number("scale", 1) * clip.fields.number("scaleY", 1))
        let local = canvas.map { point -> CGPoint in
            let dx = point.x - clip.fields.number("x", model.width / 2), dy = point.y - clip.fields.number("y", model.height / 2)
            return CGPoint(x: (dx * cos(angle) - dy * sin(angle)) / scaleX, y: (dx * sin(angle) + dy * cos(angle)) / scaleY)
        }
        if mode == .maskPath {
            model.edit(["op": "add_mask", "id": clip.id, "mask": ["type": "path", "path": ["closed": true, "vertices": local.map { [$0.x, $0.y] }], "feather": 2]], expectedVersion: source.version)
        } else {
            let minX = local.map(\.x).min() ?? 0, maxX = local.map(\.x).max() ?? 0, minY = local.map(\.y).min() ?? 0, maxY = local.map(\.y).max() ?? 0
            guard maxX - minX > 1, maxY - minY > 1 else { return }
            if mode == .maskRectangle {
                model.edit(["op": "add_mask", "id": clip.id, "mask": ["type": "rect", "x": (minX + maxX) / 2, "y": (minY + maxY) / 2, "w": maxX - minX, "h": maxY - minY, "feather": 2]], expectedVersion: source.version)
            } else {
                guard let capture = source.tracking, capture.matches(model) else {
                    model.status = "Select an unchanged video source before drawing a tracking region."; return
                }
                let width = capture.asset.number("width"), height = capture.asset.number("height")
                guard width.isFinite, height.isFinite, width > 0, height > 0 else {
                    model.status = "Reimport this source to measure its dimensions before tracking."; return
                }
                let mediaFit = min(source.width / width, source.height / height)
                let left = min(1, max(0, 0.5 + minX / (mediaFit * width))), top = min(1, max(0, 0.5 + minY / (mediaFit * height)))
                let right = min(1, max(0, 0.5 + maxX / (mediaFit * width))), bottom = min(1, max(0, 0.5 + maxY / (mediaFit * height)))
                guard right > left, bottom > top else { model.status = "Draw a region inside the source frame."; return }
                let rect = ["x": left, "y": top, "width": right - left, "height": bottom - top]
                let request: [String: Any]
                do { request = try NativeTrackingRequest.make(capture: capture, rect: rect, available: model.hasCapability("analysis", "tracking")) }
                catch { model.status = error.localizedDescription; return }
                model.perform {
                    guard capture.matches(model) else { throw NativeInspectorWorkflow.Failure("The project, selection or source changed before tracking started. Try again.") }
                    model.status = "Tracking selected region"
                    let result = try await model.call("/api/analysis/track", request)
                    guard source.folder == model.folder, source.composition == model.composition, clip.id == model.selectedID else { return }
                    model.status = result.string("id").isEmpty ? NativeProcessingSummary(result) : "Tracking queued. Inspect its progress and results in clip analysis."
                }
            }
        }
    }
}

enum NativeTrackingRequest {
    static func make(capture: NativeInspectorWorkflow.Capture, rect: [String: Double], available: Bool) throws -> [String: Any] {
        guard available else { throw NativeInspectorWorkflow.Failure("Subject tracking is unavailable on this host.") }
        guard capture.linear, capture.unlocked, capture.clip.string("kind") == "video" else {
            throw NativeInspectorWorkflow.Failure("Tracking requires an unlocked forward video clip with a constant positive speed.")
        }
        let fps = min(120, capture.fps), length = capture.duration * capture.speed
        guard length.isFinite, length > 0, length <= 14_400, length * fps <= 20_000,
              let x = rect["x"], let y = rect["y"], let width = rect["width"], let height = rect["height"],
              [x, y, width, height].allSatisfy(\.isFinite), x >= 0, y >= 0, width > 0, height > 0,
              x + width <= 1.000001, y + height <= 1.000001 else {
            throw NativeInspectorWorkflow.Failure("Choose a region inside the source and a tracking range of at most 20,000 samples.")
        }
        return ["src": capture.source, "id": capture.id, "comp": capture.composition as Any? ?? NSNull(),
                "in": capture.input, "dur": length, "fps": fps, "rect": rect, "apply": true, "wait": false,
                "expectedVersion": capture.version, "uiCapture": capture.record]
    }
}
