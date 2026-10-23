import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'
import { normalizeCatalog, selectRoute } from '../core/assistant-routing.mjs'
import { ASSISTANT_PROVIDERS, assistantState, providerName, safeInstallURL } from '../web/ui/assistant-state.js'

// HTM and Preact are real. Inert hooks keep these tests independent of a browser,
// while still catching broken templates and wrong nested element types.
const componentSource = name => [fs.readFileSync(new URL('../web/ui/assistant-status.js', import.meta.url), 'utf8'), fs.readFileSync(new URL(`../web/ui/${name}`, import.meta.url), 'utf8')].join('\n').replace(/^import .*$/gm, '').replace(/^export \{.*$/gm, '').replace(/^export /gm, '')
const source = componentSource('provider-controls.js')
const components = new Function('h', 'htm', 'useState', 'api', 'set', 'store', 'toast', 'ASSISTANT_PROVIDERS', 'assistantState', 'providerName', 'selectRoute', `${source}\nreturn {AssistantControls,ModelPool,RoutingReceipt,autoModelPool,routingCapabilities,routingPreferencesForHost,routingPriorityOptions,routingPreferences,manualModelChoices}`)(h, htm, value => [value, () => {}], () => {}, () => {}, {}, () => {}, ASSISTANT_PROVIDERS, assistantState, providerName, selectRoute)
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const children = value => flatten(value?.props?.children)
const nodes = value => value && typeof value === 'object' ? [value, ...children(value).flatMap(nodes)] : []
const text = value => children(value).map(child => typeof child === 'object' ? text(child) : child).join(' ').replace(/\s+/g, ' ').trim()
const catalog = normalizeCatalog({ provider: 'codex', checkedAt: Date.now(), source: { kind: 'provider-cli', label: 'Provider description fixture' }, records: [{ id: 'swift', displayName: 'Swift model', description: 'Fast and efficient for simpler tasks.', inputModalities: ['text', 'image'], supportedReasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'medium', isDefault: true }] })
const status = { configured: true, provider: 'codex', mode: 'manual', model: 'swift', effort: 'low', routingSupported: true, providers: [{ id: 'codex', adapterSupported: true, modelSelectionSupported: true, installed: true, authenticated: true, available: true }], catalogs: [catalog], enabledModels: [{ provider: 'codex', model: 'swift' }] }

test('composer exposes direct provider, exact model and actual effort controls; busy disables mutation', () => {
  for (const active of [false, true]) {
    const tree = components.AssistantControls({ status, active })
    const all = nodes(tree)
    for (const node of all) assert.ok(typeof node.type === 'string' || typeof node.type === 'function')
    const selects = all.filter(node => node.type === 'select')
    assert.equal(selects.length, 4)
    assert.ok(selects.every(node => node.props.disabled === active))
    assert.ok(all.some(node => node.type === 'option' && node.props.value === 'swift'))
    assert.ok(all.some(node => node.type === 'option' && node.props.value === 'low'))
    assert.ok(all.some(node => node.type === 'option' && text(node).includes('Claude Code · Suggested')))
  }
})

test('Auto preview uses the verified enabled model and explicitly labels preview versus dispatch', () => {
  const tree = components.AssistantControls({ status: { ...status, mode: 'auto' }, text: 'Rename the title', selectionCount: 1 })
  const all = nodes(tree)
  assert.ok(all.some(node => node.props?.class === 'assistant-route-preview' && text(node).includes('Likely choice: Swift model')))
  assert.match(text(tree), /host refreshes account and model metadata/)
  assert.equal(all.filter(node => node.type === 'select').length, 2)
})

test('model pool changes exact IDs only and keeps unavailable saved entries visibly removable', () => {
  let changed
  const value = [...status.enabledModels, { provider: 'codex', model: 'missing' }]
  const tree = components.ModelPool({ status, value, onChange: next => { changed = next } })
  const all = nodes(tree)
  const checkbox = all.find(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(checkbox.props.checked, true); assert.equal(checkbox.props.disabled, false)
  checkbox.props.onChange({ target: { checked: false } })
  assert.deepEqual(changed, [{ provider: 'codex', model: 'missing' }])
  assert.match(text(tree), /Not in the current catalog/)
  all.find(node => node.type === 'button' && text(node) === 'Remove').props.onClick()
  assert.deepEqual(changed, status.enabledModels)
})

test('saved unusable Auto models can be removed but never re-enabled while still unusable', () => {
  const scenarios = [
    { name: 'stale', catalogs: [{ ...catalog, checkedAt: Date.now() - 301000 }] },
    { name: 'retired', catalogs: [{ ...catalog, models: catalog.models.map(model => ({ ...model, retirementAt: Date.now() - 1 })) }] },
    { name: 'adapter not ready', providers: status.providers.map(row => ({ ...row, available: false })) },
    { name: 'unsupported extra credits', routingCapabilities: { priorities: ['balanced'], allowAdditionalSpend: false, allowAPIBilling: false, autoProviders: ['codex'] }, catalogs: [{ ...catalog, models: catalog.models.map(model => ({ ...model, additionalSpend: true })) }] },
  ]
  for (const scenario of scenarios) {
    const unavailable = { ...status, ...scenario }, saved = status.enabledModels
    let changed, changes = 0
    const render = value => components.ModelPool({ status: unavailable, value, onChange: next => { changed = next; changes++ } })
    const checked = nodes(render(saved)).find(node => node.type === 'input')
    assert.equal(checked.props.checked, true, scenario.name); assert.equal(checked.props.disabled, false, scenario.name)
    checked.props.onChange({ target: { checked: false } })
    assert.deepEqual(changed, [], scenario.name); assert.equal(changes, 1)
    const unchecked = nodes(render(changed)).find(node => node.type === 'input')
    assert.equal(unchecked.props.checked, false, scenario.name); assert.equal(unchecked.props.disabled, true, scenario.name)
    unchecked.props.onChange({ target: { checked: true } })
    assert.equal(changes, 1, 'An unusable model cannot be added through a stale/programmatic callback.')
    assert.equal(components.ModelPool({ status: unavailable, value: saved, disabled: true, onChange: () => {} }).props.disabled, true)
  }
})

test('bulk Auto setup uses individual eligibility, preserves saved missing choices, and clears the entire pool', () => {
  const second = { ...catalog.models[0], id: 'second-model', name: 'Second model' }
  const retired = { ...catalog.models[0], id: 'retired-model', name: 'Retired model', retirementAt: Date.now() - 1 }
  const credits = { ...catalog.models[0], id: 'credit-model', name: 'Credit model', additionalSpend: true }
  const current = { ...nativeStatus, catalogs: [{ ...catalog, models: [...catalog.models, second, retired, credits] }] }
  const saved = [{ provider: 'codex', model: 'missing-saved-model' }]
  let changed
  const tree = components.ModelPool({ status: current, value: saved, onChange: value => { changed = value } })
  const all = nodes(tree), bulk = all.find(node => node.type === 'button' && text(node) === 'Enable available models')
  assert.equal(bulk.props.disabled, false)
  bulk.props.onClick()
  assert.deepEqual(changed, [...saved, { provider: 'codex', model: 'swift' }, { provider: 'codex', model: 'second-model' }])
  const individualEligible = all.filter(node => node.props?.class === 'assistant-model-row').filter(row => nodes(row).find(node => node.type === 'input').props.disabled === false).map(row => nodes(row).find(node => node.type === 'input'))
  assert.equal(individualEligible.length, 2)
  all.find(node => node.type === 'button' && text(node) === 'Clear pool').props.onClick()
  assert.deepEqual(changed, [])
  const empty = components.ModelPool({ status: current, value: [], onChange: () => {} })
  assert.equal(nodes(empty).find(node => node.type === 'button' && text(node) === 'Clear pool').props.disabled, true)
  assert.match(text(tree), /task fit from provider descriptions/); assert.match(text(tree), /price and remaining allowance are unknown/)
})

test('bulk Auto setup cannot exceed the host pool limit or add unready models', () => {
  const missing = Array.from({ length: 256 }, (_, index) => ({ provider: 'codex', model: `saved-${index}` }))
  const capped = components.ModelPool({ status, value: missing, onChange: () => {} })
  assert.equal(nodes(capped).find(node => node.type === 'button' && text(node) === 'Enable available models').props.disabled, true)
  assert.match(text(capped), /up to 256 enabled models/)
  const unavailable = components.ModelPool({ status: { ...status, providers: status.providers.map(row => ({ ...row, available: false })) }, value: [], onChange: () => {} })
  assert.equal(nodes(unavailable).find(node => node.type === 'button' && text(node) === 'Enable available models').props.disabled, true)
})

test('routing receipt exposes the requested exact choice and unknown executed-model boundary', () => {
  const route = selectRoute({ preferences: { mode: 'auto', enabledModels: status.enabledModels }, catalogs: [catalog], providers: status.providers, request: { text: 'Rename the title', selectionCount: 1 } })
  const tree = components.RoutingReceipt({ value: route })
  assert.match(text(tree), /Auto chose Swift model/)
  assert.match(text(tree), /Requested model: swift/)
  assert.match(text(tree), /has not reported an executed model identifier/)
  assert.match(text(tree), /Exact price and remaining allowance are unknown/)
})

test('Settings renders real account setup steps and Auto pool without malformed nesting', () => {
  const source = componentSource('settings.js')
  for (const mode of ['auto', 'manual']) {
  const state = { caps: {}, assistantStatus: { ...status, mode } }
  const render = new Function('h', 'htm', 'useEffect', 'useRef', 'useState', 'useStore', 'api', 'set', 'store', 'toast', 'ASSISTANT_PROVIDERS', 'assistantState', 'providerName', 'safeInstallURL', 'LayoutMenu', 'registry', 'ModelPool', 'autoModelPool', 'assistantActivity', 'routingPreferences', 'routingCapabilities', 'routingPreferencesForHost', 'routingPriorityOptions', 'manualModelChoices', `const host = { kind: "http" };\n${source}\nreturn Settings()`)
  const tree = render(h, htm, () => {}, value => ({ current: value }), value => [value, () => {}], () => state, () => {}, () => {}, state, () => {}, ASSISTANT_PROVIDERS, assistantState, providerName, safeInstallURL, () => null, { settings: [] }, components.ModelPool, components.autoModelPool, assistantActivity, components.routingPreferences, components.routingCapabilities, components.routingPreferencesForHost, components.routingPriorityOptions, components.manualModelChoices)
  const all = nodes(tree)
  for (const node of all) assert.ok(typeof node.type === 'string' || typeof node.type === 'function')
  assert.deepEqual(all.filter(node => node.type === 'h3' && /^[123]\./.test(text(node))).map(text), ['1. Choose your assistant', '2. Sign in', '3. Turn on the assistant'])
  assert.ok(all.some(node => node.type === 'select' && node.props.value === mode))
  assert.equal(all.some(node => node.type === components.ModelPool), mode === 'auto')
  if (mode === 'manual') assert.ok(all.some(node => node.type === 'select' && node.props.value === 'swift'))
  assert.match(text(tree), /Set up your editing assistant/)
  }
})


const nativeCapabilities = { priorities: ['balanced'], allowAdditionalSpend: false, allowAPIBilling: false, autoProviders: ['claude-code', 'codex'] }
const nativeStatus = { ...status, mode: 'auto', priority: 'balanced', routingCapabilities: nativeCapabilities }
const assistantActivity = new Function(`${componentSource('assistant-activity.js')}\nreturn assistantActivity`)()

function settingsHarness(assistantStatus, api = () => {}) {
  const source = componentSource('settings.js')
  const state = { caps: { host: assistantStatus.routingCapabilities ? 'native' : 'browser' }, assistantStatus }
  const values = [], refs = []
  let stateIndex = 0, refIndex = 0
  const useState = initial => {
    const index = stateIndex++
    if (!(index in values)) values[index] = initial
    return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next }]
  }
  const useRef = initial => {
    const index = refIndex++
    return refs[index] ??= { current: initial }
  }
  const render = new Function('h', 'htm', 'useEffect', 'useRef', 'useState', 'useStore', 'api', 'set', 'store', 'toast', 'ASSISTANT_PROVIDERS', 'assistantState', 'providerName', 'safeInstallURL', 'LayoutMenu', 'registry', 'ModelPool', 'autoModelPool', 'assistantActivity', 'routingPreferences', 'routingCapabilities', 'routingPreferencesForHost', 'routingPriorityOptions', 'manualModelChoices', `const host = { kind: "http" };\n${source}\nreturn Settings()`)
  return { render() {
    stateIndex = 0; refIndex = 0
    return render(h, htm, () => {}, useRef, useState, () => state, api, update => Object.assign(state, update), state, () => {}, ASSISTANT_PROVIDERS, assistantState, providerName, safeInstallURL, () => null, { settings: [] }, components.ModelPool, components.autoModelPool, assistantActivity, components.routingPreferences, components.routingCapabilities, components.routingPreferencesForHost, components.routingPriorityOptions, components.manualModelChoices)
  } }
}
const renderSettings = (status, api) => settingsHarness(status, api).render()
const optionValues = node => nodes(node).filter(child => child.type === 'option').map(child => child.props.value)

