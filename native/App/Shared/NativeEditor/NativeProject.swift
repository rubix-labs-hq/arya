import Foundation
import CoreFoundation
import ReelKit

/// Read-only projections of the shared JSON. All writes go through ReelKit operations.
struct NativeProject {
    let fields: [String: Any]
    var name: String { fields.string("name", "Untitled") }
    var width: Double { fields.number("width", 1920) }
    var height: Double { fields.number("height", 1080) }
    var fps: Double { fields.number("fps", 30) }
    var tracks: [NativeTrack] { fields.objects("tracks").map(NativeTrack.init) }
    var assets: [NativeAsset] { fields.dictionary("assets").map { NativeAsset(id: $0.key, fields: $0.value as? [String: Any] ?? [:]) }.sorted { $0.id < $1.id } }
    var compositions: [NativeComposition] { fields.dictionary("comps").map { NativeComposition(id: $0.key, fields: $0.value as? [String: Any] ?? [:]) }.sorted { $0.name < $1.name } }
    func tracks(in comp: String?) -> [NativeTrack] { comp.flatMap { fields.dictionary("comps")[$0] as? [String: Any] }?.objects("tracks").map(NativeTrack.init) ?? tracks }
    func markers(in comp: String?) -> [[String: Any]] {
        guard let comp else { return fields.objects("markers") }
        return (fields.dictionary("comps")[comp] as? [String: Any])?.objects("markers") ?? []
    }
    func duration(in comp: String?) -> Double {
        let end = tracks(in: comp).flatMap(\.clips).map(\.end).max() ?? 0
        if let comp, let fields = fields.dictionary("comps")[comp] as? [String: Any] { return max(end, fields.number("duration", 5)) }
        return end
    }
    func clip(_ id: String?) -> NativeClip? {
        guard let id else { return nil }
        return (tracks + compositions.flatMap(\.tracks)).flatMap(\.clips).first { $0.id == id }
    }
    var text: String { JSON(any: fields).text }
}

struct NativeTrack: Identifiable {
    let fields: [String: Any]
    var id: String { fields.string("id") }
    var name: String { fields.string("name", id) }
    var kind: String { fields.string("kind", "video") }
    var clips: [NativeClip] { fields.objects("clips").map(NativeClip.init) }
    var locked: Bool { fields.flag("locked") }
}

struct NativeClip: Identifiable {
    let fields: [String: Any]
    var id: String { fields.string("id") }
    var kind: String { fields.string("kind") }
    var start: Double { fields.number("start") }
    var duration: Double { fields.number("dur") }
    var end: Double { start + duration }
    var source: String { fields.string("src") }
    var name: String { fields.string("label", fields.dictionary("title").string("text", source.isEmpty ? kind.capitalized : (source as NSString).lastPathComponent)) }
    var nodes: [[String: Any]] { fields.dictionary("nodes").objects("list") }
}

struct NativeAsset: Identifiable {
    let id: String
    let fields: [String: Any]
    var name: String {
        let title = fields.string("name").trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? (id as NSString).lastPathComponent : title
    }
    var duration: Double { fields.number("duration") }
    var kind: String { fields.flag("still") ? "image" : fields.flag("hasVideo") ? "video" : fields.flag("hasAudio") ? "audio" : "image" }
}

struct NativeComposition: Identifiable {
    let id: String
    let fields: [String: Any]
    var name: String { fields.string("name", id) }
    var tracks: [NativeTrack] { fields.objects("tracks").map(NativeTrack.init) }
}

