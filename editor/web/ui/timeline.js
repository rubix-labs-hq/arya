// The timeline: a canvas of tracks with filmstrips, waveforms, fades, transitions and
// keyframes, plus every edit gesture (select, move, trim, roll, slip, slide, blade).

import { h } from 'preact'
import { host } from '../host.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { applyOps, clipEnd, duration, hasAudio, snapToFrame, timecode, MARKER_COLORS } from '/core/project.js'
import { addRef, api, edit, onTime, set, store, subscribe, time, toast, useStore, useTime, viewProject } from './store.js'
import { openMenu } from './menu.js'
import { player } from './engine-host.js'
import { registry } from './registry.js'
import { mediaDisplayName } from './media-label.js'
import { titlePresetOp } from './title-presets.js'

const html = htm.bind(h)

const RULER = 30
const HEADER = 168
// Default row heights. A track with no clips stays short until something lands on it,
// so empty lanes do not take the room the clips need. Taller and Shorter still win.
const TRACK_HEIGHT = { video: 66, audio: 54, caption: 40, empty: 34 }
const coarsePointer = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null
const KIND = {
  video: ['#3a63c7', '#2d4f9f'],
  image: ['#2a8f8f', '#1f6b6b'],
  title: ['#8c55cc', '#6c3fa3'],
  color: ['#5d5d6b', '#4a4a56'],
  adjustment: ['#7a6a3a', '#5e5230'],
  audio: ['#2b8f62', '#1f6d4a'],
  caption: ['#56607a', '#3f475c'],
}

// ---------------------------------------------------------------- media caches

const strips = new Map()
const peaks = new Map()
let redraw = () => {}

// A failed filmstrip or waveform request is retried after a growing, jittered delay. The
// server answers 429 while busy, so that keeps retrying; any other failure, such as missing
// media, stops after five attempts instead of probing the source all session.
function due(entry) {
  return entry?.retryAt !== undefined && Date.now() >= entry.retryAt
}

function retryLater(entry, error) {
  // A busy server backs off on its own count, so a long export cannot use up the failure budget.
  const busy = error?.status === 429
  if (busy) entry.busy = (entry.busy ?? 0) + 1
  else entry.failures = (entry.failures ?? 0) + 1
  if (entry.failures > 5) return
  const attempts = busy ? entry.busy : entry.failures
  const delay = Math.min(busy ? 30000 : 60000, 2000 * 2 ** Math.max(0, attempts - 1)) * (0.75 + Math.random() / 2)
  entry.retryAt = Date.now() + delay
  setTimeout(() => redraw(), delay)
}

function strip(src) {
  const key = host.kind === 'browser-local' ? `${store.root}:${host.browser.generation}:${src}` : src
  if (!strips.has(key) || due(strips.get(key))) {
    const entry = { meta: null, img: null, failures: strips.get(key)?.failures, busy: strips.get(key)?.busy }
    strips.set(key, entry)
    api(`/api/strip?src=${encodeURIComponent(src)}`)
      .then(meta => {
        if (meta.error) return retryLater(entry)
        entry.meta = meta
        const img = new Image()
        img.onload = () => {
          entry.img = img
          redraw()
        }
        img.src = meta.url
      })
      .catch(error => retryLater(entry, error))
  }

  return strips.get(key)
}

function peaksOf(src) {
  const key = host.kind === 'browser-local' ? `${store.root}:${host.browser.generation}:${src}` : src
  if (!peaks.has(key) || due(peaks.get(key))) {
    const entry = { data: null, failures: peaks.get(key)?.failures, busy: peaks.get(key)?.busy }
    peaks.set(key, entry)
    api(`/api/peaks?src=${encodeURIComponent(src)}`)
      .then(d => {
        if (!d.peaks) return retryLater(entry)
        entry.data = new Uint8Array(d.peaks)
        entry.perSec = d.perSec
        redraw()
      })
      .catch(error => retryLater(entry, error))
  }

  return peaks.get(key)
}

// ---------------------------------------------------------------- layout

/** The default height of a track: compact while the committed project has no clips on it. */
function defaultTrackHeight(t, committed) {
  const empty = !(committed?.get(t.id) ?? t).clips.length
  return empty ? TRACK_HEIGHT.empty : t.kind === 'video' ? TRACK_HEIGHT.video : t.kind === 'caption' ? TRACK_HEIGHT.caption : TRACK_HEIGHT.audio
}

export function rowsOf(p) {
  // Caption tracks sit above the picture, like Final Cut's captions lane and Resolve's subtitle tracks.
  const captions = p.tracks.filter(t => t.kind === 'caption')
  const video = p.tracks.filter(t => t.kind === 'video').reverse()
  const audio = p.tracks.filter(t => t.kind === 'audio')
  // A drag preview moves clips between tracks. Emptiness comes from the committed project, so
  // drawn lanes stay aligned with the headers and the drop hit test until the edit lands.
  const committed = new Map((viewProject()?.tracks ?? []).map(t => [t.id, t]))
  const rows = []
  let y = RULER
  for (const t of [...captions, ...video, ...audio]) {
    const preferred = store.trackHeight[t.id] ?? defaultTrackHeight(t, committed)
    const hgt = coarsePointer?.matches ? Math.max(70, preferred) : preferred
    rows.push({ track: t, y, h: hgt })
    y += hgt + 2
  }

  return { rows, height: y + 40 }
}

const tx = t => (t - store.scroll) * store.zoom
const xt = x => x / store.zoom + store.scroll

function snapPoints(p, exclude) {
  const pts = [0, time.t, ...p.markers.map(m => m.t)]
  if (p.range) pts.push(p.range.in, p.range.out)
  for (const t of p.tracks) for (const c of t.clips) if (!exclude.has(c.id)) pts.push(c.start, clipEnd(c))

  return pts
}

function snap(p, t, exclude, enabled = store.snapping) {
  if (!enabled) return { t: snapToFrame(t, p.fps), line: null }
  let best = null
  let bestPx = 9
  for (const s of snapPoints(p, exclude)) {
    const d = Math.abs(s - t) * store.zoom
    if (d < bestPx) {
      bestPx = d
      best = s
    }
  }

  return best === null ? { t: snapToFrame(t, p.fps), line: null } : { t: best, line: best }
}

// ---------------------------------------------------------------- drawing

function roundRect(ctx, x, y, w, hgt, r) {
  ctx.beginPath()
  ctx.roundRect(x, y, Math.max(1, w), hgt, Math.min(r, w / 2))
}

