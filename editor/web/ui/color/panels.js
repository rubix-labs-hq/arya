// Palettes under the Color page's grade controls for the selected node: Qualifier,
// Window, Node (label, bypass, parameters of key/LUT/blur/mixer nodes), Presets, Gallery.

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { BLEND_MODES, timecode } from '/core/project.js'
import { canvas } from '../engine-host.js'
import { Num } from '../inspector.js'
import { api, edit, set, store, time, toast, useStore } from '../store.js'
import { BUILTIN_PRESETS } from './presets.js'
import { defaultWindow, FULL_QUALIFIER, fullWindow, graphOf, inputSlots, nodeTitle, planBypass, planPreset, planRename, presetFromClip, TYPE_LABEL } from './graph.js'
import { nodeOps, preview } from './state.js'

const html = htm.bind(h)

// ---------------------------------------------------------------- range bar

/**
 * A bar with a low and a high handle over [min, max]. With `wrap` (hue) the range may
 * run past max and come back from min (lo > hi). onChange previews, onCommit stores.
 */
function RangeBar({ label, value, min, max, wrap, gradient, digits = 2, onChange, onCommit }) {
  const bar = useRef(null)
  const [lo, hi] = value
  const frac = v => (v - min) / (max - min)
  const down = e => {
    e.preventDefault()
    const r = bar.current.getBoundingClientRect()
    const at = ev => min + Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * (max - min)
    const v0 = at(e)
    const which = Math.abs(v0 - lo) <= Math.abs(v0 - hi) ? 0 : 1
    let cur = [lo, hi]
    const round = v => Math.round(v * 10 ** digits) / 10 ** digits
    const apply = ev => {
      const v = round(at(ev))
      cur = which === 0 ? [v, cur[1]] : [cur[0], v]
      if (!wrap && cur[0] > cur[1]) cur = which === 0 ? [cur[1], cur[1]] : [cur[0], cur[0]]
      onChange(cur)
    }
    apply(e)
    const move = ev => apply(ev)
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      onCommit(cur)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }
  const a = frac(lo) * 100
  const b = frac(hi) * 100
  const spans = wrap && lo > hi ? [[a, 100], [0, b]] : [[Math.min(a, b), Math.max(a, b)]]

  return html`
    <div class="range-row">
      <label>${label}</label>
      <div class="range-bar" ref=${bar} style=${{ background: gradient }} onPointerDown=${down}>
        ${spans.map(([s, e]) => html`<div class="range-sel" style=${{ left: `${s}%`, width: `${e - s}%` }}></div>`)}
        <div class="range-h" style=${{ left: `${a}%` }}></div>
        <div class="range-h" style=${{ left: `${b}%` }}></div>
      </div>
      <span class="range-val">${lo.toFixed(digits === 0 ? 0 : 2)}–${hi.toFixed(digits === 0 ? 0 : 2)}</span>
    </div>
  `
}

// ---------------------------------------------------------------- qualifier

