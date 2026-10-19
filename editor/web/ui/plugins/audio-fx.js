// Audio effects UI: the clip "Audio FX" inspector section, the effect rack the mixer reuses for
// tracks and the master, the loudness meter, loudness presets and matching, and voice clean-up
// in the clip menu. Effect chains are plain arrays in the project; every change sends the whole
// array (ops replace arrays wholesale).

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { applyOps, clipEnd, duration, hasAudio, sortedKeys, valueAt } from '/core/project.js'
import { CLEAN_DEFAULTS, cleanRecipe, cleanSettings, cleanSource, detachedAudioSettings } from '/core/audio-cleanup.js'
import { biquadCoefs, biquadMagnitudeDb } from '../../engine/audio-worklets/dsp.js'
import { EQ_BAND_TYPES, eqBands, FX_TYPES, fxParams, loudnessGain, MAX_EQ_BANDS, newFx, PRESETS } from '../../engine/audio-worklets/fx.js'
import { sounds } from '../../engine/audio.js'
import { audio } from '../engine-host.js'
import { Num } from '../inspector.js'
import { registerClipMenu, registerInspector } from '../registry.js'
import { api, edit, set, store, toast, useStore, useTime, viewProject } from '../store.js'

const html = htm.bind(h)

const CSS = `
.afx-rack { display: flex; flex-direction: column; gap: 6px; }
.afx-card { border: 1px solid var(--line); border-radius: 6px; background: #141418; }
.afx-card.off { opacity: 0.55; }
.afx-head { display: flex; align-items: center; gap: 2px; padding: 3px 4px 3px 6px; font-size: 12px; font-weight: 600; }
.afx-head .afx-name { flex: 1; cursor: pointer; user-select: none; }
.afx-body { padding: 2px 8px 8px; display: flex; flex-direction: column; gap: 4px; }
.afx-body .field > label { width: 76px; }
.afx-add { display: flex; gap: 6px; }
.afx-add select { flex: 1; min-width: 0; }
.afx-eq canvas { width: 100%; height: 92px; border: 1px solid var(--line); border-radius: 5px; background: #0d0d10; display: block; }
.afx-band { border-top: 1px solid var(--line); padding-top: 4px; display: flex; flex-direction: column; gap: 3px; }
.afx-band .field select { flex: 1; }
.afx-meter { display: flex; flex-direction: column; gap: 6px; }
.afx-loud { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 8px; font-size: 10.5px; color: var(--muted); }
.afx-loud b { display: block; font: 600 15px ui-monospace, Menlo, monospace; color: var(--text); }
.afx-loud b.hot { color: var(--danger); }
.afx-bar { height: 7px; background: #000; border-radius: 3px; position: relative; overflow: hidden; }
.afx-bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--good); }
.afx-bar i.m { background: #2fbf7166; }
.afx-bar u { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--accent); }
.afx-slots { display: flex; flex-direction: column; gap: 2px; width: 100%; }
.afx-slot { font-size: 10.5px; padding: 1px 4px; text-align: left; overflow: hidden; text-overflow: ellipsis; }
.afx-slot.off { opacity: 0.45; text-decoration: line-through; }
.afx-slot.empty { color: var(--muted); }
.afx-tp { font: 10px ui-monospace, Menlo, monospace; color: var(--muted); cursor: pointer; }
.afx-tp.hot { color: var(--danger); }
.afx-mini { font: 10px ui-monospace, Menlo, monospace; color: var(--muted); text-align: center; line-height: 1.3; }
.afx-mini b { color: var(--text); font-weight: 600; }
`

if (typeof document !== 'undefined' && !document.getElementById('afx-style')) {
  const style = document.createElement('style')
  style.id = 'afx-style'
  style.textContent = CSS
  document.head.appendChild(style)
}

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–')
const dbOf = v => (v > 0 ? 20 * Math.log10(v) : -Infinity)
const digitsOf = step => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2)

// ---------------------------------------------------------------- parameters and keyframes

/**
 * A number field for an effect parameter. Given a clip, it is keyframable at the playhead on
 * `prop` (fx.<index>.params.<name>): with keys, it shows and sets the keyed value.
 */
function ParamNum({ label, value, spec, onCommit, clip, prop }) {
  const common = { label, step: spec.step, min: spec.min, max: spec.max, unit: spec.unit, digits: digitsOf(spec.step) }
  if (!clip) return html`<${Num} ...${common} value=${value} onCommit=${onCommit} />`

  return html`<${KeyedNum} common=${common} value=${value} onCommit=${onCommit} clip=${clip} prop=${prop} />`
}

