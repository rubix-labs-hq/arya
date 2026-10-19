import CoreGraphics
import CoreFoundation
import Foundation
import ReelKit
import SwiftUI
import AVFoundation
import ImageIO
import Darwin
#if os(iOS)
import UIKit
#endif


// BEGIN HAPTIC POLICY
/// Feedback accompanies a visible, confirmed event; transport frames and optimistic requests stay silent.
enum NativeHapticKind: Equatable { case selection, snap, commit, success }
struct NativeHapticSignal: Equatable {
    var sequence: UInt64 = 0
    var kind: NativeHapticKind?
}
struct NativeHapticPolicy {
    static let preferenceKey = "editor.interaction.hapticsEnabled"
    private var activeSnapFrame: Int64?
    private var pendingExports: Set<String> = []
    private var consumedExports: Set<String> = []
    private var consumedOrder: [String] = []

    static func enabled(in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: preferenceKey) == nil || defaults.bool(forKey: preferenceKey)
    }
    static func selection(before: Set<String>, primary: String?, after: Set<String>, nextPrimary: String?) -> NativeHapticKind? {
        before != after || primary != nextPrimary ? .selection : nil
    }
    mutating func snap(target: Double?, fps: Double) -> NativeHapticKind? {
        guard let target, target.isFinite, fps.isFinite, fps > 0,
              (target * fps).isFinite, abs(target * fps) < 9_000_000_000_000_000 else {
            activeSnapFrame = nil; return nil
        }
        let frame = Int64((target * fps).rounded())
        guard frame != activeSnapFrame else { return nil }
        activeSnapFrame = frame
        return .snap
    }
    mutating func endSnap() { activeSnapFrame = nil }

    static func committedEdit(before: [String: Any]?, previousVersion: Int, reply: [String: Any]) -> NativeHapticKind? {
        guard previousVersion >= 0, let number = reply["version"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue, number.doubleValue > Double(previousVersion),
              let before, let after = reply["project"] as? [String: Any],
              JSONSerialization.isValidJSONObject(before), JSONSerialization.isValidJSONObject(after),
              let old = try? JSONSerialization.data(withJSONObject: before, options: [.sortedKeys]),
              let next = try? JSONSerialization.data(withJSONObject: after, options: [.sortedKeys]), old != next else { return nil }
        return .commit
    }
    static func imported(count: Int, failures: Int) -> NativeHapticKind? {
        count > 0 && failures == 0 ? .success : nil
    }
    mutating func registerExport(_ reply: [String: Any]) {
        guard reply["kind"] as? String == "export", let id = reply["id"] as? String,
              !id.isEmpty, id.utf8.count <= 512, !consumedExports.contains(id), pendingExports.count < 128 else { return }
        pendingExports.insert(id)
    }
    private mutating func consume(_ id: String) {
        pendingExports.remove(id)
        consumedExports.insert(id); consumedOrder.append(id)
        if consumedOrder.count > 512 { consumedExports.remove(consumedOrder.removeFirst()) }
    }
    mutating func exportUpdate(_ job: [String: Any]) -> NativeHapticKind? {
        guard job["kind"] as? String == "export", let id = job["id"] as? String,
              pendingExports.contains(id), let state = job["state"] as? String else { return nil }
        if ["failed", "cancelled"].contains(state) { consume(id); return nil }
        guard state == "done" else { return nil }
        consume(id)
        guard let output = job["output"] as? String, !output.isEmpty,
              (job["error"] as? String ?? "").isEmpty else { return nil }
        return .success
    }
    mutating func reset() { activeSnapFrame = nil; pendingExports.removeAll(); consumedExports.removeAll(); consumedOrder.removeAll() }
}
// END HAPTIC POLICY

struct NativeEditorSelection: Equatable {
    private(set) var ids: Set<String> = []
    private(set) var primary: String?

    mutating func select(id: String?, extending: Bool = false) {
        guard let id else { ids = []; primary = nil; return }
        if extending {
            if ids.contains(id) { ids.remove(id); if primary == id { primary = ids.sorted().first } }
            else { ids.insert(id); primary = id }
        } else { ids = [id]; primary = id }
    }

    mutating func select(ids: Set<String>, primary: String? = nil) {
        self.ids = ids
        self.primary = primary.flatMap { ids.contains($0) ? $0 : nil } ?? ids.sorted().first
    }

    mutating func reconcile(validIDs: Set<String>) {
        select(ids: ids.intersection(validIDs), primary: primary)
    }
}

struct NativeSourceRange: Equatable {
    let duration: Double
    let fps: Double
    private(set) var time: Double = 0
    private(set) var inPoint: Double = 0
    private(set) var outPoint: Double
    var frame: Double { 1 / fps }
    var length: Double { outPoint - inPoint }

    init?(duration: Double, fps: Double) {
        guard duration.isFinite, duration > 0, fps.isFinite, fps > 0, fps <= 1000 else { return nil }
        self.fps = fps
        self.duration = floor(duration * fps + 1e-7) / fps
        guard self.duration >= 1 / fps else { return nil }
        outPoint = self.duration
    }
    mutating func seek(_ value: Double) {
        guard value.isFinite else { return }
        time = min(duration, max(0, (value * fps).rounded() / fps))
    }
    mutating func markIn(_ value: Double? = nil) {
        guard (value ?? time).isFinite else { return }
        inPoint = min(outPoint - frame, max(0, ((value ?? time) * fps).rounded() / fps))
    }
    mutating func markOut(_ value: Double? = nil) {
        guard (value ?? time).isFinite else { return }
        outPoint = min(duration, max(inPoint + frame, ((value ?? time) * fps).rounded() / fps))
    }
    mutating func clearMarks() { inPoint = 0; outPoint = duration }

    func operation(_ mode: String, source: String, kind: String, hasAudio: Bool = false, tracks: [[String: Any]], at: Double) -> [String: Any]? {
        guard ["append", "insert", "overwrite", "connect"].contains(mode), !source.isEmpty, at.isFinite, at >= 0 else { return nil }
        let targetKind = kind == "audio" ? "audio" : "video"
        let matching = tracks.filter { ($0["kind"] as? String ?? "video") == targetKind }
        let candidate = mode == "connect" && targetKind == "video" ? matching.dropFirst().first(where: { $0["locked"] as? Bool != true }) : matching.first(where: { $0["locked"] as? Bool != true })
        guard let track = candidate, let id = track["id"] as? String, !id.isEmpty else { return nil }
        var result: [String: Any] = ["op": mode == "connect" ? "overwrite" : mode, "src": source, "track": id, "in": kind == "image" ? 0 : inPoint]
        if mode == "connect", kind == "video", hasAudio {
            let audio = tracks.filter { $0["kind"] as? String == "audio" }.dropFirst().first { $0["locked"] as? Bool != true }
            guard let audioID = audio?["id"] as? String, !audioID.isEmpty else { return nil }
            result["audioTrack"] = audioID
        }
        if mode != "append" { result["start"] = at }
        if kind == "image" { result["dur"] = length } else { result["out"] = outPoint }
        return result
    }
}

// BEGIN MATCH FRAME PLANNING
/// Match Frame navigates to original media; it never submits a project operation.
enum NativeMatchFrame {
    struct Failure: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
    struct Target {
        let asset: NativeAsset
        let seconds: Double
        let viewerSeconds: Double
    }
    struct Capture {
        let backend: ReelBackend
        let folder: URL
        let context: UUID
        let revision: UUID
        let version: Int
        let composition: String?
        let selection: Set<String>
        let primary: String
        let timelineTime: Double
        let projectText: String
        let target: Target
        let file: NativeSourceFileIdentity
    }
    private static func number(_ fields: [String: Any], _ key: String, default fallback: Double? = nil) throws -> Double {
        if fields[key] == nil, let fallback { return fallback }
        guard let value = fields[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else {
            throw Failure("The selected clip has invalid source timing. Reimport or repair it first.")
        }
        return value.doubleValue
    }
    static func target(project: NativeProject, composition: String?, selection: Set<String>, primary: String?, at: Double) throws -> Target {
        guard at.isFinite, at >= 0, let primary, selection.contains(primary) else {
            throw Failure("Select a source clip with a current primary selection before matching its frame.")
        }
        if let composition, project.fields.dictionary("comps")[composition] as? [String: Any] == nil {
            throw Failure("The open composition changed. Open it again before matching a frame.")
        }
        let matches = project.tracks(in: composition).flatMap(\.clips).filter { $0.id == primary }
        guard matches.count == 1, let clip = matches.first else {
            throw Failure("The primary clip is missing or ambiguous in this composition.")
        }
        guard ["video", "audio", "image"].contains(clip.kind), !clip.source.isEmpty else {
            throw Failure(clip.kind == "comp" ? "Open this composition and select its source clip before matching a frame." : "Match Frame needs a video, audio or image source clip.")
        }
        guard let asset = project.assets.first(where: { $0.id == clip.source }), !asset.fields.flag("missing"),
              clip.kind != "video" || asset.fields.flag("hasVideo"), clip.kind != "audio" || asset.fields.flag("hasAudio") else {
            throw Failure("The selected source is unavailable. Restore or reimport it before matching a frame.")
        }
        let start = try number(clip.fields, "start"), duration = try number(clip.fields, "dur")
        guard start >= 0, duration > 0, (start + duration).isFinite, at >= start, at < start + duration else {
            throw Failure("Place the playhead inside the selected clip before matching its frame.")
        }
        guard clip.fields["timeMap"] == nil else { throw Failure("Match Frame needs scalar speed; nonlinear retiming is not supported.") }
        let input = try number(clip.fields, "in", default: 0), speed = try number(clip.fields, "speed", default: 1)
        guard input >= 0, speed > 0 else { throw Failure("Match Frame needs a finite source in-point and positive scalar speed.") }
        let scope = composition.flatMap { project.fields.dictionary("comps")[$0] as? [String: Any] } ?? project.fields
        let sourceFPS = asset.fields.number("fps", scope.number("fps", project.fps))
        let fps = sourceFPS.isFinite && sourceFPS > 0 ? sourceFPS : scope.number("fps", project.fps)
        let sourceDuration = asset.kind == "image" ? 5 : asset.duration
        guard sourceDuration.isFinite, sourceDuration > 0, (sourceDuration * fps).isFinite,
              sourceDuration <= Double(Int64.max) / 60000,
              let range = NativeSourceRange(duration: sourceDuration, fps: fps) else {
            throw Failure("This source has no valid duration or frame rate. Reimport it before matching a frame.")
        }
        var seconds = input + (clip.fields.flag("reverse") ? duration - (at - start) : at - start) * speed
        if clip.fields["freeze"] != nil { seconds = try number(clip.fields, "freeze") }
        guard seconds.isFinite else { throw Failure("The source frame is outside the supported timing range.") }
        seconds = asset.kind == "image" ? 0 : max(0, min(asset.duration - 0.001, seconds))
        // A floored endpoint before actual media duration is a readable partial frame.
        // At an exact media endpoint, seek the preceding frame instead.
        let lastFrame = range.duration < sourceDuration ? range.duration : range.duration - range.frame
        let viewerSeconds = min(lastFrame, max(0, (seconds * range.fps).rounded() / range.fps))
        return Target(asset: asset, seconds: seconds, viewerSeconds: viewerSeconds)
    }
}
// END MATCH FRAME PLANNING

struct NativeSourceFileIdentity: Equatable {
    let path: String
    let device: UInt64
    let inode: UInt64
    let size: Int64
    let seconds: Int64
    let nanoseconds: Int64