export function QualifierPanel({ clip, node }) {
  const s = useStore()
  const q = node.qualifier
  const upd = (patch, summary) => edit(nodeOps(clip, node, { qualifier: patch }), summary ?? `qualifier on ${clip.id} node ${node.id}`)
  const live = patch => preview(nodeOps(clip, node, { qualifier: patch }))
  const picker = mode => set({ eyedropper: s.eyedropper === mode ? null : mode })
  const pick = s.lastPick
  const pickTools = html`
    <div class="row gap wrap">
      <button class=${`tiny ${s.eyedropper === 'set' ? 'on' : ''}`} title="Click the viewer to qualify around a colour" onClick=${() => picker('set')}>⌖ Pick</button>
      <button class=${`tiny ${s.eyedropper === 'add' ? 'on' : ''}`} title="Click the viewer to widen the ranges to another colour (or ⇧-click with Pick)" onClick=${() => picker('add')} disabled=${!q}>⌖+ Add</button>
      ${pick ? html`<span class="pick-chip" title=${`hue ${pick.hsl[0].toFixed(0)}°, sat ${pick.hsl[1].toFixed(2)}, lum ${pick.hsl[2].toFixed(2)}`}><i style=${{ background: `rgb(${pick.rgb.map(v => Math.round(v * 255)).join(',')})` }}></i>H ${pick.hsl[0].toFixed(0)}° S ${pick.hsl[1].toFixed(2)} L ${pick.hsl[2].toFixed(2)}</span>` : null}
    </div>`
  if (!q) {
    return html`
      <div class="palette qualifier">
        <div class="hint">No qualifier: this node grades the whole frame (inside its window, if it has one).</div>
        <div class="row gap"><button class="tiny" onClick=${() => upd(structuredClone(FULL_QUALIFIER), `added a qualifier on ${clip.id} node ${node.id}`)}>Add qualifier</button></div>
        ${pickTools}
      </div>`
  }
  const full = { ...FULL_QUALIFIER, ...q }

  return html`
    <div class="palette qualifier">
      ${pickTools}
      <${RangeBar} label="Hue" value=${full.hue} min=${0} max=${360} wrap digits=${0}
        gradient="linear-gradient(90deg, #f33, #ff3 16.7%, #3f3 33.3%, #3ff 50%, #33f 66.7%, #f3f 83.3%, #f33)"
        onChange=${v => live({ hue: v })} onCommit=${v => upd({ hue: v })} />
      <${RangeBar} label="Sat" value=${full.sat} min=${0} max=${1}
        gradient="linear-gradient(90deg, #777, #e33)" onChange=${v => live({ sat: v })} onCommit=${v => upd({ sat: v })} />
      <${RangeBar} label="Lum" value=${full.lum} min=${0} max=${1}
        gradient="linear-gradient(90deg, #000, #fff)" onChange=${v => live({ lum: v })} onCommit=${v => upd({ lum: v })} />
      <div class="row gap wrap qual-opts">
        <${Num} label="Softness" value=${full.soft} step=${0.01} min=${0} max=${0.5} onChange=${v => live({ soft: v })} onCommit=${v => upd({ soft: v })} />
        <label class="check"><input type="checkbox" checked=${!!q.invert} onChange=${e => upd({ invert: e.target.checked || null })} /> Invert</label>
        <label class="check" title="Show the qualifier matte in the viewer"><input type="checkbox" checked=${!!q.show} onChange=${e => upd({ show: e.target.checked || null })} /> Highlight</label>
        <button class="ghost tiny" onClick=${() => upd({ hue: [0, 360] })}>All hues</button>
        <button class="ghost tiny danger" onClick=${() => edit(nodeOps(clip, node, { qualifier: null }), `removed the qualifier on ${clip.id} node ${node.id}`)}>Remove</button>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------- power window

export function WindowPanel({ clip, node }) {
  const win = node.window ? fullWindow(node.window) : null
  const upd = (patch, summary) => edit(nodeOps(clip, node, { window: patch }), summary ?? `window on ${clip.id} node ${node.id}`)
  const live = patch => preview(nodeOps(clip, node, { window: patch }))
  const setType = type => {
    if (!type) return upd(null, `removed the window on ${clip.id} node ${node.id}`)
    if (!win) return upd(defaultWindow(type), `added a ${type} window on ${clip.id} node ${node.id}`)
    // Switching to or from linear swaps in that shape's own size and softness.
    const keep = (type === 'linear') === (win.type === 'linear') ? {} : defaultWindow(type)
    upd({ ...win, ...keep, x: win.x, y: win.y, rotation: win.rotation, invert: win.invert, type })
  }
  const num = (label, key, step, min, max) => html`<${Num} label=${label} value=${win[key]} step=${step} min=${min} max=${max} onChange=${v => live({ [key]: v })} onCommit=${v => upd({ [key]: v })} />`

  return html`
    <div class="palette window">
      <div class="seg">
        ${[[null, 'Off'], ['circle', '◯ Circle'], ['rect', '▭ Rect'], ['linear', '⧄ Linear']].map(([t, l]) => html`<button class=${(win?.type ?? null) === t ? 'on' : ''} onClick=${() => setType(t)}>${l}</button>`)}
      </div>
      ${win ? html`
        <div class="grade-cols">
          <div class="grade-col">${num('Center X', 'x', 0.005, -1, 2)}${num('Center Y', 'y', 0.005, -1, 2)}${num('Rotation', 'rotation', 0.5, -180, 180)}</div>
          <div class="grade-col">${win.type === 'linear' ? null : num('Width', 'w', 0.005, 0.01, 4)}${num(win.type === 'linear' ? 'Band' : 'Height', 'h', 0.005, 0.01, 4)}${num('Softness', 'softness', 0.01, 0.001, win.type === 'linear' ? 4 : 1)}</div>
          <div class="grade-col">
            <label class="check"><input type="checkbox" checked=${!!win.invert} onChange=${e => upd({ invert: e.target.checked })} /> Invert (grade outside)</label>
            <button class="ghost tiny" onClick=${() => upd(defaultWindow(win.type))}>Reset window</button>
            <div class="hint">Drag the shape in the viewer: center to move, the square handles to size, the round one above to rotate, the hollow one to soften.${win.type === 'linear' ? ' A linear window grades the side the arrow points to.' : ''}</div>
          </div>
        </div>` : html`<div class="hint">No window: the node grades the whole frame (within its qualifier).</div>`}
    </div>
  `
}

// ---------------------------------------------------------------- node parameters

export function NodePanel({ clip, node }) {
  const [luts, setLuts] = useState([])
  useEffect(() => {
    if (node.type === 'lut') api('/api/luts').then(r => setLuts(r.luts ?? [])).catch(() => {})
  }, [node.type])
  const upd = (patch, summary) => edit(nodeOps(clip, node, patch), summary ?? `node ${node.id} on ${clip.id}`)
  const live = patch => preview(nodeOps(clip, node, patch))
  const num = (label, key, step, min, max, fallback) => html`<${Num} label=${label} value=${node[key] ?? fallback} step=${step} min=${min} max=${max} onChange=${v => live({ [key]: v })} onCommit=${v => upd({ [key]: v })} />`
  const g = graphOf(clip)
  const inputs = Math.max(0, inputSlots(g, node) - 1)
  const fixed = node.type === 'source' || node.type === 'output'
  let params = null
  if (node.type === 'key') {
    params = html`
      <div class="field"><label>Key colour</label><input type="color" value=${node.color ?? '#00ff00'} onChange=${e => upd({ color: e.target.value })} /></div>
      ${num('Similarity', 'similarity', 0.01, 0, 1, 0.4)}${num('Smoothness', 'smoothness', 0.01, 0, 1, 0.08)}${num('Spill', 'spill', 0.01, 0, 1, 0.5)}`
  } else if (node.type === 'lut') {
    params = html`
      <div class="field"><label>LUT</label><select value=${node.lut ?? ''} onChange=${e => upd({ lut: e.target.value || null })}><option value="">None</option>${luts.map(l => html`<option value=${l}>${l.split('/').pop()}</option>`)}</select></div>
      ${num('Mix', 'mix', 0.01, 0, 1, 1)}
      ${luts.length ? null : html`<div class="hint">Put .cube files in a luts/ folder of the project.</div>`}`
  } else if (node.type === 'blur') params = num('Radius', 'radius', 0.5, 0, 200, 8)
  else if (node.type === 'sharpen') params = num('Amount', 'amount', 0.01, 0, 3, 0.5)
  else if (node.type === 'glow') params = html`${num('Amount', 'amount', 0.01, 0, 3, 0.5)}${num('Threshold', 'threshold', 0.01, 0, 1, 0.7)}${num('Radius', 'radius', 0.5, 0, 200, 12)}`
  else if (node.type === 'parallel') {
    params = html`${Array.from({ length: inputs }, (_, i) => html`<${Num} label=${`Input ${i + 1} weight`} value=${node.weights?.[i] ?? 1} step=${0.05} min=${0} max=${10}
      onChange=${v => live({ weights: Array.from({ length: inputs }, (_, j) => (j === i ? v : node.weights?.[j] ?? 1)) })}
      onCommit=${v => upd({ weights: Array.from({ length: inputs }, (_, j) => (j === i ? v : node.weights?.[j] ?? 1)) })} />`)}
      <div class="hint">Parallel averages its inputs by these weights.</div>`
  } else if (node.type === 'layerMixer') {
    params = html`${Array.from({ length: inputs }, (_, i) => html`<div class="field"><label>${i === 0 ? 'Input 1 (bottom)' : `Input ${i + 1}`}</label>
      <select value=${node.blends?.[i] ?? 'normal'} onChange=${e => upd({ blends: Array.from({ length: inputs }, (_, j) => (j === i ? e.target.value : node.blends?.[j] ?? 'normal')) })}>
        ${BLEND_MODES.map(b => html`<option value=${b}>${b}</option>`)}</select></div>`)}
      <div class="hint">The layer mixer stacks input 1 at the bottom and each next input on top with its blend.</div>`
  } else if (node.type === 'primary') params = html`<div class="hint">The primary node applies the clip's own grade (clip.grade): the wheels edit it when this node is selected.</div>`
  else if (node.type === 'corrector') params = html`<div class="hint">A corrector grades with its own wheels, limited by its qualifier and window.</div>`
  else params = html`<div class="hint">${node.type === 'source' ? 'The clip\'s pixels, before any grade.' : 'The graph\'s result, before the clip\'s transform, masks and effects.'}</div>`

  return html`
    <div class="palette node-params">
      <div class="row gap wrap">
        <span class="node-kind">${TYPE_LABEL[node.type]} · ${node.id}</span>
        ${fixed ? null : html`
          <div class="field"><label>Label</label><input class="label-in" value=${node.label ?? ''} placeholder=${nodeTitle({ type: node.type })} onKeyDown=${e => (e.stopPropagation(), e.key === 'Enter' && e.target.blur())}
            onChange=${e => edit(planRename(clip, node.id, e.target.value), `renamed node ${node.id}`)} /></div>
          <label class="check"><input type="checkbox" checked=${node.enabled === false} onChange=${() => edit(planBypass(clip, node.id), `bypass node ${node.id}`)} /> Bypass (⌘D)</label>`}
      </div>
      <div class="node-param-fields">${params}</div>
    </div>
  `
}

