import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const editor = fileURLToPath(new URL('../', import.meta.url))
const sourceDirectory = fs.realpathSync(editor)
const require = createRequire(path.join(editor, 'package.json'))
const { h } = require('preact'), htm = require('htm')
const core = await import(pathToFileURL(path.join(editor, 'core/project.js')))
const assistant = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-state.js')))
const { Icon } = await import(pathToFileURL(path.join(editor, 'web/ui/icons.js')))
const activity = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-activity.js')))
const script = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-script.js')))
const { assistantPanel } = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-panel.js')))
const inertProcess = Object.freeze({ env: Object.freeze({}) })
const forbidden = () => assert.fail('The fixture cannot perform a process, filesystem, provider or network operation.')
const inertFS = new Proxy({}, { get: () => forbidden })
const sideEffects = { process: inertProcess, fs: inertFS, exec: forbidden, execFile: forbidden, spawn: forbidden, fetch: forbidden, WebSocket: forbidden }
const read = file => {
  const captured = fs.realpathSync(path.resolve(editor, file))
  assert.ok(captured.startsWith(sourceDirectory + path.sep), 'Fixture reads stay inside the captured component tree.')
  return fs.readFileSync(captured, 'utf8')
}
const body = file => read(file).replace(/^import .*$/gm, '').replace(/^export \{.*\}\s*$/gm, '').replace(/^export /gm, '')
const makeModule = (file, names, dependencies) => {
  const deps = { ...sideEffects, ...dependencies }
  return new Function('deps', `const {${Object.keys(deps).join(',')}} = deps; ${body(file)}\nreturn {${names}}`)(deps)
}
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...flatten(value.props?.children).flatMap(nodes)] : []
const text = value => flatten(value?.props?.children).map(child => typeof child === 'object' ? text(child) : child).join(' ').replace(/\s+/g, ' ').trim()
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture() {
  const p = core.newProject('Marker context')
  p.markers = [{ id: 'm1', t: 1, label: 'Main' }]
  p.comps = { k1: { id: 'k1', name: 'First', fps: 25, markers: [{ id: 'm2', t: 2, label: 'Nested' }], tracks: [{ id: 'V1', kind: 'video', clips: [] }] }, k2: { id: 'k2', name: 'Second', markers: [], tracks: [{ id: 'V1', kind: 'video', clips: [] }] } }
  return p
}

function controller() {
  let backend = fixture(), version = 3
  const calls = []
  const api = async (route, request) => {
    calls.push({ route, request: structuredClone(request) })
    if (route === '/api/ops') { backend = core.applyOps(backend, request.ops).project; return { project: backend, version: ++version } }
    return { project: backend, version }
  }
  const state = makeModule('web/ui/store.js', 'store,set,edit,addRef,viewProject,time,toast', { ...core, useEffect() {}, useReducer: () => [0, () => {}], api, host: {}, changeReceipt() {}, innerWidth: 1280, setTimeout() {} })
  state.set({ project: backend, version, root: '/owned/fixture', openComp: null, selection: [], selMarker: null, refs: [], toasts: [], zoom: 80, scroll: 0, highlight: new Map(), trackHeight: {}, settingsOpen: false })
  return { ...state, calls }
}

