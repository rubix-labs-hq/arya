import Foundation
import CoreFoundation
import ImageIO
import SwiftUI
#if os(macOS)
import AppKit
#endif

// BEGIN TRACK STATUS
struct NativeTrackStatus {
    struct Item: Equatable {
        let name: String
        let symbol: String
    }

    static func items(muted: Bool, solo: Bool, locked: Bool, hidden: Bool) -> [Item] {
        var result: [Item] = []
        if muted { result.append(Item(name: "Muted", symbol: "speaker.slash.fill")) }
        if solo { result.append(Item(name: "Solo", symbol: "headphones")) }
        if locked { result.append(Item(name: "Locked", symbol: "lock.fill")) }
        if hidden { result.append(Item(name: "Hidden", symbol: "eye.slash.fill")) }
        return result
    }

    static func accessibilityValue(_ items: [Item]) -> String {
        items.isEmpty ? "Normal" : items.map(\.name).joined(separator: ", ")
    }
}
// END TRACK STATUS

// BEGIN TIMELINE RANGE MARKS
/// Preserve the selected timeline's opposite endpoint; never seed composition marks from main marks.
enum NativeTimelineRangeMarks {
    static func operation(_ action: String, fields: [String: Any], composition: String?, time: Double, duration: Double, fps: Double) -> [String: Any]? {
        let scope: [String: Any]
        if let composition {
            guard let selected = (fields["comps"] as? [String: Any])?[composition] as? [String: Any] else { return nil }
            scope = selected
        } else { scope = fields }
        if action == "clear" { return ["op": "range", "in": NSNull()] }
        guard time.isFinite, duration.isFinite, fps.isFinite, fps > 0, duration >= 1 / fps else { return nil }
        let frame = 1 / fps, at = min(duration, max(0, time))
        let marks = scope["range"] as? [String: Any] ?? [:]
        func endpoint(_ key: String, fallback: Double) -> Double {
            guard let number = marks[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return fallback }
            return min(duration, max(0, number.doubleValue))
        }
        if action == "start" {
            let start = min(at, duration - frame)
            return ["op": "range", "in": start, "out": max(start + frame, endpoint("out", fallback: duration))]
        }
        if action == "end" {
            let end = max(frame, at)
            return ["op": "range", "in": min(end - frame, endpoint("in", fallback: 0)), "out": end]
        }
        return nil
    }
}
// END TIMELINE RANGE MARKS

// BEGIN MANUAL MARKER EDITING
/// Main and each composition keep their own markers. A missing composition has no fallback.
enum NativeTimelineMarkerEditing {
    static let maximumFrame: Int64 = 9_000_000_000

    static func scope(_ fields: [String: Any], composition: String?) -> [String: Any]? {
        guard let composition else { return fields }
        return (fields["comps"] as? [String: Any])?[composition] as? [String: Any]
    }
    static func markers(_ fields: [String: Any], composition: String?) -> [[String: Any]] {
        scope(fields, composition: composition)?["markers"] as? [[String: Any]] ?? []
    }
    static func number(_ fields: [String: Any], _ key: String, fallback: Double = .nan) -> Double {
        guard let value = fields[key] else { return fallback }
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite else { return .nan }
        return number.doubleValue
    }
    static func frame(_ time: Double, fps: Double) -> Int64? {
        guard time.isFinite, time >= 0, fps.isFinite, fps > 0, fps <= 1000,
              (time * fps).isFinite, time * fps <= Double(maximumFrame) else { return nil }
        return Int64((time * fps).rounded())
    }
    static func time(_ frame: Int64, fps: Double) -> Double? {
        guard frame >= 0, frame <= maximumFrame, fps.isFinite, fps > 0, fps <= 1000 else { return nil }
        let seconds = Double(frame) / fps
        guard seconds.isFinite, (seconds * 100_000).isFinite else { return nil }
        let snapped = (seconds * 100_000).rounded() / 100_000
        guard Self.frame(snapped, fps: fps) == frame else { return nil }
        return snapped
    }
    static func parseFrame(_ text: String, fps: Double) -> Int64? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.allSatisfy({ $0 >= "0" && $0 <= "9" }),
              let value = Int64(text), time(value, fps: fps) != nil else { return nil }
        return value
    }
    static func state(_ fields: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(fields) else { return nil }
        return try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    }
    static func same(_ lhs: [String: Any], _ rhs: [String: Any]) -> Bool {
        guard let encoded = state(lhs) else { return false }
        return state(rhs) == encoded
    }
}

@MainActor
struct NativeTimelineMarkerCapture: Identifiable {
    let id = UUID()
    let revision: UUID
    let context: UUID
    let backend: ObjectIdentifier
    let folder: String
    let composition: String?
    let version: Int
    let fps: Double
    let markerID: String?
    let marker: [String: Any]?
    let markers: [[String: Any]]
    let initialFrame: Int64
    let initialLabel: String

    init?(model: NativeEditorModel, markerID: String? = nil) {
        guard let folder = model.folder?.standardizedFileURL.path, let backend = model.renderPreviewBackendID, let fields = model.project?.fields,
              let scope = NativeTimelineMarkerEditing.scope(fields, composition: model.composition),
              !model.busy, !model.showingSource, model.projectReadOnlyReason == nil, model.version >= 0, model.version < 9_000_000_000_000_000 else { return nil }
        let markers = scope.objects("markers")
        let ids = markers.compactMap { $0["id"] as? String }
        guard ids.count == markers.count, Set(ids).count == ids.count, !ids.contains(""),
              markers.allSatisfy({ NativeTimelineMarkerEditing.state($0) != nil }) else { return nil }
        let marker = markerID.flatMap { target in markers.first { $0["id"] as? String == target } }
        if markerID != nil && marker == nil { return nil }
        let time = marker.map { NativeTimelineMarkerEditing.number($0, "t") } ?? model.time
        let fps = NativeTimelineMarkerEditing.number(scope, "fps", fallback: NativeTimelineMarkerEditing.number(fields, "fps", fallback: 30))
        guard let frame = NativeTimelineMarkerEditing.frame(time, fps: fps),
              NativeTimelineMarkerEditing.time(frame, fps: fps) != nil else { return nil }
        revision = model.audioProjectRevision
        context = model.processingContextID; self.backend = backend; self.folder = folder; composition = model.composition
        version = model.version; self.fps = fps; self.markerID = markerID; self.marker = marker
        self.markers = markers; initialFrame = frame; initialLabel = marker?.string("label") ?? "Marker"
    }

    func ownsScope(model: NativeEditorModel) -> Bool {
        guard let backend = model.renderPreviewBackendID else { return false }
        return model.processingContextID == context && backend == self.backend &&
            model.folder?.standardizedFileURL.path == folder && model.composition == composition
    }
    func matches(model: NativeEditorModel) -> Bool {
        guard ownsScope(model: model), model.audioProjectRevision == revision, model.version == version, !model.busy, !model.showingSource,
              model.projectReadOnlyReason == nil, let fields = model.project?.fields,
              let scope = NativeTimelineMarkerEditing.scope(fields, composition: composition),
              NativeTimelineMarkerEditing.number(scope, "fps", fallback: NativeTimelineMarkerEditing.number(fields, "fps", fallback: 30)) == fps else { return false }
        let current = scope.objects("markers")
        guard current.count == markers.count else { return false }
        return markers.allSatisfy { original in
            let matches = current.filter { $0["id"] as? String == original["id"] as? String }
            return matches.count == 1 && NativeTimelineMarkerEditing.same(original, matches[0])
        }
    }
    func operation(label: String, frameText: String, deleting: Bool = false) -> [String: Any]? {
        if deleting { return markerID.map { ["op": "delete_marker", "id": $0] } }
        guard let frame = NativeTimelineMarkerEditing.parseFrame(frameText, fps: fps),
              let time = NativeTimelineMarkerEditing.time(frame, fps: fps) else { return nil }
        guard let markerID else { return ["op": "marker", "label": label, "t": time] }
        var set: [String: Any] = [:]
        if label != initialLabel { set["label"] = label }
        // A label-only edit preserves an imported marker's original off-frame time.
        if frame != initialFrame { set["t"] = time }
        return set.isEmpty ? nil : ["op": "update_marker", "id": markerID, "set": set]
    }
    func confirmed(_ reply: [String: Any], operation: [String: Any]) -> Bool {
        guard let version = reply["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
              version.doubleValue == Double(self.version) + 1, let fields = reply["project"] as? [String: Any],
              let scope = NativeTimelineMarkerEditing.scope(fields, composition: composition),
              NativeTimelineMarkerEditing.number(scope, "fps", fallback: NativeTimelineMarkerEditing.number(fields, "fps", fallback: 30)) == fps else { return false }
        let current = scope.objects("markers"), ids = current.compactMap { $0["id"] as? String }
        guard ids.count == current.count, Set(ids).count == ids.count, !ids.contains("") else { return false }
        for original in markers where original["id"] as? String != markerID {
            guard let next = current.first(where: { $0["id"] as? String == original["id"] as? String }),
                  NativeTimelineMarkerEditing.same(original, next) else { return false }
        }
        switch operation["op"] as? String {
        case "marker":
            let oldIDs = Set(markers.compactMap { $0["id"] as? String })
            let added = current.filter { !oldIDs.contains($0.string("id")) }
            guard current.count == markers.count + 1, added.count == 1 else { return false }
            return added[0]["label"] as? String == operation["label"] as? String &&
                NativeTimelineMarkerEditing.number(added[0], "t") == (operation["t"] as? NSNumber)?.doubleValue
        case "update_marker":
            guard current.count == markers.count, let markerID, var expected = marker,
                  let set = operation["set"] as? [String: Any],
                  let next = current.first(where: { $0["id"] as? String == markerID }) else { return false }
            for (key, value) in set { expected[key] = value }
            return NativeTimelineMarkerEditing.same(expected, next)
        case "delete_marker":
            guard let markerID else { return false }
            return current.count == markers.count - 1 && !ids.contains(markerID)
        default: return false
        }
    }
}
// END MANUAL MARKER EDITING

// BEGIN TRACK DELETION CONTROLLER
/// A menu can outlive its project revision or target. Validate its capture again at dispatch.
@MainActor
struct NativeTrackDeletion {
    let context: UUID
    let folder: String
    let composition: String?
    let version: Int
    let projectFields: [String: Any]
    let targetID: String
    let targetFields: [String: Any]
    let capturedCurrentFields: [String: Any]

    private static func state(_ fields: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(fields) else { return nil }
        return try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    }

    init?(track: NativeTrack, model: NativeEditorModel) {
        let tracks = model.tracks
        guard let folder = model.folder?.standardizedFileURL.path, let project = model.project,
              model.version >= 0, let current = tracks.first(where: { $0.id == track.id }),
              !current.locked, tracks.filter({ $0.kind == current.kind }).count > 1 else { return nil }
        context = model.processingContextID; self.folder = folder; composition = model.composition
        version = model.version; projectFields = project.fields
        targetID = track.id; targetFields = track.fields; capturedCurrentFields = current.fields
        // Read-only JSON projections retain their value snapshots without walking clips/media.
        // Headers rebuild during playback; defer canonical encoding until the delete action.
    }

    @discardableResult
    func delete(model: NativeEditorModel) -> Bool {
        guard model.processingContextID == context, model.folder?.standardizedFileURL.path == folder,
              model.composition == composition, model.version == version,
              let project = model.project,
              let current = model.tracks.first(where: { $0.id == targetID }), !current.locked,
              model.tracks.filter({ $0.kind == current.kind }).count > 1,
              let projectState = Self.state(projectFields), Self.state(project.fields) == projectState,
              let targetState = Self.state(targetFields),
              Self.state(capturedCurrentFields) == targetState, Self.state(current.fields) == targetState else {
            model.status = "This track or project changed. Open its menu again before deleting it."
            return false
        }
        model.edit(["op": "delete_track", "id": current.id], expectedVersion: version)
        return true
    }
}
// END TRACK DELETION CONTROLLER

// BEGIN TIMELINE PLANNING
enum NativeTimelineMode: String, CaseIterable {
    case move = "Move", trim = "Trim", ripple = "Ripple trim", roll = "Roll", slip = "Slip", slide = "Slide"
    var hint: String {
        switch self {
        case .move: return "Drag selected clips. Drag vertically to another track of the same kind."
        case .trim: return "Drag the primary clip's left or right edge."
        case .ripple: return "Drag an edge to trim and shift later clips on affected tracks."
        case .roll: return "Drag an edge shared by adjacent clips to move their cut."
        case .slip: return "Drag the primary clip to change its source window."
        case .slide: return "Drag the primary clip between adjacent neighbors."
        }
    }
}

enum NativeTimelinePlanning {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
        init(_ message: String) { self.message = message }
    }
    static func destination(rows: [String], source: String, verticalDelta: Double, rowHeight: Double) throws -> String {
        guard verticalDelta.isFinite, abs(verticalDelta) < 1_000_000, rowHeight.isFinite, rowHeight > 0,
              let index = rows.firstIndex(of: source) else { throw Failure("The timeline gesture has invalid track geometry.") }
        let position = Double(index) + (verticalDelta / rowHeight).rounded()
        guard position >= 0, position < Double(rows.count) else { throw Failure("Drag onto an unlocked track of the same kind.") }
        return rows[Int(position)]
    }
    static func marquee(tracks: [[String: Any]], x0: Double, x1: Double, y0: Double, y1: Double, zoom: Double, rowHeight: Double) -> Set<String> {
        guard [x0, x1, y0, y1, zoom, rowHeight].allSatisfy(\.isFinite), zoom > 0, rowHeight > 0 else { return [] }
        let from = min(x0, x1) / zoom, to = max(x0, x1) / zoom
        var ids = Set<String>()
        for (index, track) in tracks.enumerated() {
            let top = 29 + Double(index) * rowHeight
            guard top < max(y0, y1), top + rowHeight > min(y0, y1) else { continue }
            for clip in track["clips"] as? [[String: Any]] ?? [] {
                let start = (clip["start"] as? NSNumber)?.doubleValue ?? 0, duration = (clip["dur"] as? NSNumber)?.doubleValue ?? 0
                if start < to, start + duration > from, let id = clip["id"] as? String { ids.insert(id) }
            }
        }
        return ids
    }
    static func imageAllowed(width: Double, height: Double) -> Bool {
        width.isFinite && height.isFinite && width >= 1 && height >= 1 && width * height <= 16_000_000
    }
    static func thumbnailPlan(imageWidth: Int, imageHeight: Int, width: Double, count: Double, interval: Double) -> (width: Int, count: Int, interval: Double)? {
        guard imageAllowed(width: Double(imageWidth), height: Double(imageHeight)), width.isFinite, count.isFinite, interval.isFinite,
              width >= 1, width.rounded() == width, width <= Double(imageWidth), count >= 1, count <= 100_000, interval >= 0 else { return nil }
        let tileWidth = Int(width)
        return (tileWidth, min(180, min(Int(count), imageWidth / tileWidth)), max(0.001, interval))
    }
    struct Clip {
        let fields: [String: Any]
        let track: String
        let trackKind: String
        let locked: Bool
        var id: String { fields["id"] as? String ?? "" }
        var link: String { fields["link"] as? String ?? "" }
        var start: Double { number("start") }
        var duration: Double { number("dur") }
        var end: Double { start + duration }
        var speed: Double { number("speed", 1) }
        var input: Double { number("in") }
        func number(_ key: String, _ fallback: Double = 0) -> Double { (fields[key] as? NSNumber)?.doubleValue ?? fallback }
    }
    struct Plan {
        let operations: [[String: Any]]
        let offsets: [String: Double]
        let targetTrack: String?
        let snapLine: Double?
        let detail: String
        let clipFields: [String: [String: Double]]
        init(operations: [[String: Any]], offsets: [String: Double], targetTrack: String?, snapLine: Double?, detail: String, clipFields: [String: [String: Double]] = [:]) {
            self.operations = operations; self.offsets = offsets; self.targetTrack = targetTrack; self.snapLine = snapLine; self.detail = detail; self.clipFields = clipFields
        }
    }
    struct Capture {
        let fields: [String: Any]
        let state: Data
        let folder: String
        let composition: String?
        let version: Int
        let selected: Set<String>
        let primary: String?
        let lead: String
        let zoom: Double
        let time: Double
        let snapping: Bool
        let tracks: [[String: Any]]
        let clips: [Clip]
        let fps: Double
        let minimumDuration: Double
        let rangeMarks: [String: Any]?

