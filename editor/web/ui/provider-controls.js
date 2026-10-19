import { h } from 'preact'
import { useState } from 'preact/hooks'
import htm from 'htm'
import { api, set, store, toast } from './store.js'
import { ASSISTANT_PROVIDERS, assistantState, providerName } from './assistant-state.js'
import { selectRoute } from '/core/assistant-routing.mjs'
import { refreshAssistantStatus } from './assistant-status.js'

const html = htm.bind(h)
const identity = item => `${item.provider}:${item.model}`
const PRIORITY_LABELS = { balanced: 'Balanced · adapts to the task', quick: 'Speed', quality: 'Quality' }

// Older browser hosts expose the full routing policy. A declared host contract is
// authoritative; unsupported choices cannot leak into the native settings request.
export function routingCapabilities(status) {
  const declared = status?.routingCapabilities
  const knownProviders = ASSISTANT_PROVIDERS.map(item => item.id)
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return { priorities: Object.keys(PRIORITY_LABELS), allowAdditionalSpend: true, allowAPIBilling: true, autoProviders: knownProviders }
  const priorities = [...new Set((Array.isArray(declared.priorities) ? declared.priorities : []).filter(value => Object.hasOwn(PRIORITY_LABELS, value)))]
  return { priorities: priorities.length ? priorities : ['balanced'], allowAdditionalSpend: declared.allowAdditionalSpend === true,
    allowAPIBilling: declared.allowAPIBilling === true,
    autoProviders: [...new Set((Array.isArray(declared.autoProviders) ? declared.autoProviders : []).filter(value => knownProviders.includes(value)))] }
}

export function routingPreferencesForHost(status, value) {
  const capabilities = routingCapabilities(status), next = { ...routingPreferences(status), ...value }
  return { ...next, priority: capabilities.priorities.includes(next.priority) ? next.priority : capabilities.priorities[0],
    allowAdditionalSpend: capabilities.allowAdditionalSpend && next.allowAdditionalSpend === true,
    allowAPIBilling: capabilities.allowAPIBilling && next.allowAPIBilling === true,
    enabledModels: (next.enabledModels ?? []).filter(item => capabilities.autoProviders.includes(item.provider)) }
}

export function routingPriorityOptions(status) {
  return routingCapabilities(status).priorities.map(value => ({ value, label: PRIORITY_LABELS[value] }))
}
export const routingPreferences = status => ({ provider: status?.provider ?? 'claude-code', model: status?.model ?? '', agent: status?.agent ?? '', effort: status?.effort ?? '', catalogBound: status?.catalogBound === true, mode: status?.mode ?? 'manual', priority: status?.priority ?? 'balanced', enabledModels: status?.enabledModels ?? [], allowAdditionalSpend: status?.allowAdditionalSpend === true, allowAPIBilling: status?.allowAPIBilling === true })

export function manualModelChoices(status, provider, selected = '') {
  const catalog = status?.catalogs?.find(row => row.provider === provider)
  const choices = (catalog?.models ?? []).filter(model => !model.hidden && model.available !== false).map(model => {
    const route = selectRoute({ preferences: { mode: 'manual', provider, model: model.id, catalogBound: true }, catalogs: status?.catalogs ?? [], providers: status?.providers ?? [] })
    return { ...model, disabled: !route.ok, reason: route.reason }
  })
  const selectedChoice = choices.find(model => selected ? model.id === selected : model.isDefault)
  return { choices, model: selectedChoice?.disabled === false ? selectedChoice : null,
    missing: Boolean(selected && !selectedChoice),
    reason: selected ? selectedChoice?.reason ?? (!selectedChoice ? catalog ? 'This saved model is absent, unavailable or hidden in the current catalog. Refresh status or choose another model.' : 'No verified catalog is available for this saved model ID. Its availability is unverified.' : '') : '' }
}

export function autoModelPool(status, value = [], preferences) {
  const capabilities = routingCapabilities(status)
  const prefs = routingPreferencesForHost(status, preferences)
  const models = (status?.catalogs ?? []).filter(catalog => capabilities.autoProviders.includes(catalog.provider)).flatMap(catalog => (catalog.models ?? []).filter(model => model.available !== false && !model.hidden).map(model => ({ ...model, provider: catalog.provider })))
  const enabled = new Set((value ?? []).map(identity))
  const available = new Set(models.map(model => identity({ provider: model.provider, model: model.id })))
  const missing = (value ?? []).filter(item => !available.has(identity(item)))
  const modelRoute = model => {
    try {
      return selectRoute({ preferences: { ...prefs, mode: 'auto', model: '', effort: '', catalogBound: false, enabledModels: [{ provider: model.provider, model: model.id }] }, catalogs: status?.catalogs ?? [], providers: status?.providers ?? [], request: { requiresImage: true } })
    } catch (error) { return { ok: false, reason: error.message } }
  }
  const usableModel = model => modelRoute(model).ok
  const usableModels = models.filter(usableModel)
  const bulk = [...new Map([...(value ?? []), ...usableModels.map(model => ({ provider: model.provider, model: model.id }))].map(item => [identity(item), item])).values()]
  return { capabilities, prefs, models, enabled, missing, modelRoute, usableModel, usableModels, bulk }
}

