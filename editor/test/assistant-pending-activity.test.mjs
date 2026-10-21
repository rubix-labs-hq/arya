import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceRoot = process.env.ARYA_PENDING_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const dependencyRoot = process.env.ARYA_PENDING_DEPENDENCY_ROOT ?? sourceRoot
const require = createRequire(path.join(dependencyRoot, 'package.json'))
const { h } = require('preact'), htm = require('htm')
const activitySource = fs.readFileSync(path.join(sourceRoot, 'web/ui/assistant-activity.js'), 'utf8')
const { assistantActivity } = await import(`data:text/javascript;base64,${Buffer.from(activitySource).toString('base64')}`)
const { assistantState, assistantPrompt, providerName } = await import(pathToFileURL(path.join(dependencyRoot, 'web/ui/assistant-state.js')).href)
const { normalizeSharingScope, normalizeSharingEnvelope, sameSharingScope } = await import(pathToFileURL(path.join(dependencyRoot, 'core/assistant-sharing.mjs')).href)
const script = await import(pathToFileURL(path.join(dependencyRoot, 'web/ui/assistant-script.js')))
const { assistantPanel } = await import(pathToFileURL(path.join(sourceRoot, 'web/ui/assistant-panel.js')))
const { Icon } = await import(pathToFileURL(path.join(dependencyRoot, 'web/ui/icons.js')))
const chatSource = fs.readFileSync(path.join(dependencyRoot, 'web/ui/chat.js'), 'utf8').replace(/^import .*$/gm, '').replace('export function ChatPanel', 'function ChatPanel')
const sharingSource = fs.readFileSync(path.join(dependencyRoot, 'web/ui/assistant-sharing.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
// Execute the actual consent gate and modal with inert focus hooks. Requests use
// injected callbacks; Preact and HTM build the real component templates.
const sharing = new Function('h', 'htm', 'useEffect', 'useRef', 'normalizeSharingScope', 'normalizeSharingEnvelope', 'sameSharingScope', `${sharingSource}\nreturn {createAssistantSharingGate,AssistantSharingReview}`)(h, htm, () => {}, value => ({ current: value }), normalizeSharingScope, normalizeSharingEnvelope, sameSharingScope)
const renderPanel = new Function('Icon', 'h', 'htm', 'useEffect', 'useRef', 'useState', 'useStore', 'assistantActivity', 'assistantState', 'assistantPrompt', 'providerName', 'useTime', 'refreshAssistantStatus', 'api', 'set', 'store', 'time', 'toast', 'receiptSelection', 'player', 'AssistantControls', 'RoutingReceipt', 'createAssistantSharingGate', ...Object.keys(script), 'assistantPanel', `${chatSource}\nreturn ChatPanel()`)
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const nodes = value => value && typeof value === 'object' ? [value, ...flatten(value.props?.children).flatMap(nodes)] : []
const text = value => flatten(value?.props?.children).map(child => typeof child === 'object' ? text(child) : child).join(' ').replace(/\s+/g, ' ').trim()
const card = tree => nodes(tree).find(node => node.props?.class?.startsWith('assistant-run '))
const scope = { providers: ['codex'], models: [{ provider: 'codex', model: 'fixture-model' }], companion: 'http://127.0.0.1:4900/', classes: ['prompt', 'project_context', 'project_content', 'tool_results', 'rendered_frames', 'reference_images', 'conversation_history'] }
const review = { version: 1, approved: false, reviewID: 'offline-review', scope }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

test('pending presentation over aged idle metadata has no old elapsed time or stale stage', () => {
  const stored = Object.freeze({ state: 'idle', startedAt: null, updatedAt: 0, phase: '' })
  const result = assistantActivity(stored, { pending: true, now: 164000 })
  assert.equal(result.state, 'sending'); assert.equal(result.label, 'Sending request')
  assert.equal(result.detail, 'Preparing your request.'); assert.equal(result.elapsed, '')
  assert.equal(result.active, true); assert.equal(result.canStop, false)
  assert.deepEqual(stored, { state: 'idle', startedAt: null, updatedAt: 0, phase: '' })
})

test('pending presentation does not inherit terminal timestamps, phase or outcome', () => {
  for (const state of ['done', 'cancelled', 'error']) {
    const stored = Object.freeze({ state, startedAt: 1000, updatedAt: 2000, finishedAt: 5000, phase: 'Previous stored stage', outcome: 'Previous outcome' })
    const result = assistantActivity(stored, { pending: true, now: 164000 })
    assert.equal(result.detail, 'Preparing your request.'); assert.equal(result.elapsed, '')
    assert.equal(result.state, 'sending'); assert.equal(result.terminal, false)
    assert.equal(assistantActivity(stored, { now: 999000 }).elapsed, '4s')
    assert.equal(stored.phase, 'Previous stored stage'); assert.equal(stored.outcome, 'Previous outcome')
  }
})

test('real active run events keep their elapsed time and confirmed stage despite local pending', () => {
  for (const state of ['sending', 'queued', 'thinking', 'running', 'working', 'cancelling']) {
    const run = { state, startedAt: 1000, updatedAt: 2000, phase: 'Inspecting current frame' }
    const result = assistantActivity(run, { pending: true, now: 62000 })
    assert.deepEqual(result, assistantActivity(run, { pending: false, now: 62000 }))
    assert.equal(result.elapsed, '1m 01s')
    if (state !== 'cancelling') assert.match(result.detail, /Last confirmed stage: Inspecting current frame/)
  }
})

test('real stopping, stop uncertainty and disconnected status keep their existing messages', () => {
  const run = { state: 'done', startedAt: 1000, updatedAt: 2000, finishedAt: 5000, phase: 'Previous stage' }
  const stopping = assistantActivity(run, { pending: true, stopping: true, now: 62000 })
  assert.equal(stopping.state, 'cancelling'); assert.equal(stopping.elapsed, '1m 01s')
  assert.equal(stopping.detail, 'Waiting for the agent and its processing to stop.'); assert.equal(stopping.canStop, false)
  const unconfirmed = assistantActivity({ ...run, state: 'error', stopUnconfirmed: true }, { pending: true, now: 62000 })
  assert.equal(unconfirmed.label, 'Stop unconfirmed'); assert.match(unconfirmed.detail, /Stopping could not be confirmed/)
  const unconfirmedStop = assistantActivity({ ...run, stopUnconfirmed: true }, { pending: true, stopping: true, now: 62000 })
  assert.equal(unconfirmedStop.elapsed, '1m 01s'); assert.equal(unconfirmedStop.label, 'Stop unconfirmed')
  const disconnected = assistantActivity(run, { pending: true, connected: false, now: 62000 })
  assert.equal(disconnected.label, 'Reconnecting'); assert.match(disconnected.detail, /request may still be running/)
})

function panelFixture(t, run) {
  const values = [], refs = [], effects = [], calls = [], secondReview = deferred(), submission = deferred()
  const state = { claude: run, connected: true, caps: {}, assistantStatus: { provider: 'codex', configured: true }, chat: [{ role: 'claude', text: 'Stored response', at: 1 }], activity: [], receipts: [{ version: 3, total: 0, clips: [], projectChanges: [], at: 1 }], selection: [], refs: [{ kind: 'clip', id: 'c1', label: 'Current reference' }], project: { comps: {} }, openComp: null }
  state.root = '/fixture'; state.assistantDraft = { root: '/fixture', text: 'Keep and resend this draft', inputKind: 'prompt' }
  const originalRefs = state.refs, originalReceipts = state.receipts
  let stateIndex, refIndex, reviewCalls = 0
  const api = async (url, body) => {
    calls.push({ url, body })
    if (url === '/api/assistant/sharing') { reviewCalls++; return reviewCalls === 1 ? review : secondReview.promise }
    if (url === '/api/bridge/send') return submission.promise
    if (url === '/api/assistant/cancel') return { cancelled: true }
    assert.fail(`Unexpected fixture API call: ${url}`)
  }
  const render = () => {
    stateIndex = 0; refIndex = 0
    return renderPanel(Icon, h, htm, action => effects.push(action), value => { const i = refIndex++; return refs[i] ??= { current: value } }, value => {
      const i = stateIndex++; if (!(i in values)) values[i] = value
      return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next }]
    }, () => state, assistantActivity, assistantState, assistantPrompt, providerName, () => 0, () => { assert.fail('No status request is expected.') }, api,
    patch => Object.assign(state, patch), state, { t: 0 }, message => { assert.fail(`Unexpected fixture toast: ${message}`) }, () => null, {}, () => null, () => null, sharing.createAssistantSharingGate, ...Object.values(script), assistantPanel)
  }
  const modal = () => sharing.AssistantSharingReview({ review: state.assistantSharingReview, busy: state.assistantSharingBusy, onAllow: state.assistantSharingActions.allow, onDecline: state.assistantSharingActions.decline, onStop: state.assistantSharingActions.stop })
  t.after(() => { refs.forEach(ref => ref.current?.dispose?.()); secondReview.resolve(review); submission.resolve({ queued: 'offline-run' }) })
  return { render, modal, state, calls, secondReview, submission, originalRefs, originalReceipts, draft: () => state.assistantDraft.text }
}

