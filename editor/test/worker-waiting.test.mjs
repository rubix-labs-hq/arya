// What a render job reports while it has not reached the worker, and when a still frame gives up.
// Seen on 2026-11-16: a frame requested behind a 35 s export failed with "frame render timed out"
// after 30 s in the queue without ever reaching the worker, and a queued export showed no reason.
import assert from 'node:assert/strict'
import test from 'node:test'

import { failStalledWorkerJob, FRAME_QUEUE_MS, FRAME_RENDER_MS, frameJobDeadline, noteWorkerActivity, noteWorkerSetupStep, queuedJobWait } from '../core/processing-worker.mjs'

function timers() {
  let now = 0, next = 1
  const pending = new Map()
  return {
    setTimer(fn, ms) { const id = next++; pending.set(id, { fn, at: now + ms }); return id },
    clearTimer(id) { pending.delete(id) },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...pending]) if (timer.at <= now && pending.delete(id)) timer.fn()
    },
    get pending() { return pending.size },
  }
}

test('a frame that waits 40 s in the queue is not failed; its 30 s limit starts when the worker has it', () => {
  const clock = timers(), failures = []
  const deadline = frameJobDeadline(message => failures.push(message), clock)
  clock.advance(40000)
  assert.deepEqual(failures, [], 'time behind a running export does not count against the frame')
  deadline.dispatched()
  clock.advance(FRAME_RENDER_MS - 1)
  assert.deepEqual(failures, [])
  clock.advance(1)
  assert.deepEqual(failures, ['The render worker did not finish this frame in 30 s. Try again.'])
})

test('a frame that never reaches the worker stops after 5 minutes and says why', () => {
  const clock = timers(), failures = []
  frameJobDeadline(message => failures.push(message), clock)
  clock.advance(FRAME_QUEUE_MS - 1)
  assert.deepEqual(failures, [])
  clock.advance(1)
  assert.deepEqual(failures, ['This frame waited 5 minutes behind other processing, so it stopped. Try again when the running export has finished.'])
})

test('a finished frame leaves no timer behind, whether or not it was dispatched', () => {
  for (const dispatch of [false, true]) {
    const clock = timers(), failures = []
    const deadline = frameJobDeadline(message => failures.push(message), clock)
    if (dispatch) deadline.dispatched()
    deadline.clear()
    assert.equal(clock.pending, 0)
    clock.advance(FRAME_QUEUE_MS)
    assert.deepEqual(failures, [])
  }
})

test('a queued job names the render job it is behind, or other processing, and nothing once it has its turn', () => {
  const running = { id: 'a', state: 'running', admissionState: 'running', processing: {} }
  const queued = { id: 'b', state: 'queued', admissionState: 'queued', processing: {} }
  const proxy = { id: 'p', state: 'running' } // not a render job: no reservation
  assert.deepEqual(queuedJobWait(queued, [running, queued, proxy], true), { reason: 'behind-job', job: 'a' })
  running.admissionState = 'cancelling'
  assert.deepEqual(queuedJobWait(queued, [running, queued], true), { reason: 'behind-job', job: 'a' }, 'a stopping job still holds the worker')
  running.admissionState = 'done'
  assert.deepEqual(queuedJobWait(queued, [running, queued, proxy], true), { reason: 'behind-processing' })
  assert.equal(queuedJobWait(queued, [running, queued], false), null)
  queued.admissionState = 'running'
  assert.equal(queuedJobWait(queued, [running, queued], true), null)
})

test('a setup that hangs names the step the page last reported', () => {
  const job = { state: 'queued', spec: { width: 1920, height: 1080, range: { in: 0, out: 60 } } }
  job.processing = { dispatched: true, drained: false, worker: { exitCode: null, signalCode: null } }
  noteWorkerActivity(job, 0, 'dispatch')
  noteWorkerSetupStep(job, 'audio')
  noteWorkerSetupStep(job, 'not a step')
  noteWorkerSetupStep(job, 'constructor')
  assert.equal(job.workerStep, 'audio', 'only the known step names are kept')
  const failures = []
  failStalledWorkerJob(job, (_job, message) => { job.state = 'failed'; failures.push(message) }, 150000)
  assert.equal(failures[0], 'The render worker sent nothing for 120 s (last step: rendering the audio mix), so this export stopped. Export again. Arya starts a new render worker and the export starts from the first frame.')
  // Once frames flow the step no longer applies.
  const rendering = { state: 'running', spec: job.spec, workerStep: 'first' }
  rendering.processing = { dispatched: true, drained: false, worker: { exitCode: null, signalCode: null } }
  noteWorkerActivity(rendering, 0, 'dispatch'); noteWorkerActivity(rendering, 0, 'setup'); noteWorkerActivity(rendering, 10, 'batch')
  noteWorkerSetupStep(rendering, 'audio')
  assert.equal(rendering.workerStep, 'first', 'a late heartbeat cannot move the step back')
  failStalledWorkerJob(rendering, (_job, message) => failures.push(message), 180000)
  assert.match(failures[1], /^The render worker sent nothing for 120 s, so this export stopped\./)
})
