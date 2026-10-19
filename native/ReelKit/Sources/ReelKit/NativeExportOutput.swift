import Darwin
import Foundation

/// Holds output directories and uses an exclusive rename for files and frame sequences.
final class NativeExportOutput: @unchecked Sendable {
    private struct Directory {
        let fd: Int32
        let path: URL
        let device: dev_t
        let inode: ino_t
    }
    let destination: URL
    let part: URL
    private let folder: ProjectFolder
    private let directories: [Directory]
    private let stage: Directory
    private let stageName: String

    private static func posix() -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    static func refuseExisting(_ url: URL, folder: ProjectFolder) throws {
        let path = try folder.output(url.path).path
        var info = Darwin.stat()
        if path.withCString({ Darwin.lstat($0, &info) }) == 0 { throw ReelBackend.APIError("The output already exists: \(folder.relative(url)). Choose another name.") }
        guard errno == ENOENT else { throw posix() }
    }

    init(folder: ProjectFolder, destination: URL) throws {
        self.folder = folder
        self.destination = try folder.output(destination.path)
        try Self.refuseExisting(self.destination, folder: folder)
        let parts = folder.relative(self.destination).split(separator: "/").map(String.init)
        guard parts.count >= 2 else { throw ReelBackend.APIError("Choose an output inside a project output folder.") }
        var held: [Directory] = []
        var ownedStage: Directory?
        func hold(_ fd: Int32, _ path: URL) throws {
            guard fd >= 0 else { throw Self.posix() }
            var info = Darwin.stat()
            guard Darwin.fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { Darwin.close(fd); throw Self.posix() }
            held.append(Directory(fd: fd, path: path, device: info.st_dev, inode: info.st_ino))
        }
        do {
            try hold(folder.root.path.withCString { Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }, folder.root)
            for component in parts.dropLast() {
                let parent = held.last!
                if component.withCString({ Darwin.mkdirat(parent.fd, $0, 0o700) }) != 0, errno != EEXIST { throw Self.posix() }
                try hold(component.withCString { Darwin.openat(parent.fd, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }, parent.path.appendingPathComponent(component))
            }
            let parent = held.last!, name = ".output-\(UUID().uuidString).stage"
            guard name.withCString({ Darwin.mkdirat(parent.fd, $0, 0o700) }) == 0 else { throw Self.posix() }
            let path = parent.path.appendingPathComponent(name)
            let fd = name.withCString { Darwin.openat(parent.fd, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
            var info = Darwin.stat()
            guard fd >= 0, Darwin.fstat(fd, &info) == 0 else { if fd >= 0 { Darwin.close(fd) }; throw Self.posix() }
            let capturedStage = Directory(fd: fd, path: path, device: info.st_dev, inode: info.st_ino)
            ownedStage = capturedStage
            directories = held
            stage = capturedStage
            stageName = name
            part = path.appendingPathComponent("output.part")
            try validateDirectories()
            try Self.refuseExisting(self.destination, folder: folder)
        } catch {
            if let ownedStage {
                var named = Darwin.stat()
                if let parent = held.last, Darwin.fstatat(parent.fd, ownedStage.path.lastPathComponent, &named, AT_SYMLINK_NOFOLLOW) == 0,
                   named.st_dev == ownedStage.device, named.st_ino == ownedStage.inode { _ = Darwin.unlinkat(parent.fd, ownedStage.path.lastPathComponent, AT_REMOVEDIR) }
                Darwin.close(ownedStage.fd)
            }
            for directory in held { Darwin.close(directory.fd) }
            throw error
        }
    }

    private func matches(_ directory: Directory) -> Bool {
        var held = Darwin.stat(), named = Darwin.stat()
        return Darwin.fstat(directory.fd, &held) == 0 && directory.path.path.withCString({ Darwin.lstat($0, &named) }) == 0 &&
            named.st_mode & S_IFMT == S_IFDIR && held.st_dev == directory.device && held.st_ino == directory.inode &&
            named.st_dev == directory.device && named.st_ino == directory.inode
    }
    func validateDirectories() throws {
        guard directories.allSatisfy(matches), matches(stage), try folder.output(destination.path).path == destination.path else { throw ReelBackend.APIError("The export output folder changed. Its files were preserved.") }
    }

    func publish() throws -> URL {
        try Task.checkCancellation()
        try validateDirectories()
        let parent = directories.last!
        var info = Darwin.stat()
        guard Darwin.fstatat(stage.fd, "output.part", &info, AT_SYMLINK_NOFOLLOW) == 0,
              (info.st_mode & S_IFMT == S_IFREG && info.st_nlink == 1 && info.st_size > 0) || info.st_mode & S_IFMT == S_IFDIR else { throw ReelBackend.APIError("The owned export output is missing or invalid.") }
        // RENAME_EXCL refuses every existing leaf, including an empty file or dangling link.
        guard destination.lastPathComponent.withCString({ Darwin.renameatx_np(stage.fd, "output.part", parent.fd, $0, UInt32(RENAME_EXCL)) }) == 0 else {
            if errno == EEXIST { throw ReelBackend.APIError("The output appeared during export. It was preserved. Choose another name.") }
            throw Self.posix()
        }
        try validateDirectories()
        return destination
    }

    private func removeOwnedContents(_ fd: Int32, depth: Int, remaining: inout Int) {
        guard depth <= 4, remaining > 0 else { return }
        let duplicate = Darwin.dup(fd)
        guard duplicate >= 0 else { return }
        guard let stream = Darwin.fdopendir(duplicate) else { Darwin.close(duplicate); return }
        defer { Darwin.closedir(stream) }
        while remaining > 0, let entry = Darwin.readdir(stream) {
            let name = withUnsafeBytes(of: entry.pointee.d_name) { bytes in String(cString: bytes.baseAddress!.assumingMemoryBound(to: CChar.self)) }
            if name == "." || name == ".." { continue }
            remaining -= 1
            var info = Darwin.stat()
            guard Darwin.fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { continue }
            if info.st_mode & S_IFMT == S_IFDIR {
                let child = Darwin.openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard child >= 0 else { continue }
                var held = Darwin.stat()
                if Darwin.fstat(child, &held) == 0, held.st_dev == info.st_dev, held.st_ino == info.st_ino {
                    removeOwnedContents(child, depth: depth + 1, remaining: &remaining)
                    var named = Darwin.stat()
                    if Darwin.fstatat(fd, name, &named, AT_SYMLINK_NOFOLLOW) == 0, named.st_dev == held.st_dev, named.st_ino == held.st_ino { _ = Darwin.unlinkat(fd, name, AT_REMOVEDIR) }
                }
                Darwin.close(child)
            } else { _ = Darwin.unlinkat(fd, name, 0) }
        }
    }

    func cleanup() {
        // Remove only entries in the held private directory, even if its path moved.
        var remaining = 216_010
        removeOwnedContents(stage.fd, depth: 0, remaining: &remaining)
        var named = Darwin.stat()
        let parent = directories.last!
        if Darwin.fstatat(parent.fd, stageName, &named, AT_SYMLINK_NOFOLLOW) == 0,
           named.st_dev == stage.device, named.st_ino == stage.inode { _ = Darwin.unlinkat(parent.fd, stageName, AT_REMOVEDIR) }
    }
    deinit { cleanup(); Darwin.close(stage.fd); for directory in directories { Darwin.close(directory.fd) } }
}
