// Viewer overlays for the Color page: the selected corrector's power window with its
// handles, the qualifier eyedropper, and the gallery still's split-screen wipe.

import { h } from 'preact'
import { useState } from 'preact/hooks'
import htm from 'htm'
import { applyOps, clipEnd } from '/core/project.js'
import { drawFrame } from '../../engine/frame.js'
import { comp, media } from '../engine-host.js'
import { edit, set, store, time, useStore, useTime, viewProject } from '../store.js'
import { dragWindow, ensureGraph, expandQualifier, feedOf, fullWindow, graphOf, nodeNumbers, nodeTitle, qualifierAround, rgbToHsl, windowHandles } from './graph.js'
import { clipPlane, gradedClip, nodeOps, preview, selectedNode } from './state.js'

const html = htm.bind(h)

/** The selected node when it is a corrector of the graded clip, with that clip. */
function activeCorrector() {
  const clip = gradedClip()
  const node = selectedNode(clip)

  return clip && node?.type === 'corrector' ? { clip, node } : null
}

export const windowOverlayActive = s => s.page === 'color' && !s.playing && !s.eyedropper && Boolean(activeCorrector()?.node.window)
export const eyedropperActive = s => s.page === 'color' && Boolean(s.eyedropper) && Boolean(activeCorrector())
export const wipeActive = s => s.page === 'color' && Boolean(s.wipe && (s.stills ?? []).some(x => x.id === s.wipe.id))

// ---------------------------------------------------------------- power window

