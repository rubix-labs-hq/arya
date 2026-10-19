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
check('}.pickerStyle(.segmented).labelsHidden().frame(width: 168)' in viewer, 'Viewer control must hide its visible label rather than squeeze it into one-letter columns')
check('ViewThatFits(in: .horizontal)' in media and '.fixedSize(horizontal: true, vertical: false)' in media, 'Media must choose a menu when the complete noncompressing tab strip cannot fit')
check('ForEach(sections, id: \\.self) { Text($0).tag($0) }' in media, 'Compact media picker must expose every section')
check('NativeEditorStyle.minimumControlHeight + 4' in media, 'Media strip must fit native button height with spare vertical space')
check('Bring your footage into Reel' not in media and 'Bring your footage into Arya' in media, 'Empty-state brand must be Arya')
check('TextEditor(text: $model.assistantDraft)' in assistant and 'Picker("Input", selection: $model.assistantInputKind)' in assistant, 'Resize adaptation must retain the model-owned draft and input type')
check('inputPicker.pickerStyle(.menu)' in assistant and 'dynamicTypeSize.isAccessibilitySize' in assistant, 'Narrow/accessibility assistant must expose all input options through a menu')
cancel = block(assistant, 'private var cancelButton:')
check(assistant.count('{ assistant.cancel() }') == 1 and 'Button(assistant.state == "cancelling" ? "Stopping…" : "Stop request")' in cancel, 'Working Stop must remain exactly once and use the original callback')
footer = assistant.split('if hasRun && footerRegions.activity > 0 {', 1)[1].split('}.frame(width: width, height: height', 1)[0]
assert len(footer) < len(assistant.split('if hasRun && footerRegions.activity > 0 {', 1)[1]), 'Regular footer ends at the panel frame'
actions = block(assistant, 'private func footerActions(stacked: Bool')
check('footerActionViewport(height: footerRegions.actions, stacked: stackedFooter)' in footer and 'cancelButton' in actions and 'sendButton' in actions, 'Stop and Send must be pinned outside history and composer')
check('@ScaledMetric(relativeTo: .body) private var scaledActionHeight' in assistant and 'private var actionHeight: Double { max(44, scaledActionHeight) }' in assistant and 'requestedFooter: footerBudget' in assistant and 'NativeAssistantLayout.footerBudget(actionHeight: actionHeight' in assistant, 'Actual scaled action height must participate in footer region allocation')
check('VStack(spacing: 8)' in actions and 'Label(contextLabel, systemImage: "scope")' in assistant and 'footerTimecode' in assistant, 'Large-text actions must stack while timecode remains in the composer')
action_viewport = block(assistant, 'private func footerActionViewport(')
action_scroll = block(action_viewport, 'ScrollView(.vertical)')
check('footerActions(stacked: stacked, compactInput: compactInput)' in action_scroll and '.padding(.vertical, 8)' in action_scroll, 'The actual Send/Stop action subtree including padding must be INSIDE its own vertical ScrollView')
check('}.frame(height: height)' in action_viewport and 'NativeAssistantLayout.footerRegions(height: regions.footer, actionHeight: actionBudget - 16, hasRun: hasRun)' in assistant, 'Action viewport must use the tested footer allocation')
check('.frame(minHeight: actionHeight)' in cancel and '.frame(minHeight: actionHeight)' in block(assistant, 'private var sendButton:'), 'Send and Stop must retain complete intrinsic scaled targets in the scroll content')
check('Color.clear.frame(height: footerRegions.gap)' in footer and '.frame(height: footerRegions.activity)' in footer and '.padding(.vertical, 8)' not in footer, 'Only action scroll content owns vertical padding; activity/action viewport arithmetic must conserve the footer')
check('.padding(.horizontal, 12).frame(height: regions.chat)' in assistant and '}.frame(height: regions.composer)' in assistant, 'History and composer must scroll within their independently bounded viewports')
stacked_actions = actions.split('if stacked {', 1)[1].split('} else {\n            VStack(alignment: .leading', 1)[0]
assert len(stacked_actions) < len(actions.split('if stacked {', 1)[1]), 'Stacked footer branch ends at the inline branch'
check(stacked_actions.index('if assistant.isWorking { cancelButton } else { sendButton }') < stacked_actions.index('modelControls'), 'Stacked primary action must remain initially visible before the model menu')
check('modelControls' not in assistant.split('ScrollViewReader { proxy in', 1)[1].split('.padding(.horizontal, 12).frame(height: regions.chat)', 1)[0], 'Model choice belongs beside the draft and primary action, outside history')
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
    for marker in ['Button("Send") {', 'private var cancelButton:', 'private func footerActionViewport(', 'static func footerRegions(', 'private var inputPicker:', 'private var contextLabel:', 'private func showSettings()', 'private func receiptRow(', 'private func receiptChanges(', '.fileImporter(isPresented: $importingScript,']:
        check(normalized(block(assistant, marker)) == normalized(block(original_assistant, marker)), 'Assistant project/selection/import/inspection boundary changed: ' + marker)
    existing_viewer = original_viewer[original_viewer.index('enum NativeViewerGeometry {'):original_viewer.index('private struct NativeSourceViewer: View {')]
    proposed_viewer = viewer[viewer.index('enum NativeViewerGeometry {'):viewer.index('private struct NativeSourceViewer: View {')]
    check(proposed_viewer == existing_viewer.replace('}.pickerStyle(.segmented).frame(width: 168)', '}.pickerStyle(.segmented).labelsHidden().frame(width: 168)'), 'Composition geometry/gesture/lifecycle blocks must remain byte-for-byte intact except source picker label')
    for marker in ['private func markControls(', 'private var placementControls:']:
        check(block(viewer, marker) == block(original_viewer, marker), 'Source mark/place semantics changed: ' + marker)
    check(view[view.index('    private var compactWorkspace:'):] == original_view[original_view.index('    private var compactWorkspace:'):], 'Current compact/header/workspace/project behavior must remain unchanged')
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
