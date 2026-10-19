import Darwin
import Foundation

/// Export sources must stay on the accepted regular-file identities until publication.
struct NativeExportSources: Sendable {
    struct File: Equatable, Sendable {
        let alias: String
        let path: String
        let stamp: String
        let parents: [String]
    }
    let rootStamp: String
    let files: [File]

    static func references(_ project: String) throws -> [String] {
        let fields = try JSON.parse(project) as? [String: Any] ?? [:]
        var refs = Set<String>()
        for (src, value) in fields["assets"] as? [String: Any] ?? [:] {
            refs.insert(src)
            if let proxy = (value as? [String: Any])?["proxy"] as? String, !proxy.isEmpty { refs.insert(proxy) }
        }
        func walk(_ value: Any, depth: Int) throws {
            guard depth <= 64 else { throw ReelBackend.APIError("The export graph is too deeply nested.") }
            if let object = value as? [String: Any] {
                for (key, item) in object {
                    if ["src", "proxy", "lut"].contains(key), let path = item as? String, !path.isEmpty { refs.insert(path) }
                    try walk(item, depth: depth + 1)
                }
            } else if let array = value as? [Any] { for item in array { try walk(item, depth: depth + 1) } }
        }
        try walk(fields, depth: 0)
        guard refs.count <= 4096, refs.allSatisfy({ $0.utf8.count <= 4096 }) else { throw ReelBackend.APIError("An export supports at most 4096 source paths of at most 4096 bytes.") }
        return refs.sorted()
    }

    static func rootIdentity(_ folder: ProjectFolder) throws -> String {
        var info = Darwin.stat()
        guard folder.root.path.withCString({ Darwin.lstat($0, &info) }) == 0, info.st_mode & S_IFMT == S_IFDIR else { throw ReelBackend.APIError("The export project folder is unavailable.") }
        return "\(info.st_dev)|\(info.st_ino)"
    }

    static func identity(_ alias: String, folder: ProjectFolder) throws -> File {
        let path = try folder.resolve(alias).path
        let components = folder.relative(URL(fileURLWithPath: path)).split(separator: "/").map(String.init)
        guard let name = components.last else { throw ReelBackend.APIError("Choose a regular export source.") }
        var directory = folder.root.path.withCString { Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
        guard directory >= 0 else { throw ReelBackend.APIError("The source project folder is unavailable.") }
        defer { Darwin.close(directory) }
        var parents: [String] = [], parentPaths: [URL] = [], current = folder.root
        func record() throws {
            var held = Darwin.stat(), named = Darwin.stat()
            guard Darwin.fstat(directory, &held) == 0, current.path.withCString({ Darwin.lstat($0, &named) }) == 0,
                  held.st_mode & S_IFMT == S_IFDIR, held.st_dev == named.st_dev, held.st_ino == named.st_ino else { throw ReelBackend.APIError("An export source directory changed.") }
            parents.append("\(held.st_dev)|\(held.st_ino)"); parentPaths.append(current)
        }
        try record()
        for component in components.dropLast() {
            let child = component.withCString { Darwin.openat(directory, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
            guard child >= 0 else { throw ReelBackend.APIError("An export source directory is unavailable.") }
            Darwin.close(directory); directory = child; current = current.appendingPathComponent(component)
            try record()
        }
        let fd = name.withCString { Darwin.openat(directory, $0, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC) }
        guard fd >= 0 else { throw ReelBackend.APIError("The export source is missing or unreadable: \(alias).") }
        defer { Darwin.close(fd) }
        var held = Darwin.stat(), named = Darwin.stat()
        guard Darwin.fstat(fd, &held) == 0, held.st_mode & S_IFMT == S_IFREG, held.st_size >= 0,
              path.withCString({ Darwin.lstat($0, &named) }) == 0, held.st_dev == named.st_dev, held.st_ino == named.st_ino else { throw ReelBackend.APIError("Export needs a stable regular source file: \(alias).") }
        let stamp = "\(held.st_dev)|\(held.st_ino)|\(held.st_size)|\(held.st_mtimespec.tv_sec)|\(held.st_mtimespec.tv_nsec)|\(held.st_ctimespec.tv_sec)|\(held.st_ctimespec.tv_nsec)"
        for (index, parent) in parentPaths.enumerated() {
            var named = Darwin.stat()
            guard parent.path.withCString({ Darwin.lstat($0, &named) }) == 0, named.st_mode & S_IFMT == S_IFDIR,
                  "\(named.st_dev)|\(named.st_ino)" == parents[index] else { throw ReelBackend.APIError("An export source directory changed during capture.") }
        }
        guard try folder.resolve(alias).path == path else { throw ReelBackend.APIError("An export source alias changed during capture.") }
        return File(alias: alias, path: path, stamp: stamp, parents: parents)
    }

    static func capture(project: String, folder: ProjectFolder) throws -> Self {
        let root = try rootIdentity(folder)
        let files = try references(project).map { try identity($0, folder: folder) }
        guard try rootIdentity(folder) == root else { throw ReelBackend.APIError("The export project folder changed during capture.") }
        return Self(rootStamp: root, files: files)
    }

    func validate(folder: ProjectFolder) throws {
        try Task.checkCancellation()
        guard try Self.rootIdentity(folder) == rootStamp else { throw ReelBackend.APIError("The export project folder changed. No output was completed.") }
        for file in files {
            try Task.checkCancellation()
            guard try Self.identity(file.alias, folder: folder) == file else { throw ReelBackend.APIError("The source changed during export: \(file.alias). No output was completed.") }
        }
    }

    var json: JSON { .array(files.map { .object([("source", .string($0.alias)), ("resolvedPath", .string($0.path)), ("identity", .string($0.stamp))]) }) }
}