export function ModelPool({ status, value, onChange, preferences, disabled = false }) {
  const { capabilities, models, enabled, missing, modelRoute, usableModel, usableModels, bulk } = autoModelPool(status, value, preferences)
  return html`<fieldset class="assistant-model-pool" disabled=${disabled}><legend>Models Auto may use</legend>
    <p class="settings-note">Choose the models Auto may use for your edits.</p>
    <p class="settings-note">${usableModels.length} eligible now. ${usableModels.filter(model => enabled.has(identity({ provider: model.provider, model: model.id }))).length} enabled and eligible. Saved blocked choices are excluded when Auto runs.</p>
    <div class="settings-actions assistant-model-pool-actions"><button class="ghost tiny" type="button" disabled=${!usableModels.length || bulk.length === enabled.size || bulk.length > 256} onClick=${() => {
      if (disabled) return
      const current = [...new Map([...(value ?? []), ...models.filter(usableModel).map(model => ({ provider: model.provider, model: model.id }))].map(item => [identity(item), item])).values()]
      if (current.length <= 256 && current.length !== enabled.size) onChange(current)
    }}>Enable available models</button><button class="ghost tiny" type="button" disabled=${!enabled.size} onClick=${() => { if (!disabled) onChange([]) }}>Clear pool</button></div>
    ${bulk.length > 256 ? html`<p class="settings-note">Auto supports up to 256 enabled models. Remove saved entries or choose individual models before adding more.</p>` : null}
    ${models.length ? models.map(model => {
      const route = modelRoute(model), usable = route.ok
      const reason = model.additionalSpend === true && !capabilities.allowAdditionalSpend ? 'This connection cannot use models requiring extra usage credits.' : route.blocked?.[0]?.reason ?? route.reason
      const billingMode = status?.providers?.find(row => row.id === model.provider)?.billingMode
      const billingNote = billingMode === 'api' ? 'The adapter reports API billing.' : billingMode === 'unknown' || model.provider === 'custom' && billingMode !== 'subscription' ? 'Billing for this adapter is unverified.' : ''
      return html`<label class="assistant-model-row"><input type="checkbox" checked=${enabled.has(`${model.provider}:${model.id}`)} disabled=${(!usable || enabled.size >= 256) && !enabled.has(`${model.provider}:${model.id}`)} onChange=${event => {
        if (disabled || event.target.checked && !usableModel(model)) return
        const next = (value ?? []).filter(item => identity(item) !== `${model.provider}:${model.id}`)
        if (event.target.checked) next.push({ provider: model.provider, model: model.id })
        if (next.length <= 256) onChange(next)
      }} /><span><b>${model.name}</b><small>${providerName(model.provider)} · ${model.id}</small><small>${model.description || 'Provider has not supplied a task-fit description.'}</small>${billingNote ? html`<small>${billingNote}</small>` : null}${!usable ? html`<small>${reason}</small>` : model.additionalSpend === true ? html`<small>Provider reports additional usage credits.</small>` : null}</span></label>`
    }) : html`<p class="settings-note">No available models are listed here. Refresh status in Accounts or switch to Manual. Read model discovery details below.</p>`}
    ${missing.map(item => html`<div class="assistant-model-missing"><span>${providerName(item.provider)} · ${item.model}<small>${capabilities.autoProviders.includes(item.provider) ? 'Not in the current catalog; Auto will exclude it.' : 'This connection cannot include this provider in Auto.'}</small></span><button class="ghost tiny" type="button" onClick=${() => { if (!disabled) onChange((value ?? []).filter(value => identity(value) !== identity(item))) }}>Remove</button></div>`)}
    <details class="settings-advanced settings-disclosure" open=${!usableModels.length}><summary>Model eligibility and discovery details</summary>
    <p class="settings-note">Choose the models you want available. Auto estimates task fit from provider descriptions; exact price and remaining allowance are unknown. Catalog choices do not prove account access. A successful request confirms access to its selected model for that request.</p>
    ${(status?.providers ?? []).filter(row => row.catalogReason).map(row => html`<p class="settings-note">${providerName(row.id)}: ${row.catalogReason}</p>`)}
    </details>
  </fieldset>`
}

