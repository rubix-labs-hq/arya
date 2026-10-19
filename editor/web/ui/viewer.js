// Viewer: the composited frame with on-canvas transform handles, overlays, the
// transport, and a source monitor for marking and three-point edits.

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { clipEnd, compView, duration, timecode, valueAt } from '/core/project.js'
import { canvas, comp, media, player } from './engine-host.js'
import { addRef, edit, set, store, time, toast, useStore, useTime, viewProject } from './store.js'
import { titleAnim } from '../engine/frame.js'
import { resolvedShape } from '../engine/shapes.js'
import { mediaUrl } from '../engine/media.js'
import { shapeExtent } from './motion/geometry.js'
import { mediaDisplayName } from './media-label.js'
import { sourceAudioWindow, sourcePlacementPlan } from './source-media.js'
import { host as backendHost } from '../host.js'
import { registry } from './registry.js'
import { Icon } from './icons.js'
import { h as hh } from 'preact'

const html = htm.bind(h)

function useFit(box, w, hgt, mode) {
  const [rect, setRect] = useState({ w: 0, h: 0, x: 0, y: 0 })
  useEffect(() => {
    if (!box.current) return
    const ro = new ResizeObserver(() => {
      const el = box.current
      if (!el) return
      const bw = el.clientWidth - 16
      const bh = el.clientHeight - 16
      const s = Math.min(bw / w, bh / hgt)
      const rw = Math.max(1, Math.floor(w * s))
      const rh = Math.max(1, Math.floor(hgt * s))
      setRect({ w: rw, h: rh, x: Math.floor((el.clientWidth - rw) / 2), y: Math.floor((el.clientHeight - rh) / 2) })
    })
    ro.observe(box.current)

    return () => ro.disconnect()
  }, [w, hgt, mode])

  return rect
}

/** The selected clip's quad at time t in project pixels, or null. */
function quadOf(p, c, t) {
  if (!c || c.kind === 'audio' || c.kind === 'adjustment') return null
  const local = t - c.start
  let w = p.width
  let hh = p.height
  const extra = c.kind === 'title' ? titleAnim(c, local) : { dx: 0, dy: 0, scale: 1 }
  if (c.kind === 'video' || c.kind === 'image' || c.kind === 'comp') {
    const a = c.kind === 'comp' && p.comps?.[c.comp] ? compView(p, c.comp) : p.assets[c.src] ?? {}
    const aw = a.width ?? p.width
    const ah = a.height ?? p.height
    const fit = (c.fit === 'cover' ? Math.max : Math.min)(p.width / aw, p.height / ah)
    w = aw * fit
    hh = ah * fit
  } else if (c.kind === 'shape') {
    const { hw, hh: halfHeight } = shapeExtent(resolvedShape(p, c, local))
    w = hw * 2
    hh = halfHeight * 2
  } else if (c.kind === 'title') {
    const cv = media.titles.get(c.id)?.canvas
    const rs = comp.size[0] / p.width
    w = cv ? cv.width / rs : 400
    hh = cv ? cv.height / rs : 120
  }
  const s = valueAt(p, c, 'scale', local) * (extra.scale ?? 1)

  return {
    x: valueAt(p, c, 'x', local) + (extra.dx ?? 0),
    y: valueAt(p, c, 'y', local) + (extra.dy ?? 0),
    w: w * s * valueAt(p, c, 'scaleX', local),
    h: hh * s * valueAt(p, c, 'scaleY', local),
    r: valueAt(p, c, 'rotation', local),
    s,
  }
}

/** Sets a property: a keyframe at the playhead when the property is animated, else the value. */
export function setProp(c, prop, value, summary) {
  const t = time.t
  if (c.anim?.[prop]?.length) return edit({ op: 'keyframe', id: c.id, prop, at: t, value }, summary)

  return edit({ op: 'update', id: c.id, set: { [prop]: value } }, summary)
}

