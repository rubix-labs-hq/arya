import { AsyncResource } from 'node:async_hooks'

export const DERIVATIVE_WAIT_LIMIT = 256
export const DERIVATIVE_QUEUE_SHARE = 4
export const DERIVATIVE_WAIT_MS = 120000

function full(message) {
  const error = new Error(message)
  error.status = 429
  return error
}

/**
 * A waiting list in front of the processing queue for filmstrips and waveform peaks.
 *
 * The processing queue holds 8 operations and refuses the rest. Importing 16 files asks for 16
 * filmstrips in the same second, so half of them were refused and their thumbnails stayed empty.
 * Requests wait here instead. At most `share` of them sit in the processing queue at a time, so an
 * export started during an import still gets a slot. A request is refused only when `limit`
 * requests already wait, or when it has waited `maxWait` without getting into the queue.
 *
 * `admit(work)` hands work to the processing queue. It returns a promise, or throws an error with
 * status 429 when the queue is full; the request then stays here and is offered again.
 */
export function createDerivativeWaiters({ admit, limit = DERIVATIVE_WAIT_LIMIT, share = DERIVATIVE_QUEUE_SHARE, maxWait = DERIVATIVE_WAIT_MS, retryMs = 250, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const waiting = []
  let admitted = 0, retry = null
  function pump() {
    if (retry !== null) { clearTimer(retry); retry = null }
    while (waiting.length) {
      const item = waiting[0]
      if (now() - item.since >= maxWait) { waiting.shift(); item.reject(full('Thumbnails are waiting behind other processing. Try again when it has finished.')); continue }
      if (admitted >= share) break
      let promise
      try { promise = item.submit() } catch (error) {
        if (error?.status !== 429) { waiting.shift(); item.reject(error); continue }
        break
      }
      waiting.shift(); admitted++
      Promise.resolve(promise).then(item.resolve, item.reject).finally(() => { admitted--; pump() })
    }
    // Requests still waiting are offered again when one of ours finishes, and on a timer, because
    // a slot can also free when an export or another operation finishes.
    if (waiting.length && retry === null) { retry = setTimer(() => { retry = null; pump() }, retryMs); retry?.unref?.() }
  }
  return {
    run(work) {
      if (waiting.length >= limit) return Promise.reject(full('Too many thumbnails are waiting. Try again in a moment.'))
      return new Promise((resolve, reject) => {
        // The work runs in the caller's context, whichever request frees the slot.
        waiting.push({ submit: AsyncResource.bind(() => admit(work)), resolve, reject, since: now() })
        pump()
      })
    },
    snapshot: () => ({ waiting: waiting.length, admitted }),
  }
}
