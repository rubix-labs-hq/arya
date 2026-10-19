// The layer timeline (After Effects style) for the open composition: one row per layer
// with switches (visible, solo, lock), blend mode, track matte and parent (pick whip or
// menu); twirl-down property rows with stopwatches, values, keyframe navigation and
// expressions; keyframe diamonds you select (click, shift, box), drag in time, copy,
// paste, delete and ease; layer bars you move and trim.

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { BLEND_MODES, clipEnd, compDuration, duration, MATTE_MODES, round, snapToFrame, sortedKeys, timecode } from '/core/project.js'
import { player } from '../engine-host.js'
import { Num } from '../inspector.js'
import { openMenu } from '../menu.js'
import { edit, set, store, time, toast, useStore, useTime, viewProject } from '../store.js'
import { openComposition } from '../timeline.js'
import { ExpressionRow } from './expr.js'
import { GraphEditor } from './graph.js'
import { bezierOf } from './ease.js'
import { easeOps, keyId, retimeOps } from './keyframes.js'
import { cancel, commit, preview } from './live.js'
import { inView, layerRows, layerTrack, newLayerSpan, setValueOp, soloOps } from './ops.js'
import { TEXT_ANIMATORS } from './presets.js'
import { propertyGroups, propValue } from './props.js'
import { ms, mset } from './state.js'

const html = htm.bind(h)

export const ROW = 22
export const LEFT = 560

const KIND_ICON = { shape: '◆', null: '✛', title: 'T', video: '▶', image: '▣', comp: '⧉', color: '■', adjustment: '◐', multicam: '⊞' }
const MATTE_LABEL = { alpha: 'Alpha', alphaInverted: 'Alpha inv', luma: 'Luma', lumaInverted: 'Luma inv' }

/** Window-level pointer drag: move(ev, dx, dy), up(ev, moved). */
function drag(e, { move, up }) {
  const x0 = e.clientX
  const y0 = e.clientY
  let moved = false
  const mv = ev => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return
    moved = true
    move?.(ev, ev.clientX - x0, ev.clientY - y0)
  }
  const fin = ev => {
    removeEventListener('pointermove', mv)
    removeEventListener('pointerup', fin)
    up?.(ev, moved)
  }
  addEventListener('pointermove', mv)
  addEventListener('pointerup', fin)
}

const layerName = c => c.label ?? (c.kind === 'title' ? c.title?.text?.split('\n')[0] : String(c.src ?? c.kind).split('/').pop())

/** The time span the layer timeline shows. */
export function viewSpan(view) {
  return view.compId ? compDuration(view.comps?.[view.compId]) : Math.max(5, duration(view))
}

/** px per second and the left edge for a right-area width. */
export function timeScale(view, width) {
  const m = ms()
  const zoom = m.zoom || Math.max(1, (width - 2 * PAD_X - 8) / viewSpan(view))
  const scroll = m.zoom ? m.scroll : 0

  return { zoom, scroll, X: tt => (tt - scroll) * zoom + PAD_X, T: x => (x - PAD_X) / zoom + scroll }
}

/** Room left of time 0, so keys at the start stay whole. */
const PAD_X = 10

/** The rows the timeline shows, flattened: layers, groups, properties, expressions. */
function buildRows(view, m, selection) {
  const out = []
  const reveal = m.reveal
  let n = 0
  for (const { track, clip } of layerRows(view)) {
    out.push({ type: 'layer', track, clip, n: ++n })
    const revealHere = reveal && (selection.length === 0 || selection.includes(clip.id))
    if (revealHere) {
      for (const g of propertyGroups(clip)) {
        for (const row of g.rows) {
          if (!row.anim) continue
          const match = reveal.animated ? Boolean(clip.anim?.[row.prop]?.length || clip.expr?.[row.prop]) : reveal.props.includes(row.prop)
          if (match) pushProp(out, m, clip, row, 1)
        }
      }
      continue
    }
    if (!m.open[clip.id]) continue
    for (const g of propertyGroups(clip)) {
      const open = m.groups[`${clip.id}:${g.id}`] ?? g.id === 'transform'
      out.push({ type: 'group', clip, group: g, open })
      if (!open) continue
      for (const row of g.rows) {
        if (row.anim) pushProp(out, m, clip, row, 2)
        else out.push({ type: row.kind ?? 'static', clip, row, depth: 2 })
      }
    }
  }

  return out
}

