// Assistant requests carry editing context and report their status and committed edits.

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { api, set, store, time, toast, useStore, useTime } from './store.js'
import { assistantState, assistantPrompt, providerName } from './assistant-state.js'
import { assistantActivity } from './assistant-activity.js'
import { AssistantControls, RoutingReceipt } from './provider-controls.js'
import { Icon } from './icons.js'
import { receiptSelection } from './change-receipt.js'
import { player } from './engine-host.js'
import { refreshAssistantStatus } from './settings.js'
import { startChatGPTSignIn, chatgptAccountAction, chooseChatGPTAssistant } from './assistant-status.js'
import { createAssistantSharingGate } from './assistant-sharing.js'
import { assistantDraft, updatedAssistantDraft, assistantDraftContext, assistantDraftIsCurrent, createAssistantScriptImport } from './assistant-script.js'
import { assistantPanel } from './assistant-panel.js'

const html = htm.bind(h)
const assistantDrafts = new Map()
let signInNotice = null

function md(text) {
  // Minimal formatting: code spans, bold, line breaks.
  const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')

  return esc.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')
}

function ChangeReceipt({ receipt }) {
  const groups = [...new Set(receipt.clips.map(clip => clip.comp))]
  const legacyAssets = receipt.totalAssets == null && receipt.projectChanges.includes('assets')
  const assetChange = change => change.property === 'assets' || change.property.startsWith('assets.') || change.property.startsWith('assets[')
  const scopeLabel = scope => scope.asset != null ? 'Media registration' : scope.comp == null && scope.track == null && scope.changes.some(assetChange)
    ? scope.changes.every(assetChange) ? 'Media metadata' : 'Media and project settings' : scope.track == null ? 'Project or composition settings' : 'Track settings'
  const headline = [receipt.total ? `${receipt.total} ${receipt.total === 1 ? 'layer' : 'layers'} changed` : '',
    receipt.totalAssets ? `${receipt.totalAssets} Media ${receipt.totalAssets === 1 ? 'asset' : 'assets'} changed` : legacyAssets ? 'Media assets changed' : '',
    receipt.totalAssets && (receipt.scopes ?? []).some(scope => scope.asset == null && scope.changes.some(change => change.property !== 'Object order')) ? 'Project or track settings changed' : '',
    legacyAssets && receipt.projectChanges.some(property => property !== 'assets') ? 'Project or track settings changed' : '',
    !receipt.total && !receipt.totalAssets && !legacyAssets ? 'Project settings changed' : ''].filter(Boolean).join(' · ')
  const select = comp => {
    const current = receiptSelection(receipt, store.project, comp)
    if (!current) return toast('Those layers are no longer in the project.')
    set({ openComp: current.comp, selection: current.ids, page: 'edit', viewerMode: 'timeline' })
    player.seek(current.start)
  }
  return html`<section class="assistant-result-card" aria-label=${receipt.undone ? 'Undone edit result' : 'Committed edit result'}>
    <div class="receipt-heading"><b>${headline}</b><small>${receipt.undone ? 'Undone · Edit' : 'Edit'} ${receipt.version}</small></div>
    <details class="change-receipt"><summary>View changes</summary>
      ${receipt.projectChanges.length ? html`<p class="receipt-meta">${receipt.projectChanges.join(', ')}</p>` : null}
      ${(receipt.scopes ?? []).map(scope => html`<div class="receipt-layer"><b>${scope.name}</b><span class="receipt-meta">${scopeLabel(scope)} · ${scope.status}</span>${scope.asset != null ? html`<p class="receipt-meta">${scope.asset}</p>` : null}<dl>${scope.changes.map(change => html`<dt>${change.property}</dt><dd><span>${change.before}</span><span class="receipt-arrow" aria-label="changed to">→</span><span>${change.after}</span></dd>`)}</dl></div>`)}
      ${receipt.clips.map(clip => html`<div class="receipt-layer"><b>${clip.name}</b><span class="receipt-meta">${clip.compositionName} · ${clip.id} · ${clip.status}</span><dl>${clip.changes.map(change => html`<dt>${change.property}</dt><dd><span>${change.before}</span><span class="receipt-arrow" aria-label="changed to">→</span><span>${change.after}</span></dd>`)}</dl></div>`)}
      ${receipt.truncated ? html`<p class="receipt-meta">Some changes or values are shortened. Showing ${receipt.clips.length} of ${receipt.total} changed layers${receipt.totalScopes == null ? '' : ` and ${(receipt.scopes ?? []).length} of ${receipt.totalScopes} ${receipt.totalAssets ? 'Media and settings' : 'settings'} groups`}.</p>` : null}
      <details class="receipt-json"><summary>Read-only JSON diff</summary><pre>${JSON.stringify({ clips: receipt.clips, scopes: receipt.scopes, projectChanges: receipt.projectChanges, totalLayers: receipt.total, totalScopes: receipt.totalScopes, totalAssets: receipt.totalAssets, truncated: receipt.truncated }, null, 2)}</pre></details>
      <p class="receipt-meta">Undo in the toolbar reverts the latest committed edit.</p>
    </details>
    ${groups.length ? html`<div class="receipt-actions">${groups.map(comp => {
      const selectable = receiptSelection(receipt, store.project, comp)
      const name = comp == null ? 'main timeline' : store.project?.comps?.[comp]?.name ?? comp
      return html`<button class="ghost tiny" disabled=${!selectable} onClick=${() => select(comp)}>Select changed layers${groups.length > 1 ? ` · ${name}` : ''}</button>`
    })}</div>` : null}
  </section>`
}

