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
  // Browser editors only: the website support link shown in Settings. Native hosts resolve
  // none, so the App Store builds never show a website payment link.
  Promise.all([import('./host.js'), import('./ui/support-link.js'), import('./ui/store.js')])
    .then(([{ host }, { resolveSupportLink }, { set }]) => resolveSupportLink({ kind: host.kind, request: path => host.request(path) })
      .then(async supportURL => {
        if (!supportURL) return
        set({ supportURL })
        const { mountSupportPrompt } = await import('./ui/support-prompt.js')
        mountSupportPrompt(supportURL)
      }))
    .catch(() => {})
  if (globalThis.__aryaBrowserHost) await mounting
  const { installAccessibleNames } = await import('./ui/accessible-names.js')
  installAccessibleNames(document.getElementById('app'))
}
