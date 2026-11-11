import { h } from 'preact'
import { host } from '../host.js'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { api, set, store, toast, useStore } from './store.js'
import { ASSISTANT_PROVIDERS, assistantState, providerName, safeInstallURL } from './assistant-state.js'
import { LayoutMenu } from './layout.js'
import { ModelPool, autoModelPool, manualModelChoices, routingPreferences, routingCapabilities, routingPreferencesForHost, routingPriorityOptions } from './provider-controls.js'
import { registry } from './registry.js'
import { withdrawAssistantSharing } from './assistant-sharing.js'
import { refreshAssistantStatus, startChatGPTSignIn, chatgptAccountAction } from './assistant-status.js'
import { assistantActivity } from './assistant-activity.js'
export { refreshAssistantStatus } from './assistant-status.js'

const html = htm.bind(h)

export function Settings() {
  const s = useStore(), native = s.caps.host === 'native'
  const [section, setSection] = useState('assistant')
  const [provider, setProvider] = useState(s.assistantStatus?.provider ?? 'claude-code')
  const [model, setModel] = useState(s.assistantStatus?.model ?? '')
  const [agent, setAgent] = useState(s.assistantStatus?.agent ?? '')
  const [routing, setRouting] = useState(routingPreferencesForHost(s.assistantStatus))
  const [billingOpen, setBillingOpen] = useState(routing.allowAdditionalSpend || routing.allowAPIBilling)
  const billingPresentation = useRef({ hydrated: Boolean(s.assistantStatus), toggled: false })
  useEffect(() => {
    if (!s.assistantStatus || billingPresentation.current.hydrated) return
    billingPresentation.current.hydrated = true
    const initial = routingPreferencesForHost(s.assistantStatus)
    if (!billingPresentation.current.toggled && (initial.allowAdditionalSpend || initial.allowAPIBilling)) setBillingOpen(true)
  }, [s.assistantStatus])
  const routingSupported = s.assistantStatus?.routingSupported === true
  const capabilities = routingCapabilities(s.assistantStatus)
  const renderedStatus = s.assistantStatus
  const active = assistantActivity(s.claude).active
  const setupPool = autoModelPool(renderedStatus, routing.enabledModels, { ...routing, provider, model, agent: provider === 'claude-code' ? agent : '' })
  const markEdited = () => { edited.current = true; revision.current++; setConflict(null); setCloseGuard(false) }
  const editRouting = changes => { markEdited(); setRouting(value => ({ ...value, ...changes })) }
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(null)
  const savedSnapshot = status => JSON.stringify({ root: store.root ?? '', host: store.caps?.host ?? '', routingSupported: status?.routingSupported === true, preferences: routingPreferences(status) })
  const dialog = useRef(null), mounted = useRef(true), edited = useRef(false), revision = useRef(0), saving = useRef(false), actions = useRef(0), baseline = useRef(s.assistantStatus ? savedSnapshot(s.assistantStatus) : null)
  const renderedRevision = revision.current
  const close = () => set({ settingsOpen: false, settingsOtherWays: false })
  // Closing with ✕, Escape or the backdrop never drops an unsaved draft silently. The footer
  // then offers Save and close or Discard changes; Cancel there discards on purpose.
  const [closeGuard, setCloseGuard] = useState(false)
  const requestClose = () => {
    if (!edited.current) return close()
    setCloseGuard(true)
    dialog.current?.querySelector('.settings-footer .primary')?.focus()
  }
  const hydrate = status => { revision.current++; baseline.current = savedSnapshot(status); setConflict(null); setProvider(status.provider ?? 'claude-code'); setModel(status.model ?? ''); setAgent(status.agent ?? ''); setRouting(routingPreferencesForHost(status)) }
  useEffect(() => {
    if (mounted.current && !edited.current && s.assistantStatus) hydrate(s.assistantStatus)
  }, [s.assistantStatus])
  useEffect(() => {
    const previous = document.activeElement
    dialog.current.querySelector('button')?.focus()
    refreshAssistantStatus().catch(() => {})
    return () => { mounted.current = false; previous?.focus?.() }
  }, [])
  const run = async (name, action) => {
    actions.current++
    setBusy(name); setNotice('')
    try {
      await action()
    } catch (error) { if (mounted.current) setNotice(error.message) }
    finally { actions.current--; if (mounted.current) setBusy('') }
  }
  const reviewSaved = (current, routingChanges = {}, setupModels = null) => { setConflict({ snapshot: savedSnapshot(current), preferences: routingPreferences(current), routingChanges, setupModels }); setNotice('Assistant preferences or connection changed while you were editing. Your draft is kept. Review both versions before choosing which to save.') }
  const save = (closeAfter = false, routingChanges = {}, reviewedSnapshot = null, ownedRevision = renderedRevision, setupModels = null, draft = {}) => {
    if (!mounted.current || saving.current || busy) return
    if (ownedRevision !== revision.current) return setNotice('Your draft changed. Review the current draft, then save again.')
    const current = store.assistantStatus
    if (!current) return setNotice('Assistant status is unavailable. Refresh status before saving; your draft is kept.')
    const snapshot = savedSnapshot(current)
    if (snapshot !== baseline.current && snapshot !== reviewedSnapshot) return reviewSaved(current, routingChanges, setupModels)
    if (reviewedSnapshot && snapshot !== reviewedSnapshot) return reviewSaved(current, routingChanges, setupModels)
    if (setupModels) {
      if (store.connected === false || assistantActivity(store.claude).active) return setNotice('Wait for the assistant request to finish or stop, and reconnect before saving Auto setup. Your draft is kept.')
      const eligible = new Set(autoModelPool(current, [], { ...routing, provider, model, agent: provider === 'claude-code' ? agent : '' }).usableModels.map(item => `${item.provider}:${item.id}`))
      if (!setupModels.every(item => eligible.has(`${item.provider}:${item.model}`))) return setNotice('The proposed Auto setup models are no longer eligible. Your draft is kept. Refresh status and review individual models before saving.')
    }
    // A provider chosen in this click has not reached component state yet.
    const target = { provider, model, agent, ...draft }
    const body = { ...(routingSupported ? routingPreferencesForHost(current, { ...routing, ...routingChanges }) : {}), provider: target.provider, model: target.model.trim() }
    if (!native || current.agent !== undefined || target.provider === 'claude-code' && target.agent) body.agent = target.provider === 'claude-code' ? target.agent.trim() : ''
    saving.current = true
    return run('save', async () => {
      try {
        await api('/api/assistant/config', body)
        const fresh = await refreshAssistantStatus()
        if (mounted.current && fresh === store.assistantStatus && ownedRevision === revision.current) { hydrate(fresh); edited.current = false; setNotice('Assistant preferences saved.'); if (closeAfter) close() }
        else if (mounted.current && ownedRevision !== revision.current) setNotice('Preferences were submitted. Your newer draft edit is kept; review it before saving again.')
        else if (mounted.current) setNotice('Preferences were submitted. A newer status check superseded the save confirmation. Your draft is kept; review the current status before saving again.')
      } finally { saving.current = false }
    })
  }
  const loadSaved = () => {
    if (!mounted.current || saving.current || busy) return
    if (renderedRevision !== revision.current) return setNotice('Your draft changed. Review the current draft before replacing it.')
    const current = store.assistantStatus
    if (!current) return setNotice('Assistant status is unavailable. Refresh status before replacing your draft.')
    if (savedSnapshot(current) !== conflict?.snapshot) return reviewSaved(current, conflict?.routingChanges, conflict?.setupModels)
    hydrate(current); edited.current = false; setNotice('Current saved assistant preferences loaded. The earlier draft was replaced.')
  }
  const describePreferences = value => [
    `Provider: ${providerName(value.provider)}. Manual model preference: ${value.model || 'Provider default'}. Named agent: ${value.agent || 'Provider default'}.`,
    `Selection: ${value.mode === 'auto' ? 'Auto' : 'Manual'}. Auto preference: ${value.priority}. Reasoning effort: ${value.effort || 'Provider default'}. Require a current model catalog match: ${value.catalogBound ? 'Yes' : 'No'}.`,
    `Auto pool: ${value.enabledModels.length ? value.enabledModels.map(item => `${providerName(item.provider)} · ${item.model}`).join('; ') : 'No enabled models'}.`,
    `Additional usage credits: ${value.allowAdditionalSpend ? 'Allowed' : 'Not allowed'}. API or unverified billing: ${value.allowAPIBilling ? 'Allowed' : 'Not allowed'}.`
  ]
  const loginProvider = target => run('login', async () => {
    const result = await api('/api/assistant/login', { provider: target })
    if (result.started !== true) throw new Error(result.reason ?? 'Sign-in could not be started.')
    if (mounted.current) setNotice('Complete the official sign-in in Terminal, then refresh status here.')
    await refreshAssistantStatus()
  })
  const login = () => loginProvider(provider)
  const enableAndSave = () => {
    if (!mounted.current || actions.current || saving.current || busy || store.connected === false || assistantActivity(store.claude).active) return
    if (renderedRevision !== revision.current) return setNotice('Your draft changed. Review the current draft, then enable models again.')
    const current = store.assistantStatus
    if (!current || current !== renderedStatus) return setNotice('Assistant status changed. Review the current accounts and models, then enable models again. Your draft is kept.')
    const pool = autoModelPool(current, routing.enabledModels, { ...routing, provider, model, agent: provider === 'claude-code' ? agent : '' })
    if (!pool.usableModels.length || pool.bulk.length === pool.enabled.size || pool.bulk.length > 256) return setNotice('No models can be added from the current eligible catalog. Review the account and discovery diagnostics or choose individual models.')
    editRouting({ enabledModels: pool.bulk })
    return save(false, { enabledModels: pool.bulk }, null, revision.current, pool.bulk.filter(item => !pool.enabled.has(`${item.provider}:${item.model}`)))
  }
  const status = assistantState(s.assistantStatus ? { ...s.assistantStatus, mode: 'manual' } : null, provider), details = status.detail
  // One click switches to a provider that is installed, signed in and available. Others
  // stay a draft so the steps below can explain what is missing.
  const chooseProvider = id => {
    if (busy || id === provider) return
    const detail = assistantState(s.assistantStatus ? { ...s.assistantStatus, mode: 'manual' } : null, id).detail
    const saved = s.assistantStatus?.provider === id && s.assistantStatus?.mode !== 'auto'
    markEdited(); setProvider(id); setModel(''); setAgent(''); editRouting({ effort: '', catalogBound: false }); setNotice('')
    if (detail?.authenticated === true && detail?.available === true && !saved) save(false, { mode: 'manual', effort: '', catalogBound: false }, null, revision.current, null, { provider: id, model: '', agent: '' })
  }
  const choices = [...ASSISTANT_PROVIDERS.filter(p => p.id !== 'chatgpt' || s.assistantStatus?.chatgpt?.supported === true), ...(native && s.assistantStatus?.provider === 'anthropic' ? [{ id: 'anthropic', name: 'Anthropic API', account: 'API account' }] : [])]
  const installURL = safeInstallURL(details?.installURL)
  const manual = manualModelChoices(s.assistantStatus, provider, model)
  const efforts = manual.model?.reasoningEfforts ?? []
  const manualSelected = provider !== 'custom' && status.ready && s.assistantStatus?.mode !== 'auto'
  // Sign in with ChatGPT is offered only by hosts that hold the account themselves.
  const chatgpt = s.assistantStatus?.chatgpt?.supported === true ? s.assistantStatus.chatgpt : null
  const chatgptAttempt = chatgpt?.attempt ?? { state: 'idle', message: '', startURL: null }
  const chatgptWaiting = ['waiting', 'exchanging'].includes(chatgptAttempt.state)
  const chatgptCurrent = chatgpt?.accounts?.find(item => item.active) ?? null
  const chatgptUsage = typeof chatgpt?.usageURL === 'string' && chatgpt.usageURL.startsWith('https://chatgpt.com/') ? chatgpt.usageURL : null
  const chatgptSelected = s.assistantStatus?.provider === 'chatgpt' && s.assistantStatus?.mode !== 'auto'
  const otherOpen = Boolean(s.assistantStatus) && s.assistantStatus.provider !== 'chatgpt' && s.assistantStatus.configured === true
  const chatgptStart = body => run('chatgpt', async () => {
    const result = await startChatGPTSignIn(body)
    if (mounted.current) setNotice(result.opened === false ? 'Arya could not open your browser. Use Open the sign-in page.' : 'Finish signing in on the ChatGPT page in your browser.')
  })
  const chatgptCancel = () => run('chatgpt', async () => {
    await chatgptAccountAction('cancel')
    if (mounted.current) setNotice('ChatGPT sign-in cancelled. Manual editing still works without an account.')
  })
  const chatgptSignOut = () => run('chatgpt', async () => {
    const result = await chatgptAccountAction('sign-out', chatgptCurrent ? { account: chatgptCurrent.id } : {})
    if (mounted.current) setNotice(result.revocationConfirmed ? 'Signed out of ChatGPT. Arya removed the sign-in from this computer.' : 'Signed out on this computer, but OpenAI did not confirm the revocation. An unused sign-in expires within 30 days.')
  })
  const chooseChatGPT = () => {
    if (busy || saving.current) return
    markEdited(); setProvider('chatgpt'); setModel(''); setAgent(''); editRouting({ effort: '', catalogBound: false }); setNotice('')
    return save(false, { mode: 'manual', effort: '', catalogBound: false }, null, revision.current, null, { provider: 'chatgpt', model: '', agent: '' })
  }
  const chatgptWelcome = () => html`<section class="chatgpt-welcome" aria-labelledby="chatgpt-welcome-title"><h4 id="chatgpt-welcome-title">You’re using your ChatGPT plan</h4><p>Eligible AI requests in Arya use your ChatGPT plan or credits balance. Check and manage usage in your ChatGPT settings.</p><div class="settings-actions"><button class="primary" disabled=${Boolean(busy)} onClick=${() => run('chatgpt', () => chatgptAccountAction('welcome'))}>Got it</button>${chatgptUsage ? html`<a class="button ghost" href=${chatgptUsage} target="_blank" rel="noopener noreferrer">Manage usage ↗</a>` : null}</div></section>`
  const chatgptCard = () => html`<section class="chatgpt-card" aria-labelledby="chatgpt-card-title">
    <h3 class="settings-heading settings-step" id="chatgpt-card-title">Use your ChatGPT plan</h3>
    <p class="settings-note">Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance. Arya adds no charge for AI requests.</p>
    ${chatgpt.error ? html`<p class="settings-error" role="alert">${chatgpt.error}</p>` : null}
    ${chatgpt.welcome ? chatgptWelcome() : null}
    ${chatgptWaiting ? html`<div class="provider-status" aria-live="polite"><span class="provider-status-dot"></span><div><b>${chatgptAttempt.state === 'exchanging' ? 'Finishing sign-in…' : 'Waiting for ChatGPT sign-in'}</b><p>${chatgptAttempt.state === 'exchanging' ? 'Arya is confirming the sign-in with OpenAI.' : 'Finish signing in on the ChatGPT page in your browser. Arya never sees your password.'}</p></div></div>
    <div class="settings-actions">${chatgptAttempt.startURL ? html`<a class="button ghost" href=${chatgptAttempt.startURL} target="_blank" rel="noopener noreferrer">Open the sign-in page ↗</a>` : null}<button class="ghost" disabled=${busy === 'chatgpt'} onClick=${chatgptCancel}>Cancel sign-in</button></div>` : !chatgpt.signedIn ? html`${['failed', 'cancelled', 'expired'].includes(chatgptAttempt.state) && chatgptAttempt.message ? html`<p class="settings-note" role="status">${chatgptAttempt.message}</p>` : null}
    <div class="settings-actions"><button class="primary" disabled=${Boolean(busy) || active} onClick=${() => chatgptStart({})}>${busy === 'chatgpt' ? 'Opening ChatGPT…' : 'Continue with ChatGPT'}</button>${chatgpt.accounts?.length ? html`<button class="ghost" disabled=${Boolean(busy) || active} onClick=${() => chatgptStart({ newAccount: true })}>Use a different account</button>` : null}</div>
    <p class="settings-note">Sign-in opens in your browser. Your ChatGPT plan decides which requests are eligible and how much you can use.</p>` : html`<div class=${`provider-status ${chatgpt.planUsage ? 'ready' : ''}`} aria-live="polite"><span class="provider-status-dot"></span><div><b>${chatgpt.planUsage ? 'Using ChatGPT plan' : 'ChatGPT plan usage is off'}</b><p>Signed in as ${chatgpt.email || 'your ChatGPT account'}.${chatgpt.planUsage ? '' : ' Turn on plan usage to send assistant requests with ChatGPT.'}</p></div></div>
    <div class="settings-actions">${chatgpt.planUsage ? chatgptSelected ? html`<span class="settings-note">ChatGPT is your assistant.</span>` : html`<button class="primary" disabled=${Boolean(busy) || active} onClick=${chooseChatGPT}>Use ChatGPT for the assistant</button>` : html`<button class="primary" disabled=${Boolean(busy) || active} onClick=${() => chatgptStart({ ...(chatgptCurrent ? { account: chatgptCurrent.id } : {}), enablePlan: true })}>Turn on ChatGPT plan usage</button>`}${chatgptUsage ? html`<a class="button ghost" href=${chatgptUsage} target="_blank" rel="noopener noreferrer">Manage usage ↗</a>` : null}<button class="ghost" disabled=${Boolean(busy) || active} onClick=${() => chatgptStart({ newAccount: true })}>Use a different account</button><button class="ghost" disabled=${Boolean(busy)} onClick=${chatgptSignOut}>Sign out</button></div>`}
    ${(chatgpt.accounts ?? []).filter(item => !item.active).map(item => html`<div class="settings-actions"><p class="settings-note">Saved account: ${item.email || 'ChatGPT account'}${item.signedIn ? '' : ' · signed out'}</p><button class="ghost" disabled=${Boolean(busy) || active || chatgptWaiting} onClick=${() => chatgptStart({ account: item.id })}>Switch to this account</button></div>`)}
  </section>`
  const cliSteps = html`<h3 class="settings-heading settings-step">1. Choose your assistant</h3>
            <div class="settings-actions" role="group" aria-label="Choose assistant">${choices.filter(p => ['claude-code', 'codex', 'antigravity'].includes(p.id)).map(p => html`<button class=${provider === p.id ? 'primary' : 'ghost'} aria-pressed=${provider === p.id} disabled=${Boolean(busy)} onClick=${() => chooseProvider(p.id)}>${p.name} · ${p.hint}</button>`)}</div>
            ${provider === 'chatgpt' ? html`<p class="settings-note">${chatgpt ? 'ChatGPT is selected above. Choose one of these apps to switch.' : 'ChatGPT was selected, but its sign-in is not available right now. Refresh status, or choose one of these apps.'}</p>${chatgpt ? null : html`<div class="settings-actions"><button class="ghost" disabled=${Boolean(busy)} onClick=${() => run('refresh', () => refreshAssistantStatus({ refresh: true }))}>${busy === 'refresh' ? 'Checking…' : 'Refresh status'}</button></div>`}` : html`<div class="provider-account">${choices.find(p => p.id === provider)?.account}</div>
            ${provider === 'claude-code' ? html`<p class="settings-note">Anthropic does not let other apps offer Claude sign-in without its approval, so Arya has no Claude sign-in button. Install Claude Code and sign in to it yourself. Arya runs it on this computer and never sees your password or tokens.</p>` : null}
            <p class="settings-note" role="status">${details?.installed === true ? `${providerName(provider)} is installed.` : details?.installed === false ? `Install ${providerName(provider)} to continue. After installing, click Refresh status.` : 'Refresh status to check installation.'}</p>
            ${!native && details?.installed === false && installURL ? html`<button class="primary" disabled=${Boolean(busy)} onClick=${() => window.open(installURL, '_blank', 'noopener,noreferrer')}>Install ${providerName(provider)} ↗</button>` : null}
            <h3 class="settings-heading settings-step">2. Sign in</h3>
            <p class="settings-note">${details?.authenticated === true ? provider === 'gemini-cli' ? 'A saved Google sign-in was found. Arya checks only that it exists.' : 'Signed in. Confirmed by the provider’s CLI.' : provider === 'custom' ? 'Authentication is unknown. A configured executable does not confirm sign-in.' : "Sign in through the provider's own account flow. Credentials stay with the provider."}</p>
            ${!native && ['claude-code', 'codex', 'antigravity'].includes(provider) && details?.installed !== false ? html`<button class=${details?.authenticated === true ? 'ghost' : 'primary'} disabled=${Boolean(busy) || details?.canLogin !== true} onClick=${login}>${busy === 'login' ? 'Opening sign-in…' : details?.authenticated === true ? 'Sign in with another account' : `Sign in to ${providerName(provider)}`}</button>` : null}
            ${!native && details?.installed === true && details?.canLogin !== true && details?.loginCommand ? html`<p class="settings-note">Run <code>${details.loginCommand}</code> in Terminal${provider === 'gemini-cli' ? ' and choose Sign in with Google' : ''}, then refresh status here.</p>` : null}
            <h3 class="settings-heading settings-step">3. Turn on the assistant</h3>
            <p class="settings-note">${native ? "Open Arya Settings → Assistant accounts to turn on the helper." : 'The local editor runs the provider’s official CLI outside your browser. Keep the Arya editor running while you use the assistant.'}</p>
            <div class=${`provider-status ${status.ready ? 'ready' : ''}`} aria-live="polite"><span class="provider-status-dot"></span><div><b>${status.label}</b><p>${status.reason}</p></div></div>
            <div class="settings-actions"><button class="primary" disabled=${Boolean(busy) || details?.authenticated !== true || details?.available !== true || manualSelected} onClick=${() => save(false, { mode: 'manual' })}>${manualSelected ? 'Assistant is on' : `Use ${providerName(provider)}`}</button><button class="ghost" disabled=${Boolean(busy)} onClick=${() => run('refresh', () => refreshAssistantStatus({ refresh: true }))}>${busy === 'refresh' ? 'Checking…' : 'Refresh status'}</button></div>`}
            <details class="settings-advanced settings-disclosure"><summary>Account setup and provider details</summary>
            <label class="settings-field"><span>Other connections</span><select value=${provider} disabled=${Boolean(busy)} onChange=${event => { markEdited(); setProvider(event.target.value); setModel(''); setAgent(''); editRouting({ effort: '', catalogBound: false }); setNotice('') }}>${choices.map(p => html`<option value=${p.id}>${p.name}${['gemini-cli', 'custom'].includes(p.id) ? ' (not available for editing)' : ''}</option>`)}</select></label>
            ${provider === 'gemini-cli' ? html`<p class="settings-note">Google retired Gemini CLI individual-account sign-in. Choose Google Antigravity, sign in to Arya’s separate profile, and refresh status. Your saved Gemini preferences are preserved.</p>` : null}
            ${provider === 'antigravity' ? html`<p class="settings-note">Antigravity uses a separate Arya profile with only the two project tools. Extra AI credits and API billing are disabled. Sign in below, refresh status, then select a model. Model image capabilities are not reported, so these models are not offered for Auto frame-inspection requests.</p>` : null}
            ${provider === 'custom' ? html`<p class="settings-note">This host does not expose custom editing with reviewed AI sharing. Saved custom options are kept, but this connection cannot send project data to that adapter. Reported custom models do not verify subscription access, billing or an executed model. Use Claude Code or Codex for subscription editing here.</p>` : null}
            ${(s.assistantStatus?.providers ?? []).filter(account => account.id !== provider && ['claude-code', 'codex', 'antigravity'].includes(account.id) && account.installed === true && account.authenticated === false).map(account => html`<div class="settings-actions"><p class="settings-note">${providerName(account.id)} is installed but signed out. Its account is separate from your other providers.${native ? " Open the Arya app's Settings → Assistant to review sign-in on the companion host." : account.canLogin !== true ? ' Sign in with its official CLI on the host, then refresh status here.' : ' Complete its official sign-in, then refresh status here. Signing in does not switch the editing provider or enable models.'}</p>${!native && account.canLogin === true ? html`<button class="ghost" disabled=${Boolean(busy) || active} onClick=${() => { if (!actions.current && !assistantActivity(store.claude).active) return loginProvider(account.id) }}>Sign in to ${providerName(account.id)}</button>` : null}</div>`)}
            </details>`
  const trap = event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); requestClose() }
    if (event.key !== 'Tab') return
    const elements = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')].filter(el => el.getClientRects().length)
    const first = elements[0], last = elements.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return html`<div class="modal-back settings-back" onClick=${event => { if (event.target === event.currentTarget) requestClose() }}>
    <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref=${dialog} onKeyDown=${trap}>
      <header class="settings-head"><div><h2 id="settings-title">Settings</h2><p>Accounts and workspace preferences</p></div><button class="ghost settings-close" aria-label="Close settings" onClick=${requestClose}>✕</button></header>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="Settings sections">${[{ id: 'assistant', label: 'AI and accounts' }, { id: 'workspace', label: 'Workspace' }, ...registry.settings, ...(s.supportURL ? [{ id: 'support', label: 'Support Arya' }] : [])].map(item => html`<button aria-current=${section === item.id ? 'page' : undefined} class=${section === item.id ? 'on' : ''} onClick=${() => setSection(item.id)}>${item.label}</button>`)}</nav>
        <div class="settings-content" tabIndex="0" aria-label="Settings content">
          ${section === 'assistant' && host.kind === 'browser-local' ? html`<h3 class="settings-heading">Assistant</h3><p class="settings-intro">Not available in the browser beta. The assistant uses your own AI account, which needs the Arya Mac app or the editor running on your computer.</p><div class="settings-actions"><a class="button primary" href="https://editwitharya.app/download/#mac" target="_blank" rel="noopener noreferrer">Download for Mac</a><a class="settings-link" href="https://editwitharya.app/install/#accounts" target="_blank" rel="noopener noreferrer">Run locally</a></div>` : section === 'assistant' ? html`<h3 class="settings-heading">Set up your editing assistant</h3><p class="settings-intro">Arya includes no AI credits. Editing works without an account.</p>
            ${s.assistantStatusError ? html`<p class="settings-error" role="alert">Could not read assistant status. ${s.assistantStatusError}</p>` : null}
            ${chatgpt ? chatgptCard() : null}
            ${chatgpt ? html`<details class="settings-advanced settings-disclosure" open=${otherOpen || s.settingsOtherWays === true}><summary>Other ways to connect</summary><p class="settings-note">These use an AI app you install and sign in to yourself. Arya runs it on this computer and never sees its password or tokens.</p>${cliSteps}</details>` : cliSteps}
            <div class="settings-divider"></div><h3 class="settings-heading settings-step">Model preferences</h3>
            ${routingSupported ? html`<label class="settings-field"><span>Model selection</span><select value=${routing.mode} disabled=${Boolean(busy)} onChange=${event => editRouting({ mode: event.target.value })}><option value="manual">Manual · choose a provider and model</option><option value="auto">Auto · choose from my enabled models</option></select></label>
            ${routing.mode === 'auto' ? html`<label class="settings-field"><span>Auto preference</span><select value=${routingPreferencesForHost(s.assistantStatus, routing).priority} disabled=${Boolean(busy)} onChange=${event => editRouting({ priority: event.target.value })}>${routingPriorityOptions(s.assistantStatus).map(option => html`<option value=${option.value}>${option.label}</option>`)}</select></label><${ModelPool} status=${s.assistantStatus} value=${routing.enabledModels} preferences=${{ ...routing, provider, model, agent: provider === 'claude-code' ? agent : '' }} disabled=${Boolean(busy)} onChange=${enabledModels => editRouting({ enabledModels })} />` : null}` : null}
            ${routingSupported && routing.mode === 'auto' ? html`<div class="settings-actions"><button class="primary" disabled=${Boolean(busy) || active || s.connected === false || !renderedStatus || !setupPool.usableModels.length || setupPool.bulk.length === setupPool.enabled.size || setupPool.bulk.length > 256} onClick=${enableAndSave}>Enable eligible models and save</button></div><p class="settings-note">Adds ${setupPool.bulk.length - setupPool.enabled.size} eligible models and saves the preferences shown here.</p>${active ? html`<p class="settings-note">Wait for the current assistant request to finish or stop before saving Auto setup.</p>` : null}` : null}
            ${routingSupported && routing.mode === 'manual' ? html`<label class="settings-field"><span>Manual model</span><select value=${model} disabled=${Boolean(busy)} onChange=${event => {
              if (event.target.value && !manualModelChoices(s.assistantStatus, provider).choices.some(row => row.id === event.target.value && !row.disabled)) return
              markEdited(); setModel(event.target.value); editRouting({ effort: '', catalogBound: Boolean(event.target.value) })
            }}><option value="">Provider default</option>${manual.choices.map(row => html`<option value=${row.id} disabled=${row.disabled}>${row.name} · ${row.id}${row.disabled ? ' · unavailable' : ''}</option>`)}${manual.missing ? html`<option value=${model} disabled>${model} · saved selection</option>` : null}</select></label>${manual.reason ? html`<p class="settings-note">${manual.reason} Your saved choice is preserved.</p>` : !manual.choices.length ? html`<p class="settings-note">${provider === 'claude-code' ? 'Claude Code uses your account’s default model. Its CLI does not report a model list. To ask for another model, enter a Claude Code model alias such as sonnet or opus under Model and agent preferences.' : 'No verified model choices yet. Refresh status after sign-in. Provider default remains available; an exact unverified model ID can be entered in advanced preferences.'}</p>` : null}` : null}
            <details class="settings-advanced"><summary>Model and agent preferences</summary>
              <label class="settings-field"><span>Custom model ID <small>advanced · availability unverified</small></span><input value=${model} maxLength="128" placeholder="Provider default" disabled=${Boolean(busy)} onInput=${event => { markEdited(); setModel(event.target.value); editRouting({ effort: '', catalogBound: false }) }} /></label>
              ${routingSupported ? html`<label class="settings-field"><span>Reasoning effort <small>optional</small></span><select value=${routing.effort} disabled=${Boolean(busy)} onChange=${event => {
                if (event.target.value && !manualModelChoices(s.assistantStatus, provider, model).model?.reasoningEfforts.includes(event.target.value)) return
                editRouting({ effort: event.target.value })
              }}><option value="">Provider default</option>${efforts.map(effort => html`<option value=${effort}>${effort}</option>`)}${routing.effort && !efforts.includes(routing.effort) ? html`<option value=${routing.effort} disabled>${routing.effort} · needs refresh</option>` : null}</select></label>` : null}
              ${provider === 'claude-code' ? html`<label class="settings-field"><span>Agent <small>optional</small></span><input value=${agent} maxLength="128" placeholder="Provider default" disabled=${Boolean(busy)} onInput=${event => { markEdited(); setAgent(event.target.value) }} /></label>` : html`<p class="settings-note">Named agent selection is supported by Claude Code. This provider uses its own agent.</p>`}
            </details>
            <details class="settings-advanced settings-disclosure" open=${billingOpen} onToggle=${event => { billingPresentation.current.toggled = true; setBillingOpen(event.currentTarget.open) }}><summary>Billing and account limits</summary>
              ${routingSupported && routing.mode === 'auto' ? html`${capabilities.allowAdditionalSpend ? html`<label class="assistant-spending"><input type="checkbox" checked=${routing.allowAdditionalSpend} disabled=${Boolean(busy)} onChange=${event => editRouting({ allowAdditionalSpend: event.target.checked })} /><span>Allow models the provider marks as requiring extra usage credits<small>Pricing is not reported by model discovery. Check your provider’s billing settings.</small></span></label>` : html`<p class="settings-note">Auto cannot use models requiring extra usage credits on this connection.</p>`}${capabilities.allowAPIBilling ? html`<label class="assistant-spending"><input type="checkbox" checked=${routing.allowAPIBilling} disabled=${Boolean(busy)} onChange=${event => editRouting({ allowAPIBilling: event.target.checked })} /><span>Include adapters with API or unverified billing<small>Disabled by default. These accounts can incur separate provider charges.</small></span></label>` : html`<p class="settings-note">API billing cannot be enabled for Auto on this connection.</p>`}<p class="settings-note">Each request shows the exact requested model and why Auto selected it. Auto does not retry edits on another provider mid-run. A named Claude agent limits Auto to Claude Code.</p>` : null}
            <div class="settings-limits"><span>Account limits</span><p>${s.assistantStatus?.provider === provider && s.assistantStatus?.usage?.summary || 'Not reported by this provider. Check your provider account for remaining usage.'}</p></div>
            </details>
            <div class="settings-divider"></div>
            <h3 class="settings-heading settings-step">Sharing before sending</h3><p class="settings-note">Review the recipients and project data when you send a request.</p><details class="settings-advanced settings-disclosure"><summary>What sharing permission covers</summary><p class="settings-note">Before sending, review the exact AI recipients, companion and project data. Withdrawal stops further assistant sharing and requires another review. Data already shared remains subject to the recipients' policies.</p></details>
            ${s.assistantStatus?.sharing?.approved ? html`<div class="settings-actions"><button class="ghost" disabled=${Boolean(busy)} onClick=${() => run('withdraw', async () => {
              const result = await withdrawAssistantSharing(api)
              if (mounted.current) setNotice(result.stopUnconfirmed ? 'Permission withdrawn. Stopping could not be confirmed; review running jobs before continuing.' : 'Sharing permission withdrawn. Review again before the next request.')
              await refreshAssistantStatus()
            })}>${busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw sharing permission'}</button></div>` : null}
            <div class="settings-divider"></div><h3 class="settings-heading">Figma</h3><p class="settings-note">Connect your access token to import design frames.</p><button class="ghost" onClick=${() => setSection('figma')}>Open Figma settings</button>
            ${conflict ? html`<section class="settings-advanced" aria-label="Review changed assistant preferences"><h4>Review saved preferences and your draft</h4><p class="settings-note">Saving this draft replaces the current saved preferences, including the Auto pool. No choices are merged automatically. Loading replaces your draft; saving replaces the saved preferences.</p><h4>Current saved preferences</h4>${describePreferences(conflict.preferences).map(line => html`<p class="settings-note">${line}</p>`)}<h4>Your draft</h4>${describePreferences({ ...routing, ...conflict.routingChanges, provider, model: model.trim(), agent: provider === 'claude-code' ? agent.trim() : '' }).map(line => html`<p class="settings-note">${line}</p>`)}<div class="settings-actions"><button class="ghost" disabled=${Boolean(busy) || !s.assistantStatus} onClick=${loadSaved}>Use current saved preferences</button><button class="primary" disabled=${Boolean(busy) || !s.assistantStatus || Boolean(conflict.setupModels) && active} onClick=${() => save(false, conflict.routingChanges, conflict.snapshot, renderedRevision, conflict.setupModels)}>Replace saved preferences with this draft</button></div></section>` : null}
            ${notice ? html`<p class="settings-notice" role="status">${notice}</p>` : null}
          ` : section === 'workspace' ? html`<h3 class="settings-heading">Workspace</h3><p class="settings-intro">Keep the viewer, timeline and controls where you need them.</p><${LayoutMenu} /><p class="settings-note">Drag panel dividers to resize. Use arrow keys on a focused divider. Double-click to reset a divider. Layout is saved on this device.</p><button class="ghost" onClick=${() => { close(); set({ showKeys: true }) }}>Keyboard shortcuts</button>` : section === 'support' && s.supportURL ? html`<h3 class="settings-heading">Support Arya</h3><p class="settings-intro">Arya is free. Editing, export and every feature stay free, with no account. A tip is optional, unlocks nothing and helps fund development.</p><div class="settings-actions"><a class="button primary" href=${s.supportURL} target="_blank" rel="noopener noreferrer">Support Arya ↗</a></div><p class="settings-note">Opens the Arya website in a new tab. Payment happens there, not in the editor, and the editor does not see or store it.</p>` : h(registry.settings.find(item => item.id === section)?.component, { project: s.project, caps: s.caps })}
        </div>
      </div>
      <footer class="settings-footer"><span role=${closeGuard && edited.current ? 'alert' : undefined}>${closeGuard && edited.current ? 'You have unsaved changes. Save them, or discard them to close.' : host.kind === 'browser-local' ? 'Preferences stay in this browser.' : native ? 'Preferences stay on this device.' : 'Workspace preferences stay on this device. Assistant preferences stay in the project folder.'}</span><div class="settings-actions">${edited.current ? html`<button class="primary" disabled=${Boolean(busy) || !s.assistantStatus} onClick=${() => save(true)}>${busy === 'save' ? 'Saving…' : 'Save and close'}</button>` : null}<button onClick=${close}>${edited.current ? closeGuard ? 'Discard changes' : 'Cancel' : 'Close'}</button></div></footer>
    </section>
  </div>`
}
