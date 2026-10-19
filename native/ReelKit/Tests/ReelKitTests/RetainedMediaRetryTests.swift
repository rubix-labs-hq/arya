import Darwin
import Foundation
import XCTest
@testable import ReelKit

final class RetainedMediaRetryTests: XCTestCase {
    private final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var blocked = false, armed = false, probes = 0
        func arm() { lock.lock(); armed = true; lock.unlock() }
        func clear() { lock.lock(); blocked = false; lock.unlock() }
        func probe() { lock.lock(); probes += 1; if armed { blocked = true; armed = false }; lock.unlock() }
        func count() -> Int { lock.lock(); defer { lock.unlock() }; return probes }
        func check() throws { lock.lock(); defer { lock.unlock() }; if blocked { throw ReelBackend.APIError("Synthetic write admission failed after the completed copy") } }
    }
    private func source(_ folder: URL, name: String, bytes: UInt8 = 0x61) throws -> URL {
        let url = folder.appendingPathComponent(name)
        try Data(repeating: bytes, count: 100).write(to: url)
        return url
    }
    private func backend(_ root: URL, gate: Gate = Gate()) throws -> ReelBackend {
        try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), probe: { url in
            gate.probe()
            let data = try Data(contentsOf: url)
            if data.first == 0x62 { throw ReelBackend.APIError("Synthetic invalid media") }
            return .object([("size", .int(data.count)), ("width", 1), ("height", 1), ("still", true), ("hasVideo", false), ("hasAudio", false)])
        }, writeAdmission: { try gate.check() }) { _, _ in }
    }

    func testStaleAdmissionRejectsBeforeProbeAndDispatchValidatesVersion() async throws {
        let root = try Support.tempFolder("retained-stale")
        defer { try? FileManager.default.removeItem(at: root) }
        _ = try source(root, name: "existing.png")
        let gate = Gate(), b = try backend(root, gate: gate); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"First\"}")
        let stale = await b.currentVersion()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Changed\"}")
        let saved = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        do { _ = try await b.importMedia(["existing.png"], expectedVersion: stale); XCTFail("Stale admission registered into the changed project") }
        catch { XCTAssertTrue(error.localizedDescription.contains("before this import was admitted")) }
        XCTAssertEqual(gate.count(), 0)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), saved)
        for raw in ["true", "1.5", "-1", "\"2\""] {
            do { _ = try await b.handle(method: "POST", path: "/api/import", body: "{\"paths\":[\"existing.png\"],\"expectedVersion\":\(raw)}"); XCTFail("Invalid dispatch version admitted") }
            catch { XCTAssertTrue(error.localizedDescription.contains("valid captured project version")) }
        }
        XCTAssertEqual(gate.count(), 0)
        // Existing callers that omit expectedVersion keep working.
        let compatible = parse(try await b.importMedia(["existing.png"]).text)
        XCTAssertNotNil(object(compatible["assets"])["existing.png"])
        await b.stop()
    }

    func testTypedFailedCopyRetriesSamePathWithoutCreatingAnotherCopy() async throws {
        let root = try Support.tempFolder("retained-copy"), outside = try Support.tempFolder("retained-copy-source")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: outside) }
        let selected = try source(outside, name: "cafe? take.png"), bytes = try Data(contentsOf: selected)
        XCTAssertEqual(ProjectFolder.cleanFileName(selected.lastPathComponent), "cafe_ take.png")
        let gate = Gate(), b = try backend(root, gate: gate); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        let version = await b.currentVersion(), project = await b.currentProject()
        let saved = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        gate.arm()
        var retained: ReelBackend.RetainedMediaCopiesError?
        do { _ = try await b.copyIn([selected]); XCTFail("Synthetic failed registration succeeded") }
        catch let error as ReelBackend.RetainedMediaCopiesError { retained = error }
        let failure = try XCTUnwrap(retained)
        XCTAssertEqual(Set(failure.retainedCopyIdentities.keys), Set(failure.unregisteredCopies))
        XCTAssertEqual(failure.unregisteredCopies, ["media/cafe_ take.png"])
        XCTAssertEqual(failure.rootPath, root.standardizedFileURL.path)
        XCTAssertEqual(failure.version, version); XCTAssertEqual(failure.projectJSON, project)
        XCTAssertEqual(try Data(contentsOf: selected), bytes)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(failure.unregisteredCopies[0])), bytes)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), saved)
        gate.clear()
        let receipt = parse(try await b.importMedia(failure.unregisteredCopies, expectedVersion: failure.version, retainedCopyIdentities: failure.retainedCopyIdentities).text)
        XCTAssertEqual(Set(object(receipt["assets"]).keys), Set(failure.unregisteredCopies))
        XCTAssertEqual(receipt["version"] as? Int, version + 1)
        let mediaNames = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("media").path)
        XCTAssertEqual(mediaNames, ["cafe_ take.png"])
        XCTAssertEqual(try Data(contentsOf: selected), bytes)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(failure.unregisteredCopies[0])), bytes)
        let current = await b.currentProject()
        XCTAssertNotNil(object(parse(try XCTUnwrap(current))["assets"])[failure.unregisteredCopies[0]])
        await b.stop()
    }

    func testPartialReceiptNamesOnlyUnregisteredCopyAndFailedRetryKeepsIt() async throws {
        let root = try Support.tempFolder("retained-partial"), outside = try Support.tempFolder("retained-partial-source")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: outside) }
        let good = try source(outside, name: "good.png"), bad = try source(outside, name: "bad.png", bytes: 0x62)
        let b = try backend(root); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Partial\"}")
        let receipt = parse(try await b.copyIn([good, bad]).text)
        XCTAssertEqual(Set(object(receipt["assets"]).keys), ["media/good.png"])
        XCTAssertEqual(receipt["unregisteredCopies"] as? [String], ["media/bad.png"])
        let version = await b.currentVersion(), saved = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        let identities = try XCTUnwrap(receipt["retainedCopyIdentities"] as? [String: String])
        do { _ = try await b.importMedia(["media/bad.png"], expectedVersion: version, retainedCopyIdentities: identities); XCTFail("Invalid exact retry registered") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Synthetic invalid media")) }
        let afterVersion = await b.currentVersion(); XCTAssertEqual(afterVersion, version)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), saved)
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("media").path)), ["good.png", "bad.png"])
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("media/bad.png")), try Data(contentsOf: bad))
        await b.stop()
    }
    private actor ProbePause {
        private var enabled = false, entered = false
        private var continuation: CheckedContinuation<Void, Never>?
        func enable() { enabled = true }
        func pause() async { if enabled { entered = true; await withCheckedContinuation { continuation = $0 } } }
        func waitForEntry() async throws {
            let deadline = Date().addingTimeInterval(5)
            while !entered { guard Date() < deadline else { throw ReelBackend.APIError("Retry probe did not start") }; await Task.yield() }
        }
        func release() { continuation?.resume(); continuation = nil; enabled = false }
    }

    func testRetainedFileReplacedByDirectoryRejectsBeforeProbeAndNeverRecurses() async throws {
        let root = try Support.tempFolder("retained-directory"), outside = try Support.tempFolder("retained-directory-source")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: outside) }
        let selected = try source(outside, name: "take.png")
        let gate = Gate(), b = try backend(root, gate: gate); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        gate.arm()
        var retained: ReelBackend.RetainedMediaCopiesError?
        do { _ = try await b.copyIn([selected]); XCTFail("Expected failed copy registration") }
        catch let error as ReelBackend.RetainedMediaCopiesError { retained = error }
        let failure = try XCTUnwrap(retained), path = try XCTUnwrap(failure.unregisteredCopies.first)
        gate.clear()
        let target = root.appendingPathComponent(path), kept = root.appendingPathComponent("kept-original.png")
        try FileManager.default.moveItem(at: target, to: kept)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        _ = try source(target, name: "unrequested.png")
        let bytes = try Data(contentsOf: root.appendingPathComponent("reel.project.json")), probes = gate.count()
        do { _ = try await b.importMedia(failure.unregisteredCopies, expectedVersion: failure.version, retainedCopyIdentities: failure.retainedCopyIdentities); XCTFail("Directory replacement was recursively imported") }
        catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        XCTAssertEqual(gate.count(), probes)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), bytes)
        let project = await b.currentProject(); XCTAssertTrue(object(parse(try XCTUnwrap(project))["assets"]).isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.appendingPathComponent("unrequested.png").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: kept.path))
        // Ordinary callers still retain folder import behavior.
        let ordinary = parse(try await b.importMedia([path]).text)
        XCTAssertNotNil(object(ordinary["assets"])[path + "/unrequested.png"])
        await b.stop()
    }

    func testRetainedFileReplacedDuringDeferredProbeRejectsBeforeCommit() async throws {
        let root = try Support.tempFolder("retained-probe-directory"), outside = try Support.tempFolder("retained-probe-source")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: outside) }
        let selected = try source(outside, name: "take.png"), bytes = try Data(contentsOf: selected)
        let gate = Gate(), pause = ProbePause()
        let b = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), probe: { url in
            gate.probe(); await pause.pause()
            return .object([("size", .int(try Data(contentsOf: url).count)), ("width", 1), ("height", 1), ("still", true), ("hasVideo", false), ("hasAudio", false)])
        }, writeAdmission: { try gate.check() }) { _, _ in }
        try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        gate.arm()
        var retained: ReelBackend.RetainedMediaCopiesError?
        do { _ = try await b.copyIn([selected]); XCTFail("Expected failed copy registration") }
        catch let error as ReelBackend.RetainedMediaCopiesError { retained = error }
        let failure = try XCTUnwrap(retained), target = root.appendingPathComponent(try XCTUnwrap(failure.unregisteredCopies.first))
        gate.clear(); await pause.enable()
        let saved = try Data(contentsOf: root.appendingPathComponent("reel.project.json"))
        let task = Task { try await b.importMedia(failure.unregisteredCopies, expectedVersion: failure.version, retainedCopyIdentities: failure.retainedCopyIdentities) }
        let kept = root.appendingPathComponent("kept-original.png")
        do {
            try await pause.waitForEntry()
            try FileManager.default.moveItem(at: target, to: kept)
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
            _ = try source(target, name: "unrequested.png")
        } catch {
            task.cancel(); await pause.release(); _ = try? await task.value
            throw error
        }
        await pause.release()
        do { _ = try await task.value; XCTFail("Replaced original registered after deferred probe") }
        catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), saved)
        XCTAssertEqual(try Data(contentsOf: kept), bytes); XCTAssertEqual(try Data(contentsOf: selected), bytes)
        let version = await b.currentVersion(); XCTAssertEqual(version, failure.version)
        await b.stop()
    }

    func testMetadataTokenExpiryRejectsThenExplicitFreshCheckRecoversSameCopy() async throws {
        let root = try Support.tempFolder("retained-token-expiry"), outside = try Support.tempFolder("retained-token-source")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: outside) }
        let selected = try source(outside, name: "take.png"), bytes = try Data(contentsOf: selected)
        let gate = Gate(), b = try backend(root, gate: gate); try await b.start()
        _ = try await b.handle(method: "POST", path: "/api/new", body: "{\"name\":\"Keep\"}")
        gate.arm()
        var retained: ReelBackend.RetainedMediaCopiesError?
        do { _ = try await b.copyIn([selected]); XCTFail("Expected failed publication") }
        catch let error as ReelBackend.RetainedMediaCopiesError { retained = error }
        let failure = try XCTUnwrap(retained), path = try XCTUnwrap(failure.unregisteredCopies.first)
        let target = root.appendingPathComponent(path)
        XCTAssertEqual(Darwin.chmod(target.path, 0o644), 0)
        let saved = try Data(contentsOf: root.appendingPathComponent("reel.project.json")), probes = gate.count()
        gate.clear()
        do { _ = try await b.importMedia(failure.unregisteredCopies, expectedVersion: failure.version, retainedCopyIdentities: failure.retainedCopyIdentities); XCTFail("Expired exact token admitted") }
        catch let error as ReelBackend.RetainedMediaCopyChangedError { XCTAssertEqual(error.path, path) }
        XCTAssertEqual(gate.count(), probes)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), saved)
        XCTAssertEqual(try Data(contentsOf: target), bytes)
        let check = parse(try await b.recoveryMediaCandidates(expectedVersion: failure.version).text)
        let paths = try XCTUnwrap(check["unregisteredCopies"] as? [String])
        let identities = try XCTUnwrap(check["retainedCopyIdentities"] as? [String: String])
        let recoveryID = try XCTUnwrap(check["recoveryID"] as? String)
        XCTAssertEqual(paths, [path]); XCTAssertNotEqual(identities[path], failure.retainedCopyIdentities[path])
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("reel.project.json")), saved)
        let receipt = parse(try await b.registerRecoveryMedia(paths, recoveryID: recoveryID, expectedVersion: failure.version, retainedCopyIdentities: identities).text)
        XCTAssertEqual(Set(object(receipt["assets"]).keys), [path]); XCTAssertEqual(receipt["version"] as? Int, failure.version + 1)
        let version = await b.currentVersion(); XCTAssertEqual(version, failure.version + 1)
        let project = await b.currentProject(); XCTAssertNotNil(object(parse(try XCTUnwrap(project))["assets"])[path])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("media").path), ["take.png"])
        XCTAssertEqual(try Data(contentsOf: target), bytes); XCTAssertEqual(try Data(contentsOf: selected), bytes)
        await b.stop()
    }

}
