import CryptoKit
import Darwin
import Foundation
@testable import ReelKit
import XCTest

final class NativeAudioPreviewReuseSourceTests: XCTestCase {
    private func captured(_ alias: String, folder: ProjectFolder) throws -> NativeAudioMixCapture.Source {
        let path = try folder.resolve(alias).path
        return .init(alias: alias, path: path, stamp: try NativeAudioMixCapture.fileStamp(path))
    }
    func testSourceByteDigestAndAliasIdentityBothInvalidateRetainedAudio() throws {
        let folder = ProjectFolder(root: try Support.tempFolder("preview-reuse-source-identities"))
        defer { try? FileManager.default.removeItem(at: folder.root.deletingLastPathComponent()) }
        let a = folder.root.appendingPathComponent("a.wav"), b = folder.root.appendingPathComponent("b.wav"), link = folder.root.appendingPathComponent("alias.wav")
        let bytes = Data(repeating: 7, count: 65536)
        try bytes.write(to: a); try Data(repeating: 9, count: bytes.count).write(to: b)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: a)
        let original = try NativeAudioPreviewReuse.sourceIdentities([captured("alias.wav", folder: folder)], folder: folder)
        XCTAssertEqual(original[0].digest, SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
        try FileManager.default.removeItem(at: link)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: b)
        let changed = try NativeAudioPreviewReuse.sourceIdentities(NativeAudioPreviewReuse.freshSources(original, folder: folder), folder: folder)
        XCTAssertNotEqual(changed, original)
        XCTAssertNotEqual(changed[0].source.path, original[0].source.path)
        XCTAssertNotEqual(changed[0].digest, original[0].digest)
        XCTAssertThrowsError(try NativeAudioPreviewReuse.sourceIdentities(original.map(\.source), folder: folder))
    }

    func testMutationAfterDescriptorValidationCannotPublishAnAcceptedHash() throws {
        let folder = ProjectFolder(root: try Support.tempFolder("preview-reuse-hash-mutation"))
        defer { try? FileManager.default.removeItem(at: folder.root.deletingLastPathComponent()) }
        let url = folder.root.appendingPathComponent("source.wav")
        try Data(repeating: 7, count: 65536).write(to: url)
        let source = try captured("source.wav", folder: folder)
        XCTAssertThrowsError(try NativeAudioPreviewReuse.sourceIdentities([source], folder: folder, afterDescriptorValidation: {
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.write(contentsOf: Data(repeating: 9, count: 65536))
        }))
    }

    func testCancellationInsideDescriptorHashDrainsItsProvisionalCredit() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("preview-reuse-hash-cancel"))
        defer { try? FileManager.default.removeItem(at: folder.root.deletingLastPathComponent()) }
        try Data(repeating: 7, count: 65536).write(to: folder.root.appendingPathComponent("source.wav"))
        let source = try captured("source.wav", folder: folder), store = NativeAudioPreviewReuse.Store(limit: 65536)
        var worker: Task<[NativeAudioPreviewReuse.SourceIdentity], Error>? = Task.detached {
            guard let credit = store.reserve(4096) else { throw ReelBackend.APIError("The hash test could not reserve its provisional credit.") }
            defer { withExtendedLifetime(credit) {} }
            return try NativeAudioPreviewReuse.sourceIdentities([source], folder: folder, afterDescriptorValidation: {
                withUnsafeCurrentTask { $0?.cancel() }
            })
        }
        do { _ = try await worker!.value; XCTFail("Cancellation inside the descriptor hash returned a usable identity.") }
        catch is CancellationError { }
        worker = nil
        XCTAssertEqual(store.reservedBytes, 0); XCTAssertEqual(store.entryCount, 0)
    }

    func testSourceHashBudgetRejectsHugeAndOverflowingMetadataBeforeReading() {
        var info = Darwin.stat(); info.st_size = Int64.max
        let source = NativeAudioMixCapture.Source(alias: "huge.wav", path: "/unused", stamp: .init(info))
        XCTAssertFalse(NativeAudioPreviewReuse.canHashSources([source, source, source]))
        info.st_size = -1
        XCTAssertFalse(NativeAudioPreviewReuse.canHashSources([.init(alias: "negative.wav", path: "/unused", stamp: .init(info))]))
        info.st_size = 0
        let zero = NativeAudioMixCapture.Source(alias: "zero.wav", path: "/unused", stamp: .init(info))
        XCTAssertFalse(NativeAudioPreviewReuse.canHashSources(Array(repeating: zero, count: 17)))
        XCTAssertTrue(NativeAudioPreviewReuse.canHashSources([zero]))
    }
}