        init(fields: [String: Any], folder: String, composition: String?, version: Int, selected: Set<String>, primary: String?, lead: String, zoom: Double, time: Double, snapping: Bool) throws {
            self.fields = fields; self.folder = folder; self.composition = composition; self.version = version
            self.selected = selected; self.primary = primary; self.lead = lead; self.zoom = zoom; self.time = time; self.snapping = snapping
            guard !folder.isEmpty, zoom.isFinite, zoom > 0, time.isFinite,
                  JSONSerialization.isValidJSONObject(fields) else { throw Failure("The timeline has invalid geometry or project data.") }
            state = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
            var scope = fields
            if let composition {
                guard let comp = (fields["comps"] as? [String: Any])?[composition] as? [String: Any] else { throw Failure("The composition was removed.") }
                scope = comp
            }
            rangeMarks = scope["range"] as? [String: Any]
            let rootFPS = (fields["fps"] as? NSNumber)?.doubleValue ?? 30
            fps = (scope["fps"] as? NSNumber)?.doubleValue ?? rootFPS
            guard rootFPS.isFinite, rootFPS > 0, fps.isFinite, fps > 0 else { throw Failure("The timeline frame rate is invalid.") }
            minimumDuration = 1 / fps
            tracks = scope["tracks"] as? [[String: Any]] ?? []
            clips = tracks.flatMap { track in
                (track["clips"] as? [[String: Any]] ?? []).map {
                    Clip(fields: $0, track: track["id"] as? String ?? "", trackKind: track["kind"] as? String ?? "video", locked: track["locked"] as? Bool ?? false)
                }
            }
            let ids = clips.map(\.id), trackIDs = tracks.compactMap { $0["id"] as? String }
            guard Set(ids).count == ids.count, !ids.contains(""), Set(trackIDs).count == tracks.count,
                  !trackIDs.contains(""), !selected.isEmpty, selected.contains(lead), selected.isSubset(of: Set(ids)) else {
                throw Failure("The selection no longer matches the timeline.")
            }
            for clip in affectedSelection { try editable(clip) }
        }

        func matches(fields: [String: Any], folder: String?, composition: String?, version: Int, selected: Set<String>, primary: String?, zoom: Double) -> Bool {
            guard self.folder == folder, self.composition == composition, self.version == version,
                  self.selected == selected, self.primary == primary, self.zoom == zoom,
                  JSONSerialization.isValidJSONObject(fields),
                  let current = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) else { return false }
            return state == current
        }
        var affectedSelection: [Clip] {
            var ids = selected
            for clip in clips where selected.contains(clip.id) && !clip.link.isEmpty {
                for linked in family(clip) { ids.insert(linked.id) }
            }
            return clips.filter { ids.contains($0.id) }
        }
        func family(_ clip: Clip) -> [Clip] { clip.link.isEmpty ? [clip] : clips.filter { $0.link == clip.link } }
        func clip(_ id: String) throws -> Clip {
            guard let result = clips.first(where: { $0.id == id }) else { throw Failure("A selected clip was removed.") }
            return result
        }
        func editable(_ clip: Clip) throws {
            guard !clip.locked else { throw Failure("Unlock every selected or linked track before editing.") }
            guard clip.start.isFinite, clip.start >= 0, clip.duration.isFinite, clip.duration >= minimumDuration - 0.0001,
                  clip.end.isFinite, clip.end < 1_000_000 else { throw Failure("A clip has invalid timeline timing.") }
        }
        func linear(_ clip: Clip) throws {
            try editable(clip)
            guard clip.speed.isFinite, clip.speed > 0, clip.input.isFinite, clip.input >= 0,
                  clip.fields["reverse"] as? Bool != true, clip.fields["freeze"] == nil, clip.fields["timeMap"] == nil else {
                throw Failure("This edit requires forward clips with a constant positive speed.")
            }
        }
        func length(_ clip: Clip) throws -> Double {
            let kind = clip.fields["kind"] as? String ?? ""
            if kind == "comp" {
                let comps = fields["comps"] as? [String: Any] ?? [:]
                guard let comp = comps[clip.fields["comp"] as? String ?? ""] as? [String: Any] else { throw Failure("A source composition was removed.") }
                if let duration = (comp["duration"] as? NSNumber)?.doubleValue, duration.isFinite, duration > 0 { return duration }
                let end = (comp["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }.map {
                    (($0["start"] as? NSNumber)?.doubleValue ?? 0) + (($0["dur"] as? NSNumber)?.doubleValue ?? 0)
                }.max() ?? 0
                guard end.isFinite, end >= 0 else { throw Failure("A source composition has invalid timing.") }
                return end > 0 ? end : 5
            }
            guard ["video", "audio"].contains(kind) else { return .infinity }
            let assets = fields["assets"] as? [String: Any] ?? [:]
            let asset = assets[clip.fields["src"] as? String ?? ""] as? [String: Any] ?? [:]
            guard let duration = (asset["duration"] as? NSNumber)?.doubleValue, duration.isFinite, duration > 0 else { throw Failure("Media duration is unavailable for this edit.") }
            return duration
        }
        func aligned(_ group: [Clip]) throws {
            guard let first = group.first else { throw Failure("A linked clip was removed.") }
            for item in group {
                try linear(item)
                guard abs(item.start - first.start) < 0.0001, abs(item.end - first.end) < 0.0001,
                      abs(item.speed - first.speed) < 0.0001 else { throw Failure("Linked clips must have matching timing and speed for this edit.") }
            }
        }
        func snap(_ value: Double, excluding: Set<String>) -> (time: Double, line: Double?) {
            var points = [0, time]
            points += NativeTimelineMarkerEditing.markers(fields, composition: composition).compactMap { ($0["t"] as? NSNumber)?.doubleValue }
            if let range = rangeMarks { points += [range["in"], range["out"]].compactMap { ($0 as? NSNumber)?.doubleValue } }
            for item in clips where !excluding.contains(item.id) { points += [item.start, item.end] }
            let closest = snapping ? points.filter { $0.isFinite && abs($0 - value) * zoom < 9 }.min { abs($0 - value) < abs($1 - value) } : nil
            return (frame(closest ?? value), closest)
        }
        func frame(_ value: Double) -> Double { ((value * fps).rounded() / fps * 100_000).rounded() / 100_000 }
        func boundedFrame(_ value: Double, lower: Double, upper: Double) throws -> Double {
            let low = ceil((lower - 0.000001) * fps) / fps
            let high = floor((upper + 0.000001) * fps) / fps
            guard !low.isNaN, !high.isNaN, low <= high else { throw Failure("There are no source handles left for this edit.") }
            return frame(max(low, min(high, frame(value))))
        }
        func scoped(_ ops: [[String: Any]]) -> [[String: Any]] {
            ops.map { operation in var result = operation; result["comp"] = composition as Any? ?? NSNull(); return result }
        }
        func hasChanges(_ plan: Plan) -> Bool {
            plan.operations.contains { operation in
                let kind = operation["op"] as? String ?? ""
                guard let item = try? clip(operation["id"] as? String ?? operation["b"] as? String ?? "") else { return false }
                let value = (operation[kind == "move" ? "start" : kind == "trim" || kind == "roll" ? "to" : "delta"] as? NSNumber)?.doubleValue ?? 0
                switch kind {
                case "move": return abs(frame(value) - item.start) > 0.00001 || operation["track"] as? String != nil
                case "trim": return abs(value - (operation["edge"] as? String == "left" ? item.start : item.end)) > 0.00001
                case "roll": return abs(value - item.start) > 0.00001
                default: return abs(value) > 0.00001
                }
            }
        }

        func plan(mode: NativeTimelineMode, delta: Double, edge: String? = nil, destination: String? = nil) throws -> Plan {
            guard delta.isFinite, abs(delta) < 1_000_000 else { throw Failure("The timeline gesture has invalid geometry.") }
            let leadClip = try clip(lead)
            switch mode {
            case .move:
                let group = affectedSelection, ids = Set(group.map(\.id))
                var target: String?
                if let destination, destination != leadClip.track {
                    guard let track = tracks.first(where: { $0["id"] as? String == destination }),
                          track["kind"] as? String == leadClip.trackKind, track["locked"] as? Bool != true else {
                        throw Failure("Choose an unlocked destination track of the same kind.")
                    }
                    target = destination
                }
                let a = snap(leadClip.start + delta, excluding: ids), b = snap(leadClip.end + delta, excluding: ids)
                let useEnd = b.line != nil && (a.line == nil || abs(b.time - leadClip.end - delta) < abs(a.time - leadClip.start - delta))
                let raw = (useEnd ? b.time - leadClip.duration : a.time) - leadClip.start
                let shift = max(-(group.map(\.start).min() ?? 0), raw)
                guard group.allSatisfy({ $0.end + shift < 1_000_000 }) else { throw Failure("The move exceeds the supported timeline range.") }
                var seen = Set<String>(), operations: [[String: Any]] = [], offsets: [String: Double] = [:]
                for item in [leadClip] + group.filter({ $0.id != lead }) {
                    let key = item.link.isEmpty ? "id:\(item.id)" : "link:\(item.link)"
                    guard seen.insert(key).inserted else { continue }
                    let linked = family(item)
                    let start = try boundedFrame(item.start + shift, lower: item.start - (linked.map(\.start).min() ?? 0),
                                                 upper: item.start + 999_999 - (linked.map(\.end).max() ?? item.end))
                    for partner in linked { offsets[partner.id] = start - item.start }
                    var operation: [String: Any] = ["op": "move", "id": item.id, "start": start]
                    if item.id == lead, let target { operation["track"] = target }
                    operations.append(operation)
                }
                return Plan(operations: scoped(operations), offsets: offsets, targetTrack: target, snapLine: useEnd ? b.line : a.line, detail: String(format: "Move %+.2f s", offsets[lead] ?? shift))
            case .trim, .ripple:
                guard let edge, ["left", "right"].contains(edge) else { throw Failure("Drag a clip edge to trim.") }
                let group = family(leadClip); try aligned(group)
                var lower = mode == .ripple && edge == "left" ? -Double.infinity : 0.0, upper = Double.infinity
                for item in group {
                    if edge == "left" {
                        lower = max(lower, item.start - item.input / item.speed)
                        upper = min(upper, item.end - minimumDuration)
                    } else {
                        lower = max(lower, item.start + minimumDuration)
                        upper = min(upper, item.start + (try length(item) - item.input) / item.speed)
                    }
                }
                // A plain trim stops at the neighbouring clip on each linked track, as the shared core does.
                if mode == .trim {
                    let groupIDs = Set(group.map(\.id))
                    for item in group {
                        let row = clips.filter { $0.track == item.track && !groupIDs.contains($0.id) }
                        if edge == "left" { lower = max(lower, row.filter { $0.end <= item.start + 0.000001 }.map(\.end).max() ?? 0) }
                        else { upper = min(upper, row.filter { $0.start >= item.end - 0.000001 }.map(\.start).min() ?? .infinity) }
                    }
                }
                let snapped = snap((edge == "left" ? leadClip.start : leadClip.end) + delta, excluding: Set(group.map(\.id)))
                let to = try boundedFrame(snapped.time, lower: lower, upper: upper)
                let shift = edge == "left" ? leadClip.start - to : to - leadClip.end
                var offsets: [String: Double] = [:], previewFields: [String: [String: Double]] = [:]
                for item in group {
                    if edge == "left" {
                        previewFields[item.id] = ["start": mode == .ripple ? item.start : to, "dur": item.end - to]
                        if item.fields["in"] != nil { previewFields[item.id]?["in"] = item.input + (to - item.start) * item.speed }
                    } else { previewFields[item.id] = ["dur": to - item.start] }
                }
                if mode == .ripple {
                    guard Set(group.map(\.track)).count == group.count else { throw Failure("Ripple trim needs one linked clip per track.") }
                    for item in group {
                        for later in clips where later.track == item.track && later.id != item.id && later.start >= item.end - 0.000001 {
                            guard later.start + shift >= 0 else { throw Failure("The ripple would move a clip before the timeline start.") }
                            offsets[later.id] = shift
                        }
                    }
                    for later in clips where offsets[later.id] != nil {
                        guard family(later).allSatisfy({ offsets[$0.id] == shift }) else { throw Failure("The ripple would separate later linked clips.") }
                    }
                }
                return Plan(operations: scoped([["op": "trim", "id": lead, "edge": edge, "to": to, "ripple": mode == .ripple]]), offsets: offsets, targetTrack: nil, snapLine: snapped.line == to ? to : nil, detail: String(format: "%@ %@ %.2f s", mode.rawValue, edge, to), clipFields: previewFields)
            case .roll:
                guard let edge, ["left", "right"].contains(edge) else { throw Failure("Drag a shared edge to roll.") }
                let pair = try neighbors(of: leadClip, edge: edge)
                let leftFamily = family(pair.0), rightFamily = family(pair.1)
                try aligned(leftFamily); try aligned(rightFamily)
                guard Set(leftFamily.map(\.track)) == Set(rightFamily.map(\.track)), Set(leftFamily.map(\.track)).count == leftFamily.count,
                      Set(rightFamily.map(\.track)).count == rightFamily.count else { throw Failure("Every linked roll needs matching adjacent clips on its track.") }
                var pairs: [(Clip, Clip)] = [], lower = 0.0, upper = Double.infinity
                for a in leftFamily {
                    guard let b = rightFamily.first(where: { $0.track == a.track }), abs(a.end - b.start) < 0.0001 else { throw Failure("Roll requires adjacent clips without a gap or overlap.") }
                    _ = try neighbors(of: a, edge: "right")
                    pairs.append((a, b))
                    lower = max(lower, max(a.start + minimumDuration, b.start - b.input / b.speed))
                    upper = min(upper, min(b.end - minimumDuration, a.start + (try length(a) - a.input) / a.speed))
                }
                let snapped = snap(pair.1.start + delta, excluding: Set((leftFamily + rightFamily).map(\.id)))
                let to = try boundedFrame(snapped.time, lower: lower, upper: upper)
                let operations = pairs.map { ["op": "roll", "a": $0.0.id, "b": $0.1.id, "to": to] as [String: Any] }
                var previewFields: [String: [String: Double]] = [:]
                for (a, b) in pairs {
                    previewFields[a.id] = ["dur": to - a.start]
                    previewFields[b.id] = ["start": to, "dur": b.end - to]
                    if b.fields["in"] != nil { previewFields[b.id]?["in"] = b.input + (to - b.start) * b.speed }
                }
                return Plan(operations: scoped(operations), offsets: [:], targetTrack: nil, snapLine: snapped.line == to ? to : nil, detail: String(format: "Roll cut %.2f s", to), clipFields: previewFields)
            case .slip:
                let group = family(leadClip); try aligned(group)
                var lower = -Double.infinity, upper = Double.infinity
                for item in group {
                    guard item.fields["in"] != nil else { throw Failure("Slip requires a clip with a source window.") }
                    lower = max(lower, -item.input)
                    upper = min(upper, try length(item) - item.duration * item.speed - item.input)
                }
                guard lower <= upper else { throw Failure("The source window is outside its media.") }
                let shift = max(lower, min(upper, -frame(delta) * leadClip.speed))
                return Plan(operations: scoped([["op": "slip", "id": lead, "delta": shift]]), offsets: [:], targetTrack: nil, snapLine: nil, detail: String(format: "Slip source %+.2f s", shift), clipFields: Dictionary(uniqueKeysWithValues: group.map { ($0.id, ["in": $0.input + shift]) }))
            case .slide:
                let group = family(leadClip); try aligned(group)
                guard Set(group.map(\.track)).count == group.count else { throw Failure("Linked slide clips must be on separate tracks.") }
                var affected = group, lower = -leadClip.start, upper = Double.infinity
                for item in group {
                    let before = try neighbors(of: item, edge: "left").0, after = try neighbors(of: item, edge: "right").1
                    try linear(before); try linear(after)
                    affected += [before, after]
                    lower = max(lower, max(-(before.duration - minimumDuration), -after.input / after.speed))
                    upper = min(upper, min(after.duration - minimumDuration, (try length(before) - before.input) / before.speed - before.duration))
                }
                let affectedIDs = Set(affected.map(\.id))
                guard affected.allSatisfy({ family($0).allSatisfy { affectedIDs.contains($0.id) } }) else { throw Failure("Slide would separate a neighbor from its linked clip.") }
                let shift = try boundedFrame(delta, lower: lower, upper: upper)
                let operations = group.map { ["op": "slide", "id": $0.id, "delta": shift] as [String: Any] }
                var previewFields: [String: [String: Double]] = [:]
                for item in group {
                    let before = try neighbors(of: item, edge: "left").0, after = try neighbors(of: item, edge: "right").1
                    previewFields[before.id] = ["dur": before.duration + shift]
                    previewFields[after.id] = ["start": after.start + shift, "dur": after.duration - shift]
                    if after.fields["in"] != nil { previewFields[after.id]?["in"] = after.input + shift * after.speed }
                }
                return Plan(operations: scoped(operations), offsets: Dictionary(uniqueKeysWithValues: group.map { ($0.id, shift) }), targetTrack: nil, snapLine: nil, detail: String(format: "Slide %+.2f s", shift), clipFields: previewFields)
            }
        }
        func neighbors(of item: Clip, edge: String) throws -> (Clip, Clip) {
            let row = clips.filter { $0.track == item.track }.sorted { $0.start < $1.start }
            guard let index = row.firstIndex(where: { $0.id == item.id }) else { throw Failure("The clip was removed.") }
            let a: Clip, b: Clip
            if edge == "left", index > 0 { a = row[index - 1]; b = item }
            else if edge == "right", index + 1 < row.count { a = item; b = row[index + 1] }
            else { throw Failure("This edit needs an adjacent clip on that edge.") }
            try linear(a); try linear(b)
            guard abs(a.end - b.start) < 0.0001,
                  !row.contains(where: { $0.id != a.id && $0.id != b.id && $0.start < b.end - 0.000001 && $0.end > a.start + 0.000001 }) else {
                throw Failure("This edit requires adjacent clips without a gap or overlap.")
            }
            return (a, b)
        }
    }
}
// END TIMELINE PLANNING

