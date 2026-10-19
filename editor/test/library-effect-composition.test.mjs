import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) { return next(specifier.startsWith('/core/') ? new URL(`../core/${specifier.slice(6)}`, import.meta.url).href : specifier, context) } })
const { allClips, applyOps, findClip, newProject } = await import('../core/project.js')
const { libraryPlacesObject, validateLibraryItem } = await import('../core/library.js')
const { nativeFigmaImport } = await import('../core/figma-native.js')
const { framePlan } = await import('../core/render-plan.js')
const { captureLibrarySource, libraryApplyPlan, libraryItemFacts, librarySaveChoices, librarySourceStatus } = await import('../web/ui/library/model.js')
const run = (p, ops) => applyOps(p, ops).project
const flat = p => allClips(p, true).map(row => row.clip)

function scene() {
  let p = run(newProject('Animated design', { width: 320, height: 180, fps: 30 }), [
    { op: 'add_comp', name: 'Pulse overlay', width: 320, height: 180, duration: 4 },
    { op: 'add_shape', comp: 'k1', track: 'V1', start: 0, dur: 4, shape: { type: 'rect', width: 90, height: 30, fill: { color: '#ff9911' } } },
    { op: 'add_title', comp: 'k1', track: 'V2', start: 0, dur: 4, text: 'Pulse', title: { font: 'Inter', size: 24 } },
    { op: 'parent', comp: 'k1', id: 'c2', parent: 'c1' },
    { op: 'link', comp: 'k1', ids: ['c1', 'c2'] },
    { op: 'keyframe', comp: 'k1', id: 'c1', prop: 'opacity', at: 0, local: true, value: 0 },
    { op: 'keyframe', comp: 'k1', id: 'c1', prop: 'opacity', at: 2, local: true, value: 1, ease: 'inOut' },
    { op: 'comp_clip', target: 'k1', track: 'V3', start: 2, dur: 2, set: { in: 1, scale: 0.7, x: 80, opacity: 0.6 } },
    { op: 'effect', id: 'c3', type: 'glow', params: { amount: 0.4 } },
  ])
  return p
}
function save(p, source = { composition: 'k1' }, extra = {}) {
  return run(p, [{ op: 'library_save', category: 'effect', name: 'Pulse', source, ...extra }])
}
function overlay(p) { return p.library.items.at(-1) }
function placed(before, after) { const ids = new Set(flat(before).map(c => c.id)); return flat(after).find(c => c.kind === 'comp' && !ids.has(c.id)) }
function atomic(p, op, pattern) { const before = structuredClone(p); assert.throws(() => run(p, [op]), pattern); assert.deepEqual(p, before) }

test('an authored effect composition saves in Effects without changing source layers', () => {
  const p = scene(), before = structuredClone(p), q = save(p)
  assert.equal(overlay(q).category, 'effect')
  assert.equal(overlay(q).body.composition, 'k1')
  assert.deepEqual(overlay(q).body.comps.k1, p.comps.k1)
  assert.deepEqual(p, before)
  assert.equal(overlay(q).body.settings, undefined)
  assert.equal(libraryPlacesObject(overlay(q)), true)
})

test('saving a selected effect wrapper retains timing, transforms and wrapper effects', () => {
  const p = scene(), q = save(p, { clip: 'c3', type: 'composition' })
  const c = overlay(q).body.clip
  assert.deepEqual(c, { ...findClip(p, 'c3').clip, start: 0 })
  assert.equal(c.in, 1); assert.equal(c.dur, 2); assert.equal(c.scale, 0.7)
  assert.equal(c.effects[0].type, 'glow')
})

test('ordinary effect settings on a comp wrapper still save and apply to a selected target', () => {
  const p = scene(), q = save(p, { clip: 'c3' })
  assert.equal(libraryPlacesObject(overlay(q)), false)
  assert.equal(overlay(q).body.comps, undefined)
  assert.deepEqual(overlay(q).body.settings.effects, findClip(p, 'c3').clip.effects)
  assert.equal(libraryApplyPlan(q, overlay(q), []).ok, false)
  const plan = libraryApplyPlan(q, overlay(q), ['c2'], { comp: 'k1' })
  assert.equal(plan.ok, true)
  const result = run(q, plan.ops)
  assert.equal(findClip(result, 'c2').clip.effects[0].type, 'glow')
})

