import Foundation
import ReelKit
import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

// BEGIN SHORTS WORKFLOW
/// A review captures the exact inputs. Creation can only reuse that reviewed body.
enum NativeShortsWorkflow {
    struct Navigation: Equatable {
        let composition: String?
        let primary: String?
        let selection: Set<String>
        let panel: String
        let source: String?
        let showingSource: Bool
        @discardableResult
        func openCreated(_ first: String, current: Navigation, open: (String) -> Void) -> Bool {
            guard self == current, !first.isEmpty else { return false }
            open(first); return true
        }
    }
    struct Settings: Equatable {
        let format: String
        let captions: Bool
        let captionStyle: String
        var dimensions: (Int, Int) {
            format == "square" ? (1080, 1080) : format == "landscape" ? (1920, 1080) : (1080, 1920)
        }
    }
    struct Capture {
        let record: [String: Any]
        let data: Data
        init(_ record: [String: Any]) throws {
            guard let source = record["src"] as? String, !source.isEmpty,
                  let locale = record["locale"] as? String, !locale.isEmpty,
                  let folder = record["folder"] as? String, !folder.isEmpty,
                  record["backend"] is String, let version = record["version"] as? Int, version >= 0,
                  let revision = record["revision"] as? Int, revision > 0,
                  let fingerprint = record["fingerprint"] as? String, !fingerprint.isEmpty,
                  ["complete", "ready", "partial"].contains(record.string("status")), record["dirty"] as? Bool != true,
                  record["current"] as? Bool == true, record["file"] is [String: Any], record["project"] is [String: Any],
                  let words = record["words"] as? [[String: Any]], !words.isEmpty,
                  JSONSerialization.isValidJSONObject(record) else {
                throw ReelBackend.APIError("Load and save a current transcript before reviewing short clips.")
            }
            self.record = record
            data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        }
        func matches(_ current: Capture) -> Bool { data == current.data }
        func verifyTranscript(_ response: [String: Any]) throws {
            guard ["complete", "ready", "partial"].contains(response.string("status")),
                  response["revision"] as? Int == record["revision"] as? Int,
                  response["fingerprint"] as? String == record["fingerprint"] as? String,
                  response["src"] as? String == record["src"] as? String,
                  response["locale"] as? String == record["locale"] as? String,
                  JSON(any: response.objects("words").map { ["t": $0.number("t"), "end": $0.number("end"), "text": $0.string("text")] }).text == JSON(any: record["words"] ?? []).text else {
                throw ReelBackend.APIError("The saved transcript or source changed. Recheck it, then review the clips again.")
            }
        }
    }
    struct Review {
        let capture: Capture
        let settings: Settings
        let body: [String: Any]
        let compositions: [[String: Any]]
        init(capture: Capture, settings: Settings, body: [String: Any], response: [String: Any]) throws {
            let ranges = body.objects("ranges"), compositions = response.objects("comps")
            guard body["apply"] as? Bool == false, response["version"] as? Int == capture.record["version"] as? Int,
                  response["sourceFingerprint"] as? String == capture.record["fingerprint"] as? String,
                  response["transcriptRevision"] as? Int == capture.record["revision"] as? Int,
                  !response.objects("ops").isEmpty, !ranges.isEmpty, compositions.count == ranges.count else {
                throw ReelBackend.APIError("The backend did not return a current short-clip review. Review again before creating.")
            }
            for (range, comp) in zip(ranges, compositions) {
                guard !comp.string("id").isEmpty, comp.string("name") == range.string("name"),
                      abs(comp.number("from") - range.number("from")) < 0.0001,
                      abs(comp.number("to") - range.number("to")) < 0.0001,
                      abs(comp.number("duration") - (range.number("to") - range.number("from"))) < 0.0001 else {
                    throw ReelBackend.APIError("The planned ranges changed. Review them again before creating.")
                }
            }
            self.capture = capture; self.settings = settings; self.body = body; self.compositions = compositions
        }
        func creationBody(current: Capture, settings: Settings) throws -> [String: Any] {
            guard capture.matches(current), self.settings == settings else {
                throw ReelBackend.APIError("The project, source or clip options changed. Review the compositions again.")
            }
            var next = body; next["apply"] = true
            return next
        }
    }
    /// The shared JavaScript planner limits names to 200 UTF-16 code units.
    /// Keep complete Unicode scalars so its truncation cannot change the reviewed name.
    static func normalizedName(_ input: String, index: Int) -> String {
        let name = input.trimmingCharacters(in: .whitespacesAndNewlines)
        var result = "", units = 0
        for scalar in name.unicodeScalars {
            let part = String(scalar), length = part.utf16.count
            guard length <= 200 - units else { break }
            result += part; units += length
        }
        return result.isEmpty ? "Clip \(index + 1)" : result
    }
    static func reviewBody(capture: Capture, ranges: [[String: Any]], settings: Settings) throws -> [String: Any] {
        guard ["vertical", "square", "landscape"].contains(settings.format),
              ["plain", "boxed", "karaoke", "word"].contains(settings.captionStyle),
              !ranges.isEmpty, ranges.count <= 20 else { throw ReelBackend.APIError("Choose 1 to 20 clips and a supported output format and caption style.") }
        let project = capture.record.dictionary("project"), source = capture.record.string("src")
        let duration = project.dictionary("assets").dictionary(source).number("duration")
        guard duration.isFinite, duration > 0 else { throw ReelBackend.APIError("The source has no finite duration. Recheck the media before building clips.") }
        let clean = try ranges.enumerated().map { index, range -> [String: Any] in
            let from = range.number("from", .nan), to = range.number("to", .nan)
            guard from.isFinite, to.isFinite, from >= 0, to > from, to - from <= 600, to <= duration + 0.0001 else {
                throw ReelBackend.APIError("Clip \(index + 1) must stay inside the source and last at most 600 seconds.")
            }
            return ["from": from, "to": to, "name": normalizedName(range.string("name"), index: index)]
        }
        let size = settings.dimensions
        return ["src": source, "locale": capture.record.string("locale"), "ranges": clean, "width": size.0, "height": size.1,
                "captionStyle": settings.captionStyle, "captions": settings.captions, "words": settings.captions ? capture.record.objects("words") : [],
                "apply": false, "expectedVersion": capture.record["version"]!, "expectedSourceFingerprint": capture.record["fingerprint"]!,
                "expectedTranscriptRevision": capture.record["revision"]!]
    }
}
// BEGIN CAPTION WORKFLOW
/// Caption creation uses the saved words and exact project captured by the preview.
enum NativeCaptionWorkflow {
    struct Settings: Equatable {
        var preset = "boxed"
        var maxChars = 42
        var maxLines = 2
        var burnIn = true
        var onlySelected = false
        var track = "C1"
        var replace = false
    }
    static func reviewBody(capture: NativeShortsWorkflow.Capture, settings: Settings) throws -> [String: Any] {
        guard ["plain", "boxed", "karaoke", "word"].contains(settings.preset), (16...80).contains(settings.maxChars),
              (1...3).contains(settings.maxLines), !settings.track.isEmpty else {
            throw ReelBackend.APIError("Choose a caption style, 16 to 80 characters per line, 1 to 3 lines, and a caption track.")
        }
        let tracks = capture.record.objects("tracks"), target = tracks.first { $0.string("id") == settings.track }
        guard target == nil || (target?.string("kind") == "caption" && target?["locked"] as? Bool != true),
              !settings.replace || target != nil else { throw ReelBackend.APIError("Choose an unlocked caption track. Replacement requires an existing track.") }
        var body: [String: Any] = ["src": capture.record.string("src"), "locale": capture.record.string("locale"),
            "words": capture.record.objects("words"), "comp": capture.record["comp"] ?? NSNull(), "style": settings.preset,
            "maxChars": settings.maxChars, "maxLines": settings.maxLines, "burnIn": settings.burnIn,
            "track": settings.track, "replace": settings.replace, "apply": false, "expectedVersion": capture.record["version"]!,
            "expectedSourceFingerprint": capture.record["fingerprint"]!, "expectedTranscriptRevision": capture.record["revision"]!]
        if settings.onlySelected {
            guard let id = capture.record["id"] as? String, !id.isEmpty else { throw ReelBackend.APIError("Select a clip for captioning.") }
            body["id"] = id
        }
        return body
    }
    static func createdTrackIsLoaded(project: [String: Any], composition: String?, track: String, count: Int) -> Bool {
        let scope: [String: Any]
        if let composition {
            guard let destination = project.dictionary("comps")[composition] as? [String: Any] else { return false }
            scope = destination
        } else { scope = project }
        return scope.objects("tracks").contains { $0.string("id") == track && $0.string("kind") == "caption" && $0.objects("clips").count >= count }
    }
    struct Review {
        let capture: NativeShortsWorkflow.Capture
        let settings: Settings
        let body: [String: Any]
        let items: [[String: Any]]
        let warnings: [String]
        init(capture: NativeShortsWorkflow.Capture, settings: Settings, body: [String: Any], response: [String: Any]) throws {
            let items = response.objects("items")
            guard body["apply"] as? Bool == false, response["version"] as? Int == capture.record["version"] as? Int,
                  response["src"] as? String == capture.record["src"] as? String,
                  response["sourceFingerprint"] as? String == capture.record["fingerprint"] as? String,
                  response["transcriptRevision"] as? Int == capture.record["revision"] as? Int,
                  JSON(any: response["comp"] ?? NSNull()).text == JSON(any: body["comp"] ?? NSNull()).text,
                  !items.isEmpty, items.allSatisfy({ item in
                      let from = item.number("t", .nan), to = item.number("end", .nan)
                      return from.isFinite && to.isFinite && from >= 0 && to > from && !item.string("text").isEmpty
                  }) else { throw ReelBackend.APIError("The backend did not return a current caption preview. Preview again before creating captions.") }
            self.capture = capture; self.settings = settings; self.body = body; self.items = items
            warnings = response["warnings"] as? [String] ?? []
        }
        func creationBody(current: NativeShortsWorkflow.Capture, settings: Settings) throws -> [String: Any] {
            guard capture.matches(current), self.settings == settings else { throw ReelBackend.APIError("The project, transcript, selection or caption options changed. Preview captions again.") }
            var body = body; body["apply"] = true; return body
        }
    }
}
// END CAPTION WORKFLOW
enum NativeTimedTranscriptWorkflow {
    struct Capture: Identifiable {
        let id = UUID()
        let record: [String: Any]
        let data: Data
        init(_ record: [String: Any]) throws {
            guard let revision = record["revision"] as? Int, revision >= 0,
                  record["version"] is Int, !record.string("fingerprint").isEmpty,
                  !record.string("src").isEmpty, !record.string("locale").isEmpty,
                  record.number("duration").isFinite, record.number("duration") > 0,
                  JSONSerialization.isValidJSONObject(record) else {
                throw ReelBackend.APIError("Load the current transcript for a source with a finite duration before importing.")
            }
            self.record = record
            data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        }
        func matches(_ current: Capture) -> Bool { data == current.data }
        func verifySaved(_ saved: [String: Any]) throws {
            guard saved["src"] as? String == record["src"] as? String,
                  saved["locale"] as? String == record["locale"] as? String,
                  saved["revision"] as? Int == record["revision"] as? Int, saved["status"] as? String != "stale" else {
                throw ReelBackend.APIError("The saved transcript changed. Preview the file again.")
            }
        }
        var basis: [String: Any] {
            ["expectedVersion": record["version"]!, "expectedSourceFingerprint": record["fingerprint"]!]
        }
        var request: [String: Any] {
            basis.merging(["src": record["src"]!, "locale": record["locale"]!, "expectedTranscriptRevision": record["revision"]!]) { _, new in new }
        }
    }
    struct Review {
        let capture: Capture
        let words: [[String: Any]]
        let warnings: [String]
        init(capture: Capture, response: [String: Any]) throws {
            guard response["version"] as? Int == capture.record["version"] as? Int,
                  response["src"] as? String == capture.record["src"] as? String,
                  response["locale"] as? String == capture.record["locale"] as? String,
                  response["sourceFingerprint"] as? String == capture.record["fingerprint"] as? String,
                  response["transcriptRevision"] as? Int == capture.record["revision"] as? Int else {
                throw ReelBackend.APIError("The source or saved transcript changed. Preview the file again.")
            }
            self.capture = capture
            words = response.objects("words")
            guard !words.isEmpty else { throw ReelBackend.APIError("The imported file has no timed words.") }
            warnings = response["warnings"] as? [String] ?? []
        }
        func verify(current: Capture) throws {
            guard capture.matches(current) else { throw ReelBackend.APIError("The project, source, saved transcript or draft changed. Preview the file again.") }
        }
    }
}
// END SHORTS WORKFLOW

