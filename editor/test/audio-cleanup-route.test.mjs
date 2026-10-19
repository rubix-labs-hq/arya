import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import audioRoutes, { cleanFilter } from '../routes/audio.mjs'
import { cleanSettings } from '../core/audio-cleanup.js'
import { applyOps, newProject } from '../core/project.js'
import { createToolOutcomes, recordToolOutcome, unresolvedToolOutcome } from '../agent/tool-outcomes.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-cleanup-plan-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const calls = [], keys = [], edits = []
  const source = path.join(root, 'source.wav'); fs.writeFileSync(source, 'original source')
  const past = [], future = []
  let generation = 1
  let project = { ...newProject('Fixture'), tracks: [{ id: 'A1', kind: 'audio', clips: [{ id: 'c1', kind: 'audio', src: 'source.wav', start: 0, dur: 4, volume: -6 }] }], assets: { 'source.wav': { duration: 8, hasAudio: true } } }, version = 1
  const ctx = { ROOT: root, resolveMedia: () => source, getProject: () => project, getVersion: () => version, getProjectGeneration: () => generation,
    cacheKey: async (...parts) => { keys.push(parts); return createHash('sha256').update(JSON.stringify(parts)).digest('hex') },
    once: async (_key, work) => work(), pushActivity: () => {}, editOps: async (...args) => { edits.push(args); assert.equal(args[3].expectedVersion, version); past.push(project); future.length = 0; project = applyOps(project, args[0]).project; return { version: ++version } },
    probe: async () => ({ duration: 8, hasAudio: true, hasVideo: false }),
    run: async (command, args) => { calls.push({ command, args }); if (args.includes('pcm_s24le')) fs.writeFileSync(args.at(-1), 'controlled output'); return { stdout: 'RMS_level=-62.6' } } }
  return { clean: audioRoutes(ctx).routes['POST /api/audio/clean'], root, calls, keys, edits, source, ctx,
    project: () => project, version: () => version,
    external: ops => { project = applyOps(project, ops).project; version++; if (ops.some(op => op.op === 'replace')) generation++ },
    undo: () => { future.push(project); project = past.pop(); version++ },
    redo: () => { past.push(project); project = future.pop(); version++ } }
}

test('actual route consumes all manual settings, primes known noise, and stores an editable recipe', async t => {
  const f = fixture(t), options = { strength: 0.4, detail: 0.9, quality: 'high', noiseFrom: 3, noiseTo: 3.5 }
  const result = await f.clean({ src: 'source.wav', mode: 'denoise', id: 'c1', ...options })
  const analysis = f.calls[0].args
  assert.deepEqual(analysis.slice(analysis.indexOf('-ss'), analysis.indexOf('-ss') + 4), ['-ss', '3', '-t', '0.5'])
  const encode = f.calls.find(c => c.args.includes('pcm_s24le')).args
  assert.match(encode[encode.indexOf('-filter_complex') + 1], /afftdn=nr=12:nf=-43:gs=6/)
  assert.equal(result.engine, 'ffmpeg-afftdn-cpu')
  assert.deepEqual(result.settings, options)
  assert.equal(result.recipe.source, 'source.wav')
  assert.deepEqual(f.edits[1][0][1].set.audioCleanup, result.recipe)
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'original source')
})

test('actual route caches identical options and creates distinct output for changed manual settings', async t => {
  const f = fixture(t), input = { src: 'source.wav', strength: 0.25 }
  const first = await f.clean(input), same = await f.clean(input), other = await f.clean({ ...input, strength: 0.8 })
  assert.equal(first.cached, false); assert.equal(same.cached, true)
  assert.equal(same.path, first.path); assert.notEqual(other.path, first.path)
  assert.equal(f.calls.filter(c => c.args.includes('pcm_s24le')).length, 2)
  assert.match(f.keys[0].at(-1), /"strength":0.25/)
})

test('actual route rejects invalid options and out-of-source noise before subprocess planning', async t => {
  const f = fixture(t)
  for (const options of [{ strength: '0.7' }, { detail: Infinity }, { noiseFrom: 3 }, { noiseFrom: 7.95, noiseTo: 8.5 }, { noiseFrom: 2, noiseTo: 2.02 }]) await assert.rejects(() => f.clean({ src: 'source.wav', ...options }))
  assert.equal(f.calls.length, 0); assert.equal(f.edits.length, 0)
})