// BEGIN TIMELINE TOUCH GEOMETRY
enum NativeTimelineTouchGeometry {
    static let target: Double = 44
    static let holdDuration: Double = 0.25
    static let holdDistance: Double = 10
    // Keep independent start, move and end regions. Short clips use the precision controls.
    static func inlineEdges(clipWidth: Double) -> Bool {
        clipWidth.isFinite && clipWidth >= target * 3
    }
}
// END TIMELINE TOUCH GEOMETRY

#if os(iOS)
struct NativeTimelineInteractionLayout: Equatable {
    let frame: CGRect
    let visible: Bool
}

// BEGIN TIMELINE INTERACTION POLICY
enum NativeTimelineInteractionPolicy {
    static func accepts(unchanged: Bool, visible: Bool, frame: CGRect) -> Bool {
        unchanged && visible && frame.origin.x.isFinite && frame.origin.y.isFinite &&
            frame.width.isFinite && frame.height.isFinite && frame.width > 0 && frame.height > 0
    }
    static func cancellationLatch(active: Bool, canceled: Bool) -> Bool { active || canceled }
}
// END TIMELINE INTERACTION POLICY

fileprivate struct NativeTimelineInteractionCapture: Equatable {
    let supplied: NativeTimelineInteractionLayout?
    let measuredFrame: CGRect?
    var permitsInteraction: Bool {
        let frame = supplied?.frame ?? measuredFrame ?? .zero
        return NativeTimelineInteractionPolicy.accepts(unchanged: true, visible: supplied?.visible ?? true, frame: frame) &&
            (measuredFrame.map { NativeTimelineInteractionPolicy.accepts(unchanged: true, visible: true, frame: $0) } ?? true)
    }
    func matches(_ current: Self) -> Bool { self == current && current.permitsInteraction }
}

// BEGIN TIMELINE ARMED FEEDBACK
fileprivate enum NativeTimelineArmedFeedback {
    static func label(mode: NativeTimelineMode, edge: String?) -> String? {
        switch mode {
        case .move, .slip, .slide:
            guard edge == nil else { return nil }
            return mode.rawValue
        case .trim, .ripple, .roll:
            guard edge == "left" || edge == "right" else { return nil }
            return "\(mode.rawValue) \(edge == "left" ? "start" : "end")"
        }
    }
}
// END TIMELINE ARMED FEEDBACK
#endif

// BEGIN NATIVE CANVAS COMMAND POLICY
/// Only this timeline's focused key handler can request these commands.
enum NativeTimelineCanvasCommands {
    enum Action: Equatable { case copy, cut, paste, matchFrame }

    static func action(characters: String, modifiers: EventModifiers) -> Action? {
        let shortcutModifiers = modifiers.subtracting(.capsLock)
        let key = characters.lowercased()
        if shortcutModifiers == .command {
            switch key {
            case "c": return .copy
            case "x": return .cut
            case "v": return .paste
            default: return nil
            }
        }
        return shortcutModifiers.isEmpty && key == "f" ? .matchFrame : nil
    }

    #if os(macOS)
    static func admits(keyboardFocus: Bool, keyWindow: Bool, contentFocused: Bool, modal: Bool, sheet: Bool,
                       textEditable: Bool, textSelectable: Bool) -> Bool {
        keyboardFocus && keyWindow && contentFocused && !modal && !sheet && !textEditable && !textSelectable
    }

    @MainActor final class FocusOwner { weak var view: NSView? }

    @MainActor static func focusedCanvas(_ keyboardFocus: Bool, owner: FocusOwner) -> Bool {
        guard let surface = owner.view, let window = surface.window, NSApp.keyWindow === window,
              let view = window.firstResponder as? NSView, let content = window.contentView else { return false }
        let text = view as? NSTextView, field = view as? NSTextField
        return admits(keyboardFocus: keyboardFocus, keyWindow: window.isKeyWindow,
                      contentFocused: surface.isDescendant(of: content) && view.window === window && (view === content || view.isDescendant(of: content)),
                      modal: NSApp.modalWindow != nil, sheet: window.attachedSheet != nil,
                      textEditable: text?.isEditable == true || field?.isEditable == true,
                      textSelectable: text?.isSelectable == true || field?.isSelectable == true)
    }
    #endif
}
// END NATIVE CANVAS COMMAND POLICY

#if os(macOS)
private struct NativeTimelineCanvasFocusAnchor: NSViewRepresentable {
    let owner: NativeTimelineCanvasCommands.FocusOwner
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        owner.view = view
        return view
    }
    func updateNSView(_ view: NSView, context: Context) { owner.view = view }
}
#endif

struct NativeTimeline: View {
    @ObservedObject var model: NativeEditorModel
    var openMotion: () -> Void
    #if os(iOS)
    var interactionLayout: NativeTimelineInteractionLayout? = nil
    @State private var measuredInteractionFrame: CGRect?
    @State private var rulerGesture: RulerGesture?
    @State private var rulerCanceled = false
    @GestureState private var rulerActive = false
    #if os(iOS)
    /// Horizontal scroll position of the tracks, so the pinned ruler above them follows it.
    @State private var tracksScrollX: CGFloat = 0
    #endif
    @State private var magnifyLayout: NativeTimelineInteractionCapture?
    @State private var magnifyCanceled = false
    @GestureState private var magnifyActive = false
    #endif
    @State private var initialZoom: Double?
    @State private var mode: NativeTimelineMode = .move
    @State private var snapping = true
    @State private var extendingSelection = false
    @State private var gesture: TimelineGesture?
    @State private var preview: NativeTimelinePlanning.Plan?
    @State private var marquee: Marquee?
    @State private var feedback = ""
    #if os(iOS)
    @State private var precisionEdge = "right"
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    #endif
    @FocusState private var keyboardFocus: Bool
    #if os(macOS)
    @State private var canvasFocusOwner = NativeTimelineCanvasCommands.FocusOwner()
    #endif
    private let rowHeight: CGFloat = 64
    private var rulerHeight: CGFloat {
        #if os(iOS)
        return 44
        #else
        return 28
        #endif
    }
    private var trackHeaderWidth: CGFloat {
        #if os(iOS)
        return 72
        #else
        return 128
        #endif
    }
    private var contentWidth: Double { max(600, (model.duration + 5) * model.zoom) }
    private var displayTracks: [NativeTrack] { Array(model.tracks.filter { $0.kind == "video" }.reversed()) + model.tracks.filter { $0.kind != "video" } }
    /// Changes when a project or timeline opens, or when its first clips arrive.
    private var firstClipTrackKey: String {
        "\(model.folder?.path ?? "")|\(model.composition ?? "")|\(displayTracks.contains { !$0.clips.isEmpty })"
    }

    private struct TimelineGesture {
        let capture: NativeTimelinePlanning.Capture
        let mode: NativeTimelineMode
        let edge: String?
        let rows: [String]
        let sourceTrack: String
        #if os(iOS)
        var interaction: NativeTimelineInteractionCapture? = nil
        var feedbackContext: UUID? = nil
        var feedbackInvalidated = false
        #endif
    }
    #if os(iOS)
    private struct RulerGesture {
        let interaction: NativeTimelineInteractionCapture
        let context: UUID
        let composition: String?
        let zoom: Double
    }
    private var currentInteractionLayout: NativeTimelineInteractionCapture {
        NativeTimelineInteractionCapture(supplied: interactionLayout, measuredFrame: measuredInteractionFrame)
    }
    private func armedEditLabel(for id: String) -> String? {
        guard let source = gesture, source.capture.lead == id, !source.feedbackInvalidated,
              source.feedbackContext == model.processingContextID, feedback.isEmpty,
              !model.busy, !model.showingSource, model.projectReadOnlyReason == nil,
              model.project != nil, source.capture.version == model.version,
              source.capture.folder == model.folder?.path, source.capture.composition == model.composition,
              source.capture.selected == model.selectedIDs, source.capture.primary == model.selectedID,
              source.capture.zoom == model.zoom,
              source.interaction?.matches(currentInteractionLayout) == true else { return nil }
        return NativeTimelineArmedFeedback.label(mode: source.mode, edge: source.edge)
    }
    private func invalidateArmedFeedback(_ matchesOldCapture: Bool) {
        guard matchesOldCapture else { return }
        gesture?.feedbackInvalidated = true
    }
    #endif
    private struct Marquee {
        let start: CGPoint
        var point: CGPoint
        let folder: URL?
        let composition: String?
        let version: Int
        let zoom: Double
        let state: Data
        let tracks: [[String: Any]]
        let selection: Set<String>
        let extending: Bool
    }

