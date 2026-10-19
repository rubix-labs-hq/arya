import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { validateMusicScore, createMusicRenderer, musicMeasurement, musicPCM24, musicWAVHeader, musicBase64, musicPlacementOps, MUSIC_INSTRUMENTS } from '../core/music-score.js'
import { renderMusicWAV, discardMusicWAV } from '../music/render-score.mjs'
import musicRoutes from '../routes/music.mjs'
import vm from 'node:vm'
import { bundleMusic } from '../../native/scripts/bundle-music.mjs'
import { validateCall } from '../agent/protocol.mjs'

const { newProject, applyOps } = await import(process.env.ARYA_PROJECT_CORE ? pathToFileURL(process.env.ARYA_PROJECT_CORE) : new URL('../core/project.js', import.meta.url))
const exec = promisify(execFile)
const score = (overrides = {}) => ({ version: 1, title: 'Original cue', bpm: 120, lengthBeats: 2, seed: 17, room: 0, parts: [{ id: 'bass', instrument: 'bass', gainDb: -12, pan: 0, notes: [{ at: 0.5, duration: 0.5, pitch: 69, velocity: 0.7 }] }], ...overrides })
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arya-music-test-'))
const readPCM = (s, size = 4096) => {
  const r = createMusicRenderer(s), out = new Float32Array(r.frames * 2)
  let n = 0, chunk
  while ((chunk = r.renderChunk(size)).length) { out.set(chunk, n); n += chunk.length }
  return out
}
async function probeWAV(root, rel) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(root, rel)])
  const p = JSON.parse(stdout), a = p.streams.find(s => s.codec_type === 'audio')
  return { hasAudio: !!a, hasVideo: p.streams.some(s => s.codec_type === 'video'), channels: a?.channels, codec: a?.codec_name, duration: Number(p.format.duration), sampleRate: Number(a?.sample_rate), size: Number(p.format.size) }
}
function ctx(root, p = newProject('Music QA')) {
  let project = p, version = 7, generation = 2
  const past = [], future = []
  const c = { ROOT: root, getProject: () => project, getVersion: () => version, getProjectGeneration: () => generation, probe: rel => probeWAV(root, rel),
    callAPI: async (method, route, body) => {
      if (method === 'GET') return { project, version }
      assert.equal(route, '/api/ops')
      assert.equal(body.expectedVersion, version, 'stale publication must fail')
      const result = applyOps(project, body.ops)
      past.push(project); future.length = 0; project = result.project; version++
      fs.writeFileSync(path.join(root, 'reel.project.json'), JSON.stringify(project))
      return { version, created: result.created }
    },
    mutate: () => { project = applyOps(project, [{ op: 'project', set: { name: 'User changed project' } }]).project; version++ },
    replace: () => { project = newProject('Replacement project'); version++; generation++ },
    undo: () => { future.push(project); project = past.pop(); version++ },
    redo: () => { past.push(project); project = future.pop(); version++ },
    history: past,
  }
  return c
}

test('strict score bounds reject unknown/infinite/empty/zero-velocity or over-budget data', () => {
  for (const s of [score({ network: 'fetch' }), score({ bpm: NaN }), score({ lengthBeats: 200 }), score({ seed: 0.5 }), score({ parts: [] }), score({ title: '\0bad' }), score({ parts: [{ ...score().parts[0], notes: [{ at: 0, duration: 1, pitch: 69, velocity: 0 }] }] })]) assert.throws(() => validateMusicScore(s))
  const p = score().parts[0]
  assert.throws(() => validateMusicScore(score({ parts: [{ ...p, notes: [{ at: 1.5, duration: 1, pitch: 69 }] }] })), /fit/)
  assert.throws(() => validateMusicScore(score({ parts: [{ ...p, notes: Array.from({ length: 25 }, () => ({ at: 0, duration: 1, pitch: 60 })) }] })), /voices/)
  assert.throws(() => validateMusicScore(score({ parts: [{ ...p, notes: Array.from({ length: 1025 }, (_, i) => ({ at: i / 1025, duration: 0.025, pitch: 60 })) }] })), /1024/)
})

