// node --test editor/test
import assert from 'node:assert/strict'
import test from 'node:test'

import { check, evaluate } from '../core/expr.js'
import { applyOps, compContains, findClip, migrate, newProject, nodeOrder, valueAt } from '../core/project.js'

function base() {
  const p = newProject('t')
  p.assets = {
    'a.mp4': { duration: 10, width: 1920, height: 1080, hasVideo: true },
    'b.mp4': { duration: 8, width: 1920, height: 1080, hasVideo: true, hasAudio: true },
  }

  return p
}

test('expressions: arithmetic, functions, wiggle is deterministic, no JavaScript', () => {
  assert.equal(evaluate('1 + 2 * 3 ^ 2', { time: 0 }), 19)
  assert.equal(evaluate('time > 2 ? 10 : 20', { time: 3 }), 10)
  assert.equal(evaluate('linear(time, 0, 2, 0, 100)', { time: 1 }), 50)
  assert.equal(evaluate('clamp(value, 0, 1)', { value: 3 }), 1)
  const ctx = { time: 1.234, value: 5, seed: 7 }
  assert.equal(evaluate('wiggle(3, 20)', ctx), evaluate('wiggle(3, 20)', ctx))
  assert.ok(Math.abs(evaluate('wiggle(3, 20)', ctx) - 5) <= 20)
  for (const bad of ['fetch("x")', 'constructor', 'this.x', 'a = 1', 'value; 1', '__proto__']) assert.ok(check(bad), `should refuse ${bad}`)
  assert.equal(check('loopOut("pingpong")'), null)
  assert.equal(evaluate('layer("Logo").x + .5', { time: 0, layer: () => ({ x: 10 }) }), 10.5)
  assert.ok(check('layer("Logo").constructor'))
})

test('loopOut cycles keyframes past the last key', () => {
  let p = base()
  p = applyOps(p, [{ op: 'add_shape', track: 'V1', start: 0, dur: 10 }]).project
  p = applyOps(p, [
    { op: 'keyframe', id: 'c1', prop: 'x', at: 0, value: 0 },
    { op: 'keyframe', id: 'c1', prop: 'x', at: 2, value: 100 },
    { op: 'expression', id: 'c1', prop: 'x', expr: 'loopOut("cycle")' },
  ]).project
  const c = findClip(p, 'c1').clip
  assert.equal(valueAt(p, c, 'x', 1), 50)
  assert.equal(valueAt(p, c, 'x', 3), 50)
})

test('compositions nest, refuse cycles, and ops find clips inside them', () => {
  let r = applyOps(base(), [
    { op: 'add_comp', name: 'Lower third' },
    { op: 'add_shape', comp: 'k1', track: 'V1' },
    { op: 'add_comp', name: 'Outer' },
    { op: 'comp_clip', comp: 'k2', target: 'k1', track: 'V1' },
    { op: 'comp_clip', target: 'k2', track: 'V1' },
  ])
  const p = r.project
  assert.equal(findClip(p, 'c1').comp, 'k1')
  assert.ok(compContains(p, 'k2', 'k1'))
  assert.throws(() => applyOps(p, [{ op: 'comp_clip', comp: 'k1', target: 'k2', track: 'V1' }]), /contain itself/)
  r = applyOps(p, [{ op: 'move', id: 'c1', start: 2 }])
  assert.equal(findClip(r.project, 'c1').clip.start, 2)
  assert.equal(findClip(r.project, 'c1').comp, 'k1')
})

test('precompose moves clips into a new composition and leaves one comp clip', () => {
  let p = applyOps(base(), [{ op: 'append', src: 'a.mp4', track: 'V1', dur: 3 }, { op: 'add_title', track: 'V2', start: 1, dur: 2, text: 'Hi' }]).project
  const r = applyOps(p, [{ op: 'precompose', ids: ['c1', 'c2'], name: 'Intro' }])
  p = r.project
  const comp = Object.values(p.comps)[0]
  assert.equal(comp.duration, 3)
  assert.deepEqual(comp.tracks.map(t => [t.id, t.clips.map(c => [c.id, c.start])]), [['V1', [['c1', 0]]], ['V2', [['c2', 1]]]])
  const host = p.tracks.flatMap(t => t.clips).filter(c => c.kind === 'comp')
  assert.equal(host.length, 1)
  assert.equal(host[0].dur, 3)
})

test('masks, mattes, parenting and node graphs', () => {
  let p = applyOps(base(), [{ op: 'add_shape', track: 'V1' }, { op: 'add_null', track: 'V2' }]).project
  p = applyOps(p, [
    { op: 'add_mask', id: 'c1', mask: { type: 'ellipse', feather: 20 } },
    { op: 'update_mask', id: 'c1', mask: 'mk1', set: { inverted: true } },
    { op: 'matte', id: 'c1', matte: { mode: 'lumaInverted' } },
    { op: 'parent', id: 'c1', parent: 'c2' },
    { op: 'node_add', id: 'c1', node: { type: 'corrector', grade: { saturation: 0 } } },
    { op: 'node_add', id: 'c1', node: { type: 'blur', radius: 4 } },
  ]).project
  const c = findClip(p, 'c1').clip
  assert.deepEqual(c.masks.map(m => [m.id, m.inverted, m.feather]), [['mk1', true, 20]])
  assert.equal(c.matte.mode, 'lumaInverted')
  assert.equal(c.parent, 'c2')
  assert.deepEqual(nodeOrder(c.nodes).map(n => n.type), ['source', 'primary', 'corrector', 'blur', 'output'])
  assert.throws(() => applyOps(p, [{ op: 'parent', id: 'c2', parent: 'c1' }]), /loop/)
  assert.throws(() => applyOps(p, [{ op: 'node_link', id: 'c1', from: 'n5', to: 'n2' }]), /loop/)
  p = applyOps(p, [{ op: 'node_delete', id: 'c1', node: 'n4' }]).project
  assert.deepEqual(nodeOrder(findClip(p, 'c1').clip.nodes).map(n => n.type), ['source', 'primary', 'blur', 'output'])
})

test('multicam cuts and captions', () => {
  let r = applyOps(base(), [{ op: 'make_multicam', srcs: ['a.mp4', 'b.mp4'], track: 'V1' }])
  const id = r.created[0]
  r = applyOps(r.project, [{ op: 'multicam_cut', id, at: 2, angle: 1 }, { op: 'multicam_cut', id, at: 4, angle: 1 }, { op: 'multicam_cut', id, at: 5, angle: 0 }])
  assert.deepEqual(findClip(r.project, id).clip.cuts, [{ t: 0, angle: 0 }, { t: 2, angle: 1 }, { t: 5, angle: 0 }])
  r = applyOps(r.project, [{ op: 'captions', items: [{ t: 0, end: 1, text: 'one' }, { t: 1, end: 2.5, text: 'two' }] }])
  const cap = r.project.tracks.find(t => t.kind === 'caption')
  assert.deepEqual(cap.clips.map(c => [c.text, c.start, c.dur]), [['one', 0, 1], ['two', 1, 1.5]])
})

test('v2 projects migrate to v3 without losing anything', () => {
  const v2 = { version: 2, name: 'old', width: 1920, height: 1080, fps: 30, tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'video', src: 'a.mp4', start: 0, dur: 2, grade: { look: 'film' } }] }], markers: [], assets: {} }
  const p = migrate(structuredClone(v2))
  assert.equal(p.version, 3)
  assert.deepEqual(p.comps, {})
  assert.deepEqual(p.tracks[0].clips[0].grade, { look: 'film' })
})
