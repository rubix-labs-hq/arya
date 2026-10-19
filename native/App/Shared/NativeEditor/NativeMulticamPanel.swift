import AVFoundation
import CryptoKit
import ReelKit
import SwiftUI

// BEGIN MULTICAM PLANNING
enum NativeMulticamPlanning {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
        init(_ message: String) { self.message = message }
    }
    static func number(_ fields: [String: Any], _ key: String, _ fallback: Double = 0) -> Double { (fields[key] as? NSNumber)?.doubleValue ?? fallback }
    static func data(_ fields: [String: Any]) throws -> Data {
        guard JSONSerialization.isValidJSONObject(fields) else { throw Failure("The project has invalid data.") }
        return try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    }
    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func linear(_ clip: [String: Any]) -> Bool {
        let start = number(clip, "start"), dur = number(clip, "dur"), input = number(clip, "in"), speed = number(clip, "speed", 1)
        return start.isFinite && start >= 0 && dur.isFinite && dur > 0 && start + dur < 1_000_000 && input.isFinite && input >= 0 &&
            speed.isFinite && speed > 0 && (input + dur * speed).isFinite && clip["reverse"] as? Bool != true && clip["freeze"] == nil && clip["timeMap"] == nil
    }
    static func index(_ value: Double, count: Int) -> Int? {
        value.isFinite && value.rounded() == value && value >= 0 && value < Double(count) ? Int(value) : nil
    }
    static func syncJobs(_ jobs: [[String: Any]]) -> [[String: Any]] {
        let relevant = jobs.filter { $0["kind"] as? String == "sync" && (($0["spec"] as? [String: Any])?["uiMulticamCapture"] as? [String: Any]) != nil }
        return Array(relevant.filter { ["queued", "running"].contains($0["state"] as? String ?? "") }.reversed()) +
            Array(relevant.filter { !["queued", "running"].contains($0["state"] as? String ?? "") }.suffix(20).reversed())
    }
    struct Sync {
        let offsets: [Double]
        let confidence: [Double]
        let sharpness: [Double]
        let warnings: [String]
        init(result: [String: Any], count: Int) throws {
            guard let offsets = result["offsets"] as? [NSNumber], offsets.count == count,
                  offsets.allSatisfy({ $0.doubleValue.isFinite && (0...600).contains($0.doubleValue) }),
                  let confidence = result["confidence"] as? [NSNumber], confidence.count == count,
                  confidence.allSatisfy({ $0.doubleValue.isFinite && (0...1.000001).contains($0.doubleValue) }),
                  let sharpness = result["sharpness"] as? [NSNumber], sharpness.count == count,
                  sharpness.allSatisfy({ $0.doubleValue.isFinite && (0...1.000001).contains($0.doubleValue) }) else { throw Failure("Sync returned invalid or incomplete offsets. Review the sources and run it again.") }
            self.offsets = offsets.map(\.doubleValue); self.confidence = confidence.map(\.doubleValue); self.sharpness = sharpness.map(\.doubleValue)
            warnings = Array((result["warnings"] as? [String] ?? []).prefix(20)).map { String($0.prefix(1200)) }
        }
    }
    struct Capture {
        let record: [String: Any]
        var sources: [String] { record["sources"] as? [String] ?? [] }
        var folder: String { record["folder"] as? String ?? "" }
        var context: String { record["context"] as? String ?? "" }
        var composition: String? { record["comp"] as? String }
        var version: Int { (record["version"] as? NSNumber)?.intValue ?? -1 }
        var target: String? { record["target"] as? String }
        var fps: Double { number(record, "fps", 30) }
        var assets: [String: Any] { record["assets"] as? [String: Any] ?? [:] }
        var scope: Any { composition as Any? ?? NSNull() }
        init(fields: [String: Any], folder: String, composition: String?, version: Int, context: String, selection: Set<String>, primary: String? = nil, sources: [String], target: String? = nil, files: [String: [String: String]]) throws {
            let project = try data(fields)
            guard project.count <= 8 * 1024 * 1024, !folder.isEmpty, UUID(uuidString: context) != nil, version >= 0,
                  (2...9).contains(sources.count), Set(sources).count == sources.count,
                  sources.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 2048 && files[$0]?.isEmpty == false }) else { throw Failure("Choose 2 to 9 different imported video sources in an open project.") }
            let canvas: [String: Any]
            if let composition {
                guard let found = (fields["comps"] as? [String: Any])?[composition] as? [String: Any] else { throw Failure("The composition was removed.") }
                canvas = found
            } else { canvas = fields }
            let fps = number(canvas, "fps", number(fields, "fps", 30)), tracks = canvas["tracks"] as? [[String: Any]] ?? []
            guard fps.isFinite, (1...240).contains(fps) else { throw Failure("The composition frame rate is invalid.") }
            var assets: [String: Any] = [:]
            for src in sources {
                guard let asset = (fields["assets"] as? [String: Any])?[src] as? [String: Any], asset["hasVideo"] as? Bool == true,
                      number(asset, "duration").isFinite, number(asset, "duration") >= 1 / fps else { throw Failure("Every angle needs an imported video source with a known duration.") }
                assets[src] = asset
            }
            let clips = tracks.flatMap { $0["clips"] as? [[String: Any]] ?? [] }
            if let target {
                guard let clip = clips.first(where: { $0["id"] as? String == target }), clip["kind"] as? String == "multicam", linear(clip),
                      let angles = clip["angles"] as? [[String: Any]], angles.compactMap({ $0["src"] as? String }) == sources else { throw Failure("Select a forward multicam clip with constant positive speed.") }
                try Self.validateAngles(angles, clip: clip, assets: assets, fps: fps)
                guard index(number(clip, "audioAngle"), count: sources.count) != nil else { throw Failure("The multicam audio angle is invalid.") }
                let cuts = clip["cuts"] as? [[String: Any]] ?? []
                guard !cuts.isEmpty, cuts.count <= 1000, cuts.allSatisfy({ number($0, "t").isFinite && number($0, "t") >= 0 && index(number($0, "angle"), count: sources.count) != nil }) else { throw Failure("The multicam cuts are invalid or exceed 1,000 entries.") }
                let link = clip["link"] as? String ?? ""
                for track in tracks {
                    for item in track["clips"] as? [[String: Any]] ?? [] where item["id"] as? String == target || (!link.isEmpty && item["link"] as? String == link) {
                        guard track["locked"] as? Bool != true, linear(item) else { throw Failure("Unlock every linked track and use forward clips before editing multicam.") }
                    }
                }
            } else {
                for track in tracks {
                    for clip in track["clips"] as? [[String: Any]] ?? [] where selection.contains(clip["id"] as? String ?? "") && sources.contains(clip["src"] as? String ?? "") {
                        guard track["locked"] as? Bool != true, linear(clip) else { throw Failure("The selected source clips must be unlocked with forward constant source mapping.") }
                    }
                }
            }
            let record: [String: Any] = ["folder": folder, "context": context, "comp": composition as Any? ?? NSNull(), "version": version, "selection": selection.sorted(), "primary": primary as Any? ?? NSNull(),
                      "sources": sources, "target": target as Any? ?? NSNull(), "assets": assets, "files": files, "project": digest(project), "fps": fps]
            try self.init(record: record)
        }
        init(record: [String: Any]) throws {
            let payload = try data(record)
            guard payload.count <= 262_144, let sources = record["sources"] as? [String], (2...9).contains(sources.count), Set(sources).count == sources.count,
                  let folder = record["folder"] as? String, !folder.isEmpty, let context = record["context"] as? String, UUID(uuidString: context) != nil,
                  record["comp"] is String || record["comp"] is NSNull, record["target"] is String || record["target"] is NSNull,
                  (record["primary"] is String || record["primary"] is NSNull), record["selection"] is [String], let version = record["version"] as? NSNumber, version.doubleValue.isFinite, version.doubleValue >= 0,
                  let project = record["project"] as? String, project.count == 64, record["assets"] is [String: Any], record["files"] is [String: [String: String]],
                  number(record, "fps").isFinite, (1...240).contains(number(record, "fps")) else { throw Failure("This sync job has no valid captured project. Run it again.") }
            self.record = record
        }
        func matches(fields: [String: Any], folder: String?, composition: String?, version: Int, context: String, selection: Set<String>, primary: String? = nil, files: [String: [String: String]]) -> Bool {
            guard self.folder == folder, self.composition == composition, self.version == version, self.context == context,
                  selectionMatches(selection, primary: primary), let project = try? data(fields), digest(project) == record["project"] as? String,
                  let expected = record["files"] as? [String: [String: String]], expected == files else { return false }
            return true
        }
        func selectionMatches(_ selection: Set<String>, primary: String?) -> Bool {
            (record["primary"] as? String) == primary && record["selection"] as? [String] == selection.sorted()
        }
        func commitBody(_ operations: [[String: Any]], summary: String, projectedFields: [String: Any]? = nil) throws -> [String: Any] {
            guard !operations.isEmpty, operations.count <= 64, operations.allSatisfy({ $0.keys.contains("comp") && ($0["comp"] as? String) == composition && (composition != nil || $0["comp"] is NSNull) }) else { throw Failure("The multicam batch has invalid or missing composition scope.") }
            if operations.contains(where: { $0["op"] as? String == "multicam_cut" }) {
                guard let projectedFields else { throw Failure("The multicam cut needs a shared-core preview before committing.") }
                let projectedClip = try clip(in: projectedFields), cuts = projectedClip["cuts"] as? [[String: Any]] ?? []
                guard projectedClip["kind"] as? String == "multicam", !cuts.isEmpty, cuts.count <= 1000 else {
                    throw Failure("This edit would exceed 1,000 angle cuts. Replace or remove an existing cut first.")
                }
            }
            let body: [String: Any] = ["ops": operations, "summary": summary, "who": "you", "returnProject": true, "expectedVersion": version]
            guard try data(body).count <= 1_048_576 else { throw Failure("The multicam edit exceeds the bounded request size.") }
            return body
        }
        func syncRequest() throws -> [String: Any] {
            guard sources.allSatisfy({ (assets[$0] as? [String: Any])?["hasAudio"] as? Bool == true }) else { throw Failure("Audio sync needs an audio track in every angle. Use reviewed manual offsets for sources without audio.") }
            return ["srcs": sources, "rate": 8000, "window": 30, "maxSeconds": 120, "wait": false, "comp": scope, "expectedVersion": version, "uiMulticamCapture": record]
        }
        func creation(fields: [String: Any], offsets: [Double], at: Double, audioAngle: Int?) throws -> [[String: Any]] {
            guard target == nil, offsets.count == sources.count, offsets.allSatisfy({ $0.isFinite && (0...600).contains($0) }), at.isFinite, at >= 0, at < 1_000_000 else { throw Failure("Use finite nonnegative offsets and a valid playhead position.") }
            let canvas = composition.flatMap { (fields["comps"] as? [String: Any])?[$0] as? [String: Any] } ?? fields
            let tracks = canvas["tracks"] as? [[String: Any]] ?? []
            let overlap = zip(sources, offsets).map { number(assets[$0.0] as? [String: Any] ?? [:], "duration") - $0.1 }.min() ?? 0
            let duration = floor(overlap * fps + 0.000001) / fps, start = (at * fps).rounded() / fps
            guard duration >= 1 / fps, start + duration < 1_000_000 else { throw Failure("The angles have no complete overlapping frame after these offsets.") }
            if let audioAngle {
                guard sources.indices.contains(audioAngle), (assets[sources[audioAngle]] as? [String: Any])?["hasAudio"] as? Bool == true else { throw Failure("Choose an angle with audio, or create without a linked audio track.") }
            }
            func free(_ kind: String) -> String? {
                tracks.first { track in
                    track["kind"] as? String == kind && track["locked"] as? Bool != true && !(track["clips"] as? [[String: Any]] ?? []).contains { number($0, "start") < start + duration && number($0, "start") + number($0, "dur") > start }
                }?["id"] as? String
            }
            func newID(_ kind: String) -> String {
                let prefix = kind == "audio" ? "A" : "V", ids = Set(tracks.compactMap { $0["id"] as? String })
                var index = 1; while ids.contains("\(prefix)\(index)") { index += 1 }
                return "\(prefix)\(index)"
            }
            var ops: [[String: Any]] = []
            let video = free("video") ?? newID("video")
            if free("video") == nil { ops.append(["op": "add_track", "kind": "video", "comp": scope]) }
            ops.append(["op": "make_multicam", "srcs": sources, "offsets": offsets, "labels": sources.map { ($0 as NSString).lastPathComponent }, "track": video,
                        "start": start, "dur": duration, "audioAngle": audioAngle ?? 0, "name": "Multicam", "comp": scope])
            if let audioAngle {
                let audio = free("audio") ?? newID("audio")
                if free("audio") == nil { ops.append(["op": "add_track", "kind": "audio", "comp": scope]) }
                ops.append(["op": "add_clip", "kind": "audio", "src": sources[audioAngle], "track": audio, "start": start, "in": offsets[audioAngle], "dur": duration, "comp": scope])
            }
            return ops
        }
        func finishCreation(_ ops: [[String: Any]], created: [String], withAudio: Bool) throws -> [[String: Any]] {
            let ids = created.filter { $0.hasPrefix("c") }
            guard ids.count == (withAudio ? 2 : 1), Set(ids).count == ids.count else { throw Failure("The shared core returned unexpected created clips.") }
            if withAudio { return ops + [["op": "update", "id": ids[0], "set": ["mute": true], "comp": scope], ["op": "link", "ids": ids, "comp": scope]] }
            return ops + [["op": "update", "id": ids[0], "set": ["mute": true], "comp": scope]]
        }
        static func validateAngles(_ angles: [[String: Any]], clip: [String: Any], assets: [String: Any], fps: Double) throws {
            let input = number(clip, "in"), duration = number(clip, "dur") * number(clip, "speed", 1)
            guard (2...9).contains(angles.count) else { throw Failure("Multicam editing supports 2 to 9 angles.") }
            for angle in angles {
                let offset = number(angle, "offset"), source = angle["src"] as? String ?? "", length = number(assets[source] as? [String: Any] ?? [:], "duration")
                guard offset.isFinite, abs(offset) <= 600, input + offset >= -0.000001, input + offset + duration <= length + 0.000001,
                      duration >= 1 / fps else { throw Failure("An angle does not cover the complete multicam source window. Trim or correct its offset first.") }
            }
        }
        func clip(in fields: [String: Any]) throws -> [String: Any] {
            let canvas = composition.flatMap { (fields["comps"] as? [String: Any])?[$0] as? [String: Any] } ?? fields
            guard let target, let clip = (canvas["tracks"] as? [[String: Any]] ?? []).flatMap({ $0["clips"] as? [[String: Any]] ?? [] }).first(where: { $0["id"] as? String == target }) else { throw Failure("The multicam clip was removed.") }
            return clip
        }
        func cut(fields: [String: Any], at: Double, angle: Int) throws -> [[String: Any]] {
            let clip = try clip(in: fields), start = number(clip, "start"), duration = number(clip, "dur"), speed = number(clip, "speed", 1)
            guard at.isFinite, at >= start, at < start + duration, sources.indices.contains(angle), linear(clip) else { throw Failure("Place the playhead inside this forward multicam clip and choose an angle.") }
            return [["op": "multicam_cut", "id": clip["id"] as? String ?? "", "local": true, "at": (at - start) * speed, "angle": angle, "comp": scope]]
        }
        func angles(fields: [String: Any], offsets: [Double]) throws -> [[String: Any]] {
            let clip = try clip(in: fields)
            var angles = clip["angles"] as? [[String: Any]] ?? []
            guard offsets.count == angles.count else { throw Failure("Each angle needs an offset.") }
            for index in angles.indices { angles[index]["offset"] = offsets[index] }
            try Self.validateAngles(angles, clip: clip, assets: assets, fps: fps)
            var ops: [[String: Any]] = [["op": "update", "id": clip["id"] as? String ?? "", "set": ["angles": angles], "comp": scope]]
            guard let audioAngle = index(number(clip, "audioAngle"), count: angles.count) else { throw Failure("The audio angle is invalid.") }
            if let partner = try audioPartner(fields: fields, clip: clip) {
                guard angles.indices.contains(audioAngle) else { throw Failure("The audio angle is invalid.") }
                let input = number(clip, "in") + number(angles[audioAngle], "offset")
                ops.append(["op": "update", "id": partner["id"] as? String ?? "", "set": ["src": sources[audioAngle], "in": input], "comp": scope])
            }
            return ops
        }
        func audio(fields: [String: Any], angle: Int) throws -> [[String: Any]] {
            let clip = try clip(in: fields), angles = clip["angles"] as? [[String: Any]] ?? []
            guard sources.indices.contains(angle), (assets[sources[angle]] as? [String: Any])?["hasAudio"] as? Bool == true else { throw Failure("Choose an angle with an audio track.") }
            var ops: [[String: Any]] = [["op": "update", "id": clip["id"] as? String ?? "", "set": ["audioAngle": angle], "comp": scope]]
            if let partner = try audioPartner(fields: fields, clip: clip) {
                ops.append(["op": "update", "id": partner["id"] as? String ?? "", "set": ["src": sources[angle], "in": number(clip, "in") + number(angles[angle], "offset")], "comp": scope])
            } else { ops[0]["set"] = ["audioAngle": angle, "mute": false] }
            return ops
        }
        private func audioPartner(fields: [String: Any], clip: [String: Any]) throws -> [String: Any]? {
            let link = clip["link"] as? String ?? ""
            if link.isEmpty { return nil }
            let canvas = composition.flatMap { (fields["comps"] as? [String: Any])?[$0] as? [String: Any] } ?? fields
            let partners = (canvas["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }.filter { $0["id"] as? String != target && $0["link"] as? String == link && $0["kind"] as? String == "audio" }
            guard partners.count <= 1 else { throw Failure("This multicam has multiple linked audio clips. Resolve them before changing the audio angle.") }
            if let partner = partners.first {
                guard abs(number(partner, "start") - number(clip, "start")) < 0.00001, abs(number(partner, "dur") - number(clip, "dur")) < 0.00001,
                      abs(number(partner, "speed", 1) - number(clip, "speed", 1)) < 0.00001 else { throw Failure("Align linked audio timing and speed before changing its angle or offsets.") }
            }
            return partners.first
        }
        func removeCut(fields: [String: Any], index: Int) throws -> [[String: Any]] {
            let clip = try clip(in: fields), cuts = clip["cuts"] as? [[String: Any]] ?? []
            guard index > 0, cuts.indices.contains(index), cuts.count <= 1000 else { throw Failure("The initial angle cut must remain. Select a later cut to remove.") }
            let remaining = cuts.enumerated().filter { $0.offset != index }.map(\.element)
            let reduced = remaining.enumerated().filter { $0.offset == 0 || number($0.element, "angle") != number(remaining[$0.offset - 1], "angle") }.map(\.element)
            return [["op": "update", "id": clip["id"] as? String ?? "", "set": ["cuts": reduced], "comp": scope]]
        }
    }
    static func angleTime(clip: [String: Any], angle: [String: Any], asset: [String: Any], at: Double) -> Double? {
        let start = number(clip, "start"), duration = number(clip, "dur"), local = number(clip, "in") + (at - start) * number(clip, "speed", 1) + number(angle, "offset")
        guard linear(clip), at.isFinite, at >= start, at < start + duration, local.isFinite, local >= 0, local < number(asset, "duration") else { return nil }
        return local
    }
    static func activeAngle(clip: [String: Any], at: Double) -> Int? {
        let local = number(clip, "in") + (at - number(clip, "start")) * number(clip, "speed", 1)
        guard at.isFinite, at >= number(clip, "start"), at < number(clip, "start") + number(clip, "dur"), linear(clip) else { return nil }
        var angle = 0
        for cut in clip["cuts"] as? [[String: Any]] ?? [] where number(cut, "t") <= local + 0.000001 {
            guard let next = index(number(cut, "angle"), count: (clip["angles"] as? [[String: Any]] ?? []).count) else { return nil }; angle = next
        }
        return angle
    }
}
// END MULTICAM PLANNING

