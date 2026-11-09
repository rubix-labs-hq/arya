import assert from 'node:assert/strict'
import test from 'node:test'
import { applyOps, newProject, sourceTime } from '../core/project.js'

// A reversed clip reads its source backwards. Cutting or trimming it must keep every
// remaining frame on the same footage it showed before the edit.
function fixture() {
  const p = newProject('Reverse')
  p.assets['media/a.mp4'] = { hasVideo: true, duration: 30, fps: 30 }
  p.tracks = [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'video', src: 'media/a.mp4', start: 0, dur: 10, in: 5, speed: 1, reverse: true }] }]
  return p
}
const at = (p, t) => { const c = p.tracks[0].clips.find(x => x.start <= t && x.start + x.dur > t); return c && sourceTime(p, c, t) }
const same = (before, after, times) => { for (const t of times) assert.ok(Math.abs(at(before, t) - at(after, t)) < 1e-6, `footage at ${t}s: ${at(before, t)} vs ${at(after, t)}`) }

test('blade keeps reversed footage on both sides of the cut', () => {
  const p = fixture(), q = applyOps(p, [{ op: 'blade', id: 'c1', at: 4 }]).project
  assert.equal(q.tracks[0].clips.length, 2)
  same(p, q, [0, 1, 3.5, 4, 6, 9.5])
})

test('range clears keep reversed footage outside the range', () => {
  const p = fixture()
  same(p, applyOps(p, [{ op: 'delete_range', from: 3, to: 6, ripple: false }]).project, [0, 2.5, 6, 9])
  same(p, applyOps(p, [{ op: 'delete_range', from: 7, to: 12, ripple: false }]).project, [0, 3, 6.5])
  same(p, applyOps(p, [{ op: 'delete_range', from: 0, to: 2, ripple: false }]).project, [2, 5, 9.5])
})

test('trimming either edge of a reversed clip keeps the remaining footage and source limits', () => {
  const p = fixture()
  same(p, applyOps(p, [{ op: 'trim', id: 'c1', edge: 'left', to: 2 }]).project, [2, 5, 9.5])
  same(p, applyOps(p, [{ op: 'trim', id: 'c1', edge: 'right', to: 7 }]).project, [0, 3, 6.5])
  const longer = applyOps(p, [{ op: 'trim', id: 'c1', edge: 'right', to: 20 }]).project.tracks[0].clips[0]
  assert.equal(longer.dur, 15, 'the right edge stops where the source starts')
  assert.equal(longer.in, 0)
  const q = applyOps(p, [{ op: 'trim', id: 'c1', edge: 'right', to: 12 }]).project
  same(p, q, [0, 5, 9.5])
})

test('rolling and sliding next to a reversed clip keep its footage', () => {
  const p = newProject('Reverse roll')
  p.assets['media/a.mp4'] = { hasVideo: true, duration: 30, fps: 30 }
  p.assets['media/b.mp4'] = { hasVideo: true, duration: 30, fps: 30 }
  p.tracks = [{ id: 'V1', kind: 'video', clips: [
    { id: 'a', kind: 'video', src: 'media/a.mp4', start: 0, dur: 10, in: 5, speed: 1 },
    { id: 'b', kind: 'video', src: 'media/b.mp4', start: 10, dur: 10, in: 5, speed: 1, reverse: true },
    { id: 'c', kind: 'video', src: 'media/a.mp4', start: 20, dur: 5, in: 5, speed: 1, reverse: true },
  ] }]
  // Roll the a|b cut earlier: b gains frames at its head, the rest of b is unchanged.
  same(p, applyOps(p, [{ op: 'roll', a: 'a', b: 'b', to: 8 }]).project, [0, 7.5, 10, 15, 19.5])
  // Roll the b|c cut later: b grows at its tail and c loses its head.
  same(p, applyOps(p, [{ op: 'roll', a: 'b', b: 'c', to: 22 }]).project, [10, 15, 19.5, 22, 24.5])
  // Slide b earlier: a shortens, c starts sooner, and b's frames move with it.
  const slid = applyOps(p, [{ op: 'slide', id: 'b', delta: -2 }]).project
  for (const t of [10, 15, 19.5]) assert.ok(Math.abs(at(p, t) - at(slid, t - 2)) < 1e-6, `b footage at ${t}s`)
  same(p, slid, [0, 7.5, 21, 24.5])
})
