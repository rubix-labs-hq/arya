import Foundation
import XCTest
@testable import ReelKit

#if DEBUG
private actor PreviewReuseStageGate {
    let target: String
    private var visits = 0
    private var released = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    init(_ target: String) { self.target = target }
    func visit(_ stage: String) async {
        guard stage == target else { return }
        visits += 1
        if !released { await withCheckedContinuation { waiters.append($0) } }
    }
    func count() -> Int { visits }
    func release() {
        released = true
        let pending = waiters; waiters = []
        for waiter in pending { waiter.resume() }
    }
}

private actor PreviewReuseStageLog {
    private var stages: [String] = []
    func record(_ stage: String) { stages.append(stage) }
    func values() -> [String] { stages }
}

/// These use real backend work and noncooperative gates. Root must run the class serially.
final class NativeAudioPreviewReuseLifecycleTests: XCTestCase {
    private typealias Reuse = NativeAudioPreviewReuse
    private struct Fixture { let folder: ProjectFolder; let backend: ReelBackend }
    private struct Observation { let preview: ReelAudioPreview; let bytes: Data }
    private var fixtures: [Fixture] = []
    private var gates: [PreviewReuseStageGate] = []
    private var requests: [Task<ReelAudioPreview, Error>] = []
    private var admissions: [Task<UInt64, Error>] = []
    private var heldBorrow: Reuse.Entry?

    override func setUp() async throws {
        Reuse.store.evictBeforeOtherProcessing()
        try await eventually {
            let state = NativeProcessingAdmission.shared.snapshot()
            return state.active == 0 && state.queued == 0 && Reuse.store.reservedBytes == 0
        }
    }

    override func tearDown() async throws {
        for request in requests { request.cancel() }
        for task in admissions { task.cancel() }
        for gate in gates { await gate.release() }
        heldBorrow = nil
        Reuse.store.evictBeforeOtherProcessing()
        for fixture in fixtures {
            await fixture.backend.setAudioPreviewReuseTestBarrier(nil)
            await fixture.backend.setAudioPreviewReuseEnabledForTesting(false)
            await fixture.backend.stop()
        }
        for request in requests { _ = try? await request.value }
        for task in admissions { _ = try? await task.value }
        for fixture in fixtures {
            await fixture.backend.pageProcessingWorkersExited()
            try await eventually { await fixture.backend.processingWorkersForTesting() == 0 }
        }
        try await assertDrained()
        for root in Set(fixtures.map { $0.folder.root.deletingLastPathComponent() }) {
            try FileManager.default.removeItem(at: root)
        }
    }

    private func master() -> [String: Any] {
        ["volume": 0, "fx": [], "limiter": ["enabled": true, "ceiling": -1, "release": 60, "lookahead": 5]]
    }

    private func fixture(futureSource: String? = nil, createFutureSource: Bool = false) async throws -> Fixture {
        let folder = ProjectFolder(root: try Support.tempFolder("preview-reuse-lifecycle")), core = try ReelCore(scriptURL: Support.core())
        let rate = 48_000, signal = (0..<(rate * 2)).map { Float(0.2 * sin(2 * .pi * 997 * Double($0) / Double(rate))) }
        try NativeAudioProcessing.write(.init(channels: [signal, signal], rate: rate), to: folder.root.appendingPathComponent("source.wav"))
        var fields = try XCTUnwrap(JSON.parse(core.newProject(name: "Preview reuse lifecycle")) as? [String: Any])
        var assets: [String: Any] = ["source.wav": ["kind": "audio", "hasAudio": true, "duration": 2]]
        var tracks: [[String: Any]] = [["id": "A1", "kind": "audio", "volume": 0, "pan": 0,
                                      "clips": [["id": "valid", "kind": "audio", "src": "source.wav", "start": 0, "dur": 2, "in": 0]]]]
        if let futureSource {
            assets[futureSource] = ["kind": "audio", "hasAudio": true, "duration": 1]
            tracks.append(["id": "Future", "kind": "audio", "volume": 0, "pan": 0,
                           "clips": [["id": "future", "kind": "audio", "src": futureSource, "start": 0.8, "dur": 0.8, "in": 0]]])
            if createFutureSource { try Data("This disposable file contains no media stream.\n".utf8).write(to: folder.root.appendingPathComponent(futureSource)) }
        }
        fields["assets"] = assets; fields["tracks"] = tracks; fields["master"] = master()
        try core.fileText(project: JSON(any: fields).text).write(to: folder.projectFile, atomically: true, encoding: .utf8)
        let backend = try ReelBackend(folder: folder, coreScript: Support.core()) { _, _ in }
        let fixture = Fixture(folder: folder, backend: backend); fixtures.append(fixture)
        try await backend.start()
        await backend.setAudioPreviewReuseEnabledForTesting(false)
        return fixture
    }

