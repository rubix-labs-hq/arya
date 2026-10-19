import { h } from 'preact'
import { useEffect, useReducer, useRef, useState } from 'preact/hooks'
import htm from 'htm'

const html = htm.bind(h)
// v2 stores null for a pane width that follows the window. v1 stored every width as a number.
const key = 'reel.workspace.v2', legacyKey = 'reel.workspace.v1'
const WIDTHS = ['media', 'inspector', 'chat']
const defaults = { media: null, inspector: null, chat: null, upper: 52, showMedia: true, showInspector: true, showTimeline: true, mediaSide: 'left' }
const listeners = new Set()
let compactEditPanel = 'viewer'
function valid(input = {}) {
  const next = { ...defaults }
  for (const name of WIDTHS) if (Number.isFinite(input[name])) next[name] = Math.max(160, Math.min(700, input[name]))
  if (Number.isFinite(input.upper)) next.upper = Math.max(20, Math.min(80, input.upper))
  for (const name of ['showMedia', 'showInspector', 'showTimeline']) if (typeof input[name] === 'boolean') next[name] = input[name]
  if (input.mediaSide === 'right') next.mediaSide = 'right'
  return next
}
// A v1 layout saved the old fixed defaults (260, 300, 360) for panes nobody resized. Read once,
// those become null so they grow with the window; any other width stays as the user set it.
const LEGACY_DEFAULTS = { media: 260, inspector: 300, chat: 360 }
export function migrateLegacyLayout(input = {}) {
  const out = { ...input }
  for (const name of WIDTHS) if (out[name] === LEGACY_DEFAULTS[name]) out[name] = null
  return out
}
function load() {
  try {
    const current = localStorage.getItem(key)
    if (current != null) return valid(JSON.parse(current))
    return valid(migrateLegacyLayout(JSON.parse(localStorage.getItem(legacyKey) || '{}')))
  } catch { return { ...defaults } }
}
let layout = load()

// Default panel widths grow with the window: these are the widths at 1440, 1920 and 2560 pixels.
const GROW = { media: [260, 320, 360], inspector: [300, 360, 400], chat: [360, 400, 440] }
const viewportWidth = () => (typeof innerWidth === 'number' && innerWidth > 0 ? innerWidth : 1440)
export function defaultWidth(name, viewport = viewportWidth()) {
  const [narrow, wide, widest] = GROW[name], w = Number.isFinite(viewport) ? viewport : 1440
  if (w <= 1440) return narrow
  if (w <= 1920) return Math.round(narrow + (wide - narrow) * (w - 1440) / 480)
  return Math.round(wide + (widest - wide) * Math.min(1, (w - 1920) / 640))
}
/** The widths the window shows: a null width follows the window, a number is the user's own. */
export function effectiveLayout(value, viewport = viewportWidth()) {
  const out = { ...value }
  for (const name of WIDTHS) if (value[name] == null) out[name] = defaultWidth(name, viewport)
  return out
}
// Re-render layout users when the window crosses into a different set of default widths.
let defaultKey = WIDTHS.map(name => defaultWidth(name)).join()
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', () => {
    const next = WIDTHS.map(name => defaultWidth(name)).join()
    if (next === defaultKey) return
    defaultKey = next
    for (const fn of listeners) fn()
  })
}
// A resize also budgets the neighbouring pane. When that neighbour follows the window and the
// resize left it unchanged, keep it following the window instead of saving its current width.
export function keepDefaults(patch, field, saved, shown) {
  const out = { ...patch }
  for (const name of Object.keys(out)) if (name !== field && WIDTHS.includes(name) && saved[name] == null && out[name] === shown[name]) delete out[name]
  return out
}
export function useLayout() {
  const [, update] = useReducer(x => x + 1, 0)
  useEffect(() => { listeners.add(update); return () => listeners.delete(update) }, [])
  return effectiveLayout(layout)
}
function save(patch) {
  layout = valid({ ...layout, ...patch })
  try { localStorage.setItem(key, JSON.stringify(layout)) } catch {}
  for (const fn of listeners) fn()
}
function chooseCompactEditPanel(panel) {
  if (!['viewer', 'media', 'inspector'].includes(panel) || panel === compactEditPanel) return
  compactEditPanel = panel
  for (const fn of listeners) fn()
}

// Compact access does not overwrite the saved desktop layout.
export function useCompactEditPanel() {
  useLayout()
  return [compactEditPanel, chooseCompactEditPanel]
}

