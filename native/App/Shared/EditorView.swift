import Foundation
import ReelKit
import CoreText
import SwiftUI
import WebKit

/// The editor's web view in SwiftUI. The view itself lives on the session, so switching
/// between the start screen and the editor never recreates it.
#if os(macOS)
struct EditorView: NSViewRepresentable {
    let session: EditorSession
    func makeNSView(context: Context) -> WKWebView { session.webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#else
struct EditorView: UIViewRepresentable {
    let session: EditorSession
    func makeUIView(context: Context) -> WKWebView { session.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#endif

/// What the window shows: the start screen until a project folder is open, then the editor.
struct ContentView: View {
    @ObservedObject var session: EditorSession
    var openFolder: () -> Void
    var newProject: () -> Void
    #if os(iOS)
    var openAssistantSettings: (() -> Void)? = nil
    #endif

    var body: some View {
        Group {
            if session.folder != nil {
                if session.useWebEditor {
                    EditorView(session: session).ignoresSafeArea()
                } else {
                    NativeEditorView(session: session, model: session.nativeEditor, openFolder: openFolder, newProject: newProject)
                }
            } else {
                #if os(iOS)
                StartView(session: session, openFolder: openFolder, newProject: newProject,
                          openAssistantSettings: openAssistantSettings)
                #else
                StartView(session: session, openFolder: openFolder, newProject: newProject)
                #endif
            }
        }
        // Amber replaces the system blue in links, toggles and default buttons on every platform.
        .tint(NativeEditorStyle.accent)
        .sheet(item: $session.projectRecoveryRequest) { request in
            NativeProjectRecoverySheet(session: session, request: request)
        }
        .alert("Arya", isPresented: Binding(get: { session.error != nil }, set: { if !$0 { session.error = nil } })) {
            Button("OK") { session.error = nil }
        } message: {
            Text(session.error ?? "")
        }
    }
}

struct NativeProjectRecoverySheet: View {
    @ObservedObject var session: EditorSession
    let request: NativeProjectRecoveryRequest
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Choose a saved project copy. Arya checks that it belongs to this folder and preserves the file being replaced. Your media stays in the project folder.")
                        .fixedSize(horizontal: false, vertical: true)
                }
                Section("Saved copies") {
                    ForEach(request.offer.choices) { choice in
                        Button { session.restoreProjectRecovery(choice, request: request) } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(choice.createdAt).font(.headline)
                                Text("Saved by \(choice.host.capitalized) • \(ByteCountFormatter.string(fromByteCount: Int64(choice.bytes), countStyle: .file))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }.padding(.vertical, 4)
                        }.disabled(session.recoveringProject)
                    }
                }
                if session.recoveringProject { ProgressView("Restoring saved project…") }
                if let error = session.projectRecoveryError { Text(error).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            }
            .navigationTitle("Recover saved project")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { session.dismissProjectRecovery(request) }.disabled(session.recoveringProject)
                }
            }
        }
        .interactiveDismissDisabled(request.failedOpen || session.recoveringProject)
        #if os(macOS)
        .frame(minWidth: 420, idealWidth: 500, minHeight: 340)
        #endif
    }
}

// BEGIN WELCOME LAYOUT
/// Portrait and accessibility sizes keep each primary action on its own row.
enum NativeWelcomeLayout {
    static func horizontalActions(width: Double, height: Double, accessibility: Bool) -> Bool {
        width.isFinite && height.isFinite && width > 0 && height > 0 && width > height && width >= 608 && !accessibility
    }
}
// END WELCOME LAYOUT

// BEGIN RECENT PROJECT PRESENTATION
/// Labels describe the stored path. Opening still resolves the original bookmark.
enum NativeRecentProjectPresentation {
    private struct DisplayKey: Hashable {
        let path: [String]
        let bookmark: Data
    }

    /// Collapse exact duplicate saved identities and keep the first (newest) entry for opening.
    /// Unavailable folders retain their bookmarks for retry. Paths under another app's
    /// Documents keep their own bookmark identity instead of merging by project name.
    static func visible(_ recents: [ProjectBookmarks.Recent], mobile: Bool) -> [ProjectBookmarks.Recent] {
        var seen: Set<DisplayKey> = []
        return recents.filter { recent in
            guard !recent.data.isEmpty, let path = components(recent.path, mobile: mobile) else { return true }
            return seen.insert(DisplayKey(path: path, bookmark: recent.data)).inserted
        }
    }

