// Motion tracking, stabilization and optical-flow retiming in the editor.
//
// - Track tool (⌖) and viewer overlay: draw a box (two for scale and rotation) on a video
//   clip, track forward or backward in a worker (engine/tracker-worker.js), see the path.
// - Track tab: apply the track as keyframes to another layer (match move, offset kept), to
//   the clip's mask, to a node window, or as an inverse transform (stabilize on the track).
// - Stabilize tab: global motion analysis, path smoothing, crop zoom, x/y/rotation/scale
//   keyframes; or an ffmpeg deshake render that replaces the clip's media.
// - Speed tab and clip menu: optical-flow slow motion (minterpolate render) or frame blending.

import { h } from 'preact'
import { useState } from 'preact/hooks'
import htm from 'htm'
import { baseValue, clipEnd, sourceTime, timecode, valueAt } from '/core/project.js'
import { worldMatrix } from '../../engine/frame.js'
import { frameCenter, mediaUrl } from '../../engine/media.js'
import {
  accumulate, applyMatrix, corrections, coverZoom, fitScale, invertMatrix, keyframeOps, layerToSource, matchMoveValues,
  pairTransform, smoothPath, sourceToLayer, stabilizeValues, TrackerClient,
} from '../../engine/tracker.js'
import { player } from '../engine-host.js'
import { registerClipMenu, registerInspector, registerTool, registerViewerOverlay } from '../registry.js'
import { api, edit, set, store, time, toast, useStore, useTime, viewProject } from '../store.js'

const html = htm.bind(h)
const client = new TrackerClient()

// ---------------------------------------------------------------- styles

const css = `
.trk-layer { position: absolute; z-index: 4; }
.trk-layer.draw { cursor: crosshair; }
.trk-layer svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.trk-hud { position: absolute; left: 8px; top: 8px; background: #000000b0; color: #fff; font-size: 11.5px; padding: 3px 8px; border-radius: 5px; pointer-events: none; white-space: nowrap; }
.trk-bar { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; flex: 1; }
.trk-bar > div { height: 100%; background: var(--accent); }
.trk-note { font-size: 11.5px; color: var(--muted); line-height: 1.35; }
.trk-note.warn { color: #f0a35e; }
.trk-seg { display: flex; gap: 4px; }
.trk-seg button.on { background: #f5b9421a; border-color: #f5b94266; color: var(--accent); }
`
if (typeof document !== 'undefined' && !document.getElementById('trk-style')) {
  const el = document.createElement('style')
  el.id = 'trk-style'
  el.textContent = css
  document.head.appendChild(el)
}

// ---------------------------------------------------------------- clip frames and coordinates

/** Facts about a video clip in a view: source size, fit, frame count. */
function info(p, c) {
  const a = p.assets[c.src] ?? {}
  const W = a.width ?? p.width
  const H = a.height ?? p.height

  return { W, H, fit: fitScale(W, H, p.width, p.height), fps: p.fps, n: Math.max(1, Math.round(c.dur * p.fps)), assetFps: a.fps || p.fps }
}

/** Clip frame k plays at timeline time c.start + k / fps (sampled just after, as exports do). */
const frameTime = (p, c, k) => c.start + (k + 1e-4) / p.fps
const frameAt = (p, c, t) => Math.max(0, Math.min(Math.max(1, Math.round(c.dur * p.fps)) - 1, Math.floor((t - c.start) * p.fps + 1e-4)))
const sourceFrame = (p, c, k, assetFps) => frameCenter(sourceTime(p, c, frameTime(p, c, k)), assetFps)

/** Source px → project (canvas) px at clip frame k, through the clip's world transform. */
function toCanvas(p, c, k, u, v, inf = info(p, c)) {
  return applyMatrix(worldMatrix(p, c, frameTime(p, c, k)), ...sourceToLayer(u, v, inf.W, inf.H, inf.fit))
}

function toSource(p, c, t, X, Y, inf = info(p, c)) {
  return layerToSource(...applyMatrix(invertMatrix(worldMatrix(p, c, t)), X, Y), inf.W, inf.H, inf.fit)
}

const isVideo = c => c?.kind === 'video' && c.src
const clipName = c => c.label ?? c.title?.text?.split('\n')[0] ?? String(c.src ?? c.kind).split('/').pop()

function viewClip(p, id) {
  for (const t of p?.tracks ?? []) for (const c of t.clips) if (c.id === id) return { clip: c, track: t }

  return null
}

/** The clip the tracker works on: the tracked one, else the selected video clip, else the top one under the playhead. */
function activeClip(p, t) {
  const tracked = store.trk?.clipId && viewClip(p, store.trk.clipId)?.clip
  if (tracked) return tracked
  const sel = store.selection.length === 1 ? viewClip(p, store.selection[0])?.clip : null
  if (isVideo(sel)) return sel
  for (const tr of [...p.tracks].reverse()) {
    if (tr.kind !== 'video' || tr.hidden) continue
    const c = tr.clips.find(x => x.start <= t + 1e-6 && t < clipEnd(x) - 1e-6 && x.enabled !== false)
    if (isVideo(c)) return c
  }

  return null
}

// ---------------------------------------------------------------- track state

function trackOf(clipId) {
  return store.trk?.clipId === clipId ? store.trk : null
}

function setTrack(patch) {
  set(s => ({ trk: { ...(s.trk ?? {}), ...patch } }))
}

function newTrack(clipId, mode = 'point') {
  set({ trk: { clipId, mode, boxes: [], k0: null, results: {}, busy: null, lostAt: null, next: 0 } })
}

/** Boxes (source px, center and size) to start tracking from at clip frame k. */
function boxesAt(trk, k) {
  const need = trk.mode === 'pair' ? 2 : 1
  const r = trk.results[k]
  if (r && r.pts.length >= need && trk.boxes.length >= need) return r.pts.slice(0, need).map((pt, i) => ({ x: pt[0], y: pt[1], w: trk.boxes[i].w, h: trk.boxes[i].h }))
  if (trk.k0 === k && trk.boxes.length >= need) return trk.boxes.slice(0, need)

  return null
}

