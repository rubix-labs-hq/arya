import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'
import { Icon, hasIcon } from '../web/ui/icons.js'

const read = file => fs.readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8')
const css = read('styles.css')
const html = htm.bind(h)
const walk = (node, out = []) => { if (Array.isArray(node)) node.forEach(n => walk(n, out)); else if (node && typeof node === 'object') { if (typeof node.type === 'function') return walk(node.type(node.props), out); out.push(node); walk(node.props?.children, out) } return out }
const text = node => walk([node]).flatMap(n => [n.props?.children].flat()).filter(c => typeof c === 'string' || typeof c === 'number').join('')

test('Motion tools render named icon buttons whose pressed state follows the tool', () => {
  const page = read('ui/motion/page.js')
  const body = page.slice(page.indexOf('const SHAPES ='), page.indexOf('function LeftPanel()'))
  assert.doesNotMatch(body, /[↖▭◯⬡☆✎⊕]/u, 'no text glyphs stand in for tool icons')
  const calls = []
  const state = { tool: 'm-shape' }, motion = { shapeKind: 'star', maskKind: 'rect', fillOn: true, fill: '#ffffff', stroke: '#000000', strokeWidth: 0, sides: 6, points: 5 }
  const ToolBar = new Function('html', 'useStore', 'ms', 'mset', 'set', 'Icon', `${body}\nreturn ToolBar`)(html, () => state, () => motion, patch => calls.push(['mset', patch]), patch => calls.push(['set', patch]), Icon)
  const buttons = walk(ToolBar()).filter(n => n.type === 'button')
  const named = Object.fromEntries(buttons.map(b => [b.props['aria-label'], b]))
  assert.deepEqual(Object.keys(named), ['Selection', 'Rectangle', 'Ellipse', 'Polygon', 'Star', 'Pen', 'Rectangle mask', 'Ellipse mask', 'Pen mask', 'Anchor point'])
  for (const button of buttons) assert.equal(walk([button]).filter(n => n.type === 'svg').length, 1, `${button.props['aria-label']} draws one icon`)
  assert.deepEqual(buttons.filter(b => b.props['aria-pressed']).map(b => b.props['aria-label']), ['Star'])
  named.Ellipse.props.onClick()
  assert.deepEqual(calls, [['mset', { shapeKind: 'ellipse' }], ['set', { tool: 'm-shape' }]])
  for (const name of ['select', 'shape', 'ellipse', 'polygon', 'star', 'pen', 'anchor']) assert.ok(hasIcon(name), name)
  const groups = walk(ToolBar()).filter(n => n.props?.role === 'group').map(n => n.props['aria-label'])
  assert.deepEqual(groups, ['Shape tools', 'Mask tools'])
})

