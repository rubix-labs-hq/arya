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
import { createToolOutcomes, editedOutcome, unfinishedJobsOutcome, unresolvedToolOutcome } from '../agent/tool-outcomes.mjs'

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
function panel(run, connected = true, { stateSlots = null, version = undefined, history = undefined, draft = '', chat = [], activity = [], receipts = [], review = null, previewShown = null, session = null, project = { comps: {} }, lastSent = null, patches = [], onDraft = () => {}, api = () => {}, toast = () => {}, status = { provider: 'codex', configured: true }, refresh = async () => {} } = {}) {
  const state = { claude: run, connected, caps: {}, assistantStatus: status, assistantReview: review, previewShown, session,
    root: '/fixture', assistantDraft: { root: '/fixture', text: draft, inputKind: 'prompt' }, chat, activity, receipts, selection: [], refs: [], project, openComp: null }
  let refIndex = 0
  const useRef = value => ({ current: refNames[refIndex++] === 'lastSent' && lastSent ? lastSent : value })
  // `stateSlots` keeps useState values between renders of the same panel, in hook order.
  let stateIndex = 0
  const useState = stateSlots ? value => { const at = stateIndex++; if (!(at in stateSlots)) stateSlots[at] = value; return [stateSlots[at], next => { stateSlots[at] = next }] } : value => [value, () => {}]
  if (version !== undefined) Object.assign(state, { version, history })
  return render(Icon, h, htm, () => {}, useRef, useState, () => state,
    assistantActivity, assistantState, assistantPrompt, providerName, () => 0, refresh, api, patch => { patches.push(patch); Object.assign(state, patch); if (patch.assistantDraft) onDraft(patch.assistantDraft.text) }, state, { t: 0 }, toast, () => {}, {}, () => null, () => null, () => null, createAssistantSharingGate, ...Object.values(script), assistantPanel)
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

test('inside a turn the reply comes first, then one result card, and a finished run adds no Done line of its own', async () => {
  const { changeReceipt } = await import('../web/ui/change-receipt.js')
  const at = Date.now() - 5000
  const before = { tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'title', start: 0, dur: 2 }] }], comps: {} }
  const after = structuredClone(before); after.tracks[0].clips[0].dur = 3
  const receipt = changeReceipt(before, after, { who: 'agent', version: 5, at: at + 2000 })
  const options = { chat: [{ role: 'user', text: 'Make the title longer', at }, { role: 'claude', text: 'Done.', at: at + 3000 }],
    activity: [{ who: 'agent', text: 'Calling apply_ops', at: at + 1000 }], receipts: [receipt] }
  const order = tree => children(nodes(tree).find(node => node.props?.class === 'assistant-turn')).map(node => typeof node.type === 'function' ? node.type.name : node.props?.class)
  const run = { state: 'done', startedAt: at, finishedAt: at + 4000, outcome: 'This request made 1 edit. Review it in the timeline.' }
  assert.deepEqual(order(panel(run, true, options)), ['msg user', 'msg claude', 'ResultCard'], 'the card is the Done line')
  // The request's route still needs a place, so the line stays for it without repeating what the card says.
  const routed = panel({ ...run, routing: { ok: true } }, true, options)
  assert.deepEqual(order(routed), ['msg user', 'msg claude', 'assistant-run done', 'ResultCard'])
  const line = nodes(routed).find(node => node.props?.class === 'assistant-run done')
  assert.equal(nodes(line).some(node => node.props?.class === 'assistant-run-stage'), false, 'no outcome sentence beside the card')
  assert.ok(nodes(line).some(node => node.props?.class === 'assistant-route'))
  // The line that gave way took the tool updates with it, so the card's Details list them. A line that stayed keeps them.
  const updatesIn = tree => nodes(tree).filter(node => node.props?.['aria-label'] === 'Tool updates').flatMap(list => nodes(list).filter(node => node.type === 'li').map(textContent))
  const carded = resultCard(panel(run, true, options))
  assert.deepEqual(updatesIn(nodes(carded.tree).find(node => node.props?.class === 'change-receipt')), ['Calling apply_ops'])
  assert.deepEqual(updatesIn(line), ['Calling apply_ops']); assert.deepEqual(resultCard(routed).props.updates, [])
  // An older turn that succeeded has no line either, and its card keeps its tool updates too.
  const older = panel({ state: 'idle' }, true, { ...options, chat: [...options.chat, { role: 'user', text: 'Thanks', at: at + 3500 }] })
  assert.deepEqual(order(older), ['msg user', 'msg claude', 'ResultCard']); assert.deepEqual(updatesIn(resultCard(older).tree), ['Calling apply_ops'])
  // A request that saved an edit and ended with a failed processing job keeps its whole line: the warning is not the card's to say.
  const warning = unfinishedJobsOutcome([{ state: 'failed', kind: 'denoise', name: 'clip.mov', error: 'ffmpeg exited with code 1' }])
  for (const outcome of [warning, unresolvedToolOutcome({ ...createToolOutcomes(), otherPlacementFailed: true })]) {
    const warned = panel({ ...run, outcome }, true, options)
    assert.deepEqual(order(warned), ['msg user', 'msg claude', 'assistant-run done', 'ResultCard'])
    const kept = nodes(warned).find(node => node.props?.class === 'assistant-run done')
    assert.equal(textContent(nodes(kept).find(node => node.props?.class === 'assistant-run-stage')), outcome)
    assert.deepEqual(updatesIn(kept), ['Calling apply_ops']); assert.deepEqual(resultCard(warned).props.updates, [])
    assert.equal(nodes(panel({ ...run, outcome, routing: { ok: true } }, true, options)).find(node => node.props?.class === 'assistant-run-stage')?.props.title, outcome, 'and beside the route as well')
  }
  // Both sentences the server ends an ordinary edit with are the card's to say.
  for (const outcome of [editedOutcome(1, 1), editedOutcome(3, 2)]) assert.deepEqual(order(panel({ ...run, outcome }, true, options)), ['msg user', 'msg claude', 'ResultCard'], outcome)
  // With no result card the line keeps its outcome sentence.
  const bare = panel(run, true, { ...options, receipts: [] })
  assert.deepEqual(order(bare), ['msg user', 'msg claude', 'assistant-run done'])
  // A run still working keeps its line above the card of an edit it already made.
  assert.ok(order(panel({ state: 'working', startedAt: at }, true, options)).includes('assistant-run active'))
})