function TransformOverlay({ p, rect }) {
  const t = useTime()
  const sel = store.selection.length === 1 ? p.tracks.flatMap(tr => tr.clips).find(c => c.id === store.selection[0]) : null
  const [drag, setDrag] = useState(null)
  if (!sel || t < sel.start || t >= clipEnd(sel)) return null
  const q = drag?.q ?? quadOf(p, sel, t)
  if (!q) return null
  const k = rect.w / p.width
  const style = {
    left: `${rect.x + (q.x - q.w / 2) * k}px`,
    top: `${rect.y + (q.y - q.h / 2) * k}px`,
    width: `${q.w * k}px`,
    height: `${q.h * k}px`,
    transform: `rotate(${q.r}deg)`,
  }
  const start = (e, mode) => {
    e.stopPropagation()
    e.preventDefault()
    e.target.setPointerCapture(e.pointerId)
    const q0 = quadOf(p, sel, t)
    const cx = rect.x + q0.x * k
    const cy = rect.y + q0.y * k
    setDrag({ mode, x0: e.clientX, y0: e.clientY, q0, q: q0, cx, cy, box: e.currentTarget.closest('.viewer-stage').getBoundingClientRect() })
  }
  const move = e => {
    if (!drag) return
    const { q0 } = drag
    let q = { ...q0 }
    if (drag.mode === 'move') {
      q.x = Math.round(q0.x + (e.clientX - drag.x0) / k)
      q.y = Math.round(q0.y + (e.clientY - drag.y0) / k)
      if (e.shiftKey) {
        if (Math.abs(q.x - p.width / 2) < 12 / k) q.x = p.width / 2
        if (Math.abs(q.y - p.height / 2) < 12 / k) q.y = p.height / 2
      }
    } else if (drag.mode === 'scale') {
      const bx = drag.box.left + drag.cx
      const by = drag.box.top + drag.cy
      const d0 = Math.hypot(drag.x0 - bx, drag.y0 - by)
      const d1 = Math.hypot(e.clientX - bx, e.clientY - by)
      const f = d1 / Math.max(1, d0)
      q.s = Math.max(0.01, Math.round(q0.s * f * 1000) / 1000)
      q.w = (q0.w / q0.s) * q.s
      q.h = (q0.h / q0.s) * q.s
    } else if (drag.mode === 'rotate') {
      const bx = drag.box.left + drag.cx
      const by = drag.box.top + drag.cy
      const a0 = Math.atan2(drag.y0 - by, drag.x0 - bx)
      const a1 = Math.atan2(e.clientY - by, e.clientX - bx)
      let r = q0.r + ((a1 - a0) * 180) / Math.PI
      if (e.shiftKey) r = Math.round(r / 15) * 15
      q.r = Math.round(r * 10) / 10
    }
    setDrag({ ...drag, q })
  }
  const end = () => {
    if (!drag) return
    const { q, q0, mode } = drag
    setDrag(null)
    if (mode === 'move' && (q.x !== q0.x || q.y !== q0.y)) {
      const ops = []
      for (const [prop, v] of [['x', q.x], ['y', q.y]]) {
        if (sel.anim?.[prop]?.length) ops.push({ op: 'keyframe', id: sel.id, prop, at: time.t, value: v })
        else ops.push({ op: 'update', id: sel.id, set: { [prop]: v } })
      }
      edit(ops)
    } else if (mode === 'scale' && q.s !== q0.s) setProp(sel, 'scale', q.s / (sel.kind === 'title' ? titleAnim(sel, time.t - sel.start).scale || 1 : 1))
    else if (mode === 'rotate' && q.r !== q0.r) setProp(sel, 'rotation', q.r)
  }

  return html`
    <div class="xform" style=${style} onPointerDown=${e => start(e, 'move')} onPointerMove=${move} onPointerUp=${end}>
      ${['nw', 'ne', 'sw', 'se'].map(c => html`<div class=${`xh ${c}`} onPointerDown=${e => start(e, 'scale')} onPointerMove=${move} onPointerUp=${end}></div>`)}
      <div class="xrot" onPointerDown=${e => start(e, 'rotate')} onPointerMove=${move} onPointerUp=${end}></div>
      ${drag ? html`<div class="xinfo">${drag.mode === 'move' ? `${Math.round(drag.q.x)}, ${Math.round(drag.q.y)}` : drag.mode === 'scale' ? `${Math.round(drag.q.s * 100)}%` : `${drag.q.r}°`}</div>` : null}
    </div>
  `
}

