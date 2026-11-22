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
    /// The timeline the layers come from, by name, for the sheet. The references keep the ID.
    let scopeName: String
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
        let scopeName = scope == "main" ? "Main timeline" : (comps[scope] as? [String: Any])?["name"] as? String ?? "Composition"
        return NativeSelectionAIContext(label: label, scopeName: scopeName.isEmpty ? "Composition" : scopeName, refs: refs, suggestions: suggestions, folder: folder, projectCapture: capture)
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

/// A compact reference to the object under the menu, independent of later selection changes.
struct NativeAskAryaTarget {
    enum Kind: String { case clip, media, track, frame, grade, motion, audio, bus, deliver, marker }
    let kind: Kind
    let objectID: String
    let label: String
    var subtype = ""
    var details: [String: String] = [:]

    var icon: String {
        switch kind {
        case .clip, .media: return subtype == "audio" || subtype == "music" ? "waveform" : "film"
        case .track: return "rectangle.stack"
        case .frame: return "viewfinder"
        case .grade: return "camera.filters"
        case .motion: return "diamond"
        case .audio, .bus: return "waveform"
        case .deliver: return "square.and.arrow.up"
        case .marker: return "bookmark"
        }
    }

    var suggestions: [String] {
        switch kind {
        case .media:
            if subtype == "music" { return ["Place this cue on an audio track at the playhead.", "Fade this cue under the ending.", "Build a shorter variation from this cue’s saved score."] }
            if subtype == "audio" { return ["Insert this audio at the playhead.", "Place this source under the picture with a soft fade in.", "Measure this source’s integrated loudness."] }
            return ["Insert this source at the playhead and fit it to the canvas.", "Build an opening title over this source.", subtype == "image" ? "Place this still for four seconds with a slow push-in." : "Mark the scene cuts in this source."]
        case .bus: return ["Lower this bus by 3 dB.", "Check headroom on this bus and suggest a gain adjustment.", "Review the tracks routed to this bus."]
        case .track:
            if subtype == "audio" { return ["Lower this track by 3 dB.", "Pan this track to the center.", "Add short fades to the audio clips on this track."] }
            if subtype == "caption" { return ["Check these captions for timing overlaps.", "Break long captions into shorter cues.", "Tidy punctuation while preserving cue timing."] }
            return ["Close gaps on this track.", "Add a short dissolve between adjacent shots.", "Add a fade to the final shot on this track."]
        case .frame, .marker: return ["Add a title at this moment.", "Split the video clip under this frame.", "Add a marker describing this frame."]
        case .grade: return ["Warm the highlights on this grade node.", "Build a gentle S-curve on this node.", "Reduce saturation slightly while preserving contrast."]
        case .motion: return ["Ease the keyframes on this property.", "Slow down the entrance on this layer.", "Add a pair of editable keys for this property."]
        case .deliver: return ["Review this export’s frame rate and dimensions against the timeline.", "Suggest an export preset for a small review copy.", "Check the timeline range before exporting."]
        case .audio: return Self.audioSuggestions
        case .clip: break
        }
        switch subtype {
        case "title": return ["Animate this title in and out with editable keys.", "Improve title readability with tracking and shadow.", "Add a thin amber rule beneath this title."]
        case "shape": return ["Ease this shape into position.", "Add a contrasting stroke to this shape.", "Animate this shape’s opacity over its first half second."]
        case "caption": return ["Shorten this caption without changing its meaning.", "Split this caption at a natural phrase break.", "Check this cue’s timing against the dialogue."]
        case "audio": return Self.audioSuggestions
        case "comp": return ["Stagger entrances inside this composition.", "Fade this composition out over its last second.", "Add a slow push-in to this composition."]
        case "adjustment": return ["Add gentle contrast to this adjustment layer.", "Warm the underlying shots with this layer.", "Ease this adjustment layer’s opacity in and out."]
        case "color": return ["Change this solid to a warm charcoal.", "Fade this solid into the next shot.", "Place a centered title over this background."]
        case "image": return ["Add a slow push-in to this still.", "Fit this image to the canvas.", "Fade the still in and out."]
        default: return ["Grade this shot with subtle contrast and warmer highlights.", "Add an eased push-in from 100% to 108%.", "Fade this shot in and out smoothly."]
        }
    }

    private static let audioSuggestions = ["Normalize this clip to -14 LUFS.", "Add a 0.8-second fade in and a 1.2-second fade out.", "Reduce low-end rumble and lift vocal presence with EQ."]
}

struct AskAryaPinnedContext: Identifiable {
    struct ID: Hashable {
        let kind: NativeAskAryaTarget.Kind
        let object: String
        let composition: String?
        let details: [String: String]
    }
    let target: NativeAskAryaTarget
    let composition: String?
    let version: Int
    let generation: UUID
    var id: ID { ID(kind: target.kind, object: target.objectID, composition: composition, details: target.details) }
    var reference: [String: Any] {
        ["kind": target.kind.rawValue, "id": target.objectID, "label": String(target.label.prefix(160)),
         "subtype": target.subtype, "composition": composition as Any? ?? NSNull(),
         "details": target.details, "sourceProjectVersion": version]
    }
}
