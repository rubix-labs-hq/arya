import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'
import { Icon } from '../web/ui/icons.js'
import * as script from '../web/ui/assistant-script.js'
import { assistantPanel } from '../web/ui/assistant-panel.js'
import { assistantActivity } from '../web/ui/assistant-activity.js'
import { createAssistantSharingGate } from '../web/ui/assistant-sharing.js'
import { assistantState, assistantPrompt, providerName } from '../web/ui/assistant-state.js'
import { changeReceipt } from '../web/ui/change-receipt.js'

// The real TopBar and ChatPanel templates render with inert hooks, as in topbar-groups.test.mjs
// and composer-refinement.test.mjs. No request leaves the process.
const read = name => fs.readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8')
const app = read('ui/app.js'), keys = read('ui/keys.js')
const assistantCSS = read('ui/assistant.css'), phoneCSS = read('ui/phone.css'), baseCSS = read('styles.css')
const chatSource = read('ui/chat.js').replace(/^import .*$/gm, '').replace(/^export /gm, '')
const renderChat = new Function('Icon', 'h', 'htm', 'useEffect', 'useRef', 'useState', 'useStore', 'useTime', 'assistantActivity', 'assistantState', 'assistantPrompt', 'providerName', 'refreshAssistantStatus', 'api', 'set', 'store', 'time', 'toast', 'receiptSelection', 'player', 'AssistantControls', 'RoutingReceipt', 'createAssistantSharingGate', 'startChatGPTSignIn', 'chatgptAccountAction', 'chooseChatGPTAssistant', ...Object.keys(script), 'assistantPanel', `${chatSource}\nreturn ChatPanel()`)
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const nodes = value => value && typeof value === 'object' ? [value, ...flatten(value.props?.children).flatMap(nodes)] : []
const text = value => flatten(value?.props?.children).map(child => typeof child === 'object' ? text(child) : String(child)).join(' ').replace(/\s+/g, ' ').trim()
const cls = (node, name) => String(node?.props?.class ?? '').split(/\s+/).includes(name)
const byClass = (tree, name) => nodes(tree).find(node => cls(node, name))
const byLabel = (tree, label) => nodes(tree).find(node => node.props?.['aria-label'] === label)
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const media = (css, query) => {
  const start = css.indexOf(`@media ${query} {`)
  assert.notEqual(start, -1, `missing @media ${query}`)
  for (let i = css.indexOf('{', start), depth = 0; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1)
  }
  assert.fail(`unterminated @media ${query}`)
}

const project = { name: 'Ferry', width: 1080, height: 1920, fps: 30 }
function shell({ kind = 'http', document = { querySelector: () => null }, microtask = callback => callback(), patch = {} } = {}) {
  const store = { project, version: 7, root: '/selected', recovery: { status: 'valid' }, jobs: [], caps: {}, claude: { state: 'idle' }, connected: true, refs: [], page: 'edit', ...patch }
  const context = vm.createContext({ html: htm.bind(h), h, Icon, assistantState, assistantActivity, store, host: { kind }, queueMicrotask: microtask, globalThis: { document }, useStore: () => store, useState: value => [value, () => {}], useRef: value => ({ current: value }), showRecovery() {}, api: async () => ({}), set: value => Object.assign(store, value), toast() {}, PAGES: [['edit', 'Edit', '⇧2', 20]], registry: { pages: [] }, ScrollTabs() {}, LayoutMenu() {} })
  vm.runInContext(app.match(/function TopBar\([^]*?\n}\n/)[0], context)
  return context
}
const entryOf = context => nodes(context.TopBar()).find(node => node.props?.id === 'ask-arya')

