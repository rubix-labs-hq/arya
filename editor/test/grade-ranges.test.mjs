// Grade wheels stay additive around 0. Values in DaVinci Resolve's units (Gain 1.00, Offset 25)
// are refused with the conversion, instead of silently blowing the picture out.
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyOps, newProject, OPS_DOC } from '../core/project.js'
import { gradeUniforms } from '../core/render-grade.js'

function project() {
  const p = newProject('grade')
  p.assets = { 'a.mp4': { duration: 10, width: 1920, height: 1080, hasVideo: true } }

  return applyOps(p, [{ op: 'append', src: 'a.mp4', dur: 4 }]).project
}

test('a Resolve-style neutral gain of 1.0 is refused with the conversion', () => {
  assert.throws(() => applyOps(project(), [{ op: 'update', id: 'c1', set: { grade: { gain: [1, 1, 1] } } }]), /Resolve Gain 1\.00 is 0 here/)
  assert.throws(() => applyOps(project(), [{ op: 'update', id: 'c1', set: { grade: { offset: [25, 25, 25] } } }]), /Resolve Offset 25 is 0 here/)
  assert.throws(() => applyOps(project(), [{ op: 'node_add', id: 'c1', node: { type: 'corrector', grade: { gain: 1 } } }]), /neutral is 0/)
  assert.throws(() => applyOps(project(), [{ op: 'update', id: 'c1', set: { grade: { lift: ['x', 0, 0] } } }]), /numbers/)
})

test('values the Color page wheels produce still apply and render as before', () => {
  // Gain master 0.8 with a warm push, the strongest the wheel reaches; lift and gamma at their limits.
  const grade = { gain: [1.05, 0.8, 0.55], lift: [0.3, 0.3, 0.3], gamma: [-0.6, -0.6, -0.6], offset: [-0.3, 0, 0.3] }
  const p = applyOps(project(), [{ op: 'update', id: 'c1', set: { grade } }]).project
  assert.deepEqual(p.tracks[0].clips[0].grade, grade)
  assert.deepEqual(gradeUniforms(grade).gain, grade.gain)
  // v1 numeric gamma (1 = neutral) is still accepted.
  assert.doesNotThrow(() => applyOps(project(), [{ op: 'update', id: 'c1', set: { grade: { gamma: 1.2 } } }]))
})

test('the ops reference the assistant reads states the neutral values and the Resolve mapping', () => {
  assert.match(OPS_DOC, /additive per channel with neutral 0/)
  assert.match(OPS_DOC, /Resolve Gain 1\.00 is 0 here and 1\.10 is 0\.1/)
  assert.match(OPS_DOC, /contrast 1 and saturation 1 multiply/)
})