// BEGIN TRANSCRIPT CONTROLLER
struct NativeTranscriptWord: Identifiable {
    let id: Int
    var from: Double
    var to: Double
    var text: String
    var json: [String: Any] { ["t": from, "end": to, "text": text] }
}

enum NativeTranscriptTiming {
    static func edited(_ words: [NativeTranscriptWord], index: Int, from: Double, to: Double, duration: Double) throws -> NativeTranscriptWord {
        guard words.indices.contains(index), duration.isFinite, duration > 0,
              from.isFinite, to.isFinite, from >= 0, to > from, to <= duration else {
            throw ReelBackend.APIError("Word timing must use finite source seconds, start before its end, and stay inside the source.")
        }
        guard (index == 0 || from >= words[index - 1].from),
              (index == words.count - 1 || from <= words[index + 1].from) else {
            throw ReelBackend.APIError("Keep word starts in transcript order. Edit the neighboring word first if needed.")
        }
        var word = words[index]; word.from = from; word.to = to
        return word
    }
}

struct NativeTranscriptIdentity: Equatable {
    let source: String
    let locale: String
}

@MainActor
private final class NativeTranscriptRecoverySession {
    private let backend: ReelBackend
    private let owner: NativeTranscriptIdentity
    private let sessionID = UUID().uuidString.lowercased()
    private var basis: [String: Any]?
    private var head: String?
    private var sequence = 0
    private var pending: [[String: Any]]?
    private var task: Task<Void, Never>?
    private var error: Error?
    var status: (String) -> Void
    init(backend: ReelBackend, owner: NativeTranscriptIdentity, status: @escaping (String) -> Void) { self.backend = backend; self.owner = owner; self.status = status }
    var capturedBasis: [String: Any]? { basis }
    var backendID: ObjectIdentifier { ObjectIdentifier(backend) }
    func capture(_ context: [String: Any], revision: Any?, fingerprint: String?) {
        guard pending == nil, task == nil, head == nil || error != nil else { return }
        if error != nil {
            if let observed = context.objects("offers").first(where: { $0["sessionID"] as? String == sessionID }), let observedID = observed["id"] as? String, let observedSequence = observed["sequence"] as? Int { head = observedID; sequence = observedSequence }
            error = nil
        }
        guard let value = context["basis"] as? [String: Any], let actual = value["revision"] as? Int, actual == revision as? Int,
              value["fingerprint"] as? String == (fingerprint ?? "") else { basis = nil; status("Recheck the saved transcript before creating a recovery copy."); return }
        basis = value
    }
    private func request(_ action: String, _ extra: [String: Any]) async throws -> [String: Any] {
        let body = extra.merging(["src": owner.source, "locale": owner.locale]) { _, owner in owner }
        let response = try await backend.handle(method: "POST", path: "/api/transcript/drafts/" + action, body: JSON(any: body).text)
        return try JSON.parse(response.text) as? [String: Any] ?? [:]
    }
    func update(_ words: [NativeTranscriptWord]) {
        guard basis != nil else { status("No current recovery identity. Recheck or save your corrections."); return }
        pending = words.map(\.json); pump()
    }
    private func pump() {
        guard task == nil, let words = pending, let basis else { return }
        pending = nil; status("Updating the recovery copy...")
        task = Task { [self] in
            do {
                let receipt = try await request("checkpoint", ["sessionID": sessionID, "sequence": sequence + 1, "parent": head.map { $0 as Any } ?? NSNull(), "basis": basis, "words": words])
                guard let id = receipt["id"] as? String, let number = receipt["sequence"] as? Int else { throw ReelBackend.APIError("The recovery copy did not return an acknowledgement.") }
                head = id; sequence = number; error = nil; status(receipt["warning"] as? String ?? "Recovery copy saved on disk.")
            } catch { self.error = error; status("Recovery copy failed: \(error.localizedDescription). Keep this editor open or save corrections.") }
            task = nil; if pending != nil { pump() }
        }
    }
    func flush() async throws {
        while let current = task { await current.value }
        if let error { throw error }
    }
    func retire() async throws {
        try await flush()
        if let head { _ = try await request("discard", ["id": head]) }
        head = nil; basis = nil
    }
}

@MainActor
final class NativeTranscriptState: ObservableObject {
    @Published var source = "" {
        willSet { if source != newValue { retainDraft() } }
        didSet { if source != oldValue { clearActive() } }
    }
    @Published var locale = Locale.current.identifier.replacingOccurrences(of: "_", with: "-") {
        willSet { if locale != newValue { retainDraft() } }
        didSet { if locale != oldValue { clearActive() } }
    }
    @Published var words: [NativeTranscriptWord] = []
    @Published var selectedWords: Set<Int> = []
    @Published var shortsReview: NativeShortsWorkflow.Review?
    @Published var captionReview: NativeCaptionWorkflow.Review?
    @Published var timedImportReview: NativeTimedTranscriptWorkflow.Review?
    @Published var candidates: [[String: Any]] = [] { didSet { shortsReview = nil } }
    @Published var selectedCandidates: Set<Int> = [] { didSet { shortsReview = nil } }
    @Published var query = ""
    @Published var allowServer = false
    @Published var dirty = false
    @Published var busy = false
    @Published var message = "Choose media with speech to transcribe it."
    @Published private(set) var draftConflict = false
    @Published private(set) var recoveryOffers: [[String: Any]] = []
    @Published private(set) var recoveryMessage = ""
    private(set) var recognitionStatus = "missing"
    private var revision: Any?
    private var task: Task<Void, Never>?
    private var generation = UUID()
    private var ownedJob: (String, ReelBackend)?
    private var loadedIdentity: NativeTranscriptIdentity?
    private var loadedBackendID: ObjectIdentifier?
    private var folderPath: String?
    private var attachedBackendID: ObjectIdentifier?
    private var fingerprint: String?
    private var importedBasis: [String: Any]?
    private struct DraftKey: Hashable { let folder: String; let source: String; let locale: String }
    private struct Draft {
        let words: [NativeTranscriptWord]
        let selectedWords: Set<Int>
        let query: String
        let revision: Any?
        let fingerprint: String?
        let basis: [String: Any]?
        let importedBasis: [String: Any]?
    }
    private var drafts: [DraftKey: Draft] = [:]
    private var preferredSources: [String: NativeTranscriptIdentity] = [:]
    private var recoverySessions: [DraftKey: NativeTranscriptRecoverySession] = [:]
    private var recoverySession: NativeTranscriptRecoverySession? { draftKey.flatMap { recoverySessions[$0] } }

    var identity: NativeTranscriptIdentity { NativeTranscriptIdentity(source: source, locale: locale) }
    var hasCurrentTranscript: Bool { !source.isEmpty && loadedIdentity == identity && !draftConflict }
    var selectedRanges: [[String: Any]] {
        selectedCandidates.sorted().filter { candidates.indices.contains($0) }.map { candidates[$0] }
    }
    var retainedCorrectionsText: String {
        "Source: \(source)\nLanguage: \(locale)\n\n" + words.map {
            "[\($0.from)–\($0.to) s] \($0.text)"
        }.joined(separator: "\n")
    }

