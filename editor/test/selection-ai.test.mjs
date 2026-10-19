import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { applyOps, newProject } from '../core/project.js'
import { nativeFigmaImport } from '../core/figma-native.js'
import { selectionMotionContext, selectionMotionReference } from '../core/selection-ai.js'
import { assistantPrompt } from '../web/ui/assistant-state.js'
import { createChatHistory } from '../agent/chat-history.mjs'

function imported() {
  const nodes = {
    id: '10:1', type: 'FRAME', name: 'Opening', absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 180 }, fills: [],
    children: [{ id: '10:2', type: 'TEXT', name: 'Headline', characters: 'A real editable headline', absoluteBoundingBox: { x: 20, y: 20, width: 260, height: 40 }, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }], style: { fontFamily: 'Avenir Next', fontWeight: 700, fontSize: 24 } }],
  }
  const project = newProject('Imported motion')
  const result = nativeFigmaImport(project, nodes, { placeOnTimeline: true, duration: 6 })
  return { project: applyOps(project, result.ops).project, comp: result.comp }
}

test('an imported composition attaches its genuine source node and editable layer IDs without mutation', () => {
  const { project, comp } = imported()
  const before = JSON.stringify(project)
  const clip = project.tracks.flatMap(track => track.clips).find(layer => layer.kind === 'comp')
  const ref = selectionMotionReference(project, [clip.id], null, 'Make the headline fade in gently.')
  const title = project.comps[comp].tracks.flatMap(track => track.clips).find(layer => layer.kind === 'title')
  assert.deepEqual(ref.context.selected, [clip.id])
  assert.equal(ref.context.layers.find(layer => layer.id === title.id).figma.nodeId, '10:2')
  assert.equal(ref.context.layers.find(layer => layer.id === title.id).composition, comp)
  assert.equal(ref.context.layers.find(layer => layer.id === title.id).font, 'Avenir Next')
  assert.equal(ref.context.compositions[0].id, comp)
  assert.equal(ref.intent, 'Make the headline fade in gently.')
  assert.equal(ref.context.layers.find(layer => layer.id === title.id).figma.fileKey, undefined)
  assert.equal(JSON.stringify(project), before)
})

test('an open composition uses exact current layers and rejects stale or outside IDs', () => {
  const { project, comp } = imported()
  const title = project.comps[comp].tracks.flatMap(track => track.clips).find(layer => layer.kind === 'title')
  const placed = project.tracks.flatMap(track => track.clips).find(layer => layer.kind === 'comp')
  assert.deepEqual(selectionMotionContext(project, [], comp).selected, [title.id])
  assert.deepEqual(selectionMotionContext(project, [title.id, title.id], comp).selected, [title.id])
  assert.throws(() => selectionMotionContext(project, ['gone'], comp), /no longer exists/)
  assert.throws(() => selectionMotionContext(project, [placed.id], comp), /outside/)
  assert.throws(() => selectionMotionContext(project, [], 'missing'), /no longer exists/)
})

test('suggestions come from selected content and inspect current keyframes instead of modifying them', () => {
  let project = applyOps(newProject('Motion'), [
    { op: 'add_shape', track: 'V1', start: 0, dur: 4, shape: { type: 'path', path: { vertices: [[0, 0], [20, 20]], closed: false }, stroke: { color: '#ffffff', width: 4 } } },
    { op: 'add_title', track: 'V2', start: 0, dur: 4, text: 'Text' },
  ]).project
  const shape = project.tracks[0].clips[0], title = project.tracks[1].clips[0]
  const shapeContext = selectionMotionContext(project, [shape.id])
  assert.deepEqual(shapeContext.suggestions.map(suggestion => suggestion.id), ['draw'])
  project = applyOps(project, [{ op: 'keyframe', id: title.id, prop: 'opacity', at: 0, value: 0, local: true }, { op: 'keyframe', id: title.id, prop: 'opacity', at: 0.4, value: 1, local: true }]).project
  const context = selectionMotionContext(project, [title.id])
  assert.deepEqual(context.layers[0].animated, [{ property: 'opacity', keys: 2 }])
  assert.deepEqual(context.suggestions.map(suggestion => suggestion.id), ['refine', 'readable'])
  const together = selectionMotionContext(project, [shape.id, title.id])
  assert(together.suggestions.some(suggestion => suggestion.id === 'stagger'))
})