    static func location(path: String, documentsPath: String?, homePath: String?, mobile: Bool) -> String {
        guard let pathComponents = components(path, mobile: mobile), !pathComponents.isEmpty else { return "Saved folder" }
        let parent = Array(pathComponents.dropLast())

        if let documentsPath, let documents = components(documentsPath, mobile: mobile), !documents.isEmpty,
           parent.starts(with: documents) {
            return compact(root: mobile ? "Arya" : "Documents", folders: Array(parent.dropFirst(documents.count)))
        }

        if let container = parent.indices.first(where: { index in
            parent.count >= index + 5 &&
            Array(parent[index..<(index + 3)]) == ["Containers", "Data", "Application"] &&
            UUID(uuidString: parent[index + 3]) != nil && parent[index + 4] == "Documents"
        }) {
            return compact(root: "Saved app folder", folders: Array(parent.dropFirst(container + 5)))
        }

        if !mobile, let homePath, let home = components(homePath), !home.isEmpty,
           parent.starts(with: home) {
            return compact(root: "Home", folders: Array(parent.dropFirst(home.count)))
        }
        if !mobile, parent.first == "Volumes", parent.count >= 2 {
            return compact(root: "Volume / \(parent[1])", folders: Array(parent.dropFirst(2)))
        }

        guard let folder = parent.last, !folder.hasPrefix("."), UUID(uuidString: folder) == nil else {
            return "Selected folder"
        }
        return "Folder / \(folder)"
    }

    private static func components(_ path: String, mobile: Bool = false) -> [String]? {
        guard path.hasPrefix("/"), path.utf8.count <= 8192,
              path.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        let components = path.split(separator: "/").map(String.init)
        guard !components.contains("."), !components.contains("..") else { return nil }
        if mobile, components.count >= 8,
           Array(components.prefix(6)) == ["private", "var", "mobile", "Containers", "Data", "Application"],
           UUID(uuidString: components[6]) != nil, components[7] == "Documents" {
            return Array(components.dropFirst())
        }
        return components
    }

    private static func compact(root: String, folders: [String]) -> String {
        let visible = folders.count > 2 ? ["…"] + Array(folders.suffix(2)) : folders
        return ([root] + visible).joined(separator: " / ")
    }
}
// END RECENT PROJECT PRESENTATION

// BEGIN WELCOME TYPOGRAPHY
/// Branded welcome copy uses the bundled face. Working controls retain system type.
private struct NativeWelcomeTypography: ViewModifier {
    enum CopyStyle { case tagline, support }
    let style: CopyStyle
    @ScaledMetric(relativeTo: .title3) private var taglineSize: CGFloat = 20
    @ScaledMetric(relativeTo: .callout) private var supportSize: CGFloat = 16

    private static let descriptor: CTFontDescriptor? = {
        guard let url = Bundle.main.url(forResource: "manrope", withExtension: "ttf", subdirectory: "editor/web/fonts"),
              Bundle.main.url(forResource: "manrope-OFL", withExtension: "txt", subdirectory: "editor/web/fonts") != nil,
              CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil),
              let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor],
              let descriptor = descriptors.first else { return nil }
        // This variable font defaults to weight 200. Welcome copy uses regular weight 400.
        let weight: [NSNumber: NSNumber] = [NSNumber(value: 0x77676874): NSNumber(value: 400)]
        return CTFontDescriptorCreateCopyWithAttributes(descriptor, [kCTFontVariationAttribute: weight] as CFDictionary)
    }()

    private var font: Font {
        guard let descriptor = Self.descriptor else { return style == .tagline ? .title3 : .callout }
        let size = style == .tagline ? taglineSize : supportSize
        return Font(CTFontCreateWithFontDescriptor(descriptor, size, nil))
    }

    func body(content: Content) -> some View { content.font(font) }
}
// END WELCOME TYPOGRAPHY

struct StartView: View {
    @ObservedObject var session: EditorSession
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var gettingStartedVisible = false
    var openFolder: () -> Void
    var newProject: () -> Void
    #if os(iOS)
    var openAssistantSettings: (() -> Void)? = nil
    #endif

    private var visibleRecents: [ProjectBookmarks.Recent] {
        #if os(iOS)
        NativeRecentProjectPresentation.visible(session.recents, mobile: true)
        #else
        NativeRecentProjectPresentation.visible(session.recents, mobile: false)
        #endif
    }

