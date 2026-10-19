import Foundation

@main struct ColorWindowFieldChecks {
    @MainActor static var count = 0
    @MainActor static func check(_ value: Bool, _ message: String) { precondition(value, message); count += 1 }
    @MainActor static func fixture() -> (NativeEditorModel, EditorSession, NativeColorWindowController, ColorWindowNumberFieldChecks) {
        let window: [String: Any] = ["type": "circle", "x": 0.123456, "y": 0.5, "w": 0.3, "h": 0.3, "rotation": 0.0, "softness": 0.15]
        let clip: [String: Any] = ["id": "c1", "kind": "shape", "start": 0.0, "dur": 4.0,
            "nodes": ["list": [["id": "n4", "type": "corrector", "window": window]], "links": []]]
        let project = NativeProject(fields: ["width": 1920, "height": 1080,
            "tracks": [["id": "V1", "kind": "video", "clips": [clip]]]])
        let node: [String: Any] = ["nodeID": "n4", "nodeType": "corrector", "coordinateSpace": NativeColorWindowGeometry.coordinateSpace,
            "nodePlaneWidth": 480, "nodePlaneHeight": 853, "window": window]
        let record: [String: Any] = ["id": "c1", "kind": "shape", "width": 500.0, "height": 500.0,
            "matrix": [1.0, 0, 0, 1, 960, 540], "crop": [:], "nodePlanes": ["n4": node]]
        let session = EditorSession(); session.backend = ReelBackend()
        let model = NativeEditorModel(session: session, project: project, geometry: JSON(any: [record]))
        let controller = NativeColorWindowController(model: model, session: session, nodeID: "n4")
        model.viewerColorWindow = controller
        return (model, session, controller, ColorWindowNumberFieldChecks(controller: controller, property: "x", value: 0.123456))
    }
    @MainActor static func edit(_ field: ColorWindowNumberFieldChecks, _ text: String) {
        field.text = text
        field.textChanged(text)
    }
    @MainActor static func main() async throws {
        for event in ["blur", "Enter"] {
            let (model, session, controller, field) = fixture()
            let original = model.project!.text
            check(field.text == "0.1235", "Regression fixture has rounded display text")
            field.focused = true; field.beginEditing()
            check(field.text == "0.123456" && field.token != nil, "Focus exposes exact round-trip value")
            field.textChanged(field.text)
            check(!field.dirty && model.previewOperations == nil && model.requests == 0, "Programmatic focus text cannot preview a rounded edit")
            field.finish(); field.focused = false
            if event == "Enter" { field.finish() }
            check(field.token == nil && !field.dirty && controller.draftWindow == nil, "Untouched \(event) discards capture")
            check(model.deferred.isEmpty && model.project!.text == original, "Untouched \(event) cannot queue a project edit")
            try await model.flush()
            check(session.backend!.requests.isEmpty && !model.previewing, "Untouched \(event) performs no write")
        }
        let (edited, editedSession, editedController, dirty) = fixture()
        dirty.focused = true; dirty.beginEditing(); edit(dirty, "0.2345678901234567")
        check(dirty.dirty && !dirty.invalid && edited.previewOperations != nil, "Changed text previews through production controller")
        check(editedController.draftWindow?.x == 0.2345678901234567, "GPU draft keeps full input precision")
        dirty.finish(); dirty.focused = false; dirty.finish()
        check(edited.deferred.count == 1 && dirty.token == nil && !dirty.dirty, "Enter then blur queues one edit")
        try await edited.flush()
        let patch = editedSession.backend!.requests[0].objects("ops")[0].dictionary("set").dictionary("window")
        check(patch.number("x") == 0.2345678901234567, "Changed text commits exact parsed value")
        check(editedSession.backend!.requests.count == 1 && Set(patch.keys) == ["x"], "Dirty field writes only its window property once")

        let (reverted, revertedSession, revertedController, revert) = fixture()
        revert.focused = true; revert.beginEditing(); edit(revert, "0.9"); edit(revert, revert.initialText)
        check(!revert.dirty && revertedController.draftWindow?.x == 0.123456, "Reverting text restores exact original draft")
        revert.finish(); try await reverted.flush()
        check(revertedSession.backend!.requests.isEmpty && reverted.previewOperations == nil, "Reverted text discards preview without a write")

        let (equivalent, equivalentSession, _, same) = fixture()
        same.focused = true; same.beginEditing(); edit(same, "0.1234560"); same.finish()
        try await equivalent.flush()
        check(equivalentSession.backend!.requests.isEmpty && equivalent.deferred.isEmpty,
              "A changed spelling of the same exact value creates no write")

        for event in ["Escape", "disappear", "external cancel", "invalid", "stale", "foreign preview"] {
            let (model, session, controller, field) = fixture()
            field.focused = true; field.beginEditing(); edit(field, "0.7654321")
            var foreignID: UUID?
            switch event {
            case "Escape", "disappear": field.cancelEditing()
            case "external cancel": controller.cancel()
            case "invalid": edit(field, "nan"); check(field.invalid, "Invalid edited text is marked")
            case "stale": model.time += 1
            default:
                model.discardRenderPreview(redraw: false)
                let foreign = model.beginRenderPreview(renderedVersion: model.version)!
                foreignID = foreign.id
                check(model.previewOwnershipID == foreign.id, "Foreign capture owns preview before old field finishes")
            }
            field.finish(); field.focused = false; field.finish()
            try await model.flush()
            check(session.backend!.requests.isEmpty && model.deferred.isEmpty, "\(event) cannot submit a field write")
            check(field.token == nil && !field.dirty && !field.invalid, "\(event) clears local editing state")
            if event == "foreign preview" {
                check(model.previewOwnershipID == foreignID && model.previewCapture?.id == foreignID,
                      "Stale field cannot clear foreign preview ownership or capture")
            } else {
                check(model.previewOperations == nil && controller.draftWindow == nil, "\(event) removes field GPU draft")
            }
        }
        let (unavailable, unavailableSession, _, denied) = fixture()
        unavailable.selectedIDs = []
        denied.focused = true; denied.beginEditing(); edit(denied, "0.9"); denied.finish()
        try await unavailable.flush()
        check(!denied.focused && denied.token == nil && unavailableSession.backend!.requests.isEmpty,
              "Unavailable capture ends focus without an edit")
        print("Passed \(count) extracted production numeric field lifecycle checks.")
    }
}
