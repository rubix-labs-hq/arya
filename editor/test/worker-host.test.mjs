// The render worker process is replaced when it cannot serve, instead of failing every later
// frame and export until the server restarts. Seen in three editing sessions: a worker Chrome
// alive at 0 % CPU for 12 to 40 minutes while every request answered "the render worker did not
// start".
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { acknowledgeProcessingWorkerExit, createProcessingWorkerHost, createWorkerWatchdog, failStalledWorkerJob, noteWorkerActivity, retireProcessingWorker, workerClosedMessage, workerStartLimit } from '../core/processing-worker.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))

/** A clock whose timers fire only when the test advances it. */
function fakeClock() {
  let at = 0
  const timers = new Set()
  return {
    now: () => at,
    setTimer(fn, ms) { const timer = { fn, due: at + ms, unref() {} }; timers.add(timer); return timer },
    clearTimer(timer) { timers.delete(timer) },
    async advance(ms) {
      for (const end = at + ms; at < end;) {
        at = Math.min(end, at + 50)
        for (const timer of [...timers]) if (timer.due <= at && timers.delete(timer)) timer.fn()
        await turn()
      }
    },
  }
}

/** A child process that records its signals. `obeys` lists the signals that make it exit. */
function child(obeys = ['SIGTERM', 'SIGKILL']) {
  const value = new EventEmitter()
  value.pid = 4000 + Math.floor(Math.random() * 1000); value.exitCode = null; value.signalCode = null; value.kills = []
  value.kill = signal => { value.kills.push(signal); if (obeys.includes(signal) && value.signalCode === null) { value.signalCode = signal; queueMicrotask(() => value.emit('exit', null, signal)) } return true }
  return value
}

function fixture(make = () => child()) {
  const clock = fakeClock(), clients = new Set(), launched = [], logs = [], lost = [], exits = []
  const host = createProcessingWorkerHost({
    launch: token => { const value = make(launched.length); value.token = token; launched.push(value); return value },
    clients, onExit: worker => exits.push(worker), onLost: worker => lost.push(worker), log: line => logs.push(line),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  })
  const connect = (worker = host.current, token = worker?.token) => {
    if (!host.accepts(token)) return null
    const client = { role: 'worker', res: { end() { client.ended = true } } }
    host.attach(client); clients.add(client)
    return client
  }
  const close = client => { clients.delete(client); host.detached(client) }
  /** Runs ensure() and reports how it settled without leaving a rejection unhandled. */
  const ensure = signal => { const result = { settled: false }; host.ensure(signal).then(() => { result.settled = true; result.ok = true }, error => { result.settled = true; result.error = error }); return result }
  return { clock, clients, launched, logs, lost, exits, host, connect, close, ensure }
}

test('a worker that connects serves the request, and later requests reuse it', async () => {
  const f = fixture(), first = f.ensure()
  await f.clock.advance(300)
  assert.equal(f.launched.length, 1); assert.equal(first.settled, false)
  f.connect()
  await f.clock.advance(200)
  assert.equal(first.ok, true)
  const second = f.ensure(); await f.clock.advance(50)
  assert.equal(second.ok, true); assert.equal(f.launched.length, 1)
  assert.ok(f.logs.some(line => /render worker connected 300 ms after it started/.test(line)), String(f.logs))
})

test('a worker that never connects is killed after 20 s and the next request starts a new one', async () => {
  // The first process ignores SIGTERM, as a stopped or hung Chrome does.
  const f = fixture(index => child(index === 0 ? ['SIGKILL'] : undefined)), first = f.ensure()
  await f.clock.advance(19900)
  assert.equal(first.settled, false); assert.deepEqual(f.launched[0].kills, [])
  await f.clock.advance(2000)
  assert.match(first.error.message, /render worker did not start/)
  assert.deepEqual(f.launched[0].kills, ['SIGTERM', 'SIGKILL'], 'SIGKILL follows 1.5 s after an ignored SIGTERM')
  assert.equal(f.host.current, null, 'the dead handle is not kept')
  const second = f.ensure(); await f.clock.advance(300)
  assert.equal(f.launched.length, 2, 'the next request starts a new worker')
  f.connect(); await f.clock.advance(200)
  assert.equal(second.ok, true); assert.equal(f.host.current, f.launched[1])
})

