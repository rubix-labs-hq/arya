import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const editor = process.env.ARYA_COMPOSER_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(path.join(process.env.ARYA_COMPOSER_DEPENDENCY_ROOT ?? editor, 'package.json'))
const { h } = require('preact'), htm = require('htm')
const { assistantState, assistantPrompt, providerName } = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-state.js')))
const { assistantActivity } = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-activity.js')))
const { createAssistantSharingGate } = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-sharing.js')))
const script = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-script.js')))
const { assistantPanel } = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-panel.js')))
const { Icon } = await import(pathToFileURL(path.join(editor, 'web/ui/icons.js')))
const source = fs.readFileSync(path.join(editor, 'web/ui/chat.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
const render = new Function('Icon', 'h', 'htm', 'useEffect', 'useRef', 'useState', 'useStore', 'useTime', 'assistantActivity', 'assistantState', 'assistantPrompt', 'providerName', 'refreshAssistantStatus', 'api', 'set', 'store', 'time', 'toast', 'receiptSelection', 'player', 'AssistantControls', 'RoutingReceipt', 'createAssistantSharingGate', ...Object.keys(script), 'assistantPanel', `${source}\nreturn ChatPanel()`)
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const nodes = value => value && typeof value === 'object' ? [value, ...flatten(value.props?.children).flatMap(nodes)] : []
const text = value => flatten(value?.props?.children).map(child => typeof child === 'object' ? text(child) : String(child)).join(' ').replace(/\s+/g, ' ').trim()
const tick = () => new Promise(resolve => setImmediate(resolve))
const scope = { providers: ['codex'], models: [{ provider: 'codex', model: 'exact' }], companion: 'http://127.0.0.1:4900/', classes: ['prompt', 'project_context', 'project_content', 'tool_results', 'rendered_frames', 'reference_images', 'conversation_history'] }
const sharing = { version: 1, approved: true, scope }
function fixture(overrides = {}, draft = 'Refine this title') {
  const state = { caps: {}, claude: { state: 'idle' }, connected: true, assistantStatus: { provider: 'codex', configured: true, model: 'exact', catalogBound: true }, chat: [], activity: [], receipts: [], selection: [], refs: [], project: { tracks: [], comps: {} }, root: '/fixture', assistantDraft: { root: '/fixture', text: draft, inputKind: 'prompt' }, openComp: null, ...overrides }
  const calls = [], drafts = [], patches = [], refs = [], values = [], clock = { t: 12.25 }
  let hook = 0, ref = 0, timeReads = 0
  const api = async (route, body) => { calls.push({ route, body }); return route === '/api/assistant/sharing' ? { version: 1, approved: true, scope, sharing } : { queued: 'fixture', cancelled: true } }
  const useState = initial => { const i = hook++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value }] }
  const useRef = initial => refs[ref++] ??= { current: initial }
  const Controls = () => null, Receipt = () => null
  const draw = () => { hook = 0; ref = 0; return render(Icon, h, htm, () => {}, useRef, useState, () => state, () => { timeReads++; return clock.t }, assistantActivity, assistantState, assistantPrompt, providerName, () => assert.fail('Unexpected account refresh'), api, patch => { patches.push(patch); Object.assign(state, patch); if (patch.assistantDraft) drafts.push(patch.assistantDraft.text) }, state, clock, () => {}, () => null, {}, Controls, Receipt, createAssistantSharingGate, ...Object.values(script), assistantPanel) }
  return { state, calls, drafts, patches, clock, draw, Controls, get timeReads() { return timeReads } }
}
const input = tree => nodes(tree).find(node => node.type === 'textarea')
const event = values => { const result = { key: 'Enter', stopped: 0, prevented: 0, stopPropagation() { this.stopped++ }, preventDefault() { this.prevented++ }, ...values }; return result }

test('actual activity entries render truthful update cards without inferred tool success', () => {
  const f = fixture({ activity: [{ who: 'agent', text: 'Inspecting the current frame', at: 3 }, { who: 'you', text: 'Hidden user activity', at: 1 }, { who: 'assistant', text: 'Tool reported an error', at: 2 }] })
  const cards = nodes(f.draw()).filter(node => node.props?.class === 'assistant-tool-card')
  assert.equal(cards.length, 2)
  assert.match(text(cards[0]), /Assistant update Tool reported an error/)
  assert.match(text(cards[1]), /Inspecting the current frame/)
  assert.doesNotMatch(cards.map(text).join(' '), /Success|Tool completed|Hidden user activity/)
})

