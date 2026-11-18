import { Icon } from '../web/ui/icons.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { h } from 'preact'
import htm from 'htm'
import * as script from '../web/ui/assistant-script.js'
import { assistantPanel } from '../web/ui/assistant-panel.js'
import { assistantActivity } from '../web/ui/assistant-activity.js'
import { createAssistantSharingGate } from '../web/ui/assistant-sharing.js'
import { assistantState, assistantPrompt, providerName } from '../web/ui/assistant-state.js'

// Render the actual component with inert host and hook boundaries. HTM and
// Preact remain real so malformed template nesting cannot pass as text tests.
const source = readFileSync(new URL('../web/ui/chat.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace('export function ChatPanel', 'function ChatPanel')
const render = new Function('Icon', 'h', 'htm', 'useEffect', 'useRef', 'useState', 'useStore',
  'assistantActivity', 'assistantState', 'assistantPrompt', 'providerName', 'useTime', 'refreshAssistantStatus', 'api',
  'set', 'store', 'time', 'toast', 'receiptSelection', 'player', 'AssistantControls', 'RoutingReceipt', 'AssistantSharingReview', 'createAssistantSharingGate', ...Object.keys(script), 'assistantPanel', `${source}\nreturn ChatPanel()`)
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const children = node => flatten(node?.props?.children)
const nodes = node => typeof node === 'object' && node ? [node, ...children(node).flatMap(nodes)] : []
const textContent = node => children(node).map(child => typeof child === 'object' ? textContent(child) : String(child)).join('')
// The panel's refs in the order ChatPanel creates them, so a test can preset one (the last request sent).
const refNames = [...source.matchAll(/(\w+) = useRef\(/g)].map(match => match[1])
function panel(run, connected = true, { draft = '', chat = [], activity = [], receipts = [], review = null, session = null, project = { comps: {} }, lastSent = null, onDraft = () => {}, api = () => {}, status = { provider: 'codex', configured: true }, refresh = async () => {} } = {}) {
  const state = { claude: run, connected, caps: {}, assistantStatus: status, assistantReview: review, session,
    root: '/fixture', assistantDraft: { root: '/fixture', text: draft, inputKind: 'prompt' }, chat, activity, receipts, selection: [], refs: [], project, openComp: null }
  let refIndex = 0
  const useRef = value => ({ current: refNames[refIndex++] === 'lastSent' && lastSent ? lastSent : value })
  return render(Icon, h, htm, () => {}, useRef, value => [value, () => {}], () => state,
    assistantActivity, assistantState, assistantPrompt, providerName, () => 0, refresh, api, patch => { Object.assign(state, patch); if (patch.assistantDraft) onDraft(patch.assistantDraft.text) }, state, { t: 0 }, () => {}, () => {}, {}, () => null, () => null, () => null, createAssistantSharingGate, ...Object.values(script), assistantPanel)
}

test('assistant activity renders one run line with Stop in the bar inside the field', () => {
  const tree = panel({ state: 'working', startedAt: Date.now() - 1000, phase: 'Rendering media' })
  const all = nodes(tree), run = all.find(node => node.props?.class === 'assistant-run active')
  assert.ok(run)
  for (const node of all) assert.ok(typeof node.type === 'string' || typeof node.type === 'function', 'every rendered element has a valid Preact type')
  const content = children(run), heading = content.find(node => node.props?.class === 'assistant-run-heading')
  assert.ok(heading)
  assert.equal(textContent(nodes(heading).find(node => node.type === 'b')), 'Working')
  assert.equal(textContent(nodes(heading).find(node => node.props?.class === 'assistant-run-stage')), 'Rendering media')
  assert.equal(nodes(heading).find(node => node.props?.class === 'assistant-run-stage').props.title, 'Rendering media', 'a cut-off stage can still be read in full')
  assert.match(textContent(nodes(heading).find(node => node.props?.class === 'assistant-run-time')), /^\ds$/)
  assert.equal(nodes(run).some(node => node.type === 'button'), false)
  const footer = nodes(all.find(node => node.props?.class === 'assistant-field')).find(node => node.props?.class === 'assistant-field-bar')
  assert.ok(footer)
  const stop = nodes(footer).find(node => node.type === 'button' && node.props['aria-label'] === 'Stop request')
  assert.ok(stop)
  assert.equal(textContent(stop), 'Stop')
  assert.equal(all.filter(node => node.type === 'button' && node.props['aria-label'] === 'Stop request').length, 1)
  assert.equal(nodes(heading).some(node => ['button', 'p'].includes(node.type)), false)
})

test('finished disconnected replies keep a separate result and reconnect notice', () => {
  const tree = panel({ state: 'done', outcome: 'No project edits were applied during this request.' }, false)
  const run = nodes(tree).find(node => node.props?.class === 'assistant-run done')
  assert.ok(run)
  assert.equal(run.type, 'details')
  const heading = children(run).find(node => node.props?.class === 'assistant-run-heading')
  assert.equal(textContent(nodes(heading).find(node => node.type === 'b')), 'Done')
  assert.match(textContent(nodes(heading).find(node => node.props?.class === 'assistant-run-stage')), /No project edits/)
  const paragraphs = children(run).filter(node => node.type === 'p').map(node => children(node).join(''))
  assert.equal(paragraphs.length, 1)
  assert.match(paragraphs[0], /last confirmed result/)
  assert.equal(nodes(run).some(node => node.type === 'button'), false)
})

test('a past turn shows its tool updates as one quiet line that opens to the list', () => {
  const at = Date.now() - 60000
  const tree = panel({ state: 'idle' }, true, { chat: [{ role: 'user', text: 'Trim the opening', at }, { role: 'claude', text: 'Trimmed it.', at: at + 12000 }],
    activity: [{ who: 'agent', text: 'Calling get_project', at: at + 1000 }, { who: 'agent', text: 'Calling apply_ops', at: at + 2000 }] })
  const run = nodes(tree).find(node => node.props?.class === 'assistant-run done')
  assert.equal(run.type, 'details')
  assert.equal(run.props.open, false)
  assert.match(textContent(children(run)[0]), /Done2 tool updates12s/)
  assert.deepEqual(nodes(run).filter(node => node.type === 'li').map(textContent), ['Calling get_project', 'Calling apply_ops'])
})

test('inside a turn the reply comes first, then the run line, then one result card', async () => {
  const { changeReceipt } = await import('../web/ui/change-receipt.js')
  const at = Date.now() - 5000
  const before = { tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'title', start: 0, dur: 2 }] }], comps: {} }
  const after = structuredClone(before); after.tracks[0].clips[0].dur = 3
  const receipt = changeReceipt(before, after, { who: 'agent', version: 5, at: at + 2000 })
  const tree = panel({ state: 'done', startedAt: at, finishedAt: at + 4000 }, true, { chat: [{ role: 'user', text: 'Make the title longer', at }, { role: 'claude', text: 'Done.', at: at + 3000 }],
    activity: [{ who: 'agent', text: 'Calling apply_ops', at: at + 1000 }], receipts: [receipt] })
  const turn = nodes(tree).find(node => node.props?.class === 'assistant-turn')
  const order = children(turn).map(node => typeof node.type === 'function' ? node.type.name : node.props?.class)
  assert.deepEqual(order, ['msg user', 'msg claude', 'assistant-run done', 'ResultCard'])
})


