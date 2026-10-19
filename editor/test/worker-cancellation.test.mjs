import './fixtures/browser-host-imports.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test, { after } from 'node:test'
import { failStalledWorkerJob, noteWorkerActivity, stalledWorkerJobs, workerSetupLimit } from '../core/processing-worker.mjs'

const originalConsoleError = console.error
after(() => { console.error = originalConsoleError })

const moduleURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
let sequence = 0
const unique = source => moduleURL(`${source}\n// fixture ${sequence++}`)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const turn = () => new Promise(resolve => setImmediate(resolve))
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await turn() } assert.ok(check(), 'Expected worker state did not arrive') }
function element() { return { style: {}, src: '', paused: true, appendChild() {}, addEventListener() {}, removeEventListener() {}, removeAttribute() { this.src = '' }, pause() {}, load() {}, remove() {} } }

async function fixture(options = {}) {
  const f = globalThis.__workerCancelFixture = { events: {}, requests: [], paints: [], resizes: [], errors: [], resetCount: 0, closedFrames: 0, audioObjects: [], ...options }
  console.error = error => f.errors.push(String(error))
  globalThis.FontFace = class { async load() { return this } }
  globalThis.Image = class { constructor() { Object.assign(this, element()) } }
  globalThis.document = { fonts: { add() {} }, visibilityState: 'hidden', body: element(), createElement: name => name === 'canvas' ? { toBlob(done) { if (f.blobGate) f.blobDone = done; else done({}) } } : element() }
  globalThis.EventSource = class { addEventListener(name, fn) { f.events[name] = fn } }
  const mediaSource = (await fs.readFile(new URL('../web/engine/media.js', import.meta.url), 'utf8'))
    .replace("'/core/cube-lut.js'", JSON.stringify(unique('export const parseCube=()=>({})')))
    .replaceAll('import.meta.url', JSON.stringify(new URL('../web/engine/media.js', import.meta.url).href))
  const { Media } = await import(unique(mediaSource))
  f.media = new Media()
  const reset = f.media.reset.bind(f.media)
  f.media.reset = () => { f.resetCount++; reset() }
  f.media.planDecoders = async () => {}
  if (f.videoGate) f.media.readers.set('video', { url: 'movie', reader: { frameAt: () => f.videoGate.promise, close() {} } })
  if (f.failVideo) {
    const decode = f.media.decodeFrame.bind(f.media)
    f.media.decodeFrame = (...args) => args[0] === 'failed' ? Promise.reject(new Error('one video failed')) : decode(...args)
  }
  f.comp = { size: [2, 2], textures: new Map(), luts: new Map(), gl: { deleteTexture() {} }, resize(w, h) { f.resizes.push([w, h]) }, readPixels() {}, dropTexture(key) { this.textures.delete(key) }, setLut(path, lut) { this.luts.set(path, { tex: {} }); f.lutSet = true } }
  const compositorSource = await fs.readFile(new URL('../web/engine/compositor.js', import.meta.url), 'utf8')
  const clearStart = compositorSource.indexOf('  clearLuts(keepExpected = false) {')
  const clearEnd = compositorSource.indexOf('\n  commitLuts(', clearStart)
  assert.ok(clearStart >= 0 && clearEnd > clearStart, 'Extract the actual compositor LUT cleanup method')
  f.comp.clearLuts = new Function(`return function ${compositorSource.slice(clearStart, clearEnd).trim()}`)()
  f.comp.commitLuts = inputs => { f.lutCommits = (f.lutCommits ?? 0) + 1; for (const input of inputs) f.comp.setLut(input.path, input.lut) }
  const core = unique('export const duration=p=>p.duration??2, clipEnd=c=>c.start+c.dur, sourceTime=()=>0, compView=p=>p;')
  const frames = unique(`export const neededVideos=p=>[...(p.failVideo?[{key:'failed',url:'failed',srcTime:0,fps:30}]:[]),...(p.delayVideo?[{key:'video',url:'movie',srcTime:0,fps:30}]:[])];
    export const neededImages=p=>new Set(p.image?[p.image]:[]), resolveTracks=()=>[];
    export const drawFrame=(comp,media,p,t)=>globalThis.__workerCancelFixture.paints.push({name:p.name,t});`)
  const playerSource = (await fs.readFile(new URL('../web/engine/player.js', import.meta.url), 'utf8'))
    .replace("'/core/project.js'", JSON.stringify(core)).replace("'./frame.js'", JSON.stringify(frames)).replace("'./media.js'", JSON.stringify(unique('export const mediaUrl=()=>"image"')))
  const player = unique(playerSource)
  const mock = unique(`export class Compositor { constructor(){return globalThis.__workerCancelFixture.comp} }
    export class Media { constructor(){return globalThis.__workerCancelFixture.media} }
    export { Player } from ${JSON.stringify(player)};
    export class AudioEngine { constructor(){this.buffers=new Map();this.ctx={close:()=>Promise.resolve()};globalThis.__workerCancelFixture.audioObjects.push(this)} stop(){} renderWav(p,a,b,{signal,processingJob}){const f=globalThis.__workerCancelFixture;f.audioSignal=signal;f.audioProcessingJob=processingJob;if(!f.audioGate)return Promise.resolve({});return f.audioGate.promise} }
    export const frameCenter=(t)=>t, parseCube=()=>({});
    export { neededVideos } from ${JSON.stringify(frames)};
    export { compView,duration } from ${JSON.stringify(core)};
    export { framePlan } from ${JSON.stringify(new URL('../core/render-plan.js', import.meta.url).href)};
    export { createRenderQueue } from ${JSON.stringify(new URL('../core/render-queue.js', import.meta.url).href)};
    export { validateExportSpec,buildDecoderPlans } from ${JSON.stringify(new URL('../core/processing-export.js', import.meta.url).href)};`)
  globalThis.fetch = (url, request = {}) => {
    f.requests.push({ url, request })
    if (f.httpGate && url.includes('/first/frame')) return f.httpGate.promise
    if (url.startsWith('/media?')) {
      let delivered = false
      return Promise.resolve({ ok: true, body: { getReader() { return {
        async read() {
          if (delivered) return { done: true }
          delivered = true; f.lutStarted = true
          const text = await (f.lutGate?.promise ?? Promise.resolve('LUT'))
          return { done: false, value: new TextEncoder().encode(text) }
        },
        async cancel() { f.lutReaderCancels = (f.lutReaderCancels ?? 0) + 1 },
        releaseLock() { f.lutReaderReleases = (f.lutReaderReleases ?? 0) + 1 },
      } } } })
    }
    return Promise.resolve({ ok: true })
  }
  const workerSource = (await fs.readFile(process.env.ARYA_CANCEL_WORKER_FILE ?? new URL('../web/engine/worker.js', import.meta.url), 'utf8')).replace(/^import .* from .*$/gm, line => line.replace(/from .*$/, `from ${JSON.stringify(mock)}`))
  const { startWorker } = await import(unique(workerSource)); startWorker()
  f.enqueue = item => f.events.render({ data: JSON.stringify(item) })
  f.cancel = id => f.events.cancel({ data: JSON.stringify({ id }) })
  return f
}

