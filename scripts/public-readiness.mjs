#!/usr/bin/env node
// A bounded, read-only preflight. Findings contain locations, never matched values.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const maxBlobBytes = 2 * 1024 * 1024;
const maxFindings = 2000;
const maxSkipped = 2000;
const maxManifestEntries = 2000;
const families = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{30,}\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['figma-token', /\bfig[dp]_[A-Za-z0-9_-]{20,}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['stripe-secret', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
  ['credential-in-url', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]{8,}@/gi],
  ['assigned-secret', /\b(?:client_secret|api_key|access_token|refresh_token|aws_secret_access_key)\s*[=:]\s*["']([^"'\r\n]{20,})["']/gi],
];
const personalPath = /(?:\/Users\/|C:\\Users\\)[^\s/\\"'<>]+/g;

export function inspectTextDetailed(text, limit = maxFindings) {
  const findings = [];
  let detectedFindings = 0;
  const newlines = [];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') newlines.push(index);
  const lineAt = position => {
    let low = 0, high = newlines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (newlines[middle] < position) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
  const add = (family, severity, position) => {
    detectedFindings++;
    if (findings.length < limit) findings.push({ family, severity, line: lineAt(position) });
  };
  for (const [family, expression] of families) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      const candidate = match[1] ?? match[0];
      if (family === 'assigned-secret' && /^(?:\$\{|process\.|YOUR_|REPLACE_|example|placeholder|fixture|test-)/i.test(candidate)) continue;
      add(family, 'review-required', match.index);
    }
  }
  personalPath.lastIndex = 0;
  for (const match of text.matchAll(personalPath)) {
    add('personal-absolute-path', 'publication-review', match.index);
  }
  return { findings, detectedFindings, omittedFindings: detectedFindings - findings.length };
}

export function inspectText(text) { return inspectTextDetailed(text).findings; }

export function safeLocation(path) {
  if (path !== null && path !== undefined && inspectTextDetailed(path, 1).detectedFindings > 0) {
    const pathSHA256 = createHash('sha256').update(path).digest('hex');
    return { path: `[redacted path sha256:${pathSHA256}]`, pathSHA256, pathRedacted: true };
  }
  return { path };
}

function git(scopeRoot, ...args) {
  return execFileSync('git', ['-C', scopeRoot, ...args], { maxBuffer: 8 * 1024 * 1024 });
}

function textContent(bytes) {
  if (bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
}

export function boundedWorkingFile(path, scopeRoot = root) {
  const canonicalRoot = resolve(scopeRoot);
  const absolute = resolve(path);
  const rel = relative(canonicalRoot, absolute);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Working file outside scan root.');
  const request = JSON.stringify({ root: canonicalRoot, path: rel, maximum: maxBlobBytes });
  if (Buffer.byteLength(request) > 16 * 1024) throw new Error('Working-file request too large.');
  let output;
  try {
    // A minimal environment: with SWIFT_BACKTRACE set, the /usr/bin/python3 stub adds runtime
    // warnings and the bounded read failed with ENOBUFS.
    // Ignore stderr so a full stdout payload cannot share maxBuffer with helper noise.
    output = execFileSync('/usr/bin/python3', ['-I', '-S', '-c', trustedReadHelper()], {
      input: request, maxBuffer: maxBlobBytes + 128, timeout: 5000,
      env: { PATH: '/usr/bin:/bin', ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}) },
      killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch { throw new Error('Working-file read rejected.'); }
  if (output.equals(Buffer.from('ARYA_LIMIT\n'))) return null;
  const prefix = Buffer.from('ARYA_OK\n');
  if (!output.subarray(0, prefix.length).equals(prefix) || output.length > maxBlobBytes + prefix.length) {
    throw new Error('Invalid working-file response.');
  }
  return output.subarray(prefix.length);
}

// Review the helper and repin this digest whenever its source changes.
const readHelperSHA256 = 'ccad03b1cb1e49e82f8ab6e984a77c1d15c00bc4d3b70ee49e68bb1d42b4383b';
function trustedReadHelper() {
  const path = fileURLToPath(new URL('public-readiness-read.py', import.meta.url));
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > 64n * 1024n) throw new Error('Invalid working-file helper.');
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let count = 0;
    while (count < bytes.length) {
      const received = readSync(descriptor, bytes, count, bytes.length - count, null);
      if (received === 0) break;
      count += received;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (count > 64 * 1024 || BigInt(count) !== before.size ||
        ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some(key => before[key] !== after[key])) {
      throw new Error('Working-file helper changed.');
    }
    const source = bytes.subarray(0, count);
    if (createHash('sha256').update(source).digest('hex') !== readHelperSHA256) throw new Error('Unreviewed working-file helper.');
    return new TextDecoder('utf-8', { fatal: true }).decode(source);
  } finally { closeSync(descriptor); }
}

// Tracked entries win if callers supply the same path in both inventories.
export function workingFileEntries(trackedPaths, untrackedPaths = []) {
  const entries = new Map();
  for (const path of trackedPaths) entries.set(path, { path, scope: 'working-tree' });
  for (const path of untrackedPaths) {
    if (!entries.has(path)) entries.set(path, { path, scope: 'untracked-working-tree' });
  }
  return [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function scan(includeHistory, includeUntracked = false, scopeRoot = root) {
  scopeRoot = resolve(scopeRoot);
  trustedReadHelper();
  const referenceFingerprint = () => createHash('sha256').update(git(scopeRoot, 'for-each-ref', '--format=%(refname) %(objectname)')).digest('hex');
  const refsAtStart = referenceFingerprint();
  const treeFingerprint = createHash('sha256');
  const report = { schema: 2, readyToPublish: false, publicationApproved: false, head: git(scopeRoot, 'rev-parse', 'HEAD').toString().trim(),
    scope: { trackedWorkingTree: true, mutableWorkingTree: true, untrackedWorkingTree: includeUntracked, reachableHistory: includeHistory,
      maximumBlobBytes: maxBlobBytes, scansBlobOneAtATime: true,
      exclusions: [includeUntracked ? 'ignored files' : 'untracked and ignored files', 'Git LFS payloads', 'unreachable objects and reflogs',
        'GitHub releases, issues, pull requests, Actions logs and artifacts', 'provider dashboards',
        'binary content and blobs larger than the maximum'] },
    counts: { trackedPaths: 0, untrackedPaths: 0, untrackedTextFiles: 0, fingerprintedWorkingFiles: 0, workingTextFiles: 0, reachableBlobs: 0, historyTextBlobs: 0, detectedFindings: 0, skippedEntries: 0 },
    findings: [], skipped: [], workingFileManifest: [], missingDocuments: [], releaseGates: [
      'License choice and copyright ownership approval',
      'Third-party notices and fixture/media provenance approval',
      'Independent mature secret scan of all branches and tags, plus false-positive triage',
      'GitHub private data, Actions logs, releases, LFS and account-security review',
      'Fresh-clone build and test instructions validated',
      'Owner approval before changing repository visibility',
    ] };
  const add = finding => {
    report.counts.detectedFindings++;
    if (report.findings.length < maxFindings) report.findings.push({ ...finding, ...safeLocation(finding.path) });
  };
  const skip = entry => {
    report.counts.skippedEntries++;
    if (report.skipped.length < maxSkipped) report.skipped.push({ ...entry, ...safeLocation(entry.path) });
  };
  const addText = (text, location) => {
    const inspected = inspectTextDetailed(text);
    report.counts.detectedFindings += inspected.omittedFindings;
    for (const finding of inspected.findings) add({ ...location, ...finding });
  };
  const paths = git(scopeRoot, 'ls-files', '-z').toString().split('\0').filter(Boolean);
  const untrackedPaths = includeUntracked ? git(scopeRoot, 'ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean) : [];
  const entries = workingFileEntries(paths, untrackedPaths);
  report.counts.untrackedPaths = entries.filter(entry => entry.scope === 'untracked-working-tree').length;
  report.counts.trackedPaths = paths.length;
  const knownTextHashes = new Set();
  for (const { path, scope } of entries) {
    const absolute = resolve(scopeRoot, path);
    const rel = relative(scopeRoot, absolute);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Tracked path escaped the repository.');
    let bytes;
    try { bytes = boundedWorkingFile(absolute, scopeRoot); } catch { skip({ scope, path, reason: 'working-file-read-rejected' }); continue; }
    if (/(?:^|\/)(?:\.env(?:\.|$)|.*\.(?:p12|pfx|key|mobileprovision)$)/i.test(path)) add({ scope, path, family: 'sensitive-file-name', severity: 'review-required' });
    if (/(?:^|\/)(?:build|DerivedData|node_modules|\.reel|renders)\//.test(path)) add({ scope, path, family: 'generated-or-project-data', severity: 'publication-review' });
    if (/\.(?:mp4|mov|m4a|wav|mp3|png|jpg|jpeg|ttf|woff2?)$/i.test(path)) add({ scope, path, family: 'media-or-font-provenance', severity: 'publication-review' });
    if (bytes === null) { skip({ scope, path, reason: 'size-limit' }); continue; }
    const fileSHA256 = createHash('sha256').update(bytes).digest('hex');
    const binding = { scope, ...safeLocation(path), bytes: bytes.length, sha256: fileSHA256 };
    report.counts.fingerprintedWorkingFiles++;
    treeFingerprint.update(JSON.stringify(binding) + '\n');
    if (report.workingFileManifest.length < maxManifestEntries) report.workingFileManifest.push(binding);
    const text = textContent(bytes);
    if (text === null) { skip({ scope, path, reason: 'binary-or-invalid-utf8', bytes: bytes.length }); continue; }
    report.counts.workingTextFiles++;
    if (scope === 'untracked-working-tree') report.counts.untrackedTextFiles++;
    knownTextHashes.add(fileSHA256);
    addText(text, { scope, path });
  }
  if (includeHistory) {
    const objects = git(scopeRoot, 'rev-list', '--objects', '--all').toString().split('\n').filter(Boolean);
    const identifiers = objects.map(line => line.split(' ', 1)[0]);
    const aliases = new Map(objects.map(line => [line.split(' ', 1)[0], line.includes(' ') ? line.slice(line.indexOf(' ') + 1) : null]));
    const metadata = execFileSync('git', ['-C', scopeRoot, 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      { input: identifiers.join('\n') + '\n', maxBuffer: 8 * 1024 * 1024 }).toString().split('\n').filter(Boolean);
    for (const line of metadata) {
      const [object, kind, sizeString] = line.split(' ');
      if (kind !== 'blob') continue;
      const size = Number(sizeString);
      const path = aliases.get(object);
      report.counts.reachableBlobs++;
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid Git object size.');
      if (size > maxBlobBytes) { skip({ scope: 'history', object, path, reason: 'size-limit', bytes: size }); continue; }
      const bytes = execFileSync('git', ['-C', scopeRoot, 'cat-file', 'blob', object], { maxBuffer: maxBlobBytes + 1024 });
      const text = textContent(bytes);
      if (text === null) { skip({ scope: 'history', object, path, reason: 'binary-or-invalid-utf8', bytes: size }); continue; }
      report.counts.historyTextBlobs++;
      // An identical working file was already inspected. All other history blobs are inspected once.
      if (knownTextHashes.has(createHash('sha256').update(bytes).digest('hex'))) continue;
      addText(text, { scope: 'history', object, path });
    }
  }
  for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md']) {
    if (!paths.includes(path)) report.missingDocuments.push(path);
  }
  report.headAtEnd = git(scopeRoot, 'rev-parse', 'HEAD').toString().trim();
  report.refsSHA256AtStart = refsAtStart;
  report.refsSHA256AtEnd = referenceFingerprint();
  report.gitReferencesChangedDuringScan = report.head !== report.headAtEnd || report.refsSHA256AtStart !== report.refsSHA256AtEnd;
  report.workingTreeContentSHA256 = treeFingerprint.digest('hex');
  report.workingFileManifestTruncated = report.counts.fingerprintedWorkingFiles > report.workingFileManifest.length;
  report.findingsTruncated = report.counts.detectedFindings > report.findings.length;
  report.skippedTruncated = report.counts.skippedEntries > report.skipped.length;
  report.limitations = [
    'Pattern matches are candidates, not verified working credentials. Resolve each candidate before publication.',
    'History paths are the first alias reported by Git, not a complete path or commit-location index.',
    'This preflight is not a security audit and never clears the manual publication gates.',
    'A clean content scan does not establish media rights or permission to publish project documents.',
    'Untracked inventory excludes ignored files and is opt-in; missingDocuments lists documents not tracked in Git.',
    'Working-tree and Git inventories may change during the scan; this report is not an atomic release snapshot.',
  ];
  return report;
}

function selfTest() {
  const samples = [
    ['private-key', '-----BEGIN ' + 'PRIVATE KEY-----'],
    ['anthropic-key', 'sk-' + 'ant-' + 'a'.repeat(30)],
    ['openai-key', 'sk-' + 'proj-' + 'a'.repeat(40)],
    ['github-token', 'gh' + 'p_' + 'a'.repeat(40)],
    ['google-api-key', 'AI' + 'za' + 'a'.repeat(35)],
    ['aws-access-key', 'AK' + 'IA' + 'A'.repeat(16)],
    ['figma-token', 'fig' + 'd_' + 'a'.repeat(30)],
    ['slack-token', 'xox' + 'b-' + 'a'.repeat(30)],
    ['stripe-secret', 'sk_' + 'live_' + 'a'.repeat(30)],
    ['credential-in-url', 'https://' + 'account:' + 'secret'.repeat(4) + '@example.invalid'],
    ['assigned-secret', 'client_' + 'secret="' + 'a'.repeat(40) + '"'],
    ['personal-absolute-path', '/Us' + 'ers/example/private'],
  ];
  for (const [family, sample] of samples) {
    const findings = inspectText('first line\n' + sample);
    assert(findings.some(finding => finding.family === family && finding.line === 2), family);
    assert(!JSON.stringify(findings).includes(sample), `Redaction failed for ${family}`);
  }
  assert.deepEqual(inspectText('client_secret="YOUR_PLACEHOLDER_VALUE_GOES_HERE"'), []);
  assert.deepEqual(inspectText('api_key="${ENVIRONMENT_VARIABLE}"'), []);
  assert.deepEqual(inspectText('access_token="fixture-not-a-real-credential"'), []);
  assert.deepEqual(inspectText('sk-short \n public information'), []);
  assert.equal(textContent(Buffer.from([0, 1, 2])), null);
  assert.equal(textContent(Buffer.from([0xff, 0xff])), null);
  assert.equal(textContent(Buffer.from('valid text')), 'valid text');
  const many = inspectTextDetailed((samples[3][1] + '\n').repeat(2500), 2);
  assert.equal(many.findings.length, 2);
  assert.equal(many.detectedFindings, 2500);
  assert.equal(many.omittedFindings, 2498);
  assert(!JSON.stringify(safeLocation(`folder/${samples[1][1]}.txt`)).includes(samples[1][1]));
  assert(safeLocation(`folder/${samples[1][1]}.txt`).pathRedacted);
  assert.deepEqual(safeLocation('editor/core/project.js'), { path: 'editor/core/project.js' });
  const temporary = realpathSync(mkdtempSync(resolve(tmpdir(), 'arya-readiness-tests-')));
  try {
    const inside = resolve(temporary, 'inside'), outside = resolve(temporary, 'outside');
    mkdirSync(inside); mkdirSync(outside);
    writeFileSync(resolve(inside, 'safe.txt'), 'safe');
    writeFileSync(resolve(outside, 'private.txt'), 'outside');
    symlinkSync(outside, resolve(inside, 'parent-link'));
    symlinkSync(resolve(outside, 'private.txt'), resolve(inside, 'leaf-link'));
    assert.equal(boundedWorkingFile(resolve(inside, 'safe.txt'), inside).toString(), 'safe');
    assert.throws(() => boundedWorkingFile(resolve(inside, 'parent-link/private.txt'), inside));
    assert.throws(() => boundedWorkingFile(resolve(inside, 'leaf-link'), inside));
    assert.throws(() => boundedWorkingFile(resolve(outside, 'private.txt'), inside));
  } finally { rmSync(temporary, { recursive: true }); }
  console.log(JSON.stringify({ selfTest: 'passed', positiveFamilies: samples.length, ancestorAndLeafSymlinkTests: 3,
    boundedFindingTests: 3, redactedPathTests: 3, readHelperCalls: 3, gitOrProviderProcessesExecuted: 0 }));
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const flags = process.argv.slice(2);
  if (flags.some(flag => !['--history', '--include-untracked', '--json', '--self-test'].includes(flag))) {
    console.error('Use --history --include-untracked --json for the audit, or --self-test for disposable scanner checks.');
    process.exitCode = 2;
  } else if (flags.includes('--self-test')) selfTest();
  else {
    try {
      const report = scan(flags.includes('--history'), flags.includes('--include-untracked'));
      console.log(JSON.stringify(report, null, 2));
      // A caller cannot mistake an initial preflight for authorization to publish.
      process.exitCode = report.readyToPublish ? 0 : 1;
    } catch {
      console.error('Public-readiness preflight failed. No credential values were printed.');
      process.exitCode = 2;
    }
  }
}
