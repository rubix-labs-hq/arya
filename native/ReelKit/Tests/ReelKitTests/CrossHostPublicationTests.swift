#if os(macOS)
import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import ReelKit

/// Root supplies both binaries from the reviewed C source. Missing binaries fail
/// these tests. This file never compiles, prepares or installs a helper.
final class CrossHostPublicationTests: XCTestCase {
    private struct FileIdentity: Equatable {
        let device: UInt64, inode: UInt64, links: UInt16, size: Int64, type: UInt16
        init(_ info: Darwin.stat) {
            device = UInt64(bitPattern: Int64(info.st_dev)); inode = info.st_ino
            links = info.st_nlink; size = info.st_size; type = info.st_mode & S_IFMT
        }
    }
    private struct Metadata: Equatable {
        let mode: UInt16, owner: UInt32, group: UInt32, flags: UInt32
        let acl: Data, aclHasEntry: Bool, attributes: [String: Data]
    }
    private struct Receipt {
        let status: Int32
        let fields: [String: Any]
    }
    private final class Binary {
        let url: URL, sha256: String
        private let observed: NativeProjectRecovery.Read
        init(pathKey: String, hashKey: String) throws {
            let environment = ProcessInfo.processInfo.environment
            guard let path = environment[pathKey], path.hasPrefix("/"),
                  let digest = environment[hashKey], digest.count == 64,
                  digest.allSatisfy({ "0123456789abcdef".contains($0) }) else {
                throw NativeProjectRecovery.error("Supply \(pathKey) and its lowercase exact \(hashKey). Cross-host fixtures cannot skip this gate.")
            }
            url = URL(fileURLWithPath: path).standardizedFileURL
            sha256 = digest
            observed = try Self.read(url)
            guard NativeProjectRecovery.digest(observed.data) == sha256 else {
                throw NativeProjectRecovery.error("\(pathKey) does not match the supplied binary hash.")
            }
        }
        private static func read(_ url: URL) throws -> NativeProjectRecovery.Read {
            let parent = Darwin.open(url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard parent >= 0 else { throw NativeProjectRecovery.posix() }
            defer { Darwin.close(parent) }
            var info = Darwin.stat()
            guard fstatat(parent, url.lastPathComponent, &info, AT_SYMLINK_NOFOLLOW) == 0,
                  info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
                  info.st_mode & 0o111 != 0, info.st_mode & 0o022 == 0,
                  info.st_uid == 0 || info.st_uid == geteuid(),
                  let value = try NativeProjectRecovery.read(parent, url.lastPathComponent, limit: 64 * 1024 * 1024, exclusive: true) else {
                throw NativeProjectRecovery.error("The supplied writer must be an executable, exclusively named regular file with a trusted owner and mode.")
            }
            return value
        }
        func requireExact() throws {
            let current = try Self.read(url)
            guard observed.sameIdentity(as: current), NativeProjectRecovery.digest(current.data) == sha256 else {
                throw NativeProjectRecovery.error("The supplied writer changed after this fixture admitted it.")
            }
        }
    }
    private final class Child {
        let process: Process
        private let output: URL, errors: URL
        private let outputHandle: FileHandle, errorHandle: FileHandle
        init(executable: URL, arguments: [String], input: Data, control: URL, extraEnvironment: [String: String] = [:]) throws {
            let identifier = UUID().uuidString.lowercased()
            output = control.appendingPathComponent(identifier + ".stdout")
            errors = control.appendingPathComponent(identifier + ".stderr")
            func log(_ url: URL) throws -> FileHandle {
                let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
                guard fd >= 0 else { throw NativeProjectRecovery.posix() }
                return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            }
            outputHandle = try log(output); errorHandle = try log(errors)
            process = Process(); process.executableURL = executable; process.arguments = arguments
            let stdin = Pipe()
            process.standardInput = stdin; process.standardOutput = outputHandle; process.standardError = errorHandle
            var environment = ["PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"]
            environment.merge(extraEnvironment) { _, new in new }; process.environment = environment
            do {
                try process.run()
                try stdin.fileHandleForWriting.write(contentsOf: input)
                try stdin.fileHandleForWriting.close()
            } catch {
                try? stdin.fileHandleForWriting.close(); killAndReap(); throw error
            }
        }
        deinit { killAndReap(); try? outputHandle.close(); try? errorHandle.close() }
        private static func boundedRead(_ url: URL, limit: Int) throws -> Data {
            let fd = Darwin.open(url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { throw NativeProjectRecovery.posix() }
            defer { Darwin.close(fd) }
            guard let value = try NativeProjectRecovery.read(fd, url.lastPathComponent, limit: limit, exclusive: true) else {
                throw NativeProjectRecovery.error("The owned process log is unavailable.")
            }
            return value.data
        }
        @discardableResult func killAndReap() -> Bool {
            guard process.isRunning else { return true }
            _ = Darwin.kill(process.processIdentifier, SIGKILL)
            let clock = ContinuousClock(), deadline = clock.now.advanced(by: .seconds(2))
            while process.isRunning, clock.now < deadline { Thread.sleep(forTimeInterval: 0.01) }
            if !process.isRunning { process.waitUntilExit() }
            return !process.isRunning
        }
        func wait(seconds: TimeInterval = 6) throws -> Receipt {
            let clock = ContinuousClock(), deadline = clock.now.advanced(by: .seconds(seconds))
            while process.isRunning, clock.now < deadline { Thread.sleep(forTimeInterval: 0.01) }
            guard !process.isRunning else {
                killAndReap(); throw NativeProjectRecovery.error("The owned writer did not exit within its fixture deadline.")
            }
            process.waitUntilExit()
            try outputHandle.close(); try errorHandle.close()
            let bytes = try Self.boundedRead(output, limit: 8192), stderr = try Self.boundedRead(errors, limit: 8192)
            guard let fields = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
                throw NativeProjectRecovery.error("The writer returned no bounded JSON receipt: \(String(data: stderr.prefix(8192), encoding: .utf8) ?? "unreadable stderr")")
            }
            return Receipt(status: process.terminationStatus, fields: fields)
        }
        func waitForReady(_ ready: URL) async throws {
            let clock = ContinuousClock(), deadline = clock.now.advanced(by: .seconds(2))
            while clock.now < deadline {
                if FileManager.default.fileExists(atPath: ready.path) {
                    guard try Self.boundedRead(ready, limit: 5) == Data("ready".utf8) else { throw NativeProjectRecovery.error("The C lock-holder handshake is invalid.") }
                    return
                }
                guard process.isRunning else { throw NativeProjectRecovery.error("The C test writer exited before acquiring the publication lock.") }
                try await Task.sleep(for: .milliseconds(10))
            }
            killAndReap(); throw NativeProjectRecovery.error("The C test writer did not acquire the lock within two seconds.")
        }
    }
    private final class Fixture {
        let root: URL, control: URL, folder: ProjectFolder, backend: ReelBackend, core: ReelCore, store: NativeProjectRecovery.Store
        private var children: [Child] = []
        private let writerRootPath: String
        init() throws {
            let ownedRoot = try Support.tempFolder("cross-host-publication").resolvingSymlinksInPath()
            var complete = false
            defer { if !complete { try? FileManager.default.removeItem(at: ownedRoot.deletingLastPathComponent()) } }
            guard let canonicalRoot = ownedRoot.path.withCString({ Darwin.realpath($0, nil) }) else { throw NativeProjectRecovery.posix() }
            defer { Darwin.free(canonicalRoot) }
            writerRootPath = String(cString: canonicalRoot)
            root = ownedRoot
            control = root.deletingLastPathComponent().appendingPathComponent("control")
            try FileManager.default.createDirectory(at: control, withIntermediateDirectories: false)
            folder = ProjectFolder(root: root)
            let original = Data("{\"version\":3,\"name\":\"Original\",\"width\":1920,\"height\":1080,\"fps\":30,\"tracks\":[]}".utf8)
            try original.write(to: folder.projectFile)
            core = try ReelCore(scriptURL: Support.core())
            backend = try ReelBackend(folder: folder, coreScript: Support.core(), events: { _, _ in })
            store = try NativeProjectRecovery.Store(folder: folder)
            complete = true
        }
        var lockFile: URL { folder.dotDir.appendingPathComponent("recovery/project-write.lock") }
        func input(_ next: Data, expected: NativeProjectRecovery.Read) throws -> Data {
            var info = Darwin.stat()
            guard fstatat(AT_FDCWD, root.path, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw NativeProjectRecovery.posix() }
            let values = [UInt64(bitPattern: Int64(info.st_dev)), info.st_ino, UInt64(next.count), UInt64(expected.data.count),
                          UInt64(bitPattern: Int64(expected.device)), expected.inode]
            var bytes = Data()
            for value in values { var big = value.bigEndian; withUnsafeBytes(of: &big) { bytes.append(contentsOf: $0) } }
            bytes.append(next); bytes.append(expected.data); return bytes
        }
        func launch(_ binary: Binary, command: String = "write", input: Data = Data(), extra: [String: String] = [:]) throws -> Child {
            try binary.requireExact()
            let child = try Child(executable: binary.url, arguments: command == "info" ? ["info"] : [command, writerRootPath], input: input, control: control, extraEnvironment: extra)
            children.append(child); return child
        }
        func cleanup() throws {
            var exited = true
            for child in children { if !child.killAndReap() { exited = false } }
            guard exited else { throw NativeProjectRecovery.error("An owned writer has not exited. Preserve the owned fixture at \(root.path).") }
            try FileManager.default.removeItem(at: root.deletingLastPathComponent())
        }
        func read() throws -> NativeProjectRecovery.Read { try XCTUnwrap(store.currentRead()) }
        func lockIdentity() throws -> FileIdentity {
            var info = Darwin.stat()
            guard lstat(lockFile.path, &info) == 0 else { throw NativeProjectRecovery.posix() }
            let value = FileIdentity(info)
            XCTAssertEqual(value.type, UInt16(S_IFREG)); XCTAssertEqual(value.links, 1); XCTAssertEqual(value.size, 0)
            return value
        }
        func inventory() throws -> [String: Data] {
            let directory = folder.dotDir.appendingPathComponent("recovery")
            let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            guard files.count <= 512 else { throw NativeProjectRecovery.error("The owned recovery fixture exceeded its entry bound.") }
            return try Dictionary(uniqueKeysWithValues: files.map { ($0.lastPathComponent, try Data(contentsOf: $0)) })
        }
        func metadata() throws -> Metadata {
            let fd = Darwin.open(folder.projectFile.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard fd >= 0 else { throw NativeProjectRecovery.posix() }; defer { Darwin.close(fd) }
            var info = Darwin.stat(); guard fstat(fd, &info) == 0 else { throw NativeProjectRecovery.posix() }
            guard let acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED) else { throw NativeProjectRecovery.posix() }; defer { acl_free(UnsafeMutableRawPointer(acl)) }
            var firstEntry: acl_entry_t? = nil
            let entryStatus = acl_get_entry(acl, Int32(ACL_FIRST_ENTRY.rawValue), &firstEntry)
            let hasEntry = entryStatus >= 0 && firstEntry != nil
            var length: ssize_t = 0
            guard let text = acl_to_text(acl, &length), length >= 0, length <= 4 * 1024 * 1024 else { throw NativeProjectRecovery.posix() }
            defer { acl_free(text) }
            let namesLength = flistxattr(fd, nil, 0, 0)
            guard namesLength >= 0, namesLength <= 4 * 1024 * 1024 else { throw NativeProjectRecovery.posix() }
            var names = [CChar](repeating: 0, count: max(1, namesLength))
            guard namesLength == 0 || flistxattr(fd, &names, namesLength, 0) == namesLength else { throw NativeProjectRecovery.posix() }
            var attributes: [String: Data] = [:], offset = 0
            while offset < namesLength {
                let name = names.withUnsafeBufferPointer { String(cString: $0.baseAddress!.advanced(by: offset)) }
                let count = fgetxattr(fd, name, nil, 0, 0, 0)
                guard count >= 0, count <= 4 * 1024 * 1024 else { throw NativeProjectRecovery.posix() }
                var value = [UInt8](repeating: 0, count: max(1, count))
                guard value.withUnsafeMutableBytes({ fgetxattr(fd, name, $0.baseAddress, count, 0, 0) }) == count else { throw NativeProjectRecovery.posix() }
                attributes[name] = Data(value.prefix(count)); offset += name.utf8.count + 1
            }
            return Metadata(mode: info.st_mode & 0o7777, owner: info.st_uid, group: info.st_gid, flags: info.st_flags,
                            acl: Data(bytes: text, count: length), aclHasEntry: hasEntry, attributes: attributes)
        }
        func installMetadata() throws {
            XCTAssertEqual(Darwin.chmod(folder.projectFile.path, 0o640), 0)
            let attribute = Data([7, 6, 5, 4])
            let fd = Darwin.open(folder.projectFile.path, O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard fd >= 0 else { throw NativeProjectRecovery.posix() }; defer { Darwin.close(fd) }
            guard attribute.withUnsafeBytes({ fsetxattr(fd, "com.arya.cross-host-fixture", $0.baseAddress, $0.count, 0, 0) }) == 0 else { throw NativeProjectRecovery.posix() }
            let child = try Child(executable: URL(fileURLWithPath: "/bin/chmod"), arguments: ["+a", "everyone allow read", folder.projectFile.path], input: Data(), control: control)
            // chmod returns no JSON. Wait for actual exit here and inspect its status.
            let clock = ContinuousClock(), deadline = clock.now.advanced(by: .seconds(2))
            while child.process.isRunning, clock.now < deadline { Thread.sleep(forTimeInterval: 0.01) }
            guard !child.process.isRunning else { child.killAndReap(); throw NativeProjectRecovery.error("The owned ACL setup did not exit.") }
            child.process.waitUntilExit(); XCTAssertEqual(child.process.terminationStatus, 0)
            let saved = try metadata()
            XCTAssertEqual(saved.mode, 0o640); XCTAssertEqual(saved.attributes["com.arya.cross-host-fixture"], attribute)
            XCTAssertTrue(saved.aclHasEntry, "chmod must install an ACL entry, not merely an empty ACL text header")
        }
    }
    private func withFixture(_ body: (Fixture, Binary, Binary) async throws -> Void) async throws {
        let fixture = try Fixture()
        do {
            let production = try Binary(pathKey: "ARYA_LOCK_PRODUCTION_BINARY", hashKey: "ARYA_LOCK_PRODUCTION_SHA256")
            let testing = try Binary(pathKey: "ARYA_LOCK_TEST_BINARY", hashKey: "ARYA_LOCK_TEST_SHA256")
            for (binary, hooks) in [(production, false), (testing, true)] {
                let info = try fixture.launch(binary, command: "info").wait()
                XCTAssertEqual(info.status, 0); XCTAssertEqual(info.fields["ok"] as? Bool, true)
                XCTAssertEqual(info.fields["testHooks"] as? Bool, hooks)
                XCTAssertEqual(info.fields["protocol"] as? Int, 1)
                XCTAssertEqual(info.fields["platform"] as? String, "darwin")
                XCTAssertEqual(info.fields["metadata"] as? String, "acl-xattr-mode-owner-group")
                XCTAssertEqual(info.fields["publicationLock"] as? String, "recovery-flock-v1")
                XCTAssertEqual(info.fields["expectedIdentity"] as? String, "main-device-inode-v1")
                guard info.status == 0, info.fields["ok"] as? Bool == true, info.fields["testHooks"] as? Bool == hooks,
                      info.fields["protocol"] as? Int == 1, info.fields["platform"] as? String == "darwin",
                      info.fields["metadata"] as? String == "acl-xattr-mode-owner-group",
                      info.fields["publicationLock"] as? String == "recovery-flock-v1",
                      info.fields["expectedIdentity"] as? String == "main-device-inode-v1" else {
                    throw NativeProjectRecovery.error("The supplied C writer does not implement the reviewed cross-host publication protocol.")
                }
            }
            try await fixture.backend.start()
            try await edit(fixture.backend, name: "A"); try await edit(fixture.backend, name: "B")
            _ = try await fixture.backend.handle(method: "POST", path: "/api/undo", body: "{}")
            try fixture.installMetadata()
            try await body(fixture, production, testing)
        } catch {
            await fixture.backend.stop(); try fixture.cleanup(); throw error
        }
        await fixture.backend.stop(); try fixture.cleanup()
    }
    private func edit(_ backend: ReelBackend, name: String) async throws {
        _ = try await backend.editOperations(ops: .array([.object([("op", "project"), ("set", .object([("name", .string(name))]))])]))
    }
    private func name(_ backend: ReelBackend) async throws -> String {
        let current = await backend.currentProject(), project = try XCTUnwrap(current)
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(project.utf8)) as? [String: Any])
        return try XCTUnwrap(fields["name"] as? String)
    }
    private func assertHistory(_ backend: ReelBackend) async throws {
        // The seeded state has a past Original and a future B. Both must survive.
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let original = try await name(backend); XCTAssertEqual(original, "Original")
        _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}")
        let a = try await name(backend); XCTAssertEqual(a, "A")
        _ = try await backend.handle(method: "POST", path: "/api/redo", body: "{}")
        let b = try await name(backend); XCTAssertEqual(b, "B")
        _ = try await backend.handle(method: "POST", path: "/api/undo", body: "{}")
        let restored = try await name(backend); XCTAssertEqual(restored, "A")
    }
    private func next(_ name: String) -> Data {
        Data("{\"version\":3,\"name\":\"\(name)\",\"width\":1920,\"height\":1080,\"fps\":30,\"tracks\":[]}".utf8)
    }

    func testNativeStoreLockRejectsProductionCThenReleaseAllowsCAndRejectsStaleInput() async throws {
        try await withFixture { fixture, production, _ in
            let observed = try fixture.read(), metadata = try fixture.metadata(), inventory = try fixture.inventory(), lock = try fixture.lockIdentity()
            let version = await fixture.backend.currentVersion(), project = await fixture.backend.currentProject()
            try fixture.store.withPublicationLock { held in
                let clock = ContinuousClock(), began = clock.now
                let loser = try fixture.launch(production, input: fixture.input(next("C loser"), expected: observed)).wait(seconds: 2)
                XCTAssertLessThan(began.duration(to: clock.now), .seconds(2))
                XCTAssertEqual(loser.status, 1); XCTAssertEqual(loser.fields["ok"] as? Bool, false); XCTAssertEqual(loser.fields["stage"] as? String, "lock")
                try held.requireIdentity()
                XCTAssertEqual(try fixture.read().data, observed.data); XCTAssertEqual(try fixture.metadata(), metadata)
                XCTAssertEqual(try fixture.inventory(), inventory); XCTAssertEqual(try fixture.lockIdentity(), lock)
            }
            let afterVersion = await fixture.backend.currentVersion(), afterProject = await fixture.backend.currentProject()
            XCTAssertEqual(afterVersion, version); XCTAssertEqual(afterProject, project)
            try await assertHistory(fixture.backend)
            XCTAssertEqual(try fixture.metadata(), metadata)
            await fixture.backend.stop()

            let nativeExpected = try fixture.read(), nativeWinner = next("Native winner")
            _ = try fixture.store.replace(nativeWinner, expected: nativeExpected.data, expectedIdentity: nativeExpected, preserveOriginal: false, admission: {}, validate: fixture.core.validateRecoveryProject)
            let afterNativeInventory = try fixture.inventory()
            let stale = try fixture.launch(production, input: fixture.input(next("Stale C loser"), expected: nativeExpected)).wait()
            XCTAssertEqual(stale.status, 1); XCTAssertEqual(stale.fields["ok"] as? Bool, false); XCTAssertEqual(stale.fields["stage"] as? String, "target")
            XCTAssertEqual(try fixture.read().data, nativeWinner); XCTAssertEqual(try fixture.metadata(), metadata); XCTAssertEqual(try fixture.inventory(), afterNativeInventory)

            let fresh = try fixture.read(), cWinner = next("C winner after release")
            let winner = try fixture.launch(production, input: fixture.input(cWinner, expected: fresh)).wait()
            XCTAssertEqual(winner.status, 0); XCTAssertEqual(winner.fields["ok"] as? Bool, true)
            XCTAssertEqual(winner.fields["directorySynced"] as? Bool, true); XCTAssertEqual(winner.fields["testHooks"] as? Bool, false)
            XCTAssertEqual(try fixture.read().data, cWinner); XCTAssertEqual(try fixture.metadata(), metadata); XCTAssertEqual(try fixture.lockIdentity(), lock)
            try fixture.store.withPublicationLock { try $0.requireIdentity() }
        }
    }

    func testCTestLockRejectsNativeStoreAndBackendThenReleaseAllowsNativeAndRejectsStaleIdentity() async throws {
        try await withFixture { fixture, _, testing in
            let observed = try fixture.read(), metadata = try fixture.metadata(), inventory = try fixture.inventory(), lock = try fixture.lockIdentity()
            let version = await fixture.backend.currentVersion(), project = await fixture.backend.currentProject()
            let ready = fixture.control.appendingPathComponent("ready"), release = fixture.control.appendingPathComponent("release")
            // C replaces A with exactly A after release. The actor's watcher must
            // not gain an unrelated external-edit history entry during this test.
            let holder = try fixture.launch(testing, input: fixture.input(observed.data, expected: observed), extra: [
                "ARYA_TEST_FAULT": "lock-hold", "ARYA_TEST_LOCK_READY": ready.path, "ARYA_TEST_LOCK_RELEASE": release.path
            ])
            defer { holder.killAndReap() }
            try await holder.waitForReady(ready)
            let clock = ContinuousClock(), began = clock.now
            XCTAssertThrowsError(try fixture.store.replace(next("Native loser"), expected: observed.data, expectedIdentity: observed, preserveOriginal: false, admission: {}, validate: fixture.core.validateRecoveryProject)) { error in
                XCTAssertTrue(error.localizedDescription.contains("Another Arya host"), error.localizedDescription)
            }
            do { try await edit(fixture.backend, name: "Backend loser"); XCTFail("A backend commit must respect the C writer's lock") }
            catch { XCTAssertTrue(error.localizedDescription.contains("Another Arya host"), error.localizedDescription) }
            XCTAssertLessThan(began.duration(to: clock.now), .seconds(2))
            let afterVersion = await fixture.backend.currentVersion(), afterProject = await fixture.backend.currentProject()
            XCTAssertEqual(afterVersion, version); XCTAssertEqual(afterProject, project)
            XCTAssertEqual(try fixture.read().data, observed.data); XCTAssertEqual(try fixture.metadata(), metadata)
            XCTAssertEqual(try fixture.inventory(), inventory); XCTAssertEqual(try fixture.lockIdentity(), lock)
            try Data().write(to: release, options: .withoutOverwriting)
            let released = try holder.wait()
            XCTAssertEqual(released.status, 0); XCTAssertEqual(released.fields["ok"] as? Bool, true); XCTAssertEqual(released.fields["testHooks"] as? Bool, true)
            XCTAssertEqual(released.fields["directorySynced"] as? Bool, true)
            let afterC = try fixture.read()
            XCTAssertEqual(afterC.data, observed.data); XCTAssertNotEqual(afterC.inode, observed.inode)
            XCTAssertEqual(try fixture.metadata(), metadata); XCTAssertEqual(try fixture.lockIdentity(), lock)
            XCTAssertThrowsError(try fixture.store.replace(next("Stale native loser"), expected: observed.data, expectedIdentity: observed, preserveOriginal: false, admission: {}, validate: fixture.core.validateRecoveryProject)) { error in
                XCTAssertTrue(error.localizedDescription.contains("identity changed"), error.localizedDescription)
            }
            XCTAssertEqual(try fixture.read().data, observed.data); XCTAssertEqual(try fixture.metadata(), metadata); XCTAssertEqual(try fixture.inventory(), inventory)
            try await assertHistory(fixture.backend)
            XCTAssertEqual(try fixture.metadata(), metadata)
            await fixture.backend.stop()

            let fresh = try fixture.read(), winner = next("Native winner after C release")
            _ = try fixture.store.replace(winner, expected: fresh.data, expectedIdentity: fresh, preserveOriginal: false, admission: {}, validate: fixture.core.validateRecoveryProject)
            XCTAssertEqual(try fixture.read().data, winner); XCTAssertEqual(try fixture.metadata(), metadata); XCTAssertEqual(try fixture.lockIdentity(), lock)
            try fixture.store.withPublicationLock { try $0.requireIdentity() }
        }
    }
}
#endif