function KeyedNum({ common, value, onCommit, clip, prop }) {
  const t = useTime()
  const p = store.project
  const local = Math.max(0, Math.min(clip.dur, t - clip.start))
  const keys = sortedKeys(clip.anim?.[prop])
  const animated = keys.length > 0
  const shown = animated ? valueAt(p, clip, prop, local) : value
  const here = keys.find(k => Math.abs(k[0] - local) < 1 / 120)
  const inside = t >= clip.start - 1e-6 && t <= clipEnd(clip) + 1e-6
  const at = Math.min(clipEnd(clip), Math.max(clip.start, t))
  const commit = v => (animated ? edit({ op: 'keyframe', id: clip.id, prop, at, value: v }) : onCommit(v))
  const name = common.label ?? prop
  const dot = html`<span class="kf"><button class=${`kf-dot ${here ? 'on' : animated ? 'some' : ''}`} disabled=${!inside}
    aria-label=${here ? `Remove ${name} keyframe at playhead` : `Add ${name} keyframe at playhead`}
    title=${here ? 'Remove keyframe' : 'Keyframe at playhead'} onClick=${() => edit({ op: 'keyframe', id: clip.id, prop, at, value: shown, remove: Boolean(here) })}>${here ? '◆' : '◇'}</button></span>`

  return html`<${Num} ...${common} value=${shown} onCommit=${commit} keyframe=${dot} />`
}

/**
 * The anim/expr changes that keep effect keyframes on their effect when the chain is
 * reordered: `map(oldIndex)` is the new index, or -1 when the effect was removed.
 */
export function fxAnimPatch(clip, map) {
  const patch = {}
  for (const field of ['anim', 'expr']) {
    const src = clip?.[field]
    if (!src) continue
    const out = {}
    for (const k of Object.keys(src)) {
      const m = /^fx\.(\d+)\.(.+)$/.exec(k)
      if (m && map(Number(m[1])) !== Number(m[1])) out[k] = null
    }
    for (const [k, v] of Object.entries(src)) {
      const m = /^fx\.(\d+)\.(.+)$/.exec(k)
      const to = m ? map(Number(m[1])) : -1
      if (m && to >= 0 && to !== Number(m[1])) out[`fx.${to}.${m[2]}`] = v
    }
    if (Object.keys(out).length) patch[field] = out
  }

  return patch
}

// ---------------------------------------------------------------- the rack

/**
 * An effect chain editor. onChange(list, map) gets the whole new array and, for reorders and
 * removals, the old → new index map (so clip keyframes can follow their effect).
 */
export function FxRack({ fx, onChange, clip, presets = true }) {
  const list = Array.isArray(fx) ? fx : []
  const update = (i, patch) => onChange(list.map((f, k) => (k === i ? { ...f, ...patch } : f)))
  const move = (i, d) => {
    const j = i + d
    if (j < 0 || j >= list.length) return
    const next = [...list]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next, k => (k === i ? j : k === j ? i : k))
  }
  const remove = i => onChange(list.filter((_, k) => k !== i), k => (k === i ? -1 : k > i ? k - 1 : k))

  return html`
    <div class="afx-rack">
      ${list.map((f, i) => html`<${FxCard} key=${`${i}:${f.type}`} fx=${f} index=${i} count=${list.length} clip=${clip}
        onToggle=${on => update(i, { enabled: on })}
        onParams=${params => update(i, { params: { ...(f.params ?? {}), ...params } })}
        onMove=${d => move(i, d)} onRemove=${() => remove(i)} />`)}
      ${list.length ? null : html`<div class="hint">No effects yet.</div>`}
      <div class="afx-add">
        <select value="" onChange=${e => {
          const type = e.target.value
          e.target.value = ''
          if (type) onChange([...list, newFx(type)])
        }}>
          <option value="">+ Add effect…</option>
          ${Object.entries(FX_TYPES).map(([k, spec]) => html`<option value=${k}>${spec.label}</option>`)}
        </select>
        ${presets ? html`<select value="" title="Replace the chain with a preset" onChange=${e => {
          const id = e.target.value
          e.target.value = ''
          if (id) onChange(PRESETS[id].fx(), () => -1)
        }}>
          <option value="">Preset…</option>
          ${Object.entries(PRESETS).filter(([, pr]) => pr.scope === 'chain').map(([id, pr]) => html`<option value=${id}>${pr.label}</option>`)}
        </select>` : null}
      </div>
    </div>
  `
}

