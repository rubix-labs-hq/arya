import CryptoKit
import Darwin
import Foundation
import NativeProjectIO

public struct NativeProjectRecoveryChoice: Identifiable, Sendable {
    public let id: String, host: String, familyID: String, createdAt: String, sha256: String
    public let bytes: Int
}
public struct NativeProjectRecoveryOffer: Sendable {
    public let observedToken: String
    public let choices: [NativeProjectRecoveryChoice]
}

/// Recovery files belong to one folder identity. Only verified published pairs can be pruned.
enum NativeProjectRecovery {
    static let maximumBytes = 64 * 1024 * 1024
    static let maximumRetainedBytes: Int64 = 128 * 1024 * 1024
    static let maximumPublished = 12
    struct RootIdentity: Codable, Equatable {
        let device: String, inode: String
        init(_ info: Darwin.stat) { device = String(info.st_dev); inode = String(info.st_ino) }
    }
    struct Family: Codable {
        let protocolVersion: Int
        let familyID: String
        let rootIdentity: RootIdentity
        let createdAt: String
        enum CodingKeys: String, CodingKey { case protocolVersion = "protocol", familyID, rootIdentity, createdAt }
    }
    struct Receipt: Codable {
        let protocolVersion: Int
        let kind: String
        let host: String
        let familyID: String
        let rootIdentity: RootIdentity
        let id: String
        let createdAt: String
        let phase: String
        let sha256: String
        let bytes: Int
        let sourceSHA256: String?
        enum CodingKeys: String, CodingKey { case protocolVersion = "protocol", kind, host, familyID, rootIdentity, id, createdAt, phase, sha256, bytes, sourceSHA256 }
        var stem: String { "\(host)-\(id)" }
        var choice: NativeProjectRecoveryChoice { .init(id: id, host: host, familyID: familyID, createdAt: createdAt, sha256: sha256, bytes: bytes) }
    }
    struct Read {
        let data: Data
        let device: Int32, inode: UInt64, size: Int64, modified: timespec, changed: timespec
        init(data: Data, info: Darwin.stat) {
            self.data = data; device = info.st_dev; inode = info.st_ino; size = info.st_size
            modified = info.st_mtimespec; changed = info.st_ctimespec
        }
        func sameIdentity(as other: Read) -> Bool {
            device == other.device && inode == other.inode && size == other.size &&
            modified.tv_sec == other.modified.tv_sec && modified.tv_nsec == other.modified.tv_nsec &&
            changed.tv_sec == other.changed.tv_sec && changed.tv_nsec == other.changed.tv_nsec
        }
        func matches(_ info: Darwin.stat) -> Bool {
            device == info.st_dev && inode == info.st_ino && size == info.st_size &&
            modified.tv_sec == info.st_mtimespec.tv_sec && modified.tv_nsec == info.st_mtimespec.tv_nsec &&
            changed.tv_sec == info.st_ctimespec.tv_sec && changed.tv_nsec == info.st_ctimespec.tv_nsec
        }
    }
    static func error(_ message: String) -> ReelBackend.APIError { .init(message) }
    static func posix(_ operation: String? = nil, file: String? = nil, projectIO: Bool = false) -> NSError {
        let code = Int(errno)
        let nativeOperation = projectIO ? arya_project_io_error_operation().map { String(cString: $0) } : nil
        let underlying = NSError(domain: NSPOSIXErrorDomain, code: code)
        guard let operation else { return underlying }
        var context: [String: Any] = [NSUnderlyingErrorKey: underlying, "AryaProjectOperation": operation]
        var description = "Could not \(operation)"
        if let file { context["AryaProjectFile"] = file; description += " for \(file)" }
        if let nativeOperation {
            context["AryaNativeOperation"] = nativeOperation; description += " [\(nativeOperation)]"
        }
        context[NSLocalizedDescriptionKey] = description + ": " + underlying.localizedDescription
        return NSError(domain: NSPOSIXErrorDomain, code: code, userInfo: context)
    }
    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func token(_ data: Data?) -> String { data.map { "sha256:" + digest($0) } ?? "missing" }
    static func observedToken(_ read: Read?) -> String {
        guard let read else { return "missing" }
        let parts = [String(read.device), String(read.inode), String(read.size), String(read.modified.tv_sec), String(read.modified.tv_nsec),
                     String(read.changed.tv_sec), String(read.changed.tv_nsec), digest(read.data)]
        return digest(Data(parts.joined(separator: ":").utf8))
    }
    static func verifyBytes(_ fd: Int32, expected: Data) throws {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024), offset = 0
        while offset < expected.count {
            try Task.checkCancellation()
            let count = min(buffer.count, expected.count - offset)
            let next = buffer.withUnsafeMutableBytes { Darwin.pread(fd, $0.baseAddress, count, off_t(offset)) }
            if next < 0 { if errno == EINTR { continue }; throw posix() }
            guard next > 0 else { throw error("The original project changed while its metadata was captured.") }
            let equal = expected.withUnsafeBytes { original in
                buffer.withUnsafeBytes { chunk in memcmp(original.baseAddress!.advanced(by: offset), chunk.baseAddress!, next) == 0 }
            }
            guard equal else { throw error("The original project changed while its metadata was captured.") }
            offset += next
        }
    }
    final class MetadataSource {
        let fd: Int32, rootFD: Int32, identity: Read
        init(rootFD: Int32, stagedFD: Int32, expected: Data) throws {
            let fd = openat(rootFD, "reel.project.json", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard fd >= 0 else { throw NativeProjectRecovery.posix("open original project metadata", file: "reel.project.json") }
            var retained = false
            defer { if !retained { close(fd) } }
            var info = Darwin.stat()
            guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
                  info.st_size == Int64(expected.count) else { throw NativeProjectRecovery.error("The original project is not an exclusively named regular file.") }
            let identity = Read(data: Data(), info: info)
            try NativeProjectRecovery.verifyBytes(fd, expected: expected)
            guard arya_copy_project_metadata(fd, stagedFD) == 0 else { throw NativeProjectRecovery.posix("preserve project access metadata", file: "reel.project.json", projectIO: true) }
            var after = Darwin.stat(), named = Darwin.stat()
            guard fstat(fd, &after) == 0, fstatat(rootFD, "reel.project.json", &named, AT_SYMLINK_NOFOLLOW) == 0,
                  identity.matches(after), identity.matches(named) else { throw NativeProjectRecovery.error("The original project metadata changed before publication.") }
            self.fd = fd; self.rootFD = rootFD; self.identity = identity; retained = true
        }
        deinit { close(fd) }
        func verify(stagedFD: Int32) throws {
            try requireIdentity()
            guard arya_verify_project_metadata(fd, stagedFD) == 0 else { throw NativeProjectRecovery.posix("verify staged project access metadata", file: "reel.project.json", projectIO: true) }
            try requireIdentity()
        }
        func requireIdentity() throws {
            var held = Darwin.stat(), named = Darwin.stat()
            guard fstat(fd, &held) == 0, fstatat(rootFD, "reel.project.json", &named, AT_SYMLINK_NOFOLLOW) == 0,
                  identity.matches(held), identity.matches(named), named.st_nlink == 1 else {
                throw NativeProjectRecovery.error("The original project identity or metadata changed before publication.")
            }
        }
    }
    static func sync(_ fd: Int32, file: String? = nil) throws {
        while fsync(fd) != 0 { if errno != EINTR { throw posix("sync recovery storage", file: file) } }
    }
    static func read(_ directory: Int32, _ name: String, limit: Int = maximumBytes, missing: Bool = false, exclusive: Bool = false) throws -> Read? {
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 { if missing && errno == ENOENT { return nil }; throw posix("open recovery file", file: name) }
        defer { close(fd) }
        var before = Darwin.stat()
        guard fstat(fd, &before) == 0 else { throw posix() }
        guard before.st_mode & S_IFMT == S_IFREG, before.st_size >= 0, before.st_size <= Int64(limit),
              !exclusive || before.st_nlink == 1 else { throw error("Recovery requires regular files within its byte limit.") }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            try Task.checkCancellation()
            let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if count < 0 { if errno == EINTR { continue }; throw posix() }
            if count == 0 { break }
            guard bytes.count <= limit - count else { throw error("The recovery file grew beyond its byte limit.") }
            bytes.append(contentsOf: buffer[0..<count])
        }
        let result = Read(data: bytes, info: before)
        var after = Darwin.stat(), named = Darwin.stat()
        guard fstat(fd, &after) == 0, fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
              result.matches(after), result.matches(named), Int64(bytes.count) == before.st_size else { throw error("A recovery file changed while it was read.") }
        return result
    }
    static func put(_ data: Data, directory: Int32, name: String) throws -> Darwin.stat {
        let fd = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw posix("create private recovery file", file: name) }
        var info = Darwin.stat(); _ = fstat(fd, &info)
        var complete = false
        defer {
            close(fd)
            if !complete {
                var named = Darwin.stat()
                if fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0, named.st_dev == info.st_dev, named.st_ino == info.st_ino { _ = unlinkat(directory, name, 0) }
            }
        }
        guard arya_clear_project_acl(fd) == 0 else { throw posix("prepare private recovery file", file: name, projectIO: true) }
        try data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                try Task.checkCancellation()
                let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if count < 0 { if errno == EINTR { continue }; throw posix("write recovery file", file: name) }
                guard count > 0 else { throw error("Recovery could not finish writing its file.") }
                offset += count
            }
        }
        try sync(fd, file: name)
        var finished = Darwin.stat(); guard fstat(fd, &finished) == 0 else { throw posix("verify written recovery file", file: name) }
        complete = true; return finished
    }

    final class PublicationLock {
        let fd: Int32, directory: Int32, identity: Read
        init(directory: Int32) throws {
            self.directory = directory
            let name = "project-write.lock"
            var created = false
            var fd = openat(directory, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
            if fd >= 0 { created = true }
            else if errno == EEXIST { fd = openat(directory, name, O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC) }
            guard fd >= 0 else { throw NativeProjectRecovery.posix("open project publication lock", file: name) }
            var retained = false
            defer { if !retained { close(fd) } }
            if created, arya_clear_project_acl(fd) != 0 { throw NativeProjectRecovery.posix("prepare private publication lock", file: name, projectIO: true) }
            var info = Darwin.stat()
            guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size == 0, info.st_nlink == 1 else {
                throw NativeProjectRecovery.error("The project publication lock is not a regular, exclusively named file.")
            }
            guard arya_try_lock_project_publication(fd) == 0 else {
                if errno == EWOULDBLOCK || errno == EAGAIN { throw NativeProjectRecovery.error("Another Arya host is saving this project. Try again after it finishes.") }
                throw NativeProjectRecovery.posix("lock project publication", file: name, projectIO: true)
            }
            if created { try NativeProjectRecovery.sync(fd); try NativeProjectRecovery.sync(directory) }
            let identity = Read(data: Data(), info: info)
            var named = Darwin.stat()
            guard fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0, identity.matches(named), named.st_nlink == 1 else {
                throw NativeProjectRecovery.error("The project publication lock changed while it was opened.")
            }
            self.fd = fd; self.identity = identity
            retained = true
        }
        deinit { close(fd) }
        func requireIdentity() throws {
            var held = Darwin.stat(), named = Darwin.stat()
            guard fstat(fd, &held) == 0, fstatat(directory, "project-write.lock", &named, AT_SYMLINK_NOFOLLOW) == 0,
                  identity.matches(held), identity.matches(named), named.st_mode & S_IFMT == S_IFREG, named.st_nlink == 1 else {
                throw NativeProjectRecovery.error("The project publication lock changed. Reopen the project before saving.")
            }
        }
    }

    final class Store {
        let folder: ProjectFolder, rootFD: Int32, directoryFD: Int32, identity: RootIdentity, family: Family
        init(folder: ProjectFolder, create: Bool = true) throws {
            self.folder = folder
            let root = open(folder.root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard root >= 0 else { throw NativeProjectRecovery.posix("open project folder for recovery") }
            var keepRoot = false, keepDirectory = false
            defer { if !keepRoot { close(root) } }
            var info = Darwin.stat(); guard fstat(root, &info) == 0 else { throw NativeProjectRecovery.posix() }
            let identity = RootIdentity(info)
            func child(_ parent: Int32, _ name: String) throws -> Int32 {
                if create, mkdirat(parent, name, 0o700) != 0, errno != EEXIST { throw NativeProjectRecovery.posix("create recovery directory", file: name) }
                let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard fd >= 0 else { throw NativeProjectRecovery.posix("open recovery directory", file: name) }; return fd
            }
            let dot = try child(root, ".reel"); defer { close(dot) }
            let directory = try child(dot, "recovery")
            defer { if !keepDirectory { close(directory) } }
            let decoder = JSONDecoder(), name = "project-identity.json"
            var recorded = try NativeProjectRecovery.read(directory, name, limit: 4096, missing: true, exclusive: true)
            if recorded == nil {
                guard create else { throw NativeProjectRecovery.error("There is no recovery identity in this project folder.") }
                let candidate = Family(protocolVersion: 1, familyID: UUID().uuidString.lowercased(), rootIdentity: identity, createdAt: ISO8601DateFormatter().string(from: Date()))
                do { try NativeProjectRecovery.put(JSONEncoder().encode(candidate), directory: directory, name: name); try NativeProjectRecovery.sync(directory); try NativeProjectRecovery.sync(dot); try NativeProjectRecovery.sync(root) }
                catch { guard (error as NSError).domain == NSPOSIXErrorDomain, (error as NSError).code == Int(EEXIST) else { throw error } }
                recorded = try NativeProjectRecovery.read(directory, name, limit: 4096, exclusive: true)
            }
            guard let recorded else { throw NativeProjectRecovery.error("Recovery identity is unavailable.") }
            let family = try decoder.decode(Family.self, from: recorded.data)
            guard family.protocolVersion == 1, UUID(uuidString: family.familyID) != nil, family.rootIdentity == identity else { throw NativeProjectRecovery.error("Recovery belongs to another project folder. Its files were preserved.") }
            self.rootFD = root; self.directoryFD = directory; self.identity = identity; self.family = family
            keepRoot = true; keepDirectory = true
        }
        deinit { close(directoryFD); close(rootFD) }
        func requireIdentity() throws {
            let current = open(folder.root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard current >= 0 else { throw NativeProjectRecovery.posix() }; defer { close(current) }
            var info = Darwin.stat(); guard fstat(current, &info) == 0, RootIdentity(info) == identity else { throw NativeProjectRecovery.error("The project folder changed. Reopen it before recovery.") }
            let dot = openat(rootFD, ".reel", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard dot >= 0 else { throw NativeProjectRecovery.posix() }; defer { close(dot) }
            let named = openat(dot, "recovery", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard named >= 0 else { throw NativeProjectRecovery.posix() }; defer { close(named) }
            var held = Darwin.stat(), live = Darwin.stat()
            guard fstat(named, &live) == 0, fstat(directoryFD, &held) == 0, live.st_dev == held.st_dev, live.st_ino == held.st_ino else { throw NativeProjectRecovery.error("The recovery folder changed. Its files were preserved.") }
            guard let bytes = try NativeProjectRecovery.read(directoryFD, "project-identity.json", limit: 4096, exclusive: true) else { throw NativeProjectRecovery.error("The recovery identity changed.") }
            let recorded = try JSONDecoder().decode(Family.self, from: bytes.data)
            guard recorded.protocolVersion == family.protocolVersion, recorded.familyID == family.familyID,
                  recorded.rootIdentity == family.rootIdentity, recorded.createdAt == family.createdAt else { throw NativeProjectRecovery.error("The recovery identity changed.") }
        }
        func currentRead() throws -> Read? { try requireIdentity(); return try NativeProjectRecovery.read(rootFD, "reel.project.json", missing: true) }
        func current() throws -> Data? { try currentRead()?.data }
        func entries() throws -> [String] {
            try requireIdentity()
            let fd = openat(directoryFD, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { throw NativeProjectRecovery.posix() }
            guard let stream = fdopendir(fd) else { close(fd); throw NativeProjectRecovery.posix() }
            defer { closedir(stream) }
            var names: [String] = []
            while true {
                try Task.checkCancellation()
                errno = 0
                guard let entry = readdir(stream) else {
                    if errno != 0 { throw NativeProjectRecovery.posix() }
                    break
                }
                let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                    pointer.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
                }
                if name == "." || name == ".." { continue }
                guard names.count < 512 else { throw NativeProjectRecovery.error("Recovery has too many files to inspect safely. Its files were preserved.") }
                names.append(name)
            }
            try requireIdentity()
            return names
        }
        func pair(_ name: String) throws -> (Receipt, Read, Read) {
            guard name.hasSuffix(".receipt.json"), let receiptFile = try NativeProjectRecovery.read(directoryFD, name, limit: 4096, exclusive: true) else { throw NativeProjectRecovery.error("Recovery receipt is unavailable.") }
            let receipt = try JSONDecoder().decode(Receipt.self, from: receiptFile.data)
            guard receipt.protocolVersion == 1, receipt.kind == "arya-project-recovery", ["native", "browser"].contains(receipt.host),
                  UUID(uuidString: receipt.id) != nil, receipt.familyID == family.familyID, receipt.rootIdentity == identity,
                  name == receipt.stem + ".receipt.json", ["published", "preserved-original"].contains(receipt.phase),
                  receipt.bytes >= 0, receipt.bytes <= maximumBytes,
                  let project = try NativeProjectRecovery.read(directoryFD, receipt.stem + ".project.json", exclusive: true),
                  project.data.count == receipt.bytes, NativeProjectRecovery.digest(project.data) == receipt.sha256 else { throw NativeProjectRecovery.error("Recovery receipt or project bytes do not match.") }
            return (receipt, receiptFile, project)
        }
        func verified(_ validate: (String) throws -> Void) throws -> [Receipt] {
            var result: [Receipt] = []
            for name in try entries() where name.hasSuffix(".receipt.json") {
                guard let (receipt, _, project) = try? pair(name), receipt.phase == "published", let text = String(data: project.data, encoding: .utf8), (try? validate(text)) != nil else { continue }
                result.append(receipt)
            }
            return result.sorted { $0.createdAt == $1.createdAt ? $0.stem < $1.stem : $0.createdAt < $1.createdAt }
        }
        func reserve(_ bytes: Int64, incomingPublished: Bool, lock: PublicationLock, validate: (String) throws -> Void) throws {
            var total: Int64 = 0
            let names = try entries()
            var entryCount = names.count
            for name in names {
                var info = Darwin.stat(); guard fstatat(directoryFD, name, &info, AT_SYMLINK_NOFOLLOW) == 0, info.st_size >= 0 else { throw NativeProjectRecovery.posix() }
                guard info.st_mode & S_IFMT != S_IFDIR else { throw NativeProjectRecovery.error("Recovery contains an unknown folder. Its contents were preserved.") }
                guard total <= maximumRetainedBytes - Int64(info.st_size) else { throw NativeProjectRecovery.error("Recovery exceeds its 128 MiB budget. Its files were preserved.") }
                total += Int64(info.st_size)
            }
            var published = try verified(validate)
            while (entryCount + 2 > 512 || total + bytes > maximumRetainedBytes || (incomingPublished && published.count >= maximumPublished)), let oldest = published.first {
                let (receipt, receiptFile, projectFile) = try pair(oldest.stem + ".receipt.json")
                guard receipt.phase == "published" else { throw NativeProjectRecovery.error("A recovery entry changed before retention cleanup.") }
                try requireIdentity(); try lock.requireIdentity()
                var a = Darwin.stat(), b = Darwin.stat()
                guard fstatat(directoryFD, receipt.stem + ".receipt.json", &a, AT_SYMLINK_NOFOLLOW) == 0,
                      fstatat(directoryFD, receipt.stem + ".project.json", &b, AT_SYMLINK_NOFOLLOW) == 0,
                      receiptFile.matches(a), projectFile.matches(b), a.st_nlink == 1, b.st_nlink == 1 else { throw NativeProjectRecovery.error("A recovery entry changed before retention cleanup.") }
                guard unlinkat(directoryFD, receipt.stem + ".receipt.json", 0) == 0 else { throw NativeProjectRecovery.posix() }
                guard unlinkat(directoryFD, receipt.stem + ".project.json", 0) == 0 else { throw NativeProjectRecovery.posix() }
                try NativeProjectRecovery.sync(directoryFD); total -= Int64(receiptFile.data.count + projectFile.data.count); entryCount -= 2; published.removeFirst()
            }
            guard entryCount + 2 <= 512, total + bytes <= maximumRetainedBytes else { throw NativeProjectRecovery.error("Recovery has no space within its file or 128 MiB byte budget. Original and unknown files were preserved.") }
        }
        func withPublicationLock<T>(_ action: (PublicationLock) throws -> T) throws -> T {
            try requireIdentity()
            let lock = try PublicationLock(directory: directoryFD)
            try requireIdentity(); try lock.requireIdentity()
            return try withExtendedLifetime(lock) { try action(lock) }
        }
        func snapshot(_ data: Data, phase: String = "published", source: Data?, validate: (String) throws -> Void) throws {
            try withPublicationLock { lock in
                try snapshotLocked(data, phase: phase, source: source, lock: lock, validate: validate)
            }
        }
        private func snapshotLocked(_ data: Data, phase: String = "published", source: Data?, lock: PublicationLock, validate: (String) throws -> Void) throws {
            try requireIdentity(); try lock.requireIdentity()
            guard data.count <= maximumBytes else { throw NativeProjectRecovery.error("The project exceeds the recovery limit of 64 MiB.") }
            if phase == "published" {
                guard let text = String(data: data, encoding: .utf8) else { throw NativeProjectRecovery.error("The recovery project is not UTF-8.") }; try validate(text)
                if try verified(validate).contains(where: { $0.sha256 == NativeProjectRecovery.digest(data) }) { return }
            }
            let receipt = Receipt(protocolVersion: 1, kind: "arya-project-recovery", host: "native", familyID: family.familyID, rootIdentity: identity,
                                  id: UUID().uuidString.lowercased(), createdAt: ISO8601DateFormatter().string(from: Date()), phase: phase,
                                  sha256: NativeProjectRecovery.digest(data), bytes: data.count, sourceSHA256: source.map(NativeProjectRecovery.digest))
            let encoded = try JSONEncoder().encode(receipt)
            try reserve(Int64(data.count + encoded.count), incomingPublished: phase == "published", lock: lock, validate: validate)
            try lock.requireIdentity()
            try NativeProjectRecovery.put(data, directory: directoryFD, name: receipt.stem + ".project.json"); try NativeProjectRecovery.sync(directoryFD)
            try requireIdentity(); try lock.requireIdentity()
            try NativeProjectRecovery.put(encoded, directory: directoryFD, name: receipt.stem + ".receipt.json"); try NativeProjectRecovery.sync(directoryFD)
        }
        func selected(_ choice: NativeProjectRecoveryChoice, validate: (String) throws -> Void) throws -> Data {
            guard choice.familyID == family.familyID else { throw NativeProjectRecovery.error("The recovery choice belongs to another project.") }
            let (receipt, _, project) = try pair(choice.host + "-" + choice.id + ".receipt.json")
            guard receipt.phase == "published", receipt.sha256 == choice.sha256, receipt.bytes == choice.bytes,
                  let text = String(data: project.data, encoding: .utf8) else { throw NativeProjectRecovery.error("The selected recovery changed.") }
            try validate(text); return project.data
        }
        /// Caller holds the final coordinated write. Current bytes are compared twice before rename.
        func replace(_ data: Data, expected: Data?, expectedIdentity: Read? = nil, preserveOriginal: Bool, admission: () throws -> Void, validate: (String) throws -> Void, preparePublication: (Int32) throws -> () -> Void = { _ in {} }) throws -> [String] {
            try withPublicationLock { lock in
                try replaceLocked(data, expected: expected, expectedIdentity: expectedIdentity, preserveOriginal: preserveOriginal, lock: lock, admission: admission, validate: validate, preparePublication: preparePublication)
            }
        }
        private func replaceLocked(_ data: Data, expected: Data?, expectedIdentity: Read?, preserveOriginal: Bool, lock: PublicationLock, admission: () throws -> Void, validate: (String) throws -> Void, preparePublication: (Int32) throws -> () -> Void) throws -> [String] {
            guard data.count <= maximumBytes, let text = String(data: data, encoding: .utf8) else { throw NativeProjectRecovery.error("The new project must be UTF-8 within the recovery byte limit.") }
            try validate(text)
            try admission(); try Task.checkCancellation(); try requireIdentity()
            let observed = try currentRead()
            guard observed?.data == expected, expectedIdentity == nil || observed?.sameIdentity(as: expectedIdentity!) == true else {
                throw NativeProjectRecovery.error("The project bytes or file identity changed after recovery or save was prepared. Refresh and try again.")
            }
            if let expected { try snapshotLocked(expected, phase: preserveOriginal ? "preserved-original" : "published", source: expected, lock: lock, validate: validate) }
            let temporary = ".reel-project-" + UUID().uuidString.lowercased() + ".tmp"
            let temporaryInfo = try NativeProjectRecovery.put(data, directory: rootFD, name: temporary)
            var owned = Read(data: Data(), info: temporaryInfo)
            defer {
                var named = Darwin.stat()
                if fstatat(rootFD, temporary, &named, AT_SYMLINK_NOFOLLOW) == 0, named.st_dev == temporaryInfo.st_dev, named.st_ino == temporaryInfo.st_ino { _ = unlinkat(rootFD, temporary, 0) }
            }
            let stagedFD = openat(rootFD, temporary, O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard stagedFD >= 0 else { throw NativeProjectRecovery.posix() }
            defer { close(stagedFD) }
            var stagedInfo = Darwin.stat()
            guard fstat(stagedFD, &stagedInfo) == 0, owned.matches(stagedInfo), stagedInfo.st_nlink == 1 else { throw NativeProjectRecovery.error("The staged project changed before metadata preservation.") }
            let metadata = try expected.map { try MetadataSource(rootFD: rootFD, stagedFD: stagedFD, expected: $0) }
            guard fstat(stagedFD, &stagedInfo) == 0, stagedInfo.st_mode & S_IFMT == S_IFREG, stagedInfo.st_nlink == 1, stagedInfo.st_size == Int64(data.count) else { throw NativeProjectRecovery.error("The staged project changed during metadata preservation.") }
            owned = Read(data: Data(), info: stagedInfo)
            try NativeProjectRecovery.verifyBytes(stagedFD, expected: data)
            try metadata?.verify(stagedFD: stagedFD)
            try NativeProjectRecovery.sync(stagedFD)
            guard fstat(stagedFD, &stagedInfo) == 0, owned.matches(stagedInfo), stagedInfo.st_nlink == 1 else { throw NativeProjectRecovery.error("The staged project changed during verification.") }
            let published = try preparePublication(stagedFD)
            return try withExtendedLifetime(metadata) {
                try admission(); try Task.checkCancellation(); try requireIdentity()
                let final = try currentRead()
                guard final?.data == expected, expectedIdentity == nil || final?.sameIdentity(as: expectedIdentity!) == true else {
                    throw NativeProjectRecovery.error("The project bytes or file identity changed before publication. Its original bytes were preserved.")
                }
                try metadata?.requireIdentity()
                var named = Darwin.stat(), held = Darwin.stat()
                guard fstat(stagedFD, &held) == 0, owned.matches(held), fstatat(rootFD, temporary, &named, AT_SYMLINK_NOFOLLOW) == 0, owned.matches(named), named.st_nlink == 1 else { throw NativeProjectRecovery.error("The staged project changed before publication.") }
                try lock.requireIdentity()
                guard renameat(rootFD, temporary, rootFD, "reel.project.json") == 0 else { throw NativeProjectRecovery.posix("publish staged project", file: "reel.project.json") }
                published()
                // Publication already happened. Later sync/snapshot failure must not leave memory stale.
                var warnings: [String] = []
                do { try NativeProjectRecovery.sync(rootFD) } catch { warnings.append("The project was saved, but folder sync failed: \(error.localizedDescription)") }
                do { try snapshotLocked(data, source: expected, lock: lock, validate: validate) } catch { warnings.append("The project was saved, but its new recovery snapshot failed: \(error.localizedDescription)") }
                return warnings
            }
        }
    }
}