// ResultCard is a component, so the walker leaves it as a node. Call it with the panel's own store.
const resultCard = (tree, state = {}) => {
  const node = nodes(tree).find(node => node.type?.name === 'ResultCard')
  return node && { props: node.props, type: node.type, tree: node.type(node.props) }
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

test('a result card is undone while the server says its change is, whatever change came later', async () => {
  const { changeReceipt } = await import('../web/ui/change-receipt.js')
  const at = Date.now() - 5000
  const before = { comps: {}, tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'title', start: 0, dur: 2 }] }] }
  const after = structuredClone(before); after.tracks[0].clips[0].dur = 3
  const receipt = { ...changeReceipt(before, after, { who: 'agent', version: 5, at: at + 1000 }), changeId: 'ch1', changeKind: 'preview', changeLabel: 'Applied assistant preview' }
  const chat = [{ role: 'user', text: 'Make the title longer', at }]
  const change = { id: 'ch1', kind: 'preview', beforeVersion: 4, afterVersion: 5, edits: 1, undoable: true }
  const listed = undone => [{ id: 'ch1', kind: 'preview', beforeVersion: 4, afterVersion: 5, undone }]
  const undone = resultCard(panel({ state: 'done' }, true, { chat, receipts: [receipt], project: after, review: { change: null, changes: listed(true) } }))
  assert.equal(undone.props.receipts[0].undone, true)
  assert.equal(undone.tree.props['aria-label'], 'Undone edit result')
  assert.equal(textContent(nodes(undone.tree).find(node => node.type === 'b')), 'Applied the preview', 'an undone preview keeps its name')
  const redone = resultCard(panel({ state: 'done' }, true, { chat, receipts: [receipt], project: after, review: { change, changes: listed(false) } }))
  assert.equal(Boolean(redone.props.receipts[0].undone), false)
  assert.equal(redone.tree.props['aria-label'], 'Committed edit result')
  assert.ok(nodes(redone.tree).some(node => node.type === 'button' && textContent(node) === 'Undo this change'))
  // A later change takes the latest slot. The redone card stays applied and keeps its name.
  const later = { id: 'ch2', kind: 'request', beforeVersion: 5, afterVersion: 6, edits: 1, undoable: true }
  const longer = structuredClone(after); longer.tracks[0].clips[0].dur = 4
  const next = { ...changeReceipt(after, longer, { who: 'agent', version: 6, at: at + 3000 }), changeId: 'ch2', changeKind: 'request' }
  const kept = resultCard(panel({ state: 'done' }, true, { chat: [...chat, { role: 'user', text: 'Longer still', at: at + 2000 }], receipts: [receipt, next], project: longer, review: { change: later, changes: [...listed(false), { ...later, undone: false }] } }))
  assert.equal(Boolean(kept.props.receipts[0].undone), false)
  assert.equal(kept.tree.props['aria-label'], 'Committed edit result')
  assert.equal(textContent(nodes(kept.tree).find(node => node.type === 'b')), 'Applied the preview')
  // A receipt the server does not list is left as it is.
  const unknown = resultCard(panel({ state: 'done' }, true, { chat, receipts: [receipt], project: after, review: { change: null, changes: [] } }))
  assert.equal(unknown.props.receipts[0], receipt)
})

