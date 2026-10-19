// Routes that measure or read media asynchronously before committing must not overwrite
// an edit made in the meantime. Each fixture emulates /api/ops's expectedVersion check.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import audioRoutes from '../routes/audio.mjs'
import interchangeRoutes from '../routes/interchange.mjs'

function versionedContext(root, project) {
  const state = { project, version: 7, edits: [] }
  const ctx = {
    ROOT: root, DOT: path.join(root, '.reel'),
    getProject: () => state.project,
    getVersion: () => state.version,
    resolveMedia: rel => path.resolve(path.isAbsolute(rel) ? rel : path.join(root, rel)),
    editOps: async (ops, who, summary, options = {}) => {
      if (options.expectedVersion !== undefined && options.expectedVersion !== state.version) throw new Error('The project changed. Review the current version before applying these edits.')
      state.edits.push({ ops, who, summary, options }); state.version++
      return { version: state.version }
    },
  }
  return { state, ctx }
}

function loudnormFixture(t, onPass = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-loudnorm-guard-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = { tracks: [{ id: 'A1', clips: [{ id: 'a1', kind: 'audio', src: 'media/voice.wav', start: 0, dur: 2 }] }], comps: {} }
  const { state, ctx } = versionedContext(root, project)
  let passes = 0
  ctx.run = async (_tool, args) => {
    passes++; onPass(state, passes)
    const filter = args[args.indexOf('-af') + 1]
    if (filter.startsWith('ebur128')) return { stderr: 'Summary:\n  Integrated loudness:\n    I:         -20.0 LUFS\n' }
    return { stderr: '{\n"input_i" : "-20.1",\n"input_tp" : "-6.0",\n"input_lra" : "4.0",\n"input_thresh" : "-30.2",\n"target_offset" : "0.1",\n"output_i" : "-23.0",\n"output_tp" : "-9.0",\n"output_lra" : "4.0",\n"normalization_type" : "linear"\n}\n' }
  }
  return { state, routes: audioRoutes(ctx).routes, passes: () => passes }
}

test('loudnorm refuses a stale expectedVersion before measuring', async t => {
  const f = loudnormFixture(t)
  await assert.rejects(f.routes['POST /api/audio/loudnorm']({ src: 'media/voice.wav', id: 'a1', expectedVersion: 6 }), /project changed/)
  await assert.rejects(f.routes['POST /api/audio/loudnorm']({ src: 'media/voice.wav', id: 'a1', expectedVersion: -1 }), /nonnegative safe integer/)
  assert.equal(f.passes(), 0); assert.deepEqual(f.state.edits, [])
})

test('loudnorm keeps the true peak under the ceiling and reports the limit', async t => {
  const f = loudnormFixture(t)
  // The fixture measures -20 LUFS with peaks at -6 dBTP: -10 LUFS would need +10 dB, -1 dBTP allows +5.
  const result = await f.routes['POST /api/audio/loudnorm']({ src: 'media/voice.wav', id: 'a1', target: -10 })
  assert.deepEqual([result.gain, result.requestedGain, result.peakLimited, result.peakOver], [5, 10, true, 5])
  assert.deepEqual([result.output.i, result.output.tp], [-15, -1])
  assert.deepEqual(f.state.edits[0].ops, [{ op: 'update', id: 'a1', set: { volume: 5 } }])
})

test('loudnorm sets the gain on a clip that still plays the measured source', async t => {
  const f = loudnormFixture(t)
  const result = await f.routes['POST /api/audio/loudnorm']({ src: 'media/voice.wav', id: 'a1', expectedVersion: 7 })
  assert.equal(result.gain, -3)
  assert.equal(f.state.edits.length, 1)
  assert.deepEqual(f.state.edits[0].ops, [{ op: 'update', id: 'a1', set: { volume: -3 } }])
  assert.equal(f.state.edits[0].options.expectedVersion, 7)
})

test('loudnorm with a named version reports an edit made during measurement instead of overwriting it', async t => {
  const f = loudnormFixture(t, (state, pass) => { if (pass === 1) state.version++ })
  await assert.rejects(f.routes['POST /api/audio/loudnorm']({ src: 'media/voice.wav', id: 'a1', expectedVersion: 7 }), /project changed/)
  assert.deepEqual(f.state.edits, [])
})

test('loudnorm does not apply a measurement after the clip changed source', async t => {
  const f = loudnormFixture(t, (state, pass) => {
    if (pass === 1) { state.project = structuredClone(state.project); state.project.tracks[0].clips[0].src = 'media/other.wav'; state.version++ }
  })
  await assert.rejects(f.routes['POST /api/audio/loudnorm']({ src: 'media/voice.wav', id: 'a1' }), /no longer plays media\/voice\.wav/)
  assert.deepEqual(f.state.edits, [])
})

function importFixture(t, onProbe = () => {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-import-guard-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'media')); fs.writeFileSync(path.join(root, 'media/broll.mp4'), 'broll')
  fs.copyFileSync(new URL('./fixtures/resolve.otio', import.meta.url), path.join(root, 'cut.otio'))
  const { state, ctx } = versionedContext(root, { name: 'Current', tracks: [], assets: {}, comps: {} })
  ctx.probe = async key => { onProbe(state, key); return { hasVideo: true, hasAudio: false, duration: 4, width: 1920, height: 1080, fps: 30 } }
  return { state, routes: interchangeRoutes(ctx).routes }
}

test('timeline import replaces only the version it started from', async t => {
  const f = importFixture(t)
  const preview = await f.routes['POST /api/interchange/import']({ path: 'cut.otio' })
  assert.equal(preview.version, 7)
  const applied = await f.routes['POST /api/interchange/import']({ path: 'cut.otio', apply: true, expectedVersion: preview.version })
  assert.equal(applied.version, 8)
  assert.equal(f.state.edits.length, 1); assert.equal(f.state.edits[0].ops[0].op, 'replace'); assert.equal(f.state.edits[0].options.expectedVersion, 7)
})

test('timeline import reports an edit made while media was read instead of replacing it', async t => {
  const f = importFixture(t, state => { state.version++ })
  await assert.rejects(f.routes['POST /api/interchange/import']({ path: 'cut.otio', apply: true }), /project changed/)
  assert.deepEqual(f.state.edits, [])
})

test('timeline import refuses a stale or invalid preview version before reading media', async t => {
  let probes = 0
  const f = importFixture(t, () => { probes++ })
  await assert.rejects(f.routes['POST /api/interchange/import']({ path: 'cut.otio', apply: true, expectedVersion: 3 }), /Preview the import again/)
  await assert.rejects(f.routes['POST /api/interchange/import']({ path: 'cut.otio', apply: true, expectedVersion: 1.5 }), /nonnegative safe integer/)
  assert.equal(probes, 0); assert.deepEqual(f.state.edits, [])
})