function FxCard({ fx, index, count, clip, onToggle, onParams, onMove, onRemove }) {
  const [open, setOpen] = useState(true)
  const spec = FX_TYPES[fx?.type]
  const on = fx?.enabled !== false
  const P = fxParams(fx)

  return html`
    <div class=${`afx-card ${on ? '' : 'off'}`}>
      <div class="afx-head">
        <input type="checkbox" checked=${on} title=${on ? 'Bypass' : 'Enable'} onChange=${e => onToggle(e.target.checked)} />
        <span class="afx-name" onClick=${() => setOpen(!open)}>${open ? '▾' : '▸'} ${spec?.label ?? `${fx?.type} (unknown, skipped)`}</span>
        <button class="ghost tiny" disabled=${index === 0} title="Move up" onClick=${() => onMove(-1)}>↑</button>
        <button class="ghost tiny" disabled=${index === count - 1} title="Move down" onClick=${() => onMove(1)}>↓</button>
        <button class="ghost tiny" title="Remove" onClick=${onRemove}>✕</button>
      </div>
      ${open && spec ? html`<div class="afx-body">
        ${fx.type === 'eq'
          ? html`<${EqEditor} fx=${fx} index=${index} clip=${clip} onParams=${onParams} />`
          : Object.entries(spec.params).map(([k, d]) => html`<${ParamNum} key=${k} label=${d.label} value=${P[k]} spec=${d} clip=${clip}
              prop=${`fx.${index}.params.${k}`} onCommit=${v => onParams({ [k]: v })} />`)}
      </div>` : null}
    </div>
  `
}

// ---------------------------------------------------------------- parametric eq

const BAND_SPECS = {
  freq: { label: 'Freq', min: 20, max: 20000, step: 1, unit: 'Hz' },
  gain: { label: 'Gain', min: -24, max: 24, step: 0.5, unit: 'dB' },
  q: { label: 'Q', min: 0.1, max: 18, step: 0.05, unit: '' },
}

const usesGain = type => type === 'peaking' || type === 'lowshelf' || type === 'highshelf'
const usesQ = type => type !== 'lowshelf' && type !== 'highshelf'

/** Combined response (dB) of eq bands at a frequency, as the engine's biquads compute it. */
export function eqResponse(bands, freq, fs = 48000) {
  return bands.reduce((sum, b) => sum + biquadMagnitudeDb(biquadCoefs(b.type, fs, b.freq, b.q, b.gain), fs, freq), 0)
}

function drawEq(cv, bands) {
  if (!cv) return
  const ctx = cv.getContext('2d')
  const W = cv.width
  const H = cv.height
  const range = 18
  const x = f => (Math.log10(f / 20) / 3) * W
  const y = d => H / 2 - (Math.max(-range, Math.min(range, d)) / range) * (H / 2 - 4)
  ctx.fillStyle = '#0d0d10'
  ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = '#ffffff14'
  ctx.lineWidth = 1
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    ctx.beginPath()
    ctx.moveTo(x(f), 0)
    ctx.lineTo(x(f), H)
    ctx.stroke()
  }
  for (const d of [-12, -6, 6, 12]) {
    ctx.beginPath()
    ctx.moveTo(0, y(d))
    ctx.lineTo(W, y(d))
    ctx.stroke()
  }
  ctx.strokeStyle = '#ffffff40'
  ctx.beginPath()
  ctx.moveTo(0, y(0))
  ctx.lineTo(W, y(0))
  ctx.stroke()
  ctx.fillStyle = '#8b8b98'
  ctx.font = '18px -apple-system, sans-serif'
  for (const [f, l] of [[100, '100'], [1000, '1k'], [10000, '10k']]) ctx.fillText(l, x(f) + 4, H - 6)
  ctx.strokeStyle = '#f5b942'
  ctx.lineWidth = 3
  ctx.beginPath()
  for (let px = 0; px <= W; px += 2) {
    const f = 20 * 10 ** ((px / W) * 3)
    const d = eqResponse(bands, f)
    px === 0 ? ctx.moveTo(px, y(d)) : ctx.lineTo(px, y(d))
  }
  ctx.stroke()
  ctx.fillStyle = '#f5b942'
  bands.forEach((b, k) => {
    const cx = x(b.freq)
    const cy = y(eqResponse(bands, b.freq))
    ctx.beginPath()
    ctx.arc(cx, cy, 7, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#1a1405'
    ctx.fillText(String(k + 1), cx - 5, cy + 6)
    ctx.fillStyle = '#f5b942'
  })
}

function EqEditor({ fx, index, clip, onParams }) {
  const bands = eqBands(fx)
  const cv = useRef(null)
  const setBands = next => onParams({ bands: next })
  const setBand = (k, patch) => setBands(bands.map((b, j) => (j === k ? { ...b, ...patch } : b)))
  const key = JSON.stringify(bands)
  useEffect(() => drawEq(cv.current, bands), [key])

  return html`
    <div class="afx-eq">
      <canvas ref=${cv} width="600" height="190"></canvas>
      ${bands.map((b, k) => html`
        <div class="afx-band" key=${k}>
          <div class="field"><label>Band ${k + 1}</label>
            <select value=${b.type} onChange=${e => setBand(k, { type: e.target.value })}>${EQ_BAND_TYPES.map(t => html`<option value=${t}>${t}</option>`)}</select>
            <button class="ghost tiny" title="Remove band" onClick=${() => setBands(bands.filter((_, j) => j !== k))}>✕</button>
          </div>
          <${ParamNum} label="Freq" value=${b.freq} spec=${BAND_SPECS.freq} clip=${clip} prop=${`fx.${index}.params.bands.${k}.freq`} onCommit=${v => setBand(k, { freq: v })} />
          ${usesGain(b.type) ? html`<${ParamNum} label="Gain" value=${b.gain} spec=${BAND_SPECS.gain} clip=${clip} prop=${`fx.${index}.params.bands.${k}.gain`} onCommit=${v => setBand(k, { gain: v })} />` : null}
          ${usesQ(b.type) ? html`<${ParamNum} label="Q" value=${b.q} spec=${BAND_SPECS.q} clip=${clip} prop=${`fx.${index}.params.bands.${k}.q`} onCommit=${v => setBand(k, { q: v })} />` : null}
        </div>`)}
      ${bands.length < MAX_EQ_BANDS ? html`<button class="ghost tiny" onClick=${() => setBands([...bands, { type: 'peaking', freq: 1000, gain: 0, q: 1 }])}>+ Band</button>` : html`<div class="hint">Six bands at most.</div>`}
    </div>
  `
}