export function revealMedia() { chooseCompactEditPanel('media'); save({ showMedia: true }) }

export function revealInspector() { chooseCompactEditPanel('inspector'); save({ showInspector: true }) }

export function layoutStyle(value) {
  return { '--media-width': `${value.media}px`, '--inspector-width': `${value.inspector}px`, '--chat-width': `${value.chat}px`, '--upper-height': `${value.upper}%` }
}

// Budget the actual Edit workspace, including the Assistant column, without
// overwriting the user's preferred widths when the window becomes narrower.
export function editPaneSizes(value, width) {
  const l = effectiveLayout(valid(value)), panels = ['media', 'inspector'].filter(name => name === 'media' ? l.showMedia : l.showInspector)
  const available = Number.isFinite(width) ? Math.max(0, width) : 960
  const minimum = 160, dividers = panels.length * 6
  const canvas = Math.max(available, minimum * (panels.length + 1) + dividers)
  const content = canvas - dividers
  const viewer = Math.min(320, Math.max(minimum, canvas * .36), content - minimum * panels.length)
  const budget = content - viewer, desired = panels.reduce((total, name) => total + l[name], 0)
  const extra = desired - minimum * panels.length
  const ratio = desired > budget && extra > 0 ? (budget - minimum * panels.length) / extra : 1
  const sizes = { media: 0, inspector: 0, viewer: content, viewerMinimum: viewer, width: canvas }
  for (const name of panels) {
    sizes[name] = minimum + (l[name] - minimum) * ratio
    sizes.viewer -= sizes[name]
  }
  return sizes
}

export function editPaneResizePatch(value, width, field, target) {
  const l = effectiveLayout(valid({ ...value, [field]: target })), sizes = editPaneSizes(value, width)
  const other = field === 'media' ? 'inspector' : 'media'
  const count = Number(sizes.media > 0) + Number(sizes.inspector > 0)
  const budget = sizes.width - count * 6 - sizes.viewerMinimum
  const patch = { [field]: Math.min(l[field], budget - (sizes[other] ? 160 : 0)) }
  if (sizes[other]) patch[other] = Math.min(sizes[other], budget - patch[field])
  return patch
}

export function editGridColumns(value, width) {
  const sizes = editPaneSizes(value, width), left = value.mediaSide === 'right' ? 'inspector' : 'media'
  const right = left === 'media' ? 'inspector' : 'media'
  return `${sizes[left] ? `${sizes[left]}px 6px ` : ''}minmax(160px, 1fr)${sizes[right] ? ` 6px ${sizes[right]}px` : ''}`
}

