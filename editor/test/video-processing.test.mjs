import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyOps, compView, newProject, valueAt } from '../core/project.js'
import { captureMatches, createProcessingRuns, processingBody, processingCapture, denoiseSource, restoreDenoiseOps, reframeOps, sourceKey, trackedReframe } from '../web/ui/processing-workflows.js'
import videoRoutes, { denoiseFilter } from '../routes/video-processing.mjs'

function fixture() {
  const project = newProject('video', { width: 100, height: 200, fps: 2 })
  const clip = { id: 'c1', kind: 'video', src: 'media/source.mov', in: 1, start: 0, dur: 2, speed: 2, x: 20, y: 50, scale: 2, anim: { x: [[0, 10], [1, 20]] }, expr: { y: 'value+30' } }
  project.assets[clip.src] = { hasVideo: true, duration: 10, width: 400, height: 200, fps: 24 }
  project.tracks[0].clips = [structuredClone(clip)]
  project.comps = { portrait: { id: 'portrait', name: 'Portrait', width: 100, height: 200, fps: 2, tracks: [{ id: 'V1', kind: 'video', clips: [clip] }] } }
  const s = { project, root: '/project', version: 4, openComp: 'portrait', selection: ['c1'] }, p = compView(project, 'portrait')
  return { s, p, clip, capture: processingCapture(s, p, clip) }
}

test('processing body captures nested source range, version and source frame rate', () => {
  const f = fixture(), b = processingBody(f.capture, { strength: 0.2, apply: true })
  assert.equal(b.comp, 'portrait'); assert.equal(b.in, 1); assert.equal(b.dur, 4); assert.equal(b.fps, 24); assert.equal(b.expectedVersion, 4)
  assert.equal(processingBody(f.capture, { fps: 2 }).fps, 2)
  for (const key of ['timeMap', 'freeze']) { const c = { ...f.clip, [key]: [] }; f.p.tracks[0].clips[0] = c; assert.throws(() => processingCapture(f.s, f.p, c), /constant positive/) }
})

test('capture rejects locks, replaced sources, composition navigation and selection drift', () => {
  for (const mutate of [f => f.s.openComp = null, f => f.s.selection = [], f => f.s.version++, f => f.s.project.assets[f.clip.src].duration = 1, f => f.p.tracks[0].locked = true]) {
    const f = fixture(); mutate(f); assert.equal(captureMatches(f.capture, f.s, f.p), false)
  }
})

test('local tracked reframe covers the canvas, removes obsolete animation and leaves main timeline intact', () => {
  const f = fixture(), track = { clipId: 'c1', reframeSourceKey: sourceKey(f.capture), results: { 0: { pts: [[0, 100]] }, 1: { pts: [[100, 100]] }, 2: { pts: [[300, 100]] }, 3: { pts: [[400, 100]] } } }
  const ops = trackedReframe(f.capture, track, 0), result = applyOps(f.s.project, ops), c = result.project.comps.portrait.tracks[0].clips[0]
  assert.deepEqual(result.project.tracks, f.s.project.tracks)
  assert.equal(c.fit, 'cover'); assert.equal(c.scale, 1); assert.equal(c.expr, undefined); assert.equal(c.anim.x.length, 4)
  assert.deepEqual(c.anim.x.map(k => k[1]), [200, 150, -50, -100])
  assert.deepEqual(c.anim.x.map(k => k[0]), [0, 0.5, 1, 1.5])
  const view = compView(result.project, 'portrait'); assert.equal(valueAt(view, c, 'y', 1), 100)
  assert.equal(f.s.project.comps.portrait.tracks[0].clips[0].fit, undefined, 'Original project is the undo state')
  delete track.results[2]; assert.throws(() => trackedReframe(f.capture, track), /every frame/)
})

test('reframe rejects animated axis transforms, parents, unbounded or unordered detector samples', () => {
  const f = fixture()
  for (const clip of [{ ...f.clip, parent: 'other' }, { ...f.clip, anim: { rotation: [[0, 0], [1, 10]] } }, { ...f.clip, expr: { anchorX: 'time' } }]) assert.throws(() => reframeOps({ ...f.capture, clip }, [{ t: 0, x: 1, y: 2 }]), /unparented/)
  assert.throws(() => reframeOps(f.capture, [{ t: 1, x: 1, y: 2 }, { t: 0, x: 1, y: 2 }]), /invalid timing/)
})

