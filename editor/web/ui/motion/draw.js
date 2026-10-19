// Shape and mask tools: a drag in the viewer becomes an add_shape or add_mask op.
// Pure: runs in the browser and under node --test.

import { round } from '/core/project.js'
import { apply } from './geometry.js'
import { inView, layerTrack, newLayerSpan } from './ops.js'
import { penShape } from './pen.js'

const r = v => round(v, 2)

/**
 * The box a drag from a to b describes: { cx, cy, w, h }. `square` forces equal sides
 * (Shift), `fromCenter` makes a the center (Option).
 */
export function dragBox(a, b, { square = false, fromCenter = false } = {}) {
  let dx = b[0] - a[0]
  let dy = b[1] - a[1]
  if (square) {
    const s = Math.max(Math.abs(dx), Math.abs(dy))
    dx = Math.sign(dx || 1) * s
    dy = Math.sign(dy || 1) * s
  }
  if (fromCenter) return { cx: a[0], cy: a[1], w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 }

  return { cx: a[0] + dx / 2, cy: a[1] + dy / 2, w: Math.abs(dx), h: Math.abs(dy) }
}

/**
 * A shape layer from a drag in frame pixels: { shape, x, y, rotation }.
 * Rectangles and ellipses span the drag box. Polygons and stars grow from the drag
 * start; the drag length is the radius and its direction turns the first point toward
 * the pointer (Shift keeps it upright).
 */
export function shapeFromDrag(kind, a, b, mods = {}, style = {}) {
  const look = {
    // add_shape merges a default fill, so "no fill" has to be an explicit null.
    fill: style.fill === null ? null : { color: style.fill ?? '#f5b942' },
    ...(style.strokeWidth > 0 ? { stroke: { color: style.stroke ?? '#ffffff', width: style.strokeWidth } } : {}),
  }
  if (kind === 'rect' || kind === 'ellipse') {
    const box = dragBox(a, b, mods)
    if (box.w < 2 || box.h < 2) return null
    const shape = { type: kind, width: r(box.w), height: r(box.h), ...(kind === 'rect' ? { radius: style.radius ?? 0 } : {}), ...look }

    return { shape, x: r(box.cx), y: r(box.cy), rotation: 0 }
  }
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const radius = Math.hypot(dx, dy)
  if (radius < 2) return null
  const rotation = mods.square ? 0 : r((Math.atan2(dy, dx) * 180) / Math.PI + 90)
  const shape = kind === 'star'
    ? { type: 'star', points: style.points ?? 5, radius: r(radius), innerRadius: r(radius * (style.innerRatio ?? 0.45)), ...look }
    : { type: 'polygon', sides: style.sides ?? 6, radius: r(radius), ...look }

  return { shape, x: r(a[0]), y: r(a[1]), rotation }
}

/** The ops that add a drawn shape as a new top layer in `view` at time t. */
export function addShapeOps(view, drawn, t, name) {
  const { start, dur } = newLayerSpan(view, t)
  const { ops, track } = layerTrack(view, start, dur)
  const set = { x: drawn.x, y: drawn.y, ...(drawn.rotation ? { rotation: drawn.rotation } : {}) }

  return [...ops, inView(view, { op: 'add_shape', shape: drawn.shape, track, start, dur, name: name ?? defaultName(drawn.shape.type), set })]
}

/** The ops that add a pen path (frame pixels) as a new shape layer. */
export function addPenShapeOps(view, points, closed, t, style = {}) {
  const { x, y, path } = penShape(points, closed)
  const shape = { type: 'path', path, fill: style.fill === null || !closed ? null : { color: style.fill ?? '#f5b942' }, ...(style.strokeWidth > 0 || !closed ? { stroke: { color: style.stroke ?? '#ffffff', width: style.strokeWidth > 0 ? style.strokeWidth : 6 } } : {}) }

  return addShapeOps(view, { shape, x, y, rotation: 0 }, t, 'Path')
}

const defaultName = type => ({ rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', path: 'Path', line: 'Line' })[type] ?? 'Shape'

/**
 * A rect or ellipse mask from a drag, for a layer drawn through world matrix W
 * (invW is its inverse). Both drag corners map into layer pixels; the mask is the box
 * between them in the layer's own axes.
 */
export function maskFromDrag(kind, a, b, invW, mods = {}) {
  const box = dragBox(a, b, mods)
  const p0 = apply(invW, [box.cx - box.w / 2, box.cy - box.h / 2])
  const p1 = apply(invW, [box.cx + box.w / 2, box.cy + box.h / 2])
  const w = Math.abs(p1[0] - p0[0])
  const h = Math.abs(p1[1] - p0[1])
  if (w < 2 || h < 2) return null

  return { type: kind === 'ellipse' ? 'ellipse' : 'rect', x: r((p0[0] + p1[0]) / 2), y: r((p0[1] + p1[1]) / 2), w: r(w), h: r(h) }
}

/**
 * A rect or ellipse mask resized by dragging one corner handle (layer pixels): the
 * opposite corner stays put. `corner` is 0..3 clockwise from top left.
 */
export function resizeMask(m, corner, pt, layerW, layerH) {
  const w = m.w ?? layerW
  const h = m.h ?? layerH
  const x = m.x ?? 0
  const y = m.y ?? 0
  const pts = [[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2]]
  const fixed = pts[(corner + 2) % 4]
  const nw = Math.max(2, Math.abs(pt[0] - fixed[0]))
  const nh = Math.max(2, Math.abs(pt[1] - fixed[1]))

  return { x: r((pt[0] + fixed[0]) / 2), y: r((pt[1] + fixed[1]) / 2), w: r(nw), h: r(nh) }
}
