import CryptoKit
import Darwin
import Foundation
import NativeProjectIO
import XCTest
@testable import ReelKit

final class ProjectRecoveryTests: XCTestCase {
    func testInitialRecoveryCreatesPrivateIdentityBeforePublicationLock() throws {
        let root = try Support.tempFolder("recovery-first-private-file"), folder = ProjectFolder(root: root)
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let original = Data(raw.utf8)
        try original.write(to: folder.projectFile)
        let store = try NativeProjectRecovery.Store(folder: folder)
        let identity = try XCTUnwrap(NativeProjectRecovery.read(store.directoryFD, "project-identity.json", exclusive: true))
        var identityInfo = Darwin.stat()
        XCTAssertEqual(Darwin.fstatat(store.directoryFD, "project-identity.json", &identityInfo, AT_SYMLINK_NOFOLLOW), 0)
        XCTAssertEqual(identityInfo.st_mode & 0o7777, 0o600)
        XCTAssertEqual(identityInfo.st_nlink, 1)
        XCTAssertEqual(try JSONDecoder().decode(NativeProjectRecovery.Family.self, from: identity.data).familyID, store.family.familyID)
        XCTAssertNil(try NativeProjectRecovery.read(store.directoryFD, "project-write.lock", missing: true))
        let lock = try NativeProjectRecovery.PublicationLock(directory: store.directoryFD)
        try lock.requireIdentity()
        let lockFile = try XCTUnwrap(NativeProjectRecovery.read(store.directoryFD, "project-write.lock", exclusive: true))
        var lockInfo = Darwin.stat()
        XCTAssertEqual(Darwin.fstatat(store.directoryFD, "project-write.lock", &lockInfo, AT_SYMLINK_NOFOLLOW), 0)
        XCTAssertEqual(lockInfo.st_mode & 0o7777, 0o600)
        XCTAssertEqual(lockInfo.st_nlink, 1)
        XCTAssertTrue(lockFile.data.isEmpty)
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), original)
    }
    func testMatchingMetadataPreparationAndCopyOnCurrentPlatform() throws {
        let root = try Support.tempFolder("recovery-matching-metadata")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let original = root.appendingPathComponent("original.json"), staged = root.appendingPathComponent("staged.json")
        let originalBytes = Data("original".utf8), stagedBytes = Data("staged".utf8)
        try originalBytes.write(to: original); try stagedBytes.write(to: staged)
        let sourceFD = Darwin.open(original.path, O_RDWR | O_NOFOLLOW), stagedFD = Darwin.open(staged.path, O_RDWR | O_NOFOLLOW)
        XCTAssertGreaterThanOrEqual(sourceFD, 0); XCTAssertGreaterThanOrEqual(stagedFD, 0)
        defer { Darwin.close(sourceFD); Darwin.close(stagedFD) }
        XCTAssertEqual(arya_clear_project_acl(sourceFD), 0)
        XCTAssertEqual(arya_clear_project_acl(stagedFD), 0)
        let attribute = Data([1, 4, 9])
        XCTAssertEqual(attribute.withUnsafeBytes { Darwin.fsetxattr(sourceFD, "com.arya.matching-metadata", $0.baseAddress, $0.count, 0, 0) }, 0)
        XCTAssertEqual(arya_copy_project_metadata(sourceFD, stagedFD), 0)
        XCTAssertEqual(arya_verify_project_metadata(sourceFD, stagedFD), 0)
        XCTAssertNil(arya_project_io_error_operation())
        XCTAssertEqual(try Data(contentsOf: original), originalBytes)
        XCTAssertEqual(try Data(contentsOf: staged), stagedBytes)
    }
    #if os(macOS)
    func testNewStageQuarantineIsRetainedWithoutRelaxingOriginalMetadata() throws {
        let root = try Support.tempFolder("recovery-new-quarantine")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let quarantine = Data("0081;00000000;Arya;".utf8), attribute = Data([1, 4, 9])
        for originalHasAttribute in [false, true] {
            let original = root.appendingPathComponent("original-\(originalHasAttribute).json")
            let staged = root.appendingPathComponent("staged-\(originalHasAttribute).json")
            let originalBytes = Data("original".utf8), stagedBytes = Data("staged".utf8)
            try originalBytes.write(to: original); try stagedBytes.write(to: staged)
            let sourceFD = Darwin.open(original.path, O_RDWR | O_NOFOLLOW), stagedFD = Darwin.open(staged.path, O_RDWR | O_NOFOLLOW)
            XCTAssertGreaterThanOrEqual(sourceFD, 0); XCTAssertGreaterThanOrEqual(stagedFD, 0)
            defer { Darwin.close(sourceFD); Darwin.close(stagedFD) }
            XCTAssertEqual(arya_clear_project_acl(sourceFD), 0); XCTAssertEqual(arya_clear_project_acl(stagedFD), 0)
            XCTAssertEqual(Darwin.fchmod(sourceFD, 0o640), 0)
            XCTAssertEqual(Darwin.fgetxattr(sourceFD, "com.apple.quarantine", nil, 0, 0, 0), -1); XCTAssertEqual(errno, ENOATTR)
            XCTAssertEqual(quarantine.withUnsafeBytes { Darwin.fsetxattr(stagedFD, "com.apple.quarantine", $0.baseAddress, $0.count, 0, 0) }, 0)
            if originalHasAttribute {
                XCTAssertEqual(attribute.withUnsafeBytes { Darwin.fsetxattr(sourceFD, "com.arya.original", $0.baseAddress, $0.count, 0, 0) }, 0)
            }
            XCTAssertEqual(arya_copy_project_metadata(sourceFD, stagedFD), 0)
            XCTAssertEqual(arya_verify_project_metadata(sourceFD, stagedFD), 0)
            var retained = [UInt8](repeating: 0, count: quarantine.count)
            XCTAssertEqual(retained.withUnsafeMutableBytes { Darwin.fgetxattr(stagedFD, "com.apple.quarantine", $0.baseAddress, $0.count, 0, 0) }, quarantine.count)
            XCTAssertEqual(Data(retained), quarantine)
            var info = Darwin.stat(); XCTAssertEqual(Darwin.fstat(stagedFD, &info), 0); XCTAssertEqual(info.st_mode & 0o7777, 0o640)
            XCTAssertEqual(Darwin.fgetxattr(sourceFD, "com.apple.quarantine", nil, 0, 0, 0), -1); XCTAssertEqual(errno, ENOATTR)
            let changed = Data([2, 5, 8])
            let key = originalHasAttribute ? "com.arya.original" : "com.arya.unexpected"
            XCTAssertEqual(changed.withUnsafeBytes { Darwin.fsetxattr(stagedFD, key, $0.baseAddress, $0.count, 0, 0) }, 0)
            XCTAssertEqual(arya_verify_project_metadata(sourceFD, stagedFD), -1); XCTAssertEqual(errno, EINVAL)
            XCTAssertEqual(try Data(contentsOf: original), originalBytes); XCTAssertEqual(try Data(contentsOf: staged), stagedBytes)
        }
    }
    func testQuarantineTimestampRefreshPreservesRestrictions() throws {
        let root = try Support.tempFolder("recovery-quarantine-time")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let original = root.appendingPathComponent("original.json"), staged = root.appendingPathComponent("staged.json")
        let originalBytes = Data("original".utf8), stagedBytes = Data("staged".utf8)
        try originalBytes.write(to: original); try stagedBytes.write(to: staged)
        let sourceFD = Darwin.open(original.path, O_RDWR | O_NOFOLLOW), stagedFD = Darwin.open(staged.path, O_RDWR | O_NOFOLLOW)
        XCTAssertGreaterThanOrEqual(sourceFD, 0); XCTAssertGreaterThanOrEqual(stagedFD, 0)
        defer { Darwin.close(sourceFD); Darwin.close(stagedFD) }
        XCTAssertEqual(arya_clear_project_acl(sourceFD), 0); XCTAssertEqual(arya_clear_project_acl(stagedFD), 0)
        let before = "0082;6ad1b39b;Arya;"
        let cases: [(String, Bool)] = [
            ("0082;6ad1b4b7;Arya;", true), ("0080;6ad1b4b7;Arya;", false),
            ("0082;6ad1b4b7;Other;", true), ("0082;6ad1b4b7;Arya;event", false),
            ("0082;6ad1b39a;Arya;", false), ("0082;6ad1b4bg;Arya;", false),
            ("0082:6ad1b4b7;Arya;", false), ("0082;6ad1b4b7:Arya;", false),
            ("0082;06ad1b4b7;Arya;", false), ("0082;6ad1b4b7;Arya;\0", false)
        ]
        for (after, allowed) in cases {
            for (fd, value) in [(sourceFD, before), (stagedFD, after)] {
                let data = Data(value.utf8)
                XCTAssertEqual(data.withUnsafeBytes { Darwin.fsetxattr(fd, "com.apple.quarantine", $0.baseAddress, $0.count, 0, 0) }, 0)
            }
            XCTAssertEqual(arya_verify_project_metadata(sourceFD, stagedFD), allowed ? 0 : -1, after)
            if allowed {
                XCTAssertEqual(arya_copy_project_metadata(sourceFD, stagedFD), 0)
                var value = Data(count: after.utf8.count)
                let count = value.withUnsafeMutableBytes { Darwin.fgetxattr(stagedFD, "com.apple.quarantine", $0.baseAddress, $0.count, 0, 0) }
                XCTAssertEqual(count, value.count); XCTAssertEqual(value, Data(after.utf8))
            }
            XCTAssertEqual(try Data(contentsOf: original), originalBytes)
            XCTAssertEqual(try Data(contentsOf: staged), stagedBytes)
        }
    }
    func testOriginalQuarantineCannotLoseRestrictions() throws {
        let root = try Support.tempFolder("recovery-original-quarantine")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let original = root.appendingPathComponent("original.json"), staged = root.appendingPathComponent("staged.json")
        try Data("original".utf8).write(to: original); try Data("staged".utf8).write(to: staged)
        let sourceFD = Darwin.open(original.path, O_RDWR | O_NOFOLLOW), stagedFD = Darwin.open(staged.path, O_RDWR | O_NOFOLLOW)
        XCTAssertGreaterThanOrEqual(sourceFD, 0); XCTAssertGreaterThanOrEqual(stagedFD, 0)
        defer { Darwin.close(sourceFD); Darwin.close(stagedFD) }
        XCTAssertEqual(arya_clear_project_acl(sourceFD), 0); XCTAssertEqual(arya_clear_project_acl(stagedFD), 0)
        let originalValue = Data("0081;00000000;Original;".utf8), changedValue = Data("0080;00000000;Changed;".utf8)
        XCTAssertEqual(originalValue.withUnsafeBytes { Darwin.fsetxattr(sourceFD, "com.apple.quarantine", $0.baseAddress, $0.count, 0, 0) }, 0)
        XCTAssertEqual(arya_verify_project_metadata(sourceFD, stagedFD), -1)
        XCTAssertEqual(changedValue.withUnsafeBytes { Darwin.fsetxattr(stagedFD, "com.apple.quarantine", $0.baseAddress, $0.count, 0, 0) }, 0)
        XCTAssertEqual(arya_verify_project_metadata(sourceFD, stagedFD), -1); XCTAssertEqual(errno, EINVAL)
        XCTAssertEqual(originalValue.withUnsafeBytes { Darwin.fsetxattr(stagedFD, "com.apple.quarantine", $0.baseAddress, $0.count, 0, 0) }, 0)
        XCTAssertEqual(arya_verify_project_metadata(sourceFD, stagedFD), 0)
    }
    #endif
    func testNativeFailureContextKeepsErrnoAndIdentifiesPrivateIdentityPreparation() throws {
        let result = arya_clear_project_acl(-1)
        let code = errno
        let failure = NativeProjectRecovery.posix("prepare private recovery file", file: "project-identity.json", projectIO: true)
        XCTAssertEqual(result, -1)
        XCTAssertEqual(code, EBADF)
        XCTAssertEqual(failure.domain, NSPOSIXErrorDomain); XCTAssertEqual(failure.code, Int(code))
        let underlying = try XCTUnwrap(failure.userInfo[NSUnderlyingErrorKey] as? NSError)
        XCTAssertEqual(underlying.domain, NSPOSIXErrorDomain); XCTAssertEqual(underlying.code, Int(code))
        XCTAssertEqual(failure.userInfo["AryaProjectOperation"] as? String, "prepare private recovery file")
        XCTAssertEqual(failure.userInfo["AryaProjectFile"] as? String, "project-identity.json")
        XCTAssertEqual(failure.userInfo["AryaNativeOperation"] as? String, "acl_get_fd_np")
        XCTAssertTrue(failure.localizedDescription.contains("project-identity.json"))
        XCTAssertTrue(failure.localizedDescription.contains("acl_get_fd_np"))
    }
    func testUnrelatedPosixErrorDoesNotUsePreviousNativeOperation() {
        XCTAssertEqual(arya_clear_project_acl(-1), -1)
        errno = ENOENT
        let failure = NativeProjectRecovery.posix()
        XCTAssertEqual(failure.code, Int(ENOENT)); XCTAssertEqual(failure.domain, NSPOSIXErrorDomain)
        XCTAssertNil(failure.userInfo["AryaNativeOperation"])
    }
    func testPrivateCreationErrorNamesItsFileAndKeepsErrno() {
        XCTAssertThrowsError(try NativeProjectRecovery.put(Data([1]), directory: -1, name: "project-identity.json")) { error in
            let failure = error as NSError
            XCTAssertEqual(failure.domain, NSPOSIXErrorDomain); XCTAssertEqual(failure.code, Int(EBADF))
            XCTAssertEqual(failure.userInfo["AryaProjectOperation"] as? String, "create private recovery file")
            XCTAssertEqual(failure.userInfo["AryaProjectFile"] as? String, "project-identity.json")
            XCTAssertNil(failure.userInfo["AryaNativeOperation"])
        }
    }
    #if os(iOS) && !targetEnvironment(macCatalyst)
    func testDifferentDataProtectionClassesRejectMetadataVerificationOnIOS() throws {
        let root = try Support.tempFolder("recovery-protection-class")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let original = root.appendingPathComponent("original.json"), staged = root.appendingPathComponent("staged.json")
        let originalBytes = Data("original".utf8), stagedBytes = Data("staged".utf8)
        try originalBytes.write(to: original); try stagedBytes.write(to: staged)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete.rawValue], ofItemAtPath: original.path)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication.rawValue], ofItemAtPath: staged.path)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: original.path)[.protectionKey] as? String, FileProtectionType.complete.rawValue)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: staged.path)[.protectionKey] as? String, FileProtectionType.completeUntilFirstUserAuthentication.rawValue)
        let sourceFD = Darwin.open(original.path, O_RDWR | O_NOFOLLOW), stagedFD = Darwin.open(staged.path, O_RDWR | O_NOFOLLOW)
        XCTAssertGreaterThanOrEqual(sourceFD, 0); XCTAssertGreaterThanOrEqual(stagedFD, 0)
        defer { Darwin.close(sourceFD); Darwin.close(stagedFD) }
        XCTAssertEqual(arya_clear_project_acl(sourceFD), 0); XCTAssertEqual(arya_clear_project_acl(stagedFD), 0)
        let result = arya_verify_project_metadata(sourceFD, stagedFD)
        let failure = NativeProjectRecovery.posix("verify staged project access metadata", file: "reel.project.json", projectIO: true)
        XCTAssertEqual(result, -1)
        XCTAssertEqual(failure.code, Int(EINVAL))
        XCTAssertEqual(failure.userInfo["AryaNativeOperation"] as? String, "verify project Data Protection class equality")
        XCTAssertEqual(try Data(contentsOf: original), originalBytes); XCTAssertEqual(try Data(contentsOf: staged), stagedBytes)
    }
    #endif
    private let raw = "{\n \"version\": 1, \"name\": \"Original\", \"width\": 1920, \"height\": 1080, \"fps\": 30, \"tracks\": [], \"custom\": {\"keep\": true}\n}\n"
    private func rejected(_ action: () async throws -> Void) async {
        do { try await action(); XCTFail("Recovery must reject this state") } catch { }
    }
    private func fixture() async throws -> (URL, ReelBackend) {
        let root = try Support.tempFolder("project-recovery"), folder = ProjectFolder(root: root)
        try Data(raw.utf8).write(to: folder.projectFile)
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), events: { _, _ in })
        try await backend.start()
        return (root, backend)
    }
    private func cleanup(_ root: URL, _ backend: ReelBackend) async {
        await backend.stop(); try? FileManager.default.removeItem(at: root.deletingLastPathComponent())
    }
    private func core() throws -> ReelCore { try ReelCore(scriptURL: Support.core()) }

    func testColdCorruptOpenOffersExactOriginalFormatAndPreservesCorruptBytes() async throws {
        let (root, first) = try await fixture(); await first.stop()
        let corrupt = Data([0xff, 0x00, 0x01]), file = ProjectFolder(root: root).projectFile
        try corrupt.write(to: file)
        let backend = try ReelBackend(folder: ProjectFolder(root: root), coreScript: Support.core(), events: { _, _ in })
        await rejected { try await backend.start() }
        let offer = try await backend.projectRecoveryOffer(), version = await backend.currentVersion()
        let choice = try XCTUnwrap(offer.choices.first)
        try await backend.restoreProjectRecovery(choice, observedToken: offer.observedToken, expectedVersion: version)
        XCTAssertEqual(try Data(contentsOf: file), Data(raw.utf8))
        let store = try NativeProjectRecovery.Store(folder: ProjectFolder(root: root), create: false)
        let originals = try store.entries().filter { $0.hasSuffix(".receipt.json") }.compactMap { try? store.pair($0) }.filter { $0.0.phase == "preserved-original" }
        XCTAssertEqual(originals.count, 1); XCTAssertEqual(originals.first?.2.data, corrupt)
        await cleanup(root, backend)
    }
    func testRestoringAnOlderSnapshotCreatesOneUndoStepAndKeepsExactBytes() async throws {
        let (root, backend) = try await fixture(), firstData = Data(raw.utf8)
        _ = try await backend.editOperations(ops: .array([.object([("op", "project"), ("set", .object([("name", "Changed")]))])]))
        let second = try Data(contentsOf: ProjectFolder(root: root).projectFile)
        let offer = try await backend.projectRecoveryOffer(), version = await backend.currentVersion()
        let choice = try XCTUnwrap(offer.choices.first { $0.sha256 == NativeProjectRecovery.digest(firstData) })
        try await backend.restoreProjectRecovery(choice, observedToken: offer.observedToken, expectedVersion: version)
        XCTAssertEqual(try Data(contentsOf: ProjectFolder(root: root).projectFile), firstData)
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        XCTAssertEqual(try Data(contentsOf: ProjectFolder(root: root).projectFile), second)
        _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}")
        let restoredProject = await backend.currentProject()
        XCTAssertEqual(parse(restoredProject ?? "{}")["name"] as? String, "Original")
        await cleanup(root, backend)
    }
    func testDiskChangeAfterOfferRejectsWithoutMemoryOrHistoryChange() async throws {
        let (root, backend) = try await fixture(), file = ProjectFolder(root: root).projectFile
        let offer = try await backend.projectRecoveryOffer(), choice = try XCTUnwrap(offer.choices.first)
        let version = await backend.currentVersion(), before = await backend.currentProject()
        let external = Data("{\"version\":3,\"name\":\"External\",\"tracks\":[]}".utf8); try external.write(to: file)
        await rejected { try await backend.restoreProjectRecovery(choice, observedToken: offer.observedToken, expectedVersion: version) }
        XCTAssertEqual(try Data(contentsOf: file), external)
        let afterVersion = await backend.currentVersion(), after = await backend.currentProject()
        XCTAssertEqual(afterVersion, version); XCTAssertEqual(after, before)
        await cleanup(root, backend)
    }
    func testTamperedReceiptPairAndIncompleteSnapshotAreNeverOffered() async throws {
        let (root, backend) = try await fixture(), store = try NativeProjectRecovery.Store(folder: ProjectFolder(root: root), create: false)
        let offer = try await backend.projectRecoveryOffer(), choice = try XCTUnwrap(offer.choices.first)
        let dir = ProjectFolder(root: root).dotDir.appendingPathComponent("recovery")
        try Data("{}".utf8).write(to: dir.appendingPathComponent(choice.host + "-" + choice.id + ".project.json"))
        let orphan = "native-" + UUID().uuidString.lowercased() + ".project.json"
        try NativeProjectRecovery.put(Data(raw.utf8), directory: store.directoryFD, name: orphan)
        let next = try await backend.projectRecoveryOffer(); XCTAssertTrue(next.choices.isEmpty)
        XCTAssertTrue(try store.entries().contains(orphan)); XCTAssertEqual(try Data(contentsOf: ProjectFolder(root: root).projectFile), Data(raw.utf8))
        await cleanup(root, backend)
    }
    func testCopiedRootIdentityRejectsItsOldRecoveryWithoutWriting() async throws {
        let (root, backend) = try await fixture(); await backend.stop()
        let copy = root.deletingLastPathComponent().appendingPathComponent("copied-project")
        try FileManager.default.copyItem(at: root, to: copy)
        XCTAssertThrowsError(try NativeProjectRecovery.Store(folder: ProjectFolder(root: copy), create: false)) { error in
            XCTAssertTrue(error is NativeProjectRecovery.ForeignFolder)
        }
        XCTAssertEqual(try Data(contentsOf: ProjectFolder(root: copy).projectFile), Data(raw.utf8))
        await cleanup(root, backend)
    }
    func testRetentionRemovesOnlyVerifiedPublishedPairs() async throws {
        let root = try Support.tempFolder("recovery-retention"), store = try NativeProjectRecovery.Store(folder: ProjectFolder(root: root)), core = try core()
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let unknown = Data([8, 7, 6]), dir = ProjectFolder(root: root).dotDir.appendingPathComponent("recovery")
        try unknown.write(to: dir.appendingPathComponent("do-not-delete.bin"))
        let corrupt = Data([0xff, 0x00]); try store.snapshot(corrupt, phase: "preserved-original", source: corrupt, validate: core.validateRecoveryProject)
        for n in 0..<15 { let data = Data("{\"version\":3,\"name\":\"Copy \(n)\",\"tracks\":[]}".utf8); try store.snapshot(data, source: data, validate: core.validateRecoveryProject) }
        XCTAssertEqual(try store.verified(core.validateRecoveryProject).count, 12)
        XCTAssertEqual(try Data(contentsOf: dir.appendingPathComponent("do-not-delete.bin")), unknown)
        let preserved = try store.entries().filter { $0.hasSuffix(".receipt.json") }.compactMap { try? store.pair($0) }.filter { $0.0.phase == "preserved-original" }
        XCTAssertEqual(preserved.first?.2.data, corrupt)
    }
    func testReadOnlyTokenBlocksRestoreBeforeAnyPublication() async throws {
        let (root, first) = try await fixture(); await first.stop()
        let admission = ProjectWriteAdmission(), folder = ProjectFolder(root: root)
        let backend = try ReelBackend(folder: folder, coreScript: Support.core(), writeAdmission: { try admission.requireWritable() }, events: { _, _ in })
        try await backend.start(); let offer = try await backend.projectRecoveryOffer(), choice = try XCTUnwrap(offer.choices.first), version = await backend.currentVersion()
        admission.setBlockedReason("Files conflict")
        await rejected { try await backend.restoreProjectRecovery(choice, observedToken: offer.observedToken, expectedVersion: version) }
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), Data(raw.utf8)); await cleanup(root, backend)
    }
    func testFIFOCurrentProjectAndLinkedRecoveryDirectoryRejectPromptly() async throws {
        let (root, backend) = try await fixture(), folder = ProjectFolder(root: root)
        try FileManager.default.removeItem(at: folder.projectFile); XCTAssertEqual(Darwin.mkfifo(folder.projectFile.path, 0o600), 0)
        let clock = ContinuousClock(), began = clock.now
        await rejected { _ = try await backend.projectRecoveryOffer() }
        XCTAssertLessThan(began.duration(to: clock.now), .seconds(1))
        let moved = folder.dotDir.appendingPathComponent("saved-recovery"), recovery = folder.dotDir.appendingPathComponent("recovery")
        try FileManager.default.moveItem(at: recovery, to: moved); try FileManager.default.createSymbolicLink(at: recovery, withDestinationURL: moved)
        XCTAssertThrowsError(try NativeProjectRecovery.Store(folder: folder, create: false))
        await cleanup(root, backend)
    }
    func testIdentityProtocolRootAndTimestampDriftRejectBeforeWriting() async throws {
        let (root, backend) = try await fixture(), store = try NativeProjectRecovery.Store(folder: ProjectFolder(root: root), create: false)
        let identityFile = ProjectFolder(root: root).dotDir.appendingPathComponent("recovery/project-identity.json")
        let before = try Data(contentsOf: identityFile), original = try JSONSerialization.jsonObject(with: before) as! [String: Any]
        for field in ["protocol", "rootIdentity", "createdAt"] {
            var changed = original
            changed[field] = field == "protocol" ? 2 : field == "rootIdentity" ? ["device": "changed", "inode": "changed"] : "changed"
            try JSONSerialization.data(withJSONObject: changed).write(to: identityFile)
            XCTAssertThrowsError(try store.requireIdentity())
            try before.write(to: identityFile)
        }
        XCTAssertEqual(try Data(contentsOf: ProjectFolder(root: root).projectFile), Data(raw.utf8))
        await cleanup(root, backend)
    }
    func testReplacementHelperRejectsInvalidIncomingBytesAndFinalDiskChange() async throws {
        let (root, backend) = try await fixture(), store = try NativeProjectRecovery.Store(folder: ProjectFolder(root: root), create: false), core = try core()
        let file = ProjectFolder(root: root).projectFile, original = try Data(contentsOf: file)
        XCTAssertThrowsError(try store.replace(Data([0xff]), expected: original, preserveOriginal: false, admission: {}, validate: core.validateRecoveryProject))
        XCTAssertThrowsError(try store.replace(Data("[]".utf8), expected: original, preserveOriginal: false, admission: {}, validate: core.validateRecoveryProject))
        XCTAssertEqual(try Data(contentsOf: file), original)
        let changed = Data("{\"version\":3,\"name\":\"External during stage\",\"tracks\":[]}".utf8)
        var calls = 0
        XCTAssertThrowsError(try store.replace(Data(raw.utf8), expected: original, preserveOriginal: false, admission: {
            calls += 1
            if calls == 2 { try changed.write(to: file) }
        }, validate: core.validateRecoveryProject))
        XCTAssertEqual(try Data(contentsOf: file), changed)
        let entries = try FileManager.default.contentsOfDirectory(atPath: root.path)
        XCTAssertFalse(entries.contains { $0.hasPrefix(".reel-project-") })
        await cleanup(root, backend)
    }

    func testPublicationLockRejectsSecondNativeWriterAndReleasesOnExit() async throws {
        let (root, backend) = try await fixture(), folder = ProjectFolder(root: root), core = try core()
        let first = try NativeProjectRecovery.Store(folder: folder, create: false), second = try NativeProjectRecovery.Store(folder: folder, create: false)
        let before = try Data(contentsOf: folder.projectFile), next = Data("{\"version\":3,\"name\":\"Next\",\"tracks\":[]}".utf8)
        try first.withPublicationLock { _ in
            XCTAssertThrowsError(try second.replace(next, expected: before, preserveOriginal: false, admission: {}, validate: core.validateRecoveryProject))
            XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
        }
        _ = try second.replace(next, expected: before, preserveOriginal: false, admission: {}, validate: core.validateRecoveryProject)
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), next)
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.dotDir.appendingPathComponent("recovery/project-write.lock").path))
        await cleanup(root, backend)
    }
    func testPublicationLockRejectsFIFOAndReplacedNamedInode() async throws {
        let (root, backend) = try await fixture(), folder = ProjectFolder(root: root), store = try NativeProjectRecovery.Store(folder: folder, create: false)
        let lock = folder.dotDir.appendingPathComponent("recovery/project-write.lock"), saved = lock.deletingLastPathComponent().appendingPathComponent("saved-lock")
        try store.withPublicationLock { held in
            try FileManager.default.moveItem(at: lock, to: saved)
            try Data().write(to: lock)
            XCTAssertThrowsError(try held.requireIdentity())
        }
        try FileManager.default.removeItem(at: lock); XCTAssertEqual(Darwin.mkfifo(lock.path, 0o600), 0)
        let clock = ContinuousClock(), began = clock.now
        XCTAssertThrowsError(try store.withPublicationLock { _ in })
        XCTAssertLessThan(began.duration(to: clock.now), .seconds(1))
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), Data(raw.utf8))
        XCTAssertTrue(FileManager.default.fileExists(atPath: saved.path))
        await cleanup(root, backend)
    }

    func testDocumentTrackingFlagIsAllowedAndOtherFileFlagsStillReject() throws {
        let root = try Support.tempFolder("recovery-tracked-flag")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let original = root.appendingPathComponent("original.json"), staged = root.appendingPathComponent("staged.json")
        try Data("original".utf8).write(to: original); try Data("staged".utf8).write(to: staged)
        let sourceFD = Darwin.open(original.path, O_RDWR | O_NOFOLLOW), stagedFD = Darwin.open(staged.path, O_RDWR | O_NOFOLLOW)
        XCTAssertGreaterThanOrEqual(sourceFD, 0); XCTAssertGreaterThanOrEqual(stagedFD, 0)
        defer { Darwin.close(sourceFD); Darwin.close(stagedFD) }
        // iOS sets UF_TRACKED on documents it tracks, including files the app has just created.
        XCTAssertEqual(Darwin.fchflags(sourceFD, UInt32(UF_TRACKED)), 0)
        XCTAssertEqual(Darwin.fchflags(stagedFD, UInt32(UF_TRACKED)), 0)
        XCTAssertEqual(arya_clear_project_acl(stagedFD), 0)
        XCTAssertEqual(arya_copy_project_metadata(sourceFD, stagedFD), 0)
        XCTAssertEqual(arya_verify_project_metadata(sourceFD, stagedFD), 0)
        XCTAssertNil(arya_project_io_error_operation())
        // Any other flag still rejects, alone or next to UF_TRACKED.
        XCTAssertEqual(Darwin.fchflags(sourceFD, UInt32(UF_TRACKED | UF_NODUMP)), 0)
        XCTAssertEqual(arya_copy_project_metadata(sourceFD, stagedFD), -1); XCTAssertEqual(errno, EINVAL)
        XCTAssertEqual(arya_verify_project_metadata(sourceFD, stagedFD), -1); XCTAssertEqual(errno, EINVAL)
        XCTAssertEqual(Darwin.fchflags(sourceFD, UInt32(UF_TRACKED)), 0)
        XCTAssertEqual(Darwin.fchflags(stagedFD, UInt32(UF_TRACKED | UF_HIDDEN)), 0)
        XCTAssertEqual(arya_verify_project_metadata(sourceFD, stagedFD), -1); XCTAssertEqual(errno, EINVAL)
        XCTAssertEqual(arya_clear_project_acl(stagedFD), -1); XCTAssertEqual(errno, EINVAL)
        XCTAssertEqual(Darwin.fchflags(stagedFD, 0), 0)
    }
    func testTrackedProjectFileSavesThroughNativeReplacement() async throws {
        let (root, backend) = try await fixture(), folder = ProjectFolder(root: root), store = try NativeProjectRecovery.Store(folder: folder, create: false), core = try core()
        XCTAssertEqual(Darwin.chflags(folder.projectFile.path, UInt32(UF_TRACKED)), 0)
        let read = try XCTUnwrap(store.currentRead()), next = Data("{\"version\":3,\"name\":\"Tracked save\",\"tracks\":[]}".utf8)
        _ = try store.replace(next, expected: read.data, expectedIdentity: read, preserveOriginal: false, admission: {}, validate: core.validateRecoveryProject)
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), next)
        await cleanup(root, backend)
    }
    func testExistingModeOwnerGroupAndXattrSurviveNativeReplacement() async throws {
        let (root, backend) = try await fixture(), folder = ProjectFolder(root: root), store = try NativeProjectRecovery.Store(folder: folder, create: false), core = try core()
        let fd = Darwin.open(folder.projectFile.path, O_RDWR | O_NOFOLLOW | O_NONBLOCK)
        XCTAssertGreaterThanOrEqual(fd, 0); defer { Darwin.close(fd) }
        XCTAssertEqual(Darwin.fchmod(fd, 0o640), 0)
        let attribute = Data([7, 6, 5, 4])
        XCTAssertEqual(attribute.withUnsafeBytes { Darwin.fsetxattr(fd, "com.arya.recovery-fixture", $0.baseAddress, $0.count, 0, 0) }, 0)
        var original = Darwin.stat(); XCTAssertEqual(Darwin.fstat(fd, &original), 0)
        let read = try XCTUnwrap(store.currentRead()), next = Data("{\"version\":3,\"name\":\"Metadata kept\",\"tracks\":[]}".utf8)
        _ = try store.replace(next, expected: read.data, expectedIdentity: read, preserveOriginal: false, admission: {}, validate: core.validateRecoveryProject)
        let afterFD = Darwin.open(folder.projectFile.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        XCTAssertGreaterThanOrEqual(afterFD, 0); defer { Darwin.close(afterFD) }
        var after = Darwin.stat(); XCTAssertEqual(Darwin.fstat(afterFD, &after), 0)
        XCTAssertEqual(after.st_mode & 0o777, original.st_mode & 0o777); XCTAssertEqual(after.st_uid, original.st_uid); XCTAssertEqual(after.st_gid, original.st_gid)
        var value = [UInt8](repeating: 0, count: 4)
        XCTAssertEqual(value.withUnsafeMutableBytes { Darwin.fgetxattr(afterFD, "com.arya.recovery-fixture", $0.baseAddress, $0.count, 0, 0) }, 4)
        XCTAssertEqual(Data(value), attribute); XCTAssertEqual(try Data(contentsOf: folder.projectFile), next)
        await cleanup(root, backend)
    }
    func testSameByteInodeSwapAfterOfferAndAfterPreparationRejects() async throws {
        let (root, backend) = try await fixture(), folder = ProjectFolder(root: root), store = try NativeProjectRecovery.Store(folder: folder, create: false), core = try core()
        let offer = try await backend.projectRecoveryOffer(), choice = try XCTUnwrap(offer.choices.first), version = await backend.currentVersion()
        let before = try Data(contentsOf: folder.projectFile), replacement = root.appendingPathComponent("same-bytes.json")
        try before.write(to: replacement)
        XCTAssertEqual(Darwin.rename(replacement.path, folder.projectFile.path), 0)
        await rejected { try await backend.restoreProjectRecovery(choice, observedToken: offer.observedToken, expectedVersion: version) }
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
        let read = try XCTUnwrap(store.currentRead())
        try before.write(to: replacement); XCTAssertEqual(Darwin.rename(replacement.path, folder.projectFile.path), 0)
        XCTAssertThrowsError(try store.replace(Data(raw.utf8), expected: before, expectedIdentity: read, preserveOriginal: false, admission: {}, validate: core.validateRecoveryProject))
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), before)
        await cleanup(root, backend)
    }
    func testUnsupportedSetIDMetadataRejectsWithoutPublishingOrChangingHistory() async throws {
        let (root, backend) = try await fixture(), folder = ProjectFolder(root: root), store = try NativeProjectRecovery.Store(folder: folder, create: false), core = try core()
        XCTAssertEqual(Darwin.chmod(folder.projectFile.path, 0o6755), 0)
        let before = try XCTUnwrap(store.currentRead()), project = await backend.currentProject(), version = await backend.currentVersion()
        XCTAssertThrowsError(try store.replace(Data("{\"version\":3,\"tracks\":[]}".utf8), expected: before.data, expectedIdentity: before, preserveOriginal: false, admission: {}, validate: core.validateRecoveryProject))
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), before.data)
        let after = await backend.currentProject(), afterVersion = await backend.currentVersion()
        XCTAssertEqual(after, project); XCTAssertEqual(afterVersion, version)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.path).contains { $0.hasPrefix(".reel-project-") })
        await cleanup(root, backend)
    }
    #if os(macOS)
    func testExistingSharedACLRemainsAfterNativeReplacement() async throws {
        let (root, backend) = try await fixture(), folder = ProjectFolder(root: root), store = try NativeProjectRecovery.Store(folder: folder, create: false), core = try core()
        func command(_ executable: String, _ arguments: [String]) throws -> String {
            let process = Process(), pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments; process.standardOutput = pipe; process.standardError = pipe
            try process.run(); let bytes = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw ReelBackend.APIError(String(data: bytes, encoding: .utf8) ?? "Owned ACL fixture failed") }
            return String(data: bytes, encoding: .utf8) ?? ""
        }
        _ = try command("/bin/chmod", ["+a", "everyone allow read", folder.projectFile.path])
        let beforeACL = try command("/bin/ls", ["-le", folder.projectFile.path]).split(separator: "\n").dropFirst().joined(separator: "\n")
        let before = try XCTUnwrap(store.currentRead()), next = Data("{\"version\":3,\"name\":\"ACL kept\",\"tracks\":[]}".utf8)
        _ = try store.replace(next, expected: before.data, expectedIdentity: before, preserveOriginal: false, admission: {}, validate: core.validateRecoveryProject)
        let afterACL = try command("/bin/ls", ["-le", folder.projectFile.path]).split(separator: "\n").dropFirst().joined(separator: "\n")
        XCTAssertFalse(beforeACL.isEmpty); XCTAssertEqual(afterACL, beforeACL)
        XCTAssertEqual(try Data(contentsOf: folder.projectFile), next)
        await cleanup(root, backend)
    }
    #endif

    func testLateStagedByteOrMetadataMutationRejectsBeforePublication() async throws {
        let (root, backend) = try await fixture(), folder = ProjectFolder(root: root), store = try NativeProjectRecovery.Store(folder: folder, create: false), core = try core()
        let before = try XCTUnwrap(store.currentRead()), next = Data("{\"version\":3,\"name\":\"Next\",\"tracks\":[]}".utf8)
        for mutateMetadata in [false, true] {
            var calls = 0
            XCTAssertThrowsError(try store.replace(next, expected: before.data, expectedIdentity: before, preserveOriginal: false, admission: {
                calls += 1
                guard calls == 2 else { return }
                let name = try XCTUnwrap(FileManager.default.contentsOfDirectory(atPath: root.path).first { $0.hasPrefix(".reel-project-") })
                let fd = Darwin.open(root.appendingPathComponent(name).path, O_RDWR | O_NOFOLLOW | O_NONBLOCK)
                guard fd >= 0 else { throw NativeProjectRecovery.posix() }
                defer { Darwin.close(fd) }
                if mutateMetadata {
                    let value: [UInt8] = [1]
                    guard value.withUnsafeBytes({ Darwin.fsetxattr(fd, "com.arya.late-mutation", $0.baseAddress, $0.count, 0, 0) }) == 0 else { throw NativeProjectRecovery.posix() }
                } else {
                    let value: [UInt8] = [32]
                    guard value.withUnsafeBytes({ Darwin.pwrite(fd, $0.baseAddress, $0.count, 0) }) == 1 else { throw NativeProjectRecovery.posix() }
                }
            }, validate: core.validateRecoveryProject))
            XCTAssertEqual(try Data(contentsOf: folder.projectFile), before.data)
            XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.path).contains { $0.hasPrefix(".reel-project-") })
        }
        await cleanup(root, backend)
    }
    func testEntryBudgetRejectsWithoutAllocatingEveryDirectoryNameOrDeletingUnknownFiles() async throws {
        let root = try Support.tempFolder("recovery-entry-budget"), folder = ProjectFolder(root: root), store = try NativeProjectRecovery.Store(folder: folder), core = try core()
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let directory = folder.dotDir.appendingPathComponent("recovery")
        for index in 0..<511 { try Data().write(to: directory.appendingPathComponent("unknown-\(index)")) }
        XCTAssertThrowsError(try store.snapshot(Data(raw.utf8), source: nil, validate: core.validateRecoveryProject))
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("unknown-510").path))
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: directory.path).contains { $0.hasSuffix(".receipt.json") })
    }

}
