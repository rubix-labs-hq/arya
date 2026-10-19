#!/usr/bin/env python3
"""Source integration contracts only. Does not compile or execute Swift.
Actual Darwin/AVFoundation/JSC behavior is covered by the supplied Swift tests,
which must be run by the native build owner before claiming native acceptance.
"""
from pathlib import Path
import sys
root = Path(__file__).resolve().parents[2]
helper = (root / 'native/ReelKit/Sources/ReelKit/NativeMusicIdentity.swift').read_text()
composer = (root / 'native/ReelKit/Sources/ReelKit/NativeMusicComposer.swift').read_text()
backend = (root / 'native/ReelKit/Sources/ReelKit/ReelBackend.swift').read_text()
session = (root / 'native/App/Shared/EditorSession.swift').read_text()
imports = backend[backend.index('public func importMedia'):backend.index('public func copyIn')]
compose = backend[backend.index('private func composeMusic'):backend.index('private func placeMusic')]
place = backend[backend.index('private func placeMusic'):backend.index('private func cleanAudio')]
checks = {
 'bounded read budget': '44 + 2_880_000 * 6' in helper,
 '64 KiB streaming buffer': '[UInt8](repeating: 0, count: 65_536)' in helper,
 'digest actual read chunks': 'hash.update(data: Data(buffer.prefix(count)))' in helper,
 'owned regular file': 'value.st_mode & S_IFMT == S_IFREG' in helper,
 'owner checked': 'value.st_uid == Darwin.geteuid()' in helper,
 'hardlinks excluded': 'value.st_nlink == 1' in helper,
 'shared write excluded': 'value.st_mode & 0o022 == 0' in helper,
 'non-follow nonblocking descriptor': 'O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC' in helper,
 'stamp contains inode size and nanosecond timestamps': all(s in helper for s in ['value.st_ino', 'value.st_size', 'value.st_mtimespec.tv_nsec', 'value.st_ctimespec.tv_nsec']),
 'descriptor and pathname checked': 'Darwin.fstat' in helper and 'Darwin.lstat' in helper,
 'physical namespace checked': 'F_GETPATH' in helper and 'Darwin.realpath' in helper and 'opened == expected' in helper,
 'path authority project output': 'folder.output(path)' in helper,
 'cancelled worker propagates': 'onCancel: { worker.cancel() }' in helper and 'try Task.checkCancellation()' in helper,
 'no whole-file Data load': 'Data(contentsOf:' not in helper,
 'new render reads identity after final probe': composer.index('let identity = try NativeMusicIdentity.readSync') > composer.index('let asset = try probeOwnedWAV'),
 'digest included in generation receipt': 'identity.contentSHA256' in composer,
 'shared import pure bridge used': 'importDecisionJSON' in composer and 'NativeMusicComposer.importDecision' in imports,
 # Since fd4b5de ordinary imports probe the held private snapshot (OrdinaryImportIdentityTests.swift),
 # still without any music identity step.
 'ordinary imports remain normal probe': '} else {\n                    let probed = try await probe(snapshot.file)\n                    try requireMediaImport(capture, recovery: recovery); try snapshot.validate()\n                    assets.append((f, probed))\n                }' in imports,
 'only exact renderer1 score assets receive identity behavior': '== "original-music"' in composer and '== "arya-score-synth/1"' in composer,
 'legacy reimport never imports null decision': 'guard NativeMusicComposer.hasByteIdentity(existing) else' in imports,
 'final per-file identity revalidated before commit': imports.index('try item.identity.validate()') < imports.index('try commit(' , imports.index('var assets:')),
 'project replacement cannot publish generated record': 'projectGeneration == importGeneration' in imports,
 'per-file metadata changes cannot be overwritten': 'try core.asset(project: current, src: item.path) == item.original' in imports,
 'partial identity failure removes only affected import': 'assets.removeAll { $0.0 == item.path }' in imports,
 'replaced metadata warnings returned': '("warnings", .array(warnings))' in imports,
 'compose validates bytes before registration and placement': compose.count('try result.identity.validate()') == 2,
 'import hashes before potentially blocking probe': imports.index('NativeMusicIdentity.read(') < imports.index('try await probe(', imports.index('if generatedMusic')) ,
 'new placement hashes before probe': place.index('NativeMusicIdentity.read(') < place.index('NativeMusicComposer.probeOwnedWAV'),
 'new placement hashes before ops': place.index('NativeMusicIdentity.read(') < place.index('let ops ='),
 'legacy placement skips hash': 'NativeMusicComposer.hasByteIdentity(asset) ?' in place,
 'changed digest rejects before placement': 'identity.contentSHA256 != generated["contentSHA256"]' in place and place.index('The saved Media entry was left unchanged') < place.index('let ops ='),
 'placement rechecks project and stamp': 'placementGeneration == projectGeneration' in place and 'try identity?.validate()' in place,
 'native UI shows replacement notice': 'let warnings: [String]' in session and 'Array(warnings.prefix(3))' in session,
}
failed = [name for name, ok in checks.items() if not ok]
for name in failed: print('FAIL source contract:', name, file=sys.stderr)
if failed: raise SystemExit(1)
print(f'{len(checks)} native source integration contracts PASS; Swift compiler/runtime/UI UNRUN')
