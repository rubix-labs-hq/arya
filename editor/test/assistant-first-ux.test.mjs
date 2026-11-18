import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'
import { Icon } from '../web/ui/icons.js'
import * as script from '../web/ui/assistant-script.js'
import { assistantPanel } from '../web/ui/assistant-panel.js'
import { assistantActivity, PREVIEW_OUTCOME } from '../web/ui/assistant-activity.js'
import { createAssistantSharingGate } from '../web/ui/assistant-sharing.js'
import { assistantState, assistantPrompt, providerName } from '../web/ui/assistant-state.js'
import { changeReceipt } from '../web/ui/change-receipt.js'

// The real TopBar and ChatPanel templates render with inert hooks, as in topbar-groups.test.mjs
// and composer-refinement.test.mjs. No request leaves the process.
const read = name => fs.readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8')
const app = read('ui/app.js'), keys = read('ui/keys.js'), storeSource = read('ui/store.js'), timelineSource = read('ui/timeline.js')
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
  let hook = 0, ref = 0, effects = [], ran = []
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
  const draw = () => { hook = 0; ref = 0; effects = []; return renderChat(Icon, h, htm, (run, deps) => { effects.push({ run, deps }) }, useRef, useState, () => state, () => 12.25, assistantActivity, assistantState, assistantPrompt, providerName, async () => { calls.push({ route: 'refresh' }) }, api, patch => Object.assign(state, patch), state, { t: 12.25 }, message => toasts.push(message), () => null, {}, Controls, () => null, createAssistantSharingGate, account('sign-in'), account('account'), account('use-chatgpt'), ...Object.values(script), assistantPanel) }
  t.after(() => refs.forEach(item => item.current?.dispose?.()))
  // Runs the effects of the last draw whose dependencies changed, as Preact would after a render.
  const flush = (only = /./) => effects.map((effect, i) => {
    const changed = !ran[i] || !effect.deps || effect.deps.some((value, at) => !Object.is(value, ran[i][at]))
    if (!changed || !only.test(String(effect.run))) return undefined
    ran[i] = effect.deps ?? []
    return effect.run()
  })
  return { state, calls, toasts, draw, flush, Controls }
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
    assert.match(text(entry), new RegExp(`^Ask Arya to edit or explain ${label} /$`))
    assert.equal(byClass(entry, 'assistant-entry-hint').props['aria-hidden'], 'true', 'the hint is not part of the name')
    assert.equal(nodes(entry).find(node => node.type === 'kbd').props['aria-hidden'], 'true')
  }
  expectState({}, 'Checking', 'idle')
  expectState({ assistantStatus: { provider: 'codex', configured: false } }, 'Not set up', 'idle')
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