// The same saved settings drive the composer and Settings. Switching never affects
// an in-flight request and never changes the user's manual model behind their back.
export function AssistantControls({ status, active = false, text = '', selectionCount = 0 }) {
  const [busy, setBusy] = useState(false)
  const prefs = routingPreferencesForHost(status), supported = status?.routingSupported === true
  const ready = assistantState(status).ready
  const manual = manualModelChoices(status, prefs.provider, prefs.model)
  const efforts = manual.model?.reasoningEfforts ?? []
  const update = async changes => {
    if (active || busy) return
    const current = store.assistantStatus ?? (store.caps?.host === 'native' ? store.caps.assistant : null)
    if (status !== current) return toast('Assistant status changed. Review the current accounts and models, then try again.', 'error')
    setBusy(true)
    try {
      await api('/api/assistant/config', supported ? routingPreferencesForHost(status, { ...prefs, ...changes }) : { provider: changes.provider ?? prefs.provider, model: changes.model ?? prefs.model, agent: changes.agent ?? prefs.agent })
      await refreshAssistantStatus()
    } catch (error) { toast(error.message, 'error') }
    finally { setBusy(false) }
  }
  let preview = null
  if (supported && prefs.mode === 'auto') preview = selectRoute({ preferences: prefs, catalogs: status.catalogs ?? [], providers: status.providers ?? [], request: { text, selectionCount, requiresImage: true } })
  return html`<div class="assistant-controls" aria-label="Assistant model selection">
    <div class="assistant-control-row">
      ${supported ? html`<label><span class="sr-only">Model selection mode</span><select value=${prefs.mode} disabled=${active || busy} onChange=${event => update({ mode: event.target.value })}><option value="manual">Manual</option><option value="auto">Auto</option></select></label>` : null}
      ${prefs.mode === 'auto' && supported ? html`<label class="assistant-control-grow"><span class="sr-only">Auto preference</span><select value=${prefs.priority} disabled=${active || busy} onChange=${event => update({ priority: event.target.value })}>${routingPriorityOptions(status).map(option => html`<option value=${option.value}>${option.label}</option>`)}</select></label>` : html`<label class="assistant-control-grow"><span class="sr-only">Editing provider</span><select value=${prefs.provider} disabled=${active || busy || !status} onChange=${event => update({ provider: event.target.value, model: '', agent: '', effort: '', catalogBound: false })}>${ASSISTANT_PROVIDERS.map(provider => html`<option value=${provider.id} disabled=${status?.providers?.find(row => row.id === provider.id)?.available === false}>${provider.name}${provider.suggested ? ' · Suggested' : ''}</option>`)}</select></label>`}
      <button class="ghost tiny" aria-label="Manage assistant accounts and models" onClick=${() => set({ settingsOpen: true })}>Accounts</button>
    </div>
    ${prefs.mode === 'manual' && supported ? html`<label class="assistant-manual-model"><span class="sr-only">Manual model</span><select value=${prefs.model} disabled=${active || busy} onChange=${event => {
      if (event.target.value && !manualModelChoices(status, prefs.provider).choices.some(model => model.id === event.target.value && !model.disabled)) return
      return update({ model: event.target.value, effort: '', catalogBound: Boolean(event.target.value) })
    }}><option value="">Provider default</option>${manual.choices.map(model => html`<option value=${model.id} disabled=${model.disabled}>${model.name} · ${model.id}${model.disabled ? ' · unavailable' : ''}</option>`)}${manual.missing ? html`<option value=${prefs.model} disabled>${prefs.model} · saved selection</option>` : null}</select></label>${ready && manual.reason ? html`<p class="assistant-route-preview">${manual.reason}<small>Your saved choice is preserved. Manage exact model IDs in Accounts.</small></p>` : null}` : null}
    ${prefs.mode === 'manual' && supported && (efforts.length || prefs.effort) ? html`<label class="assistant-manual-model"><span class="sr-only">Manual reasoning effort</span><select value=${prefs.effort} disabled=${active || busy} onChange=${event => {
      if (event.target.value && !manualModelChoices(status, prefs.provider, prefs.model).model?.reasoningEfforts.includes(event.target.value)) return
      return update({ effort: event.target.value })
    }}><option value="">Provider-default effort</option>${efforts.map(effort => html`<option value=${effort}>${effort} effort</option>`)}${prefs.effort && !efforts.includes(prefs.effort) ? html`<option value=${prefs.effort} disabled>${prefs.effort} · needs refresh</option>` : null}</select></label>` : null}
    ${ready && preview ? html`<p class="assistant-route-preview">${preview.ok ? `Likely choice: ${preview.modelName ?? preview.model}` : preview.reason}<small>${preview.ok ? 'Preview only. The host refreshes account and model metadata when you send. Catalog presence does not prove access.' : !prefs.enabledModels.length ? 'Auto has no enabled models. Open Accounts, refresh status, then choose Enable available models or individual eligible models. You can switch to Manual and choose a provider and model.' : 'Choose available models in Accounts.'}</small></p>` : null}
  </div>`
}

export function RoutingReceipt({ value }) {
  if (!value?.ok) return null
  return html`<details class="assistant-routing-receipt"><summary>${value.mode === 'auto' ? 'Auto chose' : 'Requested'} ${value.modelName ?? value.model ?? 'provider default'}${value.effort ? ` · ${value.effort}` : ''}</summary><p>${value.rationale}</p><p class="muted">${providerName(value.provider)} · Requested model: ${value.model ?? 'provider default'}. The CLI has not reported an executed model identifier.</p><p class="muted">${value.billing?.note}</p></details>`
}
