// Audio page: a mixer with channel strips (effects, meters with true-peak hold), a master
// strip with loudness metering and limiter, an effect editor for the selected bus, loudness
// tools and ducking, over the timeline.

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { applyOps, hasAudio } from '/core/project.js'
import { duckOps, mixRoles, speechSpans } from '/core/audio-roles.js'
import { AudioEngine, sounds } from '../engine/audio.js'
import { PRESETS } from '../engine/audio-worklets/fx.js'
import { audio } from './engine-host.js'
import { Num } from './inspector.js'
import { Divider, useLayout } from './layout.js'
import { applyMasterPreset, FxRack, FxSlots, LoudnessMeter, LoudnessMini, matchLoudness, measureMix, normalizeClips, TruePeakReadout } from './plugins/audio-fx.js'
import { api, edit, set, store, toast, useStore, viewProject } from './store.js'
import { Timeline } from './timeline.js'
import { Toolbar } from './timeline-toolbar.js'
import { Viewer } from './viewer.js'

const html = htm.bind(h)

const trackOp = (id, fields, composition) => ({ op: 'update_track', id, comp: composition ?? null, set: fields })

const db = lin => (lin > 0 ? 20 * Math.log10(lin) : -96)

function Meter({ get }) {
  const cv = useRef(null)
  useEffect(() => {
    let id = 0
    const peakHold = { v: -96, t: 0 }
    const draw = () => {
      id = requestAnimationFrame(draw)
      const c = cv.current
      if (!c) return
      const ctx = c.getContext('2d')
      const W = c.width
      const H = c.height
      const lv = get()
      const pk = db(lv.peak)
      const rms = db(lv.rms)
      if (pk > peakHold.v || performance.now() - peakHold.t > 1200) {
        peakHold.v = pk
        peakHold.t = performance.now()
      }
      const y = v => H - Math.max(0, Math.min(1, (v + 60) / 66)) * H
      ctx.fillStyle = '#0b0b0e'
      ctx.fillRect(0, 0, W, H)
      const grad = ctx.createLinearGradient(0, H, 0, 0)
      grad.addColorStop(0, '#2fbf71')
      grad.addColorStop(0.72, '#d8d23a')
      grad.addColorStop(0.9, '#ff5f57')
      ctx.fillStyle = grad
      ctx.fillRect(0, y(rms), W, H - y(rms))
      ctx.fillStyle = '#ffffff55'
      ctx.fillRect(0, y(pk), W, 2)
      ctx.fillStyle = peakHold.v > -0.5 ? '#ff5f57' : '#ffffffaa'
      ctx.fillRect(0, y(peakHold.v), W, 1)
    }
    id = requestAnimationFrame(draw)

    return () => cancelAnimationFrame(id)
  }, [])

  return html`<canvas ref=${cv} class="meter" width="14" height="220"></canvas>`
}

function Strip({ track, p, editing, onEdit }) {
  const vol = track.volume ?? 0
  const preview = v => set({ project: applyOps(store.project, [trackOp(track.id, { volume: v }, p.compId)]).project })

  return html`
    <div class=${`strip ${track.muted ? 'muted' : ''} ${editing ? 'active' : ''}`}>
      <div class="strip-name" title=${track.name}>${track.id}<small>${track.name ?? ''}</small></div>
      <${FxSlots} fx=${track.fx} active=${editing} onOpen=${onEdit} />
      <div class="pan">
        <input aria-label=${`${track.name ?? track.id} pan`} type="range" min="-1" max="1" step="0.01" value=${track.pan ?? 0} onChange=${e => edit(trackOp(track.id, { pan: Number(e.target.value) }, p.compId))} onDblClick=${() => edit(trackOp(track.id, { pan: 0 }, p.compId))} />
        <span>${(track.pan ?? 0) === 0 ? 'C' : (track.pan < 0 ? 'L' : 'R') + Math.round(Math.abs(track.pan) * 100)}</span>
      </div>
      <div class="fader-row">
        <input aria-label=${`${track.name ?? track.id} volume`} class="fader" type="range" orient="vertical" min="-60" max="12" step="0.1" value=${vol}
          onInput=${e => preview(Number(e.target.value))}
          onChange=${e => edit(trackOp(track.id, { volume: Number(e.target.value) }, p.compId))}
          onDblClick=${() => edit(trackOp(track.id, { volume: 0 }, p.compId))} />
        <${Meter} get=${() => AudioEngine.level(audio.meters.get(track.id))} />
      </div>
      <${TruePeakReadout} id=${track.id} />
      <div class="strip-db">${vol > 0 ? '+' : ''}${vol.toFixed(1)} dB</div>
      <div class="row gap">
        <button aria-label=${`Mute ${track.name ?? track.id}`} aria-pressed=${Boolean(track.muted)} class=${track.muted ? 'on mute' : ''} onClick=${() => edit(trackOp(track.id, { muted: !track.muted }, p.compId))}>M</button>
        <button aria-label=${`Solo ${track.name ?? track.id}`} aria-pressed=${Boolean(track.solo)} class=${track.solo ? 'on solo' : ''} onClick=${() => edit(trackOp(track.id, { solo: !track.solo }, p.compId))}>S</button>
      </div>
      <div class="muted small">${track.clips.length} ${track.clips.length === 1 ? 'clip' : 'clips'}</div>
    </div>
  `
}

