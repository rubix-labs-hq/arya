import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { rasterSize, graphSize, MAX_RESIDENT_BYTES } from '../web/engine/render-resolution.js'
import { newProject, applyOps, findClip } from '../core/project.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const url = name => pathToFileURL(path.join(root, name)).href
const data = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
let compText = fs.readFileSync(path.join(root, 'web/engine/compositor.js'), 'utf8')
for (const [name, replacement] of Object.entries({ '/core/project.js': url('core/project.js'), './grade.js': url('core/render-grade.js'), './render-resolution.js': url('web/engine/render-resolution.js') })) compText = compText.replace(`from '${name}'`, `from ${JSON.stringify(replacement)}`)
const compURL = data(compText)
const { Compositor } = await import(compURL)
let shapesText = fs.readFileSync(path.join(root, 'web/engine/shapes.js'), 'utf8')
shapesText = shapesText.replace("from '/core/project.js'", `from ${JSON.stringify(url('core/project.js'))}`).replace("from './render-resolution.js'", `from ${JSON.stringify(url('web/engine/render-resolution.js'))}`)
const shapesURL = data(shapesText)
const shapes = await import(shapesURL)
let frameText = fs.readFileSync(path.join(root, 'web/engine/frame.js'), 'utf8')
const replacements = { '/core/project.js': url('core/project.js'), '/core/caption-render.js': url('core/caption-render.js'), './compositor.js': compURL, './render-resolution.js': url('web/engine/render-resolution.js'), './media.js': data('export const mediaUrl=(p,s)=>s;'), './shapes.js': shapesURL }
for (const [name, replacement] of Object.entries(replacements)) frameText = frameText.replace(`from '${name}'`, `from ${JSON.stringify(replacement)}`)
const { drawFrame } = await import(data(frameText))

function spy(width, height, maxEdge = 8192) {
  const calls = [], allocations = []
  const comp = { size: [width, height], renderMaxEdge: () => maxEdge, beginFrame() { calls.push({ begin: true }) }, pooled(key, w, h) { allocations.push({ key, w, h }); return { tex: key, w, h } }, sourceTexture: key => ({ tex: key }), clear() {}, drawLayer(target, source, layer, plane) { calls.push({ target, source, layer, plane }) }, blendOnto() {}, present(target) { calls.push({ present: target }) }, copyInto() {}, postEffects(target, fx, scale) { calls.push({ effects: fx, scale }); return target } }
  return { comp, calls, allocations }
}
function project(width, height, ops) { return JSON.parse(JSON.stringify(applyOps(newProject('Graph', { width, height, fps: 30 }), ops).project)) }
function color(width = 3840, height = 2160, node = { type: 'corrector', grade: { exposure: 0 }, window: { type: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.2, rotation: 35 } }) {
  return project(width, height, [{ op: 'add_color', track: 'V1', dur: 4, color: '#ff0000', set: { opacity: 0.5 } }, { op: 'node_add', id: 'c1', node }])
}
function nodeTargets(f) { return f.allocations.filter(t => /^node\d+:/.test(t.key)) }

class PathSpy {
  constructor() { this.ops = [] }
  roundRect(...args) { this.ops.push(['roundRect', ...args]) }
  ellipse(...args) { this.ops.push(['ellipse', ...args]) }
  rect(...args) { this.ops.push(['rect', ...args]) }
  moveTo() {} lineTo() {} closePath() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {}
}
const canvases = []
globalThis.Path2D = PathSpy
globalThis.document = { createElement(name) { assert.equal(name, 'canvas'); const calls = [], ctx = new Proxy({ calls }, { get(object, key) { if (key in object) return object[key]; return (...args) => calls.push({ key, args }) }, set(object, key, value) { object[key] = value; calls.push({ key, value }); return true } }); const canvas = { width: 0, height: 0, getContext: () => ctx, calls }; canvases.push(canvas); return canvas } }
globalThis.HTMLVideoElement = class {}

