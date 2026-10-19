import Darwin
import Foundation
import XCTest
@testable import ReelKit

final class RecoveryWritePermissionTests: XCTestCase {
    private let raw = "{\n \"version\": 1, \"name\": \"Original\", \"width\": 1920, \"height\": 1080, \"fps\": 30, \"tracks\": [], \"custom\": {\"keep\": true}\n}\n"
    private struct Fixture {
        let root: URL, backend: ReelBackend, admission: ProjectWriteAdmission
        let offer: NativeProjectRecoveryOffer, choice: NativeProjectRecoveryChoice, version: Int
        var folder: ProjectFolder { ProjectFolder(root: root) }
        var operation: ProjectWriteAdmission.RecoveryOperation {
            backend.recoveryOperation(choice, observedToken: offer.observedToken, expectedVersion: version)
        }
        func permission() throws -> ProjectWriteAdmission.RecoveryPermission {
            try admission.recoveryPermission(for: operation)
        }
    }
    private func rejected(_ action: () async throws -> Void) async {
        do { try await action(); XCTFail("This restore or ordinary write must be refused") } catch { }
    }
    private func deniedByAdmission(_ action: () async throws -> Void) async {
        do { try await action(); XCTFail("Ordinary writes must retain their read-only admission") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Project is read-only."), error.localizedDescription) }
    }
    private func fixture(missing: Bool = true) async throws -> Fixture {
        let root = try Support.tempFolder("recovery-permission"), folder = ProjectFolder(root: root)
        addTeardownBlock { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        try Data(raw.utf8).write(to: folder.projectFile)
        let seed = try ReelBackend(folder: folder, coreScript: Support.core(), events: { _, _ in })
        addTeardownBlock { await seed.stop() }
        try await seed.start(); await seed.stop()
        if missing { try FileManager.default.removeItem(at: folder.projectFile) }
        else { try Data([0xff, 0x00, 0x01]).write(to: folder.projectFile) }
        let admission = ProjectWriteAdmission()
        admission.setBlockedReason("The Files opening request has not adopted a document.", recoveryAvailable: true)
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), writeAdmission: { try admission.requireWritable() }, events: { _, _ in })
        addTeardownBlock { await backend.stop() }
        await rejected { try await backend.start() }
        let offer = try await backend.projectRecoveryOffer(), version = await backend.currentVersion()
        return Fixture(root: root, backend: backend, admission: admission, offer: offer, choice: try XCTUnwrap(offer.choices.first), version: version)
    }
    private func cleanup(_ f: Fixture) async {
        await f.backend.stop(); try? FileManager.default.removeItem(at: f.root.deletingLastPathComponent())
    }
    private func inventory(_ f: Fixture) throws -> [String: Data] {
        let directory = f.folder.dotDir.appendingPathComponent("recovery")
        return try Dictionary(uniqueKeysWithValues: FileManager.default.contentsOfDirectory(atPath: directory.path).map { ($0, try Data(contentsOf: directory.appendingPathComponent($0))) })
    }
    private func ordinaryWritesStayBlocked(_ f: Fixture) async {
        XCTAssertThrowsError(try f.admission.requireWritable())
        for route in ["/api/new", "/api/import", "/api/ops", "/api/undo", "/api/redo", "/api/export", "/api/transcript/drafts/checkpoint"] {
            await deniedByAdmission { _ = try await f.backend.handle(method: "POST", path: route, body: "{}") }
        }
        await deniedByAdmission { _ = try await f.backend.upload(name: "forbidden.wav", data: Data([1]), id: nil, done: true) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.folder.mediaDir.appendingPathComponent("forbidden.wav").path))
    }

    func testColdMissingAndCorruptRestoreDoesNotUnlockOrdinaryWrites() async throws {
        for missing in [true, false] {
            let f = try await fixture(missing: missing), permit = try f.permission()
            await ordinaryWritesStayBlocked(f)
            try await f.backend.restoreProjectRecovery(f.choice, observedToken: f.offer.observedToken, expectedVersion: f.version, permission: permit)
            XCTAssertEqual(try Data(contentsOf: f.folder.projectFile), Data(raw.utf8))
            let version = await f.backend.currentVersion(); XCTAssertEqual(version, f.version + 1)
            XCTAssertThrowsError(try permit.require(f.operation))
            await ordinaryWritesStayBlocked(f)
            if !missing {
                let store = try NativeProjectRecovery.Store(folder: f.folder, create: false)
                let originals = try store.entries().filter { $0.hasSuffix(".receipt.json") }.compactMap { try? store.pair($0) }.filter { $0.0.phase == "preserved-original" }
                XCTAssertEqual(originals.last?.2.data, Data([0xff, 0x00, 0x01]))
            }
            await cleanup(f)
        }
    }
    func testDefaultRestoreRefusesBeforeAllocatingOrPublishing() async throws {
        let f = try await fixture(), before = try inventory(f)
        await rejected { try await f.backend.restoreProjectRecovery(f.choice, observedToken: f.offer.observedToken, expectedVersion: f.version) }
        XCTAssertEqual(try inventory(f), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.folder.projectFile.path))
        let project = await f.backend.currentProject(), version = await f.backend.currentVersion()
        XCTAssertNil(project); XCTAssertEqual(version, f.version)
        await cleanup(f)
    }
    func testEveryOfferedChoiceFieldIsBoundToOnePermit() async throws {
        let f = try await fixture(), c = f.choice, before = try inventory(f)
        let variants: [NativeProjectRecoveryChoice] = [
            .init(id: UUID().uuidString, host: c.host, familyID: c.familyID, createdAt: c.createdAt, sha256: c.sha256, bytes: c.bytes),
            .init(id: c.id, host: "browser", familyID: c.familyID, createdAt: c.createdAt, sha256: c.sha256, bytes: c.bytes),
            .init(id: c.id, host: c.host, familyID: UUID().uuidString, createdAt: c.createdAt, sha256: c.sha256, bytes: c.bytes),
            .init(id: c.id, host: c.host, familyID: c.familyID, createdAt: "changed", sha256: c.sha256, bytes: c.bytes),
            .init(id: c.id, host: c.host, familyID: c.familyID, createdAt: c.createdAt, sha256: String(repeating: "0", count: 64), bytes: c.bytes),
            .init(id: c.id, host: c.host, familyID: c.familyID, createdAt: c.createdAt, sha256: c.sha256, bytes: c.bytes + 1)
        ]
        for variant in variants {
            let permit = try f.permission()
            try permit.require(f.operation)
            XCTAssertThrowsError(try permit.require(f.backend.recoveryOperation(variant, observedToken: f.offer.observedToken, expectedVersion: f.version)))
            try permit.require(f.operation)
            await rejected { try await f.backend.restoreProjectRecovery(variant, observedToken: f.offer.observedToken, expectedVersion: f.version, permission: permit) }
            XCTAssertThrowsError(try permit.require(f.operation))
        }
        XCTAssertEqual(try inventory(f), before); XCTAssertFalse(FileManager.default.fileExists(atPath: f.folder.projectFile.path))
        await cleanup(f)
    }
    func testBackendAndFolderOwnershipAreBoundToThePermit() async throws {
        let f = try await fixture(), permit = try f.permission()
        let other = try ReelBackend(folder: f.folder, coreScript: Support.core(), writeAdmission: { try f.admission.requireWritable() }, events: { _, _ in })
        addTeardownBlock { await other.stop() }
        let otherOperation = other.recoveryOperation(f.choice, observedToken: f.offer.observedToken, expectedVersion: f.version)
        XCTAssertThrowsError(try permit.require(otherOperation))
        await rejected { try await other.restoreProjectRecovery(f.choice, observedToken: f.offer.observedToken, expectedVersion: f.version, permission: permit) }
        let copy = f.root.deletingLastPathComponent().appendingPathComponent("other-folder")
        try FileManager.default.createDirectory(at: copy, withIntermediateDirectories: true)
        let otherRoot = try ReelBackend(folder: ProjectFolder(root: copy), coreScript: Support.core(), events: { _, _ in })
        addTeardownBlock { await otherRoot.stop() }
        let fresh = try f.permission(), rootOperation = otherRoot.recoveryOperation(f.choice, observedToken: f.offer.observedToken, expectedVersion: f.version)
        XCTAssertThrowsError(try fresh.require(rootOperation))
        let o = f.operation
        let changedRoot = ProjectWriteAdmission.RecoveryOperation(owner: o.owner, root: copy.path, snapshotID: o.snapshotID,
            familyID: o.familyID, host: o.host, createdAt: o.createdAt, sha256: o.sha256, bytes: o.bytes, version: o.version, observedToken: o.observedToken)
        try fresh.require(o); XCTAssertThrowsError(try fresh.require(changedRoot)); try fresh.require(o)
        fresh.revoke(); await other.stop(); await otherRoot.stop(); await cleanup(f)
    }
    func testStaleVersionAndObservedTokenRefuseAndConsumeThePermit() async throws {
        let f = try await fixture(), before = try inventory(f)
        for staleVersion in [true, false] {
            let permit = try f.permission()
            let changed = f.backend.recoveryOperation(f.choice, observedToken: staleVersion ? f.offer.observedToken : "stale", expectedVersion: staleVersion ? f.version + 1 : f.version)
            try permit.require(f.operation); XCTAssertThrowsError(try permit.require(changed)); try permit.require(f.operation)
            await rejected { try await f.backend.restoreProjectRecovery(f.choice, observedToken: staleVersion ? f.offer.observedToken : "stale", expectedVersion: staleVersion ? f.version + 1 : f.version, permission: permit) }
            XCTAssertThrowsError(try permit.require(f.operation))
        }
        XCTAssertEqual(try inventory(f), before); XCTAssertFalse(FileManager.default.fileExists(atPath: f.folder.projectFile.path))
        await cleanup(f)
    }
    func testSameByteNewMainInodeRefusesWithoutChangingMemory() async throws {
        let f = try await fixture(missing: false), permit = try f.permission(), before = try Data(contentsOf: f.folder.projectFile)
        let replacement = f.root.appendingPathComponent("external-replacement.json")
        try before.write(to: replacement)
        XCTAssertEqual(Darwin.rename(replacement.path, f.folder.projectFile.path), 0)
        await rejected { try await f.backend.restoreProjectRecovery(f.choice, observedToken: f.offer.observedToken, expectedVersion: f.version, permission: permit) }
        XCTAssertEqual(try Data(contentsOf: f.folder.projectFile), before)
        let project = await f.backend.currentProject(), version = await f.backend.currentVersion()
        XCTAssertNil(project); XCTAssertEqual(version, f.version); await cleanup(f)
    }
    func testFamilyIdentityDriftRefusesBeforeProjectPublication() async throws {
        let f = try await fixture(), permit = try f.permission(), identity = f.folder.dotDir.appendingPathComponent("recovery/project-identity.json")
        var fields = try JSONSerialization.jsonObject(with: Data(contentsOf: identity)) as! [String: Any]
        fields["familyID"] = UUID().uuidString.lowercased()
        try JSONSerialization.data(withJSONObject: fields).write(to: identity)
        await rejected { try await f.backend.restoreProjectRecovery(f.choice, observedToken: f.offer.observedToken, expectedVersion: f.version, permission: permit) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.folder.projectFile.path))
        let project = await f.backend.currentProject(); XCTAssertNil(project); await cleanup(f)
    }
    func testHostTransitionRevokesEarlierPermissionWithoutUnlockingWrites() async throws {
        let f = try await fixture(), permit = try f.permission()
        f.admission.setBlockedReason("Files has an unresolved version.")
        XCTAssertThrowsError(try permit.require(f.operation)); XCTAssertThrowsError(try f.permission())
        await rejected { try await f.backend.restoreProjectRecovery(f.choice, observedToken: f.offer.observedToken, expectedVersion: f.version, permission: permit) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.folder.projectFile.path))
        await ordinaryWritesStayBlocked(f); await cleanup(f)
    }
    func testFinalPublicationCallbackRevocationPreservesMainAndMetadata() async throws {
        let f = try await fixture(missing: false), permit = try f.permission(), store = try NativeProjectRecovery.Store(folder: f.folder, create: false)
        XCTAssertEqual(Darwin.chmod(f.folder.projectFile.path, 0o640), 0)
        let before = try XCTUnwrap(store.currentRead()), core = try ReelCore(scriptURL: Support.core())
        var original = Darwin.stat(); XCTAssertEqual(Darwin.lstat(f.folder.projectFile.path, &original), 0)
        var calls = 0
        XCTAssertThrowsError(try store.replace(Data(raw.utf8), expected: before.data, expectedIdentity: before, preserveOriginal: true, admission: {
            calls += 1
            if calls == 2 { permit.revoke() }
            try permit.require(f.operation)
        }, validate: core.validateRecoveryProject))
        XCTAssertEqual(calls, 2); XCTAssertEqual(try Data(contentsOf: f.folder.projectFile), before.data)
        var after = Darwin.stat(); XCTAssertEqual(Darwin.lstat(f.folder.projectFile.path, &after), 0)
        XCTAssertEqual(after.st_ino, original.st_ino); XCTAssertEqual(after.st_mode, original.st_mode)
        XCTAssertEqual(after.st_uid, original.st_uid); XCTAssertEqual(after.st_gid, original.st_gid)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: f.root.path).contains { $0.hasPrefix(".reel-project-") })
        let project = await f.backend.currentProject(), version = await f.backend.currentVersion()
        XCTAssertNil(project); XCTAssertEqual(version, f.version); await cleanup(f)
    }
    func testStoppedBackendRefusesEvenAValidPermission() async throws {
        let f = try await fixture(), permit = try f.permission(); await f.backend.stop()
        await rejected { try await f.backend.restoreProjectRecovery(f.choice, observedToken: f.offer.observedToken, expectedVersion: f.version, permission: permit) }
        XCTAssertThrowsError(try permit.require(f.operation)); XCTAssertFalse(FileManager.default.fileExists(atPath: f.folder.projectFile.path))
        await cleanup(f)
    }
    func testCancellationBeforeRestoreRefusesPublicationAndConsumesPermission() async throws {
        let f = try await fixture(), permit = try f.permission()
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            try await f.backend.restoreProjectRecovery(f.choice, observedToken: f.offer.observedToken, expectedVersion: f.version, permission: permit)
        }
        await rejected { try await task.value }
        XCTAssertThrowsError(try permit.require(f.operation)); XCTAssertFalse(FileManager.default.fileExists(atPath: f.folder.projectFile.path))
        await cleanup(f)
    }
    func testTamperedSelectedBytesNeverReachPublication() async throws {
        let f = try await fixture(), permit = try f.permission()
        let selected = f.folder.dotDir.appendingPathComponent("recovery/\(f.choice.host)-\(f.choice.id).project.json")
        try Data("{\"version\":3,\"name\":\"Untrusted\",\"tracks\":[]}".utf8).write(to: selected)
        await rejected { try await f.backend.restoreProjectRecovery(f.choice, observedToken: f.offer.observedToken, expectedVersion: f.version, permission: permit) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.folder.projectFile.path)); XCTAssertThrowsError(try permit.require(f.operation))
        let project = await f.backend.currentProject(); XCTAssertNil(project); await cleanup(f)
    }
}