enum NativeProcessingRequests {
    static func video(clip: NativeClip, project: NativeProject?, fps: Double, comp: String?, options: [String: Any], version: Int? = nil) -> [String: Any] {
        var body: [String: Any] = ["src": clip.source, "in": clip.fields.number("in"), "dur": clip.duration * abs(clip.fields.number("speed", 1))]
        body.merge(options) { _, value in value }
        let sourceFPS = project?.assets.first(where: { $0.id == clip.source })?.fields.number("fps", fps) ?? fps
        body["fps"] = sourceFPS.isFinite && sourceFPS > 0 ? sourceFPS : fps
        body["id"] = clip.id; body["apply"] = true; body["wait"] = false
        body["comp"] = comp as Any? ?? NSNull()
        if let version { body["expectedVersion"] = version }
        return body
    }
    static func audio(clip: NativeClip, mode: String, quality: String, strength: Double, detail: Double, noise: ClosedRange<Double>? = nil, comp: String? = nil, version: Int? = nil) -> [String: Any] {
        var body: [String: Any] = ["src": clip.source, "id": clip.id, "comp": comp as Any? ?? NSNull(), "mode": mode, "quality": quality, "strength": strength, "detail": detail, "useOriginal": true]
        if let noise { body["noiseFrom"] = noise.lowerBound; body["noiseTo"] = noise.upperBound }
        if let version { body["expectedVersion"] = version }
        return body
    }
}

struct NativeAudioRequestCapture {
    let target: NativeInspectorWorkflow.Capture
    let contextID: UUID
    let selection: Set<String>
    let projectData: Data

    func request(route: String, options: [String: Any], capabilities: [String: Any]) throws -> [String: Any] {
        let analysis = capabilities.dictionary("analysis"), processing = capabilities.dictionary("processing")
        let targets = target.linked.filter { $0.dictionary("clip").string("id") == target.id }
        let unlocked = targets.count == 1 && !targets[0].dictionary("track").flag("locked")
        guard target.asset.flag("hasAudio") else { throw NativeInspectorWorkflow.Failure("The selected source has no audio track.") }
        var body = options
        switch route {
        case "/api/audio/clean":
            guard processing.flag("audioClean"), target.clip.string("kind") == "audio", unlocked else { throw NativeInspectorWorkflow.Failure("Choose an unlocked audio clip on a host with native cleanup.") }
            let request = try NativeAudioProcessing.CleanupRequest(body)
            let project = (try JSONSerialization.jsonObject(with: projectData)) as? [String: Any] ?? [:]
            let source = try NativeAudioProcessing.cleanupSource(clip: target.clip, assets: project.dictionary("assets"))
            try request.options.validate(duration: project.dictionary("assets").dictionary(source).number("duration"))
            body["useOriginal"] = true
            body["apply"] = true
        case "/api/audio/restore":
            guard target.clip.string("kind") == "audio", unlocked else { throw NativeInspectorWorkflow.Failure("Choose an unlocked cleaned audio clip.") }
            let project = (try JSONSerialization.jsonObject(with: projectData)) as? [String: Any] ?? [:]
            let source = try NativeAudioProcessing.cleanupSource(clip: target.clip, assets: project.dictionary("assets"))
            guard source != target.source else { throw NativeInspectorWorkflow.Failure("This clip has no applied cleanup recipe to restore.") }
            body["useOriginal"] = true; body["apply"] = true
        case "/api/audio/loudnorm":
            let level = body.number("target", -23), peak = body.number("tp", -1)
            guard analysis.flag("loudness"), unlocked, target.linear, level.isFinite, (-70...0).contains(level), peak.isFinite, (-24...0).contains(peak) else { throw NativeInspectorWorkflow.Failure("Normalization needs an unlocked forward clip, a valid LUFS target and peak ceiling.") }
            body["in"] = target.input; body["dur"] = target.duration * target.speed; body["apply"] = true
        case "/api/analyze":
            switch body.string("kind") {
            case "loudness":
                guard analysis.flag("loudness") else { throw NativeInspectorWorkflow.Failure("Source loudness analysis is unavailable on this host.") }
                body.removeValue(forKey: "in"); body.removeValue(forKey: "dur")
            case "audio-noise":
                guard analysis.flag("processingRecommendations"), target.linear else { throw NativeInspectorWorkflow.Failure("Noise measurement needs a forward source clip with positive scalar speed.") }
                body["in"] = target.input; body["dur"] = min(30, target.duration * target.speed)
            default: throw NativeInspectorWorkflow.Failure("Choose source loudness or audio noise measurement.")
            }
        default: throw NativeInspectorWorkflow.Failure("This audio action is unavailable.")
        }
        body["src"] = target.source; body["id"] = target.id; body["comp"] = target.composition as Any? ?? NSNull()
        body["expectedVersion"] = target.version; body["wait"] = false; body["uiCapture"] = target.record
        return body
    }