test('Settings explicit refresh requests fresh metadata while ordinary status helpers retain cached polling', async () => {
  const requests = []
  const settings = settingsHarness(status, async path => { requests.push(path); return status })
  const refresh = nodes(settings.render()).find(node => node.type === 'button' && text(node) === 'Refresh status')
  await refresh.props.onClick()
  assert.deepEqual(requests, ['/api/assistant/status?refresh=1'])
  const source = componentSource('settings.js')
  const helper = new Function('h', 'htm', 'api', 'set', `${source}\nreturn refreshAssistantStatus`)(h, htm, async path => { requests.push(path); return status }, () => {})
  await helper()
  assert.deepEqual(requests, ['/api/assistant/status?refresh=1', '/api/assistant/status'])
})

test('hosted native Settings exposes Balanced only and no unsupported billing opt-ins', () => {
  const tree = renderSettings(nativeStatus), all = nodes(tree)
  for (const node of all) assert.ok(typeof node.type === 'string' || typeof node.type === 'function')
  const priority = all.find(node => node.type === 'select' && optionValues(node).includes('balanced'))
  assert.deepEqual(optionValues(priority), ['balanced'])
  assert.equal(all.some(node => node.type === 'input' && node.props.type === 'checkbox'), false)
  assert.match(text(tree), /Auto cannot use models requiring extra usage credits/)
  assert.match(text(tree), /API billing cannot be enabled for Auto/)
  const pool = all.find(node => node.type === components.ModelPool)
  assert.equal(pool.props.status.routingCapabilities, nativeCapabilities)
})

