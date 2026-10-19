import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCube } from '../core/cube-lut.js'

const rows = Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join('\n')

test('CUBE domains map input while table values retain precision and range', () => {
  const table = parseCube(`TITLE "Fixture"\nLUT_3D_SIZE 2\nDOMAIN_MIN -0.25 0.25 0.1\nDOMAIN_MAX 1.25 0.75 0.9\n${rows}`)
  assert.deepEqual(table.domainMin, [-0.25, 0.25, 0.1])
  assert.deepEqual(table.domainMax, [1.25, 0.75, 0.9])
  assert.deepEqual([...table.data], rows.split(/\s+/).map(Number))
  const extended = parseCube(`LUT_3D_SIZE 2\n${Array(8).fill('0.12345 1.2345 -0.25').join('\n')}`)
  assert.ok(Math.abs(extended.data[0] - 0.12345) < 1e-7)
  assert.ok(extended.data[1] > 1)
  assert.equal(extended.data[2], -0.25)
})

test('Resolve input range, comments and exponent notation are accepted', () => {
  const table = parseCube(`LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE -1e-1 1.1\n${rows}\n# end`)
  assert.deepEqual(table.domainMin, [-0.1, -0.1, -0.1])
  assert.deepEqual(table.domainMax, [1.1, 1.1, 1.1])
})

test('CUBE rejects malformed, unbounded or unsupported tables before upload', () => {
  for (const text of [
    `LUT_3D_SIZE 129\n${rows}`, `LUT_3D_SIZE 2.5\n${rows}`, `LUT_3D_SIZE 2\n${rows}\n0 0 0`,
    `LUT_3D_SIZE 2\n0 0 0`, `LUT_3D_SIZE 2\nDOMAIN_MIN 1 0 0\n${rows}`,
    `LUT_3D_SIZE 2\nDOMAIN_MAX NaN 1 1\n${rows}`, `LUT_3D_SIZE 2\nLUT_1D_SIZE 2\n${rows}`,
    `LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n${rows}`, `LUT_3D_SIZE 2\n${rows}\nDOMAIN_MIN 0 0 0`,
    `LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE 0 1\nDOMAIN_MIN 0 0 0\n${rows}`,
  ]) assert.throws(() => parseCube(text))
})
