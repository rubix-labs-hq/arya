#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { boundedWorkingFile, inspectText, safeLocation, workingFileEntries } from './public-readiness.mjs';

const scripts = fileURLToPath(new URL('.', import.meta.url));
const maximum = 2 * 1024 * 1024;

function temporaryFixture(run) {
  const base = realpathSync(mkdtempSync(resolve(tmpdir(), 'arya-node-reader-')));
  try { return run(base); }
  finally { rmSync(base, { recursive: true, force: true }); }
}

test('Node wrapper returns exact-limit bytes and excludes larger files', () => temporaryFixture(base => {
  const file = resolve(base, 'sample.txt');
  const bytes = Buffer.alloc(maximum, 97);
  writeFileSync(file, bytes);
  assert.deepEqual(boundedWorkingFile(file, base), bytes);
  writeFileSync(file, Buffer.alloc(maximum + 1, 97));
  assert.equal(boundedWorkingFile(file, base), null);
}));

test('Node wrapper reads exact-limit bytes when the caller sets SWIFT_BACKTRACE', () => temporaryFixture(base => {
  const file = resolve(base, 'sample.txt');
  const bytes = Buffer.alloc(maximum, 97);
  writeFileSync(file, bytes);
  const saved = process.env.SWIFT_BACKTRACE;
  process.env.SWIFT_BACKTRACE = 'enable=yes,interactive=no';
  try { assert.deepEqual(boundedWorkingFile(file, base), bytes); }
  finally { if (saved === undefined) delete process.env.SWIFT_BACKTRACE; else process.env.SWIFT_BACKTRACE = saved; }
}));

