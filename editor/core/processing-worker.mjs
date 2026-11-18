import { randomUUID } from 'node:crypto'
import { processingCancelled } from './processing-admission.mjs'

// An abort stops publication immediately. Only cleanup acknowledgement or worker exit
// releases the worker reservation; an encoder must also have closed.
export function reserveProcessingWorker(admission, job, { assertCurrent, accept, ensureWorker, dispatch, cancel, waitEncoder = () => Promise.resolve(), onState = () => {} }) {
  let resolveDrain, dispatched = false, drained = false
  const drain = new Promise(resolve => { resolveDrain = resolve })
  const state = { assertCurrent, payload: null, ticket: null, dispatched: false, drained: false,
    acknowledge() { if (!drained) { drained = true; state.drained = true; resolveDrain() } },
  }
  Object.defineProperty(job, 'processing', { value: state })
  state.ticket = admission.submit(async lease => {
    state.lease = lease
    const abort = () => { if (dispatched && !drained) cancel(job) }
    lease.signal.addEventListener('abort', abort, { once: true })
    try {
      await ensureWorker(lease.signal)
      lease.check()
      dispatch(job, state)
      dispatched = true; state.dispatched = true
      await drain
      await waitEncoder(job)
      if (lease.signal.aborted) throw processingCancelled()
      lease.check()
      if (job.state === 'failed') throw new Error(job.error ?? 'Worker failed')
    } finally {
      if (dispatched) { await drain; await waitEncoder(job) }
      state.lease = null
      lease.signal.removeEventListener('abort', abort)
    }
  }, { assertCurrent, accept, onState })
  return state
}

