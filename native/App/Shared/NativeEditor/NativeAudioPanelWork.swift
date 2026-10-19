import SwiftUI
import ReelKit

struct NativeAudioPanelOrigin {
    let backend: ReelBackend
    let folder: URL
    let context: UUID
    let revision: UUID
    let version: Int
    let composition: String?
    let primary: String?
    let selection: Set<String>
    let projectData: Data

    @MainActor init(_ model: NativeEditorModel) throws {
        guard let backend = model.captureAudioBackend(), let folder = model.folder,
              let project = model.project, let data = NativeInspectorWorkflow.canonical(project.fields) else {
            throw NativeInspectorWorkflow.Failure("Open a project before using the audio panel.")
        }
        self.backend = backend; self.folder = folder.standardizedFileURL
        context = model.processingContextID; revision = model.audioProjectRevision
        version = model.version; composition = model.composition
        primary = model.selectedID; selection = model.selectedIDs; projectData = data
    }
    @MainActor func backendMatches(_ model: NativeEditorModel) -> Bool {
        model.captureAudioBackend() === backend && model.folder?.standardizedFileURL == folder && model.processingContextID == context
    }
    @MainActor func matches(_ model: NativeEditorModel) -> Bool {
        backendMatches(model) && model.audioProjectRevision == revision && model.version == version && model.composition == composition && model.selectedID == primary && model.selectedIDs == selection && model.project.map { NativeInspectorWorkflow.canonical($0.fields) == projectData } == true
    }
    func call(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        let result = try await backend.handle(method: body == nil ? "GET" : "POST", path: path, body: body.map { JSON(any: $0).text })
        return try JSON.parse(result.text) as? [String: Any] ?? [:]
    }
}

@MainActor final class NativeMixMeasureWork: ObservableObject {
    @Published private(set) var running = false
    @Published private(set) var result: [String: Any] = [:]
    @Published private(set) var message: String?
    private var task: Task<Void, Never>?
    private var token = UUID()
    private var jobID: String?
    private var origin: NativeAudioPanelOrigin?
    private var settingsData: Data?

