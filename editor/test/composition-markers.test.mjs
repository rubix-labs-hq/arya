import './fixtures/browser-host-imports.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const editor = process.env.ARYA_MARKER_EDITOR_ROOT ? new URL(`file://${process.env.ARYA_MARKER_EDITOR_ROOT}/`) : new URL('../', import.meta.url)
const { applyOps, compView, migrate, newProject } = await import(new URL('core/project.js', editor))
const coreURL = new URL('core/project.js', editor).href
const moduleURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const read = relative => fs.readFile(new URL(relative, editor), 'utf8')
const run = (p, ops) => applyOps(p, ops).project
function fixture() {
  const p = newProject('Main marker fixture', { fps: 30 })
  p.markers = [{ id: 'm1', t: 4, label: 'Main four', color: '#123456' }, { id: 'm8', t: 8, label: 'Main eight', note: 'Original marker' }]
  p.comps = {
    k1: { id: 'k1', name: 'Four seconds', width: 1920, height: 1080, fps: 25, duration: 4, tracks: [{ id: 'V1', kind: 'video', clips: [] }] },
    k2: { id: 'k2', name: 'Other scene', width: 1920, height: 1080, fps: 24, duration: 12, markers: [{ id: 'm21', t: 2, label: 'Other two', color: '#abcdef', kind: 'chapter', note: 'Nested note', dur: 0.5 }], tracks: [{ id: 'V1', kind: 'video', clips: [] }] },
  }
  return p
}
const markerIds = p => [...p.markers, ...Object.values(p.comps).flatMap(c => c.markers ?? [])].map(m => m.id)

test('a four-second unmarked composition inherits neither main ruler marker', () => {
  const p = fixture(), before = structuredClone(p)
  assert.deepEqual(compView(p, 'k1').markers, [])
  assert.deepEqual(p, before, 'A read-only projection must not mutate old files')
  assert.deepEqual(compView(p, null).markers, before.markers)
})
test('switching nested views selects each composition marker array', () => {
  const p = fixture()
  assert.deepEqual(compView(compView(p, 'k1'), 'k2').markers, p.comps.k2.markers)
  assert.deepEqual(compView(compView(p, 'k2'), 'k1').markers, [])
  assert.deepEqual(p.markers.map(m => m.t), [4, 8])
})
test('migration leaves missing local marker fields absent while new compositions own empty markers', () => {
  const p = migrate(fixture())
  assert.equal(Object.hasOwn(p.comps.k1, 'markers'), false)
  assert.deepEqual(compView(p, 'k1').markers, [])
  assert.equal(p.comps.k2.markers[0].id, 'm21')
  const q = run(p, [{ op: 'add_comp', name: 'New' }])
  assert.deepEqual(q.comps.k3.markers, [])
  assert.deepEqual(q.markers, p.markers)
})
test('precompose creates an unmarked local timeline and retains main markers', () => {
  const p = run(fixture(), [{ op: 'add_title', track: 'V1', start: 1, dur: 2, text: 'Title' }])
  const q = run(p, [{ op: 'precompose', ids: ['c1'], name: 'Title comp' }])
  assert.deepEqual(q.comps.k3.markers, [])
  assert.deepEqual(q.markers, p.markers)
})
test('nested single and batch markers use local frame rate and globally fresh IDs', () => {
  const p = fixture(), q = run(p, [
    { op: 'marker', comp: 'k1', t: 1.019, label: 'Local' },
    { op: 'markers', comp: 'k1', markers: [{ t: 2.019, label: 'Batch', dur: 0.5 }] },
    { op: 'marker', t: 3.018, label: 'New main' },
    { op: 'marker', comp: 'k2', t: 4.019, label: 'Other' },
  ])
  assert.deepEqual(q.comps.k1.markers.map(m => [m.id, m.t]), [['m22', 1], ['m23', 2]])
  assert.equal(q.comps.k1.markers[1].dur, 0.5)
  assert.equal(q.markers.find(m => m.label === 'New main').id, 'm24')
  assert.equal(q.markers.find(m => m.label === 'New main').t, 3.03333)
  assert.equal(q.comps.k2.markers.at(-1).id, 'm25')
  assert.equal(new Set(markerIds(q)).size, markerIds(q).length)
  assert.deepEqual(p.comps.k1.markers, undefined)
})
test('nested marker update and delete preserve main and sibling markers', () => {
  let p = fixture(); p.comps.k1.markers = [{ id: 'm12', t: 1, label: 'Nested' }]
  const originalMain = structuredClone(p.markers), other = structuredClone(p.comps.k2.markers)
  p = run(p, [{ op: 'update_marker', comp: 'k1', id: 'm12', set: { t: 1.019, label: 'Edited', note: 'Local note' } }])
  assert.deepEqual(p.comps.k1.markers[0], { id: 'm12', t: 1, label: 'Edited', note: 'Local note' })
  p = run(p, [{ op: 'delete_marker', comp: 'k1', ids: ['m12'] }])
  assert.deepEqual(p.comps.k1.markers, [])
  assert.deepEqual(p.markers, originalMain); assert.deepEqual(p.comps.k2.markers, other)
})
test('explicit main marker operations retain their root meaning', () => {
  const p = fixture(), q = run(p, [{ op: 'update_marker', comp: null, id: 'm1', set: { label: 'Root edited' } }, { op: 'delete_marker', comp: null, id: 'm8' }])
  assert.deepEqual(q.markers.map(m => m.label), ['Root edited'])
  assert.deepEqual(q.comps.k2.markers, p.comps.k2.markers)
})
test('mixed scopes remain atomic when a later marker scope is missing', () => {
  const p = fixture(), before = structuredClone(p)
  assert.throws(() => run(p, [{ op: 'marker', comp: 'k1', t: 1 }, { op: 'marker', comp: 'gone', t: 1 }]), /no composition gone/)
  assert.deepEqual(p, before)
})
test('preview edits of a nested view use its own markers and reserve main IDs', () => {
  const p = fixture(); p.markers.push({ id: 'm100', t: 9, label: 'Reserved root ID' })
  const view = compView(p, 'k1'), result = run(view, [{ op: 'marker', t: 1, label: 'Preview' }])
  assert.deepEqual(result.markers.map(m => [m.id, m.label]), [['m101', 'Preview']])
  assert.deepEqual(p.comps.k1.markers, undefined)
})

