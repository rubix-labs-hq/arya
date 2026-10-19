import { h } from 'preact'
import htm from 'htm'
import { duration } from '/core/project.js'
import { set, useStore, viewProject } from './store.js'
import { registry } from './registry.js'
import { Icon, hasIcon } from './icons.js'

const html = htm.bind(h)

const TOOLS = [
  ['select', 'select', 'Select (A)'],
  ['trim', 'trim', 'Trim: ripple edges, roll edit points, slip bodies, ⌥ slide (T)'],
  ['blade', 'blade', 'Blade (B)'],
  ['slip', 'slip', 'Slip (Y)'],
  ['slide', 'slide', 'Slide (U)'],
  ['hand', 'hand', 'Hand (H)'],
]

// Plugin tools register a text glyph. Known tool ids get the matching drawn icon;
// any other plugin tool keeps its own glyph.
const PLUGIN_ICONS = { 'm-shape': 'shape', 'm-pen': 'pen', 'm-mask': 'mask', 'm-anchor': 'anchor', track: 'track' }

function toolIcon(id, icon) {
  const name = PLUGIN_ICONS[id] ?? icon
  return hasIcon(name) ? html`<${Icon} name=${name} />` : icon
}

/** Short name and shortcut for the tool readout: "Trim: ripple edges… (T)" gives Trim and T. */
export function toolNameAndKey(title) {
  const [, text, key = ''] = title.match(/^(.*?)(?: \(([^)]*)\))?$/)
  const [shortcut = '', ...where] = key.split(' ')
  return { name: text.split(':')[0].trim(), shortcut, where: where.join(' ') }
}

// While the pointer or keyboard focus is on a tool, a preview names that tool over the active
// one. The preview is hidden from assistive technology, so hovering announces nothing; the
// status text only changes when the tool does. Its data attributes are outside Preact's control.
function previewTool(event, title) {
  const readout = event?.currentTarget?.closest?.('.tl-toolbar')?.querySelector('.tool-preview')
  if (!readout) return
  if (!title) {
    delete readout.dataset.previewName
    delete readout.dataset.previewKey
    return
  }
  const { name, shortcut } = toolNameAndKey(title)
  readout.dataset.previewName = name
  if (shortcut) readout.dataset.previewKey = shortcut
  else delete readout.dataset.previewKey
}

function ToolButton({ id, icon, title, active }) {
  return html`<button class=${active ? 'on' : ''} aria-label=${title.replace(/ \([^)]*\)$/, '')} aria-pressed=${active} title=${title}
    onClick=${e => { previewTool(e); set({ tool: id }) }}
    onPointerEnter=${e => previewTool(e, title)} onPointerLeave=${e => previewTool(e)}
    onFocus=${e => previewTool(e, title)} onBlur=${e => previewTool(e)}>${toolIcon(id, icon)}</button>`
}

function Breadcrumb() {
  const s = useStore()
  if (!s.openComp || !s.project?.comps?.[s.openComp]) return null
  const chain = []
  for (let id = s.openComp, n = 0; id && n < 16; n++) {
    chain.unshift(id)
    id = s.compParents?.[id] ?? null
  }

  return html`
    <div class="crumbs comp-crumbs">
      <button class="ghost tiny" title="Back to the main timeline" onClick=${() => set({ openComp: null, selection: [] })}>Main</button>
      ${chain.map(id => html`<span class="sep">›</span><button class=${`ghost tiny ${id === s.openComp ? 'on' : ''}`} onClick=${() => set({ openComp: id, selection: [] })}>${s.project.comps[id]?.name ?? id}</button>`)}
    </div>
  `
}

export function Toolbar() {
  const s = useStore()
  const plugins = registry.tools.map(tl => [tl.id, tl.icon, `${tl.label}${tl.key ? ` (${tl.key})` : ''}`])
  const active = [...TOOLS, ...plugins].find(([k]) => k === s.tool)
  const current = active ? toolNameAndKey(active[2]) : null
  const group = (tools, label) => html`<div class="seg tools" role="group" aria-label=${label}>${tools.map(([k, icon, title]) => html`<${ToolButton} key=${k} id=${k} icon=${icon} title=${title} active=${s.tool === k} />`)}</div>`

  return html`
    <div class="tl-toolbar">
      <${Breadcrumb} />
      ${group(TOOLS, 'Edit tools')}
      ${plugins.length ? group(plugins, 'Drawing and tracking tools') : null}
      <span class="tool-readout" title=${active?.[2] ?? ''}><span class="tool-current" role="status">${current ? html`<span class="tool-name">${current.name}</span>${current.shortcut ? html`<kbd>${current.shortcut}</kbd>` : null}${current.where ? html`<span class="tool-where">${current.where}</span>` : null}` : null}</span><span class="tool-preview" aria-hidden="true"></span></span>
      <span class="tl-toolbar-sep" aria-hidden="true"></span>
      <button class=${`ghost ${s.snapping ? 'on' : ''}`} aria-label="Snapping" aria-pressed=${!!s.snapping} title="Snapping (N)" onClick=${() => set({ snapping: !s.snapping })}><${Icon} name="magnet" /></button>
      <button class=${`ghost ${s.linked ? 'on' : ''}`} aria-label="Linked selection" aria-pressed=${!!s.linked} title="Linked selection" onClick=${() => set({ linked: !s.linked })}><${Icon} name="link" /></button>
      <span class="grow"></span>
      <span class="muted small">${s.selection.length ? `${s.selection.length} selected` : ''}</span>
      <button class="ghost" aria-label="Zoom out" title="Zoom out (⌘-)" onClick=${() => set({ zoom: Math.max(0.5, s.zoom / 1.5) })}><${Icon} name="minus" /></button>
      <input aria-label="Timeline zoom" type="range" min="0" max="100" value=${Math.log(s.zoom / 0.5) / Math.log(4800) * 100} onInput=${e => set({ zoom: 0.5 * 4800 ** (Number(e.target.value) / 100) })} />
      <button class="ghost" aria-label="Zoom in" title="Zoom in (⌘=)" onClick=${() => set({ zoom: Math.min(2400, s.zoom * 1.5) })}><${Icon} name="plus" /></button>
      <button class="ghost" aria-label="Fit timeline" title="Zoom to fit (⇧Z)" onClick=${() => set({ zoom: Math.max(0.5, (document.querySelector('.tl-canvas')?.clientWidth ?? 1000) / Math.max(1, duration(viewProject()) * 1.05)), scroll: 0 })}><${Icon} name="fit" /></button>
    </div>
  `
}