test('motion reference rejects empty and oversized intents and selections', () => {
  const { project, comp } = imported()
  assert.throws(() => selectionMotionReference(project, [], comp, ''), /Describe/)
  assert.throws(() => selectionMotionReference(project, [], comp, 'a'.repeat(4001)), /4000/)
  const layer = project.comps[comp].tracks.flatMap(track => track.clips)[0]
  for (let i = 0; i < 160; i++) project.comps[comp].tracks[0].clips.push({ ...structuredClone(layer), id: `many${i}`, label: 'label'.repeat(40) })
  assert.throws(() => selectionMotionReference(project, [], comp, 'Animate these layers.'), /too large/)
})

function repeatedScopeIDs() {
  const project = newProject('Scope-local imported IDs')
  const title = (id, label, nodeId) => ({ id, kind: 'title', label, start: 2, dur: 5, note: `figma ${nodeId}`, figma: { nodeId, fileKey: 'saved-file' }, parent: 'parent', title: { text: label, font: 'Avenir Next', anim: 'none' }, anim: { opacity: [[0, 0, 'hold'], [1, 1]] }, expr: { x: 'value + 2' } })
  const timeline = clip => ({ width: 320, height: 180, duration: 7, tracks: [{ id: 'V1', kind: 'video', clips: [clip] }] })
  project.tracks[0].clips = [title('shared', 'Main title', '11:1')]
  project.comps = { k1: timeline(title('shared', 'First title', '11:2')), k2: timeline(title('shared', 'Second title', '11:3')) }
  return { project, title, timeline }
}

for (const explicit of [false, true]) test(`Main selection resolves in main despite nested ID reuse (${explicit ? 'explicit null' : 'default'})`, () => {
  const { project } = repeatedScopeIDs(), before = structuredClone(project)
  const context = explicit ? selectionMotionContext(project, ['shared'], null) : selectionMotionContext(project, ['shared'])
  assert.equal(context.layers[0].composition, null)
  assert.equal(context.layers[0].label, 'Main title')
  assert.equal(context.layers[0].figma.nodeId, '11:1')
  assert.deepEqual(project, before)
})

test('Named composition resolves its own ID even when a later composition reuses it', () => {
  const { project } = repeatedScopeIDs(), before = structuredClone(project)
  const context = selectionMotionContext(project, ['shared', 'shared', 'tr:V1'], 'k1')
  assert.deepEqual(context.selected, ['shared'])
  assert.equal(context.layers[0].composition, 'k1')
  assert.equal(context.layers[0].label, 'First title')
  assert.equal(context.layers[0].figma.nodeId, '11:2')
  assert.equal(context.layers[0].figma.fileKey, 'saved-file')
  assert.equal(context.layers[0].font, 'Avenir Next')
  assert.equal(context.layers[0].parent, 'parent')
  assert.deepEqual(context.layers[0].animated, [{ property: 'opacity', keys: 2 }])
  assert.deepEqual(context.layers[0].expressions, ['x'])
  assert.deepEqual(project, before)
})

test('An actual Figma imported child remains attached when its parent container reuses the child ID', () => {
  const { project, comp } = imported()
  const placed = project.tracks.flatMap(track => track.clips).find(layer => layer.kind === 'comp')
  const child = project.comps[comp].tracks.flatMap(track => track.clips).find(layer => layer.kind === 'title')
  placed.id = child.id
  const before = structuredClone(project), ref = selectionMotionReference(project, [placed.id], null, 'Keep the imported headline readable.')
  assert.deepEqual(ref.context.layers.map(layer => [layer.composition, layer.id]), [[null, placed.id], [comp, child.id]])
  assert.equal(ref.context.layers[1].figma.nodeId, '10:2')
  assert.equal(ref.context.layers[1].font, 'Avenir Next')
  assert.deepEqual(project, before)
})