test('a history card is named for its move and its button says Redo, offered only as the server allows', async () => {
  const { changeReceipt } = await import('../web/ui/change-receipt.js')
  const at = Date.now() - 5000
  const before = { comps: {}, tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'title', start: 0, dur: 2 }] }] }
  const after = structuredClone(before); after.tracks[0].clips[0].dur = 3
  const receipt = { ...changeReceipt(before, after, { who: 'agent', version: 5, at: at + 1000 }), changeId: 'h1', changeKind: 'history', changeLabel: 'Undid 1 edit' }
  const chat = [{ role: 'user', text: 'Undo that', at }]
  const change = { id: 'h1', kind: 'history', label: 'Undid 1 edit', beforeVersion: 4, afterVersion: 5, edits: 1, undoable: true, reason: '' }
  const card = review => resultCard(panel({ state: 'done' }, true, { chat, receipts: [receipt], project: after, review })).tree
  const offered = card({ change, changes: [{ ...change, undone: false }] })
  assert.equal(textContent(nodes(offered).find(node => node.type === 'b')), 'Undid 1 edit')
  // The button redoes what the assistant undid, so it says Redo. An ordinary card keeps Undo.
  const buttons = tree => nodes(tree).filter(node => node.type === 'button').map(textContent)
  assert.ok(buttons(offered).includes('Redo this change')); assert.equal(buttons(offered).includes('Undo this change'), false)
  assert.match(nodes(offered).find(node => node.type === 'button' && textContent(node) === 'Redo this change').props.title, /^Redo the edits the assistant undid/)
  const working = resultCard(panel({ state: 'done' }, true, { chat, receipts: [receipt], project: after, review: { change, changes: [{ ...change, undone: false }] } }))
  assert.ok(buttons(working.type({ ...working.props, busy: 'undo' })).includes('Redoing…'), 'the busy label follows the kind')
  const plainChange = { ...change, id: 'r1', kind: 'request', label: '' }
  const plain = resultCard(panel({ state: 'done' }, true, { chat, receipts: [{ ...receipt, changeId: 'r1', changeKind: 'request', changeLabel: '' }], project: after, review: { change: plainChange, changes: [{ ...plainChange, undone: false }] } }))
  assert.ok(buttons(plain.tree).includes('Undo this change')); assert.equal(buttons(plain.tree).includes('Redo this change'), false)
  assert.ok(buttons(plain.type({ ...plain.props, busy: 'undo' })).includes('Undoing…'))
  const reason = 'Use Redo in the toolbar to bring back the edits the assistant undid.'
  const pointed = card({ change: { ...change, undoable: false, reason }, changes: [{ ...change, undone: false }] })
  assert.equal(nodes(pointed).some(node => node.type === 'button' && /this change$/.test(textContent(node))), false)
  assert.deepEqual(nodes(pointed).filter(node => node.props?.class === 'assistant-note').map(textContent), [reason])
  assert.equal(textContent(nodes(card({ change: null, changes: [] })).find(node => node.type === 'b')), 'Undid 1 edit', 'an older card keeps the name too')
})

