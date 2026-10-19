import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTranscriptRoutes } from '../routes/transcript.mjs'
import { applyOps, newProject } from '../core/project.js'

const words = [{ t: .2, end: .7, text: 'Saved' }, { t: .8, end: 1.4, text: 'sentence.' }]
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya caption preview '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'synthetic.wav'); fs.writeFileSync(file, 'synthetic-no-codec')
  let project = newProject('Caption preview'); project.assets['synthetic.wav'] = { duration: 3, hasAudio: true }
  project = applyOps(project, [{ op: 'add_clip', src: 'synthetic.wav', dur: 3, start: 0 }]).project
  let version = 1, calls = 0, onGet = null
  const routes = createTranscriptRoutes({ root, getProject: () => { onGet?.(); return project }, getVersion: () => version, resolveMedia: src => path.join(root, src), findWhisper: async () => { throw new Error('Unexpected recognition') }, process: async () => { throw new Error('Unexpected codec') }, apply: ops => { project = applyOps(project, ops).project; calls++; version++; return { project, version } } })
  const save = value => routes.save({ src: 'synthetic.wav', words: value, revision: routes.get({}, new URLSearchParams({ src: 'synthetic.wav' })).revision })
  const record = save(words)
  const body = { src: 'synthetic.wav', words: record.words, style: 'karaoke', comp: null, expectedVersion: version, expectedSourceFingerprint: record.fingerprint, expectedTranscriptRevision: record.revision }
  return { root, file, routes, save, body, project: () => project, calls: () => calls, changeVersion: () => version++, inject: fn => { onGet = fn } }
}

test('guarded caption previews bind saved revision and source, then apply one editable caption edit', async t => {
  const f = fixture(t), before = JSON.stringify(f.project())
  const preview = await f.routes.captions(f.body)
  assert.equal(preview.sourceFingerprint, f.body.expectedSourceFingerprint)
  assert.equal(preview.transcriptRevision, f.body.expectedTranscriptRevision)
  assert.equal(preview.version, 1); assert.equal(f.calls(), 0)
  assert.equal(JSON.stringify(f.project()), before)
  const applied = await f.routes.captions({ ...f.body, apply: true })
  assert.equal(f.calls(), 1); assert.equal(applied.version, 2)
  assert.ok(f.project().tracks.find(track => track.kind === 'caption').clips[0].words.length)
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'synthetic-no-codec')
})

test('caption apply rejects a saved correction made after preview', async t => {
  const f = fixture(t); await f.routes.captions(f.body)
  f.save(words.map((word, i) => i === 0 ? { ...word, text: 'Revised' } : word))
  await assert.rejects(f.routes.captions({ ...f.body, apply: true }), /transcript changed/)
  assert.equal(f.calls(), 0)
})

test('caption apply rejects a replaced source after preview', async t => {
  const f = fixture(t); await f.routes.captions(f.body)
  fs.appendFileSync(f.file, '-replaced')
  await assert.rejects(f.routes.captions({ ...f.body, apply: true }), /source changed/)
  assert.equal(f.calls(), 0)
})

test('guarded captions reject unsaved word injection even with the saved revision', async t => {
  const f = fixture(t)
  await assert.rejects(f.routes.captions({ ...f.body, words: [{ ...words[0], text: 'Unsaved' }, words[1]] }), /reviewed transcript words changed/)
  assert.equal(f.calls(), 0)
})

test('guarded captions reject project edits between preview and apply', async t => {
  const f = fixture(t); await f.routes.captions(f.body); f.changeVersion()
  await assert.rejects(f.routes.captions({ ...f.body, apply: true }), /project changed/)
  assert.equal(f.calls(), 0)
})

test('unguarded caption API callers retain explicit word preview and apply compatibility', async t => {
  const f = fixture(t)
  const preview = await f.routes.captions({ src: 'synthetic.wav', words: [{ t: .5, end: 1, text: 'External caption' }], style: 'word' })
  assert.equal(preview.items[0].text, 'External caption')
  assert.equal(preview.transcriptRevision, undefined)
  await f.routes.captions({ src: 'synthetic.wav', words: [{ t: .5, end: 1, text: 'External caption' }], style: 'word', apply: true })
  assert.equal(f.calls(), 1)
})

for (const change of ['source', 'project']) test(`caption grouping rechecks a ${change} change before guarded apply`, async t => {
  const f = fixture(t); let reads = 0
  f.inject(() => { if (++reads !== 2) return; if (change === 'source') fs.appendFileSync(f.file, '-changed-during-preview'); else f.changeVersion() })
  await assert.rejects(f.routes.captions({ ...f.body, apply: true }), /changed/)
  assert.equal(f.calls(), 0)
})