function pushProp(out, m, clip, row, depth) {
  out.push({ type: 'prop', clip, row, depth })
  const key = `${clip.id}|${row.prop}`
  if (m.exprOpen[key] ?? Boolean(clip.expr?.[row.prop])) out.push({ type: 'expr', clip, row, depth })
}

// ---------------------------------------------------------------- the panel

export function LayerTimeline() {
  const s = useStore()
  const t = useTime()
  const view = viewProject()
  const m = ms()
  const ruler = useRef(null)
  const body = useRef(null)
  const [rw, setRw] = useState(600)
  const [box, setBox] = useState(null) // marquee in client px
  const [whip, setWhip] = useState(null) // pick whip line in client px

  useEffect(() => {
    const el = ruler.current
    if (!el) return
    const ro = new ResizeObserver(() => setRw(el.clientWidth))
    ro.observe(el)
    setRw(el.clientWidth)

    return () => ro.disconnect()
  }, [ruler.current])

  if (!view) return html`<div class="mt empty">No project</div>`
  const { zoom, scroll, X, T } = timeScale(view, rw)
  const rows = buildRows(view, m, s.selection)
  const span = viewSpan(view)
  const fps = view.fps

  const zoomBy = (f, atX = rw / 2) => {
    const at = T(atX)
    const z = Math.max(4, Math.min(4000, zoom * f))
    mset({ zoom: z, scroll: Math.max(0, at - (atX - PAD_X) / z) })
  }
  const onWheel = e => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const r = ruler.current.getBoundingClientRect()
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left)
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault()
      mset({ zoom, scroll: Math.max(0, scroll + (e.deltaX || e.deltaY) / zoom) })
    }
  }
  const scrub = e => {
    const r = ruler.current.getBoundingClientRect()
    const go = ev => player.seek(Math.max(0, Math.min(span, snapToFrame(T(ev.clientX - r.left), fps))))
    if (player.playing) player.pause()
    go(e)
    drag(e, { move: go })
  }

  // Box selection of keyframes over the right side of the rows.
  const marquee = e => {
    if (e.button !== 0 || e.target.closest('.kd, .mt-lbar')) return
    const x0 = e.clientX
    const y0 = e.clientY
    const add = e.shiftKey
    drag(e, {
      move: ev => setBox({ x: Math.min(x0, ev.clientX), y: Math.min(y0, ev.clientY), w: Math.abs(ev.clientX - x0), h: Math.abs(ev.clientY - y0) }),
      up: (ev, moved) => {
        setBox(null)
        if (!moved) {
          if (!add) mset({ keySel: [] })

          return
        }
        const r = { x0: Math.min(x0, ev.clientX), x1: Math.max(x0, ev.clientX), y0: Math.min(y0, ev.clientY), y1: Math.max(y0, ev.clientY) }
        const hit = [...body.current.querySelectorAll('.kd')].filter(el => {
          const b = el.getBoundingClientRect()
          const cx = b.left + b.width / 2
          const cy = b.top + b.height / 2

          return cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1
        }).map(el => el.dataset.key)
        mset({ keySel: add ? [...new Set([...ms().keySel, ...hit])] : hit })
      },
    })
  }

  const ticks = rulerTicks(zoom, scroll, rw, fps)
  const sel = m.keySel
  const ph = X(t)

  return html`
    <div class="mt" onWheel=${onWheel}>
      <${TimelineBar} view=${view} zoomBy=${zoomBy} />
      <div class="mt-head">
        <div class="mt-cols" style=${{ width: `${LEFT}px` }}>
          <span></span><span class="c">#</span><span class="c" title="Visible"><span class="ui-glyph glyph-eye" aria-hidden="true"></span></span><span class="c" title="Solo">S</span><span class="c" title="Lock (the layer's track)"><span class="ui-glyph glyph-lock" aria-hidden="true"></span></span><span></span>
          <span>Layer</span><span>Mode</span><span>Track matte</span><span></span><span>Parent</span>
        </div>
        <div class="mt-ruler" ref=${ruler} onPointerDown=${scrub}>
          ${ticks.map(tk => html`<div class=${`mt-tick ${tk.major ? 'major' : ''}`} style=${{ left: `${X(tk.t)}px` }}>${tk.major ? html`<span>${tk.label}</span>` : null}</div>`)}
          <div class="mt-span-end" style=${{ left: `${X(span)}px` }}></div>
          ${ph >= -8 && ph <= rw + 8 ? html`<div class="mt-head-ph" style=${{ left: `${ph}px` }}><span>${timecode(t, fps)}</span></div>` : null}
        </div>
      </div>
      <div class="mt-body" ref=${body}>
        <div class="mt-scroll">
          ${rows.length ? rows.map(row => html`<${Row} key=${rowKey(row)} row=${row} view=${view} X=${X} zoom=${zoom} sel=${sel} marquee=${marquee} setWhip=${setWhip} rw=${rw} />`) : html`<div class="mt-empty">No layers yet. Draw a shape with the tools above the viewer, or add a null from the + menu.</div>`}
        </div>
        ${m.graph ? html`<${GraphEditor} view=${view} X=${X} T=${T} zoom=${zoom} rw=${rw} left=${LEFT} />` : null}
        ${!m.graph && ph >= 0 && ph <= rw ? html`<div class="mt-ph" style=${{ left: `${LEFT + ph}px` }}></div>` : null}
        ${!m.graph && X(span) < rw ? html`<div class="mt-after" style=${{ left: `${LEFT + Math.max(0, X(span))}px` }}></div>` : null}
      </div>
      ${box ? html`<div class="mt-marquee" style=${{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` }}></div>` : null}
      ${whip ? html`<svg class="mt-whip"><line x1=${whip.x0} y1=${whip.y0} x2=${whip.x} y2=${whip.y} /><circle cx=${whip.x} cy=${whip.y} r="4" /></svg>` : null}
    </div>
  `
}

const rowKey = r => `${r.type}:${r.clip.id}:${r.group?.id ?? ''}:${r.row?.prop ?? r.row?.path ?? r.row?.kind ?? ''}`

function rulerTicks(zoom, scroll, width, fps) {
  const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  const major = steps.find(st => st * zoom >= 70) ?? 300
  const minor = steps.filter(st => st < major).reverse().find(st => st * zoom >= 10 && Math.abs(major / st - Math.round(major / st)) < 1e-6) ?? major
  const out = []
  const first = Math.max(0, Math.floor(scroll / minor))
  for (let i = first; (i * minor - scroll) * zoom <= width + 1; i++) {
    const tt = i * minor
    const isMajor = Math.abs(tt / major - Math.round(tt / major)) < 1e-6
    out.push({ t: tt, major: isMajor, label: tickLabel(tt, fps) })
  }

  return out
}

/** Seconds as "2s", or seconds and frames as "2s 15f" between whole seconds. */
function tickLabel(tt, fps) {
  let sec = Math.floor(tt + 1e-6)
  let f = Math.round((tt - sec) * fps)
  if (f >= fps) {
    sec += 1
    f = 0
  }
  const s = sec >= 60 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s` : `${sec}s`

  return f ? `${s} ${f}f` : s
}

