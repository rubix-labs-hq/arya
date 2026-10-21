import AppKit
import ReelKit
import SwiftUI
import UniformTypeIdentifiers

@main
struct ReelMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var session = EditorSession(platform: MacPlatform())
    @Environment(\.openWindow) private var openWindow

    var body: some Scene {
        Window("Arya", id: "main") {
            ContentView(session: session, openFolder: openFolder, newProject: newProject)
                .frame(minWidth: 960, minHeight: 600)
                .background(MacEditorWindowAnchor {
                    appDelegate.editorWindow = $0
                    #if DEBUG
                    NativeEditorSmoke.registerFirstUseWindow($0, session: session)
                    #endif
                })
                .onAppear(perform: launch)
                .onOpenURL { url in if url.isFileURL { session.open(url) } else { _ = session.assistant.acceptPairingURL(url) } }
                .onContinueUserActivity(NativeHandoff.type) { session.continueProject($0) }
                .navigationTitle(session.folder?.lastPathComponent ?? "Arya")
        }
        .defaultSize(width: 1440, height: 900)
        .commands { commands }
        Window("Getting started", id: "getting-started") {
            NavigationStack { NativeGettingStartedView() }
                .frame(minWidth: 420, minHeight: 360)
                .preferredColorScheme(.dark).tint(NativeEditorStyle.accent)
        }
        .defaultSize(width: 640, height: 680)
        Settings {
            TabView {
                NativeAssistantSettings(assistant: session.assistant).tabItem { Label("Assistant", systemImage: "text.bubble") }
                NativeFigmaSettings(figma: session.figma).tabItem { Label("Figma", systemImage: "square.stack") }
                NavigationStack { NativeGettingStartedView() }.tabItem { Label("Getting started", systemImage: "questionmark.circle") }
            }.frame(width: 560, height: 460)
            // The accent is a light gold. Keep Settings dark like the editor so its text stays readable.
            .preferredColorScheme(.dark)
            .tint(NativeEditorStyle.accent)
        }
    }

    @CommandsBuilder private var commands: some Commands {
        CommandGroup(replacing: .help) {
            Button("Arya Getting started") { openWindow(id: "getting-started") }
        }
        CommandGroup(replacing: .newItem) {
            Button("New Project…", action: newProject).keyboardShortcut("n")
            Button("Open Project Folder…", action: openFolder).keyboardShortcut("o")
            Menu("Open Recent") {
                ForEach(session.recents) { recent in
                    Button(recent.name) { session.open(recent: recent) }
                }
            }
            .disabled(session.recents.isEmpty)
            Divider()
            Button("Import Media…", action: importMedia).keyboardShortcut("i", modifiers: [.command, .shift])
                .disabled(session.folder == nil)
            Button("Show Project in Finder") {
                if let folder = session.folder { NSWorkspace.shared.activateFileViewerSelecting([folder]) }
            }
            .disabled(session.folder == nil)
            Button("Recover Saved Project…") { session.offerProjectRecovery() }.disabled(session.folder == nil)
            Button("Close Project") { session.close() }
                .keyboardShortcut("w", modifiers: [.command, .shift])
                .disabled(session.folder == nil)
        }
        CommandGroup(replacing: .undoRedo) {
            Button("Undo") { session.undo(redo: false) }.keyboardShortcut("z")
                .disabled(session.folder == nil)
            Button("Redo") { session.undo(redo: true) }.keyboardShortcut("z", modifiers: [.command, .shift])
                .disabled(session.folder == nil)
        }
        CommandGroup(after: .toolbar) {
            ForEach(NativePanel.allCases) { page in
                Button("\(page.name) Page") { session.showPage(page.rawValue) }.disabled(session.folder == nil)
            }
            Toggle("Web Editor", isOn: $session.useWebEditor).disabled(session.folder == nil)
            Divider()
            Button("Reload Editor") { session.reloadEditor() }
                .keyboardShortcut("r", modifiers: [.command, .option])
                .disabled(session.folder == nil)
        }
        CommandMenu("Timeline") {
            Group {
                Button("Play or Pause") { performEditorCommand(.playPause) }.keyboardShortcut(editorShortcut(.space, modifiers: []))
                Button("Split at Playhead") { performEditorCommand(.split) }.keyboardShortcut(editorShortcut("b", modifiers: [.command]))
                Button("Delete Selected Clip") { performEditorCommand(.delete) }.keyboardShortcut(editorShortcut(.delete, modifiers: []))
                    .disabled(!session.useWebEditor && session.nativeEditor.selectedID == nil)
                Button("Ripple Delete") { performEditorCommand(.rippleDelete) }.keyboardShortcut(editorShortcut(.delete, modifiers: [.shift]))
                    .disabled(!session.useWebEditor && session.nativeEditor.selectedID == nil)
                Button("Previous Frame") { performEditorCommand(.previousFrame) }.keyboardShortcut(editorShortcut(.leftArrow, modifiers: []))
                Button("Next Frame") { performEditorCommand(.nextFrame) }.keyboardShortcut(editorShortcut(.rightArrow, modifiers: []))
                Divider()
                Button("Duplicate Selected Clips") { performEditorCommand(.duplicate) }.keyboardShortcut(editorShortcut("d", modifiers: [.command]))
                    .disabled(!session.useWebEditor && session.nativeEditor.selectedIDs.isEmpty)
                Button("Export…") { performEditorCommand(.export) }.keyboardShortcut(editorShortcut("e", modifiers: [.command]))
                Divider()
                // The standard Edit menu and its Cmd-C/X/V shortcuts remain responder-owned.
                Button("Copy Timeline Selection") { performEditorCommand(.copy) }
                    .disabled(!session.useWebEditor && !session.nativeEditor.canCopyTimelineSelection)
                Button("Cut Timeline Selection") { performEditorCommand(.cut) }
                    .disabled(!session.useWebEditor && !session.nativeEditor.canCopyTimelineSelection)
                Button("Paste Timeline Clips") { performEditorCommand(.paste) }
                    .disabled(!session.useWebEditor && !session.nativeEditor.canPasteTimelineClipboard)
                Button("Match Frame") { performEditorCommand(.matchFrame) }
                    .disabled(!session.useWebEditor && !session.nativeEditor.canRequestMatchFrame)
            }
            .disabled(session.folder == nil)
        }
    }

    private func editorShortcut(_ key: KeyEquivalent, modifiers: EventModifiers) -> KeyboardShortcut? {
        // WebKit receives real key events, including text editing and browser selection.
        session.useWebEditor ? nil : KeyboardShortcut(key, modifiers: modifiers)
    }

    private func performEditorCommand(_ command: MacEditorCommand) {
        guard session.folder != nil, session.error == nil,
              MacEditorTextCommandGuard.permitsTimelineAction(
                editorWindowIsKey: appDelegate.editorWindow != nil && NSApp.keyWindow === appDelegate.editorWindow,
                hasModal: NSApp.modalWindow != nil, hasSheet: appDelegate.editorWindow?.attachedSheet != nil,
                textSelectable: (NSApp.keyWindow?.firstResponder as? NSTextView)?.isSelectable == true,
                textEditable: (NSApp.keyWindow?.firstResponder as? NSTextView)?.isEditable == true) else { return }
        if session.useWebEditor {
            session.evaluate("const { runEditorCommand } = await import('/ui/keys.js'); return runEditorCommand(\(JSON.string(command.rawValue).text))")
            return
        }
        switch command {
        case .playPause: session.nativeEditor.togglePlayback()
        case .split: session.nativeEditor.split()
        case .delete: session.nativeEditor.delete()
        case .rippleDelete: session.nativeEditor.delete(ripple: true)
        case .previousFrame: session.nativeEditor.step(-1)
        case .nextFrame: session.nativeEditor.step(1)
        case .duplicate:
            session.nativeEditor.editBatch(session.nativeEditor.selectedIDs.sorted().map { ["op": "duplicate", "id": $0] }, expectedVersion: session.nativeEditor.version)
        case .export: session.nativeEditor.panel = .deliver
        case .copy, .cut, .paste:
            guard let capture = session.nativeEditor.clipboardActionCapture() else { return }
            if command == .paste { session.nativeEditor.pasteTimelineClipboard(expected: capture) }
            else { session.nativeEditor.copyTimelineSelection(cut: command == .cut, expected: capture) }
        case .matchFrame:
            do {
                let capture = try session.nativeEditor.captureMatchFrame()
                session.nativeEditor.matchFrame(capture)
            } catch { session.nativeEditor.status = error.localizedDescription }
        }
    }

    private func launch() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        appDelegate.installTextCommandGuard(session: session)
        #if DEBUG
        Automation.start(session) { NSApp.terminate(nil) }
        NativeEditorSmoke.start(session) { NSApp.terminate(nil) }
        #endif
    }

    private func openFolder() {
        let panel = NSOpenPanel()
        panel.title = "Open Project Folder"
        panel.message = "Choose a folder with an Arya project, or a folder of media to start one in."
        panel.prompt = "Open"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        session.open(url)
    }

    private func newProject() {
        let panel = NSSavePanel()
        panel.title = "New Project"
        panel.message = "Choose where to save the project and its media."
        panel.prompt = "Create"
        panel.nameFieldLabel = "Project:"
        panel.nameFieldStringValue = "Untitled Arya"
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        session.create(at: url)
    }

    private func importMedia() {
        let panel = NSOpenPanel()
        panel.title = "Import Media"
        panel.message = "Files are copied into the project's media folder."
        panel.prompt = "Import"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.movie, .audio, .image]
        guard panel.runModal() == .OK else { return }
        session.importFiles(panel.urls)
    }
}

