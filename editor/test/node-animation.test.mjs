import assert from 'node:assert/strict'
import test from 'node:test'

import { applyOps, baseValue, findClip, newProject, valueAt } from '../core/project.js'

test('node window expressions start from the stored value and retain keyframe interpolation', () => {
  let p = applyOps(newProject('tracked window'), [
    { op: 'add_shape', track: 'V1', start: 0, dur: 5 },
    { op: 'node_add', id: 'c1', node: { type: 'corrector', window: { type: 'circle', x: 0.35, y: 0.6, w: 0.2, h: 0.4 } } },
  ]).project
  let c = findClip(p, 'c1').clip
  const node = c.nodes.list.find(n => n.type === 'corrector').id
  const prop = `node.${node}.window.x`
  assert.equal(baseValue(p, c, prop), 0.35)
  p = applyOps(p, [{ op: 'expression', id: 'c1', prop, expr: 'value + time * 0.1' }]).project
  c = findClip(p, 'c1').clip
  assert.equal(valueAt(p, c, prop, 2), 0.55)
  p = applyOps(p, [
    { op: 'keyframe', id: 'c1', prop, at: 0, value: 0.2, local: true },
    { op: 'keyframe', id: 'c1', prop, at: 2, value: 0.6, local: true },
  ]).project
  c = findClip(p, 'c1').clip
  assert.equal(valueAt(p, c, prop, 1), 0.5)
  assert.equal(baseValue(p, c, `node.${node}.window.y`), 0.6)
  assert.equal(baseValue(p, c, 'node.missing.window.x'), 0)
})

test('node window expressions use the renderer defaults for omitted values', () => {
  const p = applyOps(newProject('default window'), [
    { op: 'add_shape', track: 'V1', start: 0, dur: 5 },
    { op: 'node_add', id: 'c1', node: { type: 'corrector', window: { type: 'circle' } } },
  ]).project
  const c = findClip(p, 'c1').clip
  const node = c.nodes.list.find(n => n.type === 'corrector').id
  for (const [field, expected] of Object.entries({ x: 0.5, y: 0.5, w: 0.5, h: 0.5, softness: 0.15, rotation: 0 })) {
    const prop = `node.${node}.window.${field}`
    assert.equal(baseValue(p, c, prop), expected)
    assert.equal(valueAt(p, { ...c, expr: { [prop]: 'value + 0.1' } }, prop, 0), expected + 0.1)
  }
  assert.equal(baseValue(p, c, 'node.missing.window.x'), 0)
})