for (const [w, h] of [[3840, 2160], [2160, 3840]]) test(`graph retains ${w} by ${h} dimensions, aspect, window and opacity after reopen`, () => {
  const p = color(w, h), before = JSON.stringify(p), f = spy(w, h)
  drawFrame(f.comp, {}, p, 1)
  assert.ok(nodeTargets(f).length >= 4)
  assert.ok(nodeTargets(f).every(t => t.w === w && t.h === h))
  const correction = f.calls.find(c => c.layer?.window)
  assert.deepEqual(correction.plane, { width: w, height: h })
  assert.equal(correction.layer.window.rotation, 35)
  assert.equal(correction.plane.width / correction.plane.height, w / h)
  const final = f.calls.find(c => c.layer?.matrix && c.source.w === w)
  assert.equal(final.layer.opacity, 0.5)
  assert.equal(final.layer.w, w); assert.equal(final.layer.h, h)
  assert.equal(JSON.stringify(p), before)
  assert.equal(f.calls[0].begin, true)
})

test('decoded 4K source graph keeps source pixels while final geometry stays in a 1080p project', () => {
  const p = project(1920, 1080, [{ op: 'import', assets: { 'input.mov': { assetKind: 'video', hasVideo: true, width: 3840, height: 2160, duration: 4, fps: 30 } } }, { op: 'append', src: 'input.mov', track: 'V1', dur: 4, audio: false }, { op: 'node_add', id: 'c1', node: { type: 'primary' } }])
  const f = spy(3840, 2160), media = { useDecoders: true, frames: new Map([['c1', { frame: { displayWidth: 3840, displayHeight: 2160 }, stamp: 1 }]]) }
  drawFrame(f.comp, media, p, 1)
  assert.ok(nodeTargets(f).every(t => t.w === 3840 && t.h === 2160))
  const final = f.calls.find(c => c.layer?.matrix)
  assert.equal(final.layer.w, 1920); assert.equal(final.layer.h, 1080)
})

test('blur radius scales in source pixels at full graph resolution', () => {
  const p = color(1920, 1080, { type: 'blur', radius: 4 }), f = spy(3840, 2160)
  drawFrame(f.comp, {}, p, 1)
  assert.ok(nodeTargets(f).every(t => t.w === 3840 && t.h === 2160))
  assert.equal(f.calls.find(c => c.effects?.blur === 4).scale, 2)
})

test('reviewed LUT space and animated mix survive the new graph sizing', () => {
  const p = color(3840, 2160, { type: 'lut', lut: 'look.cube', lutSpace: 'working', mix: 0.25 })
  const edited = applyOps(p, [{ op: 'keyframe', id: 'c1', prop: 'node.n4.mix', at: 0, value: 0.25, local: true }, { op: 'keyframe', id: 'c1', prop: 'node.n4.mix', at: 2, value: 0.75, local: true }]).project
  const f = spy(3840, 2160); drawFrame(f.comp, {}, JSON.parse(JSON.stringify(edited)), 1)
  const grade = f.calls.find(c => c.layer?.grade?.lut).layer.grade
  assert.equal(grade.lutSpace, 'working'); assert.equal(grade.lutMix, 0.5)
})

test('node target slots reuse across sequential clips without sharing results', () => {
  const p = color(), first = findClip(p, 'c1').clip
  p.tracks[0].clips.push({ ...structuredClone(first), id: 'c2', start: 4 })
  const a = spy(3840, 2160), b = spy(3840, 2160)
  drawFrame(a.comp, {}, p, 1); drawFrame(b.comp, {}, p, 5)
  assert.deepEqual(nodeTargets(a).map(t => t.key), nodeTargets(b).map(t => t.key))
})