// ResultCard is a component, so the walker leaves it as a node. Call it with the panel's own store.
const resultCard = (tree, state = {}) => {
  const node = nodes(tree).find(node => node.type?.name === 'ResultCard')
  return node && { props: node.props, tree: node.type(node.props) }
}

test('a result card names caption style and track settings changes and lists the edit notes', async () => {
  const { changeReceipt } = await import('../web/ui/change-receipt.js')
  const at = Date.now() - 5000
  const before = { width: 1080, height: 1920, comps: {}, tracks: [{ id: 'V1', kind: 'video', clips: [] }, { id: 'C1', kind: 'caption', style: { size: 60 }, clips: [] }, { id: 'A1', kind: 'audio', clips: [] }] }
  const caption = structuredClone(before); caption.tracks[1].style.size = 72
  const track = structuredClone(before); track.tracks[2].muted = true
  const captionReceipt = { ...changeReceipt(before, caption, { who: 'agent', version: 2, at: at + 1000 }), notes: ['C1 captions are 72 units tall.'] }
  const trackReceipt = changeReceipt(before, track, { who: 'agent', version: 3, at: at + 1000 })
  const chat = [{ role: 'user', text: 'Make the captions bigger', at }]
  const card = receipt => resultCard(panel({ state: 'done' }, true, { chat, receipts: [receipt], project: caption }))
  const captioned = card(captionReceipt), muted = card(trackReceipt)
  assert.equal(textContent(nodes(captioned.tree).find(node => node.props?.class === 'assistant-result-caption')), 'Caption style changed')
  assert.equal(textContent(nodes(muted.tree).find(node => node.props?.class === 'assistant-result-caption')), 'Track settings changed')
  assert.deepEqual(nodes(captioned.tree).filter(node => node.props?.class === 'assistant-note').map(textContent), ['C1 captions are 72 units tall.'])
  assert.deepEqual(nodes(muted.tree).filter(node => node.props?.class === 'assistant-note'), [])
})

