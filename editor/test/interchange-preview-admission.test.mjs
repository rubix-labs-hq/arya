import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import interchangeRoutes from '../routes/interchange.mjs'
import { newProject } from '../core/project.js'
import { toOTIO } from '../core/interchange.js'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-import-preview-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let version = 7, writes = 0
  const project = newProject('Reviewed timeline')
  const ctx = { ROOT: root, getProject: () => project, getVersion: () => version,
    probe: async () => project.assets['media.mov'],
    editOps: async (_ops, _who, _note, options) => {
      assert.equal(options.expectedVersion, version, 'reject a concurrent project edit')
      writes++; return { version: ++version }
    } }
  const route = interchangeRoutes(ctx).routes['POST /api/interchange/import']
  const file = path.join(root, 'input.otio')
  fs.writeFileSync(file, JSON.stringify(toOTIO(project, root)))
  return { root, file, route, ctx, project, edit: () => version++, writes: () => writes }
}

test('preview includes a native-compatible SHA-256 receipt and a guarded apply succeeds', async t => {
  const f = fixture(t), preview = await f.route({ path: 'input.otio' })
  assert.equal(preview.sourceHash, createHash('sha256').update(fs.readFileSync(f.file, 'utf8')).digest('hex'))
  const result = await f.route({ path: 'input.otio', apply: true, expectedVersion: preview.version, expectedInputHash: preview.sourceHash })
  assert.equal(result.applied, true); assert.equal(f.writes(), 1)
})

test('a project edit after preview prevents replacement', async t => {
  const f = fixture(t), preview = await f.route({ path: 'input.otio' })
  f.edit()
  await assert.rejects(f.route({ path: 'input.otio', apply: true, expectedVersion: preview.version, expectedInputHash: preview.sourceHash }), /project changed/i)
  assert.equal(f.writes(), 0)
})

test('a changed interchange file prevents replacement', async t => {
  const f = fixture(t), preview = await f.route({ path: 'input.otio' })
  fs.appendFileSync(f.file, '\n')
  await assert.rejects(f.route({ path: 'input.otio', apply: true, expectedVersion: preview.version, expectedInputHash: preview.sourceHash }), /input changed/i)
  assert.equal(f.writes(), 0)
})

test('input is revalidated after asynchronous media probing, including legacy unguarded callers', async t => {
  const f = fixture(t)
  f.project.assets['media.mov'] = { duration: 1, width: 100, height: 100, fps: 30, hasVideo: true }
  f.project.tracks[0].clips.push({ id: 'c1', src: 'media.mov', start: 0, in: 0, dur: 1 })
  fs.writeFileSync(path.join(f.root, 'media.mov'), '')
  fs.writeFileSync(f.file, JSON.stringify(toOTIO(f.project, f.root)))
  f.ctx.probe = async () => { fs.appendFileSync(f.file, '\n'); return f.project.assets['media.mov'] }
  await assert.rejects(f.route({ path: 'input.otio', apply: true }), /input changed/i)
  assert.equal(f.writes(), 0)
})

for (const value of [null, 42, '', 'bad']) test(`invalid expected input hash ${JSON.stringify(value)} cannot bypass admission`, async t => {
  const f = fixture(t)
  await assert.rejects(f.route({ path: 'input.otio', apply: true, expectedInputHash: value }), /input changed/i)
  assert.equal(f.writes(), 0)
})

test('caption previews use the same receipt and optional API callers remain supported', async t => {
  const f = fixture(t), file = path.join(f.root, 'captions.srt')
  fs.writeFileSync(file, '1\n00:00:00,000 --> 00:00:01,000\nReviewed\n')
  const preview = await f.route({ path: 'captions.srt' })
  assert.equal(typeof preview.sourceHash, 'string')
  fs.appendFileSync(file, '\n')
  await assert.rejects(f.route({ path: 'captions.srt', apply: true, expectedInputHash: preview.sourceHash }), /input changed/i)
  await f.route({ path: 'captions.srt', apply: true })
  assert.equal(f.writes(), 1)
})
