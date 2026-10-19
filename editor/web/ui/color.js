// Color page: node graph, wheels, sliders, curves, looks, LUTs, qualifier, power
// windows, presets, gallery stills and live scopes. The grade controls edit the selected
// node: the primary node edits the clip's grade, a corrector its own (color/state.js).

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { LOOKS, timecode } from '/core/project.js'
import { comp, player } from './engine-host.js'
import { Num } from './inspector.js'
import { Divider } from './layout.js'
import { addRef, api, edit, set, store, time, toast, useStore, useTime, viewProject } from './store.js'
import { Viewer } from './viewer.js'
import { Icon } from './icons.js'
import { graphOf, nodeNumbers, nodeTitle, TYPE_LABEL } from './color/graph.js'
import { NodeEditor } from './color/node-editor.js'
import { GalleryPanel, NodePanel, PresetsPanel, QualifierPanel, WindowPanel } from './color/panels.js'
import { LUTWorkflowPanel } from './color/workflow-panel.js'
import { gradedClip, gradeTarget, preview, selectedNode } from './color/state.js'

const html = htm.bind(h)

// ---------------------------------------------------------------- wheels

const SQ3 = Math.sqrt(3)
const toRgb = (x, y, a) => [x * a, (-x / 2 + (y * SQ3) / 2) * a, (-x / 2 - (y * SQ3) / 2) * a]

function split(rgb = [0, 0, 0], a) {
  const m = (rgb[0] + rgb[1] + rgb[2]) / 3
  const c = [rgb[0] - m, rgb[1] - m, rgb[2] - m]

  return { master: m, x: c[0] / a, y: (c[1] - c[2]) / (SQ3 * a) }
}

