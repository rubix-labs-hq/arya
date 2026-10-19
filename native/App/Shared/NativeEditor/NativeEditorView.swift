import SwiftUI
import UniformTypeIdentifiers
import ReelKit
#if os(iOS)
import CoreHaptics
import UIKit
import AVFoundation
#elseif os(macOS)
import AppKit
#endif

#if os(iOS)
private struct NativeContextInteractionsEnabledKey: EnvironmentKey {
    static let defaultValue = true
}

struct NativeContextInteractionLayout: Equatable {
    let frame: CGRect
    let visible: Bool

    var permitsInteraction: Bool {
        visible && !frame.isNull && !frame.isInfinite &&
            frame.origin.x.isFinite && frame.origin.y.isFinite &&
            frame.size.width.isFinite && frame.size.height.isFinite &&
            frame.size.width > 0 && frame.size.height > 0
    }
}

private struct NativeContextInteractionLayoutKey: EnvironmentKey {
    static let defaultValue: NativeContextInteractionLayout? = nil
}

extension EnvironmentValues {
    var nativeContextInteractionsEnabled: Bool {
        get { self[NativeContextInteractionsEnabledKey.self] }
        set { self[NativeContextInteractionsEnabledKey.self] = newValue }
    }

    var nativeContextInteractionLayout: NativeContextInteractionLayout? {
        get { self[NativeContextInteractionLayoutKey.self] }
        set { self[NativeContextInteractionLayoutKey.self] = newValue }
    }
}

enum NativeHapticAvailability {
    static let supported = CHHapticEngine.capabilitiesForHardware().supportsHaptics
}
#endif

enum NativeWorkspaceLayout {
    /// The shortest picture worth keeping beside the timeline while detailed controls are open.
    static let pictureMinimum = 200.0

    static func contextBeside(width: Double, height: Double, accessibilityText: Bool) -> Bool {
        width.isFinite && height.isFinite && width >= 760 && height >= 320 && !accessibilityText
    }

    static func contextWidth(width: Double) -> Double {
        let width = width.isFinite ? max(0, width) : 0
        return min(360, max(300, width * 0.38))
    }

    static func contextHeight(height: Double, expanded: Bool, detailed: Bool = false) -> Double {
        let height = height.isFinite ? max(0, height) : 0
        guard expanded else { return 0 }
        let summary = min(260, height * 0.30)
        return detailed ? max(summary, min(height * 0.58, max(0, height - 226))) : summary
    }

    static func contextPanelHeight(height: Double, header: Double) -> Double {
        let height = height.isFinite ? max(0, height) : 0
        let header = header.isFinite ? max(44, header) : 44
        return max(0, height - header - 1)
    }

    struct CompactCanvas {
        let viewerWidth: Double
        let viewerHeight: Double
        let timelineWidth: Double
        let timelineHeight: Double
        let timelineX: Double
        let timelineY: Double
        let dividerHeight: Double
    }

    static func compactCanvas(width: Double, height: Double, timeline: Double, visible: Bool, touchDivider: Double) -> CompactCanvas {
        let width = width.isFinite ? max(0, width) : 0
        let height = height.isFinite ? max(0, height) : 0
        let touchDivider = touchDivider.isFinite ? max(0, touchDivider) : 0
        let horizontal = visible && width >= 600 && height < 400
        let divider = visible && !horizontal ? min(height, width >= 600 ? touchDivider : 6) : 0
        let range = compactTimelineRange(height: height, divider: divider)
        let preferred = timeline.isFinite ? timeline : range.lowerBound
        let bottom = visible ? (horizontal ? height : min(range.upperBound, max(range.lowerBound, preferred))) : 0
        let viewerWidth = horizontal ? width * 0.42 : width
        let viewerHeight = horizontal ? height : max(0, height - divider - bottom)
        let gap = horizontal ? min(6, max(0, width - viewerWidth)) : 0
        return CompactCanvas(viewerWidth: viewerWidth, viewerHeight: viewerHeight,
                             timelineWidth: horizontal ? max(0, width - viewerWidth - gap) : width,
                             timelineHeight: bottom, timelineX: horizontal ? viewerWidth + gap : 0,
                             timelineY: horizontal ? 0 : viewerHeight + divider, dividerHeight: divider)
    }

    static func compactTimelineRange(height: Double, divider: Double) -> ClosedRange<Double> {
        let height = height.isFinite ? max(0, height) : 0
        let divider = divider.isFinite ? max(0, divider) : 0
        let available = max(0, height - divider)
        let minimumTimeline = min(196, available * 0.40)
        let maximum = max(minimumTimeline, available - min(220, available * 0.60))
        return min(minimumTimeline, maximum)...maximum
    }

    static func compact(width: Double, height: Double, mobile: Bool, accessibilityText: Bool) -> Bool {
        // Three touch panes need room for media, the picture and its inspector.
        // A full-size iPad in portrait is still too narrow for that arrangement.
        mobile && (width < 1200 || height < 560 || accessibilityText)
    }

    static func compactWorkflowColumns(width: Double, itemWidth: Double) -> Int {
        let available = width.isFinite ? max(0, width - 12) : 0
        let minimum = itemWidth.isFinite ? max(44, itemWidth) : 48
        return [6, 3, 2].first { Double($0) * minimum + Double($0 - 1) * 2 <= available } ?? 1
    }

    // A compact phone row has the project, Undo and Tools; narrow windows and large text stack.
    static func stackedHeader(width: Double, compact: Bool, accessibilityText: Bool) -> Bool {
        !width.isFinite || width < (compact ? 360 : 680) || accessibilityText
    }
    static func sideBySide(width: Double, height: Double) -> Bool {
        width >= 600 && height < 400
    }

    static func scrollingStack(width: Double, height: Double) -> Bool {
        width < 600 && height < 400
    }

    struct Desktop {
        let editingWidth: Double
        let mediaWidth: Double
        let mediaMaximum: Double
        let inspectorWidth: Double
        let inspectorMaximum: Double
        let assistantWidth: Double
        let assistantMaximum: Double
        let viewerWidth: Double
        let viewerHeight: Double
        let timelineHeight: Double
        let timelineRange: ClosedRange<Double>
        let showMedia: Bool
        let showInspector: Bool
        let showAssistant: Bool
    }

    struct MobilePlacement {
        let viewerX: Double
        let viewerY: Double
        let viewerWidth: Double
        let viewerHeight: Double
        let timelineX: Double
        let timelineY: Double
        let timelineWidth: Double
        let timelineHeight: Double
        let panelX: Double
        let panelY: Double
        let panelWidth: Double
        let panelHeight: Double
        let panelVisible: Bool
        let contextFocused: Bool
        let canvasWidth: Double
        let canvasHeight: Double
        let compactDividerHeight: Double
        let desktop: Desktop
    }

    static func mobilePlacement(width: Double, height: Double, compact: Bool, expanded: Bool, accessibilityText: Bool,
                                divider: Double, media: Double, inspector: Double, assistant: Double, timeline: Double,
                                mediaVisible: Bool, inspectorVisible: Bool, assistantVisible: Bool,
                                timelineVisible: Bool, mediaPage: Bool, detailedControls: Bool = false) -> MobilePlacement {
        let width = width.isFinite ? max(0, width) : 0
        let height = height.isFinite ? max(0, height) : 0
        let divider = divider.isFinite ? max(0, divider) : 0
        let wide = desktop(width: width, height: height, divider: divider, media: media, inspector: inspector,
                              assistant: assistant, timeline: timeline, mediaVisible: mediaVisible,
                              inspectorVisible: inspectorVisible, assistantVisible: assistantVisible,
                              timelineVisible: timelineVisible, mediaPage: mediaPage)
        if compact {
            if expanded && width < 600 && height < 400 {
                return MobilePlacement(viewerX: 0, viewerY: 0, viewerWidth: width, viewerHeight: 0,
                                       timelineX: 0, timelineY: 0, timelineWidth: width, timelineHeight: 0,
                                       panelX: 0, panelY: 0, panelWidth: width, panelHeight: height,
                                       panelVisible: true, contextFocused: true, canvasWidth: width,
                                       canvasHeight: 0, compactDividerHeight: 0, desktop: wide)
            }
            if expanded && sideBySide(width: width, height: height) {
                let panelWidth = min(width * 0.5, contextWidth(width: width))
                let separator = min(6, max(0, width - panelWidth))
                let viewerWidth = max(0, width - panelWidth - separator)
                return MobilePlacement(viewerX: 0, viewerY: 0, viewerWidth: viewerWidth, viewerHeight: height,
                                       timelineX: 0, timelineY: height, timelineWidth: width, timelineHeight: 0,
                                       panelX: viewerWidth + separator, panelY: 0, panelWidth: panelWidth,
                                       panelHeight: height, panelVisible: true, contextFocused: true,
                                       canvasWidth: viewerWidth, canvasHeight: height, compactDividerHeight: 0, desktop: wide)
            }
            let beside = contextBeside(width: width, height: height, accessibilityText: accessibilityText)
            let panelWidth = beside ? contextWidth(width: width) : width
            let panelHeight = expanded ? (beside ? height : contextHeight(height: height, expanded: true, detailed: detailedControls)) : 0
            let separator = expanded ? min(6, beside ? width : max(0, height - panelHeight)) : 0
            let canvasWidth = max(0, width - (beside && expanded ? panelWidth + separator : 0))
            let canvasHeight = max(0, height - (!beside && expanded ? panelHeight + separator : 0))
            // When expanded controls below the picture leave it shorter than pictureMinimum while it
            // shares the space with the timeline, give the timeline's height to the picture so a
            // grade stays visible. Taller spaces, such as an iPad in split view, keep both.
            let shared = compactCanvas(width: canvasWidth, height: canvasHeight, timeline: timeline,
                                       visible: timelineVisible, touchDivider: divider)
            let pictureOnly = expanded && detailedControls && !beside && timelineVisible && shared.viewerHeight < pictureMinimum
            let canvas = pictureOnly ? compactCanvas(width: canvasWidth, height: canvasHeight, timeline: timeline,
                                                     visible: false, touchDivider: divider) : shared
            return MobilePlacement(viewerX: 0, viewerY: 0, viewerWidth: canvas.viewerWidth, viewerHeight: canvas.viewerHeight,
                                   timelineX: canvas.timelineX, timelineY: canvas.timelineY,
                                   timelineWidth: canvas.timelineWidth, timelineHeight: canvas.timelineHeight,
                                   panelX: beside && expanded ? canvasWidth + separator : 0,
                                   panelY: !beside && expanded ? canvasHeight + separator : 0,
                                   panelWidth: panelWidth, panelHeight: panelHeight, panelVisible: expanded, contextFocused: false,
                                   canvasWidth: canvasWidth, canvasHeight: canvasHeight,
                                   compactDividerHeight: canvas.dividerHeight, desktop: wide)
        }
        let viewerX = 6 + (wide.showMedia ? wide.mediaWidth + divider : 0)
        return MobilePlacement(viewerX: viewerX, viewerY: 6, viewerWidth: wide.viewerWidth, viewerHeight: wide.viewerHeight,
                               timelineX: 6, timelineY: 6 + wide.viewerHeight + (timelineVisible ? divider : 0),
                               timelineWidth: wide.editingWidth, timelineHeight: wide.timelineHeight,
                               panelX: viewerX + wide.viewerWidth + divider, panelY: 6,
                               panelWidth: wide.showInspector ? wide.inspectorWidth : bounded(inspector, minimum: 240, maximum: 560),
                               panelHeight: wide.viewerHeight,
                               panelVisible: wide.showInspector, contextFocused: false, canvasWidth: wide.editingWidth,
                               canvasHeight: max(0, height - 12), compactDividerHeight: 0, desktop: wide)
    }

