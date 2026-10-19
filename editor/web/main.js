// Entry: the render worker (headless) or the editor.
const params = new URLSearchParams(location.search)
if (params.has('worker')) {
  const { startWorker } = await import('./engine/worker.js')
  startWorker()
} else {
  // Feature plugins register their pages, panels and menus before the shell first draws.
  await import('./ui/plugins-index.js').catch(error => console.warn('plugins', error))
  const { mountApp } = await import('./ui/app.js')
  const mounting = mountApp(document.getElementById('app'))
  if (globalThis.__aryaBrowserHost) await mounting
  const { installAccessibleNames } = await import('./ui/accessible-names.js')
  installAccessibleNames(document.getElementById('app'))
}