test('committed receipt card retains the exact receipt and existing result component', () => {
  const receipt = { version: 7, total: 0, clips: [], projectChanges: ['Saved asset media/cue.wav'], at: 4 }
  const card = nodes(fixture({ receipts: [receipt] }).draw()).find(node => node.props?.class === 'assistant-result-card')
  assert.ok(card); assert.match(text(card), /Committed edit/)
  const component = nodes(card).find(node => typeof node.type === 'function')
  assert.equal(component.props.receipt, receipt)
  assert.equal(component.type.name, 'ChangeReceipt')
})

test('selection chips visibly distinguish duplicate labels, tracks and exact transition IDs in the current composition', () => {
  const f = fixture({ selection: ['c1', 'c2', 'tr:c2', 'missing'], openComp: 'k1', project: { tracks: [{ clips: [{ id: 'c1', label: 'Wrong main title' }] }], comps: { k1: { name: 'Opening', tracks: [{ id: 'T1', name: 'Titles', clips: [{ id: 'c1', label: 'Opening title' }] }, { id: 'V2', clips: [{ id: 'c2', label: 'Opening title', transitionIn: { type: 'crossDissolve' } }] }] } } } })
  const tree = f.draw(), group = nodes(tree).find(node => node.props?.class === 'assistant-selection-chips')
  assert.ok(group)
  assert.equal(group.props['aria-label'], 'Current selection included when sending')
  const chips = nodes(group).filter(node => node.props?.class === 'chip small')
  assert.deepEqual(chips.map(text), ['Opening title c1 · Titles (T1)', 'Opening title c2 · V2', 'Transition into Opening title tr:c2 · V2', 'missing missing'])
  assert.match(text(tree), /Opening \(k1\) · Playhead/)
  assert.doesNotMatch(text(group), /Wrong main title/)
  assert.equal(nodes(group).some(node => node.type === 'button'), false)
})

test('changing current selection updates readable chips while preserving the draft and sharing boundary', () => {
  const f = fixture({ selection: ['c1'], project: { tracks: [{ id: 'V1', clips: [{ id: 'c1', label: 'First' }, { id: 'c2', label: 'Second' }] }], comps: {} } })
  const first = f.draw()
  assert.match(text(nodes(first).find(node => node.props?.class === 'assistant-selection-chips')), /First c1/)
  f.state.selection = ['c2']
  const second = f.draw()
  assert.match(text(nodes(second).find(node => node.props?.class === 'assistant-selection-chips')), /Second c2/)
  assert.doesNotMatch(text(nodes(second).find(node => node.props?.class === 'assistant-selection-chips')), /First|c1/)
  assert.equal(input(second).props.value, 'Refine this title')
  assert.deepEqual(f.drafts, []); assert.deepEqual(f.calls, [])
})

test('historical references remain separate from current selection and explicit reference removal', () => {
  const f = fixture({ chat: [{ role: 'user', text: 'Previous request', refs: [{ label: 'Previous frame', id: 'old' }] }], selection: ['c1'], refs: [{ label: 'Current frame', id: 'c1' }], project: { tracks: [{ id: 'V1', clips: [{ id: 'c1', label: 'Current clip' }] }], comps: {} } })
  const tree = f.draw(), current = nodes(tree).find(node => node.props?.class === 'assistant-selection-chips')
  assert.match(text(current), /Current clip c1/)
  assert.doesNotMatch(text(current), /Previous frame|old/)
  assert.ok(nodes(tree).some(node => node.props?.class === 'msg-refs' && /Previous frame/.test(text(node))))
  const remove = nodes(tree).find(node => node.props?.['aria-label'] === 'Remove reference Current frame')
  assert.ok(remove); remove.props.onClick()
  assert.deepEqual(f.state.refs, []); assert.deepEqual(f.state.selection, ['c1'])
  assert.equal(input(f.draw()).props.value, 'Refine this title'); assert.deepEqual(f.calls, [])
})

