import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const editor = process.env.ARYA_SETTINGS_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const dependencyRoot = process.env.ARYA_SETTINGS_DEPENDENCY_ROOT ?? editor
const require = createRequire(path.join(dependencyRoot, 'package.json'))
const { h } = require('preact'), htm = require('htm')
const policy = await import(pathToFileURL(path.join(editor, 'core/assistant-routing.mjs')))
const stateModule = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-state.js')))
const readComponent = name => fs.readFileSync(path.join(editor, 'web/ui', name), 'utf8').replace(/^import .*$/gm, '').replace(/^export \{.*$/gm, '').replace(/^export /gm, '')
const statusPath = path.join(editor, 'web/ui/assistant-status.js')
const statusSource = fs.existsSync(statusPath) ? readComponent('assistant-status.js') : ''
const controls = new Function('h', 'htm', 'useState', 'api', 'set', 'toast', 'ASSISTANT_PROVIDERS', 'assistantState', 'providerName', 'selectRoute', `${readComponent('provider-controls.js')}\nreturn { ModelPool, autoModelPool, routingPreferences, routingCapabilities, routingPreferencesForHost, routingPriorityOptions, manualModelChoices }`)(h, htm, value => [value, () => {}], () => assert.fail('Unexpected account request.'), () => {}, () => {}, stateModule.ASSISTANT_PROVIDERS, stateModule.assistantState, stateModule.providerName, policy.selectRoute)
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const children = value => flatten(value?.props?.children)
const nodes = value => value && typeof value === 'object' ? [value, ...children(value).flatMap(nodes)] : []
const text = value => children(value).map(child => typeof child === 'object' ? text(child) : child).join(' ').replace(/\s+/g, ' ').trim()
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

// Real component bodies and HTM/Preact nodes execute with inert hooks and requests.
// The document object below only records focus; it has no browser or DOM access.
const assistantActivity = new Function(`${readComponent('assistant-activity.js')}\nreturn assistantActivity`)()

function settingsFixture(initialStatus, respond, host = 'browser') {
  const state = { caps: { host }, assistantStatus: initialStatus, assistantStatusError: '', settingsOpen: true }
  const values = [], refs = [], effects = [], pending = [], requests = [], publications = []
  let stateIndex = 0, refIndex = 0, effectIndex = 0, revision = 0, tree, unmounted = false, localWrites = 0
  const useState = initial => {
    const index = stateIndex++
    if (!(index in values)) values[index] = initial
    return [values[index], next => {
      const value = typeof next === 'function' ? next(values[index]) : next
      if (values[index] !== value) { values[index] = value; revision++; localWrites++ }
    }]
  }
  const useRef = initial => refs[refIndex++] ??= { current: initial }
  const useEffect = (callback, dependencies) => {
    const index = effectIndex++, previous = effects[index]
    if (!previous || dependencies.some((value, position) => value !== previous.dependencies[position])) {
      effects[index] = { callback, dependencies, cleanup: previous?.cleanup }
      pending.push(index)
    }
  }
  const api = (route, body) => {
    const request = { route, body: body === undefined ? undefined : structuredClone(body) }
    requests.push(request)
    return respond(route, body, requests.length)
  }
  const set = patch => { Object.assign(state, patch); publications.push(patch); revision++ }
  const focus = [], document = { activeElement: { focus: () => focus.push('restore') } }
  const factory = new Function('h', 'htm', 'useEffect', 'useRef', 'useState', 'useStore', 'api', 'set', 'store', 'toast', 'ASSISTANT_PROVIDERS', 'assistantState', 'providerName', 'safeInstallURL', 'LayoutMenu', 'registry', 'ModelPool', 'autoModelPool', 'assistantActivity', 'routingPreferences', 'routingCapabilities', 'routingPreferencesForHost', 'routingPriorityOptions', 'manualModelChoices', 'withdrawAssistantSharing', 'document', `const host = { kind: "http" };\n${statusSource}\n${readComponent('settings.js')}\nreturn { Settings, refreshAssistantStatus }`)
  const module = factory(h, htm, useEffect, useRef, useState, () => state, api, set, state, () => {}, stateModule.ASSISTANT_PROVIDERS, stateModule.assistantState, stateModule.providerName, stateModule.safeInstallURL, () => null, { settings: [] }, controls.ModelPool, controls.autoModelPool, assistantActivity, controls.routingPreferences, controls.routingCapabilities, controls.routingPreferencesForHost, controls.routingPriorityOptions, controls.manualModelChoices, () => assert.fail('Sharing withdrawal is outside this fixture.'), document)
  const Composer = new Function('h', 'htm', 'useState', 'api', 'set', 'store', 'toast', 'ASSISTANT_PROVIDERS', 'assistantState', 'providerName', 'selectRoute', 'refreshAssistantStatus', `${readComponent('provider-controls.js')}\nreturn AssistantControls`)(h, htm, value => [value, () => {}], api, set, state, () => {}, stateModule.ASSISTANT_PROVIDERS, stateModule.assistantState, stateModule.providerName, policy.selectRoute, module.refreshAssistantStatus)
  const render = () => {
    assert.equal(unmounted, false, 'No render after unmount.')
    stateIndex = 0; refIndex = 0; effectIndex = 0
    tree = module.Settings()
    nodes(tree).find(node => node.type === 'section').ref.current = { querySelector: () => ({ focus: () => focus.push('dialog') }) }
    return tree
  }
  const flush = async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      await Promise.resolve()
      if (unmounted) continue
      const before = revision
      render()
      for (const index of pending.splice(0)) {
        const effect = effects[index]
        effect.cleanup?.()
        effect.cleanup = effect.callback()
      }
      await Promise.resolve()
      if (before === revision && pending.length === 0 && attempt >= 3) return
    }
  }
  const select = options => nodes(tree).find(node => node.type === 'select' && options.every(value => nodes(node).some(item => item.type === 'option' && item.props.value === value)))
  const button = label => nodes(tree).find(node => node.type === 'button' && text(node) === label)
  const provider = () => select(['claude-code', 'codex'])
  const mode = () => select(['manual', 'auto'])
  const priority = () => select(['balanced'])
  const pool = () => nodes(tree).find(node => node.type === controls.ModelPool)
  const unmount = () => { unmounted = true; pending.length = 0; for (const effect of effects) effect.cleanup?.() }
  return { state, requests, publications, render, flush, provider, mode, priority, pool, button, module, unmount, focus, composer: () => Composer({ status: state.assistantStatus }), get tree() { return tree }, get localWrites() { return localWrites } }
}

