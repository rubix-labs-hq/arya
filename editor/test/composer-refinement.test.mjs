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

test('a turn folds its tool updates into one collapsed run line after the reply, in time order', () => {
  const f = fixture({ chat: [{ role: 'user', text: 'Check the frame', at: 0 }, { role: 'claude', text: 'The result', at: 4 }], activity: [
    { who: 'agent', text: 'Inspecting the current frame', at: 3 },
    { who: 'you', text: 'Hidden user activity', at: 1 },
    { who: 'assistant', text: 'Tool reported an error', at: 2 },
    { who: 'agent', text: 'Read saved output', at: 5 },
  ] })
  const list = nodes(f.draw()).find(node => node.props?.class === 'chat-list')
  const lines = nodes(list).filter(node => node.props?.class?.startsWith('assistant-run '))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].type, 'details'); assert.equal(Boolean(lines[0].props.open), false)
  assert.match(text(lines[0]), /Done 3 tool updates/)
  assert.deepEqual(nodes(lines[0]).filter(node => node.type === 'li').map(text), ['Tool reported an error', 'Inspecting the current frame', 'Read saved output'])
  const turn = nodes(list).find(node => node.props?.class === 'assistant-turn'), order = flatten(turn.props.children)
  assert.ok(order.indexOf(lines[0]) > order.findIndex(node => node?.props?.class === 'msg claude'))
  assert.doesNotMatch(text(list), /Success|Tool completed|Hidden user activity/)
})

test('the context chip names the main timeline when the open composition is gone', () => {
  const chip = state => text(nodes(fixture(state).draw()).find(node => node.props?.class === 'assistant-context-chips').props.children[0])
  assert.equal(chip({ openComp: 'k9', project: { tracks: [], comps: {} } }), 'Main timeline')
  assert.equal(chip({ openComp: 'k1', project: { tracks: [], comps: { k1: { name: 'Sample scene', tracks: [] } } } }), 'Sample scene')
})

test('the exact committed receipt is passed to the result card', () => {
  const receipt = { version: 7, total: 0, clips: [], projectChanges: ['Saved asset media/cue.wav'], at: 4 }
  const component = nodes(fixture({ receipts: [receipt] }).draw()).find(node => node.type?.name === 'ResultCard')
  assert.equal(component.props.receipts.length, 1)
  assert.equal(component.props.receipts[0], receipt)
})

test('several selected objects are one counted chip, with each name, track and id in its tooltip', () => {
  const f = fixture({ selection: ['c1', 'c2', 'tr:c2', 'missing'], openComp: 'k1', project: { tracks: [{ clips: [{ id: 'c1', label: 'Wrong main title' }] }], comps: { k1: { name: 'Opening', tracks: [{ id: 'T1', name: 'Titles', clips: [{ id: 'c1', label: 'Opening title' }] }, { id: 'V2', clips: [{ id: 'c2', label: 'Opening title', transitionIn: { type: 'crossDissolve' } }] }] } } } })
  const tree = f.draw(), group = nodes(tree).find(node => node.props?.class === 'assistant-selection-chips')
  assert.ok(group)
  assert.equal(group.props['aria-label'], 'Current selection included when sending')
  const chips = nodes(group).filter(node => node.props?.class === 'chip small')
  assert.deepEqual(chips.map(text), ['4 items selected'])
  assert.equal(chips[0].props.title, ['Opening title, Titles (T1) (c1)', 'Opening title, V2 (c2)', 'Transition into Opening title, V2 (tr:c2)', 'missing (missing)'].join('\n'))
  const clips = fixture({ selection: ['c1', 'c2'], project: { tracks: [{ id: 'V1', clips: [{ id: 'c1', label: 'One' }, { id: 'c2', label: 'Two' }] }], comps: {} } }).draw()
  assert.equal(text(nodes(clips).find(node => node.props?.class === 'chip small' && /selected/.test(text(node)))), '2 clips selected')
  assert.match(text(tree), /Opening Playhead/)
  assert.equal(nodes(tree).find(node => node.props?.title === 'Opening (k1)')?.props.class, 'chip small', 'the composition id stays on the context chip')
  assert.doesNotMatch(text(group), /Wrong main title/)
  const clear = nodes(group).filter(node => node.type === 'button')
  assert.deepEqual(clear.map(node => node.props['aria-label']), ['Clear selection'])
})