test('a request that finds an old unconnected worker replaces it and waits for the new one', async () => {
  const f = fixture(), abort = new AbortController(), cancelled = f.ensure(abort.signal)
  await f.clock.advance(300)
  abort.abort(); await f.clock.advance(200)
  assert.equal(cancelled.error.name, 'AbortError')
  // No request is waiting when the 20 s pass, and the process ignores every signal.
  const stuck = f.launched[0]
  stuck.kill = signal => { stuck.kills.push(signal); return true }
  await f.clock.advance(25000)
  assert.equal(f.host.current, stuck, 'nothing replaces it until a request needs a worker')
  const next = f.ensure(); await f.clock.advance(3000)
  assert.deepEqual(stuck.kills, ['SIGTERM', 'SIGKILL']); assert.equal(f.launched.length, 1, 'waits a bounded time for the old process')
  await f.clock.advance(1000)
  assert.equal(f.launched.length, 2, 'a process that will not die is dropped and replaced')
  f.connect(); await f.clock.advance(200)
  assert.equal(next.ok, true); assert.equal(f.host.current, f.launched[1])
})

test('a slow machine gets a longer start limit after each start that never connected', async () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(workerStartLimit), [20000, 40000, 80000, 80000, 80000])
  const f = fixture(), first = f.ensure()
  await f.clock.advance(22000)
  assert.match(first.error.message, /did not start/); assert.equal(f.launched.length, 1)
  // The second process may take 40 s. A request gives up after 20 s but leaves it running.
  const second = f.ensure(); await f.clock.advance(21000)
  assert.match(second.error.message, /did not start in 20 s/)
  assert.equal(f.launched.length, 2); assert.deepEqual(f.launched[1].kills, [], 'still inside its 40 s limit')
  // It connects 30 s after it started, and the waiting request is served by it.
  const third = f.ensure(); await f.clock.advance(9000)
  f.connect(); await f.clock.advance(200)
  assert.equal(third.ok, true); assert.equal(f.launched.length, 2)
})

test('a worker that never connects is stopped at its own start limit when no later request asks', async () => {
  const f = fixture(), first = f.ensure()
  await f.clock.advance(22000)
  assert.match(first.error.message, /did not start/)
  // The second process may take 40 s. Its one request gives up at 20 s and nothing asks again.
  const second = f.ensure(); await f.clock.advance(21000)
  assert.match(second.error.message, /did not start in 20 s/)
  const slow = f.launched[1]
  assert.equal(slow.processingStartLimit, 40000); assert.deepEqual(slow.kills, [])
  await f.clock.advance(20000)
  assert.deepEqual(slow.kills, ['SIGTERM'], 'stopped at 40 s with no request waiting')
  assert.equal(f.host.current, null)
  assert.equal(f.logs.filter(line => /did not connect within 40 s/.test(line)).length, 1, String(f.logs))
  // A third start in a row that never connected gets the longest limit.
  f.ensure(); await f.clock.advance(300)
  assert.equal(f.launched[2].processingStartLimit, 80000)
})

test('a worker that connects in time is not stopped by its start timer', async () => {
  const f = fixture(), first = f.ensure()
  await f.clock.advance(300); f.connect(); await f.clock.advance(200)
  assert.equal(first.ok, true)
  await f.clock.advance(60000)
  assert.deepEqual(f.launched[0].kills, []); assert.equal(f.host.current, f.launched[0])
  assert.equal(f.logs.some(line => /did not connect/.test(line)), false, String(f.logs))
})

test('a worker that connected and then lost its page is replaced without being counted as a failed start', async () => {
  const f = fixture(), first = f.ensure()
  await f.clock.advance(200); const page = f.connect(); await f.clock.advance(200)
  assert.equal(first.ok, true)
  await f.clock.advance(60000)
  f.close(page); await f.clock.advance(500)
  const next = f.ensure(); await f.clock.advance(600)
  assert.equal(f.logs.some(line => /did not connect within/.test(line)), false, String(f.logs))
  assert.ok(f.logs.includes('stopping the render worker: it cannot serve this request'), String(f.logs))
  assert.equal(f.launched.length, 2)
  assert.equal(f.launched[1].processingStartLimit, 20000, 'the replacement keeps the first start limit')
  f.connect(); await f.clock.advance(200)
  assert.equal(next.ok, true)
})

