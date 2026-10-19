import AVFoundation
import SwiftUI
import CoreFoundation

// BEGIN INSPECTOR WORKFLOW
enum NativeInspectorWorkflow {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
        init(_ message: String) { self.message = message }
    }
    struct Format { let hdr: Bool; let alpha: Bool }
    struct Event: Identifiable {
        let id: Int
        let source: Double
        let end: Double?
        let label: String
    }
    struct Results {
        let events: [Event]
        let total: Int
        let truncated: Bool
    }
    static func canonical(_ value: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(value) else { return nil }
        return try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
    static func number(_ value: [String: Any], _ key: String, _ fallback: Double = 0) -> Double { (value[key] as? NSNumber)?.doubleValue ?? fallback }
    static func results(_ result: [String: Any], kind: String) -> Results {
        let times = result["times"] as? [NSNumber] ?? []
        let ranges = result["ranges"] as? [[NSNumber]] ?? []
        let total = kind == "silence" ? ranges.count : times.count
        var events: [Event] = []
        if kind == "silence" {
            for (index, range) in ranges.prefix(1000).enumerated() where range.count >= 2 {
                let start = range[0].doubleValue, end = range[1].doubleValue
                if start.isFinite, end.isFinite, start >= 0, end > start { events.append(Event(id: index, source: start, end: end, label: "Silence \(index + 1)")) }
            }
        } else {
            for (index, time) in times.prefix(1000).enumerated() {
                let value = time.doubleValue
                if value.isFinite, value >= 0 { events.append(Event(id: index, source: value, end: nil, label: "\(kind == "scenes" ? "Scene cut" : "Beat") \(index + 1)")) }
            }
        }
        return Results(events: events, total: total, truncated: total > 1000)
    }
    static func jobStatus(_ job: [String: Any]) -> String {
        let state = job["state"] as? String ?? "queued", error = job["error"] as? String ?? ""
        if state == "cancelled" || error.lowercased().contains("cancelled") || error.lowercased().contains("canceled") { return "Cancelled" }
        if state == "failed" { return "Failed" }
        if state != "done" { return state == "running" ? "Running" : "Queued" }
        let result = job["result"] as? [String: Any] ?? [:], spec = job["spec"] as? [String: Any] ?? [:]
        let applied = job["applied"] as? Bool ?? result["applied"] as? Bool
        let applyError = job["applyError"] as? String ?? result["applyError"] as? String ?? ""
        let output = job["output"] as? String ?? result["path"] as? String ?? ""
        if !output.isEmpty {
            if applied == true && applyError.isEmpty { return "Saved and applied" }
            if applied == false || !applyError.isEmpty || spec["apply"] as? Bool == false { return "Saved, not applied" }
            return "Saved. Application not reported."
        }
        if applied == true && applyError.isEmpty { return "Applied to clip" }
        if applied == false || !applyError.isEmpty { return "Analysis complete, not applied" }
        return "Analysis complete. No timeline edit."
    }
    static func visibleJobs(_ jobs: [[String: Any]]) -> [[String: Any]] {
        let kinds = Set(["scenes", "silence", "beats", "noise", "stabilization", "retime", "person-mask", "denoise", "stabilize", "autoreframe"])
        let relevant = jobs.filter { kinds.contains($0["kind"] as? String ?? "") }
        let active = relevant.filter { ["queued", "running"].contains($0["state"] as? String ?? "") }
        let completed = relevant.filter { !["queued", "running"].contains($0["state"] as? String ?? "") }
        return Array(active.reversed()) + Array(completed.suffix(20).reversed())
    }
    struct Capture {
        let record: [String: Any]
        let data: Data
        var id: String { record["id"] as? String ?? "" }
        var source: String { clip["src"] as? String ?? "" }
        var composition: String? { record["comp"] as? String }
        var version: Int { (record["version"] as? NSNumber)?.intValue ?? -1 }
        var folder: String { record["folder"] as? String ?? "" }
        var clip: [String: Any] { record["clip"] as? [String: Any] ?? [:] }
        var asset: [String: Any] { record["asset"] as? [String: Any] ?? [:] }
        var start: Double { number(clip, "start") }
        var duration: Double { number(clip, "dur") }
        var input: Double { number(clip, "in") }
        var speed: Double { number(clip, "speed", 1) }
        var fps: Double { number(record, "fps", 30) }
        var linked: [[String: Any]] { record["linked"] as? [[String: Any]] ?? [] }
        var linear: Bool {
            start.isFinite && start >= 0 && duration.isFinite && duration > 0 && input.isFinite && input >= 0 && speed.isFinite && speed > 0 &&
                (start + duration).isFinite && start + duration < 1_000_000 && (input + duration * speed).isFinite &&
                clip["reverse"] as? Bool != true && clip["freeze"] == nil && clip["timeMap"] == nil
        }
        var unlocked: Bool { linked.allSatisfy { ($0["track"] as? [String: Any])?["locked"] as? Bool != true } }
        init(fields: [String: Any], folder: String, composition: String?, version: Int, id: String, file: [String: String]) throws {
            var scope = fields
            if let composition {
                guard let comp = (fields["comps"] as? [String: Any])?[composition] as? [String: Any] else { throw Failure("The composition was removed.") }
                scope = comp
            }
            let tracks = scope["tracks"] as? [[String: Any]] ?? []
            guard let track = tracks.first(where: { ($0["clips"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == id } }),
                  let clip = (track["clips"] as? [[String: Any]])?.first(where: { $0["id"] as? String == id }),
                  let src = clip["src"] as? String, !src.isEmpty,
                  let asset = (fields["assets"] as? [String: Any])?[src] as? [String: Any] else { throw Failure("The selected source or clip was removed.") }
            let link = clip["link"] as? String ?? ""
            var linked: [[String: Any]] = []
            for track in tracks {
                var metadata = track; metadata.removeValue(forKey: "clips")
                for item in track["clips"] as? [[String: Any]] ?? [] where item["id"] as? String == id || (!link.isEmpty && item["link"] as? String == link) {
                    linked.append(["track": metadata, "clip": item, "asset": (fields["assets"] as? [String: Any])?[item["src"] as? String ?? ""] as? [String: Any] ?? [:]])
                }
            }
            let record: [String: Any] = ["folder": folder, "comp": composition as Any? ?? NSNull(), "version": version, "id": id, "clip": clip,
                                         "asset": asset, "linked": linked, "file": file, "fps": number(scope, "fps", number(fields, "fps", 30)),
                                         "width": number(scope, "width", number(fields, "width", 1920)), "height": number(scope, "height", number(fields, "height", 1080))]
            try self.init(record: record)
        }
        init(record: [String: Any]) throws {
            guard let data = canonical(record), data.count <= 262_144, let folder = record["folder"] as? String, !folder.isEmpty,
                  let id = record["id"] as? String, !id.isEmpty, record["version"] is NSNumber,
                  record["comp"] is NSNull || record["comp"] is String,
                  let clip = record["clip"] as? [String: Any], clip["id"] as? String == id,
                  let src = clip["src"] as? String, !src.isEmpty, record["asset"] is [String: Any],
                  let file = record["file"] as? [String: String], !file.isEmpty,
                  let linked = record["linked"] as? [[String: Any]], !linked.isEmpty,
                  number(record, "fps").isFinite, (1...240).contains(number(record, "fps")) else { throw Failure("This result has no valid captured target. Run it again.") }
            self.record = record; self.data = data
        }
        func matches(fields: [String: Any], folder: String?, composition: String?, version: Int, primary: String?, file: [String: String]) -> Bool {
            guard self.folder == folder, self.composition == composition, self.version == version, id == primary,
                  let current = try? Capture(fields: fields, folder: self.folder, composition: composition, version: version, id: id, file: file) else { return false }
            return current.data == data
        }
        func timeline(_ sourceTime: Double) -> Double? {
            guard linear, sourceTime.isFinite, sourceTime >= input - 0.000001, sourceTime <= input + duration * speed + 0.000001 else { return nil }
            return max(start, min(start + duration, ((start + (sourceTime - input) / speed) * fps).rounded() / fps))
        }
        func operations(events: [Event], selected: Set<Int>, split: Bool) throws -> [[String: Any]] {
            guard linear, unlocked else { throw Failure("Marker and split actions require unlocked forward clips with a constant positive speed.") }
            if split, !linked.allSatisfy({ item in
                let clip = item["clip"] as? [String: Any] ?? [:], speed = number(clip, "speed", 1)
                return speed.isFinite && speed > 0 && clip["reverse"] as? Bool != true && clip["freeze"] == nil && clip["timeMap"] == nil
            }) { throw Failure("Splits require every linked clip to have a forward constant source mapping.") }
            let chosen = events.filter { selected.contains($0.id) }
            guard !chosen.isEmpty, chosen.count <= 256 else { throw Failure("Choose between 1 and 256 results to apply.") }
            var used = Set<Int>(), points: [(Double, String)] = []
            for event in chosen {
                for sourceTime in [event.source] + (event.end.map { [$0] } ?? []) {
                    guard let at = timeline(sourceTime), !split || (at > start + 0.5 / fps && at < start + duration - 0.5 / fps) else { continue }
                    let frame = Int((at * fps).rounded())
                    if used.insert(frame).inserted { points.append((at, event.label)) }
                }
            }
            guard !points.isEmpty, points.count <= 256 else { throw Failure("Choose up to 256 events inside the selected clip. Split points must be between its edges.") }
            let scope = composition as Any? ?? NSNull()
            if split { return points.sorted { $0.0 > $1.0 }.map { ["op": "blade", "id": id, "at": $0.0, "comp": scope] } }
            return [["op": "markers", "comp": scope, "markers": points.sorted { $0.0 < $1.0 }.map { ["t": $0.0, "label": $0.1, "color": "#f5b942"] as [String: Any] }]]
        }
        func restoreProcessing(_ key: String, fields: [String: Any]) throws -> [[String: Any]] {
            guard ["noiseReduction", "deshake"].contains(key), linear, unlocked,
                  let recipe = clip[key] as? [String: Any], recipe["output"] as? String == source,
                  let original = recipe["src"] as? String, !original.isEmpty, original != source,
                  let originalAsset = (fields["assets"] as? [String: Any])?[original] as? [String: Any],
                  originalAsset["hasVideo"] as? Bool == true, originalAsset["still"] as? Bool != true else { throw Failure("This clip has no matching saved processing source.") }
            let sourceIn = number(recipe, "in", -1), savedDuration = number(recipe, "dur", -1), originalIn = sourceIn + input, sourceDuration = duration * speed, available = number(originalAsset, "duration", -1)
            guard [sourceIn, savedDuration, originalIn, sourceDuration, available].allSatisfy(\.isFinite), sourceIn >= 0, savedDuration > 0,
                  input + sourceDuration <= savedDuration + 0.00001, originalIn + sourceDuration <= available + 0.00001 else { throw Failure("The saved processing source does not cover this clip's current range.") }
            return [["op": "update", "id": id, "comp": composition as Any? ?? NSNull(), "set": ["src": original, "in": originalIn, key: NSNull()]]]
        }
        func request(route: String, options: [String: Any], capabilities: [String: Any], format: Format? = nil) throws -> [String: Any] {
            var body = options
            let analysis = capabilities["analysis"] as? [String: Any] ?? [:], processing = capabilities["processing"] as? [String: Any] ?? [:]
            if route == "/api/analyze" {
                let kind = options["kind"] as? String ?? ""
                guard ["scenes", "silence", "beats", "noise", "stabilization"].contains(kind) else { throw Failure("Choose a supported analysis.") }
                let capability = ["noise", "stabilization"].contains(kind) ? "processingRecommendations" : kind
                guard analysis[capability] as? Bool == true else { throw Failure("This analysis is unavailable on this host.") }
                guard asset[kind == "silence" || kind == "beats" ? "hasAudio" : "hasVideo"] as? Bool == true else { throw Failure("This source does not have the required audio or video track.") }
                if kind == "scenes" { guard (0.1...100).contains(number(options, "threshold", 10)) else { throw Failure("Choose a scene threshold between 0.1 and 100.") } }
                if kind == "silence" { guard (-100...0).contains(number(options, "noise", -32)), (0.05...30).contains(number(options, "min", 0.45)) else { throw Failure("Choose a valid silence level and minimum duration.") } }
                if ["noise", "stabilization"].contains(kind) {
                    guard linear else { throw Failure("Range measurement requires a forward clip with a constant positive speed.") }
                    body["in"] = input; body["dur"] = min(30, duration * speed)
                }
            } else {
                guard linear, unlocked, clip["kind"] as? String == "video", duration * speed <= 3600 else { throw Failure("Processing requires an unlocked forward video clip with a source range of at most one hour.") }
                let allowed: Bool
                switch route {
                case "/api/video/denoise": allowed = processing["videoDenoise"] as? Bool == true
                case "/api/stabilize/render": allowed = processing["deshake"] as? Bool == true
                case "/api/retime": allowed = analysis["opticalFlow"] as? Bool == true
                case "/api/analysis/person-mask": allowed = analysis["personMask"] as? Bool == true && processing["preservesAlpha"] as? Bool == true
                case "/api/analysis/autoreframe": allowed = analysis["autoReframe"] as? Bool == true
                default: allowed = false
                }
                guard allowed else { throw Failure("This processing route is unavailable on this host.") }
                if route != "/api/analysis/autoreframe" {
                    guard let format else { throw Failure("Wait for the source format check before rendering.") }
                    let requested = options["codec"] as? String ?? "auto"
                    let codec = format.alpha || route == "/api/analysis/person-mask" ? "prores-4444" : requested
                    guard (processing["codecs"] as? [String] ?? []).contains(codec), !(format.hdr && codec == "h264") else { throw Failure("Choose a supported codec that preserves HDR and alpha.") }
                    body["codec"] = codec
                }
                if route == "/api/retime" {
                    let outputSpeed = number(options, "speed", 0.5)
                    guard (0.05...4).contains(outputSpeed) else { throw Failure("Choose an output speed between 0.05 and 4.") }
                    if options["apply"] as? Bool != false, linked.count > 1 {
                        guard linked.allSatisfy({ item in
                            let clip = item["clip"] as? [String: Any] ?? [:], asset = item["asset"] as? [String: Any] ?? [:]
                            let scalar = number(clip, "speed", 1), available = number(asset, "duration", -1) - number(clip, "in")
                            return clip["reverse"] as? Bool != true && clip["freeze"] == nil && clip["timeMap"] == nil &&
                                abs(number(clip, "start") - start) < 0.00001 && abs(number(clip, "dur") - duration) < 0.00001 &&
                                abs(scalar - speed) < 0.00001 && available.isFinite && available + 0.00001 >= duration * scalar
                        }) else { throw Failure("Applied retime needs aligned forward linked clips with matching speed and known source handles. Save the output without applying, or unlink the clip first.") }
                    }
                }
                let sourceRate = number(asset, "fps", fps), sourceFPS = sourceRate.isFinite && (1...240).contains(sourceRate) ? sourceRate : fps
                body["fps"] = route == "/api/analysis/autoreframe" ? number(options, "fps", 2) : sourceFPS
                body["in"] = input; body["dur"] = duration * speed; body["apply"] = options["apply"] as? Bool ?? true
            }
            body["src"] = source; body["id"] = id; body["comp"] = composition as Any? ?? NSNull(); body["expectedVersion"] = version
            body["wait"] = false; body["uiCapture"] = record
            return body
        }
    }
}
// END INSPECTOR WORKFLOW

private func NativeInspectorFile(_ identity: NativeSourceFileIdentity) -> [String: String] {
    ["path": identity.path, "device": String(identity.device), "inode": String(identity.inode), "size": String(identity.size),
     "seconds": String(identity.seconds), "nanoseconds": String(identity.nanoseconds)]
}

extension NativeInspectorWorkflow.Capture {
    @MainActor init(model: NativeEditorModel, id: String) throws {
        guard let fields = model.project?.fields, let folder = model.folder,
              let clip = model.tracks.flatMap(\.clips).first(where: { $0.id == id }) else { throw NativeInspectorWorkflow.Failure("Select a media clip in an open project.") }
        let identity = try NativeSourceFileIdentity(file: model.mediaURL(clip.source))
        try self.init(fields: fields, folder: folder.path, composition: model.composition, version: model.version, id: id, file: NativeInspectorFile(identity))
    }
    @MainActor func matches(_ model: NativeEditorModel) -> Bool {
        guard let fields = model.project?.fields, let file = try? NativeSourceFileIdentity(file: model.mediaURL(source)) else { return false }
        return matches(fields: fields, folder: model.folder?.path, composition: model.composition, version: model.version, primary: model.selectedID, file: NativeInspectorFile(file))
    }
    @MainActor func sourceMatches(_ model: NativeEditorModel) -> Bool {
        guard folder == model.folder?.path, let current = model.project?.assets.first(where: { $0.id == source }),
              NativeInspectorWorkflow.canonical(current.fields) == NativeInspectorWorkflow.canonical(asset),
              let file = try? NativeSourceFileIdentity(file: model.mediaURL(source)) else { return false }
        return record["file"] as? [String: String] == NativeInspectorFile(file)
    }
}

enum NativeInspectorNavigation {
    struct Section {
        let title: String
        let anchor: String
    }

    static func sections(kind: String?) -> [Section] {
        guard let kind else {
            return [Section(title: "Canvas and layers", anchor: "inspector.project"), Section(title: "Processing jobs", anchor: "inspectorJobs")]
        }
        var sections = [Section(title: "Label", anchor: "inspector.label"), Section(title: "Timing", anchor: "inspector.timing")]
        if ["video", "audio"].contains(kind) { sections.append(Section(title: "Source analysis", anchor: "inspector.analysis")) }
        if kind == "multicam" { sections.append(Section(title: "Multicam", anchor: "inspector.multicam")) }
        if kind == "caption" { sections.append(Section(title: "Caption", anchor: "inspector.caption")) }
        if kind != "audio" && kind != "caption" {
            sections.append(Section(title: "Transform", anchor: "inspector.transform"))
            if kind == "title" { sections.append(Section(title: "Text", anchor: "inspector.text")) }
            if kind == "shape" { sections.append(Section(title: "Shape", anchor: "inspector.shape")) }
            sections.append(Section(title: "Effects and transition", anchor: "inspector.effects"))
            if kind == "video" { sections.append(Section(title: "Video processing", anchor: "inspector.processing")) }
        }
        sections.append(Section(title: "Enabled and note", anchor: "inspector.notes"))
        sections.append(Section(title: "Processing jobs", anchor: "inspectorJobs"))
        return sections
    }
}


// BEGIN SHAPE APPEARANCE PLANNING
enum NativeShapeAppearance {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
        init(_ message: String) { self.message = message }
    }
    enum Action: String { case fillColor, strokeColor, fillEnabled, strokeEnabled, strokeWidth }
    struct Capture {
        let record: [String: Any]
        let data: Data
        var version: Int { (record["version"] as? NSNumber)?.intValue ?? -1 }
        var composition: Any { record["comp"] ?? NSNull() }
        init(fields: [String: Any], folder: String, backend: String, context: UUID, revision: UUID, version: Int, composition: String?, selection: Set<String>, primary: String?) throws {
            guard !folder.isEmpty, !backend.isEmpty, version >= 0, let primary, selection.contains(primary), !selection.isEmpty else { throw Failure("Select the shape again before changing its appearance.") }
            var scope = fields
            if let composition {
                guard let comp = fields.dictionary("comps")[composition] as? [String: Any] else { throw Failure("The composition was removed.") }
                scope = comp
            }
            var targets: [[String: Any]] = []
            for id in selection.sorted() {
                let found = scope.objects("tracks").flatMap { track -> [[String: Any]] in
                    var metadata = track; metadata.removeValue(forKey: "clips")
                    return track.objects("clips").filter { $0.string("id") == id }.map { ["id": id, "clip": $0, "track": metadata] }
                }
                guard found.count == 1, found[0].dictionary("clip").string("kind") == "shape", !found[0].dictionary("track").flag("locked") else { throw Failure("Select only shapes on unlocked tracks.") }
                targets.append(found[0])
            }
            let record: [String: Any] = ["folder": folder, "backend": backend, "context": context.uuidString, "revision": revision.uuidString, "version": version,
                                         "comp": composition as Any? ?? NSNull(), "primary": primary, "selection": selection.sorted(), "targets": targets]
            guard JSONSerialization.isValidJSONObject(record), let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]), data.count <= 262_144 else { throw Failure("This shape selection is too large to edit. Select fewer shapes.") }
            self.record = record; self.data = data
        }
        func operations(_ action: Action, value: Any) throws -> [[String: Any]] {
            var patch: [String: Any] = [:]
            var color: String?, enabled: Bool?, width: Double?
            switch action {
            case .fillColor, .strokeColor:
                guard let string = value as? String, let range = string.range(of: "^#[a-fA-F0-9]{3}(?:[a-fA-F0-9]{1}|[a-fA-F0-9]{3}|[a-fA-F0-9]{5})?$", options: .regularExpression), range == (string.startIndex..<string.endIndex) else { throw Failure("Use a hex color such as #d95d18 or #d95d18ff.") }
                let hex = String(string.dropFirst()).lowercased()
                color = "#" + (hex.count <= 4 ? hex.map { "\($0)\($0)" }.joined() : hex)
            case .fillEnabled, .strokeEnabled:
                guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw Failure("Choose whether the paint is enabled.") }
                enabled = number.boolValue
            case .strokeWidth:
                guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite, (0...100).contains(number.doubleValue) else { throw Failure("Stroke width must be from 0 to 100 pixels.") }
                width = number.doubleValue
            }
            return record.objects("targets").map { target in
                let shape = target.dictionary("clip").dictionary("shape")
                switch action {
                case .fillColor, .strokeColor:
                    let field = action == .fillColor ? "fill" : "stroke"
                    var paint: [String: Any] = ["color": color!]
                    if shape.dictionary(field)["gradient"] != nil { paint["gradient"] = NSNull() }
                    patch = [field: paint]
                case .fillEnabled: patch = ["fill": enabled! ? (shape["fill"] as? [String: Any] ?? ["color": "#f5b942"]) as Any : NSNull()]
                case .strokeEnabled:
                    var stroke: [String: Any] = ["width": enabled! ? (shape.dictionary("stroke").number("width") > 0 ? shape.dictionary("stroke").number("width") : 3) : 0]
                    if enabled!, shape["stroke"] as? [String: Any] == nil { stroke["color"] = "#ffffff" }
                    patch = ["stroke": stroke]
                case .strokeWidth: patch = ["stroke": ["width": width!]]
                }
                return ["op": "update", "id": target.string("id"), "comp": composition, "set": ["shape": patch]]
            }
        }
    }
}
// END SHAPE APPEARANCE PLANNING

