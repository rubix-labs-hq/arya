// The actual tracker client/controller feed the real reframe planner and project core.
// Worker messages are projected; no browser, media decoding or renderer is required.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { applyOps, compView, newProject, valueAt } from '../core/project.js'
import { TrackerClient } from '../web/engine/tracker.js'
import { captureMatches, processingCapture, sourceKey, trackedReframe } from '../web/ui/processing-workflows.js'

const trackingText = fs.readFileSync(new URL('../web/ui/plugins/tracking.js', import.meta.url), 'utf8')
const method = trackingText.match(/async function runTrack\(dir, useRange\) \{([\s\S]*?)\n\}\n\nfunction trackedFrames/)[0].split('\n\nfunction trackedFrames')[0]
const makeRun = new Function('env', `const {viewProject, store, viewClip, info, frameAt, time, boxesAt, trackRange, toast, mediaUrl, sourceFrame, client, setTrack, set, timecode, frameTime}=env; ${method}; return runTrack`)

function setup() {
  let worker
  globalThis.Worker = class { constructor() { worker = this; this.messages = [] } postMessage(message) { this.messages.push(message) } }
  const project = newProject('integration', { width: 100, height: 200, fps: 2 })
  const clip = { id: 'c1', kind: 'video', src: 'media/original.mov', in: 1, start: 3, dur: 2, speed: 2, expr: { x: 'value+10' } }
  project.assets[clip.src] = { hasVideo: true, width: 400, height: 200, duration: 10, fps: 24 }
  project.tracks[0].clips = [{ ...structuredClone(clip), id: 'original-on-main' }]
  project.comps = { portrait: { id: 'portrait', name: 'Portrait', width: 100, height: 200, fps: 2, tracks: [{ id: 'V1', kind: 'video', clips: [clip] }] } }
  const store = { root: '/owned/project', version: 7, project, openComp: 'portrait', selection: ['c1'] }
  const viewProject = () => compView(store.project, store.openComp)
  const capture = processingCapture(store, viewProject(), clip)
  store.trk = { clipId: 'c1', mode: 'point', boxes: [{ x: 10, y: 100, w: 20, h: 20 }], k0: 0, results: {}, reframeSourceKey: sourceKey(capture) }
  const client = new TrackerClient(), notices = []
  const set = patch => Object.assign(store, patch)
  const setTrack = patch => set({ trk: { ...store.trk, ...patch } })
  const run = makeRun({ store, viewProject, set, setTrack, client, time: { t: 3 },
    viewClip: (p, id) => p.tracks.flatMap(track => track.clips.map(clip => ({ track, clip }))).find(hit => hit.clip.id === id),
    info: () => ({ W: 400, H: 200, assetFps: 24 }), frameAt: () => 0,
    boxesAt: trk => trk.boxes, trackRange: () => [0, 3], toast: (...args) => notices.push(args), mediaUrl: () => '/owned/project/media/original.mov',
    sourceFrame: (_p, c, k) => c.in + k / 2 * c.speed, timecode: String, frameTime: (_p, _c, k) => k / 2,
  })
  return { project, store, capture, run, client, notices, worker: () => worker, viewProject }
}

for (const withProgress of [false, true]) {
  test(`Tracker ${withProgress ? 'progress and final remainder' : 'final-only result'} produces a scoped reframe with the original source`, async t => {
    const oldWorker = globalThis.Worker
    t.after(() => oldWorker === undefined ? delete globalThis.Worker : globalThis.Worker = oldWorker)
    const h = setup(), task = h.run(1, false), worker = h.worker(), id = worker.messages[0].id
    const points = [0, 100, 300, 400].map((x, k) => ({ k, pts: [[x, 100, 1]] }))
    if (withProgress) worker.onmessage({ data: { type: 'progress', id, done: 2, total: 4, results: points.slice(0, 2) } })
    worker.onmessage({ data: { type: 'done', id, results: withProgress ? points.slice(2) : points, lostAt: null } })
    await task
    assert(captureMatches(h.capture, h.store, h.viewProject()))
    const before = JSON.stringify(h.project), ops = trackedReframe(h.capture, h.store.trk, 0)
    assert(ops.every(op => op.comp === 'portrait'))
    const result = applyOps(h.project, ops).project, clip = result.comps.portrait.tracks[0].clips[0]
    assert.equal(JSON.stringify(h.project), before)
    assert.deepEqual(result.tracks, h.project.tracks)
    assert.equal(clip.src, 'media/original.mov'); assert.equal(clip.in, 1); assert.equal(clip.speed, 2)
    assert.equal(clip.fit, 'cover'); assert.equal(clip.expr, undefined)
    assert.deepEqual(clip.anim.x.map(key => key[0]), [0, 0.5, 1, 1.5])
    assert.deepEqual(clip.anim.x.map(key => key[1]), [200, 150, -50, -100])
    assert.equal(valueAt(compView(result, 'portrait'), clip, 'y', 1), 100)
    assert.equal(h.client.jobs.size, 0); assert.deepEqual(h.notices, [['Tracked 4 frames']])
  })
}

test('A new drawing cannot consume the old worker result as a fresh reframe', async t => {
  const oldWorker = globalThis.Worker
  t.after(() => oldWorker === undefined ? delete globalThis.Worker : globalThis.Worker = oldWorker)
  const h = setup(), task = h.run(1, false), worker = h.worker(), id = worker.messages[0].id
  h.store.trk = { clipId: 'c1', mode: 'point', boxes: [{ x: 300, y: 100, w: 20, h: 20 }], k0: 0, results: {}, reframeSourceKey: sourceKey(h.capture) }
  const fresh = structuredClone(h.store.trk)
  worker.onmessage({ data: { type: 'done', id, lostAt: null, results: [0, 1, 2, 3].map(k => ({ k, pts: [[10, 100, 1]] })) } })
  await task
  assert.deepEqual(h.store.trk, fresh)
  assert.throws(() => trackedReframe(h.capture, h.store.trk), /every frame/)
  assert.deepEqual(h.notices, [])
  assert(worker.messages.some(message => message.type === 'cancel' && message.id === id))
})
