import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderQueue } from '../core/render-queue.js'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const item = id => ({ job: { id } })

test('worker replay cannot enqueue an active or completed export again', async () => {
  const active = deferred(), next = deferred(), calls = []
  const enqueue = createRenderQueue(async ({ job }) => {
    calls.push(job.id)
    if (job.id === 'export') await active.promise
    else next.resolve()
  }, (_item, error) => { throw error })
  assert.equal(enqueue(item('export')), true)
  assert.deepEqual(calls, ['export'])
  assert.equal(enqueue(item('export')), false, 'startup replay reaches the currently running job')
  assert.equal(enqueue(item('frame')), true)
  assert.equal(enqueue(item('frame')), false, 'queued jobs still deduplicate')
  active.resolve()
  await next.promise
  assert.equal(enqueue(item('export')), false, 'completed export replay cannot reopen its encoder')
  assert.deepEqual(calls, ['export', 'frame'])
})

test('a duplicate failed job cannot rerun while its failure is reported', async () => {
  const reporting = deferred(), next = deferred(), failures = [], calls = []
  const enqueue = createRenderQueue(async ({ job }) => {
    calls.push(job.id)
    if (job.id === 'failed') throw new Error('render failed')
    next.resolve()
  }, async ({ job }, error) => {
    failures.push([job.id, error.message])
    await reporting.promise
  })
  assert.equal(enqueue(item('failed')), true)
  assert.equal(enqueue(item('failed')), false)
  assert.equal(enqueue(item('next')), true)
  reporting.resolve()
  await next.promise
  assert.deepEqual(calls, ['failed', 'next'])
  assert.deepEqual(failures, [['failed', 'render failed']])
})