// Execute the actual optimistic store, replacing only browser module URLs/hooks and the API host.
const receiptKey = Symbol.for('arya.marker.fixture')
const hooks = moduleURL('export const useEffect=()=>{};export const useLayoutEffect=()=>{};export const useReducer=()=>[0,()=>{}];export const useState=v=>[v,()=>{}];export const useRef=v=>({current:v});')
const hostURL = moduleURL("export const host={events:()=>()=>{},kind:'browser'};export const api=(...args)=>globalThis[Symbol.for('arya.marker.fixture')].api(...args);")
let storeSource = (await read('web/ui/store.js')).replace("'preact/hooks'", JSON.stringify(hooks)).replace("'/core/project.js'", JSON.stringify(coreURL)).replace("'../host.js'", JSON.stringify(hostURL)).replace("'./change-receipt.js'", JSON.stringify(new URL('web/ui/change-receipt.js', editor).href))
const originalWidth = globalThis.innerWidth; globalThis.innerWidth = 1440
const storeURL = moduleURL(storeSource), { edit, set, store, setTime, viewProject } = await import(storeURL)
if (originalWidth === undefined) delete globalThis.innerWidth; else globalThis.innerWidth = originalWidth
function controller(t) {
  let backend = fixture(), version = 1; const calls = []
  const previous = globalThis[receiptKey]
  globalThis[receiptKey] = { api: async (route, body) => {
    calls.push({ route, body })
    if (route === '/api/ops') { backend = run(backend, body.ops); return { project: backend, version: ++version } }
    if (route === '/api/analyze') return { times: [1, 2], bpm: 120 }
    return { project: backend, version }
  } }
  set({ project: backend, version, openComp: 'k1', jobs: [], caps: {}, root: '/owned-fixture', selection: [], selMarker: null, settingsOpen: false, zoom: 80, scroll: 0, toasts: [] })
  t.after(() => { if (previous === undefined) delete globalThis[receiptKey]; else globalThis[receiptKey] = previous })
  return { calls }
}
for (const operation of ['marker', 'markers', 'update_marker', 'delete_marker']) {
  test(`actual store scopes ${operation} despite marker IDs and preserves explicit root override`, async t => {
    const { calls } = controller(t)
    let op = { op: operation, t: 1, label: 'Local', markers: [{ t: 1, label: 'Batch' }], id: 'm21', set: { label: 'Edited' } }
    if (operation === 'update_marker' || operation === 'delete_marker') set({ openComp: 'k2' })
    assert.ok(await edit(op))
    assert.equal(calls[0].body.ops[0].comp, store.openComp)
    assert.deepEqual(store.project.markers, fixture().markers)
    await edit({ op: 'marker', comp: null, t: 3, label: 'Root' })
    assert.equal(calls.at(-1).body.ops[0].comp, null)
    assert.ok(store.project.markers.some(m => m.label === 'Root'))
  })
}
const stubPlayer = moduleURL('export const player={seek(){},step(){},toggle(){}};')
const keySource = (await read('web/ui/keys.js')).replace("'/core/project.js'", JSON.stringify(coreURL)).replace("'./store.js'", JSON.stringify(storeURL)).replace("'./engine-host.js'", JSON.stringify(stubPlayer)).replace("'./timeline.js'", JSON.stringify(moduleURL('export const copySelection=()=>{};'))).replace("'./source-media.js'", JSON.stringify(new URL('web/ui/source-media.js', editor).href))
const savedElement = globalThis.Element; globalThis.Element = class {}
const keys = await import(moduleURL(keySource))
if (savedElement === undefined) delete globalThis.Element; else globalThis.Element = savedElement
test('actual M keyboard adds local marker and Delete command deletes it without touching main', async t => {
  const { calls } = controller(t), before = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element }
  let handler; globalThis.Element = class {}; globalThis.document = { activeElement: null }; globalThis.window = { addEventListener: (_event, fn) => { handler = fn } }
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value } })
  keys.installKeys(); setTime(1.019)
  handler({ key: 'm', target: { closest: () => null }, preventDefault() {} }); await new Promise(resolve => setImmediate(resolve))
  const marker = store.project.comps.k1.markers?.[0]; assert.ok(marker); assert.equal(marker.t, 1); assert.equal(calls[0].body.ops[0].comp, 'k1')
  set({ selMarker: marker.id }); assert.equal(keys.runEditorCommand('delete'), 'handled'); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(store.project.comps.k1.markers, []); assert.deepEqual(store.project.markers, fixture().markers)
})

