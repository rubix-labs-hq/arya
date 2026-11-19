#!/usr/bin/env python3
"""Run actual extracted layout policies and preserve existing geometry/project-action contracts."""
from pathlib import Path
import argparse
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--repo-root', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--source-root', type=Path)
parser.add_argument('--contracts-only', action='store_true', help='Only static source contracts; does not compile or run layout helpers')
args = parser.parse_args(); repo = args.repo_root; source = args.source_root or repo
editor = source / 'native/App/Shared/NativeEditor'
view = (editor / 'NativeEditorView.swift').read_text()
assistant = (editor / 'NativeAssistantPanel.swift').read_text()
viewer = (editor / 'NativeViewer.swift').read_text()
media = (editor / 'NativeMediaPanel.swift').read_text()

def block(text, marker):
    start = text.index(marker); opening = text.index('{', start); depth = 1; end = opening + 1
    while depth:
        depth += (text[end] == '{') - (text[end] == '}'); end += 1
    return text[start:end]

def normalized(text): return '\n'.join(line.strip() for line in text.splitlines())

contracts = 0
def check(ok, label):
    global contracts
    assert ok, label
    contracts += 1

check('desktopPanes(size: workspace.size)' in view, 'Desktop sizing must use the inner workspace GeometryReader')
check('desktopWorkspace(size: geometry.size)' not in view, 'Full window height must not size the workspace')
panes = block(view, 'private func desktopPanes(size: CGSize)')
check('ScrollView' not in panes, 'Desktop editing shell must not scroll as a workaround')
for field in ['viewerWidth', 'mediaWidth', 'inspectorWidth', 'assistantWidth', 'viewerHeight', 'timelineHeight']:
    check('layout.' + field in panes, 'Actual pane layout must consume the tested ' + field + ' budget')
check('NativeSegmentedControl(label: "Viewer", selection: $model.showingSource' in viewer and '.frame(width: 168)' in viewer, 'Viewer control must show Timeline and Source whole, with its name only as the accessibility label')
check('ViewThatFits(in: .horizontal)' in media and '.fixedSize(horizontal: true, vertical: false)' in media, 'Media must choose a menu when the complete noncompressing tab strip cannot fit')
check('ForEach(sections, id: \\.self) { Text($0).tag($0) }' in media, 'Compact media picker must expose every section')
check('NativeEditorStyle.minimumControlHeight + 4' in media, 'Media strip must fit native button height with spare vertical space')
check('Bring your footage into Reel' not in media and 'Bring your footage into Arya' in media, 'Empty-state brand must be Arya')
check('TextEditor(text: $model.assistantDraft)' in assistant and 'Picker("Input", selection: $model.assistantInputKind)' in assistant, 'Resize adaptation must retain the model-owned draft and input type')
input_menu = block(assistant, 'private var inputMenu: some View')
check('inputPicker.pickerStyle(.inline)' in input_menu and 'editor.assistant.inputAttachments' in input_menu and 'requestScriptImport()' in input_menu, 'Every input kind and script import must stay reachable from the composer menu at every width and text size')
cancel = block(assistant, 'private var cancelButton:')
check(assistant.count('{ assistant.cancel() }') == 1 and '{ assistant.cancel() }' in cancel, 'Working Stop must remain exactly once and use the original callback')
check('Label(assistant.state == "cancelling" ? "Stopping…" : "Stop", systemImage: "stop.fill")' in cancel and '.accessibilityLabel(assistant.state == "cancelling" ? "Stopping request" : "Stop request")' in cancel, 'Stop must keep its visible label, its stopping label and its VoiceOver name')
send = block(assistant, 'private var sendButton:')
check('sendDraft()' in send and 'Label("Send", systemImage: "arrow.up")' in send and '.frame(minHeight: actionHeight)' in send and '.frame(minHeight: actionHeight)' in cancel, 'Send and Stop must retain complete intrinsic scaled targets in the scroll content, and Send its visible label')
primary = block(assistant, 'private var primaryAction: some View')
check('if assistant.isWorking { cancelButton } else { sendButton }' in primary, 'Send and Stop are one primary control in the same place')
body = block(assistant.split('struct NativeAssistantPanel: View {', 1)[1], '    var body: some View')
check('@ScaledMetric(relativeTo: .body) private var scaledActionLine' in assistant and 'private var actionHeight: Double { max(44, scaledActionLine + 14) }' in assistant and 'NativeAssistantLayout.actionBudget(actionHeight: actionHeight, stacked: stacked)' in body and 'NativeAssistantLayout.regions(' in body, 'The drawn action row, one scaled line of text plus its padding, must participate in region allocation')
check('dynamicTypeSize.isAccessibilitySize' in body and 'NativeAssistantLayout.stackedActions(width: width, actionHeight: max(44, scaledActionHeight)' in body and '@ScaledMetric(relativeTo: .body) private var scaledActionHeight = 44.0' in assistant, 'Accessibility text must stack the composer actions, and large standard text must stack at the same sizes as before')
composer = block(assistant, 'private func composer(width: Double')
# The chip row has the first vertical scroll view in the composer and the actions the second.
action_scroll = block(composer.split('draftEditor(', 1)[1], 'ScrollView(.vertical)')
check('composerActions(width: width, stacked: stacked)' in action_scroll and '.padding(.top, 6).padding(.bottom, 14)' in action_scroll and '}.frame(height: regions.actions)' in composer, 'The actual Send/Stop action subtree including padding must be INSIDE its own vertical ScrollView sized by the tested region')
check('ScrollView(.vertical) { contextRow.padding(.top, 14).padding(.bottom, 4) }.frame(height: regions.context)' in composer and '.clipped()' not in composer, 'Context chips must scroll inside their tested region, never be clipped out of reach')
check('draftEditor(height: max(0, regions.editor - 8))' in composer, 'The draft must use its tested region')
check('context: chipHeight + 18' in body and 'RoundedRectangle(cornerRadius: 10)' in composer and '.padding(8)' in composer, 'One border holds the chips, the draft and the actions, and the chip region includes its inset')
check('conversationScroll.frame(height: regions.history)' in body and 'composer(width: width, regions: regions, stacked: stacked)' in body, 'History scrolls in its own region above the pinned composer')
actions = block(assistant, 'private func composerActions(')
stacked_actions = actions.split('if stacked {', 1)[1].split('} else {', 1)[0]
check(stacked_actions.index('primaryAction') < stacked_actions.index('modelControls'), 'Stacked primary action must remain initially visible before the model menu')
check('modelControls' not in block(assistant, 'private var conversationContent: some View') and 'modelControls' in actions, 'Model choice belongs beside the draft and primary action, outside history')
check('Label(contextLabel, systemImage: "scope")' in block(assistant, 'private var contextRow: some View') and 'footerTimecode' in block(assistant, 'private var contextRow: some View'), 'Context and timecode remain visible in the composer')
check('runActivity' in block(assistant, 'private var conversationContent: some View') and 'runActivity' not in composer, 'Run status lives in history, so a run starting or ending never moves the composer')
source_view = viewer.split('private struct NativeSourceViewer: View {', 1)[1].split('private func markControls', 1)[0]
check('ScrollView(.vertical)' in source_view and 'layout.controls' in source_view and 'layout.picture' in source_view, 'Source marking/placement controls must have their own bounded scroll viewport beside a retained picture')
for text, expected in [(assistant, 3), (media, 1)]:
    check(text.count('#if os(macOS)\n            .frame(minWidth: 320') == expected, 'Touched modal minimum frames must be macOS-only')