/** Sets selected clips (or every clip with sound) to a loudness target, measured with their effects. */
function normalize(target = -14) {
  const p = viewProject()
  const ids = store.selection.filter(id => !id.startsWith('tr:'))
  const entries = p.tracks.flatMap(t => t.clips.filter(c => (ids.length ? ids.includes(c.id) : true) && sounds(p, c)).map(clip => ({ clip, track: t })))

  return normalizeClips(entries, target)
}

/**
 * Dips music under dialogue with ramped volume keys. Music and dialogue come from audio roles
 * (a stated role or track name first, else picture sound is dialogue and audio-only files are
 * music), and the dips follow speech: silences of a second or more inside a dialogue clip, found
 * by the server's silence analysis, let the music back up. Without that analysis the whole
 * dialogue clip counts as speech.
 */
async function duck(amount = -12) {
  const p = viewProject(), version = store.version, comp = store.openComp ?? null
  const { music, dialogue } = mixRoles(p, hasAudio)
  if (!music.length) return toast('No music found. Put music on a track named Music, or give its clip the music role.')
  if (!dialogue.length) return toast('Need some dialogue to duck under')
  const silences = new Map()
  for (const src of new Set(dialogue.map(x => x.clip.src).filter(Boolean))) {
    try { silences.set(src, (await api('/api/analyze', { src, kind: 'silence', noise: -35, min: 1 })).ranges ?? null) } catch { silences.set(src, null) }
  }
  if (store.version !== version || (store.openComp ?? null) !== comp) return toast('The project changed while finding speech. Duck again.', 'error')
  const spans = speechSpans(dialogue, silences)
  const ops = duckOps(music, spans, amount)
  if (!ops.length) return toast('No music overlaps dialogue')
  await edit(ops, `ducked ${music.length} music clip${music.length > 1 ? 's' : ''} under ${spans.length} speech span${spans.length > 1 ? 's' : ''}`, { expectedVersion: version })
}

function MasterStrip({ p, editing, onEdit }) {
  const m = p.master ?? {}
  const vol = Number(m.volume) || 0
  const lim = m.limiter ?? {}
  const limOn = Boolean(m.limiter) && lim.enabled !== false
  const preview = v => set({ project: applyOps(store.project, [{ op: 'project', set: { master: { volume: v } } }]).project })

  return html`
    <div class=${`strip master ${editing ? 'active' : ''}`}>
      <div class="strip-name">Master<small>${limOn ? `limit ${lim.ceiling ?? -1} dBTP` : 'no limiter'}</small></div>
      <${FxSlots} fx=${m.fx} active=${editing} onOpen=${onEdit} />
      <div class="fader-row">
        <input aria-label="Master volume" class="fader" type="range" orient="vertical" min="-30" max="20" step="0.1" value=${vol} title="Master volume, before the limiter"
          onInput=${e => preview(Number(e.target.value))}
          onChange=${e => edit({ op: 'project', set: { master: { volume: Number(e.target.value) } } })}
          onDblClick=${() => edit({ op: 'project', set: { master: { volume: 0 } } })} />
        <${Meter} get=${() => AudioEngine.level(audio.masterL)} /><${Meter} get=${() => AudioEngine.level(audio.masterR)} />
      </div>
      <${LoudnessMini} />
      <div class="strip-db">${vol > 0 ? '+' : ''}${vol.toFixed(1)} dB</div>
      <button aria-label="Master limiter" aria-pressed=${limOn} class=${limOn ? 'on' : ''} title="Brickwall true-peak limiter on the master" onClick=${() => edit({ op: 'project', set: { master: { limiter: { ...lim, enabled: !limOn, ceiling: lim.ceiling ?? -1 } } } })}>Limiter</button>
    </div>
  `
}

/** The effect editor for the selected bus: a track's chain, or the master's chain and limiter. */
function BusEditor({ p, bus, onClose }) {
  const master = bus === 'master'
  const track = master ? null : p.tracks.find(t => t.id === bus)
  if (!master && !track) return null
  const m = p.master ?? {}
  const lim = m.limiter ?? {}
  const limOn = Boolean(m.limiter) && lim.enabled !== false
  const setLim = patch => edit({ op: 'project', set: { master: { limiter: { enabled: limOn, ceiling: lim.ceiling ?? -1, release: lim.release ?? 60, ...patch } } } })
  const onChange = list => (master ? edit({ op: 'project', set: { master: { fx: list } } }) : edit(trackOp(track.id, { fx: list }, p.compId)))

  return html`
    <div class="row gap"><h4 class="grow">Effects · ${master ? 'Master' : `${track.id} ${track.name ?? ''}`}</h4><button class="ghost tiny" onClick=${onClose}>Done</button></div>
    <${FxRack} fx=${master ? m.fx : track.fx} onChange=${onChange} />
    ${master ? html`
      <h4>Limiter (last, after master volume)</h4>
      <div class="field"><label>Enabled</label><input type="checkbox" checked=${limOn} onChange=${e => setLim({ enabled: e.target.checked })} /></div>
      <${Num} label="Ceiling" value=${lim.ceiling ?? -1} step=${0.1} min=${-24} max=${0} unit="dBTP" digits=${1} onCommit=${v => setLim({ ceiling: v })} />
      <${Num} label="Release" value=${lim.release ?? 60} step=${1} min=${1} max=${1000} unit="ms" digits=${0} onCommit=${v => setLim({ release: v })} />` : null}
  `
}