test('changing current selection updates readable chips while preserving the draft and sharing boundary', () => {
  const f = fixture({ selection: ['c1'], project: { tracks: [{ id: 'V1', clips: [{ id: 'c1', label: 'First' }, { id: 'c2', label: 'Second' }] }], comps: {} } })
  const first = f.draw()
  assert.match(text(nodes(first).find(node => node.props?.class === 'assistant-selection-chips')), /First V1/)
  f.state.selection = ['c2']
  const second = f.draw()
  assert.match(text(nodes(second).find(node => node.props?.class === 'assistant-selection-chips')), /Second V1/)
  assert.doesNotMatch(text(nodes(second).find(node => node.props?.class === 'assistant-selection-chips')), /First|c1|c2/)
  assert.equal(input(second).props.value, 'Refine this title')
  assert.deepEqual(f.drafts, []); assert.deepEqual(f.calls, [])
})

test('historical references remain separate from current selection and explicit reference removal', () => {
  const f = fixture({ chat: [{ role: 'user', text: 'Previous request', refs: [{ label: 'Previous frame', id: 'old' }] }], selection: ['c1'], refs: [{ label: 'Current frame', id: 'c1' }], project: { tracks: [{ id: 'V1', clips: [{ id: 'c1', label: 'Current clip' }] }], comps: {} } })
  const tree = f.draw(), current = nodes(tree).find(node => node.props?.class === 'assistant-selection-chips')
  assert.match(text(current), /Current clip V1/)
  assert.doesNotMatch(text(current), /Previous frame|old/)
  assert.ok(nodes(tree).some(node => node.props?.class === 'msg-refs' && /Previous frame/.test(text(node))))
  const remove = nodes(tree).find(node => node.props?.['aria-label'] === 'Remove reference Current frame')
  assert.ok(remove); remove.props.onClick()
  assert.deepEqual(f.state.refs, []); assert.deepEqual(f.state.selection, ['c1'])
  assert.equal(input(f.draw()).props.value, 'Refine this title'); assert.deepEqual(f.calls, [])
})

test('playhead context reads the time hook on each render without fabricating unavailable time', () => {
  const f = fixture()
  assert.match(text(f.draw()), /Main timeline Playhead 00:00:12:08/)
  f.clock.t = 28.75
  assert.match(text(f.draw()), /Playhead 00:00:28:23/)
  assert.equal(f.timeReads, 2)
  f.clock.t = NaN
  assert.match(text(f.draw()), /Playhead unavailable/)
})

test('busy composer labels current attachments as next request context', () => {
  const label = patch => nodes(fixture(patch).draw()).find(node => node.props?.class === 'assistant-composer-content').props['aria-label']
  assert.equal(label({ claude: { state: 'working' } }), 'Next request context')
  assert.equal(label({}), 'Editing context')
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
  const f = fixture({ selection: ['c1', 'c2'], project: { width: 1920, height: 1080, assets: { 'a.mp4': { hasAudio: true }, 'b.mp4': { hasAudio: true } }, tracks: [{ id: 'V1', kind: 'video', clips }], comps: {} } }, '')
  f.state.assistantDraft.inputKind = 'script'
  const tree = f.draw(), group = nodes(tree).find(node => node.props?.class === 'assistant-suggestions')
  assert.ok(group); assert.equal(group.props['aria-label'], 'Suggested requests')
  const labels = nodes(group).filter(node => node.type === 'button').map(node => text(node))
  assert.deepEqual(labels, ['Color Grade these to match', 'Cut Cut the silences', 'Sound Clean up the sound', 'Explain Explain the selection'])
  nodes(group).find(node => node.type === 'button').props.onClick()
  assert.equal(f.drafts.length, 1); assert.match(f.drafts[0], /Grade the 2 selected shots to match/); assert.equal(f.calls.length, 0)
  const card = nodes(tree).find(node => node.props?.class === 'assistant-composer-card')
  const order = nodes(nodes(card).find(node => node.props?.class === 'assistant-field')).map(child => child.props?.class)
  assert.ok(order.indexOf('assistant-composer-content') < order.indexOf('composer'))
  assert.equal(f.state.assistantDraft.inputKind, 'prompt', 'a suggestion is always sent as a prompt')
  assert.equal(nodes(f.draw()).find(node => node.props?.class === 'assistant-suggestions'), undefined, 'suggestions hide once the box has text, so none replaces it')
  assert.equal(nodes(fixture({ claude: { state: 'working' }, selection: ['c1'], project: { assets: {}, tracks: [{ id: 'V1', kind: 'video', clips }], comps: {} } }, '').draw()).find(node => node.props?.class === 'assistant-suggestion'), undefined, 'suggestions hide while requests cannot be sent')
})

