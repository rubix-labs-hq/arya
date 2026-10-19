#!/usr/bin/env python3
"""Compile and exercise the app's assistant navigation and keyboard handlers."""
import argparse
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--case', choices=['navigation', 'keyboard', 'all'], default='all')
args = parser.parse_args()
root = args.source_root
editor = root / 'native/App/Shared/NativeEditor'


def block(source, marker):
    start = source.index(marker)
    end = source.index('{', start) + 1
    depth = 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


def run(source, name):
    with tempfile.TemporaryDirectory(prefix='arya-assistant-controls-') as directory:
        scratch = Path(directory)
        swift = scratch / 'main.swift'
        swift.write_text(source)
        binary = scratch / name
        subprocess.run(['swiftc', '-module-cache-path', str(scratch / 'cache'),
                        str(root / 'native/ReelKit/Sources/ReelKit/JSON.swift'),
                        str(swift), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


checks = '''
var checks = 0
func check(_ value: @autoclosure () -> Bool, _ message: String) {
    checks += 1
    if !value() { print("FAIL: " + message); exit(1) }
}
'''


def navigation():
    source = (root / 'native/App/Shared/NativeAssistant.swift').read_text()
    model = (editor / 'NativeEditorModel.swift').read_text()
    view = (editor / 'NativeEditorView.swift').read_text()
    show = block(source, '    private func showInEditor(').replace('private func', 'func', 1)
    route = block(view, '    private func select(_ panel:').replace('private func', 'func', 1)
    # Before the fix there is no request consumer. Leave the fixture empty so the real
    # route fails first on the page-only request, rather than failing source extraction.
    consume = block(view, '    private func showRequestedWorkspace(').replace('private func', 'func', 1) if '    private func showRequestedWorkspace(' in view else 'func showRequestedWorkspace(compact: Bool) {}'
    source = '''import Foundation
enum ReelBackend { struct APIError: Error { let message: String; init(_ message: String) { self.message = message } } }
extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) -> String { self[key] as? String ?? "" }
}
struct Project { var fields: [String: Any] }
final class Model {
    var project: Project? = Project(fields: ["tracks": [["clips": [["id": "c1"]]]], "comps": ["k1": ["tracks": [["clips": [["id": "nested"]]]]]]])
    var composition: String?, requestedWorkspace: NativePanel?, mobilePanel: NativePanel? = .assistant
    var panel: NativePanel = .edit, showingSource = true
    var time: Double = 0, selected: Set<String> = [], primary: String?
    func select(ids: Set<String>, primary: String?, feedback: Bool) { selected = ids; self.primary = primary }
    func seek(_ at: Double) { time = at }
}
final class Session { var nativeEditor: Model? = Model() }
final class Controller {
    var session: Session? = Session()
''' + show + '\n}\n' + block(model, 'enum NativePanel:') + '\n' + block(view, 'enum NativeCompactWorkspaceRouting {') + '''
final class ViewController {
    let model: Model
    var assistantVisible = false, mediaVisible = false, inspectorVisible = false, expanded = false
    var lastEditingPanel: NativePanel = .edit
    init(_ model: Model) { self.model = model }
    func dismissCompactKeyboard() {}
    func setCompactToolsExpanded(_ value: Bool) { expanded = value }
''' + route + '\n' + consume + '\n}\n' + checks + '''
for compact in [false, true] {
    for page in NativePanel.workflow {
      for retainedSheet: NativePanel in [.assistant, .media, .deliver] {
        let controller = Controller(), model = controller.session!.nativeEditor!
        model.mobilePanel = retainedSheet
        let view = ViewController(model), before = JSON(any: model.project!.fields).text
        do {
            let reply = try controller.showInEditor(body: JSON(any: ["page": page.rawValue]).text)
            let fields = try JSON.parse(reply.text) as! [String: Any]
            check(fields["page"] as? String == page.rawValue, "Reply must acknowledge the requested page")
        } catch { print("FAIL: page-only request for \\(page.rawValue): \\(error)"); exit(1) }
        check(model.requestedWorkspace == page, "The assistant must request the actual native workspace")
        view.showRequestedWorkspace(compact: compact)
        check(model.requestedWorkspace == nil, "Consume the request once")
        if !compact { check(model.mobilePanel == nil, "A widened iPad must dismiss a retained task sheet before showing the workspace") }
        if compact && !NativeCompactWorkspaceRouting.inlineWorkspaces.contains(page) {
            check(model.mobilePanel == page, "Media and Deliver use their existing compact sheets")
            check(model.panel == .edit, "A compact task preserves the editing workspace")
        } else {
            check(model.panel == page, "The visible editor must use the requested workspace")
            check(compact ? view.expanded : (page == .media ? view.mediaVisible : view.inspectorVisible), "Restore hidden controls")
            if compact { check(model.mobilePanel == nil, "Dismiss the assistant sheet before showing inline controls") }
        }
        check(JSON(any: model.project!.fields).text == before, "Navigation must not change the project")
        // Asking for the same page again must restore controls that the user hid.
        view.expanded = false; view.inspectorVisible = false; view.mediaVisible = false
        _ = try controller.showInEditor(body: JSON(any: ["page": page.rawValue]).text)
        view.showRequestedWorkspace(compact: compact)
        check(compact ? (NativeCompactWorkspaceRouting.inlineWorkspaces.contains(page) ? view.expanded : model.mobilePanel == page) : (page == .media ? view.mediaVisible : view.inspectorVisible), "Repeated page requests restore controls")
      }
    }
}
let controller = Controller(), model = controller.session!.nativeEditor!
_ = try controller.showInEditor(body: #"{"page":"motion","comp":"k1","ids":["nested"],"at":2.5}"#)
check(model.composition == "k1" && model.selected == ["nested"] && model.primary == "nested" && model.time == 2.5 && !model.showingSource, "Combined requests show the requested timeline and layers")
model.requestedWorkspace = nil
for invalid: Any in ["unknown", "assistant", 42, NSNull()] {
    do {
        _ = try controller.showInEditor(body: JSON(any: ["page": invalid, "comp": NSNull(), "ids": ["c1"], "at": 8]).text)
        check(false, "Reject invalid pages")
    } catch {}
    check(model.composition == "k1" && model.selected == ["nested"] && model.time == 2.5 && model.requestedWorkspace == nil, "An invalid page must not partially change the view")
}
_ = try controller.showInEditor(body: #"{"comp":"k1"}"#)
_ = try controller.showInEditor(body: #"{"comp":null,"ids":[],"at":0}"#)
check(model.composition == nil && model.selected.isEmpty && model.time == 0, "Existing selection, composition and playhead controls still work")
do { _ = try controller.showInEditor(body: "{}"); check(false, "An empty request needs a useful error") } catch {}
print("Passed \\(checks) assistant navigation checks.")
'''
    run(source, 'navigation')
    assert '@Published var requestedWorkspace: NativePanel?' in model
    assert 'requestedWorkspace = nil' in block(model, '    func reset() {')
    assert '.onChange(of: model.requestedWorkspace)' in view and 'showRequestedWorkspace(compact: compact)' in view


def keyboard():
    panel = (editor / 'NativeAssistantPanel.swift').read_text()
    draft = block(panel, '    private func draftEditor(')
    assert '#if os(macOS)' not in draft, 'The hardware Return handler must also be compiled on iOS'
    handler = block(draft, '.onKeyPress(.return, phases: .down)')
    body = handler.split('{ press in', 1)[1].rsplit('}', 1)[0]
    source = '''import Foundation
import SwiftUI
struct Proposal { var finished: Bool }
final class Assistant { var configured = true, isWorking = false; var applyingProposal: Proposal?; var inputCharacterLimit = 20 }
final class Model { var assistantDraft = "Make a title" }
struct Press { var modifiers: EventModifiers }
final class Composer {
    let assistant = Assistant(), model = Model()
    var sent = 0
    func sendDraft() { sent += 1 }
''' + block(panel, '    private var canSendDraft: Bool') + '\nfunc press(_ press: Press) -> KeyPress.Result {\n' + body + '\n}\n}\n' + checks + '''
let composer = Composer()
check(composer.press(Press(modifiers: [])) == .handled && composer.sent == 1, "Unmodified hardware Return sends once")
for modifier: EventModifiers in [.shift, .command, .option, .control, [.shift, .command]] {
    check(composer.press(Press(modifiers: modifier)) == .ignored && composer.sent == 1, "Modified Return keeps normal text editing")
}
for blocked in 0..<6 {
    let composer = Composer()
    switch blocked {
    case 0: composer.assistant.configured = false
    case 1: composer.assistant.isWorking = true
    case 2: composer.assistant.applyingProposal = Proposal(finished: false)
    case 3: composer.model.assistantDraft = "  \\n"
    case 4: composer.model.assistantDraft = String(repeating: "a", count: 21)
    default: composer.model.assistantDraft = ""
    }
    check(composer.press(Press(modifiers: [])) == .ignored && composer.sent == 0, "Unavailable, busy, blank and oversized drafts must not send")
}
composer.assistant.applyingProposal = Proposal(finished: true)
check(composer.press(Press(modifiers: [])) == .handled && composer.sent == 2, "A finished preview permits another request")
print("Passed \\(checks) assistant keyboard checks.")
'''
    run(source, 'keyboard')


if args.case in ['navigation', 'all']:
    navigation()
if args.case in ['keyboard', 'all']:
    keyboard()