    func expectedProject(result: [String: Any], route: String) -> Data? {
        guard (route == "/api/audio/clean" ? result.flag("assetRegistered") : result.flag("applied")),
              var project = (try? JSONSerialization.jsonObject(with: projectData)) as? [String: Any] else { return nil }
        var scope = target.composition.map { project.dictionary("comps").dictionary($0) } ?? project
        var tracks = scope.objects("tracks")
        let matches = tracks.indices.flatMap { track in tracks[track].objects("clips").indices.filter { tracks[track].objects("clips")[$0].string("id") == target.id }.map { (track, $0) } }
        guard matches.count == 1, let (trackIndex, clipIndex) = matches.first else { return nil }
        var clips = tracks[trackIndex].objects("clips")
        if route == "/api/audio/clean" {
            guard let path = result["path"] as? String, !path.isEmpty, let asset = result["asset"] as? [String: Any],
                  let recipe = result["recipe"] as? [String: Any], recipe["output"] as? String == path,
                  recipe["source"] as? String == (try? NativeAudioProcessing.cleanupSource(clip: target.clip, assets: project.dictionary("assets"))),
                  recipe["version"] as? Int == 1 else { return nil }
            if result.flag("applied") { clips[clipIndex]["src"] = path; clips[clipIndex]["audioCleanup"] = recipe }
            var assets = project.dictionary("assets"); assets[path] = asset; project["assets"] = assets
        } else if route == "/api/audio/restore" {
            guard result.flag("restored"), let source = try? NativeAudioProcessing.cleanupSource(clip: target.clip, assets: project.dictionary("assets")), result["path"] as? String == source else { return nil }
            clips[clipIndex]["src"] = source; clips[clipIndex].removeValue(forKey: "audioCleanup")
        } else if route == "/api/audio/loudnorm", let gain = result["gain"] as? NSNumber, gain.doubleValue.isFinite {
            clips[clipIndex]["volume"] = gain
        } else { return nil }
        tracks[trackIndex]["clips"] = clips; scope["tracks"] = tracks
        if let composition = target.composition { var comps = project.dictionary("comps"); comps[composition] = scope; project["comps"] = comps }
        else { project["tracks"] = tracks }
        return NativeInspectorWorkflow.canonical(project)
    }
}

extension Dictionary where Key == String, Value == Any {
    func string(_ key: String, _ fallback: String = "") -> String { self[key] as? String ?? fallback }
    func number(_ key: String, _ fallback: Double = 0) -> Double { (self[key] as? NSNumber)?.doubleValue ?? fallback }
    func flag(_ key: String, _ fallback: Bool = false) -> Bool { self[key] as? Bool ?? fallback }
    func dictionary(_ key: String) -> [String: Any] { self[key] as? [String: Any] ?? [:] }
    func objects(_ key: String) -> [[String: Any]] { self[key] as? [[String: Any]] ?? [] }
}

