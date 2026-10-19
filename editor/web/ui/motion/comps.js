// Composition panel: list, create (size presets, rate, length, background), edit
// settings, duplicate, rename, delete (refused while placed), open, place on the main
// timeline or nest in the open composition, and precompose the selected layers.

import { h } from 'preact'
import { useState } from 'preact/hooks'
import htm from 'htm'
import { clipEnd, compDuration, duration, round } from '/core/project.js'
import { openMenu } from '../menu.js'
import { edit, set, store, time, toast, useStore, viewProject } from '../store.js'
import { openComposition } from '../timeline.js'
import { compUsers, duplicateCompOps, inView, layerTrack } from './ops.js'

const html = htm.bind(h)

export const SIZE_PRESETS = [
  ['HD 1080p', 1920, 1080],
  ['4K UHD', 3840, 2160],
  ['HD 720p', 1280, 720],
  ['Vertical 9:16', 1080, 1920],
  ['Square 1:1', 1080, 1080],
  ['Portrait 4:5', 1080, 1350],
  ['Cinema 2.39:1', 2048, 858],
]
const RATES = [23.976, 24, 25, 29.97, 30, 50, 60]

function CompForm({ initial, onDone }) {
  const p = store.project
  const [f, setF] = useState(initial ?? { name: `Comp ${Object.keys(p.comps ?? {}).length + 1}`, width: p.width, height: p.height, fps: p.fps, duration: 5, background: 'transparent' })
  const up = patch => setF({ ...f, ...patch })
  const preset = SIZE_PRESETS.find(([, w, hh]) => w === f.width && hh === f.height)?.[0] ?? 'Custom'
  const transparent = f.background === 'transparent'
  const submit = async e => {
    e.preventDefault()
    const body = { name: f.name.trim() || 'Comp', width: Math.max(16, Math.round(f.width)), height: Math.max(16, Math.round(f.height)), fps: Number(f.fps), duration: Math.max(1 / Number(f.fps), Number(f.duration)), background: f.background }
    if (initial?.id) await edit({ op: 'update_comp', target: initial.id, set: body }, `composition settings ${body.name}`)
    else {
      const res = await edit({ op: 'add_comp', ...body }, `new composition ${body.name}`)
      const id = res?.created?.[0]
      if (id) openComposition(id)
    }
    onDone()
  }
  const stop = e => e.stopPropagation()

  return html`
    <form class="mo-form" onSubmit=${submit} onKeyDown=${stop}>
      <div class="field"><label>Name</label><input value=${f.name} onInput=${e => up({ name: e.target.value })} autofocus /></div>
      <div class="field"><label>Size</label>
        <select value=${preset} onChange=${e => {
          const pr = SIZE_PRESETS.find(x => x[0] === e.target.value)
          if (pr) up({ width: pr[1], height: pr[2] })
        }}>${SIZE_PRESETS.map(([n]) => html`<option value=${n}>${n}</option>`)}<option value="Custom">Custom</option></select>
      </div>
      <div class="field"><label>Width × height</label><input type="number" aria-label="Width" value=${f.width} onInput=${e => up({ width: Number(e.target.value) })} /><span class="muted">×</span><input type="number" aria-label="Height" value=${f.height} onInput=${e => up({ height: Number(e.target.value) })} /></div>
      <div class="field"><label>Frame rate</label><select value=${f.fps} onChange=${e => up({ fps: Number(e.target.value) })}>${RATES.map(r => html`<option value=${r}>${r} fps</option>`)}</select></div>
      <div class="field"><label>Duration</label><input type="number" step="0.1" min="0.1" value=${f.duration} onInput=${e => up({ duration: Number(e.target.value) })} /><span class="muted">s</span></div>
      <div class="field"><label>Background</label>
        <label class="mt-check"><input type="checkbox" checked=${transparent} onChange=${e => up({ background: e.target.checked ? 'transparent' : '#000000' })} /> Transparent</label>
        ${transparent ? null : html`<input type="color" aria-label="Composition background color" value=${f.background} onInput=${e => up({ background: e.target.value })} />`}
      </div>
      <div class="row gap"><span class="grow"></span><button type="button" class="ghost" onClick=${onDone}>Cancel</button><button type="submit" class="primary">${initial?.id ? 'Save' : 'Create'}</button></div>
    </form>
  `
}

/** Puts composition `id` on the main timeline: at the playhead on a free video track, else after everything. */
async function placeOnMain(id) {
  const p = store.project
  const comp = p.comps[id]
  const dur = compDuration(comp)
  // The playhead belongs to the open composition when one is open; the main timeline's own
  // playhead is the one the user last left there.
  const at = store.openComp ? (store.motionMainT ?? 0) : time.t
  const video = p.tracks.filter(t => t.kind === 'video' && !t.locked)
  const free = [...video].reverse().find(t => !t.clips.some(c => c.start < at + dur - 1e-6 && clipEnd(c) > at + 1e-6))
  const track = free ?? video.at(-1)
  const start = free ? at : duration(p)
  if (!track) return toast('The main timeline has no unlocked video track', 'error')
  const res = await edit({ op: 'comp_clip', target: id, track: track.id, start }, `place ${comp.name} on the main timeline`)
  if (res) toast(`Placed "${comp.name}" on ${track.id} at ${round(start, 2)} s of the main timeline`)
}

/** Nests composition `id` as a new top layer of the open composition. */
async function nestInOpen(id) {
  const view = viewProject()
  if (!view.compId) return
  const { ops, track } = layerTrack(view, 0, compDuration(store.project.comps[id]))
  const res = await edit([...ops, inView(view, { op: 'comp_clip', target: id, track, start: 0 })], `nest ${store.project.comps[id].name}`)
  const made = res?.created?.filter(x => /^c\d+$/.test(x)).at(-1)
  if (made) set({ selection: [made] })
}