// Invoke the unchanged real canvas ruler/snap implementation with a recording 2D context.
const empty = moduleURL('export const openMenu=()=>{};export const registry={timeline:[]};')
let timeline = (await read('web/ui/timeline.js')).replace("'preact'", JSON.stringify(moduleURL('export const h=()=>{};'))).replace("'preact/hooks'", JSON.stringify(hooks)).replace("'htm'", JSON.stringify(moduleURL('export default {bind:()=>()=>{}};'))).replace("'/core/project.js'", JSON.stringify(coreURL)).replace("'./store.js'", JSON.stringify(storeURL)).replace("'./menu.js'", JSON.stringify(empty)).replace("'./engine-host.js'", JSON.stringify(stubPlayer)).replace("'./registry.js'", JSON.stringify(empty)).replace("'./title-presets.js'", JSON.stringify(new URL('web/ui/title-presets.js', editor).href))
timeline += '\nexport { drawRuler as markerFixtureDrawRuler, snapPoints as markerFixtureSnapPoints };\n'
const { markerFixtureDrawRuler, markerFixtureSnapPoints } = await import(moduleURL(timeline))
function labels(p) {
  const text = [], context = new Proxy({ fillText: value => text.push(value) }, { get(target, key) { return target[key] ?? (() => {}) }, set(target, key, value) { target[key] = value; return true } })
  markerFixtureDrawRuler(context, p, { width: 1000 }); return text
}
test('actual browser ruler renders only current composition labels and root labels on main', t => {
  controller(t)
  assert.ok(!labels(viewProject()).includes('Main four')); assert.ok(!labels(viewProject()).includes('Main eight'))
  set({ openComp: 'k2' }); assert.ok(labels(viewProject()).includes('Other two')); assert.ok(!labels(viewProject()).includes('Main four'))
  set({ openComp: null }); assert.ok(labels(viewProject()).includes('Main four')); assert.ok(labels(viewProject()).includes('Main eight'))
})
test('actual browser snapping has local markers and never inherited main marker points', t => {
  controller(t); setTime(0)
  assert.ok(!markerFixtureSnapPoints(viewProject(), new Set()).includes(8))
  set({ openComp: 'k2' }); assert.ok(markerFixtureSnapPoints(viewProject(), new Set()).includes(2)); assert.ok(!markerFixtureSnapPoints(viewProject(), new Set()).includes(8))
  set({ openComp: null }); assert.ok(markerFixtureSnapPoints(viewProject(), new Set()).includes(8))
})