for (const stored of [
  { name: 'aged idle snapshot', run: { state: 'idle', startedAt: null, updatedAt: 0, phase: '' } },
  { name: 'completed stored snapshot', run: { state: 'done', startedAt: 1000, updatedAt: 2000, finishedAt: 5000, phase: 'Previous stored stage', outcome: 'Previous outcome' } },
]) test(`actual ChatPanel Keep draft then resend shows fresh preparation over ${stored.name}`, async t => {
  t.mock.method(Date, 'now', () => 164000)
  const run = Object.freeze(stored.run), f = panelFixture(t, run)
  const first = nodes(f.render()).find(node => node.props?.['aria-label'] === 'Send message').props.onClick()
  await tick()
  assert.equal(f.state.assistantSharingReview.reviewID, 'offline-review')
  const decline = nodes(f.modal()).find(node => node.type === 'button' && text(node) === 'Keep draft')
  assert.ok(decline); decline.props.onClick(); await first
  assert.deepEqual(f.calls.map(call => call.url), ['/api/assistant/sharing'])
  assert.equal(f.draft(), 'Keep and resend this draft'); assert.equal(f.state.claude, run)
  assert.equal(f.state.refs, f.originalRefs); assert.equal(f.state.receipts, f.originalReceipts)
  const afterDecline = f.render()
  if (run.state === 'done') { assert.match(text(card(afterDecline)), /Response finished/); assert.match(text(card(afterDecline)), /Previous outcome/); assert.match(text(card(afterDecline)), /4s/) }
  const resend = nodes(afterDecline).find(node => node.props?.['aria-label'] === 'Send message').props.onClick()
  await tick()
  const pendingTree = f.render(), pendingCard = card(pendingTree)
  assert.ok(pendingCard); assert.match(text(pendingCard), /Sending request/); assert.match(text(pendingCard), /Preparing your request\./)
  assert.doesNotMatch(text(pendingCard), /No update|Last confirmed stage|Previous stored stage|Previous outcome/)
  assert.equal(nodes(pendingCard).some(node => node.props?.class === 'assistant-run-time'), false)
  assert.equal(f.state.claude, run); assert.equal(f.state.receipts, f.originalReceipts)
  assert.deepEqual(f.calls.map(call => call.url), ['/api/assistant/sharing', '/api/assistant/sharing'])
  const envelope = { version: 1, approved: true, scope }
  f.secondReview.resolve({ ...review, approved: true, sharing: envelope }); await tick()
  assert.equal(f.calls.at(-1).url, '/api/bridge/send'); assert.equal(f.calls.at(-1).body.text, f.draft())
  f.state.claude = { state: 'working', startedAt: 160000, updatedAt: 164000, phase: 'Inspecting current frame' }
  const active = card(f.render())
  assert.match(text(active), /Using tools/); assert.match(text(active), /Inspecting current frame/); assert.match(text(active), /4s/)
  assert.doesNotMatch(text(active), /Preparing your request/)
  f.submission.resolve({ queued: 'offline-run' }); await resend
  assert.equal(f.draft(), '')
  assert.deepEqual(f.state.refs, []); assert.equal(f.state.receipts, f.originalReceipts)
})


test('Stop cancels a submitted request before the first run status event arrives', async t => {
  const f = panelFixture(t, { state: 'idle' })
  const first = nodes(f.render()).find(node => node.props?.['aria-label'] === 'Send message').props.onClick()
  await tick()
  nodes(f.modal()).find(node => node.type === 'button' && text(node) === 'Keep draft').props.onClick()
  await first
  const resend = nodes(f.render()).find(node => node.props?.['aria-label'] === 'Send message').props.onClick()
  await tick()
  f.secondReview.resolve({ ...review, approved: true, sharing: { version: 1, approved: true, scope } })
  await tick()
  assert.equal(f.calls.at(-1).url, '/api/bridge/send')
  assert.equal(f.state.claude.state, 'idle', 'the stream has not confirmed admission yet')
  const stop = nodes(f.render()).find(node => node.type === 'button' && text(node) === 'Stop request')
  assert.equal(stop.props.disabled, false)
  await stop.props.onClick()
  assert.equal(f.calls.at(-1).url, '/api/assistant/cancel')
  f.submission.resolve({ queued: 'offline-run' })
  await resend
})
