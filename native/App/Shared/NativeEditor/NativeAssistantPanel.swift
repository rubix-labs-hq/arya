import ReelKit
import SwiftUI
import UniformTypeIdentifiers

enum NativeAssistantLayout {
    struct Regions {
        let header: Double
        let chat: Double
        let composer: Double
        let footer: Double
        let editor: Double
        let separator: Double
    }

    static func segmentedInput(width: Double, accessibilityText: Bool) -> Bool { width >= 400 && !accessibilityText }

    static func stackedFooter(width: Double, actionHeight: Double, accessibilityText: Bool) -> Bool {
        accessibilityText || width < 280 * max(1, actionHeight / 44)
    }

    static func footerBudget(actionHeight: Double, stacked: Bool, working: Bool) -> Double {
        actionHeight * (stacked ? 2 : 1) + (stacked ? 24 : 16)
    }

    struct FooterRegions {
        let activity: Double
        let actions: Double
        let gap: Double
    }

    /// Give actions their own viewport; preserve intrinsic targets inside its scroll content.
    static func footerRegions(height: Double, actionHeight: Double, hasRun: Bool) -> FooterRegions {
        let height = height.isFinite ? max(0, height) : 0
        let actionHeight = actionHeight.isFinite ? max(0, actionHeight) : 0
        let actions = min(height, actionHeight + 16)
        let remaining = max(0, height - actions)
        let gap = hasRun ? min(8, remaining) : 0
        return FooterRegions(activity: hasRun ? remaining - gap : 0, actions: actions, gap: gap)
    }

    struct CompactRegions {
        let header: Double
        let content: Double
        let footer: Double
        let separator: Double
    }

    static func compactComposer(width: Double, compactSizeClass: Bool) -> Bool {
        compactSizeClass || !width.isFinite || width < 600
    }

    /// Keep the draft first and reserve a scrollable action row when the keyboard shortens the pane.
    static func compactRegions(height: Double, requestedFooter: Double) -> CompactRegions {
        let height = height.isFinite ? max(0, height) : 0
        let requestedFooter = requestedFooter.isFinite ? max(0, requestedFooter) : 0
        let header = min(height, 44)
        let separator = min(1, max(0, height - header) / 2)
        let available = max(0, height - header - 2 * separator)
        let footer = min(requestedFooter, available * 0.4)
        return CompactRegions(header: header, content: available - footer, footer: footer, separator: separator)
    }

    static func compactEditorHeight(contentHeight: Double, actionHeight: Double) -> Double {
        let contentHeight = contentHeight.isFinite ? max(0, contentHeight) : 0
        let actionHeight = actionHeight.isFinite ? max(44, actionHeight) : 44
        return min(150, max(80, contentHeight - actionHeight - 42))
    }

    /// Pin actions; scroll their viewport too if scaled actions exceed a short pane.
    static func regions(height: Double, controlHeight: Double, requestedFooter: Double? = nil) -> Regions {
        let height = height.isFinite ? max(0, height) : 0
        let controlHeight = controlHeight.isFinite ? max(0, controlHeight) : 0
        let header = min(height, controlHeight)
        let separator = min(1, max(0, height - header) / 2)
        let afterHeader = max(0, height - header - 2 * separator)
        let requested = requestedFooter ?? controlHeight + 12
        // Leave usable history and drafting viewports even with large working actions.
        let retainedContent = min(104, afterHeader * 0.6)
        let footer = min(afterHeader - retainedContent, max(0, requested.isFinite ? requested : controlHeight + 12))
        let available = afterHeader - footer
        let composer = min(246, available * 0.65)
        let chat = available - composer
        return Regions(header: header, chat: chat, composer: composer, footer: footer,
                       editor: min(150, max(80, composer - 112)), separator: separator)
    }
}

// BEGIN SCRIPT IMPORT PRESENTATION
/// A reappearing picker must retain its original request and open only once.
struct NativeScriptImportPresentation {
    var isPresented = false
    private var started = false

    mutating func start() {
        guard !started else { return }
        started = true; isPresented = true
    }
}
// END SCRIPT IMPORT PRESENTATION

/// Completion and cancellation carry the context that presented this picker.
private struct NativeScriptImportPresenter: View {
    let context: NativeScriptImportContext
    let onCompletion: (NativeScriptImportContext, Result<[URL], Error>) -> Void
    let onCancellation: (NativeScriptImportContext) -> Void
    @State private var presentation = NativeScriptImportPresentation()

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .onAppear { presentation.start() }
            .fileImporter(isPresented: $presentation.isPresented, allowedContentTypes: [.plainText, .json], allowsMultipleSelection: false,
                onCompletion: { result in onCompletion(context, result) },
                onCancellation: { onCancellation(context) })
    }
}

struct NativeAssistantPanel: View {
    @ObservedObject var assistant: NativeAssistant
    @ObservedObject var model: NativeEditorModel
    var openSettings: (() -> Void)?
    var close: (() -> Void)?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var draftFocused: Bool
    #endif
    @ScaledMetric(relativeTo: .body) private var scaledActionHeight = 44.0
    private var actionHeight: Double { max(44, scaledActionHeight) }
    @ScaledMetric(relativeTo: .caption) private var activityFontSize = 11.0
    @State private var reviewingSharing = false
    @State private var settings = false
    @State private var scriptImportContext: NativeScriptImportContext?
    @State private var scriptImportRequestID: UUID?
    @State private var inspectedReceipt: NativeChangeReceipt?
    @State private var inspectedReferences: NativeAssistantReferenceInspection?

