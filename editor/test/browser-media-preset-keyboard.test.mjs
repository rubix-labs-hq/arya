import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const editor = process.env.ARYA_TEST_EDITOR_ROOT ? pathToFileURL(process.env.ARYA_TEST_EDITOR_ROOT + '/') : new URL('../', import.meta.url)
const browserRoot = process.env.ARYA_TEST_BROWSER_ROOT ? pathToFileURL(process.env.ARYA_TEST_BROWSER_ROOT + '/') : editor
const core = await import(new URL('core/project.js', editor))
const { uploadMediaFiles } = await import(new URL('web/ui/media-import.js', editor))
const htm = createRequire(new URL('package.json', editor))('htm')
const source = fs.readFileSync(new URL('web/ui/browser.js', browserRoot), 'utf8')
const storeSource = fs.readFileSync(new URL('web/ui/store.js', editor), 'utf8')
const keysSource = fs.readFileSync(new URL('web/ui/keys.js', editor), 'utf8')
const viewerSource = fs.readFileSync(new URL('web/ui/viewer.js', editor), 'utf8')
function between(text, start, end) {
  assert.equal(text.split(start).length, 2, `Unique owning source: ${start}`)
  const at = text.indexOf(start), until = text.indexOf(end, at + start.length)
  assert.ok(until > at, `Owning boundary: ${end}`)
  return text.slice(at, until)
}
const browserBody = [
  between(source, 'function uploadFiles(', 'function importFolder('),
  between(source, 'function MediaTab(', 'async function addTitlePreset('),
  between(source, 'function TransitionsTab(', 'export function Browser('),
].join('\n')
const uiFactory = new Function('deps', `const { html, useState, useRef, store, time, edit, toast, host, api, uploadMediaFiles, EFFECTS, TRANSITIONS, BrowserSections, MediaCard, FolderPicker, mediaMatchesQuery, showMusicDetails } = deps; ${browserBody}\nreturn { MediaTab, TransitionsTab, EffectsTab }`)
const scopedBody = storeSource.match(/function scoped\(ops\) \{[\s\S]*?\n\}/)?.[0]
assert.ok(scopedBody)
const editBody = between(storeSource, 'export async function edit(', 'export function connect(').replace('export ', '')
const editFactory = new Function('store', 'applyOps', 'set', 'api', 'toast', `let pending = 0; ${scopedBody}\n${editBody}\nreturn edit`)
const keysBody = keysSource.replace(/^import .*\n/gm, '').replace(/^export const /gm, 'const ').replace(/^export function /gm, 'function ').replace(/^export \{.*\}\s*$/gm, '')
const keysFactory = new Function('deps', `const { clipEnd, compView, duration, snapToFrame, sourceTime, player, api, edit, set, store, time, toast, viewProject, copySelection, sourcePlacementPlan, window, Element, getComputedStyle, document } = deps; ${keysBody}\nreturn installKeys`)
const sourceKey = viewerSource.match(/const onKey = e => \{([\s\S]*?)\n    \}\n    window.addEventListener\('keydown', onKey, true\)/)
assert.ok(sourceKey, 'Extract the actual source-viewer capture listener')
const sourceKeysFactory = new Function('store', 'video', 'offset', 'dur', 'setSrc', 'toggle', 'place', `return e => {${sourceKey[1]}\n}`)
const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
const nodes = value => value && typeof value === 'object' ? [value, ...(value.children ?? []).flatMap(nodes)] : []
const text = value => value && typeof value === 'object' ? (value.children ?? []).map(text).join('') : String(value ?? '')