test('zero strength skips noise analysis and does not send profile commands', async t => {
  const f = fixture(t)
  const result = await f.clean({ src: 'source.wav', strength: 0, noiseFrom: 1, noiseTo: 1.5 })
  assert.equal(f.calls.length, 1)
  const args = f.calls[0].args
  assert.equal(args[args.indexOf('-af') + 1], 'anull')
  assert.equal(args.includes('-filter_complex'), false)
  assert.equal(result.settings.strength, 0)
  assert.equal(result.noiseFloor, undefined)
})

test('the shared request parser accepts only finite numeric settings and complete noise ranges', () => {
  for (const options of [{ strength: true }, { detail: '0.5' }, { quality: '' }, { noiseFrom: 0, noiseTo: null }]) assert.throws(() => cleanSettings(options))
  assert.deepEqual(cleanSettings({ strength: 0, detail: 1, quality: 'fast' }), { strength: 0, detail: 1, quality: 'fast' })
})

function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(done => setImmediate(done))
const selected = p => p.tracks[0].clips[0]

test('no-target output is admitted with persistent CPU source and settings provenance', async t => {
  const f = fixture(t), before = structuredClone(f.project())
  const r = await f.clean({ src: 'source.wav', strength: 0, expectedVersion: 1 })
  assert.equal(r.assetRegistered, true); assert.equal(r.applied, undefined); assert.equal(r.placementRequested, false); assert.equal(r.admissionVersion, 2)
  assert.deepEqual(f.project().tracks, before.tracks)
  assert.deepEqual(f.project().assets[r.path].processing, { kind: 'audio-cleanup', ...r.recipe, compute: 'cpu', sourceStamp: r.asset.processing.sourceStamp })
  assert.equal(r.asset.processing.source, 'source.wav'); assert.equal(r.asset.processing.engine, 'ffmpeg-afftdn-cpu')
  assert.equal(f.edits.length, 1); assert.equal(f.edits[0][0][0].op, 'import')
})

test('targeted placement and admission have separate Undo and Redo entries', async t => {
  const f = fixture(t), before = structuredClone(f.project())
  const r = await f.clean({ src: 'source.wav', id: 'c1', comp: null, strength: 0, expectedVersion: 1 })
  assert.equal(r.assetRegistered, true); assert.equal(r.applied, true)
  assert.deepEqual([r.admissionVersion, r.version], [2, 3])
  assert.deepEqual(f.edits.map(edit => edit[0].map(op => op.op)), [['import'], ['update', 'update']])
  f.undo(); assert.equal(selected(f.project()).src, 'source.wav'); assert.ok(f.project().assets[r.path])
  f.undo(); assert.deepEqual(f.project(), before)
  f.redo(); assert.ok(f.project().assets[r.path]); assert.equal(selected(f.project()).src, 'source.wav')
  f.redo(); assert.equal(selected(f.project()).src, r.path)
})

test('apply false with a target admits Media without changing that target', async t => {
  const f = fixture(t), before = structuredClone(f.project().tracks)
  const r = await f.clean({ src: 'source.wav', id: 'c1', comp: null, apply: false, strength: 0 })
  assert.equal(r.assetRegistered, true); assert.equal(r.applied, undefined); assert.equal(r.placementRequested, false)
  assert.deepEqual(f.project().tracks, before); assert.ok(f.project().assets[r.path])
})

test('cached Media admission deduplicates and preserves unrelated asset annotations', async t => {
  const f = fixture(t), r = await f.clean({ src: 'source.wav', strength: 0 })
  const asset = { ...f.project().assets[r.path], name: 'Named cleanup', notes: { owner: 'fixture' } }
  f.external([{ op: 'import', assets: { [r.path]: asset } }]); const version = f.version(), edits = f.edits.length
  const repeat = await f.clean({ src: 'source.wav', strength: 0, expectedVersion: version })
  assert.equal(repeat.cached, true); assert.equal(repeat.admissionVersion, version)
  assert.equal(f.edits.length, edits); assert.equal(repeat.asset.name, 'Named cleanup'); assert.deepEqual(repeat.asset.notes, { owner: 'fixture' })
})

