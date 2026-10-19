import Foundation
import XCTest
@testable import ReelKit

private final class MusicCancellationLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<JSON, Error>?
    private var cancelled = false
    private var finished = false
    func install(_ task: Task<JSON, Error>) {
        lock.lock(); self.task = task; let cancel = cancelled; lock.unlock()
        if cancel { task.cancel() }
    }
    func cancel() {
        lock.lock(); cancelled = true; let owned = task; lock.unlock()
        owned?.cancel()
    }
    func markFinished() { lock.lock(); finished = true; task = nil; lock.unlock() }
    var didCancel: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    var didFinish: Bool { lock.lock(); defer { lock.unlock() }; return finished }
}

private actor MusicCancellationRenderGate {
    private var entered = false
    private var released = false
    private var permit: CheckedContinuation<Void, Never>?
    private var invocations = 0
    private var output: String?
    let cancellation = MusicCancellationLatch()
    func render(folder: ProjectFolder, score: String, script: URL) async throws -> NativeMusicComposer.Rendered {
        invocations += 1
        // Produce actual owned bytes, then delay completion even after cancellation.
        let result = try await NativeMusicComposer.render(folder: folder, scoreJSON: score, scriptURL: script)
        output = result.path; entered = true
        let cancellation = self.cancellation
        await withTaskCancellationHandler {
            if !released { await withCheckedContinuation { permit = $0 } }
        } onCancel: { cancellation.cancel() }
        return result
    }
    func hasEntered() -> Bool { entered }
    func wasCancelled() -> Bool { cancellation.didCancel }
    func count() -> Int { invocations }
    func path() -> String? { output }
    func release() { released = true; permit?.resume(); permit = nil }
}