// ---------------------------------------------------------------- meters

/** Re-renders a component every `ms` while mounted (meters read engine state, not the store). */
function useTick(ms = 120) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force(x => x + 1), ms)

    return () => clearInterval(id)
  }, [])
}

/** The master loudness meter: momentary, short-term, integrated, LRA and true-peak max. */
export function LoudnessMeter({ target, ceiling }) {
  useTick(120)
  const L = audio.loudness
  const tp = L ? dbOf(Math.max(...L.truePeakMax)) : -Infinity
  const pos = v => `${Math.max(0, Math.min(100, ((v + 42) / 42) * 100))}%`
  const over = Number.isFinite(tp) && tp > (ceiling ?? -1)

  return html`
    <div class="afx-meter">
      <div class="afx-loud">
        <div>Momentary<b>${fmt(L?.momentary)}</b></div>
        <div>Short-term<b>${fmt(L?.shortTerm)}</b></div>
        <div>Integrated<b class=${Number.isFinite(target) && Math.abs((L?.integrated ?? -99) - target) > 1 && Number.isFinite(L?.integrated) ? 'hot' : ''}>${fmt(L?.integrated)}</b></div>
        <div>LRA (LU)<b>${fmt(L?.lra)}</b></div>
        <div>True peak<b class=${over ? 'hot' : ''}>${fmt(tp)}</b></div>
        <div>Target<b>${Number.isFinite(target) ? target : '–'}</b></div>
      </div>
      <div class="afx-bar" title="Short-term (bright) and momentary loudness, −42…0 LUFS; the mark is the target">
        <i class="m" style=${{ width: pos(L?.momentary ?? -99) }}></i>
        <i style=${{ width: pos(L?.shortTerm ?? -99) }}></i>
        ${Number.isFinite(target) ? html`<u style=${{ left: pos(target) }}></u>` : null}
      </div>
      <div class="row gap"><span class="hint grow">LUFS (EBU R128), dBTP. Integrated covers playback since play or reset.</span><button class="ghost tiny" onClick=${() => audio.resetMeters()}>Reset</button></div>
    </div>
  `
}

/** Short loudness readout for the master strip. */
export function LoudnessMini() {
  useTick(200)
  const L = audio.loudness

  return html`<div class="afx-mini" title="Short-term and integrated loudness (LUFS)">S <b>${fmt(L?.shortTerm)}</b><br />I <b>${fmt(L?.integrated)}</b></div>`
}

/** The true-peak hold of a track strip (dBTP); click to reset. */
export function TruePeakReadout({ id }) {
  useTick(200)
  const pk = audio.trackPeaks.get(id)
  const v = pk ? dbOf(Math.max(...pk.hold)) : -Infinity

  return html`<div class=${`afx-tp ${v > -1 ? 'hot' : ''}`} title="True-peak hold (dBTP); click to reset" onClick=${() => audio.trackPeaks.delete(id)}>TP ${fmt(v)}</div>`
}

/** The effect names of a chain, as slots on a mixer strip. */
export function FxSlots({ fx, active, onOpen }) {
  const list = Array.isArray(fx) ? fx : []

  return html`
    <div class="afx-slots">
      ${list.slice(0, 4).map(f => html`<button class=${`ghost tiny afx-slot ${f.enabled === false ? 'off' : ''} ${active ? 'on' : ''}`} onClick=${onOpen}>${FX_TYPES[f.type]?.label ?? f.type}</button>`)}
      ${list.length > 4 ? html`<button class="ghost tiny afx-slot" onClick=${onOpen}>+${list.length - 4} more</button>` : null}
      <button class=${`ghost tiny afx-slot empty ${active ? 'on' : ''}`} onClick=${onOpen}>${list.length ? 'Edit FX' : '+ FX'}</button>
    </div>
  `
}

