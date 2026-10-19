import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks'

export function processingCancelled() {
  const error = new Error('Processing cancelled')
  error.name = 'AbortError'
  return error
}

export function createProcessingAdmission({ capacity = 8, concurrency = 1 } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 8 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > capacity) throw new Error('Invalid processing admission limits')
  const context = new AsyncLocalStorage(), queue = [], active = new Set()
  let closed = false
  const check = signal => { if (signal.aborted) throw processingCancelled() }
  function pump() {
    while (!closed && active.size < concurrency && queue.length) {
      const item = queue.shift()
      active.add(item); item.state = 'running'; item.notify()
      void item.invoke(async () => {
        const lease = {
          signal: item.controller.signal, closed: false, tail: Promise.resolve(), children: 0, accept: item.accept,
          check() { check(this.signal); item.assertCurrent() },
          child(work) {
            if (this.closed) return Promise.reject(new Error('Processing reservation already drained'))
            if (this.children >= 8) { const error = new Error('Processing child queue is full'); error.status = 429; return Promise.reject(error) }
            this.children++
            const invoke = AsyncResource.bind(() => { this.check(); return work(this) })
            const next = this.tail.then(invoke).finally(() => { this.children-- })
            this.tail = next.catch(() => {})
            return next
          },
        }
        let result, failure
        try { result = await context.run(lease, async () => { lease.check(); const value = await item.work(lease); await lease.tail; lease.check(); return value }) }
        catch (error) { failure = error }
        finally {
          await lease.tail
          lease.closed = true; active.delete(item); item.state = 'drained'; item.finish(); item.notify(); pump()
          if (failure) item.reject(failure); else item.resolve(result)
        }
      })
    }
  }
  function assertCapacity() {
    if (closed || active.size + queue.length >= capacity) { const error = new Error('Processing queue is full. Wait for an active operation to finish.'); error.status = 429; throw error }
  }
  function submit(work, { signal, assertCurrent = () => {}, accept = () => {}, onState = () => {} } = {}) {
    assertCapacity()
    if (signal?.aborted) throw processingCancelled()
    const controller = new AbortController()
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no }); promise.catch(() => {})
    const item = { work, controller, assertCurrent, accept, resolve, reject, state: 'queued', invoke: AsyncResource.bind(fn => fn()), notify() { try { onState(this.state) } catch {} }, finish() { signal?.removeEventListener('abort', abort) } }
    function abort() {
      if (controller.signal.aborted) return
      controller.abort()
      if (item.state === 'queued') { queue.splice(queue.indexOf(item), 1); item.state = 'drained'; item.finish(); reject(processingCancelled()); item.notify(); pump() }
      else if (item.state === 'running') { item.state = 'cancelling'; item.notify() }
    }
    item.abort = abort
    signal?.addEventListener('abort', abort, { once: true }); queue.push(item); item.notify(); pump()
    return { promise, cancel: abort, get state() { return item.state }, get signal() { return controller.signal } }
  }
  return {
    submit, current: () => context.getStore(), assertCapacity,
    within(lease, work) { if (!lease || lease.closed) throw new Error('This processing reservation has drained'); lease.check(); return context.run(lease, () => work(lease)) },
    run(work, options) { const lease = context.getStore(); if (lease) { if (lease.closed) return Promise.reject(new Error('Processing reservation already drained')); lease.check(); return Promise.resolve().then(() => work(lease)) } return submit(work, options).promise },
    snapshot: () => ({ capacity, concurrency, active: active.size, queued: queue.length, draining: [...active].filter(item => item.state === 'cancelling').length }),
    close() { closed = true; for (const item of [...queue, ...active]) item.abort() },
  }
}

export function captureProcessingIdentity(read, assertOrigin = () => {}) {
  let captured = read()
  return {
    assertCurrent() { assertOrigin(); const current = read(); if (current.epoch !== captured.epoch || current.version !== captured.version || current.disk !== captured.disk) throw new Error('The project changed while processing was queued or running. Retry from the current project.') },
    accept() { captured = read() },
  }
}