test('Traversal retains children with reused IDs in sibling compositions', () => {
  const { project } = repeatedScopeIDs()
  project.tracks[0].clips = ['k1', 'k2'].map((comp, i) => ({ id: `container${i}`, kind: 'comp', comp, start: 0, dur: 7 }))
  const before = structuredClone(project), context = selectionMotionContext(project, ['container0', 'container1'], null)
  assert.deepEqual(context.layers.filter(layer => layer.id === 'shared').map(layer => [layer.composition, layer.label]), [['k1', 'First title'], ['k2', 'Second title']])
  assert.deepEqual(context.compositions.map(comp => comp.id), ['k1', 'k2'])
  assert.deepEqual(project, before)
})

test('Traversal retains a nested composition container and child with the same ID', () => {
  const { project } = repeatedScopeIDs()
  project.comps.k1.tracks[0].clips = [{ id: 'shared', kind: 'comp', comp: 'k2', start: 0, dur: 7 }]
  const context = selectionMotionContext(project, ['shared'], 'k1')
  assert.deepEqual(context.layers.map(layer => [layer.composition, layer.id]), [['k1', 'shared'], ['k2', 'shared']])
})

test('Explicit main and named scope refuse outside IDs and distinguish stale IDs', () => {
  const { project, title } = repeatedScopeIDs()
  project.comps.k2.tracks[0].clips.push(title('nestedOnly', 'Nested only', '12:1'))
  project.tracks[1].clips.push(title('mainOnly', 'Main only', '12:2'))
  assert.throws(() => selectionMotionContext(project, ['nestedOnly'], null), /outside/)
  assert.throws(() => selectionMotionContext(project, ['mainOnly'], 'k1'), /outside/)
  assert.throws(() => selectionMotionContext(project, ['gone'], null), /no longer exists/)
  assert.throws(() => selectionMotionContext(project, ['gone'], 'k1'), /no longer exists/)
  assert.throws(() => selectionMotionContext(project, ['shared'], 'gone'), /composition no longer exists/)
  assert.throws(() => selectionMotionContext(project, ['shared'], 'constructor'), /composition no longer exists/)
})

for (const composition of [null, 'k1']) test(`Duplicate IDs within ${composition ?? 'main'} refuse ambiguous selection`, () => {
  const { project } = repeatedScopeIDs()
  const scope = composition ? project.comps[composition] : project
  scope.tracks.push({ id: 'duplicate', kind: 'video', clips: [structuredClone(scope.tracks[0].clips[0])] })
  const before = structuredClone(project)
  assert.throws(() => selectionMotionContext(project, ['shared'], composition), /ambiguous/)
  if (composition) assert.throws(() => selectionMotionContext(project, [], composition), /ambiguous/)
  assert.deepEqual(project, before)
})

test('Ambiguous child IDs refuse traversal without attaching partial imported context', () => {
  const { project } = repeatedScopeIDs()
  project.tracks[0].clips = [{ id: 'container', kind: 'comp', comp: 'k1', start: 0, dur: 7 }]
  project.comps.k1.tracks[0].clips.push(structuredClone(project.comps.k1.tracks[0].clips[0]))
  const before = structuredClone(project)
  assert.throws(() => selectionMotionReference(project, ['container'], null, 'Animate the imported layers.'), /ambiguous/)
  assert.deepEqual(project, before)
})

test('Scope and ID traversal keys are distinct even when their strings contain delimiters', () => {
  const { project, title, timeline } = repeatedScopeIDs()
  project.comps = { 'x': timeline(title('y:z', 'First', '13:1')), 'x:y': timeline(title('z', 'Second', '13:2')) }
  project.tracks[0].clips = [{ id: 'first', kind: 'comp', comp: 'x', start: 0, dur: 7 }, { id: 'second', kind: 'comp', comp: 'x:y', start: 0, dur: 7 }]
  assert.deepEqual(selectionMotionContext(project, ['first', 'second'], null).layers.filter(layer => layer.kind === 'title').map(layer => [layer.composition, layer.id]), [['x', 'y:z'], ['x:y', 'z']])
})

test('Named empty selection still includes current scope and main empty selection still refuses', () => {
  const { project } = repeatedScopeIDs()
  assert.deepEqual(selectionMotionContext(project, [], 'k1').selected, ['shared'])
  assert.throws(() => selectionMotionContext(project, [], null), /Select a layer/)
})

