import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { registerHooks } from 'node:module'
import test from 'node:test'

const editor = new URL('../', import.meta.url)
registerHooks({ resolve(specifier, context, next) { return next(specifier.startsWith('/core/') ? new URL('.' + specifier, editor).href : specifier, context) } })
const { newProject } = await import('../core/project.js')

const ui = new URL('../web/ui/', import.meta.url)
const read = name => fs.readFile(new URL(name, ui), 'utf8')
const moduleURL = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const component = name => moduleURL(`export function ${name}(){return null}`)

// phone.js with its panels stubbed. Node caches these data-URL modules, so stubs read live globals.
async function loadPhone(tag) {
  let source = await read('phone.js')
  const imports = {
    preact: import.meta.resolve('preact'), htm: import.meta.resolve('htm'),
    'preact/hooks': moduleURL('export const useRef=x=>({current:x});export const useEffect=f=>{globalThis.__phoneEffects?.push(f)};export const useState=x=>{const o=globalThis.__phoneState;const v=o!==undefined?o:(typeof x==="function"?x():x);return[v,n=>globalThis.__phoneSet.push(n)]};'),
    './store.js': moduleURL('export const set=v=>globalThis.__phoneSet.push(v);export const useStore=()=>globalThis.__phoneStore;export const viewProject=()=>globalThis.__phoneProject;'),
    './viewer.js': component('Viewer'), './browser.js': component('Browser'), './inspector.js': component('Inspector'),
    './timeline-toolbar.js': component('Toolbar'), './timeline.js': component('Timeline'),
  }
  for (const [specifier, target] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(target))
  return import(moduleURL(`${source}\n// ${tag}`))
}

const walk = (node, out = []) => {
  if (Array.isArray(node)) { node.forEach(n => walk(n, out)); return out }
  if (node && typeof node === 'object') { out.push(node); walk(node.props?.children, out) }
  return out
}
const text = node => walk(node).flatMap(n => [n.props?.children].flat()).filter(c => typeof c === 'string').join('')

function project() {
  const p = newProject('Phone', { width: 1080, height: 1920, fps: 30 })
  p.tracks[0].clips.push({ id: 'c1', kind: 'video', src: 'media/harbour-wide.mp4', start: 0, dur: 4 })
  p.tracks[0].clips.push({ id: 'c2', kind: 'title', title: { text: 'The last ferry' }, start: 4, dur: 3 })
  p.tracks[0].clips.push({ id: 'c3', kind: 'shape', label: 'Lower third plate', start: 7, dur: 2 })
  return p
}

function withGlobals(values, run) {
  const keys = ['__phoneState', '__phoneSet', '__phoneStore', '__phoneProject', '__phoneEffects']
  const hadMatchMedia = 'matchMedia' in globalThis, oldMatchMedia = globalThis.matchMedia
  Object.assign(globalThis, { __phoneSet: [], __phoneEffects: [] }, values)
  return Promise.resolve().then(run).finally(() => {
    for (const k of keys) delete globalThis[k]
    if (hadMatchMedia) globalThis.matchMedia = oldMatchMedia; else delete globalThis.matchMedia
  })
}

test.after(() => assert.deepEqual(Object.keys(globalThis).filter(k => k.startsWith('__phone') || k === 'matchMedia'), []))

