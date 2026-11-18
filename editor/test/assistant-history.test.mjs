import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import readline from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentProjectView, CHAT_NOTE, HISTORY_LIMITS, HISTORY_NOTE, historyPage, runHistory } from '../agent/agent-views.mjs'
import { READS, validateCall } from '../agent/protocol.mjs'
import { promptContext, runningServer } from './fixtures/running-server.mjs'

// An agent run has no memory of earlier requests. These tests cover what it is given instead:
// a short history in the run context, a paged history route, and a bounded GET /api/project.
const here = path.dirname(fileURLToPath(import.meta.url))
const says = (role, text, at, extra = {}) => ({ role, text, at, ...extra })
const pasted = `Lower thirds, one per line:\n${Array.from({ length: 200 }, (_, index) => `row ${String(index).padStart(3, '0')} | Speaker ${index} | Title ${index}`).join('\n')}\nLAST-ROW-MARKER`
const conversation = [
  says('user', 'Cut the pauses.', 1000),
  says('claude', 'Removed four pauses.', 1001, { provider: 'claude-code' }),
  says('user', pasted, 1002),
  says('claude', 'Which rows do you want? A) the first ten B) all of them', 1003, { provider: 'codex' }),
  says('user', 'Make the intro shorter.', 1004),
  says('claude', 'The agent could not complete the request.', 1005, { error: true }),
  says('user', 'Try again.', 1006),
  says('claude', 'Shortened the intro by two seconds.', 1007),
]

