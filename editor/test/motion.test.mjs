// node --test editor/test
// The Motion page's pure modules (web/ui/motion) import '/core/project.js' as the browser
// does; this hook maps that to editor/core before they load.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const editor = new URL('../', import.meta.url)
registerHooks({
  resolve(spec, ctx, next) {
    return next(spec.startsWith('/core/') ? new URL(`.${spec}`, editor).href : spec, ctx)
  },
})

const { applyOps, findClip, newProject, valueAt, sortedKeys, ease: coreEase } = await import('../core/project.js')
const geo = await import('../web/ui/motion/geometry.js')
const { anchorOps } = await import('../web/ui/motion/anchor.js')
const { penShape, maskPath, closesPath, samplePath, vertex } = await import('../web/ui/motion/pen.js')
const { shapeFromDrag, addShapeOps, addPenShapeOps, maskFromDrag, dragBox, resizeMask } = await import('../web/ui/motion/draw.js')
const ease = await import('../web/ui/motion/ease.js')
const kf = await import('../web/ui/motion/keyframes.js')
const ops = await import('../web/ui/motion/ops.js')
const { presetOps } = await import('../web/ui/motion/presets.js')
const { propertyGroups, propValue } = await import('../web/ui/motion/props.js')

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`)
const closeM = (A, B, eps = 1e-3) => A.forEach((v, i) => close(v, B[i], eps))

function comp() {
  const r = applyOps(newProject('m'), [{ op: 'add_comp', name: 'Comp', duration: 4 }])

  return r.project
}
const run = (p, list) => applyOps(p, list).project
const clip = (p, id) => findClip(p, id).clip
const view = (p, k = 'k1') => ({ ...p, tracks: p.comps[k].tracks, width: p.comps[k].width, height: p.comps[k].height, fps: p.comps[k].fps, compId: k })

test('anchor tool: moving the anchor keeps the layer still (rotated, scaled, parented)', () => {
  let p = comp()
  p = run(p, [
    { op: 'add_null', comp: 'k1', track: 'V1', start: 0, dur: 4, set: { x: 400, y: 300, rotation: 30, scale: 1.5 } },
    { op: 'add_shape', comp: 'k1', track: 'V2', start: 0, dur: 4, shape: { type: 'rect', width: 200, height: 100 }, set: { x: 900, y: 500, rotation: -20, scaleX: 2, scaleY: 0.5 } },
  ])
  p = run(p, [{ op: 'parent', id: 'c2', parent: 'c1', at: 0 }])
  // Move the parent so the parenting actually transforms the child.
  p = run(p, [{ op: 'update', id: 'c1', set: { x: 500, rotation: 45 } }])
  const t = 1.25
  const before = geo.worldMatrixOf(view(p), clip(p, 'c2'), t)
  p = run(p, anchorOps(view(p), clip(p, 'c2'), t, 60, -25))
  const c2 = clip(p, 'c2')
  assert.equal(c2.anchorX, 60)
  assert.equal(c2.anchorY, -25)
  closeM(geo.worldMatrixOf(view(p), c2, t), before)
  // The anchor now sits where layer point (60, -25) is drawn.
  const W = geo.worldMatrixOf(view(p), c2, t)
  const pt = geo.apply(W, [60, -25])
  const parent = geo.parentSpace(W, geo.localMatrix(geo.transformAt(view(p), c2, t)))
  closeM(geo.apply(parent, [c2.x, c2.y]), pt)
})

test('anchor tool shifts every position key and keys an animated anchor', () => {
  let p = comp()
  p = run(p, [{ op: 'add_shape', comp: 'k1', track: 'V1', start: 0, dur: 4, set: { rotation: 90 } }])
  p = run(p, [
    { op: 'keyframe', id: 'c1', prop: 'x', at: 0, value: 100 },
    { op: 'keyframe', id: 'c1', prop: 'x', at: 2, value: 500, ease: 'inOut' },
    { op: 'keyframe', id: 'c1', prop: 'anchorX', at: 0, value: 0 },
  ])
  const t = 1
  const before = geo.worldMatrixOf(view(p), clip(p, 'c1'), t)
  p = run(p, anchorOps(view(p), clip(p, 'c1'), t, 40, 10))
  const c = clip(p, 'c1')
  closeM(geo.worldMatrixOf(view(p), c, t), before)
  // rotation 90: anchor (+40, +10) moves position by (-10, +40); x keys shift by -10, ease kept
  assert.deepEqual(sortedKeys(c.anim.x), [[0, 90], [2, 490, 'inOut']])
  assert.equal(c.y, 540 + 40)
  assert.deepEqual(sortedKeys(c.anim.anchorX).map(k => k[0]), [0, 1])
})

test('pen: mirrored tangents, bbox-centered path, and a mask path through the inverse matrix', () => {
  const pts = [vertex(100, 100), vertex(300, 100, [50, 0]), vertex(300, 300)]
  const s = penShape(pts, true)
  assert.equal(s.x, 225) // bbox includes the control points at 250 and 350
  assert.equal(s.y, 200)
  assert.deepEqual(s.path.vertices, [[-125, -100], [75, -100], [75, 100]])
  assert.deepEqual(s.path.out[1], [50, 0])
  assert.deepEqual(s.path.in[1], [-50, 0])
  assert.equal(s.path.closed, true)
  // The sampled outline passes through every vertex (in frame px after adding x, y).
  const samples = samplePath(s.path, 8)
  for (const v of s.path.vertices) assert.ok(samples.some(q => Math.hypot(q[0] - v[0], q[1] - v[1]) < 1e-6))
  assert.ok(closesPath(pts, [103, 98], 6))
  assert.ok(!closesPath(pts, [130, 98], 6))
  // As a shape layer: the op lands on a free top track spanning the composition.
  let p = comp()
  p = run(p, addPenShapeOps(view(p), pts, true, 0))
  const c = clip(p, 'c1')
  assert.equal(c.shape.type, 'path')
  assert.deepEqual([c.x, c.y], [225, 200])
  assert.equal(c.dur, 4)
  assert.equal(findClip(p, 'c1').comp, 'k1')
  // Mask path: frame points map into layer pixels of a scaled, moved layer.
  const W = geo.localMatrix({ x: 500, y: 400, scale: 2, rotation: 0, anchorX: 0, anchorY: 0 })
  const m = maskPath([vertex(500, 400, [20, 0]), vertex(600, 400), vertex(600, 500)], true, geo.inverse(W))
  assert.deepEqual(m.vertices, [[0, 0], [50, 0], [50, 50]])
  assert.deepEqual(m.out[0], [10, 0])
  assert.deepEqual(m.in[0], [-10, 0])
})

test('shape tools: drags become add_shape ops on a free top track', () => {
  let p = comp()
  const rect = shapeFromDrag('rect', [100, 100], [500, 300], {}, { fill: '#ff0000' })
  assert.deepEqual([rect.x, rect.y, rect.shape.width, rect.shape.height], [300, 200, 400, 200])
  const sq = dragBox([100, 100], [500, 300], { square: true })
  assert.deepEqual([sq.w, sq.h], [400, 400])
  const ctr = dragBox([100, 100], [150, 120], { fromCenter: true })
  assert.deepEqual([ctr.cx, ctr.cy, ctr.w, ctr.h], [100, 100, 100, 40])
  const star = shapeFromDrag('star', [960, 540], [1060, 540], {}, { points: 6 })
  assert.equal(star.shape.radius, 100)
  assert.equal(star.shape.points, 6)
  assert.equal(star.rotation, 90) // the first point (up) turns toward the pointer on the right
  assert.equal(shapeFromDrag('rect', [0, 0], [1, 1]), null)
  p = run(p, addShapeOps(view(p), rect, 0))
  p = run(p, addShapeOps(view(p), star, 0))
  p = run(p, addShapeOps(view(p), shapeFromDrag('ellipse', [0, 0], [50, 50], {}, { fill: null, strokeWidth: 4 }), 0))
  const v = view(p)
  // c1 took the empty top track V3; the next two each got a new track on top.
  assert.deepEqual(ops.layerRows(v).map(r => [r.track.id, r.clip.id]), [['V5', 'c3'], ['V4', 'c2'], ['V3', 'c1']])
  assert.equal(clip(p, 'c2').rotation, 90)
  assert.equal(clip(p, 'c3').shape.fill, null)
  assert.equal(clip(p, 'c3').shape.stroke.width, 4)
})

test('mask tools: a drag maps into layer pixels; corner drags resize with the opposite corner fixed', () => {
  const W = geo.localMatrix({ x: 960, y: 540, scale: 0.5, rotation: 0 })
  const m = maskFromDrag('ellipse', [910, 490], [1010, 590], geo.inverse(W))
  assert.deepEqual(m, { type: 'ellipse', x: 0, y: 0, w: 200, h: 200 })
  let p = comp()
  p = run(p, [{ op: 'add_shape', comp: 'k1', track: 'V1', start: 0, dur: 4 }, { op: 'add_mask', id: 'c1', mask: m }])
  assert.equal(clip(p, 'c1').masks[0].type, 'ellipse')
  const r = resizeMask({ x: 0, y: 0, w: 200, h: 100 }, 2, [150, 80], 400, 400)
  assert.deepEqual(r, { x: 25, y: 15, w: 250, h: 130 })
})

test('ease handles: bezier ↔ graph handles and speed handles round-trip', () => {
  const a = [1, 100]
  const b = [3, 500]
  const h = ease.handlesOf(a, b, [0.25, 0.1, 0.75, 0.9])
  closeM(h.out, [1.5, 140])
  closeM(h.in, [2.5, 460])
  assert.deepEqual(ease.dragHandle(a, b, [0.25, 0.1, 0.75, 0.9], 'out', [1.5, 140]), [0.25, 0.1, 0.75, 0.9])
  assert.deepEqual(ease.dragHandle(a, b, 'linear', 'in', [2, 600]), [0, 0, 0.5, 1.25]) // overshoot keeps y
  assert.deepEqual(ease.dragHandle(a, b, 'linear', 'out', [9, 100]), [1, 0, 1, 1]) // x clamps to 1
  assert.equal(ease.easeValue([0, 0, 1, 1]), 'linear')
  // Speed handles: easy ease starts and ends at speed 0 with a third of influence.
  const sp = ease.speedHandles(a, b, [1 / 3, 0, 2 / 3, 1])
  close(sp.out.speed, 0)
  close(sp.in.influence, 1 / 3)
  // Linear: speed is the average, 200/s.
  close(ease.segmentSpeeds(a, b, 'linear').out, 200)
  const bz = ease.bezierFromSpeed(a, b, 'linear', 'out', 0.5, 100)
  close(ease.speedHandles(a, b, bz).out.speed, 100)
  close(ease.speedHandles(a, b, bz).out.influence, 0.5)
  // Our curve matches the core's evaluation.
  for (const x of [0.1, 0.4, 0.8]) close(ease.easeAt([0.3, -0.2, 0.6, 1.3], x), coreEase([0.3, -0.2, 0.6, 1.3], x), 1e-6)
})

test('easy ease (F9), ease in and out write keyframe_ease on the right segments', () => {
  let p = comp()
  p = run(p, [{ op: 'add_shape', comp: 'k1', track: 'V1', start: 0, dur: 4 }])
  p = run(p, [0, 1, 2].map(t => ({ op: 'keyframe', id: 'c1', prop: 'x', at: t, value: t * 100 })))
  const mid = kf.keyId('c1', 'x', 1)
  // F9 on the middle key: the segment arriving gets [x2, y2] = [2/3, 1], the one leaving [x1, y1] = [1/3, 0].
  let q = run(p, kf.easeOps(p, [mid], 'easy'))
  let keys = sortedKeys(clip(q, 'c1').anim.x)
  assert.deepEqual(keys[0][2], [0, 0, 0.6667, 1])
  assert.deepEqual(keys[1][2], [0.3333, 0, 1, 1])
  assert.equal(keys[2][2], undefined)
  // Ease in only touches the arriving segment; ease out only the leaving one.
  q = run(p, kf.easeOps(p, [mid], 'in'))
  keys = sortedKeys(clip(q, 'c1').anim.x)
  assert.deepEqual([keys[0][2], keys[1][2]], [[0, 0, 0.6667, 1], undefined])
  q = run(p, kf.easeOps(p, [mid], 'out'))
  keys = sortedKeys(clip(q, 'c1').anim.x)
  assert.deepEqual([keys[0][2], keys[1][2]], [undefined, [0.3333, 0, 1, 1]])
  // F9 on all three keys: both handles of both segments eased; values unchanged at keys.
  q = run(p, kf.easeOps(p, kf.allKeyIds([clip(p, 'c1')]), 'easy'))
  keys = sortedKeys(clip(q, 'c1').anim.x)
  assert.deepEqual(keys[0][2], [0.3333, 0, 0.6667, 1])
  assert.deepEqual(keys[1][2], [0.3333, 0, 0.6667, 1])
  close(valueAt(view(q), clip(q, 'c1'), 'x', 0.5), 50, 1e-6)
  // Linear undoes it; hold and named presets act on the leaving segment.
  q = run(q, kf.easeOps(q, kf.allKeyIds([clip(q, 'c1')]), 'linear'))
  assert.ok(sortedKeys(clip(q, 'c1').anim.x).every(k => k.length === 2))
  q = run(q, kf.easeOps(q, [mid], 'hold'))
  assert.equal(sortedKeys(clip(q, 'c1').anim.x)[1][2], 'hold')
  close(valueAt(view(q), clip(q, 'c1'), 'x', 1.9), 100, 1e-9)
})

test('keyframe drag: retime moves selected keys, crossing others, and keeps values and eases', () => {
  let p = comp()
  p = run(p, [{ op: 'add_shape', comp: 'k1', track: 'V1', start: 0, dur: 4 }])
  p = run(p, [
    { op: 'keyframe', id: 'c1', prop: 'x', at: 0, value: 0, ease: 'inOut' },
    { op: 'keyframe', id: 'c1', prop: 'x', at: 1, value: 100 },
    { op: 'keyframe', id: 'c1', prop: 'x', at: 2, value: 200 },
    { op: 'keyframe', id: 'c1', prop: 'opacity', at: 0.5, value: 0 },
  ])
  // Drag the first x key and the opacity key 1.5 s later: x[0] crosses x[1] and lands between.
  const sel = [kf.keyId('c1', 'x', 0), kf.keyId('c1', 'opacity', 0.5)]
  const { ops: list, selection } = kf.retimeOps(p, sel, 1.51, 30) // snaps to 1.5 s
  p = run(p, list)
  const c = clip(p, 'c1')
  assert.deepEqual(sortedKeys(c.anim.x), [[1, 100], [1.5, 0, 'inOut'], [2, 200]])
  assert.deepEqual(c.anim.opacity, [[2, 0]])
  assert.deepEqual(selection.sort(), [kf.keyId('c1', 'opacity', 2), kf.keyId('c1', 'x', 1.5)].sort())
  // Dragging onto an unselected key replaces it; times clamp to the clip.
  p = run(p, kf.retimeOps(p, [kf.keyId('c1', 'x', 1.5)], 0.5, 30).ops)
  assert.deepEqual(sortedKeys(clip(p, 'c1').anim.x), [[1, 100], [2, 0, 'inOut']])
  p = run(p, kf.retimeOps(p, [kf.keyId('c1', 'x', 2)], 10, 30).ops)
  assert.deepEqual(sortedKeys(clip(p, 'c1').anim.x), [[1, 100], [4, 0, 'inOut']])
})

test('keyframe copy, paste at the playhead, and delete', () => {
  let p = comp()
  p = run(p, [{ op: 'add_shape', comp: 'k1', track: 'V1', start: 0, dur: 4 }, { op: 'add_shape', comp: 'k1', track: 'V2', start: 1, dur: 3 }])
  p = run(p, [
    { op: 'keyframe', id: 'c1', prop: 'x', at: 0.5, value: 10, ease: [0.1, 0.2, 0.3, 0.4] },
    { op: 'keyframe', id: 'c1', prop: 'x', at: 1, value: 20 },
    { op: 'keyframe', id: 'c1', prop: 'y', at: 1, value: 30 },
  ])
  const ids = kf.allKeyIds([clip(p, 'c1')])
  const board = kf.copyKeys(p, ids)
  assert.deepEqual(board.items.map(i => [i.prop, i.dt]).sort(), [['x', 0], ['x', 0.5], ['y', 0.5]])
  // Paste into c2 (starts at 1 s) at timeline 2 s: first key at local 1 s.
  const pasted = kf.pasteOps(board, clip(p, 'c2'), 2, 30)
  p = run(p, pasted.ops)
  assert.deepEqual(sortedKeys(clip(p, 'c2').anim.x), [[1, 10, [0.1, 0.2, 0.3, 0.4]], [1.5, 20]])
  assert.deepEqual(clip(p, 'c2').anim.y, [[1.5, 30]])
  // One property onto another.
  const one = kf.copyKeys(p, [kf.keyId('c1', 'y', 1)])
  p = run(p, kf.pasteOps(one, clip(p, 'c2'), 1, 30, 'rotation').ops)
  assert.deepEqual(clip(p, 'c2').anim.rotation, [[0, 30]])
  p = run(p, kf.deleteOps(kf.allKeyIds([clip(p, 'c2')], ['x'])))
  assert.equal(clip(p, 'c2').anim.x, undefined)
})

test('solo hides tracks without a soloed layer and restores exactly those', () => {
  let p = comp()
  p = run(p, [
    { op: 'add_shape', comp: 'k1', track: 'V1' },
    { op: 'add_shape', comp: 'k1', track: 'V2' },
    { op: 'add_shape', comp: 'k1', track: 'V3' },
    { op: 'update_track', comp: 'k1', id: 'V3', set: { hidden: true } },
  ])
  p = run(p, ops.soloOps(view(p), 'c1'))
  let tr = Object.fromEntries(p.comps.k1.tracks.map(t => [t.id, t]))
  assert.equal(clip(p, 'c1').solo, true)
  assert.deepEqual([tr.V1.hidden, tr.V2.hidden, tr.V2.soloHidden, tr.V3.hidden, tr.V3.soloHidden], [undefined, true, true, true, undefined])
  p = run(p, ops.soloOps(view(p), 'c2'))
  tr = Object.fromEntries(p.comps.k1.tracks.map(t => [t.id, t]))
  assert.equal(tr.V2.hidden, undefined)
  p = run(p, ops.soloOps(view(p), 'c1'))
  p = run(p, ops.soloOps(view(p), 'c2'))
  tr = Object.fromEntries(p.comps.k1.tracks.map(t => [t.id, t]))
  assert.deepEqual([tr.V1.hidden, tr.V2.hidden, tr.V3.hidden], [undefined, undefined, true]) // V3 was hidden before solo
})

test('duplicate composition copies layers and rewires parents and mattes to the copies', () => {
  let p = comp()
  p = run(p, [
    { op: 'add_null', comp: 'k1', track: 'V1', start: 0, dur: 4, name: 'Ctrl' },
    { op: 'add_shape', comp: 'k1', track: 'V2', start: 0.5, dur: 3 },
    { op: 'add_shape', comp: 'k1', track: 'V3', start: 0, dur: 4 },
    { op: 'add_track', comp: 'k1', kind: 'video' },
    { op: 'add_shape', comp: 'k1', track: 'V4', start: 1, dur: 2 },
    { op: 'update_track', comp: 'k1', id: 'V4', set: { locked: true, name: 'Top' } },
  ])
  p = run(p, [{ op: 'parent', id: 'c2', parent: 'c1' }, { op: 'matte', id: 'c3', matte: { mode: 'luma', source: 'c2' } }, { op: 'keyframe', id: 'c2', prop: 'x', at: 1, value: 5 }])
  const d = ops.duplicateCompOps(p, 'k1', 'Copy')
  p = run(p, d.ops)
  const k2 = p.comps.k2
  assert.equal(k2.name, 'Copy')
  assert.equal(k2.duration, 4)
  const clips = k2.tracks.flatMap(t => t.clips.map(c => [t.id, c]))
  assert.equal(clips.length, 4)
  const byOld = id => findClip(p, d.ids.get(id))
  assert.equal(byOld('c2').comp, 'k2')
  assert.equal(byOld('c2').clip.parent, d.ids.get('c1'))
  assert.equal(byOld('c3').clip.matte.source, d.ids.get('c2'))
  assert.equal(byOld('c2').clip.start, 0.5)
  assert.deepEqual(byOld('c2').clip.anim.x, [[0.5, 5]]) // the key at 1 s on a clip starting at 0.5 s
  assert.equal(byOld('c4').track.id, 'V4')
  assert.equal(byOld('c4').track.locked, true)
  assert.equal(byOld('c4').track.name, 'Top')
  // The originals are untouched.
  assert.equal(clip(p, 'c2').parent, 'c1')
})

test('motion presets write keyframes that play back as described', () => {
  let p = comp()
  p = run(p, [
    { op: 'add_shape', comp: 'k1', track: 'V1', start: 0, dur: 4, shape: { type: 'rect', width: 300, height: 200 }, set: { y: 500 } },
    { op: 'add_title', comp: 'k1', track: 'V2', start: 0, dur: 4, text: 'Hi' },
  ])
  const v = () => view(p)
  p = run(p, presetOps(v(), clip(p, 'c1'), 'pop', 1).ops)
  let c = clip(p, 'c1')
  assert.equal(valueAt(v(), c, 'scale', 1), 0)
  close(valueAt(v(), c, 'scale', 1.45), 1)
  assert.ok(valueAt(v(), c, 'scale', 1.3) > 1, 'backOut overshoots')
  p = run(p, presetOps(v(), clip(p, 'c1'), 'bounce', 0).ops)
  c = clip(p, 'c1')
  close(valueAt(v(), c, 'y', 0.45), 500)
  assert.ok(valueAt(v(), c, 'y', 0.65) < 500)
  close(valueAt(v(), c, 'y', 2), 500)
  const wipe = presetOps(v(), clip(p, 'c1'), 'wipe', 0, { layerW: 300, layerH: 200 })
  p = run(p, wipe.ops)
  c = clip(p, 'c1')
  assert.equal(wipe.mask, 'mk1')
  assert.deepEqual(c.masks[0], { id: 'mk1', type: 'rect', mode: 'add', feather: 0, expansion: 0, opacity: 1, inverted: false, x: -150, y: 0, w: 600, h: 800 })
  close(valueAt(v(), c, 'mask.mk1.expansion', 0), -300)
  close(valueAt(v(), c, 'mask.mk1.expansion', 0.8), 0)
  const draw = presetOps(v(), clip(p, 'c1'), 'drawOn', 0)
  assert.ok(draw.note)
  p = run(p, draw.ops)
  c = clip(p, 'c1')
  assert.equal(c.shape.fill, undefined)
  assert.equal(c.shape.stroke.width, 8)
  close(valueAt(v(), c, 'shape.trim.end', 0.5), 0.5)
  assert.throws(() => presetOps(v(), clip(p, 'c2'), 'drawOn', 0), /shape layer/)
  p = run(p, presetOps(v(), clip(p, 'c2'), 'typewriter', 0).ops)
  assert.equal(clip(p, 'c2').title.anim, 'typewriter')
  assert.throws(() => presetOps(v(), clip(p, 'c1'), 'typewriter', 0), /text layer/)
  p = run(p, presetOps(v(), clip(p, 'c2'), 'spin', 0).ops)
  close(valueAt(v(), clip(p, 'c2'), 'rotation', 0), -180)
  p = run(p, presetOps(v(), clip(p, 'c2'), 'slideUp', 0).ops)
  close(valueAt(v(), clip(p, 'c2'), 'opacity', 0.3), 1)
})

test('property rows: shape and mask groups, nested defaults', () => {
  let p = comp()
  p = run(p, [{ op: 'add_shape', comp: 'k1', track: 'V1', shape: { type: 'star' } }, { op: 'add_mask', id: 'c1', mask: { type: 'ellipse' } }])
  const c = clip(p, 'c1')
  const groups = propertyGroups(c)
  assert.deepEqual(groups.map(g => g.id), ['transform', 'shape', 'mask:mk1'])
  assert.ok(groups[1].rows.some(r => r.prop === 'shape.points'))
  assert.ok(!groups[1].rows.some(r => r.prop === 'shape.width'))
  assert.equal(propValue(view(p), c, 'shape.trim.end', 0), 1)
  assert.equal(propValue(view(p), c, 'mask.mk1.opacity', 0), 1)
  // setValueOp routes nested props: shape fields through update, masks through update_mask.
  p = run(p, [ops.setValueOp(c, 'shape.stroke.width', 3, 0), ops.setValueOp(c, 'mask.mk1.feather', 12, 0)])
  assert.equal(clip(p, 'c1').shape.stroke.width, 3)
  assert.equal(clip(p, 'c1').masks[0].feather, 12)
})
