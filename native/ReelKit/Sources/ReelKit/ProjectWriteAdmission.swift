import Foundation
import Darwin

/// A host can update document access synchronously while the backend awaits processing.
/// The lock protects only the reason snapshot; it is never held during file coordination.
public final class ProjectWriteAdmission: @unchecked Sendable {
    public struct RecoveryOperation: Equatable, Sendable {
        let owner: ObjectIdentifier
        let root: String
        let snapshotID: String, familyID: String, host: String, createdAt: String, sha256: String
        let bytes: Int, version: Int
        let observedToken: String
    }

    /// One selected restore can check this permit without a hop to the host actor.
    public final class RecoveryPermission: @unchecked Sendable {
        private let lock = NSLock()
        private let admission: ProjectWriteAdmission
        private let generation: UUID
        private let operation: RecoveryOperation
        private var revoked = false

        fileprivate init(admission: ProjectWriteAdmission, generation: UUID, operation: RecoveryOperation) {
            self.admission = admission; self.generation = generation; self.operation = operation
        }

        public func revoke() { lock.withLock { revoked = true } }

        public func require(_ operation: RecoveryOperation) throws {
            try lock.withLock {
                guard !revoked, self.operation == operation else {
                    throw ReelBackend.APIError("This recovery permission no longer matches the selected operation.")
                }
                try admission.requireRecoveryGeneration(generation)
            }
        }
    }

    private let lock = NSLock()
    private var reason: String?
    private var recoveryAvailable = false
    private var recoveryGeneration = UUID()

    public let projectFileAccess = ProjectFileAccess()

    public init() {}

    public var blockedReason: String? { lock.withLock { reason } }

    public func setBlockedReason(_ reason: String?, recoveryAvailable: Bool = false) {
        lock.withLock {
            self.reason = reason
            self.recoveryAvailable = reason != nil && recoveryAvailable
            recoveryGeneration = UUID()
        }
    }

    public func requireWritable() throws {
        if let reason = blockedReason { throw ReelBackend.APIError("Project is read-only. \(reason)") }
    }

    public func recoveryPermission(for operation: RecoveryOperation) throws -> RecoveryPermission {
        try lock.withLock {
            guard reason != nil, recoveryAvailable else {
                throw ReelBackend.APIError("Files does not permit recovery for this opening request.")
            }
            return RecoveryPermission(admission: self, generation: recoveryGeneration, operation: operation)
        }
    }

    private func requireRecoveryGeneration(_ generation: UUID) throws {
        try lock.withLock {
            guard reason != nil, recoveryAvailable, recoveryGeneration == generation else {
                throw ReelBackend.APIError("Files access changed before the selected recovery was published.")
            }
        }
    }
}


/// The backend publishes bytes without making its document presenter dirty.
public protocol ProjectFilePresenter: NSFilePresenter {
    func projectFileDidPublish(_ data: Data)
}

/// Association never changes admission. External item replacement requires reopen.
public final class ProjectFileAccess: @unchecked Sendable {
    private final class Descriptor {
        let raw: Int32
        init(_ raw: Int32) { self.raw = raw }
        deinit { close(raw) }
    }
    private final class Item {
        let file: URL
        let root: Descriptor, fileDescriptor: Descriptor?
        var rootFD: Int32 { root.raw }
        var fileFD: Int32? { fileDescriptor?.raw }
        init(file: URL) throws {
            self.file = file.standardizedFileURL
            let openedRoot = open(file.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard openedRoot >= 0 else { throw Self.posix() }
            let root = Descriptor(openedRoot)
            let held = openat(root.raw, file.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            if held < 0, errno != ENOENT { throw Self.posix() }
            self.root = root; fileDescriptor = held >= 0 ? Descriptor(held) : nil
            try requireCurrent()
        }
        init(replacing item: Item, stagedFD: Int32) throws {
            file = item.file
            root = try Self.duplicate(item.rootFD)
            fileDescriptor = try Self.duplicate(stagedFD)
        }
        private static func duplicate(_ fd: Int32) throws -> Descriptor {
            let copy = dup(fd)
            guard copy >= 0 else { throw posix() }
            let descriptor = Descriptor(copy)
            guard fcntl(copy, F_SETFD, FD_CLOEXEC) == 0 else { throw posix() }
            return descriptor
        }
        private static func posix() -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        private static func matches(_ a: Darwin.stat, _ b: Darwin.stat) -> Bool { a.st_dev == b.st_dev && a.st_ino == b.st_ino }
        func requireCurrent() throws {
            var root = Darwin.stat(), namedRoot = Darwin.stat(), named = Darwin.stat()
            guard fstat(rootFD, &root) == 0, lstat(file.deletingLastPathComponent().path, &namedRoot) == 0,
                  namedRoot.st_mode & S_IFMT == S_IFDIR, Self.matches(root, namedRoot) else { throw Self.changed() }
            let found = fstatat(rootFD, file.lastPathComponent, &named, AT_SYMLINK_NOFOLLOW)
            if let fileFD {
                var held = Darwin.stat()
                guard fstat(fileFD, &held) == 0, held.st_mode & S_IFMT == S_IFREG,
                      found == 0, named.st_mode & S_IFMT == S_IFREG, Self.matches(held, named) else { throw Self.changed() }
            } else {
                guard found != 0, errno == ENOENT else { throw Self.changed() }
            }
        }
        private static func changed() -> ReelBackend.APIError {
            ReelBackend.APIError("Files replaced or moved the presented project item. Close and reopen its folder before editing.")
        }
    }
    struct Coordination {
        let coordinator: NSFileCoordinator
        let requireCurrent: () throws -> Void
        let preparePublication: (Int32, Data) throws -> () -> Void
    }
    private let lock = NSLock()
    private weak var presenter: (any ProjectFilePresenter)?
    private var item: Result<Item, Error>?
    private var generation = UUID()
    public init() {}

    /// Capture before open and keep the descriptor alive so its inode cannot be reused.
    public func setPresenter(_ presenter: any ProjectFilePresenter, for file: URL) {
        let item = Result { try Item(file: file) }
        lock.withLock { self.presenter = presenter; self.item = item; generation = UUID() }
    }
    public func clearPresenter() {
        lock.withLock { presenter = nil; item = nil; generation = UUID() }
    }
    func coordinate<T>(for file: URL, _ body: (Coordination) throws -> T) throws -> T {
        let (owner, bound, generation) = lock.withLock { (presenter, item, self.generation) }
        guard let bound else {
            return try body(Coordination(coordinator: NSFileCoordinator(filePresenter: nil), requireCurrent: {}, preparePublication: { _, _ in {} }))
        }
        guard let owner else { throw ReelBackend.APIError("The Files presenter ended. Close and reopen its project before editing.") }
        let item = try bound.get()
        let requireCurrent = {
            guard item.file == file.standardizedFileURL,
                  owner.presentedItemURL?.standardizedFileURL == item.file else {
                throw ReelBackend.APIError("Files moved the project presenter. Close and reopen its folder before editing.")
            }
            try item.requireCurrent()
        }
        try requireCurrent()
        // Keep actor isolation and task cancellation on the initiating backend thread.
        // The pinned item rejects pending moves and replacements before and inside access.
        let coordinator = NSFileCoordinator(filePresenter: owner)
        return try body(Coordination(coordinator: coordinator, requireCurrent: requireCurrent, preparePublication: { [self] fd, data in
            let next = try Item(replacing: item, stagedFD: fd)
            return {
                owner.projectFileDidPublish(data)
                self.lock.withLock {
                    if self.generation == generation { self.item = .success(next) }
                }
            }
        }))
    }
}