    func invalidate() {
        retainDraft()
        clearActive()
    }

    private var draftKey: DraftKey? {
        folderPath.flatMap { source.isEmpty ? nil : DraftKey(folder: $0, source: source, locale: locale) }
    }

    private func retainDraft() {
        guard let key = draftKey else { return }
        preferredSources[key.folder] = identity
        guard dirty else { return }
        drafts[key] = Draft(words: words, selectedWords: selectedWords, query: query, revision: revision, fingerprint: fingerprint, basis: recoverySession?.capturedBasis, importedBasis: importedBasis)
    }

    /// Presentation can go away without becoming the owner of unsaved corrections.
    func suspend() { retainDraft(); cancel() }

    /// A different project/backend invalidates operations, but retains drafts for explicit recovery.
    func projectDidChange() {
        retainDraft()
        folderPath = nil; attachedBackendID = nil
        source = ""
        clearActive()
    }

    func attach(session: EditorSession) {
        let nextFolder = session.folder?.standardizedFileURL.path
        let nextBackend = session.backend.map { ObjectIdentifier($0) }
        guard folderPath != nextFolder || attachedBackendID != nextBackend else { return }
        retainDraft()
        folderPath = nil
        source = ""
        clearActive()
        folderPath = nextFolder; attachedBackendID = nextBackend
        if let nextFolder, let preferred = preferredSources[nextFolder] {
            locale = preferred.locale; source = preferred.source
        }
    }

    func discardDraft() {
        if let key = draftKey { drafts[key] = nil }
        dirty = false
        clearActive()
    }

    private func clearActive() {
        cancel()
        loadedIdentity = nil; loadedBackendID = nil; revision = nil; recognitionStatus = "missing"
        fingerprint = nil; importedBasis = nil; timedImportReview = nil; draftConflict = false; captionReview = nil; recoveryOffers = []; recoveryMessage = ""
        words = []; dirty = false; candidates = []; selectedCandidates = []; selectedWords = []
        message = source.isEmpty ? "Choose media with speech to transcribe it." : "Loading the transcript for this source and language."
    }

    func requireCurrentTranscript(session: EditorSession) throws -> NativeTranscriptIdentity {
        guard hasCurrentTranscript, let backend = session.backend, loadedBackendID == ObjectIdentifier(backend),
              attachedBackendID == ObjectIdentifier(backend), folderPath == session.folder?.standardizedFileURL.path else {
            throw ReelBackend.APIError("Load the transcript for this source and language before using its words.")
        }
        return identity
    }

    /// Preview never writes the transcript or places media; the retained draft stays owned here.
    @discardableResult
    func previewWord(_ index: Int, model: NativeEditorModel, session: EditorSession) -> Bool {
        guard !busy else { return false }
        do {
            let loaded = try requireCurrentTranscript(session: session)
            guard words.indices.contains(index), model.folder?.standardizedFileURL.path == folderPath,
                  let asset = model.project?.assets.first(where: { $0.id == loaded.source }) else {
                throw ReelBackend.APIError("This transcript source is no longer in the open project. Recheck it before previewing.")
            }
            let word = words[index]
            guard recognitionStatus != "stale" else {
                throw ReelBackend.APIError("This transcript source changed. Recheck it before previewing its words.")
            }
            guard word.from.isFinite, word.from >= 0, word.from < asset.duration else {
                throw ReelBackend.APIError("This word is outside the available source duration. Recheck its transcript.")
            }
            let candidates = model.tracks.flatMap(\.clips).filter {
                $0.source == loaded.source && !$0.fields.flag("reverse") && $0.fields["freeze"] == nil
                    && $0.fields["timeMap"] == nil && $0.fields["enabled"] as? Bool != false
            }
            if let clip = candidates.first(where: {
                let from = $0.fields.number("in"), speed = $0.fields.number("speed", 1)
                return speed.isFinite && speed > 0 && word.from >= from && word.from < from + $0.duration * speed
            }) {
                model.showingSource = false
                model.selectedID = clip.id
                model.seek(clip.start + (word.from - clip.fields.number("in")) / clip.fields.number("speed", 1))
                message = "Previewing this word in the first matching timeline placement."
            } else {
                model.openSource(asset)
                guard model.sourceAssetID == loaded.source, model.sourceError == nil else {
                    throw ReelBackend.APIError(model.sourceError ?? "This source could not be opened for preview.")
                }
                model.seekSource(word.from)
                message = "Previewing this word in the source viewer; no timeline placement was changed."
            }
            return true
        } catch {
            message = error.localizedDescription
            return false
        }
    }

    func updateCandidate(_ index: Int, key: String, value: Any) {
        guard hasCurrentTranscript, !busy, !dirty, recognitionStatus != "stale", candidates.indices.contains(index), ["name", "from", "to"].contains(key) else { return }
        candidates[index][key] = value
        shortsReview = nil
    }

    @discardableResult
    func previewShortRange(_ index: Int, model: NativeEditorModel, session: EditorSession) -> Bool {
        guard !busy, candidates.indices.contains(index) else { return false }
        do {
            _ = try shortsCapture(model: model, session: session)
            guard let asset = model.project?.assets.first(where: { $0.id == source }) else { throw ReelBackend.APIError("This source is no longer available.") }
            let range = candidates[index], from = range.number("from", .nan), to = range.number("to", .nan)
            guard from.isFinite, to.isFinite, from >= 0, to > from, to <= asset.duration, to - from <= 600 else { throw ReelBackend.APIError("Choose a valid source range before previewing this clip.") }
            model.openSource(asset)
            guard model.sourceAssetID == source, model.sourceError == nil else { throw ReelBackend.APIError(model.sourceError ?? "This source could not be opened.") }
            model.markSourceIn(from); model.markSourceOut(to); model.seekSource(from)
            message = "Previewing the edited source range. The original timeline is unchanged."
            return true
        } catch { message = error.localizedDescription; return false }
    }

    func shortsCapture(model: NativeEditorModel, session: EditorSession) throws -> NativeShortsWorkflow.Capture {
        let loaded = try requireCurrentTranscript(session: session)
        guard let backend = session.backend, let project = model.project, let folder = model.folder,
              model.capabilities.dictionary("shorts").flag("available"), let revision = revision as? Int, let fingerprint else {
            throw ReelBackend.APIError("Short clips require a saved transcript and an open supported project.")
        }
        let file = try NativeSourceFileIdentity(file: model.mediaURL(loaded.source))
        return try NativeShortsWorkflow.Capture(["src": loaded.source, "locale": loaded.locale, "folder": folder.standardizedFileURL.path,
            "backend": String(describing: ObjectIdentifier(backend)), "version": model.version, "comp": model.composition as Any? ?? NSNull(),
            "project": project.fields, "file": ["path": file.path, "device": file.device, "inode": file.inode, "size": file.size, "seconds": file.seconds, "nanoseconds": file.nanoseconds],
            "revision": revision, "fingerprint": fingerprint, "status": recognitionStatus, "dirty": dirty, "current": hasCurrentTranscript, "words": words.map(\.json)])
    }

    func captionCapture(model: NativeEditorModel, session: EditorSession, settings: NativeCaptionWorkflow.Settings) throws -> NativeShortsWorkflow.Capture {
        let loaded = try requireCurrentTranscript(session: session)
        guard let backend = session.backend, let project = model.project, let folder = model.folder,
              folder.standardizedFileURL.path == folderPath, let revision = revision as? Int, let fingerprint else {
            throw ReelBackend.APIError("Captions require a saved transcript and an open project.")
        }
        let selected = model.tracks.flatMap(\.clips).first { $0.id == model.selectedID }
        if settings.onlySelected, selected?.source != loaded.source {
            throw ReelBackend.APIError("Select a timeline clip that plays this transcript source, or caption all its placements in this composition.")
        }
        let file = try NativeSourceFileIdentity(file: model.mediaURL(loaded.source))
        return try NativeShortsWorkflow.Capture(["src": loaded.source, "locale": loaded.locale, "folder": folder.standardizedFileURL.path,
            "backend": String(describing: ObjectIdentifier(backend)), "version": model.version, "comp": model.composition as Any? ?? NSNull(),
            "id": settings.onlySelected ? (selected?.id as Any? ?? NSNull()) : NSNull(), "tracks": model.tracks.map(\.fields),
            "project": project.fields, "file": ["path": file.path, "device": file.device, "inode": file.inode, "size": file.size, "seconds": file.seconds, "nanoseconds": file.nanoseconds],
            "revision": revision, "fingerprint": fingerprint, "status": recognitionStatus, "dirty": dirty, "current": hasCurrentTranscript, "words": words.map(\.json)])
    }

    func reviewCaptions(model: NativeEditorModel, session: EditorSession, settings: NativeCaptionWorkflow.Settings, token: UUID, backend: ReelBackend) async throws {
        captionReview = nil
        let capture = try captionCapture(model: model, session: session, settings: settings)
        let body = try NativeCaptionWorkflow.reviewBody(capture: capture, settings: settings)
        let saved = try await model.call(nativeQuery("/api/transcript", ["src": source, "locale": locale]))
        try check(token, backend: backend, session: session); try capture.verifyTranscript(saved)
        guard capture.matches(try captionCapture(model: model, session: session, settings: settings)) else { throw ReelBackend.APIError("The project or source changed. Preview the captions again.") }
        let response = try await model.call("/api/captions/from-transcript", body)
        try check(token, backend: backend, session: session)
        guard capture.matches(try captionCapture(model: model, session: session, settings: settings)) else { throw ReelBackend.APIError("The project or source changed during preview. Preview the captions again.") }
        captionReview = try NativeCaptionWorkflow.Review(capture: capture, settings: settings, body: body, response: response)
        message = "Review the caption text, timeline times and destination below before creating captions."
    }

