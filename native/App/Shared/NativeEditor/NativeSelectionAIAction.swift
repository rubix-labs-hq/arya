import ReelKit
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
            if compact { Image(systemName: "sparkles") }
            else { Label(title, systemImage: "sparkles") }
        }
        .accessibilityLabel(title).help(title)
        .disabled(model.selected == nil && model.composition == nil)
        .sheet(item: $context) { context in
            NativeSelectionAIIntent(model: model, assistant: assistant, context: context)
                .preferredColorScheme(.dark).tint(NativeEditorStyle.accent)
        }
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
                    Text("\(ids.count) \(ids.count == 1 ? "editable layer" : "editable layers") · \(context.scopeName)").font(.caption).foregroundStyle(.secondary)
                    TextField("Describe the animation or edit", text: $intent, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(4...8)
                    // Like the panel, starting points show only while the intent is empty, so one never replaces typed text.
                    if !context.suggestions.isEmpty && intent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text("Starting points").font(.subheadline)
                        ForEach(context.suggestions, id: \.self) { suggestion in
                            Button { intent = suggestion } label: { Text(suggestion).font(.caption).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading) }
                                .buttonStyle(.bordered)
                        }
                    }
                    Text("The assistant receives your intent and source layer references, plus project context. Its tools can read the open project, transcripts and requested project or reference images. Review AI sharing permission before the first send. Motion stays editable in the Motion panel.").font(.caption).foregroundStyle(.secondary)
                    if !assistant.configured {
                        // Setup opens in place, and the intent typed here stays.
                        Text(assistant.reason).font(.caption).foregroundStyle(.secondary)
                        NavigationLink {
                            NativeAssistantSettings(assistant: assistant).navigationTitle("Assistant settings")
                        } label: {
                            Label("Set up assistant", systemImage: "sparkles")
                                .foregroundStyle(NativeEditorStyle.accentInk)
                                .frame(minHeight: 44)
                        }.buttonStyle(.borderedProminent).tint(NativeEditorStyle.accent)
                            .accessibilityIdentifier("askAI.setUpAssistant")
                    }
                    if assistant.isWorking { Text("Wait for the assistant to finish its current edit.").font(.caption).foregroundStyle(.secondary) }
                    if let error {
                        Text(error).font(.caption).foregroundStyle(.secondary)
                        if context.folder == model.folder?.standardizedFileURL.path {
                            Button("Refresh source selection") { refreshContext() }
                        }
                    }
                }.nativePanelPadding()
            }
            .navigationTitle("Ask Arya")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Ask Arya") {
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
        .sheet(isPresented: $reviewingSharing) {
            NativeAssistantSharingReview(assistant: assistant)
                .preferredColorScheme(.dark).tint(NativeEditorStyle.accent)
        }
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

extension NativeAskAryaTarget {
    static func clip(_ clip: NativeClip) -> Self {
        Self(kind: .clip, objectID: clip.id, label: clip.name, subtype: clip.kind)
    }

    static func media(_ asset: NativeAsset) -> Self {
        Self(kind: .media, objectID: asset.id, label: asset.name,
             subtype: asset.fields.dictionary("generated").string("kind") == "original-music" ? "music" : asset.kind)
    }

    static func track(_ track: NativeTrack) -> Self {
        Self(kind: .track, objectID: track.id, label: track.name, subtype: track.kind)
    }

    @MainActor static func frame(_ model: NativeEditorModel) -> Self {
        Self(kind: .frame, objectID: String(model.time), label: "Frame " + nativeTimecode(model.time, fps: model.fps),
             details: model.selectedID.map { ["selectedClip": $0] } ?? [:])
    }

    static func panel(_ kind: Kind, clip: NativeClip, details: [String: String] = [:]) -> Self {
        Self(kind: kind, objectID: clip.id, label: "\(kind.rawValue.capitalized) · \(clip.name)", subtype: clip.kind, details: details)
    }
}

extension NativeEditorModel {
    func pinForAssistant(_ context: AskAryaPinnedContext, suggestion: String?) {
        guard context.generation == processingContextID, context.version == version else {
            status = "The project changed. Open the item’s menu again."; return
        }
        var pins = pinnedAssistantTargets.filter { $0.id != context.id }
        pins.append(context)
        guard pins.count <= 16, JSON(any: pins.map(\.reference)).text.utf8.count <= 48_000 else {
            status = "Remove an attached item to make room for this reference."; return
        }
        pinnedAssistantTargets = pins
        if let suggestion {
            if assistantDraft.isEmpty { assistantInputKind = "prompt"; assistantDraft = suggestion }
            else { assistantDraft += "\n" + suggestion }
        }
        assistantFocusRequests += 1
        requestedWorkspace = .assistant
    }
}

struct NativeContextAIMenuContent: View {
    let model: NativeEditorModel
    let context: AskAryaPinnedContext

    init(_ model: NativeEditorModel, _ target: NativeAskAryaTarget) {
        self.model = model
        context = AskAryaPinnedContext(target: target, composition: model.composition, version: model.version, generation: model.processingContextID)
    }

    var body: some View {
        Button("Add to Ask Arya", systemImage: "plus.bubble") { model.pinForAssistant(context, suggestion: nil) }
        Menu("Ask Arya", systemImage: "sparkles") {
            ForEach(context.target.suggestions, id: \.self) { suggestion in
                Button(suggestion) { model.pinForAssistant(context, suggestion: suggestion) }
            }
        }
    }
}

extension View {
    @ViewBuilder @MainActor func aryaContextAIMenu(_ model: NativeEditorModel, _ target: NativeAskAryaTarget?) -> some View {
        if let target { contextMenu { NativeContextAIMenuContent(model, target) } }
        else { self }
    }
}
