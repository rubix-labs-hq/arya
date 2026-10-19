// Turns a timeline time into draw calls: resolves what each video track shows (a clip,
// or a transition between two), renders nested compositions recursively, runs each
// clip's node graph, applies transform (anchor, parenting), masks, track mattes and
// effects, and blends layer by layer. See docs/format.md section 1.8 for the order.

import { clipEnd, compDuration, compView, findClip, nodeOrder, opacityAt, sourceTime, valueAt } from '/core/project.js'
import { hexToRgb } from './compositor.js'
import { mediaUrl } from './media.js'
import { maskCanvas, resolvedShape, shapeCanvas } from './shapes.js'
import { captionTitle } from '/core/caption-render.js'

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

/** The video element key for a clip at a nesting path (one element per clip instance). */
export const mediaKey = (c, path, suffix = '') => `${path ? `${path}/` : ''}${c.id}${suffix}`

/** Which multicam angle shows at multicam time mt. */
export function angleAt(c, mt) {
  let angle = c.cuts?.[0]?.angle ?? 0
  for (const cut of c.cuts ?? []) if (cut.t <= mt + 1e-6) angle = cut.angle

  return Math.max(0, Math.min((c.angles?.length ?? 1) - 1, angle))
}

/**
 * Every video frame the picture at time t needs, across nested compositions:
 * [{ key, url, srcTime, fps, clip }]. The player seeks these before an exact draw.
 */
export function neededVideos(root, t, view = root, path = '', depth = 0, out = []) {
  if (depth > MAX_DEPTH) return out
  for (const e of resolveTracks(view, t)) {
    for (const c of [e.c, e.a, e.b]) {
      if (!c) continue
      if (c.kind === 'video') out.push({ key: mediaKey(c, path), url: mediaUrl(root, c.src), srcTime: sourceTime(view, c, t), fps: root.assets[c.src]?.fps || view.fps, clip: c })
      else if (c.kind === 'multicam') {
        const mt = (c.in ?? 0) + (t - c.start) * (c.speed ?? 1)
        const a = angleAt(c, mt)
        const angle = c.angles[a]
        const len = root.assets[angle.src]?.duration ?? Infinity
        out.push({ key: mediaKey(c, path, `#a${a}`), url: mediaUrl(root, angle.src), srcTime: Math.max(0, Math.min(len - 0.001, mt + (angle.offset ?? 0))), fps: root.assets[angle.src]?.fps || view.fps, clip: c })
      } else if (c.kind === 'comp' && root.comps?.[c.comp]) {
        neededVideos(root, compTime(root, c, t, view), compView(root, c.comp), mediaKey(c, path), depth + 1, out)
      }
    }
  }

  return out
}

