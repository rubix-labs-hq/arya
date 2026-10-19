import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) { return next(specifier.startsWith('/core/') ? new URL(`../core/${specifier.slice(6)}`, import.meta.url).href : specifier, context) } })
const { applyOps, newProject } = await import('../core/project.js')
const { captureLibrarySource, libraryApplyPlan, libraryItemFacts, librarySaveChoices, librarySourceStatus } = await import('../web/ui/library/model.js')

test('saving choices reflect actual selected components and project compositions', () => {
  const project = applyOps(newProject('Choices'), [
    { op: 'add_title', track: 'V1', start: 0, dur: 4, text: 'Reusable heading' },
    { op: 'effect', id: 'c1', type: 'glow' },
    { op: 'transition', id: 'c1', type: 'wipeLeft', dur: 0.6 },
    { op: 'keyframe', id: 'c1', prop: 'opacity', at: 0, value: 0, local: true },
  ]).project
  assert.deepEqual(librarySaveChoices(project, ['c1']).map(choice => choice.category), ['title', 'effect', 'transition', 'motion'])
  assert.deepEqual(librarySaveChoices(project, []), [])
  assert.deepEqual(librarySaveChoices(project, ['c1', 'missing']), [])
  assert.equal(librarySaveChoices(project, ['tr:c1']).find(choice => choice.category === 'transition').source.clip, 'c1')
})

test('multi-target apply blocks the entire selection before emitting operations when one target conflicts', () => {
  const project = applyOps(newProject('Apply'), [
    { op: 'add_title', track: 'V1', start: 0, dur: 4, text: 'Source' },
    { op: 'add_title', track: 'V2', start: 0, dur: 8, text: 'Target' },
    { op: 'add_title', track: 'V3', start: 0, dur: 8, text: 'Conflict' },
    { op: 'keyframe', id: 'c1', prop: 'opacity', at: 0, value: 0, local: true },
    { op: 'keyframe', id: 'c1', prop: 'opacity', at: 4, value: 1, local: true },
    { op: 'keyframe', id: 'c3', prop: 'opacity', at: 0, value: 1, local: true },
    { op: 'library_save', category: 'motion', name: 'Fade', source: { clip: 'c1' } },
  ]).project
  const item = project.library.items[0]
  const blocked = libraryApplyPlan(project, item, ['c2', 'c3'])
  assert.equal(blocked.ok, false)
  assert.deepEqual(blocked.ops, [])
  assert.match(blocked.reason, /opacity|animated|keyframe/i)
  const accepted = libraryApplyPlan(project, item, ['c2', 'c2'])
  assert.equal(accepted.ops.length, 1)
  const result = applyOps(project, accepted.ops).project
  assert.equal(result.tracks[1].clips[0].anim.opacity.at(-1)[0], 8)
  assert.equal(project.tracks[1].clips[0].anim?.opacity, undefined)
  assert.equal(libraryItemFacts(item).details.includes('2 editable keyframes'), true)
})

test('placing a saved title respects the open composition and accurate title sample', () => {
  let project = applyOps(newProject('Placement'), [
    { op: 'add_title', track: 'V1', start: 0, dur: 4, text: 'Actual title', title: { font: 'Didot', anim: 'fade' } },
    { op: 'library_save', category: 'title', name: 'Heading', source: { clip: 'c1' } },
    { op: 'add_comp', name: 'Destination', duration: 10 },
  ]).project
  const item = project.library.items[0]
  const plan = libraryApplyPlan(project, item, [], { comp: 'k1', start: 2 })
  assert.equal(plan.ok, true)
  project = applyOps(project, plan.ops).project
  const copy = project.comps.k1.tracks.flatMap(track => track.clips).find(clip => clip.kind === 'title')
  assert.equal(copy.start, 2)
  assert.equal(copy.title.text, 'Actual title')
  assert.equal(project.tracks[0].clips.length, 1)
  assert.equal(libraryItemFacts(item).text, 'Actual title')
  assert.match(libraryItemFacts(item).details, /Didot/)
})

