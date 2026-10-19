// Multicam editing.
//
// - Create: from media picked in the Multicam browser tab, or from clips selected on the
//   timeline; angles are synced by audio (POST /api/multicam/sync) and the audio angle is
//   placed as a linked audio clip (the multicam clip itself is muted, see below).
// - Angle viewer over the program: every angle playing in sync, the live angle outlined.
//   Click an angle or press 1–9 to cut at the playhead. While playing, cuts are recorded at
//   player.t and written as one edit when playback stops (an edit restarts playback).
// - Multicam tab in the inspector: labels, offsets, audio angle, and the cut list.

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { applyOps, clipEnd, timecode } from '/core/project.js'
import { angleAt } from '../../engine/frame.js'
import { mediaUrl } from '../../engine/media.js'
import { player } from '../engine-host.js'
import { registerBrowserTab, registerClipMenu, registerInspector, registerViewerOverlay } from '../registry.js'
import { api, edit, set, store, subscribe, toast, useStore, useTime, viewProject } from '../store.js'

const html = htm.bind(h)

const css = `
.mc-panel { position: absolute; z-index: 5; background: #0b0b0ee6; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; box-shadow: 0 6px 24px #0008; }
.mc-head { display: flex; align-items: center; gap: 4px; padding: 3px 6px; font-size: 11px; color: var(--muted); }
.mc-head b { color: var(--text); font-weight: 600; }
.mc-head button { padding: 0 5px; font-size: 11px; }
.mc-rec { color: #ff5f57; font-weight: 700; }
.mc-grid { display: grid; gap: 2px; padding: 2px; }
.mc-cell { position: relative; cursor: pointer; background: #000; outline: 2px solid transparent; outline-offset: -2px; }
.mc-cell canvas { display: block; width: 100%; height: 100%; }
.mc-cell.live { outline-color: #ff3b30; }
.mc-cell:hover:not(.live) { outline-color: #f5b94299; }
.mc-label { position: absolute; left: 4px; bottom: 3px; font-size: 11px; color: #fff; text-shadow: 0 1px 2px #000; pointer-events: none; }
.mc-label .num { display: inline-block; min-width: 14px; padding: 0 3px; margin-right: 3px; border-radius: 3px; background: #ffffff26; text-align: center; }
.mc-cell.live .num { background: #ff3b30; }
.mc-audio { position: absolute; right: 4px; top: 2px; font-size: 11px; pointer-events: none; }
.mc-empty { position: absolute; inset: 0; display: grid; place-items: center; color: #777; font-size: 11px; pointer-events: none; }
.mc-list { display: flex; flex-direction: column; gap: 3px; }
.mc-row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.mc-row .num { width: 18px; text-align: center; color: var(--accent); font-weight: 700; }
.mc-row input[type=number] { width: 70px; text-align: right; }
.mc-row input[type=text] { flex: 1; min-width: 0; }
.mc-row .src { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.mc-note { font-size: 11.5px; color: var(--muted); line-height: 1.35; }
.mc-note.warn { color: #f0a35e; }
`
if (typeof document !== 'undefined' && !document.getElementById('mc-style')) {
  const el = document.createElement('style')
  el.id = 'mc-style'
  el.textContent = css
  document.head.appendChild(el)
}

// ---------------------------------------------------------------- helpers

/** Multicam time at timeline time t. */
export const mcTime = (c, t) => (c.in ?? 0) + (t - c.start) * (c.speed ?? 1)
/** Timeline time of multicam time mt. */
const tlTime = (c, mt) => c.start + (mt - (c.in ?? 0)) / (c.speed ?? 1)

/** The topmost multicam clip under timeline time t in a view. */
function multicamAt(p, t) {
  for (const tr of [...(p?.tracks ?? [])].reverse()) {
    if (tr.kind !== 'video' || tr.hidden) continue
    const c = tr.clips.find(x => x.start <= t + 1e-6 && t < clipEnd(x) - 1e-6 && x.enabled !== false)
    if (c) return c.kind === 'multicam' ? c : null
  }

  return null
}

const name = src => String(src).split('/').pop().replace(/\.[^.]+$/, '')

const UNSCOPED = ['import', 'project', 'range', 'marker', 'markers', 'update_marker', 'delete_marker', 'add_comp', 'replace']

/** Ops scoped the way store.edit scopes them (store.js), so a local dry run gives the ids the server will. */
function scopedForDryRun(ops) {
  if (!store.openComp) return ops

  return ops.map(op => (op.comp || op.id || op.ids || op.a || op.target || UNSCOPED.includes(op.op) ? op : { ...op, comp: store.openComp }))
}

