import Foundation
import XCTest
@testable import ReelKit

private actor ProcessingGate {
    private var visits = 0
    private var released = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func visit() async { visits += 1; if !released { await withCheckedContinuation { waiters.append($0) } } }
    func count() -> Int { visits }
    func release() { released = true; let pending = waiters; waiters = []; for waiter in pending { waiter.resume() } }
}

/// These run the actual backend with injected recognition, disposable bytes and
/// explicit gates. They never start Speech, AVFoundation decoding or a renderer.
final class ProcessingAdmissionBackendTests: XCTestCase {
    private struct Fixture { let root: URL; let backend: ReelBackend; let writes: ProjectWriteAdmission }
    private var fixtures: [Fixture] = []
    private var gates: [ProcessingGate] = []
    private func admission() -> NativeProcessingAdmission { .init(capturedByteLimit: 64 * 1024 * 1024) }
    private func fixture(_ admission: NativeProcessingAdmission, recognition: ProcessingGate? = nil) async throws -> Fixture {
        let root = try Support.tempFolder("shared-processing"), folder = ProjectFolder(root: root)
        let core = try ReelCore(scriptURL: Support.core())
        var fields = try JSON.parse(core.newProject(name: "Captured")) as! [String: Any]
        fields["assets"] = ["source.wav": ["kind": "audio", "hasAudio": true, "duration": 1]]
        try Data("preserved original".utf8).write(to: root.appendingPathComponent("source.wav"))
        try Data(core.fileText(project: JSON(any: fields).text).utf8).write(to: folder.projectFile)
        let writes = ProjectWriteAdmission()
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), transcribe: { _, _, _, _ in
            if let recognition { await recognition.visit() }
            return .object([("status", "complete"), ("words", .array([.object([("t", 0), ("end", 0.5), ("text", "captured")])])), ("onDevice", true)])
        }, writeAdmission: { try writes.requireWritable() }, processingAdmission: admission, events: { _, _ in })
        let value = Fixture(root: root, backend: backend, writes: writes); fixtures.append(value)
        if let recognition { gates.append(recognition) }
        try await backend.start(); return value
    }
    override func tearDown() async throws {
        for gate in gates { await gate.release() }
        for fixture in fixtures { await fixture.backend.stop(); await fixture.backend.pageProcessingWorkersExited() }
        for fixture in fixtures {
            try await eventually { await fixture.backend.processingWorkersForTesting() == 0 }
            try? FileManager.default.removeItem(at: fixture.root.deletingLastPathComponent())
        }
    }
    private func eventually(_ condition: @escaping () async -> Bool) async throws {
        for _ in 0..<500 { if await condition() { return }; try await Task.sleep(for: .milliseconds(10)) }
        throw ReelBackend.APIError("The backend fixture did not reach its expected state.")
    }
    private func call(_ fixture: Fixture, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        parse(try await fixture.backend.handle(method: body == nil ? "GET" : "POST", path: path, body: body.map { JSON(any: $0).text }).text)
    }
    private func start(_ fixture: Fixture) async throws -> String {
        let result = try await call(fixture, "/api/analyze", ["src": "source.wav", "locale": "en-US", "kind": "transcript", "force": true, "wait": false])
        return try XCTUnwrap(result["id"] as? String)
    }
    private func receipt(_ fixture: Fixture, _ id: String) async throws -> [String: Any] {
        try await call(fixture, "/api/jobs/wait?id=\(id)&timeout=0")
    }
    private func finished(_ fixture: Fixture, _ id: String) async throws -> [String: Any] {
        for _ in 0..<500 {
            let job = try await receipt(fixture, id)
            if ["done", "failed"].contains(job["state"] as? String ?? ""), job["draining"] as? Bool == false { return job }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw ReelBackend.APIError("The fixture worker did not finish.")
    }
    private func waitUntilRunning(_ fixture: Fixture, _ id: String) async throws {
        try await eventually { (try? await self.receipt(fixture, id))?["state"] as? String == "running" }
    }
    private func mutate(_ fixture: Fixture) async throws {
        _ = try await call(fixture, "/api/ops", ["ops": [["op": "project", "set": ["name": "Changed"]]]])
    }
    private func assertNoSavedTranscript(_ fixture: Fixture) throws {
        let saved = try NativeTranscriptStore.read(src: "source.wav", locale: "en-US", folder: ProjectFolder(root: fixture.root))
        XCTAssertTrue((parse(saved.text)["words"] as? [Any] ?? []).isEmpty)
    }
    func testTwoProjectBackendsShareOneWorkerAndShowQueuedProgress() async throws {
        let policy = admission(), firstGate = ProcessingGate(), secondGate = ProcessingGate()
        let first = try await fixture(policy, recognition: firstGate), second = try await fixture(policy, recognition: secondGate)
        let firstID = try await start(first); try await eventually { await firstGate.count() == 1 }
        let secondID = try await start(second)
        let queued = try await receipt(second, secondID)
        XCTAssertEqual(queued["state"] as? String, "queued"); XCTAssertEqual(queued["progress"] as? Double, 0)
        XCTAssertEqual(policy.snapshot().active, 1); XCTAssertEqual(policy.snapshot().queued, 1)
        await firstGate.release(); let firstResult = try await finished(first, firstID); XCTAssertEqual(firstResult["state"] as? String, "done")
        try await eventually { await secondGate.count() == 1 }; await secondGate.release()
        let secondResult = try await finished(second, secondID); XCTAssertEqual(secondResult["state"] as? String, "done")
    }
    func testQueuedVersionEditRejectsBeforeRecognitionAndPreservesUndo() async throws {
        let policy = admission(), held = try policy.reserve(capturedBytes: 1), recognition = ProcessingGate()
        try await held.wait()
        let fixture = try await fixture(policy, recognition: recognition), id = try await start(fixture)
        let original = try Data(contentsOf: fixture.root.appendingPathComponent("source.wav"))
        try await mutate(fixture); held.finish()
        let job = try await finished(fixture, id), count = await recognition.count()
        XCTAssertEqual(job["state"] as? String, "failed"); XCTAssertEqual(count, 0)
        try assertNoSavedTranscript(fixture)
        _ = try await call(fixture, "/api/undo", [:])
        let current = await fixture.backend.currentProject(); XCTAssertEqual(parse(try XCTUnwrap(current))["name"] as? String, "Captured")
        XCTAssertEqual(try Data(contentsOf: fixture.root.appendingPathComponent("source.wav")), original)
    }
    func testQueuedReplacementRejectsBeforeRecognition() async throws {
        let policy = admission(), held = try policy.reserve(capturedBytes: 1), gate = ProcessingGate()
        try await held.wait()
        let fixture = try await fixture(policy, recognition: gate), id = try await start(fixture)
        _ = try await call(fixture, "/api/new", ["name": "Replacement"]); held.finish()
        let job = try await finished(fixture, id), count = await gate.count()
        XCTAssertEqual(job["state"] as? String, "failed"); XCTAssertEqual(count, 0)
    }
    func testQueuedDiskEditRejectsEvenWithoutWatcherRefresh() async throws {
        let policy = admission(), held = try policy.reserve(capturedBytes: 1), gate = ProcessingGate()
        try await held.wait()
        let fixture = try await fixture(policy, recognition: gate), id = try await start(fixture)
        let file = fixture.root.appendingPathComponent("reel.project.json")
        var fields = parse(try String(contentsOf: file)); fields["name"] = "External edit"
        let changed = Data(JSON(any: fields).text.utf8); try changed.write(to: file)
        held.finish(); let job = try await finished(fixture, id), count = await gate.count()
        XCTAssertEqual(job["state"] as? String, "failed"); XCTAssertEqual(count, 0)
        XCTAssertEqual(try Data(contentsOf: file), changed)
    }
    func testQueuedSameByteRootReplacementRejectsBeforeRecognition() async throws {
        let policy = admission(), held = try policy.reserve(capturedBytes: 1), gate = ProcessingGate()
        try await held.wait()
        let fixture = try await fixture(policy, recognition: gate), id = try await start(fixture)
        let saved = fixture.root.deletingLastPathComponent().appendingPathComponent("original-root")
        try FileManager.default.moveItem(at: fixture.root, to: saved)
        try FileManager.default.copyItem(at: saved, to: fixture.root)
        held.finish(); let job = try await finished(fixture, id), count = await gate.count()
        XCTAssertEqual(job["state"] as? String, "failed"); XCTAssertEqual(count, 0)
        XCTAssertEqual(try Data(contentsOf: fixture.root.appendingPathComponent("reel.project.json")), try Data(contentsOf: saved.appendingPathComponent("reel.project.json")))
    }
    func testQueuedSourceReplacementRejectsBeforeRecognition() async throws {
        let policy = admission(), held = try policy.reserve(capturedBytes: 1), gate = ProcessingGate()
        try await held.wait()
        let fixture = try await fixture(policy, recognition: gate), id = try await start(fixture)
        let source = fixture.root.appendingPathComponent("source.wav"), replacement = Data("external replacement".utf8)
        try FileManager.default.removeItem(at: source); try replacement.write(to: source)
        held.finish(); let job = try await finished(fixture, id), count = await gate.count()
        XCTAssertEqual(job["state"] as? String, "failed"); XCTAssertEqual(count, 0); XCTAssertEqual(try Data(contentsOf: source), replacement)
    }
    func testCancellationReceiptKeepsLeaseUntilNoncooperativeRecognitionReturns() async throws {
        let policy = admission(), firstGate = ProcessingGate(), secondGate = ProcessingGate()
        let first = try await fixture(policy, recognition: firstGate), second = try await fixture(policy, recognition: secondGate)
        let id = try await start(first); try await eventually { await firstGate.count() == 1 }
        _ = try await call(first, "/api/jobs/cancel", ["id": id]); let canceled = try await receipt(first, id)
        XCTAssertEqual(canceled["state"] as? String, "failed"); XCTAssertEqual(canceled["draining"] as? Bool, true)
        let laterID = try await start(second); try await Task.sleep(for: .milliseconds(40))
        let laterCount = await secondGate.count(); XCTAssertEqual(laterCount, 0); XCTAssertEqual(policy.snapshot().active, 1)
        await firstGate.release(); let drained = try await finished(first, id); XCTAssertEqual(drained["draining"] as? Bool, false)
        try assertNoSavedTranscript(first)
        try await eventually { await secondGate.count() == 1 }; await secondGate.release(); _ = try await finished(second, laterID)
    }
    func testCloseRetainsActualWorkerOwnershipUntilRecognitionReturns() async throws {
        let policy = admission(), gate = ProcessingGate(), fixture = try await fixture(policy, recognition: gate)
        _ = try await start(fixture); try await eventually { await gate.count() == 1 }
        await fixture.backend.stop()
        let workers = await fixture.backend.processingWorkersForTesting(); XCTAssertEqual(workers, 1); XCTAssertEqual(policy.snapshot().active, 1)
        await gate.release(); try await eventually { policy.snapshot().active == 0 }
        try assertNoSavedTranscript(fixture)
    }
    func testDirectRecognitionReusesLeaseAndRejectsLateProjectMutation() async throws {
        let policy = admission(), gate = ProcessingGate(), fixture = try await fixture(policy, recognition: gate)
        let request = Task { try await self.call(fixture, "/api/analyze", ["src": "source.wav", "locale": "en-US", "kind": "transcript", "force": true]) }
        try await eventually { await gate.count() == 1 }; XCTAssertEqual(policy.snapshot().active, 1); XCTAssertEqual(policy.snapshot().queued, 0)
        try await mutate(fixture); let edited = try Data(contentsOf: fixture.root.appendingPathComponent("reel.project.json"))
        await gate.release()
        do { _ = try await request.value; XCTFail("Stale recognition published a transcript.") } catch { }
        try assertNoSavedTranscript(fixture); XCTAssertEqual(try Data(contentsOf: fixture.root.appendingPathComponent("reel.project.json")), edited)
    }
    func testReadOnlyChangeBlocksTranscriptPublicationAndReleasesAfterExit() async throws {
        let policy = admission(), gate = ProcessingGate(), fixture = try await fixture(policy, recognition: gate)
        let version = await fixture.backend.currentVersion(), before = try Data(contentsOf: fixture.root.appendingPathComponent("reel.project.json"))
        let id = try await start(fixture); try await eventually { await gate.count() == 1 }
        fixture.writes.setBlockedReason("Files conflict"); await gate.release()
        let job = try await finished(fixture, id), afterVersion = await fixture.backend.currentVersion()
        XCTAssertEqual(job["state"] as? String, "failed"); XCTAssertEqual(afterVersion, version)
        try assertNoSavedTranscript(fixture); XCTAssertEqual(try Data(contentsOf: fixture.root.appendingPathComponent("reel.project.json")), before)
        XCTAssertEqual(policy.snapshot().active, 0)
    }
    func testHostedExportCancelNeedsDrainAckAndProgressNeverClaimsCompletionEarly() async throws {
        let policy = admission(), fixture = try await fixture(policy)
        let held = try policy.reserve(capturedBytes: 1)
        defer { held.finish() }
        try await held.wait()
        let job = try await call(fixture, "/api/export", ["renderer": "webcodecs", "name": "Final", "width": 64, "height": 64, "fps": 1, "range": ["in": 0, "out": 1]])
        let id = try XCTUnwrap(job["id"] as? String)
        let queued = try await call(fixture, "/api/export/progress", ["id": id, "progress": 1])
        XCTAssertEqual(queued["state"] as? String, "queued")
        let waiting = try await receipt(fixture, id)
        XCTAssertEqual(waiting["progress"] as? Double, 0)
        held.finish()
        try await waitUntilRunning(fixture, id)
        _ = try await call(fixture, "/api/export/progress", ["id": id, "progress": 1])
        let running = try await receipt(fixture, id); XCTAssertEqual(running["progress"] as? Double, 0.99)
        _ = try await call(fixture, "/api/jobs/cancel", ["id": id]); XCTAssertEqual(policy.snapshot().active, 1)
        do { _ = try await call(fixture, "/api/export/finish", ["id": id, "error": "cancelled"]); XCTFail("Missing exit acknowledgement released admission.") } catch { }
        XCTAssertEqual(policy.snapshot().active, 1)
        let drained = try await call(fixture, "/api/export/finish", ["id": id, "error": "cancelled", "drained": true])
        XCTAssertEqual(drained["draining"] as? Bool, false); XCTAssertEqual(policy.snapshot().active, 0)
    }
    func testHostedAudioCachedDerivativeReusesOwningExportWithoutDeadlock() async throws {
        let policy = admission(), fixture = try await fixture(policy), folder = ProjectFolder(root: fixture.root)
        let source = fixture.root.appendingPathComponent("source.wav")
        let samples = [Float](repeating: 0.125, count: 4800)
        try NativeAudioProcessing.write(.init(channels: [samples, samples]), to: source)
        let sourceBytes = try Data(contentsOf: source)
        let job = try await call(fixture, "/api/export", ["renderer": "webcodecs", "name": "Final", "width": 64, "height": 64, "fps": 1, "range": ["in": 0, "out": 1]])
        let id = try XCTUnwrap(job["id"] as? String); try await waitUntilRunning(fixture, id)
        let cohort = try XCTUnwrap(job["sourceCohortID"] as? String)
        let key = try ProjectFolder.cacheKey(source, "wav-stereo-energy-v2", "0.000", "0.100", "export-cohort:" + cohort + "." + id)
        let audio = folder.cacheDir.appendingPathComponent("audio/\(key).wav")
        try FileManager.default.createDirectory(at: audio.deletingLastPathComponent(), withIntermediateDirectories: true)
        let cached = [Float](repeating: 0.25, count: 4800)
        try NativeAudioProcessing.write(.init(channels: [cached, cached]), to: audio)
        let cachedBytes = try Data(contentsOf: audio)
        let resource = try await fixture.backend.resource(path: "/api/audio", query: ["src": "source.wav", "in": "0", "dur": "0.1", "processingJob": id])
        guard let resource, case .file(let result, _) = resource else { return XCTFail("The cached derivative was not returned.") }
        XCTAssertEqual(result, audio); XCTAssertEqual(policy.snapshot().active, 1); XCTAssertEqual(policy.snapshot().queued, 0)
        XCTAssertEqual(try Data(contentsOf: result), cachedBytes)
        XCTAssertEqual(try Data(contentsOf: source), sourceBytes)
        _ = try await call(fixture, "/api/export/finish", ["id": id, "error": "fixture exited", "drained": true])
        XCTAssertEqual(policy.snapshot().active + policy.snapshot().queued, 0)
    }
    func testActualPageExitCallbackCanReleaseCanceledPreviousBackend() async throws {
        let policy = admission(), fixture = try await fixture(policy)
        let job = try await call(fixture, "/api/export", ["renderer": "webcodecs", "name": "Final", "width": 64, "height": 64, "fps": 1, "range": ["in": 0, "out": 1]])
        try await waitUntilRunning(fixture, XCTUnwrap(job["id"] as? String))
        await fixture.backend.stop(); XCTAssertEqual(policy.snapshot().active, 1)
        let stillOwned = await fixture.backend.hasPageProcessingWorkers(); XCTAssertTrue(stillOwned)
        await fixture.backend.pageProcessingWorkersExited(); XCTAssertEqual(policy.snapshot().active + policy.snapshot().queued, 0)
        let noLongerOwned = await fixture.backend.hasPageProcessingWorkers(); XCTAssertFalse(noLongerOwned)
        XCTAssertEqual(try Data(contentsOf: fixture.root.appendingPathComponent("source.wav")), Data("preserved original".utf8))
    }
    func testPageExitRetainsGlobalExportLeaseUntilNativeAudioChildActuallyReturns() async throws {
        let policy = admission(), fixture = try await fixture(policy), gate = ProcessingGate()
        gates.append(gate)
        await fixture.backend.setProcessingTestBarrier { await gate.visit(); try Task.checkCancellation() }
        let job = try await call(fixture, "/api/export", ["renderer": "webcodecs", "name": "Final", "width": 64, "height": 64, "fps": 1, "range": ["in": 0, "out": 1]])
        let id = try XCTUnwrap(job["id"] as? String)
        try await waitUntilRunning(fixture, id)
        let audio = Task { try await fixture.backend.resource(path: "/api/audio", query: ["src": "source.wav", "in": "0", "dur": "0.1", "processingJob": id]) }
        try await eventually { await gate.count() == 1 }
        let exited = Task { await fixture.backend.pageProcessingWorkersExited() }
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(policy.snapshot().active, 1)
        let held = await fixture.backend.hasPageProcessingWorkers(); XCTAssertTrue(held)
        await gate.release(); _ = try? await audio.value; await exited.value
        XCTAssertEqual(policy.snapshot().active + policy.snapshot().queued, 0)
        let owned = await fixture.backend.hasPageProcessingWorkers(); XCTAssertFalse(owned)
        XCTAssertEqual(try Data(contentsOf: fixture.root.appendingPathComponent("source.wav")), Data("preserved original".utf8))
    }

    func testQueuedNativeExportCancellationAvoidsRendererAndPreservesProject() async throws {
        let policy = admission(), held = try policy.reserve(capturedBytes: 1)
        defer { held.finish() }
        try await held.wait()
        let fixture = try await fixture(policy)
        let before = try Data(contentsOf: fixture.root.appendingPathComponent("reel.project.json"))
        let job = try await call(fixture, "/api/export", ["preset": "h264-high", "name": "Queued", "width": 64, "height": 64, "fps": 1, "range": ["in": 0, "out": 1]])
        let id = try XCTUnwrap(job["id"] as? String)
        XCTAssertEqual(job["state"] as? String, "queued"); XCTAssertEqual(policy.snapshot().queued, 1)
        _ = try await call(fixture, "/api/jobs/cancel", ["id": id])
        let canceled = try await finished(fixture, id)
        XCTAssertEqual(canceled["state"] as? String, "failed"); XCTAssertEqual(policy.snapshot().active, 1); XCTAssertEqual(policy.snapshot().queued, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("renders/Queued.mp4").path))
        XCTAssertEqual(try Data(contentsOf: fixture.root.appendingPathComponent("reel.project.json")), before)
        XCTAssertEqual(try Data(contentsOf: fixture.root.appendingPathComponent("source.wav")), Data("preserved original".utf8))
    }

}
