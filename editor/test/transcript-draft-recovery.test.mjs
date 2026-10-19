import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { encodeJournalPacket, decodeJournalPacket } from '../core/recovery-journal-packet.mjs'
import { fixtureJournal } from './support/journal-fixture-bridge.mjs'
import { JOURNAL_DEPENDENCIES } from '../core/project-writer-manifest.mjs'
import { createTranscriptDraftStore, transcriptTimingDigest, readTranscriptDraftBytes } from '../core/transcript-draft-store.mjs'
import routes from '../routes/transcript-drafts.mjs'
const words = [{ t: 0, end: 1, text: 'Hello' }, { t: 1, end: 2, text: 'world' }]
function fixture(t, extras = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-drafts-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'reel.project.json'), '{"assets":{"media.wav":{}}}\n'); fs.writeFileSync(path.join(root, 'media.wav'), 'fixture source')
  const record = { words, revision: 2, fingerprint: 'saved-fingerprint', status: 'complete' }
  const options = { assertLock: () => {}, root, resolveMedia: src => path.join(root, src), readTranscript: () => record, ...extras }
  const store = createTranscriptDraftStore(options)
  const checkpoint = (value = {}, target = store) => target.checkpoint({ src: 'media.wav', locale: 'en-US', basis: target.context('media.wav', 'en-US').basis, sessionID: randomUUID(), sequence: 1, parent: null, words, ...value })
  return { root, record, options, store, checkpoint, body: id => ({ src: 'media.wav', locale: 'en-US', id }) }
}