    private func observe(_ fixture: Fixture, from: Double = 0, to: Double = 0.4) async throws -> Observation {
        let preview = try await fixture.backend.renderAudioPreview(from: from, to: to)
        return .init(preview: preview, bytes: try Data(contentsOf: preview.url))
    }

    private func mixFiles(_ fixture: Fixture) throws -> Set<String> {
        Set(try FileManager.default.contentsOfDirectory(atPath: fixture.folder.cacheDir.path).filter { $0.hasPrefix("mix-") && $0.hasSuffix(".wav") })
    }

    private func preserve(_ original: Observation, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(try Data(contentsOf: original.preview.url), original.bytes, "The earlier caller-owned WAV must survive rejection.", file: file, line: line)
    }

    private func eventually(_ condition: @escaping () async -> Bool) async throws {
        let clock = ContinuousClock(), deadline = clock.now.advanced(by: .seconds(5))
        while clock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw ReelBackend.APIError("The deterministic preview lifecycle fixture did not reach its expected state within five seconds.")
    }

    private func assertDrained(file: StaticString = #filePath, line: UInt = #line) async throws {
        try await eventually {
            let state = NativeProcessingAdmission.shared.snapshot()
            return state.active == 0 && state.queued == 0 && Reuse.store.reservedBytes == 0 && Reuse.store.entryCount == 0
        }
        let state = NativeProcessingAdmission.shared.snapshot()
        XCTAssertEqual(state.active, 0, file: file, line: line); XCTAssertEqual(state.queued, 0, file: file, line: line)
        XCTAssertEqual(Reuse.store.reservedBytes, 0, file: file, line: line); XCTAssertEqual(Reuse.store.entryCount, 0, file: file, line: line)
    }

    private func cancellation(at stage: String, hit: Bool = false,
                              file: StaticString = #filePath, line: UInt = #line) async throws {
        let fixture = try await fixture()
        let original: Observation
        if hit {
            await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
            original = try await observe(fixture)
            let counts = await fixture.backend.audioPreviewReuseCountsForTesting()
            XCTAssertEqual(counts.fills, 1, file: file, line: line); XCTAssertEqual(counts.hits, 0, file: file, line: line)
            XCTAssertEqual(Reuse.store.entryCount, 1, file: file, line: line)
        } else {
            original = try await observe(fixture, to: 0.1)
            await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
        }
        let before = try mixFiles(fixture), gate = PreviewReuseStageGate(stage)
        gates.append(gate)
        // This gate does not observe cancellation. The backend must reject after actual work resumes.
        await fixture.backend.setAudioPreviewReuseTestBarrier { await gate.visit($0) }
        let from = hit ? 0.4 : 0.0, to = hit ? 0.8 : 0.4
        let request = Task { try await fixture.backend.renderAudioPreview(from: from, to: to) }
        requests.append(request)
        try await eventually { await gate.count() == 1 }
        XCTAssertGreaterThan(Reuse.store.reservedBytes, 0, file: file, line: line)
        let beforeCancelWorkers = await fixture.backend.processingWorkersForTesting()
        XCTAssertEqual(beforeCancelWorkers, 1, file: file, line: line)
        XCTAssertEqual(NativeProcessingAdmission.shared.snapshot().active, 1, file: file, line: line)
        request.cancel()
        let heldWorkers = await fixture.backend.processingWorkersForTesting()
        XCTAssertEqual(heldWorkers, 1, "Cancellation cannot release an owner suspended inside its worker.", file: file, line: line)
        XCTAssertEqual(NativeProcessingAdmission.shared.snapshot().active, 1, file: file, line: line)
        await gate.release()
        do { _ = try await request.value; XCTFail("Cancellation at \(stage) returned a preview.", file: file, line: line) }
        catch is CancellationError { }
        try await eventually { await fixture.backend.processingWorkersForTesting() == 0 }
        try await assertDrained(file: file, line: line)
        XCTAssertEqual(try mixFiles(fixture), before, "Cancellation at \(stage) left a new owned mix WAV.", file: file, line: line)
        try preserve(original, file: file, line: line)
    }

