import CoreFoundation
import Foundation

public enum NativeTimedTranscriptImport {
    public static let maximumBytes = 16 * 1024 * 1024

    public enum Document {
        case words([[String: Any]], warnings: [String])
        case subtitles(text: String, format: String)
    }

    public enum Failure: Error, LocalizedError {
        case fileTooLarge, invalidText, invalidDocument, invalidTiming, invalidDuration, invalidFile, invalidSubtitles
        public var errorDescription: String? {
            switch self {
            case .fileTooLarge: return "The transcript file must be no larger than 16 MB."
            case .invalidText: return "Use a UTF-8 timed transcript, SRT or WebVTT file."
            case .invalidDocument: return "Timed JSON must contain a nonempty word array, or an object with a words array."
            case .invalidTiming: return "Word timings must use finite numbers and stay inside this source."
            case .invalidDuration: return "Choose a source with a finite, positive duration."
            case .invalidFile: return "Choose a regular transcript file."
            case .invalidSubtitles: return "Use complete, ordered SRT or WebVTT cues with valid timestamps inside this source."
            }
        }
    }

    // The caller owns the selected source and draft. Stale success and failure return no document.
    public static func read(_ result: Result<[URL], Error>, duration: Double, isCurrent: () -> Bool) throws -> Document? {
        guard isCurrent() else { return nil }
        try Task.checkCancellation()
        do {
            guard duration.isFinite, duration > 0 else { throw Failure.invalidDuration }
            guard let url = try result.get().first else { return nil }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular else { throw Failure.invalidFile }
            guard ((attributes[.size] as? NSNumber)?.intValue ?? Int.max) <= maximumBytes else { throw Failure.fileTooLarge }
            guard isCurrent() else { return nil }
            try Task.checkCancellation()
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var bytes = Data()
            while bytes.count <= maximumBytes {
                guard isCurrent() else { return nil }
                try Task.checkCancellation()
                let remaining = maximumBytes + 1 - bytes.count
                guard let chunk = try handle.read(upToCount: min(64 * 1024, remaining)), !chunk.isEmpty else { break }
                bytes.append(chunk)
            }
            guard bytes.count <= maximumBytes else { throw Failure.fileTooLarge }
            guard isCurrent() else { return nil }
            try Task.checkCancellation()
            let format = url.pathExtension.lowercased()
            let document: Document
            if format == "srt" || format == "vtt" {
                guard let text = String(data: bytes, encoding: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw Failure.invalidText }
                try validateSubtitles(text: text, format: format, duration: duration)
                document = .subtitles(text: text, format: format)
            } else {
                document = .words(try jsonWords(bytes, duration: duration), warnings: [])
            }
            guard isCurrent() else { return nil }
            try Task.checkCancellation()
            return document
        } catch {
            guard isCurrent() else { return nil }
            throw error
        }
    }

    private static func jsonWords(_ bytes: Data, duration: Double) throws -> [[String: Any]] {
        guard String(data: bytes, encoding: .utf8) != nil else { throw Failure.invalidText }
        let value: Any
        do { value = try JSONSerialization.jsonObject(with: bytes) }
        catch { throw Failure.invalidDocument }
        let words = (value as? [[String: Any]]) ?? ((value as? [String: Any])?["words"] as? [[String: Any]])
        guard let words, !words.isEmpty else { throw Failure.invalidDocument }
        return try validateWords(words, duration: duration)
    }

    public static func validateWords(_ words: [[String: Any]], duration: Double) throws -> [[String: Any]] {
        try Task.checkCancellation()
        guard duration.isFinite, duration > 0 else { throw Failure.invalidDuration }
        guard !words.isEmpty else { throw Failure.invalidDocument }
        let validated = try NativeTranscriptStore.validate(words, duration: duration)
        for word in words {
            try Task.checkCancellation()
            guard let start = word["t"] as? NSNumber, let finish = word["end"] as? NSNumber,
                  CFGetTypeID(start) != CFBooleanGetTypeID(), CFGetTypeID(finish) != CFBooleanGetTypeID(),
                  start.doubleValue.isFinite, finish.doubleValue.isFinite, start.doubleValue >= 0,
                  finish.doubleValue > start.doubleValue, finish.doubleValue <= duration else { throw Failure.invalidTiming }
            if let confidence = word["confidence"] {
                guard let number = confidence as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { throw Failure.invalidTiming }
            }
        }
        return validated
    }