    private static func bounded(_ value: Double, minimum: Double, maximum: Double) -> Double {
        min(maximum, max(minimum, value.isFinite ? value : minimum))
    }

    /// The input is the workspace after header/status chrome, not the whole window.
    static func desktop(width: Double, height: Double, divider: Double, media: Double, inspector: Double,
                        assistant: Double, timeline: Double, mediaVisible: Bool, inspectorVisible: Bool,
                        assistantVisible: Bool, timelineVisible: Bool, mediaPage: Bool) -> Desktop {
        let width = width.isFinite ? max(0, width) : 0
        let height = height.isFinite ? max(0, height) : 0
        let divider = divider.isFinite ? max(0, divider) : 0
        let viewerMinimum = 360.0
        let fixedSide = inspectorVisible && !mediaPage ? 240 + divider : mediaVisible && mediaPage ? 180 + divider : 0
        let assistantMaximum = max(0, min(520, width - 12 - viewerMinimum - fixedSide - divider))
        let showAssistant = assistantVisible && assistantMaximum >= 290
        let chat = showAssistant ? bounded(assistant, minimum: 290, maximum: assistantMaximum) : 0
        let editing = max(0, width - (showAssistant ? chat + divider : 0) - 12)
        let showInspector = inspectorVisible && !mediaPage && editing >= 240 + viewerMinimum + divider
        // The Media page is a browser: its media column can take most of the width beside the viewer.
        let mediaMaximum = max(0, min(mediaPage ? 900 : 420, editing - (showInspector ? 240 + divider : 0) - viewerMinimum - divider))
        let mediaThreshold = max(850, bounded(inspector, minimum: 240, maximum: 560) + bounded(media, minimum: 180, maximum: 420) + viewerMinimum + 2 * divider)
        let showMedia = mediaVisible && mediaMaximum >= 180 && (mediaPage || editing >= mediaThreshold)
        let left = showMedia ? bounded(media, minimum: 180, maximum: mediaMaximum) : 0
        let inspectorMaximum = max(0, min(560, editing - (showMedia ? left + divider : 0) - viewerMinimum - divider))
        let right = showInspector ? bounded(inspector, minimum: 240, maximum: inspectorMaximum) : 0
        let viewer = max(0, editing - (showMedia ? left + divider : 0) - (showInspector ? right + divider : 0))
        let available = max(0, height - 12)
        let maximumTimeline = max(0, available - divider - min(240, available * 0.65))
        let range = min(140, maximumTimeline)...maximumTimeline
        let bottom = timelineVisible ? bounded(timeline, minimum: range.lowerBound, maximum: range.upperBound) : 0
        let top = max(0, available - (timelineVisible ? bottom + divider : 0))
        return Desktop(editingWidth: editing, mediaWidth: left, mediaMaximum: mediaMaximum,
                       inspectorWidth: right, inspectorMaximum: inspectorMaximum, assistantWidth: chat,
                       assistantMaximum: assistantMaximum, viewerWidth: viewer, viewerHeight: top,
                       timelineHeight: bottom, timelineRange: range, showMedia: showMedia,
                       showInspector: showInspector, showAssistant: showAssistant)
    }

    static func timelineRange(height: Double, divider: Double) -> ClosedRange<Double> {
        let available = max(0, height - divider)
        let minimum = min(140, available * 0.45)
        let maximum = max(minimum, available - min(180, available * 0.55))
        return minimum...maximum
    }
}

enum NativeCompactWorkspaceRouting {
    static let inlineWorkspaces: [NativePanel] = [.edit, .motion, .color, .audio]
}

struct NativeEditorView: View {
    @ObservedObject var session: EditorSession
    @ObservedObject var model: NativeEditorModel
    var openFolder: () -> Void
    var newProject: () -> Void
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var contextHeaderHeight = 44.0
    @ScaledMetric(relativeTo: .caption) private var compactTimelineMinimum = 196.0
    @ScaledMetric(relativeTo: .caption2) private var compactWorkflowItemWidth = 48.0
    @AppStorage("editor.layout.mediaWidth") private var mediaWidth = 220.0
    @AppStorage("editor.layout.mediaPageWidth") private var mediaPageWidth = 620.0
    @AppStorage("editor.layout.inspectorWidth") private var inspectorWidth = 300.0
    @AppStorage("editor.layout.colorWidth") private var colorWidth = 520.0
    @AppStorage("editor.layout.motionWidth") private var motionWidth = 520.0
    @AppStorage("editor.layout.audioWidth") private var audioWidth = 520.0
    @AppStorage("editor.layout.assistantWidth") private var assistantWidth = 320.0
    @AppStorage("editor.layout.timelineHeight") private var timelineHeight = 260.0
    @AppStorage("editor.layout.colorTimelineHeight") private var colorTimelineHeight = 170.0
    @AppStorage("editor.layout.mediaTimelineHeight") private var mediaTimelineHeight = 200.0
    @AppStorage("editor.layout.mediaVisible") private var mediaVisible = true
    /// Color hides the media column by default; Show media on the Color page sets this one.
    @AppStorage("editor.layout.colorMediaVisible") private var colorMediaVisible = false
    @AppStorage("editor.layout.inspectorVisible") private var inspectorVisible = true
    @AppStorage("editor.layout.assistantVisible") private var assistantVisible = false
    @AppStorage("editor.layout.timelineVisible") private var timelineVisible = true
    @State private var libraryVisible = false
    @State private var settingsVisible = false
    @State private var lastEditingPanel: NativePanel = .edit
    @State private var compactToolsExpanded = false
    @State private var compactControlsDetailed = false
    @AccessibilityFocusState private var compactWorkspaceFocused: NativePanel?

