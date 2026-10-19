// A render worker that stops making progress fails its job instead of holding the queue, and a
// worker that is slow but alive, or a job the server is finishing, is never failed.
// Seen on 2026-10-09: three exports stopped at 80 to 96 % with the worker page unresponsive, and
// every later export queued behind them until a manual cancel.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkerWatchdog, failStalledWorkerJob, noteWorkerActivity, stalledWorkerJobs, WORKER_STALL_MS, workerSetupLimit, workerStallLimit } from '../core/processing-worker.mjs'

function job(state = 'queued', spec = { width: 1920, height: 1080, range: { in: 0, out: 60 } }, worker = { exitCode: null, signalCode: null }) {
  const value = { state, spec, acknowledged: 0 }
  value.processing = { dispatched: true, drained: false, worker, acknowledge() { value.acknowledged++; this.drained = true } }
  return value
}
const minutes = n => n * 60000

test('a slow setup with heartbeats is not failed; a silent one is, and so is an endless one', () => {
  const alive = job(), silent = job(), endless = job()
  for (const j of [alive, silent, endless]) noteWorkerActivity(j, 0, 'dispatch')
  // Audio render and upload take five minutes; the page sends heartbeats every 5 s.
  for (let t = 5000; t <= minutes(5); t += 5000) { noteWorkerActivity(alive, t, 'heartbeat'); noteWorkerActivity(endless, t, 'heartbeat') }
  assert.deepEqual(stalledWorkerJobs([alive, silent, endless], minutes(5)), [silent], 'a page silent for two minutes during setup is stuck')
  // Heartbeats alone do not keep setup going forever: the cap is 10 min + 0.5 s per range second.
  assert.equal(workerSetupLimit(endless), minutes(10) + 30000)
  for (let t = minutes(5); t <= minutes(11); t += 5000) noteWorkerActivity(endless, t, 'heartbeat')
  assert.deepEqual(stalledWorkerJobs([endless], minutes(11)), [endless])
})

test('the first batch is measured from the start of rendering, so a slow first batch raises the limit', () => {
  const j = job()
  noteWorkerActivity(j, 0, 'dispatch')
  j.state = 'running'
  noteWorkerActivity(j, 1000, 'setup') // start
  for (let t = 6000; t <= 151000; t += 5000) noteWorkerActivity(j, t, 'heartbeat')
  assert.deepEqual(stalledWorkerJobs([j], 151000), [], 'heartbeats cover 150 s of decoder planning before the first batch')
  noteWorkerActivity(j, 151000, 'batch')
  assert.equal(j.longestWorkerGap, 150000)
  assert.equal(workerStallLimit(j), 20 * 150000 > minutes(30) ? minutes(30) : 20 * 150000)
  // After the first batch, heartbeats no longer count: an alive page that sends no frames is stuck.
  noteWorkerActivity(j, 151000 + minutes(10), 'heartbeat')
  assert.equal(j.lastWorkerActivity, 151000)
  assert.deepEqual(stalledWorkerJobs([j], 151000 + minutes(30)), [j], 'capped at 30 minutes')
})

test('the frame limit scales with frame size and batch speed', () => {
  assert.equal(workerStallLimit(job('running')), WORKER_STALL_MS)
  assert.equal(workerStallLimit(job('running', { width: 3840, height: 2160 })), 4 * WORKER_STALL_MS)
  const steady = job('running')
  noteWorkerActivity(steady, 0, 'dispatch'); noteWorkerActivity(steady, 0, 'setup')
  for (let t = 300; t <= 3000; t += 300) noteWorkerActivity(steady, t, 'batch')
  assert.deepEqual(stalledWorkerJobs([steady], 3000 + WORKER_STALL_MS - 1), [])
  assert.deepEqual(stalledWorkerJobs([steady], 3000 + WORKER_STALL_MS), [steady])
})

test('a job the server is finishing (encoder close, faststart, source check) is never failed', () => {
  const j = job('running')
  noteWorkerActivity(j, 0, 'dispatch'); noteWorkerActivity(j, 0, 'setup'); noteWorkerActivity(j, 1000, 'batch')
  j.finishing = true
  assert.deepEqual(stalledWorkerJobs([j], minutes(45)), [])
})