function drawClip(ctx, p, c, row, state) {
  const x = tx(c.start)
  const w = c.dur * store.zoom
  const y = row.y + 2
  const hgt = row.h - 4
  if (x > state.width || x + w < 0) return
  const sel = store.selection.includes(c.id)
  const [top, body] = KIND[c.kind] ?? KIND.video
  const disabled = c.enabled === false || row.track.muted || row.track.hidden
  ctx.save()
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, hgt - 1, 5)
  ctx.fillStyle = disabled ? '#33333b' : body
  ctx.fill()
  ctx.clip()
  // Filmstrip / waveform.
  const labelH = 17
  if ((c.kind === 'video' || c.kind === 'image') && hgt > 30) {
    const s = strip(c.src)
    if (s.img && s.meta) {
      const th = hgt - labelH
      const tw = (s.meta.w / s.meta.h) * th
      for (let px = Math.max(x, x - ((x % tw) + tw) % tw); px < Math.min(x + w, state.width); px += tw) {
        const srcT = (c.in ?? 0) + ((px - x) / store.zoom) * (c.speed ?? 1)
        const idx = s.meta.count === 1 ? 0 : Math.max(0, Math.min(s.meta.count - 1, Math.floor(srcT / (s.meta.interval || 1))))
        ctx.globalAlpha = disabled ? 0.35 : 0.92
        ctx.drawImage(s.img, idx * s.meta.w, 0, s.meta.w, s.meta.h, px, y + labelH, tw, th)
      }
      ctx.globalAlpha = 1
    }
  }
  // A title's label bar already shows its text; the body repeats it only under a custom clip name.
  const titleText = c.kind === 'title' ? String(c.title?.text ?? '').split('\n')[0] : ''
  if (c.kind === 'title' && c.label && c.label !== titleText) {
    ctx.fillStyle = '#ffffffcc'
    ctx.font = '600 13px -apple-system, sans-serif'
    ctx.fillText(titleText, x + 8, y + labelH + 18)
  }
  if (c.kind === 'audio') {
    const pk = peaksOf(c.src)
    if (pk.data) {
      const mid = y + labelH + (hgt - labelH) / 2
      const amp = (hgt - labelH) / 2 - 2
      const gain = 10 ** ((c.volume ?? 0) / 20)
      ctx.fillStyle = disabled ? '#6b6b75' : '#9df0c8'
      const x0 = Math.max(x, 0)
      const x1 = Math.min(x + w, state.width)
      for (let px = x0; px < x1; px += 1) {
        const t0 = (c.in ?? 0) + ((px - x) / store.zoom) * (c.speed ?? 1)
        const t1 = t0 + (c.speed ?? 1) / store.zoom
        let m = 0
        for (let i = Math.floor(t0 * pk.perSec); i <= Math.floor(t1 * pk.perSec); i++) m = Math.max(m, pk.data[i] ?? 0)
        const local = (px - x) / store.zoom
        let f = 1
        if (c.fadeIn && local < c.fadeIn) f = local / c.fadeIn
        if (c.fadeOut && local > c.dur - c.fadeOut) f = (c.dur - local) / c.fadeOut
        const v = Math.min(1, Math.sqrt((m / 255) * gain * f)) * amp
        ctx.fillRect(px, mid - v, 1, v * 2 || 1)
      }
    }
  }
  // Label bar.
  ctx.fillStyle = disabled ? '#2a2a31' : top
  ctx.fillRect(x, y, w, labelH)
  ctx.fillStyle = disabled ? '#88889a' : '#fff'
  ctx.font = '600 11px -apple-system, sans-serif'
  const label = c.kind === 'title' ? `T  ${c.label ?? titleText}` : c.label ?? (c.kind === 'caption' ? String(c.text ?? '').replace(/\s+/g, ' ') : c.kind === 'color' ? 'Color' : c.kind === 'adjustment' ? 'Adjustment' : mediaDisplayName(c.src, p.assets?.[c.src]))
  const badges = [c.speed && c.speed !== 1 ? `${c.speed}x` : '', c.reverse ? '⟲' : '', c.effects?.length ? 'fx' : '', c.grade ? '◐' : ''].filter(Boolean).join(' ')
  const text = `${label ?? ''}${badges ? `  ${badges}` : ''}`
  ctx.fillText(text, Math.max(x, 0) + 6, y + 12)
  // Linked audio and video: two interlocked links, stroked like the interface icons.
  if (c.link) {
    const lx = Math.max(x, 0) + 6 + (ctx.measureText(text)?.width ?? 0) + 7, ly = y + 8.5
    ctx.strokeStyle = disabled ? '#88889a' : '#ffffffcc'
    ctx.lineWidth = 1.25
    for (const dx of [0, 5]) {
      ctx.beginPath()
      ctx.roundRect?.(lx + dx, ly - 2.5, 7, 5, 2.5)
      ctx.stroke()
    }
  }
  // Fades.
  const fadePath = (fx, fw, left) => {
    ctx.beginPath()
    if (left) {
      ctx.moveTo(fx, y + hgt)
      ctx.lineTo(fx + fw, y)
      ctx.lineTo(fx, y)
    } else {
      ctx.moveTo(fx + fw, y + hgt)
      ctx.lineTo(fx, y)
      ctx.lineTo(fx + fw, y)
    }
    ctx.closePath()
    ctx.fillStyle = '#00000066'
    ctx.fill()
  }
  if (c.fadeIn) fadePath(x, c.fadeIn * store.zoom, true)
  if (c.fadeOut) fadePath(x + w - c.fadeOut * store.zoom, c.fadeOut * store.zoom, false)
  // Keyframes.
  if (c.anim) {
    const keys = new Set(Object.values(c.anim).flatMap(k => k.map(kk => kk[0])))
    ctx.fillStyle = '#ffd84d'
    for (const k of keys) {
      const kx = x + k * store.zoom
      ctx.save()
      ctx.translate(kx, y + hgt - 7)
      ctx.rotate(Math.PI / 4)
      ctx.fillRect(-3, -3, 6, 6)
      ctx.restore()
    }
  }
  if (disabled) {
    ctx.strokeStyle = '#ffffff10'
    for (let i = x - hgt; i < x + w; i += 8) {
      ctx.beginPath()
      ctx.moveTo(i, y + hgt)
      ctx.lineTo(i + hgt, y)
      ctx.stroke()
    }
  }
  ctx.restore()
  // Fade handles (hover affordance).
  if (state.hover?.clip === c && w > 30) {
    ctx.fillStyle = '#fff'
    for (const hx of [x + (c.fadeIn ?? 0) * store.zoom, x + w - (c.fadeOut ?? 0) * store.zoom]) {
      ctx.beginPath()
      ctx.arc(hx, y + 3, 4, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  // Selection and Claude highlight.
  const hl = store.highlight.get(c.id)
  const age = hl ? (performance.now() - hl) / 2500 : 1
  if (age < 1) {
    roundRect(ctx, x - 1, y - 1, w + 2, hgt + 2, 6)
    ctx.strokeStyle = `rgba(214, 140, 255, ${1 - age})`
    ctx.lineWidth = 3
    ctx.stroke()
    state.animating = true
  }
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, hgt - 1, 5)
  ctx.strokeStyle = sel ? '#f5b942' : '#00000080'
  ctx.lineWidth = sel ? 2 : 1
  ctx.stroke()
  // Transition into this clip.
  if (c.transitionIn) {
    const d = c.transitionIn.dur * store.zoom
    const cx = x
    ctx.save()
    const tsel = store.selection.includes(`tr:${c.id}`)
    ctx.fillStyle = tsel ? '#f5b942dd' : '#ffffffcc'
    ctx.beginPath()
    ctx.moveTo(cx - d / 2, y + 2)
    ctx.lineTo(cx + d / 2, y + hgt - 2)
    ctx.lineTo(cx + d / 2, y + 2)
    ctx.lineTo(cx - d / 2, y + hgt - 2)
    ctx.closePath()
    ctx.globalAlpha = 0.35
    ctx.fill()
    ctx.globalAlpha = 1
    roundRect(ctx, cx - d / 2, y + hgt / 2 - 8, d, 16, 4)
    ctx.fill()
    ctx.fillStyle = '#111'
    ctx.font = '600 10px -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(d > 70 ? c.transitionIn.type.replace(/([A-Z])/g, ' $1').toLowerCase() : '⨯', cx, y + hgt / 2 + 4)
    ctx.restore()
  }
}

function drawRuler(ctx, p, state) {
  ctx.fillStyle = '#1b1b20'
  ctx.fillRect(0, 0, state.width, RULER)
  const steps = [1 / p.fps, 2 / p.fps, 5 / p.fps, 10 / p.fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const major = steps.find(s => s * store.zoom >= 90) ?? 600
  const minor = steps.filter(s => s < major).reverse().find(s => s * store.zoom >= 10 && Math.abs(major / s - Math.round(major / s)) < 1e-6)
  ctx.font = '10px ui-monospace, Menlo, monospace'
  ctx.textBaseline = 'top'
  const t0 = Math.floor(store.scroll / (minor ?? major)) * (minor ?? major)
  for (let t = t0; tx(t) < state.width; t += minor ?? major) {
    const x = Math.round(tx(t)) + 0.5
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6
    ctx.strokeStyle = isMajor ? '#6a6a78' : '#3c3c46'
    ctx.beginPath()
    ctx.moveTo(x, isMajor ? 12 : 20)
    ctx.lineTo(x, RULER)
    ctx.stroke()
    if (isMajor) {
      ctx.fillStyle = '#9a9aa8'
      ctx.fillText(major < 1 ? timecode(t, p.fps) : timecode(t, p.fps).slice(major >= 60 ? 0 : 3, 8), x + 3, 3)
    }
  }
  if (p.range) {
    const x0 = tx(p.range.in)
    const x1 = tx(p.range.out)
    ctx.fillStyle = '#f5b94233'
    ctx.fillRect(x0, 0, x1 - x0, RULER)
    ctx.fillStyle = '#f5b942'
    ctx.fillRect(x0, 0, 2, RULER)
    ctx.fillRect(x1 - 2, 0, 2, RULER)
  }
  for (const m of p.markers) {
    const x = tx(m.t)
    if (x < -10 || x > state.width + 10) continue
    ctx.fillStyle = m.color ?? MARKER_COLORS[0]
    ctx.beginPath()
    if (m.kind === 'chapter') {
      ctx.moveTo(x - 5, RULER - 14)
      ctx.lineTo(x + 5, RULER - 14)
      ctx.lineTo(x + 5, RULER - 6)
      ctx.lineTo(x, RULER - 2)
      ctx.lineTo(x - 5, RULER - 6)
    } else {
      ctx.moveTo(x, RULER - 14)
      ctx.lineTo(x + 5, RULER - 8)
      ctx.lineTo(x, RULER - 2)
      ctx.lineTo(x - 5, RULER - 8)
    }
    ctx.fill()
    if (store.selMarker === m.id) {
      ctx.strokeStyle = '#fff'
      ctx.stroke()
    }
    if (m.label && store.zoom > 25) {
      ctx.fillStyle = '#d8d8e0'
      ctx.fillText(m.label, x + 7, RULER - 15)
    }
  }
}

function drawAll(canvas, state) {
  const p = state.preview ?? viewProject()
  const ctx = canvas.getContext('2d')
  const dpr = devicePixelRatio
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  // The ruler leaves textBaseline at 'top'; reset it so clip labels sit in their label bars on every frame.
  ctx.textBaseline = 'alphabetic'
  state.animating = false
  ctx.fillStyle = '#121216'
  ctx.fillRect(0, 0, state.width, state.height)
  if (!p) return
  const { rows } = rowsOf(p)
  ctx.save()
  ctx.translate(0, -state.scrollY)
  for (const row of rows) {
    ctx.fillStyle = row.track.kind === 'audio' ? '#15191a' : '#16161b'
    ctx.fillRect(0, row.y, state.width, row.h)
    if (store.selTrack === row.track.id) {
      ctx.fillStyle = '#ffffff08'
      ctx.fillRect(0, row.y, state.width, row.h)
    }
  }
  // Past-the-end shade.
  const end = tx(duration(p))
  ctx.fillStyle = '#00000040'
  ctx.fillRect(Math.max(0, end), RULER, state.width, state.height)
  for (const row of rows) for (const c of row.track.clips) drawClip(ctx, p, c, row, state)
  if (state.marquee) {
    const m = state.marquee
    ctx.fillStyle = '#f5b94218'
    ctx.strokeStyle = '#f5b942aa'
    ctx.fillRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0))
    ctx.strokeRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0))
  }
  ctx.restore()
  drawRuler(ctx, p, state)
  if (state.snapLine !== null && state.snapLine !== undefined) {
    const x = tx(state.snapLine)
    ctx.strokeStyle = '#ffe26b'
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(x + 0.5, RULER)
    ctx.lineTo(x + 0.5, state.height)
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (state.bladeX !== undefined && store.tool === 'blade') {
    ctx.strokeStyle = '#ff5f57'
    ctx.beginPath()
    ctx.moveTo(state.bladeX + 0.5, RULER)
    ctx.lineTo(state.bladeX + 0.5, state.height)
    ctx.stroke()
  }
  // Playhead.
  const px = Math.round(tx(state.scrubT ?? time.t)) + 0.5
  ctx.strokeStyle = '#ff3b4a'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(px, 0)
  ctx.lineTo(px, state.height)
  ctx.stroke()
  ctx.fillStyle = '#ff3b4a'
  ctx.beginPath()
  ctx.moveTo(px - 6, 0)
  ctx.lineTo(px + 6, 0)
  ctx.lineTo(px + 6, 8)
  ctx.lineTo(px, 14)
  ctx.lineTo(px - 6, 8)
  ctx.fill()
  if (state.tip) {
    ctx.font = '11px ui-monospace, Menlo, monospace'
    const w = ctx.measureText(state.tip.text).width + 12
    ctx.fillStyle = '#000000d0'
    ctx.fillRect(state.tip.x + 10, state.tip.y - 26, w, 18)
    ctx.fillStyle = '#fff'
    ctx.fillText(state.tip.text, state.tip.x + 16, state.tip.y - 22)
  }
}

