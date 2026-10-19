// Reel project model, shared by the server (Node) and the editor (browser).
// A project is plain JSON; every edit is an op applied by applyOps, all or nothing.

import { check as checkExpr, evaluate as evalExpr } from './expr.js'
import { captionWordRanges } from './caption-render.js'
import { applyLibraryOp, describeLibraryItem } from './library.js'
import { pasteClips } from './clipboard.js'

export const FORMAT_VERSION = 3

export const ANIM_PROPS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'anchorX', 'anchorY', 'volume', 'pan', 'blur']

export const SHAPE_TYPES = ['rect', 'ellipse', 'polygon', 'star', 'line', 'path']

export const NODE_TYPES = ['source', 'primary', 'corrector', 'parallel', 'layerMixer', 'key', 'lut', 'blur', 'sharpen', 'glow', 'output']

export const MATTE_MODES = ['alpha', 'alphaInverted', 'luma', 'lumaInverted']

export const MASK_MODES = ['add', 'subtract', 'intersect']

export const BLEND_MODES = ['normal', 'add', 'screen', 'multiply', 'overlay', 'softLight', 'lighten', 'darken', 'difference', 'colorDodge']

export const TRANSITIONS = [
  'crossDissolve', 'dipBlack', 'dipWhite', 'wipeLeft', 'wipeRight', 'wipeUp', 'wipeDown',
  'slideLeft', 'slideRight', 'pushLeft', 'pushRight', 'zoomIn', 'iris', 'blurDissolve',
]

export const EFFECTS = {
  blur: { radius: 8 },
  sharpen: { amount: 0.5 },
  vignette: { amount: 0.5, softness: 0.6 },
  grain: { amount: 0.08, size: 1.2 },
  pixelate: { size: 24 },
  glow: { amount: 0.5, threshold: 0.7, radius: 12 },
  mirror: { axis: 'x' },
  invert: {},
  posterize: { levels: 6 },
  chromaticAberration: { amount: 4 },
  letterbox: { ratio: 2.39 },
}

export const TITLE_ANIMS = ['none', 'fade', 'rise', 'drop', 'pop', 'slideLeft', 'slideRight', 'typewriter', 'blurIn', 'tracking']

export const LOOKS = ['none', 'mono', 'warm', 'cool', 'punch', 'film', 'fade', 'teal-orange', 'bleach', 'noir']

export const MARKER_COLORS = ['#f5b942', '#ff5f57', '#3fb950', '#58a6ff', '#bc8cff', '#ff7b72', '#39c5cf']

export const round = (n, places = 4) => Math.round(n * 10 ** places) / 10 ** places

// ---------------------------------------------------------------- creation and migration

export function newProject(name = 'Untitled', options = {}) {
  return {
    version: 2,
    name,
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    fps: options.fps ?? 30,
    sampleRate: 48000,
    background: '#000000',
    tracks: [
      { id: 'V1', kind: 'video', name: 'Video 1', clips: [] },
      { id: 'V2', kind: 'video', name: 'Video 2', clips: [] },
      { id: 'V3', kind: 'video', name: 'Titles', clips: [] },
      { id: 'A1', kind: 'audio', name: 'Audio 1', volume: 0, pan: 0, clips: [] },
      { id: 'A2', kind: 'audio', name: 'Audio 2', volume: 0, pan: 0, clips: [] },
      { id: 'A3', kind: 'audio', name: 'Music', volume: 0, pan: 0, clips: [] },
    ],
    markers: [],
    assets: {},
    library: { version: 1, items: [] },
    range: null,
  }
}

/** Brings a v1 or v2 project (or a hand-written one) to the v3 shape, in place. */
export function migrate(p) {
  p.markers ??= []
  p.assets ??= {}
  p.tracks ??= []
  p.comps ??= {}
  p.library ??= { version: 1, items: [] }
  p.sampleRate ??= 48000
  p.background ??= '#000000'
  p.colorSpace ??= 'rec709'
  const tracks = [...p.tracks, ...Object.values(p.comps).flatMap(k => (k.tracks ??= []))]
  for (const track of tracks) {
    track.clips ??= []
    if (track.id === 'T1' && track.kind === 'video') track.name ??= 'Titles'
    for (const clip of track.clips) {
      if (clip.gain !== undefined && clip.volume === undefined) {
        clip.volume = clip.gain > 0 ? round(20 * Math.log10(clip.gain), 2) : -60
        delete clip.gain
      }
      if (clip.title && clip.title.shadow === true) clip.title.shadow = { color: '#000000aa', blur: 12, x: 0, y: 4 }
    }
  }
  p.version = FORMAT_VERSION

  return p
}

// ---------------------------------------------------------------- queries

export function duration(p) {
  if (p.compId && p.comps?.[p.compId]) return compDuration(p.comps[p.compId])
  let end = 0
  for (const track of p.tracks) for (const c of track.clips) end = Math.max(end, c.start + c.dur)

  return round(end, 4)
}

/** A composition's length: its set duration, else the end of its last clip. */
export function compDuration(comp) {
  if (comp?.duration) return comp.duration
  let end = 0
  for (const track of comp?.tracks ?? []) for (const c of track.clips) end = Math.max(end, c.start + c.dur)

  return round(end || 5, 4)
}

/** The project-shaped view of a composition: its own tracks, size and rate, the project's media. */
export function compView(p, compId) {
  if (!compId) return p
  const comp = p.comps?.[compId]
  if (!comp) throw new Error(`no composition ${compId}`)

  return { ...p, __rootMarkers: p.__rootMarkers ?? p.markers, markers: comp.markers ?? [], tracks: comp.tracks, width: comp.width ?? p.width, height: comp.height ?? p.height, fps: comp.fps ?? p.fps, background: comp.background ?? 'transparent', range: comp.range ?? null, compId }
}

