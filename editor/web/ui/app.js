// The editor shell, workflow pages and toasts.

import { h, render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { duration } from '/core/project.js'
import { Browser, installDropImport } from './browser.js'
import { ChatPanel } from './chat.js'
import { player } from './engine-host.js'
import { Inspector } from './inspector.js'
import { installKeys, SHORTCUTS } from './keys.js'
import { api, chatHistoryStatus, connect, set, store, toast, useStore } from './store.js'
import { Timeline } from './timeline.js'
import { Toolbar } from './timeline-toolbar.js'
import { Viewer } from './viewer.js'
import { ColorPage } from './color.js'
import { AudioPage } from './mixer.js'
import { DeliverPage } from './deliver.js'
import { MediaPage } from './media-page.js'
import { registry } from './registry.js'
import { Divider, LayoutMenu, editGridColumns, editPaneSizes, layoutStyle, useCompactEditPanel, useLayout, useWorkspaceWidth } from './layout.js'
import { Settings, refreshAssistantStatus } from './settings.js'
import { ScrollTabs } from './scroll-tabs.js'
import { Icon } from './icons.js'
import { PhonePanelControls, PhoneGate, usePhoneLayout, compactPanelToPhone, phonePanelToCompact } from './phone.js'
import { AssistantSharingReview } from './assistant-sharing.js'
import { host } from '../host.js'
import { BrowserWorkspace } from '../browser-local/workspace.js'
import { openProjectRecovery, refreshOpenProjectRecovery } from './project-recovery.js'

const html = htm.bind(h)

const PAGES = [
  ['media', 'Media', '⇧1', 10],
  ['edit', 'Edit', '⇧2', 20],
  ['color', 'Color', '⇧4', 40],
  ['audio', 'Audio', '⇧5', 50],
  ['deliver', 'Deliver', '⇧6', Infinity],
]

function showRecovery() {
  if (store.assistantSharingReviewOpen) return
  return openProjectRecovery({ request: api, context: () => store,
    updateStatus: recovery => set({ recovery }),
    apply: result => {
      player.pause()
      set({ project: result.project, version: result.version, selection: [], selMarker: null, selTrack: null, openComp: null })
      player.seek(0)
    },
  })
}

function TopBar() {
  const s = useStore()
  const p = s.project
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsButton = useRef(null)
  const closeActions = () => {
    setActionsOpen(false)
    const trigger = actionsButton.current
    if (trigger?.getClientRects().length) trigger.focus()
  }
  const openActionDialog = action => {
    if (store.assistantSharingReviewOpen) return
    if (actionsOpen) closeActions()
    return action()
  }
  const running = s.jobs.filter(j => j.state === 'running' || j.state === 'queued' || host.kind === 'browser-local' && ['cancelling', 'committing'].includes(j.state))

  return html`
    <div class="topbar">
      <div class="topbar-project"><div class="brand"><picture><source media="(max-width: 480px)" srcset="/assets/brand/mark.svg" /><img src="/assets/brand/wordmark.svg" alt="Arya" width="166" height="77" /></picture></div>
      ${p ? html`<div class="proj" title=${p.name ?? 'Untitled'}><span class="proj-name" title=${p.name ?? 'Untitled'}>${p.name ?? 'Untitled'}</span><span class="muted proj-format">${`${p.width}×${p.height} · ${p.fps}fps`}</span></div>` : null}</div>
      <div class="workflow-pages" hidden=${!p}><${ScrollTabs} tabs=${[...PAGES, ...registry.pages.map(pg => [pg.id, pg.label, pg.key ?? '', pg.order ?? 100])].sort((a, b) => a[3] - b[3])} value=${s.page} onChange=${page => set({ page })} label="Workflow" /></div>
      <div class="topbar-actions">
      <div class="topbar-action-tools" onFocusOut=${event => { if (!event.currentTarget.contains(event.relatedTarget)) setActionsOpen(false) }} onKeyDown=${event => { if (actionsOpen && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeActions() } }}>
      <button type="button" class="ghost compact-actions-toggle" ref=${actionsButton} aria-label=${`Editor actions${running.length ? `, delivery ${Math.round((running[0].progress ?? 0) * 100)}%` : ''}`} aria-expanded=${actionsOpen} aria-controls="editor-action-list" onClick=${() => setActionsOpen(!actionsOpen)}>More${running.length ? ` ${Math.round((running[0].progress ?? 0) * 100)}%` : ''}</button>
      <div id="editor-action-list" class=${`topbar-action-list ${actionsOpen ? 'open' : ''}`} role="group" aria-label="Editor actions">
      ${running.length ? html`<button type="button" class="job-pill" aria-label=${`Open delivery progress, ${Math.round((running[0].progress ?? 0) * 100)}%`} onClick=${() => set({ page: 'deliver' })}><${Icon} name="export" size=${14} /> ${Math.round((running[0].progress ?? 0) * 100)}%</button>` : null}
      ${p ? html`<div class="topbar-history" role="group" aria-label="History">
        <button class="ghost topbar-undo" aria-label="Undo" title="Undo latest edit (⌘Z)" onClick=${() => api('/api/undo', {}).then(r => set({ project: r.project, version: r.version }))}><${Icon} name="undo" /><span class="action-label">Undo</span></button>
        <button class="ghost topbar-undo" aria-label="Redo" title="Redo (⇧⌘Z)" onClick=${() => api('/api/redo', {}).then(r => set({ project: r.project, version: r.version }))}><${Icon} name="redo" /><span class="action-label">Redo</span></button>
      </div>
      <span class="topbar-sep" aria-hidden="true"></span>
      <div class="topbar-utility"><${LayoutMenu} /></div>` : null}
      ${host.kind === 'http' ? html`<button class="ghost recovery-entry" aria-haspopup="dialog" disabled=${s.assistantSharingReviewOpen === true} title=${s.recovery?.warning ?? 'Review verified saved project copies'} onClick=${() => openActionDialog(showRecovery)}>Recovery</button>` : null}
      <button class="ghost topbar-utility" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick=${() => set({ showKeys: !s.showKeys })}><${Icon} name="keyboard" /><span class="action-label">Shortcuts</span></button>
      <button class="ghost settings-entry" aria-haspopup="dialog" title="Settings (⌘,)" disabled=${s.assistantSharingReviewOpen === true} onClick=${() => openActionDialog(() => set({ settingsOpen: true }))}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z"/><circle cx="12" cy="12" r="3"/></svg><span class="action-label">Settings</span></button>
      <button type="button" class="ghost compact-actions-done" onClick=${closeActions}>Close actions</button>
      </div></div>
      <span class="topbar-sep before-assistant" aria-hidden="true"></span>
      <button class=${`claude-btn ${s.chatOpen ? 'on' : ''} ${['thinking', 'working', 'running', 'queued', 'cancelling'].includes(s.claude.state) ? 'busy' : ''}`} aria-expanded=${s.chatOpen} onClick=${() => set({ chatOpen: !s.chatOpen })}><${Icon} name="assistant" />Assistant${s.refs.length ? html` <span class="count">${s.refs.length}</span>` : ''}</button>
      <span class=${`conn ${s.connected ? 'ok' : ''}`} title=${host.kind === 'browser-local' ? 'Using project storage on this browser' : s.connected ? 'Connected to the Arya server' : 'Disconnected'}></span>
      </div>
    </div>
  `
}

function EditPage() {
  const s = useStore()
  const l = useLayout()
  const workspace = useWorkspaceWidth()
  const [compactPanel, choosePanel] = useCompactEditPanel()
  const [previewOpen, setPreviewOpen] = useState(false)
  const focusInspector = active => {
    if (active && document.activeElement?.closest('.edit-inspector-pane')) {
      choosePanel('inspector')
      setPreviewOpen(false)
    }
  }
  const phone = usePhoneLayout(focusInspector)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const shortPortrait = matchMedia('(max-height: 600px) and (orientation: portrait)')
    const update = () => focusInspector(phone && shortPortrait.matches)
    shortPortrait.addEventListener('change', update)
    document.addEventListener('focusin', update)
    update()
    return () => {
      shortPortrait.removeEventListener('change', update)
      document.removeEventListener('focusin', update)
    }
  }, [phone])
  const compact = !phone && Number.isFinite(workspace.width) && workspace.width < 900
  // A resize or the Assistant opening can make the workspace compact while an Inspector field
  // is focused. On that transition only, keep the Inspector shown so the field is not hidden and
  // blurred, then record the choice. Later panel choices while compact are never overridden.
  const wasCompact = useRef(compact)
  const keepInspector = compact && !wasCompact.current && compactPanel !== 'inspector' && typeof document !== 'undefined' && Boolean(document.activeElement?.closest?.('.edit-inspector-pane'))
  const panel = keepInspector ? 'inspector' : compactPanel
  useEffect(() => { wasCompact.current = compact; if (keepInspector) choosePanel('inspector') }, [compact, keepInspector])
  const showTimeline = phone || compact || l.showTimeline
  const sizes = editPaneSizes(l, workspace.width)
  const scope = s.openComp == null ? s.project : s.project?.comps?.[s.openComp]
  const clip = scope?.tracks?.flatMap(track => track.clips).find(item => item.id === s.selection[0])
  const selected = s.selection.length === 1 ? clip?.label ?? (clip?.kind === 'title' ? clip.title?.text?.split('\n')[0] : String(clip?.src ?? clip?.kind ?? s.selection[0]).split('/').pop()) : s.selection.length ? `${s.selection.length} selected` : s.selMarker ? 'Marker selected' : 'No clip selected'
  const left = l.mediaSide === 'left' ? 'media' : 'inspector'
  const right = left === 'media' ? 'inspector' : 'media'
  const visible = name => name === 'media' ? l.showMedia : l.showInspector
  const column = name => name === left ? 1 : (visible(left) ? 3 : 1) + 2
  const paneProps = name => ({
    hidden: phone || compact ? panel !== name : !visible(name),
    style: phone || compact ? undefined : { gridColumn: column(name), gridRow: 1 },
    id: `edit-panel-${name}`, role: phone ? 'tabpanel' : undefined,
    'aria-labelledby': phone ? `phone-tab-${name}` : undefined,
  })
  const setPhonePanel = name => {
    const mapped = phonePanelToCompact(name)
    if (mapped) { choosePanel(mapped); setPreviewOpen(false) }
  }

  // Keep these keyed panes mounted so resizing does not discard an input draft.
  return html`
    <div class=${`page edit ${phone ? 'phone-edit' : compact ? 'customizable compact-edit' : 'customizable'} ${phone && compactPanel === 'inspector' ? 'phone-inspector-focus' : ''} ${previewOpen ? 'phone-preview-open' : ''} ${s.chatOpen ? 'with-chat' : ''} ${showTimeline ? '' : 'timeline-hidden'}`} data-compact-panel=${compactPanel}>
      <${PhonePanelControls} panel=${compactPanelToPhone(compactPanel)} setPanel=${setPhonePanel} previewOpen=${previewOpen} setPreviewOpen=${setPreviewOpen} />
      <div class="compact-edit-access">
        <div class="compact-panel-picker" role="group" aria-label="Edit panels">${[['viewer', 'Viewer'], ['media', 'Media'], ['inspector', 'Inspector']].map(([name, label]) => html`<button type="button" class=${panel === name ? 'on' : 'ghost'} aria-pressed=${panel === name} aria-controls="edit-upper" onClick=${() => choosePanel(name)}>${label}</button>`)}</div>
        <div class="compact-edit-selection" title=${selected}>${selected}</div>
      </div>
      <div id="edit-upper" class="upper" ref=${workspace.ref} style=${phone ? undefined : { gridTemplateColumns: compact ? 'minmax(0, 1fr)' : editGridColumns(l, workspace.width) }}>
        <div key="media" class="edit-pane edit-media-pane" ...${paneProps('media')}><${Browser} key="media" /></div>
        ${!phone && !compact && visible(left) ? html`<${Divider} key="left-divider" field=${left} size=${sizes[left]} label=${`Resize ${left} panel`} />` : null}
        <div key="viewer" id="edit-viewer" class="edit-viewer" hidden=${compact && panel !== 'viewer'} style=${phone || compact ? undefined : { gridColumn: visible(left) ? 3 : 1, gridRow: 1 }}><${Viewer} key="viewer" compact=${phone} /></div>
        ${!phone && !compact && visible(right) ? html`<${Divider} key="right-divider" field=${right} size=${sizes[right]} label=${`Resize ${right} panel`} reverse=${true} />` : null}
        <div key="inspector" class="edit-pane edit-inspector-pane" ...${paneProps('inspector')}><${Inspector} key="inspector" /></div>
      </div>
      ${!phone && !compact && showTimeline ? html`<${Divider} field="upper" axis="vertical" label="Resize viewer and timeline" />` : null}
      <div class="lower" id="edit-panel-timeline" hidden=${phone ? compactPanel !== 'viewer' : !showTimeline} role=${phone ? 'tabpanel' : undefined} aria-labelledby=${phone ? 'phone-tab-timeline' : undefined}>
        <${Toolbar} /><${Timeline} />
      </div>
    </div>
  `
}