// ---------------------------------------------------------------- toolbar

function TimelineBar({ view, zoomBy }) {
  const s = useStore()
  const m = ms()
  const n = m.keySel.length
  const ease = mode => {
    if (!n) return toast('Select keyframes first')
    edit(easeOps(store.project, m.keySel, mode), `ease: ${mode}`)
  }
  const comp = view.compId ? view.comps[view.compId] : null
  const addMenu = e => openMenu(e.clientX, e.clientY, [
    { label: 'Null object', run: () => addLayer(view, 'null') },
    { label: 'Text', run: () => addLayer(view, 'title') },
    { label: 'Solid (color)', run: () => addLayer(view, 'color') },
    { label: 'Adjustment layer', run: () => addLayer(view, 'adjustment') },
  ])

  return html`
    <div class="mt-bar">
      <span class="mt-title">${comp ? html`<b>${comp.name}</b> <span class="muted">${comp.width}×${comp.height} · ${comp.fps} fps · ${compDuration(comp)} s</span>` : html`<b>Main timeline</b> <span class="muted">open a composition to work in it</span>`}</span>
      <button class="ghost tiny" title="Add a layer" onClick=${addMenu}>＋ Layer</button>
      <span class="grow"></span>
      <span class="muted small">${n ? `${n} key${n > 1 ? 's' : ''}` : ''}</span>
      <div class="seg mt-ease">
        <button title="Linear" onClick=${() => ease('linear')}>Linear</button>
        <button title="Easy Ease (F9)" onClick=${() => ease('easy')}>Easy ease</button>
        <button title="Easy Ease In (⇧F9)" onClick=${() => ease('in')}>Ease in</button>
        <button title="Easy Ease Out (⌘⇧F9)" onClick=${() => ease('out')}>Ease out</button>
        <button title="Hold: jump to the next key's value" onClick=${() => ease('hold')}>Hold</button>
        <button title="More eases" onClick=${e => openMenu(e.clientX, e.clientY, ['smooth', 'backOut', 'expoOut', 'expoIn', 'inOut'].map(name => ({ label: name, run: () => ease(name) })))}>⋯</button>
      </div>
      <button class=${`ghost tiny ${m.reveal?.animated ? 'on' : ''}`} title="Show animated properties only (U)" onClick=${() => mset({ reveal: m.reveal?.animated ? null : { animated: true } })}>U</button>
      <button class=${`ghost tiny ${m.graph ? 'on' : ''}`} title="Graph editor" onClick=${() => mset({ graph: !m.graph })}>Graph</button>
      ${m.graph ? html`<div class="seg"><button class=${m.graphMode === 'value' ? 'on' : ''} onClick=${() => mset({ graphMode: 'value' })}>Value</button><button class=${m.graphMode === 'speed' ? 'on' : ''} onClick=${() => mset({ graphMode: 'speed' })}>Speed</button></div>` : null}
      <button class="ghost tiny" title="Zoom out" onClick=${() => zoomBy(1 / 1.5)}>−</button>
      <button class="ghost tiny" title="Zoom to fit" onClick=${() => mset({ zoom: 0, scroll: 0 })}>⤢</button>
      <button class="ghost tiny" title="Zoom in" onClick=${() => zoomBy(1.5)}>+</button>
    </div>
  `
}