for (const change of ['clip', 'ordinary project']) test(`completed output admits at latest version after ${change} drift and refuses stale placement`, async t => {
  const f = fixture(t), gate = deferred(); f.ctx.probe = async src => src === 'source.wav' ? { duration: 8, hasAudio: true } : gate.promise
  // The route captures probe from context construction; recreate it with this controlled gate.
  const clean = audioRoutes(f.ctx).routes['POST /api/audio/clean']
  const work = clean({ src: 'source.wav', id: 'c1', comp: null, strength: 0, expectedVersion: 1 })
  await tick(); f.external(change === 'clip' ? [{ op: 'update', id: 'c1', comp: null, set: { volume: 8 } }] : [{ op: 'project', set: { name: 'Edited' } }])
  const tracks = structuredClone(f.project().tracks); gate.resolve({ duration: 8, hasAudio: true })
  const r = await work
  assert.equal(r.assetRegistered, true); assert.equal(r.admissionVersion, 3); assert.equal(r.applied, false); assert.match(r.applyError, /target changed/)
  assert.deepEqual(f.project().tracks, tracks); assert.ok(f.project().assets[r.path])
})

test('replacement project refuses Media admission even when its bytes match the old project', async t => {
  const f = fixture(t), gate = deferred(); f.ctx.probe = async src => src === 'source.wav' ? { duration: 8, hasAudio: true } : gate.promise
  const work = audioRoutes(f.ctx).routes['POST /api/audio/clean']({ src: 'source.wav', strength: 0 })
  await tick(); f.external([{ op: 'replace', project: structuredClone(f.project()) }]); const after = structuredClone(f.project())
  gate.resolve({ duration: 8, hasAudio: true }); const r = await work
  assert.equal(r.assetRegistered, false); assert.match(r.registrationError, /project was replaced/)
  assert.deepEqual(f.project(), after); assert.equal(f.edits.length, 0)
})

test('changed decode input refuses output admission while probe is suspended', async t => {
  const f = fixture(t), gate = deferred(); f.ctx.probe = async src => src === 'source.wav' ? { duration: 8, hasAudio: true } : gate.promise
  const work = audioRoutes(f.ctx).routes['POST /api/audio/clean']({ src: 'source.wav', strength: 0 })
  await tick(); fs.appendFileSync(f.source, ' replacement'); gate.resolve({ duration: 8, hasAudio: true })
  const r = await work
  assert.equal(r.assetRegistered, false); assert.match(r.registrationError, /input source changed/); assert.equal(f.edits.length, 0)
})

for (const stage of ['registration', 'placement']) test(`${stage} publication refusal returns an honest reusable output receipt`, async t => {
  const f = fixture(t), publish = f.ctx.editOps; let calls = 0
  f.ctx.editOps = async (...args) => { calls++; if (calls === (stage === 'registration' ? 1 : 2)) throw Error('fixture publication refused'); return publish(...args) }
  const r = await audioRoutes(f.ctx).routes['POST /api/audio/clean']({ src: 'source.wav', id: 'c1', comp: null, strength: 0 })
  assert.equal(r.applied, false); assert.equal(selected(f.project()).src, 'source.wav')
  assert.equal(r.assetRegistered, stage === 'placement')
  assert.match(r[stage === 'registration' ? 'registrationError' : 'applyError'], /publication refused/)
  assert.equal(!!f.project().assets[r.path], stage === 'placement')
})

test('target capture scopes reused IDs and refuses ambiguous requests', async t => {
  const f = fixture(t), project = structuredClone(f.project())
  project.comps = { nested: { width: 320, height: 180, fps: 30, tracks: structuredClone(project.tracks) } }
  f.external([{ op: 'replace', project }])
  await assert.rejects(f.clean({ src: 'source.wav', id: 'c1', strength: 0 }), /ambiguous/)
  const r = await f.clean({ src: 'source.wav', id: 'c1', comp: 'nested', strength: 0, expectedVersion: 2 })
  assert.equal(r.applied, true); assert.equal(selected(f.project()).src, 'source.wav'); assert.equal(f.project().comps.nested.tracks[0].clips[0].src, r.path)
})

test('stale versions and invalid apply types reject before processing or admission', async t => {
  const f = fixture(t)
  for (const extra of [{ expectedVersion: 0 }, { expectedVersion: '1' }, { expectedVersion: true }, { expectedVersion: -1 }, { apply: 0 }, { comp: false }]) await assert.rejects(f.clean({ src: 'source.wav', ...extra }))
  assert.equal(f.calls.length, 0); assert.equal(f.edits.length, 0)
})


