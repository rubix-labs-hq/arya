import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { h } from 'preact'
import htm from 'htm'
import { normalizeCatalog, selectRoute } from '../core/assistant-routing.mjs'
import { ASSISTANT_PROVIDERS, assistantState, providerName, safeInstallURL } from '../web/ui/assistant-state.js'

const root = process.env.ARYA_SELECTION_SOURCE_ROOT ? pathToFileURL(path.resolve(process.env.ARYA_SELECTION_SOURCE_ROOT) + '/') : new URL('../', import.meta.url)
const source = name => [fs.readFileSync(new URL('web/ui/assistant-status.js', root), 'utf8'), fs.readFileSync(new URL(name, root), 'utf8')].join('\n').replace(/^import .*$/gm, '').replace(/^export \{.*$/gm, '').replace(/^export /gm, '')
const components = new Function('h', 'htm', 'useState', 'api', 'set', 'store', 'toast', 'ASSISTANT_PROVIDERS', 'assistantState', 'providerName', 'selectRoute', `${source('web/ui/provider-controls.js')}\nreturn {AssistantControls, ModelPool, autoModelPool, routingPreferences, routingCapabilities, routingPreferencesForHost, routingPriorityOptions, manualModelChoices: typeof manualModelChoices === 'function' ? manualModelChoices : undefined}`)(h, htm, value => [value, () => {}], () => {}, () => {}, {}, () => {}, ASSISTANT_PROVIDERS, assistantState, providerName, selectRoute)
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const children = value => flatten(value?.props?.children)
const nodes = value => value && typeof value === 'object' ? [value, ...children(value).flatMap(nodes)] : []
const text = value => children(value).map(child => typeof child === 'object' ? text(child) : child).join(' ').replace(/\s+/g, ' ').trim()
const option = (tree, id) => nodes(tree).find(node => node.type === 'option' && node.props.value === id)
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label)
const checkbox = tree => nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox')
const checkedAt = Date.now()
const catalog = normalizeCatalog({ provider: 'codex', checkedAt, source: { kind: 'provider-cli', label: 'Signed-in provider fixture' }, records: [{ id: 'model-fast', displayName: 'Provider fast model', description: 'Fast and efficient for simple tasks.', inputModalities: ['text', 'image'], supportedReasoningEfforts: ['low', 'high'], isDefault: true }] })
const status = { provider: 'codex', model: 'model-fast', mode: 'manual', effort: 'low', catalogBound: true, configured: true, routingSupported: true, enabledModels: [], providers: [{ id: 'codex', installed: true, authenticated: true, adapterSupported: true, modelSelectionSupported: true, available: true, canLogin: true }], catalogs: [catalog] }
const customCatalog = normalizeCatalog({ provider: 'custom', checkedAt, source: { kind: 'verified-custom-adapter', label: 'Verified adapter fixture' }, records: [{ id: 'custom-model', displayName: 'Provider custom model', description: 'Balanced workhorse.', inputModalities: ['text', 'image'] }] })
const customProvider = { id: 'custom', adapterManaged: true, adapterSupported: true, modelSelectionSupported: true, available: true, billingMode: 'unknown', authenticated: null }

const assistantActivity = new Function(`${source('web/ui/assistant-activity.js')}\nreturn assistantActivity`)()

