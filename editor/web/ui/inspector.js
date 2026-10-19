// Inspector: every property of the selection, with scrub-to-change fields, keyframe
// toggles at the playhead, a curve editor, effects, titles, audio and transitions.

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { BLEND_MODES, clipEnd, EASES, EFFECTS, findClip, sortedKeys, timecode, TITLE_ANIMS, TRANSITIONS, valueAt, ease as easeFn } from '/core/project.js'
import { openMenu } from './menu.js'
import { player } from './engine-host.js'
import { addRef, edit, set, store, time, toast, useStore, useTime, viewProject } from './store.js'
import { registry } from './registry.js'
import { ScrollTabs } from './scroll-tabs.js'
import { ShapeAppearance } from './shape-appearance.js'
import { Icon } from './icons.js'

const html = htm.bind(h)

const FONTS = ['Avenir Next', 'Helvetica Neue', 'SF Pro Display', 'Futura', 'Gill Sans', 'Optima', 'Didot', 'Georgia', 'Baskerville', 'Times New Roman', 'Menlo', 'Courier New', 'Impact', 'Arial Black', 'Copperplate', 'Marker Felt', 'Chalkboard', 'American Typewriter', 'Rockwell', 'Bodoni 72']

/** A number you can type or drag horizontally on the label to scrub. */
export function Num({ label, value, step = 1, min, max, unit = '', digits = 2, onChange, onCommit, keyframe, refId }) {
  const [text, setText] = useState(null)
  const clamp = v => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
  const startScrub = e => {
    if (e.altKey && refId) return addRef(refId)
    e.preventDefault()
    const x0 = e.clientX
    const v0 = Number(value) || 0
    let last = v0
    const move = ev => {
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1
      last = clamp(Math.round((v0 + ((ev.clientX - x0) / 2) * step * mult) / step) * step)
      onChange?.(last)
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      if (last !== v0) (onCommit ?? onChange)?.(last)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }
  const shown = typeof value === 'number' ? (Number.isInteger(step) && Number.isInteger(value) ? String(value) : value.toFixed(digits)) : value ?? ''

  return html`
    <div class="field num">
      <label onPointerDown=${startScrub} title=${`Drag to scrub (⇧ ×10, ⌥ fine).${refId ? ' ⌥-click: attach a reference to your assistant' : ''}`}>${label}</label>
      <input aria-label=${label} value=${text ?? shown} onFocus=${e => (setText(shown), e.target.select())} onInput=${e => setText(e.target.value)}
        onKeyDown=${e => {
          e.stopPropagation()
          if (e.key === 'Enter') e.target.blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const v = clamp((Number(value) || 0) + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1))
            ;(onCommit ?? onChange)?.(v)
          }
        }}
        onBlur=${() => {
          if (text !== null && text !== shown) {
            const v = Number(text)
            if (Number.isFinite(v)) (onCommit ?? onChange)?.(clamp(v))
          }
          setText(null)
        }} />
      ${unit ? html`<span class="unit">${unit}</span>` : null}
      ${keyframe ?? null}
    </div>
  `
}

function KeyButton({ clip, prop, label }) {
  // Name the property the way its row does: "Stretch X", not the stored key "scaleX".
  const name = label ?? prop
  const t = useTime()
  const local = Math.round((t - clip.start) * 1000) / 1000
  const keys = sortedKeys(clip.anim?.[prop])
  const here = keys.find(k => Math.abs(k[0] - local) < 1 / 120)
  const inside = t >= clip.start - 1e-6 && t <= clipEnd(clip) + 1e-6
  const prev = [...keys].reverse().find(k => k[0] < local - 1e-3)
  const next = keys.find(k => k[0] > local + 1e-3)
  const p = viewProject()

  return html`
    <span class="kf">
      <button class="kf-nav" aria-label=${`Previous ${name} keyframe`} title="Previous keyframe" disabled=${!prev} onClick=${() => prev && player.seek(clip.start + prev[0])}>‹</button>
      <button class=${`kf-dot ${here ? 'on' : keys.length ? 'some' : ''}`} disabled=${!inside} title=${here ? 'Remove keyframe' : 'Add keyframe at playhead'}
        aria-label=${here ? `Remove ${name} keyframe at playhead` : `Add ${name} keyframe at playhead`}
        onClick=${() => edit({ op: 'keyframe', id: clip.id, prop, at: t, value: valueAt(p, clip, prop, local), remove: Boolean(here) })}>${here ? '◆' : '◇'}</button>
      <button class="kf-nav" aria-label=${`Next ${name} keyframe`} title="Next keyframe" disabled=${!next} onClick=${() => next && player.seek(clip.start + next[0])}>›</button>
    </span>
  `
}

function Section({ title, children, open = true, extra }) {
  const [isOpen, setOpen] = useState(open)

  return html`
    <div class="section">
      <div class="section-head" onClick=${() => setOpen(!isOpen)}><button type="button" class="section-toggle" aria-expanded=${isOpen} onClick=${e => { e.stopPropagation(); setOpen(!isOpen) }}><span class="chev" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>${title}</button><span class="grow"></span>${extra ?? null}</div>
      ${isOpen ? html`<div class="section-body">${children}</div>` : null}
    </div>
  `
}

/** Selected clips that a property edit on `clip` should reach. A linked selection holds the
 *  clip's audio as well, and a transform or audio setting belongs only to its own kind. */
function editTargets(clip) {
  const p = viewProject(), audio = clip.kind === 'audio'
  // A field can commit on blur after the selection moved on; the edit still belongs to its clip.
  const selection = store.selection.includes(clip.id) ? store.selection : [clip.id]
  return selection.filter(id => !id.startsWith('tr:') && (findClip(p, id)?.clip.kind === 'audio') === audio)
}

/** A property row bound to a clip, keyframe-aware. */
function Prop({ clip, prop, label, step, min, max, unit, digits, scale = 1 }) {
  const t = useTime()
  const p = viewProject()
  const local = Math.max(0, Math.min(clip.dur, t - clip.start))
  const [live, setLive] = useState(null)
  const value = live ?? valueAt(p, clip, prop, local) * scale
  const commit = v => {
    setLive(null)
    const raw = v / scale
    if (clip.anim?.[prop]?.length) edit({ op: 'keyframe', id: clip.id, prop, at: Math.min(clipEnd(clip), Math.max(clip.start, t)), value: raw })
    else edit({ op: 'update', ids: editTargets(clip), set: { [prop]: raw } })
  }

  return html`<${Num} label=${label} value=${value} step=${step} min=${min} max=${max} unit=${unit} digits=${digits}
    onChange=${v => setLive(v)} onCommit=${commit}
    refId=${{ kind: 'property', id: `${clip.id}.${prop}`, label: `${clip.id} ${label}` }}
    keyframe=${html`<${KeyButton} clip=${clip} prop=${prop} label=${label} />`} />`
}

function Field({ clip, path, label, step = 0.01, min, max, unit, digits = 2, fallback = 0 }) {
  const parts = path.split('.')
  const get = obj => parts.reduce((o, k) => (o == null ? undefined : o[k]), obj)
  const value = get(clip) ?? fallback
  const build = v => parts.reduceRight((acc, k) => ({ [k]: acc }), v)

  return html`<${Num} label=${label} value=${value} step=${step} min=${min} max=${max} unit=${unit} digits=${digits}
    refId=${{ kind: 'property', id: `${clip.id}.${path}`, label: `${clip.id} ${label}` }}
    onCommit=${v => edit({ op: 'update', ids: editTargets(clip), set: build(v) })} />`
}

// ---------------------------------------------------------------- curve editor

function CurveEditor({ clip }) {
  const props = Object.keys(clip.anim ?? {})
  const [prop, setProp] = useState(props[0])
  const cv = useRef(null)
  const [drag, setDrag] = useState(null)
  const [selKey, setSelKey] = useState(null)
  const t = useTime()
  const p = viewProject()
  const active = props.includes(prop) ? prop : props[0]
  const keys = sortedKeys((drag?.keys) ?? clip.anim?.[active])
  const W = 300
  const H = 140
  const vals = keys.map(k => k[1])
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  if (hi - lo < 1e-6) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * 0.15
  lo -= pad
  hi += pad
  const X = tt => 8 + (tt / clip.dur) * (W - 16)
  const Y = v => H - 10 - ((v - lo) / (hi - lo)) * (H - 20)

  useEffect(() => {
    const c = cv.current
    if (!c) return
    const dpr = devicePixelRatio
    c.width = W * dpr
    c.height = H * dpr
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#101014'
    ctx.fillRect(0, 0, W, H)
    ctx.strokeStyle = '#26262e'
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath()
      ctx.moveTo(0, 10 + (i * (H - 20)) / 4)
      ctx.lineTo(W, 10 + (i * (H - 20)) / 4)
      ctx.stroke()
    }
    if (!keys.length) return
    const tmp = { ...clip, anim: { ...clip.anim, [active]: keys } }
    ctx.strokeStyle = '#f5b942'
    ctx.lineWidth = 2
    ctx.beginPath()
    for (let i = 0; i <= 200; i++) {
      const tt = (i / 200) * clip.dur
      const v = valueAt(p, tmp, active, tt)
      if (i === 0) ctx.moveTo(X(tt), Y(v))
      else ctx.lineTo(X(tt), Y(v))
    }
    ctx.stroke()
    keys.forEach((k, i) => {
      ctx.save()
      ctx.translate(X(k[0]), Y(k[1]))
      ctx.rotate(Math.PI / 4)
      ctx.fillStyle = i === selKey ? '#fff' : '#ffd84d'
      ctx.fillRect(-4.5, -4.5, 9, 9)
      ctx.restore()
    })
    const px = X(t - clip.start)
    ctx.strokeStyle = '#ff3b4a'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, H)
    ctx.stroke()
  })

  if (!props.length) return html`<div class="hint">No keyframes yet. Click ◆ beside a property to animate it.</div>`
  const at = e => {
    const r = cv.current.getBoundingClientRect()

    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const down = e => {
    const { x, y } = at(e)
    const i = keys.findIndex(k => Math.abs(X(k[0]) - x) < 7 && Math.abs(Y(k[1]) - y) < 7)
    if (i < 0) return
    setSelKey(i)
    if (e.button === 2) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ i, keys })
  }
  const move = e => {
    if (!drag) return
    const { x, y } = at(e)
    const k2 = drag.keys.map(k => [...k])
    const tt = Math.max(0, Math.min(clip.dur, ((x - 8) / (W - 16)) * clip.dur))
    k2[drag.i][0] = Math.round(tt * p.fps) / p.fps
    k2[drag.i][1] = Math.round((lo + ((H - 10 - y) / (H - 20)) * (hi - lo)) * 1000) / 1000
    setDrag({ ...drag, keys: k2 })
  }
  const up = () => {
    if (!drag) return
    const k = drag.keys[drag.i]
    edit({ op: 'keyframe_ease', id: clip.id, prop: active, index: drag.i, t: k[0], value: k[1] })
    setDrag(null)
  }
  const menu = e => {
    e.preventDefault()
    const { x, y } = at(e)
    const i = keys.findIndex(k => Math.abs(X(k[0]) - x) < 8 && Math.abs(Y(k[1]) - y) < 8)
    if (i < 0) return
    openMenu(e.clientX, e.clientY, [
      ...Object.keys(EASES).map(name => ({ label: `Ease: ${name}`, run: () => edit({ op: 'keyframe_ease', id: clip.id, prop: active, index: i, ease: name }) })),
      { label: 'Ease: hold', run: () => edit({ op: 'keyframe_ease', id: clip.id, prop: active, index: i, ease: 'hold' }) },
      { sep: true },
      { label: 'Delete keyframe', danger: true, run: () => edit({ op: 'keyframe', id: clip.id, prop: active, at: keys[i][0], local: true, remove: true }) },
    ])
  }

  return html`
    <div class="curve">
      <div class="row gap">
        <select value=${active} onChange=${e => setProp(e.target.value)}>${props.map(pp => html`<option value=${pp}>${pp}</option>`)}</select>
        ${selKey !== null && keys[selKey] ? html`<span class="muted">key ${selKey + 1}: ${keys[selKey][0].toFixed(2)}s = ${keys[selKey][1]} · ${Array.isArray(keys[selKey][2]) ? 'custom' : keys[selKey][2] ?? 'linear'}</span>` : html`<span class="muted">drag keys · right-click for easing</span>`}
      </div>
      <canvas ref=${cv} style=${{ width: `${W}px`, height: `${H}px` }} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onContextMenu=${menu}></canvas>
      <div class="ease-row">${['linear', 'in', 'out', 'inOut', 'smooth', 'backOut', 'expoOut'].map(name => html`
        <button class="ease-btn" title=${`Apply ${name} to every key`} onClick=${() => edit(keys.map((_, i) => ({ op: 'keyframe_ease', id: clip.id, prop: active, index: i, ease: name })))}>
          <svg viewBox="0 0 24 24" width="22" height="22"><path d=${Array.from({ length: 21 }, (_, i) => `${i ? 'L' : 'M'}${2 + i}, ${22 - easeFn(name, i / 20) * 20}`).join(' ')} fill="none" stroke="currentColor" stroke-width="1.6" /></svg>
        </button>`)}</div>
    </div>
  `
}