    var body: some View {
        VStack(spacing: 0) {
            NativeTimelineToolbar(model: model, mode: $mode, snapping: $snapping, extending: $extendingSelection,
                                  detail: feedback.isEmpty ? preview?.detail ?? "\(model.selectedIDs.count) selected" : feedback,
                                  selectAll: selectAll, split: splitSelection, delete: deleteSelection, nudge: nudge)
            #if os(iOS)
            precisionControls
            #endif
            #if os(iOS)
            // The ruler sits outside the vertical scroll, so scrolling to a lower track keeps
            // drag-to-scrub and the marker flags on screen. It follows the tracks horizontally.
            HStack(spacing: 0) {
                Text("Tracks").font(.caption2).foregroundStyle(.secondary)
                    .frame(width: trackHeaderWidth, height: rulerHeight).background(NativeEditorStyle.panel)
                ruler.frame(height: rulerHeight)
                    .overlay(alignment: .topLeading) {
                        Rectangle().fill(NativeEditorStyle.playhead).frame(width: 1.5)
                            .offset(x: model.time * model.zoom).allowsHitTesting(false)
                    }
                    .offset(x: tracksScrollX)
                    .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading).clipped()
            }.frame(height: rulerHeight).padding(.bottom, 1)
            #endif
            ScrollViewReader { trackScroll in
            ScrollView(.vertical) {
                HStack(alignment: .top, spacing: 0) {
                    VStack(spacing: 1) {
                        #if os(macOS)
                        Text("Tracks").font(.caption2).foregroundStyle(.secondary).frame(height: rulerHeight)
                        #endif
                        ForEach(displayTracks) { track in trackHeader(track).frame(height: rowHeight).id("timeline.track." + track.id) }
                    }.frame(width: trackHeaderWidth).background(NativeEditorStyle.panel)
                    ScrollView(.horizontal) {
                        VStack(spacing: 1) {
                            #if os(macOS)
                            ruler.frame(height: rulerHeight)
                            #endif
                            ForEach(displayTracks) { track in
                                ZStack(alignment: .leading) {
                                    Rectangle().fill(NativeEditorStyle.panelRaised.opacity(0.55))
                                        .contentShape(Rectangle()).onTapGesture { model.select(id: nil); keyboardFocus = true }
                                        #if os(macOS)
                                        .gesture(DragGesture(minimumDistance: 3, coordinateSpace: .named("nativeTimelineRows"))
                                            .onChanged(updateMarquee).onEnded(endMarquee))
                                        #endif
                                    ForEach(track.clips) { clip in
                                        let shown = shownClip(clip)
                                        let motionContext = model.processingContextID, motionVersion = model.version, motionComposition = model.composition
                                        NativeTimelineClip(clip: shown, track: track, model: model, mode: mode,
                                                           select: { selectClip(clip.id) }, extend: { selectClip(clip.id, extending: true) },
                                                           begin: { begin(clip.id, edge: $0, renderedVersion: $1) },
                                                           update: { update(clip.id, translation: $0) },
                                                           end: { end(clip.id, translation: $0) },
                                                           cancel: clearGesture,
                                                           precise: { direction, edge, activeMode in precisionNudge(clip.id, direction: direction, edge: edge, mode: activeMode) },
                                                           action: { action in
                                                               if action == "motion" { editMotion(clip: clip, context: motionContext, version: motionVersion, composition: motionComposition) }
                                                               else { clipAction(action, clip: clip) }
                                                           })
                                            #if os(iOS)
                                            .timelineInteractionLayout(currentInteractionLayout)
                                            .timelineArmedEditLabel(armedEditLabel(for: clip.id))
                                            #endif
                                            .frame(width: max(8, shown.duration * model.zoom), height: rowHeight - 6)
                                            .offset(x: shown.start * model.zoom + (preview?.offsets[clip.id] ?? 0) * (gesture?.capture.zoom ?? model.zoom), y: verticalOffset(clip.id))
                                            .zIndex(preview?.offsets[clip.id] == nil ? 0 : 1)
                                    }
                                }.frame(width: contentWidth, height: rowHeight)
                                    .zIndex(gesture?.sourceTrack == track.id ? 1 : 0)
                            }
                        }
                        .coordinateSpace(name: "nativeTimelineRows")
                        #if os(iOS)
                        .background {
                            GeometryReader { content in
                                Color.clear.onChange(of: content.frame(in: .named("nativeTimelineTracksX")).minX, initial: true) { _, x in
                                    if x.isFinite { tracksScrollX = min(0, x) }
                                }
                            }
                        }
                        #endif
                        .overlay(alignment: .topLeading) {
                            Rectangle().fill(NativeEditorStyle.playhead).frame(width: 1.5)
                                .offset(x: model.time * model.zoom).allowsHitTesting(false)
                            if let line = preview?.snapLine {
                                Rectangle().fill(NativeEditorStyle.accent).frame(width: 1)
                                    .offset(x: line * model.zoom).allowsHitTesting(false)
                            }
                            if let marquee {
                                Rectangle().fill(NativeEditorStyle.accent.opacity(0.12)).overlay { Rectangle().stroke(NativeEditorStyle.accent) }
                                    .frame(width: abs(marquee.point.x - marquee.start.x), height: abs(marquee.point.y - marquee.start.y))
                                    .offset(x: min(marquee.start.x, marquee.point.x), y: min(marquee.start.y, marquee.point.y)).allowsHitTesting(false)
                            }
                        }
                    }
                    #if os(iOS)
                    .coordinateSpace(name: "nativeTimelineTracksX")
                    #endif
                    .simultaneousGesture(MagnifyGesture()
                        #if os(iOS)
                        .updating($magnifyActive) { _, active, _ in active = true }
                        #endif
                        .onChanged { value in
                        #if os(iOS)
                        guard !magnifyCanceled else { return }
                        if magnifyLayout == nil { magnifyLayout = currentInteractionLayout }
                        guard let source = magnifyLayout, source.matches(currentInteractionLayout) else {
                            cancelLayoutInteraction(); return
                        }
                        #endif
                        if initialZoom == nil { initialZoom = model.zoom }
                        model.zoom = min(800, max(10, (initialZoom ?? 80) * value.magnification))
                    }.onEnded { _ in
                        #if os(iOS)
                        defer { initialZoom = nil; magnifyLayout = nil; magnifyCanceled = false }
                        guard !magnifyCanceled, magnifyLayout?.matches(currentInteractionLayout) == true else {
                            cancelLayoutInteraction(); return
                        }
                        #else
                        initialZoom = nil
                        #endif
                    })
                }
            }
            #if os(iOS)
            .focusable(currentInteractionLayout.permitsInteraction)
            #else
            .focusable()
            #endif
            .focused($keyboardFocus).focusEffectDisabled()
            .onKeyPress(phases: .down, action: keyPress)
            #if os(macOS)
            .background(NativeTimelineCanvasFocusAnchor(owner: canvasFocusOwner).allowsHitTesting(false))
            #endif
            .accessibilityLabel("Timeline. Command A selects all. Arrow keys nudge the current editing mode. S toggles snapping.")
            #if os(iOS)
            // A phone timeline shows about two tracks. When the top tracks are empty, open on the
            // first track that holds clips instead of on empty rows. Runs once per project and timeline.
            .onChange(of: firstClipTrackKey, initial: true) { _, _ in
                guard let first = displayTracks.first, first.clips.isEmpty,
                      let target = displayTracks.first(where: { !$0.clips.isEmpty }) else { return }
                DispatchQueue.main.async { trackScroll.scrollTo("timeline.track." + target.id, anchor: .top) }
            }
            #endif
            }
        }.background(NativeEditorStyle.background)
        #if os(iOS)
        .background {
            GeometryReader { geometry in
                let frame = geometry.frame(in: .global)
                Color.clear.onAppear { updateInteractionFrame(frame) }
                    .onChange(of: frame) { _, next in updateInteractionFrame(next) }
            }.allowsHitTesting(false)
        }
        .onChange(of: interactionLayout) { _, next in
            if next?.visible == false { keyboardFocus = false }
            cancelLayoutInteraction()
        }
        .onChange(of: rulerActive) { _, active in
            if !active { finishInterruptedScrub(); rulerGesture = nil; rulerCanceled = false }
        }
        .onChange(of: magnifyActive) { _, active in
            if !active { initialZoom = nil; magnifyLayout = nil; magnifyCanceled = false }
        }
        .onChange(of: model.processingContextID) { _, _ in cancelLayoutInteraction() }
        .onChange(of: model.version) { old, _ in invalidateArmedFeedback(gesture?.capture.version == old) }
        .onChange(of: model.selectedIDs) { old, _ in invalidateArmedFeedback(gesture?.capture.selected == old) }
        .onChange(of: model.selectedID) { old, _ in invalidateArmedFeedback(gesture?.capture.primary == old) }
        .onChange(of: model.zoom) { old, _ in invalidateArmedFeedback(gesture?.capture.zoom == old) }
        .onChange(of: model.busy) { _, busy in invalidateArmedFeedback(busy) }
        .onChange(of: model.showingSource) { _, visible in invalidateArmedFeedback(visible) }
        .onChange(of: model.projectReadOnlyReason) { _, reason in invalidateArmedFeedback(reason != nil) }
        #endif
        .onChange(of: model.composition) { _, _ in
            #if os(iOS)
            cancelLayoutInteraction()
            #else
            clearGesture()
            #endif
        }
        .onChange(of: model.folder) { _, _ in
            #if os(iOS)
            cancelLayoutInteraction()
            #else
            clearGesture()
            #endif
        }
        .onChange(of: mode) { _, _ in clearGesture() }
        .onDisappear {
            clearGesture()
            #if os(iOS)
            cancelLayoutInteraction(); measuredInteractionFrame = nil
            rulerCanceled = false; magnifyCanceled = false
            #endif
        }
    }

    private var ruler: some View {
        let renderedContext = model.processingContextID
        let renderedComposition = model.composition
        let rate = max(1, Int(model.fps.rounded()))
        // Minutes and seconds, as on a Final Cut ruler. Ticks between whole seconds are shorter and unlabeled,
        // so no label can be read as minutes:seconds:frames.
        func rulerLabel(_ seconds: Int) -> String {
            seconds >= 3600 ? String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
                : String(format: "%d:%02d", seconds / 60, seconds % 60)
        }
        return Canvas { context, size in
            let step = model.zoom > 160 ? 0.5 : model.zoom > 40 ? 1.0 : 5.0
            for at in stride(from: 0.0, through: contentWidth / model.zoom, by: step) {
                let x = at * model.zoom
                let frames = Int((at * Double(rate)).rounded())
                let whole = frames % rate == 0
                if whole {
                    context.draw(Text(rulerLabel(frames / rate)).font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary), at: CGPoint(x: x + 3, y: 9), anchor: .topLeading)
                }
                var path = Path(); path.move(to: CGPoint(x: x, y: size.height - (whole ? 7 : 4))); path.addLine(to: CGPoint(x: x, y: size.height))
                context.stroke(path, with: .color(.secondary.opacity(0.4)))
            }
            for marker in NativeTimelineMarkerEditing.markers(model.project?.fields ?? [:], composition: renderedComposition) {
                let x = marker.number("t") * model.zoom
                guard x.isFinite else { continue }
                var mark = Path(); mark.move(to: CGPoint(x: x - 4, y: 0)); mark.addLine(to: CGPoint(x: x + 4, y: 0)); mark.addLine(to: CGPoint(x: x, y: 7)); mark.closeSubpath()
                context.fill(mark, with: .color(.orange))
            }
        }
        .frame(width: contentWidth).contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0)
            #if os(iOS)
            .updating($rulerActive) { _, active, _ in active = true }
            #endif
            .onChanged { value in
            guard renderedContext == model.processingContextID, renderedComposition == model.composition else { return }
            #if os(iOS)
            guard !rulerCanceled else { return }
            if rulerGesture == nil {
                rulerGesture = RulerGesture(interaction: currentInteractionLayout, context: renderedContext,
                                            composition: renderedComposition, zoom: model.zoom)
            }
            guard let source = rulerGesture, source.interaction.matches(currentInteractionLayout),
                  source.context == model.processingContextID, source.composition == model.composition,
                  source.zoom == model.zoom else { cancelLayoutInteraction(); return }
            #endif
            keyboardFocus = true; model.scrub(value.location.x / model.zoom)
        }.onEnded { value in
            #if os(iOS)
            defer { rulerGesture = nil; rulerCanceled = false }
            guard !rulerCanceled, let source = rulerGesture,
                  source.interaction.matches(currentInteractionLayout), source.context == model.processingContextID,
                  source.composition == model.composition, source.zoom == model.zoom else {
                finishInterruptedScrub(); return
            }
            #endif
            guard renderedContext == model.processingContextID, renderedComposition == model.composition else { return }
            model.scrub(value.location.x / model.zoom, finished: true)
        })
        .accessibilityLabel("Timeline ruler, drag to scrub")
        .accessibilityValue(nativeTimecode(model.time, fps: model.fps))
        .accessibilityAdjustableAction { direction in
            guard model.fps.isFinite, model.fps > 0 else { return }
            switch direction {
            case .increment: model.scrub(model.time + 1 / model.fps, finished: true)
            case .decrement: model.scrub(model.time - 1 / model.fps, finished: true)
            @unknown default: break
            }
        }
    }

    private func capture(_ lead: String, snapping override: Bool? = nil) throws -> NativeTimelinePlanning.Capture {
        guard let fields = model.project?.fields, let folder = model.folder else { throw NativeTimelinePlanning.Failure("Open a project before editing.") }
        return try .init(fields: fields, folder: folder.path, composition: model.composition, version: model.version,
                         selected: model.selectedIDs, primary: model.selectedID, lead: lead, zoom: model.zoom, time: model.time, snapping: override ?? snapping)
    }
    private func matches(_ source: NativeTimelinePlanning.Capture) -> Bool {
        guard let fields = model.project?.fields else { return false }
        return source.matches(fields: fields, folder: model.folder?.path, composition: model.composition, version: model.version,
                              selected: model.selectedIDs, primary: model.selectedID, zoom: model.zoom)
    }
    private func selectClip(_ id: String, extending explicit: Bool? = nil) {
        keyboardFocus = true
        var extending = explicit ?? extendingSelection
        #if os(macOS)
        if explicit == nil { extending = extending || NSEvent.modifierFlags.contains(.shift) || NSEvent.modifierFlags.contains(.command) }
        #endif
        guard let clip = model.tracks.flatMap(\.clips).first(where: { $0.id == id }) else { return }
        let link = clip.fields.string("link")
        let family = Set(model.tracks.flatMap(\.clips).filter { $0.id == id || (!link.isEmpty && $0.fields.string("link") == link) }.map(\.id))
        let ids = extending ? (model.selectedIDs.contains(id) ? model.selectedIDs.subtracting(family) : model.selectedIDs.union(family)) : family
        model.select(ids: ids, primary: ids.contains(id) ? id : model.selectedID)
    }
    private func selectAll() { keyboardFocus = true; model.select(ids: Set(model.tracks.flatMap(\.clips).map(\.id)), primary: model.selectedID) }
    #if os(iOS)
    private var precisionControls: some View {
        VStack(alignment: .leading, spacing: 0) {
            if model.selected == nil {
                clipSelectionMenu
            } else if dynamicTypeSize.isAccessibilitySize {
                clipSelectionMenu
                HStack(spacing: 6) { precisionTarget; Spacer(minLength: 0); precisionSteps }
            } else {
                HStack(spacing: 6) { clipSelectionMenu; precisionTarget; precisionSteps }
            }
        }
        .padding(.horizontal, 8)
        .background(NativeEditorStyle.panelRaised)
    }
    private var clipSelectionMenu: some View {
        let clipboardCapture = model.clipboardActionCapture()
        let matchFrame = Result { try model.captureMatchFrame() }
        return Menu {
            if let clip = model.selected {
                Section("Selected clip") {
                    Button("Seek to clip start") { model.scrub(clip.start, finished: true) }
                    Button("Match Frame") {
                        do { model.matchFrame(try matchFrame.get()) } catch { model.status = error.localizedDescription }
                    }
                        .disabled(!model.canRequestMatchFrame).accessibilityIdentifier("editor.matchFrame.precision")
                    Button("Split selection at playhead", action: splitSelection)
                    Button("Copy selection") { if let clipboardCapture { model.copyTimelineSelection(expected: clipboardCapture) } }.disabled(clipboardCapture == nil)
                    Button("Cut selection") { if let clipboardCapture { model.copyTimelineSelection(cut: true, expected: clipboardCapture) } }.disabled(clipboardCapture == nil)
                    Button("Duplicate clip") { clipAction("duplicate", clip: clip) }
                    if clip.kind == "comp" { Button("Open composition") { clipAction("open", clip: clip) } }
                    Button("Precompose selection") { clipAction("precompose", clip: clip) }
                    if clip.kind == "video" { Button("Detach audio") { clipAction("detach", clip: clip) } }
                    Button("Delete selection", role: .destructive) { deleteSelection(false) }
                    Button("Ripple delete selection", role: .destructive) { deleteSelection(true) }
                }
            }
            Button("Paste at playhead") { if let clipboardCapture { model.pasteTimelineClipboard(expected: clipboardCapture) } }.disabled(clipboardCapture == nil || !model.canPasteTimelineClipboard)
            ForEach(displayTracks) { track in
                Section(track.name) {
                    ForEach(track.clips) { clip in
                        Button { selectClip(clip.id) } label: {
                            Label("\(clip.name), \(nativeTimecode(clip.start, fps: model.fps))", systemImage: model.selectedIDs.contains(clip.id) ? "checkmark.circle.fill" : "film")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "film.stack")
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.selected?.name ?? "Select clip").lineLimit(1)
                    Text(feedback.isEmpty ? preview?.detail ?? (model.selected == nil ? "Tap a clip; swipe to scroll" : [.trim, .ripple, .roll].contains(mode) ? "Hold an edge, then drag" : "Hold, then drag to \(mode.rawValue.lowercased())") : feedback)
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.down").font(.caption2)
            }.font(.caption).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .accessibilityLabel(model.selected.map { "Selected clip, \($0.name)" } ?? "Select a timeline clip")
        .accessibilityValue(feedback.isEmpty ? preview?.detail ?? "" : feedback)
        .accessibilityHint("Choose any clip, including short clips, or open selected clip actions.")
    }
    private var precisionTarget: some View {
        Group {
            if [.trim, .ripple, .roll].contains(mode) {
                Menu {
                    Button("Start edge") { precisionEdge = "left" }
                    Button("End edge") { precisionEdge = "right" }
                } label: { Label(precisionEdge == "left" ? "Start" : "End", systemImage: "chevron.down") }
                    .accessibilityLabel("\(mode.rawValue), \(precisionEdge == "left" ? "start" : "end") edge")
            } else {
                Text(mode.rawValue).foregroundStyle(.secondary)
            }
        }.font(.caption).frame(minWidth: 44, minHeight: 44)
    }
    private var precisionSteps: some View {
        Group {
            Button { precisionStep(-1) } label: { Image(systemName: "minus") }
                .accessibilityLabel(precisionStepLabel(-1))
            Button { precisionStep(1) } label: { Image(systemName: "plus") }
                .accessibilityLabel(precisionStepLabel(1))
        }
        .buttonStyle(NativeToolbarButtonStyle())
        .disabled(model.selected == nil || model.tracks.first(where: { $0.clips.contains(where: { $0.id == model.selectedID }) })?.locked == true)
    }
    private func precisionStep(_ direction: Double) {
        guard let id = model.selectedID else { return }
        precisionNudge(id, direction: direction, edge: [.trim, .ripple, .roll].contains(mode) ? precisionEdge : nil)
    }
    private func precisionStepLabel(_ direction: Double) -> String {
        if mode == .slip { return "Shift source window \(direction < 0 ? "later" : "earlier") by one timeline frame" }
        let edge = [.trim, .ripple, .roll].contains(mode) ? " \(precisionEdge == "left" ? "start" : "end") edge" : ""
        return "\(mode.rawValue)\(edge) \(direction < 0 ? "earlier" : "later") by one frame"
    }
    #endif
    private func begin(_ id: String, edge: String?, renderedVersion: Int) {
        clearGesture(); keyboardFocus = true
        #if os(iOS)
        guard currentInteractionLayout.permitsInteraction else { return }
        #endif
        guard renderedVersion == model.version else { feedback = "The project changed. Try again."; return }
        if !model.selectedIDs.contains(id) { selectClip(id) }
        else { model.select(ids: model.selectedIDs, primary: id) }
        let activeMode: NativeTimelineMode = edge == nil ? mode : (mode == .roll || mode == .ripple ? mode : .trim)
        guard edge != nil || [.move, .slip, .slide].contains(activeMode) else { feedback = mode.hint; return }
        do {
            let source = try capture(id)
            gesture = TimelineGesture(capture: source, mode: activeMode, edge: edge, rows: displayTracks.map(\.id), sourceTrack: try source.clip(id).track)
            #if os(iOS)
            gesture?.interaction = currentInteractionLayout
            gesture?.feedbackContext = model.processingContextID
            gesture?.feedbackInvalidated = model.busy || model.showingSource || model.projectReadOnlyReason != nil
            #endif
        } catch { feedback = error.localizedDescription }
    }
    private func plan(_ source: TimelineGesture, translation: CGSize) throws -> NativeTimelinePlanning.Plan {
        guard translation.width.isFinite, translation.height.isFinite else { throw NativeTimelinePlanning.Failure("The timeline gesture has invalid geometry.") }
        var destination: String?
        if source.mode == .move {
            destination = try NativeTimelinePlanning.destination(rows: source.rows, source: source.sourceTrack,
                                                                 verticalDelta: translation.height, rowHeight: rowHeight + 1)
        }
        return try source.capture.plan(mode: source.mode, delta: translation.width / source.capture.zoom, edge: source.edge, destination: destination)
    }
    private func update(_ id: String, translation: CGSize) {
        guard let source = gesture, source.capture.lead == id else { return }
        #if os(iOS)
        guard source.interaction?.matches(currentInteractionLayout) == true else { cancelLayoutInteraction(); return }
        #endif
        do {
            guard source.capture.version == model.version, source.capture.folder == model.folder?.path,
                  source.capture.composition == model.composition, source.capture.selected == model.selectedIDs,
                  source.capture.primary == model.selectedID, source.capture.zoom == model.zoom else {
                throw NativeTimelinePlanning.Failure("The project or selection changed during the edit. Try again.")
            }
            preview = try plan(source, translation: translation); feedback = ""
            model.updateSnapFeedback(target: preview?.snapLine, fps: source.capture.fps)
        } catch { preview = nil; feedback = error.localizedDescription; model.endSnapFeedback() }
    }
    private func end(_ id: String, translation: CGSize) {
        defer { clearGesture() }
        guard let source = gesture, source.capture.lead == id else { return }
        #if os(iOS)
        guard source.interaction?.matches(currentInteractionLayout) == true else { cancelLayoutInteraction(); return }
        #endif
        guard matches(source.capture) else { model.status = "The project or selection changed during the edit. Try again."; return }
        do {
            let result = try plan(source, translation: translation)
            guard source.capture.hasChanges(result) else { return }
            model.editBatch(result.operations, summary: result.detail, expectedVersion: source.capture.version, feedback: true)
        } catch { model.status = error.localizedDescription }
    }
    private func verticalOffset(_ id: String) -> CGFloat {
        guard let source = gesture, source.capture.lead == id, let target = preview?.targetTrack,
              let a = source.rows.firstIndex(of: source.sourceTrack), let b = source.rows.firstIndex(of: target) else { return 0 }
        return CGFloat(b - a) * (rowHeight + 1)
    }
    private func shownClip(_ clip: NativeClip) -> NativeClip {
        var fields = clip.fields
        for (key, value) in preview?.clipFields[clip.id] ?? [:] { fields[key] = value }
        return NativeClip(fields: fields)
    }
    private func clearGesture() { gesture = nil; preview = nil; marquee = nil; feedback = ""; model.endSnapFeedback() }
    #if os(iOS)
    private func finishInterruptedScrub() {
        guard let source = rulerGesture, source.context == model.processingContextID else { return }
        model.scrub(model.time, finished: true)
    }
    private func cancelLayoutInteraction() {
        clearGesture()
        rulerCanceled = NativeTimelineInteractionPolicy.cancellationLatch(active: rulerGesture != nil, canceled: rulerCanceled)
        finishInterruptedScrub(); rulerGesture = nil
        magnifyCanceled = NativeTimelineInteractionPolicy.cancellationLatch(active: magnifyLayout != nil, canceled: magnifyCanceled)
        magnifyLayout = nil; initialZoom = nil
    }
    private func updateInteractionFrame(_ frame: CGRect) {
        if measuredInteractionFrame != frame { cancelLayoutInteraction(); measuredInteractionFrame = frame }
    }
    #endif
    private func updateMarquee(_ value: DragGesture.Value) {
        keyboardFocus = true
        guard value.startLocation.x.isFinite, value.startLocation.y.isFinite, value.location.x.isFinite, value.location.y.isFinite else { return }
        if marquee == nil {
            guard let fields = model.project?.fields, let state = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) else { return }
            var extending = extendingSelection
            #if os(macOS)
            extending = extending || NSEvent.modifierFlags.contains(.shift) || NSEvent.modifierFlags.contains(.command)
            #endif
            marquee = Marquee(start: value.startLocation, point: value.location, folder: model.folder, composition: model.composition,
                              version: model.version, zoom: model.zoom, state: state, tracks: displayTracks.map(\.fields), selection: model.selectedIDs, extending: extending)
        } else { marquee?.point = value.location }
    }
    private func endMarquee(_ value: DragGesture.Value) {
        defer { marquee = nil }
        guard let source = marquee, source.folder == model.folder, source.composition == model.composition, source.version == model.version,
              source.zoom == model.zoom, source.selection == model.selectedIDs, let fields = model.project?.fields,
              let current = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]), current == source.state else { return }
        let ids = NativeTimelinePlanning.marquee(tracks: source.tracks, x0: source.start.x, x1: value.location.x,
                                                y0: source.start.y, y1: value.location.y, zoom: source.zoom, rowHeight: rowHeight + 1)
        model.select(ids: source.extending ? source.selection.union(ids) : ids, primary: model.selectedID)
    }
    private func nudge(_ direction: Double) {
        guard let id = model.selectedID else { return }
        precisionNudge(id, direction: direction, edge: [.trim, .ripple, .roll].contains(mode) ? "right" : nil)
    }
    private func precisionNudge(_ id: String, direction: Double, edge: String?, mode requestedMode: NativeTimelineMode? = nil) {
        if !model.selectedIDs.contains(id) { selectClip(id, extending: false) }
        else if model.selectedID != id { model.select(ids: model.selectedIDs, primary: id) }
        do {
            let source = try capture(id, snapping: false)
            let chosenMode = requestedMode ?? mode
            let activeMode: NativeTimelineMode = edge == nil ? chosenMode : (chosenMode == .ripple || chosenMode == .roll ? chosenMode : .trim)
            let result = try source.plan(mode: activeMode, delta: direction / source.fps, edge: edge)
            guard matches(source), source.hasChanges(result) else { return }
            model.editBatch(result.operations, summary: result.detail, expectedVersion: source.version, feedback: true)
        } catch { model.status = error.localizedDescription }
    }
    private func splitSelection() {
        guard let id = model.selectedID else { return }
        do {
            let source = try capture(id)
            var operations: [[String: Any]] = [], seen = Set<String>()
            for clip in source.affectedSelection where model.time > clip.start && model.time < clip.end {
                let key = clip.link.isEmpty ? "id:\(clip.id)" : "link:\(clip.link)"
                if seen.insert(key).inserted { operations.append(["op": "blade", "id": clip.id, "at": model.time]) }
            }
            guard matches(source) else { return }
            model.editBatch(source.scoped(operations), summary: "Split selected clips", expectedVersion: source.version, feedback: true)
        } catch { model.status = error.localizedDescription }
    }
    private func deleteSelection(_ ripple: Bool) {
        guard let id = model.selectedID else { return }
        do {
            let source = try capture(id)
            guard matches(source) else { return }
            model.editBatch(source.scoped([["op": ripple ? "ripple_delete" : "delete", "ids": source.selected.sorted()]]), summary: ripple ? "Ripple delete selected clips" : "Delete selected clips", expectedVersion: source.version, feedback: true)
        } catch { model.status = error.localizedDescription }
    }
    private func editMotion(clip: NativeClip, context: UUID, version: Int, composition: String?) {
        guard model.processingContextID == context, model.version == version, model.composition == composition,
              let current = model.tracks.flatMap(\.clips).first(where: { $0.id == clip.id }),
              !["audio", "caption"].contains(current.kind),
              JSONSerialization.isValidJSONObject(clip.fields), JSONSerialization.isValidJSONObject(current.fields),
              let expected = try? JSONSerialization.data(withJSONObject: clip.fields, options: [.sortedKeys]),
              let actual = try? JSONSerialization.data(withJSONObject: current.fields, options: [.sortedKeys]), expected == actual else {
            model.status = "The project or clip changed. Open the clip menu again to edit motion."; return
        }
        model.showingSource = false
        model.select(current)
        openMotion()
    }

    private func clipAction(_ action: String, clip: NativeClip) {
        if action == "open" { model.composition = clip.fields.string("comp"); return }
        if !model.selectedIDs.contains(clip.id) { selectClip(clip.id, extending: false) }
        if action == "split" { splitSelection(); return }
        if action == "delete" || action == "ripple" { deleteSelection(action == "ripple"); return }
        do {
            let source = try capture(clip.id)
            let operation: [String: Any]
            if action == "duplicate" { operation = ["op": "duplicate", "id": clip.id, "start": clip.end] }
            else if action == "detach" { operation = ["op": "detach_audio", "id": clip.id] }
            else { operation = ["op": "precompose", "ids": source.selected.sorted(), "name": clip.name] }
            guard matches(source) else { return }
            model.editBatch(source.scoped([operation]), expectedVersion: source.version, feedback: true)
        } catch { model.status = error.localizedDescription }
    }
    // BEGIN NATIVE CANVAS COMMAND DISPATCH
    private func performCanvasCommand(_ command: NativeTimelineCanvasCommands.Action, permitted: Bool) -> KeyPress.Result {
        guard permitted else { return .ignored }
        switch command {
        case .copy, .cut, .paste:
            guard command == .paste ? model.canPasteTimelineClipboard : model.canCopyTimelineSelection,
                  let capture = model.clipboardActionCapture() else { return .ignored }
            if command == .paste { model.pasteTimelineClipboard(expected: capture) }
            else { model.copyTimelineSelection(cut: command == .cut, expected: capture) }
        case .matchFrame:
            guard model.canRequestMatchFrame else { return .ignored }
            do {
                let capture = try model.captureMatchFrame()
                model.matchFrame(capture)
            } catch { model.status = error.localizedDescription }
        }
        return .handled
    }
    // END NATIVE CANVAS COMMAND DISPATCH

    private func keyPress(_ press: KeyPress) -> KeyPress.Result {
        #if os(macOS)
        if let command = NativeTimelineCanvasCommands.action(characters: press.characters, modifiers: press.modifiers) {
            return performCanvasCommand(command, permitted: NativeTimelineCanvasCommands.focusedCanvas(keyboardFocus, owner: canvasFocusOwner))
        }
        #endif
        #if os(iOS)
        guard currentInteractionLayout.permitsInteraction else { return .ignored }
        if let command = NativeTimelineCanvasCommands.action(characters: press.characters, modifiers: press.modifiers) {
            return performCanvasCommand(command, permitted: keyboardFocus)
        }
        #endif
        if press.key == "a", press.modifiers.contains(.command) { selectAll(); return .handled }
        if press.key == .escape { model.select(id: nil); clearGesture(); return .handled }
        if press.key == .delete { deleteSelection(press.modifiers.contains(.shift)); return .handled }
        if press.key == .leftArrow || press.key == .rightArrow {
            nudge((press.key == .leftArrow ? -1 : 1) * (press.modifiers.contains(.shift) ? 10 : 1)); return .handled
        }
        guard press.modifiers.isEmpty else { return .ignored }
        switch press.characters.lowercased() {
        case "s": snapping.toggle()
        case "v": mode = .move
        case "t": mode = .trim
        case "r": mode = .ripple
        case "o": mode = .roll
        case "y": mode = .slip
        case "u": mode = .slide
        default: return .ignored
        }
        return .handled
    }

    private func trackHeader(_ track: NativeTrack) -> some View {
        #if os(iOS)
        let deletion = NativeTrackDeletion(track: track, model: model)
        let states = NativeTrackStatus.items(muted: track.fields.flag("muted"), solo: track.fields.flag("solo"),
                                             locked: track.locked, hidden: track.fields.flag("hidden"))
        return Menu {
            Button(track.fields.flag("muted") ? "Unmute" : "Mute") { model.edit(["op": "update_track", "id": track.id, "set": ["muted": !track.fields.flag("muted")]]) }
            Button(track.fields.flag("solo") ? "Unsolo" : "Solo") { model.edit(["op": "update_track", "id": track.id, "set": ["solo": !track.fields.flag("solo")]]) }
            Button(track.locked ? "Unlock" : "Lock") { model.edit(["op": "update_track", "id": track.id, "set": ["locked": !track.locked]]) }
            Button(track.fields.flag("hidden") ? "Show" : "Hide") { model.edit(["op": "update_track", "id": track.id, "set": ["hidden": !track.fields.flag("hidden")]]) }
            Button("Close gaps") { model.edit(["op": "close_gaps", "track": track.id]) }.disabled(track.locked)
            Button("Delete track", role: .destructive) { deletion?.delete(model: model) }
                .disabled(deletion == nil)
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(track.name).font(.caption).lineLimit(2)
                if !states.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(states, id: \.name) { state in
                            Image(systemName: state.symbol).font(.system(size: 9, weight: .semibold))
                        }
                    }.foregroundStyle(NativeEditorStyle.accent).accessibilityHidden(true)
                }
            }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 6)
        }
        .accessibilityLabel("Track \(track.name)")
        .accessibilityValue(NativeTrackStatus.accessibilityValue(states))
        .accessibilityHint("Opens track controls")
        #else
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(track.id).font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(track.kind == "audio" ? .green : .blue)
                Text(track.name).font(.caption).lineLimit(1)
            }
            HStack(spacing: 9) {
                trackToggle(track, "muted", "speaker.slash")
                trackToggle(track, "solo", "headphones")
                trackToggle(track, "locked", "lock")
            }
        }.padding(.horizontal, 6).frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            Button(track.fields.flag("hidden") ? "Show track" : "Hide track") { model.edit(["op": "update_track", "id": track.id, "set": ["hidden": !track.fields.flag("hidden")]]) }
            Button("Close gaps") { model.edit(["op": "close_gaps", "track": track.id]) }.disabled(track.locked)
            Button("Delete track", role: .destructive) { model.edit(["op": "delete_track", "id": track.id]) }
        }
        #endif
    }
    private func trackToggle(_ track: NativeTrack, _ key: String, _ icon: String) -> some View {
        Button { model.edit(["op": "update_track", "id": track.id, "set": [key: !track.fields.flag(key)]]) } label: {
            Image(systemName: icon).font(.system(size: 10)).foregroundStyle(track.fields.flag(key) ? NativeEditorStyle.accent : Color.secondary)
        }.buttonStyle(.plain).frame(width: 25, height: 25)
            .background(track.fields.flag(key) ? NativeEditorStyle.accent.opacity(0.15) : NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 4))
            .help(key == "muted" ? (track.fields.flag(key) ? "Unmute track" : "Mute track") : key == "locked" ? (track.locked ? "Unlock track" : "Lock track") : (track.fields.flag(key) ? "Disable solo" : "Solo track"))
            .accessibilityLabel("\(track.name) \(key)")
    }
}