test('native composer exposes only its supported Auto priority and preserves busy guards', () => {
  for (const active of [false, true]) {
    const tree = components.AssistantControls({ status: nativeStatus, active })
    const priority = nodes(tree).find(node => node.type === 'select' && optionValues(node).includes('balanced'))
    assert.deepEqual(optionValues(priority), ['balanced']); assert.equal(priority.props.disabled, active)
    assert.equal(optionValues(tree).includes('quick'), false); assert.equal(optionValues(tree).includes('quality'), false)
  }
})

test('native model pool excludes unsupported providers and disables extra-credit models', () => {
  const custom = normalizeCatalog({ provider: 'custom', checkedAt: Date.now(), source: { kind: 'verified-custom-adapter', label: 'Configured adapter fixture' }, records: [{ id: 'custom-model', displayName: 'Custom pool model', inputModalities: ['text', 'image'] }] })
  const credits = { ...catalog, models: [...catalog.models, { ...catalog.models[0], id: 'credit-model', name: 'Credit model', additionalSpend: true }] }
  const saved = [...nativeStatus.enabledModels, { provider: 'custom', model: 'custom-model' }]
  const tree = components.ModelPool({ status: { ...nativeStatus, catalogs: [credits, custom] }, value: saved, onChange: () => {} })
  const rows = nodes(tree).filter(node => node.props?.class === 'assistant-model-row')
  assert.equal(rows.length, 2)
  const allowed = rows.find(row => text(row).includes('Swift model')), blocked = rows.find(row => text(row).includes('Credit model'))
  assert.equal(nodes(allowed).find(node => node.type === 'input').props.disabled, false)
  assert.equal(nodes(blocked).find(node => node.type === 'input').props.disabled, true)
  assert.match(text(blocked), /cannot use models requiring extra usage credits/)
  assert.match(text(tree), /This connection cannot include this provider in Auto/)
})

