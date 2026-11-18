import ReelKit
import SwiftUI
import UniformTypeIdentifiers

enum NativeAssistantLayout {
    struct Regions {
        let header: Double
        let history: Double
        let context: Double
        let editor: Double
        let actions: Double
        let separator: Double
    }

    /// Large text or a narrow pane puts Send or Stop on its own row, above the model menu.
    static func stackedActions(width: Double, actionHeight: Double, accessibilityText: Bool) -> Bool {
        accessibilityText || !width.isFinite || width < 300 * max(1, actionHeight / 44)
    }

    /// The composer's action rows, their spacing, the scroll content's vertical padding and
    /// the inset of the field's border.
    static func actionBudget(actionHeight: Double, stacked: Bool) -> Double {
        let actionHeight = actionHeight.isFinite ? max(0, actionHeight) : 0
        return actionHeight * (stacked ? 2 : 1) + (stacked ? 8 : 0) + 20
    }

    /// The draft grows with its lines, from two lines to about seven, then scrolls.
    static func preferredEditorHeight(text: String, width: Double, lineHeight: Double) -> Double {
        let lineHeight = lineHeight.isFinite ? max(10, lineHeight) : 17
        let width = width.isFinite ? max(40, width) : 240
        let perLine = max(8, width / (lineHeight * 0.5))
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            .reduce(0.0) { $0 + max(1, (Double($1.count) / perLine).rounded(.up)) }
        return min(lineHeight * 7 + 24, max(lineHeight * 2 + 24, lines * lineHeight + 24))
    }

    /// Send and Stop are reserved first so they stay reachable, then the context chips and the
    /// draft. History takes the rest. Every region scrolls inside its own bounds, so the parts
    /// always add up to the pane height and a run starting or ending never moves the composer.
    static func regions(height: Double, header: Double, actions: Double, context: Double, preferredEditor: Double) -> Regions {
        func clean(_ value: Double) -> Double { value.isFinite ? max(0, value) : 0 }
        let height = clean(height)
        let header = min(height, clean(header))
        let separator = min(1, (height - header) / 2)
        let body = height - header - 2 * separator
        // Leave history and the draft usable before the actions take their full rows.
        let retained = min(120, body * 0.55)
        let actions = min(clean(actions), body - retained)
        var rest = body - actions
        // The chips get their full row while history and the draft keep 180 points between
        // them. In a shorter pane they take a quarter and scroll.
        let context = min(clean(context), max(rest * 0.25, rest - 180))
        rest -= context
        let editor = min(max(44, clean(preferredEditor)), rest * 0.6)
        return Regions(header: header, history: rest - editor, context: context, editor: editor, actions: actions, separator: separator)
    }
}

/// The one labelled way into the assistant: it reads like the start of a request and shows
/// whether the assistant is ready, working or still needs setup.
struct NativeAssistantEntry: View {
    @ObservedObject var assistant: NativeAssistant
    let open: Bool
    /// A phone header: a 44-point target and no status text beside the label.
    var phone = false
    /// Wide Mac windows show the keyboard shortcut inside the control.
    var shortcut = false
    let action: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// At accessibility text sizes a phone header has no room for the label, so the entry
    /// keeps only its icon. VoiceOver still reads "Ask Arya".
    private var showsLabel: Bool { !(phone && dynamicTypeSize.isAccessibilitySize) }

    private var statusText: String { assistant.statusWord }
    private var dot: Color { assistant.statusColor }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if assistant.isWorking {
                    ProgressView().controlSize(.small).frame(width: 16, height: 16)
                } else {
                    Image(systemName: "text.bubble").overlay(alignment: .topTrailing) {
                        Circle().fill(dot).frame(width: 6, height: 6)
                            .overlay { Circle().stroke(NativeEditorStyle.background, lineWidth: 1) }
                            .offset(x: 3, y: -2)
                    }
                }
                if showsLabel { Text("Ask Arya").fontWeight(.medium).lineLimit(1).fixedSize() }
                if !phone && statusText != "Ready" {
                    Text(statusText).font(.caption).foregroundStyle(NativeEditorStyle.muted).lineLimit(1).fixedSize()
                }
                if shortcut {
                    Text("⌥⌘A").font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize()
                }
            }
            .padding(.horizontal, phone ? 12 : 10)
            .frame(minHeight: phone ? 44 : 30)
            .background(Capsule().fill(open ? NativeEditorStyle.selectionFill : NativeEditorStyle.background))
            .overlay { Capsule().stroke(open ? NativeEditorStyle.accent.opacity(0.55) : NativeEditorStyle.line) }
            .foregroundStyle(open ? NativeEditorStyle.accent : NativeEditorStyle.text)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Ask Arya")
        .accessibilityValue("\(open ? "Open" : "Closed"), \(statusText)")
        .accessibilityHint("Opens the assistant with the request field ready.")
        .help(open ? "Hide the assistant (⌥⌘A)" : "Ask Arya to edit or explain (⌥⌘A)")
    }
}

/// The assistant's state in a word and a colour. The Ask Arya entry and the panel header both
/// read these, so the two never disagree.
extension NativeAssistant {
    var statusWord: String {
        if state == "cancelling" { return "Stopping" }
        if isWorking { return "Working" }
        if state == "error" { return "Failed" }
        if proposal != nil { return "Preview ready" }
        if !configured { return checking ? "Checking" : "Not set up" }
        return "Ready"
    }

