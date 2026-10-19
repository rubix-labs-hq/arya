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

export function acknowledgeProcessingWorkerExit(jobs, ownedWorker, failJob) {
  for (const job of jobs) if (job.processing?.dispatched && !job.processing.drained && job.processing.worker === ownedWorker) {
    failJob(job, 'The render worker exited')
    job.processing.acknowledge()
  }
}

export function processingWorkerConnected(worker, clients) {
  return Boolean(worker && !worker.processingStopping && [...clients].some(client => client.role === 'worker' && client.worker === worker))
}

export function retireProcessingWorkerClients(clients, worker) {
  for (const client of clients) if (client.role === 'worker' && client.worker === worker) {
    clients.delete(client)
    try { client.res.end() } catch {}
  }
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
 * Fails a stalled job so later exports stop waiting behind it. Failing cancels the reservation,
 * which stops the worker after its grace period; the reservation drains when that worker exits,
 * or at once when it has already gone.
 */
export function failStalledWorkerJob(job, failJob, now = workerClock()) {
  const stall = workerStall(job, now) ?? { phase: 'frames', limit: workerStallLimit(job) }
  const seconds = Math.round(stall.limit / 1000)
  failJob(job, stall.phase === 'setup-cap'
    ? `The render worker was still preparing this export after ${seconds} s, so it stopped. Export again; a new render worker starts.`
    : `The render worker sent nothing for ${seconds} s, so this export stopped. Export again; a new render worker starts.`)
  const owner = job.processing?.worker
  if (!owner || owner.exitCode != null || owner.signalCode != null) job.processing?.acknowledge()
}

/**
 * The periodic check. When a check fires more than 20 s late (the server process was stalled or
 * the clock jumped), the time the server lost is taken out of every watched job's counts: its
 * stamps move forward by the jump, so the silence before and after the stall still adds up (a
 * real hang still fails within one limit plus the stall time) and the next batch gap counts the
 * worker's time without the server's. Stamps never move past now.
 */
export function createWorkerWatchdog({ jobs, failJob, clock = workerClock, interval = WORKER_CHECK_MS }) {
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
    for (const job of stalledWorkerJobs(jobs(), now)) failStalledWorkerJob(job, failJob, now)
  }
}
