import Foundation

/// Recently opened project folders, kept as bookmarks so the app can reopen them later.
/// On macOS the bookmarks are security-scoped: a sandboxed app keeps access to a folder the
/// user picked once. On iOS they are the bookmarks Files hands out for picked folders.
enum ProjectBookmarks {
    struct Recent: Identifiable, Equatable {
        let id: String
        let name: String
        let path: String
        let data: Data
    }

    private static let key = "recentProjects"
    private static let limit = 12

    #if os(macOS)
    private static let createOptions: URL.BookmarkCreationOptions = [.withSecurityScope]
    private static let resolveOptions: URL.BookmarkResolutionOptions = [.withSecurityScope]
    #else
    private static let createOptions: URL.BookmarkCreationOptions = []
    private static let resolveOptions: URL.BookmarkResolutionOptions = []
    #endif

    static func load() -> [Recent] {
        let stored = UserDefaults.standard.array(forKey: key) as? [[String: Any]] ?? []
        return stored.compactMap { item in
            guard let data = item["bookmark"] as? Data, let path = item["path"] as? String else { return nil }
            return Recent(id: path, name: (path as NSString).lastPathComponent, path: path, data: data)
        }
    }

    /// Refresh reachable bookmarks. Keep unavailable storage until the user removes its entry.
    static func refresh() -> [Recent] {
        let loaded = load()
        let kept = surviving(loaded) { recent -> (url: URL, data: Data)? in
            var stale = false
            guard let url = try? URL(resolvingBookmarkData: recent.data, options: resolveOptions, relativeTo: nil, bookmarkDataIsStale: &stale) else {
                return nil
            }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
                return nil
            }
            if stale, let refreshed = try? url.bookmarkData(options: createOptions, includingResourceValuesForKeys: nil, relativeTo: nil) {
                return (url, refreshed)
            }
            return (url, recent.data)
        }
        if kept != loaded { save(kept) }
        return Array(kept.prefix(limit))
    }

    // BEGIN RECENT PROJECT SURVIVAL
    /// Refresh reachable folders after moves and retain unresolved bookmark bytes for retry.
    static func surviving(_ recents: [Recent], resolve: (Recent) -> (url: URL, data: Data)?) -> [Recent] {
        recents.map { recent in
            guard let resolved = resolve(recent) else { return recent }
            return Recent(id: resolved.url.path, name: resolved.url.lastPathComponent, path: resolved.url.path, data: resolved.data)
        }
    }
    // END RECENT PROJECT SURVIVAL

    private static func save(_ recents: [Recent]) {
        UserDefaults.standard.set(recents.prefix(limit).map { ["bookmark": $0.data, "path": $0.path] }, forKey: key)
    }

    /// Records a folder as most recent; returns the updated list.
    @discardableResult
    static func remember(_ url: URL) -> [Recent] {
        var recents = load().filter { $0.path != url.path }
        if let data = try? url.bookmarkData(options: createOptions, includingResourceValuesForKeys: nil, relativeTo: nil) {
            recents.insert(Recent(id: url.path, name: url.lastPathComponent, path: url.path, data: data), at: 0)
        }
        save(recents)
        return Array(recents.prefix(limit))
    }

    static func forget(_ recent: Recent) -> [Recent] {
        let recents = load().filter { $0.path != recent.path }
        save(recents)
        return recents
    }

    /// The folder a bookmark points to now (it follows moves and renames), or nil if gone.
    static func resolve(_ recent: Recent) -> URL? {
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: recent.data, options: resolveOptions, relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        if stale { remember(url) }
        return url
    }
}
