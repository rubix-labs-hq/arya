import './fixtures/browser-host-imports.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'

const editor = new URL('../', import.meta.url)
registerHooks({ resolve(specifier, context, next) { return next(specifier.startsWith('/core/') ? new URL('.' + specifier, editor).href : specifier, context) } })
const { applyOps, clipEnd, compView, newProject, timecode, valueAt } = await import('../core/project.js')
const { resolvedShape, shapePath } = await import('../web/engine/shapes.js')
const { shapeExtent } = await import('../web/ui/motion/geometry.js')
const source = await fs.readFile(new URL('../web/ui/viewer.js', import.meta.url), 'utf8')
const frame = await fs.readFile(new URL('../web/engine/frame.js', import.meta.url), 'utf8')
function between(text, first, next) {
  const start = text.indexOf(first), end = text.indexOf(next, start)
  assert.ok(start >= 0 && end > start)
  return text.slice(start, end).trim()
}
const titleAnim = new Function('IN', 'OUT', `return (${between(frame, 'export function titleAnim(', '/** For each visible').replace('export ', '')})`)(0.6, 0.45)
const media = { titles: new Map() }, compositor = { size: [320, 180] }
const quadOf = new Function('valueAt', 'compView', 'titleAnim', 'media', 'comp', 'resolvedShape', 'shapeExtent', `return (${between(source, 'function quadOf(', '/** Sets a property')})`)(valueAt, compView, titleAnim, media, compositor, resolvedShape, shapeExtent)

// The renderer path recorder captures numeric geometry and draws no pixels.
const oldPath = globalThis.Path2D
globalThis.Path2D = class { roundRect() {}; ellipse() {}; moveTo() {}; lineTo() {}; closePath() {}; bezierCurveTo() {} }
test.after(() => { if (oldPath === undefined) delete globalThis.Path2D; else globalThis.Path2D = oldPath })

function scene(shape = { type: 'rect', width: 320, height: 70, radius: 12, fill: { color: '#d95d18' } }) {
  const p = newProject('Installed plate geometry', { width: 640, height: 360, fps: 30 })
  const clip = { id: 'c6', kind: 'shape', start: 0, dur: 4, shape: structuredClone(shape), label: 'Editable blue plate', note: 'figma qa:plate', x: 192, y: 209, anim: { x: [[0, 176], [1, 192]] } }
  p.comps ??= {}
  p.comps.k1 = { id: 'k1', width: 640, height: 360, fps: 30, duration: 4, tracks: [{ id: 'V1', kind: 'video', clips: [clip] }] }
  return { p, clip, view: compView(p, 'k1') }
}
function sizeOf(p, c, t) { const q = quadOf(p, c, t); return [q.w, q.h] }
function pathSize(shape) { const p = shapePath(shape); return [p.hw * 2 + (shape.stroke?.width ?? 0), p.hh * 2 + (shape.stroke?.width ?? 0)] }

