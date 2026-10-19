import SwiftUI

struct NativeColorWindowHost: View {
    @ObservedObject var model: NativeEditorModel
    @StateObject private var controller: NativeColorWindowController
    let windowType: String
    init(model: NativeEditorModel, session: EditorSession, nodeID: String, windowType: String) {
        self.model = model; self.windowType = windowType
        _controller = StateObject(wrappedValue: NativeColorWindowController(model: model, session: session, nodeID: nodeID))
    }
    var body: some View {
        Group {
            if ["circle", "rect"].contains(windowType) { NativeColorWindowControls(controller: controller) }
            else if windowType != "none" {
                Text("Direct window editing supports circles and rectangles. Choose either shape to use the viewer handles.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .onAppear { model.viewerColorWindow?.cancel(); model.viewerColorWindow = controller }
        .onDisappear {
            controller.cancel()
            if model.viewerColorWindow === controller { model.viewerColorWindow = nil }
        }
    }
}

struct NativeColorWindowControls: View {
    @ObservedObject var controller: NativeColorWindowController
    var body: some View {
        Group {
            if let plane = controller.plane() {
                let window = controller.draftWindow ?? plane.window
                Text("Drag this node's window in the viewer. Use the corners to resize and the upper handle to rotate.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(["x", "y", "w", "h", "rotation", "softness"], id: \.self) { property in
                    NativeColorWindowNumberField(controller: controller, property: property,
                        value: property == "softness" ? window.softness : window.geometryPatch[property] as? Double ?? 0)
                }
                Toggle("Invert window", isOn: Binding(get: { window.invert }, set: { value in
                    guard let token = controller.beginNumeric(), controller.preview(token: token, patch: ["invert": value]) else { return }
                    controller.commit(token: token)
                }))
                .disabled(controller.submitting)
                if controller.draftWindow != nil { Button("Cancel window edit") { controller.cancel() } }
            } else {
                Text("Window controls require an unlocked circle or rectangle node, a supported graph, and its current rendered frame.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

private struct NativeColorWindowNumberField: View {
    @ObservedObject var controller: NativeColorWindowController
    let property: String
    let value: Double
    @State private var text = ""
    @State private var token: UUID?
    @State private var invalid = false
    @State private var initialText = ""
    @State private var dirty = false
    @FocusState private var focused: Bool

    private func beginEditing() {
        guard token == nil else { return }
        guard let capture = controller.beginNumeric() else { focused = false; return }
        initialText = String(value)
        text = initialText
        dirty = false
        invalid = false
        token = capture
    }
    private func textChanged(_ next: String) {
        guard let token else { return }
        let wasDirty = dirty
        dirty = next != initialText
        guard dirty || wasDirty else { return }
        invalid = !controller.previewNumeric(token: token, text: next, property: property)
    }
    private func finish() {
        guard let token else { return }
        self.token = nil
        if dirty, NativeColorWindowGeometry.numericPatch(text, property: property) != nil,
           controller.previewNumeric(token: token, text: text, property: property) {
            controller.commit(token: token)
        } else { controller.cancel(token: token); text = String(format: "%.4g", value) }
        dirty = false
        invalid = false
    }
    private func cancelEditing() {
        let capture = token
        token = nil
        if let capture { controller.cancel(token: capture) }
        focused = false
        text = String(format: "%.4g", value)
        dirty = false
        invalid = false
    }
    var body: some View {
        HStack {
            Text(property == "rotation" ? "Rotation" : property.capitalized).font(.caption)
            Spacer()
            TextField(property, text: $text).multilineTextAlignment(.trailing)
                .frame(width: 82).focused($focused)
                .accessibilityLabel("Window \(property)")
                .onSubmit { finish(); focused = false }
                .onChange(of: focused) { _, next in
                    if next { beginEditing() } else { finish() }
                }
                .onChange(of: text) { _, next in textChanged(next) }
                .onChange(of: value) { _, next in if !focused { text = String(format: "%.4g", next) } }
                .onAppear { text = String(format: "%.4g", value) }
                .onDisappear { cancelEditing() }
                #if os(macOS)
                .onExitCommand { cancelEditing() }
                #endif
                .disabled(controller.submitting)
            if invalid { Image(systemName: "exclamationmark.circle").foregroundStyle(.orange).accessibilityLabel("Enter a finite number in the allowed range") }
        }
    }
}

struct NativeColorWindowOverlay: View {
    @ObservedObject var controller: NativeColorWindowController
    let viewport: NativeViewerGeometry.Viewport
    @State private var token: UUID?
    @State private var attempted = false
    private var hitSize: Double {
        #if os(iOS)
        44
        #else
        28
        #endif
    }
    private func outline(_ points: [CGPoint]) -> Path {
        Path { path in
            guard let first = points.first else { return }
            path.move(to: first); for point in points.dropFirst() { path.addLine(to: point) }; path.closeSubpath()
        }
    }
    var body: some View {
        let viewport = controller.geometryViewport(self.viewport)
        ZStack {
            if let plane = controller.plane() {
                let window = controller.draftWindow ?? plane.window
                let crop = [CGPoint(x: plane.crop.minX, y: plane.crop.minY), CGPoint(x: plane.crop.maxX, y: plane.crop.minY), CGPoint(x: plane.crop.maxX, y: plane.crop.maxY), CGPoint(x: plane.crop.minX, y: plane.crop.maxY)].map { viewport.screen(plane.project($0)) }
                outline(plane.points(window: window).map { viewport.screen(plane.project($0)) })
                    .stroke(.white, style: StrokeStyle(lineWidth: 1.5, dash: [5, 3])).clipShape(outline(crop))
                let handles = plane.handles(window: window, viewport: viewport)
                ForEach(handles.indices, id: \.self) { index in
                    let point = handles[index]
                    if viewport.normalized(point) != nil && plane.visibleUV(plane.uv(viewport.project(point))) {
                        Circle().fill(.white).frame(width: index == 4 ? 10 : 8, height: index == 4 ? 10 : 8)
                            .overlay(Circle().stroke(.black, lineWidth: 1)).position(point)
                            .accessibilityLabel(index == 4 ? "Rotate node window" : "Resize node window")
                    }
                }
                Color.clear.contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named("nativeViewerViewport"))
                        .onChanged { value in
                            if !attempted { attempted = true; token = controller.beginPointer(point: value.startLocation, viewport: viewport, hitSize: hitSize) }
                            if let token, !controller.previewPointer(token: token, point: value.location, viewport: viewport) { self.token = nil }
                        }
                        .onEnded { value in
                            if let token, controller.previewPointer(token: token, point: value.location, viewport: viewport) { controller.commit(token: token, viewport: viewport) }
                            token = nil; attempted = false
                        })
            }
        }
        .frame(width: viewport.size.width, height: viewport.size.height)
        .onAppear { controller.updateViewport(viewport) }
        .onChange(of: self.viewport.layout) { _, _ in controller.updateViewport(self.viewport); token = nil; attempted = false }
        .onDisappear { controller.updateViewport(nil); token = nil }
        #if os(macOS)
        .onExitCommand { controller.cancel(); token = nil; attempted = false }
        #endif
    }
}