test('one admitted action handles Stop before job ID without publishing a late reframe', async () => {
  const f = fixture(), calls = [], edits = [], notes = []; let admit
  const api = (route, body) => { calls.push({ route, body }); if (route === '/start') return new Promise(resolve => admit = resolve); return Promise.resolve(route.includes('/wait') ? { id: 'late', state: 'done', result: { samples: [{ t: 0, x: 50, y: 100 }] } } : { ok: true }) }
  const a = createProcessingRuns({ api, current: () => f, edit: ops => { edits.push(ops); return {} }, notify: (...n) => notes.push(n) })
  const run = a.start(f.capture, 'reframe', '/start', {}, { applyReframe: true })
  assert.equal(a.start(f.capture, 'reframe', '/start', {}, { applyReframe: true }), run); assert.equal(calls.length, 1)
  await a.cancel(run); admit({ id: 'late', state: 'running' }); await run.promise
  assert.equal(calls.find(x => x.route.endsWith('/cancel')).body.id, 'late'); assert.equal(edits.length, 0); assert.equal(run.state, 'cancelled'); assert.equal(notes.length, 1)
})

test('late detector completion cannot apply to another version or selection', async () => {
  for (const mutate of [f => f.s.version++, f => f.s.selection = [], f => f.s.openComp = null]) {
    const f = fixture(); let admit; const edits = []
    const a = createProcessingRuns({ api: () => new Promise(resolve => admit = resolve), current: () => f, edit: ops => { edits.push(ops); return {} }, notify() {} })
    const run = a.start(f.capture, 'reframe', '/start', {}, { applyReframe: true }); mutate(f)
    admit({ samples: [{ t: 0, x: 50, y: 100 }] }); await run.promise
    assert.equal(edits.length, 0); assert.equal(run.state, 'failed')
  }
})

test('real detector samples become one scoped optimistic edit; done with applyError is a failure', async () => {
  const f = fixture(), edits = []
  const a = createProcessingRuns({ api: async () => ({ id: 'r', state: 'done', result: { samples: [{ t: 0, x: 50, y: 100 }, { t: 2, x: 20, y: 100 }] } }), current: () => f, edit: (ops, _summary, options) => { edits.push({ ops, options }); return { version: 5 } }, notify() {} })
  await a.start(f.capture, 'reframe', '/start', {}, { applyReframe: true }).promise
  assert.equal(edits.length, 1); assert.equal(edits[0].options.expectedVersion, 4); assert(edits[0].ops.every(op => op.comp === 'portrait'))
  const b = createProcessingRuns({ api: async () => ({ id: 'd', state: 'done', applied: false, applyError: 'source changed' }), current: () => f, edit() {}, notify() {} })
  const run = b.start(f.capture, 'denoise', '/start', {}); await run.promise; assert.equal(run.state, 'failed'); assert.equal(run.error, 'source changed')
})

test('zero strength bypasses ffmpeg defaults and malformed options are rejected', () => {
  assert.equal(denoiseFilter({ strength: 0 }).filter, 'null')
  assert.notEqual(denoiseFilter({ quality: 'fast' }).filter, denoiseFilter({ quality: 'high' }).filter)
  assert.throws(() => denoiseFilter({ sigma: Infinity })); assert.throws(() => denoiseFilter({ strength: '1' }))
})

async function serverFixture(t, { hold = false, pix = 'yuv420p', derived, streams, revising = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-video-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'media')); const file = path.join(root, 'media/source.mov'); fs.writeFileSync(file, 'original video bytes')
  const f = fixture()
  if (revising) {
    const c = f.s.project.comps.portrait.tracks[0].clips[0]
    c.src = 'media/previous.mp4'; c.in = 0.5
    c.noiseReduction = { src: 'media/source.mov', in: 1, dur: 5, output: c.src, settings: { strength: 0.2 } }
    f.s.project.assets[c.src] = { hasVideo: true, duration: 5, width: 400, height: 200, fps: 24 }
    f.clip = c; f.capture = processingCapture(f.s, f.p, c)
    fs.writeFileSync(path.join(root, c.src), 'previous processed bytes')
  }
  let project = f.s.project, version = f.s.version, finish, renderStarted
  const commands = [], edits = [], broadcasts = [], start = new Promise(resolve => renderStarted = resolve)
  const ctx = { ROOT: root, getProject: () => project, getVersion: () => version, getProjectGeneration: () => 1, resolveMedia: src => path.join(root, src), broadcast: (_event, job) => broadcasts.push(job),
    run: async (tool, args) => { commands.push({ tool, args }); return { stdout: tool === 'ffmpeg' ? ' TSC hqdn3d V->V' : JSON.stringify({ format: { duration: 10 }, streams: streams ?? [{ index: 0, codec_type: 'video', pix_fmt: pix }] }) } },
    videoRender: async (argv, signal, progress) => { commands.push({ tool: 'render', args: argv }); progress(1); renderStarted(); if (hold) await new Promise(resolve => { finish = resolve; signal.addEventListener('abort', resolve, { once: true }) }); if (signal.aborted) throw new Error('cancelled'); fs.writeFileSync(argv.at(-1), 'processed output') },
    probe: async () => derived ?? ({ hasVideo: true, duration: 4, width: 400, height: 200, fps: 24 }),
    callAPI: async (method, route, body) => {
      assert.equal(method, 'POST'); assert.equal(route, '/api/ops'); assert.equal(body.expectedVersion, version)
      project = applyOps(project, body.ops).project; edits.push(structuredClone(body)); version++; return { version }
    },
  }
  const routes = videoRoutes(ctx).routes, body = processingBody(f.capture, { apply: true, codec: 'auto' })
  return { root, file, routes, body, commands, edits, broadcasts, start, finish: () => finish(),
    drift: () => { project = applyOps(project, [{ op: 'project', set: { name: 'Ordinary edit during processing' } }]).project; version++ }, project: () => project }
}