/** Plane pixels ↔ stage pixels for the clip's source plane drawn in the viewer `rect`. */
function planeMapping(p, clip, t, rect) {
  const q = clipPlane(p, clip, t)
  const k = rect.w / p.width
  const a = (q.r * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const toStage = (px, py) => {
    const lx = (px - q.fw / 2) * q.sx * k
    const ly = (py - q.fh / 2) * q.sy * k

    return [rect.x + q.x * k + lx * cos - ly * sin, rect.y + q.y * k + lx * sin + ly * cos]
  }
  const toPlane = (sx, sy) => {
    const dx = sx - rect.x - q.x * k
    const dy = sy - rect.y - q.y * k
    const lx = dx * cos + dy * sin
    const ly = -dx * sin + dy * cos

    return [lx / (q.sx * k) + q.fw / 2, ly / (q.sy * k) + q.fh / 2]
  }
  const transform = `translate(${rect.x + q.x * k} ${rect.y + q.y * k}) rotate(${q.r}) scale(${q.sx * k} ${q.sy * k}) translate(${-q.fw / 2} ${-q.fh / 2})`

  return { q, toStage, toPlane, transform }
}

export function WindowOverlay({ p, rect }) {
  useStore()
  const t = useTime()
  const [dragging, setDragging] = useState(null)
  const active = activeCorrector()
  if (!active?.node.window) return null
  const { clip, node } = active
  if (t < clip.start || t >= clipEnd(clip)) return null
  const win = fullWindow(node.window)
  const m = planeMapping(p, clip, t, rect)
  const { fw, fh } = m.q
  const hd = windowHandles(win, fw, fh)
  const ax = (win.w * fw) / 2
  const ay = (win.h * fh) / 2
  const soft = win.softness

  const start = (e, handle) => {
    e.stopPropagation()
    e.preventDefault()
    const stage = e.currentTarget.closest('.viewer-stage').getBoundingClientRect()
    const at = ev => m.toPlane(ev.clientX - stage.left, ev.clientY - stage.top)
    const [px, py] = at(e)
    const from = { win, px, py }
    let out = win
    setDragging(handle)
    const move = ev => {
      out = dragWindow(handle, from, ...at(ev), fw, fh, { snap: ev.shiftKey })
      preview(nodeOps(clip, node, { window: out }))
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      setDragging(null)
      if (out !== win) edit(nodeOps(clip, node, { window: out }), `moved the ${win.type} window on ${clip.id} node ${node.id}`)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  const handle = (name, [x, y], cls, title) => {
    const [sx, sy] = m.toStage(x, y)

    return html`<circle class=${`wh ${cls}`} cx=${sx} cy=${sy} r=${cls === 'rot' ? 6 : 5.5} data-handle=${name} onPointerDown=${e => start(e, name)}><title>${title}</title></circle>`
  }
  const shape = (scale, cls) =>
    win.type === 'rect'
      ? html`<rect class=${cls} x=${-ax * scale} y=${-ay * scale} width=${2 * ax * scale} height=${2 * ay * scale} vector-effect="non-scaling-stroke" />`
      : html`<ellipse class=${cls} rx=${ax * scale} ry=${ay * scale} vector-effect="non-scaling-stroke" />`
  const reach = Math.hypot(fw, fh)
  const [rx1, ry1] = m.toStage(...hd.rotate)
  const [cx1, cy1] = m.toStage(...hd.center)

  return html`
    <svg class=${`win-overlay ${dragging ? 'dragging' : ''}`} data-node=${node.id}>
      <g transform=${m.transform}>
        <g transform=${`translate(${win.x * fw} ${win.y * fh}) rotate(${win.rotation})`}>
          ${win.type === 'linear'
            ? html`
              <line class="wshape" x1=${-reach} y1="0" x2=${reach} y2="0" vector-effect="non-scaling-stroke" />
              <line class="wsoft" x1=${-reach} y1=${-soft * ay} x2=${reach} y2=${-soft * ay} vector-effect="non-scaling-stroke" />
              <line class="wsoft" x1=${-reach} y1=${soft * ay} x2=${reach} y2=${soft * ay} vector-effect="non-scaling-stroke" />
              <path class="warrow" d=${`M0,0 L0,${-Math.max(40, ay * 0.6)}`} vector-effect="non-scaling-stroke" />`
            : html`
              <g class="wbody" onPointerDown=${e => start(e, 'center')}>${shape(1, 'wshape')}</g>
              ${shape(Math.max(0.01, 1 - soft), 'wsoft')}
              ${shape(1 + soft, 'wsoft')}`}
        </g>
      </g>
      <line class="wstem" x1=${cx1} y1=${cy1} x2=${rx1} y2=${ry1} />
      ${handle('center', hd.center, 'center', 'Drag to move (the shape too)')}
      ${win.type === 'linear' ? null : handle('w', hd.w, 'size', 'Width')}
      ${win.type === 'linear' ? null : handle('h', hd.h, 'size', 'Height')}
      ${win.type === 'linear' ? null : handle('corner', hd.corner, 'size', 'Width and height')}
      ${handle('rotate', hd.rotate, 'rot', 'Rotate (⇧ 15° steps)')}
      ${handle('soft', hd.soft, 'soft', 'Softness')}
      <text class="wlabel" x=${cx1 + 10} y=${cy1 - 10}>${nodeNumbers(graphOf(clip)).get(node.id)} ${nodeTitle(node)} · ${win.type}${win.invert ? ' (inverted)' : ''}</text>
    </svg>
  `
}

// ---------------------------------------------------------------- eyedropper

/** Mean RGB (0…1) of a 5×5 patch of the viewer's current frame around stage point (sx, sy). */
export function sampleViewer(rect, sx, sy) {
  const [W, H] = comp.size
  if (!W) return null
  const cx = Math.floor(((sx - rect.x) / rect.w) * W)
  const cy = Math.floor(((sy - rect.y) / rect.h) * H)
  if (cx < 0 || cy < 0 || cx >= W || cy >= H) return null
  const px = comp.readPixels()
  const sum = [0, 0, 0]
  let n = 0
  for (let y = cy - 2; y <= cy + 2; y++) {
    for (let x = cx - 2; x <= cx + 2; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const o = ((H - 1 - y) * W + x) * 4 // bottom row first
      sum[0] += px[o]
      sum[1] += px[o + 1]
      sum[2] += px[o + 2]
      n++
    }
  }

  return sum.map(v => v / n / 255)
}

/**
 * Samples what the node sees, as Resolve's qualifier picker does: the frame is drawn once
 * with the clip's graph output fed straight from the node's input, read, then drawn again
 * as it was, inside one task (the viewer never shows the probe frame). Without that the
 * pick would read colours the node (or nodes after it) already changed.
 */
export function sampleNodeInput(clip, node, rect, sx, sy) {
  const p = store.project
  const feed = feedOf(graphOf(clip), node.id, 0)
  const out = graphOf(clip).list.find(n => n.type === 'output')
  if (!feed || !out || store.openComp) return sampleViewer(rect, sx, sy)
  let probe
  try {
    probe = applyOps(p, [...ensureGraph(clip), { op: 'node_link', id: clip.id, from: feed, to: out.id, input: 0 }]).project
  } catch {
    return sampleViewer(rect, sx, sy)
  }
  try {
    drawFrame(comp, media, probe, time.t)

    return sampleViewer(rect, sx, sy)
  } finally {
    drawFrame(comp, media, viewProject(), time.t)
  }
}

export function EyedropperOverlay({ rect }) {
  const s = useStore()
  const active = activeCorrector()
  if (!active) return null
  const { clip, node } = active
  const pickAt = e => {
    e.stopPropagation()
    e.preventDefault()
    const stage = e.currentTarget.closest('.viewer-stage').getBoundingClientRect()
    const rgb = sampleNodeInput(clip, node, rect, e.clientX - stage.left, e.clientY - stage.top)
    if (!rgb) return
    const add = (s.eyedropper === 'add' || e.shiftKey) && node.qualifier
    // A fresh pick replaces the ranges; invert and highlight stay as they were (node_update merges).
    const q = add ? expandQualifier(node.qualifier, rgb) : qualifierAround(rgb)
    set({ lastPick: { rgb, hsl: rgbToHsl(rgb) } })
    edit(nodeOps(clip, node, { qualifier: q }), `${add ? 'widened' : 'picked'} the qualifier on ${clip.id} node ${node.id}`)
  }

  return html`
    <div class="eyedrop" style=${{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` }}
      onPointerDown=${pickAt} onKeyDown=${e => e.key === 'Escape' && set({ eyedropper: null })}>
      <div class="eyedrop-tip">${s.eyedropper === 'add' ? 'Click to widen the qualifier' : 'Click a colour to qualify (⇧ adds)'}: samples the node's input · <a onPointerDown=${e => (e.stopPropagation(), set({ eyedropper: null }))}>done</a></div>
    </div>
  `
}

// ---------------------------------------------------------------- still wipe

export function WipeOverlay({ rect }) {
  const s = useStore()
  const still = (s.stills ?? []).find(x => x.id === s.wipe?.id)
  if (!still) return null
  const pos = s.wipe.pos ?? 0.5
  const down = e => {
    e.stopPropagation()
    e.preventDefault()
    const box = e.currentTarget.parentElement.getBoundingClientRect()
    const move = ev => set({ wipe: { ...store.wipe, pos: Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width)) } })
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  return html`
    <div class="wipe" style=${{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` }}>
      <img src=${still.url} style=${{ clipPath: `inset(0 ${(1 - pos) * 100}% 0 0)` }} />
      <div class="wipe-bar" style=${{ left: `${pos * 100}%` }} onPointerDown=${down} title="Drag to move the split"></div>
      <span class="wipe-tag l">${still.label}</span><span class="wipe-tag r">live</span>
    </div>
  `
}

/** Escape ends the eyedropper wherever focus is. */
export function installEyedropperKeys() {
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && store.eyedropper) {
      set({ eyedropper: null })
      e.stopPropagation()
    }
  }, true)
}