test('Redo brings a change back, so its result card is no longer marked undone', async () => {
  const { changeReceipt } = await import('../web/ui/change-receipt.js')
  const at = Date.now() - 5000
  const before = { comps: {}, tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'title', start: 0, dur: 2 }] }] }
  const after = structuredClone(before); after.tracks[0].clips[0].dur = 3
  const receipt = { ...changeReceipt(before, after, { who: 'agent', version: 5, at: at + 1000 }), undone: true, undoneBy: 'ch1' }
  const chat = [{ role: 'user', text: 'Make the title longer', at }]
  const change = { id: 'ch1', kind: 'request', beforeVersion: 4, afterVersion: 5, edits: 1, undoable: true }
  const undone = resultCard(panel({ state: 'done' }, true, { chat, receipts: [receipt], project: after, review: { change: null } }))
  assert.equal(undone.props.receipts[0].undone, true)
  assert.equal(undone.tree.props['aria-label'], 'Undone edit result')
  const redone = resultCard(panel({ state: 'done' }, true, { chat, receipts: [receipt], project: after, review: { change } }))
  assert.equal(redone.props.receipts[0].undone, false)
  assert.equal(redone.tree.props['aria-label'], 'Committed edit result')
  assert.ok(nodes(redone.tree).some(node => node.type === 'button' && textContent(node) === 'Undo this change'))
  // An undone preview keeps its name.
  const undonePreview = resultCard(panel({ state: 'done' }, true, { chat, receipts: [{ ...receipt, changeKind: 'preview' }], project: after, review: { change: null } }))
  assert.equal(textContent(nodes(undonePreview.tree).find(node => node.type === 'b')), 'Applied the preview')
  // Another change coming back leaves this one undone.
  const other = resultCard(panel({ state: 'done' }, true, { chat, receipts: [receipt], project: after, review: { change: { ...change, id: 'ch2' } } }))
  assert.equal(other.props.receipts[0].undone, true)
})

test('a failed turn lists what was saved and offers Retry only for the same retryable request', () => {
  const at = Date.now() - 5000
  const chat = [{ role: 'user', text: 'Add a title card', at }]
  const failed = (claude, lastSent) => nodes(panel({ state: 'error', runId: 'r1', startedAt: at, finishedAt: at + 3000, ...claude }, true, { chat, lastSent })).find(node => node.props?.class === 'assistant-failure')
  const buttons = block => nodes(block).filter(node => node.type === 'button').map(textContent)
  const committed = [{ version: 7, summary: 'Added a title' }]
  const saved = failed({ committed }, null)
  assert.equal(textContent(nodes(saved).find(node => node.type === 'b')), 'Saved before the failure')
  assert.deepEqual(nodes(saved).filter(node => node.type === 'li').map(textContent), ['Added a title'])
  assert.deepEqual(buttons(saved), ['Edit and retry'], 'no plain Retry without a retryable failure')
  assert.deepEqual(buttons(failed({ retryable: true }, null)), ['Edit and retry'], 'not a request this panel sent')
  assert.deepEqual(buttons(failed({ retryable: true }, { request: { text: 'Add a title card' }, runId: 'r0' })), ['Edit and retry'], 'an earlier request')
  assert.deepEqual(buttons(failed({ retryable: false }, { request: { text: 'Add a title card' }, runId: 'r1' })), ['Edit and retry'])
  assert.deepEqual(buttons(failed({ retryable: true }, { request: { text: 'Add a title card' }, runId: 'r1' })), ['Edit and retry', 'Retry'])
  assert.equal(nodes(failed({ retryable: true, committed: [] }, null)).some(node => node.props?.class === 'assistant-saved'), false, 'nothing saved, nothing listed')
})