test('the entry is never hidden or clipped by CSS and only drops its key hint on a phone', () => {
  // Every rule in every sheet whose subject is the entry, its label, its state or a direct child span.
  for (const [name, css] of [['assistant.css', assistantCSS], ['phone.css', phoneCSS], ['styles.css', baseCSS]]) {
    for (const [, selectors, body] of css.replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
      for (const selector of selectors.split(',').map(item => item.trim())) {
        const subject = selector.split(/\s*[\s>+~]\s*/).at(-1)
        const entryPart = /^\.assistant-entry(?:-label|-state)?(?![\w-])/.test(subject) || /\.assistant-entry(?![\w-])[^\s>]*\s*>\s*(?:span|\*)$/.test(selector)
        if (entryPart) assert.doesNotMatch(body, /display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d])|font-size:\s*0[;\s}]|text-overflow|overflow:\s*hidden|max-width:\s*\d/, `${name}: ${selector}`)
      }
    }
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
  assert.match(keys, /case '\/':\s*set\(\{ chatOpen: true, chatCollapsed: false \}\)\s*setTimeout\(\(\) => document\.querySelector\('\.chat textarea'\)\?\.focus\(\), 30\)/)
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
  // The control is an icon, so its name is the aria-label and its tooltip repeats what it does.
  const describe = button => { assert.ok(button.props.title, 'the icon has a tooltip'); assert.equal(text(button), '', 'no visible word changes the width'); return [button.props.class, nodes(button).find(node => node.type === Icon)?.props.name, button.props['aria-label'], Boolean(button.props.disabled)] }
  assert.deepEqual(describe(one(panel(t).draw())), ['send', 'send', 'Send message', false])
  assert.deepEqual(describe(one(panel(t, {}, { draft: '   ' }).draw())), ['send', 'send', 'Send message', true], 'nothing to send')
  assert.deepEqual(describe(one(panel(t, { refs: [{ kind: 'clip', id: 'c1', label: 'Frame' }] }, { draft: '' }).draw())), ['send', 'send', 'Send message', false], 'a reference alone can be sent')
  assert.deepEqual(describe(one(panel(t, {}, { draft: 'x'.repeat(128000) }).draw())), ['send', 'send', 'Send message', false], 'at the character limit')
  assert.deepEqual(describe(one(panel(t, {}, { draft: 'x'.repeat(128001) }).draw())), ['send', 'send', 'Send message', true], 'over the character limit')
  assert.deepEqual(describe(one(panel(t, { assistantStatus: { provider: 'codex', configured: false } }).draw())), ['send', 'send', 'Send message', true], 'not set up')
  assert.deepEqual(describe(one(panel(t, { connected: false }).draw())), ['send', 'send', 'Send message', true], 'disconnected')
  for (const state of ['queued', 'thinking', 'running', 'working']) assert.deepEqual(describe(one(panel(t, { claude: { state } }).draw())), ['assistant-stop', 'stop', 'Stop request', false], state)
  assert.deepEqual(describe(one(panel(t, { claude: { state: 'cancelling' } }).draw())), ['assistant-stop', 'stop', 'Stopping…', true])
  for (const state of ['done', 'error', 'cancelled']) assert.deepEqual(describe(one(panel(t, { claude: { state } }).draw())), ['send', 'send', 'Send message', false], state)
  for (const tree of [panel(t).draw(), panel(t, { claude: { state: 'working' } }).draw()]) {
    assert.equal(nodes(tree).filter(node => node.type === 'button' && ['Send message', 'Stop request', 'Stopping…'].includes(node.props['aria-label'])).length, 1)
    const field = byClass(tree, 'assistant-field')
    assert.ok(nodes(byClass(field, 'assistant-field-bar')).includes(primary(tree)[0]), 'the control sits in the bar inside the field')
    for (const part of ['assistant-composer-content', 'assistant-preview-toggle', 'assistant-input-tools']) assert.ok(byClass(field, part), `${part} is inside the one bordered field`)
    assert.ok(nodes(field).some(node => node.type === 'textarea'), 'the text box is inside the field')
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
  assert.match(phone, /\.app\.chat-open:not\(\.chat-collapsed\):has\(\.assistant-composer-card\) \.page\.phone-edit \.edit-viewer \{ height: clamp\(110px, calc\(38dvh - var\(--topbar-height\) - 12px\), 320px\); \}/, 'the viewer keeps a height above the sheet')
  assert.doesNotMatch(phone, /\.edit-viewer[^{]*\{[^}]*display:\s*none/)
  assert.match(phone, /\.chat \.composer textarea \{ font-size: max\(16px, 1em\); \}/, 'no zoom on focus in iOS Safari')
  assert.match(phone, /\.main > \.chat\.assistant-unavailable \{ height: auto;/, 'the hosted notice does not cover the editor')
  const touch = media(assistantCSS, '(pointer: coarse), (max-width: 720px)')
  for (const target of ['.chat-head button', '.assistant-setup-actions > *', '.assistant-suggestion', '.assistant-input-tools :is(select, summary, .assistant-script-import)', '.assistant-primary-action button', '.assistant-preview-toggle', '.receipt-actions button']) assert.ok(touch.includes(target), `44px target: ${target}`)
  assert.match(touch, /\{ min-height: 44px; \}/)
  const landscape = media(assistantCSS, '(max-height: 500px) and (max-width: 1000px) and (orientation: landscape)')
  assert.match(landscape, /\.main > \.chat\.panel \{ position: fixed; top: calc\(var\(--topbar-height\) \+ 6px\); right: 6px; bottom: 6px; left: auto; width: min\(max\(46vw, 320px\), var\(--chat-width, 360px\)\); height: auto;/, 'a short landscape phone gets a side panel that leaves the editor in view, not a sheet')
  assert.match(assistantCSS, /\.chat \.assistant-composer-card \{\s*flex: 0 0 auto;/, 'the composer never shrinks out of the panel')
  assert.match(baseCSS, /\.chat-list \{ flex: 1 1 0; min-height: 0; overflow: auto;/, 'the conversation scrolls above it')
  assert.match(media(assistantCSS, '(prefers-reduced-motion: reduce)'), /\.chat \.claude-dot\.busy \{ animation: none; \}/)
})

// Fails at 9f9dc3b: the merged setup card dropped the one-click ChatGPT action that the second card had at 9fa712a.
test('a failing selected provider keeps the ChatGPT action on the setup card, after Refresh', async t => {
  const reason = 'The selected account session expired. Sign in again.'
  const failing = chatgpt => ({ provider: 'codex', mode: 'manual', configured: false, reason, chatgpt, providers: [{ id: 'codex', installed: true, authenticated: false, available: false, reason }] })
  for (const [name, chatgpt, action, route] of [
    ['signed out', account(), 'Continue with ChatGPT', 'sign-in'],
    ['plan usage off', signedIn({ planUsage: false }), 'Turn on ChatGPT plan usage', 'sign-in'],
    ['signed in', signedIn(), 'Use ChatGPT', 'use-chatgpt'],
  ]) {
    const f = panel(t, { assistantStatus: failing(chatgpt) }), tree = f.draw()
    const cards = nodes(tree).filter(node => cls(node, 'assistant-setup'))
    assert.equal(cards.length, 1, name)
    assert.match(text(cards[0]), /session expired/, name)
    const buttons = nodes(cards[0]).filter(node => node.type === 'button')
    assert.deepEqual(buttons.filter(node => cls(node, 'primary')).map(text), ['Refresh status'], `${name}: recovery stays the one primary action`)
    assert.deepEqual(buttons.map(text), ['Refresh status', action, 'Other ways to connect'], name)
    await buttons[1].props.onClick()
    assert.deepEqual(f.calls.map(call => call.route), [route], name)
  }
  const waiting = panel(t, { assistantStatus: failing(account({ attempt: { state: 'waiting', message: '', startURL: 'https://auth.example/start' } })) }).draw()
  assert.deepEqual(nodes(byClass(waiting, 'assistant-setup')).filter(node => node.type === 'button').map(text), ['Cancel sign-in', 'Refresh status', 'Other ways to connect'], 'a sign-in in progress keeps Refresh for the failing provider')
})

// Fails at 9f9dc3b: a ready assistant that lost its connection no longer says why Send is off.
test('a ready assistant that lost its connection says why Send is off and that the draft is kept', t => {
  const tree = panel(t, { connected: false }).draw()
  assert.equal(primary(tree)[0].props.disabled, true)
  const card = byClass(tree, 'assistant-composer-card'), reason = byClass(card, 'assistant-send-reason')
  assert.ok(reason, 'the reason sits with the composer')
  assert.equal(text(reason), 'Reconnect to send. Your draft is kept.')
  assert.equal(reason.props.role, 'status')
  const parts = flatten(card.props.children).filter(node => node && typeof node === 'object')
  assert.equal(parts.indexOf(reason), parts.indexOf(byClass(card, 'assistant-field')) + 1, 'the note is the line under the field that holds the disabled Send')
  assert.equal(text(tree).split('Reconnect to send').length - 1, 1, 'it is said once')
  assert.equal(byClass(panel(t, { connected: false }, { draft: '' }).draw(), 'assistant-send-reason'), undefined, 'no draft, no note')
  assert.equal(byClass(panel(t).draw(), 'assistant-send-reason'), undefined)
  assert.equal(byClass(panel(t, { connected: false, claude: { state: 'working' } }).draw(), 'assistant-send-reason'), undefined, 'a run shows its own status')
})

test('until the first status check answers, the entry and panel say Checking and never show setup', t => {
  const unset = { provider: 'codex', mode: 'manual', configured: false, providers: [{ id: 'codex', installed: false, authenticated: false, available: false, reason: 'Install Codex.' }] }
  for (const [name, patch, checking] of [
    ['no status has arrived', { assistantStatus: undefined }, true],
    ['the first account check is running', { assistantStatus: { ...unset, loading: true, checkedAt: null } }, true],
    ['a later re-check of an assistant that is not set up', { assistantStatus: { ...unset, loading: true, checkedAt: 1700000000000 } }, false],
    ['the check answered: nothing is set up', { assistantStatus: { ...unset, loading: false, checkedAt: 1700000000000 } }, false],
    ['the status request failed', { assistantStatus: null, assistantStatusError: 'The editor server did not answer.' }, false],
  ]) {
    const f = panel(t, patch), tree = f.draw(), note = byClass(tree, 'assistant-checking')
    assert.equal(Boolean(note), checking, name)
    assert.equal(nodes(tree).some(node => cls(node, 'assistant-setup')), !checking, `${name}: setup card`)
    assert.match(text(byClass(tree, 'chat-head')), checking ? /^Assistant Checking Settings$/ : /^Assistant Not set up Settings$/, name)
    if (checking) { assert.equal(text(note), '◌ Checking your assistant…'); assert.equal(note.props.role, 'status') }
    const field = nodes(tree).find(node => node.type === 'textarea')
    assert.equal(field.props.value, 'Tighten the opening', `${name}: the draft is kept`)
    assert.equal(field.props.disabled, undefined, `${name}: the draft stays editable`)
    assert.equal(primary(tree)[0].props.disabled, true, name)
    const entry = entryOf(shell({ patch }))
    assert.equal(text(byClass(entry, 'assistant-entry-state')), checking ? 'Checking' : 'Not set up', `${name}: entry`)
    assert.equal(entry.props['data-state'], 'idle', name)
    assert.equal(entry.props.disabled, false, `${name}: the entry still opens the panel`)
    // Return cannot send yet. It says why, keeps the draft and sends nothing.
    field.props.onKeyDown({ key: 'Enter', stopPropagation() {}, preventDefault() {} })
    assert.deepEqual(f.toasts, [checking ? 'Still checking your assistant. Your draft is kept.' : 'Connect an assistant to send. Your draft is kept.'], name)
    assert.deepEqual(f.calls, [], name)
    // Send turns on with the same draft as soon as the status says the assistant is ready.
    f.state.assistantStatus = ready; f.state.assistantStatusError = ''
    const after = f.draw()
    assert.equal(byClass(after, 'assistant-checking'), undefined, name)
    assert.equal(primary(after)[0].props.disabled, false, name)
    assert.equal(nodes(after).find(node => node.type === 'textarea').props.value, 'Tighten the opening', name)
  }
  const waiting = panel(t, { assistantStatus: { ...unset, loading: true, checkedAt: null, chatgpt: account({ attempt: { state: 'waiting', message: '', startURL: 'https://auth.example/start' } }) } }).draw()
  assert.equal(byClass(waiting, 'assistant-checking'), undefined, 'a sign-in in progress keeps its own card')
  assert.ok(nodes(byClass(waiting, 'assistant-setup')).some(node => node.type === 'button' && text(node) === 'Cancel sign-in'))
  assert.equal(byClass(panel(t, { assistantStatus: { ...ready, loading: true, checkedAt: null } }).draw(), 'assistant-checking'), undefined, 'a ready assistant is never shown as checking')
  assert.match(app, /const checkingAssistant = !s\.assistantStatusError && s\.assistantStatus\?\.loading === true && s\.assistantStatus\.checkedAt === null\n/)
  assert.match(app, /setInterval\(poll, checkingAssistant \? 1000 : 4000\)[^]*?\}, \[checkingAssistant\]\)/, 'the status is asked again sooner while the first check runs')
})

test('the preview sentence shows only while this request has a proposal to apply', t => {
  const server = fs.readFileSync(new URL('../agent/browser-assistant.mjs', import.meta.url), 'utf8')
  assert.equal(server.match(/pending: '([^']+)'/)?.[1], PREVIEW_OUTCOME, 'the panel and the server agree on the sentence')
  assert.equal(server.split(`'${PREVIEW_OUTCOME}'`).length - 1, 2, 'the server publishes the same text for a preview run')
  const done = { state: 'done', runId: 'r1', outcome: PREVIEW_OUTCOME, startedAt: 1000, finishedAt: 9000 }
  const review = changes => ({ proposal: null, applying: null, change: null, running: false, runId: null, ...changes })
  const note = state => { const run = byClass(panel(t, state).draw(), 'assistant-run'); return { silent: cls(run, 'silent'), lines: nodes(run).filter(node => node.type === 'p').map(text) } }
  assert.deepEqual(note({ claude: done, assistantReview: review() }), { silent: true, lines: [] }, 'a reply with nothing proposed says nothing about Apply')
  assert.deepEqual(note({ claude: done, assistantReview: review({ proposal: { id: 'p1', runId: 'r1' } }) }), { silent: false, lines: [PREVIEW_OUTCOME] })
  assert.deepEqual(note({ claude: done, assistantReview: review({ proposal: { id: 'p0', runId: 'r0' } }) }), { silent: true, lines: [] }, 'an older proposal is not this request')
  assert.deepEqual(note({ claude: done }), { silent: false, lines: [PREVIEW_OUTCOME] }, 'with no review state the sentence is kept')
  assert.deepEqual(note({ claude: done, caps: { host: 'native' }, assistantReview: review() }), { silent: false, lines: [PREVIEW_OUTCOME] }, 'the Mac host reports its own flow')
  const other = 'The project changed during this request. Review edits in the timeline.'
  assert.deepEqual(note({ claude: { ...done, outcome: other }, assistantReview: review() }), { silent: false, lines: [other] }, 'other outcomes always show')
  assert.equal(assistantActivity(done, { proposal: false }).detail, '')
  assert.equal(assistantActivity(done).detail, PREVIEW_OUTCOME)
})

test('after Stop, committed edits are mentioned only when this request made some', t => {
  const stopped = { state: 'cancelled', runId: 'r1', startedAt: 1000, finishedAt: 13000 }
  const sentence = 'Request stopped. Committed edits remain available to review and undo.'
  const review = change => ({ proposal: null, applying: null, change, running: false, runId: null })
  const row = state => { const run = byClass(panel(t, state).draw(), 'assistant-run'); assert.ok(cls(run, 'cancelled')); return text(run) }
  assert.equal(row({ claude: stopped, assistantReview: review(null) }), '■ Stopped 12s', 'nothing was committed, so nothing is promised')
  assert.equal(row({ claude: stopped, assistantReview: review({ id: 'c1', kind: 'request', runId: 'r1', edits: 2 }) }), `■ Stopped 12s ${sentence}`)
  assert.equal(row({ claude: stopped, assistantReview: review({ id: 'c0', kind: 'request', runId: 'r0', edits: 2 }) }), '■ Stopped 12s', 'an earlier request made those edits')
  assert.equal(row({ claude: stopped, assistantReview: review({ id: 'c1', kind: 'request', runId: 'r1', edits: 0 }) }), '■ Stopped 12s')
  assert.equal(row({ claude: stopped }), `■ Stopped 12s ${sentence}`, 'with no review state the sentence is kept')
  assert.equal(row({ claude: stopped, caps: { host: 'native' }, assistantReview: review(null) }), `■ Stopped 12s ${sentence}`)
  assert.equal(assistantActivity(stopped, { edits: false }).detail, '')
  assert.equal(assistantActivity(stopped).detail, sentence)
})

test('a finished run adds no card: the reply stands alone and the status is announced, not drawn', t => {
  const reply = { role: 'assistant', text: 'The opening is two seconds shorter.', at: 2 }
  const review = { proposal: null, applying: null, change: null, running: false, runId: null }
  const tree = panel(t, { claude: { state: 'done', runId: 'r1', outcome: PREVIEW_OUTCOME }, chat: [{ role: 'user', text: 'Tighten it', at: 1 }, reply], assistantReview: review }).draw()
  const run = byClass(tree, 'assistant-run')
  assert.ok(cls(run, 'done') && cls(run, 'silent'))
  assert.equal(text(nodes(run).find(node => node.props?.role === 'status')), 'Response finished', 'assistive technology still hears that the reply ended')
  assert.equal(nodes(run).some(node => ['p', 'button'].includes(node.type)), false)
  assert.equal(text(byClass(tree, 'chat-head')), 'Assistant Response finished Settings', 'the header is the one place that shows it')
  const hidden = assistantCSS.match(/\.chat-list :is\(([^{]*)\) \{\s*position: absolute; width: 1px; height: 1px;[^}]*clip-path: inset\(50%\);[^}]*\}/)?.[1] ?? ''
  for (const part of ['.sr-only', '.assistant-stream > small', '.assistant-run.done .assistant-run-heading', '.assistant-run.silent']) assert.ok(hidden.split(', ').includes(part), `visually hidden: ${part}`)
  assert.match(assistantCSS, /\.chat-list \.assistant-run \{[^}]*border: 0; background: none; \}/, 'run status is an unframed row')
  assert.match(assistantCSS, /\.chat-list \.assistant-run\.error \{[^}]*border: 1px solid/, 'only a failure keeps a frame')
  assert.doesNotMatch(assistantCSS, /\.assistant-run(?:\.\w+)*(?: [^{,]*)?\{[^}]*display:\s*none/, 'the status node stays in the accessibility tree')
  const failed = panel(t, { claude: { state: 'error', runId: 'r1' }, chat: [{ role: 'user', text: 'Tighten it', at: 1 }] }, { draft: '' }).draw(), failure = byClass(failed, 'assistant-run')
  assert.ok(cls(failure, 'error') && !cls(failure, 'silent'))
  assert.equal(text(nodes(failure).find(node => node.type === 'button')), 'Edit and retry')
  // The reply and the request are message bodies; only the request is a bubble.
  const messages = nodes(tree).filter(node => cls(node, 'msg'))
  assert.deepEqual(messages.map(node => [node.props.class, text(nodes(node).find(child => cls(child, 'sr-only'))), Boolean(byClass(node, 'msg-body'))]), [['msg user', 'You', true], ['msg claude', 'Assistant', true]])
  assert.match(assistantCSS, /\.chat-list \.msg\.claude \{[^}]*border: 0; background: transparent;/)
  assert.match(assistantCSS, /\.chat-list \.msg\.user \.msg-body \{[^}]*background: var\(--panel-2\);/)
  assert.match(assistantCSS, /\.chat-list \.assistant-tool-card \{[^}]*border: 0; background: none;/, 'tool activity is one quiet line')
})

test('hidden speaker labels are clipped inside the list and cannot stretch the panel', () => {
  assert.match(assistantCSS, /\.chat-list \{ position: relative;/, 'the list is the positioning root for its hidden labels')
  assert.match(assistantCSS, /\.chat-list \{[^}]*overscroll-behavior: contain;/)
  assert.match(baseCSS, /\.chat-list \{ flex: 1 1 0; min-height: 0; overflow: auto;/, 'and it is the scroll container that holds them')
})

test('the list follows the person\'s own message, a new proposal, an apply, an undo bar and the end of a run', t => {
  const review = changes => ({ proposal: null, applying: null, change: null, running: false, runId: null, ...changes })
  const f = panel(t, { chat: [{ role: 'user', text: 'First', at: 1 }], assistantReview: review() })
  const element = { scrollTop: 0, scrollHeight: 900, clientHeight: 300 }
  const step = (name, change, follows) => {
    let tree = f.draw(); byClass(tree, 'chat-list').ref.current = element; f.flush(/follow\.current = true|scrollTop = /)
    // The person scrolls up to read.
    element.scrollTop = 100; byClass(tree, 'chat-list').props.onScroll({ currentTarget: element })
    change(); tree = f.draw(); byClass(tree, 'chat-list').ref.current = element; f.flush(/follow\.current = true|scrollTop = /)
    assert.equal(element.scrollTop, follows ? 900 : 100, name)
  }
  step('their own message', () => { f.state.chat = [...f.state.chat, { role: 'user', text: 'Second', at: 5 }] }, true)
  step('a streamed reply does not pull a reader down', () => { f.state.claude = { state: 'working', text: 'Partial' } }, false)
  step('a tool update does not either', () => { f.state.activity = [{ who: 'agent', text: 'Listing media', at: 6 }] }, false)
  step('a proposal waiting for a decision', () => { f.state.assistantReview = review({ proposal: { id: 'p1', runId: 'r1' } }) }, true)
  step('the apply in progress', () => { f.state.assistantReview = review({ applying: { id: 'p1', finished: false } }) }, true)
  step('the undo bar', () => { f.state.assistantReview = review({ change: { id: 'c1', kind: 'preview', edits: 1 } }) }, true)
  step('the end of the run, where an error would show', () => { f.state.claude = { state: 'error', text: 'Partial' } }, true)
})

test('a press in a scroll region gives focus back on release, so timeline shortcuts keep working', t => {
  const tree = panel(t).draw()
  const previous = globalThis.document
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous })
  for (const name of ['chat-list', 'assistant-composer-content']) {
    const region = byClass(tree, name), element = { blurred: 0, blur() { this.blurred++ } }, listeners = []
    assert.equal(String(region.props.tabIndex), '0', `${name} stays reachable by Tab so it can be scrolled from the keyboard`)
    assert.equal(region.props.onFocus, undefined, `${name}: focus from the keyboard is left alone`)
    globalThis.document = { activeElement: element, addEventListener: (type, run, options) => listeners.push({ type, run, options }) }
    region.props.onMouseDown({ currentTarget: element })
    assert.equal(element.blurred, 0, `${name}: focus stays for the length of the press`)
    assert.deepEqual(listeners.map(item => [item.type, item.options]), [['mouseup', { once: true, capture: true }]], name)
    listeners[0].run()
    assert.equal(element.blurred, 1, `${name}: released`)
    globalThis.document.activeElement = {}
    listeners[0].run()
    assert.equal(element.blurred, 1, `${name}: focus that moved on is not touched`)
  }
})

test('an open composer menu closes on a press elsewhere, on Send and when focus leaves it', async t => {
  const previous = globalThis.document, listeners = [], removed = []
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous })
  globalThis.document = { addEventListener: (type, run, capture) => listeners.push({ type, run, capture }), removeEventListener: (type, run, capture) => removed.push({ type, run, capture }), getElementById: () => null }
  const f = panel(t), tree = f.draw(), menus = [{ open: true }, { open: true }], queries = []
  const field = nodes(tree).find(node => node.type === 'textarea')
  field.ref.current = { focus() {}, closest: selector => selector === '.assistant-composer-card' ? { querySelectorAll: query => { queries.push(query); return menus } } : null }
  const [cleanup] = f.flush(/pointerdown/).filter(Boolean)
  assert.deepEqual(listeners.map(item => [item.type, item.capture]), [['pointerdown', true]], 'one capture-phase listener, so a press on the timeline counts')
  listeners[0].run({ target: { closest: () => menus[0] } })
  assert.deepEqual(menus.map(menu => menu.open), [true, false], 'a press inside a menu keeps that menu')
  menus[1].open = true
  listeners[0].run({ target: { closest: () => null } })
  assert.deepEqual(menus.map(menu => menu.open), [false, false])
  assert.deepEqual(queries.at(-1), '.assistant-input-tools details[open]')
  cleanup(); assert.deepEqual(removed, listeners, 'the listener leaves with the panel')
  for (const menu of menus) menu.open = true
  primary(tree)[0].props.onClick(); await tick()
  assert.deepEqual(menus.map(menu => menu.open), [false, false], 'Send closes them')
  assert.deepEqual(f.calls.map(call => call.route), ['/api/assistant/sharing', '/api/bridge/send'])
  const { model, tips } = composerControls(tree)
  for (const menu of [model, tips]) {
    const inside = {}, element = { open: true, contains: target => target === inside }
    menu.props.onFocusOut({ relatedTarget: inside, currentTarget: element }); assert.equal(element.open, true, 'focus moving within the menu')
    menu.props.onFocusOut({ relatedTarget: null, currentTarget: element }); assert.equal(element.open, true, 'a press on something that takes no focus is left to the pointer rule')
    menu.props.onFocusOut({ relatedTarget: {}, currentTarget: element }); assert.equal(element.open, false, 'focus moved to another control')
    assert.equal(menu.props.name, 'assistant-composer-menu', 'the two menus are exclusive')
  }
})

