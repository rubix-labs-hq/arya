// Viewer overlay for the Motion page and the motion tools: layer bounds through the
// world matrix (anchor and parents included), parenting links, null outlines, motion
// paths with draggable keys, mask and path vertex editing, and the drawing tools
// (shapes, pen, masks, anchor point). Drags preview live by applying the ops to a copy
// of the project, then commit once on release.

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { clipEnd, round, sortedKeys, valueAt } from '/core/project.js'
import { player } from '../engine-host.js'
import { edit, set, store, time, toast, useStore, useTime } from '../store.js'
import { openComposition } from '../timeline.js'
import { anchorOps } from './anchor.js'
import { addPenShapeOps, addShapeOps, dragBox, maskFromDrag, resizeMask, shapeFromDrag } from './draw.js'
import { apply, applyVec, corners, hitsLayer, inverse, localMatrix, parentSpace, transformAt, worldMatrixOf } from './geometry.js'
import { activeLayers, layerBox, NULL_SIZE } from './layer-box.js'
import { cancel as cancelPreview, commit, preview } from './live.js'
import { setValueOp } from './ops.js'
import { closesPath, maskPath, samplePath, vertex } from './pen.js'
import { isMotionTool, ms } from './state.js'

const html = htm.bind(h)

// ---------------------------------------------------------------- geometry helpers

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const pts = list => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')

/** The matrix from a layer's parent space to the frame, at timeline time t. */
function parentMatrix(view, c, t) {
  const local = Math.max(0, Math.min(c.dur, t - c.start))

  return parentSpace(worldMatrixOf(view, c, c.start + local), localMatrix(transformAt(view, c, local)))
}

/** Where the anchor of c is drawn at time t (frame px). */
function anchorWorld(view, c, t) {
  const local = Math.max(0, Math.min(c.dur, t - c.start))

  return apply(worldMatrixOf(view, c, c.start + local), [valueAt(view, c, 'anchorX', local), valueAt(view, c, 'anchorY', local)])
}

/** Editable paths of a selected layer: its masks and, for path shapes, the shape path. */
function editablePaths(c, box, withShape) {
  const out = []
  for (const m of c.masks ?? []) out.push({ kind: 'mask', id: m.id, m })
  if (withShape && c.kind === 'shape' && c.shape?.type === 'path') out.push({ kind: 'shape', id: 'shape', path: c.shape.path })

  return out.map(e => ({ ...e, box }))
}

const pathOp = (c, target, path) => (target.kind === 'mask' ? { op: 'update_mask', id: c.id, mask: target.id, set: { path } } : { op: 'update', id: c.id, set: { shape: { path } } })
const maskBoxOp = (c, maskId, box) => ({ op: 'update_mask', id: c.id, mask: maskId, set: box })

/** The outline of a mask in layer pixels. */
function maskOutline(m, w, h) {
  if (m.type === 'path' && m.path) return samplePath(m.path, 12)
  const mw = m.w ?? w
  const mh = m.h ?? h
  const x = m.x ?? 0
  const y = m.y ?? 0
  if (m.type === 'ellipse') return Array.from({ length: 49 }, (_, i) => [x + (Math.cos((i / 48) * Math.PI * 2) * mw) / 2, y + (Math.sin((i / 48) * Math.PI * 2) * mh) / 2])

  return [[x - mw / 2, y - mh / 2], [x + mw / 2, y - mh / 2], [x + mw / 2, y + mh / 2], [x - mw / 2, y + mh / 2], [x - mw / 2, y - mh / 2]]
}

const maskCorners = (m, w, h) => {
  const mw = m.w ?? w
  const mh = m.h ?? h
  const x = m.x ?? 0
  const y = m.y ?? 0

  return [[x - mw / 2, y - mh / 2], [x + mw / 2, y - mh / 2], [x + mw / 2, y + mh / 2], [x - mw / 2, y + mh / 2]]
}

// ---------------------------------------------------------------- the overlay