function Wheel({ label, field, target, range, masterRange }) {
  const value = target.grade[field] ?? [0, 0, 0]
  const { master, x, y } = split(Array.isArray(value) ? value : [value, value, value], range)
  const size = 128
  const r = size / 2 - 8
  const opsFor = (nx, ny, nm) => target.ops({ [field]: toRgb(nx, ny, range).map(v => Math.round((v + nm) * 10000) / 10000) })
  const drag = e => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const x0 = e.clientX
    const y0 = e.clientY
    const fine = 1 / r
    let nx = x
    let ny = y
    const move = ev => {
      const k = ev.shiftKey ? 0.2 : 1
      nx = x + (ev.clientX - x0) * fine * k
      ny = y - (ev.clientY - y0) * fine * k
      const len = Math.hypot(nx, ny)
      if (len > 1) {
        nx /= len
        ny /= len
      }
      preview(opsFor(nx, ny, master))
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      edit(opsFor(nx, ny, master), `${label} wheel on ${target.name}`)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return html`
    <div class="wheel">
      <div class="wheel-label" onClick=${e => e.altKey && addRef(target.ref(field))}>${label}</div>
      <div class="wheel-disc" data-field=${field} style=${{ width: `${size}px`, height: `${size}px` }} onPointerDown=${drag} onDblClick=${() => edit(target.ops({ [field]: null }), `reset ${label} on ${target.name}`)} title="Drag to tint (⇧ fine). Double-click to reset.">
        <div class="wheel-puck" style=${{ left: `${size / 2 + x * r}px`, top: `${size / 2 - y * r}px` }}></div>
        <div class="wheel-cross"></div>
      </div>
      <input class="wheel-master" type="range" aria-label=${`${label} master`} min=${-masterRange} max=${masterRange} step="0.001" value=${master}
        onInput=${e => preview(opsFor(x, y, Number(e.target.value)))}
        onChange=${e => edit(opsFor(x, y, Number(e.target.value)))} />
      <div class="wheel-vals">${(Array.isArray(value) ? value : [0, 0, 0]).map(v => (v >= 0 ? '+' : '') + v.toFixed(3)).join(' ')}</div>
    </div>
  `
}

// ---------------------------------------------------------------- curves

function CurvesEditor({ target }) {
  const [channel, setChannel] = useState('master')
  const cv = useRef(null)
  const [drag, setDrag] = useState(null)
  const curves = target.grade.curves ?? {}
  const pts = drag?.pts ?? curves[channel] ?? [[0, 0], [1, 1]]
  const S = 200
  const colors = { master: '#e8e8e8', r: '#ff5f57', g: '#3fb950', b: '#58a6ff' }

  useEffect(() => {
    const c = cv.current
    const dpr = devicePixelRatio
    c.width = S * dpr
    c.height = S * dpr
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0e0e12'
    ctx.fillRect(0, 0, S, S)
    ctx.strokeStyle = '#25252d'
    for (let i = 1; i < 4; i++) {
      ctx.beginPath()
      ctx.moveTo((i * S) / 4, 0)
      ctx.lineTo((i * S) / 4, S)
      ctx.moveTo(0, (i * S) / 4)
      ctx.lineTo(S, (i * S) / 4)
      ctx.stroke()
    }
    ctx.strokeStyle = '#3a3a44'
    ctx.beginPath()
    ctx.moveTo(0, S)
    ctx.lineTo(S, 0)
    ctx.stroke()
    // spline via the same math the shader table uses
    const sorted = [...pts].sort((a, b) => a[0] - b[0])
    ctx.strokeStyle = colors[channel]
    ctx.lineWidth = 2
    ctx.beginPath()
    const f = spline(sorted)
    for (let i = 0; i <= S; i++) {
      const yv = Math.max(0, Math.min(1, f(i / S)))
      if (i === 0) ctx.moveTo(i, S - yv * S)
      else ctx.lineTo(i, S - yv * S)
    }
    ctx.stroke()
    ctx.fillStyle = '#fff'
    for (const [px, py] of sorted) {
      ctx.beginPath()
      ctx.arc(px * S, S - py * S, 4, 0, Math.PI * 2)
      ctx.fill()
    }
  })

  const at = e => {
    const r = cv.current.getBoundingClientRect()

    return [Math.max(0, Math.min(1, (e.clientX - r.left) / S)), Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / S))]
  }
  const ops = list => target.ops({ curves: { ...curves, [channel]: list } })
  const down = e => {
    const [x, y] = at(e)
    let list = pts.map(q => [...q])
    let i = list.findIndex(q => Math.hypot(q[0] - x, q[1] - y) < 0.04)
    if (e.button === 2 || e.altKey) {
      e.preventDefault()
      if (i >= 0 && list.length > 2) {
        list.splice(i, 1)
        edit(ops(list))
      }

      return
    }
    if (i < 0) {
      list.push([x, y])
      list.sort((a, b) => a[0] - b[0])
      i = list.findIndex(q => q[0] === x && q[1] === y)
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ i, pts: list })
    preview(ops(list))
  }
  const move = e => {
    if (!drag) return
    const [x, y] = at(e)
    const list = drag.pts.map(q => [...q])
    list[drag.i] = [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]
    setDrag({ ...drag, pts: list })
    preview(ops([...list].sort((a, b) => a[0] - b[0])))
  }
  const up = () => {
    if (!drag) return
    edit(ops([...drag.pts].sort((a, b) => a[0] - b[0])), `curves ${channel} on ${target.name}`)
    setDrag(null)
  }

  return html`
    <div class="curves">
      <div class="seg">${['master', 'r', 'g', 'b'].map(k => html`<button class=${channel === k ? 'on' : ''} style=${{ color: colors[k] }} onClick=${() => setChannel(k)}>${k === 'master' ? 'Y' : k.toUpperCase()}</button>`)}
        <button class="ghost tiny" onClick=${() => edit(ops(null))}>Reset</button></div>
      <canvas ref=${cv} style=${{ width: `${S}px`, height: `${S}px` }} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onContextMenu=${e => e.preventDefault()} title="Click to add a point, drag to shape, right-click to remove"></canvas>
    </div>
  `
}