test('device and graph memory limits throw before node allocation instead of downscaling', () => {
  const p = color(), f = spy(3840, 2160, 2048)
  assert.throws(() => drawFrame(f.comp, {}, p, 1), /device or policy limit/)
  assert.equal(nodeTargets(f).length, 0)
  const huge = color(); let clip = findClip(huge, 'c1').clip
  for (let i = 0; i < 20; i++) { const next = applyOps(huge, [{ op: 'node_add', id: 'c1', node: { type: 'corrector' } }]).project; Object.assign(huge, next) }
  const g = spy(3840, 2160)
  assert.throws(() => drawFrame(g.comp, {}, huge, 1), /memory limit/)
  assert.equal(nodeTargets(g).length, 0)
})

test('full 4K mask retains layer coordinates, feather and opacity at output scale', () => {
  const p = color(1920, 1080), updated = applyOps(p, [{ op: 'add_mask', id: 'c1', mask: { type: 'rect', w: 960, h: 540, x: 100, y: -50, feather: 4, opacity: 0.4 } }]).project
  const f = spy(3840, 2160), start = canvases.length
  drawFrame(f.comp, {}, updated, 1)
  const drawn = canvases.slice(start)
  assert.equal(drawn[0].width, 3840); assert.equal(drawn[0].height, 2160)
  assert.equal(drawn[1].width, 3840); assert.equal(drawn[1].height, 2160)
  assert.ok(drawn[1].calls.some(c => c.key === 'setTransform' && JSON.stringify(c.args) === JSON.stringify([2, 0, 0, 2, 1920, 1080])))
  assert.ok(drawn[1].calls.some(c => c.key === 'translate' && JSON.stringify(c.args) === JSON.stringify([100, -50])))
  assert.ok(drawn[1].calls.some(c => c.key === 'filter' && c.value === 'blur(4px)'))
  assert.ok(drawn[0].calls.some(c => c.key === 'globalAlpha' && c.value === 0.4))
})

test('shape above old 4096 cap retains full raster or rejects before canvas allocation', () => {
  const s = shapes.shapeCanvas('large-shape', { type: 'rect', width: 5000, height: 1000, fill: { color: '#ff0000' } }, 1)
  assert.equal(s.canvas.width, 5004); assert.equal(s.canvas.height, 1004)
  const start = canvases.length
  assert.throws(() => shapes.shapeCanvas('huge-shape', { type: 'rect', width: 9000, height: 100 }, 1), /limit/)
  assert.equal(canvases.length, start)
})

test('mask rejects excessive dimensions before creating canvas and rejects nonfinite scale', () => {
  const clip = { masks: [{ id: 'mk1', type: 'rect', w: 960, h: 540 }] }, start = canvases.length
  assert.throws(() => shapes.maskCanvas({}, clip, 'huge-mask', 0, 9000, 2160, 1), /limit/)
  assert.throws(() => shapes.maskCanvas({}, clip, 'invalid-mask', 0, 3840, 2160, Infinity), /Invalid/)
  assert.equal(canvases.length, start)
})

function gpuDouble({ edge = 8192, complete = true, error = 0 } = {}) {
  const calls = []; let id = 0
  const gl = new Proxy({ calls, MAX_TEXTURE_SIZE: 'edge', MAX_VIEWPORT_DIMS: 'viewport', FRAMEBUFFER_COMPLETE: 'complete', NO_ERROR: 0, getParameter: p => p === 'edge' ? edge : [edge, edge], getError: () => error, checkFramebufferStatus: () => complete ? 'complete' : 'incomplete', createTexture: () => ({ id: ++id }), createFramebuffer: () => ({ id: ++id }) }, { get(object, key) { return key in object ? object[key] : (...args) => calls.push({ key, args }) } })
  const c = Object.assign(Object.create(Compositor.prototype), { gl, canvas: {}, size: [0, 0], targets: {}, textures: new Map(), luts: new Map(), pool: new Map() }); c.beginFrame()
  return { c, calls }
}

