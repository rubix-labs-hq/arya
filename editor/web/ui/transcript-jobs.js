export function cancelledTranscriptError() {
  const error = new Error('Transcription cancelled')
  error.name = 'AbortError'
  return error
}

/** Runs one owned job. Cancellation can arrive before its identifier does. */
export async function runTranscriptJob(request, path, body, { signal, onJob } = {}) {
  let id = null
  let cancelSent = false
  const cancel = () => {
    if (!id || cancelSent) return
    cancelSent = true
    request('/api/jobs/cancel', { id }).catch(() => {})
  }
  const check = () => {
    if (signal?.aborted) {
      cancel()
      throw cancelledTranscriptError()
    }
  }
  check()
  signal?.addEventListener('abort', cancel)
  try {
    let job = await request(path, { ...body, wait: false })
    id = job?.id
    check()
    if (!id) throw new Error('The transcription service did not return a job identifier')
    while (true) {
      onJob?.(job)
      if (job.state === 'done') return job.result ?? job
      if (job.state === 'failed' || job.state === 'cancelled') {
        if (job.state === 'cancelled' || String(job.error).toLowerCase() === 'cancelled') throw cancelledTranscriptError()
        throw new Error(job.error ?? 'Transcription failed')
      }
      check()
      job = await request(`/api/jobs/wait?id=${encodeURIComponent(id)}&timeout=2500`)
      check()
    }
  } catch (error) {
    cancel()
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
