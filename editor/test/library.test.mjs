import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { nativeFigmaImport } from '../core/figma-native.js'
import { allClips, applyOps, compView, findClip, newProject, nodeOrder, valueAt } from '../core/project.js'
import { framePlan } from '../core/render-plan.js'

const run = (project, ops) => applyOps(project, ops).project
const clip = (project, id) => findClip(project, id)?.clip
const items = project => project.library?.items ?? []
const item = (project, name) => items(project).find(entry => entry.name === name)
const copyJSON = value => JSON.parse(JSON.stringify(value))
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} differs from ${expected}`)

function project() {
  const p = newProject('Reusable edit', { width: 320, height: 180, fps: 30 })
  p.assets = {
    'media/one.mp4': { duration: 20, width: 320, height: 180, fps: 30, hasVideo: true, hasAudio: false },
    'media/tone.wav': { duration: 20, hasVideo: false, hasAudio: true },
  }
  return run(p, [
    { op: 'add_clip', src: 'media/one.mp4', track: 'V1', start: 0, dur: 4 },
    { op: 'add_clip', src: 'media/one.mp4', track: 'V1', start: 4, dur: 8 },
    { op: 'add_clip', src: 'media/tone.wav', track: 'A1', start: 0, dur: 12 },
    { op: 'add_title', track: 'V3', start: 2, dur: 4, text: 'Editable heading', title: { anim: 'none', font: 'Inter', weight: 600, size: 28, align: 'left' }, set: { x: 90, y: 60 } },
  ])
}

function save(project, category, source, name = category, extra = {}) {
  const result = run(project, [{ op: 'library_save', category, name, description: `Reusable ${category}`, source, ...extra }])
  assert.ok(item(result, name), `${name} was not saved`)
  return result
}

function createdClip(before, after, kind) {
  const ids = new Set(allClips(before, true).map(row => row.clip.id))
  return allClips(after, true).map(row => row.clip).find(c => !ids.has(c.id) && (!kind || c.kind === kind))
}

function expectAtomicFailure(project, ops, pattern) {
  const before = structuredClone(project)
  if (pattern) assert.throws(() => applyOps(project, ops), pattern)
  else assert.throws(() => applyOps(project, ops))
  assert.deepEqual(project, before, 'a failed operation changed its input project')
}

test('saving a title captures its editable values without changing the source or sharing objects', () => {
  let p = project()
  p = run(p, [
    { op: 'keyframe', id: 'c4', prop: 'opacity', local: true, at: 0, value: 0 },
    { op: 'keyframe', id: 'c4', prop: 'opacity', local: true, at: 1, value: 1, ease: 'inOut' },
    { op: 'add_mask', id: 'c4', mask: { type: 'rect', x: 0, y: 0, w: 160, h: 40 } },
  ])
  const before = structuredClone(p)
  const q = save(p, 'title', { clip: 'c4' }, 'Heading')
  assert.deepEqual(p, before)
  assert.deepEqual(clip(q, 'c4'), clip(before, 'c4'))
  assert.equal(q.library.version, 1)
  const saved = item(q, 'Heading')
  assert.equal(saved.category, 'title')
  assert.equal(saved.body.clip.title.font, 'Inter')
  assert.deepEqual(saved.body.clip.anim.opacity, [[0, 0], [1, 1, 'inOut']])
  saved.body.clip.title.text = 'Library only'
  saved.body.clip.masks[0].w = 80
  assert.equal(clip(q, 'c4').title.text, 'Editable heading')
  assert.equal(clip(q, 'c4').masks[0].w, 160)
})

test('a placed title has a fresh identity and renders its saved keyframes at the new start', () => {
  let p = project()
  p = run(p, [
    { op: 'keyframe', id: 'c4', prop: 'x', at: 0, local: true, value: 20 },
    { op: 'keyframe', id: 'c4', prop: 'x', at: 2, local: true, value: 100 },
  ])
  p = save(p, 'title', { clip: 'c4' }, 'Slide heading')
  const saved = structuredClone(item(p, 'Slide heading'))
  const result = applyOps(p, [{ op: 'library_apply', item: saved.id, track: 'V2', start: 8 }])
  const placed = createdClip(p, result.project, 'title')
  assert.ok(placed)
  assert.ok(result.created.includes(placed.id))
  assert.notEqual(placed.id, 'c4')
  assert.equal(placed.start, 8)
  assert.equal(placed.dur, 4)
  assert.deepEqual(placed.anim.x, [[0, 20], [2, 100]])
  const resolved = framePlan(result.project, 9).layers.find(layer => layer.clip?.id === placed.id).clip
  close(resolved.matrix[4], 60)
  assert.equal(resolved.title.text, 'Editable heading')
  const edited = run(result.project, [{ op: 'update', id: placed.id, set: { title: { text: 'Copy changed' } } }])
  assert.equal(clip(edited, 'c4').title.text, 'Editable heading')
  assert.deepEqual(item(edited, 'Slide heading'), saved)
})

test('library rename and remove survive a JSON roundtrip and leave placed copies intact', () => {
  const p = save(project(), 'title', { clip: 'c4' }, 'Original name')
  const id = item(p, 'Original name').id
  const placed = run(copyJSON(p), [{ op: 'library_apply', item: id, start: 12, track: 'V2' }])
  const copy = createdClip(p, placed, 'title')
  const renamed = run(placed, [{ op: 'library_rename', item: id, name: 'Lower third', description: 'A short editable heading' }])
  assert.equal(item(renamed, 'Lower third').id, id)
  assert.equal(item(renamed, 'Lower third').description, 'A short editable heading')
  assert.equal(clip(renamed, copy.id).title.text, 'Editable heading')
  const removed = run(copyJSON(renamed), [{ op: 'library_remove', item: id }])
  assert.equal(items(removed).length, 0)
  assert.deepEqual(clip(removed, copy.id), clip(placed, copy.id))
  assert.deepEqual(clip(removed, 'c4'), clip(p, 'c4'))
  expectAtomicFailure(removed, [{ op: 'library_apply', item: id }])
})

test('registered declarative title templates use the same placement path as saved templates', () => {
  const saved = save(project(), 'title', { clip: 'c4' }, 'Saved heading')
  const body = structuredClone(item(saved, 'Saved heading').body)
  const base = project()
  const registered = run(base, [{ op: 'library_register', item: { name: 'Agent heading', category: 'title', description: 'Native text and animation', body } }])
  const template = item(registered, 'Agent heading')
  const placed = run(registered, [{ op: 'library_apply', item: template.id, start: 9, track: 'V2' }])
  assert.equal(createdClip(registered, placed, 'title').title.font, 'Inter')
  assert.deepEqual(items(base), [])
  body.clip.title.text = 'Caller changed'
  assert.equal(template.body.clip.title.text, 'Editable heading')
})

function figmaProject() {
  const box = (x, y, width, height) => ({ absoluteBoundingBox: { x, y, width, height } })
  const white = { type: 'SOLID', color: { r: 1, g: 1, b: 1 } }
  const frame = {
    id: '10:1', type: 'FRAME', name: 'Figma card', ...box(0, 0, 320, 180), fills: [],
    children: [{
      id: '10:2', type: 'FRAME', name: 'Clipped card', clipsContent: true, ...box(20, 20, 280, 140), fills: [],
      children: [
        { id: '10:3', type: 'RECTANGLE', name: 'Portrait', ...box(20, 20, 60, 60), fills: [{ type: 'IMAGE', imageRef: 'portrait-fill', scaleMode: 'FILL' }] },
        { id: '10:4', type: 'RECTANGLE', name: 'Matte', ...box(80, 30, 160, 60), fills: [white] },
        { id: '10:5', type: 'TEXT', name: 'Figma heading', characters: 'Reusable Figma', ...box(90, 40, 180, 40), fills: [white], style: { fontFamily: 'IBM Plex Sans', fontWeight: 600, fontSize: 24, textAlignHorizontal: 'LEFT' } },
      ],
    }],
  }
  const p = newProject('Figma library', { width: 320, height: 180, fps: 30 })
  const imported = nativeFigmaImport(p, frame, {
    duration: 4,
    images: { '10:3': { src: 'media/figma/portrait.png', width: 120, height: 120 } },
    assets: {
      'media/figma/portrait.png': { width: 120, height: 120, hasVideo: true, hasAudio: false, still: true },
      'media/unused.png': { width: 10, height: 10, hasVideo: true, still: true },
    },
  })
  let q = run(p, imported.ops)
  const title = allClips(q, true).find(row => row.clip.kind === 'title')
  const matte = q.comps[title.comp].tracks.flatMap(track => track.clips).find(c => c.kind === 'shape')
  q = run(q, [
    { op: 'parent', id: title.clip.id, parent: matte.id },
    { op: 'matte', id: title.clip.id, matte: { source: matte.id, mode: 'alpha' } },
    { op: 'link', ids: [title.clip.id, matte.id] },
    { op: 'add_mask', id: title.clip.id, mask: { type: 'rect', x: 0, y: 0, w: 180, h: 40 } },
    { op: 'node_add', id: title.clip.id, node: { type: 'blur', radius: 3 } },
    { op: 'node_add', id: title.clip.id, node: { type: 'corrector', window: { type: 'rect', x: 0.25, y: 0.5, w: 0.5, h: 0.5 } } },
    { op: 'keyframe', id: title.clip.id, prop: 'mask.mk1.x', at: 0, local: true, value: 0 },
    { op: 'keyframe', id: title.clip.id, prop: 'mask.mk1.x', at: 2, local: true, value: 20 },
    { op: 'keyframe', id: title.clip.id, prop: 'node.n4.radius', at: 0, local: true, value: 2 },
    { op: 'keyframe', id: title.clip.id, prop: 'node.n4.radius', at: 2, local: true, value: 6 },
    { op: 'keyframe', id: title.clip.id, prop: 'node.n5.window.x', at: 0, local: true, value: 0.25 },
    { op: 'keyframe', id: title.clip.id, prop: 'node.n5.window.x', at: 2, local: true, value: 0.75 },
  ])
  clip(q, title.clip.id).expr = { x: `layer("${matte.id}").x + 10` }
  return { project: q, root: imported.comp, title: title.clip.id, matte: matte.id }
}

test('a Figma composition copy keeps native hierarchy, fonts and source notes while remapping references', () => {
  const source = figmaProject()
  const p = save(source.project, 'composition', { composition: source.root }, 'Figma card')
  const original = structuredClone(p)
  const template = item(p, 'Figma card')
  assert.deepEqual(Object.keys(template.body.assets), ['media/figma/portrait.png'])
  const applied = run(p, [{ op: 'library_apply', item: template.id, start: 6, track: 'V1' }])
  const placed = createdClip(p, applied, 'comp')
  assert.ok(placed)
  assert.notEqual(placed.comp, source.root)
  const nestedHost = applied.comps[placed.comp].tracks.flatMap(track => track.clips).find(c => c.kind === 'comp')
  assert.ok(nestedHost, 'the clipped Figma frame remains a composition')
  const layers = applied.comps[nestedHost.comp].tracks.flatMap(track => track.clips)
  const title = layers.find(c => c.kind === 'title')
  const matte = layers.find(c => c.note === clip(p, source.matte).note)
  assert.equal(title.title.font, 'IBM Plex Sans')
  assert.equal(title.title.text, 'Reusable Figma')
  assert.equal(title.note, 'figma 10:5')
  assert.notEqual(title.id, source.title)
  assert.notEqual(matte.id, source.matte)
  assert.equal(title.parent, matte.id)
  assert.deepEqual(title.parentRef, clip(p, source.title).parentRef)
  assert.equal(title.matte.source, matte.id)
  assert.deepEqual(matte.shape, clip(p, source.matte).shape)
  assert.equal(title.link, matte.link)
  assert.notEqual(title.link, clip(p, source.title).link)
  assert.ok(title.expr.x.includes(`"${matte.id}"`))
  assert.ok(!title.expr.x.includes(`"${source.matte}"`))
  const mask = title.masks[0]
  const blur = title.nodes.list.find(node => node.type === 'blur')
  const corrector = title.nodes.list.find(node => node.type === 'corrector')
  assert.notEqual(mask.id, clip(p, source.title).masks[0].id)
  assert.notEqual(blur.id, clip(p, source.title).nodes.list.find(node => node.type === 'blur').id)
  assert.deepEqual(title.anim[`mask.${mask.id}.x`], [[0, 0], [2, 20]])
  assert.deepEqual(title.anim[`node.${blur.id}.radius`], [[0, 2], [2, 6]])
  assert.deepEqual(title.anim[`node.${corrector.id}.window.x`], [[0, 0.25], [2, 0.75]])
  const ids = allClips(applied, true).map(row => row.clip.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(p, original)
  const view = compView(applied, nestedHost.comp)
  const resolved = framePlan(view, 1).layers.find(layer => layer.clip?.id === title.id).clip
  assert.equal(resolved.masks[0].x, 10)
  close(valueAt(view, title, `node.${blur.id}.radius`, 1), 4)
  close(resolved.nodes.list.find(node => node.type === 'corrector').window.x, 0.5)
  close(valueAt(view, title, 'x', 1), valueAt(view, matte, 'x', 1) + 10)
})

test('saved composition dependencies remain usable after source compositions and asset records are removed', () => {
  const source = figmaProject()
  const p = save(source.project, 'composition', { composition: source.root }, 'Independent card')
  const template = item(p, 'Independent card')
  const reloaded = copyJSON(p)
  reloaded.comps = {}
  delete reloaded.assets['media/figma/portrait.png']
  const applied = run(reloaded, [{ op: 'library_apply', item: template.id, start: 0, track: 'V1' }])
  assert.deepEqual(applied.assets['media/figma/portrait.png'], p.assets['media/figma/portrait.png'])
  const root = applied.tracks[0].clips.find(c => c.kind === 'comp')
  assert.ok(applied.comps[root.comp])
  assert.ok(allClips(applied, true).some(row => row.clip.src === 'media/figma/portrait.png'))
  assert.deepEqual(reloaded.comps, {})
})

function captionedCompositionProject() {
  let p = run(project(), [
    { op: 'add_comp', name: 'Captioned composition', duration: 4 },
    { op: 'add_clip', comp: 'k1', track: 'V1', src: 'media/one.mp4', start: 0, dur: 4 },
  ])
  const media = p.comps.k1.tracks[0].clips[0]
  p = run(p, [{ op: 'captions', comp: 'k1', burnIn: true, style: { font: 'Inter', size: 20, preset: 'karaoke' }, items: [
    { t: 0.5, end: 2.5, text: 'Editable words', words: [{ t: 0.5, end: 1.2, text: 'Editable' }, { t: 1.2, end: 2.5, text: 'words' }], source: { src: media.src, clip: media.id } },
    { t: 2.5, end: 3.5, text: 'Timed provenance', source: { src: media.src, from: 6, to: 7 } },
  ] }])
  p = save(p, 'composition', { composition: 'k1' }, 'Captioned component')
  return { project: p, template: item(p, 'Captioned component'), media: media.id }
}

test('copied captioned compositions preserve editable words, source timing and internal provenance references', () => {
  const source = captionedCompositionProject()
  const p = source.project
  assert.deepEqual(Object.keys(source.template.body.assets), ['media/one.mp4'])
  const applied = run(p, [{ op: 'library_apply', item: source.template.id, track: 'V2', start: 6 }])
  const placed = createdClip(p, applied, 'comp')
  const layers = applied.comps[placed.comp].tracks.flatMap(t => t.clips)
  const media = layers.find(c => c.kind === 'video')
  const captions = layers.filter(c => c.kind === 'caption')
  assert.equal(captions.length, 2)
  assert.equal(captions[0].text, 'Editable words')
  assert.deepEqual(captions[0].words, [{ t: 0, end: 0.7, text: 'Editable' }, { t: 0.7, end: 2, text: 'words' }])
  assert.deepEqual(captions[0].source, { src: 'media/one.mp4', clip: media.id })
  assert.notEqual(media.id, source.media)
  assert.deepEqual(captions[1].source, { src: 'media/one.mp4', from: 6, to: 7 })
  const rendered = framePlan(applied, 7).layers.find(layer => layer.clip?.id === placed.id).clip.composition.captions[0]
  assert.equal(rendered.title.font, 'Inter')
  assert.equal(rendered.title.text, 'Editable words')
  assert.deepEqual(rendered.title.highlight, { start: 0, end: 8, color: '#ffe600' })
  const edited = run(applied, [{ op: 'update', id: captions[0].id, set: { text: 'Changed words' } }])
  const original = p.comps.k1.tracks.flatMap(t => t.clips).find(c => c.kind === 'caption')
  assert.equal(clip(edited, original.id).text, 'Editable words')
  assert.equal(clip(edited, captions[0].id).text, 'Changed words')
})

test('caption provenance rejects unsafe paths, malformed timing pairs and invalid metadata atomically', async t => {
  const source = captionedCompositionProject()
  const cases = [
    ['absolute source', { src: '/tmp/outside.mp4', from: 0, to: 1 }],
    ['escaping source', { src: '../outside.mp4', from: 0, to: 1 }],
    ['missing source', { from: 0, to: 1 }],
    ['incomplete timing', { src: 'media/one.mp4', from: 0 }],
    ['backward timing', { src: 'media/one.mp4', from: 2, to: 1 }],
    ['invalid clip metadata', { src: 'media/one.mp4', clip: { id: source.media } }],
    ['unknown provenance field', { src: 'media/one.mp4', script: 'alert(1)' }],
  ]
  for (const [name, provenance] of cases) await t.test(name, () => {
    const body = structuredClone(source.template.body)
    const caption = body.comps.k1.tracks.flatMap(t => t.clips).find(c => c.kind === 'caption')
    caption.source = provenance
    expectAtomicFailure(source.project, [{ op: 'library_register', item: { name, category: 'composition', body } }])
  })
})

test('two composition applications have independent editable layers and no shared IDs', () => {
  const source = figmaProject()
  const p = save(source.project, 'composition', { composition: source.root }, 'Figma copies')
  const id = item(p, 'Figma copies').id
  const first = run(p, [{ op: 'library_apply', item: id, start: 0, track: 'V1' }])
  const second = run(first, [{ op: 'library_apply', item: id, start: 5, track: 'V1' }])
  const firstTitle = createdClip(p, first, 'title')
  const secondTitle = createdClip(first, second, 'title')
  assert.notEqual(firstTitle.id, secondTitle.id)
  const edited = run(second, [{ op: 'update', id: secondTitle.id, set: { title: { text: 'Second card' } } }])
  assert.equal(clip(edited, firstTitle.id).title.text, 'Reusable Figma')
  assert.equal(clip(edited, source.title).title.text, 'Reusable Figma')
  assert.equal(clip(edited, secondTitle.id).title.text, 'Second card')
})

test('a layered title can be saved from a composition clip and placed inside another composition', () => {
  const source = figmaProject()
  let p = run(source.project, [
    { op: 'comp_clip', target: source.root, track: 'V1', start: 0, dur: 4 },
    { op: 'add_comp', name: 'Destination', duration: 10 },
  ])
  const host = p.tracks[0].clips.find(c => c.kind === 'comp')
  const destination = Object.values(p.comps).find(comp => comp.name === 'Destination').id
  p = run(p, [
    { op: 'update', id: host.id, set: { scale: 0.75, opacity: 0.6 } },
    { op: 'keyframe', id: host.id, prop: 'x', local: true, at: 0, value: 20 },
    { op: 'keyframe', id: host.id, prop: 'x', local: true, at: 2, value: 120 },
  ])
  p = save(p, 'title', { clip: host.id }, 'Layered title')
  const originalRoot = structuredClone(p.tracks)
  const applied = run(p, [{ op: 'library_apply', item: item(p, 'Layered title').id, comp: destination, track: 'V2', start: 2 }])
  const placed = applied.comps[destination].tracks.find(track => track.id === 'V2').clips[0]
  assert.equal(placed.kind, 'comp')
  assert.equal(placed.start, 2)
  assert.equal(placed.dur, 4)
  assert.equal(placed.scale, 0.75)
  assert.equal(placed.opacity, 0.6)
  assert.deepEqual(placed.anim.x, [[0, 20], [2, 120]])
  assert.notEqual(placed.comp, source.root)
  assert.deepEqual(applied.tracks, originalRoot)
  assert.equal(applied.width, p.width)
  assert.equal(applied.height, p.height)
  const rendered = framePlan(applied, 3, destination).layers[0].clip
  assert.ok(rendered.composition.layers.length)
  close(rendered.matrix[4], 70)
})

test('a standalone title with an external layer dependency cannot be saved as an incomplete template', () => {
  const p = run(project(), [{ op: 'parent', id: 'c4', parent: 'c1' }])
  expectAtomicFailure(p, [{ op: 'library_save', category: 'title', name: 'Incomplete', source: { clip: 'c4' } }])
  const expr = project()
  clip(expr, 'c4').expr = { x: 'layer("c1").x + 10' }
  expectAtomicFailure(expr, [{ op: 'library_save', category: 'title', name: 'External expression', source: { clip: 'c4' } }])
})

test('copied layer expressions remap multiline, quoted and literal-backslash names to the new clip', async t => {
  const names = [
    ['multiline', 'First\nSecond', 'layer("First\nSecond").x + 20'],
    ['quoted', 'A "quoted" line', 'layer(\'A "quoted" line\').x + 20'],
    ['backslash', 'Folder\\Deck', 'layer("Folder\\Deck").x + 20'],
    ['literal escape', 'First\\nSecond', 'layer("First\\nSecond").x + 20'],
  ]
  for (const [name, text, expression] of names) await t.test(name, () => {
    let p = run(project(), [{ op: 'update', id: 'c4', set: { title: { text } } }])
    clip(p, 'c4').expr = { x: expression }
    p = save(p, 'title', { clip: 'c4' }, `${name} expression`)
    const template = item(p, `${name} expression`)
    p = run(p, [{ op: 'update', id: 'c4', set: { x: 500 } }])
    const applied = run(p, [{ op: 'library_apply', item: template.id, track: 'V2', start: 8 }])
    const copy = createdClip(p, applied, 'title')
    assert.equal(copy.title.text, text)
    assert.ok(copy.expr.x.includes(`"${copy.id}"`))
    close(valueAt(applied, copy, 'x', 1), 110)
    const changed = run(applied, [{ op: 'update', id: copy.id, set: { x: 200 } }])
    close(valueAt(changed, clip(changed, copy.id), 'x', 1), 220)
    assert.equal(clip(changed, 'c4').x, 500)
    assert.equal(clip(changed, 'c4').expr.x, expression)
  })
})

test('effect templates append native effects and graph processing without removing the target work', () => {
  let p = project()
  p = run(p, [
    { op: 'effect', id: 'c1', type: 'glow', params: { amount: 0.25, radius: 9 } },
    { op: 'node_add', id: 'c1', node: { type: 'blur', radius: 5 } },
    { op: 'effect', id: 'c2', type: 'vignette', params: { amount: 0.4 } },
    { op: 'node_add', id: 'c2', node: { type: 'sharpen', amount: 0.7 } },
    { op: 'update', id: 'c2', set: { grade: { exposure: 0.3 } } },
  ])
  p = save(p, 'effect', { clip: 'c1' }, 'Glow and blur')
  const targetBefore = structuredClone(clip(p, 'c2'))
  const applied = run(p, [{ op: 'library_apply', item: item(p, 'Glow and blur').id, id: 'c2' }])
  const target = clip(applied, 'c2')
  assert.equal(target.effects[0].type, 'vignette')
  assert.equal(target.effects[1].type, 'glow')
  assert.deepEqual(target.grade, targetBefore.grade)
  assert.deepEqual(nodeOrder(target.nodes).map(node => node.type), ['source', 'primary', 'sharpen', 'corrector', 'blur', 'output'])
  assert.deepEqual(target.nodes.list.find(node => node.id === 'n4'), targetBefore.nodes.list.find(node => node.id === 'n4'))
  assert.equal(new Set(target.nodes.list.map(node => node.id)).size, target.nodes.list.length)
  const resolved = framePlan(applied, 5).layers.find(layer => layer.clip?.id === 'c2').clip
  assert.equal(resolved.fx.glow, 0.25)
  assert.equal(resolved.fx.vignette, 0.4)
  assert.equal(resolved.nodes.list.find(node => node.type === 'blur').radius, 5)
  assert.deepEqual(clip(applied, 'c1'), clip(p, 'c1'))
})

test('a saved effect index copies that effect without copying unrelated effects', () => {
  let p = run(project(), [
    { op: 'effect', id: 'c1', type: 'blur', params: { radius: 6 } },
    { op: 'effect', id: 'c1', type: 'grain', params: { amount: 0.12 } },
  ])
  p = save(p, 'effect', { clip: 'c1' }, 'Grain only', { index: 1 })
  const applied = run(p, [{ op: 'library_apply', item: item(p, 'Grain only').id, id: 'c2' }])
  assert.deepEqual(clip(applied, 'c2').effects.map(effect => effect.type), ['grain'])
  assert.equal(clip(applied, 'c2').effects[0].params.amount, 0.12)
})

function animatedEffectProject() {
  let p = run(project(), [
    { op: 'node_add', id: 'c1', node: { type: 'blur', radius: 2 } },
    { op: 'keyframe', id: 'c1', prop: 'node.n4.radius', local: true, at: 0, value: 2 },
    { op: 'keyframe', id: 'c1', prop: 'node.n4.radius', local: true, at: 4, value: 10 },
  ])
  p = save(p, 'effect', { clip: 'c1' }, 'Animated blur')
  return { project: p, template: item(p, 'Animated blur') }
}

test('animated effect registration rejects missing or nonpositive source duration before retiming', async t => {
  const source = animatedEffectProject()
  for (const [name, duration] of [['missing', undefined], ['zero', 0], ['negative', -1]]) await t.test(name, () => {
    const body = structuredClone(source.template.body)
    if (duration === undefined) delete body.settings.dur
    else body.settings.dur = duration
    if (duration === 0) body.settings.anim = { 'node.n4.radius': [[0, 2]] }
    expectAtomicFailure(source.project, [{ op: 'library_register', item: { name: `${name} duration`, category: 'effect', body } }])
  })
})

test('animated effect applications keep finite editable keyframes scaled to a longer target clip', () => {
  const source = animatedEffectProject()
  const applied = run(source.project, [{ op: 'library_apply', item: source.template.id, id: 'c2' }])
  const target = clip(applied, 'c2')
  const node = target.nodes.list.find(n => n.type === 'blur')
  const prop = `node.${node.id}.radius`
  assert.deepEqual(target.anim[prop], [[0, 2], [8, 10]])
  close(valueAt(applied, target, prop, 4), 6)
  assert.ok(target.anim[prop].flat().every(Number.isFinite))
  assert.deepEqual(clip(applied, 'c1'), clip(source.project, 'c1'))
})

test('left-trimmed motion keeps the off-clip boundary key and renders the same boundary interpolation after retiming', () => {
  let p = run(project(), [
    { op: 'update', id: 'c4', set: { start: 0 } },
    { op: 'update', id: 'c2', set: { dur: 6 } },
    { op: 'keyframe', id: 'c4', prop: 'opacity', local: true, at: 0, value: 0 },
    { op: 'keyframe', id: 'c4', prop: 'opacity', local: true, at: 4, value: 1 },
    { op: 'trim', id: 'c4', edge: 'left', to: 1 },
  ])
  assert.equal(clip(p, 'c4').dur, 3)
  assert.deepEqual(clip(p, 'c4').anim.opacity, [[-1, 0], [3, 1]])
  close(valueAt(p, clip(p, 'c4'), 'opacity', 0), 0.25)
  p = save(p, 'motion', { clip: 'c4' }, 'Trimmed motion')
  const template = item(p, 'Trimmed motion')
  assert.deepEqual(template.body.settings.anim.opacity, [[-1, 0], [3, 1]])
  const applied = run(p, [{ op: 'library_apply', item: template.id, id: 'c2' }])
  assert.deepEqual(clip(applied, 'c2').anim.opacity, [[-2, 0], [6, 1]])
  close(valueAt(applied, clip(applied, 'c2'), 'opacity', 0), 0.25)
  close(framePlan(applied, 4).layers.find(layer => layer.clip?.id === 'c2').clip.opacity, 0.25)
  close(framePlan(applied, 7).layers.find(layer => layer.clip?.id === 'c2').clip.opacity, 0.625)
  assert.deepEqual(clip(applied, 'c4'), clip(p, 'c4'))
})

test('left-trimmed effect node curves retain off-clip keys and interpolate at the new target boundary', () => {
  let p = run(project(), [
    { op: 'update', id: 'c2', set: { dur: 6 } },
    { op: 'node_add', id: 'c1', node: { type: 'blur', radius: 2 } },
    { op: 'keyframe', id: 'c1', prop: 'node.n4.radius', local: true, at: 0, value: 2 },
    { op: 'keyframe', id: 'c1', prop: 'node.n4.radius', local: true, at: 4, value: 10 },
    { op: 'trim', id: 'c1', edge: 'left', to: 1 },
  ])
  assert.deepEqual(clip(p, 'c1').anim['node.n4.radius'], [[-1, 2], [3, 10]])
  p = save(p, 'effect', { clip: 'c1' }, 'Trimmed blur')
  const template = item(p, 'Trimmed blur')
  assert.deepEqual(template.body.settings.anim['node.n4.radius'], [[-1, 2], [3, 10]])
  const applied = run(p, [{ op: 'library_apply', item: template.id, id: 'c2' }])
  const target = clip(applied, 'c2')
  const blur = target.nodes.list.find(n => n.type === 'blur')
  const prop = `node.${blur.id}.radius`
  assert.deepEqual(target.anim[prop], [[-2, 2], [6, 10]])
  close(valueAt(applied, target, prop, 0), 4)
  close(framePlan(applied, 4).layers.find(layer => layer.clip?.id === 'c2').clip.nodes.list.find(n => n.type === 'blur').radius, 4)
  assert.deepEqual(clip(applied, 'c1'), clip(p, 'c1'))
})

test('right-trimmed motion and effect curves retain the key beyond the clip end and preserve end-boundary interpolation', async t => {
  for (const category of ['motion', 'effect']) await t.test(category, () => {
    const sourceID = category === 'motion' ? 'c4' : 'c1'
    const prop = category === 'motion' ? 'opacity' : 'node.n4.radius'
    const values = category === 'motion' ? [0, 1] : [2, 10]
    let p = run(project(), [
      { op: 'update', id: sourceID, set: { start: 0 } },
      { op: 'update', id: 'c2', set: { dur: 6 } },
      ...(category === 'effect' ? [{ op: 'node_add', id: sourceID, node: { type: 'blur', radius: 2 } }] : []),
      { op: 'keyframe', id: sourceID, prop, local: true, at: 0, value: values[0] },
      { op: 'keyframe', id: sourceID, prop, local: true, at: 4, value: values[1] },
      { op: 'trim', id: sourceID, edge: 'right', to: 3 },
    ])
    assert.equal(clip(p, sourceID).dur, 3)
    assert.deepEqual(clip(p, sourceID).anim[prop], [[0, values[0]], [4, values[1]]])
    p = save(p, category, { clip: sourceID }, `Right-trimmed ${category}`)
    const applied = run(p, [{ op: 'library_apply', item: item(p, `Right-trimmed ${category}`).id, id: 'c2' }])
    const target = clip(applied, 'c2')
    const mapped = category === 'motion' ? prop : `node.${target.nodes.list.find(n => n.type === 'blur').id}.radius`
    assert.deepEqual(target.anim[mapped], [[0, values[0]], [8, values[1]]])
    const atEnd = category === 'motion' ? 0.75 : 8
    close(valueAt(applied, target, mapped, target.dur), atEnd)
    const rendered = framePlan(applied, 9.5).layers.find(layer => layer.clip?.id === target.id).clip
    close(category === 'motion' ? rendered.opacity : rendered.nodes.list.find(n => n.type === 'blur').radius, category === 'motion' ? 0.6875 : 7.5)
    assert.deepEqual(clip(applied, sourceID), clip(p, sourceID))
  })
})

test('subnormal source durations either retime to finite bounded keys or reject the batch without mutation', async t => {
  const tiny = 1e-320
  const effect = animatedEffectProject().template
  for (const category of ['motion', 'effect']) for (const targetDuration of [8, 1e308]) await t.test(`${category}, target duration ${targetDuration}`, () => {
    const p = run(project(), [{ op: 'update', id: 'c2', set: { dur: targetDuration } }])
    const before = structuredClone(p)
    const body = category === 'motion'
      ? { assets: {}, settings: { kind: 'video', dur: tiny, anim: { x: [[0, 0], [tiny, 100]] } } }
      : structuredClone(effect.body)
    if (category === 'effect') {
      body.settings.dur = tiny
      body.settings.anim = { 'node.n4.radius': [[0, 2], [tiny, 10]] }
    }
    let result
    try {
      result = applyOps(p, [
        { op: 'library_register', item: { id: 'subnormal_component', name: 'Tiny timing', category, body } },
        { op: 'library_apply', item: 'subnormal_component', id: 'c2' },
      ])
    } catch (error) {
      assert.match(error.message, /duration|keyframe|timing|retime|finite/i)
    }
    assert.deepEqual(p, before)
    if (result) {
      const target = clip(result.project, 'c2')
      const keys = Object.values(target.anim).flat()
      assert.ok(keys.every(key => Number.isFinite(key[0]) && key[0] >= 0 && key[0] <= target.dur && Number.isFinite(key[1])))
      assert.equal(Math.max(...keys.map(key => key[0])), targetDuration)
    }
  })
})

test('motion templates retime editable keyframes to the target duration and keep other animations', () => {
  let p = run(project(), [
    { op: 'keyframe', id: 'c1', prop: 'x', local: true, at: 0, value: 20 },
    { op: 'keyframe', id: 'c1', prop: 'x', local: true, at: 4, value: 140 },
    { op: 'keyframe', id: 'c2', prop: 'opacity', local: true, at: 0, value: 0.5 },
    { op: 'keyframe', id: 'c2', prop: 'opacity', local: true, at: 8, value: 1 },
  ])
  p = save(p, 'motion', { clip: 'c1' }, 'Position move')
  const applied = run(p, [{ op: 'library_apply', item: item(p, 'Position move').id, id: 'c2' }])
  assert.deepEqual(clip(applied, 'c2').anim.x, [[0, 20], [8, 140]])
  assert.deepEqual(clip(applied, 'c2').anim.opacity, [[0, 0.5], [8, 1]])
  close(valueAt(applied, clip(applied, 'c2'), 'x', 4), 80)
  close(framePlan(applied, 8).layers[0].clip.matrix[4], 80)
  assert.equal(clip(applied, 'c2').start, 4)
})

test('motion rejects conflicting animation, expression and incompatible property kinds before editing', () => {
  let p = run(project(), [
    { op: 'keyframe', id: 'c1', prop: 'x', local: true, at: 0, value: 20 },
    { op: 'keyframe', id: 'c1', prop: 'x', local: true, at: 4, value: 140 },
  ])
  p = save(p, 'motion', { clip: 'c1' }, 'Position move')
  const id = item(p, 'Position move').id
  const conflict = run(p, [{ op: 'keyframe', id: 'c2', prop: 'x', local: true, at: 1, value: 70 }])
  expectAtomicFailure(conflict, [{ op: 'library_apply', item: id, id: 'c2' }])
  const expression = run(p, [{ op: 'expression', id: 'c2', prop: 'x', expr: 'value + time * 10' }])
  expectAtomicFailure(expression, [{ op: 'library_apply', item: id, id: 'c2' }])
  expectAtomicFailure(p, [{ op: 'library_apply', item: id, id: 'c3' }])
  let audio = run(project(), [
    { op: 'keyframe', id: 'c3', prop: 'volume', local: true, at: 0, value: -12 },
    { op: 'keyframe', id: 'c3', prop: 'volume', local: true, at: 12, value: 0 },
  ])
  audio = save(audio, 'motion', { clip: 'c3' }, 'Audio fade')
  expectAtomicFailure(audio, [{ op: 'library_apply', item: item(audio, 'Audio fade').id, id: 'c4' }])
})

test('transition templates need a neighboring visual clip and do not replace existing transitions', () => {
  let p = run(project(), [{ op: 'transition', id: 'c2', type: 'dipBlack', dur: 0.8 }])
  p = save(p, 'transition', { clip: 'c2' }, 'Dip')
  const id = item(p, 'Dip').id
  p = run(p, [{ op: 'transition', id: 'c2', type: 'none' }])
  const applied = run(p, [{ op: 'library_apply', item: id, id: 'c2' }])
  assert.deepEqual(clip(applied, 'c2').transitionIn, { type: 'dipBlack', dur: 0.8 })
  const frame = framePlan(applied, 4).layers[0]
  assert.equal(frame.transition, 'dipBlack')
  close(frame.progress, 0.5)
  expectAtomicFailure(applied, [{ op: 'library_apply', item: id, id: 'c2' }])
  expectAtomicFailure(p, [{ op: 'library_apply', item: id, id: 'c1' }])
  expectAtomicFailure(p, [{ op: 'library_apply', item: id, id: 'c3' }])
  const gap = run(p, [{ op: 'move', id: 'c2', start: 5 }])
  expectAtomicFailure(gap, [{ op: 'library_apply', item: id, id: 'c2' }])
})

function customTransitionProject() {
  const source = figmaProject()
  let p = run(source.project, [
    { op: 'import', assets: project().assets },
    { op: 'add_clip', src: 'media/one.mp4', track: 'V1', start: 0, dur: 4 },
    { op: 'add_clip', src: 'media/one.mp4', track: 'V1', start: 4, dur: 4 },
    { op: 'add_clip', src: 'media/one.mp4', track: 'V1', start: 8, dur: 4 },
    { op: 'add_clip', src: 'media/tone.wav', track: 'A1', start: 0, dur: 12 },
  ])
  const nested = p.comps[source.root].tracks.flatMap(track => track.clips).find(c => c.kind === 'comp')
  p = run(p, [
    { op: 'keyframe', id: nested.id, prop: 'opacity', local: true, at: 0, value: 0 },
    { op: 'keyframe', id: nested.id, prop: 'opacity', local: true, at: 2, value: 1 },
    { op: 'keyframe', id: nested.id, prop: 'opacity', local: true, at: 4, value: 0 },
  ])
  p = save(p, 'transition', { composition: source.root }, 'Authored wipe')
  const timeline = p.tracks[0].clips
  return { ...source, project: p, item: item(p, 'Authored wipe').id, target: timeline.find(c => c.start === 4).id, next: timeline.find(c => c.start === 8).id }
}

test('authored transition compositions place an editable overlay centered on the cut and render its motion', () => {
  const source = customTransitionProject()
  const p = source.project
  const saved = item(p, 'Authored wipe')
  assert.equal(saved.category, 'transition')
  assert.deepEqual(Object.keys(saved.body.assets), ['media/figma/portrait.png'])
  const before = structuredClone(p)
  const result = applyOps(p, [{ op: 'library_apply', item: source.item, id: source.target }])
  const applied = result.project
  const overlay = createdClip(p, applied, 'comp')
  assert.ok(overlay)
  assert.equal(overlay.start, 2)
  assert.equal(overlay.dur, 4)
  assert.notEqual(overlay.comp, source.root)
  const track = findClip(applied, overlay.id).track
  assert.equal(track.kind, 'video')
  assert.ok(!track.locked)
  assert.ok(applied.tracks.indexOf(track) > applied.tracks.indexOf(findClip(applied, source.target).track))
  assert.deepEqual(clip(applied, source.target), clip(p, source.target))
  assert.deepEqual(p, before)
  const nested = applied.comps[overlay.comp].tracks.flatMap(t => t.clips).find(c => c.kind === 'comp')
  const children = applied.comps[nested.comp].tracks.flatMap(t => t.clips)
  const title = children.find(c => c.kind === 'title')
  const matte = children.find(c => c.note === clip(p, source.matte).note)
  assert.equal(title.title.font, 'IBM Plex Sans')
  assert.equal(title.note, 'figma 10:5')
  assert.equal(title.parent, matte.id)
  assert.equal(title.matte.source, matte.id)
  assert.equal(title.link, matte.link)
  assert.ok(title.expr.x.includes(`"${matte.id}"`))
  assert.notEqual(title.id, source.title)
  assert.notEqual(title.masks[0].id, clip(p, source.title).masks[0].id)
  const blur = title.nodes.list.find(n => n.type === 'blur')
  assert.deepEqual(title.anim[`node.${blur.id}.radius`], [[0, 2], [2, 6]])
  assert.deepEqual(title.anim[`mask.${title.masks[0].id}.x`], [[0, 0], [2, 20]])
  for (const copied of [overlay, nested, ...children]) assert.ok(result.created.includes(copied.id), `${copied.id} missing from created`)
  assert.ok(result.created.includes(overlay.comp))
  assert.ok(result.created.includes(nested.comp))
  const ids = allClips(applied, true).map(row => row.clip.id)
  assert.equal(new Set(ids).size, ids.length)
  const fadeAt = at => framePlan(applied, at).layers.find(layer => layer.clip?.id === overlay.id)?.clip.composition.layers[0].clip.opacity
  assert.equal(fadeAt(1.9), undefined)
  close(fadeAt(3), 0.5)
  close(fadeAt(4), 1)
  close(fadeAt(5), 0.5)
  assert.equal(fadeAt(6), undefined)
})

test('custom transition placement adds an upper video track when the existing upper tracks are occupied', () => {
  const source = customTransitionProject()
  const p = run(source.project, [
    { op: 'add_color', track: 'V2', start: 2, dur: 4, color: '#ff0000' },
    { op: 'add_color', track: 'V3', start: 2, dur: 4, color: '#0000ff' },
  ])
  const beforeIDs = new Set(allClips(p, true).map(row => row.clip.id))
  const applied = run(p, [{ op: 'library_apply', item: source.item, id: source.target }])
  const overlay = createdClip(p, applied, 'comp')
  const host = findClip(applied, overlay.id).track
  assert.equal(applied.tracks.length, p.tracks.length + 1)
  assert.equal(host.kind, 'video')
  assert.ok(!host.locked)
  assert.ok(applied.tracks.indexOf(host) > applied.tracks.indexOf(findClip(applied, source.target).track))
  assert.deepEqual(host.clips.map(c => c.id), [overlay.id])
  for (const id of beforeIDs) assert.deepEqual(clip(applied, id), clip(p, id), `existing clip ${id} changed`)
})

test('custom transitions reject missing or incompatible targets, cut gaps and locked target tracks atomically', () => {
  const source = customTransitionProject()
  const p = source.project
  const first = p.tracks[0].clips.find(c => c.start === 0).id
  const audio = p.tracks.find(t => t.kind === 'audio').clips[0].id
  expectAtomicFailure(p, [{ op: 'library_apply', item: source.item }])
  expectAtomicFailure(p, [{ op: 'library_apply', item: source.item, id: 'missing' }])
  expectAtomicFailure(p, [{ op: 'library_apply', item: source.item, id: audio }])
  expectAtomicFailure(p, [{ op: 'library_apply', item: source.item, id: first }])
  const gap = run(p, [{ op: 'move', id: source.target, start: 5 }])
  expectAtomicFailure(gap, [{ op: 'library_apply', item: source.item, id: source.target }])
  const locked = run(p, [{ op: 'update_track', id: 'V1', set: { locked: true } }])
  expectAtomicFailure(locked, [{ op: 'library_apply', item: source.item, id: source.target }])
  const existing = run(p, [{ op: 'transition', id: source.target, type: 'crossDissolve', dur: 0.5 }])
  expectAtomicFailure(existing, [{ op: 'library_apply', item: source.item, id: source.target }])
})

test('custom transition templates can save a selected composition wrapper and apply to multiple cuts in one batch', () => {
  const source = customTransitionProject()
  let p = run(source.project, [{ op: 'comp_clip', target: source.root, track: 'V3', start: 20, dur: 4, set: { scale: 0.8 } }])
  const wrapper = p.tracks.find(t => t.id === 'V3').clips[0]
  p = run(p, [
    { op: 'keyframe', id: wrapper.id, prop: 'x', local: true, at: 0, value: 40 },
    { op: 'keyframe', id: wrapper.id, prop: 'x', local: true, at: 4, value: 120 },
  ])
  p = save(p, 'transition', { clip: wrapper.id }, 'Wrapper wipe')
  const saved = item(p, 'Wrapper wipe')
  assert.equal(saved.body.clip.kind, 'comp')
  const before = structuredClone(p)
  const result = applyOps(p, [
    { op: 'library_apply', item: saved.id, id: source.target },
    { op: 'library_apply', item: saved.id, id: source.next },
  ])
  const original = new Set(allClips(p, true).map(row => row.clip.id))
  const overlays = allClips(result.project).map(row => row.clip).filter(c => c.kind === 'comp' && !original.has(c.id))
  assert.equal(overlays.length, 2)
  assert.deepEqual(overlays.map(c => c.start).sort((a, b) => a - b), [2, 6])
  assert.notEqual(overlays[0].comp, overlays[1].comp)
  for (const overlay of overlays) {
    assert.equal(overlay.scale, 0.8)
    assert.deepEqual(overlay.anim.x, [[0, 40], [4, 120]])
    assert.ok(result.created.includes(overlay.id))
  }
  assert.deepEqual(clip(result.project, source.target), clip(p, source.target))
  assert.deepEqual(clip(result.project, source.next), clip(p, source.next))
  assert.deepEqual(p, before)
  expectAtomicFailure(p, [
    { op: 'library_apply', item: saved.id, id: source.target },
    { op: 'library_apply', item: saved.id, id: 'missing' },
  ])
})

test('placement and target checks reject locked tracks, audio tracks and missing targets atomically', () => {
  const p = save(project(), 'title', { clip: 'c4' }, 'Heading')
  const id = item(p, 'Heading').id
  const locked = run(p, [{ op: 'update_track', id: 'V2', set: { locked: true } }])
  expectAtomicFailure(locked, [{ op: 'library_apply', item: id, track: 'V2', start: 8 }])
  expectAtomicFailure(p, [{ op: 'library_apply', item: id, track: 'A1', start: 8 }])
  expectAtomicFailure(p, [{ op: 'library_apply', item: id, track: 'missing', start: 8 }])
  expectAtomicFailure(p, [{ op: 'library_apply', item: 'missing', track: 'V2', start: 8 }])
  expectAtomicFailure(p, [{ op: 'library_apply', item: id, start: Infinity }])
  const effect = save(run(project(), [{ op: 'effect', id: 'c1', type: 'blur' }]), 'effect', { clip: 'c1' }, 'Blur')
  expectAtomicFailure(effect, [{ op: 'library_apply', item: item(effect, 'Blur').id, id: 'c3' }])
  expectAtomicFailure(effect, [{ op: 'library_apply', item: item(effect, 'Blur').id, id: 'missing' }])
})

test('target components reject explicit composition scope mismatches without changing either timeline', async t => {
  let p = run(project(), [
    { op: 'add_comp', name: 'Target scope', duration: 4 },
    { op: 'add_color', comp: 'k1', track: 'V1', start: 0, dur: 2, color: '#ff0000' },
    { op: 'add_color', comp: 'k1', track: 'V1', start: 2, dur: 2, color: '#0000ff' },
    { op: 'add_comp', name: 'Other scope', duration: 4 },
    { op: 'effect', id: 'c1', type: 'blur' },
    { op: 'keyframe', id: 'c1', prop: 'x', local: true, at: 0, value: 20 },
    { op: 'keyframe', id: 'c1', prop: 'x', local: true, at: 4, value: 100 },
    { op: 'transition', id: 'c2', type: 'dipBlack', dur: 0.5 },
  ])
  p = save(p, 'effect', { clip: 'c1' }, 'Scope effect')
  p = save(p, 'motion', { clip: 'c1' }, 'Scope motion')
  p = save(p, 'transition', { clip: 'c2' }, 'Scope transition')
  p = run(p, [{ op: 'transition', id: 'c2', type: 'none' }])
  const nestedTarget = p.comps.k1.tracks[0].clips.find(c => c.start === 2).id
  for (const category of ['effect', 'motion', 'transition']) await t.test(category, () => {
    const template = item(p, `Scope ${category}`)
    expectAtomicFailure(p, [{ op: 'library_apply', item: template.id, id: 'c2', comp: 'k1' }])
    expectAtomicFailure(p, [{ op: 'library_apply', item: template.id, id: nestedTarget, comp: 'k2' }])
    expectAtomicFailure(p, [
      { op: 'library_apply', item: template.id, id: 'c2' },
      { op: 'library_apply', item: template.id, id: nestedTarget, comp: 'k2' },
    ])
    const valid = run(p, [{ op: 'library_apply', item: template.id, id: nestedTarget, comp: 'k1' }])
    assert.deepEqual(valid.tracks, p.tracks)
    assert.notDeepEqual(clip(valid, nestedTarget), clip(p, nestedTarget))
  })
  const custom = customTransitionProject()
  const scoped = run(custom.project, [{ op: 'add_comp', name: 'Wrong custom scope', duration: 4 }])
  const otherScope = Object.values(scoped.comps).find(comp => comp.name === 'Wrong custom scope').id
  expectAtomicFailure(scoped, [{ op: 'library_apply', item: custom.item, id: custom.target, comp: otherScope }])
})

test('invalid library operations reject a whole batch, including edits that preceded the failure', () => {
  const p = save(project(), 'title', { clip: 'c4' }, 'Heading')
  expectAtomicFailure(p, [
    { op: 'library_apply', item: item(p, 'Heading').id, track: 'V2', start: 10 },
    { op: 'library_rename', item: 'missing', name: 'No entry' },
  ])
  expectAtomicFailure(p, [
    { op: 'update', id: 'c4', set: { title: { text: 'Must not survive' } } },
    { op: 'library_save', category: 'arbitrary', name: 'Bad category', source: { clip: 'c4' } },
  ])
  expectAtomicFailure(p, [{ op: 'library_rename', item: item(p, 'Heading').id, name: '   ' }])
  expectAtomicFailure(p, [{ op: 'library_remove', item: 'missing' }])
})

test('registration refuses executable values, unsafe fields, malformed keyframes and missing references', async t => {
  const p = project()
  const saved = save(p, 'title', { clip: 'c4' }, 'Heading')
  const validBody = item(saved, 'Heading').body
  const cases = [
    ['unknown body field', body => { body.script = 'process.exit(1)' }],
    ['unknown clip field', body => { body.clip.run = 'alert(1)' }],
    ['unknown title field', body => { body.clip.title.script = 'alert(1)' }],
    ['invalid font value', body => { body.clip.title.font = { path: '../outside.ttf' } }],
    ['arbitrary expression', body => { body.clip.expr = { x: 'globalThis.process.exit(1)' } }],
    ['unknown function in an inactive expression branch', body => { body.clip.expr = { x: 'time > 0 ? 1 : run()' } }],
    ['non-finite value', body => { body.clip.x = Infinity }],
    ['non-finite keyframe', body => { body.clip.anim = { x: [[0, 10], [1, NaN]] } }],
    ['malformed keyframe', body => { body.clip.anim = { x: [[0], [1, 20]] } }],
    ['unknown animated property', body => { body.clip.anim = { arbitrary: [[0, 10], [1, 20]] } }],
    ['missing parent', body => { body.clip.parent = 'outside' }],
    ['missing matte', body => { body.clip.matte = { mode: 'alpha', source: 'outside' } }],
    ['unsafe asset path', body => { body.assets = { '../outside.png': { width: 10, height: 10, still: true, hasVideo: true } } }],
    ['function value', body => { body.clip.x = () => 10 }],
    ['prototype key', body => { body.clip.title = JSON.parse('{"text":"x","__proto__":{"polluted":true}}') }],
  ]
  for (const [name, mutate] of cases) await t.test(name, () => {
    const body = structuredClone(validBody)
    mutate(body)
    expectAtomicFailure(p, [{ op: 'library_register', item: { name, category: 'title', body } }])
    assert.equal({}.polluted, undefined)
  })
})

test('registered composition templates cannot invent media records or reference absent media', () => {
  const source = figmaProject()
  const saved = save(source.project, 'composition', { composition: source.root }, 'Card')
  const body = item(saved, 'Card').body
  const missing = newProject('No imported media')
  expectAtomicFailure(missing, [{ op: 'library_register', item: { name: 'Missing media', category: 'composition', body } }])
  const mismatched = structuredClone(body)
  mismatched.assets['media/figma/portrait.png'].width = 999
  expectAtomicFailure(source.project, [{ op: 'library_register', item: { name: 'Invented metadata', category: 'composition', body: mismatched } }])
  const fresh = run(newProject('Media registered'), [{ op: 'import', assets: { 'media/figma/portrait.png': source.project.assets['media/figma/portrait.png'] } }])
  const registered = run(fresh, [{ op: 'library_register', item: { name: 'Imported card', category: 'composition', body } }])
  assert.ok(item(registered, 'Imported card'))
})

test('registered effect graphs reject cycles, dangling links and duplicate node identities', async t => {
  let p = run(project(), [{ op: 'node_add', id: 'c1', node: { type: 'blur', radius: 4 } }])
  p = save(p, 'effect', { clip: 'c1' }, 'Blur graph')
  const valid = item(p, 'Blur graph').body
  const cases = [
    ['cycle', graph => { graph.links.push({ from: 'n4', to: 'n2', input: 0 }) }],
    ['dangling link', graph => { graph.links.push({ from: 'unknown', to: 'n3', input: 1 }) }],
    ['duplicate node', graph => { graph.list.push({ ...graph.list[1] }) }],
    ['missing output', graph => { graph.list = graph.list.filter(node => node.type !== 'output') }],
    ['unknown node type', graph => { graph.list.find(node => node.type === 'blur').type = 'script' }],
    ['unknown node field', graph => { graph.list.find(node => node.type === 'blur').script = 'alert(1)' }],
    ['invalid node parameter', graph => { graph.list.find(node => node.type === 'blur').radius = 'large' }],
  ]
  for (const [name, mutate] of cases) await t.test(name, () => {
    const body = structuredClone(valid)
    mutate(body.settings.nodes)
    expectAtomicFailure(p, [{ op: 'library_register', item: { name, category: 'effect', body } }])
  })
})

test('registration rejects incomplete or cyclic composition dependencies and duplicate layer identities', async t => {
  const source = figmaProject()
  const saved = save(source.project, 'composition', { composition: source.root }, 'Card')
  const valid = item(saved, 'Card').body
  const cases = [
    ['missing nested composition', body => {
      const host = body.comps[body.composition].tracks.flatMap(track => track.clips).find(c => c.kind === 'comp')
      delete body.comps[host.comp]
    }],
    ['composition cycle', body => {
      body.comps[body.composition].tracks[0].clips.push({ id: 'cycle_layer', kind: 'comp', comp: body.composition, start: 0, dur: 4 })
    }],
    ['duplicate global layer ID', body => {
      const host = body.comps[body.composition].tracks.flatMap(track => track.clips).find(c => c.kind === 'comp')
      const nested = body.comps[host.comp].tracks.flatMap(track => track.clips)
      nested[0].id = host.id
    }],
    ['unreferenced composition', body => {
      body.comps.unreferenced = { ...structuredClone(body.comps[body.composition]), id: 'unreferenced', tracks: [] }
    }],
    ['invalid shape geometry', body => {
      const shape = Object.values(body.comps).flatMap(c => c.tracks.flatMap(track => track.clips)).find(c => c.kind === 'shape')
      shape.shape.width = 'wide'
    }],
    ['unknown mask field', body => {
      const title = Object.values(body.comps).flatMap(c => c.tracks.flatMap(track => track.clips)).find(c => c.kind === 'title')
      title.masks[0].script = 'alert(1)'
    }],
  ]
  for (const [name, mutate] of cases) await t.test(name, () => {
    const body = structuredClone(valid)
    mutate(body)
    expectAtomicFailure(source.project, [{ op: 'library_register', item: { name, category: 'composition', body } }])
  })
})

test('dependency metadata equality accepts a different property order and rejects changed values', () => {
  const source = figmaProject()
  const saved = save(source.project, 'composition', { composition: source.root }, 'Card')
  const body = structuredClone(item(saved, 'Card').body)
  const media = body.assets['media/figma/portrait.png']
  body.assets['media/figma/portrait.png'] = Object.fromEntries(Object.entries(media).reverse())
  const registered = run(source.project, [{ op: 'library_register', item: { name: 'Reordered metadata', category: 'composition', body } }])
  assert.ok(item(registered, 'Reordered metadata'))
  body.assets['media/figma/portrait.png'].height += 1
  expectAtomicFailure(source.project, [{ op: 'library_register', item: { name: 'Changed metadata', category: 'composition', body } }])
})

function request(port, route, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1', port, path: route, method: data ? 'POST' : 'GET',
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch (error) { reject(error) }
      })
    })
    req.setTimeout(3000, () => req.destroy(new Error('library test HTTP request timed out')))
    req.on('error', reject)
    req.end(data)
  })
}

async function freePort() {
  const socket = net.createServer()
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', resolve)
  })
  const { port } = socket.address()
  await new Promise(resolve => socket.close(resolve))
  return port
}

test('HTTP library edits persist and each save or apply is one undoable operation', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-library-'))
  let child
  t.after(async () => {
    if (child && child.exitCode === null) {
      const ended = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGTERM')
      await ended
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  const file = path.join(root, 'reel.project.json')
  const fixture = run(newProject('Library HTTP', { width: 320, height: 180, fps: 30 }), [
    { op: 'add_title', text: 'Original', dur: 4, title: { anim: 'none', font: 'Inter', size: 28 } },
    { op: 'keyframe', id: 'c1', prop: 'opacity', local: true, at: 0, value: 0 },
    { op: 'keyframe', id: 'c1', prop: 'opacity', local: true, at: 1, value: 1 },
  ])
  await fs.writeFile(file, JSON.stringify(fixture))
  const port = await freePort()
  const server = fileURLToPath(new URL('../server.mjs', import.meta.url))
  child = spawn(process.execPath, [server, '--root', root, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output = (output + data.toString()).slice(-12000) })
  child.stderr.on('data', data => { output = (output + data.toString()).slice(-12000) })
  const deadline = Date.now() + 10000
  while (true) {
    try { if ((await request(port, '/api/project')).status === 200) break } catch {}
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`isolated library test server did not start\n${output}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const api = async (route, body) => {
    const result = await request(port, route, body)
    assert.equal(result.status, 200, result.body.error)
    return result.body
  }
  const original = (await api('/api/project')).project
  const saved = (await api('/api/ops', { ops: [{ op: 'library_save', category: 'title', name: 'HTTP title', source: { clip: 'c1' } }] })).project
  const id = item(saved, 'HTTP title').id
  const applied = (await api('/api/ops', { ops: [{ op: 'library_apply', item: id, track: 'V2', start: 6 }] })).project
  const copy = createdClip(saved, applied, 'title')
  assert.ok(copy)
  assert.equal(copy.title.text, 'Original')
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), applied)
  assert.deepEqual((await api('/api/undo', {})).project, saved)
  assert.deepEqual((await api('/api/redo', {})).project, applied)
  assert.deepEqual((await api('/api/undo', {})).project, saved)
  assert.deepEqual((await api('/api/undo', {})).project, original)
  assert.deepEqual((await api('/api/redo', {})).project, saved)
  const beforeInvalid = await api('/api/project')
  const invalid = await request(port, '/api/ops', { ops: [
    { op: 'library_apply', item: id, track: 'V2', start: 6 },
    { op: 'library_rename', item: 'missing', name: 'Rejected' },
  ] })
  assert.ok(invalid.status >= 400 && invalid.status < 600)
  assert.match(invalid.body.error, /item does not exist/)
  const afterInvalid = await api('/api/project')
  assert.equal(afterInvalid.version, beforeInvalid.version)
  assert.deepEqual(afterInvalid.project, saved)
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), saved)
  const effect = animatedEffectProject().template
  for (const duration of [undefined, 0, -1]) {
    const body = structuredClone(effect.body)
    if (duration === undefined) delete body.settings.dur
    else body.settings.dur = duration
    if (duration === 0) body.settings.anim = { 'node.n4.radius': [[0, 2]] }
    const rejected = await request(port, '/api/ops', { ops: [{ op: 'library_register', item: { name: 'Invalid animated effect', category: 'effect', body } }] })
    assert.ok(rejected.status >= 400 && rejected.status < 600)
    assert.match(rejected.body.error, /duration|keyframes/i)
    const current = await api('/api/project')
    assert.equal(current.version, beforeInvalid.version)
    assert.deepEqual(current.project, saved)
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), saved)
  }
  const authored = (await api('/api/ops', { ops: [
    { op: 'add_color', track: 'V1', start: 0, dur: 4, color: '#ff0000' },
    { op: 'add_color', track: 'V1', start: 4, dur: 4, color: '#0000ff' },
    { op: 'add_color', track: 'V1', start: 8, dur: 4, color: '#00ff00' },
    { op: 'add_comp', name: 'HTTP authored transition', duration: 2 },
    { op: 'add_shape', comp: 'k1', track: 'V1', dur: 2 },
  ] })).project
  const rootComp = Object.values(authored.comps).find(c => c.name === 'HTTP authored transition')
  const shape = rootComp.tracks.flatMap(t => t.clips).find(c => c.kind === 'shape')
  const savedTransition = (await api('/api/ops', { ops: [
    { op: 'keyframe', id: shape.id, prop: 'opacity', local: true, at: 0, value: 0 },
    { op: 'keyframe', id: shape.id, prop: 'opacity', local: true, at: 1, value: 1 },
    { op: 'keyframe', id: shape.id, prop: 'opacity', local: true, at: 2, value: 0 },
    { op: 'library_save', category: 'transition', name: 'HTTP custom transition', source: { composition: rootComp.id } },
  ] })).project
  const customID = item(savedTransition, 'HTTP custom transition').id
  const cuts = savedTransition.tracks[0].clips.filter(c => c.start > 0)
  const batch = (await api('/api/ops', { ops: cuts.map(c => ({ op: 'library_apply', item: customID, id: c.id })) })).project
  assert.equal(allClips(batch).filter(row => row.clip.kind === 'comp').length, 2)
  assert.deepEqual((await api('/api/undo', {})).project, savedTransition)
  assert.deepEqual((await api('/api/redo', {})).project, batch)
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), batch)
  const trimmedMotion = (await api('/api/ops', { ops: [
    { op: 'keyframe', id: 'c1', prop: 'opacity', local: true, at: 1, remove: true },
    { op: 'keyframe', id: 'c1', prop: 'opacity', local: true, at: 4, value: 1 },
    { op: 'trim', id: 'c1', edge: 'left', to: 1 },
    { op: 'add_title', track: 'V3', start: 20, dur: 4, text: 'HTTP effect source', title: { anim: 'none' } },
    { op: 'add_color', track: 'V1', start: 12, dur: 6, color: '#ffffff' },
    { op: 'library_save', category: 'motion', name: 'HTTP trimmed motion', source: { clip: 'c1' } },
  ] })).project
  const effectSource = allClips(trimmedMotion).find(row => row.clip.title?.text === 'HTTP effect source').clip
  const trimmedEffect = (await api('/api/ops', { ops: [
    { op: 'node_add', id: effectSource.id, node: { type: 'blur', radius: 2 } },
    { op: 'keyframe', id: effectSource.id, prop: 'node.n4.radius', local: true, at: 0, value: 2 },
    { op: 'keyframe', id: effectSource.id, prop: 'node.n4.radius', local: true, at: 4, value: 10 },
    { op: 'trim', id: effectSource.id, edge: 'left', to: 21 },
    { op: 'library_save', category: 'effect', name: 'HTTP trimmed effect', source: { clip: effectSource.id } },
  ] })).project
  const trimTarget = trimmedEffect.tracks[0].clips.find(c => c.start === 12)
  const retimed = (await api('/api/ops', { ops: [
    { op: 'library_apply', item: item(trimmedEffect, 'HTTP trimmed motion').id, id: trimTarget.id },
    { op: 'library_apply', item: item(trimmedEffect, 'HTTP trimmed effect').id, id: trimTarget.id },
  ] })).project
  const target = clip(retimed, trimTarget.id)
  const blur = target.nodes.list.find(n => n.type === 'blur')
  assert.deepEqual(target.anim.opacity, [[-2, 0], [6, 1]])
  assert.deepEqual(target.anim[`node.${blur.id}.radius`], [[-2, 2], [6, 10]])
  const frame = framePlan(retimed, 12).layers.find(layer => layer.clip?.id === target.id).clip
  close(frame.opacity, 0.25)
  close(frame.nodes.list.find(n => n.type === 'blur').radius, 4)
  assert.deepEqual((await api('/api/undo', {})).project, trimmedEffect)
  assert.deepEqual((await api('/api/redo', {})).project, retimed)
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), retimed)
})
