// node --test editor/test
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyOps, duration, ease, newProject, valueAt } from '../core/project.js'
import { framePlan } from '../core/render-plan.js'

function base() {
  const p = newProject('t')
  p.assets = {
    'a.mp4': { duration: 10, width: 1920, height: 1080, hasVideo: true, hasAudio: true },
    'b.mp4': { duration: 10, width: 1280, height: 720, hasVideo: true, hasAudio: false },
    'm.m4a': { duration: 30, hasVideo: false, hasAudio: true },
  }

  return applyOps(p, [
    { op: 'append', src: 'a.mp4', track: 'V1', dur: 4 },
    { op: 'append', src: 'b.mp4', track: 'V1', dur: 4 },
  ]).project
}

const v1 = p => p.tracks.find(t => t.id === 'V1').clips.map(c => [c.id, c.start, c.dur, c.in])
const a1 = p => p.tracks.find(t => t.id === 'A1').clips.map(c => [c.id, c.start, c.dur, c.in, c.link])

test('append with sound adds a linked audio clip', () => {
  const p = base()
  assert.deepEqual(v1(p), [['c1', 0, 4, 0], ['c2', 4, 4, 0]])
  assert.deepEqual(a1(p), [['c1a', 0, 4, 0, 'Lc1']])
  assert.equal(duration(p), 8)
})

test('blade splits a clip and its linked audio at one point', () => {
  const p = applyOps(base(), [{ op: 'blade', at: 1.5, id: 'c1' }]).project
  assert.deepEqual(v1(p), [['c1', 0, 1.5, 0], ['c3', 1.5, 2.5, 1.5], ['c2', 4, 4, 0]])
  const audio = a1(p)
  assert.equal(audio.length, 2)
  assert.equal(audio[1][1], 1.5)
  assert.equal(audio[1][4], p.tracks[0].clips.find(c => c.id === 'c3').link)
})

test('ripple trim pulls later clips in', () => {
  const p = applyOps(base(), [{ op: 'trim', id: 'c1', edge: 'right', to: 3, ripple: true }]).project
  assert.deepEqual(v1(p), [['c1', 0, 3, 0], ['c2', 3, 4, 0]])
})

test('left ripple trim removes the head and closes the following cut without overlap', () => {
  const original = base()
  const snapshot = structuredClone(original)
  const p = applyOps(original, [{ op: 'trim', id: 'c1', edge: 'left', to: 1, ripple: true }]).project
  assert.deepEqual(v1(p), [['c1', 0, 3, 1], ['c2', 3, 4, 0]])
  assert.deepEqual(a1(p), [['c1a', 0, 3, 1, 'Lc1']])
  assert.equal(duration(p), 7)
  assert.deepEqual(original, snapshot)
  const normal = applyOps(original, [{ op: 'trim', id: 'c1', edge: 'left', to: 1 }]).project
  assert.deepEqual(v1(normal), [['c1', 1, 3, 1], ['c2', 4, 4, 0]])
})

test('left ripple extension uses available source handles while holding the timeline start', () => {
  const original = applyOps(base(), [{ op: 'update', id: 'c1', set: { in: 2, anim: { opacity: [[0, 0], [2, 1]] } } }, { op: 'update', id: 'c1a', set: { in: 2 } }]).project
  const p = applyOps(original, [{ op: 'trim', id: 'c1', edge: 'left', to: -1, ripple: true }]).project
  assert.deepEqual(v1(p), [['c1', 0, 5, 1], ['c2', 5, 4, 0]])
  assert.deepEqual(a1(p), [['c1a', 0, 5, 1, 'Lc1']])
  assert.deepEqual(p.tracks[0].clips[0].anim.opacity, [[1, 0], [3, 1]])
  const clamped = applyOps(original, [{ op: 'trim', id: 'c1', edge: 'left', to: -20, ripple: true }]).project
  assert.deepEqual(v1(clamped), [['c1', 0, 6, 0], ['c2', 6, 4, 0]])
})

test('left ripple trim holds a nonzero start and acts only inside the requested composition', () => {
  const original = base()
  original.comps = { nested: { width: 1920, height: 1080, fps: 30, tracks: [{ id: 'V1', kind: 'video', clips: [
    { id: 'c1', kind: 'video', src: 'a.mp4', start: 4, dur: 4, in: 2, speed: 1 },
    { id: 'c2', kind: 'video', src: 'b.mp4', start: 8, dur: 2, in: 0, speed: 1 },
  ] }] } }
  const p = applyOps(original, [{ op: 'trim', id: 'c1', comp: 'nested', edge: 'left', to: 5, ripple: true }]).project
  assert.deepEqual(p.tracks, original.tracks)
  assert.deepEqual(p.comps.nested.tracks[0].clips.map(c => [c.start, c.dur, c.in]), [[4, 3, 3], [7, 2, 0]])
})

