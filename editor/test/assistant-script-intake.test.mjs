import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { File } from 'node:buffer'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const editor = process.env.ARYA_SCRIPT_EDITOR ?? fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(path.resolve(process.env.ARYA_SCRIPT_DEPS ?? editor, 'package.json'))
const { h } = require('preact'), htm = require('htm')
const script = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-script.js')))
const { assistantPanel } = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-panel.js')))
const { assistantState, assistantPrompt, providerName } = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-state.js')))
const { assistantActivity } = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-activity.js')))
const { createAssistantSharingGate } = await import(pathToFileURL(path.join(editor, 'web/ui/assistant-sharing.js')))
const { Icon } = await import(pathToFileURL(path.join(editor, 'web/ui/icons.js')))
const source = fs.readFileSync(path.join(editor, 'web/ui/chat.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
const dependencies = ['Icon', 'h', 'htm', 'useEffect', 'useRef', 'useState', 'useStore', 'useTime', 'assistantActivity', 'assistantState', 'assistantPrompt', 'providerName', 'refreshAssistantStatus', 'api', 'set', 'store', 'time', 'toast', 'receiptSelection', 'player', 'AssistantControls', 'RoutingReceipt', 'createAssistantSharingGate', ...Object.keys(script), 'assistantPanel']
const render = new Function(...dependencies, `${source}\nreturn ChatPanel()`)
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const nodes = value => value && typeof value === 'object' ? [value, ...flatten(value.props?.children).flatMap(nodes)] : []
const text = value => flatten(value?.props?.children).map(child => typeof child === 'object' ? text(child) : String(child)).join(' ').replace(/\s+/g, ' ').trim()
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const file = (value = 'INT. STUDIO - DAY\nA title appears.', name = 'scene.fountain') => new File([value], name, { type: 'text/plain' })
const scope = { providers: ['codex'], models: [{ provider: 'codex', model: 'exact' }], companion: 'http://127.0.0.1:4900/', classes: ['prompt', 'project_context', 'project_content', 'tool_results', 'rendered_frames', 'reference_images', 'conversation_history'] }
const sharing = { version: 1, approved: true, scope }

function fixture(overrides = {}, customAPI) {
  const state = { root: '/owned/project', project: { name: 'Fixture', tracks: [], comps: {} }, version: 1, openComp: null, chatOpen: true, caps: {}, claude: { state: 'idle' }, connected: true, assistantStatus: { provider: 'codex', configured: true, model: 'exact', catalogBound: true }, chat: [], activity: [], receipts: [], selection: ['c1'], refs: [], assistantDraft: { root: '/owned/project', text: 'Keep this draft', inputKind: 'prompt' }, ...overrides }
  const calls = [], notices = [], values = [], refs = [], effects = [], clock = { t: 12.25 }
  let hook = 0, ref = 0, effect = 0
  const api = async (route, body) => { calls.push({ route, body }); return customAPI ? customAPI(route, body) : route === '/api/assistant/sharing' ? { version: 1, approved: true, scope, sharing } : { queued: 'fixture', cancelled: true } }
  const useState = initial => { const i = hook++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value }] }
  const useRef = initial => refs[ref++] ??= { current: initial }
  const useEffect = (callback, deps) => { const i = effect++; if (deps?.length === 0 && !effects[i]) effects[i] = { cleanup: callback() } }
  const draw = () => {
    hook = 0; ref = 0; effect = 0
    return render(Icon, h, htm, useEffect, useRef, useState, () => state, () => clock.t, assistantActivity, assistantState, assistantPrompt, providerName, () => assert.fail('Unexpected refresh'), api, patch => Object.assign(state, patch), state, clock, (...notice) => notices.push(notice), () => null, {}, () => null, () => null, createAssistantSharingGate, ...Object.values(script), assistantPanel)
  }
  const unmount = () => { for (const entry of effects) entry?.cleanup?.(); state.chatOpen = false }
  return { state, calls, notices, draw, unmount }
}
const upload = tree => nodes(tree).find(node => node.type === 'input' && node.props.type === 'file')
const field = tree => nodes(tree).find(node => node.type === 'textarea')
const mode = tree => nodes(tree).find(node => node.props?.['aria-label'] === 'Assistant input kind')
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label))
async function importFile(f, value) {
  const input = upload(f.draw()); assert.ok(input, 'Actual ChatPanel exposes a local text file input')
  input.props.onClick()
  const target = { files: value ? [value] : [], value: value ? 'fixture-file' : '' }
  await input.props.onChange({ target })
  assert.equal(target.value, '')
}