test('a request that edited and then undid is named for both steps and says why it has no card undo', async () => {
  const { changeReceipt } = await import('../web/ui/change-receipt.js')
  const at = Date.now() - 5000
  const before = { comps: {}, tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'title', start: 0, dur: 2 }] }] }
  const after = structuredClone(before); after.tracks[0].clips[0].dur = 3
  const label = 'Made 1 edit and undid 1'
  const receipts = [5, 6].map((version, index) => ({ ...changeReceipt(before, after, { who: 'agent', version, at: at + 1000 + index }), changeId: 'm1', changeKind: 'request', changeLabel: label }))
  const chat = [{ role: 'user', text: 'Try a longer title, then go back', at }]
  const reason = 'This change left the project as it was before.'
  const change = { id: 'm1', kind: 'request', label, moves: { edit: 1, undo: 1, redo: 0 }, beforeVersion: 4, afterVersion: 6, edits: 2, undoable: false, reason }
  const card = review => resultCard(panel({ state: 'done' }, true, { chat, receipts, project: before, review })).tree
  const latest = card({ change, changes: [{ ...change, undone: false }] })
  assert.equal(textContent(nodes(latest).find(node => node.type === 'b')), label, 'the undo is not counted as an edit')
  assert.deepEqual(nodes(latest).filter(node => node.props?.class === 'assistant-note').map(textContent), [reason])
  assert.equal(textContent(nodes(card({ change: null, changes: [] })).find(node => node.type === 'b')), label, 'an older card keeps the name too')
  // A plain request that cannot be undone in one step keeps its quiet card.
  const plain = { ...change, label: 'Assistant request', moves: undefined, edits: 1, afterVersion: 5, reason: 'The project changed after this assistant change. Use Undo step by step.' }
  const quiet = resultCard(panel({ state: 'done' }, true, { chat, receipts: [{ ...receipts[0], changeLabel: 'Assistant request' }], project: after, review: { change: plain, changes: [{ ...plain, undone: false }] } })).tree
  assert.equal(textContent(nodes(quiet).find(node => node.type === 'b')), '1 change: trim')
  assert.equal(nodes(quiet).some(node => node.props?.class === 'assistant-note'), false)
})

test('a stopped request that changed nothing says so and offers Retry and Edit request', () => {
  const at = Date.now() - 5000
  const chat = [{ role: 'user', text: 'Tighten the opening', at }]
  const stopped = { state: 'cancelled', runId: 'r1', startedAt: at, finishedAt: at + 3000 }
  const tree = panel(stopped, true, { chat, review: { change: null, changes: [] }, lastSent: { request: { text: 'Tighten the opening' }, options: {}, runId: 'r1' } })
  const run = nodes(tree).find(node => node.props?.class === 'assistant-run cancelled')
  assert.equal(textContent(nodes(run).find(node => node.props?.class === 'assistant-run-stage')), 'Nothing was changed.')
  assert.equal(nodes(tree).find(node => node.props?.class?.startsWith('assistant-failure ')).props.class, 'assistant-failure stopped', 'not drawn as an error')
  const actions = nodes(tree).find(node => node.props?.class === 'assistant-failure-actions')
  assert.deepEqual(nodes(actions).filter(node => node.type === 'button').map(textContent), ['Retry', 'Edit request'])
  // Another request's run gets Edit request only.
  const other = panel(stopped, true, { chat, review: { change: null, changes: [] }, lastSent: { request: {}, options: {}, runId: 'r0' } })
  assert.deepEqual(nodes(nodes(other).find(node => node.props?.class === 'assistant-failure-actions')).filter(node => node.type === 'button').map(textContent), ['Edit request'])
})

