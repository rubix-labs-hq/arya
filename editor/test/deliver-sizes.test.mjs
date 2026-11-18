import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { EXPORT_LIMITS, validateExportSpec } from '../core/processing-export.js'

const deliver = fs.readFileSync(new URL('../web/ui/deliver.js', import.meta.url), 'utf8')
const presets = deliver.slice(deliver.indexOf('const PRESETS ='), deliver.indexOf('// The tip card'))
const dimensions = deliver.slice(deliver.indexOf('  const sizes = deliverSizes'), deliver.indexOf('  const range ='))
const queue = deliver.slice(deliver.indexOf('const jobFile ='), deliver.indexOf('export function DeliverPage'))
const size = (id, p, width = null) => new Function('p', 'width', `${presets}; const choice = PRESETS.find(p => p.id === '${id}'); ${dimensions}; return [outW, outH]`)(p, width)
const offered = (id, p) => new Function('p', `${presets}; return deliverSizes(p, PRESETS.find(p => p.id === '${id}'))`)(p)
const status = (job, jobs = [job]) => new Function('job', 'jobs', `${queue}; return jobStatus(job, jobs)`)(job, jobs)
const labels = sizes => sizes.map(value => `${value.width}x${value.height}`)

test('YouTube 1080p puts the short edge at 1080 and keeps the project shape', () => {
  for (const [width, height, expected] of [
    [1920, 3414, [1080, 1920]], [3414, 1920, [1920, 1080]], [1080, 1920, [1080, 1920]], [1920, 1080, [1920, 1080]],
    [3840, 2160, [1920, 1080]], [2160, 3840, [1080, 1920]], [1280, 720, [1920, 1080]], [1080, 1080, [1080, 1080]], [1000, 3000, [1080, 3240]],
  ]) assert.deepEqual(size('youtube', { width, height }), expected, `${width}x${height}`)
})

test('the size list follows the project shape and never passes what the preset allows', () => {
  const vertical = { width: 1920, height: 3414 }
  assert.deepEqual(labels(offered('youtube', vertical)), ['1080x1920', '720x1280', '540x960'])
  assert.deepEqual(labels(offered('youtube', { width: 1280, height: 720 })), ['1920x1080', '1280x720', '960x540'])
  assert.deepEqual(labels(offered('web', vertical)), ['2160x3840', '1920x3414', '1440x2560', '1080x1920', '720x1280', '540x960'])
  assert.deepEqual(labels(offered('web', { width: 1920, height: 1080 })), ['3840x2160', '2560x1440', '1920x1080', '1280x720', '960x540'])
  assert.deepEqual(labels(offered('4k', { width: 1000, height: 3000 })), ['1280x3840', '1080x3240', '1000x3000', '720x2160', '540x1620'])
  assert.deepEqual(labels(offered('gif', { width: 1920, height: 1080 })), ['640x360'])
  assert.deepEqual(labels(offered('gif', { width: 1080, height: 1920 })), ['640x1138', '540x960'])
})

test('every offered size is one the export accepts, and a chosen size renders at its listed height', () => {
  assert.match(presets, new RegExp(`edge: ${EXPORT_LIMITS.maximumEdge}, pixels: ${EXPORT_LIMITS.maximumPixels}\\b`))
  for (const p of [{ width: 1920, height: 3414 }, { width: 3414, height: 1920 }, { width: 1000, height: 5000 }, { width: 7680, height: 4320 }, { width: 720, height: 720 },
    { width: 200, height: 2000 }, { width: 8192, height: 1024 }, { width: 1081, height: 1921 }, { width: 1921, height: 1081 }, { width: 101, height: 8191 }]) {
    const project = { ...p, fps: 30, duration: 2 }
    for (const id of ['youtube', '4k', 'web', 'gif', 'png']) {
      const sizes = offered(id, p)
      assert.ok(sizes.length > 0, `${id} offers a size for ${p.width}x${p.height}`)
      assert.equal(new Set(sizes.map(value => value.width)).size, sizes.length, 'each width is offered once')
      for (const value of sizes) {
        assert.doesNotThrow(() => validateExportSpec({ width: value.width, height: value.height }, project), `${id} ${value.width}x${value.height}`)
        assert.deepEqual(size(id, p, value.width), [value.width, value.height])
      }
      // The size Render uses before one is chosen is accepted too.
      const [width, height] = size(id, p)
      assert.doesNotThrow(() => validateExportSpec({ width, height }, project), `${id} default ${width}x${height} for ${p.width}x${p.height}`)
    }
  }
  // A width that is not in the list falls back to the preset's own size, or the largest allowed size when that is too big.
  assert.deepEqual(size('youtube', { width: 1920, height: 3414 }, 3840), [1080, 1920])
  assert.deepEqual(size('youtube', { width: 200, height: 2000 }), [720, 7200])
  assert.deepEqual(size('youtube', { width: 8192, height: 1024 }), [8192, 1024])
  // An odd project size is offered made even, never larger than the project.
  assert.deepEqual(labels(offered('web', { width: 1081, height: 1921 })), ['2160x3838', '1440x2558', '1080x1920', '720x1280', '540x960'])
  assert.deepEqual(size('png', { width: 1081, height: 1921 }), [1080, 1920])
})

test('a failed job shows its own error and a waiting job says what it waits for', () => {
  const chrome = 'Arya could not start a browser to render (ENOENT). Install one in Applications, then try again.'
  assert.equal(status({ state: 'failed', error: chrome }), chrome)
  assert.equal(status({ state: 'failed', error: 'The render worker did not start in 20 s. Try again.' }), 'The render worker did not start in 20 s. Try again.')
  assert.equal(status({ state: 'failed' }), 'The render could not finish. Try again.')
  const first = { id: 'a', state: 'running', progress: 0.4, output: '/synthetic/renders/first cut.mp4' }
  const second = { id: 'b', state: 'queued', waiting: { reason: 'behind-job', job: 'a', since: 1 } }
  assert.equal(status(second, [first, second]), 'Waiting for first cut.mp4 to finish')
  assert.equal(status({ ...second, waiting: { reason: 'behind-job', job: 'gone' } }, [second]), 'Waiting for another render to finish')
  assert.equal(status({ state: 'queued', waiting: { reason: 'behind-processing' } }), 'Waiting for other processing')
  assert.equal(status({ state: 'queued', waiting: { reason: 'copying-sources' } }), 'Copying media')
  assert.equal(status({ state: 'queued', waiting: { reason: 'worker-starting' } }), 'Starting the render worker')
  assert.equal(status({ state: 'queued', waiting: { reason: 'something-new' }, progress: 0 }), '0%')
  assert.equal(status(first, [first]), '40%')
  assert.equal(status({ state: 'done', created: 1000, finished: 3500 }), 'done in 2.5s')
})