function trackRange(p, c, dir, useRange) {
  const inf = info(p, c)
  let lo = 0
  let hi = inf.n - 1
  if (useRange && p.range) {
    lo = Math.max(lo, frameAt(p, c, Math.max(c.start, p.range.in)))
    hi = Math.min(hi, frameAt(p, c, Math.min(clipEnd(c) - 1e-6, p.range.out - 1e-6)))
  }

  return dir > 0 ? [lo, hi] : [hi, lo]
}

async function runTrack(dir, useRange) {
  const p = viewProject()
  const trk = store.trk
  const c = trk && viewClip(p, trk.clipId)?.clip
  if (!c) return toast('Pick a video clip and draw a tracking box first', 'error')
  const origin = { root: store.root, version: store.version, project: store.project, comp: store.openComp, id: c.id, src: c.src,
    clip: JSON.stringify(c), asset: JSON.stringify(p.assets?.[c.src]), canvas: JSON.stringify([p.width, p.height, p.fps]) }
  const contextCurrent = () => {
    const current = viewProject()
    return store.root === origin.root && store.version === origin.version && store.project === origin.project && store.openComp === origin.comp
      && JSON.stringify(viewClip(current, origin.id)?.clip) === origin.clip && JSON.stringify(current?.assets?.[origin.src]) === origin.asset
      && JSON.stringify([current?.width, current?.height, current?.fps]) === origin.canvas
  }
  const inf = info(p, c)
  const k = frameAt(p, c, time.t)
  const boxes = boxesAt(trk, k)
  if (!boxes) return toast(trk.mode === 'pair' ? 'Draw two boxes on this frame, or park the playhead on a tracked frame' : 'Draw a box on this frame, or park the playhead on a tracked frame', 'error')
  const [, end] = trackRange(p, c, dir, useRange)
  if ((dir > 0 && k >= end) || (dir < 0 && k <= end)) return toast('Nothing left to track in that direction')
  const ks = []
  for (let i = k; dir > 0 ? i <= end : i >= end; i += dir) ks.push(i)
  // Results past the start in this direction come from an older run: drop them.
  const results = { ...trk.results }
  for (const key of Object.keys(results)) if ((Number(key) - k) * dir > 0) delete results[key]
  const aw = Math.min(inf.W, 1280)
  const ah = Math.max(2, Math.round((inf.H * aw) / inf.W))
  let ownedTrack = trk, stale = false
  const accept = () => {
    if (!stale && store.trk === ownedTrack && store.trk?.busy?.id === id && contextCurrent()) return true
    if (!stale) {
      stale = true
      client.cancel(id)
      // Retire only our stale state. A new drawing or worker owns a different object.
      if (store.trk === ownedTrack && store.trk?.busy?.id === id) set({ trk: null })
    }
    return false
  }
  const updateOwned = patch => { setTrack(patch); ownedTrack = store.trk }
  const merge = list => {
    const cur = { ...(store.trk?.results ?? results) }
    for (const r of list) cur[r.k] = r

    return cur
  }
  const { id, promise } = client.run(
    { type: 'track', url: mediaUrl(p, c.src), frames: ks.map(kk => ({ k: kk, s: sourceFrame(p, c, kk, inf.assetFps) })), width: aw, height: ah, srcWidth: inf.W, srcHeight: inf.H, points: boxes },
    (done, total, list) => { if (accept()) updateOwned({ results: merge(list), busy: { id, dir, done, total } }) },
  )
  updateOwned({ results, busy: { id, dir, done: 0, total: ks.length }, lostAt: null, k0: trk.k0 ?? k })
  try {
    const r = await promise
    if (!accept()) return
    updateOwned({ results: merge(r.results ?? []), busy: null, lostAt: r.lostAt ?? null })
    const n = Object.keys(store.trk.results).length
    if (r.cancelled) toast('Tracking cancelled')
    else if (r.lostAt !== null && r.lostAt !== undefined) toast(`Lost the track at ${timecode(frameTime(p, c, r.lostAt), p.fps)}: draw the box again there and continue`, 'error')
    else toast(`Tracked ${n} frames`)
  } catch (error) {
    if (!accept()) return
    updateOwned({ busy: null })
    toast(error.message, 'error')
  }
}

function trackedFrames(trk) {
  return Object.keys(trk?.results ?? {}).map(Number).sort((a, b) => a - b)
}

// ---------------------------------------------------------------- applying a track

function refFrame(trk, ks) {
  return ks.includes(trk.k0) ? trk.k0 : ks[0]
}

async function applyMatchMove(p, c, trk, targetId, tol) {
  const T = viewClip(p, targetId)?.clip
  if (!T) return toast('Pick a layer to move', 'error')
  if (T.parent) return toast(`${T.id} has a parent: unparent it to match move it`, 'error')
  const inf = info(p, c)
  const ks = trackedFrames(trk).filter(k => {
    const t = c.start + k / p.fps

    return t >= T.start - 1e-6 && t < clipEnd(T) - 1e-6
  })
  if (ks.length < 2) return toast(`${T.id} does not overlap the tracked frames`, 'error')
  const pair = trk.mode === 'pair' && trk.results[ks[0]].pts.length >= 2
  const pts = ks.map(k => toCanvas(p, c, k, ...trk.results[k].pts[0], inf))
  const ref = ks.indexOf(refFrame(trk, ks))
  let pairs = null
  if (pair) {
    const second = ks.map(k => toCanvas(p, c, k, ...trk.results[k].pts[1], inf))
    pairs = ks.map((_, i) => pairTransform(pts[i], second[i], pts[ref], second[ref]))
  }
  const local = k => c.start + k / p.fps - T.start
  const base = i => ({ x: valueAt(p, T, 'x', local(ks[i])), y: valueAt(p, T, 'y', local(ks[i])), rotation: valueAt(p, T, 'rotation', local(ks[i])), scale: valueAt(p, T, 'scale', local(ks[i])) })
  const vals = matchMoveValues(pts, ref, base, pairs)
  const samples = ks.map((k, i) => ({ local: local(k), values: vals[i] }))
  const ops = keyframeOps(T.id, samples, { x: tol, y: tol, rotation: 0.02, scale: 0.0005 })
  const r = await edit(ops, `match move ${T.id} to the track on ${c.id}`)
  if (r) toast(`${T.id} follows the track: ${ops.filter(o => o.op === 'keyframe').length} keyframes`)
}