function spline(points) {
  const pts = [...points]
  if (pts[0][0] > 0) pts.unshift([0, pts[0][1]])
  if (pts[pts.length - 1][0] < 1) pts.push([1, pts[pts.length - 1][1]])
  const n = pts.length
  const xs = pts.map(q => q[0])
  const ys = pts.map(q => q[1])
  const d = []
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]))
  const m = [d[0] ?? 0]
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2)
  m.push(d[n - 2] ?? 0)

  return x => {
    if (x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let i = 0
    while (x > xs[i + 1]) i++
    const hh = xs[i + 1] - xs[i]
    const t = (x - xs[i]) / hh

    return (2 * t ** 3 - 3 * t ** 2 + 1) * ys[i] + (t ** 3 - 2 * t ** 2 + t) * hh * m[i] + (-2 * t ** 3 + 3 * t ** 2) * ys[i + 1] + (t ** 3 - t ** 2) * hh * m[i + 1]
  }
}

// ---------------------------------------------------------------- scopes

const scopeBuf = { data: null }

function computeScopes(cvs, kind) {
  const [w, hgt] = comp.size
  if (!w) return
  if (!scopeBuf.data || scopeBuf.data.length !== w * hgt * 4) scopeBuf.data = new Uint8Array(w * hgt * 4)
  const px = comp.readPixels(scopeBuf.data)
  const ctx = cvs.getContext('2d')
  const W = cvs.width
  const H = cvs.height
  const step = Math.max(1, Math.floor(Math.sqrt((w * hgt) / 90000)))
  const img = ctx.createImageData(W, H)
  const acc = new Float32Array(W * H * 3)
  const add = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = ((H - 1 - y) * W + x) * 3
    acc[i] += r
    acc[i + 1] += g
    acc[i + 2] += b
  }
  for (let yy = 0; yy < hgt; yy += step) {
    for (let xx = 0; xx < w; xx += step) {
      const o = (yy * w + xx) * 4
      const r = px[o]
      const g = px[o + 1]
      const b = px[o + 2]
      if (kind === 'waveform') {
        const yv = 0.2126 * r + 0.7152 * g + 0.0722 * b
        add(Math.floor((xx / w) * W), Math.floor((yv / 255) * (H - 1)), 0.6, 1, 0.7)
      } else if (kind === 'parade') {
        const third = W / 3
        const x0 = (xx / w) * third
        add(Math.floor(x0), Math.floor((r / 255) * (H - 1)), 1, 0.25, 0.25)
        add(Math.floor(x0 + third), Math.floor((g / 255) * (H - 1)), 0.25, 1, 0.25)
        add(Math.floor(x0 + third * 2), Math.floor((b / 255) * (H - 1)), 0.3, 0.45, 1)
      } else if (kind === 'vectorscope') {
        const yv = 0.2126 * r + 0.7152 * g + 0.0722 * b
        const cb = (b - yv) / 255 / 1.8556
        const cr = (r - yv) / 255 / 1.5748
        const S = Math.min(W, H) / 2 - 6
        add(Math.floor(W / 2 + cb * S * 2), Math.floor(H / 2 + cr * S * 2), r / 255 + 0.3, g / 255 + 0.3, b / 255 + 0.3)
      }
    }
  }
  if (kind === 'histogram') {
    const bins = [new Float32Array(256), new Float32Array(256), new Float32Array(256)]
    for (let yy = 0; yy < hgt; yy += step) {
      for (let xx = 0; xx < w; xx += step) {
        const o = (yy * w + xx) * 4
        bins[0][px[o]]++
        bins[1][px[o + 1]]++
        bins[2][px[o + 2]]++
      }
    }
    const max = Math.max(...bins.map(b => Math.max(...b.slice(2, 254))), 1)
    ctx.fillStyle = '#0b0b0e'
    ctx.fillRect(0, 0, W, H)
    ctx.globalCompositeOperation = 'lighter'
    const cols = ['#ff4040aa', '#40ff40aa', '#4070ffaa']
    bins.forEach((b, c) => {
      ctx.fillStyle = cols[c]
      for (let i = 0; i < 256; i++) {
        const v = Math.min(1, b[i] / max) * (H - 4)
        ctx.fillRect((i / 256) * W, H - v, W / 256 + 0.5, v)
      }
    })
    ctx.globalCompositeOperation = 'source-over'

    return
  }
  const gain = 18 / step
  for (let i = 0; i < W * H; i++) {
    img.data[i * 4] = Math.min(255, acc[i * 3] * gain)
    img.data[i * 4 + 1] = Math.min(255, acc[i * 3 + 1] * gain)
    img.data[i * 4 + 2] = Math.min(255, acc[i * 3 + 2] * gain)
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  ctx.strokeStyle = '#ffffff22'
  ctx.fillStyle = '#ffffff55'
  ctx.font = '10px ui-monospace, Menlo, monospace'
  if (kind === 'waveform' || kind === 'parade') {
    for (const v of [0, 25, 50, 75, 100]) {
      const yy = H - 1 - (v / 100) * (H - 1)
      ctx.beginPath()
      ctx.moveTo(0, yy)
      ctx.lineTo(W, yy)
      ctx.stroke()
      ctx.fillText(String(v), 3, Math.max(10, yy - 2))
    }
  } else {
    const S = Math.min(W, H) / 2 - 6
    ctx.beginPath()
    ctx.arc(W / 2, H / 2, S, 0, Math.PI * 2)
    ctx.stroke()
    // Skin tone line (~123°).
    ctx.strokeStyle = '#f5b94266'
    ctx.beginPath()
    ctx.moveTo(W / 2, H / 2)
    const a = (-123 * Math.PI) / 180
    ctx.lineTo(W / 2 + Math.cos(a) * S, H / 2 + Math.sin(a) * S)
    ctx.stroke()
    const targets = { R: [255, 0, 0], Y: [255, 255, 0], G: [0, 255, 0], C: [0, 255, 255], B: [0, 0, 255], M: [255, 0, 255] }
    for (const [name, [r, g, b]] of Object.entries(targets)) {
      const yv = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const cb = (b - yv) / 255 / 1.8556
      const cr = (r - yv) / 255 / 1.5748
      ctx.fillText(name, W / 2 + cb * S * 2 * 0.75 - 3, H - (H / 2 + cr * S * 2 * 0.75) + 3)
    }
  }
}