private struct NativeTimelineToolbar: View {
    @ObservedObject var model: NativeEditorModel
    @Binding var mode: NativeTimelineMode
    @Binding var snapping: Bool
    @Binding var extending: Bool
    let detail: String
    let selectAll: () -> Void
    let split: () -> Void
    let delete: (Bool) -> Void
    let nudge: (Double) -> Void
    @State private var multicamVisible = false
    @State private var markerRequest: NativeTimelineMarkerRequest?
    #if os(iOS)
    @ScaledMetric(relativeTo: .subheadline) private var toolbarHeight: CGFloat = 44
    #endif

    private func openMarkers(adding: Bool) {
        guard let request = NativeTimelineMarkerRequest(model: model, adding: adding) else {
            model.status = "Open an editable timeline before managing markers."
            return
        }
        markerRequest = request
    }

    private func markRange(_ action: String) {
        guard let fields = model.project?.fields,
              let operation = NativeTimelineRangeMarks.operation(action, fields: fields, composition: model.composition, time: model.time, duration: model.duration, fps: model.fps) else { return }
        model.edit(operation)
    }

    var body: some View {
        let clipboardCapture = model.clipboardActionCapture()
        let matchFrame = Result { try model.captureMatchFrame() }
        Group {
        #if os(iOS)
        HStack(spacing: 6) {
            Menu {
                ForEach(NativeTimelineMode.allCases, id: \.self) { item in
                    Button { mode = item } label: {
                        Label(item.rawValue, systemImage: item == mode ? "checkmark" : "cursorarrow.motionlines")
                    }
                }
                Section("Touch editing") {
                    Text("Tap a clip to select it. Swipe to scroll the timeline.")
                    Text("Hold a clip or its edge, then drag to edit. Pinch to zoom.")
                    Text("The frame buttons make precise edits. Trim modes also provide Start and End controls for short clips.")
                }
            } label: {
                HStack(spacing: 4) {
                    Text(mode.rawValue).lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption2).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
                .accessibilityLabel("Timeline edit mode").accessibilityValue(mode.rawValue)
                .accessibilityHint("Choose an edit mode or read how to use timeline gestures")
                .accessibilityIdentifier("timeline.editMode")
            Button(action: split) { Image(systemName: "scissors") }
                .disabled(model.selectedIDs.isEmpty).accessibilityLabel("Split selected clips at playhead")
                .accessibilityIdentifier("timeline.split")
            Button { delete(false) } label: { Image(systemName: "trash") }
                .disabled(model.selectedIDs.isEmpty).accessibilityLabel("Delete selected clips")
                .accessibilityHint("Leaves a gap. Undo restores the deleted clips.")
                .accessibilityIdentifier("timeline.delete")
            Menu {
                Section("Selection") {
                    Toggle("Snap to edges, markers and playhead", isOn: $snapping)
                    Toggle("Select multiple clips", isOn: $extending)
                    Button("Select all clips", action: selectAll)
                    Button("Clear selection") { model.select(id: nil) }
                    Button("Ripple delete selected clips") { delete(true) }.disabled(model.selectedIDs.isEmpty)
                    Button("Nudge edit left one frame") { nudge(-1) }.disabled(model.selectedIDs.isEmpty)
                    Button("Nudge edit right one frame") { nudge(1) }.disabled(model.selectedIDs.isEmpty)
                }
                Section("Clipboard") {
                    Button("Copy selection") { if let clipboardCapture { model.copyTimelineSelection(expected: clipboardCapture) } }.disabled(clipboardCapture == nil || !model.canCopyTimelineSelection)
                    Button("Cut selection") { if let clipboardCapture { model.copyTimelineSelection(cut: true, expected: clipboardCapture) } }.disabled(clipboardCapture == nil || !model.canCopyTimelineSelection)
                    Button("Paste at playhead") { if let clipboardCapture { model.pasteTimelineClipboard(expected: clipboardCapture) } }.disabled(clipboardCapture == nil || !model.canPasteTimelineClipboard)
                }
                Section("Source and markers") {
                    Button {
                        do { model.matchFrame(try matchFrame.get()) } catch { model.status = error.localizedDescription }
                    } label: { Label("Match Frame", systemImage: "arrow.up.right") }
                        .disabled(!model.canRequestMatchFrame)
                        .accessibilityIdentifier("editor.matchFrame.toolbar")
                    Button { openMarkers(adding: false) } label: { Label("Markers", systemImage: "bookmark") }
                        .disabled(model.project == nil || model.projectReadOnlyReason != nil || model.busy || model.showingSource)
                        .accessibilityIdentifier("editor.marker.toolbar")
                    Button("Add marker") { openMarkers(adding: true) }
                    Button("Set range start") { markRange("start") }
                    Button("Set range end") { markRange("end") }
                    Button("Clear range") { markRange("clear") }
                }
                Section("Tracks") {
                    Button { multicamVisible = true } label: { Label("Multicam", systemImage: "square.grid.2x2") }.disabled(model.project == nil)
                    Button("Add video track") { model.edit(["op": "add_track", "kind": "video"]) }
                    Button("Add audio track") { model.edit(["op": "add_track", "kind": "audio"]) }
                }
                Section("Timeline view") {
                    Text("Playhead \(nativeTimecode(model.time, fps: model.fps))")
                    Text(detail)
                    Button { model.zoom = max(10, model.zoom / 1.4) } label: { Label("Zoom out", systemImage: "minus.magnifyingglass") }
                    Button { model.zoom = min(800, model.zoom * 1.4) } label: { Label("Zoom in", systemImage: "plus.magnifyingglass") }
                }
            } label: { Image(systemName: "ellipsis") }
                .accessibilityLabel("More timeline actions")
                .accessibilityIdentifier("timeline.more")
        }.buttonStyle(NativeToolbarButtonStyle()).padding(.horizontal, 8)
        #else
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Text(nativeTimecode(model.time, fps: model.fps)).font(.system(size: 11, weight: .semibold, design: .monospaced)).foregroundStyle(NativeEditorStyle.text)
                Button {
                    do { model.matchFrame(try matchFrame.get()) } catch { model.status = error.localizedDescription }
                } label: { Label("Match Frame", systemImage: "arrow.up.right") }
                    .disabled(!model.canRequestMatchFrame).help("Pause and place the playhead inside the primary selected source clip, then open that frame in the source viewer.")
                    .accessibilityIdentifier("editor.matchFrame.toolbar")
                Menu {
                    ForEach(NativeTimelineMode.allCases, id: \.self) { item in Button(item.rawValue) { mode = item } }
                } label: { Label(mode.rawValue, systemImage: "cursorarrow.motionlines") }.help(mode.hint)
                Button { snapping.toggle() } label: { Label("Snap", systemImage: "dot.scope") }.buttonStyle(NativeToolbarButtonStyle(selected: snapping)).help("Snap to clip edges, markers and playhead. S toggles snapping. Edits always align to frames.")
                Button { extending.toggle() } label: { Label("Multi", systemImage: "checkmark.circle") }.buttonStyle(NativeToolbarButtonStyle(selected: extending)).help("Tap clips to add or remove them from the selection. Shift or Command click also selects multiple clips.")
                Menu {
                    Button("Copy selection") { if let clipboardCapture { model.copyTimelineSelection(expected: clipboardCapture) } }.disabled(clipboardCapture == nil || !model.canCopyTimelineSelection)
                    Button("Cut selection") { if let clipboardCapture { model.copyTimelineSelection(cut: true, expected: clipboardCapture) } }.disabled(clipboardCapture == nil || !model.canCopyTimelineSelection)
                    Button("Paste at playhead") { if let clipboardCapture { model.pasteTimelineClipboard(expected: clipboardCapture) } }.disabled(clipboardCapture == nil || !model.canPasteTimelineClipboard)
                } label: { Label("Clipboard", systemImage: "doc.on.clipboard") }.help("Copy or cut selected and linked clips; paste at the timeline playhead")
                Button { openMarkers(adding: false) } label: { Label("Markers", systemImage: "bookmark") }
                    .disabled(model.project == nil || model.projectReadOnlyReason != nil || model.busy || model.showingSource)
                    .help("Add, rename, move or delete markers in the active timeline")
                    .accessibilityIdentifier("editor.marker.toolbar")
                Button { multicamVisible = true } label: { Label("Multicam", systemImage: "square.grid.2x2") }.disabled(model.project == nil).help("Create multicam from imported camera sources")
                Button(action: split) { Image(systemName: "scissors") }.disabled(model.selectedIDs.isEmpty).help("Split selected clips at the playhead")
                Button { delete(false) } label: { Image(systemName: "trash") }.disabled(model.selectedIDs.isEmpty).help("Delete selected clips")
                Menu {
                    Button("Select all clips", action: selectAll)
                    Button("Clear selection") { model.select(id: nil) }
                    Button("Ripple delete selected clips") { delete(true) }.disabled(model.selectedIDs.isEmpty)
                    Button("Nudge edit left one frame") { nudge(-1) }.disabled(model.selectedIDs.isEmpty)
                    Button("Nudge edit right one frame") { nudge(1) }.disabled(model.selectedIDs.isEmpty)
                    Button("Add video track") { model.edit(["op": "add_track", "kind": "video"]) }
                    Button("Add audio track") { model.edit(["op": "add_track", "kind": "audio"]) }
                    Button("Add marker") { openMarkers(adding: true) }
                    Button("Set range start") { markRange("start") }
                    Button("Set range end") { markRange("end") }
                    Button("Clear range") { markRange("clear") }
                } label: { Image(systemName: "ellipsis") }
                Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1).frame(minWidth: 70, maxWidth: 250, alignment: .leading)
                Button { model.zoom = max(10, model.zoom / 1.4) } label: { Image(systemName: "minus.magnifyingglass") }.help("Zoom out")
                Button { model.zoom = min(800, model.zoom * 1.4) } label: { Image(systemName: "plus.magnifyingglass") }.help("Zoom in")
            }.font(.caption).buttonStyle(NativeToolbarButtonStyle()).padding(.horizontal, 8)
        }
        #endif
        }
        #if os(iOS)
        .frame(height: max(44, toolbarHeight))
        #else
        .frame(height: 44)
        #endif
        .background(NativeEditorStyle.panel)
        .sheet(isPresented: $multicamVisible) { NativeMulticamPanel(model: model) }
        .sheet(item: $markerRequest) { request in NativeTimelineMarkerPanel(model: model, request: request) }
    }
}

