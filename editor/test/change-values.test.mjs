import test from 'node:test'
import assert from 'node:assert/strict'
import { h } from 'preact'
import { readableChange, settingsSummary, splitChanges } from '../web/ui/change-values.js'
import { changeReceipt } from '../web/ui/change-receipt.js'
import { assistantPanel } from '../web/ui/assistant-panel.js'

const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const children = node => flatten(node?.props?.children)
const text = node => children(node).map(child => typeof child === 'object' ? text(child) : String(child)).join('')
const nodes = node => node && typeof node === 'object' ? [node, ...children(node).flatMap(nodes)] : []
const json = value => JSON.stringify(value)

test('times read as seconds to two places with a timecode at the timeline frame rate', () => {
  assert.deepEqual(readableChange({ property: 'start', before: '9.43333', after: '0' }, { fps: 30 }),
    { property: 'start', label: 'start', before: '9.43 s · 00:00:09:13', after: '0.00 s · 00:00:00:00', swatches: null })
  assert.equal(readableChange({ property: 'dur', before: '2', after: '1.5' }, { fps: 25 }).after, '1.50 s · 00:00:01:13')
  assert.equal(readableChange({ property: 'in', before: 'Absent', after: '4.25' }).after, '4.25 s · 00:00:04:08')
  assert.equal(readableChange({ property: 'duration', before: '12', after: '8' }).after, '8.00 s · 00:00:08:00')
  // Only these exact names are times: a trim on a shape is a fraction, not seconds.
  assert.equal(readableChange({ property: 'shape.trim.start', before: '0', after: '0.333333' }).after, '0.333')
  assert.equal(readableChange({ property: 'opacity', before: '1', after: '0.70000001' }).after, '0.7')
})

test('keyframes become one line each, paired by time, with the ease named', () => {
  const before = json([[0, 0], [1, 1, 'out'], [2, 0.5, [0.2, 0, 0.4, 1]]])
  const after = json([[0, 0], [0.5, 0.25, 'inOut'], [1, 0.8, 'out'], [2, 0.5, [0.2, 0, 0.4, 1]]])
  const row = readableChange({ property: 'anim.opacity', before, after })
  assert.equal(row.label, 'anim.opacity')
  assert.deepEqual(row.keys, [
    { time: 'at 0.50 s', before: '', after: '0.25, inOut', status: 'added' },
    { time: 'at 1.00 s', before: '1, out', after: '0.8, out', status: 'changed' },
  ])
  const added = readableChange({ property: 'anim["fx.0.params.threshold"]', before: 'Absent', after: json([[0, -20], [1.25, -12, 'hold']]) })
  assert.deepEqual(added.keys.map(key => `${key.time} ${key.after}`), ['at 0.00 s -20, linear', 'at 1.25 s -12, hold'])
  const removed = readableChange({ property: 'anim.x', before: json([[0, 10, [0.1, 0.2, 0.3, 0.4]]]), after: 'Absent' })
  assert.deepEqual(removed.keys, [{ time: 'at 0.00 s', before: '10, custom curve', after: '', status: 'removed' }])
  // A keyframe list cut short by the receipt size limit is never shown as a JSON fragment.
  assert.deepEqual(readableChange({ property: 'anim.x', before: 'Absent', after: '[[0,1],[0.5,2],[1,…' }), { property: 'anim.x', label: 'anim.x', only: 'Keyframes too long to show here' })
})

test('colours get a swatch only for a strict hex value, and nothing reads as JSON', () => {
  const colour = readableChange({ property: 'title.color', before: json('#ffffff'), after: json('#FF8800cc') })
  assert.deepEqual([colour.before, colour.after, colour.swatches], ['#ffffff', '#FF8800cc', ['#ffffff', '#FF8800cc']])
  for (const value of ['red', '#12', 'url(x)', '#fff;background:url(x)']) assert.equal(readableChange({ property: 'color', before: 'Absent', after: json(value) }).swatches, null, value)
  assert.equal(readableChange({ property: 'crop', before: 'Absent', after: json({ l: 0.1, r: 0, t: 0.05, b: 0 }) }).after, 'l 0.1, r 0, t 0.05, b 0')
  assert.equal(readableChange({ property: 'title.stroke', before: json(null), after: json({ color: '#000000', width: 4 }) }).before, 'None')
  assert.equal(readableChange({ property: 'title.shadow', before: 'Absent', after: json({ color: '#000', blur: 8, offset: { x: 0, y: 2 } }) }).after, 'color #000, blur 8, offset (x 0, y 2)')
  assert.equal(readableChange({ property: 'fx', before: json([]), after: json([{ type: 'eq', params: {} }, { type: 'limiter' }]) }).after, 'eq, limiter')
  assert.equal(readableChange({ property: 'Track order', before: json(['V1', 'V2']), after: json(['V2', 'V1']) }).after, 'V2, V1')
  assert.equal(readableChange({ property: 'mute', before: 'false', after: 'true' }).after, 'On')
  assert.equal(readableChange({ property: 'label', before: json('Sample one'), after: json('') }).after, 'Empty')
  assert.equal(readableChange({ property: 'label', before: 'Absent', after: '"A long sample label…' }).after, 'A long sample label…')
  assert.equal(readableChange({ property: 'grade', before: 'Absent', after: '{"lift":[0,0,0],"gam…' }).after, 'Too long to show here')
  assert.deepEqual(readableChange({ property: 'layer', before: 'Absent', after: '{"id":"t1","kind":"title"…' }), { property: 'layer', label: 'Layer', only: 'Added' })
  assert.deepEqual(readableChange({ property: 'composition', before: json({ name: 'Sample' }), after: 'Absent' }).only, 'Removed')
})

