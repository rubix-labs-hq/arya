// Motion: an After Effects style page for compositions. It registers the page, the
// viewer tools and their overlay, a Motion inspector tab (presets, text animators),
// a Compositions tab in the media browser and a clip menu entry. The code lives in
// web/ui/motion/.

import { h } from 'preact'
import { onTime, set, store } from '../store.js'
import { registerBrowserTab, registerClipMenu, registerInspector, registerPage, registerTool, registerViewerOverlay } from '../registry.js'
import { CompList } from '../motion/comps.js'
import { MotionOverlay, overlayActive } from '../motion/overlay.js'
import { MotionPage } from '../motion/page.js'
import { PresetsSection } from '../motion/presets-ui.js'
import { installMotionKeys } from '../motion/shortcuts.js'
import { openComposition } from '../timeline.js'

// The page's stylesheet (index.html only links styles.css).
const css = document.createElement('link')
css.rel = 'stylesheet'
css.href = new URL('../motion/motion.css', import.meta.url).href
document.head.appendChild(css)

registerPage({ id: 'motion', label: 'Motion', key: '⇧3', order: 30, component: MotionPage })

registerTool({ id: 'm-shape', label: 'Shape tool: rectangle, ellipse, polygon, star', icon: '▭', key: 'Q on the Motion page', order: 60 })
registerTool({ id: 'm-pen', label: 'Pen tool', icon: '✎', key: 'G on the Motion page', order: 61 })
registerTool({ id: 'm-mask', label: 'Mask tool: draw a mask on the selected layer', icon: '◪', key: '', order: 62 })
registerTool({ id: 'm-anchor', label: 'Anchor point tool', icon: '⊕', key: 'Y on the Motion page', order: 63 })

registerViewerOverlay({ id: 'motion', order: 10, when: overlayActive, exclusive: overlayActive, component: MotionOverlay })

registerInspector({
  id: 'motion',
  label: 'Motion',
  order: 60,
  when: clip => clip.kind !== 'audio' && clip.kind !== 'caption',
  component: PresetsSection,
})

// Other browser tabs bring their own padded .tab-body; the Motion page wraps CompList in one too.
function CompsTab() { return h('div', { class: 'tab-body' }, h(CompList)) }
registerBrowserTab({ id: 'comps', label: 'Comps', order: 60, component: CompsTab })

registerClipMenu((p, hit) => {
  const c = hit.clip
  if (!c || c.kind === 'audio') return []
  const items = [{ label: 'Animate on the Motion page', run: () => set({ page: 'motion', selection: [c.id] }) }]
  if (c.kind === 'comp') items.unshift({ label: 'Open composition on the Motion page', run: () => (openComposition(c.comp), set({ page: 'motion' })) })

  return items
})

// Remember the main timeline's playhead, so "place on main timeline" can use it while a
// composition is open.
onTime(t => {
  if (!store.openComp) store.motionMainT = t
})

installMotionKeys()