test('a replaced worker that exits late does not clear the worker that replaced it', async () => {
  const f = fixture(index => index === 0 ? child([]) : child())
  f.ensure()
  await f.clock.advance(20400)
  const second = f.ensure()
  await f.clock.advance(15000)
  assert.equal(f.launched.length, 2, 'the replacement started after the wait for the old process')
  f.connect(); await f.clock.advance(300)
  assert.equal(second.ok, true)
  f.launched[0].signalCode = 'SIGKILL'; f.launched[0].emit('exit', null, 'SIGKILL')
  await f.clock.advance(100)
  assert.equal(f.host.current, f.launched[1], 'the new worker is still the current one')
  const third = f.ensure(); await f.clock.advance(300)
  assert.equal(third.ok, true)
  assert.equal(f.launched.length, 2, 'no third process is started')
})

test('an idle stop that ignores SIGTERM gets SIGKILL, and the next request starts a new worker', async () => {
  const f = fixture(index => child(index === 0 ? ['SIGKILL'] : undefined)), first = f.ensure()
  await f.clock.advance(300); f.connect(); await f.clock.advance(200)
  assert.equal(first.ok, true)
  f.host.retire(f.host.current, 'idle for 5 minutes')
  assert.equal(f.host.connected(), false)
  const next = f.ensure(); await f.clock.advance(1000)
  assert.deepEqual(f.launched[0].kills, ['SIGTERM']); assert.equal(f.launched.length, 1, 'the old process must be gone first')
  await f.clock.advance(1000)
  assert.deepEqual(f.launched[0].kills, ['SIGTERM', 'SIGKILL'])
  assert.equal(f.launched.length, 2)
  f.connect(); await f.clock.advance(200)
  assert.equal(next.ok, true)
  assert.ok([...f.clients].every(client => client.worker === f.launched[1]), 'the old page was disconnected')
})

test('a page from a replaced worker cannot connect as the new one', async () => {
  const f = fixture(), first = f.ensure()
  await f.clock.advance(300); const old = f.launched[0]; f.connect(); await f.clock.advance(200)
  assert.equal(first.ok, true)
  f.host.retire(old)
  assert.equal(f.connect(old), null, 'a stopping worker accepts no new page')
  const next = f.ensure(); await f.clock.advance(400)
  assert.equal(f.launched.length, 2)
  assert.equal(f.connect(f.launched[1], old.token), null, 'the old token is refused')
  assert.equal(f.host.connected(), false); assert.equal(next.settled, false)
  f.connect(); await f.clock.advance(200)
  assert.equal(next.ok, true)
})

test('a browser that cannot be started fails the request with a plain message and does not crash', async () => {
  const f = fixture(() => { const value = child(); value.pid = undefined; queueMicrotask(() => value.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))); return value })
  const first = f.ensure(); await f.clock.advance(400)
  assert.match(first.error.message, /could not start Google Chrome to render \(ENOENT\)/)
  assert.equal(f.host.current, null)
  const again = f.ensure(); await f.clock.advance(400)
  assert.equal(f.launched.length, 2, 'the next request tries again'); assert.match(again.error.message, /ENOENT/)
})

function dispatched(worker, kind = 'export') {
  const job = { kind, state: 'running', spec: { width: 1080, height: 1920, range: { in: 0, out: 35 } } }
  job.processing = { dispatched: true, drained: false, worker, acknowledge() { this.drained = true } }
  return job
}
const failer = () => { const failed = []; return Object.assign((job, message) => { job.state = 'failed'; job.error = message; failed.push(job) }, { failed }) }

