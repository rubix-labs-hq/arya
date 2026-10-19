import CryptoKit
import Darwin
import Foundation

/// Corrected words use source seconds and a locale-specific source fingerprint.
public enum NativeTranscriptStore {
    public static func localeID(_ locale: String?) throws -> String {
        let raw = locale ?? Locale.current.identifier.components(separatedBy: "@")[0]
        let tag = raw.replacingOccurrences(of: "_", with: "-")
        guard tag.count <= 64, tag.range(of: "^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$", options: .regularExpression) == tag.startIndex..<tag.endIndex else {
            throw ReelBackend.APIError("Use a language tag such as en-US or es-ES.")
        }
        var parts = tag.split(separator: "-").map(String.init)
        parts[0] = ["iw": "he", "in": "id", "ji": "yi"][parts[0].lowercased()] ?? parts[0].lowercased()
        var index = 1
        if index < parts.count, parts[index].count == 4, parts[index].allSatisfy(\.isLetter) {
            parts[index] = parts[index].prefix(1).uppercased() + parts[index].dropFirst().lowercased(); index += 1
        }
        if index < parts.count, (parts[index].count == 2 && parts[index].allSatisfy(\.isLetter)) || (parts[index].count == 3 && parts[index].allSatisfy(\.isNumber)) {
            parts[index] = parts[index].uppercased(); index += 1
        }
        var variants = Set<String>()
        for i in index..<parts.count {
            let value = parts[i].lowercased()
            guard (5...8).contains(value.count) || (value.count == 4 && value.first?.isNumber == true), variants.insert(value).inserted else {
                throw ReelBackend.APIError("Use a language tag such as en-US or es-ES.")
            }
            parts[i] = value
        }
        return parts.joined(separator: "-")
    }

    static func file(src: String, locale: String, folder: ProjectFolder) throws -> URL {
        let source = try folder.resolve(src)
        let key = Insecure.SHA1.hash(data: Data([src, locale].joined(separator: "|").utf8)).map { String(format: "%02x", $0) }.joined().prefix(16)
        _ = source
        return try folder.output(".reel/transcripts/\(key).json")
    }

    static func fingerprint(_ src: String, folder: ProjectFolder) throws -> String {
        try sourceStamp(src, folder: folder).text
    }

    struct SourceIdentity: Equatable, Sendable {
        let file: URL
        let fingerprint: String
    }

    static func sourceIdentity(_ src: String, folder: ProjectFolder) throws -> SourceIdentity {
        let file = try folder.resolve(src)
        return SourceIdentity(file: file, fingerprint: try fingerprint(file.path, folder: folder))
    }

    private struct SourceStamp {
        let size: Int64, seconds: Int64, nanoseconds: Int64
        var text: String { "v2|\(size)|\(seconds)|\(nanoseconds)" }
    }

    private static func sourceStamp(_ src: String, folder: ProjectFolder) throws -> SourceStamp {
        let file = try folder.resolve(src)
        var attributes = Darwin.stat()
        guard file.path.withCString({ Darwin.fstatat(AT_FDCWD, $0, &attributes, 0) }) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        guard attributes.st_mode & S_IFMT == S_IFREG else { throw ReelBackend.APIError("The transcript source is not a file.") }
        return SourceStamp(size: attributes.st_size, seconds: Int64(attributes.st_mtimespec.tv_sec), nanoseconds: Int64(attributes.st_mtimespec.tv_nsec))
    }

    private static func matchesFingerprint(_ saved: String?, stamp: SourceStamp) -> Bool {
        guard let saved else { return false }
        if saved == stamp.text { return true }
        guard saved.count <= 100, let pattern = try? NSRegularExpression(pattern: "^(0|[1-9][0-9]*)\\|(-?(?:0|[1-9][0-9]*))\\.([0-9]{3})$"),
              let match = pattern.firstMatch(in: saved, range: NSRange(saved.startIndex..., in: saved)),
              match.range.length == saved.utf16.count,
              let sizeRange = Range(match.range(at: 1), in: saved), let msRange = Range(match.range(at: 2), in: saved), let fractionRange = Range(match.range(at: 3), in: saved),
              let size = Int64(saved[sizeRange]), size == stamp.size, let milliseconds = Int64(saved[msRange]), let fraction = Int64(saved[fractionRange]) else { return false }
        let scaled = milliseconds.multipliedReportingOverflow(by: 1000)
        let micros = scaled.partialValue.addingReportingOverflow(saved[msRange].hasPrefix("-") ? -fraction : fraction)
        guard !scaled.overflow, !micros.overflow else { return false }
        var seconds = micros.partialValue / 1_000_000, remainder = micros.partialValue % 1_000_000
        if remainder < 0 { seconds -= 1; remainder += 1_000_000 }
        let distance = stamp.seconds.subtractingReportingOverflow(seconds)
        guard !distance.overflow, (-1...1).contains(distance.partialValue) else { return false }
        // Legacy records rounded milliseconds to three decimals after floating-point conversion.
        let nanoseconds = distance.partialValue * 1_000_000_000 + stamp.nanoseconds - remainder * 1000
        return abs(nanoseconds) <= 1000
    }