// ---------------------------------------------------------------- tabs

/** Spatial conform, as in Final Cut: Fit shows the whole source, Fill covers the frame. */
function Conform({ clip, ids, p }) {
  const sw = p.width / (p.assets[clip.src]?.width ?? p.width), sh = p.height / (p.assets[clip.src]?.height ?? p.height)
  const fill = Math.max(sw / Math.min(sw, sh), sh / Math.min(sw, sh))
  const scale = clip.scale ?? 1, still = !clip.anim?.scale
  const isFit = still && scale === 1 && clip.x == null && clip.y == null
  const isFill = still && !isFit && Math.abs(scale - fill) < 1e-3

  return html`
    <div class="field conform">
      <label id=${`conform-${clip.id}`}>Conform</label>
      <div class="seg" role="group" aria-labelledby=${`conform-${clip.id}`}>
        <button type="button" class=${isFit ? 'on' : ''} aria-pressed=${isFit} title="Show the whole source: 100% scale, centered" onClick=${() => edit({ op: 'update', ids, set: { scale: 1, x: null, y: null } })}>Fit</button>
        <button type="button" class=${isFill ? 'on' : ''} aria-pressed=${isFill} title="Scale up until the source covers the frame, cropping the edges" onClick=${() => edit({ op: 'update', ids, set: { scale: fill } })}>Fill</button>
      </div>
    </div>
  `
}