export function Viewer({ compact }) {
  const s = useStore()
  const p = viewProject()
  const stage = useRef(null)
  const host = useRef(null)
  const rect = useFit(stage, p?.width ?? 1920, p?.height ?? 1080, s.viewerMode)

  useEffect(() => {
    if (host.current && canvas.parentElement !== host.current) host.current.appendChild(canvas)
    player.requestExact()
  }, [host.current, s.viewerMode])

  if (!p) return html`<div class="viewer"></div>`
  if (s.viewerMode === 'source' && s.source) return html`<${SourceViewer} compact=${compact} />`
  const timelineName = p.compId ? s.project?.comps?.[p.compId]?.name ?? p.compId : 'Main timeline'

  const onStageDown = e => {
    if (e.target.closest('.xform')) return
    if (e.altKey) {
      const r = e.currentTarget.getBoundingClientRect()
      const px = Math.round(((e.clientX - r.left - rect.x) / rect.w) * p.width)
      const py = Math.round(((e.clientY - r.top - rect.y) / rect.h) * p.height)
      if (px >= 0 && py >= 0 && px <= p.width && py <= p.height) {
        addRef({ kind: 'frame', id: `${time.t.toFixed(3)}@${px},${py}`, label: `frame ${timecode(time.t, p.fps)} at (${px}, ${py})` })
      }

      return
    }
    // Click selects the topmost clip under the pointer.
    const r = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - r.left - rect.x) / rect.w) * p.width
    const py = ((e.clientY - r.top - rect.y) / rect.h) * p.height
    const tracks = p.tracks.filter(t => t.kind === 'video' && !t.hidden).reverse()
    for (const tr of tracks) {
      const c = tr.clips.find(cc => cc.start <= time.t && time.t < clipEnd(cc) && cc.enabled !== false)
      const q = quadOf(p, c, time.t)
      if (!q) continue
      const dx = px - q.x
      const dy = py - q.y
      const a = (-q.r * Math.PI) / 180
      const lx = dx * Math.cos(a) - dy * Math.sin(a)
      const ly = dx * Math.sin(a) + dy * Math.cos(a)
      if (Math.abs(lx) <= q.w / 2 && Math.abs(ly) <= q.h / 2) {
        set({ selection: [c.id] })

        return
      }
    }
    set({ selection: [] })
  }

  return html`
    <div class=${`viewer ${compact ? 'compact' : ''}`}>
      <div class="viewer-info" aria-label="Active timeline information"><span class="viewer-info-name" title=${timelineName}>${timelineName}</span><span class="viewer-info-format">${p.width}×${p.height} · ${p.fps} fps timeline</span></div>
      <div class="viewer-bar">
        <div class="seg">
          <button class=${s.viewerMode === 'timeline' ? 'on' : ''} onClick=${() => set({ viewerMode: 'timeline' })}>Timeline</button>
          <button class=${s.viewerMode === 'source' ? 'on' : ''} disabled=${!s.source} onClick=${() => set({ viewerMode: 'source' })}>Source</button>
        </div>
        <span class="grow"></span>
        <select value=${s.previewQuality} onChange=${e => set({ previewQuality: e.target.value })} title="Playback resolution" aria-label="Playback resolution">
          <option value="full">Full</option><option value="half">Half</option><option value="quarter">Quarter</option>
        </select>
        <button class=${s.overlays.safe ? 'on' : ''} title="Safe areas" aria-label="Safe areas" aria-pressed=${!!s.overlays.safe} onClick=${() => set({ overlays: { ...s.overlays, safe: !s.overlays.safe } })}><${Icon} name="safe-area" /></button>
        <button class=${s.overlays.grid ? 'on' : ''} title="Rule of thirds" aria-label="Rule of thirds grid" aria-pressed=${!!s.overlays.grid} onClick=${() => set({ overlays: { ...s.overlays, grid: !s.overlays.grid } })}><${Icon} name="grid" /></button>
        <button title="Reference this frame to your assistant (⌥-click a point in the frame for a pixel)" aria-label="Reference this frame to your assistant" onClick=${() => addRef({ kind: 'frame', id: time.t.toFixed(3), label: `frame ${timecode(time.t, p.fps)}` })}><${Icon} name="attach" /></button>
      </div>
      <div class="viewer-stage" ref=${stage} onPointerDown=${onStageDown} onDblClick=${() => player.toggle()}>
        <div class="canvas-host" ref=${host} style=${{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` }}></div>
        ${s.overlays.safe ? html`<div class="safe" style=${{ left: `${rect.x + rect.w * 0.05}px`, top: `${rect.y + rect.h * 0.05}px`, width: `${rect.w * 0.9}px`, height: `${rect.h * 0.9}px` }}><div class="safe-inner"></div></div>` : null}
        ${s.overlays.grid ? html`<div class="thirds" style=${{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` }}></div>` : null}
        ${!s.playing && !registry.viewerOverlays.some(o => o.exclusive?.(store)) ? html`<${TransformOverlay} p=${p} rect=${rect} />` : null}
        ${registry.viewerOverlays.filter(o => o.when?.(store) ?? true).map(o => hh(o.component, { key: o.id, p, rect, t: time.t }))}
      </div>
      <${Transport} p=${p} />
    </div>
  `
}

