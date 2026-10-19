import assert from 'node:assert/strict'
import test from 'node:test'

import { figmaToOps } from '../core/figma.js'

const gradient = (type, transform) => {
  const node = { id: '1:1', type: 'FRAME', name: 'Gradient', absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 80 }, children: [{
    id: '1:2', type: 'RECTANGLE', name: 'Paint', absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 80 },
    fills: [{ type, gradientTransform: transform, gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0 } }, { position: 1, color: { r: 0, g: 0, b: 1 } }] }],
  }] }

  return figmaToOps(node).ops.find(o => o.op === 'add_shape').shape.fill.gradient
}

test('Plugin API linear gradientTransform becomes its normalized handle positions', () => {
  const paint = gradient('GRADIENT_LINEAR', [[0, 1, 0], [-1, 0, 1]])
  assert.deepEqual(paint.from, [0, -40])
  assert.deepEqual(paint.to, [0, 40])
  assert.equal(paint.angle, 90)
})

test('Plugin API radial gradientTransform preserves the center and radii', () => {
  const paint = gradient('GRADIENT_RADIAL', [[1, 0, 0], [0, 1, 0]])
  assert.deepEqual(paint.center, [0, 0])
  assert.deepEqual(paint.radius, [80, 40])
})