function AssistantHistoryNotice({ status }) {
  const warning = typeof status?.warning === 'string' ? status.warning.slice(0, 500) : ''
  return warning.trim() ? html`<p class="assistant-route-preview" role="status" aria-label="Chat history">${warning}</p>` : null
}

export function ChatPanel() {
  const s = useStore()
  const hosted = s.caps.host === 'browser-local'
  const playhead = useTime()
  const draftRoot = s.root
  const draft = assistantDraft(s), text = draft.text
  const draftContext = assistantDraftContext(s)
  const commitDraft = value => { assistantDrafts.set(value.root, value); set({ assistantDraft: value }) }
  const setText = (value, kind) => { if (assistantDraftIsCurrent(draftContext, store)) commitDraft(updatedAssistantDraft(store, value, kind)) }
  useEffect(() => {
    const saved = assistantDrafts.get(draftRoot)
    if (saved && store.root === draftRoot && store.assistantDraft !== saved) set({ assistantDraft: saved })
  }, [draftRoot])
  const [importing, setImporting] = useState(false)
  const scriptImport = useRef(null), scriptPicker = useRef(null)
  if (!scriptImport.current) scriptImport.current = createAssistantScriptImport({ state: () => store, commit: commitDraft, report: toast, reading: setImporting })
  useEffect(() => () => scriptImport.current.dispose(), [])
  const [pending, setPending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [sharingReview, setSharingReview] = useState(null)
  const [now, setNow] = useState(Date.now())
  const sending = useRef(false), dispatching = useRef(false)
  const sharingGate = useRef(null), stopAction = useRef(null)
  if (!sharingGate.current) sharingGate.current = createAssistantSharingGate({ api,
    present: review => {
      setSharingReview(review)
      set({ assistantSharingReview: review, assistantSharingActions: review ? { allow: () => sharingGate.current.allow(), decline: () => sharingGate.current.cancel(), stop: () => stopAction.current?.() } : null })
    },
    busy: value => { setPending(value); set({ assistantSharingBusy: value }) },
  })
  useEffect(() => () => { sharingGate.current.dispose(); set({ assistantSharingReviewOpen: false, assistantSharingReview: null, assistantSharingActions: null, assistantSharingBusy: false }) }, [])
  // The browser server reports the pending preview and the latest assistant change. The native host keeps its own flow.
  const runReview = s.caps.host === 'native' ? null : s.assistantReview
  const sameRun = id => id != null && id === s.claude?.runId
  const activity = assistantActivity(s.claude, { connected: s.connected, pending, stopping, now, ...(runReview ? {
    proposal: Boolean(runReview.proposal) && (runReview.proposal.runId == null || s.claude?.runId == null || sameRun(runReview.proposal.runId)),
    edits: runReview.change?.kind === 'request' && sameRun(runReview.change.runId) && runReview.change.edits > 0,
  } : {}) })
  useEffect(() => {
    if (!activity.active) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [activity.active])
  const native = s.caps.host === 'native'
  const list = useRef(null)
  const composing = useRef(false), composer = useRef(null), follow = useRef(true)
  // A press outside an open composer menu closes it, as does sending or focus leaving it.
  const closeComposerMenus = keep => composer.current?.closest?.('.assistant-composer-card')?.querySelectorAll('.assistant-input-tools details[open]').forEach(menu => { if (menu !== keep) menu.open = false })
  useEffect(() => {
    const page = globalThis.document
    if (!page?.addEventListener) return
    const dismiss = event => closeComposerMenus(event.target?.closest?.('.assistant-input-tools details'))
    page.addEventListener('pointerdown', dismiss, true)
    return () => page.removeEventListener('pointerdown', dismiss, true)
  }, [])
  const leaveComposerMenu = event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false
  }
  // A press focuses a scroll region. Hand focus back on release so timeline shortcuts keep working; Tab focus stays.
  const releasePointerFocus = event => {
    const region = event.currentTarget, page = globalThis.document
    page?.addEventListener?.('mouseup', () => { if (page.activeElement === region) region.blur() }, { once: true, capture: true })
  }
  const closePanel = () => {
    scriptImport.current.cancel()
    set({ chatOpen: false, chatCollapsed: false })
    globalThis.document?.getElementById('ask-arya')?.focus()
  }
  // The person's own message, a new preview, an apply, an undo bar or the end of a run brings the list to its end.
  const lastOwnAt = [...s.chat].reverse().find(m => ['user', 'you'].includes(m.role))?.at
  useEffect(() => { follow.current = true }, [lastOwnAt, s.assistantReview?.proposal?.id, s.assistantReview?.applying?.id, s.assistantReview?.change?.id, activity.terminal])
  useEffect(() => {
    const hasUpdates = s.chat.length || s.activity.length || s.receipts.length || activity.active || activity.terminal || s.assistantReview
    if (hasUpdates && list.current && follow.current) list.current.scrollTop = list.current.scrollHeight
  }, [s.chat, s.claude.text, activity.state, s.activity, s.receipts, s.assistantReview])

  const send = async (msg = text) => {
    if (!assistantDraftIsCurrent(draftContext, store)) return
    const body = msg.trim()
    if (!body && !s.refs.length || sending.current || activity.active || !s.connected) return
    if (body.length > inputLimit) return toast(`Use at most ${inputLimit} characters for this assistant.`, 'error')
    const captured = draftContext, inputKind = draft.inputKind
    sending.current = true
    set({ assistantSharingReviewOpen: true, settingsOpen: false })
    setPending(true)
    try {
      const consumedRefs = new Map((store.refs ?? []).map(ref => [ref, JSON.stringify(ref)]))
      const request = assistantPrompt(body || 'Look at what I referenced.', store, time.t, inputKind)
      const permit = await sharingGate.current.request()
      if (!permit?.valid() || !assistantDraftIsCurrent(captured, store)) return
      setPending(true)
      dispatching.current = true
      await api('/api/bridge/send', { ...request, sharing: permit.sharing, ...(store.caps?.host !== 'native' && store.assistantPreview !== false ? { review: true } : {}) })
      if (captured.draft && assistantDrafts.get(captured.root) === captured.draft) {
        assistantDrafts.set(captured.root, { ...captured.draft, text: '' })
      }
      if (assistantDraftIsCurrent(captured, store)) {
        setText('')
        set({ refs: store.refs.filter(ref => !consumedRefs.has(ref) || consumedRefs.get(ref) !== JSON.stringify(ref)) })
      }
    } catch (error) {
      toast(error.message, 'error')
    } finally {
      sending.current = false; dispatching.current = false
      set({ assistantSharingReviewOpen: false })
      setPending(false)
      setNow(Date.now())
    }
  }
  const stop = async () => {
    sharingGate.current.cancel()
    if (!dispatching.current && !activity.canStop) return
    setStopping(true)
    try { await api('/api/assistant/cancel', {}) }
    catch (error) { toast(error.message, 'error') }
    finally { setStopping(false); setNow(Date.now()) }
  }
  stopAction.current = stop
  const working = activity.active
  const runActive = assistantActivity(s.claude, { connected: s.connected, now }).active
  const connection = s.assistantStatus ?? (native ? s.caps.assistant : null)
  const status = assistantState(connection)
  const inputLimit = native && connection?.provider === 'anthropic' && connection?.mode !== 'auto' ? 32000 : 128000
  const refreshAvailability = async () => {
    if (refreshing || connection?.loading || working || !s.connected) return
    setRefreshing(true)
    try { await refreshAssistantStatus({ refresh: true }) }
    catch (error) { toast(error.message, 'error') }
    finally { setRefreshing(false) }
  }
  // Until the first status answer arrives, nothing is known. Show that, not the setup card.
  const checking = status.checking && !s.assistantStatusError
  const canSend = status.ready && s.connected && !working
  const name = connection?.providerName ?? providerName(connection?.provider)
  // Sign in with ChatGPT appears only when this editor's server holds the account.
  const chatgpt = connection?.chatgpt?.supported === true ? connection.chatgpt : null
  const providerFailure = !status.ready && connection?.provider !== 'chatgpt' && status.detail?.installed === true
  // A completed sign-in cancellation belongs to the project where it happened.
  const signInState = chatgpt?.attempt?.state
  signInNotice ??= { root: s.root, project: s.project, state: signInState, dismissed: false }
  if (signInNotice.root !== s.root || signInNotice.project !== s.project) {
    signInNotice.dismissed ||= signInNotice.state === 'cancelled' && signInState === 'cancelled'
    signInNotice.root = s.root
    signInNotice.project = s.project
  }
  if (signInState !== 'cancelled' || signInNotice.state !== 'cancelled') signInNotice.dismissed = false
  signInNotice.state = signInState
  const showSignInNotice = signInState !== 'cancelled' || !signInNotice.dismissed
  const chatgptUsage = typeof chatgpt?.usageURL === 'string' && chatgpt.usageURL.startsWith('https://chatgpt.com/') ? chatgpt.usageURL : 'https://chatgpt.com/settings/usage'
  const chatgptWaiting = ['waiting', 'exchanging'].includes(chatgpt?.attempt?.state)
  const chatgptCurrent = chatgpt?.accounts?.find(item => item.active) ?? null
  const chatgptPlan = Boolean(chatgpt?.planUsage) && connection?.provider === 'chatgpt' && connection?.mode !== 'auto'
  const chatgptCode = typeof s.claude?.errorCode === 'string' && s.claude.errorCode.startsWith('chatgpt_') ? s.claude.errorCode : ''
  const chatgptTask = action => async () => { try { await action() } catch (error) { toast(error.message, 'error') } }
  // The one ChatGPT step that applies now. It is the primary action in setup and a second action beside Refresh.
  const chatgptAction = !chatgpt || chatgptWaiting ? null
    : !chatgpt.signedIn ? ['Continue with ChatGPT', () => startChatGPTSignIn({})]
    : !chatgpt.planUsage ? ['Turn on ChatGPT plan usage', () => startChatGPTSignIn({ ...(chatgptCurrent ? { account: chatgptCurrent.id } : {}), enablePlan: true })]
    : connection.provider !== 'chatgpt' || connection.mode === 'auto' ? ['Use ChatGPT', () => chooseChatGPTAssistant(connection)] : null
  const timeline = s.openComp ? s.project?.comps?.[s.openComp] : s.project
  const selectedObjects = (timeline?.tracks ?? []).flatMap(track => (track.clips ?? []).map(clip => ({ clip, track })))
  const selection = s.selection.map(id => {
    const transition = id.startsWith('tr:')
    const object = selectedObjects.find(({ clip }) => clip.id === (transition ? id.slice(3) : id))
    const clip = object?.clip
    const label = clip?.label ?? (clip?.kind === 'title' ? clip.title?.text : clip?.kind === 'color' ? 'Color' : clip?.kind === 'adjustment' ? 'Adjustment' : String(clip?.src ?? clip?.kind ?? '').split('/').pop())
    return { id, label: transition ? label ? `Transition into ${label}` : `Transition ${id.slice(3)}` : label || id,
      track: object ? object.track.name ? `${object.track.name} (${object.track.id})` : object.track.id : null }
  })
  const quick = assistantPanel.suggestions(s.project, { selection: s.selection, comp: s.openComp })
  // Suggestions populate an empty draft as a prompt.
  const showSuggestions = canSend && quick.length > 0 && !text.trim()
  const lastRequest = [...s.chat].reverse().find(m => ['user', 'you'].includes(m.role) && m.text)?.text ?? ''
  const view = assistantPanel.focus(s.project, { comp: s.openComp, playhead })
  const scopeName = s.openComp ? s.project?.comps?.[s.openComp]?.name ? `${s.project.comps[s.openComp].name} (${s.openComp})` : s.openComp : 'Main timeline'
  // Preview changes and one-step undo need the browser server; the native host keeps its own flow.
  const preview = !native && s.assistantPreview !== false
  const review = native ? null : s.assistantReview
  const [reviewBusy, setReviewBusy] = useState('')
  const decide = async (kind, route, body) => {
    if (reviewBusy) return
    const undoneChange = kind === 'undo' ? store.assistantReview?.change : null, root = store.root
    setReviewBusy(kind)
    try {
      await api(route, body)
      if (undoneChange?.id === body?.id && store.root === root) set({ receipts: store.receipts.map(receipt => receipt.version > undoneChange.beforeVersion && receipt.version <= undoneChange.afterVersion ? { ...receipt, undone: true } : receipt) })
    }
    catch (error) { toast(error.message, 'error') }
    finally { setReviewBusy('') }
  }
  const focusComposer = () => composer.current?.focus()
  const setPreview = on => {
    set({ assistantPreview: on })
    try { globalThis.localStorage?.setItem('arya.assistant.preview', on ? 'on' : 'off') } catch { /* The choice still applies to this session. */ }
  }
  const feed = [
    ...s.chat.map(m => ({ ...m, type: 'chat' })),
    ...s.activity.filter(a => ['claude', 'agent', 'assistant'].includes(a.who)).map(a => ({ type: 'act', text: a.text, at: a.at ?? 0 })),
    ...s.receipts.map(receipt => ({ type: 'receipt', receipt, at: receipt.at })),
  ].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))

  // Collapse consecutive tool updates without moving them past a message or edit.
  const conversation = []
  for (const entry of feed) {
    const previous = conversation.at(-1)
    if (entry.type !== 'act') conversation.push(entry)
    else if (previous?.type === 'tools') previous.updates.push(entry)
    else conversation.push({ ...entry, type: 'tools', updates: [entry] })
  }
  const inputLocked = working || Boolean(sharingReview)
  const needsRefresh = status.refreshRequired || providerFailure
  const openSettings = (other = false) => {
    if (!store.assistantSharingReviewOpen) set({ settingsOpen: true, ...(other ? { settingsOtherWays: true } : {}) })
  }
  const closeComposerMenu = event => {
    if (event.key !== 'Escape' || !event.currentTarget.open) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.open = false
    event.currentTarget.querySelector('summary')?.focus()
  }

  // On a phone the sheet can drop to a one-line bar so the timeline is reachable. The draft and the list stay mounted.
  const collapsed = s.chatCollapsed === true
  const headStatus = activity.terminal || working || !s.connected ? activity.label : status.ready ? name : checking ? 'Checking' : status.refreshRequired ? 'Needs refresh' : 'Not set up'
  const runDone = !working && s.connected && activity.state === 'done'

  if (hosted) return html`<section class="panel chat assistant-unavailable" id="editor-assistant" aria-label="Assistant">
    <div class="chat-head"><div class="chat-title"><b>Assistant</b><span class="muted">Unavailable in beta</span></div><button class="ghost tiny" aria-label="Close assistant" onClick=${closePanel}><${Icon} name="close" /></button></div>
    <div class="chat-list"><div class="assistant-setup"><b>Use Assistant in Arya for Mac</b><p>Assistant is also available in the local editor.</p><div class="assistant-setup-actions"><a class="button primary" href="https://editwitharya.app/download/#mac" target="_blank" rel="noopener noreferrer">Download for Mac</a><a class="settings-link" href="https://editwitharya.app/install/#accounts" target="_blank" rel="noopener noreferrer">Run locally</a></div></div></div>
  </section>`

  return html`
    <section class=${`panel chat${collapsed ? ' collapsed' : ''}`} id="editor-assistant" aria-label="Assistant">
      <div class="chat-head">
        <div class="chat-title" onClick=${collapsed ? () => set({ chatCollapsed: false }) : undefined}>
          <span class=${`claude-dot ${working ? 'busy' : status.ready ? 'ok' : 'off'}`}></span>
          <b>Assistant</b>
          <span class="muted">${headStatus}</span>
          ${collapsed && text.trim() ? html`<span class="muted chat-draft-note">Draft kept</span>` : null}
        </div>
        <button class="ghost tiny chat-settings" aria-label="Assistant settings" title="Assistant settings" disabled=${pending || Boolean(sharingReview)} onClick=${() => openSettings()}>Settings</button>
        <button class="ghost tiny chat-collapse" aria-label=${collapsed ? 'Expand assistant' : 'Minimize assistant'} title=${collapsed ? 'Expand assistant' : 'Minimize to reach the timeline. Your draft is kept.'} aria-expanded=${!collapsed} onClick=${() => set({ chatCollapsed: !collapsed })}><${Icon} name=${collapsed ? 'chevron-up' : 'chevron-down'} /></button>
        <button class="ghost tiny" aria-label="Close assistant" onClick=${closePanel}><${Icon} name="close" /></button>
      </div>
      <div class="chat-list" role="group" aria-label="Conversation" tabIndex="0" ref=${list} onMouseDown=${releasePointerFocus} onScroll=${event => {
        const el = event.currentTarget
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}>
        <${AssistantHistoryNotice} status=${s.chatHistory} />
        ${s.caps.assistant?.pluginSession ? html`<p class="assistant-plugin-note">Typing here starts a separate ${name} run. To use this Claude session, ask in the terminal.</p>` : null}
        ${chatgpt?.welcome ? html`<section class="assistant-setup chatgpt-welcome" aria-labelledby="chatgpt-welcome-heading"><b id="chatgpt-welcome-heading">You’re using your ChatGPT plan</b><p>Eligible AI requests in Arya use your ChatGPT plan or credits balance. Check and manage usage in your ChatGPT settings.</p><button class="primary" onClick=${chatgptTask(() => chatgptAccountAction('welcome'))}>Got it</button><a class="button" href=${chatgptUsage} target="_blank" rel="noopener noreferrer">Manage usage ↗</a></section>` : null}
        ${status.ready && !working && !conversation.length && !text.trim() ? html`<div class="chat-empty">
          <p>Ask for an edit, or ask a question about this project.</p>
        </div>` : null}
        ${conversation.map(m => m.type === 'receipt' ? html`<${ChangeReceipt} key=${`edit-${m.receipt.version}-${m.at}`} receipt=${m.receipt} />` : m.type === 'tools'
          ? html`<details class="assistant-tool-card" key=${`tools-${m.at}-${m.text}`}><summary>${m.updates.length} tool ${m.updates.length === 1 ? 'update' : 'updates'}</summary>
              <ul>${m.updates.map(update => html`<li>${update.text}</li>`)}</ul>
            </details>`
          : html`<div class=${`msg ${['user', 'you'].includes(m.role) ? 'user' : 'claude'}`}>
              <span class="sr-only">${['user', 'you'].includes(m.role) ? 'You' : 'Assistant'}</span>
              ${m.refs?.length ? html`<div class="msg-refs">${m.refs.map(r => html`<span class="chip small"><${Icon} name="attach" size=${14} /> ${r.label}</span>`)}</div>` : null}
              <div class="msg-body" dangerouslySetInnerHTML=${{ __html: md(m.text) }}></div>
              ${['user', 'you'].includes(m.role) ? html`<button class="ghost tiny assistant-edit-request" disabled=${working || Boolean(text) || !m.text} title="Restore this text as a draft with the current selection. Clear the existing draft first." onClick=${() => { setText(m.text); focusComposer() }}>Edit request</button>` : null}
            </div>`)}
        ${working && runActive && s.claude.text ? html`<div class="msg claude assistant-stream"><small>Response in progress</small><div class="msg-body" dangerouslySetInnerHTML=${{ __html: md(s.claude.text) }}></div></div>` : null}
        ${working || activity.terminal || !s.connected ? html`<div class=${`assistant-run ${working ? 'active' : activity.state}${runDone && !activity.detail ? ' silent' : ''}`}>
          <div class="assistant-run-heading"><span class="assistant-run-symbol" aria-hidden="true">${!s.connected ? '↻' : working ? '◌' : activity.state === 'done' ? '↵' : activity.state === 'error' ? '!' : '■'}</span><b role="status">${activity.label}</b>${activity.elapsed ? html`<span class="assistant-run-time">${activity.elapsed}</span>` : null}</div>
          ${activity.detail ? html`<p>${activity.detail}</p>` : null}
          ${activity.connectionNotice ? html`<p>${activity.connectionNotice}</p>` : null}
          ${!working && activity.state === 'error' && chatgptCode === 'chatgpt_usage_limit' ? html`<div class="assistant-plan-error"><b>Usage limit reached</b><p>ChatGPT account: ${chatgpt?.email || 'your signed-in account'}. Check your usage, then try again later.</p><a class="button primary" href=${chatgptUsage} target="_blank" rel="noopener noreferrer">Manage usage ↗</a></div>` : null}
          ${!working && activity.state === 'error' && ['chatgpt_sign_in_required', 'chatgpt_not_authorized', 'chatgpt_plan_disabled', 'chatgpt_account_changed', 'chatgpt_not_eligible'].includes(chatgptCode) ? html`<div class="assistant-plan-error"><button class="ghost tiny" onClick=${() => set({ settingsOpen: true })}>Review ChatGPT sign-in</button></div>` : null}
          ${activity.state === 'error' && !working && lastRequest ? html`<button class="ghost tiny assistant-retry" disabled=${Boolean(text)} title="Put the failed request back in the text box to edit or send again. Clear the current draft first." onClick=${() => { setText(lastRequest); focusComposer() }}>Edit and retry</button>` : null}
        </div>` : null}
        ${(!working || runActive) && s.claude.routing?.ok ? html`<div class="assistant-route" role="group" aria-label=${runActive ? 'Current request route' : 'Last request route'}><small class="muted">${runActive ? 'Current request route' : 'Last request route'}</small><${RoutingReceipt} value=${s.claude.routing} /></div>` : null}
        ${review?.proposal ? html`<${assistantPanel.PreviewCard} proposal=${review.proposal} project=${s.project} version=${s.version} running=${runActive} newRequest=${Boolean(runActive && review.runId && review.runId !== review.proposal.runId)} busy=${reviewBusy}
          onApply=${() => decide('apply', '/api/assistant/proposal/apply', { id: review.proposal.id })} onDiscard=${() => decide('discard', '/api/assistant/proposal/discard', { id: review.proposal.id })} />` : null}
        ${review?.applying ? html`<${assistantPanel.ApplyingCard} applying=${review.applying} onDismiss=${() => decide('discard', '/api/assistant/proposal/discard', { id: review.applying.id })} />` : null}
        ${review?.change && !runActive && !(review?.applying && !review.applying.finished) ? html`<${assistantPanel.ChangeBar} change=${review.change} busy=${reviewBusy} onUndo=${() => decide('undo', '/api/assistant/change/undo', { id: review.change.id })} />` : null}
        ${checking ? html`<p class="assistant-checking" role="status"><span class="assistant-run-symbol" aria-hidden="true">◌</span>Checking your assistant…</p>` : !status.ready ? html`<section class="assistant-setup" aria-label="Assistant setup">
          <b>${chatgptWaiting ? 'Waiting for ChatGPT sign-in' : status.refreshRequired ? status.label : providerFailure ? `${name}: ${status.label}` : 'Connect your editing assistant'}</b>
          <p>${chatgptWaiting ? 'Finish signing in on the ChatGPT page.' : needsRefresh ? status.reason
            : chatgpt?.signedIn && !chatgpt.planUsage ? 'Turn on ChatGPT plan usage for this sign-in.'
            : chatgpt?.signedIn && connection.provider === 'chatgpt' && connection.mode !== 'auto' ? connection.reason ?? 'Refresh ChatGPT status in Settings.'
            : chatgpt ? 'Use your ChatGPT plan for eligible requests. You can keep editing without an account.'
            : connection?.reason ?? (s.assistantStatusError || 'Choose a provider in Assistant settings. You can keep editing without an account.')}</p>
          ${showSignInNotice && !chatgptWaiting && ['failed', 'cancelled', 'expired'].includes(signInState) && chatgpt.attempt.message ? html`<p role="status">${chatgpt.attempt.message}</p>` : null}
          ${text.trim() ? html`<p>Your draft is kept.</p>` : null}
          <div class="assistant-setup-actions">
            ${chatgptWaiting ? html`${chatgpt.attempt?.startURL ? html`<a class="button primary" href=${chatgpt.attempt.startURL} target="_blank" rel="noopener noreferrer">Open the sign-in page ↗</a>` : null}<button onClick=${chatgptTask(() => chatgptAccountAction('cancel'))}>Cancel sign-in</button>`
            : needsRefresh ? html`<button class="primary" disabled=${refreshing || connection?.loading || working || !s.connected} onClick=${refreshAvailability}>${refreshing || connection?.loading ? 'Refreshing…' : status.refreshRequired ? 'Refresh availability' : 'Refresh status'}</button>`
            : chatgptAction ? html`<button class="primary" disabled=${working} onClick=${chatgptTask(chatgptAction[1])}>${chatgptAction[0]}</button>`
            : html`<button class="primary" onClick=${() => openSettings()}>Assistant settings</button>`}
            ${needsRefresh && chatgptAction ? html`<button disabled=${working} onClick=${chatgptTask(chatgptAction[1])}>${chatgptAction[0]}</button>` : null}
            ${chatgpt ? html`<button class="ghost settings-link" onClick=${() => openSettings(true)}>Other ways to connect</button>`
            : needsRefresh ? html`<button class="ghost settings-link" onClick=${() => openSettings()}>Assistant settings</button>` : null}
          </div>
        </section>` : null}
        ${showSuggestions && !review?.proposal && !(review?.applying && !review.applying.finished) ? html`<div class=${`assistant-suggestions${conversation.length ? ' compact' : ''}`} role="group" aria-label="Suggested requests">${quick.map(item => html`<button class="assistant-suggestion" key=${item.id} disabled=${working} title=${item.prompt} onClick=${() => { setText(item.prompt, 'prompt'); focusComposer() }}>${item.label}</button>`)}</div>` : null}
      </div>
      <div class="assistant-composer-card" role="group" aria-label="Assistant composer">
        <div class="assistant-field">
          <div class="assistant-field-context">
            <div class="assistant-composer-content" role="group" tabIndex="0" onMouseDown=${releasePointerFocus} aria-label=${working ? 'Next request context' : 'Editing context'}>
              <div class="assistant-context-chips">
                <span class="chip small" title=${scopeName}>${s.openComp ? s.project?.comps?.[s.openComp]?.name ?? 'Current composition' : 'Main timeline'}</span>
                <span class="chip small" title=${view.under.join(', ') || undefined}>${!view.time || view.time === 'unavailable' ? 'Playhead unavailable' : `Playhead ${view.time}`}</span>
              </div>
              ${native ? null : html`<label class="assistant-preview-toggle" title="Show the clips and settings a request will change, and apply them only when you choose"><input type="checkbox" checked=${preview} disabled=${inputLocked} onChange=${e => setPreview(e.target.checked)} /><span>Preview changes</span></label>`}
              ${selection.length ? html`<div class="assistant-selection-chips" role="group" aria-label="Current selection included when sending">${selection.map(item => html`<span class="chip small" key=${item.id}><b>${item.label}</b>${item.track || item.id !== item.label ? html`<small>${item.id}${item.track ? ` · ${item.track}` : ''}</small>` : null}</span>`)}</div>` : null}
              ${s.refs.length ? html`<div class="refs" role="group" aria-label="Attached references">${s.refs.map(r => html`<span class="chip"><${Icon} name="attach" size=${14} /> ${r.label}<button aria-label=${`Remove reference ${r.label}`} onClick=${() => set({ refs: s.refs.filter(x => x !== r) })}><${Icon} name="close" size=${14} /></button></span>`)}</div>` : null}
            </div>
          </div>
          <div class="composer">
            <textarea ref=${composer} rows="2" aria-label="Message your editing assistant" maxLength=${inputLimit} placeholder=${s.selection.length ? 'Ask about or change this selection' : 'Ask for an edit, or ask about the project'} value=${text}
              onInput=${e => setText(e.target.value)}
              onCompositionStart=${() => { composing.current = true }} onCompositionEnd=${() => { composing.current = false }}
              onKeyDown=${e => {
                e.stopPropagation()
                if (composing.current || e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229) return
                // As in the Mac Assistant: ⌘Return always sends; Return sends a prompt but adds a line in a
                // script or screenplay. Shift-Return adds a line.
                if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && (e.metaKey || draft.inputKind === 'prompt')) {
                  e.preventDefault()
                  if (canSend) { closeComposerMenus(); send() }
                  else if (text.trim() && !working) { toast(checking ? 'Still checking your assistant. Your draft is kept.' : 'Connect an assistant to send. Your draft is kept.'); list.current?.querySelector('.assistant-setup :is(button:enabled, a[href])')?.focus() }
                }
              }}></textarea>
          </div>
          <div class="assistant-field-bar">
            <div class="assistant-input-tools" role="group" aria-label="Assistant input">
              <details class="assistant-model-menu" name="assistant-composer-menu" onKeyDown=${closeComposerMenu} onFocusOut=${leaveComposerMenu}>
                <summary>Model</summary>
                <div class="assistant-model-popover">
                  <${AssistantControls} status=${connection} active=${inputLocked} text=${text} selectionCount=${s.selection.length} />
                </div>
              </details>
              <label class="assistant-input-kind"><select aria-label="Assistant input kind" value=${draft.inputKind} disabled=${inputLocked} onChange=${e => setText(text, e.target.value)}><option value="prompt">Prompt</option><option value="script">Script</option><option value="screenplay">Screenplay</option></select></label>
              <label class="assistant-script-import"><span>Import text</span><input type="file" aria-label="Import script or screenplay" accept=".txt,.md,.fountain,.script,.screenplay,text/plain,text/markdown" disabled=${inputLocked || importing || !s.project}
                onClick=${() => { scriptPicker.current = scriptImport.current.begin() }}
                onChange=${e => { const captured = scriptPicker.current; scriptPicker.current = null; const file = e.target.files?.[0]; e.target.value = ''; return scriptImport.current.consume(file, captured) }}
                onCancel=${() => { scriptImport.current.cancel(scriptPicker.current); scriptPicker.current = null }} /></label>
              <details class="assistant-input-help" name="assistant-composer-menu" onKeyDown=${closeComposerMenu} onFocusOut=${leaveComposerMenu}><summary aria-label="Input tips">?</summary>
                <div class="assistant-model-popover">
                  <p class="assistant-composer-hint">⌥-click a clip, keyframe, track, marker or inspector field to attach it.</p>
                  <p class="assistant-composer-hint">Press / anywhere to type here · ${draft.inputKind === 'prompt' ? 'Return to send · Shift+Return for a new line' : '⌘Return to send · Return for a new line'} · ${inputLimit.toLocaleString()} character limit.</p>
                  <p class="assistant-composer-hint">Import UTF-8 text up to 512 KiB. Files stay in the draft until you send.</p>
                </div>
              </details>
            </div>
            <div class="assistant-primary-action"><button
              class=${working ? 'assistant-stop' : 'send'}
              aria-label=${working ? activity.state === 'cancelling' ? 'Stopping…' : 'Stop request' : 'Send message'}
              title=${working ? activity.state === 'cancelling' ? 'Stopping…' : 'Stop request' : draft.inputKind === 'prompt' ? 'Send (Return)' : 'Send (⌘Return)'}
              disabled=${working ? !pending && !activity.canStop : Boolean(sharingReview) || !canSend || text.length > inputLimit || !text.trim() && !s.refs.length}
              onClick=${working ? stop : () => { closeComposerMenus(); return send() }}><${Icon} name=${working ? 'stop' : 'send'} size=${18} /></button></div>
          </div>
        </div>
        ${importing ? html`<div class="assistant-import-status"><span role="status">Reading text file…</span><button class="ghost tiny" onClick=${() => scriptImport.current.cancel()}>Cancel import</button></div>` : null}
        ${status.ready && !s.connected && !working && text.trim() ? html`<span class="assistant-plan-note assistant-send-reason" role="status">Reconnect to send. Your draft is kept.</span>` : null}
        ${chatgptPlan && status.ready ? html`<span class="assistant-plan-note">Using ChatGPT plan · <a href=${chatgptUsage} target="_blank" rel="noopener noreferrer">Manage usage ↗</a></span>` : null}
      </div>
    </section>
  `
}