// ---------------------------------------------------------------- presets

export function PresetsPanel({ clip, ids }) {
  const s = useStore()
  const [name, setName] = useState('')
  const saved = Object.values(s.project.nodePresets ?? {})
  const apply = preset => {
    try {
      const clips = s.project.tracks.flatMap(t => t.clips).filter(c => ids.includes(c.id))
      edit(clips.flatMap(c => planPreset(c, preset)), `applied the ${preset.name} nodes to ${ids.join(', ')}`)
    } catch (error) {
      toast(error.message, 'error')
    }
  }
  const save = () => {
    const n = name.trim()
    if (!n) return toast('Name the preset first')
    edit([{ op: 'project', set: { nodePresets: { [n]: presetFromClip(clip, n) } } }], `saved node preset ${n}`)
    setName('')
  }
  const row = (pr, mine) => html`
    <div class="preset-row">
      <span class="preset-name">${pr.name}</span>
      <span class="muted small">${pr.nodes.list.filter(n => n.type !== 'source' && n.type !== 'output').length} nodes${pr.grade ? ' + primary' : ''}</span>
      <span class="grow"></span>
      <button class="tiny" onClick=${() => apply(pr)}>Apply${ids.length > 1 ? ` to ${ids.length}` : ''}</button>
      ${mine ? html`<button class="ghost tiny danger" title="Delete this preset" onClick=${() => edit([{ op: 'project', set: { nodePresets: { [pr.name]: null } } }], `deleted node preset ${pr.name}`)}>✕</button>` : null}
    </div>`

  return html`
    <div class="palette presets">
      <div class="preset-cols">
        <div><h4>Built in</h4>${BUILTIN_PRESETS.map(pr => row(pr, false))}</div>
        <div>
          <h4>This project</h4>
          ${saved.length ? saved.map(pr => row(pr, true)) : html`<div class="hint">Save ${clip.id}'s node graph (and its primary grade) to reuse it on other clips.</div>`}
          <div class="row gap">
            <input placeholder="Preset name" value=${name} onInput=${e => setName(e.target.value)} onKeyDown=${e => (e.stopPropagation(), e.key === 'Enter' && save())} />
            <button class="tiny" onClick=${save}>Save ${clip.id}'s nodes</button>
          </div>
        </div>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------- gallery stills

/** Grabs the viewer's current graded frame as a still (kept for this session). */
export function grabStill(clip) {
  try {
    const url = canvas.toDataURL('image/jpeg', 0.9)
    const p = store.project
    const still = { id: `s${Date.now().toString(36)}`, url, at: time.t, clip: clip?.id ?? null, label: `${clip?.id ?? 'frame'} · ${timecode(time.t, p.fps)}` }
    set({ stills: [...(store.stills ?? []), still].slice(-24) })

    return still
  } catch (error) {
    toast(`Could not grab the frame: ${error.message}`, 'error')

    return null
  }
}

export function GalleryPanel({ clip }) {
  const s = useStore()
  const stills = s.stills ?? []

  return html`
    <div class="palette gallery">
      <div class="row gap wrap">
        <button class="tiny" onClick=${() => grabStill(clip)}>Grab still</button>
        ${s.wipe ? html`<button class="tiny on" onClick=${() => set({ wipe: null })}>Wipe off</button>` : null}
        <span class="hint">Click a still to compare: the viewer shows it left of a divider you can drag, the live frame right of it. Stills last for this session.</span>
      </div>
      <div class="stills">
        ${stills.map(st => html`
          <div class=${`still ${s.wipe?.id === st.id ? 'on' : ''}`} key=${st.id}>
            <img src=${st.url} onClick=${() => set({ wipe: s.wipe?.id === st.id ? null : { id: st.id, pos: s.wipe?.pos ?? 0.5 } })} title="Split-screen compare with the viewer" />
            <div class="still-meta"><span>${st.label}</span><button class="ghost tiny" title="Remove" onClick=${() => set({ stills: stills.filter(x => x.id !== st.id), wipe: s.wipe?.id === st.id ? null : s.wipe })}>✕</button></div>
          </div>`)}
      </div>
    </div>
  `
}