export function armProcessingWorkerCancellation(worker, { isCurrent, isDrained, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let hardKill
  const grace = setTimer(() => {
    if (!isCurrent() || isDrained()) return
    worker.kill('SIGTERM')
    hardKill = setTimer(() => { if (isCurrent() && !isDrained()) worker.kill('SIGKILL') }, 1500)
  }, 15000)
  return () => { clearTimer(grace); clearTimer(hardKill) }
}

export function acknowledgeProcessingWorkerExit(jobs, ownedWorker, failJob, reason = () => 'The render worker exited') {
  for (const job of jobs) if (job.processing?.dispatched && !job.processing.drained && job.processing.worker === ownedWorker) {
    failJob(job, reason(job))
    job.processing.acknowledge()
  }
}

/** What a job is told when its worker page closed and did not come back. */
export const workerClosedMessage = job => job.kind === 'frame'
  ? 'The render worker closed while this frame was rendering. Try again.'
  : 'The render worker closed while this export was running. Export again.'

export function processingWorkerConnected(worker, clients) {
  return Boolean(worker && !worker.processingStopping && [...clients].some(client => client.role === 'worker' && client.worker === worker))
}

export function retireProcessingWorkerClients(clients, worker) {
  for (const client of clients) if (client.role === 'worker' && client.worker === worker) {
    clients.delete(client)
    try { client.res.end() } catch {}
  }
}

// ---------------------------------------------------------------- the worker process
//
// The render worker is a headless Chrome that Arya starts when a frame or export needs it. A
// process handle alone proves nothing: Chrome can be alive with no page (the page crashed, or
// never loaded), and a stopped process ignores SIGTERM. So a handle serves jobs only while one of
// its pages holds the event stream, and a handle that cannot serve is stopped for good (SIGTERM,
// then SIGKILL) and replaced by the next request instead of failing every request after it.

export const WORKER_START_MS = 20000
const WORKER_START_MAX_MS = 80000
export const WORKER_KILL_GRACE_MS = 1500
export const WORKER_CLOSE_GRACE_MS = 5000
const WORKER_EXIT_WAIT_MS = 2000

const exited = worker => worker.exitCode != null || worker.signalCode != null || worker.processingGone === true

/**
 * How long a new worker process may take to connect before it is replaced: 20 s, doubled after
 * each start in a row that never connected (a slow machine gets more time), at most 80 s.
 */
export function workerStartLimit(failedStarts = 0) {
  return Math.min(WORKER_START_MAX_MS, WORKER_START_MS * 2 ** Math.max(0, failedStarts))
}

/** Stops a worker process for good: SIGTERM now, SIGKILL after 1.5 s unless it has exited. */
export function retireProcessingWorker(worker, { setTimer = setTimeout } = {}) {
  if (!worker || worker.processingRetired) return
  worker.processingRetired = true
  worker.processingStopping = true
  if (exited(worker)) return
  try { worker.kill('SIGTERM') } catch {}
  const timer = setTimer(() => { if (!exited(worker)) try { worker.kill('SIGKILL') } catch {} }, WORKER_KILL_GRACE_MS)
  timer?.unref?.()
}

/**
 * Owns the one worker process. `launch(token)` starts it and returns the child; the page it opens
 * presents `token` when it connects, so a late page from a replaced process is refused.
 * `onExit(worker)` runs when a process has gone; `onLost(worker)` runs when its page closed and
 * did not reconnect within 5 s, just before the process is stopped.
 */
export function createProcessingWorkerHost({ launch, clients, onExit = () => {}, onLost = () => {}, onChange = () => {}, log = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, token = () => randomUUID() }) {
  let current = null, failedStarts = 0
  const sleep = ms => new Promise(resolve => { setTimer(resolve, ms) })
  const set = value => { current = value; onChange(value) }
  const attached = worker => [...clients].some(client => client.role === 'worker' && client.worker === worker)
  const retire = (worker, reason) => {
    if (!worker || worker.processingRetired) return
    if (reason) log(`stopping the render worker: ${reason}`)
    retireProcessingWorker(worker, { setTimer })
  }
  function gone(worker) {
    if (worker.processingGone) return
    worker.processingGone = true
    clearTimer(worker.processingCloseTimer)
    retireProcessingWorkerClients(clients, worker)
    if (current === worker) set(null)
    onExit(worker)
    for (const resolve of worker.processingExitWaiters.splice(0)) resolve()
  }
  const waitGone = (worker, ms) => worker.processingGone ? Promise.resolve() : Promise.race([new Promise(resolve => worker.processingExitWaiters.push(resolve)), sleep(ms)])
  function start() {
    const presented = token(), worker = launch(presented)
    worker.processingToken = presented
    worker.processingStartedAt = now()
    worker.processingStartLimit = workerStartLimit(failedStarts)
    worker.processingExitWaiters = []
    worker.on('exit', () => gone(worker))
    // 'error' without a pid means the browser could not be started at all (for example, no Chrome).
    worker.on('error', error => {
      log(`render worker process error: ${error?.code ?? error?.message ?? error}`)
      if (worker.pid !== undefined) return
      worker.processingStartError = `Arya could not start Google Chrome to render (${error?.code ?? 'unknown error'}). Install Google Chrome in Applications, then try again.`
      gone(worker)
    })
    set(worker)
    return worker
  }
  return {
    get current() { return current },
    connected: () => processingWorkerConnected(current, clients),
    retire,
    /** False for a page whose process has been replaced or is stopping. Pages without a token are accepted. */
    accepts: presented => !presented || Boolean(current && !current.processingStopping && current.processingToken === presented),
    /** Binds a connecting worker page to the current process. */
    attach(client) {
      client.worker = current
      if (!current) return
      clearTimer(current.processingCloseTimer)
      if (current.processingConnectedAt === undefined) {
        current.processingConnectedAt = now()
        failedStarts = 0
        log(`render worker connected ${current.processingConnectedAt - current.processingStartedAt} ms after it started`)
      }
    },
    /** Call after a client has been removed. A worker whose last page stays away for 5 s is stopped. */
    detached(client) {
      const worker = client.worker
      if (client.role !== 'worker' || !worker || worker.processingStopping || exited(worker) || attached(worker)) return
      clearTimer(worker.processingCloseTimer)
      worker.processingCloseTimer = setTimer(() => {
        if (worker.processingStopping || exited(worker) || attached(worker)) return
        onLost(worker)
        retire(worker, 'its page closed and did not reconnect')
      }, WORKER_CLOSE_GRACE_MS)
      worker.processingCloseTimer?.unref?.()
    },
    /**
     * Resolves once a worker page is connected. Starts a process when there is none, and replaces
     * one that is stopping or that has not connected within its start limit. One call starts at
     * most one process and waits 20 s for it.
     */
    async ensure(signal) {
      let until = now() + WORKER_START_MS, started = null
      while (!processingWorkerConnected(current, clients)) {
        if (signal?.aborted) throw processingCancelled()
        const worker = current
        if (worker && (worker.processingStopping || now() - worker.processingStartedAt >= worker.processingStartLimit)) {
          if (!worker.processingStopping) {
            failedStarts++
            log(`the render worker did not connect within ${Math.round(worker.processingStartLimit / 1000)} s`)
          }
          retire(worker, worker.processingRetired ? '' : 'it cannot serve this request')
          // The old process must be gone before a new one opens the same browser profile.
          await waitGone(worker, WORKER_KILL_GRACE_MS + WORKER_EXIT_WAIT_MS)
          if (current === worker) { retireProcessingWorkerClients(clients, worker); set(null) }
          continue
        }
        if (!current) {
          if (started) throw new Error(started.processingStartError ?? 'The render worker did not start. Try again: Arya starts a new one.')
          log('starting the render worker')
          started = start()
          until = now() + WORKER_START_MS
        }
        if (now() > until) throw new Error('The render worker did not start in 20 s. Try again.')
        await sleep(150)
      }
    },
  }
}

// ---------------------------------------------------------------- waiting jobs

export const FRAME_RENDER_MS = 30000
export const FRAME_QUEUE_MS = 5 * 60 * 1000

/**
 * The time limits of a still-frame job. The 30 s render limit starts when the worker is given the
 * frame (`dispatched`), not when the job is queued: the wait behind a running export, the source
 * copy and a worker start are not the frame's fault. The whole request is capped at 5 minutes.
 */
export function frameJobDeadline(fail, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = setTimer(() => fail('This frame waited 5 minutes behind other processing, so it stopped. Try again when the running export has finished.'), FRAME_QUEUE_MS)
  return {
    dispatched() { clearTimer(timer); timer = setTimer(() => fail('The render worker did not finish this frame in 30 s. Try again.'), FRAME_RENDER_MS) },
    clear() { clearTimer(timer) },
  }
}

/**
 * Why a job still in the processing queue is waiting: behind another render job (with its id) or
 * behind other processing such as a proxy or an analysis. Null once it has its turn.
 */
export function queuedJobWait(job, jobs, otherProcessingActive = false) {
  if (job.state !== 'queued' || job.admissionState !== 'queued') return null
  for (const other of jobs) if (other !== job && other.processing && ['running', 'cancelling'].includes(other.admissionState)) return { reason: 'behind-job', job: other.id }
  return otherProcessingActive ? { reason: 'behind-processing' } : null
}

// A worker job that stops making progress has hung (seen when the page's renderer stops
// answering on a loaded machine) or lost the server. Silence is measured on a clock that does not
// run while the Mac sleeps (performance.now), and a check that fires much later than planned
// (the server itself was stalled) takes the lost time out of every count instead of blaming the
// worker for it. A job that
// is finishing (the encoder closing, the +faststart rewrite, the final source check) is the
// server's work, not the worker's, and is never failed here.
//
// Two phases:
// - Setup, from dispatch to the first frame batch: LUTs, audio render and upload, decoder
//   planning. The worker sends a heartbeat every 5 s while it works, so a live page is never
//   failed for slow setup, but a page that is silent for the frame floor below, or a setup that
//   runs past a generous cap (10 minutes plus half a second per second of range, at most an
//   hour), counts as stalled.
// - Frames: the limit is 2 minutes for a 1080p frame, scaled up by pixel count (8 minutes for
//   4K), and at least 20 times the slowest batch so far (the first batch is measured from the
//   start of rendering), at most 30 minutes. Heartbeats no longer count, because a page that is
//   alive but not delivering frames is stuck.
export const WORKER_STALL_MS = 120000
const WORKER_STALL_MAX_MS = 30 * 60 * 1000
const WORKER_STALL_GAP_FACTOR = 20
const SETUP_BASE_MS = 10 * 60 * 1000
const SETUP_PER_RANGE_SECOND_MS = 500
const SETUP_MAX_MS = 60 * 60 * 1000
export const WORKER_CHECK_MS = 10000
const LATE_CHECK_MS = 20000

/** Milliseconds on a clock that stops while the computer sleeps. */
export const workerClock = () => performance.now()

const floorOf = job => {
  const pixels = Number(job.spec?.width) * Number(job.spec?.height)
  return WORKER_STALL_MS * Math.max(1, Number.isFinite(pixels) && pixels > 0 ? pixels / (1920 * 1080) : 1)
}

/** How long a rendering export may go without a frame batch. */
export function workerStallLimit(job) {
  return Math.min(WORKER_STALL_MAX_MS, Math.max(floorOf(job), WORKER_STALL_GAP_FACTOR * (job.longestWorkerGap ?? 0)))
}

/** How long setup (dispatch to the first frame batch) may take in all. */
export function workerSetupLimit(job) {
  const range = Number(job.spec?.range?.out) - Number(job.spec?.range?.in)
  return Math.min(SETUP_MAX_MS, SETUP_BASE_MS + (Number.isFinite(range) && range > 0 ? range * SETUP_PER_RANGE_SECOND_MS : 0))
}

// The setup steps the worker page names in its heartbeat, in the words a failure message uses.
export const WORKER_SETUP_STEPS = Object.freeze({ luts: 'loading LUTs', audio: 'rendering the audio mix', upload: 'uploading the audio mix', plans: 'planning video decoding', first: 'rendering the first frame' })

/** Keeps the setup step from a heartbeat body. Unknown or late values are ignored. */
export function noteWorkerSetupStep(job, step) {
  if (!job.workerFramesSeen && Object.hasOwn(WORKER_SETUP_STEPS, step)) job.workerStep = step
}

/**
 * Records what the worker did at `now` (workerClock): `dispatch`, `setup` (audio upload, start),
 * `heartbeat` (counts only before the first batch) or `batch` (a frame batch).
 */
export function noteWorkerActivity(job, now, kind = 'setup') {
  if (kind === 'dispatch') { job.workerDispatchedAt = now; job.lastWorkerActivity = now; return }
  if (kind === 'heartbeat') { if (!job.workerFramesSeen) job.lastWorkerActivity = now; return }
  if (kind === 'batch') {
    const since = job.workerFramesSeen ? job.lastWorkerActivity : job.workerStartedAt
    if (Number.isFinite(since)) job.longestWorkerGap = Math.max(job.longestWorkerGap ?? 0, now - since)
    job.workerFramesSeen = true
  }
  if (kind === 'setup' && job.state === 'running' && !Number.isFinite(job.workerStartedAt)) job.workerStartedAt = now
  job.lastWorkerActivity = now
}

const watched = job => ['queued', 'running'].includes(job.state) && job.processing?.dispatched && !job.processing.drained && !job.finishing && Number.isFinite(job.lastWorkerActivity)

/** Why a watched job counts as stalled at `now`, or null while it is making progress. */
export function workerStall(job, now) {
  if (!watched(job)) return null
  const silent = now - job.lastWorkerActivity
  if (job.workerFramesSeen) return silent >= workerStallLimit(job) ? { phase: 'frames', limit: workerStallLimit(job) } : null
  if (silent >= floorOf(job)) return { phase: 'setup', limit: floorOf(job) }
  const setup = now - (job.workerDispatchedAt ?? job.lastWorkerActivity)
  return setup >= workerSetupLimit(job) ? { phase: 'setup-cap', limit: workerSetupLimit(job) } : null
}

/** Watched jobs that count as stalled at `now`. */
export function stalledWorkerJobs(jobs, now) {
  return [...jobs].filter(job => workerStall(job, now))
}

/**
 * Fails a stalled job so later exports stop waiting behind it, and stops the worker that owned
 * it. A page that answers the cancel is stopped too: it already hung once, and in one session the
 * next export went to the same page and hung the same way. The reservation drains when that
 * worker exits, or at once when it has already gone.
 */
export function failStalledWorkerJob(job, failJob, now = workerClock(), { retireWorker = () => {} } = {}) {
  const stall = workerStall(job, now) ?? { phase: 'frames', limit: workerStallLimit(job) }
  const seconds = Math.round(stall.limit / 1000)
  const owner = job.processing?.worker
  const next = 'Export again. Arya starts a new render worker and the export starts from the first frame.'
  // During setup the page says which step it is on, so a hang names the step it stopped in.
  const step = stall.phase !== 'frames' && WORKER_SETUP_STEPS[job.workerStep] ? ` (last step: ${WORKER_SETUP_STEPS[job.workerStep]})` : ''
  failJob(job, stall.phase === 'setup-cap'
    ? `The render worker was still preparing this export after ${seconds} s${step}, so it stopped. ${next}`
    : `The render worker sent nothing for ${seconds} s${step}, so this export stopped. ${next}`)
  if (!owner || owner.exitCode != null || owner.signalCode != null) job.processing?.acknowledge()
  if (owner) retireWorker(owner)
}

/**
 * The periodic check. When a check fires more than 20 s late (the server process was stalled or
 * the clock jumped), the time the server lost is taken out of every watched job's counts: its
 * stamps move forward by the jump, so the silence before and after the stall still adds up (a
 * real hang still fails within one limit plus the stall time) and the next batch gap counts the
 * worker's time without the server's. Stamps never move past now.
 */
export function createWorkerWatchdog({ jobs, failJob, retireWorker, clock = workerClock, interval = WORKER_CHECK_MS }) {
  let last = clock()
  return function check() {
    const now = clock()
    const jump = now - last - interval
    if (jump > LATE_CHECK_MS) {
      const shift = value => (Number.isFinite(value) ? Math.min(now, value + jump) : value)
      for (const job of jobs()) if (watched(job)) {
        job.lastWorkerActivity = shift(job.lastWorkerActivity)
        if (!job.workerFramesSeen) { job.workerDispatchedAt = shift(job.workerDispatchedAt); job.workerStartedAt = shift(job.workerStartedAt) }
      }
    }
    last = now
    for (const job of stalledWorkerJobs(jobs(), now)) failStalledWorkerJob(job, failJob, now, { retireWorker })
  }
}