@MainActor private func NativeMulticamFiles(model: NativeEditorModel, sources: [String]) throws -> [String: [String: String]] {
    var files: [String: [String: String]] = [:]
    for src in sources {
        let identity = try NativeSourceFileIdentity(file: model.mediaURL(src))
        files[src] = ["path": identity.path, "device": String(identity.device), "inode": String(identity.inode), "size": String(identity.size), "seconds": String(identity.seconds), "nanoseconds": String(identity.nanoseconds)]
    }
    return files
}

private extension NativeMulticamPlanning.Capture {
    @MainActor init(model: NativeEditorModel, sources: [String], target: String? = nil) throws {
        guard let fields = model.project?.fields, let folder = model.folder else { throw NativeMulticamPlanning.Failure("Open a project first.") }
        guard target == nil || model.selectedID == target else { throw NativeMulticamPlanning.Failure("Select this multicam clip again before editing it.") }
        try self.init(fields: fields, folder: folder.path, composition: model.composition, version: model.version, context: model.processingContextID.uuidString,
                      selection: model.selectedIDs, primary: model.selectedID, sources: sources, target: target, files: NativeMulticamFiles(model: model, sources: sources))
    }
    @MainActor func matches(_ model: NativeEditorModel) -> Bool {
        guard let fields = model.project?.fields, let files = try? NativeMulticamFiles(model: model, sources: sources) else { return false }
        return matches(fields: fields, folder: model.folder?.path, composition: model.composition, version: model.version, context: model.processingContextID.uuidString, selection: model.selectedIDs, primary: model.selectedID, files: files)
    }
}