test('a selected composition saves its clip wrapper and placement rejects a locked destination before any edit', () => {
  const project = applyOps(newProject('Wrapper'), [
    { op: 'add_comp', name: 'Brand badge', duration: 6 },
    { op: 'add_title', comp: 'k1', track: 'V1', start: 0, dur: 6, text: 'Brand' },
    { op: 'comp_clip', target: 'k1', track: 'V1', start: 2, dur: 3, set: { x: 300, scale: 0.6 } },
    { op: 'library_save', category: 'title', name: 'Badge wrapper', source: { clip: 'c2' } },
  ]).project
  const choices = librarySaveChoices(project, ['c2'])
  assert.deepEqual(choices.find(choice => choice.category === 'composition').source, { clip: 'c2' })
  assert.deepEqual(choices.find(choice => choice.category === 'title').source, { clip: 'c2' })
  const item = project.library.items[0]
  assert.match(libraryItemFacts(item).details, /1 editable layer/)
  assert.equal(libraryItemFacts(item).text, 'Brand')
  const result = applyOps(project, libraryApplyPlan(project, item, [], { start: 6 }).ops).project
  const placed = result.tracks[2].clips[0]
  assert.equal(placed.x, 300)
  assert.equal(placed.scale, 0.6)
  assert.equal(placed.dur, 3)
  project.tracks.filter(track => track.kind === 'video').forEach(track => { track.locked = true })
  const plan = libraryApplyPlan(project, item, [])
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.ops, [])
  assert.match(plan.reason, /unlocked video track/)
})

test('a displayed saved item cannot apply a different body with the same ID after a project change', () => {
  const first = applyOps(newProject('First'), [{ op: 'add_title', text: 'First title', start: 0, dur: 4 }, { op: 'library_save', category: 'title', name: 'Heading', source: { clip: 'c1' } }]).project
  const second = applyOps(newProject('Second'), [{ op: 'add_title', text: 'Second title', start: 0, dur: 4 }, { op: 'library_save', category: 'title', name: 'Heading', source: { clip: 'c1' } }]).project
  assert.equal(first.library.items[0].id, second.library.items[0].id)
  const before = JSON.stringify(second)
  const plan = libraryApplyPlan(second, first.library.items[0], [])
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.ops, [])
  assert.match(plan.reason, /changed/)
  assert.equal(JSON.stringify(second), before)
})

test('a native transition composition is offered for saving and applies as an editable overlay copy at the cut', () => {
  const project = applyOps(newProject('Custom transition'), [
    { op: 'add_title', track: 'V1', start: 0, dur: 4, text: 'Before' },
    { op: 'add_title', track: 'V1', start: 4, dur: 4, text: 'After' },
    { op: 'add_comp', name: 'Animated transition', duration: 1 },
    { op: 'add_shape', comp: 'k1', track: 'V1', start: 0, dur: 1, shape: { type: 'rect', width: 1920, height: 1080, fill: { color: '#f5b942' } } },
    { op: 'keyframe', id: 'c3', prop: 'opacity', at: 0, value: 0, local: true },
    { op: 'keyframe', id: 'c3', prop: 'opacity', at: 0.5, value: 1, local: true },
    { op: 'keyframe', id: 'c3', prop: 'opacity', at: 1, value: 0, local: true },
    { op: 'comp_clip', target: 'k1', track: 'V3', start: 0, dur: 1 },
    { op: 'library_save', category: 'transition', name: 'Authored overlay', source: { clip: 'c4' } },
  ]).project
  assert.deepEqual(librarySaveChoices(project, ['c4']).find(choice => choice.category === 'transition').source, { clip: 'c4' })
  assert.deepEqual(librarySaveChoices(project, [], 'k1').find(choice => choice.category === 'transition').source, { composition: 'k1' })
  const item = project.library.items[0]
  assert.match(libraryItemFacts(item).details, /1 editable layer.*overlay across the selected cut/)
  const blocked = libraryApplyPlan(project, item, ['c2', 'c1'])
  assert.equal(blocked.ok, false)
  assert.deepEqual(blocked.ops, [])
  const plan = libraryApplyPlan(project, item, ['tr:c2'])
  assert.equal(plan.ok, true)
  const before = JSON.stringify(project)
  const result = applyOps(project, plan.ops).project
  const overlay = result.tracks.flatMap(track => track.clips).find(clip => clip.kind === 'comp' && clip.id !== 'c4')
  assert(overlay)
  assert.equal(overlay.start, 3.5)
  assert.equal(overlay.dur, 1)
  assert.notEqual(overlay.comp, 'k1')
  const copiedLayer = result.comps[overlay.comp].tracks.flatMap(track => track.clips).find(clip => clip.kind === 'shape')
  assert.notEqual(copiedLayer.id, 'c3')
  assert.deepEqual(copiedLayer.anim.opacity, [[0, 0], [0.5, 1], [1, 0]])
  assert.equal(result.tracks[0].clips.find(clip => clip.id === 'c2').title.text, 'After')
  assert.deepEqual(result.comps.k1, project.comps.k1)
  assert.equal(JSON.stringify(project), before)
})