test('a worker page that closes mid-job fails the job after 5 s and the next request starts a new worker', async () => {
  const jobs = [], fail = failer(), f = fixture()
  const host = f.host
  f.lostHandler = worker => acknowledgeProcessingWorkerExit(jobs, worker, fail, workerClosedMessage)
  const first = f.ensure(); await f.clock.advance(300); const page = f.connect(); await f.clock.advance(200)
  assert.equal(first.ok, true)
  const running = dispatched(host.current), frame = dispatched(host.current, 'frame'), other = dispatched({})
  jobs.push(running, frame, other)
  f.close(page)
  await f.clock.advance(4900)
  assert.equal(running.state, 'running', 'an EventSource reconnects by itself, so the job gets 5 s')
  await f.clock.advance(200)
  for (const worker of f.lost) f.lostHandler(worker)
  assert.equal(f.lost.length, 1)
  assert.equal(running.error, 'The render worker closed while this export was running. Export again.')
  assert.equal(frame.error, 'The render worker closed while this frame was rendering. Try again.')
  assert.equal(frame.workerLost, true, 'the frame route reads this to render the frame once more'); assert.equal(other.workerLost, undefined)
  assert.equal(running.processing.drained, true); assert.equal(other.state, 'running')
  assert.deepEqual(f.launched[0].kills, ['SIGTERM'])
  const next = f.ensure(); await f.clock.advance(300)
  assert.equal(f.launched.length, 2); f.connect(); await f.clock.advance(200)
  assert.equal(next.ok, true)
})

test('a worker page that reconnects within 5 s keeps its job and its process', async () => {
  const f = fixture(), first = f.ensure()
  await f.clock.advance(300); const page = f.connect(); await f.clock.advance(200)
  assert.equal(first.ok, true)
  f.close(page); await f.clock.advance(3000)
  f.connect(); await f.clock.advance(10000)
  assert.equal(f.lost.length, 0); assert.deepEqual(f.launched[0].kills, []); assert.equal(f.host.connected(), true)
})

test('a stalled job whose page answers the cancel still gets its worker stopped, and the next job gets a new one', async () => {
  const f = fixture(), fail = failer(), first = f.ensure()
  await f.clock.advance(300); f.connect(); await f.clock.advance(200)
  assert.equal(first.ok, true)
  const job = dispatched(f.host.current)
  noteWorkerActivity(job, 0, 'dispatch'); noteWorkerActivity(job, 0, 'setup'); noteWorkerActivity(job, 10, 'batch')
  const check = createWorkerWatchdog({ jobs: () => [job], failJob: fail, retireWorker: worker => f.host.retire(worker, 'its job stalled'), clock: () => 10 + 120000, interval: 10 + 120000 })
  check()
  assert.match(job.error, /sent nothing for 120 s, so this export stopped\. Export again\. Arya starts a new render worker and the export starts from the first frame\./)
  job.processing.acknowledge() // the page answered the cancel: before this fix it was kept
  assert.deepEqual(f.launched[0].kills, ['SIGTERM'])
  const next = f.ensure(); await f.clock.advance(400)
  assert.equal(f.launched.length, 2, 'the promise in the message holds: a new worker starts')
  f.connect(); await f.clock.advance(200)
  assert.equal(next.ok, true); assert.equal(f.host.current, f.launched[1])
})

test('retiring is safe to repeat and skips a process that has already exited', () => {
  const timers = [], setTimer = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} } }
  const gone = child(); gone.exitCode = 0
  retireProcessingWorker(gone, { setTimer }); assert.deepEqual(gone.kills, []); assert.equal(timers.length, 0)
  const live = child(['SIGTERM'])
  retireProcessingWorker(live, { setTimer }); retireProcessingWorker(live, { setTimer })
  assert.deepEqual(live.kills, ['SIGTERM']); assert.equal(timers.length, 1); assert.equal(timers[0].ms, 1500)
  timers[0].fn(); assert.deepEqual(live.kills, ['SIGTERM'], 'no SIGKILL once it has exited')
  retireProcessingWorker(null)
})

test('the stall message without a retire callback still works for callers that pass none', () => {
  const fail = failer(), job = dispatched({ exitCode: 0, signalCode: null })
  noteWorkerActivity(job, 0, 'dispatch')
  failStalledWorkerJob(job, fail, 130000)
  assert.equal(job.processing.drained, true)
})