    var body: some View {
        GeometryReader { geometry in
            let stackedFooter = NativeAssistantLayout.stackedFooter(width: geometry.size.width, actionHeight: actionHeight, accessibilityText: dynamicTypeSize.isAccessibilitySize)
            let hasRun = assistant.startedAt != nil
            let actionBudget = NativeAssistantLayout.footerBudget(actionHeight: actionHeight, stacked: stackedFooter, working: assistant.isWorking)
            let footerBudget = actionBudget + (hasRun ? 68 * max(1, activityFontSize / 11) : 0)
            let regions = NativeAssistantLayout.regions(height: geometry.size.height, controlHeight: NativeEditorStyle.minimumControlHeight, requestedFooter: footerBudget)
            let footerRegions = NativeAssistantLayout.footerRegions(height: regions.footer, actionHeight: actionBudget - 16, hasRun: hasRun)
            #if os(iOS)
            if NativeAssistantLayout.compactComposer(width: geometry.size.width, compactSizeClass: horizontalSizeClass == .compact) {
                compactPanel(height: geometry.size.height, actionBudget: actionBudget, stackedFooter: stackedFooter, hasRun: hasRun)
            } else {
                regularPanel(width: geometry.size.width, height: geometry.size.height, regions: regions, footerRegions: footerRegions, stackedFooter: stackedFooter, hasRun: hasRun)
            }
            #else
            regularPanel(width: geometry.size.width, height: geometry.size.height, regions: regions, footerRegions: footerRegions, stackedFooter: stackedFooter, hasRun: hasRun)
            #endif
        }
        .foregroundStyle(NativeEditorStyle.text).tint(NativeEditorStyle.accent)
        .background(NativeEditorStyle.panel)
        .task { await refreshAccountsIfIdle() }
        .task(id: suggestionKey) { await assistant.refreshSuggestions(selection: model.selectedIDs, composition: model.composition) }
        .task(id: proposalKey) { await assistant.refreshProposalCurrency() }
        .onChange(of: scenePhase) { previous, current in
            if current == .active && previous != .active { Task { await refreshAccountsIfIdle() } }
        }
        .background {
            if let context = scriptImportContext {
                NativeScriptImportPresenter(context: context, onCompletion: readScriptImport, onCancellation: cancelScriptImport)
                    .id(context.id)
            }
        }
        .onDisappear { invalidateScriptImport() }
        .sheet(isPresented: $reviewingSharing) { NativeAssistantSharingReview(assistant: assistant) }
        .sheet(isPresented: $settings) {
            NavigationStack {
                NativeAssistantSettings(assistant: assistant).navigationTitle("Assistant settings")
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { settings = false } } }
            }.preferredColorScheme(.dark).tint(NativeEditorStyle.accent)
            #if os(macOS)
            .frame(minWidth: 320, minHeight: 300)
            #endif
        }
        .sheet(item: $inspectedReceipt) { receipt in
            NavigationStack {
                ScrollView([.vertical, .horizontal]) {
                    Text(receipt.displayJSON).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true).padding(16)
                }.background(NativeEditorStyle.background).foregroundStyle(NativeEditorStyle.text)
                    .navigationTitle("Edit \(receipt.version) JSON diff")
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { inspectedReceipt = nil } } }
            }.preferredColorScheme(.dark).tint(NativeEditorStyle.accent)
            #if os(macOS)
            .frame(minWidth: 320, minHeight: 300)
            #endif
        }
        .sheet(item: $inspectedReferences) { inspection in
            NavigationStack {
                VStack(alignment: .leading, spacing: 0) {
                    if let note = inspection.note {
                        Text(note).font(.caption).foregroundStyle(NativeEditorStyle.muted)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    }
                    ScrollView([.vertical, .horizontal]) {
                        Text(inspection.text).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: true).padding(16)
                    }
                }.navigationTitle(inspection.title)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { inspectedReferences = nil } } }
            }.preferredColorScheme(.dark).tint(NativeEditorStyle.accent)
            #if os(macOS)
            .frame(minWidth: 320, minHeight: 300)
            #endif
        }
    }

    private var conversationContent: some View {
        LazyVStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Circle().fill(assistant.configured ? NativeEditorStyle.success : NativeEditorStyle.muted).frame(width: 6, height: 6)
                Text(assistant.providerName).font(.system(size: 11, weight: .medium))
                Text(assistant.state == "cancelling" ? "Stopping" : assistant.isWorking ? "Working" : assistant.state == "done" ? "Response finished" : assistant.state == "cancelled" ? "Stopped" : assistant.state == "error" ? "Failed" : assistant.configured ? "Ready" : "Setup needed").font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted)
                Spacer(minLength: 0)
            }.accessibilityElement(children: .combine)
            if !assistant.route.isEmpty { routeSummary }
            if !assistant.configured {
                VStack(alignment: .leading, spacing: 8) {
                    Text(assistant.reason).font(.system(size: 12)).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
                    Button("Open account settings") { showSettings() }.controlSize(.small)
                }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 6))
            }
            if let diagnostic = assistant.localDiagnostic {
                VStack(alignment: .leading, spacing: 5) {
                    Label("Latest local tool failure", systemImage: "exclamationmark.triangle").font(.system(size: 11, weight: .semibold))
                    Text(diagnostic).font(.system(size: 12)).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    Text("A tool reported an error. Earlier committed edits may still be present.")
                        .font(.caption).foregroundStyle(NativeEditorStyle.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 6))
                .accessibilityElement(children: .combine)
            }
            let history = (try? JSON.parse(assistant.chatHistoryStatus.text) as? [String: Any]) ?? [:]
            if let warning = history["warning"] as? String {
                Text(warning).font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            }
            if history.number("restored") > 0 {
                Text("Saved display history · previous messages and reference labels. Runs and permissions are checked again.").font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            }
            if assistant.chat.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    Text("Edit with your agent").font(.system(size: 12, weight: .semibold))
                    Text(assistant.previewChanges ? "Ask for a change to the selection or the open timeline. With Preview changes on, you see what will change and apply it yourself." : "Describe a change to the selected clip or the open timeline. Review the result in the viewer and undo it with Undo this change.")
                    .font(.system(size: 12)).foregroundStyle(NativeEditorStyle.muted)
                }.padding(.vertical, 14).frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(Array(assistant.chat.enumerated()), id: \.offset) { index, message in
                let fields = (try? JSON.parse(message.text) as? [String: Any]) ?? [:]
                let fromUser = ["you", "user"].contains(fields.string("role"))
                VStack(alignment: .leading, spacing: 5) {
                    Text(fromUser ? "You" : fields.string("provider").isEmpty ? "Assistant" : NativeAssistant.providerName(fields.string("provider")))
                    .font(.system(size: 10, weight: .semibold)).foregroundStyle(NativeEditorStyle.muted)
                    Text(fields.string("text")).font(.system(size: 12)).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    if fromUser {
                        Button("Edit request") {
                            model.assistantDraft = fields.string("text")
                            let labels = fields["refs"] as? [[String: Any]] ?? []
                            let kind = fields.dictionary("refs").string("inputKind", labels.first { $0.string("kind") == "input_kind" }?.string("id") ?? "prompt")
                            model.assistantInputKind = ["prompt", "script", "screenplay"].contains(kind) ? kind : "prompt"
                        }.controlSize(.small).frame(minHeight: 44)
                        .disabled(assistant.isWorking || !model.assistantDraft.isEmpty || fields.string("text").isEmpty)
                        .help("Use this text as a draft with the current selection. Clear the existing draft first.")
                        .accessibilityHint("Review the current selection before sending. Attached context is not copied.")
                    }
                    if let labels = fields["refs"] as? [[String: Any]], !labels.isEmpty {
                        Button { inspectedReferences = NativeAssistantReferenceInspection(text: JSON(any: labels).text) } label: {
                            Label("Inspect historical reference labels", systemImage: "paperclip").font(.system(size: 11))
                        }.buttonStyle(.plain).foregroundStyle(NativeEditorStyle.accent)
                            .accessibilityHint("Read-only labels from a previous request. Current selection and sharing are reviewed when sending.")
                    }
                    if let refs = fields["refs"] as? [String: Any], !refs.isEmpty {
                        Button { inspectedReferences = NativeAssistantReferenceInspection(text: JSON(any: refs).text) } label: {
                            let count = refs.dictionary("sourceSelection")["nativeLayerIDs"] as? [String] ?? refs["clips"] as? [String] ?? []
                            Label(count.isEmpty ? "Inspect attached context" : "Inspect \(count.count) attached layers", systemImage: "paperclip")
                            .font(.system(size: 11))
                        }.buttonStyle(.plain).foregroundStyle(NativeEditorStyle.accent)
                    }
                }
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(fromUser ? NativeEditorStyle.panelRaised : NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 6))
                .id(index)
            }
            if !model.changeReceipts.isEmpty {
                HStack {
                    Text("Committed assistant edits").font(.system(size: 12, weight: .semibold)).accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 0)
                    Button("Undo latest edit") { model.undo() }.controlSize(.small)
                }.id("receipts")
                Text("These receipts record project changes. Review playback and the timeline to verify the requested result.")
                    .font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Undo reverts the latest committed edit in the project.")
                .font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted)
                ForEach(model.changeReceipts.reversed()) { receipt in
                    receiptRow(receipt)
                }
            }
            // On a phone the cards sit above the draft, where a pending preview is seen first.
            if !phoneComposer { changeCards }
            if assistant.isWorking {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(assistant.progress.isEmpty ? "Processing the request" : assistant.progress)
                    .font(.system(size: 11)).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }.id("progress")
            }
        }.frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
    }

    private var conversationScroll: some View {
        ScrollViewReader { proxy in
            ScrollView {
                conversationContent
            }.frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity)
            .onChange(of: assistant.state) { _, state in if state == "working" { proxy.scrollTo("progress", anchor: .bottom) } }
            .onChange(of: assistant.chat.count) { _, count in if assistant.isWorking { proxy.scrollTo("progress", anchor: .bottom) } else if count > 0 { proxy.scrollTo(count - 1, anchor: .bottom) } }
            .onChange(of: model.changeReceipts.count) { _, count in if count > 0 { proxy.scrollTo("receipts", anchor: .top) } }
        }
    }

    private func draftEditor(height: Double) -> some View {
        TextEditor(text: $model.assistantDraft)
        #if os(iOS)
        .focused($draftFocused)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { draftFocused = false }
                    .frame(minWidth: 44, minHeight: actionHeight)
                    .accessibilityLabel("Dismiss assistant keyboard")
            }
        }
        #endif
        .font(.body).scrollContentBackground(.hidden)
        .frame(height: height)
        .padding(4).background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 6))
        .overlay { RoundedRectangle(cornerRadius: 6).stroke(NativeEditorStyle.line) }
        .overlay(alignment: .topLeading) {
            if model.assistantDraft.isEmpty {
                Text(model.assistantInputKind == "prompt" ? "Describe the edit" : "Paste a script to build editable scenes")
                .font(.body).foregroundStyle(NativeEditorStyle.muted).padding(9).allowsHitTesting(false)
            }
        }
        .accessibilityLabel("Assistant prompt or script")
        .accessibilityIdentifier("editor.assistant.draft")
        .onKeyPress(.return, phases: .down) { press in
            guard press.modifiers.isEmpty, canSendDraft else { return .ignored }
            sendDraft()
            return .handled
        }
    }

    private var phoneComposer: Bool {
        #if os(iOS)
        horizontalSizeClass == .compact
        #else
        false
        #endif
    }

    /// The pending preview, a preview being applied, and one-step undo of the latest change.
    @ViewBuilder private var changeCards: some View {
            if let proposal = assistant.proposal {
                NativeAssistantPreviewCard(proposal: proposal, stale: assistant.proposalStale || proposal.baseVersion != model.version, running: assistant.isWorking,
                                           newRequest: assistant.isWorking && proposal.runID != assistant.currentRunID,
                                           apply: { Task { await assistant.applyProposal() } }, discard: { assistant.discardProposal() }).id("preview")
            }
            if let applying = assistant.applyingProposal {
                NativeAssistantApplyingCard(applying: applying, dismiss: { assistant.dismissApplyFailure() })
            }
            if let change = assistant.lastChange, assistant.canUndoLastChange(version: model.version) {
                HStack(spacing: 8) {
                    Text(change.kind == "preview" ? "Applied the assistant preview." : "The last request made \(change.edits) edit\(change.edits == 1 ? "" : "s").")
                        .font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Button("Undo this change") { Task { await assistant.undoLastChange() } }.controlSize(.small).frame(minHeight: 44)
                        .help("Restore the project from before this assistant change. Undo restores it again.")
                }.padding(.horizontal, 10).background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 6))
                .accessibilityElement(children: .contain).accessibilityIdentifier("editor.assistant.undoChange")
            }
    }

    /// Suggested requests and the Preview changes switch, above the draft.
    private var composerAssists: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !assistant.suggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(assistant.suggestions) { item in
                            Button(item.label) { model.assistantDraft = item.prompt }
                                .buttonStyle(.bordered).controlSize(.small).tint(NativeEditorStyle.text).disabled(assistant.isWorking)
                                .help(item.prompt + " It goes into the draft for you to review before sending.")
                        }
                    }
                }.accessibilityElement(children: .contain).accessibilityLabel("Suggested requests")
            }
            Toggle("Preview changes", isOn: $assistant.previewChanges)
                .toggleStyle(.switch).controlSize(.small).font(.caption).disabled(assistant.isWorking)
                .help("Show the clips, settings and processing a request will change, and apply them only when you choose.")
                .accessibilityIdentifier("editor.assistant.previewChanges")
        }
    }

    private var suggestionKey: String { "\(model.selectedIDs.sorted().joined(separator: ","))|\(model.composition ?? "")|\(model.version)" }
    private var proposalKey: String { "\(assistant.proposal?.id.uuidString ?? "")|\(model.version)" }

    private func regularPanel(width: Double, height: Double, regions: NativeAssistantLayout.Regions, footerRegions: NativeAssistantLayout.FooterRegions, stackedFooter: Bool, hasRun: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            #if os(iOS)
            ScrollView(.vertical) {
                assistantHeader.frame(minHeight: max(Double(NativeEditorStyle.minimumControlHeight), actionHeight), alignment: .top)
            }.frame(height: regions.header)
            #else
            assistantHeader.frame(height: regions.header)
            #endif
            Rectangle().fill(NativeEditorStyle.line).frame(height: regions.separator)
            conversationScroll
            .padding(.horizontal, 12).frame(height: regions.chat)
            Rectangle().fill(NativeEditorStyle.line).frame(height: regions.separator)
            if hasRun && footerRegions.activity > 0 {
                ScrollView(.vertical) { runActivity.padding(.horizontal, 12) }
                    .frame(height: footerRegions.activity)
            }
            if footerRegions.gap > 0 { Color.clear.frame(height: footerRegions.gap) }
            VStack(spacing: 0) {
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: 10) {
                        #if os(iOS)
                        composerContext
                        Button { inspectCurrentContext() } label: {
                            Label("Inspect current source context", systemImage: "paperclip")
                                .font(.caption).frame(minHeight: actionHeight, alignment: .leading)
                        }.buttonStyle(.plain).foregroundStyle(NativeEditorStyle.accent)
                            .disabled(model.selectedIDs.isEmpty && model.composition == nil)
                            .accessibilityHint("Preview the selected layers and source references before sending.")
                        #else
                        HStack(alignment: .top, spacing: 6) {
                            Button { inspectCurrentRequestContext() } label: {
                            Label(contextLabel, systemImage: "scope")
                                .font(.caption.weight(.medium)).lineLimit(2)
                                .foregroundStyle(NativeEditorStyle.accent)
                                .fixedSize(horizontal: false, vertical: true)
                            }.buttonStyle(.plain).foregroundStyle(NativeEditorStyle.accent)
                                .frame(minHeight: 30, alignment: .leading)
                                .disabled(model.project == nil || model.renderPreviewBackendID == nil)
                                .help("Inspect the current selection and request context. Send captures the current selection again.")
                                .accessibilityLabel("Inspect current request context: \(contextLabel)")
                            Spacer(minLength: 0)
                            footerTimecode
                        }.accessibilityElement(children: .combine)
                        #endif
                        #if os(iOS)
                        HStack(spacing: 6) {
                            if NativeAssistantLayout.segmentedInput(width: width, accessibilityText: dynamicTypeSize.isAccessibilitySize) {
                                inputPicker.pickerStyle(.segmented)
                            } else {
                                inputPicker.pickerStyle(.menu)
                            }
                            Button { requestScriptImport() } label: { Image(systemName: "doc.badge.plus") }
                            .buttonStyle(NativeToolbarButtonStyle()).fixedSize().help("Import a text script").accessibilityLabel("Import a text script")
                            .disabled(scriptImportContext != nil || model.renderPreviewBackendID == nil || model.folder == nil)
                        }
                        #endif
                        composerAssists
                        VStack(alignment: .leading, spacing: 6) {
                            draftEditor(height: regions.editor)
                        }
                        if let reference = model.lookReference {
                            HStack(spacing: 6) {
                                Image(systemName: "photo").foregroundStyle(NativeEditorStyle.muted)
                                Text((reference as NSString).lastPathComponent).font(.system(size: 11)).lineLimit(1).truncationMode(.middle)
                                Spacer(minLength: 0)
                                Button("Clear") { model.lookReference = nil }.controlSize(.small)
                            }
                        }
                    }.padding(12).frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                }.frame(height: regions.composer)
                footerActionViewport(height: footerRegions.actions, stacked: stackedFooter)
                    .padding(.horizontal, 12)
            }.background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 10))
                .overlay { RoundedRectangle(cornerRadius: 10).stroke(NativeEditorStyle.line) }
                .padding(.horizontal, 8)

        }.frame(width: width, height: height, alignment: .topLeading)
    }

    #if os(iOS)
    private func compactPanel(height: Double, actionBudget: Double, stackedFooter: Bool, hasRun: Bool) -> some View {
        let regions = NativeAssistantLayout.compactRegions(height: height, requestedFooter: actionBudget)
        let editorHeight = NativeAssistantLayout.compactEditorHeight(contentHeight: regions.content, actionHeight: actionHeight)
        return VStack(alignment: .leading, spacing: 0) {
            ScrollView(.vertical) {
                assistantHeader.frame(minHeight: max(44, actionHeight), alignment: .top)
            }.frame(height: regions.header)
            Rectangle().fill(NativeEditorStyle.line).frame(height: regions.separator)
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView(.vertical) {
                        VStack(alignment: .leading, spacing: 10) {
                            compactContextPill
                            if phoneComposer { changeCards }
                            composerAssists
                            draftEditor(height: editorHeight)
                            if hasRun { runActivity }
                            conversationContent
                        }.padding(12).frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .onChange(of: assistant.state) { _, state in
                        if state == "working" && model.assistantDraft.isEmpty && !draftFocused { proxy.scrollTo("progress", anchor: .bottom) }
                    }
                    .onChange(of: assistant.chat.count) { _, count in
                        guard model.assistantDraft.isEmpty && !draftFocused else { return }
                        if assistant.isWorking { proxy.scrollTo("progress", anchor: .bottom) }
                        else if count > 0 { proxy.scrollTo(count - 1, anchor: .bottom) }
                    }
                    .onChange(of: model.changeReceipts.count) { _, count in
                        if count > 0 && model.assistantDraft.isEmpty && !draftFocused { proxy.scrollTo("receipts", anchor: .top) }
                    }
                }.frame(height: regions.content)
                Rectangle().fill(NativeEditorStyle.line).frame(height: regions.separator)
                footerActionViewport(height: regions.footer, stacked: stackedFooter, compactInput: true).padding(.horizontal, 12)
            }.background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 10))
                .overlay { RoundedRectangle(cornerRadius: 10).stroke(NativeEditorStyle.line) }
                .padding(.horizontal, 8)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .accessibilityIdentifier("editor.assistant.compactComposer")
            .transaction { transaction in if reduceMotion { transaction.disablesAnimations = true } }
    }

    private var compactContextPill: some View {
        Button { inspectCurrentRequestContext() } label: {
            HStack(spacing: 6) {
                Image(systemName: "scope")
                VStack(alignment: .leading, spacing: 2) {
                    Text(contextLabel).font(.caption.weight(.medium)).lineLimit(1)
                    Text(requestStatusLabel).font(.caption2).foregroundStyle(NativeEditorStyle.muted).lineLimit(1)
                }
            }
                .frame(minWidth: 44, maxWidth: .infinity, minHeight: actionHeight, alignment: .leading)
                .padding(.horizontal, 8).contentShape(Rectangle())
        }.buttonStyle(.plain)
            .foregroundStyle(NativeEditorStyle.accent)
            .background(model.selectedIDs.isEmpty ? NativeEditorStyle.background : NativeEditorStyle.selectionFill, in: RoundedRectangle(cornerRadius: 6))
            .overlay { RoundedRectangle(cornerRadius: 6).stroke(model.selectedIDs.isEmpty ? NativeEditorStyle.line : NativeEditorStyle.accent.opacity(0.3)) }
            .disabled(model.project == nil || model.renderPreviewBackendID == nil)
            .accessibilityLabel("Inspect current request context: \(contextLabel)")
            .accessibilityValue(requestStatusLabel)
            .accessibilityHint("Preview the selection and time. Send captures the current context again.")
            .accessibilityIdentifier("editor.assistant.composerContext")
    }

    private var compactInputMenu: some View {
        Menu {
            Picker("Request input", selection: $model.assistantInputKind) {
                Text("Prompt").tag("prompt")
                Text("Script").tag("script")
                Text("Screenplay").tag("screenplay")
            }
            Divider()
            Button("Import a text script…", systemImage: "doc.badge.plus") { requestScriptImport() }
                .disabled(scriptImportContext != nil || model.renderPreviewBackendID == nil || model.folder == nil)
            if let reference = model.lookReference {
                Section("Look reference") {
                    Text((reference as NSString).lastPathComponent)
                    Button("Remove look reference") { model.lookReference = nil }
                }
            }
        } label: {
            Label(model.assistantInputKind == "screenplay" ? "Screenplay" : model.assistantInputKind == "script" ? "Script" : "Prompt", systemImage: "paperclip")
                .font(.caption.weight(.medium)).lineLimit(1)
                .frame(minWidth: 44, minHeight: actionHeight).padding(.horizontal, 8)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Request input and script attachment")
        .accessibilityValue(model.assistantInputKind + (model.lookReference == nil ? "" : ", look reference attached"))
        .accessibilityIdentifier("editor.assistant.inputAttachments")
    }
    #endif

    private var requestStatusLabel: String {
        assistant.state == "cancelling" ? "Stopping" : assistant.isWorking ? "Working" : assistant.state == "done" ? "Response finished" : assistant.state == "cancelled" ? "Stopped" : assistant.state == "error" ? "Failed" : assistant.configured ? "Ready" : "Setup needed"
    }

    private func inspectCurrentContext() {
        guard let selection = NativeSelectionAIContext.make(project: model.project?.fields ?? [:], clipID: model.selectedID, clipIDs: model.selectedIDs, composition: model.composition, time: model.time, version: model.version, folder: model.folder?.standardizedFileURL.path) else {
            model.status = "The source selection is unavailable or too large. Select fewer layers before inspecting."
            return
        }
        var refs = selection.refs
        refs["inputKind"] = model.assistantInputKind
        if let reference = model.lookReference { refs["reference"] = reference }
        inspectedReferences = NativeAssistantReferenceInspection(text: JSON(any: refs).text, title: "Current source context",
            note: "This preview captures the selection and time when opened. Send uses the current selection and time, plus project context allowed by AI sharing.")
    }

    private func invalidateScriptImport() {
        scriptImportContext = nil
        scriptImportRequestID = nil
    }

    private func scriptImportOwnsPresentation(_ context: NativeScriptImportContext) -> Bool {
        scriptImportContext?.id == context.id && scriptImportRequestID == context.id
    }

    private func readScriptImport(_ context: NativeScriptImportContext, _ result: Result<[URL], Error>) {
        guard scriptImportOwnsPresentation(context) else { return }
        scriptImportContext = nil
        guard scriptImportIsCurrent(context) else { finishScriptImport(context); return }
        model.perform {
            defer { finishScriptImport(context) }
            guard scriptImportIsCurrent(context) else { return }
            try Task.checkCancellation()
            guard let text = try NativeScriptImport.read(result, isCurrent: { scriptImportIsCurrent(context) }) else { return }
            guard scriptImportIsCurrent(context) else { return }
            try Task.checkCancellation()
            model.assistantDraft = text; model.assistantInputKind = model.assistantInputKind == "screenplay" ? "screenplay" : "script"
        }
    }

    private func cancelScriptImport(_ context: NativeScriptImportContext) {
        guard scriptImportOwnsPresentation(context) else { return }
        scriptImportContext = nil
        finishScriptImport(context)
    }

    private func scriptImportIsCurrent(_ context: NativeScriptImportContext) -> Bool {
        context.matches(requestID: scriptImportRequestID, contextID: model.processingContextID, backendID: model.renderPreviewBackendID, folder: model.folder, draft: model.assistantDraft, inputKind: model.assistantInputKind)
    }

    private func finishScriptImport(_ context: NativeScriptImportContext) {
        if scriptImportRequestID == context.id { scriptImportRequestID = nil }
    }
    private var assistantHeader: some View {
        HStack(spacing: 6) {
            Image(systemName: "text.bubble").foregroundStyle(NativeEditorStyle.accent)
            Text("Assistant").font(.system(size: 13, weight: .semibold)).lineLimit(1)
            Spacer(minLength: 0)
            Button { showSettings() } label: { Image(systemName: "gearshape") }
            .accessibilityLabel("Assistant account settings").help("Assistant account settings")
            if let close {
                Button(action: close) { Image(systemName: "xmark") }
                .accessibilityLabel("Close Assistant").help("Close Assistant")
            }
        }
        .buttonStyle(NativeToolbarButtonStyle()).padding(.leading, 12).padding(.trailing, 4)
    }

    #if os(iOS)
    private var composerContext: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(contextLabel, systemImage: "scope")
                .font(.caption.weight(.medium)).lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .top, spacing: 6) {
                Label(assistant.routingLabel, systemImage: assistant.routingMode == "auto" ? "arrow.triangle.branch" : "cpu")
                    .font(.caption2).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                footerTimecode
            }
        }
        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
        .background(model.selectedIDs.isEmpty ? NativeEditorStyle.background : NativeEditorStyle.selectionFill, in: RoundedRectangle(cornerRadius: 6))
        .overlay { RoundedRectangle(cornerRadius: 6).stroke(model.selectedIDs.isEmpty ? NativeEditorStyle.line : NativeEditorStyle.accent.opacity(0.3)) }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("editor.assistant.composerContext")
    }
    #endif

    #if os(macOS)
    private var desktopInputMenu: some View {
        Menu {
            Picker("Request input", selection: $model.assistantInputKind) {
                Text("Prompt").tag("prompt")
                Text("Script").tag("script")
                Text("Screenplay").tag("screenplay")
            }
            Divider()
            Button("Import a text script…", systemImage: "doc.badge.plus") { requestScriptImport() }
                .disabled(scriptImportContext != nil || model.renderPreviewBackendID == nil || model.folder == nil)
        } label: { Image(systemName: "paperclip") }
            .menuStyle(.borderlessButton).frame(width: 40, height: actionHeight)
            .help("Choose prompt, script or screenplay, or attach a text script")
            .accessibilityLabel("Request input and script attachment")
            .accessibilityValue(model.assistantInputKind)
    }

    #endif

    private func requestScriptImport() {
        guard scriptImportContext == nil,
              let context = NativeScriptImportContext(contextID: model.processingContextID, backendID: model.renderPreviewBackendID, folder: model.folder, draft: model.assistantDraft, inputKind: model.assistantInputKind) else { return }
        scriptImportContext = context
        scriptImportRequestID = context.id
    }

    private func inspectCurrentRequestContext() {
        let selection = NativeSelectionAIContext.make(project: model.project?.fields ?? [:], clipID: model.selectedID, clipIDs: model.selectedIDs, composition: model.composition, time: model.time, version: model.version, folder: model.folder?.standardizedFileURL.path)
        guard model.selectedIDs.isEmpty || selection != nil else {
            model.status = "The selection is too large or changed. Select fewer layers before inspecting its context."
            return
        }
        var refs = selection?.refs ?? ["clip": "", "clips": [], "time": model.time, "composition": model.composition ?? "main", "editableNativeObjects": true, "sourceProjectVersion": model.version]
        refs["inputKind"] = model.assistantInputKind
        if let reference = model.lookReference { refs["reference"] = reference }
        inspectedReferences = NativeAssistantReferenceInspection(text: JSON(any: refs).text, title: "Current request context")
    }

    private var canChooseClaudeDefault: Bool {
        guard assistant.accountStatusVerified, !assistant.checking, !assistant.isWorking,
              let account = assistant.providers.first(where: { $0.string("id") == "claude-code" }),
              account["installed"] as? Bool == true, account["authenticated"] as? Bool == true,
              account["adapterSupported"] as? Bool == true, account["available"] as? Bool == true else { return false }
        return !assistant.modelOptions.contains { $0.string("provider") == "claude-code" && $0.flag("isDefault") }
    }

    private var modelControls: some View {
            Menu {
                if assistant.routingSupported && !assistant.autoModels.isEmpty {
                    ForEach(NativeAssistantRoutingPolicy.priorities, id: \.self) { priority in
                        Button {
                            do { try assistant.setRouting(mode: "auto", effort: "", priority: priority) }
                            catch { model.status = error.localizedDescription }
                        } label: {
                            let title = "Auto · \(NativeAssistantRoutingPolicy.priorityLabel(priority))"
                            if assistant.routingMode == "auto" && assistant.routingPriority == priority { Label(title, systemImage: "checkmark") }
                            else { Text(title) }
                        }
                    }
                }
                if canChooseClaudeDefault {
                    Button {
                        guard canChooseClaudeDefault else { return }
                        do {
                            try assistant.selectProvider("claude-code")
                            try assistant.update(apiKey: nil, model: "")
                            try assistant.setRouting(mode: "manual", effort: "")
                        } catch { model.status = error.localizedDescription }
                    } label: {
                        if assistant.routingMode == "manual" && assistant.provider == "claude-code" && assistant.model.isEmpty {
                            Label("Claude Code default", systemImage: "checkmark")
                        } else { Text("Claude Code default") }
                    }
                }
                ForEach(Array(Set(assistant.modelOptions.map { $0.string("provider") })).sorted(), id: \.self) { provider in
                    let options = assistant.modelOptions.filter { $0.string("provider") == provider }
                    if !options.isEmpty {
                        Section(NativeAssistant.providerName(provider)) {
                            ForEach(Array(options.enumerated()), id: \.offset) { _, item in
                                Button {
                                    do { try assistant.chooseModel(item) }
                                    catch { model.status = error.localizedDescription }
                                } label: {
                                    if assistant.routingMode == "manual" && assistant.provider == item.string("provider") && assistant.model == item.string("id") {
                                        Label(item.string("name", item.string("id")), systemImage: "checkmark")
                                    } else { Text(item.string("name", item.string("id"))) }
                                }
                            }
                        }
                    }
                }
                if assistant.routingMode == "auto" {
                    Button("Use \(assistant.providerName) manually") {
                        do { try assistant.setRouting(mode: "manual", effort: "") }
                        catch { model.status = error.localizedDescription }
                    }
                }
                Divider()
                Button("Accounts and Auto model pool…") { showSettings() }
                Button(assistant.checking ? "Checking accounts…" : "Retry account and model check") {
                    Task { await refreshAccountsIfIdle(userInitiated: true) }
                }.disabled(assistant.checking || assistant.endpoint.isEmpty)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: assistant.routingMode == "auto" ? "arrow.triangle.branch" : "cpu")
                    Text(assistant.routingLabel).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up.chevron.down").font(.caption)
                }.font(.caption.weight(.medium)).padding(.horizontal, 6)
                    .frame(minWidth: 0, maxWidth: .infinity, minHeight: actionHeight, alignment: .leading)
            }
            #if os(macOS)
            .menuStyle(.borderlessButton)
            #endif
            .disabled(assistant.isWorking)
                .accessibilityLabel("Assistant model, \(assistant.routingLabel)")
    }

    private var routeSummary: some View {
        let route = assistant.route
        let title = route.string("modelName", route.string("model", "Provider default"))
        let provider = NativeAssistant.providerName(route.string("provider", assistant.provider))
        let effort = route.string("effort")
        return DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
                Text(route.string("rationale", "The companion selected this route for the request."))
                    .fixedSize(horizontal: false, vertical: true)
                Text("This is the requested model. The CLI has not reported an executed model identifier.")
                    .foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
                if !effort.isEmpty { Text("Advertised reasoning effort: \(effort)") }
                let scope = route.string("scope")
                if !scope.isEmpty { Text(scope).foregroundStyle(NativeEditorStyle.muted) }
                let billing = route.dictionary("billing")
                Text(billing.string("note", "Exact price and remaining usage are not reported by this provider."))
                    .foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            }.font(.caption).padding(.vertical, 5)
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(assistant.isWorking ? "Requested model" : "Last request · requested model").foregroundStyle(NativeEditorStyle.muted)
                Text("\(provider) · \(title)").fixedSize(horizontal: false, vertical: true)
            }.font(.caption).frame(minHeight: 44, alignment: .leading)
        }
    }

    private func refreshAccountsIfIdle(userInitiated: Bool = false) async {
        guard !assistant.isWorking, !assistant.checking, !assistant.endpoint.isEmpty, !Task.isCancelled else { return }
        #if os(macOS)
        if userInitiated { await assistant.checkSavedConnection() }
        else { await assistant.refreshStatus(refresh: true) }
        #else
        await assistant.refreshStatus(refresh: true)
        #endif
    }

    private var runActivity: some View {
        TimelineView(.animation(minimumInterval: 1, paused: !assistant.isWorking)) { context in
            let working = assistant.isWorking
            let label = assistant.state == "cancelling" ? "Stopping" : working ? "Working" : assistant.state == "done" ? "Response finished" : assistant.state == "cancelled" ? "Stopped" : "Failed"
            let seconds = Int(max(0, (assistant.finishedAt ?? context.date).timeIntervalSince(assistant.startedAt ?? context.date)))
            let elapsed = seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
            let quiet = working && context.date.timeIntervalSince(assistant.updatedAt ?? context.date) >= 20
            let detail = working ? quiet ? "No update for 20 seconds. Last confirmed stage: \(assistant.progress.isEmpty ? "Working" : assistant.progress)." : assistant.progress.isEmpty ? "Thinking about your request" : assistant.progress : assistant.state == "done" ? assistant.outcome.isEmpty ? "Edit results have not been verified." : assistant.outcome : assistant.state == "cancelled" ? "Stopped. Review or undo any committed edits." : assistant.progress.isEmpty ? "Request failed. Review the error before retrying." : assistant.progress
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if working { ProgressView().controlSize(.small) }
                    else { Image(systemName: assistant.state == "done" ? "text.bubble" : assistant.state == "cancelled" ? "stop.circle" : "exclamationmark.circle") }
                    Text(label).fontWeight(.semibold)
                    Spacer(minLength: 0)
                    Text(elapsed).monospacedDigit().foregroundStyle(NativeEditorStyle.muted)
                }.accessibilityElement(children: .combine)
                Text(detail).foregroundStyle(NativeEditorStyle.muted).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true).accessibilityLabel(detail)
            }.font(.system(size: activityFontSize)).frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                .padding(10).background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 6))
                .accessibilityElement(children: .contain).accessibilityLabel("Current request status")
        }
    }

    private var footerTimecode: some View {
        Text(nativeTimecode(model.time, fps: model.fps))
            .font(.system(size: 11, design: .monospaced)).foregroundStyle(NativeEditorStyle.muted).monospacedDigit()
    }

    @ViewBuilder private var cancelButton: some View {
        if assistant.isWorking {
            Button(assistant.state == "cancelling" ? "Stopping…" : "Stop request") { assistant.cancel() }.disabled(assistant.state == "cancelling").controlSize(.small).frame(minHeight: actionHeight)
        }
    }

    private var canSendDraft: Bool {
        assistant.configured && !assistant.isWorking && (assistant.applyingProposal.map { $0.finished } ?? true) && !model.assistantDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.assistantDraft.count <= assistant.inputCharacterLimit
    }

    private func sendDraft() {
        do {
            let selection = NativeSelectionAIContext.make(project: model.project?.fields ?? [:], clipID: model.selectedID, clipIDs: model.selectedIDs, composition: model.composition, time: model.time, version: model.version, folder: model.folder?.standardizedFileURL.path)
            guard model.selectedIDs.isEmpty || selection != nil else { throw ReelBackend.APIError("The selection is too large or changed. Select fewer layers before sending.") }
            var refs = selection?.refs ?? ["clip": "", "clips": [], "time": model.time, "composition": model.composition ?? "main", "editableNativeObjects": true, "sourceProjectVersion": model.version]
            refs["inputKind"] = model.assistantInputKind
            if let reference = model.lookReference { refs["reference"] = reference }
            try assistant.send(model.assistantDraft, refs: refs); model.assistantDraft = ""
        } catch { model.status = error.localizedDescription; if assistant.sharingReview != nil { reviewingSharing = true } }
    }

    private var sendButton: some View {
        Button("Send") { sendDraft() }.buttonStyle(.borderedProminent).controlSize(.regular)
        .disabled(!assistant.configured || assistant.isWorking || model.assistantDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.assistantDraft.count > assistant.inputCharacterLimit)
        .accessibilityHint(draftLimitExplanation)
            .frame(minHeight: actionHeight)
    }

    private func footerActionViewport(height: Double, stacked: Bool, compactInput: Bool = false) -> some View {
        ScrollView(.vertical) {
            footerActions(stacked: stacked, compactInput: compactInput)
                .frame(minWidth: 0, maxWidth: .infinity)
                .padding(.vertical, 8)
        }.frame(height: height)
    }

    private var draftLimitExplanation: String {
        let count = model.assistantDraft.count
        let limit = assistant.inputCharacterLimit
        let overage = max(0, count - limit)
        if overage > 0 {
            return "Too long to send: \(count) of \(limit) characters. Remove \(overage) character\(overage == 1 ? "" : "s") to send."
        }
        return "\(count) of \(limit) characters."
    }

    @ViewBuilder private var draftLimitNotice: some View {
        if model.assistantDraft.count > assistant.inputCharacterLimit {
            Text(draftLimitExplanation)
                .font(.caption).foregroundStyle(NativeEditorStyle.error)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func footerActions(stacked: Bool, compactInput: Bool = false) -> some View {
        if stacked {
            VStack(spacing: 8) {
                HStack {
                    Spacer(minLength: 0)
                    if assistant.isWorking { cancelButton } else { sendButton }
                }
                if !assistant.isWorking { draftLimitNotice }
                #if os(macOS)
                HStack(spacing: 6) { desktopInputMenu; modelControls }
                #else
                HStack(spacing: 6) {
                    if compactInput { compactInputMenu }
                    modelControls
                }
                #endif
            }.frame(maxWidth: .infinity)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    #if os(macOS)
                    desktopInputMenu
                    #else
                    if compactInput { compactInputMenu }
                    #endif
                    modelControls
                    if assistant.isWorking { cancelButton } else { sendButton }
                }
                if !assistant.isWorking { draftLimitNotice }
            }
        }
    }

    private var inputPicker: some View {
        Picker("Input", selection: $model.assistantInputKind) {
            Text("Prompt").tag("prompt"); Text("Script").tag("script"); Text("Screenplay").tag("screenplay")
        }.labelsHidden().frame(minWidth: 0, maxWidth: .infinity).accessibilityLabel("Assistant input type")
    }

    private var contextLabel: String {
        if model.selectedIDs.count > 1 { return "\(model.selectedIDs.count) selected clips" }
        if let clip = model.selected { return "Selected clip: \(clip.name)" }
        if let composition = model.project?.compositions.first(where: { $0.id == model.composition }) { return "Composition: \(composition.name)" }
        return "Main timeline: \(model.project?.name ?? "Opening project")"
    }

    private func showSettings() {
        if let openSettings { openSettings() }
        else { settings = true }
    }

    private func receiptRow(_ receipt: NativeChangeReceipt) -> some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(receipt.scopes.enumerated()), id: \.offset) { _, scope in
                    VStack(alignment: .leading, spacing: 5) {
                        Text("\(scope.name) · \(scope.status)").font(.system(size: 11, weight: .medium))
                        if let comp = scope.composition { Text(comp).font(.system(size: 10, design: .monospaced)).foregroundStyle(NativeEditorStyle.muted) }
                        receiptChanges(scope.changes)
                    }
                }
                ForEach(receipt.clips) { clip in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(clip.name).font(.system(size: 12, weight: .medium))
                        Text("\(clip.compositionName) · \(clip.clipID) · \(clip.status)")
                            .font(.system(size: 10)).foregroundStyle(NativeEditorStyle.muted).textSelection(.enabled)
                        receiptChanges(clip.changes)
                        if clip.status != "deleted" {
                            Button("Select changed object") { model.selectReceiptClip(clip) }.controlSize(.small)
                                .disabled(model.receiptSelection(clip) == nil)
                                .accessibilityLabel("Select \(clip.name) in \(clip.compositionName)")
                        }
                    }
                    Rectangle().fill(NativeEditorStyle.line).frame(height: 1)
                }
                if receipt.truncated {
                    Text("Some changes or values are shortened. Showing \(receipt.clips.count) of \(receipt.totalClips) changed objects and \(receipt.scopes.count) of \(receipt.totalScopes) changed \(receipt.hasAssetChanges ? "Media and settings" : "settings") groups.")
                        .font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted)
                }
                Button("Inspect JSON diff") { inspectedReceipt = receipt }.controlSize(.small)
            }.padding(.top, 8)
        } label: {
            Text("Edit \(receipt.version) · \(receipt.summary)")
                .font(.system(size: 11, weight: .medium))
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 6))
    }

    private func receiptChanges(_ changes: [NativeChangeReceipt.Change]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(changes.enumerated()), id: \.offset) { _, change in
                VStack(alignment: .leading, spacing: 2) {
                    Text(change.property).font(.system(size: 10, weight: .medium, design: .monospaced))
                    Text("Before: \(change.before)\nAfter: \(change.after)")
                        .font(.system(size: 10, design: .monospaced)).foregroundStyle(NativeEditorStyle.muted)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

private struct NativeAssistantReferenceInspection: Identifiable {
    let id = UUID()
    let text: String
    let title: String
    let note: String?

    init(text: String, title: String = "Attached source context", note: String? = nil) {
        self.text = text; self.title = title; self.note = note
    }
}


// BEGIN ASSISTANT PREVIEW CARDS
/// A proposed change before it applies: the layers it changes, the processing it runs, Apply and Discard.
private struct NativeAssistantPreviewCard: View {
    let proposal: NativeAssistantProposal
    let stale: Bool
    let running: Bool
    let newRequest: Bool
    let apply: () -> Void
    let discard: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Preview").font(.caption).foregroundStyle(NativeEditorStyle.muted)
            Text(proposal.summary.isEmpty ? "\(proposal.ops.count) edits" : proposal.summary).font(.system(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
            if !proposal.replaced.isEmpty { note("Replaces the earlier preview: \(proposal.replaced).") }
            if newRequest && !stale { note("The assistant is working on a new request. This preview stays until that request makes its own.") }
            if stale { note("The project changed after this preview. Ask again for a current one.").foregroundStyle(NativeEditorStyle.error) }
            else { note(headline) }
            if let receipt = proposal.receipt, !stale {
                ForEach(Array(receipt.clips.prefix(6).enumerated()), id: \.offset) { _, clip in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(proposal.names[clip.clipID] ?? clip.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
                            Text(clip.status == "added" ? "New" : clip.status == "deleted" ? "Removed" : "Changed").font(.caption2).foregroundStyle(NativeEditorStyle.muted)
                            Text("\(clip.compositionName) · \(clip.clipID)").font(.caption2).foregroundStyle(NativeEditorStyle.muted).lineLimit(1)
                        }
                        if clip.status == "changed" {
                            let changes = clip.changes.flatMap(Self.readable)
                            ForEach(Array(changes.prefix(4).enumerated()), id: \.offset) { _, change in
                                Text("\(change.property): \(change.before) → \(change.after)").font(.system(size: 10.5, design: .monospaced)).lineLimit(2)
                            }
                            if changes.count > 4 { note("\(changes.count - 4) more properties") }
                        }
                    }.padding(6).frame(maxWidth: .infinity, alignment: .leading)
                    .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 6))
                }
                if receipt.clips.count > 6 { note("\(receipt.clips.count - 6) more layers change.") }
            }
            if !stale {
                ForEach(Array(proposal.previews.enumerated()), id: \.offset) { index, step in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(index + 1). \(step["title"] ?? "")").font(.system(size: 12, weight: .medium))
                        Text("Produces: \(step["produces"] ?? "")").font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
                        Text("Lands: \(step["lands"] ?? "")").font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            HStack(spacing: 8) {
                Button("Apply", action: apply).buttonStyle(.borderedProminent).frame(minHeight: 44).disabled(stale || running)
                    .help(running ? "Wait for the assistant to finish" : "Apply these edits as one undoable change")
                    .accessibilityIdentifier("editor.assistant.applyPreview")
                Button("Discard", action: discard).frame(minHeight: 44)
            }
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).stroke(NativeEditorStyle.line) }
        .accessibilityElement(children: .contain).accessibilityLabel("Preview of proposed changes")
        .accessibilityIdentifier("editor.assistant.preview")
    }

    private var headline: String {
        let layers = proposal.receipt?.totalClips ?? 0, steps = proposal.steps.count
        let parts = [layers > 0 ? "changes \(layers) layer\(layers == 1 ? "" : "s")" : "", steps > 0 ? "runs \(steps) processing step\(steps == 1 ? "" : "s")" : ""].filter { !$0.isEmpty }
        return "Apply \(parts.isEmpty ? "changes settings" : parts.joined(separator: ", ")). Nothing has changed yet\(steps > 0 ? " and nothing renders until you apply" : "")."
    }

    private func note(_ text: String) -> Text { Text(text).font(.caption).foregroundStyle(NativeEditorStyle.muted) }

    /// grade.exposure: Absent → 0.3 instead of /grade: Absent → {"exposure":0.2999…}.
    static func readable(_ change: NativeChangeReceipt.Change) -> [(property: String, before: String, after: String)] {
        let property = change.property.split(separator: "/").joined(separator: ".")
        if change.before == "Absent", let data = change.after.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return object.keys.sorted().map { key in (property: "\(property).\(key)", before: "Absent", after: value(object[key] as Any)) }
        }
        return [(property: property, before: change.before, after: change.after)]
    }

    private static func value(_ item: Any) -> String {
        if let number = item as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() { return String(format: "%g", number.doubleValue) }
        if let text = item as? String { return "\"\(text)\"" }
        if let data = try? JSONSerialization.data(withJSONObject: item, options: [.fragmentsAllowed]), let text = String(data: data, encoding: .utf8) { return text }
        return "\(item)"
    }
}

/// A preview being applied, step by step, or the step that stopped it.
private struct NativeAssistantApplyingCard: View {
    let applying: NativeAssistantApplying
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(applying.error.isEmpty ? "Applying the preview" : "Preview stopped").font(.caption).foregroundStyle(NativeEditorStyle.muted)
            Text(applying.summary.isEmpty ? "Assistant preview" : applying.summary).font(.system(size: 12, weight: .semibold))
            if applying.error.isEmpty {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(applying.index >= 0 ? "Step \(applying.index + 1) of \(applying.total): \(applying.title)" : "Applying the edits").font(.caption)
                }
                Text("Wait for it to finish before editing: a change to the project now stops this step before its result lands.")
                    .font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(applying.error).font(.caption).foregroundStyle(NativeEditorStyle.error).fixedSize(horizontal: false, vertical: true)
                Text("Edits made before the failure stay in the project. Use Undo this change to remove them together.").font(.caption).foregroundStyle(NativeEditorStyle.muted)
                Button("Dismiss", action: dismiss).controlSize(.small).frame(minHeight: 44)
            }
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain).accessibilityLabel("Applying the preview")
    }
}
// END ASSISTANT PREVIEW CARDS
