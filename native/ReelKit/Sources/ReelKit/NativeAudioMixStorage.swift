import Darwin
import Foundation

/// Private ephemeral copies are never in a project's resolver namespace. Captures and
/// directories retain this owner until their asynchronous workers have actually exited.
final class NativeAudioMixStorage: @unchecked Sendable {
    struct Identity: Equatable, Sendable {
        let device: UInt64, inode: UInt64
        init(_ value: Darwin.stat) {
            device = UInt64(UInt32(bitPattern: value.st_dev)); inode = UInt64(value.st_ino)
        }
    }
    let root: URL
    private let parentPath: String
    private let parentDescriptor: Int32
    fileprivate let descriptor: Int32
    private let name: String
    private let identity: Identity

    init(project: ProjectFolder, temporaryRoot: URL = FileManager.default.temporaryDirectory) throws {
        // Foundation may present /private/var as /var while F_GETPATH returns
        // the physical pathname. Compare descriptor paths in the same namespace.
        let parent = URL(fileURLWithPath: try Self.physicalPath(temporaryRoot.path), isDirectory: true)
        let parentFD = parent.path.withCString { Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
        guard parentFD >= 0 else { throw Self.systemError() }
        let name = "arya-private-mix-" + UUID().uuidString
        var directoryFD: Int32 = -1, ownedIdentity: Identity?, complete = false
        defer {
            if !complete {
                if directoryFD >= 0 { Darwin.close(directoryFD) }
                if let ownedIdentity, Self.entryMatches(parentFD, name, ownedIdentity) {
                    name.withCString { _ = Darwin.unlinkat(parentFD, $0, AT_REMOVEDIR) }
                }
                Darwin.close(parentFD)
            }
        }
        var parentStat = Darwin.stat()
        guard Darwin.fstat(parentFD, &parentStat) == 0, parentStat.st_mode & S_IFMT == S_IFDIR,
              parentStat.st_uid == geteuid(), parentStat.st_mode & 0o022 == 0,
              try Self.descriptorPath(parentFD) == parent.path else {
            throw ReelBackend.APIError("Private mix storage needs an owned temporary directory.")
        }
        let candidate = parent.appendingPathComponent(name, isDirectory: true)
        guard !project.contains(candidate), !ProjectFolder(root: candidate).contains(project.root) else {
            throw ReelBackend.APIError("Private mix storage must be outside the project folder.")
        }
        guard name.withCString({ Darwin.mkdirat(parentFD, $0, 0o700) }) == 0 else { throw Self.systemError() }
        directoryFD = name.withCString { Darwin.openat(parentFD, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
        guard directoryFD >= 0 else { throw Self.systemError() }
        var value = Darwin.stat()
        guard Darwin.fstat(directoryFD, &value) == 0, value.st_mode & S_IFMT == S_IFDIR,
              value.st_uid == geteuid(), value.st_mode & 0o777 == 0o700 else {
            throw ReelBackend.APIError("The private mix storage directory changed.")
        }
        ownedIdentity = Identity(value)
        let path = try Self.descriptorPath(directoryFD)
        let root = URL(fileURLWithPath: path, isDirectory: true)
        guard path == parent.appendingPathComponent(name).path,
              !project.contains(root), !ProjectFolder(root: root).contains(project.root) else {
            throw ReelBackend.APIError("Private mix storage must be outside the project folder.")
        }
        self.root = root; self.parentPath = parent.path; self.parentDescriptor = parentFD
        self.descriptor = directoryFD; self.name = name; self.identity = Identity(value)
        complete = true
    }

    deinit {
        // No recursive pathname deletion; directory symlinks are never followed.
        if Self.entryMatches(parentDescriptor, name, identity) {
            name.withCString { _ = Darwin.unlinkat(parentDescriptor, $0, AT_REMOVEDIR) }
        }
        Darwin.close(descriptor); Darwin.close(parentDescriptor)
    }

    func validate() throws {
        guard try Self.descriptorPath(parentDescriptor) == parentPath,
              try Self.descriptorPath(descriptor) == root.path,
              Self.entryMatches(parentDescriptor, name, identity), Self.isPrivateDirectory(descriptor) else {
            throw ReelBackend.APIError("The private mix storage directory changed.")
        }
    }

    /// Read the filesystem holding the copies, rather than a possibly external project
    /// volume. The value stays local and the existing shared disk reservation still applies.
    func diskBudget() throws -> UInt64 {
        try validate()
        var value = Darwin.statfs()
        guard Darwin.fstatfs(descriptor, &value) == 0, value.f_bsize > 0 else { throw Self.systemError() }
        let free = UInt64(value.f_bavail).multipliedReportingOverflow(by: UInt64(value.f_bsize))
        guard !free.overflow else { throw ReelBackend.APIError("The private mix space estimate overflowed.") }
        let budget = min(1024 * 1024 * 1024, free.partialValue / 8)
        guard budget >= 1024 * 1024 else { throw ReelBackend.APIError("Mix measurement needs more temporary disk space.") }
        return budget
    }

    func makeDirectory(id: String, filenames: [String]) throws -> Directory {
        try validate()
        guard UUID(uuidString: id) != nil, filenames.count <= 256, Set(filenames).count == filenames.count,
              filenames.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("/") && !$0.contains("\0") && $0.utf8.count <= 255 }) else {
            throw ReelBackend.APIError("A private mix capture needs owned source names and a job UUID.")
        }
        let name = "mix-capture-" + id
        guard name.withCString({ Darwin.mkdirat(descriptor, $0, 0o700) }) == 0 else { throw Self.systemError() }
        let fd = name.withCString { Darwin.openat(descriptor, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
        // Without an opened identity, cleanup cannot prove a replaced entry is ours.
        guard fd >= 0 else { throw Self.systemError() }
        do { return try Directory(storage: self, name: name, descriptor: fd, filenames: filenames) }
        catch {
            var value = Darwin.stat()
            let owned = Darwin.fstat(fd, &value) == 0 ? Identity(value) : nil
            Darwin.close(fd)
            if let owned, Self.entryMatches(descriptor, name, owned) {
                name.withCString { _ = Darwin.unlinkat(descriptor, $0, AT_REMOVEDIR) }
            }
            throw error
        }
    }

    fileprivate static func entryMatches(_ parent: Int32, _ name: String, _ identity: Identity) -> Bool {
        var value = Darwin.stat()
        return name.withCString({ Darwin.fstatat(parent, $0, &value, AT_SYMLINK_NOFOLLOW) }) == 0 &&
            value.st_mode & S_IFMT == S_IFDIR && Identity(value) == identity
    }
    fileprivate static func isPrivateDirectory(_ descriptor: Int32) -> Bool {
        var value = Darwin.stat()
        return Darwin.fstat(descriptor, &value) == 0 && value.st_mode & S_IFMT == S_IFDIR &&
            value.st_uid == geteuid() && value.st_mode & 0o777 == 0o700
    }
    fileprivate static func descriptorPath(_ descriptor: Int32) throws -> String {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard buffer.withUnsafeMutableBufferPointer({ Darwin.fcntl(descriptor, F_GETPATH, $0.baseAddress!) }) == 0 else { throw systemError() }
        return String(cString: buffer)
    }
    fileprivate static func physicalPath(_ path: String) throws -> String {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard buffer.withUnsafeMutableBufferPointer({ target in path.withCString { Darwin.realpath($0, target.baseAddress!) != nil } }) else { throw systemError() }
        return String(cString: buffer)
    }
    fileprivate static func systemError() -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }

    final class Directory: @unchecked Sendable {
        let folder: ProjectFolder
        let path: String
        private let storage: NativeAudioMixStorage
        private let name: String
        private let descriptor: Int32
        private let identity: Identity
        private let filenames: Set<String>
        private let lock = NSLock()
        private var cleaned = false

        fileprivate init(storage: NativeAudioMixStorage, name: String, descriptor: Int32, filenames: [String]) throws {
            var value = Darwin.stat()
            guard Darwin.fstat(descriptor, &value) == 0, value.st_mode & S_IFMT == S_IFDIR,
                  value.st_uid == geteuid(), value.st_mode & 0o777 == 0o700 else {
                throw ReelBackend.APIError("The private mix snapshot directory changed.")
            }
            let path = try NativeAudioMixStorage.descriptorPath(descriptor)
            guard path == storage.root.appendingPathComponent(name).path else {
                throw ReelBackend.APIError("The private mix snapshot path changed.")
            }
            self.storage = storage; self.name = name; self.descriptor = descriptor
            self.path = path
            self.identity = Identity(value); self.filenames = Set(filenames)
            self.folder = ProjectFolder(root: URL(fileURLWithPath: path, isDirectory: true))
        }
        deinit { cleanup(); Darwin.close(descriptor) }

        func validate() throws {
            lock.lock(); let removed = cleaned; lock.unlock()
            try storage.validate()
            guard !removed, NativeAudioMixStorage.entryMatches(storage.descriptor, name, identity),
                  NativeAudioMixStorage.isPrivateDirectory(descriptor),
                  try NativeAudioMixStorage.descriptorPath(descriptor) == path else {
                throw ReelBackend.APIError("The private mix snapshot directory changed.")
            }
        }
        func createFile(_ name: String) throws -> Int32 {
            try validate()
            guard filenames.contains(name) else { throw ReelBackend.APIError("The private source name was not captured.") }
            let fd = name.withCString { Darwin.openat(descriptor, $0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600) }
            guard fd >= 0 else { throw NativeAudioMixStorage.systemError() }
            return fd
        }
        func cleanup() {
            lock.lock(); defer { lock.unlock() }
            guard !cleaned else { return }; cleaned = true
            // Names are captured before any copy. unlinkat removes links themselves and
            // refuses directories; it never traverses a replacement into another tree.
            for file in filenames { file.withCString { _ = Darwin.unlinkat(descriptor, $0, 0) } }
            if NativeAudioMixStorage.entryMatches(storage.descriptor, name, identity) {
                name.withCString { _ = Darwin.unlinkat(storage.descriptor, $0, AT_REMOVEDIR) }
            }
        }
    }
}