async function addLayer(view, kind) {
  const { start, dur } = newLayerSpan(view, time.t)
  const { ops, track } = layerTrack(view, start, dur)
  const op = kind === 'null' ? { op: 'add_null', track, start, dur, name: 'Null' }
    : kind === 'title' ? { op: 'add_title', track, start, dur, text: 'Text', title: { anim: 'none' } }
    : kind === 'color' ? { op: 'add_color', track, start, dur, color: '#3a63c7' }
    : { op: 'adjustment', track, start, dur }
  const res = await edit([...ops, inView(view, op)], `add ${kind}`)
  const id = res?.created?.filter(x => /^c\d+$/.test(x)).at(-1)
  if (id) set({ selection: [id] })
}

// ---------------------------------------------------------------- rows

function Row(props) {
  const { row } = props
  if (row.type === 'layer') return html`<${LayerRow} ...${props} />`
  if (row.type === 'group') return html`<${GroupRow} ...${props} />`
  if (row.type === 'prop') return html`<${PropRow} ...${props} />`
  if (row.type === 'expr') {
    return html`<div class="mt-row expr" style=${{ height: `${ROW + 4}px` }}><div class="mt-l" style=${{ paddingLeft: `${row.depth * 16 + 30}px` }}><${ExpressionRow} view=${props.view} clip=${row.clip} prop=${row.row.prop} scale=${row.row.scale ?? 1} /></div><div class="mt-r" onPointerDown=${props.marquee}></div></div>`
  }

  return html`<${StaticRow} ...${props} />`
}

