// node --test editor/test
// Clip times are rounded to 0.0001 s and range edges to the frame, so the two can differ by less
// than a frame. An edit must not leave a clip, or a hole, of that length behind.
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyOps, clipEnd, newProject } from '../core/project.js'

const FRAME = 1 / 30

// The shape of the project the problem was found in: three takes of one recording, 30 fps. The
// second take ends, and the third starts, at 9.0666, which is 0.00007 s before frame 272.
function takes() {
  const p = newProject('t')
  p.assets = { 'talk.mp4': { duration: 60, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true }, 'bed.m4a': { duration: 60, hasVideo: false, hasAudio: true } }
  const made = applyOps(p, [
    { op: 'append', src: 'talk.mp4', track: 'V1', in: 0, dur: 4 },
    { op: 'append', src: 'talk.mp4', track: 'V1', in: 6.4, dur: 4 },
    { op: 'append', src: 'talk.mp4', track: 'V1', in: 13.2, dur: 4 },
    { op: 'append', src: 'talk.mp4', track: 'V1', in: 30, dur: 2 },
    { op: 'append', src: 'bed.m4a', track: 'A2', in: 0, dur: 20 },
  ]).project
  // Earlier ripple edits left these times, each rounded to 0.0001 s.
  for (const id of ['V1', 'A1']) place(made, id, [[0, 4.3333], [4.3333, 4.7333], [9.0666, 4.8333], [13.8999, 2]])
  return made
}

const place = (p, id, times) => p.tracks.find(track => track.id === id).clips.forEach((c, index) => { [c.start, c.dur] = times[index] })

const clips = (p, id) => p.tracks.find(track => track.id === id).clips
const row = (p, id) => clips(p, id).map(c => `${c.id} ${c.start}+${c.dur} in ${c.in}`)
const shortest = p => Math.min(...p.tracks.flatMap(track => track.clips.map(c => c.dur)))
/** The holes between neighbouring clips of a track that are shorter than a frame. */
const holes = (p, id) => clips(p, id).slice(1).map((c, index) => c.start - clipEnd(clips(p, id)[index])).filter(gap => gap > 1e-6 && gap < FRAME)
// The exporter draws frame n at (n + 0.0001) / fps and takes the clip that covers that time.
const shownAt = (p, id, frame) => { const t = (frame + 0.0001) / p.fps; return clips(p, id).find(c => c.start <= t + 1e-6 && t < clipEnd(c) - 1e-6)?.id ?? null }

test('the starting project has the rounding the problem needs', () => {
  const p = takes()
  assert.deepEqual(row(p, 'V1'), ['c1 0+4.3333 in 0', 'c2 4.3333+4.7333 in 6.4', 'c3 9.0666+4.8333 in 13.2', 'c4 13.8999+2 in 30'])
  assert.deepEqual(row(p, 'A1').map(text => text.split(' ').slice(1).join(' ')), row(p, 'V1').map(text => text.split(' ').slice(1).join(' ')))
})

test('a ripple delete that starts on a clip\'s first frame leaves no sub-frame clip and no hole', () => {
  // What the assistant sent: frames 272 to 325.
  const result = applyOps(takes(), [{ op: 'delete_range', from: 9.066666666666666, to: 10.833333333333334, tracks: ['V1', 'A1'], ripple: true }])
  const p = result.project
  assert.deepEqual(row(p, 'V1'), ['c1 0+4.3333 in 0', 'c2 4.3333+4.7333 in 6.4', 'c3 9.0666+3.0666 in 14.9667', 'c4 12.1332+2 in 30'])
  assert.deepEqual(clips(p, 'A1').map(c => [c.start, c.dur, c.in]), clips(p, 'V1').map(c => [c.start, c.dur, c.in]), 'the linked sound is cut the same way')
  assert.ok(shortest(p) >= FRAME / 2, `no clip is shorter than half a frame (shortest ${shortest(p)})`)
  assert.deepEqual(holes(p, 'V1'), []); assert.deepEqual(holes(p, 'A1'), [])
  assert.deepEqual(result.created, [], 'the clip that lost its start keeps its id, and no new clip is made')
  assert.equal(shownAt(p, 'V1', 271), 'c2'); assert.equal(shownAt(p, 'V1', 272), 'c3', 'frame 272 shows the take after the cut, not a hole and not the removed frame')
  assert.equal(clips(p, 'V1').find(c => c.id === 'c3').link, clips(p, 'A1')[2].link)
})

test('the same range without ripple leaves the rest of the clip at the end of the range', () => {
  const p = applyOps(takes(), [{ op: 'delete_range', from: 9.066666666666666, to: 10.833333333333334, tracks: ['V1', 'A1'], ripple: false }]).project
  assert.deepEqual(row(p, 'V1'), ['c1 0+4.3333 in 0', 'c2 4.3333+4.7333 in 6.4', 'c3 10.83333+3.0666 in 14.9667', 'c4 13.8999+2 in 30'])
  assert.ok(shortest(p) >= FRAME / 2)
})

