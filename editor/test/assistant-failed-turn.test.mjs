// A failed turn said only "fetch failed". Seen on 2026-11-17: the reply was those 12 characters,
// the outcome was empty and the project had gone from version 48 to 51. The host made one attempt
// at each bridge request and did not track what the run had saved.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBrowserAssistant } from '../agent/browser-assistant.mjs'
import { SHARING_CLASSES } from '../core/assistant-sharing.mjs'

const accounts = async () => [{ id: 'claude-code', installed: true, authenticated: true }]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async predicate => { for (let i = 0; i < 400; i++) { const value = await predicate(); if (value) return value; await sleep(10) } assert.fail('The fixture did not reach the expected state.') }

/**
 * A bridge that plays a script. `events` are sent in order; a tool event waits for its result
 * before the next event is released. `fail(kind, attempt)` may return 'drop' to destroy the
 * socket without an answer (what a reset keep-alive connection looks like) or a status to answer
 * with that HTTP error.
 */
async function fakeBridge(t, { events, fail = () => null }) {
  const seen = { runs: 0, results: [], attempts: { run: 0, events: 0, 'tool-result': 0, cancel: 0 }, cancelled: 0 }
  let released = 0
  const advance = () => { while (released < events.length) { released++; if (events[released - 1].type === 'tool') break } }
  const server = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const url = new URL(request.url, 'http://127.0.0.1'), parts = url.pathname.split('/').filter(Boolean)
    const kind = parts.length === 2 ? 'run' : parts[3] === 'events' ? 'events' : parts[3] === 'tools' ? 'tool-result' : 'cancel'
    const action = fail(kind, ++seen.attempts[kind])
    const reply = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (action === 'drop') { request.socket.destroy(); return }
    if (action === 'drop-after') { if (kind === 'tool-result') seen.results.push(JSON.parse(body)); request.socket.destroy(); return }
    if (typeof action === 'number') return reply(action, { error: `The fixture bridge answered ${action}.` })
    if (kind === 'run') { seen.runs++; advance(); return reply(201, { id: JSON.parse(body).id }) }
    if (kind === 'events') { const after = Number(url.searchParams.get('after')); return reply(200, { events: events.slice(0, released).map((event, index) => ({ ...event, seq: index + 1 })).filter(event => event.seq > after) }) }
    if (kind === 'tool-result') { seen.results.push(JSON.parse(body)); advance(); return reply(200, { accepted: true }) }
    seen.cancelled++; return reply(200, { id: parts[2], cancelled: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return { seen, owner: { endpoint: `http://127.0.0.1:${server.address().port}/`, token: 'f'.repeat(64), close: async () => {} } }
}

async function host(t, script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-failed-turn-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bridge = await fakeBridge(t, script)
  let version = 48
  const states = [], replies = [], lines = []
  const service = createBrowserAssistant({ root, providerStatus: accounts, catalogOptions: { providerStatus: accounts, executable: async () => '/fixture-only' }, startBridge: async () => bridge.owner, retryDelaysMs: [5, 10],
    getIdentity: () => 1, getVersion: () => version, getOutline: () => ({ version, outline: 'x' }),
    // A write raises the version the way the server's commit does, and reports it to the run.
    dispatch: async (call, _assert, acceptIdentity) => { if (call.method === 'POST' && call.path === '/api/ops') { version++; acceptIdentity(1) } if (script.onDispatch) await script.onDispatch(call, () => { version++ }); return { applied: 1 } },
    onState: value => states.push(value), onReply: (text, error) => replies.push({ text, error }), diagnostic: line => lines.push(line) })
  t.after(() => service.close())
  await service.configure({ provider: 'claude-code' })
  const review = await service.sharing()
  const granted = await service.grantSharing({ reviewID: review.reviewID, sharing: { version: 1, approved: true, scope: { ...review.scope, classes: [...SHARING_CLASSES] } } })
  const send = async () => {
    await service.send({ text: 'Tidy the edit.', sharing: granted.sharing })
    return waitFor(() => ['done', 'error', 'cancelled'].includes(states.at(-1)?.state) && states.at(-1))
  }
  return { service, bridge, states, replies, lines, send, version: () => version }
}

const ops = (callID, summary, count = 1) => ({ type: 'tool', callID, method: 'POST', path: '/api/ops', body: { ops: Array.from({ length: count }, () => ({ op: 'marker', t: 1 })), ...(summary ? { summary } : {}) } })
const route = { type: 'route', routing: { provider: 'claude-code', model: '', modelName: 'Provider default' } }

test('one dropped connection on the tool-result request is retried and the run completes', async t => {
  for (const action of ['drop', 'drop-after']) {
    const f = await host(t, { events: [route, ops('c1', 'Tightened the opening'), { type: 'done', text: 'All done.' }], fail: (kind, attempt) => kind === 'tool-result' && attempt === 1 ? action : null })
    const final = await f.send()
    assert.equal(final.state, 'done', final.text); assert.equal(final.text, 'All done.')
    assert.equal(f.bridge.seen.attempts['tool-result'], 2, 'one retry')
    assert.deepEqual(f.bridge.seen.results.at(-1), { result: { applied: 1 } })
    assert.equal(f.version(), 49, 'the edit ran once: only the delivery of its result was repeated')
    assert.deepEqual(final.committed, [{ version: 49, summary: 'Tightened the opening' }]); assert.equal(final.retryable, false)
    assert.ok(f.lines.some(line => /tool-result request failed \((ECONNRESET|UND_ERR_SOCKET)\); retry 1 of 2/.test(line)), f.lines.join('\n'))
  }
})

test('a connection that keeps failing after two edits ends with what was saved, a reason and a retry hint', async t => {
  const f = await host(t, { events: [route, ops('c1', 'Tightened the opening'), ops('c2', '', 3), ops('c3', 'Added the end card'), { type: 'done', text: 'unreachable' }], fail: (kind, attempt) => kind === 'tool-result' && attempt >= 3 ? 'drop' : null })
  const final = await f.send()
  assert.equal(final.state, 'error')
  assert.equal(f.bridge.seen.attempts['tool-result'], 5, 'the third result was tried three times')
  // The third edit was saved too: its result is what could not be delivered.
  assert.deepEqual(final.committed, [{ version: 49, summary: 'Tightened the opening' }, { version: 50, summary: 'applied 3 edits' }, { version: 51, summary: 'Added the end card' }])
  assert.equal(final.retryable, true)
  assert.equal(final.text, 'The connection between Arya and the agent failed 3 times in a row (fetch failed, ' + final.text.match(/ECONNRESET|UND_ERR_SOCKET/)[0] + ').\n\nSaved before the failure, and still in the project:\n- Tightened the opening\n- applied 3 edits\n- Added the end card')
  assert.equal(final.outcome, '3 edits were saved before the request failed. They are still in the project.')
  assert.deepEqual(f.replies, [{ text: final.text, error: true }], 'the same text reaches the saved conversation')
  await waitFor(() => f.bridge.seen.cancelled === 1)
  // What the investigation asked to be measured: the cause code, the request kind and the event-loop delay.
  const line = f.lines.find(value => value.startsWith('run failed:'))
  assert.match(line, /^run failed: tool-result request, cause (ECONNRESET|UND_ERR_SOCKET), 3 attempts, event-loop delay max \d+ ms over the last \d+ s$/)
})

test('a failure before any edit says that no project edits were saved', async t => {
  const f = await host(t, { events: [route, { type: 'tool', callID: 'c1', method: 'GET', path: '/api/outline' }], fail: kind => kind === 'tool-result' ? 'drop' : null })
  const final = await f.send()
  assert.equal(final.state, 'error'); assert.deepEqual(final.committed, []); assert.equal(final.retryable, true)
  assert.match(final.text, /^The connection between Arya and the agent failed 3 times in a row \(fetch failed, [A-Z_]+\)\.\n\nNo project edits were saved\.$/)
  assert.equal(final.outcome, 'No project edits were saved.')
})

test('a project that changed without an edit of this run is not called unchanged', async t => {
  // A background job applies while the read is in flight: the version rises with no commit of the run.
  const f = await host(t, { events: [route, { type: 'tool', callID: 'c1', method: 'GET', path: '/api/outline' }], fail: kind => kind === 'tool-result' ? 'drop' : null, onDispatch: (_call, bump) => bump() })
  const final = await f.send()
  assert.deepEqual(final.committed, [])
  assert.match(final.text, /\n\nThe project changed during this request\. Review edits in the timeline\.$/); assert.equal(/No project edits were saved/.test(final.text), false)
})

test('an HTTP error from the bridge is not retried and keeps its own message first', async t => {
  const f = await host(t, { events: [route, ops('c1', 'Tightened the opening')], fail: kind => kind === 'tool-result' ? 409 : null })
  const final = await f.send()
  assert.equal(f.bridge.seen.attempts['tool-result'], 1)
  assert.equal(final.state, 'error'); assert.equal(final.retryable, false)
  assert.equal(final.text, 'The fixture bridge answered 409.\n\nSaved before the failure, and still in the project:\n- Tightened the opening')
})

test('a refused first request is not retried either, and a dropped one is', async t => {
  const refused = await host(t, { events: [route], fail: kind => kind === 'run' ? 429 : null })
  await assert.rejects(refused.service.send({ text: 'Tidy the edit.', sharing: (await refused.service.sharing()).sharing }), /The fixture bridge answered 429/)
  assert.equal(refused.bridge.seen.attempts.run, 1)
  const dropped = await host(t, { events: [route, { type: 'done', text: 'All done.' }], fail: (kind, attempt) => kind === 'run' && attempt === 1 ? 'drop' : null })
  assert.equal((await dropped.send()).state, 'done'); assert.equal(dropped.bridge.seen.attempts.run, 2); assert.equal(dropped.bridge.seen.runs, 1)
})

test('a stopped run is not retried', async t => {
  let stop
  const f = await host(t, { events: [route, ops('c1', 'Tightened the opening')], fail: kind => { if (kind === 'tool-result') { stop(); return 'drop' } return null } })
  stop = () => { f.service.cancel().catch(() => {}) }
  const final = await f.send()
  assert.equal(final.state, 'cancelled')
  assert.equal(f.bridge.seen.attempts['tool-result'], 1, 'Stop ends the retries')
  assert.deepEqual(final.committed, [{ version: 49, summary: 'Tightened the opening' }], 'a stopped run still lists what it saved')
})

test('a provider error lists what was saved, and a new run starts with an empty list', async t => {
  const f = await host(t, { events: [route, ops('c1', 'Tightened the opening'), { type: 'error', message: 'The provider stopped the request.' }] })
  const failed = await f.send()
  assert.equal(failed.state, 'error'); assert.equal(failed.retryable, false)
  assert.equal(failed.text, 'The provider stopped the request.\n\nSaved before the failure, and still in the project:\n- Tightened the opening')
  assert.deepEqual(failed.committed, [{ version: 49, summary: 'Tightened the opening' }])
  const start = f.states.length
  f.service.send({ text: 'Again.', sharing: (await f.service.sharing()).sharing }).catch(() => {})
  const first = await waitFor(() => f.states[start])
  assert.deepEqual(first.committed, []); assert.equal(first.retryable, false); assert.equal(first.state, 'thinking')
})

test('the model a CLI reports is published with the route, and only a plain model name is accepted', async t => {
  const f = await host(t, { events: [route, { type: 'model', model: 'fixture-model-4-5' }, { type: 'model', model: 'fixture-helper-1' }, { type: 'done', text: 'All done.' }] })
  const final = await f.send()
  assert.equal(final.state, 'done')
  assert.deepEqual(final.routing, { provider: 'claude-code', model: '', modelName: 'Provider default', executedModel: 'fixture-model-4-5', executedModelSource: 'cli' }, 'the first reported model is the run\'s own; a helper model does not replace it')
  for (const model of ['', 'x'.repeat(201), 'two\nlines', 7, null]) {
    const g = await host(t, { events: [route, { type: 'model', model }, { type: 'done', text: 'All done.' }] })
    const done = await g.send()
    assert.equal(done.state, 'done'); assert.equal(Object.hasOwn(done.routing, 'executedModel'), false, JSON.stringify(model))
  }
  // A later run does not inherit the earlier run's model.
  const h = await host(t, { events: [route, { type: 'done', text: 'All done.' }] })
  assert.equal(Object.hasOwn((await h.send()).routing, 'executedModel'), false)
})
