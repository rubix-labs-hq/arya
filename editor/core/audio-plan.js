import { clipEnd, compView, duration, gainAt, hasAudio, valueAt } from './project.js'
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
      let f = Math.max(from, A + B * c.start)
      const end = Math.min(to, A + B * clipEnd(c))
      if (!(end > f)) continue
      const item = { id: c.id, from: f, to: end, chain: [] }
      const speed = c.speed > 0 ? c.speed : 1
      if (c.kind === 'comp' && p.comps?.[c.comp]) {
        item.kind = 'comp'
        item.buses = scope(compView(p, c.comp), A + B * (c.start - (c.in ?? 0) / speed), B / speed, f, end, depth + 1)
        if (!item.buses.length) continue
      } else {
        if (!hasAudio(p, c)) continue
        const angle = c.kind === 'multicam' ? c.angles?.[c.audioAngle ?? 0] : null
        item.src = angle?.src ?? c.src
        if (!item.src) continue
        const sourceIn = (c.in ?? 0) + (angle?.offset ?? 0)
        if (sourceIn < 0) f = Math.max(f, A + B * (c.start - sourceIn / speed))
        if (!(end > f)) continue
        item.from = f
        item.kind = 'leaf'
        item.sourceIn = sourceIn + ((f - A) / B - c.start) * speed
        item.speed = speed / B
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