    func createReviewedCaptions(model: NativeEditorModel, session: EditorSession, settings: NativeCaptionWorkflow.Settings, token: UUID, backend: ReelBackend) async throws {
        guard let review = captionReview else { throw ReelBackend.APIError("Preview captions before creating them.") }
        let saved = try await model.call(nativeQuery("/api/transcript", ["src": source, "locale": locale]))
        try check(token, backend: backend, session: session); try review.capture.verifyTranscript(saved)
        let body = try review.creationBody(current: captionCapture(model: model, session: session, settings: settings), settings: settings)
        // A lost edit reply requires a new preview before retrying, because the edit may have committed.
        captionReview = nil
        let response = try await model.call("/api/captions/from-transcript", body)
        try check(token, backend: backend, session: session)
        let createdVersion = review.capture.record.number("version") + 1
        guard response["applied"] as? Bool == true, response.number("version", -1) == createdVersion else {
            throw ReelBackend.APIError("Caption creation was not confirmed. Refresh and preview before retrying.")
        }
        await model.refresh(); try check(token, backend: backend, session: session)
        guard Double(model.version) >= createdVersion, let project = model.project,
              NativeCaptionWorkflow.createdTrackIsLoaded(project: project.fields, composition: review.capture.record["comp"] as? String,
                                                         track: settings.track, count: review.items.count) else {
            throw ReelBackend.APIError("Captions were created, but the updated track could not be loaded. Refresh the project before continuing.")
        }
        message = "Created \(review.items.count) editable captions on \(settings.track). Undo restores the prior timeline."
    }

    func reviewShorts(model: NativeEditorModel, session: EditorSession, settings: NativeShortsWorkflow.Settings, token: UUID, backend: ReelBackend) async throws {
        shortsReview = nil
        let capture = try shortsCapture(model: model, session: session)
        let body = try NativeShortsWorkflow.reviewBody(capture: capture, ranges: selectedRanges, settings: settings)
        let saved = try await model.call(nativeQuery("/api/transcript", ["src": source, "locale": locale]))
        try check(token, backend: backend, session: session); try capture.verifyTranscript(saved)
        guard capture.matches(try shortsCapture(model: model, session: session)) else { throw ReelBackend.APIError("The project or source changed. Review the clips again.") }
        let result = try await model.call("/api/shorts/build", body)
        try check(token, backend: backend, session: session)
        guard capture.matches(try shortsCapture(model: model, session: session)) else { throw ReelBackend.APIError("The project or source changed during review. Review the clips again.") }
        shortsReview = try NativeShortsWorkflow.Review(capture: capture, settings: settings, body: body, response: result)
        message = "Review the planned names, source ranges, format and caption choice below. No clips have been created."
    }

    func createReviewedShorts(model: NativeEditorModel, session: EditorSession, settings: NativeShortsWorkflow.Settings, token: UUID, backend: ReelBackend) async throws {
        guard let review = shortsReview else { throw ReelBackend.APIError("Review the selected clips before creating compositions.") }
        let saved = try await model.call(nativeQuery("/api/transcript", ["src": source, "locale": locale]))
        try check(token, backend: backend, session: session); try review.capture.verifyTranscript(saved)
        let body = try review.creationBody(current: shortsCapture(model: model, session: session), settings: settings)
        let navigation = shortsNavigation(model)
        // A dispatched edit may commit even if its reply is lost. Require a new review before retrying.
        shortsReview = nil
        let result = try await model.call("/api/shorts/build", body)
        try check(token, backend: backend, session: session)
        let createdVersion = review.capture.record.number("version") + 1
        guard result["applied"] as? Bool == true, result.number("version", -1) == createdVersion else {
            throw ReelBackend.APIError("The creation reply was not confirmed. Refresh and review before retrying.")
        }
        await model.refresh(); try check(token, backend: backend, session: session)
        let created = result.objects("comps")
        guard Double(model.version) >= createdVersion, created.count == review.compositions.count,
              let project = model.project, created.allSatisfy({ planned in project.compositions.contains { $0.id == planned.string("id") } }) else {
            throw ReelBackend.APIError("Short clips were created, but the updated project could not be loaded. Refresh the project before continuing.")
        }
        if let first = created.first?.string("id") {
            navigation.openCreated(first, current: shortsNavigation(model)) { model.showingSource = false; model.composition = $0 }
        }
        message = "Created \(result.objects("comps").count) editable short compositions in one undoable edit. Review the framing and sound before export."
    }

    private func shortsNavigation(_ model: NativeEditorModel) -> NativeShortsWorkflow.Navigation {
        NativeShortsWorkflow.Navigation(composition: model.composition, primary: model.selectedID, selection: model.selectedIDs,
                                        panel: model.panel.rawValue, source: model.sourceAssetID, showingSource: model.showingSource)
    }

    @discardableResult
    func updateWordTiming(_ index: Int, from: Double, to: Double, model: NativeEditorModel, session: EditorSession) -> Bool {
        guard !busy else { return false }
        do {
            let loaded = try requireCurrentTranscript(session: session)
            guard recognitionStatus != "stale", model.folder?.standardizedFileURL.path == folderPath,
                  let asset = model.project?.assets.first(where: { $0.id == loaded.source }) else {
                throw ReelBackend.APIError("Recheck the current transcript source before editing word timing.")
            }
            let word = try NativeTranscriptTiming.edited(words, index: index, from: from, to: to, duration: asset.duration)
            if words[index].from == from, words[index].to == to { return true }
            words[index] = word
            // Use the text-edit path so timing corrections have the same draft owner and recovery hooks.
            updateWord(index, text: word.text)
            message = "Word timing updated. Save corrections before creating captions or clips."
            return true
        } catch { message = error.localizedDescription; return false }
    }

    func updateWord(_ index: Int, text: String) {
        guard hasCurrentTranscript, !busy, words.indices.contains(index) else { return }
        words[index].text = text; dirty = true; candidates = []; selectedCandidates = []; captionReview = nil; timedImportReview = nil
        retainDraft(); recoverySession?.update(words)
    }

