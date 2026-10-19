// 2D affine math for the Motion page, matching engine/frame.js: a matrix is
// [a, b, c, d, e, f] for x' = a x + c y + e, y' = b x + d y + f. Layer pixels have their
// origin at the layer center; the anchor is an offset from that center.
// Pure: runs in the browser and under node --test.

import { valueAt } from '/core/project.js'

export const IDENTITY = [1, 0, 0, 1, 0, 0]

export const mul = (A, B) => [
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
]

export function inverse(M) {
  const det = M[0] * M[3] - M[1] * M[2] || 1e-9

  return [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det, (M[2] * M[5] - M[3] * M[4]) / det, (M[1] * M[4] - M[0] * M[5]) / det]
}

/** Maps a point through M. */
export const apply = (M, [x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]]

/** Maps a vector (a tangent or a delta) through M's linear part only. */
export const applyVec = (M, [x, y]) => [M[0] * x + M[2] * y, M[1] * x + M[3] * y]

/** Position · rotation · scale · −anchor, the same as frame.js localMatrix. */
export function localMatrix(v) {
  const r = ((v.rotation ?? 0) * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const sx = (v.scale ?? 1) * (v.scaleX ?? 1)
  const sy = (v.scale ?? 1) * (v.scaleY ?? 1)
  const a = cos * sx
  const b = sin * sx
  const c = -sin * sy
  const d = cos * sy
  const ax = v.anchorX ?? 0
  const ay = v.anchorY ?? 0

  return [a, b, c, d, v.x - (a * ax + c * ay), v.y - (b * ax + d * ay)]
}

export const TRANSFORM_PROPS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'anchorX', 'anchorY']

/** The clip's transform values at clip-local seconds (keyframes and expressions applied). */
export function transformAt(p, c, local) {
  return Object.fromEntries(TRANSFORM_PROPS.map(k => [k, valueAt(p, c, k, local)]))
}

/**
 * The world matrix of a clip at timeline time t, parents applied relative to the pose
 * they had when parented. Mirrors frame.js worldMatrix (without title animation offsets).
 */
export function worldMatrixOf(p, c, t, depth = 0) {
  let M = localMatrix(transformAt(p, c, t - c.start))
  if (c.parent && depth < 32) {
    const parent = p.tracks.flatMap(tr => tr.clips).find(x => x.id === c.parent)
    if (parent) {
      const now = worldMatrixOf(p, parent, Math.max(parent.start, Math.min(parent.start + parent.dur, t)), depth + 1)
      const ref = c.parentRef ? localMatrix(c.parentRef) : localMatrix(transformAt(p, parent, 0))
      M = mul(mul(now, inverse(ref)), M)
    }
  }

  return M
}

/** The matrix from a layer's parent space to the frame: its world matrix without its own transform. */
export function parentSpace(world, local) {
  return mul(world, inverse(local))
}

/** Half extents of a shape's outline in layer pixels (stroke included), as shapes.js draws it. */
export function shapeExtent(shape) {
  const type = shape?.type ?? 'rect'
  let hw = 1
  let hh = 1
  if (type === 'rect') {
    hw = (shape.width ?? 400) / 2
    hh = (shape.height ?? 240) / 2
  } else if (type === 'ellipse') {
    hw = (shape.width ?? 300) / 2
    hh = (shape.height ?? 300) / 2
  } else if (type === 'polygon' || type === 'star') {
    hw = hh = shape.radius ?? 180
  } else if (type === 'line') {
    hw = (shape.width ?? 600) / 2
    hh = 1
  } else {
    for (const [x, y] of shape?.path?.vertices ?? []) {
      hw = Math.max(hw, Math.abs(x))
      hh = Math.max(hh, Math.abs(y))
    }
  }
  const sw = shape?.stroke?.width ?? 0

  return { hw: hw + sw / 2, hh: hh + sw / 2 }
}

/** The four corners of a w × h layer through M, clockwise from top left. */
export function corners(M, w, h) {
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(pt => apply(M, pt))
}

/** Whether a frame point lies inside a w × h layer drawn through M. */
export function hitsLayer(M, w, h, pt) {
  const [lx, ly] = apply(inverse(M), pt)

  return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2
}

/** The layer's own rotation·scale terms (a, b, c, d) for transform values v. */
export function linearOf(v) {
  const [a, b, c, d] = localMatrix({ ...v, x: 0, y: 0, anchorX: 0, anchorY: 0 })

  return [a, b, c, d]
}
