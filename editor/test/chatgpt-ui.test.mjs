import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { h } from 'preact'
import htm from 'htm'
import { Icon } from '../web/ui/icons.js'
import * as script from '../web/ui/assistant-script.js'
import { assistantPanel } from '../web/ui/assistant-panel.js'
import { assistantActivity } from '../web/ui/assistant-activity.js'
import { createAssistantSharingGate } from '../web/ui/assistant-sharing.js'
import { ASSISTANT_PROVIDERS, assistantState, assistantPrompt, providerName, safeInstallURL } from '../web/ui/assistant-state.js'
import { selectRoute } from '../core/assistant-routing.mjs'

// The real Settings and assistant panel bodies render with inert hooks. Requests are recorded.
const strip = name => readFileSync(new URL(`../web/ui/${name}`, import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace(/^export \{.*$/gm, '').replace(/^export /gm, '')
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const children = node => flatten(node?.props?.children)
const nodes = node => node && typeof node === 'object' ? [node, ...children(node).flatMap(nodes)] : []
const text = node => children(node).map(child => typeof child === 'object' ? text(child) : child).join(' ').replace(/\s+/g, ' ').trim()
const all = tree => nodes(tree).map(node => text(node)).join(' ')
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label)
const link = (tree, label) => nodes(tree).find(node => node.type === 'a' && text(node) === label)

const controls = new Function('h', 'htm', 'useState', 'api', 'set', 'toast', 'ASSISTANT_PROVIDERS', 'assistantState', 'providerName', 'selectRoute', `${strip('provider-controls.js')}\nreturn { ModelPool, autoModelPool, routingPreferences, routingCapabilities, routingPreferencesForHost, routingPriorityOptions, manualModelChoices }`)(
  h, htm, value => [value, () => {}], () => assert.fail('Unexpected request.'), () => {}, () => {}, ASSISTANT_PROVIDERS, assistantState, providerName, selectRoute)
const statusSource = strip('assistant-status.js')
const statusModule = (api, set = () => {}) => new Function('api', 'set', `${statusSource}\nreturn { refreshAssistantStatus, followChatGPTSignIn, startChatGPTSignIn, chatgptAccountAction, chooseChatGPTAssistant }`)(api, set)

const usageURL = 'https://chatgpt.com/settings/usage'
const account = (changes = {}) => ({ supported: true, signedIn: false, planUsage: false, email: '', active: null, accounts: [], welcome: false, usageURL, attempt: { state: 'idle', message: '', startURL: null }, ...changes })
const signedIn = (changes = {}) => account({ signedIn: true, planUsage: true, email: 'sam@example.com', active: 'acct-0000000001', accounts: [{ id: 'acct-0000000001', email: 'sam@example.com', signedIn: true, planUsage: true, active: true }], ...changes })
const baseStatus = (changes = {}) => ({ provider: 'claude-code', mode: 'manual', model: '', agent: '', effort: '', priority: 'balanced', enabledModels: [{ provider: 'codex', model: 'kept-model' }], allowAdditionalSpend: false, allowAPIBilling: false, catalogBound: false,
  routingSupported: true, configured: false, catalogs: [], sharing: { approved: false },
  providers: [{ id: 'claude-code', installed: false, authenticated: false, available: false, reason: 'Install Claude Code.' }, { id: 'codex', installed: false, authenticated: false, available: false, reason: 'Install Codex.' }], ...changes })

function settings(status, extra = {}) {
  const state = { caps: { host: 'browser' }, assistantStatus: status, assistantStatusError: '', connected: true, claude: { state: 'idle' }, root: '/fixture', ...extra }
  const calls = [], notices = []
  const api = async (route, body) => {
    calls.push({ route, body })
    if (route === '/api/assistant/chatgpt/sign-in') return { started: true, opened: true, chatgpt: status.chatgpt }
    if (route === '/api/assistant/chatgpt/sign-out') return { signedOut: true, revocationConfirmed: false, chatgpt: account() }
    if (route.startsWith('/api/assistant/chatgpt/')) return { chatgpt: status.chatgpt }
    // Status polls report a finished sign-in so the follow loop ends.
    return { ...status, chatgpt: status.chatgpt && { ...status.chatgpt, attempt: { state: 'done', message: '', startURL: null } } }
  }
  const factory = new Function('h', 'htm', 'useEffect', 'useRef', 'useState', 'useStore', 'api', 'set', 'store', 'toast', 'ASSISTANT_PROVIDERS', 'assistantState', 'providerName', 'safeInstallURL', 'LayoutMenu', 'registry', 'ModelPool', 'autoModelPool', 'assistantActivity', 'routingPreferences', 'routingCapabilities', 'routingPreferencesForHost', 'routingPriorityOptions', 'manualModelChoices', 'withdrawAssistantSharing', 'document',
    `const host = { kind: "http" };\n${statusSource}\n${strip('settings.js')}\nreturn Settings`)
  let hook = 0
  const Settings = factory(h, htm, () => {}, value => ({ current: value }), value => { const index = hook++; return [value, update => { if (index === 7) notices.push(update) }] }, () => state,
    api, patch => Object.assign(state, patch), state, () => {}, ASSISTANT_PROVIDERS, assistantState, providerName, safeInstallURL, () => null, { settings: [] }, controls.ModelPool, controls.autoModelPool, assistantActivity,
    controls.routingPreferences, controls.routingCapabilities, controls.routingPreferencesForHost, controls.routingPriorityOptions, controls.manualModelChoices, async () => ({}), { activeElement: null })
  return { tree: Settings(), calls, notices, state }
}

const chatSource = readFileSync(new URL('../web/ui/chat.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace('export function ChatPanel', 'function ChatPanel')
const chatRender = new Function('Icon', 'h', 'htm', 'useEffect', 'useRef', 'useState', 'useStore',
  'assistantActivity', 'assistantState', 'assistantPrompt', 'providerName', 'useTime', 'refreshAssistantStatus', 'api',
  'set', 'store', 'time', 'toast', 'receiptSelection', 'player', 'AssistantControls', 'RoutingReceipt', 'AssistantSharingReview', 'createAssistantSharingGate', ...Object.keys(script), 'assistantPanel',
  'startChatGPTSignIn', 'chatgptAccountAction', 'chooseChatGPTAssistant', `${chatSource}\nreturn ChatPanel()`)
function panel(status, run = { state: 'idle' }) {
  const calls = []
  const state = { claude: run, connected: true, caps: {}, assistantStatus: status, root: '/fixture', assistantDraft: { root: '/fixture', text: '', inputKind: 'prompt' }, chat: [], activity: [], receipts: [], selection: [], refs: [], project: { comps: {} }, openComp: null }
  const tree = chatRender(Icon, h, htm, () => {}, value => ({ current: value }), value => [value, () => {}], () => state,
    assistantActivity, assistantState, assistantPrompt, providerName, () => 0, async () => status, async () => ({}), patch => Object.assign(state, patch), state, { t: 0 }, message => calls.push({ toast: message }), () => {}, {}, () => null, () => null, () => null, createAssistantSharingGate, ...Object.values(script), assistantPanel,
    async body => calls.push({ start: body }), async (action, body) => calls.push({ action, body }), async value => calls.push({ choose: value.provider }))
  return { tree, state, calls }
}

test('hosts without Sign in with ChatGPT show no ChatGPT option and honest app labels', () => {
  const { tree } = settings(baseStatus({ chatgpt: { supported: false } }))
  const shown = all(tree)
  assert.doesNotMatch(shown, /Continue with ChatGPT|Use your ChatGPT plan|Other ways to connect|Suggested/)
  assert.ok(button(tree, 'Claude Code · Claude account')); assert.ok(button(tree, 'Codex · ChatGPT account')); assert.ok(button(tree, 'Google Antigravity · Google account'))
  assert.match(shown, /Anthropic does not let other apps offer Claude sign-in without its approval/)
  assert.equal(nodes(tree).some(node => node.type === 'option' && node.props.value === 'chatgpt'), false)
  const chat = panel(baseStatus())
  assert.doesNotMatch(all(chat.tree), /ChatGPT/)
  assert.match(all(chat.tree), /Connect your editing assistant/)
})

test('signed out: Continue with ChatGPT is first and installed apps move under Other ways to connect', async () => {
  const status = baseStatus({ chatgpt: account() })
  const { tree, calls, notices } = settings(status)
  assert.match(all(tree), /Use your ChatGPT plan/)
  assert.match(all(tree), /Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance/)
  const disclosure = nodes(tree).find(node => node.type === 'details' && text(children(node).find(child => child.type === 'summary') ?? {}) === 'Other ways to connect')
  assert.ok(disclosure, 'The installed-app steps sit in a disclosure.')
  assert.equal(disclosure.props.open, false)
  assert.ok(nodes(disclosure).some(node => node.type === 'button' && text(node) === 'Claude Code · Claude account'))
  const order = nodes(tree).filter(node => node.type === 'button').map(node => text(node))
  assert.ok(order.indexOf('Continue with ChatGPT') < order.indexOf('Claude Code · Claude account'))
  await button(tree, 'Continue with ChatGPT').props.onClick()
  assert.deepEqual(calls.slice(0, 2).map(call => call.route), ['/api/assistant/chatgpt/sign-in', '/api/assistant/status'])
  assert.deepEqual(calls[0].body, {})
  assert.match(notices.at(-1), /Finish signing in on the ChatGPT page/)
  // A chosen app stays open for the people who use it.
  const configured = settings(baseStatus({ chatgpt: account(), configured: true, providers: [{ id: 'claude-code', installed: true, authenticated: true, available: true, reason: 'Signed in.' }] }))
  assert.equal(nodes(configured.tree).find(node => node.type === 'details' && text(children(node).find(child => child.type === 'summary') ?? {}) === 'Other ways to connect').props.open, true)
  // The panel's Other ways to connect opens that section expanded, and closing Settings resets it.
  const asked = settings(baseStatus({ chatgpt: account() }), { settingsOpen: true, settingsOtherWays: true })
  assert.equal(nodes(asked.tree).find(node => node.type === 'details' && text(children(node).find(child => child.type === 'summary') ?? {}) === 'Other ways to connect').props.open, true)
  nodes(asked.tree).find(node => node.type === 'button' && node.props['aria-label'] === 'Close settings').props.onClick()
  assert.equal(asked.state.settingsOpen, false); assert.equal(asked.state.settingsOtherWays, false)
})

test('waiting for the browser keeps Cancel and a sign-in link available', async () => {
  const startURL = 'http://127.0.0.1:49152/auth/start?attempt=fixture'
  const { tree, calls } = settings(baseStatus({ chatgpt: account({ attempt: { state: 'waiting', message: '', startURL } }) }))
  assert.match(all(tree), /Waiting for ChatGPT sign-in/)
  const open = link(tree, 'Open the sign-in page ↗')
  assert.equal(open.props.href, startURL); assert.equal(open.props.rel, 'noopener noreferrer')
  assert.equal(button(tree, 'Continue with ChatGPT'), undefined)
  const cancel = button(tree, 'Cancel sign-in')
  assert.equal(cancel.props.disabled, false)
  await cancel.props.onClick()
  assert.equal(calls[0].route, '/api/assistant/chatgpt/cancel')
  const failed = settings(baseStatus({ chatgpt: account({ attempt: { state: 'cancelled', message: 'ChatGPT sign-in was cancelled. Manual editing still works without an account.', startURL: null } }) }))
  assert.match(all(failed.tree), /Manual editing still works without an account/)
  assert.ok(button(failed.tree, 'Continue with ChatGPT'))
})

test('signed in: plan indicator, Manage usage, switch to ChatGPT, other account and sign-out', async () => {
  const { tree, calls, notices } = settings(baseStatus({ chatgpt: signedIn() }))
  assert.match(all(tree), /Using ChatGPT plan/); assert.match(all(tree), /Signed in as sam@example.com/)
  const usage = link(tree, 'Manage usage ↗')
  assert.equal(usage.props.href, usageURL); assert.equal(usage.props.target, '_blank'); assert.equal(usage.props.rel, 'noopener noreferrer')
  await button(tree, 'Use ChatGPT for the assistant').props.onClick()
  const saved = calls.find(call => call.route === '/api/assistant/config')
  assert.equal(saved.body.provider, 'chatgpt'); assert.equal(saved.body.mode, 'manual'); assert.equal(saved.body.agent, '')
  assert.deepEqual(saved.body.enabledModels, [{ provider: 'codex', model: 'kept-model' }])
  await button(tree, 'Use a different account').props.onClick()
  assert.deepEqual(calls.find(call => call.route === '/api/assistant/chatgpt/sign-in').body, { newAccount: true })
  await button(tree, 'Sign out').props.onClick()
  assert.deepEqual(calls.find(call => call.route === '/api/assistant/chatgpt/sign-out').body, { account: 'acct-0000000001' })
  assert.match(notices.at(-1), /OpenAI did not confirm the revocation/)
  // Already the assistant: no switch button.
  const chosen = settings(baseStatus({ provider: 'chatgpt', configured: true, chatgpt: signedIn() }))
  assert.equal(button(chosen.tree, 'Use ChatGPT for the assistant'), undefined)
  assert.match(all(chosen.tree), /ChatGPT is your assistant/)
})

test('plan usage off asks for consent again, and the first sign-in shows the welcome once', async () => {
  const off = settings(baseStatus({ chatgpt: signedIn({ planUsage: false, accounts: [{ id: 'acct-0000000001', email: 'sam@example.com', signedIn: true, planUsage: false, active: true }] }) }))
  assert.match(all(off.tree), /ChatGPT plan usage is off/)
  await button(off.tree, 'Turn on ChatGPT plan usage').props.onClick()
  assert.deepEqual(off.calls[0].body, { account: 'acct-0000000001', enablePlan: true })
  const welcome = settings(baseStatus({ chatgpt: signedIn({ welcome: true }) }))
  assert.match(all(welcome.tree), /You’re using your ChatGPT plan/)
  await button(welcome.tree, 'Got it').props.onClick()
  assert.equal(welcome.calls[0].route, '/api/assistant/chatgpt/welcome')
  const chat = panel(baseStatus({ chatgpt: signedIn({ welcome: true }) }))
  assert.match(all(chat.tree), /You’re using your ChatGPT plan/)
  await button(chat.tree, 'Got it').props.onClick()
  assert.deepEqual(chat.calls, [{ action: 'welcome', body: undefined }])
})

test('assistant panel: one-click ChatGPT setup, waiting state and Use ChatGPT', async () => {
  const out = panel(baseStatus({ chatgpt: account() }))
  const setup = nodes(out.tree).find(node => node.props?.class === 'assistant-setup')
  assert.match(text(setup), /Use your ChatGPT plan for eligible requests/)
  const start = button(out.tree, 'Continue with ChatGPT')
  assert.equal(start.props.class, 'primary')
  button(out.tree, 'Other ways to connect').props.onClick()
  assert.equal(out.state.settingsOpen, true); assert.equal(out.state.settingsOtherWays, true)
  await start.props.onClick()
  assert.deepEqual(out.calls, [{ start: {} }])
  const waiting = panel(baseStatus({ chatgpt: account({ attempt: { state: 'waiting', message: '', startURL: 'http://127.0.0.1:49152/auth/start?attempt=fixture' } }) }))
  assert.match(all(waiting.tree), /Waiting for ChatGPT sign-in/)
  await button(waiting.tree, 'Cancel sign-in').props.onClick()
  assert.deepEqual(waiting.calls, [{ action: 'cancel', body: undefined }])
  const other = panel(baseStatus({ chatgpt: signedIn() }))
  await button(other.tree, 'Use ChatGPT').props.onClick()
  assert.deepEqual(other.calls, [{ choose: 'claude-code' }])
})

test('assistant panel: plan indicator when ready, and usage limit makes Manage usage the main action', () => {
  const ready = { ...baseStatus({ provider: 'chatgpt', configured: true, chatgpt: signedIn() }), providers: [{ id: 'chatgpt', installed: true, authenticated: true, available: true, reason: 'Uses your ChatGPT plan.' }] }
  const out = panel(ready)
  assert.equal(nodes(out.tree).some(node => node.props?.class === 'assistant-setup'), false)
  const note = nodes(out.tree).find(node => node.props?.class === 'assistant-plan-note')
  assert.match(text(note), /Using ChatGPT plan/)
  assert.equal(link(out.tree, 'Manage usage ↗').props.href, usageURL)
  const limited = panel(ready, { state: 'error', text: 'You reached the ChatGPT plan usage limit for Arya. Request ID: req_1.', errorCode: 'chatgpt_usage_limit', startedAt: Date.now() - 1000, finishedAt: Date.now() })
  const block = nodes(limited.tree).find(node => node.props?.class === 'assistant-plan-error')
  assert.match(text(block), /Usage limit reached/); assert.match(text(block), /sam@example.com/)
  const manage = nodes(block).find(node => node.type === 'a')
  assert.equal(manage.props.class, 'button primary'); assert.equal(manage.props.href, usageURL)
  const signedOut = panel(ready, { state: 'error', text: 'Sign in again.', errorCode: 'chatgpt_sign_in_required', startedAt: Date.now() - 1000, finishedAt: Date.now() })
  assert.ok(button(signedOut.tree, 'Review ChatGPT sign-in'))
  const other = panel(ready, { state: 'error', text: 'Failed.', errorCode: 'something_else', startedAt: Date.now() - 1000, finishedAt: Date.now() })
  assert.equal(nodes(other.tree).some(node => node.props?.class === 'assistant-plan-error'), false)
})

test('page helpers start, follow and end a sign-in and keep the saved Auto pool', async () => {
  const calls = []
  let state = 'waiting'
  const api = async (route, body) => { calls.push({ route, body }); return route === '/api/assistant/chatgpt/sign-in' ? { started: true, opened: true } : { chatgpt: { supported: true, attempt: { state } } } }
  const helpers = statusModule(api)
  const follow = helpers.followChatGPTSignIn({ interval: 1 })
  assert.equal(helpers.followChatGPTSignIn({ interval: 1 }), follow, 'One follow loop at a time.')
  await new Promise(resolve => setTimeout(resolve, 20)); state = 'done'
  assert.equal((await follow).chatgpt.attempt.state, 'done')
  await assert.rejects(helpers.chatgptAccountAction('delete-everything'), /Unknown ChatGPT account action/)
  calls.length = 0
  await helpers.chooseChatGPTAssistant(baseStatus({ mode: 'auto', priority: 'quality', allowAdditionalSpend: true }))
  assert.deepEqual(calls[0], { route: '/api/assistant/config', body: { provider: 'chatgpt', model: '', agent: '', effort: '', catalogBound: false, mode: 'manual', priority: 'quality', enabledModels: [{ provider: 'codex', model: 'kept-model' }], allowAdditionalSpend: true, allowAPIBilling: false } })
  const failing = statusModule(async () => ({ started: false }))
  await assert.rejects(failing.startChatGPTSignIn({}), /could not be started/)
})

test('Auto never routes to ChatGPT plan models', () => {
  const route = selectRoute({ preferences: { mode: 'auto', provider: 'chatgpt', priority: 'balanced', enabledModels: [{ provider: 'chatgpt', model: 'gpt-fixture' }] },
    catalogs: [{ provider: 'chatgpt', complete: true, checkedAt: Date.now(), source: { kind: 'provider-sdk' }, models: [{ id: 'gpt-fixture', listed: true, available: true, retirementAt: null, inputModalities: ['text', 'image'] }] }],
    providers: [{ id: 'chatgpt', installed: true, authenticated: true, available: true, adapterSupported: true, modelSelectionSupported: true, billingMode: 'subscription' }],
    request: { text: 'Trim the intro', selectionCount: 0, requiresImage: false } })
  assert.equal(route.ok, false)
  assert.ok(route.blocked.some(item => item.provider === 'chatgpt' && /Manual selection only/.test(item.reason)))
  assert.equal(controls.routingCapabilities(null).autoProviders.includes('chatgpt'), false)
})

test('native sign-out cleanup remains available while the session is signed out', async () => {
  const current = account({ signedIn: false, planUsage: false, signOutCleanupRequired: true, error: 'Unlock your Mac, then finish signing out.' })
  const { tree, calls } = settings(baseStatus({ provider: 'chatgpt', chatgpt: current }))
  const retry = button(tree, 'Finish signing out')
  assert.ok(retry)
  await retry.props.onClick()
  assert.deepEqual(calls[0], { route: '/api/assistant/chatgpt/sign-out', body: {} })
})


test('selected provider failures and recovery come before the ChatGPT alternative', async () => {
  for (const provider of ['codex', 'claude-code']) {
    const reason = 'The selected account session expired. Sign in again.'
    const status = baseStatus({ provider, reason, chatgpt: account(),
      providers: [{ id: provider, installed: true, authenticated: false, available: false, reason }] })
    const { tree, state } = panel(status)
    const cards = nodes(tree).filter(node => node.props?.class === 'assistant-setup')
    assert.equal(cards.length, 2)
    assert.match(text(cards[0]), /session expired/)
    assert.ok(button(cards[0], 'Refresh status'))
    button(cards[0], 'Assistant settings').props.onClick()
    assert.equal(state.settingsOpen, true)
    assert.match(text(cards[1]), /Or use ChatGPT/)
    assert.ok(button(cards[1], 'Continue with ChatGPT'))
  }
})