function Scopes() {
  const s = useStore()
  const cv = useRef(null)
  useEffect(() => {
    let id = 0
    let last = 0
    const loop = ts => {
      id = requestAnimationFrame(loop)
      if (ts - last < (store.playing ? 120 : 250)) return
      last = ts
      if (cv.current) computeScopes(cv.current, store.scopes.kind)
    }
    id = requestAnimationFrame(loop)

    return () => cancelAnimationFrame(id)
  }, [])

  return html`
    <div class="scopes">
      <div class="seg">${['waveform', 'parade', 'vectorscope', 'histogram'].map(k => html`<button class=${s.scopes.kind === k ? 'on' : ''} onClick=${() => set({ scopes: { kind: k } })}>${k}</button>`)}</div>
      <canvas ref=${cv} width="512" height="256" class="scope-canvas" onClick=${e => e.altKey && addRef({ kind: 'scope', id: `${s.scopes.kind}@${time.t.toFixed(2)}`, label: `${s.scopes.kind} at ${timecode(time.t, s.project.fps)}` })}></canvas>
    </div>
  `
}

// ---------------------------------------------------------------- page

function ClipStrip() {
  const s = useStore()
  useTime()
  const p = viewProject()
  const clips = p.tracks.filter(t => t.kind === 'video').flatMap(t => t.clips.filter(c => c.kind === 'video' || c.kind === 'image' || c.kind === 'adjustment')).sort((a, b) => a.start - b.start)
  const active = gradedClip()
  if (!clips.length) return null

  return html`
    <div class="clip-strip" role="group" aria-label="Clips to grade">
      ${clips.map((c, i) => {
        const name = c.label ?? (c.kind === 'adjustment' ? 'Adjustment' : String(c.src ?? c.id).split('/').pop())
        const nodes = c.nodes ? c.nodes.list.length - 2 : 0
        return html`
        <button type="button" class=${`strip-clip ${active?.id === c.id ? 'on' : ''}`} aria-pressed=${active?.id === c.id} title=${`${name} (${c.id})`}
          aria-label=${`Clip ${i + 1}, ${name}${c.grade ? ', graded' : ''}${nodes ? `, ${nodes} corrector nodes` : ''}`}
          onClick=${() => (set({ selection: [c.id] }), player.seek(c.start + Math.min(c.dur / 2, 1)))}>
          <${StripThumb} clip=${c} />
          <span class="strip-meta"><b>${String(i + 1).padStart(2, '0')}</b><span class="strip-name">${name}</span>${c.grade ? html`<span class="strip-flag" aria-hidden="true">◐</span>` : null}${nodes ? html`<span class="strip-flag" aria-hidden="true">⬡${nodes}</span>` : null}</span>
        </button>`
      })}
    </div>
  `
}