function settings(initial, api = async () => initial) {
  const state = { caps: { host: 'browser' }, assistantStatus: initial }, values = [], refs = []
  let stateIndex = 0, refIndex = 0
  const useState = value => {
    const index = stateIndex++
    if (!(index in values)) values[index] = value
    return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next }]
  }
  const useRef = value => refs[refIndex++] ??= { current: value }
  const render = new Function('h', 'htm', 'useEffect', 'useRef', 'useState', 'useStore', 'api', 'set', 'store', 'toast', 'ASSISTANT_PROVIDERS', 'assistantState', 'providerName', 'safeInstallURL', 'LayoutMenu', 'registry', 'ModelPool', 'autoModelPool', 'assistantActivity', 'routingPreferences', 'routingCapabilities', 'routingPreferencesForHost', 'routingPriorityOptions', 'manualModelChoices', `const host = { kind: 'http' };\n${source('web/ui/settings.js')}\nreturn Settings()`)
  return { state, render() {
    stateIndex = 0; refIndex = 0
    return render(h, htm, () => {}, useRef, useState, () => state, api, next => Object.assign(state, next), state, () => {}, ASSISTANT_PROVIDERS, assistantState, providerName, safeInstallURL, () => null, { settings: [] }, components.ModelPool, components.autoModelPool, assistantActivity, components.routingPreferences, components.routingCapabilities, components.routingPreferencesForHost, components.routingPriorityOptions, components.manualModelChoices)
  } }
}

test('Settings and composer retain exact saved hidden, unavailable and removed model IDs', () => {
  const catalogs = [
    { ...catalog, models: catalog.models.map(model => ({ ...model, hidden: true })) },
    { ...catalog, models: catalog.models.map(model => ({ ...model, available: false })) },
    { ...catalog, models: [] },
  ]
  for (const unavailable of catalogs) for (const tree of [settings({ ...status, catalogs: [unavailable] }).render(), components.AssistantControls({ status: { ...status, catalogs: [unavailable] } })]) {
    const saved = option(tree, 'model-fast')
    assert.ok(saved, 'The select must display the saved exact ID even when its catalog row is filtered.')
    assert.equal(saved.props.disabled, true)
    assert.match(text(tree), /saved choice is preserved/i)
    assert.ok(nodes(tree).some(node => node.type === 'select' && node.props.value === 'model-fast'))
    assert.ok(nodes(tree).some(node => node.type === 'select' && node.props.value === 'low'), 'Saved effort remains reachable so it can be cleared.')
  }
})

test('expired, future and retired Manual choices stay visible but reject new catalog selections', async () => {
  const invalid = [
    { ...catalog, checkedAt: checkedAt - 301000 },
    { ...catalog, checkedAt: checkedAt + 301000 },
    { ...catalog, models: catalog.models.map(model => ({ ...model, retirementAt: checkedAt - 1 })) },
  ]
  for (const unavailable of invalid) {
    let requests = 0
    const form = settings({ ...status, catalogs: [unavailable] }, async () => { requests++; return status })
    const tree = form.render(), saved = option(tree, 'model-fast')
    assert.equal(saved.props.disabled, true)
    const select = nodes(tree).find(node => node.type === 'select' && node.props.value === 'model-fast')
    await select.props.onChange({ target: { value: 'model-fast' } })
    assert.equal(button(form.render(), 'Save and close'), undefined, 'A blocked callback must not edit the form.')
    assert.equal(requests, 0)
    assert.equal(option(components.AssistantControls({ status: { ...status, catalogs: [unavailable] } }), 'model-fast').props.disabled, true)
  }
})

test('choosing a current Manual catalog row saves its exact binding and preserves the Auto pool', async () => {
  const requests = [], pool = [{ provider: 'codex', model: 'saved-other-model' }]
  const form = settings({ ...status, model: '', effort: 'high', enabledModels: pool }, async (route, body) => { requests.push({ route, body }); return status })
  const tree = form.render(), select = nodes(tree).find(node => node.type === 'select' && option(node, 'model-fast'))
  assert.match(text(option(tree, 'model-fast')), /model-fast/)
  select.props.onChange({ target: { value: 'model-fast' } })
  await button(form.render(), 'Save and close').props.onClick()
  assert.deepEqual(requests.map(request => request.route), ['/api/assistant/config', '/api/assistant/status'])
  assert.equal(requests[0].body.model, 'model-fast'); assert.equal(requests[0].body.catalogBound, true)
  assert.equal(requests[0].body.effort, ''); assert.deepEqual(requests[0].body.enabledModels, pool)
})