function motionMenu(project, composition = null) {
  const plugin = fs.readFileSync(new URL('../web/ui/plugins/library.js', import.meta.url), 'utf8')
  const attachment = plugin.slice(plugin.indexOf('export function attachMotionIntent('), plugin.indexOf('export function AnimateSelection(')).replace('export ', '')
  const registration = plugin.slice(plugin.lastIndexOf('registerClipMenu('))
  const store = { project, root: '/owned/motion', version: 7, openComp: composition, selection: ['prior'], inspectorTab: 'appearance', refs: [{ kind: 'image', id: 'saved-ref' }] }
  const refs = [], errors = [], mutations = []
  let callback
  new Function('selectionMotionReference', 'store', 'toast', 'set', 'addRef', 'registerClipMenu', attachment + '\n' + registration)(selectionMotionReference, store, message => errors.push(message), fields => { mutations.push('set'); Object.assign(store, fields) }, ref => { mutations.push('addRef'); refs.push(ref); store.refs.push(ref) }, fn => { callback = fn })
  const scope = composition ? project.comps[composition] : project
  return { store, refs, errors, mutations, actions: callback(project, { clip: scope.tracks[0].clips[0] }) }
}

test('Actual clip-menu attachment resolves repeated IDs in its captured current scope', () => {
  for (const composition of [null, 'k1']) {
    const { project } = repeatedScopeIDs(), before = structuredClone(project), menu = motionMenu(project, composition)
    menu.actions[0].run()
    assert.equal(menu.refs.length, 1)
    assert.equal(menu.refs[0].context.composition, composition)
    assert.equal(menu.refs[0].context.layers[0].label, composition ? 'First title' : 'Main title')
    assert.equal(menu.refs[0].context.projectRoot, '/owned/motion')
    assert.equal(menu.refs[0].context.projectVersion, 7)
    assert.deepEqual(menu.store.selection, ['shared'])
    assert.equal(menu.store.inspectorTab, 'library')
    assert.deepEqual(menu.mutations, ['addRef', 'set'])
    assert.deepEqual(project, before)
  }
})

for (const composition of [null, 'k1']) for (const fault of ['ambiguous', 'stale', 'reference-cap']) test(`Actual registered menu ${fault} refusal in ${composition ?? 'main'} preserves all UI and source state`, () => {
  const { project } = repeatedScopeIDs(), menu = motionMenu(project, composition)
  const scope = composition ? project.comps[composition] : project
  if (fault === 'ambiguous') scope.tracks[0].clips.push(structuredClone(scope.tracks[0].clips[0]))
  if (fault === 'stale') scope.tracks[0].clips = []
  if (fault === 'reference-cap') menu.store.refs = [{ kind: 'image', id: 'large-ref', content: 'x'.repeat(64000) }]
  const before = { selection: menu.store.selection, inspectorTab: menu.store.inspectorTab, refs: menu.store.refs, refBytes: JSON.stringify(menu.store.refs), project: JSON.stringify(project) }
  menu.actions[0].run()
  assert.equal(menu.refs.length, 0)
  assert.equal(menu.store.selection, before.selection)
  assert.equal(menu.store.inspectorTab, before.inspectorTab)
  assert.equal(menu.store.refs, before.refs)
  assert.equal(JSON.stringify(menu.store.refs), before.refBytes)
  assert.equal(JSON.stringify(project), before.project)
  assert.deepEqual(menu.mutations, [])
  assert.match(menu.errors[0], fault === 'ambiguous' ? /ambiguous/ : fault === 'stale' ? /no longer exists|outside/ : /too large/)
})