test('actual ChatPanel stages a real File as Script without dispatch and retains it on reopen', async () => {
  const f = fixture(); await importFile(f, file())
  assert.equal(field(f.draw()).props.value, 'INT. STUDIO - DAY\nA title appears.')
  assert.equal(mode(f.draw()).props.value, 'script'); assert.deepEqual(f.calls, [])
  assert.match(f.notices.at(-1)[0], /Review it before sending/)
  f.unmount()
  const reopened = fixture({ ...f.state, chatOpen: true })
  assert.equal(field(reopened.draw()).props.value, f.state.assistantDraft.text)
  assert.equal(mode(reopened.draw()).props.value, 'script'); assert.deepEqual(reopened.calls, [])
})

test('explicit Screenplay survives file staging, close/reopen and an explicit consent-gated send', async () => {
  const f = fixture(); mode(f.draw()).props.onChange({ target: { value: 'screenplay' } })
  await importFile(f, file())
  assert.equal(mode(f.draw()).props.value, 'screenplay')
  f.unmount(); const reopened = fixture({ ...f.state, chatOpen: true })
  await button(reopened.draw(), 'Send message').props.onClick()
  assert.deepEqual(reopened.calls.map(call => call.route), ['/api/assistant/sharing', '/api/bridge/send'])
  assert.deepEqual(reopened.calls[1].body, { type: 'prompt', text: 'INT. STUDIO - DAY\nA title appears.', inputKind: 'screenplay', ids: ['c1'], comp: null, playhead: 12.25, refs: [], sharing, review: true })
  assert.equal(reopened.state.assistantDraft.text, '')
  assert.equal(reopened.state.assistantDraft.inputKind, 'screenplay')
})

test('ordinary three-argument Prompt payload stays compatible; explicit modes are validated', () => {
  const state = { refs: [], selection: ['c1'] }
  assert.deepEqual(assistantPrompt('Title', state, 2), { type: 'prompt', text: 'Title', ids: ['c1'], refs: [], comp: null, playhead: 2 })
  for (const inputKind of ['prompt', 'script', 'screenplay']) assert.equal(assistantPrompt('Title', state, 2, inputKind).inputKind, inputKind)
  for (const inputKind of [null, false, 3, {}, [], '', 'Screenplay']) assert.throws(() => assistantPrompt('Title', state, 2, inputKind), /Choose Prompt/)
})

for (const [label, value] of [
  ['malformed UTF-8', file(new Uint8Array([0xc3, 0x28]))],
  ['NUL binary', file('hello\0world')], ['control binary', file('hello\x01world')],
  ['oversized bytes', file('x'.repeat(script.SCRIPT_BYTE_LIMIT + 1))],
  ['too many characters', file('x'.repeat(128001))], ['empty bytes', file('')], ['whitespace only', file('  \n\t')],
  ['PDF extension', file('%PDF text', 'scene.pdf')],
  ['bytes larger than advertised', { name: 'scene.txt', size: 1, type: 'text/plain', arrayBuffer: async () => new Uint8Array(script.SCRIPT_BYTE_LIMIT + 1).buffer }],
]) test(`actual file callback preserves draft/kind on ${label}`, async () => {
  const f = fixture(); const draft = f.state.assistantDraft
  await importFile(f, value)
  assert.equal(f.state.assistantDraft, draft); assert.equal(f.notices.length, 1)
  assert.equal(f.notices[0][1], 'error'); assert.deepEqual(f.calls, [])
})

test('UTF-8 BOM, line breaks and exact decoded character bound are accepted by actual reader', async () => {
  assert.equal(await script.readAssistantScript(file(new Uint8Array([0xef, 0xbb, 0xbf, 65, 10, 9, 66]))), 'A\n\tB')
  assert.equal((await script.readAssistantScript(file('x'.repeat(128000)))).length, 128000)
})

test('picker Cancel and an empty selection leave the retained draft untouched without false feedback', async () => {
  const f = fixture(), draft = f.state.assistantDraft, input = upload(f.draw())
  input.props.onClick(); input.props.onCancel(); assert.equal(f.state.assistantDraft, draft)
  await importFile(f, null)
  assert.deepEqual(f.notices, []); assert.deepEqual(f.calls, [])
  await importFile(f, file('Next attempt')); assert.equal(f.state.assistantDraft.text, 'Next attempt')
})

