import CryptoKit
import Darwin
import Foundation

/// Owns only a uniquely named staging directory. The destination is installed with an
/// exclusive hard link, so an original or a racing destination is never overwritten.
enum NativeMissingMediaRestore {
    static let maximumBytes: Int64 = 64 * 1024 * 1024 * 1024
    struct Identity: Equatable {
        let device: Int32, inode: UInt64, size: Int64, seconds: Int64, nanos: Int64, changeSeconds: Int64, changeNanos: Int64
        init(_ fd: Int32) throws {
            var info = Darwin.stat()
            guard fstat(fd, &info) == 0 else { throw NativeMissingMediaRestore.posix() }
            guard info.st_mode & S_IFMT == S_IFREG else { throw ReelBackend.APIError("Choose a regular original media file, rather than a symbolic link or folder.") }
            device = info.st_dev; inode = info.st_ino; size = info.st_size
            seconds = Int64(info.st_mtimespec.tv_sec); nanos = Int64(info.st_mtimespec.tv_nsec)
            changeSeconds = Int64(info.st_ctimespec.tv_sec); changeNanos = Int64(info.st_ctimespec.tv_nsec)
        }
    }
    // Immutable descriptors cross only to an owned cancellable worker. Each validation
    // opens an independent file descriptor, so no file offset is shared between tasks.
    final class Stage: @unchecked Sendable {
        let directory: URL, file: URL, directoryFD: Int32, rootDevice: Int32, rootInode: UInt64
        let identity: Identity, digest: SHA256.Digest
        init(directory: URL, name: String, directoryFD: Int32, root: Darwin.stat, identity: Identity, digest: SHA256.Digest) {
            self.directory = directory; file = directory.appendingPathComponent(name)
            self.directoryFD = directoryFD; rootDevice = root.st_dev; rootInode = root.st_ino
            self.identity = identity; self.digest = digest
        }
        deinit {
            // unlinkat acts on our held directory, never a replacement path elsewhere.
            _ = unlinkat(directoryFD, file.lastPathComponent, 0)
            var held = Darwin.stat(), current = Darwin.stat()
            if fstat(directoryFD, &held) == 0, lstat(directory.path, &current) == 0,
               held.st_dev == current.st_dev, held.st_ino == current.st_ino { _ = rmdir(directory.path) }
            close(directoryFD)
        }
        func validateIdentity() throws {
            try Task.checkCancellation()
            let fd = openat(directoryFD, file.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard fd >= 0 else { throw NativeMissingMediaRestore.posix() }
            defer { close(fd) }
            guard try Identity(fd) == identity else { throw ReelBackend.APIError("The staged original changed during checking. Select the original again.") }
        }
        func validate() throws {
            try Task.checkCancellation()
            let fd = openat(directoryFD, file.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard fd >= 0 else { throw NativeMissingMediaRestore.posix() }
            defer { close(fd) }
            guard try Identity(fd) == identity, try NativeMissingMediaRestore.hash(fd, maximumBytes: identity.size) == digest,
                  try Identity(fd) == identity else { throw ReelBackend.APIError("The staged original changed while it was being checked. Select the original again.") }
        }
    }

    static func stageAsync(_ selected: URL, folder: ProjectFolder, expectedRoot: (device: Int32, inode: UInt64)) async throws -> Stage {
        let worker = Task.detached(priority: .utility) { try stage(selected, folder: folder, expectedRoot: expectedRoot) }
        return try await withTaskCancellationHandler(operation: { try await worker.value }, onCancel: { worker.cancel() })
    }
    static func validateAsync(_ stage: Stage) async throws {
        let worker = Task.detached(priority: .utility) { try stage.validate() }
        try await withTaskCancellationHandler(operation: { try await worker.value }, onCancel: { worker.cancel() })
    }

    static func posix() -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    static func rootIdentity(_ folder: ProjectFolder) throws -> Darwin.stat {
        let fd = open(folder.root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw posix() }
        defer { close(fd) }
        var info = Darwin.stat()
        guard fstat(fd, &info) == 0 else { throw posix() }
        return info
    }
    static func requireAbsent(_ file: URL) throws {
        var info = Darwin.stat()
        guard lstat(file.path, &info) != 0 else { throw ReelBackend.APIError("This media path already exists. Restoration never replaces an existing file.") }
        guard errno == ENOENT else { throw posix() }
    }
    private static func hash(_ fd: Int32, maximumBytes: Int64) throws -> SHA256.Digest {
        var total: Int64 = 0
        var hasher = SHA256(), buffer = [UInt8](repeating: 0, count: 1024 * 1024)
        while true {
            try Task.checkCancellation()
            let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if count < 0 { if errno == EINTR { continue }; throw posix() }
            if count == 0 { return hasher.finalize() }
            total += Int64(count)
            guard total <= maximumBytes else { throw ReelBackend.APIError("The staged original changed size during checking.") }
            hasher.update(data: Data(buffer[0..<count]))
        }
    }

    /// Copy from a held regular-file descriptor, with bounded buffer/bytes and identity
    /// checks around the copy. Probing later reads our copy, never the mutable selection.
    static func stage(_ selected: URL, folder: ProjectFolder, expectedRoot: (device: Int32, inode: UInt64)) throws -> Stage {
        try Task.checkCancellation()
        let input = open(selected.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard input >= 0 else { throw posix() }
        defer { close(input) }
        let original = try Identity(input)
        guard original.size > 0, original.size <= maximumBytes, ProjectFolder.isMedia(selected.lastPathComponent) else { throw ReelBackend.APIError("Choose a nonempty original media file up to 64 GiB.") }
        let root = try rootIdentity(folder)
        guard root.st_dev == expectedRoot.device, root.st_ino == expectedRoot.inode else { throw ReelBackend.APIError("The project folder was replaced. Reopen it before restoring media.") }
        let cache = try folder.output(folder.cacheDir.path)
        if let available = try? cache.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage,
           available < original.size + 16 * 1024 * 1024 { throw ReelBackend.APIError("There is not enough free storage to restore this original safely.") }
        let directory = try folder.output(cache.appendingPathComponent("restore-\(UUID().uuidString)", isDirectory: true).path)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let dirFD = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard dirFD >= 0 else { _ = rmdir(directory.path); throw posix() }
        let name = "original." + selected.pathExtension.lowercased()
        let output = openat(dirFD, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard output >= 0 else { close(dirFD); _ = rmdir(directory.path); throw posix() }
        var owned = false
        defer {
            close(output)
            if !owned { _ = unlinkat(dirFD, name, 0); close(dirFD); _ = rmdir(directory.path) }
        }
        var hasher = SHA256(), total: Int64 = 0, buffer = [UInt8](repeating: 0, count: 1024 * 1024)
        while true {
            try Task.checkCancellation()
            let count = buffer.withUnsafeMutableBytes { Darwin.read(input, $0.baseAddress, $0.count) }
            if count < 0 { if errno == EINTR { continue }; throw posix() }
            if count == 0 { break }
            total += Int64(count)
            guard total <= original.size, total <= maximumBytes else { throw ReelBackend.APIError("The selected original changed size during restoration.") }
            hasher.update(data: Data(buffer[0..<count]))
            var offset = 0
            while offset < count {
                try Task.checkCancellation()
                let written = buffer.withUnsafeBytes { Darwin.write(output, $0.baseAddress!.advanced(by: offset), count - offset) }
                if written < 0 { if errno == EINTR { continue }; throw posix() }
                guard written > 0 else { throw ReelBackend.APIError("The original could not be copied completely.") }
                offset += written
            }
        }
        guard total == original.size, try Identity(input) == original else { throw ReelBackend.APIError("The selected original changed while copying. Select it again.") }
        guard fsync(output) == 0 else { throw posix() }
        let result = Stage(directory: directory, name: name, directoryFD: dirFD, root: root, identity: try Identity(output), digest: hasher.finalize())
        owned = true
        return result
    }

    /// Revalidates the coordinated JSON bytes and admission at publication. Held directory
    /// descriptors plus O_NOFOLLOW prevent a replaced parent link redirecting the install.
    static func install(_ stage: Stage, source: String, folder: ProjectFolder, expectedText: String,
                        admission: () throws -> Void) throws {
        try stage.validateIdentity()
        let target = try folder.output(source)
        let projectFile = try folder.output(folder.projectFile.path)
        try requireAbsent(target)
        var result: Result<Void, Error>?, coordinationError: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: projectFile, options: [], writingItemAt: target, options: [], error: &coordinationError) { projectURL, targetURL in
            result = Result {
                try admission(); try Task.checkCancellation()
                var projectInfo = Darwin.stat()
                guard projectURL.standardizedFileURL.path == projectFile.path,
                      lstat(projectURL.path, &projectInfo) == 0, projectInfo.st_mode & S_IFMT == S_IFREG,
                      try String(contentsOf: projectURL, encoding: .utf8).utf8.elementsEqual(expectedText.utf8),
                      targetURL.standardizedFileURL.path == target.path else { throw ReelBackend.APIError("The project changed before the original could be restored. Reopen it and try again.") }
                let rootFD = open(folder.root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard rootFD >= 0 else { throw posix() }
                var parent = rootFD
                defer { if parent != rootFD { close(parent) }; close(rootFD) }
                var info = Darwin.stat()
                guard fstat(rootFD, &info) == 0, info.st_dev == stage.rootDevice, info.st_ino == stage.rootInode else { throw ReelBackend.APIError("The project folder was replaced during restoration.") }
                let components = source.split(separator: "/").map(String.init)
                for component in components.dropLast() {
                    if mkdirat(parent, component, 0o700) != 0, errno != EEXIST { throw posix() }
                    let next = openat(parent, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    guard next >= 0 else { throw posix() }
                    if parent != rootFD { close(parent) }; parent = next
                }
                try admission(); try Task.checkCancellation()
                try stage.validateIdentity()
                // linkat fails atomically for every existing leaf, including a dangling link.
                guard linkat(stage.directoryFD, stage.file.lastPathComponent, parent, components.last!, 0) == 0 else { throw posix() }
                _ = fsync(parent)
            }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw ReelBackend.APIError("The missing media could not be coordinated for restoration.") }
        try result.get()
    }
}