test('Actual store addRef retains main and named-main requests and replaces the same exact scoped selection', () => {
  const { project, title, timeline } = repeatedScopeIDs(), before = structuredClone(project)
  project.comps.main = timeline(title('shared', 'Named main', '14:1'))
  const storeSource = fs.readFileSync(new URL('../web/ui/store.js', import.meta.url), 'utf8')
  const method = storeSource.match(/export function addRef\(ref\) \{[\s\S]*?\n\}/)
  assert(method)
  const state = { refs: [], chatOpen: false }
  const add = new Function('set', 'toast', method[0].replace('export ', '') + '\nreturn addRef')(patch => Object.assign(state, typeof patch === 'function' ? patch(state) : patch), () => {})
  const original = structuredClone(project)
  const main = selectionMotionReference(project, ['shared'], null, 'Animate main.')
  const nested = selectionMotionReference(project, ['shared'], 'main', 'Animate named main.')
  assert.notEqual(main.id, nested.id)
  add(main); add(nested)
  assert.equal(state.refs.length, 2)
  assert.deepEqual(state.refs.map(ref => ref.context.composition), [null, 'main'])
  const repeated = selectionMotionReference(project, ['shared', 'shared'], null, 'Refine this same selection.')
  assert.equal(repeated.id, main.id)
  add(repeated)
  assert.equal(state.refs.length, 2)
  assert.equal(state.refs.find(ref => ref.id === main.id).intent, 'Refine this same selection.')
  assert.equal(state.chatOpen, true)
  assert.deepEqual(project, original)
  assert.deepEqual(project.tracks, before.tracks)
})

test('Root multi-selection and named-scope identities encode strings and arrays without delimiter collisions', () => {
  const { project, title, timeline } = repeatedScopeIDs()
  project.tracks[0].clips = ['a,b', 'a', 'b', 'one:layer', 'quote"\\', '😀'].map((id, i) => title(id, `Layer ${i}`, `15:${i}`))
  project.comps = { part: timeline(title('one:layer', 'First', '16:1')), 'part:one': timeline(title('layer', 'Second', '16:2')), main: timeline(title('a,b', 'Named main', '16:3')), null: timeline(title('a,b', 'String null', '16:4')) }
  const cases = [[null, ['a,b']], [null, ['a', 'b']], [null, ['quote"\\']], [null, ['😀']], ['part', ['one:layer']], ['part:one', ['layer']], ['main', ['a,b']], ['null', ['a,b']]]
  const before = structuredClone(project), identities = cases.map(([scope, ids]) => selectionMotionReference(project, ids, scope, 'Keep this scoped selection.').id)
  assert.equal(new Set(identities).size, cases.length)
  for (let i = 0; i < cases.length; i++) assert.equal(identities[i], selectionMotionReference(project, cases[i][1], cases[i][0], 'Repeat the exact selection.').id)
  assert.deepEqual(project, before)
})

test('Actual clip-menu attachment refuses scope/root/project/version drift before changing selection', () => {
  for (const axis of ['composition', 'root', 'project', 'version']) {
    const { project } = repeatedScopeIDs(), menu = motionMenu(project), beforeSelection = menu.store.selection
    if (axis === 'composition') menu.store.openComp = 'k1'
    if (axis === 'root') menu.store.root = '/owned/other'
    if (axis === 'project') menu.store.project = structuredClone(project)
    if (axis === 'version') menu.store.version++
    menu.actions[0].run()
    assert.equal(menu.refs.length, 0, axis)
    assert.equal(menu.store.selection, beforeSelection, axis)
    assert.match(menu.errors[0], /changed/, axis)
  }
})


test('Bounded reference digests match Node SHA-256 for ASCII, Unicode, escaped and long typed tuples', () => {
  const { project, title, timeline } = repeatedScopeIDs()
  let receipts = 0
  for (const length of [0, 1, 2, 3, 20, 31, 32, 47, 48, 55, 56, 63, 64, 65, 127, 128, 255, 256, 511, 512, 2048]) {
    for (const suffix of ['ascii', 'é', '漢', '😀', '\ud800', 'quote"\\']) {
      const id = `id-${'x'.repeat(length)}-${suffix}`
      project.tracks[0].clips = [title(id, 'Digest title', '17:1')]
      project.comps = { main: timeline(title(id, 'Nested digest title', '17:2')) }
      for (const scope of [null, 'main']) {
        const ref = selectionMotionReference(project, [id], scope, 'Animate this selection.')
        const tuple = JSON.stringify([scope == null ? ['main'] : ['composition', scope], ref.context.selected])
        assert.equal(ref.id, `selection:sha256:${createHash('sha256').update(tuple).digest('hex')}`)
        assert.equal(ref.id.length, 81)
        assert(!ref.then, 'The reference remains synchronous')
        receipts++
      }
    }
  }
  assert.equal(receipts, 252)
})

