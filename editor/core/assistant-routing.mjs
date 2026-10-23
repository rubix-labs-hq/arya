// Pure routing policy. Catalogs come from the host's authenticated, read-only discovery.
// A provider login, a listed model, and a safe editing adapter are separate facts.
export const ROUTING_POLICY_VERSION = 'provider-description-v1'
export const CATALOG_MAX_AGE_MS = 5 * 60 * 1000
export const PROVIDER_SETUP = Object.freeze([
  { id: 'claude-code', name: 'Claude Code', suggested: true, executable: 'claude', account: 'Claude account',
    installURL: 'https://code.claude.com/docs/en/setup', signInCommand: 'claude auth login --claudeai',
    discovery: 'No standalone model-list command was exposed by the inspected CLI.',
    productLoginApproval: 'unverified', externalInstructions: 'Sign in to your own Claude Code and connect the Arya MCP tools. Embedded consumer sign-in needs provider approval.' },
  { id: 'codex', name: 'Codex', executable: 'codex', account: 'ChatGPT account',
    installURL: 'https://developers.openai.com/codex/cli/', signInCommand: 'codex login',
    discovery: 'Codex App Server model/list', productLoginApproval: 'documented-client-integration' },
  { id: 'antigravity', name: 'Google Antigravity', executable: 'agy', account: 'Google account',
    installURL: 'https://antigravity.google/docs/getting-started/?tab=cli', signInCommand: 'Use Arya’s Sign in button for its separate profile.',
    discovery: 'agy models in Arya’s signed-in profile', adapterSupported: true,
    productLoginApproval: 'official-cli', reason: 'Uses your Google sign-in in a separate Arya profile, with only the two project tools and extra AI credits disabled. The CLI reports exact model IDs but not image capabilities or prices.' },
  { id: 'gemini-cli', name: 'Gemini CLI · retired', executable: 'gemini', account: 'Retired individual account connection',
    installURL: 'https://antigravity.google/docs/cli/gcli-migration/',
    discovery: 'Individual-account service retired by Google.', adapterSupported: false,
    reason: 'Choose Google Antigravity. Google retired Gemini CLI individual-account sign-in; existing preferences are preserved.' },
  { id: 'custom', name: 'Custom agent', account: 'Adapter-managed account', discovery: 'Adapter-supplied verified catalog',
    reason: 'Configure a host-side adapter and its model discovery. Arya does not assume its authentication or prices.' },
])

const providerIDs = new Set([...PROVIDER_SETUP.map(item => item.id), 'anthropic'])
const kinds = new Set(['provider-cli', 'provider-sdk', 'provider-docs', 'verified-custom-adapter'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const cleanText = (value, size = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, size) : ''
const token = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+\[\]-]{0,127}$/.test(value)
const failure = message => Object.assign(new Error(message), { status: 400 })
const key = (provider, id) => `${provider}:${id}`

// Qualitative fit comes from the provider's description, never a model-name table or
// an invented benchmark. It is an estimate, displayed as such in every route receipt.
export function modelFit(description) {
  const text = cleanText(description, 1000).toLowerCase()
  const quick = /\b(fast|faster|quick|efficient|lightweight|low.latency|simple|simpler|easier|affordable)\b/.test(text)
  const deep = /\b(frontier|most capable|demanding|hardest|complex|advanced|deep reasoning)\b/.test(text)
  const balanced = /\b(workhorse|everyday|daily|balanced|balances|general.purpose|versatile)\b/.test(text)
  const usage = /\b(efficient|affordable|low.cost|lower.cost)\b/.test(text) ? 'lighter' : /\b(expensive|higher.cost|high.cost|resource.intensive)\b/.test(text) ? 'heavier' : 'unknown'
  return { tier: deep ? 'deep' : balanced ? 'balanced' : quick ? 'quick' : 'unknown', usage,
    policyVersion: ROUTING_POLICY_VERSION, source: text ? 'provider-description-estimate' : 'unknown', evidence: cleanText(description, 500) }
}

export function normalizeCatalog({ provider, records, checkedAt, source, complete = true }) {
  if (!providerIDs.has(provider) || !Array.isArray(records) || records.length > 256 || !object(source) || !kinds.has(source.kind) || !Number.isSafeInteger(checkedAt) || checkedAt < 0 || complete !== true) throw failure('A complete provider-reported model catalog is required.')
  const models = [], seen = new Set()
  for (const record of records) {
    if (!object(record)) throw failure('The provider returned an unreadable model entry.')
    const id = record.model ?? record.value ?? record.id
    if (!token(id)) throw failure('The provider returned an invalid model ID.')
    if (seen.has(id)) continue
    seen.add(id)
    const efforts = record.supportedReasoningEfforts ?? record.reasoningEfforts ?? []
    if (!Array.isArray(efforts) || efforts.length > 32) throw failure('The provider returned invalid effort options.')
    const reasoningEfforts = [...new Set(efforts.map(item => object(item) ? item.reasoningEffort ?? item.id : item).filter(token))]
    const defaultEffort = record.defaultReasoningEffort ?? record.defaultEffort
    const hasModes = Array.isArray(record.inputModalities)
    // Codex documents the legacy missing-field default as text + image.
    const inputModalities = hasModes ? [...new Set(record.inputModalities.filter(mode => ['text', 'image', 'audio'].includes(mode)))] : provider === 'codex' ? ['text', 'image'] : []
    const description = cleanText(record.description, 1000)
    const retirement = record.upgradeInfo?.retirementAt
    models.push({ id, provider, name: cleanText(record.displayName ?? record.display_name ?? record.name, 160) || id,
      description, fit: modelFit(description), isDefault: record.isDefault === true,
      listed: true, hidden: record.hidden === true, available: record.available !== false,
      reasoningEfforts, defaultEffort: reasoningEfforts.includes(defaultEffort) ? defaultEffort : null,
      inputModalities, modalitiesSource: hasModes ? 'provider-catalog' : provider === 'codex' ? 'documented-legacy-default' : 'unknown',
      additionalSpend: typeof record.requiresUsageCredits === 'boolean' ? record.requiresUsageCredits : null,
      retirementAt: Number.isSafeInteger(retirement) && retirement >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, retirement * 1000) : null,
      // Model list and account type do not establish a price or a remaining allowance.
      price: null, remainingAllowance: null })
  }
  return { provider, checkedAt, source: { kind: source.kind, label: cleanText(source.label, 200) }, complete: true, models }
}