function StripThumb({ clip }) {
  const [meta, setMeta] = useState(null)
  useEffect(() => {
    if (clip.src) api(`/api/strip?quality=high&src=${encodeURIComponent(clip.src)}`).then(d => !d.error && setMeta(d)).catch(() => {})
  }, [clip.src])
  if (!meta) return html`<div class="strip-thumb"></div>`
  const idx = Math.min(meta.count - 1, Math.floor(((clip.in ?? 0) + clip.dur / 2) / (meta.interval || 1)))

  return html`<div class="strip-thumb"><svg width="100%" height="100%" viewBox=${`0 0 ${meta.w} ${meta.h}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true"><svg width=${meta.w} height=${meta.h} overflow="hidden"><image href=${meta.url} width=${meta.w * meta.count} height=${meta.h} x=${-idx * meta.w} /></svg></svg></div>`
}

function selectedOr(clip) {
  const ids = store.selection.filter(i => !i.startsWith('tr:'))

  return ids.length ? ids : [clip.id]
}

/** Replaces (not merges) the grade on clips, as one undo step. */
function replaceGrade(ids, grade, summary) {
  return edit([{ op: 'update', ids, comp: store.openComp ?? null, set: { grade: null } }, ...(grade ? [{ op: 'update', ids, comp: store.openComp ?? null, set: { grade } }] : [])], summary)
}