    var body: some View {
        GeometryReader { geometry in
            let compact = usesCompactLayout(size: geometry.size)
            let status = session.projectReadOnlyReason.map { "Project is read-only. \($0)" } ?? model.status
            VStack(spacing: 0) {
                header(compact: compact, width: geometry.size.width)
                Rectangle().fill(NativeEditorStyle.line).frame(height: 1)
                #if os(iOS)
                mobileWorkspace(compact: compact)
                #else
                if compact {
                    compactWorkspace
                } else {
                    desktopWorkspace
                }
                #endif
                if !status.isEmpty {
                    DisclosureGroup {
                        Text(status).font(compact ? .caption : .system(size: 11)).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "info.circle")
                            Text(status).lineLimit(1).truncationMode(.tail)
                            Spacer(minLength: 0)
                        }
                    }
                    .font(compact ? .caption : .system(size: 11)).foregroundStyle(NativeEditorStyle.muted)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(NativeEditorStyle.panel)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Editor status. \(status)")
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if compact {
                    VStack(spacing: 0) {
                        Rectangle().fill(NativeEditorStyle.line).frame(height: 1)
                        compactPanels(width: geometry.size.width)
                    }
                }
            }
            .sheet(item: compactTaskBinding()) { panel in
                NavigationStack {
                    NativePanelView(panel: panel, model: model, session: session)
                        .navigationTitle(panel.name)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { model.mobilePanel = nil } } }
                }
                .preferredColorScheme(.dark).tint(NativeEditorStyle.accent)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                .background { mediaImportPresentation(panel: panel) }
            }
            .sheet(isPresented: $libraryVisible) {
                NavigationStack {
                    NativeLibraryPanel(model: model)
                        .navigationTitle("Project library")
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { libraryVisible = false } } }
                }
                .preferredColorScheme(.dark).tint(NativeEditorStyle.accent)
                #if os(macOS)
                .frame(minWidth: 320, idealWidth: 480, minHeight: 440)
                #endif
                .presentationDetents([.medium, .large])
            }
            .sheet(isPresented: $settingsVisible) {
                NativeEditorPreferences(session: session)
                    .preferredColorScheme(.dark).tint(NativeEditorStyle.accent)
            }
            .onChange(of: model.mobilePanel) { _, next in
                // A nested picker belongs to the panel that presented it. Never queue it
                // behind a dismissed panel or migrate it across a layout/project switch.
                if let request = model.mediaImportRequest, request.panelID != next?.rawValue {
                    model.mediaImportRequest = nil
                }
                if compact, let next, NativeCompactWorkspaceRouting.inlineWorkspaces.contains(next) {
                    model.mobilePanel = nil
                    model.panel = next
                    lastEditingPanel = next
                    setCompactToolsExpanded(true)
                }
            }
            .onChange(of: model.showingSource) { _, next in
                if compact && next { setCompactToolsExpanded(false) }
            }
            .onChange(of: model.requestedWorkspace) { _, _ in
                showRequestedWorkspace(compact: compact)
            }
            .onChange(of: model.panel) { previous, next in
                if compact {
                    if !NativeCompactWorkspaceRouting.inlineWorkspaces.contains(next) {
                        model.mobilePanel = next
                        model.panel = NativeCompactWorkspaceRouting.inlineWorkspaces.contains(previous) ? previous : compactEditingPanel
                    } else {
                        lastEditingPanel = next
                    }
                    return
                }
                if next == .assistant {
                    assistantVisible = true
                    model.panel = NativePanel.workflow.contains(previous) ? previous : lastEditingPanel
                } else if NativePanel.workflow.contains(next) {
                    lastEditingPanel = next
                }
            }
            .onAppear {
                if compact, let requested = model.mobilePanel, NativeCompactWorkspaceRouting.inlineWorkspaces.contains(requested) {
                    model.mobilePanel = nil; model.panel = requested; lastEditingPanel = requested; setCompactToolsExpanded(true)
                }
                if compact && !NativeCompactWorkspaceRouting.inlineWorkspaces.contains(model.panel) { model.mobilePanel = model.panel; model.panel = compactEditingPanel }
                else if model.panel == .assistant, !compact { assistantVisible = true; model.panel = lastEditingPanel }
                else if NativePanel.workflow.contains(model.panel) { lastEditingPanel = model.panel }
                showRequestedWorkspace(compact: compact)
            }
            .onChange(of: compact) { _, next in
                if next {
                    if !NativeCompactWorkspaceRouting.inlineWorkspaces.contains(model.panel) { model.mobilePanel = model.panel; model.panel = compactEditingPanel }
                } else {
                    let tool = model.mobilePanel
                    // Bounded tasks keep their sheet identity and unsaved form state
                    // when an iPad window widens into the multi-pane workspace.
                    if tool == .media || tool == .deliver { return }
                    model.mobilePanel = nil
                    if tool == .assistant || model.panel == .assistant { assistantVisible = true; model.panel = lastEditingPanel }
                    else if let tool, NativePanel.tools.contains(tool) { model.panel = tool }
                }
            }
        }
        .background(NativeEditorStyle.background)
        .foregroundStyle(NativeEditorStyle.text)
        .nativeNeutralTint()
        .preferredColorScheme(.dark)
        #if os(iOS)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { dismissCompactKeyboard() }
                    .accessibilityLabel("Dismiss keyboard")
            }
        }
        .sensoryFeedback(trigger: model.hapticSignal) { _, signal -> SensoryFeedback? in
            guard scenePhase == .active, NativeHapticAvailability.supported, NativeHapticPolicy.enabled() else { return nil }
            switch signal.kind {
            case .selection: return .selection
            case .snap: return .impact(flexibility: .rigid, intensity: 0.45)
            case .commit: return .impact(weight: .light, intensity: 0.5)
            case .success: return .success
            case nil: return nil
            }
        }
        #endif
        .background { mediaImportPresentation() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { model.requestFrame() } else { model.releasePreview() } }
        .onChange(of: session.projectReadOnlyReason) { old, next in if old != nil && next == nil { model.projectWritable() } }
        .onDisappear { model.discardRenderPreview(); model.pause(); model.pauseSource() }
        #if os(iOS)
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in model.releasePreview() }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in model.pause() }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)) { _ in model.pause() }
        #endif
    }

    // BEGIN IMPORT RESULT DISMISSAL
    private func mediaImportPresentation(panel: NativePanel? = nil) -> some View {
        let panelID = panel?.rawValue
        let active = model.mediaImportRequest.flatMap { $0.belongsToPresenter(panelID) ? $0.id : nil }
        let queued = model.mediaImportNavigation.flatMap { $0.context.panelID == panelID ? $0.requestID : nil }
        let ownerID = active ?? queued
        return Color.clear.frame(width: 0, height: 0)
            .sheet(item: mediaImportBinding(panel: panel, ownerID: ownerID), onDismiss: {
                guard let ownerID else { return }
                finishImportNavigation(requestID: ownerID, panel: panel)
            }) { request in
                NativeMediaImportSheet(session: session, model: model, request: request).id(request.id)
            }
            .id(ownerID)
    }

    private func finishImportNavigation(requestID: UUID, panel: NativePanel? = nil) {
        guard let next = NativeMediaImportNavigation.take(&model.mediaImportNavigation, panelID: panel?.rawValue, requestID: requestID) else { return }
        let context = NativeMediaImportNavigation.Context(generation: model.processingContextID,
            backendID: session.backend.map(ObjectIdentifier.init), rootPath: session.folder?.standardizedFileURL.path,
            composition: model.composition, panelID: model.mobilePanel?.rawValue)
        let asset: NativeAsset?
        switch next.destination {
        case .media: asset = nil
        case .source(let id): asset = model.project?.assets.first { $0.id == id && !$0.fields.flag("missing") }
        }
        guard model.project != nil, !model.busy, model.renderPreviewBackendID == context.backendID,
              next.canNavigate(context: context, importPending: model.mediaImportRequest != nil,
                  restorationPending: model.missingMediaRestoreRequest != nil,
                  restorationActive: model.restoringMediaSource != nil, sourceJSON: asset.map { JSON(any: $0.fields).text }) else { return }
        switch next.destination {
        case .media:
            model.importedMediaRevealID = UUID()
            if NativeMediaImportNavigation.revealMedia(mediaVisible: &mediaVisible, retainedMediaParent: model.mobilePanel == .media) {
                select(.media)
            }
        case .source:
            guard let asset else { return }
            model.openSource(asset)
            #if os(iOS)
            if model.mobilePanel == .media, model.showingSource, model.sourceAssetID == asset.id,
               model.sourceRange != nil, model.sourceError == nil { model.mobilePanel = nil }
            #endif
        }
    }
    // END IMPORT RESULT DISMISSAL

    private func mediaImportBinding(panel: NativePanel? = nil, ownerID: UUID?) -> Binding<NativeMediaImportRequest?> {
        let panelID = panel?.rawValue
        let requestID = ownerID
        return Binding(
            get: {
                guard let request = model.mediaImportRequest, request.belongsToPresenter(panelID),
                      NativeMediaImportNavigation.owns(requestID: request.id, presentationID: ownerID) else { return nil }
                return request
            },
            set: { next in
                // A stale dismissal from another presenter must not clear a new request.
                guard next == nil, model.mediaImportRequest?.canDismiss(fromRequestID: requestID, panelID: panelID) == true else { return }
                model.mediaImportRequest = nil
            }
        )
    }

    private func compactTaskBinding() -> Binding<NativePanel?> {
        let presented = model.mobilePanel
        return Binding(
            get: {
                guard let panel = model.mobilePanel, !NativeCompactWorkspaceRouting.inlineWorkspaces.contains(panel) else { return nil }
                return panel
            },
            set: { next in
                guard next == nil, model.mobilePanel == presented else { return }
                model.mobilePanel = nil
            }
        )
    }

    private func usesCompactLayout(size: CGSize) -> Bool {
        #if os(iOS)
        return NativeWorkspaceLayout.compact(width: size.width, height: size.height, mobile: true, accessibilityText: dynamicTypeSize.isAccessibilitySize)
        #else
        return false
        #endif
    }

    private var desktopWorkspace: some View {
        GeometryReader { workspace in
            desktopPanes(size: workspace.size)
        }
    }

    private func desktopPanes(size: CGSize) -> some View {
        let divider = NativeResizeDivider.thickness
        let layout = NativeWorkspaceLayout.desktop(width: size.width, height: size.height, divider: divider,
            media: mediaSize.wrappedValue, inspector: inspectorSize.wrappedValue, assistant: assistantWidth, timeline: timelineSize.wrappedValue,
            mediaVisible: desktopMediaVisible, inspectorVisible: inspectorVisible, assistantVisible: assistantVisible,
            timelineVisible: timelineVisible, mediaPage: model.panel == .media)

        return HStack(spacing: 0) {
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    if layout.showMedia {
                        panelFrame { NativeMediaPanel(model: model, session: session) }.frame(width: layout.mediaWidth)
                        NativeResizeDivider(value: mediaSize, range: 180...layout.mediaMaximum, vertical: true, label: "Media panel width")
                    }
                    panelFrame { NativeViewer(model: model) }.frame(width: layout.viewerWidth)
                    if layout.showInspector {
                        NativeResizeDivider(value: inspectorSize, range: 240...layout.inspectorMaximum, vertical: true, reversed: true, label: "Inspector width")
                        panelFrame { NativePanelView(panel: model.panel, model: model, session: session) }.frame(width: layout.inspectorWidth)
                    }
                }.frame(height: layout.viewerHeight)
                if timelineVisible {
                    NativeResizeDivider(value: timelineSize, range: layout.timelineRange, vertical: false, reversed: true, label: "Timeline height")
                    panelFrame { NativeTimeline(model: model, openMotion: { select(.motion) }) }.frame(height: layout.timelineHeight)
                }
            }
            .frame(width: layout.editingWidth, height: max(0, size.height - 12)).padding(6)
            if layout.showAssistant {
                NativeResizeDivider(value: $assistantWidth, range: 290...layout.assistantMaximum, vertical: true, reversed: true, label: "Assistant width")
                NativeAssistantPanel(assistant: session.assistant, model: model, openSettings: { settingsVisible = true }, close: { assistantVisible = false })
                    .frame(width: layout.assistantWidth, height: size.height, alignment: .topLeading)
                    .background(NativeEditorStyle.panel)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Editing workspace")
    }

    private var compactEditingPanel: NativePanel {
        if NativeCompactWorkspaceRouting.inlineWorkspaces.contains(model.panel) { return model.panel }
        return NativeCompactWorkspaceRouting.inlineWorkspaces.contains(lastEditingPanel) ? lastEditingPanel : .edit
    }

    #if os(iOS)
    private func mobileWorkspace(compact: Bool) -> some View {
        GeometryReader { workspace in
            let size = workspace.size
            let divider = NativeResizeDivider.thickness
            let expanded = compactToolsExpanded && model.drawing == nil && model.viewerColorPicker == nil
            let layout = NativeWorkspaceLayout.mobilePlacement(width: size.width, height: size.height, compact: compact,
                expanded: expanded, accessibilityText: dynamicTypeSize.isAccessibilitySize, divider: divider,
                media: compact ? mediaWidth : mediaSize.wrappedValue, inspector: inspectorSize.wrappedValue, assistant: assistantWidth, timeline: compact ? timelineHeight : timelineSize.wrappedValue,
                mediaVisible: compact ? mediaVisible : desktopMediaVisible, inspectorVisible: inspectorVisible, assistantVisible: assistantVisible,
                timelineVisible: timelineVisible, mediaPage: model.panel == .media, detailedControls: compactControlsDetailed)
            let origin = workspace.frame(in: .global).origin
            let timelineFrame = CGRect(x: origin.x + layout.timelineX, y: origin.y + layout.timelineY,
                                       width: layout.timelineWidth, height: layout.timelineHeight)
            let panelFrame = CGRect(x: origin.x + layout.panelX, y: origin.y + layout.panelY,
                                    width: layout.panelWidth, height: layout.panelHeight)
            // Expanded phone controls give the timeline's height to the picture.
            let timelineYieldsToPicture = compact && timelineVisible && layout.panelVisible && !layout.contextFocused && layout.timelineHeight <= 0
            let timelinePresented = timelineVisible && !layout.contextFocused && !timelineYieldsToPicture
            // These three children keep their structural identity through every iPad layout.
            ZStack(alignment: .topLeading) {
                NativeViewer(model: model, timelineVisible: timelinePresented, toggleTimeline: {
                    if timelineYieldsToPicture {
                        // Bring the timeline back by reducing the controls; the panel and its drafts stay open.
                        withAnimation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 1)) { compactControlsDetailed = false }
                    } else if layout.contextFocused {
                        setCompactToolsExpanded(false)
                        timelineVisible = true
                    } else {
                        timelineVisible.toggle()
                        if !timelineVisible { setCompactToolsExpanded(false) }
                    }
                })
                    .frame(width: layout.viewerWidth, height: layout.viewerHeight)
                    .background(NativeEditorStyle.panel)
                    .clipShape(RoundedRectangle(cornerRadius: compact ? 0 : 7))
                    .overlay { RoundedRectangle(cornerRadius: compact ? 0 : 7).stroke(compact ? .clear : NativeEditorStyle.line) }
                    .offset(x: layout.viewerX, y: layout.viewerY)
                compactTimeline(height: layout.timelineHeight, frame: timelineFrame, compact: compact, visible: timelinePresented)
                    .frame(width: layout.timelineWidth)
                    .clipShape(RoundedRectangle(cornerRadius: compact ? 0 : 7))
                    .overlay { RoundedRectangle(cornerRadius: compact ? 0 : 7).stroke(compact ? .clear : NativeEditorStyle.line) }
                    .offset(x: layout.timelineX, y: layout.timelineY)
                    .opacity(timelinePresented ? 1 : 0).allowsHitTesting(timelinePresented)
                    .accessibilityHidden(!timelinePresented)
                mobilePanelHost(compact: compact, height: layout.panelHeight, focused: layout.contextFocused,
                    canExpand: !layout.contextFocused && layout.panelWidth == size.width &&
                        NativeWorkspaceLayout.contextHeight(height: size.height, expanded: true, detailed: true) >
                        NativeWorkspaceLayout.contextHeight(height: size.height, expanded: true))
                    .environment(\.nativeContextInteractionsEnabled, layout.panelVisible)
                    .environment(\.nativeContextInteractionLayout, NativeContextInteractionLayout(frame: panelFrame, visible: layout.panelVisible))
                    .frame(width: layout.panelWidth, height: layout.panelHeight)
                    .clipped().clipShape(RoundedRectangle(cornerRadius: compact ? 0 : 7))
                    .overlay { RoundedRectangle(cornerRadius: compact ? 0 : 7).stroke(compact ? .clear : NativeEditorStyle.line) }
                    .offset(x: layout.panelX, y: layout.panelY)
                    .opacity(layout.panelVisible ? 1 : 0).allowsHitTesting(layout.panelVisible)
                    .accessibilityHidden(!layout.panelVisible)
                    .onChange(of: layout.panelVisible) { _, visible in
                        if !visible { dismissCompactKeyboard(); model.discardRenderPreview() }
                    }
                    .onChange(of: panelFrame) { _, _ in model.discardRenderPreview() }
                if compact {
                    if layout.compactDividerHeight > 0 {
                        Group {
                            if layout.canvasWidth >= 600 {
                                NativeResizeDivider(value: $timelineHeight,
                                    range: NativeWorkspaceLayout.compactTimelineRange(height: layout.canvasHeight, divider: layout.compactDividerHeight),
                                    vertical: false, reversed: true, label: "Timeline height")
                            } else { Rectangle().fill(NativeEditorStyle.line).accessibilityHidden(true) }
                        }.frame(width: layout.canvasWidth, height: layout.compactDividerHeight)
                            .offset(y: layout.viewerHeight)
                    }
                } else {
                    mobileDesktopAccessories(layout: layout, size: size)
                }
            }.frame(width: size.width, height: size.height, alignment: .topLeading).clipped()
                .accessibilityElement(children: .contain).accessibilityLabel("Editing workspace")
        }
    }

    private func mobilePanelHost(compact: Bool, height: Double, focused: Bool, canExpand: Bool) -> some View {
        let header = compact ? min(contextHeaderHeight, max(0, height)) : 0
        let body = compact ? NativeWorkspaceLayout.contextPanelHeight(height: height, header: header) : max(0, height)
        return VStack(spacing: 0) {
            mobileContextHeader(focused: focused, canExpand: canExpand)
                .frame(height: header).clipped().opacity(compact ? 1 : 0)
                .allowsHitTesting(compact).accessibilityHidden(!compact)
            Rectangle().fill(NativeEditorStyle.line).frame(height: compact ? min(1, max(0, height - header)) : 0)
            NativePanelView(panel: compact ? compactEditingPanel : model.panel, model: model, session: session,
                            sharedContextHeader: compact)
                .frame(maxWidth: .infinity, alignment: .topLeading).frame(height: body)
        }.background(NativeEditorStyle.panel).frame(height: height).accessibilityElement(children: .contain)
            .accessibilityLabel("Context controls").accessibilityIdentifier("editor.contextTray")
    }

    private func mobileContextHeader(focused: Bool, canExpand: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: compactEditingPanel.icon).foregroundStyle(NativeEditorStyle.accent).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(compactEditingPanel.name).font(.subheadline.weight(.semibold))
                Text(model.chosenClipCount > 1 ? "\(model.chosenClipCount) selected clips" : model.selected?.name ?? "Timeline settings")
                    .font(.caption).foregroundStyle(NativeEditorStyle.muted).lineLimit(1).truncationMode(.middle)
            }.frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine).accessibilityLabel("\(compactEditingPanel.name) controls")
                .accessibilityValue(model.chosenClipCount > 1 ? "\(model.chosenClipCount) selected clips" : model.selected?.name ?? "No selected clip")
            if model.selected != nil {
                NativeSelectionAIAction(model: model, assistant: session.assistant, title: "Ask AI",
                                        compact: dynamicTypeSize.isAccessibilitySize)
                    .buttonStyle(NativeToolbarButtonStyle())
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel(model.aiSelectionLabel)
                    .accessibilityIdentifier("editor.contextTray.askAI")
            }
            if canExpand {
                Button {
                    withAnimation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 1)) {
                        compactControlsDetailed.toggle()
                    }
                } label: {
                    Image(systemName: compactControlsDetailed ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                        .frame(width: 44, height: 44)
                }.buttonStyle(.plain)
                    .accessibilityLabel(compactControlsDetailed ? "Reduce controls" : "Expand controls")
                    .accessibilityHint("Changes control space while keeping the picture visible")
                    .accessibilityValue(compactControlsDetailed ? "Expanded" : "Compact")
                    .accessibilityIdentifier("editor.contextTray.expand")
            }
            Button { setCompactToolsExpanded(false) } label: {
                if focused {
                    Label(timelineVisible ? "Timeline" : "Viewer", systemImage: "arrow.left").font(.caption.weight(.semibold))
                        .padding(.horizontal, 8).frame(minHeight: 44)
                } else { Image(systemName: "chevron.down").frame(width: 44, height: 44) }
            }
                .buttonStyle(.plain).accessibilityLabel(focused ? (timelineVisible ? "Back to timeline" : "Back to viewer") : "Collapse \(compactEditingPanel.name) controls")
                .accessibilityHint("Keeps the workspace and current control drafts")
                .accessibilityIdentifier("editor.contextTray.collapse")
        }.padding(.leading, 12)
    }

    private func mobileDesktopAccessories(layout: NativeWorkspaceLayout.MobilePlacement, size: CGSize) -> some View {
        let desktop = layout.desktop
        let divider = NativeResizeDivider.thickness
        return ZStack(alignment: .topLeading) {
            if desktop.showMedia {
                panelFrame { NativeMediaPanel(model: model, session: session) }
                    .frame(width: desktop.mediaWidth, height: desktop.viewerHeight).offset(x: 6, y: 6)
                NativeResizeDivider(value: mediaSize, range: 180...desktop.mediaMaximum, vertical: true, label: "Media panel width")
                    .frame(width: divider, height: desktop.viewerHeight).offset(x: 6 + desktop.mediaWidth, y: 6)
            }
            if desktop.showInspector {
                NativeResizeDivider(value: inspectorSize, range: 240...desktop.inspectorMaximum, vertical: true, reversed: true, label: "Inspector width")
                    .frame(width: divider, height: desktop.viewerHeight).offset(x: layout.viewerX + desktop.viewerWidth, y: 6)
            }
            if timelineVisible {
                NativeResizeDivider(value: timelineSize, range: desktop.timelineRange, vertical: false, reversed: true, label: "Timeline height")
                    .frame(width: desktop.editingWidth, height: divider).offset(x: 6, y: 6 + desktop.viewerHeight)
            }
            if desktop.showAssistant {
                NativeResizeDivider(value: $assistantWidth, range: 290...desktop.assistantMaximum, vertical: true, reversed: true, label: "Assistant width")
                    .frame(width: divider, height: size.height).offset(x: size.width - desktop.assistantWidth - divider)
                NativeAssistantPanel(assistant: session.assistant, model: model, openSettings: { settingsVisible = true }, close: { assistantVisible = false })
                    .frame(width: desktop.assistantWidth, height: size.height, alignment: .topLeading)
                    .background(NativeEditorStyle.panel).offset(x: size.width - desktop.assistantWidth)
            }
        }.frame(width: size.width, height: size.height, alignment: .topLeading)
    }
    #endif

    private var compactWorkspace: some View {
        GeometryReader { workspace in
            let size = workspace.size
            let expanded = compactToolsExpanded && model.drawing == nil && model.viewerColorPicker == nil
            let beside = NativeWorkspaceLayout.contextBeside(width: size.width, height: size.height, accessibilityText: dynamicTypeSize.isAccessibilitySize)
            let trayWidth = beside ? NativeWorkspaceLayout.contextWidth(width: size.width) : size.width
            let trayHeight = expanded ? (beside ? size.height : NativeWorkspaceLayout.contextHeight(height: size.height, expanded: true)) : 0
            let separator = expanded ? min(6, beside ? size.width : max(0, size.height - trayHeight)) : 0
            let editingWidth = max(0, size.width - (beside && expanded ? trayWidth + separator : 0))
            let editingHeight = max(0, size.height - (!beside && expanded ? trayHeight + separator : 0))
            // Stable siblings retain the active panel's local drafts when the tray
            // collapses or moves from below the picture to beside it on iPad.
            ZStack(alignment: .topLeading) {
                compactCanvas(size: CGSize(width: editingWidth, height: editingHeight), origin: workspace.frame(in: .global).origin)
                    .frame(width: editingWidth, height: editingHeight)
                compactContextTray(height: trayHeight)
                    .frame(width: trayWidth, height: trayHeight)
                    .clipped()
                    .opacity(expanded ? 1 : 0)
                    .allowsHitTesting(expanded)
                    .accessibilityHidden(!expanded)
                    .offset(x: beside && expanded ? editingWidth + separator : 0,
                            y: !beside && expanded ? editingHeight + separator : 0)
            }.frame(width: size.width, height: size.height, alignment: .topLeading)
        }
    }

    private func compactCanvas(size: CGSize, origin: CGPoint) -> some View {
        let layout = NativeWorkspaceLayout.compactCanvas(width: size.width, height: size.height,
            timeline: timelineHeight, visible: timelineVisible, touchDivider: NativeResizeDivider.thickness)
        let range = NativeWorkspaceLayout.compactTimelineRange(height: size.height, divider: layout.dividerHeight)
        // These exact viewer/timeline siblings survive every size and axis change.
        return ZStack(alignment: .topLeading) {
            NativeViewer(model: model)
                .frame(width: layout.viewerWidth, height: layout.viewerHeight)
            compactTimeline(height: layout.timelineHeight,
                frame: CGRect(x: origin.x + layout.timelineX, y: origin.y + layout.timelineY,
                              width: layout.timelineWidth, height: layout.timelineHeight))
                .frame(width: layout.timelineWidth)
                .offset(x: layout.timelineX, y: layout.timelineY)
                .opacity(timelineVisible ? 1 : 0)
                .allowsHitTesting(timelineVisible)
                .accessibilityHidden(!timelineVisible)
            if layout.dividerHeight > 0 {
                Group {
                    if size.width >= 600 {
                        NativeResizeDivider(value: $timelineHeight, range: range, vertical: false, reversed: true, label: "Timeline height")
                    } else { Rectangle().fill(NativeEditorStyle.line).accessibilityHidden(true) }
                }.frame(width: size.width, height: layout.dividerHeight)
                    .offset(y: layout.viewerHeight)
            }
        }.frame(width: size.width, height: size.height, alignment: .topLeading).clipped()
    }

    private func compactTimeline(height: Double, frame: CGRect, compact: Bool = true, visible: Bool? = nil) -> some View {
        let minimum = max(compactTimelineMinimum, dynamicTypeSize.isAccessibilitySize ? 240.0 : 196.0)
        // Keep one timeline instance. Its local viewport can reveal every toolbar,
        // precision control and track even when the keyboard leaves a very short pane.
        return ScrollView(.vertical) {
            #if os(iOS)
            NativeTimeline(model: model, openMotion: { select(.motion, compact: compact) }, interactionLayout: .init(frame: frame, visible: visible ?? timelineVisible))
                .frame(height: max(minimum, height))
            #else
            NativeTimeline(model: model, openMotion: { select(.motion, compact: compact) }).frame(height: max(minimum, height))
            #endif
        }.frame(height: height).clipped()
    }

    private func compactContextTray(height: Double) -> some View {
        let panelHeight = NativeWorkspaceLayout.contextPanelHeight(height: height, header: contextHeaderHeight)
        return ScrollView(.vertical) {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: compactEditingPanel.icon).foregroundStyle(NativeEditorStyle.accent)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(compactEditingPanel.name).font(.subheadline.weight(.semibold))
                    Text(model.chosenClipCount > 1 ? "\(model.chosenClipCount) selected clips" : model.selected?.name ?? "Timeline settings")
                        .font(.caption).foregroundStyle(NativeEditorStyle.muted).lineLimit(1).truncationMode(.middle)
                }.frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(compactEditingPanel.name) controls")
                    .accessibilityValue(model.chosenClipCount > 1 ? "\(model.chosenClipCount) selected clips" : model.selected?.name ?? "No selected clip")
                Button { setCompactToolsExpanded(false) } label: {
                    Image(systemName: "chevron.down").frame(width: 44, height: 44)
                }.buttonStyle(.plain).accessibilityLabel("Collapse \(compactEditingPanel.name) controls")
                    .accessibilityHint("Keeps the workspace and current control drafts")
                    .accessibilityIdentifier("editor.contextTray.collapse")
            }.padding(.leading, 12).frame(height: contextHeaderHeight)
            Rectangle().fill(NativeEditorStyle.line).frame(height: 1)
            // Keep the active view mounted, including when the tray has zero height.
            NativePanelView(panel: compactEditingPanel, model: model, session: session)
                .frame(maxWidth: .infinity, alignment: .topLeading).frame(height: panelHeight)
        }.background(NativeEditorStyle.panel)
        }.frame(height: height)
            .accessibilityElement(children: .contain).accessibilityLabel("Context controls")
            .accessibilityIdentifier("editor.contextTray")
    }

    private func setCompactToolsExpanded(_ expanded: Bool) {
        if expanded && model.showingSource { model.showingSource = false }
        if !expanded {
            dismissCompactKeyboard()
            model.discardRenderPreview()
        }
        withAnimation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 1)) {
            compactToolsExpanded = expanded
            if !expanded { compactControlsDetailed = false }
        }
        if !expanded { compactWorkspaceFocused = compactEditingPanel }
    }

    private func dismissCompactKeyboard() {
        #if os(iOS)
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        #endif
    }

    private var inspectorSize: Binding<Double> {
        switch model.panel {
        case .color: return $colorWidth
        case .motion: return $motionWidth
        // The mixer needs room for several channel strips beside Master.
        case .audio: return $audioWidth
        default: return $inspectorWidth
        }
    }

    // Color keeps a short clip timeline, as Resolve does, so the picture, scopes and wheels share
    // the window. It has its own saved height and hides the media column.
    private var timelineSize: Binding<Double> {
        switch model.panel {
        case .color: return $colorTimelineHeight
        // The Media page gives the browser more height, as Final Cut's browser does above its timeline.
        case .media: return $mediaTimelineHeight
        default: return $timelineHeight
        }
    }
    // The Media page always shows the browser, at its own saved width.
    private var desktopMediaVisible: Bool {
        switch model.panel {
        case .media: return true
        case .color: return colorMediaVisible
        default: return mediaVisible
        }
    }
    /// What Show media changes on the current page. The Media page always shows its browser.
    private var mediaToggle: Binding<Bool> {
        switch model.panel {
        case .media: return .constant(true)
        case .color: return $colorMediaVisible
        default: return $mediaVisible
        }
    }
    private var mediaSize: Binding<Double> { model.panel == .media ? $mediaPageWidth : $mediaWidth }

    private func panelFrame<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .background(NativeEditorStyle.panel)
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay { RoundedRectangle(cornerRadius: 7).stroke(NativeEditorStyle.line, lineWidth: 1) }
    }

    private func header(compact: Bool, width: Double) -> some View {
        #if os(macOS)
        return desktopHeader(width: width)
        #else
        let narrow = NativeWorkspaceLayout.stackedHeader(width: width, compact: compact, accessibilityText: dynamicTypeSize.isAccessibilitySize)
        let stacked = width < 1500
        return VStack(spacing: 0) {
            if narrow {
                compositionMenu(compact: compact)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                headerActions(compact: compact, width: width)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.horizontal, 6)
            } else {
                HStack(spacing: 8) {
                    if !compact || width >= 600 {
                        NativeBrandWordmark()
                            .frame(width: 82, height: 38)
                            .fixedSize()
                    }
                    compositionMenu(compact: compact)
                        .frame(minWidth: compact ? 80 : 180, idealWidth: 260, maxWidth: stacked ? .infinity : 280, alignment: .leading)
                        .layoutPriority(1)
                    if !compact && !stacked {
                        workflowPages.frame(minWidth: 180, idealWidth: 300, maxWidth: 470)
                    }
                    Spacer(minLength: 0)
                    headerActions(compact: compact, width: width).layoutPriority(2)
                }.padding(.horizontal, 12)
            }
            if !compact && (stacked || narrow) {
                workflowPages.padding(.horizontal, 12).padding(.bottom, 7)
            }
        }
        .padding(.vertical, compact ? 4 : 3)
        .background(NativeEditorStyle.background)
        #endif
    }

    #if os(macOS)
    private func desktopHeader(width: Double) -> some View {
        HStack(spacing: 8) {
            NativeBrandWordmark().frame(width: 72, height: 32).fixedSize()
            compositionMenu(compact: false)
                .frame(minWidth: 120, idealWidth: 200, maxWidth: width >= 1180 ? 250 : .infinity, alignment: .leading)
                .layoutPriority(1)
            if width >= 1180 {
                desktopWorkflowPages
            } else {
                Menu {
                    ForEach(NativePanel.workflow) { panel in
                        Button { select(panel) } label: { Label(panel.name, systemImage: panel.icon) }
                            .keyboardShortcut(KeyEquivalent(Character(String((NativePanel.workflow.firstIndex(of: panel) ?? 0) + 1))), modifiers: [.shift])
                    }
                } label: {
                    Label(model.panel.name, systemImage: model.panel.icon)
                        .font(.system(size: 12, weight: .semibold)).lineLimit(1)
                }
                .menuStyle(.borderlessButton)
                .fixedSize(horizontal: true, vertical: false)
                .frame(minHeight: 30)
                .accessibilityLabel("Choose workflow")
                .accessibilityValue(model.panel.name)
                .accessibilityIdentifier("editor.workflowMenu")
            }
            Spacer(minLength: 0)
            desktopHeaderActions(width: width).fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .background(NativeEditorStyle.background)
    }

    private var desktopWorkflowPages: some View {
        HStack(spacing: 2) {
            ForEach(NativePanel.workflow) { panel in
                Button { select(panel) } label: { Text(panel.name).fixedSize() }
                    .buttonStyle(NativeDesktopChromeButtonStyle(selected: model.panel == panel))
                    .keyboardShortcut(KeyEquivalent(Character(String((NativePanel.workflow.firstIndex(of: panel) ?? 0) + 1))), modifiers: [.shift])
                    .accessibilityLabel("\(panel.name) workflow")
                    .accessibilityAddTraits(model.panel == panel ? [.isSelected] : [])
            }
        }
        .padding(2)
        .background(NativeEditorStyle.input, in: RoundedRectangle(cornerRadius: 6))
        .overlay { RoundedRectangle(cornerRadius: 6).stroke(NativeEditorStyle.line) }
        .accessibilityElement(children: .contain).accessibilityLabel("Workflow")
    }

    private func desktopHeaderActions(width: Double) -> some View {
        HStack(spacing: 2) {
            Button { model.undo() } label: { Image(systemName: "arrow.uturn.backward") }
                .help("Undo latest edit (⌘Z)").accessibilityLabel("Undo")
            Button { model.undo(redo: true) } label: { Image(systemName: "arrow.uturn.forward") }
                .help("Redo (⇧⌘Z)").accessibilityLabel("Redo")
            Rectangle().fill(NativeEditorStyle.line).frame(width: 1, height: 18).padding(.horizontal, 4)
            Button { model.showFiles = true } label: { Image(systemName: "square.and.arrow.down") }
                .help("Import media").accessibilityLabel("Import media")
                .accessibilityIdentifier("editor.importMedia")
            Button { libraryVisible = true } label: { Image(systemName: "books.vertical") }
                .help("Project library").accessibilityLabel("Project library")
            if model.selected != nil || model.composition != nil {
                NativeSelectionAIAction(model: model, assistant: session.assistant, compact: true)
            }
            Menu {
                Toggle("Show media", isOn: mediaToggle).keyboardShortcut("1", modifiers: [.command, .option])
                    .disabled(model.panel == .media)
                Toggle("Show inspector", isOn: $inspectorVisible).keyboardShortcut("2", modifiers: [.command, .option])
                Toggle("Show timeline", isOn: $timelineVisible).keyboardShortcut("3", modifiers: [.command, .option])
                Divider()
                Button("Edit layout") { setLayout("edit") }
                Button("Motion layout") { setLayout("motion") }
                Button("Color layout") { setLayout("color") }
                Button("Viewer layout") { setLayout("viewer") }
                Button("Reset layout") { resetLayout() }
            } label: { Image(systemName: "rectangle.split.3x1") }
                .menuStyle(.borderlessButton).frame(width: 30, height: 30)
                .help("Pane visibility and workspace layouts").accessibilityLabel("Workspace layout")
                .accessibilityIdentifier("editor.layoutMenu")
            Button { settingsVisible = true } label: { Image(systemName: "gearshape") }
                .keyboardShortcut(",", modifiers: [.command])
                .help("Settings (⌘,)").accessibilityLabel("Settings")
            Button { assistantVisible.toggle() } label: {
                if width >= 1180 { Label("Assistant", systemImage: "text.bubble") }
                else { Image(systemName: "text.bubble") }
            }
                .buttonStyle(NativeDesktopChromeButtonStyle(selected: assistantVisible))
                .keyboardShortcut("a", modifiers: [.command, .option])
                .help("Show Assistant beside the edit (⌥⌘A)").accessibilityLabel("Assistant")
                .accessibilityValue(assistantVisible ? "Open" : "Closed")
            workspaceMenu(compact: false)
        }.buttonStyle(NativeDesktopChromeButtonStyle())
    }
    #endif

    #if os(macOS)
    private var desktopCompositionName: String {
        guard let id = model.composition else { return "Main timeline" }
        return model.project?.compositions.first { $0.id == id }?.name ?? "Composition unavailable"
    }
    #endif

    private func compositionMenu(compact: Bool) -> some View {
        Menu {
            Button("Main timeline") { model.composition = nil }
            ForEach(model.project?.compositions ?? []) { comp in Button(comp.name) { model.composition = comp.id } }
            Divider()
            Button("New composition") { model.edit(["op": "add_comp", "name": "Composition \((model.project?.compositions.count ?? 0) + 1)"]) }
        } label: {
            HStack(spacing: 5) {
                #if os(macOS)
                // A borderless Mac menu keeps one text label and draws its own indicator,
                // so a second chevron or a stacked label renders as "⌄ Name ⌄".
                Text(model.composition == nil ? model.project?.name ?? "Opening project"
                     : "\(model.project?.name ?? "Opening project") · \(desktopCompositionName)")
                    .font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                #else
                Text(model.project?.compositions.first { $0.id == model.composition }?.name ?? model.project?.name ?? "Opening project")
                    .font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(NativeEditorStyle.muted)
                #endif
            }
            #if os(macOS)
            .frame(minHeight: 30)
            #else
            .frame(minHeight: NativeEditorStyle.minimumControlHeight)
            #endif
        }
        #if os(macOS)
        .menuStyle(.borderlessButton)
        .help("Project: \(model.project?.name ?? "Opening project")\nTimeline: \(desktopCompositionName)")
        .accessibilityLabel("Project and timeline or composition")
        .accessibilityValue("\(model.project?.name ?? "Opening project"), \(desktopCompositionName)")
        #else
        .help("Switch timeline or composition")
        .accessibilityLabel("Timeline or composition")
        .accessibilityValue(model.project?.compositions.first { $0.id == model.composition }?.name ?? model.project?.name ?? "Opening project")
        #endif
        .accessibilityIdentifier("editor.composition")
    }

    private var workflowPages: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(NativePanel.workflow) { panel in
                    Button { select(panel) } label: { Text(panel.name).lineLimit(1).fixedSize(horizontal: true, vertical: false).padding(.horizontal, 1) }
                        .buttonStyle(NativeToolbarButtonStyle(selected: model.panel == panel))
                        .keyboardShortcut(KeyEquivalent(Character(String((NativePanel.workflow.firstIndex(of: panel) ?? 0) + 1))), modifiers: [.shift])
                        .accessibilityLabel("\(panel.name) workflow")
                        .accessibilityAddTraits(model.panel == panel ? [.isSelected] : [])
                }
            }.padding(3)
        }
        .frame(maxWidth: .infinity).fixedSize(horizontal: false, vertical: true)
        .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 7))
        .overlay { RoundedRectangle(cornerRadius: 7).stroke(NativeEditorStyle.line) }
        .accessibilityElement(children: .contain).accessibilityLabel("Workflow")
    }

    private func headerActions(compact: Bool, width: Double) -> some View {
        let iconActions = compact || width < 920
        return HStack(spacing: 2) {
            if !compact {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    Button { model.undo() } label: { Image(systemName: "arrow.uturn.backward") }
                        .help("Undo latest edit").accessibilityLabel("Undo")
                    Button { model.undo(redo: true) } label: { Image(systemName: "arrow.uturn.forward") }
                        .help("Redo").accessibilityLabel("Redo")
                    if !compact {
                        Button { libraryVisible = true } label: { Image(systemName: "books.vertical") }
                            .help("Project titles, transitions, effects and motion").accessibilityLabel("Project library")
                        if model.selected != nil || model.composition != nil {
                            NativeSelectionAIAction(model: model, assistant: session.assistant, compact: true)
                        }
                    }
                }.fixedSize(horizontal: true, vertical: false)
            }
            .frame(minWidth: 40, idealWidth: compact ? 80 : 240, maxWidth: compact ? 120 : 260)
            #if os(iOS)
            .frame(height: CGFloat(max(Double(NativeEditorStyle.minimumControlHeight), contextHeaderHeight)))
            #else
            .frame(height: NativeEditorStyle.minimumControlHeight)
            #endif
            .accessibilityElement(children: .contain).accessibilityLabel("Editing actions")
            }
            HStack(spacing: 2) {
                if !compact {
                    Button { model.showFiles = true } label: { Image(systemName: "square.and.arrow.down") }
                        .help("Import from Photos, Files or a folder").accessibilityLabel("Import media")
                        .accessibilityIdentifier("editor.importMedia")
                }
                if !compact {
                    Button { settingsVisible = true } label: {
                        if iconActions { Image(systemName: "gearshape") }
                        else { Label("Settings", systemImage: "gearshape").labelStyle(.titleAndIcon) }
                    }.keyboardShortcut(",", modifiers: [.command]).help("Assistant accounts and Figma settings")
                        .accessibilityLabel("Settings")
                }
                if compact {
                    Button { model.undo() } label: { Image(systemName: "arrow.uturn.backward") }
                        .help("Undo latest edit").accessibilityLabel("Undo")
                } else {
                Button {
                    assistantVisible.toggle()
                } label: {
                    if iconActions { Image(systemName: "text.bubble") }
                    else { Label("Assistant", systemImage: "text.bubble").labelStyle(.titleAndIcon) }
                }
                    .buttonStyle(NativeToolbarButtonStyle(selected: compact ? model.mobilePanel == .assistant : assistantVisible))
                    .accessibilityLabel("Assistant")
                    .accessibilityValue((compact ? model.mobilePanel == .assistant : assistantVisible) ? "Open" : "Closed")
                    .help("Show Assistant beside the edit")
                }
                workspaceMenu(compact: compact)
            }.fixedSize(horizontal: true, vertical: false).layoutPriority(2)
        }
        .buttonStyle(NativeToolbarButtonStyle())
        .frame(maxWidth: compact ? nil : 520)
        .fixedSize(horizontal: compact, vertical: true)
    }

    private func workspaceMenu(compact: Bool) -> some View {
        // Everything the menu can do. On a phone this sits under More, below the few actions
        // people reach for while editing; Undo already has its own header button.
        @ViewBuilder func allCommands() -> some View {
            Section("Project") {
                Button("New project", action: newProject).keyboardShortcut("n", modifiers: [.command])
                Button("Open project folder", action: openFolder).keyboardShortcut("o", modifiers: [.command])
                Button("Close project") { session.close() }
                Button("Recover saved project…") { session.offerProjectRecovery() }
                if !compact, session.projectReadOnlyReason != nil { Button("Retry project access") { session.retryProjectAccess() } }
            }
            Section("Tools") {
                if !compact {
                    Button("Import media") { model.showFiles = true }
                        .keyboardShortcut("i", modifiers: [.command])
                        .accessibilityIdentifier("editor.importMedia")
                    Button("Project library") { libraryVisible = true }
                }
                Button("Figma") { select(.figma, compact: compact) }
                Button("Transcript") { select(.transcript, compact: compact) }
                if compact { Button("Settings") { settingsVisible = true }.keyboardShortcut(",", modifiers: [.command]) }
            }
            Section("Layout") {
                Toggle("Show timeline", isOn: $timelineVisible)
                if compact {
                    Menu("Timeline size") {
                        Button("Compact") { timelineHeight = 140 }
                        Button("Balanced") { timelineHeight = 200 }
                        Button("Large") { timelineHeight = 300 }
                    }
                } else {
                    Toggle("Show media", isOn: mediaToggle).disabled(model.panel == .media)
                    Toggle("Show inspector", isOn: $inspectorVisible)
                    Toggle("Show Assistant", isOn: $assistantVisible)
                }
                Menu("Workspace layout") {
                    Button("Edit") { setLayout("edit") }
                    Button("Motion") { setLayout("motion") }
                    Button("Color") { setLayout("color") }
                    Button("Viewer") { setLayout("viewer") }
                    Button("Reset layout") { resetLayout() }
                }
            }
            Section {
                Toggle("Web editor", isOn: $session.useWebEditor)
                Button("Reload editor") { session.reloadEditor() }
            }
        }
        return Menu {
            if compact {
                Button { model.showFiles = true } label: { Label("Import media", systemImage: "square.and.arrow.down") }
                    .keyboardShortcut("i", modifiers: [.command])
                    .accessibilityIdentifier("editor.importMedia")
                Button { model.undo(redo: true) } label: { Label("Redo", systemImage: "arrow.uturn.forward") }
                Button { select(.assistant, compact: true) } label: { Label("Assistant", systemImage: "text.bubble") }
                Button { libraryVisible = true } label: { Label("Project library", systemImage: "books.vertical") }
                Button { setCompactToolsExpanded(!compactToolsExpanded) } label: {
                    Label(compactToolsExpanded ? "Hide controls" : "Show controls", systemImage: "slider.horizontal.3")
                }
                if session.projectReadOnlyReason != nil {
                    Button { session.retryProjectAccess() } label: { Label("Retry project access", systemImage: "arrow.clockwise") }
                }
                Divider()
                Menu { allCommands() } label: { Label("More", systemImage: "ellipsis.circle") }
            } else {
                allCommands()
            }
        } label: {
            if compact {
                Label("Tools", systemImage: "ellipsis").font(.subheadline.weight(.medium))
                    .frame(minWidth: 64, minHeight: 44)
            } else { Image(systemName: "ellipsis") }
        }
            #if os(macOS)
            .frame(width: 30, height: 30)
            #else
            .frame(minWidth: NativeEditorStyle.minimumControlHeight, minHeight: NativeEditorStyle.minimumControlHeight)
            #endif
            #if os(macOS)
            .menuStyle(.borderlessButton)
            #endif
            .help("Project tools and workspace layout").accessibilityLabel(compact ? "Tools and project menu" : "Project and workspace menu")
            .accessibilityIdentifier("editor.workspaceMenu")
    }

    private func compactPanels(width: Double) -> some View {
        let columns = NativeWorkspaceLayout.compactWorkflowColumns(width: width, itemWidth: compactWorkflowItemWidth)
        let selected = model.mobilePanel.flatMap { NativePanel.workflow.contains($0) ? $0 : nil } ?? compactEditingPanel
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 44), spacing: 2), count: columns), spacing: 2) {
            ForEach(NativePanel.workflow) { panel in
                Button { select(panel, compact: true) } label: {
                    VStack(spacing: 2) {
                        Image(systemName: panel.icon).font(.body).accessibilityHidden(true)
                        Text(panel.name).font(.caption2.weight(.semibold)).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(selected == panel ? NativeEditorStyle.accent : NativeEditorStyle.muted)
                .background(selected == panel ? NativeEditorStyle.selectionFill : .clear, in: RoundedRectangle(cornerRadius: 6))
                .overlay { RoundedRectangle(cornerRadius: 6).stroke(selected == panel ? NativeEditorStyle.accent.opacity(0.38) : .clear) }
                .keyboardShortcut(KeyEquivalent(Character(String((NativePanel.workflow.firstIndex(of: panel) ?? 0) + 1))), modifiers: [.shift])
                .accessibilityLabel("\(panel.name) workflow")
                .accessibilityAddTraits(selected == panel ? [.isSelected] : [])
                .accessibilityFocused($compactWorkspaceFocused, equals: panel)
                .accessibilityIdentifier("editor.compact.workflow.\(panel.rawValue)")
            }
        }
        .padding(.horizontal, 6).padding(.vertical, 6)
        .background(NativeEditorStyle.panel)
        .accessibilityElement(children: .contain).accessibilityLabel("Workflow")
    }

    private func showRequestedWorkspace(compact: Bool) {
        guard let panel = model.requestedWorkspace else { return }
        model.requestedWorkspace = nil
        if !compact { model.mobilePanel = nil }
        select(panel, compact: compact)
    }

    private func select(_ panel: NativePanel, compact: Bool = false) {
        if panel == .assistant && !compact {
            assistantVisible = true
            return
        }
        if compact {
            if NativeCompactWorkspaceRouting.inlineWorkspaces.contains(panel) {
                model.mobilePanel = nil
                model.panel = panel
                lastEditingPanel = panel
                setCompactToolsExpanded(true)
            } else {
                // Task presentation never changes the active editing workspace.
                dismissCompactKeyboard()
                model.mobilePanel = panel
            }
            return
        }
        model.panel = panel
        if panel == .media { mediaVisible = true }
        else { inspectorVisible = true }
    }

    private func setLayout(_ name: String) {
        mediaWidth = 220; inspectorWidth = 300
        if name == "color" { colorWidth = 520; colorTimelineHeight = 170; colorMediaVisible = false }
        if name == "motion" { motionWidth = 520 }
        // Color keeps its own timeline height; the other pages share one.
        if name != "color" { timelineHeight = name == "motion" ? 180 : 260 }
        mediaVisible = name == "edit"; inspectorVisible = name != "viewer"; timelineVisible = name != "viewer"
        if name == "color" { model.panel = .color }
        else if name == "motion" { model.panel = .motion }
        else if name == "edit" { model.panel = .edit }
    }

    /// Every saved pane size and visibility goes back to its default.
    private func resetLayout() {
        setLayout("edit")
        colorWidth = 520; motionWidth = 520; audioWidth = 520
        colorTimelineHeight = 170; mediaTimelineHeight = 200; mediaPageWidth = 620; colorMediaVisible = false
        assistantWidth = 320; assistantVisible = false
    }
}