test('a quiet divider marks where a new server session begins', () => {
  const now = Date.now()
  const chat = [{ role: 'user', text: 'Trim the end', at: now - 60000 }, { role: 'claude', text: 'Trimmed.', at: now - 59000 }, { role: 'user', text: 'Add a fade', at: now - 1000 }]
  const dividers = session => nodes(panel({ state: 'idle' }, true, { chat, session })).filter(node => node.props?.class === 'assistant-session-divider')
  const split = dividers({ id: 's2', startedAt: now - 30000 })
  assert.deepEqual(split.map(textContent), ['New session']); assert.equal(split[0].props.role, 'separator')
  assert.deepEqual(dividers({ id: 's1', startedAt: now - 120000 }), [], 'every turn is from this session')
  assert.deepEqual(dividers(null), [])
})

test('idle composer has current context, draft and one Send action beside model controls', () => {
  const tree = panel({ state: 'idle' })
  const all = nodes(tree), card = all.find(node => node.props?.class === 'assistant-composer-card')
  assert.ok(card)
  assert.ok(nodes(card).some(node => node.type === 'textarea'))
  assert.ok(nodes(card).some(node => node.props?.class === 'assistant-context-chips'))
  const footer = nodes(nodes(card).find(node => node.props?.class === 'assistant-field')).find(node => node.props?.class === 'assistant-field-bar')
  assert.ok(footer)
  assert.equal(nodes(footer).filter(node => node.props?.['aria-label'] === 'Send message').length, 1)
  assert.equal(all.filter(node => node.props?.['aria-label'] === 'Send message').length, 1)
})

test('stopping action remains in the primary action location with a disabled receipt', () => {
  const tree = panel({ state: 'cancelling' })
  const primary = nodes(tree).find(node => node.props?.class === 'assistant-primary-action')
  const button = nodes(primary).find(node => node.type === 'button')
  assert.equal(button.props['aria-label'], 'Stopping request')
  assert.equal(button.props.title, 'Stopping request')
  assert.equal(textContent(button), 'Stopping…')
  assert.equal(button.props.class, 'assistant-stop', 'the same control, not a second one')
  assert.equal(button.props.disabled, true)
  assert.equal(nodes(tree).filter(node => node.props?.['aria-label'] === 'Send message').length, 0)
})


test('Edit request restores only user text without dispatch or old references', () => {
  let restored, dispatched = 0
  const tree = panel({ state: 'error' }, true, { chat: [{ role: 'user', text: 'Tighten the current selection', refs: [{ label: 'Old frame' }] }], onDraft: value => { restored = value }, api: () => { dispatched++ } })
  const edit = nodes(tree).find(node => node.type === 'button' && children(node).includes('Edit request'))
  assert.ok(edit)
  assert.equal(edit.props.disabled, false)
  edit.props.onClick()
  assert.equal(restored, 'Tighten the current selection')
  assert.equal(dispatched, 0)
})

test('existing drafts and active requests disable Edit request', () => {
  for (const [run, draft] of [[{ state: 'done' }, 'Keep this draft'], [{ state: 'working' }, '']]) {
    const tree = panel(run, true, { draft, chat: [{ role: 'user', text: 'An earlier request' }] })
    const edit = nodes(tree).find(node => node.type === 'button' && children(node).includes('Edit request'))
    assert.ok(edit)
    assert.equal(edit.props.disabled, true)
  }
  const reply = panel({ state: 'done' }, true, { chat: [{ role: 'claude', text: 'Finished' }] })
  assert.equal(nodes(reply).some(node => node.type === 'button' && children(node).includes('Edit request')), false)
})

const { changeReceipt, receiptSelection } = await import('../web/ui/change-receipt.js')
const receiptComponent = new Function('h', 'htm', 'receiptSelection', 'store', 'set', 'toast', 'player', 'assistantPanel', `${source}\nreturn ResultCard`)
function renderReceipt(receipt, project, change = null) {
  const updates = [], seeks = [], messages = []
  const component = receiptComponent(h, htm, receiptSelection, { project }, update => updates.push(update),
    message => messages.push(message), { seek: value => seeks.push(value) }, assistantPanel)
  const card = component({ receipts: [receipt], change })
  const expand = node => typeof node?.type === 'function' ? expand(node.type(node.props)) : node && typeof node === 'object' ? { ...node, props: { ...node.props, children: flatten(node.props.children).map(expand) } } : node
  return { tree: expand(card), updates, seeks, messages }
}
const receiptFixture = () => ({ tracks: [{ id: 'A3', name: 'Music', kind: 'audio', clips: [{ id: 'music', start: 4, dur: 14, label: 'Reviewed cue' }] }],
  assets: {}, comps: { nested: { name: 'Nested mix', tracks: [{ id: 'A3', clips: [{ id: 'music', start: 20, dur: 14 }] }] } } })