for (const [before, after, marker] of [[null, 'k1', 'm1'], ['k1', null, 'm2'], ['k1', 'k2', 'm2']]) {
  test(`composition navigation clears marker selection from ${before} to ${after}`, () => {
    const f = controller(); f.set({ openComp: before }); f.set({ selMarker: marker }); f.set({ openComp: after, selection: [] })
    assert.equal(f.store.selMarker, null)
    assert.equal(f.store.openComp, after)
  })
}
test('functional store navigation also clears stale marker selection', () => {
  const f = controller(); f.set({ selMarker: 'm1' }); f.set(s => ({ openComp: 'k1', selection: s.selection }))
  assert.equal(f.store.selMarker, null)
})
test('updates within the same composition retain its selected marker', () => {
  const f = controller(); f.set({ openComp: 'k1' }); f.set({ selMarker: 'm2' }); f.set({ openComp: 'k1', zoom: 90 })
  assert.equal(f.store.selMarker, 'm2')
})
test('marker attachments capture composition and project version at attachment', () => {
  const f = controller(); f.set({ openComp: 'k1' }); f.addRef({ kind: 'marker', id: 'm2', label: 'Nested' })
  assert.deepEqual(f.store.refs[0], { kind: 'marker', id: 'm2', label: 'Nested', comp: 'k1', context: { projectRoot: '/owned/fixture', projectVersion: 3 } })
  f.set({ openComp: null })
  assert.equal(f.store.refs[0].comp, 'k1')
})
test('explicit captured marker attachment context survives a later composition switch', () => {
  const f = controller(); f.set({ openComp: 'k2', version: 4 })
  f.addRef({ kind: 'marker', id: 'm2', label: 'Nested', comp: 'k1', context: { projectRoot: '/owned/fixture', projectVersion: 3 } })
  assert.equal(f.store.refs[0].comp, 'k1'); assert.equal(f.store.refs[0].context.projectVersion, 3)
})
test('prompt references are a snapshot of the attached marker context', () => {
  const f = controller(); f.set({ openComp: 'k1' }); f.addRef({ kind: 'marker', id: 'm2', label: 'Nested' })
  const request = assistant.assistantPrompt('Review', f.store, 2)
  f.store.refs[0].label = 'Changed'; f.store.refs[0].comp = 'k2'; f.store.selection.push('c9')
  assert.equal(request.comp, 'k1'); assert.equal(request.refs[0].label, 'Nested'); assert.equal(request.refs[0].comp, 'k1'); assert.deepEqual(request.ids, [])
})
test('stale marker references require a new attachment before prompting', () => {
  const f = controller(); f.addRef({ kind: 'marker', id: 'm1', label: 'Main' }); f.set({ version: 4 })
  assert.throws(() => assistant.assistantPrompt('Review', f.store, 0), /project changed/i)
})

