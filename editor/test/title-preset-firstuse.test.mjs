import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const editor = process.env.ARYA_TITLE_PRESET_EDITOR_ROOT ? pathToFileURL(process.env.ARYA_TITLE_PRESET_EDITOR_ROOT + '/') : new URL('../', import.meta.url)
const browserURL = process.env.ARYA_TITLE_PRESET_BROWSER_PATH ? pathToFileURL(process.env.ARYA_TITLE_PRESET_BROWSER_PATH) : new URL('web/ui/browser.js', editor)
const require = createRequire(new URL('package.json', editor))
const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const coreURL = new URL('core/project.js', editor).href
registerHooks({ resolve(s, c, next) { return next(s.startsWith('/core/') ? new URL('.' + s, editor).href : s, c) } })
const { applyOps, newProject } = await import(coreURL)
const key = Symbol.for('arya.title-preset-firstuse.fixture')
const host = moduleURL("export const host={kind:'browser',events:()=>()=>{}};export const api=(...args)=>globalThis[Symbol.for('arya.title-preset-firstuse.fixture')].api(...args);")
const hooks = moduleURL('export const useEffect=()=>{};export const useLayoutEffect=()=>{};export const useState=v=>[v,()=>{}];export const useReducer=()=>[0,()=>{}];export const useRef=v=>({current:v});')
let source = await fs.readFile(new URL('web/ui/store.js', editor), 'utf8')
for (const [from, to] of [['preact/hooks', hooks], ['/core/project.js', coreURL], ['../host.js', host], ['./change-receipt.js', new URL('web/ui/change-receipt.js', editor).href]]) source = source.replaceAll("'" + from + "'", JSON.stringify(to))
const oldWidth = globalThis.innerWidth
let ui
try { globalThis.innerWidth = 1440; ui = await import(moduleURL(source)) }
finally { if (oldWidth === undefined) delete globalThis.innerWidth; else globalThis.innerWidth = oldWidth }
const { store, set, time } = ui
const facade = moduleURL(`export {api,addRef,edit,set,store,subscribe,time,viewProject} from ${JSON.stringify(moduleURL(source))};import {store} from ${JSON.stringify(moduleURL(source))};export const useStore=()=>store;export const toast=()=>{};`)
const preact = moduleURL(`import runtime from ${JSON.stringify(pathToFileURL(require.resolve('preact')).href)};export const h=runtime.h;`)
const htm = moduleURL(`import runtime from ${JSON.stringify(pathToFileURL(require.resolve('htm')).href)};export default runtime;`)
const empty = moduleURL('export const ScrollTabs=()=>null;export const openMenu=()=>{};export const registry={browserSections:[],browserTabs:[]};export const runTranscriptJob=()=>{};export const importMediaPaths=()=>{};export const uploadMediaFiles=()=>{};export const mediaDisplayModel=()=>({});export const mediaDisplayName=()=>"";export const mediaMatchesQuery=()=>true;')
source = await fs.readFile(browserURL, 'utf8')
for (const [from, to] of Object.entries({'preact': preact, 'htm': htm, 'preact/hooks': hooks, '/core/project.js': coreURL, './store.js': facade, '../host.js': host, './scroll-tabs.js': empty, './menu.js': empty, './registry.js': empty, './transcript-jobs.js': empty, './media-import.js': empty, './media-label.js': empty, './title-presets.js': new URL('web/ui/title-presets.js', editor).href})) source = source.replaceAll("'" + from + "'", JSON.stringify(to))
const { TitlesTab, TITLE_PRESETS } = await import(moduleURL(source + '\nexport {TitlesTab};\n'))
const nodes = v => Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === 'object' ? [v, ...nodes(v.props?.children)] : []
const scope = (p, comp) => comp ? p.comps[comp] : p

function fixture(t, comp = null, options = {}) {
  let project = newProject('Owned title fixture', { width: 320, height: 180 })
  project.comps = { nested: { id: 'nested', width: 640, height: 480, fps: 30, tracks: structuredClone(project.tracks) } }
  project = applyOps(project, [{ op: 'add_title', comp, text: 'Existing title' }]).project
  const oldID = scope(project, comp).tracks.flatMap(track => track.clips)[0].id
  if (options.locked) scope(project, comp).tracks.filter(track => track.kind === 'video').forEach(track => { track.locked = true })
  let version = 7, pending
  const calls = []
  globalThis[key] = { api(route, body) {
    if (route === '/api/project') {
      if (options.recoveryFails) throw Error('Recovery unavailable')
      return Promise.resolve({ project: structuredClone(project), version })
    }
    assert.equal(route, '/api/ops'); assert.equal(body.returnProject, true)
    calls.push(body)
    return new Promise((resolve, reject) => { pending = { body, resolve, reject } })
  } }
  set({ project, version, root: '/owned-title-fixture', openComp: comp, selection: [oldID], selMarker: null, selTrack: null, page: 'edit', viewerMode: 'timeline', source: null, toasts: [] })
  time.t = 1
  const initialSelection = store.selection
  const control = nodes(TitlesTab()).find(node => node.props?.class === 'preset title-preset')
  assert.ok(control)
  function finish(change = result => result) {
    assert.ok(pending, 'Actual edit reached the API boundary')
    if (options.serverExtraTitle) { project = applyOps(project, [{ op: 'add_title', comp, text: 'Concurrent server title' }]).project; version++ }
    const result = applyOps(project, pending.body.ops)
    project = result.project
    const receipt = change({ ...result, version: ++version })
    pending.resolve(receipt); pending = null
    return receipt
  }
  t.after(() => { if (pending) finish(); delete globalThis[key] })
  return { control, oldID, initialSelection, calls, finish, reject() { assert.ok(pending); pending.reject(Error('Owned edit rejected')); pending = null } }
}

