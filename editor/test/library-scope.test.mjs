import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'

const editor = new URL('../', import.meta.url)
registerHooks({ resolve(spec, ctx, next) { return next(spec.startsWith('/core/') ? new URL(`.${spec}`, editor).href : spec, ctx) } })
const { applyOps, compView, newProject } = await import('../core/project.js')
const { prepareLibraryOps } = await import('../core/library-resources.js')
const { libraryCompatibility, describeLibraryItem, libraryPlacesObject } = await import('../core/library.js')
const { selectedLibraryClip, librarySaveChoices, captureLibrarySource, librarySourceStatus, libraryApplyPlan, libraryItemFacts } = await import('../web/ui/library/model.js')
const run = (p, ops) => applyOps(p, ops).project
const clips = p => p.tracks.flatMap(t => t.clips)
const title = (id, text, start = 0) => ({ id, kind: 'title', start, dur: 4, title: { text, font: 'Inter', size: 96, anim: 'none' }, label: text })
function scene() {
  const p = newProject('Scoped reusable design', { width: 640, height: 360, fps: 30 })
  p.comps ??= {}
  p.tracks.find(t => t.kind === 'video').clips = [title('same', 'Main heading')]
  p.comps.k1 = { id: 'k1', name: 'Nested title', width: 320, height: 180, fps: 24, duration: 8, tracks: [{ id: 'V1', kind: 'video', clips: [title('same', 'Nested heading')] }] }
  p.comps.k2 = { id: 'k2', name: 'Other', width: 640, height: 360, fps: 30, duration: 8, tracks: [{ id: 'V1', kind: 'video', clips: [] }] }
  return p
}
const scope = (composition = 'k1') => ({ root: '/fixture', version: 7, selection: ['same'], composition })
const save = (p, composition, source = 'same', category = 'title') => run(p, [{ op: 'library_save', comp: composition, category, name: 'Saved design', source: { clip: source } }])
function incomingScene() {
  const p = scene()
  for (const [timeline, name] of [[p, 'Main'], [p.comps.k1, 'Nested']]) timeline.tracks.find(t => t.kind === 'video').clips = [title(`before${name}`, `${name} before`), title('same', `${name} after`, 4)]
  return run(p, [{ op: 'library_register', item: { name: 'Reusable cut', category: 'transition', body: { settings: { transitionIn: { type: 'wipeLeft', dur: 0.5 } } } } }])
}
function authoredScene() {
  const p = scene()
  p.comps.k3 = { id: 'k3', name: 'Main overlay', width: 640, height: 360, fps: 30, duration: 1, tracks: [{ id: 'V1', kind: 'video', clips: [{ ...title('mainOverlay', 'Main transition'), dur: 1 }] }] }
  p.comps.k4 = { id: 'k4', name: 'Nested overlay', width: 320, height: 180, fps: 24, duration: 1, tracks: [{ id: 'V1', kind: 'video', clips: [{ ...title('nestedOverlay', 'Nested transition'), dur: 1, anim: { opacity: [[0, 0], [0.5, 1], [1, 0]] } }] }] }
  p.tracks.find(t => t.kind === 'video').clips = [{ id: 'same', kind: 'comp', comp: 'k3', start: 0, in: 0, dur: 1, label: 'Main wrapper' }]
  p.comps.k1.tracks[0].clips = [{ id: 'same', kind: 'comp', comp: 'k4', start: 0, in: 0, dur: 1, label: 'Nested wrapper', x: 50, y: 60, note: 'figma source overlay' }]
  return p
}