#if os(macOS)
private struct NativeDesktopChromeButtonStyle: ButtonStyle {
    var selected = false

    func makeBody(configuration: Configuration) -> some View {
        ChromeButton(configuration: configuration, selected: selected)
    }

    private struct ChromeButton: View {
        let configuration: ButtonStyleConfiguration
        let selected: Bool
        @Environment(\.isEnabled) private var enabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovered = false

        var body: some View {
            configuration.label
                .font(.system(size: 12, weight: selected ? .semibold : .medium))
                .foregroundStyle(selected ? NativeEditorStyle.accent : NativeEditorStyle.text)
                .padding(.horizontal, 8).frame(minWidth: 30, minHeight: 30)
                .background(selected ? NativeEditorStyle.selectionFill : hovered ? NativeEditorStyle.panelRaised : .clear)
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).stroke(selected ? NativeEditorStyle.accent.opacity(0.38) : hovered ? NativeEditorStyle.line : .clear) }
                .opacity(enabled ? 1 : 0.4)
                .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
                .contentShape(Rectangle()).onHover { hovered = $0 }
        }
    }
}
#endif

private struct NativeResizeDivider: View {
    static var thickness: Double {
        #if os(iOS)
        return 44
        #else
        return 6
        #endif
    }
    @Binding var value: Double
    let range: ClosedRange<Double>
    let vertical: Bool
    var reversed = false
    let label: String
    @State private var origin: Double?
    @State private var hovered = false
    var body: some View {
        Rectangle().fill(hovered ? NativeEditorStyle.accent.opacity(0.20) : NativeEditorStyle.background)
            .overlay { Capsule().fill(hovered ? NativeEditorStyle.accent : NativeEditorStyle.muted.opacity(0.4)).frame(width: vertical ? 2 : 28, height: vertical ? 28 : 2) }
            .frame(width: vertical ? Self.thickness : nil, height: vertical ? nil : Self.thickness)
            .contentShape(Rectangle())
            .onHover { next in
                guard hovered != next else { return }
                hovered = next
                #if os(macOS)
                if next { (vertical ? NSCursor.resizeLeftRight : NSCursor.resizeUpDown).push() }
                else { NSCursor.pop() }
                #endif
            }
            .onDisappear {
                #if os(macOS)
                if hovered { NSCursor.pop() }
                #endif
                hovered = false
            }
            .gesture(DragGesture(minimumDistance: 0).onChanged { gesture in
                if origin == nil { origin = min(range.upperBound, max(range.lowerBound, value)) }
                let delta = vertical ? gesture.translation.width : gesture.translation.height
                value = min(range.upperBound, max(range.lowerBound, (origin ?? value) + delta * (reversed ? -1 : 1)))
            }.onEnded { _ in origin = nil })
            .accessibilityLabel(label)
            .accessibilityValue("\(Int(min(range.upperBound, max(range.lowerBound, value)))) points")
            .accessibilityAdjustableAction { direction in
                let current = min(range.upperBound, max(range.lowerBound, value))
                value = min(range.upperBound, max(range.lowerBound, current + (direction == .increment ? 20 : -20)))
            }
    }
}

