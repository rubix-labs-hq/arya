// Extension points for editor features. Plugins in web/ui/plugins/*.js import this
// module and register what they add; the shell reads the registries when it draws.
//
//   registerPage({ id, label, order, component })                 a top-level page
//   registerInspector({ id, label, order, when(clip, track), component({ clip, track }) })
//   registerBrowserTab({ id, label, order, component })            a tab in the left panel
//   registerBrowserSection({ id, tab, order, component })         a section inside a browser tab
//   registerInspectorAction({ id, order, when(clip, track), component })
//       contextual controls above the inspector's tabs
//   registerClipMenu(fn(project, hit, t) => items[])               entries for the timeline's right-click menu
//   registerDeliver({ id, label, run(project) })                   extra Deliver actions (e.g. FCPXML export)
//   registerSettings({ id, label, component })                     a section in Settings
//   registerViewerOverlay({ id, order, when(store), component({ p, rect, t }) })
//       drawn over the viewer's frame; rect is the frame's box in the stage (CSS px),
//       and project px map to it by rect.w / p.width. Return null to draw nothing.
//   registerTool({ id, label, icon, key, order })                   an extra timeline/viewer tool (store.tool = id)

export const registry = { pages: [], inspectors: [], inspectorActions: [], browserTabs: [], browserSections: [], clipMenus: [], deliver: [], settings: [], viewerOverlays: [], tools: [] }

const byOrder = (a, b) => (a.order ?? 100) - (b.order ?? 100)
const add = (list, item) => {
  const i = list.findIndex(x => x.id && x.id === item.id)
  if (i >= 0) list.splice(i, 1, item)
  else list.push(item)
  list.sort(byOrder)
}

export const registerPage = page => add(registry.pages, page)
export const registerInspector = section => add(registry.inspectors, section)
export const registerBrowserTab = tab => add(registry.browserTabs, tab)
export const registerBrowserSection = section => add(registry.browserSections, section)
export const registerInspectorAction = action => add(registry.inspectorActions, action)
export const registerClipMenu = fn => registry.clipMenus.push(fn)
export const registerDeliver = action => add(registry.deliver, action)
export const registerSettings = section => add(registry.settings, section)
export const registerViewerOverlay = overlay => add(registry.viewerOverlays, overlay)
export const registerTool = tool => add(registry.tools, tool)