const scope = { providers: ['codex'], models: [{ provider: 'codex', model: 'exact' }], companion: 'http://127.0.0.1:4900/', classes: ['prompt', 'project_context', 'project_content', 'tool_results', 'rendered_frames', 'reference_images', 'conversation_history'] }
const approved = { version: 1, approved: true, scope, sharing: { version: 1, approved: true, scope } }
const needsReview = { version: 1, approved: false, reviewID: 'offline-review', scope }
const ready = { provider: 'codex', configured: true, model: 'exact', catalogBound: true }
function panel(t, overrides = {}, { draft = 'Tighten the opening', sharing = approved } = {}) {
  const state = { caps: {}, claude: { state: 'idle' }, connected: true, assistantStatus: ready, chat: [], activity: [], receipts: [], selection: [], refs: [], project: { tracks: [], comps: {} }, root: '/fixture', assistantDraft: { root: '/fixture', text: draft, inputKind: 'prompt' }, openComp: null, ...overrides }
  const calls = [], values = [], refs = [], toasts = []
  let hook = 0, ref = 0
  const api = async (route, body) => {
    calls.push({ route, body })
    if (route === '/api/assistant/sharing') return sharing
    if (route === '/api/assistant/cancel') return { cancelled: true }
    return { queued: 'fixture' }
  }
  const useState = initial => { const i = hook++; if (!(i in values)) values[i] = initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next }] }
  const useRef = initial => refs[ref++] ??= { current: initial }
  const Controls = () => null
  const account = name => async (...args) => { calls.push({ route: name, body: args }) }
  const draw = () => { hook = 0; ref = 0; return renderChat(Icon, h, htm, () => {}, useRef, useState, () => state, () => 12.25, assistantActivity, assistantState, assistantPrompt, providerName, async () => { calls.push({ route: 'refresh' }) }, api, patch => Object.assign(state, patch), state, { t: 12.25 }, message => toasts.push(message), () => null, {}, Controls, () => null, createAssistantSharingGate, account('sign-in'), account('account'), account('use-chatgpt'), ...Object.values(script), assistantPanel) }
  t.after(() => refs.forEach(item => item.current?.dispose?.()))
  return { state, calls, toasts, draw, Controls }
}
const usageURL = 'https://chatgpt.com/settings/usage'
const account = (changes = {}) => ({ supported: true, signedIn: false, planUsage: false, email: '', active: null, accounts: [], welcome: false, usageURL, attempt: { state: 'idle', message: '', startURL: null }, ...changes })
const signedIn = (changes = {}) => account({ signedIn: true, planUsage: true, email: 'sam@example.com', active: 'a1', accounts: [{ id: 'a1', email: 'sam@example.com', signedIn: true, planUsage: true, active: true }], ...changes })
const primary = tree => nodes(byClass(tree, 'assistant-primary-action')).filter(node => node.type === 'button')
const composerControls = tree => {
  const tools = byClass(tree, 'assistant-input-tools')
  return { tools, kind: byLabel(tools, 'Assistant input kind'), file: byLabel(tools, 'Import script or screenplay'), model: byClass(tools, 'assistant-model-menu'), tips: byClass(tools, 'assistant-input-help'), preview: nodes(byClass(tree, 'assistant-preview-toggle')).find(node => node.type === 'input'), field: nodes(tree).find(node => node.type === 'textarea') }
}

test('the entry dot and label agree in every assistant state, and the state stays in the accessible name', () => {
  const context = shell()
  const stale = { provider: 'codex', configured: false, mode: 'auto', autoPreview: { ok: false, blocked: [{ reason: 'The model catalog needs a refresh.' }] } }
  const expectState = (patch, label, dot, disabled = false) => {
    Object.assign(context.store, { claude: { state: 'idle' }, connected: true, assistantSharingReviewOpen: false, assistantStatus: undefined, ...patch })
    const entry = entryOf(context)
    assert.equal(text(byClass(entry, 'assistant-entry-state')), label, JSON.stringify(patch))
    assert.equal(entry.props['data-state'], dot, `${label} dot`)
    assert.equal(entry.props.disabled, disabled, `${label} disabled`)
    assert.equal(entry.props['aria-label'], undefined, 'no aria-label hides the visible state from assistive technology')
    assert.match(text(entry), new RegExp(`^Ask Arya ${label} /$`))
    assert.equal(nodes(entry).find(node => node.type === 'kbd').props['aria-hidden'], 'true')
  }
  expectState({}, 'Not set up', 'idle')
  expectState({ assistantStatus: ready }, 'Ready', 'ready')
  for (const state of ['sending', 'queued', 'thinking', 'running', 'working', 'cancelling']) expectState({ assistantStatus: ready, claude: { state } }, 'Working', 'working')
  for (const state of ['done', 'error', 'cancelled']) expectState({ assistantStatus: ready, claude: { state } }, 'Ready', 'ready')
  expectState({ assistantStatus: ready, assistantSharingReviewOpen: true }, 'Working', 'working', true)
  expectState({ assistantStatus: ready, claude: { state: 'working' }, connected: false }, 'Reconnecting', 'idle')
  expectState({ assistantStatus: stale }, 'Needs refresh', 'idle')
  expectState({ claude: { state: 'working' } }, 'Working', 'working')
  const hosted = entryOf(shell({ kind: 'browser-local', patch: { assistantStatus: ready, claude: { state: 'working' } } }))
  assert.equal(text(byClass(hosted, 'assistant-entry-state')), 'Unavailable in beta')
  assert.equal(hosted.props['data-state'], 'idle')
})

