import CoreFoundation
import CryptoKit
import Darwin
import Foundation

/// Recovery returns unsaved text only after rechecking its captured identity.
/// Saved transcripts and source files are never changed by this store.
public enum NativeTranscriptDraftStore {
    private static let recordLimit = 16 * 1024 * 1024
    private static let storeLimit = 256 * 1024 * 1024
    private struct Record { let fields: [String: Any]; let file: URL; let read: NativeProjectRecovery.Read }
    private struct Scan { let records: [Record]; let warnings: [String]; let bytes: Int; let files: Int }
    private static func failure(_ message: String) -> ReelBackend.APIError { .init(message) }
    private static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func identifier(_ value: Any?) -> String? { guard let text = value as? String, UUID(uuidString: text) != nil else { return nil }; return text.lowercased() }
    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue.rounded(.towardZero) == number.doubleValue, number.doubleValue >= 0, number.doubleValue <= 1_000_000_000 else { return nil }
        return number.intValue
    }
    private static func number(_ value: Any?) -> Double? { guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }; return value.doubleValue }
    private static func stat(_ url: URL, noFollow: Bool = false) throws -> Darwin.stat {
        var value = Darwin.stat()
        guard url.path.withCString({ Darwin.fstatat(AT_FDCWD, $0, &value, noFollow ? AT_SYMLINK_NOFOLLOW : 0) }) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        return value
    }
    private static func identity(_ value: Darwin.stat) -> String { "\(value.st_dev)|\(value.st_ino)" }
    private static func directory(_ folder: ProjectFolder) throws -> URL { try folder.output(".reel/transcript-drafts") }
    private static func owner(_ body: [String: Any]) throws -> (String, String) {
        guard let src = body["src"] as? String, !src.isEmpty, src.utf16.count <= 4096, !src.contains("\0") else { throw failure("Choose a transcript source.") }
        return (src, try NativeTranscriptStore.localeID(body["locale"] as? String ?? "en-US"))
    }
    static func exactWords(_ value: Any?) throws -> [[String: Any]] {
        guard let words = value as? [[String: Any]], words.count <= 100_000 else { throw failure("A recovery copy supports at most 100000 words.") }
        var previous = 0.0
        return try words.map { word in
            guard let t = number(word["t"]), let end = number(word["end"]), t >= previous, end > t,
                  let text = word["text"] as? String, text.utf16.count <= 1000 else { throw failure("Recovery words need ordered finite timestamps and text of at most 1000 characters.") }
            previous = t
            return ["t": t, "end": end, "text": text]
        }
    }
    static func timingDigest(_ words: [[String: Any]]) -> String {
        var bytes = Data(); bytes.reserveCapacity(words.count * 16)
        for word in words { for key in ["t", "end"] {
            let value = (word[key] as! NSNumber).doubleValue
            var bits = (value == 0 ? 0.0 : value).bitPattern.littleEndian
            withUnsafeBytes(of: &bits) { bytes.append(contentsOf: $0) }
        } }
        return hash(bytes)
    }
    private static func equal(_ a: [String: Any], _ b: [String: Any]) -> Bool { NSDictionary(dictionary: a).isEqual(to: b) }
    private static func readBytes(_ file: URL, folder: ProjectFolder, limit: Int = recordLimit) throws -> (Data, NativeProjectRecovery.Read) {
        let file = try folder.output(file.path), parent = file.deletingLastPathComponent()
        let directory = Darwin.open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw NativeProjectRecovery.posix() }
        defer { Darwin.close(directory) }
        var before = Darwin.stat()
        guard fstat(directory, &before) == 0 else { throw NativeProjectRecovery.posix() }
        guard let value = try NativeProjectRecovery.read(directory, file.lastPathComponent, limit: limit, exclusive: true) else { throw failure("Recovery bytes are unavailable.") }
        _ = try folder.output(file.path)
        let named = try stat(parent, noFollow: true)
        guard identity(before) == identity(named) else { throw failure("The recovery directory changed while it was read.") }
        return (value.data, value)
    }
    private static func names(_ folder: ProjectFolder) throws -> [URL] {
        let dir = try directory(folder)
        let fd = Darwin.open(dir.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { if errno == ENOENT { return [] }; throw NativeProjectRecovery.posix() }
        guard let stream = fdopendir(fd) else { Darwin.close(fd); throw NativeProjectRecovery.posix() }
        defer { closedir(stream) }
        var result: [URL] = []
        while true {
            try Task.checkCancellation(); errno = 0
            guard let entry = readdir(stream) else { if errno != 0 { throw NativeProjectRecovery.posix() }; break }
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in pointer.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) } }
            if name == "." || name == ".." { continue }
            guard result.count < 64 else { throw failure("The recovery store exceeds its 64-file limit. Preserve it and inspect its files.") }
            result.append(dir.appendingPathComponent(name))
        }
        return result
    }
    private static func nanoseconds(_ time: timespec) throws -> Int64 {
        guard time.tv_nsec >= 0, time.tv_nsec < 1_000_000_000 else { throw failure("The source timestamp is unsupported for recovery.") }
        let scaled = Int64(time.tv_sec).multipliedReportingOverflow(by: 1_000_000_000)
        let result = scaled.partialValue.addingReportingOverflow(Int64(time.tv_nsec))
        guard !scaled.overflow, !result.overflow else { throw failure("The source timestamp is unsupported for recovery.") }
        return result.partialValue
    }
    private static func fingerprintMatches(_ saved: String?, source: Darwin.stat) throws -> Bool {
        guard let saved, saved.utf16.count <= 100 else { return false }
        if saved == "v2|\(source.st_size)|\(source.st_mtimespec.tv_sec)|\(source.st_mtimespec.tv_nsec)" { return true }
        guard let pattern = try? NSRegularExpression(pattern: "^(0|[1-9][0-9]*)\\|(-?(?:0|[1-9][0-9]*))\\.([0-9]{3})$"),
              let match = pattern.firstMatch(in: saved, range: NSRange(saved.startIndex..., in: saved)), match.range.length == saved.utf16.count,
              let sizeRange = Range(match.range(at: 1), in: saved), let msRange = Range(match.range(at: 2), in: saved), let fractionRange = Range(match.range(at: 3), in: saved),
              Int64(saved[sizeRange]) == source.st_size, let milliseconds = Int64(saved[msRange]), let fraction = Int64(saved[fractionRange]) else { return false }
        let scaled = milliseconds.multipliedReportingOverflow(by: 1_000)
        let micros = scaled.partialValue.addingReportingOverflow(saved[msRange].hasPrefix("-") ? -fraction : fraction)
        let nanos = micros.partialValue.multipliedReportingOverflow(by: 1_000)
        guard !scaled.overflow, !micros.overflow, !nanos.overflow else { return false }
        let distance = try nanoseconds(source.st_mtimespec).subtractingReportingOverflow(nanos.partialValue)
        return !distance.overflow && distance.partialValue >= -1_000 && distance.partialValue <= 1_000
    }
    private static func basis(src: String, locale: String, folder: ProjectFolder) throws -> [String: Any] {
        let source = try stat(folder.resolve(src)), root = try stat(folder.root)
        guard source.st_mode & S_IFMT == S_IFREG else { throw failure("The source is not a file.") }
        let (project, _) = try readBytes(folder.projectFile, folder: folder, limit: NativeProjectRecovery.maximumBytes)
        let transcriptFile = try NativeTranscriptStore.file(src: src, locale: locale, folder: folder)
        let transcript: [String: Any]
        if FileManager.default.fileExists(atPath: transcriptFile.path) {
            let (bytes, _) = try readBytes(transcriptFile, folder: folder)
            guard let saved = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], saved["src"] as? String == src, saved["locale"] as? String == locale,
                  try fingerprintMatches(saved["fingerprint"] as? String, source: source) else { throw failure("The source or saved transcript changed. Its recovery copy can only be copied.") }
            transcript = saved
        } else { transcript = ["words": [[String: Any]](), "revision": 0, "status": "missing"] }
        guard transcript["status"] as? String != "stale" else { throw failure("The source changed. Its recovery copy can only be copied.") }
        guard let revision = integer(transcript["revision"]) else { throw failure("The transcript has no valid revision.") }
        let words = try exactWords(transcript["words"])
        let mtime = try nanoseconds(source.st_mtimespec)
        let ctime = try nanoseconds(source.st_ctimespec)
        return ["folder": identity(root), "projectSHA256": hash(project), "source": "v3|\(source.st_dev)|\(source.st_ino)|\(source.st_size)|\(mtime)|\(ctime)", "revision": revision, "fingerprint": transcript["fingerprint"] as? String ?? "", "wordCount": words.count, "timingSHA256": timingDigest(words)]
    }
    private static func scan(_ folder: ProjectFolder) throws -> Scan {
        let dir = try directory(folder)
        guard FileManager.default.fileExists(atPath: dir.path) else { return Scan(records: [], warnings: [], bytes: 0, files: 0) }
        let files = try names(folder)
        guard files.count <= 64 else { throw failure("The recovery store exceeds its 64-file limit. Preserve it and inspect the files before continuing.") }
        var records: [Record] = [], warnings: [String] = [], bytes = 0
        for file in files {
            let named = try stat(file, noFollow: true)
            if named.st_mode & S_IFMT == S_IFREG {
                guard named.st_size >= 0, named.st_size <= Int64(storeLimit - bytes) else { throw failure("The recovery store exceeds its 256 MB limit.") }
                bytes += Int(named.st_size)
            }
            do {
                guard file.pathExtension == "json", let nameID = identifier(file.deletingPathExtension().lastPathComponent) else { throw failure("Unrecognized record.") }
                let (data, info) = try readBytes(file, folder: folder)
                guard let fields = try JSONSerialization.jsonObject(with: data) as? [String: Any], integer(fields["schema"]) == 1,
                      identifier(fields["id"]) == nameID, identifier(fields["sessionID"]) != nil, let sequence = integer(fields["sequence"]), sequence >= 1,
                      ["draft", "discard"].contains(fields["kind"] as? String ?? ""), let created = fields["createdAt"] as? NSNumber, created.doubleValue.isFinite, created.doubleValue >= 0 else { throw failure("Invalid record.") }
                _ = try owner(fields)
                if fields["kind"] as? String == "draft" {
                    let words = try exactWords(fields["words"])
                    guard let basis = fields["basis"] as? [String: Any], integer(basis["wordCount"]) == words.count, basis["timingSHA256"] as? String == timingDigest(words) else { throw failure("Invalid captured timestamps.") }
                }
                records.append(Record(fields: fields, file: file, read: info))
            } catch { warnings.append("\(file.lastPathComponent): \(error.localizedDescription)") }
        }
        guard bytes <= storeLimit else { throw failure("The recovery store exceeds its 256 MB limit.") }
        return Scan(records: records, warnings: warnings, bytes: bytes, files: files.count)
    }
    private static func heads(_ records: [Record]) throws -> [String: Record] {
        var result: [String: Record] = [:]
        for record in records {
            let session = identifier(record.fields["sessionID"])!, sequence = integer(record.fields["sequence"])!
            if let old = result[session] {
                let oldSequence = integer(old.fields["sequence"])!
                if oldSequence == sequence, old.fields["id"] as? String != record.fields["id"] as? String { throw failure("Two recovery records claim the same session sequence. Preserve them and inspect the recovery store.") }
                if oldSequence > sequence { continue }
            }
            result[session] = record
        }
        return result
    }
    private static func selected(_ body: [String: Any], folder: ProjectFolder) throws -> (Scan, Record) {
        let (src, locale) = try owner(body), state = try scan(folder)
        guard let id = identifier(body["id"]), let record = state.records.first(where: { identifier($0.fields["id"]) == id }),
              record.fields["kind"] as? String == "draft", record.fields["src"] as? String == src, record.fields["locale"] as? String == locale,
              try heads(state.records)[identifier(record.fields["sessionID"])!]?.fields["id"] as? String == record.fields["id"] as? String else { throw failure("That recovery copy is no longer current. Reload the recovery offers.") }
        return (state, record)
    }
    private static func publish(_ fields: [String: Any], state: Scan, folder: ProjectFolder, recovery: NativeProjectRecovery.Store?, assertPublication: () throws -> Void, validate: () throws -> Void) throws -> JSON {
        let data = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        guard data.count <= recordLimit, state.bytes <= storeLimit - data.count, state.files <= 62 else { throw failure("The recovery store is full. Preserve it and inspect its files before continuing.") }
        let dir = try directory(folder)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dirfd = Darwin.open(dir.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard dirfd >= 0 else { throw NativeProjectRecovery.posix() }
        defer { Darwin.close(dirfd) }
        var directoryInfo = Darwin.stat()
        guard fstat(dirfd, &directoryInfo) == 0 else { throw NativeProjectRecovery.posix() }
        let owned = identity(directoryInfo), temp = UUID().uuidString.lowercased() + ".part", final = (fields["id"] as! String) + ".json"
        // put writes with openat, bounded writes, ACL removal and an owned cleanup.
        let staged = try NativeProjectRecovery.put(data, directory: dirfd, name: temp)
        defer {
            var named = Darwin.stat()
            if fstatat(dirfd, temp, &named, AT_SYMLINK_NOFOLLOW) == 0, named.st_dev == staged.st_dev, named.st_ino == staged.st_ino { _ = unlinkat(dirfd, temp, 0) }
        }
        try Task.checkCancellation(); try assertPublication(); try validate(); try recovery?.requireIdentity()
        _ = try folder.output(dir.path)
        guard identity(try stat(dir, noFollow: true)) == owned else { throw failure("The recovery directory changed before publication.") }
        // Reopen and retain the staged descriptor through publication. Never link a
        // replaced temporary name or clean up a name owned by another writer.
        let stagedFD = openat(dirfd, temp, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard stagedFD >= 0 else { throw NativeProjectRecovery.posix() }
        defer { Darwin.close(stagedFD) }
        var held = Darwin.stat(), named = Darwin.stat()
        guard fstat(stagedFD, &held) == 0, fstatat(dirfd, temp, &named, AT_SYMLINK_NOFOLLOW) == 0,
              NativeProjectRecovery.Read(data: Data(), info: staged).matches(held), NativeProjectRecovery.Read(data: Data(), info: staged).matches(named), named.st_nlink == 1 else { throw failure("The staged recovery copy changed before publication.") }
        try NativeProjectRecovery.verifyBytes(stagedFD, expected: data)
        guard fstat(stagedFD, &held) == 0, fstatat(dirfd, temp, &named, AT_SYMLINK_NOFOLLOW) == 0,
              held.st_size == Int64(data.count), named.st_nlink == 1,
              NativeProjectRecovery.Read(data: Data(), info: staged).matches(held), NativeProjectRecovery.Read(data: Data(), info: staged).matches(named) else { throw failure("The staged recovery bytes changed before publication.") }
        guard linkat(dirfd, temp, dirfd, final, 0) == 0 else { throw NativeProjectRecovery.posix() }
        var warning: String?
        do {
        var temporary = Darwin.stat()
        guard fstatat(dirfd, temp, &temporary, AT_SYMLINK_NOFOLLOW) == 0, temporary.st_dev == staged.st_dev, temporary.st_ino == staged.st_ino,
              unlinkat(dirfd, temp, 0) == 0 else { throw failure("The published recovery temporary could not be retired.") }
        var heldAfterLink = Darwin.stat(), published = Darwin.stat()
        guard fstat(stagedFD, &heldAfterLink) == 0, fstatat(dirfd, final, &published, AT_SYMLINK_NOFOLLOW) == 0,
              published.st_dev == staged.st_dev, published.st_ino == staged.st_ino, published.st_size == Int64(data.count), published.st_nlink == 1,
              NativeProjectRecovery.Read(data: Data(), info: heldAfterLink).matches(published) else { throw failure("The published recovery copy changed.") }
        try NativeProjectRecovery.verifyBytes(stagedFD, expected: data)
        var afterBytes = Darwin.stat(), namedAfterBytes = Darwin.stat()
        guard fstat(stagedFD, &afterBytes) == 0, fstatat(dirfd, final, &namedAfterBytes, AT_SYMLINK_NOFOLLOW) == 0,
              NativeProjectRecovery.Read(data: Data(), info: heldAfterLink).matches(afterBytes), NativeProjectRecovery.Read(data: Data(), info: heldAfterLink).matches(namedAfterBytes) else { throw failure("The published recovery bytes changed.") }
        try NativeProjectRecovery.sync(dirfd)
        } catch { warning = "The recovery record was published, but its cleanup or verification did not finish. Keep the editor open or save corrections before closing." }
        if warning == nil {
            do { try assertPublication(); try recovery?.requireIdentity() }
            catch { warning = "The recovery copy was published. Cleanup was deferred because its publication identity changed." }
        }
        if warning == nil { for old in state.records where identifier(old.fields["sessionID"]) == identifier(fields["sessionID"]) {
            let oldFD = openat(dirfd, old.file.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            if oldFD < 0 { continue }
            var heldOld = Darwin.stat(), namedOld = Darwin.stat()
            if fstat(oldFD, &heldOld) == 0, fstatat(dirfd, old.file.lastPathComponent, &namedOld, AT_SYMLINK_NOFOLLOW) == 0,
               namedOld.st_mode & S_IFMT == S_IFREG, namedOld.st_nlink == 1, old.read.matches(heldOld), old.read.matches(namedOld) { _ = unlinkat(dirfd, old.file.lastPathComponent, 0) }
            Darwin.close(oldFD)
        } }
        var receipt: [String: Any] = ["id": fields["id"]!, "sessionID": fields["sessionID"]!, "sequence": fields["sequence"]!, "createdAt": fields["createdAt"]!]
        if let warning { receipt["warning"] = warning }
        return JSON(any: receipt)
    }
    public static func handle(action: String, body: [String: Any], folder: ProjectFolder, assertPublication: () throws -> Void = {}) throws -> JSON {
        if action == "checkpoint" || action == "discard" {
            try assertPublication()
            let recovery = try NativeProjectRecovery.Store(folder: folder)
            let lock = try NativeProjectRecovery.PublicationLock(directory: recovery.directoryFD)
            defer { withExtendedLifetime(lock) {} }
            try recovery.requireIdentity(); try lock.requireIdentity()
            return try handleUnlocked(action: action, body: body, folder: folder, assertPublication: {
                try recovery.requireIdentity(); try lock.requireIdentity(); try assertPublication()
            }, recovery: recovery)
        }
        return try handleUnlocked(action: action, body: body, folder: folder, assertPublication: assertPublication)
    }
    private static func handleUnlocked(action: String, body: [String: Any], folder: ProjectFolder, assertPublication: () throws -> Void = {}, recovery: NativeProjectRecovery.Store? = nil) throws -> JSON {
        let (src, locale) = try owner(body)
        if action == "context" {
            let state = try scan(folder), current: [String: Any]?, reason: String?
            do { current = try basis(src: src, locale: locale, folder: folder); reason = nil } catch { current = nil; reason = error.localizedDescription }
            let offers: [[String: Any]] = try heads(state.records).values.filter { $0.fields["kind"] as? String == "draft" && $0.fields["src"] as? String == src && $0.fields["locale"] as? String == locale }.map { record in
                ["id": record.fields["id"]!, "sessionID": record.fields["sessionID"]!, "sequence": record.fields["sequence"]!, "createdAt": record.fields["createdAt"]!, "wordCount": (record.fields["words"] as! [[String: Any]]).count, "recoverable": current.map { equal($0, record.fields["basis"] as! [String: Any]) } ?? false]
            }
            var result: [String: Any] = ["src": src, "locale": locale, "basis": current.map { $0 as Any } ?? NSNull(), "offers": offers, "warnings": state.warnings]
            if let reason { result["reason"] = reason }
            return JSON(any: result)
        }
        if action == "checkpoint" {
            let state = try scan(folder), current = try basis(src: src, locale: locale, folder: folder)
            guard let captured = body["basis"] as? [String: Any], equal(current, captured) else { throw failure("The project, source or transcript changed. Copy the unsaved words and recheck before editing.") }
            guard let session = identifier(body["sessionID"]), let sequence = integer(body["sequence"]), sequence >= 1 else { throw failure("Recovery copies need a session and a finite sequence.") }
            let allHeads = try heads(state.records), head = allHeads[session]
            if let head {
                guard identifier(head.fields["id"]) == identifier(body["parent"]), sequence == integer(head.fields["sequence"])! + 1, head.fields["src"] as? String == src, head.fields["locale"] as? String == locale else { throw failure("The recovery session changed. Reload its current head before checkpointing.") }
            } else {
                guard body["parent"] == nil || body["parent"] is NSNull, sequence == 1 else { throw failure("The recovery session changed.") }
                guard allHeads.values.filter({ $0.fields["kind"] as? String == "draft" }).count < 8 else { throw failure("Eight recovery sessions already have unsaved words. Copy or discard one before editing in another window.") }
            }
            let words = try exactWords(body["words"])
            guard integer(current["wordCount"]) == words.count, current["timingSHA256"] as? String == timingDigest(words) else { throw failure("Recovery words must retain the captured transcript timestamps.") }
            let fields: [String: Any] = ["schema": 1, "id": UUID().uuidString.lowercased(), "kind": "draft", "src": src, "locale": locale, "sessionID": session, "sequence": sequence, "parent": body["parent"] ?? NSNull(), "createdAt": Int64(Date().timeIntervalSince1970 * 1000), "basis": current, "words": words]
            return try publish(fields, state: state, folder: folder, recovery: recovery, assertPublication: assertPublication) { guard equal(current, try basis(src: src, locale: locale, folder: folder)) else { throw failure("The source or transcript changed before recovery publication.") } }
        }
        let (state, record) = try selected(body, folder: folder)
        if action == "read" || action == "recover" {
            if action == "recover" { guard equal(try basis(src: src, locale: locale, folder: folder), record.fields["basis"] as! [String: Any]) else { throw failure("This recovery copy has old source timestamps or project identity. Copy its text instead.") } }
            return JSON(any: ["src": src, "locale": locale, "basis": record.fields["basis"]!, "words": record.fields["words"]!])
        }
        guard action == "discard" else { throw failure("Unknown recovery action.") }
        guard integer(record.fields["sequence"])! < 1_000_000_000 else { throw failure("This recovery session reached its sequence limit. Copy its text before retiring it.") }
        let fields: [String: Any] = ["schema": 1, "id": UUID().uuidString.lowercased(), "kind": "discard", "src": src, "locale": locale, "sessionID": record.fields["sessionID"]!, "sequence": integer(record.fields["sequence"])! + 1, "parent": record.fields["id"]!, "createdAt": Int64(Date().timeIntervalSince1970 * 1000)]
        return try publish(fields, state: state, folder: folder, recovery: recovery, assertPublication: assertPublication) { let (_, current) = try selected(body, folder: folder); guard current.fields["id"] as? String == record.fields["id"] as? String else { throw failure("The recovery copy changed before discard.") } }
    }
}
