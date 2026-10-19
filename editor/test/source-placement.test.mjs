import { mediaDisplayName } from '../web/ui/media-label.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const editor = process.env.ARYA_TEST_EDITOR_ROOT ? new URL(`file://${process.env.ARYA_TEST_EDITOR_ROOT}/`) : new URL('../', import.meta.url)
const { applyOps, newProject } = await import(new URL('core/project.js', editor))
const sourceMedia = await import(new URL('web/ui/source-media.js', editor))
const viewer = fs.readFileSync(new URL('web/ui/viewer.js', editor), 'utf8')
const body = viewer.match(/  const place = how => \{([\s\S]*?)\n  \}\n  const pct/)[1]
const context = viewer.match(/  const sourceContext = (.*)\n/)?.[1] ?? 'null'
const placeFactory = new Function('p', 'src', 'asset', 'dur', 'isImage', 'time', 's', 'store', 'sourcePlacementPlan', 'edit', 'toast', 'mediaDisplayName', `const sourceContext = ${context}; return how => {${body}\n}`)

function project({ sound = false } = {}) {
  const result = newProject('Source placement')
  result.assets['media/source.mp4'] = { hasVideo: true, hasAudio: sound, duration: 10 }
  return result
}

function controller(p, src = { src: 'media/source.mp4', in: 2, out: 5 }) {
  const calls = [], notices = []
  const asset = p.assets[src.src] ?? {}, image = asset.hasVideo && !asset.duration
  const state = { root: 'fixture', version: 7, project: p, openComp: null, source: src }
  const store = state // useStore returns the live store rather than a value snapshot.
  const place = placeFactory(p, src, asset, asset.duration ?? 5, image, { t: 3 }, state, store, sourceMedia.sourcePlacementPlan,
    (op, summary, options) => calls.push({ op, summary, options }), (text, kind) => notices.push({ text, kind }), mediaDisplayName)
  return { calls, notices, place, store, state }
}

test('Source Connect with one video track refuses to overwrite the primary footage', () => {
  const p = project()
  p.tracks = p.tracks.filter(track => track.kind !== 'video' || track.id === 'V1')
  const c = controller(p)
  c.place('connect')
  assert.equal(c.calls.length, 0)
  assert.match(c.notices[0].text, /upper|video track/i)
})

test('Source Connect skips locked upper tracks and keeps the primary and locked tracks unchanged', () => {
  let p = project()
  p = applyOps(p, [{ op: 'add_color', track: 'V1', color: '#ff0000', start: 0, dur: 8 }, { op: 'add_color', track: 'V2', start: 0, dur: 8 }]).project
  p.tracks.find(track => track.id === 'V2').locked = true
  const before = structuredClone(p), c = controller(p)
  c.place('connect')
  assert.equal(c.calls[0].op.track, 'V3')
  const result = applyOps(p, [c.calls[0].op]).project
  for (const id of ['V1', 'V2']) assert.deepEqual(result.tracks.find(track => track.id === id), before.tracks.find(track => track.id === id))
})

test('Source Connect with sound refuses to overwrite the primary audio bed when no upper audio track exists', () => {
  const p = project({ sound: true })
  p.tracks = p.tracks.filter(track => track.kind !== 'audio' || track.id === 'A1')
  const c = controller(p)
  c.place('connect')
  assert.equal(c.calls.length, 0)
  assert.match(c.notices[0].text, /upper.*audio|audio.*upper/i)
})

test('Source Connect preserves the primary audio bed and creates a linked pair on upper destinations', () => {
  let p = project({ sound: true })
  p.assets['media/bed.wav'] = { hasVideo: false, hasAudio: true, duration: 10 }
  p = applyOps(p, [{ op: 'add_clip', src: 'media/bed.wav', track: 'A1', start: 0, dur: 10 }]).project
  const bed = structuredClone(p.tracks.find(track => track.id === 'A1')), c = controller(p)
  c.place('connect')
  assert.equal(c.calls[0].op.audioTrack, 'A2')
  const result = applyOps(p, [c.calls[0].op]).project
  assert.deepEqual(result.tracks.find(track => track.id === 'A1'), bed)
  const video = result.tracks.find(track => track.id === 'V2').clips[0]
  const audio = result.tracks.find(track => track.id === 'A2').clips[0]
  assert.equal(video.link, audio.link)
  assert.deepEqual([video.start, video.in, video.dur], [3, 2, 3])
  assert.deepEqual([audio.start, audio.in, audio.dur], [3, 2, 3])
})

