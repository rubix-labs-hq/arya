import Darwin
import Foundation

/// Imports read held regular files into private probe snapshots. Only completed copies
/// in media are retained after failure; cleanup never removes a selected original.
enum NativeMediaImportSource {
    static let maximumBytes: Int64 = 64 * 1024 * 1024 * 1024
    static let bufferBytes = 65_536
    static let maximumRetainedFiles = 32

    struct RetainedCopyFailure: LocalizedError {
        let path: String, cause: Error
        var errorDescription: String? { "\(cause.localizedDescription) The completed copy remains at \(path), but was not registered in Media. Your selected original remains unchanged." }
    }

    struct Stamp: Equatable, Sendable {
        let device: Int32, inode: UInt64, bytes: Int64, mode: UInt16, links: UInt16, owner: UInt32, group: UInt32
        let modifiedSeconds: Int, modifiedNanos: Int, changedSeconds: Int, changedNanos: Int
        init(_ value: Darwin.stat) throws {
            guard value.st_mode & S_IFMT == S_IFREG, value.st_size >= 0,
                  value.st_size <= NativeMediaImportSource.maximumBytes else {
                throw ReelBackend.APIError("Choose a nonempty regular media file up to 64 GiB. Symbolic links and special files are not imported.")
            }
            device = value.st_dev; inode = value.st_ino; bytes = value.st_size
            mode = value.st_mode; links = value.st_nlink; owner = value.st_uid; group = value.st_gid
            modifiedSeconds = value.st_mtimespec.tv_sec; modifiedNanos = value.st_mtimespec.tv_nsec
            changedSeconds = value.st_ctimespec.tv_sec; changedNanos = value.st_ctimespec.tv_nsec
        }
    }
    struct DirectoryStamp: Equatable, Sendable {
        let device: Int32, inode: UInt64
        init(_ fd: Int32) throws {
            var info = Darwin.stat()
            guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { throw NativeMediaImportSource.posix("Reading import directory identity") }
            device = info.st_dev; inode = info.st_ino
        }
    }
    final class Root: @unchecked Sendable {
        let folder: ProjectFolder, descriptor: Int32, identity: DirectoryStamp
        init(_ folder: ProjectFolder) throws {
            let fd = try NativeMediaImportSource.openDirectory(folder.root)
            do { identity = try DirectoryStamp(fd) }
            catch { close(fd); throw error }
            self.folder = folder; descriptor = fd
        }
        deinit { close(descriptor) }
        func validate() throws {
            let fd = try NativeMediaImportSource.openDirectory(folder.root)
            defer { close(fd) }
            guard try DirectoryStamp(fd) == identity, try DirectoryStamp(descriptor) == identity else {
                throw ReelBackend.APIError("The project folder changed during import. Reopen it before importing media.")
            }
        }
        func directory(_ relative: String, create: Bool, exclusiveFinal: Bool = false) throws -> Int32 {
            try validate()
            let parts = relative.split(separator: "/").map(String.init)
            guard parts.allSatisfy({ $0 != "." && $0 != ".." && !$0.contains("\0") }) else { throw ReelBackend.APIError("Invalid import destination.") }
            var fd = dup(descriptor)
            guard fd >= 0 else { throw NativeMediaImportSource.posix("Duplicating project directory descriptor") }
            do {
                for (index, name) in parts.enumerated() {
                    if create, mkdirat(fd, name, 0o700) != 0 {
                        if errno != EEXIST || (exclusiveFinal && index == parts.count - 1) { throw NativeMediaImportSource.posix("Creating import directory \(name)") }
                    }
                    let next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    guard next >= 0 else { throw NativeMediaImportSource.posix("Opening import directory \(name)") }
                    close(fd); fd = next
                }
                return fd
            } catch { close(fd); throw error }
        }
    }
    private final class CoordinationPreflight {
        let url: URL, parent: Int32, parentIdentity: DirectoryStamp
        let device: Int32, inode: UInt64
        init(_ selected: URL) throws {
            let url = NativeMediaImportSource.normalized(selected)
            let parent = try NativeMediaImportSource.openDirectory(url.deletingLastPathComponent())
            do {
                var named = Darwin.stat()
                guard fstatat(parent, url.lastPathComponent, &named, AT_SYMLINK_NOFOLLOW) == 0 else { throw NativeMediaImportSource.posix("Reading selected media identity") }
                guard named.st_mode & S_IFMT == S_IFREG else {
                    throw ReelBackend.APIError("Choose a regular media file. Symbolic links and special files are not imported.")
                }
                parentIdentity = try DirectoryStamp(parent)
                self.url = url; self.parent = parent; device = named.st_dev; inode = named.st_ino
            } catch { close(parent); throw error }
        }
        deinit { close(parent) }
        func validate(captured: Stamp? = nil) throws {
            try Task.checkCancellation()
            let current = try NativeMediaImportSource.openDirectory(url.deletingLastPathComponent())
            defer { close(current) }
            guard try DirectoryStamp(current) == parentIdentity, try DirectoryStamp(parent) == parentIdentity else {
                throw ReelBackend.APIError("The selected media folder changed before coordinated import. Select it again.")
            }
            var named = Darwin.stat()
            guard fstatat(parent, url.lastPathComponent, &named, AT_SYMLINK_NOFOLLOW) == 0,
                  named.st_mode & S_IFMT == S_IFREG, named.st_dev == device, named.st_ino == inode,
                  captured.map({ $0.device == device && $0.inode == inode }) ?? true else {
                throw ReelBackend.APIError("The selected media changed before coordinated import. Select it again.")
            }
        }
    }
    fileprivate final class Access: @unchecked Sendable {
        let url: URL, scoped: Bool
        init(_ url: URL) { self.url = url; scoped = url.startAccessingSecurityScopedResource() }
        deinit { if scoped { url.stopAccessingSecurityScopedResource() } }
    }
    fileprivate final class Entry: @unchecked Sendable {
        let url: URL, parent: Int32, descriptor: Int32, parentIdentity: DirectoryStamp?
        var identity: Stamp
        init(url: URL, parent: Int32, descriptor: Int32) throws {
            self.url = url; self.parent = parent; self.descriptor = descriptor
            parentIdentity = parent >= 0 ? try DirectoryStamp(parent) : nil; identity = try NativeMediaImportSource.stamp(descriptor)
        }
        deinit { close(descriptor); if parent >= 0 { close(parent) } }
        func validate() throws {
            try NativeMediaImportSource.requirePath(descriptor, url: url)
            if let parentIdentity {
                let currentParent = try NativeMediaImportSource.openDirectory(url.deletingLastPathComponent())
                defer { close(currentParent) }
                guard try DirectoryStamp(currentParent) == parentIdentity else { throw ReelBackend.APIError("The selected or copied media folder changed during import.") }
            }
            var named = Darwin.stat()
            let read = parent >= 0 ? fstatat(parent, url.lastPathComponent, &named, AT_SYMLINK_NOFOLLOW) : lstat(url.path, &named)
            guard read == 0, try Stamp(named) == identity, try NativeMediaImportSource.stamp(descriptor) == identity else {
                throw ReelBackend.APIError("The selected or copied media changed during import. Select it again.")
            }
        }
        func removeIfOwned() {
            var held = Darwin.stat(), named = Darwin.stat()
            if fstat(descriptor, &held) == 0,
               fstatat(parent, url.lastPathComponent, &named, AT_SYMLINK_NOFOLLOW) == 0,
               held.st_dev == named.st_dev, held.st_ino == named.st_ino,
               named.st_mode & S_IFMT == S_IFREG { _ = unlinkat(parent, url.lastPathComponent, 0) }
        }
    }
    final class Snapshot: @unchecked Sendable {
        let file: URL, bytes: Int64
        private let root: Root, source: Entry, stage: Entry, destination: Entry?, access: Access
        private let stageDirectory: URL, stageDirectoryIdentity: DirectoryStamp
        fileprivate init(root: Root, source: Entry, stage: Entry, destination: Entry?, access: Access) throws {
            self.root = root; self.source = source; self.stage = stage; self.destination = destination; self.access = access
            file = stage.url; bytes = source.identity.bytes
            stageDirectory = stage.url.deletingLastPathComponent(); stageDirectoryIdentity = try DirectoryStamp(stage.parent)
        }
        deinit {
            stage.removeIfOwned()
            if let fd = try? NativeMediaImportSource.openDirectory(stageDirectory, checkCancellation: false) {
                if (try? DirectoryStamp(fd)) == stageDirectoryIdentity { _ = rmdir(stageDirectory.path) }
                close(fd)
            }
        }
        func validate() throws {
            try Task.checkCancellation()
            try root.validate(); try source.validate(); try stage.validate(); try destination?.validate()
        }
    }

