#!/usr/bin/env python3
"""Extract real form submission and header policy; source checks do not require Swift/UI."""
import argparse
import re
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--base-root', type=Path)
parser.add_argument('--contracts-only', action='store_true')
args = parser.parse_args()
view_path = Path('native/App/Shared/EditorView.swift')
editor_path = Path('native/App/Shared/NativeEditor/NativeEditorView.swift')
view = (args.source_root / view_path).read_text()
editor = (args.source_root / editor_path).read_text()

def method(source, signature):
    start = source.index(signature)
    opening = source.index('{', start)
    depth, pos = 1, opening + 1
    while depth:
        if source[pos] == '{': depth += 1
        elif source[pos] == '}': depth -= 1
        pos += 1
    return source[start:pos]

checks = 0

def check(value, message):
    global checks
    assert value, message
    checks += 1

sheet = view.split('struct NativeNewProjectSheet: View {', 1)[1]
submission = sheet.split('// BEGIN NEW PROJECT SUBMISSION', 1)[1].split('// END NEW PROJECT SUBMISSION', 1)[0]
presentation_lines = [line.strip() for line in sheet.split('var body: some View', 1)[0].splitlines() if line.strip().startswith(('var isPresented:', 'var onDismiss:'))]
assert len(presentation_lines) == 2, 'New Project sheet presentation hooks'
policy = method(editor, 'static func stackedHeader(')
header = method(editor, 'private func header(')
inline = re.search(r'if ([^\n]+) \{\n\s+workflowPages.frame', header).group(1)
separate = re.search(r'if ([^\n]+) \{\n\s+workflowPages.padding', header).group(1)
check('.submitLabel(.go)' in sheet and '.onSubmit { submit() }' in sheet, 'Name Return uses the real submission action')
check('Button(action: submit)' in sheet and '.keyboardShortcut(.defaultAction)' in sheet, 'Default Create uses the same guarded action')
check('.disabled(!canSubmit)' in sheet, 'Create enabled state uses the guard tested below')
check('.keyboardShortcut(.cancelAction)' in sheet and 'Button("Cancel", role: .cancel) { dismissPresentation() }' in sheet, 'Escape keeps normal cancellation')
check('.interactiveDismissDisabled(creating)' in sheet and '.disabled(creating)' in sheet, 'Pending work cannot be dismissed or resubmitted')
check('.focused($nameFocused)' in sheet and '.onAppear { nameFocused = true }' in sheet, 'Name has initial input focus')
check('.accessibilityFocused($errorFocused)' in sheet and '@AccessibilityFocusState' in sheet, 'Recovery text is an accessibility focus target')
check('.scrollDismissesKeyboard(.interactively)' in sheet and '.safeAreaInset(edge: .bottom)' in sheet, 'Form remains scrollable with independent create action')
for identifier in ['newProject.name', 'newProject.frameSize', 'newProject.frameRate', 'newProject.create', 'newProject.cancel', 'newProject.error']:
    check(f'"{identifier}"' in sheet, f'Stable control identifier: {identifier}')
check('NativeWorkspaceLayout.stackedHeader(width: width, compact: compact, accessibilityText: dynamicTypeSize.isAccessibilitySize)' in editor, 'Actual header consumes the tested fit policy')
check('minWidth: compact ? 80 : 180' in editor, 'Compact title does not demand the desktop minimum')
check(inline == '!compact && !stacked', 'Inline workflow is excluded from compact dock layouts')
check(separate == '!compact && (stacked || narrow)', 'Noncompact narrow accessibility retains workflow actions')
workspace = method(editor, 'private func workspaceMenu(')
for action, key in [('New project', 'n'), ('Open project folder', 'o'), ('Import media', 'i')]:
    check(f'Button("{action}"' in workspace and f'.keyboardShortcut("{key}", modifiers: [.command])' in workspace, f'Discoverable project command: {action}')
check('editor.composition' in editor and 'editor.workspaceMenu' in editor, 'Accessible editor entry controls')
if args.base_root:
    base_view = (args.base_root / view_path).read_text()
    base_editor = (args.base_root / editor_path).read_text()
    check(base_view.split('#if os(iOS)\n/// New is', 1)[0] == view.split('#if os(iOS)\n/// New is', 1)[0], 'Welcome and platform webview remain unchanged')
    for signature in ['private func desktopPanes(', 'private func compactLandscape(', 'private var inspectorSize:', 'private func panelFrame<', 'private func select(', 'private func setLayout(', 'static func desktop(', 'static func compact(', 'static func timelineRange(']:
        check(method(base_editor, signature) == method(editor, signature), f'Workspace lifecycle unchanged: {signature}')
    check('.sheet(item: mediaImportBinding())' in editor and '.sheet(item: mediaImportBinding(panel: panel))' in editor, 'Editor and active compact panel each own their captured chooser presenter')
    check('request.panelID != next?.rawValue' in editor, 'Dismissing or switching the presenting panel clears its import request')
print(f'Mobile keyboard source contracts passed: {checks}', flush=True)
if args.contracts_only:
    raise SystemExit(0)