test('explicit composition edits resolve reused clip IDs within the chosen scope', () => {
  const original = base()
  original.comps = { nested: { fps: 24, tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'title', start: 0, dur: 2, title: { text: 'Nested' } }] }] } }
  const nested = applyOps(original, [{ op: 'update', id: 'c1', comp: 'nested', set: { dur: 0 } }]).project
  assert.equal(nested.comps.nested.tracks[0].clips[0].dur, 1 / 24)
  assert.deepEqual(nested.tracks, original.tracks)
  const main = applyOps(original, [{ op: 'update', id: 'c1', comp: null, set: { label: 'Main' } }]).project
  assert.equal(main.tracks[0].clips[0].label, 'Main')
  assert.deepEqual(main.comps, original.comps)
  assert.throws(() => applyOps(original, [{ op: 'update', id: 'c2', comp: 'nested', set: { label: 'Wrong scope' } }]), /no clip c2/)
  const locked = structuredClone(original)
  locked.comps.nested.tracks[0].locked = true
  assert.throws(() => applyOps(locked, [{ op: 'update', id: 'c1', comp: 'nested', set: { label: 'Locked' } }]), /locked/)
})

test('roll moves the edit point within the media both sides have, keeping the length', () => {
  const p = applyOps(base(), [{ op: 'roll', a: 'c1', b: 'c2', to: 5 }]).project
  assert.deepEqual(v1(p), [['c1', 0, 5, 0], ['c2', 5, 3, 1]])
  assert.equal(duration(p), 8)
  // c2 starts at source 0, so there is nothing to roll back into.
  assert.deepEqual(v1(applyOps(base(), [{ op: 'roll', a: 'c1', b: 'c2', to: 3 }]).project), v1(base()))
})

test('slip changes the source window, slide moves between neighbors', () => {
  let p = applyOps(base(), [{ op: 'slip', id: 'c2', delta: 2 }]).project
  assert.equal(p.tracks[0].clips[1].in, 2)
  p = applyOps(applyOps(base(), [{ op: 'append', src: 'b.mp4', track: 'V1', dur: 2 }]).project, [{ op: 'slide', id: 'c2', delta: 1 }]).project
  assert.deepEqual(v1(p).map(c => [c[1], c[2]]), [[0, 5], [5, 4], [9, 1]])
})

test('insert ripples everything after the insert point; overwrite clears its range', () => {
  let p = applyOps(base(), [{ op: 'insert', src: 'b.mp4', track: 'V1', start: 2, dur: 1 }]).project
  assert.deepEqual(v1(p).map(c => [c[1], c[2]]), [[0, 2], [2, 1], [3, 2], [5, 4]])
  p = applyOps(base(), [{ op: 'overwrite', src: 'b.mp4', track: 'V1', start: 3, dur: 2 }]).project
  assert.deepEqual(v1(p).map(c => [c[1], c[2]]), [[0, 3], [3, 2], [5, 3]])
})

test('the speed log names a change of direction, and a Reverse toggle alone is not a retime', () => {
  const log = (p, op) => { const r = applyOps(p, [op]); return [r.project, r.log.at(-1)] }
  let [p, line] = log(base(), { op: 'speed', id: 'c1', speed: 2 })
  assert.equal(line, 'retimed c1 to 2x')
  ;[p, line] = log(p, { op: 'speed', id: 'c1', speed: 2, reverse: true })
  assert.equal(line, 'reversed c1')
  assert.equal(p.tracks[0].clips[0].reverse, true)
  ;[p, line] = log(p, { op: 'speed', id: 'c1', speed: 2 })
  assert.equal(line, 'retimed c1 to 2x', 'an op without reverse keeps the direction')
  ;[p, line] = log(p, { op: 'speed', id: 'c1', speed: 1, reverse: false })
  assert.equal(line, 'retimed c1 to 1x and restored forward playback')
  ;[p, line] = log(p, { op: 'speed', id: 'c1', speed: 0.5, reverse: true })
  assert.equal(line, 'retimed c1 to 0.5x and reversed it')
  ;[p, line] = log(p, { op: 'speed', id: 'c1', speed: 0.5, reverse: false })
  assert.equal(line, 'restored forward playback of c1')
})