/** Next mask id the core will give (same rule as add_mask). */
const nextMaskId = c => `mk${(c.masks ?? []).reduce((m, x) => Math.max(m, Number(String(x.id).slice(2)) || 0), 0) + 1}`

async function applyMask(p, c, trk, maskId, tol) {
  const inf = info(p, c)
  const ks = trackedFrames(trk)
  if (ks.length < 2) return toast('Track some frames first', 'error')
  const ops = []
  let id = maskId
  let m = (c.masks ?? []).find(x => x.id === maskId)
  if (maskId === 'new') {
    const b = trk.boxes[0] ?? { x: trk.results[ks[0]].pts[0][0], y: trk.results[ks[0]].pts[0][1], w: 120, h: 120 }
    const [x, y] = sourceToLayer(b.x, b.y, inf.W, inf.H, inf.fit)
    id = nextMaskId(c)
    m = { id, type: 'rect', x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, w: Math.round(b.w * inf.fit), h: Math.round(b.h * inf.fit), feather: 8 }
    ops.push({ op: 'add_mask', id: c.id, mask: { type: 'rect', x: m.x, y: m.y, w: m.w, h: m.h, feather: 8 } })
  }
  if (!m) return toast('Pick a mask', 'error')
  const pair = trk.mode === 'pair' && trk.results[ks[0]].pts.length >= 2
  const L = ks.map(k => sourceToLayer(...trk.results[k].pts[0], inf.W, inf.H, inf.fit))
  const ref = ks.indexOf(refFrame(trk, ks))
  const pairs = pair ? ks.map((k, i) => pairTransform(trk.results[k].pts[0], trk.results[k].pts[1], trk.results[ks[ref]].pts[0], trk.results[ks[ref]].pts[1])) : null
  const keyed = prop => c.anim?.[`mask.${id}.${prop}`]?.length
  const base = i => ({ x: keyed('x') ? valueAt(p, c, `mask.${id}.x`, ks[i] / p.fps) : m.x ?? 0, y: keyed('y') ? valueAt(p, c, `mask.${id}.y`, ks[i] / p.fps) : m.y ?? 0, rotation: 0, scale: 1 })
  const vals = matchMoveValues(L, ref, base, pairs)
  const samples = ks.map((k, i) => {
    const values = { [`mask.${id}.x`]: vals[i].x, [`mask.${id}.y`]: vals[i].y }
    if (pairs && m.w) values[`mask.${id}.w`] = m.w * pairs[i].rho
    if (pairs && m.h) values[`mask.${id}.h`] = m.h * pairs[i].rho

    return { local: k / p.fps, values }
  })
  ops.push(...keyframeOps(c.id, samples, { [`mask.${id}.x`]: tol, [`mask.${id}.y`]: tol, [`mask.${id}.w`]: tol, [`mask.${id}.h`]: tol }))
  const r = await edit(ops, `mask ${id} on ${c.id} follows the track`)
  if (r) toast(`Mask ${id}: ${ops.filter(o => o.op === 'keyframe').length} position keyframes written`)
}

async function applyWindow(p, c, trk, nodeId, tol) {
  const inf = info(p, c)
  const ks = trackedFrames(trk)
  if (ks.length < 2) return toast('Track some frames first', 'error')
  const n = c.nodes?.list.find(x => x.id === nodeId)
  if (!n) return toast('Pick a corrector node', 'error')
  const ops = []
  let win = n.window
  if (!win) {
    const b = trk.boxes[0] ?? { x: trk.results[ks[0]].pts[0][0], y: trk.results[ks[0]].pts[0][1], w: inf.W / 5, h: inf.H / 5 }
    win = { type: 'circle', x: (b.x + 0.5) / inf.W, y: (b.y + 0.5) / inf.H, w: b.w / inf.W, h: b.h / inf.H, softness: 0.05 }
    ops.push({ op: 'node_update', id: c.id, node: nodeId, set: { window: win } })
  }
  const key = prop => `node.${nodeId}.window.${prop}`
  const ref = ks.indexOf(refFrame(trk, ks))
  const pair = trk.mode === 'pair' && trk.results[ks[0]].pts.length >= 2
  const pairs = pair ? ks.map(k => pairTransform(trk.results[k].pts[0], trk.results[k].pts[1], trk.results[ks[ref]].pts[0], trk.results[ks[ref]].pts[1])) : null
  // Work in source px (window x, y are 0…1 of the source plane).
  const pts = ks.map(k => trk.results[k].pts[0])
  const base = i => {
    const wx = c.anim?.[key('x')]?.length ? valueAt(p, c, key('x'), ks[i] / p.fps) : win.x
    const wy = c.anim?.[key('y')]?.length ? valueAt(p, c, key('y'), ks[i] / p.fps) : win.y

    return { x: wx * inf.W - 0.5, y: wy * inf.H - 0.5, rotation: win.rotation ?? 0, scale: 1 }
  }
  const vals = matchMoveValues(pts, ref, base, pairs)
  const samples = ks.map((k, i) => {
    const values = { [key('x')]: (vals[i].x + 0.5) / inf.W, [key('y')]: (vals[i].y + 0.5) / inf.H }
    if (pairs) {
      values[key('rotation')] = vals[i].rotation
      if (win.w) values[key('w')] = win.w * pairs[i].rho
      if (win.h) values[key('h')] = win.h * pairs[i].rho
    }

    return { local: k / p.fps, values }
  })
  const tolRel = tol / inf.W
  ops.push(...keyframeOps(c.id, samples, { [key('x')]: tolRel, [key('y')]: tolRel, [key('w')]: tolRel, [key('h')]: tolRel, [key('rotation')]: 0.05 }))
  const r = await edit(ops, `node ${nodeId} window on ${c.id} follows the track`)
  if (r) toast(`Window on ${nodeId}: ${ops.filter(o => o.op === 'keyframe').length} keyframes written`)
}

