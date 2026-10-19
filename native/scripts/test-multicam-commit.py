#!/usr/bin/env python3
"""Exercise production multicam dispatch with the shared core and a suspended request."""
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[2]
panel = (root / 'native/App/Shared/NativeEditor/NativeMulticamPanel.swift').read_text()
model = (root / 'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()

def block(source, marker):
    start = source.index(marker)
    end = source.index('{', start) + 1
    depth = 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]

source = 'import Foundation\nimport CryptoKit\nimport Darwin\n'
source += block(model, 'struct NativeSourceFileIdentity: Equatable {') + '\n'
for marker in ['enum NativeMulticamPlanning {', '@MainActor private func NativeMulticamFiles(',
               'private extension NativeMulticamPlanning.Capture {', '@MainActor private func NativeMulticamCommit(',
               '@MainActor private enum NativeMulticamCore {']:
    source += block(panel, marker) + '\n'
source += (root / 'native/scripts/multicam-commit-tests.swift').read_text()

with tempfile.TemporaryDirectory(prefix='reel-multicam-commit-') as temp:
    folder = Path(temp)
    core = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else folder / 'reel-core.js'
    if len(sys.argv) == 1:
        subprocess.run(['node', str(root / 'native/scripts/bundle-core.mjs'), '--out', str(core)], check=True)
    script = folder / 'Checks.swift'
    script.write_text(source)
    binary = folder / 'checks'
    subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(folder / 'cache'),
                    str(root / 'native/ReelKit/Sources/ReelKit/JSON.swift'),
                    str(root / 'native/ReelKit/Sources/ReelKit/ReelCore.swift'), str(script), '-o', str(binary)], check=True)
    subprocess.run([str(binary), str(core), str(folder)], check=True)