test('a range that ends on a clip\'s last frame leaves nothing of the clip after it', () => {
  // The third take ends 0.00005 s after frame 417, and the range ends on frame 417.
  const base = () => { const p = takes(); for (const id of ['V1', 'A1']) place(p, id, [[0, 4.3333], [4.3333, 4.7333], [9.0666, 4.83345], [13.90005, 2]]); return p }
  const cut = { op: 'delete_range', from: 12, to: 13.9, tracks: ['V1', 'A1'] }
  const closed = applyOps(base(), [{ ...cut, ripple: true }])
  assert.deepEqual(row(closed.project, 'V1'), ['c1 0+4.3333 in 0', 'c2 4.3333+4.7333 in 6.4', 'c3 9.0666+2.9334 in 13.2', 'c4 12+2 in 30'])
  assert.deepEqual(closed.created, [], 'no clip is made from the 0.00005 s after the range')
  assert.deepEqual(holes(closed.project, 'V1'), [])
  const open = applyOps(base(), [{ ...cut, ripple: false }])
  assert.deepEqual(row(open.project, 'V1'), ['c1 0+4.3333 in 0', 'c2 4.3333+4.7333 in 6.4', 'c3 9.0666+2.9334 in 13.2', 'c4 13.90005+2 in 30'])
  assert.deepEqual(open.created, [])
})

test('a clip that lies inside the range by less than half a frame at both ends is removed, and the range closes', () => {
  const base = takes()
  // A clip from 9.0666 to 10.8334 between its neighbours; the range is frames 272 to 325.
  for (const id of ['V1', 'A1']) place(base, id, [[0, 4.3333], [4.3333, 4.7333], [9.0666, 1.7668], [10.8334, 2]])
  const p = applyOps(base, [{ op: 'delete_range', from: 9.066666666666666, to: 10.833333333333334, tracks: ['V1', 'A1'], ripple: true }]).project
  assert.deepEqual(row(p, 'V1'), ['c1 0+4.3333 in 0', 'c2 4.3333+4.7333 in 6.4', 'c4 9.0666+2 in 30'])
  assert.deepEqual(holes(p, 'V1'), []); assert.equal(shownAt(p, 'V1', 272), 'c4')
})

test('a long clip on another track is split at the frame, and every clip stays in step', () => {
  const p = applyOps(takes(), [{ op: 'delete_range', from: 9.066666666666666, to: 10.833333333333334, ripple: true }]).project
  // The music bed spans the range, so it is split in two parts that meet.
  assert.deepEqual(row(p, 'A2'), ['c5 0+9.0667 in 0', 'c6 9.0667+9.1667 in 10.8333'])
  assert.deepEqual(row(p, 'V1'), ['c1 0+4.3333 in 0', 'c2 4.3333+4.7333 in 6.4', 'c3 9.0666+3.0666 in 14.9667', 'c4 12.1332+2 in 30'])
  assert.ok(shortest(p) >= FRAME / 2)
})

test('a range well inside a clip still splits it in two', () => {
  const result = applyOps(takes(), [{ op: 'delete_range', from: 10, to: 11, tracks: ['V1', 'A1'], ripple: true }])
  assert.deepEqual(row(result.project, 'V1'), ['c1 0+4.3333 in 0', 'c2 4.3333+4.7333 in 6.4', 'c3 9.0666+0.9334 in 13.2', 'c6 10+2.8999 in 15.1334', 'c4 12.8999+2 in 30'])
  assert.equal(result.created.length, 2, 'the picture and its sound each get a new clip')
  // Half a frame or more is kept: a range that starts one frame into the clip keeps that frame.
  const frame = applyOps(takes(), [{ op: 'delete_range', from: 9.1, to: 10, tracks: ['V1'], ripple: true }]).project
  assert.deepEqual(row(frame, 'V1').slice(2, 4), ['c3 9.0666+0.0334 in 13.2', 'c6 9.1+3.8999 in 14.1334'])
})

test('a range of no length beside a clip edge leaves that clip as it was', () => {
  const before = takes(), after = applyOps(takes(), [{ op: 'delete_range', from: 9.066666666666666, to: 9.066666666666666, tracks: ['V1', 'A1'] }]).project
  assert.deepEqual(after.tracks, before.tracks)
})

test('inserting on a clip\'s first frame moves the whole clip instead of leaving a sliver of it behind', () => {
  const result = applyOps(takes(), [{ op: 'insert', src: 'talk.mp4', track: 'V1', at: 9.066666666666666, in: 40, dur: 1 }])
  const p = result.project
  assert.ok(shortest(p) >= FRAME / 2, `shortest ${shortest(p)}: ${row(p, 'V1').join(' | ')}`)
  assert.deepEqual(clips(p, 'V1').map(c => c.id).slice(0, 2), ['c1', 'c2'])
  assert.equal(clips(p, 'V1').length, 5, 'four takes and the inserted clip')
  assert.equal(clips(p, 'V1').find(c => c.id === 'c3').dur, 4.8332, 'the take after the insert keeps its length to within 0.0001 s')
})