for (const comp of [null, 'nested']) for (const activation of ['click', 'Enter', ' ']) {
  test(`actual preset ${JSON.stringify(activation)} selects only its committed title in ${comp ?? 'main'}`, async t => {
    const f = fixture(t, comp, { serverExtraTitle: true }), p = f.control.props
    assert.equal(p.role, 'button'); assert.equal(Number(p.tabIndex), 0)
    assert.equal(p['aria-label'], 'Add Basic Title at the playhead')
    let prevented = 0, stopped = 0
    const work = activation === 'click' ? p.onClick() : p.onKeyDown({ key: activation, repeat: false, preventDefault() { prevented++ }, stopPropagation() { stopped++ } })
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].ops[0].comp ?? null, comp)
    assert.equal(f.calls[0].ops[0].start, 1)
    assert.strictEqual(store.selection, f.initialSelection, 'An optimistic clip must not be selected')
    const optimisticID = scope(store.project, comp).tracks.flatMap(track => track.clips).find(clip => clip.id !== f.oldID).id
    const receipt = f.finish(); assert.notEqual(receipt.created[0], optimisticID)
    await work
    assert.deepEqual(store.selection, [receipt.created[0]])
    assert.ok(scope(store.project, comp).tracks.some(track => track.clips.some(clip => clip.id === store.selection[0] && clip.kind === 'title')))
    assert.equal(prevented, activation === 'click' ? 0 : 1); assert.equal(stopped, prevented)
  })
}

test('actual preset preserves drag data and ignores other keys and key repeats', t => {
  const f = fixture(t), payload = []
  f.control.props.onDragStart({ dataTransfer: { setData: (...args) => payload.push(args) } })
  assert.deepEqual(payload, [['application/x-reel', JSON.stringify({ type: 'title', preset: true, text: TITLE_PRESETS[0].text, title: TITLE_PRESETS[0].title, set: TITLE_PRESETS[0].set })]])
  for (const event of [{ key: 'Enter', repeat: true }, { key: ' ', repeat: true }, { key: 'ArrowRight', repeat: false }]) {
    let prevented = 0, stopped = 0
    f.control.props.onKeyDown({ ...event, preventDefault() { prevented++ }, stopPropagation() { stopped++ } })
    const recognized = event.key === 'Enter' || event.key === ' '
    assert.equal(prevented, recognized ? 1 : 0); assert.equal(stopped, prevented)
  }
  assert.equal(f.calls.length, 0); assert.strictEqual(store.selection, f.initialSelection)
})

for (const [name, mutate] of [
  ['new selection', f => set({ selection: ['manual-selection'] })],
  ['selection changed then restored', f => { set({ selection: [] }); set({ selection: f.initialSelection }) }],
  ['scope changed then restored', f => { set({ openComp: 'nested' }); set({ openComp: null }) }],
  ['project root changed then restored', f => { set({ root: '/other-project' }); set({ root: '/owned-title-fixture' }) }],
  ['marker selection', f => set({ selMarker: 'manual-marker' })],
  ['track selection', f => set({ selTrack: 'A1' })],
  ['source viewer navigation', f => set({ viewerMode: 'source', source: { src: 'manual.mov' } })],
]) test(`actual preset leaves ${name} unchanged after the delayed commit`, async t => {
  const f = fixture(t), work = f.control.props.onClick()
  mutate(f)
  const selected = store.selection, marker = store.selMarker, track = store.selTrack
  f.finish(); await work
  assert.strictEqual(store.selection, selected); assert.equal(store.selMarker, marker); assert.equal(store.selTrack, track)
})

for (const recoveryFails of [false, true]) test(`failed edit leaves selection unchanged when recovery fails=${recoveryFails}`, async t => {
  const f = fixture(t, null, { recoveryFails }), work = f.control.props.onClick()
  f.reject(); assert.equal(await work, null)
  assert.strictEqual(store.selection, f.initialSelection)
})

for (const [name, change] of [
  ['missing created IDs', result => ({ ...result, created: [] })],
  ['old created ID', (result, f) => ({ ...result, created: [f.oldID] })],
  ['unknown created ID', result => ({ ...result, created: ['not-in-project'] })],
  ['non-array created IDs', result => ({ ...result, created: result.created[0] })],
  ['title removed before publication', result => ({ ...result, project: applyOps(result.project, [{ op: 'delete', id: result.created[0] }]).project })],
]) test(`actual preset rejects selection from ${name}`, async t => {
  const f = fixture(t), work = f.control.props.onClick()
  f.finish(result => change(result, f)); await work
  assert.strictEqual(store.selection, f.initialSelection)
})

test('a response superseded by a newer project version cannot select its title', async t => {
  const f = fixture(t), work = f.control.props.onClick()
  set({ version: 50, project: structuredClone(store.project) })
  const currentProject = store.project
  f.finish(); await work
  assert.strictEqual(store.project, currentProject); assert.strictEqual(store.selection, f.initialSelection)
})

test('locked destinations leave selection and backend unchanged', async t => {
  const f = fixture(t, null, { locked: true })
  assert.equal(await f.control.props.onClick(), null)
  assert.equal(f.calls.length, 0); assert.strictEqual(store.selection, f.initialSelection)
})
