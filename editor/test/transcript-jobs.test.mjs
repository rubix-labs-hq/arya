import assert from 'node:assert/strict'
import test from 'node:test'
import { runTranscriptJob } from '../web/ui/transcript-jobs.js'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('a cancelled transcription cancels only its own job when a late start returns', async () => {
  const start = deferred(), calls = [], controller = new AbortController()
  const request = async (path, body) => {
    calls.push({ path, body })
    if (path === '/api/transcribe') return start.promise
    return { ok: true }
  }
  const work = runTranscriptJob(request, '/api/transcribe', { src: 'interview.mov' }, { signal: controller.signal })
  controller.abort()
  start.resolve({ id: 'owned', state: 'queued' })
  await assert.rejects(work, error => error.name === 'AbortError')
  assert.deepEqual(calls, [
    { path: '/api/transcribe', body: { src: 'interview.mov', wait: false } },
    { path: '/api/jobs/cancel', body: { id: 'owned' } },
  ])
})

test('transcription polling stays bounded and returns the completed word timings', async () => {
  const calls = [], updates = []
  const words = [{ t: 1.2, end: 1.6, text: 'Hello' }]
  const request = async (path, body) => {
    calls.push({ path, body })
    if (path === '/api/transcribe') return { id: 'job / 1', state: 'running', progress: 0.1 }
    return calls.length === 2 ? { id: 'job / 1', state: 'running', progress: 0.5 } : { id: 'job / 1', state: 'done', result: { src: 'voice.wav', words } }
  }
  const result = await runTranscriptJob(request, '/api/transcribe', { src: 'voice.wav' }, { onJob: job => updates.push(job.progress) })
  assert.deepEqual(result.words, words)
  assert.deepEqual(updates, [0.1, 0.5, undefined])
  assert.equal(calls[1].path, '/api/jobs/wait?id=job%20%2F%201&timeout=2500')
  assert.equal(calls.filter(call => call.path === '/api/jobs/cancel').length, 0)
})

test('a cancelled running poll cannot publish the result from a completed wait', async () => {
  const poll = deferred(), controller = new AbortController(), calls = []
  const request = async (path, body) => {
    calls.push({ path, body })
    if (path === '/api/transcribe') return { id: 'owned', state: 'running' }
    if (path.startsWith('/api/jobs/wait')) return poll.promise
    return { ok: true }
  }
  const work = runTranscriptJob(request, '/api/transcribe', { src: 'voice.wav' }, { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  poll.resolve({ id: 'owned', state: 'done', result: { words: [{ t: 0, end: 1, text: 'Late' }] } })
  await assert.rejects(work, error => error.name === 'AbortError')
  assert.equal(calls.filter(call => call.path === '/api/jobs/cancel').length, 1)
})