/** The clip's own transform without keyframes (stabilization replaces x, y, rotation, scale keys). */
function staticTransform(p, c) {
  return Object.fromEntries(['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'anchorX', 'anchorY'].map(k => [k, baseValue(p, c, k)]))
}

/** Writes stabilization keys for camera path `path` (similarities, centered source px) at clip frames ks. */
async function writeStabilization(p, c, ks, path, options, summary) {
  const inf = info(p, c)
  const sigma = options.smooth * p.fps
  const smooth = smoothPath(path, sigma, { lock: options.lock, lockIndex: options.lockIndex ?? 0 })
  const corrs = corrections(path, smooth)
  const zoom = options.crop ? coverZoom(corrs, inf.W, inf.H, options.maxZoom ?? 1.5) : 1
  const base = staticTransform(p, c)
  const vals = stabilizeValues(corrs, () => base, inf.fit, zoom)
  const samples = ks.map((k, i) => ({ local: k / p.fps, values: options.translateOnly ? { x: vals[i].x, y: vals[i].y, ...(zoom > 1 ? { scale: vals[i].scale } : {}) } : vals[i] }))
  const ops = keyframeOps(c.id, samples, { x: 0.05, y: 0.05, rotation: 0.005, scale: 0.0002 })
  const r = await edit(ops, summary)
  if (r) toast(`Stabilized ${c.id}: ${ops.filter(o => o.op === 'keyframe').length} keyframes${zoom > 1.0005 ? `, ${((zoom - 1) * 100).toFixed(1)}% zoom to hide the edges` : ''}`)

  return zoom
}

function trackPath(p, c, trk) {
  const inf = info(p, c)
  const ks = trackedFrames(trk)
  const ref = refFrame(trk, ks)
  const cx = (inf.W - 1) / 2
  const cy = (inf.H - 1) / 2
  const pair = trk.mode === 'pair' && trk.results[ks[0]]?.pts.length >= 2
  const r0 = trk.results[ref].pts

  return {
    ks,
    lockIndex: ks.indexOf(ref),
    path: ks.map(k => {
      const pts = trk.results[k].pts
      if (!pair) return { a: 1, b: 0, tx: pts[0][0] - r0[0][0], ty: pts[0][1] - r0[0][1] }
      const { rho, theta } = pairTransform(pts[0], pts[1], r0[0], r0[1])
      const a = rho * Math.cos(theta)
      const b = rho * Math.sin(theta)
      const ux = r0[0][0] - cx
      const uy = r0[0][1] - cy

      return { a, b, tx: pts[0][0] - cx - (a * ux - b * uy), ty: pts[0][1] - cy - (b * ux + a * uy) }
    }),
    pair,
  }
}

// ---------------------------------------------------------------- viewer overlay

function TrackOverlay({ p, rect }) {
  const s = useStore()
  const t = useTime()
  const [drag, setDrag] = useState(null)
  const c = activeClip(p, t)
  const drawing = s.tool === 'track'
  if (!c) return drawing ? html`<div class="trk-layer" style=${{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`, pointerEvents: 'none' }}><div class="trk-hud">Park the playhead on a video clip to track it</div></div>` : null
  const inf = info(p, c)
  const k = rect.w / p.width
  const trk = trackOf(c.id)
  const inClip = t >= c.start && t < clipEnd(c)
  const kNow = frameAt(p, c, t)
  const screen = (kk, u, v) => {
    const [X, Y] = toCanvas(p, c, kk, u, v, inf)

    return [X * k, Y * k]
  }
  const boxPoly = (kk, b) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => screen(kk, b.x + (sx * b.w) / 2, b.y + (sy * b.h) / 2).join(',')).join(' ')
  const ks = trackedFrames(trk)
  const paths = []
  if (trk && ks.length > 1) {
    const n = trk.results[ks[0]].pts.length
    for (let i = 0; i < n; i++) paths.push(ks.filter(kk => trk.results[kk].pts[i]).map(kk => screen(kk, trk.results[kk].pts[i][0], trk.results[kk].pts[i][1]).join(',')).join(' '))
  }
  const now = trk?.results[kNow]
  const shown = !inClip ? [] : now ? now.pts.map((pt, i) => ({ x: pt[0], y: pt[1], w: trk.boxes[i]?.w ?? 60, h: trk.boxes[i]?.h ?? 60, score: pt[2] })) : trk?.k0 === kNow ? trk.boxes.map(b => ({ ...b, score: 1 })) : []

  const local = e => {
    const r = e.currentTarget.getBoundingClientRect()

    return [e.clientX - r.left, e.clientY - r.top]
  }
  const down = e => {
    if (!drawing || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    if (!inClip) return toast('Park the playhead inside the clip to draw a box')
    e.currentTarget.setPointerCapture(e.pointerId)
    const [x, y] = local(e)
    setDrag({ x0: x, y0: y, x1: x, y1: y })
  }
  const move = e => {
    if (!drag) return
    const [x1, y1] = local(e)
    setDrag({ ...drag, x1, y1 })
  }
  const up = () => {
    if (!drag) return
    setDrag(null)
    const corners = [[drag.x0, drag.y0], [drag.x1, drag.y0], [drag.x1, drag.y1], [drag.x0, drag.y1]].map(([x, y]) => toSource(p, c, t, x / k, y / k, inf))
    const xs = corners.map(q => q[0])
    const ys = corners.map(q => q[1])
    const w = Math.max(...xs) - Math.min(...xs)
    const hh = Math.max(...ys) - Math.min(...ys)
    if (w < 8 || hh < 8) return toast('Drag a box around a detail with some texture (at least 8 px)')
    const box = { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2, w, h: hh }
    if (!trk) newTrack(c.id, store.trkMode ?? 'point')
    const cur = store.trk
    const boxes = cur.k0 === kNow ? [...cur.boxes] : []
    const slot = cur.mode === 'pair' ? (cur.k0 === kNow ? cur.next ?? 0 : 0) : 0
    boxes[slot] = box
    // A box redrawn mid-track restarts the track from this frame.
    const results = cur.k0 === kNow || !cur.results[kNow] ? cur.results : {}
    setTrack({ boxes, k0: kNow, next: cur.mode === 'pair' ? (slot + 1) % 2 : 0, results, lostAt: null })
  }
  const hud = trk?.busy
    ? `Tracking ${trk.busy.dir > 0 ? '▶' : '◀'} ${trk.busy.done}/${trk.busy.total}`
    : drawing ? (trk?.mode === 'pair' ? `Two-point: drag box ${((trk?.k0 === kNow ? trk.next : 0) ?? 0) + 1} of 2 on ${c.id}` : `Drag a box around a detail on ${c.id}`) : `Track on ${c.id}: ${ks.length} frames`

  return html`
    <div class=${`trk-layer ${drawing ? 'draw' : ''}`} style=${{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`, pointerEvents: drawing ? 'auto' : 'none' }}
      onPointerDown=${down} onPointerMove=${move} onPointerUp=${up}>
      <svg width=${rect.w} height=${rect.h}>
        ${paths.map(pts => html`<polyline points=${pts} fill="none" stroke="#f5b942" stroke-width="1.5" stroke-opacity="0.85" />`)}
        ${shown.map(b => html`<polygon points=${boxPoly(kNow, b)} fill="none" stroke=${b.score >= 0.8 ? '#3fb950' : '#f0a35e'} stroke-width="1.5" />`)}
        ${shown.map(b => {
          const [x, y] = screen(kNow, b.x, b.y)

          return html`<g><line x1=${x - 6} y1=${y} x2=${x + 6} y2=${y} stroke="#fff" /><line x1=${x} y1=${y - 6} x2=${x} y2=${y + 6} stroke="#fff" /></g>`
        })}
        ${drag ? html`<rect x=${Math.min(drag.x0, drag.x1)} y=${Math.min(drag.y0, drag.y1)} width=${Math.abs(drag.x1 - drag.x0)} height=${Math.abs(drag.y1 - drag.y0)} fill="#f5b94222" stroke="#f5b942" stroke-dasharray="4 3" />` : null}
      </svg>
      <div class="trk-hud">${hud}</div>
    </div>
  `
}

// ---------------------------------------------------------------- inspector: Track

function Bar({ done, total }) {
  return html`<div class="trk-bar"><div style=${{ width: `${Math.round((100 * done) / Math.max(1, total))}%` }}></div></div>`
}

function TrackTab({ clip }) {
  const s = useStore()
  const t = useTime()
  const p = viewProject()
  const [target, setTarget] = useState('')
  const [tol, setTol] = useState(0.25)
  const [useRange, setUseRange] = useState(false)
  const [smooth, setSmooth] = useState(0)
  const trk = trackOf(clip.id)
  const mode = trk?.mode ?? s.trkMode ?? 'point'
  const ks = trackedFrames(trk)
  const kNow = frameAt(p, clip, t)
  const canStart = trk && boxesAt(trk, kNow)
  const others = p.tracks.filter(tr => tr.kind === 'video').flatMap(tr => tr.clips).filter(x => x.id !== clip.id && x.kind !== 'audio' && x.start < clipEnd(clip) && clipEnd(x) > clip.start)
  const correctors = (clip.nodes?.list ?? []).filter(n => n.type === 'corrector')
  const rangeOverlaps = p.range && p.range.in < clipEnd(clip) && p.range.out > clip.start
  const setMode = m => {
    set({ trkMode: m })
    if (trk) setTrack({ mode: m, boxes: [], next: 0, results: {}, k0: null, lostAt: null })
  }
  const startDraw = () => {
    if (!trk) newTrack(clip.id, mode)
    set({ tool: 'track', selection: [clip.id] })
    if (time.t < clip.start || time.t >= clipEnd(clip)) player.seek(clip.start)
  }
  const apply = async () => {
    if (!trk || ks.length < 2) return toast('Track some frames first', 'error')
    const [kind, id] = target.split(':')
    if (kind === 'layer') await applyMatchMove(p, clip, trk, id, tol)
    else if (kind === 'mask') await applyMask(p, clip, trk, id, tol)
    else if (kind === 'node') await applyWindow(p, clip, trk, id, tol)
    else if (kind === 'stab') {
      const tp = trackPath(p, clip, trk)
      await writeStabilization(p, clip, tp.ks, tp.path, { smooth, lock: smooth === 0, lockIndex: tp.lockIndex, crop: true, translateOnly: !tp.pair }, `stabilized ${clip.id} on its track`)
    } else toast('Pick what the track drives', 'error')
  }
  const busy = trk?.busy

  return html`
    <div class="section-body">
      <div class="field"><label>Tracker</label>
        <div class="trk-seg">
          <button class=${mode === 'point' ? 'on' : ''} onClick=${() => setMode('point')}>One point</button>
          <button class=${mode === 'pair' ? 'on' : ''} title="Two points: also scale and rotation" onClick=${() => setMode('pair')}>Two points</button>
        </div>
      </div>
      <div class="row gap wrap">
        <button class=${s.tool === 'track' ? 'on' : ''} onClick=${startDraw}>⌖ Draw ${mode === 'pair' ? 'boxes' : 'box'}</button>
        ${trk ? html`<button class="ghost" onClick=${() => set({ trk: null })}>Clear track</button>` : null}
      </div>
      <div class="trk-note">${!trk || !trk.boxes.length ? `With the Track tool, drag a box around a detail that has texture${mode === 'pair' ? ' (two boxes, far apart on the same object)' : ''}.` : `Box drawn at ${timecode(frameTime(p, clip, trk.k0), p.fps)}. Track from the playhead.`}</div>
      ${rangeOverlaps ? html`<label class="row gap trk-note"><input type="checkbox" checked=${useRange} onChange=${e => setUseRange(e.target.checked)} /> Only within the In/Out range</label>` : null}
      <div class="row gap">
        <button disabled=${!canStart || busy} title="Track backward from the playhead" onClick=${() => runTrack(-1, useRange)}>◀ Track</button>
        <button disabled=${!canStart || busy} title="Track forward from the playhead" onClick=${() => runTrack(1, useRange)}>Track ▶</button>
        ${busy ? html`<${Bar} done=${busy.done} total=${busy.total} /><button class="ghost danger" onClick=${() => client.cancel(busy.id)}>Cancel</button>` : null}
      </div>
      ${ks.length ? html`<div class="kv"><span>Tracked</span><b>${ks.length} frames, ${timecode(frameTime(p, clip, ks[0]), p.fps)} → ${timecode(frameTime(p, clip, ks.at(-1)), p.fps)}</b></div>` : null}
      ${trk?.lostAt !== null && trk?.lostAt !== undefined ? html`<div class="trk-note warn">Lost at ${timecode(frameTime(p, clip, trk.lostAt), p.fps)}. Go there, draw the box again and continue.</div>` : null}
      ${ks.length > 1 ? html`
        <h4 style=${{ margin: '8px 0 2px' }}>Apply the track</h4>
        <div class="field"><label>Drives</label>
          <select value=${target} onChange=${e => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            <optgroup label="Match move another layer">${others.map(o => html`<option value=${`layer:${o.id}`}>${o.id} ${clipName(o)}</option>`)}</optgroup>
            <optgroup label="This clip's mask">
              ${(clip.masks ?? []).map(m => html`<option value=${`mask:${m.id}`}>${m.id} (${m.type})</option>`)}
              <option value="mask:new">New mask from the box</option>
            </optgroup>
            ${correctors.length ? html`<optgroup label="Node window">${correctors.map(n => html`<option value=${`node:${n.id}`}>${n.id} ${n.window ? `${n.window.type} window` : '(new window)'}</option>`)}</optgroup>` : null}
            <optgroup label="This clip"><option value="stab:">Stabilize on the track (inverse transform)</option></optgroup>
          </select>
        </div>
        ${target.startsWith('stab') ? html`<div class="field"><label>Smoothing</label><input type="range" min="0" max="2" step="0.05" value=${smooth} style=${{ flex: 1 }} onInput=${e => setSmooth(Number(e.target.value))} /><span class="trk-note">${smooth === 0 ? 'locked' : `${smooth}s`}</span></div>` : null}
        <div class="field"><label>Tolerance</label><input type="number" min="0" step="0.05" value=${tol} onChange=${e => setTol(Math.max(0, Number(e.target.value) || 0))} /><span class="trk-note">px; keys are dropped while a straight line stays this close</span></div>
        ${target.startsWith('mask') || target.startsWith('node') ? html`<div class="trk-note">${target.startsWith('mask') ? 'The mask' : 'The node window'} follows the track in preview and export. You can edit the resulting keyframes.</div>` : null}
        <button disabled=${!target} onClick=${apply}>Apply</button>
      ` : null}
    </div>
  `
}

// ---------------------------------------------------------------- inspector: Stabilize

const stabOf = id => store.stab?.[id]
const setStab = (id, patch) => set(s => ({ stab: { ...(s.stab ?? {}), [id]: { ...(s.stab?.[id] ?? {}), ...patch } } }))

async function analyzeMotion(p, c) {
  const inf = info(p, c)
  const ks = [...Array(inf.n).keys()]
  const aw = Math.min(inf.W, 640)
  const ah = Math.max(2, Math.round((inf.H * aw) / inf.W))
  const { id, promise } = client.run(
    { type: 'motion', url: mediaUrl(p, c.src), frames: ks.map(k => ({ k, s: sourceFrame(p, c, k, inf.assetFps) })), width: aw, height: ah, srcWidth: inf.W, srcHeight: inf.H },
    (done, total) => setStab(c.id, { busy: { id, done, total } }),
  )
  setStab(c.id, { busy: { id, done: 0, total: ks.length }, steps: null, key: null })
  try {
    const r = await promise
    if (r.cancelled) {
      setStab(c.id, { busy: null })

      return toast('Analysis cancelled')
    }
    const steps = r.results.sort((a, b) => a.k - b.k)
    const weak = steps.filter((x, i) => i > 0 && x.inliers < 6).length
    setStab(c.id, { busy: null, steps, key: `${c.src}|${c.in}|${c.dur}|${c.speed ?? 1}|${c.reverse ? 1 : 0}` })
    toast(weak ? `Analyzed ${steps.length} frames; ${weak} had few trackable points` : `Analyzed ${steps.length} frames`)
  } catch (error) {
    setStab(c.id, { busy: null })
    toast(error.message, 'error')
  }
}

function useJob(id) {
  const s = useStore()

  return id ? s.jobs.find(j => j.id === id) : null
}

async function startRender(path, body, label) {
  try {
    const job = await api(path, body)
    set(s => ({ renderJobs: { ...(s.renderJobs ?? {}), [`${path}|${body.clip}`]: job.id } }))
    toast(`${label}: rendering`)
    let j = job
    while (j.state === 'running') j = await api(`/api/analysis/jobs/wait?id=${job.id}&timeout=25000`)
    if (j.state === 'done' && !j.applyError) toast(`${label}: done (${j.output})`)
    else if (j.state === 'done') toast(`${label}: rendered ${j.output} but ${j.applyError}`, 'error')
    else if (j.state === 'cancelled') toast(`${label}: cancelled`)
    else toast(`${label} failed: ${j.error}`, 'error')
  } catch (error) {
    toast(error.message, 'error')
  }
}

function deshake(c) {
  if (store.caps.processing?.deshake === false) return toast('Open the browser editor to render deshake', 'error')
  const src = c.deshake?.src ?? c.src
  const inPoint = c.deshake?.in ?? c.in ?? 0

  return startRender('/api/stabilize/render', { src, in: inPoint, dur: c.dur * (c.speed ?? 1), clip: c.id }, `Deshake ${c.id}`)
}

function RenderJob({ path, clip }) {
  const s = useStore()
  const id = s.renderJobs?.[`${path}|${clip.id}`]
  const job = useJob(id)
  if (!job || job.state !== 'running') return null

  return html`<div class="row gap"><${Bar} done=${job.progress ?? 0} total=${1} /><span class="trk-note">${Math.round((job.progress ?? 0) * 100)}%</span><button class="ghost danger" onClick=${() => api('/api/analysis/jobs/cancel', { id })}>Cancel</button></div>`
}

function StabilizeTab({ clip }) {
  const s = useStore()
  const canRender = s.caps.processing?.deshake !== false
  const p = viewProject()
  const st = stabOf(clip.id) ?? {}
  const [smoothS, setSmoothS] = useState(0.8)
  const [lock, setLock] = useState(false)
  const [crop, setCrop] = useState(true)
  const [rot, setRot] = useState(true)
  const inf = info(p, clip)
  const fresh = st.steps && st.key === `${clip.src}|${clip.in}|${clip.dur}|${clip.speed ?? 1}|${clip.reverse ? 1 : 0}`
  let preview = null
  if (fresh) {
    const path = accumulate(st.steps.map(x => ({ a: x.a, b: x.b, tx: x.tx, ty: x.ty })))
    const flat = rot ? path : path.map(x => ({ a: 1, b: 0, tx: x.tx, ty: x.ty }))
    const corrs = corrections(flat, smoothPath(flat, smoothS * p.fps, { lock }))
    preview = { path: flat, zoom: crop ? coverZoom(corrs, inf.W, inf.H, 1.5) : 1, maxShift: Math.max(...corrs.map(x => Math.hypot(x.tx, x.ty))) }
  }
  const apply = () => writeStabilization(p, clip, st.steps.map(x => x.k), preview.path, { smooth: smoothS, lock, crop, translateOnly: !rot }, `stabilized ${clip.id}`)
  const clear = () => edit(['x', 'y', 'rotation', 'scale'].map(prop => ({ op: 'clear_keyframes', id: clip.id, prop })), `removed stabilization on ${clip.id}`)

  return html`
    <div class="section-body">
      <h4 style=${{ margin: '2px 0' }}>Stabilize with keyframes</h4>
      <div class="trk-note">Measures the camera's motion from a grid of tracked points, smooths the path and writes compensating x, y, rotation and a scale that hides the edges. Replaces this clip's x/y/rotation/scale keyframes.</div>
      <div class="row gap">
        <button disabled=${st.busy} onClick=${() => analyzeMotion(p, clip)}>${fresh ? 'Analyze again' : 'Analyze motion'}</button>
        ${st.busy ? html`<${Bar} done=${st.busy.done} total=${st.busy.total} /><button class="ghost danger" onClick=${() => client.cancel(st.busy.id)}>Cancel</button>` : null}
      </div>
      ${fresh ? html`
        <div class="field"><label>Smoothness</label><input type="range" min="0.1" max="3" step="0.05" value=${smoothS} disabled=${lock} style=${{ flex: 1 }} onInput=${e => setSmoothS(Number(e.target.value))} /><span class="trk-note">${smoothS.toFixed(2)}s</span></div>
        <label class="row gap trk-note"><input type="checkbox" checked=${lock} onChange=${e => setLock(e.target.checked)} /> Lock the camera (tripod)</label>
        <label class="row gap trk-note"><input type="checkbox" checked=${rot} onChange=${e => setRot(e.target.checked)} /> Correct rotation</label>
        <label class="row gap trk-note"><input type="checkbox" checked=${crop} onChange=${e => setCrop(e.target.checked)} /> Zoom to hide moving edges</label>
        <div class="kv"><span>Largest correction</span><b>${preview.maxShift.toFixed(1)} px</b></div>
        <div class="kv"><span>Crop</span><b>${preview.zoom > 1.0005 ? `${((1 - 1 / preview.zoom) * 100).toFixed(1)}% (zoom ${preview.zoom.toFixed(3)}×)` : 'none'}</b></div>
        ${preview.zoom >= 1.4999 ? html`<div class="trk-note warn">The shake needs more than a 1.5× zoom; edges will show. Try more smoothness.</div>` : null}
        <div class="row gap"><button onClick=${apply}>Apply stabilization</button><button class="ghost" onClick=${clear}>Remove</button></div>
      ` : st.steps ? html`<div class="trk-note warn">The clip changed since the analysis: analyze again.</div>` : null}
      <h4 style=${{ margin: '10px 0 2px' }}>Render with ffmpeg deshake</h4>
      <div class="trk-note">${canRender ? "Renders the clip's range through ffmpeg deshake into media/stabilized/ and swaps it in (one undo restores the original)." : 'Open the browser editor to render deshake. Keyframe stabilization is available above.'}</div>
      ${clip.deshake ? html`
        <div class="kv"><span>Source</span><b title=${clip.src}>${String(clip.src).split('/').pop()}</b></div>
        <div class="row gap"><button class="ghost" onClick=${() => edit({ op: 'update', id: clip.id, set: { src: clip.deshake.src, in: clip.deshake.in, deshake: null } }, `original media back on ${clip.id}`)}>Back to the original</button></div>
      ` : html`<div class="row gap"><button disabled=${!canRender} onClick=${() => deshake(clip)}>Render deshake</button></div>`}
      <${RenderJob} path="/api/stabilize/render" clip=${clip} />
    </div>
  `
}

// ---------------------------------------------------------------- speed: optical flow

function opticalFlow(c, speed) {
  if (store.caps.analysis?.opticalFlow === false) return toast('Open the browser editor to render optical-flow slow motion', 'error')
  const orig = c.retime ? { src: c.retime.src, in: c.retime.in, speed: c.retime.speed } : { src: c.src, in: c.in ?? 0, speed: c.speed ?? 1 }
  if (c.reverse || c.freeze !== undefined) return toast('Optical flow needs a forward, unfrozen clip', 'error')
  if (!(speed < 1)) return toast('Optical flow is for slow motion (below 100%)', 'error')

  return startRender('/api/retime', { src: orig.src, in: orig.in, dur: c.dur * orig.speed, speed, clip: c.id }, `Optical flow ${Math.round(speed * 100)}% on ${c.id}`)
}

function frameBlending(c) {
  if (!c.retime) return
  edit({ op: 'update', id: c.id, set: { src: c.retime.src, in: c.retime.in, speed: c.retime.speed, retime: null } }, `frame blending on ${c.id}`)
}

function SpeedTab({ clip }) {
  const s = useStore()
  const canFlow = s.caps.analysis?.opticalFlow !== false
  const speed = clip.retime?.speed ?? clip.speed ?? 1
  const flow = Boolean(clip.retime)

  return html`
    <div class="section-body">
      <div class="kv"><span>Speed</span><b>${Math.round(speed * 1000) / 10}%${clip.reverse ? ' reversed' : ''}</b></div>
      <div class="field"><label>Slow motion</label>
        <div class="trk-seg">
          <button class=${!flow ? 'on' : ''} onClick=${() => frameBlending(clip)}>Frame blending</button>
          <button class=${flow ? 'on' : ''} disabled=${!canFlow || !(speed < 1) || flow} title=${!canFlow ? 'Open the browser editor to render optical flow' : speed < 1 ? 'Render interpolated frames (ffmpeg minterpolate)' : 'Slow the clip below 100% first'} onClick=${() => opticalFlow(clip, speed)}>Optical flow</button>
        </div>
      </div>
      <div class="trk-note">${flow ? `Playing ${String(clip.src).split('/').pop()}, rendered with motion-compensated interpolation from ${String(clip.retime.src).split('/').pop()}.` : speed < 1 ? 'Frame blending repeats source frames. Optical flow renders new in-between frames.' : 'Optical flow applies to slow motion. Pick a speed below to render one:'}</div>
      ${!canFlow ? html`<div class="trk-note">Open the browser editor to render optical-flow slow motion.</div>` : null}
      <div class="row gap">${[0.5, 0.25].map(sp => html`<button class="ghost" disabled=${!canFlow} onClick=${() => opticalFlow(clip, sp)}>Optical flow ${sp * 100}%</button>`)}</div>
      <${RenderJob} path="/api/retime" clip=${clip} />
    </div>
  `
}

// ---------------------------------------------------------------- registration

registerTool({ id: 'track', label: 'Track: drag a box on the viewer', icon: '⌖', order: 60 })

registerViewerOverlay({
  id: 'tracking',
  order: 40,
  when: s => s.tool === 'track' || Boolean(s.trk && s.inspectorTab === 'tracking' && s.selection.includes(s.trk.clipId)),
  exclusive: s => s.tool === 'track',
  component: TrackOverlay,
})

registerInspector({ id: 'tracking', label: 'Track', order: 60, when: c => isVideo(c), component: TrackTab })
registerInspector({ id: 'stabilize', label: 'Stabilize', order: 61, when: c => isVideo(c), component: StabilizeTab })
registerInspector({ id: 'speed', label: 'Speed', order: 62, when: c => isVideo(c), component: SpeedTab })

registerClipMenu((p, hit) => {
  const c = hit.clip
  if (!isVideo(c)) return []
  const open = tab => set({ selection: [c.id], inspectorTab: tab })

  return [
    { label: 'Track motion…', run: () => (open('tracking'), store.trk?.clipId !== c.id && newTrack(c.id, store.trkMode ?? 'point'), set({ tool: 'track' })) },
    { label: 'Stabilize…', run: () => (open('stabilize'), analyzeMotion(viewProject(), c)) },
    c.deshake ? { label: 'Undo deshake render', run: () => edit({ op: 'update', id: c.id, set: { src: c.deshake.src, in: c.deshake.in, deshake: null } }) } : { label: 'Stabilize: render with ffmpeg deshake', disabled: store.caps.processing?.deshake === false, run: () => deshake(c) },
    {
      label: 'Optical-flow slow motion',
      sub: [
        { label: '50%', disabled: store.caps.analysis?.opticalFlow === false, run: () => opticalFlow(c, 0.5) },
        { label: '25%', disabled: store.caps.analysis?.opticalFlow === false, run: () => opticalFlow(c, 0.25) },
        ...((c.speed ?? 1) < 1 && !c.retime ? [{ label: `At the current ${Math.round((c.speed ?? 1) * 100)}%`, disabled: store.caps.analysis?.opticalFlow === false, run: () => opticalFlow(c, c.speed) }] : []),
        ...(c.retime ? [{ label: 'Back to frame blending', run: () => frameBlending(c) }] : []),
      ],
    },
  ]
})
