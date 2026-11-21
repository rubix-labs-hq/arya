import test from 'node:test'
import assert from 'node:assert/strict'
import { newProject, applyOps, clipEnd } from '../core/project.js'

// V1 picture with linked A1 sound. a1 is an L cut: its sound runs 0.5 s into v2, so a2 starts
// 0.5 s after v2. V3 holds a title over v3 and A3 holds music under everything.
function fixture() {
  const p = newProject('ripple')
  const clip = (id, start, dur, link, kind = 'color') => ({ id, kind, ...(kind === 'color' ? { color: '#111' } : {}), start, dur, ...(link ? { link } : {}) })
  const track = id => p.tracks.find(t => t.id === id)
  track('V1').clips = [clip('v1', 0, 3, 'L1'), clip('v2', 3, 3, 'L2'), clip('v3', 6, 3, 'L3')]
  track('A1').clips = [clip('a1', 0, 3.5, 'L1', 'audio'), clip('a2', 3.5, 2.5, 'L2', 'audio'), clip('a3', 6, 3, 'L3', 'audio')]
  track('V3').clips = [clip('t3', 6.5, 2)]
  track('A3').clips = [clip('m', 0, 9, null, 'audio')]
  return p
}
const find = (p, id) => p.tracks.flatMap(t => t.clips.map(clip => ({ track: t.id, clip }))).find(x => x.clip.id === id)
const start = (p, id) => find(p, id)?.clip.start
const ids = (p, track) => p.tracks.find(t => t.id === track).clips.map(c => c.id)
const offset = (p, picture, sound) => Math.round((start(p, sound) - start(p, picture)) * 1e4) / 1e4
function videoOverlaps(p) {
  const found = []
  for (const t of p.tracks.filter(t => t.kind === 'video')) {
    const clips = [...t.clips].sort((a, b) => a.start - b.start)
    for (let i = 1; i < clips.length; i++) if (clips[i].start < clipEnd(clips[i - 1]) - 1e-6) found.push(`${t.id}:${clips[i - 1].id}/${clips[i].id}`)
  }
  return found
}

for (const [label, ops] of [
  ['the first clip', [{ op: 'ripple_delete', id: 'v1' }]],
  ['the picture and its sound selected together', [{ op: 'ripple_delete', ids: ['v1', 'a1'] }]],
  ['the sound clip of an L cut', [{ op: 'ripple_delete', id: 'a1' }]],
  ['a middle clip', [{ op: 'ripple_delete', id: 'v2' }]],
  ['two adjacent clips', [{ op: 'ripple_delete', ids: ['v1', 'v2'] }]],
  ['a delete with ripple set', [{ op: 'delete', id: 'v2', ripple: true }]],
]) test(`ripple deleting ${label} keeps every later linked picture and sound in sync`, () => {
  const before = fixture(), { project: after } = applyOps(before, ops)
  for (const [picture, sound] of [['v2', 'a2'], ['v3', 'a3']]) {
    if (!find(after, picture)) continue
    assert.equal(offset(after, picture, sound), offset(before, picture, sound), `${picture}/${sound}`)
  }
  assert.deepEqual(videoOverlaps(after), [])
})

test('ripple delete closes the picture gap on the linked tracks and leaves other tracks in place', () => {
  const { project } = applyOps(fixture(), [{ op: 'ripple_delete', id: 'v2' }])
  assert.deepEqual(ids(project, 'V1'), ['v1', 'v3']); assert.deepEqual(ids(project, 'A1'), ['a1', 'a3'])
  assert.equal(start(project, 'v3'), 3); assert.equal(start(project, 'a3'), 3)
  // The L-cut sound of v1 now plays 0.5 s into v3, as an L cut does; the audio mixer plays both.
  assert.equal(clipEnd(find(project, 'a1').clip), 3.5)
  // Unlinked tracks keep their times, so a title or music is never cut or pulled over other clips.
  assert.equal(start(project, 't3'), 6.5); assert.equal(start(project, 'm'), 0); assert.equal(find(project, 'm').clip.dur, 9)
})

test('unlinked ripple delete closes only the selected track', () => {
  const { project } = applyOps(fixture(), [{ op: 'ripple_delete', id: 'v2', unlinked: true }])
  assert.deepEqual(ids(project, 'A1'), ['a1', 'a2', 'a3'])
  assert.equal(start(project, 'v3'), 3); assert.equal(start(project, 'a3'), 6)
})

test('a locked linked track keeps its clips and times during a ripple delete', () => {
  const p = fixture(); p.tracks.find(t => t.id === 'A1').locked = true
  const { project } = applyOps(p, [{ op: 'ripple_delete', id: 'v2' }])
  assert.deepEqual(ids(project, 'A1'), ['a1', 'a2', 'a3']); assert.equal(start(project, 'a3'), 6); assert.equal(start(project, 'v3'), 3)
})

