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
import { refreshAssistantStatus } from './assistant-status.js'
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
  const markEdited = () => { edited.current = true; revision.current++; setConflict(null) }
  const editRouting = changes => { markEdited(); setRouting(value => ({ ...value, ...changes })) }
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(null)
  const savedSnapshot = status => JSON.stringify({ root: store.root ?? '', host: store.caps?.host ?? '', routingSupported: status?.routingSupported === true, preferences: routingPreferences(status) })
  const dialog = useRef(null), mounted = useRef(true), edited = useRef(false), revision = useRef(0), saving = useRef(false), actions = useRef(0), baseline = useRef(s.assistantStatus ? savedSnapshot(s.assistantStatus) : null)
  const renderedRevision = revision.current
  const close = () => set({ settingsOpen: false })
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
  const save = (closeAfter = false, routingChanges = {}, reviewedSnapshot = null, ownedRevision = renderedRevision, setupModels = null) => {
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
    const body = { ...(routingSupported ? routingPreferencesForHost(current, { ...routing, ...routingChanges }) : {}), provider, model: model.trim() }
    if (!native || current.agent !== undefined || provider === 'claude-code' && agent) body.agent = provider === 'claude-code' ? agent.trim() : ''
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
  const choices = [...ASSISTANT_PROVIDERS, ...(native && s.assistantStatus?.provider === 'anthropic' ? [{ id: 'anthropic', name: 'Anthropic API', account: 'API account' }] : [])]
  const installURL = safeInstallURL(details?.installURL)
  const manual = manualModelChoices(s.assistantStatus, provider, model)
  const efforts = manual.model?.reasoningEfforts ?? []
  const adapterManaged = provider === 'custom' && details?.adapterManaged === true
  const manualSelected = provider !== 'custom' && status.ready && s.assistantStatus?.mode !== 'auto'
  const trap = event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close() }
    if (event.key !== 'Tab') return
    const elements = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')].filter(el => el.getClientRects().length)
    const first = elements[0], last = elements.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return html`<div class="modal-back settings-back" onClick=${event => { if (event.target === event.currentTarget) close() }}>
    <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref=${dialog} onKeyDown=${trap}>
      <header class="settings-head"><div><h2 id="settings-title">Settings</h2><p>Accounts and workspace preferences</p></div><button class="ghost settings-close" aria-label="Close settings" onClick=${close}>✕</button></header>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="Settings sections">${[{ id: 'assistant', label: 'AI and accounts' }, { id: 'workspace', label: 'Workspace' }, ...registry.settings].map(item => html`<button aria-current=${section === item.id ? 'page' : undefined} class=${section === item.id ? 'on' : ''} onClick=${() => setSection(item.id)}>${item.label}</button>`)}</nav>
        <div class="settings-content" tabIndex="0" aria-label="Settings content">
          ${section === 'assistant' && host.kind === 'browser-local' ? html`<h3 class="settings-heading">AI connections in the hosted beta</h3><p class="settings-intro">Your subscription agents run through their official apps on your own computer. This hosted browser workspace has no agent connection, so it cannot sign you in or use a Pro or Max subscription.</p><p>Use the native Arya app or your own local Arya server for supported subscription sign-in. Manual timeline editing, GPU preview, project backups and compatible exports stay available here.</p><p class="settings-note">No provider keys or account credentials are sent from this browser beta. A secure companion connection must be reviewed and tested before account controls become available.</p>` : section === 'assistant' ? html`<h3 class="settings-heading">Set up your editing assistant</h3><p class="settings-intro">Connect your account, choose your models, then review sharing before sending.</p>
            <h3 class="settings-heading settings-step">1. Connect an account</h3>
            <label class="settings-field"><span>Provider</span><select value=${provider} disabled=${Boolean(busy)} onChange=${event => { markEdited(); setProvider(event.target.value); setModel(''); setAgent(''); editRouting({ effort: '', catalogBound: false }); setNotice('') }}>${choices.map(p => html`<option value=${p.id}>${p.name}${p.suggested ? ' · Suggested' : ''}${p.id === 'codex' ? ' · ChatGPT' : ''}</option>`)}</select></label>
            <div class="provider-account">${choices.find(p => p.id === provider)?.account}</div>
            <div class=${`provider-status ${status.ready ? 'ready' : ''}`} aria-live="polite"><span class="provider-status-dot"></span><div><b>${status.label}</b><p>${status.reason}</p></div></div>
            ${s.assistantStatusError ? html`<p class="settings-error" role="alert">Could not read assistant status. ${s.assistantStatusError}</p>` : null}
            <div class="settings-actions">
              ${s.assistantStatus?.provider !== provider && details?.authenticated === true && details?.available !== false ? html`<button class="primary" disabled=${Boolean(busy)} onClick=${() => save(false, { mode: 'manual' })}>${native && provider === 'custom' ? 'Save custom preferences' : `Use ${providerName(provider)}`}</button>` : null}
              ${!native && ['claude-code', 'codex'].includes(provider) ? html`<button class="primary" disabled=${Boolean(busy) || details?.canLogin !== true} onClick=${login}>${busy === 'login' ? 'Opening sign-in…' : `Sign in to ${providerName(provider)}`}</button>` : null}
              ${installURL ? html`<a class="settings-link" href=${installURL} target="_blank" rel="noopener noreferrer">Install ${providerName(provider)} ↗</a>` : null}
              <button class="ghost" disabled=${Boolean(busy)} onClick=${() => run('refresh', () => refreshAssistantStatus({ refresh: true }))}>${busy === 'refresh' ? 'Checking…' : 'Refresh status'}</button>
            </div>
            ${native ? html`<p class="settings-note">Open the Arya app's Settings → Assistant to pair your agent bridge or sign in. Provider and model preferences below also apply here.</p>` : details?.loginCommand ? html`<p class="settings-note">Official sign-in command <code>${details.loginCommand}</code>. Credentials stay with the provider.</p>` : null}
            <details class="settings-advanced settings-disclosure"><summary>Account setup and provider details</summary>
            <ol class="assistant-onboarding" aria-label="Assistant account setup"><li class=${details?.installed === true || adapterManaged ? 'complete' : 'current'}><b>${provider === 'custom' ? '1 · Configure your adapter' : '1 · Install your agent'}</b><span>${adapterManaged ? 'Server adapter configured' : details?.installed === true ? 'Installed on the host Mac' : provider === 'custom' ? 'Configure an adapter on the Arya server' : "Use the provider's official installer"}</span></li><li class=${details?.authenticated === true ? 'complete' : details?.installed === true || adapterManaged ? 'current' : ''}><b>${provider === 'custom' ? '2 · Adapter authentication' : '2 · Sign in'}</b><span>${adapterManaged ? details?.authenticated === true ? 'The adapter reports authentication. Subscription access is unverified.' : 'Authentication is unknown. Executable configuration does not confirm sign-in.' : details?.authenticated === true ? 'Account sign-in confirmed by the CLI' : "Complete the provider's own account flow"}</span></li><li class=${manualSelected ? 'complete' : details?.authenticated === true || adapterManaged ? 'current' : ''}><b>${provider === 'custom' ? '3 · Review editing support' : '3 · Select for editing'}</b><span>${provider === 'custom' ? 'This host does not expose custom editing with reviewed AI sharing. Saving preferences does not enable project-data sharing.' : manualSelected ? 'Selected for Manual editing. You can also configure Auto below.' : s.assistantStatus?.mode === 'auto' && s.assistantStatus?.provider === provider ? 'Auto is selected. Enable models below, or choose Manual and save.' : details?.available === true ? `Choose Use ${providerName(provider)} or save your Manual preferences below.` : details?.authenticated === true || adapterManaged ? 'Editing adapter availability is separate from sign-in' : 'Refresh status after sign-in'}</span></li></ol>
            ${provider === 'claude-code' ? html`<p class="settings-note">Claude Code is the suggested agent for your own external CLI and Arya MCP connection. Embedded product distribution still needs provider eligibility confirmation; that is not verified for Arya. Your own Claude Code and MCP workflow remains the suggested path.</p>` : null}
            ${provider === 'antigravity' ? html`<p class="settings-note">Google Antigravity account sign-in is available in its own app. Built-in Arya editing stays unavailable until its adapter can isolate permissions and MCP tools per run.</p>` : null}
            ${provider === 'custom' ? html`<p class="settings-note">This host does not expose custom editing with reviewed AI sharing. Saved custom options are kept, but this connection cannot send project data to that adapter. Reported custom models do not verify subscription access, billing or an executed model. Use Claude Code or Codex for subscription editing here.</p>` : null}
            ${(s.assistantStatus?.providers ?? []).filter(account => account.id !== provider && ['claude-code', 'codex'].includes(account.id) && account.installed === true && account.authenticated === false).map(account => html`<div class="settings-actions"><p class="settings-note">${providerName(account.id)} is installed but signed out. Its account is separate from your other providers.${native ? " Open the Arya app's Settings → Assistant to review sign-in on the companion host." : account.canLogin !== true ? ' Sign in with its official CLI on the host, then refresh status here.' : ' Complete its official sign-in, then refresh status here. Signing in does not switch the editing provider or enable models.'}</p>${!native && account.canLogin === true ? html`<button class="ghost" disabled=${Boolean(busy) || active} onClick=${() => { if (!actions.current && !assistantActivity(store.claude).active) return loginProvider(account.id) }}>Sign in to ${providerName(account.id)}</button>` : null}</div>`)}
            </details>
            <div class="settings-divider"></div><h3 class="settings-heading settings-step">2. Choose your models</h3>
            ${routingSupported ? html`<label class="settings-field"><span>Model selection</span><select value=${routing.mode} disabled=${Boolean(busy)} onChange=${event => editRouting({ mode: event.target.value })}><option value="manual">Manual · choose a provider and model</option><option value="auto">Auto · choose from my enabled models</option></select></label>
            ${routing.mode === 'auto' ? html`<label class="settings-field"><span>Auto preference</span><select value=${routingPreferencesForHost(s.assistantStatus, routing).priority} disabled=${Boolean(busy)} onChange=${event => editRouting({ priority: event.target.value })}>${routingPriorityOptions(s.assistantStatus).map(option => html`<option value=${option.value}>${option.label}</option>`)}</select></label><${ModelPool} status=${s.assistantStatus} value=${routing.enabledModels} preferences=${{ ...routing, provider, model, agent: provider === 'claude-code' ? agent : '' }} disabled=${Boolean(busy)} onChange=${enabledModels => editRouting({ enabledModels })} />` : null}` : null}
            ${routingSupported && routing.mode === 'auto' ? html`<div class="settings-actions"><button class="primary" disabled=${Boolean(busy) || active || s.connected === false || !renderedStatus || !setupPool.usableModels.length || setupPool.bulk.length === setupPool.enabled.size || setupPool.bulk.length > 256} onClick=${enableAndSave}>Enable eligible models and save</button></div><p class="settings-note">Adds ${setupPool.bulk.length - setupPool.enabled.size} eligible models and saves the preferences shown here.</p>${active ? html`<p class="settings-note">Wait for the current assistant request to finish or stop before saving Auto setup.</p>` : null}` : null}
            ${routingSupported && routing.mode === 'manual' ? html`<label class="settings-field"><span>Manual model</span><select value=${model} disabled=${Boolean(busy)} onChange=${event => {
              if (event.target.value && !manualModelChoices(s.assistantStatus, provider).choices.some(row => row.id === event.target.value && !row.disabled)) return
              markEdited(); setModel(event.target.value); editRouting({ effort: '', catalogBound: Boolean(event.target.value) })
            }}><option value="">Provider default</option>${manual.choices.map(row => html`<option value=${row.id} disabled=${row.disabled}>${row.name} · ${row.id}${row.disabled ? ' · unavailable' : ''}</option>`)}${manual.missing ? html`<option value=${model} disabled>${model} · saved selection</option>` : null}</select></label>${manual.reason ? html`<p class="settings-note">${manual.reason} Your saved choice is preserved.</p>` : !manual.choices.length ? html`<p class="settings-note">No verified model choices yet. Refresh status after sign-in. Provider default remains available; an exact unverified model ID can be entered in advanced preferences.</p>` : null}` : null}
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
            <h3 class="settings-heading settings-step">3. Review sharing before sending</h3><p class="settings-note">Review the recipients and project data when you send a request.</p><details class="settings-advanced settings-disclosure"><summary>What sharing permission covers</summary><p class="settings-note">Before sending, review the exact AI recipients, companion and project data. Withdrawal stops further assistant sharing and requires another review. Data already shared remains subject to the recipients' policies.</p></details>
            <div class="settings-actions"><button class="ghost" disabled=${Boolean(busy)} onClick=${() => run('withdraw', async () => {
              const result = await withdrawAssistantSharing(api)
              if (mounted.current) setNotice(result.stopUnconfirmed ? 'Permission withdrawn. Stopping could not be confirmed; review running jobs before continuing.' : 'Sharing permission withdrawn. Review again before the next request.')
              await refreshAssistantStatus()
            })}>${busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw sharing permission'}</button></div>
            ${conflict ? html`<section class="settings-advanced" aria-label="Review changed assistant preferences"><h4>Review saved preferences and your draft</h4><p class="settings-note">Saving this draft replaces the current saved preferences, including the Auto pool. No choices are merged automatically. Loading replaces your draft; saving replaces the saved preferences.</p><h4>Current saved preferences</h4>${describePreferences(conflict.preferences).map(line => html`<p class="settings-note">${line}</p>`)}<h4>Your draft</h4>${describePreferences({ ...routing, ...conflict.routingChanges, provider, model: model.trim(), agent: provider === 'claude-code' ? agent.trim() : '' }).map(line => html`<p class="settings-note">${line}</p>`)}<div class="settings-actions"><button class="ghost" disabled=${Boolean(busy) || !s.assistantStatus} onClick=${loadSaved}>Use current saved preferences</button><button class="primary" disabled=${Boolean(busy) || !s.assistantStatus || Boolean(conflict.setupModels) && active} onClick=${() => save(false, conflict.routingChanges, conflict.snapshot, renderedRevision, conflict.setupModels)}>Replace saved preferences with this draft</button></div></section>` : null}
            ${notice ? html`<p class="settings-notice" role="status">${notice}</p>` : null}
          ` : section === 'workspace' ? html`<h3 class="settings-heading">Workspace</h3><p class="settings-intro">Keep the viewer, timeline and controls where you need them.</p><${LayoutMenu} /><p class="settings-note">Drag panel dividers to resize. Use arrow keys on a focused divider. Double-click to reset a divider. Layout is saved on this device.</p><button class="ghost" onClick=${() => { close(); set({ showKeys: true }) }}>Keyboard shortcuts</button>` : h(registry.settings.find(item => item.id === section)?.component, { project: s.project, caps: s.caps })}
        </div>
      </div>
      <footer class="settings-footer"><span>Preferences stay on this device and Arya server.</span><div class="settings-actions">${edited.current ? html`<button class="primary" disabled=${Boolean(busy) || !s.assistantStatus} onClick=${() => save(true)}>${busy === 'save' ? 'Saving…' : 'Save and close'}</button>` : null}<button onClick=${close}>${edited.current ? 'Cancel' : 'Close'}</button></div></footer>
    </section>
  </div>`
}