    func testCancellationBeforeSourceHashDrainsCredit() async throws { try await cancellation(at: "beforeSourceHash") }
    func testCancellationAfterSourceHashDrainsCredit() async throws { try await cancellation(at: "afterSourceHash") }
    func testCancellationBeforeDecodeAndDSPDrainsCredit() async throws { try await cancellation(at: "beforeDecodeAndDSP") }
    func testCancellationAfterDecodeAndDSPDrainsActualWorker() async throws { try await cancellation(at: "afterDecodeAndDSP") }
    func testCancellationAfterCropDrainsRetainedPCM() async throws { try await cancellation(at: "afterCrop") }
    func testCancellationAfterHitSliceDrainsBorrowAndPreservesCallerWAV() async throws { try await cancellation(at: "afterSlice", hit: true) }
    func testCancellationBeforeWritePreservesCallerWAV() async throws { try await cancellation(at: "beforeWrite") }
    func testCancellationAfterWriteRemovesRejectedWAV() async throws { try await cancellation(at: "afterWrite") }
    func testCancellationBeforeCachePublicationRemovesRejectedWAVAndCredit() async throws { try await cancellation(at: "beforeCachePublication") }
    func testCancellationAtFinalHandoffRemovesWorkerResultAndPublishedEntry() async throws { try await cancellation(at: "finalHandoff") }

    private func finalInvalidation(reuse: Bool, source: Bool,
                                   file: StaticString = #filePath, line: UInt = #line) async throws {
        let fixture = try await fixture(), original = try await observe(fixture, to: 0.1)
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(reuse)
        let before = try mixFiles(fixture), gate = PreviewReuseStageGate("finalHandoff")
        gates.append(gate)
        await fixture.backend.setAudioPreviewReuseTestBarrier { await gate.visit($0) }
        let request = Task { try await fixture.backend.renderAudioPreview(from: 0, to: 0.4) }
        requests.append(request)
        try await eventually { await gate.count() == 1 }
        let counts = await fixture.backend.audioPreviewReuseCountsForTesting()
        XCTAssertEqual(counts.fills, reuse ? 1 : 0, "The test must identify the cache or original path at final handoff.", file: file, line: line)
        XCTAssertEqual(counts.hits, 0, file: file, line: line)
        XCTAssertEqual(try mixFiles(fixture).subtracting(before).count, 1, "The worker must have written a real WAV before final validation.", file: file, line: line)
        let audio = fixture.folder.root.appendingPathComponent("source.wav")
        var changedSource: Data?
        if source {
            var bytes = try Data(contentsOf: audio)
            XCTAssertGreaterThan(bytes.count, 100, file: file, line: line)
            bytes[100] ^= 0x7f
            let handle = try FileHandle(forWritingTo: audio)
            do { try handle.write(contentsOf: bytes); try handle.close() }
            catch { try? handle.close(); throw error }
            changedSource = bytes
        } else {
            // Awaiting the actor gate permits an actual edit through the backend API.
            _ = try await fixture.backend.editOperations(ops: JSON(any: [["op": "project", "set": ["name": "Changed at final handoff"]]]))
        }
        await gate.release()
        do { _ = try await request.value; XCTFail("A changed captured context returned a completed preview.", file: file, line: line) }
        catch let error as ReelBackend.APIError {
            let message = error.message.lowercased()
            XCTAssertTrue(message.contains("source") || message.contains("project") || message.contains("captured"), file: file, line: line)
        }
        try await eventually { await fixture.backend.processingWorkersForTesting() == 0 }
        try await assertDrained(file: file, line: line)
        XCTAssertEqual(try mixFiles(fixture), before, "Final validation must clean up the actual worker result.", file: file, line: line)
        try preserve(original, file: file, line: line)
        if let changedSource { XCTAssertEqual(try Data(contentsOf: audio), changedSource, file: file, line: line) }
    }

    func testCacheFinalHandoffRejectsProjectEditAndCleansOwnedWAV() async throws { try await finalInvalidation(reuse: true, source: false) }
    func testCacheFinalHandoffRejectsSourceMutationAndCleansOwnedWAV() async throws { try await finalInvalidation(reuse: true, source: true) }
    func testOriginalFinalHandoffRejectsProjectEditAndCleansOwnedWAV() async throws { try await finalInvalidation(reuse: false, source: false) }
    func testOriginalFinalHandoffRejectsSourceMutationAndCleansOwnedWAV() async throws { try await finalInvalidation(reuse: false, source: true) }

