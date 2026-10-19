const openDialogs = new WeakMap()
const statusText = status => ({
  valid: 'The current project file is valid.',
  invalid: 'The current project file is damaged. Its original bytes will be preserved before a recovery copy replaces it.',
  missing: 'The current project file is missing. Choose a verified recovery copy to restore it.',
  unavailable: 'The current project file cannot be safely read. Repair file access and refresh before restoring.',
})[status] ?? 'Refresh to check the current project file.'

export function createRecoveryController({ request, context, apply, updateStatus = () => {} }) {
  const root = context().root, listeners = new Set()
  const state = { listing: null, selected: null, busy: false, error: '', message: '', publicationWarning: '' }
  let epoch = 0, disposed = false
  const emit = () => { if (!disposed) for (const listener of listeners) listener(state) }
  const current = token => !disposed && epoch === token
  const sameFolder = () => { if (context().root !== root) throw new Error('The project folder changed. Close recovery and reopen it for the current folder.') }
  function accept(listing) {
    if (listing?.protocol !== 1 || !Number.isSafeInteger(listing.version) || !Array.isArray(listing.snapshots) || listing.snapshots.length > 12 || !listing.observed) throw new Error('The recovery response is incomplete. Refresh before restoring.')
    state.listing = listing; state.selected = null
    updateStatus({ status: listing.observed.status, writable: listing.observed.writable, warning: [listing.warning, state.publicationWarning].filter(Boolean).join(' ') || null })
  }
  const controller = {
    state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener) },
    choose(id) {
      if (state.busy || !state.listing?.snapshots.some(copy => copy.id === id)) return
      state.selected = id; state.error = ''; state.message = ''; emit()
    },
    canRestore() { return Boolean(!state.busy && state.selected && state.listing?.familyID && state.listing?.observed.token && state.listing?.observed.writable && ['valid', 'invalid', 'missing'].includes(state.listing.observed.status)) },
    async refresh({ preserveError = false } = {}) {
      if (disposed || state.busy) return
      const token = ++epoch
      state.busy = true; state.selected = null; state.message = ''; if (!preserveError) state.error = ''; emit()
      try { sameFolder(); const listing = await request('/api/recovery'); if (!current(token)) return; sameFolder(); accept(listing) }
      catch (error) { if (current(token)) { state.listing = null; state.error = error.message } }
      finally { if (current(token)) { state.busy = false; emit() } }
    },
    async restore() {
      if (!controller.canRestore()) return
      const listing = state.listing, chosen = state.selected, token = ++epoch
      state.busy = true; state.error = ''; state.message = ''; emit()
      try {
        sameFolder()
        if (context().version !== listing.version) throw new Error('The project changed after recovery was shown. Refresh and choose a copy again.')
        const result = await request('/api/recovery/restore', { snapshotID: chosen, familyID: listing.familyID, observedToken: listing.observed.token, expectedVersion: listing.version })
        if (!current(token)) return
        sameFolder()
        if (!result.project || !Number.isSafeInteger(result.version)) throw new Error('The restore response is incomplete. Refresh the project before continuing.')
        if (result.version < context().version) throw new Error('A newer project edit arrived while restore finished. Refresh before continuing.')
        apply(result)
        state.selected = null
        state.message = 'The selected copy was restored. The previous file was preserved when it existed.'
        state.publicationWarning = result.publication?.directorySynced === false ? 'The project was restored, but its folder sync could not be confirmed. Keep the project open and check the saved file before closing.' : ''
        if (result.publication?.warningCode) state.publicationWarning += ` Publication warning: ${String(result.publication.warningCode).slice(0, 128)}.`
        if (result.recovery) accept(result.recovery)
        else {
          const refreshed = await request('/api/recovery')
          if (!current(token)) return
          sameFolder(); accept(refreshed)
        }
      } catch (error) {
        if (current(token)) {
          state.error = error.message; state.selected = null
          try { sameFolder(); const listing = await request('/api/recovery'); if (current(token)) { sameFolder(); accept(listing) } }
          catch (refreshError) { if (current(token)) { state.listing = null; state.error += ` Refresh failed: ${refreshError.message}` } }
        }
      } finally { if (current(token)) { state.busy = false; emit() } }
    },
    dispose() { disposed = true; epoch++; listeners.clear() },
  }
  return controller
}