function job(id = 'first', props = {}, kind = 'frame', spec = {}) {
  return { job: { id, kind, spec: { at: 0, width: 2, height: 2, fps: 30, range: { in: 0, out: 1 }, preset: 'png-seq', ...spec } }, project: { name: id, tracks: [], assets: {}, width: 1920, height: 1080, fps: 30, duration: 2, ...props } }
}
const urls = f => f.requests.map(request => request.url)
async function finishesNext(f) {
  f.enqueue(job('next'))
  await until(() => urls(f).includes('/api/job/next/frame'))
  assert.ok(urls(f).includes('/api/job/first/fail'))
  assert.ok(!urls(f).includes('/api/job/first/done'))
}

test('cancellation retires a deferred decoder, advances the actual queue, and waits for its real drain', async () => {
  const videoGate = deferred(), f = await fixture({ videoGate })
  f.enqueue(job('first', { delayVideo: true }))
  await until(() => f.resizes.length > 0)
  await turn(); f.cancel('first')
  await finishesNext(f)
  assert.equal(f.paints.some(paint => paint.name === 'first'), false)
  assert.ok(!urls(f).includes('/api/job/first/drained'))
  videoGate.resolve({ close() { f.closedFrames++ } })
  await until(() => urls(f).includes('/api/job/first/drained'))
  assert.equal(f.closedFrames, 1)
  assert.equal(f.paints.some(paint => paint.name === 'first'), false)
})

