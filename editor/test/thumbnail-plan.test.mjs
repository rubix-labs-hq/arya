import assert from 'node:assert/strict'
import test from 'node:test'
import { thumbnailPlan } from '../core/thumbnail-plan.js'

test('media previews preserve portrait proportions and have five times the timeline height', () => {
  const asset = { width: 1080, height: 1920, duration: 46.2 }
  const low = thumbnailPlan(asset)
  const high = thumbnailPlan(asset, true)
  assert.equal(low.h, 72)
  assert.equal(high.h, 360)
  assert.ok(Math.abs(high.w / high.h - asset.width / asset.height) < .005)
  assert.equal(high.count, 24)
  assert.equal(high.interval * high.count, asset.duration)
})

test('high resolution previews bound allocation and avoid enlarging small originals', () => {
  for (const [width, height] of [[7680, 4320], [32000, 400], [400, 32000], [64, 48]]) {
    const plan = thumbnailPlan({ width, height, duration: 3600 }, true)
    assert.ok(plan.w <= 640 && plan.h <= 360)
    assert.ok(plan.w <= width && plan.h <= height)
    assert.ok(plan.w * plan.count < 16384)
    assert.ok(plan.w * plan.h * plan.count * 4 < 24 * 1024 * 1024)
  }
  assert.deepEqual(thumbnailPlan({ width: 64, height: 48, still: true }, true), { w: 64, h: 48, count: 1, interval: 0 })
})

test('invalid metadata cannot create an unbounded sprite', () => {
  const plan = thumbnailPlan({ width: Infinity, height: NaN, duration: Infinity }, true)
  assert.ok(Number.isFinite(plan.w) && Number.isFinite(plan.h))
  assert.equal(plan.count, 1)
})
