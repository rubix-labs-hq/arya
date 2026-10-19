import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { hasPendingEdits, set, store, toast, useStore } from '../ui/store.js'
import { player } from '../ui/engine-host.js'
import { host } from '../host.js'
import { formatFileSize } from './delivery-preview.js'
import { importedMediaNavigation } from './import-result.js'
import { restoreBackup, writeBackup } from './backup.js'

const html = htm.bind(h)
export function BrowserWorkspace() {
  const state = useStore(), backend = host.browser
  const [open, setOpen] = useState(false), [projects, setProjects] = useState([]), [storage, setStorage] = useState(null)
  const [busy, setBusy] = useState(''), [error, setError] = useState(backend.startupError ?? ''), [name, setName] = useState('Untitled'), [format, setFormat] = useState('landscape')
  const [staged, setStaged] = useState([])
  const [cancellable, setCancellable] = useState(false), [temporary, setTemporary] = useState([])
  const [importState, setImportState] = useState(backend.importState), [copies, setCopies] = useState([])
  const controller = useRef(null), input = useRef(null), dialog = useRef(null), trigger = useRef(null)
  const refresh = async () => {
    const [list, status, pending] = await Promise.all([backend.request('/api/browser/projects'), backend.request('/api/browser/storage'), backend.request('/api/browser/copies')])
    setProjects(list.projects); setStorage(status); setCopies(pending.paths)
    setTemporary(backend.record ? await backend.storage.temporaryBackups(backend.record.id) : [])
    setStaged(await backend.storage.stagedRestores())
  }
  useEffect(() => {
    refresh().catch(error => setError(error.message))
    return backend.events({ import: value => { setImportState(value); refresh().catch(error => setError(error.message)) }, project: () => refresh().catch(error => setError(error.message)) })
  }, [])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement; dialog.current?.querySelector('button')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [open])
  const apply = result => {
    player.pause()
    set({ project: result.project, version: result.version, root: result.root, selection: [], selMarker: null, selTrack: null, source: null, mediaReveal: null, openComp: null, viewerMode: 'timeline', jobs: result.jobs ?? [] })
    player.seek(0)
  }
  const run = async (label, operation, canCancel = false) => {
    if (busy || hasPendingEdits()) return
    const abort = controller.current = new AbortController()
    setBusy(label); setCancellable(canCancel); setError('')
    try { await operation(abort.signal, phase => { setCancellable(phase.cancellable); setBusy(phase.label) }); await refresh() }
    catch (error) { setError(abort.signal.aborted ? 'Cancelled. The existing project and originals are preserved.' : error.message) }
    finally { if (controller.current === abort) { controller.current = null; setBusy(''); setCancellable(false); refresh().catch(() => {}) } }
  }
  const trap = event => {
    event.stopPropagation()
    if (event.key === 'Escape' && !busy) { event.preventDefault(); setOpen(false); return }
    if (event.key !== 'Tab') return
    const controls = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')].filter(element => element.getClientRects().length)
    if (!controls.length) { event.preventDefault(); dialog.current.focus(); return }
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus() }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus() }
  }
  const importing = ['copying', 'registering', 'committing'].includes(importState.state)
  const blocked = !!busy || hasPendingEdits() || importing || state.jobs.some(job => ['running', 'queued', 'cancelling', 'committing'].includes(job.state))
  const importedNavigation = !blocked && importedMediaNavigation(importState, backend, state)
  const revealImported = () => {
    if (busy || hasPendingEdits()) return
    const patch = importedMediaNavigation(importState, backend, store)
    if (!patch) return toast('These imported files are no longer available in the current project.', 'error')
    set(patch)
  }
  const saveLabel = hasPendingEdits() ? 'Saving edit or waiting for recovery' : state.project ? `Saved on this browser · revision ${backend.record?.version ?? state.version}` : 'Projects stay on this browser'
  return html`<div class="browser-workspace" role="region" aria-label="Browser project storage">
    <button type="button" class="ghost" ref=${trigger} aria-haspopup="dialog" aria-expanded=${open} onClick=${() => setOpen(true)}>Projects & backups</button>
    <span class="browser-save-state" role="status" aria-live="polite">${busy || (importing ? `${importState.state === 'committing' ? 'Saving imported media' : importState.state === 'copying' ? 'Copying' : 'Adding media'} ${importState.name ?? ''} ${Math.round((importState.progress ?? 0) * 100)}%` : saveLabel)}</span>
    ${importing && importState.state !== 'committing' ? html`<button type="button" class="ghost" onClick=${() => backend.request('/api/browser/import/cancel')}>Cancel import</button>` : null}
    ${importedNavigation ? html`<button type="button" class="ghost" onClick=${revealImported}>View imported media</button>` : null}
    ${importState.error ? html`<span role="alert">${importState.error}</span>` : null}
    ${open ? html`<div class="modal-back"><section class="modal browser-project-dialog" ref=${dialog} role="dialog" aria-modal="true" aria-labelledby="browser-project-title" tabIndex="-1" onKeyDown=${trap}>
      <header class="row gap"><h2 id="browser-project-title">Your browser projects</h2><span class="grow"></span><button type="button" class="ghost" disabled=${!!busy} onClick=${() => setOpen(false)}>Close</button></header>
      <p>Your footage is copied to storage on this device. Arya does not upload it. Reopen projects here, and download a complete backup before clearing website data or changing browsers.</p>
      ${storage ? html`<p class="hint">${storage.warning}${storage.quota ? ` ${Math.round((storage.usage ?? 0) / 1024 / 1024)} MB used of approximately ${Math.round(storage.quota / 1024 / 1024)} MB.` : ''}</p>` : null}
      ${error ? html`<p role="alert" class="settings-error">${error}</p>` : null}
      <div class="row gap wrap"><button disabled=${blocked || !state.project} onClick=${() => run('Preparing complete backup', signal => backend.queue(async () => { const backup = await writeBackup(backend, signal); backend.download(backup.file, backup.name, backup.dispose, { projectID: backup.projectID, key: backup.key }); toast('Project backup offered for download. Keep the .arya file with your originals.') }), true)}>Download project and media backup</button>
      <button class="ghost" disabled=${blocked} onClick=${() => input.current?.click()}>Open .arya backup</button>
      <input type="file" accept=".arya" hidden ref=${input} onChange=${event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) return run('Reopening backup', (signal, phase) => backend.queue(async () => { apply(await restoreBackup(backend, file, signal, phase)); setOpen(false) }), true) }} />
      <button class="ghost" disabled=${!!busy} onClick=${() => run('Requesting browser storage', async () => { const status = await backend.request('/api/browser/persist'); setStorage(status) })}>Keep storage if browser allows</button></div>
      ${busy ? html`<p role="status">${busy}. Keep this tab open.</p>${cancellable ? html`<button class="ghost" onClick=${() => controller.current?.abort()}>Cancel</button>` : html`<span class="hint">Saving has started. Keep this tab open.</span>`}` : null}
      ${temporary.length ? html`<h3>Temporary backup files</h3><p>These are download preparation files. Your project media and saved exports are separate. Keep this tab open while the .arya file downloads. Release its temporary file only after the download has finished saving. Files left by interrupted tabs can also be released here.</p>${temporary.map(row => html`<button class="ghost" disabled=${blocked} onClick=${() => run('Releasing temporary backup', () => backend.queue(async () => { const context = backend.context(); await backend.releaseTemporaryBackup(context.id, row.key, true); backend.assert(context) }))}>${backend.temporaryConsumers.has(`${backend.record?.id}:${row.key}`) ? 'I saved the backup · Release temporary' : 'Release interrupted temporary backup'} · ${formatFileSize(row.size)}</button>`)}` : null}
      ${staged.length ? html`<h3>Interrupted backup restores</h3><p>These copies belong to backup restores that have not become saved projects. Your current project and original backups are separate. Release only these staged copies when you no longer need that restore attempt.</p>${staged.map(row => html`<button class="ghost" disabled=${blocked} onClick=${() => run('Releasing interrupted restore copies', () => backend.queue(() => backend.storage.clearStagedRestore(row.id, row.files)))}>Release ${row.files.length} interrupted restore copies · ${formatFileSize(row.bytes)}</button>`)}` : null}
      <h3>New project</h3><form class="browser-new-project" onSubmit=${event => { event.preventDefault(); return run('Creating project', async () => { const result = await backend.request('/api/new', { name, width: format === 'vertical' ? 1080 : 1920, height: format === 'vertical' ? 1920 : 1080 }); apply(result); setOpen(false) }) }}>
      <label>Name<input required maxLength="120" value=${name} disabled=${blocked} onInput=${event => setName(event.target.value)} /></label>
      <label>Format<select value=${format} disabled=${blocked} onChange=${event => setFormat(event.target.value)}><option value="landscape">16:9 · 1920×1080</option><option value="vertical">9:16 · 1080×1920</option></select></label><button type="submit" disabled=${blocked}>Create project</button></form>
      <h3>Saved projects</h3>${projects.length ? html`<div class="browser-project-list">${projects.sort((a, b) => b.updated - a.updated).map(project => html`<button class="ghost" disabled=${blocked || `browser:${project.id}` === state.root} onClick=${() => run('Opening project', async () => { apply(await backend.request('/api/browser/open', { id: project.id })); setOpen(false) })}><span>${project.name}</span><small>${`browser:${project.id}` === state.root ? 'Open' : new Date(project.updated).toLocaleString()}</small></button>`)}</div>` : html`<p>No saved projects yet.</p>`}
      ${copies.length ? html`<h3>Copied files awaiting import</h3><p>${copies.length} completed copies are still here. Retry probes and registration without copying your originals again.</p><button disabled=${blocked} onClick=${() => run('Retrying copied files', async () => { const result = await backend.request('/api/import', { paths: copies }); if (result.failures?.length) throw new Error(result.failures.map(item => `${item.name}: ${item.error}`).join('\n')); toast(`Added ${Object.keys(result.assets).length} files to Media`) })}>Retry adding copied files</button>` : null}
      <p class="hint">Subscription agents, cloud generation, Figma sign-in, transcription and server analysis need a supported native or local connection. Manual editing, GPU preview, browser-compatible exports and project backups work on this browser after their capability checks.</p>
    </section></div>` : null}
  </div>`
}