function VideoTab({ clip }) {
  const p = viewProject()
  const isVisual = clip.kind !== 'audio'
  if (!isVisual) return null
  const ids = editTargets(clip)

  return html`
    ${clip.kind !== 'adjustment' ? html`<${Section} title="Transform" extra=${html`<button class="ghost tiny" onClick=${e => (e.stopPropagation(), edit({ op: 'update', ids, set: { x: null, y: null, scale: null, scaleX: null, scaleY: null, rotation: null, anim: null } }))}>Reset</button>`}>
      <${Prop} clip=${clip} prop="x" label="Position X" step=${1} digits=${0} />
      <${Prop} clip=${clip} prop="y" label="Position Y" step=${1} digits=${0} />
      <${Prop} clip=${clip} prop="scale" label="Scale" step=${1} unit="%" digits=${1} scale=${100} />
      <${Prop} clip=${clip} prop="scaleX" label="Stretch X" step=${1} unit="%" digits=${1} scale=${100} />
      <${Prop} clip=${clip} prop="scaleY" label="Stretch Y" step=${1} unit="%" digits=${1} scale=${100} />
      <${Prop} clip=${clip} prop="rotation" label="Rotation" step=${0.5} unit="°" digits=${1} />
      <${Conform} clip=${clip} ids=${ids} p=${p} />
    </${Section}>
    <${Section} title="Animation presets" open=${false}>
      <p class="hint section-hint">Each preset writes keyframes across this clip. Edit them under Animation curves, or undo.</p>
      <div class="row gap wrap preset-row">
        <button class="ghost tiny" title="Ken Burns: slow push in over the whole clip" onClick=${() => edit([{ op: 'keyframe', id: clip.id, prop: 'scale', at: 0, local: true, value: 1, ease: 'inOut' }, { op: 'keyframe', id: clip.id, prop: 'scale', at: clip.dur, local: true, value: 1.15 }])}>Ken Burns</button>
        <button class="ghost tiny" title="Slide in from the left" onClick=${() => edit([{ op: 'keyframe', id: clip.id, prop: 'x', at: 0, local: true, value: -p.width / 2, ease: 'expoOut' }, { op: 'keyframe', id: clip.id, prop: 'x', at: Math.min(0.8, clip.dur / 2), local: true, value: clip.x ?? p.width / 2 }])}>Slide in</button>
        <button class="ghost tiny" title="Camera shake" onClick=${() => edit(Array.from({ length: Math.min(40, Math.floor(clip.dur * 12)) }, (_, i) => ({ op: 'keyframe', id: clip.id, prop: 'x', at: i / 12, local: true, value: (clip.x ?? p.width / 2) + (Math.random() - 0.5) * 24, ease: 'smooth' })))}>Shake</button>
      </div>
    </${Section}>
    <${Section} title="Crop" open=${Boolean(clip.crop)}>
      ${['l', 'r', 't', 'b'].map(k => html`<${Field} clip=${clip} path=${`crop.${k}`} label=${{ l: 'Left', r: 'Right', t: 'Top', b: 'Bottom' }[k]} step=${0.005} min=${0} max=${0.95} digits=${3} />`)}
    </${Section}>` : null}
    <${Section} title="Compositing">
      <${Prop} clip=${clip} prop="opacity" label="Opacity" step=${1} min=${0} max=${100} unit="%" digits=${0} scale=${100} />
      <div class="field"><label>Blend</label><select value=${clip.blend ?? 'normal'} onChange=${e => edit({ op: 'update', ids, set: { blend: e.target.value === 'normal' ? null : e.target.value } })}>${BLEND_MODES.map(m => html`<option value=${m}>${m}</option>`)}</select></div>
      <${Field} clip=${clip} path="fadeIn" label="Fade in" step=${1 / p.fps} min=${0} unit="s" />
      <${Field} clip=${clip} path="fadeOut" label="Fade out" step=${1 / p.fps} min=${0} unit="s" />
    </${Section}>
    ${clip.kind === 'video' ? html`<${Section} title="Speed" open=${Boolean(clip.speed && clip.speed !== 1) || Boolean(clip.reverse)}>
      <div class="row gap wrap">${[0.25, 0.5, 1, 2, 4].map(sp => html`<button class=${`ghost tiny ${(clip.speed ?? 1) === sp ? 'on' : ''}`} onClick=${() => edit({ op: 'speed', id: clip.id, speed: sp })}>${sp * 100}%</button>`)}
        <button class=${`ghost tiny ${clip.reverse ? 'on' : ''}`} onClick=${() => edit({ op: 'speed', id: clip.id, speed: clip.speed ?? 1, reverse: !clip.reverse })}>Reverse</button></div>
      <${Num} label="Speed" value=${(clip.speed ?? 1) * 100} step=${5} min=${5} max=${2000} unit="%" digits=${0} onCommit=${v => edit({ op: 'speed', id: clip.id, speed: v / 100 })} />
    </${Section}>` : null}
    ${clip.key || clip.kind === 'video' || clip.kind === 'image' ? html`<${Section} title="Chroma key" open=${Boolean(clip.key)} extra=${html`<input type="checkbox" aria-label="Chroma key" checked=${Boolean(clip.key)} onClick=${e => e.stopPropagation()} onChange=${e => edit({ op: 'update', ids, set: { key: e.target.checked ? { color: '#00ff00', similarity: 0.3, smoothness: 0.1, spill: 0.5 } : null } })} />`}>
      ${clip.key ? html`
        <div class="field"><label>Key color</label><input type="color" value=${clip.key.color ?? '#00ff00'} onChange=${e => edit({ op: 'update', ids, set: { key: { color: e.target.value } } })} /></div>
        <${Field} clip=${clip} path="key.similarity" label="Similarity" step=${0.01} min=${0} max=${1} />
        <${Field} clip=${clip} path="key.smoothness" label="Softness" step=${0.01} min=${0} max=${1} />
        <${Field} clip=${clip} path="key.spill" label="Spill" step=${0.01} min=${0} max=${1} />` : null}
    </${Section}>` : null}
    <${Section} title="Animation curves" open=${Boolean(clip.anim)}><${CurveEditor} clip=${clip} /></${Section}>
  `
}

