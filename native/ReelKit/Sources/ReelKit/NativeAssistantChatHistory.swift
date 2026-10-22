import CoreFoundation
import CryptoKit
import Darwin
import Foundation

/// Project-owned display history. Restoring messages never restores a run or permission.
public final class NativeAssistantChatHistory {
    public static let maximumMessages = 200
    public static let maximumDisplayedMessages = 100
    public static let maximumBytes = 2 * 1024 * 1024
    private static let providers: Set<String> = ["claude-code", "codex", "antigravity", "gemini-cli", "custom", "anthropic"]
    private static let messageKeys: Set<String> = ["role", "text", "at", "refs", "error", "provider"]
    private static let referenceKeys: Set<String> = ["kind", "id", "label"]
    private let folder: ProjectFolder
    public private(set) var messages: [JSON] = []
    private var restored = 0
    private var warning: String?
    private var omittedOversizeMessage = false
    private var blocked = false
    private var previousHash: Data?
    private var rootIdentity: (dev_t, ino_t)?
    private struct Failure: Error {}
    private struct Stamp: Equatable {
        let device: dev_t, inode: ino_t, bytes: off_t
        let modified: Int, modifiedNS: Int, changed: Int, changedNS: Int
        init(_ value: stat) {
            device = value.st_dev; inode = value.st_ino; bytes = value.st_size
            modified = value.st_mtimespec.tv_sec; modifiedNS = value.st_mtimespec.tv_nsec
            changed = value.st_ctimespec.tv_sec; changedNS = value.st_ctimespec.tv_nsec
        }
    }

    public init(folder: ProjectFolder) {
        self.folder = folder
        do {
            if let bytes = try read() {
                messages = try Self.parse(bytes); previousHash = Self.digest(bytes); restored = messages.count
            }
        } catch {
            blocked = true
            warning = "Saved chat history could not be read. The existing file is unchanged; inspect .reel/assistant-chat.json before saving history again."
        }
    }

    public var status: JSON {
        let warnings = [warning, omittedOversizeMessage ? "A message exceeded the saved chat history limit and was not saved. It is available only in the current conversation and will not appear after reopening the project." : nil].compactMap { $0 }
        return .object([("restored", .int(restored)), ("warning", warnings.isEmpty ? .null : .string(warnings.joined(separator: " "))), ("savingAvailable", .bool(!blocked))])
    }
    public var snapshot: JSON { .object([("messages", .array(messages)), ("status", status)]) }

    /// Append receives a display projection, not provider request context or tool turns.
    @discardableResult public func append(_ value: JSON, admitWrite: () throws -> Void = {}) throws -> JSON {
        let message = try Self.displayMessage(value)
        guard Self.encoded([message]).count <= Self.maximumBytes else {
            omittedOversizeMessage = true
            return snapshot
        }
        messages = try Self.bounded(messages + [message])
        if !blocked { persist(admitWrite: admitWrite) }
        return snapshot
    }

    /// The live conversation keeps accepted rows independently of the saved file's byte cap.
    public static func boundedLive(_ values: [JSON]) -> [JSON] {
        Array(values.suffix(maximumDisplayedMessages))
    }

    public static func bounded(_ values: [JSON]) throws -> [JSON] {
        var result = Array(values.suffix(maximumMessages))
        while !result.isEmpty, encoded(result).count > maximumBytes { result.removeFirst() }
        return result
    }

    public static func displayMessage(_ value: JSON) throws -> JSON {
        guard var fields = try JSON.parse(value.text) as? [String: Any] else { throw Failure() }
        if fields["role"] as? String == "you" { fields["role"] = "user" }
        if let source = fields["refs"] as? [String: Any] {
            var labels: [[String: String]] = []
            if let kind = source["inputKind"] as? String, ["prompt", "script", "screenplay"].contains(kind) {
                labels.append(["kind": "input_kind", "id": kind, "label": kind.capitalized])
            }
            let selection = source["sourceSelection"] as? [String: Any] ?? [:]
            let ids = selection["nativeLayerIDs"] as? [String] ?? source["clips"] as? [String] ?? []
            for id in ids.prefix(60) { labels.append(["kind": "clip", "id": id, "label": id]) }
            if ids.count > 60 { labels.append(["kind": "notice", "id": "shortened", "label": "Some historical reference labels were shortened."]) }
            if let comp = source["composition"] as? String, !comp.isEmpty { labels.append(["kind": "composition", "id": comp, "label": comp]) }
            if let reference = source["reference"] as? String { labels.append(["kind": "image", "id": reference, "label": (reference as NSString).lastPathComponent]) }
            fields["refs"] = labels
        }
        return try normalize(fields, strict: false)
    }