test('a whole object that appears or goes is split into one row per property', () => {
  const keys = json({ opacity: [[0, 0], [0.5, 1, 'out']], 'fx.0.params.mix': [[0, 0.2]] })
  assert.deepEqual(splitChanges([{ property: 'anim', before: 'Absent', after: keys }]), [
    { property: 'anim.opacity', before: 'Absent', after: json([[0, 0], [0.5, 1, 'out']]) },
    { property: 'anim["fx.0.params.mix"]', before: 'Absent', after: json([[0, 0.2]]) },
  ])
  assert.deepEqual(splitChanges([{ property: 'grade', before: json({ sat: 1.1 }), after: 'Absent' }]), [{ property: 'grade.sat', before: '1.1', after: 'Absent' }])
  for (const change of [{ property: 'layer', before: 'Absent', after: json({ id: 'x' }) }, { property: 'grade', before: 'Absent', after: '{"lift":[0,…' }, { property: 'crop', before: json({ l: 0 }), after: json({ l: 0.1 }) }]) {
    assert.deepEqual(splitChanges([change]), [change])
  }
  assert.equal(readableChange({ property: 'opacity', before: 'Absent', after: '0.85' }).before, 'Not set')
})

test('the settings line counts tracks and folds a new composition with its own tracks into one item', () => {
  assert.equal(settingsSummary([
    { comp: 'intro', track: null, name: 'Sample intro', status: 'added', changes: [] },
    { comp: 'intro', track: 'V1', name: 'Track V1 · Video 1 · Sample intro', status: 'added', changes: [] },
    { comp: 'intro', track: 'A1', name: 'Track A1 · Audio 1 · Sample intro', status: 'added', changes: [] },
    { comp: null, track: 'V2', name: 'Track V2 · Video 2 · Main timeline', status: 'changed', changes: [] },
  ]), 'New composition Sample intro, 1 track')
  assert.equal(settingsSummary([{ comp: null, track: null, name: 'Timeline length', status: 'changed' }]), 'Timeline length')
  assert.equal(settingsSummary([
    { comp: null, track: null, name: 'Main timeline', status: 'changed' },
    { comp: 'outro', track: null, name: 'Sample outro', status: 'changed' },
    { comp: null, track: null, asset: 'media/a.wav', name: 'Media asset · a', status: 'added' },
  ]), 'Project settings, Sample outro settings, 1 media file')
  assert.equal(settingsSummary([]), '')
})

test('the preview card and receipt details render readable rows, a swatch and keyframe lines', () => {
  const project = { name: 'Sample', width: 1920, height: 1080, fps: 30, assets: {}, comps: { nested: { name: 'Nested sample', fps: 24, tracks: [] } },
    tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 't1', kind: 'title', start: 1, dur: 2, title: { text: 'Sample', color: '#ffffff' } }] }] }
  const proposal = { ops: [
    { op: 'keyframe', id: 't1', prop: 'opacity', at: 1, value: 0 }, { op: 'keyframe', id: 't1', prop: 'opacity', at: 1.5, value: 1, ease: 'out' },
    { op: 'update', id: 't1', set: { start: 1.23456, title: { text: 'Sample', color: '#ff8800' } } },
  ], baseVersion: 2 }
  const card = assistantPanel.PreviewCard({ proposal, project, version: 2 })
  const list = nodes(card).find(node => node.props?.class === 'assistant-preview-list')
  const shown = text(list)
  assert.match(shown, /start1\.00 s · 00:00:01:00→1\.23 s · 00:00:01:07/)
  assert.match(shown, /title\.color#ffffff→#ff8800/)
  assert.match(shown, /anim\.opacity/)
  assert.match(shown, /at 0\.50 s Added 1, out/)
  assert.doesNotMatch(shown, /[{}[\]"]/)
  const swatches = nodes(list).filter(node => node.props?.class === 'change-swatch').map(node => node.props.style.background)
  assert.deepEqual(swatches, ['#ffffff', '#ff8800'])
  // Show all changes names a layer as the timeline does, not by its id.
  const details = nodes(card).find(node => node.props?.class === 'assistant-preview-details')
  assert.deepEqual(nodes(details).filter(node => node.type === 'b').map(text), ['Main timeline', 'Sample'])
  // A committed receipt uses the same rows, at the frame rate of the layer's own composition.
  const before = structuredClone(project); before.comps.nested.tracks = [{ id: 'V1', kind: 'video', clips: [{ id: 'n1', kind: 'title', start: 0, dur: 1, title: { text: 'Inner' } }] }]
  const after = structuredClone(before); after.comps.nested.tracks[0].clips[0].start = 0.5
  const receipt = changeReceipt(before, after, { version: 3, who: 'agent' })
  const fps = assistantPanel.fpsOf(after, receipt.clips[0].comp)
  assert.equal(fps, 24)
  assert.match(text(h(() => assistantPanel.ChangeList({ changes: receipt.clips[0].changes, fps }), null).type()), /start0\.00 s · 00:00:00:00→0\.50 s · 00:00:00:12/)
})
