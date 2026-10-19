import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { h } from 'preact'
import htm from 'htm'
import { createAssistantSharingGate, verifiedSharingReview, withdrawAssistantSharing } from '../web/ui/assistant-sharing.js'

const scope = () => ({ providers: ['codex'], models: [{ provider: 'codex', model: 'exact-model' }], companion: 'http://127.0.0.1:4900/', classes: ['prompt', 'project_context', 'project_content', 'tool_results', 'rendered_frames', 'reference_images', 'conversation_history'] })
const review = (approved = false) => { const value = scope(); return { version: 1, approved, required: !approved, scope: value, reviewID: 'fixture-review', sharing: approved ? { version: 1, approved: true, scope: value } : null } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(api) {
  const presented = [], busy = [], calls = []
  const gate = createAssistantSharingGate({ api: async (...args) => { calls.push(args); return api(...args) }, present: value => presented.push(value), busy: value => busy.push(value) })
  return { gate, presented, busy, calls }
}

test('first-send review cannot authorize before an affirmative scoped grant', async () => {
  const value = review(), f = fixture(async (path, body) => path.endsWith('/grant') ? { ...value, approved: true, sharing: body.sharing } : value)
  const pending = f.gate.request()
  await tick()
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.presented, [value])
  assert.deepEqual(f.busy, [true, false])
  await f.gate.allow()
  const permit = await pending
  assert.equal(permit.valid(), true)
  assert.deepEqual(f.calls[1], ['/api/assistant/sharing/grant', { sharing: { version: 1, approved: true, scope: value.scope }, reviewID: value.reviewID }])
  assert.equal(f.presented.at(-1), null)
  f.gate.dispose()
})

test('Keep draft refuses without a grant or send', async () => {
  const f = fixture(async () => review()), pending = f.gate.request()
  await tick(); f.gate.cancel()
  assert.equal(await pending, null)
  assert.equal(f.calls.length, 1)
  assert.equal(f.busy.at(-1), false)
  f.gate.dispose()
})

test('Stop before review metadata returns prevents later authorization', async () => {
  let complete
  const f = fixture(() => new Promise(resolve => { complete = resolve })), pending = f.gate.request()
  await tick(); f.gate.cancel(); complete(review(true)); await tick()
  assert.equal(await pending, null)
  assert.deepEqual(f.presented, [null])
  assert.equal(f.calls.length, 1)
  f.gate.dispose()
})

test('withdrawal invalidates a pending grant before the revoke request and cannot resume it', async () => {
  let complete
  const value = review(), f = fixture(async path => path.endsWith('/grant') ? new Promise(resolve => { complete = resolve }) : value)
  const pending = f.gate.request(); await tick()
  const granting = f.gate.allow(); await tick()
  let cancelledBeforeRequest = false
  await withdrawAssistantSharing(async (path, body) => { assert.equal(path, '/api/assistant/sharing/revoke'); assert.deepEqual(body, {}); cancelledBeforeRequest = f.presented.at(-1) === null; return { version: 1, revoked: true, approved: false } })
  assert.equal(cancelledBeforeRequest, true)
  complete({ ...value, approved: true, sharing: { version: 1, approved: true, scope: value.scope } })
  await granting
  assert.equal(await pending, null)
  f.gate.dispose()
})

test('a permit expires when Stop happens before dispatch', async () => {
  const f = fixture(async () => review(true)), permit = await f.gate.request()
  assert.equal(permit.valid(), true)
  f.gate.cancel()
  assert.equal(permit.valid(), false)
  f.gate.dispose()
})

test('recipient expansion or grant failure rejects rather than authorizing the old review', async () => {
  for (const reject of [false, true]) {
    const f = fixture(async path => {
      if (!path.endsWith('/grant')) return review()
      if (reject) throw new Error('The sharing review expired.')
      const value = review(true); value.sharing.scope.models.push({ provider: 'codex', model: 'new-model' }); return value
    })
    const pending = f.gate.request(), denied = assert.rejects(pending, /expired|recipients changed/)
    await tick(); await f.gate.allow(); await denied
    assert.equal(f.presented.at(-1), null)
    f.gate.dispose()
  }
})

test('saved grants accept canonical facts with different JSON key order', async () => {
  const value = review(true)
  value.sharing.scope = { classes: [...value.scope.classes].reverse(), companion: value.scope.companion, models: value.scope.models, providers: value.scope.providers }
  const f = fixture(async () => value), permit = await f.gate.request()
  assert.equal(permit.valid(), true)
  assert.equal(f.calls.length, 1)
  f.gate.dispose()
})