test('resize checks full device dimensions and allocates no unused fixed targets', () => {
  const { c, calls } = gpuDouble(); c.resize(3840, 2160)
  assert.deepEqual(c.size, [3840, 2160]); assert.deepEqual(c.targets, {})
  assert.equal(calls.some(call => call.key === 'texImage2D'), false)
  assert.throws(() => c.resize(8193, 2160), /limit/)
  assert.deepEqual(c.size, [3840, 2160])
})

test('target allocation uses requested dimensions and cleans up incomplete framebuffers', () => {
  const ok = gpuDouble(), target = ok.c.makeTarget(3840, 2160)
  assert.equal(target.w, 3840); assert.equal(target.h, 2160)
  const image = ok.calls.find(c => c.key === 'texImage2D')
  assert.equal(image.args[3], 3840); assert.equal(image.args[4], 2160)
  const bad = gpuDouble({ complete: false })
  assert.throws(() => bad.c.makeTarget(3840, 2160), /Could not allocate the full/)
  assert.ok(bad.calls.some(c => c.key === 'deleteFramebuffer')); assert.ok(bad.calls.some(c => c.key === 'deleteTexture'))
})

test('pool never deletes current-frame inputs under target count pressure', () => {
  const { c, calls } = gpuDouble()
  for (let i = 0; i < 96; i++) c.pooled(`live${i}`, 2, 2)
  assert.throws(() => c.pooled('overflow', 2, 2), /target limit/)
  assert.equal(c.pool.size, 96)
  assert.equal(calls.some(c => c.key === 'deleteTexture'), false)
  c.beginFrame(); c.pooled('replacement', 2, 2)
  assert.equal(c.pool.size, 96); assert.equal(c.pool.has('live0|2x2'), false)
})

test('pool evicts unused previous-frame targets under byte pressure and fails if all are live', () => {
  const { c } = gpuDouble()
  for (let i = 0; i < 4; i++) c.pooled(`large${i}`, 8190, 8190)
  assert.ok(c.residentBytes() <= MAX_RESIDENT_BYTES)
  assert.throws(() => c.pooled('extra', 512, 512), /memory limit/)
  assert.equal(c.pool.size, 4)
  c.beginFrame(); c.pooled('extra', 512, 512)
  assert.equal(c.pool.size, 4); assert.equal(c.pool.has('large0|8190x8190'), false)
})

test('source upload rejects over-device dimensions before allocating image storage', () => {
  const { c, calls } = gpuDouble({ edge: 2048 })
  assert.throws(() => c.sourceTexture('source', { width: 3840, height: 2160 }, 1), /limit/)
  assert.equal(calls.some(call => call.key === 'texImage2D'), false)
})

test('no-op effects allocate no scratch textures', () => {
  const { c, calls } = gpuDouble(), target = { w: 3840, h: 2160 }
  assert.equal(c.postEffects(target, {}, 1), target)
  assert.equal(calls.some(call => call.key === 'texImage2D'), false)
})

test('resolution policy rejects invalid input and counts half-float graph bytes', () => {
  for (const size of [[NaN, 2160], [3840, Infinity], [0, 2160], [-1, 2160]]) assert.throws(() => rasterSize(...size), /Invalid/)
  assert.deepEqual(rasterSize(3840, 2160), { w: 3840, h: 2160, bytes: 33177600 })
  assert.equal(graphSize({ float: true }, { w: 3840, h: 2160 }, 3840, 2160, 1, 4).bytes, 530841600)
  assert.throws(() => graphSize({ float: true }, { w: 3840, h: 2160 }, 3840, 2160, 1, 5), /memory limit/)
})


