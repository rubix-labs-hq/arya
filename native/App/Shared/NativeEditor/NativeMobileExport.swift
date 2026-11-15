#if os(iOS)
import BackgroundTasks
import Foundation
import ReelKit
import UIKit

/// Owns a user-started export across foreground and supported background execution.
@MainActor
final class NativeMobileExport: ObservableObject {
    static let shared = NativeMobileExport()
    static let identifier = (Bundle.main.bundleIdentifier ?? "app.reel.ios") + ".export"
    @Published private(set) var message = ""
    @Published private(set) var pending = false
    @Published private(set) var running = false
    @Published private(set) var starting = false
    private weak var session: EditorSession?
    private var worker: Task<Void, Never>?
    private var leases: [String: UIBackgroundTaskIdentifier] = [:]
    private var registered: Set<String> = []
    private var fallbackJobs: [String: ReelBackend] = [:]
    private var workerUsesGPU = false
    private var backgroundObserver: NSObjectProtocol?
    #if DEBUG
    var forceForegroundForTesting = false
    #endif
    private struct Request: Codable {
        let id: String
        let bookmark: Data
        let project: String
        let body: String
    }
    private var request: Request?
    private var file: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Reel/mobile-export.json")
    }

    private init() {
        request = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Request.self, from: $0) }
        pending = request != nil
        if pending { message = "An interrupted export can be resumed from Deliver." }
        #if !targetEnvironment(macCatalyst)
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.suspendForegroundGPU() }
        }
        #endif
    }

    var supportsGPU: Bool {
        #if DEBUG
        if forceForegroundForTesting { return false }
        #endif
        #if !targetEnvironment(macCatalyst)
        if #available(iOS 26, *) { return BGTaskScheduler.supportedResources.contains(.gpu) }
        #endif
        return false
    }
    private var canRunExport: Bool {
        #if targetEnvironment(macCatalyst)
        // Mac exports continue while another window or application has focus.
        return true
        #else
        return UIApplication.shared.applicationState == .active
        #endif
    }
    var canResume: Bool { pending && !starting && !running && worker == nil && fallbackJobs.isEmpty }

    func attach(_ session: EditorSession) { self.session = session }

    static func registerPreflight() {
        #if !targetEnvironment(macCatalyst)
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            Task { @MainActor in shared.preflight(task) }
        }
        if #available(iOS 26, *), let request = shared.request {
            do { try shared.registerContinuation(request.id) }
            catch { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: request.id); shared.message = "Background continuation is unavailable. Resume this export from Deliver." }
        }
        if shared.pending { shared.schedulePreflight() }
            #endif
    }

    func start(session: EditorSession, body: [String: Any]) async throws -> [String: Any] {
        guard !starting, !pending else {
            // A running export also counts as pending here; only an interrupted one needs Resume or Discard.
            throw ReelBackend.APIError(starting || running || worker != nil || !fallbackJobs.isEmpty
                ? "An export is already running. Start the next one when it finishes."
                : "Finish or discard the pending export before starting another.")
        }
        starting = true; defer { starting = false }
        guard canRunExport else { throw ReelBackend.APIError("Return to Arya before starting a GPU export on this device.") }
        guard !pending, let backend = session.backend, let folder = session.folder,
              let project = await backend.currentProject() else { throw ReelBackend.APIError("Finish or discard the pending export before starting another.") }
        guard session.backend === backend, canRunExport else { throw CancellationError() }
        self.session = session
        #if !targetEnvironment(macCatalyst)
        if #available(iOS 26, *), supportsGPU {
            let request = Request(id: Self.identifier + "." + UUID().uuidString, bookmark: try ProjectBookmarks.makeBookmark(folder), project: project, body: JSON(any: body).text)
            try store(request)
            let task = BGContinuedProcessingTaskRequest(identifier: request.id, title: "Export Arya composition", subtitle: body.string("name", "Arya export"))
            task.requiredResources = .gpu; task.strategy = .queue
            do {
                try registerContinuation(request.id)
                try BGTaskScheduler.shared.submit(task)
                message = "Export queued with background GPU support."
                return ["scheduled": true]
            } catch {
                clear()
                message = "Background GPU scheduling is unavailable. Keep Arya active while exporting."
            }
        } else { message = "Keep Arya active while exporting on this device." }
        #else
        message = "Exporting in Arya."
        #endif
        let fallback = Request(id: Self.identifier + "." + UUID().uuidString, bookmark: try ProjectBookmarks.makeBookmark(folder), project: project, body: JSON(any: body).text)
        try store(fallback)
        var spec = body; spec["expectedProject"] = project
        let result: JSON
        do { result = try await backend.handle(method: "POST", path: "/api/export", body: JSON(any: spec).text) }
        catch { if request?.id == fallback.id { clear() }; throw error }
        let fields = try JSON.parse(result.text) as? [String: Any] ?? [:]
        guard session.backend === backend, canRunExport else {
            _ = try? await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": fields.string("id")]).text)
            message = "Return to Arya to resume the export."; throw CancellationError()
        }
        session.nativeEditor.registerExportFeedback(fields)
        protectForegroundJob(backend, id: fields.string("id"), requestID: fallback.id)
        return fields
    }

    func resume() {
        guard canResume, let request else { return }
        guard canRunExport else { message = "Return to Arya to resume the export."; return }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: request.id)
        running = true; worker = Task { await run(request, task: nil) }
    }

    func discard() {
        guard canResume, let request else { return }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: request.id)
        clear(); message = "Queued export discarded."
    }

    @available(iOS 26, *)
    private func registerContinuation(_ id: String) throws {
        guard !registered.contains(id) else { return }
        let accepted = BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: .main) { task in
            Task { @MainActor in
                guard let request = self.request, request.id == task.identifier, self.worker == nil else { task.setTaskCompleted(success: false); return }
                self.running = true
                self.worker = Task { await self.run(request, task: task) }
                task.expirationHandler = { Task { @MainActor in self.worker?.cancel() } }
            }
        }
        guard accepted else { throw ReelBackend.APIError("The background GPU launch handler could not be registered.") }
        registered.insert(id)
    }

    private func run(_ request: Request, task: BGTask?) async {
        var backend: ReelBackend?, owned = false, scoped: URL?, jobID: String?, success = false
        workerUsesGPU = task != nil
        defer { worker = nil; workerUsesGPU = false; running = false; task?.setTaskCompleted(success: success); if let jobID { fallbackJobs[jobID] = nil } }
        do {
            if task == nil, !canRunExport { throw ReelBackend.APIError("Return to Arya to resume a GPU export.") }
            var stale = false
            let folder = try ProjectBookmarks.resolveBookmark(request.bookmark, stale: &stale)
            if folder.startAccessingSecurityScopedResource() { scoped = folder }
            let core = session?.editor.coreScript ?? Bundle.main.url(forResource: "editor", withExtension: nil)!.appendingPathComponent("reel-core.js")
            if let current = session?.backend, session?.folder?.standardizedFileURL == folder.standardizedFileURL { backend = current }
            else {
                let fresh = try ReelBackend(folder: ProjectFolder(root: folder), coreScript: core) { name, json in
                    guard name == "job" else { return }
                    Task { @MainActor in self.updateProgress(json, requestID: request.id, task: task) }
                }
                backend = fresh; owned = true; try await fresh.start()
            }
            try Task.checkCancellation()
            guard let backend, let current = await backend.currentProject(), Self.sameProject(current, request.project) else { throw ReelBackend.APIError("The queued project changed. Discard this export and start it again with the current timeline.") }
            if task == nil, !canRunExport { throw CancellationError() }
            var spec = try JSON.parse(request.body) as? [String: Any] ?? [:]; spec["expectedProject"] = request.project
            let result = try await backend.handle(method: "POST", path: "/api/export", body: JSON(any: spec).text)
            let started = try JSON.parse(result.text) as? [String: Any] ?? [:]
            jobID = started.string("id")
            if session?.backend === backend { session?.nativeEditor.registerExportFeedback(started) }
            guard let jobID, !jobID.isEmpty else { throw ReelBackend.APIError("The export did not return a job.") }
            if task == nil, !canRunExport { throw CancellationError() }
            if task == nil { fallbackJobs[jobID] = backend }
            message = "Exporting in Arya"
            // Long 4K exports can run past 30 minutes. The background task's expiration ends
            // this loop through cancellation; otherwise it waits for the job to finish.
            while !success {
                try Task.checkCancellation()
                let job = try await backend.handle(method: "GET", path: nativeQuery("/api/jobs/wait", ["id": jobID, "timeout": "1000"]), body: nil)
                updateProgress(job.text, requestID: request.id, task: task)
                let fields = try JSON.parse(job.text) as? [String: Any] ?? [:]
                if fields.string("state") == "done" { if session?.backend === backend { session?.nativeEditor.confirmExportFeedback(fields) }; success = true; message = "Export saved to \(fields.string("output"))"; clear(); break }
                if ["failed", "cancelled"].contains(fields.string("state")) { throw ReelBackend.APIError(fields.string("error", "Export cancelled.")) }
            }
            if !success { throw ReelBackend.APIError("Export timed out. Resume it from Deliver.") }
        } catch {
            if let backend, let jobID { _ = try? await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": jobID]).text) }
            message = error is CancellationError ? "Background time expired. Resume the export from Deliver." : error.localizedDescription
            schedulePreflight()
        }
        if owned { await backend?.stop() }
        scoped?.stopAccessingSecurityScopedResource()
    }

    private func updateProgress(_ json: String, requestID: String, task: BGTask?) {
        #if !targetEnvironment(macCatalyst)
        guard request?.id == requestID, let fields = try? JSON.parse(json) as? [String: Any] else { return }
        if #available(iOS 26, *), let task = task as? BGContinuedProcessingTask {
            task.progress.totalUnitCount = 1000
            task.progress.completedUnitCount = Int64(min(1, max(0, fields.number("progress"))) * 1000)
        }
            #endif
    }

    private func preflight(_ task: BGTask) {
        guard let request, worker == nil else { task.setTaskCompleted(success: true); return }
        let work = Task {
            var backend: ReelBackend?, scoped: URL?, success = false
            defer { task.setTaskCompleted(success: success) }
            do {
                var stale = false
                let folder = try ProjectBookmarks.resolveBookmark(request.bookmark, stale: &stale)
                if folder.startAccessingSecurityScopedResource() { scoped = folder }
                guard let root = Bundle.main.url(forResource: "editor", withExtension: nil) else { throw ReelBackend.APIError("Missing editor resources.") }
                let fresh = try ReelBackend(folder: ProjectFolder(root: folder), coreScript: root.appendingPathComponent("reel-core.js")) { _, _ in }
                backend = fresh; try await fresh.start(); try Task.checkCancellation()
                guard let current = await fresh.currentProject(), Self.sameProject(current, request.project) else { throw ReelBackend.APIError("The queued project changed.") }
                let body = try JSON.parse(request.body) as? [String: Any] ?? [:]
                let from = body.number("from"), to = min(body.number("to", from + 5), from + 5)
                let audio = try await fresh.renderAudio(from: from, to: max(from + 0.1, to), comp: body["comp"] as? String)
                try? FileManager.default.removeItem(at: audio)
                success = true; message = "Export sources checked. Resume the export from Deliver."
            } catch { message = error.localizedDescription }
            await backend?.stop(); scoped?.stopAccessingSecurityScopedResource()
        }
        task.expirationHandler = { work.cancel() }
    }

    private func protectForegroundJob(_ backend: ReelBackend, id: String, requestID: String) {
        guard !id.isEmpty else { return }
        fallbackJobs[id] = backend
        running = true
        #if !targetEnvironment(macCatalyst)
        leases[id] = UIApplication.shared.beginBackgroundTask(withName: "Arya export") {
            Task { @MainActor in
                _ = try? await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": id]).text)
                self.endLease(id); self.message = "Background time expired. Start the export again while Arya is active."
            }
        }
        #endif
        Task {
            var completed = false
            // Wait as long as the job runs. The background-task expiration handler above cancels
            // the job if the system ends Arya's time.
            while true {
                guard let json = try? await backend.handle(method: "GET", path: nativeQuery("/api/jobs/wait", ["id": id, "timeout": "1000"]), body: nil),
                      let job = try? JSON.parse(json.text) as? [String: Any] else { break }
                if job.string("state") == "done" { if session?.backend === backend { session?.nativeEditor.confirmExportFeedback(job) }; completed = true; if request?.id == requestID { clear(); message = "Export saved to \(job.string("output"))" }; break }
                if !["queued", "running"].contains(job.string("state")) { break }
            }
            if !completed { _ = try? await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": id]).text) }
            fallbackJobs[id] = nil
            running = false
            endLease(id)
        }
    }

    private func suspendForegroundGPU() {
        guard !fallbackJobs.isEmpty else { return }
        if !workerUsesGPU { worker?.cancel() }
        for (id, backend) in fallbackJobs {
            Task {
                _ = try? await backend.handle(method: "POST", path: "/api/jobs/cancel", body: JSON(any: ["id": id]).text)
                endLease(id)
            }
        }
        message = "Export paused when Arya entered the background. Resume it from Deliver."
        schedulePreflight()
    }

    private func endLease(_ id: String) { if let lease = leases.removeValue(forKey: id), lease != .invalid { UIApplication.shared.endBackgroundTask(lease) } }
    private func schedulePreflight() {
        #if !targetEnvironment(macCatalyst)
        guard pending else { return }
        let task = BGProcessingTaskRequest(identifier: Self.identifier)
        task.requiresExternalPower = true; task.requiresNetworkConnectivity = false
        task.earliestBeginDate = Date(timeIntervalSinceNow: 60)
        try? BGTaskScheduler.shared.submit(task)
            #endif
    }
    private func store(_ value: Request) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(value).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        request = value; pending = true
    }
    private func clear() { try? FileManager.default.removeItem(at: file); request = nil; pending = false }
    private static func sameProject(_ a: String, _ b: String) -> Bool {
        guard let left = try? JSONSerialization.jsonObject(with: Data(a.utf8)) as? NSDictionary,
              let right = try? JSONSerialization.jsonObject(with: Data(b.utf8)) as? NSDictionary else { return false }
        return left == right
    }
}

final class NativeMobileAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        NativeMobileExport.registerPreflight(); return true
    }
}
#endif