for (const composition of [null, 'k1']) for (const fault of ['scope', 'selected', 'missing-context']) test(`Actual registered menu ${fault} digest conflict in ${composition ?? 'main'} refuses before any mutation`, () => {
  const { project } = repeatedScopeIDs(), menu = motionMenu(project, composition)
  const desired = selectionMotionReference(project, ['shared'], composition, 'Animate this layer.')
  const context = fault === 'missing-context' ? undefined : { composition: fault === 'scope' ? (composition === null ? 'k1' : null) : composition, selected: fault === 'selected' ? ['different'] : ['shared'] }
  menu.store.refs = [{ kind: 'motion', id: desired.id, label: 'Prior distinct request', ...(context ? { context } : {}) }]
  const before = { refs: menu.store.refs, bytes: JSON.stringify(menu.store.refs), selection: menu.store.selection, inspector: menu.store.inspectorTab, project: JSON.stringify(project) }
  menu.actions[0].run()
  assert.equal(menu.refs.length, 0)
  assert.equal(menu.store.refs, before.refs)
  assert.equal(JSON.stringify(menu.store.refs), before.bytes)
  assert.equal(menu.store.selection, before.selection)
  assert.equal(menu.store.inspectorTab, before.inspector)
  assert.equal(JSON.stringify(project), before.project)
  assert.deepEqual(menu.mutations, [])
  assert.match(menu.errors[0], /conflicts with another scoped selection/)
})

function actualAttachment(project, ids, composition = null) {
  const plugin = fs.readFileSync(new URL('../web/ui/plugins/library.js', import.meta.url), 'utf8')
  const attachment = plugin.slice(plugin.indexOf('export function attachMotionIntent('), plugin.indexOf('export function AnimateSelection(')).replace('export ', '')
  const storeSource = fs.readFileSync(new URL('../web/ui/store.js', import.meta.url), 'utf8')
  const method = storeSource.match(/export function addRef\(ref\) \{[\s\S]*?\n\}/)[0].replace('export ', '')
  const store = { project, root: '/owned/motion-history', version: 7, selection: ids, openComp: composition, refs: [] }, errors = []
  const addRef = new Function('set', 'toast', method + ';return addRef')(patch => Object.assign(store, typeof patch === 'function' ? patch(store) : patch), () => {})
  const attach = new Function('selectionMotionReference', 'store', 'toast', 'addRef', attachment + ';return attachMotionIntent')(selectionMotionReference, store, message => errors.push(message), addRef)
  return { store, errors, attach: intent => attach(project, ids, composition, intent) }
}

test('Actual attachment, prompt and history retain a bounded 64-layer reference and exact repeated intent', t => {
  const project = newProject('64 selected layers')
  const ids = Array.from({ length: 64 }, (_, index) => 'clip_' + String(index).padStart(25, '0'))
  project.tracks[0].clips = ids.map(id => ({ id, kind: 'title', start: 0, dur: 4, label: 'Title', title: { text: 'Hello', font: 'Inter', anim: 'none' } }))
  assert(ids.every(id => /^[a-zA-Z0-9_-]{1,128}$/.test(id) && id.length === 30))
  const before = structuredClone(project), h = actualAttachment(project, ids), ref = h.attach('Animate these layers.')
  assert(ref); assert(ref.id.length <= 2048)
  assert(Buffer.byteLength(JSON.stringify(ref)) < 48000)
  assert.equal(h.store.refs.length, 1)
  const prompt = assistantPrompt('Animate', h.store, 0)
  assert.deepEqual(prompt.refs[0], ref)
  assert.notEqual(prompt.refs[0], ref)
  const root = fs.mkdtempSync(new URL('./.motion-history-fixture-', import.meta.url))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const history = createChatHistory({ root })
  history.append({ role: 'user', text: prompt.text, at: 1, refs: prompt.refs })
  assert.equal(history.messages()[0].refs[0].id, ref.id)
  assert.equal(createChatHistory({ root }).messages()[0].refs[0].id, ref.id)
  const repeated = h.attach('Refine this same selection.')
  assert.equal(repeated.id, ref.id); assert.equal(h.store.refs.length, 1)
  assert.equal(h.store.refs[0].intent, 'Refine this same selection.')
  assert.deepEqual(project, before); assert.deepEqual(h.errors, [])
})
