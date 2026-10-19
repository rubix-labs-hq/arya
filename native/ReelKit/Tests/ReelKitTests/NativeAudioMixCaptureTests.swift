import CryptoKit
import Dispatch
import Foundation
import XCTest
@testable import ReelKit

private final class MixCopyArrival: @unchecked Sendable {
    private let lock = NSLock()
    private var arrived = false
    func signal() { lock.lock(); defer { lock.unlock() }; arrived = true }
    func hasArrived() -> Bool { lock.lock(); defer { lock.unlock() }; return arrived }
}

final class NativeAudioMixCaptureTests: XCTestCase {
    func testPrivateBytesSHAPlanRewriteAndOriginalDrift() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("mix-copy"))
        try FileManager.default.createDirectory(at: folder.cacheDir, withIntermediateDirectories: true)
        let file = folder.root.appendingPathComponent("source.bin")
        try Data("abc".utf8).write(to: file)
        let original = JSON(any: ["from": 0, "to": 1, "rate": 48000, "buses": [["id": "A1", "items": [["src": "source.bin", "sourceIn": 0, "from": 0, "to": 1, "speed": 1]]]], "master": ["gain": 1]]).text
        let limit: UInt64 = 1_048_576
        let sources = try NativeAudioMixCapture.sources(plan: original, folder: folder, diskLimit: limit)
        let bytes = try NativeAudioMixCapture.reservationBytes(plan: original, croppedFrames: 48000, folder: folder)
        let capture = NativeAudioMixCapture(projectText: "{}", projectFileText: "{}", version: 1, root: folder.root.path, storage: try NativeAudioMixStorage(project: folder), composition: nil, output: .master, semantics: .export,
                                            requestID: UUID().uuidString, from: 0, to: 1, planText: original, cropStart: 0, cropCount: 48000, sampleStart: 0,
                                            sources: sources, maximumDiskBytes: limit, requestText: "{}", reservedMemoryBytes: bytes)
        let directory = try capture.prepareSnapshotDirectory(folder: folder, id: UUID().uuidString)
        defer { directory.cleanup() }
        let snapshot = try await NativeAudioProcessing.cancellableTask { try capture.makeSnapshot(folder: folder, directory: directory) }
        XCTAssertEqual(snapshot.files.count, 1)
        XCTAssertFalse(folder.contains(snapshot.folder.root))
        XCTAssertThrowsError(try folder.resolve(snapshot.files[0].copy))
        XCTAssertEqual(try snapshot.folder.resolve(snapshot.files[0].copy).path, snapshot.files[0].copy)
        XCTAssertEqual(snapshot.files[0].sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: snapshot.files[0].copy)), Data("abc".utf8))
        XCTAssertFalse(snapshot.planText.contains("\"source.bin\""))
        let reserved = try NativeAudioMixCapture.reservationBytes(plan: snapshot.planText, croppedFrames: 48000, folder: folder)
        XCTAssertLessThanOrEqual(reserved, bytes)
        try capture.verify(snapshot, folder: folder)
        let copyAttrs = try FileManager.default.attributesOfItem(atPath: snapshot.files[0].copy)
        let directoryAttrs = try FileManager.default.attributesOfItem(atPath: snapshot.directory)
        XCTAssertEqual((copyAttrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual((directoryAttrs[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        try Data("xyz".utf8).write(to: file)
        XCTAssertThrowsError(try capture.verify(snapshot, folder: folder))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: snapshot.files[0].copy)), Data("abc".utf8))
    }
    func testCancellationAtCopyReturnBoundaryRemovesOwnedDirectoryAfterWorkerExit() async throws {
        let folder = ProjectFolder(root: try Support.tempFolder("mix-return-cancel"))
        try FileManager.default.createDirectory(at: folder.cacheDir, withIntermediateDirectories: true)
        let file = folder.root.appendingPathComponent("source.bin")
        try Data("abc".utf8).write(to: file)
        let plan = JSON(any: ["from": 0, "to": 0.01, "rate": 48000, "buses": [["id": "A", "items": [["src": "source.bin"]]]]]).text
        let capture = NativeAudioMixCapture(projectText: "{}", projectFileText: "{}", version: 1, root: folder.root.path, storage: try NativeAudioMixStorage(project: folder), composition: nil, output: .master, semantics: .export,
                                            requestID: UUID().uuidString, from: 0, to: 0.01, planText: plan, cropStart: 0, cropCount: 480, sampleStart: 0,
                                            sources: try NativeAudioMixCapture.sources(plan: plan, folder: folder, diskLimit: 100), maximumDiskBytes: 100, requestText: "{}", reservedMemoryBytes: 1_048_576)
        let directory = try capture.prepareSnapshotDirectory(folder: folder, id: UUID().uuidString)
        let arrived = MixCopyArrival(), release = DispatchSemaphore(value: 0)
        let task = Task {
            defer { directory.cleanup() }
            return try await NativeAudioProcessing.cancellableTask {
                let snapshot = try capture.makeSnapshot(folder: folder, directory: directory)
                arrived.signal()
                release.wait()
                return snapshot
            }
        }
        defer { release.signal(); directory.cleanup() }
        var reached = false
        for _ in 0..<500 {
            if arrived.hasArrived() { reached = true; break }
            try await Task.sleep(for: .milliseconds(10))
        }
        guard reached else { task.cancel(); release.signal(); _ = try? await task.value; throw ReelBackend.APIError("The copy worker did not reach its return boundary.") }
        task.cancel()
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path))
        release.signal()
        do { _ = try await task.value; XCTFail("The canceled copy returned a snapshot.") } catch is CancellationError { }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    func testSourceGrowthCannotWriteBeyondCapturedDiskLease() throws {
        let folder = ProjectFolder(root: try Support.tempFolder("mix-grow"))
        let source = folder.root.appendingPathComponent("source.bin")
        let copy = folder.root.appendingPathComponent("copy.bin")
        try Data("abc".utf8).write(to: source)
        let identity = NativeAudioMixCapture.Source(alias: source.path, path: source.path, stamp: try NativeAudioMixCapture.fileStamp(source.path))
        XCTAssertThrowsError(try NativeAudioMixCapture.stream(source: identity, folder: folder, copyTo: copy, maximumBytes: UInt64(identity.stamp.bytes)) {
            let handle = try FileHandle(forWritingTo: source)
            defer { try? handle.close() }
            _ = try handle.seekToEnd()
            try handle.write(contentsOf: Data(repeating: 65, count: 100_000))
        })
        XCTAssertLessThanOrEqual(try Data(contentsOf: copy).count, 3)
    }

    func testProjectComparisonRejectsOversizedReplacementWithBoundedRead() throws {
        let folder = ProjectFolder(root: try Support.tempFolder("mix-project-size"))
        try Data("{}".utf8).write(to: folder.projectFile)
        XCTAssertTrue(try NativeAudioMixCapture.projectFileMatches(folder.projectFile, expected: "{}"))
        let handle = try FileHandle(forWritingTo: folder.projectFile)
        try handle.truncate(atOffset: 64 * 1024 * 1024)
        try handle.close()
        XCTAssertFalse(try NativeAudioMixCapture.projectFileMatches(folder.projectFile, expected: "{}"))
    }

    func testRetainedCaptureStringsAreIncludedAsTwoBytePerUTF8Headroom() {
        XCTAssertEqual(NativeAudioMixCapture.captureStringBytes(project: "abc", projectFile: "defg", request: "hi"), 18)
    }

    func testDepthLimitAllowsEmptyChildrenAndRejectsDeeperBuses() throws {
        let folder = ProjectFolder(root: try Support.tempFolder("mix-depth"))
        var buses: [[String: Any]] = [["id": "leaf", "items": []]]
        for level in 0..<16 { buses = [["id": "bus-\(level)", "items": [["kind": "comp", "buses": buses]]]] }
        let plan = JSON(any: ["from": 0, "to": 0.01, "rate": 48000, "buses": buses]).text
        XCTAssertTrue(try NativeAudioMixCapture.sources(plan: plan, folder: folder, diskLimit: 100).isEmpty)
        XCTAssertGreaterThan(try NativeAudioMixCapture.reservationBytes(plan: plan, croppedFrames: 480, folder: folder), 0)
        buses = [["id": "too-deep", "items": [["kind": "comp", "buses": buses]]]]
        let deep = JSON(any: ["from": 0, "to": 0.01, "rate": 48000, "buses": buses]).text
        XCTAssertThrowsError(try NativeAudioMixCapture.sources(plan: deep, folder: folder, diskLimit: 100))
        XCTAssertThrowsError(try NativeAudioMixCapture.reservationBytes(plan: deep, croppedFrames: 480, folder: folder))
    }

    func testStrictIntegerVersionAndConfinedSources() throws {
        let invalidVersions: [Any] = [true, false, 1.5, NSNumber(value: 2.0), "2", -1, NSNull()]
        for value in invalidVersions { XCTAssertThrowsError(try NativeAudioMixCapture.strictVersion(value)) }
        XCTAssertEqual(try NativeAudioMixCapture.strictVersion(NSNumber(value: 2)), 2)
        let folder = ProjectFolder(root: try Support.tempFolder("mix-confined"))
        let outside = folder.root.deletingLastPathComponent().appendingPathComponent("outside.bin")
        try Data("bytes".utf8).write(to: outside)
        let alias = folder.root.appendingPathComponent("escape.bin")
        try FileManager.default.createSymbolicLink(atPath: alias.path, withDestinationPath: outside.path)
        let plan = JSON(any: ["from": 0, "to": 1, "buses": [["id": "A1", "items": [["src": "escape.bin"]]]]]).text
        XCTAssertThrowsError(try NativeAudioMixCapture.sources(plan: plan, folder: folder, diskLimit: 100))
        XCTAssertThrowsError(try NativeAudioMixCapture.composition([:]))
        XCTAssertThrowsError(try NativeAudioMixCapture.composition(["comp": true]))
    }
}