enum MacEditorCommand: String {
    case playPause, split, delete, rippleDelete, previousFrame, nextFrame, duplicate, export, copy, cut, paste, matchFrame
}

@MainActor
enum MacEditorTextCommandGuard {
    // Explicit Timeline menu admission, not a claim that the canvas owns keyboard focus.
    static func permitsTimelineAction(editorWindowIsKey: Bool, hasModal: Bool, hasSheet: Bool,
                                      textSelectable: Bool, textEditable: Bool) -> Bool {
        editorWindowIsKey && !hasModal && !hasSheet && !textSelectable && !textEditable
    }

    static func protects(keyCode: UInt16, characters: String, command: Bool, control: Bool) -> Bool {
        if command { return ["b", "d", "e"].contains(characters.lowercased()) }
        guard !control else { return false }
        return [49, 51, 117, 123, 124, 125, 126].contains(keyCode)
            || characters.unicodeScalars.contains { !CharacterSet.controlCharacters.contains($0) }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var textCommandMonitor: Any?
    weak var editorWindow: NSWindow?

    func installTextCommandGuard(session: EditorSession) {
        guard textCommandMonitor == nil else { return }
        textCommandMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak session] event in
            MainActor.assumeIsolated {
                guard let session, !session.useWebEditor,
                      let editor = NSApp.keyWindow?.firstResponder as? NSTextView, editor.isEditable,
                      editor.window === event.window,
                      MacEditorTextCommandGuard.protects(keyCode: event.keyCode, characters: event.charactersIgnoringModifiers ?? "",
                                                        command: event.modifierFlags.contains(.command), control: event.modifierFlags.contains(.control)) else { return event }
                // Deliver typing to its field editor before any global editor shortcut.
                editor.keyDown(with: event)
                return nil
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        if let textCommandMonitor { NSEvent.removeMonitor(textCommandMonitor) }
        textCommandMonitor = nil
    }
}

/// Identifies the actual editor window without relying on window titles or text focus.
private struct MacEditorWindowAnchor: NSViewRepresentable {
    let onWindow: (NSWindow) -> Void

