import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const editor = process.env.ARYA_TEST_EDITOR_ROOT ? new URL(`file://${process.env.ARYA_TEST_EDITOR_ROOT}/`) : new URL('../', import.meta.url)
registerHooks({ resolve(spec, context, next) { return next(spec.startsWith('/core/') ? new URL(`.${spec}`, editor).href : spec, context) } })
const { applyOps, compView, findClip, newProject, valueAt } = await import(new URL('core/project.js', editor))
const { framePlan } = await import(new URL('core/render-plan.js', editor))
const { duplicateCompOps } = await import(new URL('web/ui/motion/ops.js', editor))
const run = (project, ops) => applyOps(project, ops).project
const source = () => run(newProject('Duplicate fixture'), [{ op: 'add_comp', name: 'Authored comp', duration: 4 }])
const copy = project => { const plan = duplicateCompOps(project, 'k1'); return { plan, project: run(project, plan.ops) } }

test('Duplicate composition retains editable captions, their style and internal source provenance', () => {
  let project = run(source(), [
    { op: 'import', assets: { 'media/source.mp4': { hasVideo: true, hasAudio: false, duration: 8 } } },
    { op: 'add_clip', comp: 'k1', track: 'V1', src: 'media/source.mp4', start: 0, in: 2, dur: 4, audio: false },
    { op: 'captions', comp: 'k1', burnIn: true, style: { font: 'Inter', size: 26, preset: 'karaoke' }, items: [
      { t: 0.5, end: 2.5, text: 'Editable words', words: [{ t: 0.5, end: 1.2, text: 'Editable' }, { t: 1.2, end: 2.5, text: 'words' }], source: { src: 'media/source.mp4', clip: 'c1' } },
    ] },
  ])
  const before = structuredClone(project)
  const result = copy(project)
  const track = result.project.comps[result.plan.id].tracks.find(track => track.kind === 'caption')
  assert.ok(track, 'The duplicate must keep its caption track')
  assert.equal(track.burnIn, true)
  assert.deepEqual(track.style, project.comps.k1.tracks.find(track => track.kind === 'caption').style)
  assert.equal(track.clips[0].source.clip, result.plan.ids.get('c1'))
  assert.deepEqual(track.clips[0].words, findClip(project, 'c2').clip.words)
  assert.deepEqual(framePlan(result.project, 1, result.plan.id).captions, framePlan(project, 1, 'k1').captions)
  project = run(result.project, [{ op: 'update', id: track.clips[0].id, set: { text: 'Copied words' } }])
  assert.equal(findClip(project, 'c2').clip.text, 'Editable words')
  assert.deepEqual(result.project.comps.k1, before.comps.k1)
})

test('Duplicate composition keeps track processing, mute/solo state, and composition color settings', () => {
  const project = run(source(), [
    { op: 'update_comp', target: 'k1', set: { colorSpace: 'rec2020', note: 'Authored color intent' } },
    { op: 'update_track', comp: 'k1', id: 'A1', set: { name: 'Dialog', volume: -9, pan: 0.25, muted: true, solo: true, effects: [{ type: 'compressor', params: { threshold: -18, ratio: 3 } }] } },
    { op: 'update_track', comp: 'k1', id: 'V2', set: { muted: true, soloHidden: true } },
  ])
  const result = copy(project)
  assert.deepEqual(result.project.comps[result.plan.id].tracks.find(track => track.id === 'A1'), project.comps.k1.tracks.find(track => track.id === 'A1'))
  assert.equal(result.project.comps[result.plan.id].tracks.find(track => track.id === 'V2').muted, true)
  assert.equal(result.project.comps[result.plan.id].colorSpace, 'rec2020')
  assert.equal(result.project.comps[result.plan.id].note, 'Authored color intent')
})

test('Duplicate composition rewrites ID-based layer expressions to the copied layers', () => {
  let project = run(source(), [
    { op: 'add_null', comp: 'k1', track: 'V1', start: 0, dur: 4, name: 'Controller', set: { x: 110 } },
    { op: 'add_shape', comp: 'k1', track: 'V2', start: 0, dur: 4 },
    { op: 'expression', id: 'c2', prop: 'x', expr: 'layer("c1").x + 20' },
  ])
  const result = copy(project)
  const copied = findClip(result.project, result.plan.ids.get('c2')).clip
  assert.equal(valueAt(compView(result.project, result.plan.id), copied, 'x', 1), 130)
  project = run(result.project, [{ op: 'update', id: result.plan.ids.get('c1'), set: { x: 300 } }])
  assert.equal(valueAt(compView(project, result.plan.id), findClip(project, copied.id).clip, 'x', 1), 320)
  assert.equal(valueAt(compView(project, 'k1'), findClip(project, 'c2').clip, 'x', 1), 130)
})

