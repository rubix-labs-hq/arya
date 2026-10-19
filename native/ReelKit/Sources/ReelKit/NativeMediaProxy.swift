import AVFoundation
import CryptoKit
import Foundation

public enum NativeMediaProxy {
    public static func create(source: URL, folder: ProjectFolder) async throws -> URL {
        let directory=try folder.output(folder.cacheDir.path)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        _=try folder.output(directory.path)
        let attributes=try FileManager.default.attributesOfItem(atPath:source.path)
        let key=source.path+"|\(attributes[.size] ?? 0)|\(attributes[.modificationDate] ?? "")|640x480-v1"
        let hash=SHA256.hash(data:Data(key.utf8)).map { String(format:"%02x",$0) }.joined()
        let output=try folder.output(directory.appendingPathComponent("proxy-\(hash).mp4").path)
        if FileManager.default.fileExists(atPath:output.path) { return output }
        let temporary=try folder.output(directory.appendingPathComponent("proxy-\(UUID().uuidString).mp4").path)
        defer { if let checked=try? folder.output(temporary.path) { try? FileManager.default.removeItem(at:checked) } }
        let asset=AVURLAsset(url:source)
        guard !(try await asset.loadTracks(withMediaType:.video)).isEmpty,let exporter=AVAssetExportSession(asset:asset,presetName:AVAssetExportPreset640x480) else { throw ReelBackend.APIError("This source cannot make a video proxy.") }
        exporter.outputURL=temporary; exporter.outputFileType = .mp4; exporter.shouldOptimizeForNetworkUse=true
        try await withTaskCancellationHandler { await withCheckedContinuation { continuation in exporter.exportAsynchronously { continuation.resume() } }; try Task.checkCancellation(); guard exporter.status == .completed else { throw exporter.error ?? ReelBackend.APIError("Proxy export failed.") } } onCancel: { exporter.cancelExport() }
        _=try folder.output(output.path); _=try folder.output(temporary.path)
        if !FileManager.default.fileExists(atPath:output.path) { try FileManager.default.moveItem(at:temporary,to:output) }
        return output
    }
}