test('suggestions stay next to the field, also with history, and step aside for a waiting proposal', t => {
  const clips = [{ id: 'c1', kind: 'video', src: 'a.mp4', start: 0, dur: 4 }]
  const state = { selection: ['c1'], project: { width: 1920, height: 1080, assets: { 'a.mp4': { hasAudio: true } }, tracks: [{ id: 'V1', kind: 'video', clips }], comps: {} } }
  const last = tree => flatten(byClass(tree, 'chat-list').props.children).filter(node => node && typeof node === 'object').at(-1)
  const empty = panel(t, state, { draft: '' }).draw()
  assert.equal(last(empty).props.class, 'assistant-suggestions', 'the last thing above the field')
  const before = flatten(byClass(empty, 'chat-list').props.children).filter(node => node && typeof node === 'object').at(-2)
  assert.ok(cls(before, 'chat-empty')); assert.equal(text(before), 'Ask for an edit, or ask a question about this project.')
  assert.match(assistantCSS, /\.chat-list :is\(\.chat-empty, \.assistant-checking\) \{ margin-top: auto; \}/, 'the empty state sits at the bottom of the list, near the field')
  const history = { ...state, chat: [{ role: 'user', text: 'Earlier', at: 1 }, { role: 'assistant', text: 'Done.', at: 2 }] }
  assert.equal(last(panel(t, history, { draft: '' }).draw()).props.class, 'assistant-suggestions compact', 'one compact row once there is a conversation')
  assert.equal(byClass(panel(t, history, { draft: '' }).draw(), 'chat-empty'), undefined)
  assert.equal(byClass(panel(t, history).draw(), 'assistant-suggestions'), undefined, 'a draft replaces them')
  assert.equal(byClass(panel(t, state).draw(), 'chat-empty'), undefined, 'the sentence leaves once typing starts')
  const review = changes => ({ proposal: null, applying: null, change: null, running: false, runId: null, ...changes })
  assert.equal(byClass(panel(t, { ...history, assistantReview: review({ proposal: { id: 'p1', runId: 'r1' } }) }, { draft: '' }).draw(), 'assistant-suggestions'), undefined, 'Apply or Discard comes first')
  assert.equal(byClass(panel(t, { ...history, assistantReview: review({ applying: { id: 'p1', finished: false } }) }, { draft: '' }).draw(), 'assistant-suggestions'), undefined)
  assert.ok(byClass(panel(t, { ...history, assistantReview: review({ applying: { id: 'p1', finished: true } }) }, { draft: '' }).draw(), 'assistant-suggestions'))
})