test('cancellation settles a pending image load and drains it before the next frame', async () => {
  const f = await fixture()
  f.enqueue(job('first', { image: 'never-loaded.png' }))
  await until(() => f.media.images.size === 1)
  const image = f.media.images.get('never-loaded.png')
  f.cancel('first'); await finishesNext(f)
  await until(() => urls(f).includes('/api/job/first/drained'))
  assert.equal(image.failed, true); assert.equal(image.el.src, ''); assert.equal(image.el.onload, null)
  assert.equal(f.paints.some(paint => paint.name === 'first'), false)
})

test('cancellation aborts an upload request and withholds drain until an uncooperative HTTP wait settles', async () => {
  const httpGate = deferred(), f = await fixture({ httpGate })
  f.enqueue(job()); await until(() => urls(f).includes('/api/job/first/frame'))
  f.cancel('first'); await finishesNext(f)
  const upload = f.requests.find(request => request.url === '/api/job/first/frame')
  assert.equal(upload.request.signal.aborted, true)
  assert.ok(!urls(f).includes('/api/job/first/drained'))
  httpGate.resolve({ ok: false, status: 410 })
  await until(() => urls(f).includes('/api/job/first/drained'))
})

test('a late LUT response cannot populate the next job after cancellation', async () => {
  const lutGate = deferred(), f = await fixture({ lutGate })
  f.enqueue(job('first', { tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'lut-color', kind: 'color', color: '#000000', start: 0, dur: 2, grade: { lut: 'delayed.cube' } }] }] }))
  await until(() => f.lutStarted)
  f.cancel('first'); await finishesNext(f)
  lutGate.resolve('late LUT')
  await until(() => urls(f).includes('/api/job/first/drained'))
  assert.equal(f.lutSet, undefined)
})

test('the current LUT commit boundary is observable for a valid visual layer before cancellation assertions', async () => {
  const f = await fixture()
  f.enqueue(job('first', { tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'lut-color', kind: 'color', color: '#000000', start: 0, dur: 2, grade: { lut: 'ready.cube' } }] }] }))
  await until(() => urls(f).includes('/api/job/first/frame'))
  assert.equal(f.lutSet, true)
  assert.equal(f.lutCommits, 1)
  assert.equal(f.lutReaderCancels, 2)
  assert.equal(f.lutReaderReleases, 2)
})

test('the actual worker sends setup heartbeats during pending audio, then a setup timeout cancels it', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const audioGate = deferred(), f = await fixture({ audioGate })
  const pending = { state: 'queued', spec: { width: 1920, height: 1080, range: { in: 0, out: 1 } },
    processing: { dispatched: true, drained: false, worker: { exitCode: null, signalCode: null }, acknowledge() { this.drained = true } } }
  f.enqueue(job('first', {}, 'export', { preset: 'audio-wav' }))
  await until(() => f.audioSignal)
  noteWorkerActivity(pending, 0, 'dispatch')
  for (let now = 5000; now <= 150000; now += 5000) {
    t.mock.timers.tick(5000)
    await turn()
    assert.equal(urls(f).filter(url => url === '/api/job/first/alive').length, now / 5000,
      'the real worker must send a heartbeat while audio is awaiting its renderer')
    noteWorkerActivity(pending, now, 'heartbeat')
    assert.deepEqual(stalledWorkerJobs([pending], now), [], 'slow, responsive audio is allowed')
  }
  const deadline = workerSetupLimit(pending)
  noteWorkerActivity(pending, deadline, 'heartbeat')
  assert.deepEqual(stalledWorkerJobs([pending], deadline), [pending], 'heartbeats cannot hide an endless audio render')
  failStalledWorkerJob(pending, (j, message) => {
    j.state = 'failed'
    assert.match(message, /still preparing this export/)
    f.cancel('first')
  }, deadline)
  await finishesNext(f)
  assert.equal(f.audioSignal.aborted, true)
  assert.equal(pending.processing.drained, false)
  assert.ok(!urls(f).includes('/api/job/first/audio') && !urls(f).includes('/api/job/first/drained'))
  audioGate.resolve({})
  await until(() => urls(f).includes('/api/job/first/drained'))
  const beats = urls(f).filter(url => url === '/api/job/first/alive').length
  t.mock.timers.tick(10000); await turn()
  assert.equal(urls(f).filter(url => url === '/api/job/first/alive').length, beats, 'cancelled jobs stop their heartbeat')
  assert.ok(!urls(f).includes('/api/job/first/audio'), 'late audio must never publish')
})

