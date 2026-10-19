import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'

const source = fs.readFileSync(new URL('../web/ui/inspector.js', import.meta.url), 'utf8')
const conformSource = source.match(/\nfunction Conform\(\{ clip, ids, p \}\) \{[\s\S]*?\n\}\n/)[0]
const videoTab = source.match(/\nfunction VideoTab\(\{ clip \}\) \{[\s\S]*?\n\}\n/)[0]

function conform(edits) {
  return new Function('html', 'edit', `${conformSource}\nreturn Conform`)(htm.bind(h), op => edits.push(op))
}
const walk = (node, out = []) => { if (Array.isArray(node)) node.forEach(n => walk(n, out)); else if (node && typeof node === 'object') { out.push(node); walk(node.props?.children, out) } return out }
const buttons = tree => Object.fromEntries(walk(tree).filter(n => n.type === 'button').map(b => [[b.props.children].flat().join(''), b]))

function titleFontControl(clip, edit) {
  const titleSource = source.match(/\nfunction TitleTab\(\{ clip \}\) \{[\s\S]*?\n\}\n/)[0]
  const fontSource = source.match(/^const FONTS = .*$/m)[0]
  const TitleTab = new Function('html', 'useState', 'Section', 'Field', 'TITLE_ANIMS', 'edit', `${fontSource}\n${titleSource}\nreturn TitleTab`)(
    htm.bind(h), initial => [initial, () => {}], () => null, () => null, ['none'], edit)
  return walk(TitleTab({ clip })).find(node => node.type === 'select')
}

test('the title font menu represents existing imported fonts without editing the project', () => {
  for (const font of ['Arial', 'Imported Display Font', 'Avenir Next', undefined]) {
    const clip = { id: 'c1', kind: 'title', title: { text: 'Original text', ...(font === undefined ? {} : { font }) } }
    const before = structuredClone(clip), edits = []
    const control = titleFontControl(clip, op => edits.push(op))
    const options = walk(control).filter(node => node.type === 'option')
    assert.equal(control.props.value, font ?? 'Avenir Next')
    assert.equal(options.filter(option => option.props.value === control.props.value).length, 1)
    assert.deepEqual(clip, before)
    assert.deepEqual(edits, [])
  }
})

test('an explicit font choice changes only the selected title font', async () => {
  const { applyOps, newProject } = await import('../core/project.js')
  const made = applyOps(newProject('Imported font'), [{ op: 'add_title', text: 'Original text', title: { font: 'Arial', size: 96 } }])
  const project = made.project, before = structuredClone(project), id = made.created[0]
  const clip = project.tracks.flatMap(track => track.clips).find(item => item.id === id)
  const edits = [], control = titleFontControl(clip, op => edits.push(op))
  control.props.onChange({ target: { value: 'Georgia' } })
  assert.deepEqual(edits, [{ op: 'update', id, set: { title: { font: 'Georgia' } } }])
  const changed = applyOps(project, edits).project
  const expected = structuredClone(before)
  expected.tracks.flatMap(track => track.clips).find(item => item.id === id).title.font = 'Georgia'
  assert.deepEqual(changed, expected)
  assert.deepEqual(project, before)
  const changedClip = changed.tracks.flatMap(track => track.clips).find(item => item.id === id)
  const selected = titleFontControl(changedClip, () => {})
  assert.equal(selected.props.value, 'Georgia')
  assert.equal(walk(selected).filter(node => node.type === 'option' && node.props.value === 'Georgia').length, 1)
})
// A 1920 x 1080 frame with a 720 x 1280 portrait source, using the inspector's existing Fill formula.
const project = { width: 1920, height: 1080, assets: { 'portrait.mp4': { width: 720, height: 1280 } } }
const fill = (() => { const sw = 1920 / 720, sh = 1080 / 1280; return Math.max(sw / Math.min(sw, sh), sh / Math.min(sw, sh)) })()

test('Conform offers Fit and Fill as one labeled group with the current choice pressed', () => {
  const edits = [], Conform = conform(edits)
  const clip = { id: 'c1', src: 'portrait.mp4' }
  const tree = Conform({ clip, ids: ['c1'], p: project })
  const group = walk(tree).find(n => n.props?.role === 'group')
  assert.equal(group.props['aria-labelledby'], 'conform-c1')
  assert.equal(walk(tree).find(n => n.type === 'label').props.children, 'Conform')
  const { Fit, Fill } = buttons(tree)
  assert.equal(Fit.props['aria-pressed'], true)
  assert.equal(Fill.props['aria-pressed'], false)
  Fit.props.onClick(); Fill.props.onClick()
  assert.deepEqual(edits, [{ op: 'update', ids: ['c1'], set: { scale: 1, x: null, y: null } }, { op: 'update', ids: ['c1'], set: { scale: fill } }])
})