function EffectsTab({ clip }) {
  const fx = clip.effects ?? []

  return html`
    <div class="row gap"><select onChange=${e => e.target.value && (edit({ op: 'effect', id: clip.id, type: e.target.value }), (e.target.value = ''))}><option value="">+ Add effect…</option>${Object.keys(EFFECTS).map(k => html`<option value=${k}>${k}</option>`)}</select></div>
    <${Prop} clip=${clip} prop="blur" label="Blur (animatable)" step=${0.5} min=${0} digits=${1} />
    ${fx.map((e, i) => html`
      <${Section} title=${e.type} extra=${html`<span class="row gap"><input type="checkbox" aria-label=${`Enable ${e.type}`} checked=${e.enabled !== false} onClick=${ev => ev.stopPropagation()} onChange=${ev => edit({ op: 'effect', id: clip.id, index: i, enabled: ev.target.checked })} /><button class="ghost tiny" onClick=${ev => (ev.stopPropagation(), edit({ op: 'effect', id: clip.id, remove: i }))}>✕</button></span>`}>
        ${Object.entries(e.params ?? {}).map(([k, v]) =>
          typeof v === 'number'
            ? html`<${Num} label=${k} value=${v} step=${v >= 4 ? 1 : 0.01} min=${0} onCommit=${nv => edit({ op: 'effect', id: clip.id, index: i, params: { [k]: nv } })} />`
            : html`<div class="field"><label>${k}</label><select value=${v} onChange=${ev => edit({ op: 'effect', id: clip.id, index: i, params: { [k]: ev.target.value } })}><option>x</option><option>y</option></select></div>`,
        )}
      </${Section}>`)}
  `
}

