import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { h } from 'preact'
import htm from 'htm'

const editor = process.env.ARYA_TEST_EDITOR_ROOT ? pathToFileURL(process.env.ARYA_TEST_EDITOR_ROOT + '/') : new URL('../', import.meta.url)
const { assistantActivity } = await import(new URL('web/ui/assistant-activity.js', editor))
const { assistantState, assistantPrompt, providerName } = await import(new URL('web/ui/assistant-state.js', editor))
const { createAssistantSharingGate } = await import(new URL('web/ui/assistant-sharing.js', editor))
const { assistantPanel } = await import(new URL('web/ui/assistant-panel.js', editor))
const { assistantDraft, updatedAssistantDraft, assistantDraftContext, assistantDraftIsCurrent, createAssistantScriptImport } = await import(new URL('web/ui/assistant-script.js', editor))
const { Icon } = await import(new URL('web/ui/icons.js', editor))
const source = fs.readFileSync(new URL('web/ui/chat.js', editor), 'utf8').replace(/^import .*$/gm, '').replace('export function ChatPanel', 'function ChatPanel')
const factory = new Function('deps', `const { Icon, h, htm, useEffect, useRef, useState, useStore, useTime, assistantDraft, updatedAssistantDraft, assistantDraftContext, assistantDraftIsCurrent, createAssistantScriptImport, assistantActivity, assistantState, assistantPrompt, providerName, refreshAssistantStatus, api, set, store, time, toast, receiptSelection, player, AssistantControls, RoutingReceipt, createAssistantSharingGate, setInterval, clearInterval, assistantPanel } = deps; ${source}\nreturn ChatPanel`)
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const nodes = node => node && typeof node === 'object' ? [node, ...flatten(node.props?.children).flatMap(nodes)] : []
const text = node => flatten(node.props?.children).map(value => typeof value === 'object' ? text(value) : String(value)).join('')
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
const sharingScope = { providers: ['codex'], models: [{ provider: 'codex', model: 'exact' }], companion: 'http://127.0.0.1:4900/', classes: ['prompt', 'project_context', 'project_content', 'tool_results', 'rendered_frames', 'reference_images', 'conversation_history'] }

// Transport is a local function. No test contacts a provider or editor endpoint.
function session(t, { sharing = 'approved', send = async () => ({ queued: 'synthetic' }) } = {}) {
  const state = { root: '/project-a', claude: { state: 'idle' }, connected: true, caps: {}, assistantStatus: { provider: 'codex', configured: true }, chat: [], activity: [], receipts: [], selection: [], refs: [], project: { name: 'Synthetic', comps: {}, tracks: [], assets: {} }, openComp: null, chatOpen: true }
  const calls = [], notices = []
  let mounted = null, tree, storeChanged = false
  const useState = initial => {
    const id = mounted.index++, slot = mounted.slots[id] ??= { value: typeof initial === 'function' ? initial() : initial }
    return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
  }
  const useRef = initial => { const id = mounted.index++; return (mounted.slots[id] ??= { ref: { current: initial } }).ref }
  const useEffect = (run, deps) => {
    const id = mounted.index++, previous = mounted.slots[id]
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
      mounted.effects.push(() => { previous?.cleanup?.(); mounted.slots[id] = { deps, cleanup: run() } })
    }
  }
  const api = async (route, body) => {
    calls.push({ route, body })
    if (route === '/api/assistant/sharing') return sharing === 'approved' ? { version: 1, approved: true, scope: sharingScope, sharing: { version: 1, approved: true, scope: sharingScope } } : { version: 1, approved: false, reviewID: 'synthetic', scope: sharingScope }
    if (route === '/api/bridge/send') return send(body)
    throw Error('Unexpected fixture route ' + route)
  }
  const ChatPanel = factory({ Icon, h, htm, useEffect, useRef, useState, useStore: () => state, useTime: () => 0, assistantDraft, updatedAssistantDraft, assistantDraftContext, assistantDraftIsCurrent, createAssistantScriptImport, assistantActivity, assistantState, assistantPrompt, providerName, refreshAssistantStatus: async () => {}, api, set: patch => { Object.assign(state, patch); storeChanged = true }, store: state, time: { t: 0 }, toast: message => notices.push(message), receiptSelection: () => null, player: {}, AssistantControls: () => null, RoutingReceipt: () => null, createAssistantSharingGate, setInterval: () => 0, clearInterval: () => {}, assistantPanel })
  const render = () => {
    let renders = 0
    do {
      assert.ok(renders++ < 10, 'Fixture store updates did not settle')
      storeChanged = false; mounted.index = 0; mounted.effects = []
      tree = ChatPanel(); mounted.effects.forEach(effect => effect())
    } while (storeChanged)
    return tree
  }
  const mount = () => { mounted = { slots: [], index: 0, effects: [] }; state.chatOpen = true; return render() }
  const unmount = () => { if (!mounted) return; mounted.slots.forEach(slot => slot.cleanup?.()); mounted = null }
  mount(); t.after(unmount)
  const textarea = () => nodes(tree).find(node => node.type === 'textarea')
  return {
    state, calls, notices, render, mount, unmount,
    draft: () => textarea().props.value,
    input(value) { textarea().props.onInput({ target: { value } }); render() },
    quick(label) { nodes(tree).find(node => node.type === 'button' && text(node) === label).props.onClick(); render() },
    editRequest() { nodes(tree).find(node => node.props?.class?.includes?.('assistant-edit-request')).props.onClick(); render() },
    close() { nodes(tree).find(node => node.props?.['aria-label'] === 'Close assistant').props.onClick(); unmount() },
    switchRoot(root) { state.root = root; render() },
    send() { return nodes(tree).find(node => node.props?.['aria-label'] === 'Send message').props.onClick() },
  }
}

