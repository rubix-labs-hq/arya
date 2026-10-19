// Shorts from a wider source keep the moving subject in the crop instead of cutting the centre.
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildShortsOps, framingKeys, subjectCenters } from '../core/shorts.js'
import { newProject } from '../core/project.js'

const W = 96, H = 54

/** Synthetic samples: a still textured background with a moving block centred at `at` (0..1). */
function frames(positions) {
  return positions.map((at, i) => {
    const frame = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) frame[y * W + x] = 40 + ((x * 7 + y * 3) % 5)
    const c = Math.round(at * W)
    for (let y = 10; y < 44; y++) for (let x = Math.max(0, c - 6); x < Math.min(W, c + 6); x++) frame[y * W + x] = 120 + ((x + y + i * 13) % 90)
    return frame
  })
}

test('the subject on the left of a 16:9 source is found for a 9:16 crop', () => {
  const visible = (1080 / 1920) / (1920 / 1080)
  const { centers, confident } = subjectCenters(frames([0.2, 0.2, 0.21, 0.2, 0.19, 0.2]), W, H, visible)
  assert.equal(confident, true)
  for (const c of centers) assert.ok(Math.abs(c - 0.2) < 0.06, String(c))
})

test('a still or evenly busy picture keeps the centre crop', () => {
  const visible = 0.3
  const still = Array.from({ length: 6 }, () => new Uint8Array(W * H).fill(80))
  assert.deepEqual(subjectCenters(still, W, H, visible).centers, Array(6).fill(0.5))
  assert.deepEqual(subjectCenters(frames([0.5]), W, H, 1).centers, [0.5], 'a crop as wide as the source does not move')
})

test('small wobbles do not move the crop; a clear move does', () => {
  const { centers } = subjectCenters(frames([0.3, 0.31, 0.3, 0.32, 0.7, 0.7, 0.71, 0.7, 0.7]), W, H, 0.3)
  assert.ok(Math.abs(centers[0] - centers[2]) < 1e-9, 'the first wobbles stay put')
  assert.ok(centers.at(-1) > 0.6, 'the crop follows the subject to the right')
})

test('keys keep the subject centred and the frame covered', () => {
  const source = { width: 1920, height: 1080 }, canvas = { width: 1080, height: 1920 }
  // The cover-fit layer is 3413 px wide; a subject at 20% sits 1024 px left of the layer centre.
  assert.deepEqual(framingKeys([0.2, 0.2], [0, 0.5], source, canvas), { x: 1564 })
  // At the far left the crop stops at the layer edge instead of showing black.
  const edge = framingKeys([0.01], [0], source, canvas)
  assert.equal(edge.x, Math.round((3413.33 / 2) * 100) / 100)
  const moving = framingKeys([0.2, 0.2, 0.8], [0, 1, 2], source, canvas)
  assert.deepEqual(moving.keys.map(k => k[0]), [0, 2])
})

test('the builder places the framing on the short clip', () => {
  const p = newProject('shorts')
  p.assets = { 'wide.mp4': { duration: 30, width: 1920, height: 1080, hasVideo: true, hasAudio: true } }
  const still = buildShortsOps(p, { src: 'wide.mp4', ranges: [{ from: 1, to: 5 }], captions: false, framing: [{ x: 1564.27 }] })
  assert.equal(still.ops.find(op => op.op === 'add_clip').set.x, 1564.27)
  const moving = buildShortsOps(p, { src: 'wide.mp4', ranges: [{ from: 1, to: 5 }], captions: false, framing: [{ keys: [[0, 1564], [2, 600]] }] })
  assert.deepEqual(moving.ops.find(op => op.op === 'add_clip').set.anim.x, [[0, 1564, 'smooth'], [2, 600, 'smooth']])
  const centred = buildShortsOps(p, { src: 'wide.mp4', ranges: [{ from: 1, to: 5 }], captions: false })
  assert.deepEqual(centred.ops.find(op => op.op === 'add_clip').set, { fit: 'cover' })
})