swift = r'''import Foundation
struct FixtureFailure: LocalizedError { var errorDescription: String? { "fixture creation failure" } }
@MainActor final class Session {
    var sessionID = UUID().uuidString
    var requests: [(String, Int, Int, Double)] = []
    var waiting: CheckedContinuation<Void, Error>?
    func createNewProject(name: String, width: Int, height: Int, fps: Double) async throws {
        requests.append((name, width, height, fps))
        try await withCheckedThrowingContinuation { waiting = $0 }
    }
    func complete(_ result: Result<Void, Error>) { let current = waiting; waiting = nil; current?.resume(with: result) }
}
@MainActor final class FormFixture {
    let session = Session()
    var name = "Arya keyboard"
    var format = Format.landscape
    var fps = 30.0
    var creating = false
    var failure: String?
    var nameFocused = true
    var errorFocused = false
    var dismissed = 0
    func dismiss() { dismissed += 1 }
    func invoke() { submit() }
''' + '\n'.join('    ' + line for line in presentation_lines) + '\n' + method(sheet, 'enum Format:') + submission + r'''
}
enum HeaderFixture {
''' + policy + '\n    static func inline(compact: Bool, stacked: Bool, narrow: Bool) -> Bool { !narrow && (' + inline + ') }\n    static func separate(compact: Bool, stacked: Bool, narrow: Bool) -> Bool { ' + separate + ' }\n' + r'''
}
@main struct Tests {
    @MainActor static func main() async {
        var assertions = 0
        func expect(_ value: Bool, _ label: String) { assertions += 1; if !value { fatalError(label) } }
        func spin(_ condition: () -> Bool) async {
            for _ in 0..<10000 { if condition() { return }; await Task.yield() }
            fatalError("fixture task did not reach expected state")
        }
        let form = FormFixture()
        form.name = " \n\t "
        form.invoke(); await Task.yield()
        expect(!form.creating && form.session.requests.isEmpty && form.dismissed == 0, "blank Return cannot create")
        form.name = "Arya keyboard"; form.format = .portrait; form.fps = 24
        form.failure = "previous failure"; form.errorFocused = true
        form.invoke(); form.invoke()
        expect(form.creating && !form.nameFocused && !form.errorFocused && form.failure == nil, "synchronous reservation and focus reset")
        form.name = "changed while pending"; form.format = .square; form.fps = 60
        await spin { form.session.waiting != nil }
        expect(form.session.requests.count == 1, "Return plus default action creates once")
        let request = form.session.requests[0]
        expect(request.0 == "Arya keyboard" && request.1 == 1080 && request.2 == 1920 && request.3 == 24, "pending request uses immutable chosen metadata")
        expect(form.dismissed == 0, "pending startup never dismisses")
        form.session.complete(.failure(FixtureFailure()))
        await spin { !form.creating }
        expect(form.dismissed == 0 && form.failure == "fixture creation failure" && form.errorFocused, "failure retains retry and exposes accessibility error")
        form.invoke(); await spin { form.session.waiting != nil }
        expect(form.session.requests.count == 2 && form.failure == nil, "retry starts a new request")
        form.session.complete(.failure(CancellationError()))
        await spin { !form.creating }
        expect(form.dismissed == 0 && form.failure == "Project creation was cancelled." && form.errorFocused, "cancelled startup clears busy and keeps recovery")
        form.invoke(); await spin { form.session.waiting != nil }
        form.session.complete(.success(()))
        await spin { !form.creating }
        expect(form.dismissed == 1 && form.failure == nil, "success dismisses exactly after startup")
        for width in [-1.0, 0, 320, 359, 359.999] {
            expect(HeaderFixture.stackedHeader(width: width, compact: true, accessibilityText: false), "sub-360 compact windows retain stacked recovery")
        }
        for width in [360.0, 375, 390, 600, 759, 760, 834, 960, 1032, 1199, 1600] {
            expect(!HeaderFixture.stackedHeader(width: width, compact: true, accessibilityText: false), "compact phone and iPad widths >=360 use one row")
        }
        for width in [320.0, 359, 360, 375, 390, 600, 759, 834, 1600] {
            expect(HeaderFixture.stackedHeader(width: width, compact: true, accessibilityText: true), "every accessibility width retains stacked recovery")
            expect(HeaderFixture.stackedHeader(width: width, compact: false, accessibilityText: true), "noncompact accessibility widths also stack")
        }
        for width in [Double.nan, .infinity, -.infinity] {
            for compact in [false, true] {
                expect(HeaderFixture.stackedHeader(width: width, compact: compact, accessibilityText: false), "invalid width is conservative on every layout")
            }
        }
        expect(HeaderFixture.stackedHeader(width: 679, compact: false, accessibilityText: false), "desktop narrow boundary retained")
        expect(!HeaderFixture.stackedHeader(width: 680, compact: false, accessibilityText: false), "desktop existing wide boundary retained")
        for compact in [false, true] {
            for accessibility in [false, true] {
                for width in [320.0, 359, 360, 375, 390, 600, 679, 680, 759, 760, 1032, 1499, 1500, 1600] {
                    let narrow = HeaderFixture.stackedHeader(width: width, compact: compact, accessibilityText: accessibility)
                    let stacked = width < 1500
                    let inline = HeaderFixture.inline(compact: compact, stacked: stacked, narrow: narrow)
                    let separate = HeaderFixture.separate(compact: compact, stacked: stacked, narrow: narrow)
                    expect(!(inline && separate), "workflow header never duplicates itself")
                    expect((inline || separate) == !compact, "compact uses dock; every noncompact route retains workflow")
                    if !compact && accessibility { expect(separate, "wide noncompact accessibility keeps separate workflow") }
                    if compact && width >= 1500 { expect(!inline && !separate, "short-height wide compact does not duplicate dock") }
                }
            }
        }
        print("Actual mobile keyboard/form/header assertions passed: \(assertions)")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='arya-keyboard-tests-') as directory:
    path = Path(directory)
    source = path / 'KeyboardTests.swift'
    binary = path / 'KeyboardTests'
    source.write_text(swift)
    subprocess.run(['swiftc', '-j', '1', '-module-cache-path', str(path / 'module-cache'), '-parse-as-library', str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