    var statusColor: Color {
        if isWorking || (state != "error" && proposal != nil) { return NativeEditorStyle.accent }
        if state == "error" { return NativeEditorStyle.error }
        return configured ? NativeEditorStyle.success : NativeEditorStyle.muted
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
    @ObservedObject private var chatGPT = NativeChatGPTAccount.shared
    var openSettings: (() -> Void)?
    var close: (() -> Void)?
    /// Set by the Ask Arya entry. The panel focuses the draft once and clears it, so restoring a
    /// saved layout or a programmatic page change never takes the keyboard.
    var focusRequest: Binding<Bool> = .constant(false)
    /// Presented as the phone sheet, whose navigation bar carries the title and settings.
    var inSheet = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #endif
    @FocusState private var draftFocused: Bool
    /// Decides when the actions stack. It grows faster than the drawn rows on purpose.
    @ScaledMetric(relativeTo: .body) private var scaledActionHeight = 44.0
    /// One line of body text. A button is that line plus 14 points of padding, so the rows are
    /// budgeted from the control that is drawn and leave no empty band at large text sizes.
    @ScaledMetric(relativeTo: .body) private var scaledActionLine = 21.0
    private var actionHeight: Double { max(44, scaledActionLine + 14) }
    @ScaledMetric(relativeTo: .caption) private var activityFontSize = 11.0
    @ScaledMetric(relativeTo: .caption) private var scaledChipHeight = 26.0
    @ScaledMetric(relativeTo: .body) private var editorLineHeight = Self.touch ? 22.0 : 17.0
    @State private var reviewingSharing = false
    @State private var settings = false
    @State private var scriptImportContext: NativeScriptImportContext?
    @State private var scriptImportRequestID: UUID?
    @State private var inspectedReceipt: NativeChangeReceipt?
    @State private var inspectedReferences: NativeAssistantReferenceInspection?
    @State private var activityExpanded = false
    /// Counts the times the run line grew a second line, so the history can keep it in view.
    @State private var runLineGrowth = 0
    @State private var signingIn = false
    @State private var setupNotice: String?
    /// The wrapped placeholder with its padding, measured at the draft's width.
    @State private var placeholderHeight = 0.0
    /// The history's height, the times it got shorter while the latest item was in view, and
    /// where the setup card, the preview and the end sit in the visible history.
    @State private var historyHeight = 0.0
    @State private var historyShrinks = 0
    @State private var latestSpans: [String: ClosedRange<Double>] = [:]

    private var chipHeight: Double { max(Self.touch ? 44 : 26, scaledChipHeight) }
    private var headerHeight: Double { max(Double(NativeEditorStyle.minimumControlHeight), Self.touch ? actionHeight : 0) }

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let stacked = NativeAssistantLayout.stackedActions(width: width, actionHeight: max(44, scaledActionHeight), accessibilityText: dynamicTypeSize.isAccessibilitySize)
            let regions = NativeAssistantLayout.regions(height: geometry.size.height, header: inSheet ? 0 : headerHeight,
                actions: NativeAssistantLayout.actionBudget(actionHeight: actionHeight, stacked: stacked),
                context: chipHeight + 18,
                // An empty draft is at least as tall as its wrapped placeholder, so large text never cuts it.
                preferredEditor: max(model.assistantDraft.isEmpty ? placeholderHeight : 0,
                    NativeAssistantLayout.preferredEditorHeight(text: model.assistantDraft, width: width - 40, lineHeight: editorLineHeight)))
            VStack(alignment: .leading, spacing: 0) {
                if regions.header > 0 {
                    assistantHeader.frame(height: regions.header).clipped()
                }
                Rectangle().fill(NativeEditorStyle.line).frame(height: regions.separator)
                conversationScroll.frame(height: regions.history)
                Rectangle().fill(NativeEditorStyle.line).frame(height: regions.separator)
                composer(width: width, regions: regions, stacked: stacked)
            }.frame(width: width, height: geometry.size.height, alignment: .topLeading)
        }
        .foregroundStyle(NativeEditorStyle.text).tint(NativeEditorStyle.accent)
        .background(NativeEditorStyle.panel)
        #if os(iOS)
        .transaction { transaction in if reduceMotion { transaction.disablesAnimations = true } }
        .toolbar {
            if inSheet {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showSettings() } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Assistant account settings")
                }
            }
        }
        .navigationBarTitleDisplayMode(inSheet ? .inline : .automatic)
        #endif
        .onAppear { takeFocusRequest() }
        .onChange(of: focusRequest.wrappedValue) { _, requested in if requested { takeFocusRequest() } }
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

    private func takeFocusRequest() {
        guard focusRequest.wrappedValue else { return }
        focusRequest.wrappedValue = false
        // A phone keeps the viewer above the medium sheet, so the keyboard waits for a tap there.
        #if os(iOS)
        if horizontalSizeClass == .compact { return }
        #endif
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(150))
            draftFocused = true
        }
    }

    private var assistantHeader: some View {
        HStack(spacing: 8) {
            Image(systemName: "text.bubble").foregroundStyle(NativeEditorStyle.accent)
            Text("Assistant").font(.system(size: 13, weight: .semibold)).lineLimit(1)
            HStack(spacing: 4) {
                Circle().fill(assistant.statusColor).frame(width: 6, height: 6)
                Text(assistant.statusWord).font(.caption).foregroundStyle(NativeEditorStyle.muted).lineLimit(1)
            }.accessibilityElement(children: .combine)
            Spacer(minLength: 0)
            Button { showSettings() } label: { Image(systemName: "gearshape") }
                .accessibilityLabel("Assistant account settings").help("Assistant settings")
            if let close {
                Button(action: close) { Image(systemName: "xmark") }
                    .accessibilityLabel("Close Assistant").help("Close Assistant (⌥⌘A)")
            }
        }
        .buttonStyle(NativeToolbarButtonStyle()).padding(.leading, 12).padding(.trailing, 4)
    }

    // MARK: History

    private var conversationScroll: some View {
        ScrollViewReader { proxy in
            ScrollView {
                conversationContent.padding(12)
            }.frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity)
            .coordinateSpace(.named(Self.historySpace))
            #if os(iOS)
            .scrollDismissesKeyboard(.interactively)
            #endif
            .onAppear { scrollToLatest(proxy) }
            .onChange(of: assistant.state) { _, _ in scrollToLatest(proxy) }
            .onChange(of: assistant.partialReply) { _, _ in if assistant.isWorking { proxy.scrollTo("end", anchor: .bottom) } }
            .onChange(of: assistant.chat.count) { _, _ in scrollToLatest(proxy) }
            .onChange(of: model.changeReceipts.count) { _, _ in scrollToLatest(proxy) }
            .onChange(of: assistant.proposal?.id) { _, _ in scrollToLatest(proxy) }
            .onChange(of: runLineGrowth) { _, _ in scrollToLatest(proxy) }
            #if DEBUG
            .onChange(of: assistant.fixtureScroll) { _, _ in scrollToLatest(proxy) }
            #endif
            // The keyboard, a smaller sheet detent or window, or a longer draft makes the history
            // shorter. If the setup card, a waiting preview or the newest message was in view, it
            // is brought back into view once the height settles. Someone reading earlier messages
            // is left where they are, and a taller history needs no scroll. Scrolling never
            // changes the height, so this cannot loop. An empty chat has nothing below its
            // opening sentence to bring back, so it keeps that sentence at the top.
            .onGeometryChange(for: Double.self) { $0.size.height } action: { height in
                let emptyChat = assistant.chat.isEmpty && assistant.configured && assistant.proposal == nil
                if height < historyHeight - 1, !emptyChat, let span = latestSpans[latestTarget],
                   span.upperBound >= -1, span.lowerBound <= historyHeight + 1 { historyShrinks += 1 }
                historyHeight = height
            }
            .task(id: historyShrinks) {
                guard historyShrinks > 0 else { return }
                try? await Task.sleep(for: .milliseconds(150))
                if !Task.isCancelled { scrollToLatest(proxy) }
            }
        }
    }

    /// A preview that is waiting keeps Apply and Discard in view, even with an earlier result
    /// card below it. While the assistant is not set up, the setup card is the thing to read, so
    /// keep its heading, reason and primary action in view. In a short phone sheet, scrolling to
    /// the end would hide them, with or without earlier messages.
    private func scrollToLatest(_ proxy: ScrollViewProxy) {
        proxy.scrollTo(latestTarget, anchor: latestTarget == "setup" ? .top : .bottom)
    }

    private var latestTarget: String {
        if assistant.proposal != nil && !assistant.isWorking { return "preview" }
        return assistant.configured ? "end" : "setup"
    }

    fileprivate static let historySpace = "editor.assistant.history"

    /// Records where a scroll target sits in the visible history.
    private func latestSpan(_ id: String) -> some ViewModifier {
        LatestSpan { latestSpans[id] = $0 }
    }

    private var conversationContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !assistant.configured && assistant.chat.isEmpty { setupCard.id("setup").modifier(latestSpan("setup")) }
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
            // Suggestions wait until the assistant can take them, so the setup card stays calm.
            if assistant.chat.isEmpty && assistant.configured { emptyState }
            ForEach(Array(assistant.chat.enumerated()), id: \.offset) { index, message in
                messageRow((try? JSON.parse(message.text) as? [String: Any]) ?? [:]).id(index)
            }
            if assistant.isWorking && !assistant.partialReply.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Writing…").font(.caption).foregroundStyle(NativeEditorStyle.muted)
                    Text(assistant.partialReply).font(.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine).accessibilityLabel("Reply in progress: \(assistant.partialReply)")
                .id("stream")
            }
            if assistant.startedAt != nil { runActivity.id("progress") }
            if assistant.state == "error", let request = lastRequest {
                Button { editRequest(request) } label: {
                    Text("Edit and retry").font(.caption).frame(minHeight: Self.touch ? 44 : 20).contentShape(Rectangle())
                }.buttonStyle(.plain).foregroundStyle(NativeEditorStyle.accent)
                    .disabled(!model.assistantDraft.isEmpty)
                    .help("Put the failed request back in the draft. Clear the current draft first.")
            }
            changeCards
            // After a conversation the reason Send is off sits last, and the history scrolls to its top.
            if !assistant.configured && !assistant.chat.isEmpty { setupCard.id("setup").modifier(latestSpan("setup")) }
            Color.clear.frame(height: 1).id("end").modifier(latestSpan("end"))
        }.frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.selectedIDs.isEmpty ? "Ask for an edit, or ask a question about this project." : "Ask for an edit to the selection, or a question about it.")
                .font(.callout).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            // Suggestions only fill an empty draft, so one never replaces typed text.
            // Each one is sent as a prompt, not as a script or screenplay.
            if !assistant.suggestions.isEmpty && model.assistantDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(assistant.suggestions) { item in
                        Button { useSuggestion(item) } label: {
                            Label(item.label, systemImage: "arrow.turn.down.right")
                                .font(.callout).frame(maxWidth: .infinity, minHeight: Self.touch ? 44 : 30, alignment: .leading)
                                .padding(.horizontal, 10).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                            .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 7))
                            .overlay { RoundedRectangle(cornerRadius: 7).stroke(NativeEditorStyle.line) }
                            .disabled(assistant.isWorking)
                            .help(item.prompt + " It goes into the draft for you to review before sending.")
                    }
                }.accessibilityElement(children: .contain).accessibilityLabel("Suggested requests")
            }
        }.padding(.top, 4).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func useSuggestion(_ item: NativeAssistantSuggestion) {
        guard model.assistantDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        model.assistantInputKind = "prompt"; model.assistantDraft = item.prompt
        #if os(macOS)
        draftFocused = true
        #endif
    }

    @ViewBuilder private func messageRow(_ fields: [String: Any]) -> some View {
        let fromUser = ["you", "user"].contains(fields.string("role"))
        let text = fields.string("text")
        if fromUser {
            VStack(alignment: .trailing, spacing: 4) {
                Text(text).font(.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 12))
                    .overlay { RoundedRectangle(cornerRadius: 12).stroke(NativeEditorStyle.line) }
                HStack(spacing: 12) {
                    attachedContextButton(fields)
                    Button { editRequest(fields) } label: {
                        Text("Edit request").font(.caption).frame(minHeight: Self.touch ? 44 : 20).contentShape(Rectangle())
                    }.buttonStyle(.plain).foregroundStyle(NativeEditorStyle.muted)
                        .disabled(assistant.isWorking || !model.assistantDraft.isEmpty || text.isEmpty)
                        .help("Edit this request as a new draft. Clear the current draft first.")
                }
            }.frame(maxWidth: .infinity, alignment: .trailing).padding(.leading, 28)
        } else {
            let failed = fields["error"] as? Bool == true
            VStack(alignment: .leading, spacing: 4) {
                Label(fields.string("provider").isEmpty ? "Assistant" : NativeAssistant.providerName(fields.string("provider")),
                      systemImage: failed ? "exclamationmark.triangle.fill" : "text.bubble")
                    .font(.caption).foregroundStyle(failed ? NativeEditorStyle.error : NativeEditorStyle.muted)
                Text(text).font(.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder private func attachedContextButton(_ fields: [String: Any]) -> some View {
        if let refs = fields["refs"] as? [String: Any], !refs.isEmpty {
            let layers = refs.dictionary("sourceSelection")["nativeLayerIDs"] as? [String] ?? refs["clips"] as? [String] ?? []
            Button { inspectedReferences = NativeAssistantReferenceInspection(text: JSON(any: refs).text) } label: {
                Label(layers.isEmpty ? "Context" : layers.count == 1 ? "1 layer" : "\(layers.count) layers", systemImage: "paperclip")
                    .font(.caption).frame(minHeight: Self.touch ? 44 : 20).contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(NativeEditorStyle.muted)
                .accessibilityLabel(layers.isEmpty ? "Inspect attached context" : "Inspect \(layers.count) attached layer\(layers.count == 1 ? "" : "s")")
        } else if let labels = fields["refs"] as? [[String: Any]], !labels.isEmpty {
            // A request restored from saved history keeps only the labels of what it attached.
            Button { inspectedReferences = NativeAssistantReferenceInspection(text: JSON(any: labels).text) } label: {
                Label("References", systemImage: "paperclip")
                    .font(.caption).frame(minHeight: Self.touch ? 44 : 20).contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(NativeEditorStyle.muted)
                .accessibilityLabel("Inspect historical reference labels")
        }
    }

    /// The newest request in the conversation, for Edit and retry after a failed run.
    private var lastRequest: [String: Any]? {
        for message in assistant.chat.reversed() {
            let fields = (try? JSON.parse(message.text) as? [String: Any]) ?? [:]
            if ["you", "user"].contains(fields.string("role")) { return fields.string("text").isEmpty ? nil : fields }
        }
        return nil
    }

    private func editRequest(_ fields: [String: Any]) {
        guard !assistant.isWorking, model.assistantDraft.isEmpty, !fields.string("text").isEmpty else { return }
        model.assistantDraft = fields.string("text")
        let labels = fields["refs"] as? [[String: Any]] ?? []
        let kind = fields.dictionary("refs").string("inputKind", labels.first { $0.string("kind") == "input_kind" }?.string("id") ?? "prompt")
        model.assistantInputKind = ["prompt", "script", "screenplay"].contains(kind) ? kind : "prompt"
    }

    // MARK: Setup

    /// ChatGPT is the one-tap path when no other connection is set up. Otherwise the existing
    /// connection is fixed in Assistant settings.
    private var chatGPTPrimary: Bool {
        // When the Keychain refused the read, the fix is Check again in Assistant settings, not a new sign-in.
        NativeChatGPT.supported && !chatGPT.status.signedIn && chatGPT.status.storage != .unavailable
            && (assistant.provider == "chatgpt" || assistant.endpoint.isEmpty)
    }

    /// The model's first-run reasons point at Assistant settings. Beside a Continue with ChatGPT
    /// button the card says what that button does.
    private var setupReason: String {
        let pointsAtSettings = ["Choose your signed-in subscription agent in Assistant settings.",
                                "Continue with ChatGPT in Assistant settings to use your ChatGPT plan."]
        return chatGPTPrimary && pointsAtSettings.contains(assistant.reason) ? "Use your ChatGPT plan for eligible requests." : assistant.reason
    }

    private var chatGPTWaiting: Bool { chatGPT.status.phase == .waiting || chatGPT.status.phase == .exchanging }

    private var setupCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Set up the assistant").font(.callout.weight(.semibold))
            Text(setupReason).font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            if chatGPTPrimary && chatGPTWaiting {
                Label("Finish signing in on the ChatGPT page.", systemImage: "hourglass")
                    .font(.caption).fixedSize(horizontal: false, vertical: true)
            } else if chatGPTPrimary, [.failed, .cancelled, .expired].contains(chatGPT.status.phase), !chatGPT.status.message.isEmpty {
                Text(chatGPT.status.message).font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            }
            if chatGPTPrimary && !chatGPTWaiting {
                Button { startChatGPT() } label: {
                    NativeAssistantProminentLabel {
                        Text(signingIn ? "Opening ChatGPT…" : "Continue with ChatGPT").frame(maxWidth: .infinity, minHeight: Self.touch ? 30 : 20)
                    }
                }.buttonStyle(.borderedProminent).disabled(signingIn || assistant.isWorking)
                Button { showSettings() } label: {
                    Text("Other ways to connect").font(.caption).frame(minHeight: Self.touch ? 44 : 20).contentShape(Rectangle())
                }.buttonStyle(.plain).foregroundStyle(NativeEditorStyle.accent)
            } else {
                Button { showSettings() } label: {
                    NativeAssistantProminentLabel {
                        Text("Assistant settings").frame(maxWidth: .infinity, minHeight: Self.touch ? 30 : 20)
                    }
                }.buttonStyle(.borderedProminent)
            }
            if let setupNotice {
                Text(setupNotice).font(.caption).foregroundStyle(NativeEditorStyle.error).fixedSize(horizontal: false, vertical: true)
            }
            // The draft is only mentioned when there is one, as in the browser editor.
            Text(model.assistantDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Editing works without an account." : "Editing works without an account. Your draft is kept.")
                .font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).stroke(NativeEditorStyle.line) }
        .accessibilityElement(children: .contain).accessibilityLabel("Assistant setup")
    }

    /// The same sign-in Assistant settings starts. Waiting, reopening the page and cancelling stay there.
    private func startChatGPT() {
        guard !signingIn, !assistant.isWorking else { return }
        signingIn = true; setupNotice = nil
        Task { @MainActor in
            assistant.beginChatGPTChoice()
            do {
                if !(try await chatGPT.signIn()) { setupNotice = "Arya could not open the sign-in page. Try again from Assistant settings." }
            } catch {
                assistant.abandonChatGPTChoice()
                setupNotice = error.localizedDescription
            }
            signingIn = false
        }
    }

    // MARK: Run status and results

    /// One quiet line while a request runs or after it ends. Details and the route expand from it.
    private var runActivity: some View {
        TimelineView(.animation(minimumInterval: 1, paused: !assistant.isWorking)) { context in
            let working = assistant.isWorking
            let label = assistant.state == "cancelling" ? "Stopping" : working ? "Working" : assistant.state == "done" ? "Done" : assistant.state == "cancelled" ? "Stopped" : "Failed"
            let seconds = Int(max(0, (assistant.finishedAt ?? context.date).timeIntervalSince(assistant.startedAt ?? context.date)))
            let elapsed = seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
            let quiet = working && context.date.timeIntervalSince(assistant.updatedAt ?? context.date) >= 20
            let stopped = assistant.state == "cancelled"
            // A stopped request that never moved the version says so, instead of asking for a review of edits it did not make.
            let stoppedNote = assistant.lastRunEdited == false ? "Nothing was changed." : "Review or undo any committed edits."
            let stage = working ? (quiet ? "No update for 20 seconds" : assistant.progress.isEmpty ? "Thinking about your request" : assistant.progress) : assistant.state == "done" ? (assistant.outcome.isEmpty ? "Results not verified" : assistant.outcome) : stopped ? stoppedNote : ""
            let detail = working ? quiet ? "No update for 20 seconds. Last confirmed stage: \(assistant.progress.isEmpty ? "Working" : assistant.progress)." : assistant.progress.isEmpty ? "Thinking about your request" : assistant.progress : assistant.state == "done" ? assistant.outcome.isEmpty ? "Edit results have not been verified." : assistant.outcome : assistant.state == "cancelled" ? "Stopped. \(stoppedNote)" : assistant.progress.isEmpty ? "Request failed. Review the error before retrying." : assistant.progress
            DisclosureGroup(isExpanded: $activityExpanded) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(detail).foregroundStyle(NativeEditorStyle.muted).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    if !assistant.route.isEmpty { routeSummary }
                }.padding(.top, 4)
            } label: {
                // At accessibility text sizes the stage, the outcome and the stalled and stopped
                // sentences get their own line, so the state word is never broken and the sentence
                // is never cut.
                let below = dynamicTypeSize.isAccessibilitySize && !stage.isEmpty
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        // The spinner grows with the text, so at those sizes it takes the room it draws in.
                        if working && dynamicTypeSize.isAccessibilitySize { ProgressView().controlSize(.small).fixedSize() }
                        else if working { ProgressView().controlSize(.small).frame(width: 14, height: 14) }
                        else { Image(systemName: assistant.state == "done" ? "checkmark.circle" : assistant.state == "cancelled" ? "stop.circle" : "exclamationmark.circle")
                            .foregroundStyle(assistant.state == "error" ? NativeEditorStyle.error : NativeEditorStyle.muted) }
                        Text(label).fontWeight(.semibold).lineLimit(1).fixedSize()
                        if !stage.isEmpty && !below { Text(stage).foregroundStyle(NativeEditorStyle.muted).lineLimit(quiet || stopped ? 2 : 1).truncationMode(.tail).multilineTextAlignment(.leading) }
                        Spacer(minLength: 4)
                        Text(elapsed).monospacedDigit().foregroundStyle(NativeEditorStyle.muted).lineLimit(1).fixedSize()
                    }
                    if below { Text(stage).foregroundStyle(NativeEditorStyle.muted).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true) }
                }.frame(minHeight: Self.touch ? 44 : 22)
                // Fires when the line appears and again when its text gets longer or changes.
                .onChange(of: below ? stage : "") { _, text in if !text.isEmpty { runLineGrowth += 1 } }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(label), \(quiet ? detail : stage), \(elapsed)")
            }
            .font(.system(size: activityFontSize))
            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain).accessibilityLabel("Current request status")
        }
    }

    /// The pending preview, a preview being applied, and the result of the latest change.
    @ViewBuilder private var changeCards: some View {
        if let proposal = assistant.proposal {
            NativeAssistantPreviewCard(proposal: proposal, stale: assistant.proposalStale || proposal.baseVersion != model.version, running: assistant.isWorking,
                                       newRequest: assistant.isWorking && proposal.runID != assistant.currentRunID,
                                       apply: { Task { await assistant.applyProposal() } }, discard: { assistant.discardProposal() }).id("preview")
                .modifier(latestSpan("preview"))
        }
        if let applying = assistant.applyingProposal {
            NativeAssistantApplyingCard(applying: applying, dismiss: { assistant.dismissApplyFailure() })
        }
        if assistant.lastChange != nil && !assistant.isWorking && (assistant.applyingProposal.map { $0.finished } ?? true) && !assistant.canUndoLastChange(version: model.version) {
            Text("Can't undo this run: the project changed after it. Use Undo in the editor.")
                .font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
        }
        if assistant.canUndoLastChange(version: model.version) || !model.changeReceipts.isEmpty { resultCard.id("receipts") }
    }

    private var resultCard: some View {
        let undoable = assistant.lastChange.flatMap { assistant.canUndoLastChange(version: model.version) ? $0 : nil }
        let latest = model.changeReceipts.last
        let changed = (latest?.clips ?? []).filter { $0.status != "deleted" && model.receiptSelection($0) != nil }
        let title = undoable.map { $0.kind == "preview" ? "Applied the preview" : $0.kind == "history" ? ReelBackend.historyChangeTitle(moves: $0.moves) : "Made \($0.edits) edit\($0.edits == 1 ? "" : "s")" }
            ?? "Recent assistant edits"
        return VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: "checkmark.circle.fill").font(.callout.weight(.semibold))
                .foregroundStyle(NativeEditorStyle.text)
            if let latest, !latest.summary.isEmpty {
                Text(latest.summary).font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            }
            // Bordered on every platform: on iPhone and iPad a default button in a list card reads as plain text.
            // The height is inside each label, so the capsule itself is the 44-point target.
            // Side by side where both fit. A narrow pane stacks them, so no title is cut short.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { resultActions(canUndo: undoable != nil, changed: changed) }
                VStack(alignment: .leading, spacing: 8) { resultActions(canUndo: undoable != nil, changed: changed) }
            }
            .buttonStyle(.bordered).controlSize(Self.touch ? .regular : .small)
            if !model.changeReceipts.isEmpty {
                DisclosureGroup("Details") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Receipts record what changed in the project. Check playback and the timeline for the result you asked for.")
                            .font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
                        ForEach(model.changeReceipts.reversed()) { receipt in receiptRow(receipt) }
                    }.padding(.top, 6)
                }.font(.caption).frame(minHeight: Self.touch ? 44 : nil)
            }
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).stroke(NativeEditorStyle.line) }
        .accessibilityElement(children: .contain).accessibilityLabel("Assistant changes")
    }

    @ViewBuilder private func resultActions(canUndo: Bool, changed: [NativeChangeReceipt.Clip]) -> some View {
        if canUndo {
            Button { Task { await assistant.undoLastChange() } } label: { cardAction("Undo this change") }
                .help("Restore the project from before this assistant change. Undo restores it again.")
                .accessibilityIdentifier("editor.assistant.undoChange")
        } else if !model.changeReceipts.isEmpty {
            Button { model.undo() } label: { cardAction("Undo latest edit") }
                .help("Undo the latest edit in the project, as Undo in the editor does.")
        }
        if changed.count == 1, let clip = changed.first {
            Button { model.selectReceiptClip(clip) } label: { cardAction("Select \(clip.name)") }
                .accessibilityLabel("Select \(clip.name) in \(clip.compositionName)")
        } else if changed.count > 1 {
            Menu {
                ForEach(changed) { clip in Button("\(clip.name) · \(clip.compositionName)") { model.selectReceiptClip(clip) } }
            } label: { cardAction("Select changed layers") }.fixedSize()
        }
    }

    private func cardAction(_ title: String) -> some View {
        Text(title).lineLimit(1).frame(minHeight: Self.touch ? 30 : nil)
    }

    // MARK: Composer

    /// Touch devices get 44-point targets.
    private static var touch: Bool {
        #if os(iOS)
        true
        #else
        false
        #endif
    }

    /// One bordered field holds the chips, the draft and the controls, as in the browser editor.
    /// The border is a background shape, so the three regions still add up to the composer.
    private func composer(width: Double, regions: NativeAssistantLayout.Regions, stacked: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // A chip row taller than its region scrolls, so no chip is cut off out of reach.
            ScrollView(.vertical) { contextRow.padding(.top, 14).padding(.bottom, 4) }.frame(height: regions.context)
            draftEditor(height: max(0, regions.editor - 8))
                .padding(.horizontal, 12)
            ScrollView(.vertical) {
                composerActions(width: width, stacked: stacked)
                    .frame(minWidth: 0, maxWidth: .infinity)
                    .padding(.top, 6).padding(.bottom, 14).padding(.horizontal, 16)
            }.frame(height: regions.actions)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background {
            RoundedRectangle(cornerRadius: 10).fill(NativeEditorStyle.background)
                .overlay { RoundedRectangle(cornerRadius: 10).stroke(draftFocused ? NativeEditorStyle.accent.opacity(0.5) : NativeEditorStyle.line) }
                .padding(8)
        }
        .background(NativeEditorStyle.panelRaised)
        #if os(iOS)
        .accessibilityIdentifier("editor.assistant.compactComposer")
        #endif
    }

    /// What Send attaches, as chips: the selection or timeline, the playhead, the input kind and
    /// any look reference. Send captures the selection again when pressed.
    private var contextRow: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    // First, so the reason Send is off is never scrolled out of the row.
                    if model.assistantDraft.count > assistant.inputCharacterLimit {
                        chip { Text("Too long: \(model.assistantDraft.count) of \(assistant.inputCharacterLimit)").monospacedDigit() }
                            .foregroundStyle(NativeEditorStyle.error)
                            .accessibilityLabel(draftLimitExplanation)
                    }
                    Button { inspectCurrentRequestContext() } label: {
                        chip { Label(contextLabel, systemImage: "scope").lineLimit(1) }
                    }.buttonStyle(.plain)
                        .foregroundStyle(model.selectedIDs.isEmpty ? NativeEditorStyle.text : NativeEditorStyle.accent)
                        .disabled(model.project == nil || model.renderPreviewBackendID == nil)
                        .help("Inspect the current selection and request context. Send captures the current selection again.")
                        .accessibilityLabel("Inspect current request context: \(contextDescription)")
                        .accessibilityIdentifier("editor.assistant.composerContext")
                    chip { HStack(spacing: 5) { Text("Playhead").foregroundStyle(NativeEditorStyle.muted); footerTimecode } }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Playhead \(nativeTimecode(model.time, fps: model.fps))")
                    if model.assistantInputKind != "prompt" {
                        Button { model.assistantInputKind = "prompt" } label: {
                            chip { HStack(spacing: 4) { Text(model.assistantInputKind == "screenplay" ? "Screenplay" : "Script"); Image(systemName: "xmark").font(.caption2) } }
                        }.buttonStyle(.plain)
                            .accessibilityLabel("\(model.assistantInputKind == "screenplay" ? "Screenplay" : "Script") input. Switch back to prompt")
                    }
                    if let reference = model.lookReference {
                        Button { model.lookReference = nil } label: {
                            chip { HStack(spacing: 4) { Label((reference as NSString).lastPathComponent, systemImage: "photo").lineLimit(1).truncationMode(.middle); Image(systemName: "xmark").font(.caption2) } }
                        }.buttonStyle(.plain).accessibilityLabel("Look reference \((reference as NSString).lastPathComponent). Remove")
                    }
                }.padding(.horizontal, 7)
            }.padding(.horizontal, 9)
            if showsKeyboardDone {
                // The frame sits inside the label so the whole 44-point target is the button.
                Button { draftFocused = false } label: {
                    Text("Done").fontWeight(.semibold).frame(minWidth: 44, minHeight: chipHeight).contentShape(Rectangle())
                }
                    .padding(.trailing, 14)
                    .accessibilityLabel("Dismiss assistant keyboard")
            }
        }
    }

    /// A phone puts the keyboard's Done in the composer. In the keyboard toolbar it covered
    /// Send: the sheet's keyboard inset leaves out part of that bar, so the pane ran under it.
    private var showsKeyboardDone: Bool {
        #if os(iOS) && !targetEnvironment(macCatalyst)
        horizontalSizeClass == .compact && draftFocused
        #else
        false
        #endif
    }

    private func chip<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content().font(.caption.weight(.medium))
            .padding(.horizontal, 9).frame(minHeight: chipHeight)
            .background(NativeEditorStyle.background, in: Capsule())
            .overlay { Capsule().stroke(NativeEditorStyle.line) }
            .contentShape(Capsule())
    }

    private func draftEditor(height: Double) -> some View {
        TextEditor(text: $model.assistantDraft)
        .focused($draftFocused)
        .font(.body).scrollContentBackground(.hidden)
        .frame(height: height)
        .padding(4)
        // A hidden copy measures the placeholder where it wraps, whatever height the draft has now.
        .background(alignment: .topLeading) {
            Text(draftPlaceholder).font(.body).multilineTextAlignment(.leading).padding(9)
                .fixedSize(horizontal: false, vertical: true).hidden().accessibilityHidden(true)
                .onGeometryChange(for: Double.self) { $0.size.height } action: { placeholderHeight = $0 }
        }
        .overlay(alignment: .topLeading) {
            if model.assistantDraft.isEmpty {
                Text(draftPlaceholder)
                .font(.body).foregroundStyle(NativeEditorStyle.muted).multilineTextAlignment(.leading)
                .padding(9).allowsHitTesting(false)
            }
        }
        // The placeholder wraps. It stays inside the field when a short pane leaves it less room.
        .clipped()
        .accessibilityLabel("Assistant prompt or script")
        .accessibilityIdentifier("editor.assistant.draft")
        .onKeyPress(.return, phases: .down) { press in
            // Return sends a prompt. Scripts and screenplays are multi-line, so Return adds a line
            // there and Command-Return sends.
            let modifiers = press.modifiers.subtracting(.capsLock)
            let send = modifiers == .command || (modifiers.isEmpty && model.assistantInputKind == "prompt")
            guard send else { return .ignored }
            if !assistant.configured && !model.assistantDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                settings = true; return .handled
            }
            guard canSendDraft else { return .ignored }
            sendDraft()
            return .handled
        }
    }

    private var draftPlaceholder: String {
        if model.assistantInputKind != "prompt" { return "Paste a script to build editable scenes" }
        return model.selectedIDs.isEmpty ? "Ask for an edit, or ask about the project" : "Ask about or change this selection"
    }

    /// Input, preview, model and the one primary control. Stacked, Send or Stop comes first.
    /// At accessibility text sizes Preview shows only its icon so Send never wraps. When the row
    /// is still wider than the field, Send or Stop shows only its icon, so the row stays inside
    /// the border.
    @ViewBuilder private func composerActions(width: Double, stacked: Bool) -> some View {
        if stacked {
            VStack(spacing: 8) {
                ViewThatFits(in: .horizontal) {
                    stackedActionRow(width: width) { primaryAction }
                    stackedActionRow(width: width) { primaryAction.labelStyle(NativeAssistantIconActionStyle()) }
                }
                // The largest text sizes cannot fit "· Default" even on a row of its own.
                modelControls(short: dynamicTypeSize >= .accessibility3)
            }.frame(maxWidth: .infinity)
        } else {
            // In one row the model shares the width, so a narrow pane or a phone shows only the
            // provider in its label, and a narrow touch row shows Send or Stop as its icon.
            HStack(spacing: 6) {
                inputMenu
                previewToggle(iconOnly: width < 360)
                modelControls(short: width < 420 || Self.touch && horizontalSizeClass == .compact)
                if Self.touch && width < 440 { primaryAction.labelStyle(NativeAssistantIconActionStyle()) } else { primaryAction }
            }
            // The row is as tall while a request runs as when idle, so Stop keeps Send's target.
            .frame(minHeight: actionHeight)
        }
    }

    private func stackedActionRow<Primary: View>(width: Double, @ViewBuilder primary: () -> Primary) -> some View {
        HStack(spacing: 6) {
            inputMenu
            previewToggle(iconOnly: width < 260 || (dynamicTypeSize.isAccessibilitySize && width < 600))
            Spacer(minLength: 0)
            primary()
        }.frame(minHeight: actionHeight)
    }

    @ViewBuilder private var primaryAction: some View {
        if assistant.isWorking { cancelButton } else { sendButton }
    }

    private var sendButton: some View {
        // The 44-point minimum is inside the label, so the gold capsule itself is the touch target.
        Button { sendDraft() } label: { NativeAssistantProminentLabel { Label("Send", systemImage: "arrow.up").lineLimit(1).fixedSize().modifier(NativeAssistantPrimaryTarget()) } }
        .buttonStyle(.borderedProminent).controlSize(.regular)
        .disabled(!assistant.configured || assistant.isWorking || model.assistantDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.assistantDraft.count > assistant.inputCharacterLimit)
        .help(assistant.configured ? "Send (Return). Scripts send with Command-Return." : "Set up the assistant to send. Your draft is kept.")
        // Named here, because the icon-only row drops the title from the label.
        .accessibilityLabel("Send")
        .accessibilityHint(draftLimitExplanation)
            .frame(minHeight: actionHeight)
    }

    @ViewBuilder private var cancelButton: some View {
        if assistant.isWorking {
            Button { assistant.cancel() } label: { NativeAssistantProminentLabel { Label(assistant.state == "cancelling" ? "Stopping…" : "Stop", systemImage: "stop.fill").lineLimit(1).fixedSize().modifier(NativeAssistantPrimaryTarget()) } }
                .buttonStyle(.borderedProminent).controlSize(.regular)
                .disabled(assistant.state == "cancelling")
                .accessibilityLabel(assistant.state == "cancelling" ? "Stopping request" : "Stop request")
                .help("Stop this request. Edits it already made stay and can be undone.")
                .frame(minHeight: actionHeight)
        }
    }

    private func previewToggle(iconOnly: Bool) -> some View {
        Toggle(isOn: $assistant.previewChanges) {
            if iconOnly { Image(systemName: "eye") } else { Label("Preview", systemImage: "eye") }
        }
        .toggleStyle(.button).controlSize(Self.touch ? .regular : .small).fixedSize()
        .frame(minHeight: Self.touch ? actionHeight : nil)
        .disabled(assistant.isWorking)
        .help("Preview changes: see what a request will change, then apply it yourself.")
        .accessibilityLabel("Preview changes")
        .accessibilityIdentifier("editor.assistant.previewChanges")
    }

    /// Input kind, script import, suggestions and context inspection, from the composer.
    private var inputMenu: some View {
        Menu {
            inputPicker.pickerStyle(.inline)
            Button("Import text…", systemImage: "doc.badge.plus") { requestScriptImport() }
                .disabled(scriptImportContext != nil || model.renderPreviewBackendID == nil || model.folder == nil)
            if !assistant.suggestions.isEmpty && model.assistantDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !assistant.chat.isEmpty {
                Section("Suggestions") {
                    ForEach(assistant.suggestions) { item in Button(item.label) { useSuggestion(item) }.disabled(assistant.isWorking) }
                }
            }
            Section {
                Button("Inspect current context", systemImage: "scope") { inspectCurrentRequestContext() }
                    .disabled(model.project == nil || model.renderPreviewBackendID == nil)
                if model.lookReference != nil {
                    Button("Remove look reference", systemImage: "photo") { model.lookReference = nil }
                }
            }
        } label: {
            Image(systemName: "plus").frame(width: Self.touch ? 44 : 26, height: Self.touch ? actionHeight : 26).contentShape(Rectangle())
        }
        #if os(macOS)
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        #endif
        .help("Choose prompt, script or screenplay, import text, or use a suggestion")
        .accessibilityLabel("Request input and script attachment")
        .accessibilityValue(model.assistantInputKind + (model.lookReference == nil ? "" : ", look reference attached"))
        .accessibilityIdentifier("editor.assistant.inputAttachments")
    }

    private func sendDraft() {
        do {
            let selection = NativeSelectionAIContext.make(project: model.project?.fields ?? [:], clipID: model.selectedID, clipIDs: model.selectedIDs, composition: model.composition, time: model.time, version: model.version, folder: model.folder?.standardizedFileURL.path)
            guard model.selectedIDs.isEmpty || selection != nil else { throw ReelBackend.APIError("The selection is too large or changed. Select fewer layers before sending.") }
            var refs = selection?.refs ?? ["clip": "", "clips": [], "time": model.time, "composition": model.composition ?? "main", "editableNativeObjects": true, "sourceProjectVersion": model.version]
            refs["inputKind"] = model.assistantInputKind
            if let reference = model.lookReference { refs["reference"] = reference }
            try assistant.send(model.assistantDraft, refs: refs); model.assistantDraft = ""
            #if os(iOS)
            // The reply and the viewer are what matter now, so the keyboard steps aside.
            if horizontalSizeClass == .compact { draftFocused = false }
            #endif
        } catch { model.status = error.localizedDescription; assistant.recordSendFailure(error); if assistant.sharingReview != nil { reviewingSharing = true } }
    }

    private var suggestionKey: String { "\(model.selectedIDs.sorted().joined(separator: ","))|\(model.composition ?? "")|\(model.version)" }
    private var proposalKey: String { "\(assistant.proposal?.id.uuidString ?? "")|\(model.version)" }

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
        inspectedReferences = NativeAssistantReferenceInspection(text: JSON(any: refs).text, title: "Current request context",
            note: "This preview captures the selection and time when opened. Send uses the current selection and time, plus project context allowed by AI sharing.")
    }

    private var canChooseClaudeDefault: Bool {
        guard assistant.accountStatusVerified, !assistant.checking, !assistant.isWorking,
              let account = assistant.providers.first(where: { $0.string("id") == "claude-code" }),
              account["installed"] as? Bool == true, account["authenticated"] as? Bool == true,
              account["adapterSupported"] as? Bool == true, account["available"] as? Bool == true else { return false }
        return !assistant.modelOptions.contains { $0.string("provider") == "claude-code" && $0.flag("isDefault") }
    }

    private var chatGPTMenuModels: [ChatGPTModel] {
        guard NativeChatGPT.supported, chatGPT.status.signedIn, chatGPT.status.planUsage,
              !assistant.modelOptions.contains(where: { $0.string("provider") == "chatgpt" }) else { return [] }
        return chatGPT.models
    }

    private func chooseChatGPTModel(_ slug: String) {
        do {
            if assistant.provider != "chatgpt" { try assistant.selectProvider("chatgpt") }
            try assistant.update(apiKey: nil, model: slug)
            // A chosen model only takes effect in Manual routing.
            if assistant.routingMode != "manual" { try assistant.setRouting(mode: "manual", effort: "") }
        } catch { model.status = error.localizedDescription }
    }

    /// Short shows only Auto or the provider's short name, so the label fits beside Send without
    /// being cut in the middle. The menu marks the model, and VoiceOver reads the full route.
    private func modelControls(short: Bool) -> some View {
            let label = short ? NativeAssistantRoutingPolicy.compactRoutingLabel(mode: assistant.routingMode, provider: assistant.provider) : assistant.routingLabel
            return Menu {
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
                // A signed-in ChatGPT plan lists its models here too, like the picker in Assistant settings.
                if !chatGPTMenuModels.isEmpty {
                    Section(NativeAssistant.providerName("chatgpt")) {
                        ForEach(chatGPTMenuModels, id: \.slug) { item in
                            Button { chooseChatGPTModel(item.slug) } label: {
                                if assistant.provider == "chatgpt" && assistant.model == item.slug { Label(item.displayName, systemImage: "checkmark") }
                                else { Text(item.displayName) }
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
                    // A narrow touch row gives the width to the name, which already says Auto or the provider.
                    if !(short && Self.touch) { Image(systemName: assistant.routingMode == "auto" ? "arrow.triangle.branch" : "cpu") }
                    Text(label).lineLimit(1).truncationMode(.middle)
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

    private var footerTimecode: some View {
        Text(nativeTimecode(model.time, fps: model.fps))
            .font(.system(size: 11, design: .monospaced)).foregroundStyle(NativeEditorStyle.muted).monospacedDigit()
    }

    private var canSendDraft: Bool {
        assistant.configured && !assistant.isWorking && (assistant.applyingProposal.map { $0.finished } ?? true) && !model.assistantDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.assistantDraft.count <= assistant.inputCharacterLimit
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

    private var inputPicker: some View {
        Picker("Input", selection: $model.assistantInputKind) {
            Text("Prompt").tag("prompt"); Text("Script").tag("script"); Text("Screenplay").tag("screenplay")
        }.labelsHidden().frame(minWidth: 0, maxWidth: .infinity).accessibilityLabel("Assistant input type")
    }

    /// The chip names what is attached, in the browser editor's words. The window title
    /// already shows the project name.
    private var contextLabel: String {
        if model.selectedIDs.count > 1 { return "\(model.selectedIDs.count) selected clips" }
        if let clip = model.selected { return clip.name }
        if let composition = model.project?.compositions.first(where: { $0.id == model.composition }) { return "Composition: \(composition.name)" }
        return "Main timeline"
    }

    /// VoiceOver also hears that the named clip is the selection.
    private var contextDescription: String {
        if model.selectedIDs.count <= 1, let clip = model.selected { return "Selected clip: \(clip.name)" }
        return contextLabel
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
                            Button { model.selectReceiptClip(clip) } label: {
                                Text("Select changed layer").frame(minHeight: Self.touch ? 44 : nil).contentShape(Rectangle())
                            }.controlSize(Self.touch ? .regular : .small)
                                .disabled(model.receiptSelection(clip) == nil)
                                .accessibilityLabel("Select \(clip.name) in \(clip.compositionName)")
                        }
                    }
                    Rectangle().fill(NativeEditorStyle.line).frame(height: 1)
                }
                if receipt.truncated {
                    Text("Some changes or values are shortened. Showing \(receipt.clips.count) of \(receipt.totalClips) changed layers and \(receipt.scopes.count) of \(receipt.totalScopes) changed \(receipt.hasAssetChanges ? "Media and settings" : "settings") groups.")
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
/// Touch builds give card actions 44-point targets. The Mac keeps its compact rows.
private enum NativeAssistantCardMetrics {
    #if os(iOS)
    static let touch = true
    #else
    static let touch = false
    #endif
}

/// On iPhone, iPad and Mac Catalyst a prominent button draws its label in the panel's pale text
/// colour, which is hard to read on the gold fill. This gives the label the dark ink, and the
/// muted colour while the button is disabled.
private struct NativeAssistantProminentLabel<Content: View>: View {
    @Environment(\.isEnabled) private var isEnabled
    @ViewBuilder var content: () -> Content

    var body: some View {
        #if os(iOS)
        content().foregroundStyle(isEnabled ? NativeEditorStyle.accentInk : NativeEditorStyle.muted)
        #else
        content()
        #endif
    }
}

/// Send or Stop as its icon alone, wide enough to stay a 44-point target. VoiceOver still
/// reads the title.
private struct NativeAssistantIconActionStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.icon.frame(minWidth: 20)
    }
}

/// On touch builds the Send or Stop label fills a capsule of at least 44 by 44 points: the
/// bordered style adds 12 points on each side and 7 above and below. The Mac keeps its row.
private struct NativeAssistantPrimaryTarget: ViewModifier {
    func body(content: Content) -> some View {
        #if os(iOS)
        content.frame(minWidth: 20, minHeight: 30).contentShape(Rectangle())
        #else
        content
        #endif
    }
}

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
                if !receipt.scopes.isEmpty { note("Settings: \(receipt.scopes.map(\.name).joined(separator: ", ")).") }
                // Everything Apply will change, with values, so nothing is approved unseen.
                DisclosureGroup("Show all changes") { allChanges(receipt) }
                    .font(.caption).frame(minHeight: NativeAssistantCardMetrics.touch ? 44 : nil).accessibilityIdentifier("editor.assistant.previewAllChanges")
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
                // The heights are inside the labels, so the drawn controls are the 44-point targets.
                Button(action: apply) {
                    NativeAssistantProminentLabel { Text("Apply").frame(minHeight: NativeAssistantCardMetrics.touch ? 30 : nil) }
                }.buttonStyle(.borderedProminent).disabled(stale || running)
                    .help(running ? "Wait for the assistant to finish" : "Apply these edits as one undoable change")
                    .accessibilityIdentifier("editor.assistant.applyPreview")
                // Bordered on every platform. On iPhone, iPad and Mac Catalyst the default is plain text.
                Button(action: discard) {
                    Text("Discard").frame(minHeight: NativeAssistantCardMetrics.touch ? 30 : nil).contentShape(Rectangle())
                }.buttonStyle(.bordered)
            }
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).stroke(NativeEditorStyle.line) }
        .accessibilityElement(children: .contain).accessibilityLabel("Preview of proposed changes")
        .accessibilityIdentifier("editor.assistant.preview")
    }

    private var headline: String {
        let layers = proposal.receipt?.totalClips ?? 0, steps = proposal.steps.count
        let parts = [layers > 0 ? "changes to \(layers) layer\(layers == 1 ? "" : "s")" : "", steps > 0 ? "\(steps) processing step\(steps == 1 ? "" : "s")" : ""].filter { !$0.isEmpty }
        return "Apply \(parts.isEmpty ? "changes to settings" : parts.joined(separator: " and ")). Nothing has changed yet\(steps > 0 ? " and nothing renders until you apply" : "")."
    }

    private func note(_ text: String) -> Text { Text(text).font(.caption).foregroundStyle(NativeEditorStyle.muted) }

    private func allChanges(_ receipt: NativeChangeReceipt) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(receipt.scopes.enumerated()), id: \.offset) { _, scope in
                changeGroup(title: "\(scope.name) · \(scope.status)", changes: scope.changes)
            }
            ForEach(receipt.clips) { clip in
                changeGroup(title: "\(proposal.names[clip.clipID] ?? clip.name) · \(clip.compositionName) · \(clip.status)", changes: clip.changes)
            }
            if receipt.truncated {
                note("Arya shortened this list. It shows \(receipt.clips.count) of \(receipt.totalClips) layers and \(receipt.scopes.count) of \(receipt.totalScopes) settings groups.")
            }
        }.padding(.top, 4).textSelection(.enabled)
    }

    private func changeGroup(title: String, changes: [NativeChangeReceipt.Change]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 11, weight: .medium)).fixedSize(horizontal: false, vertical: true)
            ForEach(Array(changes.flatMap(Self.readable).enumerated()), id: \.offset) { _, change in
                Text("\(change.property): \(change.before) → \(change.after)").font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

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
                Button(action: dismiss) {
                    Text("Dismiss").frame(minHeight: NativeAssistantCardMetrics.touch ? 44 : nil).contentShape(Rectangle())
                }.controlSize(.small)
            }
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain).accessibilityLabel("Applying the preview")
    }
}
// END ASSISTANT PREVIEW CARDS

/// Reports a view's top and bottom in the assistant history's visible area.
private struct LatestSpan: ViewModifier {
    let action: (ClosedRange<Double>) -> Void
    func body(content: Content) -> some View {
        content.onGeometryChange(for: ClosedRange<Double>.self) { geometry in
            let frame = geometry.frame(in: .named(NativeAssistantPanel.historySpace))
            return Double(frame.minY)...Double(max(frame.minY, frame.maxY))
        } action: { action($0) }
    }
}