for (const flags of [{ isComposing: true }, { nativeEvent: { isComposing: true } }, { keyCode: 229 }, { altKey: true }, { ctrlKey: true }, { shiftKey: true }]) test(`Enter preserves composition or newline for ${JSON.stringify(flags)}`, async () => {
  const f = fixture(), e = event(flags)
  input(f.draw()).props.onKeyDown(e)
  await tick()
  assert.equal(e.prevented, 0); assert.equal(e.stopped, 1); assert.deepEqual(f.calls, []); assert.deepEqual(f.drafts, [])
})

test('Command-Return sends like Return, as in the Mac Assistant', async () => {
  const f = fixture(), e = event({ metaKey: true })
  input(f.draw()).props.onKeyDown(e)
  await tick()
  assert.equal(e.prevented, 1)
  assert.ok(f.calls.some(call => call.route === '/api/bridge/send'))
})

test('the prompt placeholder follows the selection', () => {
  assert.equal(input(fixture().draw()).props.placeholder, 'Ask for an edit or ask about the project')
  assert.equal(input(fixture({ selection: ['c1'] }).draw()).props.placeholder, 'Ask about or change this selection')
})

test('the placeholder, Send and the Preview toggle say whether edits wait for Apply', () => {
  const off = fixture({ assistantPreview: false }).draw()
  assert.equal(input(off).props.placeholder, 'Ask for an edit or ask about the project')
  assert.match(nodes(off).find(node => node.props?.['aria-label'] === 'Send message').props.title, /^Send \(Return\)\. Applies edits directly$/)
  assert.equal(nodes(off).find(node => node.props?.class === 'assistant-preview-toggle').props.title, 'Preview changes is off: edits apply directly')
  const on = fixture().draw()
  assert.equal(nodes(on).find(node => node.props?.['aria-label'] === 'Send message').props.title, 'Send (Return). Preview first: edits wait for Apply')
  // The Mac app has no Preview toggle, so its placeholder names no mode.
  assert.equal(input(fixture({ caps: { host: 'native' } }).draw()).props.placeholder, 'Ask for an edit or ask about the project')
})

test('in a script or screenplay, Return adds a line and Command-Return sends', async () => {
  for (const inputKind of ['script', 'screenplay']) {
    const f = fixture({ assistantDraft: { root: '/fixture', text: 'INT. ROOM - DAY', inputKind } })
    const plain = event()
    input(f.draw()).props.onKeyDown(plain)
    await tick()
    assert.equal(plain.prevented, 0, `${inputKind}: Return keeps the newline`)
    assert.deepEqual(f.calls, [])
    assert.match(text(f.draw()), /⌘Return to send · Return for a new line/)
    assert.equal(input(f.draw()).props.placeholder, 'Paste a script to build editable scenes', `${inputKind}: placeholder`)
    const command = event({ metaKey: true })
    input(f.draw()).props.onKeyDown(command)
    await tick()
    assert.equal(command.prevented, 1)
    assert.ok(f.calls.some(call => call.route === '/api/bridge/send'), `${inputKind}: Command-Return sends`)
  }
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
  for (const [state, label] of [['working', 'Working'], ['cancelling', 'Stopping…'], ['done', 'Done'], ['error', 'Failed'], ['cancelled', 'Stopped']]) {
    const f = fixture({ claude: { state } }), tree = f.draw()
    assert.ok(nodes(tree).some(node => node.props?.role === 'status' && text(node) === label), state)
    const controls = nodes(tree).find(node => node.type === f.Controls)
    assert.equal(controls.props.status, f.state.assistantStatus)
    assert.equal(controls.props.active, ['working', 'cancelling'].includes(state))
    if (state === 'working') { await nodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === 'Stop request').props.onClick(); assert.deepEqual(f.calls.map(call => call.route), ['/api/assistant/cancel']) }
  }
})