test('the entry is never hidden by CSS and only drops its key hint on a phone', () => {
  for (const [name, css] of [['assistant.css', assistantCSS], ['phone.css', phoneCSS], ['styles.css', baseCSS]]) {
    assert.doesNotMatch(css, /\.assistant-entry(?:-label|-state)?(?:\[[^\]]*\]|:[\w-]+)*\s*(?:,[^{}]*)?\{[^{}]*display:\s*none/, `${name} hides the entry, its label or its state`)
    assert.doesNotMatch(css, /\.assistant-entry(?:-label|-state)?\s*(?:,[^{}]*)?\{[^{}]*font-size:\s*0[;\s}]/, `${name} collapses the entry to an icon`)
  }
  const phone = media(assistantCSS, '(max-width: 720px)')
  assert.match(phone, /\.assistant-entry kbd \{ display: none; \}/)
  assert.match(media(assistantCSS, '(pointer: coarse), (max-width: 720px)'), /\.topbar \.assistant-entry \{ min-height: 44px; min-width: 0; \}/)
})

test('opening from the entry focuses the composer after the panel has rendered, never before', async () => {
  let mounted = false, focused = 0
  const selectors = []
  const document = { querySelector: selector => { selectors.push(selector); return mounted ? { focus: () => focused++ } : null } }
  const context = shell({ document, microtask: queueMicrotask })
  // Preact schedules the re-render as a microtask inside set(), before the handler returns.
  context.set = patch => { Object.assign(context.store, patch); Promise.resolve().then(() => { mounted = context.store.chatOpen === true }) }
  entryOf(context).props.onClick()
  assert.equal(context.store.chatOpen, true)
  assert.equal(focused, 0, 'the panel is not in the document yet')
  await tick()
  assert.equal(focused, 1, 'focus lands once the panel exists')
  assert.equal(selectors.length, 1)
  assert.match(selectors[0], /^#editor-assistant /)
  assert.match(selectors[0], /\btextarea\b/)
  entryOf(context).props.onClick()
  assert.equal(focused, 2, 'an open panel is focused at once')
  assert.equal(context.store.chatOpen, true, 'the entry never closes the conversation')
})

test('the entry, the / shortcut and Close agree with the panel markup they target', t => {
  const f = panel(t, { chatOpen: true })
  const root = f.draw()
  assert.equal(root.props.id, 'editor-assistant')
  assert.ok(cls(root, 'chat'), 'keys.js focuses .chat textarea')
  assert.match(keys, /case '\/':\s*set\(\{ chatOpen: true \}\)\s*setTimeout\(\(\) => document\.querySelector\('\.chat textarea'\)\?\.focus\(\), 30\)/)
  assert.equal(nodes(root).filter(node => node.type === 'textarea').length, 1)
  assert.equal(entryOf(shell({ patch: { chatOpen: true } })).props['aria-controls'], root.props.id)
  const hosted = panel(t, { caps: { host: 'browser-local' } }).draw()
  assert.equal(hosted.props.id, 'editor-assistant')
  assert.equal(nodes(hosted).some(node => node.type === 'textarea'), false)
  const download = nodes(byClass(hosted, 'assistant-setup')).find(node => node.type === 'a' && cls(node, 'primary'))
  assert.equal(text(download), 'Download for Mac', 'the hosted panel gives the entry a link to focus')
  const focused = [], previous = globalThis.document
  globalThis.document = { getElementById: id => ({ focus: () => focused.push(id) }) }
  try { byLabel(root, 'Close assistant').props.onClick() } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous }
  assert.equal(f.state.chatOpen, false)
  assert.deepEqual(focused, ['ask-arya'], 'closing returns focus to the entry')
  assert.equal(entryOf(shell()).props.id, 'ask-arya')
})

