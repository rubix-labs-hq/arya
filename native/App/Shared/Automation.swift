#if DEBUG
import Foundation
#if os(macOS)
import AppKit
#endif

/// Debug builds only: launch arguments for end-to-end tests of the app.
///
///     --open <folder>            open this project folder at launch
///     --automation <script.js>   once the editor is up, run the file as an async function
///                                body in the page and write what it returns as JSON
///     --automation-out <file>    where to write that result (default: stdout)
///     --quit-after-automation    quit when the script finishes
///     --echo-console             print the page's console to stdout
///     --assistant-preview <file> stage this {ops, steps, summary} JSON as an assistant preview
///                                once the project opens, to check the native preview card
///     --assistant-panel          open the Assistant panel
///     --assistant-apply          apply the staged preview, as the Apply button does
///     --assistant-fixture <kind> seed a display-only conversation: conversation, working or setup.
///                                Sending stays off while a fixture is shown.
///     --page <name>              show this workflow page once the project opens
///     --select <id,id>           select these clips once the project opens
///     --present <sheet>          open settings, assistantSettings, pro or askArya for screenshots
///     --window-size <w>x<h>      Mac: resize the editor window once the project opens
///     --no-activate              Mac: launch without taking focus from the person at the Mac
///
/// The script runs through callAsyncJavaScript, the same way the app's own menu actions
/// reach the editor; it has no other access. Release builds contain none of this.
@MainActor
enum Automation {
    static var echoConsole = false
    /// Posted with a sheet name (settings, assistantSettings, pro, askArya) for screenshots.
    static let presentNotification = Notification.Name("AryaAutomationPresent")

    static func value(_ flag: String) -> String? {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static func start(_ session: EditorSession, quit: @escaping () -> Void) {
        #if os(macOS)
        if CommandLine.arguments.contains("--native-firstuse-root") { return }
        #endif
        echoConsole = CommandLine.arguments.contains("--echo-console")
        if CommandLine.arguments.contains("--assistant-panel") { UserDefaults.standard.set(true, forKey: "editor.layout.assistantVisible") }
        if let folder = value("--open") {
            if let readyFile = value("--native-smoke-start-after") {
                // Let the UI driver activate the welcome window before opening the smoke fixture.
                Task { @MainActor in
                    let deadline = ContinuousClock().now.advanced(by: .seconds(10))
                    while !FileManager.default.fileExists(atPath: readyFile), ContinuousClock().now < deadline {
                        try? await Task.sleep(for: .milliseconds(25))
                    }
                    guard FileManager.default.fileExists(atPath: readyFile) else {
                        session.error = "The native smoke driver did not signal readiness."
                        return
                    }
                    session.open(URL(fileURLWithPath: folder))
                }
            } else { session.open(URL(fileURLWithPath: folder)) }
        }
        if let fixture = value("--assistant-preview"), let text = try? String(contentsOfFile: fixture, encoding: .utf8) {
            Task { @MainActor in
                for _ in 0..<100 where session.backend == nil || session.nativeEditor.project == nil { try? await Task.sleep(for: .milliseconds(100)) }
                #if os(iOS)
                if CommandLine.arguments.contains("--assistant-panel") { session.nativeEditor.mobilePanel = .assistant }
                #endif
                await session.assistant.stageFixtureProposal(text)
                if CommandLine.arguments.contains("--assistant-apply") { try? await Task.sleep(for: .seconds(2)); await session.assistant.applyProposal() }
            }
        }
        if value("--page") != nil || value("--select") != nil || value("--present") != nil || value("--window-size") != nil || value("--assistant-fixture") != nil {
            Task { @MainActor in
                for _ in 0..<100 where session.backend == nil || session.nativeEditor.project == nil { try? await Task.sleep(for: .milliseconds(100)) }
                #if os(macOS)
                if let size = value("--window-size")?.split(separator: "x").compactMap({ Double($0) }), size.count == 2,
                   let window = NSApp.windows.first(where: { $0.canBecomeMain && $0.isVisible }) {
                    window.setContentSize(NSSize(width: size[0], height: size[1]))
                }
                #endif
                if let page = value("--page") { session.showPage(page) }
                if let ids = value("--select")?.split(separator: ",").map(String.init), !ids.isEmpty {
                    session.nativeEditor.select(ids: Set(ids), primary: ids[0], feedback: false)
                }
                if let kind = value("--assistant-fixture") { await session.assistant.stageFixtureConversation(kind) }
                if let sheet = value("--present") {
                    try? await Task.sleep(for: .milliseconds(600))
                    NotificationCenter.default.post(name: presentNotification, object: sheet)
                }
            }
        }
        guard let scriptPath = value("--automation") else { return }
        session.whenReady {
            // Give the editor a moment to draw its first frame after mounting.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                MainActor.assumeIsolated { run(scriptPath, session, quit) }
            }
        }
    }

    private static func run(_ scriptPath: String, _ session: EditorSession, _ quit: @escaping () -> Void) {
        guard let script = try? String(contentsOfFile: scriptPath, encoding: .utf8) else {
            write("{\"error\":\"cannot read \(scriptPath)\"}")
            return
        }
        let body = "try { const value = await (async () => {\n\(script)\n})(); return JSON.stringify({ ok: true, value }) } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e), stack: String(e && e.stack || '') }) }"
        session.evaluate(body) { result in
            switch result {
            case .success(let value): write(value as? String ?? "null")
            case .failure(let error): write("{\"ok\":false,\"error\":\(String(reflecting: error.localizedDescription))}")
            }
            if CommandLine.arguments.contains("--quit-after-automation") { quit() }
        }
    }

    private static func write(_ text: String) {
        if let out = value("--automation-out") {
            try? text.write(toFile: out, atomically: true, encoding: .utf8)
        } else {
            print(text)
        }
    }
}
#endif
