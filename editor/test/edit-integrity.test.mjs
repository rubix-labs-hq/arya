// Edits that split clips keep every clip id unique and keep video and its linked audio in sync.
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyOps, clipEnd, newProject } from '../core/project.js'

function threeClips() {
  const p = newProject('t')
  p.assets = {
    'a.mp4': { duration: 60, width: 1920, height: 1080, hasVideo: true, hasAudio: true },
    'b.mp4': { duration: 60, width: 1920, height: 1080, hasVideo: true, hasAudio: true },
  }

  return applyOps(p, [
    { op: 'append', src: 'a.mp4', in: 0, out: 10 },
    { op: 'append', src: 'b.mp4', in: 2, out: 10 },
    { op: 'append', src: 'a.mp4', in: 20, out: 30 },
  ]).project
}

const all = p => p.tracks.flatMap(t => t.clips.map(c => ({ ...c, track: t.id })))

function assertUniqueIds(p) {
  const ids = all(p).map(c => c.id)
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], `duplicate clip ids in ${ids.join(' ')}`)
}

/** Every link group is one video and one audio clip at the same place in the same source. */
function assertLinksInSync(p) {
  const groups = Map.groupBy(all(p).filter(c => c.link), c => c.link)
  for (const [link, clips] of groups) {
    assert.ok(clips.length <= 2, `${link} groups ${clips.map(c => c.id).join(', ')}`)
    const [a, b] = clips
    if (!b) continue
    assert.equal(a.start, b.start, `${link} start`)
    assert.equal(a.dur, b.dur, `${link} duration`)
    assert.equal(a.in, b.in, `${link} source in`)
  }
}

for (const [name, op] of [
  ['insert inside a clip', { op: 'insert', src: 'b.mp4', start: 3, in: 0, dur: 2 }],
  ['overwrite inside a clip', { op: 'overwrite', src: 'b.mp4', start: 3, in: 0, dur: 2 }],
  ['delete_range inside a clip', { op: 'delete_range', from: 3, to: 5 }],
  ['freeze inside a clip', { op: 'freeze', id: 'c1', at: 5, dur: 2 }],
]) {
  test(`${name} gives every new clip its own id and the split tail its own link`, () => {
    const p = applyOps(threeClips(), [op]).project
    assertUniqueIds(p)
    assertLinksInSync(p)
    const head = all(p).find(c => c.id === 'c1')
    const tail = all(p).find(c => c.track === 'V1' && c.src === 'a.mp4' && c.in > 0 && c.in < 20 && !c.freeze)
    assert.ok(tail, 'the split tail exists')
    assert.notEqual(tail.link, head.link, 'the tail does not move with the head')
  })
}

test('a split tail id never collides with a later clip on the same track', () => {
  const p = newProject('t')
  p.assets = { 'v.mp4': { duration: 30, width: 1920, height: 1080, hasVideo: true, hasAudio: false } }
  // c1 then c2 on V1 only, so c2 is the highest id and sits after the split point.
  const base = applyOps(p, [{ op: 'append', src: 'v.mp4', in: 0, out: 10 }, { op: 'append', src: 'v.mp4', in: 10, out: 20 }]).project
  const out = applyOps(base, [{ op: 'overwrite', src: 'v.mp4', start: 2, in: 0, dur: 1 }]).project
  assertUniqueIds(out)
})

test('ops after an insert act on the clip they name', () => {
  let p = applyOps(threeClips(), [{ op: 'insert', src: 'b.mp4', start: 3, in: 0, dur: 2 }]).project
  const tail = all(p).find(c => c.track === 'V1' && c.src === 'a.mp4' && c.start === 5)
  const before = tail.dur
  p = applyOps(p, [{ op: 'trim', id: 'c1', edge: 'right', to: 2, ripple: true }]).project
  const after = all(p).find(c => c.id === tail.id)
  assert.equal(after.dur, before, 'trimming the head leaves the tail length alone')
  assertLinksInSync(p)
})

const clip = (p, id) => all(p).find(c => c.id === id)
const span = (p, id) => { const c = clip(p, id); return [c.start, c.dur, c.in] }