test('same-length source replacement with restored mtime cannot reuse the old stamped cache output', async t => {
  const f = fixture(t), stat = fs.statSync(f.source), first = await f.clean({ src: 'source.wav', strength: 0 })
  fs.writeFileSync(f.source, 'changed! source'); assert.equal(fs.statSync(f.source).size, stat.size)
  fs.utimesSync(f.source, stat.atime, stat.mtime)
  const next = await f.clean({ src: 'source.wav', strength: 0 })
  assert.notEqual(next.path, first.path); assert.notEqual(next.asset.processing.sourceStamp, first.asset.processing.sourceStamp)
  assert.equal(next.cached, false); assert.ok(f.project().assets[first.path]); assert.ok(f.project().assets[next.path])
})


test('actual cleanup receipts classify intentional source-only success and requested placement failure', async t => {
  for (const body of [{ src: 'source.wav', strength: 0 }, { src: 'source.wav', id: 'c1', apply: false, strength: 0 }]) {
    const f = fixture(t), receipt = await f.clean(body), outcomes = createToolOutcomes()
    recordToolOutcome(outcomes, { method: 'POST', path: '/api/audio/clean', body }, receipt)
    assert.equal(receipt.assetRegistered, true); assert.equal(receipt.placementRequested, false)
    assert.equal(Object.hasOwn(receipt, 'applied'), false); assert.equal(unresolvedToolOutcome(outcomes), null)
  }
  const failed = fixture(t); failed.ctx.editOps = async () => { throw new Error('Controlled import failure') }
  const failedBody = { src: 'source.wav', strength: 0 }, unregistered = await audioRoutes(failed.ctx).routes['POST /api/audio/clean'](failedBody), failedOutcomes = createToolOutcomes()
  recordToolOutcome(failedOutcomes, { method: 'POST', path: '/api/audio/clean', body: failedBody }, unregistered)
  assert.equal(unregistered.assetRegistered, false); assert.equal(unregistered.placementRequested, false)
  assert.equal(unregistered.applied, false); assert.match(unregistered.registrationError, /Controlled import failure/)
  assert.match(unresolvedToolOutcome(failedOutcomes), /processing result was not applied/)
  const f = fixture(t), gate = deferred(); f.ctx.probe = async src => src === 'source.wav' ? { duration: 8, hasAudio: true } : gate.promise
  const body = { src: 'source.wav', id: 'c1', strength: 0 }, pending = audioRoutes(f.ctx).routes['POST /api/audio/clean'](body)
  await tick(); f.external([{ op: 'update', id: 'c1', set: { volume: -12 } }]); gate.resolve({ duration: 8, hasAudio: true })
  const receipt = await pending, outcomes = createToolOutcomes()
  recordToolOutcome(outcomes, { method: 'POST', path: '/api/audio/clean', body }, receipt)
  assert.equal(receipt.assetRegistered, true); assert.equal(receipt.placementRequested, true); assert.equal(receipt.applied, false)
  assert.match(unresolvedToolOutcome(outcomes), /saved in Media.*requested edit was not applied/)
})


for (const measured of [{ duration: 8, hasAudio: false }, { duration: 0, hasAudio: true }, { duration: -1, hasAudio: true }, { duration: NaN, hasAudio: true }, { duration: Infinity, hasAudio: true }, { duration: '8', hasAudio: true }, { duration: true, hasAudio: true }, { duration: 8, hasAudio: 1 }]) test(`invalid cleaned-output probe refuses persistent admission: ${JSON.stringify(measured)}`, async t => {
  const f = fixture(t), existing = await f.clean({ src: 'source.wav', strength: 0 })
  // A cached output must pass the same fresh probe admission as a new output.
  f.undo(); const before = structuredClone(f.project()), version = f.version()
  f.ctx.probe = async src => src === 'source.wav' ? { duration: 8, hasAudio: true } : measured
  await assert.rejects(() => audioRoutes(f.ctx).routes['POST /api/audio/clean']({ src: 'source.wav', strength: 0, expectedVersion: version }), /no valid audio duration/)
  assert.deepEqual(f.project(), before); assert.equal(f.version(), version)
  assert.equal(f.project().assets[existing.path], undefined)
})


for (const outputDuration of [0.1, 9]) for (const cached of [false, true]) test(`full-source output admission refuses positive ${outputDuration}s duration, cached=${cached}`, async t => {
  const f = fixture(t)
  if (cached) { await f.clean({ src: 'source.wav', strength: 0 }); f.undo() }
  const before = structuredClone(f.project()), version = f.version()
  f.ctx.probe = async src => ({ duration: src === 'source.wav' ? 8 : outputDuration, hasAudio: true })
  await assert.rejects(() => audioRoutes(f.ctx).routes['POST /api/audio/clean']({ src: 'source.wav', id: 'c1', comp: null, strength: 0, expectedVersion: version }), /duration does not match the complete source/)
  assert.deepEqual(f.project(), before); assert.equal(f.version(), version); assert.equal(selected(f.project()).src, 'source.wav')
})

