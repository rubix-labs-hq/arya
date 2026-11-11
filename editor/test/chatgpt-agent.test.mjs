import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startBridge } from '../agent/bridge.mjs'
import { outputEvent } from '../agent/adapters.mjs'
import { createChatGPTAccount } from '../agent/chatgpt-account.mjs'
import { fixtureSharing } from './fixtures/sharing-fixture.mjs'
import { startChatGPTFake, DOC_MODEL } from './fixtures/chatgpt-fake.mjs'

// The bridge spawns the real agent/chatgpt-agent.mjs. OpenAI is the doc-oracle fake.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const PNG = 'iVBORw0KGgo='

async function settle(account) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const current = account.status()
    if (['done', 'failed', 'cancelled', 'expired'].includes(current.attempt.state)) return current
    await sleep(5)
  }
  assert.fail('sign-in did not settle')
}

async function setup(t, { signIn = true, consent, prepareAdapter } = {}) {
  const fake = await startChatGPTFake()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-chatgpt-agent-'))
  const clock = { offset: 0 }
  const account = createChatGPTAccount({ directory: path.join(root, 'chatgpt'), endpoints: fake.endpoints, retryDelays: [1, 1, 1], now: () => Date.now() + clock.offset,
    openURL: async url => { await fake.browser(url); return true } })
  if (consent) fake.consent.push(consent)
  if (signIn) assert.equal((await account.signIn().then(() => settle(account))).attempt.state, 'done')
  const bridge = await startBridge({ chatgpt: account, catalogOptions: { providerStatus: async () => [] }, ...(prepareAdapter ? { prepareAdapter } : {}) })
  t.after(async () => { await bridge.close(); account.close(); await fake.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { fake, account, bridge, clock }
}

async function call(bridge, method, route, body, auth = bridge.token) {
  const response = await fetch(new URL(route, bridge.endpoint), { method, headers: { authorization: `Bearer ${auth}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}

function start(bridge, { text = 'Add a title that says Hello', model } = {}) {
  const id = randomUUID()
  const body = { id, provider: 'chatgpt', text, ...(model ? { model } : {}), context: { selection: [] }, outline: { version: 1 }, sharing: fixtureSharing(bridge.endpoint, [{ provider: 'chatgpt', model: model ?? '' }]) }
  return call(bridge, 'POST', '/v1/runs', body).then(started => { assert.equal(started.status, 201, JSON.stringify(started.body)); return id })
}

async function run(bridge, options = {}) {
  const id = await start(bridge, options)
  let cursor = 0
  const events = []
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const batch = (await call(bridge, 'GET', `/v1/runs/${id}/events?after=${cursor}`)).body.events
    for (const event of batch) {
      cursor = event.seq; events.push(event)
      if (event.type === 'tool') {
        const result = await (options.tool?.(event) ?? { result: { ok: true } })
        assert.equal((await call(bridge, 'POST', `/v1/runs/${id}/tools/${event.callID}`, result)).status, 200)
      }
      if (event.type === 'done' || event.type === 'error') return { id, events, final: event, text: events.filter(item => item.type === 'text').map(item => item.text).join('') }
    }
    await sleep(15)
  }
  assert.fail('ChatGPT run timed out')
}

const completed = (output = []) => ({ type: 'response.completed', response: { status: 'completed', output } })
const secrets = fake => [...fake.access.keys(), ...fake.refresh.keys()]

test('a ChatGPT run uses the plan, runs Arya tools and replays every output item in order', async t => {
  const { fake, bridge } = await setup(t)
  const reasoning = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'encrypted-1' }
  const api = { id: 'fc_1', type: 'function_call', namespace: 'arya', name: 'reel_api', call_id: 'call_api', arguments: JSON.stringify({ method: 'GET', path: '/api/outline' }) }
  const frame = { id: 'fc_2', type: 'function_call', namespace: 'arya', name: 'reel_frame', call_id: 'call_frame', arguments: JSON.stringify({ at: 1.5 }) }
  const blocked = { id: 'fc_3', type: 'function_call', namespace: 'arya', name: 'reel_api', call_id: 'call_blocked', arguments: JSON.stringify({ method: 'POST', path: '/api/assistant/chatgpt/sign-out' }) }
  fake.responses.push(
    () => [{ type: 'response.output_item.done', item: reasoning }, { type: 'response.output_text.delta', delta: 'Checking the project.' }, completed([reasoning, api, frame, blocked])],
    // The second turn returns output only through output_item.done events.
    () => [...Array.from({ length: 300 }, () => ({ type: 'response.output_text.delta', delta: 'ok ' })), { type: 'response.output_item.done', item: { id: 'msg_2', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] } }, completed()],
  )
  const tools = []
  const result = await run(bridge, { tool: event => { tools.push(event); return event.frame ? { image: { mediaType: 'image/png', data: PNG } } : { result: { outline: 'fixture outline' } } } })
  assert.equal(result.final.type, 'done', result.final.message)
  assert.deepEqual(fake.violations, [])
  assert.equal(result.text, `Checking the project.\n\n${'ok '.repeat(300)}`)
  // 300 deltas arrive as a few batched records, well inside the bridge's event limit.
  assert.ok(result.events.filter(item => item.type === 'text').length <= 10)
  assert.deepEqual(tools.map(item => item.frame ? 'frame' : item.path), ['/api/outline', 'frame'])

  const [first, second] = fake.responseBodies
  assert.equal(fake.responseBodies.length, 2)
  assert.equal(first.model, DOC_MODEL)
  assert.equal(first.store, false); assert.equal(first.stream, true)
  assert.match(first.instructions, /reel_api and reel_frame/)
  assert.doesNotMatch(first.instructions, /immutable_reel_context/)
  assert.deepEqual(first.input.map(item => [item.type, item.role]), [['message', 'user']])
  assert.match(first.input[0].content[0].text, /^<immutable_reel_context>[\s\S]*<user_request>\nAdd a title that says Hello\n<\/user_request>$/)
  assert.deepEqual(first.tools.map(tool => [tool.type, tool.name, tool.tools.map(item => item.name)]), [['namespace', 'arya', ['reel_api', 'reel_frame']]])
  assert.equal(JSON.stringify(first.tools).includes('oneOf'), false)
  // Append-only: the second request starts with the whole first request input.
  assert.deepEqual(second.input.slice(0, first.input.length), first.input)
  const added = second.input.slice(first.input.length)
  assert.deepEqual(added.map(item => item.type), ['reasoning', 'function_call', 'function_call', 'function_call', 'function_call_output', 'function_call_output', 'function_call_output'])
  assert.equal(added[0].encrypted_content, 'encrypted-1'); assert.equal(added[0].id, undefined)
  assert.deepEqual(added.slice(1, 4).map(item => [item.call_id, item.namespace, item.id]), [['call_api', 'arya', undefined], ['call_frame', 'arya', undefined], ['call_blocked', 'arya', undefined]])
  assert.deepEqual(JSON.parse(added[4].output), { outline: 'fixture outline' })
  assert.deepEqual(added[5].output, [{ type: 'input_image', image_url: `data:image/png;base64,${PNG}` }])
  // Agents cannot reach account routes; the model gets an error instead.
  assert.match(JSON.parse(added[6].output).error, /unavailable to agents/)
  // No OAuth token reaches the run events.
  const published = JSON.stringify(result.events)
  for (const secret of secrets(fake)) assert.equal(published.includes(secret), false)
})

test('a usage limit during the stream stops the run with the Manage usage recovery and request ID', async t => {
  const { fake, bridge } = await setup(t)
  fake.responses.push(() => [{ type: 'response.output_text.delta', delta: 'Starting' }, { type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached.' } } }])
  const result = await run(bridge)
  assert.equal(result.final.type, 'error')
  assert.equal(result.final.code, 'chatgpt_usage_limit')
  assert.match(result.final.message, /usage limit/i)
  assert.match(result.final.message, /Request ID: req_fake1\./)
  assert.equal(fake.responseBodies.length, 1)
})

test('a cut stream, an incomplete reply and an ineligible account are failures, not success', async t => {
  const { fake, bridge } = await setup(t)
  fake.responses.push(() => [{ type: 'response.output_text.delta', delta: 'Half' }, 'cut'])
  const cut = await run(bridge)
  assert.equal(cut.final.code, 'chatgpt_stream_interrupted', cut.final.message)

  fake.responses.push(() => [{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }])
  const incomplete = await run(bridge)
  assert.equal(incomplete.final.code, 'chatgpt_incomplete'); assert.match(incomplete.final.message, /max_output_tokens/)

  const before = fake.responseBodies.length
  fake.responses.push(() => ({ status: 403, body: { error: { code: 'subscription_sharing_user_not_eligible', message: 'Not eligible' } } }))
  const ineligible = await run(bridge)
  assert.equal(ineligible.final.code, 'chatgpt_not_eligible')
  // Not eligible is never retried.
  assert.equal(fake.responseBodies.length, before + 1)

  fake.responses.push(() => ({ status: 403, body: { detail: 'Direct routing is not permitted in this region.' } }))
  const admission = await run(bridge)
  assert.equal(admission.final.code, 'chatgpt_not_eligible'); assert.match(admission.final.message, /not permitted in this region/)
  assert.deepEqual(fake.violations, [])
})

test('temporary unavailability uses bounded backoff and then completes', async t => {
  const { fake, bridge } = await setup(t)
  fake.responses.push(() => ({ status: 503, body: { error: { code: 'subscription_sharing_usage_unavailable', message: 'Try later' } } }))
  const result = await run(bridge)
  assert.equal(result.final.type, 'done', result.final.message)
  assert.equal(fake.responseBodies.length, 2)
})

test('a long run gets a refreshed token from Arya before its next request', async t => {
  const { fake, bridge, clock } = await setup(t)
  const api = { type: 'function_call', namespace: 'arya', name: 'reel_api', call_id: 'call_1', arguments: JSON.stringify({ method: 'GET', path: '/api/caps' }) }
  // The first turn takes "an hour" on Arya's clock, so the next credential needs a refresh.
  fake.responses.push(() => { clock.offset = 3590 * 1000; return [completed([api])] })
  const result = await run(bridge)
  assert.equal(result.final.type, 'done', result.final.message)
  assert.equal(fake.refreshGrants, 1)
  assert.deepEqual(fake.violations, [])
})

test('without plan usage or a sign-in the run stops before contacting OpenAI', async t => {
  const declined = await setup(t, { consent: { grantPlan: false } })
  const off = await run(declined.bridge)
  assert.equal(off.final.type, 'error'); assert.match(off.final.message, /plan usage is off/)
  assert.equal(declined.fake.responseBodies.length, 0)

  const signedOut = await setup(t, { signIn: false })
  const none = await run(signedOut.bridge)
  assert.equal(none.final.type, 'error'); assert.match(none.final.message, /Continue with ChatGPT/)
  assert.equal(signedOut.fake.responseBodies.length, 0)
})

test('the credential route serves only the run’s own token, follows sign-out and refuses an account switch', async t => {
  let transport
  const hold = async (request, value) => { transport = value; return { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], cwd: os.tmpdir(), env: {}, prompt: '', cleanup: async () => {} } }
  const { fake, account, bridge } = await setup(t, { prepareAdapter: hold })
  const id = await start(bridge)
  const deadline = Date.now() + 5000
  while (!transport && Date.now() < deadline) await sleep(10)
  assert.ok(transport)
  const route = `/v1/runs/${id}/credential`
  assert.equal((await call(bridge, 'POST', route, {})).status, 404, 'the master token cannot read OpenAI tokens')
  assert.equal((await call(bridge, 'POST', route, {}, 'f'.repeat(64))).status, 401)
  const granted = await call(bridge, 'POST', route, {}, transport.token)
  assert.equal(granted.status, 200)
  assert.equal(granted.body.api, fake.endpoints.api)
  assert.ok(fake.access.has(granted.body.accessToken))

  // Another ChatGPT account mid-run: sharing was approved for the first one.
  fake.consent.push({ subject: 'user-second', email: 'sam@example.com' })
  await account.signIn({ newAccount: true }); assert.equal((await settle(account)).attempt.state, 'done')
  const switched = await call(bridge, 'POST', route, {}, transport.token)
  assert.equal(switched.status, 409); assert.equal(switched.body.code, 'chatgpt_account_changed')

  await account.signOut()
  const after = await call(bridge, 'POST', route, {}, transport.token)
  assert.equal(after.status, 401); assert.equal(after.body.code, 'chatgpt_sign_in_required')
  assert.equal((await call(bridge, 'POST', `/v1/runs/${id}/cancel`, {})).status, 200)
})

test('the bridge accepts only the ChatGPT agent’s three record shapes', () => {
  assert.deepEqual(outputEvent('chatgpt', JSON.stringify({ type: 'text', text: 'Hi' })), { type: 'text', text: 'Hi' })
  assert.deepEqual(outputEvent('chatgpt', JSON.stringify({ type: 'done', text: 'ignored' })), { type: 'done' })
  assert.deepEqual(outputEvent('chatgpt', JSON.stringify({ type: 'error', message: 'Limit', code: 'chatgpt_usage_limit' })), { type: 'error', message: 'Limit', code: 'chatgpt_usage_limit' })
  assert.deepEqual(outputEvent('chatgpt', JSON.stringify({ type: 'error', message: 'Odd', code: 'other code' })), { type: 'error', message: 'Odd' })
  for (const line of ['{"type":"tool","path":"/api/ops"}', '{"type":"result","result":"x"}', '{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}', 'plain text', '{"type":"text","text":5}']) assert.equal(outputEvent('chatgpt', line), null)
})
