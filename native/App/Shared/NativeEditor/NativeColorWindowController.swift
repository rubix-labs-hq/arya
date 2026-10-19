import SwiftUI
import ReelKit

@MainActor final class NativeColorWindowController: ObservableObject {
    weak var model: NativeEditorModel?
    weak var session: EditorSession?
    let nodeID: String
    let clipID: String
    @Published private(set) var draftWindow: NativeColorWindowGeometry.Window?
    @Published private(set) var submitting = false
    var previewWidth: Int? {
        guard let active, matches(active) else { return nil }
        return active.renderPixelWidth
    }
    private var active: Capture?
    private var currentViewport: NativeViewerGeometry.Viewport?
    private var queued: Capture?
    private var inFlight = false

    private struct Capture {
        let renderPixelWidth: Int
        let modelID: ObjectIdentifier
        let backendID: ObjectIdentifier
        let sessionID: String
        let workflow: NativeColorWorkflowCapture
        let render: NativeRenderPreviewCapture
        let plane: NativeColorWindowGeometry.Plane
        let clip: NativeClip
        let track: NativeTrack
        let viewport: NativeViewerGeometry.Viewport?
        let drag: NativeColorWindowGeometry.Drag?
        var patch: [String: Any] = [:]
        var previousRotation: Double
    }

    init(model: NativeEditorModel, session: EditorSession, nodeID: String) {
        self.model = model; self.session = session; self.nodeID = nodeID; self.clipID = model.selectedID ?? ""
    }

    private func target(allowSubmitting: Bool = false) -> (NativeClip, NativeTrack, [String: Any])? {
        guard let model, model.panel == .color, model.viewerColorWindow === self,
              model.selectedIDs.count == 1, let clip = model.selected, model.selectedID == clip.id, clip.id == clipID,
              clip.kind != "adjustment", !clip.fields.flag("locked"), !model.showingSource,
              model.drawing == nil, model.viewerColorPicker == nil, allowSubmitting || !submitting,
              model.tracks.flatMap(\.clips).filter({ $0.id == clip.id }).count == 1,
              let track = model.tracks.first(where: { $0.clips.contains(where: { $0.id == clip.id }) }), !track.locked,
              model.tracks.filter({ $0.id == track.id }).count == 1,
              clip.nodes.filter({ $0.string("id") == nodeID }).count == 1,
              let node = clip.nodes.first(where: { $0.string("id") == nodeID }),
              ["source", "primary", "corrector"].contains(node.string("type")), node["enabled"] as? Bool != false else { return nil }
        let prefix = "node.\(nodeID).window."
        guard !clip.fields.dictionary("expr").keys.contains(where: { $0.hasPrefix(prefix) }),
              !clip.fields.dictionary("anim").keys.contains(where: { $0.hasPrefix(prefix) }) else { return nil }
        return (clip, track, node)
    }

    func plane() -> NativeColorWindowGeometry.Plane? {
        if let active { return matches(active) ? active.plane : nil }
        guard let model, model.viewerGeometryIsCurrent(), let frame = model.metalFrame, let (clip, _, node) = target(),
              let records = try? JSON.parse(frame.drawGeometry.text) as? [[String: Any]],
              records.filter({ $0.string("id") == clip.id }).count == 1,
              let record = records.first(where: { $0.string("id") == clip.id }) else { return nil }
        return NativeColorWindowGeometry.Plane(record: record, clipID: clip.id, nodeID: nodeID, nodeType: node.string("type"))
    }

    private func begin(viewport: NativeViewerGeometry.Viewport?, target dragTarget: NativeColorWindowGeometry.Target?, point: CGPoint?) -> UUID? {
        guard active == nil, queued == nil, !submitting, let model, let session, let backendID = model.renderPreviewBackendID, let frame = model.metalFrame, frame.width > 0, frame.width <= 16384, let (clip, track, _) = target(), let plane = plane(),
              let workflow = NativeColorWorkflowCapture.capture(model: model, session: session, node: nodeID, renderedVersion: model.version) else { return nil }
        let drag: NativeColorWindowGeometry.Drag?
        if let viewport, let dragTarget, let point {
            guard let value = NativeColorWindowGeometry.Drag(plane: plane, viewport: viewport, target: dragTarget, start: point) else { return nil }
            drag = value
        } else { drag = nil }
        guard let render = model.beginRenderPreview(renderedVersion: workflow.origin.version) else { return nil }
        active = Capture(renderPixelWidth: frame.width, modelID: ObjectIdentifier(model), backendID: backendID, sessionID: session.sessionID, workflow: workflow, render: render, plane: plane, clip: clip, track: track, viewport: viewport, drag: drag, previousRotation: plane.window.rotation)
        draftWindow = plane.window
        return render.id
    }

    func beginPointer(point: CGPoint, viewport: NativeViewerGeometry.Viewport, hitSize: Double) -> UUID? {
        guard currentViewport?.layout == viewport.layout else { return nil }
        guard let plane = plane(), let target = plane.target(point, window: plane.window, viewport: viewport, hitSize: hitSize) else { return nil }
        return begin(viewport: viewport, target: target, point: point)
    }

    func beginNumeric() -> UUID? { begin(viewport: nil, target: nil, point: nil) }