test('a suggestion fills the draft and moves focus to the composer without sending', t => {
  const clips = [{ id: 'c1', kind: 'video', src: 'a.mp4', start: 0, dur: 4 }]
  const f = panel(t, { selection: ['c1'], project: { width: 1920, height: 1080, assets: { 'a.mp4': { hasAudio: true } }, tracks: [{ id: 'V1', kind: 'video', clips }], comps: {} } }, { draft: '' })
  const tree = f.draw(), list = byClass(tree, 'chat-list'), group = byClass(list, 'assistant-suggestions')
  assert.ok(group, 'suggestions belong to the conversation')
  assert.equal(byClass(byClass(tree, 'assistant-composer-card'), 'assistant-suggestions'), undefined)
  assert.equal(nodes(list).filter(node => cls(node, 'chat-empty')).flatMap(node => nodes(node).filter(child => child.type === 'p')).length, 1)
  let focused = 0
  nodes(tree).find(node => node.type === 'textarea').ref.current = { focus: () => focused++ }
  nodes(group).find(node => node.type === 'button').props.onClick()
  assert.equal(focused, 1)
  assert.notEqual(f.state.assistantDraft.text, '')
  assert.deepEqual(f.calls, [])
})

test('one primary control swaps between Send and Stop and is the only one of either', async t => {
  const one = tree => { const buttons = primary(tree); assert.equal(buttons.length, 1); return buttons[0] }
  const describe = button => [button.props.class, text(button), button.props['aria-label'], Boolean(button.props.disabled)]
  assert.deepEqual(describe(one(panel(t).draw())), ['send', 'Send', 'Send message', false])
  assert.deepEqual(describe(one(panel(t, {}, { draft: '   ' }).draw())), ['send', 'Send', 'Send message', true], 'nothing to send')
  assert.deepEqual(describe(one(panel(t, { refs: [{ kind: 'clip', id: 'c1', label: 'Frame' }] }, { draft: '' }).draw())), ['send', 'Send', 'Send message', false], 'a reference alone can be sent')
  assert.deepEqual(describe(one(panel(t, {}, { draft: 'x'.repeat(128000) }).draw())), ['send', 'Send', 'Send message', false], 'at the character limit')
  assert.deepEqual(describe(one(panel(t, {}, { draft: 'x'.repeat(128001) }).draw())), ['send', 'Send', 'Send message', true], 'over the character limit')
  assert.deepEqual(describe(one(panel(t, { assistantStatus: { provider: 'codex', configured: false } }).draw())), ['send', 'Send', 'Send message', true], 'not set up')
  assert.deepEqual(describe(one(panel(t, { connected: false }).draw())), ['send', 'Send', 'Send message', true], 'disconnected')
  for (const state of ['queued', 'thinking', 'running', 'working']) assert.deepEqual(describe(one(panel(t, { claude: { state } }).draw())), ['assistant-stop', 'Stop', 'Stop request', false], state)
  assert.deepEqual(describe(one(panel(t, { claude: { state: 'cancelling' } }).draw())), ['assistant-stop', 'Stopping…', 'Stopping…', true])
  for (const state of ['done', 'error', 'cancelled']) assert.deepEqual(describe(one(panel(t, { claude: { state } }).draw())), ['send', 'Send', 'Send message', false], state)
  for (const tree of [panel(t).draw(), panel(t, { claude: { state: 'working' } }).draw()]) {
    assert.equal(nodes(tree).filter(node => node.type === 'button' && ['Send message', 'Stop request', 'Stopping…'].includes(node.props['aria-label'])).length, 1)
    assert.ok(nodes(byClass(tree, 'assistant-composer-footer')).includes(primary(tree)[0]), 'the control sits in the composer footer')
  }
  const f = panel(t, { claude: { state: 'working' } })
  await one(f.draw()).props.onClick()
  assert.deepEqual(f.calls.map(call => call.route), ['/api/assistant/cancel'], 'Stop never sends the draft')
  const idle = panel(t)
  one(idle.draw()).props.onClick()
  await tick()
  assert.deepEqual(idle.calls.map(call => call.route), ['/api/assistant/sharing', '/api/bridge/send'])
})