function Welcome() {
  const s = useStore()
  const needsRecovery = host.kind === 'http' && ['invalid', 'unavailable'].includes(s.recovery?.status)
  // A new folder has no project file and no recovery history; there is nothing to recover.
  const fresh = host.kind === 'http' && s.recovery?.status === 'missing' && s.recovery?.history === false
  const missing = host.kind === 'http' && s.recovery?.status === 'missing' && !fresh
  const [busy, setBusy] = useState(false)
  const start = async body => {
    setBusy(true)
    try {
      const r = await api('/api/new', body)
      set({ project: r.project, version: r.version })
    } catch (e) {
      toast(e.message, 'error')
    }
    setBusy(false)
  }

  return html`
    <div class="welcome">
      <div class="welcome-card">
        <div class="brand big"><img src="/assets/brand/wordmark.svg" alt="Arya" width="166" height="77" /></div>
        <p>${host.kind === 'browser-local' ? 'Create a project, import your own footage, edit its native layers and download the completed export. Projects and media stay on this browser. Subscription agents require a supported native or local connection.' : 'A video editor you can direct.'}${host.kind === 'browser-local' ? '' : ' Edit by hand on the timeline, or ask your connected assistant to work with the current selection and references. Review its changes with undo.'}</p>
        ${needsRecovery ? html`<p role="alert">The project file could not be opened. Preserve its original and choose a verified recovery copy, or repair the file and refresh recovery.</p>` : missing ? html`<p>The project file is missing. You can recover a saved copy or create a new project.</p>` : null}
        ${host.kind === 'http' && !fresh ? html`<button class="ghost" aria-haspopup="dialog" disabled=${s.assistantSharingReviewOpen === true} onClick=${showRecovery}>Choose a recovery copy</button>` : null}
        ${s.recovery?.warning ? html`<p role="status">${s.recovery.warning}</p>` : null}
        <div class="row gap">
          <button class="primary" disabled=${busy || needsRecovery} onClick=${() => start({ name: 'Untitled' })}>New 1080p project</button>
          <button class="ghost" disabled=${busy || needsRecovery} onClick=${() => start({ name: 'Vertical', width: 1080, height: 1920 })}>New 9:16 project</button>
        </div>
        <p class="muted">Or drop media anywhere in this window to start.</p>
      </div>
    </div>
  `
}