function savedStatus(overrides = {}) {
  const checkedAt = Date.now()
  const catalogs = [policy.normalizeCatalog({ provider: 'codex', checkedAt, source: { kind: 'provider-cli', label: 'Injected account catalog' }, records: [{ id: 'exact', inputModalities: ['text', 'image'], isDefault: true }] })]
  return { provider: 'codex', model: 'exact', agent: '', effort: '', catalogBound: true, configured: true, routingSupported: true, mode: 'auto', priority: 'quality', allowAPIBilling: true, allowAdditionalSpend: true,
    enabledModels: [{ provider: 'codex', model: 'exact' }, { provider: 'codex', model: 'saved-missing' }], catalogs,
    providers: [{ id: 'codex', installed: true, authenticated: true, available: true, canLogin: true, modelSelectionSupported: true }, { id: 'claude-code', installed: true, authenticated: true, available: true, canLogin: true }], ...overrides }
}

for (const host of ['browser', 'native']) test(`${host} first-use recovery restores the published provider, Auto pool and explicit opt-ins before saving`, async () => {
  const gate = deferred(), recovered = savedStatus(host === 'native' ? { priority: 'balanced', allowAdditionalSpend: false, allowAPIBilling: false, routingCapabilities: { priorities: ['balanced'], allowAdditionalSpend: false, allowAPIBilling: false, autoProviders: ['claude-code', 'codex'] } } : {})
  let statusReads = 0, written
  const fixture = settingsFixture(null, async (route, body) => {
    if (route === '/api/assistant/config') { written = body; return { ...recovered, ...body } }
    if (++statusReads === 1) return gate.promise
    return written ? { ...recovered, ...written } : recovered
  }, host)
  await fixture.flush()
  gate.reject(new Error('Companion offline.'))
  await fixture.flush()
  assert.equal(fixture.state.assistantStatus, null)
  assert.match(text(fixture.tree), /Companion offline/)
  await fixture.button('Refresh status').props.onClick()
  await fixture.flush()
  const recoveredDraft = { provider: fixture.provider().props.value, mode: fixture.mode().props.value, pool: fixture.pool()?.props.value }
  nodes(fixture.tree).find(node => node.type === 'input' && node.props.maxLength === '128').props.onInput({ target: { value: 'deliberate-model' } })
  await fixture.flush()
  await fixture.button('Save and close').props.onClick()
  await fixture.flush()
  assert.deepEqual({ provider: written.provider, mode: written.mode, pool: written.enabledModels, allowAdditionalSpend: written.allowAdditionalSpend, allowAPIBilling: written.allowAPIBilling },
    { provider: 'codex', mode: 'auto', pool: recovered.enabledModels, allowAdditionalSpend: recovered.allowAdditionalSpend, allowAPIBilling: recovered.allowAPIBilling }, 'Actual Settings config request must preserve the recovered saved preferences.')
  assert.equal(recoveredDraft.provider, 'codex'); assert.equal(recoveredDraft.mode, 'auto')
  assert.deepEqual(recoveredDraft.pool, recovered.enabledModels)
  assert.equal(written.model, 'deliberate-model')
  assert.equal(written.allowAdditionalSpend, recovered.allowAdditionalSpend)
  assert.equal(written.allowAPIBilling, recovered.allowAPIBilling)
  assert.equal(fixture.state.settingsOpen, false)
  assert.equal(fixture.requests.some(request => request.route.includes('login') || request.route.includes('sharing') || request.route.includes('bridge')), false)
})

