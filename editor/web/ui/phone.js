import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { set, useStore, viewProject } from './store.js'

const html = htm.bind(h)

// Portrait phones match the existing 720 px breakpoint in styles.css. Landscape phones are
// wider than that but too short for the desktop grid, which leaves the picture no height.
export const PHONE_QUERY = '(max-width: 720px), (max-height: 500px) and (max-width: 1000px)'

export function usePhoneLayout(beforeChange) {
  const callback = useRef(beforeChange)
  callback.current = beforeChange
  const query = () => (typeof matchMedia === 'function' ? matchMedia(PHONE_QUERY) : null)
  const [phone, setPhone] = useState(() => query()?.matches ?? false)
  useEffect(() => {
    const q = query()
    if (!q) return
    const update = () => { callback.current?.(q.matches); setPhone(q.matches) }
    update()
    q.addEventListener('change', update)
    return () => q.removeEventListener('change', update)
  }, [])
  return phone
}

const PANELS = [['timeline', 'Timeline'], ['media', 'Media'], ['inspector', 'Inspector']]

// The same name the timeline draws on the clip (timeline.js clip label). A `tr:` id is the
// transition at the start of that clip.
export function selectionName(project, id) {
  if (!project || !id) return null
  const transition = id.startsWith('tr:')
  const clipId = transition ? id.slice(3) : id
  const c = (project.tracks ?? []).flatMap(t => t.clips).find(x => x.id === clipId)
  if (!c) return null
  const label = c.label ?? (c.kind === 'title' ? c.title?.text : c.kind === 'color' ? 'Color' : c.kind === 'adjustment' ? 'Adjustment' : String(c.src ?? '').split('/').pop())
  const name = label || c.kind || 'Clip'
  return transition ? `Transition into ${name}` : name
}

export function PhonePanelControls({ panel, setPanel, previewOpen = false, setPreviewOpen }) {
  const s = useStore()
  const selected = s.selection.length ? selectionName(viewProject(), s.selection[0]) : null
  const more = s.selection.length > 1 ? ` and ${s.selection.length - 1} more` : ''
  const keys = event => {
    const index = PANELS.findIndex(([id]) => id === panel)
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = PANELS[(index + step + PANELS.length) % PANELS.length][0]
    setPanel(next)
    event.currentTarget.querySelector(`[data-panel="${next}"]`)?.focus()
  }

  return html`
    <div class="phone-controls">
      <div class="phone-switch" role="tablist" aria-label="Edit panel" onKeyDown=${keys}>
        ${PANELS.map(([id, label]) => html`<button role="tab" data-panel=${id} id=${`phone-tab-${id}`} aria-controls=${`edit-panel-${id}`} aria-selected=${panel === id} tabIndex=${panel === id ? 0 : -1} class=${panel === id ? 'on' : ''} onClick=${() => setPanel(id)}>${label}</button>`)}
      </div>
      ${panel === 'inspector' ? html`<button class="phone-preview-toggle ghost" aria-controls="edit-viewer" aria-expanded=${previewOpen} onClick=${() => setPreviewOpen(!previewOpen)}>${previewOpen ? 'Focus Inspector' : 'Show preview'}</button>` : null}
      ${selected && panel !== 'inspector' ? html`<div class="phone-readout" role="status">
        <span class="muted">Selected</span><b>${selected}${more}</b>
        <button class="ghost tiny" onClick=${() => setPanel('inspector')}>Properties</button>
      </div>` : null}
    </div>
  `
}


export function compactPanelToPhone(panel) { return panel === 'viewer' ? 'timeline' : panel }
export function phonePanelToCompact(panel) { return panel === 'timeline' ? 'viewer' : ['media', 'inspector'].includes(panel) ? panel : null }

// Plugin pages render through this gate. Motion lays out compositions, the inspector and a
// layer table side by side and has no stacked arrangement, so at phone widths it says what
// it needs instead of clipping. Every other page renders unchanged.
const NEEDS_WIDTH = new Set(['motion'])

export function PhoneGate({ page }) {
  const phone = usePhoneLayout()
  return phone && NEEDS_WIDTH.has(page.id) ? html`<${PhoneWideNotice} name=${page.label} />` : h(page.component, {})
}

export function PhoneWideNotice({ name }) {
  return html`
    <div class="page phone-wide-notice">
      <div class="phone-wide-card">
        <h2>${name} needs a wider window</h2>
        <p>${name} shows its compositions, properties and layers side by side. Use a tablet in landscape, a laptop or a desktop window at least 900 pixels wide.</p>
        <p class="muted">Edit, Media, Color, Audio and Deliver work at this width.</p>
        <button class="primary" onClick=${() => set({ page: 'edit' })}>Back to Edit</button>
      </div>
    </div>
  `
}