    public static func validate(_ value: Any?, duration: Double = .infinity) throws -> [[String: Any]] {
        guard let words = value as? [[String: Any]], words.count <= 100_000 else { throw ReelBackend.APIError("A transcript must contain at most 100000 words.") }
        var previous = -1.0
        return try words.map { w in
            guard let t = (w["t"] as? NSNumber)?.doubleValue, let end = (w["end"] as? NSNumber)?.doubleValue,
                  t.isFinite, end.isFinite, t >= 0, end > t, t >= previous, end <= duration + 0.02,
                  let text = w["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 1000 else {
                throw ReelBackend.APIError("Transcript words need ordered, finite source timings and nonempty text.")
            }
            previous = t
            var out: [String: Any] = ["t": t, "end": end, "text": text.trimmingCharacters(in: .whitespacesAndNewlines)]
            if let confidence = (w["confidence"] as? NSNumber)?.doubleValue, confidence.isFinite { out["confidence"] = min(1, max(0, confidence)) }
            return out
        }
    }

    public static func read(src: String, locale: String, folder: ProjectFolder) throws -> JSON {
        let url = try file(src: src, locale: locale, folder: folder)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return .object([("src", .string(src)), ("locale", .string(locale)), ("words", []), ("revision", 0), ("status", "missing")])
        }
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        guard (attrs[.size] as? NSNumber)?.intValue ?? 0 <= 16 * 1024 * 1024 else { throw ReelBackend.APIError("The saved transcript is larger than 16 MB.") }
        let value = try JSON.parse(String(contentsOf: folder.output(url.path), encoding: .utf8))
        guard let fields = value as? [String: Any], fields["src"] as? String == src, fields["locale"] as? String == locale, let revision = fields["revision"] as? Int, revision >= 0, revision <= 1_000_000_000 else { throw ReelBackend.APIError("The transcript does not match this source and locale.") }
        _ = try validate(fields["words"])
        if !matchesFingerprint(fields["fingerprint"] as? String, stamp: try sourceStamp(src, folder: folder)) {
            return .object([("src", .string(src)), ("locale", .string(locale)), ("words", []), ("revision", JSON(any: fields["revision"] ?? 0)), ("status", "stale"), ("warning", "The source changed. Transcribe it again before using old words.")])
        }
        return JSON(any: fields)
    }

    public static func save(src: String, locale: String, words: Any?, expectedRevision: Int?, duration: Double = .infinity, metadata: [String: Any] = [:], folder: ProjectFolder) throws -> JSON {
        try saveRecord(src: src, locale: locale, words: words, expectedRevision: expectedRevision, duration: duration, metadata: metadata, replacingStaleRecognition: false, folder: folder)
    }

    static func saveRecognition(src: String, locale: String, words: Any?, expectedRevision: Int, duration: Double, metadata: [String: Any], folder: ProjectFolder) throws -> JSON {
        try saveRecord(src: src, locale: locale, words: words, expectedRevision: expectedRevision, duration: duration, metadata: metadata, replacingStaleRecognition: true, folder: folder)
    }

    private static func saveRecord(src: String, locale: String, words: Any?, expectedRevision: Int?, duration: Double, metadata: [String: Any], replacingStaleRecognition: Bool, folder: ProjectFolder) throws -> JSON {
        try Task.checkCancellation()
        let checked = try validate(words, duration: duration)
        let old = (try JSON.parse(read(src: src, locale: locale, folder: folder).text) as? [String: Any]) ?? [:]
        guard old["status"] as? String != "stale" || replacingStaleRecognition else { throw ReelBackend.APIError("The source changed. Transcribe it again before saving corrections.") }
        let revision = old["revision"] as? Int ?? 0
        if let expectedRevision, expectedRevision != revision { throw ReelBackend.APIError("The transcript changed. Reload it before saving corrections.") }
        var fields = old.merging(metadata) { _, new in new }
        if old["status"] as? String == "stale" { fields.removeValue(forKey: "warning") }
        fields["src"] = src; fields["locale"] = locale; fields["words"] = checked; fields["revision"] = revision + 1
        fields["status"] = metadata["status"] ?? (["complete", "partial"].contains(old["status"] as? String ?? "") ? old["status"]! : "complete")
        fields["fingerprint"] = try fingerprint(src, folder: folder)
        fields["updatedAt"] = Date().timeIntervalSince1970 * 1000
        let result = JSON(any: fields), data = Data(result.text.utf8)
        guard data.count <= 16 * 1024 * 1024 else { throw ReelBackend.APIError("The transcript is larger than 16 MB.") }
        let url = try file(src: src, locale: locale, folder: folder)
        try FileManager.default.createDirectory(at: folder.output(url.deletingLastPathComponent().path), withIntermediateDirectories: true)
        try Task.checkCancellation()
        try data.write(to: folder.output(url.path), options: .atomic)
        return result
    }
}