test('insert pushes every unlocked track, and ripple deleting the inserted clip restores the linked timeline', () => {
  const p = fixture()
  p.assets['media/b.mp4'] = { kind: 'video', duration: 2, hasAudio: false, width: 1920, height: 1080 }
  const inserted = applyOps(p, [{ op: 'insert', src: 'media/b.mp4', track: 'V1', start: 6, dur: 2 }])
  // Insert also splits the music that spans the insert point, so `created` holds that tail too.
  const id = inserted.created.find(x => find(inserted.project, x).track === 'V1')
  assert.equal(start(inserted.project, id), 6)
  assert.deepEqual(ids(inserted.project, 'A3').map(x => start(inserted.project, x)), [0, 8])
  for (const clip of ['v3', 'a3']) assert.equal(start(inserted.project, clip), 8)
  assert.equal(start(inserted.project, 't3'), 8.5)
  assert.deepEqual(videoOverlaps(inserted.project), [])
  const { project } = applyOps(inserted.project, [{ op: 'ripple_delete', id }])
  for (const clip of ['v1', 'v2', 'v3', 'a1', 'a2', 'a3']) assert.equal(start(project, clip), start(p, clip), clip)
  // Ripple delete closes only the tracks it removed clips from, so the title keeps its pushed time.
  assert.equal(start(project, 't3'), 8.5)
})

test('ripple trims keep later linked clips in sync with an L cut', () => {
  for (const op of [{ op: 'trim', id: 'v1', edge: 'right', to: 2, ripple: true }, { op: 'trim', id: 'v2', edge: 'left', to: 4, ripple: true }]) {
    const before = fixture(), { project } = applyOps(before, [op])
    for (const [picture, sound] of [['v2', 'a2'], ['v3', 'a3']]) assert.equal(offset(project, picture, sound), offset(before, picture, sound), `${op.edge} ${picture}`)
    assert.deepEqual(videoOverlaps(project), [])
  }
})

// v2 becomes a still or color clip with no sound: a ripple on V1 alone must carry v3's sound along.
function silentMiddle() {
  const p = fixture()
  p.tracks.find(t => t.id === 'V1').clips.find(c => c.id === 'v2').link = undefined
  p.tracks.find(t => t.id === 'A1').clips = p.tracks.find(t => t.id === 'A1').clips.filter(c => c.id !== 'a2')
  p.tracks.find(t => t.id === 'A1').clips.find(c => c.id === 'a1').dur = 3
  return p
}
for (const [label, op, v3] of [
  ['ripple delete', { op: 'ripple_delete', id: 'v2' }, 3],
  ['ripple trim of the right edge', { op: 'trim', id: 'v2', edge: 'right', to: 5, ripple: true }, 5],
  ['ripple trim of the left edge', { op: 'trim', id: 'v2', edge: 'left', to: 4, ripple: true }, 5],
  ['slower speed', { op: 'speed', id: 'v2', speed: 0.5 }, 9],
  ['faster speed with ripple', { op: 'speed', id: 'v2', speed: 2, ripple: true }, 4.5],
]) test(`${label} of a clip without sound keeps the later linked sound in sync`, () => {
  const { project } = applyOps(silentMiddle(), [op])
  assert.equal(start(project, 'v3'), v3); assert.equal(start(project, 'a3'), v3)
  assert.equal(start(project, 'a1'), 0); assert.equal(start(project, 't3'), 6.5)
  assert.deepEqual(videoOverlaps(project), [])
})
test('an unlinked ripple trim still edits one side only', () => {
  const { project } = applyOps(silentMiddle(), [{ op: 'trim', id: 'v2', edge: 'right', to: 5, ripple: true, unlinked: true }])
  assert.equal(start(project, 'v3'), 5); assert.equal(start(project, 'a3'), 6)
})
test('close gaps after a lift keeps linked pairs in sync without picture overlaps', () => {
  const before = fixture(), { project } = applyOps(before, [{ op: 'lift', id: 'v2' }, { op: 'close_gaps', track: 'V1' }])
  assert.deepEqual(ids(project, 'V1'), ['v1', 'v3'])
  assert.equal(start(project, 'v3'), 3); assert.equal(offset(project, 'v3', 'a3'), offset(before, 'v3', 'a3'))
  assert.deepEqual(videoOverlaps(project), [])
})

test('move with a linked partner keeps the pair in sync, and a later ripple delete still lines up', () => {
  const before = fixture()
  const moved = applyOps(before, [{ op: 'move', id: 'v3', start: 10 }]).project
  assert.equal(start(moved, 'v3'), 10); assert.equal(offset(moved, 'v3', 'a3'), 0)
  const { project } = applyOps(moved, [{ op: 'ripple_delete', id: 'v1' }])
  assert.equal(offset(project, 'v2', 'a2'), offset(before, 'v2', 'a2')); assert.equal(offset(project, 'v3', 'a3'), 0)
  assert.deepEqual(videoOverlaps(project), [])
})