test('a late initial response cannot replace the form after a newer Use provider save', async () => {
  const initial = savedStatus(), gate = deferred()
  let written, statusReads = 0
  const fixture = settingsFixture(initial, async (route, body) => {
    if (route === '/api/assistant/config') { written = body; return { ...initial, ...body } }
    if (++statusReads === 1) return gate.promise
    return { ...initial, ...written }
  })
  await fixture.flush()
  fixture.provider().props.onChange({ target: { value: 'claude-code' } })
  await fixture.flush()
  await fixture.button('Use Claude Code').props.onClick()
  await fixture.flush()
  assert.equal(fixture.state.assistantStatus.provider, 'claude-code')
  gate.resolve(initial)
  await fixture.flush()
  assert.equal(fixture.state.assistantStatus.provider, 'claude-code')
  assert.equal(fixture.provider().props.value, 'claude-code')
  assert.equal(fixture.mode().props.value, 'manual')
  assert.match(text(fixture.tree), /Assistant preferences saved/)
  assert.deepEqual(written.enabledModels, initial.enabledModels)
  assert.equal(written.allowAdditionalSpend, true); assert.equal(written.allowAPIBilling, true)
})

for (const outcome of ['newer-published', 'newer-pending', 'newer-failed']) test(`a superseded save confirmation keeps the draft open when the latest poll is ${outcome}`, async () => {
  const initial = savedStatus(), confirmation = deferred(), latest = deferred()
  let statusReads = 0, written
  const fixture = settingsFixture(initial, async (route, body) => {
    if (route === '/api/assistant/config') { written = body; return { ...initial, ...body } }
    statusReads++
    if (statusReads === 1) return initial
    if (statusReads === 2) return confirmation.promise
    if (statusReads > 3) return current
    return latest.promise
  })
  await fixture.flush()
  fixture.provider().props.onChange({ target: { value: 'claude-code' } })
  await fixture.flush()
  const save = fixture.button('Save and close').props.onClick()
  await fixture.flush()
  const poll = fixture.module.refreshAssistantStatus().catch(() => {})
  const current = savedStatus({ provider: 'codex', priority: 'quick', enabledModels: [{ provider: 'codex', model: 'newest' }], allowAdditionalSpend: false, allowAPIBilling: false })
  if (outcome === 'newer-published') latest.resolve(current)
  if (outcome === 'newer-failed') latest.reject(new Error('Latest check failed.'))
  await fixture.flush()
  confirmation.resolve({ ...initial, ...written })
  await save
  await fixture.flush()
  assert.equal(fixture.state.settingsOpen, true)
  assert.equal(fixture.provider().props.value, 'claude-code')
  if (outcome !== 'newer-failed') assert.deepEqual(fixture.pool().props.value, initial.enabledModels)
  else { assert.equal(fixture.state.assistantStatus, null); assert.match(text(fixture.tree), /Latest check failed/) }
  assert.match(text(fixture.tree), /Preferences were submitted/)
  assert.match(text(fixture.tree), /newer status check superseded the save confirmation/)
  assert.equal(fixture.button('Save and close')?.props.disabled, outcome === 'newer-failed')
  if (outcome === 'newer-pending') latest.resolve(current)
  await poll
  if (outcome === 'newer-failed') await fixture.module.refreshAssistantStatus()
  await fixture.flush()
  assert.equal(fixture.provider().props.value, 'claude-code', 'The original intentional draft remains owned by the user.')
  assert.deepEqual(fixture.pool().props.value, initial.enabledModels)
})

