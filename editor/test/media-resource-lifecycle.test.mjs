import './fixtures/browser-host-imports.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const folder = process.env.ARYA_RESOURCE_ENGINE_DIRECTORY
  ? pathToFileURL(path.resolve(process.env.ARYA_RESOURCE_ENGINE_DIRECTORY) + path.sep)
  : new URL('../web/engine/', import.meta.url)
const read = name => fs.readFile(new URL(name, folder), 'utf8')
let sequence = 0
const moduleURL = source => `data:text/javascript;base64,${Buffer.from(`${source}\n// fixture ${sequence++}`).toString('base64')}`
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const sample = ({ fail = false } = {}) => {
  const frame = { closed: 0, close() { this.closed++ } }
  return { closed: 0, converted: 0, frame, close() { this.closed++ }, toVideoFrame() { this.converted++; if (fail) throw Error('conversion failed'); return frame } }
}

async function decoderFixture({ pending = deferred(), planned = false, track } = {}) {
  let disposed = 0, returned = 0
  globalThis.location = { href: 'http://fixture.invalid/' }
  globalThis.__decoderFixture = {
    primary: () => track ?? Promise.resolve({ displayWidth: 1920, displayHeight: 1080, canDecode: async () => true }),
    dispose: () => { disposed++ }, sample: () => pending.promise,
    iter: () => ({ next: () => pending.promise.then(value => ({ value })), return: async () => { returned++; return { done: true } } }),
  }
  const bunny = moduleURL(`export const ALL_FORMATS=[]; export class BlobSource { constructor(){} } export class UrlSource { constructor(){} }
    export class Input { getPrimaryVideoTrack(){return globalThis.__decoderFixture.primary()} dispose(){globalThis.__decoderFixture.dispose()} }
    export class VideoSampleSink { getSample(){return globalThis.__decoderFixture.sample()} samplesAtTimestamps(){return globalThis.__decoderFixture.iter()} }`)
  const source = (await read('decoder.js')).replace("'/vendor/mediabunny/dist/bundles/mediabunny.min.mjs'", JSON.stringify(bunny))
  const { FrameReader } = await import(moduleURL(source))
  const reader = new FrameReader('/movie.mp4')
  if (!track) await reader.ready
  if (planned) reader.setPlan([1, 2])
  return { reader, pending, disposed: () => disposed, returned: () => returned }
}

for (const planned of [false, true]) test(`close discards a late ${planned ? 'planned' : 'random-access'} sample without producing a frame`, async () => {
  const f = await decoderFixture({ planned })
  const result = f.reader.frameAt(1); await Promise.resolve()
  f.reader.close(); f.reader.close()
  const s = sample(); f.pending.resolve(s)
  await assert.rejects(result, /no longer current/)
  assert.equal(s.closed, 1); assert.equal(s.converted, 0); assert.equal(f.disposed(), 1)
  assert.equal(f.returned(), planned ? 1 : 0)
})

test('replacing an active plan disposes the previous iterator and its late sample', async () => {
  const f = await decoderFixture({ planned: true })
  const result = f.reader.frameAt(1); await Promise.resolve()
  f.reader.setPlan([4, 5])
  const s = sample(); f.pending.resolve(s)
  await assert.rejects(result, /no longer current/)
  assert.equal(s.closed, 1); assert.equal(s.converted, 0); assert.equal(f.returned(), 1)
  f.reader.close()
})

test('sample conversion failure still closes the sample', async () => {
  const f = await decoderFixture()
  const result = f.reader.frameAt(1)
  const s = sample({ fail: true }); f.pending.resolve(s)
  await assert.rejects(result, /conversion failed/)
  assert.equal(s.closed, 1)
  f.reader.close()
})

test('closing during asynchronous open disposes the input exactly once', async () => {
  const track = deferred(), f = await decoderFixture({ track: track.promise })
  const opening = assert.rejects(f.reader.ready, /cannot decode/)
  f.reader.close(); track.resolve({ canDecode: async () => true })
  await opening; assert.equal(f.disposed(), 1)
})

test('a normal decoded frame belongs to the caller and the sample is released', async () => {
  const f = await decoderFixture(), s = sample(), result = f.reader.frameAt(1)
  f.pending.resolve(s)
  assert.equal(await result, s.frame); assert.equal(s.closed, 1); assert.equal(s.frame.closed, 0)
  s.frame.close(); f.reader.close()
})

function element() {
  const listeners = new Map()
  return { style: {}, paused: true, removed: false, src: '',
    appendChild() {}, addEventListener(name, fn) { listeners.set(name, fn) }, removeEventListener(name) { listeners.delete(name) },
    removeAttribute() { this.src = '' }, load() {}, pause() { this.paused = true }, remove() { this.removed = true },
  }
}

