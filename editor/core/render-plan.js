// Native frame instructions resolved with the shared project timing and expressions.
import { clipEnd, compDuration, compView, nodeOrder, opacityAt, sourceTime, valueAt } from './project.js'
import { gradeUniforms } from './render-grade.js'
import { captionTitle } from './caption-render.js'

const IN = 0.6
const OUT = 0.45
const MAX_DEPTH = 8

/** Title animation state at clip-local time. */
export function titleAnim(c, local) {
  const anim = c.title?.anim ?? 'none'
  const s = { dx: 0, dy: 0, scale: 1, opacity: 1, blur: 0, chars: undefined, tracking: 0 }
  if (anim === 'none') return s
  const inP = Math.max(0, Math.min(1, local / IN))
  const outP = Math.max(0, Math.min(1, (c.dur - local) / OUT))
  const e = x => 1 - (1 - x) ** 3
  const ei = e(inP)
  const eo = e(outP)
  switch (anim) {
    case 'fade':
      s.opacity = ei * eo
      break
    case 'rise':
      s.dy = (1 - ei) * 60 + (1 - eo) * -30
      s.opacity = ei * eo
      break
    case 'drop':
      s.dy = (1 - ei) * -60
      s.opacity = ei * eo
      break
    case 'pop': {
      const back = x => 1 + 2.7 * (x - 1) ** 3 + 1.7 * (x - 1) ** 2
      s.scale = Math.max(0.01, back(inP)) * (0.85 + 0.15 * eo)
      s.opacity = Math.min(1, inP * 3) * eo
      break
    }
    case 'slideLeft':
      s.dx = (1 - ei) * 300 + (1 - eo) * -300
      s.opacity = ei * eo
      break
    case 'slideRight':
      s.dx = (1 - ei) * -300 + (1 - eo) * 300
      s.opacity = ei * eo
      break
    case 'typewriter': {
      const len = String(c.title?.text ?? '').length
      const typeDur = Math.min(c.dur * 0.6, len * 0.05)
      s.chars = Math.floor(Math.min(1, local / Math.max(0.01, typeDur)) * len)
      s.opacity = eo
      break
    }
    case 'blurIn':
      s.blur = (1 - ei) * 24
      s.opacity = ei * eo
      break
    case 'tracking':
      s.tracking = (1 - ei) * 40
      s.opacity = ei * eo
      break
  }

  return s
}

/** For each visible video track bottom→top: { track, c } or a transition { track, a, b, type, p }. */
export function resolveTracks(p, t) {
  const out = []
  for (const track of p.tracks.filter(tr => tr.kind === 'video' && !tr.hidden)) {
    const clips = track.clips.filter(c => c.enabled !== false)
    let entry = null
    for (const b of clips) {
      const tr = b.transitionIn
      if (!tr) continue
      const from = b.start - tr.dur / 2
      const to = b.start + tr.dur / 2
      if (t >= from && t < to) {
        const a = clips.find(c => c !== b && Math.abs(clipEnd(c) - b.start) < 1.5 / p.fps)
        entry = { track, a, b, type: tr.type, p: (t - from) / tr.dur }
        break
      }
    }
    if (!entry) {
      const c = clips.find(x => x.start <= t + 1e-6 && t < clipEnd(x) - 1e-6)
      if (c) entry = { track, c }
    }
    if (entry) out.push(entry)
  }

  return out
}

/** Which multicam angle shows at multicam time mt. */
export function angleAt(c, mt) {
  let angle = c.cuts?.[0]?.angle ?? 0
  for (const cut of c.cuts ?? []) if (cut.t <= mt + 1e-6) angle = cut.angle

  return Math.max(0, Math.min((c.angles?.length ?? 1) - 1, angle))
}

function compTime(root, c, t) {
  const len = compDuration(root.comps[c.comp])
  const local = t - c.start
  const ct = (c.in ?? 0) + local * (c.speed ?? 1)

  return Math.max(0, Math.min(len - 1e-4, c.reverse ? len - ct : ct))
}

