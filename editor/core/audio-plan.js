import { clipEnd, compDuration, compView, duration, gainAt, hasAudio, valueAt } from './project.js'
import { activeFx, eqBands, fxParams, legacyEqBands, masterChain } from './audio-fx.js'

const STEP = 1 / 50

function curve(from, to, read, animated) {
  if (!animated) return { from, step: STEP, values: [read(from)] }
  const values = []
  for (let t = from; t < to; t += STEP) values.push(read(t))
  return { from, step: STEP, values }
}

function effects(list, c, view, A, B, from, to) {
  return activeFx(list).map(({ fx, index }) => {
    const params = fx.type === 'eq' ? { bands: eqBands(fx) } : fxParams(fx)
    const curves = {}
    if (c) for (const key of new Set([...Object.keys(c.anim ?? {}), ...Object.keys(c.expr ?? {})])) {
      const prefix = `fx.${index}.params.`
      if (key.startsWith(prefix)) curves[key.slice(prefix.length)] = curve(from, to, t => valueAt(view, c, key, (t - A) / B - c.start), true)
    }
    return { type: fx.type, params, curves }
  })
}

function scope(p, A, B, from, to, depth) {
  if (depth > 16) return []
  const solo = p.tracks.some(t => t.kind === 'audio' && t.solo)
  const buses = []
  for (const track of p.tracks) {
    if (track.muted || (solo && track.kind === 'audio' && !track.solo)) continue
    const items = []
    for (const c of track.clips) {
      if (c.enabled === false || c.mute) continue
      // B is negative inside a reversed composition, so the clip's edges can arrive in either order.
      let f = Math.max(from, Math.min(A + B * c.start, A + B * clipEnd(c)))
      let end = Math.min(to, Math.max(A + B * c.start, A + B * clipEnd(c)))
      if (!(end > f)) continue
      const item = { id: c.id, from: f, to: end, chain: [] }
      const speed = c.speed > 0 ? c.speed : 1
      if (c.kind === 'comp' && p.comps?.[c.comp]) {
        item.kind = 'comp'
        // Comp second tau = in + local * speed, mirrored to len - tau when reversed (compTime in render-plan.js).
        const len = compDuration(p.comps[c.comp])
        const inner = c.reverse
          ? [A + B * (c.start + (len - (c.in ?? 0)) / speed), -B / speed]
          : [A + B * (c.start - (c.in ?? 0) / speed), B / speed]
        item.buses = scope(compView(p, c.comp), ...inner, f, end, depth + 1)
        if (!item.buses.length) continue
      } else {
        if (!hasAudio(p, c)) continue
        const angle = c.kind === 'multicam' ? c.angles?.[c.audioAngle ?? 0] : null
        item.src = angle?.src ?? c.src
        if (!item.src) continue
        const sourceIn = (c.in ?? 0) + (angle?.offset ?? 0)
        // A reversed clip plays source second in + (dur - local) * speed, as the browser does. Inside a
        // reversed composition (B < 0) the direction flips again. A backwards leaf starts at its latest
        // source second and reads backwards at `speed`. Nothing sounds before source second 0.
        const backwards = Boolean(c.reverse) !== (B < 0)
        if (sourceIn < 0) {
          const zero = A + B * (c.start + (c.reverse ? c.dur + sourceIn / speed : -sourceIn / speed))
          if (backwards) end = Math.min(end, zero)
          else f = Math.max(f, zero)
        }
        if (!(end > f)) continue
        item.from = f
        item.to = end
        item.kind = 'leaf'
        const local = (f - A) / B - c.start
        item.sourceIn = sourceIn + (c.reverse ? c.dur - local : local) * speed
        item.speed = speed / Math.abs(B)
        if (backwards) item.reverse = true
      }
      const legacy = legacyEqBands(c.eq)
      if (legacy.length) item.chain.push({ type: 'eq', params: { bands: legacy }, curves: {} })
      item.chain.push(...effects(c.fx, c, p, A, B, f, end))
      const local = t => (t - A) / B - c.start
      item.gain = curve(f, end, t => gainAt(p, c, local(t)), Boolean(c.fadeIn || c.fadeOut || c.anim?.volume || c.expr?.volume))
      item.pan = curve(f, end, t => Math.max(-1, Math.min(1, valueAt(p, c, 'pan', local(t)) ?? 0)), Boolean(c.anim?.pan || c.expr?.pan))
      items.push(item)
    }
    if (items.length) buses.push({ id: track.id, chain: effects(track.fx), gain: 10 ** ((track.volume ?? 0) / 20), pan: track.pan ?? 0, items })
  }
  return buses
}

/** A serializable mix graph. Automation uses the same 50 Hz ramps as Web Audio playback. */
export function audioPlan(p, from = 0, to = duration(p)) {
  if (!(Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from)) throw new Error('Audio mix needs a non-empty range')
  const master = masterChain(p.master)
  return {
    from, to, rate: 48000,
    buses: scope(p, 0, 1, from, to, 0),
    master: { chain: effects(master.fx), gain: 10 ** (master.volume / 20), limiter: master.limiter ? { type: 'limiter', params: fxParams(master.limiter), curves: {} } : null },
  }
}
