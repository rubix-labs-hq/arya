import AVFoundation
import CryptoKit
import Foundation
import Speech

/// Speech recognition uses bounded PCM windows. Audio stays on device unless explicitly allowed.
public enum Transcriber {
    public struct Failed: Error, LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
    }
    public struct Word: Sendable {
        public let t: Double, end: Double, text: String, confidence: Double
        public init(t: Double, end: Double, text: String, confidence: Double = 1) { self.t=t; self.end=end; self.text=text; self.confidence=confidence }
    }
    public struct Segment: Sendable {
        public let words: [Word], partial: Bool, warning: String?
        public init(words: [Word], partial: Bool = false, warning: String? = nil) { self.words=words; self.partial=partial; self.warning=warning }
    }
    struct Window: Sendable { let from: Double, to: Double, keepFrom: Double, keepTo: Double }
    typealias WindowRecognizer = @Sendable (URL, Double, Double) async throws -> Segment
    typealias AuthorizationCallback = @Sendable (SFSpeechRecognizerAuthorizationStatus) -> Void
    typealias AuthorizationRequest = @Sendable (@escaping AuthorizationCallback) -> Void

    public static func availability(locale: Locale = .current) -> (available: Bool, onDevice: Bool, authorized: Bool) {
        let recognizer = SFSpeechRecognizer(locale: locale)
        return (recognizer?.isAvailable ?? false, recognizer?.supportsOnDeviceRecognition ?? false, SFSpeechRecognizer.authorizationStatus() == .authorized)
    }
    public static var locales: [String] { SFSpeechRecognizer.supportedLocales().map(\.identifier).sorted() }

    static func authorize() async throws {
        try Task.checkCancellation()
        var status = SFSpeechRecognizer.authorizationStatus()
        if status == .notDetermined {
            status = try await requestAuthorization()
        }
        try Task.checkCancellation()
        switch status {
        case .authorized: return
        case .denied: throw Failed(message: "Speech recognition is turned off for Reel. Turn it on in System Settings > Privacy & Security > Speech Recognition.")
        case .restricted: throw Failed(message: "Speech recognition is restricted on this device.")
        default: throw Failed(message: "Speech recognition was not allowed.")
        }
    }

    static func requestAuthorization(timeout: Double = 120, request: AuthorizationRequest = { reply in
        SFSpeechRecognizer.requestAuthorization { reply($0) }
    }) async throws -> SFSpeechRecognizerAuthorizationStatus {
        let gate = SpeechAuthorizationCompletion()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                gate.install(continuation)
                guard !gate.finished else { return }
                gate.scheduleTimeout(seconds: timeout)
                request { gate.complete(.success($0)) }
            }
        } onCancel: { gate.complete(.failure(CancellationError())) }
    }

    static func windows(duration: Double) throws -> [Window] {
        guard duration.isFinite, duration > 0, duration <= 14_400 else { throw Failed(message: "Transcription supports recordings up to four hours.") }
        return stride(from: 0.0, to: duration, by: 45).map { start in
            Window(from: max(0,start-0.5), to: min(duration,start+45.5), keepFrom: start, keepTo: min(duration,start+45))
        }
    }

    public static func transcribe(file: URL, cacheDir: URL, locale: Locale = .current, allowServer: Bool = false, projectFolder: ProjectFolder? = nil, force: Bool = false, progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> JSON {
        try Task.checkCancellation()
        let folder = projectFolder ?? ProjectFolder(root: cacheDir.deletingLastPathComponent().deletingLastPathComponent())
        let source = try NativeTranscriptStore.sourceIdentity(file.path, folder: folder)
        let out = try cacheFile(source: source, cacheDir: cacheDir, locale: locale, allowServer: allowServer, folder: folder)
        if let cached = try readCachedTranscript(out: out, file: file, source: source, locale: locale, force: force, folder: folder) { return cached }
        try await authorize()
        try checkSource(file: file, source: source, folder: folder)
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else { throw Failed(message: "Speech recognition is unavailable for \(locale.identifier).") }
        let onDevice = recognizer.supportsOnDeviceRecognition
        guard onDevice || allowServer else { throw Failed(message: "On-device recognition is unavailable for this language. Allow Apple server recognition explicitly to send this audio for transcription.") }
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1; recognizer.queue = queue
        let duration = try await AVURLAsset(url: source.file).load(.duration).seconds
        let result = try await transcribeWindows(file: source.file, duration: duration, locale: locale.identifier, onDevice: onDevice, progress: progress) { source, from, length in
            let samples = try await monoSamples(file: source, rate: 16000, from: from, duration: length)
            return try await recognize(samples, rate: 16000, recognizer: recognizer, onDevice: onDevice)
        }
        return try publish(result, to: out, file: file, source: source, folder: folder)
    }

    static func readCachedTranscript(out: URL, file: URL, source: NativeTranscriptStore.SourceIdentity, locale: Locale, force: Bool, folder: ProjectFolder) throws -> JSON? {
        guard !force, FileManager.default.fileExists(atPath: out.path) else { return nil }
        let size = (try FileManager.default.attributesOfItem(atPath: out.path)[.size] as? NSNumber)?.intValue ?? 0
        guard size <= 16 * 1024 * 1024 else { throw Failed(message: "The cached transcript is larger than 16 MB.") }
        let fields = try JSON.parse(String(contentsOf: folder.output(out.path), encoding: .utf8)) as? [String: Any] ?? [:]
        _ = try NativeTranscriptStore.validate(fields["words"])
        if fields["locale"] as? String == locale.identifier {
            try checkSource(file: file, source: source, folder: folder)
            return JSON(any: fields)
        }
        return nil
    }

    static func publish(_ result: JSON, to out: URL, file: URL, source: NativeTranscriptStore.SourceIdentity, folder: ProjectFolder) throws -> JSON {
        try checkSource(file: file, source: source, folder: folder)
        let fields = try JSON.parse(result.text) as? [String: Any] ?? [:]
        // A partial result remains inspectable but never becomes a complete cache hit.
        if fields["status"] as? String == "complete" {
            try FileManager.default.createDirectory(at: folder.output(out.deletingLastPathComponent().path), withIntermediateDirectories: true)
            try checkSource(file: file, source: source, folder: folder)
            try Data(result.text.utf8).write(to: folder.output(out.path), options: .atomic)
        }
        return result
    }

    static func cacheFile(file: URL, cacheDir: URL, locale: Locale, allowServer: Bool, folder: ProjectFolder) throws -> URL {
        let source = try NativeTranscriptStore.sourceIdentity(file.path, folder: folder)
        return try cacheFile(source: source, cacheDir: cacheDir, locale: locale, allowServer: allowServer, folder: folder)
    }

    private static func cacheFile(source: NativeTranscriptStore.SourceIdentity, cacheDir: URL, locale: Locale, allowServer: Bool, folder: ProjectFolder) throws -> URL {
        let parts = [source.file.path, source.fingerprint, "speech-v3", locale.identifier, allowServer ? "server-allowed" : "on-device"]
        let digest = Insecure.SHA1.hash(data: Data(JSON(any: parts).text.utf8)).map { String(format: "%02x", $0) }.joined()
        let key = String(digest.prefix(16))
        return try folder.output(cacheDir.appendingPathComponent(key).appendingPathComponent("transcript.json").path)
    }

    private static func checkSource(file: URL, source: NativeTranscriptStore.SourceIdentity, folder: ProjectFolder) throws {
        try Task.checkCancellation()
        guard source == (try NativeTranscriptStore.sourceIdentity(file.path, folder: folder)) else { throw Failed(message: "The source changed while transcription ran.") }
    }

    static func transcribeWindows(file: URL, duration: Double, locale: String, onDevice: Bool, progress: @escaping @Sendable (Double) -> Void = { _ in }, recognize: WindowRecognizer) async throws -> JSON {
        let ranges = try windows(duration: duration)
        var words: [JSON] = [], warnings: [String] = [], completed = 0
        for window in ranges {
            try Task.checkCancellation()
            do {
                let segment = try await recognize(file, window.from, window.to-window.from)
                try Task.checkCancellation()
                for w in segment.words {
                    let t = window.from+w.t, end = min(duration,window.from+w.end), mid = (t+end)/2
                    guard mid >= window.keepFrom, mid < window.keepTo, end > t else { continue }
                    words.append(.object([("t", .number((t*1000).rounded()/1000)), ("end", .number((end*1000).rounded()/1000)), ("text", .string(w.text)), ("confidence", .number(w.confidence))]))
                }
                guard words.count <= 100_000 else { throw Failed(message: "The transcript exceeds 100000 words.") }
                completed += 1
                if segment.partial { warnings.append(segment.warning ?? "A recognition window returned partial words.") }
                progress(Double(completed)/Double(ranges.count))
            } catch {
                try Task.checkCancellation()
                if words.isEmpty { throw error }
                warnings.append("Recognition stopped at \(Int(window.keepFrom)) seconds: \(error.localizedDescription)")
                break
            }
        }
        return .object([("kind", "transcript"), ("locale", .string(locale)), ("words", .array(words)), ("onDevice", .bool(onDevice)), ("status", .string(warnings.isEmpty ? "complete" : "partial")), ("warnings", .array(warnings.map(JSON.string))), ("completedWindows", .int(completed)), ("totalWindows", .int(ranges.count))])
    }

    static func monoSamples(file: URL, rate: Double, from: Double, duration: Double) async throws -> [Float] {
        guard duration > 0, duration <= 46.001 else { throw Failed(message: "The recognition window exceeds 46 seconds.") }
        var out: [Float] = []
        let range = CMTimeRange(start: CMTime(seconds: from, preferredTimescale: 600000), duration: CMTime(seconds: duration, preferredTimescale: 600000))
        try await MediaDerivatives.readPCM(file: file, sampleRate: rate, channels: 1, range: range) { chunk in
            try Task.checkCancellation()
            guard out.count+chunk.count <= Int(ceil(46.1*rate)) else { throw Failed(message: "The decoded recognition window exceeds its memory bound.") }
            out.append(contentsOf: chunk.map { Float($0)/32768 })
        }
        try Task.checkCancellation()
        return out
    }

    static func recognize(_ samples: [Float], rate: Double, recognizer: SFSpeechRecognizer, onDevice: Bool, timeout: Double = 90) async throws -> Segment {
        guard !samples.isEmpty else { return .init(words: []) }
        let gate = SpeechCompletion()
        let result: Result<Segment, Error>
        do {
            result = .success(try await withTaskCancellationHandler {
                try Task.checkCancellation()
                return try await withCheckedThrowingContinuation { continuation in
                    gate.install(continuation)
                    let request = SFSpeechAudioBufferRecognitionRequest()
                    request.shouldReportPartialResults = true; request.requiresOnDeviceRecognition = onDevice; request.taskHint = .dictation
                    let task = recognizer.recognitionTask(with: request) { result, error in
                        if let result { gate.setWords(result.bestTranscription.segments.filter { !$0.substring.isEmpty }.map { .init(t: $0.timestamp, end: $0.timestamp+$0.duration, text: $0.substring, confidence: Double($0.confidence)) }) }
                        if let error {
                            let ns = error as NSError
                            if ns.domain == "kAFAssistantErrorDomain", ns.code == 1110 { gate.complete(.success(.init(words: []))) }
                            else { gate.finishPartialOrError("Speech recognition failed: \(error.localizedDescription)") }
                        } else if result?.isFinal == true { gate.finishWords() }
                    }
                    gate.setTask(task, request: request)
                    gate.scheduleTimeout(seconds: timeout)
                    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false) else { gate.complete(.failure(Failed(message: "Cannot create the speech PCM format."))); return }
                    for i in stride(from: 0, to: samples.count, by: Int(rate)) {
                        if Task.isCancelled { gate.cancel(); break }
                        if gate.finished { break }
                        let n = min(Int(rate),samples.count-i)
                        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n)) else { gate.finishPartialOrError("Cannot allocate a speech PCM buffer."); break }
                        buffer.frameLength = AVAudioFrameCount(n)
                        samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!+i, count: n) }
                        request.append(buffer)
                    }
                    request.endAudio()
                }
            } onCancel: { gate.cancel() })
        } catch { result = .failure(error) }
        await gate.waitUntilStopped()
        return try result.get()
    }
}