function audioPartner(p, c) {
  if (!c.link) return null

  return p.tracks.flatMap(t => t.clips).find(x => x.id !== c.id && x.link === c.link && x.kind === 'audio') ?? null
}

/**
 * Builds the multicam clip at timeline time `at`, on the first video track free there (a
 * new one if none), plus the audio angle as a linked audio clip, in one edit.
 */
async function createMulticam(srcs, { offsets, labels, at, audioAngle = 0, withAudio = true }) {
  const p = viewProject()
  const dur = Math.min(...srcs.map((s, i) => (p.assets[s]?.duration ?? 10) - (offsets[i] ?? 0)))
  if (!(dur > 0)) return toast('The angles do not overlap in time', 'error')
  const free = kind => p.tracks.find(t => t.kind === kind && !t.locked && !t.clips.some(c => c.start < at + dur && clipEnd(c) > at))
  const ops = []
  let vTrack = free('video')?.id
  if (!vTrack) {
    let n = 1
    while (p.tracks.some(t => t.id === `V${n}`)) n++
    vTrack = `V${n}`
    ops.push({ op: 'add_track', kind: 'video' })
  }
  ops.push({ op: 'make_multicam', srcs, offsets, labels, track: vTrack, start: at, audioAngle, name: 'Multicam' })
  const angle = srcs[audioAngle]
  const audio = withAudio && p.assets[angle]?.hasAudio
  if (audio) {
    let aTrack = free('audio')?.id
    if (!aTrack) {
      let n = 1
      while (p.tracks.some(t => t.id === `A${n}`)) n++
      aTrack = `A${n}`
      ops.push({ op: 'add_track', kind: 'audio' })
    }
    ops.push({ op: 'add_clip', kind: 'audio', src: angle, track: aTrack, start: at, in: offsets[audioAngle] ?? 0, dur })
  }
  // A dry run gives the ids the server will assign, so linking fits in the same edit.
  let created
  try {
    created = applyOps(store.project, scopedForDryRun(ops)).created.filter(id => id.startsWith('c'))
  } catch (error) {
    return toast(error.message, 'error')
  }
  const mcId = created[0]
  if (audio) ops.push({ op: 'update', id: mcId, set: { mute: true } }, { op: 'link', ids: [mcId, created[1]] })
  const r = await edit(ops, `multicam ${mcId} from ${srcs.length} angles`)
  if (r) {
    set({ selection: [mcId], inspectorTab: 'multicam' })
    toast(`Multicam ${mcId}: ${srcs.length} angles synced. Click an angle or press 1–${Math.min(9, srcs.length)} to cut.`)
  }

  return r
}

async function syncAngles(srcs) {
  const r = await api('/api/multicam/sync', { srcs })
  for (const w of r.warnings ?? []) toast(w, 'error')

  return r
}

// ---------------------------------------------------------------- cutting

const pending = [] // cuts recorded during playback: { id, at, angle }

function cutTo(c, angle) {
  if (!c || angle < 0 || angle >= c.angles.length) return
  const t = player.t
  if (t < c.start - 1e-6 || t >= clipEnd(c) - 1e-6) return
  if (player.playing) {
    pending.push({ id: c.id, at: t, angle })
    set({ mcPending: pending.length })

    return
  }
  edit({ op: 'multicam_cut', id: c.id, at: t, angle }, `cut ${c.id} to ${c.angles[angle].label ?? `angle ${angle + 1}`}`)
}

function flushPending() {
  if (!pending.length || store.playing) return
  const cuts = pending.splice(0)
  set({ mcPending: 0 })
  edit(cuts.map(x => ({ op: 'multicam_cut', id: x.id, at: x.at, angle: x.angle })), `${cuts.length} live multicam cut${cuts.length === 1 ? '' : 's'}`)
}

subscribe(() => {
  if (!store.playing && pending.length) flushPending()
})

/** The angle showing at t, counting cuts recorded during this playback. */
function liveAngle(c, t) {
  let a = angleAt(c, mcTime(c, t))
  let best = -Infinity
  for (const x of pending) if (x.id === c.id && x.at <= t + 1e-6 && x.at >= best) {
    best = x.at
    a = x.angle
  }

  return a
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !/^Digit[1-9]$/.test(e.code)) return
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return
    const c = multicamAt(viewProject(), player.t)
    const n = Number(e.code.slice(5)) - 1
    if (!c || n >= c.angles.length) return
    e.preventDefault()
    e.stopImmediatePropagation()
    cutTo(c, n)
  }, true)
}