function KeysSheet() {
  return html`
    <div class="modal-back" onClick=${() => set({ showKeys: false })}>
      <div class="modal keys" onClick=${e => e.stopPropagation()}>
        <h3>Keyboard</h3>
        <div class="keys-grid">${SHORTCUTS.map(([k, d]) => html`<kbd>${k}</kbd><span>${d}</span>`)}</div>
      </div>
    </div>
  `
}

function Toasts() {
  const s = useStore()

  return html`<div class="toasts">${s.toasts.map(t => html`<div class=${`toast ${t.kind}`} key=${t.id}>${t.text}</div>`)}</div>`
}

function App() {
  const s = useStore()
  const l = useLayout()
  useEffect(() => {
    document.body.dataset.page = s.page
  }, [s.page])
  useEffect(() => {
    const poll = () => refreshAssistantStatus().catch(() => {})
    poll()
    const interval = setInterval(poll, 4000)
    return () => clearInterval(interval)
  }, [])
  const page = !s.project ? html`<${Welcome} />` :
    s.page === 'edit' ? html`<${EditPage} />` :
    s.page === 'color' ? html`<${ColorPage} />` :
    s.page === 'audio' ? html`<${AudioPage} />` :
    s.page === 'deliver' ? html`<${DeliverPage} />` :
    registry.pages.some(pg => pg.id === s.page) ? h(PhoneGate, { page: registry.pages.find(pg => pg.id === s.page) }) :
    html`<${MediaPage} />`

  return html`
    <div class=${`app ${s.chatOpen ? 'chat-open' : ''}`} style=${layoutStyle(l)}>
      <${TopBar} />
      ${host.kind === 'browser-local' ? html`<${BrowserWorkspace} />` : null}
      <div class="main">
        ${page}
        ${s.chatOpen ? html`<${Divider} field="chat" label="Resize assistant panel" reverse=${true} /><${ChatPanel} />` : null}
      </div>
      ${s.showKeys && !s.assistantSharingReviewOpen ? html`<${KeysSheet} />` : null}
      ${s.settingsOpen && !s.assistantSharingReviewOpen ? html`<${Settings} />` : null}
      ${s.assistantSharingReview ? html`<${AssistantSharingReview} review=${s.assistantSharingReview} busy=${s.assistantSharingBusy === true} onAllow=${s.assistantSharingActions.allow} onDecline=${s.assistantSharingActions.decline} onStop=${s.assistantSharingActions.stop} />` : null}
      <${Toasts} />
    </div>
  `
}

export async function mountApp(el) {
  const res = await api('/api/project')
  set({ project: res.project, version: res.version, root: res.root, recovery: res.recovery ?? null, chat: res.chat ?? [], chatHistory: chatHistoryStatus(res.chatHistory), claude: res.claude ?? { state: 'idle' }, activity: res.activity ?? [], jobs: res.jobs ?? [] })
  api('/api/caps').then(caps => set({ caps })).catch(() => {})
  connect(() => { if (host.kind === 'http') refreshOpenProjectRecovery() })
  installKeys()
  installDropImport()
  if (host.kind === 'browser-local') el.replaceChildren()
  render(html`<${App} />`, el)
  if (store.project) {
    set({ zoom: Math.max(4, Math.min(200, (innerWidth - 220) / Math.max(5, duration(store.project) * 1.1))) })
    player.seek(0)
  }
  window.reel = { store, player, set }
}