test('Conform shows Fill pressed after filling, and neither when the scale is animated or custom', () => {
  const Conform = conform([])
  const pressed = clip => Object.fromEntries(Object.entries(buttons(Conform({ clip, ids: [clip.id], p: project }))).map(([name, b]) => [name, b.props['aria-pressed']]))
  assert.deepEqual(pressed({ id: 'c1', src: 'portrait.mp4', scale: fill }), { Fit: false, Fill: true })
  assert.deepEqual(pressed({ id: 'c1', src: 'portrait.mp4', scale: 1.4 }), { Fit: false, Fill: false })
  assert.deepEqual(pressed({ id: 'c1', src: 'portrait.mp4', anim: { scale: [[0, 1], [2, 1.15]] } }), { Fit: false, Fill: false })
  assert.deepEqual(pressed({ id: 'c1', src: 'portrait.mp4', x: 300 }), { Fit: false, Fill: false })
})

test('the keyframe button names its action and shows a hollow or filled diamond', async () => {
  const core = await import('../core/project.js')
  const keyButton = source.match(/\nfunction KeyButton\(\{ clip, prop, label \}\) \{[\s\S]*?\n\}\n/)[0]
  const edits = []
  const KeyButton = new Function('html', 'useTime', 'sortedKeys', 'clipEnd', 'viewProject', 'player', 'edit', 'valueAt', `${keyButton}\nreturn KeyButton`)(
    htm.bind(h), () => 1, core.sortedKeys, core.clipEnd, () => ({ width: 640, height: 360, fps: 30 }), { seek() {} }, op => edits.push(op), () => 0.5)
  const dot = tree => walk(tree).find(n => n.type === 'button' && String(n.props.class).includes('kf-dot'))
  const empty = dot(KeyButton({ clip: { id: 'c1', start: 0, dur: 4 }, prop: 'opacity' }))
  assert.equal(empty.props['aria-label'], 'Add opacity keyframe at playhead')
  assert.deepEqual([empty.props.children].flat(), ['◇'])
  const keyed = dot(KeyButton({ clip: { id: 'c1', start: 0, dur: 4, anim: { opacity: [[1, 0.5]] } }, prop: 'opacity' }))
  assert.equal(keyed.props['aria-label'], 'Remove opacity keyframe at playhead')
  assert.deepEqual([keyed.props.children].flat(), ['◆'])
  assert.match(keyed.props.class, /\bon\b/)
  keyed.props.onClick()
  assert.equal(edits[0].remove, true)
  // Rows pass their visible label, so a Stretch X row never announces the stored key "scaleX".
  const stretch = walk(KeyButton({ clip: { id: 'c1', start: 0, dur: 4, anim: { scaleX: [[0, 1], [1, 1.2], [3, 1]] } }, prop: 'scaleX', label: 'Stretch X' })).filter(n => n.type === 'button').map(b => b.props['aria-label'])
  assert.deepEqual(stretch, ['Previous Stretch X keyframe', 'Remove Stretch X keyframe at playhead', 'Next Stretch X keyframe'])
  assert.match(source, /keyframe=\$\{html`<\$\{KeyButton\} clip=\$\{clip\} prop=\$\{prop\} label=\$\{label\} \/>`\}/)
})

test('inspector section titles are buttons that report and toggle their state', () => {
  const sectionSource = source.match(/\nfunction Section\(\{ title, children, open = true, extra \}\) \{[\s\S]*?\n\}\n/)[0]
  let state, stopped = 0
  const useState = initial => [state ??= initial, value => { state = value }]
  const Section = new Function('html', 'useState', `${sectionSource}\nreturn Section`)(htm.bind(h), useState)
  const toggle = () => walk(Section({ title: 'Crop', open: false, children: 'body' })).find(n => n.type === 'button' && n.props.class === 'section-toggle')
  assert.equal(toggle().props['aria-expanded'], false)
  toggle().props.onClick({ stopPropagation: () => stopped++ })
  assert.equal(state, true)
  assert.equal(stopped, 1, 'the head does not toggle a second time')
  assert.equal(toggle().props['aria-expanded'], true)
})

test('Transform holds properties and Conform; keyframe presets sit in their own collapsed section', () => {
  const transform = videoTab.slice(videoTab.indexOf('title="Transform"'), videoTab.indexOf('title="Animation presets"'))
  assert.match(transform, /<\$\{Conform\} clip=\$\{clip\} ids=\$\{ids\} p=\$\{p\} \/>/)
  for (const name of ['Ken Burns', 'Slide in', 'Shake', 'Fill frame']) assert.ok(!transform.includes(`>${name}</button>`), `${name} is not in Transform`)
  const presets = videoTab.slice(videoTab.indexOf('title="Animation presets"'), videoTab.indexOf('title="Crop"'))
  assert.match(presets, /title="Animation presets" open=\$\{false\}/)
  for (const name of ['Ken Burns', 'Slide in', 'Shake']) assert.ok(presets.includes(`>${name}</button>`), `${name} is a preset`)
  assert.match(presets, /writes keyframes across this clip/)
})