test('the entry counts attached references and reads as the start of a request at wide widths', () => {
  const refs = [{ kind: 'clip', id: 'c1', label: 'c1' }, { kind: 'clip', id: 'c2', label: 'c2' }]
  assert.equal(text(byClass(entryOf(shell({ patch: { assistantStatus: ready, refs } })), 'assistant-entry-state')), 'Ready · 2 attached')
  assert.equal(text(byClass(entryOf(shell({ patch: { assistantStatus: ready } })), 'assistant-entry-state')), 'Ready')
  assert.match(assistantCSS, /\n\.assistant-entry-hint \{ display: none; \}/, 'narrow bars keep the label and state only')
  const wide = media(assistantCSS, '(min-width: 1280px)')
  assert.match(wide, /\.assistant-entry\[data-state="ready"\]:not\(\.on\) \.assistant-entry-hint \{ display: block;/, 'the hint shows when ready and closed')
  assert.match(wide, /\.topbar \.assistant-entry \{[^}]*cursor: text; \}/)
  assert.doesNotMatch(assistantCSS, /\.assistant-entry(?:-label|-state|-hint)?[^{},]*\{[^}]*(?:text-overflow|overflow:\s*hidden)/, 'no part of the entry is clipped')
})

test('the phone sheet minimizes to a one-line bar that keeps the draft, and every way in expands it', async t => {
  const f = panel(t, { chatOpen: true })
  let tree = f.draw()
  assert.equal(cls(tree, 'collapsed'), false)
  const minimize = byLabel(tree, 'Minimize assistant')
  assert.equal(minimize.props['aria-expanded'], true); assert.match(minimize.props.title, /Your draft is kept/)
  minimize.props.onClick()
  assert.equal(f.state.chatCollapsed, true); assert.equal(f.state.chatOpen, true)
  tree = f.draw()
  assert.ok(cls(tree, 'collapsed'))
  assert.equal(nodes(tree).find(node => node.type === 'textarea').props.value, 'Tighten the opening', 'the composer stays mounted with its draft')
  assert.ok(byClass(tree, 'chat-list'), 'the conversation stays mounted, so it keeps its scroll position')
  assert.equal(text(byClass(tree, 'chat-title')), 'Assistant Codex Draft kept', 'the bar is one line: name, state and the draft note')
  assert.equal(byClass(panel(t, { chatCollapsed: true }, { draft: '' }).draw(), 'chat-draft-note'), undefined)
  const expand = byLabel(tree, 'Expand assistant')
  assert.equal(expand.props['aria-expanded'], false)
  expand.props.onClick(); assert.equal(f.state.chatCollapsed, false)
  f.state.chatCollapsed = true
  byClass(f.draw(), 'chat-title').props.onClick(); assert.equal(f.state.chatCollapsed, false, 'tapping the bar expands it')
  assert.equal(byClass(f.draw(), 'chat-title').props.onClick, undefined, 'the title is not a control while expanded')
  f.state.chatCollapsed = true
  byLabel(f.draw(), 'Close assistant').props.onClick()
  assert.deepEqual([f.state.chatOpen, f.state.chatCollapsed], [false, false], 'Close leaves no stale detent for the next open')

  // The entry expands a minimized sheet and focuses the field once it is visible again.
  let focused = 0
  const context = shell({ document: { querySelector: () => ({ focus: () => focused++ }) }, microtask: queueMicrotask, patch: { assistantStatus: ready, chatOpen: true, chatCollapsed: true } })
  entryOf(context).props.onClick()
  assert.equal(context.store.chatCollapsed, false); assert.equal(focused, 0, 'the field is still hidden at this point')
  await tick(); assert.equal(focused, 1)
  assert.match(keys, /case '\/':\s*set\(\{ chatOpen: true, chatCollapsed: false \}\)/, 'the / shortcut expands it')
  assert.match(storeSource, /export function addRef\(ref\) \{[^]*?chatOpen: true, chatCollapsed: false \}\)\)/, 'attaching a reference expands it')
  assert.match(timelineSource, /Ask the Assistant about this clip…', run: \(\) => \{ addRef\([^;]*\); set\(\{ chatOpen: true, chatCollapsed: false \}\)/)
  assert.match(storeSource, /\n  chatCollapsed: false,/, 'expanded by default, and not a stored preference')
  assert.doesNotMatch(storeSource + app + read('ui/chat.js'), /(?:localStorage|sessionStorage)[^\n]*chatCollapsed|chatCollapsed[^\n]*(?:localStorage|sessionStorage)/)
  assert.match(app, /class=\$\{`app \$\{s\.chatOpen \? 'chat-open' : ''\}\$\{s\.chatOpen && s\.chatCollapsed \? ' chat-collapsed' : ''\}`\}/)

  assert.match(assistantCSS, /\n\.chat-head \.chat-collapse \{ display: none; \}/, 'side panels have no minimize control')
  const detent = media(assistantCSS, '(max-width: 720px) and (orientation: portrait), (max-width: 720px) and (min-height: 501px)')
  assert.match(detent, /\.chat-head \.chat-collapse \{ display: inline-grid;/)
  assert.match(detent, /\.main > \.chat\.panel\.collapsed \{ overflow: hidden; transform: translateY\(calc\(100% - 54px - env\(safe-area-inset-bottom\)\)\); \}/, 'the sheet slides down and keeps its size')
  assert.match(detent, /\.chat\.collapsed > :not\(\.chat-head\), \.chat\.collapsed \.chat-settings \{ visibility: hidden; \}/, 'hidden content takes no focus and is not read out')
  assert.match(detent, /\.app\.chat-collapsed \.main \{ padding-bottom: calc\(54px \+ env\(safe-area-inset-bottom\)\); \}/, 'the page ends above the bar')
  assert.doesNotMatch(detent, /display:\s*none/, 'nothing is unmounted from layout')
  const phone = media(assistantCSS, '(max-width: 720px)')
  assert.equal(phone.split('.app.chat-open:not(.chat-collapsed):has(.assistant-composer-card)').length - 1, 2, 'the viewer gets its full height and controls back while minimized')
  assert.equal(media(assistantCSS, '(max-width: 359px)').split('.app.chat-open:not(.chat-collapsed):has(.assistant-composer-card)').length - 1, 1)
  assert.match(media(assistantCSS, '(prefers-reduced-motion: reduce)'), /\.main > \.chat\.panel \{ transition: none; \}/)
})