function LayerRow({ row, view, X, zoom, marquee, setWhip }) {
  const s = store
  const m = ms()
  const { clip: c, track, n } = row
  const isSel = s.selection.includes(c.id)
  const [renaming, setRenaming] = useState(false)
  const others = view.tracks.filter(tr => tr.kind === 'video').flatMap(tr => tr.clips).filter(x => x.id !== c.id)
  const parent = others.find(o => o.id === c.parent)
  const select = e => {
    if (e.shiftKey || e.metaKey) set({ selection: isSel ? s.selection.filter(x => x !== c.id) : [...s.selection, c.id] })
    else set({ selection: [c.id] })
  }
  const toggleOpen = e => {
    e.stopPropagation()
    mset({ open: { ...m.open, [c.id]: !m.open[c.id] }, reveal: null })
  }
  const parentTo = id => edit({ op: 'parent', id: c.id, parent: id || null, at: time.t }, id ? `parent ${c.id} to ${id}` : `unparent ${c.id}`)
  const startWhip = e => {
    e.stopPropagation()
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    const x0 = r.left + r.width / 2
    const y0 = r.top + r.height / 2
    drag(e, {
      move: ev => setWhip({ x0, y0, x: ev.clientX, y: ev.clientY }),
      up: (ev, moved) => {
        setWhip(null)
        if (!moved) return
        const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-layer]')?.dataset.layer
        if (target && target !== c.id) parentTo(target)
      },
    })
  }

  // Layer bar: drag the body to move (every selected layer), the ends to trim.
  const barDown = e => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (!isSel) select(e)
    const ids = isSel ? s.selection : [c.id]
    const p0 = viewProject()
    const starts = new Map(p0.tracks.flatMap(tr => tr.clips).filter(x => ids.includes(x.id)).map(x => [x.id, x.start]))
    let ops = []
    drag(e, {
      move: (ev, dx) => {
        let dt = dx / zoom
        // Snap the dragged layer's start to the playhead within 6 px.
        if (Math.abs((c.start + dt - time.t) * zoom) < 6) dt = time.t - c.start
        ops = [...starts].map(([id, st]) => ({ op: 'move', id, start: Math.max(0, snapToFrame(st + dt, view.fps)) }))
        preview(ops)
      },
      up: (_, moved) => (moved ? commit(ops, 'move layers') : cancel()),
    })
  }
  const edgeDown = (e, edge) => {
    e.stopPropagation()
    let op = null
    drag(e, {
      move: (ev, dx) => {
        let to = (edge === 'left' ? c.start : clipEnd(c)) + dx / zoom
        if (Math.abs((to - time.t) * zoom) < 6) to = time.t
        op = { op: 'trim', id: c.id, edge, to: Math.max(0, snapToFrame(to, view.fps)) }
        preview([op])
      },
      up: (_, moved) => (moved && op ? commit([op], `trim ${edge}`) : cancel()),
    })
  }
  const visible = c.enabled !== false

  return html`
    <div class=${`mt-row layer ${isSel ? 'sel' : ''} ${visible ? '' : 'off'}`} data-layer=${c.id} style=${{ height: `${ROW}px` }}>
      <div class="mt-l mt-grid" onPointerDown=${e => !e.target.closest('button, select, input, .whip') && select(e)} onDblClick=${() => c.kind === 'comp' && openComposition(c.comp)}>
        <button class="tw" aria-label=${`${m.open[c.id] ? 'Collapse' : 'Expand'} ${c.name ?? c.id}`} aria-expanded=${!!m.open[c.id]} onClick=${toggleOpen}>${m.open[c.id] ? '▾' : '▸'}</button>
        <span class="c num">${n}</span>
        <button class=${`sw ${visible ? 'on' : ''}`} aria-label="Visible" aria-pressed=${visible} title=${visible ? 'Hide layer' : 'Show layer'} onClick=${() => edit({ op: 'update', id: c.id, set: { enabled: visible ? false : null } })}>${visible ? html`<span class="ui-glyph glyph-eye" aria-hidden="true"></span>` : '·'}</button>
        <button class=${`sw ${c.solo ? 'on solo' : ''}`} aria-label="Solo" aria-pressed=${Boolean(c.solo)} title="Solo: hides the tracks of every layer that is not soloed" onClick=${() => edit(soloOps(view, c.id), c.solo ? 'unsolo' : 'solo')}>S</button>
        <button class=${`sw ${track.locked ? 'on' : ''}`} aria-label="Lock track" aria-pressed=${Boolean(track.locked)} title=${`${track.locked ? 'Unlock' : 'Lock'} track ${track.id}${track.clips.length > 1 ? ` (${track.clips.length} layers)` : ''}`} onClick=${() => edit(inView(view, { op: 'update_track', id: track.id, set: { locked: track.locked ? null : true } }))}>${track.locked ? html`<span class="ui-glyph glyph-lock" aria-hidden="true"></span>` : '·'}</button>
        <span class="kind" title=${c.kind}>${KIND_ICON[c.kind] ?? '•'}</span>
        ${renaming
          ? html`<input class="mt-rename" value=${layerName(c)} autofocus onKeyDown=${e => {
              e.stopPropagation()
              if (e.key === 'Enter') e.target.blur()
              if (e.key === 'Escape') setRenaming(false)
            }} onBlur=${e => {
              setRenaming(false)
              if (e.target.value && e.target.value !== layerName(c)) edit({ op: 'update', id: c.id, set: { label: e.target.value } }, 'rename layer')
            }} />`
          : html`<span class="name" title=${`${c.id} · double-click to rename`} onDblClick=${e => (e.stopPropagation(), setRenaming(true))}>${layerName(c)}</span>`}
        <select class="mode mt-choice" value=${c.blend ?? 'normal'} aria-label=${`Blend mode for ${layerName(c)}`} title=${`Blend mode: ${c.blend ?? 'normal'}`} onChange=${e => edit({ op: 'update', id: c.id, set: { blend: e.target.value === 'normal' ? null : e.target.value } })}>${BLEND_MODES.map(b => html`<option value=${b}>${b}</option>`)}</select>
        <select class="matte mt-choice" value=${c.matte?.mode ?? ''} aria-label=${`Track matte for ${layerName(c)}`} title=${`Track matte: ${MATTE_LABEL[c.matte?.mode] ?? 'No matte'}. Uses the layer above.`} onChange=${e => edit({ op: 'matte', id: c.id, matte: e.target.value ? { mode: e.target.value } : null })}>
          <option value="">No matte</option>${MATTE_MODES.map(md => html`<option value=${md}>${MATTE_LABEL[md]}</option>`)}
        </select>
        <span class="whip" title="Pick whip: drag onto another layer to parent to it" onPointerDown=${startWhip}>@</span>
        <select class="parent mt-choice" value=${c.parent ?? ''} aria-label=${`Parent for ${layerName(c)}`} title=${`Parent: ${parent ? layerName(parent) : 'None'}`} onChange=${e => parentTo(e.target.value)}>
          <option value="">None</option>${others.map(o => html`<option value=${o.id}>${layerName(o)}</option>`)}
        </select>
      </div>
      <div class="mt-r" onPointerDown=${marquee}>
        <div class=${`mt-lbar k-${c.kind} ${isSel ? 'sel' : ''}`} style=${{ left: `${X(c.start)}px`, width: `${Math.max(2, c.dur * zoom)}px` }} onPointerDown=${barDown} title=${`${layerName(c)}: ${round(c.start, 3)}–${round(clipEnd(c), 3)} s`}>
          <div class="mt-edge l" onPointerDown=${e => edgeDown(e, 'left')}></div>
          <span>${layerName(c)}</span>
          <div class="mt-edge r" onPointerDown=${e => edgeDown(e, 'right')}></div>
        </div>
      </div>
    </div>
  `
}