test('a deliberate advanced model ID remains unverified and is never replaced by a catalog default', async () => {
  let saved
  const form = settings(status, async (route, body) => { if (route.endsWith('/config')) saved = body; return status })
  const input = nodes(form.render()).find(node => node.type === 'input' && node.props.placeholder === 'Provider default')
  input.props.onInput({ target: { value: 'advanced-exact-id' } })
  const tree = form.render()
  assert.ok(option(tree, 'advanced-exact-id')); assert.match(text(tree), /saved choice is preserved/i)
  await button(tree, 'Save and close').props.onClick()
  assert.equal(saved.model, 'advanced-exact-id'); assert.equal(saved.catalogBound, false); assert.equal(saved.effort, '')
})

test('Auto pool distinguishes user credit opt-in from host support and reports unknown adapter billing', () => {
  const credits = { ...catalog, models: catalog.models.map(model => ({ ...model, additionalSpend: true })) }
  const blocked = components.ModelPool({ status: { ...status, catalogs: [credits] }, value: [], onChange: () => {} })
  assert.equal(checkbox(blocked).props.disabled, true)
  assert.match(text(blocked), /requires additional usage credits/)
  const allowed = components.ModelPool({ status: { ...status, catalogs: [credits] }, preferences: { allowAdditionalSpend: true }, value: [], onChange: () => {} })
  assert.equal(checkbox(allowed).props.disabled, false)
  for (const billingMode of ['unknown', 'api', 'subscription']) {
    const current = { ...status, catalogs: [customCatalog], providers: [{ ...customProvider, billingMode }] }
    const pool = components.ModelPool({ status: current, value: [], onChange: () => {} })
    assert.equal(checkbox(pool).props.disabled, true)
    assert.match(text(pool), /authentication or editing adapter is unavailable/)
    if (billingMode === 'unknown') assert.match(text(pool), /Billing for this adapter is unverified/)
    if (billingMode === 'api') assert.match(text(pool), /adapter reports API billing/)
    const optedIn = components.ModelPool({ status: current, preferences: { allowAPIBilling: true }, value: [], onChange: () => {} })
    assert.equal(checkbox(optedIn).props.disabled, true, 'Billing opt-in does not authenticate or register a custom adapter.')
    assert.match(text(optedIn), /exact price and remaining allowance are unknown/)
  }
})

test('Settings draft billing opt-ins immediately change Auto eligibility before saving', () => {
  const credits = { ...catalog, models: catalog.models.map(model => ({ ...model, additionalSpend: true })) }
  const form = settings({ ...status, mode: 'auto', catalogs: [credits] })
  const pool = () => {
    const node = nodes(form.render()).find(node => node.type === components.ModelPool)
    return components.ModelPool(node.props)
  }
  assert.equal(checkbox(pool()).props.disabled, true)
  for (const toggle of nodes(form.render()).filter(node => node.type === 'input' && node.props.type === 'checkbox')) toggle.props.onChange({ target: { checked: true } })
  assert.equal(checkbox(pool()).props.disabled, false)
  assert.equal(form.state.assistantStatus.allowAdditionalSpend, undefined, 'Draft choices have not changed the saved host status.')
})

test('Settings draft provider and named-agent choices determine the shown Auto pool', () => {
  const form = settings({ ...status, provider: 'claude-code', mode: 'auto', agent: 'saved-claude-agent' })
  const pool = () => components.ModelPool(nodes(form.render()).find(node => node.type === components.ModelPool).props)
  assert.equal(checkbox(pool()).props.disabled, true)
  const provider = nodes(form.render()).find(node => node.type === 'select' && option(node, 'claude-code'))
  provider.props.onChange({ target: { value: 'codex' } })
  assert.equal(checkbox(pool()).props.disabled, false, 'Switching provider clears the draft named agent.')
  provider.props.onChange({ target: { value: 'claude-code' } })
  const agent = nodes(form.render()).filter(node => node.type === 'input' && node.props.placeholder === 'Provider default')[1]
  agent.props.onInput({ target: { value: 'new-claude-agent' } })
  assert.equal(checkbox(pool()).props.disabled, true, 'The draft named agent restricts Auto to Claude Code.')
})

