import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createProcessingAdmission, captureProcessingIdentity } from '../core/processing-admission.mjs'
import { runProcessingProcess } from '../core/processing-process.mjs'
import { reserveProcessingWorker, armProcessingWorkerCancellation, acknowledgeProcessingWorkerExit } from '../core/processing-worker.mjs'
import { validateExportSpec, buildDecoderPlans, EXPORT_LIMITS } from '../core/processing-export.js'
import audioRoutes from '../routes/audio.mjs'
import analysisRoutes from '../routes/analysis.mjs'
import { createTranscriptRoutes } from '../routes/transcript.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const turn = () => new Promise(resolve => setImmediate(resolve))
function fakeChild() { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kills = []; child.kill = signal => { child.kills.push(signal); return true }; return child }
const snapshot = { width: 1920, height: 1080, fps: 30, duration: 10 }

// These gates control actual operation/child settlement, independently of Stop receipts.
test('one shared FIFO holds eight operations across workload classes and rejects the ninth before work', async () => {
  const gate = deferred(), admission = createProcessingAdmission(), starts = []
  const tickets = ['export', 'analysis', 'transcript', 'strip', 'peaks', 'clean', 'sync', 'frame'].map((kind, index) => admission.submit(async () => { starts.push(kind); if (!index) await gate.promise }))
  assert.deepEqual(admission.snapshot(), { capacity: 8, concurrency: 1, active: 1, queued: 7, draining: 0 })
  assert.throws(() => admission.submit(() => starts.push('overflow')), error => error.status === 429)
  gate.resolve(); await Promise.all(tickets.map(ticket => ticket.promise))
  assert.deepEqual(starts, ['export', 'analysis', 'transcript', 'strip', 'peaks', 'clean', 'sync', 'frame'])
  assert.equal(admission.snapshot().active, 0)
})
test('queued cancellation allocates nothing and removes only that queue entry', async () => {
  const admission = createProcessingAdmission(), gate = deferred(); let allocations = 0
  const first = admission.submit(() => gate.promise), queued = admission.submit(() => allocations++)
  queued.cancel(); await assert.rejects(queued.promise, { name: 'AbortError' })
  assert.equal(allocations, 0); assert.equal(admission.snapshot().queued, 0)
  gate.resolve(); await first.promise
})
test('Stop keeps the slot until an actual cancelled child close, even after child error', async () => {
  const admission = createProcessingAdmission(), child = fakeChild(), starts = []
  const first = admission.submit(lease => lease.child(() => runProcessingProcess('fixture', [], { signal: lease.signal, spawn: () => child })))
  const second = admission.submit(() => starts.push('next'))
  await turn(); first.cancel(); child.emit('error', new Error('late error')); await turn()
  assert.deepEqual(child.kills, ['SIGTERM']); assert.equal(admission.snapshot().draining, 1); assert.deepEqual(starts, [])
  child.emit('close', null); await assert.rejects(first.promise, { name: 'AbortError' }); await second.promise
  assert.deepEqual(starts, ['next'])
})
test('admission shutdown removes queued operations but waits for active drain', async () => {
  const admission = createProcessingAdmission(), gate = deferred()
  const first = admission.submit(() => gate.promise), second = admission.submit(() => assert.fail('queued work started'))
  admission.close(); await assert.rejects(second.promise, { name: 'AbortError' })
  assert.equal(admission.snapshot().active, 1); assert.equal(admission.snapshot().draining, 1)
  gate.resolve(); await assert.rejects(first.promise, { name: 'AbortError' }); assert.equal(admission.snapshot().active, 0)
})
test('nested Promise.all child work stays serial inside one reservation', async () => {
  const admission = createProcessingAdmission(), gate = deferred(), starts = []
  const work = admission.run(lease => Promise.all([lease.child(async () => { starts.push(1); await gate.promise }), lease.child(() => starts.push(2))]))
  await turn(); assert.deepEqual(starts, [1]); gate.resolve(); await work; assert.deepEqual(starts, [1, 2])
})
test('queued jobs keep their originating async context', async () => {
  const origin = new AsyncLocalStorage(), admission = createProcessingAdmission(), gate = deferred(), seen = []
  const first = origin.run('first', () => admission.submit(async () => { seen.push(origin.getStore()); await gate.promise }))
  const second = origin.run('second', () => admission.submit(() => seen.push(origin.getStore())))
  gate.resolve(); await Promise.all([first.promise, second.promise]); assert.deepEqual(seen, ['first', 'second'])
})
test('a project switch rejects queued work before allocation', async () => {
  const admission = createProcessingAdmission(), gate = deferred(); let identity = { epoch: 1, version: 2, disk: 'a' }, allocations = 0
  const first = admission.submit(() => gate.promise)
  const queued = admission.submit(() => allocations++, captureProcessingIdentity(() => identity))
  identity = { epoch: 2, version: 2, disk: 'b' }; gate.resolve(); await first.promise
  await assert.rejects(queued.promise, /project changed/); assert.equal(allocations, 0)
})
test('a late output cannot publish after a composition edit or external disk change', async () => {
  for (const change of [{ version: 3 }, { disk: 'external' }]) {
    let identity = { epoch: 1, version: 2, disk: 'a' }, publications = 0
    const admission = createProcessingAdmission(), gate = deferred()
    const work = admission.submit(async lease => { await gate.promise; lease.check(); publications++ }, captureProcessingIdentity(() => identity))
    identity = { ...identity, ...change }; gate.resolve(); await assert.rejects(work.promise, /project changed/); assert.equal(publications, 0)
  }
})
test('an owned committed edit can advance the captured version', async () => {
  const admission = createProcessingAdmission(); let identity = { epoch: 1, version: 2, disk: 'a' }
  await admission.run(lease => { identity = { ...identity, version: 3, disk: 'b' }; lease.accept(); lease.check() }, captureProcessingIdentity(() => identity))
})
test('output overflow kills a child and waits for close before release', async () => {
  const child = fakeChild(); let settled = false
  const work = runProcessingProcess('fixture', [], { spawn: () => child, maxBuffer: 3 }).finally(() => { settled = true })
  child.stdout.emit('data', Buffer.from('four')); await turn(); assert.equal(settled, false); assert.deepEqual(child.kills, ['SIGTERM'])
  child.emit('close', 0); await assert.rejects(work, /memory limit/)
})
test('child spawn error is not a drain acknowledgement', async () => {
  const child = fakeChild(); let settled = false
  const work = runProcessingProcess('fixture', [], { spawn: () => child }).finally(() => { settled = true })
  child.emit('error', new Error('spawn failed')); await turn(); assert.equal(settled, false)
  child.emit('close', -1); await assert.rejects(work, /spawn failed/)
})
test('worker Stop retains the slot until both worker cleanup and encoder close, in either order', async () => {
  for (const workerFirst of [true, false]) {
    const admission = createProcessingAdmission(), encoder = deferred(), job = { id: 'worker', state: 'queued' }; let next = false, cancellations = 0
    const state = reserveProcessingWorker(admission, job, { assertCurrent() {}, ensureWorker: async () => {}, dispatch() {}, cancel: () => cancellations++, waitEncoder: () => encoder.promise })
    await turn(); const second = admission.submit(() => { next = true }); job.state = 'failed'; state.ticket.cancel(); await turn()
    assert.equal(cancellations, 1); assert.equal(next, false)
    if (workerFirst) state.acknowledge(); else encoder.resolve()
    await turn(); assert.equal(next, false); assert.equal(admission.snapshot().active, 1)
    if (workerFirst) encoder.resolve(); else state.acknowledge()
    await assert.rejects(state.ticket.promise, { name: 'AbortError' }); await second.promise; assert.equal(next, true)
  }
})
test('worker queued Stop does not launch a worker or await an acknowledgement', async () => {
  const admission = createProcessingAdmission(), gate = deferred(); const first = admission.submit(() => gate.promise); let launches = 0
  const state = reserveProcessingWorker(admission, { id: 'queued' }, { assertCurrent() {}, ensureWorker: async () => launches++, dispatch() {}, cancel() {} })
  state.ticket.cancel(); await assert.rejects(state.ticket.promise, { name: 'AbortError' }); assert.equal(launches, 0)
  gate.resolve(); await first.promise
})
test('failure before worker dispatch releases the reservation without a fictitious drain', async () => {
  const admission = createProcessingAdmission()
  const state = reserveProcessingWorker(admission, { id: 'failure' }, { assertCurrent() {}, ensureWorker: async () => {}, dispatch: () => { throw new Error('output refused') }, cancel() {} })
  await assert.rejects(state.ticket.promise, /output refused/); assert.equal(admission.snapshot().active, 0)
})
test('export spec bounds reject nonfinite and oversized values before allocation', () => {
  const invalid = [{ width: Infinity }, { width: 8194 }, { width: 8192, height: 8192 }, { fps: NaN }, { fps: 121 }, { range: { in: 0, out: Infinity } }, { range: { in: -1, out: 10 } }, { range: { in: 0, out: 3601 } }, { fps: 120, range: { in: 0, out: 3600 } }, { width: 1919 }, { range: { in: 2, out: 1 } }]
  for (const spec of invalid) assert.throws(() => validateExportSpec(spec, snapshot))
  assert.equal(validateExportSpec({}, snapshot).frames, 300)
  assert.equal(validateExportSpec({ width: 8192, height: 4096, fps: 60, range: { in: 0, out: 3600 } }, snapshot).frames, 216000)
  assert.throws(() => validateExportSpec({ at: NaN }, snapshot, { frame: true }), /Frame time/)
})
test('decoder planning bounds readers and total timestamps without allocating the rest', async () => {
  const spec = validateExportSpec({}, snapshot), limits = { ...EXPORT_LIMITS, maximumDecoderInstances: 2, maximumSourceTimes: 3 }
  await assert.rejects(buildDecoderPlans(spec, {}, () => [0, 1, 2].map(key => ({ key, url: 'media', srcTime: 0, fps: 30 })), t => t, { limits }), /decoder limit/)
  await assert.rejects(buildDecoderPlans(spec, {}, (_p, at) => [{ key: 'one', url: 'media', srcTime: at, fps: 30 }], t => t, { limits }), /timestamp/)
  await assert.rejects(buildDecoderPlans({ ...spec, frames: Infinity }, {}, () => [], t => t), /planning bounds/)
})
test('decoder planning yields and observes cancellation before the next expansion chunk', async () => {
  let cancelled = false, calls = 0
  await assert.rejects(buildDecoderPlans(validateExportSpec({}, snapshot), {}, () => { calls++; return [] }, t => t, { check: () => { if (cancelled) throw new Error('fixture Stop') }, yieldTask: async () => { cancelled = true } }), /fixture Stop/)
  assert.equal(calls, 128)
})
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-admission-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'media')); fs.writeFileSync(path.join(root, 'media', 'source.mp4'), 'source'); fs.writeFileSync(path.join(root, 'model.bin'), 'fixture')
  const project = { ...snapshot, tracks: [], assets: { 'media/source.mp4': { duration: 10, fps: 30, width: 1920, height: 1080, hasVideo: true, hasAudio: true } } }
  const admission = createProcessingAdmission(); let identity = { epoch: 1, version: 1, disk: 'project' }
  const ctx = { ROOT: root, getProject: () => project, getVersion: () => identity.version, getProjectGeneration: () => identity.epoch, resolveMedia: src => path.join(root, src), assertCurrent: () => admission.current()?.check(), assertCapacity: admission.assertCapacity, captureProcessing: () => captureProcessingIdentity(() => identity), cacheKey: async () => 'fixture', broadcast() {}, pushActivity() {}, checkAgentFile() {},
    admit: (work, options) => admission.run(work, options ?? captureProcessingIdentity(() => identity)), editOps: async () => { assert.fail('stale output edited the project') }, probe: async () => project.assets['media/source.mp4'] }
  return { root, project, admission, ctx, change: () => { identity = { ...identity, version: identity.version + 1 } } }
}
test('actual retime route queues without creating its output directory and rejects a changed project', async t => {
  const f = fixture(t), gate = deferred(), active = f.admission.submit(() => gate.promise); let processes = 0
  f.ctx.run = async () => { processes++ }
  const routes = analysisRoutes(f.ctx).routes
  const job = await routes['POST /api/retime']({ src: 'media/source.mp4', speed: .5 })
  assert.equal(job.state, 'queued'); assert.equal(fs.existsSync(path.join(f.root, 'media', 'retimed')), false)
  f.change(); gate.resolve(); await active.promise; await turn()
  const current = routes['GET /api/analysis/jobs']().jobs[0]
  assert.equal(current.state, 'failed'); assert.match(current.error, /project changed/); assert.equal(processes, 0)
})
test('actual retime Stop holds admission until the injected child closes, then starts the next operation', async t => {
  const f = fixture(t), child = fakeChild(); let next = false
  f.ctx.run = (command, args, options) => f.admission.current().child(lease => runProcessingProcess(command, args, { ...options, signal: lease.signal, spawn: () => child }))
  const routes = analysisRoutes(f.ctx).routes, job = await routes['POST /api/retime']({ src: 'media/source.mp4', speed: .5 })
  await turn(); const second = f.admission.submit(() => { next = true })
  routes['POST /api/analysis/jobs/cancel']({ id: job.id }); await turn(); assert.equal(next, false); assert.deepEqual(child.kills, ['SIGTERM'])
  child.emit('close', null); await second.promise; await turn()
  assert.equal(routes['GET /api/analysis/jobs']().jobs[0].state, 'cancelled'); assert.equal(next, true)
})
test('actual transcript admission creates no staging directory while queued and rejects a changed project', async t => {
  const f = fixture(t), gate = deferred(), active = f.admission.submit(() => gate.promise), jobs = []; let processes = 0
  const service = createTranscriptRoutes({ root: f.root, resolveMedia: f.ctx.resolveMedia, getProject: () => f.project, getVersion: () => 1, newJob: (kind, spec) => { const job = { id: 'transcript', kind, spec, state: 'queued' }; jobs.push(job); return job }, publish() {}, findWhisper: async () => 'fixture', modelPaths: [path.join(f.root, 'model.bin')], process: async () => processes++, admit: f.ctx.admit, captureProcessing: f.ctx.captureProcessing, assertCapacity: f.ctx.assertCapacity, assertPublication: f.ctx.assertCurrent })
  const job = await service.transcribe({ src: 'media/source.mp4', wait: false })
  assert.equal(job.state, 'queued'); assert.equal(fs.existsSync(path.join(f.root, '.reel', 'transcripts')), false)
  f.change(); gate.resolve(); await active.promise; await turn()
  assert.equal(jobs[0].state, 'failed'); assert.match(jobs[0].error, /project changed/); assert.equal(processes, 0)
})