test('actual installed nested plate has its 320x70 renderer outline at its animated x176/y209', () => {
  const { view, clip } = scene()
  assert.deepEqual(quadOf(view, clip, 0), { x: 176, y: 209, w: 320, h: 70, r: 0, s: 1 })
})
test('the actual viewer module resolves its existing shape helpers and returns the plate bounds', async () => {
  const moduleURL = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
  const engine = moduleURL('export const canvas={},comp={size:[320,180]},media={titles:new Map()},player={};')
  const hooks = moduleURL('export const useEffect=()=>{},useRef=()=>({current:null}),useState=x=>[x,()=>{}];')
  const store = moduleURL('export const addRef=()=>{},edit=()=>{},set=()=>{},store={},time={t:0},toast=()=>{},useStore=()=>({}),useTime=()=>0,viewProject=()=>null;')
  const imports = {
    preact: import.meta.resolve('preact'), 'preact/hooks': hooks, htm: import.meta.resolve('htm'),
    '/core/project.js': new URL('../core/project.js', import.meta.url).href,
    './engine-host.js': engine, './store.js': store,
    '../engine/frame.js': moduleURL(`export const titleAnim=${titleAnim.toString()};`),
    '../engine/media.js': moduleURL('export const mediaUrl=()=>null;'),
    '../engine/shapes.js': new URL('../web/engine/shapes.js', import.meta.url).href,
    './motion/geometry.js': new URL('../web/ui/motion/geometry.js', import.meta.url).href,
    './source-media.js': new URL('../web/ui/source-media.js', import.meta.url).href,
    './registry.js': new URL('../web/ui/registry.js', import.meta.url).href,
    './icons.js': new URL('../web/ui/icons.js', import.meta.url).href,
  }
  let loadedSource = source
  for (const [specifier, target] of Object.entries(imports)) loadedSource = loadedSource.replaceAll("'" + specifier + "'", JSON.stringify(target))
  const { loadedQuad } = await import(moduleURL(loadedSource + '\nexport { quadOf as loadedQuad }\n'))
  const { view, clip } = scene()
  assert.deepEqual(loadedQuad(view, clip, 0), { x: 176, y: 209, w: 320, h: 70, r: 0, s: 1 })
})
for (const [name, shape] of [
  ['default rectangle', {}], ['default ellipse', { type: 'ellipse' }],
  ['sized ellipse', { type: 'ellipse', width: 80, height: 50 }],
  ['polygon', { type: 'polygon', sides: 6, radius: 44 }], ['star', { type: 'star', points: 5, radius: 37, innerRadius: 9 }],
  ['line', { type: 'line', width: 90, stroke: { width: 6, color: '#ffffff' } }],
  ['default line', { type: 'line' }],
  ['path', { type: 'path', path: { vertices: [[-80, -20], [50, -30], [60, 10]], closed: false } }],
  ['rectangle with stroke', { type: 'rect', width: 100, height: 40, stroke: { width: 12, color: '#ffffff' } }],
]) test(`Edit shape bounds agree with the actual renderer outline for ${name}`, () => {
  const { view, clip } = scene(shape)
  assert.deepEqual(sizeOf(view, clip, 0), pathSize(resolvedShape(view, clip, 0)))
})
test('shape dimensions and stroke animation resolve at clip-local time', () => {
  const { view, clip } = scene()
  clip.start = 3
  clip.anim['shape.width'] = [[0, 100], [2, 300]]
  clip.anim['shape.height'] = [[0, 40], [2, 80]]
  clip.anim['shape.stroke.width'] = [[0, 0], [2, 8]]
  for (const local of [0, 0.5, 1, 2]) assert.deepEqual(sizeOf(view, clip, clip.start + local), pathSize(resolvedShape(view, clip, local)))
})
test('shape dimension expressions use local seconds and the open composition', () => {
  const { p, clip } = scene({ type: 'rect', width: 100, height: 40 })
  p.width = 1920; p.height = 1080
  clip.start = 5; clip.expr = { 'shape.width': 'value + time * 40', 'shape.height': 'height / 9' }
  const view = compView(p, 'k1')
  assert.deepEqual(sizeOf(view, clip, 7), [180, 40])
})
test('shape scale and rotation retain their existing animated transform values', () => {
  const { view, clip } = scene()
  clip.scale = 1.5; clip.scaleX = 2; clip.scaleY = 0.5
  clip.anim.rotation = [[0, 0], [2, 90]]
  const q = quadOf(view, clip, 1)
  assert.deepEqual([q.w, q.h], [960, 52.5])
  assert.equal(q.x, valueAt(view, clip, 'x', 1)); assert.equal(q.y, 209)
  assert.equal(q.r, valueAt(view, clip, 'rotation', 1)); assert.equal(q.s, 1.5)
})
for (const quality of [1, 0.5, 0.25]) test(`shape bounds stay in project pixels at preview scale ${quality}`, () => {
  const { view, clip } = scene()
  compositor.size = [640 * quality, 360 * quality]
  assert.deepEqual(sizeOf(view, clip, 0), [320, 70])
})
test('main and nested clips with a reused ID retain their separate geometry', () => {
  const { p, clip } = scene()
  const main = { ...structuredClone(clip), shape: { type: 'ellipse', width: 60, height: 30 } }
  p.tracks.find(tr => tr.kind === 'video').clips = [main]
  assert.deepEqual(sizeOf(compView(p, null), main, 0), [60, 30])
  assert.deepEqual(sizeOf(compView(p, 'k1'), clip, 0), [320, 70])
})
test('geometry reads preserve the full project, animation, paint and metadata', () => {
  const { p, view, clip } = scene(), before = structuredClone(p)
  for (const t of [0, 0.5, 1, 3]) quadOf(view, clip, t)
  assert.deepEqual(p, before)
})
test('media, compositions, titles, full-frame colors and unsupported layer kinds retain their sizes', () => {
  const { view } = scene(); view.assets.a1 = { width: 1920, height: 1080 }
  const base = { id: 'other', start: 0, dur: 4, x: 320, y: 180 }
  for (const kind of ['video', 'image']) assert.deepEqual(sizeOf(view, { ...base, kind, src: 'a1' }, 0), [640, 360])
  assert.deepEqual(sizeOf(view, { ...base, kind: 'comp', comp: 'k1' }, 0), [640, 360])
  assert.deepEqual(sizeOf(view, { ...base, kind: 'title', title: {} }, 0), [400, 120])
  assert.deepEqual(sizeOf(view, { ...base, kind: 'color' }, 0), [640, 360])
  for (const kind of ['audio', 'adjustment']) assert.equal(quadOf(view, { ...base, kind }, 0), null)
  assert.equal(quadOf(view, null, 0), null)
})
function stagePick(p, point, t = 0) {
  const selections = [], body = between(source, 'const onStageDown = e => {', '\n  return html`')
  const handler = new Function('p', 'rect', 'time', 'quadOf', 'set', 'addRef', 'timecode', 'clipEnd', `${body};return onStageDown`)(p, { x: 0, y: 0, w: p.width, h: p.height }, { t }, quadOf, patch => selections.push(patch.selection), () => {}, timecode, clipEnd)
  handler({ target: { closest: () => false }, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) }, clientX: point[0], clientY: point[1] })
  return selections.at(-1)
}
test('actual stage hit testing selects the plate inside its outline and clears outside it', () => {
  const { view } = scene()
  assert.deepEqual(stagePick(view, [176, 209]), ['c6'])
  assert.deepEqual(stagePick(view, [400, 209]), [])
})
test('actual stage hit testing lets a full-frame layer behind the plate receive an outside click', () => {
  const { view } = scene()
  view.tracks.unshift({ id: 'V0', kind: 'video', clips: [{ id: 'background', kind: 'color', color: '#000000', start: 0, dur: 4 }] })
  assert.deepEqual(stagePick(view, [176, 209]), ['c6'])
  assert.deepEqual(stagePick(view, [400, 209]), ['background'])
})
test('actual transform overlay draws the small shape handles and keeps animated drag edit dispatch', () => {
  const { p, view, clip } = scene(), before = structuredClone(p), calls = []
  const rect = { x: 10, y: 12, w: 320, h: 180 }, time = { t: 0 }, store = { selection: ['c6'] }
  let drag = null
  const edit = operations => { calls.push(Array.isArray(operations) ? operations : [operations]) }
  const setProp = new Function('time', 'edit', `return (${between(source, 'export function setProp(', 'function TransformOverlay(').replace('export ', '')})`)(time, edit)
  const overlay = new Function('useTime', 'store', 'useState', 'clipEnd', 'quadOf', 'html', 'time', 'edit', 'setProp', 'titleAnim', `return (${between(source, 'function TransformOverlay(', 'export function Viewer(')})`)(() => time.t, store, () => [drag, value => { drag = value }], clipEnd, quadOf, htm.bind(h), time, edit, setProp, titleAnim)
  const render = () => overlay({ p: view, rect })
  let tree = render()
  assert.deepEqual(tree.props.style, { left: '18px', top: '99px', width: '160px', height: '35px', transform: 'rotate(0deg)' })
  const event = { clientX: 100, clientY: 100, pointerId: 1, stopPropagation() {}, preventDefault() {}, target: { setPointerCapture() {} }, currentTarget: { closest: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }) } }
  tree.props.onPointerDown(event); tree = render(); tree.props.onPointerMove({ ...event, clientX: 112, clientY: 105 }); tree = render(); tree.props.onPointerUp()
  assert.deepEqual(calls, [[{ op: 'keyframe', id: 'c6', prop: 'x', at: 0, value: 200 }, { op: 'update', id: 'c6', set: { y: 219 } }]])
  assert.deepEqual(p, before)
  const updated = applyOps(p, calls[0].map(op => ({ ...op, comp: 'k1' }))).project
  assert.deepEqual(updated.tracks, p.tracks)
  const next = updated.comps.k1.tracks[0].clips[0]
  assert.deepEqual(next.shape, clip.shape); assert.equal(next.note, clip.note)
  assert.equal(next.anim.x[0][1], 200); assert.equal(next.anim.x[1][1], 192)
})