    private func matches(_ capture: Capture, viewport: NativeViewerGeometry.Viewport? = nil, forCommit: Bool = false) -> Bool {
        guard let model, let session, let (clip, track, _) = target(allowSubmitting: forCommit),
              ObjectIdentifier(model) == capture.modelID, model.renderPreviewBackendID == capture.backendID,
              session.sessionID == capture.sessionID, model.project != nil, model.metalFrame != nil, model.renderError == nil,
              capture.workflow.matches(model: model, session: session, node: nodeID),
              viewport == nil || capture.viewport?.layout == viewport?.layout,
              capture.viewport == nil || capture.viewport?.layout == currentViewport?.layout,
              capture.viewport.map({ model.width == Double($0.canvas.width) && model.height == Double($0.canvas.height) }) ?? true,
              NSDictionary(dictionary: clip.fields).isEqual(to: capture.clip.fields),
              NSDictionary(dictionary: track.fields).isEqual(to: capture.track.fields) else { return false }
        return forCommit ? model.renderPreviewCommitMatches(capture.render) : model.viewerGeometryIsCurrent(capture: capture.render)
    }

    @discardableResult func previewPointer(token: UUID, point: CGPoint, viewport: NativeViewerGeometry.Viewport) -> Bool {
        guard let capture = active, capture.render.id == token, matches(capture, viewport: viewport),
              let next = capture.drag?.value(at: point, previousRotation: capture.previousRotation) else { cancel(token: token); return false }
        return preview(token: token, patch: next.geometryPatch)
    }

    @discardableResult func previewNumeric(token: UUID, text: String, property: String) -> Bool {
        guard let patch = NativeColorWindowGeometry.numericPatch(text, property: property) else { return false }
        return preview(token: token, patch: patch)
    }

    @discardableResult func preview(token: UUID, patch: [String: Any]) -> Bool {
        guard var capture = active, capture.render.id == token, matches(capture), let model,
              let operation = NativeColorWindowGeometry.operation(clip: capture.clip.id, node: nodeID, composition: capture.render.composition, patch: patch),
              model.preview([operation], capture: capture.render) else { cancel(token: token); return false }
        capture.patch = patch
        var fields = capture.plane.window.geometryPatch
        fields["type"] = capture.plane.window.type; fields["softness"] = capture.plane.window.softness; fields["invert"] = capture.plane.window.invert
        fields.merge(patch) { _, new in new }
        draftWindow = NativeColorWindowGeometry.Window(fields)
        capture.previousRotation = draftWindow?.rotation ?? capture.previousRotation
        active = capture
        return true
    }

    func commit(token: UUID, viewport: NativeViewerGeometry.Viewport? = nil) {
        guard let capture = active, capture.render.id == token, let model, let session else { return }
        guard matches(capture, viewport: viewport),
              let operation = NativeColorWindowGeometry.operation(clip: capture.clip.id, node: nodeID, composition: capture.render.composition, patch: capture.patch) else { cancel(token: token); return }
        let base = capture.plane.window.geometryPatch.merging(["softness": capture.plane.window.softness, "invert": capture.plane.window.invert]) { _, new in new }
        let changed = capture.patch.contains { key, value in
            guard let previous = base[key] else { return true }
            return !NSDictionary(dictionary: [key: value]).isEqual(to: [key: previous])
        }
        model.discardRenderPreview(capture.render)
        active = nil; draftWindow = nil
        guard changed, matches(capture, viewport: viewport, forCommit: true) else { return }
        queued = capture
        submitting = true
        model.perform { [weak self, weak model, weak session] in
            guard let self, let model, let session else { return }
            guard self.queued?.render.id == capture.render.id else { return }
            self.queued = nil
            defer { self.submitting = false; self.inFlight = false }
            // Recheck the captured identity before the first write. The backend checks the version atomically.
            guard self.matches(capture, viewport: viewport, forCommit: true) else { throw ReelBackend.APIError("The project, node or viewer changed before the window edit started.") }
            self.inFlight = true
            let body: [String: Any] = ["ops": [operation], "expectedVersion": capture.workflow.origin.version, "returnProject": true, "who": "you", "summary": "Edit node window"]
            let reply = try await capture.workflow.origin.backend.handle(method: "POST", path: "/api/ops", body: JSON(any: body).text)
            let fields = try JSON.parse(reply.text) as? [String: Any] ?? [:], version = Int(fields.number("version", -1))
            guard !Task.isCancelled, session.sessionID == capture.sessionID, model.renderPreviewBackendID == capture.backendID, model.viewerColorWindow === self, model.panel == .color,
                  capture.workflow.origin.matchesAfterApply(model: model, session: session, appliedVersion: version),
                  model.selectedIDs == capture.workflow.selection, model.selectedID == capture.workflow.primary,
                  model.processingContextID == capture.render.generation, model.time == capture.render.time,
                  !model.playing, !model.scrubbing, let replacement = fields["project"] as? [String: Any] else {
                throw ReelBackend.APIError("The window edit finished in its captured project. The editor changed before its result returned.")
            }
            model.receive("project", reply.text)
            guard model.version == version, model.project?.text == NativeProject(fields: replacement).text else {
                throw ReelBackend.APIError("The window response could not be opened. Review the current project before repeating the edit.")
            }
            model.status = "Edited node window"
        }
    }

    func cancel(token: UUID? = nil) {
        guard token == nil || active?.render.id == token || queued?.render.id == token else { return }
        if let active { model?.discardRenderPreview(active.render) }
        active = nil; queued = nil; draftWindow = nil
        if !inFlight { submitting = false }
    }

    func geometryViewport(_ viewport: NativeViewerGeometry.Viewport) -> NativeViewerGeometry.Viewport {
        active?.viewport ?? viewport
    }

    func updateViewport(_ viewport: NativeViewerGeometry.Viewport?) {
        if currentViewport?.layout != viewport?.layout { currentViewport = viewport; cancel() }
        else { currentViewport = viewport }
    }

    func invalidateIfChanged(viewport: NativeViewerGeometry.Viewport? = nil) {
        if let active, !matches(active, viewport: viewport) { cancel() }
        if let queued, !matches(queued, viewport: viewport, forCommit: true) { cancel() }
    }
}