test('a failed turn lists what was saved and offers Retry only for the same retryable request', () => {
  const at = Date.now() - 5000
  const chat = [{ role: 'user', text: 'Add a title card', at }]
  const failed = (claude, lastSent) => nodes(panel({ state: 'error', runId: 'r1', startedAt: at, finishedAt: at + 3000, ...claude }, true, { chat, lastSent })).find(node => node.props?.class === 'assistant-failure')
  const buttons = block => nodes(block).filter(node => node.type === 'button').map(textContent)
  const committed = [{ version: 7, summary: 'Added a title' }]
  const saved = failed({ committed }, null)
  assert.deepEqual(nodes(saved).filter(node => node.type === 'b').map(textContent), ['The request did not finish', 'Saved before the failure'])
  assert.deepEqual(nodes(saved).filter(node => node.type === 'li').map(textContent), ['Added a title'])
  assert.deepEqual(buttons(saved), ['Edit request'], 'no plain Retry without a retryable failure')
  assert.deepEqual(buttons(failed({ retryable: true }, null)), ['Edit request'], 'not a request this panel sent')
  assert.deepEqual(buttons(failed({ retryable: true }, { request: { text: 'Add a title card' }, runId: 'r0' })), ['Edit request'], 'an earlier request')
  assert.deepEqual(buttons(failed({ retryable: false }, { request: { text: 'Add a title card' }, runId: 'r1' })), ['Edit request'])
  assert.deepEqual(buttons(failed({ retryable: true }, { request: { text: 'Add a title card' }, runId: 'r1' })), ['Retry', 'Edit request'])
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
  assert.match(text, /Media registration · New/)
  assert.doesNotMatch(text, /Project settings changed/)
  assert.match(text, /media\/generated\/music\/owned\/score\.wav/, 'the stored path is in Technical details')
  assert.match(text, /Reviewed cue/)
  assert.match(text, /Absent/)
  assert.equal(all.some(node => node.type === 'button'), false)
  const json = JSON.parse(children(all.find(node => node.type === 'pre')).join(''))[0]
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
  assert.match(text, /A3 · Music · Main timeline/)
  assert.match(text, /Track settings · Changed/)
  assert.match(text, /Volume0 dB→-6 dB/)
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
  const json = JSON.parse(children(nodes(tree).find(node => node.type === 'pre')).join(''))[0]
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

test('a card whose change added a composition that is not open offers to open it first', () => {
  const before = { name: 'Main', tracks: [{ id: 'V1', kind: 'video', clips: [] }], comps: {} }
  const after = structuredClone(before)
  after.comps.k1 = { name: 'Sample scene', width: 1080, height: 1920, fps: 30, tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'color', color: '#123456', start: 0, dur: 2 }] }] }
  const receipt = changeReceipt(before, after, { who: 'agent', version: 3 })
  const { tree, updates } = renderReceipt(receipt, after, { id: 'p1', kind: 'preview', edits: 1, undoable: true })
  const buttons = nodes(tree).filter(node => node.type === 'button').map(textContent)
  assert.deepEqual(buttons, ['Open Sample scene', 'Undo this change', 'Select changed layers'])
  nodes(tree).find(node => node.type === 'button' && textContent(node) === 'Open Sample scene').props.onClick()
  assert.deepEqual(updates, [{ openComp: 'k1', compParents: { k1: null }, selection: [], page: 'edit', viewerMode: 'timeline', scroll: 0 }])
  // Gone again, as after Undo, there is nothing to open.
  assert.equal(nodes(renderReceipt(receipt, before).tree).some(node => node.type === 'button' && textContent(node).startsWith('Open ')), false)
})

test('the preview card asks the store to show its proposal in the viewer, and says when it does', () => {
  const proposal = { id: 'p1', baseVersion: 0, at: 1, summary: 'Add a sample title', stale: false, ops: [{ op: 'add_title', text: 'Sample', track: 'V3', start: 0, dur: 2 }], steps: [] }
  const project = { name: 'Sample', fps: 30, width: 1280, height: 720, tracks: [{ id: 'V1', kind: 'video', clips: [] }], assets: {}, comps: {} }
  const card = tree => nodes(tree).find(node => node.type === assistantPanel.PreviewCard)
  const patches = []
  const off = card(panel({ state: 'done' }, true, { review: { proposal }, project, patches }))
  assert.equal(off.props.shown, false)
  off.props.onShow(true)
  // The real store stamps the saved project, version and folder on this bare id.
  assert.deepEqual(patches.at(-1), { previewShown: { id: 'p1' }, viewerMode: 'timeline' })
  const on = card(panel({ state: 'done' }, true, { review: { proposal }, project, previewShown: { id: 'p1' }, patches }))
  assert.equal(on.props.shown, true)
  on.props.onShow(false)
  assert.deepEqual(patches.at(-1), { previewShown: null })
  assert.equal(card(panel({ state: 'done' }, true, { review: { proposal: { ...proposal, id: 'p2' } }, project, previewShown: { id: 'p1' } })).props.shown, false, 'a shown preview belongs to its own proposal')
})

