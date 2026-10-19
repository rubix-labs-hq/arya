import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { encodeJournalPacket, decodeJournalPacket } from '../core/recovery-journal-packet.mjs'
import { JOURNAL_DEPENDENCIES } from '../core/project-writer-manifest.mjs'
import { createTranscriptDraftStore } from '../core/transcript-draft-store.mjs'

// Root supplies a disposable production helper built from this exact candidate.
// These actual ACL/helper fixtures never compile, install or touch a live project.
const binary = process.env.ARYA_DRAFT_PRODUCTION_BINARY
const enabled = process.platform === 'darwin' && Boolean(binary)
const script = fileURLToPath(new URL('../core/project-recovery-journal.mjs', import.meta.url))
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes }
function fixture(t, { external = false, link = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reel-draft-private-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let sourceFile = path.join(root, 'media.wav'), src = 'media.wav'
  if (external) { const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reel-draft-external-'))); t.after(() => fs.rmSync(outside, { recursive: true, force: true })); sourceFile = path.join(outside, 'recording.wav'); src = sourceFile }
  fs.writeFileSync(sourceFile, 'source fixture')
  if (link) { fs.symlinkSync(sourceFile, path.join(root, 'linked.wav')); src = 'linked.wav' }
  fs.writeFileSync(path.join(root, 'reel.project.json'), JSON.stringify({ assets: { [src]: {} } }))
  fs.mkdirSync(path.join(root, '.reel/transcripts'), { recursive: true })
  const stat = fs.statSync(sourceFile, { bigint: true }), key = createHash('sha1').update(`${src}|en-US`).digest('hex').slice(0, 16)
  fs.writeFileSync(path.join(root, '.reel/transcripts', `${key}.json`), JSON.stringify({ src, locale: 'en-US', revision: 1, fingerprint: `v2|${stat.size}|${stat.mtimeNs / 1000000000n}|${stat.mtimeNs % 1000000000n}`, status: 'complete', words: [{ t: 0, end: 1, text: 'saved' }] }))
  const body = { src, locale: 'en-US', sessionID: randomUUID(), sequence: 1, words: [{ t: 0, end: 1, text: ' \t retained \n' }], basis: createTranscriptDraftStore({ root }).context(src, 'en-US').basis }
  return { root, body, sourceFile }
}
function packet(root, body) {
  const node = fs.realpathSync(process.execPath), ns = fs.statSync(node, { bigint: true }), ss = fs.statSync(script, { bigint: true }), rs = fs.statSync(root, { bigint: true })
  const input = Buffer.concat([u64(rs.dev), u64(rs.ino), u64(ns.dev), u64(ns.ino), u64(ss.dev), u64(ss.ino), createHash('sha256').update(fs.readFileSync(script)).digest(), encodeJournalPacket({ operation: 'transcriptDrafts', action: 'checkpoint', trustedDependencies: JOURNAL_DEPENDENCIES }, [JSON.stringify(body)])])
  return { input, node }
}
function invoke(root, body, mode = 'journal-exec-drafts') {
  const { input, node } = packet(root, body)
  return spawnSync(binary, [mode, root, node, script], { input, timeout: 5000, maxBuffer: 1024 * 1024 })
}
const acl = file => spawnSync('/bin/ls', ['-lde', file], { encoding: 'utf8' }).stdout

test('actual fixed draft mode publishes a private record under the shared lock without changing source or transcript', { skip: !enabled }, t => {
  const f = fixture(t), result = invoke(f.root, f.body)
  assert.equal(result.status, 0, result.stderr?.toString())
  const packet = decodeJournalPacket(result.stdout); assert.equal(packet.metadata.ok, true)
  const file = path.join(f.root, '.reel/transcript-drafts', `${packet.metadata.result.id}.json`)
  assert.equal(fs.statSync(file).nlink, 1); assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.doesNotMatch(acl(file), /\n\s*\d+:/)
  assert.equal(JSON.parse(fs.readFileSync(file)).words[0].text, ' \t retained \n')
  assert.equal(fs.readFileSync(path.join(f.root, 'media.wav'), 'utf8'), 'source fixture')
})
test('actual inherited draft-directory ACL is refused before any populated staging write and remains unchanged', { skip: !enabled }, t => {
  const f = fixture(t), dir = path.join(f.root, '.reel/transcript-drafts'); fs.mkdirSync(dir, { recursive: true })
  const user = os.userInfo().username
  const changed = spawnSync('/bin/chmod', ['+a', `user:${user} allow read,write,append,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit`, dir], { encoding: 'utf8' })
  assert.equal(changed.status, 0, changed.stderr)
  const before = acl(dir), result = invoke(f.root, f.body)
  assert.notEqual(result.status, 0); assert.deepEqual(fs.readdirSync(dir), [])
  assert.equal(acl(dir), before)
})
test('ordinary recovery journal mode cannot bypass the retained private draft-directory gate', { skip: !enabled }, t => {
  const f = fixture(t), result = invoke(f.root, f.body, 'journal-exec')
  assert.notEqual(result.status, 0)
  const packet = decodeJournalPacket(result.stdout); assert.equal(packet.metadata.ok, false); assert.match(packet.metadata.error, /private stage gate/)
  assert.equal(fs.existsSync(path.join(f.root, '.reel/transcript-drafts')), false)
})

test('actual private-stage helper accepts supported referenced external sources and relative symlinks', { skip: !enabled }, t => {
  for (const link of [false, true]) {
    const f = fixture(t, { external: true, link }), result = invoke(f.root, f.body)
    assert.equal(result.status, 0, result.stderr?.toString())
    assert.equal(decodeJournalPacket(result.stdout).metadata.ok, true)
    assert.equal(fs.readFileSync(f.sourceFile, 'utf8'), 'source fixture')
  }
})

const testingBinary = process.env.ARYA_DRAFT_TEST_BINARY
const testingEnabled = process.platform === 'darwin' && Boolean(testingBinary)
test('actual post-gate inherited directory ACL change cannot grant access to the already-created private stage', { skip: !testingEnabled }, async t => {
  const f = fixture(t), ready = path.join(f.root, 'fixture-ready'), release = path.join(f.root, 'fixture-release'), { input, node } = packet(f.root, f.body)
  const child = spawn(testingBinary, ['journal-exec-drafts', f.root, node, script], { env: { ...process.env, ARYA_TEST_FAULT: 'draft-stage-hold', ARYA_TEST_LOCK_READY: ready, ARYA_TEST_LOCK_RELEASE: release } })
  t.after(() => child.kill('SIGKILL'))
  const chunks = [], errors = []; child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk))
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)) })
  child.stdin.end(input)
  const deadline = Date.now() + 3000
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(fs.existsSync(ready), 'The actual C test helper must expose its private-stage handoff')
  const directory = path.join(f.root, '.reel/transcript-drafts'), names = fs.readdirSync(directory)
  assert.equal(names.length, 1); const stageFile = path.join(directory, names[0]); assert.equal(fs.statSync(stageFile).size, 0)
  assert.equal(fs.statSync(stageFile).mode & 0o777, 0o600); assert.doesNotMatch(acl(stageFile), /\n\s*\d+:/)
  const changed = spawnSync('/bin/chmod', ['+a', `user:${os.userInfo().username} allow read,write,append,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit`, directory], { encoding: 'utf8' })
  assert.equal(changed.status, 0, changed.stderr); const inherited = acl(directory)
  fs.writeFileSync(release, 'continue')
  assert.equal(await done, 0, Buffer.concat(errors).toString())
  const response = decodeJournalPacket(Buffer.concat(chunks)); assert.equal(response.metadata.ok, true)
  const final = path.join(directory, `${response.metadata.result.id}.json`)
  assert.equal(fs.statSync(final).nlink, 1); assert.equal(fs.statSync(final).mode & 0o777, 0o600); assert.doesNotMatch(acl(final), /\n\s*\d+:/)
  assert.equal(acl(directory), inherited, 'Existing directory ACL metadata must remain unchanged')
})