test('the run history is the last six messages, oldest first, each cut and marked', () => {
  const history = runHistory(conversation)
  assert.equal(history.length, HISTORY_LIMITS.messages)
  assert.deepEqual(history.map(entry => entry.at), [1002, 1003, 1004, 1005, 1006, 1007])
  assert.deepEqual(history.map(entry => entry.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'], 'a stored reply has role assistant whichever provider wrote it')
  assert.equal(history[0].text, pasted.slice(0, 1500)); assert.equal(history[0].more, pasted.length - 1500)
  assert.deepEqual(history[1], { role: 'assistant', at: 1003, text: conversation[3].text }, 'a short message is whole and carries nothing else')
  assert.equal(history[3].error, true)
  assert.ok(Buffer.byteLength(JSON.stringify(history)) <= HISTORY_LIMITS.bytes)
  // Six long messages do not fit 8 KiB, so the oldest are dropped first.
  const long = runHistory(Array.from({ length: 8 }, (_, index) => says('user', `${index}`.repeat(4000), index)))
  assert.ok(long.length < 6 && long.length > 0); assert.equal(long.at(-1).at, 7)
  assert.ok(Buffer.byteLength(JSON.stringify(long)) <= HISTORY_LIMITS.bytes)
  assert.deepEqual(runHistory([]), []); assert.deepEqual(runHistory(undefined), []); assert.deepEqual(runHistory([null, 'x']), [])
})

test('the history route pages every message and returns the rest of a long one', () => {
  const latest = historyPage(conversation, { limit: '3' })
  assert.equal(latest.total, 8); assert.equal(latest.offset, 5); assert.deepEqual(latest.messages.map(entry => entry.index), [5, 6, 7])
  assert.equal(Object.hasOwn(latest, 'nextOffset'), false)
  const oldest = historyPage(conversation, { offset: '0', limit: '3' })
  assert.deepEqual(oldest.messages.map(entry => entry.at), [1000, 1001, 1002]); assert.equal(oldest.nextOffset, 3)
  assert.equal(oldest.messages[2].text.length, 2000); assert.equal(oldest.messages[2].chars, pasted.length); assert.equal(oldest.messages[2].more, pasted.length - 2000)
  assert.deepEqual(historyPage(conversation, {}).messages.length, 8)
  // Following nextFrom reads a long message to its end.
  let text = '', from = 0
  for (let step = 0; step < 10 && from !== undefined; step++) {
    const part = historyPage(conversation, { at: '1002', role: 'user', from: String(from), chars: '3000' })
    assert.equal(part.index, 2); assert.equal(part.chars, pasted.length)
    text += part.text; from = part.nextFrom
  }
  assert.equal(text, pasted)
  assert.match(historyPage(conversation, { at: 1002, from: pasted.length - 15 }).text, /LAST-ROW-MARKER$/)
  // A page never exceeds its text budget, and still moves past a message longer than the budget.
  const heavy = Array.from({ length: 5 }, (_, index) => says('user', 'x'.repeat(30000), index))
  const page = historyPage(heavy, { offset: 0, chars: 48000 })
  assert.equal(page.messages.length, 1); assert.equal(page.nextOffset, 1)
  assert.equal(historyPage(heavy, { offset: 0, chars: 20000 }).messages.length, 2)
  assert.deepEqual(historyPage([], {}), { total: 0, offset: 0, messages: [], note: latest.note })
  for (const [query, pattern] of [[{ limit: '0' }, /limit must be a whole number from 1 to 100/], [{ offset: '-1' }, /offset must be a whole number/], [{ chars: '1e3' }, /chars must be a whole number/], [{ at: '5' }, /No saved message has that at value/], [{ at: '1002', role: 'claude' }, /role must be user or assistant/]]) assert.throws(() => historyPage(conversation, query), pattern)
  assert.throws(() => historyPage(conversation, { at: 1002, role: 'assistant' }), error => error.status === 404, 'role picks between two messages saved in the same millisecond')
  assert.equal(historyPage([...conversation, says('claude', 'Same instant.', 1006)], { at: 1006, role: 'assistant' }).text, 'Same instant.')
})

test('an agent may read the history route, and nothing else under the assistant routes', () => {
  assert.ok(READS.has('/api/assistant/history'))
  assert.deepEqual(validateCall('reel_api', { method: 'GET', path: '/api/assistant/history?at=1002&role=user&from=1500' }), { method: 'GET', path: '/api/assistant/history?at=1002&role=user&from=1500' })
  for (const route of ['/api/assistant/config', '/api/assistant/sharing', '/api/assistant/review']) assert.throws(() => validateCall('reel_api', { method: 'GET', path: route }), /unavailable to agents/)
})

test('the agent view of the project keeps the project and bounds everything around it', () => {
  const full = { project: { name: 'P', tracks: [] }, version: 7, root: '/owned/project', recovery: { status: 'ok' }, chatHistory: { restored: 8 }, claude: { state: 'thinking', text: 'x'.repeat(5000) },
    chat: Array.from({ length: 100 }, (_, index) => says(index % 2 ? 'claude' : 'user', `${index} `.repeat(3000), index)),
    activity: Array.from({ length: 40 }, (_, index) => ({ who: 'agent', text: `line ${index} `.repeat(200), at: index })), jobs: Array.from({ length: 20 }, (_, index) => ({ id: `j${index}`, state: 'done' })) }
  const view = agentProjectView(full)
  assert.deepEqual(Object.keys(view), ['project', 'version', 'root', 'chat', 'chatNote', 'activity', 'jobs'])
  assert.equal(view.project, full.project); assert.equal(view.version, 7)
  assert.equal(view.chat.length, 12); assert.equal(view.chat.at(-1).at, 99); assert.equal(view.chat.at(-1).role, 'assistant'); assert.equal(view.chat[0].text.length, 1500); assert.ok(view.chat[0].more > 0)
  assert.equal(view.chatNote, CHAT_NOTE)
  assert.equal(view.activity.length, 20); assert.equal(view.activity[0].text.length, 200); assert.equal(view.activity.at(-1).at, 39)
  assert.deepEqual(view.jobs.map(job => job.id), ['j15', 'j16', 'j17', 'j18', 'j19'])
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < 32 * 1024, String(Buffer.byteLength(JSON.stringify(view))))
  assert.ok(Buffer.byteLength(JSON.stringify(full)) > 500 * 1024)
  assert.deepEqual(agentProjectView({ project: null, version: 0 }), { project: null, version: 0, root: undefined, chat: [], chatNote: CHAT_NOTE, activity: [], jobs: [] })
})

test('the real server gives an agent the earlier messages, bounded, and leaves the editor\'s own view whole', async t => {
  const server = await runningServer(t, [
    { method: 'GET', path: '/api/project' },
    { method: 'GET', path: '/api/assistant/history' },
    { method: 'GET', path: '/api/assistant/history?at=1002&role=user&from=1500' },
  ], { setup: (root, initial) => {
    fs.mkdirSync(path.join(root, '.reel'), { recursive: true })
    fs.writeFileSync(path.join(root, '.reel', 'assistant-chat.json'), `${JSON.stringify({ version: 1, messages: conversation })}\n`)
    return initial
  } })
  const agent = await server.ask('B, all of them.')
  const { context } = promptContext(agent.prompt)
  // The run context: the six messages before this request, without the request itself.
  assert.deepEqual(context.history.map(entry => entry.at), [1002, 1003, 1004, 1005, 1006, 1007])
  assert.equal(context.history[1].text, 'Which rows do you want? A) the first ten B) all of them')
  assert.equal(context.history[0].more, pasted.length - 1500)
  assert.equal(context.historyNote, HISTORY_NOTE)
  assert.ok(Buffer.byteLength(JSON.stringify(context.history)) <= HISTORY_LIMITS.bytes)
  const [project, page, rest] = agent.results
  // GET /api/project as the agent reads it.
  assert.ok(Buffer.byteLength(JSON.stringify(project)) < 60 * 1024, String(Buffer.byteLength(JSON.stringify(project))))
  assert.deepEqual(Object.keys(project), ['project', 'version', 'root', 'chat', 'chatNote', 'activity', 'jobs'])
  assert.equal(project.project.name, 'Server fixture')
  assert.equal(project.chat.length, 9, 'the eight earlier messages and this request')
  assert.equal(project.chat.at(-1).text, 'B, all of them.')
  assert.equal(project.chat[2].text.length, 1500); assert.equal(project.chat[2].more, pasted.length - 1500)
  // The history route as the agent reads it.
  assert.equal(page.total, 9); assert.equal(page.messages.length, 9); assert.equal(page.messages[2].more, pasted.length - 2000)
  assert.equal(context.history[0].text + rest.text, pasted, 'the cut part of the run history plus the rest is the whole message')
  assert.equal(Object.hasOwn(rest, 'more'), false)
  // The editor's own read is unchanged: the whole message, the run state and the recovery state.
  const editor = (await server.api('GET', '/api/project')).body
  assert.ok(['recovery', 'chatHistory', 'claude'].every(key => Object.hasOwn(editor, key)))
  assert.equal(editor.chat.length, 10); assert.equal(editor.chat[2].text, pasted); assert.equal(editor.chat[1].role, 'claude')
  const direct = await server.api('GET', '/api/assistant/history?limit=2')
  assert.equal(direct.status, 200); assert.deepEqual(direct.body.messages.map(entry => entry.role), ['user', 'assistant'])
  assert.equal((await server.api('GET', '/api/assistant/history?limit=500')).status, 400)
  assert.equal((await server.api('GET', '/api/assistant/history?at=77')).status, 404)
})

test('a first request carries no history', async t => {
  const server = await runningServer(t, [{ method: 'GET', path: '/api/assistant/history' }])
  const agent = await server.ask('Add a title.')
  const { context } = promptContext(agent.prompt)
  assert.equal(Object.hasOwn(context, 'history'), false); assert.equal(Object.hasOwn(context, 'historyNote'), false)
  assert.deepEqual(agent.results[0].messages.map(entry => entry.text), ['Add a title.'])
})

test('the MCP server returns a JSON result once, as text', async t => {
  const result = { outline: 'x'.repeat(2000), version: 3 }
  const endpoint = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(request.method === 'POST' ? { callID: 'call-1' } : { pending: false, result }))
  })
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve))
  t.after(() => endpoint.close())
  const child = spawn(process.execPath, [path.join(here, '../agent/mcp.mjs')], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, REEL_AGENT_ENDPOINT: `http://127.0.0.1:${endpoint.address().port}`, REEL_AGENT_RUN_ID: '11111111-1111-4111-8111-111111111111', REEL_AGENT_RUN_TOKEN: 'a'.repeat(64) } })
  t.after(() => child.kill())
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const rpc = async (id, method, params) => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); return JSON.parse((await lines.next()).value) }
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })
  const answer = (await rpc(2, 'tools/call', { name: 'reel_api', arguments: { method: 'GET', path: '/api/outline' } })).result
  assert.deepEqual(Object.keys(answer), ['content'])
  assert.equal(answer.content.length, 1); assert.equal(answer.content[0].type, 'text')
  assert.deepEqual(JSON.parse(answer.content[0].text), result)
  assert.ok(JSON.stringify(answer).length < JSON.stringify(result).length * 1.2, 'the result is not sent twice')
  child.stdin.end()
})