function GradeControls({ clip, target }) {
  const g = target.grade
  const primary = target.kind === 'primary'
  const [luts, setLuts] = useState([])
  useEffect(() => {
    api('/api/luts').then(r => setLuts(r.luts)).catch(() => {})
  }, [])
  const upd = (patch, summary) => edit(target.ops(patch), summary)
  const slider = (label, key, min, max, step, neutral) => html`
    <${Num} label=${label} value=${g[key] ?? neutral} step=${step} min=${min} max=${max} digits=${2}
      onChange=${v => preview(target.ops({ [key]: v }))}
      onCommit=${v => upd({ [key]: v === neutral ? null : v }, `${label} on ${target.name}`)}
      refId=${target.ref(key)} />
  `

  return html`
    <div class="grade-controls">
      <section class="grade-group grade-wheels" aria-label="Color wheels">
        <h4 class="grade-group-title">Color wheels</h4>
        <div class="wheels">
          <${Wheel} label="Lift" field="lift" target=${target} range=${0.25} masterRange=${0.3} />
          <${Wheel} label="Gamma" field="gamma" target=${target} range=${0.5} masterRange=${0.6} />
          <${Wheel} label="Gain" field="gain" target=${target} range=${0.5} masterRange=${0.8} />
          <${Wheel} label="Offset" field="offset" target=${target} range=${0.25} masterRange=${0.3} />
          <${Wheel} label="Shadows" field="shadowTint" target=${target} range=${0.15} masterRange=${0.1} />
          <${Wheel} label="Highlights" field="highlightTint" target=${target} range=${0.15} masterRange=${0.1} />
        </div>
      </section>
      <section class="grade-group grade-balance" aria-label="Balance and looks">
        <h4 class="grade-group-title">Balance</h4>
        <div class="grade-fields">
          ${slider('Exposure', 'exposure', -4, 4, 0.05, 0)}
          ${slider('Contrast', 'contrast', 0, 3, 0.01, 1)}
          ${slider('Pivot', 'pivot', 0, 1, 0.01, 0.435)}
          ${slider('Saturation', 'saturation', 0, 3, 0.01, 1)}
          ${slider('Hue', 'hue', -180, 180, 1, 0)}
          ${slider('Temperature', 'temperature', -1, 1, 0.01, 0)}
          ${slider('Tint', 'tint', -1, 1, 0.01, 0)}
        </div>
        <div class="grade-look">
          <h4 class="grade-group-title">Look and LUT</h4>
          <div class="look-grid">${LOOKS.map(l => html`<button class=${`ghost tiny ${(g.look ?? 'none') === l ? 'on' : ''}`} onClick=${() => upd({ look: l === 'none' ? null : l }, `look ${l} on ${target.name}`)}>${l}</button>`)}</div>
          <div class="field"><label>LUT</label><select value=${g.lut ?? ''} onChange=${e => upd({ lut: e.target.value || null }, `LUT on ${target.name}`)}><option value="">None</option>${luts.map(l => html`<option value=${l}>${l.split('/').pop()}</option>`)}</select></div>
          ${g.lut ? slider('LUT mix', 'lutMix', 0, 1, 0.01, 1) : html`<div class="hint">Import and inspect .cube files with LUT & reference.</div>`}
        </div>
      </section>
      <section class="grade-group grade-curve" aria-label="Curves and grade actions">
        <h4 class="grade-group-title">Curves</h4>
        <${CurvesEditor} target=${target} />
        <div class="grade-action-group">
          <h4 class="grade-group-title">Grade actions</h4>
          <div class="row gap wrap grade-actions">
            <button class="ghost tiny" onClick=${() => (set({ gradeClipboard: structuredClone(target.grade) }), toast('Grade copied'))}>Copy grade</button>
            <button class="ghost tiny" disabled=${!store.gradeClipboard} onClick=${() => (primary ? replaceGrade(selectedOr(clip), store.gradeClipboard, 'pasted grade') : edit(target.replace(store.gradeClipboard), `pasted grade on ${target.name}`))}>Paste grade</button>
            ${primary ? html`<button class="ghost tiny" onClick=${() => replaceGrade(viewProject().tracks.flatMap(t => t.clips.filter(c => c.kind === 'video' || c.kind === 'image').map(c => c.id)), clip.grade ?? null, 'applied grade to every clip')}>Apply to all</button>` : null}
            <button class="ghost tiny danger" onClick=${() => edit(target.replace(null), `reset the grade on ${target.name}`)}>Reset</button>
            <button class="ghost tiny grade-ref" title="Add this grade to the Assistant context" onClick=${() => addRef(primary ? { kind: 'clip', id: clip.id, label: `${clip.id} grade` } : target.ref('grade'))}><${Icon} name="attach" size=${14} />Reference to Assistant</button>
          </div>
        </div>
      </section>
    </div>
  `
}

