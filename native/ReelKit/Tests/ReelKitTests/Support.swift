import Foundation
import XCTest

/// Paths and generated files the tests share.
enum Support {
    /// native/ in the repository.
    static let nativeDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static let generated = nativeDir.appendingPathComponent("build/generated")
    static let coreScript = generated.appendingPathComponent("reel-core.js")
    static let parity = generated.appendingPathComponent("core-parity.json")

    static func fixture(_ name: String) -> URL {
        Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: nil)!
    }

    /// Runs native/scripts/bundle-core.mjs once per test run, so the tests always use the
    /// core as it is in editor/core now.
    static let generate: Void = {
        let candidates = [ProcessInfo.processInfo.environment["NODE"], "/opt/homebrew/bin/node", "/usr/local/bin/node",
                          NSHomeDirectory() + "/.local/bin/node", "/usr/bin/node"].compactMap { $0 }
        guard let node = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            fatalError("ReelKit tests need Node.js to bundle editor/core (set NODE=/path/to/node)")
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [nativeDir.appendingPathComponent("scripts/bundle-core.mjs").path, "--out", coreScript.path, "--parity", parity.path]
        try! p.run()
        p.waitUntilExit()
        precondition(p.terminationStatus == 0, "bundle-core.mjs failed")
        let music = Process()
        music.executableURL = URL(fileURLWithPath: node)
        music.arguments = [nativeDir.appendingPathComponent("scripts/bundle-music.mjs").path, "--out", generated.appendingPathComponent("arya-music.js").path]
        try! music.run(); music.waitUntilExit()
        precondition(music.terminationStatus == 0, "bundle-music.mjs failed")
    }()

    static func core() throws -> URL {
        _ = generate
        return coreScript
    }

    /// A fresh empty folder under the temporary directory.
    static func tempFolder(_ name: String = "project") throws -> URL {
        // Foundation can ignore TMPDIR on macOS. Honor the verifier's owned directory explicitly.
        let configured = ProcessInfo.processInfo.environment["TMPDIR"]
        let root = configured.flatMap { $0.hasPrefix("/") ? URL(fileURLWithPath: $0, isDirectory: true) : nil }
            ?? FileManager.default.temporaryDirectory
        let url = root.appendingPathComponent("reelkit-\(UUID().uuidString)").appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

/// Collects pushed events for assertions.
final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [(String, String)] = []

    func add(_ name: String, _ json: String) {
        lock.lock(); defer { lock.unlock() }
        items.append((name, json))
    }

    func names() -> [String] {
        lock.lock(); defer { lock.unlock() }
        return items.map(\.0)
    }

    func last(_ name: String) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        guard let text = items.last(where: { $0.0 == name })?.1 else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
    }
}

func object(_ json: Any?) -> [String: Any] { json as? [String: Any] ?? [:] }

func parse(_ text: String) -> [String: Any] {
    object(try? JSONSerialization.jsonObject(with: Data(text.utf8)))
}
