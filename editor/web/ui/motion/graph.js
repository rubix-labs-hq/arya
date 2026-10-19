// Graph editor: the value graph (keyed value over time, bezier handles on the selected
// keys) and the speed graph (value per second, influence and speed handles), drawn in
// SVG over the layer timeline's time area. Handle drags write [x1, y1, x2, y2] eases
// through keyframe_ease; key drags change time and value.

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { clipEnd, round, sortedKeys, valueAt } from '/core/project.js'
import { store, useStore, useTime } from '../store.js'
import { bezierFromSpeed, dragHandle, handlesOf, speedHandles } from './ease.js'
import { keyId, parseKey } from './keyframes.js'
import { cancel, commit, preview } from './live.js'
import { animatableProps, propertyGroups } from './props.js'
import { ms, mset } from './state.js'

const html = htm.bind(h)
const PAD = 14

/** The curves to show: the picked properties, else every animated property of the selection. */
function curvesOf(view, m, selection) {
  const clips = view.tracks.flatMap(tr => tr.clips)
  const byId = new Map(clips.map(c => [c.id, c]))
  let list = m.graphProps.map(k => k.split('|')).filter(([id, prop]) => byId.get(id)?.anim?.[prop]?.length >= 1)
  if (!list.length) list = selection.flatMap(id => (byId.has(id) ? animatableProps(byId.get(id)).filter(p => byId.get(id).anim?.[p]?.length).map(p => [id, p]) : []))

  return list.map(([id, prop]) => {
    const c = byId.get(id)
    const row = propertyGroups(c).flatMap(g => g.rows).find(r => r.prop === prop)

    return { c, prop, label: `${c.label ?? c.id} · ${row?.label ?? prop}`, scale: row?.scale ?? 1, keys: sortedKeys(c.anim[prop]) }
  })
}

const COLORS = ['#f5b942', '#58a6ff', '#ff6b75', '#3fb950', '#bc8cff', '#39c5cf']

/** The keyed value (expression left out) of a property at clip-local time. */
function keyed(view, c, prop, local) {
  return valueAt(view, c.expr?.[prop] ? { ...c, expr: undefined } : c, prop, local)
}

/** Speed (value per second) inside segment i at fraction u, from the keyed curve. */
function speedIn(view, c, prop, keys, i, u) {
  const a = keys[i][0]
  const dt = keys[i + 1][0] - a
  const d = 0.002
  const u0 = Math.max(0, u - d)
  const u1 = Math.min(1, u + d)

  return (keyed(view, c, prop, a + u1 * dt) - keyed(view, c, prop, a + u0 * dt)) / ((u1 - u0) * dt || 1e-9)
}