test('actual filesystem reopen offers exact whitespace and empty edits but does not apply automatically', t => {
  const f = fixture(t), edited = [{ ...words[0], text: ' \t Hello \n' }, { ...words[1], text: '' }]
  const receipt = f.checkpoint({ words: edited }), reopened = createTranscriptDraftStore(f.options)
  const offer = reopened.context('media.wav', 'en-US').offers[0]
  assert.equal(offer.id, receipt.id); assert.equal(offer.recoverable, true); assert.equal(offer.words, undefined)
  assert.deepEqual(reopened.recover(f.body(receipt.id)).words, edited)
  assert.deepEqual(f.record.words, words)
  assert.equal(fs.readFileSync(path.join(f.root, 'media.wav'), 'utf8'), 'fixture source')
})
test('source rewrite, project bytes and saved revision each make the retained offer copy-only', t => {
  for (const change of ['source', 'project', 'revision', 'timings']) {
    const f = fixture(t), receipt = f.checkpoint()
    if (change === 'source') fs.writeFileSync(path.join(f.root, 'media.wav'), 'new source')
    if (change === 'project') fs.appendFileSync(path.join(f.root, 'reel.project.json'), ' ')
    if (change === 'revision') f.record.revision++
    if (change === 'timings') f.record.words = [{ ...words[0], end: 0.8 }, words[1]]
    assert.equal(f.store.context('media.wav', 'en-US').offers[0].recoverable, false, change)
    assert.throws(() => f.store.recover(f.body(receipt.id)), error => error.status === 409, change)
    assert.deepEqual(f.store.read(f.body(receipt.id)).words, words)
  }
})
test('two sessions keep separate offers and a stale same-session parent cannot replace a newer head', t => {
  const f = fixture(t), first = f.checkpoint(), other = f.checkpoint()
  const next = f.checkpoint({ sessionID: first.sessionID, sequence: 2, parent: first.id, words: [{ ...words[0], text: 'Newest' }, words[1]] })
  assert.equal(f.store.context('media.wav', 'en-US').offers.length, 2)
  assert.throws(() => f.checkpoint({ sessionID: first.sessionID, sequence: 2, parent: first.id }), error => error.status === 409)
  assert.throws(() => f.store.read(f.body(first.id)), error => error.status === 409)
  f.store.discard(f.body(next.id)); assert.deepEqual(f.store.context('media.wav', 'en-US').offers.map(v => v.id), [other.id])
})
test('a failed publication preserves the prior durable head and cleans only its own temporary', t => {
  const f = fixture(t), first = f.checkpoint(), bad = createTranscriptDraftStore({ ...f.options, beforePublish: () => { throw new Error('fixture crash before publication') } })
  assert.throws(() => f.checkpoint({ sessionID: first.sessionID, sequence: 2, parent: first.id }, bad), /fixture crash/)
  assert.equal(f.store.context('media.wav', 'en-US').offers[0].id, first.id)
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.reel/transcript-drafts')), [`${first.id}.json`])
})
test('changed project during publication rejects before replacing any recovery head', t => {
  const f = fixture(t), first = f.checkpoint(), bad = createTranscriptDraftStore({ ...f.options, beforePublish: () => fs.appendFileSync(path.join(f.root, 'reel.project.json'), ' ') })
  assert.throws(() => f.checkpoint({ sessionID: first.sessionID, sequence: 2, parent: first.id }, bad), error => error.status === 409)
  assert.equal(f.store.context('media.wav', 'en-US').offers[0].id, first.id)
})
test('linked directories and records are refused while the previous record stays readable', t => {
  const f = fixture(t), receipt = f.checkpoint(), directory = path.join(f.root, '.reel/transcript-drafts'), external = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-external-'))
  t.after(() => fs.rmSync(external, { recursive: true, force: true }))
  const linked = randomUUID(); fs.symlinkSync(path.join(directory, `${receipt.id}.json`), path.join(directory, `${linked}.json`))
  assert.equal(f.store.context('media.wav', 'en-US').warnings.length, 1)
  assert.throws(() => f.store.read(f.body(linked)), error => error.status === 409)
  fs.renameSync(directory, directory + '-preserved'); fs.symlinkSync(external, directory)
  assert.throws(() => f.store.context('media.wav', 'en-US'), /symbolic links/)
  assert.deepEqual(fs.readdirSync(external), [])
})
test('exact timestamps are mandatory and reordered basis JSON remains compatible across hosts', t => {
  const f = fixture(t), basis = f.store.context('media.wav', 'en-US').basis, reordered = Object.fromEntries(Object.entries(basis).reverse())
  assert.throws(() => f.checkpoint({ words: [{ ...words[0], end: 0.5 }, words[1]] }), error => error.status === 409)
  assert.throws(() => f.checkpoint({ words: [{ ...words[0], text: 'a'.repeat(1001) }, words[1]] }), /1000/)
  const receipt = f.checkpoint({ basis: reordered }); assert.equal(f.store.recover(f.body(receipt.id)).basis.timingSHA256, transcriptTimingDigest(words))
})
test('eight live recovery sessions reject a ninth before allocation and discard frees a head', t => {
  const f = fixture(t), receipts = Array.from({ length: 8 }, () => f.checkpoint())
  assert.throws(() => f.checkpoint(), /Eight recovery/)
  f.store.discard(f.body(receipts[0].id)); f.checkpoint()
  assert.equal(f.store.context('media.wav', 'en-US').offers.length, 8)
})
test('the actual plugin routes expose explicit read/recover/discard and enforce publication callback', t => {
  const f = fixture(t); let writes = 0
  const plugin = routes({ ROOT: f.root, resolveMedia: f.options.resolveMedia, transcripts: { get: () => f.record }, assertDraftLock: () => {}, draftJournal: (_root, metadata, texts) => ({ result: f.store[metadata.action](JSON.parse(texts[0])) }), assertCurrent: () => writes++ }).routes
  const context = plugin['GET /api/transcript/drafts']({}, new URLSearchParams({ src: 'media.wav', locale: 'en-US' }))
  const receipt = plugin['POST /api/transcript/drafts/checkpoint']({ ...f.body(undefined), basis: context.basis, words, sessionID: randomUUID(), sequence: 1 })
  assert.equal(writes, 1); assert.deepEqual(plugin['POST /api/transcript/drafts/recover'](f.body(receipt.id)).words, words)
  plugin['POST /api/transcript/drafts/discard'](f.body(receipt.id)); assert.equal(writes, 2)
})