// Capture the project and editing scope before asynchronous audio work.
function captureAudioWorkflow() {
  if (!store.project) throw new Error('Open a project before processing audio')
  return { project: store.project, root: store.root, version: store.version, composition: store.openComp,
    selection: JSON.stringify([...store.selection].sort()), view: viewProject() }
}

function assertAudioWorkflowCurrent(capture) {
  if (store.project !== capture.project || store.root !== capture.root || store.version !== capture.version ||
      store.openComp !== capture.composition || JSON.stringify([...store.selection].sort()) !== capture.selection) {
    throw new Error('The project, composition or selection changed. Run the audio action again.')
  }
}

async function acceptCleanupAdmission(capture, receipt) {
  if (receipt.assetRegistered !== true || !Number.isSafeInteger(receipt.admissionVersion) || !receipt.path || !receipt.asset) throw new Error(receipt.registrationError ?? 'The cleaned output was not saved in Media')
  const contextCurrent = () => store.root === capture.root && store.openComp === capture.composition && JSON.stringify([...store.selection].sort()) === capture.selection
  if (!contextCurrent()) throw new Error('The editor context changed. The cleaned output is saved in the original project Media.')
  const expected = applyOps(capture.project, [{ op: 'import', assets: { [receipt.path]: receipt.asset } }]).project
  const same = project => JSON.stringify(project) === JSON.stringify(expected)
  const ownedStore = () => store.version === capture.version && store.project === capture.project || store.version === receipt.admissionVersion && same(store.project)
  if (!ownedStore()) throw new Error('The project changed. The cleaned output is saved in Media; review it before placing it.')
  const latest = await api('/api/project')
  if (!contextCurrent() || !ownedStore() || latest.version !== receipt.admissionVersion || !same(latest.project)) throw new Error('The project changed. The cleaned output is saved in Media; review it before placing it.')
  set({ project: latest.project, version: latest.version })
  return { ...capture, project: latest.project, version: latest.version, view: viewProject() }
}

function capturedAudioClip(capture, clip) {
  const track = capture.view.tracks.find(t => t.clips.some(c => c.id === clip.id))
  const current = track?.clips.find(c => c.id === clip.id)
  if (!current || track.locked || JSON.stringify(current) !== JSON.stringify(clip)) {
    throw new Error('The audio clip changed or its track is locked. Select its current clip again.')
  }
  return { clip: current, track }
}

// ---------------------------------------------------------------- loudness actions

/** The range a mix is measured over: the project range, else the whole timeline. */
function mixRange(p) {
  const r = p.range
  if (r && r.out > r.in) return [r.in, r.out]

  return [0, duration(p)]
}

/** Renders the mix offline (effects, limiter and all) and measures it. */
export async function measureMix(p = viewProject()) {
  const [from, to] = mixRange(p)
  if (!(to > from)) throw new Error('Nothing on the timeline to measure')

  return audio.measure(p, from, to)
}

/**
 * Moves the mix to a loudness target with the master volume (before the limiter), re-measuring
 * until it lands within 0.1 LU (the limiter makes the response slightly non-linear).
 */
export async function matchLoudness(target) {
  const capture = captureAudioWorkflow()
  let p = capture.view
  let volume = Number(p.master?.volume) || 0
  toast(`Measuring the mix for ${target} LUFS…`)
  let m = await measureMix(p)
  assertAudioWorkflowCurrent(capture)
  for (let i = 0; i < 4 && Number.isFinite(m.integrated) && Math.abs(m.integrated - target) > 0.1; i++) {
    volume = loudnessGain(m.integrated, target, volume)
    p = { ...p, master: { ...(p.master ?? {}), volume } }
    m = await measureMix(p)
    assertAudioWorkflowCurrent(capture)
  }
  if (!Number.isFinite(m.integrated)) return toast('The mix is silent', 'error')
  const result = await edit({ op: 'project', set: { master: { volume, target } } }, `mix to ${target} LUFS`, { expectedVersion: capture.version })
  if (!result) return null
  toast(`Mix: ${fmt(m.integrated)} LUFS integrated, ${fmt(m.truePeak)} dBTP, LRA ${fmt(m.lra)} LU`)

  return m
}

/** Applies a master preset (Broadcast, Social): master effects and limiter, then matches loudness. */
export async function applyMasterPreset(id) {
  const preset = PRESETS[id]
  const m = preset.master()
  const capture = captureAudioWorkflow()
  const result = await edit({ op: 'project', set: { master: { fx: m.fx, limiter: m.limiter, target: m.target } } }, `master preset ${preset.label}`, { expectedVersion: capture.version })
  if (!result) return null
  // The preset is committed. Match only in the same editor context.
  if (store.root !== capture.root || store.openComp !== capture.composition || store.version !== result.version || store.project !== result.project || JSON.stringify([...store.selection].sort()) !== capture.selection) {
    return toast('The editor changed after the preset was applied. Match its current mix again.', 'error')
  }

  return matchLoudness(m.target).catch(e => toast(e.message, 'error'))
}