@MainActor private func NativeMulticamCommit(model: NativeEditorModel, capture: NativeMulticamPlanning.Capture, operations: [[String: Any]], summary: String, completed: (() -> Void)? = nil) throws {
    let projected: [String: Any]?
    if operations.contains(where: { $0["op"] as? String == "multicam_cut" }) {
        guard let fields = model.project?.fields, capture.matches(model) else { throw NativeMulticamPlanning.Failure("The captured project or sources changed before planning the cut.") }
        projected = try NativeMulticamCore.projected(fields: fields, operations: operations)
    } else { projected = nil }
    let body = try capture.commitBody(operations, summary: summary, projectedFields: projected)
    model.perform {
        guard capture.matches(model) else { throw NativeMulticamPlanning.Failure("The captured project, selection or source changed before the multicam edit started.") }
        _ = try await model.call("/api/ops", body)
        guard capture.context == model.processingContextID.uuidString, capture.folder == model.folder?.path,
              capture.composition == model.composition, model.version == capture.version + 1,
              capture.selectionMatches(model.selectedIDs, primary: model.selectedID) else { return }
        completed?()
    }
}

@MainActor private enum NativeMulticamCore {
    private static var core: ReelCore?
    private static func apply(fields: [String: Any], operations: [[String: Any]]) throws -> ReelCore.OpsResult {
        if core == nil {
            guard let editor = Bundle.main.url(forResource: "editor", withExtension: nil) else { throw NativeMulticamPlanning.Failure("The bundled project core is unavailable.") }
            core = try ReelCore(scriptURL: editor.appendingPathComponent("reel-core.js"))
        }
        let project = try NativeMulticamPlanning.data(fields), ops = try JSONSerialization.data(withJSONObject: operations, options: [.sortedKeys])
        guard let core else { throw NativeMulticamPlanning.Failure("The bundled project core is unavailable.") }
        return try core.applyOps(project: String(decoding: project, as: UTF8.self), ops: String(decoding: ops, as: UTF8.self))
    }
    static func projected(fields: [String: Any], operations: [[String: Any]]) throws -> [String: Any] {
        let result = try apply(fields: fields, operations: operations)
        guard let fields = try JSONSerialization.jsonObject(with: Data(result.project.utf8)) as? [String: Any] else { throw NativeMulticamPlanning.Failure("The shared core returned an invalid project.") }
        return fields
    }
    static func created(fields: [String: Any], operations: [[String: Any]]) throws -> [String] {
        let result = try apply(fields: fields, operations: operations)
        guard let created = try JSONSerialization.jsonObject(with: Data(result.created.utf8)) as? [String] else { throw NativeMulticamPlanning.Failure("The shared core returned invalid created IDs.") }
        return created
    }
}

