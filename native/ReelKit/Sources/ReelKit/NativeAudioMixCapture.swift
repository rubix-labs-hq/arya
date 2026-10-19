import CoreFoundation
import CryptoKit
import Darwin
import Foundation

struct NativeAudioMixCapture: Sendable {
    struct Source: Equatable, Sendable {
        let alias: String
        let path: String
        let stamp: Stamp
    }
    struct Stamp: Equatable, Sendable {
        let device: UInt64, inode: UInt64, bytes: Int64
        let modifiedSeconds: Int64, modifiedNanoseconds: Int64
        let changedSeconds: Int64, changedNanoseconds: Int64
        init(_ stat: Darwin.stat) {
            device = UInt64(UInt32(bitPattern: stat.st_dev)); inode = UInt64(stat.st_ino); bytes = stat.st_size
            modifiedSeconds = Int64(stat.st_mtimespec.tv_sec); modifiedNanoseconds = Int64(stat.st_mtimespec.tv_nsec)
            changedSeconds = Int64(stat.st_ctimespec.tv_sec); changedNanoseconds = Int64(stat.st_ctimespec.tv_nsec)
        }
    }
    struct Snapshot: Sendable {
        struct File: Sendable { let original: Source; let copy: String; let copyStamp: Stamp; let sha256: String }
        let directory: String
        let owned: SnapshotDirectory
        var folder: ProjectFolder { owned.folder }
        let files: [File]
        let planText: String
        let diskBytes: UInt64
        func cleanup() { owned.cleanup() }
    }
    typealias SnapshotDirectory = NativeAudioMixStorage.Directory
    enum Output: Sendable { case master, track(String) }
    enum Semantics: String, Sendable { case playback, export }
    let projectText: String
    let projectFileText: String
    let version: Int
    let root: String
    let storage: NativeAudioMixStorage
    let composition: String?
    let output: Output
    let semantics: Semantics
    let requestID: String
    let from: Double, to: Double
    let planText: String
    let cropStart: Int, cropCount: Int
    let sampleStart: Int
    let sources: [Source]
    let maximumDiskBytes: UInt64
    let requestText: String
    let reservedMemoryBytes: UInt64
    var reservedDiskBytes: UInt64 { sources.reduce(0) { $0 + UInt64($1.stamp.bytes) } }

    static func captureStringBytes(project: String, projectFile: String, request: String) -> UInt64 {
        UInt64(project.utf8.count + projectFile.utf8.count + request.utf8.count) * 2
    }