    public static func parse(_ bytes: Data) throws -> [JSON] {
        guard bytes.count <= maximumBytes, let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(value.keys) == ["version", "messages"], integer(value["version"]) == 1,
              let rows = value["messages"] as? [[String: Any]], rows.count <= maximumMessages else { throw Failure() }
        return try rows.map { try normalize($0, strict: true) }
    }

    private static func integer(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let result = number.doubleValue
        return result.isFinite && result >= 0 && result <= 9_007_199_254_740_991 && result == result.rounded() ? result : nil
    }
    private static func redact(_ text: String) -> String {
        // JavaScript uses ASCII word boundaries and includes BOM in whitespace.
        text.replacingOccurrences(of: #"(?<![A-Za-z0-9_])(?:[sS][kK]-(?:[aA][nN][tT]-)?[A-Za-z0-9_-]{12,}|[bB][eE][aA][rR][eE][rR][\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+[A-Za-z0-9._~-]{16,})"#, with: "[redacted]", options: .regularExpression)
    }
    private static func normalize(_ fields: [String: Any], strict: Bool) throws -> JSON {
        guard let role = fields["role"] as? String, ["user", "claude", "assistant"].contains(role), let text = fields["text"] as? String,
              let at = integer(fields["at"]), !strict || Set(fields.keys).isSubset(of: messageKeys) else { throw Failure() }
        var result: [(String, JSON)] = [("role", .string(role)), ("text", .string(redact(text))), ("at", .number(at))]
        if let raw = fields["error"] {
            guard let flag = raw as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else { throw Failure() }
            result.append(("error", .bool(flag.boolValue)))
        }
        if let raw = fields["provider"] {
            guard let provider = raw as? String, providers.contains(provider) else { throw Failure() }
            result.append(("provider", .string(provider)))
        }
        if let raw = fields["refs"] {
            guard let refs = raw as? [[String: Any]], refs.count <= 64 else { throw Failure() }
            let labels: [JSON] = try refs.map { ref in
                guard let kind = ref["kind"] as? String, let id = ref["id"] as? String, let label = ref["label"] as? String,
                      kind.utf16.count <= 64, id.utf16.count <= 2048, label.utf16.count <= 4096,
                      !strict || Set(ref.keys).isSubset(of: referenceKeys) else { throw Failure() }
                return .object([("kind", .string(redact(kind))), ("id", .string(redact(id))), ("label", .string(redact(label)))])
            }
            result.append(("refs", .array(labels)))
        }
        return JSON.object(result)
    }
    private static func encoded(_ rows: [JSON]) -> Data { Data((JSON.object([("version", 1), ("messages", .array(rows))]).text + "\n").utf8) }
    private static func digest(_ bytes: Data) -> Data { Data(SHA256.hash(data: bytes)) }

    /// Hold the actual root and .reel directory; no pathname write follows a replaced link.
    private func directory(create: Bool) throws -> Int32? {
        let root = Darwin.open(folder.root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard root >= 0 else { throw Failure() }
        defer { Darwin.close(root) }
        var held = stat(), entry = stat()
        guard Darwin.fstat(root, &held) == 0, Darwin.lstat(folder.root.path, &entry) == 0,
              held.st_mode & S_IFMT == S_IFDIR, held.st_dev == entry.st_dev, held.st_ino == entry.st_ino else { throw Failure() }
        if let expected = rootIdentity { guard expected.0 == held.st_dev, expected.1 == held.st_ino else { throw Failure() } }
        else { rootIdentity = (held.st_dev, held.st_ino) }
        _ = try folder.output(".reel")
        if create, Darwin.mkdirat(root, ".reel", 0o700) != 0, errno != EEXIST { throw Failure() }
        let descriptor = Darwin.openat(root, ".reel", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if descriptor < 0 { if errno == ENOENT && !create { return nil }; throw Failure() }
        do { try checkDirectory(descriptor); return descriptor }
        catch { Darwin.close(descriptor); throw error }
    }
    private func checkDirectory(_ descriptor: Int32) throws {
        let file = try folder.output(".reel")
        var root = stat()
        guard let expected = rootIdentity, Darwin.lstat(folder.root.path, &root) == 0, root.st_mode & S_IFMT == S_IFDIR,
              root.st_dev == expected.0, root.st_ino == expected.1 else { throw Failure() }
        var held = stat(), entry = stat()
        guard Darwin.fstat(descriptor, &held) == 0, Darwin.lstat(file.path, &entry) == 0,
              held.st_mode & S_IFMT == S_IFDIR, held.st_dev == entry.st_dev, held.st_ino == entry.st_ino else { throw Failure() }
    }
    private func read() throws -> Data? {
        guard let directory = try directory(create: false) else { return nil }
        defer { Darwin.close(directory) }
        return try read(directory: directory)
    }
    private func read(directory: Int32, name: String = "assistant-chat.json") throws -> Data? {
        try checkDirectory(directory)
        let descriptor = Darwin.openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if descriptor < 0 { if errno == ENOENT { return nil }; throw Failure() }
        defer { Darwin.close(descriptor) }
        var before = stat(), after = stat(), entry = stat()
        guard Darwin.fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_nlink == 1,
              before.st_size >= 0, before.st_size <= off_t(Self.maximumBytes) else { throw Failure() }
        var bytes = Data(count: Self.maximumBytes + 1), count = 0
        try bytes.withUnsafeMutableBytes { buffer in
            while count < buffer.count {
                let read = Darwin.read(descriptor, buffer.baseAddress!.advanced(by: count), buffer.count - count)
                if read < 0 { if errno == EINTR { continue }; throw Failure() }
                if read == 0 { break }; count += read
            }
        }
        guard count <= Self.maximumBytes, Darwin.fstat(descriptor, &after) == 0,
              Stamp(before) == Stamp(after), off_t(count) == after.st_size,
              Darwin.fstatat(directory, name, &entry, AT_SYMLINK_NOFOLLOW) == 0,
              entry.st_mode & S_IFMT == S_IFREG, entry.st_nlink == 1, Stamp(entry) == Stamp(after) else { throw Failure() }
        try checkDirectory(directory)
        bytes.count = count
        return bytes
    }
    private func persist(admitWrite: () throws -> Void) {
        let bytes = Self.encoded(messages)
        var directory: Int32 = -1, descriptor: Int32 = -1
        let temporary = "assistant-chat-\(UUID().uuidString).part.json"
        var published = false
        var stagedIdentity: (dev_t, ino_t)?
        defer {
            if descriptor >= 0 { Darwin.close(descriptor) }
            if directory >= 0 {
                if !published, let owned = stagedIdentity {
                    var entry = stat()
                    if Darwin.fstatat(directory, temporary, &entry, AT_SYMLINK_NOFOLLOW) == 0,
                       entry.st_dev == owned.0, entry.st_ino == owned.1 { Darwin.unlinkat(directory, temporary, 0) }
                }
                Darwin.close(directory)
            }
        }
        do {
            try admitWrite()
            guard let opened = try self.directory(create: true) else { throw Failure() }; directory = opened
            guard try read(directory: directory).map(Self.digest) == previousHash else { throw Failure() }
            descriptor = Darwin.openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else { throw Failure() }
            var owned = stat(), entry = stat()
            guard Darwin.fstat(descriptor, &owned) == 0, owned.st_mode & S_IFMT == S_IFREG, owned.st_nlink == 1 else { throw Failure() }
            stagedIdentity = (owned.st_dev, owned.st_ino)
            try bytes.withUnsafeBytes { buffer in
                var count = 0
                while count < buffer.count {
                    let written = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: count), buffer.count - count)
                    if written < 0 { if errno == EINTR { continue }; throw Failure() }
                    guard written > 0 else { throw Failure() }; count += written
                }
            }
            guard Darwin.fsync(descriptor) == 0 else { throw Failure() }
            Darwin.close(descriptor); descriptor = -1
            try admitWrite()
            try checkDirectory(directory)
            guard Darwin.fstatat(directory, temporary, &entry, AT_SYMLINK_NOFOLLOW) == 0,
                  entry.st_mode & S_IFMT == S_IFREG, entry.st_nlink == 1, entry.st_dev == owned.st_dev, entry.st_ino == owned.st_ino,
                  try read(directory: directory, name: temporary) == bytes,
                  try read(directory: directory).map(Self.digest) == previousHash else { throw Failure() }
            guard Darwin.renameat(directory, temporary, directory, "assistant-chat.json") == 0 else { throw Failure() }
            published = true; previousHash = Self.digest(bytes); warning = nil
            if Darwin.fsync(directory) != 0 { warning = "Chat history was saved, but its directory flush could not be confirmed." }
        } catch {
            warning = "Chat history could not be saved. Messages remain visible for this session; the previous saved file is unchanged."
        }
    }
}