struct NativeMulticamPanel: View {
    @ObservedObject var model: NativeEditorModel
    @Environment(\.dismiss) private var dismiss
    @State private var picked: [String] = []
    @State private var pickerContext: UUID?
    @State private var pickerComposition: String?
    @State private var offsets: [Double] = []
    @State private var withAudio = true
    @State private var audioAngle = 0
    @State private var syncCapture: NativeMulticamPlanning.Capture?
    @State private var chosenJob: String?
    @State private var usingInspectedSync = false
    @State private var starting = false
    @State private var error = ""
    private var assets: [NativeAsset] { Array((model.project?.assets ?? []).filter { $0.fields.flag("hasVideo") && $0.duration.isFinite && $0.duration > 0 }.prefix(1000)) }
    private var syncJobs: [[String: Any]] { NativeMulticamPlanning.syncJobs(model.jobs) }
    private var job: [String: Any] { model.jobs.first { $0.string("id") == chosenJob } ?? [:] }
    private var sync: NativeMulticamPlanning.Sync? { try? .init(result: job.dictionary("result"), count: picked.count) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("Create multicam").font(.headline); Spacer(); Button("Close") { dismiss() } }
            Text("\(model.project?.name ?? "No project") · \(model.composition ?? "Main timeline")").font(.caption).foregroundStyle(.secondary)
            Text("Choose 2 to 9 imported video sources in angle order. Creation uses the whole sources at the playhead and preserves existing clips.").font(.caption).foregroundStyle(.secondary)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(assets) { asset in
                        Button { toggle(asset.id) } label: {
                            HStack { Image(systemName: picked.contains(asset.id) ? "checkmark.circle.fill" : "circle"); Text(asset.name).lineLimit(1); Spacer(); Text(picked.firstIndex(of: asset.id).map { "Angle \($0 + 1)" } ?? "").font(.caption) }
                        }.buttonStyle(NativeToolbarButtonStyle(selected: picked.contains(asset.id)))
                    }
                    if picked.count >= 2 {
                        Toggle("Create a linked audio track", isOn: $withAudio)
                        if withAudio { Picker("Audio angle", selection: $audioAngle) { ForEach(Array(picked.enumerated()), id: \.offset) { index, source in Text("\(index + 1) · \((source as NSString).lastPathComponent)").tag(index) } } }
                        Text("Offset adds seconds to each angle's source time. Manual offsets must be nonnegative.").font(.caption2).foregroundStyle(.secondary)
                        ForEach(Array(picked.enumerated()), id: \.offset) { index, source in
                            NativeNumberRow("\(index + 1) · \((source as NSString).lastPathComponent)", value: offsets.indices.contains(index) ? offsets[index] : 0, range: 0...600, showsSlider: false) { value in
                                if offsets.indices.contains(index) { offsets[index] = value; syncCapture = nil; chosenJob = nil; usingInspectedSync = false }
                            }
                        }
                    }
                    if let sync {
                        Text("Sync suggestions. Review the confidence, warnings and offsets before using them.").font(.caption.weight(.semibold))
                        ForEach(Array(sync.offsets.enumerated()), id: \.offset) { index, offset in
                            Text(String(format: "Angle %d · %.3f s · match %.0f%% · peak separation %.0f%%", index + 1, offset, sync.confidence[index] * 100, sync.sharpness[index] * 100)).font(.caption2).monospacedDigit()
                        }
                        ForEach(Array(sync.warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.caption2).foregroundStyle(.secondary) }
                        Button("Use inspected offsets") { useSync() }.disabled(syncCapture?.matches(model) != true || syncCapture?.sources != picked)
                    }
                    if chosenJob != nil { Button("Use manual offsets instead") { chosenJob = nil; syncCapture = nil; usingInspectedSync = false } }
                    if !job.isEmpty { Text(NativeInspectorWorkflow.jobStatus(job)).font(.caption); if ["running", "queued"].contains(job.string("state")) { ProgressView("Syncing audio"); Button("Cancel sync") { cancel(job) } }; if !job.string("error").isEmpty { Text(job.string("error")).font(.caption2) } }
                    if !syncJobs.isEmpty {
                        Text("Saved sync jobs").font(.caption.weight(.semibold))
                        ForEach(syncJobs, id: \.multicamJobID) { job in Button("\(NativeInspectorWorkflow.jobStatus(job)) · \(job.string("id").prefix(8))") { inspect(job) } }
                    }
                }
            }
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
            HStack {
                Button(starting ? "Starting sync" : "Sync by audio", action: startSync).disabled(starting || picked.count < 2 || !model.capabilities.dictionary("processing").flag("multicamSync"))
                Spacer()
                Button("Create multicam", action: create).disabled(starting || picked.count < 2 || (chosenJob != nil && !usingInspectedSync))
            }.buttonStyle(NativeToolbarButtonStyle())
        }.padding(16).frame(minWidth: 340, idealWidth: 650, minHeight: 480, idealHeight: 700).background(NativeEditorStyle.background)
        .onChange(of: model.processingContextID) { _, _ in reset() }
        .onChange(of: model.composition) { _, _ in reset() }
        .onAppear {
            pickerContext = model.processingContextID; pickerComposition = model.composition
            let selected = model.tracks.flatMap(\.clips).filter { model.selectedIDs.contains($0.id) && $0.kind == "video" }.map(\.source)
            picked = Array(NSOrderedSet(array: selected)).compactMap { $0 as? String }.prefix(9).map { $0 }; offsets = [Double](repeating: 0, count: picked.count)
        }
    }
    private func reset() {
        pickerContext = model.processingContextID; pickerComposition = model.composition
        picked = []; offsets = []; chosenJob = nil; syncCapture = nil; usingInspectedSync = false; audioAngle = 0
        error = "The project scope changed. Choose sources again before creating multicam."
    }
    private func toggle(_ source: String) {
        if let index = picked.firstIndex(of: source) { picked.remove(at: index); offsets.remove(at: index) }
        else if picked.count < 9 { picked.append(source); offsets.append(0) }
        audioAngle = min(audioAngle, max(0, picked.count - 1)); syncCapture = nil; chosenJob = nil; usingInspectedSync = false
    }
    private func startSync() {
        do {
            guard pickerContext == model.processingContextID, pickerComposition == model.composition else { throw NativeMulticamPlanning.Failure("The project scope changed. Choose the sources again.") }
            let capture = try NativeMulticamPlanning.Capture(model: model, sources: picked), body = try capture.syncRequest()
            starting = true; error = ""; usingInspectedSync = false
            model.perform {
                defer { starting = false }
                guard capture.matches(model) else { throw NativeMulticamPlanning.Failure("The project, selection or source changed before sync started.") }
                let response = try await model.call("/api/multicam/sync", body)
                guard capture.context == model.processingContextID.uuidString, capture.folder == model.folder?.path, capture.sources == picked else { return }
                chosenJob = response.string("id"); syncCapture = capture
            }
        } catch { self.error = error.localizedDescription }
    }
    private func inspect(_ job: [String: Any]) {
        do {
            let capture = try NativeMulticamPlanning.Capture(record: job.dictionary("spec").dictionary("uiMulticamCapture"))
            picked = capture.sources; offsets = [Double](repeating: 0, count: picked.count); chosenJob = job.string("id"); syncCapture = capture; usingInspectedSync = false; error = ""
            if !capture.matches(model) { error = "This captured project or source changed. Results are read-only; run sync again before creating." }
            if job.string("state") == "done" { _ = try NativeMulticamPlanning.Sync(result: job.dictionary("result"), count: picked.count) }
        } catch { self.error = error.localizedDescription }
    }
    private func useSync() {
        guard let capture = syncCapture, capture.matches(model), capture.sources == picked, let sync else { error = "The captured sync target changed. Run sync again."; return }
        offsets = sync.offsets; usingInspectedSync = true
    }
    private func cancel(_ job: [String: Any]) {
        let id = job.string("id"), context = model.processingContextID
        model.perform { guard context == model.processingContextID else { return }; _ = try await model.call("/api/jobs/cancel", ["id": id]) }
    }
    private func create() {
        do {
            guard pickerContext == model.processingContextID, pickerComposition == model.composition else { throw NativeMulticamPlanning.Failure("The project scope changed. Choose the sources again.") }
            if chosenJob != nil { guard usingInspectedSync, job.string("state") == "done", syncCapture?.matches(model) == true else { throw NativeMulticamPlanning.Failure("The captured sync project changed. Run sync again or choose sources and manual offsets afresh.") } }
            let capture = try NativeMulticamPlanning.Capture(model: model, sources: picked)
            guard let fields = model.project?.fields else { return }
            let base = try capture.creation(fields: fields, offsets: offsets, at: model.time, audioAngle: withAudio ? audioAngle : nil)
            let created = try NativeMulticamCore.created(fields: fields, operations: base), ops = try capture.finishCreation(base, created: created, withAudio: withAudio)
            guard capture.matches(model) else { throw NativeMulticamPlanning.Failure("The project or source changed before creation.") }
            let primary = created.first { $0.hasPrefix("c") }
            try NativeMulticamCommit(model: model, capture: capture, operations: ops, summary: "Create multicam from \(picked.count) angles") {
                if let primary { model.select(id: primary) }; dismiss()
            }
        } catch { self.error = error.localizedDescription }
    }
}