test('legacy browser hosts retain Speed, Quality and billing opt-ins while unknown custom authentication stays blocked', () => {
  const tree = renderSettings({ ...status, mode: 'auto' }), all = nodes(tree)
  const priority = all.find(node => node.type === 'select' && optionValues(node).includes('balanced'))
  assert.deepEqual(optionValues(priority), ['balanced', 'quick', 'quality'])
  assert.equal(all.filter(node => node.type === 'input' && node.props.type === 'checkbox').length, 2)
  const custom = normalizeCatalog({ provider: 'custom', checkedAt: Date.now(), source: { kind: 'verified-custom-adapter', label: 'Configured adapter fixture' }, records: [{ id: 'custom-model', displayName: 'Custom pool model', inputModalities: ['text', 'image'] }] })
  const pool = components.ModelPool({ status: { ...status, catalogs: [custom], providers: [{ id: 'custom', adapterManaged: true, adapterSupported: true, modelSelectionSupported: true, available: true }], allowAPIBilling: true }, value: [], onChange: () => {} })
  const checkbox = nodes(pool).find(node => node.type === 'input')
  assert.ok(checkbox); assert.equal(checkbox.props.disabled, true); assert.match(text(pool), /authentication or editing adapter is unavailable/)
})

test('native save and composer payloads cannot contain unsupported stale routing choices', async () => {
  const dirty = { ...nativeStatus, priority: 'quality', allowAdditionalSpend: true, allowAPIBilling: true, enabledModels: [...nativeStatus.enabledModels, { provider: 'custom', model: 'custom-model' }] }
  const requests = [], api = async (path, body) => { requests.push({ path, body }); return nativeStatus }
  const settings = settingsHarness(dirty, api), tree = settings.render()
  const activate = nodes(tree).find(node => node.type === 'select' && optionValues(node).includes('claude-code'))
  activate.props.onChange({ target: { value: 'codex' } })
  const save = nodes(settings.render()).find(node => node.type === 'button' && text(node) === 'Save and close')
  assert.ok(save); await save.props.onClick()
  const settingsBody = requests.find(value => value.path === '/api/assistant/config').body
  assert.equal(settingsBody.priority, 'balanced'); assert.equal(settingsBody.allowAdditionalSpend, false); assert.equal(settingsBody.allowAPIBilling, false)
  assert.equal(settingsBody.mode, 'auto')
  assert.deepEqual(settingsBody.enabledModels, nativeStatus.enabledModels)
  assert.equal(settingsBody.provider, 'codex'); assert.equal(settingsBody.model, '')
  requests.length = 0
  const source = componentSource('provider-controls.js')
  const dynamic = new Function('h', 'htm', 'useState', 'api', 'set', 'store', 'toast', 'ASSISTANT_PROVIDERS', 'assistantState', 'providerName', 'selectRoute', `${source}\nreturn {AssistantControls}`)(h, htm, value => [value, () => {}], api, () => {}, { assistantStatus: dirty }, () => {}, ASSISTANT_PROVIDERS, assistantState, providerName, selectRoute)
  const composer = dynamic.AssistantControls({ status: dirty })
  const priority = nodes(composer).find(node => node.type === 'select' && optionValues(node).includes('balanced'))
  await priority.props.onChange({ target: { value: 'quality' } })
  const saved = requests.find(value => value.path === '/api/assistant/config').body
  assert.equal(saved.priority, 'balanced'); assert.equal(saved.allowAdditionalSpend, false); assert.equal(saved.allowAPIBilling, false)
  assert.deepEqual(saved.enabledModels, nativeStatus.enabledModels)
})