private struct NativeTimelineMarkerRequest: Identifiable {
    let id = UUID()
    let context: UUID
    let backend: ObjectIdentifier
    let folder: String
    let composition: String?
    let scopeName: String
    let initialDraft: NativeTimelineMarkerCapture?

    @MainActor
    init?(model: NativeEditorModel, adding: Bool) {
        guard let folder = model.folder?.standardizedFileURL.path, let backend = model.renderPreviewBackendID,
              let fields = model.project?.fields,
              let scope = NativeTimelineMarkerEditing.scope(fields, composition: model.composition),
              !model.busy, !model.showingSource, model.projectReadOnlyReason == nil else { return nil }
        let draft = adding ? NativeTimelineMarkerCapture(model: model) : nil
        if adding && draft == nil { return nil }
        context = model.processingContextID; self.backend = backend; self.folder = folder
        composition = model.composition; scopeName = composition == nil ? "Main timeline" : scope.string("name", "Composition")
        initialDraft = draft
    }
    @MainActor
    func ownsScope(model: NativeEditorModel) -> Bool {
        guard let backend = model.renderPreviewBackendID else { return false }
        return model.processingContextID == context && backend == self.backend &&
            model.folder?.standardizedFileURL.path == folder && model.composition == composition
    }
}

private struct NativeTimelineMarkerPanel: View {
    @ObservedObject var model: NativeEditorModel
    let request: NativeTimelineMarkerRequest
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var draft: NativeTimelineMarkerCapture?
    @State private var label: String
    @State private var frameText: String
    @State private var deletion: NativeTimelineMarkerCapture?
    @State private var deletionVisible = false
    @State private var committing = false
    @State private var message = ""
    @State private var commitTask: Task<Void, Never>?