export function Transport({ p }) {
  const t = useTime()
  const s = store
  const [editing, setEditing] = useState(false)
  const edits = () => [0, duration(p), ...p.markers.map(m => m.t), ...p.tracks.flatMap(tr => tr.clips.flatMap(c => [c.start, clipEnd(c)]))].sort((a, b) => a - b)
  const jump = dir => {
    const pts = edits()
    const target = dir < 0 ? pts.filter(x => x < t - 1e-3).at(-1) : pts.find(x => x > t + 1e-3)
    if (target !== undefined) player.seek(target)
  }

  return html`
    <div class="transport timeline-transport">
      <div class="tc-box">
        ${editing
          ? html`<input class="tc-input" autofocus value=${timecode(t, p.fps)} onKeyDown=${e => {
              if (e.key === 'Enter') {
                const parts = e.target.value.split(/[:;.]/).map(Number)
                while (parts.length < 4) parts.unshift(0)
                const [hh, mm, ss, ff] = parts
                player.seek(hh * 3600 + mm * 60 + ss + ff / p.fps)
                setEditing(false)
              }
              if (e.key === 'Escape') setEditing(false)
              e.stopPropagation()
            }} onBlur=${() => setEditing(false)} />`
          : html`<span class="tc" onClick=${() => setEditing(true)} title="Click to type a timecode">${timecode(t, p.fps)}</span>`}
        <span class="tc-dur">/ ${timecode(duration(p), p.fps)}</span>
      </div>
      <div class="buttons">
        <button aria-label="Go to start" title="Start (Home)" onClick=${() => player.seek(0)}><${Icon} name="skip-start" /></button>
        <button aria-label="Previous edit" title="Previous edit (↑)" onClick=${() => jump(-1)}><${Icon} name="prev-edit" /></button>
        <button aria-label="Back one frame" title="Back a frame (←)" onClick=${() => player.step(-1)}><${Icon} name="step-back" /></button>
        <button class="play" aria-label=${s.playing ? 'Pause' : 'Play'} title="Play/Pause (Space) · J K L shuttle" onClick=${() => player.toggle()}>${s.playing ? (s.rate !== 1 ? `${s.rate}×` : html`<${Icon} name="pause" />`) : html`<${Icon} name="play" />`}</button>
        <button aria-label="Forward one frame" title="Forward a frame (→)" onClick=${() => player.step(1)}><${Icon} name="step-forward" /></button>
        <button aria-label="Next edit" title="Next edit (↓)" onClick=${() => jump(1)}><${Icon} name="next-edit" /></button>
        <button aria-label="Go to end" title="End (End)" onClick=${() => player.seek(duration(p))}><${Icon} name="skip-end" /></button>
      </div>
      <div class="buttons right">
        <button aria-label="Mark in" title="Mark in (I)" onClick=${() => edit({ op: 'range', in: t, out: Math.max(t + 1 / p.fps, p.range?.out ?? duration(p)) })}>I</button>
        <button aria-label="Mark out" title="Mark out (O)" onClick=${() => edit({ op: 'range', in: Math.min(p.range?.in ?? 0, t - 1 / p.fps), out: t })}>O</button>
        <button aria-label="Clear range" title="Clear range (⌥X)" disabled=${!p.range} onClick=${() => edit({ op: 'range', in: null })}><${Icon} name="clear" /></button>
        <button class=${s.loop ? 'on' : ''} aria-label="Loop playback" aria-pressed=${!!s.loop} title="Loop playback (⌘L)" onClick=${() => set({ loop: !s.loop })}><${Icon} name="loop" /></button>
      </div>
    </div>
  `
}

