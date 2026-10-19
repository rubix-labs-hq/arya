import Foundation

struct NativeFigmaImportCapture {
    private let backend: ObjectIdentifier?
    private let folder: String?

    init(backend: AnyObject?, folder: String?) {
        self.backend = backend.map(ObjectIdentifier.init); self.folder = folder
    }

    func matches(backend: AnyObject?, folder: String?, expectedVersion: Int?, currentVersion: Int) -> Bool {
        guard let backend, let expectedVersion, let source = self.backend else { return false }
        return source == ObjectIdentifier(backend) && self.folder == folder && expectedVersion == currentVersion
    }
}

struct NativeSelectionAIContext: Identifiable {
    let id = UUID()
    let label: String
    let refs: [String: Any]
    let suggestions: [String]
    let folder: String?
    private let projectCapture: NativeLibraryCapture

    func matches(project: [String: Any], folder: String?, version: Int) -> Bool {
        projectCapture.matches(project: project, folder: folder, version: version)
    }

    func references(intent: String) -> [String: Any]? {
        var result = refs
        result["intent"] = intent
        return Self.bounded(result) ? result : nil
    }

    static func make(project: [String: Any], clipID: String?, clipIDs: Set<String>? = nil, composition: String?, time: Double, version: Int? = nil, folder: String? = nil) -> NativeSelectionAIContext? {
        let comps = project["comps"] as? [String: Any] ?? [:]
        if let composition, !(comps[composition] is [String: Any]) { return nil }
        let canvas = composition.flatMap { comps[$0] as? [String: Any] } ?? project
        let tracks = canvas["tracks"] as? [[String: Any]] ?? []
        let clips = tracks.flatMap { $0["clips"] as? [[String: Any]] ?? [] }
        let selected = clipID.flatMap { id in clips.first { $0["id"] as? String == id } }
        if clipID != nil && selected == nil { return nil }
        let requestedIDs = clipIDs ?? Set(clipID.map { [$0] } ?? [])
        let selectedClips = clips.filter { requestedIDs.contains($0["id"] as? String ?? "") }
        guard selectedClips.count == requestedIDs.count else { return nil }
        guard !selectedClips.isEmpty || composition != nil && !clips.isEmpty else { return nil }
        var visited = Set<String>()
        var layers: [[String: Any]] = []
        func collect(_ clips: [[String: Any]], in scope: String) {
            for clip in clips {
                guard let id = clip["id"] as? String else { continue }
                var layer: [String: Any] = ["id": id, "composition": scope, "kind": clip["kind"] as? String ?? "", "name": name(clip)]
                if let node = figmaNode(clip) { layer["figmaNodeID"] = node }
                layers.append(layer)
                if clip["kind"] as? String == "comp", let nested = clip["comp"] as? String, !visited.contains(nested), let comp = comps[nested] as? [String: Any] {
                    visited.insert(nested)
                    collect((comp["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }, in: nested)
                }
            }
        }
        let root = composition ?? "main"
        if let composition { visited.insert(composition) }
        collect(selectedClips.isEmpty ? clips : selectedClips, in: root)
        let nativeIDs = layers.compactMap { $0["id"] as? String }
        let figmaIDs = Array(Set(layers.compactMap { $0["figmaNodeID"] as? String })).sorted()
        let scope = selectedClips.count == 1 ? selectedClips.first.flatMap { $0["kind"] as? String == "comp" ? $0["comp"] as? String : nil } ?? root : root
        var refs: [String: Any] = ["clip": selected?["id"] as? String ?? "", "clips": selectedClips.compactMap { $0["id"] as? String }, "composition": root, "time": time,
            "inputKind": "prompt", "editableNativeObjects": true,
            "sourceSelection": ["composition": scope, "nativeLayerIDs": nativeIDs, "figmaSourceNodeIDs": figmaIDs, "layers": layers],
            "preserveEditableGeometry": true, "preserveLayerHierarchy": true, "preserveFonts": true]
        if let version { refs["sourceProjectVersion"] = version }
        let label = selectedClips.count > 1 ? "\(selectedClips.count) selected layers" : selectedClips.first.map(name) ?? (canvas["name"] as? String ?? composition ?? "Composition")
        let titleCount = layers.filter { $0["kind"] as? String == "title" }.count
        var suggestions: [String] = []
        if let selected, selected["kind"] as? String != "audio" {
            suggestions.append("Add a brief, restrained fade to this layer. Choose timing that fits its duration and keep its final position.")
        }
        if titleCount > 0 {
            suggestions.append("Reveal the selected text with editable opacity and position keyframes. Keep the text, geometry and fonts.")
        }
        if layers.count > 1 {
            suggestions.append("Stagger these layers with subtle motion. Choose timing from the composition and preserve their hierarchy and final layout.")
        }
        guard bounded(refs) else { return nil }
        let capture = NativeLibraryCapture(project: project, selected: selected, composition: composition, folder: folder, version: version ?? -1)
        return NativeSelectionAIContext(label: label, refs: refs, suggestions: suggestions, folder: folder, projectCapture: capture)
    }

    static func figmaNode(_ clip: [String: Any]) -> String? {
        guard let note = clip["note"] as? String, note.hasPrefix("figma ") else { return nil }
        return note.dropFirst(6).split(whereSeparator: { $0.isWhitespace }).first.map(String.init)
    }

    static func importedCompositions(in project: [String: Any]) -> [String] {
        let comps = project["comps"] as? [String: Any] ?? [:]
        func imported(_ id: String, visited: Set<String>) -> Bool {
            guard !visited.contains(id), let comp = comps[id] as? [String: Any] else { return false }
            let clips = (comp["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }
            return clips.contains { clip in
                if figmaNode(clip) != nil { return true }
                guard clip["kind"] as? String == "comp", let nested = clip["comp"] as? String else { return false }
                return imported(nested, visited: visited.union([id]))
            }
        }
        return comps.keys.filter { imported($0, visited: []) }.sorted {
            let left = (comps[$0] as? [String: Any])?["name"] as? String ?? $0
            let right = (comps[$1] as? [String: Any])?["name"] as? String ?? $1
            return left == right ? $0 < $1 : left.localizedStandardCompare(right) == .orderedAscending
        }
    }

    private static func name(_ clip: [String: Any]) -> String {
        let title = clip["title"] as? [String: Any] ?? [:]
        return clip["label"] as? String ?? title["text"] as? String ?? clip["id"] as? String ?? "Layer"
    }

    private static func bounded(_ refs: [String: Any]) -> Bool {
        guard JSONSerialization.isValidJSONObject(refs), let bytes = try? JSONSerialization.data(withJSONObject: refs) else { return false }
        return bytes.count < 60_000
    }
}