test('roll moves the linked audio edit with the video edit', () => {
  const p = applyOps(threeClips(), [{ op: 'roll', a: 'c1', b: 'c2', to: 11 }]).project
  assert.deepEqual(span(p, 'c1'), [0, 11, 0])
  assert.deepEqual(span(p, 'c1a'), [0, 11, 0])
  assert.deepEqual(span(p, 'c2'), [11, 7, 3])
  assert.deepEqual(span(p, 'c2a'), [11, 7, 3])
  assertLinksInSync(p)
})

test('an unlinked roll of the audio edit makes a J cut and leaves the picture alone', () => {
  const p = applyOps(threeClips(), [{ op: 'roll', a: 'c1a', b: 'c2a', to: 9, unlinked: true }]).project
  assert.deepEqual(span(p, 'c1'), [0, 10, 0])
  assert.deepEqual(span(p, 'c2'), [10, 8, 2])
  assert.deepEqual(span(p, 'c1a'), [0, 9, 0])
  assert.deepEqual(span(p, 'c2a'), [9, 9, 1])
  // A later linked trim keeps the one-second split.
  const q = applyOps(p, [{ op: 'trim', id: 'c2', edge: 'right', to: 17, ripple: true }]).project
  assert.equal(clipEnd(clip(q, 'c2')), 17)
  assert.equal(clipEnd(clip(q, 'c2a')), 17)
  assert.equal(clip(q, 'c2a').start, 9)
})

test('slide keeps video, audio and both neighbours in sync', () => {
  const p = applyOps(threeClips(), [{ op: 'slide', id: 'c2', delta: 1 }]).project
  assert.deepEqual(span(p, 'c1'), [0, 11, 0])
  assert.deepEqual(span(p, 'c2'), [11, 8, 2])
  assert.deepEqual(span(p, 'c3'), [19, 9, 21])
  assertLinksInSync(p)
})

test('a batch that slides or rolls every linked clip itself moves each clip once', () => {
  // The native timeline plans one slide per linked clip and one roll per linked pair.
  const slid = applyOps(threeClips(), [{ op: 'slide', id: 'c2', delta: 1 }, { op: 'slide', id: 'c2a', delta: 1 }]).project
  assert.deepEqual(span(slid, 'c2'), [11, 8, 2])
  assert.deepEqual(span(slid, 'c2a'), [11, 8, 2])
  assert.deepEqual(span(slid, 'c3a'), [19, 9, 21])
  assertLinksInSync(slid)
  const rolled = applyOps(threeClips(), [{ op: 'roll', a: 'c1', b: 'c2', to: 11 }, { op: 'roll', a: 'c1a', b: 'c2a', to: 11 }]).project
  assert.deepEqual(span(rolled, 'c2a'), [11, 7, 3])
  assertLinksInSync(rolled)
})

test('duplicate copies linked audio and never covers the next clip', () => {
  const p = applyOps(threeClips(), [{ op: 'duplicate', id: 'c1' }]).project
  const copies = all(p).filter(c => !['c1', 'c1a', 'c2', 'c2a', 'c3', 'c3a'].includes(c.id))
  assert.equal(copies.length, 2, 'video and its audio')
  assert.deepEqual(copies.map(c => [c.kind, c.start, c.dur, c.in]).sort(), [['audio', 28, 10, 0], ['video', 28, 10, 0]])
  assert.equal(copies[0].link, copies[1].link)
  assert.notEqual(copies[0].link, 'Lc1')
  assert.deepEqual(overlapsOf(p), [])
  assertLinksInSync(p)
  // Command-D with Linked selection sends both clips: one linked copy each, not two.
  const both = applyOps(threeClips(), [{ op: 'duplicate', id: 'c3' }, { op: 'duplicate', id: 'c3a' }]).project
  assert.equal(all(both).length, 8)
  assert.deepEqual(all(both).filter(c => c.start === 28).map(c => c.kind).sort(), ['audio', 'video'])
  assertLinksInSync(both)
  // An explicit start (Option-drag) is used as given, and unlinked copies one clip.
  const placed = applyOps(threeClips(), [{ op: 'duplicate', id: 'c2', start: 40, unlinked: true }]).project
  assert.deepEqual(all(placed).filter(c => c.start === 40).map(c => c.kind), ['video'])
})