test('a current file read error preserves the draft and reports only the read failure', async () => {
  const f = fixture(), draft = f.state.assistantDraft
  await importFile(f, { name: 'scene.txt', size: 1, arrayBuffer: async () => { throw new Error('The file is no longer readable.') } })
  assert.equal(f.state.assistantDraft, draft); assert.deepEqual(f.calls, [])
  assert.deepEqual(f.notices, [['The file is no longer readable.', 'error']])
})

for (const outcome of ['success', 'failure']) for (const change of ['edited draft', 'edited kind', 'project switch', 'same-root project replacement', 'version change', 'composition change', 'closed/reopened']) test(`late ${outcome} preserves ${change}`, async () => {
  const pending = deferred(), f = fixture(), input = upload(f.draw())
  input.props.onClick()
  const reading = input.props.onChange({ target: { files: [{ name: 'scene.txt', size: 5, type: 'text/plain', arrayBuffer: () => pending.promise }], value: 'fixture' } })
  if (change === 'edited draft') field(f.draw()).props.onInput({ target: { value: 'New drafting' } })
  if (change === 'edited kind') mode(f.draw()).props.onChange({ target: { value: 'screenplay' } })
  if (change === 'project switch') { f.state.root = '/other/project'; f.state.project = { name: 'Other' }; f.state.assistantDraft = { root: f.state.root, text: 'Other draft', inputKind: 'screenplay' } }
  if (change === 'same-root project replacement') f.state.project = { ...f.state.project }
  if (change === 'version change') f.state.version++
  if (change === 'composition change') f.state.openComp = 'k1'
  if (change === 'closed/reopened') { f.unmount(); f.state.chatOpen = true }
  const draft = f.state.assistantDraft
  if (outcome === 'success') pending.resolve(new TextEncoder().encode('Old file').buffer)
  else pending.reject(new Error('Old file failure'))
  await reading
  assert.equal(f.state.assistantDraft, draft); assert.deepEqual(f.notices, []); assert.deepEqual(f.calls, [])
})

test('Cancel import during an actual pending read retains draft and permits a new upload', async () => {
  const pending = deferred(), f = fixture(), input = upload(f.draw()), draft = f.state.assistantDraft
  input.props.onClick(); const reading = input.props.onChange({ target: { files: [{ name: 'scene.txt', size: 1, arrayBuffer: () => pending.promise }], value: 'fixture' } })
  button(f.draw(), 'Cancel import').props.onClick()
  await importFile(f, file('New file'))
  pending.resolve(new TextEncoder().encode('Old file').buffer); await reading
  assert.notEqual(f.state.assistantDraft, draft); assert.equal(f.state.assistantDraft.text, 'New file')
  assert.equal(f.notices.length, 1); assert.deepEqual(f.calls, [])
})

test('actual helper owned stale cancellation never cancels the newer read', async () => {
  const pending = deferred(), state = fixture().state, commits = [], busy = []
  const importer = script.createAssistantScriptImport({ state: () => state, commit: value => commits.push(value), report: () => {}, reading: value => busy.push(value), read: () => pending.promise })
  const old = importer.begin(), newer = importer.begin(), reading = importer.consume(file(), newer)
  importer.cancel(old); await importer.consume(file(), old)
  assert.equal(busy.at(-1), true)
  pending.resolve('New file'); await reading
  assert.equal(commits.length, 1); assert.equal(commits[0].text, 'New file')
})

test('a changed project displays its own empty draft and stale previous callbacks cannot write into it', () => {
  const f = fixture(), before = field(f.draw()), oldDraft = f.state.assistantDraft
  f.state.root = '/other/project'; f.state.project = { name: 'Other' }
  assert.equal(field(f.draw()).props.value, '')
  before.props.onInput({ target: { value: 'Old field input' } })
  assert.equal(f.state.assistantDraft, oldDraft)
  field(f.draw()).props.onInput({ target: { value: 'Other draft' } })
  assert.equal(f.state.assistantDraft.root, '/other/project'); assert.equal(f.state.assistantDraft.text, 'Other draft')
})

test('Keep draft in actual sharing review retains imported screenplay and produces no dispatch', async () => {
  const f = fixture({}, async route => route === '/api/assistant/sharing' ? { version: 1, approved: false, reviewID: 'fixture-review', scope } : assert.fail('Unexpected dispatch'))
  mode(f.draw()).props.onChange({ target: { value: 'screenplay' } }); await importFile(f, file())
  const pending = button(f.draw(), 'Send message').props.onClick(); await tick()
  f.state.assistantSharingActions.decline(); await pending
  assert.equal(f.state.assistantDraft.inputKind, 'screenplay'); assert.match(f.state.assistantDraft.text, /INT\. STUDIO/)
  assert.deepEqual(f.calls.map(call => call.route), ['/api/assistant/sharing'])
})