test('native Auto capabilities do not remove exact custom Manual model choices', () => {
  const custom = normalizeCatalog({ provider: 'custom', checkedAt: Date.now(), source: { kind: 'verified-custom-adapter', label: 'Configured adapter fixture' }, records: [{ id: 'custom-model', displayName: 'Custom manual model', inputModalities: ['text', 'image'] }] })
  const manual = { ...nativeStatus, mode: 'manual', provider: 'custom', model: 'custom-model', catalogs: [custom] }
  const settings = renderSettings(manual)
  assert.ok(nodes(settings).some(node => node.type === 'option' && node.props.value === 'custom-model'))
  const composer = components.AssistantControls({ status: manual })
  assert.ok(nodes(composer).some(node => node.type === 'select' && node.props.value === 'custom-model'))
})

test('declared capability contracts exclude unrecognized values and default to a safe empty pool', () => {
  const capabilities = components.routingCapabilities({ routingCapabilities: { priorities: ['unsupported', 'balanced', 'balanced'], allowAdditionalSpend: 'yes', allowAPIBilling: 1, autoProviders: ['custom', 'invented', 'custom'] } })
  assert.deepEqual(capabilities, { priorities: ['balanced'], allowAdditionalSpend: false, allowAPIBilling: false, autoProviders: ['custom'] })
  assert.deepEqual(components.routingCapabilities({ routingCapabilities: {} }).autoProviders, [])
})

