import CoreGraphics
import CoreFoundation
import CryptoKit
import Foundation
import Darwin

/// What a host platform does for the backend that ReelKit cannot do without UI frameworks.
public protocol ReelPlatform: Sendable {
    /// Shows a file in the file manager, or opens it with its default app.
    func reveal(_ url: URL, open: Bool) async throws
}

/// The Reel backend for one project folder: the same API as the Node server
/// (docs/format.md section 3), answered in-process. JSON comes in and goes out as text;
/// pushes go to `events` as (name, JSON text). Ops run in the shared JavaScript core.
public actor ReelBackend {
    public typealias EventSink = @Sendable (_ name: String, _ json: String) -> Void
    public typealias TranscriptRecognizer = @Sendable (URL, Locale, Bool, ProjectFolder) async throws -> JSON
    public typealias MediaProber = @Sendable (URL) async throws -> JSON
    public typealias MusicRenderer = @Sendable (ProjectFolder, String, URL) async throws -> NativeMusicComposer.Rendered

    public struct APIError: Error, LocalizedError {
        public let message: String
        public init(_ message: String) { self.message = message }
        public var errorDescription: String? { message }
    }

    /// An exact retained-copy token failed before the retry registered any media.
    public struct RetainedMediaCopyChangedError: Error, LocalizedError, Sendable {
        public let path: String
        public var errorDescription: String? { "A retained copy changed or was replaced. No files from this retry were registered." }
    }

    /// Only this failed copy operation supplies the retained paths; callers must not parse its message.
    public struct RetainedMediaCopiesError: Error, LocalizedError, Sendable {
        public let message: String
        public let unregisteredCopies: [String]
        public let retainedCopyIdentities: [String: String]
        public let rootPath: String
        public let version: Int
        public let projectJSON: String?
        public var errorDescription: String? { message }
    }

    /// Export presets the in-page WebCodecs encoder can make (see editor/web/engine/export-webcodecs.js).
    public static let inPagePresets = ["h264-high", "h264-web", "h264-fast", "hevc", "audio-m4a", "audio-wav"]
    static let presetExtensions = ["h264-high": "mp4", "h264-web": "mp4", "h264-fast": "mp4", "hevc": "mp4", "audio-m4a": "m4a", "audio-wav": "wav"]

    public nonisolated let folder: ProjectFolder
    private let core: ReelCore
    private let coreScript: URL
    private let musicScript: URL
    private var musicComposing = false
    private let renderMusic: MusicRenderer
    private var renderer: ReelMetalRenderer?
    private let events: EventSink
    private let platform: ReelPlatform?
    private let recognizeTranscript: @Sendable (URL, Locale, Bool, ProjectFolder, Bool) async throws -> JSON
    private let customProbe: MediaProber?
    private let writeAdmission: @Sendable () throws -> Void
    private let projectFileAccess: ProjectFileAccess
    private let processingAdmission: NativeProcessingAdmission
    private let audioPreviewReuseOwner = UUID()
    #if DEBUG
    private var audioPreviewReuseEnabledForTesting = true
    private var audioPreviewReuseFills = 0, audioPreviewReuseHits = 0
    private var audioPreviewReuseTestBarrier: (@Sendable (String) async throws -> Void)?
    func setAudioPreviewReuseTestBarrier(_ barrier: (@Sendable (String) async throws -> Void)?) { audioPreviewReuseTestBarrier = barrier }
    func setAudioPreviewReuseEnabledForTesting(_ enabled: Bool) {
        audioPreviewReuseEnabledForTesting = enabled
        NativeAudioPreviewReuse.store.discard(owner: audioPreviewReuseOwner)
    }
    func audioPreviewReuseCountsForTesting() -> (fills: Int, hits: Int) { (audioPreviewReuseFills, audioPreviewReuseHits) }
    #endif
    private func audioPreviewReuseCheckpoint(_ stage: String) async throws {
        #if DEBUG
        try await audioPreviewReuseTestBarrier?(stage)
        #endif
    }

    private var project: String?
    private var version = 0
    private var projectGeneration = UUID()
    private var recoveryStore: NativeProjectRecovery.Store?
    private var restorationRootIdentity: (device: Int32, inode: UInt64)?
    private var lastText = ""
    private var projectFileLoaded = false
    private var projectFilePresent = false
    private var projectReadFailure: String?
    private var past: [String] = []
    private var future: [String] = []
    private var activity: [JSON] = []
    private var assistantChatHistory: NativeAssistantChatHistory?
    private var uiState: [(String, JSON)] = [("playhead", 0), ("selection", []), ("page", "edit")]
    /// Who made each recent commit, so the assistant can tell its own edits from the user's.
    private var commitOwners: [(version: Int, who: String)] = []
    private var jobs: [Job] = []
    private var subscribed = false
    private var watcher: DispatchSourceTimer?
    private var lastStat: (Date?, Int64) = (nil, -1)
    private var uploads: [String: URL] = [:]
    private struct DirectExportWrite {
        let generation: UUID
        let version: Int
        let nextPosition: UInt64
        let stamp: String
        let sources: NativeExportSources
        let parentStamp: String
    }
    private var directExportWrites: [String: DirectExportWrite] = [:]
    private var stopped = false
    private var nativeTasks: [String: Task<Void, Never>] = [:]
    private var directProcessingCancellations: [UUID: @Sendable () -> Void] = [:]
    private var mixAnalysisReservations: [String: UInt64] = [:]
    private var mixAnalysisMemoryLimit = NativeAudioMixer.memoryLimitBytes
    private var mixAnalysisDiskReservations: [String: UInt64] = [:]
    private var mixAnalysisDiskLimit: UInt64?
    private var mixAnalysisStorage: NativeAudioMixStorage?

    public init(folder: ProjectFolder, coreScript: URL, musicScript: URL? = nil, renderMusic: MusicRenderer? = nil, platform: ReelPlatform? = nil, probe: MediaProber? = nil, transcribe: TranscriptRecognizer? = nil, writeAdmission: @escaping @Sendable () throws -> Void = {}, projectFileAccess: ProjectFileAccess = ProjectFileAccess(), processingAdmission: NativeProcessingAdmission = .shared, events: @escaping EventSink) throws {
        self.folder = folder
        self.core = try ReelCore(scriptURL: coreScript)
        self.coreScript = coreScript
        self.musicScript = musicScript ?? coreScript.deletingLastPathComponent().appendingPathComponent("arya-music.js")
        if let renderMusic {
            self.renderMusic = renderMusic
        } else {
            self.renderMusic = { folder, score, script in try await NativeMusicComposer.render(folder: folder, scoreJSON: score, scriptURL: script) }
        }
        self.platform = platform
        self.customProbe = probe
        self.writeAdmission = writeAdmission
        self.projectFileAccess = projectFileAccess
        self.processingAdmission = processingAdmission
        self.recognizeTranscript = { file, locale, allowServer, folder, force in
            if let transcribe { return try await transcribe(file, locale, allowServer, folder) }
            return try await Transcriber.transcribe(file: file, cacheDir: folder.cacheDir, locale: locale, allowServer: allowServer, projectFolder: folder, force: force)
        }
        self.events = events
    }

    // MARK: lifecycle

    private func probe(_ file: URL) async throws -> JSON {
        if let customProbe { return try await customProbe(file) }
        return try await MediaProbe.probe(file)
    }

    /// Loads the project file (if any) and starts watching it for changes made elsewhere.
    public func start() throws {
        try requireOpen()
        try FileManager.default.createDirectory(at: folder.output(".reel/cache"), withIntermediateDirectories: true)
        _ = try folder.output(".reel/cache")
        try loadFromDisk()
        assistantChatHistory = NativeAssistantChatHistory(folder: folder)
        if project == nil, let offer = try? projectRecoveryOffer(), !offer.choices.isEmpty {
            throw APIError("The project file is missing. Choose a saved recovery copy before editing.")
        }
        if projectFilePresent, (try? writeAdmission()) != nil {
            do {
                let store = try recoveryStorage()
                try store.snapshot(Data(lastText.utf8), source: Data(lastText.utf8), validate: core.validateRecoveryProject)
            } catch { pushActivity("reel", "The project opened, but its recovery snapshot failed: \(error.localizedDescription)") }
        }
        if restorationRootIdentity == nil {
            let root = try NativeMissingMediaRestore.rootIdentity(folder)
            restorationRootIdentity = (root.st_dev, root.st_ino)
        }
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 0.7, repeating: 0.7)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            Task { await self.checkDisk() }
        }
        timer.resume()
        watcher = timer
    }

    public func stop() {
        stopped = true
        NativeAudioPreviewReuse.store.discard(owner: audioPreviewReuseOwner)
        // Captured jobs and directories retain their storage until actual worker exit.
        mixAnalysisStorage = nil
        subscribed = false
        watcher?.cancel()
        watcher = nil
        for task in nativeTasks.values { task.cancel() }
        for cancel in directProcessingCancellations.values { cancel() }
        // Worker epilogues retain ownership and release admission after actual exit.
        directExportWrites.removeAll()
        for job in jobs where job.state == "running" || job.state == "queued" {
            fail(job, "the project was closed")
        }
    }

    public func subscribe() { if !stopped { subscribed = true } }

    public func cancelExports(reason: String) {
        for job in jobs where job.state == "running" || job.state == "queued" { nativeTasks[job.id]?.cancel(); fail(job, reason) }
    }

    /// The current project as JSON text, or nil before one exists.
    public func currentProject() -> String? { project }
    public func currentVersion() -> Int { version }

    // BEGIN ASSISTANT CHANGES
    /// Owners of the commits after `after`, oldest first; nil when a version change was not a
    /// recorded commit (a disk reload or recovery).
    public func commitOwners(after: Int) -> [String]? {
        let owners = commitOwners.filter { $0.version > after }.map(\.who)
        return owners.count == version - after ? owners : nil
    }

    /// The shared suggestion rules for the selection or the timeline, as a JSON array.
    public func assistantSuggestions(selection: [String], composition: String?) -> String {
        guard let project else { return "[]" }
        let options = JSON.compact([("selection", .array(selection.map(JSON.string))), ("comp", JSON.str(composition))])
        return (try? core.assistantSuggestions(project: project, options: options.text)) ?? "[]"
    }

    public struct AssistantPreview: Sendable {
        public let project: String, log: String, created: String, outline: String, assets: String
        public let steps: [String]
    }

    /// Checks proposed ops and processing steps against the project without saving them.
    public func previewAssistantChange(ops: String, steps: [String]) async throws -> AssistantPreview {
        guard let project else { throw APIError("No project yet: create one first.") }
        var assets: [(String, JSON)] = []
        for src in try core.unknownSources(project: project, ops: ops) { assets.append((src, try await probe(try folder.resolve(src)))) }
        guard let current = self.project else { throw APIError("the project was closed") }
        let all = assets.isEmpty ? ops : try core.prependImport(ops: ops, assets: JSON.compact(assets).text)
        let result = try core.applyOps(project: current, ops: all)
        return AssistantPreview(project: result.project, log: result.log, created: result.created, outline: try core.outline(project: result.project),
                                assets: JSON.compact(assets).text, steps: try steps.map { try core.describeStep(project: result.project, step: $0) })
    }

    /// Restores the project from before an assistant change as one undoable edit, only while
    /// the project is still exactly the result of that change.
    public func restoreAssistantChange(_ snapshot: String, expected: String, line: String) throws -> Int {
        guard let current = project, current == expected else { throw APIError("The project changed after this assistant change. Use Undo step by step.") }
        try commit(snapshot, who: "you", lines: [line])
        return version
    }

    /// The project a preview or an assistant change was made against. Every opened project gets
    /// its own backend that starts at version 1, so a version alone cannot tell two projects
    /// apart; the backend identity and the exact project text can.
    public struct AssistantBase: Sendable, Equatable {
        public let backend: ObjectIdentifier
        public let version: Int
        public let project: String
        /// Whether `backend` is the backend this base was captured from (a cheap check for views).
        public func belongs(to backend: ReelBackend?) -> Bool { backend.map(ObjectIdentifier.init) == self.backend }
    }

    public func assistantBase() -> AssistantBase? {
        project.map { AssistantBase(backend: ObjectIdentifier(self), version: version, project: $0) }
    }

    /// Whether this backend still holds exactly the project `base` was captured from.
    public func isCurrent(_ base: AssistantBase) -> Bool {
        base.backend == ObjectIdentifier(self) && base.version == version && base.project == project
    }

    /// The owner recorded for a processing request's commits: the assistant when it asked, else the user.
    static func processingRequester(_ body: [String: Any]) -> String {
        let who = body["who"] as? String ?? "you"
        return ["agent", "claude"].contains(who) ? who : "you"
    }
    // END ASSISTANT CHANGES
    public func assistantHistorySnapshot() throws -> JSON {
        try requireOpen()
        guard let assistantChatHistory else { throw APIError("Wait for the project history to load.") }
        return assistantChatHistory.snapshot
    }
    public func appendAssistantHistory(_ message: JSON) throws -> JSON {
        try Task.checkCancellation()
        try requireOpen()
        guard let assistantChatHistory else { throw APIError("Wait for the project history to load.") }
        return try assistantChatHistory.append(message) {
            try Task.checkCancellation()
            try requireWritableProject()
        }
    }

    public func refreshProjectFile() throws {
        try requireOpen()
        let before = version
        try loadFromDisk()
        if version != before, let project { broadcast("project", .object([("project", .raw(project)), ("version", .int(version)), ("who", "disk")])) }
    }

    private struct PreparedAudioRange: Sendable {
        let plan: String
        let window: NativeAudioRenderRange
    }

    private func prepareAudioRange(project snapshot: String, from: Double, to: Double,
                                   output: NativeAudioMixCapture.Output = .master,
                                   rounding: NativeAudioRenderRange.Rounding,
                                   planningBudget: UInt64 = NativeAudioMixer.memoryLimitBytes / 4) throws -> PreparedAudioRange {
        guard from.isFinite, from >= 0, to.isFinite, to > from, to - from <= 3600 else { throw APIError("Choose a finite, non-empty audio range under one hour.") }
        try Task.checkCancellation()
        let scope = try JSON.parse(snapshot) as? [String: Any] ?? [:]
        try validateMixPlanningMemory(scope, seconds: to, budget: planningBudget)
        let overview = try filterMixPlan(core.audioPlan(project: snapshot, from: 0, to: to), output: output)
        let history = try NativeAudioMixer.previewHistory(plan: .raw(overview))
        let window = try NativeAudioRenderRange(from: from, to: to, history: history, rounding: rounding)
        try validateMixPlanningMemory(scope, seconds: window.end, budget: planningBudget)
        try Task.checkCancellation()
        let plan = try filterMixPlan(core.audioPlan(project: snapshot, from: window.begin, to: window.end), output: output)
        try NativeAudioMixer.validate(plan: .raw(plan), additionalBytes: window.cropBytes)
        return .init(plan: plan, window: window)
    }

    /// A snapshot mix for native playback or export. The caller may remove the returned cache file.
    public func renderAudio(from: Double, to: Double, comp: String? = nil) async throws -> URL {
        if ProcessingScope.context == nil {
            return try await withProcessingAdmission(["comp": comp.map { $0 as Any } ?? NSNull()]) { try await self.renderAudio(from: from, to: to, comp: comp) }
        }

        try requireOpen()
        let snapshot = try projectView(comp: comp)
        try validateMixPlanningMemory((try JSON.parse(snapshot) as? [String: Any]) ?? [:], seconds: to, budget: processingAdmission.workerByteLimit / 4)
        let prepared = try prepareAudioRange(project: snapshot, from: from, to: to, rounding: .delivery)
        let rendered = try await NativeAudioMixer.render(plan: .raw(prepared.plan), folder: folder)
        let pcm = try await NativeAudioProcessing.cancellableTask { try prepared.window.trim(rendered) }
        try Task.checkCancellation(); try requireOpen()
        let file = try Self.exportFile(folder.cacheDir.appendingPathComponent("mix-\(UUID().uuidString).wav"), folder: folder)
        try NativeAudioProcessing.write(pcm, to: file)
        return file
    }

    /// Playback and delivery share verified DSP and crop graph-derived history after rendering.
    public func renderAudioPreview(from: Double, to: Double, comp: String? = nil) async throws -> ReelAudioPreview {
        if ProcessingScope.context == nil {
            do {
                return try await withProcessingAdmission(["comp": comp.map { $0 as Any } ?? NSNull()], preservingAudioPreviewReuse: true) { try await self.renderAudioPreview(from: from, to: to, comp: comp) }
            } catch {
                NativeAudioPreviewReuse.store.discard(owner: audioPreviewReuseOwner)
                throw error
            }
        }

        try requireOpen()
        guard from.isFinite, to.isFinite, from >= 0, to > from, to-from <= 30 else { throw APIError("Audio preview chunks must last at most 30 seconds.") }
        let capturedProject = project, capturedVersion = version
        let snapshot = try projectView(comp: comp)
        let scope = (try JSON.parse(snapshot) as? [String: Any]) ?? [:]
        let trackIDs = (scope["tracks"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
        try validateMixPlanningMemory(scope, seconds: to, budget: processingAdmission.workerByteLimit / 4)
        let prepared = try prepareAudioRange(project: snapshot, from: from, to: to, rounding: .playback)
        let window = prepared.window
        do {
            if let reused = try await renderReusedAudioPreview(prepared: prepared, snapshot: snapshot, scope: scope, trackIDs: trackIDs,
                                                             from: from, to: to, comp: comp, capturedProject: capturedProject, capturedVersion: capturedVersion) {
                return reused
            }
        } catch {
            NativeAudioPreviewReuse.store.discard(owner: audioPreviewReuseOwner)
            throw error
        }
        // The original path may need its entire budget. No retained crop competes with it.
        NativeAudioPreviewReuse.store.evictBeforeOtherProcessing()
        await NativeWorkerDrain.untilStopped { NativeAudioPreviewReuse.store.reservedBytes == 0 }
        try validateCurrentProcessing()
        let rendered = try await NativeAudioMixer.renderWithMeters(plan: .raw(prepared.plan), folder: folder, preview: true, meterRange: window.samples)
        try requireOpen()
        try Task.checkCancellation()
        guard capturedProject == project, capturedVersion == version else { throw APIError("The project changed while audio was preparing. Start playback again.") }
        let trimmed = try await NativeAudioProcessing.cancellableTask { try window.trim(rendered.pcm) }
        try requireOpen(); try Task.checkCancellation()
        guard capturedProject == project, capturedVersion == version else { throw APIError("The project changed while audio was preparing. Start playback again.") }
        let owned = try writeOwnedAudioPreview(trimmed)
        return .init(url: owned.url, offset: 0, duration: trimmed.duration, historySeconds: window.historySeconds, residualDB: -100,
                     composition: comp, version: capturedVersion, requestID: UUID(), meters: rendered.meters.includingSilence(trackIDs: trackIDs))
    }

    private func renderReusedAudioPreview(prepared: PreparedAudioRange, snapshot: String, scope: [String: Any], trackIDs: [String],
                                         from: Double, to: Double, comp: String?, capturedProject: String?, capturedVersion: Int) async throws -> ReelAudioPreview? {
        #if DEBUG
        guard audioPreviewReuseEnabledForTesting else { return nil }
        #endif
        // Shared admission serializes active workers. Custom admissions retain their original path.
        guard processingAdmission === NativeProcessingAdmission.shared, ProcessingScope.context?.allowsAudioPreviewReuse == true,
              NativeAudioPreviewReuse.scopeIsStatic(scope),
              let samples = NativeAudioPreviewReuse.exactSamples(from: from, to: to, window: prepared.window),
              let profile = try NativeAudioPreviewReuse.profile(prepared.plan) else { return nil }
        let store = NativeAudioPreviewReuse.store
        let identity = NativeAudioPreviewReuse.Identity(owner: audioPreviewReuseOwner, generation: projectGeneration, version: capturedVersion,
            composition: comp, projectDigest: NativeAudioPreviewReuse.digest(capturedProject ?? ""), snapshotDigest: NativeAudioPreviewReuse.digest(snapshot),
            diskDigest: NativeAudioPreviewReuse.digest(lastText), root: folder.root.path, rootIdentity: try processingRootStamp(),
            parentIdentity: try NativeAudioPreviewReuse.directoryIdentity(folder.root.deletingLastPathComponent()), revision: NativeAudioPreviewReuse.revision)
        if let entry = store.borrow(identity: identity, samples: samples, profile: profile) {
            do {
                let currentSources = try NativeAudioPreviewReuse.freshSources(entry.sources, folder: folder)
                guard NativeAudioPreviewReuse.canHashSources(currentSources) else {
                    store.discard(owner: audioPreviewReuseOwner); return nil
                }
                let folder = self.folder
                try await audioPreviewReuseCheckpoint("beforeSourceHash")
                let current = try await NativeAudioProcessing.cancellableTask { try NativeAudioPreviewReuse.sourceIdentities(currentSources, folder: folder) }
                try await audioPreviewReuseCheckpoint("afterSourceHash")
                try validateCurrentProcessing()
                if current == entry.sources {
                    let headroom = store.reservedBytes + prepared.window.cropBytes * 2 + UInt64(ReelAudioBusMeters.maximumBytes) * 2
                    guard headroom <= processingAdmission.workerByteLimit else { store.discard(owner: audioPreviewReuseOwner); return nil }
                    let result = try await NativeAudioProcessing.cancellableTask { try entry.slice(samples) }
                    try await audioPreviewReuseCheckpoint("afterSlice")
                    let preview = try await finishReusedAudioPreview(pcm: result.0, meters: result.1, entry: entry, prepared: prepared,
                        trackIDs: trackIDs, comp: comp, capturedProject: capturedProject, capturedVersion: capturedVersion)
                    store.consumed(entry, through: samples.upperBound)
                    #if DEBUG
                    audioPreviewReuseHits += 1
                    #endif
                    return preview
                }
            } catch is CancellationError { throw CancellationError() }
            catch {
                try Task.checkCancellation(); try validateCurrentProcessing()
                guard try processingRootStamp() == identity.rootIdentity,
                      try NativeAudioPreviewReuse.directoryIdentity(folder.root.deletingLastPathComponent()) == identity.parentIdentity else {
                    throw APIError("The audio preview folder changed while checking retained audio.")
                }
                store.discard(owner: audioPreviewReuseOwner)
                return nil
            }
        }
        store.discard(owner: audioPreviewReuseOwner)
        // Meter bins are anchored at the first output frame. Only whole bins may be split.
        guard samples.count % 2400 == 0 else { return nil }
        let token = store.publicationToken()
        for chunks in [3, 2] {
            let ownedBefore = Set(ProcessingScope.context?.ownedAudioPreviews.keys.map { $0 } ?? [])
            do {
                try Task.checkCancellation()
                // A caller's accumulated Double can ceil its support one frame beyond the
                // sample-grid endpoint. Retain one extra frame so that request stays reusable.
                let forwardTo = Double(samples.lowerBound + chunks * samples.count + 1) / 48000
                let forward: PreparedAudioRange
                do {
                    forward = try prepareAudioRange(project: snapshot, from: from, to: forwardTo, rounding: .playback,
                                                    planningBudget: processingAdmission.workerByteLimit / 4)
                } catch { try Task.checkCancellation(); continue }
                guard let forwardSamples = NativeAudioPreviewReuse.exactSamples(from: from, to: forwardTo, window: forward.window),
                      let forwardProfile = try NativeAudioPreviewReuse.profile(forward.plan), forwardProfile.containsPrefix(profile) else { continue }
                let sources = try NativeAudioMixCapture.sources(plan: forward.plan, folder: folder, diskLimit: UInt64.max)
                guard NativeAudioPreviewReuse.canHashSources(sources),
                      let retainedBytes = forwardProfile.retentionBytes(frames: forwardSamples.count, sources: sources),
                      let credit = store.reserve(retainedBytes) else { continue }
                let extra = store.reservedBytes + prepared.window.cropBytes * 2 + UInt64(ReelAudioBusMeters.maximumBytes) * 2
                guard (try? NativeAudioMixer.validate(plan: .raw(forward.plan), limit: processingAdmission.workerByteLimit, additionalBytes: extra)) != nil else {
                    withExtendedLifetime(credit) {}; continue
                }
                let folder = self.folder
                try await audioPreviewReuseCheckpoint("beforeSourceHash")
                let sourceIdentities = try await NativeAudioProcessing.cancellableTask { try NativeAudioPreviewReuse.sourceIdentities(sources, folder: folder) }
                try await audioPreviewReuseCheckpoint("afterSourceHash")
                try validateCurrentProcessing()
                try await audioPreviewReuseCheckpoint("beforeDecodeAndDSP")
                let rendered = try await NativeAudioMixer.renderWithMeters(plan: .raw(forward.plan), folder: folder, preview: true, meterRange: forward.window.samples)
                try await audioPreviewReuseCheckpoint("afterDecodeAndDSP")
                try validateCurrentProcessing()
                let crop = try await NativeAudioProcessing.cancellableTask { try forward.window.trim(rendered.pcm) }
                try await audioPreviewReuseCheckpoint("afterCrop")
                try validateCurrentProcessing()
                guard rendered.meters.valid else { return nil }
                let entry = NativeAudioPreviewReuse.Entry(identity: identity, sources: sourceIdentities, profile: forwardProfile, samples: forwardSamples,
                    pcm: crop, meters: rendered.meters, credit: credit)
                let result = try await NativeAudioProcessing.cancellableTask { try entry.slice(samples) }
                let preview = try await finishReusedAudioPreview(pcm: result.0, meters: result.1, entry: entry, prepared: prepared,
                    trackIDs: trackIDs, comp: comp, capturedProject: capturedProject, capturedVersion: capturedVersion)
                try await audioPreviewReuseCheckpoint("beforeCachePublication")
                try validateCurrentProcessing()
                store.publish(entry, nextFrame: samples.upperBound, token: token)
                #if DEBUG
                audioPreviewReuseFills += 1
                #endif
                return preview
            } catch is CancellationError { throw CancellationError() }
            catch {
                if let context = ProcessingScope.context {
                    for id in Array(context.ownedAudioPreviews.keys) where !ownedBefore.contains(id) {
                        context.ownedAudioPreviews.removeValue(forKey: id)?.cleanup()
                    }
                }
                // A speculative future source or its larger render can fail while the
                // requested range remains valid. Preserve the original render's verdict.
                try Task.checkCancellation(); try validateCurrentProcessing()
                guard try processingRootStamp() == identity.rootIdentity,
                      try NativeAudioPreviewReuse.directoryIdentity(folder.root.deletingLastPathComponent()) == identity.parentIdentity else {
                    throw APIError("The audio preview folder changed while preparing its forward range.")
                }
                store.discard(owner: audioPreviewReuseOwner)
                return nil
            }
        }
        return nil
    }

    private func finishReusedAudioPreview(pcm: NativeAudioProcessing.PCM, meters: ReelAudioBusMeters, entry: NativeAudioPreviewReuse.Entry,
                                         prepared: PreparedAudioRange, trackIDs: [String], comp: String?, capturedProject: String?, capturedVersion: Int) async throws -> ReelAudioPreview {
        try validateCurrentProcessing()
        guard project == capturedProject, version == capturedVersion, projectGeneration == entry.identity.generation,
              try processingRootStamp() == entry.identity.rootIdentity,
              try NativeAudioPreviewReuse.directoryIdentity(folder.root.deletingLastPathComponent()) == entry.identity.parentIdentity else {
            throw APIError("The project changed while audio was preparing. Start playback again.")
        }
        try await audioPreviewReuseCheckpoint("beforeWrite")
        let owned = try writeOwnedAudioPreview(pcm)
        var complete = false
        defer {
            if !complete { owned.cleanup(); ProcessingScope.context?.ownedAudioPreviews[owned.id] = nil }
        }
        try await audioPreviewReuseCheckpoint("afterWrite")
        let folder = self.folder, expected = entry.sources
        let checked = try await NativeAudioProcessing.cancellableTask {
            try NativeAudioPreviewReuse.sourceIdentities(expected.map(\.source), folder: folder)
        }
        try validateCurrentProcessing()
        guard checked == expected, project == capturedProject, version == capturedVersion,
              projectGeneration == entry.identity.generation,
              try NativeAudioPreviewReuse.directoryIdentity(owned.url.deletingLastPathComponent()) == owned.parentIdentity,
              try NativeAudioPreviewReuse.directoryIdentity(folder.root.deletingLastPathComponent()) == entry.identity.parentIdentity else {
            throw APIError("An audio source or project changed while preview was preparing. Start playback again.")
        }
        try Task.checkCancellation()
        complete = true
        return .init(url: owned.url, offset: 0, duration: pcm.duration, historySeconds: prepared.window.historySeconds, residualDB: -100,
                     composition: comp, version: capturedVersion, requestID: UUID(), meters: meters.includingSilence(trackIDs: trackIDs))
    }

    private final class OwnedAudioPreviewOutput: @unchecked Sendable {
        let id: UUID, url: URL, folder: ProjectFolder
        let stamp: NativeAudioMixCapture.Stamp, rootIdentity: String, parentIdentity: String
        init(id: UUID, url: URL, folder: ProjectFolder, stamp: NativeAudioMixCapture.Stamp, rootIdentity: String, parentIdentity: String) {
            self.id = id; self.url = url; self.folder = folder; self.stamp = stamp
            self.rootIdentity = rootIdentity; self.parentIdentity = parentIdentity
        }
        var isCurrent: Bool {
            (try? NativeAudioPreviewReuse.directoryIdentity(folder.root)) == rootIdentity &&
                (try? NativeAudioPreviewReuse.directoryIdentity(url.deletingLastPathComponent())) == parentIdentity &&
                (try? NativeAudioMixCapture.fileStamp(url.path)) == stamp && (try? folder.output(url.path)) == url
        }
        func cleanup() {
            guard isCurrent else { return }
            try? FileManager.default.removeItem(at: url)
        }
    }
    private func writeOwnedAudioPreview(_ pcm: NativeAudioProcessing.PCM) throws -> OwnedAudioPreviewOutput {
        guard let context = ProcessingScope.context else { throw APIError("Audio preview needs its processing owner.") }
        try validateProcessingContext(context)
        let id = UUID(), url = try folder.output(folder.cacheDir.appendingPathComponent("mix-\(id.uuidString).wav").path)
        let rootIdentity = try processingRootStamp(), parentIdentity = try NativeAudioPreviewReuse.directoryIdentity(url.deletingLastPathComponent())
        do { try NativeAudioProcessing.write(pcm, to: url) }
        catch {
            if let stamp = try? NativeAudioMixCapture.fileStamp(url.path) {
                OwnedAudioPreviewOutput(id: id, url: url, folder: folder, stamp: stamp, rootIdentity: rootIdentity, parentIdentity: parentIdentity).cleanup()
            }
            throw error
        }
        let owned = OwnedAudioPreviewOutput(id: id, url: url, folder: folder, stamp: try NativeAudioMixCapture.fileStamp(url.path),
                                          rootIdentity: rootIdentity, parentIdentity: parentIdentity)
        context.ownedAudioPreviews[id] = owned
        return owned
    }

    private func projectView(comp: String?) throws -> String {
        guard let project else { throw APIError("No project yet.") }
        guard let comp else { return project }
        var p = (try JSON.parse(project) as? [String: Any]) ?? [:]
        guard let composition = (p["comps"] as? [String: [String: Any]])?[comp] else { throw APIError("No composition \(comp).") }
        p["tracks"] = composition["tracks"]
        p["markers"] = composition["markers"] ?? []
        for key in ["width", "height", "fps", "background"] { if let value = composition[key] { p[key] = value } }
        p["compId"] = comp
        return JSON(any: p).text
    }

    public func editOperations(ops: JSON, who: String = "you", summary: String? = nil, expectedVersion: Int? = nil) async throws -> JSON {
        try requireOpen()
        try requireWritableProject()
        let body = JSON.compact([("ops", ops), ("who", .string(who)), ("summary", JSON.str(summary)), ("expectedVersion", expectedVersion.map(JSON.int))])
        return try await applyOps(body.text, (try JSON.parse(body.text) as? [String: Any]) ?? [:])
    }

    private func requireOpen() throws {
        try Task.checkCancellation()
        guard !stopped else { throw APIError("the project was closed") }
    }

    private final class ProcessingContext: @unchecked Sendable {
        let generation: UUID
        let root: String
        let rootStamp: String
        let composition: String?
        let sources: [(String, String)]
        let lease: NativeProcessingAdmission.Lease
        let allowsAudioPreviewReuse: Bool
        var ownedAudioPreviews: [UUID: OwnedAudioPreviewOutput] = [:]
        var version: Int
        var project: String
        var diskText: String
        var exportPublished = false
        init(generation: UUID, root: String, rootStamp: String, composition: String?, sources: [(String, String)],
             lease: NativeProcessingAdmission.Lease, version: Int, project: String, diskText: String, allowsAudioPreviewReuse: Bool = false) {
            self.generation = generation; self.root = root; self.rootStamp = rootStamp; self.composition = composition
            self.sources = sources; self.lease = lease; self.version = version; self.project = project; self.diskText = diskText
            self.allowsAudioPreviewReuse = allowsAudioPreviewReuse
        }
    }
    private enum ProcessingScope { @TaskLocal static var context: ProcessingContext? }
    private static let directProcessingRoutes: Set<String> = [
        "/api/strip", "/api/proxy", "/api/peaks", "/api/analyze", "/api/captions/from-transcript",
        "/api/audio/clean", "/api/audio/denoise", "/api/audio/restore", "/api/audio/loudnorm", "/api/multicam/sync",
        "/api/analysis/track", "/api/tracking/track", "/api/analysis/saliency", "/api/analysis/autoreframe",
        "/api/frame", "/api/looks/match", "/api/audio/compose", "/api/audio/duck-plan",
    ]
    private func processingRootStamp() throws -> String {
        let info = try NativeMissingMediaRestore.rootIdentity(folder)
        return "\(info.st_dev)|\(info.st_ino)"
    }
    private func processingSourceStamp(_ src: String, allowMissing: Bool = false) throws -> String {
        let url = try folder.resolve(src)
        var info = Darwin.stat()
        if url.path.withCString({ Darwin.lstat($0, &info) }) != 0 {
            if allowMissing, errno == ENOENT { return "missing|\(url.path)" }
            throw APIError("Processing needs an existing regular source file: \(src).")
        }
        guard info.st_mode & S_IFMT == S_IFREG else { throw APIError("Processing needs a regular source file: \(src).") }
        return "\(url.path)|\(info.st_dev)|\(info.st_ino)|\(info.st_size)|\(info.st_mtimespec.tv_sec)|\(info.st_mtimespec.tv_nsec)|\(info.st_ctimespec.tv_sec)|\(info.st_ctimespec.tv_nsec)"
    }
    private func captureProcessingContext(_ body: [String: Any], allSources: Bool = false, preservingAudioPreviewReuse: Bool = false) throws -> ProcessingContext {
        try requireOpen()
        guard let project, projectFileLoaded, project.utf8.count <= 32 * 1024 * 1024 else { throw APIError("Open a project of at most 32 MiB before processing.") }
        if let expected = body["expectedVersion"] as? Int, expected != version { throw APIError("The queued project changed. Refresh before processing.") }
        if let expected = body["expectedProject"] as? String {
            guard let supplied = try JSON.parse(expected) as? NSDictionary, let current = try JSON.parse(project) as? NSDictionary, supplied == current else { throw APIError("The captured page project changed. Refresh before processing.") }
        }
        let composition = body["comp"] as? String
        _ = try projectView(comp: composition)
        var refs = Set(body["sources"] as? [String] ?? [])
        if let src = body["src"] as? String, !src.isEmpty { refs.insert(src) }
        if body["clip"] != nil, let src = try processingTarget(body)?.clip["src"] as? String { refs.insert(src) }
        if allSources {
            let fields = try JSON.parse(project) as? [String: Any] ?? [:]
            for (src, value) in fields["assets"] as? [String: Any] ?? [:] {
                refs.insert(src)
                if let proxy = (value as? [String: Any])?["proxy"] as? String { refs.insert(proxy) }
            }
        }
        guard refs.count <= 4096 else { throw APIError("Use at most 4096 sources in one processing operation.") }
        let sources = try refs.sorted().map { ($0, try processingSourceStamp($0, allowMissing: allSources && ($0 != (body["src"] as? String)))) }
        let bodyBytes = JSON(any: body).text.utf8.count
        guard bodyBytes <= 1024 * 1024 else { throw APIError("The processing request exceeds 1 MiB.") }
        let capturedBytes = UInt64(project.utf8.count + lastText.utf8.count + bodyBytes) * 8 + UInt64(sources.count) * 1024 + 2 * 1024 * 1024
        let rootStamp = try processingRootStamp()
        guard try readProjectText() == lastText else { throw APIError("The project changed on disk. Refresh before processing.") }
        let lease = try processingAdmission.reserve(capturedBytes: capturedBytes, preservingAudioPreviewReuse: preservingAudioPreviewReuse)
        return ProcessingContext(generation: projectGeneration, root: folder.root.path, rootStamp: rootStamp, composition: composition,
                                 sources: sources, lease: lease, version: version, project: project, diskText: lastText, allowsAudioPreviewReuse: preservingAudioPreviewReuse)
    }
    private func validateProcessingContext(_ context: ProcessingContext) throws {
        try requireOpen()
        guard context.lease.isActive, context.generation == projectGeneration, context.root == folder.root.path,
              context.rootStamp == (try processingRootStamp()), context.version == version, context.project == project,
              context.diskText == lastText, try readProjectText() == context.diskText else {
            throw APIError("The captured project changed while processing waited or ran. Start it again with the current timeline.")
        }
        for (src, stamp) in context.sources {
            guard try processingSourceStamp(src, allowMissing: true) == stamp else { throw APIError("The source changed during processing: \(src).") }
        }
    }
    private func validateSourceProcessingContext(_ context: ProcessingContext) throws {
        try requireOpen(); try Task.checkCancellation()
        guard context.lease.isActive, context.generation == projectGeneration, context.root == folder.root.path,
              context.rootStamp == (try processingRootStamp()) else {
            throw APIError("The project was replaced during processing. The generated output was not registered in the new project.")
        }
        _ = try projectView(comp: context.composition)
        for (src, stamp) in context.sources {
            guard try processingSourceStamp(src, allowMissing: true) == stamp else { throw APIError("The source changed during processing: \(src).") }
        }
        guard let project, projectFileLoaded, project.utf8.count <= 32 * 1024 * 1024,
              try readProjectText() == lastText else { throw APIError("The project changed on disk. Refresh before registering the generated output.") }
    }
    private func prepareProcessingMediaAdmission() throws {
        guard let context = ProcessingScope.context else { return }
        try validateSourceProcessingContext(context)
        guard let project else { throw APIError("No project yet.") }
        // Register the measured asset against the current project. Placement still
        // uses its original capture and cannot apply to an edited target.
        context.version = version; context.project = project; context.diskText = lastText
    }
    private func validateCurrentProcessing() throws {
        if let context = ProcessingScope.context { try validateProcessingContext(context) }
    }
    private func withProcessingAdmission<T>(_ body: [String: Any], preservingAudioPreviewReuse: Bool = false, operation: @escaping () async throws -> T) async throws -> T {
        if let context = ProcessingScope.context { try validateProcessingContext(context); return try await operation() }
        let context = try captureProcessingContext(body, allSources: body["src"] == nil, preservingAudioPreviewReuse: preservingAudioPreviewReuse)
        let id = UUID()
        let worker = Task {
            try await context.lease.wait()
            try validateProcessingContext(context)
            return try await ProcessingScope.$context.withValue(context) {
                let result = try await operation()
                if !context.exportPublished { try validateProcessingContext(context) }
                return result
            }
        }
        directProcessingCancellations[id] = { worker.cancel() }
        defer { directProcessingCancellations[id] = nil; context.lease.finish() }
        do {
            let result = try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
            if !context.ownedAudioPreviews.isEmpty {
                try await audioPreviewReuseCheckpoint("finalHandoff")
                try Task.checkCancellation()
                try validateProcessingContext(context)
                guard context.ownedAudioPreviews.values.allSatisfy(\.isCurrent) else { throw APIError("The prepared audio file changed before its handoff.") }
            }
            // The API result now owns these WAVs. Until this final handoff, rejection
            // retains cleanup even when the operation itself has already returned.
            context.ownedAudioPreviews.removeAll()
            return result
        } catch {
            for owned in context.ownedAudioPreviews.values { owned.cleanup() }
            context.ownedAudioPreviews.removeAll()
            throw error
        }
    }
    #if DEBUG
    private var processingTestBarrier: (@Sendable () async throws -> Void)?
    func setProcessingTestBarrier(_ barrier: (@Sendable () async throws -> Void)?) { processingTestBarrier = barrier }
    func processingWorkersForTesting() -> Int { nativeTasks.count + directProcessingCancellations.count }
    #endif
    private func processingTestStage() async throws {
        #if DEBUG
        try await processingTestBarrier?()
        #endif
    }
    private func validateProcessingJobContext(_ job: Job, context: ProcessingContext) throws {
        if job.sourceVideoProcessing { try validateSourceProcessingContext(context) }
        else { try validateProcessingContext(context) }
    }
    private func activateProcessingJob(_ id: String, context: ProcessingContext) throws {
        guard let job = jobs.first(where: { $0.id == id }), job.state == "queued" else { throw CancellationError() }
        try validateProcessingJobContext(job, context: context)
        job.state = "running"; broadcast("job", job.json)
    }
    private func processingWorkerExited(_ id: String) {
        nativeTasks[id] = nil; mixAnalysisReservations[id] = nil; mixAnalysisDiskReservations[id] = nil
        guard let job = jobs.first(where: { $0.id == id }) else { return }
        if job.state != "done", !job.readOnlyAnalysis, let owned = try? Self.exportFile(job.partFile, folder: folder) { try? FileManager.default.removeItem(at: owned) }
        job.exportOutput?.cleanup(); job.exportOutput = nil; job.exportSources = nil; job.acceptedProject = nil
        job.mixCapture = nil; job.admissionContext = nil; job.draining = false
        job.admission?.finish(); job.admission = nil
        broadcast("job", job.json); pruneCompletedJobs(assistantLocalOnly: job.assistantLocalOnly)
    }

    /// The first of `base.ext`, `base-2.ext` … `base-1000.ext` that `taken` reports free, or `base.ext`
    /// when all are taken (the exclusive publish then refuses it).
    /// A taken name gets the next free number (Export.mp4, Export-2.mp4), as the browser server and
    /// Final Cut do, instead of failing. Names held by queued or running exports count as taken.
    /// Callers never pass an explicit `out` path through this, so a chosen path is never renamed.
    private func freeExport(base: String, ext: String, in renders: URL) -> URL {
        let held = Set(jobs.filter { $0.kind == "export" && ["queued", "running"].contains($0.state) }.map { $0.out.standardizedFileURL.path })
        let file = Self.freeExportName(base: base, ext: ext) { candidate in
            let url = renders.appendingPathComponent(candidate).standardizedFileURL
            // Any entry counts, including a symbolic link whose target is missing.
            return held.contains(url.path) || (try? FileManager.default.attributesOfItem(atPath: url.path)) != nil
        }
        return renders.appendingPathComponent(file)
    }

    nonisolated static func freeExportName(base: String, ext: String, taken: (String) -> Bool) -> String {
        let first = base + "." + ext
        guard taken(first) else { return first }
        for number in 2...1000 {
            let candidate = "\(base)-\(number).\(ext)"
            if !taken(candidate) { return candidate }
        }
        return first
    }

    private nonisolated static func exportFile(_ url: URL, folder: ProjectFolder) throws -> URL {
        try folder.output(url.path)
    }

    /// Missing is allowed only before a project has ever loaded. A failed read must never
    /// turn an existing project into the empty-folder creation path.
    private func readProjectText() throws -> String? {
        var info = Darwin.stat()
        if folder.projectFile.path.withCString({ Darwin.lstat($0, &info) }) != 0 {
            let code = errno
            guard code == ENOENT else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(code)) }
            let attributes = try FileManager.default.attributesOfItem(atPath: folder.root.path)
            guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw APIError("The project folder is unavailable.") }
            guard project == nil && lastText.isEmpty else { throw APIError("The previously opened project file is missing. Restore it or open a different folder.") }
            return nil
        }
        guard info.st_mode & S_IFMT == S_IFREG else { throw APIError("The project file is not a regular file.") }
        let file = try folder.resolve(folder.projectFile.path)
        return try NativeProjectPersistence.read(file, fileAccess: projectFileAccess)
    }

    private func migrateProjectText(_ text: String) throws -> String {
        guard let fields = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
            throw APIError("The project file must contain a JSON object.")
        }
        if let storedVersion = fields["version"] {
            let value: Int
            do { value = try NativeAudioMixCapture.strictVersion(storedVersion) }
            catch { throw APIError("The project format version must be a positive integer.") }
            let currentText = try core.migrate(fileText: core.newProject(name: "Format check"))
            let current = (try JSON.parse(currentText) as? [String: Any])?["version"] as? Int ?? 0
            guard value > 0 && value <= current else { throw APIError("This project format is unsupported by this Arya version. Open it with a compatible version.") }
        }
        return try core.migrate(fileText: text)
    }

    private func loadFromDisk() throws {
        do {
            let text = try readProjectText()
            if let text, project == nil || !text.utf8.elementsEqual(lastText.utf8) {
                let next = try migrateProjectText(text)
                if let project {
                    rememberProject(project)
                    future.removeAll()
                }
                project = next
                lastText = text
                version += 1
                NativeAudioPreviewReuse.store.discard(owner: audioPreviewReuseOwner)
            }
            lastStat = stat()
            projectFilePresent = text != nil
            projectFileLoaded = true
            projectReadFailure = nil
        } catch {
            let message = "Could not read the project file: \(error.localizedDescription) Existing project data was not replaced."
            projectReadFailure = message
            throw APIError(message)
        }
    }

    /// Also runs immediately before publication, after asynchronous probes or processing.
    /// An external failure/change cannot be overwritten using a stale in-memory project.
    private func requireWritableProject() throws {
        try writeAdmission()
        guard projectFileLoaded else { throw APIError(projectReadFailure ?? "Open the project successfully before editing.") }
        do {
            let text = try readProjectText()
            if (text != nil) != projectFilePresent || !(text ?? "").utf8.elementsEqual(lastText.utf8) {
                if let text { _ = try migrateProjectText(text) }
                throw APIError("The project file changed. Refresh or reopen it before editing.")
            }
            projectReadFailure = nil
        } catch {
            let message = "Could not edit the project file: \(error.localizedDescription) Existing project data was not replaced."
            projectReadFailure = message
            throw APIError(message)
        }
    }

    private func stat() -> (Date?, Int64) {
        let attrs = try? FileManager.default.attributesOfItem(atPath: folder.projectFile.path)
        return (attrs?[.modificationDate] as? Date, (attrs?[.size] as? NSNumber)?.int64Value ?? -1)
    }

    /// Picks up edits another program (Claude, a text editor) made to reel.project.json.
    private func checkDisk() {
        guard !stopped else { return }
        let now = stat()
        guard projectReadFailure != nil || now.0 != lastStat.0 || now.1 != lastStat.1 else { return }
        let before = version
        let previousFailure = projectReadFailure
        do {
            try loadFromDisk()
            if version != before, let project {
                broadcast("project", .object([("project", .raw(project)), ("version", .int(version)), ("who", "disk")]))
                pushActivity("claude", "reel.project.json changed on disk")
            }
        } catch {
            // Retain the last successful stat so unchanged failed reads keep retrying.
            if previousFailure != projectReadFailure { pushActivity("reel", error.localizedDescription) }
        }
    }

    // MARK: state changes

    private func broadcast(_ name: String, _ data: JSON) {
        guard !stopped else { return }
        events(name, data.text)
    }

    private func pushActivity(_ who: String, _ text: String) {
        let entry = JSON.compact([("who", .string(who)), ("text", .string(text)), ("at", .number((Date().timeIntervalSince1970 * 1000).rounded()))])
        activity.append(entry)
        if activity.count > 200 { activity.removeFirst() }
        broadcast("activity", entry)
    }

    private func rememberProject(_ previous: String) {
        past.append(previous)
        if past.count > 200 { past.removeFirst(past.count - 200) }
    }

    private func commit(_ next: String, who: String, lines: [String], history: Bool = true, admission: (() throws -> Void)? = nil) throws {
        try requireOpen()
        try requireWritableProject()
        try validateCurrentProcessing()
        let text = try core.fileText(project: next)
        let store = try recoveryStorage()
        let expected = projectFilePresent ? Data(lastText.utf8) : nil
        let expectedIdentity = try store.currentRead()
        guard expectedIdentity?.data == expected else { throw APIError("The project changed before saving. Refresh or reopen it.") }
        let warnings = try NativeProjectPersistence.replace(Data(text.utf8), store: store, expected: expected, expectedIdentity: expectedIdentity, preserveOriginal: false, fileAccess: projectFileAccess,
            admission: { try self.requireRecoveryWriteAdmission(); try admission?() }, validate: core.validateRecoveryProject)
        if let project, history {
            rememberProject(project)
            future.removeAll()
        }
        project = next
        version += 1
        commitOwners.append((version, who))
        if commitOwners.count > 400 { commitOwners.removeFirst(commitOwners.count - 400) }
        NativeAudioPreviewReuse.store.discard(owner: audioPreviewReuseOwner)
        lastText = text
        if let context = ProcessingScope.context {
            context.version = version; context.project = next; context.diskText = text
        }
        projectFilePresent = true
        lastStat = stat()
        broadcast("project", .object([("project", .raw(next)), ("version", .int(version)), ("who", .string(who))]))
        for line in lines.suffix(8) { pushActivity(who, line) }
        for warning in warnings { pushActivity("reel", warning) }
    }

    private func recoveryStorage() throws -> NativeProjectRecovery.Store {
        if let recoveryStore { try recoveryStore.requireIdentity(); return recoveryStore }
        let store = try NativeProjectRecovery.Store(folder: folder)
        recoveryStore = store
        return store
    }
    private func requireRecoveryWriteAdmission() throws {
        try requireOpen(); try writeAdmission()
        try requireRecoveryFilesystemAccess()
    }
    private func requireSelectedRecoveryAdmission(permission: ProjectWriteAdmission.RecoveryPermission?, operation: ProjectWriteAdmission.RecoveryOperation) throws {
        try requireOpen()
        if let permission { try permission.require(operation) }
        else { try writeAdmission() }
        try requireRecoveryFilesystemAccess()
    }
    private func requireRecoveryFilesystemAccess() throws {
        guard FileManager.default.isWritableFile(atPath: folder.root.path),
              !FileManager.default.fileExists(atPath: folder.projectFile.path) || FileManager.default.isWritableFile(atPath: folder.projectFile.path) else {
            throw APIError("The project is read-only. Restore requires write access to its file and folder.")
        }
        guard (NSFileVersion.unresolvedConflictVersionsOfItem(at: folder.projectFile) ?? []).isEmpty else {
            throw APIError("This project has unresolved Files versions. Resolve them before recovery or saving.")
        }
    }
    public func projectRecoveryOffer() throws -> NativeProjectRecoveryOffer {
        try requireOpen()
        let store: NativeProjectRecovery.Store
        if let recoveryStore { store = recoveryStore }
        else { store = try NativeProjectRecovery.Store(folder: folder, create: false); recoveryStore = store }
        return try NativeProjectPersistence.recoveryOffer(store: store, fileAccess: projectFileAccess, validate: core.validateRecoveryProject)
    }
    public nonisolated func recoveryOperation(_ choice: NativeProjectRecoveryChoice, observedToken: String, expectedVersion: Int) -> ProjectWriteAdmission.RecoveryOperation {
        .init(owner: ObjectIdentifier(self), root: folder.root.standardizedFileURL.path, snapshotID: choice.id,
              familyID: choice.familyID, host: choice.host, createdAt: choice.createdAt, sha256: choice.sha256,
              bytes: choice.bytes, version: expectedVersion, observedToken: observedToken)
    }
    public func restoreProjectRecovery(_ choice: NativeProjectRecoveryChoice, observedToken: String, expectedVersion: Int,
                                       permission: ProjectWriteAdmission.RecoveryPermission? = nil) throws {
        defer { permission?.revoke() }
        try requireOpen(); try Task.checkCancellation()
        let operation = recoveryOperation(choice, observedToken: observedToken, expectedVersion: expectedVersion)
        if permission == nil { try requireRecoveryWriteAdmission() }
        guard expectedVersion == version else { throw APIError("The project changed after recovery was offered. Choose a recovery copy again.") }
        let store = try recoveryStorage(), current = try store.currentRead()
        guard NativeProjectRecovery.observedToken(current) == observedToken else { throw APIError("The project file changed after recovery was offered. Its bytes were preserved.") }
        let restored = try store.selected(choice, validate: core.validateRecoveryProject)
        guard let text = String(data: restored, encoding: .utf8) else { throw APIError("The recovery project is not UTF-8.") }
        let next = try migrateProjectText(text)
        try requireSelectedRecoveryAdmission(permission: permission, operation: operation)
        let warnings = try NativeProjectPersistence.replace(restored, store: store, expected: current?.data, expectedIdentity: current, preserveOriginal: true, fileAccess: projectFileAccess,
            admission: { try self.requireSelectedRecoveryAdmission(permission: permission, operation: operation) }, validate: core.validateRecoveryProject)
        if let project, !next.utf8.elementsEqual(project.utf8) { rememberProject(project); future.removeAll() }
        project = next; lastText = text; projectFilePresent = true; projectFileLoaded = true; projectReadFailure = nil
        version += 1; projectGeneration = UUID(); lastStat = stat(); renderer = nil; directExportWrites.removeAll()
        NativeAudioPreviewReuse.store.discard(owner: audioPreviewReuseOwner)
        broadcast("project", .object([("project", .raw(next)), ("version", .int(version)), ("who", "recovery")]))
        pushActivity("reel", "Restored the saved project from \(choice.createdAt). The replaced original was preserved in .reel/recovery.")
        for warning in warnings { pushActivity("reel", warning) }
    }

    // MARK: requests

    /// Assistant reads are separate from local UI reads. Mix-capture provenance is owned by
    /// Job, independent of its caller-supplied kind/spec and retained after capture cleanup.
    /// Reject private/missing IDs before waiting or cancelling, so completion timing and
    /// cancellation receipts cannot reveal a local disk-derived outcome.
    public func handleAssistant(method: String, path: String, body: String?) async throws -> JSON {
        try requireOpen()
        guard Assistant.allows(method: method, path: path) else { throw APIError("This project route is not available to the assistant.") }
        let components = URLComponents(string: path) ?? URLComponents()
        let route = components.path
        if method == "GET", ["/api/jobs/wait", "/api/analysis/jobs/wait"].contains(route) {
            let id = components.queryItems?.last(where: { $0.name == "id" })?.value ?? ""
            guard let job = jobs.first(where: { $0.id == id }), !job.assistantLocalOnly else { return AssistantToolOutput.unavailableJob }
        }
        if method == "POST", ["/api/jobs/cancel", "/api/analysis/jobs/cancel"].contains(route) {
            let fields = try JSON.parse(body ?? "{}") as? [String: Any]
            guard let id = fields?["id"] as? String, let job = jobs.first(where: { $0.id == id }), !job.assistantLocalOnly else { return AssistantToolOutput.unavailableJob }
        }
        let value: JSON
        if method == "GET", ["/api/jobs", "/api/analysis/jobs"].contains(route) {
            let visible = jobs.filter { !$0.assistantLocalOnly && (route != "/api/analysis/jobs" || $0.kind != "export") }
            value = .object([("jobs", .array(visible.map(\.json)))])
        } else if method == "GET", route == "/api/project" {
            // Filter before the recent-history bound, so private jobs do not evict public rows.
            let local = try await handle(method: method, path: path, body: body)
            guard case .object(let pairs) = local else { throw APIError("Project context is unavailable.") }
            let visible = jobs.filter { !$0.assistantLocalOnly }.suffix(20).map(\.json)
            value = .object(pairs.map { $0.0 == "jobs" ? ("jobs", .array(visible)) : $0 })
        } else { value = try await handle(method: method, path: path, body: body) }
        return try AssistantToolOutput.project(value, path: path)
    }

    /// Answers one API call. `path` may carry a query string; `body` is the JSON text of a POST.
    public func handle(method: String, path: String, body: String?) async throws -> JSON {
        let comps = URLComponents(string: path) ?? URLComponents()
        let route = comps.path
        if stopped, method == "POST", route == "/api/export/finish" {
            guard let b = try JSON.parse(body ?? "{}") as? [String: Any], b["drained"] as? Bool == true else { throw APIError("A stopped project accepts only page worker drain acknowledgements.") }
            return try await finishExport(b)
        }
        try requireOpen()
        // Cancellation and transient selection/playhead state do not publish project data.
        if method != "GET", !["/api/jobs/cancel", "/api/analysis/jobs/cancel", "/api/ui-state", "/api/deliveries/access", "/api/export/progress", "/api/export/finish", "/api/transcript/drafts/read", "/api/transcript/drafts/recover"].contains(route) { try requireWritableProject() }
        var query: [String: String] = [:]
        for item in comps.queryItems ?? [] { query[item.name] = item.value ?? "" }
        let bodyText = body?.isEmpty == false ? body! : "{}"
        guard let b = try JSON.parse(bodyText) as? [String: Any] else { throw APIError("The request body must be a JSON object.") }

        if method == "POST", ["/api/audio/clean", "/api/audio/denoise", "/api/audio/restore"].contains(route) { _ = try NativeAudioProcessing.CleanupRequest(b) }

        if method == "POST", b["wait"] as? Bool == false, Self.analysisRoutes.contains(route) { return try startAnalysisJob(route: route, body: b) }
        if ProcessingScope.context == nil, Self.directProcessingRoutes.contains(route) {
            if route == "/api/audio/duck-plan" { try preflightDuckPlanning(b) }
            var captureBody = b
            if captureBody["src"] == nil { captureBody["src"] = query["src"] }
            return try await withProcessingAdmission(captureBody) { try await self.handle(method: method, path: path, body: body) }
        }

        switch (method, route) {
        case ("GET", "/api/project"):
            return .object([
                ("project", project.map(JSON.raw) ?? .null),
                ("version", .int(version)),
                ("root", .string(folder.root.path)),
                ("activity", .array(Array(activity.suffix(40)))),
                ("chat", .array(Array((assistantChatHistory?.messages ?? []).suffix(NativeAssistantChatHistory.maximumDisplayedMessages)))),
                ("chatHistory", assistantChatHistory?.status ?? .object([("restored", 0), ("warning", .null), ("savingAvailable", false)])),
                ("claude", .object([("state", "idle"), ("text", "")])),
                ("jobs", .array(jobs.suffix(20).map(\.json))),
            ])
        case ("GET", "/api/outline"):
            // The focus describes what the editor shows: selection, playhead and open composition.
            let focusOptions = JSON.object([("selection", uiState.first { $0.0 == "selection" }?.1 ?? .array([])), ("playhead", uiState.first { $0.0 == "playhead" }?.1 ?? 0),
                                            ("comp", uiState.first { $0.0 == "openComp" }?.1 ?? .null)])
            return JSON.compact([
                ("outline", .string(try project.map { try core.outline(project: $0) } ?? "no project")),
                ("opsDoc", .raw(try core.opsDoc())),
                ("uiState", .object(uiState)),
                ("version", .int(version)),
                ("focus", project.flatMap { try? core.describeFocus(project: $0, options: focusOptions.text) }.map(JSON.string)),
            ])
        case ("GET", "/api/describe"):
            guard let project else { throw APIError("No project is open.") }
            let ids = (query["ids"] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            guard ids.count <= 64, ids.allSatisfy({ $0.count <= 128 && $0.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" } }) else { throw APIError("ids must be at most 64 comma-separated clip IDs.") }
            let at = query["at"].flatMap(Double.init)
            if let at, !(at.isFinite && at >= 0 && at < 1_000_000) { throw APIError("at must be timeline seconds from 0 to 1000000.") }
            let options = JSON.compact([("ids", .array(ids.map(JSON.string))), ("at", at.map(JSON.number)), ("comp", JSON.str(query["comp"].flatMap { $0.isEmpty ? nil : $0 }))])
            return .object([("text", .string(try core.describeRequest(project: project, options: options.text))), ("version", .int(version))])
        case ("POST", "/api/ops"): return try await applyOps(bodyText, b)
        case ("POST", "/api/undo"): return try undo()
        case ("POST", "/api/redo"): return try redo()
        case ("POST", "/api/new"):
            let next = try core.newProject(name: b["name"] as? String ?? "Untitled", options: bodyText)
            let fields = (try? JSON.parse(next) as? [String: Any]) ?? [:]
            try commit(next, who: b["who"] as? String ?? "you", lines: ["new project \(fields["name"] ?? "") \(fields["width"] ?? "")x\(fields["height"] ?? "")@\(fields["fps"] ?? "")"])
            projectGeneration = UUID()
            return .object([("version", .int(version)), ("project", .raw(next))])
        case ("POST", "/api/import"):
            var expectedVersion: Int?
            if let raw = b["expectedVersion"] {
                guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                      let value = Int(exactly: number.doubleValue), value >= 0 else { throw APIError("Choose a valid captured project version before retrying import.") }
                expectedVersion = value
            }
            var retainedCopyIdentities: [String: String]?
            if let raw = b["retainedCopyIdentities"] {
                guard let identities = raw as? [String: String] else { throw APIError("Choose verified copied files before retrying import.") }
                retainedCopyIdentities = identities
            }
            return try await importMedia(b["paths"] as? [String] ?? [], who: b["who"] as? String ?? "you",
                expectedVersion: expectedVersion, retainedCopyIdentities: retainedCopyIdentities)
        case ("POST", "/api/forget"):
            guard let project else { throw APIError("No project yet: create one first") }
            let paths = b["paths"] as? [String] ?? []
            try commit(try core.forget(project: project, paths: JSON.array(paths.map { .string($0) }).text), who: "you", lines: ["removed \(paths.count) media from the project"])
            return .object([("version", .int(version))])
        case ("GET", "/api/files"): return try listFiles(query["dir"] ?? ".")
        case ("GET", "/api/strip"): return try await strip(query["src"] ?? "", highQuality: query["quality"] == "high")
        case ("GET", "/api/proxy"), ("POST", "/api/proxy"):
            let src = b["src"] as? String ?? query["src"] ?? ""
            _ = try Self.exportFile(folder.cacheDir, folder: folder)
            let output = try await NativeMediaProxy.create(source: folder.resolve(src), folder: folder)
            try requireOpen(); try Task.checkCancellation()
            return .object([("path", .string(folder.relative(try Self.exportFile(output, folder: folder)))), ("source", .string(src)), ("asset", try await probe(output))])
        case ("GET", "/api/peaks"):
            return try await MediaDerivatives.peaks(file: try folder.resolve(query["src"] ?? ""), cacheDir: folder.cacheDir, projectFolder: folder)
        case ("GET", "/api/transcript"): return try readTranscript(query)
        case ("GET", "/api/transcript/drafts"):
            return try NativeTranscriptDraftStore.handle(action: "context", body: query, folder: folder)
        case ("POST", "/api/transcript/drafts/read"):
            return try NativeTranscriptDraftStore.handle(action: "read", body: b, folder: folder)
        case ("POST", "/api/transcript/drafts/recover"):
            return try NativeTranscriptDraftStore.handle(action: "recover", body: b, folder: folder)
        case ("POST", "/api/transcript/drafts/checkpoint"):
            return try NativeTranscriptDraftStore.handle(action: "checkpoint", body: b, folder: folder, assertPublication: { try self.requireWritableProject() })
        case ("POST", "/api/transcript/drafts/discard"):
            return try NativeTranscriptDraftStore.handle(action: "discard", body: b, folder: folder, assertPublication: { try self.requireWritableProject() })
        case ("POST", "/api/transcript"): return try saveTranscript(b)
        case ("POST", "/api/transcript/import-preview"): return try previewTranscriptImport(b)
        case ("POST", "/api/transcript/edit"): return try await editTranscript(b)
        case ("POST", "/api/shorts/propose"): return try proposeShorts(b)
        case ("POST", "/api/shorts/build"): return try await buildShorts(b)
        case ("POST", "/api/audio/measure-mix"):
            let job = try startAnalysisJob(route: route, body: b)
            if b["wait"] as? Bool == true, let id = (try JSON.parse(job.text) as? [String: Any])?["id"] as? String { return try await waitJob(id, timeout: 60_000) }
            return job
        case ("POST", "/api/audio/duck-plan"): return try planDucking(b)
        case ("POST", "/api/analyze"): return try await analyze(b)
        case ("POST", "/api/audio/clean"), ("POST", "/api/audio/denoise"): return try await cleanAudio(b)
        case ("POST", "/api/audio/restore"): return try await restoreAudio(b)
        case ("POST", "/api/audio/loudnorm"): return try await normalizeAudio(b)
        case ("GET", "/api/audio/compose/capabilities"): return musicCapabilities()
        case ("POST", "/api/audio/compose"): return try await composeMusic(b)
        case ("POST", "/api/audio/compose/place"): return try await placeMusic(b)
        case ("POST", "/api/multicam/sync"): return try await syncAudio(b)
        case ("GET", "/api/analysis/jobs"): return .object([("jobs", .array(jobs.filter { $0.kind != "export" }.map(\.json)))])
        case ("POST", "/api/retime"): return try await startProcessing(b, kind: "retime")
        case ("POST", "/api/stabilize/render"): return try await startProcessing(b, kind: "stabilize")
        case ("POST", "/api/analysis/person-mask"): return try await startProcessing(b, kind: "person-mask")
        case ("POST", "/api/analysis/track"), ("POST", "/api/analysis/saliency"), ("POST", "/api/analysis/autoreframe"): return try await visionAnalysis(b, kind: String(route.split(separator: "/").last ?? ""))
        case ("POST", "/api/tracking/track"): return try await visionAnalysis(b, kind: "track")
        case ("GET", "/api/interchange/files"): return try interchangeFiles(query)
        case ("POST", "/api/interchange/export"): return try exportInterchange(bodyText, b)
        case ("POST", "/api/interchange/import"): return try await importInterchange(b)
        case ("POST", "/api/captions/from-transcript"): return try await transcriptCaptions(bodyText, b)
        case ("GET", "/api/caps"):
            let speech = Transcriber.availability()
            return .object([
                ("host", "native"),
                // The editor reads `whisper` as "transcription is available"; the app transcribes with the Speech framework.
                ("whisper", .bool(speech.available)),
                ("transcriber", "speech"),
                ("onDeviceSpeech", .bool(speech.onDevice)),
                ("transcription", .object([("durable", true), ("jobs", true), ("serverOptIn", true), ("maxWindowSeconds", 46), ("locales", .array(Transcriber.locales.map(JSON.string)))])),
                ("shorts", .object([("available", true), ("scoring", "transcript-structure")])),
                ("captionStyles", ["plain", "boxed", "karaoke", "word"]),
                ("chrome", false),
                ("presets", .array(Self.nativePresets.map { .string($0) })),
                ("export", .object([("renderer", "metal"), ("presets", .array(Self.nativePresets.map { .string($0) })), ("still", true), ("hdr", .object([("available", true), ("transfers", .array(["pq", "hlg"])), ("presets", .array(["hevc", "prores-422", "prores-422hq", "prores-4444"])), ("workingSpace", "linear-rec2020"), ("bitDepth", 10)])), ("audioMemoryLimitMB", .number(Double(NativeAudioMixer.memoryLimitBytes)/1048576)), ("maxDurationSeconds", 3600)])),
                ("interchange", .object([("available", true)])),
                ("proxy", .object([("available", true), ("maxWidth", 640), ("maxHeight", 480)])),
                ("analysis", .object([("transcript", .bool(speech.available)), ("scenes", true), ("silence", true), ("beats", true), ("loudness", true), ("opticalFlow", true), ("denoise", true), ("tracking", true), ("saliency", true), ("personMask", true), ("autoReframe", true), ("processingRecommendations", true), ("mixLoudness", true)])),
                ("color", .object([("cubeImport", true), ("lutInspect", true), ("lutApply", true), ("lutExport", true), ("referenceMatch", true), ("referenceEngine", "trimmed-rgb-mean-deviation"), ("referenceFrameEngine", "metal"), ("maxCubeBytes", 16777216), ("maxReferenceBytes", 33554432)])),
                ("editing", .object([("dialogueClipDucking", true)])),
                ("processingAdmission", .object([("maxOutstanding", 8), ("maxHeavyActive", 1), ("capturedMemoryLimitMB", .number(Double(processingAdmission.capturedByteLimit) / 1048576)), ("workerMemoryReservationMB", .number(Double(processingAdmission.workerByteLimit) / 1048576))])),
                ("music", musicCapabilities()),
                ("processing", .object([("audioClean", true), ("audioCleanEngine", "accelerate-spectral-cpu"), ("audioCleanupIntermediate", "float32-wav"), ("audioMixerEngine", "cpu-dsp"), ("multicamSync", true), ("deshake", true), ("videoDenoise", true), ("audioEngine", "accelerate-spectral-subtraction"), ("videoDenoiseEngine", "metal-motion-bilateral"), ("stabilizationEngine", "vision-registration-core-image-warp"), ("gpuRegistrationVerified", false), ("qualityLevels", ["fast","balanced","high"]), ("stabilizationModels", ["translation","homography"]), ("codecs", ["auto","h264","hevc","prores-422hq","prores-4444"]), ("preservesHDR", true), ("preservesAlpha", true), ("frameMemoryLimitMB", .number(Double(NativeAudioMixer.memoryLimitBytes)/1048576)), ("maxDurationSeconds", 3600)])),
                ("figma", .object([("available", false), ("reason", "Connect and import Figma files in the browser editor with /reel. Imported compositions can be edited here.")])),
                ("assistant", .object([("available", false), ("reason", "The native assistant is not connected. Use /reel in the browser editor to direct edits with Claude.")])),
            ])
        case ("POST", "/api/library/export"): return try exportLibraryComponent(b)
        case ("POST", "/api/library/import"): return try importLibraryComponent(b)
        case ("GET", "/api/luts"): return listLuts()
        case ("POST", "/api/luts/import"): return try importLUT(b)
        case ("POST", "/api/luts/inspect"): return try inspectLUT(b)
        case ("POST", "/api/luts/export"): return try exportLUT(b)
        case ("POST", "/api/luts/apply"): return try applyLUT(b)
        case ("POST", "/api/looks/match"): return try await makeLook(b)
        case ("POST", "/api/ui-state"):
            for (key, value) in b.sorted(by: { $0.key < $1.key }) {
                if let i = uiState.firstIndex(where: { $0.0 == key }) { uiState[i].1 = JSON(any: value) } else { uiState.append((key, JSON(any: value))) }
            }
            return .object([("ok", true)])
        case ("GET", "/api/state"):
            return .object([
                ("bridgeAlive", false), ("version", .int(version)), ("editors", .int(subscribed ? 1 : 0)),
                ("worker", false), ("processing", .object([("active", .int(processingAdmission.snapshot().active)), ("queued", .int(processingAdmission.snapshot().queued))])), ("root", .string(folder.root.path)), ("pid", .int(Int(ProcessInfo.processInfo.processIdentifier))),
            ])
        case ("POST", "/api/bridge/send"), ("GET", "/api/bridge/poll"), ("POST", "/api/bridge/claude"):
            throw APIError("Claude is not connected to the Reel app yet. To direct edits with Claude, open this project with the Reel Claude Code plugin (/reel), which runs the browser editor.")
        case ("POST", "/api/export"): return b["renderer"] as? String == "webcodecs" ? try startExport(b) : try startNativeExport(b)
        case ("POST", "/api/video/denoise"): return try await startProcessing(b, kind: "denoise")
        case ("POST", "/api/export/progress"): return exportProgress(b)
        case ("POST", "/api/export/finish"): return try await finishExport(b)
        case ("POST", "/api/frame"):
            guard let project else { throw APIError("No project yet.") }
            let renderer = try freshNativeRenderer()
            let sources = try NativeExportSources.capture(project: project, folder: folder)
            let context = ProcessingScope.context
            let time = (b["time"] as? NSNumber)?.doubleValue ?? (b["at"] as? NSNumber)?.doubleValue ?? 0
            let view = try JSON.parse(projectView(comp: b["comp"] as? String)) as? [String: Any] ?? [:]
            let width = (b["width"] as? NSNumber)?.doubleValue ?? (view["width"] as? NSNumber)?.doubleValue ?? 1920
            let height = width * ((view["height"] as? NSNumber)?.doubleValue ?? 1080) / ((view["width"] as? NSNumber)?.doubleValue ?? 1920)
            guard time.isFinite, time >= 0 else { throw APIError("Choose a finite frame time.") }
            try validateExportAdmission(width: width, height: height, fps: 1, from: 0, to: 1)
            let name = b["name"] as? String ?? "frame-\(UUID().uuidString).png"
            let output = try folder.output(b["out"] as? String ?? ".reel/frames/" + ProjectFolder.cleanFileName(name))
            guard output.path.hasPrefix(folder.dotDir.appendingPathComponent("frames").path + "/") else { throw APIError("Still outputs must stay under .reel/frames/.") }
            try rejectReferencedMediaOverwrite(output)
            let publication = try NativeExportOutput(folder: folder, destination: output)
            let path = try await renderer.still(project: project, at: time, comp: b["comp"] as? String, width: (b["width"] as? NSNumber)?.intValue, name: name, out: b["out"] as? String, outputPublication: publication, beforePublish: {}, publishOutput: { publication in
                try await self.publishStillOutput(publication, context: context, sources: sources)
            })
            return .object([("path", .string(folder.relative(path)))])
        case ("GET", "/api/jobs"): return .object([("jobs", .array(jobs.map(\.json)))])
        case ("GET", "/api/jobs/wait"), ("GET", "/api/analysis/jobs/wait"): return try await waitJob(query["id"] ?? "", timeout: Double(query["timeout"] ?? "") ?? 25000)
        case ("POST", "/api/jobs/cancel"), ("POST", "/api/analysis/jobs/cancel"):
            if let id = b["id"] as? String, let job = jobs.first(where: { $0.id == id }), job.state != "done" { nativeTasks[id]?.cancel(); fail(job, "cancelled") }
            return .object([("ok", true)])
        case ("GET", "/api/deliveries"):
            var result = (try JSON.parse(deliveryHistory().list().text) as? [String: Any]) ?? [:]
            result["actions"] = platform == nil ? ["share"] : ["share", "open", "reveal"]
            return JSON(any: result)
        case ("POST", "/api/deliveries/access"):
            let action = b["action"] as? String ?? ""
            guard ["open", "reveal"].contains(action) else { throw APIError("Unsupported delivery action") }
            let url = try deliveryURL(id: b["id"] as? String ?? "", root: b["root"] as? String ?? "")
            guard let platform else { throw APIError("Use Share export to open this delivery in another app.") }
            try await platform.reveal(url, open: action == "open")
            return .object([("ok", true)])
        case ("POST", "/api/reveal"):
            let url = try folder.resolve(b["path"] as? String ?? "")
            guard let platform else { throw APIError("Showing files is not available on this device.") }
            try await platform.reveal(url, open: b["open"] as? Bool ?? false)
            return .object([("ok", true)])
        default:
            if route.hasPrefix("/api/figma/") { throw APIError("Figma account connection is available in the browser editor with /reel. Imported Figma compositions can be edited in the app.") }
            if route.hasPrefix("/api/analysis/") || ["/api/retime", "/api/stabilize/render"].contains(route) { throw APIError("This analysis and rendered processing needs ffmpeg in the browser editor. Open this project with /reel to run it. Clip speed, keyframes and stabilization transforms can still be edited here.") }
            if ["/api/audio/denoise", "/api/audio/clean", "/api/audio/loudnorm"].contains(route) { throw APIError("This audio processing needs ffmpeg in the browser editor. Open this project with /reel to run it. The app's audio mixer, effects and loudness meters remain available.") }
            if route == "/api/multicam/sync" { throw APIError("Automatic multicam audio sync runs in the browser editor with /reel. You can create multicam clips and align their angles manually here.") }
            throw APIError("not found: \(method) \(route)")
        }
    }

    public static let nativePresets = inPagePresets + ["prores-422", "prores-422hq", "prores-4444", "gif", "png-seq"]

    private func nativeRenderer() throws -> ReelMetalRenderer {
        if let renderer { return renderer }
        let value = try freshNativeRenderer()
        renderer = value
        return value
    }

    private func freshNativeRenderer() throws -> ReelMetalRenderer {
        let fonts = coreScript.deletingLastPathComponent().appendingPathComponent("web/fonts")
        let urls = ((try? FileManager.default.contentsOfDirectory(at: fonts, includingPropertiesForKeys: nil)) ?? []).filter { ["ttf", "otf"].contains($0.pathExtension.lowercased()) }
        return try ReelMetalRenderer(folder: folder, coreScriptURL: coreScript, fontURLs: urls)
    }

    private func startNativeExport(_ b: [String: Any]) throws -> JSON {
        if let expected = b["expectedProject"] as? String {
            guard let project,
                  let current = try JSON.parse(project) as? NSDictionary,
                  let captured = try JSON.parse(expected) as? NSDictionary,
                  current == captured else { throw APIError("The queued project changed. Start this export again with the current timeline.") }
        }
        let context = try captureProcessingContext(b, allSources: true)
        var scheduled = false
        defer { if !scheduled { context.lease.finish() } }
        let snapshot = try projectView(comp: b["comp"] as? String)
        var specBody = b
        let preset = b["preset"] as? String ?? "h264-high"
        guard Self.nativePresets.contains(preset) else { throw APIError("Unknown native export preset \(preset).") }
        let fields = (try JSON.parse(snapshot) as? [String: Any]) ?? [:]
        let range = b["range"] as? [String: Any] ?? [:]
        let from = (b["from"] as? NSNumber)?.doubleValue ?? (range["in"] as? NSNumber)?.doubleValue ?? 0
        let to = try (b["to"] as? NSNumber)?.doubleValue ?? (range["out"] as? NSNumber)?.doubleValue ?? core.duration(project: snapshot)
        let fps = (b["fps"] as? NSNumber)?.doubleValue ?? (fields["fps"] as? NSNumber)?.doubleValue ?? 30
        let width = (b["width"] as? NSNumber)?.doubleValue ?? (fields["width"] as? NSNumber)?.doubleValue ?? 1920
        let height = (b["height"] as? NSNumber)?.doubleValue ?? width * ((fields["height"] as? NSNumber)?.doubleValue ?? 1080) / ((fields["width"] as? NSNumber)?.doubleValue ?? 1920)
        try validateExportAdmission(width: width, height: height, fps: fps, from: from, to: to)
        let ext = preset.hasPrefix("prores-") ? "mov" : preset == "gif" ? "gif" : preset == "png-seq" ? "frames" : Self.presetExtensions[preset] ?? "mp4"
        let name = ProjectFolder.cleanFileName(b["name"] as? String ?? fields["name"] as? String ?? "reel")
        let renders = try Self.exportFile(folder.rendersDir, folder: folder)
        try FileManager.default.createDirectory(at: renders, withIntermediateDirectories: true)
        let destination: URL
        if let out = b["out"] as? String {
            destination = try folder.output(out)
            guard destination.path.hasPrefix(renders.path + "/") else { throw APIError("Native exports must stay under renders/.") }
        } else {
            destination = try Self.exportFile(freeExport(base: (name as NSString).deletingPathExtension, ext: ext, in: renders), folder: folder)
        }
        try rejectReferencedMediaOverwrite(destination)
        let sources = try NativeExportSources.capture(project: snapshot, folder: folder)
        let publication = try NativeExportOutput(folder: folder, destination: destination)
        specBody["out"] = folder.relative(destination); specBody["from"] = from; specBody["to"] = to
        let spec = try ReelNativeExportSpec(body: JSON(any: specBody).text)
        let id = "j" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let temp = try Self.exportFile(folder.cacheDir.appendingPathComponent("mix-\(id).wav"), folder: folder)
        let job = Job(id: id, kind: "export", spec: specBody.sorted { $0.key < $1.key }.map { ($0.key, JSON(any: $0.value)) }, out: destination, partFile: temp)
        job.admission = context.lease; job.admissionContext = context
        job.bindExport(project: snapshot, context: context, sources: sources, output: publication)
        jobs.append(job); broadcast("job", job.json)
        let folder = self.folder
        nativeTasks[id] = Task { [weak self] in
            guard let self else { context.lease.finish(); return }
            do {
                try await context.lease.wait()
                try await self.activateProcessingJob(id, context: context)
                try await ProcessingScope.$context.withValue(context) {
                    let prepared = try await self.prepareExportAudioRange(snapshot, from: from, to: to)
                    let renderer = try await self.freshNativeRenderer()
                    let rendered = try await NativeAudioMixer.render(plan: .raw(prepared.plan), folder: folder)
                    let pcm = try await NativeAudioProcessing.cancellableTask { try prepared.window.trim(rendered) }
                    try Task.checkCancellation()
                    try await self.validateProcessingContext(context)
                    try NativeAudioProcessing.write(pcm, to: Self.exportFile(temp, folder: folder))
                    _ = try await renderer.export(project: snapshot, spec: spec, audioURL: temp, outputPublication: publication, beforePublish: {}, publishOutput: { publication in
                        try await self.publishNativeExportOutput(id, publication: publication)
                    }) { progress in Task { await self.processingProgress(id, progress) } }
                }
            } catch { await self.processingFailed(id, error.localizedDescription) }
            if let checked = try? Self.exportFile(temp, folder: folder) { try? FileManager.default.removeItem(at: checked) }
            await self.processingWorkerExited(id)
            context.lease.finish()
        }
        scheduled = true
        return job.acceptedJSON
    }

    private func prepareExportAudioRange(_ snapshot: String, from: Double, to: Double) throws -> PreparedAudioRange {
        try validateCurrentProcessing()
        return try prepareAudioRange(project: snapshot, from: from, to: to, rounding: .delivery,
                                     planningBudget: processingAdmission.workerByteLimit / 4)
    }

    private func deliveryHistory() -> NativeDeliveryHistory {
        let fields = (try? project.flatMap { try JSON.parse($0) as? [String: Any] }) ?? [:]
        let assets = fields["assets"] as? [String: Any] ?? [:]
        let sources = assets.flatMap { src, value -> [String] in
            let asset = value as? [String: Any] ?? [:]
            return [Optional(src), asset["proxy"] as? String].compactMap { $0 }
        }
        return NativeDeliveryHistory(folder: folder, sources: sources)
    }

    public func deliveryURL(id: String, root: String) throws -> URL {
        try requireOpen()
        return try deliveryHistory().resolve(id: id, root: root)
    }

    private func recordDelivery(_ job: Job) {
        guard job.kind == "export", let output = job.output, let finished = job.finished else { return }
        let spec = (try? JSON.parse(JSON.object(job.spec).text) as? [String: Any]) ?? [:]
        do {
            try requireWritableProject()
            try deliveryHistory().record(output: output, preset: spec["preset"] as? String, finished: finished.timeIntervalSince1970 * 1000, acceptedVersion: job.acceptedVersion, acceptedGeneration: job.acceptedGeneration, acceptedProjectSHA256: job.acceptedProjectSHA256, sourceCohortID: job.sourceCohortID, sourceCohort: job.exportCohortReceipt)
        } catch {
            job.deliveryWarning = "Export saved, but its completion receipt could not be recorded. Refresh delivery history to find the existing output."
        }
    }

    private func completeNativeExport(_ id: String, output: URL) {
        guard let job = jobs.first(where: { $0.id == id }) else { return }
        job.output = folder.relative(output)
        guard !stopped, job.state == "running" else {
            job.deliveryWarning = "The output was saved before cancellation or close completed. Inspect the existing output before retrying."
            broadcast("job", job.json)
            return
        }
        job.state = "done"; job.progress = 1; job.finished = Date(); job.output = folder.relative(output); recordDelivery(job)
        broadcast("job", job.json); pushActivity("reel", "exported \(job.output!)")
    }

    private func applyOps(_ bodyText: String, _ b: [String: Any]) async throws -> JSON {
        guard let project else { throw APIError("No project yet: create one first") }
        if let expected = b["expectedVersion"] as? Int, expected != version { throw APIError("The project changed. Refresh it and retry this import.") }
        var inputs = try expectedLUTInputs(b)
        var ops = try core.field(bodyText, "ops")
        if ops == "null" { ops = "[]" }
        // Probe any media the ops reference that the project has not seen.
        var assets: [(String, JSON)] = []
        for src in try core.unknownSources(project: project, ops: ops) {
            assets.append((src, try await probe(try folder.resolve(src))))
        }
        guard let current = self.project else { throw APIError("the project was closed") }
        try Task.checkCancellation()
        if let expected = b["expectedVersion"] as? Int, expected != version { throw APIError("The project changed. Refresh it and retry this import.") }
        let all = assets.isEmpty ? ops : try core.prependImport(ops: ops, assets: JSON.compact(assets).text)
        let prepared = try prepareLibraryOperations(project: current, ops: all)
        inputs.append(contentsOf: prepared.inputs)
        let result = try core.applyOps(project: current, ops: prepared.ops)
        let log = (try? JSON.parse(result.log) as? [String]) ?? []
        let lines = (b["summary"] as? String).map { [$0] } ?? log.filter { !$0.hasPrefix("imported") }
        try Task.checkCancellation(); try verifyLUTInputs(inputs)
        try commit(result.project, who: b["who"] as? String ?? "you", lines: lines)
        return JSON.compact([
            ("version", .int(version)),
            ("log", .raw(result.log)),
            ("created", .raw(result.created)),
            ("project", (b["returnProject"] as? Bool) == false ? nil : .raw(result.project)),
        ])
    }

    private func exportLibraryComponent(_ body: [String: Any]) throws -> JSON {
        try requireOpen()
        guard let current = project, let expected = body["expectedVersion"] as? Int, expected == version,
              let id = body["item"] as? String,
              let library = try JSON.parse(core.field(current, "library")) as? [String: Any],
              let items = library["items"] as? [[String: Any]], let item = items.first(where: { $0["id"] as? String == id }) else {
            throw APIError("The source component or project changed. Open Export component again.")
        }
        let dependencies = try JSON.parse(core.libraryLUTDependencies(project: current, operation: JSON(any: ["op": "library_register", "item": item]).text)) as? [[String: Any]] ?? []
        var resources: [String: Any] = [:], inputs: [LUTInput] = [], total = 0
        for dependency in dependencies {
            guard let path = dependency["path"] as? String, let expectedHash = dependency["sourceHash"] as? String else { throw APIError("The component LUT receipt is incomplete.") }
            let input = try readLUTInput(path, expectedHash: expectedHash, byteLimit: NativeLibraryResources.fileLimit)
            total += input.text.utf8.count
            guard input.text.utf8.count <= NativeLibraryResources.fileLimit, total <= 4 * 1024 * 1024 else { throw APIError("Component transfer supports LUTs up to 2 MiB each and 4 MiB total.") }
            let inspection = try JSON.parse(ReelLUTInspection.inspect(text: input.text).text) as? [String: Any] ?? [:]
            resources[path] = ["type": "lut", "size": inspection["size"] ?? NSNull(), "sourceHash": input.hash, "text": input.text]
            inputs.append(LUTInput(requestedPath: input.requestedPath, path: input.path, file: input.file, stamp: input.stamp, hash: input.hash, text: ""))
        }
        _ = try core.portableLibraryPlan(item: JSON(any: item).text, resources: JSON(any: resources).text)
        try verifyLUTInputs(inputs); try Task.checkCancellation()
        guard expected == version, try readProjectText() == lastText else { throw APIError("The project changed before component export completed.") }
        return JSON(any: ["item": item, "resources": resources, "version": version])
    }

    private func importLibraryComponent(_ body: [String: Any]) throws -> JSON {
        try requireOpen(); try requireWritableProject(); try Task.checkCancellation()
        guard let current = project, let expected = body["expectedVersion"] as? Int, expected == version,
              let item = body["item"] as? [String: Any], let resources = body["resources"] as? [String: Any] else {
            throw APIError("The destination project changed or the component package is invalid.")
        }
        let itemText = JSON(any: item).text, resourceText = JSON(any: resources).text
        guard itemText.utf8.count <= 2 * 1024 * 1024, resourceText.utf8.count <= 8 * 1024 * 1024 else { throw APIError("The component or packaged LUTs exceed the transfer byte limit.") }
        let plan = try JSON.parse(core.portableLibraryPlan(item: itemText, resources: resourceText)) as? [String: Any] ?? [:]
        guard let files = plan["files"] as? [[String: Any]] else { throw APIError("The component resource plan is invalid.") }
        // Validate every byte/hash/grid before admitting any file.
        var copies: [(String, String, Data)] = []
        for file in files {
            guard let sourcePath = file["sourcePath"] as? String, let hash = file["sourceHash"] as? String,
                  let text = file["text"] as? String, let size = file["size"] as? Int,
                  let source = try? NativeLUTSource(data: Data(text.utf8)), source.sourceHash == hash,
                  let inspection = try JSON.parse(ReelLUTInspection.inspect(text: source.text).text) as? [String: Any],
                  inspection["size"] as? Int == size else { throw APIError("A packaged LUT is corrupt or does not match its grid or digest.") }
            copies.append((sourcePath, hash, Data(text.utf8)))
        }
        var paths: [String: String] = [:]
        for (sourcePath, hash, _) in copies { paths[sourcePath] = "luts/Component-\(hash).cube" }
        let remapped = try core.remapPortableLibraryItem(item: itemText, paths: JSON(any: paths).text)
        let operation = "[{\"op\":\"library_register\",\"item\":\(remapped)}]"
        _ = try core.applyOps(project: current, ops: operation)
        let root = try NativeMediaImportSource.Root(folder)
        var admitted: [String: NativeLibraryResources.File] = [:]
        for (_, hash, data) in copies {
            try requireWritableProject(); try root.validate(); try Task.checkCancellation()
            if admitted[hash] == nil { admitted[hash] = try NativeLibraryResources.admit(root: root, hash: hash, data: data) }
        }
        let prepared = try prepareLibraryOperations(project: current, ops: operation)
        let result = try core.applyOps(project: current, ops: prepared.ops)
        for file in admitted.values { try file.validate() }
        try verifyLUTInputs(prepared.inputs); try root.validate(); try Task.checkCancellation()
        guard expected == version else { throw APIError("The destination project changed before component import committed.") }
        try commit(result.project, who: "you", lines: ["Imported editable component with \(admitted.count) LUT copies"], admission: {
            for file in admitted.values { try file.validate() }
            try self.verifyLUTInputs(prepared.inputs); try root.validate(); try Task.checkCancellation()
            guard expected == self.version else { throw APIError("The destination project changed before component import published.") }
        })
        return JSON(any: ["version": version, "resourcePaths": paths, "registrationItem": try JSON.parse(remapped), "created": try JSON.parse(result.created)])
    }

    private func prepareLibraryOperations(project: String, ops: String) throws -> (ops: String, inputs: [LUTInput]) {
        guard let operations = try JSON.parse(ops) as? [[String: Any]] else { throw APIError("Give an array of edit operations.") }
        guard operations.contains(where: { ["library_save", "library_register", "library_apply"].contains($0["op"] as? String ?? "") }) else { return (ops, []) }
        var working = project, prepared: [[String: Any]] = []
        var inputs: [String: LUTInput] = [:]
        for original in operations {
            try Task.checkCancellation()
            var operation = original
            let dependencies = try JSON.parse(core.libraryLUTDependencies(project: working, operation: JSON(any: operation).text)) as? [[String: Any]] ?? []
            var resources: [String: Any] = [:]
            for dependency in dependencies {
                guard let path = dependency["path"] as? String else { throw APIError("A component LUT needs a project path.") }
                let input = try readLUTInput(path, expectedHash: dependency["sourceHash"] as? String)
                let inspected = try JSON.parse(ReelLUTInspection.inspect(text: input.text).text) as? [String: Any] ?? [:]
                guard let size = inspected["size"] as? Int, inspected["sourceHash"] as? String == input.hash else { throw APIError("Inspect a valid CUBE resource before saving the component.") }
                if let expectedSize = dependency["size"] as? Int, expectedSize != size { throw APIError("The component LUT size does not match inspection: \(path).") }
                if let prior = inputs[path], prior.hash != input.hash || prior.stamp != input.stamp || prior.file != input.file { throw APIError("A component LUT changed during the edit.") }
                resources[path] = ["type": "lut", "size": size, "sourceHash": input.hash]
                inputs[path] = LUTInput(requestedPath: input.requestedPath, path: input.path, file: input.file, stamp: input.stamp, hash: input.hash, text: "")
            }
            if operation["op"] as? String == "library_save", !resources.isEmpty {
                if let supplied = operation["resources"] as? [String: Any], supplied.keys.contains(where: { resources[$0] == nil }) { throw APIError("Unreferenced LUT resource.") }
                operation["resources"] = resources
            }
            prepared.append(operation)
            working = try core.applyOps(project: project, ops: JSON(any: prepared).text).project
        }
        return (JSON(any: prepared).text, inputs.keys.sorted().compactMap { inputs[$0] })
    }

    private func undo() throws -> JSON {
        guard let prev = past.last, let current = project else { return .object([("version", .int(version)), ("project", project.map(JSON.raw) ?? .null)]) }
        try commit(prev, who: "you", lines: ["undo"], history: false)
        past.removeLast()
        future.append(current)
        return .object([("version", .int(version)), ("project", .raw(prev))])
    }

    private func redo() throws -> JSON {
        guard let next = future.last, let current = project else { return .object([("version", .int(version)), ("project", project.map(JSON.raw) ?? .null)]) }
        try commit(next, who: "you", lines: ["redo"], history: false)
        future.removeLast()
        rememberProject(current)
        return .object([("version", .int(version)), ("project", .raw(next))])
    }

    private struct MediaImportCapture {
        let version: Int, generation: UUID, project: String?, root: NativeMediaImportSource.Root
    }
    private func captureMediaImport() throws -> MediaImportCapture {
        try requireOpen(); try requireWritableProject(); try Task.checkCancellation()
        let root = try NativeMediaImportSource.Root(folder)
        if let expected = restorationRootIdentity {
            guard root.identity.device == expected.device, root.identity.inode == expected.inode else { throw APIError("The project folder changed. Reopen it before importing media.") }
        }
        return MediaImportCapture(version: version, generation: projectGeneration, project: project, root: root)
    }
    private func requireMediaImport(_ capture: MediaImportCapture) throws {
        try requireOpen(); try requireWritableProject(); try Task.checkCancellation(); try capture.root.validate()
        guard version == capture.version, projectGeneration == capture.generation, project == capture.project else {
            throw APIError("The project changed during import. No media from this batch was registered in the changed project. Review it before retrying.")
        }
    }

    private struct CopiedMediaRecoveryCapture {
        let id: UUID, importCapture: MediaImportCapture
        let mediaIdentity: NativeMediaImportSource.DirectoryStamp
        let identities: [String: String]
    }
    private var copiedMediaRecovery: CopiedMediaRecoveryCapture?

    /// Explicit read-only discovery of immediate project media files without registered assets.
    public func recoveryMediaCandidates(expectedVersion: Int) throws -> JSON {
        guard expectedVersion >= 0, expectedVersion == version else {
            throw APIError("The project changed before checking copied files. Check again in the current project.")
        }
        copiedMediaRecovery = nil
        let capture = try captureMediaImport()
        let fields = try capture.project.flatMap { try JSON.parse($0) as? [String: Any] } ?? [:]
        let assets = fields["assets"] as? [String: Any] ?? [:]
        func receipt(_ identities: [String: String], limited: Bool, id: UUID = UUID()) -> JSON {
            .object([("rootPath", .string(folder.root.standardizedFileURL.path)), ("version", .int(capture.version)),
                ("recoveryID", .string(id.uuidString)),
                ("project", capture.project.map(JSON.raw) ?? .null),
                ("unregisteredCopies", .array(identities.keys.sorted().map(JSON.string))),
                ("retainedCopyIdentities", .object(identities.sorted { $0.key < $1.key }.map { ($0.key, .string($0.value)) })),
                ("limited", .bool(limited))])
        }
        let mediaFD: Int32
        do { mediaFD = try capture.root.directory("media", create: false) }
        catch let error as NSError where error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT) {
            try requireMediaImport(capture)
            return receipt([:], limited: false)
        }
        defer { close(mediaFD) }
        let mediaIdentity = try NativeMediaImportSource.DirectoryStamp(mediaFD)
        func validateMedia() throws {
            try requireMediaImport(capture)
            let currentFD = try capture.root.directory("media", create: false)
            defer { close(currentFD) }
            guard try NativeMediaImportSource.DirectoryStamp(currentFD) == mediaIdentity,
                  try NativeMediaImportSource.DirectoryStamp(mediaFD) == mediaIdentity else {
                throw APIError("The project media folder changed while checking copied files. Nothing was registered.")
            }
        }
        let enumerationFD = dup(mediaFD)
        guard enumerationFD >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        guard let directory = fdopendir(enumerationFD) else {
            let error = NSError(domain: NSPOSIXErrorDomain, code: Int(errno)); close(enumerationFD); throw error
        }
        defer { closedir(directory) }
        var candidates: [String: NativeMediaImportSource.Stamp] = [:]
        var examined = 0, bytes: Int64 = 0, limited = false
        while true {
            try validateMedia()
            errno = 0
            guard let entry = readdir(directory) else {
                guard errno == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
                break
            }
            examined += 1
            if examined > 512 { limited = true; break }
            let nameLength = Int(entry.pointee.d_namlen)
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: nameLength + 1) { String(validatingUTF8: $0) }
            }
            guard let name, !name.hasPrefix("."), !name.contains("/"), !name.contains("\\"), ProjectFolder.isMedia(name) else { continue }
            let path = "media/\(name)"
            guard assets[path] == nil else { continue }
            var named = Darwin.stat()
            guard fstatat(mediaFD, name, &named, AT_SYMLINK_NOFOLLOW) == 0 else {
                throw APIError("A project media file changed while checking copied files. Check again; nothing was registered.")
            }
            guard named.st_mode & S_IFMT == S_IFREG, named.st_size > 0,
                  named.st_size <= NativeMediaImportSource.maximumBytes else { continue }
            let stamp = try NativeMediaImportSource.Stamp(named)
            if candidates.count == NativeMediaImportSource.maximumRetainedFiles || bytes > NativeMediaImportSource.maximumBytes - stamp.bytes {
                limited = true; break
            }
            candidates[path] = stamp; bytes += stamp.bytes
        }
        try validateMedia()
        var identities: [String: String] = [:]
        for (path, expected) in candidates {
            try Task.checkCancellation()
            var named = Darwin.stat()
            guard fstatat(mediaFD, (path as NSString).lastPathComponent, &named, AT_SYMLINK_NOFOLLOW) == 0,
                  try NativeMediaImportSource.Stamp(named) == expected else {
                throw APIError("A project media file changed while checking copied files. Check again; nothing was registered.")
            }
            identities[path] = Self.retainedCopyIdentity(expected)
        }
        try validateMedia()
        let id = UUID()
        copiedMediaRecovery = CopiedMediaRecoveryCapture(id: id, importCapture: capture, mediaIdentity: mediaIdentity, identities: identities)
        return receipt(identities, limited: limited, id: id)
    }

    public func registerRecoveryMedia(_ paths: [String], recoveryID: String, expectedVersion: Int,
                                      retainedCopyIdentities: [String: String]) async throws -> JSON {
        guard let recovery = copiedMediaRecovery, UUID(uuidString: recoveryID) == recovery.id,
              expectedVersion == recovery.importCapture.version, !paths.isEmpty,
              Set(paths).count == paths.count, Set(retainedCopyIdentities.keys) == Set(paths),
              paths.allSatisfy({ recovery.identities[$0] == retainedCopyIdentities[$0] }) else {
            throw APIError("The copied-file check expired. Check copied files again; nothing was registered.")
        }
        try requireMediaImport(recovery.importCapture)
        let mediaFD = try recovery.importCapture.root.directory("media", create: false)
        defer { close(mediaFD) }
        guard try NativeMediaImportSource.DirectoryStamp(mediaFD) == recovery.mediaIdentity else {
            throw APIError("The project media folder changed. Check copied files again; nothing was registered.")
        }
        return try await importMediaWithRecovery(paths, expectedVersion: expectedVersion, retainedCopyIdentities: retainedCopyIdentities, recovery: recovery)
    }

    private func requireMediaImport(_ capture: MediaImportCapture, recovery: CopiedMediaRecoveryCapture?) throws {
        try requireMediaImport(capture)
        guard let recovery else { return }
        guard copiedMediaRecovery?.id == recovery.id else { throw APIError("The copied-file check expired during registration. Check again; nothing was registered.") }
        try requireMediaImport(recovery.importCapture)
        let mediaFD = try recovery.importCapture.root.directory("media", create: false)
        defer { close(mediaFD) }
        guard try NativeMediaImportSource.DirectoryStamp(mediaFD) == recovery.mediaIdentity else {
            throw APIError("The project media folder changed during registration. No files from this recovery were registered.")
        }
    }

    /// POST /api/import: files or folders inside the project; folders import their media files.
    public func importMedia(_ paths: [String], who: String = "you", expectedVersion: Int? = nil,
                            retainedCopyIdentities: [String: String]? = nil) async throws -> JSON {
        try await importMediaWithRecovery(paths, who: who, expectedVersion: expectedVersion, retainedCopyIdentities: retainedCopyIdentities, recovery: nil)
    }

    private func importMediaWithRecovery(_ paths: [String], who: String = "you", expectedVersion: Int? = nil,
                                         retainedCopyIdentities: [String: String]? = nil, recovery: CopiedMediaRecoveryCapture?) async throws -> JSON {
        if let expectedVersion, expectedVersion < 0 || expectedVersion != version {
            throw APIError("The project changed before this import was admitted. Review Media before retrying.")
        }
        let capture = try captureMediaImport()
        if recovery != nil { try requireMediaImport(capture, recovery: recovery) }
        guard let retainedCopyIdentities else { return try await importCapturedMedia(paths, who: who, capture: capture) }
        guard expectedVersion != nil, !paths.isEmpty, paths.count <= NativeMediaImportSource.maximumRetainedFiles,
              Set(paths).count == paths.count, Set(retainedCopyIdentities.keys) == Set(paths) else {
            throw APIError("Retry only the exact verified copied files from this import.")
        }
        var prepared: [String: NativeMediaImportSource.Snapshot] = [:]
        var selectedBytes: Int64 = 0
        for path in paths {
            try requireMediaImport(capture, recovery: recovery)
            let parts = path.split(separator: "/", omittingEmptySubsequences: false)
            guard parts.count >= 2, parts.first == "media", parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
                  !path.contains("\0"), !path.contains("\\") else { throw APIError("Retry only verified project media files.") }
            let url = try folder.output(path)
            let identity = try NativeMediaImportSource.selectedStamp(url)
            guard retainedCopyIdentities[path] == Self.retainedCopyIdentity(identity) else {
                throw RetainedMediaCopyChangedError(path: path)
            }
            guard selectedBytes <= NativeMediaImportSource.maximumBytes - identity.bytes else { throw APIError("Retry at most 64 GiB of copied media at a time.") }
            selectedBytes += identity.bytes
            prepared[path] = try await NativeMediaImportSource.prepare(url, root: capture.root, expected: identity)
            try requireMediaImport(capture, recovery: recovery)
        }
        for snapshot in prepared.values { try snapshot.validate() }
        return try await importCapturedMedia(paths, who: who, capture: capture, prepared: prepared, exactFilesOnly: true, recovery: recovery)
    }

    private static func retainedCopyIdentity(_ value: NativeMediaImportSource.Stamp) -> String {
        "\(value.device):\(value.inode):\(value.bytes):\(value.mode):\(value.links):\(value.owner):\(value.group):\(value.modifiedSeconds):\(value.modifiedNanos):\(value.changedSeconds):\(value.changedNanos)"
    }

    private func retainedCopyIdentities(_ paths: [String], prepared: [String: NativeMediaImportSource.Snapshot]) -> [String: String] {
        var result: [String: String] = [:]
        for path in paths {
            guard let snapshot = prepared[path] else { continue }
            do {
                try snapshot.validate()
                let identity = try NativeMediaImportSource.selectedStamp(folder.output(path))
                try snapshot.validate()
                result[path] = Self.retainedCopyIdentity(identity)
            } catch { continue }
        }
        return result
    }

    private func importCapturedMedia(_ paths: [String], who: String = "you", capture: MediaImportCapture,
                                     prepared: [String: NativeMediaImportSource.Snapshot] = [:], copied: Set<String> = [],
                                     importLocations: [String: NativeMediaImportLocation] = [:], exactFilesOnly: Bool = false, recovery: CopiedMediaRecoveryCapture? = nil) async throws -> JSON {
        try requireMediaImport(capture, recovery: recovery)
        guard paths.count <= NativeMediaFolderSelection.maximumEntries else { throw APIError("Select at most 10,000 paths for one import.") }
        var selections: [String: NativeMediaFolderSelection.Item] = [:]
        var selectionRoots: [String: URL] = [:]
        var files: [String] = [], failures: [JSON] = []
        for p in paths {
            do {
                let url = try folder.output(p)
                var isDir: ObjCBool = false
                guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { throw APIError("no such file: \(p)") }
                if isDir.boolValue {
                    guard !exactFilesOnly else { throw APIError("A retained copy became a folder. No files from this retry were registered.") }
                    let selection = try NativeMediaFolderSelection.collect(url, project: folder, allowProjectRoot: true)
                    for item in selection.items {
                        let path = folder.relative(item.url)
                        files.append(path); selections[path] = item; selectionRoots[path] = selection.root
                    }
                    failures += selection.issues.map { Self.importFailure(path: "\(p)/\($0.path)", stage: "read", error: $0.error) }
                } else {
                    files.append(folder.relative(url))
                }
            } catch {
                if error is CancellationError || exactFilesOnly { throw error }
                failures.append(Self.importFailure(path: p, stage: "read", error: error))
            }
        }
        if exactFilesOnly, Set(files) != Set(paths) { throw APIError("The exact retained file selection changed before registration.") }
        var seen = Set<String>()
        files = files.filter { seen.insert($0).inserted }
        let importGeneration = capture.generation
        var sources: [String: NativeMediaImportSource.Snapshot] = [:]
        var selectedBytes = prepared.values.reduce(Int64(0)) { $0 + $1.bytes }
        var selectedFiles = prepared.count
        var assets: [(String, JSON)] = [], warnings: [JSON] = []
        var verified: [(path: String, original: String, identity: NativeMusicIdentity.Snapshot)] = []
        for f in files {
            try requireMediaImport(capture, recovery: recovery)
            let existingJSON = try capture.project.flatMap { try core.asset(project: $0, src: f) }
            let existing = try existingJSON.flatMap { try JSON.parse($0) as? [String: Any] } ?? [:]
            let generatedMusic = NativeMusicComposer.isGeneratedAsset(existing)
            var stage = "read"
            do {
                let snapshot: NativeMediaImportSource.Snapshot
                if let held = prepared[f] { snapshot = held }
                else {
                    guard selectedFiles < NativeMediaImportSource.maximumRetainedFiles else { throw APIError("Import at most 32 media files at a time. Select a smaller batch to import the remaining files.") }
                    let sourceURL = try folder.output(f)
                    let expected = try selections[f]?.identity ?? NativeMediaImportSource.selectedStamp(sourceURL)
                    guard selectedBytes <= NativeMediaImportSource.maximumBytes - expected.bytes else { throw APIError("Import at most 64 GiB of media at a time. Select a smaller batch.") }
                    snapshot = try await NativeMediaImportSource.prepare(sourceURL, root: capture.root, expected: expected,
                                                                         selectionRoot: selectionRoots[f], selectionIdentity: selections[f]?.rootIdentity)
                    selectedBytes += snapshot.bytes; selectedFiles += 1
                    try requireMediaImport(capture, recovery: recovery)
                }
                try snapshot.validate()
                stage = generatedMusic ? "identity" : "probe"
                if generatedMusic, let existingJSON {
                    guard NativeMusicComposer.hasByteIdentity(existing) else { throw APIError("This earlier generated music has no saved byte identity. Its Media entry and score were kept unchanged. Import a replacement as a new file to replace it explicitly.") }
                    let identity = try await NativeMusicIdentity.read(folder: folder, path: f, allowOversized: true)
                    try requireMediaImport(capture, recovery: recovery); try snapshot.validate()
                    let probed = try await probe(snapshot.file)
                    try requireMediaImport(capture, recovery: recovery); try snapshot.validate()
                    try identity.validate()
                    let decisionJSON = try NativeMusicComposer.importDecision(existingJSON: existingJSON, probedJSON: probed.text, identity: identity, script: musicSource())
                    guard let decision = try JSON.parse(decisionJSON) as? [String: Any] else { throw APIError("Generated music identity returned an invalid receipt") }
                    guard let replacement = decision["asset"] as? [String: Any] else {
                        throw APIError(decision["message"] as? String ?? "This generated music has no saved byte identity. Its Media entry was kept unchanged.")
                    }
                    guard projectGeneration == importGeneration, let current = project, try core.asset(project: current, src: f) == existingJSON else { throw APIError("The generated music Media entry changed during import. Review it before retrying.") }
                    assets.append((f, JSON(any: replacement)))
                    verified.append((f, existingJSON, identity))
                    if decision["disposition"] as? String == "replaced" {
                        warnings.append(.object([("path", .string(f)), ("name", .string((f as NSString).lastPathComponent)), ("stage", "identity"), ("message", JSON(any: decision["message"]))]))
                    }
                } else {
                    let probed = try await probe(snapshot.file)
                    try requireMediaImport(capture, recovery: recovery); try snapshot.validate()
                    assets.append((f, probed))
                }
                sources[f] = snapshot
            } catch {
                if error is CancellationError || exactFilesOnly { throw error }
                try requireMediaImport(capture, recovery: recovery)
                failures.append(Self.importFailure(path: f, stage: stage, error: error, copied: copied.contains(f)))
            }
        }
        // Other files may have awaited probes; recheck both bytes' captured identity and the
        // original Media record immediately before the single ordinary import operation.
        for item in verified {
            do {
                try item.identity.validate()
                guard projectGeneration == importGeneration, let current = project, try core.asset(project: current, src: item.path) == item.original else { throw APIError("The generated music Media entry changed during import. Review it before retrying.") }
            } catch {
                if error is CancellationError || exactFilesOnly { throw error }
                assets.removeAll { $0.0 == item.path }
                failures.append(Self.importFailure(path: item.path, stage: "identity", error: error))
            }
        }
        for (path, snapshot) in sources where assets.contains(where: { $0.0 == path }) {
            do { try snapshot.validate() }
            catch {
                if error is CancellationError || exactFilesOnly { throw error }
                assets.removeAll { $0.0 == path }
                failures.append(Self.importFailure(path: path, stage: "identity", error: error, copied: copied.contains(path)))
            }
        }
        try requireMediaImport(capture, recovery: recovery)
        let importedPaths = Set(assets.map { $0.0 })
        warnings = warnings.filter { value in
            guard let fields = try? JSON.parse(value.text) as? [String: Any], let path = fields["path"] as? String else { return false }
            return importedPaths.contains(path)
        }
        try Task.checkCancellation()
        // A failed-only batch is a receipt, not an empty edit/history entry.
        if !assets.isEmpty {
            let current = try capture.project ?? core.newProject(name: folder.root.lastPathComponent)
            let existingAssets = (try JSON.parse(current) as? [String: Any])?["assets"] as? [String: Any] ?? [:]
            assets = try assets.map { path, asset in
                let stored = (existingAssets[path] as? [String: Any]).flatMap { NativeMediaImportLocation.read(asset: $0) }
                guard let location = importLocations[path] ?? stored else { return (path, asset) }
                return (path, try NativeMediaImportSession.attach(asset, location: location))
            }
            let op = JSON.array([.object([("op", "import"), ("assets", .object(assets))])])
            let result = try core.applyOps(project: current, ops: op.text)
            if recovery != nil { try requireMediaImport(capture, recovery: recovery) }
            try commit(result.project, who: who, lines: ["imported \(assets.count) media"])
        } else { try requireOpen(); try requireWritableProject() }
        // Make thumbnails ahead of the editor asking, as the server does.
        for (src, asset) in assets {
            guard case .object(let pairs) = asset, pairs.contains(where: { $0.0 == "hasVideo" && $0.1 == .bool(true) }) else { continue }
            Task { await ProcessingScope.$context.withValue(nil) { _ = try? await self.strip(src) } }
        }
        return .object([("assets", .object(assets)), ("version", .int(version)), ("failures", .array(failures)), ("warnings", .array(warnings)),
                        ("unregisteredCopies", .array(copied.subtracting(importedPaths).sorted().map { .string($0) }))])
    }

    /// Restores one explicitly selected missing original. Project JSON and both history
    /// stacks stay byte-for-byte unchanged; this file restoration is outside project Undo.
    public func restoreMissingMedia(source: String, from selected: URL, expectedVersion: Int) async throws -> JSON {
        try requireOpen(); try requireWritableProject()
        guard expectedVersion == version, let capturedProject = project else { throw APIError("The captured project changed. Choose the original again.") }
        // Validate original path/type even when a missing interchange asset has no measured size.
        _ = try core.mediaRestoreSource(project: capturedProject, src: source)
        guard let rootIdentity = restorationRootIdentity else { throw APIError("Reopen this project before restoring its original media.") }
        let target = try folder.output(source)
        try NativeMissingMediaRestore.requireAbsent(target)
        let capturedGeneration = projectGeneration, capturedText = lastText
        let staged = try await NativeMissingMediaRestore.stageAsync(selected, folder: folder, expectedRoot: rootIdentity)
        try requireOpen(); try requireWritableProject()
        guard version == expectedVersion, projectGeneration == capturedGeneration else { throw APIError("The project changed while copying the original. Choose it again.") }
        let measured = try await probe(staged.file)
        try await NativeMissingMediaRestore.validateAsync(staged)
        try requireOpen(); try requireWritableProject()
        guard version == expectedVersion, projectGeneration == capturedGeneration,
              project == capturedProject, lastText.utf8.elementsEqual(capturedText.utf8) else { throw APIError("The project changed while checking the original. Choose it again.") }
        _ = try core.mediaRestorePlan(project: capturedProject, src: source, asset: measured.text,
                                      digest: staged.digest.map { String(format: "%02x", $0) }.joined())
        try NativeMissingMediaRestore.install(staged, source: source, folder: folder, expectedText: capturedText) {
            try self.writeAdmission(); try Task.checkCancellation()
        }
        renderer = nil
        pushActivity("you", "Restored missing original \(source). Project edits and Undo history were preserved.")
        broadcast("media-restored", .object([("source", .string(source)), ("version", .int(version))]))
        return .object([("source", .string(source)), ("version", .int(version)), ("restored", true)])
    }

    /// Copies selected originals through held descriptors, then registers one captured batch.
    public func copyIn(_ urls: [URL], importSession: NativeMediaImportSession? = nil) async throws -> JSON {
        let capture = try captureMediaImport()
        let capturedFields = try capture.project.flatMap { try JSON.parse($0) as? [String: Any] } ?? [:]
        let capturedAssets = capturedFields["assets"] as? [String: Any] ?? [:]
        try importSession?.validate(assets: capturedAssets, version: capture.version)
        if importSession != nil {
            guard (1...NativeMediaImportSource.maximumRetainedFiles).contains(urls.count) else {
                throw APIError("Choose 1 to 32 files or selected folders for a root import batch. Nothing was copied.")
            }
        }
        guard urls.count <= NativeMediaFolderSelection.maximumEntries else { throw APIError("Select at most 10,000 files or folders for one import.") }
        let media = try folder.output(folder.mediaDir.path)
        let mediaFD = try capture.root.directory("media", create: true)
        close(mediaFD)
        var rel: [String] = [], failures: [JSON] = [], copied = Set<String>()
        var prepared: [String: NativeMediaImportSource.Snapshot] = [:]
        var importLocations: [String: NativeMediaImportLocation] = [:]
        var logicalPaths = importSession?.existingPaths(assets: capturedAssets) ?? []
        var selectedBytes: Int64 = 0
        func prepare(_ source: URL, path: String, destination: String?, scope: URL,
                     item: NativeMediaFolderSelection.Item? = nil, selectionRoot: URL? = nil,
                     relativePath: String) async throws {
            try requireMediaImport(capture)
            let location = try importSession?.location(relativePath: relativePath)
            if let location, logicalPaths.contains(location.relativePath) {
                throw APIError("That path is already registered in the imported root: \(location.relativePath). Choose another subfolder or root; no duplicate copy was made.")
            }
            guard prepared.count < NativeMediaImportSource.maximumRetainedFiles else { throw APIError("Import at most 32 media files at a time. Select a smaller batch to import the remaining files.") }
            let expected = try item?.identity ?? NativeMediaImportSource.selectedStamp(source)
            guard selectedBytes <= NativeMediaImportSource.maximumBytes - expected.bytes else { throw APIError("Import at most 64 GiB of media at a time. Select a smaller batch.") }
            let snapshot = try await NativeMediaImportSource.prepare(source, root: capture.root, destination: destination,
                                                                     scope: scope, expected: expected, selectionRoot: selectionRoot,
                                                                     selectionIdentity: item?.rootIdentity)
            // The complete external copy survives every later probe or admission failure.
            if destination != nil { copied.insert(path) }
            prepared[path] = snapshot; selectedBytes += snapshot.bytes; rel.append(path)
            if let location { importLocations[path] = location; logicalPaths.insert(location.relativePath) }
            try requireMediaImport(capture)
        }
        do {
            for url in urls {
                try requireMediaImport(capture)
                do {
                    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
                    let type = attributes[.type] as? FileAttributeType
                    guard type != .typeSymbolicLink else { throw APIError("Symbolic links are not imported. Select the original media instead.") }
                    if type == .typeDirectory {
                        let selection = try NativeMediaFolderSelection.collect(url, project: folder)
                        failures += selection.issues.map { Self.importFailure(path: "\(url.lastPathComponent)/\($0.path)", stage: "read", error: $0.error) }
                        let inside = folder.contains(selection.root)
                        let destination = try folder.output(ProjectFolder.freeName(in: media, for: ProjectFolder.cleanFileName(url.lastPathComponent)).path)
                        if !inside, !selection.items.isEmpty {
                            let reserved = try capture.root.directory(folder.relative(destination), create: true, exclusiveFinal: true)
                            close(reserved)
                        }
                        for item in selection.items {
                            try requireMediaImport(capture)
                            do {
                                try NativeMediaFolderSelection.validate(item, root: selection.root)
                                let target = inside ? try folder.output(item.url.path) : try folder.output(destination.appendingPathComponent(item.relativePath).path)
                                let path = folder.relative(target)
                                try await prepare(item.url, path: path, destination: inside ? nil : path, scope: url,
                                                  item: item, selectionRoot: selection.root, relativePath: item.relativePath)
                            } catch {
                                if let retained = error as? NativeMediaImportSource.RetainedCopyFailure { copied.insert(retained.path) }
                                if error is CancellationError { throw error }
                                try requireMediaImport(capture)
                                failures.append(Self.importFailure(path: "\(url.lastPathComponent)/\(item.relativePath)", stage: "copy", error: error))
                            }
                        }
                        continue
                    }
                    guard type == .typeRegular else { throw APIError("Choose a regular media file or folder.") }
                    let inside = folder.contains(url.standardizedFileURL.resolvingSymlinksInPath())
                    let target = inside ? try folder.output(url.path) : try folder.output(ProjectFolder.freeName(in: media, for: ProjectFolder.cleanFileName(url.lastPathComponent)).path)
                    let path = folder.relative(target)
                    if prepared[path] != nil { continue }
                    try await prepare(url, path: path, destination: inside ? nil : path, scope: url, relativePath: url.lastPathComponent)
                } catch {
                    if let retained = error as? NativeMediaImportSource.RetainedCopyFailure { copied.insert(retained.path) }
                    if error is CancellationError { throw error }
                    try requireMediaImport(capture)
                    failures.append(Self.importFailure(path: url.lastPathComponent, stage: "copy", error: error))
                }
            }
            let receipt = try await importCapturedMedia(rel, capture: capture, prepared: prepared, copied: copied, importLocations: importLocations)
            guard case .object(var fields) = receipt else { return receipt }
            if case .array(let items)? = fields.first(where: { $0.0 == "failures" })?.1 { failures += items }
            fields.removeAll { $0.0 == "failures" }; fields.append(("failures", .array(failures)))
            let admitted: Set<String>
            if case .object(let assets)? = fields.first(where: { $0.0 == "assets" })?.1 { admitted = Set(assets.map { $0.0 }) }
            else { admitted = [] }
            let pending = copied.subtracting(admitted).sorted()
            fields.append(("retainedCopyIdentities", JSON(any: retainedCopyIdentities(pending, prepared: prepared))))
            return .object(fields)
        } catch {
            let paths = copied.sorted()
            let detail = paths.isEmpty ? "No media from this batch was registered." : "Completed copies remain unregistered in the project at \(paths.joined(separator: ", ")). Your selected originals remain unchanged."
            pushActivity("you", "Media import \(error is CancellationError ? "cancelled" : "stopped"). \(detail)")
            broadcast("media-import", .object([("state", error is CancellationError ? "cancelled" : "failed"),
                                               ("registered", 0), ("unregisteredCopies", .array(paths.map { .string($0) })),
                                               ("message", .string(detail))]))
            if error is CancellationError { throw error }
            if !paths.isEmpty {
                throw RetainedMediaCopiesError(message: error.localizedDescription + " " + detail,
                    unregisteredCopies: paths, retainedCopyIdentities: retainedCopyIdentities(paths, prepared: prepared),
                    rootPath: folder.root.standardizedFileURL.path,
                    version: capture.version, projectJSON: capture.project)
            }
            throw APIError(error.localizedDescription + " " + detail)
        }
    }

    private static func importFailure(path: String, stage: String, error: Error, copied: Bool = false) -> JSON {
        let detail = error.localizedDescription + (copied ? " The completed copy remains at \(path), but was not registered in Media. Your selected original remains unchanged." : "")
        return .object([("path", .string(path)), ("name", .string((path as NSString).lastPathComponent)),
                        ("stage", .string(stage)), ("error", .string(detail))])
    }

    private func listFiles(_ dir: String) throws -> JSON {
        let url = try folder.resolve(dir.isEmpty ? "." : dir)
        let rel = folder.relative(url) == folder.root.path ? "" : folder.relative(url)
        let names = try FileManager.default.contentsOfDirectory(atPath: url.path).filter { !$0.hasPrefix(".") && $0 != "node_modules" }.sorted()
        var entries: [JSON] = []
        for name in names {
            var isDir: ObjCBool = false
            FileManager.default.fileExists(atPath: url.appendingPathComponent(name).path, isDirectory: &isDir)
            guard isDir.boolValue || ProjectFolder.isMedia(name) else { continue }
            entries.append(.object([("name", .string(name)), ("dir", .bool(isDir.boolValue)), ("path", .string(rel.isEmpty ? name : "\(rel)/\(name)"))]))
        }
        return .object([("dir", .string(rel)), ("entries", .array(entries))])
    }

    private func strip(_ src: String, highQuality: Bool = false) async throws -> JSON {
        if ProcessingScope.context == nil {
            return try await withProcessingAdmission(["src": src]) { try await self.strip(src, highQuality: highQuality) }
        }

        let file = try folder.resolve(src)
        var assetText: String? = nil
        if let project { assetText = try core.asset(project: project, src: src) }
        let asset: [String: Any]
        if let assetText, let parsed = try? JSON.parse(assetText) as? [String: Any] {
            asset = parsed
        } else {
            asset = (try? JSON.parse(try await probe(file).text) as? [String: Any]) ?? [:]
        }
        return try await MediaDerivatives.filmstrip(file: file, asset: asset, cacheDir: folder.cacheDir, highQuality: highQuality, projectFolder: folder)
    }

    private func analyze(_ request: [String: Any]) async throws -> JSON {
        let kind = request["kind"] as? String ?? request["type"] as? String ?? ""
        var b = request
        // Agents name a clip, as the shared instructions say; measure its source over the clip's
        // own source range (at most 30 s), as the browser editor does.
        if b["src"] == nil, ["noise", "stabilization", "audio-noise"].contains(kind), let target = try processingTarget(b), let src = target.clip["src"] as? String {
            b["src"] = src
            if b["in"] == nil, b["from"] == nil { b["in"] = (target.clip["in"] as? NSNumber)?.doubleValue ?? 0 }
            if b["dur"] == nil {
                let length = ((target.clip["dur"] as? NSNumber)?.doubleValue ?? 5) * abs((target.clip["speed"] as? NSNumber)?.doubleValue ?? 1)
                b["dur"] = min(30, length.isFinite && length > 0 ? length : 5)
            }
        }
        let file = try folder.resolve(b["src"] as? String ?? "")
        switch kind {
        case "noise", "stabilization", "audio-noise":
            let from=(b["in"] as? NSNumber)?.doubleValue ?? (b["from"] as? NSNumber)?.doubleValue ?? 0
            let duration=(b["dur"] as? NSNumber)?.doubleValue ?? 5
            guard from.isFinite,duration.isFinite,from>=0,duration>0,duration<=30 else { throw APIError("Choose an analysis range of up to 30 seconds.") }
            if kind=="audio-noise" { let pcm=try await NativeAudioProcessing.decode(file,from:from,duration:duration);return try NativeProcessingRecommendations.audio(pcm) }
            return try await NativeProcessingRecommendations.video(file:file,kind:kind,from:from,duration:duration)
        case "transcript":
            return try await transcribeSource(b)
        case "silence", "beats", "loudness":
            let pcm = try await NativeAudioProcessing.decode(file)
            return try await NativeAudioProcessing.cancellableTask {
                if kind == "silence" {
                    let ranges = try NativeAudioProcessing.silence(pcm, noise: (b["noise"] as? NSNumber)?.doubleValue ?? -32, minimum: (b["min"] as? NSNumber)?.doubleValue ?? 0.45)
                    return .object([("kind", "silence"), ("ranges", JSON(any: ranges))])
                }
                if kind == "beats" {
                    let beats = try NativeAudioProcessing.beats(pcm)
                    return .compact([("kind", "beats"), ("times", JSON(any: beats.times)), ("bpm", beats.bpm.map(JSON.int))])
                }
                let loudness = try NativeAudioProcessing.measure(pcm)
                return .object([("kind", "loudness"), ("lufs", loudness.integrated.isFinite ? .number(loudness.integrated) : .null), ("lra", loudness.rangeAvailable ? .number(loudness.range) : .null), ("lraAvailable", .bool(loudness.rangeAvailable)), ("tp", loudness.peak.isFinite ? .number(loudness.peak) : .null)])
            }
        case "scenes":
            let times = try await NativeVideoProcessing.scenes(file, threshold: (b["threshold"] as? NSNumber)?.doubleValue ?? 10)
            return .object([("kind", "scenes"), ("times", JSON(any: times))])
        default:
            throw APIError("unknown analysis \(kind)")
        }
    }

    // MARK: original structured music

    private func musicCapabilities() -> JSON {
        JSON(any: ["available": FileManager.default.isReadableFile(atPath: musicScript.path), "renderer": "arya-score-synth/1", "instruments": ["keys", "pluck", "pad", "bass", "bell", "kick", "snare", "hat"], "sampleRate": 48000, "channels": 2, "encoding": "pcm_s24le", "maximumSeconds": 60, "maximumParts": 8, "maximumNotes": 1024, "maximumVoices": 24, "externalMusicModel": false, "source": "Original structured notes, synthesized locally. No sampled instruments or vocals."])
    }

    private func musicSource() throws -> String {
        guard FileManager.default.isReadableFile(atPath: musicScript.path) else { throw APIError("This build is missing the music-composer resource. Rebuild Arya before composing.") }
        return try String(contentsOf: musicScript, encoding: .utf8)
    }

    private func composeMusic(_ request: [String: Any]) async throws -> JSON {
        let who = Self.processingRequester(request)
        var body = request; body.removeValue(forKey: "who")
        try requireOpen(); try requireWritableProject()
        guard !musicComposing, let admittedProject = project, let expected = body["expectedVersion"] as? Int, expected == version else { throw APIError("Open a project, review its current version and wait for any active score before composing.") }
        let script = try musicSource(), bodyJSON = JSON(any: body).text
        _ = try NativeMusicComposer.placementOps(projectJSON: admittedProject, bodyJSON: bodyJSON, script: script)
        let generation = projectGeneration, score = JSON(any: body["score"]).text
        musicComposing = true
        var rendered: NativeMusicComposer.Rendered?, registered = false
        defer {
            musicComposing = false
            if !registered, let rendered {
                let exists = project.flatMap { try? core.asset(project: $0, src: rendered.path) } != nil
                try? NativeMusicComposer.discard(folder: folder, rendered: rendered, registered: exists)
            }
        }
        let result = try await renderMusic(folder, score, musicScript)
        rendered = result
        try requireOpen(); try requireWritableProject()
        guard generation == projectGeneration, let current = project else { throw APIError("The project was replaced while music was composing. No music was registered in the new project.") }
        let targetChanged = version != expected || current != admittedProject
        try result.identity.validate()
        let asset = JSON.raw(try NativeMusicComposer.assetRecord(rendered: result, script: script))
        try prepareProcessingMediaAdmission()
        _ = try await editOperations(ops: .array([.object([("op", "import"), ("assets", .object([(result.path, asset)]))])]), who: who, summary: "Created original music in Media", expectedVersion: version)
        registered = true
        let registeredVersion = version
        do {
            try Task.checkCancellation()
            guard !targetChanged, generation == projectGeneration, let current = project else { throw APIError("The project changed while music was composing. Choose the music asset in Media and retry placement on a reviewed target.") }
            var placement = body; placement["expectedVersion"] = registeredVersion
            let ops = try NativeMusicComposer.placementOps(projectJSON: current, bodyJSON: JSON(any: placement).text, receiptJSON: result.receiptJSON, script: script)
            try result.identity.validate()
            let edit = try await editOperations(ops: .raw(ops), who: who, summary: "Placed original music on \(body["track"] as? String ?? "")", expectedVersion: registeredVersion)
            return .object([("state", "complete"), ("path", .string(result.path)), ("asset", asset), ("renderer", "arya-score-synth/1"), ("track", JSON(any: body["track"])), ("comp", JSON(any: body["comp"])), ("version", .int(version)), ("created", .raw(try core.field(edit.text, "created")))])
        } catch is CancellationError { throw CancellationError() }
        catch {
            pushActivity("reel", "Original music is saved in Media; placement needs review: \(error.localizedDescription)")
            return .object([("state", "asset_ready"), ("path", .string(result.path)), ("asset", asset), ("renderer", "arya-score-synth/1"), ("version", .int(version)), ("applied", false), ("applyError", "The music is saved in Media. Review the target and retry placement without regenerating."), ("retry", "POST /api/audio/compose/place")])
        }
    }

    private func placeMusic(_ request: [String: Any]) async throws -> JSON {
        let who = Self.processingRequester(request)
        var body = request; body.removeValue(forKey: "who")
        try requireOpen(); try requireWritableProject()
        guard body.keys.allSatisfy({ ["path", "track", "start", "comp", "expectedVersion", "volume"].contains($0) }),
              let project, let expected = body["expectedVersion"] as? Int, expected == version,
              let path = body["path"] as? String, let assetJSON = try core.asset(project: project, src: path),
              let asset = try JSON.parse(assetJSON) as? [String: Any], let generated = asset["generated"] as? [String: Any], generated["kind"] as? String == "original-music",
              let normalizedScore = generated["score"], let measurement = generated["measurement"] as? [String: Any],
              let samples = measurement["samples"] as? Int, samples > 0, samples % 2 == 0 else { throw APIError("Choose a generated music asset and review the current project version.") }
        let placementGeneration = projectGeneration
        let identity = NativeMusicComposer.hasByteIdentity(asset) ? try await NativeMusicIdentity.read(folder: folder, path: path, allowOversized: true) : nil
        if let identity, identity.contentSHA256 != generated["contentSHA256"] as? String {
            throw APIError("This generated music file changed. Re-import it as a replacement before placing it. The saved Media entry was left unchanged.")
        }
        let verified = try NativeMusicComposer.probeOwnedWAV(folder: folder, path: path, frames: samples / 2)
        try identity?.validate()
        // Byte verification yields off-actor; retain normal version/project admission.
        guard placementGeneration == projectGeneration, expected == version, self.project == project else { throw APIError("The project changed while music was being verified. Review it before retrying placement.") }
        var target = body; target.removeValue(forKey: "path"); target["score"] = normalizedScore
        let receipt = JSON.object([("path", .string(path)), ("asset", .raw(verified)), ("measurement", JSON(any: measurement))])
        let ops = try NativeMusicComposer.placementOps(projectJSON: project, bodyJSON: JSON(any: target).text, receiptJSON: receipt.text, script: musicSource())
        try identity?.validate()
        let edit = try await editOperations(ops: .raw(ops), who: who, summary: "Placed original music on \(body["track"] as? String ?? "")", expectedVersion: expected)
        return .object([("state", "complete"), ("path", .string(path)), ("asset", .raw(assetJSON)), ("version", .int(version)), ("created", .raw(try core.field(edit.text, "created")))])
    }

    private func captureAudioCleanup(_ body: [String: Any], restore: Bool = false) throws -> ProcessingCapture {
        let request = try NativeAudioProcessing.CleanupRequest(body)
        if let rawVersion = body["expectedVersion"] {
            guard try NativeAudioMixCapture.strictVersion(rawVersion) == version else { throw APIError("The project changed. Refresh it before processing this clip.") }
        }
        if restore, !request.apply { throw APIError("Restore original audio applies an undoable edit. Set apply to true.") }
        let target = try processingTarget(body)
        if restore, target == nil { throw APIError("Choose the cleaned audio clip to restore.") }
        if request.apply, let target, target.clip["kind"] as? String != "audio" { throw APIError("Audio cleanup needs an audio clip.") }
        let fields = (try? JSON.parse(project ?? "{}")) as? [String: Any] ?? [:]
        let original = try target.map { try NativeAudioProcessing.cleanupSource(clip: $0.clip, assets: fields["assets"] as? [String: Any] ?? [:], useOriginal: restore || request.useOriginal) }
        if restore, original == target?.clip["src"] as? String { throw APIError("This clip has no applied cleanup recipe to restore.") }
        if let supplied = body["src"] as? String, let target {
            guard supplied == target.clip["src"] as? String || supplied == original else { throw APIError("The processing source does not match the requested clip or its original cleanup source.") }
        }
        let source = original ?? body["src"] as? String ?? ""
        guard !source.isEmpty else { throw APIError("src is required") }
        let selected = request.apply || restore ? target : nil
        return try captureProcessing(body, target: selected, src: source, targetSource: selected?.clip["src"] as? String)
    }

    private func cleanAudio(_ body: [String: Any], capture queued: ProcessingCapture? = nil) async throws -> JSON {
        let request = try NativeAudioProcessing.CleanupRequest(body)
        let capture = try queued ?? captureAudioCleanup(body)
        try validateProcessing(capture)
        let source = try folder.resolve(capture.src)
        let pcm = try await NativeAudioProcessing.decode(source)
        try request.options.validate(duration: pcm.duration)
        let cleaned = try await NativeAudioProcessing.cancellableTask { try NativeAudioProcessing.clean(pcm, mode: request.mode, options: request.options) }
        try requireOpen(); try Task.checkCancellation()
        let directory = try Self.exportFile(folder.mediaDir.appendingPathComponent("cleaned"), folder: folder)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let output = try Self.exportFile(directory.appendingPathComponent("\(source.deletingPathExtension().lastPathComponent)-\(request.mode)-\(UUID().uuidString).wav"), folder: folder)
        let temp = try Self.exportFile(folder.cacheDir.appendingPathComponent("clean-\(UUID().uuidString).wav"), folder: folder)
        defer { if let checked = try? Self.exportFile(temp, folder: folder) { try? FileManager.default.removeItem(at: checked) } }
        try await NativeAudioProcessing.cancellableTask { try NativeAudioProcessing.writeCleanup(cleaned, to: temp) }
        let measured = try await probe(temp)
        var assetFields = try JSON.parse(measured.text) as? [String: Any] ?? [:]
        guard let audio = assetFields["hasAudio"] as? NSNumber, CFGetTypeID(audio) == CFBooleanGetTypeID(), audio.boolValue,
              let duration = assetFields["duration"] as? NSNumber, CFGetTypeID(duration) != CFBooleanGetTypeID(), duration.doubleValue.isFinite, duration.doubleValue > 0 else { throw APIError("The cleaned output has no valid audio duration. It was not registered in Media.") }
        let durationTolerance = max(0.002, 2 / Double(pcm.rate))
        guard abs(duration.doubleValue - pcm.duration) <= durationTolerance else { throw APIError("The cleaned output duration does not match the complete source. It was not registered in Media.") }
        try requireOpen(); try Task.checkCancellation()
        try validateCleanupSource(capture)
        try prepareProcessingMediaAdmission()
        try FileManager.default.moveItem(at: Self.exportFile(temp, folder: folder), to: Self.exportFile(output, folder: folder))
        let path = folder.relative(output)
        let recipeFields = NativeAudioProcessing.cleanupRecipe(source: capture.src, output: path, mode: request.mode, options: request.options)
        let recipe = JSON(any: recipeFields)
        var processed = recipeFields
        processed["kind"] = "audio-cleanup"; processed["compute"] = "cpu"; processed["sourceStamp"] = capture.sourceFingerprint
        assetFields["processing"] = processed
        let asset = JSON(any: assetFields)
        let result = JSON.object([("path", .string(path)), ("asset", asset), ("mode", .string(request.mode)), ("cached", false), ("settings", JSON(any: request.options.settings)), ("engine", "accelerate-spectral-cpu"), ("recipe", recipe), ("intermediate", "float32-wav")])
        // Clear before assigning so an omitted noise interval cannot survive a JSON merge.
        let ops: [JSON] = capture.target.map { [
            $0.operation("update", fields: [("set", .object([("audioCleanup", .null)]))]),
            $0.operation("update", fields: [("set", .object([("src", .string(path)), ("audioCleanup", recipe)]))])] } ?? []
        return try await cleanupResult(result, capture: capture, path: path, asset: asset, ops: ops, summary: "cleaned \(capture.src) with \(request.mode)")
    }

    private func validateCleanupSource(_ capture: ProcessingCapture) throws {
        try requireOpen(); try Task.checkCancellation()
        guard capture.generation == projectGeneration, capture.root == folder.root.path else { throw APIError("The project was replaced during cleanup. The output was not registered in the new project.") }
        guard capture.sourceFile == (try? folder.resolve(capture.src).path),
              capture.sourceFingerprint == (try? NativeTranscriptStore.fingerprint(capture.src, folder: folder)) else { throw APIError("The cleanup input source changed. The output was not registered in Media.") }
    }

    private func cleanupResult(_ result: JSON, capture: ProcessingCapture, path: String, asset: JSON, ops: [JSON], summary: String) async throws -> JSON {
        var fields = try JSON.parse(result.text) as? [String: Any] ?? [:]
        fields["assetRegistered"] = false; fields["placementRequested"] = capture.target != nil
        if let target = capture.target { fields["applied"] = false; fields["processingTarget"] = try JSON.parse(target.identity.text) }
        do {
            try requireOpen(); try Task.checkCancellation()
            try validateCleanupSource(capture)
            var placementError: Error?
            do { try validateProcessing(capture) } catch is CancellationError { throw CancellationError() } catch { placementError = error }
            try prepareProcessingMediaAdmission()
            _ = try await editOperations(ops: .array([.object([("op", "import"), ("assets", .object([(path, asset)]))])]), who: capture.who, summary: "Saved cleaned audio in Media", expectedVersion: version)
            let admissionVersion = version
            fields["assetRegistered"] = true; fields["admissionVersion"] = admissionVersion; fields["version"] = admissionVersion
            guard capture.target != nil else { return JSON(any: fields) }
            do {
                if let placementError { throw placementError }
                let placementCapture = ProcessingCapture(target: capture.target, version: admissionVersion, generation: capture.generation, root: capture.root, src: capture.src, sourceFile: capture.sourceFile, sourceFingerprint: capture.sourceFingerprint, targetSourceFingerprint: capture.targetSourceFingerprint, who: capture.who)
                try await applyProcessing(placementCapture, ops: ops, summary: summary)
                fields["applied"] = true; fields["version"] = version
            } catch is CancellationError { throw CancellationError() }
            catch { fields["applyError"] = error.localizedDescription }
        } catch is CancellationError { throw CancellationError() }
        catch { fields["registrationError"] = error.localizedDescription; fields["applied"] = false }
        return JSON(any: fields)
    }

    private func restoreAudio(_ body: [String: Any], capture queued: ProcessingCapture? = nil) async throws -> JSON {
        let capture = try queued ?? captureAudioCleanup(body, restore: true)
        guard let target = capture.target else { throw APIError("Choose the cleaned audio clip to restore.") }
        try Task.checkCancellation()
        let result = JSON.object([("path", .string(capture.src)), ("restored", true), ("engine", "accelerate-spectral-cpu")])
        return try await processingResult(result, capture: capture, ops: [target.operation("update", fields: [("set", .object([("src", .string(capture.src)), ("audioCleanup", .null)]))])], summary: "restored original audio \(capture.src)")
    }

    private func normalizeAudio(_ b: [String: Any], capture queued: ProcessingCapture? = nil) async throws -> JSON {
        let clipTarget = try queued?.target ?? processingTarget(b)
        let src = b["src"] as? String ?? queued?.src ?? clipTarget?.clip["src"] as? String ?? ""
        let capture = try queued ?? captureProcessing(b, target: b["apply"] as? Bool == false ? nil : clipTarget, src: src)
        let target = (b["target"] as? NSNumber)?.doubleValue ?? -23
        let ceiling = (b["tp"] as? NSNumber)?.doubleValue ?? -1
        guard target.isFinite, (-70...0).contains(target), ceiling.isFinite, (-24...0).contains(ceiling) else { throw APIError("Give a loudness target from -70 to 0 LUFS and a peak ceiling from -24 to 0 dBTP.") }
        let from = max(0, (b["in"] as? NSNumber)?.doubleValue ?? 0)
        let length = (b["dur"] as? NSNumber)?.doubleValue
        let pcm = try await NativeAudioProcessing.decode(folder.resolve(src), from: from, duration: length)
        let input = try await NativeAudioProcessing.cancellableTask { try NativeAudioProcessing.measure(pcm) }
        guard input.integrated.isFinite else { throw APIError("This source is silent; it has no loudness to normalize.") }
        let gain = max(-60, min(60, target - input.integrated))
        let safeGain = min(gain, ceiling - input.peak)
        let applied = (safeGain * 100).rounded() / 100
        let out = NativeAudioProcessing.Loudness(integrated: input.integrated + applied, range: input.range, peak: input.peak + applied, threshold: input.threshold + applied, rangeAvailable: input.rangeAvailable)
        try requireOpen()
        let result = JSON.object([("gain", .number(applied)), ("target", .number(target)), ("input", input.json), ("output", out.json), ("linear", true), ("peakOver", .bool(input.peak + gain > ceiling)), ("peakLimited", .bool(safeGain < gain)), ("requestedGain", .number(gain))])
        let ops: [JSON] = capture.target.map { [$0.operation("update", fields: [("set", .object([("volume", .number(applied))]))])] } ?? []
        return try await processingResult(result, capture: capture, ops: ops, summary: "normalized \(src) to \(String(format: "%.1f", out.integrated)) LUFS")
    }

    private func syncAudio(_ b: [String: Any]) async throws -> JSON {
        let srcs = b["srcs"] as? [String] ?? []
        guard srcs.count >= 2, srcs.count <= 32 else { throw APIError("Give 2 to 32 multicam sources.") }
        let rate = max(4000, min(16000, (b["rate"] as? NSNumber)?.intValue ?? 8000))
        let window = max(1, min(120, (b["window"] as? NSNumber)?.doubleValue ?? 30))
        let seconds = max(window + 5, min(600, (b["maxSeconds"] as? NSNumber)?.doubleValue ?? 120))
        guard window.isFinite, seconds.isFinite else { throw APIError("Give a finite audio sync range.") }
        try NativeAudioProcessing.validateSyncMemory(sampleCounts: [Int](repeating: Int(ceil(seconds * Double(rate))), count: srcs.count), rate: rate)
        var signals: [[Float]] = []
        for src in srcs {
            try Task.checkCancellation()
            let file = try folder.resolve(src)
            do { signals.append(try await NativeAudioProcessing.decode(file, rate: rate, channels: 1, duration: seconds).channels[0]) }
            catch is CancellationError { throw CancellationError() }
            catch { signals.append([]) }
            try requireOpen(); try Task.checkCancellation()
        }
        let input = signals
        let result = try await NativeAudioProcessing.cancellableTask { try NativeAudioProcessing.sync(input, rate: rate, window: window) }
        var fields = (try JSON.parse(result.text) as? [String: Any]) ?? [:]
        fields["rate"] = rate; fields["window"] = window; fields["analyzed"] = seconds
        return JSON(any: fields)
    }

    private struct ProcessingTarget {
        let id: String
        let comp: String?
        let clip: [String: Any]
        let canvas: [String: Any]
        let track: [String: Any]

        var identity: JSON { .object([("id", .string(id)), ("comp", comp.map(JSON.string) ?? .null)]) }
        func operation(_ op: String, fields: [(String, JSON)]) -> JSON {
            .object([("op", .string(op)), ("id", .string(id)), ("comp", comp.map(JSON.string) ?? .null)] + fields)
        }
    }

    private struct ProcessingCapture {
        let target: ProcessingTarget?
        let version: Int
        let generation: UUID
        let root: String
        let src: String
        let sourceFile: String
        let sourceFingerprint: String
        let targetSourceFingerprint: String?
        /// Who asked for the processing, recorded as the owner of the commits it makes.
        var who = "you"
    }

    private func processingTarget(_ b: [String: Any]) throws -> ProcessingTarget? {
        let requestedScope = b.keys.contains("comp")
        let comp: String?
        if !requestedScope || b["comp"] is NSNull { comp = nil }
        else if let value = b["comp"] as? String, !value.isEmpty { comp = value }
        else { throw APIError("comp must be a composition ID or null for the main timeline.") }
        guard let id = b["clip"] as? String ?? b["id"] as? String else {
            if requestedScope { _ = try projectView(comp: comp) }
            return nil
        }
        guard !id.isEmpty, let project else { throw APIError("Choose a clip in an open project before processing it.") }
        let p = try JSON.parse(project) as? [String: Any] ?? [:]
        let comps = p["comps"] as? [String: [String: Any]] ?? [:]
        var scopes: [(String?, [String: Any])] = [(nil, p)]
        if requestedScope {
            if let comp {
                guard let scope = comps[comp] else { throw APIError("no composition \(comp)") }
                scopes = [(comp, scope)]
            }
        } else { scopes += comps.keys.sorted().map { ($0, comps[$0]!) } }
        var found: [ProcessingTarget] = []
        for (scopeID, scope) in scopes {
            var canvas = scope
            for key in ["width", "height", "fps"] where canvas[key] == nil { canvas[key] = p[key] }
            for track in scope["tracks"] as? [[String: Any]] ?? [] {
                for clip in track["clips"] as? [[String: Any]] ?? [] where clip["id"] as? String == id {
                    found.append(ProcessingTarget(id: id, comp: scopeID, clip: clip, canvas: canvas, track: track))
                }
            }
        }
        guard !found.isEmpty else { throw APIError("no clip \(id) in the requested composition") }
        guard found.count == 1 else { throw APIError("Clip ID \(id) is ambiguous. Specify comp, using null for the main timeline.") }
        return found[0]
    }

    private func captureProcessing(_ b: [String: Any], target: ProcessingTarget?, src: String, targetSource: String? = nil) throws -> ProcessingCapture {
        if let expected = b["expectedVersion"] as? Int, expected != version { throw APIError("The project changed. Refresh it before processing this clip.") }
        if let target {
            guard target.clip["src"] as? String == (targetSource ?? src) else { throw APIError("The processing source does not match the requested clip.") }
            guard target.track["locked"] as? Bool != true else { throw APIError("track \(target.track["id"] as? String ?? "") is locked") }
        }
        let targetFingerprint: String?
        if let targetSource, targetSource != src { targetFingerprint = try NativeTranscriptStore.fingerprint(targetSource, folder: folder) }
        else { targetFingerprint = nil }
        return ProcessingCapture(target: target, version: version, generation: projectGeneration, root: folder.root.path, src: src, sourceFile: try folder.resolve(src).path, sourceFingerprint: try NativeTranscriptStore.fingerprint(src, folder: folder), targetSourceFingerprint: targetFingerprint, who: Self.processingRequester(b))
    }

    private func validateProcessing(_ capture: ProcessingCapture) throws {
        try requireOpen()
        guard capture.generation == projectGeneration, capture.root == folder.root.path,
              capture.sourceFile == (try? folder.resolve(capture.src).path),
              capture.sourceFingerprint == (try? NativeTranscriptStore.fingerprint(capture.src, folder: folder)) else { throw APIError("The source changed during processing. The result was not applied.") }
        if let target = capture.target {
            if let fingerprint = capture.targetSourceFingerprint {
                guard let currentSource = target.clip["src"] as? String, fingerprint == (try? NativeTranscriptStore.fingerprint(currentSource, folder: folder)) else { throw APIError("The current cleaned source changed during processing. The result was not applied.") }
            }
            guard capture.version == version else { throw APIError("The project changed during processing. The result was not applied.") }
            let current = try processingTarget(["id": target.id, "comp": target.comp as Any? ?? NSNull()])
            guard let current, Self.processingFingerprint(target.clip) == Self.processingFingerprint(current.clip),
                  JSON(any: target.track.filter { $0.key != "clips" }).text == JSON(any: current.track.filter { $0.key != "clips" }).text,
                  Self.canvasFingerprint(target.canvas) == Self.canvasFingerprint(current.canvas) else { throw APIError("The target clip or composition changed during processing. The result was not applied.") }
        }
    }

    private static func canvasFingerprint(_ canvas: [String: Any]) -> String {
        JSON.compact(["width", "height", "fps", "background"].map { ($0, canvas[$0].map(JSON.init(any:))) }).text
    }

    private func applyProcessing(_ capture: ProcessingCapture, ops: [JSON], summary: String) async throws {
        try validateProcessing(capture)
        // Processing imports include measured assets, so this commit has no asynchronous probe gap.
        _ = try await editOperations(ops: .array(ops), who: capture.who, summary: summary, expectedVersion: capture.version)
    }

    private func processingResult(_ result: JSON, capture: ProcessingCapture, ops: [JSON], summary: String) async throws -> JSON {
        guard let target = capture.target else { try validateProcessing(capture); return result }
        var fields = try JSON.parse(result.text) as? [String: Any] ?? [:]
        fields["processingTarget"] = try JSON.parse(target.identity.text)
        do {
            try await applyProcessing(capture, ops: ops, summary: summary)
            fields["applied"] = true
        } catch is CancellationError { throw CancellationError() }
        catch { fields["applied"] = false; fields["applyError"] = error.localizedDescription }
        return JSON(any: fields)
    }

    private func visionAnalysis(_ b: [String: Any], kind: String, capture queued: ProcessingCapture? = nil) async throws -> JSON {
        let target = try queued?.target ?? processingTarget(b)
        let id = target?.id, original = target?.clip
        let src = b["src"] as? String ?? original?["src"] as? String ?? "", file = try folder.resolve(src)
        let canvas = target?.canvas ?? ((try? JSON.parse(project ?? "{}")) as? [String: Any] ?? [:])
        let targetW = (b["width"] as? NSNumber)?.doubleValue ?? (canvas["width"] as? NSNumber)?.doubleValue ?? 1080
        let targetH = (b["height"] as? NSNumber)?.doubleValue ?? (canvas["height"] as? NSNumber)?.doubleValue ?? 1920
        let from = (b["in"] as? NSNumber)?.doubleValue ?? (b["from"] as? NSNumber)?.doubleValue ?? (original?["in"] as? NSNumber)?.doubleValue ?? 0
        let speed = (original?["speed"] as? NSNumber)?.doubleValue ?? 1
        let clipDuration = (original?["dur"] as? NSNumber)?.doubleValue
        let duration = (b["dur"] as? NSNumber)?.doubleValue ?? ((b["to"] as? NSNumber)?.doubleValue).map { $0-from } ?? clipDuration.map { $0 * speed } ?? 1
        let fps = (b["fps"] as? NSNumber)?.doubleValue ?? (kind == "track" ? 15 : 2)
        guard from.isFinite, from >= 0, duration.isFinite, duration > 0, duration <= 14_400, fps.isFinite, fps > 0, fps <= (kind == "track" ? 120 : 30), duration * fps <= 20_000,
              targetW.isFinite, targetH.isFinite, targetW > 0, targetH > 0, targetW <= 7680, targetH <= 7680 else { throw APIError("Give a finite source range, target dimensions and at most 20000 Vision samples.") }
        let applying = kind != "saliency" && b["apply"] as? Bool == true && id != nil
        if applying {
            guard original?["src"] as? String == src, original?["reverse"] as? Bool != true, original?["freeze"] == nil, original?["timeMap"] == nil, speed.isFinite, speed > 0 else { throw APIError("Vision framing needs a forward source clip with positive scalar speed.") }
        }
        let capture = try queued ?? captureProcessing(b, target: applying ? target : nil, src: src)
        if kind == "saliency" {
            let at = (b["at"] as? NSNumber)?.doubleValue ?? from
            guard at.isFinite, at >= 0 else { throw APIError("Give a finite, nonnegative source time.") }
            let result = try NativeVisionAnalysis.saliency(await NativeVisionAnalysis.image(file: file, at: at))
            try requireOpen(); try Task.checkCancellation()
            try validateProcessing(capture)
            return result
        }
        let result: JSON
        if kind == "track" {
            let r = b["rect"] as? [String: Any] ?? [:]
            let rect = CGRect(x: (r["x"] as? NSNumber)?.doubleValue ?? 0.25, y: (r["y"] as? NSNumber)?.doubleValue ?? 0.25, width: (r["width"] as? NSNumber)?.doubleValue ?? (r["w"] as? NSNumber)?.doubleValue ?? 0.25, height: (r["height"] as? NSNumber)?.doubleValue ?? (r["h"] as? NSNumber)?.doubleValue ?? 0.25)
            result = try await NativeVisionAnalysis.track(file: file, from: from, duration: duration, fps: fps, rect: rect)
        } else { result = try await NativeVisionAnalysis.autoReframe(file: file, from: from, duration: duration, width: targetW, height: targetH, fps: fps) }
        try requireOpen(); try Task.checkCancellation()
        if let id, let target, applying {
            let clip = target.clip
            let data = (try JSON.parse(result.text) as? [String: Any]) ?? [:], samples = data["samples"] as? [[String: Any]] ?? []
            guard !samples.isEmpty else { throw APIError("Vision did not track a subject in this range.") }
            var ops: [JSON] = []
            let projectW = (canvas["width"] as? NSNumber)?.doubleValue ?? 1920, projectH = (canvas["height"] as? NSNumber)?.doubleValue ?? 1080
            if kind == "autoreframe" {
                let targetW = (data["width"] as? NSNumber)?.doubleValue ?? projectW, targetH = (data["height"] as? NSNumber)?.doubleValue ?? projectH
                guard abs(projectW-targetW)<0.01, abs(projectH-targetH)<0.01 else { throw APIError("Set the project dimensions to the target crop before applying auto reframe.") }
                ops.append(target.operation("update", fields: [("set", .object([("fit", "cover"), ("scale", 1)]))]))
            }
            let first = samples[0], baseX = (clip["x"] as? NSNumber)?.doubleValue ?? projectW/2, baseY = (clip["y"] as? NSNumber)?.doubleValue ?? projectH/2
            let clipIn = (clip["in"] as? NSNumber)?.doubleValue ?? 0, clipSpeed = speed
            let assetW = (data["width"] as? NSNumber)?.doubleValue ?? projectW, assetH = (data["height"] as? NSNumber)?.doubleValue ?? projectH, fit = min(projectW/assetW,projectH/assetH)
            for sample in samples {
                let t = (from-clipIn+((sample["t"] as? NSNumber)?.doubleValue ?? 0))/clipSpeed
                for (prop, base) in [("x", baseX), ("y", baseY)] {
                    let measured = (sample[prop] as? NSNumber)?.doubleValue ?? 0, initial = (first[prop] as? NSNumber)?.doubleValue ?? 0
                    let value = kind == "track" ? base + (measured-initial)*fit : measured
                    ops.append(target.operation("keyframe", fields: [("prop", .string(prop)), ("at", .number(t)), ("value", .number(value)), ("local", true), ("ease", "linear")]))
                }
            }
            return try await processingResult(result, capture: capture, ops: ops, summary: "applied Vision \(kind) to \(id)")
        }
        try validateProcessing(capture)
        return result
    }

    private func startProcessing(_ b: [String: Any], kind: String) async throws -> JSON {
        let resolved = try processingTarget(b), target = b["apply"] as? Bool == false ? nil : resolved
        let src = b["src"] as? String ?? resolved?.clip["src"] as? String ?? ""
        let capture = try captureProcessing(b, target: target, src: src)
        let file = try folder.resolve(src)
        let from = (b["in"] as? NSNumber)?.doubleValue ?? (b["from"] as? NSNumber)?.doubleValue ?? 0
        let duration = (b["dur"] as? NSNumber)?.doubleValue ?? ((b["to"] as? NSNumber)?.doubleValue ?? from)-from
        let speed = kind == "retime" ? (b["speed"] as? NSNumber)?.doubleValue ?? 0.5 : 1
        let fps = (b["fps"] as? NSNumber)?.doubleValue ?? 30, zoom = (b["zoom"] as? NSNumber)?.doubleValue ?? 1.05
        guard from.isFinite, duration.isFinite, from >= 0, duration > 0, duration<=3600, speed.isFinite, speed > 0, speed <= 4, fps.isFinite, fps > 0, fps <= 240, zoom.isFinite, (1...1.5).contains(zoom) else { throw APIError("Give a valid processing range of at most one hour, speed, frame rate and zoom.") }
        if let target {
            if kind == "retime", speed < 0.05 { throw APIError("Applied retime speed must be at least 0.05 to match the timeline speed operation.") }
            let clip = target.clip, scalarSpeed = (clip["speed"] as? NSNumber)?.doubleValue ?? 1
            guard clip["kind"] as? String == "video", clip["reverse"] as? Bool != true, clip["freeze"] == nil, clip["timeMap"] == nil, scalarSpeed.isFinite, scalarSpeed > 0 else { throw APIError("Processing application needs a forward video clip with positive scalar speed.") }
            let sourceIn = (clip["in"] as? NSNumber)?.doubleValue ?? 0, sourceLength = ((clip["dur"] as? NSNumber)?.doubleValue ?? 0) * scalarSpeed
            guard abs(sourceIn-from) < 0.00001, abs(sourceLength-duration) < 0.00001 else { throw APIError("To replace the clip, process its complete source range. Use apply:false for a partial range.") }
        }
        let denoise = NativeVideoDenoiser.Options(quality: b["quality"] as? String ?? "balanced", strength: (b["strength"] as? NSNumber)?.doubleValue ?? 0.65, spatial: (b["spatial"] as? NSNumber)?.doubleValue ?? 0.5, temporal: (b["temporal"] as? NSNumber)?.doubleValue ?? 0.8, detail: (b["detail"] as? NSNumber)?.doubleValue ?? 0.7, sigma: (b["sigma"] as? NSNumber)?.doubleValue ?? 0.06)
        let stabilization = NativeStabilization.Options(smoothing: (b["smoothing"] as? NSNumber)?.doubleValue ?? 0.4, strength: (b["strength"] as? NSNumber)?.doubleValue ?? 1, crop: b["crop"] as? String ?? "auto", maxCrop: (b["maxCrop"] as? NSNumber)?.doubleValue ?? 0.2, model: b["model"] as? String ?? "translation")
        try denoise.validate(); try stabilization.validate()
        var admissionBody = b; admissionBody["src"] = src
        let context = try captureProcessingContext(admissionBody)
        var scheduled = false
        defer { if !scheduled { context.lease.finish() } }
        let codec = b["codec"] as? String ?? "auto"
        try requireOpen(); try Task.checkCancellation()
        guard duration / speed <= 3600, fps <= 120, duration / speed * fps <= 216_000 else { throw APIError("Processing supports at most one hour, 120 fps and 216000 output frames.") }
        let id = "j" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let directory = try Self.exportFile(folder.mediaDir.appendingPathComponent(kind == "retime" ? "retimed" : kind == "person-mask" ? "segmented" : kind == "denoise" ? "denoised" : "stabilized"), folder: folder)
        let tempDir = try Self.exportFile(folder.dotDir.appendingPathComponent("processing"), folder: folder)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let ext = codec.hasPrefix("prores") ? "mov" : "mp4"
        let output = try Self.exportFile(directory.appendingPathComponent("\(file.deletingPathExtension().lastPathComponent)-\(id).\(ext)"), folder: folder)
        let temp = try Self.exportFile(tempDir.appendingPathComponent("\(id).\(ext)"), folder: folder)
        let job = Job(id: id, kind: kind, spec: b.sorted { $0.key < $1.key }.map { ($0.key, JSON(any: $0.value)) }, out: output, partFile: temp, sourceVideoProcessing: true)
        job.processingCapture = capture; job.admission = context.lease; job.admissionContext = context
        let spec = NativeVideoProcessing.Spec(from: from, duration: duration, speed: speed, fps: fps, zoom: zoom, denoise: denoise, stabilization: stabilization, codec: codec)
        jobs.append(job); broadcast("job", job.json)
        let processingFolder = folder
        nativeTasks[id] = Task { [weak self] in
            guard let self else { context.lease.finish(); return }
            do {
                try await context.lease.wait()
                try await self.activateProcessingJob(id, context: context)
                try await ProcessingScope.$context.withValue(context) {
                    let sourceFormat = try await NativeVideoProcessing.sourceFormat(file)
                    let outputCodec = try sourceFormat.outputCodec(codec, personMask: kind == "person-mask")
                    try await self.validateSourceProcessingContext(context)
                    let actualTemp = try await self.processingPath(id, extension: outputCodec.rawValue.hasPrefix("ap") ? "mov" : "mp4")
                    let measurements = try await NativeVideoProcessing.render(file: file, output: actualTemp, mode: kind, spec: spec, confine: { try processingFolder.output($0.path) }) { progress in Task { await self.processingProgress(id, progress) } }
                    try Task.checkCancellation()
                    try await self.prepareProcessingMediaAdmission()
                    await self.completeProcessing(id, src: src, from: from, speed: speed, zoom: zoom, measurements: measurements)
                }
            } catch { await self.processingFailed(id, error.localizedDescription) }
            await self.processingWorkerExited(id)
            context.lease.finish()
        }
        scheduled = true
        if b["wait"] as? Bool == true { return try await waitJob(id, timeout: 60_000) }
        return job.json
    }

    private func processingPath(_ id: String, extension ext: String) throws -> URL {
        guard let job = jobs.first(where: { $0.id == id }), job.state == "running", let context = job.admissionContext else { throw CancellationError() }
        try validateProcessingJobContext(job, context: context)
        job.out = try Self.exportFile(job.out.deletingPathExtension().appendingPathExtension(ext), folder: folder)
        job.partFile = try Self.exportFile(job.partFile.deletingPathExtension().appendingPathExtension(ext), folder: folder)
        return job.partFile
    }

    private func processingProgress(_ id: String, _ progress: Double) { _ = exportProgress(["id": id, "progress": progress]) }
    private func processingFailed(_ id: String, _ error: String) {
        if let job = jobs.first(where: { $0.id == id }), job.state == "running" || job.state == "queued" { fail(job, error) }
    }
    private func completeProcessing(_ id: String, src: String, from: Double, speed: Double, zoom: Double, measurements: JSON) async {
        guard let job = jobs.first(where: { $0.id == id }), job.state == "running", !stopped else { return }
        do {
            let asset = try await probe(Self.exportFile(job.partFile, folder: folder))
            try requireOpen(); guard job.state == "running" else { return }
            try prepareProcessingMediaAdmission()
            try requireWritableProject()
            try FileManager.default.moveItem(at: Self.exportFile(job.partFile, folder: folder), to: Self.exportFile(job.out, folder: folder))
            job.output = folder.relative(job.out)
            job.measurements = measurements
            // Save reusable media independently of placement. A changed target must not
            // strand a successfully rendered file outside the Media catalog.
            let capture = job.processingCapture
            guard capture?.generation == projectGeneration else { throw APIError("The project was replaced during processing. The generated output was not registered in the new project.") }
            var placementError: Error?
            if let capture { do { try validateProcessing(capture) } catch { placementError = error } }
            _ = try await editOperations(ops: .array([.object([("op", "import"), ("assets", .object([(job.output!, asset)]))])]), who: capture?.who ?? "you", summary: "Saved \(job.kind) output in Media", expectedVersion: version)
            job.assetRegistered = true
            if let capture = job.processingCapture {
                do {
                    if let placementError { throw placementError }
                    let placementCapture = ProcessingCapture(target: capture.target, version: version, generation: capture.generation, root: capture.root, src: capture.src, sourceFile: capture.sourceFile, sourceFingerprint: capture.sourceFingerprint, targetSourceFingerprint: capture.targetSourceFingerprint, who: capture.who)
                    try validateProcessing(placementCapture)
                    if let target = capture.target {
                        let original = target.clip
                        var changes: [String: Any] = ["src": job.output!, "in": 0]
                        var ops: [JSON] = []
                        if job.kind == "retime" {
                            if abs(((original["speed"] as? NSNumber)?.doubleValue ?? 1)-speed)>0.00001 { ops.append(target.operation("speed", fields: [("speed", .number(speed))])) }
                            changes["speed"] = 1; changes["retime"] = ["mode": "opticalFlow", "src": src, "in": from, "speed": speed]
                        } else if job.kind == "stabilize" || job.kind == "denoise" {
                            let request = try JSON.parse(JSON.object(job.spec).text) as? [String: Any] ?? [:]
                            var settings: [String: Any] = ["codec": request["codec"] as? String ?? "auto", "fps": (request["fps"] as? NSNumber)?.doubleValue ?? 30]
                            let duration = ((original["dur"] as? NSNumber)?.doubleValue ?? 0) * ((original["speed"] as? NSNumber)?.doubleValue ?? 1)
                            if job.kind == "denoise" {
                                let options = NativeVideoDenoiser.Options(quality: request["quality"] as? String ?? "balanced", strength: (request["strength"] as? NSNumber)?.doubleValue ?? 0.65, spatial: (request["spatial"] as? NSNumber)?.doubleValue ?? 0.5, temporal: (request["temporal"] as? NSNumber)?.doubleValue ?? 0.8, detail: (request["detail"] as? NSNumber)?.doubleValue ?? 0.7, sigma: (request["sigma"] as? NSNumber)?.doubleValue ?? 0.06)
                                settings.merge(["quality": options.quality, "strength": options.strength, "spatial": options.spatial, "temporal": options.temporal, "detail": options.detail, "sigma": options.sigma]) { _, value in value }
                                changes["noiseReduction"] = ["src": src, "in": from, "dur": duration, "output": job.output!, "engine": "metal-motion-bilateral", "settings": settings]
                            } else {
                                let options = NativeStabilization.Options(smoothing: (request["smoothing"] as? NSNumber)?.doubleValue ?? 0.4, strength: (request["strength"] as? NSNumber)?.doubleValue ?? 1, crop: request["crop"] as? String ?? "auto", maxCrop: (request["maxCrop"] as? NSNumber)?.doubleValue ?? 0.2, model: request["model"] as? String ?? "translation")
                                settings.merge(["smoothing": options.smoothing, "strength": options.strength, "crop": options.crop, "maxCrop": options.maxCrop, "model": options.model, "zoom": zoom]) { _, value in value }
                                changes["deshake"] = ["src": src, "in": from, "dur": duration, "output": job.output!, "zoom": zoom, "engine": "vision-coreimage", "settings": settings, "measurements": try JSON.parse(measurements.text)]
                            }
                        }
                        else { changes["magicMask"] = ["src": src, "in": from, "engine": "vision-person"] }
                        ops.append(target.operation("update", fields: [("set", JSON(any: changes))]))
                        try await applyProcessing(placementCapture, ops: ops, summary: "\(job.kind) processed \(src)")
                        job.applied = true
                    }
                } catch is CancellationError { throw CancellationError() }
                catch { job.applied = false; job.applyError = error.localizedDescription + " The derived source is saved in Media; apply that asset manually without regenerating it." }
            }
            job.state = "done"; job.progress = 1; job.finished = Date()
            broadcast("job", job.json); pushActivity("reel", "\(job.kind) finished: \(job.output!)")
        } catch { processingFailed(id, error.localizedDescription) }
    }

    private static func processingFingerprint(_ clip:[String:Any])->String {
        JSON(any: clip).text
    }

    private func makeLook(_ b: [String: Any]) async throws -> JSON {
        guard let project else { throw APIError("Open a project before creating a look.") }
        let expected = version
        if let supplied = b["expectedVersion"] as? Int, supplied != expected { throw APIError("The project changed. Refresh it before matching a look.") }
        let mix = (b["mix"] as? Double) ?? 1
        guard mix.isFinite, (0...1).contains(mix) else { throw APIError("LUT mix must be between zero and one.") }
        let view = try projectView(comp: b["comp"] as? String)
        if let clip = b["clip"] as? String {
            _ = try core.applyOps(project: project, ops: JSON.array([.compact([("op", "update"), ("id", .string(clip)), ("comp", (b["comp"] as? String).map(JSON.string) ?? .null), ("set", .object([]))])]).text)
        }
        let at = (b["at"] as? Double) ?? 0
        guard at.isFinite, at >= 0 else { throw APIError("Choose a valid source frame time.") }
        var image: CGImage?
        if b["reference"] is String {
            image = try await nativeRenderer().render(project: project, at: at, comp: b["comp"] as? String, width: 512).cgImage()
        }
        try Task.checkCancellation()
        try requireOpen()
        guard version == expected else { throw APIError("The project changed while its source frame rendered. Retry the look.") }
        let result = try NativeLook.generate(folder: folder, core: core, body: b, source: image)
        let grade = JSON.object([("lut", .string(result.path)), ("lutMix", .number(mix)), ("lutSpace", "srgb")])
        let ops: JSON
        if let clip = b["clip"] as? String {
            ops = .array([.compact([("op", "update"), ("id", .string(clip)), ("comp", (b["comp"] as? String).map(JSON.string) ?? .null), ("set", .object([("grade", grade)]))])])
        } else {
            ops = .array([.compact([("op", "adjustment"), ("comp", (b["comp"] as? String).map(JSON.string) ?? .null), ("start", 0), ("dur", .number(max(1, try core.duration(project: view)))), ("set", .object([("label", "Reference look"), ("grade", grade)]))])])
        }
        var response: [(String, JSON)] = [("lut", .string(result.path)), ("path", .string(result.path)), ("manifest", .string(result.manifest)), ("ops", ops), ("measurements", result.measurements), ("warnings", JSON(any: result.warnings))]
        if b["apply"] as? Bool == true {
            let edit = try await editOperations(ops: ops, who: b["who"] as? String ?? "you", summary: "Apply generated look", expectedVersion: expected)
            response += [("edit", edit), ("version", .int(version))]
        }
        return .object(response)
    }

    private func listLuts() -> JSON {
        var out: [String] = []
        for dir in [folder.root.appendingPathComponent("luts"), folder.root.appendingPathComponent("LUTs"), folder.root] {
            for name in ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).sorted() where name.lowercased().hasSuffix(".cube") {
                let rel = folder.relative(dir.appendingPathComponent(name))
                if !out.contains(rel) { out.append(rel) }
            }
        }
        return .object([("luts", .array(out.map { .string($0) }))])
    }

    private struct LUTInput {
        let requestedPath: String
        let path: String
        let file: URL
        let stamp: String
        let hash: String
        let text: String
    }

    private func readLUTInput(_ path: String, expectedHash: String? = nil, retainText: Bool = true, byteLimit: Int = 128 * 1024 * 1024) throws -> LUTInput {
        let file = try folder.resolve(path)
        guard file.pathExtension.lowercased() == "cube" else { throw APIError("Choose a standalone .cube LUT.") }
        let stamp = try NativeTranscriptStore.fingerprint(file.path, folder: folder)
        let size = (try file.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
        guard size > 0, size <= byteLimit else { throw APIError("The CUBE file exceeds this action's byte limit.") }
        let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
        var bytes = Data()
        while let chunk = try handle.read(upToCount: min(64 * 1024, byteLimit - bytes.count + 1)), !chunk.isEmpty {
            bytes.append(chunk)
            guard bytes.count <= byteLimit else { throw APIError("The CUBE file exceeds this action's byte limit.") }
        }
        guard let source = try? NativeLUTSource(data: bytes) else { throw APIError("Choose a UTF-8 CUBE file of at most 128 MiB.") }
        let hash = source.sourceHash
        if let expectedHash {
            guard expectedHash.count == 64, expectedHash == hash else { throw APIError("The LUT changed after inspection. Inspect it again before applying.") }
        }
        guard try folder.resolve(path) == file, try NativeTranscriptStore.fingerprint(file.path, folder: folder) == stamp else {
            throw APIError("The LUT changed while it was read. Inspect it again before applying.")
        }
        return LUTInput(requestedPath: path, path: folder.relative(file), file: file, stamp: stamp, hash: hash, text: retainText ? source.text : "")
    }

    private func expectedLUTInputs(_ body: [String: Any]) throws -> [LUTInput] {
        guard body.keys.contains("expectedInputs") else { return [] }
        guard let supplied = body["expectedInputs"] as? [[String: Any]], supplied.count <= 32 else { throw APIError("Give at most 32 captured LUT inputs.") }
        var seen = Set<String>(), inputs: [LUTInput] = []
        for item in supplied {
            guard let path = item["path"] as? String, let hash = item["sourceHash"] as? String else { throw APIError("Each LUT input requires a path and sourceHash.") }
            let input = try readLUTInput(path, expectedHash: hash, retainText: false)
            guard seen.insert(input.file.path).inserted else { throw APIError("A captured LUT input was repeated.") }
            inputs.append(input)
        }
        return inputs
    }

    private func verifyLUTInputs(_ inputs: [LUTInput]) throws {
        for input in inputs {
            let current = try readLUTInput(input.requestedPath, expectedHash: input.hash, retainText: false)
            guard current.file == input.file, current.stamp == input.stamp else { throw APIError("The LUT changed before the edit could commit. Inspect it again.") }
        }
    }

    /// Imports validated UTF-8 CUBE text as a new project copy; the picked original is untouched.
    private func importLUT(_ body: [String: Any]) throws -> JSON {
        guard let name = body["name"] as? String, (name as NSString).pathExtension.lowercased() == "cube",
              let text = body["text"] as? String, text.utf8.count <= 16 * 1024 * 1024 else {
            throw APIError("Choose a UTF-8 CUBE file of at most 16 MiB.")
        }
        var result = try JSON.parse(ReelLUTInspection.inspect(text: text).text) as? [String: Any] ?? [:]
        try requireOpen(); try Task.checkCancellation()
        let directory = try folder.output(folder.root.appendingPathComponent("luts").path)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = try folder.output(ProjectFolder.freeName(in: directory, for: ProjectFolder.cleanFileName(name)).path)
        try Data(text.utf8).write(to: file, options: .withoutOverwriting)
        result["path"] = folder.relative(file); result["imported"] = true
        return JSON(any: result)
    }

    private func inspectLUT(_ body: [String: Any]) throws -> JSON {
        guard let path = body["path"] as? String else { throw APIError("Choose a project LUT path to inspect.") }
        let input = try readLUTInput(path)
        var result = try JSON.parse(ReelLUTInspection.inspect(text: input.text).text) as? [String: Any] ?? [:]
        try verifyLUTInputs([input])
        result["path"] = input.path
        return JSON(any: result)
    }

    private func exportLUT(_ body: [String: Any]) throws -> JSON {
        guard let path = body["path"] as? String, let hash = body["expectedInputHash"] as? String else { throw APIError("Inspect the LUT before exporting it.") }
        let input = try readLUTInput(path, expectedHash: hash)
        var result = try JSON.parse(ReelLUTInspection.inspect(text: input.text).text) as? [String: Any] ?? [:]
        try Task.checkCancellation(); try verifyLUTInputs([input])
        result["path"] = input.path; result["text"] = input.text
        return JSON(any: result)
    }

    private func applyLUT(_ body: [String: Any]) throws -> JSON {
        guard let project, let expected = body["expectedVersion"] as? Int, expected == version else { throw APIError("The project changed. Refresh it before applying this LUT.") }
        guard body.keys.contains("comp"), body["comp"] is NSNull || body["comp"] is String else { throw APIError("Specify a composition ID or null for the main timeline.") }
        guard let path = body["path"] as? String, let hash = body["expectedInputHash"] as? String else { throw APIError("Inspect the LUT before applying it.") }
        let input = try readLUTInput(path, expectedHash: hash)
        _ = try ReelLUTInspection.inspect(text: input.text)
        let comp = body["comp"] as? String
        guard comp == nil || comp?.isEmpty == false else { throw APIError("Choose a valid composition ID.") }
        let mix = (body["mix"] as? NSNumber)?.doubleValue ?? 1, space = body["space"] as? String ?? "srgb"
        guard mix.isFinite, (0...1).contains(mix), ["srgb", "working"].contains(space) else { throw APIError("Choose a LUT mix between zero and one and a supported color space.") }
        guard let targets = body["targets"] as? [[String: Any]], !targets.isEmpty, targets.count <= 256 else { throw APIError("Choose between 1 and 256 visual LUT targets.") }
        var seen = Set<String>(), operations: [JSON] = []
        let visual = Set(["video", "image", "title", "shape", "color", "comp", "adjustment", "multicam"])
        for item in targets {
            guard let id = item["id"] as? String, let kind = item["kind"] as? String,
                  let target = try processingTarget(["id": id, "comp": comp as Any? ?? NSNull()]),
                  visual.contains(target.clip["kind"] as? String ?? ""), target.track["locked"] as? Bool != true else {
                throw APIError("Choose an unlocked visual clip in the captured composition.")
            }
            let nodeID = item["node"] as? String
            let identity = JSON(any: ["id": id, "kind": kind, "node": nodeID as Any? ?? NSNull()]).text
            guard seen.insert(identity).inserted else { throw APIError("A LUT target was repeated.") }
            let grade = JSON(any: ["lut": input.path, "lutMix": mix, "lutSpace": space])
            if kind == "clipGrade", nodeID == nil {
                operations.append(target.operation("update", fields: [("set", .object([("grade", grade)]))]))
            } else {
                guard let nodeID, let graph = target.clip["nodes"] as? [String: Any],
                      let node = (graph["list"] as? [[String: Any]])?.first(where: { $0["id"] as? String == nodeID }) else { throw APIError("The captured color node is missing.") }
                let settings: JSON
                if kind == "nodeGrade", node["type"] as? String == "corrector" { settings = .object([("grade", grade)]) }
                else if kind == "lutNode", node["type"] as? String == "lut" { settings = JSON(any: ["lut": input.path, "mix": mix, "lutSpace": space]) }
                else { throw APIError("Choose a corrector or LUT node that matches the captured target kind.") }
                operations.append(target.operation("node_update", fields: [("node", .string(nodeID)), ("set", settings)]))
            }
        }
        let result = try core.applyOps(project: project, ops: JSON.array(operations).text)
        try Task.checkCancellation(); try verifyLUTInputs([input])
        guard expected == version, self.project == project else { throw APIError("The project changed before the LUT edit could commit.") }
        try commit(result.project, who: body["who"] as? String ?? "you", lines: ["Applied LUT to \(targets.count) targets"])
        return JSON(any: ["applied": true, "path": input.path, "sourceHash": input.hash, "version": version, "project": try JSON.parse(result.project)])
    }

    // MARK: captions and timeline interchange

    private func interchangeFiles(_ query: [String: String]) throws -> JSON {
        let dir = try folder.resolve(query["dir"].flatMap { $0.isEmpty ? nil : $0 } ?? ".")
        let captions = Set(["srt", "vtt"]), timeline = Set(["fcpxml", "fcpxmld", "otio", "xml"])
        let allowed = query["kind"] == "captions" ? captions : query["kind"] == "timeline" ? timeline : captions.union(timeline)
        var entries: [(String, Bool, JSON)] = []
        for name in try FileManager.default.contentsOfDirectory(atPath: dir.path) where !name.hasPrefix(".") && name != "node_modules" {
            let file = try folder.resolve(folder.relative(dir.appendingPathComponent(name)))
            var isDir: ObjCBool = false
            FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir)
            let directory = isDir.boolValue && file.pathExtension.lowercased() != "fcpxmld"
            guard directory || allowed.contains(file.pathExtension.lowercased()) else { continue }
            entries.append((name, directory, .object([("name", .string(name)), ("dir", .bool(directory)), ("path", .string(folder.relative(file)))])))
        }
        entries.sort { $0.1 != $1.1 ? $0.1 : $0.0.localizedStandardCompare($1.0) == .orderedAscending }
        return .object([("dir", .string(dir == folder.root ? "" : folder.relative(dir))), ("entries", .array(entries.map { $0.2 }))])
    }

    private func exportInterchange(_ text: String, _ b: [String: Any]) throws -> JSON {
        guard let project else { throw APIError("No project yet: create one first") }
        let format = (b["format"] as? String ?? "").lowercased()
        guard ["fcpxml", "otio", "srt", "vtt"].contains(format) else { throw APIError("format must be fcpxml, otio, srt or vtt") }
        var body = b
        body["format"] = format
        let result = (try JSON.parse(core.exportInterchange(project: project, root: folder.root.path, body: JSON(any: body).text)) as? [String: Any]) ?? [:]
        let fields = (try? JSON.parse(project) as? [String: Any]) ?? [:]
        let composition = (fields["comps"] as? [String: [String: Any]])?[b["comp"] as? String ?? ""]
        let raw = b["name"] as? String ?? composition?["name"] as? String ?? fields["name"] as? String ?? "reel"
        let clean = raw.replacingOccurrences(of: "[^\\w.-]+", with: "-", options: .regularExpression).replacingOccurrences(of: "^[.-]+", with: "", options: .regularExpression)
        let file = try folder.output(b["out"] as? String ?? "renders/\(clean.isEmpty ? "reel" : clean).\(format)")
        guard file.path.hasPrefix(folder.rendersDir.path + "/"), file.pathExtension.lowercased() == format else { throw APIError("Choose an interchange output under renders/ with the requested extension.") }
        try rejectReferencedMediaOverwrite(file)
        let publication = try NativeExportOutput(folder: folder, destination: file)
        defer { publication.cleanup() }
        try Data((result["text"] as? String ?? "").utf8).write(to: publication.part, options: .withoutOverwriting)
        try requireWritableProject()
        try rejectReferencedMediaOverwrite(file)
        _ = try publication.publish()
        pushActivity("reel", "exported \(folder.relative(file))")
        return .object([("path", .string(folder.relative(file))), ("warnings", JSON(any: result["warnings"] ?? []))])
    }

    private func importInterchange(_ b: [String: Any]) async throws -> JSON {
        let applying = b["apply"] as? Bool == true
        let expected = b["expectedVersion"] as? Int ?? version
        if applying, expected != version { throw APIError("The project changed. Refresh it and retry this import.") }
        let rel = b["path"] as? String ?? ""
        var file = try folder.resolve(rel)
        var format = file.pathExtension.lowercased()
        if format == "fcpxmld" { file = try folder.resolve(folder.relative(file.appendingPathComponent("Info.fcpxml"))); format = "fcpxml" }
        guard ["fcpxml", "otio", "srt", "vtt", "xml"].contains(format) else { throw APIError("Reel reads .fcpxml, .fcpxmld, .otio, .srt and .vtt") }
        let size = ((try FileManager.default.attributesOfItem(atPath: file.path))[.size] as? NSNumber)?.int64Value ?? 0
        guard size <= 64 * 1024 * 1024 else { throw APIError("\(rel) is larger than 64 MB") }
        let text = try String(contentsOf: file, encoding: .utf8)
        let sourceHash = Self.interchangeHash(text)
        if applying, let supplied = b["expectedInputHash"] {
            guard let hash = supplied as? String, hash == sourceHash else { throw APIError("The interchange input changed. Preview it again before applying.") }
        }
        let inputFile = file
        func validateInput() throws {
            var latest = try folder.resolve(rel)
            if latest.pathExtension.lowercased() == "fcpxmld" { latest = try folder.resolve(folder.relative(latest.appendingPathComponent("Info.fcpxml"))) }
            let size = ((try FileManager.default.attributesOfItem(atPath: latest.path))[.size] as? NSNumber)?.int64Value ?? 0
            guard latest.path == inputFile.path, size <= 64 * 1024 * 1024,
                  Self.interchangeHash(try String(contentsOf: latest, encoding: .utf8)) == sourceHash else { throw APIError("The interchange input changed. Preview it again before applying.") }
        }
        if ["xml", "fcpxml"].contains(format), text.range(of: "<fcpxml[\\s>]", options: .regularExpression) == nil { throw APIError("\(rel) is not FCPXML") }
        var result = (try JSON.parse(core.importInterchange(text: text, format: format, root: folder.root.path)) as? [String: Any]) ?? [:]
        result["sourceHash"] = sourceHash; result["sourcePath"] = folder.relative(inputFile); result["version"] = version
        if let captions = result["captions"] as? [[String: Any]] {
            guard !captions.isEmpty else { throw APIError("no captions found in \(rel)") }
            if b.keys.contains("comp") {
                guard b["comp"] is NSNull || b["comp"] is String else { throw APIError("comp must be a composition ID or null for the main timeline.") }
                _ = try projectView(comp: b["comp"] as? String)
            }
            if applying {
                try requireOpen(); try validateInput()
                let op = JSON.compact([("op", "captions"), ("items", JSON(any: captions)), ("comp", b.keys.contains("comp") ? JSON(any: b["comp"]) : .null), ("track", JSON.str(b["track"] as? String)), ("replace", .bool(b["replace"] as? Bool ?? false))])
                let body = JSON.object([("ops", .array([op])), ("who", JSON(any: b["who"] ?? "you")), ("expectedVersion", .int(expected))]).text
                let edited = try await applyOps(body, (try JSON.parse(body) as? [String: Any]) ?? [:])
                result["version"] = try JSON.parse(core.field(edited.text, "version"))
                result["applied"] = true
            }
            return JSON(any: result)
        }
        guard var imported = result["project"] as? [String: Any] else { throw APIError("the interchange file has no timeline") }
        var assets = imported["assets"] as? [String: Any] ?? [:]
        var missing: [String] = [], probed: [String] = [], warnings = result["warnings"] as? [String] ?? []
        for src in assets.keys.sorted() {
            guard let media = try? folder.resolve(src), FileManager.default.fileExists(atPath: media.path) else { missing.append(src); continue }
            if applying {
                do {
                    let asset = try await probe(media)
                    try Task.checkCancellation()
                    let fields = try JSON.parse(asset.text)
                    assets[src] = fields
                    probed.append(src)
                }
                catch is CancellationError { throw CancellationError() }
                catch { warnings.append("could not read \(src): \(error.localizedDescription)") }
            }
        }
        imported["assets"] = assets
        result["project"] = imported
        result["missing"] = missing
        result["warnings"] = warnings
        if applying {
            try requireOpen()
            try validateInput()
            guard expected == version else { throw APIError("The project changed. Refresh it and retry this import.") }
            guard let current = project else { throw APIError("No project yet: create one first") }
            let applied = try core.applyOps(project: current, ops: JSON.array([.object([("op", "replace"), ("project", JSON(any: imported))])]).text)
            try commit(applied.project, who: b["who"] as? String ?? "you", lines: ["imported \(rel)"])
            result["project"] = try JSON.parse(applied.project)
            result["version"] = version
            result["applied"] = true
            result["probed"] = probed
        }
        return JSON(any: result)
    }

    private static func interchangeHash(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func transcriptCaptions(_ text: String, _ b: [String: Any]) async throws -> JSON {
        guard let current = project else { throw APIError("No project yet: create one first") }
        let expected = b["expectedVersion"] as? Int ?? version, generation = projectGeneration
        let src = try b["src"] as? String ?? core.clipSource(project: current, id: b["id"] as? String ?? "")
        guard !src.isEmpty else { throw APIError("Give src or id of a clip that plays media.") }
        let locale = try NativeTranscriptStore.localeID(b["locale"] as? String)
        let guarded = b.keys.contains("expectedSourceFingerprint") || b.keys.contains("expectedTranscriptRevision")
        // Caption requests always compare supplied words, even if another endpoint's captions flag is present.
        let reviewBody = b.merging(["captions": true]) { _, new in new }
        let source = guarded ? try NativeTranscriptStore.sourceIdentity(src, folder: folder) : nil
        let transcript: JSON
        if let source {
            guard b["expectedSourceFingerprint"] is String, b["expectedTranscriptRevision"] is Int else {
                throw APIError("Caption preview requires both the saved source fingerprint and transcript revision.")
            }
            let saved = try NativeTranscriptStore.read(src: src, locale: locale, folder: folder)
            let fields = try JSON.parse(saved.text) as? [String: Any] ?? [:]
            try validateShortsReview(reviewBody, sourceFingerprint: source.fingerprint, saved: fields, duration: sourceDuration(src))
            transcript = b["words"] == nil ? saved : JSON(any: fields.merging(["words": b["words"]!]) { _, new in new })
        } else {
            transcript = b["words"] == nil ? try await transcribeSource(b.merging(["src": src]) { _, new in new }) : JSON(any: ["words": b["words"]!])
        }
        try requireOpen()
        guard let latest = project, expected == version, generation == projectGeneration else { throw APIError("The project changed while transcription ran. Retry caption creation with the current project.") }
        let fields = try JSON.parse(transcript.text) as? [String: Any] ?? [:]
        if fields["status"] as? String == "partial", b["words"] == nil, b["acceptPartial"] as? Bool != true { throw APIError("Recognition returned a partial transcript. Review its words before creating captions.") }
        if let source {
            guard source == (try NativeTranscriptStore.sourceIdentity(src, folder: folder)) else { throw APIError("The source changed. Preview captions again.") }
        }
        let words = JSON(any: fields["words"] ?? []).text
        var result = (try JSON.parse(core.transcriptCaptions(project: latest, src: src, words: words, body: text)) as? [String: Any]) ?? [:]
        let items = result["items"] as? [[String: Any]] ?? []
        guard !items.isEmpty else { throw APIError("The transcript has no words inside a forward clip in this composition.") }
        let op = JSON.compact([("op", "captions"), ("items", JSON(any: items)), ("comp", JSON.str(result["comp"] as? String)), ("track", JSON.str(b["track"] as? String)), ("replace", .bool(b["replace"] as? Bool ?? false)), ("style", JSON(any: result["style"])), ("burnIn", .bool(b["burnIn"] as? Bool ?? true))])
        result["src"] = src; result["wordCount"] = (fields["words"] as? [Any])?.count ?? 0
        result["ops"] = [try JSON.parse(op.text)]; result["version"] = version
        if let source {
            result["sourceFingerprint"] = fields["fingerprint"] ?? source.fingerprint
            result["transcriptRevision"] = fields["revision"] ?? 0
        }
        if b["apply"] as? Bool == true {
            if let source {
                let applied = try core.applyOps(project: latest, ops: JSON.array([op]).text)
                let finalSaved = try JSON.parse(NativeTranscriptStore.read(src: src, locale: locale, folder: folder).text) as? [String: Any] ?? [:]
                try requireOpen()
                guard generation == projectGeneration, project == latest, version == expected,
                      source == (try NativeTranscriptStore.sourceIdentity(src, folder: folder)) else {
                    throw APIError("The project or source changed before creation. Preview captions again.")
                }
                try validateShortsReview(reviewBody, sourceFingerprint: source.fingerprint, saved: finalSaved, duration: sourceDuration(src))
                try commit(applied.project, who: b["who"] as? String ?? "you", lines: ["\(items.count) captions from \(src)"])
            } else {
                _ = try await editOperations(ops: .array([op]), who: b["who"] as? String ?? "you", summary: "\(items.count) captions from \(src)", expectedVersion: expected)
            }
            result["applied"] = true; result["version"] = version
        }
        return JSON(any: result)
    }

    private func readTranscript(_ query: [String: String]) throws -> JSON {
        let saved = try NativeTranscriptStore.read(src: query["src"] ?? "", locale: NativeTranscriptStore.localeID(query["locale"]), folder: folder)
        guard query["offset"] != nil || query["limit"] != nil else { return saved }
        guard let offset = Int(query["offset"] ?? "0"), offset >= 0, let limit = Int(query["limit"] ?? "500"), limit >= 1, limit <= 1000 else { throw APIError("Transcript pages need a nonnegative offset and a limit of 1 to 1000 words.") }
        var fields = try JSON.parse(saved.text) as? [String: Any] ?? [:]
        let words = fields["words"] as? [Any] ?? [], begin = min(words.count,offset), end = min(words.count,begin+limit)
        fields["words"] = Array(words[begin..<end]); fields["totalWords"] = words.count; fields["offset"] = offset
        if end < words.count { fields["nextOffset"] = end }
        return JSON(any: fields)
    }

    private func editTranscript(_ body: [String: Any]) async throws -> JSON {
        guard let snapshot = project else { throw APIError("No project yet.") }
        let expected = body["expectedVersion"] as? Int ?? version
        var result = try JSON.parse(core.transcriptDeleteOps(project: snapshot, body: JSON(any: body).text)) as? [String: Any] ?? [:]
        result["version"] = version
        if body["apply"] as? Bool == true {
            let edit = try await editOperations(ops: JSON(any: result["ops"]), who: body["who"] as? String ?? "you", summary: "Removed selected transcript passages", expectedVersion: expected)
            result["edit"] = try JSON.parse(edit.text); result["applied"] = true; result["version"] = version
        }
        return JSON(any: result)
    }

    private func saveTranscript(_ b: [String: Any]) throws -> JSON {
        let src = b["src"] as? String ?? "", locale = try NativeTranscriptStore.localeID(b["locale"] as? String)
        let duration = try sourceDuration(src)
        if b.keys.contains("expectedSourceFingerprint") {
            var guardBody = b; guardBody["expectedTranscriptRevision"] = b["revision"]
            _ = try validateTranscriptImportIdentity(guardBody, src: src, locale: locale)
        }
        return try NativeTranscriptStore.save(src: src, locale: locale, words: b["words"], expectedRevision: b["revision"] as? Int, duration: duration, metadata: ["provider": "manual"], folder: folder)
    }

    private func validateTranscriptImportIdentity(_ body: [String: Any], src: String, locale: String) throws -> NativeTranscriptStore.SourceIdentity {
        try requireOpen()
        guard let expected = body["expectedVersion"] as? Int, expected == version,
              let fingerprint = body["expectedSourceFingerprint"] as? String,
              let revision = body["expectedTranscriptRevision"] as? Int, revision >= 0 else {
            throw APIError("The project or import identity changed. Recheck the transcript before importing or saving.")
        }
        let source = try NativeTranscriptStore.sourceIdentity(src, folder: folder)
        guard source.fingerprint == fingerprint else { throw APIError("The source changed. Copy or discard the imported draft, then recheck this source.") }
        let saved = try JSON.parse(NativeTranscriptStore.read(src: src, locale: locale, folder: folder).text) as? [String: Any] ?? [:]
        guard saved["status"] as? String != "stale", saved["revision"] as? Int == revision else {
            throw APIError("The saved transcript changed. Copy or discard the imported draft, then recheck it.")
        }
        return source
    }

    private func previewTranscriptImport(_ body: [String: Any]) throws -> JSON {
        let allowed: Set<String> = ["src", "locale", "expectedVersion", "expectedSourceFingerprint", "expectedTranscriptRevision", "words", "text", "format"]
        guard Set(body.keys).isSubset(of: allowed), (body["src"] as? String ?? "").utf8.count <= 4096 else {
            throw APIError("Choose a timed transcript of up to 16 MB using the documented import fields.")
        }
        let src = body["src"] as? String ?? "", locale = try NativeTranscriptStore.localeID(body["locale"] as? String)
        let source = try validateTranscriptImportIdentity(body, src: src, locale: locale)
        let duration = try sourceDuration(src)
        let words: [[String: Any]], warnings: [String]
        if let input = body["words"] as? [[String: Any]], body["text"] == nil, body["format"] == nil {
            guard input.count <= 100_000, JSON(any: input).text.utf8.count <= NativeTimedTranscriptImport.maximumBytes else { throw APIError("The timed word array is larger than 16 MB.") }
            words = try NativeTimedTranscriptImport.validateWords(input, duration: duration); warnings = []
        } else {
            guard body["words"] == nil, let text = body["text"] as? String,
                  let format = body["format"] as? String, ["srt", "vtt"].contains(format),
                  text.utf8.count <= NativeTimedTranscriptImport.maximumBytes else {
                throw APIError("Import a timed JSON word array, SRT or WebVTT file.")
            }
            let cueCount = try NativeTimedTranscriptImport.validateSubtitles(text: text, format: format, duration: duration)
            let parsed = try JSON.parse(core.importInterchange(text: text, format: format, root: folder.root.path)) as? [String: Any] ?? [:]
            let cues = parsed["captions"] as? [[String: Any]] ?? []
            guard !cues.isEmpty, cues.count == cueCount, cues.count <= 100_000 else { throw APIError("The subtitle file has no usable cues, or too many cues.") }
            var estimated: [[String: Any]] = []
            for cue in cues {
                try Task.checkCancellation()
                let from = (cue["t"] as? NSNumber)?.doubleValue ?? .nan, to = (cue["end"] as? NSNumber)?.doubleValue ?? .nan
                let tokens = (cue["text"] as? String ?? "").split(whereSeparator: { $0.isWhitespace }).map(String.init)
                guard from.isFinite, to.isFinite, from >= 0, to > from, to <= duration, !tokens.isEmpty,
                      tokens.count <= 100_000 - estimated.count else { throw APIError("Subtitle cues must stay inside the source and contain at most 100000 words.") }
                let count = Double(tokens.count)
                for (index, token) in tokens.enumerated() {
                    let start = from + (to - from) * (Double(index) / count)
                    let end = index == tokens.count - 1 ? to : from + (to - from) * (Double(index + 1) / count)
                    estimated.append(["t": start, "end": end, "text": token])
                }
            }
            let ordered = estimated.enumerated().sorted {
                let a = ($0.element["t"] as? NSNumber)?.doubleValue ?? 0, b = ($1.element["t"] as? NSNumber)?.doubleValue ?? 0
                return a == b ? $0.offset < $1.offset : a < b
            }.map { $0.element }
            words = try NativeTimedTranscriptImport.validateWords(ordered, duration: duration)
            warnings = ["SRT and WebVTT provide cue timing. Individual word times are estimated evenly within each cue. Formatting and cue settings are omitted. Review the word timings before saving."] + (parsed["warnings"] as? [String] ?? [])
        }
        guard !words.isEmpty else { throw APIError("The imported file has no timed words.") }
        guard source == (try validateTranscriptImportIdentity(body, src: src, locale: locale)) else { throw APIError("The source changed while previewing the import.") }
        return JSON(any: ["src": src, "locale": locale, "version": version, "sourceFingerprint": source.fingerprint,
                          "transcriptRevision": body["expectedTranscriptRevision"]!, "words": words, "warnings": warnings])
    }

    private func sourceDuration(_ src: String) throws -> Double {
        _ = try folder.resolve(src)
        guard let project, let text = try core.asset(project: project, src: src), let fields = try JSON.parse(text) as? [String: Any], let duration = (fields["duration"] as? NSNumber)?.doubleValue, duration.isFinite, duration > 0 else { throw APIError("Import a finite-duration audio or video source first.") }
        return duration
    }

    private func transcribeSource(_ b: [String: Any]) async throws -> JSON {
        let src = b["src"] as? String ?? "", locale = try NativeTranscriptStore.localeID(b["locale"] as? String)
        let duration = try sourceDuration(src), before = try NativeTranscriptStore.sourceIdentity(src, folder: folder)
        let old = try NativeTranscriptStore.read(src: src, locale: locale, folder: folder)
        let fields = try JSON.parse(old.text) as? [String: Any] ?? [:], revision = fields["revision"] as? Int ?? 0
        if revision > 0, ["complete", "partial"].contains(fields["status"] as? String ?? ""), b["force"] as? Bool != true { return old }
        let result = try await recognizeTranscript(before.file, Locale(identifier: locale), b["allowServer"] as? Bool ?? false, folder, b["force"] as? Bool ?? false)
        try requireOpen()
        guard before == (try NativeTranscriptStore.sourceIdentity(src, folder: folder)) else { throw APIError("The source changed while transcription ran.") }
        var recognized = try JSON.parse(result.text) as? [String: Any] ?? [:]
        let words = recognized.removeValue(forKey: "words") ?? []
        try requireWritableProject()
        try validateCurrentProcessing()
        return try NativeTranscriptStore.saveRecognition(src: src, locale: locale, words: words, expectedRevision: revision, duration: duration, metadata: recognized.merging(["provider": "apple-speech"]) { _, new in new }, folder: folder)
    }

    private func validateShortsReview(_ body: [String: Any], sourceFingerprint: String, saved: [String: Any], duration: Double) throws {
        if body.keys.contains("expectedVersion") {
            guard let expected = body["expectedVersion"] as? Int, expected == version else { throw APIError("The project changed. Review the short compositions again.") }
        }
        let currentTranscript = ["complete", "ready", "partial"].contains(saved["status"] as? String ?? "")
        if body.keys.contains("expectedSourceFingerprint") {
            guard let fingerprint = body["expectedSourceFingerprint"] as? String,
                  fingerprint == sourceFingerprint || (currentTranscript && fingerprint == saved["fingerprint"] as? String) else {
                throw APIError("The source changed. Recheck it and review the short compositions again.")
            }
        }
        if body.keys.contains("expectedTranscriptRevision") {
            guard let revision = body["expectedTranscriptRevision"] as? Int, revision > 0,
                  currentTranscript, saved["revision"] as? Int == revision else {
                throw APIError("The transcript changed. Recheck it and review the short compositions again.")
            }
            if body["captions"] as? Bool != false, let words = body["words"] {
                let validated = try NativeTranscriptStore.validate(words, duration: duration)
                let savedWords = try NativeTranscriptStore.validate(saved["words"], duration: duration)
                let reviewedTextAndTiming = validated.map { ["t": $0["t"]!, "end": $0["end"]!, "text": $0["text"]!] }
                let savedTextAndTiming = savedWords.map { ["t": $0["t"]!, "end": $0["end"]!, "text": $0["text"]!] }
                guard JSON(any: reviewedTextAndTiming).text == JSON(any: savedTextAndTiming).text else {
                    throw APIError("The reviewed transcript words changed. Save and review them again.")
                }
            }
        }
    }

    private func proposeShorts(_ b: [String: Any]) throws -> JSON {
        let src = b["src"] as? String ?? "", locale = try NativeTranscriptStore.localeID(b["locale"] as? String)
        let duration = try sourceDuration(src), source = try NativeTranscriptStore.sourceIdentity(src, folder: folder)
        let saved = try JSON.parse(NativeTranscriptStore.read(src: src, locale: locale, folder: folder).text) as? [String: Any] ?? [:]
        try validateShortsReview(b, sourceFingerprint: source.fingerprint, saved: saved, duration: duration)
        let words = try NativeTranscriptStore.validate(b["words"] ?? saved["words"], duration: duration)
        guard !words.isEmpty else { throw APIError("Transcribe this source before proposing clips.") }
        var result = try JSON.parse(core.proposeShorts(words: JSON(any: words).text, body: JSON(any: b).text)) as? [String: Any] ?? [:]
        guard source == (try NativeTranscriptStore.sourceIdentity(src, folder: folder)) else { throw APIError("The source changed while finding excerpts. Recheck it and try again.") }
        result["src"] = src; result["locale"] = locale; result["version"] = version
        result["sourceFingerprint"] = saved["fingerprint"] ?? source.fingerprint; result["transcriptRevision"] = saved["revision"] ?? 0
        return JSON(any: result)
    }

    private func buildShorts(_ b: [String: Any]) async throws -> JSON {
        guard let snapshot = project else { throw APIError("No project yet.") }
        let expected = b["expectedVersion"] as? Int ?? version
        guard expected == version else { throw APIError("The project changed. Review the short compositions again.") }
        let generation = projectGeneration
        let src = b["src"] as? String ?? "", locale = try NativeTranscriptStore.localeID(b["locale"] as? String)
        let source = try NativeTranscriptStore.sourceIdentity(src, folder: folder)
        let saved = try JSON.parse(NativeTranscriptStore.read(src: src, locale: locale, folder: folder).text) as? [String: Any] ?? [:]
        try validateShortsReview(b, sourceFingerprint: source.fingerprint, saved: saved, duration: sourceDuration(src))
        var options = b
        if b["words"] == nil { options["words"] = saved["words"] ?? [] }
        var result = try JSON.parse(core.buildShortsOps(project: snapshot, body: JSON(any: options).text)) as? [String: Any] ?? [:]
        try requireOpen()
        guard generation == projectGeneration, project == snapshot, version == expected,
              source == (try NativeTranscriptStore.sourceIdentity(src, folder: folder)) else {
            throw APIError("The project or source changed during planning. Review the short compositions again.")
        }
        result["version"] = expected; result["sourceFingerprint"] = saved["fingerprint"] ?? source.fingerprint
        result["transcriptRevision"] = saved["revision"] ?? 0
        if b["apply"] as? Bool == true {
            let edit = try core.applyOps(project: snapshot, ops: JSON(any: result["ops"]).text)
            let finalSaved = try JSON.parse(NativeTranscriptStore.read(src: src, locale: locale, folder: folder).text) as? [String: Any] ?? [:]
            try requireOpen()
            guard generation == projectGeneration, project == snapshot, version == expected,
                  source == (try NativeTranscriptStore.sourceIdentity(src, folder: folder)) else {
                throw APIError("The project or source changed before creation. Review the short compositions again.")
            }
            try validateShortsReview(b, sourceFingerprint: source.fingerprint, saved: finalSaved, duration: sourceDuration(src))
            try commit(edit.project, who: b["who"] as? String ?? "you", lines: ["Created short clip compositions"])
            let receipt = JSON.compact([("version", .int(version)), ("log", .raw(edit.log)), ("created", .raw(edit.created)), ("project", .raw(edit.project))])
            result["edit"] = try JSON.parse(receipt.text); result["applied"] = true; result["version"] = version
        }
        return JSON(any: result)
    }

    private static let analysisRoutes: Set<String> = ["/api/audio/measure-mix", "/api/analyze", "/api/captions/from-transcript", "/api/audio/clean", "/api/audio/denoise", "/api/audio/restore", "/api/audio/loudnorm", "/api/multicam/sync", "/api/analysis/track", "/api/tracking/track", "/api/analysis/saliency", "/api/analysis/autoreframe"]

    private func startAnalysisJob(route: String, body: [String: Any]) throws -> JSON {
        try requireOpen()
        let context = try captureProcessingContext(body, allSources: route == "/api/audio/measure-mix")
        var scheduled = false
        defer { if !scheduled { context.lease.finish() } }
        let isMix = route == "/api/audio/measure-mix"
        if isMix { try preflightMixAnalysis(body) }
        let processingRoutes: Set<String> = ["/api/audio/clean", "/api/audio/denoise", "/api/audio/restore", "/api/audio/loudnorm", "/api/analysis/track", "/api/tracking/track", "/api/analysis/saliency", "/api/analysis/autoreframe"]
        let capture: ProcessingCapture?
        if ["/api/audio/clean", "/api/audio/denoise", "/api/audio/restore"].contains(route) {
            capture = try captureAudioCleanup(body, restore: route == "/api/audio/restore")
        } else if processingRoutes.contains(route) {
            let resolved = try processingTarget(body)
            let applying = route.hasPrefix("/api/audio/") ? body["apply"] as? Bool != false : route != "/api/analysis/saliency" && body["apply"] as? Bool == true
            let src = body["src"] as? String ?? resolved?.clip["src"] as? String ?? ""
            capture = try captureProcessing(body, target: applying ? resolved : nil, src: src)
        } else { capture = nil }
        let id = UUID().uuidString
        let temp = !isMix ? try folder.output(".reel/cache/job-\(id).part") : folder.cacheDir.appendingPathComponent("unwritten-mix-job-\(id)")
        let job = Job(id: id, kind: body["kind"] as? String ?? String(route.split(separator: "/").last ?? "analysis"), spec: body.sorted { $0.key < $1.key }.map { ($0.key, JSON(any: $0.value)) }, out: temp, partFile: temp, assistantLocalOnly: isMix)
        job.processingCapture = capture
        job.admission = context.lease; job.admissionContext = context
        job.readOnlyAnalysis = isMix
        jobs.append(job); broadcast("job", job.json)
        var options = body; options["wait"] = true
        if (route == "/api/captions/from-transcript" || options["apply"] as? Bool == true), options["expectedVersion"] == nil { options["expectedVersion"] = version }
        nativeTasks[id] = Task { [weak self] in
            guard let self else { context.lease.finish(); return }
            do {
                try await context.lease.wait()
                try await self.activateProcessingJob(id, context: context)
                try await ProcessingScope.$context.withValue(context) {
                    let mixCapture = isMix ? try await self.prepareMixAnalysisJob(id, body: body) : nil
                    let result = try await self.runAnalysisRoute(route, body: options, capture: capture, mixCapture: mixCapture, jobID: id)
                    if mixCapture != nil { try await self.mixTestStage("publishing") }
                    try await self.validateProcessingContext(context)
                    try await self.completeAnalysisJob(id, result: result)
                }
            } catch { await self.failAnalysisJob(id, error: error) }
            await self.processingWorkerExited(id)
            context.lease.finish()
        }
        scheduled = true
        return job.json
    }

    private func prepareMixAnalysisJob(_ id: String, body: [String: Any]) throws -> NativeAudioMixCapture {
        try validateCurrentProcessing()
        guard let job = jobs.first(where: { $0.id == id }), job.state == "running" else { throw CancellationError() }
        let capture = try captureMixAnalysis(body, jobID: id)
        job.mixCapture = capture
        mixAnalysisReservations[id] = capture.reservedMemoryBytes
        mixAnalysisDiskReservations[id] = capture.reservedDiskBytes
        return capture
    }

    private func runAnalysisRoute(_ route: String, body: [String: Any], capture: ProcessingCapture?, mixCapture: NativeAudioMixCapture? = nil, jobID: String? = nil) async throws -> JSON {
        switch route {
        case "/api/audio/measure-mix":
            guard let mixCapture, let jobID else { throw APIError("Mix measurement needs its reserved capture and job.") }
            return try await measureMix(mixCapture, jobID: jobID)
        case "/api/analyze": try await processingTestStage(); return try await analyze(body)
        case "/api/captions/from-transcript": return try await transcriptCaptions(JSON(any: body).text, body)
        case "/api/audio/clean", "/api/audio/denoise": return try await cleanAudio(body, capture: capture)
        case "/api/audio/restore": return try await restoreAudio(body, capture: capture)
        case "/api/audio/loudnorm": return try await normalizeAudio(body, capture: capture)
        case "/api/multicam/sync": return try await syncAudio(body)
        default: return try await visionAnalysis(body, kind: String(route.split(separator: "/").last ?? ""), capture: capture)
        }
    }

    private func completeAnalysisJob(_ id: String, result: JSON) throws {
        try requireOpen()
        guard let job = jobs.first(where: { $0.id == id }), job.state == "running" else { throw CancellationError() }
        if let capture = job.mixCapture { try validateMixAnalysis(capture) }
        job.result = result; job.progress = 1; job.state = "done"; job.finished = Date()
        let fields = try JSON.parse(result.text) as? [String: Any] ?? [:]
        job.output = fields["path"] as? String; job.applied = fields["applied"] as? Bool
        job.applyError = fields["applyError"] as? String
        job.assetRegistered = fields["assetRegistered"] as? Bool
        broadcast("job", job.json)
        if job.assistantLocalOnly { pruneCompletedJobs(assistantLocalOnly: true) }
    }

    private func failAnalysisJob(_ id: String, error: Error) {
        if let job = jobs.first(where: { $0.id == id }), job.state == "running" || job.state == "queued" { fail(job, error is CancellationError ? "cancelled" : error.localizedDescription) }
        if jobs.first(where: { $0.id == id })?.assistantLocalOnly == true { pruneCompletedJobs(assistantLocalOnly: true) }
    }

    // MARK: captured Float32 mix analysis

    #if DEBUG
    private var audioMixPlanningAdmissions = 0
    func audioMixPlanningAdmissionsForTesting() -> Int { audioMixPlanningAdmissions }
    func audioMixPrivateStorageRootForTesting() -> URL? { mixAnalysisStorage?.root }
    private var audioMixTestBarrier: (@Sendable (String) async throws -> Void)?
    func setAudioMixTestBarrier(_ barrier: (@Sendable (String) async throws -> Void)?) { audioMixTestBarrier = barrier }
    func audioMixActiveWorkersForTesting() -> Int { Set(nativeTasks.keys).union(mixAnalysisReservations.keys).count }
    func audioMixReservedDiskBytesForTesting() -> UInt64 { mixAnalysisDiskReservations.values.reduce(0, +) }
    func setAudioMixDiskLimitForTesting(_ limit: UInt64?) { mixAnalysisDiskLimit = limit }
    func audioMixReservedBytesForTesting() -> UInt64 { mixAnalysisReservations.values.reduce(0, +) }
    func setAudioMixMemoryLimitForTesting(_ limit: UInt64) { mixAnalysisMemoryLimit = min(limit, NativeAudioMixer.memoryLimitBytes) }
    private func mixTestStage(_ stage: String) async throws { try await audioMixTestBarrier?(stage) }
    #else
    private func mixTestStage(_ stage: String) async throws { }
    #endif

    private func filterMixPlan(_ text: String, output: NativeAudioMixCapture.Output) throws -> String {
        guard case .track(let id) = output else { return text }
        var graph = try JSON.parse(text) as? [String: Any] ?? [:]
        graph["buses"] = (graph["buses"] as? [[String: Any]] ?? []).filter { $0["id"] as? String == id }
        graph["master"] = ["chain": [], "gain": 1]
        return JSON(any: graph).text
    }
    private func validateMixPlanningMemory(_ scope: [String: Any], seconds: Double, budget: UInt64 = NativeAudioMixer.memoryLimitBytes / 4) throws {
        var clips = 0, curves = 0
        let comps = scope["comps"] as? [String: [String: Any]] ?? [:]
        func walk(_ tracks: [[String: Any]], depth: Int) throws {
            guard depth <= 16 else { throw APIError("The audio graph exceeds the supported composition depth.") }
            for track in tracks { for clip in track["clips"] as? [[String: Any]] ?? [] {
                clips += 1
                guard clips <= 4096 else { throw APIError("Choose a mix with fewer composition instances or clips.") }
                curves += (clip["anim"] as? [String: Any] ?? [:]).count + (clip["expr"] as? [String: Any] ?? [:]).count
                if ((clip["fadeIn"] as? NSNumber)?.doubleValue ?? 0) != 0 || ((clip["fadeOut"] as? NSNumber)?.doubleValue ?? 0) != 0 { curves += 1 }
                if clip["kind"] as? String == "comp", let id = clip["comp"] as? String, let nested = comps[id] {
                    try walk(nested["tracks"] as? [[String: Any]] ?? [], depth: depth + 1)
                }
            } }
        }
        try walk(scope["tracks"] as? [[String: Any]] ?? [], depth: 0)
        let estimate = seconds * 50 * Double(curves) * 48 + Double(clips) * 2048
        guard estimate.isFinite, estimate * 4 <= Double(budget) else {
            throw APIError("The expanded automation graph exceeds the planning memory budget. Choose a shorter range or fewer animated layers.")
        }
    }
    private func privateMixStorage() throws -> NativeAudioMixStorage {
        if let storage = mixAnalysisStorage { try storage.validate(); return storage }
        let storage = try NativeAudioMixStorage(project: folder)
        mixAnalysisStorage = storage
        return storage
    }

    /// Validate the request without expanding an audio graph or copying source bytes.
    private func preflightMixAnalysis(_ body: [String: Any], jobID: String? = nil) throws {
        try requireOpen()
        guard Set(body.keys).isSubset(of: ["comp", "expectedVersion", "from", "to", "output", "semantics", "uiAudioRequestID", "wait", "apply"]) else { throw APIError("Unsupported mix measurement settings. Choose only the documented range, output and render semantics.") }
        let expected = try NativeAudioMixCapture.strictVersion(body["expectedVersion"])
        _ = try NativeAudioMixCapture.boolean(body["wait"], "wait")
        guard try NativeAudioMixCapture.boolean(body["apply"], "apply") != true,
              expected == version, let project, project.utf8.count <= 32 * 1024 * 1024, JSON(any: body).text.utf8.count <= 65_536 else { throw APIError("Refresh the project and choose a read-only mix measurement.") }
        let comp = try NativeAudioMixCapture.composition(body)
        let scope = try JSON.parse(projectView(comp: comp)) as? [String: Any] ?? [:]
        let from = try NativeAudioMixCapture.finite(body["from"], "range start", range: 0...3600)
        let to = try NativeAudioMixCapture.finite(body["to"], "range end", range: 0...3600)
        guard to > from, NativeAudioMixCapture.Semantics(rawValue: body["semantics"] as? String ?? "") != nil,
              let requestID = body["uiAudioRequestID"] as? String, UUID(uuidString: requestID) != nil,
              let selected = body["output"] as? [String: Any] else { throw APIError("Choose a non-empty range, playback or export semantics, output and owned request UUID.") }
        let requestIdentity = JSON.string(requestID).text
        guard !jobs.contains(where: { $0.id != jobID && $0.spec.first(where: { $0.0 == "uiAudioRequestID" })?.1.text == requestIdentity }) else { throw APIError("Choose a new request UUID for each mix measurement.") }
        let isMaster = selected["kind"] as? String == "master" && Set(selected.keys) == Set(["kind"])
        let trackID = selected["id"] as? String
        let isTrack = selected["kind"] as? String == "track" && Set(selected.keys) == Set(["kind", "id"]) && trackID != nil && (scope["tracks"] as? [[String: Any]] ?? []).filter({ $0["id"] as? String == trackID }).count == 1
        guard isMaster || isTrack else { throw APIError("Choose master output or one unique displayed track. Track subsets are unsupported.") }
        try preflightMixPlanningBytes(project: project, body: body)
        let storage = try privateMixStorage(), diskLimit = min(try storage.diskBudget(), mixAnalysisDiskLimit ?? UInt64.max)
        guard mixAnalysisDiskReservations.values.reduce(0, +) < diskLimit else { throw APIError("The shared mix copy disk budget is occupied. Wait for an active measurement to stop.") }
    }
    private func preflightMixPlanningBytes(project: String, body: [String: Any]) throws {
        let reserved = mixAnalysisReservations.values.reduce(0, +)
        let planningBytes = UInt64(project.utf8.count) * 24 + UInt64(lastText.utf8.count + JSON(any: body).text.utf8.count) * 2 + NativeAudioMixer.memoryLimitBytes / 4 + 2_097_152
        guard reserved <= mixAnalysisMemoryLimit, planningBytes <= mixAnalysisMemoryLimit - reserved else { throw APIError("The remaining mix memory cannot admit plan expansion. Wait for active measurements to stop.") }
    }
    private func preflightDuckPlanning(_ body: [String: Any]) throws {
        guard let project else { throw APIError("No project yet.") }
        try preflightMixPlanningBytes(project: project, body: body)
    }

    private func captureMixAnalysis(_ body: [String: Any], jobID: String? = nil) throws -> NativeAudioMixCapture {
        try preflightMixAnalysis(body, jobID: jobID)
        try requireOpen()
        let reserved = mixAnalysisReservations.values.reduce(0, +)
        guard reserved < mixAnalysisMemoryLimit else { throw APIError("The shared mix analysis memory budget is occupied. Wait for an active measurement to stop.") }
        guard Set(body.keys).isSubset(of: ["comp", "expectedVersion", "from", "to", "output", "semantics", "uiAudioRequestID", "wait", "apply"]) else { throw APIError("Unsupported mix measurement settings. Choose only the documented range, output and render semantics.") }
        let expected = try NativeAudioMixCapture.strictVersion(body["expectedVersion"])
        _ = try NativeAudioMixCapture.boolean(body["wait"], "wait")
        guard try NativeAudioMixCapture.boolean(body["apply"], "apply") != true else { throw APIError("Mix measurement cannot apply an edit.") }
        guard expected == version, let fullProject = project else { throw APIError("The project changed. Refresh it before measuring the mix.") }
        guard fullProject.utf8.count <= 32 * 1024 * 1024, JSON(any: body).text.utf8.count <= 65_536,
              body["apply"] == nil || body["apply"] as? Bool == false else { throw APIError("Mix measurement is read-only and its capture must fit the supported limits.") }
        let comp = try NativeAudioMixCapture.composition(body)
        let planningGraphBytes = NativeAudioMixer.memoryLimitBytes / 4
        let planningBytes = UInt64(fullProject.utf8.count) * 24 + UInt64(lastText.utf8.count + JSON(any: body).text.utf8.count) * 2 + planningGraphBytes + 2_097_152
        guard planningBytes <= mixAnalysisMemoryLimit - reserved else { throw APIError("The remaining mix memory cannot admit plan expansion. Wait for active measurements to stop.") }
        let planningID = "planning-\(UUID().uuidString)"
        mixAnalysisReservations[planningID] = planningBytes
        defer { mixAnalysisReservations[planningID] = nil }
        #if DEBUG
        audioMixPlanningAdmissions += 1
        #endif
        guard try NativeAudioMixCapture.projectFileMatches(folder.resolve(folder.projectFile.path), expected: lastText) else { throw APIError("The project file changed. Refresh it before measuring the mix.") }
        let snapshot = try projectView(comp: comp), scope = try JSON.parse(snapshot) as? [String: Any] ?? [:]
        let from = try NativeAudioMixCapture.finite(body["from"], "range start", range: 0...3600)
        let to = try NativeAudioMixCapture.finite(body["to"], "range end", range: 0...3600)
        guard to > from, let semantics = NativeAudioMixCapture.Semantics(rawValue: body["semantics"] as? String ?? ""),
              let requestID = body["uiAudioRequestID"] as? String, UUID(uuidString: requestID) != nil,
              let selected = body["output"] as? [String: Any] else { throw APIError("Choose a non-empty range, playback or export semantics, output and owned request UUID.") }
        let requestIdentity = JSON.string(requestID).text
        guard !jobs.contains(where: { $0.id != jobID && $0.spec.first(where: { $0.0 == "uiAudioRequestID" })?.1.text == requestIdentity }) else { throw APIError("Choose a new request UUID for each mix measurement.") }
        let output: NativeAudioMixCapture.Output
        if selected["kind"] as? String == "master", Set(selected.keys) == Set(["kind"]) { output = .master }
        else if selected["kind"] as? String == "track", Set(selected.keys) == Set(["kind", "id"]), let id = selected["id"] as? String,
                (scope["tracks"] as? [[String: Any]] ?? []).filter({ $0["id"] as? String == id }).count == 1 { output = .track(id) }
        else { throw APIError("Choose master output or one unique displayed track. Track subsets are unsupported.") }
        let prepared = try prepareAudioRange(project: snapshot, from: from, to: to, output: output,
                                             rounding: semantics == .playback ? .playback : .delivery,
                                             planningBudget: planningGraphBytes)
        let plan = prepared.plan, start = prepared.window.cropStart, count = prepared.window.cropCount
        let requestText = JSON(any: body).text
        let captureBytes = NativeAudioMixCapture.captureStringBytes(project: fullProject, projectFile: lastText, request: requestText)
        let renderBytes = try NativeAudioMixCapture.reservationBytes(plan: plan, croppedFrames: count, folder: folder)
        let combined = renderBytes.addingReportingOverflow(captureBytes)
        guard !combined.overflow else { throw APIError("The mix capture exceeds its memory budget.") }
        let reservation = combined.partialValue
        guard reservation <= mixAnalysisMemoryLimit - reserved else { throw APIError("This mix cannot fit beside the active measurements. Wait for them to stop or choose a shorter range.") }
        let storage = try privateMixStorage()
        let diskLimit = min(try storage.diskBudget(), mixAnalysisDiskLimit ?? UInt64.max)
        let diskReserved = mixAnalysisDiskReservations.values.reduce(0, +)
        guard diskReserved <= diskLimit else { throw APIError("The shared mix copy disk budget is occupied. Wait for an active measurement to stop.") }
        let sources = try NativeAudioMixCapture.sources(plan: plan, folder: folder, diskLimit: diskLimit - diskReserved)
        return .init(projectText: fullProject, projectFileText: lastText, version: expected, root: folder.root.path, storage: storage, composition: comp, output: output, semantics: semantics,
                     requestID: requestID, from: from, to: to, planText: plan, cropStart: start, cropCount: count,
                     sampleStart: start, sources: sources, maximumDiskBytes: diskLimit, requestText: requestText, reservedMemoryBytes: reservation)
    }
    private func validateMixAnalysis(_ capture: NativeAudioMixCapture) throws {
        try requireOpen(); try Task.checkCancellation()
        // Check external edits without loading them or changing history inside this read-only operation.
        let projectFile = try folder.resolve(folder.projectFile.path)
        guard try NativeAudioMixCapture.projectFileMatches(projectFile, expected: capture.projectFileText) else { throw APIError("The project file changed after the mix was captured.") }
        guard project == capture.projectText, version == capture.version, folder.root.path == capture.root else {
            throw APIError("The project changed during mix measurement. The captured result was discarded.")
        }
        try capture.validatePaths(folder: folder)
    }
    private func measureMix(_ capture: NativeAudioMixCapture, jobID: String) async throws -> JSON {
        try await mixTestStage("reserved")
        try validateMixAnalysis(capture)
        let folder = self.folder
        let directory = try capture.prepareSnapshotDirectory(folder: folder, id: jobID)
        defer { directory.cleanup() }
        let snapshot = try await NativeAudioProcessing.cancellableTask { try capture.makeSnapshot(folder: folder, directory: directory) }
        try await mixTestStage("snapshot")
        try validateMixAnalysis(capture)
        try await NativeAudioProcessing.cancellableTask { try capture.verify(snapshot, folder: folder) }
        try validateMixAnalysis(capture)
        let actualReservation = try NativeAudioMixCapture.reservationBytes(plan: snapshot.planText, croppedFrames: capture.cropCount, folder: folder)
        let captureBytes = NativeAudioMixCapture.captureStringBytes(project: capture.projectText, projectFile: capture.projectFileText, request: capture.requestText)
        let actualCombined = actualReservation.addingReportingOverflow(captureBytes)
        guard !actualCombined.overflow, actualCombined.partialValue <= capture.reservedMemoryBytes else { throw APIError("The private capture exceeds its reserved analysis memory. Choose a shorter mix.") }
        let rendered = try await NativeAudioMixer.render(plan: .raw(snapshot.planText), folder: snapshot.folder, preview: capture.semantics == .playback)
        try await mixTestStage("rendered")
        try validateMixAnalysis(capture)
        guard capture.cropStart >= 0, capture.cropStart + capture.cropCount <= rendered.count else { throw APIError("The captured render returned an invalid sample range.") }
        let range = capture.cropStart..<capture.cropStart + capture.cropCount
        let pcm = try await NativeAudioProcessing.cancellableTask { try NativeAudioRenderRange.trim(rendered, samples: range) }
        let measurement = try await NativeAudioProcessing.cancellableTask { try NativeAudioProcessing.measure(pcm) }
        try await mixTestStage("measured")
        try validateMixAnalysis(capture)
        try await NativeAudioProcessing.cancellableTask { try capture.verify(snapshot, folder: folder) }
        try validateMixAnalysis(capture)
        let fields = try JSON.parse(capture.planText) as? [String: Any] ?? [:]
        let renderedFrom = (fields["from"] as? NSNumber)?.doubleValue ?? 0
        let actualFrom = renderedFrom + Double(capture.cropStart) / Double(pcm.rate)
        let stage: String
        switch capture.output {
        case .master: stage = "Float32 post master effects, fader and limiter, before encoding"
        case .track: stage = "Float32 post track effects, fader and pan, before master and encoding"
        }
        return .object([
            ("expectedVersion", .int(capture.version)), ("comp", capture.composition.map(JSON.string) ?? .null),
            ("uiAudioRequestID", .string(capture.requestID)), ("semantics", .string(capture.semantics.rawValue)), ("signalStage", .string(stage)),
            ("rate", .int(pcm.rate)), ("sampleStart", .int(range.lowerBound)), ("sampleEnd", .int(range.upperBound)), ("sampleCount", .int(pcm.count)),
            ("sampleFrom", .number(actualFrom)), ("sampleTo", .number(actualFrom + pcm.duration)), ("requestedFrom", .number(capture.from)), ("requestedTo", .number(capture.to)),
            ("lufs", measurement.integrated.isFinite ? .number(measurement.integrated) : .null),
            ("truePeak", measurement.peak.isFinite ? .number(measurement.peak) : .null),
            ("lra", measurement.rangeAvailable && measurement.integrated.isFinite ? .number(measurement.range) : .null),
            ("lraStatus", .string(!measurement.integrated.isFinite ? "silent" : measurement.rangeAvailable ? "valid" : "insufficient duration")),
            ("silence", .bool(!measurement.peak.isFinite)), ("sourceCapture", .string("private copies with SHA256 established during asynchronous copy")),
            ("sources", .array(snapshot.files.map { .object([("alias", .string($0.original.alias)), ("resolvedPath", .string($0.original.path)), ("sha256", .string($0.sha256)), ("bytes", .number(Double($0.original.stamp.bytes)))]) }))
        ])
    }
    private func planDucking(_ body: [String: Any]) throws -> JSON {
        try requireOpen()
        guard Set(body.keys).isSubset(of: ["comp", "expectedVersion", "from", "to", "dialogueTrackIDs", "musicClipIDs", "settings", "manualPolicy"]),
              let options = body["settings"] as? [String: Any], Set(options.keys) == Set(["amount", "attack", "hold", "mergeGap", "release"]) else { throw APIError("Unsupported ducking settings.") }
        let expected = try NativeAudioMixCapture.strictVersion(body["expectedVersion"])
        guard expected == version, let project, project.utf8.count <= 32 * 1024 * 1024, JSON(any: body).text.utf8.count <= 65_536 else { throw APIError("Refresh the project before planning ducking.") }
        let comp = try NativeAudioMixCapture.composition(body)
        let reserved = mixAnalysisReservations.values.reduce(0, +)
        let planningGraphBytes = NativeAudioMixer.memoryLimitBytes / 4
        let planningBytes = UInt64(project.utf8.count) * 24 + UInt64(lastText.utf8.count + JSON(any: body).text.utf8.count) * 2 + planningGraphBytes + 2_097_152
        guard reserved <= mixAnalysisMemoryLimit, planningBytes <= mixAnalysisMemoryLimit - reserved else { throw APIError("The remaining mix memory cannot admit duck plan expansion. Wait for active measurements to stop.") }
        let planningID = "duck-planning-\(UUID().uuidString)"
        mixAnalysisReservations[planningID] = planningBytes
        defer { mixAnalysisReservations[planningID] = nil }
        #if DEBUG
        audioMixPlanningAdmissions += 1
        #endif
        guard try NativeAudioMixCapture.projectFileMatches(folder.resolve(folder.projectFile.path), expected: lastText) else { throw APIError("The project file changed. Refresh it before planning ducking.") }
        let snapshot = try projectView(comp: comp), scope = try JSON.parse(snapshot) as? [String: Any] ?? [:]
        let from = try NativeAudioMixCapture.finite(body["from"], "range start", range: 0...3600)
        let to = try NativeAudioMixCapture.finite(body["to"], "range end", range: 0...3600)
        guard to > from, let music = body["musicClipIDs"] as? [String], !music.isEmpty, music.count <= 256,
              let settings = body["settings"] as? [String: Any] else { throw APIError("Choose music clips, a non-empty range and ducking settings.") }
        let hold = try NativeAudioMixCapture.finite(settings["hold"], "hold time", range: 0...10)
        let release = try NativeAudioMixCapture.finite(settings["release"], "release time", range: 0.0011...10)
        let targets = (scope["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }.filter { music.contains($0["id"] as? String ?? "") }
        let last = try targets.reduce(to) { end, clip in
            let start = try NativeAudioMixCapture.finite(clip["start"], "music clip start", range: 0...3600)
            let duration = try NativeAudioMixCapture.finite(clip["dur"], "music clip duration", range: 0.0001...3600)
            guard start + duration <= 3600 else { throw APIError("Music clips must fit within one hour.") }
            return max(end, start + duration)
        }
        let end = last + hold + release
        try validateMixPlanningMemory(scope, seconds: end, budget: planningGraphBytes)
        let plan = try JSON.parse(core.audioPlan(project: snapshot, from: 0, to: end)) as? [String: Any] ?? [:]
        return JSON(any: try NativeAudioDucking.plan(scopedProject: scope, expandedPlan: plan, request: body))
    }

    // MARK: resources for the URL scheme

    /// GET resources the page loads by URL: /media?path=, /cache/..., /api/audio?src=&in=&dur=.
    public func resource(path: String, query: [String: String]) async throws -> Resource? {
        try requireOpen()
        if path == "/media" {
            let url = try folder.resolve(query["path"] ?? "")
            return .file(url, type: MIME.type(for: url))
        }
        if path.hasPrefix("/cache/") {
            let base = try folder.resolve(".reel/cache")
            let url = base.appendingPathComponent(String(path.dropFirst("/cache/".count))).standardizedFileURL.resolvingSymlinksInPath()
            guard url.path.hasPrefix(base.path + "/") else { return nil }
            return FileManager.default.fileExists(atPath: url.path) ? .file(url, type: MIME.type(for: url)) : nil
        }
        if path == "/api/audio" {
            if ProcessingScope.context == nil, let id = query["processingJob"] {
                guard let job = jobs.first(where: { $0.id == id }), job.externalWorker, job.kind == "export", job.state == "running",
                      let context = job.admissionContext, context.sources.contains(where: { $0.0 == query["src"] }) else { throw APIError("Audio derivatives require their owning active export job.") }
                try validateProcessingContext(context)
                return try await context.lease.withChildWork {
                    try await ProcessingScope.$context.withValue(context) {
                        try await self.validateProcessingContext(context)
                        let result = try await self.resource(path: path, query: query)
                        try await self.validateProcessingContext(context)
                        return result
                    }
                }
            }
            if ProcessingScope.context == nil {
                return try await withProcessingAdmission(["src": query["src"] ?? ""]) { try await self.resource(path: path, query: query) }
            }
            try await processingTestStage()
            let from = Double(query["in"] ?? "") ?? 0, duration = Double(query["dur"] ?? "") ?? 10
            guard from.isFinite, duration.isFinite, from >= 0, duration > 0, duration <= 3600,
                  duration * 192_000 * 3 <= Double(processingAdmission.workerByteLimit) else { throw APIError("Choose an audio range that fits the shared memory reservation.") }
            let file = try folder.resolve(query["src"] ?? "")
            let exportRevision: String?
            if let id = query["processingJob"] {
                guard let job = jobs.first(where: { $0.id == id }), job.state == "running", job.externalWorker,
                      let sources = job.exportSources, let cohort = job.sourceCohortID,
                      sources.files.contains(where: { $0.alias == query["src"] }) else { throw APIError("Export audio requires its accepted source cohort.") }
                try sources.validate(folder: folder)
                exportRevision = cohort + "." + id
            } else { exportRevision = nil }
            let wav = try await MediaDerivatives.audioRange(file: file, from: from, dur: duration, cacheDir: folder.cacheDir, projectFolder: folder, cacheRevision: exportRevision)
            return .file(wav, type: "audio/wav")
        }
        return nil
    }

    // MARK: uploads and saved files

    /// Bytes from the page (`upload` message): a whole file, or chunks sharing an `id`.
    /// The file lands in media/ under a free name; answers `{ path }` when done.
    public func upload(name: String, data: Data, id: String?, done: Bool) throws -> JSON {
        try requireOpen()
        try requireWritableProject()
        let url: URL
        if let id, let existing = uploads[id] {
            url = try folder.output(existing.path)
            let handle = try FileHandle(forWritingTo: url)
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
            try handle.close()
        } else {
            let media = try folder.output(folder.mediaDir.path)
            try FileManager.default.createDirectory(at: media, withIntermediateDirectories: true)
            url = try folder.output(ProjectFolder.freeName(in: media, for: ProjectFolder.cleanFileName(name)).path)
            try data.write(to: url)
            if let id, !done { uploads[id] = url }
        }
        if done, let id { uploads[id] = nil }
        return done ? .object([("path", .string(folder.relative(url)))]) : .object([("ok", true)])
    }

    /// Bytes for an export job's file at `position` (`saveExport` message with a job), or a
    /// whole file under renders/ or .reel/frames/ (`saveExport` with a name).
    public func saveExport(job id: String?, name: String?, position: UInt64, data: Data, done: Bool = false, expectedProject: String? = nil) throws -> JSON {
        try requireOpen()
        if let id {
            guard let job = jobs.first(where: { $0.id == id }) else { throw APIError("no job \(id)") }
            guard job.state == "running" else { return .object([("ok", false), ("cancelled", true), ("state", .string(job.state))]) }
            if let context = job.admissionContext { try validateProcessingContext(context) }
            try job.exportSources?.validate(folder: folder)
            try job.exportOutput?.validateDirectories()
            let handle = try job.openHandle(folder: folder)
            try handle.seek(toOffset: position)
            try handle.write(contentsOf: data)
            return .object([("ok", true)])
        }
        try requireWritableProject()
        if let expectedProject {
            guard let project, let current = try JSON.parse(project) as? NSDictionary, let supplied = try JSON.parse(expectedProject) as? NSDictionary, current == supplied else { throw APIError("The page project changed before direct saving.") }
        }
        guard let name, !name.isEmpty else { throw APIError("saveExport needs a job or a name") }
        let lexical = name.hasPrefix("/") ? URL(fileURLWithPath: name) : folder.root.appendingPathComponent(name)
        let url = try Self.exportFile(lexical, folder: folder)
        let allowed = [folder.rendersDir, folder.dotDir.appendingPathComponent("frames")].map { $0.standardizedFileURL.path + "/" }
        guard allowed.contains(where: { url.path.hasPrefix($0) }) else { throw APIError("files from the editor are saved only under renders/ or .reel/frames/") }
        try rejectReferencedMediaOverwrite(url)
        let expected = directExportWrites[url.path]
        if position != 0 {
            guard let expected, expected.generation == projectGeneration, expected.version == version,
                  expected.nextPosition == position, expected.parentStamp == (try Self.directExportParentStamp(url)) else { throw APIError("The direct output changed or has no matching initial save. Save to a new name.") }
        }
        let sources: NativeExportSources
        if let expected, position != 0 { sources = expected.sources; try sources.validate(folder: folder) }
        else { sources = try NativeExportSources.capture(project: project ?? "{}", folder: folder) }
        let next = position.addingReportingOverflow(UInt64(data.count))
        guard !next.overflow else { throw APIError("The direct output position is too large.") }
        let descriptor = try Self.openDirectExport(url, folder: folder, creating: position == 0)
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        let before = try Self.directExportStamp(descriptor)
        if position != 0 {
            guard expected?.stamp == before else { throw APIError("The direct output changed outside Arya. Save to a new name.") }
        }
        try handle.seek(toOffset: position)
        try handle.write(contentsOf: data)
        _ = try Self.exportFile(url, folder: folder)
        var published = Darwin.stat(), owned = Darwin.stat()
        guard url.path.withCString({ Darwin.lstat($0, &published) }) == 0, Darwin.fstat(descriptor, &owned) == 0,
              published.st_dev == owned.st_dev, published.st_ino == owned.st_ino else { throw APIError("The direct output moved outside Arya during saving. Check the existing file before retrying.") }
        let parentStamp = try Self.directExportParentStamp(url)
        guard position == 0 || expected?.parentStamp == parentStamp else { throw APIError("The direct output directory changed during saving. The existing files were preserved.") }
        directExportWrites[url.path] = DirectExportWrite(generation: projectGeneration, version: version,
                                                        nextPosition: next.partialValue, stamp: try Self.directExportStamp(descriptor), sources: sources, parentStamp: parentStamp)
        try sources.validate(folder: folder)
        if done { try handle.synchronize(); directExportWrites[url.path] = nil }
        return .object([("path", .string(folder.relative(url))), ("state", .string(done ? "done" : "partial")), ("complete", .bool(done))])
    }

    private nonisolated static func directExportParentStamp(_ url: URL) throws -> String {
        var info = Darwin.stat()
        guard url.deletingLastPathComponent().path.withCString({ Darwin.lstat($0, &info) }) == 0,
              info.st_mode & S_IFMT == S_IFDIR else { throw APIError("The direct output directory is unavailable.") }
        return "\(info.st_dev)|\(info.st_ino)"
    }

    /// Pin each directory while creating a direct output; a late symlink cannot redirect it.
    private nonisolated static func openDirectExport(_ url: URL, folder: ProjectFolder, creating: Bool) throws -> Int32 {
        let components = folder.relative(url).split(separator: "/").map(String.init)
        guard let name = components.last else { throw APIError("Choose a direct output file.") }
        var directory = folder.root.path.withCString { Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
        guard directory >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { Darwin.close(directory) }
        for component in components.dropLast() {
            var child = component.withCString { Darwin.openat(directory, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
            if child < 0, errno == ENOENT, creating {
                guard component.withCString({ Darwin.mkdirat(directory, $0, 0o700) }) == 0 || errno == EEXIST else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
                child = component.withCString { Darwin.openat(directory, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
            }
            guard child >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            Darwin.close(directory); directory = child
        }
        let descriptor = name.withCString { Darwin.openat(directory, $0, O_WRONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (creating ? O_CREAT | O_EXCL : 0), 0o600) }
        guard descriptor >= 0 else {
            if errno == EEXIST { throw APIError("The direct output already exists. Save to a new name.") }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        return descriptor
    }

    /// Direct-save chunks may append only to the same regular, unlinked file Arya created.
    private nonisolated static func directExportStamp(_ descriptor: Int32) throws -> String {
        var info = Darwin.stat()
        guard Darwin.fstat(descriptor, &info) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 else { throw APIError("The direct output must remain an owned regular file without hard links.") }
        return "\(info.st_dev)|\(info.st_ino)|\(info.st_size)|\(info.st_mtimespec.tv_sec)|\(info.st_mtimespec.tv_nsec)|\(info.st_ctimespec.tv_sec)|\(info.st_ctimespec.tv_nsec)"
    }

    // MARK: export jobs (rendered and encoded in the page, written here)

    private final class Job {
        let id: String
        let kind: String
        let assistantLocalOnly: Bool
        let sourceVideoProcessing: Bool
        var spec: [(String, JSON)]
        var state = "queued"
        var admission: NativeProcessingAdmission.Lease?
        var admissionContext: ProcessingContext?
        var draining = false
        var externalWorker = false
        var exportSources: NativeExportSources?
        var exportOutput: NativeExportOutput?
        var acceptedProject: String?
        var acceptedVersion: Int?
        var acceptedGeneration: String?
        var sourceCohortID: String?
        var acceptedProjectSHA256: String?
        var exportCohortReceipt: NativeDeliveryHistory.SourceCohort?

        func bindExport(project: String, context: ProcessingContext, sources: NativeExportSources, output: NativeExportOutput) {
            acceptedProject = project; acceptedVersion = context.version; acceptedGeneration = context.generation.uuidString.lowercased()
            exportSources = sources; exportOutput = output
            acceptedProjectSHA256 = SHA256.hash(data: Data(project.utf8)).map { String(format: "%02x", $0) }.joined()
            sourceCohortID = SHA256.hash(data: Data(sources.json.text.utf8)).map { String(format: "%02x", $0) }.joined()
            exportCohortReceipt = .init(id: UUID().uuidString.lowercased(), projectSHA256: acceptedProjectSHA256!, sourcesSHA256: sourceCohortID!, count: sources.files.count)
        }
        var acceptedJSON: JSON {
            let fields = (try? JSON.parse(json.text) as? [String: Any]) ?? [:]
            return JSON(any: fields.merging(["acceptedProject": (try? acceptedProject.flatMap { try JSON.parse($0) }) ?? NSNull(), "sourceCohort": (try? exportSources.map { try JSON.parse($0.json.text) }) ?? []]) { _, new in new })
        }
        var progress = 0.0
        let created = Date()
        var finished: Date?
        var output: String?
        var deliveryWarning: String?
        var error: String?
        var applied: Bool?
        var assetRegistered: Bool?
        var applyError: String?
        var result: JSON?
        var measurements: JSON?
        var processingCapture: ProcessingCapture?
        var mixCapture: NativeAudioMixCapture?
        var readOnlyAnalysis = false
        var out: URL
        var partFile: URL
        var handle: FileHandle?
        var lastBroadcast = Date.distantPast

        init(id: String, kind: String, spec: [(String, JSON)], out: URL, partFile: URL, assistantLocalOnly: Bool = false, sourceVideoProcessing: Bool = false) {
            self.id = id
            self.kind = kind
            self.assistantLocalOnly = assistantLocalOnly
            self.sourceVideoProcessing = sourceVideoProcessing
            self.spec = spec
            self.out = out
            self.partFile = partFile
        }

        func openHandle(folder: ProjectFolder) throws -> FileHandle {
            let confined = try ReelBackend.exportFile(partFile, folder: folder)
            if let handle {
                let descriptor = handle.fileDescriptor
                _ = try ReelBackend.directExportStamp(descriptor)
                var named = Darwin.stat(), held = Darwin.stat()
                guard confined.path.withCString({ Darwin.lstat($0, &named) }) == 0, Darwin.fstat(descriptor, &held) == 0,
                      named.st_dev == held.st_dev, named.st_ino == held.st_ino else { throw ReelBackend.APIError("The owned export part changed before writing.") }
                return handle
            }
            let descriptor = try ReelBackend.openDirectExport(confined, folder: folder, creating: true)
            _ = try ReelBackend.directExportStamp(descriptor)
            let h = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            handle = h
            return h
        }

        var json: JSON {
            JSON.compact([
                ("id", .string(id)), ("kind", .string(kind)), ("assistantLocalOnly", .bool(assistantLocalOnly)), ("spec", .object(spec)), ("state", .string(state)),
                ("progress", .number(progress)), ("draining", .bool(draining)), ("created", .number((created.timeIntervalSince1970 * 1000).rounded())),
                ("finished", finished.map { .number(($0.timeIntervalSince1970 * 1000).rounded()) }),
                ("output", JSON.str(output)), ("deliveryWarning", JSON.str(deliveryWarning)), ("error", JSON.str(error)),
                ("applied", applied.map(JSON.bool)), ("assetRegistered", assetRegistered.map(JSON.bool)), ("applyError", JSON.str(applyError)),
                ("measurements", measurements), ("result", result),
                ("acceptedVersion", acceptedVersion.map(JSON.int)), ("acceptedGeneration", JSON.str(acceptedGeneration)), ("sourceCohortID", JSON.str(sourceCohortID)), ("acceptedProjectSHA256", JSON.str(acceptedProjectSHA256)),
                ("processingTarget", processingCapture?.target?.identity),
            ])
        }
    }

    /// Single-file WebCodecs exports refuse existing outputs and current source aliases.
    /// Resolve input aliases and compare existing inodes as well as paths (hard links).
    private func checkedWebExportOutput(_ url: URL) throws -> URL {
        let destination = try Self.exportFile(url, folder: folder)
        let renders = try Self.exportFile(folder.rendersDir, folder: folder)
        guard destination.path.hasPrefix(renders.path + "/") else { throw APIError("Export outputs must stay under renders/.") }
        try rejectReferencedMediaOverwrite(destination)
        try NativeExportOutput.refuseExisting(destination, folder: folder)
        return destination
    }

    private func rejectReferencedMediaOverwrite(_ destination: URL) throws {
        guard let project else { throw APIError("No project yet.") }
        let references = try NativeExportSources.references(project)
        func identity(_ file: URL) throws -> (dev_t, ino_t)? {
            var info = Darwin.stat()
            if file.path.withCString({ Darwin.fstatat(AT_FDCWD, $0, &info, 0) }) == 0 { return (info.st_dev, info.st_ino) }
            let code = errno
            guard code == ENOENT else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(code)) }
            return nil
        }
        let outputIdentity = try identity(destination)
        for reference in references {
            let source = try folder.resolve(reference)
            let samePath = source.path == destination.path
            var sameFile = false
            if let outputIdentity, let sourceIdentity = try identity(source) {
                sameFile = outputIdentity.0 == sourceIdentity.0 && outputIdentity.1 == sourceIdentity.1
            }
            guard !samePath && !sameFile else { throw APIError("An export cannot overwrite a source, proxy or LUT referenced by the project. Choose another export name.") }
        }
    }

    /// Public and private receipt limits are independent of caller-supplied kind/spec.
    /// A failed/cancelled job may still own a worker; retain its receipt until that worker
    /// is released so history pruning never forgets still-active cancellation ownership.
    private func pruneCompletedJobs(assistantLocalOnly: Bool) {
        var count = jobs.filter { $0.assistantLocalOnly == assistantLocalOnly }.count
        while count > 50,
              let index = jobs.firstIndex(where: {
                  $0.assistantLocalOnly == assistantLocalOnly &&
                  $0.state != "running" && $0.state != "queued" && nativeTasks[$0.id] == nil && $0.admission == nil
              }) {
            jobs.remove(at: index)
            count -= 1
        }
    }

    /// POST /api/export: registers a job for the page to render. Answers the job, whose
    /// `spec.out` is the project-relative output path.
    private func startExport(_ b: [String: Any]) throws -> JSON {
        guard let project else { throw APIError("no project") }
        let preset = b["preset"] as? String ?? "h264-high"
        guard let ext = Self.presetExtensions[preset] else {
            throw APIError("The \(preset) preset is not available in the Reel app yet: ProRes, GIF and PNG sequences need the native renderer. Use H.264, HEVC or an audio preset, or render from the browser editor.")
        }
        let raw = (b["name"] as? String) ?? folder.root.lastPathComponent
        let base = raw.replacingOccurrences(of: "[^\\w.-]+", with: "-", options: .regularExpression).isEmpty ? "reel" : raw.replacingOccurrences(of: "[^\\w.-]+", with: "-", options: .regularExpression)
        let renders = try Self.exportFile(folder.rendersDir, folder: folder)
        try FileManager.default.createDirectory(at: renders, withIntermediateDirectories: true)
        let out = try checkedWebExportOutput(try (b["out"] as? String).map { try folder.output($0) } ?? freeExport(base: base, ext: ext, in: renders))
        let context = try captureProcessingContext(b, allSources: true)
        var scheduled = false
        defer { if !scheduled { context.lease.finish() } }
        let id = "j" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + String(Int.random(in: 0 ..< 46656), radix: 36)
        let exports = try Self.exportFile(folder.dotDir.appendingPathComponent("exports"), folder: folder)
        try FileManager.default.createDirectory(at: exports, withIntermediateDirectories: true)
        let publication = try NativeExportOutput(folder: folder, destination: out)
        let partFile = publication.part
        let snapshot = try projectView(comp: b["comp"] as? String)
        let sources = try NativeExportSources.capture(project: snapshot, folder: folder)
        let fields = (try? JSON.parse(snapshot) as? [String: Any]) ?? [:]
        let fps = (b["fps"] as? NSNumber)?.doubleValue ?? (fields["fps"] as? NSNumber)?.doubleValue ?? 30
        let width = (b["width"] as? NSNumber)?.doubleValue ?? (fields["width"] as? NSNumber)?.doubleValue ?? 1920
        let height = (b["height"] as? NSNumber)?.doubleValue ?? (fields["height"] as? NSNumber)?.doubleValue ?? 1080
        let range = b["range"] as? [String: Any]
        let rangeIn = (range?["in"] as? NSNumber)?.doubleValue ?? 0
        let rangeOut = try (range?["out"] as? NSNumber)?.doubleValue ?? core.duration(project: snapshot)
        try validateExportAdmission(width: width, height: height, fps: fps, from: rangeIn, to: rangeOut)
        let outWidth = Int((width / 2).rounded()) * 2, outHeight = Int((height / 2).rounded()) * 2
        let spec: [(String, JSON)] = [
            ("preset", .string(preset)), ("name", .string(raw)),
            ("width", .int(outWidth)), ("height", .int(outHeight)), ("fps", .number(fps)),
            ("range", .object([("in", .number(rangeIn)), ("out", .number(rangeOut))])), ("out", .string(folder.relative(out))),
            ("frames", .int(max(1, Int(ceil((rangeOut - rangeIn) * fps))))),
        ]
        let job = Job(id: id, kind: "export", spec: spec, out: out, partFile: partFile)
        job.admission = context.lease; job.admissionContext = context; job.externalWorker = true
        job.bindExport(project: snapshot, context: context, sources: sources, output: publication)
        jobs.append(job)
        pruneCompletedJobs(assistantLocalOnly: false)
        broadcast("job", job.json)
        nativeTasks[id] = Task { [weak self] in
            guard let self else { context.lease.finish(); return }
            do {
                try await context.lease.wait()
                try await self.activateProcessingJob(id, context: context)
                await self.pageWorkerDispatched(id)
            } catch {
                await self.processingFailed(id, error.localizedDescription)
                await self.processingWorkerExited(id)
                context.lease.finish()
            }
        }
        scheduled = true
        pushActivity("reel", "export queued: \(folder.relative(out))")
        return job.acceptedJSON
    }

    private func validateExportAdmission(width: Double, height: Double, fps: Double, from: Double, to: Double) throws {
        guard width.isFinite, height.isFinite, fps.isFinite, from.isFinite, to.isFinite,
              width >= 2, height >= 2, width <= 8192, height <= 8192, width * height <= 33_554_432,
              fps >= 1, fps <= 120, from >= 0, to > from, to - from <= 3600, ceil((to - from) * fps) <= 216_000 else {
            throw APIError("Export supports at most 8192 pixels per edge, 33554432 pixels, 120 fps, one hour and 216000 frames.")
        }
    }
    private func pageWorkerDispatched(_ id: String) { nativeTasks[id] = nil }

    /// The host may call this only after the WebKit content process has exited. A
    /// navigation or Stop request alone does not prove that page work has drained.
    public func hasPageProcessingWorkers() -> Bool { jobs.contains { $0.externalWorker && $0.admission != nil } }

    public func pageProcessingWorkersExited() async {
        for job in jobs where job.externalWorker && job.admission != nil {
            nativeTasks[job.id]?.cancel()
            if job.state == "running" || job.state == "queued" { fail(job, "The page worker exited.") }
            job.admission?.cancelChildren()
            await job.admission?.waitForChildrenToExit()
            processingWorkerExited(job.id)
        }
    }

    private func exportProgress(_ b: [String: Any]) -> JSON {
        guard let id = b["id"] as? String, let job = jobs.first(where: { $0.id == id }) else { return .object([("cancelled", true)]) }
        if job.state == "queued" { return .object([("cancelled", false), ("queued", true), ("state", "queued")]) }
        guard job.state == "running" else { return .object([("cancelled", true), ("state", .string(job.state)), ("draining", .bool(job.draining))]) }
        if let context = job.admissionContext {
            do { try validateProcessingJobContext(job, context: context) }
            catch { nativeTasks[id]?.cancel(); fail(job, error.localizedDescription); return .object([("cancelled", true)]) }
        }
        job.progress = min(0.99, max(0, (b["progress"] as? NSNumber)?.doubleValue ?? job.progress))
        if Date().timeIntervalSince(job.lastBroadcast) > 0.3 {
            job.lastBroadcast = Date()
            broadcast("job", job.json)
        }
        return .object([("cancelled", false), ("state", "running")])
    }

    private func finishExport(_ b: [String: Any]) async throws -> JSON {
        guard let id = b["id"] as? String, let job = jobs.first(where: { $0.id == id }) else { throw APIError("no such job") }
        guard job.externalWorker, b["drained"] as? Bool == true else { throw APIError("The page must drain its encoder, audio and decoders before finishing an export.") }
        job.admission?.sealChildren(cancel: b["error"] != nil)
        await job.admission?.waitForChildrenToExit()
        do {
            try publishPageExport(job, body: b)
            processingWorkerExited(id)
            return job.json
        } catch {
            if job.state == "running" || job.state == "queued" { fail(job, error.localizedDescription) }
            processingWorkerExited(id)
            throw error
        }
    }
    private func publishPageExport(_ job: Job, body b: [String: Any]) throws {
        if let error = b["error"] as? String {
            if job.state == "running" || job.state == "queued" { fail(job, error) }
            return
        }
        guard job.state == "running" else { throw APIError(job.error ?? "the job is \(job.state)") }
        try requireWritableProject()
        let partFile = try Self.exportFile(job.partFile, folder: folder)
        try job.handle?.synchronize()
        try job.handle?.close()
        job.handle = nil
        guard let size = (try? FileManager.default.attributesOfItem(atPath: partFile.path)[.size]) as? NSNumber, size.int64Value > 0 else {
            fail(job, "the editor sent no data for the export")
            throw APIError("the editor sent no data for the export")
        }
        // Recheck current media references and confinement immediately before publication.
        let destination: URL
        do { destination = try checkedWebExportOutput(job.out) }
        catch {
            fail(job, error.localizedDescription)
            throw error
        }
        if let context = job.admissionContext { try validateProcessingContext(context) }
        try validateExportPublication(job.id)
        guard let publication = job.exportOutput, publication.destination == destination else { throw APIError("The export output ownership was lost.") }
        _ = try publication.publish()
        job.state = "done"
        job.progress = 1
        job.finished = Date()
        job.output = folder.relative(job.out)
        recordDelivery(job)
        broadcast("job", job.json)
        pushActivity("reel", String(format: "exported %@ in %.1fs", job.output!, job.finished!.timeIntervalSince(job.created)))
    }

    private func publishStillOutput(_ publication: NativeExportOutput, context: ProcessingContext?, sources: NativeExportSources) throws -> URL {
        guard let context else { throw APIError("The still lost its accepted processing context.") }
        try requireWritableProject()
        try validateProcessingContext(context)
        try sources.validate(folder: folder)
        try rejectReferencedMediaOverwrite(publication.destination)
        let output = try publication.publish()
        context.exportPublished = true
        return output
    }

    private func publishNativeExportOutput(_ id: String, publication: NativeExportOutput) throws -> URL {
        try validateExportPublication(id)
        guard let job = jobs.first(where: { $0.id == id }), job.exportOutput === publication else { throw APIError("The export output ownership changed.") }
        let output = try publication.publish()
        completeNativeExport(id, output: output)
        return output
    }

    private func validateExportPublication(_ id: String) throws {
        guard let job = jobs.first(where: { $0.id == id }), job.state == "running",
              let context = job.admissionContext, let sources = job.exportSources, let output = job.exportOutput else { throw APIError("The export no longer owns an active output.") }
        try requireWritableProject()
        try validateProcessingContext(context)
        try sources.validate(folder: folder)
        try rejectReferencedMediaOverwrite(job.out)
        try output.validateDirectories()
        try NativeExportOutput.refuseExisting(job.out, folder: folder)
    }
    #if DEBUG
    func exportPartForTesting(_ id: String) -> URL? { jobs.first(where: { $0.id == id })?.partFile }
    #endif

    private func fail(_ job: Job, _ message: String) {
        job.draining = job.admission != nil || nativeTasks[job.id] != nil
        if job.externalWorker { job.admission?.cancelChildren() }
        job.state = "failed"
        job.finished = Date()
        job.error = message
        try? job.handle?.close()
        job.handle = nil
        if !job.draining, !job.readOnlyAnalysis, let confined = try? Self.exportFile(job.partFile, folder: folder) { try? FileManager.default.removeItem(at: confined) }
        broadcast("job", job.json)
        pushActivity("reel", "job failed: \(message)")
    }

    private func waitJob(_ id: String, timeout: Double) async throws -> JSON {
        let until = Date().addingTimeInterval(min(60, timeout / 1000))
        while Date() < until {
            guard let job = jobs.first(where: { $0.id == id }) else { throw APIError("no job \(id)") }
            if job.state == "done" || job.state == "failed" { return job.json }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        guard let job = jobs.first(where: { $0.id == id }) else { throw APIError("no job \(id)") }
        return job.json
    }
}
