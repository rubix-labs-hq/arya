import AVFoundation
import Foundation
import JavaScriptCore
import Darwin

/// Original structured scores synthesized by the same bounded DSP as the browser backend.
/// Each worker creates and owns its own JSC VM; the shared project-core actor is untouched.
/// Rendering is not publication: the backend registers the verified result in Media before
/// an independently guarded placement. Undo placement retains its owned WAV and score.
public enum NativeMusicComposer {
    public struct Rendered: Sendable {
        public let path: String
        public let scoreJSON: String
        public let measurementJSON: String
        public let assetJSON: String
        public let frames: Int
        public let identity: NativeMusicIdentity.Snapshot

        /// Receipt accepted by the shared placement validator. A generated Media record is
        /// created only by those normal project operations after valid render+probe.
        public var receiptJSON: String {
            "{\"path\":\(JSON.string(path).text),\"score\":\(scoreJSON),\"measurement\":\(measurementJSON),\"asset\":\(assetJSON),\"contentSHA256\":\(JSON(any: identity.contentSHA256).text)}"
        }
    }
    public struct Failure: Error, LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
    }

    public static func render(folder: ProjectFolder, scoreJSON: String, scriptURL: URL) async throws -> Rendered {
        try Task.checkCancellation()
        let source = try String(contentsOf: scriptURL, encoding: .utf8)
        let worker = Task.detached(priority: .userInitiated) {
            try renderSync(folder: folder, scoreJSON: scoreJSON, script: source)
        }
        return try await withTaskCancellationHandler(operation: { try await worker.value }, onCancel: { worker.cancel() })
    }

    /// Cheap data-only placement admission. Invoke on the backend before creating a worker,
    /// and again with its completed receipt before expectedVersion-guarded editOperations.
    public static func placementOps(projectJSON: String, bodyJSON: String, receiptJSON: String? = nil, script: String) throws -> String {
        let engine = try Engine(script: script)
        return try engine.string("placementOpsJSON", [projectJSON, bodyJSON, receiptJSON ?? ""])
    }
    public static func assetRecord(rendered: Rendered, script: String) throws -> String {
        try Engine(script: script).string("assetRecordJSON", [rendered.scoreJSON, rendered.receiptJSON])
    }

    public static func importDecision(existingJSON: String, probedJSON: String, identity: NativeMusicIdentity.Snapshot?, script: String) throws -> String {
        try Engine(script: script).string("importDecisionJSON", [existingJSON, probedJSON, identity?.json ?? ""])
    }
    public static func isGeneratedAsset(_ asset: [String: Any]) -> Bool {
        guard let generated = asset["generated"] as? [String: Any] else { return false }
        return generated["kind"] as? String == "original-music" && generated["renderer"] as? String == "arya-score-synth/1"
    }
    public static func hasByteIdentity(_ asset: [String: Any]) -> Bool {
        guard isGeneratedAsset(asset), let generated = asset["generated"] as? [String: Any], let digest = generated["contentSHA256"] as? String else { return false }
        return digest.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil
    }

    /// Re-probe a retained result before retry, without regenerating or reading other assets.
    public static func probeOwnedWAV(folder: ProjectFolder, path: String, frames: Int) throws -> String {
        try Task.checkCancellation()
        guard frames > 0, frames <= 2_880_000,
              path.range(of: #"^media/generated/music/[0-9a-f-]{36}/score\.wav$"#, options: .regularExpression) != nil else { throw Failure(message: "Invalid owned music output") }
        let final = try folder.output(path), file = try AVAudioFile(forReading: final)
        let size = (try FileManager.default.attributesOfItem(atPath: final.path)[.size] as? NSNumber)?.int64Value
        let format = file.fileFormat.streamDescription.pointee
        guard size == Int64(44 + frames * 6), file.length == AVAudioFramePosition(frames), format.mSampleRate == 48000, format.mChannelsPerFrame == 2,
              format.mFormatID == kAudioFormatLinearPCM, format.mBitsPerChannel == 24, format.mBytesPerFrame == 6,
              format.mFormatFlags & kAudioFormatFlagIsFloat == 0, format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
              format.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0 else { throw Failure(message: "Synthesized WAV failed its stereo PCM24 probe") }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4096) else { throw Failure(message: "Cannot decode synthesized audio") }
        try file.read(into: buffer)
        guard buffer.frameLength > 0 else { throw Failure(message: "Synthesized audio is unreadable") }
        try Task.checkCancellation()
        return JSON(any: ["duration": Double(frames) / 48000, "hasAudio": true, "hasVideo": false, "channels": 2, "sampleRate": 48000, "codec": "pcm_s24le", "size": Int64(44 + frames * 6)]).text
    }

    /// Backend calls this only on failed/stale publication. Registered assets and Undo's
    /// retained files must never be removed. No caller-selected output or recursive cleanup.
    public static func discard(folder: ProjectFolder, rendered: Rendered, registered: Bool) throws {
        guard !registered else { return }
        let path = rendered.path
        guard path.range(of: #"^media/generated/music/[0-9a-f-]{36}/score\.wav$"#, options: .regularExpression) != nil else { throw Failure(message: "Invalid owned music output") }
        try FileManager.default.removeItem(at: folder.output(path))
        let dir = try folder.output((path as NSString).deletingLastPathComponent)
        _ = Darwin.rmdir(dir.path) // fails safely if someone added another file
    }

    private static func renderSync(folder: ProjectFolder, scoreJSON: String, script: String) throws -> Rendered {
        try Task.checkCancellation()
        let engine = try Engine(script: script)
        let meta = try engine.dictionary("startJSON", [scoreJSON])
        guard let frames = meta["frames"] as? Int, frames > 0, frames <= 2_880_000,
              let score = meta["score"], (meta["sampleRate"] as? Int) == 48000,
              (meta["channels"] as? Int) == 2 else { throw Failure(message: "Invalid synthesized score metadata") }
        let normalizedScore = JSON(any: score).text
        var measurement: [String: Any]?
        while measurement == nil {
            try Task.checkCancellation()
            let m = try engine.dictionary("measureNextJSON", [])
            if (m["done"] as? Bool) == true { measurement = m["measurement"] as? [String: Any] }
            // The bridge returns done=true only once the complete first pass was measured.
            if (m["done"] as? Bool) == true && measurement == nil { throw Failure(message: "Score measurement failed") }
        }
        try Task.checkCancellation()
        let relDir = "media/generated/music/\(UUID().uuidString.lowercased())"
        let path = "\(relDir)/score.wav"
        let dir = try folder.output(relDir), partial = try folder.output("\(relDir)/score.part.wav")
        let fm = FileManager.default
        try fm.createDirectory(at: try folder.output("media/generated/music"), withIntermediateDirectories: true)
        _ = try folder.output(relDir)
        try fm.createDirectory(at: dir, withIntermediateDirectories: false)
        var handle: FileHandle?, published = false, succeeded = false
        defer {
            try? handle?.close()
            if !succeeded {
                if let safe = try? folder.output("\(relDir)/score.part.wav") { try? fm.removeItem(at: safe) }
                if published, let safe = try? folder.output(path) { try? fm.removeItem(at: safe) }
                // Never recursively remove arbitrary user content in the owned namespace.
                _ = Darwin.rmdir(dir.path)
            }
        }
        let descriptor = Darwin.open(try folder.output("\(relDir)/score.part.wav").path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw Failure(message: "Cannot exclusively create music output") }
        handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        try handle?.write(contentsOf: engine.bytes("headerBase64"))
        while true {
            try Task.checkCancellation()
            let bytes = try engine.bytes("nextPCMBase64")
            if bytes.isEmpty { break }
            try handle?.write(contentsOf: bytes)
        }
        try Task.checkCancellation()
        try handle?.synchronize(); try handle?.close(); handle = nil
        _ = try folder.output("\(relDir)/score.part.wav")
        let size = (try fm.attributesOfItem(atPath: partial.path)[.size] as? NSNumber)?.int64Value
        guard size == Int64(44 + frames * 6) else { throw Failure(message: "Synthesized WAV is incomplete") }
        try fm.linkItem(at: partial, to: try folder.output(path)) // refuses existing destination
        published = true; try fm.removeItem(at: partial)
        let asset = try probeOwnedWAV(folder: folder, path: path, frames: frames)
        let identity = try NativeMusicIdentity.readSync(folder: folder, path: path)
        succeeded = true
        return Rendered(path: path, scoreJSON: normalizedScore, measurementJSON: JSON(any: measurement!).text, assetJSON: asset, frames: frames, identity: identity)
    }

    private final class Engine {
        let context: JSContext
        let bridge: JSValue
        init(script: String) throws {
            guard let ctx = JSContext() else { throw Failure(message: "JavaScriptCore is unavailable") }
            ctx.name = "Arya original score worker"; ctx.evaluateScript(script)
            if let exception = ctx.exception { throw Failure(message: "Music renderer failed to load: \(exception)") }
            guard let value = ctx.objectForKeyedSubscript("AryaMusic"), value.isObject else { throw Failure(message: "Music renderer is unavailable") }
            context = ctx; bridge = value
        }
        func string(_ method: String, _ args: [Any]) throws -> String {
            context.exception = nil
            guard let value = bridge.invokeMethod(method, withArguments: args) else { throw Failure(message: "Music renderer returned nothing") }
            if let exception = context.exception { throw Failure(message: exception.toString() ?? "Music renderer failed") }
            guard let result = value.toString() else { throw Failure(message: "Invalid music renderer response") }
            return result
        }
        func dictionary(_ method: String, _ args: [Any]) throws -> [String: Any] {
            guard let value = try JSON.parse(string(method, args)) as? [String: Any] else { throw Failure(message: "Invalid music renderer metadata") }
            return value
        }
        func bytes(_ method: String) throws -> Data {
            guard let data = Data(base64Encoded: try string(method, [])) else { throw Failure(message: "Invalid rendered music chunk") }
            return data
        }
    }
}
