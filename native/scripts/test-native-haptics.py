#!/usr/bin/env python3
"""Run the actual native haptic event policy; physical feel still requires supported iPhone QA."""
import argparse
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--contracts-only', action='store_true')
args = parser.parse_args()
root = args.source_root.resolve()
model = (root / 'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()
timeline = (root / 'native/App/Shared/NativeEditor/NativeTimeline.swift').read_text()
view = (root / 'native/App/Shared/NativeEditor/NativeEditorView.swift').read_text()
deliver = (root / 'native/App/Shared/NativeEditor/NativeDeliverPanel.swift').read_text()
mobile = (root / 'native/App/Shared/NativeEditor/NativeMobileExport.swift').read_text()
session = (root / 'native/App/Shared/EditorSession.swift').read_text()
photos = (root / 'native/App/Shared/NativeEditor/NativePhotosImport.swift').read_text()
helper = model.split('// BEGIN HAPTIC POLICY\n', 1)[1].split('// END HAPTIC POLICY', 1)[0]
checks = 0
def check(condition, reason):
    global checks
    assert condition, reason
    checks += 1

check('primary: selectedID, feedback: false' in model, 'Project reconciliation never vibrates')
check('feedback: Bool = false' in model, 'Generic inspector edits do not opt into haptics')
check('if feedback, self.generation == context, self.composition == sourceComposition' in model, 'Edit confirmation rejects stale project/scope')
check('let reply = try await self.call("/api/ops", request)' in model, 'Request completes before confirmed edit feedback')
emit = model.split('private func emitHaptic(', 1)[1].split('func updateSnapFeedback', 1)[0]
check('UIApplication.shared.applicationState == .active' in emit, 'Inactive app discards feedback instead of queuing it')
check('NativeHapticAvailability.supported' in emit, 'Unsupported hardware never receives a trigger')
check('NativeHapticPolicy.enabled()' in emit, 'Persisted opt-out is respected on each event')
check('.sensoryFeedback(trigger: model.hapticSignal)' in view, 'Root UI consumes the typed event signal')
check('CHHapticEngine.capabilitiesForHardware().supportsHaptics' in view, 'Runtime hardware is checked')
check('@AppStorage(NativeHapticPolicy.preferenceKey)' in view, 'Preference is persisted')
check('model.updateSnapFeedback(target: preview?.snapLine, fps: source.capture.fps)' in timeline, 'Snap uses actual planned guide')
check('model.endSnapFeedback()' in timeline, 'Gesture exit releases the snap latch')
scrub = model.split('func scrub(', 1)[1].split('func step(', 1)[0]
check('Haptic' not in scrub and 'haptic' not in scrub, 'No per-frame scrub feedback')
check('model.registerExportFeedback(job)' in deliver, 'User-started desktop job is owned')
check('session.nativeEditor.registerExportFeedback(fields)' in mobile, 'User-started foreground mobile job is owned')
check('if session?.backend === backend { session?.nativeEditor.registerExportFeedback(started) }' in mobile, 'Continued export must still belong to the current project')
check('session?.nativeEditor.confirmExportFeedback(fields)' in mobile, 'Continued export observes a terminal receipt')
check('session?.nativeEditor.confirmExportFeedback(job)' in mobile, 'Foreground export observes a terminal receipt')
files_import = session.split('func importFiles(', 1)[1].split('func undo(', 1)[0]
check('self.nativeEditor.confirmImportFeedback(imported: outcome.imported, failed: outcome.issues.count)' in files_import, 'Files/folder import uses confirmed receipt counts')
check(files_import.index('guard self.backend === backend') < files_import.index('self.nativeEditor.confirmImportFeedback'), 'Files/folder feedback follows stale-project guard')
check('model.confirmImportFeedback(imported: outcome.confirmed, failed: outcome.unavailable + outcome.unconfirmed)' in photos, 'Photos batch uses confirmed receipt counts')
photo_complete = photos.split('await model.refresh()', 1)[1]
check(photo_complete.index('try Task.checkCancellation()') < photo_complete.index('model.confirmImportFeedback'), 'Photos feedback follows final cancellation guard')
check(photo_complete.index('guard isCurrent()') < photo_complete.index('model.confirmImportFeedback'), 'Photos feedback follows final current-project guard')
import_feedback = model.split('func confirmImportFeedback(', 1)[1].split('func registerExportFeedback', 1)[0]
check('guard !Task.isCancelled else { return }' in import_feedback, 'Cancelled import cannot produce a success cue')
print(f'Native haptic wiring source contracts passed: {checks}', flush=True)
if args.contracts_only:
    raise SystemExit(0)

fixture = r'''
import Foundation
import CoreFoundation
var checks = 0
func expect(_ condition: @autoclosure () -> Bool, _ reason: String) {
    checks += 1; if !condition() { fatalError(reason) }
}
@main struct HapticPolicyTests {
    static func main() throws {
        expect(NativeHapticPolicy.selection(before: ["c1"], primary: "c1", after: ["c1"], nextPrimary: "c1") == nil, "Same clip stays quiet")
        expect(NativeHapticPolicy.selection(before: ["c1"], primary: "c1", after: ["c2"], nextPrimary: "c2") == .selection, "New selection has one cue")
        expect(NativeHapticPolicy.selection(before: ["c1", "c2"], primary: "c1", after: ["c1", "c2"], nextPrimary: "c2") == .selection, "New primary has one cue")
        expect(NativeHapticPolicy.selection(before: ["c1"], primary: "c1", after: [], nextPrimary: nil) == .selection, "Deselect is a visible selection change")
        var policy = NativeHapticPolicy()
        expect(policy.snap(target: 2, fps: 30) == .snap, "Enter guide")
        for _ in 0..<120 { expect(policy.snap(target: 2, fps: 30) == nil, "Remaining at guide must not vibrate each frame") }
        expect(policy.snap(target: 2.001, fps: 30) == nil, "Frame-equivalent guide stays quiet")
        expect(policy.snap(target: 3, fps: 30) == .snap, "A different guide has a new cue")
        expect(policy.snap(target: nil, fps: 30) == nil, "Leaving guide stays quiet")
        expect(policy.snap(target: 3, fps: 30) == .snap, "Leaving rearms guide")
        policy.endSnap()
        expect(policy.snap(target: 3, fps: 30) == .snap, "A new gesture rearms guide")
        for invalid in [Double.nan, .infinity, 1e308] {
            expect(policy.snap(target: invalid, fps: 30) == nil, "Invalid target stays quiet")
        }
        expect(policy.snap(target: 3, fps: 0) == nil, "Invalid fps stays quiet")
        let before: [String: Any] = ["tracks": [["id": "V1", "clips": [["id": "c1", "start": 0]]]]]
        let after: [String: Any] = ["tracks": [["id": "V1", "clips": [["id": "c1", "start": 1]]]]]
        func edit(_ reply: [String: Any]) -> NativeHapticKind? { NativeHapticPolicy.committedEdit(before: before, previousVersion: 7, reply: reply) }
        expect(edit(["version": 8, "project": after]) == .commit, "Changed atomic response confirms edit")
        expect(edit(["version": 8, "project": before]) == nil, "No-op operation is quiet even when version advances")
        expect(edit(["version": 7, "project": after]) == nil, "Uncommitted version is quiet")
        expect(edit(["version": 6, "project": after]) == nil, "Stale reply is quiet")
        expect(edit(["version": 8, "error": "Conflict"]) == nil, "Failure without project is quiet")
        expect(edit(["version": 8.5, "project": after]) == nil, "Malformed fractional version is quiet")
        expect(edit(["version": "8", "project": after]) == nil, "Malformed string version is quiet")
        expect(NativeHapticPolicy.committedEdit(before: before, previousVersion: 0, reply: ["version": true, "project": after]) == nil, "Bool is not a committed version")
        expect(NativeHapticPolicy.committedEdit(before: nil, previousVersion: 7, reply: ["version": 8, "project": after]) == nil, "First loaded project is quiet")
        expect(NativeHapticPolicy.imported(count: 2, failures: 0) == .success, "Confirmed full batch succeeds")
        expect(NativeHapticPolicy.imported(count: 0, failures: 0) == nil, "Empty/cancelled import stays quiet")
        expect(NativeHapticPolicy.imported(count: 1, failures: 1) == nil, "Partial import does not claim complete success")
        expect(NativeHapticPolicy.imported(count: 0, failures: 2) == nil, "Failed batch stays quiet")
        expect(NativeHapticPolicy.imported(count: -1, failures: 0) == nil, "Malformed import count stays quiet")
        func job(_ id: String, _ state: String, _ output: String? = nil, _ error: String? = nil) -> [String: Any] {
            var fields: [String: Any] = ["id": id, "kind": "export", "state": state]
            if let output { fields["output"] = output }; if let error { fields["error"] = error }
            return fields
        }
        expect(policy.exportUpdate(job("historical", "done", "renders/old.mp4")) == nil, "Cold/history receipt never vibrates")
        policy.registerExport(job("j1", "running"))
        expect(policy.exportUpdate(job("j1", "running")) == nil, "Rendering progress stays quiet")
        expect(policy.exportUpdate(job("j1", "done", "renders/new.mp4")) == .success, "Published output confirms completion")
        expect(policy.exportUpdate(job("j1", "done", "renders/new.mp4")) == nil, "Repeated broadcast is quiet")
        policy.registerExport(job("j1", "running"))
        expect(policy.exportUpdate(job("j1", "done", "renders/new.mp4")) == nil, "Repeated registration cannot rearm completed job")
        policy.registerExport(job("j2", "running"))
        expect(policy.exportUpdate(job("j2", "failed", nil, "Cancelled")) == nil, "Failed/cancelled export stays quiet")
        expect(policy.exportUpdate(job("j2", "done", "renders/late.mp4")) == nil, "Cancelled job cannot later vibrate")
        policy.registerExport(job("j3", "running"))
        expect(policy.exportUpdate(job("j3", "done")) == nil, "No published output stays quiet")
        policy.registerExport(["scheduled": true])
        expect(policy.exportUpdate(job("unknown", "done", "renders/x.mp4")) == nil, "Scheduling alone does not own a job ID")
        policy.registerExport(job("j4", "running")); policy.reset()
        expect(policy.exportUpdate(job("j4", "done", "renders/x.mp4")) == nil, "Project reset drops old completions")
        let suite = "AryaHapticPolicyTests." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        expect(NativeHapticPolicy.enabled(in: defaults), "First use defaults on")
        defaults.set(false, forKey: NativeHapticPolicy.preferenceKey)
        expect(!NativeHapticPolicy.enabled(in: defaults), "Opt-out survives persistence")
        defaults.set(true, forKey: NativeHapticPolicy.preferenceKey)
        expect(NativeHapticPolicy.enabled(in: defaults), "Re-enable survives persistence")
        print("Actual native haptic policy assertions passed: \(checks)")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='arya-native-haptics-') as directory:
    temp = Path(directory)
    source = temp / 'HapticTests.swift'
    source.write_text('import Foundation\nimport CoreFoundation\n' + helper + '\n' + fixture)
    executable = temp / 'haptic-tests'
    subprocess.run(['xcrun', 'swiftc', '-j1', '-parse-as-library', '-module-cache-path', str(temp / 'module-cache'), str(source), '-o', str(executable)], check=True, timeout=120)
    subprocess.run([str(executable)], check=True, timeout=30)
