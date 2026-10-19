import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'
import { pathToFileURL } from 'node:url'

const editorURL = process.env.ARYA_TITLE_PRESET_EDITOR ? pathToFileURL(process.env.ARYA_TITLE_PRESET_EDITOR + '/') : new URL('../', import.meta.url)
const { applyOps, baseValue, compView, newProject, snapToFrame } = await import(new URL('core/project.js', editorURL))

const browser = fs.readFileSync(new URL('web/ui/browser.js', editorURL), 'utf8')
const timeline = fs.readFileSync(new URL('web/ui/timeline.js', editorURL), 'utf8')
const storeSource = fs.readFileSync(new URL('web/ui/store.js', editorURL), 'utf8')
const helperURL = new URL('web/ui/title-presets.js', editorURL)
const helper = fs.existsSync(helperURL) ? await import(helperURL) : {}
const declaration = browser.slice(browser.indexOf('export const TITLE_PRESETS ='), browser.indexOf('const MEDIA_ICON =')).replace('export const', 'const')
const titleBody = browser.slice(browser.indexOf('async function addTitlePreset('), browser.indexOf('function TransitionsTab('))
const titleFactory = new Function('deps', `const { html, edit, time, viewProject, BrowserSections, titlePresetOp, store, set, subscribe, toast } = deps; ${declaration}; ${titleBody}; return { TITLE_PRESETS, TitlesTab }`)
const dropBody = timeline.slice(timeline.indexOf('  const onDrop = e => {'), timeline.indexOf('\n\n  return html`', timeline.indexOf('  const onDrop = e => {')))
assert(dropBody.includes("item.type === 'title'"), 'Load the actual timeline drop handler')
const dropFactory = new Function('deps', `const { local, hitAt, p, state, snap, xt, edit, titlePresetOp } = deps; ${dropBody}; return onDrop`)
const scopedBody = storeSource.match(/^function scoped\(ops\) \{[\s\S]*?^\}/m)?.[0]
assert(scopedBody, 'Load the actual store composition scope function')
const scopedFactory = new Function('store', scopedBody + '\nreturn scoped')
const stateBodies = ['set', 'subscribe'].map(name => storeSource.match(new RegExp(`^export function ${name}\\([^]*?^}`, 'm'))?.[0]).join('\n')
assert(stateBodies.includes('export function set(') && stateBodies.includes('export function subscribe('), 'Load the actual store publication and subscriber functions')
const stateFactory = new Function('store', `const listeners = new Set(); ${stateBodies.replaceAll('export function', 'function')}; return { set, subscribe }`)