function SourceViewer({ compact } = {}) {
  const s = useStore()
  const p = viewProject()
  const src = s.source
  const sourceContext = { root: s.root, version: s.version, project: s.project, composition: s.openComp }
  const video = useRef(null)
  const [t, setT] = useState(src.t ?? 0)
  const [playing, setPlaying] = useState(false)
  const [fallbackSource, setFallbackSource] = useState(null)
  const [browserAudio, setBrowserAudio] = useState(null)
  const [audioPosition, setAudioPosition] = useState(src.t ?? 0)
  const seekTarget = useRef(src.t ?? 0), resumePlayback = useRef(false)
  const asset = p.assets[src.src] ?? {}
  const isImage = asset.hasVideo && !asset.duration
  const dur = Number.isFinite(asset.duration) && asset.duration > 0 ? asset.duration : 5
  const audioOnly = asset.hasAudio && !asset.hasVideo
  const fallback = audioOnly && (backendHost.kind === 'browser-local' || fallbackSource === src.src || /\.aiff?$/i.test(src.src))
  const audioWindow = fallback ? sourceAudioWindow(src.src, dur, audioPosition) : null
  const offset = audioWindow?.from ?? 0
  const browserAudioKey = audioWindow ? `${s.root}:${src.src}:${audioWindow.from}:${audioWindow.duration}` : null
  useEffect(() => {
    if (backendHost.kind !== 'browser-local' || !audioWindow) return
    const controller = new AbortController()
    backendHost.browser.prepareSourceAudio(src.src, audioWindow.from, audioWindow.duration, controller.signal).then(url => { if (!controller.signal.aborted) setBrowserAudio({ key: browserAudioKey, url }) }).catch(error => { if (!controller.signal.aborted) toast(error.message, 'error') })
    return () => controller.abort()
  }, [browserAudioKey])
  const url = backendHost.kind === 'browser-local' && audioWindow ? browserAudio?.key === browserAudioKey ? browserAudio.url : undefined : audioWindow?.url ?? mediaUrl(p, src.src)
  const seek = value => {
    const target = Math.max(0, Math.min(dur, value))
    seekTarget.current = target
    setT(target)
    const v = video.current
    if (fallback && sourceAudioWindow(src.src, dur, target).from !== offset) {
      resumePlayback.current = Boolean(v && !v.paused)
      setAudioPosition(target)
    } else if (v?.readyState >= 1) v.currentTime = target - offset
  }
  const toggle = () => {
    const v = video.current
    if (!v) return
    if (v.paused) v.play().catch(error => toast(error.message || 'Unable to play this source', 'error'))
    else v.pause()
  }

  useEffect(() => {
    const v = video.current
    if (!v) return
    const tick = () => setT(Math.min(dur, offset + v.currentTime))
    const playback = () => setPlaying(!v.paused)
    const loaded = () => {
      v.currentTime = Math.max(0, Math.min(v.duration || dur, seekTarget.current - offset))
      if (resumePlayback.current) { resumePlayback.current = false; v.play().catch(error => toast(error.message, 'error')) }
    }
    const failed = () => {
      if (!audioOnly || fallback) return
      setAudioPosition(seekTarget.current)
      setFallbackSource(src.src)
    }
    const ended = () => {
      const next = offset + (audioWindow?.duration ?? dur)
      if (!fallback || next >= dur - 0.001) return
      seekTarget.current = next
      resumePlayback.current = true
      setAudioPosition(next); setT(next)
    }
    v.addEventListener('timeupdate', tick)
    v.addEventListener('seeked', tick)
    v.addEventListener('loadedmetadata', loaded)
    v.addEventListener('error', failed)
    v.addEventListener('ended', ended)
    v.addEventListener('play', playback)
    v.addEventListener('pause', playback)
    playback()
    if (v.readyState >= 1) loaded()
    else if (v.error) failed()

    return () => {
      v.removeEventListener('timeupdate', tick)
      v.removeEventListener('seeked', tick)
      v.removeEventListener('loadedmetadata', loaded)
      v.removeEventListener('error', failed)
      v.removeEventListener('ended', ended)
      v.removeEventListener('play', playback)
      v.removeEventListener('pause', playback)
    }
  }, [url, offset])

  useEffect(() => { resumePlayback.current = false; seek(src.t ?? 0) }, [src.src, src.t, src.seekToken])

  useEffect(() => {
    const onKey = e => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || store.settingsOpen || store.viewerMode !== 'source' || e.target.closest?.('input, textarea, select, [contenteditable], [role="dialog"], [role="alertdialog"], dialog, button, summary, a[href], [role="button"], [role="tab"]')) return
      const v = video.current
      const k = e.key.toLowerCase()
      if (k === 'i') setSrc({ in: offset + (v?.currentTime ?? 0) })
      else if (k === 'o') setSrc({ out: offset + (v?.currentTime ?? dur - offset) })
      else if (k === ' ' && v) toggle()
      else if (k === 'e' || k === 'w' || k === 'd' || k === 'q') place({ e: 'append', w: 'insert', d: 'overwrite', q: 'connect' }[k])
      else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)

    return () => window.removeEventListener('keydown', onKey, true)
  })

  const setSrc = patch => set({ source: { ...store.source, ...patch } })
  const place = how => {
    if (sourceContext.root !== store.root || sourceContext.version !== store.version || sourceContext.composition !== store.openComp || sourceContext.project !== store.project || src !== store.source) return toast('The project or source changed. Open the source again before placing it.', 'error')
    try {
      edit(sourcePlacementPlan(p, src, how, time.t), `${how} ${mediaDisplayName(src.src, asset)}`, { expectedVersion: sourceContext.version })
    } catch (error) { toast(error.message, 'error') }
  }
  const pct = x => `${(x / dur) * 100}%`

  return html`
    <div class=${`viewer source ${compact ? 'compact' : ''}`} >
      <div class="viewer-bar">
        <div class="seg">
          <button onClick=${() => set({ viewerMode: 'timeline' })}>Timeline</button>
          <button class="on">Source</button>
        </div>
        <span class="src-name">${mediaDisplayName(src.src, asset)}</span>
        <span class="grow"></span>
        <span class="muted">${asset.width ? `${asset.width}×${asset.height}` : ''} ${asset.fps ? `${asset.fps}fps` : ''} ${asset.codec ?? ''}</span>
      </div>
      <div class="viewer-stage src">
        ${isImage ? html`<img class="src-media" src=${url} />` : audioOnly ? html`<div class="empty-hint" onClick=${toggle}><span style="font-size:40px">♪</span><br />${mediaDisplayName(src.src, asset)}<br /><span class="muted">Audio source</span></div><audio ref=${video} src=${url} preload="auto"></audio>` : html`<video class="src-media" ref=${video} src=${url} controls=${false} onClick=${toggle}></video>`}
      </div>
      ${isImage ? null : html`
        <div class="src-scrub" onPointerDown=${e => {
          const r = e.currentTarget.getBoundingClientRect()
          const go = ev => seek(Math.max(0, Math.min(dur, ((ev.clientX - r.left) / r.width) * dur)))
          go(e)
          const mv = ev => go(ev)
          const up = () => (removeEventListener('pointermove', mv), removeEventListener('pointerup', up))
          addEventListener('pointermove', mv)
          addEventListener('pointerup', up)
        }}>
          <div class="src-range" style=${{ left: pct(src.in ?? 0), width: pct((src.out ?? dur) - (src.in ?? 0)) }}></div>
          <div class="src-head" style=${{ left: pct(t) }}></div>
        </div>`}
      <div class="transport">
        <div class="tc-box"><span class="tc">${timecode(t, Math.round(asset.fps || p.fps))}</span><span class="tc-dur">in ${timecode(src.in ?? 0, p.fps)} · out ${timecode(src.out ?? dur, p.fps)}</span></div>
        <div class="buttons">
          <button aria-label="Mark source in" title="Mark in (I)" onClick=${() => setSrc({ in: offset + (video.current?.currentTime ?? 0) })}>I</button>
          <button class="play" aria-label=${playing ? 'Pause source' : 'Play source'} title="Play/Pause source (Space)" onClick=${toggle}>${playing ? html`<${Icon} name="pause" />` : html`<${Icon} name="play" />`}</button>
          <button aria-label="Mark source out" title="Mark out (O)" onClick=${() => setSrc({ out: offset + (video.current?.currentTime ?? dur - offset) })}>O</button>
        </div>
        <div class="buttons right">
          <button title="Append to end (E)" onClick=${() => place('append')}>Append</button>
          <button title="Insert at playhead, ripple (W)" onClick=${() => place('insert')}>Insert</button>
          <button title="Overwrite at playhead (D)" onClick=${() => place('overwrite')}>Overwrite</button>
          <button title="Connect above (Q)" onClick=${() => place('connect')}>Connect</button>
        </div>
      </div>
    </div>
  `
}