// BEGIN SHAPE APPEARANCE CONTROLLER
@MainActor
enum NativeShapeAppearanceController {
    static func capture(_ model: NativeEditorModel, primary: String?) throws -> NativeShapeAppearance.Capture {
        guard let fields = model.project?.fields, let folder = model.folder, let backend = model.renderPreviewBackendID,
              !model.busy, model.projectReadOnlyReason == nil else { throw NativeShapeAppearance.Failure("Open an editable project before changing shape appearance.") }
        return try NativeShapeAppearance.Capture(fields: fields, folder: folder.standardizedFileURL.path, backend: String(describing: backend),
                                                  context: model.processingContextID, revision: model.audioProjectRevision, version: model.version,
                                                  composition: model.composition, selection: model.selectedIDs, primary: primary)
    }
    static func commit(_ model: NativeEditorModel, capture: NativeShapeAppearance.Capture?, action: NativeShapeAppearance.Action, value: Any) {
        model.perform {
            guard let capture, let now = try? self.capture(model, primary: model.selectedID), capture.data == now.data else { throw NativeShapeAppearance.Failure("The project or shape changed. Reopen its appearance controls.") }
            let operations = try capture.operations(action, value: value)
            try await model.ops(operations, summary: "Changed shape appearance", expectedVersion: capture.version)
        }
    }
}
// END SHAPE APPEARANCE CONTROLLER

private struct NativeShapeAppearanceControls: View {
    @ObservedObject var model: NativeEditorModel
    let clip: NativeClip
    var body: some View {
        let capture = try? NativeShapeAppearanceController.capture(model, primary: clip.id)
        let shape = clip.fields.dictionary("shape"), fill = shape.dictionary("fill"), stroke = shape.dictionary("stroke")
        VStack(spacing: 8) {
            Toggle("Fill enabled", isOn: Binding(get: { shape["fill"] as? [String: Any] != nil }, set: { NativeShapeAppearanceController.commit(model, capture: capture, action: .fillEnabled, value: $0) }))
            NativeTextRow("Fill", value: fill.string("color", "#f5b942")) { NativeShapeAppearanceController.commit(model, capture: capture, action: .fillColor, value: $0) }
            Toggle("Stroke enabled", isOn: Binding(get: { stroke.number("width") > 0 }, set: { NativeShapeAppearanceController.commit(model, capture: capture, action: .strokeEnabled, value: $0) }))
            NativeTextRow("Stroke", value: stroke.string("color", "#ffffff")) { NativeShapeAppearanceController.commit(model, capture: capture, action: .strokeColor, value: $0) }
            NativeNumberRow("Stroke width", value: stroke.number("width"), range: 0...100) { NativeShapeAppearanceController.commit(model, capture: capture, action: .strokeWidth, value: $0) }
            if capture == nil { Text("Select only shapes on unlocked tracks.").font(.caption).foregroundStyle(NativeEditorStyle.muted) }
            if [fill, stroke].contains(where: { $0["gradient"] as? [String: Any] != nil }) {
                Text("Choosing a color changes that paint to a solid color. Undo restores its previous paint.").font(.caption).foregroundStyle(NativeEditorStyle.muted)
            }
        }.disabled(capture == nil).id(capture?.data)
    }
}