test('during a run every composer control stays in place, input options lock and the next draft stays editable', t => {
  for (const state of ['queued', 'thinking', 'running', 'working', 'cancelling']) {
    const f = panel(t, { claude: { state, startedAt: Date.now() - 2000 } })
    const tree = f.draw(), { tools, kind, file, model, tips, preview, field } = composerControls(tree)
    for (const [name, control] of Object.entries({ kind, file, model, tips, preview, field })) assert.ok(control, `${state}: ${name} is rendered`)
    assert.equal(kind.props.disabled, true, `${state}: input kind`)
    assert.equal(file.props.disabled, true, `${state}: text import`)
    assert.equal(preview.props.disabled, true, `${state}: Preview changes`)
    assert.equal(nodes(model).find(node => node.type === f.Controls).props.active, true, `${state}: model controls report the run`)
    assert.equal(field.props.disabled, undefined, `${state}: the next request can be drafted`)
    assert.equal(field.props.value, 'Tighten the opening')
    assert.equal(model.type, 'details'); assert.equal(text(nodes(model).find(node => node.type === 'summary')), 'Model')
    for (const control of [kind, file]) assert.equal(nodes(tools).some(node => node.type === 'details' && nodes(node).includes(control)), false, 'input kind and import are not behind a disclosure')
    assert.equal(byClass(tree, 'assistant-composer-content').props['aria-label'], 'Next request context')
    assert.equal(byLabel(tree, 'Assistant settings').props.disabled, false)
  }
  const idle = composerControls(panel(t).draw())
  assert.deepEqual([idle.kind.props.disabled, idle.file.props.disabled, idle.preview.props.disabled], [false, false, false])
})

test('during a sharing review the composer locks, keeps the draft and cannot send twice', async t => {
  const f = panel(t, {}, { sharing: needsReview })
  primary(f.draw())[0].props.onClick()
  await tick()
  assert.equal(f.state.assistantSharingReview.reviewID, 'offline-review')
  assert.equal(f.state.assistantSharingReviewOpen, true)
  const tree = f.draw(), { kind, file, model, preview, field } = composerControls(tree)
  assert.equal(kind.props.disabled, true); assert.equal(file.props.disabled, true); assert.equal(preview.props.disabled, true)
  assert.equal(nodes(model).find(node => node.type === f.Controls).props.active, true)
  assert.equal(byLabel(tree, 'Assistant settings').props.disabled, true)
  assert.equal(field.props.value, 'Tighten the opening', 'the draft is kept while consent is open')
  const [button] = primary(tree)
  assert.equal(primary(tree).length, 1)
  assert.equal(button.props['aria-label'], 'Send message'); assert.equal(button.props.disabled, true)
  const context = shell({ patch: { assistantStatus: ready, assistantSharingReviewOpen: f.state.assistantSharingReviewOpen, chatOpen: true } })
  assert.equal(entryOf(context).props.disabled, true, 'the entry cannot move focus behind the review')
  f.state.assistantSharingActions.decline()
  await tick()
  assert.equal(f.state.assistantSharingReview, null); assert.equal(f.state.assistantSharingReviewOpen, false)
  const after = f.draw(), unlocked = composerControls(after)
  assert.deepEqual([unlocked.kind.props.disabled, unlocked.file.props.disabled, unlocked.preview.props.disabled], [false, false, false])
  assert.equal(unlocked.field.props.value, 'Tighten the opening')
  assert.equal(primary(after)[0].props.disabled, false)
  assert.deepEqual(f.calls.map(call => call.route), ['/api/assistant/sharing'], 'declining sends nothing')
})

