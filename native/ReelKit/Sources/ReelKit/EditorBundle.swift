import Foundation

/// A file or bytes for the web view, with its content type. The host's URL scheme handler
/// answers Range requests for files.
public enum Resource: Sendable {
    case file(URL, type: String)
    case data(Data, type: String)
}

/// The editor's files as the app bundles them (native/scripts/bundle-editor.sh):
///
///     editor/web/      the editor (index.html, main.js, engine/, ui/, ...), served at /
///     editor/core/     the shared core ES modules, served at /core/
///     editor/vendor/   preact, htm and mediabunny, served at /vendor/
///     editor/reel-core.js  the core bundled for JavaScriptCore
public struct EditorBundle: Sendable {
    public let root: URL

    public init(root: URL) {
        self.root = root.standardizedFileURL.resolvingSymlinksInPath()
    }

    public var coreScript: URL { root.appendingPathComponent("reel-core.js") }
    var web: URL { root.appendingPathComponent("web", isDirectory: true) }

    /// The resource for a GET path, or nil when there is no such file.
    public func resource(path: String) -> Resource? {
        if path == "/ui/plugins-index.js" { return .data(Data(pluginIndex().utf8), type: "text/javascript; charset=utf-8") }
        let file: URL?
        if path == "/" || path.isEmpty {
            file = web.appendingPathComponent("index.html")
        } else if path.hasPrefix("/core/") {
            // Like the Node server: only the file name counts under /core/.
            file = confined(root.appendingPathComponent("core").appendingPathComponent((path as NSString).lastPathComponent), in: root.appendingPathComponent("core"))
        } else if path.hasPrefix("/vendor/") {
            let base = root.appendingPathComponent("vendor", isDirectory: true)
            file = confined(base.appendingPathComponent(String(path.dropFirst("/vendor/".count))), in: base)
        } else {
            file = confined(web.appendingPathComponent(String(path.dropFirst())), in: web)
        }
        guard let file, (try? file.checkResourceIsReachable()) == true, !file.hasDirectoryPath else { return nil }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue else { return nil }
        return .file(file, type: MIME.type(for: file))
    }

    private func confined(_ url: URL, in base: URL) -> URL? {
        let resolved = url.standardizedFileURL.resolvingSymlinksInPath()
        let basePath = base.standardizedFileURL.resolvingSymlinksInPath().path
        return resolved.path.hasPrefix(basePath + "/") ? resolved : nil
    }

    /// One module importing every web/ui/plugins/*.js, as the Node server generates it.
    public func pluginIndex() -> String {
        let dir = web.appendingPathComponent("ui/plugins", isDirectory: true)
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".js") }.sorted()
        let imports = files.map { "import './plugins/\($0)'" }.joined(separator: "\n")
        let list = JSON.array(files.map { .string($0) }).text
        return "\(imports)\nexport const loaded = \(list)\n"
    }
}