test('actual client checkpoints one in flight, coalesces latest exact text, and retires only its acknowledged head', async () => {
  const { transcriptRecoverySession } = await import('../web/ui/transcript-drafts.js')
  let resolveFirst; const gate = new Promise(resolve => { resolveFirst = resolve }); const calls = [], statuses = []
  const api = async (route, body) => { calls.push({ route, body }); if (calls.length === 1) await gate; return { id: `head-${body.sequence}`, sequence: body.sequence } }
  const session = transcriptRecoverySession(randomUUID(), api, { src: 'media.wav', locale: 'en-US' }, value => statuses.push(value))
  session.capture({ basis: { revision: 2, fingerprint: 'fp' } }, { revision: 2, fingerprint: 'fp' })
  session.update([{ ...words[0], text: 'first' }]); session.update([{ ...words[0], text: 'middle' }]); session.update([{ ...words[0], text: ' \nlatest\t ' }])
  assert.equal(calls.length, 1); resolveFirst(); await session.flush()
  assert.equal(calls.length, 2); assert.equal(calls[1].body.parent, 'head-1'); assert.equal(calls[1].body.words[0].text, ' \nlatest\t ')
  await session.retire(); assert.equal(calls[2].route, '/api/transcript/drafts/discard'); assert.equal(calls[2].body.id, 'head-2'); assert.equal(statuses.at(-1), 'Recovery copy saved on disk.')
})
test('client lost checkpoint reply retains the error and never claims durability or discards another head', async () => {
  const { transcriptRecoverySession } = await import('../web/ui/transcript-drafts.js'); const calls = [], statuses = []
  const session = transcriptRecoverySession(randomUUID(), async route => { calls.push(route); throw new Error('lost reply') }, { src: 'media.wav', locale: 'en-US' }, value => statuses.push(value))
  session.capture({ basis: { revision: 2, fingerprint: 'fp' } }, { revision: 2, fingerprint: 'fp' }); session.update(words)
  await assert.rejects(session.retire(), /lost reply/); assert.deepEqual(calls, ['/api/transcript/drafts/checkpoint']); assert.match(statuses.at(-1), /Keep this editor open/)
})