test('actual denoise route publishes a retained copy and performs one scoped version-guarded edit', async t => {
  const f = await serverFixture(t), job = await f.routes['POST /api/video/denoise']({ ...f.body, wait: true })
  assert.equal(job.state, 'done'); assert.equal(job.applied, true); assert.equal(f.edits.length, 2)
  assert.deepEqual(f.edits.map(body => body.ops.map(op => op.op)), [['import'], ['update']])
  assert.deepEqual(f.edits.map(body => body.expectedVersion), [4, 5])
  assert.equal(f.edits[1].ops[0].comp, 'portrait'); assert.equal(f.edits[1].ops[0].id, 'c1')
  assert.equal(job.assetRegistered, true); assert.equal(job.admissionVersion, 5); assert.equal(job.version, 6)
  assert.deepEqual(JSON.parse(JSON.stringify(f.project().assets[job.output])).processing, {
    version: 1, kind: 'video-denoise', source: 'media/source.mov', range: { in: 1, dur: 4 }, output: job.output,
    engine: 'ffmpeg-hqdn3d', compute: 'cpu', settings: { quality: 'balanced', strength: 0.65, spatial: 0.5, temporal: 0.8, detail: 0.7, sigma: 0.06, codec: 'h264' }
  })
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original video bytes'); assert(fs.existsSync(path.join(f.root, job.output)))
  assert.equal(f.project().tracks[0].clips[0].src, 'media/source.mov'); assert.equal(f.project().comps.portrait.tracks[0].clips[0].src, job.output)
  assert.equal(f.broadcasts[0].cancelPath, '/api/video/jobs/cancel')
  const record = JSON.parse(JSON.stringify(f.project())).comps.portrait.tracks[0].clips[0].noiseReduction
  assert.equal(record.src, 'media/source.mov'); assert.equal(record.in, 1); assert.equal(record.dur, 4); assert.equal(record.output, job.output)
  assert.deepEqual(record.settings, { quality: 'balanced', strength: 0.65, spatial: 0.5, temporal: 0.8, detail: 0.7, sigma: 0.06, codec: 'h264' })
  assert.equal(record.compute, 'cpu')
})

test('denoise completion after project drift preserves source and rejects application', async t => {
  const f = await serverFixture(t, { hold: true }), job = await f.routes['POST /api/video/denoise'](f.body)
  await f.start; f.drift(); f.finish(); const done = await f.routes['GET /api/video/jobs/wait']({}, new URLSearchParams({ id: job.id }))
  assert.equal(done.state, 'done'); assert.equal(done.applied, false); assert.match(done.applyError, /changed/); assert.equal(f.edits.length, 1); assert.equal(fs.readFileSync(f.file, 'utf8'), 'original video bytes')
  assert.deepEqual(f.edits.map(body => body.ops.map(op => op.op)), [['import']]); assert.equal(f.edits[0].expectedVersion, 5)
  assert.equal(done.assetRegistered, true); assert.equal(done.admissionVersion, 6); assert.equal(done.version, 6)
  assert.equal(f.project().assets[done.output].processing.source, 'media/source.mov')
  assert.equal(f.project().comps.portrait.tracks[0].clips[0].src, 'media/source.mov')
})

test('cancellation aborts the owned worker and removes its partial output', async t => {
  const f = await serverFixture(t, { hold: true }), job = await f.routes['POST /api/video/denoise'](f.body)
  await f.start; f.routes['POST /api/video/jobs/cancel']({ id: job.id }); await new Promise(resolve => setTimeout(resolve, 0))
  const done = await f.routes['GET /api/video/jobs/wait']({}, new URLSearchParams({ id: job.id }))
  assert.equal(done.state, 'cancelled'); assert.equal(f.edits.length, 0); assert.equal(fs.existsSync(path.join(f.root, job.output)), false)
})

