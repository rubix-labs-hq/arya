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
print('Mac menu state checks passed.')