// ---------------------------------------------------------------- hit testing

function hitAt(p, x, y, state) {
  const yy = y + state.scrollY
  if (y < RULER) {
    const m = p.markers.find(mm => Math.abs(tx(mm.t) - x) < 6 && y > RULER - 16)

    return { zone: m ? 'marker' : 'ruler', marker: m }
  }
  const { rows } = rowsOf(p)
  const row = rows.find(r => yy >= r.y && yy < r.y + r.h)
  if (!row) return { zone: 'empty' }
  const t = xt(x)
  // Transition badge.
  for (const c of row.track.clips) {
    if (!c.transitionIn) continue
    const d = c.transitionIn.dur * store.zoom
    if (Math.abs(x - tx(c.start)) < Math.max(8, d / 2) && Math.abs(yy - (row.y + row.h / 2)) < 9) return { zone: 'transition', row, clip: c }
  }
  const clip = row.track.clips.find(c => t >= c.start && t < clipEnd(c))
  // Edit points between adjacent clips (roll) take priority with the trim tool.
  const edge = 6
  for (const c of row.track.clips) {
    const x0 = tx(c.start)
    const x1 = tx(clipEnd(c))
    if (yy < row.y + 12 && x1 - x0 > 30) {
      if (Math.abs(x - (x0 + (c.fadeIn ?? 0) * store.zoom)) < 6) return { zone: 'fadeIn', row, clip: c }
      if (Math.abs(x - (x1 - (c.fadeOut ?? 0) * store.zoom)) < 6) return { zone: 'fadeOut', row, clip: c }
    }
    if (Math.abs(x - x0) < edge || Math.abs(x - x1) < edge) {
      const left = Math.abs(x - x0) < edge
      const neighbor = row.track.clips.find(o => o !== c && (left ? Math.abs(clipEnd(o) - c.start) < 1e-3 : Math.abs(o.start - clipEnd(c)) < 1e-3))
      if (store.tool === 'trim' && neighbor && Math.abs(x - (left ? x0 : x1)) < 4) return { zone: 'roll', row, a: left ? neighbor : c, b: left ? c : neighbor }
      if (left ? x >= x0 - edge && (!neighbor || x >= x0) : x <= x1 + edge && (!neighbor || x <= x1)) return { zone: left ? 'left' : 'right', row, clip: c }
    }
  }
  if (clip) return { zone: 'body', row, clip }

  return { zone: 'lane', row, t }
}