const motionSource = (await read('web/ui/motion/ops.js')).replace("'/core/project.js'", JSON.stringify(coreURL)).replace("'/core/expr.js'", JSON.stringify(new URL('core/expr.js', editor).href))
const { duplicateCompOps, maxClipNumber, nextCompId } = await import(moduleURL(motionSource))
test('Motion duplicate keeps local marker content with fresh IDs and preserves the original', () => {
  const p = fixture(), original = structuredClone(p.comps.k2.markers), plan = duplicateCompOps(p, 'k2'), q = run(p, plan.ops)
  const copied = q.comps[plan.id].markers
  assert.deepEqual(copied.map(({ id, ...m }) => m), original.map(({ id, ...m }) => m))
  assert.notEqual(copied[0].id, original[0].id); assert.equal(new Set(markerIds(q)).size, markerIds(q).length)
  assert.deepEqual(q.comps.k2.markers, original); assert.deepEqual(q.markers, p.markers)
})
test('Motion ID predictions include composition marker reservations as core IDs do', () => {
  const p = fixture(); p.comps.k2.markers.push({ id: 'c97', t: 3, label: '' }, { id: 'k91', t: 3, label: '' })
  assert.equal(maxClipNumber(p), 97); assert.equal(nextCompId(p), 'k92')
})
test('composition library accepts migrated empty markers and preserves/remaps marked dependencies', () => {
  let p = run(fixture(), [{ op: 'library_save', category: 'composition', name: 'Local markers', source: { composition: 'k2' } }])
  const saved = structuredClone(p.library.items[0]), before = structuredClone(p.markers)
  assert.equal(saved.body.comps.k2.markers[0].label, 'Other two')
  p = run(p, [{ op: 'library_apply', item: saved.id, track: 'V1', start: 0 }])
  const placed = p.tracks[0].clips[0], copied = p.comps[placed.comp].markers
  assert.equal(copied[0].label, 'Other two'); assert.notEqual(copied[0].id, 'm21')
  assert.equal(new Set(markerIds(p)).size, markerIds(p).length); assert.deepEqual(p.markers, before); assert.deepEqual(p.library.items[0], saved)
  assert.doesNotThrow(() => run(p, [{ op: 'library_save', category: 'composition', name: 'Unmarked', source: { composition: 'k1' } }]))
})
test('library rejects malformed and duplicate markers without mutating source', () => {
  for (const markers of [[{ id: 'm21', t: -1, label: '' }], [{ id: 'm21', t: 1, label: '' }, { id: 'm21', t: 2, label: '' }], [{ id: 'm21', t: 1, label: 42 }]]) {
    const p = fixture(); p.comps.k2.markers = markers; const before = structuredClone(p)
    assert.throws(() => run(p, [{ op: 'library_save', category: 'composition', name: 'Invalid', source: { composition: 'k2' } }]), /marker|duplicate/)
    assert.deepEqual(p, before)
  }
})