private extension Dictionary where Key == String, Value == Any { var multicamJobID: String { string("id") } }

struct NativeMulticamControls: View {
    @ObservedObject var model: NativeEditorModel
    let clip: NativeClip
    @State private var starting = false
    @State private var syncID: String?
    @State private var offsetCapture: NativeMulticamPlanning.Capture?
    @State private var syncCapture: NativeMulticamPlanning.Capture?
    @State private var error = ""
    private var angles: [[String: Any]] { clip.fields.objects("angles") }
    private var sources: [String] { angles.map { $0.string("src") } }
    private var hasLinkedAudio: Bool { !clip.fields.string("link").isEmpty && model.tracks.flatMap(\.clips).contains { $0.kind == "audio" && $0.fields.string("link") == clip.fields.string("link") } }
    private var job: [String: Any] { model.jobs.first { $0.string("id") == syncID } ?? [:] }
    var body: some View {
        GroupBox("Multicam") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Click an angle to cut at the playhead. Option 1–9 selects an angle. Cuts commit immediately and pause playback. Frame previews sample playback at most twice a second.").font(.caption2).foregroundStyle(.secondary)
                if angles.count > 9 { Text("Native multicam controls support up to 9 angles. Open this larger clip in the browser editor.").font(.caption2).foregroundStyle(.secondary) }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 115))], spacing: 6) {
                    ForEach(Array(angles.prefix(9).enumerated()), id: \.offset) { index, angle in
                        Button { action { try $0.cut(fields: $1, at: model.time, angle: index) } } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                NativeMulticamAnglePreview(model: model, clip: clip, angle: angle)
                                Text("\(index + 1) · \(angle.string("label", "Angle \(index + 1)"))").font(.caption2).lineLimit(1)
                                Text(String(format: "Offset %.3f s", angle.number("offset"))).font(.caption2).foregroundStyle(.secondary)
                            }.padding(5).overlay { RoundedRectangle(cornerRadius: 5).stroke(NativeMulticamPlanning.activeAngle(clip: clip.fields, at: model.time) == index ? NativeEditorStyle.accent : NativeEditorStyle.line, lineWidth: 2) }
                        }.buttonStyle(.plain).keyboardShortcut(KeyEquivalent(Array("123456789")[index]), modifiers: [.option])
                    }
                }
                Picker("Audio angle", selection: Binding(get: { NativeMulticamPlanning.index(clip.fields.number("audioAngle"), count: angles.count) ?? 0 }, set: { index in action { try $0.audio(fields: $1, angle: index) } })) {
                    ForEach(Array(angles.prefix(9).enumerated()), id: \.offset) { index, angle in Text("\(index + 1) · \(angle.string("label", "Angle \(index + 1)"))").tag(index) }
                }
                Text(hasLinkedAudio ? "A linked audio track carries the selected angle." : clip.fields.flag("mute") ? "This multicam clip is muted." : "This clip plays the selected audio angle directly.").font(.caption2).foregroundStyle(.secondary)
                if !hasLinkedAudio, clip.fields.flag("mute") { Button("Enable selected audio angle") { action { try $0.audio(fields: $1, angle: NativeMulticamPlanning.index(clip.fields.number("audioAngle"), count: angles.count) ?? 0) } } }
                ForEach(Array(angles.prefix(9).enumerated()), id: \.offset) { index, angle in
                    NativeNumberRow("Angle \(index + 1) offset", value: angle.number("offset"), range: -600...600, showsSlider: false,
                                    onEditingBegan: { if offsetCapture == nil { offsetCapture = try? .init(model: model, sources: sources, target: clip.id) } }, onEditingEnded: { offsetCapture = nil }) { value in
                        guard let capture = offsetCapture, capture.matches(model) else { error = "The project or sources changed during the offset edit. Try again."; return }
                        var offsets = angles.map { $0.number("offset") }; offsets[index] = value
                        action { try $0.angles(fields: $1, offsets: offsets) }
                    }
                }
                Button(starting ? "Starting sync" : "Analyze audio sync", action: startSync).disabled(starting || !model.capabilities.dictionary("processing").flag("multicamSync"))
                if !job.isEmpty {
                    Text(NativeInspectorWorkflow.jobStatus(job)).font(.caption)
                    if syncCapture?.matches(model) != true { Text("This sync result is read-only because its captured project, selection or source changed.").font(.caption2).foregroundStyle(.secondary) }
                    if let sync = try? NativeMulticamPlanning.Sync(result: job.dictionary("result"), count: sources.count) {
                        ForEach(Array(sync.offsets.enumerated()), id: \.offset) { index, offset in Text(String(format: "Angle %d · %.3f s · match %.0f%% · separation %.0f%%", index + 1, offset, sync.confidence[index] * 100, sync.sharpness[index] * 100)).font(.caption2) }
                        ForEach(Array(sync.warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.caption2).foregroundStyle(.secondary) }
                        Button("Apply inspected sync offsets") { applySync() }.disabled(syncCapture?.matches(model) != true)
                    } else if ["running", "queued"].contains(job.string("state")) { ProgressView("Syncing audio"); Button("Cancel sync") { cancel() } }
                    else if job.string("state") == "done" { Text("Sync returned no valid offsets. Run it again.").font(.caption2).foregroundStyle(.secondary) }
                    if !job.string("error").isEmpty { Text(job.string("error")).font(.caption2) }
                }
                Text("Angle cuts").font(.caption.weight(.semibold))
                ForEach(Array(clip.fields.objects("cuts").prefix(1000).enumerated()), id: \.offset) { index, cut in
                    let at = clip.start + (cut.number("t") - clip.fields.number("in")) / clip.fields.number("speed", 1)
                    HStack {
                        Button(String(format: "%.3f s", at)) { model.showingSource = false; model.seek(at) }.disabled(!at.isFinite || at < clip.start || at >= clip.end)
                        Text("Angle \((NativeMulticamPlanning.index(cut.number("angle"), count: angles.count) ?? 0) + 1)").font(.caption2)
                        Spacer()
                        if index > 0 { Button("Remove") { action { try $0.removeCut(fields: $1, index: index) } } }
                    }
                }
                if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
            }.padding(4)
        }
        .onAppear {
            if let job = model.jobs.reversed().first(where: { $0.string("kind") == "sync" && $0.dictionary("spec").dictionary("uiMulticamCapture").string("target") == clip.id && ($0.dictionary("spec").dictionary("uiMulticamCapture")["comp"] as? String) == model.composition }) {
                syncID = job.string("id"); syncCapture = try? .init(record: job.dictionary("spec").dictionary("uiMulticamCapture"))
            }
        }
    }
    private func action(_ plan: (NativeMulticamPlanning.Capture, [String: Any]) throws -> [[String: Any]]) {
        do {
            let capture = try NativeMulticamPlanning.Capture(model: model, sources: sources, target: clip.id)
            guard let fields = model.project?.fields else { return }
            let ops = try plan(capture, fields)
            guard capture.matches(model) else { throw NativeMulticamPlanning.Failure("The project or sources changed before the edit.") }
            try NativeMulticamCommit(model: model, capture: capture, operations: ops, summary: "Edit multicam \(clip.id)"); error = ""
        } catch { self.error = error.localizedDescription }
    }
    private func startSync() {
        do {
            let capture = try NativeMulticamPlanning.Capture(model: model, sources: sources, target: clip.id), body = try capture.syncRequest()
            starting = true
            model.perform {
                defer { starting = false }
                guard capture.matches(model) else { throw NativeMulticamPlanning.Failure("The project or sources changed before sync started.") }
                let response = try await model.call("/api/multicam/sync", body)
                guard capture.context == model.processingContextID.uuidString, capture.folder == model.folder?.path else { return }
                syncID = response.string("id"); syncCapture = capture
            }
        } catch { self.error = error.localizedDescription }
    }
    private func applySync() {
        do {
            guard let capture = syncCapture, capture.matches(model), let fields = model.project?.fields else { throw NativeMulticamPlanning.Failure("The captured project or sources changed. Run sync again.") }
            let sync = try NativeMulticamPlanning.Sync(result: job.dictionary("result"), count: sources.count)
            let ops = try capture.angles(fields: fields, offsets: sync.offsets)
            try NativeMulticamCommit(model: model, capture: capture, operations: ops, summary: "Apply inspected multicam sync")
        } catch { self.error = error.localizedDescription }
    }
    private func cancel() {
        let id = syncID, context = model.processingContextID
        model.perform { guard context == model.processingContextID, let id else { return }; _ = try await model.call("/api/jobs/cancel", ["id": id]) }
    }
}

