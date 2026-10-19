import assert from 'node:assert/strict'
import test from 'node:test'
import { changeReceipt, receiptSelection } from '../web/ui/change-receipt.js'

const project = () => ({ name: 'Receipt fixture', width: 1920, height: 1080, fps: 30, tracks: [{ id: 'V1', clips: [{ id: 'c1', kind: 'title', start: 0, dur: 4, title: { text: 'Opening', size: 80 } }] }], comps: { k1: { name: 'Brand lockup', width: 1080, height: 1920, fps: 24, tracks: [{ id: 'V2', clips: [{ id: 'c2', kind: 'shape', label: 'Figma mark', start: 1, dur: 3, x: 20, anim: { opacity: [[0, 0], [1, 1]] } }] }] } } })

test('assistant receipts preserve nested property differences without changing project data', () => {
  const before = project(), after = structuredClone(before), original = structuredClone(before)
  after.tracks[0].clips[0].title.size = 100
  after.comps.k1.tracks[0].clips[0].anim.opacity = [[0, 0], [0.5, 1]]
  const receipt = changeReceipt(before, after, { version: 8, who: 'agent', at: 123 })
  assert.equal(receipt.total, 2)
  assert.deepEqual(receipt.clips[0].changes, [{ property: 'title.size', before: '80', after: '100' }])
  assert.equal(receipt.clips[1].compositionName, 'Brand lockup')
  assert.deepEqual(receipt.clips[1].changes, [{ property: 'anim.opacity', before: '[[0,0],[1,1]]', after: '[[0,0],[0.5,1]]' }])
  assert.deepEqual(before, original)
  after.comps.k1.tracks[0].clips[0].anim.opacity[1][0] = 2
  assert.equal(receipt.clips[1].changes[0].after, '[[0,0],[0.5,1]]')
})

test('deleted and subsequently removed layers never enter a receipt selection', () => {
  const before = project(), after = structuredClone(before)
  after.tracks[0].clips = []
  after.comps.k1.tracks[0].clips[0].x = 45
  const receipt = changeReceipt(before, after, { version: 9, who: 'claude' })
  assert.equal(receipt.clips[0].status, 'deleted')
  assert.equal(receiptSelection(receipt, after, null), null)
  assert.deepEqual(receiptSelection(receipt, after, 'k1'), { ids: ['c2'], comp: 'k1', start: 1 })
  after.comps.k1.tracks[0].clips = []
  assert.equal(receiptSelection(receipt, after, 'k1'), null)
})

test('format and library changes are reported without inventing affected layers', () => {
  const before = project(), after = structuredClone(before)
  after.fps = 24
  after.library = { version: 1, items: [] }
  const receipt = changeReceipt(before, after, { version: 10, who: 'agent' })
  assert.equal(receipt.total, 0)
  assert.deepEqual(receipt.projectChanges, ['fps', 'library'])
  assert.equal(changeReceipt(before, after, { who: 'you' }), null)
  assert.equal(changeReceipt(before, before, { who: 'agent' }), null)
  assert.equal(changeReceipt(null, after, { who: 'agent' }), null)
})

test('large receipts bound display data while retaining the actual changed layer count', () => {
  const before = project(), after = structuredClone(before)
  after.tracks[0].clips = Array.from({ length: 100 }, (_, index) => ({ id: `new${index}`, kind: 'title', start: index, dur: 1, title: { text: 'A'.repeat(5000), size: 20 } }))
  const receipt = changeReceipt(before, after, { who: 'agent' })
  assert.equal(receipt.total, 101)
  assert.equal(receipt.clips.length, 80)
  assert.equal(receipt.truncated, true)
  assert.ok(receipt.clips[1].changes[0].after.length <= 1025)
})

// These use actual core operations with synthetic receipt data. They do not render
// media, contact a provider or establish that a referenced WAV exists on disk.
const { applyOps, newProject } = await import('../core/project.js')
const { musicAssetRecord, musicPlacementOps } = await import('../core/music-score.js')
const generatedPath = 'media/generated/music/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/score.wav'
const score = { version: 1, title: 'Reviewed cue', bpm: 120, lengthBeats: 28, seed: 17, room: 0.12,
  parts: [{ id: 'keys', instrument: 'keys', gainDb: -12, pan: 0, notes: [{ at: 0, duration: 1, pitch: 60, velocity: 0.7 }] }] }