    func start(_ model: NativeEditorModel, settings: [String: Any], currentSettings: @escaping @MainActor () -> [String: Any]) {
        guard !running else { return }
        do {
            let origin = try NativeAudioPanelOrigin(model), token = UUID()
            guard let settingsData = NativeInspectorWorkflow.canonical(settings) else { throw NativeInspectorWorkflow.Failure("Choose valid mix settings.") }
            var request = settings
            request["comp"] = origin.composition as Any? ?? NSNull(); request["expectedVersion"] = origin.version
            request["uiAudioRequestID"] = token.uuidString; request["wait"] = false
            let capturedRequest = request
            self.token = token; self.origin = origin; self.settingsData = settingsData
            result = [:]; message = nil; running = true
            task = Task { @MainActor in
                var ownedJob: String?
                defer { if self.token == token { self.task = nil; self.running = false; self.jobID = nil } }
                do {
                    try Task.checkCancellation()
                    guard origin.matches(model), NativeInspectorWorkflow.canonical(currentSettings()) == settingsData else { throw CancellationError() }
                    var job = try await origin.call("/api/audio/measure-mix", capturedRequest)
                    guard let id = job["id"] as? String, !id.isEmpty else { throw NativeInspectorWorkflow.Failure("Mix measurement did not return a job.") }
                    ownedJob = id
                    if self.token == token { self.jobID = id }
                    while !["done", "failed", "cancelled"].contains(job.string("state")) {
                        try Task.checkCancellation()
                        guard self.token == token, origin.matches(model), NativeInspectorWorkflow.canonical(currentSettings()) == settingsData else { throw CancellationError() }
                        job = try await origin.call(nativeQuery("/api/jobs/wait", ["id": id, "timeout": "1000"]))
                    }
                    try Task.checkCancellation()
                    guard self.token == token, origin.matches(model), NativeInspectorWorkflow.canonical(currentSettings()) == settingsData else { throw CancellationError() }
                    guard job.string("state") == "done" else { throw NativeInspectorWorkflow.Failure(job.string("error", "Mix measurement failed.")) }
                    let result = job.dictionary("result")
                    guard result["expectedVersion"] as? Int == origin.version,
                          (result["comp"] as? String) == origin.composition,
                          result["uiAudioRequestID"] as? String == token.uuidString else { throw NativeInspectorWorkflow.Failure("Mix measurement returned a different capture.") }
                    self.result = result
                } catch {
                    await Self.cancelOwned(origin, id: ownedJob, requestID: token)
                    guard self.token == token, origin.matches(model), NativeInspectorWorkflow.canonical(currentSettings()) == settingsData else { return }
                    self.message = error is CancellationError ? "Mix measurement canceled." : error.localizedDescription
                }
            }
        } catch { message = error.localizedDescription }
    }
    func visible(_ model: NativeEditorModel, settings: [String: Any]) -> [String: Any] {
        guard origin?.matches(model) == true, NativeInspectorWorkflow.canonical(settings) == settingsData else { return [:] }
        return result
    }
    func cancel(clear: Bool = true) {
        if let origin, running {
            let id = jobID, requestID = token
            Task { await Self.cancelOwned(origin, id: id, requestID: requestID) }
        }
        token = UUID(); task?.cancel(); task = nil; jobID = nil; running = false
        if clear { result = [:]; message = nil; origin = nil; settingsData = nil }
        else { message = "Mix measurement canceled." }
    }
    private static func cancelOwned(_ origin: NativeAudioPanelOrigin, id: String?, requestID: UUID) async {
        if let id { _ = try? await origin.call("/api/jobs/cancel", ["id": id]); return }
        // A start request can finish after cancellation. Look up only this request on its captured backend.
        for _ in 0..<5 {
            if let jobs = try? await origin.call("/api/jobs"), let job = jobs.objects("jobs").first(where: { $0.dictionary("spec").string("uiAudioRequestID") == requestID.uuidString }) {
                _ = try? await origin.call("/api/jobs/cancel", ["id": job.string("id")]); return
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }
}

@MainActor enum NativeAudioEffectAdapter {
    static func submit(_ model: NativeEditorModel, origin: NativeAudioPanelOrigin?, kind: String, id: String, busID: String, currentBusID: @escaping @MainActor () -> String, edit: NativeAudioEffectEdit) {
        guard let origin, origin.matches(model), currentBusID() == busID else { nativeGestureRetry(model); return }
        model.perform {
            guard origin.matches(model), currentBusID() == busID else { throw NativeInspectorWorkflow.Failure("The audio target changed. Try the edit again.") }
            let operation: [String: Any]?
            if kind == "clip" {
                guard model.selectedID == id, let track = model.tracks.first(where: { $0.clips.contains { $0.id == id } }), !track.locked,
                      let clip = track.clips.first(where: { $0.id == id }) else { throw NativeInspectorWorkflow.Failure("Choose an unlocked clip.") }
                operation = try NativeAudioEffectPlanner.operation(clipFields: clip.fields, composition: origin.composition, edit: edit)
            } else {
                let fields: [String: Any]
                if kind == "track" {
                    guard let track = model.tracks.first(where: { $0.id == id }), !track.locked else { throw NativeInspectorWorkflow.Failure("Choose an unlocked track.") }
                    fields = track.fields
                } else if kind == "master", let project = model.project { fields = project.fields.dictionary("master") }
                else { throw NativeInspectorWorkflow.Failure("Choose a valid audio bus.") }
                guard NativeInspectorWorkflow.canonical(["fx": fields.objects("fx")]) == NativeInspectorWorkflow.canonical(["fx": edit.originalEffects]) else { throw NativeInspectorWorkflow.Failure("The bus effects changed. Try the edit again.") }
                guard ["anim", "expr"].allSatisfy({ key in !fields.dictionary(key).keys.contains(where: { $0.hasPrefix("fx.") }) }) else { throw NativeInspectorWorkflow.Failure("Track and master effect automation is unsupported. Edit clip effects instead.") }
                if NativeInspectorWorkflow.canonical(["fx": edit.effects]) == NativeInspectorWorkflow.canonical(["fx": edit.originalEffects]) { return }
                operation = kind == "master" ? ["op": "project", "comp": origin.composition as Any? ?? NSNull(), "set": ["master": ["fx": edit.effects]]] : ["op": "update_track", "id": id, "comp": origin.composition as Any? ?? NSNull(), "set": ["fx": edit.effects]]
            }
            guard let operation else { return }
            guard origin.matches(model), currentBusID() == busID else { throw CancellationError() }
            _ = try await origin.call("/api/ops", ["ops": [operation], "expectedVersion": origin.version, "returnProject": true, "who": "you", "summary": "Edit audio effects"])
            if origin.backendMatches(model) { await model.refresh() }
        }
    }
}