test('pending offline audio does not publish or claim resource drain after logical cancellation', async () => {
  const audioGate = deferred(), f = await fixture({ audioGate })
  f.enqueue(job('first', {}, 'export', { preset: 'audio-wav' }))
  await until(() => f.audioSignal)
  f.cancel('first'); await finishesNext(f)
  assert.equal(f.audioSignal.aborted, true)
  assert.equal(f.audioProcessingJob, 'first')
  assert.ok(!urls(f).includes('/api/job/first/audio')); assert.ok(!urls(f).includes('/api/job/first/drained'))
  audioGate.resolve({})
  await until(() => urls(f).includes('/api/job/first/drained'))
  assert.ok(!urls(f).includes('/api/job/first/audio'))
})

test('cancellation interrupts a pending canvas callback without publishing its late blob', async () => {
  const f = await fixture({ blobGate: true })
  f.enqueue(job()); await until(() => f.blobDone)
  f.cancel('first'); f.blobGate = false; await finishesNext(f)
  assert.ok(!urls(f).includes('/api/job/first/frame'))
  f.blobDone({})
  await until(() => urls(f).includes('/api/job/first/drained'))
  assert.ok(!urls(f).includes('/api/job/first/frame'))
})

test('cancelling a queued job skips rendering and still reports fail before drained', async () => {
  const videoGate = deferred(), f = await fixture({ videoGate })
  f.enqueue(job('first', { delayVideo: true })); await until(() => f.resizes.length > 0)
  f.enqueue(job('queued')); f.cancel('queued'); f.cancel('first')
  videoGate.resolve({ close() {} })
  await until(() => urls(f).includes('/api/job/queued/drained'))
  assert.equal(f.paints.some(paint => paint.name === 'queued'), false)
  assert.ok(urls(f).indexOf('/api/job/queued/fail') < urls(f).indexOf('/api/job/queued/drained'))
})

test('worker disconnect retires an active image wait and sends a failure', async () => {
  const f = await fixture(); f.enqueue(job('first', { image: 'pending.png' }))
  await until(() => f.media.images.size === 1); f.events.error()
  await finishesNext(f)
  await until(() => urls(f).includes('/api/job/first/drained'))
})

test('invalid render bounds fail before GPU resize or allocation', async () => {
  const f = await fixture(); f.enqueue(job('first', {}, 'export', { width: 10000 }))
  await until(() => urls(f).includes('/api/job/first/drained'))
  assert.equal(f.resizes.length, 0)
  assert.ok(urls(f).includes('/api/job/first/fail'))
})

test('a completed frame reports drained without a failure', async () => {
  const f = await fixture(); f.enqueue(job())
  await until(() => urls(f).includes('/api/job/first/drained'))
  assert.ok(urls(f).includes('/api/job/first/frame')); assert.ok(!urls(f).includes('/api/job/first/fail'))
})

test('an image deadline settles a load and reset cancels its timer', async () => {
  const f = await fixture(), timers = new Map(), oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout
  let next = 0
  globalThis.setTimeout = (fn, ms) => { timers.set(++next, { fn, ms }); return next }
  globalThis.clearTimeout = id => timers.delete(id)
  try {
    const image = f.media.image('timeout.png')
    assert.equal([...timers.values()][0].ms, 8000)
    const deadline = [...timers.values()][0].fn
    deadline(); await image.promise
    assert.equal(image.failed, true); assert.equal(image.el.src, ''); assert.equal(timers.size, 0)
    image.el.onload?.(); deadline()
    const pending = f.media.image('pending.png')
    assert.equal(timers.size, 1)
    f.media.reset(); await pending.promise
    assert.equal(timers.size, 0); assert.equal(pending.el.onerror, null)
  } finally { globalThis.setTimeout = oldSet; globalThis.clearTimeout = oldClear }
})