/** Measures one clip as it sounds (its effects included, alone, no track or master processing). */
export async function measureClip(p, clip, track) {
  const view = { ...p, master: undefined, tracks: [{ id: track?.id ?? 'solo', kind: track?.kind ?? 'audio', name: 'solo', volume: 0, pan: 0, clips: [clip] }] }

  return audio.measure(view, clip.start, clipEnd(clip))
}

/**
 * Ops that move a clip to a loudness target: volume after its effects is linear, so this lands
 * exactly, unless the gain would lift the true peak over `ceiling` (dBTP); then it stops there.
 */
export function normalizeOps(clip, measured, target, truePeak = -Infinity, ceiling = -1) {
  if (!Number.isFinite(measured)) return []
  const wanted = Math.round((target - measured) * 10) / 10
  const limit = Number.isFinite(truePeak) ? ceiling - truePeak : Infinity
  const delta = wanted <= limit + 1e-9 ? wanted : Math.floor(limit * 10 + 1e-9) / 10
  if (clip.anim?.volume?.length) return [{ op: 'update', id: clip.id, set: { anim: { volume: clip.anim.volume.map(([t, v, e]) => (e === undefined ? [t, v + delta] : [t, v + delta, e])) } } }]

  return [{ op: 'update', id: clip.id, set: { volume: Math.round(((clip.volume ?? 0) + delta) * 10) / 10 } }]
}

export async function normalizeClips(entries, target) {
  if (!entries.length) return toast('No clips with sound to normalize')
  try {
    const capture = captureAudioWorkflow()
    const targets = entries.map(({ clip }) => capturedAudioClip(capture, clip))
    toast(`Measuring ${targets.length} clip${targets.length > 1 ? 's' : ''}…`)
    const ops = []
    let failed = 0, limited = 0
    for (const { clip, track } of targets) {
      assertAudioWorkflowCurrent(capture)
      try {
        const m = await measureClip(capture.view, clip, track)
        assertAudioWorkflowCurrent(capture)
        ops.push(...normalizeOps(clip, m.integrated, target, m.truePeak))
        if (Number.isFinite(m.integrated) && Number.isFinite(m.truePeak) && Math.round((target - m.integrated) * 10) / 10 > -1 - m.truePeak + 1e-9) limited++
        if (!Number.isFinite(m.integrated)) failed++
      } catch (e) {
        assertAudioWorkflowCurrent(capture)
        console.warn('measure', clip.id, e)
        failed++
      }
    }
    assertAudioWorkflowCurrent(capture)
    if (!ops.length) return toast('No measurable audio was found in these clips', 'error')
    const result = await edit(ops, `normalized ${ops.length} clip${ops.length > 1 ? 's' : ''} to ${target} LUFS`, { expectedVersion: capture.version })
    if (result && failed) toast(`${ops.length} clips normalized; ${failed} could not be measured.`, 'error')
    if (result && limited) toast(`${limited} clip${limited > 1 ? 's' : ''} stopped below ${target} LUFS to keep true peak under -1 dBTP. Use the master limiter to go further.`)
    return result
  } catch (e) {
    toast(e.message, 'error')
    return null
  }
}

// ---------------------------------------------------------------- clean-up

function freeAudioTrack(p, from, to) {
  return p.tracks.find(t => t.kind === 'audio' && !t.locked && !t.clips.some(c => c.start < to && clipEnd(c) > from))
}

/** Renders a cleaned copy of a clip's audio on the server and points the clip at it. */
export async function cleanClip(clip, mode = 'voice', input = CLEAN_DEFAULTS) {
  if (store.caps.processing?.audioClean === false) return toast('Open the browser editor to render cleaned audio', 'error')
  if (!clip.src) return toast('This clip has no source to clean', 'error')
  toast(mode === 'voice' ? 'Cleaning up the voice…' : 'Removing noise…')
  let receipt
  try {
    let capture = captureAudioWorkflow()
    clip = capturedAudioClip(capture, clip).clip
    const source = cleanSource(clip, capture.project.assets)
    const options = cleanSettings(input, capture.project.assets?.[source]?.duration)
    const r = await api('/api/audio/clean', { src: source, mode, ...options, apply: false, expectedVersion: capture.version })
    receipt = r
    capture = await acceptCleanupAdmission(capture, r)
    assertAudioWorkflowCurrent(capture)
    const recipe = cleanRecipe(source, r.path, mode, options, r.engine)
    const ops = []
    if (clip.kind === 'audio') {
      ops.push({ op: 'update', id: clip.id, comp: capture.composition, set: { audioCleanup: null } }, { op: 'update', id: clip.id, comp: capture.composition, set: { src: r.path, audioCleanup: recipe } })
    } else {
      // Video with its own sound: the cleaned sound goes on an audio track and the video's is muted.
      const p = capture.view
      let track = freeAudioTrack(p, clip.start, clipEnd(clip))
      if (!track) {
        ops.push({ op: 'add_track', comp: capture.composition, kind: 'audio', name: 'Cleaned' })
        const preview = applyOps(capture.project, ops).project
        track = freeAudioTrack(capture.composition ? { ...p, tracks: preview.comps[capture.composition].tracks } : preview, clip.start, clipEnd(clip))
      }
      if (!track) throw new Error('no free audio track')
      ops.push(
        { op: 'add_clip', comp: capture.composition, kind: 'audio', src: r.path, track: track.id, start: clip.start, in: clip.in ?? 0, dur: clip.dur, set: { ...detachedAudioSettings(clip), audioCleanup: recipe } },
        { op: 'update', id: clip.id, comp: capture.composition, set: { mute: true } },
      )
    }
    const result = await edit(ops, `${mode === 'voice' ? 'cleaned voice' : 'denoised audio'} of ${clip.id}`, { expectedVersion: capture.version })
    if (!result) { toast('Cleaned audio is saved in Media. Placement was not applied.', 'error'); return r }
    toast(`${mode === 'voice' ? 'Voice cleaned' : 'Denoised'}: ${r.path.split('/').pop()}`)
    return r
  } catch (e) {
    toast(e.message, 'error')
    return receipt ?? null
  }
}

