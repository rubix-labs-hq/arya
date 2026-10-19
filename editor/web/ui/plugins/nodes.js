// Color nodes plugin: Resolve-style node grading on the Color page.
//
// The node panel, the per-node palettes and the presets live in web/ui/color/ and the
// Color page (color.js) draws them. This plugin adds what the shell owns: the stylesheet
// and the viewer overlays (power window handles, the qualifier eyedropper, the gallery
// still wipe).
//
// Data it writes (all through ops, so Claude sees and can make the same edits):
//   clip.nodes                    the graph (node_add / node_update / node_link …)
//   node.enabled: false           bypass (Cmd-D); a missing key means enabled
//   node.label                    the name shown on the node
//   node.qualifier.show: true     highlight: draw the qualifier's matte instead of the grade
//   project.nodePresets { name: { name, nodes, grade } }  presets saved in this project

import { registerViewerOverlay } from '../registry.js'
import { EyedropperOverlay, eyedropperActive, installEyedropperKeys, WindowOverlay, windowOverlayActive, WipeOverlay, wipeActive } from '../color/overlay.js'

if (typeof document !== 'undefined' && !document.querySelector('link[data-reel="nodes"]')) {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = new URL('../color/nodes.css', import.meta.url).href
  link.dataset.reel = 'nodes'
  document.head.appendChild(link)
}

registerViewerOverlay({ id: 'nodes-wipe', order: 10, when: wipeActive, component: WipeOverlay })
registerViewerOverlay({ id: 'nodes-window', order: 20, when: windowOverlayActive, exclusive: windowOverlayActive, component: WindowOverlay })
registerViewerOverlay({ id: 'nodes-eyedropper', order: 30, when: eyedropperActive, exclusive: eyedropperActive, component: EyedropperOverlay })

installEyedropperKeys()