async function mediaFixture() {
  globalThis.FontFace = class { async load() { return this } }
  globalThis.document = { fonts: { add() {} }, body: element(), createElement: () => element(), visibilityState: 'hidden' }
  globalThis.Image = class { constructor() { Object.assign(this, element()) } }
  globalThis.__newReaderCount = 0
  globalThis.__dynamicDecodedFrame = sample().frame
  const decoder = moduleURL('export class FrameReader { constructor(){globalThis.__newReaderCount++;this.ready=Promise.resolve()} close(){} setPlan(){} async frameAt(){return globalThis.__dynamicDecodedFrame} }')
  const source = (await read('media.js')).replaceAll("'./decoder.js'", JSON.stringify(decoder))
    .replace("'/core/cube-lut.js'", JSON.stringify(moduleURL('export const parseCube=()=>({})')))
    .replaceAll('import.meta.url', JSON.stringify(new URL('media.js', folder).href))
  const { Media } = await import(moduleURL(source))
  const media = new Media(), fallback = []
  media.seek = async (...args) => { fallback.push(args) }
  return { media, fallback }
}

function pendingReader(media, key = 'clip', url = 'movie') {
  const pending = deferred(), record = { url, failed: false, reader: { closed: 0, ready: Promise.resolve(), frameAt: () => pending.promise, close() { this.closed++ } } }
  media.readers.set(key, record)
  return { pending, record }
}

for (const failure of [false, true]) test(`decoder teardown rejects a late ${failure ? 'failure' : 'frame'} without recreating fallback video`, async () => {
  const { media, fallback } = await mediaFixture(), f = pendingReader(media)
  const result = media.decodeFrame('clip', 'movie', 1)
  media.closeDecoders()
  const frame = sample().frame
  if (failure) f.pending.reject(Error('decoder closed'))
  else f.pending.resolve(frame)
  await result
  assert.equal(media.readers.size, 0); assert.equal(media.frames.size, 0); assert.equal(fallback.length, 0)
  assert.equal(frame.closed, failure ? 0 : 1)
})

test('a superseded decode cannot overwrite the newest clip frame', async () => {
  const { media } = await mediaFixture(), first = deferred(), second = deferred()
  let call = 0
  media.readers.set('clip', { url: 'movie', reader: { frameAt: () => (call++ ? second.promise : first.promise), close() {} } })
  const a = media.decodeFrame('clip', 'movie', 1), b = media.decodeFrame('clip', 'movie', 2)
  const newest = sample().frame, old = sample().frame
  second.resolve(newest); await b
  first.resolve(old); await a
  assert.equal(media.frames.get('clip').frame, newest); assert.equal(newest.closed, 0); assert.equal(old.closed, 1)
  media.closeDecoders(); assert.equal(newest.closed, 1)
})

for (const failure of [false, true]) test(`replacing a source URL retires its pending ${failure ? 'failure' : 'frame'} before the replacement import`, async () => {
  const { media, fallback } = await mediaFixture(), f = pendingReader(media), old = sample().frame
  const previous = media.decodeFrame('clip', 'movie', 1)
  const next = media.decodeFrame('clip', 'replacement', 2)
  if (failure) f.pending.reject(Error('old decoder closed'))
  else f.pending.resolve(old)
  await previous; await next
  assert.equal(fallback.length, 0); assert.equal(media.readers.get('clip').url, 'replacement')
  assert.equal(media.frames.get('clip').frame, globalThis.__dynamicDecodedFrame)
  assert.equal(old.closed, failure ? 0 : 1)
  media.closeDecoders()
})

for (const operation of ['decode', 'plan']) test(`teardown during dynamic decoder import cannot reopen a ${operation}`, async () => {
  const { media } = await mediaFixture()
  const result = operation === 'decode' ? media.decodeFrame('clip', 'movie', 1) : media.planDecoders(new Map([['clip', { url: 'movie', times: [1] }]]))
  media.closeDecoders(); await result
  assert.equal(globalThis.__newReaderCount, 0); assert.equal(media.readers.size, 0)
})

test('a genuine decode failure closes the decoder and retains the seeking fallback', async () => {
  const { media, fallback } = await mediaFixture(), f = pendingReader(media)
  const result = media.decodeFrame('clip', 'movie', 1)
  f.pending.reject(Error('unsupported codec')); await result
  assert.equal(f.record.reader.closed, 1); assert.equal(fallback.length, 1); assert.equal(f.record.failed, true)
})

test('idle collection retains all active videos and only four most-recent idle videos', async () => {
  const { media } = await mediaFixture(), now = performance.now()
  for (let i = 0; i < 100; i++) { const v = media.video(`clip-${i}`, 'movie'); v.lastUsed = now - (100 - i) }
  media.gc(new Set(['clip-0', 'clip-1']))
  assert.deepEqual([...media.videos.keys()], ['clip-0', 'clip-1', 'clip-96', 'clip-97', 'clip-98', 'clip-99'])
  for (const v of media.videos.values()) v.lastUsed = now - 9000
  media.gc(new Set(['clip-0']))
  assert.deepEqual([...media.videos.keys()], ['clip-0'])
})