test('the reserved child queue rejects a ninth process before it allocates', async () => {
  const admission = createProcessingAdmission(), gate = deferred(); let allocations = 0
  await admission.run(async lease => {
    const children = Array.from({ length: 8 }, (_, index) => lease.child(async () => { allocations++; if (!index) await gate.promise }))
    await assert.rejects(lease.child(() => assert.fail('ninth child started')), error => error.status === 429)
    assert.equal(allocations, 1); gate.resolve(); await Promise.all(children)
  })
  assert.equal(allocations, 8)
})
test('actual audio cleanup rejects a late measurement before staging or project mutation', async t => {
  const f = fixture(t), gate = deferred(); let commands = 0
  Object.assign(f.ctx, { once: (_key, work) => work(), run: async () => { commands++; await gate.promise; return { stdout: 'RMS_level=-60' } } })
  const routes = audioRoutes(f.ctx).routes
  const work = routes['POST /api/audio/clean']({ src: 'media/source.mp4', mode: 'denoise' })
  await turn(); f.change(); gate.resolve(); await assert.rejects(work, /project changed/)
  assert.equal(commands, 1); assert.deepEqual(fs.readdirSync(path.join(f.root, 'media', 'cleaned')), [])
})

test('worker cancellation escalates after 15 seconds while retaining admission until actual exit', async () => {
  const admission = createProcessingAdmission(), job = { id: 'owned', state: 'queued' }, worker = fakeChild(), timers = [], cleared = []
  const state = reserveProcessingWorker(admission, job, { assertCurrent() {}, ensureWorker: async () => {}, dispatch() {}, cancel() {} })
  await turn(); state.ticket.cancel()
  const disarm = armProcessingWorkerCancellation(worker, { isCurrent: () => true, isDrained: () => state.drained, setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer }, clearTimer: timer => cleared.push(timer) })
  assert.equal(timers[0].delay, 15000); timers[0].callback(); assert.deepEqual(worker.kills, ['SIGTERM'])
  assert.equal(timers[1].delay, 1500); timers[1].callback(); assert.deepEqual(worker.kills, ['SIGTERM', 'SIGKILL']); assert.equal(admission.snapshot().active, 1)
  state.acknowledge(); await assert.rejects(state.ticket.promise, { name: 'AbortError' }); disarm(); assert.equal(admission.snapshot().active, 0); assert.equal(cleared.length, 2)
})
test('worker cancellation timer cannot kill a replacement process or a drained worker', () => {
  for (const current of [false, true]) { const worker = fakeChild(), timers = []
    const disarm = armProcessingWorkerCancellation(worker, { isCurrent: () => current, isDrained: () => current, setTimer: callback => { timers.push(callback); return 1 }, clearTimer() {} })
    timers[0](); assert.deepEqual(worker.kills, []); disarm()
  }
})

test('an old worker exit cannot fail or drain a reservation assigned to its replacement', () => {
  const oldWorker = {}, replacement = {}, failed = []
  const old = { id: 'old', processing: { dispatched: true, drained: false, worker: oldWorker, acknowledge() { this.drained = true } } }
  const next = { id: 'next', processing: { dispatched: true, drained: false, worker: replacement, acknowledge() { this.drained = true } } }
  acknowledgeProcessingWorkerExit([old, next], oldWorker, job => failed.push(job.id))
  assert.deepEqual(failed, ['old']); assert.equal(old.processing.drained, true); assert.equal(next.processing.drained, false)
  acknowledgeProcessingWorkerExit([old, next], replacement, job => failed.push(job.id))
  assert.deepEqual(failed, ['old', 'next']); assert.equal(next.processing.drained, true)
})