// The real analysis entrypoint is evaluated intact; API I/O uses the same actual store controller.
const analysisSource = await read('web/ui/browser.js')
const analyzeBody = analysisSource.slice(analysisSource.indexOf('async function analyze('), analysisSource.indexOf('\nfunction MediaCard('))
const analyzeContext = vm.createContext({ store, viewProject, JSON,
  api: (...args) => globalThis[receiptKey].api(...args), edit, set,
  toast: (...args) => globalThis[receiptKey].messages?.push(args),
})
vm.runInContext(analyzeBody, analyzeContext)
for (const kind of ['scenes', 'beats']) {
  test(`actual ${kind} marker analysis maps the opened nested clip and captures composition/version`, async t => {
    const { calls } = controller(t)
    store.project.assets['media/fixture.mp4'] = { hasVideo: true, hasAudio: true, duration: 20 }
    store.project.comps.k1.tracks[0].clips.push({ id: 'c1', kind: 'video', src: 'media/fixture.mp4', start: 1, in: 0, dur: 3, speed: 2 })
    await analyzeContext.analyze('media/fixture.mp4', kind)
    const request = calls.find(call => call.route === '/api/ops')
    assert.ok(request); assert.equal(request.body.expectedVersion, 1); assert.equal(request.body.ops[0].comp, 'k1')
    assert.deepEqual(store.project.comps.k1.markers.map(m => m.t), [1.52, 2])
    assert.deepEqual(store.project.markers, fixture().markers)
  })
  for (const drift of ['composition', 'version', 'root', 'asset', 'project']) {
    test(`actual ${kind} analysis refuses ${drift} drift before marker admission`, async t => {
      const { calls } = controller(t), messages = []; globalThis[receiptKey].messages = messages
      store.project.assets['media/fixture.mp4'] = { hasVideo: true, hasAudio: true, duration: 20 }
      const initialAPI = globalThis[receiptKey].api
      globalThis[receiptKey].api = async (...args) => {
        const result = await initialAPI(...args)
        if (args[0] === '/api/analyze') {
          if (drift === 'composition') set({ openComp: 'k2' })
          if (drift === 'version') set({ version: 2 })
          if (drift === 'root') set({ root: '/other-fixture' })
          if (drift === 'asset') store.project.assets['media/fixture.mp4'].duration = 21
          if (drift === 'project') set({ project: structuredClone(store.project) })
        }
        return result
      }
      await analyzeContext.analyze('media/fixture.mp4', kind)
      assert.equal(calls.filter(call => call.route === '/api/ops').length, 0)
      assert.ok(messages.some(([text, type]) => /changed during analysis/.test(text) && type === 'error'))
      assert.deepEqual(store.project.markers, fixture().markers)
    })
  }
}

// Silence removal must use the same captured composition and version as marker analysis.
function silenceController(t, clips, ranges = [[1, 2]]) {
  const f = controller(t)
  store.project.assets['media/fixture.mp4'] = { hasVideo: true, hasAudio: true, duration: 20 }
  store.project.comps.k1.tracks[0].clips.push(...clips)
  const initialAPI = globalThis[receiptKey].api
  globalThis[receiptKey].api = async (...args) => args[0] === '/api/analyze' ? { ranges } : initialAPI(...args)
  return f
}
const silenceClip = (id, patch = {}) => ({ id, kind: 'video', src: 'media/fixture.mp4', start: 0, in: 0, dur: 3, ...patch })
const roundedRanges = request => JSON.parse(JSON.stringify(request.body.ops.map(op => [op.from, op.to].map(n => Math.round(n * 1e6) / 1e6))))
test('silence removal maps repeated uses, merges linked duplicates and scopes every ripple cut', async t => {
  const { calls } = silenceController(t, [silenceClip('c1'), silenceClip('c2', { start: 6, in: 0.5, speed: 2 })])
  store.project.comps.k1.tracks.push({ id: 'A1', kind: 'audio', clips: [silenceClip('c3', { kind: 'audio' })] })
  const main = structuredClone(store.project.tracks), sibling = structuredClone(store.project.comps.k2)
  await analyzeContext.analyze('media/fixture.mp4', 'silence', true)
  const request = calls.find(c => c.route === '/api/ops'); assert.ok(request)
  assert.equal(request.body.expectedVersion, 1)
  assert.deepEqual(roundedRanges(request), [[6.29, 6.71], [1.08, 1.92]])
  assert(request.body.ops.every(op => op.comp === 'k1'))
  assert.deepEqual(store.project.tracks, main); assert.deepEqual(store.project.comps.k2, sibling)
  assert.equal(store.project.comps.k1.tracks[0].clips.filter(c => c.src === 'media/fixture.mp4').length, 4)
})
test('silence crossing trim edges cuts each visible intersection without bridging timeline gaps', async t => {
  const { calls } = silenceController(t, [silenceClip('c1', { dur: 2 }), silenceClip('c2', { start: 10, in: 4, dur: 2 })], [[1, 5]])
  await analyzeContext.analyze('media/fixture.mp4', 'silence', true)
  assert.deepEqual(roundedRanges(calls.find(c => c.route === '/api/ops')), [[10, 10.92], [1.08, 2]])
})
for (const drift of ['composition', 'version', 'root', 'asset', 'project']) {
  test(`silence removal refuses ${drift} drift while analysis is pending`, async t => {
    const { calls } = silenceController(t, [silenceClip('c1')]), messages = []; globalThis[receiptKey].messages = messages
    const initialAPI = globalThis[receiptKey].api
    globalThis[receiptKey].api = async (...args) => {
      const result = await initialAPI(...args)
      if (args[0] === '/api/analyze') {
        if (drift === 'composition') set({ openComp: 'k2' })
        if (drift === 'version') set({ version: 2 })
        if (drift === 'root') set({ root: '/other-fixture' })
        if (drift === 'asset') store.project.assets['media/fixture.mp4'].duration = 21
        if (drift === 'project') set({ project: structuredClone(store.project) })
      }
      return result
    }
    await analyzeContext.analyze('media/fixture.mp4', 'silence', true)
    assert.equal(calls.filter(c => c.route === '/api/ops').length, 0)
    assert(messages.some(([message, type]) => /changed during analysis/.test(message) && type === 'error'))
  })
}
for (const patch of [{ reverse: true }, { freeze: 1 }, { timeMap: [[0, 0], [1, 2]] }]) {
  test(`silence removal refuses unsupported retiming ${JSON.stringify(patch)}`, async t => {
    const { calls } = silenceController(t, [silenceClip('c1', patch)]), messages = []; globalThis[receiptKey].messages = messages
    await analyzeContext.analyze('media/fixture.mp4', 'silence', true)
    assert.equal(calls.filter(c => c.route === '/api/ops').length, 0)
    assert(messages.some(([message, type]) => /forward.*scalar speed/.test(message) && type === 'error'))
  })
}