    private func recentLocation(_ recent: ProjectBookmarks.Recent) -> String {
        #if os(iOS)
        let mobile = true
        let homePath: String? = nil
        #else
        let mobile = false
        let homePath = NSHomeDirectoryForUser(NSUserName())
        #endif
        return NativeRecentProjectPresentation.location(
            path: recent.path,
            documentsPath: FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.path,
            homePath: homePath,
            mobile: mobile
        )
    }

    private var newButton: some View {
        Button(action: newProject) {
            Label("New Project", systemImage: "plus")
                .font(.headline).multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 44)
                .padding(.horizontal, 12)
        }
        .buttonStyle(.borderedProminent)
        .tint(NativeEditorStyle.accent)
        #if os(iOS)
        .foregroundStyle(NativeEditorStyle.accentInk)
        #endif
        .keyboardShortcut("n")
        .accessibilityLabel("New Arya project")
        .accessibilityHint("Create a project to start editing")
        .accessibilityIdentifier("welcome.newProject")
    }

    private var openButton: some View {
        Button(action: openFolder) {
            Label("Open Project", systemImage: "folder")
                .font(.headline).multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, minHeight: 44)
                .padding(.horizontal, 12)
        }
        .buttonStyle(.bordered)
        .keyboardShortcut("o")
        .accessibilityLabel("Open Arya project")
        .accessibilityHint("Choose an existing project folder")
        .accessibilityIdentifier("welcome.openProject")
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 24) {
                    NativeBrandWordmark()
                        .frame(maxWidth: 220).frame(height: 70)
                        .accessibilityLabel("Arya")
                    Text("A video editor you can direct.")
                        .modifier(NativeWelcomeTypography(style: .tagline)).multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                    Group {
                        if NativeWelcomeLayout.horizontalActions(width: geometry.size.width, height: geometry.size.height, accessibility: dynamicTypeSize.isAccessibilitySize) {
                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: 16) { newButton; openButton }
                                    .fixedSize(horizontal: true, vertical: false)
                                VStack(spacing: 12) { newButton; openButton }
                            }
                        } else {
                            VStack(spacing: 12) { newButton; openButton }
                        }
                    }
                    .controlSize(.large)
                    .frame(maxWidth: 560)
                    VStack(spacing: 8) {
                        Text("Manual editing needs no AI account.")
                            .modifier(NativeWelcomeTypography(style: .support)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        Button { gettingStartedVisible = true } label: {
                            Text("Getting started")
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .accessibilityIdentifier("welcome.gettingStarted")
                        #if os(iOS)
                        if let openAssistantSettings {
                            Button(action: openAssistantSettings) {
                                Label("Assistant settings", systemImage: "gearshape")
                                    .frame(minHeight: 44)
                                    .contentShape(Rectangle())
                            }
                            .accessibilityHint("Connect accounts and choose assistant models before opening a project.")
                            .accessibilityIdentifier("welcome.assistantSettings")
                        }
                        #endif
                    }
                    if !visibleRecents.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Recent projects").font(.headline).accessibilityAddTraits(.isHeader)
                            VStack(spacing: 0) {
                                ForEach(visibleRecents) { recent in
                                    let location = recentLocation(recent)
                                    Button { session.open(recent: recent) } label: {
                                        HStack(spacing: 12) {
                                            Image(systemName: "folder")
                                                .foregroundStyle(.secondary)
                                                .frame(width: 24)
                                                .accessibilityHidden(true)
                                            VStack(alignment: .leading, spacing: 4) {
                                                Text(recent.name).font(.body)
                                                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                                                    .fixedSize(horizontal: false, vertical: true)
                                                Text(location).font(.footnote).foregroundStyle(.secondary)
                                                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                                                    .truncationMode(.middle)
                                                    .fixedSize(horizontal: false, vertical: true)
                                            }
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            Image(systemName: "chevron.forward")
                                                .font(.caption).foregroundStyle(.tertiary)
                                                .accessibilityHidden(true)
                                        }
                                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                        .padding(.vertical, 8)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Open \(recent.name). Last location: \(location)")
                                    if recent.id != visibleRecents.last?.id { Divider() }
                                }
                            }
                            Text("Locations were saved when each project was last opened.")
                                .font(.footnote).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .frame(maxWidth: visibleRecents.isEmpty ? 560 : 640)
                .padding(24)
                // Centered on every platform: top alignment left most of an iPad or iPhone
                // screen empty below the actions. Taller content still scrolls from the top.
                .frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }
        }
        .background(NativeEditorStyle.background)
        .preferredColorScheme(.dark)
        .sheet(isPresented: $gettingStartedVisible) { NativeGettingStartedSheet() }
    }
}