test('bounded actual read rejects a growing file and a named-inode swap after open', t => {
  const f = fixture(t), file = path.join(f.root, 'bounded.json')
  fs.writeFileSync(file, '{}')
  assert.throws(() => readTranscriptDraftBytes(file, 16, { beforeRead: () => fs.appendFileSync(file, '01234567890123456789') }), /changed/)
  fs.writeFileSync(file, '{}')
  assert.throws(() => readTranscriptDraftBytes(file, 16, { beforeRead: () => { fs.renameSync(file, file + '.owned'); fs.writeFileSync(file, '{}') } }), /changed/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{}'); assert.equal(fs.readFileSync(file + '.owned', 'utf8'), '{}')
})
test('a replaced staging name is retained and cannot be linked or deleted by the older owner', t => {
  const f = fixture(t), first = f.checkpoint(), directory = path.join(f.root, '.reel/transcript-drafts'); let replacement
  const bad = createTranscriptDraftStore({ ...f.options, beforePublish: () => {
    const part = fs.readdirSync(directory).find(name => name.endsWith('.part')); replacement = path.join(directory, part)
    fs.renameSync(replacement, replacement + '.preserved'); fs.writeFileSync(replacement, 'another writer')
  } })
  assert.throws(() => f.checkpoint({ sessionID: first.sessionID, sequence: 2, parent: first.id }, bad), /staged recovery copy changed/)
  assert.equal(fs.readFileSync(replacement, 'utf8'), 'another writer')
  assert.equal(f.store.context('media.wav', 'en-US').offers[0].id, first.id)
})
test('production mutations refuse a missing retained publication lock before recovery allocation', t => {
  const f = fixture(t), unlocked = createTranscriptDraftStore({ ...f.options, assertLock: null })
  assert.throws(() => f.checkpoint({}, unlocked), /retained shared project publication lock/)
  assert.equal(fs.existsSync(path.join(f.root, '.reel/transcript-drafts')), false)
})
test('the journal standalone reader uses actual saved source fingerprint and preserves saved transcript bytes', t => {
  const f = fixture(t), directory = path.join(f.root, '.reel/transcripts'); fs.mkdirSync(directory, { recursive: true })
  const key = createHash('sha1').update('media.wav|en-US').digest('hex').slice(0, 16), file = path.join(directory, `${key}.json`)
  const stat = fs.statSync(path.join(f.root, 'media.wav'), { bigint: true })
  const saved = JSON.stringify({ src: 'media.wav', locale: 'en-US', revision: 2, fingerprint: `v2|${stat.size}|${stat.mtimeNs / 1000000000n}|${stat.mtimeNs % 1000000000n}`, words, status: 'complete' })
  fs.writeFileSync(file, saved)
  const standalone = createTranscriptDraftStore({ root: f.root, assertLock: () => {} }), receipt = f.checkpoint({}, standalone)
  assert.deepEqual(standalone.recover(f.body(receipt.id)).words, words)
  fs.appendFileSync(path.join(f.root, 'media.wav'), ' changed')
  assert.equal(standalone.context('media.wav', 'en-US').offers[0].recoverable, false)
  assert.equal(fs.readFileSync(file, 'utf8'), saved)
})

test('a late directory-sync failure returns an acknowledged published head with a warning and retains its prior head', t => {
  const f = fixture(t), first = f.checkpoint(), original = fs.fsyncSync
  const bad = createTranscriptDraftStore({ ...f.options, beforePublish: () => { fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('fixture directory sync'); return original(fd) } } })
  let receipt
  try { receipt = f.checkpoint({ sessionID: first.sessionID, sequence: 2, parent: first.id }, bad) } finally { fs.fsyncSync = original }
  assert.match(receipt.warning, /published/)
  assert.equal(f.store.context('media.wav', 'en-US').offers[0].id, receipt.id)
  assert.equal(fs.existsSync(path.join(f.root, '.reel/transcript-drafts', `${first.id}.json`)), true)
  const next = f.checkpoint({ sessionID: first.sessionID, sequence: 3, parent: receipt.id })
  assert.equal(next.sequence, 3)
})
test('two incoming publication names are reserved before a full directory can allocate a stage', t => {
  const f = fixture(t), directory = path.join(f.root, '.reel/transcript-drafts'); fs.mkdirSync(directory, { recursive: true })
  for (let index = 0; index < 63; index++) fs.writeFileSync(path.join(directory, `preserved-${index}.unknown`), '')
  assert.throws(() => f.checkpoint(), /recovery store is full/)
  assert.equal(fs.readdirSync(directory).length, 63)
})

test('pruning preserves a prior same-inode record whose bytes changed after the admission scan', t => {
  const f = fixture(t), first = f.checkpoint(), old = path.join(f.root, '.reel/transcript-drafts', `${first.id}.json`)
  const next = createTranscriptDraftStore({ ...f.options, beforePublish: () => fs.appendFileSync(old, ' externally changed') })
  const receipt = f.checkpoint({ sessionID: first.sessionID, sequence: 2, parent: first.id }, next)
  assert.equal(fs.existsSync(old), true); assert.match(fs.readFileSync(old, 'utf8'), /externally changed/)
  assert.equal(f.store.context('media.wav', 'en-US').offers[0].id, receipt.id)
})