test('saved-only asset receipt renders its actual path and metadata without a layer selection action', () => {
  const before = receiptFixture(), after = structuredClone(before)
  after.assets['media/generated/music/owned/score.wav'] = { name: 'Reviewed cue', generated: { kind: 'original-music', renderer: 'arya-score-synth/1' } }
  const receipt = changeReceipt(before, after, { who: 'agent', version: 7 })
  const { tree } = renderReceipt(receipt, after), all = nodes(tree), text = textContent(tree)
  assert.match(text, /1 Media asset changed/)
  assert.match(text, /Media registration · added/)
  assert.doesNotMatch(text, /Project settings changed/)
  assert.match(text, /assets\["media\/generated\/music\/owned\/score\.wav"\]/)
  assert.match(text, /Reviewed cue/)
  assert.match(text, /Absent/)
  assert.equal(all.some(node => node.type === 'button'), false)
  const json = JSON.parse(children(all.find(node => node.type === 'pre')).join(''))
  assert.equal(json.totalLayers, 0)
  assert.equal(json.totalScopes, 1)
  assert.equal(json.scopes[0].changes[0].before, 'Absent')
  assert.equal(all.some(node => node.props?.dangerouslySetInnerHTML), false)
})

test('track-only receipt renders the settings group and committed before and after values', () => {
  const before = receiptFixture(), after = structuredClone(before)
  before.tracks[0].volume = 0
  after.tracks[0].volume = -6
  const receipt = changeReceipt(before, after, { who: 'agent', version: 8 })
  const { tree } = renderReceipt(receipt, after), text = textContent(tree)
  assert.match(text, /Track A3 · Music · Main timeline/)
  assert.match(text, /Track settings · changed/)
  assert.match(text, /volume0→-6/)
  assert.equal(nodes(tree).some(node => node.type === 'button'), false)
})

test('changed-layer action selects the composition and seeks the current surviving layer position', () => {
  const before = receiptFixture(), after = structuredClone(before)
  after.comps.nested.tracks[0].clips[0].volume = -6
  const receipt = changeReceipt(before, after, { who: 'agent', version: 9 })
  const current = structuredClone(after)
  current.comps.nested.tracks[0].clips[0].start = 32
  const { tree, updates, seeks } = renderReceipt(receipt, current)
  const button = nodes(tree).find(node => node.type === 'button')
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  assert.deepEqual(updates, [{ openComp: 'nested', selection: ['music'], page: 'edit', viewerMode: 'timeline' }])
  assert.deepEqual(seeks, [32])
  delete current.comps.nested
  const stale = renderReceipt(receipt, current), staleButton = nodes(stale.tree).find(node => node.type === 'button')
  assert.equal(staleButton.props.disabled, true)
  staleButton.props.onClick()
  assert.deepEqual(stale.updates, [])
  assert.deepEqual(stale.seeks, [])
  assert.deepEqual(stale.messages, ['Those layers are no longer in the project.'])
})

test('shortened scope values visibly declare truncation even when every entry is shown', () => {
  const before = receiptFixture(), after = structuredClone(before)
  after.master = { note: 'x'.repeat(3000) }
  const receipt = changeReceipt(before, after, { who: 'agent', version: 10 })
  assert.equal(receipt.truncated, true)
  assert.equal(receipt.scopes.length, receipt.totalScopes)
  const { tree } = renderReceipt(receipt, after)
  assert.match(textContent(tree), /Some changes or values are shortened\. Showing 0 of 0 changed layers and 1 of 1 settings groups\./)
  const json = JSON.parse(children(nodes(tree).find(node => node.type === 'pre')).join(''))
  assert.equal(json.truncated, true)
})

test('receipts created before settings groups remain renderable', () => {
  const receipt = { version: 4, total: 0, clips: [], projectChanges: ['fps'], truncated: false }
  const { tree } = renderReceipt(receipt, receiptFixture())
  assert.match(textContent(tree), /Project settings changed/)
  assert.match(textContent(tree), /fps/)
  assert.equal(nodes(tree).some(node => node.type === 'button'), false)
})