// ---------------------------------------------------------------- component

export function Timeline() {
  const s = useStore()
  const wrap = useRef(null)
  const canvas = useRef(null)
  const headers = useRef(null)
  const state = useRef({ width: 800, height: 300, scrollY: 0, drag: null, hover: null }).current
  const [, force] = useState(0)

  const syncScrollY = () => {
    const next = headers.current?.scrollTop ?? 0
    if (next === state.scrollY) return
    state.scrollY = next
    force(n => n + 1)
    redraw()
  }
  useLayoutEffect(syncScrollY)

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = 0
      if (canvas.current) drawAll(canvas.current, state)
      if (state.animating) schedule()
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw)
    }
    redraw = schedule
    const unsub = subscribe(schedule)
    const unTime = onTime(t => {
      // Keep the playhead in view while playing (page by page).
      if (store.playing && wrap.current) {
        const w = state.width
        const x = tx(t)
        if (x > w - 40 || x < 0) set({ scroll: Math.max(0, t - 40 / store.zoom) })
      }
      schedule()
    })
    const ro = new ResizeObserver(() => {
      const el = wrap.current
      if (!el) return
      state.width = el.clientWidth
      state.height = el.clientHeight
      const dpr = devicePixelRatio
      canvas.current.width = Math.round(state.width * dpr)
      canvas.current.height = Math.round(state.height * dpr)
      canvas.current.style.width = `${state.width}px`
      canvas.current.style.height = `${state.height}px`
      syncScrollY()
      schedule()
    })
    const pointerChanged = () => { force(n => n + 1); schedule() }
    coarsePointer?.addEventListener('change', pointerChanged)
    ro.observe(wrap.current)
    schedule()

    return () => {
      unsub()
      unTime()
      ro.disconnect()
      coarsePointer?.removeEventListener('change', pointerChanged)
    }
  }, [])

  const p = viewProject()
  if (!p) return html`<div class="timeline empty">No project</div>`
  const { rows, height } = rowsOf(p)

  const local = e => {
    const r = canvas.current.getBoundingClientRect()

    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const seekTo = t => player.seek(Math.max(0, snapToFrame(t, p.fps)))

  const onDown = e => {
    if (e.button === 2) return
    canvas.current.setPointerCapture(e.pointerId)
    const { x, y } = local(e)
    const hit = hitAt(p, x, y, state)
    const t = xt(x)
    if (e.altKey && !e.shiftKey) {
      // Option-click anything: reference it to Claude.
      if (hit.clip) addRef({ kind: 'clip', id: hit.clip.id, label: `${hit.clip.id} ${hit.clip.label ?? hit.clip.title?.text ?? mediaDisplayName(hit.clip.src ?? hit.clip.kind, p.assets?.[hit.clip.src])}` })
      else if (hit.marker) addRef({ kind: 'marker', id: hit.marker.id, label: `marker "${hit.marker.label}"`, comp: p.compId ?? null, context: { projectRoot: store.root, projectVersion: store.version } })
      else if (hit.row) addRef({ kind: 'time', id: `${hit.row.track.id}@${snapToFrame(t, p.fps)}`, label: `${hit.row.track.id} at ${timecode(t, p.fps)}` })
      else addRef({ kind: 'time', id: String(snapToFrame(t, p.fps)), label: `time ${timecode(t, p.fps)}` })

      return
    }
    if (hit.zone === 'ruler' || hit.zone === 'marker') {
      if (hit.marker) {
        set({ selMarker: hit.marker.id, selection: [] })
        state.drag = { kind: 'marker', marker: hit.marker, x0: x, project: p, root: store.root, comp: p.compId ?? null, version: store.version }

        return
      }
      state.drag = { kind: 'scrub' }
      player.beginScrub()
      seekTo(t)

      return
    }
    if (store.tool === 'blade' && hit.clip) {
      const at = snap(p, t, new Set()).t
      edit(e.shiftKey ? [{ op: 'blade', at }] : [{ op: 'blade', at, id: hit.clip.id }])

      return
    }
    if (store.tool === 'hand') {
      state.drag = { kind: 'pan', x0: x, scroll0: store.scroll }

      return
    }
    if (hit.zone === 'transition') {
      set({ selection: [`tr:${hit.clip.id}`], selMarker: null })
      state.drag = { kind: 'transition', clip: hit.clip, x0: x, dur0: hit.clip.transitionIn.dur }

      return
    }
    if (hit.zone === 'lane' || hit.zone === 'empty') {
      if (!e.shiftKey && !e.metaKey) set({ selection: [], selMarker: null, selTrack: hit.row?.track.id ?? null })
      state.drag = { kind: 'marquee', x0: x, y0: y + state.scrollY, additive: e.shiftKey || e.metaKey, base: [...store.selection] }

      return
    }
    // An edit point (roll) names the clips on both sides; it selects the clip after the cut.
    const c = hit.clip ?? hit.b
    // Selection.
    let selection = store.selection.filter(id => !id.startsWith('tr:'))
    if (e.metaKey) selection = selection.includes(c.id) ? selection.filter(i => i !== c.id) : [...selection, c.id]
    else if (e.shiftKey) selection = [...new Set([...selection, c.id])]
    else if (!selection.includes(c.id)) selection = [c.id]
    if (store.linked && c.link && !e.metaKey) for (const o of p.tracks.flatMap(tt => tt.clips)) if (o.link === c.link && !selection.includes(o.id)) selection.push(o.id)
    set({ selection, selMarker: null, selTrack: hit.row.track.id })
    if (hit.row.track.locked) return toast(`${hit.row.track.id} is locked`)
    const base = { x0: x, y0: y, t0: t, clip: c, row: hit.row, moved: false }
    if (hit.zone === 'fadeIn' || hit.zone === 'fadeOut') state.drag = { ...base, kind: hit.zone }
    else if (hit.zone === 'roll') state.drag = { ...base, kind: 'roll', a: hit.a, b: hit.b }
    else if (hit.zone === 'left' || hit.zone === 'right') state.drag = { ...base, kind: 'trim', edge: hit.zone, ripple: store.tool === 'trim' }
    else if (store.tool === 'slip' || (store.tool === 'trim' && !e.altKey)) state.drag = { ...base, kind: store.tool === 'slip' || store.tool === 'trim' ? 'slip' : 'move' }
    else if (store.tool === 'slide' || (store.tool === 'trim' && e.altKey)) state.drag = { ...base, kind: 'slide' }
    else state.drag = { ...base, kind: 'move', ids: selection, duplicate: e.altKey }
  }

  const opsFor = (d, x, y) => {
    const dt = (x - d.x0) / store.zoom
    const ex = new Set(d.ids ?? [d.clip?.id])
    switch (d.kind) {
      case 'move': {
        const lead = d.clip
        const sn = snap(p, lead.start + dt, ex)
        const sn2 = snap(p, clipEnd(lead) + dt, ex)
        const useEnd = sn2.line !== null && (sn.line === null || Math.abs(sn2.t - (clipEnd(lead) + dt)) < Math.abs(sn.t - (lead.start + dt)))
        const delta = Math.max(-Math.min(...d.ids.map(id => p.tracks.flatMap(tt => tt.clips).find(c => c.id === id)?.start ?? 0)), (useEnd ? sn2.t - lead.dur : sn.t) - lead.start)
        state.snapLine = useEnd ? sn2.line : sn.line
        // Vertical: move to another track of the same kind.
        const { rows } = rowsOf(p)
        const target = rows.find(r => y + state.scrollY >= r.y && y + state.scrollY < r.y + r.h)
        const trackChange = target && target.track.kind === d.row.track.kind && target.track !== d.row.track ? target.track.id : null
        state.tip = { x, y, text: `${delta >= 0 ? '+' : '−'}${timecode(Math.abs(delta), p.fps)}` }
        if (d.duplicate) return d.ids.filter(id => !id.startsWith('tr:')).map(id => ({ op: 'duplicate', id, start: (p.tracks.flatMap(tt => tt.clips).find(c => c.id === id)?.start ?? 0) + delta, track: id === lead.id ? trackChange ?? undefined : undefined }))
        // The move op carries linked partners along, so send one move per link group.
        const seen = new Set()
        const movers = [lead.id, ...d.ids.filter(id => id !== lead.id && !id.startsWith('tr:'))].filter(id => {
          const c = p.tracks.flatMap(tt => tt.clips).find(cc => cc.id === id)
          if (!c) return false
          if (c.link && store.linked) {
            if (seen.has(c.link)) return false
            seen.add(c.link)
          }

          return true
        })

        return movers.map(id => {
          const c = p.tracks.flatMap(tt => tt.clips).find(cc => cc.id === id)

          return { op: 'move', id, start: c.start + delta, track: id === lead.id ? trackChange ?? undefined : undefined, unlinked: !store.linked }
        })
      }
      case 'trim': {
        const edgeT = d.edge === 'left' ? d.clip.start : clipEnd(d.clip)
        const sn = snap(p, edgeT + dt, new Set([d.clip.id]))
        state.snapLine = sn.line
        state.tip = { x, y, text: `${d.edge === 'left' ? 'start' : 'end'} ${timecode(sn.t, p.fps)}  dur ${timecode(d.edge === 'left' ? clipEnd(d.clip) - sn.t : sn.t - d.clip.start, p.fps)}` }

        return [{ op: 'trim', id: d.clip.id, edge: d.edge, to: sn.t, ripple: d.ripple, ...(store.linked ? {} : { unlinked: true }) }]
      }
      case 'roll': {
        const sn = snap(p, d.b.start + dt, new Set([d.a.id, d.b.id]))
        state.snapLine = sn.line
        state.tip = { x, y, text: `roll ${timecode(sn.t, p.fps)}` }

        return [{ op: 'roll', a: d.a.id, b: d.b.id, to: sn.t, ...(store.linked ? {} : { unlinked: true }) }]
      }
      case 'slip':
        state.tip = { x, y, text: `slip ${dt >= 0 ? '+' : '−'}${timecode(Math.abs(dt), p.fps)}` }

        return [{ op: 'slip', id: d.clip.id, delta: -dt * (d.clip.speed ?? 1) }]
      case 'slide':
        state.tip = { x, y, text: `slide ${dt >= 0 ? '+' : '−'}${timecode(Math.abs(dt), p.fps)}` }

        return [{ op: 'slide', id: d.clip.id, delta: dt, ...(store.linked ? {} : { unlinked: true }) }]
      case 'fadeIn':
      case 'fadeOut': {
        const local = xt(x) - d.clip.start
        const v = d.kind === 'fadeIn' ? local : d.clip.dur - local
        const fade = Math.max(0, Math.min(d.clip.dur / 2, Math.round(v * p.fps) / p.fps))
        state.tip = { x, y, text: `${d.kind === 'fadeIn' ? 'fade in' : 'fade out'} ${fade.toFixed(2)}s` }

        return [{ op: 'update', id: d.clip.id, set: { [d.kind]: fade || null } }]
      }
      case 'transition': {
        const dur = Math.max(2 / p.fps, d.dur0 + (Math.abs(x - tx(d.clip.start)) * 2 - d.dur0 * store.zoom) / store.zoom)
        state.tip = { x, y, text: `transition ${dur.toFixed(2)}s` }

        return [{ op: 'transition', id: d.clip.id, type: d.clip.transitionIn.type, dur: Math.round(dur * p.fps) / p.fps }]
      }
    }

    return []
  }

  const onMove = e => {
    const { x, y } = local(e)
    const d = state.drag
    if (!d) {
      const hit = hitAt(p, x, y, state)
      state.hover = hit
      state.bladeX = store.tool === 'blade' ? tx(snap(p, xt(x), new Set()).t) : undefined
      const cursor =
        store.tool === 'blade' ? 'crosshair' :
        store.tool === 'hand' ? 'grab' :
        hit.zone === 'left' || hit.zone === 'right' ? (store.tool === 'trim' ? 'col-resize' : 'ew-resize') :
        hit.zone === 'roll' ? 'col-resize' :
        hit.zone === 'fadeIn' || hit.zone === 'fadeOut' ? 'pointer' :
        hit.zone === 'body' && (store.tool === 'slip' || store.tool === 'trim') ? 'ew-resize' :
        hit.zone === 'ruler' ? 'text' : 'default'
      canvas.current.style.cursor = cursor
      redraw()

      return
    }
    if (d.kind === 'scrub') {
      seekTo(xt(x))

      return
    }
    if (d.kind === 'pan') {
      set({ scroll: Math.max(0, d.scroll0 - (x - d.x0) / store.zoom) })

      return
    }
    if (d.kind === 'marker') {
      if (store.root !== d.root || store.version !== d.version || (store.openComp ?? null) !== d.comp) { state.preview = null; redraw(); return }
      d.to = snap(d.project, d.marker.t + (x - d.x0) / store.zoom, new Set()).t
      state.preview = applyOps(d.project, [{ op: 'update_marker', id: d.marker.id, set: { t: d.to } }]).project
      redraw()

      return
    }
    if (d.kind === 'marquee') {
      state.marquee = { x0: d.x0, y0: d.y0, x1: x, y1: y + state.scrollY }
      const tA = xt(Math.min(d.x0, x))
      const tB = xt(Math.max(d.x0, x))
      const yA = Math.min(d.y0, y + state.scrollY)
      const yB = Math.max(d.y0, y + state.scrollY)
      const ids = rowsOf(p).rows.filter(r => r.y + r.h > yA && r.y < yB).flatMap(r => r.track.clips.filter(c => clipEnd(c) > tA && c.start < tB).map(c => c.id))
      set({ selection: d.additive ? [...new Set([...d.base, ...ids])] : ids })

      return
    }
    if (!d.moved && Math.abs(x - d.x0) < 3 && Math.abs(y - d.y0) < 3) return
    d.moved = true
    try {
      d.ops = opsFor(d, x, y)
      state.preview = applyOps(p, d.ops).project
    } catch {
      state.preview = null
    }
    redraw()
  }

  const onUp = () => {
    const d = state.drag
    if (d?.kind === 'scrub') player.endScrub()
    state.drag = null
    state.preview = null
    state.snapLine = null
    state.tip = null
    state.marquee = null
    if (d?.kind === 'marker' && d.to !== undefined) {
      if (store.root !== d.root) toast('The project changed during this marker edit. Select the current marker and try again.', 'error')
      else edit([{ op: 'update_marker', comp: d.comp, id: d.marker.id, set: { t: d.to } }], undefined, { expectedVersion: d.version })
    }
    else if (d?.moved && d.ops?.length) edit(d.ops)
    redraw()
  }

  const onWheel = e => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      const x = Math.max(0, local(e).x)
      const at = xt(x)
      const zoom = Math.max(0.5, Math.min(2400, store.zoom * Math.exp(-e.deltaY * 0.01)))
      set({ zoom, scroll: Math.max(0, at - x / zoom) })
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      set({ scroll: Math.max(0, store.scroll + (e.deltaX || e.deltaY) / store.zoom) })
    } else {
      if (headers.current) headers.current.scrollTop += e.deltaY
      syncScrollY()
    }
  }

  const onContext = e => {
    e.preventDefault()
    const { x, y } = local(e)
    const hit = hitAt(p, x, y, state)
    const t = snapToFrame(xt(x), p.fps)
    if (hit.clip && !store.selection.includes(hit.clip.id)) set({ selection: [hit.clip.id] })
    openMenu(e.clientX, e.clientY, clipMenu(p, hit, t))
  }

  const onDrop = e => {
    e.preventDefault()
    const data = e.dataTransfer.getData('application/x-reel')
    if (!data) return
    const item = JSON.parse(data)
    const { x, y } = local(e)
    const hit = hitAt(p, x, y, state)
    const t = snap(p, xt(x), new Set()).t
    if (item.type === 'media') {
      const asset = p.assets[item.src] ?? {}
      const isAudio = !asset.hasVideo
      let track = hit.row?.track
      if (!track || (track.kind === 'audio') !== isAudio) track = p.tracks.find(tt => tt.kind === (isAudio ? 'audio' : 'video') && !tt.locked)
      edit([{ op: e.altKey ? 'insert' : 'overwrite', src: item.src, track: track.id, start: t, ...(item.in !== undefined ? { in: item.in, out: item.out } : {}) }])
    } else if (item.type === 'title') {
      const track = hit.row?.track.kind === 'video' ? hit.row.track : [...p.tracks].reverse().find(tt => tt.kind === 'video')
      edit([item.preset === true ? titlePresetOp(p, item, { track: track.id, start: t }) : { op: 'add_title', track: track.id, start: t, dur: 4, text: item.text, title: item.title }])
    } else if (item.type === 'transition' && hit.clip) {
      edit([{ op: 'transition', id: hit.clip.id, type: item.name, dur: 1 }])
    } else if (item.type === 'effect' && hit.clip) {
      edit([{ op: 'effect', id: hit.clip.id, type: item.name }])
    } else if (item.type === 'generator') {
      const track = hit.row?.track.kind === 'video' ? hit.row.track : p.tracks.find(tt => tt.kind === 'video')
      edit([item.name === 'adjustment' ? { op: 'adjustment', track: track.id, start: t, dur: 5 } : { op: 'add_color', track: track.id, start: t, dur: 3, color: item.color }])
    }
  }

  return html`
    <div class="timeline" onWheel=${onWheel}>
      <div class="track-headers" style=${{ width: `${HEADER}px` }}>
        <div class="th-ruler"><${HeaderTimecode} fps=${p.fps} /></div>
        <div class="th-scroll" ref=${headers} onScroll=${syncScrollY}>
          <div class="th-rows">
            ${rows.map(r => html`<${TrackHeader} key=${r.track.id} row=${r} p=${p} />`)}
            <div class="th-add">
              <button class="ghost" onClick=${() => edit({ op: 'add_track', kind: 'video' })}>+ Video</button>
              <button class="ghost" onClick=${() => edit({ op: 'add_track', kind: 'audio' })}>+ Audio</button>
            </div>
          </div>
        </div>
      </div>
      <div class="tl-canvas" ref=${wrap} onDragOver=${e => e.preventDefault()} onDrop=${onDrop}>
        <canvas ref=${canvas} onDblClick=${e => {
          const { x, y } = local(e)
          const hit = hitAt(p, x, y, state)
          if (hit.clip?.kind === 'comp' && store.project.comps?.[hit.clip.comp]) openComposition(hit.clip.comp)
        }} onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp} onLostPointerCapture=${onUp} onPointerLeave=${() => ((state.bladeX = undefined), (state.hover = null), redraw())} onContextMenu=${onContext}></canvas>
      </div>
    </div>
  `
}