export function validateRoutingPreferences(value = {}) {
  if (!object(value) || Object.keys(value).some(field => !['mode', 'provider', 'model', 'agent', 'effort', 'priority', 'enabledModels', 'allowAdditionalSpend', 'allowAPIBilling', 'catalogBound'].includes(field))) throw failure('Unsupported assistant routing preference.')
  const mode = value.mode ?? 'manual', provider = value.provider ?? 'claude-code', model = value.model ?? '', agent = value.agent ?? '', priority = value.priority ?? 'balanced'
  if (!['manual', 'auto'].includes(mode) || !providerIDs.has(provider) || !['balanced', 'quick', 'quality'].includes(priority)) throw failure('Choose a supported mode, provider and Auto priority.')
  if (typeof model !== 'string' || model && !token(model)) throw failure('Use an exact model ID from the provider, or leave Manual model empty for its default.')
  const effort = value.effort ?? ''
  if (typeof effort !== 'string' || effort && !token(effort)) throw failure('Use an exact advertised reasoning effort, or leave it empty for the provider default.')
  if (typeof agent !== 'string' || agent.length > 128 || /[\u0000-\u001f\u007f]/.test(agent) || agent.startsWith('-') || provider !== 'claude-code' && agent) throw failure('Named agents are supported only by Claude Code.')
  if (value.allowAdditionalSpend !== undefined && typeof value.allowAdditionalSpend !== 'boolean') throw failure('Additional spending preference must be a boolean.')
  if (value.allowAPIBilling !== undefined && typeof value.allowAPIBilling !== 'boolean') throw failure('API billing preference must be a boolean.')
  if (value.catalogBound !== undefined && typeof value.catalogBound !== 'boolean') throw failure('Catalog model binding must be a boolean.')
  const input = value.enabledModels ?? []
  if (!Array.isArray(input) || input.length > 256) throw failure('Choose at most 256 models for Auto.')
  const seen = new Set(), enabledModels = []
  for (const item of input) {
    if (!object(item) || Object.keys(item).some(field => !['provider', 'model'].includes(field)) || !providerIDs.has(item.provider) || !token(item.model)) throw failure('Auto pool entries need exact provider and model IDs.')
    const id = key(item.provider, item.model)
    if (!seen.has(id)) { seen.add(id); enabledModels.push({ provider: item.provider, model: item.model }) }
  }
  return { mode, provider, model, agent, effort, priority, catalogBound: value.catalogBound === true, enabledModels, allowAdditionalSpend: value.allowAdditionalSpend === true, allowAPIBilling: value.allowAPIBilling === true }
}