test('Use provider explicitly selects Manual and exact form preferences while retaining the Auto pool', async () => {
  for (const initial of [nativeStatus, { ...status, mode: 'auto', priority: 'balanced' }]) {
    const selected = { id: 'claude-code', installed: true, authenticated: true, available: true, adapterSupported: true, modelSelectionSupported: true }
    const pool = [...initial.enabledModels, { provider: 'claude-code', model: 'pooled-model' }]
    const before = { ...initial, providers: [...initial.providers, selected], enabledModels: pool }
    const fresh = { ...before, provider: 'claude-code', mode: 'manual', model: 'chosen-exact-model', agent: 'chosen-agent', effort: '', catalogBound: false }
    const requests = [], api = async (path, body) => { requests.push({ path, body }); return fresh }
    const settings = settingsHarness(before, api)
    const provider = nodes(settings.render()).find(node => node.type === 'select' && optionValues(node).includes('claude-code'))
    provider.props.onChange({ target: { value: 'claude-code' } })
    const inputs = nodes(settings.render()).filter(node => node.type === 'input' && node.props.placeholder === 'Provider default')
    assert.equal(inputs.length, 2)
    inputs[0].props.onInput({ target: { value: 'chosen-exact-model' } })
    inputs[1].props.onInput({ target: { value: 'chosen-agent' } })
    const use = nodes(settings.render()).find(node => node.type === 'button' && text(node) === 'Use Claude Code')
    assert.ok(use); await use.props.onClick()
    assert.deepEqual(requests.map(request => request.path), ['/api/assistant/config', '/api/assistant/status'])
    const saved = requests[0].body
    assert.equal(saved.mode, 'manual'); assert.equal(saved.provider, 'claude-code')
    assert.equal(saved.model, 'chosen-exact-model'); assert.equal(saved.agent, 'chosen-agent')
    assert.equal(saved.effort, ''); assert.equal(saved.catalogBound, false)
    assert.equal(saved.priority, 'balanced'); assert.deepEqual(saved.enabledModels, pool)
    const mode = nodes(settings.render()).find(node => node.type === 'select' && optionValues(node).includes('auto'))
    assert.equal(mode.props.value, 'manual')
    assert.equal(nodes(settings.render()).some(node => node.type === components.ModelPool), false)
  }
})

test('failed Use provider does not silently switch the visible mode or discard the saved Auto pool', async () => {
  const before = { ...nativeStatus, providers: [...nativeStatus.providers, { id: 'claude-code', installed: true, authenticated: true, available: true }] }
  const requests = [], settings = settingsHarness(before, async (path, body) => { requests.push({ path, body }); throw new Error('Could not validate the selected account') })
  const provider = nodes(settings.render()).find(node => node.type === 'select' && optionValues(node).includes('claude-code'))
  provider.props.onChange({ target: { value: 'claude-code' } })
  const use = nodes(settings.render()).find(node => node.type === 'button' && text(node) === 'Use Claude Code')
  await use.props.onClick()
  assert.equal(requests.length, 1); assert.equal(requests[0].body.mode, 'manual')
  assert.deepEqual(requests[0].body.enabledModels, before.enabledModels)
  const tree = settings.render(), mode = nodes(tree).find(node => node.type === 'select' && optionValues(node).includes('auto'))
  assert.equal(mode.props.value, 'auto')
  assert.match(text(tree), /Could not validate the selected account/)
  assert.deepEqual(nodes(tree).find(node => node.type === components.ModelPool).props.value, before.enabledModels)
})


test('not-ready Auto keeps account/model controls and suppresses a dispatch preview', () => {
  const tree = components.AssistantControls({ status: { ...status, configured: false, mode: 'auto' } })
  assert.equal(nodes(tree).some(node => node.props?.class === 'assistant-route-preview'), false)
  assert.equal(nodes(tree).filter(node => node.type === 'select').length, 2)
  assert.ok(nodes(tree).find(node => node.props?.['aria-label'] === 'Manage assistant accounts and models'))
})