function HeaderTimecode({ fps }) {
  const t = useTime()

  return html`<span class="tc-mini">${timecode(t, fps)}</span>`
}

// Track header glyphs, drawn on the same 24-unit grid and stroke as ui/icons.js. They live here
// because this module is loaded by tests with a fixed set of dependencies and no icon import.
const TRACK_ICONS = {
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
  'eye-off': ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M4 4l16 16'],
  lock: ['M7 10.5h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z', 'M8 10.5V8a4 4 0 0 1 8 0v2.5'],
  unlock: ['M7 10.5h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z', 'M8 10.5V8a4 4 0 0 1 7.7-1.5'],
}

function trackIcon(name) {
  return html`<svg class="ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${TRACK_ICONS[name].map(d => html`<path d=${d} />`)}</svg>`
}

function TrackHeader({ row, p }) {
  const t = row.track
  const toggle = key => edit({ op: 'update_track', id: t.id, set: { [key]: !t[key] } })
  const sel = store.selTrack === t.id
  // An empty track is compact by default; Taller and Shorter step from its full height instead.
  const stepFrom = store.trackHeight[t.id] == null && row.h === TRACK_HEIGHT.empty ? (t.kind === 'video' ? TRACK_HEIGHT.video : TRACK_HEIGHT.audio) : row.h

  return html`
    <div class=${`th ${t.kind} ${sel ? 'sel' : ''} ${row.h < 48 ? 'slim' : ''}`} style=${{ height: `${row.h + 2}px` }} onClick=${e => (e.altKey ? addRef({ kind: 'track', id: t.id, label: `track ${t.id} ${t.name ?? ''}` }) : set({ selTrack: t.id }))}
      onContextMenu=${e => {
        e.preventDefault()
        openMenu(e.clientX, e.clientY, [
          { label: 'Reference track to Assistant', hint: '⌥-click', run: () => addRef({ kind: 'track', id: t.id, label: `track ${t.id} ${t.name ?? ''}` }) },
          { label: 'Rename…', run: () => { const name = prompt('Track name', t.name ?? t.id); if (name) edit({ op: 'update_track', id: t.id, set: { name } }) } },
          { label: 'Close gaps', run: () => edit({ op: 'close_gaps', track: t.id }) },
          { label: 'Taller', run: () => set(s => ({ trackHeight: { ...s.trackHeight, [t.id]: Math.min(200, stepFrom + 24) } })) },
          { label: 'Shorter', run: () => set(s => ({ trackHeight: { ...s.trackHeight, [t.id]: Math.max(30, stepFrom - 24) } })) },
          { sep: true },
          { label: 'Delete track', danger: true, run: () => edit({ op: 'delete_track', id: t.id }) },
        ])
      }}>
      <div class="th-name" title=${`${t.id} ${t.name ?? ''}`.trim()}><b>${t.id}</b> <span>${t.name ?? ''}</span></div>
      <div class="th-btns">
        ${t.kind === 'caption' ? html`<button class=${t.burnIn ? 'on' : ''} title="Burn captions into the picture" aria-label=${`Burn in ${t.id}`} aria-pressed=${!!t.burnIn} onClick=${e => (e.stopPropagation(), toggle('burnIn'))}>CC</button>` : t.kind === 'video' ? html`<button class=${`th-icon ${t.hidden ? 'on' : ''}`} title=${t.hidden ? 'Show track' : 'Hide track'} aria-label=${`Hide ${t.id}`} aria-pressed=${!!t.hidden} onClick=${e => (e.stopPropagation(), toggle('hidden'))}>${trackIcon(t.hidden ? 'eye-off' : 'eye')}</button>` : html`<button class=${t.solo ? 'on solo' : ''} title="Solo" aria-label=${`Solo ${t.id}`} aria-pressed=${!!t.solo} onClick=${e => (e.stopPropagation(), toggle('solo'))}>S</button>`}
        <button class=${t.muted ? 'on mute' : ''} title="Mute" aria-label=${`Mute ${t.id}`} aria-pressed=${!!t.muted} onClick=${e => (e.stopPropagation(), toggle('muted'))}>M</button>
        <button class=${`th-icon ${t.locked ? 'on' : ''}`} title=${t.locked ? 'Unlock track' : 'Lock track'} aria-label=${`Lock ${t.id}`} aria-pressed=${!!t.locked} onClick=${e => (e.stopPropagation(), toggle('locked'))}>${trackIcon(t.locked ? 'lock' : 'unlock')}</button>
      </div>
    </div>
  `
}