function MasterLoudness({ p }) {
  const m = p.master ?? {}
  const [last, setLast] = useState(null)
  const [busy, setBusy] = useState(false)
  const run = async fn => {
    setBusy(true)
    try {
      const r = await fn()
      if (r) setLast(r)
    } catch (e) {
      toast(e.message, 'error')
    }
    setBusy(false)
  }
  const presets = Object.entries(PRESETS).filter(([, pr]) => pr.scope === 'master')

  return html`
    <h4>Master loudness</h4>
    <${LoudnessMeter} target=${m.target} ceiling=${m.limiter?.ceiling} />
    <div class="row gap wrap">
      ${presets.map(([id, pr]) => html`<button class="ghost" disabled=${busy} title="Master compressor and −1 dBTP limiter, then matches the mix to the target" onClick=${() => run(() => applyMasterPreset(id))}>${pr.label}</button>`)}
    </div>
    <div class="row gap wrap">
      <button class="ghost tiny" disabled=${busy} onClick=${() => run(() => measureMix())}>Measure mix</button>
      ${Number.isFinite(m.target) ? html`<button class="ghost tiny" disabled=${busy} onClick=${() => run(() => matchLoudness(m.target))}>Match ${m.target} LUFS again</button>` : null}
      ${busy ? html`<span class="muted small">rendering…</span>` : null}
    </div>
    ${last ? html`<div class="hint">Offline: ${last.integrated.toFixed(1)} LUFS integrated, LRA ${last.lra.toFixed(1)} LU, true peak ${last.truePeak.toFixed(1)} dBTP, max short-term ${last.shortTermMax.toFixed(1)}.</div>` : null}
  `
}

export function AudioPage() {
  const s = useStore()
  const layout = useLayout()
  const p = viewProject()
  const tracks = p.tracks.filter(t => t.kind === 'audio')
  const [bus, setBus] = useState(null)
  const toggle = id => setBus(bus === id ? null : id)

  return html`
    <div class=${`page audio ${layout.showTimeline ? '' : 'timeline-hidden'}`} style=${{ '--mixer-width': `${(tracks.length + 1) * 98 + 18}px` }}>
      <div class="audio-top">
        <section class="mixer-panel" aria-label="Audio mixer">
          <div class="workspace-panel-head"><b>Mixer</b><span>${tracks.length} audio tracks · Master</span></div>
          <div class="mixer" tabIndex="0" aria-label="Mixer channels">
          ${tracks.map(t => html`<${Strip} key=${t.id} track=${t} p=${p} editing=${bus === t.id} onEdit=${() => toggle(t.id)} />`)}
          <${MasterStrip} p=${p} editing=${bus === 'master'} onEdit=${() => toggle('master')} />
          </div>
        </section>
        <section class="audio-monitor" aria-label="Picture monitor"><${Viewer} compact=${true} /></section>
        <section class="audio-tools" tabIndex="0" aria-label="Audio tools">
          ${bus ? html`<${BusEditor} p=${p} bus=${bus} onClose=${() => setBus(null)} />` : html`
          <${MasterLoudness} p=${p} />
          <h4>Clip loudness</h4>
          <div class="row gap wrap">
            <button class="ghost" onClick=${() => normalize(-14)}>Normalize to −14 LUFS</button>
            <button class="ghost" onClick=${() => normalize(-16)}>−16 LUFS (podcast)</button>
            <button class="ghost" onClick=${() => normalize(-23)}>−23 LUFS (broadcast)</button>
          </div>
          <div class="hint">Works on the selected clips, or every clip with sound, measured with their effects.</div>
          <h4>Ducking</h4>
          <div class="row gap wrap">
            <button class="ghost" onClick=${() => duck(-12)}>Duck music under dialogue</button>
            <button class="ghost" onClick=${() => duck(-6)}>Gentle duck</button>
          </div>
          <h4>Fades</h4>
          <div class="row gap wrap">
            <button class="ghost" onClick=${() => edit(p.tracks.filter(t => t.kind === 'audio').flatMap(t => t.clips.map(c => ({ op: 'update', id: c.id, set: { fadeIn: 0.04, fadeOut: 0.04 } }))), 'micro fades on every audio cut')}>Click-free cuts</button>
          </div>`}
        </section>
      </div>
      ${layout.showTimeline ? html`<${Divider} field="upper" axis="vertical" label="Resize audio workspace and timeline" /><div class="lower"><${Toolbar} /><${Timeline} /></div>` : null}
    </div>
  `
}