registerClipMenu((p, hit) => {
  const c = hit.clip
  if (!c || !c.src) return []
  const embedded = c.kind === 'video' && !c.link && hasAudio(p, { ...c, audioDetached: false, mute: false })
  if (c.kind !== 'audio' && !embedded) return []
  const note = c.kind === 'audio' ? '' : ' (to a new audio clip)'

  return [
    { label: `Clean up voice${note}`, disabled: store.caps.processing?.audioClean === false, run: () => cleanClip(c, 'voice') },
    { label: `Denoise audio${note}`, disabled: store.caps.processing?.audioClean === false, run: () => cleanClip(c, 'denoise') },
  ]
})

// ---------------------------------------------------------------- inspector section

function Section({ title, children }) {
  return html`<div class="section"><div class="section-head">${title}</div><div class="section-body">${children}</div></div>`
}

export function AudioCleanupControls({ clip, canClean }) {
  let source, sourceError
  try { source = cleanSource(clip, store.project?.assets) }
  catch (error) { sourceError = error.message }
  const saved = clip.audioCleanup?.output === clip.src ? clip.audioCleanup.settings ?? CLEAN_DEFAULTS : CLEAN_DEFAULTS
  const [strength, setStrength] = useState(saved.strength ?? CLEAN_DEFAULTS.strength)
  const [detail, setDetail] = useState(saved.detail ?? CLEAN_DEFAULTS.detail)
  const [quality, setQuality] = useState(saved.quality ?? CLEAN_DEFAULTS.quality)
  const [knownNoise, setKnownNoise] = useState(saved.noiseFrom != null)
  const [noiseFrom, setNoiseFrom] = useState(saved.noiseFrom ?? clip.in ?? 0)
  const sourceDuration = store.project?.assets?.[source]?.duration
  const [noiseTo, setNoiseTo] = useState(saved.noiseTo ?? Math.min(sourceDuration ?? Infinity, (clip.in ?? 0) + 0.5))
  const [running, setRunning] = useState(false)
  const invalidNoise = knownNoise && (noiseTo - noiseFrom < 0.1 || noiseFrom < 0 || sourceDuration != null && noiseTo > sourceDuration)
  const run = async mode => {
    if (running || !canClean || invalidNoise || sourceError) return
    setRunning(true)
    try { await cleanClip(clip, mode, { strength, detail, quality, ...(knownNoise ? { noiseFrom, noiseTo } : {}) }) }
    finally { setRunning(false) }
  }
  return html`<div>
    <${Num} label="Strength" value=${strength} min=${0} max=${1} step=${0.05} digits=${2} onCommit=${setStrength} />
    <${Num} label="Preserve detail" value=${detail} min=${0} max=${1} step=${0.05} digits=${2} onCommit=${setDetail} />
    <div class="field"><label>Quality</label><select aria-label="Audio cleanup quality" value=${quality} disabled=${running} onChange=${e => setQuality(e.target.value)}>${['fast', 'balanced', 'high'].map(value => html`<option value=${value}>${value}</option>`)}</select></div>
    <div class="field"><label>Known noise</label><input type="checkbox" aria-label="Use a known noise-only range" checked=${knownNoise} disabled=${running} onChange=${e => setKnownNoise(e.target.checked)} /></div>
    ${knownNoise ? html`<${Num} label="Noise from" value=${noiseFrom} min=${0} max=${sourceDuration} step=${0.1} digits=${2} unit="source s" onCommit=${setNoiseFrom} /><${Num} label="Noise to" value=${noiseTo} min=${0} max=${sourceDuration} step=${0.1} digits=${2} unit="source s" onCommit=${setNoiseTo} />` : null}
    ${invalidNoise ? html`<div class="hint">Choose at least 0.1 seconds of noise-only audio inside the source.</div>` : null}
    ${sourceError ? html`<div class="hint">${sourceError}</div>` : null}
    <div class="row gap wrap">
      <button class="ghost tiny" disabled=${!canClean || running || invalidNoise || !!sourceError} onClick=${() => run('voice')}>Clean up voice</button>
      <button class="ghost tiny" disabled=${!canClean || running || invalidNoise || !!sourceError} onClick=${() => run('denoise')}>Denoise</button>
    </div>
    <div class="hint">${canClean ? `Renders the full original source and retains its cleanup settings. Adjusting an applied result starts with the original sound. Playback and export use the rendered copy. Undo placement restores the previous clip and retains its reusable Media copy${clip.kind === 'video' ? '; cleaned audio keeps its mix controls on a new clip' : ''}.` : 'Open the browser editor to render cleaned audio. Playback effects and loudness controls are available here.'}</div>
    <div class="hint">Stationary noise reduction runs on the CPU. Quality sets spectrum resolution in the native engine and gain smoothing in the browser server. Compare speech detail and noise before stronger settings.</div>
  </div>`
}