// ---------------------------------------------------------------- angle viewer

const holder = typeof document !== 'undefined' ? document.createElement('div') : null
if (holder) {
  holder.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1'
  document.body.appendChild(holder)
}
const videos = new Map() // `${clip}#${angle}` → { el, url }

function angleVideo(key, url) {
  let v = videos.get(key)
  if (v && v.url !== url) {
    v.el.pause()
    v.el.removeAttribute('src')
    v.el.load()
    v.el.remove()
    v = null
  }
  if (!v) {
    const el = document.createElement('video')
    el.muted = true
    el.playsInline = true
    el.preload = 'auto'
    el.crossOrigin = 'anonymous'
    el.src = url
    holder.appendChild(el)
    v = { el, url }
    videos.set(key, v)
  }

  return v
}

function dropVideos(prefix) {
  for (const [key, v] of videos) {
    if (prefix && !key.startsWith(prefix)) continue
    v.el.pause()
    v.el.removeAttribute('src')
    v.el.load()
    v.el.remove()
    videos.delete(key)
  }
}

const SIZES = { s: 0.34, m: 0.5, l: 0.7, full: 1 }

function AngleViewer({ p, rect }) {
  const s = useStore()
  const t = useTime()
  const c = multicamAt(p, t)
  const canvases = useRef([])
  const latest = useRef(null)
  latest.current = c ? { c, p } : null

  useEffect(() => {
    if (!c) return undefined
    let raf = 0
    let lastDraw = 0
    const loop = now => {
      raf = requestAnimationFrame(loop)
      const cur = latest.current
      if (!cur) return
      const { c: clip, p: view } = cur
      const playing = player.playing && player.rate > 0
      const mt = mcTime(clip, player.t)
      const draw = now - lastDraw > 30
      if (draw) lastDraw = now
      clip.angles.slice(0, 9).forEach((angle, i) => {
        const asset = view.assets[angle.src] ?? {}
        const v = angleVideo(`${clip.id}#${i}`, mediaUrl(view, angle.src)).el
        const raw = mt + (angle.offset ?? 0)
        const len = asset.duration ?? Infinity
        const inside = raw >= 0 && raw < len
        const target = Math.max(0, Math.min(len - 0.001, raw))
        if (playing && inside) {
          const rate = Math.min(16, Math.max(0.0625, player.rate * (clip.speed ?? 1)))
          if (Math.abs(v.playbackRate - rate) > 1e-3) v.playbackRate = rate
          if (v.paused) {
            v.currentTime = target
            v.play().catch(() => {})
          } else if (Math.abs(v.currentTime - target) > 0.15 && !v.seeking) v.currentTime = target + 0.03
        } else {
          if (!v.paused) v.pause()
          if (Math.abs(v.currentTime - target) > 0.5 / (asset.fps || view.fps) && !v.seeking && v.readyState >= 1) v.currentTime = target
        }
        const cv = canvases.current[i]
        if (!draw || !cv) return
        const ctx = cv.getContext('2d')
        if (!inside) {
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, cv.width, cv.height)
        } else if (v.readyState >= 2) {
          const iw = v.videoWidth || cv.width
          const ih = v.videoHeight || cv.height
          const k = Math.min(cv.width / iw, cv.height / ih)
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, cv.width, cv.height)
          ctx.drawImage(v, (cv.width - iw * k) / 2, (cv.height - ih * k) / 2, iw * k, ih * k)
        }
      })
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      dropVideos(`${c.id}#`)
    }
  }, [c?.id])

  if (!c) return null
  const n = Math.min(9, c.angles.length)
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3
  const panelW = Math.round(rect.w * (SIZES[s.mcSize ?? 'm'] ?? 0.5))
  const cellW = Math.floor((panelW - 2 - (cols - 1) * 2) / cols)
  const cellH = Math.round((cellW * p.height) / p.width)
  const live = liveAngle(c, t)
  const recording = s.playing && (s.mcPending ?? 0) > 0
  const stop = e => e.stopPropagation()
  const size = key => set({ mcSize: key })

  return html`
    <div class="mc-panel" style=${{ left: `${rect.x + rect.w - panelW}px`, top: `${rect.y}px`, width: `${panelW}px` }} onPointerDown=${stop} onDblClick=${stop}>
      <div class="mc-head">
        <b>Multicam</b><span>${c.id}</span>${recording ? html`<span class="mc-rec">● ${s.mcPending} cut${s.mcPending === 1 ? '' : 's'}</span>` : html`<span>· click or press 1–${n}</span>`}
        <span style=${{ flex: 1 }}></span>
        ${Object.keys(SIZES).map(k => html`<button class=${`ghost tiny ${(s.mcSize ?? 'm') === k ? 'on' : ''}`} title="Angle viewer size" onClick=${() => size(k)}>${k.toUpperCase()}</button>`)}
        <button class="ghost tiny" title="Hide the angle viewer (Multicam tab or clip menu brings it back)" onClick=${() => set({ mcViewer: false })}>✕</button>
      </div>
      <div class="mc-grid" style=${{ gridTemplateColumns: `repeat(${cols}, ${cellW}px)` }}>
        ${c.angles.slice(0, 9).map((a, i) => html`
          <div class=${`mc-cell ${i === live ? 'live' : ''}`} style=${{ width: `${cellW}px`, height: `${cellH}px` }} title=${`${a.label ?? `Angle ${i + 1}`}: ${a.src} (offset ${a.offset ?? 0}s). Click to cut here.`} onClick=${() => cutTo(c, i)}>
            <canvas width=${cellW} height=${cellH} ref=${el => (canvases.current[i] = el)}></canvas>
            <span class="mc-label"><span class="num">${i + 1}</span>${a.label ?? `Angle ${i + 1}`}</span>
            ${(c.audioAngle ?? 0) === i ? html`<span class="mc-audio" title="Audio angle">♪</span>` : null}
          </div>`)}
      </div>
    </div>
  `
}