test('delete_range removes a span on every track and closes it', () => {
  const p = applyOps(base(), [{ op: 'delete_range', from: 1, to: 2 }]).project
  assert.equal(duration(p), 7)
  assert.deepEqual(v1(p).map(c => [c[1], c[2], c[3]]), [[0, 1, 0], [1, 2, 2], [3, 4, 0]])
})

test('speed retimes the clip and its partner; a failed op leaves the project alone', () => {
  const p = applyOps(base(), [{ op: 'speed', id: 'c1', speed: 2 }]).project
  assert.equal(p.tracks[0].clips[0].dur, 2)
  assert.equal(p.tracks.find(t => t.id === 'A1').clips[0].dur, 2)
  const before = base()
  assert.throws(() => applyOps(before, [{ op: 'move', id: 'c1', start: 9 }, { op: 'delete', id: 'nope' }]))
  assert.equal(before.tracks[0].clips[0].start, 0)
})

test('keyframes interpolate with easing', () => {
  const p = applyOps(base(), [
    { op: 'keyframe', id: 'c1', prop: 'scale', at: 0, value: 1, ease: 'inOut' },
    { op: 'keyframe', id: 'c1', prop: 'scale', at: 2, value: 2 },
  ]).project
  const c = p.tracks[0].clips[0]
  assert.equal(valueAt(p, c, 'scale', 1), 1.5)
  assert.ok(valueAt(p, c, 'scale', 0.5) < 1.25)
  assert.ok(Math.abs(ease('linear', 0.3) - 0.3) < 1e-4)
})

test('update ignores prototype pollution keys in nested objects', () => {
  const payload = JSON.parse('{"grade":{"__proto__":{"polluted":true},"exposure":0.2},"constructor":{"prototype":{"polluted":true}}}')
  const p = applyOps(base(), [{ op: 'update', id: 'c1', set: payload }]).project
  assert.equal(({}).polluted, undefined)
  assert.equal(p.tracks[0].clips[0].grade.exposure, 0.2)
  assert.equal(Object.hasOwn(p.tracks[0].clips[0].grade, '__proto__'), false)
})

test('freeze works inside nested compositions and marks frozen clip silent', () => {
  const p = base()
  p.comps = {
    nested: {
      width: 1920, height: 1080, fps: 30,
      tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'n1', kind: 'video', src: 'a.mp4', start: 0, dur: 4, in: 0, speed: 1 }] }],
    },
  }
  const frozen = applyOps(p, [{ op: 'freeze', id: 'n1', comp: 'nested', at: 1, dur: 2 }]).project
  assert.deepEqual(frozen.tracks, p.tracks)
  const clips = frozen.comps.nested.tracks[0].clips
  assert.equal(clips.length, 3)
  assert.equal(clips[1].start, 1)
  assert.equal(clips[1].dur, 2)
  assert.equal(clips[1].freeze, 1)
  assert.equal(clips[2].start, 3)
  assert.throws(() => applyOps(p, [{ op: 'freeze', id: 'n1', comp: 'nested', at: Number.NaN, dur: 1 }]), /finite/)
  assert.throws(() => applyOps(p, [{ op: 'freeze', id: 'n1', comp: 'nested', at: 1, dur: 0 }]), /positive/)
})

test('delete_range rejects non-finite bounds and treats empty spans as a no-op', () => {
  const original = base()
  assert.throws(() => applyOps(original, [{ op: 'delete_range', from: Number.NaN, to: 2 }]), /finite/)
  assert.throws(() => applyOps(original, [{ op: 'delete_range', from: 1, to: Infinity }]), /finite/)
  const empty = applyOps(original, [{ op: 'delete_range', from: 2, to: 1 }])
  assert.deepEqual(empty.project.tracks, original.tracks)
  assert.match(empty.log.at(-1), /empty range/)
})

test('framePlan computes finite parentMatrix when a parented child scales to zero', () => {
  const p = applyOps(base(), [
    { op: 'add_shape', track: 'V2', start: 0, dur: 4, shape: { type: 'rect', width: 100, height: 100 }, set: { x: 100, y: 50 } },
    { op: 'update', id: 'c1', set: { x: 200, y: 100 } },
  ]).project
  const child = p.tracks.find(t => t.id === 'V2').clips[0]
  const parented = applyOps(p, [
    { op: 'parent', id: child.id, parent: 'c1' },
    { op: 'update', id: child.id, set: { scale: 0 } },
  ]).project
  const plan = framePlan(parented, 1)
  const item = plan.layers.find(l => l.clip?.id === child.id)?.clip
  assert.ok(item)
  assert.ok(item.editTransform.parentMatrix.every(Number.isFinite), `expected finite parentMatrix, got ${item.editTransform.parentMatrix}`)
})
