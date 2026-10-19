// Anchor point tool math: move a layer's anchor without moving the layer.
//
// localMatrix gives e = x - (a·ax + c·ay), f = y - (b·ax + d·ay), where a, b, c, d are the
// layer's rotation·scale terms. Moving the anchor by (dax, day) leaves the matrix, and so
// the picture, unchanged when position moves by (a·dax + c·day, b·dax + d·day). Parents
// multiply on the left, so this holds for parented layers too.
// Pure: runs in the browser and under node --test.

import { round, sortedKeys } from '/core/project.js'
import { apply, inverse, linearOf, localMatrix, transformAt } from './geometry.js'

/** The position change that keeps the layer still when its anchor moves by (dax, day). */
export function anchorCompensation(v, dax, day) {
  const [a, b, c, d] = linearOf(v)

  return [a * dax + c * day, b * dax + d * day]
}

/**
 * Ops that put the anchor of clip `c` at layer point (ax, ay) at timeline time t, with
 * position compensated so nothing moves at t. Animated anchors get a keyframe at t;
 * animated positions shift every key by the same amount, so the motion keeps its shape.
 */
export function anchorOps(p, c, t, ax, ay) {
  const local = t - c.start
  const v = transformAt(p, c, local)
  const dax = ax - v.anchorX
  const day = ay - v.anchorY
  const [dx, dy] = anchorCompensation(v, dax, day)
  const ops = []
  for (const [prop, value] of [['anchorX', ax], ['anchorY', ay]]) {
    const next = round(value, 3)
    if (c.anim?.[prop]?.length) ops.push({ op: 'keyframe', id: c.id, prop, at: t, value: next })
    else ops.push({ op: 'update', id: c.id, set: { [prop]: next } })
  }
  for (const [prop, delta] of [['x', dx], ['y', dy]]) {
    if (Math.abs(delta) < 1e-9) continue
    const keys = sortedKeys(c.anim?.[prop])
    if (keys.length) {
      for (const [kt, kv, ke] of keys) ops.push({ op: 'keyframe', id: c.id, prop, at: kt, local: true, value: round(kv + delta, 3), ...(ke !== undefined ? { ease: ke } : {}) })
    } else ops.push({ op: 'update', id: c.id, set: { [prop]: round(v[prop] + delta, 3) } })
  }

  return ops
}

/**
 * The layer point under a frame point, for a layer drawn through world matrix W.
 * The anchor tool drops the anchor there.
 */
export function layerPointAt(W, pt) {
  return apply(inverse(W), pt)
}

/** Where the anchor of transform values v sits in the parent's space (it is the position). */
export function anchorInParent(v) {
  return apply(localMatrix(v), [v.anchorX ?? 0, v.anchorY ?? 0])
}
