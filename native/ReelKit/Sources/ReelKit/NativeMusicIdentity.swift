import CryptoKit
import Darwin
import Foundation

/// Byte identity for Arya's own score WAVs, never an arbitrary media-file hash service.
/// Reads at most 17.3 MB with 64 KiB working memory. Descriptor/path stamps detect
/// replacement and concurrent mutation; this is not namespace atomicity against a
/// separate process with the same user's privileges.
public enum NativeMusicIdentity {
    public static let maximumBytes: Int64 = 44 + 2_880_000 * 6

    fileprivate struct Stamp: Equatable, Sendable {
        let device: Int64, inode: UInt64, owner: UInt32, mode: UInt16, links: UInt16, bytes: Int64
        let modifiedSeconds: Int, modifiedNanos: Int, changedSeconds: Int, changedNanos: Int
        init(_ value: Darwin.stat) {
            device = Int64(value.st_dev); inode = UInt64(value.st_ino); owner = value.st_uid
            mode = value.st_mode; links = value.st_nlink; bytes = value.st_size
            modifiedSeconds = value.st_mtimespec.tv_sec; modifiedNanos = value.st_mtimespec.tv_nsec
            changedSeconds = value.st_ctimespec.tv_sec; changedNanos = value.st_ctimespec.tv_nsec
        }
    }
    public struct Snapshot: Sendable {
        public let contentSHA256: String?
        public let contentBytes: Int64
        fileprivate let folder: ProjectFolder
        fileprivate let path: String
        fileprivate let stamp: Stamp
        fileprivate init(contentSHA256: String?, folder: ProjectFolder, path: String, stamp: Stamp) {
            self.contentSHA256 = contentSHA256; self.contentBytes = stamp.bytes
            self.folder = folder; self.path = path; self.stamp = stamp
        }
        public var json: String { JSON(any: ["contentSHA256": contentSHA256 as Any? ?? NSNull(), "contentBytes": contentBytes]).text }
        /// Re-check immediately before a caller publishes metadata or timeline operations.
        public func validate() throws {
            try Task.checkCancellation()
            let descriptor = try NativeMusicIdentity.openOwned(folder: folder, path: path)
            defer { Darwin.close(descriptor) }
            guard try NativeMusicIdentity.checkedStamp(descriptor, folder: folder, path: path) == stamp else {
                throw NativeMusicComposer.Failure(message: "The generated music file changed during verification")
            }
        }
    }
    public static func read(folder: ProjectFolder, path: String, allowOversized: Bool = false) async throws -> Snapshot {
        try Task.checkCancellation()
        let worker = Task.detached(priority: .userInitiated) { try readSync(folder: folder, path: path, allowOversized: allowOversized) }
        return try await withTaskCancellationHandler(operation: { try await worker.value }, onCancel: { worker.cancel() })
    }
    static func readSync(folder: ProjectFolder, path: String, allowOversized: Bool = false,
                         afterDescriptorValidation: (@Sendable () throws -> Void)? = nil) throws -> Snapshot {
        try Task.checkCancellation()
        let descriptor = try openOwned(folder: folder, path: path)
        defer { Darwin.close(descriptor) }
        let captured = try checkedStamp(descriptor, folder: folder, path: path)
        try afterDescriptorValidation?()
        let oversized = captured.bytes > maximumBytes
        guard !oversized || allowOversized else { throw NativeMusicComposer.Failure(message: "Generated music exceeds its supported byte limit") }
        var digest: String?
        if !oversized {
            var buffer = [UInt8](repeating: 0, count: 65_536), total: Int64 = 0, hash = SHA256()
            while total < captured.bytes {
                try Task.checkCancellation()
                let requested = Int(min(Int64(buffer.count), captured.bytes - total))
                let count = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress!, requested) }
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw NativeMusicComposer.Failure(message: "The generated music file ended during verification") }
                hash.update(data: Data(buffer.prefix(count))); total += Int64(count)
            }
            var count: Int
            repeat { count = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress!, 1) } } while count < 0 && errno == EINTR
            guard count == 0 else { throw NativeMusicComposer.Failure(message: "The generated music file grew during verification") }
            digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
        }
        try Task.checkCancellation()
        guard try checkedStamp(descriptor, folder: folder, path: path) == captured else {
            throw NativeMusicComposer.Failure(message: "The generated music file changed during verification")
        }
        return Snapshot(contentSHA256: digest, folder: folder, path: path, stamp: captured)
    }
    private static func openOwned(folder: ProjectFolder, path: String) throws -> Int32 {
        guard path.range(of: #"^media/generated/music/[0-9a-f-]{36}/score\.wav$"#, options: .regularExpression) != nil else {
            throw NativeMusicComposer.Failure(message: "Music identity requires an owned generated WAV path")
        }
        let url = try folder.output(path)
        let descriptor = url.path.withCString { Darwin.open($0, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC) }
        guard descriptor >= 0 else { throw NativeMusicComposer.Failure(message: "The generated music file could not be opened safely") }
        return descriptor
    }
    private static func owned(_ value: Darwin.stat) throws -> Stamp {
        guard value.st_mode & S_IFMT == S_IFREG, value.st_nlink == 1, value.st_uid == Darwin.geteuid(),
              value.st_mode & 0o022 == 0, value.st_size >= 44 else {
            throw NativeMusicComposer.Failure(message: "Music identity requires an owned regular file without links or shared write access")
        }
        return Stamp(value)
    }
    private static func checkedStamp(_ descriptor: Int32, folder: ProjectFolder, path: String) throws -> Stamp {
        let url = try folder.output(path)
        var value = Darwin.stat(), entry = Darwin.stat()
        guard Darwin.fstat(descriptor, &value) == 0, url.path.withCString({ Darwin.lstat($0, &entry) }) == 0 else {
            throw NativeMusicComposer.Failure(message: "The generated music file changed during verification")
        }
        let stamp = try owned(value)
        guard stamp == (try owned(entry)) else { throw NativeMusicComposer.Failure(message: "The generated music file changed during verification") }
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard buffer.withUnsafeMutableBufferPointer({ Darwin.fcntl(descriptor, F_GETPATH, $0.baseAddress!) }) == 0 else {
            throw NativeMusicComposer.Failure(message: "The generated music file path could not be read")
        }
        let opened = try physicalPath(String(cString: buffer)), expected = try physicalPath(url.path), root = try physicalPath(folder.root.path)
        guard opened == expected, opened.hasPrefix(root.hasSuffix("/") ? root : root + "/") else {
            throw NativeMusicComposer.Failure(message: "The generated music file is outside its owned project path")
        }
        return stamp
    }
    private static func physicalPath(_ path: String) throws -> String {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        let resolved = buffer.withUnsafeMutableBufferPointer { output in path.withCString { Darwin.realpath($0, output.baseAddress!) != nil } }
        guard resolved else { throw NativeMusicComposer.Failure(message: "The generated music path could not be resolved") }
        return String(cString: buffer)
    }
}
