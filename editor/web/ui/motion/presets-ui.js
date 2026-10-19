// Motion presets and text animators for the selected layer, plus a summary of its
// keyframed properties and expressions. Shown on the Motion page and as the Motion tab
// of the inspector.

import { h } from 'preact'
import htm from 'htm'
import { clipEnd, round } from '/core/project.js'
import { edit, set, time, toast, useStore, useTime, viewProject } from '../store.js'
import { layerSize } from './layer-box.js'
import { PRESETS, presetOps, TEXT_ANIMATORS } from './presets.js'
import { ms, mset } from './state.js'

const html = htm.bind(h)

const ART = { pop: '◉', slideUp: '⇡', typewriter: 'A_', bounce: '⤓', spin: '↻', wipe: '▧', drawOn: '✎' }

export function applyPreset(view, c, id) {
  const t = Math.min(clipEnd(c), Math.max(c.start, time.t))
  try {
    const size = layerSize(view, c, t)
    const { ops, note } = presetOps(view, c, id, t, { layerW: size.w, layerH: size.h, height: view.height })
    edit(ops, `${PRESETS.find(x => x.id === id)?.label ?? id} on ${c.label ?? c.id}`).then(res => res && note && toast(note))
    mset({ open: { ...ms().open, [c.id]: true }, reveal: { animated: true } })
  } catch (error) {
    toast(error.message, 'error')
  }
}

/** The presets panel for one clip (the inspector passes it; the Motion page uses the selection). */
export function PresetsSection({ clip }) {
  const s = useStore()
  const t = useTime()
  const view = viewProject()
  const c = clip ?? view?.tracks.flatMap(tr => tr.clips).find(x => x.id === s.selection[0])
  if (!view || !c) return html`<div class="hint pad">Select a layer to apply a preset. Presets start at the playhead.</div>`
  const local = round(Math.min(c.dur, Math.max(0, t - c.start)), 2)
  const animated = Object.keys(c.anim ?? {})
  const exprs = Object.entries(c.expr ?? {})

  return html`
    <div class="mo-presets">
      <div class="hint">Presets write keyframes on <b>${c.label ?? c.id}</b> starting at the playhead (${local} s into the layer).</div>
      <div class="mo-preset-grid">
        ${PRESETS.map(pr => {
          const fits = pr.id === 'typewriter' ? c.kind === 'title' : pr.id === 'drawOn' ? c.kind === 'shape' : c.kind !== 'null' || ['pop', 'slideUp', 'bounce', 'spin'].includes(pr.id)

          return html`<button class="mo-preset" disabled=${!fits} title=${fits ? pr.hint : `${pr.hint} (not for this layer)`} onClick=${() => applyPreset(view, c, pr.id)}><span class="mo-preset-art">${ART[pr.id]}</span>${pr.label}</button>`
        })}
      </div>
      ${c.kind === 'title' ? html`
        <h4>Text animators</h4>
        <div class="hint">Typewriter and Tracking act per character; the others move the whole line. Per-character transforms need renderer support (see the Motion page notes).</div>
        <div class="mo-anim-grid">
          ${TEXT_ANIMATORS.map(a => html`<button class=${`tiny ${(c.title?.anim ?? 'none') === a.anim ? 'on' : ''}`} title=${a.hint} onClick=${() => edit({ op: 'update', id: c.id, set: { title: { anim: a.anim } } }, `text animator ${a.label}`)}>${a.label}${a.perChar ? ' ·' : ''}</button>`)}
        </div>` : null}
      <h4>Animated</h4>
      ${animated.length ? html`<div class="mo-anim-list">${animated.map(prop => html`<div class="kv"><span>${prop}</span><b>${c.anim[prop].length} key${c.anim[prop].length > 1 ? 's' : ''}</b></div>`)}</div>` : html`<div class="hint">No keyframes yet.</div>`}
      ${exprs.length ? html`<h4>Expressions</h4>${exprs.map(([prop, src]) => html`<div class="kv"><span>${prop}</span><code>${src}</code></div>`)}` : null}
      ${s.page !== 'motion' ? html`<button class="ghost tiny" onClick=${() => set({ page: 'motion' })}>Open the Motion page</button>` : null}
    </div>
  `
}
