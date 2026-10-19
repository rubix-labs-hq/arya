#!/usr/bin/env python3
"""Extract and exercise the production admission controller/token; no UIKit or full app build."""
import argparse
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--contracts-only', action='store_true')
args = parser.parse_args()
root = args.source_root.resolve()
session = (root / 'native/App/Shared/EditorSession.swift').read_text()
backend = (root / 'native/ReelKit/Sources/ReelKit/ReelBackend.swift').read_text()
view = (root / 'native/App/Shared/NativeEditor/NativeEditorView.swift').read_text()
token = root / 'native/ReelKit/Sources/ReelKit/ProjectWriteAdmission.swift'
controller = session.split('// BEGIN DOCUMENT ADMISSION', 1)[1].split('// END DOCUMENT ADMISSION', 1)[0]
checks = 0

def check(value, message):
    global checks
    assert value, message
    checks += 1

check('try writeAdmission()' in backend.split('private func requireWritableProject()', 1)[1].split('private func stat()', 1)[0], 'Entry/final publication reads synchronous host admission')
check('writeAdmission: @escaping @Sendable () throws -> Void = {}' in backend, 'Default backend callers remain unrestricted')
check('try requireWritableProject()\n        try validateCurrentProcessing()\n        return try NativeTranscriptStore.saveRecognition' in backend, 'Async recognition rechecks before transcript publication')
check('public func upload' in backend and 'try requireWritableProject()' in backend.split('public func upload', 1)[1].split('public func saveExport', 1)[0], 'Direct web uploads share admission')
check('self.documentAdmission === admission' in session and 'self.projectDocument === document' in session, 'Current backend/document/token identities guard callbacks')
check('documentAdmission?.close()' in session and session.index('documentAdmission?.close()') < session.index('let previousDocument'), 'Close synchronously blocks old token before async backend stop')
check('writeAccess = { try writes.requireWritable() }' in session, 'Backend captures thread-safe token independently of actor delivery')
check('admission.observe(Self.documentState(state))' in session, 'Document notifications update production controller synchronously')
check('let again = admission.finishValidation(ticket' in session, 'Revalidation completion uses ticket and latest document flags')
check('try await backend.refreshProjectFile(); failure = nil' in session, 'Conflict/open recovery rereads before enabling')
check('state.contains(.inConflict)' in session and 'state.contains(.editingDisabled)' in session and 'state.contains(.savingError)' in session and 'state.contains(.closed)' in session, 'Relevant UIKit states are projected explicitly')
check('state.contains(.progressAvailable)' not in session, 'Progress alone does not disable editing')
check('handoff == nil || projectDocument == nil' in session, 'Late project creation can attach a missing document independently of Handoff')
check('session.projectReadOnlyReason.map' in view and 'Text(status)' in view, 'Admission reason persists over ordinary activity status')
check('Button("Retry project access")' in view, 'Failed revalidation has an explicit user retry')
check('lock.withLock { reason }' in token.read_text() and 'NativeProjectPersistence' not in token.read_text(), 'Lock covers only snapshots and never coordination')
print(f'Document admission source contracts passed: {checks}', flush=True)
if args.contracts_only:
    raise SystemExit(0)

