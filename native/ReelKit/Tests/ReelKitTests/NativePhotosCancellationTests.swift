import Foundation
import XCTest

/// Cancellation tests for the Photos import batch controller.
final class NativePhotosCancellationTests: XCTestCase {
    @MainActor private final class DelayedTransfer {
        var entered = false
        private var pending: CheckedContinuation<URL?, Never>?

        func transfer() async -> URL? {
            await withCheckedContinuation { continuation in
                pending = continuation
                entered = true
            }
        }

        func waitUntilEntered() async throws {
            for _ in 0..<200 {
                if entered { return }
                try await Task.sleep(for: .milliseconds(10))
            }
            throw NSError(domain: "PhotosCancellationFixture", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Delayed transfer did not start within two seconds."])
        }

        func release(_ url: URL) {
            let continuation = pending
            pending = nil
            continuation?.resume(returning: url)
        }
    }

    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("arya-photos-cancel-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        return root
    }

    private func ownedTransfer(_ root: URL, name: String, bytes: Data) throws -> URL {
        let folder = root.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        let file = folder.appendingPathComponent("selected.png")
        try bytes.write(to: file)
        return file
    }

    @MainActor
    func testOwnedCancellationWhileTransferWaitsCleansOnlyItsReturnedCopyAndNeverCallsRegistration() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let selectedOriginal = root.appendingPathComponent("original-selected.png")
        let priorAsset = root.appendingPathComponent("already-registered.png")
        let bytes = Data("selected original fixture".utf8)
        let priorBytes = Data("prior asset fixture".utf8)
        try bytes.write(to: selectedOriginal)
        try priorBytes.write(to: priorAsset)
        let transferred = try ownedTransfer(root, name: "batch-owned-transfer", bytes: bytes)
        let gate = DelayedTransfer()
        var registrationCalls = 0
        var cleaned: [URL] = []
        let task = Task {
            try await NativePhotosImportBatch.run(items: [0], isCurrent: { true },
                transfer: { _ in await gate.transfer() },
                copy: { _ in registrationCalls += 1; return true },
                cleanup: { url in
                    cleaned.append(url)
                    try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
                })
        }
        defer { task.cancel(); gate.release(transferred) }
        try await gate.waitUntilEntered()
        task.cancel()
        // Model a provider that returns its owned file after receiving cancellation.
        gate.release(transferred)
        do { _ = try await task.value; XCTFail("Cancelled transfer was accepted.") }
        catch is CancellationError { }
        XCTAssertEqual(registrationCalls, 0)
        XCTAssertEqual(cleaned, [transferred])
        XCTAssertFalse(FileManager.default.fileExists(atPath: transferred.path))
        XCTAssertEqual(try Data(contentsOf: selectedOriginal), bytes)
        XCTAssertEqual(try Data(contentsOf: priorAsset), priorBytes)
    }

    @MainActor
    func testOwnedCancellationDuringSecondTransferPreservesFirstConfirmedAndPriorAssets() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let bytes = Data("selected original fixture".utf8)
        let priorBytes = Data("prior asset fixture".utf8)
        let original = root.appendingPathComponent("original-selected.png")
        let prior = root.appendingPathComponent("already-registered.png")
        let firstSaved = root.appendingPathComponent("first-confirmed.png")
        try bytes.write(to: original)
        try priorBytes.write(to: prior)
        let first = try ownedTransfer(root, name: "batch-owned-first", bytes: bytes)
        let second = try ownedTransfer(root, name: "batch-owned-second", bytes: bytes)
        let gate = DelayedTransfer()
        var copied: [URL] = []
        var cleaned: [URL] = []
        let task = Task {
            try await NativePhotosImportBatch.run(items: [0, 1], isCurrent: { true },
                transfer: { item in
                    if item == 0 { return first }
                    return await gate.transfer()
                },
                copy: { url in
                    copied.append(url)
                    try Data(contentsOf: url).write(to: firstSaved)
                    return true
                },
                cleanup: { url in
                    cleaned.append(url)
                    try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
                })
        }
        defer { task.cancel(); gate.release(second) }
        try await gate.waitUntilEntered()
        task.cancel()
        gate.release(second)
        do { _ = try await task.value; XCTFail("Cancelled second transfer was accepted.") }
        catch is CancellationError { }
        XCTAssertEqual(copied, [first])
        XCTAssertEqual(cleaned, [first, second])
        XCTAssertEqual(try Data(contentsOf: firstSaved), bytes)
        XCTAssertEqual(try Data(contentsOf: original), bytes)
        XCTAssertEqual(try Data(contentsOf: prior), priorBytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.path))
    }

    @MainActor
    func testLateAndDuplicateSelectionsCannotReplaceOwnedTaskOrAcknowledgeBeforeDrain() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let bytes = Data("owned transfer fixture".utf8)
        let transferred = try ownedTransfer(root, name: "batch-owned-transfer", bytes: bytes)
        let gate = DelayedTransfer()
        var importing = false
        var ownedTask: Task<Void, Never>?
        var starts = 0
        var completions = 0
        var cancellationAcknowledged = false
        var registrationCalls = 0
        var cleaned: [URL] = []

        @MainActor func selectionChanged(_ selection: [Int]) {
            guard PhotosSelectionAdmission.allows(selection: selection, importing: importing, task: ownedTask) else { return }
            importing = true
            starts += 1
            ownedTask = Task { @MainActor in
                defer { importing = false; ownedTask = nil; completions += 1 }
                do {
                    _ = try await NativePhotosImportBatch.run(items: selection, isCurrent: { true },
                        transfer: { _ in await gate.transfer() },
                        copy: { _ in registrationCalls += 1; return true },
                        cleanup: { url in
                            cleaned.append(url)
                            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
                        })
                } catch is CancellationError {
                    cancellationAcknowledged = true
                } catch {
                    XCTFail("Unexpected batch failure: \(error)")
                }
            }
        }

        selectionChanged([0])
        let originalTask = try XCTUnwrap(ownedTask)
        defer { originalTask.cancel(); gate.release(transferred) }
        try await gate.waitUntilEntered()
        selectionChanged([1])
        selectionChanged([1, 2])
        XCTAssertEqual(starts, 1)
        XCTAssertTrue(importing)
        XCTAssertNotNil(ownedTask)
        originalTask.cancel()
        selectionChanged([3])
        XCTAssertEqual(starts, 1)
        XCTAssertEqual(completions, 0)
        XCTAssertFalse(cancellationAcknowledged)
        XCTAssertTrue(importing)
        XCTAssertNotNil(ownedTask)
        // A held task also refuses admission if presentation state is temporarily stale.
        importing = false
        selectionChanged([4])
        XCTAssertEqual(starts, 1)
        XCTAssertNotNil(ownedTask)
        importing = true
        gate.release(transferred)
        await originalTask.value
        XCTAssertEqual(completions, 1)
        XCTAssertTrue(cancellationAcknowledged)
        XCTAssertFalse(importing)
        XCTAssertNil(ownedTask)
        XCTAssertEqual(registrationCalls, 0)
        XCTAssertEqual(cleaned, [transferred])
        XCTAssertFalse(FileManager.default.fileExists(atPath: transferred.path))
    }
}
