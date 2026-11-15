#!/usr/bin/env python3
"""Inspect a built Arya App Store bundle without modifying it."""
import argparse
import json
import plistlib
import subprocess
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('app', type=Path)
p.add_argument('--unsigned', action='store_true', help='Allow an unsigned local development bundle')
p.add_argument('--version', default='1.2.0')
a = p.parse_args()
app = a.app.resolve()
mac = (app / 'Contents/Info.plist').is_file()
base = app / 'Contents' if mac else app
info = plistlib.loads((base / 'Info.plist').read_bytes())
assert info.get('CFBundleIdentifier') == 'app.reel.ios', 'Wrong App Store bundle identifier'
assert info.get('CFBundleShortVersionString') == a.version, 'Wrong marketing version'
exe = base / ('MacOS' if mac else '') / info['CFBundleExecutable']
assert exe.is_file(), 'Missing executable'
for f in app.rglob('*'):
    assert f.suffix != '.storekit', f'Test configuration shipped: {f.name}'
    assert f.name not in {'node', 'project-writer', 'StoreKitTest.framework'}, f'Development or direct-Mac helper shipped: {f.name}'
    if f.is_file() and (f.suffix in {'.js', '.mjs', '.html', '.dylib'} or f == exe):
        data = f.read_bytes()
        for forbidden in (b'buy.stripe.com', b'channel=mac-direct', b'channel=local-editor', b'channel=web-beta', b'--support-storekit-config'):
            assert forbidden not in data, f'Non-App-Store or test content shipped in {f.name}'
if not a.unsigned:
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True, capture_output=True)
    signed = subprocess.run(['codesign', '-d', '--entitlements', ':-', str(app)], check=True, capture_output=True).stdout
    entitlements = plistlib.loads(signed)
    if mac:
        assert entitlements.get('com.apple.security.app-sandbox') is True, 'Mac App Store bundle is not sandboxed'
        for forbidden in ('com.apple.security.automation.apple-events', 'com.apple.security.temporary-exception.apple-events',
                          'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.cs.disable-library-validation'):
            assert forbidden not in entitlements, f'Unexpected Mac entitlement: {forbidden}'
        # Sign in with ChatGPT receives its OAuth callback on a 127.0.0.1 listener.
        assert entitlements.get('com.apple.security.network.server') is True, 'Mac App Store bundle cannot receive the ChatGPT sign-in callback'
    assert entitlements.get('get-task-allow') is not True, 'Release permits debugger attachment'
print(json.dumps({'bundle': info['CFBundleIdentifier'], 'version': info['CFBundleShortVersionString'],
                  'platform': 'Mac App Store' if mac else 'iOS', 'signatureChecked': not a.unsigned,
                  'distributionContentChecked': True}))