    func cancel() {
        generation = UUID(); task?.cancel(); task = nil; busy = false
        if let (id, backend) = ownedJob {
            Task { _ = try? await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": id]).text) }
        }
        ownedJob = nil
    }

    func check(_ token: UUID, backend: ReelBackend, session: EditorSession) throws {
        try Task.checkCancellation()
        guard generation == token, session.backend === backend, attachedBackendID == ObjectIdentifier(backend),
              folderPath == session.folder?.standardizedFileURL.path else { throw CancellationError() }
    }

    func perform(model: NativeEditorModel, session: EditorSession, operation: @escaping @MainActor (UUID, ReelBackend) async throws -> Void) {
        guard !busy, let backend = session.backend else { return }
        busy = true
        let token = UUID(); generation = token
        task = Task {
            do {
                try check(token, backend: backend, session: session)
                try await operation(token, backend)
                try check(token, backend: backend, session: session)
            } catch is CancellationError { }
            catch {
                if generation == token, session.backend === backend { message = error.localizedDescription }
            }
            if generation == token {
                if let (id, owner) = ownedJob {
                    Task { _ = try? await owner.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": id]).text) }
                    ownedJob = nil
                }
                busy = false; task = nil
            }
        }
    }

    func resolve(_ response: [String: Any], model: NativeEditorModel, session: EditorSession) async throws -> [String: Any] {
        guard let id = response["id"] as? String, response["state"] != nil, let backend = session.backend else { return response }
        if Task.isCancelled {
            Task { _ = try? await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": id]).text) }
            throw CancellationError()
        }
        ownedJob = (id, backend)
        var job = response
        while true {
            try Task.checkCancellation()
            guard session.backend === backend else { throw CancellationError() }
            let state = job.string("state")
            if state == "done" { ownedJob = nil; return job.dictionary("result") }
            if state == "failed" || state == "cancelled" { ownedJob = nil; throw ReelBackend.APIError(job.string("error", "The task was \(state).")) }
            message = "\(job.string("kind", "Processing").capitalized) \(Int(job.number("progress") * 100))%"
            job = try await model.call(nativeQuery("/api/jobs/wait", ["id": id, "timeout": "20000"]))
        }
    }

    func startJob(_ path: String, body: [String: Any], model: NativeEditorModel, session: EditorSession) async throws -> [String: Any] {
        guard let backend = session.backend else { throw CancellationError() }
        let value = try await session.request(method: "POST", path: path, body: JSON(any: body).text)
        let response = try JSON.parse(value.text) as? [String: Any] ?? [:]
        if Task.isCancelled || session.backend !== backend {
            if let id = response["id"] as? String, response["state"] != nil {
                Task { _ = try? await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": id]).text) }
            }
            throw CancellationError()
        }
        return try await resolve(response, model: model, session: session)
    }

    func accept(_ response: [String: Any], identity requested: NativeTranscriptIdentity, backend: ReelBackend) throws {
        guard identity == requested, attachedBackendID == ObjectIdentifier(backend) else { throw CancellationError() }
        loadedIdentity = requested; loadedBackendID = ObjectIdentifier(backend)
        recognitionStatus = response.string("status", "missing")
        words = response.objects("words").enumerated().map { index, word in
            NativeTranscriptWord(id: index, from: word.number("t"), to: word.number("end"), text: word.string("text"))
        }
        importedBasis = nil; timedImportReview = nil
        revision = response["revision"]; dirty = false; candidates = []; selectedCandidates = []; selectedWords = []; captionReview = nil
        fingerprint = response["fingerprint"] as? String
        message = words.isEmpty ? "No transcript yet. Transcribe this source or import timed subtitles." : "\(words.count) words. Correct the text, then save before creating captions or clips."
        if recognitionStatus == "partial" { message = "This transcript is partial. Retry recognition or review only the recognized passages. " + (response["warnings"] as? [String] ?? []).joined(separator: " ") }
        if recognitionStatus == "stale" { message = response.string("warning", "The source changed. Transcribe it again before using the saved words.") }
        if let key = draftKey, let draft = drafts[key] {
            let sameRevision = (draft.revision as? Int) != nil && (draft.revision as? Int) == (revision as? Int)
            draftConflict = !sameRevision || draft.fingerprint != fingerprint || recognitionStatus == "stale"
            words = draft.words; selectedWords = draft.selectedWords; query = draft.query; dirty = true
            revision = draft.revision; fingerprint = draft.fingerprint; importedBasis = draft.importedBasis
            message = draftConflict
                ? "Unsaved corrections were retained, but the saved transcript or source changed. Review or copy your words, then explicitly discard the draft before loading the current transcript."
                : "Unsaved corrections restored. Save corrections to commit them, or explicitly discard the draft."
        }
    }

    func load(model: NativeEditorModel, session: EditorSession) {
        let requested = identity
        invalidate()
        guard !requested.source.isEmpty else { return }
        if let key = draftKey, let draft = drafts[key] {
            words = draft.words; selectedWords = draft.selectedWords; query = draft.query
            revision = draft.revision; fingerprint = draft.fingerprint; importedBasis = draft.importedBasis; dirty = true; draftConflict = true
            message = "Unsaved corrections retained. Checking the current source and saved transcript before allowing a save."
        }
        perform(model: model, session: session) { [self] token, backend in
            let response = try await model.call(nativeQuery("/api/transcript", ["src": requested.source, "locale": requested.locale]))
            try check(token, backend: backend, session: session)
            try accept(response, identity: requested, backend: backend)
            let context = try await model.call(nativeQuery("/api/transcript/drafts", ["src": requested.source, "locale": requested.locale]))
            try check(token, backend: backend, session: session)
            guard identity == requested, let key = draftKey else { throw CancellationError() }
            if recoverySessions[key]?.backendID != ObjectIdentifier(backend) {
                recoverySessions[key] = NativeTranscriptRecoverySession(backend: backend, owner: requested) { [weak self] message in
                    guard let self, self.draftKey == key, self.attachedBackendID == ObjectIdentifier(backend) else { return }
                    self.recoveryMessage = message
                }
            }
            if let captured = drafts[key]?.basis {
                if let current = context["basis"] as? [String: Any], NSDictionary(dictionary: captured).isEqual(to: current) { }
                else { draftConflict = true; recoveryMessage = "Retained corrections have an older project or source identity. Copy them before discarding this draft." }
            }
            recoverySessions[key]?.capture(context, revision: response["revision"], fingerprint: response["fingerprint"] as? String)
            recoveryOffers = context.objects("offers")
            if let reason = context["reason"] as? String { recoveryMessage = reason }
            else if !(context["warnings"] as? [String] ?? []).isEmpty { recoveryMessage = "Some recovery files could not be read. They were preserved." }
            if dirty, !draftConflict { recoverySessions[key]?.update(words) }
        }
    }

    func save(model: NativeEditorModel, session: EditorSession, token: UUID, backend: ReelBackend) async throws {
        let loaded = try requireCurrentTranscript(session: session)
        var body: [String: Any] = ["src": loaded.source, "locale": loaded.locale, "words": words.map(\.json)]
        if let revision { body["revision"] = revision }
        if let importedBasis { body.merge(importedBasis) { _, guarded in guarded } }
        // A dispatched save can have committed even if its response is lost or cancelled.
        // Retain the original revision and require an explicit read before retrying it.
        draftConflict = true
        retainDraft()
        let ownedRecovery = recoverySession, ownedKey = draftKey
        do { try await ownedRecovery?.flush() }
        catch { try check(token, backend: backend, session: session); recoveryMessage = "Recovery copy failed: \(error.localizedDescription). Saving the corrections now." }
        try check(token, backend: backend, session: session)
        let saved = try await model.call("/api/transcript", body)
        try check(token, backend: backend, session: session)
        do {
            try await ownedRecovery?.retire()
            try check(token, backend: backend, session: session)
            if let ownedKey, let ownedRecovery, recoverySessions[ownedKey] === ownedRecovery { recoverySessions[ownedKey] = nil }
        } catch { try check(token, backend: backend, session: session); recoveryMessage = "Corrections saved, but the recovery copy remains: \(error.localizedDescription)" }
        try check(token, backend: backend, session: session)
        self.revision = saved["revision"]; fingerprint = saved["fingerprint"] as? String
        // A saved revision needs a new recovery basis even when retiring the old copy failed.
        if let ownedKey, let ownedRecovery, recoverySessions[ownedKey] === ownedRecovery { recoverySessions[ownedKey] = nil }
        if let key = draftKey { drafts[key] = nil }
        dirty = false; draftConflict = false; message = "Transcript corrections saved."
        load(model: model, session: session)
    }

    func timedImportCapture(model: NativeEditorModel, session: EditorSession) throws -> NativeTimedTranscriptWorkflow.Capture {
        let loaded = try requireCurrentTranscript(session: session)
        guard !dirty, recognitionStatus != "stale", let backend = session.backend, let project = model.project,
              let revision = revision as? Int, let folder = model.folder, folder.standardizedFileURL.path == folderPath,
              let asset = project.assets.first(where: { $0.id == loaded.source }) else {
            throw ReelBackend.APIError("Save or discard current corrections, then load the transcript before importing timed words.")
        }
        let file = try NativeSourceFileIdentity(file: model.mediaURL(loaded.source))
        let stamp = "v2|\(file.size)|\(file.seconds)|\(file.nanoseconds)"
        return try NativeTimedTranscriptWorkflow.Capture(["src": loaded.source, "locale": try NativeTranscriptStore.localeID(loaded.locale),
            "ownerLocale": loaded.locale, "folder": folder.standardizedFileURL.path, "backend": String(describing: ObjectIdentifier(backend)),
            "context": model.processingContextID.uuidString, "project": project.fields, "version": model.version,
            "revision": revision, "fingerprint": stamp, "duration": asset.duration, "words": words.map(\.json),
            "file": ["path": file.path, "device": file.device, "inode": file.inode, "size": file.size, "seconds": file.seconds, "nanoseconds": file.nanoseconds]])
    }

    private func timedImportIsCurrent(_ capture: NativeTimedTranscriptWorkflow.Capture, model: NativeEditorModel, session: EditorSession) -> Bool {
        let record = capture.record
        guard !dirty, hasCurrentTranscript, source == record.string("src"), locale == record.string("ownerLocale"),
              recognitionStatus != "stale", revision as? Int == record["revision"] as? Int,
              model.version == record["version"] as? Int, model.processingContextID.uuidString == record.string("context"),
              model.folder?.standardizedFileURL.path == record.string("folder"), let backend = session.backend,
              String(describing: ObjectIdentifier(backend)) == record.string("backend"),
              attachedBackendID == ObjectIdentifier(backend), loadedBackendID == ObjectIdentifier(backend),
              let file = try? NativeSourceFileIdentity(file: model.mediaURL(source)) else { return false }
        let captured = record.dictionary("file")
        return file.path == captured.string("path") && file.device == (captured["device"] as? NSNumber)?.uint64Value &&
            file.inode == (captured["inode"] as? NSNumber)?.uint64Value && file.size == (captured["size"] as? NSNumber)?.int64Value &&
            file.seconds == (captured["seconds"] as? NSNumber)?.int64Value && file.nanoseconds == (captured["nanoseconds"] as? NSNumber)?.int64Value
    }

    func previewTimedImport(_ result: Result<[URL], Error>, capture: NativeTimedTranscriptWorkflow.Capture,
                            model: NativeEditorModel, session: EditorSession, token: UUID, backend: ReelBackend) async throws {
        timedImportReview = nil
        try check(token, backend: backend, session: session)
        guard capture.matches(try timedImportCapture(model: model, session: session)) else { throw CancellationError() }
        let document = try NativeTimedTranscriptImport.read(result, duration: capture.record.number("duration")) { [self] in
            timedImportIsCurrent(capture, model: model, session: session)
        }
        guard let document else { return }
        try check(token, backend: backend, session: session)
        guard capture.matches(try timedImportCapture(model: model, session: session)) else { throw CancellationError() }
        var body = capture.request
        switch document {
        case .words(let words, _): body["words"] = words
        case .subtitles(let text, let format): body["text"] = text; body["format"] = format
        }
        let response = try await model.call("/api/transcript/import-preview", body)
        try check(token, backend: backend, session: session)
        let saved = try await model.call(nativeQuery("/api/transcript", ["src": capture.record.string("src"), "locale": capture.record.string("locale")]))
        try check(token, backend: backend, session: session); try capture.verifySaved(saved)
        guard capture.matches(try timedImportCapture(model: model, session: session)) else { throw CancellationError() }
        let review = try NativeTimedTranscriptWorkflow.Review(capture: capture, response: response)
        _ = try NativeTimedTranscriptImport.validateWords(review.words, duration: capture.record.number("duration"))
        timedImportReview = review
        message = "Review the imported timing below, then load the words as unsaved corrections."
    }

    @discardableResult
    func acceptTimedImport(model: NativeEditorModel, session: EditorSession, token: UUID, backend: ReelBackend) async throws -> Bool {
        guard let review = timedImportReview else { return false }
        try check(token, backend: backend, session: session)
        try review.verify(current: timedImportCapture(model: model, session: session))
        let saved = try await model.call(nativeQuery("/api/transcript", ["src": review.capture.record.string("src"), "locale": review.capture.record.string("locale")]))
        try check(token, backend: backend, session: session); try review.capture.verifySaved(saved)
        try review.verify(current: timedImportCapture(model: model, session: session))
        words = review.words.enumerated().map { NativeTranscriptWord(id: $0.offset, from: $0.element.number("t"), to: $0.element.number("end"), text: $0.element.string("text")) }
        importedBasis = review.capture.basis; timedImportReview = nil
        dirty = true; candidates = []; selectedCandidates = []; selectedWords = []; captionReview = nil
        retainDraft(); recoverySession?.update(words)
        message = "Imported \(words.count) words as unsaved corrections. Review their timing, then save corrections."
        return true
    }

    func discardDurableDraft(model: NativeEditorModel, session: EditorSession, token: UUID, backend: ReelBackend) async throws {
        try check(token, backend: backend, session: session)
        let ownedKey = draftKey, ownedRecovery = recoverySession
        do {
            try await ownedRecovery?.retire()
            try check(token, backend: backend, session: session)
            if let ownedKey, let ownedRecovery, recoverySessions[ownedKey] === ownedRecovery { recoverySessions[ownedKey] = nil }
        } catch { try check(token, backend: backend, session: session); recoveryMessage = "The recovery copy remains on disk: \(error.localizedDescription)" }
        try check(token, backend: backend, session: session)
        guard draftKey == ownedKey else { throw CancellationError() }
        discardDraft(); load(model: model, session: session)
    }

    func recoveryAction(_ action: String, offer: [String: Any], model: NativeEditorModel, session: EditorSession, copy: @escaping @MainActor (String) -> Void = { _ in }) {
        guard action != "recover" || !dirty else { return }
        perform(model: model, session: session) { [self] token, backend in
            let requested = identity
            guard let id = offer["id"] as? String else { throw ReelBackend.APIError("Choose a recovery copy.") }
            let response = try await model.call("/api/transcript/drafts/" + (action == "copy" ? "read" : action), ["src": requested.source, "locale": requested.locale, "id": id])
            try check(token, backend: backend, session: session)
            guard identity == requested else { throw CancellationError() }
            if action == "copy" { copy(response.objects("words").map { $0.string("text") }.joined(separator: " ")); recoveryMessage = "Recovery text copied."; return }
            if action == "discard" { recoveryOffers.removeAll { $0["id"] as? String == id }; return }
            let captured = response.dictionary("basis")
            guard captured["revision"] as? Int == revision as? Int, captured["fingerprint"] as? String == (fingerprint ?? ""), hasCurrentTranscript else { throw ReelBackend.APIError("The saved transcript changed. Recheck it before recovery.") }
            if captured["revision"] as? Int == 0 { importedBasis = try timedImportCapture(model: model, session: session).basis }
            words = response.objects("words").enumerated().map { NativeTranscriptWord(id: $0.offset, from: $0.element.number("t"), to: $0.element.number("end"), text: $0.element.string("text")) }
            dirty = true; selectedWords = []; candidates = []; selectedCandidates = []
            retainDraft(); recoverySession?.update(words)
            recoveryMessage = "Recovery words loaded as unsaved corrections. Review them before saving."
        }
    }
}
// END TRANSCRIPT CONTROLLER

struct NativeTranscriptPanel: View {
    @ObservedObject var model: NativeEditorModel
    @ObservedObject var session: EditorSession
    @ObservedObject private var transcript: NativeTranscriptState
    @State private var confirmingDiscard = false
    @State private var captionStyle = "boxed"
    @State private var captionCharacters = 42
    @State private var captionLines = 2
    @State private var burnInCaptions = true
    @State private var captionOnlySelected = false
    @State private var captionTrack = ""
    @State private var replaceCaptions = false
    @State private var format = "vertical"
    @State private var includeShortCaptions = true
    @State private var minimum = 15.0
    @State private var maximum = 60.0
    @State private var clipQuery = ""
    @FocusState private var editingLocale: Bool

    init(model: NativeEditorModel, session: EditorSession) {
        self.model = model; self.session = session; self.transcript = model.transcript
    }

    private var shortSettings: NativeShortsWorkflow.Settings { .init(format: format, captions: includeShortCaptions, captionStyle: captionStyle) }

    private var nextCaptionTrack: String {
        let used = Set(model.tracks.map(\.id))
        var index = 1; while used.contains("C\(index)") { index += 1 }
        return "C\(index)"
    }
    private var captionSettings: NativeCaptionWorkflow.Settings {
        .init(preset: captionStyle, maxChars: captionCharacters, maxLines: captionLines, burnIn: burnInCaptions,
              onlySelected: captionOnlySelected, track: captionTrack.isEmpty ? nextCaptionTrack : captionTrack, replace: replaceCaptions)
    }

    private var sources: [NativeAsset] { (model.project?.assets ?? []).filter { $0.fields.flag("hasAudio") } }
    private var filteredWords: [Int] {
        transcript.words.indices.filter { transcript.query.isEmpty || transcript.words[$0].text.localizedCaseInsensitiveContains(transcript.query) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Transcript and clips").font(.headline)
                Picker("Source", selection: $transcript.source) {
                    Text("Choose media").tag("")
                    ForEach(sources) { Text($0.name).tag($0.id) }
                }.disabled(transcript.busy || transcript.dirty)
                TextField("Language locale, such as en-US", text: $transcript.locale).textFieldStyle(.roundedBorder)
                    .focused($editingLocale).disabled(transcript.busy || transcript.dirty)
                    .onSubmit { if !transcript.busy, !transcript.hasCurrentTranscript { transcript.load(model: model, session: session) } }
                Toggle("Allow Apple server recognition", isOn: $transcript.allowServer).disabled(transcript.busy)
                Text("Audio is sent to Apple's speech service only when you enable this option and on-device recognition is unavailable. Availability varies by language and device.").font(.caption2).foregroundStyle(.secondary)
                HStack {
                    Button(transcript.words.isEmpty ? "Transcribe" : "Transcribe again") {
                        transcript.perform(model: model, session: session) { token, backend in
                            let requested = transcript.identity
                            let result = try await transcript.startJob("/api/analyze", body: ["src": requested.source, "kind": "transcript", "locale": requested.locale, "wait": false, "allowServer": transcript.allowServer, "force": transcript.recognitionStatus == "partial" || !transcript.words.isEmpty], model: model, session: session)
                            try transcript.check(token, backend: backend, session: session)
                            try transcript.accept(result, identity: requested, backend: backend)
                        }
                    }
                    #if os(iOS)
                    .disabled(transcript.source.isEmpty || transcript.busy || transcript.dirty)
                    #else
                    .disabled(transcript.source.isEmpty || transcript.busy || transcript.dirty || !model.capabilities.flag("whisper"))
                    #endif
                    if transcript.busy { ProgressView().controlSize(.small); Button("Cancel") { transcript.cancel() } }
                    else { Button("Save corrections") { transcript.perform(model: model, session: session) { token, backend in try await transcript.save(model: model, session: session, token: token, backend: backend) } }.disabled(!transcript.dirty || !transcript.hasCurrentTranscript) }
                }
                NativeTimedTranscriptImportControls(transcript: transcript, model: model, session: session)
                Text(transcript.message).font(.caption).foregroundStyle(.secondary)
                if !transcript.recoveryMessage.isEmpty { Text(transcript.recoveryMessage).font(.caption).foregroundStyle(.secondary).accessibilityAddTraits(.updatesFrequently) }
                ForEach(transcript.recoveryOffers.indices, id: \.self) { index in
                    let offer = transcript.recoveryOffers[index]
                    VStack(alignment: .leading, spacing: 6) {
                        Text(offer.flag("recoverable") ? "Recovery copy available. Review it as unsaved corrections." : "The recovery copy has an older project, source or saved transcript. Copy its text.").font(.caption)
                        HStack {
                            if offer.flag("recoverable") { Button("Recover corrections") { transcript.recoveryAction("recover", offer: offer, model: model, session: session) }.disabled(transcript.dirty || transcript.busy) }
                            Button("Copy recovery text") { transcript.recoveryAction("copy", offer: offer, model: model, session: session, copy: copyRecoveryText) }.disabled(transcript.busy)
                            Button("Discard recovery copy", role: .destructive) { transcript.recoveryAction("discard", offer: offer, model: model, session: session) }.disabled(transcript.busy)
                        }
                    }
                }
                if transcript.dirty {
                    Button("Recheck saved transcript") { transcript.load(model: model, session: session) }.disabled(transcript.busy)
                    Button("Copy retained corrections", action: copyRetainedCorrections)
                        .disabled(transcript.words.isEmpty)
                    Button("Discard unsaved corrections", role: .destructive) { confirmingDiscard = true }
                        .disabled(transcript.busy)
                }
                TextField("Find a word", text: $transcript.query).textFieldStyle(.roundedBorder)
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(filteredWords, id: \.self) { index in
                        VStack(alignment: .leading, spacing: 4) {
                          HStack {
                            Button {
                                if transcript.selectedWords.contains(index) { transcript.selectedWords.remove(index) } else { transcript.selectedWords.insert(index) }
                            } label: { Image(systemName: transcript.selectedWords.contains(index) ? "checkmark.circle.fill" : "circle") }
                                .buttonStyle(.borderless).accessibilityLabel("Select word \(index + 1) for a passage").disabled(transcript.busy)
                            Button(transcript.words[index].from.formatted(.number.precision(.fractionLength(2)))) { seekWord(index) }
                                .font(.caption.monospacedDigit()).buttonStyle(.borderless).frame(width: 58, alignment: .leading)
                                .disabled(transcript.busy)
                            TextField("Word \(index + 1)", text: Binding(get: { transcript.words.indices.contains(index) ? transcript.words[index].text : "" }, set: { value in
                                transcript.updateWord(index, text: value)
                            }))
                                .textFieldStyle(.roundedBorder).disabled(transcript.busy || transcript.draftConflict)
                          }
                          NativeTranscriptTimingEditor(transcript: transcript, model: model, session: session, index: index)
                        }
                    }
                }
                passageControls
                Divider()
                Picker("Caption style", selection: $captionStyle) {
                    Text("Plain").tag("plain"); Text("Boxed").tag("boxed"); Text("Word highlight").tag("karaoke"); Text("One word").tag("word")
                }.disabled(transcript.busy)
                captionControls
                Divider()
                Text("Build short clips").font(.headline)
                TextField("Find moments about…", text: $clipQuery).textFieldStyle(.roundedBorder).disabled(transcript.busy)
                HStack {
                    TextField("Minimum seconds", value: $minimum, format: .number).textFieldStyle(.roundedBorder)
                    TextField("Maximum seconds", value: $maximum, format: .number).textFieldStyle(.roundedBorder)
                }.disabled(transcript.busy)
                Picker("Output format", selection: $format) {
                    Text("9:16 vertical").tag("vertical"); Text("1:1 square").tag("square"); Text("16:9 landscape").tag("landscape")
                }.disabled(transcript.busy)
                Toggle("Include editable captions", isOn: $includeShortCaptions).disabled(transcript.busy)
                Button("Suggest clips") {
                    transcript.perform(model: model, session: session) { token, backend in
                        let capture = try transcript.shortsCapture(model: model, session: session)
                        let loaded = try transcript.requireCurrentTranscript(session: session)
                        let result = try await model.call("/api/shorts/propose", ["src": loaded.source, "locale": loaded.locale, "words": transcript.words.map(\.json), "minDur": minimum, "maxDur": maximum, "count": 5, "query": clipQuery])
                        try transcript.check(token, backend: backend, session: session)
                        guard capture.matches(try transcript.shortsCapture(model: model, session: session)) else { throw ReelBackend.APIError("The project or source changed. Suggest clips again.") }
                        transcript.candidates = result.objects("candidates").enumerated().map { index, range in var next = range; next["name"] = "Clip \(index + 1)"; return next }
                        transcript.selectedCandidates = []
                        transcript.message = "Edit the source ranges and names, select the clips to include, then review the plan."
                    }
                }.disabled(transcript.words.isEmpty || transcript.busy || transcript.dirty || !transcript.hasCurrentTranscript || transcript.recognitionStatus == "stale")
                ForEach(transcript.candidates.indices, id: \.self) { index in
                    let candidate = transcript.candidates[index]
                    VStack(alignment: .leading, spacing: 5) {
                        Toggle("Include clip \(index + 1)", isOn: Binding(get: { transcript.selectedCandidates.contains(index) }, set: { value in
                            guard transcript.hasCurrentTranscript, !transcript.busy, !transcript.dirty, transcript.recognitionStatus != "stale", transcript.candidates.indices.contains(index) else { return }
                            if value { transcript.selectedCandidates.insert(index) } else { transcript.selectedCandidates.remove(index) }
                        }))
                        TextField("Clip \(index + 1) name", text: Binding(get: { transcript.candidates.indices.contains(index) ? transcript.candidates[index].string("name") : "" }, set: { transcript.updateCandidate(index, key: "name", value: $0) })).textFieldStyle(.roundedBorder)
                        HStack {
                            TextField("Source start seconds", value: Binding(get: { transcript.candidates.indices.contains(index) ? transcript.candidates[index].number("from") : 0 }, set: { transcript.updateCandidate(index, key: "from", value: $0) }), format: .number).textFieldStyle(.roundedBorder)
                            TextField("Source end seconds", value: Binding(get: { transcript.candidates.indices.contains(index) ? transcript.candidates[index].number("to") : 0 }, set: { transcript.updateCandidate(index, key: "to", value: $0) }), format: .number).textFieldStyle(.roundedBorder)
                        }
                        Button("Preview edited range") {
                            if transcript.previewShortRange(index, model: model, session: session) {
                                #if os(iOS)
                                model.mobilePanel = nil
                                #endif
                            }
                        }
                        Text("Suggested passage: " + candidate.string("evidence")).font(.caption)
                        Text("The evidence describes the original suggestion. Preview edited source ranges before export.").font(.caption2).foregroundStyle(.secondary)
                        Text(candidate.string("reason")).font(.caption2).foregroundStyle(.secondary)
                    }.disabled(transcript.busy || transcript.dirty || !transcript.hasCurrentTranscript || transcript.recognitionStatus == "stale")
                        .padding(8).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
                }
                Button("Review selected clips") {
                    let settings = shortSettings
                    transcript.perform(model: model, session: session) { token, backend in
                        try await transcript.reviewShorts(model: model, session: session, settings: settings, token: token, backend: backend)
                    }
                }.disabled(transcript.selectedRanges.isEmpty || transcript.busy || transcript.dirty || !transcript.hasCurrentTranscript || transcript.recognitionStatus == "stale")
                if let review = transcript.shortsReview {
                    GroupBox("Review before creation") {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(review.compositions.indices, id: \.self) { index in
                                let planned = review.compositions[index]
                                Text("\(planned.string("name")): \(planned.number("from").formatted(.number.precision(.fractionLength(2))))–\(planned.number("to").formatted(.number.precision(.fractionLength(2)))) source seconds · \(planned.number("duration").formatted(.number.precision(.fractionLength(2)))) seconds")
                            }
                            let size = review.settings.dimensions
                            Text("\(size.0) × \(size.1) · " + (review.settings.captions ? "Editable captions, \(review.settings.captionStyle)" : "Captions omitted"))
                            Text("Creates separate compositions in one undoable edit. Original source files and timeline placements keep their timing.").font(.caption)
                            Button("Create reviewed compositions") {
                                let settings = shortSettings
                                transcript.perform(model: model, session: session) { token, backend in
                                    try await transcript.createReviewedShorts(model: model, session: session, settings: settings, token: token, backend: backend)
                                }
                            }.disabled(transcript.busy || (try? review.creationBody(current: transcript.shortsCapture(model: model, session: session), settings: shortSettings)) == nil)
                        }
                    }
                }
                Text("Suggestions use transcript content and sentence boundaries. Review the framing and sound before exporting.").font(.caption2).foregroundStyle(.secondary)
            }.nativePanelPadding()
        }
        .onAppear {
            transcript.attach(session: session)
            chooseRequestedSource()
        }
        .onChange(of: transcript.source) { _, _ in transcript.load(model: model, session: session) }
        .onChange(of: editingLocale) { _, focused in if !focused, !transcript.busy, !transcript.hasCurrentTranscript { transcript.load(model: model, session: session) } }
        .onChange(of: model.transcriptSource) { _, requested in if requested != nil { chooseRequestedSource() } }
        .onChange(of: model.folder) { _, _ in transcript.attach(session: session); model.transcriptSource = nil; chooseRequestedSource() }
        .onChange(of: model.processingContextID) { _, _ in transcript.attach(session: session); chooseRequestedSource() }
        .onChange(of: format) { _, _ in transcript.shortsReview = nil }
        .onChange(of: includeShortCaptions) { _, _ in transcript.shortsReview = nil }
        .onChange(of: captionStyle) { _, _ in transcript.shortsReview = nil }
        .onChange(of: captionSettings) { _, _ in transcript.captionReview = nil }
        .onChange(of: model.version) { _, _ in transcript.captionReview = nil }
        .onChange(of: model.composition) { _, _ in transcript.captionReview = nil; captionTrack = ""; replaceCaptions = false }
        .onDisappear { transcript.suspend() }
        .confirmationDialog("Discard unsaved transcript corrections?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Discard corrections", role: .destructive) {
                transcript.perform(model: model, session: session) { token, backend in
                    try await transcript.discardDurableDraft(model: model, session: session, token: token, backend: backend)
                }
            }
            Button("Keep corrections", role: .cancel) {}
        } message: { Text("The saved transcript will be loaded. This does not change the saved words.") }
    }