test('the Motion layer table marks visibility and lock with drawn glyphs and reports state', () => {
  const layers = read('ui/motion/layers.js')
  assert.doesNotMatch(layers, /🔒/u)
  assert.match(layers, /aria-label="Visible" aria-pressed=\$\{visible\}/)
  assert.match(layers, /aria-label="Lock track" aria-pressed=\$\{Boolean\(track\.locked\)\}/)
  assert.match(css, /\.glyph-lock \{ --glyph: url\("data:image\/svg\+xml,/)
})

test('mixer strips count clips in words and the master names its limiter', () => {
  const mixer = read('ui/mixer.js')
  const strip = mixer.slice(mixer.indexOf('function Strip('), mixer.indexOf('\n}\n', mixer.indexOf('function Strip(')) + 3)
  const master = mixer.slice(mixer.indexOf('function MasterStrip('), mixer.indexOf('\n}\n', mixer.indexOf('function MasterStrip(')) + 3)
  const stub = () => null
  const deps = { html, set() {}, applyOps: () => ({}), store: {}, trackOp: () => ({}), edit() {}, AudioEngine: { level: () => 0 }, audio: { meters: new Map() }, FxSlots: stub, Meter: stub, TruePeakReadout: stub, LoudnessMini: stub }
  const make = (code, name) => new Function(...Object.keys(deps), `${code}\nreturn ${name}`)(...Object.values(deps))
  const Strip = make(strip, 'Strip'), MasterStrip = make(master, 'MasterStrip')
  const count = clips => walk(Strip({ track: { id: 'A1', name: 'Audio 1', clips }, p: {}, editing: false, onEdit() {} })).filter(n => n.props?.class === 'muted small').map(text)
  assert.deepEqual(count([{}]), ['1 clip'])
  assert.deepEqual(count([{}, {}]), ['2 clips'])
  assert.deepEqual(count([]), ['0 clips'])
  const limiter = on => walk(MasterStrip({ p: { master: on ? { limiter: { enabled: true, ceiling: -1 } } : {} }, editing: false, onEdit() {} })).find(n => n.type === 'button' && n.props['aria-label'] === 'Master limiter')
  assert.equal(text(limiter(false)), 'Limiter')
  assert.equal(limiter(false).props['aria-pressed'], false)
  assert.equal(limiter(true).props['aria-pressed'], true)
  assert.match(css, /\.mixer input\[type=range\] \{ accent-color: var\(--sage\); \}/)
})

test('tool panel actions read as buttons, and Deliver presets take one line each', () => {
  assert.match(css, /:is\(\.audio-tools, \.deliver-settings, \.deliver-queue, \.grade-actions, \.analyze-list, \.mo-left\) button\.ghost \{ border-color: var\(--line-2\); \}/)
  assert.match(css, /\.deliver-preset > \.muted \{ flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/)
  const deliver = read('ui/deliver.js')
  assert.match(deliver, /title=\$\{`\$\{pr\.name\}: \$\{detail\}`\}/)
  assert.match(deliver, /Nothing rendered yet\. Choose a preset, then press Render\./)
})

test('narrow inspectors keep numeric fields and keyframe buttons on one line', () => {
  const block = css.slice(css.lastIndexOf('@container (max-width: 260px) {'))
  assert.match(block, /\.field\.num \{ flex-wrap: nowrap; gap: 4px; \}/)
  assert.match(block, /\.field\.num \.kf \{ margin-left: auto; \}/)
  assert.ok(css.lastIndexOf('@container (max-width: 260px) {') > css.indexOf('.field .kf { margin-left: 0; }'), 'the one-line rule follows the older wrapping rule')
})

test('audio clip keyframe buttons are named after their row', async () => {
  const core = await import('../core/project.js')
  const fx = read('ui/plugins/audio-fx.js')
  const body = fx.slice(fx.indexOf('function KeyedNum('), fx.indexOf('\n}\n', fx.indexOf('function KeyedNum(')) + 3)
  const edits = []
  const Num = props => props.keyframe
  const KeyedNum = new Function('html', 'useTime', 'store', 'sortedKeys', 'valueAt', 'clipEnd', 'edit', 'Num', `${body}\nreturn KeyedNum`)(html, () => 1, { project: {} }, core.sortedKeys, () => -3, core.clipEnd, op => edits.push(op), Num)
  const dot = clip => walk(KeyedNum({ common: { label: 'Volume' }, value: 0, clip, prop: 'volume', onCommit() {} })).find(n => n.type === 'button')
  const empty = dot({ id: 'a1', start: 0, dur: 4 })
  assert.equal(empty.props['aria-label'], 'Add Volume keyframe at playhead')
  assert.equal(text(empty), '◇')
  const keyed = dot({ id: 'a1', start: 0, dur: 4, anim: { volume: [[1, -3]] } })
  assert.equal(keyed.props['aria-label'], 'Remove Volume keyframe at playhead')
  assert.equal(text(keyed), '◆')
  keyed.props.onClick()
  assert.equal(edits[0].remove, true)
})

test('Motion property rows name their stopwatch and keyframe buttons and draw the stopwatch', () => {
  const layers = read('ui/motion/layers.js')
  assert.doesNotMatch(layers, /⏱/u)
  assert.match(layers, /aria-label=\$\{`Animate \$\{r\.label\}`\} aria-pressed=\$\{keys\.length > 0\}/)
  assert.match(layers, /aria-label=\$\{`Previous \$\{r\.label\} keyframe`\}/)
  assert.match(layers, /aria-label=\$\{here \? `Remove \$\{r\.label\} keyframe at playhead` : `Add \$\{r\.label\} keyframe at playhead`\}/)
  assert.match(layers, /aria-label=\$\{`Next \$\{r\.label\} keyframe`\}/)
  assert.match(css, /\.glyph-stopwatch \{ --glyph: url\("data:image\/svg\+xml,/)
})
