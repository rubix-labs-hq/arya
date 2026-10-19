import assert from 'node:assert/strict'
import test from 'node:test'
import { lookLUT, lookTransform } from '../core/look-lut.js'

test('generated CUBE is an identity with exact red-fastest ordering', () => {
  const lut = lookLUT({ size: 17 })
  const rows = lut.text.trim().split('\n').slice(4).map(line => line.split(' ').map(Number))
  assert.equal(rows.length, 17 ** 3)
  assert.deepEqual(rows[0], [0, 0, 0])
  assert.deepEqual(rows[1], [1 / 16, 0, 0])
  assert.deepEqual(rows[17], [0, 1 / 16, 0])
  assert.deepEqual(rows[17 * 17], [0, 0, 1 / 16])
  assert.deepEqual(rows.at(-1), [1, 1, 1])
})

test('prompt grade controls and reference transfer produce bounded reusable colors', () => {
  const exposed = lookTransform({ exposure: 1 })([0.1, 0.2, 0.3])
  assert.deepEqual(exposed, [0.2, 0.4, 0.6])
  const mono = lookTransform({ saturation: 0 })([1, 0, 0])
  assert.deepEqual(mono, [0.2126, 0.2126, 0.2126])
  assert.deepEqual(lookTransform({}, { gain: [2, 1, 0.5], offset: [0.1, 0, 0.2] })([0.2, 0.3, 0.4]), [0.5, 0.3, 0.4])
  const warm = lookTransform({ look: 'warm', curves: { master: [[0, 0], [0.5, 0.6], [1, 1]] } })([0.25, 0.4, 0.6])
  assert.ok(warm.every(Number.isFinite))
  assert.ok(warm.every(x => x >= 0 && x <= 1))
})

test('invalid LUT requests reject spatial effects, recursive LUTs and unbounded values', () => {
  for (const grade of [{ lut: 'luts/old.cube' }, { blur: 4 }, { exposure: Infinity }, { curves: { r: [[0, 0], [0, 1]] } }]) assert.throws(() => lookLUT({ grade }))
  assert.throws(() => lookLUT({ size: 10000 }))
  assert.throws(() => lookLUT({ transfer: { gain: [1, 2] } }))
})