    private func copyRecoveryText(_ text: String) {
        #if os(iOS)
        UIPasteboard.general.string = text
        #elseif os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }

    @ViewBuilder private var captionControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Stepper("Characters per line: \(captionCharacters)", value: $captionCharacters, in: 16...80)
            Stepper("Maximum lines: \(captionLines)", value: $captionLines, in: 1...3)
            Toggle("Only selected timeline clip", isOn: $captionOnlySelected)
            Toggle("Burn captions into preview and export", isOn: $burnInCaptions)
            Picker("Caption destination", selection: $captionTrack) {
                Text("\(nextCaptionTrack) · New caption track").tag("")
                ForEach(model.tracks.filter { $0.kind == "caption" && !$0.locked }) { track in Text("\(track.id) · \(track.name)").tag(track.id) }
            }
            if !captionTrack.isEmpty {
                Toggle("Replace this track's captions", isOn: $replaceCaptions)
                Text("The selected style and burn-in choice apply to the whole destination track.").font(.caption2).foregroundStyle(.secondary)
            }
            Text("Times below use this composition's timeline. Edit generated cue text and appearance in the Caption inspector.").font(.caption2).foregroundStyle(.secondary)
            Button("Preview editable captions") {
                let settings = captionSettings
                transcript.perform(model: model, session: session) { token, backend in
                    try await transcript.reviewCaptions(model: model, session: session, settings: settings, token: token, backend: backend)
                }
            }.disabled(transcript.words.isEmpty || transcript.dirty || !transcript.hasCurrentTranscript || transcript.recognitionStatus == "stale")
        }.disabled(transcript.busy)
            .onChange(of: captionTrack) { _, value in if value.isEmpty { replaceCaptions = false } }
        if let review = transcript.captionReview {
            GroupBox("Caption preview") {
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(review.items.count) captions · \(review.settings.preset) · \(review.settings.track)")
                    Text(review.settings.replace ? "Replace existing captions in one undoable edit." : "Add captions in one undoable edit.").font(.caption)
                    Text(review.settings.burnIn ? "Captions appear in the picture and exported video." : "Captions remain editable and available for subtitle export.").font(.caption)
                    ForEach(Array(review.items.indices.prefix(200)), id: \.self) { index in
                        let cue = review.items[index]
                        Text("\(cue.number("t").formatted(.number.precision(.fractionLength(2)))) to \(cue.number("end").formatted(.number.precision(.fractionLength(2)))) seconds").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        Text(cue.string("text")).font(.callout)
                    }
                    if review.items.count > 200 { Text("\(review.items.count - 200) more captions will be created.").font(.caption) }
                    ForEach(Array(review.warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.caption).foregroundStyle(.secondary) }
                    Button(review.settings.replace ? "Replace reviewed captions" : "Create reviewed captions") {
                        let settings = captionSettings
                        transcript.perform(model: model, session: session) { token, backend in
                            try await transcript.createReviewedCaptions(model: model, session: session, settings: settings, token: token, backend: backend)
                        }
                    }.disabled(transcript.busy || (try? review.creationBody(current: transcript.captionCapture(model: model, session: session, settings: captionSettings), settings: captionSettings)) == nil)
                }
            }
        }
    }

    private func copyRetainedCorrections() {
        #if os(iOS)
        UIPasteboard.general.string = transcript.retainedCorrectionsText
        #elseif os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(transcript.retainedCorrectionsText, forType: .string)
        #endif
        transcript.message = "Unsaved corrections copied with source timings. This does not change the saved transcript."
    }

    private func chooseRequestedSource() {
        if let requested = model.transcriptSource {
            model.transcriptSource = nil
            guard !transcript.dirty || requested == transcript.source else {
                transcript.message = "Unsaved corrections retained. Save or discard this draft before choosing another source."
                return
            }
            guard sources.contains(where: { $0.id == requested }) else {
                if transcript.dirty { transcript.message = "Unsaved corrections retained. This source is no longer in the media browser." }
                else { transcript.source = ""; transcript.invalidate() }
                return
            }
            if transcript.source != requested { transcript.source = requested }
            else if !transcript.hasCurrentTranscript { transcript.load(model: model, session: session) }
        } else if transcript.source.isEmpty {
            let selected = model.selected?.source
            transcript.source = sources.first(where: { $0.id == selected })?.id ?? sources.first?.id ?? ""
        } else if !transcript.hasCurrentTranscript && !transcript.dirty {
            transcript.load(model: model, session: session)
        }
    }

    @ViewBuilder private var passageControls: some View {
        let indices = transcript.selectedWords.sorted().filter { transcript.words.indices.contains($0) }
        if let first = indices.first, let last = indices.last {
            let from = transcript.words[first].from, to = transcript.words[first...last].map(\.to).max() ?? transcript.words[last].to
            VStack(alignment: .leading, spacing: 8) {
                Text("Selected passage: \(from.formatted(.number.precision(.fractionLength(2)))) to \(to.formatted(.number.precision(.fractionLength(2)))) seconds").font(.caption)
                Text(transcript.words[first...last].map(\.text).joined(separator: " ")).font(.caption)
                HStack {
                    Button("Append passage") { placePassage(from: from, to: to, insert: false) }
                    Button("Insert at playhead") { placePassage(from: from, to: to, insert: true) }
                }
                Button("Lift from selected clip") {
                    guard let selected = model.selected, selected.source == transcript.source else { return }
                    var body: [String: Any] = ["id": selected.id, "ranges": [["from": from, "to": to]], "ripple": false, "apply": true, "expectedVersion": model.version]
                    if let comp = model.composition { body["comp"] = comp }
                    transcript.perform(model: model, session: session) { token, backend in
                        _ = try transcript.requireCurrentTranscript(session: session)
                        _ = try await model.call("/api/transcript/edit", body)
                        try transcript.check(token, backend: backend, session: session)
                        await model.refresh(); try transcript.check(token, backend: backend, session: session)
                        transcript.message = "Lifted the passage and its linked audio. Undo restores the edit."
                    }
                }.disabled(model.selected?.source != transcript.source)
                Button("Ask agent about passage") {
                    model.assistantDraft = "Edit this source passage, \(transcript.source), from \(from) to \(to) seconds: \(transcript.words[first...last].map(\.text).joined(separator: " "))"
                    model.panel = .assistant
                    #if os(iOS)
                    model.mobilePanel = .assistant
                    #endif
                }
            }.disabled(transcript.busy || transcript.dirty || !transcript.hasCurrentTranscript)
        }
    }

    private func placePassage(from: Double, to: Double, insert: Bool) {
        var operation: [String: Any] = ["op": insert ? "insert" : "append", "src": transcript.source, "in": from, "out": to]
        if insert { operation["start"] = model.time }
        if let comp = model.composition { operation["comp"] = comp }
        let version = model.version
        transcript.perform(model: model, session: session) { token, backend in
            _ = try transcript.requireCurrentTranscript(session: session)
            _ = try await model.call("/api/ops", ["ops": [operation], "who": "you", "summary": "Placed the transcript passage", "expectedVersion": version, "returnProject": true])
            try transcript.check(token, backend: backend, session: session)
            transcript.message = "Placed the passage as editable media and linked audio."
        }
    }

    private func seekWord(_ index: Int) {
        guard transcript.previewWord(index, model: model, session: session) else { return }
        #if os(iOS)
        // The viewer is behind the tool sheet; its disappearance retains the draft.
        model.mobilePanel = nil
        #endif
    }
}

