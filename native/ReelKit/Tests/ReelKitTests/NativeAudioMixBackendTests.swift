import Foundation
import XCTest
@testable import ReelKit

private actor MixGate {
    let stage: String
    var arrived = 0
    var released = false
    var waits: [CheckedContinuation<Void, Never>] = []
    init(_ stage: String) { self.stage = stage }
    func visit(_ value: String) async {
        guard value == stage else { return }
        arrived += 1
        if !released { await withCheckedContinuation { waits.append($0) } }
    }
    func count() -> Int { arrived }
    func release() { released = true; let pending = waits; waits = []; for wait in pending { wait.resume() } }
}

final class NativeAudioMixBackendTests: XCTestCase {
    private var folder: ProjectFolder!
    private var backend: ReelBackend!
    private var core: ReelCore!
    private var gates: [MixGate] = []
    private var pageWorkerIDs = Set<String>()
    private var admission: NativeProcessingAdmission!
    override func setUp() async throws {
        folder = ProjectFolder(root: try Support.tempFolder("mix-backend"))
        core = try ReelCore(scriptURL: Support.core())
        for name in ["tone.wav", "other.wav"] {
            let signal = (0..<192_000).map { Float(0.2 * sin(Double($0) * 2 * .pi * 997 / 48000)) }
            try NativeAudioProcessing.write(.init(channels: [signal, signal]), to: folder.root.appendingPathComponent(name))
        }
        var p = try JSON.parse(core.newProject(name: "Mix fixture")) as! [String: Any]
        p["assets"] = ["tone.wav": ["hasAudio": true, "duration": 4], "other.wav": ["hasAudio": true, "duration": 4]]
        p["tracks"] = [
            ["id": "D", "kind": "audio", "name": "Dialogue", "clips": [["id": "voice", "kind": "audio", "src": "tone.wav", "start": 0, "dur": 4, "in": 0, "fx": [["type": "gain", "enabled": true, "params": ["gain": 3]]]]]],
            ["id": "M", "kind": "audio", "name": "Music", "volume": -6, "pan": 0, "clips": [["id": "music", "kind": "audio", "src": "other.wav", "start": 0, "dur": 4, "in": 0, "anim": ["volume": [[0, -2], [3, 1]]], "expr": ["volume": "value+1"], "fadeIn": 0.1]]],
        ]
        // The coherent pre-master peak is about 0.41. A net -2 dB master keeps it times the
        // true-peak FIR bound (2.02) under the -3 dBFS ceiling, so the limiter proves unity gain
        // and skips its per-sample refinement. At -Onone that refinement runs about 2,700
        // samples a second, and one 3.2 s master mix would outlast every wait in this class.
        // Engaged-limiter behavior is covered by the NativeAudioLimiter* tests.
        p["master"] = ["volume": 1, "fx": [["type": "gain", "enabled": true, "params": ["gain": -3]]], "limiter": ["enabled": true, "ceiling": -3]]
        try core.fileText(project: JSON(any: p).text).write(to: folder.projectFile, atomically: true, encoding: .utf8)
        admission = NativeProcessingAdmission()
        backend = try ReelBackend(folder: folder, coreScript: Support.core(), processingAdmission: admission) { _, _ in }
        try await backend.start()
    }
    override func tearDown() async throws {
        for gate in gates { await gate.release() }
        await backend.setAudioMixTestBarrier(nil)
        try? await workersStopped()
        await backend.stop(); await backend.pageProcessingWorkersExited()
    }
    // Lifecycle-only completion checks can measure 0.5 seconds; DSP parity uses the longer range.
    private func request(semantics: String = "playback", output: [String: Any] = ["kind": "master"], to: Double = 3.2) async -> [String: Any] {
        ["comp": NSNull(), "expectedVersion": await backend.currentVersion(), "from": 0.7, "to": to, "semantics": semantics, "output": output, "uiAudioRequestID": UUID().uuidString, "wait": false]
    }
    private func call(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        let response = try await backend.handle(method: body == nil ? "GET" : "POST", path: path, body: body.map { JSON(any: $0).text })
        let result = try JSON.parse(response.text) as? [String: Any] ?? [:]
        if path == "/api/export", body?["renderer"] as? String == "webcodecs", let id = result["id"] as? String {
            pageWorkerIDs.insert(id)
            for _ in 0..<500 {
                let progress = try await backend.handle(method: "POST", path: "/api/export/progress", body: JSON(any: ["id": id, "progress": 0]).text)
                if parse(progress.text)["state"] as? String == "running" { return result }
                try await Task.sleep(for: .milliseconds(10))
            }
            throw ReelBackend.APIError("The fixture page export did not acquire admission.")
        }
        if path == "/api/jobs/cancel", let id = body?["id"] as? String, pageWorkerIDs.remove(id) != nil {
            _ = try await backend.handle(method: "POST", path: "/api/export/finish", body: JSON(any: ["id": id, "error": "cancelled", "drained": true]).text)
        }
        return result
    }
    private func start(_ request: [String: Any]) async throws -> String {
        let result = try await call("/api/audio/measure-mix", request)
        return try XCTUnwrap(result["id"] as? String)
    }
    private func finish(_ id: String) async throws -> [String: Any] {
        for _ in 0..<100 {
            let job = try await call("/api/jobs/wait?id=\(id)&timeout=100")
            if ["done", "failed"].contains(job["state"] as? String ?? "") { return job }
        }
        throw ReelBackend.APIError("The test mix job did not finish.")
    }
    private func waitGate(_ gate: MixGate, count: Int = 1, jobIDs: [String]) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(30))
        let stage = await gate.stage
        var diagnostic = "No job status was returned."
        while clock.now < deadline {
            let arrived = await gate.count()
            if arrived >= count { return }
            let response = try await call("/api/jobs")
            let jobs = (response["jobs"] as? [[String: Any]] ?? []).filter { jobIDs.contains($0["id"] as? String ?? "") }
            diagnostic = JSON(any: jobs.map { job in ["id": job["id"] ?? NSNull(), "state": job["state"] ?? NSNull(), "progress": job["progress"] ?? NSNull(), "error": job["error"] ?? NSNull()] }).text
            if jobs.contains(where: { ["done", "failed"].contains($0["state"] as? String ?? "") }) {
                throw ReelBackend.APIError("The mix job finished before stage \(stage), arrival \(arrived)/\(count). Jobs: \(diagnostic)")
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        let arrived = await gate.count()
        throw ReelBackend.APIError("The mix job did not reach stage \(stage) within 30 seconds, arrival \(arrived)/\(count). Jobs: \(diagnostic)")
    }
    private func workersStopped() async throws {
        for _ in 0..<500 { if await backend.audioMixActiveWorkersForTesting() == 0 { return }; try await Task.sleep(for: .milliseconds(10)) }
        throw ReelBackend.APIError("The canceled workers did not stop.")
    }
    private func canceledWorkersStopped(_ ids: [String]) async throws {
        let expected = Set(ids)
        guard !expected.isEmpty, expected.count == ids.count else { throw ReelBackend.APIError("The fixture must identify each canceled worker once.") }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(5))
        while clock.now < deadline {
            let response = try await call("/api/jobs")
            let jobs = (response["jobs"] as? [[String: Any]] ?? []).filter { expected.contains($0["id"] as? String ?? "") }
            let observed = Set(jobs.compactMap { $0["id"] as? String })
            if clock.now < deadline, jobs.count == expected.count, observed == expected,
               jobs.allSatisfy({ $0["state"] as? String == "failed" && JSON(any: $0["draining"] ?? NSNull()) == .bool(false) }) { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw ReelBackend.APIError("The canceled fixture workers did not stop within five seconds.")
    }
    private func assertNoSnapshots() throws {
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: folder.cacheDir.path).contains { $0.hasPrefix("mix-capture-") })
    }
    private func rejects(_ body: [String: Any]) async {
        do { _ = try await start(body); XCTFail("The invalid mix request was accepted.") } catch { }
    }

    func testAssistantBoundaryHidesActualMixLifecycle() async throws {
        let unavailable = AssistantToolOutput.unavailableJob.text
        for outcome in ["done", "failed", "cancelled"] {
            let gate = MixGate("publishing"); gates.append(gate)
            await backend.setAudioMixTestBarrier { stage in
                await gate.visit(stage)
                if stage == "publishing", outcome == "failed" {
                    throw NSError(domain: NSPOSIXErrorDomain, code: 28, userInfo: [NSLocalizedDescriptionKey: "LOCAL_PRIVATE_COPY_NO_SPACE"])
                }
            }
            let id = try await start(request())
            try await waitGate(gate, jobIDs: [id])
            let before = try await call("/api/jobs/wait?id=\(id)&timeout=0")
            XCTAssertEqual(before["state"] as? String, "running")
            XCTAssertEqual(before["assistantLocalOnly"] as? Bool, true)
            for route in ["/api/jobs/cancel", "/api/analysis/jobs/cancel"] {
                let hidden = try await backend.handleAssistant(method: "POST", path: route, body: JSON.object([("id", .string(id))]).text)
                let absent = try await backend.handleAssistant(method: "POST", path: route, body: JSON.object([("id", "missing")]).text)
                XCTAssertEqual(hidden.text, unavailable); XCTAssertEqual(absent.text, unavailable)
            }
            let stillRunning = try await call("/api/jobs/wait?id=\(id)&timeout=0")
            XCTAssertEqual(stillRunning["state"] as? String, "running", "Assistant cancellation must not alter a private local job")
            if outcome == "cancelled" { _ = try await call("/api/jobs/cancel", ["id": id]) }
            await gate.release()
            let local = try await finish(id)
            XCTAssertEqual(local["state"] as? String, outcome == "done" ? "done" : "failed")
            XCTAssertEqual(local["assistantLocalOnly"] as? Bool, true, "Capture cleanup must not clear provenance")
            if outcome == "done" { XCTAssertNotNil((local["result"] as? [String: Any])?["lufs"]) }
            if outcome == "failed" { XCTAssertTrue((local["error"] as? String)?.contains("LOCAL_PRIVATE_COPY_NO_SPACE") == true) }
            if outcome == "cancelled" { XCTAssertEqual(local["error"] as? String, "cancelled") }
            for route in ["/api/jobs/wait", "/api/analysis/jobs/wait"] {
                let privateReply = try await backend.handleAssistant(method: "GET", path: "\(route)?id=\(id)&timeout=0", body: nil)
                let missingReply = try await backend.handleAssistant(method: "GET", path: "\(route)?id=missing&timeout=0", body: nil)
                XCTAssertEqual(privateReply.text, unavailable); XCTAssertEqual(missingReply.text, unavailable)
            }
            for route in ["/api/jobs", "/api/analysis/jobs", "/api/project"] {
                let reply = try await backend.handleAssistant(method: "GET", path: route, body: nil)
                let fields = try JSON.parse(reply.text) as! [String: Any]
                XCTAssertFalse((fields["jobs"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == id })
                XCTAssertFalse(reply.text.contains("LOCAL_PRIVATE_COPY_NO_SPACE"))
            }
            for route in ["/api/jobs/cancel", "/api/analysis/jobs/cancel"] {
                let reply = try await backend.handleAssistant(method: "POST", path: route, body: JSON.object([("id", .string(id))]).text)
                XCTAssertEqual(reply.text, unavailable)
            }
            try assertNoSnapshots()
        }
    }

    func testMixSettingsRejectCallerProvenanceOverridesBeforeScheduling() async throws {
        let admissions = await backend.audioMixPlanningAdmissionsForTesting()
        for unsupported: [String: Any] in [["kind": "export"], ["assistantLocalOnly": false]] {
            var body = await request()
            for (key, value) in unsupported { body[key] = value }
            do {
                _ = try await start(body)
                XCTFail("Unsupported caller provenance keys must be rejected")
            } catch let error as ReelBackend.APIError {
                XCTAssertTrue(error.message.contains("Unsupported mix measurement settings"))
            }
        }
        let afterAdmissions = await backend.audioMixPlanningAdmissionsForTesting()
        let workers = await backend.audioMixActiveWorkersForTesting()
        XCTAssertEqual(afterAdmissions, admissions); XCTAssertEqual(workers, 0)
        let listed = try await call("/api/jobs")
        XCTAssertTrue((listed["jobs"] as? [[String: Any]] ?? []).isEmpty)
        try assertNoSnapshots()
    }

    func testPrivateWaitReturnsBeforeSuspendedWorkAndDirectRouteCannotStartCapture() async throws {
        let gate = MixGate("snapshot"); gates.append(gate)
        await backend.setAudioMixTestBarrier { await gate.visit($0) }
        let id = try await start(request())
        try await waitGate(gate, jobIDs: [id])
        let returned = MixGate("returned"); await returned.release()
        let wait = Task {
            let value = try await self.backend.handleAssistant(method: "GET", path: "/api/jobs/wait?id=missing&id=\(id)&timeout=60000", body: nil)
            await returned.visit("returned")
            return value
        }
        for _ in 0..<50 { if await returned.count() == 1 { break }; try await Task.sleep(for: .milliseconds(10)) }
        let count = await returned.count()
        XCTAssertEqual(count, 1, "Private wait must return while capture is still suspended")
        wait.cancel()
        if count == 1 { let reply = try await wait.value; XCTAssertEqual(reply, AssistantToolOutput.unavailableJob) }
        let workersBefore = await backend.audioMixActiveWorkersForTesting()
        do {
            _ = try await backend.handleAssistant(method: "POST", path: "/api/audio/measure-mix", body: JSON(any: await request()).text)
            XCTFail("Direct route must remain forbidden")
        } catch { }
        let workersAfter = await backend.audioMixActiveWorkersForTesting()
        XCTAssertEqual(workersAfter, workersBefore)
        _ = try await call("/api/jobs/cancel", ["id": id]); await gate.release(); try await workersStopped()
    }

    func testCallerMarkerAndMixKindCannotHidePermittedAnalysis() async throws {
        for kind in ["loudness", "measure-mix"] {
            let started = try await call("/api/analyze", ["src": "tone.wav", "wait": false, "kind": kind, "assistantLocalOnly": true])
            let id = try XCTUnwrap(started["id"] as? String)
            XCTAssertEqual(started["assistantLocalOnly"] as? Bool, false)
            _ = try await finish(id)
            let reply = try await backend.handleAssistant(method: "GET", path: "/api/jobs/wait?id=\(id)&timeout=0", body: nil)
            let fields = try JSON.parse(reply.text) as! [String: Any]
            XCTAssertEqual(fields["id"] as? String, id); XCTAssertEqual(fields["kind"] as? String, kind)
            XCTAssertEqual(fields["state"] as? String, kind == "loudness" ? "done" : "failed")
            if kind == "loudness" { XCTAssertNotNil(fields["result"]) }
            XCTAssertNil(fields["assistantLocalOnly"])
            let listed = try await backend.handleAssistant(method: "GET", path: "/api/analysis/jobs", body: nil)
            let jobs = (try JSON.parse(listed.text) as? [String: Any])?["jobs"] as? [[String: Any]] ?? []
            XCTAssertTrue(jobs.contains { $0["id"] as? String == id })
        }
    }

    func testPrivateJobsDoNotEvictPublicProjectHistoryRows() async throws {
        let started = try await call("/api/analyze", ["src": "tone.wav", "kind": "loudness", "wait": false])
        let publicID = try XCTUnwrap(started["id"] as? String); _ = try await finish(publicID)
        await backend.setAudioMixTestBarrier { stage in
            if stage == "reserved" { throw NSError(domain: NSPOSIXErrorDomain, code: 28) }
        }
        for _ in 0..<21 { let id = try await start(request()); _ = try await finish(id) }
        let local = try await call("/api/project")
        XCTAssertFalse((local["jobs"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == publicID }, "Fixture must fill the local recent-history bound")
        let reply = try await backend.handleAssistant(method: "GET", path: "/api/project", body: nil)
        let jobs = (try JSON.parse(reply.text) as? [String: Any])?["jobs"] as? [[String: Any]] ?? []
        XCTAssertEqual(jobs.count, 1); XCTAssertEqual(jobs[0]["id"] as? String, publicID)
        try assertNoSnapshots()
    }

    func testPrivateHistoryCannotEvictPublicReceiptWhenWebCodecExportStarts() async throws {
        let started = try await call("/api/analyze", ["src": "tone.wav", "kind": "loudness", "wait": false])
        let publicID = try XCTUnwrap(started["id"] as? String); _ = try await finish(publicID)
        await backend.setAudioMixTestBarrier { stage in
            if stage == "reserved" { throw NSError(domain: NSPOSIXErrorDomain, code: 28) }
        }
        var privateIDs: [String] = []
        for _ in 0..<51 {
            let id = try await start(request()); _ = try await finish(id); privateIDs.append(id)
        }
        let exported = try await call("/api/export", ["renderer": "webcodecs", "name": "retention-public", "width": 64, "height": 64, "fps": 1, "range": ["in": 0, "out": 1]])
        let exportID = try XCTUnwrap(exported["id"] as? String)
        for route in ["/api/jobs", "/api/analysis/jobs", "/api/project"] {
            let response = try await backend.handleAssistant(method: "GET", path: route, body: nil)
            let fields = try JSON.parse(response.text) as? [String: Any] ?? [:]
            let visible = fields["jobs"] as? [[String: Any]] ?? []
            XCTAssertTrue(visible.contains { $0["id"] as? String == publicID }, "Private receipt count must not evict public history")
            XCTAssertFalse(visible.contains { privateIDs.contains($0["id"] as? String ?? "") })
        }
        let waited = try await backend.handleAssistant(method: "GET", path: "/api/jobs/wait?id=\(publicID)&timeout=0", body: nil)
        let publicFields = try JSON.parse(waited.text) as? [String: Any] ?? [:]
        XCTAssertEqual(publicFields["id"] as? String, publicID); XCTAssertEqual(publicFields["state"] as? String, "done")
        let local = try await call("/api/jobs")
        let privateRows = (local["jobs"] as? [[String: Any]] ?? []).filter { $0["assistantLocalOnly"] as? Bool == true }
        XCTAssertEqual(privateRows.count, 50)
        XCTAssertFalse(privateRows.contains { $0["id"] as? String == privateIDs.first })
        XCTAssertTrue(privateRows.contains { $0["id"] as? String == privateIDs.last })
        _ = try await call("/api/jobs/cancel", ["id": exportID]); try assertNoSnapshots()
    }

    func testPublicOnlyWebCodecHistoryRetainsItsExistingFiftyReceiptLimit() async throws {
        var ids: [String] = []
        for index in 0..<51 {
            let export = try await call("/api/export", ["renderer": "webcodecs", "name": "public-\(index)", "width": 64, "height": 64, "fps": 1, "range": ["in": 0, "out": 1]])
            let id = try XCTUnwrap(export["id"] as? String); ids.append(id)
            _ = try await call("/api/jobs/cancel", ["id": id])
        }
        let response = try await backend.handleAssistant(method: "GET", path: "/api/jobs", body: nil)
        let rows = (try JSON.parse(response.text) as? [String: Any])?["jobs"] as? [[String: Any]] ?? []
        XCTAssertEqual(rows.count, 50)
        XCTAssertFalse(rows.contains { $0["id"] as? String == ids.first })
        XCTAssertTrue(rows.contains { $0["id"] as? String == ids.last })
        XCTAssertTrue(rows.allSatisfy { $0["state"] as? String == "failed" })
        try assertNoSnapshots()
    }

    func testPrivateHistoryPruningKeepsCancelledReceiptUntilItsWorkerStops() async throws {
        let gate = MixGate("snapshot"); gates.append(gate)
        await backend.setAudioMixTestBarrier { await gate.visit($0) }
        let activeID = try await start(request()); try await waitGate(gate, jobIDs: [activeID])
        _ = try await call("/api/jobs/cancel", ["id": activeID])
        let before = await backend.audioMixActiveWorkersForTesting(); XCTAssertEqual(before, 1)
        await backend.setAudioMixTestBarrier { stage in
            if stage == "reserved" { throw NSError(domain: NSPOSIXErrorDomain, code: 28) }
        }
        for _ in 0..<51 {
            let id = try await start(request())
            _ = try await call("/api/jobs/cancel", ["id": id])
            for _ in 0..<500 { if await backend.audioMixActiveWorkersForTesting() == 1 { break }; try await Task.sleep(for: .milliseconds(10)) }
        }
        let whileSuspended = try await call("/api/jobs")
        let privateRows = (whileSuspended["jobs"] as? [[String: Any]] ?? []).filter { $0["assistantLocalOnly"] as? Bool == true }
        XCTAssertEqual(privateRows.count, 50)
        XCTAssertTrue(privateRows.contains { $0["id"] as? String == activeID && $0["state"] as? String == "failed" })
        let during = await backend.audioMixActiveWorkersForTesting(); XCTAssertEqual(during, 1)
        await gate.release(); try await workersStopped(); try assertNoSnapshots()
        let finalID = try await start(request()); _ = try await finish(finalID)
        let after = try await call("/api/jobs")
        let finalRows = (after["jobs"] as? [[String: Any]] ?? []).filter { $0["assistantLocalOnly"] as? Bool == true }
        XCTAssertEqual(finalRows.count, 50)
        XCTAssertFalse(finalRows.contains { $0["id"] as? String == activeID }, "A stopped old private receipt can now be pruned")
    }

    func testPrivateSnapshotCopiesStayOutsideProjectEnumerationAndResolver() async throws {
        let baseline = try await call("/api/files?dir=.reel/cache")
        let version = await backend.currentVersion()
        let gate = MixGate("snapshot"); gates.append(gate)
        await backend.setAudioMixTestBarrier { await gate.visit($0) }
        let id = try await start(request()); try await waitGate(gate, jobIDs: [id])
        let privateRoot = await backend.audioMixPrivateStorageRootForTesting()
        let root = try XCTUnwrap(privateRoot)
        let snapshot = root.appendingPathComponent("mix-capture-\(id)")
        let copies = try FileManager.default.contentsOfDirectory(at: snapshot, includingPropertiesForKeys: nil)
        XCTAssertEqual(copies.count, 2)
        let copy = try XCTUnwrap(copies.first)
        XCTAssertGreaterThan(try Data(contentsOf: copy).count, 0)
        XCTAssertFalse(folder.contains(root)); XCTAssertFalse(folder.contains(snapshot))
        XCTAssertThrowsError(try folder.resolve(copy.path))
        let during = try await call("/api/files?dir=.reel/cache")
        XCTAssertEqual(during["dir"] as? String, baseline["dir"] as? String)
        XCTAssertTrue((baseline["entries"] as? [[String: Any]] ?? []).isEmpty)
        XCTAssertTrue((during["entries"] as? [[String: Any]] ?? []).isEmpty)
        for outside in [root, snapshot, copy] {
            var target = URLComponents(); target.path = "/api/files"
            target.queryItems = [URLQueryItem(name: "dir", value: outside.path)]
            do {
                _ = try await backend.handleAssistant(method: "GET", path: try XCTUnwrap(target.string), body: nil)
                XCTFail("A private path must stay outside the project file API")
            } catch is ProjectFolder.OutsideProject { }
        }
        let imported = try await call("/api/import", ["paths": [copy.path]])
        XCTAssertTrue((imported["assets"] as? [String: Any] ?? [:]).isEmpty)
        XCTAssertFalse((imported["failures"] as? [[String: Any]] ?? []).isEmpty)
        let link = folder.root.appendingPathComponent("private-copy.wav")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: copy)
        defer { try? FileManager.default.removeItem(at: link) }
        XCTAssertThrowsError(try folder.resolve(link.path))
        let plan = JSON(any: ["buses": [["items": [["src": link.lastPathComponent]]]]]).text
        XCTAssertThrowsError(try NativeAudioMixCapture.sources(plan: plan, folder: folder, diskLimit: UInt64.max))
        let afterImportVersion = await backend.currentVersion(); XCTAssertEqual(afterImportVersion, version)
        await gate.release()
        let finished = try await finish(id); XCTAssertEqual(finished["state"] as? String, "done")
        XCTAssertNotNil((finished["result"] as? [String: Any])?["lufs"], "The private folder must actually render its copied WAV sources")
        try await workersStopped()
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshot.path))
        let after = try await call("/api/files?dir=.reel/cache")
        XCTAssertEqual(after["dir"] as? String, baseline["dir"] as? String)
        XCTAssertTrue((after["entries"] as? [[String: Any]] ?? []).isEmpty)
    }

    func testPrivateSnapshotLifetimeSurvivesCancellationAndProjectCloseUntilWorkerExit() async throws {
        for operation in ["cancel", "close"] {
            let gate = MixGate("snapshot"); gates.append(gate)
            await backend.setAudioMixTestBarrier { await gate.visit($0) }
            let id = try await start(request()); try await waitGate(gate, jobIDs: [id])
            let privateRoot = await backend.audioMixPrivateStorageRootForTesting()
            let root = try XCTUnwrap(privateRoot)
            let snapshot = root.appendingPathComponent("mix-capture-\(id)")
            if operation == "cancel" { _ = try await call("/api/jobs/cancel", ["id": id]) }
            else { await backend.stop() }
            XCTAssertTrue(FileManager.default.fileExists(atPath: root.path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: snapshot.path), "A suspended worker still owns its snapshot")
            await gate.release()
            let removed = operation == "close" ? root : snapshot
            var disappeared = false
            for _ in 0..<500 {
                if !FileManager.default.fileExists(atPath: removed.path) { disappeared = true; break }
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertTrue(disappeared, "Owned storage must be removed after actual worker release")
            if operation == "cancel" { try await workersStopped() }
        }
    }

    func testMixMatchesIndependentStagePCMAndHasNoHistoryOrOutputs() async throws {
        let before = await backend.currentProject(), version = await backend.currentVersion()
        let diskBefore = try Data(contentsOf: folder.projectFile)
        for semantics in ["playback", "export"] {
            let outputs: [[String: Any]] = [["kind": "master"], ["kind": "track", "id": "M"]]
            for output in outputs {
                let body = await request(semantics: semantics, output: output)
                let id = try await start(body)
                let job = try await finish(id)
                XCTAssertEqual(job["state"] as? String, "done")
                XCTAssertNil(job["output"]); XCTAssertNil(job["applied"])
                let result = try XCTUnwrap(job["result"] as? [String: Any])
                let snapshot = try XCTUnwrap(before)
                func filtered(_ text: String) throws -> String {
                    var graph = try JSON.parse(text) as! [String: Any]
                    if output["kind"] as? String == "track" {
                        graph["buses"] = (graph["buses"] as? [[String: Any]] ?? []).filter { $0["id"] as? String == "M" }
                        graph["master"] = ["gain": 1, "chain": []]
                    }
                    return JSON(any: graph).text
                }
                let overview = try filtered(core.audioPlan(project: snapshot, from: 0, to: 3.2))
                let history = try NativeAudioMixer.previewHistory(plan: .raw(overview))
                let begin = history.requiresOrigin ? 0 : floor(max(0, 0.7 - history.seconds) * 48000) / 48000
                let end = ceil((3.2 + history.future) * 48000) / 48000
                let graph = try filtered(core.audioPlan(project: snapshot, from: begin, to: end))
                let pcm = try await NativeAudioMixer.render(plan: .raw(graph), folder: folder, preview: semantics == "playback")
                let a = try XCTUnwrap(result["sampleStart"] as? Int), b = try XCTUnwrap(result["sampleEnd"] as? Int)
                let actual = try NativeAudioProcessing.measure(.init(channels: pcm.channels.map { Array($0[a..<b]) }, rate: pcm.rate))
                XCTAssertEqual((result["lufs"] as? NSNumber)?.doubleValue ?? 0, actual.integrated, accuracy: 1e-7)
                XCTAssertEqual((result["truePeak"] as? NSNumber)?.doubleValue ?? 0, actual.peak, accuracy: 1e-7)
                XCTAssertEqual(result["sampleCount"] as? Int, b-a)
                XCTAssertEqual(result["uiAudioRequestID"] as? String, body["uiAudioRequestID"] as? String)
                XCTAssertEqual(result["semantics"] as? String, semantics)
                try assertNoSnapshots()
            }
        }
        let finalProject = await backend.currentProject(), finalVersion = await backend.currentVersion()
        XCTAssertEqual(finalProject, before)
        XCTAssertEqual(finalVersion, version)
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), diskBefore)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.rendersDir.path))
    }

    func testProjectEditUndoAndDiskReloadDiscardSuspendedCaptures() async throws {
        for kind in ["edit", "undo", "disk"] {
            let gate = MixGate("snapshot")
            gates.append(gate)
            await backend.setAudioMixTestBarrier { await gate.visit($0) }
            let id = try await start(request())
            try await waitGate(gate, jobIDs: [id])
            if kind == "disk" {
                let current = await backend.currentProject()
                var fields = try JSON.parse(try XCTUnwrap(current)) as! [String: Any]
                fields["name"] = "Changed on disk"
                try JSON(any: fields).text.write(to: folder.projectFile, atomically: true, encoding: .utf8)
                try await backend.refreshProjectFile()
            } else {
                _ = try await call("/api/ops", ["ops": [["op": "project", "set": ["name": "Changed"]]], "expectedVersion": await backend.currentVersion()])
                if kind == "undo" { _ = try await call("/api/undo", [:]) }
            }
            await gate.release()
            let job = try await finish(id)
            XCTAssertEqual(job["state"] as? String, "failed"); XCTAssertNil(job["result"])
            try assertNoSnapshots()
        }
        await backend.setAudioMixTestBarrier(nil)
    }

    func testSourceBytesAliasAndLateDriftDiscardWithoutOutputs() async throws {
        let original = try Data(contentsOf: folder.root.appendingPathComponent("tone.wav"))
        for stage in ["reserved", "snapshot", "rendered", "measured", "publishing"] {
            let gate = MixGate(stage)
            gates.append(gate)
            await backend.setAudioMixTestBarrier { await gate.visit($0) }
            let id = try await start(request())
            try await waitGate(gate, jobIDs: [id])
            var changed = original; changed[changed.count-10] ^= 1
            try changed.write(to: folder.root.appendingPathComponent("tone.wav"))
            await gate.release()
            let job = try await finish(id)
            XCTAssertEqual(job["state"] as? String, "failed"); XCTAssertNil(job["result"])
            try assertNoSnapshots()
            try original.write(to: folder.root.appendingPathComponent("tone.wav"))
        }
        let source = folder.root.appendingPathComponent("tone.wav")
        try FileManager.default.moveItem(at: source, to: folder.root.appendingPathComponent("stable.wav"))
        try FileManager.default.createSymbolicLink(atPath: source.path, withDestinationPath: "stable.wav")
        let gate = MixGate("snapshot")
            gates.append(gate)
        await backend.setAudioMixTestBarrier { await gate.visit($0) }
        let id = try await start(request())
        try await waitGate(gate, jobIDs: [id])
        try FileManager.default.removeItem(at: source)
        try FileManager.default.createSymbolicLink(atPath: source.path, withDestinationPath: "other.wav")
        await gate.release()
        let aliasJob = try await finish(id)
        XCTAssertEqual(aliasJob["state"] as? String, "failed")
        try assertNoSnapshots()
    }

    func testCancellationHoldsActiveLeaseAndQueuedCancellationFreesOnlyWaitingSlots() async throws {
        let gate = MixGate("reserved"); gates.append(gate)
        await backend.setAudioMixTestBarrier { await gate.visit($0) }
        var ids: [String] = []
        for _ in 0..<8 { ids.append(try await start(request())) }
        try await waitGate(gate, jobIDs: [ids[0]])
        await rejects(request())
        XCTAssertEqual(admission.snapshot().active, 1); XCTAssertEqual(admission.snapshot().queued, 7)
        for id in ids { _ = try await call("/api/jobs/cancel", ["id": id]) }
        for _ in 0..<500 { if await backend.audioMixActiveWorkersForTesting() == 1 { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(admission.snapshot().active, 1); XCTAssertEqual(admission.snapshot().queued, 0)
        let nextID = try await start(request())
        let next = try await call("/api/jobs/wait?id=\(nextID)&timeout=0")
        XCTAssertEqual(next["state"] as? String, "queued")
        await backend.setAudioMixTestBarrier(nil); await gate.release()
        try await canceledWorkersStopped(ids)
        let nextJob = try await finish(nextID); XCTAssertEqual(nextJob["state"] as? String, "done")
        try await workersStopped()
        try assertNoSnapshots()
        for id in ids {
            let job = try await finish(id)
            XCTAssertEqual(job["state"] as? String, "failed")
            XCTAssertEqual(job["error"] as? String, "cancelled")
            XCTAssertNil(job["result"])
        }
    }

    func testSharedMixReservationRejectsBeforeCopyAndSurvivesCancellation() async throws {
        let gate = MixGate("reserved")
        gates.append(gate)
        await backend.setAudioMixTestBarrier { await gate.visit($0) }
        let id = try await start(request())
        try await waitGate(gate, jobIDs: [id])
        let bytes = await backend.audioMixReservedBytesForTesting()
        let projectValue = await backend.currentProject()
        let retainedProject = try XCTUnwrap(projectValue)
        XCTAssertGreaterThan(bytes, UInt64(retainedProject.utf8.count) * 2)
        await backend.setAudioMixMemoryLimitForTesting(bytes + 1024)
        let admissions = await backend.audioMixPlanningAdmissionsForTesting()
        await rejects(request())
        let afterAdmissions = await backend.audioMixPlanningAdmissionsForTesting()
        XCTAssertEqual(afterAdmissions, admissions)
        try assertNoSnapshots()
        _ = try await call("/api/jobs/cancel", ["id": id])
        let retained = await backend.audioMixReservedBytesForTesting()
        XCTAssertEqual(retained, bytes)
        await rejects(request())
        await gate.release(); try await workersStopped()
        let released = await backend.audioMixReservedBytesForTesting()
        XCTAssertEqual(released, 0)
        await backend.setAudioMixMemoryLimitForTesting(NativeAudioMixer.memoryLimitBytes)
        await backend.setAudioMixTestBarrier(nil)
        let next = try await start(request(to: 1.2)), job = try await finish(next)
        XCTAssertEqual(job["state"] as? String, "done")
        try assertNoSnapshots()
    }

    func testCancelAfterPrivateCopyRenderAndMeasureRemovesSnapshotsAfterWorkerStops() async throws {
        for stage in ["snapshot", "rendered", "measured", "publishing"] {
            let gate = MixGate(stage)
            gates.append(gate)
            await backend.setAudioMixTestBarrier { await gate.visit($0) }
            let id = try await start(request())
            try await waitGate(gate, jobIDs: [id])
            let retained = await backend.audioMixReservedBytesForTesting()
            XCTAssertGreaterThan(retained, 0)
            _ = try await call("/api/jobs/cancel", ["id": id])
            let occupied = await backend.audioMixReservedBytesForTesting()
            XCTAssertEqual(occupied, retained)
            await gate.release(); try await workersStopped()
            let job = try await finish(id)
            XCTAssertNil(job["result"]); XCTAssertNil(job["output"])
            try assertNoSnapshots()
        }
    }

    func testMutedTrackReportsNullSilenceAndExplicitNestedScopeUsesItsOwnBus() async throws {
        _ = try await call("/api/ops", ["ops": [["op": "update_track", "id": "M", "comp": NSNull(), "set": ["muted": true]]]])
        let silentID = try await start(request(output: ["kind": "track", "id": "M"]))
        let silentJob = try await finish(silentID)
        let silent = try XCTUnwrap(silentJob["result"] as? [String: Any])
        XCTAssertTrue(silent["lufs"] is NSNull); XCTAssertTrue(silent["truePeak"] is NSNull); XCTAssertTrue(silent["lra"] is NSNull)
        XCTAssertEqual(silent["silence"] as? Bool, true)
        _ = try await call("/api/ops", ["ops": [["op": "update_track", "id": "M", "comp": NSNull(), "set": ["muted": false]]]])
        let current = await backend.currentProject()
        let fields = try JSON.parse(try XCTUnwrap(current)) as! [String: Any]
        var tracks = fields["tracks"] as! [[String: Any]]
        tracks[1]["volume"] = 8
        let nested: [String: Any] = ["tracks": tracks, "width": 1920, "height": 1080, "fps": 30, "duration": 4]
        _ = try await call("/api/ops", ["ops": [["op": "project", "set": ["comps": ["nest": nested]]]]])
        let before = await backend.currentProject(), version = await backend.currentVersion()
        let mainID = try await start(request(output: ["kind": "track", "id": "M"]))
        let mainJob = try await finish(mainID), main = try XCTUnwrap(mainJob["result"] as? [String: Any])
        var body = await request(output: ["kind": "track", "id": "M"]); body["comp"] = "nest"
        let nestedID = try await start(body), nestedJob = try await finish(nestedID)
        let result = try XCTUnwrap(nestedJob["result"] as? [String: Any])
        XCTAssertEqual(result["comp"] as? String, "nest")
        let delta = try XCTUnwrap((result["lufs"] as? NSNumber)?.doubleValue) - XCTUnwrap((main["lufs"] as? NSNumber)?.doubleValue)
        XCTAssertEqual(delta, 14, accuracy: 0.02)
        let after = await backend.currentProject(), finalVersion = await backend.currentVersion()
        XCTAssertEqual(after, before); XCTAssertEqual(finalVersion, version)
        try assertNoSnapshots()
    }

    func testInvalidVersionUnsupportedSettingsAndBudgetAreRejectedBeforeQueue() async throws {
        var invalid = await request(); invalid["expectedVersion"] = true; await rejects(invalid)
        invalid = await request(); invalid["expectedVersion"] = 1.5; await rejects(invalid)
        invalid = await request(); invalid["comp"] = nil; await rejects(invalid)
        invalid = await request(); invalid["semantics"] = "source"; await rejects(invalid)
        invalid = await request(); invalid["output"] = ["kind": "tracks", "ids": ["D", "M"]]; await rejects(invalid)
        invalid = await request(); invalid["rate"] = 96000; await rejects(invalid)
        invalid = await request(); invalid["apply"] = true; await rejects(invalid)
        invalid = await request(); invalid["apply"] = 0; await rejects(invalid)
        invalid = await request(); invalid["wait"] = 0; await rejects(invalid)
        let current = await backend.currentProject()
        let graph = try core.audioPlan(project: XCTUnwrap(current), from: 0, to: 1)
        XCTAssertThrowsError(try NativeAudioMixCapture.validateMemory(plan: graph, croppedFrames: 48_000, limit: 1024))
        XCTAssertThrowsError(try NativeAudioMixCapture.sources(plan: graph, folder: folder, diskLimit: 10))
        XCTAssertThrowsError(try NativeAudioMixCapture.strictVersion(NSNumber(value: true)))
    }

    func testSharedDiskLeaseRejectsBeforeCopiesAndSurvivesCancellation() async throws {
        let gate = MixGate("reserved")
        gates.append(gate)
        await backend.setAudioMixTestBarrier { await gate.visit($0) }
        let id = try await start(request())
        try await waitGate(gate, jobIDs: [id])
        let bytes = await backend.audioMixReservedDiskBytesForTesting()
        XCTAssertGreaterThan(bytes, 0)
        await backend.setAudioMixDiskLimitForTesting(bytes)
        await rejects(request())
        try assertNoSnapshots()
        _ = try await call("/api/jobs/cancel", ["id": id])
        let retained = await backend.audioMixReservedDiskBytesForTesting()
        XCTAssertEqual(retained, bytes)
        await rejects(request())
        await gate.release()
        try await workersStopped()
        let released = await backend.audioMixReservedDiskBytesForTesting()
        XCTAssertEqual(released, 0)
        await backend.setAudioMixDiskLimitForTesting(nil)
        await backend.setAudioMixTestBarrier(nil)
        let next = try await start(request())
        let job = try await finish(next)
        XCTAssertEqual(job["state"] as? String, "done")
        try assertNoSnapshots()
    }

    func testRequestUUIDCannotBeReusedForAnotherOwnedJob() async throws {
        let body = await request(to: 1.2)
        let id = try await start(body)
        let job = try await finish(id)
        XCTAssertEqual(job["state"] as? String, "done")
        await rejects(body)
        try await workersStopped()
        try assertNoSnapshots()
    }

    func testDuckPlanningSharesAdmissionAndRejectsBeforeExpansionWithoutEdits() async throws {
        let gate = MixGate("reserved")
        gates.append(gate)
        await backend.setAudioMixTestBarrier { await gate.visit($0) }
        let id = try await start(request())
        try await waitGate(gate, jobIDs: [id])
        let bytes = await backend.audioMixReservedBytesForTesting()
        await backend.setAudioMixMemoryLimitForTesting(bytes + 1024)
        let admissions = await backend.audioMixPlanningAdmissionsForTesting()
        let before = await backend.currentProject(), version = await backend.currentVersion()
        let fileBefore = try String(contentsOf: folder.projectFile, encoding: .utf8)
        let body: [String: Any] = ["comp": NSNull(), "expectedVersion": version, "from": 0, "to": 4, "dialogueTrackIDs": ["D"], "musicClipIDs": ["music"], "settings": ["amount": 12, "attack": 0.15, "hold": 0.1, "mergeGap": 0.1, "release": 0.4]]
        do { _ = try await call("/api/audio/duck-plan", body); XCTFail("Ducking expanded a plan without available admission memory.") } catch { }
        let afterAdmissions = await backend.audioMixPlanningAdmissionsForTesting()
        let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
        let retained = await backend.audioMixReservedBytesForTesting()
        XCTAssertEqual(afterAdmissions, admissions)
        XCTAssertEqual(after, before); XCTAssertEqual(afterVersion, version)
        XCTAssertEqual(try String(contentsOf: folder.projectFile, encoding: .utf8), fileBefore)
        XCTAssertEqual(retained, bytes)
        _ = try await call("/api/jobs/cancel", ["id": id])
        await gate.release(); try await workersStopped()
        await backend.setAudioMixMemoryLimitForTesting(NativeAudioMixer.memoryLimitBytes)
        let plan = try await call("/api/audio/duck-plan", body)
        XCTAssertFalse((plan["operations"] as? [Any] ?? []).isEmpty)
        let released = await backend.audioMixReservedBytesForTesting()
        XCTAssertEqual(released, 0)
        _ = try await call("/api/undo", [:])
        let undone = await backend.currentProject(), undoVersion = await backend.currentVersion()
        XCTAssertEqual(undone, before); XCTAssertEqual(undoVersion, version)
        try assertNoSnapshots()
    }

    func testDuckPlanIsReadOnlyAndAppliesOneAtomicUndoableBatch() async throws {
        let captured = await backend.currentProject(), version = await backend.currentVersion()
        let before = try XCTUnwrap(captured)
        let body: [String: Any] = ["comp": NSNull(), "expectedVersion": version, "from": 0, "to": 4, "dialogueTrackIDs": ["D"], "musicClipIDs": ["music"], "settings": ["amount": 12, "attack": 0.15, "hold": 0.1, "mergeGap": 0.1, "release": 0.4]]
        let plan = try await call("/api/audio/duck-plan", body)
        let unchanged = await backend.currentProject(), unchangedVersion = await backend.currentVersion()
        XCTAssertEqual(unchanged, before); XCTAssertEqual(unchangedVersion, version)
        let operations = try XCTUnwrap(plan["operations"] as? [[String: Any]])
        XCTAssertEqual(operations.count, 1)
        _ = try await call("/api/ops", ["ops": operations, "expectedVersion": version])
        let after = await backend.currentProject()
        _ = try await call("/api/undo", [:]); let undone = await backend.currentProject(); XCTAssertEqual(undone, before)
        _ = try await call("/api/redo", [:]); let redone = await backend.currentProject(); XCTAssertEqual(redone, after)
        var again = body; again["expectedVersion"] = await backend.currentVersion()
        let repeated = try await call("/api/audio/duck-plan", again)
        XCTAssertTrue((repeated["operations"] as? [Any] ?? ["invalid"]).isEmpty)
        try assertNoSnapshots()
    }
    func testQueuedMixDoesNotExpandAudioPlanBeforeAcquiringGlobalWorkerLease() async throws {
        let held = try admission.reserve(capturedBytes: 1)
        defer { held.finish() }
        try await held.wait()
        let before = await backend.audioMixPlanningAdmissionsForTesting()
        let id = try await start(request(to: 1.2))
        let queued = try await call("/api/jobs/wait?id=\(id)&timeout=0")
        XCTAssertEqual(queued["state"] as? String, "queued")
        let whileWaiting = await backend.audioMixPlanningAdmissionsForTesting()
        XCTAssertEqual(whileWaiting, before)
        XCTAssertEqual(admission.snapshot().active, 1); XCTAssertEqual(admission.snapshot().queued, 1)
        held.finish()
        let result = try await finish(id)
        XCTAssertEqual(result["state"] as? String, "done")
        let after = await backend.audioMixPlanningAdmissionsForTesting()
        XCTAssertEqual(after, before + 1)
        try await workersStopped(); try assertNoSnapshots()
    }

}