function TitleTab({ clip }) {
  const t = clip.title ?? {}
  const font = t.font ?? 'Avenir Next'
  const fonts = FONTS.includes(font) ? FONTS : [font, ...FONTS]
  const upd = patch => edit({ op: 'update', id: clip.id, set: { title: patch } })
  const [text, setText] = useState(null)

  return html`
    <${Section} title="Text">
      <textarea aria-label="Title text" class="title-text" rows="3" value=${text ?? t.text ?? ''} onInput=${e => setText(e.target.value)} onKeyDown=${e => e.stopPropagation()} onBlur=${() => text !== null && (upd({ text }), setText(null))}></textarea>
      <div class="field"><label>Font</label><select value=${font} onChange=${e => upd({ font: e.target.value })}>${fonts.map(f => html`<option value=${f} style=${{ fontFamily: f }}>${f}</option>`)}</select></div>
      <${Field} clip=${clip} path="title.size" label="Size" step=${1} min=${4} digits=${0} fallback=${96} />
      <div class="field"><label>Weight</label><select value=${t.weight ?? 600} onChange=${e => upd({ weight: Number(e.target.value) })}>${[300, 400, 500, 600, 700, 800, 900].map(wt => html`<option value=${wt}>${wt}</option>`)}</select></div>
      <div class="field"><label>Align</label><div class="seg">${['left', 'center', 'right'].map(a => html`<button class=${(t.align ?? 'center') === a ? 'on' : ''} onClick=${() => upd({ align: a })}>${a}</button>`)}</div></div>
      <${Field} clip=${clip} path="title.tracking" label="Tracking" step=${0.5} digits=${1} />
      <${Field} clip=${clip} path="title.lineHeight" label="Line height" step=${0.05} min=${0.5} fallback=${1.15} />
      <div class="field"><label>Italic</label><input type="checkbox" checked=${Boolean(t.italic)} onChange=${e => upd({ italic: e.target.checked || null })} /></div>
    </${Section}>
    <${Section} title="Style">
      <div class="field"><label>Color</label><input type="color" value=${(t.color ?? '#ffffff').slice(0, 7)} onChange=${e => upd({ color: e.target.value, gradient: null })} /></div>
      <div class="field"><label>Gradient</label><input type="checkbox" aria-label="Gradient" checked=${Boolean(t.gradient)} onChange=${e => upd({ gradient: e.target.checked ? [t.color ?? '#ffffff', '#7aa8ff'] : null })} />${t.gradient ? html`<input type="color" aria-label="Gradient start color" value=${t.gradient[0]} onChange=${e => upd({ gradient: [e.target.value, t.gradient[1]] })} /><input type="color" aria-label="Gradient end color" value=${t.gradient[1]} onChange=${e => upd({ gradient: [t.gradient[0], e.target.value] })} />` : null}</div>
      <div class="field"><label>Outline</label><input type="checkbox" aria-label="Outline" checked=${Boolean(t.stroke)} onChange=${e => upd({ stroke: e.target.checked ? { color: '#000000', width: 3 } : null })} />${t.stroke ? html`<input type="color" aria-label="Outline color" value=${t.stroke.color} onChange=${e => upd({ stroke: { color: e.target.value } })} />` : null}</div>
      ${t.stroke ? html`<${Field} clip=${clip} path="title.stroke.width" label="Outline width" step=${0.5} min=${0} />` : null}
      <div class="field"><label>Shadow</label><input type="checkbox" checked=${Boolean(t.shadow)} onChange=${e => upd({ shadow: e.target.checked ? { color: '#00000099', blur: 18, x: 0, y: 6 } : null })} /></div>
      ${t.shadow ? html`<${Field} clip=${clip} path="title.shadow.blur" label="Shadow blur" step=${1} min=${0} digits=${0} /><${Field} clip=${clip} path="title.shadow.y" label="Shadow Y" step=${1} digits=${0} />` : null}
      <div class="field"><label>Plate</label><input type="checkbox" aria-label="Plate" checked=${Boolean(t.plate)} onChange=${e => upd({ plate: e.target.checked ? '#000000b0' : null })} />${t.plate ? html`<input type="color" aria-label="Plate color" value=${t.plate.slice(0, 7)} onChange=${e => upd({ plate: `${e.target.value}b0` })} />` : null}</div>
      ${t.plate ? html`<${Field} clip=${clip} path="title.padding" label="Padding" step=${1} min=${0} digits=${0} fallback=${24} /><${Field} clip=${clip} path="title.radius" label="Corner radius" step=${1} min=${0} digits=${0} fallback=${10} />` : null}
    </${Section}>
    <${Section} title="Animation">
      <div class="anim-grid">${TITLE_ANIMS.map(a => html`<button class=${`ghost tiny ${(t.anim ?? 'none') === a ? 'on' : ''}`} onClick=${() => upd({ anim: a })}>${a}</button>`)}</div>
    </${Section}>
  `
}