    // The shared parser strips subtitle formatting. Its result must contain this many cues.
    @discardableResult
    public static func validateSubtitles(text: String, format: String, duration: Double) throws -> Int {
        try Task.checkCancellation()
        guard duration.isFinite, duration > 0 else { throw Failure.invalidDuration }
        guard text.utf8.count <= maximumBytes else { throw Failure.fileTooLarge }
        let format = format.lowercased()
        guard format == "srt" || format == "vtt" else { throw Failure.invalidSubtitles }
        var normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        if normalized.first == "\u{feff}" { normalized.removeFirst() }
        normalized = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { throw Failure.invalidText }
        let blocks = normalized.replacingOccurrences(of: "\n[ \t]*\n", with: "\n\n", options: .regularExpression)
            .components(separatedBy: "\n\n").filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let pattern = format == "srt" ? "^([0-9]{2,}):([0-5][0-9]):([0-5][0-9]),([0-9]{3})$" : "^(?:([0-9]{2,}):)?([0-5][0-9]):([0-5][0-9])\\.([0-9]{3})$"
        let timestamp = try NSRegularExpression(pattern: pattern)
        let setting = try NSRegularExpression(pattern: "^[A-Za-z][A-Za-z0-9-]*:[^\\s]+$")
        func seconds(_ value: String) throws -> Double {
            let range = NSRange(value.startIndex..., in: value)
            guard let match = timestamp.firstMatch(in: value, range: range), match.range == range else { throw Failure.invalidSubtitles }
            func number(_ index: Int, fallback: Double = .nan) -> Double {
                guard let range = Range(match.range(at: index), in: value) else { return fallback }
                return Double(value[range]) ?? .nan
            }
            let time = number(1, fallback: 0) * 3600 + number(2) * 60 + number(3) + number(4) / 1000
            guard time.isFinite else { throw Failure.invalidSubtitles }
            return time
        }
        var count = 0, previous = -1.0
        for (index, block) in blocks.enumerated() {
            try Task.checkCancellation()
            let lines = block.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            guard let first = lines.first else { throw Failure.invalidSubtitles }
            if format == "vtt", index == 0 {
                guard first == "WEBVTT" || first.hasPrefix("WEBVTT ") || first.hasPrefix("WEBVTT\t"),
                      !lines.contains(where: { $0.contains("-->") }) else { throw Failure.invalidSubtitles }
                continue
            }
            if format == "vtt", first == "STYLE" || first == "REGION" || first == "NOTE" || first.hasPrefix("NOTE ") || first.hasPrefix("NOTE\t") {
                guard !lines.contains(where: { $0.contains("-->") }) else { throw Failure.invalidSubtitles }
                continue
            }
            let timingIndex = first.contains("-->") ? 0 : 1
            if timingIndex == 1, format == "srt" {
                guard first.range(of: "^[0-9]+$", options: .regularExpression) == first.startIndex..<first.endIndex,
                      let identifier = UInt(first), identifier > 0 else { throw Failure.invalidSubtitles }
            }
            guard lines.count > timingIndex + 1 else { throw Failure.invalidSubtitles }
            let timing = lines[timingIndex].components(separatedBy: "-->")
            guard timing.count == 2 else { throw Failure.invalidSubtitles }
            let from = try seconds(timing[0].trimmingCharacters(in: .whitespaces))
            let tail = timing[1].split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
            guard let finish = tail.first else { throw Failure.invalidSubtitles }
            let to = try seconds(finish)
            for token in tail.dropFirst() {
                let range = NSRange(token.startIndex..., in: token)
                guard setting.firstMatch(in: token, range: range)?.range == range else { throw Failure.invalidSubtitles }
            }
            let body = lines.dropFirst(timingIndex + 1).joined(separator: "\n")
            let plain = body.replacingOccurrences(of: "<[^>]*>", with: "", options: .regularExpression)
                .replacingOccurrences(of: "\\{\\\\[^}]*\\}", with: "", options: .regularExpression)
                .replacingOccurrences(of: "&nbsp;", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            guard from >= previous, to > from, to <= duration, !body.contains("-->"), !plain.isEmpty else { throw Failure.invalidSubtitles }
            previous = from; count += 1
            guard count <= 100_000 else { throw Failure.invalidSubtitles }
        }
        guard count > 0 else { throw Failure.invalidSubtitles }
        return count
    }
}
