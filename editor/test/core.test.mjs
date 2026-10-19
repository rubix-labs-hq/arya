// node --test editor/test
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyOps, duration, ease, newProject, valueAt } from '../core/project.js'

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