    init(file: URL) throws {
        let resolved = file.resolvingSymlinksInPath().standardizedFileURL
        var attributes = Darwin.stat()
        guard resolved.path.withCString({ Darwin.fstatat(AT_FDCWD, $0, &attributes, 0) }) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        guard attributes.st_mode & S_IFMT == S_IFREG else { throw CocoaError(.fileReadUnsupportedScheme) }
        path = resolved.path; device = UInt64(UInt32(bitPattern: attributes.st_dev)); inode = attributes.st_ino
        size = attributes.st_size; seconds = Int64(attributes.st_mtimespec.tv_sec); nanoseconds = Int64(attributes.st_mtimespec.tv_nsec)
    }
}

enum NativePanel: String, CaseIterable, Identifiable {
    case media, edit, motion, color, audio, deliver, assistant, figma, transcript
    static let workflow: [NativePanel] = [.media, .edit, .motion, .color, .audio, .deliver]
    static let tools: [NativePanel] = [.assistant, .figma, .transcript]
    var id: String { rawValue }
    var name: String { rawValue.capitalized }
    var icon: String {
        switch self {
        case .media: return "photo.on.rectangle"
        case .edit: return "slider.horizontal.3"
        case .color: return "circle.lefthalf.filled"
        case .audio: return "waveform"
        case .motion: return "diamond"
        case .deliver: return "square.and.arrow.up"
        case .assistant: return "text.bubble"
        case .figma: return "square.stack.3d.up"
        case .transcript: return "text.quote"
        }
    }
}

struct NativeRenderPreviewCapture {
    let id: UUID
    let generation: UUID
    let revision: UUID
    let folder: URL
    let version: Int
    let composition: String?
    let selection: Set<String>
    let time: Double

    func matches(generation: UUID, revision: UUID, folder: URL?, version: Int, composition: String?, selection: Set<String>, time: Double) -> Bool {
        self.generation == generation && self.revision == revision && self.folder == folder && self.version == version &&
            self.composition == composition && self.selection == selection && self.time == time
    }
}

struct NativeDisplayedFrameCapture {
    let context: NativeRenderPreviewCapture
    let image: CGImage
    let renderedFrame: ReelRenderedFrame
    let canvasAspect: Double
    let colorSpace: String
    let selectedID: String?
    var width: Int { image.width }
    var height: Int { image.height }
}

struct NativeViewerColorPicker {
    let id: UUID
    let capture: NativeDisplayedFrameCapture
    let onPick: (Double, Double) -> Void
}

struct NativeViewerComparison {
    let id: UUID
    let context: NativeRenderPreviewCapture
    let image: CGImage
    let canvasAspect: Double
    let caption: String
}

struct NativeMissingMediaRestoreRequest: Identifiable {
    let id = UUID()
    let source: String
    let backend: ReelBackend
    let folder: URL
    let version: Int

    func isCurrent(requestID: UUID?, backend: ReelBackend?, folder: URL?) -> Bool {
        requestID == id && backend === self.backend && folder?.standardizedFileURL.path == self.folder.standardizedFileURL.path
    }
}

// BEGIN NATIVE TIMELINE CLIPBOARD
struct NativeTimelineClipboard {
    static let currentFormatVersion = 1
    let formatVersion = 1
    let id = UUID()
    let originRoot: String
    let originBackend: ObjectIdentifier
    let originContext: UUID
    let originVersion: Int
    let originComposition: String?
    let items: Data
    let assets: [String: Data]
    let compositions: [String: Data]
    let count: Int