    private func assertSameResult(_ actual: Observation, _ original: Observation,
                                  file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.bytes, original.bytes, file: file, line: line)
        XCTAssertEqual(actual.preview.offset, original.preview.offset, file: file, line: line)
        XCTAssertEqual(actual.preview.duration, original.preview.duration, file: file, line: line)
        XCTAssertEqual(actual.preview.historySeconds, original.preview.historySeconds, file: file, line: line)
        XCTAssertEqual(actual.preview.residualDB, original.preview.residualDB, file: file, line: line)
        XCTAssertEqual(actual.preview.composition, original.preview.composition, file: file, line: line)
        XCTAssertEqual(actual.preview.version, original.preview.version, file: file, line: line)
        XCTAssertEqual(actual.preview.meters, original.preview.meters, file: file, line: line)
        XCTAssertNotEqual(actual.preview.url, original.preview.url, file: file, line: line)
        XCTAssertNotEqual(actual.preview.requestID, original.preview.requestID, file: file, line: line)
    }

    private func futureFailure(nonAudio: Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let name = nonAudio ? "not-audio.bin" : "missing.wav"
        let fixture = try await fixture(futureSource: name, createFutureSource: nonAudio)
        let original = try await observe(fixture)
        let core = try ReelCore(scriptURL: Support.core()), currentProject = await fixture.backend.currentProject()
        let project = try XCTUnwrap(currentProject)
        let history = try NativeAudioMixer.previewHistory(plan: .raw(core.audioPlan(project: project, from: 0, to: 0.4)))
        let requested = try NativeAudioRenderRange(from: 0, to: 0.4, history: history, rounding: .playback)
        let forward = try NativeAudioRenderRange(from: 0, to: 1.2, history: history, rounding: .playback)
        let shortPlan = try core.audioPlan(project: project, from: 0, to: requested.end)
        let forwardPlan = try core.audioPlan(project: project, from: 0, to: forward.end)
        let shortProfile = try XCTUnwrap(Reuse.profile(shortPlan)), forwardProfile = try XCTUnwrap(Reuse.profile(forwardPlan))
        XCTAssertTrue(forwardProfile.containsPrefix(shortProfile), file: file, line: line)
        XCTAssertFalse(shortProfile.origins.keys.contains(name), file: file, line: line)
        XCTAssertTrue(forwardProfile.origins.keys.contains(name), file: file, line: line)
        let stages = PreviewReuseStageLog()
        await fixture.backend.setAudioPreviewReuseTestBarrier { await stages.record($0) }
        await fixture.backend.setAudioPreviewReuseEnabledForTesting(true)
        let actual = try await observe(fixture)
        assertSameResult(actual, original, file: file, line: line)
        let counts = await fixture.backend.audioPreviewReuseCountsForTesting(), trace = await stages.values()
        XCTAssertEqual(counts.fills, 0, file: file, line: line); XCTAssertEqual(counts.hits, 0, file: file, line: line)
        XCTAssertTrue(trace.contains("finalHandoff"), file: file, line: line)
        if nonAudio {
            XCTAssertTrue(trace.contains("beforeSourceHash"), file: file, line: line)
            XCTAssertTrue(trace.contains("beforeDecodeAndDSP"), "The future-only non-audio source must fail after actual speculative decoding begins.", file: file, line: line)
        }
        XCTAssertEqual(Reuse.store.entryCount, 0, file: file, line: line); XCTAssertEqual(Reuse.store.reservedBytes, 0, file: file, line: line)
        try preserve(original, file: file, line: line)
    }

    func testFutureOnlyMissingSourceFallsBackToExactOriginalRequestedRange() async throws { try await futureFailure(nonAudio: false) }
    func testFutureOnlyNonAudioSourceFallsBackAfterSpeculativeDecodeFailure() async throws { try await futureFailure(nonAudio: true) }

    private func makeBorrowedEntry() throws -> Reuse.Entry {
        let end = 1.2055
        func profile(to: Double) throws -> Reuse.Profile {
            let leaf: [String: Any] = ["id": "valid", "kind": "leaf", "src": "source.wav", "from": 0.0, "to": to,
                "sourceIn": 0.0, "speed": 1.0, "chain": [], "gain": ["values": [1.0]], "pan": ["values": [0.0]]]
            let graph: [String: Any] = ["from": 0.0, "to": to, "rate": 48000,
                "buses": [["id": "A1", "gain": 1.0, "pan": 0.0, "chain": [], "items": [leaf]]],
                "master": ["gain": 1.0, "chain": [], "limiter": ["type": "limiter", "params": ["ceiling": -1.0, "release": 60.0, "lookahead": 5.0], "curves": [:]]]]
            return try XCTUnwrap(Reuse.profile(JSON(any: graph).text))
        }
        let key = Reuse.Identity(owner: UUID(), generation: UUID(), version: 1, composition: nil,
            projectDigest: "p", snapshotDigest: "s", diskDigest: "d", root: "/test", rootIdentity: "1|2", parentIdentity: "1|3", revision: Reuse.revision)
        let frames = 57_600, bins = (0..<24).map { _ in ReelAudioMeterBin(frameCount: 2400, leftPeak: 0, rightPeak: 0, leftSumSquares: 0, rightSumSquares: 0) }
        let entry = Reuse.Entry(identity: key, sources: [], profile: try profile(to: end), samples: 0..<frames,
            pcm: .init(channels: [[Float](repeating: 0, count: frames), [Float](repeating: 0, count: frames)], rate: 48000),
            meters: .init(rate: 48000, frameCount: frames, binFrames: 2400, buses: ["A1": bins], available: true),
            credit: try XCTUnwrap(Reuse.store.reserve(1024 * 1024)))
        XCTAssertTrue(Reuse.store.publish(entry, nextFrame: 19200, token: Reuse.store.publicationToken()))
        return try XCTUnwrap(Reuse.store.borrow(identity: key, samples: 19200..<38400, profile: try profile(to: 0.8055)))
    }

    private func admissionWait(_ lease: NativeProcessingAdmission.Lease, stages: PreviewReuseStageLog, label: String) -> Task<UInt64, Error> {
        let task = Task {
            defer { lease.finish() }
            await stages.record("\(label)-waiting")
            try await lease.wait()
            await stages.record("\(label)-started")
            return Reuse.store.reservedBytes
        }
        admissions.append(task)
        return task
    }

    private func heldBorrowAdmission(cancel: Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        heldBorrow = try makeBorrowedEntry()
        XCTAssertEqual(Reuse.store.entryCount, 1, file: file, line: line)
        XCTAssertEqual(Reuse.store.reservedBytes, 1024 * 1024, file: file, line: line)
        let firstLease = try NativeProcessingAdmission.shared.reserve(capturedBytes: 1)
        XCTAssertEqual(Reuse.store.entryCount, 0, "Reservation evicts the slot but must keep a borrow's credit.", file: file, line: line)
        let stages = PreviewReuseStageLog(), first = admissionWait(firstLease, stages: stages, label: "first")
        try await eventually { NativeProcessingAdmission.shared.snapshot().active == 1 }
        let secondLease = try NativeProcessingAdmission.shared.reserve(capturedBytes: 1)
        let second = admissionWait(secondLease, stages: stages, label: "second")
        try await eventually {
            let values = await stages.values()
            return values.contains("first-waiting") && values.contains("second-waiting") && NativeProcessingAdmission.shared.snapshot().queued == 1
        }
        if cancel { first.cancel() }
        let beforeRelease = await stages.values()
        XCTAssertFalse(beforeRelease.contains("first-started"), file: file, line: line)
        XCTAssertFalse(beforeRelease.contains("second-started"), file: file, line: line)
        XCTAssertTrue(firstLease.isActive, file: file, line: line)
        XCTAssertEqual(NativeProcessingAdmission.shared.snapshot().active, 1, file: file, line: line)
        XCTAssertEqual(NativeProcessingAdmission.shared.snapshot().queued, 1, file: file, line: line)
        XCTAssertEqual(Reuse.store.reservedBytes, 1024 * 1024, file: file, line: line)
        heldBorrow = nil
        XCTAssertEqual(Reuse.store.reservedBytes, 0, file: file, line: line)
        if cancel {
            do { _ = try await first.value; XCTFail("Canceled activation entered work after its retained borrow drained.", file: file, line: line) }
            catch is CancellationError { }
        } else {
            let firstBytes = try await first.value
            XCTAssertEqual(firstBytes, 0, file: file, line: line)
        }
        let secondBytes = try await second.value
        XCTAssertEqual(secondBytes, 0, "The next worker must start only after all retained credits drain.", file: file, line: line)
        let completed = await stages.values()
        XCTAssertTrue(completed.contains("second-started"), file: file, line: line)
        XCTAssertEqual(completed.contains("first-started"), !cancel, file: file, line: line)
        try await assertDrained(file: file, line: line)
    }

    func testProcessWideActivationWaitsForActualBorrowReleaseBeforeStartingWorkers() async throws { try await heldBorrowAdmission(cancel: false) }
    func testCanceledActivationRetainsLeaseUntilActualBorrowDrains() async throws { try await heldBorrowAdmission(cancel: true) }
}
#endif