test('full-source duration admission uses a fresh input probe and explicit PCM conversion tolerance', async t => {
  const f = fixture(t), sources = []
  f.ctx.probe = async src => { sources.push(src); return { duration: src === 'source.wav' ? 8 : 8.02, hasAudio: true } }
  const result = await audioRoutes(f.ctx).routes['POST /api/audio/clean']({ src: 'source.wav', id: 'c1', strength: 0 })
  assert.deepEqual(sources, ['source.wav', result.path]); assert.equal(result.assetRegistered, true); assert.equal(result.applied, true)
})

test('invalid input probe refuses cleanup before subprocess planning or Media changes', async t => {
  const f = fixture(t), before = structuredClone(f.project())
  f.ctx.probe = async () => ({ duration: 0, hasAudio: true })
  await assert.rejects(() => audioRoutes(f.ctx).routes['POST /api/audio/clean']({ src: 'source.wav', strength: 0 }), /source has no valid audio duration/)
  assert.equal(f.calls.length, 0); assert.equal(f.edits.length, 0); assert.deepEqual(f.project(), before)
})


for (const timing of [{ name: 'leading offset', start: 2, end: 5 }, { name: 'early audio end', start: 0, end: 5 }, { name: 'no silence padding', start: 0, end: 8 }, { name: 'silent requested spans', start: 3, end: 4 }]) for (const profile of [false, true]) test(`video cleanup normalizes container PTS before cleanup/profile: ${timing.name}, profile=${profile}`, async t => {
  const f = fixture(t), before = structuredClone(f.project().tracks)
  f.ctx.probe = async src => ({ duration: 8, hasAudio: true, hasVideo: src === 'source.wav', audioStart: timing.start, audioEnd: timing.end })
  const clean = audioRoutes(f.ctx).routes['POST /api/audio/clean'], options = profile ? { strength: 0.4, noiseFrom: 0.5, noiseTo: 0.7 } : { strength: 0 }
  const result = await clean({ src: 'source.wav', ...options }), encode = f.calls.find(c => c.args.includes('pcm_s24le')).args
  assert.ok(encode.indexOf('-copyts') < encode.indexOf('-i')); assert.ok(encode.indexOf('-start_at_zero') < encode.indexOf('-i'))
  const graph = encode[encode.indexOf(profile ? '-filter_complex' : '-af') + 1]
  assert.match(graph, /aresample=48000:async=1:first_pts=0:min_hard_comp=0,apad,atrim=duration=8.000000,asetpts=PTS-STARTPTS/)
  assert.match(graph, /,apad,atrim=duration=8.000000(?:\[clean\])?$/)
  if (profile) {
    assert.ok(graph.indexOf('first_pts=0') < graph.indexOf('asplit=2'))
    assert.match(graph, /atrim=start=0.200000,asetpts=PTS-STARTPTS,apad,atrim=duration=8.000000\[clean\]$/)
    const analysis = f.calls[0].args, filter = analysis[analysis.indexOf('-af') + 1]
    assert.equal(analysis.includes('-ss'), false); assert.ok(analysis.includes('-copyts'))
    assert.ok(filter.indexOf('first_pts=0') < filter.indexOf('atrim=start=0.500000:end=0.700000'))
  }
  assert.equal(result.assetRegistered, true); assert.deepEqual(f.project().tracks, before)
  const repeat = await clean({ src: 'source.wav', ...options }); assert.equal(repeat.cached, true); assert.equal(repeat.path, result.path)
  assert.equal(f.keys[0][3], 5); assert.match(f.keys[0].at(-2), /container-origin-silence-padded/)
  // The supplied offsets label timing scenarios. These assertions execute command planning,
  // not FFmpeg or a decoded audio waveform.
})

test('video timestamp filter rejects invalid spans and never rewrites audio-only filters', () => {
  const options = cleanSettings({ strength: 0 })
  for (const duration of [0, -1, NaN, Infinity]) assert.throws(() => cleanFilter('denoise', -80, options, duration))
  assert.deepEqual(cleanFilter('denoise', -80, options), ['-af', 'anull'])
})