test('fitted nested 1080p composition renders its graph at 4K parent resolution', () => {
  const child = color(1920, 1080), p = newProject('Nested', { width: 3840, height: 2160, fps: 30 })
  p.comps = { child: { name: 'Child', width: 1920, height: 1080, fps: 30, tracks: child.tracks } }
  p.tracks[0].clips.push({ id: 'outer', kind: 'comp', comp: 'child', start: 0, dur: 4, nodes: structuredClone(findClip(child, 'c1').clip.nodes) })
  const f = spy(3840, 2160); drawFrame(f.comp, {}, JSON.parse(JSON.stringify(p)), 1)
  assert.ok(f.allocations.filter(t => t.key.startsWith('accA1:')).every(t => t.w === 3840 && t.h === 2160))
  assert.ok(nodeTargets(f).some(t => t.key.startsWith('node1:')))
  assert.ok(nodeTargets(f).some(t => t.key.startsWith('node0:')))
  assert.ok(nodeTargets(f).every(t => t.w === 3840 && t.h === 2160))
  const childFinal = f.calls.find(c => c.layer?.matrix && c.layer.w === 1920)
  const outerFinal = f.calls.find(c => c.layer?.matrix && c.layer.w === 3840)
  assert.ok(childFinal); assert.ok(outerFinal)
})


test('captured base reproduces the 2048-square loss that the candidate removes', async () => {
  const bytes = fs.readFileSync(new URL('./fixtures/graph-fidelity/frame-before-resolution.js', import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'b58ec066807c1fbe39377279ed0956b243ad86263f49d7c71fd98a79dc625242')
  let text = bytes.toString('utf8')
  for (const [name, replacement] of Object.entries(replacements)) text = text.replace(`from '${name}'`, `from ${JSON.stringify(replacement)}`)
  const base = await import(data(text)), p = color(), old = spy(3840, 2160), current = spy(3840, 2160)
  base.drawFrame(old.comp, {}, p, 1); drawFrame(current.comp, {}, p, 1)
  assert.ok(nodeTargets(old).length > 0); assert.ok(nodeTargets(current).length > 0)
  assert.ok(nodeTargets(old).every(t => t.w === 2048 && t.h === 2048))
  assert.ok(nodeTargets(current).every(t => t.w === 3840 && t.h === 2160))
})


test('failed source allocation does not mark the failed texture fresh on retry', () => {
  const { c, calls } = gpuDouble({ error: 1285 }), frame = { width: 3840, height: 2160 }
  assert.throws(() => c.sourceTexture('frame', frame, 1), /Could not upload the full/)
  assert.equal(c.textures.get('frame').stamp, -1)
  c.gl.getError = () => 0
  const entry = c.sourceTexture('frame', frame, 1)
  assert.equal(entry.stamp, 1); assert.equal(entry.w, 3840); assert.equal(entry.h, 2160)
  assert.equal(calls.filter(c => c.key === 'texImage2D').length, 2)
})


test('animated and expression-driven 4K window renders after JSON reopen without mutating its recipe', () => {
  const original = color(), operations = [
    { op: 'keyframe', id: 'c1', prop: 'node.n4.window.x', at: 0, value: 0.2, local: true },
    { op: 'keyframe', id: 'c1', prop: 'node.n4.window.x', at: 2, value: 0.6, local: true },
    { op: 'keyframe', id: 'c1', prop: 'node.n4.window.rotation', at: 0, value: 0, local: true },
    { op: 'keyframe', id: 'c1', prop: 'node.n4.window.rotation', at: 2, value: 90, local: true },
    { op: 'expression', id: 'c1', prop: 'node.n4.window.y', expr: '0.25 + time * 0.1' },
  ]
  const saved = JSON.stringify(applyOps(original, operations).project), reopened = JSON.parse(saved), f = spy(3840, 2160)
  assert.doesNotThrow(() => drawFrame(f.comp, {}, reopened, 1))
  const window = f.calls.find(call => call.layer?.window).layer.window
  assert.ok(Math.abs(window.x - 0.4) < 1e-9); assert.ok(Math.abs(window.y - 0.35) < 1e-9)
  assert.equal(window.rotation, 45)
  assert.ok(nodeTargets(f).every(target => target.w === 3840 && target.h === 2160))
  assert.equal(JSON.stringify(reopened), saved)
})