test('touch targets inside the conversation are 44px tall without growing their rows', () => {
  const touch = media(assistantCSS, '(pointer: coarse), (max-width: 720px)')
  assert.match(touch, /\.chat :is\(\.assistant-tool-card summary, \.change-receipt > summary, \.receipt-json > summary, \.assistant-preview-details > summary\) \{ padding-block: 15px; \}/)
  assert.match(touch, /\.chat \.assistant-primary-action button \{ width: 44px; min-width: 44px; height: 44px; \}/, 'Send and Stop are the same size, so nothing moves when a run starts or ends')
  assert.match(assistantCSS, /\.chat \.assistant-primary-action button \{[^}]*width: 32px; min-width: 32px; height: 32px; min-height: 32px;/)
  assert.match(touch, /\.chat-list \.msg\.user \.assistant-edit-request \{ min-height: 44px;/)
  assert.match(assistantCSS, /\.chat \.composer textarea::placeholder \{ color: var\(--muted\); opacity: 1; \}/, 'the placeholder meets contrast')
  assert.match(media(assistantCSS, '(max-width: 900px)'), /\.main > \.chat\.panel \{ position: fixed; width: min\(var\(--chat-width, 360px\), max\(38vw, 320px\)\); \}/, 'the floating panel never drops under 320px')
})

// ---- Round 3. One test for each problem the three reviews of the last round reported.

test('the status poll waits for its answer, so a server slower than the interval is still heard', async () => {
  const strip = source => source.replace(/^import .*$/gm, '')
  const state = { project: null, page: 'media', assistantStatus: { provider: 'codex', configured: false, loading: true, checkedAt: null } }
  const requests = [], timers = []
  const { refreshAssistantStatus } = new Function('api', 'set', `${strip(read('ui/assistant-status.js')).replace(/^export /gm, '')}\nreturn { refreshAssistantStatus }`)(() => new Promise((resolve, reject) => requests.push({ resolve, reject })), patch => Object.assign(state, patch))
  const mount = () => {
    const effects = []
    new Function('h', 'htm', 'useEffect', 'useStore', 'useLayout', 'layoutStyle', 'Divider', 'ChatPanel', 'Settings', 'AssistantSharingReview', 'refreshAssistantStatus', 'setInterval', 'clearInterval', `const host = { kind: "http" };\n${strip(app).replace('export async function mountApp', 'async function mountApp')}\nreturn App()`)(
      h, htm, (run, deps) => effects.push({ run, deps }), () => state, () => ({}), () => ({}), () => null, () => null, () => null, () => null, refreshAssistantStatus, (run, ms) => timers.push({ run, ms }), id => { timers[id - 1].cleared = true })
    return effects.find(effect => /refreshAssistantStatus\(\)/.test(String(effect.run)))
  }
  const first = mount(), stop = first.run()
  assert.deepEqual(first.deps, [true]); assert.equal(timers[0].ms, 1000, 'the first check is asked again every second')
  assert.equal(requests.length, 1, 'it asks at once')
  for (let i = 0; i < 3; i++) timers[0].run()
  assert.equal(requests.length, 1, 'no second request starts while the first is unanswered')
  requests[0].resolve(ready); await tick()
  assert.equal(state.assistantStatus, ready, 'the slow answer is kept, not dropped for a newer request')
  timers[0].run(); assert.equal(requests.length, 2, 'the next tick asks again')
  requests[1].reject(new Error('offline')); await tick()
  assert.equal(state.assistantStatusError, 'offline')
  timers[0].run(); assert.equal(requests.length, 3, 'a failed request frees the poll as well')
  stop(); assert.equal(timers[0].cleared, true)
  Object.assign(state, { assistantStatus: ready, assistantStatusError: '' })
  const later = mount(); later.run()
  assert.deepEqual(later.deps, [false]); assert.equal(timers[1].ms, 4000)
})

test('the history warning and the plugin note sit above the conversation, outside its scroll area', t => {
  const chat = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `Message ${i}`, at: i + 1 }))
  const tree = panel(t, { chat, chatHistory: { warning: 'Chat history could not be saved.' }, caps: { assistant: { pluginSession: true } } }).draw()
  const children = flatten(tree.props.children).filter(node => node && typeof node === 'object')
  const at = name => children.findIndex(node => cls(node, name))
  const notice = children.findIndex(node => node.type?.name === 'AssistantHistoryNotice')
  assert.ok(at('chat-head') === 0 && notice > 0 && notice < at('chat-list'), 'the warning is between the header and the list')
  assert.equal(children[notice].props.status.warning, 'Chat history could not be saved.')
  assert.ok(at('assistant-plugin-note') > notice && at('assistant-plugin-note') < at('chat-list'), 'the plugin note follows it')
  assert.match(text(children[at('assistant-plugin-note')]), /^Typing here starts a separate .* run\. To use this Claude session, ask in the terminal\.$/)
  assert.equal(nodes(byClass(tree, 'chat-list')).some(node => node.type?.name === 'AssistantHistoryNotice' || cls(node, 'assistant-plugin-note')), false, 'a long conversation cannot scroll them away')
  assert.match(assistantCSS, /\n\.chat > :is\(\.assistant-route-preview, \.assistant-plugin-note\) \{ flex: none; margin: 0; padding: 6px 12px; border-bottom: 1px solid var\(--line\); \}/)
  assert.doesNotMatch(assistantCSS, /\.chat-list \.assistant-plugin-note/)
})

test('a setup card, a sign-in wait, the first check or the ChatGPT welcome that arrives under a long conversation is scrolled into view', t => {
  const chat = [{ role: 'user', text: 'First', at: 1 }, { role: 'assistant', text: 'Done.', at: 2 }]
  const unset = { provider: 'codex', mode: 'manual', configured: false, providers: [{ id: 'codex', installed: false, authenticated: false, available: false, reason: 'Install Codex.' }] }
  const stale = { provider: 'codex', configured: false, mode: 'auto', autoPreview: { ok: false, blocked: [{ reason: 'The model catalog needs a refresh.' }] } }
  const arrive = (before, after) => {
    const f = panel(t, { chat, assistantStatus: before }, { draft: '' })
    const element = { scrollTop: 0, scrollHeight: 900, clientHeight: 300 }
    let tree = f.draw(); byClass(tree, 'chat-list').ref.current = element; f.flush(/follow\.current = true|scrollTop = /)
    // The person scrolls up to read.
    element.scrollTop = 100; byClass(tree, 'chat-list').props.onScroll({ currentTarget: element })
    f.state.assistantStatus = after; tree = f.draw(); byClass(tree, 'chat-list').ref.current = element; f.flush(/follow\.current = true|scrollTop = /)
    return { top: element.scrollTop, last: flatten(byClass(tree, 'chat-list').props.children).filter(node => node && typeof node === 'object' && !cls(node, 'assistant-suggestions')).at(-1) }
  }
  for (const [name, after, shown] of [
    ['not set up', unset, 'assistant-setup'],
    ['needs refresh', stale, 'assistant-setup'],
    ['waiting for sign-in', { ...unset, chatgpt: account({ attempt: { state: 'waiting', message: '', startURL: null } }) }, 'assistant-setup'],
    ['the first check', { ...unset, loading: true, checkedAt: null }, 'assistant-checking'],
    ['the ChatGPT welcome', { ...ready, provider: 'chatgpt', chatgpt: signedIn({ welcome: true }) }, 'chatgpt-welcome'],
  ]) {
    const result = arrive(ready, after)
    assert.equal(result.top, 900, name)
    assert.ok(cls(result.last, shown), `${name}: it is the last card in the list, next to the field`)
  }
  assert.equal(arrive(unset, { ...unset, chatgpt: account({ attempt: { state: 'waiting', message: '', startURL: null } }) }).top, 900, 'a sign-in that starts from the setup card')
  assert.equal(arrive({ ...ready, provider: 'chatgpt', chatgpt: signedIn() }, { ...ready, provider: 'chatgpt', chatgpt: signedIn({ welcome: true }) }).top, 900, 'the welcome on an account that was already signed in')
  assert.equal(arrive(ready, { ...ready, model: 'other' }).top, 100, 'a ready assistant leaves a reader where they are')
  assert.equal(arrive(ready, { ...ready, chatgpt: signedIn() }).top, 100, 'so does an account with no welcome to show')
})