export function clipMenu(p, hit, t) {
  const items = [], comp = p.compId ?? null, expectedVersion = store.version
  const context = { projectRoot: store.root, projectVersion: expectedVersion }
  const editMarker = op => {
    if (store.root !== context.projectRoot) return toast('The project changed since this marker menu opened. Open the current marker menu again.', 'error')
    return edit({ ...op, comp }, undefined, { expectedVersion })
  }
  const c = hit.clip
  if (c) {
    const ids = store.selection.filter(id => !id.startsWith('tr:'))
    items.push(
      { label: 'Reference to Assistant', hint: '⌥-click', run: () => ids.forEach(id => { const cc = p.tracks.flatMap(tt => tt.clips).find(x => x.id === id); if (cc) addRef({ kind: 'clip', id, label: `${id} ${cc.label ?? cc.title?.text ?? mediaDisplayName(cc.src ?? cc.kind, p.assets?.[cc.src])}` }) }) },
      { label: 'Ask the Assistant about this clip…', run: () => { addRef({ kind: 'clip', id: c.id, label: `${c.id}` }); set({ chatOpen: true }); setTimeout(() => document.querySelector('.chat textarea')?.focus(), 50) } },
      { sep: true },
      { label: 'Blade at playhead', hint: '⌘B', run: () => edit({ op: 'blade', at: time.t, id: c.id }) },
      { label: 'Blade here', run: () => edit({ op: 'blade', at: t, id: c.id }) },
      { label: 'Duplicate', run: () => edit({ op: 'duplicate', id: c.id }) },
      { label: c.enabled === false ? 'Enable clip' : 'Disable clip', hint: 'V', run: () => edit({ op: 'update', ids, set: { enabled: c.enabled === false ? null : false } }) },
      { sep: true },
      { label: 'Add cross dissolve', hint: '⌘T', run: () => edit({ op: 'transition', id: c.id, type: 'crossDissolve', dur: 1 }) },
      { label: 'Fade in & out', run: () => edit({ op: 'update', ids, set: { fadeIn: 0.5, fadeOut: 0.5 } }) },
      {
        label: 'Speed',
        sub: [
          ...[0.25, 0.5, 0.75, 1, 1.5, 2, 4].map(sp => ({ label: `${sp * 100}%`, run: () => edit({ op: 'speed', id: c.id, speed: sp }) })),
          { label: c.reverse ? 'Play forward' : 'Reverse', run: () => edit({ op: 'speed', id: c.id, speed: c.speed ?? 1, reverse: !c.reverse }) },
        ],
      },
    )
    if (c.kind === 'video') items.push({ label: 'Freeze frame at playhead', hint: '⌥F', run: () => edit({ op: 'freeze', id: c.id, at: time.t, dur: 2 }) })
    if (c.kind === 'comp') items.push({ label: 'Open composition', hint: 'double-click', run: () => openComposition(c.comp) })
    if (ids.length) items.push({ label: ids.length > 1 ? `Precompose ${ids.length} clips…` : 'Precompose…', run: () => { const name = prompt('Composition name', 'Precomp'); if (name) edit({ op: 'precompose', ids, name }) } })
    if (c.link) items.push({ label: 'Unlink audio/video', run: () => edit({ op: 'detach_audio', id: c.id }) })
    if (c.kind === 'video' && !c.link && hasAudio(p, { ...c, audioDetached: false })) items.push({ label: 'Detach audio', run: () => edit({ op: 'append', src: c.src, track: p.tracks.find(tt => tt.kind === 'audio')?.id, start: c.start, in: c.in, dur: c.dur }) })
    items.push(
      {
        label: 'Color label',
        sub: ['#ff5f57', '#f5b942', '#3fb950', '#58a6ff', '#bc8cff', null].map(col => ({ label: col ? `● ${col}` : 'None', run: () => edit({ op: 'update', ids, set: { tag: col } }) })),
      },
      { sep: true },
      { label: 'Copy', hint: '⌘C', run: () => copySelection(p) },
      { label: 'Delete (leave gap)', hint: '⌫', run: () => edit({ op: 'lift', ids }) },
      { label: 'Ripple delete', hint: '⇧⌫', danger: true, run: () => edit({ op: 'ripple_delete', ids }) },
    )
  } else if (hit.zone === 'transition') {
    items.push({ label: 'Remove transition', run: () => edit({ op: 'transition', id: hit.clip.id, type: 'none' }) })
  } else if (hit.marker) {
    items.push(
      { label: 'Reference marker to Assistant', run: () => addRef({ kind: 'marker', id: hit.marker.id, label: `marker "${hit.marker.label}"`, comp, context }) },
      { label: 'Rename…', run: () => { const label = prompt('Marker', hit.marker.label); if (label !== null) editMarker({ op: 'update_marker', id: hit.marker.id, set: { label } }) } },
      { label: 'Delete marker', danger: true, run: () => editMarker({ op: 'delete_marker', id: hit.marker.id }) },
    )
  } else {
    items.push(
      { label: 'Reference this moment to Assistant', run: () => addRef({ kind: 'time', id: String(t), label: `time ${timecode(t, p.fps)}` }) },
      { label: 'Add marker here', run: () => editMarker({ op: 'marker', t, label: '' }) },
      { label: 'Paste here', hint: '⌘V', disabled: !store.clipboard, run: () => edit({ op: 'paste', at: t, clips: store.clipboard }) },
      { label: 'Add title here', run: () => edit({ op: 'add_title', start: t, text: 'Title' }) },
    )
  }

  for (const fn of registry.clipMenus) {
    const more = fn(p, hit, t) ?? []
    if (more.length) items.push({ sep: true }, ...more)
  }

  return items
}

/** Opens a composition in the viewer and timeline, remembering the way back. */
export function openComposition(id) {
  const parents = { ...(store.compParents ?? {}), [id]: store.openComp }
  set({ openComp: id, compParents: parents, selection: [], scroll: 0 })
  player.seek(0)
}

export function copySelection(p) {
  const sel = p.tracks.flatMap(t => t.clips.filter(c => store.selection.includes(c.id)).map(c => ({ track: t.id, clip: c })))
  if (!sel.length) return
  const t0 = Math.min(...sel.map(s => s.clip.start))
  set({ clipboard: sel.map(s => ({ track: s.track, clip: s.clip, offset: s.clip.start - t0 })) })
  toast(`Copied ${sel.length} clip${sel.length > 1 ? 's' : ''}`)
}

export { HEADER, RULER }