// Bundle only shared JavaScript source into owned files; this does not invoke a native compiler.
test('native JSON bridge executes the same scoped marker CRUD and file text retains both scopes', async t => {
  const temp = new URL('../../marker-bundle-output/', editor), out = new URL('reel-core.js', temp)
  await fs.mkdir(temp, { recursive: true }); t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../native/scripts/bundle-core.mjs', editor)), '--out', fileURLToPath(out)], { encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  const context = vm.createContext({}); vm.runInContext(await fs.readFile(out, 'utf8'), context)
  const bridge = context.ReelCore.bridge, p = fixture(), ops = [{ op: 'marker', comp: 'k1', t: 1.019, label: 'Native local' }, { op: 'update_marker', comp: 'k2', id: 'm21', set: { label: 'Native sibling' } }]
  const actual = JSON.parse(bridge.applyOpsJSON(JSON.stringify(p), JSON.stringify(ops))).project
  assert.deepEqual(actual, JSON.parse(JSON.stringify(run(p, ops))))
  const file = JSON.parse(bridge.fileText(JSON.stringify(actual)))
  assert.equal(file.comps.k1.markers[0].label, 'Native local'); assert.equal(file.comps.k2.markers[0].label, 'Native sibling'); assert.deepEqual(file.markers, p.markers)
})