    init(model: NativeEditorModel, request: NativeTimelineMarkerRequest) {
        self.model = model; self.request = request
        _draft = State(initialValue: request.initialDraft)
        _label = State(initialValue: request.initialDraft?.initialLabel ?? "")
        _frameText = State(initialValue: request.initialDraft.map { String($0.initialFrame) } ?? "")
    }
    private var ownsScope: Bool { request.ownsScope(model: model) }
    private var editable: Bool { ownsScope && !model.busy && !model.showingSource && model.projectReadOnlyReason == nil && !committing }
    private var markers: [[String: Any]] {
        NativeTimelineMarkerEditing.markers(model.project?.fields ?? [:], composition: request.composition)
    }
    private var fps: Double {
        guard let fields = model.project?.fields,
              let scope = NativeTimelineMarkerEditing.scope(fields, composition: request.composition) else { return .nan }
        return NativeTimelineMarkerEditing.number(scope, "fps", fallback: NativeTimelineMarkerEditing.number(fields, "fps", fallback: 30))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Markers").font(.headline)
                Spacer()
                Button("Done") { dismiss() }.frame(minWidth: 44, minHeight: 44)
                    .keyboardShortcut(.cancelAction).disabled(committing)
            }.padding(.horizontal, 16)
            Text(request.scopeName).font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 16).padding(.bottom, 12)
            Divider()
            if !ownsScope {
                Text("The project or composition changed. Close this sheet and open Markers again.")
                    .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else if let draft {
                editor(draft)
            } else {
                markerList
            }
            if !message.isEmpty {
                Text(message).font(.callout).foregroundStyle(.secondary).padding(16)
                    .accessibilityIdentifier("editor.marker.message")
            }
        }
        .background(NativeEditorStyle.panel)
        #if os(iOS)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        #else
        .frame(minWidth: 360, idealWidth: 480, maxWidth: 640, minHeight: 400, idealHeight: 540, maxHeight: 720)
        #endif
        .interactiveDismissDisabled(committing)
        .transaction { transaction in if reduceMotion { transaction.disablesAnimations = true } }
        .confirmationDialog("Delete marker?", isPresented: $deletionVisible, titleVisibility: .visible, presenting: deletion) { capture in
            Button("Delete marker", role: .destructive) {
                if let operation = capture.operation(label: "", frameText: "", deleting: true) { commit(capture, operation: operation) }
            }
            Button("Cancel", role: .cancel) { deletion = nil }
        } message: { _ in
            Text("Delete this marker from \(request.scopeName)? You can restore it with Undo.")
        }
        .onDisappear { commitTask?.cancel() }
    }

    private var markerList: some View {
        VStack(alignment: .leading, spacing: 0) {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 0) { addButton; historyButtons }
                } else {
                    HStack(spacing: 12) { addButton; Spacer(minLength: 0); historyButtons }
                }
            }.padding(.horizontal, 16)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if markers.isEmpty {
                        Text("No markers in \(request.scopeName). Add one at the playhead.").foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 16)
                    }
                    ForEach(markers.indices, id: \.self) { index in markerRow(markers[index]) }
                }.padding(.horizontal, 16).padding(.bottom, 16)
            }
        }
    }
    private var addButton: some View {
        Button { begin(nil) } label: { Label("Add marker", systemImage: "plus") }
            .frame(minHeight: 44).accessibilityIdentifier("editor.marker.add").disabled(!editable)
    }
    private var historyButtons: some View {
        HStack(spacing: 12) {
            Button("Undo") { model.undo() }.frame(minWidth: 44, minHeight: 44).disabled(!editable)
            Button("Redo") { model.undo(redo: true) }.frame(minWidth: 44, minHeight: 44).disabled(!editable)
        }
    }
    private func markerRow(_ marker: [String: Any]) -> some View {
        let name = marker.string("label").isEmpty ? "Untitled marker" : marker.string("label")
        let time = NativeTimelineMarkerEditing.number(marker, "t")
        let frame = NativeTimelineMarkerEditing.frame(time, fps: fps)
        return HStack(spacing: 8) {
            Button { model.scrub(time, finished: true) } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(name).lineLimit(2).multilineTextAlignment(.leading)
                    Text(frame.map { "Frame \($0), \(nativeTimecode(time, fps: fps))" } ?? "Invalid marker time")
                        .font(.caption).monospacedDigit().foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(frame == nil || !ownsScope || committing)
                .accessibilityLabel("\(name), \(frame.map { "frame \($0)" } ?? "invalid time")")
                .accessibilityHint("Move the playhead to this marker. Open its menu to edit or delete it.")
                .contextMenu {
                    Button("Edit marker") { begin(marker.string("id")) }.disabled(!editable)
                    Button("Delete marker", role: .destructive) { confirmDelete(marker.string("id")) }.disabled(!editable)
                }
            Button("Edit") { begin(marker.string("id")) }.frame(minWidth: 44, minHeight: 44)
                .disabled(!editable).accessibilityLabel("Edit marker \(name)")
        }
        .padding(.horizontal, 12).background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 8))
    }
    private func editor(_ capture: NativeTimelineMarkerCapture) -> some View {
        let frame = NativeTimelineMarkerEditing.parseFrame(frameText, fps: capture.fps)
        let operation = capture.operation(label: label, frameText: frameText)
        let current = capture.matches(model: model)
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(capture.markerID == nil ? "Add marker" : "Edit marker").font(.headline)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Label").font(.subheadline)
                    TextField("Marker label", text: $label).textFieldStyle(.roundedBorder).frame(minHeight: 44)
                        .accessibilityLabel("Marker label").accessibilityIdentifier("editor.marker.label")
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Frame position").font(.subheadline)
                    TextField("Frame number", text: $frameText).textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced)).frame(minHeight: 44)
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        #endif
                        .accessibilityLabel("Marker frame position, zero is the first frame")
                        .accessibilityIdentifier("editor.marker.frame")
                    if let frame, let time = NativeTimelineMarkerEditing.time(frame, fps: capture.fps) {
                        Text("\(nativeTimecode(time, fps: capture.fps)) at \(String(format: "%g", capture.fps)) fps")
                            .font(.caption).monospacedDigit().foregroundStyle(.secondary)
                    } else {
                        Text("Enter a whole frame number between 0 and \(NativeTimelineMarkerEditing.maximumFrame).")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if !current && !committing {
                    Text("This marker or project changed. Cancel this edit and select the marker again.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                HStack(spacing: 12) {
                    Button("Cancel edit") { draft = nil; message = "" }.frame(minWidth: 44, minHeight: 44).disabled(committing)
                    Spacer(minLength: 0)
                    Button(capture.markerID == nil ? "Add" : "Save") {
                        if let operation { commit(capture, operation: operation) }
                    }.frame(minWidth: 44, minHeight: 44).keyboardShortcut(.defaultAction)
                        .disabled(!editable || !current || operation == nil)
                        .accessibilityIdentifier("editor.marker.save")
                }
                if let markerID = capture.markerID {
                    Button("Delete marker", role: .destructive) { confirmDelete(markerID) }
                        .frame(minHeight: 44).disabled(!editable || !current)
                        .accessibilityIdentifier("editor.marker.delete")
                }
                if committing { Text("Waiting for the project to confirm this change...").font(.callout).foregroundStyle(.secondary) }
            }.padding(16).disabled(committing)
        }
    }
    private func begin(_ markerID: String?) {
        guard editable, let capture = NativeTimelineMarkerCapture(model: model, markerID: markerID) else {
            message = "This marker or project is unavailable for editing. Refresh the project and try again."
            return
        }
        draft = capture; label = capture.initialLabel; frameText = String(capture.initialFrame); message = ""
    }
    private func confirmDelete(_ markerID: String) {
        guard editable, let capture = NativeTimelineMarkerCapture(model: model, markerID: markerID) else {
            message = "This marker changed. Select it again before deleting it."
            return
        }
        deletion = capture; deletionVisible = true
    }
    private func commit(_ capture: NativeTimelineMarkerCapture, operation: [String: Any]) {
        guard editable, capture.matches(model: model) else {
            message = "This marker or project changed. Select the marker again."
            return
        }
        committing = true; message = ""
        commitTask = Task { @MainActor in
            defer { committing = false; commitTask = nil }
            do {
                try await model.commitMarkerEdit(operation, capture: capture)
                guard ownsScope, !Task.isCancelled else { return }
                draft = nil; deletion = nil
            } catch is CancellationError { }
            catch {
                guard ownsScope, !Task.isCancelled else { return }
                message = error.localizedDescription
            }
        }
    }
}


private struct NativeTimelineClip: View {
    let clip: NativeClip
    let track: NativeTrack
    @ObservedObject var model: NativeEditorModel
    let mode: NativeTimelineMode
    let select: () -> Void
    let extend: () -> Void
    let begin: (String?, Int) -> Void
    let update: (CGSize) -> Void
    let end: (CGSize) -> Void
    let cancel: () -> Void
    let precise: (Double, String?, NativeTimelineMode) -> Void
    let action: (String) -> Void
    @State private var peaks: [Double] = []
    @State private var peaksPerSecond: Double = 100
    @State private var thumbnails: [CGImage] = []
    @State private var thumbnailInterval: Double = 1
    @State private var bodyStarted = false
    @State private var edgeStarted: String?
    #if os(iOS)
    @State private var touchStarted = false
    @State private var touchCanceled = false
    @State private var touchLayout: NativeTimelineInteractionCapture?
    @GestureState private var touchActive = false
    fileprivate var interactionLayout: NativeTimelineInteractionCapture?
    fileprivate var armedEditLabel: String? = nil
    #endif
    private var selected: Bool { model.selectedIDs.contains(clip.id) }
    private var inlineEdges: Bool {
        #if os(iOS)
        return NativeTimelineTouchGeometry.inlineEdges(clipWidth: clip.duration * model.zoom)
        #else
        return true
        #endif
    }
    private var color: Color {
        switch clip.kind {
        case "audio": NativeEditorStyle.clipAudio
        case "title", "caption", "shape": NativeEditorStyle.clipTitle
        case "image": NativeEditorStyle.clipImage
        case "color": NativeEditorStyle.clipColor
        case "adjustment": NativeEditorStyle.clipAdjustment
        case "comp": NativeEditorStyle.clipComposition
        default: NativeEditorStyle.clipVideo
        }
    }
    private var mediaKey: String {
        let asset = model.project?.fields.dictionary("assets").dictionary(clip.source) ?? [:]
        let data = (try? JSONSerialization.data(withJSONObject: asset, options: [.sortedKeys])) ?? Data()
        return "\(model.folder?.path ?? "")|\(clip.kind)|\(clip.source)|\(data.base64EncodedString())"
    }

    private var graphicLabel: some View {
        let symbol: String = clip.kind == "shape" ? "square.on.circle" : "textformat"
        let text: String = clip.fields.dictionary("title").string("text", clip.fields.string("text", clip.name))
        return HStack(spacing: 5) {
            Image(systemName: symbol)
            Text(text).lineLimit(1)
            Spacer(minLength: 0)
        }.font(.caption).foregroundStyle(.white.opacity(0.8)).padding(.horizontal, 8).frame(maxHeight: .infinity)
    }