test('the actual fixed journal child supports a source already referenced outside the project and relative links', t => {
  const f = fixture(t), external = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-external-source-'))
  t.after(() => fs.rmSync(external, { recursive: true, force: true }))
  const source = path.join(external, 'recording.wav'); fs.writeFileSync(source, 'external source fixture')
  fs.writeFileSync(path.join(f.root, 'reel.project.json'), JSON.stringify({ assets: { [source]: {} } }))
  fs.mkdirSync(path.join(f.root, '.reel/transcripts'), { recursive: true })
  fs.mkdirSync(path.join(f.root, '.reel/recovery'), { recursive: true })
  fs.mkdirSync(path.join(f.root, '.reel/transcript-drafts'), { mode: 0o700 })
  const stat = fs.statSync(source, { bigint: true }), fingerprint = `v2|${stat.size}|${stat.mtimeNs / 1000000000n}|${stat.mtimeNs % 1000000000n}`
  for (const src of [source, 'linked-source.wav']) {
    if (!path.isAbsolute(src)) fs.symlinkSync(source, path.join(f.root, src))
    const key = createHash('sha1').update(`${src}|en-US`).digest('hex').slice(0, 16)
    fs.writeFileSync(path.join(f.root, '.reel/transcripts', `${key}.json`), JSON.stringify({ src, locale: 'en-US', revision: 1, fingerprint, words, status: 'complete' }))
    const store = createTranscriptDraftStore({ root: f.root }), context = store.context(src, 'en-US')
    assert.ok(context.basis)
    runFixtureJournalChild(t, f.root, { src, locale: 'en-US', basis: context.basis, words, sessionID: randomUUID(), sequence: 1 })
    assert.equal(store.context(src, 'en-US').offers.length, 1)
  }
})