export function openProjectRecovery({ document = globalThis.document, ...options }) {
  const existing = openDialogs.get(document)
  if (existing) { existing.focus(); return existing }
  const controller = createRecoveryController(options), trigger = document.activeElement
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node }
  const backdrop = element('div', undefined, 'modal-back project-recovery-backdrop'), panel = element('div', undefined, 'modal project-recovery')
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'project-recovery-title'); panel.tabIndex = -1
  const title = element('h3', 'Restore a saved project'); title.id = 'project-recovery-title'
  const explanation = element('p', 'Choose a verified copy, then select Restore. Recovery does not replace the project automatically.'), disk = element('p'), warning = element('p', undefined, 'project-recovery-warning'), feedback = element('p')
  feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite')
  const copies = element('div', undefined, 'project-recovery-copies'), actions = element('div', undefined, 'modal-actions')
  const close = element('button', 'Close', 'ghost'), refresh = element('button', 'Refresh', 'ghost'), restore = element('button', 'Restore selected copy')
  actions.append(close, refresh, restore); panel.append(title, explanation, disk, warning, copies, feedback, actions); backdrop.append(panel); document.body.append(backdrop)
  let rendered = null, radios = [], unsubscribe
  const dialog = {
    controller,
    focus() { close.focus() },
    close() {
      if (controller.state.busy) return false
      controller.dispose(); unsubscribe(); backdrop.remove(); openDialogs.delete(document)
      if (trigger?.isConnected) trigger.focus()
      return true
    },
    refresh() { return controller.refresh() },
  }
  openDialogs.set(document, dialog)
  close.addEventListener('click', () => dialog.close())
  refresh.addEventListener('click', () => controller.refresh())
  restore.addEventListener('click', () => controller.restore())
  backdrop.addEventListener('click', event => { if (event.target === backdrop) dialog.close() })
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); dialog.close() }
    if (event.key !== 'Tab') return
    const controls = [...panel.querySelectorAll('button,input')].filter(control => !control.disabled)
    if (!controls.length) { event.preventDefault(); panel.focus(); return }
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first.focus() }
  })
  unsubscribe = controller.subscribe(state => {
    const observed = state.listing?.observed
    disk.textContent = statusText(observed?.status) + (observed && !observed.writable ? ' The project is read-only or unavailable for replacement.' : '')
    warning.textContent = [state.listing?.warning, state.publicationWarning].filter(Boolean).join(' ')
    feedback.textContent = state.error || state.message || (state.busy ? 'Checking recovery files…' : '')
    feedback.setAttribute('role', state.error ? 'alert' : 'status')
    if (rendered !== state.listing) {
      rendered = state.listing; copies.replaceChildren(); radios = []
      if (state.listing && !state.listing.snapshots.length) copies.append(element('p', 'No verified recovery copies are available. Preserve the original file and repair it before continuing.'))
      for (const copy of state.listing?.snapshots ?? []) {
        const row = element('label', undefined, 'project-recovery-copy'), radio = element('input'), description = element('span')
        radio.type = 'radio'; radio.name = 'project-recovery-copy'; radio.value = copy.id
        const name = typeof copy.name === 'string' ? copy.name : 'Untitled project'
        description.textContent = `${name} · ${copy.createdAt} · ${copy.host} · ${Math.ceil(copy.bytes / 1024)} KiB · SHA256 ${String(copy.sha256).slice(0, 12)}`
        radio.addEventListener('change', () => controller.choose(copy.id)); radios.push(radio); row.append(radio, description); copies.append(row)
      }
    }
    for (const radio of radios) { radio.checked = radio.value === state.selected; radio.disabled = state.busy }
    close.disabled = state.busy; refresh.disabled = state.busy; restore.disabled = !controller.canRestore()
    if (state.busy && !state.listing) panel.focus()
  })
  dialog.focus(); controller.refresh()
  return dialog
}

export function refreshOpenProjectRecovery(document = globalThis.document) { return openDialogs.get(document)?.refresh() }