function watchdog(j) {
  const clock = { now: 0 }, failed = []
  const check = createWorkerWatchdog({ jobs: () => [j], failJob: (x, message) => { x.state = 'failed'; failed.push(message) }, clock: () => clock.now })
  return { clock, failed, tick: ms => { clock.now += ms; check() } }
}

test('a server stall during a slow batch is taken out of that batch, so the limit still grows', () => {
  const j = job('running')
  const w = watchdog(j)
  noteWorkerActivity(j, 0, 'dispatch'); noteWorkerActivity(j, 0, 'setup'); noteWorkerActivity(j, 1000, 'batch')
  w.tick(10000); w.tick(10000) // 20 s: normal checks while the worker renders a slow batch
  w.tick(10000 + 60000) // the server froze for 60 s; this check fires 60 s late
  assert.equal(j.lastWorkerActivity, 1000 + 60000, 'the stamp moved forward by the jump, not to now')
  w.clock.now += 5000
  noteWorkerActivity(j, w.clock.now, 'batch') // the batch arrives 94 s after the last one, 34 s of it worker time
  assert.equal(j.longestWorkerGap, 34000)
  assert.equal(workerStallLimit(j), 20 * 34000)
  assert.deepEqual(w.failed, [])
})

test('repeated server stalls cannot keep restarting a real hang; it fails within one limit plus the stall time', () => {
  const j = job('running')
  const w = watchdog(j)
  noteWorkerActivity(j, 0, 'dispatch'); noteWorkerActivity(j, 0, 'setup'); noteWorkerActivity(j, 1000, 'batch')
  let stalled = 0
  // The worker hangs after its batch at 1 s. Every other check, the server freezes for 30 s.
  for (let i = 0; i < 40 && !w.failed.length; i++) {
    if (i % 2) { w.tick(10000 + 30000); stalled += 30000 } else w.tick(10000)
  }
  assert.equal(w.failed.length, 1)
  assert.match(w.failed[0], /render worker sent nothing for 120 s/)
  assert.ok(w.clock.now <= 1000 + WORKER_STALL_MS + stalled + 10000, `failed at ${w.clock.now} ms after ${stalled} ms of stalls`)
  assert.ok(w.clock.now - stalled >= 1000 + WORKER_STALL_MS, 'and not before the worker itself was silent for the limit')
})

test('a stall during setup moves the setup clocks without restarting them', () => {
  const j = job('queued')
  const w = watchdog(j)
  noteWorkerActivity(j, 0, 'dispatch')
  for (let t = 5000; t <= 60000; t += 5000) { noteWorkerActivity(j, t, 'heartbeat'); if (t % 10000 === 0) w.tick(10000) }
  w.tick(10000 + 120000) // a two-minute server stall
  assert.equal(j.workerDispatchedAt, 120000)
  assert.equal(j.lastWorkerActivity, 60000 + 120000)
  // No heartbeat arrives after the stall: the page fails one floor after its last heartbeat, stall excluded.
  for (let i = 0; i < 20 && !w.failed.length; i++) w.tick(10000)
  assert.equal(w.failed.length, 1)
  assert.ok(w.clock.now - 120000 - 60000 >= WORKER_STALL_MS && w.clock.now - 120000 - 60000 < WORKER_STALL_MS + 10000)
})

test('a stalled job fails with a clear message; its reservation drains at once when the worker is gone', () => {
  const failures = []
  const fail = (j, message) => { j.state = 'failed'; failures.push(message) }
  const alive = job('running')
  noteWorkerActivity(alive, 0, 'dispatch'); noteWorkerActivity(alive, 0, 'setup'); noteWorkerActivity(alive, 10, 'batch')
  failStalledWorkerJob(alive, fail, minutes(3))
  assert.match(failures[0], /render worker sent nothing for 120 s/)
  assert.equal(alive.acknowledged, 0, 'a live worker drains through its own exit after the cancel grace period')
  const stuck = job('queued', undefined, { exitCode: 0, signalCode: null })
  noteWorkerActivity(stuck, 0, 'dispatch')
  for (let t = 5000; t <= minutes(11); t += 5000) noteWorkerActivity(stuck, t, 'heartbeat')
  failStalledWorkerJob(stuck, fail, minutes(11))
  assert.match(failures[1], /still preparing this export after 630 s/)
  assert.equal(stuck.acknowledged, 1)
})