    static func canonical(_ value: Any) throws -> Data {
        guard JSONSerialization.isValidJSONObject(value) else { throw ReelBackend.APIError("The clipboard contains invalid project metadata.") }
        return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
    private static func finite(_ fields: [String: Any], _ key: String) throws -> Double {
        guard let number = fields[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { throw ReelBackend.APIError("The selected clips have invalid timing.") }
        return number.doubleValue
    }
    static func scope(_ fields: [String: Any], composition: String?) throws -> [String: Any] {
        guard let composition else { return fields }
        guard let scope = fields.dictionary("comps")[composition] as? [String: Any] else { throw ReelBackend.APIError("The clipboard composition was removed.") }
        return scope
    }
    init(fields: [String: Any], root: String, backend: ObjectIdentifier, context: UUID, version: Int, composition: String?, selected: Set<String>, cut: Bool) throws {
        let scope = try Self.scope(fields, composition: composition), tracks = scope.objects("tracks")
        let all = tracks.flatMap { track in track.objects("clips").map { (track, $0) } }
        let allIDs = all.map { $0.1.string("id") }
        guard !selected.isEmpty, selected.isSubset(of: Set(allIDs)), Set(allIDs).count == allIDs.count, !allIDs.contains("") else { throw ReelBackend.APIError("Choose current timeline clips to copy.") }
        let links = Set(all.filter { selected.contains($0.1.string("id")) }.map { $0.1.string("link") }.filter { !$0.isEmpty })
        let clips = all.filter { selected.contains($0.1.string("id")) || links.contains($0.1.string("link")) }
        guard !clips.isEmpty, clips.count <= 1000 else { throw ReelBackend.APIError("Copy at most 1000 clips at a time.") }
        if cut, clips.contains(where: { $0.0.flag("locked") }) { throw ReelBackend.APIError("Unlock every selected or linked track before cutting.") }
        let start = try clips.map { try Self.finite($0.1, "start") }.min() ?? -.infinity
        guard start.isFinite, start >= 0 else { throw ReelBackend.APIError("The selected clips have invalid timing.") }
        var media: [String: Data] = [:], comps: [String: Data] = [:]
        let values: [[String: Any]] = try clips.map { track, clip in
            let duration = try Self.finite(clip, "dur"), offset = try Self.finite(clip, "start") - start
            guard duration.isFinite, duration > 0, offset.isFinite, offset >= 0 else { throw ReelBackend.APIError("The selected clips have invalid timing.") }
            for src in ([clip.string("src")] + clip.objects("angles").map { $0.string("src") }).filter({ !$0.isEmpty }) {
                guard let asset = fields.dictionary("assets")[src] as? [String: Any] else { throw ReelBackend.APIError("A selected media source was removed.") }
                media[src] = try Self.canonical(asset)
            }
            if clip.string("kind") == "comp" {
                let id = clip.string("comp")
                guard let comp = fields.dictionary("comps")[id] as? [String: Any] else { throw ReelBackend.APIError("A selected composition was removed.") }
                comps[id] = try Self.canonical(comp)
            }
            return ["track": track.string("id"), "kind": track.string("kind"), "clip": clip, "offset": offset]
        }
        let data = try Self.canonical(values)
        guard data.count <= 4 * 1024 * 1024 else { throw ReelBackend.APIError("The selected clip metadata exceeds 4 MB.") }
        originRoot = root; originBackend = backend; originContext = context; originVersion = version; originComposition = composition
        items = data; assets = media; compositions = comps; count = clips.count
    }
    func operation(fields: [String: Any], composition: String?, at: Double) throws -> [String: Any] {
        guard formatVersion == Self.currentFormatVersion, at.isFinite, at >= 0 else { throw ReelBackend.APIError("Choose a finite timeline playhead before pasting.") }
        for (src, data) in assets {
            guard let asset = fields.dictionary("assets")[src] as? [String: Any], try Self.canonical(asset) == data else { throw ReelBackend.APIError("A copied source changed. Copy the clips again.") }
        }
        for (id, data) in compositions {
            guard let comp = fields.dictionary("comps")[id] as? [String: Any], try Self.canonical(comp) == data else { throw ReelBackend.APIError("A copied composition changed. Copy the clips again.") }
        }
        let tracks = try Self.scope(fields, composition: composition).objects("tracks")
        guard var values = try JSONSerialization.jsonObject(with: items) as? [[String: Any]] else { throw ReelBackend.APIError("The clipboard format is invalid.") }
        var mapping: [String: String] = [:], used: Set<String> = []
        for i in values.indices {
            let sourceTrack = values[i].string("track"), kind = values[i].string("kind")
            if let destination = mapping[sourceTrack] { values[i]["track"] = destination; continue }
            let same = tracks.first { $0.string("id") == sourceTrack && $0.string("kind") == kind }
            if let same, same.flag("locked") { throw ReelBackend.APIError("Unlock the copied destination tracks before pasting.") }
            guard let track = same ?? tracks.first(where: { $0.string("kind") == kind && !$0.flag("locked") && !used.contains($0.string("id")) }) else { throw ReelBackend.APIError("Add an unlocked destination track for each copied track before pasting.") }
            let id = track.string("id")
            guard !id.isEmpty, !used.contains(id) else { throw ReelBackend.APIError("The destination track layout is invalid.") }
            mapping[sourceTrack] = id; used.insert(id); values[i]["track"] = id
        }
        return ["op": "paste", "clipboard": true, "at": at, "clips": values, "comp": composition as Any? ?? NSNull()]
    }
    func confirmedPasteIDs(_ reply: [String: Any], capture: NativeClipboardActionCapture) throws -> [String] {
        guard let version = reply["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
              version.doubleValue == Double(capture.version + 1), let fields = reply["project"] as? [String: Any],
              let created = reply["created"] as? [String], created.count == count, Set(created).count == count,
              !created.contains("") else { throw ReelBackend.APIError("The paste receipt is incomplete.") }
        let tracks = try Self.scope(fields, composition: capture.composition).objects("tracks")
        let IDs = tracks.flatMap { $0.objects("clips").map { $0.string("id") } }
        let previous = capture.fields.objects("tracks") + capture.fields.dictionary("comps").values.flatMap { ($0 as? [String: Any])?.objects("tracks") ?? [] }
        let previousIDs = Set(previous.flatMap { $0.objects("clips").map { $0.string("id") } })
        guard created.allSatisfy({ id in IDs.filter({ $0 == id }).count == 1 && !previousIDs.contains(id) }) else { throw ReelBackend.APIError("The paste receipt does not identify fresh timeline clips.") }
        return created
    }
    var clipIDs: [String] { ((try? JSONSerialization.jsonObject(with: items)) as? [[String: Any]] ?? []).map { $0.dictionary("clip").string("id") } }
}

struct NativeClipboardActionCapture {
    let context: UUID
    let backend: ObjectIdentifier
    let root: String
    let version: Int
    let composition: String?
    let selection: Set<String>
    let primary: String?
    let time: Double
    let fields: [String: Any]
    let clipboardID: UUID?
}
// END NATIVE TIMELINE CLIPBOARD

@MainActor
final class NativeEditorModel: ObservableObject {
    @Published private(set) var project: NativeProject?
    @Published private(set) var version = -1
    @Published private(set) var changeReceipts: [NativeChangeReceipt] = []
    @Published private(set) var hapticSignal = NativeHapticSignal()
    private var hapticPolicy = NativeHapticPolicy()
    @Published var selectedID: String? {
        didSet {
            if oldValue != selectedID { discardRenderPreview() }
            if !applyingSelection { selectedIDs = selectedID.map { Set([$0]) } ?? [] }
        }
    }
    @Published private(set) var selectedIDs: Set<String> = []
    @Published private(set) var timelineClipboard: NativeTimelineClipboard?
    @Published private(set) var clipboardEditing = false
    private var clipboardTaskID: UUID?
    private var applyingSelection = false
    @Published var composition: String? { didSet { discardRenderPreview(redraw: false); viewerComparison = nil; selectedID = nil; seek(0) } }
    @Published var panel: NativePanel = .edit { didSet { if oldValue != panel { discardRenderPreview() }; if panel == .color { if let metalFrame { frame = try? metalFrame.cgImage() }; requestFrame() } } }
    @Published var requestedWorkspace: NativePanel?
    @Published var time: Double = 0
    @Published var zoom: Double = 80
    @Published private(set) var playing = false
    @Published private(set) var masterAudioMeter: NativeMasterAudioMeterSnapshot = .silence
    @Published private(set) var busAudioMeters: [ReelAudioBusMeterKey: NativeMasterAudioMeterSnapshot] = [:]
    @Published private(set) var frame: CGImage?
    @Published private(set) var metalFrame: ReelRenderedFrame?
    @Published private(set) var scopePixels: NativeScopeRaster?
    private var scopeQueued: (frame: ReelRenderedFrame, generation: UUID, epoch: Int, side: Int)?
    private var scopeWorker: Task<Void, Never>?
    /// Increases when a preview is released, the project resets or the scopes leave the screen, so a
    /// measurement already running cannot publish scopes for a frame that is gone.
    private var scopeEpoch = 0
    /// Scope views on screen. Frames are measured only while one is visible.
    private var scopeViewers = 0

    func scopesAppeared() {
        scopeViewers += 1
        if scopeViewers == 1 { requestFrame() }
    }

    func scopesDisappeared() {
        scopeViewers = max(0, scopeViewers - 1)
        if scopeViewers == 0 { clearScopes() }
    }

    private var scopesShown: Bool { scopeViewers > 0 && panel == .color }

    private func clearScopes() {
        scopeQueued = nil; scopeEpoch += 1; scopePixels = nil
    }

    /// Latest frame wins. While one frame is measured, newer frames replace the queued one, so
    /// playback never waits for scopes and the last frame shown is always the one measured.
    private func measureScopes(_ frame: ReelRenderedFrame, generation: UUID) {
        guard scopesShown else { clearScopes(); return }
        scopeQueued = (frame, generation, scopeEpoch, playing ? NativeScopeRaster.playbackSide : NativeScopeRaster.stillSide)
        guard scopeWorker == nil else { return }
        scopeWorker = Task { [weak self] in
            while let self, let next = self.scopeQueued {
                self.scopeQueued = nil
                let raster = await Task.detached(priority: .utility) { () -> NativeScopeRaster? in
                    (try? next.frame.scopeSamples(maximumSide: next.side)).map { NativeScopeRaster($0) }
                }.value
                if self.scopeEpoch == next.epoch, self.generation == next.generation, self.scopesShown { self.scopePixels = raster }
            }
            self?.scopeWorker = nil
        }
    }
    @Published var hdrScopes = false { didSet { requestFrame() } }
    var readbackFrames = false
    @Published private(set) var rendering = false
    @Published private(set) var renderError: String?
    @Published private(set) var displayedTime: Double?
    private var displayedPreviewID: UUID?
    private var displayedRevision: UUID?
    private var displayedVersion: Int?
    private var displayedComposition: String?
    private var displayedFolder: URL?
    private var displayedGeneration: UUID?
    @Published private(set) var scrubbing = false
    @Published private(set) var previewing = false
    @Published var viewerColorPicker: NativeViewerColorPicker?
    @Published var viewerColorWindow: NativeColorWindowController?
    @Published var viewerComparison: NativeViewerComparison?
    @Published var viewerComparisonFraction: Double = 0.5
    let colorGallery = NativeColorGalleryStore()
    private(set) var paintedFrames = 0
    @Published private(set) var capabilities: [String: Any] = [:]
    @Published private(set) var jobs: [[String: Any]] = []
    @Published var status = ""
    @Published var busy = false
    @Published var missingMediaRestoreRequest: NativeMissingMediaRestoreRequest?
    @Published private(set) var restoringMediaSource: String?
    @Published private(set) var mediaRestorationRevision = UUID()
    private var mediaRestoreTask: Task<Void, Never>?
    @Published var importedMediaRevealID = UUID()
    @Published var mediaImportNavigation: NativeMediaImportNavigation?
    @Published var mediaImportRequest: NativeMediaImportRequest?
    // Existing Import buttons use this entry point; capture the project synchronously.
    var showFiles: Bool {
        get { mediaImportRequest != nil }
        set {
            guard newValue else { mediaImportRequest = nil; return }
            guard mediaImportRequest == nil, let backend = session?.backend, let folder else { return }
            mediaImportRequest = NativeMediaImportRequest(backend: backend, folder: folder, panelID: mobilePanel?.rawValue)
        }
    }
    @Published var mobilePanel: NativePanel?
    @Published var drawing: NativeDrawingMode?
    @Published var assistantDraft = ""
    @Published var assistantInputKind = "prompt"
    @Published var transcriptSource: String?
    let transcript = NativeTranscriptState()
    @Published var lookReference: String?
    @Published var showingSource = false { didSet { if showingSource { discardRenderPreview(); pause(); drawing = nil } else { pauseSource() } } }
    @Published private(set) var sourceAssetID: String?
    @Published private(set) var sourceRange: NativeSourceRange?
    @Published private(set) var sourceImage: CGImage?
    @Published private(set) var sourceLoading = false
    @Published private(set) var sourcePlaying = false
    @Published private(set) var sourceError: String?
    let sourcePlayer = AVPlayer()
    private var sourceGeneration = UUID()
    private var sourcePlaybackGeneration = UUID()
    private var sourceLoadTask: Task<Void, Never>?
    private var sourceTimeObserver: Any?
    private var sourceStatusObserver: NSKeyValueObservation?
    private var sourceFileIdentity: NativeSourceFileIdentity?
    private var sourceAssetSnapshot: String?
    #if os(iOS)
    @Published var useProxies = true { didSet { if useProxies { prepareProxies() }; requestFrame() } }
    #else
    @Published var useProxies = false { didSet { if useProxies { prepareProxies() }; requestFrame() } }
    #endif
    private weak var session: EditorSession?
    private var playTask: Task<Void, Never>?
    private var audioPrepareTask: Task<Void, Never>?
    #if DEBUG
    var playbackChunkForTesting: Double?
    var playbackCompletedSegments: Int { playbackAudio.completedSegments }
    var playbackClockForTesting: Double? { playbackAudio.time }
    private(set) var audioPreparationSeconds: [Double] = []
    private(set) var audioPreviewHistorySeconds: [Double] = []
    #endif
    private var renderTask: Task<Void, Never>?
    private var proxyTask: Task<Void, Never>?
    private var proxies: [String: String] = [:]
    private struct FrameRequest { let token: UUID; let generation: UUID; let folder: URL; let project: String; let version: Int; let revision: UUID; let at: Double; let comp: String?; var width: Int; let queuedAt: ContinuousClock.Instant; let scrubID: UUID?; let draft: Bool; let color: Bool; let hdrScopes: Bool; let previewID: UUID?; let operations: String? }
    private struct ScrubQualityPolicy {
        let widths: [Int]
        private(set) var level = 2
        private var healthy = 0
        init(widths: [Int]) { self.widths = widths }
        var width: Int { widths[level] }
        mutating func completed(seconds: Double, width: Int) {
            guard seconds.isFinite, seconds >= 0, width == self.width else { healthy = 0; return }
            if seconds > 0.100 { level = max(0, level - 1); healthy = 0 }
            else if seconds <= 0.060 {
                healthy += 1
                if healthy >= 8 { level = min(widths.count - 1, level + 1); healthy = 0 }
            } else { healthy = 0 }
        }
        mutating func failed() { level = max(0, level - 1); healthy = 0 }
    }
    private struct ScrubContext: Equatable {
        let generation: UUID; let folder: URL; let version: Int; let revision: UUID; let comp: String?
    }
    private let frameClock = ContinuousClock()
    private var scrubContext: ScrubContext?
    private var scrubInteractionID: UUID?
    private var scrubReleaseID: UUID?
    #if os(iOS)
    private var scrubQuality = ScrubQualityPolicy(widths: [160, 240, 320])
    #else
    private var scrubQuality = ScrubQualityPolicy(widths: [240, 320, 480])
    #endif
    #if DEBUG
    private let frameClockOrigin = ContinuousClock().now
    private(set) var scrubFrameTimings: [JSON] = []
    private(set) var scrubTimingDroppedRecords = 0
    private(set) var scrubLastIntentToken: UUID?
    var scrubTimingOffsetSeconds: Double { frameSeconds(from: frameClockOrigin, to: frameClock.now) }
    func resetScrubTimingRecords() { scrubFrameTimings.removeAll(keepingCapacity: true); scrubTimingDroppedRecords = 0 }
    #endif

    private func frameSeconds(from: ContinuousClock.Instant, to: ContinuousClock.Instant) -> Double {
        let value = from.duration(to: to).components
        return Double(value.seconds) + Double(value.attoseconds) / 1_000_000_000_000_000_000
    }

    private func adaptiveScrubMatches(_ request: FrameRequest) -> Bool {
        scrubbing && !playing && previewOperations == nil && panel != .color && request.draft &&
            request.scrubID != nil && request.scrubID == scrubInteractionID &&
            generation == request.generation && folder == request.folder && version == request.version &&
            projectRevision == request.revision && composition == request.comp
    }

    #if DEBUG
    private func recordScrubTiming(_ request: FrameRequest, outcome: String, started: ContinuousClock.Instant? = nil,
                                   rendered: ContinuousClock.Instant? = nil, published: ContinuousClock.Instant? = nil) {
        guard let interaction = request.scrubID else { return }
        let now = frameClock.now
        var fields: [String: Any] = ["token": request.token.uuidString, "interaction": interaction.uuidString,
            "generation": request.generation.uuidString, "folder": request.folder.path, "version": request.version,
            "revision": request.revision.uuidString, "composition": request.comp as Any? ?? NSNull(),
            "requestedTime": request.at, "width": request.width, "draft": request.draft, "outcome": outcome,
            "intentOffsetSeconds": frameSeconds(from: frameClockOrigin, to: request.queuedAt),
            "recordOffsetSeconds": frameSeconds(from: frameClockOrigin, to: now), "presentationMeasured": false]
        if let started {
            fields["queueSeconds"] = frameSeconds(from: request.queuedAt, to: started)
            fields["workerStartOffsetSeconds"] = frameSeconds(from: frameClockOrigin, to: started)
        }
        if let rendered { fields["rendererReturnOffsetSeconds"] = frameSeconds(from: frameClockOrigin, to: rendered) }
        if let published { fields["publicationOffsetSeconds"] = frameSeconds(from: frameClockOrigin, to: published) }
        if let started, let rendered { fields["rendererSeconds"] = frameSeconds(from: started, to: rendered) }
        if let started, let published { fields["workToPublicationSeconds"] = frameSeconds(from: started, to: published) }
        if let published { fields["intentToPublicationSeconds"] = frameSeconds(from: request.queuedAt, to: published) }
        if scrubFrameTimings.count >= 128 { scrubFrameTimings.removeFirst(); scrubTimingDroppedRecords += 1 }
        scrubFrameTimings.append(JSON(any: fields))
    }
    #endif

    private var projectRevision = UUID()
    private var previewCapture: NativeRenderPreviewCapture?
    private var previewOwnershipID: UUID?
    private var previewOperations: String?
    private var pendingFrame: FrameRequest?
    private var renderWorkerID = UUID()
    private var renderer: ReelMetalRenderer?
    private var generation = UUID()
    private var renderGeneration = UUID()
    private let playbackAudio = NativePlaybackAudio()

    init(session: EditorSession) {
        self.session = session
        playbackAudio.onMeter = { [weak self] meter, origin in
            guard let self, origin == self.generation else { return }
            self.masterAudioMeter = meter
        }
    }
    var tracks: [NativeTrack] { project?.tracks(in: composition) ?? [] }
    var selected: NativeClip? { tracks.flatMap(\.clips).first { $0.id == selectedID } }
    var duration: Double { project?.duration(in: composition) ?? 0 }
    var canvas: [String: Any] { composition.flatMap { project?.fields.dictionary("comps")[$0] as? [String: Any] } ?? project?.fields ?? [:] }
    var width: Double { canvas.number("width", project?.width ?? 1920) }
    var height: Double { canvas.number("height", project?.height ?? 1080) }
    var fps: Double { canvas.number("fps", project?.fps ?? 30) }
    var folder: URL? { session?.folder }
    var projectReadOnlyReason: String? { session?.projectReadOnlyReason }
    var processingContextID: UUID { generation }
    var renderPreviewBackendID: ObjectIdentifier? { session?.backend.map { ObjectIdentifier($0) } }
    func captureAudioBackend() -> ReelBackend? { session?.backend }
    var audioProjectRevision: UUID { projectRevision }
    var sourceAsset: NativeAsset? { project?.assets.first { $0.id == sourceAssetID } }

    func select(id: String?, extending: Bool = false, feedback: Bool = true) {
        let validIDs = Set(tracks.flatMap(\.clips).map(\.id))
        if let id, !validIDs.contains(id) { return }
        var selection = NativeEditorSelection()
        selection.select(ids: selectedIDs, primary: selectedID)
        selection.select(id: id, extending: extending)
        applySelection(selection, feedback: feedback)
    }

    func select(ids: Set<String>, primary: String? = nil, feedback: Bool = true) {
        var selection = NativeEditorSelection()
        selection.select(ids: ids.intersection(Set(tracks.flatMap(\.clips).map(\.id))), primary: primary)
        applySelection(selection, feedback: feedback)
    }

    private func applySelection(_ selection: NativeEditorSelection, feedback: Bool) {
        let kind = feedback ? NativeHapticPolicy.selection(before: selectedIDs, primary: selectedID, after: selection.ids, nextPrimary: selection.primary) : nil
        if selectedIDs != selection.ids { discardRenderPreview() }
        applyingSelection = true
        selectedIDs = selection.ids; selectedID = selection.primary
        applyingSelection = false
        emitHaptic(kind)
    }

    private func emitHaptic(_ kind: NativeHapticKind?) {
        #if os(iOS)
        guard let kind, NativeHapticPolicy.enabled() else { return }
        guard UIApplication.shared.applicationState == .active, NativeHapticAvailability.supported else { return }
        hapticSignal = NativeHapticSignal(sequence: hapticSignal.sequence &+ 1, kind: kind)
        #endif
    }
    func updateSnapFeedback(target: Double?, fps: Double) { emitHaptic(hapticPolicy.snap(target: target, fps: fps)) }
    func endSnapFeedback() { hapticPolicy.endSnap() }
    // Call only after the owning import batch's validated receipt and stale-context guard.
    func confirmImportFeedback(imported: Int, failed: Int) {
        guard !Task.isCancelled else { return }
        emitHaptic(NativeHapticPolicy.imported(count: imported, failures: failed))
    }
    func registerExportFeedback(_ reply: [String: Any]) {
        hapticPolicy.registerExport(reply)
        if let current = jobs.first(where: { $0.string("id") == reply.string("id") }) { confirmExportFeedback(current) }
    }
    func confirmExportFeedback(_ job: [String: Any]) { emitHaptic(hapticPolicy.exportUpdate(job)) }

    func isMissingMedia(_ asset: NativeAsset) -> Bool {
        guard let file = try? mediaURL(asset.id) else { return true }
        return !FileManager.default.fileExists(atPath: file.path)
    }

    func chooseMissingOriginal(_ asset: NativeAsset) {
        guard restoringMediaSource == nil, isMissingMedia(asset), let session,
              let backend = session.backend, let folder, session.projectReadOnlyReason == nil else { return }
        missingMediaRestoreRequest = NativeMissingMediaRestoreRequest(source: asset.id, backend: backend, folder: folder, version: version)
    }

    func cancelMediaRestore() {
        mediaRestoreTask?.cancel()
    }

    func restoreMissingOriginal(_ request: NativeMissingMediaRestoreRequest, from selected: URL) {
        guard mediaRestoreTask == nil, let session, session.backend === request.backend,
              folder == request.folder, version == request.version else { status = "The project changed. Choose the missing original again."; return }
        let token = generation
        restoringMediaSource = request.source
        mediaRestoreTask = Task {
            let scoped = selected.startAccessingSecurityScopedResource()
            defer {
                if scoped { selected.stopAccessingSecurityScopedResource() }
                if generation == token, restoringMediaSource == request.source { restoringMediaSource = nil; mediaRestoreTask = nil }
            }
            do {
                _ = try await request.backend.restoreMissingMedia(source: request.source, from: selected, expectedVersion: request.version)
                guard generation == token, session.backend === request.backend, folder == request.folder else { return }
                // Retry viewers and thumbnails against the newly restored original.
                clearSource(); proxies[request.source] = nil; mediaRestorationRevision = UUID()
                renderTask?.cancel(); renderTask = nil; pendingFrame = nil; renderWorkerID = UUID(); renderer = nil
                renderGeneration = UUID()
                await refresh()
                guard generation == token, session.backend === request.backend, folder == request.folder else { return }
                status = "Restored \((request.source as NSString).lastPathComponent). Existing project edits and Undo history were preserved."
            } catch is CancellationError {
                if generation == token { status = "Original restoration cancelled before publication." }
            } catch {
                guard generation == token, session.backend === request.backend else { return }
                status = error.localizedDescription; session.error = error.localizedDescription
            }
        }
    }

    func importReference(_ url: URL) async throws -> String {
        guard let session, let backend = session.backend else { throw ReelBackend.APIError("Open a project first.") }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let result = try await backend.copyIn([url])
        guard session.backend === backend, !Task.isCancelled else { throw CancellationError() }
        guard let fields = try JSON.parse(result.text) as? [String: Any], let path = fields.dictionary("assets").keys.sorted().first else { throw ReelBackend.APIError("The reference image could not be imported.") }
        lookReference = path
        return path
    }

    func reset() {
        cancelMediaRestore()
        mediaRestoreTask = nil; restoringMediaSource = nil
        missingMediaRestoreRequest = nil
        mediaImportRequest = nil; mediaImportNavigation = nil
        requestedWorkspace = nil
        transcript.projectDidChange()
        discardRenderPreview(redraw: false); projectRevision = UUID()
        previewOwnershipID = nil
        viewerComparison = nil; viewerComparisonFraction = 0.5
        colorGallery.clear()
        clearSource()
        pause(); renderTask?.cancel(); renderTask = nil; pendingFrame = nil; renderWorkerID = UUID(); renderer = nil
        proxyTask?.cancel(); proxyTask = nil; proxies = [:]
        generation = UUID(); renderGeneration = UUID()
        project = nil; version = -1; selectedID = nil; composition = nil
        changeReceipts = []
        timelineClipboard = nil; clipboardEditing = false; clipboardTaskID = nil
        hapticPolicy.reset()
        time = 0; frame = nil; metalFrame = nil; clearScopes(); hdrScopes = false; renderError = nil; rendering = false
        displayedTime = nil; displayedPreviewID = nil; displayedVersion = nil; displayedRevision = nil; displayedComposition = nil; displayedFolder = nil; displayedGeneration = nil; scrubbing = false; paintedFrames = 0
        jobs = []; capabilities = [:]; status = ""; busy = false
        drawing = nil
        assistantDraft = ""; assistantInputKind = "prompt"; lookReference = nil
        transcriptSource = nil
    }

    func refresh() async {
        guard let session, let backend = session.backend else { return }
        do {
            let snapshot = try await session.request(method: "GET", path: "/api/project", body: nil)
            guard session.backend === backend else { return }
            receive("project", snapshot.text)
            let caps = try await session.request(method: "GET", path: "/api/caps", body: nil)
            guard session.backend === backend else { return }
            capabilities = (try JSON.parse(caps.text) as? [String: Any]) ?? [:]
            if renderer == nil, let folder = session.folder {
                let fonts = ["InterVariable.ttf", "InterVariable-Italic.ttf"].map { session.editor.root.appendingPathComponent("web/fonts/\($0)") }
                renderer = try ReelMetalRenderer(folder: ProjectFolder(root: folder), coreScriptURL: session.editor.coreScript, fontURLs: fonts)
            }
            requestFrame()
            prepareProxies()
        } catch {
            guard session.backend === backend else { return }
            status = error.localizedDescription
        }
    }

    func receive(_ event: String, _ text: String) {
        guard let value = try? JSON.parse(text) else { return }
        let fields = value as? [String: Any] ?? [:]
        switch event {
        case "project":
            let incomingVersion = Int(fields.number("version", Double(version)))
            guard incomingVersion >= version, let p = fields["project"] as? [String: Any] else { return }
            discardRenderPreview(redraw: false); projectRevision = UUID()
            if let receipt = NativeChangeReceipt.make(before: project?.fields, after: p, previousVersion: version,
                                                       version: incomingVersion, who: fields.string("who")) {
                changeReceipts = NativeChangeReceipt.appending(receipt, to: changeReceipts)
            }
            if incomingVersion != version { pause() }
            version = incomingVersion; project = NativeProject(fields: p)
            select(ids: selectedIDs, primary: selectedID, feedback: false)
            if sourceAssetID != nil, sourceAsset == nil { clearSource() }
            else if let sourceAsset, sourceAssetSnapshot != JSON(any: sourceAsset.fields).text { clearSource(); status = "The source metadata changed. Open the source again before marking or placing it." }
            time = min(time, max(0, duration)); requestFrame(); prepareProxies()
            if let allJobs = fields["jobs"] as? [[String: Any]] { jobs = allJobs }
        case "job":
            let id = fields.string("id")
            jobs.removeAll { $0.string("id") == id }; jobs.append(fields)
            confirmExportFeedback(fields)
        case "activity": status = fields.string("text", fields.string("summary"))
        default: break
        }
    }

    @discardableResult
    func call(_ path: String, _ body: [String: Any]? = nil, method: String? = nil) async throws -> [String: Any] {
        guard let session, let backend = session.backend else { throw ReelBackend.APIError("Open a project first.") }
        let value = try await session.request(method: method ?? (body == nil ? "GET" : "POST"), path: path, body: body.map { JSON(any: $0).text })
        guard session.backend === backend, !Task.isCancelled else { throw CancellationError() }
        let fields = try JSON.parse(value.text) as? [String: Any] ?? [:]
        if fields["project"] != nil { receive("project", value.text) }
        return fields
    }

    func perform(_ action: @escaping @MainActor () async throws -> Void) {
        let token = generation
        Task {
            guard generation == token else { return }
            do { try await action() }
            catch is CancellationError { }
            catch { guard generation == token else { return }; status = error.localizedDescription; session?.error = error.localizedDescription }
        }
    }

    func ops(_ operations: [[String: Any]], summary: String? = nil, expectedVersion: Int? = nil) async throws {
        var scoped = operations
        if let composition { scoped = operations.map { var o = $0; o["comp"] = composition; return o } }
        var body: [String: Any] = ["ops": scoped, "who": "you", "returnProject": true]
        if let summary { body["summary"] = summary }
        if let expectedVersion { body["expectedVersion"] = expectedVersion }
        _ = try await call("/api/ops", body)
    }

    func edit(_ operation: [String: Any], expectedVersion: Int? = nil, feedback: Bool = false) {
        editBatch([operation], expectedVersion: expectedVersion, feedback: feedback)
    }

    func editBatch(_ operations: [[String: Any]], summary: String? = nil, expectedVersion: Int? = nil, feedback: Bool = false) {
        guard !operations.isEmpty else { return }
        let sourceFolder = folder, sourceComposition = composition
        let scoped = operations.map { operation in
            var result = operation
            result["comp"] = sourceComposition as Any? ?? NSNull()
            return result
        }
        var body: [String: Any] = ["ops": scoped, "who": "you", "returnProject": true]
        if let summary { body["summary"] = summary }
        if let expectedVersion { body["expectedVersion"] = expectedVersion }
        let request = body
        perform {
            guard self.folder == sourceFolder, self.composition == sourceComposition,
                  expectedVersion == nil || expectedVersion == self.version else {
                throw ReelBackend.APIError("The project changed before the edit started. Try again.")
            }
            let context = self.generation, before = self.project?.fields, previousVersion = self.version
            let reply = try await self.call("/api/ops", request)
            if feedback, self.generation == context, self.composition == sourceComposition {
                self.emitHaptic(NativeHapticPolicy.committedEdit(before: before, previousVersion: previousVersion, reply: reply))
            }
        }
    }
    // BEGIN CONFIRMED MARKER COMMIT
    /// The sheet retains its draft until this scoped operation returns its exact receipt.
    func commitMarkerEdit(_ operation: [String: Any], capture: NativeTimelineMarkerCapture) async throws {
        guard capture.matches(model: self), let before = project?.fields,
              let kind = operation["op"] as? String, ["marker", "update_marker", "delete_marker"].contains(kind),
              kind == "marker" ? capture.markerID == nil : operation["id"] as? String == capture.markerID else {
            throw ReelBackend.APIError("This marker or project changed. Select the marker again.")
        }
        var scoped = operation
        scoped["comp"] = capture.composition as Any? ?? NSNull()
        let summary = kind == "marker" ? "Add marker" : kind == "update_marker" ? "Edit marker" : "Delete marker"
        let reply = try await call("/api/ops", ["ops": [scoped], "who": "you", "summary": summary,
                                              "expectedVersion": capture.version, "returnProject": true])
        guard capture.ownsScope(model: self), !Task.isCancelled else { throw CancellationError() }
        guard version == capture.version + 1, capture.confirmed(reply, operation: operation),
              let returned = reply["project"] as? [String: Any], let current = project?.fields,
              NativeTimelineMarkerEditing.same(returned, current) else {
            throw ReelBackend.APIError("The marker change did not return a confirmed receipt. Refresh the project before trying again.")
        }
        emitHaptic(NativeHapticPolicy.committedEdit(before: before, previousVersion: capture.version, reply: reply))
    }
    // END CONFIRMED MARKER COMMIT
    func update(_ clip: NativeClip, _ fields: [String: Any]) { edit(["op": "update", "id": clip.id, "set": fields]) }
    func undo(redo: Bool = false) {
        perform {
            let context = self.generation, sourceComposition = self.composition, before = self.project?.fields, previousVersion = self.version
            let reply = try await self.call(redo ? "/api/redo" : "/api/undo", [:])
            if self.generation == context, self.composition == sourceComposition { self.emitHaptic(NativeHapticPolicy.committedEdit(before: before, previousVersion: previousVersion, reply: reply)) }
        }
    }
    func split() {
        var operation: [String: Any] = ["op": "blade", "at": time]
        if let selectedID { operation["id"] = selectedID }
        edit(operation, feedback: true)
    }
    // BEGIN NATIVE CLIPBOARD CONTROLLER
    func clipboardActionCapture() -> NativeClipboardActionCapture? {
        guard !showingSource, !busy, !clipboardEditing, let session, session.projectReadOnlyReason == nil,
              let backend = session.backend, let folder, let project, version >= 0 else { return nil }
        return .init(context: generation, backend: ObjectIdentifier(backend), root: folder.standardizedFileURL.path,
                     version: version, composition: composition, selection: selectedIDs, primary: selectedID,
                     time: time, fields: project.fields, clipboardID: timelineClipboard?.id)
    }
    private func clipboardMatches(_ capture: NativeClipboardActionCapture, compareTime: Bool = false) -> Bool {
        guard !showingSource, !busy, let session, session.projectReadOnlyReason == nil, let backend = session.backend,
              generation == capture.context, ObjectIdentifier(backend) == capture.backend,
              folder?.standardizedFileURL.path == capture.root, version == capture.version, composition == capture.composition,
              selectedIDs == capture.selection, selectedID == capture.primary, !compareTime || time == capture.time,
              let fields = project?.fields,
              let current = try? NativeTimelineClipboard.canonical(fields), let original = try? NativeTimelineClipboard.canonical(capture.fields) else { return false }
        return current == original
    }
    private func clipboardReplyOwnsUI(_ capture: NativeClipboardActionCapture) -> Bool {
        generation == capture.context && session?.backend.map({ ObjectIdentifier($0) }) == capture.backend &&
            folder?.standardizedFileURL.path == capture.root && composition == capture.composition &&
            selectedIDs == capture.selection && selectedID == capture.primary && time == capture.time &&
            !showingSource && !busy && (version == capture.version || version == capture.version + 1)
    }
    var canCopyTimelineSelection: Bool { !showingSource && !busy && !clipboardEditing && !selectedIDs.isEmpty && project != nil }
    var canPasteTimelineClipboard: Bool { !showingSource && !busy && !clipboardEditing && timelineClipboard != nil && project != nil }

    func copyTimelineSelection(cut: Bool = false, expected: NativeClipboardActionCapture? = nil, targetID: String? = nil) {
        guard let capture = expected ?? clipboardActionCapture(), !clipboardEditing, clipboardMatches(capture) else { status = "The project or selection changed. Choose the clipboard action again."; return }
        do {
            let ids: Set<String> = targetID.map { capture.selection.contains($0) ? capture.selection : Set([$0]) } ?? capture.selection
            let value = try NativeTimelineClipboard(fields: capture.fields, root: capture.root, backend: capture.backend,
                                                    context: capture.context, version: capture.version, composition: capture.composition, selected: ids, cut: cut)
            timelineClipboard = value
            guard cut else { status = "Copied \(value.count) clips"; return }
            clipboardEditing = true
            let taskID = UUID(); clipboardTaskID = taskID
            perform {
                defer { if self.clipboardTaskID == taskID { self.clipboardEditing = false; self.clipboardTaskID = nil } }
                guard self.clipboardMatches(capture) else { throw ReelBackend.APIError("The project or selection changed before cutting.") }
                let operation: [String: Any] = ["op": "delete", "ids": value.clipIDs, "unlinked": true, "comp": capture.composition as Any? ?? NSNull()]
                let reply = try await self.call("/api/ops", ["ops": [operation], "who": "you", "summary": "Cut selected clips", "expectedVersion": capture.version, "returnProject": true])
                guard self.generation == capture.context, self.session?.backend.map({ ObjectIdentifier($0) }) == capture.backend,
                      self.folder?.standardizedFileURL.path == capture.root, self.composition == capture.composition else { return }
                guard reply["version"] as? Int == capture.version + 1, self.version == capture.version + 1,
                      self.selectedIDs == capture.selection.subtracting(Set(value.clipIDs)), !self.showingSource else { return }
                self.emitHaptic(.commit); self.status = "Cut \(value.count) clips"
            }
        } catch { status = error.localizedDescription }
    }
    func pasteTimelineClipboard(expected: NativeClipboardActionCapture? = nil) {
        guard let capture = expected ?? clipboardActionCapture(), !clipboardEditing, clipboardMatches(capture, compareTime: true),
              let value = timelineClipboard, value.id == capture.clipboardID, value.originRoot == capture.root,
              value.originBackend == capture.backend, value.originContext == capture.context else { status = "Copy clips in this project before pasting."; return }
        do {
            let operation = try value.operation(fields: capture.fields, composition: capture.composition, at: capture.time)
            clipboardEditing = true
            let taskID = UUID(); clipboardTaskID = taskID
            perform {
                defer { if self.clipboardTaskID == taskID { self.clipboardEditing = false; self.clipboardTaskID = nil } }
                guard self.clipboardMatches(capture, compareTime: true), self.timelineClipboard?.id == value.id else { throw ReelBackend.APIError("The project, selection or playhead changed before pasting.") }
                let reply: [String: Any]
                do {
                    reply = try await self.call("/api/ops", ["ops": [operation], "who": "you", "summary": "Paste clips", "expectedVersion": capture.version, "returnProject": true])
                } catch {
                    if self.timelineClipboard?.id == value.id { self.timelineClipboard = nil }
                    guard self.clipboardReplyOwnsUI(capture) else { return }
                    throw ReelBackend.APIError("The paste result could not be confirmed. Recheck the timeline and copy again before another paste. \(error.localizedDescription)")
                }
                let created: [String]
                do { created = try value.confirmedPasteIDs(reply, capture: capture) }
                catch {
                    if self.timelineClipboard?.id == value.id { self.timelineClipboard = nil }
                    guard self.clipboardReplyOwnsUI(capture) else { return }
                    throw ReelBackend.APIError("The paste result could not be confirmed. Recheck the timeline and copy again before another paste.")
                }
                guard self.clipboardReplyOwnsUI(capture), self.version == capture.version + 1 else { return }
                self.select(ids: Set(created), primary: created.first)
                self.emitHaptic(.commit); self.status = "Pasted \(value.count) clips"
            }
        } catch { status = error.localizedDescription }
    }
    // END NATIVE CLIPBOARD CONTROLLER

    func delete(ripple: Bool = false) {
        guard !selectedIDs.isEmpty else { return }
        edit(["op": ripple ? "ripple_delete" : "delete", "ids": selectedIDs.sorted()], expectedVersion: version, feedback: true)
    }
    func add(_ asset: NativeAsset) {
        let track = tracks.first { $0.kind == (asset.kind == "audio" ? "audio" : "video") && !$0.locked }
        guard let track else { return }
        edit(["op": "add_clip", "src": asset.id, "track": track.id, "start": time], feedback: true)
    }
    // BEGIN MATCH FRAME CONTROLLER
    var canRequestMatchFrame: Bool {
        !busy && !showingSource && !previewing && !scrubbing && !playing && session?.backend != nil && folder != nil &&
            project != nil && version >= 0 && selectedID.map { selectedIDs.contains($0) } == true
    }
    func captureMatchFrame() throws -> NativeMatchFrame.Capture {
        guard !busy, !showingSource, !previewing, !scrubbing, !playing, let backend = session?.backend, let folder, let project, let primary = selectedID, version >= 0 else {
            throw NativeMatchFrame.Failure("Open an idle timeline and select its source clip before matching a frame.")
        }
        let target = try NativeMatchFrame.target(project: project, composition: composition, selection: selectedIDs, primary: primary, at: time)
        let file = try NativeSourceFileIdentity(file: mediaURL(target.asset.id))
        return NativeMatchFrame.Capture(backend: backend, folder: folder.standardizedFileURL, context: generation, revision: projectRevision,
                                        version: version, composition: composition, selection: selectedIDs, primary: primary, timelineTime: time,
                                        projectText: project.text, target: target, file: file)
    }
    func matchFrame(_ capture: NativeMatchFrame.Capture) {
        do {
            guard !busy, !showingSource, !previewing, !scrubbing, !playing, session?.backend === capture.backend, folder?.standardizedFileURL == capture.folder,
                  generation == capture.context, projectRevision == capture.revision, version == capture.version,
                  composition == capture.composition, selectedIDs == capture.selection, selectedID == capture.primary,
                  time == capture.timelineTime, project?.text == capture.projectText else {
                throw NativeMatchFrame.Failure("The project, selection or playhead changed. Match the frame again.")
            }
            guard let project else { throw NativeMatchFrame.Failure("The project closed. Open it before matching a frame.") }
            let target = try NativeMatchFrame.target(project: project, composition: composition, selection: selectedIDs, primary: selectedID, at: time)
            let file = try NativeSourceFileIdentity(file: mediaURL(target.asset.id))
            guard target.asset.id == capture.target.asset.id, target.viewerSeconds == capture.target.viewerSeconds, file == capture.file else {
                throw NativeMatchFrame.Failure("The source changed. Restore or reimport it before matching a frame.")
            }
            openSource(target.asset)
            guard sourceError == nil, sourceAssetID == target.asset.id else {
                status = sourceError ?? "The source could not be opened."; return
            }
            guard sourceFileIdentity == capture.file else {
                clearSource()
                throw NativeMatchFrame.Failure("The source changed while opening. Match the frame again.")
            }
            seekSource(target.viewerSeconds)
            status = "Matched \(target.asset.name) at \(nativeTimecode(target.viewerSeconds, fps: sourceRange?.fps ?? fps))."
        } catch { status = error.localizedDescription }
    }
    // END MATCH FRAME CONTROLLER

    func openSource(_ asset: NativeAsset) {
        clearSource()
        showingSource = true
        guard project?.assets.contains(where: { $0.id == asset.id }) == true else { return }
        let sourceFPS = asset.fields.number("fps", fps)
        let rate = sourceFPS.isFinite && sourceFPS > 0 ? sourceFPS : fps
        guard let range = NativeSourceRange(duration: asset.kind == "image" ? 5 : asset.duration, fps: rate) else {
            sourceError = "This source has no valid duration or frame rate. Reimport it before marking a range."; return
        }
        sourceAssetID = asset.id; sourceRange = range; sourceLoading = true
        let token = sourceGeneration, root = folder
        do {
            let url = try mediaURL(asset.id)
            let identity = try NativeSourceFileIdentity(file: url)
            sourceFileIdentity = identity; sourceAssetSnapshot = JSON(any: asset.fields).text
            if asset.kind == "image" {
                sourceLoadTask = Task {
                    let image = await Task.detached(priority: .userInitiated) {
                        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil as CGImage? }
                        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 1920, kCGImageSourceCreateThumbnailWithTransform: true]
                        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
                    }.value
                    guard !Task.isCancelled, sourceGeneration == token, folder == root, sourceAssetID == asset.id else { return }
                    guard (try? NativeSourceFileIdentity(file: url)) == identity else { sourceLoading = false; sourceError = "The source changed while opening. Open it again."; return }
                    sourceImage = image; sourceLoading = false
                    if image == nil { sourceError = "This image could not be decoded." }
                }
            } else {
                let item = AVPlayerItem(url: url)
                sourcePlayer.replaceCurrentItem(with: item)
                sourceStatusObserver = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
                    Task { @MainActor [weak self] in
                        guard let self, self.sourceGeneration == token, self.folder == root, self.sourcePlayer.currentItem === item else { return }
                        if item.status == .readyToPlay { self.sourceLoading = false }
                        if item.status == .failed { self.sourceLoading = false; self.sourceError = item.error?.localizedDescription ?? "This media could not be played."; self.pauseSource() }
                    }
                }
                sourceTimeObserver = sourcePlayer.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1 / min(rate, 30), preferredTimescale: 60000), queue: .main) { [weak self] at in
                    Task { @MainActor [weak self] in
                        guard let self, self.sourceGeneration == token, self.folder == root, self.sourcePlaying, var range = self.sourceRange else { return }
                        range.seek(at.seconds); self.sourceRange = range
                        if range.time >= range.outPoint - range.frame / 2 { self.pauseSource(); self.seekSource(range.outPoint) }
                    }
                }
            }
        } catch { sourceLoading = false; sourceError = error.localizedDescription }
    }
    func seekSource(_ value: Double, exact: Bool = true) {
        pauseSource()
        guard var range = sourceRange else { return }
        range.seek(value); sourceRange = range
        guard sourceAsset?.kind != "image" else { return }
        sourcePlayer.currentItem?.cancelPendingSeeks()
        let tolerance = exact ? CMTime.zero : CMTime(seconds: range.frame * 2, preferredTimescale: 60000)
        sourcePlayer.seek(to: CMTime(seconds: range.time, preferredTimescale: 60000), toleranceBefore: tolerance, toleranceAfter: tolerance)
    }
    func markSourceIn(_ value: Double? = nil) { guard var range = sourceRange else { return }; range.markIn(value); sourceRange = range }
    func markSourceOut(_ value: Double? = nil) { guard var range = sourceRange else { return }; range.markOut(value); sourceRange = range }
    func clearSourceMarks() { guard var range = sourceRange else { return }; range.clearMarks(); sourceRange = range }
    func toggleSourcePlayback() {
        if sourcePlaying { pauseSource(); return }
        guard let range = sourceRange, !sourceLoading, sourceError == nil, sourceAsset?.kind != "image" else { return }
        let token = sourceGeneration
        if range.time < range.inPoint || range.time >= range.outPoint - range.frame / 2 {
            seekSource(range.inPoint)
            let playbackToken = sourcePlaybackGeneration
            sourcePlayer.seek(to: CMTime(seconds: range.inPoint, preferredTimescale: 60000), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] completed in
                Task { @MainActor [weak self] in
                    guard let self, completed, self.sourceGeneration == token, self.sourcePlaybackGeneration == playbackToken, self.showingSource else { return }
                    self.sourcePlaying = true; self.sourcePlayer.play()
                }
            }
        } else { sourcePlaying = true; sourcePlayer.play() }
    }
    func pauseSource() { sourcePlaybackGeneration = UUID(); sourcePlayer.pause(); sourcePlaying = false }
    func clearSource() {
        sourceGeneration = UUID(); sourceLoadTask?.cancel(); sourceLoadTask = nil
        pauseSource(); sourceStatusObserver = nil
        if let sourceTimeObserver { sourcePlayer.removeTimeObserver(sourceTimeObserver) }; sourceTimeObserver = nil
        sourcePlayer.currentItem?.cancelPendingSeeks(); sourcePlayer.replaceCurrentItem(with: nil)
        sourceAssetID = nil; sourceRange = nil; sourceImage = nil; sourceLoading = false; sourceError = nil; showingSource = false
        sourceFileIdentity = nil; sourceAssetSnapshot = nil
    }
    func placeSource(_ mode: String) {
        guard let asset = sourceAsset, sourceAssetSnapshot == JSON(any: asset.fields).text,
              let url = try? mediaURL(asset.id), let identity = try? NativeSourceFileIdentity(file: url), identity == sourceFileIdentity else {
            status = "The source changed. Open it again before placing it."; return
        }
        guard let range = sourceRange,
              let operation = range.operation(mode, source: asset.id, kind: asset.kind, hasAudio: asset.fields.flag("hasAudio"), tracks: tracks.map(\.fields), at: time) else {
            status = mode == "connect" ? "Connect needs unlocked upper video and audio tracks for this source." : "Choose a source and an unlocked destination track."; return
        }
        pauseSource(); edit(operation, expectedVersion: version, feedback: true); showingSource = false
    }
    func select(_ clip: NativeClip) { select(id: clip.id); seek(clip.start) }
    func receiptSelection(_ clip: NativeChangeReceipt.Clip) -> NativeChangeReceipt.Selection? {
        project.flatMap { NativeChangeReceipt.selection(for: clip, in: $0.fields) }
    }
    func selectReceiptClip(_ clip: NativeChangeReceipt.Clip) {
        guard let selection = receiptSelection(clip) else { return }
        composition = selection.composition
        select(id: selection.clipID)
        seek(selection.start)
    }
    func seek(_ at: Double) { discardRenderPreview(redraw: false); if playing { pause() }; time = max(0, min(max(duration, 0), (at * fps).rounded() / fps)); requestFrame() }
    func scrub(_ at: Double, finished: Bool = false) {
        if !scrubbing || finished { scrubContext = nil }
        if finished { scrubReleaseID = scrubInteractionID; scrubInteractionID = nil }
        scrubbing = !finished
        seek(at)
        scrubReleaseID = nil
    }
    func step(_ frames: Double) { pause(); seek(time + frames / fps) }
    func togglePlayback() { playing ? pause() : play() }
    func pause() {
        let wasPlaying = playing
        playing = false; playTask?.cancel(); playTask = nil; audioPrepareTask?.cancel(); audioPrepareTask = nil; playbackAudio.stop()
        busAudioMeters = [:]
        if wasPlaying { requestFrame() }
    }
    func play() {
        discardRenderPreview(redraw: false)
        pauseSource()
        guard duration > 0, let session, let backend = session.backend, let root = session.folder else { return }
        if time >= duration { seek(0) }
        playing = true
        let token = generation, folder = ProjectFolder(root: root), selectedComp = composition, capturedVersion = version
        #if os(iOS)
        var chunk = 8.0
        #else
        var chunk = 20.0
        #endif
        #if DEBUG
        if let testChunk = playbackChunkForTesting { chunk = testChunk }
        #endif
        let chunkLength = chunk
        #if DEBUG
        audioPreparationSeconds = []; audioPreviewHistorySeconds = []
        #endif
        playTask = Task {
            do {
                status = "Preparing audio preview"
                let from = time, firstEnd = min(duration, from + chunkLength)
                let audio = try await prepareAudio(backend, from: from, to: firstEnd, comp: selectedComp)
                guard !Task.isCancelled, generation == token, session.backend === backend, self.folder == root, composition == selectedComp,
                      version == capturedVersion, audio.version == capturedVersion, audio.composition == selectedComp, playing else { NativePlaybackAudio.removeOwned(audio.url, folder: folder); return }
                do { try playbackAudio.load(audio, start: from, end: firstEnd, ownedIn: folder, contextID: token) }
                catch { NativePlaybackAudio.removeOwned(audio.url, folder: folder); throw error }
                for _ in 0..<2 where playbackAudio.end < duration {
                    let nextFrom = playbackAudio.end, nextEnd = min(duration, nextFrom + chunkLength)
                    let next = try await prepareAudio(backend, from: nextFrom, to: nextEnd, comp: selectedComp)
                    guard !Task.isCancelled, generation == token, session.backend === backend, self.folder == root, composition == selectedComp,
                          version == capturedVersion, next.version == capturedVersion, next.composition == selectedComp, playing else { NativePlaybackAudio.removeOwned(next.url, folder: folder); return }
                    do { try playbackAudio.queue(next, start: nextFrom, end: nextEnd, ownedIn: folder) }
                    catch { NativePlaybackAudio.removeOwned(next.url, folder: folder); throw error }
                }
                try playbackAudio.play(); status = ""
                audioPrepareTask = Task {
                    do {
                        while !Task.isCancelled, playing, generation == token, session.backend === backend, composition == selectedComp, version == capturedVersion, self.folder == root, playbackAudio.end < duration {
                            if playbackAudio.end - (playbackAudio.time ?? from) > chunkLength * 3 { try await Task.sleep(for: .milliseconds(20)); continue }
                            let nextFrom = playbackAudio.end, nextEnd = min(duration, nextFrom + chunkLength)
                            let next = try await prepareAudio(backend, from: nextFrom, to: nextEnd, comp: selectedComp)
                            guard !Task.isCancelled, generation == token, session.backend === backend, self.folder == root, composition == selectedComp,
                                  version == capturedVersion, next.version == capturedVersion, next.composition == selectedComp, playing else { NativePlaybackAudio.removeOwned(next.url, folder: folder); return }
                            do { try playbackAudio.queue(next, start: nextFrom, end: nextEnd, ownedIn: folder) }
                            catch { NativePlaybackAudio.removeOwned(next.url, folder: folder); throw error }
                        }
                    } catch is CancellationError { }
                    catch { guard generation == token, session.backend === backend else { return }; status = error.localizedDescription; pause() }
                }
                while !Task.isCancelled, playing, generation == token, session.backend === backend, composition == selectedComp, version == capturedVersion, self.folder == root {
                    let at = playbackAudio.time ?? from
                    time = at
                    if let meters = playbackAudio.busMeters { receiveBusAudioMeters(meters) }
                    if !rendering { requestFrame() }
                    if playbackAudio.finished {
                        if playbackAudio.end < duration { status = "Audio preview could not keep up. Playback stopped at the buffered position." }
                        else { time = duration }
                        pause(); requestFrame(); break
                    }
                    try await Task.sleep(for: .milliseconds(16))
                }
            } catch is CancellationError { }
            catch { guard generation == token, session.backend === backend else { return }; status = error.localizedDescription; pause() }
        }
    }

    func receiveBusAudioMeters(_ snapshot: NativeBusAudioMeterSnapshot) {
        guard playing, snapshot.contextID == generation, snapshot.version == version, snapshot.composition == composition else {
            return
        }
        if snapshot.available { busAudioMeters = snapshot.meters }
        else if !busAudioMeters.isEmpty { busAudioMeters = [:] }
    }

    private func prepareAudio(_ backend: ReelBackend, from: Double, to: Double, comp: String?) async throws -> ReelAudioPreview {
        #if DEBUG
        let started = Date(), token = generation
        #endif
        let result = try await backend.renderAudioPreview(from: from, to: to, comp: comp)
        #if DEBUG
        if generation == token { audioPreparationSeconds.append(Date().timeIntervalSince(started)); audioPreviewHistorySeconds.append(result.historySeconds) }
        #endif
        return result
    }

    func beginRenderPreview(renderedVersion: Int) -> NativeRenderPreviewCapture? {
        guard renderedVersion == version, version >= 0, folder != nil, project != nil, renderer != nil,
              !playing, !scrubbing, !busy, time.isFinite, displayedTime == time,
              displayedVersion == version, displayedRevision == projectRevision, displayedComposition == composition,
              displayedFolder == folder, displayedGeneration == generation, displayedPreviewID == nil else { return nil }
        discardRenderPreview(redraw: false)
        let capture = NativeRenderPreviewCapture(id: UUID(), generation: generation, revision: projectRevision,
                                                  folder: folder!, version: version, composition: composition, selection: selectedIDs, time: time)
        previewCapture = capture
        previewOwnershipID = capture.id
        return capture
    }

    func renderPreviewMatches(_ capture: NativeRenderPreviewCapture) -> Bool {
        previewCapture?.id == capture.id && capture.matches(generation: generation, revision: projectRevision, folder: folder, version: version,
                                                           composition: composition, selection: selectedIDs, time: time) && !playing && !scrubbing && !busy
    }

    func renderPreviewCommitMatches(_ capture: NativeRenderPreviewCapture) -> Bool {
        previewOwnershipID == capture.id &&
            (previewCapture == nil || previewCapture?.id == capture.id) &&
            project != nil && renderer != nil && metalFrame != nil && renderError == nil &&
            (displayedPreviewID == nil || displayedPreviewID == capture.id) &&
            capture.matches(generation: generation, revision: projectRevision, folder: folder, version: version,
                            composition: composition, selection: selectedIDs, time: time) &&
            !playing && !scrubbing && !busy && !showingSource
    }

    func viewerGeometryIsCurrent(capture: NativeRenderPreviewCapture? = nil) -> Bool {
        guard metalFrame != nil, project != nil, renderer != nil, folder != nil, renderError == nil, version >= 0, time.isFinite, displayedTime == time,
              displayedVersion == version, displayedRevision == projectRevision, displayedComposition == composition,
              displayedFolder == folder, displayedGeneration == generation,
              !playing, !scrubbing, !busy, !showingSource else { return false }
        if let capture {
            return renderPreviewMatches(capture) && (displayedPreviewID == nil || displayedPreviewID == capture.id)
        }
        return previewCapture == nil && previewOperations == nil && displayedPreviewID == nil && !rendering
    }

    func captureDisplayedCommittedFrame() -> NativeDisplayedFrameCapture? {
        guard viewerGeometryIsCurrent(), let folder, let metalFrame, width > 0, height > 0,
              width.isFinite, height.isFinite, let image = try? metalFrame.cgImage() else { return nil }
        let context = NativeRenderPreviewCapture(id: UUID(), generation: generation, revision: projectRevision,
                                                folder: folder, version: version, composition: composition,
                                                selection: selectedIDs, time: time)
        let name = image.colorSpace?.name.map { $0 as String } ?? "Unspecified display color space"
        return NativeDisplayedFrameCapture(context: context, image: image, renderedFrame: metalFrame,
                                           canvasAspect: width / height, colorSpace: name, selectedID: selectedID)
    }

    func frameCaptureMatches(_ capture: NativeDisplayedFrameCapture) -> Bool {
        viewerGeometryIsCurrent() && metalFrame === capture.renderedFrame && selectedID == capture.selectedID &&
            capture.context.matches(generation: generation, revision: projectRevision, folder: folder, version: version,
                                    composition: composition, selection: selectedIDs, time: time)
    }

    func viewerComparisonMatches(_ comparison: NativeViewerComparison) -> Bool {
        comparison.context.generation == generation && comparison.context.folder == folder &&
            comparison.context.composition == composition && comparison.canvasAspect.isFinite &&
            abs(comparison.canvasAspect - width / height) < 0.000001 && !showingSource
    }

    @discardableResult
    func preview(_ operations: [[String: Any]], capture: NativeRenderPreviewCapture) -> Bool {
        guard previewCapture?.id == capture.id,
              capture.matches(generation: generation, revision: projectRevision, folder: folder, version: version,
                              composition: composition, selection: selectedIDs, time: time), !playing, !scrubbing, !busy,
              operations.count <= 256, JSONSerialization.isValidJSONObject(operations),
              operations.allSatisfy({ ["update", "node_update", "keyframe", "keyframe_ease"].contains($0.string("op")) }) else {
            discardRenderPreview(capture); return false
        }
        if operations.isEmpty { previewOperations = nil; previewing = false; requestFrame(); return true }
        let scoped = operations.map { edit -> [String: Any] in var result = edit; result["comp"] = capture.composition as Any? ?? NSNull(); return result }
        let text = JSON(any: scoped).text
        guard text.utf8.count <= 256 * 1024 else { discardRenderPreview(capture); return false }
        previewOperations = text; previewing = true; requestFrame()
        return true
    }

    func discardRenderPreview(_ capture: NativeRenderPreviewCapture? = nil, redraw: Bool = true) {
        if let capture, previewCapture?.id != capture.id { return }
        viewerColorPicker = nil
        let hadPreview = previewOperations != nil || displayedPreviewID != nil
        previewCapture = nil; previewOperations = nil; previewing = false
        if redraw, hadPreview { requestFrame() }
    }

    func requestFrame() {
        guard let project, let renderer, let folder else { return }
        let queuedAt = frameClock.now
        let token = UUID(); renderGeneration = token
        #if DEBUG
        scrubLastIntentToken = token
        #endif
        rendering = true
        let draft = scrubbing || playing || previewOperations != nil
        #if os(iOS)
        let defaultWidth = draft ? 320 : 960
        #else
        let defaultWidth = draft ? 480 : 1280
        #endif
        let windowWidth = previewOperations == nil ? nil : viewerColorWindow?.previewWidth
        let adaptiveScrub = scrubbing && !playing && previewOperations == nil && panel != .color
        if adaptiveScrub {
            let context = ScrubContext(generation: generation, folder: folder, version: version, revision: projectRevision, comp: composition)
            if scrubContext != context {
                scrubContext = context; scrubInteractionID = UUID()
                scrubQuality = ScrubQualityPolicy(widths: scrubQuality.widths)
            }
        }
        let width = windowWidth ?? (adaptiveScrub ? scrubQuality.width : defaultWidth)
        let scrubID = adaptiveScrub ? scrubInteractionID : scrubReleaseID
        #if DEBUG
        if let replaced = pendingFrame { recordScrubTiming(replaced, outcome: "coalesced") }
        #endif
        let color = panel == .color
        let renderProject = color ? project : (draft ? previewProject(project) : project)
        pendingFrame = FrameRequest(token: token, generation: generation, folder: folder, project: renderProject.text, version: version, revision: projectRevision, at: time, comp: composition, width: width, queuedAt: queuedAt, scrubID: scrubID, draft: draft, color: color, hdrScopes: hdrScopes, previewID: previewCapture?.id, operations: previewOperations)
        guard renderTask == nil else { return }
        let workerID = renderWorkerID
        renderTask = Task {
            while let queued = pendingFrame, !Task.isCancelled, renderWorkerID == workerID {
                pendingFrame = nil
                var request = queued
                if adaptiveScrubMatches(request) { request.width = scrubQuality.width }
                let started = request.scrubID == nil ? nil : frameClock.now
                do {
                    let result: ReelRenderedFrame
                    if let operations = request.operations { result = try await renderer.renderPreview(project: request.project, operations: operations, at: request.at, comp: request.comp, width: request.width) }
                    else { result = try await renderer.render(project: request.project, at: request.at, comp: request.comp, width: request.width) }
                    #if DEBUG
                    let rendered = request.scrubID == nil ? nil : frameClock.now
                    #endif
                    // Scopes measure the whole frame on a background queue after it is shown.
                    var scopeSource: ReelRenderedFrame?
                    if request.color && scopesShown {
                        if request.hdrScopes {
                            if let operations = request.operations { scopeSource = try await renderer.renderHDRPreview(project: request.project, operations: operations, at: request.at, comp: request.comp, width: 320) }
                            else { scopeSource = try await renderer.renderHDR(project: request.project, at: request.at, comp: request.comp, width: 320) }
                        } else { scopeSource = result }
                    }
                    if !Task.isCancelled, renderWorkerID == workerID, generation == request.generation, self.folder == request.folder,
                       version == request.version, projectRevision == request.revision, composition == request.comp, previewCapture?.id == request.previewID,
                       request.color == (panel == .color), request.hdrScopes == hdrScopes, renderGeneration == request.token || (scrubbing && request.draft),
                       request.scrubID == nil || !request.draft || request.scrubID == scrubInteractionID {
                        metalFrame = result
                        frame = panel == .color || readbackFrames ? try result.cgImage() : nil
                        if let scopeSource { measureScopes(scopeSource, generation: request.generation) } else { clearScopes() }
                        displayedTime = request.at; displayedPreviewID = request.operations == nil ? nil : request.previewID; displayedVersion = request.version; displayedRevision = request.revision; displayedComposition = request.comp; displayedFolder = request.folder; displayedGeneration = request.generation; paintedFrames += 1
                        renderError = nil
                        if let started {
                            let published = frameClock.now
                            if adaptiveScrubMatches(request) { scrubQuality.completed(seconds: frameSeconds(from: started, to: published), width: request.width) }
                            #if DEBUG
                            recordScrubTiming(request, outcome: "published", started: started, rendered: rendered, published: published)
                            #endif
                        }
                    } else {
                        #if DEBUG
                        recordScrubTiming(request, outcome: "superseded", started: started, rendered: rendered)
                        #endif
                    }
                } catch {
                    if !Task.isCancelled, renderWorkerID == workerID, adaptiveScrubMatches(request) { scrubQuality.failed() }
                    #if DEBUG
                    recordScrubTiming(request, outcome: "failed", started: started)
                    #endif
                    if !Task.isCancelled, renderGeneration == request.token, renderWorkerID == workerID, generation == request.generation, self.folder == request.folder, version == request.version,
                       projectRevision == request.revision, composition == request.comp, previewCapture?.id == request.previewID { renderError = error.localizedDescription }
                }
            }
            if renderWorkerID == workerID { rendering = false; renderTask = nil }
        }
    }

    func releasePreview() {
        discardRenderPreview(redraw: false); projectRevision = UUID()
        previewOwnershipID = nil
        viewerComparison = nil
        clearSource()
        pause(); renderTask?.cancel(); renderTask = nil; pendingFrame = nil; renderWorkerID = UUID(); renderGeneration = UUID(); rendering = false; frame = nil; metalFrame = nil; clearScopes(); displayedTime = nil; displayedPreviewID = nil; displayedVersion = nil; displayedRevision = nil; displayedComposition = nil; displayedFolder = nil; displayedGeneration = nil; scrubbing = false
        if let renderer { Task { await renderer.releaseCaches() } }
    }

    /// Called when the project becomes writable again, for example after Files finishes opening it.
    func projectWritable() {
        if status.hasPrefix("Proxy unavailable"), status.contains("read-only") { status = "" }
        prepareProxies()
    }

    private func prepareProxies() {
        // Proxies are written into the project folder. While Files is still opening the document
        // the write would fail, so wait for projectWritable() instead of reporting an error.
        guard useProxies, hasCapability("proxy", "available"), proxyTask == nil, projectReadOnlyReason == nil else { return }
        let token = generation
        proxyTask = Task {
            var retry = false
            defer { if generation == token { proxyTask = nil; if retry { prepareProxies() } } }
            for asset in project?.assets ?? [] where asset.kind == "video" && proxies[asset.id] == nil {
                let requestedVersion = version
                do {
                    try Task.checkCancellation()
                    let result = try await call("/api/proxy", ["src": asset.id])
                    guard generation == token else { return }
                    let path = result.string("path")
                    guard !path.isEmpty else { continue }
                    proxies[asset.id] = path; requestFrame()
                } catch is CancellationError { return }
                catch {
                    guard generation == token else { return }
                    // Access was withdrawn during the request; projectWritable() retries this asset.
                    if projectReadOnlyReason != nil { return }
                    // An edit or import during the request makes the backend reject it as stale. Proxies
                    // depend only on the source, so stay quiet; the refresh after that edit retries.
                    if version != requestedVersion { retry = true; continue }
                    status = "Proxy unavailable for \(asset.name): \(error.localizedDescription)"
                }
            }
        }
    }

    private func previewProject(_ project: NativeProject) -> NativeProject {
        guard useProxies, !proxies.isEmpty else { return project }
        func substitute(_ value: Any) -> Any {
            if let fields = value as? [String: Any] {
                return fields.mapValues { substitute($0) }.merging(fields["src"].flatMap { $0 as? String }.flatMap { proxies[$0] }.map { ["src": $0] } ?? [:]) { _, replacement in replacement }
            }
            if let values = value as? [Any] { return values.map(substitute) }
            return value
        }
        var fields = substitute(project.fields) as? [String: Any] ?? project.fields
        var assets = project.fields.dictionary("assets")
        for (source, proxy) in proxies { assets[proxy] = assets[source] }
        fields["assets"] = assets
        return NativeProject(fields: fields)
    }

    func hasCapability(_ group: String, _ key: String) -> Bool { capabilities.dictionary(group).flag(key) }
    func mediaURL(_ path: String) throws -> URL {
        guard let folder else { throw ReelBackend.APIError("Open a project first.") }
        return try ProjectFolder(root: folder).resolve(path)
    }
}
