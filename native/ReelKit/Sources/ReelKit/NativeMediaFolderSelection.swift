import Foundation

/// A bounded media-only walk of a user-selected folder. Never follows symbolic links.
/// Security-scoped access belongs to the picker/session for the whole copy + probe batch.
enum NativeMediaFolderSelection {
    struct Item { let url: URL; let relativePath: String; let identity: NativeMediaImportSource.Stamp; let rootIdentity: NativeMediaImportSource.DirectoryStamp }
    struct Issue { let path: String; let error: Error }
    struct Selection { let root: URL; var items: [Item]; var issues: [Issue] }
    struct InvalidSelection: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    static let maximumEntries = 10_000
    static let maximumDepth = 32

    /// Foundation's enumerator may spell a system temporary path with /private while
    /// its root URL uses /var. Standardize both URLs before comparing complete components.
    /// Never slice raw URL.path by a count from a differently normalized root.
    static func relativePath(_ url: URL, root: URL) throws -> String {
        let base = root.standardizedFileURL.pathComponents
        let child = url.standardizedFileURL.pathComponents
        guard child.count > base.count, Array(child.prefix(base.count)) == base else {
            throw InvalidSelection(message: "The selected item is outside its media folder.")
        }
        let remainder = child.dropFirst(base.count)
        guard remainder.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw InvalidSelection(message: "The selected media has an invalid relative path.")
        }
        return remainder.joined(separator: "/")
    }

    static func collect(_ selected: URL, project: ProjectFolder, allowProjectRoot: Bool = false,
                        maximumEntries: Int = NativeMediaFolderSelection.maximumEntries, maximumDepth: Int = NativeMediaFolderSelection.maximumDepth) throws -> Selection {
        try Task.checkCancellation()
        let attributes = try FileManager.default.attributesOfItem(atPath: selected.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory else {
            throw InvalidSelection(message: "Choose a regular folder. Symbolic links are not imported.")
        }
        guard try selected.resourceValues(forKeys: [.isPackageKey]).isPackage != true else {
            throw InvalidSelection(message: "Choose a media folder rather than an app or document package.")
        }
        let root = selected.standardizedFileURL.resolvingSymlinksInPath().standardizedFileURL
        let rootParts = root.pathComponents, projectParts = project.root.standardizedFileURL.pathComponents
        // A copy selection must never contain this batch's own newly copied files.
        // The confined API import route can read the project root without copying it.
        let projectIsSelection = projectParts == rootParts
        let projectIsDescendant = projectParts.count > rootParts.count && Array(projectParts.prefix(rootParts.count)) == rootParts
        guard (allowProjectRoot && projectIsSelection) || (!projectIsSelection && !projectIsDescendant) else {
            throw InvalidSelection(message: "Choose a media folder, rather than this project folder or one of its parent folders.")
        }
        let rootIdentity = try NativeMediaImportSource.directoryIdentity(selected)
        var selection = Selection(root: root, items: [], issues: [])
        guard let walker = FileManager.default.enumerator(at: root,
            includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .isPackageKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants], errorHandler: { url, error in
                selection.issues.append(Issue(path: (try? relativePath(url, root: root)) ?? url.lastPathComponent, error: error))
                return !Task.isCancelled
            }) else { throw InvalidSelection(message: "This folder could not be read.") }
        var entries = 0
        for case let url as URL in walker {
            try Task.checkCancellation()
            entries += 1
            guard entries <= maximumEntries else {
                selection.issues.append(Issue(path: root.lastPathComponent,
                    error: InvalidSelection(message: "Folder import stopped after \(maximumEntries) entries. Import smaller subfolders to include the remaining media.")))
                break
            }
            let lexical = url.standardizedFileURL
            var path = url.lastPathComponent
            do {
                path = try relativePath(lexical, root: root)
                let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .isPackageKey])
                if values.isSymbolicLink == true || lexical.resolvingSymlinksInPath().standardizedFileURL.pathComponents != lexical.pathComponents {
                    // FileManager's enumerator does not descend into symbolic links.
                    // skipDescendants() on a link can suppress the NEXT real directory's
                    // children instead, silently dropping unrelated organized footage.
                    throw InvalidSelection(message: "Symbolic links are not imported. Select the original media folder or file instead.")
                }
                if values.isPackage == true { walker.skipDescendants(); continue }
                if values.isDirectory == true {
                    if path.split(separator: "/").count >= maximumDepth {
                        walker.skipDescendants()
                        throw InvalidSelection(message: "Folder depth exceeds \(maximumDepth) levels. Select this subfolder separately.")
                    }
                    continue
                }
                if values.isRegularFile == true && ProjectFolder.isMedia(url.lastPathComponent) {
                    selection.items.append(Item(url: lexical, relativePath: path, identity: try NativeMediaImportSource.selectedStamp(lexical), rootIdentity: rootIdentity))
                }
            } catch {
                if error is CancellationError { throw error }
                selection.issues.append(Issue(path: path, error: error))
            }
        }
        try Task.checkCancellation()
        selection.items.sort { $0.relativePath < $1.relativePath }
        return selection
    }

    /// Recheck each source immediately before copying. Existing aliases/links are refused;
    /// this is not a transaction against an external provider changing its namespace.
    static func validate(_ item: Item, root: URL) throws {
        try Task.checkCancellation()
        guard try NativeMediaImportSource.directoryIdentity(root) == item.rootIdentity,
              try NativeMediaImportSource.selectedStamp(item.url) == item.identity else {
            throw InvalidSelection(message: "The selected media folder or file changed during import. Select it again.")
        }
        let lexical = item.url.standardizedFileURL
        guard try relativePath(lexical, root: root) == item.relativePath,
              lexical.resolvingSymlinksInPath().standardizedFileURL.pathComponents == lexical.pathComponents,
              try FileManager.default.attributesOfItem(atPath: root.standardizedFileURL.path)[.type] as? FileAttributeType == .typeDirectory,
              try FileManager.default.attributesOfItem(atPath: lexical.path)[.type] as? FileAttributeType == .typeRegular else {
            throw InvalidSelection(message: "The selected media changed or uses a symbolic link. Select its original file to retry.")
        }
    }
}
