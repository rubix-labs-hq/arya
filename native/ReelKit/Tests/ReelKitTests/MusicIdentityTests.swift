import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import ReelKit

final class MusicIdentityTests: XCTestCase {
    private func file(_ root: URL, data: Data = Data(repeating: 17, count: 131_089)) throws -> (ProjectFolder, String, URL) {
        let folder = ProjectFolder(root: root), path = "media/generated/music/\(UUID().uuidString.lowercased())/score.wav", url = try folder.output(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return (folder, path, url)
    }
    func testActualBoundedHashAndValidationUseFinalBytesAcrossChunks() throws {
        let root = try Support.tempFolder("music-identity-hash")
        defer { try? FileManager.default.removeItem(at: root) }
        let bytes = Data((0..<131_089).map { UInt8($0 % 251) }), (folder, path, _) = try file(root, data: bytes)
        let identity = try NativeMusicIdentity.readSync(folder: folder, path: path)
        XCTAssertEqual(identity.contentBytes, Int64(bytes.count))
        XCTAssertEqual(identity.contentSHA256, SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
        try identity.validate()
    }
    func testActualLinksPermissionsAndPathBoundariesRejectWithoutChangingForeignBytes() throws {
        for boundary in ["symlink", "parent-symlink", "hardlink", "shared-write", "outside", "fifo"] {
            let root = try Support.tempFolder("music-identity-\(boundary)")
            defer { try? FileManager.default.removeItem(at: root) }
            let (folder, path, url) = try file(root), foreign = root.appendingPathComponent("foreign.wav")
            let original = try Data(contentsOf: url); try original.write(to: foreign)
            var src = path
            if boundary == "symlink" { try FileManager.default.removeItem(at: url); try FileManager.default.createSymbolicLink(at: url, withDestinationURL: foreign) }
            if boundary == "parent-symlink" {
                let parent = url.deletingLastPathComponent(), moved = parent.appendingPathExtension("old")
                try FileManager.default.moveItem(at: parent, to: moved); try FileManager.default.createSymbolicLink(at: parent, withDestinationURL: moved)
            }
            if boundary == "hardlink" { try FileManager.default.linkItem(at: url, to: root.appendingPathComponent("linked.wav")) }
            if boundary == "shared-write" { try FileManager.default.setAttributes([.posixPermissions: 0o666], ofItemAtPath: url.path) }
            if boundary == "outside" { src = "../foreign.wav" }
            if boundary == "fifo" { try FileManager.default.removeItem(at: url); XCTAssertEqual(url.path.withCString { Darwin.mkfifo($0, 0o600) }, 0) }
            XCTAssertThrowsError(try NativeMusicIdentity.readSync(folder: folder, path: src), boundary)
            XCTAssertEqual(try Data(contentsOf: foreign), original, boundary)
        }
    }
    func testActualMutationTruncationGrowthAndInodeReplacementInvalidateStableDescriptor() throws {
        for change in ["mutate", "truncate", "grow", "replace"] {
            let root = try Support.tempFolder("music-identity-\(change)")
            defer { try? FileManager.default.removeItem(at: root) }
            let (folder, path, url) = try file(root)
            XCTAssertThrowsError(try NativeMusicIdentity.readSync(folder: folder, path: path, afterDescriptorValidation: {
                if change == "replace" {
                    let moved = url.appendingPathExtension("old")
                    try FileManager.default.moveItem(at: url, to: moved); try FileManager.default.copyItem(at: moved, to: url)
                } else {
                    let handle = try FileHandle(forWritingTo: url); defer { try? handle.close() }
                    if change == "mutate" { try handle.seek(toOffset: 70_000); try handle.write(contentsOf: Data([99])) }
                    if change == "truncate" { try handle.truncate(atOffset: 44) }
                    if change == "grow" { try handle.seekToEnd(); try handle.write(contentsOf: Data([99])) }
                }
            }), change)
        }
    }
    func testOversizedReplacementIsBoundedAndPublicationRechecksStamp() throws {
        let root = try Support.tempFolder("music-identity-budget")
        defer { try? FileManager.default.removeItem(at: root) }
        let (folder, path, url) = try file(root), identity = try NativeMusicIdentity.readSync(folder: folder, path: path)
        let handle = try FileHandle(forWritingTo: url); defer { try? handle.close() }
        try handle.seek(toOffset: 70_000); try handle.write(contentsOf: Data([99]))
        XCTAssertThrowsError(try identity.validate())
        try handle.truncate(atOffset: UInt64(NativeMusicIdentity.maximumBytes + 1))
        XCTAssertThrowsError(try NativeMusicIdentity.readSync(folder: folder, path: path))
        let oversized = try NativeMusicIdentity.readSync(folder: folder, path: path, allowOversized: true)
        XCTAssertNil(oversized.contentSHA256); XCTAssertEqual(oversized.contentBytes, NativeMusicIdentity.maximumBytes + 1)
    }
    func testAlreadyCancelledReadDoesNotReturnAReceipt() async throws {
        let root = try Support.tempFolder("music-identity-cancel")
        defer { try? FileManager.default.removeItem(at: root) }
        let (folder, path, _) = try file(root)
        let task = Task { withUnsafeCurrentTask { $0?.cancel() }; return try NativeMusicIdentity.readSync(folder: folder, path: path) }
        do { _ = try await task.value; XCTFail("Cancellation returned identity") } catch { XCTAssertTrue(error is CancellationError) }
    }
}
