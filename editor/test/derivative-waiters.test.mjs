// Filmstrips and waveform peaks wait for a processing slot instead of being refused.
// Seen on 2026-11-16: importing 16 files asked for 16 filmstrips in one second and 12 got 429.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createDerivativeWaiters } from '../core/derivative-waiters.mjs'
import { createProcessingAdmission } from '../core/processing-admission.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))
function gate() { let open; const promise = new Promise(resolve => { open = resolve }); return { promise, open } }

test('16 requests at once all finish, and only 4 of them hold processing slots at a time', async () => {
  const processing = createProcessingAdmission()
  const waiters = createDerivativeWaiters({ admit: work => processing.run(work) })
  const gates = Array.from({ length: 16 }, gate), started = []
  const results = gates.map((g, index) => waiters.run(async () => { started.push(index); await g.promise; return index }))
  await turn()
  assert.deepEqual(waiters.snapshot(), { waiting: 12, admitted: 4 })
  assert.equal(processing.snapshot().active + processing.snapshot().queued, 4)
  // An export that starts now still gets a slot.
  assert.doesNotThrow(() => processing.assertCapacity())
  const exported = processing.run(async () => 'export')
  for (const g of gates) { g.open(); await turn() }
  assert.deepEqual(await Promise.all(results), Array.from({ length: 16 }, (_, index) => index))
  assert.deepEqual(started, Array.from({ length: 16 }, (_, index) => index), 'in the order they were asked for')
  assert.equal(await exported, 'export')
  assert.deepEqual(waiters.snapshot(), { waiting: 0, admitted: 0 })
})

test('a full processing queue makes a request wait; it runs when a slot frees', async () => {
  const processing = createProcessingAdmission()
  let now = 0, timer = null
  const waiters = createDerivativeWaiters({ admit: work => processing.run(work), now: () => now, setTimer: fn => { timer = fn; return 1 }, clearTimer: () => { timer = null } })
  const exports = Array.from({ length: 8 }, gate)
  const held = exports.map(g => processing.run(() => g.promise))
  const strip = waiters.run(async () => 'strip')
  await turn()
  assert.deepEqual(waiters.snapshot(), { waiting: 1, admitted: 0 })
  assert.equal(typeof timer, 'function', 'it is offered again on a timer')
  exports[0].open(); await held[0]; await turn()
  timer()
  assert.deepEqual(waiters.snapshot(), { waiting: 0, admitted: 1 })
  for (const g of exports) g.open()
  assert.equal(await strip, 'strip')
})

test('a request that cannot get a slot for 2 minutes is refused, and so is the 257th waiting request', async () => {
  let now = 0, timer = null
  const busy = () => { const error = new Error('Processing queue is full. Wait for an active operation to finish.'); error.status = 429; throw error }
  const waiters = createDerivativeWaiters({ admit: busy, now: () => now, setTimer: fn => { timer = fn; return 1 }, clearTimer: () => { timer = null } })
  const first = waiters.run(async () => 'never')
  first.catch(() => {})
  const rest = Array.from({ length: 255 }, () => { const p = waiters.run(async () => 'never'); p.catch(() => {}); return p })
  assert.equal(waiters.snapshot().waiting, 256)
  await assert.rejects(waiters.run(async () => 'one too many'), error => error.status === 429 && /Too many thumbnails are waiting/.test(error.message))
  const fire = () => { const fn = timer; timer = null; fn() }
  now = 119999; fire()
  assert.equal(waiters.snapshot().waiting, 256)
  now = 120000; fire()
  await assert.rejects(first, error => error.status === 429 && /waiting behind other processing/.test(error.message))
  await Promise.allSettled(rest)
  assert.equal(waiters.snapshot().waiting, 0)
  assert.equal(timer, null, 'no timer runs when nothing waits')
})

test('a failure of the work itself is passed on, and the next request still runs', async () => {
  const processing = createProcessingAdmission()
  const waiters = createDerivativeWaiters({ admit: work => processing.run(work) })
  const broken = waiters.run(async () => { throw new Error('ffmpeg failed') })
  const next = waiters.run(async () => 'ok')
  await assert.rejects(broken, /ffmpeg failed/)
  assert.equal(await next, 'ok')
})