/** Visible still URLs, including nested compositions, transition ends and matte tracks. */
export function neededImages(root, t, view = root, depth = 0, out = new Set()) {
  if (depth > MAX_DEPTH) return out
  for (const e of resolveTracks(view, t)) {
    for (const c of [e.c, e.a, e.b]) {
      if (!c) continue
      if (c.kind === 'image') out.add(mediaUrl(root, c.src))
      else if (c.kind === 'comp' && root.comps?.[c.comp]) {
        neededImages(root, compTime(root, c, t, view), compView(root, c.comp), depth + 1, out)
      }
    }
  }
  return out
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

function resolvedNative(p, c, value, prefix, local) {
  const out = structuredClone(value ?? {})
  for (const prop of new Set([...Object.keys(c.anim ?? {}), ...Object.keys(c.expr ?? {})])) {
    if (!prop.startsWith(prefix)) continue
    const path = prop.slice(prefix.length).split('.')
    if (path.some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) continue
    let target = out
    for (const part of path.slice(0, -1)) target = target[part] ??= {}
    target[path.at(-1)] = valueAt(p, c, prop, local)
  }
  return out
}

// ---------------------------------------------------------------- sources

/** The clip's pixels at time t: { tex, w, h, flipY } or { solid }, plus its layer size and title state. */
function sourceFor(ctx, view, c, t, path, depth) {
  const { comp, media, root, rs } = ctx
  const local = t - c.start
  if (c.kind === 'color') return { source: { solid: hexToRgb(c.color ?? '#202020') }, w: view.width, h: view.height }
  if (c.kind === 'title') {
    const st = titleAnim(c, local)
    const scale = (view.height / 1080) * rs
    const canvas = media.title(mediaKey(c, path), resolvedNative(view, c, c.title ?? { text: '' }, 'title.', local), scale, st)
    const entry = comp.sourceTexture(`title:${mediaKey(c, path)}`, canvas)
    if (!entry) return null

    return { source: { tex: entry.tex, w: canvas.width, h: canvas.height }, w: canvas.width / rs, h: canvas.height / rs, extra: st }
  }
  if (c.kind === 'shape') {
    const shape = resolvedShape(root, c, local)
    const drawn = shapeCanvas(mediaKey(c, path), shape, rs)
    const entry = comp.sourceTexture(`shape:${mediaKey(c, path)}`, drawn.canvas)
    if (!entry) return null

    return { source: { tex: entry.tex, w: drawn.canvas.width, h: drawn.canvas.height }, w: drawn.w, h: drawn.h }
  }
  if (c.kind === 'image') {
    const im = media.image(mediaUrl(root, c.src))
    if (!im.ready) return null
    const entry = comp.sourceTexture(`img:${c.src}`, im.el, 1)
    const a = root.assets[c.src] ?? {}
    const iw = im.el.naturalWidth || a.width || view.width
    const ih = im.el.naturalHeight || a.height || view.height
    const fit = (c.fit === 'cover' ? Math.max : Math.min)(view.width / iw, view.height / ih)

    return { source: { tex: entry.tex, w: iw, h: ih }, w: iw * fit, h: ih * fit }
  }
  if (c.kind === 'video' || c.kind === 'multicam') {
    let key = mediaKey(c, path)
    let src = c.src
    if (c.kind === 'multicam') {
      const a = angleAt(c, (c.in ?? 0) + local * (c.speed ?? 1))
      key = mediaKey(c, path, `#a${a}`)
      src = c.angles[a].src
    }
    const decoded = media.useDecoders ? media.frames.get(key) : null
    let entry
    let iw
    let ih
    if (decoded) {
      entry = comp.sourceTexture(`vid:${key}`, decoded.frame, decoded.stamp)
      iw = decoded.frame.displayWidth
      ih = decoded.frame.displayHeight
    } else {
      const v = media.video(key, mediaUrl(root, src))
      if (!v.ready || v.failed || v.el.readyState < 2) return null
      entry = comp.sourceTexture(`vid:${key}`, v.el)
      iw = v.el.videoWidth || view.width
      ih = v.el.videoHeight || view.height
    }
    if (!entry) return null
    const fit = (c.fit === 'cover' ? Math.max : Math.min)(view.width / iw, view.height / ih)

    return { source: { tex: entry.tex, w: iw, h: ih }, w: iw * fit, h: ih * fit }
  }
  if (c.kind === 'comp') {
    const k = root.comps?.[c.comp]
    if (!k || depth >= MAX_DEPTH) return null
    const cview = compView(root, c.comp)
    const target = drawComposition(ctx, cview, compTime(root, c, t), depth + 1, mediaKey(c, path))
    const fit = (c.fit === 'cover' ? Math.max : Math.min)(view.width / cview.width, view.height / cview.height)

    return { source: { tex: target.tex, w: target.w, h: target.h, flipY: true }, w: cview.width * fit, h: cview.height * fit }
  }

  return null
}

// ---------------------------------------------------------------- node graphs

/** Runs a clip's node graph over its source; returns the result as a source (or null to skip). */
function runNodes(ctx, view, c, src, local, depth, key) {
  const { comp, rs } = ctx
  const graph = c.nodes
  let order
  try {
    order = nodeOrder(graph)
  } catch {
    return null
  }
  const sw = Math.min(2048, Math.max(2, Math.round((src.source.w ?? src.w * rs) || 2)))
  const sh = Math.min(2048, Math.max(2, Math.round((src.source.h ?? src.h * rs) || 2)))
  const plane = { width: sw, height: sh }
  const full = { x: sw / 2, y: sh / 2, w: sw, h: sh, rotation: 0, opacity: 1, fx: {} }
  const results = new Map()
  const inputsOf = id => graph.links.filter(l => l.to === id).sort((a, b) => a.input - b.input).map(l => results.get(l.from)).filter(Boolean)
  const asSource = target => ({ tex: target.tex, w: target.w, h: target.h, flipY: true })
  for (const stored of order) {
    const n = resolvedNative(view, c, { ...stored, ...(stored.type === 'primary' ? { grade: c.grade ?? {} } : {}) }, `node.${stored.id}.`, local)
    const target = comp.pooled(`node${depth}:${key}:${n.id}`, sw, sh)
    const ins = inputsOf(n.id)
    comp.clear(target)
    if (n.enabled === false && n.type !== 'source') {
      if (ins[0]) comp.copyInto(ins[0], target)
      results.set(n.id, target)
      continue
    }
    switch (n.type) {
      case 'source':
        comp.drawLayer(target, src.source, full, plane, 0)
        break
      case 'primary':
        if (ins[0]) comp.drawLayer(target, asSource(ins[0]), { ...full, grade: n.grade }, plane, 0)
        break
      case 'corrector': {
        let window = n.window
        if (window) {
          const prefix = `node.${n.id}.window.`
          const props = new Set([...Object.keys(c.anim ?? {}), ...Object.keys(c.expr ?? {})].filter(prop => prop.startsWith(prefix)))
          if (props.size) {
            window = structuredClone(window)
            for (const prop of props) window[prop.slice(prefix.length)] = valueAt(view, c, prop, local)
          }
        }
        if (ins[0]) comp.drawLayer(target, asSource(ins[0]), { ...full, grade: n.grade, qualifier: n.qualifier, window }, plane, 0)
        break
      }
      case 'key':
        if (ins[0]) comp.drawLayer(target, asSource(ins[0]), { ...full, key: { color: n.color, similarity: n.similarity, smoothness: n.smoothness, spill: n.spill } }, plane, 0)
        break
      case 'lut':
        if (ins[0]) comp.drawLayer(target, asSource(ins[0]), { ...full, grade: { lut: n.lut, lutMix: n.mix ?? 1, lutSpace: n.lutSpace ?? 'srgb' } }, plane, 0)
        break
      case 'blur':
      case 'sharpen':
      case 'glow':
        if (ins[0]) {
          comp.copyInto(ins[0], target)
          comp.postEffects(target, n.type === 'blur' ? { blur: n.radius ?? 8 } : n.type === 'sharpen' ? { sharpen: n.amount ?? 0.5 } : { glow: n.amount ?? 0.5, glowThreshold: n.threshold ?? 0.7, glowRadius: n.radius ?? 12 }, sw / Math.max(1, src.w))
        }
        break
      case 'parallel': {
        // Average the inputs (optionally weighted) with a running mix.
        const tmp = comp.pooled(`nodeTmp${depth}`, sw, sh)
        let total = 0
        ins.forEach((inp, i) => {
          const w = n.weights?.[i] ?? 1
          total += w
          comp.blendOnto(target, tmp, inp, 'normal', i === 0 ? 1 : w / total)
          comp.copyInto(tmp, target)
        })
        break
      }
      case 'layerMixer': {
        const tmp = comp.pooled(`nodeTmp${depth}`, sw, sh)
        ins.forEach((inp, i) => {
          comp.blendOnto(target, tmp, inp, n.blends?.[i] ?? 'normal', 1)
          comp.copyInto(tmp, target)
        })
        break
      }
      case 'output':
        if (ins[0]) comp.copyInto(ins[0], target)
        break
    }
    results.set(n.id, target)
  }
  const out = results.get(order[order.length - 1].id)

  return out ? { tex: out.tex, w: out.w, h: out.h, flipY: true } : null
}

// ---------------------------------------------------------------- layers

/** Draws one clip into target (cleared first); returns its blend mode, or null when it drew nothing. */
function drawClip(ctx, view, target, c, t, path, depth, matte) {
  const { comp, root, rs } = ctx
  comp.clear(target)
  if (c.kind === 'null' || c.kind === 'audio' || c.kind === 'caption') return null
  const src = sourceFor(ctx, view, c, t, path, depth)
  if (!src) return null
  const local = t - c.start
  const extra = src.extra ?? { dx: 0, dy: 0, scale: 1, opacity: 1, blur: 0 }
  const key = mediaKey(c, path)
  let source = src.source
  let grade = c.grade
  let chroma = c.key
  if (c.nodes) {
    const graded = runNodes(ctx, view, c, src, local, depth, key)
    if (graded) {
      source = graded
      grade = null
      chroma = null
    }
  }
  const fx = effectsOf(view, c, local)
  if (extra.blur) fx.blur = (fx.blur ?? 0) + extra.blur
  let mask = null
  const mc = maskCanvas(view, c, key, local, src.w, src.h, rs)
  if (mc) mask = comp.sourceTexture(`mask:${key}`, mc)
  comp.drawLayer(
    target,
    source,
    {
      matrix: worldMatrix(view, c, t, extra),
      w: src.w,
      h: src.h,
      opacity: opacityAt(view, c, local) * (extra.opacity ?? 1),
      crop: c.crop,
      grade,
      key: chroma,
      fx,
      mask,
      matte,
    },
    view,
    t,
  )
  if (fx.blur > 0.01 || fx.glow > 0 || fx.sharpen > 0) comp.postEffects(target, fx, rs)

  return c.blend ?? 'normal'
}

/** Renders a composition (or the main timeline) at time t into a pooled target and returns it. */
export function drawComposition(ctx, view, t, depth = 0, path = '') {
  const { comp, rs } = ctx
  const W = Math.max(2, Math.round(view.width * rs))
  const H = Math.max(2, Math.round(view.height * rs))
  const tag = `${depth}:${path}`
  let acc = comp.pooled(`accA${tag}`, W, H)
  let other = comp.pooled(`accB${tag}`, W, H)
  const layerA = comp.pooled(`layerA${tag}`, W, H)
  const layerB = comp.pooled(`layerB${tag}`, W, H)
  const trans = comp.pooled(`trans${tag}`, W, H)
  const matteT = comp.pooled(`matte${tag}`, W, H)
  const bg = depth > 0 && view.background && view.background !== 'transparent' ? hexToRgb(view.background) : null
  comp.clear(acc, bg ? [bg[0], bg[1], bg[2], 1] : [0, 0, 0, 0])
  const swap = () => ([acc, other] = [other, acc])
  const entries = resolveTracks(view, t)
  const usedAsMatte = new Set()
  entries.forEach((entry, i) => {
    const c = entry.c
    if (!c?.matte) return
    const source = c.matte.source ? entries.find(e => e.c?.id === c.matte.source) : entries[i + 1]
    if (source?.c) usedAsMatte.add(source.c.id)
  })

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.c && usedAsMatte.has(entry.c.id)) continue
    if (entry.c?.kind === 'adjustment') {
      const c = entry.c
      const local = t - c.start
      const fx = effectsOf(view, c, local)
      comp.clear(layerA)
      comp.drawLayer(layerA, { tex: acc.tex, w: acc.w, h: acc.h, flipY: true }, { x: view.width / 2, y: view.height / 2, w: view.width, h: view.height, rotation: 0, opacity: 1, grade: c.grade, key: null, fx }, view, t)
      if (fx.blur > 0.01 || fx.glow > 0 || fx.sharpen > 0) comp.postEffects(layerA, fx, rs)
      comp.blendOnto(acc, other, layerA, 'normal', opacityAt(view, c, local))
      swap()
      continue
    }
    if (entry.c) {
      let matte = null
      if (entry.c.matte) {
        const src = entry.c.matte.source ? entries.find(e => e.c?.id === entry.c.matte.source) : entries[i + 1]
        if (src?.c) {
          drawClip(ctx, view, matteT, src.c, t, path, depth, null)
          matte = { tex: matteT.tex, mode: entry.c.matte.mode }
        } else matte = { tex: matteT.tex, mode: entry.c.matte.mode, empty: comp.clear(matteT) }
      }
      const blend = drawClip(ctx, view, layerA, entry.c, t, path, depth, matte)
      if (!blend) continue
      comp.blendOnto(acc, other, layerA, blend)
      swap()
      continue
    }
    // Transition between a (may be absent: a gap) and b.
    if (entry.a) drawClip(ctx, view, layerA, entry.a, t, path, depth, null)
    else comp.clear(layerA)
    const blend = drawClip(ctx, view, layerB, entry.b, t, path, depth, null)
    comp.clear(trans)
    comp.transition(layerA, layerB, trans, entry.type, entry.p)
    comp.blendOnto(acc, other, trans, blend ?? 'normal')
    swap()
  }

  // Burned-in captions draw over the picture.
  for (const track of view.tracks) {
    if (track.kind !== 'caption' || !track.burnIn || track.hidden) continue
    const c = track.clips.find(x => x.enabled !== false && x.start <= t + 1e-6 && t < clipEnd(x) - 1e-6)
    if (!c) continue
    const st = { ...(track.style ?? {}), ...(c.style ?? {}) }
    const title = captionTitle(c, st, t - c.start, view)
    const canvas = ctx.media.title(`cap:${mediaKey(c, path)}`, title, (view.height / 1080) * rs, {})
    const entry = comp.sourceTexture(`title:cap:${mediaKey(c, path)}`, canvas)
    if (!entry) continue
    comp.clear(layerA)
    const fit = title.box?.autoHeight ? Math.min(1, view.width * 0.9 / (canvas.width / rs), view.height * 0.9 / (canvas.height / rs)) : 1
    const w = canvas.width / rs * fit, h = canvas.height / rs * fit
    const y = title.box?.autoHeight ? Math.max(h / 2 + view.height * 0.025, Math.min((st.y ?? 0.88) * view.height, view.height * 0.975 - h / 2)) : (st.y ?? 0.88) * view.height
    comp.drawLayer(layerA, { tex: entry.tex, w: canvas.width, h: canvas.height }, { x: view.width / 2, y, w, h, rotation: 0, opacity: 1, fx: {} }, view, t)
    comp.blendOnto(acc, other, layerA, 'normal')
    swap()
  }

  return acc
}

/**
 * Draws timeline time t. Assumes media is already where it should be (the player
 * seeks before exact draws; during playback the videos run).
 */
export function drawFrame(comp, media, p, t) {
  const rs = comp.size[0] / p.width
  const acc = drawComposition({ comp, media, root: p, rs }, p, t, 0, '')
  comp.present(acc, p.compId || !/^#/.test(p.background ?? '') ? '#000000' : p.background)
}

export { findClip }
