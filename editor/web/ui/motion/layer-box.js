// A layer's drawn size and world matrix in the open timeline, from the same sources the
// renderer uses (resolved shapes, rasterized titles, fitted media).

import { clipEnd } from '/core/project.js'
import { titleAnim, worldMatrix } from '../../engine/frame.js'
import { resolvedShape } from '../../engine/shapes.js'
import { comp as compositor, media } from '../engine-host.js'
import { shapeExtent } from './geometry.js'
import { layerRows } from './ops.js'

/** The box nulls draw in the viewer (they have no pixels of their own). */
export const NULL_SIZE = 100

/** Layer size in layer pixels: { w, h }. */
export function layerSize(view, c, t) {
  const local = t - c.start
  switch (c.kind) {
    case 'shape': {
      const { hw, hh } = shapeExtent(resolvedShape(view, c, local))

      return { w: hw * 2, h: hh * 2 }
    }
    case 'title': {
      const cv = media.titles.get(c.id)?.canvas
      const rs = compositor.size[0] / view.width || 1

      return cv ? { w: cv.width / rs, h: cv.height / rs } : { w: 400, h: 120 }
    }
    case 'video':
    case 'image':
    case 'multicam': {
      const a = view.assets?.[c.kind === 'multicam' ? c.angles?.[0]?.src : c.src] ?? {}
      const aw = a.width ?? view.width
      const ah = a.height ?? view.height
      const fit = Math.min(view.width / aw, view.height / ah)

      return { w: aw * fit, h: ah * fit }
    }
    case 'comp': {
      const k = view.comps?.[c.comp]
      const cw = k?.width ?? view.width
      const ch = k?.height ?? view.height
      const fit = Math.min(view.width / cw, view.height / ch)

      return { w: cw * fit, h: ch * fit }
    }
    case 'null':
      return { w: NULL_SIZE, h: NULL_SIZE }
    default:
      return { w: view.width, h: view.height }
  }
}

/** { w, h, M }: size and world matrix (title animation included) at timeline time t. */
export function layerBox(view, c, t) {
  const tt = Math.max(c.start, Math.min(clipEnd(c) - 1e-4, t))
  const extra = c.kind === 'title' ? titleAnim(c, tt - c.start) : undefined

  return { ...layerSize(view, c, tt), M: worldMatrix(view, c, tt, extra) }
}

/** Visible layers at time t, top to bottom: [{ track, clip }]. */
export function activeLayers(view, t) {
  return layerRows(view).filter(({ track, clip: c }) => !track.hidden && c.enabled !== false && c.kind !== 'audio' && c.kind !== 'caption' && c.start <= t + 1e-6 && t < clipEnd(c) - 1e-6)
}