export function MotionOverlay({ p: view, rect }) {
  const s = useStore()
  const t = useTime()
  const svg = useRef(null)
  const drag = useRef(null)
  const [, redraw] = useState(0)
  const [pen, setPen] = useState(null) // { points, target: 'shape' | 'mask', clipId }
  const [hover, setHover] = useState(null) // frame point under the pointer while a pen is open
  const penRef = useRef(null)
  penRef.current = pen

  // Enter finishes an open pen path, Escape cancels it.
  useEffect(() => {
    const onKey = e => {
      const pn = penRef.current
      if (!pn || e.target.closest?.('input, textarea, select')) return
      if (e.key === 'Escape') setPen(null)
      else if (e.key === 'Enter') finishPen(pn, false)
      else return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)

    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // A tool change drops an unfinished pen path.
  useEffect(() => {
    if (pen && s.tool !== 'm-pen' && !(s.tool === 'm-mask' && ms().maskKind === 'path')) setPen(null)
  }, [s.tool])

  if (!view || s.playing || rect.w < 2) return null
  const k = rect.w / view.width
  const S = ([x, y]) => [rect.x + x * k, rect.y + y * k]
  const tool = s.tool
  const all = view.tracks.flatMap(tr => tr.clips)
  const active = activeLayers(view, t)
  const selected = s.selection.map(id => active.find(a => a.clip.id === id)?.clip).filter(Boolean)
  const single = selected.length === 1 ? selected[0] : null
  const boxes = new Map(active.map(({ clip }) => [clip.id, layerBox(view, clip, t)]))

  const frameAt = e => {
    const r = svg.current.getBoundingClientRect()

    return [(e.clientX - r.left - rect.x) / k, (e.clientY - r.top - rect.y) / k]
  }

  /** The layer under frame point pt: nulls by their anchor first, then by layer order. */
  const pick = pt => {
    for (const { clip } of active) if (clip.kind === 'null' && dist(S(anchorWorld(view, clip, t)), S(pt)) < 14) return clip
    for (const { clip } of active) {
      if (clip.kind === 'null') continue
      const b = boxes.get(clip.id)
      if (hitsLayer(b.M, b.w, b.h, pt)) return clip
    }
    for (const { clip } of active) {
      const b = boxes.get(clip.id)
      if (clip.kind === 'null' && hitsLayer(b.M, b.w, b.h, pt)) return clip
    }

    return null
  }

  const style = () => {
    const m = ms()

    return { fill: m.fillOn ? m.fill : null, stroke: m.stroke, strokeWidth: m.strokeWidth, sides: m.sides, points: m.points }
  }

  async function addAndSelect(ops, summary) {
    const res = await edit(ops, summary)
    const id = res?.created?.filter(x => /^c\d+$/.test(x)).at(-1)
    if (id) set({ selection: [id], tool: 'select' })
  }

  async function finishPen(pn, closed) {
    if (!pn || pn.points.length < 2) return setPen(null)
    setPen(null)
    if (pn.target === 'mask') {
      const c = all.find(x => x.id === pn.clipId)
      if (!c) return
      const box = layerBox(view, c, time.t)
      await edit([{ op: 'add_mask', id: c.id, mask: { type: 'path', mode: 'add', path: maskPath(pn.points, closed, inverse(box.M)) } }], 'pen mask')
      set({ tool: 'select' })

      return
    }
    await addAndSelect(addPenShapeOps(view, pn.points, closed, time.t, style()), 'pen path')
  }

  // ------------------------------------------------------------ pointer handling

  const onDown = e => {
    if (e.button !== 0) return
    const pt = frameAt(e)
    const hd = e.target.dataset ?? {}
    const toolNow = isMotionTool(tool) ? tool : 'select'
    if (toolNow === 'select' && e.altKey && !hd.h) return // ⌥-click references the frame to Claude (the stage handles it)
    e.stopPropagation()
    e.preventDefault()
    svg.current.setPointerCapture(e.pointerId)
    const begin = d => {
      drag.current = { ...d, p0: pt, pt, moved: false }
      redraw(x => x + 1)
    }

    // Handles first: they belong to the single selected layer.
    if (hd.h && single) {
      const box = boxes.get(single.id)
      if (hd.h === 'scale' || hd.h === 'rot') {
        const A = anchorWorld(view, single, t)

        return begin({ kind: hd.h, c: single, A, scale0: valueAt(view, single, 'scale', t - single.start), rot0: valueAt(view, single, 'rotation', t - single.start) })
      }
      if (hd.h === 'mkey') return begin({ kind: 'mkey', c: single, kt: Number(hd.t) })
      const target = hd.h.startsWith('s') ? { kind: 'shape', id: 'shape' } : { kind: 'mask', id: hd.mask }
      const m = target.kind === 'mask' ? single.masks?.find(x => x.id === hd.mask) : null
      const path = target.kind === 'mask' ? m?.path : single.shape?.path
      if (hd.h === 'mcorner') return begin({ kind: 'mcorner', c: single, box, m, i: Number(hd.i) })
      if (hd.h === 'mvert' || hd.h === 'svert') return begin({ kind: 'vert', c: single, box, target, path, i: Number(hd.i) })
      if (hd.h === 'mtan' || hd.h === 'stan') return begin({ kind: 'tan', c: single, box, target, path, i: Number(hd.i), side: hd.side, alt: e.altKey })
    }

    if (toolNow === 'm-shape') return begin({ kind: 'shape', shapeKind: ms().shapeKind })

    const pathPen = toolNow === 'm-pen' || (toolNow === 'm-mask' && ms().maskKind === 'path')
    if (pathPen) {
      let pn = pen
      if (!pn) {
        if (toolNow === 'm-mask') {
          if (!single || single.kind === 'null' || single.kind === 'audio') return toast('Select one visual layer to draw a mask on it')
          pn = { points: [], target: 'mask', clipId: single.id }
        } else pn = { points: [], target: 'shape' }
      }
      if (closesPath(pn.points, pt, 8 / k)) return finishPen(pn, true)
      const next = { ...pn, points: [...pn.points, vertex(round(pt[0], 2), round(pt[1], 2))] }
      setPen(next)

      return begin({ kind: 'penTangent', index: next.points.length - 1 })
    }

    if (toolNow === 'm-mask') {
      if (!single || single.kind === 'null') return toast('Select one visual layer to draw a mask on it')
      const box = boxes.get(single.id)
      // Inside an existing rect or ellipse mask: move it.
      for (const m of [...(single.masks ?? [])].reverse()) {
        const lp = apply(inverse(box.M), pt)
        if (m.type === 'path') continue
        const [a, , c2] = maskCorners(m, box.w, box.h)
        if (lp[0] >= a[0] && lp[0] <= c2[0] && lp[1] >= a[1] && lp[1] <= c2[1]) return begin({ kind: 'mmove', c: single, box, m })
      }

      return begin({ kind: 'mask', c: single, box, maskKind: ms().maskKind })
    }

    if (toolNow === 'm-anchor') {
      const c = single ?? pick(pt)
      if (!c) return
      if (!single) set({ selection: [c.id] })

      return begin({ kind: 'anchor', c, W: worldMatrixOf(view, c, t), size: layerBox(view, c, t) })
    }

    // Select tool: pick, then move the selection.
    const hit = pick(pt)
    if (!hit) {
      if (!e.shiftKey) set({ selection: [] })

      return
    }
    let ids = s.selection
    if (e.shiftKey) ids = ids.includes(hit.id) ? ids.filter(x => x !== hit.id) : [...ids, hit.id]
    else if (!ids.includes(hit.id)) ids = [hit.id]
    if (ids !== s.selection) set({ selection: ids })
    const movers = ids.map(id => all.find(c => c.id === id)).filter(c => c && c.start <= t + 1e-6 && t < clipEnd(c))
    begin({
      kind: 'move',
      items: movers.map(c => {
        const local = t - c.start

        return { c, P: parentMatrix(view, c, t), x0: valueAt(view, c, 'x', local), y0: valueAt(view, c, 'y', local) }
      }),
    })
  }

  /** The ops a drag stands for right now (also what a release commits). */
  const dragOps = (d, e) => {
    const pt = d.pt
    let dx = pt[0] - d.p0[0]
    let dy = pt[1] - d.p0[1]
    switch (d.kind) {
      case 'move': {
        if (e?.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0)

        return d.items.flatMap(({ c, P, x0, y0 }) => {
          const [lx, ly] = applyVec(inverse(P), [dx, dy])

          return [setValueOp(c, 'x', round(x0 + lx, 2), time.t), setValueOp(c, 'y', round(y0 + ly, 2), time.t)]
        })
      }
      case 'scale': {
        const f = dist(pt, d.A) / Math.max(1e-6, dist(d.p0, d.A))
        let v = d.scale0 * f
        if (e?.shiftKey) v = Math.round(v * 20) / 20

        return [setValueOp(d.c, 'scale', round(Math.max(0.001, v), 4), time.t)]
      }
      case 'rot': {
        const a0 = Math.atan2(d.p0[1] - d.A[1], d.p0[0] - d.A[0])
        const a1 = Math.atan2(pt[1] - d.A[1], pt[0] - d.A[0])
        let r = d.rot0 + ((a1 - a0) * 180) / Math.PI
        if (e?.shiftKey) r = Math.round(r / 15) * 15

        return [setValueOp(d.c, 'rotation', round(r, 2), time.t)]
      }
      case 'anchor': {
        let lp = apply(inverse(d.W), pt)
        // Snap to the layer's center, corners and edge midpoints within 8 screen px.
        const { w, h } = d.size
        for (const q of [[0, 0], [-w / 2, -h / 2], [0, -h / 2], [w / 2, -h / 2], [w / 2, 0], [w / 2, h / 2], [0, h / 2], [-w / 2, h / 2], [-w / 2, 0]]) {
          if (dist(apply(d.W, q), pt) * k < 8) lp = q
        }

        return anchorOps(view, d.c, time.t, round(lp[0], 2), round(lp[1], 2))
      }
      case 'mkey': {
        const { c, kt } = d
        const P = parentMatrix(view, c, c.start + kt)
        const [nx, ny] = apply(inverse(P), pt)
        const out = []
        for (const [prop, v] of [['x', nx], ['y', ny]]) {
          const key = sortedKeys(c.anim?.[prop]).find(kk => Math.abs(kk[0] - kt) < 1e-3)
          if (key) out.push({ op: 'keyframe', id: c.id, prop, at: key[0], local: true, value: round(v, 2), ...(key[2] !== undefined ? { ease: key[2] } : {}) })
        }

        return out
      }
      case 'mcorner': {
        const lp = apply(inverse(d.box.M), pt)

        return [maskBoxOp(d.c, d.m.id, resizeMask(d.m, d.i, lp, d.box.w, d.box.h))]
      }
      case 'mmove': {
        const [lx, ly] = applyVec(inverse(d.box.M), [dx, dy])

        return [maskBoxOp(d.c, d.m.id, { x: round((d.m.x ?? 0) + lx, 2), y: round((d.m.y ?? 0) + ly, 2) })]
      }
      case 'vert': {
        const lp = apply(inverse(d.box.M), pt)
        const vertices = d.path.vertices.map((v, i) => (i === d.i ? [round(lp[0], 2), round(lp[1], 2)] : v))

        return [pathOp(d.c, d.target, { vertices })]
      }
      case 'tan': {
        const lp = apply(inverse(d.box.M), pt)
        const v = d.path.vertices[d.i]
        const vec = [round(lp[0] - v[0], 2), round(lp[1] - v[1], 2)]
        const mirror = [-vec[0] || 0, -vec[1] || 0]
        const n = d.path.vertices.length
        const ins = Array.from({ length: n }, (_, i) => d.path.in?.[i] ?? [0, 0])
        const outs = Array.from({ length: n }, (_, i) => d.path.out?.[i] ?? [0, 0])
        if (d.side === 'out') {
          outs[d.i] = vec
          if (!d.alt) ins[d.i] = mirror
        } else {
          ins[d.i] = vec
          if (!d.alt) outs[d.i] = mirror
        }

        return [pathOp(d.c, d.target, { in: ins, out: outs })]
      }
    }

    return []
  }

  const onMove = e => {
    const pt = frameAt(e)
    if (pen && !drag.current) setHover(pt)
    const d = drag.current
    if (!d) return
    d.pt = pt
    if (!d.moved && dist(S(pt), S(d.p0)) < 3) return
    d.moved = true
    if (d.kind === 'penTangent') {
      const pn = penRef.current
      if (!pn) return
      const points = pn.points.map((v, i) => (i === d.index ? { ...v, out: [round(pt[0] - v.pt[0], 2), round(pt[1] - v.pt[1], 2)] } : v))
      setPen({ ...pn, points })

      return
    }
    if (d.kind === 'shape' || d.kind === 'mask') return redraw(x => x + 1)
    d.ops = dragOps(d, e)
    preview(d.ops)
  }

  const onUp = e => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'penTangent' || !d.moved) {
      cancelPreview()
      redraw(x => x + 1)

      return
    }
    if (d.kind === 'shape') {
      const drawn = shapeFromDrag(d.shapeKind, d.p0, d.pt, { square: e.shiftKey, fromCenter: e.altKey }, style())
      if (drawn) addAndSelect(addShapeOps(view, drawn, time.t), `draw ${d.shapeKind}`)
      redraw(x => x + 1)

      return
    }
    if (d.kind === 'mask') {
      const mask = maskFromDrag(d.maskKind, d.p0, d.pt, inverse(d.box.M), { square: e.shiftKey, fromCenter: e.altKey })
      if (mask) edit([{ op: 'add_mask', id: d.c.id, mask: { ...mask, mode: 'add' } }], `${d.maskKind} mask`)
      redraw(x => x + 1)

      return
    }
    commit(dragOps(d, e), { move: 'move', scale: 'scale', rot: 'rotate', anchor: 'move anchor point', mkey: 'move position key', mcorner: 'resize mask', mmove: 'move mask', vert: 'move vertex', tan: 'bend path' }[d.kind])
  }

  const onDbl = e => {
    e.stopPropagation()
    if (isMotionTool(tool)) return
    const hit = pick(frameAt(e))
    if (hit?.kind === 'comp') openComposition(hit.comp)
    else if (!hit) player.toggle()
  }

  // ------------------------------------------------------------ drawing

  const d = drag.current
  const layers = []
  const handles = []
  // Nulls draw a faint square everywhere; selected layers get their bounds and anchor.
  for (const { clip: c } of active) {
    const b = boxes.get(c.id)
    const isSel = selected.includes(c)
    if (!isSel && c.kind !== 'null') continue
    const quad = corners(b.M, b.w, b.h).map(S)
    layers.push(html`<polygon class=${`mo-bounds ${c.kind === 'null' ? 'null' : ''} ${isSel ? 'sel' : ''}`} points=${pts(quad)} />`)
    if (!isSel) continue
    const A = S(anchorWorld(view, c, t))
    layers.push(html`<g class="mo-anchor"><circle cx=${A[0]} cy=${A[1]} r="5" /><line x1=${A[0] - 9} y1=${A[1]} x2=${A[0] + 9} y2=${A[1]} /><line x1=${A[0]} y1=${A[1] - 9} x2=${A[0]} y2=${A[1] + 9} /></g>`)
    // Parenting: a link from the child's anchor to its parent's.
    const parent = c.parent ? all.find(x => x.id === c.parent) : null
    if (parent) {
      const B = S(anchorWorld(view, parent, t))
      layers.push(html`<g class="mo-parent"><line x1=${A[0]} y1=${A[1]} x2=${B[0]} y2=${B[1]} /><circle cx=${B[0]} cy=${B[1]} r="3.5" /><text x=${A[0] + 8} y=${A[1] - 8}>↳ ${parent.label ?? parent.id}</text></g>`)
    }
  }

  if (single) {
    const c = single
    const b = boxes.get(c.id)
    // Motion path: where the anchor travels, a dot per frame, a square per position key.
    const keyTimes = [...new Set([...sortedKeys(c.anim?.x), ...sortedKeys(c.anim?.y)].map(kk => round(kk[0], 4)))].sort((a, b2) => a - b2)
    if (keyTimes.length >= 2 && (tool === 'select' || !isMotionTool(tool))) {
      const step = Math.max(1 / view.fps, c.dur / 400)
      const trail = []
      for (let tt = 0; tt <= c.dur + 1e-6; tt += step) trail.push(S(anchorWorld(view, c, c.start + tt)))
      layers.push(html`<polyline class="mo-path" points=${pts(trail)} />`)
      layers.push(html`<g class="mo-path-dots">${trail.map(q => html`<circle cx=${q[0]} cy=${q[1]} r="1.3" />`)}</g>`)
      for (const kt of keyTimes) {
        const q = S(anchorWorld(view, c, c.start + kt))
        handles.push(html`<rect class="mo-key" data-h="mkey" data-t=${kt} x=${q[0] - 4} y=${q[1] - 4} width="8" height="8"><title>Position key at ${kt.toFixed(2)} s: drag to move it</title></rect>`)
      }
    }
    // Masks and path shapes: outlines with vertex and tangent handles.
    const showShape = tool === 'select' || !isMotionTool(tool)
    for (const ed of editablePaths(c, b, showShape)) {
      const W = b.M
      if (ed.kind === 'mask') {
        const outline = maskOutline(ed.m, b.w, b.h).map(q => S(apply(W, q)))
        layers.push(html`<polyline class=${`mo-mask ${ed.m.inverted ? 'inv' : ''}`} points=${pts(outline)} />`)
        if (ed.m.type !== 'path') {
          maskCorners(ed.m, b.w, b.h).forEach((q, i) => {
            const sq = S(apply(W, q))
            handles.push(html`<rect class="mo-vert" data-h="mcorner" data-mask=${ed.id} data-i=${i} x=${sq[0] - 4} y=${sq[1] - 4} width="8" height="8" />`)
          })
          continue
        }
      }
      const path = ed.kind === 'mask' ? ed.m.path : ed.path
      if (!path?.vertices) continue
      const pre = ed.kind === 'mask' ? 'm' : 's'
      path.vertices.forEach((v, i) => {
        const sv = S(apply(W, v))
        for (const [side, tan] of [['in', path.in?.[i]], ['out', path.out?.[i]]]) {
          if (!tan || (tan[0] === 0 && tan[1] === 0)) continue
          const st = S(apply(W, [v[0] + tan[0], v[1] + tan[1]]))
          layers.push(html`<line class="mo-tan-line" x1=${sv[0]} y1=${sv[1]} x2=${st[0]} y2=${st[1]} />`)
          handles.push(html`<circle class="mo-tan" data-h=${`${pre}tan`} data-mask=${ed.id} data-i=${i} data-side=${side} cx=${st[0]} cy=${st[1]} r="4"><title>Drag to bend (⌥ breaks the pair)</title></circle>`)
        }
        handles.push(html`<rect class="mo-vert" data-h=${`${pre}vert`} data-mask=${ed.id} data-i=${i} x=${sv[0] - 4} y=${sv[1] - 4} width="8" height="8" />`)
      })
    }
    // Scale corners and the rotation handle (select tool).
    if (tool === 'select' || !isMotionTool(tool)) {
      const quad = corners(b.M, b.w, b.h).map(S)
      quad.forEach(q => handles.push(html`<rect class="mo-scale" data-h="scale" x=${q[0] - 4.5} y=${q[1] - 4.5} width="9" height="9"><title>Drag to scale (⇧ steps of 5%)</title></rect>`))
      const top = [(quad[0][0] + quad[1][0]) / 2, (quad[0][1] + quad[1][1]) / 2]
      const ctr = S(apply(b.M, [0, 0]))
      const len = Math.max(1, dist(top, ctr))
      const rot = [top[0] + ((top[0] - ctr[0]) / len) * 26, top[1] + ((top[1] - ctr[1]) / len) * 26]
      layers.push(html`<line class="mo-rot-line" x1=${top[0]} y1=${top[1]} x2=${rot[0]} y2=${rot[1]} />`)
      handles.push(html`<circle class="mo-rot" data-h="rot" cx=${rot[0]} cy=${rot[1]} r="6"><title>Drag to rotate around the anchor (⇧ 15° steps)</title></circle>`)
    }
  }

  // Tool previews.
  const ghosts = []
  if (d?.moved && d.kind === 'shape') {
    const drawn = shapeFromDrag(d.shapeKind, d.p0, d.pt, {}, style())
    if (drawn) ghosts.push(shapeGhost(drawn, S, k))
  }
  if (d?.moved && d.kind === 'mask') {
    const box = dragBox(d.p0, d.pt)
    const [a, b2] = [S([box.cx - box.w / 2, box.cy - box.h / 2]), S([box.cx + box.w / 2, box.cy + box.h / 2])]
    ghosts.push(d.maskKind === 'ellipse'
      ? html`<ellipse class="mo-ghost" cx=${(a[0] + b2[0]) / 2} cy=${(a[1] + b2[1]) / 2} rx=${Math.abs(b2[0] - a[0]) / 2} ry=${Math.abs(b2[1] - a[1]) / 2} />`
      : html`<rect class="mo-ghost" x=${Math.min(a[0], b2[0])} y=${Math.min(a[1], b2[1])} width=${Math.abs(b2[0] - a[0])} height=${Math.abs(b2[1] - a[1])} />`)
  }
  if (pen?.points.length) {
    const path = { closed: false, vertices: pen.points.map(v => v.pt), in: pen.points.map(v => [-v.out[0], -v.out[1]]), out: pen.points.map(v => v.out) }
    ghosts.push(html`<polyline class="mo-ghost pen" points=${pts(samplePath(path, 16).map(S))} />`)
    const last = pen.points.at(-1).pt
    if (hover && !d) ghosts.push(html`<line class="mo-rubber" x1=${S(last)[0]} y1=${S(last)[1]} x2=${S(hover)[0]} y2=${S(hover)[1]} />`)
    pen.points.forEach((v, i) => {
      const q = S(v.pt)
      if (v.out[0] || v.out[1]) {
        for (const sgn of [1, -1]) {
          const tq = S([v.pt[0] + sgn * v.out[0], v.pt[1] + sgn * v.out[1]])
          ghosts.push(html`<line class="mo-tan-line" x1=${q[0]} y1=${q[1]} x2=${tq[0]} y2=${tq[1]} /><circle class="mo-tan" cx=${tq[0]} cy=${tq[1]} r="3" />`)
        }
      }
      ghosts.push(html`<rect class=${`mo-vert ${i === 0 && pen.points.length > 2 ? 'first' : ''}`} x=${q[0] - 4} y=${q[1] - 4} width="8" height="8" />`)
    })
  }

  // A readout while dragging.
  let info = null
  if (d?.moved && d.ops?.length && single) {
    const c2 = store.project && view.tracks.flatMap(tr => tr.clips).find(x => x.id === single.id)
    if (c2) {
      const local = t - c2.start
      const txt = d.kind === 'scale' ? `${Math.round(valueAt(view, c2, 'scale', local) * 1000) / 10}%` : d.kind === 'rot' ? `${Math.round(valueAt(view, c2, 'rotation', local) * 10) / 10}°` : d.kind === 'anchor' ? `anchor ${Math.round(valueAt(view, c2, 'anchorX', local))}, ${Math.round(valueAt(view, c2, 'anchorY', local))}` : d.kind === 'move' ? `${Math.round(valueAt(view, c2, 'x', local))}, ${Math.round(valueAt(view, c2, 'y', local))}` : ''
      if (txt) info = html`<div class="mo-info" style=${{ left: `${S(d.pt)[0] + 14}px`, top: `${S(d.pt)[1] + 14}px` }}>${txt}</div>`
    }
  }
  const hint = pen ? 'Click to add points, drag for curves. Click the first point to close, Enter to leave it open, Esc to cancel.' : tool === 'm-mask' && !single ? 'Select one layer, then draw a mask on it.' : null
  const cursor = { 'm-shape': 'crosshair', 'm-pen': 'crosshair', 'm-mask': 'crosshair', 'm-anchor': 'move' }[tool] ?? 'default'

  return html`
    <div class="mo-overlay">
      <svg ref=${svg} class="mo-svg" style=${{ cursor }} onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerLeave=${() => setHover(null)} onDblClick=${onDbl}>
        ${layers}${ghosts}${handles}
      </svg>
      ${info}
      ${hint ? html`<div class="mo-hint">${hint}</div>` : null}
    </div>
  `
}

/** A dashed outline of a shape about to be drawn. */
function shapeGhost(drawn, S, k) {
  const { shape, x, y, rotation } = drawn
  const [cx, cy] = S([x, y])
  if (shape.type === 'rect') return html`<rect class="mo-ghost" x=${cx - (shape.width * k) / 2} y=${cy - (shape.height * k) / 2} width=${shape.width * k} height=${shape.height * k} />`
  if (shape.type === 'ellipse') return html`<ellipse class="mo-ghost" cx=${cx} cy=${cy} rx=${(shape.width * k) / 2} ry=${(shape.height * k) / 2} />`
  const n = shape.type === 'star' ? shape.points * 2 : shape.sides
  const list = []
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / n + (rotation * Math.PI) / 180
    const rr = (shape.type === 'star' && i % 2 ? shape.innerRadius : shape.radius) * k
    list.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr])
  }

  return html`<polygon class="mo-ghost" points=${pts(list)} />`
}

export const overlayActive = s => s.page === 'motion' || isMotionTool(s.tool)
export { NULL_SIZE }
