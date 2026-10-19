import CryptoKit
import Foundation

/// A project folder and the rules for touching files in it. Every path the editor or a
/// project file names resolves through `resolve`, which refuses anything outside the folder
/// (including through symbolic links), so the app reads and writes nothing else.
public struct ProjectFolder: Sendable {
    public let root: URL
    public var projectFile: URL { root.appendingPathComponent("reel.project.json") }
    public var dotDir: URL { root.appendingPathComponent(".reel", isDirectory: true) }
    public var cacheDir: URL { dotDir.appendingPathComponent("cache", isDirectory: true) }
    public var mediaDir: URL { root.appendingPathComponent("media", isDirectory: true) }
    public var rendersDir: URL { root.appendingPathComponent("renders", isDirectory: true) }

    public struct OutsideProject: Error, LocalizedError {
        public let path: String
        public var errorDescription: String? { "media outside the project: \(path)" }
    }
    public struct LinkedOutput: Error, LocalizedError {
        public let path: String
        public var errorDescription: String? { "Output paths cannot use symbolic links: \(path)" }
    }

    public init(root: URL) {
        self.root = root.standardizedFileURL.resolvingSymlinksInPath()
    }

    /// The same media extensions the Node server lists and imports.
    public static let mediaExtensions: Set<String> = [
        "mp4", "mov", "m4v", "mkv", "webm", "avi", "mxf", "mts", "mp3", "m4a", "wav", "aac", "aif", "aiff", "flac", "ogg",
        "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff", "bmp",
    ]

    public static func isMedia(_ name: String) -> Bool {
        mediaExtensions.contains((name as NSString).pathExtension.lowercased())
    }

    /// A project-relative or absolute path, resolved and confined to the project folder.
    public func resolve(_ path: String) throws -> URL {
        guard !path.isEmpty, !path.contains("\0") else { throw OutsideProject(path: path) }
        let url = path.hasPrefix("/") ? URL(fileURLWithPath: path) : root.appendingPathComponent(path)
        let resolved = url.standardizedFileURL.resolvingSymlinksInPath()
        guard contains(resolved) else { throw OutsideProject(path: path) }
        return resolved
    }

    /// A lexical output path with no symlink at any component, including missing descendants.
    public func output(_ path: String) throws -> URL {
        guard !path.isEmpty, !path.contains("\0") else { throw OutsideProject(path: path) }
        let lexical = (path.hasPrefix("/") ? URL(fileURLWithPath: path) : root.appendingPathComponent(path)).standardizedFileURL
        guard contains(lexical) else { throw OutsideProject(path: path) }
        var current = lexical
        while current.path != root.path {
            guard (try? FileManager.default.destinationOfSymbolicLink(atPath: current.path)) == nil else { throw LinkedOutput(path: path) }
            let parent = current.deletingLastPathComponent()
            guard parent.path != current.path, contains(parent) else { throw OutsideProject(path: path) }
            current = parent
        }
        guard try resolve(lexical.path).path == lexical.path else { throw OutsideProject(path: path) }
        return lexical
    }

    public func contains(_ url: URL) -> Bool {
        let p = url.standardizedFileURL.path
        return p == root.path || p.hasPrefix(root.path.hasSuffix("/") ? root.path : root.path + "/")
    }

    /// The path of a file in the project, relative to the root (as project files store it).
    public func relative(_ url: URL) -> String {
        let p = url.standardizedFileURL.resolvingSymlinksInPath().path
        let base = root.path.hasSuffix("/") ? root.path : root.path + "/"
        return p.hasPrefix(base) ? String(p.dropFirst(base.count)) : p
    }

    /// A short stable key for derived files: the path, size and modification time, plus extras.
    public static func cacheKey(_ url: URL, _ extra: String...) throws -> String {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let parts = [url.path, String(size), String(format: "%.3f", mtime * 1000)] + extra
        let digest = Insecure.SHA1.hash(data: Data(parts.joined(separator: "|").utf8))
        return digest.map { String(format: "%02x", $0) }.joined().prefix(16).description
    }

    /// A file name that does not exist yet in `dir`: name, name-1, name-2, ...
    public static func freeName(in dir: URL, for name: String) -> URL {
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var candidate = dir.appendingPathComponent(name)
        var i = 1
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = dir.appendingPathComponent(ext.isEmpty ? "\(base)-\(i)" : "\(base)-\(i).\(ext)")
            i += 1
        }
        return candidate
    }

    /// The Node server's upload name cleaning: keep word characters, dot, dash and space.
    public static func cleanFileName(_ name: String) -> String {
        let last = (name as NSString).lastPathComponent
        let cleaned = String(last.unicodeScalars.map { s -> Character in
            let c = Character(s)
            return c.isLetter || c.isNumber || c == "_" || c == "." || c == "-" || c == " " ? c : "_"
        })
        return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "upload.bin" : cleaned
    }
}

/// Content types for files the editor loads.
public enum MIME {
    static let types: [String: String] = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "json": "application/json", "svg": "image/svg+xml", "png": "image/png",
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "heic": "image/heic",
        "tif": "image/tiff", "tiff": "image/tiff", "bmp": "image/bmp", "mp4": "video/mp4", "m4v": "video/mp4",
        "mov": "video/quicktime", "webm": "video/webm", "mkv": "video/x-matroska", "mp3": "audio/mpeg", "m4a": "audio/mp4",
        "aac": "audio/aac", "wav": "audio/wav", "aif": "audio/aiff", "aiff": "audio/aiff", "ogg": "audio/ogg",
        "flac": "audio/flac", "cube": "text/plain", "txt": "text/plain; charset=utf-8", "map": "application/json",
    ]

    public static func type(for url: URL) -> String {
        types[url.pathExtension.lowercased()] ?? "application/octet-stream"
    }
}

/// An HTTP byte range, resolved against a file size.
public struct ByteRange: Equatable, Sendable {
    public let start: UInt64
    public let end: UInt64 // inclusive
    public var length: UInt64 { end - start + 1 }

    /// Parses a `Range` header (`bytes=a-b`, `bytes=a-`, `bytes=-n`; only the first range).
    /// Nil when absent or unsatisfiable.
    public init?(header: String?, size: UInt64) {
        guard let header, header.hasPrefix("bytes="), size > 0 else { return nil }
        let spec = header.dropFirst(6).split(separator: ",").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        let parts = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2 else { return nil }
        if parts[0].isEmpty {
            guard let suffix = UInt64(parts[1]), suffix > 0 else { return nil }
            start = size > suffix ? size - suffix : 0
            end = size - 1
            return
        }
        guard let s = UInt64(parts[0]), s < size else { return nil }
        let e = parts[1].isEmpty ? size - 1 : UInt64(parts[1]).map { min($0, size - 1) }
        guard let e, e >= s else { return nil }
        start = s
        end = e
    }
}