// BEGIN TITLE APPEARANCE PLANNING
enum NativeTitleAppearance {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
        init(_ message: String) { self.message = message }
    }
    enum Action: String {
        case color, gradientEnabled, gradientStart, gradientEnd, italic, lineHeight
        case strokeEnabled, strokeColor, strokeWidth, shadowEnabled, shadowColor, shadowBlur, shadowX, shadowY
        case plateEnabled, plateColor, padding, radius
        var property: String? {
            switch self {
            case .lineHeight: return "title.lineHeight"
            case .strokeWidth: return "title.stroke.width"
            case .shadowBlur: return "title.shadow.blur"
            case .shadowX: return "title.shadow.x"
            case .shadowY: return "title.shadow.y"
            case .padding: return "title.padding"
            case .radius: return "title.radius"
            default: return nil
            }
        }
        var range: ClosedRange<Double>? {
            switch self {
            case .lineHeight: return 0.5...5
            case .strokeWidth, .shadowBlur: return 0...100
            case .shadowX, .shadowY: return -500...500
            case .padding, .radius: return 0...500
            default: return nil
            }
        }
    }
    static func color(_ value: Any) throws -> String {
        guard let string = value as? String, let range = string.range(of: "^#[a-fA-F0-9]{3}(?:[a-fA-F0-9]{1}|[a-fA-F0-9]{3}|[a-fA-F0-9]{5})?$", options: .regularExpression), range == (string.startIndex..<string.endIndex) else { throw Failure("Use a hex color such as #d95d18 or #d95d18ff.") }
        let hex = String(string.dropFirst()).lowercased()
        return "#" + (hex.count <= 4 ? hex.map { "\($0)\($0)" }.joined() : hex)
    }
    struct Capture {
        let record: [String: Any]
        let data: Data
        private let transportIdentity: Data
        var version: Int { (record["version"] as? NSNumber)?.intValue ?? -1 }
        var composition: Any { record["comp"] ?? NSNull() }
        var time: Double { record.number("time") }
        var targets: [[String: Any]] { record.objects("targets") }
        init(fields: [String: Any], folder: String, backend: String, context: UUID, revision: UUID, version: Int, composition: String?, selection: Set<String>, primary: String?, time: Double) throws {
            guard !folder.isEmpty, !backend.isEmpty, version >= 0, time.isFinite, (0..<1_000_000).contains(time), let primary, selection.contains(primary), !selection.isEmpty else { throw Failure("Select the title again before changing its appearance.") }
            var scope = fields
            if let composition {
                guard let comp = fields.dictionary("comps")[composition] as? [String: Any] else { throw Failure("The composition was removed.") }
                scope = comp
            }
            var targets: [[String: Any]] = []
            for id in selection.sorted() {
                let found = scope.objects("tracks").flatMap { track -> [[String: Any]] in
                    var metadata = track; metadata.removeValue(forKey: "clips")
                    return track.objects("clips").filter { $0.string("id") == id }.map { ["id": id, "clip": $0, "track": metadata] }
                }
                guard found.count == 1, found[0].dictionary("clip").string("kind") == "title", found[0].dictionary("clip")["title"] as? [String: Any] != nil, !found[0].dictionary("track").flag("locked") else { throw Failure("Select only titles on unlocked tracks.") }
                let clip = found[0].dictionary("clip"), start = clip.number("start", .nan), duration = clip.number("dur", .nan)
                guard start.isFinite, start >= 0, duration.isFinite, duration > 0, (start + duration).isFinite, start + duration < 1_000_000 else { throw Failure("This title has invalid timing.") }
                targets.append(found[0])
            }
            let record: [String: Any] = ["folder": folder, "backend": backend, "context": context.uuidString, "revision": revision.uuidString, "version": version,
                                         "comp": composition as Any? ?? NSNull(), "primary": primary, "selection": selection.sorted(), "time": time, "targets": targets]
            guard JSONSerialization.isValidJSONObject(record), let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]), data.count <= 262_144 else { throw Failure("This title selection is too large to edit. Select fewer titles.") }
            var identity = record
            identity.removeValue(forKey: "time")
            self.transportIdentity = try JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys])
            self.record = record; self.data = data
        }
        func formIdentity(transportActive: Bool) -> Data { transportActive ? transportIdentity : data }
        func expressionOwns(_ property: String) -> Bool {
            targets.contains { !($0.dictionary("clip").dictionary("expr")[property] as? String ?? "").isEmpty }
        }
        private func requireStatic(_ clip: [String: Any], _ prefixes: [String]) throws {
            let keys = clip.dictionary("anim"), expressions = clip.dictionary("expr")
            let owners = Set(keys.keys).union(expressions.keys)
            for property in owners where prefixes.contains(where: { property == $0 || property.hasPrefix($0 + ".") }) {
                if !(keys[property] as? [Any] ?? []).isEmpty || !(expressions[property] as? String ?? "").isEmpty { throw Failure("This appearance field is animated. Edit its keys or expression in Motion first.") }
            }
        }
        func operations(_ action: Action, value: Any) throws -> [[String: Any]] {
            var number: Double?, enabled: Bool?, hex: String?
            if let range = action.range {
                guard let raw = value as? NSNumber, CFGetTypeID(raw) != CFBooleanGetTypeID(), raw.doubleValue.isFinite, range.contains(raw.doubleValue) else { throw Failure("Use a number within this field's range.") }
                number = raw.doubleValue
            } else if [.gradientEnabled, .italic, .strokeEnabled, .shadowEnabled, .plateEnabled].contains(action) {
                guard let raw = value as? NSNumber, CFGetTypeID(raw) == CFBooleanGetTypeID() else { throw Failure("Choose whether this appearance is enabled.") }
                enabled = raw.boolValue
            } else { hex = try NativeTitleAppearance.color(value) }
            return try targets.map { target in
                let clip = target.dictionary("clip"), title = clip.dictionary("title")
                var patch: [String: Any] = [:]
                if let property = action.property {
                    guard !expressionOwns(property) else { throw Failure("This field is controlled by an expression. Edit the expression in Motion first.") }
                    if property.hasPrefix("title.stroke.") && title["stroke"] as? [String: Any] == nil { throw Failure("Enable Outline before changing its width.") }
                    if property.hasPrefix("title.shadow.") && title["shadow"] as? [String: Any] == nil { throw Failure("Enable Shadow before changing its geometry.") }
                    if let raw = clip.dictionary("anim")[property] as? [Any], !raw.isEmpty {
                        guard let keys = raw as? [[Any]] else { throw Failure("This field has invalid keys. Inspect them in Motion first.") }
                        let local = min(clip.number("dur"), max(0, time - clip.number("start")))
                        // Core rounds local seconds to four places before replacing nearby keys.
                        let rounded = (local * 10_000).rounded(.toNearestOrAwayFromZero) / 10_000
                        var replaced: [[Any]] = []
                        for key in keys {
                            guard (2...3).contains(key.count), let at = key[0] as? NSNumber, CFGetTypeID(at) != CFBooleanGetTypeID(), at.doubleValue.isFinite else { throw Failure("This field has invalid keys. Inspect them in Motion first.") }
                            if abs(at.doubleValue - rounded) <= 1e-3 { replaced.append(key) }
                        }
                        guard replaced.count <= 1 else { throw Failure("Several keys are too close to this playhead. Move the playhead or separate them in Motion first.") }
                        var operation: [String: Any] = ["op": "keyframe", "id": target.string("id"), "comp": composition, "prop": property, "local": true, "at": local, "value": number!]
                        if let key = replaced.first, key.count == 3 { operation["ease"] = key[2] }
                        return operation
                    }
                    let path = property.split(separator: ".").dropFirst().map(String.init)
                    var nested: Any = number!
                    for key in path.reversed() { nested = [key: nested] }
                    patch = nested as! [String: Any]
                } else {
                    switch action {
                    case .color:
                        try requireStatic(clip, ["title.color", "title.gradient"]); patch = ["color": hex!, "gradient": NSNull()]
                    case .gradientEnabled, .gradientStart, .gradientEnd:
                        try requireStatic(clip, ["title.gradient"])
                        var gradient = title["gradient"] as? [String] ?? [title.string("color", "#ffffff"), "#7aa8ff"]
                        if gradient.count != 2 { gradient = [title.string("color", "#ffffff"), "#7aa8ff"] }
                        if action == .gradientStart { gradient[0] = hex! }
                        if action == .gradientEnd { gradient[1] = hex! }
                        patch = ["gradient": action == .gradientEnabled && enabled == false ? NSNull() : gradient as Any]
                    case .italic:
                        try requireStatic(clip, ["title.italic"]); patch = ["italic": enabled! ? true as Any : NSNull()]
                    case .strokeEnabled:
                        try requireStatic(clip, ["title.stroke"]); patch = ["stroke": enabled! ? (title["stroke"] as? [String: Any] ?? ["color": "#000000", "width": 3]) as Any : NSNull()]
                    case .strokeColor:
                        guard title["stroke"] as? [String: Any] != nil else { throw Failure("Enable Outline before changing its color.") }
                        try requireStatic(clip, ["title.stroke.color"]); patch = ["stroke": ["color": hex!]]
                    case .shadowEnabled:
                        try requireStatic(clip, ["title.shadow"]); patch = ["shadow": enabled! ? (title["shadow"] as? [String: Any] ?? ["color": "#00000099", "blur": 18, "x": 0, "y": 6]) as Any : NSNull()]
                    case .shadowColor:
                        guard title["shadow"] as? [String: Any] != nil else { throw Failure("Enable Shadow before changing its color.") }
                        try requireStatic(clip, ["title.shadow.color"]); patch = ["shadow": ["color": hex!]]
                    case .plateEnabled:
                        try requireStatic(clip, ["title.plate"]); patch = ["plate": enabled! ? title.string("plate", "#000000b0") as Any : NSNull()]
                    case .plateColor:
                        guard title["plate"] as? String != nil else { throw Failure("Enable Plate before changing its color.") }
                        try requireStatic(clip, ["title.plate"]); patch = ["plate": hex!]
                    default: throw Failure("Unsupported title appearance field.")
                    }
                }
                return ["op": "update", "id": target.string("id"), "comp": composition, "set": ["title": patch]]
            }
        }
    }
}
// END TITLE APPEARANCE PLANNING

// BEGIN TITLE APPEARANCE CONTROLLER
@MainActor
enum NativeTitleAppearanceController {
    static func capture(_ model: NativeEditorModel, primary: String?) throws -> NativeTitleAppearance.Capture {
        guard let fields = model.project?.fields, let folder = model.folder, let backend = model.renderPreviewBackendID,
              !model.busy, !model.showingSource, model.projectReadOnlyReason == nil else { throw NativeTitleAppearance.Failure("Open an editable timeline before changing title appearance.") }
        return try NativeTitleAppearance.Capture(fields: fields, folder: folder.standardizedFileURL.path, backend: String(describing: backend),
                                                  context: model.processingContextID, revision: model.audioProjectRevision, version: model.version,
                                                  composition: model.composition, selection: model.selectedIDs, primary: primary, time: model.time)
    }
    static func commit(_ model: NativeEditorModel, capture: NativeTitleAppearance.Capture?, action: NativeTitleAppearance.Action, value: Any) {
        model.perform {
            guard let capture, let now = try? self.capture(model, primary: model.selectedID), capture.data == now.data else { throw NativeTitleAppearance.Failure("The project, title, or playhead changed. Reopen its appearance controls.") }
            let operations = try capture.operations(action, value: value)
            try await model.ops(operations, summary: "Changed title appearance", expectedVersion: capture.version)
        }
    }
}
// END TITLE APPEARANCE CONTROLLER

private struct NativeTitleAppearanceControls: View {
    @ObservedObject var model: NativeEditorModel
    let clip: NativeClip
    var body: some View {
        let capture = try? NativeTitleAppearanceController.capture(model, primary: clip.id)
        let title = clip.fields.dictionary("title"), stroke = title.dictionary("stroke"), shadow = title.dictionary("shadow")
        let gradient = title["gradient"] as? [String] ?? []
        VStack(spacing: 8) {
            Toggle("Italic", isOn: Binding(get: { title.flag("italic") }, set: { NativeTitleAppearanceController.commit(model, capture: capture, action: .italic, value: $0) }))
            numeric("Line height", .lineHeight, title.number("lineHeight", 1.15), capture, step: 0.05)
            NativeTextRow("Color", value: title.string("color", "#ffffff")) { NativeTitleAppearanceController.commit(model, capture: capture, action: .color, value: $0) }
            Toggle("Gradient", isOn: Binding(get: { gradient.count == 2 }, set: { NativeTitleAppearanceController.commit(model, capture: capture, action: .gradientEnabled, value: $0) }))
            if gradient.count == 2 {
                NativeTextRow("Gradient start", value: gradient[0]) { NativeTitleAppearanceController.commit(model, capture: capture, action: .gradientStart, value: $0) }
                NativeTextRow("Gradient end", value: gradient[1]) { NativeTitleAppearanceController.commit(model, capture: capture, action: .gradientEnd, value: $0) }
            }
            Toggle("Outline", isOn: Binding(get: { !stroke.isEmpty }, set: { NativeTitleAppearanceController.commit(model, capture: capture, action: .strokeEnabled, value: $0) }))
            if !stroke.isEmpty {
                NativeTextRow("Outline color", value: stroke.string("color", "#000000")) { NativeTitleAppearanceController.commit(model, capture: capture, action: .strokeColor, value: $0) }
                numeric("Outline width", .strokeWidth, stroke.number("width"), capture, step: 0.5)
            }
            Toggle("Shadow", isOn: Binding(get: { !shadow.isEmpty }, set: { NativeTitleAppearanceController.commit(model, capture: capture, action: .shadowEnabled, value: $0) }))
            if !shadow.isEmpty {
                NativeTextRow("Shadow color", value: shadow.string("color", "#000000aa")) { NativeTitleAppearanceController.commit(model, capture: capture, action: .shadowColor, value: $0) }
                numeric("Shadow blur", .shadowBlur, shadow.number("blur", 12), capture, step: 1)
                numeric("Shadow X", .shadowX, shadow.number("x"), capture, step: 1)
                numeric("Shadow Y", .shadowY, shadow.number("y", 4), capture, step: 1)
            }
            Toggle("Plate", isOn: Binding(get: { title["plate"] as? String != nil }, set: { NativeTitleAppearanceController.commit(model, capture: capture, action: .plateEnabled, value: $0) }))
            if title["plate"] as? String != nil {
                NativeTextRow("Plate color", value: title.string("plate", "#000000b0")) { NativeTitleAppearanceController.commit(model, capture: capture, action: .plateColor, value: $0) }
                numeric("Padding", .padding, title.number("padding", 24), capture, step: 1)
                numeric("Corner radius", .radius, title.number("radius", 10), capture, step: 1)
            }
            if capture == nil { Text("Select only titles on unlocked timeline tracks.").font(.caption).foregroundStyle(NativeEditorStyle.muted) }
            if clip.fields.dictionary("anim").keys.contains(where: { $0.hasPrefix("title.") }) {
                Text("Base values are shown. Changing an animated number adds a key at the playhead.").font(.caption).foregroundStyle(NativeEditorStyle.muted)
            }
            if clip.fields.dictionary("expr").keys.contains(where: { $0.hasPrefix("title.") }) {
                Text("Expressions keep control of their fields. Edit them in Motion first.").font(.caption).foregroundStyle(NativeEditorStyle.muted)
            }
        // Playback and scrubbing change receipt time without recreating the whole form each frame.
        }.disabled(capture == nil).id(capture?.formIdentity(transportActive: model.playing || model.scrubbing))
    }
    private func numeric(_ label: String, _ action: NativeTitleAppearance.Action, _ value: Double, _ capture: NativeTitleAppearance.Capture?, step: Double) -> some View {
        NativeNumberRow(label, value: value, range: action.range, step: step) { NativeTitleAppearanceController.commit(model, capture: capture, action: action, value: $0) }
            .disabled(action.property.map { capture?.expressionOwns($0) ?? true } ?? false)
    }
}