function GroupRow({ row, marquee }) {
  const m = ms()
  const { clip: c, group: g, open } = row
  const key = `${c.id}:${g.id}`
  const mask = g.mask ? c.masks?.find(x => x.id === g.mask) : null

  return html`
    <div class="mt-row group" style=${{ height: `${ROW}px` }}>
      <div class="mt-l" style=${{ paddingLeft: '30px' }}>
        <button class="tw" aria-label=${open ? 'Collapse group' : 'Expand group'} aria-expanded=${!!open} onClick=${() => mset({ groups: { ...m.groups, [key]: !open } })}>${open ? '▾' : '▸'}</button>
        <span class="glabel">${g.label}</span>
        ${mask ? html`
          <span class="grow"></span>
          <label class="mt-check" title="Invert the mask"><input type="checkbox" checked=${Boolean(mask.inverted)} onChange=${e => edit({ op: 'update_mask', id: c.id, mask: mask.id, set: { inverted: e.target.checked } })} /> Inverted</label>
          <button class="ghost tiny danger" title="Delete this mask" onClick=${() => edit({ op: 'delete_mask', id: c.id, mask: mask.id })}>✕</button>` : null}
      </div>
      <div class="mt-r" onPointerDown=${marquee}></div>
    </div>
  `
}

function StaticRow({ row, view, marquee }) {
  const { clip: c, row: r } = row
  let control = null
  if (row.type === 'mask-type') {
    const mk = c.masks?.find(x => x.id === r.mask)
    control = html`<span class="mt-static">${mk?.type ?? 'rect'}${mk?.type === 'path' ? ` · ${mk.path?.vertices?.length ?? 0} points` : ''}</span>`
  } else if (row.type === 'mask-mode') {
    const mk = c.masks?.find(x => x.id === r.mask)
    control = html`<select value=${mk?.mode ?? 'add'} onChange=${e => edit({ op: 'update_mask', id: c.id, mask: r.mask, set: { mode: e.target.value } })}>${['add', 'subtract', 'intersect'].map(md => html`<option value=${md}>${md}</option>`)}</select>`
  } else if (row.type === 'title-anim') {
    control = html`<select value=${c.title?.anim ?? 'none'} title="Text animator: how the title enters" onChange=${e => edit({ op: 'update', id: c.id, set: { title: { anim: e.target.value } } }, 'text animator')}>${TEXT_ANIMATORS.map(a => html`<option value=${a.anim}>${a.label}${a.perChar ? ' (per character)' : ''}</option>`)}</select>`
  } else {
    const parts = r.path.split('.')
    const value = parts.reduce((o, kk) => (o == null ? undefined : o[kk]), c) ?? r.fallback ?? 0
    control = html`<${Num} label=${r.label} value=${value} step=${r.step} min=${r.min} max=${r.max} unit=${r.unit} digits=${r.digits}
      onCommit=${v => edit({ op: 'update', id: c.id, set: parts.reduceRight((acc, kk) => ({ [kk]: acc }), v) })} />`
    return html`<div class="mt-row prop static" style=${{ height: `${ROW}px` }}><div class="mt-l" style=${{ paddingLeft: `${row.depth * 16 + 30}px` }}><span class="stopwatch none" title="The renderer draws titles as stored, so this value cannot be keyframed yet"></span>${control}</div><div class="mt-r" onPointerDown=${marquee}></div></div>`
  }

  return html`<div class="mt-row prop static" style=${{ height: `${ROW}px` }}><div class="mt-l" style=${{ paddingLeft: `${row.depth * 16 + 30}px` }}><span class="stopwatch none"></span><span class="plabel">${r.label}</span>${control}</div><div class="mt-r" onPointerDown=${marquee}></div></div>`
}