test('native-only source formats, missing range and linked output directories cannot render', async t => {
  const hdr = await serverFixture(t, { pix: 'yuv420p10le' }); await assert.rejects(() => hdr.routes['POST /api/video/denoise'](hdr.body), /native processor/)
  const f = await serverFixture(t); await assert.rejects(() => f.routes['POST /api/video/denoise']({ ...f.body, in: undefined }), /complete source range/)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-video-outside-')); t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.symlinkSync(outside, path.join(f.root, 'media/denoised'))
  await assert.rejects(() => f.routes['POST /api/video/denoise'](f.body), /symbolic links/)
  assert.deepEqual(fs.readdirSync(outside), []); assert.equal(f.edits.length, 0)
})

test('attached pictures are skipped and invalid rendered outputs cannot replace a video', async t => {
  const f = await serverFixture(t, { streams: [{ index: 0, codec_type: 'video', pix_fmt: 'yuv420p', disposition: { attached_pic: 1 } }, { index: 1, codec_type: 'video', pix_fmt: 'yuv420p' }] })
  await f.routes['POST /api/video/denoise']({ ...f.body, wait: true })
  const args = f.commands.find(c => c.tool === 'render').args; assert.equal(args[args.indexOf('-map') + 1], '0:1')
  for (const derived of [{ hasVideo: false, hasAudio: true, duration: 4, width: 400, height: 200 }, { hasVideo: true, duration: 1, width: 400, height: 200 }, { hasVideo: true, duration: 4, width: NaN, height: 200 }]) {
    const broken = await serverFixture(t, { derived }), done = await broken.routes['POST /api/video/denoise']({ ...broken.body, wait: true })
    assert.equal(done.state, 'failed'); assert.equal(broken.edits.length, 0); assert.equal(broken.project().comps.portrait.tracks[0].clips[0].src, 'media/source.mov'); assert.match(done.error, /not a complete video/)
  }
})


test('revised denoise processes the saved original at the trimmed source offset', async t => {
  const f = await serverFixture(t, { revising: true })
  const job = await f.routes['POST /api/video/denoise']({ ...f.body, strength: 0.3, useOriginal: true, wait: true })
  assert.equal(job.state, 'done'); assert.equal(job.applied, true)
  const argv = f.commands.find(c => c.tool === 'render').args
  assert.equal(argv[argv.indexOf('-i') + 1], f.file)
  assert.equal(argv[argv.indexOf('-ss') + 1], '1.5')
  const c = f.project().comps.portrait.tracks[0].clips[0]
  assert.equal(c.noiseReduction.src, 'media/source.mov'); assert.equal(c.noiseReduction.in, 1.5)
  assert.equal(c.noiseReduction.settings.strength, 0.3)
  assert.equal(fs.readFileSync(path.join(f.root, 'media/previous.mp4'), 'utf8'), 'previous processed bytes')
})

test('saved denoise settings survive JSON reopen; restoring maps a trimmed derived range to its source', () => {
  const f = fixture(), c = f.s.project.comps.portrait.tracks[0].clips[0]
  c.src = 'media/denoised/old.mp4'; c.in = 0.5
  c.noiseReduction = { src: 'media/source.mov', in: 1, dur: 5, output: c.src, settings: { strength: 0.3, sigma: 0.08 } }
  f.s.project.assets[c.src] = { hasVideo: true, duration: 5, width: 400, height: 200, fps: 24 }
  f.s.project = JSON.parse(JSON.stringify(f.s.project))
  const p = compView(f.s.project, 'portrait'), clip = p.tracks[0].clips[0], capture = processingCapture(f.s, p, clip)
  assert.equal(denoiseSource(capture).settings.strength, 0.3)
  const result = applyOps(f.s.project, restoreDenoiseOps(capture)).project.comps.portrait.tracks[0].clips[0]
  assert.equal(result.src, 'media/source.mov'); assert.equal(result.in, 1.5); assert.equal(result.speed, 2); assert.equal(result.noiseReduction, undefined)
  clip.noiseReduction.output = 'unrelated.mp4'
  assert.equal(denoiseSource(processingCapture(f.s, p, clip)), null)
  clip.noiseReduction.output = clip.src; clip.noiseReduction.dur = 1
  assert.throws(() => denoiseSource(processingCapture(f.s, p, clip)), /saved denoise source range/)
})

test('a revision without matching provenance cannot render an arbitrary original', async t => {
  const f = await serverFixture(t)
  await assert.rejects(() => f.routes['POST /api/video/denoise']({ ...f.body, useOriginal: true }), /saved original/)
  assert.equal(f.commands.filter(c => c.tool === 'render').length, 0)
})
