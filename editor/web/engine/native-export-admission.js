export async function waitNativeAdmission(request, id, delay = () => new Promise(resolve => setTimeout(resolve, 100))) {
  for (;;) {
    const status = await request('/api/export/progress', { id, progress: 0 })
    if (status.cancelled) throw new Error('cancelled')
    if (status.state === 'running') return
    if (!status.queued || status.state !== 'queued') throw new Error('The native export admission status is unavailable.')
    await delay()
  }
}

// Promise.race can return on cancellation while decoding or offline audio still
// runs. Retain every started operation until it settles, then acknowledge exit.
export class NativeExportDrain {
  pending = new Set()
  track(operation) {
    const promise = Promise.resolve(operation)
    this.pending.add(promise)
    promise.finally(() => this.pending.delete(promise)).catch(() => {})
    return promise
  }
  wait(operation, cancellation) {
    return Promise.race([this.track(operation), cancellation])
  }
  trackMedia(media) {
    for (const name of ['decodeFrame', 'seek']) {
      const original = media[name].bind(media)
      media[name] = (...args) => this.track(original(...args))
    }
    const image = media.image.bind(media)
    media.image = (...args) => { const result = image(...args); this.track(result.promise); return result }
  }
  async finish(request, id, close, error) {
    await close()
    await Promise.allSettled([...this.pending])
    return request('/api/export/finish', { id, drained: true, ...(error ? { error: error.message ?? String(error) } : {}) })
  }
}
