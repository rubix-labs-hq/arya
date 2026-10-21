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
import { createAssistantSharingGate } from './assistant-sharing.js'
import { assistantDraft, updatedAssistantDraft, assistantDraftContext, assistantDraftIsCurrent, createAssistantScriptImport } from './assistant-script.js'
import { assistantPanel } from './assistant-panel.js'

const html = htm.bind(h)
const assistantDrafts = new Map()

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
  return html`<details class="change-receipt"><summary>${receipt.undone ? 'Undone · Edit' : 'Edit'} ${receipt.version} · ${headline}</summary>
    ${receipt.projectChanges.length ? html`<p class="receipt-meta">${receipt.projectChanges.join(', ')}</p>` : null}
    ${(receipt.scopes ?? []).map(scope => html`<div class="receipt-layer"><b>${scope.name}</b><span class="receipt-meta">${scopeLabel(scope)} · ${scope.status}</span>${scope.asset != null ? html`<p class="receipt-meta">${scope.asset}</p>` : null}<dl>${scope.changes.map(change => html`<dt>${change.property}</dt><dd><span>${change.before}</span><span class="receipt-arrow" aria-label="changed to">→</span><span>${change.after}</span></dd>`)}</dl></div>`)}
    ${receipt.clips.map(clip => html`<div class="receipt-layer"><b>${clip.name}</b><span class="receipt-meta">${clip.compositionName} · ${clip.id} · ${clip.status}</span><dl>${clip.changes.map(change => html`<dt>${change.property}</dt><dd><span>${change.before}</span><span class="receipt-arrow" aria-label="changed to">→</span><span>${change.after}</span></dd>`)}</dl></div>`)}
    ${receipt.truncated ? html`<p class="receipt-meta">Some changes or values are shortened. Showing ${receipt.clips.length} of ${receipt.total} changed layers${receipt.totalScopes == null ? '' : ` and ${(receipt.scopes ?? []).length} of ${receipt.totalScopes} ${receipt.totalAssets ? 'Media and settings' : 'settings'} groups`}.</p>` : null}
    <div class="receipt-actions">${groups.map(comp => {
      const selectable = receiptSelection(receipt, store.project, comp)
      const name = comp == null ? 'main timeline' : store.project?.comps?.[comp]?.name ?? comp
      return html`<button class="ghost tiny" disabled=${!selectable} onClick=${() => select(comp)}>Select changed layers${groups.length > 1 ? ` · ${name}` : ''}</button>`
    })}</div>
    <details class="receipt-json"><summary>Read-only JSON diff</summary><pre>${JSON.stringify({ clips: receipt.clips, scopes: receipt.scopes, projectChanges: receipt.projectChanges, totalLayers: receipt.total, totalScopes: receipt.totalScopes, totalAssets: receipt.totalAssets, truncated: receipt.truncated }, null, 2)}</pre></details>
    <p class="receipt-meta">Undo in the toolbar reverts the latest committed edit.</p>
  </details>`
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
  const activity = assistantActivity(s.claude, { connected: s.connected, pending, stopping, now })
  useEffect(() => {
    if (!activity.active) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [activity.active])
  const native = s.caps.host === 'native'
  const list = useRef(null)
  const composing = useRef(false)
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight
  }, [s.chat.length, s.claude.state, s.activity.length, s.receipts.length])

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
  const canSend = status.ready && s.connected && !working
  const name = connection?.providerName ?? providerName(connection?.provider)
  const transitions = s.selection.filter(id => id.startsWith('tr:')).length
  const context = s.selection.length ? transitions ? `${s.selection.length} selected items · ${transitions} ${transitions === 1 ? 'transition' : 'transitions'}` : `${s.selection.length} selected ${s.selection.length === 1 ? 'clip' : 'clips'}` : s.openComp ? s.project?.comps?.[s.openComp]?.name ?? 'Current composition' : 'Current timeline'
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
  const focusComposer = () => list.current?.parentElement.querySelector('.composer textarea')?.focus()
  const setPreview = on => {
    set({ assistantPreview: on })
    try { globalThis.localStorage?.setItem('arya.assistant.preview', on ? 'on' : 'off') } catch { /* The choice still applies to this session. */ }
  }
  const feed = [
    ...s.chat.map(m => ({ ...m, type: 'chat' })),
    ...s.activity.filter(a => ['claude', 'agent', 'assistant'].includes(a.who)).map(a => ({ type: 'act', text: a.text, at: a.at ?? 0 })),
    ...s.receipts.map(receipt => ({ type: 'receipt', receipt, at: receipt.at })),
  ].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))

  if (hosted) return html`<div class="panel chat"><div class="chat-head"><b>Assistant</b><span class="grow"></span><button class="ghost tiny" aria-label="Close assistant" onClick=${() => set({ chatOpen: false })}><${Icon} name="close" /></button></div><div class="assistant-setup"><b>Not available in the browser beta</b><p>The assistant can edit clips, titles and audio using your own Claude Code or Codex account. Use the Arya Mac app or run the editor locally to connect.</p><a class="button primary" href="https://arya-beta-delta.vercel.app/download/#mac" target="_blank" rel="noopener noreferrer">Download for Mac</a><a class="settings-link" href="https://arya-beta-delta.vercel.app/install/#accounts" target="_blank" rel="noopener noreferrer">Run locally</a></div></div>`

  return html`
    <div class="panel chat">
      <${AssistantHistoryNotice} status=${s.chatHistory} />
      <div class="chat-head">
        <span class=${`claude-dot ${working ? 'busy' : status.ready ? 'ok' : 'off'}`}></span>
        <b>Assistant</b>
        <span class="muted">${activity.terminal || working || !s.connected ? activity.label : status.ready ? name : status.refreshRequired ? 'Needs refresh' : 'Not connected'}</span>
        <span class="grow"></span>
        <button class="ghost tiny" aria-label="Assistant settings" title="Assistant settings" disabled=${pending || Boolean(sharingReview)} onClick=${() => { if (!store.assistantSharingReviewOpen) set({ settingsOpen: true }) }}>Settings</button>
        <button class="ghost tiny" aria-label="Close assistant" onClick=${() => { scriptImport.current.cancel(); set({ chatOpen: false }) }}><${Icon} name="close" /></button>
      </div>
      ${s.caps.assistant?.pluginSession ? html`<p class="assistant-plugin-note">Typing here starts a separate ${name} run. To use this Claude session, ask in the terminal.</p>` : null}
      ${!status.ready ? html`<div class="assistant-setup"><b>${status.refreshRequired ? status.label : 'Connect your editing assistant'}</b><p>${status.refreshRequired ? status.reason : connection?.reason ?? (s.assistantStatusError || 'Connect Claude Code (Claude Pro/Max) or Codex (ChatGPT plan) in Settings.')}</p>${!status.refreshRequired ? html`<p>Connect Claude Code (Claude Pro/Max) or Codex (ChatGPT plan).</p>` : null}${status.refreshRequired ? html`<button disabled=${refreshing || connection?.loading || working || !s.connected} onClick=${refreshAvailability}>${refreshing || connection?.loading ? 'Refreshing…' : 'Refresh availability'}</button>` : null}<button onClick=${() => set({ settingsOpen: true })}>${status.refreshRequired ? 'Assistant settings' : 'Set up assistant'}</button></div>` : null}
      <div class="chat-list" ref=${list}>
        ${feed.length === 0 ? html`<div class="chat-empty">
          <p>${native ? 'Describe the edit you want. Your assistant works with native clips, titles, audio and motion, with undo.' : 'Ask for an edit or a question about this project. With Preview changes on, you see what will change and apply it yourself.'}</p>
        </div>` : null}
        ${feed.map(m => m.type === 'receipt' ? html`<section class="assistant-result-card" aria-label="Committed edit result"><span class="assistant-card-label">${m.receipt.undone ? 'Undone' : 'Committed edit'}</span><${ChangeReceipt} receipt=${m.receipt} /></section>` : m.type === 'act'
          ? html`<article class="assistant-tool-card" aria-label="Assistant update"><span class="assistant-card-label">Assistant update</span><p>${m.text}</p></article>`
          : html`<div class=${`msg ${m.role}`}>
              ${m.refs?.length ? html`<div class="msg-refs">${m.refs.map(r => html`<span class="chip small"><${Icon} name="attach" size=${14} /> ${r.label}</span>`)}</div>` : null}
              <div dangerouslySetInnerHTML=${{ __html: md(m.text) }}></div>
              ${['user', 'you'].includes(m.role) ? html`<button class="ghost tiny assistant-edit-request" disabled=${working || Boolean(text) || !m.text} title="Restore this text as a draft with the current selection. Clear the existing draft first." onClick=${() => { setText(m.text); focusComposer() }}>Edit request</button>` : null}
            </div>`)}
        ${working && runActive && s.claude.text ? html`<div class="msg claude assistant-stream"><small>Response in progress</small><div dangerouslySetInnerHTML=${{ __html: md(s.claude.text) }}></div></div>` : null}
      </div>
      ${working || activity.terminal || !s.connected ? html`<div class=${`assistant-run ${working ? 'active' : activity.state}`} aria-busy=${working}>
        <div class="assistant-run-heading"><span class="assistant-run-symbol" aria-hidden="true">${!s.connected ? '↻' : working ? '◌' : activity.state === 'done' ? '↵' : activity.state === 'error' ? '!' : '■'}</span><b role="status">${activity.label}</b>${activity.elapsed ? html`<span class="assistant-run-time">${activity.elapsed}</span>` : null}</div>
        ${activity.detail ? html`<p>${activity.detail}</p>` : null}
        ${activity.connectionNotice ? html`<p>${activity.connectionNotice}</p>` : null}
        ${activity.state === 'error' && !working && lastRequest ? html`<button class="ghost tiny assistant-retry" disabled=${Boolean(text)} title="Put the failed request back in the text box to edit or send again. Clear the current draft first." onClick=${() => { setText(lastRequest); focusComposer() }}>Edit and retry</button>` : null}
      </div>` : null}
      ${(!working || runActive) && s.claude.routing?.ok ? html`<div class="assistant-route" role="group" aria-label=${runActive ? 'Current request route' : 'Last request route'}><small class="muted">${runActive ? 'Current request route' : 'Last request route'}</small><${RoutingReceipt} value=${s.claude.routing} /></div>` : null}
      ${review?.proposal ? html`<${assistantPanel.PreviewCard} proposal=${review.proposal} project=${s.project} version=${s.version} running=${runActive} newRequest=${Boolean(runActive && review.runId && review.runId !== review.proposal.runId)} busy=${reviewBusy}
        onApply=${() => decide('apply', '/api/assistant/proposal/apply', { id: review.proposal.id })} onDiscard=${() => decide('discard', '/api/assistant/proposal/discard', { id: review.proposal.id })} />` : null}
      ${review?.applying ? html`<${assistantPanel.ApplyingCard} applying=${review.applying} onDismiss=${() => decide('discard', '/api/assistant/proposal/discard', { id: review.applying.id })} />` : null}
      ${review?.change && !runActive && !(review?.applying && !review.applying.finished) ? html`<${assistantPanel.ChangeBar} change=${review.change} busy=${reviewBusy} onUndo=${() => decide('undo', '/api/assistant/change/undo', { id: review.change.id })} />` : null}
      <div class="assistant-composer-card" aria-label="Assistant composer">
      <div class="assistant-composer-content">
      <div class="assistant-context"><span class="context-label">${working ? 'Next request context' : 'Editing context'}</span><b>${context}</b><span class="muted">${scopeName} · Playhead ${view.time}${view.under.length ? ` over ${view.under.slice(0, 2).join(', ')}${view.under.length > 2 ? ` and ${view.under.length - 2} more` : ''}` : ''}</span><span class="muted">${s.refs.length ? `${s.refs.length} references attached` : 'Selection and playhead included'}</span></div>
      ${selection.length ? html`<div class="assistant-selection-chips" aria-label="Current selection included when sending">${selection.map(item => html`<span class="chip small" key=${item.id}><b>${item.label}</b><small>${item.id}${item.track ? ` · ${item.track}` : ''}</small></span>`)}</div>` : null}
      ${s.refs.length ? html`<div class="refs" aria-label="Attached references">${s.refs.map(r => html`<span class="chip"><${Icon} name="attach" size=${14} /> ${r.label}<button aria-label=${`Remove reference ${r.label}`} onClick=${() => set({ refs: s.refs.filter(x => x !== r) })}><${Icon} name="close" size=${14} /></button></span>`)}</div>` : null}
      ${quick.length ? html`<div class="assistant-suggestions" role="group" aria-label="Suggested requests">${quick.map(item => html`<button class="assistant-suggestion" key=${item.id} disabled=${working} title=${`${item.prompt} It goes into the box for you to review before sending.`} onClick=${() => { setText(item.prompt); focusComposer() }}>${item.label}</button>`)}</div>` : null}
      </div>
      <div class="composer">
        <textarea rows="3" aria-label="Message your editing assistant" maxLength=${inputLimit} placeholder=${s.selection.length ? 'Ask about or change this selection' : 'Ask for an edit, or ask about the project'} value=${text}
          onInput=${e => setText(e.target.value)}
          onCompositionStart=${() => { composing.current = true }} onCompositionEnd=${() => { composing.current = false }}
          onKeyDown=${e => {
            e.stopPropagation()
            if (composing.current || e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault()
              if (canSend) send()
              else if (text.trim() && !working) { toast('Connect an assistant to send. Your draft is kept.'); list.current?.parentElement.querySelector('.assistant-setup button:last-child')?.focus() }
            }
          }}></textarea>
      </div>
      ${!canSend && !working ? html`<div class="assistant-send-reason"><span>${!s.connected ? 'Reconnect to send. Your draft is kept.' : status.refreshRequired ? 'Refresh model availability to send. Your draft is kept.' : 'Set up an assistant to send. Your draft is kept.'}</span><button class="ghost tiny" onClick=${status.refreshRequired ? refreshAvailability : () => set({ settingsOpen: true })}>${status.refreshRequired ? 'Refresh availability' : 'Set up assistant'}</button></div>` : null}
      <div class="assistant-composer-footer">
        ${native ? null : html`<label class="assistant-preview-toggle" title="Show the clips and settings a request will change, and apply them only when you choose"><input type="checkbox" checked=${preview} disabled=${working || Boolean(sharingReview)} onChange=${e => setPreview(e.target.checked)} /><span>Preview changes</span></label>`}
        <span class="grow"></span>
        <div class="assistant-primary-action">${working
          ? html`<button class="assistant-stop" disabled=${!pending && !activity.canStop} onClick=${stop}>${activity.state === 'cancelling' ? 'Stopping…' : 'Stop request'}</button>`
          : html`<button class="send" aria-label="Send message" disabled=${Boolean(sharingReview) || !canSend || text.length > inputLimit || !text.trim() && !s.refs.length} onClick=${() => send()}>↑</button>`}</div>
      </div>
      <details class="assistant-options"><summary>Input, model and tips</summary>
      <div class="assistant-input-tools" aria-label="Assistant input">
        <label>Input <select aria-label="Assistant input kind" value=${draft.inputKind} disabled=${working || Boolean(sharingReview)} onChange=${e => setText(text, e.target.value)}><option value="prompt">Prompt</option><option value="script">Script</option><option value="screenplay">Screenplay</option></select></label>
        <label class="assistant-script-import"><span>Import text</span><input type="file" aria-label="Import script or screenplay" accept=".txt,.md,.fountain,.script,.screenplay,text/plain,text/markdown" disabled=${working || Boolean(sharingReview) || importing || !s.project}
          onClick=${() => { scriptPicker.current = scriptImport.current.begin() }}
          onChange=${e => { const captured = scriptPicker.current; scriptPicker.current = null; const file = e.target.files?.[0]; e.target.value = ''; return scriptImport.current.consume(file, captured) }}
          onCancel=${() => { scriptImport.current.cancel(scriptPicker.current); scriptPicker.current = null }} /></label>
      </div>
      <${AssistantControls} status=${connection} active=${working || Boolean(sharingReview)} text=${text} selectionCount=${s.selection.length} />
      <details class="assistant-input-help"><summary>Input tips</summary>
        <p class="assistant-composer-hint">⌥-click a clip, keyframe, track, marker or inspector field to attach it.</p>
        <p class="assistant-composer-hint">Press / anywhere to type here · Enter to send · Shift+Enter for a new line · ${inputLimit.toLocaleString()} character limit.</p>
        <p class="assistant-composer-hint">Import UTF-8 text up to 512 KiB. Files stay in the draft until you send.</p>
        <p class="assistant-composer-hint">If the assistant asks a question, type your choice and the edit you want here, then send a new request.</p>
      </details>
      </details>
      ${importing ? html`<div class="assistant-import-status"><span role="status">Reading text file…</span><button class="ghost tiny" onClick=${() => scriptImport.current.cancel()}>Cancel import</button></div>` : null}
      ${['script', 'screenplay'].includes(draft.inputKind) ? html`<p class="assistant-input-kind-note">Sending as ${draft.inputKind === 'script' ? 'a script' : 'a screenplay'}. Change it in Input, model and tips.</p>` : null}
      </div>
    </div>
  `
}