function ui(f, overrides = {}) {
  const edits = [], refs = [], slots = []; let index = 0
  const deps = { ...core, ...f, h, htm, useStore: () => f.store, useTime: () => 0, useEffect() {}, useLayoutEffect() {}, useRef: value => slots[index++] ??= { current: value }, useState: value => [value, () => {}], onTime: () => () => {}, subscribe: () => () => {}, edit: (...args) => edits.push(structuredClone(args)), addRef: ref => refs.push(structuredClone(ref)), openMenu() {}, player: { seek() {} }, registry: { clipMenus: [] }, devicePixelRatio: 1, ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame() {}, prompt: () => 'Renamed', ShapeAppearance() {}, ScrollTabs() {} }
  Object.assign(deps, overrides)
  const timeline = makeModule('web/ui/timeline.js', 'clipMenu,Timeline', deps)
  const inspector = makeModule('web/ui/inspector.js', 'MarkerInspector', deps)
  return { edits, refs, slots, timeline, inspector, render() { index = 0; return timeline.Timeline() } }
}
test('delayed marker menu rename and delete retain their original scope and version', () => {
  const f = controller(); f.set({ openComp: 'k1' }); const u = ui(f), p = f.viewProject(), menu = u.timeline.clipMenu(p, { marker: p.markers[0] }, 2)
  f.set({ openComp: null, version: 4 })
  menu.find(item => item.label === 'Rename…').run(); menu.find(item => item.label === 'Delete marker').run()
  for (const [op, , options] of u.edits) { assert.equal(op.comp, 'k1'); assert.equal(options.expectedVersion, 3) }
})
test('delayed empty-ruler menu adds a marker in its captured main timeline', () => {
  const f = controller(), u = ui(f), menu = u.timeline.clipMenu(f.viewProject(), {}, 1)
  f.set({ openComp: 'k1' }); menu.find(item => item.label === 'Add marker here').run()
  assert.equal(u.edits[0][0].comp, null); assert.equal(u.edits[0][2].expectedVersion, 3)
})
test('marker menu references retain captured composition and version', () => {
  const f = controller(); f.set({ openComp: 'k1' }); const u = ui(f), p = f.viewProject(), menu = u.timeline.clipMenu(p, { marker: p.markers[0] }, 2)
  f.set({ openComp: null, version: 4 }); menu.find(item => item.label.includes('Reference marker')).run()
  assert.equal(u.refs[0].comp, 'k1'); assert.deepEqual(u.refs[0].context, { projectRoot: '/owned/fixture', projectVersion: 3 })
})
test('rendered marker inspector callbacks retain composition and expected version', () => {
  const f = controller(); f.set({ openComp: 'k1' }); const u = ui(f), tree = u.inspector.MarkerInspector({ m: f.viewProject().markers[0] })
  const controls = nodes(tree).filter(node => node.props?.onChange)
  assert.equal(controls.length, 4)
  f.set({ openComp: null, version: 4 })
  controls.forEach(node => node.props.onChange({ target: { value: 'Captured' } })); nodes(tree).find(node => text(node) === 'Delete' && node.type === 'button').props.onClick()
  assert.equal(u.edits.length, 5)
  for (const [op, , options] of u.edits) { assert.equal(op.comp, 'k1'); assert.equal(options.expectedVersion, 3) }
  nodes(tree).find(node => text(node).includes('Reference') && node.type === 'button').props.onClick()
  assert.equal(u.refs[0].comp, 'k1'); assert.equal(u.refs[0].context.projectVersion, 3)
})
test('marker pointer drag commits with its captured composition and version', () => {
  const f = controller(); f.set({ openComp: 'k1' }); const u = ui(f), tree = u.render(), canvasNode = nodes(tree).find(node => node.type === 'canvas')
  canvasNode.ref.current = { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {} }
  const state = u.slots.find(slot => slot.current && typeof slot.current.scrollY === 'number').current
  canvasNode.props.onPointerDown({ button: 0, pointerId: 1, clientX: 160, clientY: 20 })
  assert.equal(state.drag.kind, 'marker'); state.drag.to = 2.4
  canvasNode.props.onPointerUp()
  assert.equal(u.edits[0][0][0].comp, 'k1'); assert.equal(u.edits[0][2].expectedVersion, 3)
})
test('delayed marker menus reject a different project with the same version', () => {
  const f = controller(); f.set({ openComp: 'k1' }); const u = ui(f), p = f.viewProject(), menu = u.timeline.clipMenu(p, { marker: p.markers[0] }, 2)
  f.set({ root: '/another/project' }); menu.find(item => item.label === 'Delete marker').run()
  assert.deepEqual(u.edits, [])
})
test('retained marker inspector callbacks reject a different project with the same version', () => {
  const f = controller(); f.set({ openComp: 'k1' }); const u = ui(f), tree = u.inspector.MarkerInspector({ m: f.viewProject().markers[0] })
  f.set({ root: '/another/project' }); nodes(tree).find(node => node.props?.onChange).props.onChange({ target: { value: 'Wrong project' } })
  nodes(tree).find(node => text(node) === 'Delete' && node.type === 'button').props.onClick()
  assert.deepEqual(u.edits, [])
})
test('stale captured marker edit is rejected by the actual optimistic store', async () => {
  const f = controller(), before = structuredClone(f.store.project); f.set({ openComp: 'k1', version: 4 })
  assert.equal(await f.edit({ op: 'update_marker', comp: 'k1', id: 'm2', set: { label: 'Old' } }, undefined, { expectedVersion: 3 }), null)
  assert.deepEqual(f.store.project, before); assert.deepEqual(f.calls, [])
})
for (const drift of ['root', 'version']) test(`rejected retained marker Delete preserves current selection after ${drift} drift`, async () => {
  const f = controller(); f.set({ openComp: 'k1' }); f.set({ selMarker: 'm2' }); const u = ui(f, { edit: f.edit }), tree = u.inspector.MarkerInspector({ m: f.viewProject().markers[0] }), before = structuredClone(f.store.project)
  if (drift === 'root') { f.set({ root: '/replacement', openComp: null }); f.set({ selMarker: 'm1' }) } else f.set({ version: 4 })
  const selected = f.store.selMarker
  await nodes(tree).find(node => text(node) === 'Delete' && node.type === 'button').props.onClick()
  assert.equal(f.store.selMarker, selected); assert.deepEqual(f.store.project, before); assert.deepEqual(f.calls, [])
})
test('successful retained marker Delete preserves a newer selection', async () => {
  const f = controller(); f.set({ openComp: 'k1' }); f.set({ selMarker: 'm2' }); const u = ui(f, { edit: f.edit }), tree = u.inspector.MarkerInspector({ m: f.viewProject().markers[0] })
  const pending = nodes(tree).find(node => text(node) === 'Delete' && node.type === 'button').props.onClick()
  f.set({ openComp: null }); f.set({ selMarker: 'm1' }); await pending
  assert.equal(f.store.selMarker, 'm1'); assert.deepEqual(f.store.project.comps.k1.markers, []); assert.deepEqual(f.store.project.markers, fixture().markers)
})
test('successful current marker Delete clears only its own selection', async () => {
  const f = controller(); f.set({ openComp: 'k1' }); f.set({ selMarker: 'm2' }); const u = ui(f, { edit: f.edit }), tree = u.inspector.MarkerInspector({ m: f.viewProject().markers[0] })
  await nodes(tree).find(node => text(node) === 'Delete' && node.type === 'button').props.onClick()
  assert.equal(f.store.selMarker, null); assert.deepEqual(f.store.project.comps.k1.markers, []); assert.equal(f.calls.length, 1)
})