test('incomplete advanced model text does not crash Auto setup and malformed draft agent choices stay blocked', () => {
  const form = settings({ ...status, mode: 'auto' })
  const input = nodes(form.render()).find(node => node.type === 'input' && node.props.placeholder === 'Provider default')
  input.props.onInput({ target: { value: '--unfinished model text' } })
  const pool = components.ModelPool(nodes(form.render()).find(node => node.type === components.ModelPool).props)
  assert.equal(checkbox(pool).props.disabled, false, 'Manual-only draft fields cannot invalidate Auto pool rendering.')
  const invalidAgent = components.ModelPool({ status: { ...status, provider: 'claude-code' }, preferences: { agent: '-invalid-agent' }, value: [], onChange: () => {} })
  assert.equal(checkbox(invalidAgent).props.disabled, true)
  assert.match(text(invalidAgent), /Named agents are supported only by Claude Code/)
})

test('Auto eligibility projects throttles, named-agent restrictions and unverified catalogs from routing policy', () => {
  const cases = [
    { ...status, providers: status.providers.map(provider => ({ ...provider, rateLimited: true, reason: 'Account limit reached.' })) },
    { ...status, provider: 'claude-code', agent: 'my-claude-agent' },
    { ...status, catalogs: [{ ...catalog, complete: false }] },
    { ...status, catalogs: [{ ...catalog, source: { kind: 'unverified' } }] },
  ]
  for (const current of cases) {
    const pool = components.ModelPool({ status: current, value: [], onChange: () => {} })
    assert.equal(checkbox(pool).props.disabled, true)
    assert.equal(button(pool, 'Enable available models').props.disabled, true)
    const route = selectRoute({ preferences: { ...components.routingPreferencesForHost(current), mode: 'auto', enabledModels: [{ provider: 'codex', model: 'model-fast' }] }, catalogs: current.catalogs, providers: current.providers, request: { requiresImage: true } })
    assert.ok(text(pool).includes(route.blocked[0].reason))
  }
})

test('Auto callbacks reject a catalog that becomes stale after render and keep saved blocked choices removable', t => {
  const changes = [], before = components.ModelPool({ status, value: [], onChange: value => changes.push(value) })
  assert.equal(checkbox(before).props.disabled, false)
  t.mock.method(Date, 'now', () => checkedAt + 301000)
  checkbox(before).props.onChange({ target: { checked: true } })
  button(before, 'Enable available models').props.onClick()
  assert.deepEqual(changes, [])
  const saved = components.ModelPool({ status, value: [{ provider: 'codex', model: 'model-fast' }], onChange: value => changes.push(value) })
  assert.equal(checkbox(saved).props.disabled, false)
  checkbox(saved).props.onChange({ target: { checked: false } })
  assert.deepEqual(changes, [[]])
})

test('Auto individual selection respects the pool cap and disabled callbacks cannot mutate preferences', () => {
  const saved = Array.from({ length: 256 }, (_, index) => ({ provider: 'codex', model: `saved-${index}` }))
  let changed = false
  const capped = components.ModelPool({ status, value: saved, onChange: () => { changed = true } })
  assert.equal(checkbox(capped).props.disabled, true)
  checkbox(capped).props.onChange({ target: { checked: true } })
  assert.equal(changed, false)
  const locked = components.ModelPool({ status, value: [...saved.slice(0, 1), { provider: 'codex', model: 'model-fast' }], disabled: true, onChange: () => { changed = true } })
  checkbox(locked).props.onChange({ target: { checked: false } })
  button(locked, 'Clear pool').props.onClick(); button(locked, 'Remove').props.onClick()
  assert.equal(changed, false)
})