test('metadata recovery preserves intentional local provider, model, pool and opt-in edits', async () => {
  const initial = savedStatus(), gate = deferred()
  const fixture = settingsFixture(initial, () => gate.promise)
  await fixture.flush()
  fixture.provider().props.onChange({ target: { value: 'claude-code' } })
  await fixture.flush()
  nodes(fixture.tree).find(node => node.type === 'input' && node.props.maxLength === '128').props.onInput({ target: { value: 'deliberate-model' } })
  const intentionalPool = [{ provider: 'codex', model: 'my-saved-model' }]
  fixture.pool().props.onChange(intentionalPool)
  nodes(fixture.tree).filter(node => node.type === 'input' && node.props.type === 'checkbox').forEach(node => node.props.onChange({ target: { checked: false } }))
  await fixture.flush()
  gate.resolve(savedStatus({ provider: 'codex', enabledModels: [], model: 'server-model', allowAdditionalSpend: true, allowAPIBilling: true }))
  await fixture.flush()
  assert.equal(fixture.provider().props.value, 'claude-code')
  assert.equal(nodes(fixture.tree).find(node => node.type === 'input' && node.props.maxLength === '128').props.value, 'deliberate-model')
  assert.deepEqual(fixture.pool().props.value, intentionalPool)
  assert.ok(nodes(fixture.tree).filter(node => node.type === 'input' && node.props.type === 'checkbox').every(node => node.props.checked === false))
  assert.ok(fixture.button('Save and close'))
})

test('an accepted saved status hydrates trimmed model and keeps saved blocked Auto choices', async () => {
  const initial = savedStatus(), saved = savedStatus({ provider: 'claude-code', mode: 'manual', model: 'exact-trimmed', catalogBound: false })
  const fixture = settingsFixture(initial, async route => route === '/api/assistant/config' ? saved : fixture.requests.length === 1 ? initial : saved)
  await fixture.flush()
  fixture.provider().props.onChange({ target: { value: 'claude-code' } })
  await fixture.flush()
  nodes(fixture.tree).find(node => node.type === 'input' && node.props.maxLength === '128').props.onInput({ target: { value: ' exact-trimmed ' } })
  await fixture.flush()
  await fixture.button('Use Claude Code').props.onClick()
  await fixture.flush()
  assert.equal(fixture.provider().props.value, 'claude-code')
  assert.equal(nodes(fixture.tree).find(node => node.type === 'input' && node.props.maxLength === '128').props.value, 'exact-trimmed')
  assert.equal(fixture.mode().props.value, 'manual')
  assert.equal(fixture.button('Save and close'), undefined)
  assert.deepEqual(fixture.requests.find(request => request.route === '/api/assistant/config').body.enabledModels, initial.enabledModels)
})

for (const outcome of ['resolved', 'rejected']) test(`initial refresh ${outcome} after unmount performs no local form updates`, async () => {
  const gate = deferred(), fixture = settingsFixture(null, () => gate.promise)
  await fixture.flush()
  fixture.unmount()
  const before = fixture.localWrites
  if (outcome === 'resolved') gate.resolve(savedStatus())
  else gate.reject(new Error('Offline after close.'))
  await fixture.flush()
  assert.equal(fixture.localWrites, before)
  assert.deepEqual(fixture.focus, ['dialog', 'restore'])
})

test('save completion after unmount cannot close or reset a replacement Settings draft', async () => {
  const initial = savedStatus(), gate = deferred()
  const fixture = settingsFixture(initial, async route => route === '/api/assistant/config' ? gate.promise : initial)
  await fixture.flush()
  fixture.provider().props.onChange({ target: { value: 'claude-code' } })
  await fixture.flush()
  const save = fixture.button('Save and close').props.onClick()
  await fixture.flush()
  fixture.unmount()
  const before = fixture.localWrites
  gate.resolve(initial)
  await save
  assert.equal(fixture.localWrites, before)
  assert.equal(fixture.state.settingsOpen, true)
})