private struct NativeMulticamAnglePreview: View {
    @ObservedObject var model: NativeEditorModel
    let clip: NativeClip
    let angle: [String: Any]
    @State private var image: CGImage?
    @State private var message = ""
    private var sample: Double { model.playing && model.time >= clip.start && model.time < clip.end ? max(clip.start, floor(model.time * 2) / 2) : model.time }
    private var key: String { "\(model.processingContextID)|\(model.folder?.path ?? "")|\(model.composition ?? "main")|\(model.version)|\(clip.id)|\(angle.string("src"))|\(angle.number("offset"))|\(sample)" }
    var body: some View {
        ZStack {
            Color.black
            if let image { Image(decorative: image, scale: 1).resizable().scaledToFit() }
            if !message.isEmpty { Text(message).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(4) }
        }.aspectRatio(16.0 / 9, contentMode: .fit).clipped().task(id: key) { await load() }
    }
    private func load() async {
        image = nil; message = ""
        do {
            let context = model.processingContextID, folder = model.folder, composition = model.composition, version = model.version
            let clipState = try NativeMulticamPlanning.data(clip.fields)
            guard clipState.count <= 262_144, let asset = model.project?.assets.first(where: { $0.id == angle.string("src") }),
                  let time = NativeMulticamPlanning.angleTime(clip: clip.fields, angle: angle, asset: asset.fields, at: sample) else { message = "Outside angle range"; return }
            let url = try model.mediaURL(asset.id), identity = try NativeSourceFileIdentity(file: url), assetState = try NativeMulticamPlanning.data(asset.fields)
            guard assetState.count <= 262_144 else { throw NativeMulticamPlanning.Failure("The source metadata exceeds preview limits.") }
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true; generator.maximumSize = CGSize(width: 640, height: 360)
            generator.requestedTimeToleranceBefore = CMTime(seconds: 0.05, preferredTimescale: 60000); generator.requestedTimeToleranceAfter = generator.requestedTimeToleranceBefore
            let result = try await withTaskCancellationHandler {
                try await generator.image(at: CMTime(seconds: time, preferredTimescale: 60000)).image
            } onCancel: { generator.cancelAllCGImageGeneration() }
            guard !Task.isCancelled, context == model.processingContextID, folder == model.folder, composition == model.composition, version == model.version,
                  model.selectedID == clip.id, let current = model.selected, try NativeMulticamPlanning.data(current.fields) == clipState,
                  let currentAsset = model.project?.assets.first(where: { $0.id == asset.id }), try NativeMulticamPlanning.data(currentAsset.fields) == assetState,
                  try NativeSourceFileIdentity(file: url) == identity else { return }
            image = result
        } catch { if !Task.isCancelled { message = "Preview unavailable" } }
    }
}