test('duplicate checks each linked member where it lands, so a J cut copy never covers the original audio', () => {
  // c2's audio starts 1 s before its picture (a J cut), and A1 has room only after the audio clips.
  let p = applyOps(threeClips(), [{ op: 'roll', a: 'c1a', b: 'c2a', to: 9, unlinked: true }, { op: 'delete', ids: ['c3'] }]).project
  p = applyOps(p, [{ op: 'duplicate', id: 'c2' }]).project
  assert.deepEqual(overlapsOf(p), [])
  const copies = all(p).filter(c => !['c1', 'c1a', 'c2', 'c2a'].includes(c.id))
  const video = copies.find(c => c.kind === 'video'), audio = copies.find(c => c.kind === 'audio')
  assert.equal(video.start - audio.start, 1, 'the copy keeps the J cut offset')
  assert.ok(audio.start >= 18, 'the audio copy lands after the original audio')
  assert.deepEqual([audio.start, video.start], [18, 19], 'the pair starts where both members fit')
})

const overlapsOf = p => p.tracks.flatMap(t => t.clips.slice(1).filter((c, i) => t.clips[i].start + t.clips[i].dur > c.start + 1e-6).map(c => `${t.id}:${c.id}`))

test('the ops reference tells callers to edit a linked clip once; separate calls for each partner move the pair twice', async () => {
  const { OPS_DOC } = await import('../core/project.js')
  assert.match(OPS_DOC, /Edit a linked clip once: a separate call for its partner moves the pair twice/)
  let p = applyOps(threeClips(), [{ op: 'slide', id: 'c2', delta: 1 }]).project
  p = applyOps(p, [{ op: 'slide', id: 'c2a', delta: 1 }]).project
  assert.deepEqual(span(p, 'c2'), [12, 8, 2], 'the documented hazard: two calls slide two seconds')
  assertLinksInSync(p)
})

test('slide never trims a clip it does not touch', () => {
  let p = applyOps(threeClips(), [{ op: 'move', id: 'c3', start: 20 }]).project
  p = applyOps(p, [{ op: 'slide', id: 'c2', delta: 5 }]).project
  // c2 ends at 18 and c3 starts at 20: the slide stops at the gap and c3 keeps its start.
  assert.deepEqual(span(p, 'c3'), [20, 10, 20])
  assert.equal(clipEnd(clip(p, 'c2')), 20)
  assertLinksInSync(p)
})

test('a plain trim stops at the neighbouring clip on every linked track', () => {
  const p = applyOps(threeClips(), [{ op: 'trim', id: 'c2', edge: 'left', to: 9 }]).project
  assert.deepEqual(span(p, 'c2'), [10, 8, 2])
  assert.deepEqual(span(p, 'c2a'), [10, 8, 2])
  const q = applyOps(threeClips(), [{ op: 'trim', id: 'c2', edge: 'left', to: 11 }]).project
  assert.deepEqual(span(q, 'c2'), [11, 7, 3])
  assert.deepEqual(span(q, 'c2a'), [11, 7, 3])
})

test('slowing a clip ripples later clips instead of covering them', () => {
  const p = applyOps(threeClips(), [{ op: 'speed', id: 'c1', speed: 0.5 }]).project
  assert.deepEqual(span(p, 'c1'), [0, 20, 0])
  assert.deepEqual(span(p, 'c2'), [20, 8, 2])
  assert.deepEqual(span(p, 'c2a'), [20, 8, 2])
  assertLinksInSync(p)
  const kept = applyOps(threeClips(), [{ op: 'speed', id: 'c1', speed: 0.5, ripple: false }]).project
  assert.deepEqual(span(kept, 'c1'), [0, 10, 0])
  assert.deepEqual(span(kept, 'c2'), [10, 8, 2])
})