test('editing or switching project during consent preflight prevents hidden dispatch', async () => {
  for (const change of ['draft', 'project']) {
    const response = deferred(), f = fixture({}, route => route === '/api/assistant/sharing' ? response.promise : assert.fail('Unexpected dispatch'))
    const pending = button(f.draw(), 'Send message').props.onClick(); await tick()
    if (change === 'draft') field(f.draw()).props.onInput({ target: { value: 'Changed draft' } })
    else { f.state.root = '/other'; f.state.project = {} }
    response.resolve({ version: 1, approved: true, scope, sharing }); await pending
    assert.deepEqual(f.calls.map(call => call.route), ['/api/assistant/sharing'])
  }
})

test('API failure and a newer draft during admission retain local text and explicit kind', async () => {
  const reply = deferred(), f = fixture({}, route => route === '/api/assistant/sharing' ? { version: 1, approved: true, scope, sharing } : reply.promise)
  mode(f.draw()).props.onChange({ target: { value: 'script' } })
  const pending = button(f.draw(), 'Send message').props.onClick(); await tick()
  field(f.draw()).props.onInput({ target: { value: 'Next request draft' } })
  reply.resolve({ queued: 'fixture' }); await pending
  assert.equal(f.state.assistantDraft.text, 'Next request draft'); assert.equal(f.state.assistantDraft.inputKind, 'script')
  const failed = fixture({}, route => route === '/api/assistant/sharing' ? { version: 1, approved: true, scope, sharing } : Promise.reject(new Error('Fixture failure')))
  await button(failed.draw(), 'Send message').props.onClick()
  assert.equal(failed.state.assistantDraft.text, 'Keep this draft'); assert.equal(failed.notices.at(-1)[0], 'Fixture failure')
})

test('native hosted Anthropic Manual truthfully bounds send at 32000 without preflight or dispatch', async () => {
  const f = fixture({ caps: { host: 'native' }, assistantStatus: { provider: 'anthropic', mode: 'manual', configured: true }, assistantDraft: { root: '/owned/project', text: 'x'.repeat(32001), inputKind: 'script' } })
  assert.equal(field(f.draw()).props.maxLength, 32000)
  assert.equal(button(f.draw(), 'Send message').props.disabled, true)
  await button(f.draw(), 'Send message').props.onClick()
  assert.deepEqual(f.calls, []); assert.match(f.notices[0][0], /32000 characters/)
})

test('ordinary Stop still uses the existing cancellation route and retains the next draft', async () => {
  const f = fixture({ claude: { state: 'working' } }), draft = f.state.assistantDraft
  await button(f.draw(), 'Stop request').props.onClick()
  assert.deepEqual(f.calls.map(call => call.route), ['/api/assistant/cancel'])
  assert.equal(f.state.assistantDraft, draft)
})

test('Stop during actual sharing preflight keeps the imported draft and prevents a late approved response from dispatching', async () => {
  const response = deferred(), f = fixture({}, route => route === '/api/assistant/sharing' ? response.promise : { cancelled: false })
  await importFile(f, file('Retain this script'))
  const draft = f.state.assistantDraft, pending = button(f.draw(), 'Send message').props.onClick()
  await tick(); await button(f.draw(), 'Stop request').props.onClick()
  response.resolve({ version: 1, approved: true, scope, sharing }); await pending; await tick()
  assert.equal(f.state.assistantDraft, draft)
  assert.equal(f.calls.some(call => call.route === '/api/bridge/send'), false)
})

for (const change of ['new draft', 'new project']) test(`stale actual Send callback cannot dispatch after ${change}`, async () => {
  const f = fixture(), oldSend = button(f.draw(), 'Send message').props.onClick
  if (change === 'new draft') f.state.assistantDraft = { root: f.state.root, text: 'New screenplay', inputKind: 'screenplay' }
  else { f.state.root = '/other/project'; f.state.project = { name: 'Other' }; f.state.assistantDraft = { root: f.state.root, text: 'Other screenplay', inputKind: 'screenplay' }; f.state.selection = ['other1'] }
  await oldSend()
  assert.equal(f.calls.some(call => call.route === '/api/bridge/send'), false, JSON.stringify(f.calls))
})
