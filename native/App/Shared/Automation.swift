#if DEBUG
import Foundation

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
///
/// The script runs through callAsyncJavaScript, the same way the app's own menu actions
/// reach the editor; it has no other access. Release builds contain none of this.
@MainActor
enum Automation {
    static var echoConsole = false

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