test('reset releases frames, videos, images and title canvases between worker jobs', async () => {
  const { media } = await mediaFixture(), frame = sample().frame, video = media.video('clip', 'movie'), canvas = { width: 1920, height: 1080 }, image = element()
  image.src = 'image'
  media.frames.set('clip', { frame }); media.images.set('image', { el: image }); media.titles.set('title', { canvas })
  media.reset()
  assert.equal(frame.closed, 1); assert.equal(video.el.removed, true); assert.equal(image.src, '')
  assert.equal(canvas.width, 0); assert.equal(canvas.height, 0)
  for (const key of ['frames', 'readers', 'videos', 'images', 'titles']) assert.equal(media[key].size, 0)
})

async function workerFixture({ renderError = false, postError = false, audioError = false } = {}) {
  const events = {}, requests = [], texture = {}, lut = {}, released = []
  const compositorSource = (await read('compositor.js'))
    .replace("'/core/project.js'", JSON.stringify(new URL('../core/project.js', import.meta.url).href))
    .replace("'./grade.js'", JSON.stringify(new URL('../core/render-grade.js', import.meta.url).href))
    .replace("'./render-resolution.js'", JSON.stringify(new URL('render-resolution.js', folder).href))
  const { Compositor } = await import(moduleURL(compositorSource))
  const f = globalThis.__workerFixture = {
    comp: { textures: new Map([['vid:clip', {}]]), luts: new Map([['look.cube', { tex: lut }]]), resize() {}, dropTexture(key) { released.push(key); this.textures.delete(key) }, gl: { deleteTexture(tex) { released.push(tex) } }, clearLuts: Compositor.prototype.clearLuts, readPixels() {} },
    media: { videos: new Map(), resetCount: 0, closed: 0, reset() { this.resetCount++; this.closed++ }, closeDecoders() { this.closed++ }, async planDecoders() {} },
    audio: { async renderWav() { if (audioError) throw Error('audio fixture failed'); return {} } },
    async render() { if (renderError) throw Error('decode fixture failed') },
  }
  const mock = moduleURL(`export class Compositor { constructor(){return globalThis.__workerFixture.comp} }
    export class Media { constructor(){return globalThis.__workerFixture.media} }
    export class AudioEngine { constructor(){return globalThis.__workerFixture.audio} }
    export class Player { async renderExact(){await globalThis.__workerFixture.render()} }
    export const frameCenter=(t)=>t, parseCube=()=>({}), neededVideos=()=>[],compView=p=>p,duration=()=>1;
    export { validateExportSpec,buildDecoderPlans } from ${JSON.stringify(new URL('../core/processing-export.js', import.meta.url).href)};
    export {framePlan} from ${JSON.stringify(new URL('../core/render-plan.js',import.meta.url).href)};
    export function createRenderQueue(run,failed){globalThis.__workerFixture.run=run;return ()=>{}}`)
  globalThis.document = { body: element(), createElement: () => ({ toBlob: done => done({}) }) }
  globalThis.EventSource = class { addEventListener(name, fn) { events[name] = fn } }
  globalThis.fetch = async (url, options) => { requests.push(url); if (postError) throw Error('transport fixture failed'); return { ok: true } }
  const source = (await read('worker.js')).replace(/^import .* from .*$/gm, line => line.replace(/from .*$/, `from ${JSON.stringify(mock)}`))
  const { startWorker } = await import(moduleURL(source)); startWorker()
  return { f, events, requests, released, lut, texture }
}

const job = (kind = 'frame', id = 'fixture') => ({ job: { id, kind, spec: { at: 1, width: 2, height: 2, fps: 30, frames: 2, range: { in: 0, out: 1 }, preset: 'png-seq' } }, project: { tracks: [], width: 1920, height: 1080, fps: 30 } })

for (const mode of ['frame success', 'export success', 'frame render failure', 'frame transport failure', 'audio failure', 'cancelled export']) test(`worker cleanup runs after ${mode}`, async () => {
  const fixture = await workerFixture({ renderError: mode.includes('render failure'), postError: mode.includes('transport failure'), audioError: mode === 'audio failure' })
  const item = job(mode.includes('export') || mode === 'audio failure' ? 'export' : 'frame')
  if (mode === 'audio failure') item.job.spec.preset = 'audio-wav'
  if (mode === 'cancelled export') fixture.events.cancel({ data: JSON.stringify({ id: item.job.id }) })
  if (mode.includes('failure') || mode.includes('cancelled')) await assert.rejects(fixture.f.run(item))
  else await fixture.f.run(item)
  assert.equal(fixture.f.media.resetCount, 1)
  assert.equal(fixture.f.comp.textures.size, 0); assert.equal(fixture.f.comp.luts.size, 0)
  assert.deepEqual(fixture.released, ['vid:clip', fixture.lut])
})

test('cancelled job ID is retired so a following job can finish with clean resources', async () => {
  const fixture = await workerFixture(), item = job('export')
  fixture.events.cancel({ data: JSON.stringify({ id: item.job.id }) })
  await assert.rejects(fixture.f.run(item), /cancelled/)
  await fixture.f.run(item)
  assert.equal(fixture.f.media.resetCount, 2)
  assert.ok(fixture.requests.some(url => url.endsWith('/done')))
})