function runFixtureJournalChild(t, root, body, { beforeChild = () => {}, expectError = null, metadata = {} } = {}) {
  // The real fixed journal parser, hashes and operation run. These retained FDs are
  // injectable stand-ins for the root-owned C advisory-lock/privacy gate.
  const lock = path.join(root, '.reel/recovery/project-write.lock')
  if (!fs.existsSync(lock)) fs.writeFileSync(lock, '', { flag: 'wx', mode: 0o600 })
  const directory = path.join(root, '.reel/transcript-drafts'), name = `draft-${randomUUID().replaceAll('-', '')}.part`, stageFile = path.join(directory, name)
  const lockFD = fs.openSync(lock, 'r+'), draftFD = fs.openSync(directory, 'r'), stat = fs.statSync(root, { bigint: true }), stageFD = fs.openSync(stageFile, 'wx+', 0o600)
  const staged = fs.fstatSync(stageFD, { bigint: true }), snapshot = { device: String(staged.dev), inode: String(staged.ino), mode: String(staged.mode), uid: String(staged.uid), gid: String(staged.gid), mtimeSec: String(staged.mtimeNs / 1000000000n), mtimeNsec: String(staged.mtimeNs % 1000000000n), ctimeSec: String(staged.ctimeNs / 1000000000n), ctimeNsec: String(staged.ctimeNs % 1000000000n) }
  beforeChild({ directory, stageFile, stageFD })
  try {
    const script = fileURLToPath(new URL('../core/project-recovery-journal.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, root, '3', String(stat.dev), String(stat.ino), '4', '5', name, JSON.stringify(snapshot)], { input: encodeJournalPacket({ operation: 'transcriptDrafts', action: 'checkpoint', trustedDependencies: JOURNAL_DEPENDENCIES, ...metadata }, [JSON.stringify(body)]), stdio: ['pipe', 'pipe', 'pipe', lockFD, draftFD, stageFD], timeout: 5000, maxBuffer: 1024 * 1024 })
    const packet = decodeJournalPacket(result.stdout)
    if (expectError) { assert.notEqual(result.status, 0); assert.equal(packet.metadata.ok, false); assert.match(packet.metadata.error, expectError); return packet.metadata }
    assert.equal(result.status, 0, result.stderr?.toString()); assert.equal(packet.metadata.ok, true)
    assert.equal(fs.existsSync(stageFile), false, 'The owned empty stage must be consumed or cleaned')
    return packet.metadata.result
  } finally { fs.closeSync(lockFD); fs.closeSync(draftFD); fs.closeSync(stageFD) }
}

function actualJournalFixture(t) {
  const f = fixture(t), root = fs.realpathSync(f.root), directory = path.join(root, '.reel/transcripts')
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(path.join(root, '.reel/recovery'), { recursive: true }); fs.mkdirSync(path.join(root, '.reel/transcript-drafts'), { mode: 0o700 })
  const stat = fs.statSync(path.join(root, 'media.wav'), { bigint: true }), key = createHash('sha1').update('media.wav|en-US').digest('hex').slice(0, 16)
  fs.writeFileSync(path.join(directory, `${key}.json`), JSON.stringify({ src: 'media.wav', locale: 'en-US', revision: 1, fingerprint: `v2|${stat.size}|${stat.mtimeNs / 1000000000n}|${stat.mtimeNs % 1000000000n}`, words, status: 'complete' }))
  const store = createTranscriptDraftStore({ root }), body = { src: 'media.wav', locale: 'en-US', basis: store.context('media.wav', 'en-US').basis, words, sessionID: randomUUID(), sequence: 1 }
  return { root, store, body }
}

test('actual private-stage journal child rejects a saved-capture operation and cleans its own empty stage', t => {
  const f = actualJournalFixture(t)
  runFixtureJournalChild(t, f.root, f.body, { metadata: { operation: 'capture' }, expectError: /only supports transcript draft actions/ })
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.reel/transcript-drafts')), [])
})
test('actual private-stage journal child rejects a changed stage mode and preserves a replacement name', t => {
  for (const replace of [false, true]) {
    const f = actualJournalFixture(t); let changed
    runFixtureJournalChild(t, f.root, f.body, { beforeChild({ stageFile }) { changed = stageFile; if (replace) { fs.renameSync(stageFile, `${stageFile}.owned`); fs.writeFileSync(stageFile, 'foreign replacement', { mode: 0o600 }) } else fs.chmodSync(stageFile, 0o644) }, expectError: /staging file changed/ })
    if (replace) assert.equal(fs.readFileSync(changed, 'utf8'), 'foreign replacement')
    else assert.equal(fs.existsSync(changed), false)
    assert.equal(f.store.context('media.wav', 'en-US').offers.length, 0)
  }
})
test('actual prepared-journal wrapper selects the private draft mode and supports checkpoint plus discard', t => {
  const f = actualJournalFixture(t), binary = path.join(f.root, 'fixture-helper'), script = fileURLToPath(new URL('../core/project-recovery-journal.mjs', import.meta.url))
  fs.writeFileSync(binary, 'fixture-only', { mode: 0o700 })
  const journal = fixtureJournal(binary, script)
  const receipt = journal(f.root, { operation: 'transcriptDrafts', action: 'checkpoint' }, [JSON.stringify(f.body)]).result
  assert.equal(f.store.context('media.wav', 'en-US').offers[0].id, receipt.id)
  journal(f.root, { operation: 'transcriptDrafts', action: 'discard' }, [JSON.stringify({ src: 'media.wav', locale: 'en-US', id: receipt.id })])
  assert.deepEqual(f.store.context('media.wav', 'en-US').offers, [])
  assert.ok(fs.readdirSync(path.join(f.root, '.reel/transcript-drafts')).every(name => name.endsWith('.json')))
})
test('discard refuses an exhausted session sequence before allocating or losing its last readable text', t => {
  const f = fixture(t), receipt = f.checkpoint(), file = path.join(f.root, '.reel/transcript-drafts', `${receipt.id}.json`)
  const value = JSON.parse(fs.readFileSync(file)); value.sequence = 1000000000; fs.writeFileSync(file, JSON.stringify(value)); const before = fs.readFileSync(file)
  assert.throws(() => f.store.discard(f.body(receipt.id)), /sequence limit/)
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(fs.readdirSync(path.dirname(file)), [`${receipt.id}.json`])
  assert.deepEqual(f.store.read(f.body(receipt.id)).words, words)
})