// Legacy composition marker fields are projected lazily and are not normalization edits.
function legacyMarkerFixture() {
  const p = fixture()
  p.comps.k3 = { id: 'k3', name: 'Unrelated legacy scene', fps: 24, tracks: [{ id: 'V1', kind: 'video', clips: [] }] }
  p.tracks[0].clips.push({ id: 'reused', kind: 'title', start: 0, dur: 2, title: { text: 'Main layer' } })
  p.comps.k1.tracks[0].clips.push({ id: 'reused', kind: 'title', start: 0, dur: 2, title: { text: 'Nested layer' } }, { id: 'nested-only', kind: 'shape', start: 0, dur: 2, shape: { type: 'rect', fill: { color: '#112233' } } })
  return p
}
test('migration preserves absent marker fields and the exact shape of unrelated legacy compositions', () => {
  const p = legacyMarkerFixture(), comps = structuredClone(p.comps)
  migrate(p)
  assert.deepEqual(p.comps, comps)
  assert.equal(Object.hasOwn(p.comps.k1, 'markers'), false)
  assert.deepEqual(compView(p, 'k1').markers, [])
})
test('empty operation batches preserve all composition fields including absent local markers', () => {
  const p = legacyMarkerFixture(), q = run(p, [])
  assert.deepEqual(q.comps, p.comps)
})
test('main clip edits preserve other composition objects with reused clip IDs exactly', () => {
  const p = legacyMarkerFixture(), q = run(p, [{ op: 'update', comp: null, id: 'reused', set: { label: 'Main changed' } }])
  assert.equal(q.tracks[0].clips[0].label, 'Main changed')
  assert.deepEqual(q.comps, p.comps)
})
for (const explicit of [true, false]) test(`nested clip-only edits preserve absent marker fields (${explicit ? 'explicit' : 'inferred'} scope)`, () => {
  const p = legacyMarkerFixture(), q = run(p, [{ op: 'update', ...(explicit ? { comp: 'k1' } : {}), id: explicit ? 'reused' : 'nested-only', set: { label: 'Nested changed' } }])
  assert.equal(Object.hasOwn(q.comps.k1, 'markers'), false)
  assert.deepEqual(q.comps.k2, p.comps.k2); assert.deepEqual(q.comps.k3, p.comps.k3)
  assert.deepEqual(q.markers, p.markers); assert.deepEqual(q.tracks, p.tracks)
})
test('main marker CRUD does not materialize fields in any unrelated legacy composition', () => {
  const p = legacyMarkerFixture(), q = run(p, [{ op: 'marker', comp: null, t: 1, label: 'Root' }, { op: 'update_marker', comp: null, id: 'm1', set: { label: 'Main changed' } }, { op: 'delete_marker', comp: null, id: 'm8' }])
  assert.deepEqual(q.comps, p.comps)
  assert.equal(q.markers.find(m => m.id === 'm1').label, 'Main changed')
})
for (const op of [{ op: 'markers', markers: [] }, { op: 'delete_marker', id: 'absent' }]) test(`no-op local ${op.op} keeps an absent marker field absent`, () => {
  const p = legacyMarkerFixture(), q = run(p, [{ ...op, comp: 'k1' }])
  assert.deepEqual(q.comps, p.comps)
  assert.deepEqual(q.markers, p.markers)
})
test('first local marker materializes only its target composition and preserves all other timeline data', () => {
  const p = legacyMarkerFixture(), q = run(p, [{ op: 'marker', comp: 'k1', t: 1.019, label: 'Local' }])
  assert.equal(q.comps.k1.markers.length, 1); assert.equal(q.comps.k1.markers[0].t, 1)
  assert.deepEqual(q.comps.k2, p.comps.k2); assert.deepEqual(q.comps.k3, p.comps.k3)
  const withoutMarkers = structuredClone(q.comps.k1); delete withoutMarkers.markers
  assert.deepEqual(withoutMarkers, p.comps.k1)
  assert.deepEqual(q.markers, p.markers); assert.deepEqual(q.tracks, p.tracks)
})
test('nested range and composition settings edits do not create local marker fields', () => {
  const p = legacyMarkerFixture(), q = run(p, [{ op: 'range', comp: 'k1', in: 0, out: 2 }, { op: 'update_comp', target: 'k1', set: { name: 'Renamed local scene' } }])
  assert.equal(Object.hasOwn(q.comps.k1, 'markers'), false)
  assert.deepEqual(q.comps.k2, p.comps.k2); assert.deepEqual(q.comps.k3, p.comps.k3)
  assert.deepEqual(q.markers, p.markers)
})
for (const markers of [[], [{ id: 'm50', t: 1, label: 'Existing local marker' }]]) test(`clip-only edits preserve an existing ${markers.length ? 'populated' : 'empty'} local marker field`, () => {
  const p = legacyMarkerFixture(); p.comps.k1.markers = structuredClone(markers)
  const q = run(p, [{ op: 'update', comp: 'k1', id: 'reused', set: { label: 'Nested changed' } }])
  assert.equal(Object.hasOwn(q.comps.k1, 'markers'), true)
  assert.deepEqual(q.comps.k1.markers, markers)
  assert.deepEqual(q.comps.k2, p.comps.k2); assert.deepEqual(q.comps.k3, p.comps.k3)
})
test('mixed scoped edits retain a materialized empty local field after deleting its last marker', () => {
  const p = legacyMarkerFixture(), q = run(p, [{ op: 'update', comp: 'k1', id: 'reused', set: { label: 'Nested changed' } }, { op: 'marker', comp: null, t: 3, label: 'Root' }, { op: 'marker', comp: 'k1', t: 1, label: 'Local' }, { op: 'delete_marker', comp: 'k1', id: 'm23' }])
  assert.deepEqual(q.comps.k1.markers, [])
  assert.equal(q.comps.k1.tracks[0].clips[0].label, 'Nested changed')
  assert.deepEqual(q.comps.k2, p.comps.k2); assert.deepEqual(q.comps.k3, p.comps.k3)
  assert.deepEqual(q.tracks, p.tracks)
})
