import CryptoKit
import Darwin
import Foundation

/// Component LUT copies use held project and directory descriptors. Existing files are never replaced.
enum NativeLibraryResources {
    static let fileLimit = 2 * 1024 * 1024

    final class File {
        let path: String
        private let root: NativeMediaImportSource.Root
        private let directory: Int32, descriptor: Int32
        private let directoryIdentity: NativeMediaImportSource.DirectoryStamp
        private let name: String, data: Data, identity: NativeMediaImportSource.Stamp

        fileprivate static func admit(root: NativeMediaImportSource.Root, hash: String, data: Data) throws -> File {
            guard hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  !data.isEmpty, data.count <= NativeLibraryResources.fileLimit,
                  NativeLibraryResources.digest(data) == hash else { throw ReelBackend.APIError("The packaged LUT digest or byte limit is invalid.") }
            let name = "Component-\(hash).cube"
            let directory = try root.directory("luts", create: true)
            var descriptor: Int32 = -1, created = false, complete = false
            defer {
                if !complete {
                    if created, descriptor >= 0 {
                        var held = Darwin.stat(), named = Darwin.stat()
                        if fstat(descriptor, &held) == 0, fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
                           held.st_dev == named.st_dev, held.st_ino == named.st_ino, named.st_nlink == 1 { _ = unlinkat(directory, name, 0) }
                    }
                    if descriptor >= 0 { close(descriptor) }
                    close(directory)
                }
            }
            descriptor = openat(directory, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
            if descriptor >= 0 {
                created = true
                try FileHandle(fileDescriptor: descriptor, closeOnDealloc: false).write(contentsOf: data)
                guard fsync(descriptor) == 0, fsync(directory) == 0 else { throw NativeLibraryResources.posix() }
            } else {
                guard errno == EEXIST else { throw NativeLibraryResources.posix() }
                descriptor = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
                guard descriptor >= 0 else { throw ReelBackend.APIError("The component LUT destination is not an accessible regular file.") }
            }
            let directoryIdentity = try NativeMediaImportSource.DirectoryStamp(directory)
            var info = Darwin.stat()
            guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
                  info.st_size == data.count else { throw ReelBackend.APIError("The component LUT destination conflicts with the package.") }
            let identity = try NativeMediaImportSource.Stamp(info)
            let file = File(root: root, directory: directory, descriptor: descriptor, name: name, data: data,
                            directoryIdentity: directoryIdentity, identity: identity)
            complete = true
            try file.validate()
            return file
        }

        private init(root: NativeMediaImportSource.Root, directory: Int32, descriptor: Int32, name: String, data: Data,
                     directoryIdentity: NativeMediaImportSource.DirectoryStamp, identity: NativeMediaImportSource.Stamp) {
            self.root = root; self.directory = directory; self.descriptor = descriptor; self.name = name; self.data = data
            self.directoryIdentity = directoryIdentity; self.identity = identity; path = "luts/\(name)"
        }

        deinit { close(descriptor); close(directory) }

        func validate() throws {
            try Task.checkCancellation(); try root.validate()
            let currentDirectory = try root.directory("luts", create: false)
            defer { close(currentDirectory) }
            guard try NativeMediaImportSource.DirectoryStamp(currentDirectory) == directoryIdentity,
                  try NativeMediaImportSource.DirectoryStamp(directory) == directoryIdentity else { throw ReelBackend.APIError("The LUT directory changed during component import.") }
            var held = Darwin.stat(), named = Darwin.stat()
            guard fstat(descriptor, &held) == 0, fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
                  try NativeMediaImportSource.Stamp(held) == identity, try NativeMediaImportSource.Stamp(named) == identity,
                  named.st_nlink == 1 else { throw ReelBackend.APIError("The component LUT changed before import committed.") }
            guard lseek(descriptor, 0, SEEK_SET) == 0 else { throw NativeLibraryResources.posix() }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: false)
            var bytes = Data()
            while let chunk = try handle.read(upToCount: min(64 * 1024, NativeLibraryResources.fileLimit - bytes.count + 1)), !chunk.isEmpty {
                bytes.append(chunk)
                guard bytes.count <= NativeLibraryResources.fileLimit else { throw ReelBackend.APIError("The component LUT destination exceeds its byte limit.") }
            }
            guard bytes == data, fstat(descriptor, &held) == 0, try NativeMediaImportSource.Stamp(held) == identity else {
                throw ReelBackend.APIError("The component LUT destination conflicts with the package.")
            }
        }
    }

    static func admit(root: NativeMediaImportSource.Root, hash: String, data: Data) throws -> File {
        try File.admit(root: root, hash: hash, data: data)
    }

    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func posix() -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
}