    static func directoryIdentity(_ url: URL) throws -> DirectoryStamp {
        let fd = try NativeMediaImportSource.openDirectory(url)
        defer { close(fd) }
        return try DirectoryStamp(fd)
    }
    static func selectedStamp(_ url: URL) throws -> Stamp {
        let access = Access(url)
        defer { withExtendedLifetime(access) {} }
        let preflight = try CoordinationPreflight(url)
        var result: Result<Stamp, Error>?, coordinationError: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordinationError) { coordinated in
            result = Result {
                try preflight.validate()
                guard normalized(coordinated).path == normalized(url).path else { throw ReelBackend.APIError("The provider changed the selected import path. Select it again.") }
                let fd = Darwin.open(coordinated.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
                guard fd >= 0 else { throw NativeMediaImportSource.posix("Opening selected media for validation") }
                defer { close(fd) }
                let captured = try NativeMediaImportSource.stamp(fd)
                try preflight.validate(captured: captured)
                guard captured.bytes > 0 else { throw ReelBackend.APIError("Choose a nonempty regular media file.") }
                try NativeMediaImportSource.requirePath(fd, url: coordinated)
                var named = Darwin.stat()
                guard lstat(coordinated.path, &named) == 0, try Stamp(named) == captured else { throw ReelBackend.APIError("The selected media changed before import.") }
                try preflight.validate(captured: captured)
                return captured
            }
        }
        if let coordinationError { throw contextual(coordinationError, operation: "Coordinating selected media validation") }
        guard let result else { throw ReelBackend.APIError("The selected media could not be coordinated for import.") }
        return try result.get()
    }
    static func prepare(_ selected: URL, root: Root, destination: String? = nil,
                        scope: URL? = nil, expected: Stamp? = nil,
                        selectionRoot: URL? = nil, selectionIdentity: DirectoryStamp? = nil) async throws -> Snapshot {
        let worker = Task.detached(priority: .utility) {
            try prepareSync(selected, root: root, destination: destination, scope: scope,
                            expected: expected, selectionRoot: selectionRoot, selectionIdentity: selectionIdentity)
        }
        return try await withTaskCancellationHandler(operation: { try await worker.value }, onCancel: { worker.cancel() })
    }
    static func prepareSync(_ selected: URL, root: Root, destination: String? = nil,
                            scope: URL? = nil, expected: Stamp? = nil,
                            selectionRoot: URL? = nil, selectionIdentity: DirectoryStamp? = nil,
                            afterDescriptorValidation: (() throws -> Void)? = nil,
                            afterChunk: ((Int64) throws -> Void)? = nil) throws -> Snapshot {
        let access = Access(scope ?? selected)
        let preflight = try CoordinationPreflight(selected)
        var result: Result<Snapshot, Error>?, coordinationError: NSError?
        let copy = { (sourceURL: URL, destinationURL: URL?) in
            result = Result {
                try Task.checkCancellation(); try root.validate()
                try preflight.validate()
                guard normalized(sourceURL).path == normalized(selected).path else { throw ReelBackend.APIError("The provider changed the selected import path. Select it again.") }
                if let selectionRoot, let selectionIdentity {
                    guard try NativeMediaImportSource.directoryIdentity(selectionRoot) == selectionIdentity else { throw ReelBackend.APIError("The selected media folder changed during import. Select it again.") }
                }
                let input = Darwin.open(sourceURL.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
                guard input >= 0 else { throw NativeMediaImportSource.posix("Opening selected media for copy") }
                let source: Entry
                do { source = try Entry(url: normalized(sourceURL), parent: -1, descriptor: input) }
                catch { close(input); throw error }
                try source.validate()
                try preflight.validate(captured: source.identity)
                guard source.identity.bytes > 0 else { throw ReelBackend.APIError("Choose a nonempty regular media file.") }
                if let expected, source.identity != expected { throw ReelBackend.APIError("The selected media changed after folder selection. Select it again.") }
                try afterDescriptorValidation?()
                try source.validate()
                let storageBytes = source.identity.bytes * (destination == nil ? 1 : 2) + 16 * 1024 * 1024
                if let available = try? root.folder.cacheDir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage,
                   available < storageBytes { throw ReelBackend.APIError("There is not enough free storage to copy and check this media safely.") }
                let name = ProjectFolder.cleanFileName(selected.lastPathComponent)
                let stageRelative = ".reel/cache/import-\(UUID().uuidString)"
                let stageParent = try root.directory(stageRelative, create: true, exclusiveFinal: true)
                let stageDirectoryIdentity = try DirectoryStamp(stageParent)
                let stageURL = root.folder.root.appendingPathComponent(stageRelative).appendingPathComponent(name)
                var stage: Entry?
                var stageParentOwned = true
                var copied: Entry?
                var complete = false
                defer {
                    if !complete { stage?.removeIfOwned(); copied?.removeIfOwned() }
                    if stageParentOwned { close(stageParent) }
                    if !complete, let current = try? NativeMediaImportSource.openDirectory(stageURL.deletingLastPathComponent(), checkCancellation: false) {
                        if (try? DirectoryStamp(current)) == stageDirectoryIdentity { _ = rmdir(stageURL.deletingLastPathComponent().path) }
                        close(current)
                    }
                }
                stageParentOwned = false
                stage = try create(stageURL, parent: stageParent)
                if let destination, let destinationURL {
                    let expectedURL = try root.folder.output(destination)
                    guard normalized(destinationURL).path == normalized(expectedURL).path else { throw ReelBackend.APIError("The provider changed the import destination. Retry the import.") }
                    let parentPath = (destination as NSString).deletingLastPathComponent
                    let outputParent = try root.directory(parentPath, create: true)
                    copied = try create(expectedURL, parent: outputParent)
                }
                let stageEntry = stage!
                try copyBytes(source.descriptor, capturedBytes: source.identity.bytes,
                              outputs: [stageEntry.descriptor] + (copied.map { [$0.descriptor] } ?? []), afterChunk: afterChunk)
                try source.validate(); try root.validate()
                for entry in [stageEntry] + (copied.map { [$0] } ?? []) {
                    guard fsync(entry.descriptor) == 0 else { throw NativeMediaImportSource.posix("Flushing a completed import copy") }
                }
                guard fchmod(stageEntry.descriptor, 0o400) == 0 else { throw NativeMediaImportSource.posix("Making the private probe snapshot read-only") }
                stageEntry.identity = try NativeMediaImportSource.stamp(stageEntry.descriptor)
                if let copied { copied.identity = try NativeMediaImportSource.stamp(copied.descriptor) }
                let snapshot = try Snapshot(root: root, source: source, stage: stageEntry, destination: copied, access: access)
                try snapshot.validate()
                try preflight.validate(captured: source.identity)
                complete = true
                return snapshot
            }
        }
        try root.validate()
        try preflight.validate()
        let coordinator = NSFileCoordinator(filePresenter: nil)
        if let destination {
            let target = try root.folder.output(destination)
            try refuseExistingDestination(target)
            coordinator.coordinate(readingItemAt: selected, options: [], writingItemAt: target, options: [], error: &coordinationError) { copy($0, $1) }
        } else { coordinator.coordinate(readingItemAt: selected, options: [], error: &coordinationError) { copy($0, nil) } }
        if let coordinationError {
            let error = contextual(coordinationError, operation: "Coordinating selected media and its destination")
            if let destination, let result, case .success(_) = result { throw RetainedCopyFailure(path: destination, cause: error) }
            throw error
        }
        guard let result else { throw ReelBackend.APIError("The selected media could not be coordinated for import.") }
        return try result.get()
    }
    private static func refuseExistingDestination(_ url: URL) throws {
        var named = Darwin.stat()
        if lstat(normalized(url).path, &named) == 0 {
            throw ReelBackend.APIError("The import destination already exists. Its files were preserved. Choose another name.")
        }
        guard errno == ENOENT else { throw NativeMediaImportSource.posix("Checking that the import destination is unused") }
    }
    private static func create(_ url: URL, parent: Int32) throws -> Entry {
        let fd = openat(parent, url.lastPathComponent, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
        guard fd >= 0 else { let error = NativeMediaImportSource.posix("Creating an exclusive import copy"); close(parent); throw error }
        do { return try Entry(url: url, parent: parent, descriptor: fd) } catch { _ = unlinkat(parent, url.lastPathComponent, 0); close(fd); close(parent); throw error }
    }
    private static func copyBytes(_ input: Int32, capturedBytes: Int64, outputs: [Int32], afterChunk: ((Int64) throws -> Void)?) throws {
        var buffer = [UInt8](repeating: 0, count: bufferBytes), total: Int64 = 0
        for fd in outputs { guard ftruncate(fd, 0) == 0 else { throw NativeMediaImportSource.posix("Preparing import copy length") } }
        while total < capturedBytes {
            try Task.checkCancellation()
            let requested = Int(min(Int64(buffer.count), capturedBytes - total))
            let count = buffer.withUnsafeMutableBytes { pread(input, $0.baseAddress, requested, off_t(total)) }
            if count < 0, errno == EINTR { continue }
            guard count > 0 else { throw ReelBackend.APIError("The selected media ended while copying. Select it again.") }
            for fd in outputs {
                var offset = 0
                while offset < count {
                    try Task.checkCancellation()
                    let written = buffer.withUnsafeBytes { pwrite(fd, $0.baseAddress!.advanced(by: offset), count - offset, off_t(total + Int64(offset))) }
                    if written < 0, errno == EINTR { continue }
                    guard written > 0 else { throw NativeMediaImportSource.posix("Writing import copy bytes") }
                    offset += written
                }
            }
            total += Int64(count)
            try afterChunk?(total)
        }
        var byte: UInt8 = 0
        var extra: Int
        repeat { extra = pread(input, &byte, 1, off_t(total)) } while extra < 0 && errno == EINTR
        guard extra == 0 else { throw ReelBackend.APIError("The selected media grew while copying. Select it again.") }
        try Task.checkCancellation()
    }
    private static func stamp(_ fd: Int32) throws -> Stamp {
        var value = Darwin.stat()
        guard fstat(fd, &value) == 0 else { throw NativeMediaImportSource.posix("Reading import file identity") }
        return try Stamp(value)
    }
    private static func normalized(_ url: URL) -> URL {
        let value = url.standardizedFileURL.path
        // Darwin exposes these two system aliases to Files and temporary URLs.
        if value == "/var" || value.hasPrefix("/var/") || value == "/tmp" || value.hasPrefix("/tmp/") {
            return URL(fileURLWithPath: "/private" + value)
        }
        return url.standardizedFileURL
    }
    private static func requirePath(_ fd: Int32, url: URL) throws {
        var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard path.withUnsafeMutableBufferPointer({ fcntl(fd, F_GETPATH, $0.baseAddress!) }) == 0,
              normalized(URL(fileURLWithPath: String(cString: path))).path == normalized(url).path else {
            throw ReelBackend.APIError("The selected or copied media path changed or uses a symbolic link. Select its original path to retry.")
        }
    }
    private static func openDirectory(_ url: URL, checkCancellation: Bool = true) throws -> Int32 {
        if checkCancellation { try Task.checkCancellation() }
        let fd = Darwin.open(normalized(url).path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw NativeMediaImportSource.posix("Opening import directory \(url.lastPathComponent)") }
        do { try NativeMediaImportSource.requirePath(fd, url: url); return fd }
        catch { close(fd); throw error }
    }
    private static func posix(_ operation: String) -> NSError {
        let code = errno
        return contextual(NSError(domain: NSPOSIXErrorDomain, code: Int(code)), operation: operation)
    }
    static func contextual(_ error: NSError, operation: String) -> NSError {
        var info = error.userInfo
        info[NSLocalizedDescriptionKey] = "\(operation): \(error.localizedDescription)"
        info[NSUnderlyingErrorKey] = error
        return NSError(domain: error.domain, code: error.code, userInfo: info)
    }
}