function effectsOf(p, c, local) {
  const fx = {}
  for (const e of c.effects ?? []) {
    if (e.enabled === false) continue
    const q = e.params ?? {}
    switch (e.type) {
      case 'blur': fx.blur = (fx.blur ?? 0) + (q.radius ?? 8); break
      case 'sharpen': fx.sharpen = q.amount ?? 0.5; break
      case 'vignette': fx.vignette = q.amount ?? 0.5; fx.vignetteSoft = q.softness ?? 0.6; break
      case 'grain': fx.grain = q.amount ?? 0.08; break
      case 'pixelate': fx.pixelate = q.size ?? 24; break
      case 'glow': fx.glow = q.amount ?? 0.5; fx.glowThreshold = q.threshold ?? 0.7; fx.glowRadius = q.radius ?? 12; break
      case 'mirror': fx.mirror = q.axis ?? 'x'; break
      case 'invert': fx.invert = true; break
      case 'posterize': fx.posterize = q.levels ?? 6; break
      case 'chromaticAberration': fx.aberration = q.amount ?? 4; break
      case 'letterbox': fx.letterbox = q.ratio ?? 2.39; break
    }
  }
  const animBlur = valueAt(p, c, 'blur', local)
  if (animBlur > 0) fx.blur = (fx.blur ?? 0) + animBlur
  if (c.grade?.vignette) fx.vignette = Math.max(fx.vignette ?? 0, c.grade.vignette)
  if (c.grade?.blur) fx.blur = (fx.blur ?? 0) + c.grade.blur

  return fx
}

// ---------------------------------------------------------------- transforms

const mul = (A, B) => [
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
]

function inverse(M) {
  const det = M[0] * M[3] - M[1] * M[2] || 1e-9

  return [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det, (M[2] * M[5] - M[3] * M[4]) / det, (M[1] * M[4] - M[0] * M[5]) / det]
}