test('first-use steps distinguish signed-in accounts, explicit selection, Auto and unknown configured-adapter authentication', () => {
  const form = settings({ ...status, provider: 'claude-code', configured: false, usage: { summary: 'Claude-specific allowance fixture' } })
  const provider = nodes(form.render()).find(node => node.type === 'select' && option(node, 'claude-code'))
  provider.props.onChange({ target: { value: 'codex' } })
  const tree = form.render(), third = nodes(tree).filter(node => node.type === 'li')[2]
  assert.equal(third.props.class, 'current'); assert.match(text(third), /Use Codex/)
  assert.ok(button(tree, 'Use Codex')); assert.equal(text(tree).includes('Claude-specific allowance fixture'), false)
  const auto = settings({ ...status, mode: 'auto' }).render()
  assert.match(text(auto), /Auto is selected/); assert.equal(nodes(auto).filter(node => node.type === 'li')[2].props.class, 'current')
  const custom = settings({ ...status, provider: 'custom', catalogs: [customCatalog], providers: [customProvider] }).render()
  assert.match(text(custom), /Authentication is unknown/); assert.equal(nodes(custom).filter(node => node.type === 'li')[1].props.class, 'current'); assert.equal(text(custom).includes('Account sign-in confirmed by the CLI'), false)
})

test('pending Settings saves disable advanced and spending controls and exclude disabled inputs from the focus trap', async () => {
  let release
  const form = settings({ ...status, mode: 'auto' }, async route => route.endsWith('/config') ? new Promise(resolve => { release = resolve }) : status)
  const preference = nodes(form.render()).find(node => node.type === 'select' && option(node, 'quick'))
  preference.props.onChange({ target: { value: 'quick' } })
  const saving = button(form.render(), 'Save and close').props.onClick()
  const busy = form.render()
  assert.ok(nodes(busy).filter(node => node.type === 'input').every(node => node.props.disabled === true))
  assert.ok(nodes(busy).filter(node => node.type === 'select').every(node => node.props.disabled === true))
  const dialog = nodes(busy).find(node => node.props?.role === 'dialog')
  let selector, focused = '', prevented = false
  const first = { focus: () => { focused = 'first' }, getClientRects: () => [1] }, last = { focus: () => { focused = 'last' }, getClientRects: () => [1] }
  dialog.ref.current = { querySelectorAll: value => { selector = value; return [first, last] } }
  const previousDocument = globalThis.document
  globalThis.document = { activeElement: null }
  try {
    dialog.props.onKeyDown({ key: 'Tab', shiftKey: false, stopPropagation() {}, preventDefault() { prevented = true } })
    assert.match(selector, /input:not\(:disabled\)/); assert.match(selector, /select:not\(:disabled\)/)
    assert.equal(focused, ''); assert.equal(prevented, false)
    globalThis.document.activeElement = first
    dialog.props.onKeyDown({ key: 'Tab', shiftKey: true, stopPropagation() {}, preventDefault() { prevented = true } })
    assert.equal(focused, 'last'); assert.equal(prevented, true)
    globalThis.document.activeElement = last
    dialog.props.onKeyDown({ key: 'Tab', shiftKey: false, stopPropagation() {}, preventDefault() {} })
    assert.equal(focused, 'first')
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
    release({}); await saving
  }
})


test('not-ready provider controls retain choices without repeating unavailable route previews', () => {
  for (const mode of ['auto', 'manual']) {
    const current = { ...status, configured: false, mode, model: 'missing', enabledModels: [] }
    const tree = components.AssistantControls({ status: current })
    assert.equal(nodes(tree).some(node => node.props?.class === 'assistant-route-preview'), false)
    assert.ok(nodes(tree).some(node => node.type === 'select'))
    assert.ok(button(tree, 'Accounts'))
  }
})

test('ready Auto still shows its actual bounded routing preview', () => {
  const current = { ...status, mode: 'auto', enabledModels: [{ provider: 'codex', model: 'model-fast' }] }
  const tree = components.AssistantControls({ status: current })
  const preview = nodes(tree).find(node => node.props?.class === 'assistant-route-preview')
  assert.ok(preview)
  assert.match(text(preview), /Likely choice: Provider fast model/)
  assert.match(text(preview), /Catalog presence does not prove access/)
})