test('Node wrapper keeps exact-limit reads when the helper writes large stderr', async () => {
  const base = realpathSync(mkdtempSync(resolve(tmpdir(), 'arya-node-stderr-')));
  try {
    const copiedScripts = resolve(base, 'scripts');
    mkdirSync(copiedScripts);
    const copiedScanner = resolve(copiedScripts, 'public-readiness.mjs');
    const helper = resolve(copiedScripts, 'public-readiness-read.py');
    let scanner = readFileSync(resolve(scripts, 'public-readiness.mjs'), 'utf8');
    const noisy = 'import sys\nsys.stderr.write("w" * 4096)\nsys.stderr.flush()\n'
      + readFileSync(resolve(scripts, 'public-readiness-read.py'), 'utf8');
    writeFileSync(helper, noisy);
    const digest = createHash('sha256').update(noisy).digest('hex');
    scanner = scanner.replace(
      /const readHelperSHA256 = '[0-9a-f]{64}'/,
      `const readHelperSHA256 = '${digest}'`,
    );
    writeFileSync(copiedScanner, scanner);
    writeFileSync(resolve(base, 'sample.txt'), Buffer.alloc(maximum, 97));
    const copied = await import(pathToFileURL(copiedScanner).href + `?stderr=${Date.now()}`);
    assert.deepEqual(copied.boundedWorkingFile(resolve(base, 'sample.txt'), base), Buffer.alloc(maximum, 97));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('Node wrapper rejects actual FIFO, directory, ancestor, and leaf links', () => temporaryFixture(base => {
  const inside = resolve(base, 'inside'), outside = resolve(base, 'outside');
  mkdirSync(inside); mkdirSync(outside);
  writeFileSync(resolve(outside, 'private.txt'), 'outside-private-marker');
  symlinkSync(outside, resolve(inside, 'ancestor'));
  symlinkSync(resolve(outside, 'private.txt'), resolve(inside, 'leaf'));
  execFileSync('/usr/bin/python3', ['-I', '-S', '-c', 'import os, sys; os.mkfifo(sys.argv[1])', resolve(inside, 'fifo')],
    { timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
  for (const path of ['ancestor/private.txt', 'leaf', 'fifo', '.']) {
    assert.throws(() => boundedWorkingFile(resolve(inside, path), inside), error => {
      assert(!error.message.includes('outside-private-marker'));
      assert(!error.message.includes(base));
      return true;
    });
  }
}));

test('Node wrapper rejects missing and outside-root files with generic diagnostics', () => temporaryFixture(base => {
  mkdirSync(resolve(base, 'root'));
  writeFileSync(resolve(base, 'outside.txt'), 'outside-private-marker');
  for (const file of ['missing.txt', '../outside.txt']) {
    assert.throws(() => boundedWorkingFile(resolve(base, 'root', file), resolve(base, 'root')), error => {
      assert(!error.message.includes(base));
      assert(!error.message.includes('outside-private-marker'));
      return true;
    });
  }
}));

test('Hash-checked helper bytes execute, while modified, oversized, symlink, and FIFO helpers fail closed', async () => {
  const base = realpathSync(mkdtempSync(resolve(tmpdir(), 'arya-node-helper-')));
  try {
    const copiedScripts = resolve(base, 'scripts');
    mkdirSync(copiedScripts);
    const copiedScanner = resolve(copiedScripts, 'public-readiness.mjs');
    const helper = resolve(copiedScripts, 'public-readiness-read.py');
    copyFileSync(resolve(scripts, 'public-readiness.mjs'), copiedScanner);
    copyFileSync(resolve(scripts, 'public-readiness-read.py'), helper);
    writeFileSync(resolve(base, 'sample.txt'), 'safe');
    const copied = await import(pathToFileURL(copiedScanner).href);
    assert.equal(copied.boundedWorkingFile(resolve(base, 'sample.txt'), base).toString(), 'safe');
    writeFileSync(helper, 'raise RuntimeError("outside-private-marker")\n');
    assert.throws(() => copied.boundedWorkingFile(resolve(base, 'sample.txt'), base), /Working-file read rejected\./);
    writeFileSync(helper, 'a'.repeat(64 * 1024 + 1));
    assert.throws(() => copied.boundedWorkingFile(resolve(base, 'sample.txt'), base), /Working-file read rejected\./);
    rmSync(helper);
    symlinkSync(resolve(scripts, 'public-readiness-read.py'), helper);
    assert.throws(() => copied.boundedWorkingFile(resolve(base, 'sample.txt'), base), /Working-file read rejected\./);
    rmSync(helper);
    execFileSync('/usr/bin/python3', ['-I', '-S', '-c', 'import os, sys; os.mkfifo(sys.argv[1])', helper],
      { timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.throws(() => copied.boundedWorkingFile(resolve(base, 'sample.txt'), base), /Working-file read rejected\./);
  } finally { rmSync(base, { recursive: true, force: true }); }
});


test('working inventory includes untracked entries once and preserves tracked scope', () => {
  assert.deepEqual(workingFileEntries(['source.js', 'shared.js'], ['site/index.html', 'shared.js', 'site/index.html']), [
    { path: 'shared.js', scope: 'working-tree' },
    { path: 'site/index.html', scope: 'untracked-working-tree' },
    { path: 'source.js', scope: 'working-tree' },
  ]);
  assert.deepEqual(workingFileEntries(['source.js']), [{ path: 'source.js', scope: 'working-tree' }]);
  assert.deepEqual(workingFileEntries([], []), []);
});

test('untracked locations cannot disclose a token or personal path through report fields', () => {
  const token = 'sk-' + 'ant-' + 's'.repeat(30);
  const privatePath = '/Us' + 'ers/' + 'private-person/site/file.txt';
  for (const path of [`site/${token}.txt`, privatePath]) {
    const entry = workingFileEntries([], [path])[0];
    const report = { ...entry, ...safeLocation(entry.path), findings: inspectText(token) };
    const serialized = JSON.stringify(report);
    assert.equal(report.scope, 'untracked-working-tree');
    assert.equal(report.pathRedacted, true);
    assert(!serialized.includes(token));
    assert(!serialized.includes(privatePath));
    assert(!serialized.includes('private-person'));
  }
});