test('browser save choices and source capture resolve the selected open composition', () => {
  const p = scene(), choice = librarySaveChoices(p, ['same'], 'k1').find(c => c.category === 'title' && c.source.clip)
  assert.equal(choice.name, 'Nested heading')
  assert.equal(selectedLibraryClip(p, ['same'], 'k1').title.text, 'Nested heading')
  assert.equal(captureLibrarySource(p, choice, scope()).clip.title.text, 'Nested heading')
})
test('browser source fingerprint follows the nested source instead of the root collision', () => {
  const p = scene(), choice = librarySaveChoices(p, ['same'], 'k1').find(c => c.category === 'title' && c.source.clip), capture = captureLibrarySource(p, choice, scope())
  const nestedEdit = structuredClone(p); nestedEdit.comps.k1.tracks[0].clips[0].title.text = 'Changed nested heading'
  assert.equal(librarySourceStatus(nestedEdit, capture, scope()).ok, false)
  const mainEdit = structuredClone(p); clips(mainEdit)[0].title.text = 'Unrelated main edit'
  assert.equal(librarySourceStatus(mainEdit, capture, scope()).ok, true)
  assert.equal(librarySourceStatus(p, capture, { ...scope(), version: 8 }).ok, false)
  assert.equal(librarySourceStatus(p, capture, { ...scope(), root: '/other' }).ok, false)
  assert.equal(librarySourceStatus(p, capture, { ...scope(), composition: null }).ok, false)
})
test('core saves a nested custom title from an explicit native/browser composition request', () => {
  const p = scene(), before = structuredClone(p), next = save(p, 'k1')
  assert.equal(next.library.items[0].body.clip.title.text, 'Nested heading')
  assert.deepEqual(next.tracks, before.tracks); assert.deepEqual(next.comps, before.comps); assert.deepEqual(p, before)
})
test('explicit main scope keeps the main title and refuses a nested-only ID', () => {
  const p = scene()
  assert.equal(save(p, null).library.items[0].body.clip.title.text, 'Main heading')
  p.comps.k1.tracks[0].clips[0].id = 'nestedOnly'
  assert.throws(() => save(p, null, 'nestedOnly'), /source|scope|composition/i)
})
test('core refuses a source from another explicit composition without mutating the project', () => {
  const p = scene(), before = structuredClone(p)
  assert.throws(() => save(p, 'k2'), /source|scope|composition/i)
  assert.deepEqual(p, before)
})
test('unscoped legacy requests retain unique nested sources and reject ambiguous IDs', () => {
  const p = scene()
  assert.throws(() => run(p, [{ op: 'library_save', category: 'title', name: 'Ambiguous', source: { clip: 'same' } }]), /ambiguous/i)
  p.comps.k1.tracks[0].clips[0].id = 'uniqueNested'
  const next = run(p, [{ op: 'library_save', category: 'title', name: 'Legacy', source: { clip: 'uniqueNested' } }])
  assert.equal(next.library.items[0].body.clip.title.text, 'Nested heading')
})
test('browser refuses absent, foreign, multiple or ambiguous active selections', () => {
  const p = scene()
  assert.deepEqual(librarySaveChoices(p, ['same'], 'missing'), [])
  assert.deepEqual(librarySaveChoices(p, ['same'], 'k2'), [])
  assert.deepEqual(librarySaveChoices(p, ['same', 'foreign'], 'k1'), [])
  assert.throws(() => captureLibrarySource(p, { category: 'title', source: { clip: 'same' } }, scope('k2')), /source|scope|composition/i)
  p.comps.k1.tracks.push({ id: 'V2', kind: 'video', clips: [title('same', 'Ambiguous local title')] })
  assert.deepEqual(librarySaveChoices(p, ['same'], 'k1'), [])
  assert.throws(() => save(p, 'k1'), /ambiguous/i)
})
test('an open composition without a selected clip remains an intentional reusable source', () => {
  const p = scene(), choice = librarySaveChoices(p, [], 'k1').find(c => c.category === 'title')
  assert.deepEqual(choice.source, { composition: 'k1' })
  const next = run(p, [{ op: 'library_save', category: 'title', name: 'Whole title', source: choice.source, comp: 'k1' }])
  assert.equal(next.library.items[0].body.comps.k1.tracks[0].clips[0].title.text, 'Nested heading')
})
test('authored transition wrapper saves the selected nested composition and editable animation', () => {
  const p = authoredScene(), next = save(p, 'k1', 'same', 'transition'), body = next.library.items[0].body
  assert.equal(body.clip.comp, 'k4'); assert.equal(body.clip.note, 'figma source overlay')
  assert.deepEqual(Object.keys(body.comps), ['k4']); assert.equal(body.comps.k4.tracks[0].clips[0].title.text, 'Nested transition')
  assert.deepEqual(body.comps.k4.tracks[0].clips[0].anim.opacity, [[0, 0], [0.5, 1], [1, 0]])
})
test('core applies a saved incoming transition only to the explicitly scoped nested cut', () => {
  const p = incomingScene(), item = p.library.items[0], next = run(p, [{ op: 'library_apply', item: item.id, id: 'same', comp: 'k1' }])
  assert.deepEqual(next.tracks, p.tracks)
  assert.deepEqual(next.comps.k1.tracks[0].clips[1].transitionIn, { type: 'wipeLeft', dur: 0.5 })
  assert.deepEqual(p.comps.k1.tracks[0].clips[1].transitionIn, undefined)
})
test('browser apply plan names the nested destination and avoids another scope compatibility state', () => {
  const p = incomingScene(), item = p.library.items[0]
  clips(p).find(c => c.id === 'same').transitionIn = { type: 'dipBlack', dur: 0.2 }
  const plan = libraryApplyPlan(p, item, ['tr:same'], { comp: 'k1' })
  assert.equal(plan.ok, true); assert.equal(plan.ops[0].comp, 'k1')
  const next = run(p, plan.ops)
  assert.deepEqual(next.tracks, p.tracks); assert.equal(next.comps.k1.tracks[0].clips[1].transitionIn.type, 'wipeLeft')
})
test('target locking is read from the intended composition and rejected before any edit', () => {
  const p = incomingScene(), item = p.library.items[0]
  p.tracks.find(t => t.kind === 'video').locked = true
  assert.equal(libraryApplyPlan(p, item, ['same'], { comp: 'k1' }).ok, true)
  p.tracks.find(t => t.kind === 'video').locked = false; p.comps.k1.tracks[0].locked = true
  assert.equal(libraryApplyPlan(p, item, ['same'], { comp: 'k1' }).ok, false)
  assert.throws(() => run(p, [{ op: 'library_apply', item: item.id, id: 'same', comp: 'k1' }]), /locked/i)
})
test('main, missing-scope and foreign-target apply plans cannot silently borrow a nested clip', () => {
  const p = incomingScene(), item = p.library.items[0]
  assert.equal(libraryApplyPlan(p, item, ['same'], { comp: null }).ops[0].comp, null)
  assert.equal(libraryApplyPlan(p, item, ['same'], { comp: 'missing' }).ok, false)
  assert.equal(libraryApplyPlan(p, item, ['same'], { comp: 'k2' }).ok, false)
  assert.equal(libraryCompatibility(p, item, 'same').ok, false)
  assert.equal(libraryCompatibility(p, item, 'same', 'k1').ok, true)
})
test('unique legacy transition apply remains usable without an explicit composition', () => {
  const p = incomingScene(), item = p.library.items[0]; p.comps.k1.tracks[0].clips[1].id = 'uniqueNested'
  const next = run(p, [{ op: 'library_apply', item: item.id, id: 'uniqueNested' }])
  assert.deepEqual(next.tracks, p.tracks); assert.equal(next.comps.k1.tracks[0].clips[1].transitionIn.type, 'wipeLeft')
})
test('a project-shaped view does not count its aliased active track twice', () => {
  const p = incomingScene(), item = p.library.items[0], view = compView(p, 'k1')
  assert.equal(libraryCompatibility(view, item, 'same').ok, true)
})
test('placed scoped title copies stay independent and retain the captured typography', () => {
  const p = save(scene(), 'k1'), item = p.library.items[0], plan = libraryApplyPlan(p, item, [], { start: 5, comp: 'k2' }), next = run(p, plan.ops)
  const placed = next.comps.k2.tracks.flatMap(t => t.clips)[0]
  assert.equal(placed.title.text, 'Nested heading'); assert.notEqual(placed.id, 'same')
  const edited = run(next, [{ op: 'update', id: placed.id, comp: 'k2', set: { title: { text: 'Independent copy' } } }])
  assert.equal(edited.comps.k1.tracks[0].clips[0].title.text, 'Nested heading'); assert.equal(edited.library.items[0].body.clip.title.text, 'Nested heading')
})
test('authored reusable transition applies an editable overlay at the selected nested cut', () => {
  const saved = save(authoredScene(), 'k1', 'same', 'transition').library.items[0], { id: _old, ...registration } = saved
  const p = run(incomingScene(), [{ op: 'library_register', item: registration }]), item = p.library.items.at(-1), before = structuredClone(p)
  const plan = libraryApplyPlan(p, item, ['same'], { comp: 'k1' }); assert.equal(plan.ok, true)
  const next = run(p, plan.ops), overlay = next.comps.k1.tracks.slice(1).flatMap(t => t.clips).find(c => c.kind === 'comp')
  assert.equal(overlay.start, 3.5); assert.equal(overlay.dur, 1); assert.equal(overlay.note, 'figma source overlay')
  const editable = next.comps[overlay.comp].tracks[0].clips[0]
  assert.equal(editable.title.text, 'Nested transition'); assert.deepEqual(editable.anim.opacity, [[0, 0], [0.5, 1], [1, 0]])
  assert.deepEqual(next.tracks, before.tracks); assert.deepEqual(next.library, before.library); assert.deepEqual(p, before)
})