struct NativeInspector: View {
    @ObservedObject var model: NativeEditorModel

    var body: some View {
        #if os(macOS)
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                macHeader { anchor in proxy.scrollTo(anchor, anchor: .top) }
                Divider().overlay(NativeEditorStyle.line)
                inspectorScroll
            }
        }
        #else
        inspectorScroll
        #endif
    }

    private var inspectorScroll: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 15) {
                Group {
                    if let clip = model.selected {
                        #if !os(macOS)
                        HStack {
                            Text(clip.name).font(.headline).lineLimit(2)
                            Spacer(minLength: 0)
                            Button { model.selectedID = nil } label: { Image(systemName: "xmark") }
                                .buttonStyle(NativeToolbarButtonStyle()).accessibilityLabel("Clear selection")
                        }
                        Text("\(clip.kind.capitalized) · \(clip.id)").font(.caption2).foregroundStyle(NativeEditorStyle.muted)
                        #endif
                        NativeTextRow("Label", value: clip.fields.string("label")) { model.update(clip, ["label": $0]) }.macInspectorAnchor("inspector.label")
                        GroupBox("Timing") {
                            VStack(spacing: 8) {
                                // Timecode, as in Final Cut's inspector. The step buttons and arrow keys move one frame.
                                timecodeRow("Start", value: clip.start, range: 0...max(model.duration + 60, clip.start)) { model.edit(["op": "move", "id": clip.id, "start": $0]) }
                                timecodeRow("Duration", value: clip.duration, range: (1 / model.fps)...max(60, clip.duration * 4)) { model.edit(["op": "trim", "id": clip.id, "edge": "right", "to": clip.start + $0]) }
                                if clip.kind == "video" || clip.kind == "audio" {
                                    NativeNumberRow("Speed", value: clip.fields.number("speed", 1), range: 0.1...8) { model.edit(["op": "speed", "id": clip.id, "speed": $0]) }
                                    Toggle("Reverse", isOn: Binding(get: { clip.fields.flag("reverse") }, set: { model.edit(["op": "speed", "id": clip.id, "speed": clip.fields.number("speed", 1), "reverse": $0]) }))
                                }
                            }.padding(4)
                        }.macInspectorAnchor("inspector.timing")
                        if ["video", "audio"].contains(clip.kind) { NativeSourceAnalysisControls(model: model, clip: clip).macInspectorAnchor("inspector.analysis") }
                        if clip.kind == "multicam" { NativeMulticamControls(model: model, clip: clip).macInspectorAnchor("inspector.multicam") }
                        if clip.kind == "caption" { caption(clip).macInspectorAnchor("inspector.caption") }
                        if clip.kind != "audio" && clip.kind != "caption" {
                            transform(clip).macInspectorAnchor("inspector.transform")
                            if clip.kind == "title" { title(clip).macInspectorAnchor("inspector.text") }
                            if clip.kind == "shape" { shape(clip).macInspectorAnchor("inspector.shape") }
                            effects(clip).macInspectorAnchor("inspector.effects")
                            if clip.kind == "video" {
                                NativeVideoProcessingControls(model: model, clip: clip)
                                    .id("\(model.folder?.path ?? "")|\(model.composition ?? "main")|\(clip.id)")
                                    .macInspectorAnchor("inspector.processing")
                            }
                        }
                        Toggle("Enabled", isOn: Binding(get: { clip.fields.flag("enabled", true) }, set: { model.update(clip, ["enabled": $0]) }))
                            .macInspectorAnchor("inspector.notes")
                        NativeTextRow("Note", value: clip.fields.string("note")) { model.update(clip, ["note": $0]) }
                    } else {
                        projectControls.macInspectorAnchor("inspector.project")
                    }
                }.id("\(model.folder?.path ?? "")|\(model.composition ?? "main")|\(model.selectedID ?? "none")")
                NativeInspectorJobs(model: model).id("inspectorJobs")
            }.nativePanelPadding()
        }
    }

    #if os(macOS)
    private func macHeader(scroll: @escaping (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: model.selected == nil ? "slider.horizontal.3" : "cursorarrow.click")
                    .foregroundStyle(NativeEditorStyle.accent).frame(width: 16).padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.selected?.name ?? (model.composition == nil ? "Project" : "Composition"))
                        .font(.system(size: 12, weight: .semibold)).lineLimit(2).truncationMode(.middle)
                        .help(model.selected.map { "\($0.name) · \($0.id)" } ?? "Canvas format and new layers")
                    if let clip = model.selected {
                        Text("\(clip.kind.capitalized) · \(nativeTimecode(clip.duration, fps: model.fps))")
                            .font(.caption2).monospacedDigit().foregroundStyle(NativeEditorStyle.muted)
                    } else {
                        Text("\(Int(model.width)) × \(Int(model.height)) · \(model.fps.formatted()) fps")
                            .font(.caption2).monospacedDigit().foregroundStyle(NativeEditorStyle.muted)
                    }
                }
                Spacer(minLength: 0)
                if model.selected != nil {
                    Button { model.selectedID = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain).frame(width: 24, height: 24).contentShape(Rectangle())
                        .help("Clear selection").accessibilityLabel("Clear selection")
                }
            }
            HStack(spacing: 6) {
                Menu {
                    ForEach(NativeInspectorNavigation.sections(kind: model.selected?.kind), id: \.anchor) { section in
                        Button(section.title) { scroll(section.anchor) }
                    }
                } label: { Label("Jump to section", systemImage: "list.bullet") }
                    .menuStyle(.borderlessButton).font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Jump to inspector section")
                if model.chosenClipCount > 1 {
                    Text("\(model.chosenClipCount) selected").font(.caption2).foregroundStyle(NativeEditorStyle.muted)
                }
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(NativeEditorStyle.panel).foregroundStyle(NativeEditorStyle.text)
    }
    #endif

    private func timecodeRow(_ label: String, value: Double, range: ClosedRange<Double>, commit: @escaping (Double) -> Void) -> some View {
        #if os(iOS)
        let title = Text(label).font(.subheadline).foregroundStyle(NativeEditorStyle.muted).lineLimit(1).fixedSize()
        #else
        let title = Text(label).font(NativeType.control.weight(.regular)).foregroundStyle(NativeEditorStyle.muted).lineLimit(1).fixedSize()
        #endif
        let field = NativeTimecodeField(label: label, seconds: value, fps: model.fps, range: range, commit: commit)
        // A narrow inspector puts the label above the field instead of wrapping it letter by letter.
        return ViewThatFits(in: .horizontal) {
            HStack { title; Spacer(minLength: 8); field }
            VStack(alignment: .leading, spacing: 4) { title; field }
        }
    }

    private func transform(_ clip: NativeClip) -> some View {
        GroupBox("Transform") {
            VStack(spacing: 8) {
                if ["video", "image", "comp"].contains(clip.kind) {
                    Picker("Fit", selection: Binding(get: { clip.fields.string("fit", "contain") }, set: { model.update(clip, ["fit": $0]) })) {
                        Text("Fit inside").tag("contain"); Text("Fill canvas").tag("cover")
                    }
                }
                NativeNumberRow("X", value: clip.fields.number("x", model.width / 2)) { model.update(clip, ["x": $0]) }
                NativeNumberRow("Y", value: clip.fields.number("y", model.height / 2)) { model.update(clip, ["y": $0]) }
                NativeNumberRow("Scale", value: clip.fields.number("scale", 1), range: 0.01...5) { model.update(clip, ["scale": $0]) }
                NativeNumberRow("Rotation", value: clip.fields.number("rotation"), range: -180...180, step: 1) { model.update(clip, ["rotation": $0]) }
                NativeNumberRow("Opacity", value: clip.fields.number("opacity", 1), range: 0...1) { model.update(clip, ["opacity": $0]) }
                Picker("Blend", selection: Binding(get: { clip.fields.string("blend", "normal") }, set: { model.update(clip, ["blend": $0]) })) {
                    ForEach(["normal", "add", "screen", "multiply", "overlay", "softLight", "lighten", "darken", "difference", "colorDodge"], id: \.self) { Text($0).tag($0) }
                }
                Button("Reset transform") { model.update(clip, ["x": NSNull(), "y": NSNull(), "scale": NSNull(), "rotation": NSNull(), "opacity": NSNull()]) }
            }.padding(4)
        }
    }

    private func caption(_ clip: NativeClip) -> some View {
        var style = model.tracks.first { $0.clips.contains(where: { $0.id == clip.id }) }?.fields.dictionary("style") ?? [:]
        style.merge(clip.fields.dictionary("style")) { _, value in value }
        return GroupBox("Caption") {
            VStack(spacing: 8) {
                NativeTextRow("Text", value: clip.fields.string("text")) { model.update(clip, ["text": $0]) }
                NativeTextRow("Font family", value: style.string("font", "Inter")) { model.update(clip, ["style": ["font": $0]]) }
                NativeNumberRow("Size", value: style.number("size", 52), range: 6...300, step: 1) { model.update(clip, ["style": ["size": $0]]) }
                NativeNumberRow("Vertical position", value: style.number("y", 0.86), range: 0...1) { model.update(clip, ["style": ["y": $0]]) }
                NativeTextRow("Text color", value: style.string("color", "#ffffff")) { model.update(clip, ["style": ["color": $0]]) }
                NativeTextRow("Highlight color", value: style.string("highlightColor", "#ffe600")) { model.update(clip, ["style": ["highlightColor": $0]]) }
                NativeTextRow("Background", value: style.string("plate", "#00000088")) { model.update(clip, ["style": ["plate": $0]]) }
                NativeCaptionCueControls(model: model, clip: clip, weight: style.number("weight", 600))
                Text("Correct source words in Transcript. Caption edits change this timeline cue.").font(.caption2).foregroundStyle(.secondary)
            }.padding(4)
        }
    }

    private func title(_ clip: NativeClip) -> some View {
        let title = clip.fields.dictionary("title")
        return GroupBox("Text") {
            VStack(spacing: 8) {
                NativeTextRow("Text", value: title.string("text")) { model.update(clip, ["title": ["text": $0]]) }
                NativeTextRow("Font family", value: title.string("font", "Inter")) { model.update(clip, ["title": ["font": $0]]) }
                NativeNumberRow("Size", value: title.number("size", 120), range: 6...600, step: 1) { model.update(clip, ["title": ["size": $0]]) }
                NativeNumberRow("Weight", value: title.number("weight", 800), range: 100...900, step: 100) { model.update(clip, ["title": ["weight": $0]]) }
                NativeNumberRow("Tracking", value: title.number("tracking"), range: -20...100) { model.update(clip, ["title": ["tracking": $0]]) }
                NativeTitleAppearanceControls(model: model, clip: clip)
                Picker("Align", selection: Binding(get: { title.string("align", "center") }, set: { model.update(clip, ["title": ["align": $0]]) })) { ForEach(["left", "center", "right"], id: \.self) { Text($0.capitalized).tag($0) } }
                Picker("Animation", selection: Binding(get: { title.string("anim", "none") }, set: { model.update(clip, ["title": ["anim": $0]]) })) {
                    ForEach(["none", "fade", "rise", "drop", "pop", "slideLeft", "slideRight", "typewriter", "blurIn", "tracking"], id: \.self) { Text($0).tag($0) }
                }
            }.padding(4)
        }
    }

    private func shape(_ clip: NativeClip) -> some View {
        let shape = clip.fields.dictionary("shape")
        return GroupBox("Shape") {
            VStack(spacing: 8) {
                Picker("Type", selection: Binding(get: { shape.string("type", "rect") }, set: { model.update(clip, ["shape": ["type": $0]]) })) { ForEach(["rect", "ellipse", "polygon", "star", "line"], id: \.self) { Text($0.capitalized).tag($0) } }
                NativeNumberRow("Width", value: shape.number("width", 480), range: 1...4000, step: 1) { model.update(clip, ["shape": ["width": $0]]) }
                NativeNumberRow("Height", value: shape.number("height", 270), range: 1...4000, step: 1) { model.update(clip, ["shape": ["height": $0]]) }
                NativeNumberRow("Radius", value: shape.number("radius", 24), range: 0...500, step: 1) { model.update(clip, ["shape": ["radius": $0]]) }
                NativeShapeAppearanceControls(model: model, clip: clip)
            }.padding(4)
        }
    }

    private func effects(_ clip: NativeClip) -> some View {
        GroupBox("Effects and transition") {
            VStack(alignment: .leading, spacing: 8) {
                Menu("Add effect") {
                    ForEach(["blur", "sharpen", "vignette", "grain", "pixelate", "glow", "mirror", "invert", "posterize", "chromaticAberration", "letterbox"], id: \.self) { type in
                        Button(type.capitalized) { model.edit(["op": "effect", "id": clip.id, "type": type]) }
                    }
                }
                ForEach(Array(clip.fields.objects("effects").enumerated()), id: \.offset) { index, effect in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Toggle(effect.string("type").capitalized, isOn: Binding(get: { effect.flag("enabled", true) }, set: { model.edit(["op": "effect", "id": clip.id, "index": index, "enabled": $0]) }))
                            Button { model.edit(["op": "effect", "id": clip.id, "remove": index]) } label: { Image(systemName: "minus.circle") }.accessibilityLabel("Remove \(effect.string("type"))")
                        }
                        let params = effect.dictionary("params")
                        ForEach(params.keys.sorted(), id: \.self) { key in
                            if let value = params[key] as? NSNumber {
                                NativeNumberRow(key.capitalized, value: value.doubleValue, step: value.doubleValue >= 4 ? 1 : 0.01, showsSlider: false) {
                                    model.edit(["op": "effect", "id": clip.id, "index": index, "params": [key: $0]])
                                }
                            } else if let value = params[key] as? String {
                                if key == "axis" {
                                    Picker("Axis", selection: Binding(get: { value }, set: { model.edit(["op": "effect", "id": clip.id, "index": index, "params": [key: $0]]) })) { Text("Horizontal").tag("x"); Text("Vertical").tag("y") }
                                } else {
                                    NativeTextRow(key.capitalized, value: value) { model.edit(["op": "effect", "id": clip.id, "index": index, "params": [key: $0]]) }
                                }
                            }
                        }
                    }
                }
                Picker("Transition", selection: Binding(get: { clip.fields.dictionary("transitionIn").string("type", "none") }, set: { model.edit(["op": "transition", "id": clip.id, "type": $0, "dur": 0.5]) })) {
                    ForEach(["none", "crossDissolve", "dipBlack", "dipWhite", "wipeLeft", "wipeRight", "wipeUp", "wipeDown", "slideLeft", "slideRight", "pushLeft", "pushRight", "zoomIn", "iris", "blurDissolve"], id: \.self) { Text($0).tag($0) }
                }
                if !clip.fields.dictionary("transitionIn").isEmpty {
                    NativeNumberRow("Transition duration", value: clip.fields.dictionary("transitionIn").number("dur", 0.5), range: (2 / model.fps)...max(clip.duration, clip.fields.dictionary("transitionIn").number("dur", 0.5)), showsSlider: false) {
                        model.edit(["op": "transition", "id": clip.id, "type": clip.fields.dictionary("transitionIn").string("type"), "dur": $0])
                    }
                }
            }.padding(4)
        }
    }

    private var projectControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.composition == nil ? "Project" : "Composition").font(.headline)
            if let project = model.project {
                NativeTextRow("Name", value: model.canvas.string("name", project.name)) { updateCanvas(["name": $0]) }
                Picker("Format", selection: Binding(get: { "\(Int(model.width))x\(Int(model.height))" }, set: { value in
                    let dimensions = value.split(separator: "x").compactMap { Double($0) }
                    if dimensions.count == 2 { updateCanvas(["width": dimensions[0], "height": dimensions[1]]) }
                })) {
                    Text("16:9 HD").tag("1920x1080")
                    Text("16:9 UHD").tag("3840x2160")
                    Text("9:16 Portrait").tag("1080x1920")
                    Text("1:1 Square").tag("1080x1080")
                    if !["1920x1080", "3840x2160", "1080x1920", "1080x1080"].contains("\(Int(model.width))x\(Int(model.height))") {
                        Text("Custom").tag("\(Int(model.width))x\(Int(model.height))")
                    }
                }
                NativeNumberRow("Width", value: model.width, range: 16...8192, step: 1, showsSlider: false) { updateCanvas(["width": $0]) }
                NativeNumberRow("Height", value: model.height, range: 16...8192, step: 1, showsSlider: false) { updateCanvas(["height": $0]) }
                NativeNumberRow("Frame rate", value: model.fps, range: 1...120, step: 1, showsSlider: false) { updateCanvas(["fps": $0]) }
            }
            if model.composition != nil {
                NativeNumberRow("Composition duration", value: model.canvas.number("duration", model.duration), range: (1 / model.fps)...max(600, model.duration), showsSlider: false) { updateCanvas(["duration": $0]) }
            }
            Divider()
            Button("Add title") { model.edit(["op": "add_title", "text": "Title", "start": model.time, "dur": 5, "title": ["font": "Inter", "anim": "none"]]) }
            Button("Add shape") { model.edit(["op": "add_shape", "shape": ["type": "rect"], "start": model.time, "dur": 5, "track": model.tracks.first { $0.kind == "video" && !$0.locked }?.id ?? "V1"]) }
            Button("Add color") { model.edit(["op": "add_color", "color": "#203040", "start": model.time, "dur": 5]) }
            Button("Add adjustment layer") { model.edit(["op": "adjustment", "start": model.time, "dur": 5]) }
            Button("Add null") { model.edit(["op": "add_null", "start": model.time, "dur": 5, "name": "Null", "track": model.tracks.first { $0.kind == "video" && !$0.locked }?.id ?? "V1"]) }
            Text("Select a timeline clip to edit its timing, transform, text, and effects.").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func updateCanvas(_ fields: [String: Any]) {
        if let comp = model.composition { model.edit(["op": "update_comp", "target": comp, "set": fields]) }
        else { model.edit(["op": "project", "set": fields]) }
    }
}