    func makeNSView(context: Context) -> WindowView {
        let view = WindowView()
        view.onWindow = onWindow
        return view
    }
    func updateNSView(_ view: WindowView, context: Context) {
        view.onWindow = onWindow
        view.reportWindow()
    }
    final class WindowView: NSView {
        var onWindow: ((NSWindow) -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            reportWindow()
        }
        func reportWindow() { if let window { onWindow?(window) } }
    }
}

/// What ReelKit asks of macOS: showing and opening files.
struct MacPlatform: ReelPlatform {
    func reveal(_ url: URL, open: Bool) async throws {
        await MainActor.run {
            if open { NSWorkspace.shared.open(url) } else { NSWorkspace.shared.activateFileViewerSelecting([url]) }
        }
    }
}

/// Dialogs and links for the web view, macOS versions.
@MainActor
enum Platform {
    static func openExternal(_ url: URL) { NSWorkspace.shared.open(url) }

    static func alert(_ message: String, in view: NSView, done: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        run(alert, in: view) { _ in done() }
    }

    static func confirm(_ message: String, in view: NSView, done: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        run(alert, in: view) { done($0 == .alertFirstButtonReturn) }
    }

    static func prompt(_ message: String, defaultText: String, in view: NSView, done: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        let field = NSTextField(string: defaultText)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        run(alert, in: view) { done($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    private static func run(_ alert: NSAlert, in view: NSView, done: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window = view.window { alert.beginSheetModal(for: window, completionHandler: done) } else { done(alert.runModal()) }
    }
}
