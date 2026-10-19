import Darwin
import Foundation
import XCTest
@testable import ReelKit

final class NativeAudioMixStorageTests: XCTestCase {
    func testSystemTemporaryAliasUsesPhysicalDescriptorPathsWithoutWeakeningConfinement() throws {
        let project = ProjectFolder(root: try Support.tempFolder("mix-alias-project"))
        let storage = try NativeAudioMixStorage(project: project, temporaryRoot: FileManager.default.temporaryDirectory)
        try storage.validate()
        let directory = try storage.makeDirectory(id: UUID().uuidString, filenames: ["source-0.wav"])
        defer { directory.cleanup() }
        try directory.validate()
        XCTAssertFalse(project.contains(storage.root))
        XCTAssertFalse(project.contains(directory.folder.root))
        XCTAssertThrowsError(try project.resolve(directory.path + "/source-0.wav"))
        let descriptor = try directory.createFile("source-0.wav")
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        try file.write(contentsOf: Data("retained private bytes".utf8)); try file.close()
        XCTAssertEqual(try Data(contentsOf: directory.folder.resolve("source-0.wav")), Data("retained private bytes".utf8))
        try directory.validate()
    }
    func testStoreRejectsProjectVisibleTemporaryParentAndLeavesNoOwnedDirectory() throws {
        let project = ProjectFolder(root: try Support.tempFolder("mix-visible-store"))
        XCTAssertThrowsError(try NativeAudioMixStorage(project: project, temporaryRoot: project.root))
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: project.root.path).contains { $0.hasPrefix("arya-private-mix-") })
    }

    func testOwnedRootAndCopyCleanupAreDescriptorScopedAndKeepVictimSymlinkTarget() throws {
        let project = ProjectFolder(root: try Support.tempFolder("mix-store-cleanup-project"))
        let temporary = try Support.tempFolder("mix-store-cleanup-private")
        let victim = try Support.tempFolder("mix-store-cleanup-victim")
        let victimFile = victim.appendingPathComponent("source-0.wav")
        try Data("victim".utf8).write(to: victimFile)
        let storage = try NativeAudioMixStorage(project: project, temporaryRoot: temporary)
        let directory = try storage.makeDirectory(id: UUID().uuidString, filenames: ["source-0.wav"])
        let fd = try directory.createFile("source-0.wav")
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try handle.write(contentsOf: Data("owned".utf8)); try handle.close()
        let original = URL(fileURLWithPath: directory.path)
        let moved = storage.root.appendingPathComponent("moved-owned-directory")
        try FileManager.default.moveItem(at: original, to: moved)
        try FileManager.default.createSymbolicLink(at: original, withDestinationURL: victim)
        defer {
            try? FileManager.default.removeItem(at: original)
            try? FileManager.default.removeItem(at: moved)
        }
        XCTAssertThrowsError(try directory.validate())
        directory.cleanup()
        XCTAssertEqual(try Data(contentsOf: victimFile), Data("victim".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: moved.appendingPathComponent("source-0.wav").path))
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: original.path), victim.path)
    }

    func testExclusiveCopyCreationRejectsExistingSymlinkWithoutTouchingTarget() throws {
        let project = ProjectFolder(root: try Support.tempFolder("mix-store-exclusive-project"))
        let temporary = try Support.tempFolder("mix-store-exclusive-private")
        let victim = temporary.appendingPathComponent("victim.wav")
        try Data("victim".utf8).write(to: victim)
        let storage = try NativeAudioMixStorage(project: project, temporaryRoot: temporary)
        let directory = try storage.makeDirectory(id: UUID().uuidString, filenames: ["source-0.wav"])
        let link = directory.folder.root.appendingPathComponent("source-0.wav")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: victim)
        XCTAssertThrowsError(try directory.createFile("source-0.wav"))
        directory.cleanup()
        XCTAssertEqual(try Data(contentsOf: victim), Data("victim".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: link.path))
    }

    func testRootLivesThroughDirectoryOwnerAndIsRemovedWhenLastOwnerReleases() throws {
        let project = ProjectFolder(root: try Support.tempFolder("mix-store-lifetime-project"))
        let temporary = try Support.tempFolder("mix-store-lifetime-private")
        var storage: NativeAudioMixStorage? = try NativeAudioMixStorage(project: project, temporaryRoot: temporary)
        let root = try XCTUnwrap(storage?.root)
        var directory: NativeAudioMixStorage.Directory? = try storage?.makeDirectory(id: UUID().uuidString, filenames: [])
        storage = nil
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.path))
        try directory?.validate()
        directory = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }

    func testStorageRejectsBroadenedDirectoryPermissionsBeforeWriting() throws {
        let project = ProjectFolder(root: try Support.tempFolder("mix-store-mode-project"))
        let temporary = try Support.tempFolder("mix-store-mode-private")
        let storage = try NativeAudioMixStorage(project: project, temporaryRoot: temporary)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: storage.root.path)
        XCTAssertThrowsError(try storage.validate())
        XCTAssertThrowsError(try storage.makeDirectory(id: UUID().uuidString, filenames: []))
        XCTAssertThrowsError(try storage.diskBudget())
    }

    func testBudgetUsesPrivateFilesystemAndRootHasPrivatePermissions() throws {
        let project = ProjectFolder(root: try Support.tempFolder("mix-store-budget-project"))
        let temporary = try Support.tempFolder("mix-store-budget-private")
        let storage = try NativeAudioMixStorage(project: project, temporaryRoot: temporary)
        let budget = try storage.diskBudget()
        XCTAssertGreaterThanOrEqual(budget, 1024 * 1024)
        XCTAssertLessThanOrEqual(budget, 1024 * 1024 * 1024)
        let attributes = try FileManager.default.attributesOfItem(atPath: storage.root.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        XCTAssertFalse(project.contains(storage.root))
    }
}