private struct NativeSourceAnalysisControls: View {
    @ObservedObject var model: NativeEditorModel
    let clip: NativeClip
    @State private var kind = "scenes"
    @State private var threshold = 10.0
    @State private var noise = -32.0
    @State private var minimum = 0.45
    @State private var starting = false
    private var available: [String] {
        let asset = model.project?.assets.first { $0.id == clip.source }?.fields ?? [:], caps = model.capabilities.dictionary("analysis")
        return ["scenes", "silence", "beats"].filter { caps.flag($0) && asset.flag($0 == "scenes" ? "hasVideo" : "hasAudio") }
    }
    var body: some View {
        GroupBox("Source analysis") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Analyzes the whole source. Results show source times; marker and split actions are separate.").font(.caption2).foregroundStyle(.secondary)
                Picker("Detection", selection: $kind) { ForEach(available, id: \.self) { Text($0.capitalized).tag($0) } }
                if kind == "scenes" { NativeNumberRow("Scene threshold", value: threshold, range: 0.1...100) { threshold = $0 } }
                if kind == "silence" {
                    NativeNumberRow("Silence level dB", value: noise, range: -100...0) { noise = $0 }
                    NativeNumberRow("Minimum seconds", value: minimum, range: 0.05...30) { minimum = $0 }
                }
                Button(starting ? "Starting analysis" : "Analyze source", action: start).disabled(starting || !available.contains(kind))
                if available.isEmpty { Text("This source has no supported analysis track.").font(.caption2).foregroundStyle(.secondary) }
            }.padding(4)
        }
        .onAppear { if !available.contains(kind) { kind = available.first ?? "scenes" } }
        .onChange(of: clip.id) { _, _ in if !available.contains(kind) { kind = available.first ?? "scenes" } }
    }
    private func start() {
        do {
            let capture = try NativeInspectorWorkflow.Capture(model: model, id: clip.id)
            let body = try capture.request(route: "/api/analyze", options: ["kind": kind, "threshold": threshold, "noise": noise, "min": minimum], capabilities: model.capabilities)
            starting = true
            model.perform {
                defer { starting = false }
                guard capture.matches(model) else { throw NativeInspectorWorkflow.Failure("The project, selection or source changed before analysis started. Try again.") }
                _ = try await model.call("/api/analyze", body)
            }
        } catch { model.status = error.localizedDescription }
    }
}

private struct NativeInspectorJobs: View {
    @ObservedObject var model: NativeEditorModel
    private var jobs: [[String: Any]] {
        NativeInspectorWorkflow.visibleJobs(model.jobs)
    }
    var body: some View {
        GroupBox("Processing and analysis jobs") {
            VStack(alignment: .leading, spacing: 10) {
                if jobs.isEmpty { Text("Jobs remain available here when you change selection or reopen this panel.").font(.caption2).foregroundStyle(.secondary) }
                ForEach(jobs, id: \.jobIdentity) { job in NativeInspectorJobCard(model: model, job: job) }
            }.padding(4)
        }
    }
}

private extension Dictionary where Key == String, Value == Any { var jobIdentity: String { string("id") } }

private struct NativeInspectorJobCard: View {
    @ObservedObject var model: NativeEditorModel
    let job: [String: Any]
    @State private var showingResults = false
    @State private var preview: OutputPreview?
    private struct OutputPreview: Identifiable {
        let id = UUID()
        let url: URL
        let folder: URL
        let identity: NativeSourceFileIdentity
    }
    private var running: Bool { ["queued", "running"].contains(job.string("state")) }
    private var output: String { job.string("output", job.dictionary("result").string("path")) }
    private var capture: NativeInspectorWorkflow.Capture? { try? .init(record: job.dictionary("spec").dictionary("uiCapture")) }
    private var warnings: [String] {
        let result = job.dictionary("result"), measurements = job.dictionary("measurements")
        return Array(((result["warnings"] as? [String] ?? []) + (measurements["warnings"] as? [String] ?? []) +
            [job.string("error"), job.string("applyError", result.string("applyError"))].filter { !$0.isEmpty }).prefix(20))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(job.string("kind").capitalized).font(.caption.weight(.semibold))
                Spacer(minLength: 0)
                Text(NativeInspectorWorkflow.jobStatus(job)).font(.caption2).foregroundStyle(NativeEditorStyle.accent)
            }
            Text(job.dictionary("spec").string("src")).font(.caption2).lineLimit(2).textSelection(.enabled)
            if let capture { Text("Clip \(capture.id) · \(capture.composition ?? "Main timeline")").font(.caption2).foregroundStyle(.secondary) }
            if running {
                if ["retime", "person-mask", "denoise", "stabilize"].contains(job.string("kind")) { ProgressView(value: min(1, max(0, job.number("progress")))) }
                else { ProgressView("Analyzing") }
                Button("Cancel job", action: cancel)
            }
            if job.string("state") == "done", ["scenes", "silence", "beats"].contains(job.string("kind")) {
                Button("Inspect source-time results") { showingResults = true }.disabled(capture == nil)
            }
            if !output.isEmpty {
                Text(output).font(.caption2).textSelection(.enabled)
                Button("Preview saved output", action: openOutput)
            }
            ForEach(Array(warnings.enumerated()), id: \.offset) { _, warning in Text(String(warning.prefix(1200))).font(.caption2).foregroundStyle(.secondary) }
            let measurements = job.dictionary("measurements").isEmpty ? job.dictionary("result") : job.dictionary("measurements")
            if !measurements.isEmpty { Text(String(NativeProcessingSummary(measurements).prefix(8000))).font(.caption2).textSelection(.enabled) }
        }.padding(8).background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 6))
        .sheet(isPresented: $showingResults) { if let capture { NativeAnalysisResults(model: model, jobID: job.string("id"), capture: capture) } }
        .sheet(item: $preview) { output in NativeProcessingOutputPreview(model: model, url: output.url, folder: output.folder, identity: output.identity) }
    }
    private func cancel() {
        let id = job.string("id"), folder = model.folder
        model.perform {
            guard folder == model.folder, let current = model.jobs.first(where: { $0.string("id") == id }), ["running", "queued"].contains(current.string("state")) else { return }
            _ = try await model.call("/api/jobs/cancel", ["id": id])
        }
    }
    private func openOutput() {
        do {
            guard let folder = model.folder else { return }
            let url = try model.mediaURL(output), identity = try NativeSourceFileIdentity(file: url)
            preview = OutputPreview(url: url, folder: folder, identity: identity)
        } catch { model.status = error.localizedDescription }
    }
}