func nativeTimecode(_ time: Double, fps: Double) -> String {
    let rate = max(1, Int(fps.rounded()))
    let frames = max(0, Int((time * fps).rounded()))
    let seconds = frames / rate
    return String(format: "%02d:%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60, frames % rate)
}

func nativeQuery(_ path: String, _ values: [String: String]) -> String {
    var components = URLComponents()
    components.path = path
    components.queryItems = values.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
    return components.string ?? path
}

// Foundation-only receipt helpers also run in the native receipt checks.
struct NativeChangeReceipt: Identifiable {
    struct Change {
        let property: String
        let before: String
        let after: String
        var fields: [String: Any] { ["property": property, "before": before, "after": after] }
    }
    struct Clip: Identifiable {
        let clipID: String
        let composition: String?
        let compositionName: String
        let name: String
        let status: String
        let changes: [Change]
        var id: String { "\(composition.map { "\($0.utf8.count):\($0)" } ?? "main"):\(clipID)" }
        var fields: [String: Any] {
            ["id": clipID, "comp": composition as Any? ?? NSNull(), "compositionName": compositionName,
             "name": name, "status": status, "changes": changes.map(\.fields)]
        }
    }
    struct Scope {
        let composition: String?
        let name: String
        let status: String
        let changes: [Change]
        let trackID: String?
        init(composition: String?, name: String, status: String, changes: [Change], trackID: String? = nil) {
            self.composition = composition; self.name = name; self.status = status; self.changes = changes; self.trackID = trackID
        }
        var fields: [String: Any] {
            ["comp": composition as Any? ?? NSNull(), "track": trackID as Any? ?? NSNull(), "name": name,
             "status": status, "changes": changes.map(\.fields)]
        }
    }
    struct Selection {
        let composition: String?
        let clipID: String
        let start: Double
    }

    static let maximumReceipts = 30
    static let maximumHistoryBytes = 4 * 1024 * 1024
    static let maximumReceiptBytes = 128 * 1024
    static let maximumClips = 80
    static let maximumChanges = 50
    static let maximumScopes = 80
    static let maximumPathBytes = 512
    static let maximumIdentifierBytes = 512
    static let maximumNameBytes = 160
    static let maximumPreviewBytes = 1024

    let version: Int
    let who: String
    let at: Double
    let totalClips: Int
    let totalScopes: Int
    let clips: [Clip]
    let scopes: [Scope]
    let truncated: Bool
    let displayJSON: String
    var id: Int { version }
    var displayBytes: Int { displayJSON.utf8.count }
    private static func assetChange(_ change: Change) -> Bool { change.property == "/assets" || change.property.hasPrefix("/assets/") }
    var hasAssetChanges: Bool { scopes.contains { $0.composition == nil && $0.trackID == nil && $0.changes.contains(where: Self.assetChange) } }
    var summary: String {
        var parts: [String] = []
        if totalClips > 0 { parts.append("\(totalClips) \(totalClips == 1 ? "object" : "objects") changed") }
        if hasAssetChanges { parts.append("Media assets changed") }
        let settings = scopes.contains { scope in
            scope.changes.contains { change in
                !(scope.composition == nil && scope.trackID == nil && Self.assetChange(change)) && change.property != "Object order"
            }
        }
        if settings && (totalClips == 0 || hasAssetChanges) { parts.append("Project or track settings changed") }
        return parts.isEmpty ? (truncated ? "Project changes" : "Project settings changed") : parts.joined(separator: " · ")
    }

    static func make(before: [String: Any]?, after: [String: Any], previousVersion: Int, version: Int,
                     who: String, at: Double = Date().timeIntervalSince1970 * 1000) -> Self? {
        guard let before, previousVersion >= 0, version > previousVersion, ["agent", "claude"].contains(who) else { return nil }
        let old = index(before), next = index(after)
        var clips: [Clip] = [], scopes: [Scope] = []
        var totalClips = 0, totalScopes = 0, truncated = false
        var remainingBytes = maximumReceiptBytes - 2048
        for key in old.order + next.order.filter({ old.clips[$0] == nil }) {
            let previous = old.clips[key], current = next.clips[key]
            if let previous, let current, same(previous.clip, current.clip), same(previous.track, current.track) { continue }
            totalClips += 1
            guard clips.count < maximumClips, validIdentifier(key.id), key.comp.map(validIdentifier) ?? true,
                  let source = current ?? previous else { truncated = true; continue }
            var differences = diff(previous?.clip, current?.clip)
            if let previous, let current, !same(previous.track, current.track) {
                let oldTrack = preview(previous.track), newTrack = preview(current.track)
                differences.changes.insert(Change(property: "/track", before: oldTrack.text, after: newTrack.text), at: 0)
                if differences.changes.count > maximumChanges { differences.changes.removeLast(); differences.truncated = true }
                differences.truncated = differences.truncated || oldTrack.truncated || newTrack.truncated
            }
            let name = bounded(source.clip["label"] as? String ?? (source.clip["title"] as? [String: Any])?["text"] as? String ?? key.id, bytes: maximumNameBytes)
            let compositionName = bounded(source.name, bytes: maximumNameBytes)
            let clip = Clip(clipID: key.id, composition: key.comp, compositionName: compositionName.text, name: name.text,
                            status: previous == nil ? "added" : current == nil ? "deleted" : "changed", changes: differences.changes)
            let bytes = encoded(clip.fields).utf8.count + 1
            guard bytes <= remainingBytes else { truncated = true; continue }
            clips.append(clip); remainingBytes -= bytes
            truncated = truncated || differences.truncated || name.truncated || compositionName.truncated
        }

        func appendScope(_ differences: Differences, composition: String?, name: String, status: String, trackID: String? = nil) {
            guard !differences.changes.isEmpty else { return }
            totalScopes += 1
            guard scopes.count < maximumScopes, composition.map(validIdentifier) ?? true,
                  trackID.map(validIdentifier) ?? true else { truncated = true; return }
            let name = bounded(name, bytes: maximumNameBytes)
            let scope = Scope(composition: composition, name: name.text, status: status, changes: differences.changes, trackID: trackID)
            let bytes = encoded(scope.fields).utf8.count + 1
            guard bytes <= remainingBytes else { truncated = true; return }
            scopes.append(scope); remainingBytes -= bytes
            truncated = truncated || differences.truncated || name.truncated
        }
        func appendOrder(_ before: [Any], _ after: [Any], property: String, to differences: inout Differences) {
            guard !same(before, after) else { return }
            guard differences.changes.count < maximumChanges else { differences.truncated = true; return }
            let previous = preview(before), current = preview(after)
            differences.changes.append(Change(property: property, before: previous.text, after: current.text))
            differences.truncated = differences.truncated || previous.truncated || current.truncated
        }
        let oldComps = before["comps"] as? [String: Any] ?? [:], newComps = after["comps"] as? [String: Any] ?? [:]
        let assetMaps = (before["assets"] == nil || before["assets"] is [String: Any]) && (after["assets"] == nil || after["assets"] is [String: Any])
        let compositionIDs = Set(oldComps.keys).union(newComps.keys).sorted()
        for comp in [String?](arrayLiteral: nil) + compositionIDs.map(Optional.some) {
            let previous = comp.flatMap { oldComps[$0] as? [String: Any] } ?? (comp == nil ? before : nil)
            let current = comp.flatMap { newComps[$0] as? [String: Any] } ?? (comp == nil ? after : nil)
            var differences: Differences
            if comp != nil && (previous == nil || current == nil) { differences = diff(previous, current, path: "/composition") }
            else {
                let excluded: Set<String> = comp == nil && assetMaps ? ["tracks", "comps", "assets"] : ["tracks", "comps"]
                differences = diff(metadata(previous, excluding: excluded), metadata(current, excluding: excluded))
            }
            let oldTracks = previous?["tracks"] as? [[String: Any]] ?? [], newTracks = current?["tracks"] as? [[String: Any]] ?? []
            appendOrder(oldTracks.map { $0["id"] ?? NSNull() }, newTracks.map { $0["id"] ?? NSNull() }, property: "Track order", to: &differences)
            let timelineName = comp == nil ? "Main timeline" : (current ?? previous)?["name"] as? String ?? comp ?? ""
            appendScope(differences, composition: comp, name: timelineName,
                        status: previous == nil ? "added" : current == nil ? "deleted" : "changed")
            var oldByID: [String: [String: Any]] = [:], newByID: [String: [String: Any]] = [:]
            for track in oldTracks { if let id = track["id"] as? String { oldByID[id] = track } }
            for track in newTracks { if let id = track["id"] as? String { newByID[id] = track } }
            for id in Set(oldByID.keys).union(newByID.keys).sorted() {
                let previous = oldByID[id], current = newByID[id]
                var changes = diff(metadata(previous, excluding: ["clips"]), metadata(current, excluding: ["clips"]))
                let oldClips = previous?["clips"] as? [[String: Any]] ?? [], newClips = current?["clips"] as? [[String: Any]] ?? []
                appendOrder(oldClips.map { $0["id"] ?? NSNull() }, newClips.map { $0["id"] ?? NSNull() }, property: "Object order", to: &changes)
                let trackName = (current ?? previous)?["name"] as? String ?? id
                appendScope(changes, composition: comp, name: "Track \(id) · \(trackName) · \(timelineName)",
                            status: previous == nil ? "added" : current == nil ? "deleted" : "changed", trackID: id)
            }
        }
        if assetMaps {
            let oldAssets = before["assets"] as? [String: Any] ?? [:], newAssets = after["assets"] as? [String: Any] ?? [:]
            for path in Set(oldAssets.keys).union(newAssets.keys).sorted() {
                let previous = oldAssets[path], current = newAssets[path]
                guard !same(previous, current) else { continue }
                let property = "/assets/" + pointer(path)
                guard (property + "/generated").utf8.count <= maximumPathBytes else { totalScopes += 1; truncated = true; continue }
                let oldFields = previous as? [String: Any], newFields = current as? [String: Any]
                var changes: Differences
                if (previous == nil || oldFields != nil) && (current == nil || newFields != nil) {
                    changes = diff(metadata(oldFields ?? [:], excluding: ["generated"]), metadata(newFields ?? [:], excluding: ["generated"]), path: property)
                    let oldGenerated = oldFields?["generated"], newGenerated = newFields?["generated"]
                    if !same(oldGenerated, newGenerated) {
                        var generated: Differences
                        if (oldGenerated == nil || oldGenerated is [String: Any]) && (newGenerated == nil || newGenerated is [String: Any]) {
                            generated = diff(oldGenerated as? [String: Any] ?? [:], newGenerated as? [String: Any] ?? [:], path: property + "/generated")
                        } else { generated = diff(oldGenerated, newGenerated, path: property + "/generated") }
                        if generated.changes.isEmpty { generated = diff(oldGenerated, newGenerated, path: property + "/generated") }
                        for change in generated.changes {
                            guard changes.changes.count < maximumChanges else { changes.truncated = true; break }
                            changes.changes.append(change)
                        }
                        changes.truncated = changes.truncated || generated.truncated
                    }
                    if changes.changes.isEmpty { changes = diff(previous, current, path: property) }
                } else { changes = diff(previous, current, path: property) }
                appendScope(changes, composition: nil, name: "Media asset · \(path)", status: previous == nil ? "added" : current == nil ? "deleted" : "changed")
            }
        }
        guard totalClips > 0 || totalScopes > 0 else { return nil }
        let timestamp = at.isFinite ? at : 0
        func display() -> String {
            encoded(["version": version, "who": who, "at": timestamp, "totalClips": totalClips, "totalScopes": totalScopes,
                     "clips": clips.map(\.fields), "scopes": scopes.map(\.fields), "truncated": truncated])
        }
        var json = display()
        while json.utf8.count > maximumReceiptBytes {
            truncated = true
            if !scopes.isEmpty { scopes.removeLast() }
            else if !clips.isEmpty { clips.removeLast() }
            else { return nil }
            json = display()
        }
        return Self(version: version, who: who, at: timestamp, totalClips: totalClips, totalScopes: totalScopes,
                    clips: clips, scopes: scopes, truncated: truncated, displayJSON: json)
    }

    static func appending(_ receipt: Self, to history: [Self]) -> [Self] {
        var result = Array((history + [receipt]).suffix(maximumReceipts))
        var bytes = result.reduce(0) { $0 + $1.displayBytes }
        while bytes > maximumHistoryBytes, !result.isEmpty { bytes -= result.removeFirst().displayBytes }
        return result
    }

    static func selection(for clip: Clip, in project: [String: Any]) -> Selection? {
        guard clip.status != "deleted" else { return nil }
        let timeline: [String: Any]?
        if let comp = clip.composition { timeline = (project["comps"] as? [String: Any])?[comp] as? [String: Any] }
        else { timeline = project }
        guard let timeline else { return nil }
        for track in timeline["tracks"] as? [[String: Any]] ?? [] {
            if let surviving = (track["clips"] as? [[String: Any]] ?? []).first(where: { $0["id"] as? String == clip.clipID }) {
                let start = (surviving["start"] as? NSNumber)?.doubleValue ?? 0
                return Selection(composition: clip.composition, clipID: clip.clipID, start: start.isFinite ? max(0, start) : 0)
            }
        }
        return nil
    }

    private struct Key: Hashable { let comp: String?; let id: String }
    private struct IndexedClip { let clip: [String: Any]; let track: String?; let name: String }
    private static func index(_ project: [String: Any]) -> (clips: [Key: IndexedClip], order: [Key]) {
        var result: [Key: IndexedClip] = [:], order: [Key] = []
        let comps = project["comps"] as? [String: Any] ?? [:]
        let timelines: [(String?, [String: Any])] = [(nil, project)] + comps.keys.sorted().compactMap { id in
            (comps[id] as? [String: Any]).map { (id, $0) }
        }
        for (comp, timeline) in timelines {
            for track in timeline["tracks"] as? [[String: Any]] ?? [] {
                for clip in track["clips"] as? [[String: Any]] ?? [] {
                    guard let id = clip["id"] as? String else { continue }
                    let key = Key(comp: comp, id: id)
                    if result[key] == nil { order.append(key) }
                    result[key] = IndexedClip(clip: clip, track: track["id"] as? String, name: comp == nil ? "Main timeline" : timeline["name"] as? String ?? comp ?? "")
                }
            }
        }
        return (result, order)
    }

    private struct Differences { var changes: [Change] = []; var truncated = false }
    private static func metadata(_ fields: [String: Any]?, excluding: Set<String>) -> [String: Any]? {
        fields.map { $0.filter { !excluding.contains($0.key) } }
    }
    private static func diff(_ before: Any?, _ after: Any?, path: String = "", depth: Int = 0) -> Differences {
        var result = Differences()
        func walk(_ before: Any?, _ after: Any?, path: String, depth: Int) {
            guard !same(before, after) else { return }
            guard result.changes.count < maximumChanges else { result.truncated = true; return }
            if depth < 8, let previous = before as? [String: Any], let current = after as? [String: Any] {
                let keys = Set(previous.keys).union(current.keys).sorted()
                if keys.contains(where: { (path + "/" + pointer($0)).utf8.count > maximumPathBytes }) {
                    result.truncated = true
                } else {
                    for key in keys { walk(previous[key], current[key], path: path + "/" + pointer(key), depth: depth + 1) }
                    return
                }
            }
            if depth >= 8, before is [String: Any], after is [String: Any] { result.truncated = true }
            let old = preview(before), next = preview(after)
            result.changes.append(Change(property: path.isEmpty ? "/layer" : path, before: old.text, after: next.text))
            result.truncated = result.truncated || old.truncated || next.truncated
        }
        walk(before, after, path: path, depth: depth)
        return result
    }
    private static func pointer(_ key: String) -> String { key.replacingOccurrences(of: "~", with: "~0").replacingOccurrences(of: "/", with: "~1") }
    private static func validIdentifier(_ value: String) -> Bool { !value.isEmpty && value.utf8.count <= maximumIdentifierBytes }
    private static func bounded(_ value: String, bytes: Int) -> (text: String, truncated: Bool) {
        guard value.utf8.count > bytes else { return (value, false) }
        var end = value.startIndex, count = 0
        while end < value.endIndex {
            let next = value.index(after: end), length = value[end..<next].utf8.count
            guard count + length <= bytes - 3 else { break }
            count += length; end = next
        }
        return (String(value[..<end]) + "…", true)
    }
    private static func preview(_ value: Any?) -> (text: String, truncated: Bool) {
        guard let value else { return ("Absent", false) }
        return bounded(encoded(value, pretty: false), bytes: maximumPreviewBytes)
    }
    private static func encoded(_ value: Any, pretty: Bool = true) -> String {
        let options: JSONSerialization.WritingOptions = pretty ? [.sortedKeys, .fragmentsAllowed, .prettyPrinted] : [.sortedKeys, .fragmentsAllowed]
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: options), let text = String(data: data, encoding: .utf8) else { return "null" }
        return text
    }
    private static func same(_ before: Any?, _ after: Any?) -> Bool {
        switch (before, after) {
        case (nil, nil): return true
        case (_ as NSNull, _ as NSNull): return true
        case let (before as String, after as String): return before == after
        case let (before as NSNumber, after as NSNumber):
            guard (CFGetTypeID(before) == CFBooleanGetTypeID()) == (CFGetTypeID(after) == CFBooleanGetTypeID()) else { return false }
            return before == after
        case let (before as [String: Any], after as [String: Any]):
            return before.count == after.count && before.allSatisfy { same($0.value, after[$0.key]) }
        case let (before as [Any], after as [Any]):
            return before.count == after.count && zip(before, after).allSatisfy { same($0, $1) }
        default: return false
        }
    }
}