test('unknown recipient, data category or credential-bearing destination cannot be approved', () => {
  for (const change of [value => { value.scope.providers = ['custom']; value.scope.models[0].provider = 'custom' }, value => { value.scope.models = [] },
    value => { value.scope.classes.push('new_unknown_data') }, value => { value.scope.classes.pop() },
    value => { value.scope.companion = 'https://secret@example.com/' }, value => { value.scope.companion = 'http://public.example/' },
    value => { delete value.reviewID }, value => { value.version = 2 }]) {
    const value = review(); change(value); assert.throws(() => verifiedSharingReview(value))
  }
})

const source = readFileSync(new URL('../web/ui/assistant-sharing.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replaceAll('export function ', 'function ').replaceAll('export async function ', 'async function ')
function renderReview(value, { busy = false } = {}) {
  const events = [], summary = { focus: () => events.push('summary'), getClientRects: () => [1] }, first = { focus: () => events.push('first'), getClientRects: () => [1] }, last = { focus: () => events.push('last'), getClientRects: () => [1] }
  const dialog = { querySelectorAll: () => [summary, first, last] }
  const component = new Function('h', 'htm', 'useEffect', 'useRef', `${source}\nreturn AssistantSharingReview`)(h, htm, () => {}, () => ({ current: dialog }))
  return { tree: component({ review: value, busy, onAllow: () => events.push('allow'), onDecline: () => events.push('decline'), onStop: () => events.push('stop') }), events, first, last, summary }
}
const children = node => [node?.props?.children].flat(Infinity).filter(value => value != null && value !== false)
const nodes = node => typeof node === 'object' && node ? [node, ...children(node).flatMap(nodes)] : []
const text = node => children(node).map(child => typeof child === 'object' ? text(child) : String(child)).join('')

test('actual review renders exact recipients, Auto pool, full context and affirmative/refusal controls', () => {
  const value = review(); value.scope.providers.push('claude-code'); value.scope.models.push({ provider: 'claude-code', model: 'other-exact-model' }); value.scope.companion = 'https://companion.example:8443/'
  const { tree, events } = renderReview(value), all = nodes(tree)
  assert.match(text(tree), /OpenAI.*Anthropic/)
  assert.match(text(tree), /exact-model.*other-exact-model/)
  assert.match(text(tree), /Remote companion operator.*https:\/\/companion.example:8443\//)
  assert.match(text(tree), /local paths.*transcripts.*Rendered frames.*Attached references.*Conversation history/)
  assert.match(text(tree), /cannot recall data already shared/)
  assert.equal(all.some(node => node.props?.dangerouslySetInnerHTML), false)
  const allow = all.find(node => node.type === 'button' && text(node) === 'Allow sharing and send')
  const decline = all.find(node => node.type === 'button' && text(node) === 'Keep draft')
  allow.props.onClick(); decline.props.onClick()
  assert.deepEqual(events, ['allow', 'decline'])
  assert.ok(all.find(node => node.props?.role === 'dialog' && node.props['aria-modal'] === 'true'))
})

test('review traps focus, Escape preserves draft, and pending approval exposes Stop', () => {
  const previous = globalThis.document
  try {
    for (const busy of [false, true]) {
      const rendered = renderReview(review(), { busy }), dialog = nodes(rendered.tree).find(node => node.props?.role === 'dialog')
      let prevented = 0
      const key = (name, shiftKey = false) => ({ key: name, shiftKey, stopPropagation() {}, preventDefault: () => prevented++ })
      globalThis.document = { activeElement: rendered.summary }
      dialog.props.onKeyDown(key('Tab', true)); assert.equal(rendered.events.at(-1), 'last')
      globalThis.document.activeElement = rendered.last
      dialog.props.onKeyDown(key('Tab')); assert.equal(rendered.events.at(-1), 'summary')
      dialog.props.onKeyDown(key('Escape')); assert.equal(rendered.events.at(-1), busy ? 'stop' : 'decline')
      assert.equal(prevented, 3)
      if (busy) {
        assert.ok(nodes(rendered.tree).find(node => node.type === 'button' && text(node) === 'Stop request' && !node.props.disabled))
        assert.equal(nodes(rendered.tree).find(node => node.type === 'button' && text(node) === 'Saving permission…').props.disabled, true)
      }
    }
  } finally { globalThis.document = previous }
})

test('direct Anthropic API is disclosed as a provider destination', () => {
  const value = review(); value.scope.providers = ['anthropic']; value.scope.models = [{ provider: 'anthropic', model: 'requested-model' }]; value.scope.companion = 'https://api.anthropic.com/'
  const { tree } = renderReview(value)
  assert.match(text(tree), /Provider destination.*directly to Anthropic/)
  assert.doesNotMatch(text(tree), /Remote companion operator/)
})

test('actual Settings withdrawal button calls the revocation endpoint and reports cancellation uncertainty', async () => {
  const { ASSISTANT_PROVIDERS, assistantState, providerName, safeInstallURL } = await import('../web/ui/assistant-state.js')
  const { selectRoute } = await import('../core/assistant-routing.mjs')
  const controlsSource = readFileSync(new URL('../web/ui/provider-controls.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const { autoModelPool, routingPreferences } = new Function('h', 'htm', 'ASSISTANT_PROVIDERS', 'providerName', 'selectRoute', `${controlsSource}\nreturn { autoModelPool, routingPreferences }`)(h, htm, ASSISTANT_PROVIDERS, providerName, selectRoute)
  const { assistantActivity } = await import('../web/ui/assistant-activity.js')
  const statusSource = readFileSync(new URL('../web/ui/assistant-status.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace('export async function refreshAssistantStatus', 'async function refreshAssistantStatus')
  const source = readFileSync(new URL('../web/ui/settings.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replaceAll('export async function ', 'async function ').replaceAll('export function ', 'function ').replace(/^export \{ refreshAssistantStatus \} from .*$/gm, '')
  for (const stopUnconfirmed of [false, true]) {
    const calls = [], notices = []
    const prefs = { provider: 'codex', mode: 'manual', model: '', agent: '', effort: '', enabledModels: [] }
    const state = { caps: {}, assistantStatus: { ...prefs, configured: true, providers: [{ id: 'codex', available: true, authenticated: true }] } }
    const render = new Function('h', 'htm', 'useEffect', 'useRef', 'useState', 'useStore', 'api', 'set', 'store', 'toast', 'ASSISTANT_PROVIDERS', 'assistantState', 'providerName', 'safeInstallURL', 'LayoutMenu', 'ModelPool', 'manualModelChoices', 'routingPreferencesForHost', 'routingCapabilities', 'routingPriorityOptions', 'registry', 'withdrawAssistantSharing', 'autoModelPool', 'routingPreferences', 'assistantActivity', 'refreshAssistantStatus', `const host = { kind: "http" };\n${source}\nreturn Settings()`)
    const request = async path => { calls.push(path); return path.endsWith('/revoke') ? { version: 1, revoked: true, approved: false, stopUnconfirmed } : state.assistantStatus }
    const refreshStatus = new Function('api', 'set', `${statusSource}\nreturn refreshAssistantStatus`)(request, () => {})
    let hook = 0
    const tree = render(h, htm, () => {}, value => ({ current: value }), value => { const index = hook++; return [value, update => { if (index === 7) notices.push(update) }] }, () => state,
      request, () => {}, state, () => {},
      ASSISTANT_PROVIDERS, assistantState, providerName, safeInstallURL, () => null, () => null, () => ({ choices: [], model: null }), () => prefs,
      () => ({ priorities: ['balanced'], allowAdditionalSpend: false, allowAPIBilling: false, autoProviders: ['codex'] }), () => [], { settings: [] }, withdrawAssistantSharing, autoModelPool, routingPreferences, assistantActivity, refreshStatus)
    const button = nodes(tree).find(node => node.type === 'button' && text(node) === 'Withdraw sharing permission')
    assert.ok(button); assert.equal(button.props.disabled, false)
    await button.props.onClick()
    assert.deepEqual(calls, ['/api/assistant/sharing/revoke', '/api/assistant/status'])
    assert.match(notices.at(-1), stopUnconfirmed ? /Stopping could not be confirmed/ : /Sharing permission withdrawn/)
  }
})


test('failed withdrawal acknowledgement blocks later local sends until confirmed retry', async () => {
  for (const result of [{}, { version: 1, revoked: false, approved: true }]) {
    const f = fixture(async () => review(true))
    await assert.rejects(withdrawAssistantSharing(async () => result), /could not be confirmed/)
    assert.throws(() => f.gate.request(), /Retry Withdraw sharing permission/)
    await withdrawAssistantSharing(async () => ({ version: 1, revoked: true, approved: false }))
    const permit = await f.gate.request(); assert.equal(permit.valid(), true)
    f.gate.dispose()
  }
})

test('strict contract rejects duplicate rows, extra fields, non-root paths and wrong saved envelope version', async () => {
  for (const change of [value => { value.scope.models.push({ ...value.scope.models[0] }) }, value => { value.scope.extra = true },
    value => { value.scope.companion = 'https://companion.example/private/' }, value => { value.sharing.version = 2 }]) {
    const value = review(true); change(value)
    const f = fixture(async () => value)
    await assert.rejects(f.gate.request())
    assert.equal(f.presented.at(-1), null)
    f.gate.dispose()
  }
})

function renderApp(state) {
  const source = readFileSync(new URL('../web/ui/app.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace('export async function mountApp', 'async function mountApp')
  const Settings = () => null, AssistantSharingReview = () => null
  const tree = new Function('h', 'htm', 'useEffect', 'useStore', 'useLayout', 'layoutStyle', 'Divider', 'ChatPanel', 'Settings', 'AssistantSharingReview', `const host = { kind: "http" };\n${source}\nreturn App()`)(h, htm, () => {}, () => state, () => ({}), () => ({}), () => null, () => null, Settings, AssistantSharingReview)
  return { tree, Settings, AssistantSharingReview }
}

test('async preflight cannot place consent behind Settings or the compact Chat stacking context', async () => {
  const state = { project: null, chatOpen: true, settingsOpen: true, showKeys: true, assistantSharingReviewOpen: true }
  let complete
  const gate = createAssistantSharingGate({ api: () => new Promise(resolve => { complete = resolve }), present: value => { state.assistantSharingReview = value; state.assistantSharingActions = { allow() {}, decline() {}, stop() {} } }, busy: value => { state.assistantSharingBusy = value } })
  const pending = gate.request(); await tick()
  const preflight = renderApp(state)
  assert.equal(nodes(preflight.tree).some(node => node.type === preflight.Settings), false)
  complete(review()); await tick()
  const rendered = renderApp(state), modal = children(rendered.tree).find(node => node.type === rendered.AssistantSharingReview)
  assert.ok(modal, 'consent is a direct child of the app modal layer')
  assert.equal(nodes(rendered.tree).some(node => node.type === rendered.Settings), false)
  assert.equal(nodes(rendered.tree).filter(node => node.type === rendered.AssistantSharingReview).length, 1)
  gate.cancel(); assert.equal(await pending, null); gate.dispose()
})


test('an older withdrawal success cannot clear a newer unconfirmed withdrawal', async () => {
  const f = fixture(async () => review(true))
  let confirmOlder, failNewer
  const older = withdrawAssistantSharing(() => new Promise(resolve => { confirmOlder = resolve }))
  const newer = withdrawAssistantSharing(() => new Promise(resolve => { failNewer = resolve }))
  const rejection = assert.rejects(newer, /could not be confirmed/)
  confirmOlder({ version: 1, revoked: true, approved: false }); await older
  assert.throws(() => f.gate.request(), /Retry Withdraw sharing permission/)
  failNewer({ version: 1, revoked: false, approved: true }); await rejection
  assert.throws(() => f.gate.request(), /Retry Withdraw sharing permission/)
  await withdrawAssistantSharing(async () => ({ version: 1, revoked: true, approved: false }))
  assert.equal((await f.gate.request()).valid(), true)
  f.gate.dispose()
})

test('an older failed withdrawal cannot undo a newer confirmed withdrawal', async () => {
  const f = fixture(async () => review(true))
  let failOlder, confirmNewer
  const older = withdrawAssistantSharing(() => new Promise(resolve => { failOlder = resolve }))
  const rejection = assert.rejects(older, /could not be confirmed/)
  const newer = withdrawAssistantSharing(() => new Promise(resolve => { confirmNewer = resolve }))
  confirmNewer({ version: 1, revoked: true, approved: false }); await newer
  assert.equal((await f.gate.request()).valid(), true)
  failOlder({}); await rejection
  assert.equal((await f.gate.request()).valid(), true)
  f.gate.dispose()
})


test('an actual native-style Auto review keeps deterministic ASCII model ordering in the grant', async () => {
  const value = review()
  value.scope.models = ['Alpha', 'a-b', 'a_b', 'alpha'].map(model => ({ provider: 'codex', model }))
  const nativeEnvelope = { version: 1, approved: true, scope: value.scope }
  let submitted
  const f = fixture(async (path, body) => {
    if (!path.endsWith('/grant')) return value
    submitted = body.sharing
    assert.deepEqual(submitted, nativeEnvelope, 'the embedded browser must submit the same native model-array order')
    return { ...value, approved: true, sharing: nativeEnvelope }
  })
  const pending = f.gate.request(); await tick(); await f.gate.allow()
  const permit = await pending
  assert.equal(permit.valid(), true)
  assert.deepEqual(submitted.scope.models.map(row => row.model), ['Alpha', 'a-b', 'a_b', 'alpha'])
  f.gate.dispose()
})
