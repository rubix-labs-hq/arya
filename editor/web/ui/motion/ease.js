// Keyframe easing for the graph editor and the ease presets.
//
// A key's ease shapes the segment that leaves it (format §1.4) as a CSS cubic bezier
// [x1, y1, x2, y2] in the unit square: (x1, y1) is the outgoing handle of the left key,
// (x2, y2) the incoming handle of the right key. x stays in [0, 1]; y may overshoot.
// Pure: runs in the browser and under node --test.

import { EASES } from '/core/project.js'

/** Influence After Effects' Easy Ease uses: a third of the segment, speed zero. */
export const EASY = 1 / 3

const clamp01 = v => Math.max(0, Math.min(1, v))
const r = v => Math.round(v * 10000) / 10000

/** A key's ease as a bezier, or null for hold. Linear and unknown names are [0, 0, 1, 1]. */
export function bezierOf(ease) {
  if (ease === 'hold') return null
  if (Array.isArray(ease)) return ease.map(Number)

  return [...(EASES[ease ?? 'linear'] ?? EASES.linear)]
}

/** The ease to store for a bezier: 'linear' when it is the identity, else the rounded array. */
export function easeValue(bz) {
  const b = bz.map(r)
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 1) return 'linear'

  return [clamp01(b[0]), b[1], clamp01(b[2]), b[3]]
}

/**
 * Bezier handles of the segment from key a = [t0, v0] to b = [t1, v1] in graph units:
 * { out: [t, v] } leaving a and { in: [t, v] } arriving at b. `flat` is the value span
 * to use when the segment does not change value (its handles still need a height).
 */
export function handlesOf(a, b, ease, flat = 1) {
  const bz = bezierOf(ease) ?? [0, 0, 1, 1]
  const dt = b[0] - a[0]
  const dv = Math.abs(b[1] - a[1]) < 1e-9 ? flat : b[1] - a[1]

  return { out: [a[0] + bz[0] * dt, a[1] + bz[1] * dv], in: [a[0] + bz[2] * dt, a[1] + bz[3] * dv] }
}

/**
 * The bezier after dragging one handle of the segment a → b to graph point pt.
 * `side` is 'out' (the handle leaving a) or 'in' (arriving at b).
 */
export function dragHandle(a, b, ease, side, pt, flat = 1) {
  const bz = bezierOf(ease) ?? [0, 0, 1, 1]
  const dt = b[0] - a[0] || 1e-9
  const dv = Math.abs(b[1] - a[1]) < 1e-9 ? flat : b[1] - a[1]
  const x = clamp01((pt[0] - a[0]) / dt)
  const y = (pt[1] - a[1]) / dv
  if (side === 'out') return easeValue([x, y, bz[2], bz[3]])

  return easeValue([bz[0], bz[1], x, y])
}

/** Value-per-second at the ends of a segment: { out: speed leaving a, in: speed arriving at b }. */
export function segmentSpeeds(a, b, ease) {
  const bz = bezierOf(ease)
  const dt = b[0] - a[0] || 1e-9
  const avg = (b[1] - a[1]) / dt
  if (!bz) return { out: 0, in: 0 }
  const [x1, y1, x2, y2] = bz
  const start = x1 > 1e-6 ? y1 / x1 : y1 === 0 ? (x2 > 1e-6 ? y2 / x2 : 1) : Math.sign(y1) * 1e3
  const end = x2 < 1 - 1e-6 ? (1 - y2) / (1 - x2) : y2 === 1 ? (x1 < 1 - 1e-6 ? (1 - y1) / (1 - x1) : 1) : Math.sign(1 - y2) * 1e3

  return { out: avg * start, in: avg * end }
}

/**
 * Speed graph handles of a segment: influence (fraction of the segment, 0…1) and speed
 * (value per second) at each end, the way After Effects shows them.
 */
export function speedHandles(a, b, ease) {
  const bz = bezierOf(ease) ?? [0, 0, 1, 1]
  const s = segmentSpeeds(a, b, ease)

  return { out: { influence: bz[0], speed: s.out }, in: { influence: 1 - bz[2], speed: s.in } }
}

/**
 * The bezier for a speed graph handle set to `influence` and `speed` on one side.
 * Influence is kept at least 0.01 so the speed stays defined.
 */
export function bezierFromSpeed(a, b, ease, side, influence, speed) {
  const bz = bezierOf(ease) ?? [0, 0, 1, 1]
  const dt = b[0] - a[0] || 1e-9
  const dv = b[1] - a[1]
  const inf = Math.max(0.01, Math.min(1, influence))
  // slope in the unit square = speed / average speed
  const slope = Math.abs(dv) < 1e-9 ? 0 : (speed * dt) / dv
  if (side === 'out') return easeValue([inf, slope * inf, bz[2], bz[3]])

  return easeValue([bz[0], bz[1], 1 - inf, 1 - slope * inf])
}

/**
 * Easy ease presets on key i of a sorted key list, as { index, ease } edits:
 * 'easy' eases both sides, 'in' the segment arriving at i (the previous key's [x2, y2]),
 * 'out' the segment leaving i ([x1, y1]); 'linear' makes both sides linear.
 * Hold segments become beziers.
 */
export function easeEdits(keys, i, mode) {
  const edits = new Map()
  const get = j => edits.get(j) ?? (bezierOf(keys[j][2]) ?? [0, 0, 1, 1])
  const both = mode === 'easy' || mode === 'linear'
  if ((mode === 'out' || both) && i < keys.length - 1) {
    const bz = get(i)
    edits.set(i, mode === 'linear' ? [0, 0, bz[2], bz[3]] : [EASY, 0, bz[2], bz[3]])
  }
  if ((mode === 'in' || both) && i > 0) {
    const bz = get(i - 1)
    edits.set(i - 1, mode === 'linear' ? [bz[0], bz[1], 1, 1] : [bz[0], bz[1], 1 - EASY, 1])
  }

  return [...edits].map(([index, bz]) => ({ index, ease: easeValue(bz) }))
}

/** The ease's progress at x (0…1), the same curve core/project.js evaluates. */
export function easeAt(ease, x) {
  const bz = bezierOf(ease)
  if (!bz) return 0
  const [x1, y1, x2, y2] = bz
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  let u = x
  for (let k = 0; k < 8; k++) {
    const err = ((ax * u + bx) * u + cx) * u - x
    const d = (3 * ax * u + 2 * bx) * u + cx
    if (Math.abs(err) < 1e-6 || Math.abs(d) < 1e-6) break
    u -= err / d
  }
  u = clamp01(u)

  return ((ay * u + by) * u + cy) * u
}