function AudioTab({ clip }) {
  const ids = editTargets(clip)
  const p = viewProject()

  return html`
    <${Section} title="Volume">
      <${Prop} clip=${clip} prop="volume" label="Volume" step=${0.5} min=${-60} max=${24} unit="dB" digits=${1} />
      <${Prop} clip=${clip} prop="pan" label="Pan" step=${0.05} min=${-1} max=${1} digits=${2} />
      <${Field} clip=${clip} path="fadeIn" label="Fade in" step=${1 / p.fps} min=${0} unit="s" />
      <${Field} clip=${clip} path="fadeOut" label="Fade out" step=${1 / p.fps} min=${0} unit="s" />
      <div class="field"><label>Mute</label><input type="checkbox" checked=${Boolean(clip.mute)} onChange=${e => edit({ op: 'update', ids, set: { mute: e.target.checked || null } })} /></div>
    </${Section}>
    <${Section} title="Equalizer">
      <${Field} clip=${clip} path="eq.low" label="Low (220 Hz)" step=${0.5} min=${-24} max=${24} unit="dB" digits=${1} />
      <${Field} clip=${clip} path="eq.mid" label="Mid (1.4 kHz)" step=${0.5} min=${-24} max=${24} unit="dB" digits=${1} />
      <${Field} clip=${clip} path="eq.high" label="High (5.2 kHz)" step=${0.5} min=${-24} max=${24} unit="dB" digits=${1} />
      <div class="row gap wrap">
        <button class="ghost tiny" onClick=${() => edit({ op: 'update', ids, set: { eq: { low: -6, mid: 2, high: 3 } } })}>Voice clarity</button>
        <button class="ghost tiny" onClick=${() => edit({ op: 'update', ids, set: { eq: { low: 4, mid: -2, high: 1 } } })}>Warmth</button>
        <button class="ghost tiny" onClick=${() => edit({ op: 'update', ids, set: { eq: { low: -12, mid: 6, high: -10 } } })}>Telephone</button>
        <button class="ghost tiny" onClick=${() => edit({ op: 'update', ids, set: { eq: null } })}>Flat</button>
      </div>
    </${Section}>
  `
}

function InfoTab({ clip, track }) {
  const p = viewProject()
  const a = clip.src ? p.assets[clip.src] ?? {} : {}
  const [note, setNote] = useState(null)

  return html`
    <${Section} title="Clip">
      <div class="kv"><span>ID</span><b>${clip.id}</b></div>
      <div class="kv"><span>Kind</span><b>${clip.kind}</b></div>
      <div class="kv"><span>Track</span><b>${track.id} ${track.name ?? ''}</b></div>
      <div class="kv"><span>Start</span><b>${timecode(clip.start, p.fps)}</b></div>
      <div class="kv"><span>End</span><b>${timecode(clipEnd(clip), p.fps)}</b></div>
      <div class="kv"><span>Duration</span><b>${timecode(clip.dur, p.fps)}</b></div>
      ${clip.in !== undefined ? html`<div class="kv"><span>Source in</span><b>${timecode(clip.in, p.fps)}</b></div>` : null}
      ${clip.src ? html`<div class="kv"><span>Source</span><b title=${clip.src}>${clip.src.split('/').pop()}</b></div>` : null}
      ${a.codec ? html`<div class="kv"><span>Media</span><b>${a.width ?? ''}${a.width ? '×' : ''}${a.height ?? ''} ${a.fps ? `${a.fps}fps` : ''} ${a.codec}${a.proxy ? ' · proxy' : ''}</b></div>` : null}
      ${clip.link ? html`<div class="kv"><span>Linked</span><b>${clip.link}</b></div>` : null}
      <div class="field"><label>Label</label><input value=${clip.label ?? ''} onKeyDown=${e => e.stopPropagation()} onChange=${e => edit({ op: 'update', id: clip.id, set: { label: e.target.value || null } })} /></div>
      <textarea aria-label="Clip notes" class="note" rows="3" placeholder="Notes" value=${note ?? clip.note ?? ''} onInput=${e => setNote(e.target.value)} onKeyDown=${e => e.stopPropagation()} onBlur=${() => note !== null && (edit({ op: 'update', id: clip.id, set: { note: note || null } }), setNote(null))}></textarea>
    </${Section}>
  `
}