test('note starts, audible region and release end follow beat-to-sample timing', () => {
  const pcm = readPCM(score())
  assert.equal(pcm.length, 48000 * 2)
  assert.ok(pcm.slice(0, 12000 * 2).every(s => s === 0))
  assert.ok(pcm.slice(14000 * 2, 22000 * 2).some(s => Math.abs(s) > 0.01))
  assert.ok(pcm.slice(30000 * 2).every(s => s === 0))
  assert.equal(pcm.at(-1), 0)
  // Correlation recovers A4's 440 Hz fundamental near a 109-frame period.
  const corr = lag => { let sum = 0; for (let i = 15000; i < 22000; i++) sum += pcm[i * 2] * pcm[(i + lag) * 2]; return sum }
  const best = Array.from({ length: 15 }, (_, i) => i + 102).sort((a, b) => corr(b) - corr(a))[0]
  assert.ok(Math.abs(48000 / best - 440) < 5)
})

test('all offered instruments produce finite audible stereo PCM', () => {
  for (const instrument of MUSIC_INSTRUMENTS) {
    const s = score({ parts: [{ ...score().parts[0], instrument, notes: [{ at: 0, duration: 1, pitch: 60 }] }] })
    const pcm = readPCM(s), m = musicMeasurement(); m.add(pcm)
    assert.ok(Number.isFinite(m.result().rmsDb), instrument)
  }
})

test('rendered PCM is independent of chunk boundaries and seeded drums are deterministic', () => {
  const s = score({ room: 0.12, parts: [{ ...score().parts[0], instrument: 'snare' }] })
  assert.deepEqual(readPCM(s, 127), readPCM(s, 4096))
  assert.notDeepEqual(readPCM(s), readPCM({ ...s, seed: 18 }))
})

test('equal-power pan routes hard left without leaking to right when room is off', () => {
  const s = score({ parts: [{ ...score().parts[0], pan: -1 }] }), pcm = readPCM(s)
  assert.ok(pcm.some((v, i) => i % 2 === 0 && Math.abs(v) > 0.01))
  assert.ok(pcm.every((v, i) => i % 2 === 0 || v === 0))
})

test('peak attenuation never boosts and no clipped/nonfinite PCM can be encoded', () => {
  const m = musicMeasurement(); m.add(new Float32Array([2, -2, 0.1]))
  const r = m.result(); assert.equal(r.samplePeakDb, -3); assert.ok(r.gain < 1)
  assert.doesNotThrow(() => musicPCM24(new Float32Array([2, -2]), r.gain))
  assert.throws(() => musicPCM24(new Float32Array([1])))
  assert.throws(() => musicPCM24(new Float32Array([Infinity])))
  assert.throws(() => { const empty = musicMeasurement(); empty.add(new Float32Array(100)); empty.result() }, /inaudible/)
})

test('PCM24 sign and portable base64 match standard byte encoding', () => {
  const pcm = musicPCM24(new Float32Array([0, 0.5, -0.5]))
  const b = Buffer.from(pcm); assert.equal(b.readIntLE(0, 3), 0); assert.equal(b.readIntLE(3, 3), 4194304); assert.equal(b.readIntLE(6, 3), -4194303)
  for (let n = 0; n < 100; n++) { const bytes = Uint8Array.from({ length: n }, (_, i) => i * 17 % 256); assert.equal(musicBase64(bytes), Buffer.from(bytes).toString('base64')) }
  assert.equal(Buffer.from(musicWAVHeader(48000)).readUInt32LE(40), 288000)
})