test('Undo this change on a result card is refused while the viewer shows a preview', async () => {
  const { changeReceipt } = await import('../web/ui/change-receipt.js')
  const at = Date.now() - 5000
  const before = { comps: {}, tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'title', start: 0, dur: 2 }] }] }
  const after = structuredClone(before); after.tracks[0].clips[0].dur = 3
  const receipt = changeReceipt(before, after, { who: 'agent', version: 5, at: at + 1000 })
  const chat = [{ role: 'user', text: 'Make the title longer', at }]
  const change = { id: 'ch1', kind: 'preview', beforeVersion: 4, afterVersion: 5, edits: 1, undoable: true }
  const proposal = { id: 'p2', baseVersion: 5, at: 2, summary: 'Add a sample title', stale: false, ops: [{ op: 'add_title', text: 'Sample', track: 'V3', start: 0, dur: 2 }], steps: [] }
  const calls = [], toasts = []
  const options = previewShown => ({ chat, receipts: [receipt], project: after, review: { change, proposal }, previewShown, api: async (route, body) => { calls.push([route, body?.id]) }, toast: (text, kind) => toasts.push([text, kind]) })
  const shown = resultCard(panel({ state: 'done' }, true, options({ id: 'p2' })))
  await shown.props.onUndo()
  assert.deepEqual(calls, [], 'nothing reaches the server while the preview is shown')
  assert.equal(toasts.length, 1)
  assert.match(toasts[0][0], /Undo is off while the viewer shows the assistant preview/)
  assert.equal(toasts[0][1], 'error')
  const back = resultCard(panel({ state: 'done' }, true, options(null)))
  await back.props.onUndo()
  assert.deepEqual(calls, [['/api/assistant/change/undo', 'ch1']], 'Undo works again once the preview is not shown')
})

test('a history card offers a follow-up Redo only when the server says the next Redo is that change', async () => {
  const { changeReceipt } = await import('../web/ui/change-receipt.js')
  const at = Date.now() - 5000
  const before = { comps: {}, tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'title', start: 0, dur: 2 }] }] }
  const after = structuredClone(before); after.tracks[0].clips[0].dur = 3
  const receipt = { ...changeReceipt(before, after, { who: 'agent', version: 5, at: at + 1000 }), changeId: 'h1', changeKind: 'history', changeLabel: 'Undid 1 edit' }
  const chat = [{ role: 'user', text: 'Undo that', at }]
  const change = { id: 'h1', kind: 'history', label: 'Undid 1 edit', beforeVersion: 4, afterVersion: 5, edits: 1, undoable: true, reason: '' }
  const buttons = tree => nodes(tree).filter(node => node.type === 'button').map(textContent)
  // The server's answer to pressing the card. Another edit already waits in the redo history either way.
  const press = async reply => {
    const stateSlots = [], calls = []
    const options = { stateSlots, chat, receipts: [receipt], project: after, api: async (route, body) => { calls.push([route, body]); return reply } }
    const offered = resultCard(panel({ state: 'done' }, true, { ...options, review: { change, changes: [{ ...change, undone: false }] }, version: 5, history: { undo: 0, redo: 2 } }))
    assert.ok(buttons(offered.tree).includes('Redo this change'))
    await offered.props.onUndo()
    assert.deepEqual(calls, [['/api/assistant/change/undo', { id: 'h1' }]])
    return resultCard(panel({ state: 'done' }, true, { ...options, review: { change: null, changes: [{ ...change, undone: true }] }, version: 6, history: { undo: 1, redo: 1 } }))
  }
  const unrelated = await press({ undone: true, redoable: false, version: 6, history: { undo: 1, redo: 1 } })
  assert.equal(unrelated.props.onRedo, null, 'the remaining redo step is another edit')
  assert.equal(buttons(unrelated.tree).some(label => /Redo/.test(label)), false)
  // An older server that does not say is treated the same way.
  assert.equal((await press({ undone: true, version: 6, history: { undo: 1, redo: 1 } })).props.onRedo, null)
  const own = await press({ undone: true, redoable: true, version: 6, history: { undo: 1, redo: 1 } })
  assert.equal(typeof own.props.onRedo, 'function'); assert.ok(buttons(own.tree).includes('Redo this change'))
})