const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} should equal ${expected}`)

function nodes(node, out = []) {
  if (Array.isArray(node)) node.forEach(value => nodes(value, out))
  else if (node && typeof node === 'object') { out.push(node); nodes(node.props?.children, out) }
  return out
}

function editor(width, height, { nested = false } = {}) {
  let project = newProject('Synthetic title presets')
  if (nested) project.comps = { k1: { id: 'k1', name: 'Small composition', width, height, fps: 30, tracks: [{ id: 'V1', kind: 'video', clips: [] }] } }
  else { project.width = width; project.height = height }
  const store = { project, openComp: nested ? 'k1' : null, version: 0, selection: [] }, calls = [], time = { t: 1 }
  const { set, subscribe } = stateFactory(store)
  const scoped = scopedFactory(store)
  const viewProject = () => compView(store.project, store.openComp)
  const edit = ops => {
    if (!Array.isArray(ops)) ops = [ops]
    calls.push(structuredClone(ops))
    const result = applyOps(store.project, scoped(ops))
    set({ project: result.project, version: store.version + 1 })
    return { ...result, version: store.version }
  }
  const titles = titleFactory({ html: htm.bind(h), edit, time, viewProject, BrowserSections: () => null, titlePresetOp: helper.titlePresetOp, store, set, subscribe, toast: message => { throw Error(message) } })
  const presets = nodes(titles.TitlesTab()).filter(node => node.props?.class === 'preset title-preset')
  const find = name => presets[titles.TITLE_PRESETS.findIndex(preset => preset.name === name)]
  const last = () => viewProject().tracks.flatMap(track => track.clips).at(-1)
  const click = name => { find(name).props.onClick(); return last() }
  const payload = name => {
    let value
    find(name).props.onDragStart({ dataTransfer: { setData(type, data) { assert.equal(type, 'application/x-reel'); value = JSON.parse(data) } } })
    return value
  }
  const drop = item => {
    const p = viewProject(), track = p.tracks.find(track => track.kind === 'video')
    const onDrop = dropFactory({ local: () => ({ x: 1, y: 1 }), hitAt: () => ({ row: { track } }), p, state: {}, snap: (_p, value) => ({ t: snapToFrame(value, p.fps) }), xt: value => value, edit, titlePresetOp: helper.titlePresetOp })
    onDrop({ preventDefault() {}, dataTransfer: { getData: () => JSON.stringify(item) } })
    return last()
  }
  return { titles, click, drop, payload, calls, store, viewProject }
}

for (const [width, height, expectedX, expectedY, expectedSize] of [
  [640, 360, 520 / 3, 300, 18],
  [1920, 1080, 520, 900, 54],
  [1080, 1920, 292.5, 1600, 30.375],
  [1024, 1024, 520 * 1024 / 1920, 900 * 1024 / 1080, 54 * 1024 / 1920],
]) {
  test(`Lower Third click fits the authored layout to ${width} by ${height}`, () => {
    const c = editor(width, height), clip = c.click('Lower Third')
    close(clip.x, expectedX)
    close(clip.y, expectedY)
    close(clip.title.size, expectedSize)
    assert(clip.x >= 0 && clip.x < width && clip.y >= 0 && clip.y < height)
    assert.equal(clip.title.align, 'left')
    assert.equal(clip.title.lineHeight, 1.25)
    assert.equal(clip.title.weight, 700)
  })

  test(`Subtitle click places the title near the bottom of ${width} by ${height}`, () => {
    const c = editor(width, height), clip = c.click('Subtitle')
    close(baseValue(c.viewProject(), clip, 'x'), width / 2)
    close(clip.y, 960 * height / 1080)
    assert(clip.y > height * 0.8 && clip.y < height)
    close(clip.title.size, 52 * Math.min(width / 1920, height / 1080))
  })

  test(`Every preset click and drop uses the same editable layout at ${width} by ${height}`, () => {
    const sample = editor(width, height)
    for (const preset of sample.titles.TITLE_PRESETS) {
      const clicked = editor(width, height), dragged = editor(width, height)
      assert.deepEqual(dragged.drop(dragged.payload(preset.name)), clicked.click(preset.name), preset.name)
      assert.equal(clicked.calls.length, 1)
      assert.equal(dragged.calls.length, 1)
    }
  })
}

test('Preset dragging retains raw authored placement until the destination canvas is known', () => {
  const c = editor(640, 360), data = c.payload('Lower Third')
  assert.equal(data.preset, true)
  assert.deepEqual(data.set, { x: 520, y: 900 })
  assert.equal(data.title.size, 54)
  const target = editor(1080, 1920), clip = target.drop(data)
  assert.equal(clip.x, 292.5)
  assert.equal(clip.y, 1600)
  assert.equal(clip.title.size, 30.375)
})

for (const mode of ['click', 'drop']) test(`Preset ${mode} uses nested dimensions and leaves the root timeline untouched`, () => {
  const c = editor(640, 360, { nested: true }), root = structuredClone(c.store.project.tracks)
  const clip = mode === 'click' ? c.click('Lower Third') : c.drop(c.payload('Lower Third'))
  close(clip.x, 520 / 3)
  assert.equal(clip.y, 300)
  assert.equal(clip.title.size, 18)
  assert.deepEqual(c.store.project.tracks, root)
  assert.equal(c.store.project.comps.k1.tracks[0].clips.length, 1)
})

test('Generic title drop retains its original unscaled core behavior', () => {
  const c = editor(640, 360), clip = c.drop({ type: 'title', text: 'Custom layer', title: { size: 88, color: '#ff0000' } })
  close(baseValue(c.viewProject(), clip, 'x'), 320)
  close(baseValue(c.viewProject(), clip, 'y'), 180)
  assert.equal(clip.title.size, 88)
  assert.equal(clip.title.text, 'Custom layer')
})

test('Reference-size preset clicks retain the existing authored clip fields', () => {
  const c = editor(1920, 1080)
  for (const preset of c.titles.TITLE_PRESETS) {
    const original = applyOps(newProject('Reference'), [{ op: 'add_title', start: 1, dur: 4, text: preset.text, title: preset.title, set: preset.set }]).project.tracks.flatMap(track => track.clips)[0]
    const clicked = editor(1920, 1080).click(preset.name)
    assert.deepEqual(clicked, original, preset.name)
  }
})

test('Preset helper scales pixel styling and preserves authored source objects', () => {
  assert.equal(typeof helper.titlePresetOp, 'function')
  const c = editor(640, 360), before = structuredClone(c.titles.TITLE_PRESETS)
  const lower = c.click('Lower Third'), bold = editor(640, 360).click('Big Bold'), cinematic = editor(640, 360).click('Cinematic'), gradient = editor(640, 360).click('Gradient')
  close(lower.title.padding, 26 / 3)
  close(lower.title.radius, 8 / 3)
  assert.equal(lower.title.shadow.blur, 6)
  assert.equal(lower.title.shadow.y, 2)
  close(bold.title.stroke.width, 4 / 3)
  close(cinematic.title.tracking, 8 / 3)
  close(gradient.title.shadow.blur, 40 / 3)
  assert.deepEqual(c.titles.TITLE_PRESETS, before)
})
