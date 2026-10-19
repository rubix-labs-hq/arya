#!/usr/bin/env python3
"""Execute actual production Files outcome/picker helpers; backend cases live in ReelKitTests."""
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
view = (root / 'native/App/Shared/NativeEditor/NativePhotosImport.swift').read_text()
backend = (root / 'native/ReelKit/Sources/ReelKit/ReelBackend.swift').read_text()
helper = session.split('// BEGIN FILES IMPORT OUTCOME', 1)[1].split('// END FILES IMPORT OUTCOME', 1)[0]
checks = 0

def check(condition, message):
    global checks
    assert condition, message
    checks += 1

check('NativeMediaPickerOutcome.files(result)' in view, 'Media picker applies quiet cancellation outcome')
check('guard let urls = try NativeMediaPickerOutcome.files(result) else { return }' in view, 'Cancelled/empty picker never imports')
# Since fd4b5de the import sheet reports picker errors in its own Files status (filesNotice)
# instead of session.error; the notice is rendered under "Files import needs attention".
check('} catch { filesNotice = error.localizedDescription }' in view, 'Real picker errors remain visible')
check('if let filesNotice {' in view and 'Text(filesNotice)' in view, 'Picker error notice is rendered in the import sheet')
import_session = session.split('func importFiles(', 1)[1].split('func undo(', 1)[0]
check('guard self.backend === backend else { return }' in import_session, 'Stale import receipt cannot update current project UI')
check('NativeFilesImportOutcome(receipt: result)' in import_session, 'Success count derives from confirmed receipt')
check('self.error = outcome.failureDetails' in import_session, 'Menu and drop imports retain failed filenames and reasons')
check('Text(outcome.failureDetails)' in view, 'Per-file failure details remain visible in the import sheet')
check('self.toast(outcome.summary' in import_session, 'Partial success summary stays visible')
# Since fd4b5de the stage is chosen before probing so generated music reports "identity".
check('stage = generatedMusic ? "identity" : "probe"' in backend and 'failures.append(Self.importFailure(path: f, stage: stage, error: error, copied: copied.contains(f)))' in backend, 'Actual probe errors become receipt failures')
check('failures.append(Self.importFailure(path: url.lastPathComponent, stage: "copy", error: error))' in backend, 'Copy failures preserve other sources')
check('files = files.filter { seen.insert($0).inserted }' in backend, 'Repeated paths count once')
check('if !assets.isEmpty {' in backend.split('public func importMedia', 1)[1].split('public func copyIn', 1)[0], 'Failed-only import does not append an empty edit')
check('if error is CancellationError { throw error }' in backend.split('public func importMedia', 1)[1].split('private func listFiles', 1)[0], 'Cancellation is not converted to successful receipt')
print(f'Native Files import source contracts passed: {checks}', flush=True)
if args.contracts_only:
    raise SystemExit(0)

swift = r'''
import Foundation

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
func rejected(_ value: JSON) {
    do { _ = try NativeFilesImportOutcome(receipt: value); fatalError("Accepted malformed import receipt") }
    catch { assertions += 1 }
}
@main struct OutcomeTests {
    static func main() throws {
        let url = URL(fileURLWithPath: "/disposable/source.mp4")
        expect(try NativeMediaPickerOutcome.files(.success([])) == nil, "Empty selection is quiet")
        expect(try NativeMediaPickerOutcome.files(.success([url])) == [url], "Chosen media forwarded")
        expect(try NativeMediaPickerOutcome.files(.failure(CancellationError())) == nil, "Task-style dismissal is quiet")
        expect(try NativeMediaPickerOutcome.files(.failure(NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))) == nil, "Cocoa dismissal is quiet")
        let access = NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoPermissionError)
        do { _ = try NativeMediaPickerOutcome.files(.failure(access)); fatalError("Access error hidden") }
        catch { expect((error as NSError).code == NSFileReadNoPermissionError, "Real provider/access failure survives") }
        do { _ = try NativeMediaPickerOutcome.files(.failure(NSError(domain: "Provider", code: NSUserCancelledError))); fatalError("Unrelated-domain error hidden") }
        catch { expect((error as NSError).domain == "Provider", "Cancellation checks domain") }
        let full = try NativeFilesImportOutcome(receipt: .object([("assets", .object([("a.png", .object([])), ("b.mov", .object([]))]))]))
        expect(full.imported == 2 && full.issues.isEmpty, "Legacy assets-only receipt stays compatible")
        expect(full.summary == "Imported 2 files.", "Full success uses confirmed count")
        let failures = JSON.array([.object([("path", "media/broken.mp4"), ("name", "broken.mp4"), ("stage", "probe"), ("error", "Cannot decode this source")]), .object([("path", "missing.png"), ("stage", "copy"), ("error", "Access denied")])])
        let partial = try NativeFilesImportOutcome(receipt: .object([("assets", .object([("good.mp4", .object([]))])), ("failures", failures)]))
        expect(partial.imported == 1 && partial.issues.count == 2, "Successful asset is retained alongside failures")
        expect(partial.summary == "Imported 1 file; 2 files failed.", "Partial summary states both outcomes")
        expect(partial.failureDetails.contains("broken.mp4: Could not recognize media. Cannot decode this source"), "Named probe failure shown")
        expect(partial.failureDetails.contains("missing.png: Could not copy. Access denied"), "Missing name falls back to source filename")
        expect(partial.failureDetails.contains("select only those items to retry"), "Retry does not ask user to repeat successful import")
        let none = try NativeFilesImportOutcome(receipt: .object([("assets", .object([])), ("failures", failures)]))
        expect(none.summary == "No media was imported; 2 files failed.", "Zero assets does not claim import success")
        rejected(.object([("error", "Unavailable")]))
        rejected(.object([("assets", .array([]))]))
        rejected(.object([("assets", .object([("bad", "not metadata")]))]))
        rejected(.object([("assets", .object([])), ("failures", "invalid")]))
        rejected(.object([("assets", .object([])), ("failures", .array([.object([("path", "x")])]))]))
        print("Native Files import actual production outcome/picker assertions passed: \(assertions)")
    }
}
'''
# expect accepts nonthrowing autoclosure; evaluate throwing picker outcomes first.
for label, call in [
    ('empty', 'NativeMediaPickerOutcome.files(.success([]))'),
    ('chosen', 'NativeMediaPickerOutcome.files(.success([url]))'),
    ('cancelled', 'NativeMediaPickerOutcome.files(.failure(CancellationError()))'),
    ('dismissed', 'NativeMediaPickerOutcome.files(.failure(NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)))')]:
    swift = swift.replace('expect(try ' + call, 'let ' + label + ' = try ' + call + '\n        expect(' + label)
with tempfile.TemporaryDirectory(prefix='reel-files-import-') as temp:
    temp = Path(temp)
    source = temp / 'Outcome.swift'
    source.write_text(helper + swift)
    executable = temp / 'outcome-tests'
    subprocess.run(['xcrun', 'swiftc', '-j1', '-parse-as-library', '-module-cache-path', str(temp / 'module-cache'), str(root / 'native/ReelKit/Sources/ReelKit/JSON.swift'), str(source), '-o', str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