test('the list keeps its end in view when the pinned history warning takes a line from it', t => {
  const f = panel(t, { chat: [{ role: 'user', text: 'First', at: 1 }] })
  const element = { scrollTop: 0, scrollHeight: 900, clientHeight: 300 }
  let tree = f.draw(); byClass(tree, 'chat-list').ref.current = element; f.flush(/follow\.current = true|scrollTop = /)
  element.scrollHeight = 946
  f.state.chatHistory = { warning: 'Chat history could not be saved.' }; tree = f.draw(); byClass(tree, 'chat-list').ref.current = element; f.flush(/follow\.current = true|scrollTop = /)
  assert.equal(element.scrollTop, 946)
})

test('the setup card names the signed-in ChatGPT account', t => {
  const unset = { provider: 'codex', mode: 'manual', configured: false, providers: [{ id: 'codex', installed: false, authenticated: false, available: false, reason: 'Install Codex.' }] }
  const says = status => text(nodes(byClass(panel(t, { assistantStatus: status }).draw(), 'assistant-setup')).find(node => node.type === 'p'))
  assert.equal(says({ ...unset, chatgpt: signedIn() }), 'Signed in to ChatGPT as sam@example.com.')
  assert.equal(says({ ...unset, chatgpt: signedIn({ planUsage: false }) }), 'Signed in to ChatGPT as sam@example.com. Plan usage is off for this sign-in.')
  assert.equal(says({ ...unset, chatgpt: signedIn({ email: '' }) }), 'Signed in to ChatGPT as your account.')
  assert.equal(says({ ...unset, chatgpt: account() }), 'Use your ChatGPT plan for eligible requests. You can keep editing without an account.')
})

test('a sign-in that is waiting keeps Refresh when the selected provider needs one', async t => {
  const reason = 'The selected account session expired. Sign in again.'
  const attempt = { state: 'waiting', message: '', startURL: 'https://auth.example/start' }
  const failing = { provider: 'codex', mode: 'manual', configured: false, reason, chatgpt: account({ attempt }), providers: [{ id: 'codex', installed: true, authenticated: false, available: false, reason }] }
  const stale = { provider: 'codex', configured: false, mode: 'auto', chatgpt: account({ attempt }), autoPreview: { ok: false, blocked: [{ reason: 'The model catalog needs a refresh.' }] } }
  for (const [status, label] of [[failing, 'Refresh status'], [stale, 'Refresh availability']]) {
    const f = panel(t, { assistantStatus: status }), card = byClass(f.draw(), 'assistant-setup')
    const buttons = nodes(card).filter(node => node.type === 'button')
    assert.deepEqual(buttons.map(text), ['Cancel sign-in', label, 'Other ways to connect'])
    assert.deepEqual(nodes(card).filter(node => cls(node, 'primary')).map(text), ['Open the sign-in page ↗'], 'the sign-in page stays the one primary action')
    await buttons[1].props.onClick()
    assert.deepEqual(f.calls.map(call => call.route), ['refresh'])
  }
  const off = nodes(byClass(panel(t, { assistantStatus: failing, claude: { state: 'working' } }).draw(), 'assistant-setup')).find(node => node.type === 'button' && text(node) === 'Refresh status')
  assert.equal(off.props.disabled, true, 'off while a request runs, like Refresh on the card without a sign-in')
})

test('the entry only opens the conversation, so it does not claim an expanded state', async () => {
  let focused = 0
  const context = shell({ document: { querySelector: () => ({ focus: () => focused++ }) }, patch: { assistantStatus: ready } })
  assert.equal('aria-expanded' in entryOf(context).props, false); assert.equal(entryOf(context).props['aria-controls'], undefined)
  entryOf(context).props.onClick()
  assert.equal(context.store.chatOpen, true); assert.equal(entryOf(context).props['aria-controls'], 'editor-assistant')
  entryOf(context).props.onClick()
  assert.equal(context.store.chatOpen, true, 'a second press returns to the field. Close is in the panel')
  assert.equal('aria-expanded' in entryOf(context).props, false)
  assert.equal(focused, 2)
})

test('a lost connection says a request may still be running only while one is', t => {
  const run = patch => text(byClass(panel(t, { connected: false, ...patch }).draw(), 'assistant-run'))
  assert.equal(run({}), '↻ Reconnecting Live status is unavailable.')
  assert.match(run({ claude: { state: 'working', startedAt: 1000 } }), /^↻ Reconnecting .*Live status is unavailable\. The request may still be running\.$/)
})

test('the media type filter has an accessible name', () => {
  const selects = [...read('ui/browser.js').matchAll(/<select\b[^>]*>/g)].map(match => match[0])
  assert.ok(selects.some(tag => /aria-label="Media type" value=\$\{kind\}/.test(tag)))
  for (const tag of selects) assert.match(tag, /aria-label=|id=/, `a select without a name: ${tag.slice(0, 80)}`)
})

