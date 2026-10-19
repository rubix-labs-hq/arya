// Motion presets: one click writes keyframes (and masks or stroke) onto the selected
// layer, starting at the playhead. Each preset returns ops; nothing here touches the DOM.
// Pure: runs in the browser and under node --test.

import { round, valueAt } from '/core/project.js'

// Gravity: a fall starts at speed 0 and lands at twice the average speed; a rise is the mirror.
const FALL = [1 / 3, 0, 2 / 3, 1 / 3]
const RISE = [1 / 3, 2 / 3, 2 / 3, 1]
const OUT = [0.16, 1, 0.3, 1]

const r = v => round(v, 4)

export const PRESETS = [
  { id: 'pop', label: 'Pop in', hint: 'Scale from 0 with overshoot' },
  { id: 'slideUp', label: 'Slide up', hint: 'Rise into place and fade in' },
  { id: 'typewriter', label: 'Typewriter', hint: 'Type a text layer on, letter by letter' },
  { id: 'bounce', label: 'Bounce', hint: 'Drop in and bounce to rest' },
  { id: 'spin', label: 'Spin in', hint: 'Rotate and scale up' },
  { id: 'wipe', label: 'Wipe reveal', hint: 'A mask sweeps left to right' },
  { id: 'drawOn', label: 'Draw on', hint: 'Trim paths draws the stroke' },
]

/**
 * The ops for preset `id` on clip c at timeline time t.
 * ctx: { layerW, layerH } (layer pixels, for the wipe), { height } (frame height).
 * Returns { ops, note? }; throws when the preset does not fit the layer.
 */
export function presetOps(p, c, id, t, ctx = {}) {
  const s = r(Math.max(0, Math.min(c.dur, t - c.start)))
  const key = (prop, dt, value, ease) => ({ op: 'keyframe', id: c.id, prop, at: r(Math.min(c.dur, s + dt)), local: true, value: r(value), ...(ease ? { ease } : {}) })
  // The value a property settles on: what it is after the animation would end.
  const rest = (prop, dt) => valueAt(p, c, prop, Math.min(c.dur, s + dt))
  const H = ctx.height ?? p.height ?? 1080
  switch (id) {
    case 'pop': {
      const sc = rest('scale', 0.45)
      const op = rest('opacity', 0.15)

      return { ops: [key('scale', 0, 0, 'backOut'), key('scale', 0.45, sc), key('opacity', 0, 0), key('opacity', 0.15, op)] }
    }
    case 'slideUp': {
      const y = rest('y', 0.6)
      const op = rest('opacity', 0.3)

      return { ops: [key('y', 0, y + H * 0.12, OUT), key('y', 0.6, y), key('opacity', 0, 0, 'out'), key('opacity', 0.3, op)] }
    }
    case 'typewriter': {
      if (c.kind !== 'title') throw new Error('Typewriter needs a text layer')

      return { ops: [{ op: 'update', id: c.id, set: { title: { anim: 'typewriter' } } }] }
    }
    case 'bounce': {
      const y = rest('y', 1.1)
      const h1 = H * 0.35

      return {
        ops: [
          key('y', 0, y - h1, FALL), key('y', 0.45, y, RISE), key('y', 0.65, y - h1 * 0.22, FALL),
          key('y', 0.85, y, RISE), key('y', 0.96, y - h1 * 0.06, FALL), key('y', 1.06, y),
        ],
      }
    }
    case 'spin': {
      const rot = rest('rotation', 0.7)
      const sc = rest('scale', 0.7)
      const op = rest('opacity', 0.2)

      return { ops: [key('rotation', 0, rot - 180, OUT), key('rotation', 0.7, rot), key('scale', 0, 0, OUT), key('scale', 0.7, sc), key('opacity', 0, 0), key('opacity', 0.2, op)] }
    }
    case 'wipe': {
      const w = ctx.layerW
      const h = ctx.layerH
      if (!w || !h) throw new Error('Wipe reveal needs the layer size')
      // A rect whose right edge sits on the layer's right edge and that reaches w past
      // every other edge. Expansion −w insets it to nothing at the left edge; 0 shows the
      // whole layer, so animating expansion sweeps the right edge across.
      const mask = `mk${(c.masks ?? []).reduce((m, x) => Math.max(m, Number(String(x.id).slice(2)) || 0), 0) + 1}`
      const prop = `mask.${mask}.expansion`

      return {
        ops: [
          { op: 'add_mask', id: c.id, mask: { type: 'rect', x: r(-w / 2), y: 0, w: r(2 * w), h: r(h + 2 * w), mode: 'add', feather: 0 } },
          key(prop, 0, -w, 'inOut'), key(prop, 0.8, 0),
        ],
        mask,
      }
    }
    case 'drawOn': {
      if (c.kind !== 'shape') throw new Error('Draw on needs a shape layer')
      const ops = [{ op: 'update', id: c.id, set: { shape: { trim: { start: 0, end: 1, offset: 0 } } } }]
      let note
      if (!(c.shape?.stroke?.width > 0)) {
        // Trim paths cut the stroke only: turn the fill into an outline.
        ops.push({ op: 'update', id: c.id, set: { shape: { stroke: { color: c.shape?.fill?.color ?? '#ffffff', width: 8 }, fill: null } } })
        note = 'Draw on works on strokes, so the fill became an 8 px outline'
      }
      ops.push(key('shape.trim.end', 0, 0, 'inOut'), key('shape.trim.end', 1, 1))

      return { ops, note }
    }
  }
  throw new Error(`no preset ${id}`)
}

/** Text animator presets: the title animations the renderer draws, per character where it can. */
export const TEXT_ANIMATORS = [
  { anim: 'typewriter', label: 'Typewriter', perChar: true, hint: 'Reveals one character at a time' },
  { anim: 'tracking', label: 'Tracking in', perChar: true, hint: 'Letter spacing closes in' },
  { anim: 'blurIn', label: 'Blur in', perChar: false, hint: 'The whole line sharpens' },
  { anim: 'pop', label: 'Pop', perChar: false, hint: 'The whole line scales in with overshoot' },
  { anim: 'rise', label: 'Rise', perChar: false, hint: 'The line rises and fades in' },
  { anim: 'drop', label: 'Drop', perChar: false, hint: 'The line drops into place' },
  { anim: 'slideLeft', label: 'Slide left', perChar: false, hint: 'Enters from the right' },
  { anim: 'slideRight', label: 'Slide right', perChar: false, hint: 'Enters from the left' },
  { anim: 'fade', label: 'Fade', perChar: false, hint: 'Fades in and out' },
  { anim: 'none', label: 'None', perChar: false, hint: 'No title animation' },
]