final class MusicRequestCancellationTests: XCTestCase {
    private struct Fixture {
        let root: URL, backend: ReelBackend, policy: NativeProcessingAdmission
        let originalProject: String, originalFile: Data
    }
    private var fixtures: [Fixture] = []
    private var tasks: [Task<JSON, Error>] = []
    private var gates: [MusicCancellationRenderGate] = []
    private var heldLeases: [NativeProcessingAdmission.Lease] = []
    private let originalSource = "media/original.bin"
    private var score: [String: Any] {
        ["version": 1, "title": "Cancellation fixture", "bpm": 120, "lengthBeats": 1, "seed": 17, "room": 0,
         "parts": [["id": "keys", "instrument": "keys", "gainDb": -12, "pan": 0,
                    "notes": [["at": 0, "duration": 0.5, "pitch": 62, "velocity": 0.7]]]]]
    }
    private func fixture(renderer: ReelBackend.MusicRenderer? = nil, events: @escaping ReelBackend.EventSink = { _, _ in }) async throws -> Fixture {
        let root = try Support.tempFolder("music-cancel-request"), folder = ProjectFolder(root: root)
        let coreURL = try Support.core(), core = try ReelCore(scriptURL: coreURL)
        let original = Data("User-owned original bytes".utf8)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("media"), withIntermediateDirectories: true)
        try original.write(to: root.appendingPathComponent(originalSource))
        var project = try JSON.parse(core.newProject(name: "Preserve original")) as! [String: Any]
        project["assets"] = [originalSource: ["kind": "audio", "hasAudio": true, "hasVideo": false, "duration": 1, "name": "Original"]]
        try Data(core.fileText(project: JSON(any: project).text).utf8).write(to: folder.projectFile)
        let policy = NativeProcessingAdmission(capturedByteLimit: 64 * 1024 * 1024)
        let backend = try ReelBackend(folder: folder, coreScript: coreURL, renderMusic: renderer, processingAdmission: policy, events: events)
        try await backend.start()
        let current = await backend.currentProject()
        let fixture = Fixture(root: root, backend: backend, policy: policy, originalProject: try XCTUnwrap(current), originalFile: original)
        fixtures.append(fixture)
        return fixture
    }
    private func begin(_ fixture: Fixture, latch: MusicCancellationLatch = MusicCancellationLatch()) async -> Task<JSON, Error> {
        let version = await fixture.backend.currentVersion()
        let body = JSON(any: ["score": score, "track": "A3", "start": 0, "comp": NSNull(), "expectedVersion": version]).text
        let task = Task {
            defer { latch.markFinished() }
            return try await fixture.backend.handle(method: "POST", path: "/api/audio/compose", body: body)
        }
        latch.install(task); tasks.append(task)
        return task
    }
    private func eventually(_ message: String, _ predicate: @escaping () async -> Bool) async throws {
        for _ in 0..<500 {
            if await predicate() { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw ReelBackend.APIError(message)
    }
    private func expectCancelled(_ task: Task<JSON, Error>) async {
        do { _ = try await task.value; XCTFail("Cancelled request returned a successful receipt") }
        catch { XCTAssertTrue(error is CancellationError, "Unexpected error: \(error)") }
    }
    private func assertUnchanged(_ fixture: Fixture) async throws {
        let project = await fixture.backend.currentProject()
        XCTAssertEqual(project, fixture.originalProject)
        XCTAssertEqual(try Data(contentsOf: fixture.root.appendingPathComponent(originalSource)), fixture.originalFile)
    }
    private func assertDrained(_ fixture: Fixture) async {
        let state = fixture.policy.snapshot(), workers = await fixture.backend.processingWorkersForTesting()
        XCTAssertEqual(state.active, 0); XCTAssertEqual(state.queued, 0)
        XCTAssertEqual(state.capturedBytes, 0); XCTAssertEqual(state.workerBytes, 0); XCTAssertEqual(workers, 0)
    }
    override func tearDown() async throws {
        for task in tasks { task.cancel() }
        for gate in gates { await gate.release() }
        for lease in heldLeases { lease.finish() }
        for task in tasks { _ = try? await task.value }
        for fixture in fixtures { await fixture.backend.stop() }
        for fixture in fixtures { try? FileManager.default.removeItem(at: fixture.root.deletingLastPathComponent()) }
    }

    func testCancellingQueuedMusicRequestDrainsWithoutEnteringRenderer() async throws {
        let gate = MusicCancellationRenderGate(); gates.append(gate)
        let fixture = try await fixture(renderer: { folder, score, script in try await gate.render(folder: folder, score: score, script: script) })
        let held = try fixture.policy.reserve(capturedBytes: 1); heldLeases.append(held); try await held.wait()
        let task = await begin(fixture)
        try await eventually("Music request did not enter shared admission") { fixture.policy.snapshot().queued == 1 }
        task.cancel(); await expectCancelled(task)
        let count = await gate.count(), workers = await fixture.backend.processingWorkersForTesting()
        XCTAssertEqual(count, 0); XCTAssertEqual(workers, 0)
        XCTAssertEqual(fixture.policy.snapshot().active, 1, "The unrelated owner must keep its lease")
        XCTAssertEqual(fixture.policy.snapshot().queued, 0)
        try await assertUnchanged(fixture)
        held.finish(); await assertDrained(fixture)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("media/generated/music").path))
    }

    func testCancellingRenderedMusicWaitsForOwnedWorkerBeforeCleanupAndAcknowledgement() async throws {
        let gate = MusicCancellationRenderGate(); gates.append(gate)
        let fixture = try await fixture(renderer: { folder, score, script in try await gate.render(folder: folder, score: score, script: script) })
        let completion = MusicCancellationLatch(), task = await begin(fixture, latch: completion)
        try await eventually("Real render did not reach its controlled completion gate") { await gate.hasEntered() }
        let generated = await gate.path(), path = try XCTUnwrap(generated)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent(path).path))
        task.cancel()
        try await eventually("Cancellation did not reach the owned renderer") { await gate.wasCancelled() }
        XCTAssertFalse(completion.didFinish, "Request acknowledged while its renderer remained held")
        XCTAssertEqual(fixture.policy.snapshot().active, 1)
        let workers = await fixture.backend.processingWorkersForTesting(); XCTAssertEqual(workers, 1)
        await gate.release(); await expectCancelled(task)
        XCTAssertTrue(completion.didFinish); await assertDrained(fixture)
        try await assertUnchanged(fixture)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent(path).path))
        let followup = try fixture.policy.reserve(capturedBytes: 1); try await followup.wait(); followup.finish()
        await assertDrained(fixture)
    }

    func testCancellationAtMediaCommitRetainsOwnedMusicAndOriginalSourceWithoutA3Placement() async throws {
        let cancellation = MusicCancellationLatch()
        let fixture = try await fixture(events: { name, text in
            guard name == "project" else { return }
            let fields = parse(text), assets = object(object(fields["project"])["assets"])
            if assets.values.contains(where: { object(object($0)["generated"])["kind"] as? String == "original-music" }) { cancellation.cancel() }
        })
        let task = await begin(fixture, latch: cancellation)
        await expectCancelled(task)
        XCTAssertTrue(cancellation.didCancel); await assertDrained(fixture)
        let current = await fixture.backend.currentProject(), project = parse(try XCTUnwrap(current))
        let original = parse(fixture.originalProject), assets = object(project["assets"])
        XCTAssertEqual(JSON(any: project["tracks"]).text, JSON(any: original["tracks"]).text, "No timeline placement may follow the cancellation boundary")
        XCTAssertEqual(JSON(any: assets[originalSource]).text, JSON(any: object(original["assets"])[originalSource]).text)
        XCTAssertEqual(try Data(contentsOf: fixture.root.appendingPathComponent(originalSource)), fixture.originalFile)
        let added = assets.keys.filter { $0 != originalSource }; XCTAssertEqual(added.count, 1)
        let path = try XCTUnwrap(added.first), asset = object(assets[path])
        let digest = object(asset["generated"])["contentSHA256"] as? String
        let identity = try await NativeMusicIdentity.read(folder: ProjectFolder(root: fixture.root), path: path)
        XCTAssertEqual(identity.contentSHA256, digest)
        XCTAssertEqual(object(project["assets"]).count, 2)
        let a3 = (project["tracks"] as? [[String: Any]] ?? []).first { $0["id"] as? String == "A3" }
        XCTAssertTrue((a3?["clips"] as? [Any] ?? []).isEmpty)
    }
}