test('a save source stays captured while selection, source data or project version changes', () => {
  const project = applyOps(newProject('Capture'), [{ op: 'add_title', text: 'Original source', start: 0, dur: 4 }, { op: 'add_title', text: 'Different source', track: 'V2', start: 0, dur: 4 }]).project
  const state = { root: '/first', version: 3, selection: ['c1'], composition: null }
  const capture = captureLibrarySource(project, librarySaveChoices(project, ['c1'])[0], state)
  assert.equal(librarySourceStatus(project, capture, state).ok, true)
  assert.equal(librarySourceStatus(project, capture, { ...state, selection: ['c2'] }).ok, false)
  assert.equal(capture.choice.source.clip, 'c1')
  const edited = applyOps(project, [{ op: 'update', id: 'c1', set: { title: { text: 'Changed while typing' } } }]).project
  assert.equal(librarySourceStatus(edited, capture, state).ok, false)
  assert.equal(capture.clip.title.text, 'Original source')
  assert.equal(librarySourceStatus(project, capture, { ...state, version: 4 }).ok, false)
  assert.equal(librarySourceStatus(project, capture, { ...state, root: '/second' }).ok, false)
  const refreshed = captureLibrarySource(project, librarySaveChoices(project, ['c2'])[0], { ...state, selection: ['c2'] })
  assert.equal(librarySourceStatus(project, refreshed, { ...state, selection: ['c2'] }).ok, true)
  const saved = applyOps(project, [{ op: 'library_save', name: 'Explicitly refreshed', category: refreshed.choice.category, source: refreshed.choice.source }]).project
  assert.equal(saved.library.items[0].body.clip.title.text, 'Different source')
})

test('a captured composition source rejects a changed nested dependency at the same local version', () => {
  const project = applyOps(newProject('Nested source'), [{ op: 'add_comp', name: 'Inner', duration: 4 }, { op: 'add_title', comp: 'k1', text: 'Inner title', start: 0, dur: 4 }, { op: 'add_comp', name: 'Outer', duration: 4 }, { op: 'comp_clip', comp: 'k2', target: 'k1', track: 'V1', start: 0, dur: 4 }]).project
  const state = { root: '/first', version: 2, selection: [], composition: 'k2' }
  const capture = captureLibrarySource(project, librarySaveChoices(project, [], 'k2')[0], state)
  const edited = applyOps(project, [{ op: 'update', id: 'c1', set: { title: { font: 'Didot' } } }]).project
  assert.equal(librarySourceStatus(edited, capture, state).ok, false)
  assert.equal(librarySourceStatus(project, capture, state).ok, true)
})