export function useWorkspaceWidth() {
  const ref = useRef(null), [width, setWidth] = useState(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setWidth(element.clientWidth)
    const observer = new ResizeObserver(measure)
    observer.observe(element); measure()
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

function workspaceHeight(area) {
  const style = area && typeof getComputedStyle === 'function' ? getComputedStyle(area) : null
  const padding = (parseFloat(style?.paddingTop) || 0) + (parseFloat(style?.paddingBottom) || 0)
  return Math.max(0, (area?.clientHeight || 0) - padding)
}

function visibleUpperPercent(area, fallback) {
  const panel = area?.querySelector('.upper, .audio-top, .color-top'), height = workspaceHeight(area)
  return panel && height > 0 ? panel.clientHeight / height * 100 : fallback
}

function visibleChatWidth(app, fallback) {
  const width = app?.querySelector('.chat')?.getBoundingClientRect?.().width
  return Number.isFinite(width) && width > 0 ? width : fallback
}

export function Divider({ field, axis = 'horizontal', label, reverse = false, size }) {
  const l = useLayout()
  const horizontal = axis === 'horizontal'
  const adjust = (delta, handle) => {
    const upper = handle.closest('.upper')
    const shown = effectiveLayout(layout)
    if (upper && ['media', 'inspector'].includes(field)) {
      const actual = editPaneSizes(shown, upper.clientWidth)[field]
      save(keepDefaults(editPaneResizePatch(shown, upper.clientWidth, field, actual + delta), field, layout, shown))
    } else {
      const actual = field === 'upper' ? visibleUpperPercent(handle.closest('.page'), shown[field])
        : field === 'chat' ? visibleChatWidth(handle.closest('.app'), shown[field]) : shown[field]
      save({ [field]: actual + delta })
    }
  }
  const drag = e => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget, origin = horizontal ? e.clientX : e.clientY
    const app = handle.closest('.app'), area = handle.closest('.page'), upper = handle.closest('.upper')
    // `preferred` is the saved value, restored on cancel; `shown` is what the window displays.
    const preferred = layout[field], shown = effectiveLayout(layout)
    const initial = upper && ['media', 'inspector'].includes(field) ? editPaneSizes(shown, upper.clientWidth)[field]
      : field === 'upper' ? visibleUpperPercent(area, shown[field])
        : field === 'chat' ? visibleChatWidth(app, shown[field]) : shown[field]
    const height = workspaceHeight(area) || 1
    let pending = initial, patch = { [field]: preferred }, raf = 0, moved = false
    handle.setPointerCapture(e.pointerId)
    const paint = () => {
      raf = 0
      const property = field === 'upper' ? '--upper-height' : `--${field}-width`
      const value = effectiveLayout({ ...layout, ...patch })[field]
      app?.style.setProperty(property, `${value}${field === 'upper' ? '%' : 'px'}`)
      if (upper && ['media', 'inspector'].includes(field)) {
        const current = effectiveLayout({ ...layout, ...patch })
        for (const name of ['media', 'inspector']) app?.style.setProperty(`--${name}-width`, `${current[name]}px`)
        upper.style.gridTemplateColumns = editGridColumns(current, upper.clientWidth)
      }
    }
    const move = event => {
      const pixels = ((horizontal ? event.clientX : event.clientY) - origin) * (reverse ? -1 : 1)
      moved = pixels !== 0
      pending = field === 'upper' ? Math.max(20, Math.min(80, initial + pixels / height * 100)) : Math.max(160, Math.min(700, initial + pixels))
      patch = upper && ['media', 'inspector'].includes(field) ? editPaneResizePatch(shown, upper.clientWidth, field, pending) : { [field]: pending }
      if (!raf) raf = requestAnimationFrame(paint)
    }
    const finish = event => {
      if (raf) cancelAnimationFrame(raf)
      if (!moved || event.type !== 'pointerup') patch = { [field]: preferred }
      paint()
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', finish)
      handle.removeEventListener('lostpointercapture', finish)
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId)
      save(keepDefaults(patch, field, layout, shown))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
    handle.addEventListener('lostpointercapture', finish)
  }
  return html`<div class=${`workspace-divider ${horizontal ? 'vertical' : 'horizontal'} divider-${field}`} role="separator" tabIndex="0" aria-label=${label} aria-orientation=${horizontal ? 'vertical' : 'horizontal'} aria-valuenow=${Math.round(size ?? l[field])} aria-valuemin=${field === 'upper' ? 20 : 160} aria-valuemax=${field === 'upper' ? 80 : 700} onPointerDown=${drag} onDblClick=${() => save({ [field]: defaults[field] })} onKeyDown=${e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    adjust((['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1) * (reverse ? -1 : 1) * (field === 'upper' ? 2 : 16), e.currentTarget)
  }} />`
}

export function LayoutMenu() {
  const l = useLayout()
  const [open, setOpen] = useState(false)
  return html`<div class="workspace-layout-menu"><button class="ghost" aria-label="Customize workspace" onClick=${() => setOpen(!open)}>Layout</button>
    ${open ? html`<div class="workspace-options" role="dialog" aria-label="Workspace layout">
      <p class="hint compact-layout-note">Compact Edit keeps Viewer, Media, Inspector and the timeline available. The layout settings below apply to wider workspaces.</p>
      <div class="row gap"><button onClick=${() => save(defaults)}>Default</button><button onClick=${() => save({ ...defaults, upper: 65, showMedia: false, showInspector: false })}>Review</button><button onClick=${() => save({ ...defaults, upper: 40, media: 200, inspector: 280 })}>Editing</button></div>
      ${[['showMedia', 'Media bin'], ['showInspector', 'Inspector'], ['showTimeline', 'Timeline']].map(([field, label]) => html`<label><input type="checkbox" checked=${l[field]} onChange=${e => save({ [field]: e.target.checked })} /> ${label}</label>`)}
      <label>Media position <select value=${l.mediaSide} onChange=${e => save({ mediaSide: e.target.value })}><option value="left">Left</option><option value="right">Right</option></select></label>
      <p class="hint desktop-layout-note">Drag a divider to resize. Arrow keys resize a focused divider. Double-click a divider to reset it. This layout is saved on this device.</p>
      <button onClick=${() => setOpen(false)}>Done</button>
    </div>` : null}
  </div>`
}