function PropRow({ row, view, X, sel, marquee }) {
  const t = useTime()
  const m = ms()
  const { clip: c, row: r } = row
  const prop = r.prop
  const keys = sortedKeys(c.anim?.[prop])
  const local = Math.max(0, Math.min(c.dur, t - c.start))
  const value = propValue(view, c, prop, local, r.fallback) * (r.scale ?? 1)
  const at = () => Math.min(clipEnd(c), Math.max(c.start, time.t))
  const gkey = `${c.id}|${prop}`
  const inGraph = m.graphProps.includes(gkey)
  const hasExpr = Boolean(c.expr?.[prop])

  const stopwatch = e => {
    if (e.altKey) {
      mset({ exprOpen: { ...m.exprOpen, [gkey]: !(m.exprOpen[gkey] ?? hasExpr) } })

      return
    }
    if (keys.length) edit({ op: 'clear_keyframes', id: c.id, prop }, `stop animating ${prop}`)
    else edit({ op: 'keyframe', id: c.id, prop, at: at(), value: propValue(view, c, prop, local, r.fallback) }, `animate ${prop}`)
  }
  const here = keys.find(k => Math.abs(k[0] - local) < 1 / (2 * view.fps))
  const prev = [...keys].reverse().find(k => k[0] < local - 1e-3)
  const next = keys.find(k => k[0] > local + 1e-3)
  const toggleKey = () => edit(here
    ? { op: 'keyframe', id: c.id, prop, at: here[0], local: true, remove: true }
    : { op: 'keyframe', id: c.id, prop, at: at(), value: propValue(view, c, prop, local, r.fallback) })
  const write = v => setValueOp(c, prop, v / (r.scale ?? 1), at())
  const pickProp = e => {
    const list = e.shiftKey ? (inGraph ? m.graphProps.filter(x => x !== gkey) : [...m.graphProps, gkey]) : [gkey]
    mset({ graphProps: list })
  }

  // Keyframe diamonds: click selects (shift adds), drag retimes every selected key.
  const keyDown = (e, id) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const cur = ms().keySel
    let next = cur
    if (e.shiftKey) next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]
    else if (!cur.includes(id)) next = [id]
    mset({ keySel: next })
    const base = store.project
    const zoom = X(1) - X(0)
    let res = null
    drag(e, {
      move: (ev, dx) => {
        res = retimeOps(base, next, dx / zoom, view.fps)
        preview(res.ops)
      },
      up: (_, moved) => {
        if (moved && res) {
          commit(res.ops, `move ${next.length} key${next.length > 1 ? 's' : ''}`)
          mset({ keySel: res.selection })
        } else {
          cancel()
          if (!e.shiftKey) player.seek(c.start + parseFloat(id.split('|').at(-1)))
        }
      },
    })
  }

  return html`
    <div class=${`mt-row prop ${inGraph ? 'graphed' : ''}`} style=${{ height: `${ROW}px` }}>
      <div class="mt-l" style=${{ paddingLeft: `${row.depth * 16 + 30}px` }}>
        <button class=${`stopwatch ${keys.length ? 'on' : ''} ${hasExpr ? 'expr' : ''}`} aria-label=${`Animate ${r.label}`} aria-pressed=${keys.length > 0} title="Stopwatch: animate this property (click again to remove its keys). ⌥-click: expression" onClick=${stopwatch}><span class="ui-glyph glyph-stopwatch" aria-hidden="true"></span></button>
        <span class="plabel" onClick=${pickProp} title="Click to show in the graph editor (⇧ adds)">${r.label}${hasExpr ? html`<span class="eq">=</span>` : null}</span>
        <${Num} label="↔" value=${Math.round(value * 1000) / 1000} step=${r.step} min=${r.min} max=${r.max} unit=${r.unit} digits=${r.digits}
          onChange=${v => preview([write(v)])} onCommit=${v => commit([write(v)], `${prop} = ${v}`)} />
        <span class="kf">
          <button class="kf-nav" aria-label=${`Previous ${r.label} keyframe`} disabled=${!prev} onClick=${() => prev && player.seek(c.start + prev[0])}>‹</button>
          <button class=${`kf-dot ${here ? 'on' : keys.length ? 'some' : ''}`} aria-label=${here ? `Remove ${r.label} keyframe at playhead` : `Add ${r.label} keyframe at playhead`} title=${here ? 'Remove the key at the playhead' : 'Add a key at the playhead'} onClick=${toggleKey}>${here ? '◆' : '◇'}</button>
          <button class="kf-nav" aria-label=${`Next ${r.label} keyframe`} disabled=${!next} onClick=${() => next && player.seek(c.start + next[0])}>›</button>
        </span>
      </div>
      <div class="mt-r" onPointerDown=${marquee}>
        ${keys.map((k, i) => {
          const id = keyId(c.id, prop, k[0])
          const kind = keyShape(k, keys[i - 1])

          return html`<div class=${`kd ${kind} ${sel.includes(id) ? 'sel' : ''}`} data-key=${id} style=${{ left: `${X(c.start + k[0])}px` }} title=${`${r.label} ${round(k[0], 3)} s = ${round(k[1] * (r.scale ?? 1), 3)}${Array.isArray(k[2]) ? ` · bezier ${k[2].join(', ')}` : k[2] ? ` · ${k[2]}` : ''}`} onPointerDown=${e => keyDown(e, id)}></div>`
        })}
      </div>
    </div>
  `
}

/** The diamond's shape: hold, eased (either side has a non-linear handle) or linear. */
function keyShape(k, prev) {
  if (k[2] === 'hold') return 'hold'
  const out = bezierOf(k[2])
  const inn = prev ? bezierOf(prev[2]) : null
  const easedOut = out && (out[0] !== 0 || out[1] !== 0)
  const easedIn = inn && (inn[2] !== 1 || inn[3] !== 1)

  return easedOut || easedIn ? 'eased' : 'linear'
}