const PALETTES = [
  ['primaries', 'Primaries'],
  ['qualifier', 'Qualifier'],
  ['window', 'Window'],
  ['node', 'Node'],
  ['presets', 'Presets'],
  ['gallery', 'Gallery'],
  ['look-tools', 'LUT & reference'],
]

function Palettes({ clip }) {
  const s = useStore()
  const node = selectedNode(clip)
  const target = gradeTarget(clip, node)
  const corrector = node?.type === 'corrector'
  const usable = { primaries: Boolean(target), qualifier: corrector, window: corrector, node: Boolean(node), presets: true, gallery: true, 'look-tools': true }
  // The wanted tab, or the nearest one this node has (a blur node has no wheels: show its parameters).
  const wanted = s.colorTab ?? 'primaries'
  const tab = usable[wanted] ? wanted : target ? 'primaries' : 'node'
  const num = node ? nodeNumbers(graphOf(clip)).get(node.id) : null

  return html`
    <div class="color-head">
      <b>${clip.id}</b>
      <span class="muted">${String(clip.src ?? clip.kind).split('/').pop()} · ${s.selection.length ? 'selected clip' : 'clip under the playhead'}</span>
      ${node ? html`<span class=${`node-chip ${node.enabled === false ? 'off' : ''}`} title="The grade controls edit this node">${num ? `${num} ` : ''}${nodeTitle(node)}${node.label ? ` (${TYPE_LABEL[node.type]})` : ''}${node.enabled === false ? ' · bypassed' : ''}</span>` : null}
      <span class="grow"></span>
      <div class="palette-tabs">${PALETTES.map(([k, l]) => html`<button class=${tab === k ? 'on' : ''} disabled=${!usable[k]} title=${usable[k] ? '' : 'Select a corrector node for this palette'} onClick=${() => set({ colorTab: k })}>${l}</button>`)}</div>
    </div>
    ${!corrector ? html`<p class="hint palette-hint" role="note">Select a corrector node to use Qualifier and Window.</p>` : null}
    ${clip.kind === 'adjustment' && clip.nodes ? html`<div class="warn">Adjustment clips render their primary grade only; their node graph does not render yet.</div>` : null}
    ${tab === 'primaries' && target ? html`<${GradeControls} clip=${clip} target=${target} key=${target.key} />` : null}
    ${tab === 'qualifier' && corrector ? html`<${QualifierPanel} clip=${clip} node=${node} />` : null}
    ${tab === 'window' && corrector ? html`<${WindowPanel} clip=${clip} node=${node} />` : null}
    ${tab === 'node' && node ? html`<${NodePanel} clip=${clip} node=${node} key=${`${clip.id}:${node.id}`} />` : null}
    ${tab === 'presets' ? html`<${PresetsPanel} clip=${clip} ids=${selectedOr(clip)} />` : null}
    ${tab === 'look-tools' ? html`<${LUTWorkflowPanel} clip=${clip} node=${node} key=${`${s.root}:${s.openComp ?? ''}:${clip.id}:${node?.id ?? ''}`} />` : null}
    ${tab === 'gallery' ? html`<${GalleryPanel} clip=${clip} />` : null}
  `
}

export function ColorPage() {
  useStore()
  useTime()
  const clip = gradedClip()

  return html`
    <div class="page color">
      <div class="color-top">
        <div class="color-monitor">
          <${Viewer} compact=${true} />
          <${ClipStrip} />
        </div>
        <div class="color-side">
          ${clip ? html`<${NodeEditor} clip=${clip} />` : html`<div class="node-panel"><div class="empty-hint">No clip to grade here.</div></div>`}
          <${Scopes} />
        </div>
      </div>
      <${Divider} field="upper" axis="vertical" label="Resize color viewer and controls" />
      <div class="color-bottom">
        ${clip ? html`<${Palettes} clip=${clip} />` : html`<div class="empty-hint">Park the playhead on a video clip, or pick one in the strip above.</div>`}
      </div>
    </div>
  `
}