test('Duplicate composition keeps copied video/audio links independent of the original group', () => {
  let project = run(source(), [
    { op: 'import', assets: { 'media/sync.mp4': { hasVideo: true, hasAudio: true, duration: 8 } } },
    { op: 'add_clip', comp: 'k1', track: 'V1', src: 'media/sync.mp4', start: 0, dur: 2 },
  ])
  const originals = project.comps.k1.tracks.flatMap(track => track.clips)
  const result = copy(project)
  const copiedVideo = findClip(result.project, result.plan.ids.get(originals.find(clip => clip.kind === 'video').id)).clip
  const copiedAudio = findClip(result.project, result.plan.ids.get(originals.find(clip => clip.kind === 'audio').id)).clip
  assert.ok(copiedVideo.link, 'The copied sync pair must remain linked')
  assert.equal(copiedVideo.link, copiedAudio.link)
  assert.notEqual(copiedVideo.link, originals[0].link)
  project = run(result.project, [{ op: 'move', id: copiedVideo.id, start: 1 }])
  assert.equal(findClip(project, copiedAudio.id).clip.start, 1)
  assert.equal(findClip(project, originals[0].id).clip.start, 0)
})

test('Duplicate composition preserves multiple caption tracks and locks only after copying', () => {
  const project = run(source(), [
    { op: 'captions', comp: 'k1', track: 'C1', burnIn: true, items: [{ t: 0, end: 2, text: 'Primary' }] },
    { op: 'captions', comp: 'k1', track: 'C2', burnIn: false, items: [{ t: 0, end: 2, text: 'Alternate' }] },
    { op: 'update_track', comp: 'k1', id: 'C2', set: { locked: true, name: 'Alternate language' } },
  ])
  const result = copy(project)
  const tracks = result.project.comps[result.plan.id].tracks.filter(track => track.kind === 'caption')
  assert.equal(tracks.length, 2)
  assert.deepEqual(tracks.map(track => track.clips[0].text), ['Primary', 'Alternate'])
  assert.equal(tracks[1].locked, true)
  assert.equal(tracks[1].name, 'Alternate language')
  assert.deepEqual(framePlan(result.project, 1, result.plan.id).captions.map(caption => caption.text), ['Primary'])
})

test('Duplicate composition preserves valid long expression source without exceeding the parser limit', () => {
  const expression = Array(400).fill('1').join('+') + '+layer("c1").x'
  const project = run(source(), [
    { op: 'add_null', comp: 'k1', track: 'V1', start: 0, dur: 4, set: { x: 110 } },
    { op: 'add_shape', comp: 'k1', track: 'V2', start: 0, dur: 4, set: { x: 10 } },
    { op: 'expression', id: 'c2', prop: 'x', expr: expression },
  ])
  const result = copy(project), copied = findClip(result.project, result.plan.ids.get('c2')).clip
  assert.equal(copied.expr.x, expression.replace('"c1"', `"${result.plan.ids.get('c1')}"`))
  assert.equal(valueAt(compView(result.project, result.plan.id), copied, 'x', 1), 510)
})

test('Duplicate composition remaps conditional layer names and preserves other string arguments', () => {
  const expression = 'layer(time > 0 ? "c1" : \'c1\').x + 20 + loopOut("cycle") * 0'
  const project = run(source(), [
    { op: 'add_null', comp: 'k1', track: 'V1', start: 0, dur: 4, set: { x: 110 } },
    { op: 'add_shape', comp: 'k1', track: 'V2', start: 0, dur: 4, set: { x: 10 } },
    { op: 'expression', id: 'c2', prop: 'x', expr: expression },
  ])
  const result = copy(project), copied = findClip(result.project, result.plan.ids.get('c2')).clip
  const id = result.plan.ids.get('c1')
  assert.equal(copied.expr.x, `layer(time > 0 ? "${id}" : '${id}').x + 20 + loopOut("cycle") * 0`)
  for (const at of [0, 1]) assert.equal(valueAt(compView(result.project, result.plan.id), copied, 'x', at), 130)
})
