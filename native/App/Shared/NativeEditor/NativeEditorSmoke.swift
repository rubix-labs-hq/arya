#if DEBUG
import Foundation
import ImageIO
import ReelKit
import UniformTypeIdentifiers
import AVFoundation
import CryptoKit
#if os(macOS)
import AppKit
import Darwin
#endif
#if os(iOS)
import UIKit
#endif

/// Runs only with an explicit debug launch flag and a disposable project folder.
@MainActor
enum NativeEditorSmoke {
    #if os(macOS)
    private static var firstUseStarted = false
    private static weak var firstUseWindow: NSWindow?
    private static weak var firstUseSession: EditorSession?
    private static var firstUseComposerCleanup: [String: Any]?

    static func registerFirstUseWindow(_ window: NSWindow, session: EditorSession) {
        guard CommandLine.arguments.contains("--native-firstuse-root") else { return }
        firstUseWindow = window; firstUseSession = session
    }
    #endif
    static func start(_ session: EditorSession, quit: @escaping () -> Void) {
        #if os(macOS)
        if CommandLine.arguments.contains("--native-firstuse-root") {
            guard !firstUseStarted else { return }
            firstUseStarted = true
            startFirstUse(session)
            return
        }
        #endif
        guard let out = Automation.value("--native-smoke-out") else { return }
        Task {
            var result: [String: Any] = [:]
            do {
                #if os(macOS)
                let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical], reason: "Native editor smoke measurement")
                defer { ProcessInfo.processInfo.endActivity(activity) }
                result["applicationActiveAtStart"] = NSApp.isActive
                #endif
                let model = session.nativeEditor
                model.readbackFrames = true
                for _ in 0..<200 {
                    if model.project != nil && session.projectReadOnlyReason == nil { break }
                    try await Task.sleep(for: .milliseconds(50))
                }
                guard let before = model.project, session.folder?.lastPathComponent.hasPrefix("native-editor-smoke-") == true else { throw ReelBackend.APIError("Native smoke requires an open disposable native-editor-smoke-* folder.") }
                guard session.projectReadOnlyReason == nil else { throw ReelBackend.APIError(session.projectReadOnlyReason ?? "The project is not writable.") }
                let initial = before.text
                try await model.ops([["op": "add_title", "text": "Native UI smoke", "start": 0, "dur": 2, "title": ["font": "Inter", "anim": "none"]]])
                guard let clip = model.tracks.flatMap(\.clips).first(where: { $0.fields.dictionary("title").string("text") == "Native UI smoke" }) else { throw ReelBackend.APIError("Adding a native title did not refresh the model.") }
                model.selectedID = clip.id
                try await model.ops([["op": "update", "id": clip.id, "set": ["x": 220, "grade": ["exposure": 0.2]]], ["op": "keyframe", "id": clip.id, "prop": "opacity", "at": 0, "value": 0], ["op": "keyframe", "id": clip.id, "prop": "opacity", "at": 1, "value": 1]])
                guard model.selected?.fields.number("x") == 220, (model.selected?.fields.dictionary("anim")["opacity"] as? [[Any]])?.count == 2 else { throw ReelBackend.APIError("The inspector and motion operations did not persist.") }
                try await model.ops([["op": "node_add", "id": clip.id, "node": ["type": "corrector"], "after": "n2"]])
                guard let node = model.selected?.nodes.first(where: { $0.string("type") == "corrector" }) else { throw ReelBackend.APIError("The native color node was not added.") }
                try await model.ops([["op": "node_update", "id": clip.id, "node": node.string("id"), "set": ["grade": ["saturation": 0.8], "window": ["type": "rect", "x": 0.5, "y": 0.5, "w": 0.6, "h": 0.6]]], ["op": "add_mask", "id": clip.id, "mask": ["type": "path", "path": ["closed": true, "vertices": [[-180, -100], [180, -100], [180, 100], [-180, 100]]]]], ["op": "project", "set": ["master": ["volume": -3, "limiter": ["enabled": true, "ceiling": -1]]]]])
                guard (model.selected?.fields.objects("masks").first?.dictionary("path")["vertices"] as? [[Double]])?.count == 4,
                      model.selected?.fields.objects("masks").first?.string("type") == "path",
                      model.project?.fields.dictionary("master").number("volume") == -3 else { throw ReelBackend.APIError("Native mask and audio mixer operations did not persist.") }
                model.seek(0.5)
                for _ in 0..<200 {
                    if model.frame != nil && !model.rendering { break }
                    try await Task.sleep(for: .milliseconds(50))
                }
                guard let image = model.frame, model.renderError == nil else { throw ReelBackend.APIError(model.renderError ?? "The native viewer did not render.") }
                let scopes = NativeScopeRaster(image: image)
                result["presentation"] = ["draws": NativePresentationDiagnostics.draws, "inactiveDraws": NativePresentationDiagnostics.inactiveDraws, "unavailableDrawables": NativePresentationDiagnostics.unavailableDrawables, "error": NativePresentationDiagnostics.error ?? ""]
                guard scopes.sampleCount > 4096, scopes.histogram[0].reduce(0, +) == Double(scopes.sampleCount), scopes.waveformRows > 1,
                      scopes.waveform != nil, scopes.parade != nil, scopes.vectorscope != nil else { throw ReelBackend.APIError("The native scopes did not sample the rendered frame.") }
                let paintsBefore = model.paintedFrames
                var scrubTimes = Set<Double>(), scrubHashes = Set<String>()
                let scrubClock = ContinuousClock()
                model.resetScrubTimingRecords()
                let scrubIntervalOffset = model.scrubTimingOffsetSeconds
                var scrubIssues: [[String: Any]] = []
                let scrubStarted = Date()
                for step in 0..<30 {
                    let issued = model.scrubTimingOffsetSeconds
                    model.scrub(Double(step) / 20)
                    scrubIssues.append(["token": model.scrubLastIntentToken?.uuidString ?? "", "issueOffsetSeconds": issued,
                        "requestedTime": Double(step) / 20, "quantizedTime": model.time, "release": false])
                    try await Task.sleep(for: .milliseconds(16))
                    if let at = model.displayedTime { scrubTimes.insert(at) }
                    if let pixels = model.frame?.dataProvider?.data { scrubHashes.insert(SHA256.hash(data: pixels as Data).map { String(format: "%02x", $0) }.joined()) }
                }
                let finalStarted = Date()
                let finalMonotonicStarted = scrubClock.now
                let releaseIssued = model.scrubTimingOffsetSeconds
                model.scrub(1.8, finished: true)
                scrubIssues.append(["token": model.scrubLastIntentToken?.uuidString ?? "", "issueOffsetSeconds": releaseIssued,
                    "requestedTime": 1.8, "quantizedTime": model.time, "release": true])
                for _ in 0..<200 {
                    if !model.rendering, model.displayedTime == model.time { break }
                    try await Task.sleep(for: .milliseconds(20))
                }
                let finalObservedOffset = model.scrubTimingOffsetSeconds
                let finalObservedToken = model.scrubLastIntentToken?.uuidString ?? ""
                let finalLatency = Date().timeIntervalSince(finalStarted)
                let finalElapsed = finalMonotonicStarted.duration(to: scrubClock.now).components
                let monotonicFinalLatency = Double(finalElapsed.seconds) + Double(finalElapsed.attoseconds) / 1_000_000_000_000_000_000
                let intervalTimings = model.scrubFrameTimings.filter { value in
                    guard case .object(let fields) = value,
                          let field = fields.first(where: { $0.0 == "intentOffsetSeconds" }),
                          case .number(let offset) = field.1 else { return false }
                    return offset >= scrubIntervalOffset
                }
                let scrubMeasurement: [String: Any] = ["clock": "ContinuousClock", "intervalStartOffsetSeconds": scrubIntervalOffset,
                    "finalObservedOffsetSeconds": finalObservedOffset, "finalObservedToken": finalObservedToken,
                    "finalReleaseSeconds": monotonicFinalLatency, "finalReleaseLimitSeconds": 0.5,
                    "targetStatus": monotonicFinalLatency <= 0.5 ? "met" : "missed", "accepted": false,
                    "interval": "release-to-observed-model-frame-and-worker-idle", "presentationMeasured": false,
                    "intendedDriverCadenceSeconds": 0.016, "actualIssueRecords": scrubIssues,
                    "gestureEndOffsetSeconds": releaseIssued,
                    "droppedRecords": model.scrubTimingDroppedRecords, "traceComplete": model.scrubTimingDroppedRecords == 0,
                    "requestedTime": model.time, "displayedTime": model.displayedTime ?? -1,
                    "finalWidth": model.metalFrame?.width ?? 0, "rendering": model.rendering,
                    "scrubbing": model.scrubbing, "renderError": model.renderError ?? "",
                    "records": try JSON.parse(JSON.array(intervalTimings).text)]
                result["scrubMeasurement"] = scrubMeasurement
                #if os(iOS)
                let finalWidth = 960
                #else
                let finalWidth = 1280
                #endif
                guard scrubTimes.count >= 3, scrubHashes.count >= 2, model.paintedFrames - paintsBefore >= 3,
                      model.displayedTime == model.time, model.metalFrame?.width == finalWidth, !model.scrubbing else { throw ReelBackend.APIError("Rapid native scrub did not paint intermediate positions and the final full-quality frame.") }
                let originalRenderer = try ReelMetalRenderer(folder: ProjectFolder(root: session.folder!), coreScriptURL: session.editor.coreScript)
                let originalFrame = try await originalRenderer.render(project: model.project!.text, at: model.time, comp: model.composition, width: finalWidth)
                guard let originalPixels = try originalFrame.cgImage().dataProvider?.data,
                      let displayedPixels = model.frame?.dataProvider?.data,
                      (originalPixels as Data) == (displayedPixels as Data) else { throw ReelBackend.APIError("Released native preview did not match the original-source frame.") }
                let scrubOriginalComparison: [String: Any] = ["releaseToken": model.scrubLastIntentToken?.uuidString ?? "",
                    "requestedTime": model.time, "displayedTime": model.displayedTime ?? -1,
                    "finalWidth": model.metalFrame?.width ?? 0, "pixelsEqual": true]
                result["scrubOriginalComparison"] = scrubOriginalComparison
                await originalRenderer.releaseCaches()
                let scrubEvidence: [String: Any] = ["intermediatePositions": scrubTimes.sorted(), "distinctPixelHashes": scrubHashes.count, "paintedFrames": model.paintedFrames - paintsBefore, "seconds": Date().timeIntervalSince(scrubStarted), "finalLatencySeconds": finalLatency, "requestedTime": model.time, "displayedTime": model.displayedTime ?? -1, "finalWidth": model.metalFrame?.width ?? 0]
                result["scrub"] = scrubEvidence
                guard model.scrubTimingDroppedRecords == 0 else { throw ReelBackend.APIError("Native scrub measurement lost timing records; the trace is incomplete.") }
                guard monotonicFinalLatency <= 0.5 else { throw ReelBackend.APIError("Native full-quality scrub release exceeded the proposed 0.5-second model latency target: \(monotonicFinalLatency) seconds.") }
                model.seek(0)
                let playbackPaints = model.paintedFrames
                let completedBefore = model.playbackCompletedSegments
                model.playbackChunkForTesting = 0.4
                model.readbackFrames = false
                model.play()
                var lastAudioTime = 0.0, lastClockAdvance = Date(), largestClockGap = 0.0
                var largestFrameLag = 0.0, previewWidths = Set<Int>()
                let playbackClock = ContinuousClock(), playbackStarted = ContinuousClock().now
                var playbackSamples: [[String: Any]] = []
                for _ in 0..<200 {
                    let elapsed = playbackStarted.duration(to: playbackClock.now).components
                    #if os(macOS)
                    let applicationActive = NSApp.isActive
                    #else
                    let applicationActive = UIApplication.shared.applicationState == .active
                    #endif
                    playbackSamples.append(["elapsedSeconds": Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18,
                        "modelTime": model.time, "audioTime": model.playbackClockForTesting ?? -1, "applicationActive": applicationActive,
                        "displayedTime": model.displayedTime ?? -1, "rendering": model.rendering,
                        "paintedFrames": model.paintedFrames - playbackPaints,
                        "completedAudioChunks": model.playbackCompletedSegments - completedBefore])
                    if model.time > lastAudioTime + 0.001 {
                        if lastAudioTime > 0.02 { largestClockGap = max(largestClockGap, Date().timeIntervalSince(lastClockAdvance)) }
                        lastClockAdvance = Date(); lastAudioTime = model.time
                    }
                    if model.playing, model.time > 0.05, let displayed = model.displayedTime, displayed <= model.time {
                        largestFrameLag = max(largestFrameLag, model.time - displayed)
                        if let width = model.metalFrame?.width { previewWidths.insert(width) }
                    }
                    if model.time >= 1.35, model.playbackCompletedSegments - completedBefore >= 3, model.paintedFrames - playbackPaints >= 4 { break }
                    try await Task.sleep(for: .milliseconds(20))
                }
                let playbackEvidence: [String: Any] = ["time": model.time, "displayedTime": model.displayedTime ?? -1, "paintedFrames": model.paintedFrames - playbackPaints, "completedAudioChunks": model.playbackCompletedSegments - completedBefore, "largestClockGapSeconds": largestClockGap, "largestFrameLagSeconds": largestFrameLag, "previewWidths": previewWidths.sorted(), "preparationSeconds": model.audioPreparationSeconds, "historySeconds": model.audioPreviewHistorySeconds, "samples": playbackSamples]
                result["playback"] = playbackEvidence
                guard model.time >= 1.35, model.playbackCompletedSegments - completedBefore >= 3, model.paintedFrames - playbackPaints >= 4, largestClockGap < 0.2 else { throw ReelBackend.APIError("Native playback check failed: time \(model.time), completed \(model.playbackCompletedSegments - completedBefore), painted \(model.paintedFrames - playbackPaints), gap \(largestClockGap), status \(model.status), prepare \(model.audioPreparationSeconds), render \(model.renderError ?? "none").") }
                model.pause(); model.playbackChunkForTesting = nil; model.readbackFrames = true
                for _ in 0..<200 {
                    if !model.rendering, model.displayedTime == model.time { break }
                    try await Task.sleep(for: .milliseconds(20))
                }
                guard model.metalFrame?.width == finalWidth, model.displayedTime == model.time else { throw ReelBackend.APIError("Pausing native playback did not restore the exact full-quality frame.") }
                model.seek(0.5)
                for _ in 0..<200 { if !model.rendering { break }; try await Task.sleep(for: .milliseconds(20)) }
                let imageURL = URL(fileURLWithPath: out).deletingPathExtension().appendingPathExtension("png")
                guard let destination = CGImageDestinationCreateWithURL(imageURL as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw ReelBackend.APIError("Cannot save smoke frame.") }
                CGImageDestinationAddImage(destination, image, nil)
                guard CGImageDestinationFinalize(destination) else { throw ReelBackend.APIError("Cannot finish smoke frame.") }
                for _ in 0..<4 { _ = try await model.call("/api/undo", [:]) }
                guard model.project?.text == initial else { throw ReelBackend.APIError("Native undo did not restore the exact initial project.") }
                let audio = try await session.backend!.renderAudio(from: 0, to: 0.5)
                guard (try FileManager.default.attributesOfItem(atPath: audio.path)[.size] as? NSNumber)?.intValue ?? 0 > 44 else { throw ReelBackend.APIError("Native audio preview is empty.") }
                let projectFolder = ProjectFolder(root: session.folder!)
                let player = NativePlaybackAudio(); try player.load(audio, start: 0, end: 0.5, ownedIn: projectFolder); try player.play()
                try await Task.sleep(for: .milliseconds(100))
                guard (player.time ?? 0) > 0 else { throw ReelBackend.APIError("The audio player did not advance.") }; player.stop()
                guard !FileManager.default.fileExists(atPath: audio.path) else { throw ReelBackend.APIError("Stopped audio preview retained its owned cache file.") }
                model.readbackFrames = false; model.playbackChunkForTesting = 0.4
                for _ in 0..<3 {
                    model.seek(0); model.play()
                    for _ in 0..<200 { if model.time > 0.05 { break }; try await Task.sleep(for: .milliseconds(20)) }
                    guard model.time > 0.05 else { throw ReelBackend.APIError("Repeated native playback did not start.") }
                    model.pause()
                    for _ in 0..<200 {
                        let files = (try? FileManager.default.contentsOfDirectory(at: projectFolder.root.appendingPathComponent(".reel/cache"), includingPropertiesForKeys: nil)) ?? []
                        if !files.contains(where: { $0.lastPathComponent.hasPrefix("mix-") && $0.pathExtension == "wav" }) { break }
                        try await Task.sleep(for: .milliseconds(20))
                    }
                    let files = (try? FileManager.default.contentsOfDirectory(at: projectFolder.root.appendingPathComponent(".reel/cache"), includingPropertiesForKeys: nil)) ?? []
                    guard !files.contains(where: { $0.lastPathComponent.hasPrefix("mix-") && $0.pathExtension == "wav" }) else { throw ReelBackend.APIError("Repeated playback retained owned preview cache files.") }
                }
                model.playbackChunkForTesting = nil; model.readbackFrames = true
                result["repeatedPlaybackCleanup"] = true
                guard NativePresentationDiagnostics.draws > 0, NativePresentationDiagnostics.error == nil else { throw ReelBackend.APIError("Native Metal display failed: \(NativePresentationDiagnostics.error ?? "no completed display commands").") }
                let processingEvidence = try await processing(model, initial: initial)
                let export = try await model.call("/api/export", ["preset": "h264-fast", "name": "native-ui-smoke", "width": 320, "height": 180, "fps": 6, "from": 0, "to": 0.5])
                let id = export.string("id")
                var job: [String: Any] = [:]
                for _ in 0..<6 {
                    job = try await model.call(nativeQuery("/api/jobs/wait", ["id": id, "timeout": "10000"]))
                    if job.string("state") != "running" { break }
                }
                guard job.string("state") == "done" else { throw ReelBackend.APIError(job.string("error", "Native Deliver did not complete.")) }
                let exportURL = try model.mediaURL(job.string("output"))
                let movie = AVURLAsset(url: exportURL)
                let tracks = try await movie.loadTracks(withMediaType: .video)
                let length = try await movie.load(.duration).seconds
                guard !tracks.isEmpty, length >= 0.4 else { throw ReelBackend.APIError("Native Deliver wrote an unreadable video.") }
                #if os(iOS)
                let mobile = NativeMobileExport.shared
                guard !mobile.pending else { throw ReelBackend.APIError("The mobile smoke must not replace an existing queued export.") }
                mobile.forceForegroundForTesting = true
                defer { mobile.forceForegroundForTesting = false }
                do { _ = try await mobile.start(session: session, body: ["preset": "invalid", "from": 0, "to": 0.5]); throw ReelBackend.APIError("Invalid mobile export was accepted.") }
                catch { guard !mobile.pending else { throw ReelBackend.APIError("Rejected registration stranded the mobile export queue.") } }
                let mobileJob = try await mobile.start(session: session, body: ["preset": "h264-fast", "name": "mobile-cancel", "width": 320, "height": 180, "fps": 60, "from": 0, "to": 2])
                guard mobile.running, mobile.pending, !mobile.canResume else { throw ReelBackend.APIError("Active mobile export did not disable resume and discard.") }
                mobile.resume(); mobile.discard()
                guard mobile.pending else { throw ReelBackend.APIError("Discard removed an active export's persisted request.") }
                NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
                let stopped = try await model.call(nativeQuery("/api/jobs/wait", ["id": mobileJob.string("id"), "timeout": "10000"]))
                guard stopped.string("state") == "failed" else { throw ReelBackend.APIError("Foreground GPU export did not cancel before background transition.") }
                for _ in 0..<100 { if mobile.canResume { break }; try await Task.sleep(for: .milliseconds(20)) }
                guard mobile.canResume else { throw ReelBackend.APIError("Cancelled mobile export was not resumable.") }
                mobile.discard(); guard !mobile.pending else { throw ReelBackend.APIError("Suspended mobile export could not be discarded.") }
                #endif
                result.merge(["ok": true, "native": !session.useWebEditor, "project": before.name, "frame": imageURL.path, "width": image.width, "height": image.height, "opsUndoExact": true, "motionKeys": true, "colorNodes": true, "pathMask": true, "mixer": true, "scopeSamples": scopes.sampleCount, "audioPreview": true, "audioPlayback": true, "export": exportURL.path, "exportSeconds": length, "tracks": model.tracks.count]) { _, current in current }
                result["scrub"] = scrubEvidence; result["playback"] = playbackEvidence
                result["scrubMeasurement"] = scrubMeasurement
                result["scrubOriginalComparison"] = scrubOriginalComparison
                result["processing"] = processingEvidence; result["audioCacheCleanup"] = true
                result["repeatedPlaybackCleanup"] = true; result["pausedFrameFullQuality"] = true; result["releasedFrameMatchesOriginal"] = true
                result["presentation"] = ["draws": NativePresentationDiagnostics.draws, "inactiveDraws": NativePresentationDiagnostics.inactiveDraws, "unavailableDrawables": NativePresentationDiagnostics.unavailableDrawables, "error": NativePresentationDiagnostics.error ?? ""]
                #if os(iOS)
                result["mobileQueueGuards"] = true; result["foregroundGPUSuspended"] = true
                #endif
            } catch { result["ok"] = false; result["error"] = error.localizedDescription }
            try? JSON(any: result).text.write(toFile: out, atomically: true, encoding: .utf8)
            if CommandLine.arguments.contains("--quit-after-automation") { quit() }
        }
    }
    #if os(macOS)
    private struct FirstUseRoot {
        let url: URL
        let device: UInt64
        let inode: UInt64
        var source: URL { url.appendingPathComponent("source.png") }
        var project: URL { url.appendingPathComponent("project", isDirectory: true) }
        var output: URL { url.appendingPathComponent("result.json") }

        private static func canonicalPath(_ path: String) -> String? {
            guard let resolved = path.withCString({ realpath($0, nil) }) else { return nil }
            defer { free(resolved) }
            return String(cString: resolved)
        }

        private var projectIsBound: Bool {
            project.path.withCString { path in
                var info = stat()
                if lstat(path, &info) != 0 { return errno == ENOENT }
                return info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR)
                    && Self.canonicalPath(project.path) == project.path
            }
        }

        init(_ path: String) throws {
            let root = URL(fileURLWithPath: path, isDirectory: true)
            let prefix = "native-editor-smoke-firstuse-"
            guard root.path == path, root.deletingLastPathComponent().path == "/private/tmp",
                  root.lastPathComponent.hasPrefix(prefix),
                  UUID(uuidString: String(root.lastPathComponent.dropFirst(prefix.count))) != nil,
                  Self.canonicalPath(path) == path else {
                throw ReelBackend.APIError("First-use requires a canonical UUID-named QA root under /private/tmp.")
            }
            let values = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            let attributes = try FileManager.default.attributesOfItem(atPath: root.path)
            guard values.isDirectory == true, values.isSymbolicLink != true,
                  let device = attributes[.systemNumber] as? NSNumber,
                  let inode = attributes[.systemFileNumber] as? NSNumber else {
                throw ReelBackend.APIError("The first-use QA root must be a real directory.")
            }
            let names = try FileManager.default.contentsOfDirectory(atPath: root.path)
            guard names == ["source.png"] else {
                throw ReelBackend.APIError("The first-use QA root must contain only source.png.")
            }
            self.url = root; self.device = device.uint64Value; self.inode = inode.uint64Value
        }

        func requireUnchanged() throws {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard Self.canonicalPath(url.path) == url.path,
                  (attributes[.type] as? FileAttributeType) == .typeDirectory,
                  (attributes[.systemNumber] as? NSNumber)?.uint64Value == device,
                  (attributes[.systemFileNumber] as? NSNumber)?.uint64Value == inode,
                  projectIsBound else {
                throw ReelBackend.APIError("The first-use QA directory changed. No further action is allowed.")
            }
        }

        func sourceBytes() throws -> Data {
            try requireUnchanged()
            let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, size > 0, size <= 131_072 else {
                throw ReelBackend.APIError("source.png must be a regular PNG file no larger than 128 KiB.")
            }
            let bytes = try Data(contentsOf: source)
            guard bytes.count == size,
                  let image = CGImageSourceCreateWithData(bytes as CFData, nil),
                  CGImageSourceGetCount(image) == 1, let type = CGImageSourceGetType(image),
                  (type as String) == UTType.png.identifier,
                  let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [String: Any],
                  let width = properties[kCGImagePropertyPixelWidth as String] as? NSNumber,
                  let height = properties[kCGImagePropertyPixelHeight as String] as? NSNumber,
                  (1...640).contains(width.intValue), (1...360).contains(height.intValue) else {
                throw ReelBackend.APIError("source.png must contain one PNG image no larger than 640 by 360.")
            }
            return bytes
        }
    }

    private static func firstUseCanonical(_ fields: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    }

    private static func firstUseDiskMatches(_ root: FirstUseRoot, _ project: NativeProject) throws {
        try root.requireUnchanged()
        let file = try ProjectFolder(root: root.project).resolve("reel.project.json")
        guard let fields = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
              try firstUseCanonical(fields) == firstUseCanonical(project.fields) else {
            throw ReelBackend.APIError("The committed project on disk does not match the native model.")
        }
    }

    private static func firstUseWait(_ step: String, root: FirstUseRoot, session: EditorSession,
                                     backend: ReelBackend, context: UUID,
                                     ready: () throws -> Bool) async throws {
        for _ in 0..<200 {
            try Task.checkCancellation()
            try root.requireUnchanged()
            guard session.backend === backend, session.folder == root.project,
                  session.nativeEditor.processingContextID == context, !session.useWebEditor else {
                throw ReelBackend.APIError("The native project changed during \(step).")
            }
            if let error = session.error { throw ReelBackend.APIError(error) }
            if try ready() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw ReelBackend.APIError("First-use timed out during \(step). The QA app stays open for inspection.")
    }

    private static func firstUseComposer(in window: NSWindow, requireViewport: Bool = true) throws -> NSTextView? {
        guard let content = window.contentView else { return nil }
        if requireViewport, !window.isVisible || !window.isKeyWindow || window.attachedSheet != nil { return nil }
        func named(_ element: NSAccessibilityProtocol) -> Bool {
            element.accessibilityIdentifier() == "editor.assistant.draft"
                || element.accessibilityLabel() == "Assistant prompt or script"
        }
        var matches: [ObjectIdentifier: NSTextView] = [:]
        func retain(_ view: NSView, identified: Bool) {
            guard identified, let text = view as? NSTextView, text.window === window, text.isEditable else { return }
            if requireViewport, text.isHiddenOrHasHiddenAncestor || text.visibleRect.width < 100 || text.visibleRect.height < 44 { return }
            matches[ObjectIdentifier(text)] = text
        }
        var views: [(NSView, Bool)] = [(content, false)], viewCount = 0
        while let (view, inherited) = views.popLast() {
            viewCount += 1
            guard viewCount <= 2_000 else { throw ReelBackend.APIError("The native composer view search exceeded its limit.") }
            let identified = inherited || named(view)
            retain(view, identified: identified)
            views.append(contentsOf: view.subviews.map { ($0, identified) })
        }
        var elements: [(NSObject, Bool)] = [(content, false)], visited = Set<ObjectIdentifier>()
        while let (object, inherited) = elements.popLast() {
            guard visited.insert(ObjectIdentifier(object)).inserted else { continue }
            guard visited.count <= 2_000 else { throw ReelBackend.APIError("The native composer accessibility search exceeded its limit.") }
            guard let element = object as? NSAccessibilityProtocol else { continue }
            let identified = inherited || named(element)
            if let view = object as? NSView { retain(view, identified: identified) }
            elements.append(contentsOf: (element.accessibilityChildren() ?? []).compactMap { child in
                (child as? NSObject).map { ($0, identified) }
            })
        }
        guard matches.count <= 1 else { throw ReelBackend.APIError("The QA window exposes multiple identified assistant composers.") }
        return matches.values.first
    }

    private static func firstUseComposerCheck(_ session: EditorSession, root: FirstUseRoot,
                                              backend: ReelBackend, context: UUID) async throws -> [String: Any] {
        let model = session.nativeEditor
        firstUseComposerCleanup = nil
        var window: NSWindow?
        try await firstUseWait("assistant window", root: root, session: session, backend: backend, context: context) {
            guard firstUseSession === session, let current = firstUseWindow,
                  current.isVisible, current.isKeyWindow, current.attachedSheet == nil else { return false }
            window = current
            return true
        }
        guard let window, let screen = window.screen, let content = window.contentView,
              let project = model.project, model.assistantDraft.isEmpty, !session.assistant.isWorking else {
            throw ReelBackend.APIError("The assistant check requires an idle empty draft in the registered QA editor window.")
        }
        let savedFrame = window.frame, savedDraft = model.assistantDraft, display = screen.visibleFrame
        let savedAssistantVisibility = UserDefaults.standard.object(forKey: "editor.layout.assistantVisible")
        let initialProject = try firstUseCanonical(project.fields), initialVersion = model.version
        var lastEditor: NSTextView?
        defer {
            let ownsSession = session.backend === backend && model.processingContextID == context
                && firstUseSession === session && firstUseWindow === window
            var nativeRestored = lastEditor == nil
            if ownsSession {
                if lastEditor != nil, let current = try? firstUseComposer(in: window, requireViewport: false) {
                    current.string = savedDraft
                    current.didChangeText()
                    nativeRestored = current.string == savedDraft
                }
                model.assistantDraft = savedDraft
                if let lastEditor, window.firstResponder === lastEditor { window.makeFirstResponder(nil) }
                window.setFrame(savedFrame, display: true)
                if let savedAssistantVisibility { UserDefaults.standard.set(savedAssistantVisibility, forKey: "editor.layout.assistantVisible") }
                else { UserDefaults.standard.removeObject(forKey: "editor.layout.assistantVisible") }
            }
            let currentVisibility = UserDefaults.standard.object(forKey: "editor.layout.assistantVisible")
            let preferenceRestored = savedAssistantVisibility == nil ? currentVisibility == nil
                : (savedAssistantVisibility as? NSObject)?.isEqual(currentVisibility) == true
            let frameRestored = abs(window.frame.minX - savedFrame.minX) <= 2 && abs(window.frame.minY - savedFrame.minY) <= 2
                && abs(window.frame.width - savedFrame.width) <= 2 && abs(window.frame.height - savedFrame.height) <= 2
            let modelRestored = ownsSession && model.assistantDraft == savedDraft
            firstUseComposerCleanup = ["sessionUnchanged": ownsSession, "nativeControlRestored": ownsSession && nativeRestored,
                "modelDraftRestored": modelRestored, "windowFrameRestored": ownsSession && frameRestored,
                "preferenceRestored": preferenceRestored,
                "restored": ownsSession && nativeRestored && modelRestored && frameRestored && preferenceRestored]
        }
        let wideWidth = min(1_440, display.width - 40)
        let wideHeight = min(900, display.height - 80)
        guard wideWidth >= 1_100, wideHeight >= 700 else {
            throw ReelBackend.APIError("The QA display is too small for the two native composer viewport checks.")
        }
        let sizes = [NSSize(width: wideWidth, height: wideHeight),
                     NSSize(width: max(960, wideWidth - 180), height: max(600, wideHeight - 120))]
        session.showPage("assistant")
        var observations: [[String: Any]] = []
        for (index, size) in sizes.enumerated() {
            try root.requireUnchanged()
            window.setContentSize(size)
            window.setFrameOrigin(NSPoint(x: display.midX - window.frame.width / 2, y: display.midY - window.frame.height / 2))
            var editor: NSTextView?
            try await firstUseWait("assistant viewport \(index + 1)", root: root, session: session, backend: backend, context: context) {
                guard firstUseWindow === window, let candidate = try firstUseComposer(in: window),
                      window.screen?.visibleFrame == display, display.contains(window.frame),
                      display.contains(window.convertToScreen(candidate.convert(candidate.visibleRect, to: nil))),
                      abs(content.bounds.width - size.width) <= 2,
                      abs(content.bounds.height - size.height) <= 2,
                      let scroll = candidate.enclosingScrollView,
                      candidate.visibleRect.width >= scroll.contentView.bounds.width - 4 else { return false }
                editor = candidate
                return true
            }
            guard let editor, editor.string == model.assistantDraft,
                  window.makeFirstResponder(editor), window.firstResponder === editor else {
                throw ReelBackend.APIError("The identified native composer did not accept text focus.")
            }
            lastEditor = editor
            let text = "Native composer QA \(index + 1)\nSpaces, 123, and another line stay in this draft."
            let clock = ContinuousClock(), started = clock.now
            editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
            try await firstUseWait("assistant draft \(index + 1)", root: root, session: session, backend: backend, context: context) {
                guard let current = try firstUseComposer(in: window) else { return false }
                return current.string == text && model.assistantDraft == text
            }
            let elapsed = started.duration(to: clock.now).components
            let seconds = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1_000_000_000_000_000_000
            guard seconds <= 1, model.version == initialVersion, let currentProject = model.project,
                  try firstUseCanonical(currentProject.fields) == initialProject, !session.assistant.isWorking else {
                throw ReelBackend.APIError("The native composer binding exceeded one second or changed the project or assistant run state.")
            }
            let composerRect = window.convertToScreen(editor.convert(editor.visibleRect, to: nil))
            guard window.screen?.visibleFrame == display, display.contains(window.frame), display.contains(composerRect) else {
                throw ReelBackend.APIError("The native composer or QA window moved outside the retained visible display.")
            }
            observations.append(["viewport": index + 1, "windowContentWidth": content.bounds.width,
                                 "windowContentHeight": content.bounds.height, "composerWidth": editor.visibleRect.width,
                                 "composerHeight": editor.visibleRect.height, "bindingSeconds": seconds,
                                 "bindingLimitSeconds": 1, "nativeInputMatchedDraft": true,
                                 "insideVisibleDisplay": true,
                                 "displayRect": [Double(display.minX), Double(display.minY), Double(display.width), Double(display.height)],
                                 "windowFrame": [Double(window.frame.minX), Double(window.frame.minY), Double(window.frame.width), Double(window.frame.height)],
                                 "composerScreenRect": [Double(composerRect.minX), Double(composerRect.minY), Double(composerRect.width), Double(composerRect.height)]])
        }
        guard let editor = try firstUseComposer(in: window), window.makeFirstResponder(editor) else {
            throw ReelBackend.APIError("The native composer disappeared before draft cleanup.")
        }
        lastEditor = editor
        editor.insertText(savedDraft, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
        try await firstUseWait("assistant draft cleanup", root: root, session: session, backend: backend, context: context) {
            guard let current = try firstUseComposer(in: window) else { return false }
            return current.string == savedDraft && model.assistantDraft == savedDraft
        }
        guard model.version == initialVersion, let finalProject = model.project,
              try firstUseCanonical(finalProject.fields) == initialProject else {
            throw ReelBackend.APIError("The assistant draft check changed the native project.")
        }
        try firstUseDiskMatches(root, finalProject)
        return ["nativeInputAccepted": true, "viewportChecks": observations, "draftRestored": true,
                "projectUnchanged": true, "sendActionInvoked": false, "visualAccepted": false,
                "keyboardAccepted": false]
    }

    private static func startFirstUse(_ session: EditorSession) {
        Task {
            var root: FirstUseRoot?
            var steps: [[String: Any]] = []
            var result: [String: Any] = ["ok": false, "nativeControllers": false, "functionalAccepted": false,
                "composerNativeInputAccepted": false,
                "visualAccepted": false, "pickerAccepted": false, "keyboardAccepted": false,
                "playbackAccepted": false, "exportAccepted": false]
            do {
                let args = CommandLine.arguments
                let conflicts = ["--open", "--automation", "--automation-out", "--native-smoke-out", "--quit-after-automation"]
                guard args.filter({ $0 == "--native-firstuse-root" }).count == 1,
                      !conflicts.contains(where: args.contains),
                      let path = Automation.value("--native-firstuse-root") else {
                    throw ReelBackend.APIError("Use --native-firstuse-root once, without other automation flags.")
                }
                let owned = try FirstUseRoot(path)
                root = owned
                let sourceBytes = try owned.sourceBytes()
                guard session.folder == nil, session.backend == nil, !session.useWebEditor,
                      session.error == nil else {
                    throw ReelBackend.APIError("First-use requires a fresh native Session with no open project.")
                }
                result["root"] = owned.url.path
                session.create(at: owned.project, width: 320, height: 180, fps: 6)
                guard let backend = session.backend else { throw ReelBackend.APIError(session.error ?? "Native create did not open its project.") }
                let model = session.nativeEditor, context = model.processingContextID
                try await firstUseWait("create", root: owned, session: session, backend: backend, context: context) {
                    model.project != nil && !model.capabilities.isEmpty && model.version >= 0
                }
                guard let created = model.project, created.width == 320, created.height == 180, created.fps == 6,
                      created.assets.isEmpty, created.tracks.flatMap(\.clips).isEmpty else {
                    throw ReelBackend.APIError("Native create did not produce the requested empty project.")
                }
                try firstUseDiskMatches(owned, created)
                steps.append(["step": "create", "version": model.version, "diskMatches": true])

                let importVersion = model.version
                session.importFiles([owned.source], expectedBackend: backend)
                try await firstUseWait("import", root: owned, session: session, backend: backend, context: context) {
                    model.version > importVersion && model.project?.assets.count == 1
                }
                guard let imported = model.project, let asset = imported.assets.first, asset.kind == "image",
                      asset.id.hasPrefix("media/"), try Data(contentsOf: model.mediaURL(asset.id)) == sourceBytes else {
                    throw ReelBackend.APIError("Native import did not retain the PNG bytes in project media.")
                }
                try firstUseDiskMatches(owned, imported)
                steps.append(["step": "import", "version": model.version, "asset": asset.id, "bytesEqual": true, "diskMatches": true])

                model.composition = nil; model.showingSource = false; model.panel = .edit
                let titleVersion = model.version
                model.edit(["op": "add_title", "text": "Your title", "start": 0, "dur": 5,
                            "title": ["size": min(model.width, model.height) * 0.09]])
                try await firstUseWait("add title", root: owned, session: session, backend: backend, context: context) {
                    model.version == titleVersion + 1 && model.project?.tracks.flatMap(\.clips).count == 1
                }
                guard let titleProject = model.project, let title = titleProject.tracks.flatMap(\.clips).first,
                      title.fields.dictionary("title").string("text") == "Your title" else {
                    throw ReelBackend.APIError("The native Add title operation did not produce an editable title.")
                }
                model.select(id: title.id)
                guard model.selectedID == title.id, model.selectedIDs == Set([title.id]) else {
                    throw ReelBackend.APIError("Native title selection did not reach the inspector model.")
                }
                try firstUseDiskMatches(owned, titleProject)
                let beforeEdit = try firstUseCanonical(titleProject.fields), editVersion = model.version
                steps.append(["step": "add title", "version": model.version, "titleID": title.id, "selected": true, "diskMatches": true])
                model.update(title, ["title": ["text": "Native first-use edited"]])
                try await firstUseWait("edit title", root: owned, session: session, backend: backend, context: context) {
                    model.version == editVersion + 1 && model.selected?.fields.dictionary("title").string("text") == "Native first-use edited"
                }
                guard let edited = model.project else { throw ReelBackend.APIError("The edited native project disappeared.") }
                try firstUseDiskMatches(owned, edited)
                let afterEdit = try firstUseCanonical(edited.fields), undoVersion = model.version
                steps.append(["step": "edit title", "version": model.version, "diskMatches": true])

                model.undo()
                try await firstUseWait("Undo", root: owned, session: session, backend: backend, context: context) {
                    guard let project = model.project else { return false }
                    guard model.version == undoVersion + 1 else { return false }
                    return try firstUseCanonical(project.fields) == beforeEdit
                }
                guard let undone = model.project else { throw ReelBackend.APIError("The undone native project disappeared.") }
                try firstUseDiskMatches(owned, undone)
                let redoVersion = model.version
                steps.append(["step": "Undo", "version": model.version, "exactProject": true, "diskMatches": true])
                model.undo(redo: true)
                try await firstUseWait("Redo", root: owned, session: session, backend: backend, context: context) {
                    guard let project = model.project else { return false }
                    guard model.version == redoVersion + 1 else { return false }
                    return try firstUseCanonical(project.fields) == afterEdit
                }
                guard let redone = model.project else { throw ReelBackend.APIError("The redone native project disappeared.") }
                try firstUseDiskMatches(owned, redone)
                steps.append(["step": "Redo", "version": model.version, "exactProject": true, "diskMatches": true])

                let clipVersion = model.version
                model.time = 0
                model.add(asset)
                try await firstUseWait("place imported media", root: owned, session: session, backend: backend, context: context) {
                    model.version == clipVersion + 1 && model.tracks.flatMap(\.clips).contains { $0.source == asset.id && $0.start == 0 }
                }
                guard let placed = model.project, placed.tracks.flatMap(\.clips).count == 2 else {
                    throw ReelBackend.APIError("Native media placement did not preserve the title and add one source clip.")
                }
                try firstUseDiskMatches(owned, placed)
                let saved = try firstUseCanonical(placed.fields)
                steps.append(["step": "place imported media", "version": model.version, "diskMatches": true])

                try owned.requireUnchanged()
                guard session.backend === backend, model.processingContextID == context else { throw CancellationError() }
                session.close()
                guard session.folder == nil, session.backend == nil, model.project == nil else {
                    throw ReelBackend.APIError("Native close retained the active document.")
                }
                var reopened: Result<Void, Error>?
                session.open(owned.project, completion: { reopened = $0 })
                guard let reopenedBackend = session.backend, reopenedBackend !== backend else {
                    throw ReelBackend.APIError("Native reopen did not create a fresh backend.")
                }
                let reopenedContext = model.processingContextID
                try await firstUseWait("reopen", root: owned, session: session, backend: reopenedBackend, context: reopenedContext) {
                    guard let outcome = reopened else { return false }
                    try outcome.get()
                    guard let project = model.project else { return false }
                    return (try firstUseCanonical(project.fields)) == saved
                }
                guard let final = model.project, try Data(contentsOf: model.mediaURL(asset.id)) == sourceBytes,
                      final.clip(title.id)?.fields.dictionary("title").string("text") == "Native first-use edited" else {
                    throw ReelBackend.APIError("Native reopen did not retain the imported bytes and edited title.")
                }
                try firstUseDiskMatches(owned, final)
                model.panel = .edit; model.select(id: title.id)
                steps.append(["step": "close and reopen", "version": model.version, "exactProject": true, "freshBackend": true, "bytesEqual": true, "diskMatches": true])
                result["composer"] = try await firstUseComposerCheck(session, root: owned, backend: reopenedBackend, context: reopenedContext)
                guard firstUseComposerCleanup?.flag("restored") == true else {
                    throw ReelBackend.APIError("The native composer cleanup could not verify restoration of its control, model, window and preference.")
                }
                result["composerNativeInputAccepted"] = true
                steps.append(["step": "assistant composer", "version": model.version, "nativeInputAccepted": true, "diskMatches": true])
                result["ok"] = true; result["nativeControllers"] = true
                result["functionalAccepted"] = true; result["project"] = owned.project.path
            } catch {
                result["error"] = error.localizedDescription
                if root == nil {
                    let failure = error as NSError
                    let receipt: [String: Any] = ["probe": "native-firstuse-admission", "ok": false,
                        "rootRetained": false, "errorDomain": failure.domain, "errorCode": failure.code]
                    if var line = try? JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]) {
                        line.append(10)
                        try? FileHandle.standardError.write(contentsOf: line)
                    }
                }
            }
            result["steps"] = steps
            if let firstUseComposerCleanup { result["composerCleanup"] = firstUseComposerCleanup }
            if let root {
                do {
                    try root.requireUnchanged()
                    try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .prettyPrinted])
                        .write(to: root.output, options: [.withoutOverwriting])
                } catch {
                    result["ok"] = false; result["functionalAccepted"] = false
                    result["resultWriteError"] = error.localizedDescription
                }
            }
            print(JSON(any: result).text)
        }
    }
    #endif

    private static func processing(_ model: NativeEditorModel, initial: String) async throws -> [String: Any] {
        guard let video = model.tracks.flatMap(\.clips).first(where: { $0.kind == "video" }),
              let audio = model.tracks.flatMap(\.clips).first(where: { $0.kind == "audio" }) else { throw ReelBackend.APIError("Processing smoke needs video and audio clips.") }
        let videoBytes = try Data(contentsOf: model.mediaURL(video.source)), audioBytes = try Data(contentsOf: model.mediaURL(audio.source))
        @MainActor func verifyProcessingUndo(path: String) async throws {
            guard let applied = model.project, let asset = applied.fields.dictionary("assets")[path],
                  var admitted = try JSON.parse(initial) as? [String: Any] else { throw ReelBackend.APIError("Processing did not register its reusable output.") }
            var assets = admitted.dictionary("assets")
            guard assets[path] == nil else { throw ReelBackend.APIError("Processing replaced an existing asset.") }
            assets[path] = asset; admitted["assets"] = assets
            _ = try await model.call("/api/undo", [:])
            guard model.project?.text == NativeProject(fields: admitted).text else { throw ReelBackend.APIError("Undoing processing placement did not restore the exact timeline while retaining its Media asset.") }
            _ = try await model.call("/api/undo", [:])
            guard model.project?.text == initial else { throw ReelBackend.APIError("Undoing processing admission did not restore the exact initial project.") }
            for _ in 0..<2 { _ = try await model.call("/api/redo", [:]) }
            guard model.project?.text == applied.text else { throw ReelBackend.APIError("Redoing processing admission and placement did not restore the exact applied project.") }
            for _ in 0..<2 { _ = try await model.call("/api/undo", [:]) }
            guard model.project?.text == initial else { throw ReelBackend.APIError("Repeated processing undo did not restore the exact initial project.") }
        }
        var recommendations: [String] = []
        for kind in ["noise", "stabilization", "audio-noise"] {
            let clip = kind == "audio-noise" ? audio : video
            let result = try await model.call("/api/analyze", ["kind": kind, "src": clip.source, "in": clip.fields.number("in"), "dur": min(30, clip.duration)])
            guard !result.dictionary("recommendation").isEmpty else { throw ReelBackend.APIError("Processing analysis returned no measured settings.") }
            recommendations.append(result.dictionary("recommendation").string("route"))
        }
        for (route, options) in [
            ("/api/video/denoise", ["quality": "fast", "strength": 0.5, "spatial": 0.4, "temporal": 0.4, "detail": 0.8, "sigma": 0.04, "codec": "auto"] as [String: Any]),
            ("/api/stabilize/render", ["smoothing": 0.3, "strength": 0.8, "model": "translation", "crop": "auto", "maxCrop": 0.1, "zoom": 1.05, "codec": "auto"] as [String: Any])
        ] {
            let body = NativeProcessingRequests.video(clip: video, project: model.project, fps: model.fps, comp: model.composition, options: options)
            let registered = try await model.call(route, body), id = registered.string("id")
            var job: [String: Any] = [:]
            for _ in 0..<12 { job = try await model.call(nativeQuery("/api/jobs/wait", ["id": id, "timeout": "10000"])); if job.string("state") != "running" { break } }
            guard job.string("state") == "done", job.flag("assetRegistered"), job.flag("applied") else { throw ReelBackend.APIError(job.string("error", job.string("applyError", "Processing did not register and apply its derived clip."))) }
            await model.refresh()
            guard model.project?.clip(video.id)?.source != video.source else { throw ReelBackend.APIError("Processing did not refresh the selected clip source.") }
            try await verifyProcessingUndo(path: job.string("output"))
        }
        let cleaned = try await model.call("/api/audio/clean", NativeProcessingRequests.audio(clip: audio, mode: "denoise", quality: "fast", strength: 0.4, detail: 0.8, noise: 0...0.1))
        guard !cleaned.string("path").isEmpty, cleaned.flag("assetRegistered"), cleaned.flag("applied"), model.project?.clip(audio.id)?.source != audio.source else { throw ReelBackend.APIError("Audio cleanup did not register and apply an editable source.") }
        try await verifyProcessingUndo(path: cleaned.string("path"))
        guard model.project?.text == initial,
              try Data(contentsOf: model.mediaURL(video.source)) == videoBytes,
              try Data(contentsOf: model.mediaURL(audio.source)) == audioBytes else { throw ReelBackend.APIError("Processing changed original files or did not undo exactly.") }
        return ["recommendations": recommendations, "denoiseApplied": true, "stabilizationApplied": true, "audioCleanApplied": true, "placementUndoExact": true, "admissionUndoExact": true, "redoExact": true, "originalsUnchanged": true]
    }
}
#endif
