import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'

const source = fs.readFileSync(new URL('../web/ui/color.js', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../web/ui/color/workspace.css', import.meta.url), 'utf8')
const walk = (node, out = []) => { if (Array.isArray(node)) node.forEach(n => walk(n, out)); else if (node && typeof node === 'object') { out.push(node); walk(node.props?.children, out) } return out }

test('the Color page renders the clip strip under the viewer, beside nodes and scopes', () => {
  const body = source.slice(source.indexOf('export function ColorPage()')).replace('export ', '')
  const parts = Object.fromEntries(['Viewer', 'ClipStrip', 'NodeEditor', 'Scopes', 'Divider', 'Palettes'].map(name => [name, Object.defineProperty(function () {}, 'name', { value: name })]))
  const clip = { id: 'c1', kind: 'video' }
  const ColorPage = new Function('html', 'useStore', 'useTime', 'gradedClip', ...Object.keys(parts), `${body}\nreturn ColorPage`)(htm.bind(h), () => ({}), () => 0, () => clip, ...Object.values(parts))
  const tree = ColorPage(), nodes = walk(tree)
  const byClass = name => nodes.find(n => String(n.props?.class ?? '').split(' ').includes(name))
  const children = node => walk(node.props.children).filter(n => typeof n.type === 'function').map(n => n.type.name)
  assert.deepEqual(children(byClass('color-monitor')), ['Viewer', 'ClipStrip'])
  assert.deepEqual(children(byClass('color-side')), ['NodeEditor', 'Scopes'])
  assert.equal(walk(byClass('color-monitor')).find(n => n.type === parts.Viewer).props.compact, true)
  assert.ok(nodes.indexOf(byClass('color-top')) < nodes.indexOf(byClass('color-bottom')), 'correction tools sit below the viewer row')
  assert.equal(walk(byClass('color-bottom')).find(n => n.type === parts.Palettes).props.clip, clip)
})

// CSS grid flexible-track sizing for `minmax(min, Nfr)` columns, enough to check where the wheels land.
function columnWidths(template, width, gap) {
  const tracks = [...template.matchAll(/minmax\((\d+)px, ([\d.]+)fr\)/g)].map(m => ({ min: Number(m[1]), fr: Number(m[2]) }))
  let flexible = tracks.slice(), free = width - gap * (tracks.length - 1)
  for (;;) {
    const unit = (free - tracks.filter(t => !flexible.includes(t)).reduce((sum, t) => sum + t.min, 0)) / flexible.reduce((sum, t) => sum + t.fr, 0)
    const fixed = flexible.filter(t => t.min > t.fr * unit)
    if (!fixed.length) return tracks.map(t => flexible.includes(t) ? t.fr * unit : t.min)
    flexible = flexible.filter(t => !fixed.includes(t))
  }
}

test('six wheels fit one row at 1329 and 1440 without the Assistant and at 1920 with it', () => {
  const template = css.match(/\.page\.color \.grade-controls \{\n  display: grid;\n  grid-template-columns: ([^;]+);/)[1]
  const threshold = Number(css.match(/@container color-wheels \(min-width: (\d+)px\) \{\n  \.page\.color \.wheels \{ grid-template-columns: repeat\(6, minmax\(128px, 1fr\)\); gap: (\d+)px; \}/)[1])
  const gap = Number(css.match(/@container color-wheels \(min-width: \d+px\) \{\n  \.page\.color \.wheels \{ grid-template-columns: repeat\(6, minmax\(128px, 1fr\)\); gap: (\d+)px; \}/)[1])
  assert.ok(6 * 128 + 5 * gap <= threshold, 'six 128 pixel wheels fit the one-row threshold')
  // Palette inner widths measured in Chromium (the three groups and their gaps).
  for (const [label, inner] of [['1329 x 988 without the Assistant', 1291], ['1440 x 900 without the Assistant', 1402], ['1920 x 1080 with the Assistant', 1471]]) {
    const [wheels, balance, curves] = columnWidths(template, inner, 16)
    assert.ok(wheels >= threshold, `${label}: wheel group ${Math.round(wheels)} pixels`)
    assert.ok(balance >= 220 && curves >= 230, `${label}: balance and curves keep their minimum widths`)
  }
  assert.match(css, /\.main \.page\.color \.color-top \{\n  flex: 0 0 var\(--upper-height, 52%\);/)
})

test('clip strip cards are named buttons that show the clip name', () => {
  const body = source.slice(source.indexOf('function ClipStrip()'), source.indexOf('function StripThumb('))
  const clips = [{ id: 'c1', kind: 'video', src: 'media/interview.mp4', start: 0, dur: 4, grade: { exposure: 0.2 } }, { id: 'c2', kind: 'adjustment', start: 4, dur: 2, nodes: { list: [{}, {}, {}, {}] } }]
  const project = { tracks: [{ kind: 'video', clips }] }
  const seeks = [], patches = []
  const ClipStrip = new Function('html', 'useStore', 'useTime', 'viewProject', 'gradedClip', 'set', 'player', 'StripThumb', `${body}\nreturn ClipStrip`)(
    htm.bind(h), () => ({}), () => 0, () => project, () => clips[0], patch => patches.push(patch), { seek: t => seeks.push(t) }, () => null)
  const tree = ClipStrip()
  assert.equal(tree.props.role, 'group')
  const cards = walk(tree).filter(n => n.type === 'button')
  assert.deepEqual(cards.map(c => c.props['aria-label']), ['Clip 1, interview.mp4, graded', 'Clip 2, Adjustment, 2 corrector nodes'])
  assert.deepEqual(cards.map(c => c.props['aria-pressed']), [true, false])
  assert.deepEqual(cards.map(c => c.props.class), ['strip-clip on', 'strip-clip '])
  cards[1].props.onClick()
  assert.deepEqual(patches, [{ selection: ['c2'] }])
  assert.deepEqual(seeks, [5])
})