test('effect stack and wrapper choices retain different complete source tuples', () => {
  const choices = librarySaveChoices(scene(), ['c3']).filter(c => c.category === 'effect')
  assert.equal(choices.length, 2)
  assert.deepEqual(choices[0].source, { clip: 'c3' })
  assert.deepEqual(choices[1].source, { clip: 'c3', type: 'composition' })
  assert.notEqual(JSON.stringify(choices[0].source), JSON.stringify(choices[1].source))
  assert.deepEqual(librarySaveChoices(scene(), [], 'k1').find(c => c.category === 'effect').source, { composition: 'k1' })
})

test('placing an effect composition needs no selected target and preserves existing animation', () => {
  const p = save(scene()), before = structuredClone(p)
  const plan = libraryApplyPlan(p, overlay(p), [], { start: 10 })
  assert.equal(plan.ops.length, 1)
  const { comp, ...rootOperation } = plan.ops[0]
  assert.equal(comp ?? null, null)
  assert.deepEqual(rootOperation, { op: 'library_apply', item: overlay(p).id, start: 10 })
  const q = run(p, plan.ops), c = placed(p, q)
  assert.equal(c.start, 10); assert.equal(c.dur, 4); assert.notEqual(c.comp, 'k1')
  assert.deepEqual(q.comps.k1, p.comps.k1); assert.deepEqual(q.library, p.library); assert.deepEqual(p, before)
  assert.equal(findClip(q, 'c3').clip.effects.length, 1)
})

test('independent effect copies remap parent and link references within each copied composition', () => {
  const p = save(scene()), a = run(p, libraryApplyPlan(p, overlay(p), ['missing'], { start: 10 }).ops)
  const first = placed(p, a), b = run(a, libraryApplyPlan(a, overlay(a), [], { start: 15 }).ops), second = placed(a, b)
  assert.notEqual(first.comp, second.comp)
  const layers = id => b.comps[id].tracks.flatMap(t => t.clips)
  const one = layers(first.comp), two = layers(second.comp)
  for (const cs of [one, two]) {
    const shape = cs.find(c => c.kind === 'shape'), title = cs.find(c => c.kind === 'title')
    assert.equal(title.parent, shape.id); assert.equal(title.link, shape.link)
    assert.deepEqual(shape.anim.opacity, [[0, 0], [2, 1, 'inOut']])
    assert(!['c1', 'c2'].includes(title.id))
  }
  assert.notEqual(one[0].link, two[0].link)
  assert.deepEqual(b.comps.k1, p.comps.k1)
})

test('effect placement into a nested destination emits scoped operations and changes no main track', () => {
  const p = run(save(scene()), [{ op: 'add_comp', name: 'Destination', duration: 20 }])
  const plan = libraryApplyPlan(p, overlay(p), [], { comp: 'k2', start: 3 })
  assert.equal(plan.ok, true); assert.equal(plan.ops[0].comp, 'k2')
  const q = run(p, plan.ops), c = placed(p, q)
  assert.equal(findClip(q, c.id).comp, 'k2'); assert.equal(c.start, 3)
  assert.deepEqual(q.tracks, p.tracks)
})

for (const [name, start] of [['negative', -1], ['nonfinite', Infinity]]) test(`${name} overlay placement is atomic`, () => {
  const p = save(scene())
  atomic(p, { op: 'library_apply', item: overlay(p).id, start }, /placement time/)
})

test('locked and absent destination compositions block the full browser plan', () => {
  const p = save(scene()); p.tracks.forEach(t => { if (t.kind === 'video') t.locked = true })
  assert.equal(libraryApplyPlan(p, overlay(p), [], { start: 2 }).ok, false)
  assert.equal(libraryApplyPlan(p, overlay(p), [], { start: 2, comp: 'missing' }).ok, false)
  atomic(p, { op: 'library_apply', item: overlay(p).id, start: 2 }, /unlocked/)
})