function chatFixture({ submission } = {}) {
  const f = controller(); f.set({ openComp: 'k1', selection: ['c2'], chat: [], activity: [], receipts: [], jobs: [], caps: {}, connected: true, assistantStatus: { provider: 'codex', configured: true }, claude: { state: 'idle' } }); f.time.t = 2
  f.addRef({ kind: 'marker', id: 'm2', label: 'Nested' })
  f.set({ assistantDraft: { root: f.store.root, text: 'Review this marker', inputKind: 'screenplay' } })
  const gate = deferred(), values = [], refs = [], calls = [], errors = [], gateCalls = []
  let vi = 0, ri = 0
  const deps = { Icon, assistantPanel, h, htm, useEffect() {}, useRef: value => refs[ri++] ??= { current: value }, useState: value => { const i = vi++; values[i] ??= value; return [values[i], next => { values[i] = next }] }, useStore: () => f.store, useTime: () => f.time.t, ...assistant, ...activity, ...script, refreshAssistantStatus() {}, api: async (route, request) => { calls.push({ route, request: structuredClone(request) }); return submission ? submission.promise : { queued: 'offline-fixture' } }, set: f.set, store: f.store, time: f.time, toast: message => errors.push(message), receiptSelection() {}, player: {}, AssistantControls() {}, RoutingReceipt() {}, createAssistantSharingGate: () => ({ request: () => { gateCalls.push('request'); return gate.promise }, cancel() {}, dispose() {} }) }
  const module = makeModule('web/ui/chat.js', 'ChatPanel', deps)
  const render = () => { vi = 0; ri = 0; return module.ChatPanel() }
  const tree = render()
  return { ...f, gate, gateCalls, calls, errors, values, render, draft: () => f.store.assistantDraft.text, send: () => nodes(tree).find(node => node.props?.['aria-label'] === 'Send message').props.onClick() }
}
test('same-context sharing wait preserves captured prompt composition, selection, playhead and references', async () => {
  const f = chatFixture(), pending = f.send(); await settle(); f.set({ selection: ['c1'] }); f.time.t = 8; f.store.refs[0].label = 'Later draft'
  f.gate.resolve({ valid: () => true, sharing: {} }); await pending
  assert.equal(f.calls.length, 1); const request = f.calls[0].request
  assert.equal(request.inputKind, 'screenplay'); assert.equal(request.comp, 'k1'); assert.deepEqual(request.ids, ['c2']); assert.equal(request.playhead, 2); assert.equal(request.refs[0].label, 'Nested'); assert.equal(request.refs[0].comp, 'k1')
  assert.equal(f.store.refs.length, 1); assert.equal(f.store.refs[0].label, 'Later draft')
})
test('successful captured prompt preserves a new attachment for the next draft', async () => {
  const f = chatFixture(), pending = f.send(); await settle(); f.addRef({ kind: 'marker', id: 'm1', label: 'Next Main draft', comp: null })
  const next = f.store.refs.at(-1); f.gate.resolve({ valid: () => true, sharing: {} }); await pending
  assert.deepEqual(f.calls[0].request.refs.map(ref => ref.id), ['m2']); assert.deepEqual(f.store.refs, [next]); assert.equal(next.comp, null)
})
test('successful captured prompt preserves a replacement attachment with identical content', async () => {
  const f = chatFixture(), pending = f.send(); await settle(); const previous = f.store.refs[0]; f.addRef({ kind: 'marker', id: 'm2', label: 'Nested' }); const replacement = f.store.refs[0]
  assert.notEqual(replacement, previous); f.gate.resolve({ valid: () => true, sharing: {} }); await pending
  assert.deepEqual(f.store.refs, [replacement]); assert.deepEqual(f.calls[0].request.refs, [replacement])
})
test('successful captured prompt consumes unchanged original references', async () => {
  const f = chatFixture(), pending = f.send(); await settle(); f.gate.resolve({ valid: () => true, sharing: {} }); await pending
  assert.equal(f.calls.length, 1); assert.deepEqual(f.store.refs, [])
})
for (const patch of [{ version: 4 }, { root: '/another/project' }]) test(`sharing wait refuses changed project context ${JSON.stringify(patch)}`, async () => {
  const f = chatFixture(), pending = f.send(); await settle(); f.set(patch); f.gate.resolve({ valid: () => true, sharing: {} }); await pending
  assert.deepEqual(f.calls, []); assert.deepEqual(f.errors, []); assert.equal(f.draft(), 'Review this marker'); assert.equal(f.store.refs.length, 1)
})