test('pristine refresh replaces only the draft and does not start login, grant or dispatch', async () => {
  const initial = savedStatus({ mode: 'manual' }), refreshed = savedStatus({ provider: 'claude-code', mode: 'auto', priority: 'quick', model: '', catalogBound: false, allowAdditionalSpend: false, allowAPIBilling: true })
  let reads = 0
  const fixture = settingsFixture(initial, async () => ++reads === 1 ? initial : refreshed)
  await fixture.flush()
  await fixture.button('Refresh status').props.onClick()
  await fixture.flush()
  assert.equal(fixture.provider().props.value, 'claude-code')
  assert.equal(fixture.mode().props.value, 'auto')
  assert.equal(fixture.priority().props.value, 'quick')
  assert.deepEqual(fixture.pool().props.value, initial.enabledModels)
  assert.deepEqual(fixture.requests.map(request => request.route), ['/api/assistant/status', '/api/assistant/status?refresh=1'])
  assert.equal(fixture.button('Save and close'), undefined)
})

test('a latest status error after first-use recovery does not erase the recovered pool or opt-ins', async () => {
  const recovered = savedStatus(), initial = deferred()
  let reads = 0, written
  const fixture = settingsFixture(null, async (route, body) => {
    if (route === '/api/assistant/config') { written = body; return { ...recovered, ...body } }
    if (++reads === 1) return initial.promise
    if (reads === 3) throw new Error('Account check is offline again.')
    return written ? { ...recovered, ...written } : recovered
  })
  await fixture.flush()
  initial.reject(new Error('Initial account check failed.'))
  await fixture.flush()
  await fixture.button('Refresh status').props.onClick()
  await fixture.flush()
  await fixture.button('Refresh status').props.onClick()
  await fixture.flush()
  assert.equal(fixture.state.assistantStatus, null)
  assert.match(text(fixture.tree), /Account check is offline again/)
  await fixture.button('Refresh status').props.onClick()
  await fixture.flush()
  fixture.provider().props.onChange({ target: { value: 'claude-code' } })
  await fixture.flush()
  await fixture.button('Save and close').props.onClick()
  await fixture.flush()
  assert.deepEqual(written.enabledModels, recovered.enabledModels)
  assert.equal(written.mode, 'auto'); assert.equal(written.provider, 'claude-code')
  assert.equal(written.allowAdditionalSpend, true); assert.equal(written.allowAPIBilling, true)
})

test('an older Settings poll cannot replace a completed composer provider switch', async () => {
  const initial = savedStatus({ mode: 'manual' }), gate = deferred()
  let reads = 0, written
  const fixture = settingsFixture(initial, async (route, body) => {
    if (route === '/api/assistant/config') { written = body; return { ...initial, ...body } }
    if (++reads === 1) return gate.promise
    return { ...initial, ...written }
  })
  await fixture.flush()
  const provider = nodes(fixture.composer()).find(node => node.type === 'select' && node.props.value === 'codex')
  await provider.props.onChange({ target: { value: 'claude-code' } })
  await fixture.flush()
  assert.equal(fixture.state.assistantStatus.provider, 'claude-code')
  gate.resolve(initial)
  await fixture.flush()
  assert.equal(fixture.state.assistantStatus.provider, 'claude-code')
  assert.equal(fixture.provider().props.value, 'claude-code')
  assert.deepEqual(written.enabledModels, initial.enabledModels)
  assert.equal(written.allowAPIBilling, true); assert.equal(written.allowAdditionalSpend, true)
})

test('an older composer response cannot replace a newer Settings refresh', async () => {
  const initial = savedStatus({ mode: 'manual' }), gate = deferred()
  const newest = savedStatus({ mode: 'manual', enabledModels: [{ provider: 'codex', model: 'newest' }], allowAPIBilling: false, allowAdditionalSpend: false })
  let reads = 0, written
  const fixture = settingsFixture(initial, async (route, body) => {
    if (route === '/api/assistant/config') { written = body; return { ...initial, ...body } }
    if (++reads === 1) return initial
    if (reads === 2) return gate.promise
    return newest
  })
  await fixture.flush()
  const provider = nodes(fixture.composer()).find(node => node.type === 'select' && node.props.value === 'codex')
  const switchProvider = provider.props.onChange({ target: { value: 'claude-code' } })
  await fixture.flush()
  await fixture.button('Refresh status').props.onClick()
  await fixture.flush()
  gate.resolve({ ...initial, ...written })
  await switchProvider
  await fixture.flush()
  assert.equal(fixture.state.assistantStatus, newest)
  assert.equal(fixture.provider().props.value, 'codex')
  assert.deepEqual(fixture.state.assistantStatus.enabledModels, newest.enabledModels)
})

