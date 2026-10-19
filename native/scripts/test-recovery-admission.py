#!/usr/bin/env python3
"""Extract recovery admission and session lifetime code. Root owns Swift execution."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile


def declaration(source, needle):
    """Retain one actual Swift declaration, including nested observers and tasks."""
    start = source.index(needle)
    opening = source.index('{', start)
    depth, cursor = 0, opening
    quote = None
    comment = None
    while cursor < len(source):
        pair = source[cursor:cursor + 2]
        char = source[cursor]
        if comment == '//':
            if char == '\n':
                comment = None
        elif comment == '/*':
            if pair == '*/':
                comment = None
                cursor += 1
        elif quote:
            if char == '\\':
                cursor += 1
            elif char == quote:
                quote = None
        elif pair in ('//', '/*'):
            comment = pair
            cursor += 1
        elif char == '"':
            quote = char
        elif char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                return source[start:cursor + 1]
        cursor += 1
    raise AssertionError(f'Unbalanced Swift declaration: {needle}')


def ios_projection(source):
    """Choose actual iOS branches on Mac without replacing their Swift bodies."""
    active, stack, result = True, [], []
    for line in source.splitlines(keepends=True):
        directive = line.strip()
        if directive.startswith('#if '):
            condition = directive[4:]
            assert condition in ('os(iOS)', 'os(macOS)'), condition
            selected = condition == 'os(iOS)'
            stack.append((active, selected))
            active = active and selected
        elif directive == '#else':
            parent, selected = stack[-1]
            active = parent and not selected
        elif directive == '#endif':
            active, _ = stack.pop()
        else:
            assert not directive.startswith('#elseif'), directive
            if active:
                result.append(line)
    assert not stack, 'Unclosed platform branch'
    return ''.join(result)


def own_tasks(source, name):
    """Record original Task handles without replacing their initializer closures."""
    replacements, result, cursor = [], [], 0
    for match in re.finditer(r'\bTask\s*\{', source):
        if match.start() < cursor:
            raise AssertionError('Nested task creation requires explicit fixture ownership')
        original = declaration(source[match.start():], match.group(0))
        label = f'{name}.{len(replacements) + 1}'
        replacement = f'recordRecoveryTask("{label}", task: {original})'
        replacements.append((replacement, original, label))
        result.extend((source[cursor:match.start()], replacement))
        cursor = match.start() + len(original)
    result.append(source[cursor:])
    return ''.join(result), replacements


SEAMS = r'''
import Foundation

// Task creation records the real task handle. Its closure body remains actual source.
@MainActor final class RecoveryTaskRecord {
    let label: String
    private let completion: @MainActor () async throws -> Void
    private(set) var awaited = false
    init(_ label: String, completion: @escaping @MainActor () async throws -> Void) {
        self.label = label; self.completion = completion
    }
    func wait() async throws { defer { awaited = true }; try await completion() }
}
@MainActor enum RecoveryTasks {
    static var started: [RecoveryTaskRecord] = []
    static func latest(_ label: String) -> RecoveryTaskRecord {
        guard let task = started.last(where: { $0.label == label }) else { fatalError("No actual task was created for " + label) }
        return task
    }
}
@MainActor func recordRecoveryTask(_ label: String, task: Task<Void, Never>) -> Task<Void, Never> {
    RecoveryTasks.started.append(RecoveryTaskRecord(label) { await task.value })
    return task
}
@MainActor func recordRecoveryTask(_ label: String, task: Task<Void, Error>) -> Task<Void, Error> {
    RecoveryTasks.started.append(RecoveryTaskRecord(label) { try await task.value })
    return task
}

// Backend replies, UIKit document callbacks and editor UI remain runtime seams.
public struct NativeProjectRecoveryChoice: Equatable, Sendable {
    let id: String, familyID: String, host: String, createdAt: String, sha256: String
    let bytes: Int
}
public struct NativeProjectRecoveryOffer: Sendable {
    let choices: [NativeProjectRecoveryChoice]
    let observedToken: String
}
struct ProjectFolder: Sendable { let root: URL }

enum UIDocument {
    struct State: OptionSet, Sendable {
        let rawValue: Int
        static let closed = State(rawValue: 1)
        static let inConflict = State(rawValue: 2)
        static let savingError = State(rawValue: 4)
        static let editingDisabled = State(rawValue: 8)
    }
}
@MainActor final class NativeProjectDocument: NSObject, ProjectFilePresenter, @unchecked Sendable {
    nonisolated let fileURL: URL
    nonisolated let presentedItemOperationQueue = OperationQueue()
    nonisolated var presentedItemURL: URL? { fileURL }
    nonisolated func projectFileDidPublish(_ data: Data) {}
    var changed: (() -> Void)?
    var stateChanged: ((UIDocument.State) -> Void)?
    var documentState: UIDocument.State = .closed
    var opening: ((Bool) -> Void)?
    init(fileURL: URL) { self.fileURL = fileURL; super.init() }
    func open(_ completion: @escaping (Bool) -> Void) { opening = completion }
    func close(_ completion: (Bool) -> Void) { completion(true) }
}
@MainActor final class ActivitySeam { func invalidate() {} }
enum NativeHandoff {
    @MainActor static func activity(folder: URL, name: String) -> ActivitySeam { ActivitySeam() }
}
@MainActor final class EditorUISeam {
    struct Project { let name: String }
    var project: Project?
    var resets = 0, refreshes = 0
    func reset() { resets += 1 }
    func refresh() async { refreshes += 1 }
}

actor ReelBackend {
    struct APIError: LocalizedError, Sendable {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
    nonisolated let folder: ProjectFolder
    let writes: ProjectWriteAdmission
    private var offers: [Int: CheckedContinuation<NativeProjectRecoveryOffer, Error>] = [:]
    private var restores: [Int: CheckedContinuation<Void, Error>] = [:]
    private var stops: [CheckedContinuation<Void, Never>] = []
    private var permissions: [Int: ProjectWriteAdmission.RecoveryPermission] = [:]
    private(set) var offerCount = 0, restoreCount = 0, stopCount = 0
    init(folder: ProjectFolder, writes: ProjectWriteAdmission) { self.folder = folder; self.writes = writes }
    func projectRecoveryOffer() async throws -> NativeProjectRecoveryOffer {
        offerCount += 1
        let index = offerCount
        return try await withCheckedThrowingContinuation { offers[index] = $0 }
    }
    func currentVersion() -> Int { 7 }
    // __ACTUAL_RECOVERY_OPERATION__
    func restoreProjectRecovery(_ choice: NativeProjectRecoveryChoice, observedToken: String,
                                expectedVersion: Int, permission: ProjectWriteAdmission.RecoveryPermission?) async throws {
        if let permission { try permission.require(recoveryOperation(choice, observedToken: observedToken, expectedVersion: expectedVersion)) }
        else { try writes.requireWritable() }
        restoreCount += 1
        let index = restoreCount
        permissions[index] = permission
        try await withCheckedThrowingContinuation { restores[index] = $0 }
    }
    func permit(_ index: Int) -> ProjectWriteAdmission.RecoveryPermission? { permissions[index] }
    func succeedOffer(_ index: Int, _ offer: NativeProjectRecoveryOffer) { offers.removeValue(forKey: index)!.resume(returning: offer) }
    func failOffer(_ index: Int) { offers.removeValue(forKey: index)!.resume(throwing: APIError("late offer failure")) }
    func succeedRestore(_ index: Int) { restores.removeValue(forKey: index)!.resume() }
    func failRestore(_ index: Int) { restores.removeValue(forKey: index)!.resume(throwing: APIError("restore failure")) }
    func stop() async {
        stopCount += 1
        await withCheckedContinuation { stops.append($0) }
    }
    func releaseStops() { let pending = stops; stops.removeAll(); pending.forEach { $0.resume() } }
    func hasPageProcessingWorkers() -> Bool { false }
    func refreshProjectFile() throws {}
}
'''


SESSION_SEAMS = r'''
@MainActor final class EditorSession {
    var folder: URL?
    var error: String?
    // __ACTUAL_REQUEST_OBSERVER__
    private var projectRecoveryPermission: ProjectWriteAdmission.RecoveryPermission?
    private(set) var recoveringProject = false
    private(set) var projectRecoveryError: String?
    private(set) var backend: ReelBackend?
    private var backendID = UUID().uuidString
    private var documentAdmission: NativeDocumentAdmission?
    private var projectDocument: NativeProjectDocument?
    private var projectReadOnlyReason: String?
    let nativeEditor = EditorUISeam(), assistant = EditorUISeam()
    private var retiredPageWorkerBackends: [ObjectIdentifier: ReelBackend] = [:]
    private var retiredPageWorkerSessions: [String: ReelBackend] = [:]
    private var pageWorkerDrainTask: Task<Void, Error>?
    private var pageWorkerDrainID: UUID?
    private var accessing: URL?
    private var sessionID = UUID().uuidString
    private var pageReady = false
    private var handoff: ActivitySeam?
    private(set) var reopened: [URL] = []

    // Test setup and UI open are seams. close and the recovery methods below are actual source.
    func install(_ backend: ReelBackend, folder: URL, admission: NativeDocumentAdmission) {
        self.backend = backend; self.folder = folder; backendID = UUID().uuidString
        documentAdmission = admission; projectDocument = nil
    }
    func open(_ folder: URL) {
        reopened.append(folder)
        close()
        let admission = NativeDocumentAdmission()
        admission.beginOpening()
        install(ReelBackend(folder: ProjectFolder(root: folder), writes: admission.writes), folder: folder, admission: admission)
    }
    func attachPresenter() { refreshDocument(backend: backend!, folder: folder!) }
    var admissionForTest: NativeDocumentAdmission { documentAdmission! }
    var hasPresenterForTest: Bool { projectDocument != nil }
    var permissionForTest: ProjectWriteAdmission.RecoveryPermission? { projectRecoveryPermission }
    var pageDrainForTest: Task<Void, Error>? { pageWorkerDrainTask }
    private func drainCurrentPageExports() async throws { fatalError("This fixture has no page workers") }
    // __ACTUAL_SESSION_METHODS__
}
'''


TESTS = r'''
@MainActor var assertions = 0
@MainActor var cases = 0
@MainActor func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    assertions += 1
    if !condition() { fatalError(message) }
}
@MainActor func denied(_ message: String, _ body: () throws -> Void) {
    do { try body(); fatalError(message) } catch { assertions += 1 }
}
@MainActor func eventually(_ message: String, _ condition: @MainActor () async -> Bool) async {
    for _ in 0..<2000 {
        if await condition() { assertions += 1; return }
        try? await Task.sleep(nanoseconds: 1_000_000)
    }
    fatalError(message)
}
func choice(_ suffix: String = "one") -> NativeProjectRecoveryChoice {
    .init(id: suffix, familyID: "family", host: "native", createdAt: "2026-10-04T00:00:00Z", sha256: String(repeating: "a", count: 64), bytes: 32)
}
func offer(_ selected: NativeProjectRecoveryChoice = choice()) -> NativeProjectRecoveryOffer {
    .init(choices: [selected], observedToken: "observed-disk-token")
}
@MainActor func admission(cold: Bool) -> NativeDocumentAdmission {
    let value = NativeDocumentAdmission()
    value.beginOpening()
    if !cold {
        _ = value.opened(success: true, state: .init())
        let ticket = value.beginValidation()!
        _ = value.finishValidation(ticket, error: nil, state: .init())
    }
    return value
}
@MainActor func fixture(_ root: URL, cold: Bool = true) -> (EditorSession, ReelBackend, NativeDocumentAdmission) {
    let access = admission(cold: cold), backend = ReelBackend(folder: .init(root: root), writes: access.writes), session = EditorSession()
    session.install(backend, folder: root, admission: access)
    return (session, backend, access)
}
@MainActor func request(_ backend: ReelBackend, _ root: URL, cold: Bool = true, selected: NativeProjectRecoveryChoice = choice()) -> NativeProjectRecoveryRequest {
    .init(backend: backend, folder: root, version: 7, offer: offer(selected), failedOpen: cold)
}

@main struct RecoveryAdmissionTests {
    @MainActor static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("arya-recovery-admission-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("{}".utf8).write(to: root.appendingPathComponent("reel.project.json"))

        // A permit binds the actual backend identity, choice metadata, disk token and version.
        do {
            cases += 1
            let (_, backend, access) = fixture(root)
            let operation = backend.recoveryOperation(choice(), observedToken: "disk", expectedVersion: 7)
            let permit = try access.recoveryPermission(for: operation)
            try permit.require(operation)
            denied("A cold recovery permit must not enable ordinary writes") { try access.writes.requireWritable() }
            for changed in [backend.recoveryOperation(choice("other"), observedToken: "disk", expectedVersion: 7),
                            backend.recoveryOperation(choice(), observedToken: "changed", expectedVersion: 7),
                            backend.recoveryOperation(choice(), observedToken: "disk", expectedVersion: 8)] {
                denied("A permission must match its exact operation") { try permit.require(changed) }
            }
            let other = ReelBackend(folder: .init(root: root), writes: access.writes)
            denied("A matching path cannot substitute another backend owner") {
                try permit.require(other.recoveryOperation(choice(), observedToken: "disk", expectedVersion: 7))
            }
            permit.revoke()
            denied("Explicit revocation must be synchronous") { try permit.require(operation) }
            let plain = NativeDocumentAdmission()
            denied("A closed initial state without beginOpening is not a cold recovery state") { _ = try plain.recoveryPermission(for: operation) }
            plain.writes.setBlockedReason("Files is opening the project document.")
            denied("Matching display text cannot manufacture typed recovery admission") { _ = try plain.writes.recoveryPermission(for: operation) }
        }
        for transition in 0..<8 {
            cases += 1
            let (_, backend, access) = fixture(root)
            let operation = backend.recoveryOperation(choice(), observedToken: "disk", expectedVersion: 7)
            let permit = try access.recoveryPermission(for: operation)
            switch transition {
            case 0: _ = access.observe(.init(conflict: true, closed: true))
            case 1: _ = access.observe(.init(savingError: true, closed: true))
            case 2: _ = access.observe(.init(editingDisabled: true, closed: true))
            case 3: _ = access.observe(.init())
            case 4: _ = access.opened(success: false, state: .init(closed: true))
            case 5: _ = access.opened(success: true, state: .init())
            case 6: access.close()
            default: access.beginOpening()
            }
            denied("Every observed state or opening generation change revokes the old permit") { try permit.require(operation) }
            denied("A transition cannot make unvalidated ordinary writes available") { try access.writes.requireWritable() }
        }
        // Current cold success reopens through the UI seam and starts another blocked opening.
        do {
            cases += 1
            let (session, backend, _) = fixture(root), selected = choice(), current = request(backend, root)
            session.projectRecoveryRequest = current
            session.restoreProjectRecovery(selected, request: current)
            let restoreTask = RecoveryTasks.latest("restore.1")
            expect(session.recoveringProject, "Restore claims its request before actor delivery")
            let permission = session.permissionForTest!
            let operation = backend.recoveryOperation(selected, observedToken: current.offer.observedToken, expectedVersion: current.version)
            session.dismissProjectRecovery(current)
            expect(session.projectRecoveryRequest?.id == current.id && session.recoveringProject, "Busy Restore cannot be dismissed under its active permit")
            try permission.require(operation)
            await eventually("The selected restore must reach the backend seam") { await backend.restoreCount == 1 }
            await backend.succeedRestore(1)
            try await restoreTask.wait()
            expect(session.reopened.count == 1, "Current success must reopen the failed cold project")
            expect(session.projectRecoveryRequest == nil && !session.recoveringProject, "Current success clears only its own request")
            denied("Success consumes the old permit") { try permission.require(operation) }
            expect(!session.admissionForTest.hasOpened, "Reopening is still waiting for the new document")
            denied("Reopening must keep ordinary writes blocked") { try session.admissionForTest.writes.requireWritable() }
            await eventually("The old backend close actor must be suspended") { await backend.stopCount == 1 }
            let drain = session.pageDrainForTest!, closeTask = RecoveryTasks.latest("close.1")
            await backend.releaseStops()
            try await drain.value
            try await closeTask.wait()
        }
        do {
            cases += 1
            let (session, backend, _) = fixture(root), current = request(backend, root)
            session.projectRecoveryRequest = current
            session.restoreProjectRecovery(choice(), request: current)
            let restoreTask = RecoveryTasks.latest("restore.1")
            let permission = session.permissionForTest!
            await eventually("Failure fixture starts an actual restore Task") { await backend.restoreCount == 1 }
            await backend.failRestore(1)
            try await restoreTask.wait()
            expect(!session.recoveringProject, "Current failure must stop its busy state")
            expect(session.projectRecoveryRequest?.id == current.id, "Current failure preserves its recovery choice")
            expect(session.projectRecoveryError == "restore failure" && session.reopened.isEmpty, "Current failure belongs to this request")
            denied("Failure consumes its permit") { try permission.require(backend.recoveryOperation(choice(), observedToken: current.offer.observedToken, expectedVersion: 7)) }
        }
        for lateFailure in [false, true] {
            cases += 1
            let (session, backend, _) = fixture(root, cold: false)
            session.offerProjectRecovery()
            let firstOfferTask = RecoveryTasks.latest("offer.1")
            await eventually("The first offer owns the first suspended backend reply") { await backend.offerCount == 1 }
            session.offerProjectRecovery()
            let lateOfferTask = RecoveryTasks.latest("offer.1")
            expect(firstOfferTask !== lateOfferTask, "The overlapping offers retain distinct actual task handles")
            await eventually("Both actual offer Tasks must be pending") { await backend.offerCount == 2 }
            await backend.succeedOffer(1, offer())
            try await firstOfferTask.wait()
            expect(session.projectRecoveryRequest != nil, "The first offer must become the visible request")
            let current = session.projectRecoveryRequest!
            session.restoreProjectRecovery(choice(), request: current)
            let restoreTask = RecoveryTasks.latest("restore.1")
            await eventually("Restore from the first returned offer must begin") { await backend.restoreCount == 1 }
            if lateFailure { await backend.failOffer(2) } else { await backend.succeedOffer(2, offer(choice("late"))) }
            try await lateOfferTask.wait()
            expect(session.projectRecoveryRequest?.id == current.id, "A late offer cannot replace an active Restore")
            expect(session.recoveringProject && session.error == nil && session.projectRecoveryError == nil, "A late offer cannot replace Restore's busy state or error")
            await backend.succeedRestore(1)
            try await restoreTask.wait()
            expect(session.nativeEditor.refreshes == 1, "Normal current success refreshes its editor")
            expect(session.reopened.isEmpty, "Normal recovery does not reopen a cold document")
        }
        for lateFailure in [false, true] {
            cases += 1
            let (session, backend, _) = fixture(root), first = request(backend, root), secondChoice = choice("second")
            session.projectRecoveryRequest = first
            session.restoreProjectRecovery(choice(), request: first)
            let oldRestoreTask = RecoveryTasks.latest("restore.1")
            let old = session.permissionForTest!
            await eventually("The old request reaches its suspended backend") { await backend.restoreCount == 1 }
            let replacement = request(backend, root, selected: secondChoice)
            session.projectRecoveryRequest = replacement
            expect(!session.recoveringProject && session.projectRecoveryError == nil, "A new UUID resets the old operation synchronously")
            denied("Explicit request replacement revokes the old permit") { try old.require(backend.recoveryOperation(choice(), observedToken: first.offer.observedToken, expectedVersion: 7)) }
            session.restoreProjectRecovery(secondChoice, request: replacement)
            let newRestoreTask = RecoveryTasks.latest("restore.1")
            let fresh = session.permissionForTest!
            await eventually("A replacement request can start its own Restore") { await backend.restoreCount == 2 }
            if lateFailure { await backend.failRestore(1) } else { await backend.succeedRestore(1) }
            try await oldRestoreTask.wait()
            expect(session.projectRecoveryRequest?.id == replacement.id && session.recoveringProject, "Old completion cannot clear the replacement's active operation")
            expect(session.projectRecoveryError == nil && session.reopened.isEmpty, "Old completion cannot replace the new error or reopen")
            try fresh.require(backend.recoveryOperation(secondChoice, observedToken: replacement.offer.observedToken, expectedVersion: 7))
            await backend.failRestore(2)
            try await newRestoreTask.wait()
            expect(!session.recoveringProject, "Replacement failure settles its own operation")
            expect(session.projectRecoveryError == "restore failure", "The replacement remains usable and owns its outcome")
        }
        // close is the complete production method, including its suspended stop Task.
        do {
            cases += 1
            let (session, oldBackend, oldAdmission) = fixture(root), oldRequest = request(oldBackend, root)
            session.projectRecoveryRequest = oldRequest
            session.restoreProjectRecovery(choice(), request: oldRequest)
            let oldRestoreTask = RecoveryTasks.latest("restore.1")
            let oldPermit = session.permissionForTest!
            await eventually("Old Restore is suspended before close") { await oldBackend.restoreCount == 1 }
            session.close()
            let oldDrain = session.pageDrainForTest!, oldCloseTask = RecoveryTasks.latest("close.1")
            denied("Close revokes the permit before the old actor returns") { try oldPermit.require(oldBackend.recoveryOperation(choice(), observedToken: oldRequest.offer.observedToken, expectedVersion: 7)) }
            denied("Close synchronously blocks the old ordinary token") { try oldAdmission.writes.requireWritable() }
            expect(session.backend == nil && session.projectRecoveryRequest == nil, "Close drops the current request and backend immediately")
            await eventually("The actor stop seam must still be pending") { await oldBackend.stopCount == 1 }
            let newAdmission = admission(cold: true), newBackend = ReelBackend(folder: .init(root: root), writes: newAdmission.writes)
            session.install(newBackend, folder: root, admission: newAdmission)
            let replacement = request(newBackend, root, selected: choice("new-owner"))
            session.projectRecoveryRequest = replacement
            session.restoreProjectRecovery(choice("new-owner"), request: replacement)
            let newRestoreTask = RecoveryTasks.latest("restore.1")
            let newPermit = session.permissionForTest!
            await eventually("New backend owns a usable restore") { await newBackend.restoreCount == 1 }
            await oldBackend.succeedRestore(1); await oldBackend.releaseStops()
            try await oldRestoreTask.wait()
            try await oldDrain.value
            try await oldCloseTask.wait()
            expect(session.projectRecoveryRequest?.id == replacement.id && session.recoveringProject && session.projectRecoveryError == nil, "Late old backend work cannot clear the new operation")
            try newPermit.require(newBackend.recoveryOperation(choice("new-owner"), observedToken: replacement.offer.observedToken, expectedVersion: 7))
            await newBackend.failRestore(1)
            try await newRestoreTask.wait()
            expect(!session.recoveringProject, "The new backend can settle normally")
        }
        do {
            cases += 1
            let (session, backend, access) = fixture(root), current = request(backend, root)
            session.projectRecoveryRequest = current
            session.restoreProjectRecovery(choice(), request: current)
            let restoreTask = RecoveryTasks.latest("restore.1")
            let permission = session.permissionForTest!
            await eventually("Presenter fixture suspends a Restore") { await backend.restoreCount == 1 }
            session.attachPresenter()
            expect(session.hasPresenterForTest, "The actual refreshDocument creates its document seam")
            denied("Presenter creation revokes before its open callback") { try permission.require(backend.recoveryOperation(choice(), observedToken: current.offer.observedToken, expectedVersion: 7)) }
            denied("Presenter opening keeps ordinary writes blocked") { try access.writes.requireWritable() }
            await backend.failRestore(1)
            try await restoreTask.wait()
            expect(!session.recoveringProject, "Revoked in-flight presenter Restore settles as a failure")
            session.restoreProjectRecovery(choice(), request: current)
            expect(session.projectRecoveryError?.contains("Files already changed") == true, "A presenter prevents minting another cold permit")
            expect(session.permissionForTest == nil, "A rejected retry installs no recovery permission")
        }
        do {
            cases += 1
            let (session, backend, _) = fixture(root), current = request(backend, root)
            session.projectRecoveryRequest = current
            session.dismissProjectRecovery(current)
            let drain = session.pageDrainForTest!, closeTask = RecoveryTasks.latest("close.1")
            expect(session.projectRecoveryRequest == nil && session.backend == nil, "Dismissing a failed cold opening closes it")
            await eventually("Dismissed backend stops through the actual close Task") { await backend.stopCount == 1 }
            await backend.releaseStops()
            try await drain.value
            try await closeTask.wait()
        }
        expect(cases == 18, "The runtime case count must match the script's static report")
        expect(!RecoveryTasks.started.isEmpty && RecoveryTasks.started.allSatisfy { $0.awaited }, "Every started extracted task must be awaited exactly through its recorded handle")
        print("Recovery admission actual extracted Swift cases: \(cases), assertions: \(assertions)")
        print("Backend filesystem publication and real UIKit/provider behavior are separate root execution gates.")
    }
}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--contracts-only', action='store_true')
    args = parser.parse_args()
    root = args.source_root.resolve()
    files = {
        'session': root / 'native/App/Shared/EditorSession.swift',
        'token': root / 'native/ReelKit/Sources/ReelKit/ProjectWriteAdmission.swift',
        'backend': root / 'native/ReelKit/Sources/ReelKit/ReelBackend.swift',
    }
    source = {name: file.read_text() for name, file in files.items()}
    session = source['session']
    owner = session[session.index('@MainActor\nfinal class EditorSession'):]
    controller = session.split('// BEGIN DOCUMENT ADMISSION', 1)[1].split('// END DOCUMENT ADMISSION', 1)[0]
    request_type = declaration(session, 'struct NativeProjectRecoveryRequest: Identifiable')
    observer = declaration(owner, '@Published var projectRecoveryRequest:').replace('@Published ', '', 1)
    names = {
        'offer': 'func offerProjectRecovery()',
        'dismiss': 'func dismissProjectRecovery(',
        'restore': 'func restoreProjectRecovery(',
        'close': 'func close()',
        'presenter': 'private func refreshDocument(',
        'projection': 'private static func documentState(',
        'validation': 'private func revalidateDocument(',
        'retirement': 'private func forgetRetiredPageWorker(',
    }
    methods = {name: declaration(owner, needle) for name, needle in names.items()}
    operation = declaration(source['backend'], 'public nonisolated func recoveryOperation(')
    backend_restore = declaration(source['backend'], 'public func restoreProjectRecovery(')
    selected_admission = declaration(source['backend'], 'private func requireSelectedRecoveryAdmission(')
    actual_open = declaration(owner, 'func open(_ url: URL, completion:')
    checks = 0

    def check(value, message):
        nonlocal checks
        assert value, message
        checks += 1

    check('opening && !ended && !hasOpened && failure == nil && validation == nil && state.closed' in controller, 'Cold permission comes from typed document state')
    check('!state.conflict && !state.savingError && !state.editingDisabled' in controller, 'Conflict, failure and disabled states cannot permit cold recovery')
    check('writes.setBlockedReason(reason, recoveryAvailable: permitsColdRecovery)' in controller, 'Controller passes a typed permission flag rather than display text')
    check('recoveryGeneration = UUID()' in source['token'] and 'recoveryGeneration == generation' in source['token'], 'State updates rotate and check the synchronous generation')
    check('self.operation == operation' in source['token'] and 'guard !revoked' in source['token'], 'Permission checks exact operation and explicit revocation')
    check('lock.withLock' in source['token'] and 'NativeProjectPersistence' not in source['token'], 'Permission lock never coordinates filesystem publication')
    check('oldValue?.id != projectRecoveryRequest?.id' in observer and 'projectRecoveryPermission?.revoke()' in observer, 'Request UUID replacement revokes its previous permit')
    check('recoveringProject = false; projectRecoveryError = nil' in observer, 'Request replacement releases old busy and error state')
    check('let generation = backendID' in methods['offer'] and methods['offer'].count('self.backendID == generation') == 2, 'Offer success and failure retain their backend generation')
    check(methods['offer'].count('!self.recoveringProject') == 2, 'Late overlapping offers cannot replace an active Restore')
    check('!recoveringProject' in methods['dismiss'] and 'if request.failedOpen { close() }' in methods['dismiss'], 'Dismiss retains its current owner and closes cold opening')
    check('request.offer.choices.contains' in methods['restore'] and '== operation' in methods['restore'], 'Restore binds a choice from its actual offer')
    check('guard projectDocument == nil, let admission = documentAdmission' in methods['restore'], 'Cold restore cannot mint a permit after presenter creation')
    check('permission = try admission.recoveryPermission(for: operation)' in methods['restore'], 'Session requests the actual typed permission')
    check(methods['restore'].count('backendID == generation') == 2 and methods['restore'].count('projectRecoveryRequest?.id == request.id') == 3, 'Entry and both completion paths retain request and backend owners')
    check('defer { permission?.revoke() }' in methods['restore'], 'Both session outcomes consume the permit')
    check('if request.failedOpen { open(request.folder) }' in methods['restore'] and 'else { await nativeEditor.refresh() }' in methods['restore'], 'Cold success reopens while ordinary recovery refreshes')
    check(methods['close'].index('projectRecoveryRequest = nil') < methods['close'].index('Task {'), 'Close revokes the request before asynchronous actor stop')
    check(methods['close'].index('documentAdmission?.close()') < methods['close'].index('await previousBackend.stop()'), 'Document access closes synchronously before actor delivery')
    check(methods['presenter'].index('projectRecoveryPermission?.revoke()') < methods['presenter'].index('let document = NativeProjectDocument'), 'Presenter creation revokes before opening UIKit')
    check(actual_open.index('close()') < actual_open.index('admission.beginOpening()') < actual_open.index('ReelBackend(folder:'), 'Reopen begins with close and a new blocked admission')
    check('writeAccess = { try writes.requireWritable() }' in actual_open, 'The newly opened backend retains ordinary synchronous admission')
    check('permission?.revoke()' in backend_restore and 'requireSelectedRecoveryAdmission(permission: permission, operation: operation)' in backend_restore, 'Actual backend consumes and checks selected permission')
    check('admission: { try self.requireSelectedRecoveryAdmission' in backend_restore, 'Actual backend rechecks selected permission at coordinated publication')
    check('if let permission { try permission.require(operation) }' in selected_admission and 'else { try writeAdmission() }' in selected_admission, 'Ordinary backend writes do not receive the recovery exception')
    projected = {name: ios_projection(method) for name, method in methods.items()}
    check('permission = try admission.recoveryPermission' in projected['restore'] and '#if' not in projected['restore'], 'Mac fixture retains the actual iOS permission branch')
    check('documentAdmission?.close()' in projected['close'] and 'previousDocument?.stateChanged = nil' in projected['close'], 'Mac fixture retains actual iOS close lifetime')
    instrumented, replacements = {}, []
    for name, method in projected.items():
        rewritten, owned = own_tasks(method, name)
        round_trip = rewritten
        for replacement, original, _ in owned:
            round_trip = round_trip.replace(replacement, original, 1)
        check(round_trip == method, f'{name} task instrumentation keeps the actual closure body unchanged')
        unowned = rewritten
        for replacement, _, _ in owned:
            unowned = unowned.replace(replacement, '', 1)
        check(not re.search(r'\bTask\s*\{', unowned), f'{name} has no unowned extracted task creation')
        instrumented[name] = rewritten
        replacements.extend(owned)
    check(len(replacements) == 7, 'All seven actual iOS-projected task creation sites have retained handles')
    check('Task.yield()' not in TESTS, 'A fixed yield count is never used as completion evidence')
    check('try await lateOfferTask.wait()' in TESTS and 'try await oldRestoreTask.wait()' in TESTS, 'Late offer and old restore assertions await their exact tasks')
    check('try await oldDrain.value' in TESTS and 'try await drain.value' in TESTS, 'Close cases await the captured actual pageWorkerDrainTask')
    check('RecoveryTasks.started.allSatisfy { $0.awaited }' in TESTS, 'Runtime rejects any started extracted task that the fixture never awaited')
    swift = SEAMS.replace('// __ACTUAL_RECOVERY_OPERATION__', operation)
    swift += '\n' + source['token'] + '\n' + controller + '\n' + request_type + '\n'
    swift += SESSION_SEAMS.replace('// __ACTUAL_REQUEST_OBSERVER__', observer).replace('// __ACTUAL_SESSION_METHODS__', '\n\n'.join(instrumented.values()))
    swift += TESTS
    check('__ACTUAL_' not in swift, 'Every extraction insertion was resolved')
    report = {
        'contractsPassed': checks,
        'sourceSHA256': {name: hashlib.sha256(file.read_bytes()).hexdigest() for name, file in files.items()},
        'extractedSwiftSHA256': hashlib.sha256(swift.encode()).hexdigest(),
        'runtimeExecuted': False,
        'authoredCases': 18,
        'ownedTaskSites': [label for _, _, label in replacements],
    }
    print(json.dumps(report, indent=2), flush=True)
    if args.contracts_only:
        return
    with tempfile.TemporaryDirectory(prefix='arya-recovery-admission-') as temporary:
        temporary = Path(temporary)
        fixture = temporary / 'recovery-admission.swift'
        fixture.write_text(swift)
        binary = temporary / 'recovery-admission-tests'
        subprocess.run(['swiftc', '-j1', '-module-cache-path', str(temporary / 'module-cache'), '-parse-as-library', '-o', str(binary), str(fixture)], check=True)
        subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    main()
