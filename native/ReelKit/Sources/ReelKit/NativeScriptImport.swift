import Foundation

/// Capture when the picker opens, before its callback can outlive the project or draft.
public struct NativeScriptImportContext: Equatable, Sendable {
    public let id: UUID
    private let contextID: UUID
    private let backendID: ObjectIdentifier
    private let folder: URL
    private let draft: String
    private let inputKind: String

    public init?(contextID: UUID, backendID: ObjectIdentifier?, folder: URL?, draft: String, inputKind: String) {
        guard let backendID, let folder else { return nil }
        id = UUID()
        self.contextID = contextID; self.backendID = backendID; self.folder = folder
        self.draft = draft; self.inputKind = inputKind
    }

    public func matches(requestID: UUID?, contextID: UUID, backendID: ObjectIdentifier?, folder: URL?, draft: String, inputKind: String) -> Bool {
        guard let backendID, let folder else { return false }
        return id == requestID && self.contextID == contextID && self.backendID == backendID && self.folder == folder && self.draft == draft && self.inputKind == inputKind
    }
}

public enum NativeScriptImport {
    public static let maximumBytes = 512 * 1024
    public static let maximumCharacters = 128_000

    public enum Failure: Error, LocalizedError {
        case fileTooLarge, invalidText
        public var errorDescription: String? {
            switch self {
            case .fileTooLarge: return "The script file must be smaller than 512 KB."
            case .invalidText: return "Use a UTF-8 script with no more than 128,000 characters."
            }
        }
    }

    /// Stale success and failure both return no text, before the caller can publish either.
    public static func read(_ result: Result<[URL], Error>, isCurrent: () -> Bool) throws -> String? {
        guard isCurrent() else { return nil }
        try Task.checkCancellation()
        do {
            let urls = try result.get()
            guard let url = urls.first else { return nil }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
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
            guard let text = String(data: bytes, encoding: .utf8), text.count <= maximumCharacters else { throw Failure.invalidText }
            guard isCurrent() else { return nil }
            try Task.checkCancellation()
            return text
        } catch {
            guard isCurrent() else { return nil }
            throw error
        }
    }
}