export function GraphEditor({ view, X, T, rw, left }) {
  const s = useStore()
  const t = useTime()
  const m = ms()
  const box = useRef(null)
  const [hgt, setHgt] = useState(200)
  const [drag, setDrag] = useState(null)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setHgt(el.clientHeight))
    ro.observe(el)
    setHgt(el.clientHeight)

    return () => ro.disconnect()
  }, [box.current])

  const curves = curvesOf(view, m, s.selection)
  const speedMode = m.graphMode === 'speed'
  const top = PAD
  const innerH = Math.max(20, hgt - PAD * 2)

  // Each curve maps its own range onto the full height (one curve shows its real units).
  const layout = curves.map(cv => {
    const { c, prop, keys } = cv
    const vals = []
    const samples = []
    const t0 = Math.max(c.start, T(0))
    const t1 = Math.min(clipEnd(c), T(rw))
    const step = Math.max(1 / 240, (t1 - t0) / Math.max(40, rw / 2))
    if (!speedMode) {
      for (let tt = t0; tt <= t1 + 1e-9; tt += step) {
        const v = keyed(view, c, prop, tt - c.start)
        samples.push([tt, v])
        vals.push(v)
      }
      for (let i = 0; i < keys.length; i++) {
        vals.push(keys[i][1])
        if (i < keys.length - 1 && keys[i][2] !== 'hold') {
          const hd = handlesOf(keys[i], keys[i + 1], keys[i][2])
          vals.push(hd.out[1], hd.in[1])
        }
      }
    } else {
      for (let i = 0; i < keys.length - 1; i++) {
        const seg = []
        for (let u = 0; u <= 1.0001; u += 1 / 48) {
          const sp = keys[i][2] === 'hold' ? 0 : speedIn(view, c, prop, keys, i, Math.min(1, u))
          seg.push([c.start + keys[i][0] + u * (keys[i + 1][0] - keys[i][0]), sp])
          vals.push(sp)
        }
        samples.push(seg)
      }
      vals.push(0)
    }
    let lo = Math.min(...vals)
    let hi = Math.max(...vals)
    if (!Number.isFinite(lo)) {
      lo = 0
      hi = 1
    }
    if (hi - lo < 1e-6) {
      lo -= 1
      hi += 1
    }
    const pad = (hi - lo) * 0.08
    lo -= pad
    hi += pad
    // Keep the scale still while a drag reshapes the curve under the pointer.
    const frozen = drag?.ranges?.[`${c.id}|${prop}`]
    if (frozen) [lo, hi] = frozen
    const Y = v => top + (1 - (v - lo) / (hi - lo)) * innerH
    const V = y => lo + (1 - (y - top) / innerH) * (hi - lo)

    return { ...cv, samples, lo, hi, Y, V, flat: (hi - lo) / 4 }
  })

  const svgPoint = e => {
    const r = box.current.getBoundingClientRect()

    return [e.clientX - r.left, e.clientY - r.top]
  }

  // ---------------------------------------------------------- drags

  const rangesNow = () => Object.fromEntries(layout.map(L => [`${L.c.id}|${L.prop}`, [L.lo, L.hi]]))

  const startKey = (e, L, i) => {
    e.stopPropagation()
    const id = keyId(L.c.id, L.prop, L.keys[i][0])
    const cur = ms().keySel
    const next = e.shiftKey ? (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]) : cur.includes(id) ? cur : [id]
    mset({ keySel: next })
    if (speedMode) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ kind: 'key', L, i, ops: null, ranges: rangesNow() })
  }
  const startHandle = (e, L, i, side) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ kind: speedMode ? 'speed' : 'handle', L, i, side, ops: null, ranges: rangesNow() })
  }
  const onMove = e => {
    if (!drag) return
    const [x, y] = svgPoint(e)
    const { L, i } = drag
    const { c, prop, keys } = L
    let op = null
    if (drag.kind === 'key') {
      const prev = keys[i - 1]
      const next = keys[i + 1]
      const f = 1 / view.fps
      let lt = Math.round((T(x) - c.start) * view.fps) / view.fps
      lt = Math.max(prev ? prev[0] + f : 0, Math.min(next ? next[0] - f : c.dur, lt))
      if (e.shiftKey) lt = keys[i][0] // Shift: change the value only
      op = { op: 'keyframe_ease', id: c.id, prop, index: i, t: round(lt, 4), value: round(L.V(y), 4) }
    } else {
      // Segment `seg` runs from keys[seg] to keys[seg + 1]; 'out' leaves key i, 'in' arrives at it.
      const seg = drag.side === 'out' ? i : i - 1
      const a = keys[seg]
      const b = keys[seg + 1]
      if (!a || !b) return
      const lt = T(x) - c.start
      let ease
      if (drag.kind === 'handle') ease = dragHandle(a, b, a[2], drag.side, [lt, L.V(y)], L.flat)
      else {
        const dt = b[0] - a[0]
        const influence = drag.side === 'out' ? (lt - a[0]) / dt : (b[0] - lt) / dt
        ease = bezierFromSpeed(a, b, a[2], drag.side, influence, L.V(y))
      }
      op = { op: 'keyframe_ease', id: c.id, prop, index: seg, ease }
    }
    setDrag({ ...drag, ops: [op] })
    preview([op])
  }
  const onUp = () => {
    if (!drag) return
    const ops = drag.ops
    const d = drag
    setDrag(null)
    if (!ops) return cancel()
    commit(ops, d.kind === 'key' ? 'move key' : 'ease handle')
    if (d.kind === 'key') mset({ keySel: [keyId(d.L.c.id, d.L.prop, ops[0].t)] })
  }

  // ---------------------------------------------------------- drawing

  const sel = new Set(m.keySel)
  const grid = []
  const first = layout[0]
  if (first) {
    for (let g = 0; g <= 4; g++) {
      const y = top + (g * innerH) / 4
      const v = first.V(y) * first.scale
      grid.push(html`<line class="g-grid" x1="0" y1=${y} x2=${rw} y2=${y} /><text class="g-label" x="4" y=${y - 3}>${fmt(v)}${speedMode ? '/s' : ''}</text>`)
    }
  }
  const ph = X(t)

  return html`
    <div class="mt-graph" ref=${box} style=${{ left: `${left}px` }}>
      ${!layout.length ? html`<div class="g-empty">Click a property name (⇧ for more) or select an animated layer to see its curves.</div>` : null}
      <svg class="g-svg" width=${rw} height=${hgt} onPointerMove=${onMove} onPointerUp=${onUp} onPointerDown=${e => e.target === e.currentTarget && !e.shiftKey && mset({ keySel: [] })}>
        ${grid}
        ${!speedMode && first ? html`<line class="g-zero" x1="0" y1=${first.Y(0)} x2=${rw} y2=${first.Y(0)} />` : null}
        ${layout.map((L, ci) => {
          const color = COLORS[ci % COLORS.length]
          const { c, keys } = L
          const parts = []
          if (!speedMode) parts.push(html`<polyline class="g-curve" stroke=${color} points=${L.samples.map(([tt, v]) => `${X(tt).toFixed(1)},${L.Y(v).toFixed(1)}`).join(' ')} />`)
          else for (const seg of L.samples) parts.push(html`<polyline class="g-curve" stroke=${color} points=${seg.map(([tt, v]) => `${X(tt).toFixed(1)},${L.Y(v).toFixed(1)}`).join(' ')} />`)
          keys.forEach((k, i) => {
            const id = keyId(c.id, L.prop, k[0])
            const kx = X(c.start + k[0])
            const isSel = sel.has(id)
            if (!speedMode) {
              const ky = L.Y(k[1])
              if (isSel) {
                if (i < keys.length - 1 && k[2] !== 'hold') {
                  const hd = handlesOf(k, keys[i + 1], k[2], L.flat)
                  const hx = X(c.start + hd.out[0])
                  const hy = L.Y(hd.out[1])
                  parts.push(html`<line class="g-hline" x1=${kx} y1=${ky} x2=${hx} y2=${hy} /><circle class="g-handle" data-h="out" data-key=${id} cx=${hx} cy=${hy} r="5" onPointerDown=${e => startHandle(e, L, i, 'out')}><title>Outgoing ease: drag to shape the curve</title></circle>`)
                }
                if (i > 0 && keys[i - 1][2] !== 'hold') {
                  const hd = handlesOf(keys[i - 1], k, keys[i - 1][2], L.flat)
                  const hx = X(c.start + hd.in[0])
                  const hy = L.Y(hd.in[1])
                  parts.push(html`<line class="g-hline" x1=${kx} y1=${ky} x2=${hx} y2=${hy} /><circle class="g-handle" data-h="in" data-key=${id} cx=${hx} cy=${hy} r="5" onPointerDown=${e => startHandle(e, L, i, 'in')}><title>Incoming ease: drag to shape the curve</title></circle>`)
                }
              }
              parts.push(html`<rect class=${`g-key ${isSel ? 'sel' : ''}`} data-key=${id} x=${kx - 4.5} y=${ky - 4.5} width="9" height="9" stroke=${color} onPointerDown=${e => startKey(e, L, i)}><title>${L.label} ${round(k[0], 3)} s = ${fmt(k[1] * L.scale)}. Drag to move (⇧ value only)</title></rect>`)
            } else {
              // Speed at the key from each side; handles show influence and speed.
              const sIn = i > 0 ? speedHandles(keys[i - 1], k, keys[i - 1][2]).in : null
              const sOut = i < keys.length - 1 ? speedHandles(k, keys[i + 1], k[2]).out : null
              const yIn = sIn ? L.Y(keys[i - 1][2] === 'hold' ? 0 : sIn.speed) : null
              const yOut = sOut ? L.Y(k[2] === 'hold' ? 0 : sOut.speed) : null
              if (yIn !== null && yOut !== null) parts.push(html`<line class="g-hline" x1=${kx} y1=${yIn} x2=${kx} y2=${yOut} />`)
              if (isSel && sOut && k[2] !== 'hold') {
                const hx = X(c.start + k[0] + sOut.influence * (keys[i + 1][0] - k[0]))
                parts.push(html`<line class="g-hline" x1=${kx} y1=${yOut} x2=${hx} y2=${yOut} /><circle class="g-handle" data-h="out" data-key=${id} cx=${hx} cy=${yOut} r="5" onPointerDown=${e => startHandle(e, L, i, 'out')}><title>Influence ${Math.round(sOut.influence * 100)}%, speed ${fmt(sOut.speed * L.scale)}/s</title></circle>`)
              }
              if (isSel && sIn && keys[i - 1][2] !== 'hold') {
                const hx = X(c.start + k[0] - sIn.influence * (k[0] - keys[i - 1][0]))
                parts.push(html`<line class="g-hline" x1=${kx} y1=${yIn} x2=${hx} y2=${yIn} /><circle class="g-handle" data-h="in" data-key=${id} cx=${hx} cy=${yIn} r="5" onPointerDown=${e => startHandle(e, L, i, 'in')}><title>Influence ${Math.round(sIn.influence * 100)}%, speed ${fmt(sIn.speed * L.scale)}/s</title></circle>`)
              }
              for (const y of [yIn, yOut]) if (y !== null) parts.push(html`<rect class=${`g-key ${isSel ? 'sel' : ''}`} data-key=${id} x=${kx - 4} y=${y - 4} width="8" height="8" stroke=${color} onPointerDown=${e => startKey(e, L, i)} />`)
            }
          })

          return html`<g>${parts}</g>`
        })}
        ${ph >= 0 && ph <= rw ? html`<line class="g-ph" x1=${ph} y1="0" x2=${ph} y2=${hgt} />` : null}
      </svg>
      <div class="g-legend">${layout.map((L, ci) => html`<span style=${{ color: COLORS[ci % COLORS.length] }}>${L.label}</span>`)}</div>
    </div>
  `
}

const fmt = v => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2))

export { parseKey }
