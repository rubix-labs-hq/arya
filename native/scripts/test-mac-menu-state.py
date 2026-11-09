#!/usr/bin/env python3
"""Check that the Mac Timeline menu reads editor state the menu bar can observe.

The menu bar re-renders when the session publishes, not when the native editor does. A menu
item that reads `session.nativeEditor` directly keeps the enabled state it had when the project
opened, and a disabled item still claims its key, so Delete stopped deleting selected clips.
"""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[2]
app = (root / 'native/App/macOS/ReelMacApp.swift').read_text()
session = (root / 'native/App/Shared/EditorSession.swift').read_text()

stale = [line.strip() for line in app.splitlines() if '.disabled(' in line and 'session.nativeEditor.' in line]
assert not stale, 'Menu items must read session.nativeMenu, not session.nativeEditor:\n' + '\n'.join(stale)

for item in ('Delete Selected Clip', 'Ripple Delete', 'Duplicate Selected Clips', 'Copy Timeline Selection',
             'Cut Timeline Selection', 'Paste Timeline Clips', 'Match Frame'):
    match = re.search(r'Button\("' + re.escape(item) + r'"\).*\n\s*\.disabled\((.*)\)', app)
    assert match and 'session.nativeMenu.' in match.group(1), f'{item} must be enabled from session.nativeMenu'

assert '@Published private(set) var nativeMenu = NativeMenuAvailability()' in session
assert 'model.objectWillChange.sink' in session and 'refreshNativeMenu()' in session
assert 'if next != nativeMenu { nativeMenu = next }' in session, 'Publish only when availability changes'
model = (root / 'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()
assert 'case .duplicate:\n            session.nativeEditor.duplicate()' in app, 'Duplicate must skip locked clips through the model'
assert re.search(r'func duplicate\(\) \{[\s\S]*?!\$0\.locked[\s\S]*?The selected clips are on locked tracks', model), 'Duplicate must leave locked clips out'
assert '!(cut && $0.0.flag("locked"))' in model, 'Cut must leave locked linked partners in place, as Delete does'
timeline = (root / 'native/App/Shared/NativeEditor/NativeTimeline.swift').read_text()
assert 'if mode == .move, model.selectionTouchesLockedTrack { model.nudgeUnlocked(frames: direction); return }' in timeline, 'Nudge must not be cancelled by a locked partner'
assert 'press.modifiers.isDisjoint(with: [.command, .option, .control])' in timeline, 'Modified arrows belong to the system'
assert 'let delta = max(frames / max(1, fps), -(clips.map(\\.start).min() ?? 0))' in model, 'Nudge must move every clip by one shared delta'
assert 'if action == "duplicate" { model.duplicate(); return }' in timeline, 'Clip menu Duplicate must share the locked-aware path'
assert timeline.count('if mode == .move, model.selectionTouchesLockedTrack { model.nudgeUnlocked(frames: direction); return }') == 2, 'Keyboard and iOS precision nudges must share the locked-aware path'
assert 'Button("Detach audio")' not in timeline, 'Native only unlinks, so it must say Unlink'
assert 'let playhead = (time * fps).rounded() / max(1, fps)' in model, 'Split tests the frame the core cuts on'
assert 'if press.key == .upArrow || press.key == .downArrow' in timeline, 'Up and Down jump between edits, as in the browser'
print('Mac menu state checks passed.')