private struct NativeEditorPreferences: View {
    @ObservedObject var session: EditorSession
    @Environment(\.dismiss) private var dismiss
    @State private var section = "assistant"
    @State private var gettingStartedVisible = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Settings").font(.system(size: 17, weight: .semibold))
                Spacer()
                Button("Done") { dismiss() }.buttonStyle(NativeToolbarButtonStyle())
            }.padding(.horizontal, 18).padding(.top, 8)
            Picker("Settings category", selection: $section) {
                Text("Assistant accounts").tag("assistant")
                Text("Figma").tag("figma")
                #if os(iOS)
                Text("Interaction").tag("interaction")
                #endif
            }.pickerStyle(.segmented).padding(.horizontal, 18).padding(.vertical, 12)
            Button { gettingStartedVisible = true } label: {
                Text("Getting started")
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .padding(.horizontal, 18)
            .accessibilityIdentifier("settings.gettingStarted")
            Rectangle().fill(NativeEditorStyle.line).frame(height: 1)
            if section == "assistant" { NativeAssistantSettings(assistant: session.assistant) }
            else if section == "figma" { NativeFigmaSettings(figma: session.figma) }
            #if os(iOS)
            if section == "interaction" { NativeInteractionPreferences() }
            #endif
        }
        #if os(macOS)
        .frame(minWidth: 320, idealWidth: 560, minHeight: 480, idealHeight: 620)
        #else
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        #endif
        .background(NativeEditorStyle.panel)
        .sheet(isPresented: $gettingStartedVisible) { NativeGettingStartedSheet() }
    }
}