async function audioFixture() {
  const mock = unique(`export const host={kind:'http'}; export const clipEnd=c=>c.start+c.dur,compView=p=>p,gainAt=()=>1,hasAudio=()=>true,valueAt=()=>1;
    export const dbToLin=()=>1,measure=()=>({}),reverbImpulse=()=>({});
    export const activeFx=()=>[],chainLatency=()=>0,DYNAMICS=new Set(),eqBands=()=>[],FX_TYPES={},fxLatency=()=>0,fxParams=()=>({}),legacyEqBands=()=>[],masterChain=()=>({fx:[]});`)
  const source = (await fs.readFile(new URL('../web/engine/audio.js', import.meta.url), 'utf8'))
    .replace(/^import .* from .*$/gm, line => line.replace(/from .*$/, `from ${JSON.stringify(mock)}`))
    .replaceAll('import.meta.url', JSON.stringify(new URL('../web/engine/audio.js', import.meta.url).href))
  const { AudioEngine } = await import(unique(source)), engine = new AudioEngine()
  return { engine, AudioEngine }
}

test('actual audio load forwards abort, discards its failed cache entry, and can retry', async () => {
  const { engine } = await audioFixture(), gate = deferred(), controller = new AbortController()
  let observed, decoded = 0
  engine.context = () => ({ decodeAudioData: async () => { decoded++; return { duration: 1 } } })
  globalThis.fetch = (url, { signal }) => { observed = signal; return gate.promise }
  const p = { assets: {} }, clip = { src: 'a.wav', dur: 1 }, load = engine.load(p, clip, controller.signal)
  assert.equal(observed, controller.signal)
  controller.abort(); gate.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) })
  await assert.rejects(load, { name: 'AbortError' }); assert.equal(engine.buffers.size, 0); assert.equal(decoded, 0)
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) })
  assert.equal((await engine.load(p, clip)).buffer.duration, 1); assert.equal(decoded, 1)
})

test('actual offline audio waits for rendering to settle, then rejects abort and releases its graph', async () => {
  const { engine } = await audioFixture(), gate = deferred(), controller = new AbortController()
  let started = 0, disposed = 0, stopped = 0, disconnected = 0, settled = false
  globalThis.OfflineAudioContext = class { constructor() { this.destination = {} } startRendering() { started++; return gate.promise } }
  engine.schedule = async (ctx, destination, p, from, when, rate, options) => {
    assert.equal(options.signal, controller.signal)
    return { workletNodes: [{ port: { postMessage() { disposed++ } } }], nodes: [{ stop() { stopped++ }, disconnect() { disconnected++ } }] }
  }
  const rendering = engine.renderBuffer({ tracks: [], assets: {} }, 0, 1, { signal: controller.signal })
  rendering.then(() => { settled = true }, () => { settled = true })
  await until(() => started === 1); controller.abort(); await turn()
  assert.equal(settled, false)
  gate.resolve({ getChannelData() { throw new Error('Cancelled samples must not be read') } })
  await assert.rejects(rendering, { name: 'AbortError' })
  assert.equal(disposed, 1); assert.equal(stopped, 1); assert.equal(disconnected, 1)
})