// Root retains cancellation on composition or draft drift during sharing.
for (const patch of [{ openComp: null }, { openComp: 'k2' }]) test(`composition navigation cancels captured sharing request ${JSON.stringify(patch)}`, async () => {
  const f = chatFixture(), originalDraft = f.store.assistantDraft, originalRefs = f.store.refs, pending = f.send()
  await settle(); f.set(patch); f.gate.resolve({ valid: () => true, sharing: {} }); await pending
  assert.deepEqual(f.calls, []); assert.equal(f.store.assistantDraft, originalDraft); assert.equal(f.store.refs, originalRefs); assert.deepEqual(f.errors, [])
})
for (const edit of ['text', 'kind']) test(`actual ${edit} control change cancels admission during sharing and preserves the new draft`, async () => {
  const f = chatFixture(), pending = f.send(); await settle(); const tree = f.render()
  if (edit === 'text') nodes(tree).find(node => node.type === 'textarea').props.onInput({ target: { value: 'Next draft' } })
  else nodes(tree).find(node => node.props?.['aria-label'] === 'Assistant input kind').props.onChange({ target: { value: 'script' } })
  const currentDraft = f.store.assistantDraft, refs = f.store.refs
  f.gate.resolve({ valid: () => true, sharing: {} }); await pending
  assert.deepEqual(f.calls, []); assert.equal(f.store.assistantDraft, currentDraft); assert.equal(f.store.refs, refs)
  assert.equal(currentDraft.text, edit === 'text' ? 'Next draft' : 'Review this marker'); assert.equal(currentDraft.inputKind, edit === 'kind' ? 'script' : 'screenplay')
})
test('same-root project replacement cancels sharing admission without clearing a captured draft or reference', async () => {
  const f = chatFixture(), draft = f.store.assistantDraft, refs = f.store.refs, pending = f.send()
  await settle(); f.set({ project: structuredClone(f.store.project) }); f.gate.resolve({ valid: () => true, sharing: {} }); await pending
  assert.deepEqual(f.calls, []); assert.equal(f.store.assistantDraft, draft); assert.equal(f.store.refs, refs)
})
test('a stale marker is refused before any sharing review or admission request', async () => {
  const f = chatFixture(); f.set({ version: 4 }); const tree = f.render()
  const pending = nodes(tree).find(node => node.props?.['aria-label'] === 'Send message').props.onClick()
  f.gate.resolve({ valid: () => true, sharing: {} }); await pending
  assert.deepEqual(f.gateCalls, []); assert.deepEqual(f.calls, []); assert.match(f.errors.at(-1), /marker was attached/); assert.equal(f.store.refs.length, 1); assert.equal(f.draft(), 'Review this marker')
})
for (const mutation of ['reference object', 'new attachment', 'replacement attachment']) test(`late successful admission preserves ${mutation} by identity and content`, async () => {
  const submission = deferred(), f = chatFixture({ submission }), pending = f.send(); f.gate.resolve({ valid: () => true, sharing: {} }); await settle()
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].request.inputKind, 'screenplay'); assert.equal(f.calls[0].request.refs[0].label, 'Nested')
  if (mutation === 'reference object') f.store.refs[0].label = 'Retained next label'
  if (mutation === 'new attachment') f.addRef({ kind: 'marker', id: 'm1', comp: null, label: 'Retained next marker' })
  if (mutation === 'replacement attachment') f.addRef({ kind: 'marker', id: 'm2', label: 'Nested' })
  const retained = f.store.refs.at(-1); submission.resolve({ queued: 'offline-fixture' }); await pending
  assert.deepEqual(f.store.refs, [retained]); assert.equal(f.draft(), ''); assert.equal(f.calls[0].request.refs[0].label, 'Nested')
})
for (const drift of ['draft', 'root', 'version', 'composition']) test(`late admitted response retains newer local state after ${drift} drift`, async () => {
  const submission = deferred(), f = chatFixture({ submission }), pending = f.send(); f.gate.resolve({ valid: () => true, sharing: {} }); await settle()
  assert.equal(f.calls.length, 1)
  if (drift === 'draft') nodes(f.render()).find(node => node.type === 'textarea').props.onInput({ target: { value: 'New draft after dispatch' } })
  if (drift === 'root') f.set({ root: '/new-project', assistantDraft: { root: '/new-project', text: 'Other project draft', inputKind: 'script' }, refs: [{ kind: 'clip', id: 'new', label: 'Other project reference' }] })
  if (drift === 'version') f.set({ version: 4 })
  if (drift === 'composition') f.set({ openComp: 'k2' })
  const draft = f.store.assistantDraft, refs = f.store.refs; submission.resolve({ queued: 'offline-fixture' }); await pending
  assert.equal(f.store.assistantDraft, draft); assert.equal(f.store.refs, refs); assert.equal(f.calls[0].request.comp, 'k1'); assert.equal(f.calls[0].request.inputKind, 'screenplay')
})
test('marker and motion context validation remains beside inputKind validation', () => {
  const f = controller(); f.set({ refs: [{ kind: 'motion', context: { projectRoot: '/old', projectVersion: 3 } }] })
  assert.throws(() => assistant.assistantPrompt('Review', f.store, 0, 'script'), /motion request/)
  f.set({ refs: [{ kind: 'marker', context: { projectRoot: '/old', projectVersion: 3 } }] })
  assert.throws(() => assistant.assistantPrompt('Review', f.store, 0, 'screenplay'), /marker was attached/)
  assert.throws(() => assistant.assistantPrompt('Review', f.store, 0, 'wrong'), /Choose Prompt/)
})