test('explicit audio or locked placement tracks refuse without editing a saved overlay', () => {
  const p = save(scene())
  atomic(p, { op: 'library_apply', item: overlay(p).id, start: 2, track: 'A1' }, /unlocked video/)
  p.tracks.find(t => t.id === 'V2').locked = true
  atomic(p, { op: 'library_apply', item: overlay(p).id, start: 2, track: 'V2' }, /unlocked video/)
})

for (const source of [{ composition: 'k1' }, { clip: 'c3', type: 'composition' }]) test(`an effect-index request refuses for overlay ${JSON.stringify(source)}`, () => {
  atomic(scene(), { op: 'library_save', category: 'effect', name: 'Bad', source, index: 0 }, /cannot select one stack effect/)
})

for (const [category, source] of [['effect', { clip: 'c2', type: 'composition' }], ['effect', { clip: 'c3', type: 'unknown' }], ['title', { clip: 'c3', type: 'composition' }]]) test(`unsupported source selector refuses for ${category} ${JSON.stringify(source)}`, () => {
  atomic(scene(), { op: 'library_save', category, name: 'Bad', source }, /composition source type/)
})

test('effect overlay registration validates a composition body and preserves file admission checks', () => {
  const p = save(scene()), item = structuredClone(overlay(p)); delete item.id
  const q = run(scene(), [{ op: 'library_register', item }])
  assert.equal(libraryPlacesObject(overlay(q)), true)
  const mixed = structuredClone(item); mixed.body.settings = { effects: [{ type: 'glow' }] }
  atomic(scene(), { op: 'library_register', item: mixed }, /placement needs/)
  const title = structuredClone(item); title.body = { clip: findClip(scene(), 'c2').clip, assets: {} }
  assert.throws(() => validateLibraryItem(title), /composition clip/)
})

test('JSON reopen retains the overlay category, wrapper and editable animation for another placement', () => {
  const p = save(scene(), { clip: 'c3', type: 'composition' }), reopened = JSON.parse(JSON.stringify(p))
  const q = run(reopened, libraryApplyPlan(reopened, overlay(reopened), [], { start: 12 }).ops)
  const c = placed(reopened, q)
  assert.equal(c.start, 12); assert.equal(c.in, 1); assert.equal(c.dur, 2); assert.equal(c.scale, 0.7)
  assert.deepEqual(q.comps[c.comp].tracks[0].clips[0].anim.opacity, [[0, 0], [2, 1, 'inOut']])
  assert.match(libraryItemFacts(overlay(q)).details, /overlay at the playhead/)
})

test('a retained pre-placement project snapshot still contains its saved Effects entry', () => {
  const p = save(scene()), beforePlacement = JSON.stringify(p)
  const q = run(p, libraryApplyPlan(p, overlay(p), [], { start: 10 }).ops)
  const restored = JSON.parse(beforePlacement)
  assert.deepEqual(restored, p); assert.equal(restored.library.items.length, 1)
  assert(flat(q).length > flat(restored).length)
  const redo = run(restored, libraryApplyPlan(restored, overlay(restored), [], { start: 10 }).ops)
  assert.deepEqual(redo, q)
})