#if os(iOS)
/// New is an app-owned project, not the Files picker used to open existing projects.
struct NativeNewProjectSheet: View {
    @ObservedObject var session: EditorSession
    var isPresented: @MainActor () -> Bool = { true }
    var onDismiss: (@MainActor () -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @FocusState private var nameFocused: Bool
    @AccessibilityFocusState private var errorFocused: Bool
    @State private var name = "Untitled Arya"
    @State private var format = Format.landscape
    @State private var fps = 30.0
    @State private var creating = false
    @State private var failure: String?

    enum Format: String, CaseIterable, Identifiable {
        case landscape = "Landscape HD", portrait = "Portrait HD", square = "Square"
        var id: String { rawValue }
        var width: Int { self == .landscape ? 1920 : 1080 }
        var height: Int { self == .portrait ? 1920 : 1080 }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Project name") {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .focused($nameFocused)
                        .submitLabel(.go)
                        .onSubmit { submit() }
                        .accessibilityHint("Press Return to create the project using the selected video format.")
                        .accessibilityLabel("Project name")
                        .accessibilityIdentifier("newProject.name")
                }
                Section("Video format") {
                    Picker("Frame size", selection: $format) {
                        ForEach(Format.allCases) { item in Text(item.rawValue).tag(item) }
                    }
                    .accessibilityIdentifier("newProject.frameSize")
                    Picker("Frame rate", selection: $fps) {
                        ForEach([24.0, 25.0, 30.0, 60.0], id: \.self) { value in
                            Text("\(Int(value)) fps").tag(value)
                        }
                    }
                    .accessibilityIdentifier("newProject.frameRate")
                    Text("\(format.width) × \(format.height)").foregroundStyle(.secondary)
                }
                Section("Location") {
                    Label("On this device", systemImage: "folder")
                    Text("Saved in Arya’s Projects folder in Files. You can move the project folder later.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let failure {
                    Section {
                        Text(failure).foregroundStyle(.red)
                            .accessibilityIdentifier("newProject.error")
                            .accessibilityFocused($errorFocused)
                    }
                }
            }
            .disabled(creating)
            .scrollDismissesKeyboard(.interactively)
            .onAppear { nameFocused = true }
            .onChange(of: session.sessionID) { _, _ in if !creating { dismissPresentation() } }
            .navigationTitle("New Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", role: .cancel) { dismissPresentation() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("newProject.cancel")
                        .disabled(creating)
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button(action: submit) {
                    HStack {
                        if creating { ProgressView() }
                        Text(creating ? "Creating project…" : "Create Project")
                            .font(.headline).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .tint(NativeEditorStyle.accent)
                .foregroundStyle(NativeEditorStyle.accentInk)
                .disabled(!canSubmit)
                .keyboardShortcut(.defaultAction)
                .accessibilityHint("Creates a project on this device with the selected name and video format.")
                .accessibilityIdentifier("newProject.create")
                .padding(12)
                .background(.bar)
            }
            .interactiveDismissDisabled(creating)
        }
        .presentationDetents([.large])
    }

    // BEGIN NEW PROJECT SUBMISSION
    private var canSubmit: Bool {
        isPresented() && !creating && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func dismissPresentation() {
        if let onDismiss { onDismiss() } else { dismiss() }
    }

    private func submit() {
        // Return and the default action can arrive together. Reserve the action before suspension.
        guard canSubmit else { return }
        let requestedName = name
        let requestedWidth = format.width
        let requestedHeight = format.height
        let requestedFPS = fps
        let requestedSessionID = session.sessionID
        nameFocused = false
        errorFocused = false
        failure = nil
        creating = true
        Task { @MainActor in
            // Let SwiftUI paint "Creating project…" before synchronous folder work.
            await Task.yield()
            guard isPresented(), session.sessionID == requestedSessionID else {
                creating = false
                dismissPresentation()
                return
            }
            do {
                try await session.createNewProject(name: requestedName, width: requestedWidth, height: requestedHeight, fps: requestedFPS)
                guard isPresented() else { return }
                creating = false
                dismissPresentation()
            } catch {
                guard isPresented() else { return }
                creating = false
                failure = error is CancellationError ? "Project creation was cancelled." : error.localizedDescription
                errorFocused = true
            }
        }
    }
    // END NEW PROJECT SUBMISSION
}
#endif
