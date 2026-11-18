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