const probeReceipt = { path: generatedPath, asset: { hasAudio: true, hasVideo: false, channels: 2, duration: 14, codec: 'pcm_s24le' },
  measurement: { samplePeakDb: -3, rmsDb: -18, samples: 14 * 48000 * 2 } }

test('saved-only generated asset registration has a Media diff without claiming timeline placement', () => {
  const before = applyOps(newProject('Saved music fixture'), []).project, asset = musicAssetRecord(score, probeReceipt)
  const saved = applyOps(before, [{ op: 'import', assets: { [generatedPath]: asset } }]).project
  const receipt = changeReceipt(before, saved, { version: 2, who: 'agent', at: 123 })
  assert.equal(receipt.total, 0)
  assert.equal(receipt.totalScopes, 1)
  assert.equal(receipt.totalAssets, 1)
  assert.deepEqual(receipt.projectChanges, ['assets'])
  assert.equal(receipt.scopes[0].asset, generatedPath)
  assert.equal(receipt.scopes[0].changes[0].property, `assets[${JSON.stringify(generatedPath)}].hasAudio`)
  assert.equal(receipt.scopes[0].changes[0].before, 'Absent')
  assert.equal(receipt.scopes[0].changes[0].after, 'true')
  assert.equal(receipt.scopes[0].changes.find(change => change.property.endsWith('.generated.provenance')).after,
    JSON.stringify(saved.assets[generatedPath].generated.provenance))
  assert.equal(receiptSelection(receipt, saved, null), null)
  assert.deepEqual(saved.tracks.flatMap(track => track.clips), [])
  assert.deepEqual(before.assets, {})
})

test('retry placement reports the new layer while retaining the same saved asset identity and provenance', () => {
  const initial = applyOps(newProject('Placement fixture'), []).project, asset = musicAssetRecord(score, probeReceipt)
  const saved = applyOps(initial, [{ op: 'import', assets: { [generatedPath]: asset } }]).project
  const placed = applyOps(saved, musicPlacementOps(saved, { score, start: 4, track: 'A3', expectedVersion: 2 }, probeReceipt)).project
  const receipt = changeReceipt(saved, placed, { version: 3, who: 'agent' })
  assert.equal(receipt.total, 1)
  assert.equal(receipt.clips[0].status, 'added')
  const diff = JSON.parse(receipt.clips[0].changes[0].after)
  assert.equal(diff.src, generatedPath)
  assert.equal(diff.start, 4)
  assert.equal(receipt.scopes.some(scope => scope.changes.some(change => change.property.startsWith('assets'))), false)
  assert.deepEqual(placed.assets[generatedPath], saved.assets[generatedPath])
  assert.deepEqual(receiptSelection(receipt, placed, null), { ids: [receipt.clips[0].id], comp: null, start: 4 })
})

test('actual track-only mixer operations report committed level, pan and mute values', () => {
  const before = applyOps(newProject('Mixer fixture'), []).project
  const after = applyOps(before, [{ op: 'update_track', id: 'A3', set: { volume: -6, pan: -0.25, muted: true, solo: true } }]).project
  const receipt = changeReceipt(before, after, { who: 'agent' })
  assert.equal(receipt.total, 0)
  assert.equal(receipt.totalScopes, 1)
  const scope = receipt.scopes[0]
  assert.equal(scope.comp, null)
  assert.equal(scope.track, 'A3')
  assert.match(scope.name, /Music/)
  assert.deepEqual(new Set(scope.changes.map(change => change.property)), new Set(['volume', 'pan', 'muted', 'solo']))
  assert.ok(scope.changes.some(change => change.property === 'volume' && change.before === '0' && change.after === '-6'))
  assert.ok(scope.changes.some(change => change.property === 'muted' && change.before === 'Absent' && change.after === 'true'))
  assert.equal(receiptSelection(receipt, after, null), null)
})

