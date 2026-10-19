import SwiftUI

struct NativeSelectionAIAction: View {
    @ObservedObject var model: NativeEditorModel
    @ObservedObject var assistant: NativeAssistant
    var title = "Animate selected"
    var compact = false
    @State private var context: NativeSelectionAIContext?

    var body: some View {
        Button {
            guard let selection = NativeSelectionAIContext.make(project: model.project?.fields ?? [:], clipID: model.selectedID, clipIDs: model.selectedIDs, composition: model.composition, time: model.time, version: model.version, folder: model.folder?.standardizedFileURL.path) else {
                model.status = "Select a valid layer or a smaller composition to ask AI."; return
            }
            context = selection
        } label: {
            if compact { Image(systemName: "text.bubble") }
            else { Label(title, systemImage: "text.bubble") }
        }
        .accessibilityLabel(title).help(title)
        .disabled(model.selected == nil && model.composition == nil)
        .sheet(item: $context) { context in NativeSelectionAIIntent(model: model, assistant: assistant, context: context) }
        .onChange(of: model.folder) { _, _ in context = nil }
    }
}

private struct NativeSelectionAIIntent: View {
    @ObservedObject var model: NativeEditorModel
    @ObservedObject var assistant: NativeAssistant
    @State private var context: NativeSelectionAIContext
    @Environment(\.dismiss) private var dismiss
    @State private var intent = ""
    @State private var error: String?
    @State private var reviewingSharing = false

    init(model: NativeEditorModel, assistant: NativeAssistant, context: NativeSelectionAIContext) {
        self.model = model; self.assistant = assistant
        _context = State(initialValue: context)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(context.label).font(.headline)
                    let selection = context.refs.dictionary("sourceSelection")
                    let ids = selection["nativeLayerIDs"] as? [String] ?? []
                    Text("\(ids.count) \(ids.count == 1 ? "editable layer" : "editable layers") · Composition \(selection.string("composition"))").font(.caption).foregroundStyle(.secondary)
                    TextField("Describe the animation or edit", text: $intent, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(4...8)
                    if !context.suggestions.isEmpty {
                        Text("Starting points").font(.subheadline)
                        ForEach(context.suggestions, id: \.self) { suggestion in
                            Button { intent = suggestion } label: { Text(suggestion).font(.caption).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading) }
                                .buttonStyle(.bordered)
                        }
                    }
                    Text("The assistant receives your intent and source layer references, plus project context. Its tools can read the open project, transcripts and requested project or reference images. Review AI sharing permission before the first send. Motion stays editable in the Motion panel.").font(.caption).foregroundStyle(.secondary)
                    if !assistant.configured { Text(assistant.reason).font(.caption).foregroundStyle(.secondary) }
                    if assistant.isWorking { Text("Wait for the assistant to finish its current edit.").font(.caption).foregroundStyle(.secondary) }
                    if let error {
                        Text(error).font(.caption).foregroundStyle(.secondary)
                        if context.folder == model.folder?.standardizedFileURL.path {
                            Button("Refresh source selection") { refreshContext() }
                        }
                    }
                }.nativePanelPadding()
            }
            .navigationTitle("Ask AI")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Ask AI") {
                        let prompt = intent.trimmingCharacters(in: .whitespacesAndNewlines)
                        do {
                            guard context.folder == model.folder?.standardizedFileURL.path else { reject("The project changed. Close this request and select a source in the open project."); return }
                            guard context.matches(project: model.project?.fields ?? [:], folder: model.folder?.standardizedFileURL.path, version: model.version) else { reject("The source project changed. Refresh the source selection before sending. Your intent is still here."); return }
                            guard let refs = context.references(intent: prompt) else { reject("This request has too many source references. Select a smaller composition or layer."); return }
                            try assistant.send(prompt, refs: refs)
                            model.panel = .assistant
                            if model.mobilePanel != nil { model.mobilePanel = .assistant }
                            dismiss()
                        } catch { reject(error.localizedDescription); if assistant.sharingReview != nil { reviewingSharing = true } }
                    }.disabled(!assistant.configured || assistant.isWorking || intent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || intent.count > 4000)
                }
            }
        }.frame(minWidth: 320, minHeight: 360)
        .sheet(isPresented: $reviewingSharing) { NativeAssistantSharingReview(assistant: assistant) }
    }

    private func reject(_ message: String) { error = message; model.status = message }

    private func refreshContext() {
        guard context.folder == model.folder?.standardizedFileURL.path else { return }
        let comp = context.refs.string("composition")
        let clip = context.refs.string("clip")
        guard let updated = NativeSelectionAIContext.make(project: model.project?.fields ?? [:], clipID: clip.isEmpty ? nil : clip,
            clipIDs: Set(context.refs["clips"] as? [String] ?? []),
            composition: comp == "main" ? nil : comp, time: model.time, version: model.version, folder: context.folder) else {
            reject("The source selection is no longer available. Close this request and select another layer."); return
        }
        context = updated; error = nil
    }
}