#if os(iOS)
private struct NativeInteractionPreferences: View {
    @AppStorage(NativeHapticPolicy.preferenceKey) private var hapticsEnabled = true
    var body: some View {
        Form {
            Section("Touch feedback") {
                Toggle("Editing haptics", isOn: $hapticsEnabled)
                    .disabled(!NativeHapticAvailability.supported)
                Text(NativeHapticAvailability.supported
                     ? "Feel a light response when selecting a clip, finding a snap point or finishing an edit. Successful imports and exports have a completion cue."
                     : "This device has no built-in editing haptics. Selection, snap guides and completion messages provide the same editing cues visually.")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("Scrubbing stays smooth and silent. Arya adds no extra feedback to standard switches or sliders.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }.scrollContentBackground(.hidden)
    }
}
#endif

struct NativePanelView: View {
    let panel: NativePanel
    @ObservedObject var model: NativeEditorModel
    @ObservedObject var session: EditorSession
    var sharedContextHeader = false

    var body: some View {
        switch panel {
        case .media: NativeMediaPanel(model: model, session: session)
        case .edit: NativeInspector(model: model)
        case .color:
            #if os(macOS)
            macContextPanel { NativeColorPanel(model: model, session: session) }
            #else
            NativeColorPanel(model: model, session: session, sharedContextHeader: sharedContextHeader)
            #endif
        case .audio: NativeAudioPanel(model: model)
        case .motion:
            #if os(macOS)
            macContextPanel { NativeMotionPanel(model: model) }
            #else
            NativeMotionPanel(model: model, sharedContextHeader: sharedContextHeader)
            #endif
        case .deliver: NativeDeliverPanel(model: model, session: session)
        case .assistant: NativeAssistantPanel(assistant: session.assistant, model: model)
        case .figma: NativeFigmaPanel(session: session, model: model)
        case .transcript: NativeTranscriptPanel(model: model, session: session)
        }
    }

    #if os(macOS)
    private func macContextPanel<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            macWorkflowContext
            Divider().overlay(NativeEditorStyle.line)
            content().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var macWorkflowContext: some View {
        let clip: NativeClip? = model.selected.flatMap { selected in
            panel == .color && selected.kind == "audio" ? nil : selected
        }
        let title = clip?.name ?? (panel == .color ? "No visual primary layer" : "No layer selected")
        let selection = model.chosenClipCount > 1 ? "Primary layer · \(model.chosenClipCount) selected" : "Primary layer"
        let detail = clip.map { "\($0.kind.capitalized) · \(selection)" }
            ?? (panel == .color ? "Make a visual clip the primary selection." : "Select a layer in this panel or the timeline.")
        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: panel.icon).font(.system(size: 12, weight: .medium))
                .foregroundStyle(NativeEditorStyle.accent).padding(.top, 2).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                Text(detail).font(.system(size: 11)).foregroundStyle(NativeEditorStyle.muted)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(NativeEditorStyle.panel)
        .help("\(title). \(detail)")
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(panel.name) target").accessibilityValue("\(title). \(detail)")
        .accessibilityIdentifier("editor.\(panel.rawValue).targetContext")
    }
    #endif
}

extension NativeEditorModel {
    /// Clips the person chose. A clicked clip and its linked audio or video count once, as in Final Cut.
    var chosenClipCount: Int {
        var links = Set<String>(), count = 0
        for clip in tracks.flatMap(\.clips) where selectedIDs.contains(clip.id) {
            let link = clip.fields.string("link")
            if link.isEmpty || links.insert(link).inserted { count += 1 }
        }
        return selectedIDs.isEmpty ? 0 : max(1, count)
    }

    /// What an AI request about the selection sends, including linked audio or video.
    var aiSelectionLabel: String {
        let linked = selectedIDs.count > chosenClipCount
        if chosenClipCount > 1 { return linked ? "Ask AI about selected clips and their linked clips" : "Ask AI about selected clips" }
        return linked ? "Ask AI about selected clip and its linked clip" : "Ask AI about selected clip"
    }
}