test('nested track and master edits retain exact scope and property values', () => {
  const before = project(), after = structuredClone(before)
  after.master = { volume: -2, limiter: { enabled: true } }
  after.comps.k1.tracks[0].volume = -12
  after.comps.k1.customMetadata = { approval: 'Reviewed' }
  const receipt = changeReceipt(before, after, { who: 'agent' })
  assert.equal(receipt.total, 0)
  assert.equal(receipt.totalScopes, 3)
  assert.deepEqual(receipt.scopes.find(scope => scope.comp === 'k1' && scope.track === 'V2').changes,
    [{ property: 'volume', before: 'Absent', after: '-12' }])
  assert.deepEqual(receipt.scopes.find(scope => scope.comp === null).changes,
    [{ property: 'master', before: 'Absent', after: '{"volume":-2,"limiter":{"enabled":true}}' }])
  assert.equal(receipt.scopes.find(scope => scope.comp === 'k1' && scope.track === null).changes[0].property, 'customMetadata')
})

test('empty tracks and compositions and ordered IDs have factual settings receipts', () => {
  const before = project(), after = structuredClone(before)
  after.tracks.push({ id: 'A3', name: 'Empty music bus', clips: [] })
  after.comps.empty = { name: 'Empty composition', tracks: [] }
  const receipt = changeReceipt(before, after, { who: 'agent' })
  assert.equal(receipt.total, 0)
  assert.ok(receipt.scopes.some(scope => scope.track === 'A3' && scope.status === 'added'))
  assert.ok(receipt.scopes.some(scope => scope.comp === 'empty' && scope.status === 'added'))
  assert.ok(receipt.scopes.some(scope => scope.changes.some(change => change.property === 'Track order' && change.after === '["V1","A3"]')))
  const removed = changeReceipt(after, before, { who: 'agent' })
  assert.ok(removed.scopes.some(scope => scope.track === 'A3' && scope.status === 'deleted'))
  assert.ok(removed.scopes.some(scope => scope.comp === 'empty' && scope.status === 'deleted'))
  after.tracks.reverse()
  assert.ok(changeReceipt(before, after, { who: 'agent' }).scopes.some(scope => scope.changes.some(change => change.after === '["A3","V1"]')))
})

test('receipt selection uses current starts and excludes matching IDs in other compositions', () => {
  const before = project(), after = structuredClone(before)
  after.tracks[0].clips[0].title.size = 100
  after.comps.k1.tracks[0].clips[0].id = 'c1'
  after.comps.k1.tracks[0].clips[0].x = 45
  const receipt = changeReceipt(before, after, { who: 'agent' })
  const current = structuredClone(after)
  current.tracks[0].clips[0].start = 12
  current.comps.k1.tracks[0].clips[0].start = 20
  assert.deepEqual(receiptSelection(receipt, current, null), { ids: ['c1'], comp: null, start: 12 })
  assert.deepEqual(receiptSelection(receipt, current, 'k1'), { ids: ['c1'], comp: 'k1', start: 20 })
  delete current.comps.k1
  assert.equal(receiptSelection(receipt, current, 'k1'), null)
  assert.deepEqual(receiptSelection(receipt, current, null), { ids: ['c1'], comp: null, start: 12 })
})

test('current multiple-layer selection uses its earliest surviving time and finite nonnegative values', () => {
  const before = project(), after = structuredClone(before)
  after.tracks[0].clips.push({ id: 'second', start: 3, dur: 2, kind: 'shape' })
  after.tracks[0].clips[0].start = 2
  const receipt = changeReceipt(before, after, { who: 'agent' })
  after.tracks[0].clips[0].start = 30
  after.tracks[0].clips[1].start = 8
  assert.deepEqual(receiptSelection(receipt, after, null), { ids: ['c1', 'second'], comp: null, start: 8 })
  after.tracks[0].clips[1].start = -4
  assert.equal(receiptSelection(receipt, after, null).start, 0)
  after.tracks[0].clips[1].start = Infinity
  assert.equal(receiptSelection(receipt, after, null).start, 0)
  after.tracks[0].clips.pop()
  assert.deepEqual(receiptSelection(receipt, after, null), { ids: ['c1'], comp: null, start: 30 })
})

test('JSON object key order alone cannot invent a layer edit', () => {
  const before = project(), after = structuredClone(before)
  const clip = after.tracks[0].clips[0]
  after.tracks[0].clips[0] = Object.fromEntries(Object.entries(clip).reverse())
  assert.equal(changeReceipt(before, after, { who: 'agent' }), null)
})