for (const [name, clip, selected, expected] of [
  ['title', { id: 'title1', kind: 'title', title: { text: 'Opening title' } }, 'title1', /Opening title V1/],
  ['video', { id: 'video1', kind: 'video', src: 'media/interview-take.mp4' }, 'video1', /interview-take\.mp4 V1/],
  ['transition', { id: 'title1', kind: 'title', title: { text: 'Opening title' }, transitionIn: { type: 'crossDissolve' } }, 'tr:title1', /Transition into Opening title V1/],
]) test(`unlabeled ${name} uses its current visible timeline label and track`, () => {
  const f = fixture({ selection: [selected], project: { tracks: [{ id: 'V1', clips: [clip] }], comps: {} } })
  const group = nodes(f.draw()).find(node => node.props?.class === 'assistant-selection-chips')
  assert.ok(group)
  assert.match(text(group), expected)
  assert.deepEqual(f.calls, [])
  assert.equal(input(f.draw()).props.value, 'Refine this title')
})


for (const referenceCount of [0, 12]) test(`context leads the composer with its controls directly reachable with ${referenceCount} references, preserving the draft`, () => {
  const refs = Array.from({ length: referenceCount }, (_, index) => ({ kind: 'clip', id: `ref${index}`, label: `Reference ${index}` }))
  const f = fixture({ refs, selection: ['c1'], project: { tracks: [{ id: 'V1', name: 'Picture', clips: [{ id: 'c1', label: 'Opening title' }] }], comps: {} } })
  const tree = f.draw(), content = nodes(tree).find(node => node.props?.class === 'assistant-composer-content')
  assert.ok(content)
  const children = flatten(content.props.children).filter(child => child && typeof child === 'object')
  assert.equal(children[0].props.class, 'assistant-context-chips')
  const options = nodes(tree).find(node => node.props?.class === 'assistant-input-tools')
  assert.ok(options)
  const model = nodes(options).find(node => node.props?.class === 'assistant-model-menu')
  assert.equal(model.type, 'details')
  assert.equal(Boolean(model.props.open), false)
  assert.equal(text(nodes(model).find(node => node.type === 'summary')), 'Codex · exact')
  assert.ok(nodes(model).some(node => node.type === f.Controls))
  assert.equal(nodes(content).some(node => node.props?.['aria-label'] === 'Assistant input kind'), false)
  const kind = nodes(options).find(node => node.props?.['aria-label'] === 'Assistant input kind')
  const file = nodes(options).find(node => node.props?.['aria-label'] === 'Import script or screenplay')
  assert.ok(kind); assert.ok(file)
  for (const control of [kind, file]) assert.equal(nodes(options).some(node => node.type === 'details' && nodes(node).includes(control)), false)
  assert.deepEqual(nodes(kind).filter(node => node.type === 'option').map(node => node.props.value), ['prompt', 'script', 'screenplay'])
  assert.equal(kind.props.disabled, false); assert.equal(file.props.disabled, false)
  assert.equal(children.filter(node => node.props?.class === 'assistant-context-chips').length, 1)
  assert.match(text(content), /Main timeline Playhead 00:00:12:08/)
  assert.match(text(content), /Opening title Picture \(V1\)/)
  assert.equal(nodes(content).filter(node => node.props?.['aria-label']?.startsWith('Remove reference ')).length, referenceCount)
  assert.equal(nodes(content).some(node => node.type === 'textarea'), false)
  for (const inputKind of ['script', 'screenplay', 'prompt']) {
    const current = nodes(f.draw()).find(node => node.props?.['aria-label'] === 'Assistant input kind')
    current.props.onChange({ target: { value: inputKind } })
    assert.equal(f.state.assistantDraft.inputKind, inputKind)
    assert.equal(nodes(f.draw()).find(node => node.props?.['aria-label'] === 'Assistant input kind').props.value, inputKind)
    assert.equal(input(f.draw()).props.value, 'Refine this title')
    assert.deepEqual(f.state.selection, ['c1']); assert.deepEqual(f.state.refs, refs)
    assert.deepEqual(f.calls, [])
  }
})


test('setup reason is shown once while the header gives a short connection state', () => {
  const reason = 'Enable at least one verified model in Auto settings.'
  const f = fixture({ assistantStatus: { provider: 'codex', configured: false, mode: 'auto', reason } })
  const tree = f.draw(), head = nodes(tree).find(node => node.props?.class === 'chat-head')
  assert.match(text(head), /Not set up/)
  assert.equal(text(tree).split(reason).length - 1, 1)
  assert.match(text(nodes(tree).find(node => node.props?.class === 'assistant-setup')), /verified model/)
  assert.deepEqual(f.calls, [])
})