    private var clipHeader: some View {
        Text(clip.name).font(.caption2.weight(.semibold)).foregroundStyle(.white).lineLimit(1).padding(.horizontal, 8)
            .frame(maxWidth: .infinity, minHeight: 20, alignment: .leading).background(color.opacity(0.9))
    }

    private var clipContent: some View {
        VStack(spacing: 0) {
            clipHeader
            if ["title", "caption", "shape"].contains(clip.kind) {
                graphicLabel
            } else { Spacer(minLength: 0) }
        }.clipShape(RoundedRectangle(cornerRadius: 4)).allowsHitTesting(false)
    }

    private func clipRendering(renderedVersion: Int) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4).fill(color.opacity(selected ? 0.8 : 0.5))
            NativeTimelineClipMedia(clip: clip, zoom: model.zoom, thumbnails: thumbnails, interval: thumbnailInterval, peaks: peaks, peaksPerSecond: peaksPerSecond)
            RoundedRectangle(cornerRadius: 4).stroke(selected ? NativeEditorStyle.accent : color.opacity(0.6), lineWidth: selected ? 2 : 1)
            clipContent
            if selected, !track.locked, ![.slip, .slide].contains(mode), inlineEdges {
                edgeHandles(renderedVersion: renderedVersion)
            }
            #if os(iOS)
            if let armedEditLabel { armedEditTreatment(armedEditLabel) }
            #endif
        }
    }

    var body: some View {
        let renderedVersion = model.version
        let clipboardCapture = model.clipboardActionCapture()
        let matchFrame = clip.id == model.selectedID ? Result { try model.captureMatchFrame() } : nil
        let rendering = clipRendering(renderedVersion: renderedVersion)
        let interactive = clipInteraction(rendering, renderedVersion: renderedVersion, clipboardCapture: clipboardCapture, matchFrame: matchFrame)
        let touch = clipTouchHandlers(interactive)
        let accessible = clipAccessibility(touch)
        clipSharedModifiers(accessible)
    }
    @ViewBuilder
    private func clipContextMenu(clipboardCapture: NativeClipboardActionCapture?, matchFrame: Result<NativeMatchFrame.Capture, Error>?) -> some View {
        Button(selected ? "Remove from selection" : "Add to selection", action: extend)
        if !["audio", "caption"].contains(clip.kind) { Button("Edit motion") { action("motion") } }
        Button("Split selection at playhead") { action("split") }
        Button("Copy") { if let clipboardCapture { model.copyTimelineSelection(expected: clipboardCapture, targetID: clip.id) } }.disabled(clipboardCapture == nil)
        Button("Cut") { if let clipboardCapture { model.copyTimelineSelection(cut: true, expected: clipboardCapture, targetID: clip.id) } }.disabled(clipboardCapture == nil)
        Button("Paste at playhead") { if let clipboardCapture { model.pasteTimelineClipboard(expected: clipboardCapture) } }.disabled(clipboardCapture == nil || !model.canPasteTimelineClipboard)
        Button("Duplicate clip") { action("duplicate") }
        if clip.kind == "comp" { Button("Open composition") { action("open") } }
        Button("Precompose selection") { action("precompose") }
        if clip.kind == "video" { Button("Detach audio") { action("detach") } }
        Button("Match Frame") {
            if let matchFrame {
                do { model.matchFrame(try matchFrame.get()) } catch { model.status = error.localizedDescription }
            }
        }
            .disabled(clip.id != model.selectedID || !model.canRequestMatchFrame).accessibilityIdentifier("editor.matchFrame.context")
        Button("Delete selection", role: .destructive) { action("delete") }
        Button("Ripple delete selection", role: .destructive) { action("ripple") }
    }

    private func clipInteraction<Content: View>(_ content: Content, renderedVersion: Int, clipboardCapture: NativeClipboardActionCapture?, matchFrame: Result<NativeMatchFrame.Capture, Error>?) -> some View {
        return content
        .contentShape(Rectangle()).onTapGesture(perform: select)
        .gesture(clipDrag(renderedVersion: renderedVersion))
        .contextMenu {
            clipContextMenu(clipboardCapture: clipboardCapture, matchFrame: matchFrame)
        }
    }

    private func clipTouchHandlers<Content: View>(_ content: Content) -> some View {
        #if os(iOS)
        return content
        .onChange(of: interactionLayout) { _, _ in
            if touchActive || touchStarted || touchLayout != nil { touchCanceled = true; cancel() }
        }
        .onChange(of: touchActive) { _, active in
            if !active {
                if touchStarted { cancel() }
                touchStarted = false; touchCanceled = false; touchLayout = nil
            }
        }
        #else
        return content
        #endif
    }

    private func clipAccessibility<Content: View>(_ content: Content) -> some View {
        let accessible = content
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isButton)
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityAction { select() }
        #if os(iOS)
        return accessible
        .accessibilityValue(armedEditLabel.map { "\($0) armed" } ?? "")
        .accessibilityHint(track.locked ? "Locked track. Unlock it from the track menu before editing." : "Swipe to scroll. Hold then drag to edit. Select this clip for Start and End precision controls.")
        .accessibilityAction(named: Text("Move earlier by one frame")) { precise(-1, nil, .move) }
        .accessibilityAction(named: Text("Move later by one frame")) { precise(1, nil, .move) }
        .accessibilityAction(named: Text("Trim start earlier by one frame")) { precise(-1, "left", .trim) }
        .accessibilityAction(named: Text("Trim start later by one frame")) { precise(1, "left", .trim) }
        .accessibilityAction(named: Text("Trim end earlier by one frame")) { precise(-1, "right", .trim) }
        .accessibilityAction(named: Text("Trim end later by one frame")) { precise(1, "right", .trim) }
        #else
        return accessible
        #endif
    }

    private func clipSharedModifiers<Content: View>(_ content: Content) -> some View {
        return content
        .accessibilityLabel("\(clip.name), \(clip.start.formatted()) seconds, \(clip.duration.formatted()) seconds, \(selected ? "selected" : "not selected")")
        .accessibilityAction(named: Text(selected ? "Remove from selection" : "Add to selection"), extend)
        .task(id: mediaKey) { await loadMedia(key: mediaKey) }
    }

    private func edgeHandles(renderedVersion: Int) -> some View {
        HStack(spacing: 0) {
            edge("left", renderedVersion: renderedVersion)
            Spacer(minLength: 0)
            edge("right", renderedVersion: renderedVersion)
        }
    }
    private func edge(_ edge: String, renderedVersion: Int) -> some View {
        Capsule().fill(.white.opacity(0.85)).frame(width: 3, height: 22)
            #if os(iOS)
            .frame(width: 44, height: 44).contentShape(Rectangle())
            #else
            .frame(width: min(44, max(4, clip.duration * model.zoom / 2)), height: 44).contentShape(Rectangle())
            #endif
            .highPriorityGesture(edgeDrag(edge, renderedVersion: renderedVersion))
            .accessibilityLabel("\(mode == .roll ? "Roll" : mode == .ripple ? "Ripple trim" : "Trim") \(edge) edge")
    }
    private func clipDrag(renderedVersion: Int) -> some Gesture {
        #if os(iOS)
        return touchDrag(edge: nil, renderedVersion: renderedVersion)
        #else
        return DragGesture(minimumDistance: 5, coordinateSpace: .named("nativeTimelineRows")).onChanged { value in
            if !bodyStarted { bodyStarted = true; begin(nil, renderedVersion) }
            update(value.translation)
        }.onEnded { value in end(value.translation); bodyStarted = false }
        #endif
    }
    private func edgeDrag(_ edge: String, renderedVersion: Int) -> some Gesture {
        #if os(iOS)
        return touchDrag(edge: edge, renderedVersion: renderedVersion)
        #else
        return DragGesture(minimumDistance: 1, coordinateSpace: .named("nativeTimelineRows")).onChanged { value in
                if edgeStarted == nil { edgeStarted = edge; begin(edge, renderedVersion) }
                update(value.translation)
            }.onEnded { value in end(value.translation); edgeStarted = nil }
        #endif
    }
    #if os(iOS)
    fileprivate func timelineInteractionLayout(_ layout: NativeTimelineInteractionCapture) -> Self {
        var view = self; view.interactionLayout = layout; return view
    }
    fileprivate func timelineArmedEditLabel(_ label: String?) -> Self {
        var view = self; view.armedEditLabel = label; return view
    }
    private func armedEditTreatment(_ action: String) -> some View {
        let width = max(8, clip.duration * model.zoom)
        return ZStack(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: 4).strokeBorder(Color.orange, lineWidth: 2)
            if width >= NativeTimelineTouchGeometry.target * 3 {
                Label(action, systemImage: "hand.raised.fill").lineLimit(1)
                    .padding(4).background(Color.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 3))
            } else if width >= NativeTimelineTouchGeometry.target {
                Image(systemName: "hand.raised.fill")
                    .padding(4).background(Color.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 3))
            }
        }.font(.caption2.weight(.semibold)).foregroundStyle(Color.orange)
            .clipShape(RoundedRectangle(cornerRadius: 4)).allowsHitTesting(false).accessibilityHidden(true)
            .transaction { transaction in transaction.animation = nil }
    }
    private func touchDrag(edge: String?, renderedVersion: Int) -> some Gesture {
        LongPressGesture(minimumDuration: NativeTimelineTouchGeometry.holdDuration, maximumDistance: NativeTimelineTouchGeometry.holdDistance)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named("nativeTimelineRows")))
            .updating($touchActive) { value, active, _ in
                switch value {
                case .first(true), .second(true, _): active = true
                default: break
                }
            }
            .onChanged { value in
                guard !touchCanceled else { return }
                if touchLayout == nil { touchLayout = interactionLayout }
                guard let source = touchLayout, let current = interactionLayout, source.matches(current) else {
                    touchCanceled = true; cancel(); return
                }
                guard case .second(true, let drag) = value, let drag else { return }
                if !touchStarted { touchStarted = true; begin(edge, renderedVersion) }
                update(drag.translation)
            }
            .onEnded { value in
                defer { touchStarted = false; touchCanceled = false; touchLayout = nil }
                guard !touchCanceled, let source = touchLayout, let current = interactionLayout, source.matches(current) else { cancel(); return }
                guard touchStarted, case .second(true, let drag) = value, let drag else { cancel(); return }
                end(drag.translation)
            }
    }
    #endif
    private func loadMedia(key: String) async {
        peaks = []; thumbnails = []
        guard !clip.source.isEmpty else { return }
        let folder = model.folder
        do {
            if clip.kind == "audio" {
                let result = try await model.call(nativeQuery("/api/peaks", ["src": clip.source]))
                guard !Task.isCancelled, folder == model.folder, key == mediaKey else { return }
                let source = result["peaks"] as? [NSNumber] ?? []
                let rate = result.number("perSec", 100)
                guard rate.isFinite, rate > 0 else { return }
                let strideSize = max(1, Int(ceil(Double(source.count) / 100_000)))
                peaks = stride(from: 0, to: source.count, by: strideSize).map { source[$0].doubleValue }.map { $0.isFinite ? max(0, min(255, $0)) : 0 }
                peaksPerSecond = rate / Double(strideSize)
            } else if ["video", "image"].contains(clip.kind) {
                let result = try await model.call(nativeQuery("/api/strip", ["src": clip.source]))
                guard !Task.isCancelled, folder == model.folder, key == mediaKey, result.string("url").hasPrefix("/cache/") else { return }
                let path = try model.mediaURL(".reel/cache/" + result.string("url").dropFirst("/cache/".count))
                guard let source = CGImageSourceCreateWithURL(path as CFURL, nil),
                      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      let imageWidth = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                      let imageHeight = properties[kCGImagePropertyPixelHeight] as? NSNumber,
                      NativeTimelinePlanning.imageAllowed(width: imageWidth.doubleValue, height: imageHeight.doubleValue),
                      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return }
                guard let plan = NativeTimelinePlanning.thumbnailPlan(imageWidth: image.width, imageHeight: image.height,
                                                                      width: result.number("w"), count: result.number("count"), interval: result.number("interval", 1)) else { return }
                var tiles: [CGImage] = []
                for index in 0..<plan.count {
                    if let tile = image.cropping(to: CGRect(x: index * plan.width, y: 0, width: plan.width, height: image.height)) { tiles.append(tile) }
                }
                guard !Task.isCancelled, folder == model.folder, key == mediaKey else { return }
                thumbnails = tiles; thumbnailInterval = plan.interval
            }
        } catch { }
    }
}

private struct NativeTimelineClipMedia: View {
    let clip: NativeClip
    let zoom: Double
    let thumbnails: [CGImage]
    let interval: Double
    let peaks: [Double]
    let peaksPerSecond: Double

    var body: some View {
        Canvas { context, size in
            guard zoom.isFinite, zoom > 0, size.width.isFinite, size.height.isFinite else { return }
            if let first = thumbnails.first {
                let height = max(1, size.height - 20), ratio = Double(first.width) / Double(max(1, first.height))
                let width = max(24, height * ratio), count = min(300, Int(min(300, ceil(size.width / width))))
                for tile in 0..<count {
                    let local = Double(tile) * width / zoom
                    let source = max(0, (clip.fields["freeze"] as? NSNumber)?.doubleValue ?? (clip.fields.number("in") + (clip.fields.flag("reverse") ? clip.duration - local : local) * clip.fields.number("speed", 1)))
                    guard source.isFinite else { continue }
                    let index = Int(min(Double(thumbnails.count - 1), max(0, source / max(0.001, interval))))
                    context.draw(Image(decorative: thumbnails[index], scale: 1), in: CGRect(x: Double(tile) * width, y: 20, width: width, height: height))
                }
            }
            if clip.kind == "audio", !peaks.isEmpty {
                let count = min(2000, Int(max(0, min(2000, size.width / 2))))
                for sample in 0..<count {
                    let pixel = Double(sample) / Double(max(1, count)) * size.width
                    let local = pixel / zoom, source = clip.fields.number("in") + local * clip.fields.number("speed", 1)
                    guard source.isFinite else { continue }
                    let index = Int(min(Double(peaks.count - 1), max(0, source * peaksPerSecond)))
                    let amplitude = peaks[index] / 255 * (size.height / 2 - 3)
                    var path = Path(); path.move(to: CGPoint(x: pixel, y: size.height / 2 - amplitude)); path.addLine(to: CGPoint(x: pixel, y: size.height / 2 + amplitude))
                    context.stroke(path, with: .color(.white.opacity(0.3)), lineWidth: 1)
                }
            }
        }.clipShape(RoundedRectangle(cornerRadius: 4)).allowsHitTesting(false)
    }
}