const expiredStatus = (mode, loading = false) => ({ provider: 'codex', mode, configured: false, loading, reason: 'No enabled model has a current catalog and a ready editing adapter.',
  providers: [{ id: 'codex', installed: true, authenticated: true, available: true, reason: 'Signed in.' }],
  catalogs: [{ provider: 'codex', complete: true, source: { kind: 'provider-cli' }, checkedAt: Date.now() - 300001 }],
  autoPreview: mode === 'auto' ? { ok: false, blocked: [{ provider: 'codex', model: 'exact', reason: 'The model catalog needs a refresh.' }] } : null,
  manualPreview: mode === 'manual' ? { ok: false, recovery: 'refresh-model-efforts' } : null })

test('expired Auto and Manual catalogs render refresh controls while keeping Send disabled', async () => {
  for (const mode of ['auto', 'manual']) {
    const calls = []
    const tree = panel({ state: 'idle' }, true, { draft: 'Keep this request', status: expiredStatus(mode), refresh: async body => calls.push(body) })
    assert.match(textContent(tree), /Model availability needs a refresh/)
    assert.doesNotMatch(textContent(tree), /Connect your editing assistant|Set up assistant/)
    assert.equal(nodes(tree).find(node => node.props?.['aria-label'] === 'Send message').props.disabled, true)
    const retry = nodes(tree).find(node => node.type === 'button' && children(node).includes('Refresh availability'))
    assert.equal(retry.props.disabled, false)
    await retry.props.onClick()
    assert.deepEqual(calls, [{ refresh: true }])
    assert.equal(nodes(tree).find(node => node.type === 'textarea').props.value, 'Keep this request')
  }
})

test('refresh in progress has a status message and a Settings control', () => {
  const tree = panel({ state: 'idle' }, true, { status: expiredStatus('auto', true) })
  assert.match(textContent(tree), /Refreshing model availability/)
  assert.ok(nodes(tree).some(node => node.type === 'button' && children(node).includes('Assistant settings')))
  const retry = nodes(tree).find(node => node.type === 'button' && children(node).includes('Refreshing…'))
  assert.equal(retry.props.disabled, true)
})

test('confirmed sign-out still renders the connection controls', () => {
  const status = expiredStatus('manual'); status.providers[0].authenticated = false; status.providers[0].available = false
  const tree = panel({ state: 'idle' }, true, { status })
  assert.match(textContent(tree), /Codex: Sign-in needed/)
  assert.match(textContent(tree), /Assistant settings/)
  assert.doesNotMatch(textContent(tree), /Refresh availability/)
})

const sharingScope = { providers: ['codex'], models: [{ provider: 'codex', model: 'exact' }], companion: 'http://127.0.0.1:4900/', classes: ['prompt', 'project_context', 'project_content', 'tool_results', 'rendered_frames', 'reference_images', 'conversation_history'] }
test('actual ChatPanel reviews sharing before dispatch and forwards the approved envelope', async () => {
  const calls = [], drafts = [], sharing = { version: 1, approved: true, scope: sharingScope }
  const tree = panel({ state: 'idle' }, true, { draft: 'Refine this selection', onDraft: value => drafts.push(value), api: async (path, body) => {
    calls.push({ path, body })
    if (path === '/api/assistant/sharing') return { version: 1, approved: true, scope: sharingScope, sharing }
    return { queued: 'fixture-run' }
  } })
  await nodes(tree).find(node => node.props?.['aria-label'] === 'Send message').props.onClick()
  assert.deepEqual(calls.map(call => call.path), ['/api/assistant/sharing', '/api/bridge/send'])
  assert.deepEqual(calls[1].body.sharing, sharing)
  assert.equal(calls[1].body.text, 'Refine this selection')
  assert.deepEqual(drafts, [''])
})

test('actual ChatPanel keeps the draft and never dispatches if sharing review fails', async () => {
  const calls = [], drafts = []
  const tree = panel({ state: 'idle' }, true, { draft: 'Keep this draft', onDraft: value => drafts.push(value), api: async path => { calls.push(path); throw new Error('No verified recipient.') } })
  await nodes(tree).find(node => node.props?.['aria-label'] === 'Send message').props.onClick()
  assert.deepEqual(calls, ['/api/assistant/sharing'])
  assert.deepEqual(drafts, [])
})