test('expired availability shows the Not set up status word and retains the real setup reason', () => {
  const f = fixture({ assistantStatus: { provider: 'codex', configured: false, mode: 'auto', autoPreview: { ok: false, blocked: [{ reason: 'The model catalog needs a refresh.' }] } } })
  const tree = f.draw(), head = nodes(tree).find(node => node.props?.class === 'chat-head')
  assert.match(text(head), /Not set up/)
  assert.match(text(nodes(tree).find(node => node.props?.class === 'assistant-setup')), /expired/)
})

test('the concise attachment hint lives in Input tips, not repeated in the empty state', () => {
  const f = fixture({}, ''), tree = f.draw()
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
  assert.equal(box.props.checked, true); assert.equal(text(toggle), 'Preview first'); assert.equal(box.props.role, 'switch')
  assert.equal(toggle.props.title, 'Preview changes: edits wait for Apply'); assert.equal(box.props['aria-label'], 'Preview changes')
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
  assert.equal(nodes(tree).some(node => node.type === assistantPanel.PreviewCard || node.type?.name === 'ResultCard'), false)
  input(tree).props.onKeyDown(event())
  await tick()
  assert.equal(Object.hasOwn(f.calls.find(call => call.route === '/api/bridge/send').body, 'review'), false)
})

test('a pending preview and the latest change render above the composer and call only their review routes', async () => {
  const proposal = { id: 'p1', baseVersion: 1, ops: [{ op: 'add_color', color: '#000' }], summary: 'Black', stale: false }
  const f = fixture({ version: 1, assistantReview: { proposal, change: { id: 'change1', undoable: true, edits: 2, kind: 'request' } } })
  const tree = f.draw()
  const card = nodes(tree).find(node => node.type === assistantPanel.PreviewCard), bar = nodes(tree).find(node => node.type?.name === 'ResultCard')
  assert.equal(card.props.proposal, proposal); assert.equal(card.props.version, 1); assert.equal(card.props.running, false)
  assert.equal(bar.props.change.id, 'change1')
  await card.props.onApply(); await card.props.onDiscard(); await bar.props.onUndo()
  assert.deepEqual(f.calls.map(call => [call.route, call.body]), [
    ['/api/assistant/proposal/apply', { id: 'p1' }], ['/api/assistant/proposal/discard', { id: 'p1' }], ['/api/assistant/change/undo', { id: 'change1' }]])
  const working = fixture({ claude: { state: 'working', runId: 'r', startedAt: Date.now() }, assistantReview: { proposal, change: { id: 'c', undoable: true, edits: 1 } } }).draw()
  assert.equal(nodes(working).find(node => node.type === assistantPanel.PreviewCard).props.running, true)
  assert.equal(nodes(working).some(node => node.type?.name === 'ResultCard'), false, 'no undo offer while a request is still editing')
})

test('a failed request offers Edit request, which restores its text without sending', () => {
  const f = fixture({ claude: { state: 'error', text: 'The agent could not complete the request.' }, chat: [{ role: 'user', text: 'Grade these to match' }, { role: 'claude', text: 'Failed.', error: true }] }, '')
  const inCard = tree => nodes(nodes(tree).find(node => node.props?.class === 'assistant-failure') ?? {}).find(node => node.type === 'button' && text(node) === 'Edit request')
  const card = nodes(f.draw()).find(node => node.props?.class === 'assistant-failure')
  assert.match(text(card), /The request did not finish/); assert.match(text(card) + JSON.stringify(nodes(card).map(node => node.props?.dangerouslySetInnerHTML?.__html ?? '')), /Failed\./, 'the provider message is inside the card')
  assert.equal(nodes(f.draw()).filter(node => node.props?.class === 'msg claude').length, 0, 'and is not drawn a second time as a reply')
  const retry = inCard(f.draw())
  assert.ok(retry); assert.equal(retry.props.disabled, false)
  retry.props.onClick()
  assert.deepEqual(f.drafts, ['Grade these to match']); assert.deepEqual(f.calls, [])
  assert.equal(inCard(fixture({ claude: { state: 'done' }, chat: [{ role: 'user', text: 'Fine' }] }, '').draw()), undefined)
  assert.equal(inCard(fixture({ claude: { state: 'error' }, chat: [{ role: 'user', text: 'Keep' }] }, 'A newer draft').draw()).props.disabled, true)
})