private struct NativeAnalysisResults: View {
    @ObservedObject var model: NativeEditorModel
    let jobID: String
    let capture: NativeInspectorWorkflow.Capture
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<Int> = []
    @State private var error = ""
    private var job: [String: Any] { model.jobs.first { $0.string("id") == jobID } ?? [:] }
    private var results: NativeInspectorWorkflow.Results { NativeInspectorWorkflow.results(job.dictionary("result"), kind: job.string("kind")) }
    private var editable: Bool { capture.linear && capture.unlocked && capture.matches(model) }
    var body: some View {
        #if os(iOS)
        ScrollView { content.padding(16) }
            .scrollBounceBehavior(.basedOnSize)
            .background(NativeEditorStyle.background)
        #else
        content.padding(16).frame(minWidth: 340, idealWidth: 700, minHeight: 440, idealHeight: 650).background(NativeEditorStyle.background)
        #endif
    }
    private var content: some View {
        let canEdit = editable
        return VStack(alignment: .leading, spacing: 12) {
            #if os(iOS)
            HStack(alignment: .top) {
                Text("Source-time \(job.string("kind")) results").font(.headline).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button { dismiss() } label: {
                    Text("Close").fixedSize(horizontal: false, vertical: true)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }.layoutPriority(1)
            }
            #else
            HStack { Text("Source-time \(job.string("kind")) results").font(.headline); Spacer(); Button("Close") { dismiss() } }
            #endif
            Text(capture.source).font(.caption).textSelection(.enabled)
            Text("The detector scanned the whole source. Timeline actions use this captured clip's in point, speed and start.").font(.caption2).foregroundStyle(.secondary)
            Text("\(results.total) results · \(selected.count) selected").font(.caption)
            if results.truncated { Text("Showing the first 1,000 results. Each action accepts up to 256 events.").font(.caption2).foregroundStyle(.secondary) }
            if !canEdit { Text("Select the captured clip in its original unchanged project to add markers or splits. Reverse, freeze and time maps are unsupported.").font(.caption2).foregroundStyle(.secondary) }
            #if os(iOS)
            ViewThatFits(in: .horizontal) {
                HStack { mobileActions }.fixedSize(horizontal: true, vertical: false)
                VStack(alignment: .leading, spacing: 8) { mobileActions }
            }.buttonStyle(NativeToolbarButtonStyle())
            #else
            HStack {
                Button("Select in-clip results") { selectInClip() }.disabled(!canEdit)
                Button("Clear") { selected = [] }
                Spacer()
                Button("Add markers") { apply(split: false) }.disabled(!canEdit || selected.isEmpty)
                Button("Split selected clip") { apply(split: true) }.disabled(!canEdit || selected.isEmpty)
            }.buttonStyle(NativeToolbarButtonStyle())
            #endif
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
            #if os(iOS)
            resultRows
            #else
            ScrollView { resultRows }
            #endif
        }
    }
    #if os(iOS)
    @ViewBuilder private var mobileActions: some View {
        Button("Select in-clip results") { selectInClip() }.disabled(!editable)
        Button("Clear") { selected = [] }
        Button("Add markers") { apply(split: false) }.disabled(!editable || selected.isEmpty)
        Button("Split selected clip") { apply(split: true) }.disabled(!editable || selected.isEmpty)
    }
    #endif
    private var resultRows: some View {
        let canEdit = editable, canPreview = capture.sourceMatches(model)
        return LazyVStack(alignment: .leading, spacing: 6) {
            if results.events.isEmpty { Text("No events were detected.").foregroundStyle(.secondary) }
            ForEach(results.events) { event in
                HStack {
                    Button { if !selected.insert(event.id).inserted { selected.remove(event.id) } } label: {
                        Image(systemName: selected.contains(event.id) ? "checkmark.circle.fill" : "circle")
                            #if os(iOS)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                            #endif
                    }.buttonStyle(.plain)
                    #if os(iOS)
                    .accessibilityLabel("Result selection for \(event.label)")
                    .accessibilityValue(selected.contains(event.id) ? "Selected" : "Not selected")
                    #endif
                    VStack(alignment: .leading, spacing: 3) {
                        Text(event.label).font(.caption.weight(.semibold))
                        Text(String(format: "Source %.3f s", event.source) + (event.end.map { String(format: " to %.3f s", $0) } ?? "")).font(.caption2).monospacedDigit()
                        if let mapped = capture.timeline(event.source) { Text(String(format: "Timeline %.3f s", mapped)).font(.caption2).foregroundStyle(.secondary) }
                        else { Text("Outside this clip's forward source window").font(.caption2).foregroundStyle(.secondary) }
                        #if os(iOS)
                        ViewThatFits(in: .horizontal) {
                            HStack { eventActions(event) }.fixedSize(horizontal: true, vertical: false)
                            VStack(alignment: .leading, spacing: 6) { eventActions(event) }
                        }.buttonStyle(NativeToolbarButtonStyle())
                        #endif
                    }
                    #if !os(iOS)
                    Spacer()
                    Button("Preview source") { preview(event) }.disabled(!canPreview)
                    if let mapped = capture.timeline(event.source) { Button("Seek timeline") { model.showingSource = false; model.seek(mapped) }.disabled(!canEdit) }
                    #endif
                }.padding(8).background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 5))
            }
        }
    }
    #if os(iOS)
    @ViewBuilder private func eventActions(_ event: NativeInspectorWorkflow.Event) -> some View {
        Button("Preview source") { preview(event) }.disabled(!capture.sourceMatches(model))
        if let mapped = capture.timeline(event.source) { Button("Seek timeline") { model.showingSource = false; model.seek(mapped) }.disabled(!editable) }
    }
    #endif
    private func selectInClip() {
        selected = Set(results.events.filter { capture.timeline($0.source) != nil || $0.end.flatMap(capture.timeline) != nil }.prefix(256).map(\.id))
    }
    private func preview(_ event: NativeInspectorWorkflow.Event) {
        guard capture.sourceMatches(model), let asset = model.project?.assets.first(where: { $0.id == capture.source }) else { error = "The analyzed source changed. Run analysis again."; return }
        model.openSource(asset); model.seekSource(event.source)
    }
    private func apply(split: Bool) {
        do {
            guard capture.matches(model), capture.sourceMatches(model) else { throw NativeInspectorWorkflow.Failure("The project, selection or source changed. Run analysis again before applying results.") }
            let ops = try capture.operations(events: results.events, selected: selected, split: split)
            let request: [String: Any] = ["ops": ops, "summary": split ? "Split clip from source analysis" : "Add source-analysis markers",
                                          "who": "you", "returnProject": true, "expectedVersion": capture.version]
            model.perform { [self] in
                do {
                    guard capture.matches(model), capture.sourceMatches(model) else { throw NativeInspectorWorkflow.Failure("The project, selection or analyzed source changed before the edit started. Run analysis again before applying results.") }
                    _ = try await model.call("/api/ops", request)
                } catch {
                    self.error = error.localizedDescription
                    throw error
                }
            }
        } catch { self.error = error.localizedDescription }
    }
}