private struct NativeTranscriptTimingEditor: View {
    @ObservedObject var transcript: NativeTranscriptState
    let model: NativeEditorModel
    let session: EditorSession
    let index: Int
    @State private var expanded = false
    @State private var start = ""
    @State private var end = ""
    @State private var error = ""

    var body: some View {
        DisclosureGroup("Edit word timing", isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Source seconds. Word starts must stay in transcript order.").font(.caption2).foregroundStyle(.secondary)
                HStack {
                    TextField("Start source seconds", text: $start).textFieldStyle(.roundedBorder)
                    TextField("End source seconds", text: $end).textFieldStyle(.roundedBorder)
                }
                Button("Apply word timing") {
                    guard let from = Double(start.trimmingCharacters(in: .whitespacesAndNewlines)),
                          let to = Double(end.trimmingCharacters(in: .whitespacesAndNewlines)) else {
                        error = "Enter a start and end in source seconds."; return
                    }
                    if transcript.updateWordTiming(index, from: from, to: to, model: model, session: session) { error = "" }
                    else { error = transcript.message }
                }
                if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
            }.padding(.top, 4)
        }.font(.caption).disabled(transcript.busy || !transcript.hasCurrentTranscript || transcript.recognitionStatus == "stale")
            .onChange(of: expanded) { _, showing in
                if showing, transcript.words.indices.contains(index) {
                    start = String(transcript.words[index].from); end = String(transcript.words[index].to); error = ""
                }
            }
            .onChange(of: transcript.words.indices.contains(index) ? transcript.words[index].from : -1) { _, value in start = String(value) }
            .onChange(of: transcript.words.indices.contains(index) ? transcript.words[index].to : -1) { _, value in end = String(value) }
    }
}