function fixture({ locked = false, selected = true, uploadError = false } = {}) {
  let backend = core.applyOps(core.newProject('Keyboard media and presets'), [
    { op: 'add_color', track: 'V1', start: 0, dur: 4, color: '#000000' },
    { op: 'add_color', track: 'V1', start: 4, dur: 4, color: '#ffffff' },
  ]).project
  const ids = backend.tracks.find(track => track.id === 'V1').clips.map(clip => clip.id)
  if (locked) for (const track of backend.tracks) track.locked = true
  const before = structuredClone(backend), calls = [], notices = [], uploads = [], imports = [], playback = []
  const store = { project: backend, version: 7, root: '/owned-keyboard-fixture', openComp: null, selection: selected ? [ids[1], 'tr:ignored'] : [], connected: true, settingsOpen: false, viewerMode: 'source' }
  const time = { t: 9 }, set = patch => Object.assign(store, patch), toast = (message, kind) => notices.push({ message, kind })
  const api = async (route, body) => {
    if (route === '/api/import') { imports.push(body); return { assets: Object.fromEntries(body.paths.map(path => [path, { hasAudio: true }])) } }
    assert.equal(route, '/api/ops'); calls.push(body)
    const result = core.applyOps(backend, body.ops); backend = result.project
    return { ...result, version: store.version + 1 }
  }
  const edit = editFactory(store, core.applyOps, set, api, toast)
  const ui = uiFactory({ html: htm.bind(h), useState: value => [value, () => {}], useRef: value => ({ current: value }), store, time, edit, toast, api, uploadMediaFiles,
    host: { upload: async file => { uploads.push(file); if (uploadError) throw Error('Owned upload failed'); return { path: `media/${file.name}` } } },
    EFFECTS: core.EFFECTS, TRANSITIONS: core.TRANSITIONS, BrowserSections() {}, MediaCard() {}, FolderPicker() {}, mediaMatchesQuery: () => true, showMusicDetails() { assert.fail('Unrelated music action') } })
  const tree = [...nodes(ui.MediaTab({ p: store.project })), ...nodes(ui.TransitionsTab()), ...nodes(ui.EffectsTab())]
  const find = label => { const node = tree.find(node => node.props['aria-label'] === label || text(node) === label); assert.ok(node, label); return node }
  const controls = { import: find('Import…'), transition: find('Cross Dissolve'), effect: find('Glow'), adjustment: find('Adjustment layer'), color: find('Solid #000000') }
  const input = tree.find(node => node.type === 'input' && node.props.type === 'file')
  let pickerClicks = 0
  if (input.props.ref) input.props.ref.current = { click() { pickerClicks++ } }
  const handlers = []
  const install = keysFactory({ ...core, player: { toggle: () => playback.push('timeline') }, api, edit, set, store, time, toast, viewProject: () => store.project, copySelection() {}, sourcePlacementPlan() { assert.fail('Unrelated source placement') }, window: { addEventListener: (name, fn) => { assert.equal(name, 'keydown'); handlers.push(fn) } }, Element: class {}, getComputedStyle: () => ({}), document: {} })
  install(); assert.equal(handlers.length, 1)
  const capture = sourceKeysFactory(store, { current: { currentTime: 1 } }, 0, 8, () => assert.fail('Unrelated source mark'), () => playback.push('source'), () => assert.fail('Unrelated source placement'))
  return { store, before, calls, notices, uploads, imports, playback, controls, input, ids, pickerClicks: () => pickerClicks, capture, bubble: handlers[0] }
}

function elementFor(node, descendant = false) {
  const button = { tagName: node.type.toUpperCase(), closest(selector) { return selector.split(',').some(part => part.trim() === 'button') && this.tagName === 'BUTTON' ? this : null } }
  return descendant ? { tagName: 'SPAN', closest: selector => button.closest(selector), parentElement: button } : button
}

for (const kind of ['import', 'transition', 'effect', 'adjustment', 'color']) {
  test(`${kind} native button leaves Enter and Space defaults intact through both actual editor listeners`, () => {
    const f = fixture(), node = f.controls[kind]
    assert.equal(node.type, 'button'); assert.equal(node.props.type, 'button')
    assert.equal(node.props['aria-label'], { import: 'Import media files', transition: 'Apply Cross Dissolve transition to selected clips', effect: 'Apply Glow effect to selected clips', adjustment: 'Add adjustment layer at the playhead', color: 'Add solid #000000 at the playhead' }[kind]); assert.notEqual(node.props.disabled, true)
    assert.equal(node.props.onKeyDown, undefined, 'Use native activation without a second key handler')
    for (const key of ['Enter', ' ']) for (const descendant of [false, true]) {
      const e = { key, target: elementFor(node, descendant), metaKey: false, ctrlKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopImmediatePropagation() { this.stopped = true } }
      f.capture(e); f.bubble(e)
      assert.equal(e.defaultPrevented, false); assert.equal(e.stopped, undefined)
    }
    assert.deepEqual(f.playback, []); assert.deepEqual(f.calls, []); assert.equal(f.pickerClicks(), 0)
  })
}