private struct NativeProcessingOutputPreview: View {
    @ObservedObject var model: NativeEditorModel
    let url: URL
    let folder: URL
    let identity: NativeSourceFileIdentity
    @Environment(\.dismiss) private var dismiss
    @State private var time = 0.0
    @State private var duration = 1.0
    @State private var image: CGImage?
    @State private var error = ""
    var body: some View {
        #if os(iOS)
        ScrollView { content.padding(16) }
            .scrollBounceBehavior(.basedOnSize)
            .background(NativeEditorStyle.background)
            .task(id: time) { await frame(at: time) }
        #else
        content.padding(16).frame(minWidth: 340, idealWidth: 700, minHeight: 400).background(NativeEditorStyle.background)
            .task(id: time) { await frame(at: time) }
        #endif
    }
    private var content: some View {
        VStack(spacing: 12) {
            #if os(iOS)
            HStack(alignment: .top) {
                Text("Saved output frame preview").font(.headline).fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button { dismiss() } label: {
                    Text("Close").fixedSize(horizontal: false, vertical: true)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }.layoutPriority(1)
            }
            #else
            HStack { Text("Saved output frame preview").font(.headline); Spacer(); Button("Close") { dismiss() } }
            #endif
            Text(url.lastPathComponent).font(.caption).textSelection(.enabled)
            ZStack {
                Canvas { context, size in
                    for y in stride(from: 0.0, to: min(1000, size.height), by: 16) {
                        for x in stride(from: 0.0, to: min(1600, size.width), by: 16) {
                            context.fill(Path(CGRect(x: x, y: y, width: 16, height: 16)), with: .color((Int(x + y) / 16) % 2 == 0 ? .gray.opacity(0.25) : .gray.opacity(0.5)))
                        }
                    }
                }
                if let image { Image(decorative: image, scale: 1).resizable().scaledToFit() }
                else if error.isEmpty { ProgressView("Decoding frame") }
            }.frame(maxWidth: .infinity, minHeight: 220, maxHeight: 440).clipped()
            Slider(value: $time, in: 0...max(0.001, duration - 0.001))
            Text(String(format: "Source %.3f s", time)).font(.caption).monospacedDigit()
            Text("Alpha appears over the checkerboard. This preview does not apply the saved source to a clip.").font(.caption2).foregroundStyle(.secondary)
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
        }
    }
    private func frame(at requested: Double) async {
        do {
            guard folder == model.folder, try NativeSourceFileIdentity(file: url) == identity else { throw NativeInspectorWorkflow.Failure("The output or project changed. Open the preview again.") }
            let asset = AVURLAsset(url: url), seconds = try await asset.load(.duration).seconds
            guard seconds.isFinite, seconds > 0 else { throw NativeInspectorWorkflow.Failure("The saved output has no readable video duration.") }
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true; generator.maximumSize = CGSize(width: 1920, height: 1080)
            let frame = try await generator.image(at: CMTime(seconds: min(requested, max(0, seconds - 0.001)), preferredTimescale: 60000)).image
            guard !Task.isCancelled, folder == model.folder, time == requested, try NativeSourceFileIdentity(file: url) == identity else { return }
            duration = seconds; image = frame; error = ""
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

private struct NativeVideoProcessingControls: View {
    @ObservedObject var model: NativeEditorModel
    let clip: NativeClip
    @State private var quality = "balanced"
    @State private var codec = "auto"
    @State private var strength = 0.65
    @State private var spatial = 0.5
    @State private var temporal = 0.8
    @State private var detail = 0.7
    @State private var sigma = 0.06
    @State private var smoothing = 0.4
    @State private var stabilizationStrength = 1.0
    @State private var crop = "auto"
    @State private var maxCrop = 0.2
    @State private var zoom = 1.05
    @State private var registration = "translation"
    @State private var outputSpeed = 0.5
    @State private var applyOutput = true
    @State private var format: NativeInspectorWorkflow.Format?
    @State private var formatFile: [String: String] = [:]
    @State private var formatError = ""
    @State private var formatRefresh = 0
    @State private var starting = false
    @State private var hydratedClip = ""
    private var controlsClipKey: String { "\(model.folder?.path ?? "")|\(model.composition ?? "")|\(clip.id)" }
    private var controlsSettingsKey: String {
        controlsClipKey + "|" + (NativeInspectorWorkflow.canonical(["denoise": clip.fields.dictionary("noiseReduction").dictionary("settings"), "stabilize": clip.fields.dictionary("deshake").dictionary("settings")])?.base64EncodedString() ?? "")
    }
    private func hasDerivedSource(_ key: String) -> Bool { !clip.source.isEmpty && clip.fields.dictionary(key).string("output") == clip.source }
    private var processing: [String: Any] { model.capabilities.dictionary("processing") }
    private var availableCodecs: [String] {
        let codecs = processing["codecs"] as? [String] ?? ["auto"]
        guard let format else { return codecs }
        return codecs.filter { format.alpha ? $0 == "prores-4444" : !format.hdr || $0 != "h264" }
    }
    private var formatKey: String { "\(model.folder?.path ?? "")|\(clip.source)|\(formatRefresh)" }
    private var running: Bool {
        model.jobs.contains { job in
            let spec = job.dictionary("spec")
            return ["running", "queued"].contains(job.string("state")) && spec.string("id") == clip.id &&
                (spec["comp"] as? String) == model.composition && spec.string("src") == clip.source
        }
    }
    private var recommendation: [String: Any] {
        guard let job = model.jobs.reversed().first(where: { ["noise", "stabilization"].contains($0.string("kind")) && $0.string("state") == "done" &&
            $0.dictionary("spec").string("id") == clip.id && ($0.dictionary("spec")["comp"] as? String) == model.composition }),
              let capture = try? NativeInspectorWorkflow.Capture(record: job.dictionary("spec").dictionary("uiCapture")), capture.matches(model) else { return [:] }
        return job.dictionary("result").dictionary("recommendation")
    }
    private var canRender: Bool {
        !running && !starting && format != nil && !availableCodecs.isEmpty && clip.fields.number("speed", 1) > 0 && !clip.fields.flag("reverse") && clip.fields["freeze"] == nil && clip.fields["timeMap"] == nil &&
            model.tracks.first(where: { $0.clips.contains { $0.id == clip.id } })?.locked == false
    }
    var body: some View {
        GroupBox("Video processing") {
            VStack(alignment: .leading, spacing: 8) {
                Picker("Output codec", selection: $codec) { ForEach(availableCodecs, id: \.self) { Text($0).tag($0) } }
                Toggle("Apply derived source when complete", isOn: $applyOutput)
                Text("Creates a saved derived source. Applying replaces this clip's source in one undoable edit. Jobs and saved outputs remain listed below.").font(.caption2).foregroundStyle(.secondary)
                if let format {
                    Text(format.alpha ? "Source has alpha. Output uses ProRes 4444." : format.hdr ? "HDR source. Choose Auto, HEVC or ProRes." : "SDR source. Auto uses H.264.").font(.caption2).foregroundStyle(.secondary)
                } else if formatError.isEmpty { ProgressView("Checking source format") }
                if !formatError.isEmpty { Text(formatError).font(.caption2).foregroundStyle(.secondary) }
                Button("Recheck source format") { formatRefresh += 1 }
                if model.capabilities.dictionary("analysis").flag("autoReframe") {
                    DisclosureGroup("Auto reframe") {
                        Text("Follow the salient subject within this composition's canvas. The result is editable position keyframes.").font(.caption2).foregroundStyle(.secondary)
                        Button("Auto reframe selected clip") {
                            start("/api/analysis/autoreframe", ["width": model.width, "height": model.height, "fps": 2, "apply": true, "wait": false, "expectedVersion": model.version])
                        }.disabled(running || starting || !canRender)
                    }
                }
                if processing.flag("videoDenoise") {
                    DisclosureGroup("Denoise") {
                        Picker("Quality", selection: $quality) { ForEach(["fast", "balanced", "high"], id: \.self) { Text($0.capitalized).tag($0) } }
                        NativeNumberRow("Strength", value: strength, range: 0...1) { strength = $0 }
                        NativeNumberRow("Spatial", value: spatial, range: 0...1) { spatial = $0 }
                        NativeNumberRow("Temporal", value: temporal, range: 0...1) { temporal = $0 }
                        NativeNumberRow("Preserve detail", value: detail, range: 0...1) { detail = $0 }
                        NativeNumberRow("Noise sigma", value: sigma, range: 0.002...0.25, step: 0.002) { sigma = $0 }
                        Button("Measure noise and suggest settings") { analyze("noise") }.disabled(running || starting)
                        if quality == "fast" { Text("Fast quality uses spatial reduction only.").font(.caption2).foregroundStyle(.secondary) }
                        if hasDerivedSource("noiseReduction") {
                            Text("Restore the saved source before adjusting and rendering a replacement denoise pass.").font(.caption2).foregroundStyle(.secondary)
                            Button("Restore source before denoise") { restore("noiseReduction") }.disabled(running || starting)
                        }
                        Button("Denoise selected clip") { start("/api/video/denoise", ["quality": quality, "strength": strength, "spatial": spatial, "temporal": temporal, "detail": detail, "sigma": sigma]) }.disabled(!canRender || hasDerivedSource("noiseReduction"))
                    }
                }
                if processing.flag("deshake") {
                    DisclosureGroup("Stabilize") {
                        NativeNumberRow("Smoothing seconds", value: smoothing, range: 0.1...3) { smoothing = $0 }
                        NativeNumberRow("Strength", value: stabilizationStrength, range: 0...1) { stabilizationStrength = $0 }
                        Picker("Motion model", selection: $registration) { Text("Translation").tag("translation"); Text("Homography").tag("homography") }
                        Picker("Crop", selection: $crop) { Text("Automatic").tag("auto"); Text("Fixed zoom").tag("fixed"); Text("Edge extension").tag("none") }
                        if crop == "auto" { NativeNumberRow("Maximum crop", value: maxCrop, range: 0...0.3) { maxCrop = $0 } }
                        if crop == "fixed" { NativeNumberRow("Zoom", value: zoom, range: 1...1.5) { zoom = $0 } }
                        Button("Measure motion and suggest settings") { analyze("stabilization") }.disabled(running || starting)
                        if hasDerivedSource("deshake") {
                            Text("Restore the saved source before adjusting and rendering a replacement stabilization pass.").font(.caption2).foregroundStyle(.secondary)
                            Button("Restore source before stabilization") { restore("deshake") }.disabled(running || starting)
                        }
                        Button("Stabilize selected clip") { start("/api/stabilize/render", ["smoothing": smoothing, "strength": stabilizationStrength, "model": registration, "crop": crop, "maxCrop": maxCrop, "zoom": zoom]) }.disabled(!canRender || hasDerivedSource("deshake"))
                    }
                }
                if model.capabilities.dictionary("analysis").flag("opticalFlow") {
                    DisclosureGroup("Optical-flow retime") {
                        NativeNumberRow("Output speed", value: outputSpeed, range: 0.05...4) { outputSpeed = $0 }
                        Text(String(format: "Source range %.2f s. Derived duration approximately %.2f s.", clip.duration * clip.fields.number("speed", 1), clip.duration * clip.fields.number("speed", 1) / max(0.05, outputSpeed))).font(.caption2).foregroundStyle(.secondary)
                        Text("Applying uses the new duration and a saved source at speed 1. Inspect the output and job warnings before export.").font(.caption2).foregroundStyle(.secondary)
                        Button("Render optical-flow source") { start("/api/retime", ["speed": outputSpeed]) }.disabled(!canRender)
                    }
                }
                if model.capabilities.dictionary("analysis").flag("personMask") {
                    DisclosureGroup("Person cutout") {
                        Text("Creates transparent person video in ProRes 4444. Preview the saved frames over a checkerboard to inspect the mask.").font(.caption2).foregroundStyle(.secondary)
                        Button("Render person cutout") { start("/api/analysis/person-mask", ["codec": "prores-4444"]) }
                            .disabled(!canRender || !processing.flag("preservesAlpha") || !(processing["codecs"] as? [String] ?? []).contains("prores-4444"))
                    }
                }
                if !recommendation.isEmpty { Button("Use measured settings", action: useRecommendation) }
                if clip.fields.flag("reverse") || clip.fields["freeze"] != nil || clip.fields["timeMap"] != nil { Text("Applied processing requires a forward clip with constant positive speed.").font(.caption2).foregroundStyle(.secondary) }
            }.padding(4)
        }
        .task(id: formatKey) { await loadFormat() }
        .task(id: controlsSettingsKey) { hydrateSettings() }
        .onChange(of: availableCodecs) { _, codecs in if !codecs.contains(codec) { codec = codecs.first ?? "auto" } }
    }
    private func hydrateSettings() {
        if hydratedClip != controlsClipKey {
            quality = "balanced"; codec = "auto"; strength = 0.65; spatial = 0.5; temporal = 0.8; detail = 0.7; sigma = 0.06
            smoothing = 0.4; stabilizationStrength = 1; crop = "auto"; maxCrop = 0.2; zoom = 1.05; registration = "translation"
            hydratedClip = controlsClipKey
        }
        func bounded(_ settings: [String: Any], _ key: String, _ value: Double, _ range: ClosedRange<Double>) -> Double {
            let number = settings.number(key, value); return number.isFinite && range.contains(number) ? number : value
        }
        let denoise = clip.fields.dictionary("noiseReduction").dictionary("settings")
        if !denoise.isEmpty {
            quality = ["fast", "balanced", "high"].contains(denoise.string("quality")) ? denoise.string("quality") : quality
            strength = bounded(denoise, "strength", strength, 0...1); spatial = bounded(denoise, "spatial", spatial, 0...1); temporal = bounded(denoise, "temporal", temporal, 0...1); detail = bounded(denoise, "detail", detail, 0...1); sigma = bounded(denoise, "sigma", sigma, 0.002...0.25)
            if ["auto", "h264", "hevc", "prores-422hq", "prores-4444"].contains(denoise.string("codec")) { codec = denoise.string("codec") }
        }
        let stabilize = clip.fields.dictionary("deshake").dictionary("settings")
        if !stabilize.isEmpty {
            smoothing = bounded(stabilize, "smoothing", smoothing, 0.1...3); stabilizationStrength = bounded(stabilize, "strength", stabilizationStrength, 0...1); maxCrop = bounded(stabilize, "maxCrop", maxCrop, 0...0.3); zoom = bounded(stabilize, "zoom", zoom, 1...1.5)
            if ["auto", "fixed", "none"].contains(stabilize.string("crop")) { crop = stabilize.string("crop") }
            if ["translation", "homography"].contains(stabilize.string("model")) { registration = stabilize.string("model") }
            if ["auto", "h264", "hevc", "prores-422hq", "prores-4444"].contains(stabilize.string("codec")) { codec = stabilize.string("codec") }
        }
        if format != nil, !availableCodecs.contains(codec) { codec = availableCodecs.first ?? "auto" }
    }
    private func restore(_ key: String) {
        guard !starting, !running else { return }
        do {
            let capture = try NativeInspectorWorkflow.Capture(model: model, id: clip.id)
            guard let fields = model.project?.fields else { throw NativeInspectorWorkflow.Failure("Open a project before restoring a source.") }
            let operations = try capture.restoreProcessing(key, fields: fields)
            let source = (operations[0]["set"] as? [String: Any])?.string("src") ?? ""
            let identity = try NativeSourceFileIdentity(file: model.mediaURL(source))
            starting = true
            model.perform {
                defer { starting = false }
                guard capture.matches(model), try NativeSourceFileIdentity(file: model.mediaURL(source)) == identity else { throw NativeInspectorWorkflow.Failure("The project or saved source changed before restoration. Try again.") }
                _ = try await model.call("/api/ops", ["ops": operations, "expectedVersion": capture.version, "summary": "Restored source before video processing"])
            }
        } catch { model.status = error.localizedDescription }
    }
    private func loadFormat() async {
        format = nil; formatError = ""; formatFile = [:]
        do {
            let capture = try NativeInspectorWorkflow.Capture(model: model, id: clip.id)
            let asset = AVURLAsset(url: try model.mediaURL(capture.source))
            guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw NativeInspectorWorkflow.Failure("This source has no readable video track.") }
            let descriptions = try await track.load(.formatDescriptions), characteristics = try await track.load(.mediaCharacteristics)
            let extensions = (descriptions.first.flatMap { CMFormatDescriptionGetExtensions($0) } as NSDictionary?) ?? [:]
            let transfer = extensions[kCMFormatDescriptionExtension_TransferFunction] as? String
            guard !Task.isCancelled, capture.sourceMatches(model) else { return }
            format = NativeInspectorWorkflow.Format(hdr: transfer == kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String || transfer == kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG as String, alpha: characteristics.contains(.containsAlphaChannel))
            formatFile = capture.record["file"] as? [String: String] ?? [:]
        } catch { if !Task.isCancelled { formatError = error.localizedDescription } }
    }
    private func analyze(_ kind: String) {
        do {
            let capture = try NativeInspectorWorkflow.Capture(model: model, id: clip.id)
            let body = try capture.request(route: "/api/analyze", options: ["kind": kind], capabilities: model.capabilities)
            starting = true
            model.perform {
                defer { starting = false }
                guard capture.matches(model) else { throw NativeInspectorWorkflow.Failure("The project, selection or source changed before measurement. Try again.") }
                _ = try await model.call("/api/analyze", body)
            }
        } catch { model.status = error.localizedDescription }
    }
    private func useRecommendation() {
        if recommendation.string("route") == "/api/video/denoise" {
            quality = recommendation.string("quality", quality); strength = recommendation.number("strength", strength); spatial = recommendation.number("spatial", spatial); temporal = recommendation.number("temporal", temporal); detail = recommendation.number("detail", detail); sigma = recommendation.number("sigma", sigma)
        } else {
            smoothing = recommendation.number("smoothing", smoothing); stabilizationStrength = recommendation.number("strength", stabilizationStrength); crop = recommendation.string("crop", crop); maxCrop = recommendation.number("maxCrop", maxCrop); registration = recommendation.string("model", registration)
        }
    }
    private func start(_ route: String, _ options: [String: Any]) {
        guard !starting, !running else { return }
        do {
            let capture = try NativeInspectorWorkflow.Capture(model: model, id: clip.id)
            if route != "/api/analysis/autoreframe", capture.record["file"] as? [String: String] != formatFile { throw NativeInspectorWorkflow.Failure("The source format changed. Recheck it before rendering.") }
            var settings = options
            if settings["codec"] == nil { settings["codec"] = codec }
            if settings["apply"] == nil { settings["apply"] = applyOutput }
            let body = try capture.request(route: route, options: settings, capabilities: model.capabilities, format: format)
            starting = true
            model.perform {
                defer { starting = false }
                guard capture.matches(model) else { throw NativeInspectorWorkflow.Failure("The project, selection or source changed before processing. Try again.") }
                _ = try await model.call(route, body)
            }
        } catch { model.status = error.localizedDescription }
    }
}

func NativeProcessingSummary(_ fields: [String: Any]) -> String {
    fields.keys.sorted().compactMap { key in
        guard let value = fields[key], value is String || value is NSNumber else { return nil }
        return "\(key): \(value)"
    }.joined(separator: "\n")
}

private extension View {
    @ViewBuilder func macInspectorAnchor(_ anchor: String) -> some View {
        #if os(macOS)
        self.id(anchor)
        #else
        self
        #endif
    }
}

// BEGIN CAPTION CUE WORD EDITING
private enum NativeCaptionWordUpdate {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
        init(_ message: String) { self.message = message }
    }

    static let whitespace = CharacterSet(charactersIn: " \t\n\u{0B}\u{0C}\r\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")

    static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
        return number.doubleValue
    }

    static func canonical(_ value: Any) -> Data? {
        guard JSONSerialization.isValidJSONObject(value) else { return nil }
        return try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }

    static func update(clip: [String: Any], index: Int, patch: [String: Any], composition: String?, fps: Double) throws -> [String: Any] {
        guard clip["kind"] as? String == "caption", let id = clip["id"] as? String, !id.isEmpty,
              let duration = number(clip["dur"]), duration > 0,
              var words = clip["words"] as? [[String: Any]], words.count <= 100_000, words.indices.contains(index) else {
            throw Failure("Select a timed caption word first.")
        }
        guard Set(patch.keys).isSubset(of: ["text", "t", "end"]) else { throw Failure("Only the word text and cue timing can change.") }
        let prior = words[index]
        var next = prior
        next.merge(patch) { _, value in value }
        guard let rawText = next["text"] as? String else { throw Failure("A caption word needs text.") }
        let wordText = rawText.trimmingCharacters(in: whitespace)
        guard !wordText.isEmpty, wordText.utf16.count <= 1000 else { throw Failure("A caption word needs 1 to 1000 characters.") }
        guard var start = number(next["t"]), var end = number(next["end"]) else { throw Failure("Enter finite numbers for the word start and end.") }
        let tolerance = (fps.isFinite && fps > 0 ? 1 / fps : 1 / 30) + 1e-6
        if patch["t"] == nil, start < 0, start >= -tolerance { start = 0 }
        if patch["end"] == nil, end > duration, end <= duration + tolerance { end = duration }
        guard start >= 0, end > start, end <= duration else { throw Failure("Word timing must stay inside this caption cue, with its end after its start.") }
        if index > 0 {
            guard let previous = number(words[index - 1]["t"]), start >= previous else { throw Failure("Word starts must stay in transcript order.") }
        }
        if index + 1 < words.count {
            guard let following = number(words[index + 1]["t"]), start <= following else { throw Failure("Word starts must stay in transcript order.") }
        }
        var cueText = clip["text"] as? String ?? ""
        if wordText != prior["text"] as? String {
            guard let range = wordRange(text: cueText, words: words, index: index) else {
                throw Failure("This word no longer matches the caption text. Correct the cue text before editing its words.")
            }
            cueText = (cueText as NSString).replacingCharacters(in: range, with: wordText)
        }
        next["text"] = wordText; next["t"] = start; next["end"] = end
        words[index] = next
        return ["op": "update", "id": id, "comp": composition as Any? ?? NSNull(), "set": ["text": cueText, "words": words]]
    }

    static func weight(clipID: String, value: Double, composition: String?) throws -> [String: Any] {
        guard !clipID.isEmpty, value.isFinite, (100...900).contains(value) else { throw Failure("Caption weight must be between 100 and 900.") }
        return ["op": "update", "id": clipID, "comp": composition as Any? ?? NSNull(), "set": ["style": ["weight": value]]]
    }

    private static func wordRange(text: String, words: [[String: Any]], index: Int) -> NSRange? {
        let count = text.utf16.count
        var cursor = 0
        let separator = #"[\t\n\u000B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+"#
        for offset in 0...index {
            let pieces = (words[offset]["text"] as? String ?? "").components(separatedBy: whitespace).filter { !$0.isEmpty }
            guard !pieces.isEmpty else { if offset == index { return nil }; continue }
            let pattern = pieces.map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: separator)
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: text, range: NSRange(location: cursor, length: count - cursor)) else {
                if offset == index { return nil }; continue
            }
            if offset == index { return match.range }
            cursor = NSMaxRange(match.range)
        }
        return nil
    }
}
// END CAPTION CUE WORD EDITING

@MainActor private struct NativeCaptionCueCapture {
    struct Identity: Hashable {
        let contextID: UUID
        let backendID: ObjectIdentifier
        let folder: String
        let composition: String?
        let version: Int
        let fps: Double
        let cueBytes: Data
        let trackBytes: Data
    }
    let contextID: UUID
    let backendID: ObjectIdentifier
    let folder: String
    let composition: String?
    let version: Int
    let fps: Double
    let cue: [String: Any]
    let cueBytes: Data
    let trackBytes: Data
    var identity: Identity { .init(contextID: contextID, backendID: backendID, folder: folder, composition: composition, version: version, fps: fps, cueBytes: cueBytes, trackBytes: trackBytes) }

    init?(model: NativeEditorModel, clip: NativeClip) {
        guard let project = model.project, model.projectReadOnlyReason == nil, model.version >= 0, model.fps.isFinite, model.fps > 0, clip.kind == "caption",
              model.selectedID == clip.id, model.selectedIDs == Set([clip.id]),
              let folder = model.folder?.standardizedFileURL.path, let backend = model.renderPreviewBackendID else { return nil }
        if let composition = model.composition {
            guard project.fields.dictionary("comps")[composition] is [String: Any] else { return nil }
        }
        guard let track = model.tracks.first(where: { $0.clips.contains(where: { $0.id == clip.id }) }), !track.locked,
              !clip.fields.flag("locked"), let current = track.clips.first(where: { $0.id == clip.id }),
              let bytes = NativeCaptionWordUpdate.canonical(clip.fields), bytes == NativeCaptionWordUpdate.canonical(current.fields) else { return nil }
        var trackMetadata = track.fields
        trackMetadata.removeValue(forKey: "clips")
        guard let trackBytes = NativeCaptionWordUpdate.canonical(trackMetadata) else { return nil }
        contextID = model.processingContextID; backendID = backend; self.folder = folder
        composition = model.composition; version = model.version; fps = model.fps; cue = clip.fields; cueBytes = bytes; self.trackBytes = trackBytes
    }

    func matches(_ model: NativeEditorModel) -> Bool {
        guard !model.busy, !model.showingSource, let current = Self(model: model, clip: NativeClip(fields: cue)) else { return false }
        return current.contextID == contextID && current.backendID == backendID && current.folder == folder &&
            current.composition == composition && current.version == version && current.fps == fps && current.cueBytes == cueBytes && current.trackBytes == trackBytes
    }
}

@MainActor private struct NativeCaptionCueControls: View {
    @ObservedObject var model: NativeEditorModel
    let clip: NativeClip
    let weight: Double
    private let capture: NativeCaptionCueCapture?
    @State private var expanded = false
    @State private var page = 0
    @State private var styleError: String?
    private let pageSize = 8

    init(model: NativeEditorModel, clip: NativeClip, weight: Double) {
        self.model = model; self.clip = clip; self.weight = weight
        capture = NativeCaptionCueCapture(model: model, clip: clip)
    }

    private var words: [[String: Any]] { clip.fields["words"] as? [[String: Any]] ?? [] }
    private var editable: Bool { capture?.matches(model) == true }
    private var currentPage: Int { min(page, max(0, (words.count - 1) / pageSize)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            NativeNumberRow("Weight", value: weight, range: 100...900, step: 100) { value in
                do {
                    let target = try admittedCapture()
                    let operation = try NativeCaptionWordUpdate.weight(clipID: clip.id, value: value, composition: target.composition)
                    submit(operation, target: target, summary: "Edited caption weight")
                    styleError = nil
                } catch { styleError = error.localizedDescription }
            }.id(capture?.identity).disabled(!editable)
            if let styleError { Text(styleError).font(.caption).foregroundStyle(NativeEditorStyle.error).fixedSize(horizontal: false, vertical: true) }
            if !editable {
                Text("Select one unlocked caption cue in the timeline to edit its weight or words.")
                    .font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            }
            if words.isEmpty {
                Text("This cue has no saved word timing. Create timed captions from Transcript to edit individual words.")
                    .font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            } else {
                DisclosureGroup(isExpanded: $expanded) {
                    if expanded {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Seconds are relative to this cue. Apply changes one word at a time. Source transcript timing stays unchanged.")
                                .font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
                            let lower = currentPage * pageSize, upper = min(words.count, lower + pageSize)
                            ForEach(lower..<upper, id: \.self) { index in
                                NativeCaptionWordRow(index: index, word: words[index], editable: editable, commit: applyWord, preview: previewWord)
                                    .id(capture?.identity)
                            }
                            if words.count > pageSize {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Words \(lower + 1) to \(upper) of \(words.count)").font(.caption).monospacedDigit()
                                    ViewThatFits(in: .horizontal) {
                                        HStack(spacing: 8) { pageActions }.fixedSize(horizontal: true, vertical: false)
                                        VStack(alignment: .leading, spacing: 6) { pageActions }
                                    }
                                }
                            }
                        }.padding(.vertical, 8)
                    }
                } label: {
                    Text("Word timing").font(.subheadline.weight(.medium)).frame(minHeight: NativeEditorStyle.minimumControlHeight)
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("editor.caption.cueWords")
    }

    private func admittedCapture() throws -> NativeCaptionCueCapture {
        guard let capture, capture.matches(model) else { throw NativeCaptionWordUpdate.Failure("The caption, selection or project changed. Select the cue again before editing.") }
        return capture
    }

    @ViewBuilder private var pageActions: some View {
        Button { page = currentPage - 1 } label: {
            Text("Previous words").frame(minHeight: NativeEditorStyle.minimumControlHeight).contentShape(Rectangle())
        }.disabled(currentPage == 0)
        Button { page = currentPage + 1 } label: {
            Text("Next words").frame(minHeight: NativeEditorStyle.minimumControlHeight).contentShape(Rectangle())
        }.disabled((currentPage + 1) * pageSize >= words.count)
    }

    private func applyWord(_ index: Int, _ patch: [String: Any]) throws {
        let target = try admittedCapture()
        let operation = try NativeCaptionWordUpdate.update(clip: target.cue, index: index, patch: patch, composition: target.composition, fps: target.fps)
        let fields = operation["set"] as? [String: Any] ?? [:]
        guard let words = fields["words"], let priorWords = target.cue["words"] else { throw NativeCaptionWordUpdate.Failure("The caption has no saved word timing.") }
        guard fields["text"] as? String != target.cue["text"] as? String ||
              NativeCaptionWordUpdate.canonical(words) != NativeCaptionWordUpdate.canonical(priorWords) else {
            throw NativeCaptionWordUpdate.Failure("This word already has those values.")
        }
        submit(operation, target: target, summary: "Edited caption word")
    }

    private func submit(_ operation: [String: Any], target: NativeCaptionCueCapture, summary: String) {
        model.perform {
            guard target.matches(model) else { throw NativeCaptionWordUpdate.Failure("The caption, selection or project changed before the edit started. Select the cue again.") }
            try await model.ops([operation], summary: summary, expectedVersion: target.version)
        }
    }

    private func previewWord(_ index: Int) throws {
        let target = try admittedCapture()
        guard let words = target.cue["words"] as? [[String: Any]], words.indices.contains(index),
              let start = NativeCaptionWordUpdate.number(words[index]["t"]), start >= -(1 / target.fps + 1e-6), start <= clip.duration else {
            throw NativeCaptionWordUpdate.Failure("This word has no usable cue timing to preview.")
        }
        model.seek(clip.start + max(0, start))
    }
}

@MainActor private struct NativeCaptionWordRow: View {
    let index: Int
    let word: [String: Any]
    let editable: Bool
    let commit: (Int, [String: Any]) throws -> Void
    let preview: (Int) throws -> Void
    @State private var text: String
    @State private var start: String
    @State private var end: String
    @State private var error: String?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(index: Int, word: [String: Any], editable: Bool, commit: @escaping (Int, [String: Any]) throws -> Void, preview: @escaping (Int) throws -> Void) {
        self.index = index; self.word = word; self.editable = editable; self.commit = commit; self.preview = preview
        _text = State(initialValue: word["text"] as? String ?? "")
        _start = State(initialValue: NativeCaptionWordUpdate.number(word["t"]).map { String($0) } ?? "")
        _end = State(initialValue: NativeCaptionWordUpdate.number(word["end"]).map { String($0) } ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Word \(index + 1)").font(.caption.weight(.semibold)).foregroundStyle(NativeEditorStyle.muted)
            TextField("Word \(index + 1)", text: $text, axis: .vertical)
                .textFieldStyle(.roundedBorder).frame(minHeight: NativeEditorStyle.minimumControlHeight)
                .accessibilityLabel("Caption word \(index + 1)").disabled(!editable)
            let timingLayout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout(spacing: 8))
            timingLayout {
                timingField("Start seconds", value: $start)
                timingField("End seconds", value: $end)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { wordActions }.fixedSize(horizontal: true, vertical: false)
                VStack(alignment: .leading, spacing: 6) { wordActions }
            }
            if let error { Text(error).font(.caption).foregroundStyle(NativeEditorStyle.error).fixedSize(horizontal: false, vertical: true) }
        }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
            .background(NativeEditorStyle.background, in: RoundedRectangle(cornerRadius: 6))
    }

    private func timingField(_ label: String, value: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption).foregroundStyle(NativeEditorStyle.muted).fixedSize(horizontal: false, vertical: true)
            TextField(label, text: value).textFieldStyle(.roundedBorder).monospacedDigit()
                .frame(minHeight: NativeEditorStyle.minimumControlHeight).accessibilityLabel("Caption word \(index + 1) \(label.lowercased())")
                .disabled(!editable)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var wordActions: some View {
        Button { apply() } label: {
            Text("Apply word").frame(minHeight: NativeEditorStyle.minimumControlHeight).contentShape(Rectangle())
        }.disabled(!editable)
            .accessibilityLabel("Apply caption word \(index + 1)")
        Button {
            do { try preview(index); error = nil } catch { self.error = error.localizedDescription }
        } label: {
            Text("Preview saved word").frame(minHeight: NativeEditorStyle.minimumControlHeight).contentShape(Rectangle())
        }.disabled(!editable)
            .accessibilityLabel("Preview saved caption word \(index + 1)")
    }

    private func apply() {
        guard let nextStart = Double(start.trimmingCharacters(in: NativeCaptionWordUpdate.whitespace)),
              let nextEnd = Double(end.trimmingCharacters(in: NativeCaptionWordUpdate.whitespace)), nextStart.isFinite, nextEnd.isFinite else {
            error = "Enter finite numbers for the word start and end."; return
        }
        var patch: [String: Any] = [:]
        if text != word["text"] as? String { patch["text"] = text }
        if nextStart != NativeCaptionWordUpdate.number(word["t"]) { patch["t"] = nextStart }
        if nextEnd != NativeCaptionWordUpdate.number(word["end"]) { patch["end"] = nextEnd }
        do {
            guard !patch.isEmpty else { throw NativeCaptionWordUpdate.Failure("Enter a change before applying this word.") }
            try commit(index, patch); error = nil
        } catch { self.error = error.localizedDescription }
    }
}