test('a focused suggestion in the one-line strip is scrolled into view, and the strip fades where it continues', t => {
  const clips = [{ id: 'c1', kind: 'video', src: 'a.mp4', start: 0, dur: 4 }]
  const tree = panel(t, { selection: ['c1'], chat: [{ role: 'user', text: 'Earlier', at: 1 }], project: { width: 1920, height: 1080, assets: { 'a.mp4': { hasAudio: true } }, tracks: [{ id: 'V1', kind: 'video', clips }], comps: {} } }, { draft: '' }).draw()
  const chips = nodes(byClass(tree, 'assistant-suggestions')).filter(node => node.type === 'button')
  assert.ok(chips.length > 0)
  for (const chip of chips) { let seen; chip.props.onFocus({ currentTarget: { scrollIntoView: options => { seen = options } } }); assert.deepEqual(seen, { block: 'nearest', inline: 'nearest' }) }
  const strip = assistantCSS.match(/\n\.chat-list \.assistant-suggestions\.compact \{[^}]*\}/)[0]
  assert.match(strip, /flex-wrap: nowrap;/); assert.match(strip, /overflow-x: auto;/); assert.match(strip, /padding: 4px 28px 4px 4px;/); assert.match(strip, /scroll-padding-inline: 4px 28px;/)
  assert.match(strip, /[^-]mask-image: linear-gradient\(90deg, #000 calc\(100% - 28px\), transparent\);/)
  assert.doesNotMatch(assistantCSS, /@media \(max-height: 520px\) \{[^@]*assistant-suggestions/, 'a short desktop window keeps the row')
  assert.match(media(assistantCSS, '(max-height: 500px) and (max-width: 1000px) and (orientation: landscape)'), /\.chat-list \.assistant-suggestions\.compact \{ display: none; \}/, 'a phone on its side has about two lines of conversation, so the row steps aside there')
})

test('phone, larger-text and short-window layouts keep Send, the header controls and the conversation on screen', () => {
  const phone = media(assistantCSS, '(max-width: 720px)')
  assert.match(phone, /\.main > \.chat\.panel:not\(\.assistant-unavailable\) \{ height: auto; min-height: min\(62dvh, calc\(100dvh - var\(--topbar-height\) - 6px\)\); max-height: calc\(100dvh - var\(--topbar-height\) - 6px\); \}/, 'larger text grows the sheet up to the top bar')
  assert.match(phone, /\.assistant-entry-state \{ min-width: min\(8\.2ch, 16vw\); \}/, 'Ready and Working take the same width')
  assert.match(media(assistantCSS, '(max-width: 720px) and (min-height: 521px)'), /\.chat \.assistant-field \.composer textarea \{ max-height: min\(4lh, 20dvh\); \}/, 'a long draft scrolls inside four lines')
  assert.match(media(assistantCSS, '(pointer: coarse) and (min-height: 521px)'), /\.chat \.assistant-field \.composer textarea \{ min-height: 44px; \}/, 'the empty field is a full touch target')
  const landscape = media(assistantCSS, '(max-height: 500px) and (max-width: 1000px) and (orientation: landscape)')
  assert.match(landscape, /\.main > \.chat\.panel:not\(\.assistant-unavailable\) \{ min-height: 0; max-height: none; \}/, 'the side panel keeps its own height')
  const fine = media(assistantCSS, '(max-height: 400px) and (pointer: fine)')
  assert.match(fine, /\.chat :is\(\.chat-head button, [^{]*\.assistant-preview-actions button, \.assistant-change button\) \{ min-height: 30px; \}/, 'a zoomed desktop window does not get touch-sized rows')
  assert.match(fine, /\.chat \.assistant-primary-action button \{ width: 32px; min-width: 32px; height: 32px; \}/)
  assert.doesNotMatch(fine, /assistant-suggestion|receipt-actions|edit-request/, 'only the fixed rows shrink')
  const tight = media(assistantCSS, '(max-width: 379px), (max-height: 500px) and (max-width: 1000px) and (orientation: landscape)')
  assert.match(tight, /\.chat \.assistant-input-tools \{ gap: 0; font-size: \.92em; \}/, 'the 320px landscape side panel gets the tight bar too')
  assert.match(tight, /\.chat \.assistant-input-kind select \{ padding-inline: 5px 18px; \}/)
  const narrow = media(assistantCSS, '(max-width: 359px)')
  assert.doesNotMatch(narrow, /min-width: 36px/, 'the tips button stays 44px wide')
  assert.match(narrow, /\.assistant-entry-state \{ overflow-wrap: anywhere; \}/)
  assert.match(media(assistantCSS, '(max-width: 480px)'), /\.assistant-entry-state \{ flex: 0 1 auto; line-height: 1\.12; white-space: normal; \}/, 'larger text wraps the state before the entry runs off the screen')
  const detent = media(assistantCSS, '(max-width: 720px) and (orientation: portrait), (max-width: 720px) and (min-height: 501px)')
  assert.match(detent, /\.chat\.collapsed \.chat-head \{ box-sizing: border-box; height: 54px; overflow: hidden; border-bottom-color: transparent; \}/, 'the minimized bar is 54px at any text size')
  assert.match(detent, /\.chat\.collapsed \.chat-title \{ flex-wrap: nowrap; align-self: stretch; overflow: hidden; white-space: nowrap; cursor: pointer; \}/)
  assert.match(detent, /\.chat\.collapsed \.chat-title > :not\(\.claude-dot\) \{ flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/)
  assert.match(assistantCSS, /\n\.chat-title > b \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/, 'the title gives way to Settings')
  assert.match(assistantCSS, /\n\.chat \.assistant-input-tools > :is\(\.assistant-model-menu, \.assistant-input-help\) \{ flex: none; margin: 0; \}/, 'the Model label is never squeezed under the next control')
  assert.match(assistantCSS, /\n\.assistant-model-popover \{\s*position: absolute; z-index: 2; bottom: 100%; inset-inline: 10px; max-height: min\(46dvh, 16rem\);/, 'the Model menu shows its controls at 521px to 675px heights')
  assert.match(assistantCSS, /\n\.chat \.assistant-field \{[^}]*border: 1px solid #6f7a5f;/, 'the field edge is 3:1 against the panel')
  assert.match(assistantCSS, /@media \(max-height: 520px\) \{\s*\.chat-head \{ padding-block: 0; \}\s*\.chat > :is\(\.assistant-route-preview, \.assistant-plugin-note\) \{ padding-block: 2px; font-size: 11px; line-height: 1\.25; \}/, 'both pinned notices leave room for Send in a short window')
  assert.match(baseCSS, /font: 11px ui-monospace, Menlo, monospace;/)
})

// ---- Tests the round 2 mutation review found missing.

test('entry focus selector names the hosted link as well as the field', async () => {
  const selectors = []
  const context = shell({ document: { querySelector: selector => { selectors.push(selector); return { focus() {} } } }, patch: { chatOpen: true } })
  entryOf(context).props.onClick()
  assert.equal(selectors[0], '#editor-assistant :is(textarea, .assistant-setup a.primary)')
})

test('the entry reads capabilities for its status only on the native host', () => {
  const state = patch => text(byClass(entryOf(shell({ patch })), 'assistant-entry-state'))
  assert.equal(state({ caps: { assistant: ready } }), 'Checking', 'a browser server status has not arrived yet')
  assert.equal(state({ caps: { host: 'native', assistant: ready } }), 'Ready')
})

test('the list follows the undo bar when it arrives on its own', t => {
  const review = changes => ({ proposal: null, applying: null, change: null, running: false, runId: null, ...changes })
  // Both are states agent/assistant-review.mjs publishes: finishApply with a failed step keeps `applying` and adds `change`;
  // a request sent without Preview changes gets its `change` when the run has already ended.
  for (const [name, claude, before, after] of [
    ['an apply that failed after some steps', { state: 'idle' }, review({ applying: { id: 'p1', finished: false } }), review({ applying: { id: 'p1', finished: true, error: 'Step 2 failed.' }, change: { id: 'c1', kind: 'preview', runId: null, edits: 1 } })],
    ['a committed request whose change arrives after the run ended', { state: 'done', runId: 'r1' }, review(), review({ change: { id: 'c1', kind: 'request', runId: 'r1', edits: 1 } })],
  ]) {
    const f = panel(t, { claude, chat: [{ role: 'user', text: 'First', at: 1 }], assistantReview: before })
    const element = { scrollTop: 0, scrollHeight: 900, clientHeight: 300 }
    let tree = f.draw(); byClass(tree, 'chat-list').ref.current = element; f.flush(/follow\.current = true|scrollTop = /)
    element.scrollTop = 100; byClass(tree, 'chat-list').props.onScroll({ currentTarget: element })
    f.state.assistantReview = after; tree = f.draw(); byClass(tree, 'chat-list').ref.current = element; f.flush(/follow\.current = true|scrollTop = /)
    assert.equal(element.scrollTop, 900, name)
  }
})

test('Return closes an open composer menu before it sends', async t => {
  const previous = globalThis.document
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous })
  globalThis.document = { addEventListener() {}, removeEventListener() {}, getElementById: () => null }
  const f = panel(t), tree = f.draw(), menus = [{ open: true }, { open: true }]
  const field = nodes(tree).find(node => node.type === 'textarea')
  field.ref.current = { focus() {}, closest: selector => selector === '.assistant-composer-card' ? { querySelectorAll: () => menus } : null }
  field.props.onKeyDown({ key: 'Enter', stopPropagation() {}, preventDefault() {} }); await tick()
  assert.deepEqual(menus.map(menu => menu.open), [false, false])
  assert.deepEqual(f.calls.map(call => call.route), ['/api/assistant/sharing', '/api/bridge/send'])
})

const unset = { provider: 'codex', mode: 'manual', configured: false, providers: [{ id: 'codex', installed: false, authenticated: false, available: false, reason: 'Install Codex.' }] }
test('a sign-in that is exchanging its code is not shown as Checking', t => {
  const status = { ...unset, loading: true, checkedAt: null, chatgpt: account({ attempt: { state: 'exchanging', message: '', startURL: null } }) }
  assert.equal(assistantState(status).checking, false)
  const tree = panel(t, { assistantStatus: status }).draw()
  assert.equal(byClass(tree, 'assistant-checking'), undefined)
  assert.match(text(byClass(tree, 'assistant-setup')), /Waiting for ChatGPT sign-in/)
})

test('a refresh state without ChatGPT on this server still links to Assistant settings', t => {
  const stale = { provider: 'codex', configured: false, mode: 'auto', autoPreview: { ok: false, blocked: [{ reason: 'The model catalog needs a refresh.' }] } }
  const reason = 'The selected account session expired. Sign in again.'
  const failing = { provider: 'codex', mode: 'manual', configured: false, reason, providers: [{ id: 'codex', installed: true, authenticated: false, available: false, reason }] }
  for (const [status, first] of [[stale, 'Refresh availability'], [failing, 'Refresh status']]) {
    const f = panel(t, { assistantStatus: status }), buttons = nodes(byClass(f.draw(), 'assistant-setup')).filter(node => node.type === 'button')
    assert.deepEqual(buttons.map(text), [first, 'Assistant settings'])
    buttons[1].props.onClick(); assert.equal(f.state.settingsOpen, true); assert.notEqual(f.state.settingsOtherWays, true)
  }
})

test('setup actions are off while a request runs, and Refresh is off without a connection', t => {
  const reason = 'The selected account session expired. Sign in again.'
  const failing = chatgpt => ({ provider: 'codex', mode: 'manual', configured: false, reason, chatgpt, providers: [{ id: 'codex', installed: true, authenticated: false, available: false, reason }] })
  const buttons = (status, patch) => Object.fromEntries(nodes(byClass(panel(t, { assistantStatus: status, ...patch }).draw(), 'assistant-setup')).filter(node => node.type === 'button').map(node => [text(node), Boolean(node.props.disabled)]))
  assert.deepEqual(buttons(failing(account()), { claude: { state: 'working' } }), { 'Refresh status': true, 'Continue with ChatGPT': true, 'Other ways to connect': false })
  assert.deepEqual(buttons(failing(account()), { connected: false }), { 'Refresh status': true, 'Continue with ChatGPT': false, 'Other ways to connect': false })
  assert.deepEqual(buttons({ ...failing(account()), loading: true, checkedAt: 1 }, {}), { 'Refreshing…': true, 'Continue with ChatGPT': false, 'Other ways to connect': false })
  assert.deepEqual(buttons({ ...unset, chatgpt: account() }, { claude: { state: 'working' } }), { 'Continue with ChatGPT': true, 'Other ways to connect': false })
})

test('waiting for sign-in offers the sign-in page as the one primary link', t => {
  const waiting = url => ({ ...unset, chatgpt: account({ attempt: { state: 'waiting', message: '', startURL: url } }) })
  const card = byClass(panel(t, { assistantStatus: waiting('https://auth.example/start') }).draw(), 'assistant-setup')
  const link = nodes(card).find(node => node.type === 'a')
  assert.equal(text(link), 'Open the sign-in page ↗'); assert.equal(link.props.href, 'https://auth.example/start'); assert.ok(cls(link, 'primary'))
  assert.equal(nodes(byClass(panel(t, { assistantStatus: waiting(null) }).draw(), 'assistant-setup')).some(node => node.type === 'a'), false)
})

test('every CSS variable used without a fallback is defined', () => {
  const sheets = fs.readdirSync(new URL('../web/ui/', import.meta.url)).filter(name => name.endsWith('.css')).map(name => [name, read(`ui/${name}`)]).concat([['styles.css', baseCSS]])
  const scripts = fs.readdirSync(new URL('../web/ui/', import.meta.url)).filter(name => name.endsWith('.js')).map(name => read(`ui/${name}`)).join('\n')
  const defined = new Set([...sheets.map(item => item[1]).join('\n').matchAll(/(--[\w-]+)\s*:/g), ...scripts.matchAll(/['"`](--[\w-]+)['"`]?\s*[:,]/g), ...scripts.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]))
  for (const [name, css] of sheets) assert.deepEqual([...new Set([...css.matchAll(/var\((--[\w-]+)\s*\)/g)].map(match => match[1]))].filter(item => !defined.has(item)), [], `${name} uses an undefined variable`)
})

test('composer menus open above the field unless the window is 520px tall or shorter', () => {
  assert.match(assistantCSS, /@media \(min-height: 521px\) \{\s*\.chat \.assistant-composer-card \{ position: relative; \}\s*\}/)
  assert.match(assistantCSS, /@media \(max-height: 520px\) \{\s*\.assistant-model-popover \{ top: 46px; bottom: auto;/)
})

test('a proposal or a run without an id still shows the preview sentence', t => {
  const review = changes => ({ proposal: null, applying: null, change: null, running: false, runId: null, ...changes })
  const lines = state => nodes(byClass(panel(t, state).draw(), 'assistant-run')).filter(node => node.type === 'p').map(text)
  assert.deepEqual(lines({ claude: { state: 'done', runId: 'r1', outcome: PREVIEW_OUTCOME }, assistantReview: review({ proposal: { id: 'p1' } }) }), [PREVIEW_OUTCOME], 'a proposal with no run id')
  assert.deepEqual(lines({ claude: { state: 'done', outcome: PREVIEW_OUTCOME }, assistantReview: review({ proposal: { id: 'p1', runId: 'r1' } }) }), [PREVIEW_OUTCOME], 'a run with no id')
})

test('after Stop, an applied preview from the same run is not called a committed edit of this request', t => {
  const stopped = { state: 'cancelled', runId: 'r1', startedAt: 1000, finishedAt: 13000 }
  const run = byClass(panel(t, { claude: stopped, assistantReview: { proposal: null, applying: null, change: { id: 'c1', kind: 'preview', runId: 'r1', edits: 2 }, running: false, runId: null } }).draw(), 'assistant-run')
  assert.equal(text(run), '■ Stopped 12s')
})

test('each ChatGPT setup action passes the same arguments to the sign-in flow', async t => {
  const reason = 'The selected account session expired. Sign in again.'
  const failing = chatgpt => ({ provider: 'codex', mode: 'manual', configured: false, reason, chatgpt, providers: [{ id: 'codex', installed: true, authenticated: false, available: false, reason }] })
  const press = async (status, label) => { const f = panel(t, { assistantStatus: status }); await nodes(byClass(f.draw(), 'assistant-setup')).find(node => node.type === 'button' && text(node) === label).props.onClick(); return f.calls }
  for (const make of [failing, chatgpt => ({ ...unset, chatgpt })]) {
    assert.deepEqual(await press(make(account()), 'Continue with ChatGPT'), [{ route: 'sign-in', body: [{}] }])
    assert.deepEqual(await press(make(signedIn({ planUsage: false })), 'Turn on ChatGPT plan usage'), [{ route: 'sign-in', body: [{ account: 'a1', enablePlan: true }] }])
    const status = make(signedIn()), calls = await press(status, 'Use ChatGPT')
    assert.equal(calls.length, 1); assert.equal(calls[0].route, 'use-chatgpt'); assert.equal(calls[0].body[0], status)
  }
  const selected = { provider: 'chatgpt', mode: 'manual', configured: false, reason: 'ChatGPT is not available right now.', chatgpt: signedIn() }
  assert.deepEqual(nodes(byClass(panel(t, { assistantStatus: selected }).draw(), 'assistant-setup')).filter(node => node.type === 'button').map(text), ['Assistant settings', 'Other ways to connect'], 'no Use ChatGPT when it is already the provider')
})

test('the reconnect note is only for an assistant that is ready', t => {
  assert.equal(byClass(panel(t, { connected: false, assistantStatus: { provider: 'codex', configured: false } }).draw(), 'assistant-send-reason'), undefined)
})

test('a finished run that lost its connection keeps its reconnecting notice in view', t => {
  const review = { proposal: null, applying: null, change: null, running: false, runId: null }
  const run = byClass(panel(t, { connected: false, claude: { state: 'done', runId: 'r1', outcome: PREVIEW_OUTCOME }, assistantReview: review }).draw(), 'assistant-run')
  assert.equal(cls(run, 'silent'), false)
  assert.match(text(run), /Reconnecting\. Showing the last confirmed result\./)
})

test('every icon the assistant panel and the entry name is drawn', () => {
  for (const source of [read('ui/chat.js'), app.match(/function TopBar\([^]*?\n}\n/)[0]]) {
    const names = new Set([...source.matchAll(/<\$\{Icon\} name="([a-z-]+)"/g)].map(match => match[1]))
    for (const expression of source.matchAll(/<\$\{Icon\} name=\$\{([^}]*)\}/g)) for (const literal of expression[1].matchAll(/'([a-z-]+)'/g)) names.add(literal[1])
    assert.ok(names.size > 0)
    for (const name of names) assert.notEqual(Icon({ name }), null, `icon "${name}" is not drawn`)
  }
})

test('after Stop, a change with no run id is not counted for a run with no id', t => {
  const run = byClass(panel(t, { claude: { state: 'cancelled', startedAt: 1000, finishedAt: 13000 }, assistantReview: { proposal: null, applying: null, change: { id: 'c1', kind: 'request', edits: 2 }, running: false, runId: null } }).draw(), 'assistant-run')
  assert.equal(text(run), '■ Stopped 12s')
})

test('the Send tooltip names the key that sends for the input kind', t => {
  const title = kind => { const f = panel(t); f.state.assistantDraft = { ...f.state.assistantDraft, inputKind: kind }; return primary(f.draw())[0].props.title }
  assert.equal(title('prompt'), 'Send (Return)')
  assert.equal(title('script'), 'Send (⌘Return)')
  assert.equal(title('screenplay'), 'Send (⌘Return)')
})

test('the layout fixes outside the panel stay in the stylesheets', () => {
  assert.match(baseCSS, /@media \(max-width: 720px\) \{\s*\.deliver-preset-picker \{ display: grid;/)
  assert.doesNotMatch(baseCSS, /@container delivery-workspace[^{]*\{\s*\.deliver-preset-picker/)
  assert.match(baseCSS, /\.settings-nav \{ display: flex; flex-flow: row wrap; gap: 4px; max-height: none; overflow: visible; \}/)
  assert.match(baseCSS, /\.modal\.keys \{ width: min\(880px, 94vw\); max-height: min\(96dvh, 860px\); \}/)
  assert.match(phoneCSS, /\.page\.phone-edit \.tl-toolbar \{[^}]*padding-right: 48px;[^}]*mask-image: linear-gradient\(to right, #000 calc\(100% - 48px\), transparent\); \}/)
  assert.match(baseCSS, /\.welcome-formats button\.ghost \{ border-color: var\(--line-2\); \}/)
  assert.doesNotMatch(baseCSS + assistantCSS, /\.chat-head[^{},]*\.muted[^{}]*\{[^}]*text-overflow/)
  assert.match(keys, /\['\/', 'Ask Arya'\]/)
})

test('a stale catalog that is being rechecked for the first time says Needs refresh, not Checking', () => {
  const stale = { provider: 'codex', configured: false, mode: 'auto', loading: true, checkedAt: null, autoPreview: { ok: false, blocked: [{ reason: 'The model catalog needs a refresh.' }] } }
  const state = assistantState(stale)
  assert.equal(state.refreshRequired, true); assert.equal(state.checking, false)
  assert.equal(text(byClass(entryOf(shell({ patch: { assistantStatus: stale } })), 'assistant-entry-state')), 'Needs refresh')
})
