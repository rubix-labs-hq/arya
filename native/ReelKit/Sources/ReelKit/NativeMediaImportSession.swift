import Foundation
import CoreFoundation

/// Explicit browse metadata. These paths never authorize filesystem access.
public struct NativeMediaImportRoot: Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String

    public init(id: UUID = UUID(), name: String) throws {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf8.count <= 128, !name.contains("/"), !name.contains("\\"),
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }), name != ".", name != ".." else {
            throw NativeMediaImportSession.Failure("Name the imported root with up to 128 bytes and no slashes or control characters.")
        }
        self.id = id.uuidString.lowercased(); self.name = name
    }
}

public struct NativeMediaImportLocation: Equatable, Sendable {
    public static let metadataKey = "nativeImportLocation"
    public let root: NativeMediaImportRoot
    public let relativePath: String

    public init(root: NativeMediaImportRoot, relativePath: String) throws {
        try NativeMediaImportSession.validatePath(relativePath, allowEmpty: false)
        self.root = root; self.relativePath = relativePath
    }

    public var fields: [String: Any] {
        ["schema": 1, "rootID": root.id, "rootName": root.name, "relativePath": relativePath]
    }

    public static func read(asset: [String: Any]) -> Self? {
        guard let fields = asset[metadataKey] as? [String: Any],
              let schema = fields["schema"] as? NSNumber, CFGetTypeID(schema) != CFBooleanGetTypeID(), schema.doubleValue == 1,
              let id = fields["rootID"] as? String, let uuid = UUID(uuidString: id), id == uuid.uuidString.lowercased(),
              let name = fields["rootName"] as? String, let root = try? NativeMediaImportRoot(id: uuid, name: name), root.name == name,
              let path = fields["relativePath"] as? String else { return nil }
        return try? Self(root: root, relativePath: path)
    }

    /// Conflicting root names are not offered as a valid persistent root.
    public static func roots(assets: [String: Any]) -> [NativeMediaImportRoot] {
        var roots: [String: NativeMediaImportRoot] = [:]
        var conflicted = Set<String>()
        for value in assets.values {
            guard let asset = value as? [String: Any], let location = read(asset: asset) else { continue }
            if let old = roots[location.root.id], old != location.root { conflicted.insert(old.id) }
            roots[location.root.id] = location.root
        }
        return roots.values.filter { !conflicted.contains($0.id) }.sorted {
            $0.name == $1.name ? $0.id < $1.id : $0.name < $1.name
        }
    }
}

/// One bounded import batch. A saved root can be chosen again for later batches.
public struct NativeMediaImportSession: Sendable {
    public struct Failure: LocalizedError {
        public let message: String
        public init(_ message: String) { self.message = message }
        public var errorDescription: String? { message }
    }
    public static let maximumRoots = 128
    public let root: NativeMediaImportRoot
    public let subfolder: String
    public let expectedVersion: Int
    public let requiresExistingRoot: Bool

    public init(root: NativeMediaImportRoot, subfolder: String, expectedVersion: Int, requiresExistingRoot: Bool) throws {
        try Self.validatePath(subfolder, allowEmpty: true)
        guard expectedVersion >= 0, expectedVersion < Int.max else { throw Failure("Refresh the project before importing into a root.") }
        self.root = root; self.subfolder = subfolder; self.expectedVersion = expectedVersion
        self.requiresExistingRoot = requiresExistingRoot
    }

    public static func validatePath(_ path: String, allowEmpty: Bool) throws {
        if allowEmpty && path.isEmpty { return }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !path.isEmpty, path.utf8.count <= 8192, parts.count <= 64, !path.contains("\\"),
              !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw Failure("Use a relative subfolder path with no empty, dot, parent or control-character segments, within 64 levels and 8 KiB.")
        }
    }

    public func location(relativePath: String) throws -> NativeMediaImportLocation {
        try Self.validatePath(relativePath, allowEmpty: false)
        return try .init(root: root, relativePath: subfolder.isEmpty ? relativePath : subfolder + "/" + relativePath)
    }

    /// Called before any destination directory or copy is created.
    public func validate(assets: [String: Any], version: Int) throws {
        guard version == expectedVersion else { throw Failure("The project changed. Review the imported root and choose the batch again.") }
        let locations = assets.values.compactMap { value in
            (value as? [String: Any]).flatMap { NativeMediaImportLocation.read(asset: $0) }
        }
        let matching = locations.filter { $0.root.id == root.id }
        guard matching.allSatisfy({ $0.root == root }) else { throw Failure("The imported root name changed or conflicts with saved media. Choose its current root again.") }
        let roots = NativeMediaImportLocation.roots(assets: assets)
        if requiresExistingRoot {
            guard !matching.isEmpty else { throw Failure("That imported root no longer has registered media. Choose a current root or create a new one.") }
        } else {
            guard matching.isEmpty, roots.count < Self.maximumRoots,
                  !roots.contains(where: { $0.name == root.name }) else {
                throw Failure("Choose the existing imported root, or use a different name. A project supports up to 128 imported roots.")
            }
        }
    }

    public func existingPaths(assets: [String: Any]) -> Set<String> {
        Set(assets.values.compactMap { value in
            guard let asset = value as? [String: Any], let location = NativeMediaImportLocation.read(asset: asset), location.root == root else { return nil }
            return location.relativePath
        })
    }

    /// Attach a location only to an asset that the ordinary import has confirmed.
    static func attach(_ asset: JSON, location: NativeMediaImportLocation) throws -> JSON {
        guard var fields = try JSON.parse(asset.text) as? [String: Any] else { throw Failure("The media probe returned invalid asset metadata.") }
        fields[NativeMediaImportLocation.metadataKey] = location.fields
        return JSON(any: fields)
    }

    /// A receipt and the refreshed project must agree before the UI reports a root import.
    public func confirm(receiptAssets: [String: Any], projectAssets: [String: Any]) throws {
        for (id, value) in receiptAssets {
            guard let asset = value as? [String: Any], let saved = projectAssets[id] as? [String: Any],
                  let location = NativeMediaImportLocation.read(asset: asset), location.root == root,
                  subfolder.isEmpty || location.relativePath.hasPrefix(subfolder + "/"),
                  NativeMediaImportLocation.read(asset: saved) == location else {
                throw Failure("Media did not confirm this imported root and subfolder. Review the saved media before retrying.")
            }
        }
    }
}