test('Figma node notes, fonts, geometry, hierarchy and native keyframes survive Effects save and reuse', () => {
  const box = (x, y, width, height) => ({ absoluteBoundingBox: { x, y, width, height } })
  const white = { type: 'SOLID', color: { r: 1, g: 1, b: 1 } }
  const frame = { id: '1:1', name: 'Brand pulse', type: 'FRAME', ...box(0, 0, 320, 180), fills: [], children: [
    { id: '1:2', name: 'Heading', type: 'TEXT', characters: 'Brand', ...box(40, 50, 180, 40), fills: [white], style: { fontFamily: 'IBM Plex Sans', fontSize: 24, fontWeight: 600 } },
    { id: '1:3', name: 'Portrait', type: 'RECTANGLE', ...box(20, 20, 60, 60), fills: [{ type: 'IMAGE', imageRef: 'portrait', scaleMode: 'FILL' }] },
  ] }
  const initial = newProject('Design reuse', { width: 320, height: 180, fps: 30 })
  const imported = nativeFigmaImport(initial, frame, { duration: 4, images: { '1:3': { src: 'media/figma/portrait.png', width: 120, height: 120 } }, assets: { 'media/figma/portrait.png': { width: 120, height: 120, still: true, hasVideo: true } } })
  let p = run(initial, imported.ops)
  const title = flat(p).find(c => c.kind === 'title')
  p = run(p, [{ op: 'keyframe', comp: imported.comp, id: title.id, prop: 'opacity', at: 0, local: true, value: 0 }, { op: 'keyframe', comp: imported.comp, id: title.id, prop: 'opacity', at: 2, local: true, value: 1, ease: 'smooth' }])
  p = run(p, [{ op: 'library_save', category: 'effect', name: 'Brand pulse', source: { composition: imported.comp } }])
  const q = run(p, libraryApplyPlan(p, overlay(p), [], { start: 8 }).ops), c = placed(p, q)
  const source = p.comps[imported.comp].tracks.flatMap(t => t.clips), copies = q.comps[c.comp].tracks.flatMap(t => t.clips)
  for (const original of source) {
    const copied = copies.find(c => c.note === original.note)
    assert(copied); assert.notEqual(copied.id, original.id)
    for (const field of ['kind', 'note', 'title', 'shape', 'x', 'y', 'scaleX', 'scaleY', 'src', 'anim']) assert.deepEqual(copied[field], original[field])
    if (original.parent) assert.equal(copied.parent, copies.find(c => c.note === source.find(c => c.id === original.parent).note).id)
  }
  assert.deepEqual(overlay(q).body.assets, { 'media/figma/portrait.png': p.assets['media/figma/portrait.png'] })
  assert.equal(copies.find(c => c.kind === 'title').title.font, 'IBM Plex Sans')
  assert.equal(framePlan(q, 9).layers.find(layer => layer.clip?.id === c.id).clip.composition.layers.some(layer => layer.clip?.kind === 'title'), true)
  const missing = structuredClone(initial)
  atomic(missing, { op: 'library_register', item: { ...overlay(p), id: undefined } }, /dependency.*must match/)
})

test('an overlay Save capture rejects stale source data and versions before emitting an operation', () => {
  const p = scene(), choice = librarySaveChoices(p, ['c3']).find(c => c.source.type === 'composition')
  const scope = { root: '/project', version: 4, selection: ['c3'], composition: null }
  const capture = captureLibrarySource(p, choice, scope)
  assert.equal(librarySourceStatus(p, capture, scope).ok, true)
  assert.equal(librarySourceStatus(p, capture, { ...scope, version: 5 }).ok, false)
  const changed = structuredClone(p); changed.comps.k1.tracks[1].clips[0].title.text = 'Changed'
  assert.equal(librarySourceStatus(changed, capture, scope).ok, false)
})

test('a stale displayed overlay cannot place a replacement with the same library ID', () => {
  const p = save(scene()), old = structuredClone(overlay(p)); overlay(p).body.comps.k1.tracks[1].clips[0].title.text = 'Replacement'
  const plan = libraryApplyPlan(p, old, [], { start: 8 })
  assert.equal(plan.ok, false); assert.deepEqual(plan.ops, [])
})

test('browser Save and Place callback bindings distinguish effect overlays from stacks', () => {
  const text = readFileSync(new URL('../web/ui/plugins/library.js', import.meta.url), 'utf8')
  assert.match(text, /const placement = libraryPlacesObject\(item\)/)
  assert.match(text, /choice\.category === 'effect' && !compositionEffect && Number\(effectIndex\)/)
  assert.match(text, /JSON\.stringify\(option\.source\) === JSON\.stringify\(capture\.choice\.source\)/)
  assert.match(text, /choice\?\.category === 'effect' && !compositionEffect && clip\?\.effects\?\.length/)
})