    static func projectFileMatches(_ file: URL, expected: String) throws -> Bool {
        guard expected.utf8.count <= 32 * 1024 * 1024 else { throw ReelBackend.APIError("The project capture exceeds its supported size.") }
        let bytes = Data(expected.utf8)
        var result: Result<Bool, Error>?, coordinationError: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: file, options: [], error: &coordinationError) { url in
            result = Result {
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                guard try handle.seekToEnd() == UInt64(bytes.count) else { return false }
                try handle.seek(toOffset: 0)
                var offset = 0
                while offset < bytes.count {
                    try Task.checkCancellation()
                    let count = min(65_536, bytes.count - offset)
                    guard let chunk = try handle.read(upToCount: count), chunk.count > 0,
                          chunk == bytes.subdata(in: offset..<offset + chunk.count) else { return false }
                    offset += chunk.count
                }
                return (try handle.read(upToCount: 1) ?? Data()).isEmpty
            }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw ReelBackend.APIError("The project file could not be coordinated for reading.") }
        return try result.get()
    }
    static func strictVersion(_ value: Any?) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              !["f", "d"].contains(String(cString: number.objCType)),
              let result = Int(number.stringValue), result >= 0 else { throw ReelBackend.APIError("expectedVersion must be an integer project version.") }
        return result
    }
    static func finite(_ value: Any?, _ name: String, range: ClosedRange<Double>) throws -> Double {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite, range.contains(number.doubleValue) else { throw ReelBackend.APIError("Give a valid \(name).") }
        return number.doubleValue
    }
    static func composition(_ body: [String: Any]) throws -> String? {
        guard body.keys.contains("comp") else { throw ReelBackend.APIError("Specify comp, using null for the main timeline.") }
        if body["comp"] is NSNull { return nil }
        guard let comp = body["comp"] as? String, !comp.isEmpty, comp.utf8.count <= 1024 else { throw ReelBackend.APIError("Choose a valid composition ID or null.") }
        return comp
    }
    static func boolean(_ value: Any?, _ name: String) throws -> Bool? {
        guard let value else { return nil }
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw ReelBackend.APIError("\(name) must be a boolean.") }
        return number.boolValue
    }
    static func sources(plan: String, folder: ProjectFolder, diskLimit: UInt64) throws -> [Source] {
        let fields = try JSON.parse(plan) as? [String: Any] ?? [:]
        var aliases = Set<String>()
        func walk(_ buses: [[String: Any]], depth: Int) throws {
            guard buses.isEmpty || depth <= 16 else { throw ReelBackend.APIError("The audio mix exceeds the supported composition depth.") }
            for bus in buses { for item in bus["items"] as? [[String: Any]] ?? [] {
                if let src = item["src"] as? String { aliases.insert(src) }
                try walk(item["buses"] as? [[String: Any]] ?? [], depth: depth + 1)
            } }
        }
        try walk(fields["buses"] as? [[String: Any]] ?? [], depth: 0)
        guard aliases.count <= 256 else { throw ReelBackend.APIError("Choose a mix with at most 256 source aliases.") }
        var total: UInt64 = 0
        return try aliases.sorted().map { alias in
            guard alias.utf8.count <= 4096 else { throw ReelBackend.APIError("An audio source path is too long.") }
            let path = try folder.resolve(alias).path, stamp = try fileStamp(path)
            guard URL(fileURLWithPath: path).pathExtension.utf8.count <= 64 else { throw ReelBackend.APIError("Use source file extensions no longer than 64 bytes.") }
            let add = total.addingReportingOverflow(UInt64(stamp.bytes))
            guard !add.overflow, add.partialValue <= diskLimit else { throw ReelBackend.APIError("The mix source copies exceed the temporary disk budget. Choose fewer or smaller source files.") }
            total = add.partialValue
            return .init(alias: alias, path: path, stamp: stamp)
        }
    }
    static func fileStamp(_ path: String) throws -> Stamp {
        var value = Darwin.stat()
        guard path.withCString({ Darwin.lstat($0, &value) }) == 0, value.st_mode & S_IFMT == S_IFREG, value.st_size >= 0 else { throw ReelBackend.APIError("An audio source is missing or is not a regular file.") }
        return Stamp(value)
    }
    private static func physicalPath(_ path: String) throws -> String {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        let resolved = buffer.withUnsafeMutableBufferPointer { output in
            path.withCString { Darwin.realpath($0, output.baseAddress!) != nil }
        }
        guard resolved else { throw ReelBackend.APIError("The captured audio path could not be resolved.") }
        return String(cString: buffer)
    }
    func validatePaths(folder: ProjectFolder) throws {
        guard folder.root.path == root else { throw ReelBackend.APIError("The project folder changed during mix measurement.") }
        for source in sources {
            try Task.checkCancellation()
            guard try folder.resolve(source.alias).path == source.path, try Self.fileStamp(source.path) == source.stamp else { throw ReelBackend.APIError("An audio source or alias changed after the mix was captured.") }
        }
    }
    private static func analyzerBytes(plan: String, croppedFrames: Int, folder: ProjectFolder? = nil) throws -> UInt64 {
        guard croppedFrames > 0, croppedFrames <= 172_800_000 else { throw ReelBackend.APIError("Choose a non-empty measurement range under one hour.") }
        // PCM crop, K-weighted energy and prefix arrays, gating arrays, hash buffers and plan JSON.
        // Copies now use a private destination, independent of project path length.
        // F_GETPATH is bounded by MAXPATHLEN; JSON escaping can grow each byte sixfold.
        let maxCopyPathBytes = Int(MAXPATHLEN) * 6 + 512
        let graph = try JSON.parse(plan) as? [String: Any] ?? [:]
        var pathGrowth = 0
        func walk(_ buses: [[String: Any]], depth: Int) throws {
            guard buses.isEmpty || depth <= 16 else { throw ReelBackend.APIError("The capture graph exceeds the supported depth.") }
            for bus in buses { for item in bus["items"] as? [[String: Any]] ?? [] {
                if let src = item["src"] as? String { pathGrowth += max(0, maxCopyPathBytes - JSON(any: src).text.utf8.count) }
                try walk(item["buses"] as? [[String: Any]] ?? [], depth: depth + 1)
            } }
        }
        try walk(graph["buses"] as? [[String: Any]] ?? [], depth: 0)
        let planBytes = Double(plan.utf8.count + pathGrowth) * 4
        let analysis = (Double(croppedFrames + 72_000) * 40 + planBytes + 1_310_720) * 1.25
        guard analysis.isFinite, analysis <= Double(UInt64.max) else { throw ReelBackend.APIError("The measurement allocation is too large.") }
        return UInt64(ceil(analysis))
    }
    static func validateMemory(plan: String, croppedFrames: Int, limit: UInt64 = NativeAudioMixer.memoryLimitBytes, folder: ProjectFolder? = nil) throws {
        try NativeAudioMixer.validate(plan: .raw(plan), limit: limit, additionalBytes: analyzerBytes(plan: plan, croppedFrames: croppedFrames, folder: folder))
    }
    static func reservationBytes(plan: String, croppedFrames: Int, folder: ProjectFolder? = nil) throws -> UInt64 {
        let analysis = try analyzerBytes(plan: plan, croppedFrames: croppedFrames, folder: folder)
        let total = try NativeAudioMixer.estimatedMemoryBytes(plan: .raw(plan), additionalBytes: analysis)
        guard total <= NativeAudioMixer.memoryLimitBytes else { throw ReelBackend.APIError("The mix reservation exceeds the shared audio analysis budget. Choose a shorter range.") }
        return total
    }

    func prepareSnapshotDirectory(folder: ProjectFolder, id: String) throws -> SnapshotDirectory {
        try validatePaths(folder: folder)
        let names = sources.enumerated().map { "source-\($0.offset).\(URL(fileURLWithPath: $0.element.path).pathExtension)" }
        return try storage.makeDirectory(id: id, filenames: names)
    }
    func makeSnapshot(folder: ProjectFolder, directory owned: SnapshotDirectory) throws -> Snapshot {
        try validatePaths(folder: folder)
        try owned.validate()
        let directory = owned.folder.root
        var complete = false
        defer { if !complete { owned.cleanup() } }
        var files: [Snapshot.File] = [], total: UInt64 = 0
        for (index, source) in sources.enumerated() {
            try Task.checkCancellation(); try validatePaths(folder: folder)
            let name = "source-\(index).\(URL(fileURLWithPath: source.path).pathExtension)"
            let copy = try owned.folder.output(directory.appendingPathComponent(name).path)
            let digest = try { () throws -> String in
                let output = try owned.createFile(name)
                defer { Darwin.close(output) }
                return try Self.stream(source: source, folder: folder, outputDescriptor: output, maximumBytes: min(UInt64(source.stamp.bytes), maximumDiskBytes - total))
            }()
            try owned.validate()
            total += UInt64(source.stamp.bytes)
            let copied = Source(alias: copy.path, path: copy.path, stamp: try Self.fileStamp(copy.path))
            guard try Self.stream(source: copied, folder: owned.folder, maximumBytes: maximumDiskBytes) == digest else { throw ReelBackend.APIError("The private audio copy did not match its source bytes.") }
            files.append(.init(original: source, copy: copy.path, copyStamp: copied.stamp, sha256: digest))
        }
        try validatePaths(folder: folder)
        let map = Dictionary(uniqueKeysWithValues: files.map { ($0.original.alias, $0.copy) })
        var graph = try JSON.parse(planText) as? [String: Any] ?? [:]
        func replace(_ buses: [[String: Any]]) -> [[String: Any]] {
            buses.map { bus in
                var bus = bus
                bus["items"] = (bus["items"] as? [[String: Any]] ?? []).map { item in
                    var item = item
                    if let src = item["src"] as? String { item["src"] = map[src] }
                    if let nested = item["buses"] as? [[String: Any]] { item["buses"] = replace(nested) }
                    return item
                }
                return bus
            }
        }
        graph["buses"] = replace(graph["buses"] as? [[String: Any]] ?? [])
        try owned.validate()
        complete = true
        return .init(directory: directory.path, owned: owned, files: files, planText: JSON(any: graph).text, diskBytes: total)
    }
    func verify(_ snapshot: Snapshot, folder: ProjectFolder) throws {
        try snapshot.owned.validate()
        try validatePaths(folder: folder)
        for file in snapshot.files {
            try Task.checkCancellation()
            guard try Self.stream(source: file.original, folder: folder, maximumBytes: maximumDiskBytes) == file.sha256 else { throw ReelBackend.APIError("An audio source changed after the private copy was captured.") }
            let copy = Source(alias: file.copy, path: file.copy, stamp: file.copyStamp)
            guard try Self.stream(source: copy, folder: snapshot.folder, maximumBytes: maximumDiskBytes) == file.sha256 else { throw ReelBackend.APIError("The private audio snapshot changed during measurement.") }
        }
        try validatePaths(folder: folder)
        try snapshot.owned.validate()
    }
    static func stream(source: Source, folder: ProjectFolder, copyTo: URL? = nil, outputDescriptor: Int32? = nil, maximumBytes: UInt64, afterDescriptorValidation: (@Sendable () throws -> Void)? = nil) throws -> String {
        try Task.checkCancellation()
        guard try folder.resolve(source.alias).path == source.path, try fileStamp(source.path) == source.stamp else { throw ReelBackend.APIError("An audio source changed before its bytes were read.") }
        let input = source.path.withCString { Darwin.open($0, O_RDONLY | O_NOFOLLOW) }
        guard input >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { Darwin.close(input) }
        var stat = Darwin.stat()
        guard Darwin.fstat(input, &stat) == 0, Stamp(stat) == source.stamp else { throw ReelBackend.APIError("The opened source changed identity.") }
        var pathBuffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard pathBuffer.withUnsafeMutableBufferPointer({ Darwin.fcntl(input, F_GETPATH, $0.baseAddress!) }) == 0 else { throw ReelBackend.APIError("The opened audio source path could not be read.") }
        let openedPath = try physicalPath(String(cString: pathBuffer))
        let capturedPath = try physicalPath(source.path), rootPath = try physicalPath(folder.root.path)
        guard openedPath == capturedPath, openedPath.hasPrefix(rootPath.hasSuffix("/") ? rootPath : rootPath + "/") else { throw ReelBackend.APIError("The opened audio source is outside its captured project path.") }
        var output: Int32 = outputDescriptor ?? -1
        if let copyTo {
            guard outputDescriptor == nil else { throw ReelBackend.APIError("Choose one owned copy destination.") }
            let checked = try folder.output(copyTo.path)
            output = checked.path.withCString { Darwin.open($0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600) }
            guard output >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        }
        defer { if copyTo != nil, output >= 0 { Darwin.close(output) } }
        try afterDescriptorValidation?()
        var buffer = [UInt8](repeating: 0, count: 65_536), hash = SHA256(), total: UInt64 = 0
        while true {
            try Task.checkCancellation()
            let count = buffer.withUnsafeMutableBytes { Darwin.read(input, $0.baseAddress!, $0.count) }
            if count == 0 { break }
            if count < 0 { if errno == EINTR { continue }; throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            let added = total.addingReportingOverflow(UInt64(count))
            guard !added.overflow, added.partialValue <= maximumBytes else { throw ReelBackend.APIError("The source read exceeds the temporary disk budget.") }
            total = added.partialValue
            hash.update(data: Data(buffer.prefix(count)))
            if output >= 0 {
                var position = 0
                while position < count {
                    try Task.checkCancellation()
                    let written = buffer.withUnsafeBytes { Darwin.write(output, $0.baseAddress!.advanced(by: position), count - position) }
                    if written < 0, errno == EINTR { continue }
                    guard written > 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
                    position += written
                }
            }
        }
        guard Darwin.fstat(input, &stat) == 0, Stamp(stat) == source.stamp, total == UInt64(source.stamp.bytes),
              try folder.resolve(source.alias).path == source.path, try fileStamp(source.path) == source.stamp else { throw ReelBackend.APIError("An audio source changed while its bytes were read.") }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