test('null, booleans and literal punctuation keys keep distinct exact property values', () => {
  const before = project(), after = structuredClone(before)
  before.tracks[0].clips[0].value = null
  before.tracks[0].clips[0].enabled = true
  before.tracks[0].clips[0]['a.b/c~d'] = 0
  after.tracks[0].clips[0].enabled = 1
  after.tracks[0].clips[0]['a.b/c~d'] = 1
  const changes = changeReceipt(before, after, { who: 'agent' }).clips[0].changes
  assert.ok(changes.some(change => change.property === 'value' && change.before === 'null' && change.after === 'Absent'))
  assert.ok(changes.some(change => change.property === 'enabled' && change.before === 'true' && change.after === '1'))
  assert.ok(changes.some(change => change.property === '["a.b/c~d"]' && change.before === '0' && change.after === '1'))
})

test('bounded UTF-8 receipt data admits valid JSON and declares shortened values and properties', () => {
  const before = project(), after = structuredClone(before)
  const long = '界\n"'.repeat(5000)
  after.tracks[0].clips = Array.from({ length: 100 }, (_, index) => ({ id: `new${index}`, label: long, start: index,
    ...Object.fromEntries(Array.from({ length: 80 }, (_, property) => [`p${property}`, long])) }))
  const receipt = changeReceipt(before, after, { who: 'agent' })
  assert.equal(receipt.total, 101)
  assert.equal(receipt.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt, null, 2)) <= 128 * 1024)
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)).total, 101)
  for (const clip of receipt.clips) {
    assert.ok(Buffer.byteLength(clip.name) <= 160)
    assert.ok(clip.changes.length <= 50)
    for (const change of clip.changes) {
      assert.ok(Buffer.byteLength(change.before) <= 1024)
      assert.ok(Buffer.byteLength(change.after) <= 1024)
    }
  }
  const properties = structuredClone(before)
  properties.tracks[0].clips[0] = { ...properties.tracks[0].clips[0], ...Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`p${index}`, index])) }
  const propertyReceipt = changeReceipt(before, properties, { who: 'agent' })
  assert.equal(propertyReceipt.clips[0].changes.length, 50)
  assert.equal(propertyReceipt.truncated, true)
})

test('oversized property paths report their exact parent and oversized IDs never become selectable aliases', () => {
  const before = project(), after = structuredClone(before), key = 'x'.repeat(600)
  before.tracks[0].clips[0].data = { [key]: 0 }
  after.tracks[0].clips[0].data = { [key]: 1 }
  const receipt = changeReceipt(before, after, { who: 'agent' })
  assert.equal(receipt.truncated, true)
  assert.equal(receipt.clips[0].changes[0].property, 'data')
  after.tracks[0].clips[0].id = 'y'.repeat(600)
  const oversized = changeReceipt(before, after, { who: 'agent' })
  assert.equal(oversized.total, 2)
  assert.equal(oversized.clips.some(clip => clip.id.startsWith('y')), false)
  assert.equal(receiptSelection(oversized, after, null), null)
})

test('prototype-like metadata keys and composition IDs retain added state and absent before values', () => {
  const before = project(), after = structuredClone(before)
  after.comps.constructor = { name: 'Constructor composition', tracks: [] }
  after.customMetadata = JSON.parse('{"constructor":"Reviewed","__proto__":{"status":"Approved"}}')
  before.customMetadata = {}
  const receipt = changeReceipt(before, after, { who: 'agent' })
  assert.equal(receipt.scopes.find(scope => scope.comp === 'constructor').status, 'added')
  const root = receipt.scopes.find(scope => scope.comp === null)
  assert.ok(root.changes.some(change => change.property === 'customMetadata.constructor' && change.before === 'Absent' && change.after === '"Reviewed"'))
  assert.ok(root.changes.some(change => change.property === 'customMetadata.__proto__' && change.before === 'Absent'))
  delete after.comps.constructor
  assert.equal(receiptSelection({ clips: [{ comp: 'constructor', id: 'c1', status: 'changed' }] }, after, 'constructor'), null)
})
