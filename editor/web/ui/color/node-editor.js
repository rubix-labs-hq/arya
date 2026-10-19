// The Color page's node panel (Resolve's Node Editor): the graded clip's node graph as
// SVG. Drag nodes to move them, drag from an output (right) to an input (left) to link,
// drag a linked input away to unlink, right-click for the node menu.
// Keys while the panel has focus: ⌥S serial, ⌥P parallel, ⌥L layer, ⌘D bypass,
// ⌫ delete the selected node or link.

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { edit, store, toast, useStore } from '../store.js'
import { openMenu } from '../menu.js'
import { BUILTIN_PRESETS } from './presets.js'
import {
  ADDABLE, feedOf, graphOf, inputSlots, layoutGraph, layoutOps, liveNodes, MULTI_INPUT, NODE_H, NODE_W, nodeNumbers, nodeTitle,
  planBranch, planBypass, planDelete, planLink, planMove, planPreset, planRelink, planSerial, planUnlink, TYPE_LABEL,
} from './graph.js'
import { selectedNodeId, selectNode } from './state.js'

const html = htm.bind(h)

const nodeHeight = (g, n) => Math.max(NODE_H, inputSlots(g, n) * 16 + 10)
const inY = (g, n, i) => {
  const slots = inputSlots(g, n)

  return slots <= 1 ? nodeHeight(g, n) / 2 : ((i + 1) * nodeHeight(g, n)) / (slots + 1)
}

/** Short badges for what a node does: Q (qualifier), W (window), LUT, radius… */
function badges(n) {
  const out = []
  if (n.qualifier) out.push('Q')
  if (n.window) out.push('W')
  if (n.grade?.lut || n.type === 'lut') out.push('LUT')
  if (n.type === 'blur') out.push(`r${n.radius ?? 8}`)
  if (n.type === 'layerMixer') out.push((n.blends ?? []).slice(1).join(' ') || 'normal')
  if (n.enabled === false) out.push('off')

  return out.join(' · ')
}

export function nodeActions(clip, sel) {
  const run = (ops, summary, select) => {
    if (!ops?.length) return
    edit(ops, summary)
    if (select) selectNode(clip, select)
  }
  const fresh = () => store.project.tracks.flatMap(t => t.clips).find(c => c.id === clip.id) ?? clip

  return {
    serial: (type = 'corrector') => {
      const plan = planSerial(store.project, fresh(), sel, type)
      run(plan.ops, `added a ${TYPE_LABEL[type].toLowerCase()} node on ${clip.id}`, plan.select)
    },
    branch: mixer => {
      const plan = planBranch(store.project, fresh(), sel, mixer)
      run(plan.ops, `added a ${mixer === 'layerMixer' ? 'layer' : 'parallel'} node on ${clip.id}`, plan.select)
    },
    bypass: id => run(planBypass(fresh(), id ?? sel), `bypass node ${id ?? sel} on ${clip.id}`),
    remove: id => {
      const ops = planDelete(fresh(), id ?? sel)
      if (!ops) return toast('The input and output nodes stay')
      run(ops, `deleted node ${id ?? sel} on ${clip.id}`)
    },
    cleanUp: () => {
      const c = fresh()
      if (!c.nodes) return
      run(layoutOps(store.project, c.id), `tidied the nodes on ${c.id}`)
    },
    reset: () => run([{ op: 'nodes_reset', id: clip.id }], `reset the nodes on ${clip.id}`),
    preset: preset => {
      try {
        run(planPreset(fresh(), preset), `applied the ${preset.name} nodes to ${clip.id}`)
      } catch (error) {
        toast(error.message, 'error')
      }
    },
  }
}

/** The node menu (right-click a node or the background). */
export function nodeMenu(clip, n, act) {
  const fixed = !n || n.type === 'source' || n.type === 'output'
  const saved = Object.values(store.project.nodePresets ?? {})

  return [
    { label: 'Add Serial Node', hint: '⌥S', run: () => act.serial() },
    { label: 'Add Parallel Node', hint: '⌥P', run: () => act.branch('parallel') },
    { label: 'Add Layer Node', hint: '⌥L', run: () => act.branch('layerMixer') },
    { label: 'Add Node', sub: ADDABLE.filter(t => t !== 'corrector').map(t => ({ label: TYPE_LABEL[t], run: () => act.serial(t) })) },
    { sep: true },
    { label: n?.enabled === false ? 'Enable Node' : 'Bypass Node', hint: '⌘D', disabled: fixed, run: () => act.bypass(n.id) },
    { label: 'Delete Node', hint: '⌫', danger: true, disabled: fixed, run: () => act.remove(n.id) },
    { sep: true },
    { label: 'Apply Preset', sub: [...BUILTIN_PRESETS, ...saved].map(pr => ({ label: pr.name, run: () => act.preset(pr) })) },
    { label: 'Clean Up Node Graph', disabled: !clip.nodes, run: () => act.cleanUp() },
    { label: 'Reset All Nodes', danger: true, disabled: !clip.nodes, run: () => act.reset() },
  ]
}