const plugin = await readFile(new URL('../web/ui/plugins/library.js', import.meta.url), 'utf8')
const between = (first, next) => { const a = plugin.indexOf(first), b = plugin.indexOf(next, a); assert.ok(a >= 0 && b > a); return plugin.slice(a, b).replace('export ', '') }
function saveController(project, composition) {
  const store = { project, root: '/fixture', version: 7, selection: ['same'], openComp: composition }
  const state = [], refs = []; let cursor = 0, refCursor = 0
  const calls = [], notices = []
  // The save form refuses to open or submit while another edit is pending or recovering.
  const recovery = { pending: false, reason: null }
  const useState = value => { const i = cursor++; if (!(i in state)) state[i] = value; return [state[i], v => { state[i] = v }] }
  const useRef = value => { const i = refCursor++; return refs[i] ??= { current: value } }
  const edit = async (op, _summary, options) => { calls.push({ op: Array.isArray(op) ? op[0] : op, options }); store.project = run(store.project, Array.isArray(op) ? op : [op]); return { project: store.project, version: store.version + 1 } }
  const component = new Function('useStore', 'useState', 'useRef', 'useEffect', 'librarySaveChoices', 'librarySourceStatus', 'captureLibrarySource', 'store', 'api', 'prepareLibraryOps', 'edit', 'toast', 'labelFor', 'html', 'hasPendingEdits', 'editRecoveryStatus', 'retryEditRecovery', `${between('export function SaveLibrarySelection(', 'export function LibraryItem(')}; return SaveLibrarySelection`)(() => store, useState, useRef, () => {}, librarySaveChoices, librarySourceStatus, captureLibrarySource, store, () => { throw new Error('Unexpected LUT inspection') }, prepareLibraryOps, edit, (...v) => notices.push(v), c => c, htm.bind(h), () => recovery.pending, () => (recovery.pending ? { reason: recovery.reason } : null), () => {})
  const render = () => { cursor = 0; refCursor = 0; return component({ category: 'title' }) }
  function find(tree, predicate) { if (!tree || typeof tree !== 'object') return null; if (predicate(tree)) return tree; for (const child of [tree.props?.children].flat(Infinity)) { const found = find(child, predicate); if (found) return found } return null }
  return { store, calls, notices, render, find, recovery }
}
test('actual Save component callback submits an explicit nested source and expected version', async () => {
  const c = saveController(scene(), 'k1')
  c.find(c.render(), node => node.type === 'button' && node.props.onClick).props.onClick()
  const form = c.find(c.render(), node => node.type === 'form')
  await form.props.onSubmit({ preventDefault() {} })
  assert.equal(c.calls.length, 1); assert.equal(c.calls[0].op.comp, 'k1'); assert.equal(c.calls[0].options.expectedVersion, 7)
  assert.equal(c.store.project.library.items[0].body.clip.title.text, 'Nested heading')
})
test('actual Save component callback makes main scope explicit and rejects a stale open form', async () => {
  const c = saveController(scene(), null)
  c.find(c.render(), node => node.type === 'button' && node.props.onClick).props.onClick()
  const form = c.find(c.render(), node => node.type === 'form')
  await form.props.onSubmit({ preventDefault() {} }); assert.equal(c.calls[0].op.comp, null)
  const stale = saveController(scene(), 'k1')
  stale.find(stale.render(), node => node.type === 'button' && node.props.onClick).props.onClick()
  const oldForm = stale.find(stale.render(), node => node.type === 'form'); stale.store.openComp = 'k2'
  await oldForm.props.onSubmit({ preventDefault() {} }); assert.equal(stale.calls.length, 0)
})
test('actual Save component callback waits for a pending edit before opening or saving', async () => {
  const c = saveController(scene(), 'k1')
  const text = node => [node?.props?.children].flat(Infinity).map(child => typeof child === 'object' ? text(child) : child ?? '').join('')
  c.recovery.pending = true; c.recovery.reason = 'Arya is recovering the last edit.'
  const start = () => c.find(c.render(), node => node.type === 'button' && node.props.onClick)
  start()?.props.onClick()
  assert.equal(c.find(c.render(), node => node.type === 'form'), null, 'the form stays closed while an edit is pending')
  c.recovery.pending = false
  start().props.onClick()
  const form = c.find(c.render(), node => node.type === 'form')
  assert.ok(form, 'the form opens once the edit settles')
  c.recovery.pending = true
  await form.props.onSubmit({ preventDefault() {} })
  assert.equal(c.calls.length, 0, 'no save is dispatched while an edit is pending')
  assert.match(text(c.render()), /Arya is recovering the last edit\./)
})
function applyController(project, composition) {
  const store = { project, root: '/fixture', version: 7, selection: ['same'], openComp: composition }, calls = [], notices = []
  const item = project.library.items[0]
  const edit = async (ops, _summary, options) => { calls.push({ ops, options }); const result = applyOps(store.project, ops); store.project = result.project; return result }
  const component = new Function('useStore', 'useState', 'useRef', 'useEffect', 'libraryItemFacts', 'libraryApplyPlan', 'describeLibraryItem', 'libraryPlacesObject', 'store', 'time', 'api', 'prepareLibraryOps', 'edit', 'set', 'toast', 'labelFor', 'html', `${between('export function LibraryItem(', 'export function SavedLibrarySection(')}; return LibraryItem`)(() => store, value => [value, () => {}], value => ({ current: value }), () => {}, libraryItemFacts, libraryApplyPlan, describeLibraryItem, libraryPlacesObject, store, { t: 4 }, () => { throw new Error('Unexpected LUT inspection') }, prepareLibraryOps, edit, patch => Object.assign(store, patch), (...v) => notices.push(v), c => c, htm.bind(h))
  const tree = component({ item })
  const visit = node => { if (!node || typeof node !== 'object') return null; if (node.type === 'button' && node.props.title?.startsWith('Apply')) return node; for (const child of [node.props?.children].flat(Infinity)) { const result = visit(child); if (result) return result } return null }
  return { store, calls, notices, action: visit(tree).props.onClick }
}
test('actual library Apply callback dispatches the captured nested cut and expected version', async () => {
  const p = incomingScene(), c = applyController(p, 'k1')
  await c.action()
  assert.equal(c.calls.length, 1); assert.equal(c.calls[0].ops[0].comp, 'k1'); assert.equal(c.calls[0].options.expectedVersion, 7)
  assert.deepEqual(c.store.project.tracks, p.tracks); assert.equal(c.store.project.comps.k1.tracks[0].clips[1].transitionIn.type, 'wipeLeft')
})
test('actual library Apply callback refuses stale root, version, composition or selection before edit', async () => {
  for (const patch of [{ root: '/other' }, { version: 8 }, { openComp: null }, { selection: [] }]) {
    const c = applyController(incomingScene(), 'k1'); Object.assign(c.store, patch); await c.action()
    assert.equal(c.calls.length, 0); assert.ok(c.notices.length)
  }
})