test('closing with ✕ or Escape keeps an unsaved model draft until the user saves or discards it', async () => {
  const initial = savedStatus({ mode: 'manual' })
  let written
  const fixture = settingsFixture(initial, async (route, body) => {
    if (route === '/api/assistant/config') { written = body; return { ...initial, ...body } }
    return written ? { ...initial, ...written } : initial
  })
  await fixture.flush()
  fixture.button('✕').props.onClick()
  assert.equal(fixture.state.settingsOpen, false, 'Without a draft, ✕ closes at once.')
  fixture.state.settingsOpen = true
  nodes(fixture.tree).find(node => node.type === 'input' && node.props.maxLength === '128').props.onInput({ target: { value: 'draft-model' } })
  await fixture.flush()
  fixture.button('✕').props.onClick()
  await fixture.flush()
  assert.equal(fixture.state.settingsOpen, true, 'A draft is not dropped silently.')
  assert.match(text(nodes(fixture.tree).find(node => node.type === 'footer')), /You have unsaved changes\. Save them, or discard them to close\./)
  assert.ok(fixture.button('Discard changes')); assert.equal(fixture.button('Cancel'), undefined)
  nodes(fixture.tree).find(node => node.type === 'section').props.onKeyDown({ key: 'Escape', stopPropagation() {}, preventDefault() {} })
  await fixture.flush()
  assert.equal(fixture.state.settingsOpen, true, 'Escape follows the same rule as ✕.')
  assert.equal(fixture.requests.some(request => request.route === '/api/assistant/config'), false)
  await fixture.button('Save and close').props.onClick()
  await fixture.flush()
  assert.equal(written.model, 'draft-model')
  assert.equal(fixture.state.settingsOpen, false)
})

test('Discard changes closes and sends nothing', async () => {
  const initial = savedStatus({ mode: 'manual' })
  const fixture = settingsFixture(initial, async () => initial)
  await fixture.flush()
  nodes(fixture.tree).find(node => node.type === 'input' && node.props.maxLength === '128').props.onInput({ target: { value: 'draft-model' } })
  await fixture.flush()
  fixture.button('✕').props.onClick()
  await fixture.flush()
  fixture.button('Discard changes').props.onClick()
  assert.equal(fixture.state.settingsOpen, false)
  assert.equal(fixture.requests.some(request => request.route === '/api/assistant/config'), false)
})

test('one click switches to a provider that is signed in and ready', async () => {
  const initial = savedStatus({ mode: 'manual' })
  let written
  const fixture = settingsFixture(initial, async (route, body) => {
    if (route === '/api/assistant/config') { written = body; return { ...initial, ...body } }
    return written ? { ...initial, ...written } : initial
  })
  await fixture.flush()
  await fixture.button('Claude Code · Suggested').props.onClick()
  await fixture.flush()
  assert.equal(written.provider, 'claude-code'); assert.equal(written.mode, 'manual'); assert.equal(written.model, '')
  assert.equal(fixture.state.assistantStatus.provider, 'claude-code')
  assert.equal(fixture.button('Claude Code · Suggested').props['aria-pressed'], true)
  assert.ok(fixture.button('Assistant is on'))
  assert.equal(fixture.button('Save and close'), undefined, 'The switch is saved, so no draft remains.')
})

test('choosing a provider that is not signed in only previews it and explains the next step', async () => {
  const initial = savedStatus({ mode: 'manual', providers: [{ id: 'codex', installed: true, authenticated: true, available: true, canLogin: true, modelSelectionSupported: true }, { id: 'claude-code', installed: true, authenticated: false, available: false, canLogin: true }] })
  const fixture = settingsFixture(initial, async () => initial)
  await fixture.flush()
  await fixture.button('Claude Code · Suggested').props.onClick()
  await fixture.flush()
  assert.equal(fixture.requests.some(request => request.route === '/api/assistant/config'), false)
  assert.equal(fixture.provider().props.value, 'claude-code')
  assert.match(text(fixture.tree), /Sign-in needed/)
  assert.equal(fixture.button('Use Claude Code').props.disabled, true)
  assert.ok(fixture.button('Sign in to Claude Code'))
})