test('playhead context reads the time hook on each render without fabricating unavailable time', () => {
  const f = fixture()
  assert.match(text(f.draw()), /Main timeline · Playhead 00:00:12:08/)
  f.clock.t = 28.75
  assert.match(text(f.draw()), /Playhead 00:00:28:23/)
  assert.equal(f.timeReads, 2)
  f.clock.t = NaN
  assert.match(text(f.draw()), /Playhead unavailable/)
})

test('busy composer labels current attachments as next request context', () => {
  assert.match(text(fixture({ claude: { state: 'working' } }).draw()), /Next request context/)
  assert.match(text(fixture().draw()), /Editing context/)
})

test('named reference removal changes only the actual refs', () => {
  const refs = [{ kind: 'clip', id: 'c1', label: 'Current frame' }, { kind: 'track', id: 'A1', label: 'Dialogue' }]
  const f = fixture({ refs, selection: ['c1'] })
  const remove = nodes(f.draw()).find(node => node.props?.['aria-label'] === 'Remove reference Current frame')
  assert.ok(remove); remove.props.onClick()
  assert.deepEqual(f.state.refs, [refs[1]])
  assert.deepEqual(f.state.selection, ['c1']); assert.deepEqual(f.calls, [])
})

test('suggestions follow the selection, sit before the text box and set a draft without dispatch', () => {
  const clips = [{ id: 'c1', kind: 'video', src: 'a.mp4', start: 0, dur: 4 }, { id: 'c2', kind: 'video', src: 'b.mp4', start: 4, dur: 4 }]
  const f = fixture({ selection: ['c1', 'c2'], project: { width: 1920, height: 1080, assets: { 'a.mp4': { hasAudio: true }, 'b.mp4': { hasAudio: true } }, tracks: [{ id: 'V1', kind: 'video', clips }], comps: {} } })
  const tree = f.draw(), group = nodes(tree).find(node => node.props?.class === 'assistant-suggestions')
  assert.ok(group); assert.equal(group.props['aria-label'], 'Suggested requests')
  const labels = nodes(group).filter(node => node.type === 'button').map(node => text(node))
  assert.deepEqual(labels, ['Grade these to match', 'Cut the silences', 'Clean up the sound', 'Explain the selection'])
  nodes(group).find(node => node.type === 'button').props.onClick()
  assert.equal(f.drafts.length, 1); assert.match(f.drafts[0], /Grade the 2 selected shots to match/); assert.equal(f.calls.length, 0)
  const card = nodes(tree).find(node => node.props?.class === 'assistant-composer-card')
  const order = flatten(card.props.children).filter(child => child && typeof child === 'object').map(child => child.props?.class)
  assert.ok(order.indexOf('assistant-composer-content') < order.indexOf('composer'))
  assert.equal(nodes(f.draw()).find(node => node.props?.class === 'assistant-suggestions') !== undefined, true)
  assert.equal(nodes(fixture({ claude: { state: 'working' }, selection: ['c1'], project: { assets: {}, tracks: [{ id: 'V1', kind: 'video', clips }], comps: {} } }).draw()).find(node => node.props?.class === 'assistant-suggestion').props.disabled, true)
})