private struct NativeTimedTranscriptImportControls: View {
    @ObservedObject var transcript: NativeTranscriptState
    @ObservedObject var model: NativeEditorModel
    @ObservedObject var session: EditorSession
    @State private var picker: NativeTimedTranscriptWorkflow.Capture?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button("Import timed JSON, SRT or WebVTT") {
                do { picker = try transcript.timedImportCapture(model: model, session: session) }
                catch { transcript.message = error.localizedDescription }
            }.disabled(picker != nil || transcript.busy || transcript.dirty || !transcript.hasCurrentTranscript || transcript.recognitionStatus == "stale")
            Text("UTF-8 files up to 16 MB and 100000 words. JSON accepts an array or an object with a words array. Each word needs t, end and text in source seconds.").font(.caption2).foregroundStyle(.secondary)
            if let review = transcript.timedImportReview { importReview(review) }
        }
        .background {
            if let capture = picker {
                NativeTimedTranscriptPicker { result in
                    guard picker?.id == capture.id else { return }
                    picker = nil
                    guard (try? capture.matches(transcript.timedImportCapture(model: model, session: session))) == true else { return }
                    transcript.perform(model: model, session: session) { token, backend in
                        try await transcript.previewTimedImport(result, capture: capture, model: model, session: session, token: token, backend: backend)
                    }
                }.id(capture.id)
            }
        }
        .onDisappear { picker = nil }
        .onChange(of: scenePhase) { _, phase in if phase != .active { picker = nil } }
        .onChange(of: model.version) { _, _ in transcript.timedImportReview = nil }
    }

    private func importReview(_ review: NativeTimedTranscriptWorkflow.Review) -> some View {
        GroupBox("Review timed import") {
            VStack(alignment: .leading, spacing: 6) {
                Text("\(review.words.count) words for \(review.capture.record.string("src")), \(review.capture.record.string("locale"))")
                ForEach(review.warnings, id: \.self) { Text($0).font(.caption) }
                Text("Preview shows the first 20 words. Loading keeps them as unsaved corrections, where all words can be checked and edited.").font(.caption2).foregroundStyle(.secondary)
                ForEach(review.words.indices.prefix(20), id: \.self) { index in
                    let word = review.words[index]
                    Text("\(word.number("t").formatted(.number.precision(.fractionLength(3)))) to \(word.number("end").formatted(.number.precision(.fractionLength(3)))) seconds: \(word.string("text"))").font(.caption)
                }
                HStack {
                    Button("Load imported words as corrections") {
                        transcript.perform(model: model, session: session) { token, backend in
                            _ = try await transcript.acceptTimedImport(model: model, session: session, token: token, backend: backend)
                        }
                    }
                        .disabled(transcript.busy || (try? review.verify(current: transcript.timedImportCapture(model: model, session: session))) == nil)
                    Button("Discard import preview") { transcript.timedImportReview = nil }.disabled(transcript.busy)
                }
            }
        }
    }
}

private struct NativeTimedTranscriptPicker: View {
    let completion: (Result<[URL], Error>) -> Void
    @State private var presented = false
    @State private var started = false
    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .fileImporter(isPresented: $presented,
                          allowedContentTypes: [.json, .plainText, UTType(filenameExtension: "srt") ?? .plainText, UTType(filenameExtension: "vtt") ?? .plainText],
                          allowsMultipleSelection: false, onCompletion: completion)
            .onAppear { guard !started else { return }; started = true; presented = true }
    }
}
