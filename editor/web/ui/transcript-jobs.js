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

/** What to say where a transcript would be made when this computer cannot make one. Null when it can, or when the host does not say. */
export function transcriptionSetup(caps) {
  const state = caps?.transcription
  if (!state || state.available !== false) return null
  const commands = (Array.isArray(state.install) ? state.install : []).filter(command => typeof command === 'string' && command.trim())
  // The reason is the server's own next step, such as which part to install.
  const reason = typeof state.reason === 'string' ? state.reason.trim() : ''
  return { text: ['Transcription is not installed on this computer.', reason].filter(Boolean).join(' '), commands }
}

/** The lines to show with a finished transcript: its own warnings, then that it holds no words. */
export function transcriptNotes(record, wordCount = record?.words?.length ?? 0) {
  if (!record || !['complete', 'ready', 'partial'].includes(record.status)) return []
  const warnings = (Array.isArray(record.warnings) ? record.warnings : []).filter(warning => typeof warning === 'string' && warning.trim())
  return wordCount === 0 && record.status !== 'partial' ? [...warnings, 'No words were recognized.'] : warnings
}