# When testing an isolated draft, compare action closures with its retained production base.
base = source.parent / 'base/native/App/Shared/NativeEditor'
if base.exists():
    original_assistant = (base / 'NativeAssistantPanel.swift').read_text()
    original_viewer = (base / 'NativeViewer.swift').read_text()
    original_view = (base / 'NativeEditorView.swift').read_text()
    old_disabled = next(line.strip() for line in original_assistant.splitlines() if '.disabled(!assistant.configured ||' in line)
    new_disabled = next(line.strip() for line in assistant.splitlines() if '.disabled(!assistant.configured ||' in line)
    check(new_disabled == old_disabled, 'Send disabled/configuration/working/draft/provider length guards must remain exact')
    # contextLabel and receiptRow changed their wording on purpose (browser editor terms), so they are not compared.
    for marker in ['private var inputPicker:', 'private func showSettings()', 'private func receiptChanges(', 'private var canSendDraft: Bool']:
        check(normalized(block(assistant, marker)) == normalized(block(original_assistant, marker)), 'Assistant project/selection/import/inspection boundary changed: ' + marker)
    # The viewer around it was restyled (the Timeline and Source control), so the geometry enum itself is compared, exactly.
    check(block(viewer, 'enum NativeViewerGeometry {') == block(original_viewer, 'enum NativeViewerGeometry {'), 'Composition geometry must remain byte-for-byte intact')
    for marker in ['private func markControls(', 'private var placementControls:']:
        check(block(viewer, marker) == block(original_viewer, marker), 'Source mark/place semantics changed: ' + marker)
    check(block(view, '    private func select(_ panel:') == block(original_view, '    private func select(_ panel:'), 'Workspace routing must remain unchanged')
print(f'PASS: {contracts} responsive source/action/modal contracts')
if args.contracts_only:
    raise SystemExit(0)

policies = 'import Foundation\n' + block(view, 'enum NativeWorkspaceLayout {') + '\n' + block(assistant, 'enum NativeAssistantLayout {') + '\n' + block(viewer, 'enum NativeSourceViewerLayout {')
with tempfile.TemporaryDirectory(prefix='arya-native-responsive-') as directory:
    temp = Path(directory); helpers = temp / 'Policies.swift'; helpers.write_text(policies)
    main = temp / 'main.swift'; main.write_text((source / 'native/scripts/native-responsive-geometry-tests.swift').read_text())
    binary = temp / 'responsive'
    subprocess.run(['swiftc', '-j1', '-module-cache-path', str(temp/'cache'), str(helpers), str(main), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
    # The current 93-assertion geometry fixture is used verbatim, including portrait/compact policy checks.
    deliver = (repo/'native/App/Shared/NativeEditor/NativeDeliverPanel.swift').read_text()
    drawing = (repo/'native/App/Shared/NativeEditor/NativeDrawingOverlay.swift').read_text()
    main.write_text((repo/'native/scripts/ui-geometry-tests.swift').read_text())
    helpers.write_text('import Foundation\n' + block(deliver, 'enum NativeExportDimensions {') + '\n' + block(drawing, 'enum NativeCanvasCoordinates {') + '\n' + block(view, 'enum NativeWorkspaceLayout {'))
    subprocess.run(['swiftc', '-j1', '-module-cache-path', str(temp/'cache'), str(helpers), str(main), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