test('the phone query covers portrait phones and short landscape phones, not tablets or desktops', async () => {
  const { PHONE_QUERY } = await loadPhone('query')
  assert.equal(PHONE_QUERY, '(max-width: 720px), (max-height: 500px) and (max-width: 1000px)')
  const css = await read('phone.css')
  assert.match(css, /@media \(max-height: 500px\) and \(max-width: 1000px\) and \(orientation: landscape\)/, 'small landscape phones under 720 px use the two-column arrangement')
  assert.match(css, /\.page\.phone-edit \.edit-pane, \.page\.phone-edit > \.lower \{ order: 3; flex: 1; min-height: 0;/, 'outranks styles.css .page.edit .lower min-height')
})

test('usePhoneLayout reads the query, follows change events and removes its listener', async () => {
  const listeners = []
  const query = { matches: false, addEventListener: (type, fn) => listeners.push(['add', type, fn]), removeEventListener: (type, fn) => listeners.push(['remove', type, fn]) }
  const asked = []
  await withGlobals({ matchMedia: q => { asked.push(q); return query } }, async () => {
    const { usePhoneLayout, PHONE_QUERY } = await loadPhone('lifecycle')
    assert.equal(usePhoneLayout(), false)
    assert.equal(globalThis.__phoneEffects.length, 1)
    const cleanup = globalThis.__phoneEffects[0]()
    assert.deepEqual(globalThis.__phoneSet, [false], 'the effect syncs the current match')
    assert.equal(listeners[0][0], 'add'); assert.equal(listeners[0][1], 'change')
    query.matches = true; listeners[0][2]()
    query.matches = false; listeners[0][2]()
    assert.deepEqual(globalThis.__phoneSet, [false, true, false])
    cleanup()
    assert.deepEqual(listeners[1], ['remove', 'change', listeners[0][2]])
    assert.ok(asked.length >= 2 && asked.every(q => q === PHONE_QUERY))
  })
  await withGlobals({ matchMedia: undefined }, async () => {
    const { usePhoneLayout } = await loadPhone('lifecycle-none')
    delete globalThis.matchMedia
    assert.equal(usePhoneLayout(), false, 'no matchMedia means the desktop layout')
    assert.equal(globalThis.__phoneEffects[0](), undefined)
  })
})

test('selection names match the timeline clip label, including transitions', async () => {
  const { selectionName } = await loadPhone('names')
  const p = project()
  assert.equal(selectionName(p, 'c1'), 'harbour-wide.mp4')
  assert.equal(selectionName(p, 'c2'), 'The last ferry')
  assert.equal(selectionName(p, 'c3'), 'Lower third plate')
  assert.equal(selectionName(p, 'tr:c2'), 'Transition into The last ferry')
  assert.equal(selectionName(p, 'missing'), null)
  assert.equal(selectionName(null, 'c1'), null)
})

test('the panel switcher is a labelled tablist with one selected tab and a linked panel', async () => {
  for (const panel of ['timeline', 'media', 'inspector']) {
    await withGlobals({ __phoneState: panel, __phoneStore: { selection: [] }, __phoneProject: project() }, async () => {
      const { PhonePanelControls } = await loadPhone(`tabs-${panel}`)
      const tree = PhonePanelControls({panel:globalThis.__phoneState,setPanel:n=>globalThis.__phoneSet.push(n)})
      const list = walk(tree).find(n => n.props?.role === 'tablist')
      assert.equal(list.props['aria-label'], 'Edit panel')
      const tabs = walk(list).filter(n => n.props?.role === 'tab')
      assert.deepEqual(tabs.map(t => text(t)), ['Timeline', 'Media', 'Inspector'])
      assert.deepEqual(tabs.map(t => t.props['aria-selected']), ['timeline', 'media', 'inspector'].map(id => id === panel))
      assert.deepEqual(tabs.map(t => t.props.tabIndex), ['timeline', 'media', 'inspector'].map(id => (id === panel ? 0 : -1)))
      assert.deepEqual(tabs.map(t => t.props['aria-controls']), ['edit-panel-timeline', 'edit-panel-media', 'edit-panel-inspector'])
      globalThis.__phoneSet.length = 0
      tabs[1].props.onClick()
      assert.deepEqual(globalThis.__phoneSet, ['media'])
    })
  }
})

test('a selection stays named under the switcher and Properties opens the inspector', async () => {
  await withGlobals({ __phoneState: 'timeline', __phoneStore: { selection: ['c2', 'c3'] }, __phoneProject: project() }, async () => {
    const { PhonePanelControls } = await loadPhone('readout-timeline')
    const readout = walk(PhonePanelControls({panel:globalThis.__phoneState,setPanel:n=>globalThis.__phoneSet.push(n)})).find(n => n.props?.class === 'phone-readout')
    assert.ok(readout, 'readout is shown on the timeline panel')
    assert.equal(readout.props.role, 'status')
    assert.match(text(readout), /SelectedThe last ferry and 1 more/)
    const properties = walk(readout).find(n => n.type === 'button')
    assert.equal(text(properties), 'Properties')
    properties.props.onClick()
    assert.deepEqual(globalThis.__phoneSet, ['inspector'])
  })
  await withGlobals({ __phoneState: 'inspector', __phoneStore: { selection: ['c2'] }, __phoneProject: project() }, async () => {
    const { PhonePanelControls } = await loadPhone('readout-inspector')
    assert.equal(walk(PhonePanelControls({panel:globalThis.__phoneState,setPanel:n=>globalThis.__phoneSet.push(n)})).some(n => n.props?.class === 'phone-readout'), false, 'the inspector already shows the selection')
  })
  await withGlobals({ __phoneState: 'media', __phoneStore: { selection: [] }, __phoneProject: project() }, async () => {
    const { PhonePanelControls } = await loadPhone('readout-none')
    assert.equal(walk(PhonePanelControls({panel:globalThis.__phoneState,setPanel:n=>globalThis.__phoneSet.push(n)})).some(n => n.props?.class === 'phone-readout'), false)
  })
})

test('arrow keys move between panel tabs and wrap around', async () => {
  await withGlobals({ __phoneState: 'timeline', __phoneStore: { selection: [] }, __phoneProject: project() }, async () => {
    const { PhonePanelControls } = await loadPhone('keys')
    const list = walk(PhonePanelControls({panel:globalThis.__phoneState,setPanel:n=>globalThis.__phoneSet.push(n)})).find(n => n.props?.role === 'tablist')
    const focused = []
    const event = key => ({ key, preventDefault() { this.prevented = true }, currentTarget: { querySelector: sel => ({ focus: () => focused.push(sel) }) } })
    const left = event('ArrowLeft'); list.props.onKeyDown(left)
    const right = event('ArrowRight'); list.props.onKeyDown(right)
    const other = event('Enter'); list.props.onKeyDown(other)
    assert.deepEqual(globalThis.__phoneSet, ['inspector', 'media'])
    assert.deepEqual(focused, ['[data-panel="inspector"]', '[data-panel="media"]'])
    assert.equal(left.prevented, true)
    assert.equal(other.prevented, undefined)
  })
})

test('the wide-window notice names the workspace and returns to Edit', async () => {
  await withGlobals({}, async () => {
    const { PhoneWideNotice } = await loadPhone('notice')
    const tree = PhoneWideNotice({ name: 'Motion' })
    assert.match(text(tree), /Motion needs a wider window/)
    assert.match(text(tree), /at least 900 pixels wide/)
    const back = walk(tree).find(n => n.type === 'button')
    assert.equal(text(back), 'Back to Edit')
    back.props.onClick()
    assert.deepEqual(globalThis.__phoneSet, [{ page: 'edit' }])
  })
})

test('the gate shows the notice for Motion on phones and renders every other page unchanged', async () => {
  const Motion = () => null, Captions = () => null
  for (const [phone, page, expect] of [[true, { id: 'motion', label: 'Motion', component: Motion }, 'notice'], [false, { id: 'motion', label: 'Motion', component: Motion }, Motion], [true, { id: 'captions', label: 'Captions', component: Captions }, Captions]]) {
    await withGlobals({ __phoneState: phone }, async () => {
      const { PhoneGate, PhoneWideNotice } = await loadPhone(`gate-${phone}-${page.id}`)
      const node = PhoneGate({ page })
      if (expect === 'notice') { assert.equal(node.type, PhoneWideNotice); assert.equal(node.props.name, 'Motion') }
      else assert.equal(node.type, expect)
    })
  }
})

test('EditPage keeps one panel tree mounted across media-query changes', async () => {
  const app = await read('app.js')
  const appBody = app.slice(app.indexOf('function App()'), app.indexOf('export async function mountApp'))
  assert.doesNotMatch(appBody, /usePhoneLayout|PhonePanelControls/, 'App stays free of the phone hook')
  assert.match(appBody, /h\(PhoneGate, \{ page: registry\.pages\.find\(pg => pg\.id === s\.page\) \}\)/)
  const edit = app.slice(app.indexOf('function EditPage()'), app.indexOf('function Welcome()'))
  assert.match(edit, /useWorkspaceWidth\(\)/)
  assert.match(edit, /useCompactEditPanel\(\)/)
  assert.equal([...edit.matchAll(/<\$\{Inspector\}/g)].length, 1)
  assert.equal([...edit.matchAll(/<\$\{Viewer\}/g)].length, 1)
  assert.match(edit, /key="inspector"/)
  // `panel` is the compact choice, or the Inspector while one of its fields has focus.
  assert.match(edit, /hidden: phone \|\| compact \? panel !== name : !visible\(name\)/)
  assert.match(edit, /const panel = keepInspector \? 'inspector' : compactPanel/)
  assert.match(app, /<source media="\(max-width: 480px\)" srcset="\/assets\/brand\/mark\.svg" \/>/)
  const css = await read('phone.css')
  assert.match(css, /\.page\.phone-edit \.viewer\.compact \.transport \.buttons\.right \{ display: flex; \}/)
  assert.match(css, /\.phone-edit \.transport button \{ min-height: 44px; min-width: 44px; \}/)
  const index = await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  assert.ok(index.indexOf('/ui/phone.css') > index.indexOf('/ui/icons.css'))
})