function TransitionInspector({ clip }) {
  const tr = clip.transitionIn

  return html`
    <div class="inspector-head"><b>Transition</b><span class="muted"> into ${clip.id}</span></div>
    <div class="section-body">
      <div class="field"><label>Type</label><select value=${tr.type} onChange=${e => edit({ op: 'transition', id: clip.id, type: e.target.value, dur: tr.dur })}>${TRANSITIONS.map(t => html`<option value=${t}>${t}</option>`)}</select></div>
      <${Num} label="Duration" value=${tr.dur} step=${1 / viewProject().fps} min=${0.05} unit="s" onCommit=${v => edit({ op: 'transition', id: clip.id, type: tr.type, dur: v })} />
      <button class="ghost" onClick=${() => edit({ op: 'transition', id: clip.id, type: 'none' })}>Remove transition</button>
    </div>
  `
}

function CompInspector({ id }) {
  const k = store.project.comps[id]
  const [name, setName] = useState(null)
  const upd = set => edit({ op: 'update_comp', target: id, set })
  const sizes = [['1920x1080', '1080p HD'], ['3840x2160', '4K UHD'], ['1080x1920', '9:16 vertical'], ['1080x1080', '1:1 square'], ['1280x720', '720p']]

  return html`
    <div class="inspector-head"><b>Composition</b><span class="muted"> ${id}</span></div>
    <div class="section-body">
      <div class="field"><label>Name</label><input value=${name ?? k.name} onInput=${e => setName(e.target.value)} onKeyDown=${e => e.stopPropagation()} onBlur=${() => name !== null && (upd({ name }), setName(null))} /></div>
      <div class="field"><label>Size</label><select value=${`${k.width}x${k.height}`} onChange=${e => { const [w, hh] = e.target.value.split('x').map(Number); upd({ width: w, height: hh }) }}>
        ${sizes.map(([v, l]) => html`<option value=${v}>${l} (${v})</option>`)}
        ${sizes.some(([v]) => v === `${k.width}x${k.height}`) ? null : html`<option value=${`${k.width}x${k.height}`}>Custom ${k.width}x${k.height}</option>`}
      </select></div>
      <${Num} label="Duration" value=${k.duration ?? 0} step=${1 / (k.fps ?? 30)} min=${0} unit="s" onCommit=${v => upd({ duration: v || null })} />
      <div class="field"><label>Frame rate</label><select value=${k.fps} onChange=${e => upd({ fps: Number(e.target.value) })}>${[24, 25, 29.97, 30, 50, 60].map(f => html`<option value=${f}>${f}</option>`)}</select></div>
      <div class="field"><label>Background</label><input type="checkbox" aria-label="Background" checked=${k.background && k.background !== 'transparent'} onChange=${e => upd({ background: e.target.checked ? '#000000' : 'transparent' })} />${k.background && k.background !== 'transparent' ? html`<input type="color" aria-label="Background color" value=${k.background} onChange=${e => upd({ background: e.target.value })} />` : html`<span class="muted small">transparent</span>`}</div>
      <div class="hint">Editing inside this composition. Use the breadcrumb above the timeline to go back.</div>
    </div>
  `
}

function ProjectInspector() {
  if (store.openComp && store.project.comps?.[store.openComp]) return html`<${CompInspector} id=${store.openComp} />`
  const p = viewProject()
  const presets = [['1920x1080', '1080p HD'], ['3840x2160', '4K UHD'], ['1280x720', '720p'], ['1080x1920', '9:16 vertical'], ['1080x1080', '1:1 square'], ['1080x1350', '4:5 portrait'], ['2560x1080', '21:9 wide']]
  const [name, setName] = useState(null)

  return html`
    <div class="inspector-head"><b>Project</b></div>
    <div class="section-body">
      <div class="field"><label>Name</label><input value=${name ?? p.name} onInput=${e => setName(e.target.value)} onKeyDown=${e => e.stopPropagation()} onBlur=${() => name !== null && (edit({ op: 'project', set: { name } }), setName(null))} /></div>
      <div class="field"><label>Format</label><select value=${`${p.width}x${p.height}`} onChange=${e => { const [w, hh] = e.target.value.split('x').map(Number); edit({ op: 'project', set: { width: w, height: hh } }) }}>
        ${presets.map(([v, l]) => html`<option value=${v}>${l} (${v})</option>`)}
        ${presets.some(([v]) => v === `${p.width}x${p.height}`) ? null : html`<option value=${`${p.width}x${p.height}`}>Custom ${p.width}x${p.height}</option>`}
      </select></div>
      <div class="field"><label>Frame rate</label><select value=${p.fps} onChange=${e => edit({ op: 'project', set: { fps: Number(e.target.value) } })}>${[23.976, 24, 25, 29.97, 30, 50, 59.94, 60].map(f => html`<option value=${f}>${f}</option>`)}</select></div>
      <div class="field"><label>Background</label><input type="color" value=${p.background ?? '#000000'} onChange=${e => edit({ op: 'project', set: { background: e.target.value } })} /></div>
      <div class="hint">Select a clip to edit it. ⌥-click anything to send it to your assistant.</div>
    </div>
  `
}