function ClipAudioFx({ clip, track }) {
  const s = useStore()
  const canClean = s.caps.processing?.audioClean !== false
  const p = s.project
  const setFx = (list, map) => edit({ op: 'update', id: clip.id, set: { fx: list, ...(map ? fxAnimPatch(clip, map) : {}) } })
  const nested = clip.kind === 'comp' || clip.kind === 'multicam'
  const angles = clip.kind === 'multicam' ? clip.angles ?? [] : []

  return html`
    ${nested ? html`<${Section} title="Sound">
      <${KeyedNum} common=${{ label: 'Volume', step: 0.5, min: -60, max: 24, unit: 'dB', digits: 1 }} value=${clip.volume ?? 0} clip=${clip} prop="volume" onCommit=${v => edit({ op: 'update', id: clip.id, set: { volume: v } })} />
      <${KeyedNum} common=${{ label: 'Pan', step: 0.05, min: -1, max: 1, unit: '', digits: 2 }} value=${clip.pan ?? 0} clip=${clip} prop="pan" onCommit=${v => edit({ op: 'update', id: clip.id, set: { pan: v } })} />
      <div class="field"><label>Mute</label><input type="checkbox" checked=${Boolean(clip.mute)} onChange=${e => edit({ op: 'update', id: clip.id, set: { mute: e.target.checked || null } })} /></div>
      ${angles.length ? html`<div class="field"><label>Audio angle</label><select value=${clip.audioAngle ?? 0} onChange=${e => edit({ op: 'update', id: clip.id, set: { audioAngle: Number(e.target.value) } })}>
        ${angles.map((a, i) => html`<option value=${i}>${a.label ?? `Angle ${i + 1}`}${p.assets[a.src]?.hasAudio ? '' : ' (no sound)'}</option>`)}</select></div>` : null}
      ${clip.kind === 'comp' ? html`<div class="hint">Plays the composition's audio through this clip's in point, speed and effects.</div>` : null}
    </${Section}>` : null}
    <${Section} title="Effects">
      <${FxRack} fx=${clip.fx} clip=${clip} onChange=${setFx} />
      <div class="hint">Effects run before volume and pan, in this order. ◆ keyframes a parameter at the playhead.</div>
    </${Section}>
    <${Section} title="Loudness">
      <div class="row gap wrap">
        ${[-23, -16, -14].map(t => html`<button class="ghost tiny" onClick=${() => normalizeClips([{ clip, track }], t)}>${t} LUFS</button>`)}
      </div>
      <div class="hint">Measures this clip with its effects and sets its volume to the target.</div>
    </${Section}>
    ${clip.src && (clip.kind === 'audio' || clip.kind === 'video') ? html`<${Section} title="Clean-up">
      <${AudioCleanupControls} key=${`${clip.id}:${clip.src}`} clip=${clip} canClean=${canClean} />
    </${Section}>` : null}
  `
}

registerInspector({
  id: 'audiofx',
  label: 'Audio FX',
  order: 40,
  // Audio clips, comp and multicam clips (whose sound the built-in Audio tab does not cover),
  // and video clips that carry their own sound.
  when: clip => {
    const p = store.project
    if (!p) return false
    if (clip.kind === 'audio' || clip.kind === 'multicam') return true
    if (clip.kind === 'comp') return sounds(p, { ...clip, enabled: true, mute: false })
    return clip.kind === 'video' && !clip.link && !clip.audioDetached && Boolean(p.assets[clip.src]?.hasAudio)
  },
  component: ClipAudioFx,
})