test('tool updates collapse between messages and edits, and the streaming reply and status follow them', t => {
  const receipt = { version: 7, total: 0, clips: [], projectChanges: ['Saved asset media/cue.wav'], at: 4 }
  const f = panel(t, { claude: { state: 'working', startedAt: Date.now() - 2000, text: 'Partial **reply**' },
    chat: [{ role: 'user', text: 'Add the cue', at: 1 }], receipts: [receipt],
    activity: [{ who: 'agent', text: 'Listing media', at: 2 }, { who: 'agent', text: 'Saving cue', at: 3 }, { who: 'agent', text: 'Checking levels', at: 5 }, { who: 'you', text: 'Hidden', at: 6 }] })
  const list = byClass(f.draw(), 'chat-list'), order = flatten(list.props.children).filter(node => node && typeof node === 'object')
  const kinds = order.map(node => cls(node, 'assistant-tool-card') ? `tools:${text(nodes(node).find(child => child.type === 'summary'))}` : node.type?.name === 'ChangeReceipt' ? 'edit' : cls(node, 'assistant-stream') ? 'stream' : cls(node, 'assistant-run') ? 'status' : cls(node, 'msg') ? `msg:${node.props.class}` : null).filter(Boolean)
  assert.deepEqual(kinds, ['msg:msg user', 'tools:2 tool updates', 'edit', 'tools:1 tool update', 'stream', 'status'])
  for (const card of order.filter(node => cls(node, 'assistant-tool-card'))) {
    assert.equal(card.type, 'details'); assert.equal(card.props.open, undefined, 'collapsed until the user opens it')
    assert.equal(nodes(card).filter(node => node.type === 'li').length, Number(text(nodes(card).find(node => node.type === 'summary')).split(' ')[0]))
  }
  assert.doesNotMatch(text(list), /Hidden/)
  const stream = order.find(node => cls(node, 'assistant-stream'))
  assert.match(text(stream), /Response in progress/)
  assert.match(nodes(stream).find(node => node.props?.dangerouslySetInnerHTML).props.dangerouslySetInnerHTML.__html, /Partial <(b|strong)>reply<\/\1>/)
  const status = order.find(node => cls(node, 'assistant-run'))
  assert.ok(cls(status, 'active')); assert.equal(nodes(status).find(node => node.props?.role === 'status').type, 'b')
  assert.equal(byClass(list, 'chat-empty'), undefined)
  const finished = panel(t, { claude: { state: 'done', text: 'Partial **reply**' }, chat: f.state.chat, receipts: [receipt], activity: f.state.activity })
  assert.equal(byClass(finished.draw(), 'assistant-stream'), undefined, 'a finished run shows no streaming block')
})

test('a committed edit is a compact card: headline, collapsed details and its action outside them', () => {
  const receiptSource = read('ui/chat.js').slice(read('ui/chat.js').indexOf('function ChangeReceipt'), read('ui/chat.js').indexOf('function AssistantHistoryNotice'))
  const before = { name: 'Cut', width: 1920, height: 1080, fps: 30, assets: {}, comps: {}, tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'title', title: { text: 'Old' }, start: 0, dur: 2 }] }] }
  const after = structuredClone(before); after.tracks[0].clips[0].title.text = 'New'
  const updates = [], seeks = []
  const ChangeReceipt = new Function('html', 'receiptSelection', 'store', 'set', 'toast', 'player', `${receiptSource}\nreturn ChangeReceipt`)(htm.bind(h), () => ({ comp: null, ids: ['c1'], start: 0 }), { project: after }, value => updates.push(value), () => {}, { seek: value => seeks.push(value) })
  const receipt = changeReceipt(before, after, { version: 9, who: 'agent' })
  const card = ChangeReceipt({ receipt })
  assert.equal(card.type, 'section'); assert.ok(cls(card, 'assistant-result-card'))
  assert.equal(card.props['aria-label'], 'Committed edit result')
  assert.match(text(byClass(card, 'receipt-heading')), /Edit 9$/)
  const details = byClass(card, 'change-receipt')
  assert.equal(details.type, 'details'); assert.equal(details.props.open, undefined)
  assert.equal(text(nodes(details).find(node => node.type === 'summary')), 'View changes')
  const action = nodes(card).find(node => node.type === 'button' && text(node) === 'Select changed layers')
  assert.ok(action, 'the action is on the card')
  assert.equal(nodes(details).includes(action), false, 'and stays reachable while the details are collapsed')
  action.props.onClick()
  assert.deepEqual(updates, [{ openComp: null, selection: ['c1'], page: 'edit', viewerMode: 'timeline' }]); assert.deepEqual(seeks, [0])
  const undone = ChangeReceipt({ receipt: { ...receipt, undone: true } })
  assert.equal(undone.props['aria-label'], 'Undone edit result')
  assert.match(text(byClass(undone, 'receipt-heading')), /Undone · Edit 9$/)
})