export function NodeEditor({ clip }) {
  useStore()
  const g = graphOf(clip)
  const sel = selectedNodeId(clip)
  const wrap = useRef(null)
  const svg = useRef(null)
  const [size, setSize] = useState({ w: 400, h: 200 })
  const [view, setView] = useState({ z: 1, px: 0, py: 0 })
  const [drag, setDrag] = useState(null)
  const [linkSel, setLinkSel] = useState(null)
  const numbers = nodeNumbers(g)
  const live = liveNodes(g)
  const act = nodeActions(clip, sel)

  useEffect(() => {
    const ro = new ResizeObserver(() => wrap.current && setSize({ w: wrap.current.clientWidth, h: Math.max(80, wrap.current.clientHeight - 30) }))
    ro.observe(wrap.current)

    return () => ro.disconnect()
  }, [])
  useEffect(() => setLinkSel(null), [clip.id])

  // Positions: stored ones, the layout's for nodes that have none, the drag offset on top.
  const auto = g.list.some(n => n.x === undefined || n.y === undefined) ? layoutGraph(g) : null
  const pos = n => {
    const base = n.x === undefined || n.y === undefined ? auto.get(n.id) : { x: n.x, y: n.y }

    return drag?.kind === 'node' && drag.id === n.id ? { x: base.x + drag.dx, y: base.y + drag.dy } : base
  }
  const byId = new Map(g.list.map(n => [n.id, n]))

  // View box: fit the graph (never magnify past 1.1×), then the user's zoom and pan.
  const xs = g.list.map(n => pos(n).x)
  const ys = g.list.map(n => pos(n).y)
  const minX = Math.min(...xs) - 30
  const minY = Math.min(...ys) - 24
  const bw = Math.max(...xs) + NODE_W + 30 - minX
  const bh = Math.max(...g.list.map(n => pos(n).y + nodeHeight(g, n))) + 24 - minY
  const scale = Math.min(1.1, size.w / bw, size.h / bh) * view.z
  const vw = size.w / scale
  const vh = size.h / scale
  const vx = minX + bw / 2 - vw / 2 - view.px
  const vy = minY + bh / 2 - vh / 2 - view.py

  const toGraph = e => {
    const r = svg.current.getBoundingClientRect()

    return { x: vx + ((e.clientX - r.left) / r.width) * vw, y: vy + ((e.clientY - r.top) / r.height) * vh }
  }
  const focus = () => wrap.current?.focus({ preventScroll: true })

  const track = (onMove, onUp) => {
    const move = ev => onMove(ev)
    const up = ev => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      onUp(ev)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  const downNode = (e, n) => {
    if (e.button !== 0) return
    e.stopPropagation()
    focus()
    selectNode(clip, n.id)
    setLinkSel(null)
    const p0 = toGraph(e)
    let cur = { kind: 'node', id: n.id, dx: 0, dy: 0 }
    track(
      ev => {
        const p = toGraph(ev)
        cur = { ...cur, dx: Math.round(p.x - p0.x), dy: Math.round(p.y - p0.y) }
        setDrag(cur)
      },
      () => {
        setDrag(null)
        if (Math.abs(cur.dx) + Math.abs(cur.dy) < 3) return
        const b = pos(n)
        edit(planMove(clip, { [n.id]: { x: b.x + cur.dx, y: b.y + cur.dy } }), `moved node ${n.id} on ${clip.id}`)
      },
    )
  }

  // Link drags. From an output: link to the input dropped on. From a linked input: carry that
  // link's end (drop on another input to move it, on nothing to unlink). From a free input:
  // drop on an output to link backwards.
  const socketAt = ev => document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-sock]')?.dataset
  const downOut = (e, n) => {
    e.stopPropagation()
    e.preventDefault()
    focus()
    const p = toGraph(e)
    setDrag({ kind: 'link', from: n.id, x: p.x, y: p.y })
    track(
      ev => setDrag(d => d && { ...d, ...toGraph(ev) }),
      ev => {
        setDrag(null)
        const s = socketAt(ev)
        if (s?.sock === 'in' && s.node !== n.id) edit(planLink(clip, n.id, s.node, Number(s.input)), `linked ${n.id} → ${s.node}`)
      },
    )
  }
  const downIn = (e, n, input) => {
    e.stopPropagation()
    e.preventDefault()
    focus()
    const from = feedOf(g, n.id, input)
    const p = toGraph(e)
    if (from) {
      setDrag({ kind: 'link', from, x: p.x, y: p.y, hide: { to: n.id, input } })
      track(
        ev => setDrag(d => d && { ...d, ...toGraph(ev) }),
        ev => {
          setDrag(null)
          const s = socketAt(ev)
          if (s?.sock === 'in' && s.node === n.id && Number(s.input) === input) return
          if (s?.sock === 'in' && s.node !== from) edit(planRelink(clip, from, n.id, input, s.node, Number(s.input)), `moved the link from ${from}`)
          else if (!s) edit(planUnlink(clip, n.id, input), `unlinked ${n.id}`)
        },
      )
    } else {
      setDrag({ kind: 'rlink', to: n.id, input, x: p.x, y: p.y })
      track(
        ev => setDrag(d => d && { ...d, ...toGraph(ev) }),
        ev => {
          setDrag(null)
          const s = socketAt(ev)
          if (s?.sock === 'out' && s.node !== n.id) edit(planLink(clip, s.node, n.id, input), `linked ${s.node} → ${n.id}`)
        },
      )
    }
  }

  const downBg = e => {
    if (e.button !== 0) return
    focus()
    setLinkSel(null)
    const x0 = e.clientX
    const y0 = e.clientY
    const v0 = view
    track(
      ev => setView({ ...v0, px: v0.px + (ev.clientX - x0) / scale, py: v0.py + (ev.clientY - y0) / scale }),
      () => {},
    )
  }
  const wheel = e => {
    e.preventDefault()
    setView(v => ({ ...v, z: Math.max(0.3, Math.min(3, v.z * Math.exp(-e.deltaY * 0.002))) }))
  }
  useEffect(() => {
    const el = svg.current
    el.addEventListener('wheel', wheel, { passive: false })

    return () => el.removeEventListener('wheel', wheel)
  })

  const keyDown = e => {
    const alt = e.altKey && !e.metaKey && !e.ctrlKey
    const cmd = (e.metaKey || e.ctrlKey) && !e.altKey
    let run = null
    if (alt && e.code === 'KeyS') run = () => act.serial()
    else if (alt && e.code === 'KeyP') run = () => act.branch('parallel')
    else if (alt && e.code === 'KeyL') run = () => act.branch('layerMixer')
    else if (cmd && e.code === 'KeyD') run = () => act.bypass()
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !cmd) {
      run = () => {
        if (linkSel) {
          edit(planUnlink(clip, linkSel.to, linkSel.input), `unlinked ${linkSel.to}`)
          setLinkSel(null)
        } else act.remove()
      }
    } else if (e.key === 'Escape' && linkSel) run = () => setLinkSel(null)
    if (!run) return
    e.preventDefault()
    e.stopPropagation()
    run()
  }

  const menuAt = (e, n) => {
    e.preventDefault()
    e.stopPropagation()
    focus()
    if (n) selectNode(clip, n.id)
    openMenu(e.clientX, e.clientY, nodeMenu(clip, n ?? byId.get(sel), nodeActions(clip, n?.id ?? sel)))
  }

  const curve = (x1, y1, x2, y2) => {
    const dx = Math.max(30, Math.abs(x2 - x1) / 2)

    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
  }

  const links = g.links.filter(l => byId.has(l.from) && byId.has(l.to) && !(drag?.hide && drag.hide.to === l.to && drag.hide.input === (l.input ?? 0)))

  return html`
    <div class="node-panel" ref=${wrap} tabIndex="0" onKeyDown=${keyDown} data-clip=${clip.id}>
      <div class="node-bar">
        <b>Nodes</b><span class="muted">${clip.id}${clip.nodes ? '' : ' · default graph'}</span>
        <span class="grow"></span>
        <button class="ghost tiny" title="Add Serial Node (⌥S)" onClick=${() => act.serial()}>+ Serial</button>
        <button class="ghost tiny" title="Add Parallel Node (⌥P)" onClick=${() => act.branch('parallel')}>+ Parallel</button>
        <button class="ghost tiny" title="Add Layer Node (⌥L)" onClick=${() => act.branch('layerMixer')}>+ Layer</button>
        <button class="ghost tiny" title="Fit the graph" onClick=${() => setView({ z: 1, px: 0, py: 0 })}>Fit</button>
        <button class="ghost tiny" title="Node menu" onClick=${e => menuAt(e, byId.get(sel))}>⋯</button>
      </div>
      <svg ref=${svg} class="node-graph" width=${size.w} height=${size.h} viewBox=${`${vx} ${vy} ${vw} ${vh}`}
        onPointerDown=${downBg} onContextMenu=${e => menuAt(e, null)}>
        ${links.map(l => {
          const a = byId.get(l.from)
          const b = byId.get(l.to)
          const pa = pos(a)
          const pb = pos(b)
          const d = curve(pa.x + NODE_W, pa.y + NODE_H / 2, pb.x, pb.y + inY(g, b, l.input ?? 0))
          const on = linkSel && linkSel.to === l.to && linkSel.input === (l.input ?? 0)

          return html`<g class=${`nlink ${on ? 'sel' : ''} ${live.has(l.to) && live.has(l.from) ? '' : 'dead'}`} key=${`${l.from}>${l.to}:${l.input ?? 0}`}
              onPointerDown=${e => (e.stopPropagation(), focus(), setLinkSel({ to: l.to, input: l.input ?? 0 }))}
              onContextMenu=${e => {
                e.preventDefault()
                e.stopPropagation()
                openMenu(e.clientX, e.clientY, [{ label: 'Remove Link', danger: true, run: () => edit(planUnlink(clip, l.to, l.input ?? 0), `unlinked ${l.to}`) }])
              }}>
            <path class="nlink-hit" d=${d} />
            <path class="nlink-line" d=${d} />
          </g>`
        })}
        ${drag?.kind === 'link' && byId.has(drag.from) ? html`<path class="nlink-line temp" d=${curve(pos(byId.get(drag.from)).x + NODE_W, pos(byId.get(drag.from)).y + NODE_H / 2, drag.x, drag.y)} />` : null}
        ${drag?.kind === 'rlink' && byId.has(drag.to) ? html`<path class="nlink-line temp" d=${curve(drag.x, drag.y, pos(byId.get(drag.to)).x, pos(byId.get(drag.to)).y + inY(g, byId.get(drag.to), drag.input))} />` : null}
        ${g.list.map(n => {
          const p = pos(n)
          const hgt = nodeHeight(g, n)
          const io = n.type === 'source' || n.type === 'output'
          const cls = `nnode t-${n.type} ${n.id === sel ? 'sel' : ''} ${n.enabled === false ? 'off' : ''} ${live.has(n.id) ? '' : 'dead'} ${io ? 'io' : ''}`

          return html`<g class=${cls} key=${n.id} transform=${`translate(${p.x} ${p.y})`} data-node=${n.id}
              onPointerDown=${e => downNode(e, n)} onContextMenu=${e => menuAt(e, n)}>
            <rect class="nbox" width=${NODE_W} height=${hgt} rx=${io ? hgt / 2 : 7} />
            ${io
              ? html`<text class="ntitle" x=${NODE_W / 2} y=${hgt / 2 + 4} text-anchor="middle">${TYPE_LABEL[n.type]}</text>`
              : html`
                <text class="nnum" x="8" y="19">${numbers.get(n.id)}</text>
                <text class="ntitle" x="30" y="19">${nodeTitle(n).slice(0, 11)}</text>
                <text class="nsub" x="8" y=${hgt - 9}>${n.label ? TYPE_LABEL[n.type] : ''}${n.label && badges(n) ? ' · ' : ''}${badges(n)}</text>
                ${n.enabled === false ? html`<line class="noff" x1="4" y1=${hgt - 4} x2=${NODE_W - 4} y2="4" />` : null}`}
            ${Array.from({ length: inputSlots(g, n) }, (_, i) => html`
              <circle class=${`nsock in ${feedOf(g, n.id, i) ? 'linked' : ''}`} cx="0" cy=${inY(g, n, i)} r="6"
                data-sock="in" data-node=${n.id} data-input=${i} onPointerDown=${e => downIn(e, n, i)}>
                <title>${MULTI_INPUT.has(n.type) ? `input ${i + 1}` : 'input'}</title>
              </circle>`)}
            ${n.type === 'output' ? null : html`<rect class="nsock out" x=${NODE_W - 6} y=${NODE_H / 2 - 6} width="12" height="12" rx="2"
              data-sock="out" data-node=${n.id} onPointerDown=${e => downOut(e, n)}><title>output: drag to an input</title></rect>`}
          </g>`
        })}
      </svg>
    </div>
  `
}