export function taskFit(request = {}, priority = 'balanced') {
  if (priority === 'quick') return { tier: 'quick', rationale: 'You selected Speed for this request.', source: 'user-preference' }
  if (priority === 'quality') return { tier: 'deep', rationale: 'You selected Quality for this request.', source: 'user-preference' }
  const text = cleanText(request.text, 128000)
  const count = Number.isSafeInteger(request.selectionCount) ? Math.max(0, request.selectionCount) : 0
  const longInput = ['script', 'screenplay'].includes(request.inputKind) || text.length > 2500
  const creative = /\b(build|create|design|generate|compose|storyboard|reconstruct)\b/i.test(text) && /\b(video|film|scene|sequence|motion|transition|effect|animation)\b/i.test(text)
  if (longInput || count > 12 || creative) return { tier: 'deep', rationale: longInput ? 'The request contains a script, screenplay or long brief.' : creative ? 'The request asks for a new creative sequence or component.' : 'The request spans many selected clips.', source: 'task-scope-estimate' }
  const direct = /^(?:please\s+)?(?:rename|replace|change|set|trim|move|delete|remove|mute|unmute|fix (?:the )?(?:typo|spelling))/i.test(text)
  if (text.length <= 320 && count > 0 && count <= 3 && direct) return { tier: 'quick', rationale: 'This is a short, direct edit to a small selection.', source: 'task-scope-estimate' }
  return { tier: 'balanced', rationale: 'The request has no clear need for the fastest or deepest model.', source: 'task-scope-estimate' }
}

const usageOrder = ['lighter', 'unknown', 'heavier']
const order = { quick: ['quick', 'balanced', 'deep', 'unknown'], balanced: ['balanced', 'quick', 'deep', 'unknown'], deep: ['deep', 'balanced', 'unknown', 'quick'] }