test('standalone native bridge matches Node PCM24 bytes and rejects writing before measurement', async () => {
  const root = tmp()
  try {
    const src = fs.readFileSync(new URL('../core/music-score.js', import.meta.url), 'utf8')
    const context = vm.createContext({}), script = bundleMusic(src)
    vm.runInContext(script, context)
    const bridge = context.AryaMusic
    const meta = JSON.parse(bridge.startJSON(JSON.stringify(score())))
    assert.equal(meta.frames, 48000)
    assert.throws(() => bridge.nextPCMBase64(), /Measure/)
    while (!JSON.parse(bridge.measureNextJSON()).done) {}
    const bytes = [Buffer.from(bridge.headerBase64(), 'base64')]
    let b64
    while ((b64 = bridge.nextPCMBase64())) bytes.push(Buffer.from(b64, 'base64'))
    const r = await renderMusicWAV(root, score())
    assert.deepEqual(Buffer.concat(bytes), fs.readFileSync(r.absolutePath))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('real ffprobe validates exact duration, stereo 48 kHz PCM24 WAV and sample size', async () => {
  const root = tmp()
  try {
    const r = await renderMusicWAV(root, score()), a = await probeWAV(root, r.path)
    assert.deepEqual([a.channels, a.sampleRate, a.codec, a.duration, a.size], [2, 48000, 'pcm_s24le', 1, 288044])
    assert.ok(r.measurement.samplePeakDb <= -3)
    assert.ok(fs.existsSync(r.absolutePath))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('request rejects absent/wrong/locked track, overlap and bad expected version without edits', () => {
  const p = newProject('Untouched'), base = { score: score(), track: 'A3', start: 0, expectedVersion: 7 }, before = JSON.stringify(p)
  for (const b of [{ ...base, track: undefined }, { ...base, track: 'V1' }, { ...base, expectedVersion: undefined }, { ...base, start: -1 }, { ...base, output: '../../secret' }]) assert.throws(() => musicPlacementOps(p, b))
  p.tracks.find(t => t.id === 'A3').locked = true
  assert.throws(() => musicPlacementOps(p, base), /locked/)
  delete p.tracks.find(t => t.id === 'A3').locked
  p.tracks.find(t => t.id === 'A3').clips.push({ id: 'old', start: 0.5, dur: 1, kind: 'audio' })
  assert.throws(() => musicPlacementOps(p, base), /overlaps/)
  p.tracks.find(t => t.id === 'A3').clips.length = 0
  assert.equal(JSON.stringify(p), before)
})

test('compose probes before durable Media registration+placement; Undo placement retains reusable score', async () => {
  const root = tmp()
  try {
    const p = newProject('Preserve me'); p.assets['old.wav'] = { hasAudio: true, duration: 3 }
    p.tracks[3].clips.push({ id: 'voice', kind: 'audio', src: 'old.wav', start: 0, dur: 3 })
    const c = ctx(root, p), before = JSON.stringify(p), route = musicRoutes(c).routes['POST /api/audio/compose']
    const r = await route({ score: score(), track: 'A3', start: 1, expectedVersion: 7 })
    assert.equal(r.state, 'complete'); assert.equal(c.history.length, 2)
    assert.equal(c.getProject().tracks[5].clips.length, 1); assert.equal(c.getProject().tracks[5].clips[0].start, 1)
    assert.deepEqual(c.getProject().tracks.slice(0, 5), p.tracks.slice(0, 5))
    assert.deepEqual(c.getProject().assets['old.wav'], p.assets['old.wav'])
    const reopened = JSON.parse(fs.readFileSync(path.join(root, 'reel.project.json')))
    assert.deepEqual(reopened.assets[r.path].generated.score, validateMusicScore(score()))
    assert.equal(reopened.assets[r.path].generated.renderer, 'arya-score-synth/1')
    c.undo(); assert.equal(c.getProject().tracks[5].clips.length, 0); assert.ok(c.getProject().assets[r.path])
    assert.ok(fs.existsSync(path.join(root, r.path)), 'undo retains owned bytes for redo')
    c.redo(); assert.ok(c.getProject().assets[r.path]); assert.equal(c.getProject().tracks[5].clips[0].src, r.path)
    c.undo(); c.undo(); assert.equal(JSON.stringify(c.getProject()), before)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('placement failure retains completed asset in Media; retry uses identical file without regeneration', async () => {
  const root = tmp()
  try {
    const c = ctx(root), normal = c.callAPI
    let rejectPlacement = true
    c.callAPI = async (method, route, body) => {
      if (rejectPlacement && body?.ops?.some(o => o.op === 'add_clip')) throw new Error('Target changed before placement')
      return normal(method, route, body)
    }
    const routes = musicRoutes(c).routes, r = await routes['POST /api/audio/compose']({ score: score(), track: 'A3', start: 0, expectedVersion: 7 })
    assert.equal(r.state, 'asset_ready'); assert.equal(r.placement.state, 'failed')
    assert.ok(c.getProject().assets[r.path]); assert.equal(c.getProject().tracks[5].clips.length, 0)
    const bytes = fs.readFileSync(path.join(root, r.path)); rejectPlacement = false
    const placed = await routes['POST /api/audio/compose/place']({ path: r.path, track: 'A3', start: 2, expectedVersion: 8 })
    assert.equal(placed.state, 'complete'); assert.deepEqual(fs.readFileSync(path.join(root, r.path)), bytes)
    assert.equal(c.getProject().tracks[5].clips[0].start, 2); assert.equal(Object.keys(c.getProject().assets).length, 1)
    c.undo(); assert.ok(c.getProject().assets[r.path]); assert.equal(c.getProject().tracks[5].clips.length, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('retry accepts persisted native sorted-key score metadata and re-probes corrupt retained output', async () => {
  const root = tmp()
  try {
    const c = ctx(root), routes = musicRoutes(c).routes
    const result = await routes['POST /api/audio/compose']({ score: score(), track: 'A3', start: 0, expectedVersion: 7 })
    const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])])) : value
    c.getProject().assets[result.path].generated.score = sort(c.getProject().assets[result.path].generated.score)
    const receipt = await routes['POST /api/audio/compose/place']({ path: result.path, track: 'A2', start: 2, expectedVersion: 9 })
    assert.equal(receipt.state, 'complete'); assert.equal(c.getProject().tracks[4].clips[0].src, result.path)
    const before = JSON.stringify(c.getProject())
    fs.writeFileSync(path.join(root, result.path), 'Not valid audio')
    await assert.rejects(routes['POST /api/audio/compose/place']({ path: result.path, track: 'A2', start: 4, expectedVersion: 10 }))
    assert.equal(JSON.stringify(c.getProject()), before)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('nested composition placement never edits root or another comp', async () => {
  const root = tmp()
  try {
    const p = newProject('Root'); p.comps = { scene: { fps: 24, tracks: [{ id: 'A3', kind: 'audio', clips: [] }] }, other: { tracks: [] } }
    const c = ctx(root, p), r = await musicRoutes(c).routes['POST /api/audio/compose']({ score: score(), comp: 'scene', track: 'A3', start: 2, expectedVersion: 7 })
    assert.deepEqual(c.getProject().tracks, p.tracks); assert.deepEqual(c.getProject().comps.other, p.comps.other)
    assert.equal(c.getProject().comps.scene.tracks[0].clips[0].src, r.path)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('failed probe cannot create a Media entry, timeline edit or completed result', async () => {
  const root = tmp()
  try {
    const c = ctx(root), before = JSON.stringify(c.getProject()); c.probe = async () => ({ hasAudio: false })
    await assert.rejects(musicRoutes(c).routes['POST /api/audio/compose']({ score: score(), track: 'A3', start: 0, expectedVersion: 7 }), /probe/)
    assert.equal(JSON.stringify(c.getProject()), before); assert.equal(c.history.length, 0)
    assert.deepEqual(fs.readdirSync(path.join(root, 'media/generated/music')), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('ordinary edit during probe saves completed music in Media and requires reviewed placement', async () => {
  const root = tmp()
  try {
    const c = ctx(root), probes = [], normal = c.probe
    c.probe = async rel => { probes.push(rel); const a = await normal(rel); if (probes.length === 1) c.mutate(); return a }
    const routes = musicRoutes(c).routes; let result
    await assert.doesNotReject(async () => { result = await routes['POST /api/audio/compose']({ score: score(), track: 'A3', start: 0, expectedVersion: 7 }) }, 'An ordinary edit must retain the completed owned music')
    assert.equal(result.state, 'asset_ready'); assert.equal(result.placement.state, 'failed')
    assert.equal(c.getProject().name, 'User changed project'); assert.equal(c.history.length, 1); assert.equal(c.getVersion(), 9)
    assert.deepEqual(Object.keys(c.getProject().assets), [result.path]); assert.equal(c.getProject().tracks.find(t => t.id === 'A3').clips.length, 0)
    assert.deepEqual(c.getProject().assets[result.path].generated.score, validateMusicScore(score()))
    const file = path.join(root, result.path), bytes = fs.readFileSync(file), reopened = JSON.parse(fs.readFileSync(path.join(root, 'reel.project.json')))
    assert.equal(reopened.name, 'User changed project'); assert.deepEqual(reopened.assets[result.path], result.asset)
    assert.equal(bytes.length, result.asset.generated.contentBytes)
    assert.deepEqual(fs.readdirSync(path.join(root, 'media/generated/music')), [result.path.split('/')[3]])
    const placed = await routes['POST /api/audio/compose/place']({ path: result.path, track: 'A3', start: 2, expectedVersion: 9 })
    assert.equal(placed.state, 'complete'); assert.deepEqual(probes, [result.path, result.path])
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(Object.keys(c.getProject().assets).length, 1)
    c.undo(); assert.ok(c.getProject().assets[result.path]); assert.equal(c.getProject().name, 'User changed project')
    assert.equal(c.getProject().tracks.find(t => t.id === 'A3').clips.length, 0); assert.deepEqual(fs.readFileSync(file), bytes)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('project replacement during probe still discards only its unregistered owned music', async () => {
  const root = tmp()
  try {
    const c = ctx(root); c.probe = async rel => { const a = await probeWAV(root, rel); c.replace(); return a }
    await assert.rejects(musicRoutes(c).routes['POST /api/audio/compose']({ score: score(), track: 'A3', start: 0, expectedVersion: 7 }), /project changed|original project was replaced/i)
    assert.equal(c.getProject().name, 'Replacement project'); assert.deepEqual(c.getProject().assets, {}); assert.equal(c.history.length, 0)
    assert.deepEqual(fs.readdirSync(path.join(root, 'media/generated/music')), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('cancellation during second pass leaves no partial/final audio or unrelated changes', async () => {
  const root = tmp(), abort = new AbortController()
  try {
    fs.writeFileSync(path.join(root, 'original.txt'), 'keep')
    await assert.rejects(renderMusicWAV(root, score(), { signal: abort.signal, onProgress: p => { if (p > 0.55) abort.abort(new Error('stop')) } }), /stop/)
    assert.deepEqual(fs.readdirSync(path.join(root, 'media/generated/music')), [])
    assert.equal(fs.readFileSync(path.join(root, 'original.txt'), 'utf8'), 'keep')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('symlinked destination is rejected; repeated compositions get unique paths', async () => {
  const root = tmp(), outside = tmp()
  try {
    fs.symlinkSync(outside, path.join(root, 'media'))
    await assert.rejects(renderMusicWAV(root, score()), /symbolic/); assert.deepEqual(fs.readdirSync(outside), [])
    fs.unlinkSync(path.join(root, 'media'))
    const a = await renderMusicWAV(root, score()), b = await renderMusicWAV(root, score())
    assert.notEqual(a.path, b.path); assert.deepEqual(fs.readFileSync(a.absolutePath), fs.readFileSync(b.absolutePath))
    discardMusicWAV(root, a, () => true); assert.ok(fs.existsSync(a.absolutePath), 'registered assets never removed')
    discardMusicWAV(root, a); assert.ok(!fs.existsSync(a.absolutePath)); assert.ok(fs.existsSync(b.absolutePath))
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) }
})


test('agent allowlist admits only intended music methods and leaves account/file routes closed', () => {
  for (const [method, path] of [['GET', '/api/audio/compose/capabilities'], ['POST', '/api/audio/compose'], ['POST', '/api/audio/compose/place']]) {
    assert.deepEqual(validateCall('reel_api', { method, path, ...(method === 'POST' ? { body: {} } : {}) }), { method, path, ...(method === 'POST' ? { body: {} } : {}) })
  }
  for (const [method, path] of [['POST', '/api/audio/compose/capabilities'], ['GET', '/api/audio/compose'], ['POST', '/api/assistant/config'], ['POST', '/api/reveal'], ['POST', 'https://music.example/api/audio/compose'], ['POST', '/api/audio/../compose'], ['POST', '/api/audio/compose%2fplace']]) {
    assert.throws(() => validateCall('reel_api', { method, path, body: {} }))
  }
})