async function duplicate(id) {
  const p = store.project
  const { ops } = duplicateCompOps(p, id, `${p.comps[id].name} copy`)
  await edit(ops, `duplicate composition ${p.comps[id].name}`)
}

export function CompList() {
  const s = useStore()
  const p = s.project
  const [form, setForm] = useState(null) // null | 'new' | comp
  const [renaming, setRenaming] = useState(null)
  const [pre, setPre] = useState(null) // precompose name
  if (!p) return null
  const comps = Object.values(p.comps ?? {})
  const view = viewProject()
  const layerSel = s.selection.filter(id => view.tracks.some(t => t.clips.some(c => c.id === id)))

  const menu = (e, k) => {
    const users = compUsers(p, k.id)
    openMenu(e.clientX, e.clientY, [
      { label: 'Open', run: () => openComposition(k.id) },
      { label: 'Place on main timeline', run: () => placeOnMain(k.id) },
      { label: 'Nest in open composition', disabled: !s.openComp || s.openComp === k.id, run: () => nestInOpen(k.id) },
      { sep: true },
      { label: 'Composition settings…', run: () => setForm({ id: k.id, name: k.name, width: k.width, height: k.height, fps: k.fps, duration: compDuration(k), background: k.background ?? 'transparent' }) },
      { label: 'Rename', run: () => setRenaming(k.id) },
      { label: 'Duplicate', run: () => duplicate(k.id) },
      { sep: true },
      { label: users.length ? `Delete (used by ${users.map(c => c.id).join(', ')})` : 'Delete', danger: true, disabled: users.length > 0, run: () => remove(k) },
    ])
  }
  const remove = async k => {
    const res = await edit({ op: 'delete_comp', target: k.id }, `delete composition ${k.name}`)
    if (res && s.openComp === k.id) set({ openComp: null, selection: [] })
  }

  return html`
    <div class="mo-comps">
      <div class="row gap mo-comps-bar">
        <button class="primary tiny" onClick=${() => setForm('new')}>＋ New composition</button>
        <span class="grow"></span>
      </div>
      ${form ? html`<${CompForm} initial=${form === 'new' ? null : form} onDone=${() => setForm(null)} />` : null}
      <div class=${`mo-comp ${!s.openComp ? 'open' : ''}`} onClick=${() => set({ openComp: null, selection: [] })}>
        <span class="mo-comp-icon">▤</span>
        <div class="mo-comp-text"><b>Main timeline</b><span class="muted small">${p.width}×${p.height} · ${p.fps} fps · ${round(duration(p), 2)} s</span></div>
      </div>
      ${comps.length === 0 ? html`<div class="hint">No compositions yet. A composition is a timeline of its own you can animate and place anywhere.</div>` : null}
      ${comps.map(k => {
        const users = compUsers(p, k.id)
        const layers = k.tracks.flatMap(t => t.clips).length

        return html`
          <div class=${`mo-comp ${s.openComp === k.id ? 'open' : ''}`} data-comp=${k.id} onDblClick=${() => openComposition(k.id)} onContextMenu=${e => (e.preventDefault(), menu(e, k))}>
            <span class="mo-comp-icon">⧉</span>
            <div class="mo-comp-text">
              ${renaming === k.id
                ? html`<input class="mt-rename" value=${k.name} autofocus onKeyDown=${e => {
                    e.stopPropagation()
                    if (e.key === 'Enter') e.target.blur()
                    if (e.key === 'Escape') setRenaming(null)
                  }} onBlur=${e => {
                    setRenaming(null)
                    if (e.target.value.trim() && e.target.value !== k.name) edit({ op: 'update_comp', target: k.id, set: { name: e.target.value.trim() } }, 'rename composition')
                  }} />`
                : html`<b title="Double-click to open">${k.name}</b>`}
              <span class="muted small">${k.width}×${k.height} · ${k.fps} fps · ${round(compDuration(k))} s · ${layers} layer${layers === 1 ? '' : 's'}${users.length ? ` · placed ${users.length}×` : ''}</span>
            </div>
            <button class="ghost tiny" title="Open in the viewer and timeline" onClick=${e => (e.stopPropagation(), openComposition(k.id))}>Open</button>
            <button class="ghost tiny" title="More" onClick=${e => (e.stopPropagation(), menu(e, k))}>⋯</button>
          </div>
        `
      })}
      <div class="mo-pre">
        ${pre === null
          ? html`<button class="ghost tiny" disabled=${!layerSel.length} title="Move the selected layers into a new composition" onClick=${() => setPre('Precomp')}>Precompose ${layerSel.length || ''} selected…</button>`
          : html`<form class="row gap" onSubmit=${async e => {
              e.preventDefault()
              const res = await edit({ op: 'precompose', ids: layerSel, name: pre || 'Precomp' }, `precompose ${layerSel.join(', ')}`)
              setPre(null)
              const clip = res?.created?.find(x => /^c\d+$/.test(x))
              if (clip) set({ selection: [clip] })
            }}><input value=${pre} autofocus onInput=${e => setPre(e.target.value)} onKeyDown=${e => e.stopPropagation()} /><button class="primary tiny" type="submit">Precompose</button><button class="ghost tiny" type="button" onClick=${() => setPre(null)}>✕</button></form>`}
      </div>
    </div>
  `
}

export { placeOnMain, nestInOpen }