test('Import click from a nested target opens its own chooser once without uploading', () => {
  const f = fixture()
  assert.ok(f.input.props.ref); assert.equal(f.input.props.hidden, true); assert.equal(f.input.props.multiple, true)
  assert.equal(f.input.props.accept, 'video/*,audio/*,image/*')
  f.controls.import.props.onClick({ target: elementFor(f.controls.import, true) })
  assert.equal(f.pickerClicks(), 1); assert.deepEqual(f.uploads, []); assert.deepEqual(f.imports, [])
})

test('the actual file input preserves all selected files and can import the same choice again', async () => {
  const f = fixture(), files = [{ name: 'one.wav' }, { name: 'two.png' }]
  for (let pass = 0; pass < 2; pass++) {
    const target = { files, value: 'owned-selection' }
    const receipt = await f.input.props.onChange({ target })
    assert.equal(target.value, ''); assert.equal(receipt.count, 2)
  }
  assert.deepEqual(f.uploads, [...files, ...files])
  assert.deepEqual(f.imports, [{ paths: ['media/one.wav', 'media/two.png'] }, { paths: ['media/one.wav', 'media/two.png'] }])
})

test('cancelled chooser performs no upload, request or success notification', async () => {
  const f = fixture()
  assert.equal(await f.input.props.onChange({ target: { files: [], value: '' } }), null)
  assert.deepEqual(f.uploads, []); assert.deepEqual(f.imports, []); assert.deepEqual(f.notices, [])
})

test('upload rejection uses the existing handled error path and preserves the project', async () => {
  const f = fixture({ uploadError: true })
  assert.equal(await f.input.props.onChange({ target: { files: [{ name: 'bad.mov' }], value: 'bad.mov' } }), null)
  assert.deepEqual(f.imports, []); assert.deepEqual(f.store.project, f.before)
  assert.deepEqual(f.notices.at(-1), { message: 'Import failed: Owned upload failed', kind: 'error' })
})

const expectedOps = (f, kind) => ({
  transition: [{ op: 'transition', id: f.ids[1], type: 'crossDissolve', dur: 1 }],
  effect: [{ op: 'effect', id: f.ids[1], type: 'glow' }],
  adjustment: [{ op: 'adjustment', start: 9, dur: 5 }],
  color: [{ op: 'add_color', start: 9, dur: 3, color: '#000000' }],
}[kind])
const expectedDrag = { transition: { type: 'transition', name: 'crossDissolve' }, effect: { type: 'effect', name: 'glow' }, adjustment: { type: 'generator', name: 'adjustment' }, color: { type: 'generator', name: 'color', color: '#000000' } }
for (const kind of Object.keys(expectedDrag)) {
  test(`${kind} actual click applies the existing operation once; drag remains separate`, async () => {
    const f = fixture(), node = f.controls[kind], payloads = []
    assert.equal(node.props.draggable, 'true')
    node.props.onDragStart({ target: elementFor(node, true), dataTransfer: { setData: (...args) => payloads.push(args) } })
    assert.deepEqual(payloads, [['application/x-reel', JSON.stringify(expectedDrag[kind])]])
    assert.deepEqual(f.calls, []); assert.deepEqual(f.store.project, f.before)
    // Native click synthesis is a separate real-browser gate; this calls the owning action.
    await node.props.onClick({ target: elementFor(node, true) })
    assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].ops, expectedOps(f, kind))
    assert.deepEqual(f.store.project, core.applyOps(f.before, expectedOps(f, kind)).project)
    assert.deepEqual(f.store.selection, [f.ids[1], 'tr:ignored']); assert.deepEqual(f.playback, [])
  })
  test(`${kind} actual edit refuses locked targets without publishing or changing the project`, async () => {
    const f = fixture({ locked: true })
    assert.equal(await f.controls[kind].props.onClick(), null)
    assert.deepEqual(f.calls, []); assert.deepEqual(f.store.project, f.before)
    assert.equal(f.notices.at(-1).kind, 'error')
    assert.match(f.notices.at(-1).message, /locked|unlocked video track/)
  })
}

for (const kind of ['transition', 'effect']) test(`${kind} with no selected clip keeps the existing guidance and does not edit`, async () => {
  const f = fixture({ selected: false })
  await f.controls[kind].props.onClick()
  assert.deepEqual(f.calls, []); assert.deepEqual(f.store.project, f.before)
  assert.equal(f.notices.at(-1).message, 'Select a clip first')
})