test('typed composer text survives closing and reopening without dispatch', t => {
  const s = session(t)
  s.input('Keep this exact draft\nwith another line.')
  s.close(); s.mount()
  assert.equal(s.draft(), 'Keep this exact draft\nwith another line.')
  assert.deepEqual(s.calls, [])
})

test('a selection suggestion survives closing and reopening', t => {
  const s = session(t)
  s.state.project = { ...s.state.project, tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'title', start: 0, dur: 2, title: { text: 'Opening' } }] }] }
  s.state.selection = ['c1']; s.render(); s.quick('Explain the selection')
  const draft = s.draft()
  assert.match(draft, /Describe the selected clips as an editor would/)
  s.close(); s.mount()
  assert.equal(s.draft(), draft)
  assert.deepEqual(s.calls, [])
})

test('Edit request keeps its draft and current references across reopening', t => {
  const s = session(t)
  s.state.chat = [{ role: 'user', text: 'Earlier request', refs: [{ label: 'Old reference' }] }]
  s.state.refs = [{ kind: 'clip', id: 'current', label: 'Current reference' }]
  s.render(); s.editRequest(); s.close(); s.mount()
  assert.equal(s.draft(), 'Earlier request')
  assert.deepEqual(s.state.refs, [{ kind: 'clip', id: 'current', label: 'Current reference' }])
  assert.deepEqual(s.calls, [])
})

test('mounted root changes display only each project draft', t => {
  const s = session(t)
  s.input('Draft A'); s.switchRoot('/project-b')
  assert.equal(s.draft(), '')
  s.input('Draft B'); s.switchRoot('/project-a')
  assert.equal(s.draft(), 'Draft A')
  s.switchRoot('/project-b')
  assert.equal(s.draft(), 'Draft B')
})

test('unmounted root changes do not move drafts between projects', t => {
  const s = session(t)
  s.input('Draft A'); s.close(); s.state.root = '/project-b'; s.mount()
  assert.equal(s.draft(), '')
  s.input('Draft B'); s.close(); s.state.root = '/project-a'; s.mount()
  assert.equal(s.draft(), 'Draft A')
})

test('explicitly clearing text remains empty after reopening', t => {
  const s = session(t)
  s.input('Delete this draft'); s.input(''); s.close(); s.mount()
  assert.equal(s.draft(), '')
})

test('declining sharing keeps the stored draft without transport submission', async t => {
  const s = session(t, { sharing: 'decline' })
  s.input('Keep after declining'); const work = s.send()
  await settle(); s.state.assistantSharingActions.decline(); await work
  s.close(); s.mount()
  assert.equal(s.draft(), 'Keep after declining')
  assert.deepEqual(s.calls.map(call => call.route), ['/api/assistant/sharing'])
})

test('a mocked transport failure retains the stored draft', async t => {
  const s = session(t, { send: async () => { throw Error('Synthetic refusal') } })
  s.input('Keep after failure'); await s.send(); s.close(); s.mount()
  assert.equal(s.draft(), 'Keep after failure')
  assert.deepEqual(s.notices, ['Synthetic refusal'])
})

test('a successful mocked transport clears the submitted draft on reopening', async t => {
  const s = session(t)
  s.input('Submitted draft'); await s.send(); s.close(); s.mount()
  assert.equal(s.draft(), '')
  assert.equal(s.calls.at(-1).body.text, 'Submitted draft')
})

test('a successful old-root submission leaves the current root draft intact', async t => {
  const pending = deferred(), s = session(t, { send: () => pending.promise })
  s.input('Submitted A'); const work = s.send(); await settle()
  assert.equal(s.calls.at(-1).route, '/api/bridge/send')
  s.switchRoot('/project-b'); s.input('Keep B')
  pending.resolve({ queued: 'synthetic' }); await work; s.render()
  assert.equal(s.draft(), 'Keep B')
  s.close(); s.mount(); assert.equal(s.draft(), 'Keep B')
  s.switchRoot('/project-a'); assert.equal(s.draft(), '')
})

test('a success after panel recreation clears the submitted session draft', async t => {
  const pending = deferred(), s = session(t, { send: () => pending.promise })
  s.input('Submitted A'); const work = s.send(); await settle()
  s.close(); s.mount()
  assert.equal(s.draft(), 'Submitted A')
  pending.resolve({ queued: 'synthetic' }); await work; s.render()
  assert.equal(s.draft(), '')
})

test('typing a newer draft during a pending submission preserves that new text', async t => {
  const pending = deferred(), s = session(t, { send: () => pending.promise })
  s.input('Submitted A'); const work = s.send(); await settle()
  s.input('New draft A')
  pending.resolve({ queued: 'synthetic' }); await work; s.render()
  assert.equal(s.draft(), 'New draft A')
  s.close(); s.mount(); assert.equal(s.draft(), 'New draft A')
})


test('a successful old-root submission consumes its draft when the other project has no draft', async t => {
  const pending = deferred(), s = session(t, { send: () => pending.promise })
  s.input('Submitted A'); const work = s.send(); await settle()
  assert.equal(s.calls.at(-1).route, '/api/bridge/send')
  s.switchRoot('/project-b'); assert.equal(s.draft(), '')
  pending.resolve({ queued: 'synthetic' }); await work; s.render()
  assert.equal(s.draft(), '')
  s.switchRoot('/project-a'); assert.equal(s.draft(), '')
  assert.equal(s.calls.at(-1).body.text, 'Submitted A')
})