swift = r'''
import Foundation

// Only the backend error type is a seam here. The token and controller are production code.
enum ReelBackend {
    struct APIError: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}
var assertions = 0
func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    assertions += 1
    if !condition() { fatalError(message) }
}
func blocked(_ token: ProjectWriteAdmission, _ message: String) {
    do { try token.requireWritable(); fatalError(message) }
    catch { assertions += 1 }
}
@main struct AdmissionTests {
    @MainActor static func main() throws {
        let normal = NativeDocumentAdmission.State()
        let pending = NativeDocumentAdmission()
        try pending.writes.requireWritable() // Empty folder creation before document attachment.
        expect(pending.writes.blockedReason == nil, "Unattached document leaves valid New/import available")
        pending.beginOpening()
        blocked(pending.writes, "Opening must block")
        expect(!pending.observe(normal), "Normal notification cannot bypass pending open completion")
        expect(pending.writes.blockedReason != nil, "Still pending until open returns")
        expect(pending.opened(success: true, state: normal), "Successful open requests one reread")
        blocked(pending.writes, "Successful open remains blocked until reread")
        let initial = pending.beginValidation()!
        expect(pending.beginValidation() == nil, "Only one validation is admitted")
        expect(!pending.finishValidation(initial, error: nil, state: normal), "Initial reread enables without another loop")
        try pending.writes.requireWritable()
        expect(pending.writes.blockedReason == nil, "Valid document is writable")

        let disabled = NativeDocumentAdmission.State(editingDisabled: true)
        expect(!pending.observe(disabled), "Transient editingDisabled does not start a reread")
        blocked(pending.writes, "UIKit disables editing")
        expect(!pending.observe(normal), "Normal clears a transient disable without coordination recursion")
        try pending.writes.requireWritable()
        expect(pending.writes.blockedReason == nil, "Transient disable recovers")

        let conflict = NativeDocumentAdmission.State(conflict: true)
        expect(!pending.observe(conflict), "Conflict never attempts validation until resolved")
        blocked(pending.writes, "Conflict blocks synchronous mutation")
        expect(pending.observe(normal), "Resolved conflict requires reread")
        let conflictTicket = pending.beginValidation()!
        expect(!pending.observe(disabled), "Coordinator's own disable while checking does not schedule a second check")
        expect(!pending.observe(normal), "Normal while checking cannot preempt validation")
        expect(!pending.finishValidation(conflictTicket, error: nil, state: normal), "Own transient state cannot cause a permanent loop")
        try pending.writes.requireWritable()

        expect(!pending.observe(.init(savingError: true)), "Saving error blocks without validation")
        blocked(pending.writes, "Saving error is read-only")
        expect(pending.observe(normal), "Cleared saving error requires reread")
        let errorTicket = pending.beginValidation()!
        expect(!pending.finishValidation(errorTicket, error: "Unreadable file", state: normal), "Failed reread stays blocked")
        blocked(pending.writes, "Failed reread cannot enable")
        expect(!pending.observe(normal), "Ordinary normal notification cannot erase a failed reread")
        expect(pending.retry(), "Explicit retry starts a new validation generation")
        let retry = pending.beginValidation()!
        expect(!pending.finishValidation(errorTicket, error: nil, state: normal), "Stale result cannot complete newer validation")
        blocked(pending.writes, "Stale result preserves block")
        expect(!pending.finishValidation(retry, error: nil, state: normal), "Current retry succeeds")
        try pending.writes.requireWritable()

        expect(!pending.observe(conflict), "New conflict blocks")
        expect(pending.observe(normal), "Resolution starts checking")
        let stale = pending.beginValidation()!
        expect(!pending.observe(conflict), "Another conflict during reread increments required generation")
        expect(!pending.observe(normal), "New resolution cannot start parallel reread")
        expect(pending.finishValidation(stale, error: nil, state: normal), "Stale-generation reread schedules current generation")
        blocked(pending.writes, "Old generation cannot clear latest conflict")
        let current = pending.beginValidation()!
        expect(current != stale, "Conflict generation changes")
        expect(!pending.finishValidation(current, error: nil, state: disabled), "A completed reread may still await UIKit's normal state")
        blocked(pending.writes, "Current editingDisabled still blocks")
        expect(!pending.observe(normal), "Own disable clears without additional reread")
        try pending.writes.requireWritable()

        let failed = NativeDocumentAdmission()
        failed.beginOpening()
        expect(!failed.opened(success: false, state: .init(closed: true)), "Failed open stays closed")
        blocked(failed.writes, "Failed open never enables")
        expect(!failed.retry(), "Failed UIDocument open requires close/reopen, not backend-only retry")
        expect(!failed.observe(normal), "Late normal cannot turn failed open into success")
        blocked(failed.writes, "Failure survives late normal")

        let replaced = NativeDocumentAdmission()
        replaced.beginOpening()
        expect(replaced.opened(success: true, state: normal), "Replacement can open independently")
        let replacingTicket = replaced.beginValidation()!
        replaced.close()
        expect(!replaced.finishValidation(replacingTicket, error: nil, state: normal), "Close invalidates late validation")
        expect(!replaced.observe(normal), "Late document normal cannot enable closed token")
        blocked(replaced.writes, "Closed backend remains blocked")
        expect(pending.writes.blockedReason == nil, "Closing another token cannot affect current project")
        print("Document admission actual production controller/token assertions passed: \(assertions)")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='arya-document-admission-') as tmp:
    tmp = Path(tmp)
    fixture = tmp / 'controller.swift'
    fixture.write_text(controller + '\n' + swift)
    binary = tmp / 'document-admission-tests'
    subprocess.run(['swiftc', '-j1', '-module-cache-path', str(tmp / 'module-cache'), '-parse-as-library', '-o', str(binary), str(token), str(fixture)], check=True)
    subprocess.run([str(binary)], check=True)
