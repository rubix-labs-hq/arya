#!/usr/bin/env python3
"""Compile actual title planning, controller, and playback identity checks.

The editing core supplies operation receipts. The Swift fixture stubs the backend
boundary and does not execute SwiftUI controls.
"""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[2]
node = os.environ.get('NODE') or shutil.which('node')
if not node:
    raise SystemExit('Title appearance checks require Node.js.')

with tempfile.TemporaryDirectory(prefix='arya-title-controller-') as temporary:
    work = Path(temporary)
    receipt = work / 'receipt.json'
    environment = dict(os.environ, ARYA_TITLE_RECEIPT=str(receipt))
    subprocess.run([node, '--test', 'editor/test/native-title-appearance.test.mjs'],
                   cwd=root, env=environment, check=True)
    source = work / 'Checks.swift'
    subprocess.run([sys.executable, str(root / 'native/scripts/prepare-native-title-appearance.py'),
                    '--out', str(source)], cwd=root, check=True)
    binary = work / 'checks'
    subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(work / 'cache'),
                    str(source), str(root / 'native/ReelKit/Sources/ReelKit/JSON.swift'),
                    '-o', str(binary)], cwd=root, check=True)
    subprocess.run([str(binary), str(receipt)], cwd=root, check=True)
