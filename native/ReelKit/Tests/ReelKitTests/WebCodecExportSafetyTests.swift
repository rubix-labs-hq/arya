import Foundation
import XCTest
@testable import ReelKit

/// Real backend registration/upload/publication with disposable bytes; no codec or renderer.
final class WebCodecExportSafetyTests: XCTestCase {
    private let original = Data("owned original source bytes".utf8)
    private let rendered = Data("owned replacement render bytes".utf8)

    private final class Gate: @unchecked Sendable {
        let lock = NSLock()
        private var blocked = false
        func set(_ value: Bool) { lock.withLock { blocked = value } }
        func check() throws { try lock.withLock { if blocked { throw ReelBackend.APIError("fixture read-only") } } }
    }

    private func call(_ backend: ReelBackend, _ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        var request = body
        if path == "/api/export/finish" { request?["drained"] = true }
        let json = try await backend.handle(method: method, path: path, body: request.map { JSON(any: $0).text })
        let result = (try JSON.parse(json.text) as? [String: Any]) ?? [:]
        if path == "/api/export", let id = result["id"] as? String { try await waitForPageWorker(backend, id) }
        return result
    }

    private func waitForPageWorker(_ backend: ReelBackend, _ id: String) async throws {
        for _ in 0..<500 {
            let response = try await backend.handle(method: "POST", path: "/api/export/progress", body: JSON(any: ["id": id, "progress": 0]).text)
            let state = parse(response.text)
            if state["state"] as? String == "running" { return }
            if state["cancelled"] as? Bool == true { throw ReelBackend.APIError("The fixture export failed before dispatch.") }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw ReelBackend.APIError("The fixture export did not acquire admission.")
    }

    private func fixture(_ name: String, _ action: (URL, ReelBackend, Gate) async throws -> Void) async throws {
        let root = try Support.tempFolder("web-export-" + name)
        defer { try? FileManager.default.removeItem(at: root) }
        for directory in ["media", "renders"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(directory), withIntermediateDirectories: true)
        }
        let gate = Gate()
        let backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), writeAdmission: { try gate.check() }, processingAdmission: .init(), events: { _, _ in })
        try await backend.start()
        do {
            _ = try await call(backend, "POST", "/api/new", ["name": "Owned export fixture", "width": 64, "height": 64, "fps": 1])
            try await action(root, backend, gate)
            await backend.stop(); await backend.pageProcessingWorkersExited()
        } catch { await backend.stop(); await backend.pageProcessingWorkersExited(); throw error }
    }

    private func reference(_ backend: ReelBackend, source: String, proxy: String? = nil) async throws {
        var asset: [String: Any] = ["kind": "video", "dur": 1, "width": 64, "height": 64]
        if let proxy { asset["proxy"] = proxy }
        // Import metadata through the actual shared core; no decoder is involved in this test.
        _ = try await backend.editOperations(ops: JSON(any: [["op": "import", "assets": [source: asset]]]))
    }

    private func start(_ backend: ReelBackend) async throws -> String {
        // An explicit output path: a taken export name is numbered instead of refused, so these
        // safety checks address the path itself, which is never renamed.
        let job = try await call(backend, "POST", "/api/export", ["renderer": "webcodecs", "preset": "h264-high", "out": "renders/Final.mp4", "width": 64, "height": 64, "fps": 1, "range": ["in": 0, "out": 1]])
        XCTAssertEqual((job["spec"] as? [String: Any])?["out"] as? String, "renders/Final.mp4")
        return try XCTUnwrap(job["id"] as? String)
    }

    private func rejects(_ action: () async throws -> Void, media: Bool = true, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await action(); XCTFail("Unsafe export must be rejected", file: file, line: line) }
        catch { if media { XCTAssertEqual(error.localizedDescription, "An export cannot overwrite a source, proxy or LUT referenced by the project. Choose another export name.", file: file, line: line) } }
    }

    private func assertNoJobs(_ backend: ReelBackend) async throws {
        let result = try await call(backend, "GET", "/api/jobs")
        XCTAssertTrue((result["jobs"] as? [[String: Any]] ?? []).isEmpty)
    }

    private func assertFailedPublication(_ root: URL, _ backend: ReelBackend, id: String) async throws {
        let ownedPart = await backend.exportPartForTesting(id)
        let part = try XCTUnwrap(ownedPart)
        XCTAssertTrue(FileManager.default.fileExists(atPath: part.path))
        await rejects { _ = try await self.call(backend, "POST", "/api/export/finish", ["id": id]) }
        let result = try await call(backend, "GET", "/api/jobs")
        let job = try XCTUnwrap((result["jobs"] as? [[String: Any]])?.first { $0["id"] as? String == id })
        XCTAssertEqual(job["state"] as? String, "failed")
        XCTAssertNil(job["output"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: part.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".reel/exports/\(id).part").path))
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("renders/Final.mp4")), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".reel/deliveries.json").path))
    }

    func testDirectReferencedSourceRejectsRegistrationWithoutChangingBytes() async throws {
        try await fixture("direct") { root, backend, _ in
            let output = root.appendingPathComponent("renders/Final.mp4")
            try self.original.write(to: output)
            try await self.reference(backend, source: "renders/Final.mp4")
            await self.rejects { _ = try await self.start(backend) }
            XCTAssertEqual(try Data(contentsOf: output), self.original)
            try await self.assertNoJobs(backend)
        }
    }

    func testMissingReferencedSourceIsNotFilledByExport() async throws {
        try await fixture("missing-source") { root, backend, _ in
            let output = root.appendingPathComponent("renders/Final.mp4")
            try await self.reference(backend, source: "renders/Final.mp4")
            await self.rejects { _ = try await self.start(backend) }
            XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
            try await self.assertNoJobs(backend)
        }
    }

    func testProxyRejectsRegistrationWithoutChangingBytes() async throws {
        try await fixture("proxy") { root, backend, _ in
            let output = root.appendingPathComponent("renders/Final.mp4")
            try self.original.write(to: output)
            try await self.reference(backend, source: "media/origin.mp4", proxy: "renders/Final.mp4")
            await self.rejects { _ = try await self.start(backend) }
            XCTAssertEqual(try Data(contentsOf: output), self.original)
            try await self.assertNoJobs(backend)
        }
    }

    func testStandardizedAndAbsoluteSourcePathsRejectRegistration() async throws {
        for absolute in [false, true] {
            try await fixture("normalized") { root, backend, _ in
                let output = root.appendingPathComponent("renders/Final.mp4")
                try self.original.write(to: output)
                try await self.reference(backend, source: absolute ? output.path : "renders/./Final.mp4")
                await self.rejects { _ = try await self.start(backend) }
                XCTAssertEqual(try Data(contentsOf: output), self.original)
                try await self.assertNoJobs(backend)
            }
        }
    }

    func testSourceSymlinkAliasRejectsRegistration() async throws {
        try await fixture("source-link") { root, backend, _ in
            let output = root.appendingPathComponent("renders/Final.mp4"), source = root.appendingPathComponent("media/linked.mp4")
            try self.original.write(to: output)
            try FileManager.default.createSymbolicLink(at: source, withDestinationURL: output)
            try await self.reference(backend, source: "media/linked.mp4")
            await self.rejects { _ = try await self.start(backend) }
            XCTAssertEqual(try Data(contentsOf: source), self.original)
            XCTAssertEqual(try Data(contentsOf: output), self.original)
        }
    }

    func testProxySymlinkAliasRejectsRegistration() async throws {
        try await fixture("proxy-link") { root, backend, _ in
            let output = root.appendingPathComponent("renders/Final.mp4"), proxy = root.appendingPathComponent("media/proxy.mp4")
            try self.original.write(to: output)
            try FileManager.default.createSymbolicLink(at: proxy, withDestinationURL: output)
            try await self.reference(backend, source: "media/origin.mp4", proxy: "media/proxy.mp4")
            await self.rejects { _ = try await self.start(backend) }
            XCTAssertEqual(try Data(contentsOf: proxy), self.original)
        }
    }

    func testExistingHardLinkSourceAliasRejectsRegistration() async throws {
        try await fixture("hard-link") { root, backend, _ in
            let source = root.appendingPathComponent("media/origin.mp4"), output = root.appendingPathComponent("renders/Final.mp4")
            try self.original.write(to: source)
            try FileManager.default.linkItem(at: source, to: output)
            try await self.reference(backend, source: "media/origin.mp4")
            await self.rejects { _ = try await self.start(backend) }
            XCTAssertEqual(try Data(contentsOf: source), self.original)
            XCTAssertEqual(try Data(contentsOf: output), self.original)
        }
    }

    func testNewSourceReferenceRejectsFinalPublicationAndCleansOwnedPart() async throws {
        try await fixture("late-source") { root, backend, _ in
            let id = try await self.start(backend)
            try self.original.write(to: root.appendingPathComponent("renders/Final.mp4"))
            _ = try await backend.saveExport(job: id, name: nil, position: 0, data: self.rendered)
            try await self.reference(backend, source: "renders/Final.mp4")
            try await self.assertFailedPublication(root, backend, id: id)
        }
    }

    func testNewProxyReferenceRejectsFinalPublicationAndCleansOwnedPart() async throws {
        try await fixture("late-proxy") { root, backend, _ in
            let id = try await self.start(backend)
            try self.original.write(to: root.appendingPathComponent("renders/Final.mp4"))
            _ = try await backend.saveExport(job: id, name: nil, position: 0, data: self.rendered)
            try await self.reference(backend, source: "media/origin.mp4", proxy: "renders/Final.mp4")
            try await self.assertFailedPublication(root, backend, id: id)
        }
    }

    func testNewHardLinkReferenceRejectsFinalPublication() async throws {
        try await fixture("late-hard-link") { root, backend, _ in
            let output = root.appendingPathComponent("renders/Final.mp4"), source = root.appendingPathComponent("media/origin.mp4")
            let id = try await self.start(backend)
            try self.original.write(to: output)
            _ = try await backend.saveExport(job: id, name: nil, position: 0, data: self.rendered)
            try FileManager.default.linkItem(at: output, to: source)
            try await self.reference(backend, source: "media/origin.mp4")
            try await self.assertFailedPublication(root, backend, id: id)
            XCTAssertEqual(try Data(contentsOf: source), self.original)
        }
    }

    func testUnreferencedOldRenderIsRefusedAndPreserved() async throws {
        try await fixture("refuse-old") { root, backend, _ in
            let output = root.appendingPathComponent("renders/Final.mp4")
            try self.original.write(to: output)
            await self.rejects({ _ = try await self.start(backend) }, media: false)
            XCTAssertEqual(try Data(contentsOf: output), self.original)
            try await self.assertNoJobs(backend)
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".reel/deliveries.json").path))
        }
    }

    func testOutputSymlinkStillRejectsAdmission() async throws {
        try await fixture("output-link") { root, backend, _ in
            let source = root.appendingPathComponent("media/origin.mp4")
            try self.original.write(to: source)
            try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("renders/Final.mp4"), withDestinationURL: source)
            await self.rejects({ _ = try await self.start(backend) }, media: false)
            XCTAssertEqual(try Data(contentsOf: source), self.original)
            try await self.assertNoJobs(backend)
        }
    }

    func testOutputSymlinkIntroducedAfterRegistrationFailsAndCleansOwnedPart() async throws {
        try await fixture("late-output-link") { root, backend, _ in
            let source = root.appendingPathComponent("media/origin.mp4")
            try self.original.write(to: source)
            let id = try await self.start(backend)
            _ = try await backend.saveExport(job: id, name: nil, position: 0, data: self.rendered)
            let ownedPart = await backend.exportPartForTesting(id)
            let part = try XCTUnwrap(ownedPart)
            XCTAssertTrue(FileManager.default.fileExists(atPath: part.path))
            try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("renders/Final.mp4"), withDestinationURL: source)
            await self.rejects({ _ = try await self.call(backend, "POST", "/api/export/finish", ["id": id]) }, media: false)
            let result = try await self.call(backend, "GET", "/api/jobs")
            let job = try XCTUnwrap((result["jobs"] as? [[String: Any]])?.first { $0["id"] as? String == id })
            XCTAssertEqual(job["state"] as? String, "failed")
            XCTAssertNil(job["output"])
            XCTAssertFalse(FileManager.default.fileExists(atPath: part.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".reel/exports/\(id).part").path))
            XCTAssertEqual(try Data(contentsOf: source), self.original)
        }
    }

    func testReadOnlyAndClosedAdmissionRemainEffective() async throws {
        try await fixture("admission") { root, backend, gate in
            gate.set(true)
            await self.rejects({ _ = try await self.start(backend) }, media: false)
            gate.set(false)
            let id = try await self.start(backend)
            _ = try await backend.saveExport(job: id, name: nil, position: 0, data: self.rendered)
            gate.set(true)
            await self.rejects({ _ = try await self.call(backend, "POST", "/api/export/finish", ["id": id]) }, media: false)
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("renders/Final.mp4").path))
            await backend.stop()
            gate.set(false)
            await self.rejects({ _ = try await self.start(backend) }, media: false)
            await self.rejects({ _ = try await self.call(backend, "POST", "/api/export/finish", ["id": id]) }, media: false)
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("renders/Final.mp4").path))
        }
    }
    func testAcceptedSnapshotAndSourceIdentityRemainBoundInDurableReceipt() async throws {
        try await fixture("accepted") { root, backend, _ in
            let file = root.appendingPathComponent("media/owned.wav")
            try self.original.write(to: file)
            try await self.reference(backend, source: "media/owned.wav")
            let accepted = await backend.currentProject()
            let response = try await self.call(backend, "POST", "/api/export", ["renderer": "webcodecs", "name": "Bound", "range": ["in": 0, "out": 1]])
            XCTAssertEqual(response["acceptedProject"] as? NSDictionary, try JSON.parse(try XCTUnwrap(accepted)) as? NSDictionary)
            XCTAssertEqual((response["sourceCohort"] as? [[String: Any]])?.first?["source"] as? String, "media/owned.wav")
            let id = try XCTUnwrap(response["id"] as? String)
            _ = try await backend.saveExport(job: id, name: nil, position: 0, data: self.rendered)
            let completed = try await self.call(backend, "POST", "/api/export/finish", ["id": id])
            let history = try await self.call(backend, "GET", "/api/deliveries")
            let receipt = try XCTUnwrap((history["deliveries"] as? [[String: Any]])?.first)
            for key in ["acceptedVersion", "acceptedGeneration", "acceptedProjectSHA256", "sourceCohortID"] {
                XCTAssertEqual(completed[key] as? NSObject, response[key] as? NSObject)
                XCTAssertEqual(receipt[key] as? NSObject, response[key] as? NSObject)
            }
        }
    }

    func testSourceSwapWithRestoredSizeAndMtimeRefusesCompletion() async throws {
        try await fixture("source-cohort") { root, backend, _ in
            let source = root.appendingPathComponent("media/source.wav")
            try self.original.write(to: source)
            try await self.reference(backend, source: "media/source.wav")
            let id = try await self.start(backend)
            _ = try await backend.saveExport(job: id, name: nil, position: 0, data: self.rendered)
            let before = try FileManager.default.attributesOfItem(atPath: source.path)
            try Data(repeating: 65, count: self.original.count).write(to: source)
            try FileManager.default.setAttributes([.modificationDate: before[.modificationDate]!], ofItemAtPath: source.path)
            await self.rejects({ _ = try await self.call(backend, "POST", "/api/export/finish", ["id": id]) }, media: false)
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("renders/Final.mp4").path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".reel/deliveries.json").path))
            XCTAssertEqual(try Data(contentsOf: source), Data(repeating: 65, count: self.original.count))
        }
    }

    func testLateUnreferencedOutputCollisionIsPreservedWithoutReceipt() async throws {
        try await fixture("late-collision") { root, backend, _ in
            let id = try await self.start(backend)
            _ = try await backend.saveExport(job: id, name: nil, position: 0, data: self.rendered)
            try self.original.write(to: root.appendingPathComponent("renders/Final.mp4"))
            await self.rejects({ _ = try await self.call(backend, "POST", "/api/export/finish", ["id": id]) }, media: false)
            XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("renders/Final.mp4")), self.original)
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".reel/deliveries.json").path))
        }
    }

}