for (const flags of [{ isComposing: true }, { nativeEvent: { isComposing: true } }, { keyCode: 229 }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) test(`Enter preserves composition or newline for ${JSON.stringify(flags)}`, async () => {
  const f = fixture(), e = event(flags)
  input(f.draw()).props.onKeyDown(e)
  await tick()
  assert.equal(e.prevented, 0); assert.equal(e.stopped, 1); assert.deepEqual(f.calls, []); assert.deepEqual(f.drafts, [])
})

test('composition lifecycle prevents dispatch until composition ends', async () => {
  const f = fixture(), field = input(f.draw()), during = event()
  field.props.onCompositionStart?.()
  field.props.onKeyDown(during)
  await tick()
  assert.deepEqual(f.calls, []); assert.equal(during.prevented, 0)
  assert.equal(typeof field.props.onCompositionEnd, 'function')
  field.props.onCompositionEnd()
  const after = event(); field.props.onKeyDown(after)
  await tick()
  assert.equal(after.prevented, 1)
  assert.deepEqual(f.calls.map(call => call.route), ['/api/assistant/sharing', '/api/bridge/send'])
})

test('plain Enter keeps exact sharing, selection, references, composition and playhead payload', async () => {
  const refs = [{ kind: 'clip', id: 'c1', label: 'Frame' }], f = fixture({ refs, selection: ['c1', 'tr:c2'], openComp: 'k1' })
  input(f.draw()).props.onKeyDown(event())
  await tick()
  const request = f.calls.find(call => call.route === '/api/bridge/send')
  assert.deepEqual(request.body, { type: 'prompt', text: 'Refine this title', inputKind: 'prompt', refs, ids: ['c1', 'tr:c2'], comp: 'k1', playhead: 12.25, sharing, review: true })
  assert.deepEqual(f.state.refs, []); assert.deepEqual(f.drafts, [''])
})

test('live terminal labels and inline model controls retain their current contracts', async () => {
  for (const [state, label] of [['working', 'Using tools'], ['cancelling', 'Stopping'], ['done', 'Response finished'], ['error', 'Failed'], ['cancelled', 'Stopped']]) {
    const f = fixture({ claude: { state } }), tree = f.draw()
    assert.ok(nodes(tree).some(node => node.props?.role === 'status' && text(node) === label), state)
    const controls = nodes(tree).find(node => node.type === f.Controls)
    assert.equal(controls.props.status, f.state.assistantStatus)
    assert.equal(controls.props.active, ['working', 'cancelling'].includes(state))
    if (state === 'working') { await nodes(tree).find(node => node.type === 'button' && text(node) === 'Stop request').props.onClick(); assert.deepEqual(f.calls.map(call => call.route), ['/api/assistant/cancel']) }
  }
})

for (const [name, clip, selected, expected] of [
  ['title', { id: 'title1', kind: 'title', title: { text: 'Opening title' } }, 'title1', /Opening title title1/],
  ['video', { id: 'video1', kind: 'video', src: 'media/interview-take.mp4' }, 'video1', /interview-take\.mp4 video1/],
  ['transition', { id: 'title1', kind: 'title', title: { text: 'Opening title' }, transitionIn: { type: 'crossDissolve' } }, 'tr:title1', /Transition into Opening title tr:title1/],
]) test(`unlabeled ${name} uses its current visible timeline label with exact identity`, () => {
  const f = fixture({ selection: [selected], project: { tracks: [{ id: 'V1', clips: [clip] }], comps: {} } })
  const group = nodes(f.draw()).find(node => node.props?.class === 'assistant-selection-chips')
  assert.ok(group)
  assert.match(text(group), expected)
  assert.deepEqual(f.calls, [])
  assert.equal(input(f.draw()).props.value, 'Refine this title')
})


for (const referenceCount of [0, 12]) test(`context leads the composer and input kind waits in the options with ${referenceCount} references, preserving the draft`, () => {
  const refs = Array.from({ length: referenceCount }, (_, index) => ({ kind: 'clip', id: `ref${index}`, label: `Reference ${index}` }))
  const f = fixture({ refs, selection: ['c1'], project: { tracks: [{ id: 'V1', name: 'Picture', clips: [{ id: 'c1', label: 'Opening title' }] }], comps: {} } })
  const tree = f.draw(), content = nodes(tree).find(node => node.props?.class === 'assistant-composer-content')
  assert.ok(content)
  const children = flatten(content.props.children).filter(child => child && typeof child === 'object')
  assert.equal(children[0].props.class, 'assistant-context')
  const options = nodes(tree).find(node => node.props?.class === 'assistant-options')
  assert.ok(options); assert.equal(Boolean(options.props.open), false)
  assert.equal(nodes(content).some(node => node.props?.['aria-label'] === 'Assistant input kind'), false)
  const kind = nodes(options).find(node => node.props?.['aria-label'] === 'Assistant input kind')
  const file = nodes(options).find(node => node.props?.['aria-label'] === 'Import script or screenplay')
  assert.ok(kind); assert.ok(file)
  assert.deepEqual(nodes(kind).filter(node => node.type === 'option').map(node => node.props.value), ['prompt', 'script', 'screenplay'])
  assert.equal(kind.props.disabled, false); assert.equal(file.props.disabled, false)
  assert.equal(children.filter(node => node.props?.class === 'assistant-context').length, 1)
  assert.match(text(content), /Main timeline · Playhead 00:00:12:08/)
  assert.match(text(content), /Opening title c1 · Picture \(V1\)/)
  assert.equal(nodes(content).filter(node => node.props?.['aria-label']?.startsWith('Remove reference ')).length, referenceCount)
  assert.equal(nodes(content).some(node => node.type === 'textarea'), false)
  for (const inputKind of ['script', 'screenplay', 'prompt']) {
    const current = nodes(f.draw()).find(node => node.props?.['aria-label'] === 'Assistant input kind')
    current.props.onChange({ target: { value: inputKind } })
    assert.equal(f.state.assistantDraft.inputKind, inputKind)
    assert.equal(text(f.draw()).includes(`Sending as ${inputKind === 'script' ? 'a script' : 'a screenplay'}`), inputKind !== 'prompt')
    assert.equal(input(f.draw()).props.value, 'Refine this title')
    assert.deepEqual(f.state.selection, ['c1']); assert.deepEqual(f.state.refs, refs)
    assert.deepEqual(f.calls, [])
  }
})


test('setup reason is shown once while the header gives a short connection state', () => {
  const reason = 'Enable at least one verified model in Auto settings.'
  const f = fixture({ assistantStatus: { provider: 'codex', configured: false, mode: 'auto', reason } })
  const tree = f.draw(), head = nodes(tree).find(node => node.props?.class === 'chat-head')
  assert.match(text(head), /Not connected/)
  assert.equal(text(tree).split(reason).length - 1, 1)
  assert.match(text(nodes(tree).find(node => node.props?.class === 'assistant-setup')), /verified model/)
  assert.deepEqual(f.calls, [])
})

test('expired availability has a short refresh header and retains the real setup reason', () => {
  const f = fixture({ assistantStatus: { provider: 'codex', configured: false, mode: 'auto', autoPreview: { ok: false, blocked: [{ reason: 'The model catalog needs a refresh.' }] } } })
  const tree = f.draw(), head = nodes(tree).find(node => node.props?.class === 'chat-head')
  assert.match(text(head), /Needs refresh/)
  assert.doesNotMatch(text(head), /Not connected/)
  assert.match(text(nodes(tree).find(node => node.props?.class === 'assistant-setup')), /expired/)
})

test('the concise attachment hint lives in Input tips, not repeated in the empty state', () => {
  const f = fixture(), tree = f.draw()
  const empty = nodes(tree).find(node => node.props?.class === 'chat-empty')
  assert.equal(nodes(empty).filter(node => node.type === 'p').length, 1)
  const help = nodes(tree).find(node => node.props?.class === 'assistant-input-help')
  assert.match(text(help), /clip, keyframe, track, marker or inspector field/)
  assert.match(text(help), /UTF-8 text up to 512 KiB/)
  assert.equal(text(tree).split('inspector field to attach it.').length - 1, 1)
  f.state.chat = [{ role: 'user', text: 'Prior request' }]
  assert.match(text(f.draw()), /inspector field to attach it/)
})

test('drawn reference and Close controls retain actual names and effects', () => {
  const refs = [{ label: 'Opening frame' }], f = fixture({ refs })
  const tree = f.draw(), close = nodes(tree).find(node => node.props?.['aria-label'] === 'Close assistant')
  const remove = nodes(tree).find(node => node.props?.['aria-label'] === 'Remove reference Opening frame')
  const icon = button => nodes(button).find(node => node.type === Icon)
  assert.equal(icon(close).props.name, 'close')
  assert.equal(icon(remove).props.name, 'close')
  remove.props.onClick(); assert.deepEqual(f.state.refs, [])
  close.props.onClick(); assert.equal(f.state.chatOpen, false)
  assert.equal(f.state.assistantDraft.text, 'Refine this title')
  assert.deepEqual(f.calls, [])
})

test('Preview changes is on by default, travels with the request and can be turned off', async () => {
  const f = fixture()
  const toggle = nodes(f.draw()).find(node => node.props?.class === 'assistant-preview-toggle')
  const box = nodes(toggle).find(node => node.type === 'input')
  assert.equal(box.props.checked, true); assert.match(text(toggle), /Preview changes/)
  box.props.onChange({ target: { checked: false } })
  assert.equal(f.state.assistantPreview, false)
  assert.equal(nodes(nodes(f.draw()).find(node => node.props?.class === 'assistant-preview-toggle')).find(node => node.type === 'input').props.checked, false)
  input(f.draw()).props.onKeyDown(event())
  await tick()
  const request = f.calls.find(call => call.route === '/api/bridge/send')
  assert.equal(Object.hasOwn(request.body, 'review'), false)
})

test('the native host keeps its own flow: no preview toggle, preview card or preview flag', async () => {
  const proposal = { id: 'p1', baseVersion: 1, ops: [{ op: 'add_color', color: '#000' }], summary: 'Black', stale: false }
  const f = fixture({ caps: { host: 'native' }, assistantReview: { proposal, change: { id: 'x', undoable: true, edits: 1 } } })
  const tree = f.draw()
  assert.equal(nodes(tree).some(node => node.props?.class === 'assistant-preview-toggle'), false)
  assert.equal(nodes(tree).some(node => node.type === assistantPanel.PreviewCard || node.type === assistantPanel.ChangeBar), false)
  input(tree).props.onKeyDown(event())
  await tick()
  assert.equal(Object.hasOwn(f.calls.find(call => call.route === '/api/bridge/send').body, 'review'), false)
})

test('a pending preview and the latest change render above the composer and call only their review routes', async () => {
  const proposal = { id: 'p1', baseVersion: 1, ops: [{ op: 'add_color', color: '#000' }], summary: 'Black', stale: false }
  const f = fixture({ version: 1, assistantReview: { proposal, change: { id: 'change1', undoable: true, edits: 2, kind: 'request' } } })
  const tree = f.draw()
  const card = nodes(tree).find(node => node.type === assistantPanel.PreviewCard), bar = nodes(tree).find(node => node.type === assistantPanel.ChangeBar)
  assert.equal(card.props.proposal, proposal); assert.equal(card.props.version, 1); assert.equal(card.props.running, false)
  await card.props.onApply(); await card.props.onDiscard(); await bar.props.onUndo()
  assert.deepEqual(f.calls.map(call => [call.route, call.body]), [
    ['/api/assistant/proposal/apply', { id: 'p1' }], ['/api/assistant/proposal/discard', { id: 'p1' }], ['/api/assistant/change/undo', { id: 'change1' }]])
  const working = fixture({ claude: { state: 'working', runId: 'r', startedAt: Date.now() }, assistantReview: { proposal, change: { id: 'c', undoable: true, edits: 1 } } }).draw()
  assert.equal(nodes(working).find(node => node.type === assistantPanel.PreviewCard).props.running, true)
  assert.equal(nodes(working).some(node => node.type === assistantPanel.ChangeBar), false, 'no undo offer while a request is still editing')
})

test('a failed request offers Edit and retry, which restores its text without sending', () => {
  const f = fixture({ claude: { state: 'error', text: 'The agent could not complete the request.' }, chat: [{ role: 'user', text: 'Grade these to match' }, { role: 'claude', text: 'Failed.', error: true }] }, '')
  const retry = nodes(f.draw()).find(node => node.type === 'button' && text(node) === 'Edit and retry')
  assert.ok(retry); assert.equal(retry.props.disabled, false)
  retry.props.onClick()
  assert.deepEqual(f.drafts, ['Grade these to match']); assert.deepEqual(f.calls, [])
  assert.equal(nodes(fixture({ claude: { state: 'done' }, chat: [{ role: 'user', text: 'Fine' }] }, '').draw()).some(node => text(node) === 'Edit and retry'), false)
  assert.equal(nodes(fixture({ claude: { state: 'error' }, chat: [{ role: 'user', text: 'Keep' }] }, 'A newer draft').draw()).find(node => text(node) === 'Edit and retry').props.disabled, true)
})