export function Inspector() {
  const s = useStore()
  const p = viewProject()
  if (!p) return null
  const trSel = s.selection.find(id => id.startsWith('tr:'))
  if (trSel) {
    const c = p.tracks.flatMap(t => t.clips).find(cc => cc.id === trSel.slice(3))
    if (c?.transitionIn) return html`<div class="panel inspector"><${TransitionInspector} clip=${c} /></div>`
  }
  const found = p.tracks.flatMap(t => t.clips.map(c => ({ track: t, clip: c }))).find(x => x.clip.id === s.selection[0])
  if (!found) {
    const m = p.markers.find(mm => mm.id === s.selMarker)
    if (m) return html`<div class="panel inspector"><${MarkerInspector} m=${m} /></div>`

    return html`<div class="panel inspector"><${ProjectInspector} /></div>`
  }
  const { clip, track } = found
  const tabs = [
    clip.kind !== 'audio' ? ['video', 'Video'] : null,
    clip.kind === 'title' ? ['title', 'Text'] : null,
    clip.kind === 'shape' ? ['shape', 'Shape'] : null,
    clip.kind === 'audio' || (clip.kind === 'video' && !clip.link && p.assets[clip.src]?.hasAudio) ? ['audio', 'Audio'] : null,
    clip.kind !== 'audio' ? ['effects', 'Effects'] : null,
    ...registry.inspectors.filter(sec => sec.when?.(clip, track) ?? true).map(sec => [sec.id, sec.label]),
    ['info', 'Info'],
  ].filter(Boolean)
  const plugged = registry.inspectors.find(sec => sec.id === s.inspectorTab && (sec.when?.(clip, track) ?? true))
  const tab = tabs.some(([k]) => k === s.inspectorTab) ? s.inspectorTab : tabs[0][0]

  return html`
    <div class="panel inspector">
      <div class="inspector-head">
        <b>${clip.label ?? (clip.kind === 'title' ? clip.title?.text?.split('\n')[0] : String(clip.src ?? clip.kind).split('/').pop())}</b>
        <span class="muted">${clip.id}${s.selection.length > 1 ? ` +${s.selection.length - 1}` : ''}</span>
        <span class="grow"></span>
        <button class="ghost tiny inspector-ref" title="Reference this clip to the Assistant (⌥-click works anywhere)" aria-label="Reference this clip to the Assistant" onClick=${() => addRef({ kind: 'clip', id: clip.id, label: `${clip.id} ${clip.label ?? clip.title?.text ?? String(clip.src ?? clip.kind).split('/').pop()}` })}><${Icon} name="attach" /></button>
      </div>
      ${registry.inspectorActions.filter(action => action.when?.(clip, track) ?? true).map(action => h(action.component, { key: action.id, clip, track }))}
      <${ScrollTabs} tabs=${tabs} value=${tab} onChange=${inspectorTab => set({ inspectorTab })} label="Inspector tabs" small=${true} overflow="menu" />
      <div class="inspector-body" tabIndex="0" aria-label=${`${tabs.find(([id]) => id === tab)?.[1] ?? 'Clip'} controls`}>
        ${plugged && tab === plugged.id ? h(plugged.component, { clip, track }) : tab === 'video' ? html`<${VideoTab} clip=${clip} />` : tab === 'title' ? html`<${TitleTab} clip=${clip} />` : tab === 'shape' ? html`<${ShapeAppearance} key=${clip.id} clip=${clip} />` : tab === 'audio' ? html`<${AudioTab} clip=${clip} />` : tab === 'effects' ? html`<${EffectsTab} clip=${clip} />` : html`<${InfoTab} clip=${clip} track=${track} />`}
      </div>
    </div>
  `
}

function MarkerInspector({ m }) {
  const p = viewProject(), comp = p.compId ?? null, expectedVersion = store.version
  const context = { projectRoot: store.root, projectVersion: expectedVersion }
  const editMarker = op => {
    if (store.root !== context.projectRoot) return toast('The project changed since this marker was selected. Select the current marker again.', 'error')
    return edit({ ...op, comp }, undefined, { expectedVersion })
  }
  const update = set => editMarker({ op: 'update_marker', id: m.id, set })
  const deleteMarker = async () => {
    const result = await editMarker({ op: 'delete_marker', id: m.id })
    if (result && store.root === context.projectRoot && (store.openComp ?? null) === comp && store.selMarker === m.id) set({ selMarker: null })
  }

  return html`
    <div class="inspector-head"><b>Marker</b><span class="muted"> ${m.id}</span></div>
    <div class="section-body">
      <div class="field"><label>Label</label><input value=${m.label} onKeyDown=${e => e.stopPropagation()} onChange=${e => update({ label: e.target.value })} /></div>
      <div class="kv"><span>Time</span><b>${timecode(m.t, p.fps)}</b></div>
      <div class="field"><label>Kind</label><select value=${m.kind ?? 'marker'} onChange=${e => update({ kind: e.target.value })}><option>marker</option><option>chapter</option><option>todo</option></select></div>
      <div class="field"><label>Color</label><input type="color" value=${m.color ?? '#f5b942'} onChange=${e => update({ color: e.target.value })} /></div>
      <textarea class="note" rows="3" placeholder="Note" value=${m.note ?? ''} onKeyDown=${e => e.stopPropagation()} onChange=${e => update({ note: e.target.value })}></textarea>
      <div class="row gap"><button class="ghost" onClick=${() => player.seek(m.t)}>Go to</button><button class="ghost" onClick=${() => addRef({ kind: 'marker', id: m.id, label: `marker "${m.label}"`, comp, context })}>Reference to Assistant</button><button class="ghost danger" onClick=${deleteMarker}>Delete</button></div>
    </div>
  `
}