final class SpeechAuthorizationCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Error>?
    private var result: Result<SFSpeechRecognizerAuthorizationStatus, Error>?
    private var timeout: DispatchWorkItem?
    var finished: Bool { lock.lock(); defer { lock.unlock() }; return result != nil }
    func install(_ value: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Error>) {
        lock.lock(); let ready = result; if ready == nil { continuation = value }; lock.unlock()
        if let ready { value.resume(with: ready) }
    }
    func scheduleTimeout(seconds: Double) {
        let work = DispatchWorkItem { [weak self] in
            self?.complete(.failure(Transcriber.Failed(message: "Speech permission request timed out. Respond to the permission prompt or check System Settings > Privacy & Security > Speech Recognition, then try again.")))
        }
        lock.lock(); let done = result != nil; if !done { timeout = work }; lock.unlock()
        if !done { DispatchQueue.global().asyncAfter(deadline: .now() + max(0.01, seconds), execute: work) }
    }
    func complete(_ value: Result<SFSpeechRecognizerAuthorizationStatus, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value; let cont = continuation; continuation = nil; let timer = timeout; timeout = nil
        lock.unlock()
        timer?.cancel(); cont?.resume(with: value)
    }
}

/// Serializes task completion, timeout and cancellation, including cancellation before registration.
final class SpeechCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Transcriber.Segment, Error>?
    private var result: Result<Transcriber.Segment, Error>?
    private var words: [Transcriber.Word] = []
    private var task: SFSpeechRecognitionTask?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var timeout: DispatchWorkItem?
    var finished: Bool { lock.lock(); defer { lock.unlock() }; return result != nil }
    func install(_ value: CheckedContinuation<Transcriber.Segment, Error>) {
        lock.lock(); let ready = result; if ready == nil { continuation=value }; lock.unlock()
        if let ready { value.resume(with: ready) }
    }
    func setWords(_ value: [Transcriber.Word]) { lock.lock(); if result == nil { words=value }; lock.unlock() }
    func setTask(_ value: SFSpeechRecognitionTask, request: SFSpeechAudioBufferRecognitionRequest) {
        lock.lock(); let done=result != nil; task=value; if !done { self.request=request }; lock.unlock()
        if done { request.endAudio(); value.cancel() }
    }
    func scheduleTimeout(seconds: Double) {
        let work = DispatchWorkItem { [weak self] in self?.finishPartialOrError("Speech recognition timed out.") }
        lock.lock(); let done=result != nil; if !done { timeout=work }; lock.unlock()
        if !done { DispatchQueue.global().asyncAfter(deadline: .now()+max(0.01,seconds), execute: work) }
    }
    func finishWords() { lock.lock(); let copy=words; lock.unlock(); complete(.success(.init(words: copy))) }
    func finishPartialOrError(_ warning: String) {
        lock.lock(); let copy=words; lock.unlock()
        complete(copy.isEmpty ? .failure(Transcriber.Failed(message: warning)) : .success(.init(words: copy, partial: true, warning: warning)))
    }
    func cancel() { complete(.failure(CancellationError())) }
    /// Speech cancellation is a request. Keep the OS task alive and hold admission
    /// until its terminal state, including after final words or timeout callbacks.
    func waitUntilStopped() async {
        let active = retainedTask()
        if let active { await NativeWorkerDrain.untilStopped { active.state == .completed } }
        releaseTask()
    }
    private func releaseTask() { lock.lock(); task = nil; lock.unlock() }
    private func retainedTask() -> SFSpeechRecognitionTask? { lock.lock(); defer { lock.unlock() }; return task }
    func complete(_ value: Result<Transcriber.Segment, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result=value; let cont=continuation; continuation=nil; let active=task; let audio=request; request=nil; let timer=timeout; timeout=nil
        lock.unlock()
        timer?.cancel(); audio?.endAudio(); active?.cancel(); cont?.resume(with: value)
    }
}
