import Foundation
import Darwin
import XCTest
@testable import ReelKit

final class NativeExportAudioCacheTests: XCTestCase {
    func testExportAudioIgnoresPreviewDerivativeAfterSameMetadataSourceEdit() async throws {
        let root = try Support.tempFolder("export-audio-cache")
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = ProjectFolder(root: root), source = root.appendingPathComponent("source.wav")
        let oldPCM = NativeAudioProcessing.PCM(channels: [Array(repeating: Float(0.1), count: 48000), Array(repeating: Float(0.1), count: 48000)], rate: 48000)
        try NativeAudioProcessing.write(oldPCM, to: source)
        let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
        var originalMetadata = Darwin.stat()
        guard source.path.withCString({ Darwin.lstat($0, &originalMetadata) }) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        let oldDerivative = try await MediaDerivatives.audioRange(file: source, from: 0, dur: 1, cacheDir: folder.cacheDir, projectFolder: folder)
        let oldBytes = try Data(contentsOf: oldDerivative)
        let newPCM = NativeAudioProcessing.PCM(channels: [Array(repeating: Float(0.6), count: 48000), Array(repeating: Float(0.6), count: 48000)], rate: 48000)
        try NativeAudioProcessing.write(newPCM, to: source)
        // Restore exact filesystem timestamps. Foundation Date restoration can round
        // nanoseconds and change the preview cache key this fixture must preserve.
        var times = [originalMetadata.st_atimespec, originalMetadata.st_mtimespec]
        let restored = times.withUnsafeMutableBufferPointer { values in
            source.path.withCString { Darwin.utimensat(AT_FDCWD, $0, values.baseAddress, 0) }
        }
        guard restored == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        var restoredMetadata = Darwin.stat()
        guard source.path.withCString({ Darwin.lstat($0, &restoredMetadata) }) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        XCTAssertEqual(restoredMetadata.st_mtimespec.tv_sec, originalMetadata.st_mtimespec.tv_sec)
        XCTAssertEqual(restoredMetadata.st_mtimespec.tv_nsec, originalMetadata.st_mtimespec.tv_nsec)
        let newAttributes = try FileManager.default.attributesOfItem(atPath: source.path)
        XCTAssertEqual(newAttributes[.size] as? NSNumber, attributes[.size] as? NSNumber)
        // Characterize the unchanged preview key before exercising the export-owned key.
        let preview = try await MediaDerivatives.audioRange(file: source, from: 0, dur: 1, cacheDir: folder.cacheDir, projectFolder: folder)
        XCTAssertEqual(preview, oldDerivative)
        XCTAssertEqual(try Data(contentsOf: preview), oldBytes)
        let sourceBytes = try Data(contentsOf: source)
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), processingAdmission: .init(), events: { _, _ in })
        try await backend.start()
        do {
            _ = try await backend.handle(method: "POST", path: "/api/new", body: #"{"name":"Owned cache fixture","width":64,"height":64,"fps":1}"#)
            _ = try await backend.editOperations(ops: JSON(any: [["op": "import", "assets": ["source.wav": ["assetKind": "audio", "duration": 1, "hasAudio": true, "channels": 2]]]]))
            let reply = try await backend.handle(method: "POST", path: "/api/export", body: #"{"renderer":"webcodecs","preset":"audio-wav","name":"Owned","range":{"in":0,"out":1}}"#)
            let job = parse(reply.text), id = try XCTUnwrap(job["id"] as? String)
            var admitted = false
            for _ in 0..<500 {
                let response = try await backend.handle(method: "POST", path: "/api/export/progress", body: JSON(any: ["id": id]).text)
                let fields = parse(response.text)
                if fields["state"] as? String == "running" { admitted = true; break }
                if fields["cancelled"] as? Bool == true { throw ReelBackend.APIError("Fixture export failed before admission") }
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertTrue(admitted)
            let result = try await backend.resource(path: "/api/audio", query: ["src": "source.wav", "in": "0", "dur": "1", "processingJob": id])
            guard case let .file(output, _) = try XCTUnwrap(result) else { throw ReelBackend.APIError("Fixture export audio did not return a file") }
            XCTAssertNotEqual(output, oldDerivative)
            let decoded = try await NativeAudioProcessing.decode(output)
            XCTAssertEqual(decoded.channels[0][24000], 0.6, accuracy: 0.01)
            XCTAssertEqual(try Data(contentsOf: oldDerivative), oldBytes)
            XCTAssertEqual(try Data(contentsOf: source), sourceBytes)
            _ = try await backend.handle(method: "POST", path: "/api/export/finish", body: JSON(any: ["id": id, "error": "The fixture completed its audio check.", "drained": true]).text)
            await backend.stop(); await backend.pageProcessingWorkersExited()
        } catch { await backend.stop(); await backend.pageProcessingWorkersExited(); throw error }
    }
}
