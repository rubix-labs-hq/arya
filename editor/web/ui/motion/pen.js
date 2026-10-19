// Pen tool: clicked vertices with dragged tangents become a bezier path.
// A drag at a vertex sets mirrored tangents: out = drag vector, in = −drag vector.
// Shape paths (format §1.2) are in layer pixels around the layer center, tangents
// relative to each vertex. Pure: runs in the browser and under node --test.

import { round } from '/core/project.js'
import { apply, applyVec } from './geometry.js'

/** A pen vertex: position [x, y] and its out tangent [dx, dy] ([0, 0] for a corner). */
export const vertex = (x, y, out = [0, 0]) => ({ pt: [x, y], out })

const r2 = ([x, y]) => [round(x, 2), round(y, 2)]
const neg = ([x, y]) => [x === 0 ? 0 : -x, y === 0 ? 0 : -y]

/**
 * A shape layer from pen vertices in frame pixels: { x, y, path } where (x, y) is the
 * center of the vertices' bounding box (control points included) and the path is
 * relative to it.
 */
export function penShape(points, closed) {
  if (points.length < 2) throw new Error('a path needs at least two points')
  const xs = []
  const ys = []
  for (const { pt, out } of points) {
    xs.push(pt[0], pt[0] + out[0], pt[0] - out[0])
    ys.push(pt[1], pt[1] + out[1], pt[1] - out[1])
  }
  const cx = round((Math.min(...xs) + Math.max(...xs)) / 2, 2)
  const cy = round((Math.min(...ys) + Math.max(...ys)) / 2, 2)

  return { x: cx, y: cy, path: pathFrom(points.map(v => ({ pt: [v.pt[0] - cx, v.pt[1] - cy], out: v.out })), closed) }
}

/** The format's path object for vertices already in the target space. */
export function pathFrom(points, closed) {
  return {
    closed: Boolean(closed),
    vertices: points.map(v => r2(v.pt)),
    in: points.map(v => r2(neg(v.out))),
    out: points.map(v => r2(v.out)),
  }
}

/**
 * A mask path from pen vertices in frame pixels, for a layer drawn through world matrix
 * W: vertices map through W⁻¹, tangents through its linear part.
 */
export function maskPath(points, closed, invW) {
  return pathFrom(points.map(v => ({ pt: apply(invW, v.pt), out: applyVec(invW, v.out) })), closed)
}

/** Whether a click at pt (frame px) closes the path: it lands on the first vertex. */
export function closesPath(points, pt, tolerance) {
  if (points.length < 3) return false
  const [x, y] = points[0].pt

  return Math.hypot(pt[0] - x, pt[1] - y) <= tolerance
}

/**
 * Points along a path for drawing and hit tests: each segment sampled as a cubic
 * bezier, the same curve shapes.js draws.
 */
export function samplePath(path, steps = 16) {
  const pts = path.vertices ?? []
  const ins = path.in ?? []
  const outs = path.out ?? []
  const out = []
  const seg = (i, j) => {
    const [x0, y0] = pts[i]
    const [x3, y3] = pts[j]
    const o = outs[i] ?? [0, 0]
    const n = ins[j] ?? [0, 0]
    const x1 = x0 + o[0]
    const y1 = y0 + o[1]
    const x2 = x3 + n[0]
    const y2 = y3 + n[1]
    for (let s = 1; s <= steps; s++) {
      const u = s / steps
      const m = 1 - u
      out.push([m * m * m * x0 + 3 * m * m * u * x1 + 3 * m * u * u * x2 + u * u * u * x3, m * m * m * y0 + 3 * m * m * u * y1 + 3 * m * u * u * y2 + u * u * u * y3])
    }
  }
  if (pts.length) out.push(pts[0])
  for (let i = 1; i < pts.length; i++) seg(i - 1, i)
  if (path.closed !== false && pts.length > 2) seg(pts.length - 1, 0)

  return out
}