test('a list for proxies names proxies when it refuses, and never gives up on a waiting one', async () => {
  let now = 0, timer = null
  const busy = () => { const error = new Error('Processing queue is full. Wait for an active operation to finish.'); error.status = 429; throw error }
  const waiters = createDerivativeWaiters({ what: 'proxies', limit: 1, maxWait: Infinity, admit: busy, now: () => now, setTimer: fn => { timer = fn; return 1 }, clearTimer: () => { timer = null } })
  let settled = false
  waiters.run(async () => 'proxy').then(() => { settled = true }, () => { settled = true })
  await assert.rejects(waiters.run(async () => 'second'), /^Error: Too many proxies are waiting\. Try again in a moment\.$/)
  now = 24 * 3600 * 1000; timer(); await turn()
  assert.equal(settled, false)
  assert.deepEqual(waiters.snapshot(), { waiting: 1, admitted: 0 })
})

test('the server sends import proxies and pre-warmed filmstrips through the waiting lists', async () => {
  const fs = await import('node:fs')
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(server, /const proxyWaiters = createDerivativeWaiters\(\{ what: 'proxies', share: 2, maxWait: Infinity, admit: work => processing\.submit\(work, captureProcessing\(\)\)\.promise \}\)/)
  assert.match(server, /async function ensureProxy\(rel, asset\) \{\n  if \(!asset\?\.proxy \|\| fs\.existsSync\(path\.join\(ROOT, asset\.proxy\)\)\) return\n  return proxyWaiters\.run\(\(\) => makeProxy\(rel, asset\)\)\n\}/)
  assert.match(server, /if \(asset\.hasVideo && !asset\.proxy\) waitForSourceDerivative\(\(\) => filmstrip\(src\)\)\.catch\(\(\) => \{\}\)/)
  assert.equal(server.match(/processing\.submit\(\(\) => makeProxy/g), null, 'no proxy goes straight to the queue')
})

test('a filmstrip or waveform already in the cache is answered without waiting for a processing slot', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-cached-strip-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pick = (from, to) => { const start = server.indexOf(from), end = server.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return server.slice(start, end) }
  const cachedStrip = pick('async function cachedFilmstrip(', '\nasync function filmstrip('), cachedWave = pick('async function cachedPeaks(', '\nasync function peaks(')
  const routes = `${pick("  'GET /api/strip':", "\n  'POST /api/analyze'")}`
  const waited = [], meta = path.join(dir, 'strip.json'), wave = path.join(dir, 'peaks.json')
  const values = { fs, path, project: { assets: { 'media/a.mp4': { hasVideo: true, hasAudio: true } } }, waited,
    filmstripCache: async () => ({ meta }), peaksCache: async () => ({ file: wave, out: wave, meta: wave }),
    filmstrip: async () => ({ made: 'strip' }), peaks: async () => ({ made: 'peaks' }),
    // The queue is busy: a request that asks for a slot never gets one in this test.
    waitForSourceDerivative: work => { waited.push(work); return new Promise(() => {}) } }
  const made = new Function(...Object.keys(values), `${cachedStrip}\n${cachedWave}\nreturn { ${routes} }`)(...Object.values(values))
  const query = new URLSearchParams({ src: 'media/a.mp4' })
  const settled = promise => Promise.race([promise.then(value => ({ value })), new Promise(resolve => setTimeout(() => resolve({ waiting: true }), 50))])
  assert.deepEqual(await settled(made['GET /api/strip']({}, query)), { waiting: true }, 'a strip that has to be made waits for a slot')
  assert.equal(waited.length, 1)
  fs.writeFileSync(meta, JSON.stringify({ frames: 12, cached: true }))
  assert.deepEqual(await settled(made['GET /api/strip']({}, query)), { value: { frames: 12, cached: true } })
  assert.equal(waited.length, 1, 'the cached strip asked for no slot')
  assert.deepEqual(await settled(made['GET /api/strip']({}, new URLSearchParams({ src: 'media/unknown.mp4' }))), { waiting: true }, 'an unknown source goes to the queued path, which reports it')
})
