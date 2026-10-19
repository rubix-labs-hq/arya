import Foundation

/// Browse registered source paths without moving files or changing project metadata.
public struct NativeMediaBrowser {
    public struct Source: Equatable {
        public let id: String
        public let name: String
        public let kind: String
        public let importLocation: NativeMediaImportLocation?

        public init(id: String, name: String, kind: String, importLocation: NativeMediaImportLocation? = nil) {
            self.id = id; self.name = name; self.kind = kind
            self.importLocation = importLocation
        }
    }

    public struct Folder: Identifiable, Equatable {
        public let path: String
        public let sourceCount: Int
        public var id: String { path }
        public var name: String { String(path.split(separator: "/").last ?? "") }
    }

    public let selectedFolder: String?
    public let selectedRootID: String?
    public let childFolders: [Folder]
    public let visibleIDs: Set<String>
    public let isSearching: Bool

    public init(sources: [Source], selectedFolder: String?, query: String, kind: String, rootID: String? = nil) {
        let activeRoot = rootID.flatMap { id -> String? in
            let matching = sources.compactMap(\.importLocation).map(\.root).filter { $0.id == id }
            guard let first = matching.first, matching.allSatisfy({ $0 == first }) else { return nil }
            return id
        }
        selectedRootID = activeRoot
        var unique: [Source] = []
        var seen = Set<String>()
        for source in sources where (activeRoot == nil || source.importLocation?.root.id == activeRoot) && seen.insert(source.id).inserted { unique.append(source) }
        let paths = unique.map { activeRoot == nil ? $0.id : $0.importLocation!.relativePath }
        let parents = paths.map { Self.parentPath(of: $0) }
        var counts: [String: Int] = [:]
        for parent in parents.compactMap({ $0 }) {
            let parts = parent.split(separator: "/")
            for end in 1...parts.count {
                counts[parts.prefix(end).joined(separator: "/"), default: 0] += 1
            }
        }
        let selected = selectedFolder.flatMap { counts[$0] == nil ? nil : $0 }
        self.selectedFolder = selected
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        isSearching = !search.isEmpty
        childFolders = search.isEmpty ? counts.keys.filter { Self.parentPath(of: $0) == selected }
            .sorted().map { Folder(path: $0, sourceCount: counts[$0] ?? 0) } : []
        var visible = Set<String>()
        for (index, source) in unique.enumerated() {
            let parent = parents[index]
            if let selected {
                guard parent == selected || (!search.isEmpty && parent?.hasPrefix(selected + "/") == true) else { continue }
            }
            guard kind == "All" || source.kind.capitalized == kind else { continue }
            guard search.isEmpty || source.name.localizedCaseInsensitiveContains(search) || source.id.localizedCaseInsensitiveContains(search) || paths[index].localizedCaseInsensitiveContains(search) else { continue }
            visible.insert(source.id)
        }
        visibleIDs = visible
    }

    /// Invalid or absolute source IDs remain visible in All media, without invented folders.
    public static func parentPath(of path: String) -> String? {
        guard !path.isEmpty, path.utf8.count <= 8192, !path.hasPrefix("/"), !path.contains("\0") else { return nil }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count <= 65, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return nil }
        guard parts.count > 1 else { return nil }
        return parts.dropLast().joined(separator: "/")
    }
}

/// Keep preselection guidance tied to the backend's retained-source bounds.
public enum NativeMediaImportLimits {
    public static var filesPerBatch: Int { NativeMediaImportSource.maximumRetainedFiles }
    public static var bytesPerBatch: Int64 { NativeMediaImportSource.maximumBytes }
    public static var byteLimitLabel: String {
        ByteCountFormatter.string(fromByteCount: bytesPerBatch, countStyle: .binary)
    }
    public static func acceptsFileSelection(count: Int) -> Bool { (1...filesPerBatch).contains(count) }
}