test('Source append, insert and overwrite use unlocked destinations with the captured revision', () => {
  const p = project()
  p.tracks.find(track => track.id === 'V1').locked = true
  for (const mode of ['append', 'insert', 'overwrite']) {
    const c = controller(p)
    c.place(mode)
    assert.equal(c.calls[0].op.track, 'V2')
    assert.equal(c.calls[0].options.expectedVersion, 7)
    assert.equal(c.calls[0].op.start, mode === 'append' ? undefined : 3)
  }
})

test('Source placements reject all locked video destinations without an edit', () => {
  const p = project()
  for (const track of p.tracks.filter(track => track.kind === 'video')) track.locked = true
  for (const mode of ['append', 'insert', 'overwrite', 'connect']) {
    const c = controller(p)
    c.place(mode)
    assert.equal(c.calls.length, 0)
    assert.match(c.notices[0].text, /unlocked/i)
  }
})

test('Source placements reject missing, nonfinite and inverted source metadata or marks', () => {
  for (const duration of [0, -1, Infinity, NaN]) {
    const p = project()
    p.assets['media/source.mp4'].duration = duration
    const c = controller(p)
    c.place('insert')
    assert.equal(c.calls.length, 0)
  }
  for (const marks of [{ in: -1, out: 5 }, { in: NaN, out: 5 }, { in: 2, out: Infinity }, { in: 8, out: 5 }, { in: 2, out: 11 }]) {
    const c = controller(project(), { src: 'media/source.mp4', ...marks })
    c.place('insert')
    assert.equal(c.calls.length, 0)
  }
  const c = controller(project(), { src: 'media/missing.mp4' })
  c.place('insert')
  assert.equal(c.calls.length, 0)
})

test('Source range editing refuses a selected timeline span beyond remaining source handles', () => {
  const p = project()
  p.range = { in: 1, out: 7 }
  const c = controller(p, { src: 'media/source.mp4', in: 8, out: 10 })
  c.place('overwrite')
  assert.equal(c.calls.length, 0)
  assert.match(c.notices[0].text, /source|range/i)
})

test('Source range editing places exactly the selected span while retaining the source in mark', () => {
  const p = project()
  p.range = { in: 1, out: 5 }
  const c = controller(p)
  c.place('insert')
  assert.deepEqual([c.calls[0].op.start, c.calls[0].op.in, c.calls[0].op.out], [1, 2, 6])
  const result = applyOps(p, [c.calls[0].op]).project
  assert.deepEqual(result.tracks.find(track => track.id === 'V1').clips.map(clip => [clip.start, clip.in, clip.dur]), [[1, 2, 4]])
})

test('Source image marks define a timeline duration without a media source offset', () => {
  const p = project()
  p.assets['media/still.png'] = { hasVideo: true, hasAudio: false, still: true }
  const c = controller(p, { src: 'media/still.png', in: 1, out: 4 })
  c.place('insert')
  assert.deepEqual([c.calls[0].op.in, c.calls[0].op.dur], [0, 3])
  const result = applyOps(p, [c.calls[0].op]).project
  assert.equal(result.tracks.find(track => track.id === 'V1').clips[0].kind, 'image')
  assert.equal(result.tracks.find(track => track.id === 'V1').clips[0].dur, 3)
})

test('Source placement rejects rendered project, composition, revision and source drift', () => {
  for (const drift of [store => { store.root = 'other' }, store => { store.version += 1 }, store => { store.openComp = 'k1' }, store => { store.project = structuredClone(store.project) }, store => { store.source = { ...store.source, in: 4 } }]) {
    const c = controller(project())
    drift(c.store)
    c.place('overwrite')
    assert.equal(c.calls.length, 0)
    assert.match(c.notices[0].text, /changed/i)
  }
})
