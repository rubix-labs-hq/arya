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
  // Escaped first, then code, bold, https links, tables and lists. Local paths show as file names.
  return assistantPanel.messageHTML(text, { root: store.root })
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

// How long a past run took, from its request to its last reply, as the run line shows it.
function elapsedBetween(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ''
  const seconds = Math.floor((end - start) / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

// Which track a receipt scope names, so a card can say "Caption style changed" for a caption track.
function scopeTrack(project, scope) {
  if (scope.track == null) return null
  const timeline = scope.comp == null ? project : project?.comps?.[scope.comp]
  return (timeline?.tracks ?? []).find(track => track.id === scope.track) ?? null
}

/** What a set of receipts changed, in one short line: layers, Media, or which settings. */
function receiptCaption(receipts, project) {
  const layers = new Set(receipts.flatMap(receipt => receipt.clips.map(clip => `${clip.comp ?? ''}:${clip.id}`)))
  const total = Math.max(layers.size, ...receipts.map(receipt => receipt.total ?? 0))
  const assets = receipts.reduce((sum, receipt) => sum + (receipt.totalAssets ?? 0), 0)
  const legacyAssets = receipts.some(receipt => receipt.totalAssets == null && receipt.projectChanges.includes('assets'))
  const scopes = receipts.flatMap(receipt => receipt.scopes ?? []).filter(scope => scope.asset == null && scope.changes.some(change => change.property !== 'Object order'))
  const otherSettings = assets && scopes.length || legacyAssets && receipts.some(receipt => receipt.projectChanges.some(property => property !== 'assets'))
  // Settings alone: a caption track's style, another track's settings, or the project's.
  const tracks = scopes.map(scope => scopeTrack(project, scope))
  const markers = scopes.length > 0 && scopes.every(scope => scope.track == null && scope.changes.every(change => change.property === 'markers' || change.property === 'Object order'))
  const settings = markers ? 'Markers changed' : scopes.length && tracks.every(Boolean) ? tracks.every(track => track.kind === 'caption') ? 'Caption style changed' : 'Track settings changed' : 'Project settings changed'
  return [total ? `${plural(total, 'layer')} changed` : '',
    assets ? `${assets} Media ${assets === 1 ? 'asset' : 'assets'} changed` : legacyAssets ? 'Media assets changed' : '',
    otherSettings ? 'Project or track settings changed' : '',
    !total && !assets && !legacyAssets ? settings : ''].filter(Boolean).join(' · ')
}

function ReceiptDetails({ receipt }) {
  const assetChange = change => change.property === 'assets' || change.property.startsWith('assets.') || change.property.startsWith('assets[')
  const scopeLabel = scope => scope.asset != null ? 'Media registration' : scope.comp == null && scope.track == null && scope.changes.some(assetChange)
    ? scope.changes.every(assetChange) ? 'Media metadata' : 'Media and project settings' : scope.track == null ? 'Project or composition settings' : 'Track settings'
  // A clip added to or removed from a track also reorders it. The layer row already says so.
  const moved = receipt.clips.some(clip => clip.status !== 'changed')
  const scopes = (receipt.scopes ?? []).map(scope => ({ ...scope, changes: moved ? scope.changes.filter(change => change.property !== 'Object order') : scope.changes })).filter(scope => scope.changes.length)
  return html`<div class="receipt-edit" key=${receipt.version}>
    ${scopes.map(scope => html`<div class="receipt-layer"><b>${String(scope.name).replace(/^Track /, '')}</b><span class="receipt-meta">${scopeLabel(scope)} · ${assistantPanel.STATUS[scope.status] ?? scope.status}</span>${assistantPanel.ChangeList({ changes: scope.changes, fps: assistantPanel.fpsOf(store.project, scope.comp) })}</div>`)}
    ${receipt.clips.map(clip => {
      const where = assistantPanel.layerPlace(store.project, clip)
      return html`<div class="receipt-layer"><b title=${clip.id}>${where.name}</b><span class="receipt-meta">${[clip.comp == null ? '' : clip.compositionName, where.place, assistantPanel.STATUS[clip.status] ?? clip.status].filter(Boolean).join(' · ')}</span>${assistantPanel.ChangeList({ changes: clip.changes, fps: assistantPanel.fpsOf(store.project, clip.comp) })}</div>`
    })}
    ${receipt.truncated ? html`<p class="receipt-meta">Some changes or values are shortened. Showing ${receipt.clips.length} of ${receipt.total} changed layers${receipt.totalScopes == null ? '' : ` and ${(receipt.scopes ?? []).length} of ${receipt.totalScopes} ${receipt.totalAssets ? 'Media and settings' : 'settings'} groups`}.</p>` : null}
  </div>`
}

/** The stored names, ids and values of a run's edits, for someone debugging. One disclosure per card. */
function TechnicalDetails({ receipts }) {
  return html`<details class="receipt-json"><summary>Technical details</summary>
    ${receipts.map(receipt => html`<p class="receipt-meta" key=${receipt.version}>Edit ${receipt.version}${receipt.undone ? ' · undone' : ''}${receipt.projectChanges.length ? ` · ${receipt.projectChanges.join(', ')}` : ''}</p>`)}
    <pre>${JSON.stringify(receipts.map(receipt => ({ version: receipt.version, clips: receipt.clips, scopes: receipt.scopes, projectChanges: receipt.projectChanges, totalLayers: receipt.total, totalScopes: receipt.totalScopes, totalAssets: receipt.totalAssets, truncated: receipt.truncated })), null, 2)}</pre>
  </details>`
}

/**
 * A card is named for its kind of change: an applied preview, Undo or Redo the assistant ran, or
 * edits. A request that also called Undo or Redo carries a label that counts each kind of step.
 */
function resultTitle(kind, label, edits, receipts = []) {
  if (kind === 'preview') return 'Applied the preview'
  if ((kind === 'history' || kind === 'request' && label !== 'Assistant request') && label) return label
  // With the receipts in hand the title says what changed; after a reload only the count is known.
  return assistantPanel.changeKinds(receipts).text || `Made ${plural(edits, 'edit')}`
}

/** Compositions the receipts added that still exist and are not open, as [id, name]. */
function addedCompositions(receipts, project, open) {
  const ids = new Set(receipts.flatMap(receipt => (receipt.scopes ?? []).filter(scope => scope.status === 'added' && scope.comp != null && scope.track == null && scope.asset == null).map(scope => scope.comp)))
  return [...ids].filter(id => id !== (open ?? null) && Object.hasOwn(project?.comps ?? {}, id)).map(id => [id, project.comps[id].name ?? id])
}

/**
 * One card per run: what the run changed and what you can do about it. It folds in the one-step
 * undo of the latest assistant change when that change belongs to this run. With no receipt (after
 * a reload) it still offers that undo.
 */
function ResultCard({ receipts = [], change = null, busy = '', onUndo, onRedo = null }) {
  const undoable = Boolean(change?.undoable)
  const undone = !undoable && receipts.length > 0 && receipts.every(receipt => receipt.undone)
  const edits = change ? change.edits : receipts.length
  // Older cards keep their name: each receipt carries the kind of change the server put it in.
  const kinds = new Set(receipts.map(receipt => receipt.changeKind))
  const kind = change ? change.kind : kinds.size === 1 ? receipts[0]?.changeKind : null
  const title = resultTitle(kind, change ? change.label : receipts[0]?.changeLabel, edits, receipts)
  // An applied preview keeps its title, so what it changed goes on the line under it.
  const changed = kind === 'preview' ? assistantPanel.changeKinds(receipts).text : ''
  // The assistant undid or redid edits, and the card cannot simply reverse that: the reason says what can.
  const moved = kind === 'history' || Boolean(change?.moves?.undo || change?.moves?.redo)
  const pointer = moved && change && !undoable && !undone ? change.reason : ''
  const added = undone ? [] : addedCompositions(receipts, store.project, store.openComp)
  const openComposition = id => set({ openComp: id, compParents: { ...(store.compParents ?? {}), [id]: null }, selection: [], page: 'edit', viewerMode: 'timeline', scroll: 0 })
  const caption = [changed, receipts.length ? receiptCaption(receipts, store.project) : ''].filter(Boolean).join(' · ')
  const notes = [...new Set(receipts.flatMap(receipt => receipt.notes ?? []))]
  // Select works on the layers of every edit in the run, one button per timeline they are on.
  const merged = { clips: receipts.flatMap(receipt => receipt.clips) }
  const groups = [...new Set(merged.clips.map(clip => clip.comp))]
  const select = comp => {
    const current = receiptSelection(merged, store.project, comp)
    if (!current) return toast('Those layers are no longer in the project.')
    set({ openComp: current.comp, selection: current.ids, page: 'edit', viewerMode: 'timeline' })
    player.seek(current.start)
  }
  // The card that was just undone offers the way back while Redo in the toolbar would still restore it.
  const redoable = undone && Boolean(onRedo)
  return html`<section class=${`assistant-result-card${undone ? ' undone' : ''}${receipts.length ? '' : ' compact'}`} aria-label=${undone ? 'Undone edit result' : 'Committed edit result'}>
    <div class="receipt-heading"><b>${title}</b>${undone ? html`<small class="assistant-undone-tag">Undone</small>` : null}</div>
    ${caption ? html`<p class="assistant-result-caption">${caption}</p>` : null}
    ${undoable || redoable || groups.length || added.length ? html`<div class="receipt-actions">
      ${added.map(([id, name]) => html`<button class="ghost tiny" key=${id} onClick=${() => openComposition(id)}>Open ${name}</button>`)}
      ${undoable ? html`<span class="assistant-change"><button class="ghost tiny" disabled=${Boolean(busy)} title=${kind === 'history' ? 'Redo the edits the assistant undid. Undo in the toolbar undoes them again.' : 'Restore the project from before this assistant change. Redo brings it back.'} onClick=${onUndo}>${busy === 'undo' ? 'Undoing…' : 'Undo this change'}</button></span>` : null}
      ${redoable ? html`<span class="assistant-change"><button class="ghost tiny" disabled=${Boolean(busy)} title="Bring this change back. Undo in the toolbar removes it again." onClick=${onRedo}>${busy === 'redo' ? 'Redoing…' : 'Redo this change'}</button></span>` : null}
      ${groups.map(comp => {
        const selectable = receiptSelection(merged, store.project, comp)
        const name = comp == null ? 'main timeline' : store.project?.comps?.[comp]?.name ?? comp
        return html`<button class="ghost tiny" disabled=${!selectable} onClick=${() => select(comp)}>Select changed layers${groups.length > 1 ? ` · ${name}` : ''}</button>`
      })}
    </div>` : null}
    ${pointer ? html`<p class="assistant-note">${pointer}</p>` : null}
    ${notes.map(note => html`<p class="assistant-note">${note}</p>`)}
    ${receipts.length ? html`<details class="change-receipt"><summary>Details</summary>
      ${[...receipts].reverse().map(receipt => ReceiptDetails({ receipt }))}
      <p class="receipt-meta">${undone ? 'Redo in the toolbar brings this change back.' : 'Undo in the toolbar reverts the latest edit.'}</p>
      ${TechnicalDetails({ receipts })}
    </details>` : null}
  </section>`
}

/** A run as one quiet line: label, stage and elapsed time. It opens to the tool updates. */
function RunLine({ label, stage, elapsed, state, symbol, detail = '', updates = [], open = false, children = null, live = false }) {
  // The detail opens under the line only when it says more than the stage already does.
  const bare = value => String(value ?? '').replace(/\.$/, '')
  const extra = detail && !(stage && bare(detail).endsWith(bare(stage))) ? detail : ''
  const expandable = Boolean(extra || updates.length || [children].flat(Infinity).some(Boolean))
  const heading = html`<span class="assistant-run-symbol" aria-hidden="true">${symbol}</span><b role=${live ? 'status' : undefined}>${label}</b>${stage ? html`<span class="assistant-run-stage" title=${stage}>${stage}</span>` : null}${elapsed ? html`<span class="assistant-run-time">${elapsed}</span>` : null}`
  if (!expandable) return html`<div class=${`assistant-run ${state}`}><div class="assistant-run-heading">${heading}</div></div>`
  return html`<details class=${`assistant-run ${state}`} open=${open}>
    <summary class="assistant-run-heading">${heading}</summary>
    ${extra ? html`<p>${extra}</p>` : null}
    ${updates.length ? html`<ul class="assistant-run-updates" aria-label="Tool updates">${updates.map(update => html`<li>${update.text}</li>`)}</ul>` : null}
    ${children}
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
  const sending = useRef(false), dispatching = useRef(false), lastSent = useRef(null)
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
  // The server records a change for a run whenever the project moved during it. With none and no
  // commit of its own, a stopped run changed nothing.
  const runCommitted = Array.isArray(s.claude?.committed) && s.claude.committed.length > 0
  const activity = assistantActivity(s.claude, { connected: s.connected, pending, stopping, now, ...(runReview ? {
    proposal: Boolean(runReview.proposal) && (runReview.proposal.runId == null || s.claude?.runId == null || sameRun(runReview.proposal.runId)),
    edits: ['request', 'history'].includes(runReview.change?.kind) && sameRun(runReview.change.runId) && runReview.change.edits > 0,
    unchanged: s.claude?.runId != null && !runCommitted && !sameRun(runReview.change?.runId) && !(runReview.changes ?? []).some(item => sameRun(item.runId)),
  } : {}) })
  useEffect(() => {
    if (!activity.active) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [activity.active])
  const native = s.caps.host === 'native'
  const list = useRef(null)
  const composing = useRef(false), composer = useRef(null), follow = useRef(true), alignedPreview = useRef(null)
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
  // The end of the list. A preview taller than the list shows from its title once, not from its buttons.
  // The list then stops following, as the scroll it makes would report, so later updates leave the
  // reader there. A reader who scrolls down to the buttons is followed at the end again.
  const scrollToEnd = el => {
    const proposal = s.assistantReview?.proposal
    const card = proposal && alignedPreview.current !== proposal.id ? el.querySelector?.('.assistant-preview') : null
    if (card && card.offsetHeight > el.clientHeight) {
      el.scrollTop += card.getBoundingClientRect().top - el.getBoundingClientRect().top
      alignedPreview.current = proposal.id
      follow.current = false
    } else el.scrollTop = el.scrollHeight
  }
  useEffect(() => {
    const hasUpdates = s.chat.length || s.activity.length || s.receipts.length || activity.active || activity.terminal || s.assistantReview
    if (hasUpdates && list.current && follow.current) scrollToEnd(list.current)
  }, [s.chat, s.claude.text, activity.state, s.activity, s.receipts, s.assistantReview, s.chatHistory?.warning])

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
      const options = store.caps?.host !== 'native' && store.assistantPreview !== false ? { review: true } : {}
      const sent = await api('/api/bridge/send', { ...request, sharing: permit.sharing, ...options })
      lastSent.current = { request, options, runId: sent?.runId ?? null }
      // A sent script or screenplay leaves an empty Prompt, so the next message is not read as a script.
      if (captured.draft && assistantDrafts.get(captured.root) === captured.draft) {
        assistantDrafts.set(captured.root, { ...captured.draft, text: '', inputKind: 'prompt' })
      }
      if (assistantDraftIsCurrent(captured, store)) {
        setText('', 'prompt')
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
  // Retry sends the same request again, with the context it had, after a fresh sharing check.
  const retry = async () => {
    const last = lastSent.current
    if (!last || sending.current || activity.active || !s.connected) return
    sending.current = true
    set({ assistantSharingReviewOpen: true, settingsOpen: false })
    setPending(true)
    try {
      const permit = await sharingGate.current.request()
      if (!permit?.valid()) return
      dispatching.current = true
      const sent = await api('/api/bridge/send', { ...last.request, sharing: permit.sharing, ...last.options })
      lastSent.current = { ...last, runId: sent?.runId ?? null }
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
  // A setup card, a sign-in wait or the ChatGPT welcome that arrives under a long conversation is brought into view.
  // The suggestion row is too, for a reader who is already at the end.
  const welcome = Boolean(chatgpt?.welcome)
  useEffect(() => {
    if (list.current && (checking || !status.ready || welcome || follow.current)) scrollToEnd(list.current)
  }, [checking, status.ready, status.refreshRequired, providerFailure, chatgptWaiting, signInState, welcome, showSuggestions])
  const lastRequest = [...s.chat].reverse().find(m => ['user', 'you'].includes(m.role) && m.text)?.text ?? ''
  const view = assistantPanel.focus(s.project, { comp: s.openComp, playhead })
  // A composition that Undo or Redo removed reads as the main timeline, where the store returns.
  const openTimeline = s.openComp && Object.hasOwn(s.project?.comps ?? {}, s.openComp) ? s.project.comps[s.openComp] : null
  const scopeName = openTimeline ? openTimeline.name ? `${openTimeline.name} (${s.openComp})` : s.openComp : 'Main timeline'
  // Preview changes and one-step undo need the browser server; the native host keeps its own flow.
  const preview = !native && s.assistantPreview !== false
  // The Preview setting is kept between requests, so the placeholder and Send say which mode the next request uses.
  const mode = native ? '' : preview ? 'Preview first' : 'Applies directly'
  const review = native ? null : s.assistantReview
  const [reviewBusy, setReviewBusy] = useState('')
  const [undoneChange, setUndoneChange] = useState(null)
  // Whether a change is undone comes from the server, which hears every Undo and Redo.
  const decide = async (kind, route, body) => {
    if (reviewBusy) return
    setReviewBusy(kind)
    try { return await api(route, body) }
    catch (error) { toast(error.message, 'error') }
    finally { setReviewBusy('') }
  }
  const focusComposer = () => composer.current?.focus()
  // Undoing an earlier change is an edit, so it waits until the viewer stops showing a preview.
  const undoChange = () => {
    if (store.previewShown) { toast('Undo is off while the viewer shows the assistant preview. Apply or discard it, or choose Back to project.', 'error'); return }
    const id = store.assistantReview?.change?.id
    return Promise.resolve(decide('undo', '/api/assistant/change/undo', { id })).then(result => { if (Number.isSafeInteger(result?.version) && result.history?.redo > 0) setUndoneChange({ id, version: result.version }) })
  }
  // The change just undone from its card is one Redo away until anything else moves the project.
  const redoChange = () => {
    if (store.previewShown) { toast('Redo is off while the viewer shows the assistant preview. Apply or discard it, or choose Back to project.', 'error'); return }
    return Promise.resolve(decide('redo', '/api/redo', {})).then(() => setUndoneChange(null))
  }
  const redoFor = receipts => undoneChange && s.version === undoneChange.version && s.history?.redo !== 0 && receipts.some(receipt => receipt.changeId === undoneChange.id) ? redoChange : null
  // "Show in viewer": on a phone the sheet covers the viewer, so it drops to its bar; the banner over the viewer has Apply and Discard.
  // The store stamps the project it was shown over and forgets it once it no longer applies.
  const showInViewer = on => {
    set(on ? { previewShown: { id: review?.proposal?.id }, viewerMode: 'timeline' } : { previewShown: null })
    if (on && store.previewShown && globalThis.document?.querySelector('#editor-assistant .chat-collapse')?.getClientRects().length) set({ chatCollapsed: true })
  }
  const shownPreview = Boolean(review?.proposal?.id) && s.previewShown?.id === review.proposal.id
  // The current run's line, and what a failed run saved and how to try again.
  const liveSymbol = !s.connected ? '↻' : working ? '◌' : activity.state === 'done' ? '↵' : activity.state === 'error' ? '!' : '■'
  const liveRunLine = updates => RunLine({ live: true, state: working ? 'active' : activity.state, symbol: liveSymbol, label: activity.label, stage: activity.stage, elapsed: activity.elapsed, detail: activity.detail, updates,
    children: [activity.connectionNotice ? html`<p>${activity.connectionNotice}</p>` : null,
      (!working || runActive) && s.claude.routing?.ok ? html`<div class="assistant-route" role="group" aria-label=${runActive ? 'Current request route' : 'Last request route'}><${RoutingReceipt} value=${s.claude.routing} /></div>` : null] })
  const failureBlock = lastReply => {
    // A stopped request can be sent again as well.
    const stopped = activity.state === 'cancelled'
    if (working || activity.state !== 'error' && !stopped) return null
    const saved = committed.length > 0 && !committed.every(item => lastReply?.text?.includes(item.summary))
    return html`<div class=${`assistant-failure${stopped ? ' stopped' : ''}`}>
              ${chatgptCode === 'chatgpt_usage_limit' ? html`<div class="assistant-plan-error"><b>Usage limit reached</b><p>ChatGPT account: ${chatgpt?.email || 'your signed-in account'}. Check your usage, then try again later.</p><a class="button primary" href=${chatgptUsage} target="_blank" rel="noopener noreferrer">Manage usage ↗</a></div>` : null}
              ${['chatgpt_sign_in_required', 'chatgpt_not_authorized', 'chatgpt_plan_disabled', 'chatgpt_account_changed', 'chatgpt_not_eligible'].includes(chatgptCode) ? html`<div class="assistant-plan-error"><button class="ghost tiny" onClick=${() => set({ settingsOpen: true })}>Review ChatGPT sign-in</button></div>` : null}
              ${saved ? html`<div class="assistant-saved"><b>${stopped ? 'Saved before you stopped it' : 'Saved before the failure'}</b><ul>${committed.map(item => html`<li key=${item.version}>${item.summary}</li>`)}</ul></div>` : null}
              ${lastRequest || canRetry ? html`<div class="assistant-failure-actions">
                ${lastRequest ? html`<button class="ghost tiny assistant-retry" disabled=${Boolean(text)} title=${`Put the ${stopped ? 'stopped' : 'failed'} request back in the text box to edit or send again. Clear the current draft first.`} onClick=${() => { setText(lastRequest); focusComposer() }}>Edit and retry</button>` : null}
                ${canRetry ? html`<button class="ghost tiny assistant-resend" disabled=${pending || !s.connected} title="Send the same request again" onClick=${retry}>Retry</button>` : null}
              </div>` : null}
            </div>`
  }
  // A plain Retry only for the request this panel sent, when it failed on the network or you stopped it.
  const canRetry = (s.claude?.retryable === true || activity.state === 'cancelled') && lastSent.current != null && lastSent.current.runId != null && lastSent.current.runId === s.claude?.runId
  const setPreview = on => {
    set({ assistantPreview: on })
    try { globalThis.localStorage?.setItem('arya.assistant.preview', on ? 'on' : 'off') } catch { /* The choice still applies to this session. */ }
  }
  // A receipt is undone while the server says its change is, so Redo and later changes keep it right.
  const changeState = receipt => receipt.changeId == null ? null : (review?.changes ?? []).find(item => item.id === receipt.changeId)
  const shown = receipt => { const state = changeState(receipt); return state && Boolean(receipt.undone) !== state.undone ? { ...receipt, undone: state.undone } : receipt }
  const feed = [
    ...s.chat.map(m => ({ ...m, type: 'chat' })),
    ...s.activity.filter(a => ['claude', 'agent', 'assistant'].includes(a.who)).map(a => ({ type: 'act', text: a.text, at: a.at ?? 0 })),
    ...s.receipts.map(receipt => ({ type: 'receipt', receipt: shown(receipt), at: receipt.at })),
  ].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  // The conversation as turns. Each starts with your request and holds the replies, tool updates and edits that followed.
  const turns = []
  for (const entry of feed) {
    const own = entry.type === 'chat' && ['user', 'you'].includes(entry.role)
    if (own || !turns.length) turns.push({ at: entry.at ?? 0, request: null, replies: [], updates: [], receipts: [] })
    const turn = turns.at(-1)
    if (own) turn.request = entry
    else if (entry.type === 'chat') turn.replies.push(entry)
    else if (entry.type === 'act') turn.updates.push(entry)
    else turn.receipts.push(entry.receipt)
  }
  const conversation = turns
  // The latest assistant change belongs to the turn whose edits it covers, or else to the latest turn.
  const changeShown = review?.change && !runActive && !(review?.applying && !review.applying.finished) ? review.change : null
  const covers = (change, turn) => turn.receipts.some(receipt => receipt.version > change.beforeVersion && receipt.version <= change.afterVersion)
  let changeTurn = changeShown ? turns.findLastIndex(turn => covers(changeShown, turn)) : -1
  if (changeShown && changeTurn < 0) changeTurn = turns.length - 1
  // Where this server session began, so earlier turns read as history.
  const sessionStart = Number.isFinite(s.session?.startedAt) ? s.session.startedAt : null
  const firstOfSession = sessionStart == null ? -1 : turns.findIndex(turn => turn.at >= sessionStart)
  const liveRun = working || activity.terminal || !s.connected
  const committed = Array.isArray(s.claude?.committed) ? s.claude.committed.filter(item => typeof item?.summary === 'string') : []
  const inputLocked = working || Boolean(sharingReview)
  const needsRefresh = status.refreshRequired || providerFailure
  const refreshButton = kind => html`<button class=${kind || undefined} disabled=${refreshing || connection?.loading || working || !s.connected} onClick=${refreshAvailability}>${refreshing || connection?.loading ? 'Refreshing…' : status.refreshRequired ? 'Refresh availability' : 'Refresh status'}</button>`
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
  // The same status word as the Ask Arya entry. The provider and model are in the composer's model control.
  const headStatus = assistantActivity.statusWord({ connected: s.connected, run: stopping ? { ...s.claude, state: 'cancelling' } : s.claude, pending, ready: status.ready, checking, proposal: Boolean(review?.proposal) })
  const modelName = connection?.mode === 'auto' ? 'Auto' : [name, connection?.model].filter(Boolean).join(' · ')

  if (hosted) return html`<section class="panel chat assistant-unavailable" id="editor-assistant" aria-label="Assistant">
    <div class="chat-head"><div class="chat-title"><b>Assistant</b><span class="muted">Unavailable in beta</span></div><button class="ghost tiny" aria-label="Close assistant" onClick=${closePanel}><${Icon} name="close" /></button></div>
    <div class="chat-list"><div class="assistant-setup"><b>Use Assistant in Arya for Mac</b><p>Assistant is also available in the local editor.</p><div class="assistant-setup-actions"><a class="button primary" href="https://editwitharya.app/download/#mac" target="_blank" rel="noopener noreferrer">Download for Mac</a><a class="settings-link" href="https://editwitharya.app/install/#accounts" target="_blank" rel="noopener noreferrer">Run locally</a></div></div></div>
  </section>`

  return html`
    <section class=${`panel chat${collapsed ? ' collapsed' : ''}`} id="editor-assistant" aria-label="Assistant">
      <div class="chat-head">
        <div class="chat-title" onClick=${collapsed ? () => set({ chatCollapsed: false }) : undefined}>
          <span class=${`claude-dot ${working ? 'busy' : headStatus === 'Failed' ? 'failed' : s.connected && status.ready ? 'ok' : 'off'}`}></span>
          <b>Assistant</b>
          <span class="muted">${headStatus}</span>
          ${collapsed && text.trim() ? html`<span class="muted chat-draft-note">Draft kept</span>` : null}
        </div>
        <button class="ghost tiny chat-settings" aria-label="Assistant settings" title="Assistant settings" disabled=${pending || Boolean(sharingReview)} onClick=${() => openSettings()}><${Icon} name="settings" /></button>
        <button class="ghost tiny chat-collapse" aria-label=${collapsed ? 'Expand assistant' : 'Minimize assistant'} title=${collapsed ? 'Expand assistant' : 'Minimize to reach the timeline. Your draft is kept.'} aria-expanded=${!collapsed} onClick=${() => set({ chatCollapsed: !collapsed })}><${Icon} name=${collapsed ? 'chevron-up' : 'chevron-down'} /></button>
        <button class="ghost tiny" aria-label="Close assistant" onClick=${closePanel}><${Icon} name="close" /></button>
      </div>
      ${/* These two stay pinned under the header, so a long conversation cannot scroll them away. */ null}
      <${AssistantHistoryNotice} status=${s.chatHistory} />
      ${s.caps.assistant?.pluginSession ? html`<p class="assistant-plugin-note">Typing here starts a separate ${name} run. To use this Claude session, ask in the terminal.</p>` : null}
      <div class="chat-list" role="group" aria-label="Conversation" tabIndex="0" ref=${list} onMouseDown=${releasePointerFocus} onScroll=${event => {
        const el = event.currentTarget
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}>
        ${status.ready && !working && !conversation.length && !text.trim() ? html`<div class="chat-empty">
          <p>Ask for an edit, or ask a question about this project.</p>
        </div>` : null}
        ${turns.map((turn, index) => {
          const latest = index === turns.length - 1
          const live = latest && liveRun
          const failed = turn.replies.some(reply => reply.error)
          const lastReply = turn.replies.at(-1)
          const symbol = failed ? '!' : '↵'
          const updates = turn.updates.length ? plural(turn.updates.length, 'tool update') : ''
          const past = turn.updates.length && turn.request && lastReply ? elapsedBetween(turn.request.at, lastReply.at) : ''
          return html`<div class="assistant-turn" key=${`turn-${turn.at}-${index}`}>
            ${index === firstOfSession && index > 0 ? html`<p class="assistant-session-divider" role="separator">New session</p>` : null}
            ${[turn.request, ...turn.replies].filter(Boolean).map(m => html`<div class=${`msg ${['user', 'you'].includes(m.role) ? 'user' : 'claude'}`}>
              <span class="sr-only">${['user', 'you'].includes(m.role) ? 'You' : 'Assistant'}</span>
              ${m.refs?.length ? html`<div class="msg-refs">${m.refs.map(r => html`<span class="chip small"><${Icon} name="attach" size=${14} /> ${r.label}</span>`)}</div>` : null}
              <div class="msg-body" dangerouslySetInnerHTML=${{ __html: md(m.text) }}></div>
              ${['user', 'you'].includes(m.role) ? html`<button class="ghost tiny assistant-edit-request" disabled=${working || Boolean(text) || !m.text} title="Restore this text as a draft with the current selection. Clear the existing draft first." onClick=${() => { setText(m.text); focusComposer() }}>Edit request</button>` : null}
            </div>`)}
            ${live && working && runActive && s.claude.text ? html`<div class="msg claude assistant-stream"><span class="sr-only">Writing…</span><div class="msg-body" dangerouslySetInnerHTML=${{ __html: md(s.claude.text) }}></div></div>` : null}
            ${live ? liveRunLine(turn.updates)
              : turn.updates.length ? RunLine({ state: failed ? 'error' : 'done', symbol, label: failed ? 'Failed' : 'Done', stage: updates, elapsed: past, updates: turn.updates }) : null}
            ${live ? failureBlock(lastReply) : null}
            ${latest && review?.proposal ? html`<${assistantPanel.PreviewCard} proposal=${review.proposal} project=${s.project} version=${s.version} running=${runActive} newRequest=${Boolean(runActive && review.runId && review.runId !== review.proposal.runId)} busy=${reviewBusy} shown=${shownPreview} onShow=${showInViewer}
              onApply=${() => decide('apply', '/api/assistant/proposal/apply', { id: review.proposal.id })} onDiscard=${() => decide('discard', '/api/assistant/proposal/discard', { id: review.proposal.id })} />` : null}
            ${latest && review?.applying ? html`<${assistantPanel.ApplyingCard} applying=${review.applying} onDismiss=${() => decide('discard', '/api/assistant/proposal/discard', { id: review.applying.id })} />` : null}
            ${turn.receipts.length || index === changeTurn ? html`<${ResultCard} receipts=${turn.receipts} change=${index === changeTurn ? changeShown : null} busy=${reviewBusy} onUndo=${undoChange} onRedo=${redoFor(turn.receipts)} />` : null}
          </div>`
        })}
        ${!turns.length && review?.proposal ? html`<${assistantPanel.PreviewCard} proposal=${review.proposal} project=${s.project} version=${s.version} running=${runActive} newRequest=${false} busy=${reviewBusy} shown=${shownPreview} onShow=${showInViewer}
          onApply=${() => decide('apply', '/api/assistant/proposal/apply', { id: review.proposal.id })} onDiscard=${() => decide('discard', '/api/assistant/proposal/discard', { id: review.proposal.id })} />` : null}
        ${!turns.length && review?.applying ? html`<${assistantPanel.ApplyingCard} applying=${review.applying} onDismiss=${() => decide('discard', '/api/assistant/proposal/discard', { id: review.applying.id })} />` : null}
        ${!turns.length && changeShown ? html`<${ResultCard} change=${changeShown} busy=${reviewBusy} onUndo=${undoChange} />` : null}
        ${!turns.length && liveRun ? html`${liveRunLine([])}${failureBlock(null)}` : null}
        ${chatgpt?.welcome ? html`<section class="assistant-setup chatgpt-welcome" aria-labelledby="chatgpt-welcome-heading"><b id="chatgpt-welcome-heading">You’re using your ChatGPT plan</b><p>Eligible AI requests in Arya use your ChatGPT plan or credits balance. Check and manage usage in your ChatGPT settings.</p><button class="primary" onClick=${chatgptTask(() => chatgptAccountAction('welcome'))}>Got it</button><a class="button" href=${chatgptUsage} target="_blank" rel="noopener noreferrer">Manage usage ↗</a></section>` : null}
        ${checking ? html`<p class="assistant-checking" role="status"><span class="assistant-run-symbol" aria-hidden="true">◌</span>Checking your assistant…</p>` : !status.ready ? html`<section class="assistant-setup" aria-label="Assistant setup">
          <b>Set up the assistant</b>
          ${chatgptWaiting || needsRefresh ? html`<p class="assistant-setup-state">${chatgptWaiting ? 'Waiting for ChatGPT sign-in' : status.refreshRequired ? status.label : `${name}: ${status.label}`}</p>` : null}
          <p>${chatgptWaiting ? 'Finish signing in on the ChatGPT page.' : needsRefresh ? status.reason
            : chatgpt?.signedIn && !chatgpt.planUsage ? `Signed in to ChatGPT as ${chatgpt.email || 'your account'}. Plan usage is off for this sign-in.`
            : chatgpt?.signedIn && connection.provider === 'chatgpt' && connection.mode !== 'auto' ? connection.reason ?? 'Refresh ChatGPT status in Settings.'
            : chatgpt?.signedIn ? `Signed in to ChatGPT as ${chatgpt.email || 'your account'}.`
            : chatgpt ? 'Use your ChatGPT plan for eligible requests.'
            : connection?.reason ?? (s.assistantStatusError || 'Choose a provider in Assistant settings.')}</p>
          ${showSignInNotice && !chatgptWaiting && ['failed', 'cancelled', 'expired'].includes(signInState) && chatgpt.attempt.message ? html`<p role="status">${chatgpt.attempt.message}</p>` : null}
          <div class="assistant-setup-actions">
            ${chatgptWaiting ? html`${chatgpt.attempt?.startURL ? html`<a class="button primary" href=${chatgpt.attempt.startURL} target="_blank" rel="noopener noreferrer">Open the sign-in page ↗</a>` : null}<button onClick=${chatgptTask(() => chatgptAccountAction('cancel'))}>Cancel sign-in</button>${needsRefresh ? refreshButton('') : null}`
            : needsRefresh ? refreshButton('primary')
            : chatgptAction ? html`<button class="primary" disabled=${working} onClick=${chatgptTask(chatgptAction[1])}>${chatgptAction[0]}</button>`
            : html`<button class="primary" onClick=${() => openSettings()}>Assistant settings</button>`}
            ${needsRefresh && chatgptAction ? html`<button disabled=${working} onClick=${chatgptTask(chatgptAction[1])}>${chatgptAction[0]}</button>` : null}
            ${chatgpt ? html`<button class="ghost settings-link" onClick=${() => openSettings(true)}>Other ways to connect</button>`
            : needsRefresh ? html`<button class="ghost settings-link" onClick=${() => openSettings()}>Assistant settings</button>` : null}
          </div>
          <p class="assistant-setup-note">Editing works without an account.${text.trim() ? ' Your draft is kept.' : ''}</p>
        </section>` : null}
        ${showSuggestions && !review?.proposal && !(review?.applying && !review.applying.finished) ? html`<div class=${`assistant-suggestions${conversation.length ? ' compact' : ''}`} role="group" aria-label="Suggested requests">${quick.map(item => html`<button class="assistant-suggestion" key=${item.id} disabled=${working} title=${item.prompt} onFocus=${e => e.currentTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })} onClick=${() => { setText(item.prompt, 'prompt'); focusComposer() }}>${item.label}</button>`)}</div>` : null}
      </div>
      <div class="assistant-composer-card" role="group" aria-label="Assistant composer">
        <div class="assistant-field">
          <div class="assistant-field-context">
            <div class="assistant-composer-content" role="group" tabIndex="0" onMouseDown=${releasePointerFocus} aria-label=${working ? 'Next request context' : 'Editing context'}>
              <div class="assistant-context-chips">
                <span class="chip small" title=${scopeName}>${openTimeline ? openTimeline.name ?? s.openComp : 'Main timeline'}</span>
                <span class="chip small" title=${view.under.join(', ') || undefined}>${!view.time || view.time === 'unavailable' ? 'Playhead unavailable' : `Playhead ${view.time}`}</span>
              </div>
              ${native ? null : html`<label class="assistant-preview-toggle" title=${preview ? 'Preview changes: edits wait for Apply' : 'Preview changes is off: edits apply directly'}><input type="checkbox" aria-label="Preview changes" checked=${preview} disabled=${inputLocked} onChange=${e => setPreview(e.target.checked)} /><span>Preview</span></label>`}
              ${selection.length ? html`<div class="assistant-selection-chips" role="group" aria-label="Current selection included when sending">${selection.map(item => html`<span class="chip small" key=${item.id}><b>${item.label}</b>${item.track || item.id !== item.label ? html`<small>${item.id}${item.track ? ` · ${item.track}` : ''}</small>` : null}</span>`)}</div>` : null}
              ${s.refs.length ? html`<div class="refs" role="group" aria-label="Attached references">${s.refs.map(r => html`<span class="chip"><${Icon} name="attach" size=${14} /> ${r.label}<button aria-label=${`Remove reference ${r.label}`} onClick=${() => set({ refs: s.refs.filter(x => x !== r) })}><${Icon} name="close" size=${14} /></button></span>`)}</div>` : null}
            </div>
          </div>
          <div class="composer">
            <textarea ref=${composer} rows="2" aria-label="Message your editing assistant" maxLength=${inputLimit} placeholder=${`${draft.inputKind !== 'prompt' ? 'Paste a script to build editable scenes' : s.selection.length ? 'Ask about or change this selection' : 'Ask for an edit, or ask about the project'}${mode ? ` · ${mode}` : ''}`} value=${text}
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
                <summary title=${modelName ? `Provider and model: ${modelName}` : 'Provider and model'}><span>${modelName || 'Model'}</span></summary>
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
              aria-label=${working ? activity.state === 'cancelling' ? 'Stopping request' : 'Stop request' : 'Send message'}
              title=${working ? activity.state === 'cancelling' ? 'Stopping request' : 'Stop request' : `${draft.inputKind === 'prompt' ? 'Send (Return)' : 'Send (⌘Return)'}${mode ? `. ${preview ? 'Preview first: edits wait for Apply' : 'Applies edits directly'}` : ''}`}
              disabled=${working ? !pending && !activity.canStop : Boolean(sharingReview) || !canSend || text.length > inputLimit || !text.trim() && !s.refs.length}
              onClick=${working ? stop : () => { closeComposerMenus(); return send() }}><${Icon} name=${working ? 'stop' : 'send'} size=${18} />${working ? html`<span>${activity.state === 'cancelling' ? 'Stopping…' : 'Stop'}</span>` : null}</button></div>
          </div>
        </div>
        ${importing ? html`<div class="assistant-import-status"><span role="status">Reading text file…</span><button class="ghost tiny" onClick=${() => scriptImport.current.cancel()}>Cancel import</button></div>` : null}
        ${status.ready && !s.connected && !working && text.trim() ? html`<span class="assistant-plan-note assistant-send-reason" role="status">Reconnect to send. Your draft is kept.</span>` : null}
        ${chatgptPlan && status.ready ? html`<span class="assistant-plan-note">Using ChatGPT plan · <a href=${chatgptUsage} target="_blank" rel="noopener noreferrer">Manage usage ↗</a></span>` : null}
      </div>
    </section>
  `
}