export function timecode(t, fps = 30, withFrames = true) {
  const total = Math.max(0, Math.round(t * fps))
  const f = total % fps
  const s = Math.floor(total / fps)
  const pad = n => String(n).padStart(2, '0')
  const hms = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`

  return withFrames ? `${hms}:${pad(f)}` : hms
}

export const snapToFrame = (t, fps) => round(Math.round(t * fps) / fps, 5)

/** Finds a clip anywhere: the main timeline or any composition. `comp` is null on the main timeline. */
export function findClip(p, id) {
  for (const track of p.__rootTracks ?? p.tracks) {
    const clip = track.clips.find(c => c.id === id)
    if (clip) return { track, clip, comp: null }
  }
  for (const [compId, comp] of Object.entries(p.comps ?? {})) {
    for (const track of comp.tracks ?? []) {
      const clip = track.clips.find(c => c.id === id)
      if (clip) return { track, clip, comp: compId }
    }
  }

  return null
}

/** Clips of the current scope (p.tracks); pass `everywhere` to include every composition. */
export function allClips(p, everywhere = false) {
  const out = p.tracks.flatMap(track => track.clips.map(clip => ({ track, clip, comp: p.compId ?? null })))
  if (everywhere) for (const [compId, comp] of Object.entries(p.comps ?? {})) if (compId !== p.compId) for (const track of comp.tracks) for (const clip of track.clips) out.push({ track, clip, comp: compId })

  return out
}

/** Whether composition `inner` is, or contains (at any depth), composition `outer`. */
export function compContains(p, inner, outer, seen = new Set()) {
  if (inner === outer) return true
  if (seen.has(inner)) return false
  seen.add(inner)
  for (const track of p.comps?.[inner]?.tracks ?? []) for (const c of track.clips) if (c.kind === 'comp' && compContains(p, c.comp, outer, seen)) return true

  return false
}

export function trackOf(p, id) {
  const track = p.tracks.find(t => t.id === id)
  if (!track) throw new Error(`no track ${id} (tracks: ${p.tracks.map(t => t.id).join(', ')})`)

  return track
}

function visualCreationTrack(p, requested, top = false, span = null) {
  const tracks = top ? [...p.tracks].reverse() : p.tracks
  let track = requested == null ? tracks.find(t => t.kind === 'video' && !t.locked) : trackOf(p, requested)
  if (!track) throw new Error('Add an unlocked video track before creating a visual layer.')
  // A new layer without a named track goes on top, as in After Effects. When the top track is
  // already busy at that time, a new video track above it holds the layer, so it never hides
  // under (or hides) the layer that was there.
  if (requested == null && top && span && track.clips.some(c => c.start < span.start + span.dur - 1e-6 && clipEnd(c) > span.start + 1e-6)) {
    let n = 1
    while (p.tracks.some(t => t.id === `V${n}`)) n++
    track = { id: `V${n}`, kind: 'video', name: `Video ${n}`, clips: [] }
    p.tracks.splice(p.tracks.map(t => t.kind).lastIndexOf('video') + 1, 0, track)
  }
  if (track.kind !== 'video') throw new Error(`visual layers require a video track, not ${track.id}`)
  if (track.locked) throw new Error(`track ${track.id} is locked`)

  return track
}

export const clipEnd = c => c.start + c.dur

export function isVisual(c) {
  return c.kind !== 'audio' && c.kind !== 'caption' && c.kind !== 'null'
}

export function hasAudio(p, c) {
  if (c.kind === 'audio') return !c.mute
  if (c.kind === 'multicam') return !c.mute && Boolean(p.assets[c.angles?.[c.audioAngle ?? 0]?.src]?.hasAudio)
  if (c.kind === 'comp') return !c.mute && (p.comps?.[c.comp]?.tracks ?? []).some(t => t.kind === 'audio' && t.clips.length)
  if (c.kind !== 'video' || c.mute || c.audioDetached) return false

  return Boolean(c.src && p.assets[c.src]?.hasAudio)
}

/** Source seconds read at timeline time t (clamped to the source). */
export function sourceTime(p, c, t) {
  const speed = c.speed ?? 1
  const local = t - c.start
  const len = (c.src && p.assets[c.src]?.duration) || Infinity
  let s = c.reverse ? (c.in ?? 0) + (c.dur - local) * speed : (c.in ?? 0) + local * speed
  if (c.freeze !== undefined) s = c.freeze

  return Math.max(0, Math.min(len - 0.001, s))
}

// ---------------------------------------------------------------- keyframes and easing

function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = t => ((ax * t + bx) * t + cx) * t
  const sampleY = t => ((ay * t + by) * t + cy) * t
  const slopeX = t => (3 * ax * t + 2 * bx) * t + cx

  return x => {
    let t = x
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x
      const d = slopeX(t)
      if (Math.abs(err) < 1e-6 || Math.abs(d) < 1e-6) break
      t -= err / d
    }
    t = Math.max(0, Math.min(1, t))

    return sampleY(t)
  }
}

export const EASES = {
  linear: [0, 0, 1, 1],
  in: [0.42, 0, 1, 1],
  out: [0, 0, 0.58, 1],
  inOut: [0.42, 0, 0.58, 1],
  smooth: [0.25, 0.1, 0.25, 1],
  backOut: [0.34, 1.56, 0.64, 1],
  expoOut: [0.16, 1, 0.3, 1],
  expoIn: [0.7, 0, 0.84, 0],
}

const bezierCache = new Map()

export function ease(kind, x) {
  if (kind === 'hold') return 0
  const pts = Array.isArray(kind) ? kind : EASES[kind ?? 'linear'] ?? EASES.linear
  const key = pts.join(',')
  let fn = bezierCache.get(key)
  if (!fn) {
    fn = cubicBezier(pts[0], pts[1], pts[2], pts[3])
    bezierCache.set(key, fn)
  }

  return fn(x)
}

export function baseValue(p, c, prop) {
  switch (prop) {
    case 'x': return c.x ?? p.width / 2
    case 'y': return c.y ?? p.height / 2
    case 'scale': return c.scale ?? 1
    case 'scaleX': return c.scaleX ?? 1
    case 'scaleY': return c.scaleY ?? 1
    case 'rotation': return c.rotation ?? 0
    case 'opacity': return c.opacity ?? 1
    case 'volume': return c.volume ?? 0
    case 'pan': return c.pan ?? 0
    case 'blur': return c.blurAmount ?? 0
    case 'anchorX': return c.anchorX ?? 0
    case 'anchorY': return c.anchorY ?? 0
    default: {
      // Dotted paths reach nested values and masks or nodes identified by id.
      if (prop.includes('.')) {
        const parts = prop.split('.')
        let v = c
        let start = 0
        let fallback = 0
        if (parts[0] === 'mask' || parts[0] === 'node') {
          const list = parts[0] === 'mask' ? c.masks : c.nodes?.list
          v = list?.find(item => item.id === parts[1])
          start = 2
          if (parts[0] === 'node' && v?.window && parts[2] === 'window' && parts.length === 4) {
            fallback = { x: 0.5, y: 0.5, w: 0.5, h: 0.5, softness: 0.15, rotation: 0 }[parts[3]] ?? 0
          }
        }
        for (let i = start; i < parts.length && v != null; i++) v = v[parts[i]]

        return typeof v === 'number' ? v : fallback
      }

      return c[prop] ?? 0
    }
  }
}

export function sortedKeys(keys) {
  return [...(keys ?? [])].sort((a, b) => a[0] - b[0])
}

/** An animated property's value at clip-local seconds, keyframes first, then its expression. */
export function valueAt(p, c, prop, local) {
  const keyed = keyedValueAt(p, c, prop, local)
  const src = c.expr?.[prop]
  if (!src) return keyed
  try {
    return evalExpr(src, {
      time: local,
      value: keyed,
      fps: p.fps,
      index: 1,
      width: p.width,
      height: p.height,
      seed: hashId(c.id),
      keys: sortedKeys(c.anim?.[prop]),
      valueAtTime: t => keyedValueAt(p, c, prop, t),
      layer: name => layerValues(p, name, local + c.start),
    })
  } catch {
    return keyed
  }
}

function hashId(id) {
  let h = 0
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0

  return Math.abs(h % 10000)
}

/** Another layer's transform values at timeline time t, for expressions (`layer("Logo").x`). */
function layerValues(p, name, t) {
  const c = p.tracks.flatMap(tr => tr.clips).find(x => x.label === name || x.id === name || x.title?.text === name)
  if (!c) return {}
  const local = t - c.start
  const out = {}
  for (const prop of ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'anchorX', 'anchorY']) out[prop] = keyedValueAt(p, c, prop, local)

  return out
}

function keyedValueAt(p, c, prop, local) {
  const keys = sortedKeys(c.anim?.[prop])
  if (keys.length === 0) return baseValue(p, c, prop)
  if (local <= keys[0][0]) return keys[0][1]
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (local < b[0]) {
      const span = b[0] - a[0]

      return span <= 0 ? b[1] : a[1] + (b[1] - a[1]) * ease(a[2], (local - a[0]) / span)
    }
  }

  return keys[keys.length - 1][1]
}

/** Effective opacity including fades. */
export function opacityAt(p, c, local) {
  let o = valueAt(p, c, 'opacity', local)
  if (c.fadeIn && local < c.fadeIn) o *= Math.max(0, local / c.fadeIn)
  if (c.fadeOut && local > c.dur - c.fadeOut) o *= Math.max(0, (c.dur - local) / c.fadeOut)

  return Math.max(0, Math.min(1, o))
}

/** Linear gain for an audio clip at clip-local seconds (volume dB, fades). */
export function gainAt(p, c, local) {
  let g = 10 ** (valueAt(p, c, 'volume', local) / 20)
  if (c.fadeIn && local < c.fadeIn) g *= Math.max(0, local / c.fadeIn)
  if (c.fadeOut && local > c.dur - c.fadeOut) g *= Math.max(0, (c.dur - local) / c.fadeOut)

  return g
}

// ---------------------------------------------------------------- ids

function nextId(p, prefix, reserved = []) {
  let max = 0
  const scan = id => {
    if (typeof id === 'string' && id.startsWith(prefix)) {
      const n = Number(id.slice(prefix.length))
      if (Number.isFinite(n)) max = Math.max(max, n)
    }
  }
  for (const id of reserved) scan(id)
  const tracks = [...(p.__rootTracks ?? p.tracks), ...Object.values(p.comps ?? {}).flatMap(k => k.tracks ?? [])]
  for (const t of tracks) {
    for (const c of t.clips) {
      scan(c.id)
      for (const m of c.masks ?? []) scan(m.id)
      for (const n of c.nodes?.list ?? []) scan(n.id)
    }
  }
  for (const m of [...(p.__rootMarkers ?? p.markers), ...p.markers, ...Object.values(p.comps ?? {}).flatMap(k => k.markers ?? [])]) scan(m.id)
  for (const k of Object.keys(p.comps ?? {})) scan(k)

  return `${prefix}${max + 1}`
}

function sortTrack(track) {
  track.clips.sort((a, b) => a.start - b.start)
}

function sourceLength(p, c) {
  if (c.kind === 'comp') return compDuration(p.comps?.[c.comp])
  if (c.kind !== 'video' && c.kind !== 'audio') return Infinity

  return (c.src && p.assets[c.src]?.duration) || Infinity
}

function deepMerge(target, set) {
  for (const [key, value] of Object.entries(set)) {
    if (key === 'id') continue
    const current = target[key]
    if (value === null) delete target[key]
    else if (current && typeof current === 'object' && !Array.isArray(current) && value && typeof value === 'object' && !Array.isArray(value)) {
      deepMerge(current, value)
    } else target[key] = structuredClone(value)
  }
}

function shiftKeys(c, delta) {
  if (c.words) c.words = c.words.map(w => ({ ...w, t: round(w.t + delta), end: round(w.end + delta) }))
  if (!c.anim) return
  for (const prop of Object.keys(c.anim)) c.anim[prop] = c.anim[prop].map(([t, v, e]) => (e === undefined ? [round(t + delta), v] : [round(t + delta), v, e]))
}

function boundCaptionWords(c) {
  if (c.kind !== 'caption' || !Array.isArray(c.words)) return
  const ranges = captionWordRanges(c)
  const keep = c.words.map((word, index) => ({ word, range: ranges[index] })).filter(({ word }) => word.end > 0 && word.t < c.dur)
  const first = keep[0]?.range, last = keep.at(-1)?.range
  c.text = first && last ? String(c.text ?? '').slice(first.start, last.end) : keep.map(({ word }) => word.text).join(' ')
  c.words = keep.map(({ word }) => ({ ...word, t: round(Math.max(0, word.t)), end: round(Math.min(c.dur, word.end)) }))
}

function correctCaptionWords(c, set) {
  if (c.kind !== 'caption' || !Array.isArray(c.words) || !Object.hasOwn(set, 'text') || Object.hasOwn(set, 'words')) return
  const tokens = String(c.text ?? '').trim().match(/\S+/gu) ?? []
  if (tokens.length === c.words.length) c.words = c.words.map((word, index) => ({ ...word, text: tokens[index] }))
  else delete c.words
}

/**
 * Clears [from, to) on a track: trims, splits or removes what is there.
 * `split` is shared by every clearRange of one op: `reserved` holds ids of clips the op is
 * about to add, and `links` gives the tails of one split link group their own shared link.
 */
function clearRange(p, track, from, to, created, split = { reserved: [], links: new Map() }) {
  const out = []
  for (const c of track.clips) {
    const end = clipEnd(c)
    if (end <= from || c.start >= to) {
      out.push(c)
      continue
    }
    if (c.start < from && end > to) {
      const tail = structuredClone(c)
      tail.id = nextId(p, 'c', [...split.reserved, ...out.map(x => x.id)])
      split.reserved.push(tail.id)
      if (c.link) {
        if (!split.links.has(c.link)) split.links.set(c.link, `L${tail.id}`)
        tail.link = split.links.get(c.link)
      }
      const cut = to - c.start
      tail.start = to
      tail.dur = round(end - to)
      if (tail.in !== undefined) tail.in = round((c.in ?? 0) + cut * (c.speed ?? 1))
      shiftKeys(tail, -cut)
      delete tail.fadeIn
      delete tail.transitionIn
      c.dur = round(from - c.start)
      boundCaptionWords(c)
      boundCaptionWords(tail)
      delete c.fadeOut
      out.push(c, tail)
      created?.push(tail.id)
      continue
    }
    if (c.start < from) {
      c.dur = round(from - c.start)
      boundCaptionWords(c)
      out.push(c)
      continue
    }
    if (end > to) {
      const cut = to - c.start
      if (c.in !== undefined) c.in = round((c.in ?? 0) + cut * (c.speed ?? 1))
      shiftKeys(c, -cut)
      c.start = to
      c.dur = round(end - to)
      boundCaptionWords(c)
      out.push(c)
    }
  }
  track.clips = out
  sortTrack(track)
}

function shiftAfter(track, from, delta, except) {
  for (const c of track.clips) if (c !== except && c.start >= from - 1e-6) c.start = round(Math.max(0, c.start + delta))
}

// Edge edits (trim, roll, slide) move clip edges by a delta d in timeline seconds. Bounds keep
// every moved clip at least a frame long, inside its media, and off the clips it does not move with.
const EDGE_EPS = 1e-3

function edgeBounds(p, track, clip, edge, moving, minDur) {
  const speed = clip.speed ?? 1
  const len = sourceLength(p, clip)
  let lo = -Infinity, hi = Infinity
  if (edge === 'right') {
    lo = minDur - clip.dur
    if (clip.in !== undefined && Number.isFinite(len)) hi = Math.min(hi, (len - clip.in) / speed - clip.dur)
    const next = track.clips.filter(c => c !== clip && !moving.has(c) && c.start >= clipEnd(clip) - EDGE_EPS).reduce((m, c) => Math.min(m, c.start), Infinity)
    hi = Math.min(hi, next - clipEnd(clip))
  } else {
    hi = clip.dur - minDur
    if (clip.in !== undefined) lo = Math.max(lo, -clip.in / speed)
    const prev = track.clips.filter(c => c !== clip && !moving.has(c) && clipEnd(c) <= clip.start + EDGE_EPS).reduce((m, c) => Math.max(m, clipEnd(c)), 0)
    lo = Math.max(lo, prev - clip.start)
  }

  return [lo, hi]
}

function moveBounds(track, clip, moving) {
  const prev = track.clips.filter(c => c !== clip && !moving.has(c) && clipEnd(c) <= clip.start + EDGE_EPS).reduce((m, c) => Math.max(m, clipEnd(c)), 0)
  const next = track.clips.filter(c => c !== clip && !moving.has(c) && c.start >= clipEnd(clip) - EDGE_EPS).reduce((m, c) => Math.min(m, c.start), Infinity)

  return [prev - clip.start, next - clipEnd(clip)]
}

function moveEdge(clip, edge, d) {
  if (edge === 'right') clip.dur = round(clip.dur + d)
  else {
    if (clip.in !== undefined) clip.in = round(clip.in + d * (clip.speed ?? 1))
    shiftKeys(clip, -d)
    clip.start = round(clip.start + d)
    clip.dur = round(clip.dur - d)
  }
  boundCaptionWords(clip)
}

/** The delta clamped to every [lo, hi]; no change when the bounds leave no room. */
function clampDelta(d, bounds) {
  const lo = Math.max(...bounds.map(b => b[0]))
  const hi = Math.min(...bounds.map(b => b[1]))
  if (lo > hi + 1e-9) return 0

  return Math.max(lo, Math.min(hi, d))
}

function linkedOf(p, c) {
  if (!c.link) return []

  return allClips(p).filter(x => x.clip !== c && x.clip.link === c.link)
}

function assetKind(p, src) {
  const a = p.assets[src]
  if (!a) return 'video'
  if (!a.hasVideo) return 'audio'
  if (a.duration === undefined || a.still) return 'image'

  return 'video'
}

/** Creates the clip (and its linked audio when the source has sound) for an edit. */
function makeClips(p, op, at, trackId) {
  const minDur = 1 / p.fps
  const kind = op.kind ?? (op.src ? assetKind(p, op.src) : 'video')
  const asset = op.src ? p.assets[op.src] : undefined
  const inPoint = Math.max(0, op.in ?? 0)
  const available = kind === 'image' ? Infinity : asset?.duration ? (asset.duration - inPoint) / (op.set?.speed ?? 1) : 5
  const requested = op.dur ?? (op.out !== undefined ? op.out - inPoint : kind === 'image' ? 5 : available)
  const dur = Math.max(minDur, Math.min(requested, available))
  const id = nextId(p, 'c')
  const clip = { id, kind, src: op.src, start: snapToFrame(at, p.fps), dur: snapToFrame(dur, p.fps), ...(kind === 'video' || kind === 'audio' ? { in: inPoint } : {}), ...structuredClone(op.set ?? {}) }
  const clips = [{ clip, track: trackId }]
  if (kind === 'video' && asset?.hasAudio && op.audio !== false) {
    const audioTrack = op.audioTrack ?? p.tracks.find(t => t.kind === 'audio' && !t.locked)?.id
    if (audioTrack) {
      const link = `L${id}`
      clip.link = link
      clip.audioDetached = true
      clips.push({ clip: { id: `${id}a`, kind: 'audio', src: op.src, start: clip.start, dur: clip.dur, in: inPoint, link, speed: clip.speed }, track: audioTrack })
    }
  }

  return clips
}

// Grade wheels are additive around 0 (render-grade.js): gain multiplies by 1 + gain, so
// DaVinci Resolve's neutral Gain 1.00 is 0 here. The Color page wheels keep a channel mean
// within ±0.8, so a gain mean of 0.95 or more, or any wheel value beyond ±2 (Resolve's Offset
// 25.00), is almost always a value typed in Resolve's units. Ops refuse it and say how to convert.
const GRADE_WHEELS = ['lift', 'gamma', 'gain', 'offset', 'shadowTint', 'highlightTint']

export function checkGradeInput(grade, where = 'grade') {
  if (!grade || typeof grade !== 'object') return
  for (const field of GRADE_WHEELS) {
    const value = grade[field]
    // A plain number for gamma is the v1 format (1 = neutral) and still renders as before.
    if (value == null || (field === 'gamma' && typeof value === 'number')) continue
    const parts = Array.isArray(value) ? value : [value]
    if (parts.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`${where}.${field} must be [r, g, b] numbers`)
    if (parts.some(v => Math.abs(v) > 2)) throw new Error(`${where}.${field} is an additive offset with neutral 0 and a useful range of about -1 to 1. Resolve values do not apply directly: Resolve Offset 25 is 0 here.`)
    const mean = parts.reduce((a, b) => a + b, 0) / parts.length
    if (field === 'gain' && mean >= 0.95) throw new Error(`${where}.gain multiplies by 1 + gain, so neutral is 0 (Resolve Gain 1.00 is 0 here, 1.10 is 0.1). Use exposure for changes of a stop or more.`)
  }
}

// ---------------------------------------------------------------- operations

/**
 * Applies ops to a copy of the project, all or nothing.
 * Returns { project, log, created }.
 */
export function applyOps(source, ops) {
  const p = migrate(structuredClone(source))
  const log = []
  const created = []
  const clipOf = id => {
    const track = p.tracks.find(t => t.clips.some(c => c.id === id))
    const found = track ? { track, clip: track.clips.find(c => c.id === id) } : null
    if (!found) throw new Error(`no clip ${id}`)
    if (found.track.locked) throw new Error(`track ${found.track.id} is locked`)

    return found
  }
  const withLinked = (id, fn) => {
    const found = clipOf(id)
    fn(found)
    for (const other of linkedOf(p, found.clip)) if (!other.track.locked) fn(other)
  }

  // A batch that slides or rolls each linked clip itself (the native timeline plans one op per
  // linked clip) must not also carry the partners, or they would move twice.
  const explicitSlides = new Set(ops.filter(o => o.op === 'slide').map(o => o.id))
  const explicitRolls = new Set(ops.filter(o => o.op === 'roll').flatMap(o => [o.a, o.b]))
  // Clips a duplicate op already copied as a linked partner in this batch (Command-D with Linked
  // selection sends one duplicate per selected clip).
  const duplicated = new Set()

  for (const op of ops) {
    // Ops act on the main timeline, or on a composition named by `comp` (or the one
    // holding the clip they name). The scope swaps that composition's tracks and markers into p.
    const ownerId = op.id ?? op.ids?.[0] ?? op.a
    const scope = Object.hasOwn(op, 'comp') ? op.comp : (ownerId ? findClip(p, ownerId)?.comp : null) ?? null
    let saved = null
    if (scope) {
      const comp = p.comps[scope]
      if (!comp) throw new Error(`no composition ${scope}`)
      saved = { tracks: p.tracks, markers: p.markers, rootMarkers: p.__rootMarkers, width: p.width, height: p.height, fps: p.fps, comp }
      p.__rootTracks = p.tracks
      p.__rootMarkers = p.__rootMarkers ?? p.markers
      p.markers = comp.markers ?? []
      p.tracks = comp.tracks
      p.width = comp.width ?? p.width
      p.height = comp.height ?? p.height
      p.fps = comp.fps ?? p.fps
    }
    try {
      applyOne(op)
    } finally {
      if (saved) {
        saved.comp.tracks = p.tracks
        // An unmarked legacy composition stays unchanged until it receives a marker.
        if (Object.hasOwn(saved.comp, 'markers') || p.markers.length > 0) saved.comp.markers = p.markers
        p.markers = saved.markers
        p.tracks = saved.tracks
        p.width = saved.width
        p.height = saved.height
        p.fps = saved.fps
        delete p.__rootTracks
        if (saved.rootMarkers === undefined) delete p.__rootMarkers
        else p.__rootMarkers = saved.rootMarkers
      }
    }
  }

  return { project: p, log, created }

  function applyOne(op) {
    const minDur = 1 / p.fps
    checkGradeInput(op.set?.grade, `${op.op}.set.grade`)
    checkGradeInput(op.node?.grade, `${op.op}.node.grade`)
    switch (op.op) {
      case 'import': {
        for (const [path, asset] of Object.entries(op.assets ?? {})) p.assets[path] = asset
        log.push(`imported ${Object.keys(op.assets ?? {}).length} media`)
        break
      }
      case 'add_clip':
      case 'append':
      case 'insert':
      case 'overwrite':
      case 'connect': {
        const track = trackOf(p, op.track ?? p.tracks.find(t => t.kind === (op.kind === 'audio' || assetKind(p, op.src) === 'audio' ? 'audio' : 'video'))?.id)
        const end = track.clips.reduce((e, c) => Math.max(e, clipEnd(c)), 0)
        const at = op.op === 'append' ? end : Math.max(0, op.start ?? op.at ?? end)
        const made = makeClips(p, op, at, track.id)
        const dur = made[0].clip.dur
        // Splits must not reuse the ids of the clips this op adds, and split tails form their own link groups.
        const split = { reserved: made.map(m => m.clip.id), links: new Map() }
        for (const { clip, track: tid } of made) {
          const t = trackOf(p, tid)
          if (op.op === 'insert') {
            for (const tt of p.tracks) {
              if (tt.locked) continue
              clearRange(p, tt, at, at, created, split)
              // split anything spanning the insert point, then push later clips
              const spanning = tt.clips.filter(c => c.start < at && clipEnd(c) > at)
              for (const c of spanning) clearRange(p, tt, at, at + 1e-9, created, split)
            }
            if (t === track) for (const tt of p.tracks) if (!tt.locked) shiftAfter(tt, at, dur)
          } else if (op.op === 'overwrite') {
            clearRange(p, t, at, at + dur, created, split)
          }
          t.clips.push(clip)
          sortTrack(t)
          created.push(clip.id)
        }
        log.push(`${op.op === 'add_clip' ? 'added' : op.op} ${made[0].clip.kind} ${made[0].clip.id} on ${track.id} at ${round(at, 3)}s`)
        break
      }
      case 'add_title': {
        const track = visualCreationTrack(p, op.track, true, { start: snapToFrame(Math.max(0, op.start ?? 0), p.fps), dur: Math.max(minDur, op.dur ?? 4) })
        const id = nextId(p, 'c')
        const clip = {
          id,
          kind: 'title',
          start: snapToFrame(Math.max(0, op.start ?? 0), p.fps),
          dur: snapToFrame(Math.max(minDur, op.dur ?? 4), p.fps),
          title: { text: op.text ?? 'Title', font: 'Avenir Next', weight: 800, size: 120, color: '#ffffff', align: 'center', shadow: { color: '#00000099', blur: 18, x: 0, y: 6 }, anim: 'rise', ...(op.title ?? {}) },
          ...structuredClone(op.set ?? {}),
        }
        if (op.set?.title) clip.title = { ...clip.title, ...op.set.title }
        track.clips.push(clip)
        sortTrack(track)
        created.push(id)
        log.push(`added title ${id} "${clip.title.text}"`)
        break
      }
      case 'add_color': {
        const track = visualCreationTrack(p, op.track)
        const id = nextId(p, 'c')
        track.clips.push({ id, kind: 'color', color: op.color ?? '#202020', start: snapToFrame(op.start ?? 0, p.fps), dur: snapToFrame(op.dur ?? 3, p.fps), ...(op.set ?? {}) })
        sortTrack(track)
        created.push(id)
        log.push(`added color ${id}`)
        break
      }
      case 'adjustment': {
        const track = visualCreationTrack(p, op.track, true, { start: snapToFrame(op.start ?? 0, p.fps), dur: op.dur ?? 5 })
        const id = nextId(p, 'c')
        track.clips.push({ id, kind: 'adjustment', label: 'Adjustment', start: snapToFrame(op.start ?? 0, p.fps), dur: snapToFrame(op.dur ?? 5, p.fps), ...(op.set ?? {}) })
        sortTrack(track)
        created.push(id)
        log.push(`added adjustment layer ${id}`)
        break
      }
      case 'update': {
        const dotted = Object.keys(op.set ?? {}).find(key => key.includes('.'))
        if (dotted) throw new Error(`update.set field "${dotted}" must use nested objects, such as set:{title:{text:"New title"}}`)
        const ids = Array.isArray(op.ids) ? op.ids : [op.id]
        for (const id of ids) {
          const { clip } = clipOf(id)
          deepMerge(clip, op.set ?? {})
          correctCaptionWords(clip, op.set ?? {})
          clip.dur = Math.max(minDur, clip.dur)
          if (Object.hasOwn(op.set ?? {}, 'dur')) boundCaptionWords(clip)
        }
        log.push(`updated ${ids.join(', ')}: ${Object.keys(op.set ?? {}).join(', ')}`)
        break
      }
      case 'move': {
        const { track, clip } = clipOf(op.id)
        const delta = snapToFrame(Math.max(0, op.start), p.fps) - clip.start
        const movers = [{ track, clip }, ...(op.unlinked ? [] : linkedOf(p, clip))]
        for (const m of movers) m.clip.start = round(Math.max(0, m.clip.start + delta))
        if (op.track && op.track !== track.id) {
          const target = trackOf(p, op.track)
          if (target.kind !== track.kind) throw new Error(`cannot move a ${track.kind} clip onto ${target.kind} track ${target.id}`)
          if (target.locked) throw new Error(`track ${target.id} is locked`)
          track.clips = track.clips.filter(c => c !== clip)
          target.clips.push(clip)
          sortTrack(target)
        }
        if (op.overwrite) {
          const split = { reserved: [], links: new Map() }
          for (const m of movers) {
            const t = p.tracks.find(tt => tt.clips.includes(m.clip))
            const others = t.clips.filter(c => c !== m.clip)
            const holder = { ...t, clips: others }
            clearRange(p, holder, m.clip.start, clipEnd(m.clip), created, split)
            t.clips = [...holder.clips, m.clip]
          }
        }
        for (const t of p.tracks) sortTrack(t)
        log.push(`moved ${op.id} to ${round(clip.start, 3)}s${op.track ? ` on ${op.track}` : ''}`)
        break
      }
      case 'trim': {
        // Linked partners move their edge by the same amount, so split edits keep their offset.
        // `unlinked` trims only this clip (Linked selection off): that is how J and L cuts are made.
        const main = clipOf(op.id)
        const parts = [main, ...(op.unlinked ? [] : linkedOf(p, main.clip).filter(o => !o.track.locked))]
        const edgeOf = c => (op.edge === 'left' ? c.start : clipEnd(c))
        let delta = snapToFrame(op.to, p.fps) - edgeOf(main.clip)
        // A plain trim stops at the neighbouring clip instead of covering it.
        if (!op.ripple) {
          const moving = new Set(parts.map(x => x.clip))
          delta = clampDelta(delta, parts.map(x => edgeBounds(p, x.track, x.clip, op.edge, moving, minDur)))
        }
        const apply = ({ track, clip }, to) => {
          const speed = clip.speed ?? 1
          const end = clipEnd(clip)
          if (op.edge === 'left') {
            let start = Math.min(to, end - minDur)
            if (clip.in !== undefined && clip.in + (start - clip.start) * speed < 0) start = clip.start - clip.in / speed
            if (!op.ripple) start = Math.max(0, start)
            const shift = start - clip.start
            if (clip.in !== undefined) clip.in = round(clip.in + shift * speed)
            shiftKeys(clip, -shift)
            const originalStart = clip.start
            clip.start = round(op.ripple ? originalStart : start)
            clip.dur = round(end - start)
            if (op.ripple) shiftAfter(track, end, -shift, clip)
          } else {
            const maxDur = (sourceLength(p, clip) - (clip.in ?? 0)) / speed
            const nextDur = round(Math.max(minDur, Math.min(to - clip.start, maxDur)))
            const change = nextDur - clip.dur
            clip.dur = nextDur
            if (op.ripple) shiftAfter(track, end, change, clip)
          }
          sortTrack(track)
          boundCaptionWords(clip)
        }
        for (const part of parts) apply(part, round(edgeOf(part.clip) + delta))
        log.push(`trimmed ${op.id} ${op.edge} to ${round(op.to, 3)}s${op.ripple ? ' (ripple)' : ''}${op.unlinked ? ' (unlinked)' : ''}`)
        break
      }
      case 'roll': {
        // Moves the edit point between two adjacent clips. Linked partners roll with them: a
        // partner pair that meets at a cut rolls that cut; a partner alone moves its own edge.
        // `unlinked` rolls only these two clips, which makes a J or L cut.
        const A = clipOf(op.a)
        const B = clipOf(op.b)
        const edges = [[A, 'right'], [B, 'left']]
        const plannedByBatch = [...linkedOf(p, A.clip), ...linkedOf(p, B.clip)].some(o => explicitRolls.has(o.clip.id))
        if (!op.unlinked && !plannedByBatch) {
          const partnersA = linkedOf(p, A.clip).filter(o => !o.track.locked)
          const partnersB = linkedOf(p, B.clip).filter(o => !o.track.locked)
          for (const pa of partnersA) if (Math.abs(clipEnd(pa.clip) - clipEnd(A.clip)) < EDGE_EPS || partnersB.some(pb => pb.track === pa.track && Math.abs(pb.clip.start - clipEnd(pa.clip)) < EDGE_EPS)) edges.push([pa, 'right'])
          for (const pb of partnersB) if (Math.abs(pb.clip.start - B.clip.start) < EDGE_EPS || partnersA.some(pa => pa.track === pb.track && Math.abs(pb.clip.start - clipEnd(pa.clip)) < EDGE_EPS)) edges.push([pb, 'left'])
        }
        const moving = new Set(edges.map(([x]) => x.clip))
        const d = clampDelta(snapToFrame(op.to, p.fps) - clipEnd(A.clip), edges.map(([x, edge]) => edgeBounds(p, x.track, x.clip, edge, moving, minDur)))
        for (const [x, edge] of edges) moveEdge(x.clip, edge, d)
        log.push(`rolled edit ${op.a}|${op.b} to ${round(clipEnd(A.clip), 3)}s${op.unlinked ? ' (unlinked)' : ''}`)
        break
      }
      case 'slip': {
        withLinked(op.id, ({ clip }) => {
          if (clip.in === undefined) return
          const len = sourceLength(p, clip)
          const span = clip.dur * (clip.speed ?? 1)
          clip.in = round(Math.max(0, Math.min(len - span, clip.in + op.delta)))
        })
        log.push(`slipped ${op.id} by ${round(op.delta, 3)}s`)
        break
      }
      case 'slide': {
        // Moves a clip between its neighbours: the clip before grows or shrinks at its end and the
        // clip after at its start. Linked partners slide with it, and the neighbours' partners follow.
        const main = clipOf(op.id)
        const unlinked = op.unlinked || linkedOf(p, main.clip).some(o => explicitSlides.has(o.clip.id))
        const sliders = [main, ...(unlinked ? [] : linkedOf(p, main.clip).filter(o => !o.track.locked))]
        const edges = []
        for (const { track, clip } of sliders) {
          const before = track.clips.find(c => c !== clip && Math.abs(clipEnd(c) - clip.start) < EDGE_EPS)
          const after = track.clips.find(c => c !== clip && Math.abs(c.start - clipEnd(clip)) < EDGE_EPS)
          if (before) edges.push([{ track, clip: before }, 'right'])
          if (after) edges.push([{ track, clip: after }, 'left'])
        }
        if (!unlinked) {
          for (const [n, edge] of [...edges]) {
            for (const o of linkedOf(p, n.clip).filter(x => !x.track.locked)) {
              const aligned = edge === 'right' ? Math.abs(clipEnd(o.clip) - clipEnd(n.clip)) < EDGE_EPS : Math.abs(o.clip.start - n.clip.start) < EDGE_EPS
              if (aligned && !edges.some(([e]) => e.clip === o.clip) && !sliders.some(x => x.clip === o.clip)) edges.push([o, edge])
            }
          }
        }
        const moving = new Set([...sliders, ...edges.map(([e]) => e)].map(x => x.clip))
        const bounds = [
          ...sliders.map(x => moveBounds(x.track, x.clip, moving)),
          ...sliders.map(x => [-x.clip.start, Infinity]),
          ...edges.map(([x, edge]) => edgeBounds(p, x.track, x.clip, edge, moving, minDur)),
        ]
        const d = clampDelta(op.delta, bounds)
        for (const { clip } of sliders) clip.start = round(clip.start + d)
        for (const [x, edge] of edges) moveEdge(x.clip, edge, d)
        for (const t of p.tracks) sortTrack(t)
        log.push(`slid ${op.id} by ${round(d, 3)}s`)
        break
      }
      case 'split':
      case 'blade': {
        const at = snapToFrame(op.at, p.fps)
        const targets = op.id
          ? [clipOf(op.id), ...linkedOf(p, clipOf(op.id).clip)]
          : p.tracks.filter(t => !t.locked && (!op.tracks || op.tracks.includes(t.id))).flatMap(track => track.clips.filter(c => c.start < at - 1e-6 && clipEnd(c) > at + 1e-6).map(clip => ({ track, clip })))
        const newLinks = new Map()
        for (const { track, clip } of targets) {
          if (!(clip.start < at && clipEnd(clip) > at)) continue
          const id = nextId(p, 'c')
          const head = at - clip.start
          const tail = structuredClone(clip)
          tail.id = id
          tail.start = at
          tail.dur = round(clip.dur - head)
          if (tail.in !== undefined) tail.in = round((clip.in ?? 0) + head * (clip.speed ?? 1))
          shiftKeys(tail, -head)
          delete tail.fadeIn
          delete tail.transitionIn
          clip.dur = round(head)
          boundCaptionWords(clip)
          boundCaptionWords(tail)
          delete clip.fadeOut
          if (clip.link) {
            if (!newLinks.has(clip.link)) newLinks.set(clip.link, `L${id}`)
            tail.link = newLinks.get(clip.link)
          }
          track.clips.push(tail)
          sortTrack(track)
          created.push(id)
          log.push(`bladed ${clip.id} at ${at}s → ${id}`)
        }
        if (targets.length === 0) log.push(`nothing to cut at ${at}s`)
        break
      }
      case 'delete':
      case 'lift':
      case 'ripple_delete': {
        const ids = Array.isArray(op.ids) ? op.ids : [op.id]
        const ripple = op.op === 'ripple_delete' || op.ripple
        const gone = new Set()
        for (const id of ids) {
          const found = clipOf(id)
          gone.add(found.clip)
          if (!op.unlinked) for (const l of linkedOf(p, found.clip)) gone.add(l.clip)
        }
        for (const track of p.tracks) {
          const removed = track.clips.filter(c => gone.has(c)).sort((a, b) => b.start - a.start)
          track.clips = track.clips.filter(c => !gone.has(c))
          if (ripple) for (const r of removed) shiftAfter(track, clipEnd(r), -r.dur)
        }
        log.push(`${ripple ? 'ripple deleted' : 'deleted'} ${ids.join(', ')}`)
        break
      }
      case 'delete_range': {
        const from = snapToFrame(op.from, p.fps)
        const to = snapToFrame(op.to, p.fps)
        const split = { reserved: [], links: new Map() }
        for (const track of p.tracks) {
          if (track.locked || (op.tracks && !op.tracks.includes(track.id))) continue
          clearRange(p, track, from, to, created, split)
          if (op.ripple !== false) shiftAfter(track, to, -(to - from))
        }
        log.push(`removed ${round(from, 3)}–${round(to, 3)}s${op.ripple !== false ? ' (ripple)' : ''}`)
        break
      }
      case 'duplicate': {
        // The copy brings its linked audio (unless `unlinked`), and copies of one link group share
        // a new link. Without a start it goes right after the clip when every track it needs is
        // free there, else after the last clip on those tracks, so it never covers another clip.
        const { track, clip } = clipOf(op.id)
        if (duplicated.has(clip)) { log.push(`${op.id} was already duplicated with its linked clip`); break }
        const group = [{ track: op.track ? trackOf(p, op.track) : track, clip }, ...(op.unlinked ? [] : linkedOf(p, clip).filter(o => !o.track.locked))]
        let start = snapToFrame(op.start ?? clipEnd(clip), p.fps)
        if (op.start === undefined) {
          // Each member keeps its own offset and length (a J cut's audio starts before its video).
          const busy = g => { const s = g.clip.start + start - clip.start; return g.track.clips.some(c => c.start < s + g.clip.dur - 1e-6 && clipEnd(c) > s + 1e-6) }
          if (group.some(busy)) start = snapToFrame(Math.max(...group.map(g => Math.max(0, ...g.track.clips.map(clipEnd)) - (g.clip.start - clip.start))), p.fps)
        }
        const delta = start - clip.start
        const link = group.length > 1 ? `L${nextId(p, 'c')}` : null
        const ids = []
        for (const g of group) {
          const copy = structuredClone(g.clip)
          copy.id = nextId(p, 'c')
          if (link) copy.link = link
          else delete copy.link
          copy.start = round(Math.max(0, g.clip.start + delta))
          g.track.clips.push(copy)
          sortTrack(g.track)
          duplicated.add(g.clip)
          created.push(copy.id)
          ids.push(copy.id)
        }
        log.push(`duplicated ${op.id} as ${ids.join(', ')}`)
        break
      }
      case 'paste': {
        const at = op.at ?? 0
        created.push(...pasteClips(p, { ...op, scope: Object.hasOwn(op, 'comp') ? op.comp : null }, nextId))
        log.push(`pasted ${op.clips?.length ?? 0} clips at ${round(at, 3)}s`)
        break
      }
      case 'speed': {
        // A slower clip pushes later clips on its tracks, so it never covers the next one. A faster clip
        // leaves a gap unless `ripple: true`; `ripple: false` keeps later clips and stops at the next clip.
        withLinked(op.id, ({ track, clip }) => {
          const old = clip.speed ?? 1
          const oldEnd = clipEnd(clip)
          const oldDur = clip.dur
          const speed = Math.max(0.05, Math.min(20, op.speed))
          clip.dur = round((clip.dur * old) / speed)
          clip.speed = speed
          if (op.reverse !== undefined) clip.reverse = op.reverse || undefined
          const len = sourceLength(p, clip)
          if (Number.isFinite(len)) clip.dur = round(Math.min(clip.dur, (len - (clip.in ?? 0)) / speed))
          if (op.ripple === false) {
            const next = track.clips.filter(c => c !== clip && c.start >= oldEnd - EDGE_EPS).reduce((m, c) => Math.min(m, c.start), Infinity)
            clip.dur = round(Math.max(minDur, Math.min(clip.dur, next - clip.start)))
          } else if (clip.dur > oldDur || op.ripple === true) shiftAfter(track, oldEnd, clip.dur - oldDur, clip)
          boundCaptionWords(clip)
        })
        log.push(`retimed ${op.id} to ${op.speed}x`)
        break
      }
      case 'freeze': {
        const { track, clip } = clipOf(op.id)
        const at = snapToFrame(op.at, p.fps)
        if (clip.kind !== 'video') throw new Error('freeze frames need a video clip')
        const hold = op.dur ?? 2
        const held = sourceTime(p, clip, at)
        const tmp = applyOps(p, [{ op: 'split', id: clip.id, at }])
        Object.assign(p, tmp.project)
        // The id comes after the split so the freeze frame never shares an id with the split's tail.
        const id = nextId(p, 'c')
        const frame = { id, kind: 'video', src: clip.src, start: at, dur: hold, in: held, freeze: held, label: 'Freeze', grade: clip.grade, x: clip.x, y: clip.y, scale: clip.scale }
        const t2 = trackOf(p, track.id)
        // The hold is an insert: everything from the freeze point on, linked audio included, moves later together.
        for (const tt of p.tracks) if (!tt.locked) shiftAfter(tt, at, hold)
        t2.clips.push(frame)
        sortTrack(t2)
        created.push(id)
        log.push(`freeze frame ${id} at ${at}s for ${hold}s`)
        break
      }
      case 'detach_audio': {
        const { clip } = clipOf(op.id)
        for (const l of linkedOf(p, clip)) delete l.clip.link
        delete clip.link
        log.push(`unlinked ${op.id}`)
        break
      }
      case 'link': {
        const link = `L${op.ids[0]}`
        for (const id of op.ids) clipOf(id).clip.link = link
        log.push(`linked ${op.ids.join(', ')}`)
        break
      }
      case 'transition': {
        const { clip } = clipOf(op.id)
        if (op.type === null || op.type === 'none') delete clip.transitionIn
        else clip.transitionIn = { type: op.type ?? 'crossDissolve', dur: round(Math.max(minDur * 2, op.dur ?? 1)) }
        log.push(op.type === null || op.type === 'none' ? `removed transition on ${op.id}` : `transition ${clip.transitionIn.type} (${clip.transitionIn.dur}s) into ${op.id}`)
        break
      }
      case 'effect': {
        const { clip } = clipOf(op.id)
        clip.effects ??= []
        if (op.remove !== undefined) clip.effects.splice(op.remove, 1)
        else if (op.index !== undefined) Object.assign(clip.effects[op.index].params, op.params ?? {}), op.enabled !== undefined && (clip.effects[op.index].enabled = op.enabled)
        else clip.effects.push({ type: op.type, enabled: true, params: { ...(EFFECTS[op.type] ?? {}), ...(op.params ?? {}) } })
        log.push(`effect ${op.type ?? op.index ?? op.remove} on ${op.id}`)
        break
      }
      case 'keyframe': {
        const ids = Array.isArray(op.ids) ? op.ids : [op.id]
        for (const id of ids) {
          const { clip } = clipOf(id)
          const local = round(op.local ? op.at : op.at - clip.start)
          const anim = (clip.anim ??= {})
          const keys = (anim[op.prop] ?? []).filter(k => Math.abs(k[0] - local) > 1e-3)
          if (!op.remove) keys.push(op.ease ? [local, op.value, op.ease] : [local, op.value])
          anim[op.prop] = sortedKeys(keys)
          if (anim[op.prop].length === 0) delete anim[op.prop]
        }
        log.push(`${op.remove ? 'removed' : 'set'} ${op.prop} keyframe on ${ids.join(', ')}`)
        break
      }
      case 'keyframe_ease': {
        const { clip } = clipOf(op.id)
        const keys = clip.anim?.[op.prop]
        const k = keys?.[op.index]
        if (!k) throw new Error(`no keyframe ${op.index} on ${op.id}.${op.prop}`)
        if (op.ease === 'linear') keys[op.index] = [k[0], k[1]]
        else keys[op.index] = [op.t ?? k[0], op.value ?? k[1], op.ease ?? k[2]]
        if (op.t !== undefined || op.value !== undefined) keys[op.index] = [round(op.t ?? k[0]), op.value ?? k[1], ...(keys[op.index][2] !== undefined ? [keys[op.index][2]] : [])]
        clip.anim[op.prop] = sortedKeys(keys)
        log.push(`keyframe ${op.id}.${op.prop}[${op.index}]`)
        break
      }
      case 'clear_keyframes': {
        const { clip } = clipOf(op.id)
        if (op.prop) delete clip.anim?.[op.prop]
        else delete clip.anim
        log.push(`cleared keyframes on ${op.id}${op.prop ? `.${op.prop}` : ''}`)
        break
      }
      case 'add_track': {
        const prefix = op.kind === 'audio' ? 'A' : 'V'
        let n = 1
        while (p.tracks.some(t => t.id === `${prefix}${n}`)) n++
        const track = { id: `${prefix}${n}`, kind: op.kind, name: op.name ?? `${op.kind === 'audio' ? 'Audio' : 'Video'} ${n}`, clips: [], ...(op.kind === 'audio' ? { volume: 0, pan: 0 } : {}) }
        if (op.kind === 'video') p.tracks.splice(p.tracks.map(t => t.kind).lastIndexOf('video') + 1, 0, track)
        else p.tracks.push(track)
        created.push(track.id)
        log.push(`added track ${track.id}`)
        break
      }
      case 'update_track': {
        const track = trackOf(p, op.id)
        deepMerge(track, op.set ?? {})
        log.push(`updated track ${op.id}: ${Object.keys(op.set ?? {}).join(', ')}`)
        break
      }
      case 'delete_track': {
        const track = trackOf(p, op.id)
        if (p.tracks.filter(t => t.kind === track.kind).length <= 1) throw new Error('keep at least one track of each kind')
        p.tracks = p.tracks.filter(t => t !== track)
        log.push(`deleted track ${op.id}`)
        break
      }
      case 'marker': {
        const id = nextId(p, 'm')
        p.markers.push({ id, t: snapToFrame(op.t, p.fps), label: op.label ?? '', color: op.color ?? MARKER_COLORS[0], note: op.note, kind: op.kind ?? 'marker', ...(op.dur ? { dur: op.dur } : {}) })
        p.markers.sort((a, b) => a.t - b.t)
        created.push(id)
        log.push(`marker ${id} "${op.label ?? ''}" at ${round(op.t, 3)}s`)
        break
      }
      case 'markers': {
        for (const m of op.markers ?? []) {
          const id = nextId(p, 'm')
          p.markers.push({ id, t: snapToFrame(m.t, p.fps), label: m.label ?? '', color: m.color ?? op.color ?? MARKER_COLORS[3], kind: m.kind ?? 'marker', ...(m.note ? { note: m.note } : {}), ...(m.dur ? { dur: m.dur } : {}) })
          created.push(id)
        }
        p.markers.sort((a, b) => a.t - b.t)
        log.push(`added ${op.markers?.length ?? 0} markers`)
        break
      }
      case 'update_marker': {
        const m = p.markers.find(x => x.id === op.id)
        if (!m) throw new Error(`no marker ${op.id}`)
        deepMerge(m, op.set ?? {})
        if (op.set?.t !== undefined) m.t = snapToFrame(op.set.t, p.fps)
        p.markers.sort((a, b) => a.t - b.t)
        log.push(`updated marker ${op.id}`)
        break
      }
      case 'delete_marker': {
        const ids = Array.isArray(op.ids) ? op.ids : [op.id]
        p.markers = p.markers.filter(m => !ids.includes(m.id))
        log.push(`deleted marker ${ids.join(', ')}`)
        break
      }
      case 'close_gaps': {
        const track = trackOf(p, op.track)
        let cursor = 0
        for (const clip of track.clips) {
          const delta = cursor - clip.start
          if (delta < 0) for (const l of linkedOf(p, clip)) l.clip.start = round(l.clip.start + delta)
          clip.start = round(Math.min(clip.start, cursor))
          cursor = clipEnd(clip)
        }
        log.push(`closed gaps on ${op.track}`)
        break
      }
      case 'range': {
        const target = op.comp ? p.comps[op.comp] : p
        target.range = op.in === null ? null : { in: snapToFrame(op.in ?? target.range?.in ?? 0, p.fps), out: snapToFrame(op.out ?? target.range?.out ?? (op.comp ? compDuration(target) : duration(p)), p.fps) }
        log.push(target.range ? `range ${target.range.in}–${target.range.out}s` : 'cleared range')
        break
      }
      case 'project': {
        deepMerge(p, op.set ?? {})
        log.push(`project: ${Object.keys(op.set ?? {}).join(', ')}`)
        break
      }
      case 'replace': {
        Object.keys(p).forEach(k => delete p[k])
        Object.assign(p, migrate(structuredClone(op.project)))
        log.push('replaced the project')
        break
      }
      default:
        if (!applyLibraryOp(p, op, { log, created, snapToFrame, round }) && !applyMotionOp(p, op, { log, created, clipOf, minDur })) throw new Error(`unknown op ${op.op}`)
    }
  }
}

// ---------------------------------------------------------------- describing

export function describeClip(p, c) {
  const what = c.kind === 'title' ? `"${c.title?.text ?? ''}"` : c.kind === 'color' ? c.color ?? 'color' : c.kind === 'adjustment' ? 'adjustment' : c.src ?? ''
  const extras = [
    c.speed && c.speed !== 1 ? `${c.speed}x` : '',
    c.transitionIn ? `${c.transitionIn.type} in` : '',
    c.anim ? `keys:${Object.keys(c.anim).join('/')}` : '',
    c.effects?.length ? `fx:${c.effects.map(e => e.type).join('/')}` : '',
    c.grade ? 'graded' : '',
    c.link ? `link:${c.link}` : '',
    c.enabled === false ? 'disabled' : '',
  ].filter(Boolean).join(' ')

  return `${c.id} ${c.kind} ${what} ${timecode(c.start, p.fps)}→${timecode(clipEnd(c), p.fps)} (${round(c.dur, 3)}s${c.in !== undefined ? `, in ${round(c.in, 3)}s` : ''})${extras ? ` ${extras}` : ''}`
}

export function outline(p) {
  const lines = [`${p.name}: ${p.width}x${p.height} @${p.fps}fps, ${duration(p)}s`]
  for (const track of p.tracks) {
    const flags = [track.muted && 'muted', track.hidden && 'hidden', track.locked && 'locked', track.solo && 'solo'].filter(Boolean).join(' ')
    lines.push(`${track.id} (${track.kind}${track.name ? `, ${track.name}` : ''}${flags ? `, ${flags}` : ''}):`)
    for (const c of track.clips) lines.push(`  ${describeClip(p, c)}`)
  }
  if (p.markers.length) lines.push(`markers: ${p.markers.map(m => `${m.id} "${m.label}" @${m.t}s`).join(', ')}`)
  const media = Object.keys(p.assets)
  if (media.length) lines.push(`media: ${media.join(', ')}`)
  for (const item of p.library?.items ?? []) lines.push(`library ${item.id} (${item.category}) "${item.name}": ${describeLibraryItem(item)}${item.description ? `; ${item.description}` : ''}`)

  return lines.join('\n')
}

export const OPS_DOC = [
  'Ops (objects with "op"); times are timeline seconds unless noted; video tracks stack bottom→top in array order.',
  '- library_save {category:title|composition|effect|transition|motion,name,description?,source:{clip?|composition?,type?:composition},index?} captures editable native data and its project media dependencies without editing the source. LUT dependencies use body.resources with type:lut, CUBE size and sourceHash; hosts inspect the actual project files before saving or applying. They never become Media assets. index selects one stack effect. An effect with source.composition saves an overlay; source.type:composition saves a selected comp clip with its wrapper. Save a composition when a layer has parent, matte or layer-expression dependencies.',
  '- library_apply {item:libraryId,id?:targetClip,track?,start?,comp?} places a fresh title/composition/effect overlay at the playhead or adds effects, transition or keyframes to a compatible clip. IDs and internal references are remapped. Motion scales to target duration and refuses property conflicts. Transitions need an adjacent preceding clip and no existing transition. A transition composition creates an editable overlay centered on the selected cut, on a free unlocked video track above the target or a new track. Its half duration must fit on both sides. Existing objects are preserved.',
  '- library_rename {item:libraryId,name,description?}  - library_remove {item:libraryId} removes only the saved item. Every library edit uses the normal atomic undo history.',
  '- library_register {item:{id?,name,description?,category,body}} registers declarative native data, never JavaScript. body.clip is a full native title or comp clip, or body.composition is a root ID; body.comps contains the composition dependency closure and body.assets must match imported project assets. Referenced LUT paths require body.resources entries with {type:lut,size,sourceHash}; hosts verify their actual CUBE files and hashes. JSON-only transfer cannot include these files. Custom transitions and effect overlays use a comp clip or root composition body. Effect overlays place independent editable layers; effect settings apply to a target clip. Target components use body.settings: effect {effects,nodes?,grade?,anim?,dur?}, motion {anim,dur,kind}, transition {transitionIn:{type,dur}}. Effect node animation requires a positive source dur. Prefer creating native objects with normal ops and library_save.',
  '- append|insert|overwrite|connect|add_clip {src, track?, start?, in?, out?|dur?, set?, audio?:false}  insert ripples later clips; overwrite clears the range; video with sound adds a linked audio clip',
  '- add_title {text, track?, start?, dur?, title?:{font,weight,size,color,align,lineHeight,tracking,stroke:{color,width},shadow:{color,blur,x,y},plate,padding,radius,anim:none|fade|rise|drop|pop|slideLeft|slideRight|typewriter|blurIn|tracking}, set?}',
  '- add_color {color, start, dur, track?}   - adjustment {start, dur, track?} (grade/effects apply to everything below)',
  '- update {id|ids, set}  clip fields: x,y (canvas px of center), scale, scaleX, scaleY, rotation, opacity, blend (normal|add|screen|multiply|overlay|softLight|lighten|darken|difference|colorDodge), crop {l,r,t,b} (0..1), volume (dB), pan (-1..1), eq {low,mid,high} (dB), fadeIn, fadeOut, enabled, label, note, color, mute, role (dialogue|music|effects: the mixing role ducking uses; unset means picture sound is dialogue and audio-only files are music), tag (color label hex or null), fx (audio effect chain, below), title {text, font, weight, size, color, align, lineHeight, tracking, italic, gradient:[startColor,endColor], stroke, shadow, plate, padding, radius, anim},',
  '  Nested fields require nested objects: set:{title:{text:"New title"}}. Dotted update.set keys are rejected. Use keyframe/expression prop for animated property paths.',
  '    grade {exposure, contrast, pivot, saturation, hue, temperature, tint, lift:[r,g,b], gamma:[r,g,b], gain:[r,g,b], offset:[r,g,b], curves:{master|r|g|b:[[x,y],...]}, lut (path to .cube), lutMix, look: none|mono|warm|cool|punch|film|fade|teal-orange|bleach|noir}, key {color, similarity, smoothness, spill}; null deletes a field',
  '    Grade ranges (neutral first): exposure 0 in stops; contrast 1 and saturation 1 multiply; pivot 0.435; hue 0 degrees; temperature 0 and tint 0, each -1..1. lift, gamma, gain, offset, shadowTint and highlightTint are additive per channel with neutral 0, usually within -0.5..0.5: gain multiplies by 1+gain, lift raises blacks, gamma bends mids, offset adds. These are not Resolve units: Resolve Gain 1.00 is 0 here and 1.10 is 0.1, Resolve Offset 25 is 0. Ops refuse a gain mean of 0.95 or more and any wheel value beyond 2.',
  '- move {id, start, track?, overwrite?, unlinked?}  - trim {id, edge:left|right, to, ripple?, unlinked?}  - roll {a, b, to, unlinked?}  - slip {id, delta}  - slide {id, delta, unlinked?}',
  '  Linked video and audio trim, roll and slide together; unlinked:true edits one side only (for a J or L cut, roll the audio edit with unlinked). Edit a linked clip once: a separate call for its partner moves the pair twice. A trim without ripple stops at the neighbouring clip.',
  '- blade|split {at, id?, tracks?}  - delete|lift {id|ids} (leaves a gap)  - ripple_delete {id|ids}  - delete_range {from, to, tracks?, ripple?}  - duplicate {id, start?, track?, unlinked?} (copies linked audio too; without start it lands after the clip without covering another)  - paste {at, clips:[{track, clip, offset}]} places copies of clip objects at timeline seconds at',
  '- speed {id, speed, reverse?, ripple?} (a slower clip pushes later clips; ripple:true also closes the gap a faster clip leaves; ripple:false stops at the next clip)  - freeze {id, at, dur?}  - detach_audio {id}  - link {ids}',
  '- transition {id, type: crossDissolve|dipBlack|dipWhite|wipeLeft|wipeRight|wipeUp|wipeDown|slideLeft|slideRight|pushLeft|pushRight|zoomIn|iris|blurDissolve|none, dur}  (into clip id, centered on its start)',
  '- effect {id, type: blur|sharpen|vignette|grain|pixelate|glow|mirror|invert|posterize|chromaticAberration|letterbox, params?} | {id, index, params?, enabled?} | {id, remove: index}',
  '- keyframe {id|ids, prop: x|y|scale|scaleX|scaleY|rotation|opacity|anchorX|anchorY|volume|pan|blur or a dotted path such as fx.0.params.threshold, shape.trim.end, mask.mk1.feather, at, value, ease?: linear|in|out|inOut|smooth|backOut|expoOut|expoIn|hold|[x1,y1,x2,y2], local?, remove?}  - clear_keyframes {id, prop?}',
  '- keyframe_ease {id, prop, index, ease?, t?, value?} changes one existing keyframe (index in time order; t is clip-local seconds)',
  '- add_track {kind, name?}  - update_track {id, set:{name,muted,hidden,locked,solo,volume,pan,fx}}  - delete_track {id}; caption tracks also take set:{burnIn, style:{font,size,weight,color,highlight,plate,y}}',
  'Audio effects: clip, track and master chains are arrays of {type, enabled, params}. eq {bands:[{type: lowshelf|peaking|highshelf|lowpass|highpass|notch, freq, gain, q}]} (up to 6 bands), compressor {threshold, ratio, attack, release, knee, makeup}, gate {threshold, attack, hold, release, range}, deesser {threshold, ratio, range, lo, hi, attack, release}, limiter {ceiling, release, lookahead}, reverb {size, decay, predelay, mix}, delay {time, feedback, mix}, gain {gain}. Set a clip chain with update {id, set:{fx:[...]}}, a track chain with update_track {id, set:{fx:[...]}}, and the master with project {set:{master:{fx, volume, limiter:{enabled, ceiling, release}}}}.',
  '- marker {t, label, color?, note?, kind?: marker|chapter|todo, dur?}  - markers {markers:[{t,label,color?,note?,kind?,dur?}]}  - update_marker {id, set}  - delete_marker {id|ids}; markers belong to comp when specified, otherwise the main timeline',
  '- close_gaps {track}  - range {in, out} | {in:null}  - project {set:{name,width,height,fps,background}}',
  'Compositions (precomps / compound clips): any op takes comp:"k1" to act inside that composition; ops naming a clip act where the clip lives.',
  '- add_comp {name, width?, height?, fps?, duration?}  - update_comp {target, set}  - delete_comp {target}  - comp_clip {target, track, start, dur?}  - precompose {ids, name}',
  'Motion layers: transform adds anchorX/anchorY (offset from layer center, px) and parent (clip id).',
  '- add_shape {shape:{type: rect|ellipse|polygon|star|line|path, width, height, radius, sides, points, innerRadius, path:{closed, vertices:[[x,y]], in, out}, fill:{color}|{gradient:{type,stops,angle}}, stroke:{color,width,dash}, trim:{start,end,offset}}, track, start, dur, set?}',
  '- add_null {track, start, dur, name}  - parent {id, parent|null}',
  '- add_mask {id, mask:{type: rect|ellipse|path, x, y, w, h, path, mode: add|subtract|intersect, inverted, feather, expansion, opacity}}  - update_mask {id, mask, set}  - delete_mask {id, mask}',
  '- matte {id, matte:{mode: alpha|alphaInverted|luma|lumaInverted, source?}|null}  (track matte from the layer above)',
  '- expression {id|ids, prop, expr|null}  e.g. "wiggle(2, 30)", "value + sin(time*3)*50", "loopOut(\"cycle\")", "layer(\"Logo\").x + 200"; animatable dotted props too: shape.width, shape.trim.end, mask.mk1.feather',
  'Node graphs (Resolve-style color/compositing; default graph source→primary→output, primary = the clip grade):',
  '- node_add {id, node:{type: corrector|parallel|layerMixer|key|lut|blur|sharpen|glow, grade?, qualifier?:{hue:[lo,hi], sat, lum, soft, invert}, window?:{type: circle|rect|linear|polygon, x, y, w, h, rotation, softness, invert}}, after?, parallel?}',
  '- node_update {id, node, set}  - node_delete {id, node}  - node_link {id, from, to, input}  - node_unlink {id, to, input}  - nodes_reset {id}',
  '- make_multicam {srcs, offsets?, labels?, track, start}  - multicam_cut {id, at, angle}',
  '- add_caption {text, start, dur, track?}  - captions {items:[{t, end, text}], track?, replace?}  (caption tracks draw when burnIn is true)',
].join('\n')

// ---------------------------------------------------------------- v3: compositions, motion, nodes, multicam, captions

const DEFAULT_SHAPE = { type: 'rect', width: 480, height: 270, radius: 24, fill: { color: '#f5b942' } }

/** The graph a clip renders through when it has none: its source, its primary grade, out. */
export function defaultNodes() {
  return {
    list: [
      { id: 'n1', type: 'source', x: 0, y: 0 },
      { id: 'n2', type: 'primary', x: 160, y: 0 },
      { id: 'n3', type: 'output', x: 320, y: 0 },
    ],
    links: [
      { from: 'n1', to: 'n2', input: 0 },
      { from: 'n2', to: 'n3', input: 0 },
    ],
  }
}

/** Node graph layout grid, in graph units (node x, y are the box's top-left). */
export const NODE_COL = 160
export const NODE_ROW = 84

/**
 * Lays the graph out left to right: a node's column is its longest path from a root,
 * the main chain (each node's first input, back from the output) holds row 0, other
 * inputs open rows below. Returns Map id → { x, y }.
 */
export function layoutNodes(graph) {
  const ids = graph.list.map(n => n.id)
  const inputs = id => graph.links.filter(l => l.to === id && ids.includes(l.from)).sort((a, b) => (a.input ?? 0) - (b.input ?? 0)).map(l => l.from)
  // Columns: longest path from any root, over every node (dangling ones too).
  const depth = new Map()
  const visiting = new Set()
  const depthOf = id => {
    if (depth.has(id)) return depth.get(id)
    if (visiting.has(id)) return 0
    visiting.add(id)
    const d = Math.max(-1, ...inputs(id).map(depthOf)) + 1
    visiting.delete(id)
    depth.set(id, d)

    return d
  }
  ids.forEach(depthOf)
  // Rows: walk back from the output; input 0 keeps the row, other inputs open new rows.
  const row = new Map()
  let nextRow = 1
  const assign = (id, r) => {
    if (row.has(id)) return
    row.set(id, r)
    inputs(id).forEach((from, i) => assign(from, i === 0 ? r : nextRow++))
  }
  const out = graph.list.find(n => n.type === 'output')
  if (out) assign(out.id, 0)
  // Unreachable nodes: their own chains, below everything else.
  for (const n of [...graph.list].sort((a, b) => depth.get(b.id) - depth.get(a.id))) if (!row.has(n.id)) assign(n.id, nextRow++)
  // Resolve collisions in a cell by pushing down.
  const taken = new Set()
  const pos = new Map()
  for (const n of [...graph.list].sort((a, b) => depth.get(a.id) - depth.get(b.id) || row.get(a.id) - row.get(b.id))) {
    const col = depth.get(n.id)
    let r = row.get(n.id)
    while (taken.has(`${col}:${r}`)) r++
    taken.add(`${col}:${r}`)
    pos.set(n.id, { x: col * NODE_COL, y: r * NODE_ROW })
  }

  return pos
}

/** Nodes in evaluation order (inputs before the nodes that read them); throws on a cycle. */
export function nodeOrder(graph) {
  const byId = new Map(graph.list.map(n => [n.id, n]))
  const order = []
  const state = new Map()
  const visit = id => {
    if (state.get(id) === 2) return
    if (state.get(id) === 1) throw new Error('the node graph has a loop')
    state.set(id, 1)
    for (const l of graph.links) if (l.to === id && byId.has(l.from)) visit(l.from)
    state.set(id, 2)
    order.push(byId.get(id))
  }
  const out = graph.list.find(n => n.type === 'output')
  if (!out) throw new Error('the node graph has no output')
  visit(out.id)

  return order
}

function nodeIdFor(graph) {
  let max = 0
  for (const n of graph.list) max = Math.max(max, Number(String(n.id).slice(1)) || 0)

  return `n${max + 1}`
}

const SHAPE_DEFAULTS = {
  rect: { width: 480, height: 270, radius: 0 },
  ellipse: { width: 320, height: 320 },
  polygon: { sides: 6, radius: 180 },
  star: { points: 5, radius: 200, innerRadius: 90 },
  line: { width: 600, height: 0 },
  path: { path: { closed: true, vertices: [[-100, -100], [100, -100], [0, 120]] } },
}

function applyMotionOp(p, op, ctx) {
  const { log, created, clipOf, minDur } = ctx
  const videoTrack = dur => visualCreationTrack(p, op.track, true, { start: snapToFrame(Math.max(0, op.start ?? 0), p.fps), dur })
  const timeOf = () => snapToFrame(Math.max(0, op.start ?? 0), p.fps)
  switch (op.op) {
    // compositions (After Effects precomps, Final Cut compound clips)
    case 'add_comp': {
      const id = nextId(p, 'k')
      p.comps[id] = {
        id,
        name: op.name ?? `Comp ${Object.keys(p.comps).length + 1}`,
        width: op.width ?? p.width,
        height: op.height ?? p.height,
        fps: op.fps ?? p.fps,
        ...(op.duration ? { duration: op.duration } : {}),
        background: op.background ?? 'transparent',
        markers: [],
        tracks: [
          { id: 'V1', kind: 'video', name: 'Layer 1', clips: [] },
          { id: 'V2', kind: 'video', name: 'Layer 2', clips: [] },
          { id: 'V3', kind: 'video', name: 'Layer 3', clips: [] },
          { id: 'A1', kind: 'audio', name: 'Audio', volume: 0, pan: 0, clips: [] },
        ],
      }
      created.push(id)
      log.push(`new composition ${id} "${p.comps[id].name}"`)

      return true
    }
    case 'update_comp': {
      const comp = p.comps[op.target]
      if (!comp) throw new Error(`no composition ${op.target}`)
      const { tracks: _t, id: _i, ...set } = op.set ?? {}
      deepMerge(comp, set)
      log.push(`updated composition ${op.target}`)

      return true
    }
    case 'delete_comp': {
      const users = [...(p.__rootTracks ?? p.tracks), ...Object.values(p.comps).flatMap(k => k.tracks)].flatMap(t => t.clips).filter(c => c.kind === 'comp' && c.comp === op.target)
      if (users.length) throw new Error(`composition ${op.target} is used by ${users.map(c => c.id).join(', ')}`)
      delete p.comps[op.target]
      log.push(`deleted composition ${op.target}`)

      return true
    }
    case 'comp_clip': {
      const comp = p.comps[op.target]
      if (!comp) throw new Error(`no composition ${op.target}`)
      const here = p.compId ?? (p.__rootTracks ? Object.keys(p.comps).find(k => p.comps[k].tracks === p.tracks) : null)
      if (here && compContains(p, op.target, here)) throw new Error('a composition cannot contain itself')
      const track = videoTrack(op.dur ?? compDuration(comp))
      const id = nextId(p, 'c')
      track.clips.push({ id, kind: 'comp', comp: op.target, start: timeOf(), dur: snapToFrame(op.dur ?? compDuration(comp), p.fps), in: 0, label: comp.name, ...(op.set ?? {}) })
      sortTrack(track)
      created.push(id)
      log.push(`placed composition ${op.target} as ${id}`)

      return true
    }
    case 'precompose': {
      const picks = op.ids.map(id => clipOf(id))
      const t0 = Math.min(...picks.map(x => x.clip.start))
      const t1 = Math.max(...picks.map(x => clipEnd(x.clip)))
      const id = nextId(p, 'k')
      const tracks = []
      for (const { track, clip } of picks) {
        let tt = tracks.find(x => x.id === track.id)
        if (!tt) {
          tt = { id: track.id, kind: track.kind, name: track.name, clips: [] }
          tracks.push(tt)
        }
        track.clips = track.clips.filter(c => c !== clip)
        tt.clips.push({ ...clip, start: round(clip.start - t0) })
      }
      const order = p.tracks.map(t => t.id)
      tracks.sort((a, b) => order.indexOf(a) - order.indexOf(b))
      p.comps[id] = { id, name: op.name ?? 'Precomp', width: p.width, height: p.height, fps: p.fps, duration: round(t1 - t0), background: 'transparent', markers: [], tracks }
      const host = picks.filter(x => x.track.kind === 'video').map(x => x.track).sort((a, b) => order.indexOf(b.id) - order.indexOf(a.id))[0] ?? picks[0].track
      const clipId = nextId(p, 'c')
      host.clips.push({ id: clipId, kind: 'comp', comp: id, start: round(t0), dur: round(t1 - t0), in: 0, label: p.comps[id].name })
      sortTrack(host)
      created.push(id, clipId)
      log.push(`precomposed ${op.ids.join(', ')} into ${id} (${clipId})`)

      return true
    }
    // motion layers
    case 'add_shape': {
      const track = videoTrack(Math.max(minDur, op.dur ?? 5))
      const id = nextId(p, 'c')
      const type = op.shape?.type ?? 'rect'
      const shape = { ...structuredClone(DEFAULT_SHAPE), ...SHAPE_DEFAULTS[type], ...structuredClone(op.shape ?? {}), type }
      track.clips.push({ id, kind: 'shape', start: timeOf(), dur: snapToFrame(Math.max(minDur, op.dur ?? 5), p.fps), shape, label: op.name ?? `${type[0].toUpperCase()}${type.slice(1)}`, ...structuredClone(op.set ?? {}) })
      sortTrack(track)
      created.push(id)
      log.push(`added ${type} shape ${id}`)

      return true
    }
    case 'add_null': {
      const track = videoTrack(Math.max(minDur, op.dur ?? 10))
      const id = nextId(p, 'c')
      track.clips.push({ id, kind: 'null', start: timeOf(), dur: snapToFrame(Math.max(minDur, op.dur ?? 10), p.fps), label: op.name ?? 'Null', ...structuredClone(op.set ?? {}) })
      sortTrack(track)
      created.push(id)
      log.push(`added null ${id}`)

      return true
    }
    case 'add_mask': {
      const { clip } = clipOf(op.id)
      clip.masks ??= []
      const id = `mk${clip.masks.reduce((m, x) => Math.max(m, Number(String(x.id).slice(2)) || 0), 0) + 1}`
      clip.masks.push({ id, type: 'rect', mode: 'add', feather: 0, expansion: 0, opacity: 1, inverted: false, ...structuredClone(op.mask ?? {}) })
      created.push(id)
      log.push(`added mask ${id} to ${op.id}`)

      return true
    }
    case 'update_mask': {
      const { clip } = clipOf(op.id)
      const m = clip.masks?.find(x => x.id === op.mask)
      if (!m) throw new Error(`no mask ${op.mask} on ${op.id}`)
      deepMerge(m, op.set ?? {})
      log.push(`updated mask ${op.mask} on ${op.id}`)

      return true
    }
    case 'delete_mask': {
      const { clip } = clipOf(op.id)
      clip.masks = (clip.masks ?? []).filter(x => x.id !== op.mask)
      if (!clip.masks.length) delete clip.masks
      log.push(`deleted mask ${op.mask} on ${op.id}`)

      return true
    }
    case 'matte': {
      const { clip } = clipOf(op.id)
      if (op.matte === null) delete clip.matte
      else {
        const mode = op.matte?.mode ?? 'alpha'
        if (!MATTE_MODES.includes(mode)) throw new Error(`matte mode must be one of ${MATTE_MODES.join(', ')}`)
        clip.matte = { mode, ...(op.matte?.source ? { source: op.matte.source } : {}) }
      }
      log.push(op.matte === null ? `removed matte on ${op.id}` : `matte ${clip.matte.mode} on ${op.id}`)

      return true
    }
    case 'parent': {
      const { clip } = clipOf(op.id)
      if (op.parent === null) {
        delete clip.parent
        delete clip.parentRef
        log.push(`unparented ${op.id}`)

        return true
      }
      const target = findClip(p, op.parent)
      if (!target) throw new Error(`no clip ${op.parent}`)
      for (let cur = target.clip, n = 0; cur; cur = cur.parent ? findClip(p, cur.parent)?.clip : null, n++) {
        if (cur.id === clip.id || n > 64) throw new Error('parenting would make a loop')
      }
      clip.parent = op.parent
      // Remember the parent's transform now: the child follows the parent's motion
      // relative to this pose, so parenting never makes the child jump.
      const pc = target.clip
      const local = Math.max(0, Math.min(pc.dur, (op.at ?? pc.start) - pc.start))
      clip.parentRef = Object.fromEntries(['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'anchorX', 'anchorY'].map(k => [k, round(valueAt(p, pc, k, local), 4)]))
      log.push(`parented ${op.id} to ${op.parent}`)

      return true
    }
    case 'expression': {
      const ids = Array.isArray(op.ids) ? op.ids : [op.id]
      for (const id of ids) {
        const { clip } = clipOf(id)
        if (op.expr === null || op.expr === '') {
          delete clip.expr?.[op.prop]
          if (clip.expr && !Object.keys(clip.expr).length) delete clip.expr
        } else {
          const err = checkExpr(op.expr)
          if (err) throw new Error(`expression error: ${err}`)
          ;(clip.expr ??= {})[op.prop] = op.expr
        }
      }
      log.push(op.expr ? `expression on ${ids.join(', ')}.${op.prop}: ${op.expr}` : `removed expression on ${ids.join(', ')}.${op.prop}`)

      return true
    }
    // node graphs (Resolve color nodes, Fusion-style compositing)
    case 'node_add': {
      const { clip } = clipOf(op.id)
      const g = (clip.nodes ??= defaultNodes())
      const type = op.node?.type ?? 'corrector'
      if (!NODE_TYPES.includes(type) || type === 'source' || type === 'output') throw new Error(`node type must be one of ${NODE_TYPES.filter(t => t !== 'source' && t !== 'output').join(', ')}`)
      const id = nodeIdFor(g)
      const node = { ...structuredClone(op.node ?? {}), id, type }
      const out = g.list.find(n => n.type === 'output')
      const afterId = op.after ?? g.links.find(l => l.to === out.id)?.from
      const after = g.list.find(n => n.id === afterId) ?? out
      const placed = Number.isFinite(node.x) && Number.isFinite(node.y)
      if (!placed) { node.x = (after.x ?? 0) + 80; node.y = after.y ?? 0 }
      g.list.push(node)
      if (op.parallel) {
        // Feed the new node from the same input as `after`, unlinked: the caller wires it into a mixer.
        g.links.push({ from: g.links.find(l => l.to === afterId)?.from ?? 'n1', to: id, input: 0 })
      } else {
        // Serial insert: after → node → whatever after fed.
        for (const l of g.links) if (l.from === afterId) l.from = id
        g.links.push({ from: afterId, to: id, input: 0 })
      }
      nodeOrder(g)
      // A node without a position gets the tidy left-to-right layout the Color page uses, so a
      // second corrector never lands on top of the first or of the output.
      if (!placed) for (const [nid, pos] of layoutNodes(g)) Object.assign(g.list.find(n => n.id === nid), pos)
      created.push(id)
      log.push(`added ${type} node ${id} to ${op.id}`)

      return true
    }
    case 'node_update': {
      const { clip } = clipOf(op.id)
      const n = clip.nodes?.list.find(x => x.id === op.node)
      if (!n) throw new Error(`no node ${op.node} on ${op.id}`)
      const { id: _i, type: _t, ...set } = op.set ?? {}
      deepMerge(n, set)
      log.push(`updated node ${op.node} on ${op.id}`)

      return true
    }
    case 'node_delete': {
      const { clip } = clipOf(op.id)
      const g = clip.nodes
      const n = g?.list.find(x => x.id === op.node)
      if (!n) throw new Error(`no node ${op.node} on ${op.id}`)
      if (n.type === 'source' || n.type === 'output') throw new Error('the source and output nodes stay')
      const feed = g.links.find(l => l.to === n.id && l.input === 0)?.from
      g.links = g.links.filter(l => l.to !== n.id)
      for (const l of g.links) if (l.from === n.id) l.from = feed ?? 'n1'
      g.list = g.list.filter(x => x !== n)
      log.push(`deleted node ${op.node} on ${op.id}`)

      return true
    }
    case 'node_link': {
      const { clip } = clipOf(op.id)
      const g = (clip.nodes ??= defaultNodes())
      for (const nid of [op.from, op.to]) if (!g.list.some(x => x.id === nid)) throw new Error(`no node ${nid}`)
      const input = op.input ?? 0
      g.links = g.links.filter(l => !(l.to === op.to && l.input === input))
      g.links.push({ from: op.from, to: op.to, input })
      nodeOrder(g)
      log.push(`linked ${op.from} → ${op.to}[${input}] on ${op.id}`)

      return true
    }
    case 'node_unlink': {
      const { clip } = clipOf(op.id)
      if (clip.nodes) clip.nodes.links = clip.nodes.links.filter(l => !(l.to === op.to && l.input === (op.input ?? 0)))
      log.push(`unlinked ${op.to}[${op.input ?? 0}] on ${op.id}`)

      return true
    }
    case 'nodes_reset': {
      const { clip } = clipOf(op.id)
      delete clip.nodes
      log.push(`reset nodes on ${op.id}`)

      return true
    }
    // multicam (angles synced by offset; cuts choose the angle over time)
    case 'make_multicam': {
      const srcs = op.srcs ?? []
      if (srcs.length < 2) throw new Error('a multicam clip needs at least two angles')
      for (const src of srcs) if (!p.assets[src]) throw new Error(`import ${src} first`)
      const offsets = op.offsets ?? srcs.map(() => 0)
      const angles = srcs.map((src, i) => ({ src, offset: offsets[i] ?? 0, label: op.labels?.[i] ?? `Angle ${i + 1}` }))
      const dur = Math.min(...angles.map(a => (p.assets[a.src].duration ?? 10) - a.offset))
      const track = videoTrack(Math.max(minDur, op.dur ?? dur))
      const id = nextId(p, 'c')
      track.clips.push({ id, kind: 'multicam', angles, cuts: [{ t: 0, angle: 0 }], audioAngle: op.audioAngle ?? 0, start: timeOf(), dur: snapToFrame(Math.max(minDur, op.dur ?? dur), p.fps), in: 0, label: op.name ?? 'Multicam' })
      sortTrack(track)
      created.push(id)
      log.push(`multicam ${id} with ${angles.length} angles`)

      return true
    }
    case 'multicam_cut': {
      const { clip } = clipOf(op.id)
      if (clip.kind !== 'multicam') throw new Error(`${op.id} is not a multicam clip`)
      const t = snapToFrame((op.local ? op.at : op.at - clip.start) + (clip.in ?? 0), p.fps)
      if (op.angle < 0 || op.angle >= clip.angles.length) throw new Error(`angle must be 0–${clip.angles.length - 1}`)
      clip.cuts = [...clip.cuts.filter(c => Math.abs(c.t - t) > 1e-4), { t, angle: op.angle }].sort((a, b) => a.t - b.t)
      // Drop cuts that switch to the angle already showing.
      clip.cuts = clip.cuts.filter((c, i, all) => i === 0 || c.angle !== all[i - 1].angle)
      log.push(`cut ${op.id} to angle ${op.angle + 1} at ${round(t, 3)}s`)

      return true
    }
    // captions
    case 'add_caption':
    case 'captions': {
      let track = p.tracks.find(t => t.kind === 'caption' && (!op.track || t.id === op.track))
      if (!track) {
        track = { id: op.track ?? 'C1', kind: 'caption', name: 'Captions', burnIn: false, style: { font: 'Helvetica Neue', size: 52, color: '#ffffff', plate: '#000000aa', y: 0.88 }, clips: [] }
        p.tracks.push(track)
      }
      if (op.style) deepMerge(track.style, op.style)
      if (op.burnIn !== undefined) track.burnIn = Boolean(op.burnIn)
      const items = op.op === 'add_caption' ? [{ t: op.start ?? 0, end: (op.start ?? 0) + (op.dur ?? 2), text: op.text ?? '' }] : op.items ?? []
      if (op.replace) track.clips = []
      for (const it of items) {
        const id = nextId(p, 'c')
        const start = snapToFrame(it.t, p.fps)
        const words = Array.isArray(it.words) ? it.words.map(w => ({ ...structuredClone(w), t: round(w.t - start), end: round(w.end - start) })) : undefined
        track.clips.push({ id, kind: 'caption', text: String(it.text ?? ''), start, dur: snapToFrame(Math.max(minDur, (it.end ?? it.t + 2) - it.t), p.fps), ...(words ? { words } : {}), ...(it.source ? { source: structuredClone(it.source) } : {}), ...(it.style ? { style: structuredClone(it.style) } : {}) })
        created.push(id)
      }
      sortTrack(track)
      log.push(`${items.length} caption${items.length === 1 ? '' : 's'} on ${track.id}`)

      return true
    }
  }

  return false
}