/** Position · rotation · scale · −anchor, mapping layer pixels (origin at the layer center) to parent space. */
function localMatrix(v) {
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

function transformValues(p, c, local, extra = { dx: 0, dy: 0, scale: 1 }) {
  return {
    x: valueAt(p, c, 'x', local) + (extra.dx ?? 0),
    y: valueAt(p, c, 'y', local) + (extra.dy ?? 0),
    scale: valueAt(p, c, 'scale', local) * (extra.scale ?? 1),
    scaleX: valueAt(p, c, 'scaleX', local),
    scaleY: valueAt(p, c, 'scaleY', local),
    rotation: valueAt(p, c, 'rotation', local),
    anchorX: valueAt(p, c, 'anchorX', local),
    anchorY: valueAt(p, c, 'anchorY', local),
  }
}

/** The world matrix of a clip at timeline time t, parents applied (relative to their pose when parented). */
export function worldMatrix(p, c, t, extra, depth = 0) {
  let M = localMatrix(transformValues(p, c, t - c.start, extra))
  if (c.parent && depth < 32) {
    const parent = p.tracks.flatMap(tr => tr.clips).find(x => x.id === c.parent)
    if (parent) {
      const now = worldMatrix(p, parent, Math.max(parent.start, Math.min(clipEnd(parent), t)), undefined, depth + 1)
      const ref = c.parentRef ? localMatrix(c.parentRef) : localMatrix(transformValues(p, parent, 0))
      M = mul(mul(now, inverse(ref)), M)
    }
  }

  return M
}

function resolved(p, c, value, prefix, local) {
  const out = structuredClone(value ?? {})
  for (const prop of new Set([...Object.keys(c.anim ?? {}), ...Object.keys(c.expr ?? {})])) {
    if (!prop.startsWith(prefix)) continue
    const path = prop.slice(prefix.length).split('.')
    if (path.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) continue
    let obj = out
    for (const key of path.slice(0, -1)) obj = obj[key] ??= {}
    obj[path[path.length - 1]] = valueAt(p, c, prop, local)
  }
  return out
}

/** A JSON draw plan for the native GPU renderer. Media paths remain project-relative. */
export function framePlan(root, t, comp = null, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('composition nesting exceeds eight levels')
  const view = comp ? compView(root, comp) : root
  const clipPlan = c => {
    const local = t - c.start
    const extra = c.kind === 'title' ? titleAnim(c, local) : { dx: 0, dy: 0, scale: 1, opacity: 1, blur: 0 }
    const matrix = worldMatrix(view, c, t, extra)
    const pose = transformValues(view, c, local)
    const parentMatrix = mul(matrix, inverse(localMatrix(transformValues(view, c, local, extra))))
    let src = c.src
    let st = sourceTime(view, c, t)
    if (c.kind === 'multicam') {
      const mt = (c.in ?? 0) + local * (c.speed ?? 1)
      const angle = c.angles[angleAt(c, mt)]
      src = angle.src
      st = Math.max(0, Math.min((root.assets[src]?.duration ?? Infinity) - 0.001, mt + (angle.offset ?? 0)))
    }
    const fx = effectsOf(view, c, local)
    if (extra.blur) fx.blur = (fx.blur ?? 0) + extra.blur
    const nodes = c.nodes ? {
      list: nodeOrder(c.nodes).map(n => {
        const native = resolved(view, c, { ...n, ...(n.type === 'primary' ? { grade: c.grade ?? {} } : {}) }, `node.${n.id}.`, local)
        return { ...native, grade: gradeUniforms(n.type === 'lut' ? { lut: native.lut, lutMix: native.mix ?? 1, lutSpace: native.lutSpace } : native.grade) }
      }),
      links: c.nodes.links,
    } : null
    const masks = (c.masks ?? []).map(m => {
      const mask = resolved(view, c, m, `mask.${m.id}.`, local)
      for (const key of ['x', 'y', 'w', 'h', 'radius', 'feather', 'expansion', 'opacity']) {
        const prop = `mask.${m.id}.${key}`
        if (c.anim?.[prop] || c.expr?.[prop]) mask[key] = valueAt(view, c, prop, local)
      }
      return mask
    })
    return {
      id: c.id, kind: c.kind, src, srcTime: st, asset: src ? root.assets[src] : null, ...(c.fit ? { fit: c.fit } : {}),
      matrix, editTransform: { ...pose, parentMatrix }, opacity: opacityAt(view, c, local) * extra.opacity,
      crop: c.crop, grade: gradeUniforms(c.grade), key: c.key, fx, nodes, masks,
      blend: c.blend ?? 'normal', matte: c.matte,
      color: c.color, title: c.title ? resolved(view, c, c.title, 'title.', local) : null, titleState: extra,
      shape: c.shape ? resolved(view, c, c.shape, 'shape.', local) : null,
      composition: c.kind === 'comp' && root.comps?.[c.comp] ? framePlan(root, compTime(root, c, t), c.comp, depth + 1) : null,
    }
  }
  const layers = resolveTracks(view, t).map(e => e.c ? { clip: clipPlan(e.c) } : { a: e.a ? clipPlan(e.a) : null, b: e.b ? clipPlan(e.b) : null, transition: e.type, progress: e.p })
  const captions = view.tracks.filter(tr => tr.kind === 'caption' && tr.burnIn && !tr.hidden).flatMap(tr => tr.clips.filter(c => c.enabled !== false && c.start <= t && t < clipEnd(c)).map(c => ({ text: c.text, style: { ...tr.style, ...(c.style ?? {}) }, title: captionTitle(c, tr.style, t - c.start, view) })))
  return { width: view.width, height: view.height, fps: view.fps, background: view.background, time: t, layers, captions }
}