test('actual offline audio rejects a signal already cancelled before allocating a context', async () => {
  const { engine } = await audioFixture(), controller = new AbortController()
  let allocated = 0
  globalThis.OfflineAudioContext = class { constructor() { allocated++ } }
  controller.abort()
  await assert.rejects(engine.renderBuffer({ tracks: [] }, 0, 1, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(allocated, 0)
})

test('actual audio load attaches the worker reservation only to worker requests', async () => {
  const { engine } = await audioFixture(), requests = []
  engine.context = () => ({ decodeAudioData: async () => ({ duration: 1 }) })
  globalThis.fetch = async url => { requests.push(url); return { ok: true, arrayBuffer: async () => new ArrayBuffer(2) } }
  await engine.load({ assets: {} }, { src: 'worker.wav', dur: 1 }, undefined, 'job /1')
  await engine.load({ assets: {} }, { src: 'editor.wav', dur: 1 })
  assert.equal(new URL(requests[0], 'http://fixture').searchParams.get('processingJob'), 'job /1')
  assert.equal(new URL(requests[1], 'http://fixture').searchParams.has('processingJob'), false)
})

test('actual audio scheduling waits for every leaf after one rejects', async () => {
  const { engine } = await audioFixture(), gate = deferred(), error = Object.assign(new Error('cancelled'), { name: 'AbortError' })
  let settled = false, started = 0
  engine.loadLeaf = (item, signal, processingJob) => { assert.equal(processingJob, 'owned-job'); started++; return item.src === 'a.wav' ? Promise.reject(error) : gate.promise }
  const p = { assets: {}, tracks: [{ kind: 'audio', clips: ['a.wav', 'b.wav'].map(src => ({ src, kind: 'audio', start: 0, dur: 1 })) }] }
  const scheduling = engine.schedule({}, {}, p, 0, 0, 1, { processingJob: 'owned-job' })
  scheduling.then(() => { settled = true }, () => { settled = true })
  await until(() => started === 2); await turn()
  assert.equal(settled, false)
  gate.resolve({ buffer: null, from: 0 })
  await assert.rejects(scheduling, error)
})

test('worker audio loads at most four leaves and stops later batches after a failure', async () => {
  const { engine } = await audioFixture(), gates = [deferred(), deferred(), deferred()]
  let started = 0, settled = false
  engine.loadLeaf = item => { started++; return item.src === '0.wav' ? Promise.reject(new Error('derivative failed')) : gates[Number(item.src[0]) - 1].promise }
  const p = { assets: {}, tracks: [{ kind: 'audio', clips: Array.from({ length: 9 }, (_, i) => ({ src: `${i}.wav`, kind: 'audio', start: 0, dur: 1 })) }] }
  const scheduling = engine.schedule({}, {}, p, 0, 0, 1, { processingJob: 'owned-job' })
  scheduling.then(() => { settled = true }, () => { settled = true })
  await until(() => started === 4); await turn(); assert.equal(settled, false)
  gates[0].resolve({}); gates[1].resolve({}); await turn(); assert.equal(settled, false)
  gates[2].resolve({}); await assert.rejects(scheduling, /derivative failed/)
  assert.equal(started, 4)
})

test('worker audio propagates derivative failure while preview keeps its missing-audio fallback', async () => {
  const { engine } = await audioFixture(), p = { assets: {} }
  engine.context = () => ({ decodeAudioData() { throw new Error('Failed response must not decode') } })
  globalThis.fetch = async () => ({ ok: false, status: 429 })
  await assert.rejects(engine.load(p, { src: 'worker.wav', dur: 1 }, undefined, 'owned-job'), /audio 429/)
  assert.equal(engine.buffers.size, 0)
  assert.equal((await engine.load(p, { src: 'preview.wav', dur: 1 })).buffer, null)
})

test('preview audio retries a failed source on a later load instead of staying silent', async () => {
  const { engine } = await audioFixture(), p = { assets: {} }
  engine.previewRetryMs = 0
  engine.context = () => ({ decodeAudioData: async () => ({ duration: 1 }) })
  let requests = 0
  globalThis.fetch = async () => (++requests === 1 ? { ok: false, status: 429 } : { ok: true, arrayBuffer: async () => new ArrayBuffer(2) })
  assert.equal((await engine.load(p, { src: 'busy.wav', dur: 1 })).buffer, null)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await engine.load(p, { src: 'busy.wav', dur: 1 })).buffer.duration, 1)
  assert.equal(requests, 2)
})

test('a failing render sibling advances the queue but cannot claim another decoder has drained', async () => {
  const videoGate = deferred(), f = await fixture({ videoGate, failVideo: true })
  f.enqueue(job('first', { delayVideo: true, failVideo: true }))
  await until(() => urls(f).includes('/api/job/first/fail'))
  await finishesNext(f)
  assert.ok(!urls(f).includes('/api/job/first/drained'))
  videoGate.resolve({ close() { f.closedFrames++ } })
  await until(() => urls(f).includes('/api/job/first/drained'))
  assert.equal(f.closedFrames, 1)
})