test('setup is one card with one primary action, and the draft stays in the composer', t => {
  const missing = chatgpt => ({ provider: 'codex', mode: 'manual', configured: false, chatgpt, providers: [{ id: 'codex', installed: false, authenticated: false, available: false, reason: 'Install Codex.' }] })
  for (const [name, status, action, route] of [
    ['no ChatGPT on this server', missing(undefined), 'Assistant settings', null],
    ['signed out', missing(account()), 'Continue with ChatGPT', 'sign-in'],
    ['plan usage off', missing(signedIn({ planUsage: false })), 'Turn on ChatGPT plan usage', 'sign-in'],
    ['signed in, another provider selected', missing(signedIn()), 'Use ChatGPT', 'use-chatgpt'],
  ]) {
    const f = panel(t, { assistantStatus: status }), tree = f.draw()
    const cards = nodes(tree).filter(node => cls(node, 'assistant-setup'))
    assert.equal(cards.length, 1, name)
    const primaries = nodes(cards[0]).filter(node => ['button', 'a'].includes(node.type) && cls(node, 'primary'))
    assert.deepEqual(primaries.map(text), [action], name)
    assert.match(text(cards[0]), /Your draft is kept\./, name)
    assert.equal(nodes(tree).find(node => node.type === 'textarea').props.value, 'Tighten the opening', name)
    assert.equal(byClass(tree, 'chat-empty'), undefined, `${name}: no empty-state sentence competes with setup`)
    primaries[0].props.onClick()
    if (route) assert.deepEqual(f.calls.map(call => call.route), [route], name)
    else assert.equal(f.state.settingsOpen, true, name)
    if (status.chatgpt) {
      nodes(cards[0]).find(node => node.type === 'button' && text(node) === 'Other ways to connect').props.onClick()
      assert.equal(f.state.settingsOtherWays, true, name)
    }
  }
  assert.doesNotMatch(text(byClass(panel(t, { assistantStatus: missing(account()) }, { draft: '' }).draw(), 'assistant-setup')), /Your draft is kept/)
})

test('the phone sheet keeps the viewer visible and every composer control a thumb target', () => {
  const phone = media(assistantCSS, '(max-width: 720px)')
  const sheet = phone.match(/\.main > \.chat\.panel \{([^}]*)\}/)?.[1] ?? ''
  for (const rule of ['top: auto', 'right: 0', 'bottom: 0', 'left: 0', 'width: 100%', 'height: min(62dvh, calc(100dvh - var(--topbar-height) - 6px))', 'padding-bottom: env(safe-area-inset-bottom)']) assert.ok(sheet.includes(rule), `sheet: ${rule}`)
  assert.match(media(assistantCSS, '(max-width: 900px)'), /\.main > \.chat\.panel \{ position: fixed;/)
  assert.match(phone, /\.app\.chat-open:has\(\.assistant-composer-card\) \.page\.phone-edit \.edit-viewer \{ height: clamp\(110px, calc\(38dvh - var\(--topbar-height\) - 12px\), 320px\); \}/, 'the viewer keeps a height above the sheet')
  assert.doesNotMatch(phone, /\.edit-viewer[^{]*\{[^}]*display:\s*none/)
  assert.match(phone, /\.chat \.composer textarea \{ font-size: max\(16px, 1em\); \}/, 'no zoom on focus in iOS Safari')
  assert.match(phone, /\.main > \.chat\.assistant-unavailable \{ height: auto;/, 'the hosted notice does not cover the editor')
  const touch = media(assistantCSS, '(pointer: coarse), (max-width: 720px)')
  for (const target of ['.chat-head button', '.assistant-setup-actions > *', '.assistant-suggestion', '.assistant-input-tools :is(select, summary, .assistant-script-import)', '.assistant-primary-action button', '.assistant-preview-toggle', '.receipt-actions button']) assert.ok(touch.includes(target), `44px target: ${target}`)
  assert.match(touch, /\{ min-height: 44px; \}/)
  const landscape = media(assistantCSS, '(max-height: 500px) and (max-width: 1000px) and (orientation: landscape)')
  assert.match(landscape, /\.main > \.chat\.panel \{ position: fixed; top: calc\(var\(--topbar-height\) \+ 6px\); right: 6px; bottom: 6px; left: auto;/, 'a short landscape phone gets a side panel, not a sheet')
  assert.match(assistantCSS, /\.chat \.assistant-composer-card \{\s*flex: 0 0 auto;/, 'the composer never shrinks out of the panel')
  assert.match(baseCSS, /\.chat-list \{ flex: 1 1 0; min-height: 0; overflow: auto;/, 'the conversation scrolls above it')
  assert.match(media(assistantCSS, '(prefers-reduced-motion: reduce)'), /\.chat \.claude-dot\.busy \{ animation: none; \}/)
})