// Synchronous decision; the host refreshes its own discovery before calling it and
// binds this immutable provider/model choice to the run. Never reroute a committed run.
export function selectRoute({ preferences = {}, catalogs = [], providers = [], request = {}, now = Date.now(), maxAgeMs = CATALOG_MAX_AGE_MS } = {}) {
  const prefs = validateRoutingPreferences(preferences)
  if (!Array.isArray(catalogs) || !Array.isArray(providers) || !Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) throw failure('Routing needs current provider metadata.')
  const blocked = []
  const provider = id => providers.find(item => item.id === id)
  const usableProvider = id => {
    const status = provider(id)
    return status?.authenticated === true && status?.adapterSupported === true && status?.available !== false && status?.rateLimited !== true
  }
  if (prefs.mode === 'manual') {
    const status = provider(prefs.provider)
    if (!usableProvider(prefs.provider)) return { ok: false, mode: 'manual', reason: cleanText(status?.reason) || 'This provider is not ready for an editing request.', recovery: 'connect-provider' }
    if ((prefs.model || prefs.effort || prefs.catalogBound) && status?.modelSelectionSupported !== true) return { ok: false, mode: 'manual', reason: 'This editing adapter cannot bind an exact requested model.', recovery: 'configure-model-binding' }
    // Explicit Manual effort is verified against its exact current model.
    let manualModel = prefs.model || null
    if (prefs.effort || prefs.catalogBound) {
      const catalog = catalogs.find(item => item.provider === prefs.provider)
      const model = catalog?.models?.find(item => prefs.model ? item.id === prefs.model : item.isDefault)
      if (!catalog?.complete || !kinds.has(catalog.source?.kind) || catalog.checkedAt > now || now - catalog.checkedAt > maxAgeMs || !model || model.listed !== true || model.available === false || model.hidden || model.retirementAt !== null && model.retirementAt <= now || prefs.effort && !model.reasoningEfforts?.includes(prefs.effort)) return { ok: false, mode: 'manual', reason: 'The selected Manual model or effort is not available in a fresh verified catalog. Refresh status or deliberately choose an unverified advanced model ID.', recovery: 'refresh-model-efforts' }
      manualModel = model.id
    }
    // Manual retains the user's exact model/agent choice. Provider defaults are explicit.
    return { ok: true, mode: 'manual', provider: prefs.provider, model: manualModel, catalogBound: prefs.catalogBound || !!prefs.effort, agent: prefs.agent || null, effort: prefs.effort || null,
      rationale: prefs.model || prefs.effort ? 'Using your exact manual model and supported effort selection.' : 'Using this provider’s configured default model.',
      billing: { estimatedCost: null, remainingAllowance: null, note: 'Pricing and remaining usage are not inferred from sign-in.' } }
  }
  const fit = taskFit(request, prefs.priority), candidates = []
  const requireImage = request.requiresImage !== false
  for (const [poolIndex, enabled] of prefs.enabledModels.entries()) {
    const identity = key(enabled.provider, enabled.model)
    let reason = null
    const catalog = catalogs.find(item => item.provider === enabled.provider)
    const model = catalog?.models?.find(item => item.id === enabled.model)
    if (!usableProvider(enabled.provider)) reason = cleanText(provider(enabled.provider)?.reason) || 'Provider authentication or editing adapter is unavailable.'
    else if (provider(enabled.provider)?.modelSelectionSupported !== true) reason = 'This editing adapter cannot bind an exact requested model.'
    else if (provider(enabled.provider)?.billingMode !== 'subscription' && !['claude-code', 'codex'].includes(enabled.provider) && !prefs.allowAPIBilling) reason = 'This adapter has API or unverified billing. Opt in before including it in Auto.'
    else if (prefs.agent && enabled.provider !== 'claude-code') reason = 'Your named Claude agent requires Claude Code.'
    else if (!catalog || !catalog.complete || !kinds.has(catalog.source?.kind)) reason = 'The provider has not supplied a complete model catalog.'
    else if (catalog.checkedAt > now || now - catalog.checkedAt > maxAgeMs) reason = 'The model catalog needs a refresh.'
    else if (!model || model.listed !== true || model.available === false || model.hidden) reason = 'The exact model is absent, unavailable or hidden in the current catalog.'
    else if (model.retirementAt !== null && model.retirementAt <= now) reason = 'The provider reports that this model has retired.'
    else if (requireImage && !model.inputModalities?.includes('image')) reason = 'Frame inspection support is unknown or unavailable for this model.'
    else if (model.additionalSpend === true && !prefs.allowAdditionalSpend) reason = 'The provider says this model requires additional usage credits.'
    if (reason) { blocked.push({ provider: enabled.provider, model: enabled.model, reason }); continue }
    candidates.push({ model, poolIndex, fitIndex: order[fit.tier].indexOf(model.fit?.tier ?? 'unknown') })
    // Malformed/unrecognized fit data can never become an artificially preferred tier.
    if (candidates.at(-1).fitIndex < 0) candidates.at(-1).fitIndex = order[fit.tier].length
  }
  if (!candidates.length) return { ok: false, mode: 'auto', reason: prefs.enabledModels.length ? 'No enabled model has a current catalog and a ready editing adapter.' : 'Enable at least one verified model in Auto settings.', recovery: 'refresh-and-select-models', blocked }
  candidates.sort((a, b) => a.fitIndex - b.fitIndex || Math.max(0, usageOrder.includes(a.model.fit?.usage) ? usageOrder.indexOf(a.model.fit.usage) : 1) - Math.max(0, usageOrder.includes(b.model.fit?.usage) ? usageOrder.indexOf(b.model.fit.usage) : 1) || Number(b.model.isDefault) - Number(a.model.isDefault) || a.poolIndex - b.poolIndex)
  const chosen = candidates[0].model
  const matched = chosen.fit?.tier === fit.tier
  const fallback = matched ? null : chosen.fit?.tier !== 'unknown' ? 'closest-described-category' : chosen.isDefault ? 'provider-default-in-enabled-pool' : 'user-enabled-pool-order'
  const efforts = chosen.reasoningEfforts ?? []
  // Effort IDs must come from the selected model's own advertised options.
  const preferredEffort = fit.tier === 'quick' ? 'low' : fit.tier === 'deep' ? 'high' : 'medium'
  const effort = efforts.includes(preferredEffort) ? preferredEffort : efforts.includes(chosen.defaultEffort) ? chosen.defaultEffort : null
  const limited = chosen.fit?.tier === 'unknown' || chosen.fit?.tier !== fit.tier
  return { ok: true, mode: 'auto', provider: chosen.provider, model: chosen.id, agent: chosen.provider === 'claude-code' ? prefs.agent || null : null, effort,
    modelName: chosen.name, policyVersion: ROUTING_POLICY_VERSION, fallback, taskFit: fit, fitEvidence: chosen.fit,
    rationale: `${fit.rationale} ${limited ? chosen.isDefault ? 'No exact task-fit description matched; using the provider default from your enabled compatible pool.' : chosen.fit?.tier === 'unknown' ? 'Task-fit metadata is unknown; using your first enabled compatible model. No quality, speed or cost comparison is claimed.' : 'No exact task-fit description matched; using the closest documented category in your enabled pool, as a qualitative estimate.' : `The provider describes this model as suited to ${fit.tier === 'quick' ? 'quick work' : fit.tier === 'deep' ? 'demanding work' : 'everyday work'}.`} ${effort ? `Using its supported ${effort} effort.` : 'Using its provider-default effort.'}`,
    scope: 'One request; no automatic mid-run fallback.',
    billing: { estimatedCost: null, remainingAllowance: null, additionalSpend: chosen.additionalSpend, note: 'Exact price and remaining allowance are unknown unless the provider reports them. Auto uses qualitative task fit, not invented cost or quality scores. Lower usage breaks fit ties only when a provider description explicitly supports it.' },
    considered: candidates.map(item => ({ provider: item.model.provider, model: item.model.id })), blocked }
}