// ---------------------------------------------------------------- browser tab

function MulticamBrowser({ project: p }) {
  const s = useStore()
  const canSync = s.caps.processing?.multicamSync !== false
  const [picked, setPicked] = useState([])
  const [sync, setSync] = useState(null)
  const [busy, setBusy] = useState(false)
  const [withAudio, setWithAudio] = useState(true)
  const videosList = Object.entries(p.assets).filter(([, a]) => a.hasVideo && a.duration)
  const toggle = src => {
    setPicked(cur => (cur.includes(src) ? cur.filter(x => x !== src) : [...cur, src]))
    setSync(null)
  }
  const doSync = async () => {
    setBusy(true)
    try {
      setSync({ srcs: picked, ...(await syncAngles(picked)) })
    } catch (error) {
      toast(error.message, 'error')
    }
    setBusy(false)
  }
  const create = async () => {
    setBusy(true)
    try {
      const r = sync && sync.srcs.join('|') === picked.join('|') ? sync : canSync ? await syncAngles(picked) : { offsets: picked.map(() => 0) }
      await createMulticam(picked, { offsets: r.offsets, labels: picked.map(name), at: player.t, withAudio })
    } catch (error) {
      toast(error.message, 'error')
    }
    setBusy(false)
  }

  return html`
    <div class="tab-body">
      <div class="mc-note">Pick two to nine camera angles in order. ${canSync ? 'Arya lines them up by their sound and builds a multicam clip at the playhead.' : 'The native app starts them at zero offset. Adjust each offset in the Multicam inspector, or open the browser editor to sync by audio.'}</div>
      <div class="mc-list">
        ${videosList.map(([src, a]) => {
          const i = picked.indexOf(src)

          return html`
            <label class="mc-row" title=${src}>
              <input type="checkbox" checked=${i >= 0} onChange=${() => toggle(src)} />
              <span class="num">${i >= 0 ? i + 1 : ''}</span>
              <span class="src">${src.split('/').pop()}</span>
              <span class="muted">${a.hasAudio ? timecode(a.duration, 30, false).replace(/^00:/, '') : 'no audio'}</span>
            </label>`
        })}
      </div>
      ${sync ? html`
        <div class="mc-list">
          ${sync.srcs.map((src, i) => html`<div class="mc-row"><span class="num">${i + 1}</span><span class="src">${src.split('/').pop()}</span><span>${sync.offsets[i].toFixed(3)}s</span><span class="muted" title="Correlation at the chosen offset">${Math.round(sync.confidence[i] * 100)}%</span></div>`)}
        </div>` : null}
      <label class="row gap mc-note"><input type="checkbox" checked=${withAudio} onChange=${e => setWithAudio(e.target.checked)} /> Put angle 1's sound on an audio track (linked)</label>
      <div class="row gap">
        <button class="ghost" disabled=${!canSync || picked.length < 2 || busy} onClick=${doSync}>Sync by audio</button>
        <button disabled=${picked.length < 2 || picked.length > 9 || busy} onClick=${create}>Create multicam clip</button>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------- inspector

function MulticamInspector({ clip }) {
  const s = useStore()
  const canSync = s.caps.processing?.multicamSync !== false
  const t = useTime()
  const p = viewProject()
  const [busy, setBusy] = useState(false)
  const angles = clip.angles ?? []
  const cuts = clip.cuts ?? []
  const partner = audioPartner(p, clip)
  const setAngles = (next, summary) => edit({ op: 'update', id: clip.id, set: { angles: next } }, summary)
  const setCuts = (next, summary) => {
    const sorted = [...next].sort((a, b) => a.t - b.t)
    if (!sorted.length || sorted[0].t > 1e-6) sorted.unshift({ t: 0, angle: sorted[0]?.angle ?? 0 })
    edit({ op: 'update', id: clip.id, set: { cuts: sorted.filter((c, i, all) => i === 0 || c.angle !== all[i - 1].angle) } }, summary)
  }
  const setAudio = i => {
    const ops = [{ op: 'update', id: clip.id, set: { audioAngle: i } }]
    if (partner) ops.push({ op: 'update', id: partner.id, set: { src: angles[i].src, in: Math.max(0, (clip.in ?? 0) + (partner.start - clip.start) * (clip.speed ?? 1) + (angles[i].offset ?? 0)) } })
    edit(ops, `audio from ${angles[i].label ?? `angle ${i + 1}`}`)
  }
  const resync = async () => {
    setBusy(true)
    try {
      const r = await syncAngles(angles.map(a => a.src))
      const ops = [{ op: 'update', id: clip.id, set: { angles: angles.map((a, i) => ({ ...a, offset: r.offsets[i] })) } }]
      const a = clip.audioAngle ?? 0
      if (partner) ops.push({ op: 'update', id: partner.id, set: { in: Math.max(0, (clip.in ?? 0) + (partner.start - clip.start) * (clip.speed ?? 1) + r.offsets[a]) } })
      await edit(ops, `re-synced ${clip.id} by audio`)
      toast(`Offsets: ${r.offsets.map(o => o.toFixed(3)).join(', ')} s`)
    } catch (error) {
      toast(error.message, 'error')
    }
    setBusy(false)
  }
  const placeAudio = () => {
    const a = clip.audioAngle ?? 0
    const free = p.tracks.find(tr => tr.kind === 'audio' && !tr.locked && !tr.clips.some(x => x.start < clipEnd(clip) && clipEnd(x) > clip.start))
    if (!free) return toast('Add an audio track with room for the clip first', 'error')
    const ops = [{ op: 'add_clip', kind: 'audio', src: angles[a].src, track: free.id, start: clip.start, in: (clip.in ?? 0) + (angles[a].offset ?? 0), dur: clip.dur, ...(clip.speed && clip.speed !== 1 ? { set: { speed: clip.speed } } : {}) }]
    const dry = applyOps(store.project, scopedForDryRun(ops))
    ops.push({ op: 'update', id: clip.id, set: { mute: true } }, { op: 'link', ids: [clip.id, dry.created[0]] })
    edit(ops, `audio angle of ${clip.id} on ${free.id}`)
  }
  const mtNow = mcTime(clip, t)
  const nowAngle = t >= clip.start && t < clipEnd(clip) ? angleAt(clip, mtNow) : null

  return html`
    <div class="section-body">
      <div class="row gap">
        <label class="row gap mc-note"><input type="checkbox" checked=${s.mcViewer !== false} onChange=${e => set({ mcViewer: e.target.checked })} /> Angle viewer</label>
        <span style=${{ flex: 1 }}></span>
        <button class="ghost" disabled=${busy || !canSync} title=${canSync ? '' : 'Open the browser editor to sync by audio'} onClick=${resync}>${busy ? 'Syncing…' : 'Re-sync by audio'}</button>
      </div>
      <h4 style=${{ margin: '4px 0 0' }}>Angles</h4>
      <div class="mc-list">
        ${angles.map((a, i) => html`
          <div class="mc-row">
            <span class="num" style=${{ color: i === nowAngle ? '#ff3b30' : undefined }}>${i + 1}</span>
            <input type="text" value=${a.label ?? ''} title=${a.src} onKeyDown=${e => e.stopPropagation()} onChange=${e => setAngles(angles.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)), `renamed angle ${i + 1}`)} />
            <input type="number" step="0.001" value=${a.offset ?? 0} title="Offset (s): this angle reads its source at multicam time + offset" onKeyDown=${e => e.stopPropagation()} onChange=${e => setAngles(angles.map((x, j) => (j === i ? { ...x, offset: Number(e.target.value) || 0 } : x)), `offset of angle ${i + 1}`)} />
            <label title="Audio angle"><input type="radio" name=${`aa-${clip.id}`} checked=${(clip.audioAngle ?? 0) === i} onChange=${() => setAudio(i)} />♪</label>
          </div>`)}
      </div>
      ${partner ? html`<div class="mc-note">Sound: ${partner.id} on ${p.tracks.find(tr => tr.clips.includes(partner))?.id}, linked, follows the audio angle.</div>` : clip.mute ? html`<div class="mc-note">Muted.</div>` : html`
        <div class="mc-note">Sound follows the selected audio angle. You can move it to a separate track for mixing.</div>
        <button class="ghost" onClick=${placeAudio}>Put the audio angle on an audio track</button>`}
      <h4 style=${{ margin: '6px 0 0' }}>Cuts</h4>
      <div class="mc-list">
        ${cuts.map((cut, i) => html`
          <div class="mc-row">
            <button class="ghost tiny" title="Go to this cut" onClick=${() => player.seek(tlTime(clip, cut.t))}>${timecode(Math.max(0, tlTime(clip, cut.t)), p.fps)}</button>
            <input type="number" step=${1 / p.fps} value=${cut.t} disabled=${i === 0} title="Multicam time (s)" onKeyDown=${e => e.stopPropagation()} onChange=${e => setCuts(cuts.map((x, j) => (j === i ? { ...x, t: Math.max(1 / p.fps, Number(e.target.value) || 0) } : x)), `moved cut ${i + 1}`)} />
            <select value=${cut.angle} onChange=${e => setCuts(cuts.map((x, j) => (j === i ? { ...x, angle: Number(e.target.value) } : x)), `cut ${i + 1} angle`)}>
              ${angles.map((a, j) => html`<option value=${j}>${j + 1} ${a.label ?? ''}</option>`)}
            </select>
            ${i > 0 ? html`<button class="ghost tiny danger" title="Remove this cut" onClick=${() => setCuts(cuts.filter((_, j) => j !== i), `removed cut ${i + 1}`)}>✕</button>` : html`<span style=${{ width: '22px' }}></span>`}
          </div>`)}
      </div>
      <div class="mc-note">Press 1–${Math.min(9, angles.length)} or click an angle in the viewer to cut at the playhead (${timecode(t, p.fps)}).</div>
    </div>
  `
}

// ---------------------------------------------------------------- registration

registerViewerOverlay({ id: 'multicam', order: 30, when: s => s.mcViewer !== false, component: AngleViewer })
registerBrowserTab({ id: 'multicam', label: 'Multicam', order: 60, component: MulticamBrowser })
registerInspector({ id: 'multicam', label: 'Multicam', order: 50, when: c => c.kind === 'multicam', component: MulticamInspector })

registerClipMenu((p, hit) => {
  const c = hit.clip
  if (!c) return []
  const items = []
  const picked = p.tracks.flatMap(t => t.clips).filter(x => store.selection.includes(x.id) && x.kind === 'video' && x.src)
  if (picked.length >= 2 && picked.some(x => x.id === c.id)) {
    const srcs = [...new Set(picked.sort((a, b) => a.start - b.start).map(x => x.src))]
    if (srcs.length >= 2 && srcs.length <= 9) {
      items.push({
        label: `Create multicam clip from ${srcs.length} selected clips (sync by audio)`,
        run: async () => {
          try {
            const r = await syncAngles(srcs)
            await createMulticam(srcs, { offsets: r.offsets, labels: srcs.map(name), at: Math.min(...picked.map(x => x.start)) })
          } catch (error) {
            toast(error.message, 'error')
          }
        },
      })
    }
  }
  if (c.kind === 'multicam') {
    items.push(
      { label: store.mcViewer === false ? 'Show the angle viewer' : 'Hide the angle viewer', run: () => set({ mcViewer: store.mcViewer === false }) },
      { label: 'Cut to angle at the playhead', sub: c.angles.slice(0, 9).map((a, i) => ({ label: `${i + 1}  ${a.label ?? ''}`, hint: String(i + 1), run: () => cutTo(c, i) })) },
      { label: 'Multicam settings…', run: () => set({ selection: [c.id], inspectorTab: 'multicam' }) },
    )
  }

  return items
})
