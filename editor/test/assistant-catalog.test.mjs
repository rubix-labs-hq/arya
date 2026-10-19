import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import test from 'node:test'
import { createAssistantCatalog } from '../agent/assistant-catalog.mjs'
import { normalizeCatalog } from '../core/assistant-routing.mjs'
import { startBridge } from '../agent/bridge.mjs'
import { createBrowserAssistant } from '../agent/browser-assistant.mjs'
import { prepareAdapter, providerStatus } from '../agent/adapters.mjs'
import { selectRoute } from '../core/assistant-routing.mjs'
import assistantRoutes from '../routes/assistant.mjs'
import { fixtureSharing } from './fixtures/sharing-fixture.mjs'

const at = 1791080014819
const records = [
  { id: 'swift', displayName: 'Swift editor', description: 'Fast and efficient for simple tasks.', inputModalities: ['text', 'image'], supportedReasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'medium' },
  { id: 'balanced', description: 'Everyday workhorse.', inputModalities: ['text', 'image'], supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
  { id: 'deep', description: 'Frontier model for demanding work.', inputModalities: ['text', 'image'], supportedReasoningEfforts: ['medium', 'high'], defaultReasoningEffort: 'medium' },
]
const catalog = () => normalizeCatalog({ provider: 'codex', records, checkedAt: at, source: { kind: 'provider-cli', label: 'Actual protocol fixture' } })
const statuses = async () => [{ id: 'codex', installed: true, authenticated: true }, { id: 'claude-code', installed: true, authenticated: true }, { id: 'antigravity', installed: true, authenticated: true, available: false }]
const prefs = { mode: 'auto', provider: 'claude-code', enabledModels: records.map(row => ({ provider: 'codex', model: row.id })) }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const temporary = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya catalog integration ')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root }
const hostOptions = additions => ({ providerStatus: statuses, executable: async name => { assert.equal(name, 'codex'); return '/fixture/codex' }, readCodexCatalog: async () => catalog(), now: () => at, ...additions })
const api = async (bridge, route, body) => { if (route === '/v1/runs' && body && !body.sharing) body = { ...body, sharing: fixtureSharing(bridge.endpoint, body.routing?.mode === 'auto' ? body.routing.enabledModels : [{provider:body.provider,model:body.model ?? ''}]) }; const response = await fetch(new URL(route, bridge.endpoint), { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${bridge.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { code: response.status, body: await response.json() } }
const until = async predicate => { for (let i = 0; i < 100; i++) { const value = await predicate(); if (value) return value; await sleep(10) } assert.fail('Expected fixture condition was not reached.') }

const nativeReady = row => row.installed === true && row.authenticated === true && row.adapterSupported === true && row.available === true
const sessionCatalog = model => normalizeCatalog({ provider: 'codex', records: [{ id: model, description: 'Everyday workhorse.', isDefault: true, inputModalities: ['text', 'image'] }], checkedAt: at, source: { kind: 'provider-cli', label: 'Account-switch protocol fixture' } })
const sessionPool = { mode: 'auto', enabledModels: ['account-a', 'account-b'].map(model => ({ provider: 'codex', model })) }

const browserStatusFixture = async (t, service) => {
  const routes = assistantRoutes({ assistant: service }).routes
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1'), handler = routes[`${request.method} ${url.pathname}`]
    try { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(await handler({}, url.searchParams, request))) }
    catch (error) { response.statusCode = error.status ?? 500; response.end(JSON.stringify({ error: error.message })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  globalThis[Symbol.for('arya.verification.registerOwnedEphemeralHTTP')]?.(server)
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return async route => { const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`); assert.equal(response.status, 200); return response.json() }
}

test('actual browser HTTP explicit refresh recovers sign-in and model discovery immediately while ordinary polling stays cached', async t => {
  let authenticated = false, currentModel = 'account-a', accounts = 0, discoveries = 0, fail = false
  const service = createBrowserAssistant({ root: temporary(t), getIdentity: () => 1, getOutline: () => ({ version: 1 }), catalogOptions: hostOptions({ providerStatus: async () => { accounts++; return [{ id: 'codex', installed: true, authenticated }] }, readCodexCatalog: async () => { discoveries++; if (fail) throw new Error('Fresh catalog unavailable.'); return sessionCatalog(currentModel) } }) }); t.after(() => service.close())
  const get = await browserStatusFixture(t, service)
  await service.status({ wait: true })
  authenticated = true
  const cached = await get('/api/assistant/status')
  assert.equal(cached.providers.find(row => row.id === 'codex').authenticated, false); assert.equal(accounts, 1); assert.equal(discoveries, 0)
  const signedIn = await get('/api/assistant/status?refresh=1')
  assert.equal(signedIn.providers.find(row => row.id === 'codex').available, true); assert.equal(signedIn.catalogs[0].models[0].id, 'account-a')
  currentModel = 'account-b'
  assert.equal((await get('/api/assistant/status')).catalogs[0].models[0].id, 'account-a')
  assert.equal((await get('/api/assistant/status?refresh=1')).catalogs[0].models[0].id, 'account-b')
  fail = true
  const failed = await get('/api/assistant/status?refresh=1')
  assert.equal(failed.catalogs.length, 0); assert.match(failed.providers.find(row => row.id === 'codex').catalogReason, /Fresh catalog unavailable/)
  fail = false
  assert.equal((await get('/api/assistant/status?refresh=1')).catalogs[0].models[0].id, 'account-b')
  assert.equal(accounts, 5); assert.equal(discoveries, 4)
})

test('actual companion HTTP explicit refresh coalesces callers and dispatch still gets its own serialized fresh catalog', async t => {
  const gate = deferred(), entered = deferred()
  let currentModel = 'account-a', accounts = 0, discoveries = 0, live = 0, maximumLive = 0
  const bridge = await startBridge({ catalogOptions: hostOptions({ providerStatus: async () => { accounts++; return [{ id: 'codex', installed: true, authenticated: true }] }, readCodexCatalog: async () => {
    const index = ++discoveries, model = currentModel
    live++; maximumLive = Math.max(maximumLive, live)
    try { if (index === 2) { entered.resolve(); await gate.promise } return sessionCatalog(model) } finally { live-- }
  } }), prepareAdapter: async request => {
    assert.equal(request.model, 'account-a')
    return { command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({type:"done"})+"\\n")'], cwd: os.tmpdir(), env: {}, prompt: '', cleanup: async () => {} }
  } }); t.after(() => bridge.close())
  assert.equal((await api(bridge, '/v1/status')).body.catalogs[0].models[0].id, 'account-a')
  currentModel = 'account-b'
  assert.equal((await api(bridge, '/v1/status')).body.catalogs[0].models[0].id, 'account-a')
  const first = api(bridge, '/v1/status?refresh=1'); await entered.promise
  const second = api(bridge, '/v1/status?refresh=1'), third = api(bridge, '/v1/status?refresh=1')
  const id = '057e40a3-2e03-4e62-9a81-372d002be8e9'
  currentModel = 'account-a'
  assert.equal((await api(bridge, '/v1/runs', { id, provider: 'codex', text: 'Review the edit', routing: sessionPool, sharing: fixtureSharing(bridge.endpoint, [{provider:'codex',model:currentModel}]) })).code, 201)
  await sleep(25); assert.equal(discoveries, 2)
  gate.resolve()
  const values = await Promise.all([first, second, third])
  for (const value of values) assert.equal(value.body.catalogs[0].models[0].id, 'account-b')
  await until(async () => { const page = await api(bridge, `/v1/runs/${id}/events`); return page.body.events.some(event => event.type === 'done') })
  assert.equal(accounts, 3); assert.equal(discoveries, 3); assert.equal(maximumLive, 1)
})

test('concurrent browser explicit HTTP refreshes coalesce after an older ordinary account check', async t => {
  const oldGate = deferred(), oldEntered = deferred(), freshGate = deferred(), freshEntered = deferred()
  let accounts = 0, discoveries = 0
  const service = createBrowserAssistant({ root: temporary(t), getIdentity: () => 1, getOutline: () => ({ version: 1 }), catalogOptions: hostOptions({ providerStatus: async () => {
    accounts++; if (accounts === 1) { oldEntered.resolve(); await oldGate.promise }
    return [{ id: 'codex', installed: true, authenticated: true }]
  }, readCodexCatalog: async () => {
    discoveries++; if (discoveries === 2) { freshEntered.resolve(); await freshGate.promise }
    return sessionCatalog(discoveries === 1 ? 'account-a' : 'account-b')
  } }) }); t.after(() => service.close())
  const get = await browserStatusFixture(t, service)
  await service.status(); await oldEntered.promise
  const first = get('/api/assistant/status?refresh=1'), second = get('/api/assistant/status?refresh=1')
  await sleep(20); assert.equal(accounts, 1)
  oldGate.resolve(); await freshEntered.promise
  const third = get('/api/assistant/status?refresh=1')
  await sleep(20); assert.equal(accounts, 2); assert.equal(discoveries, 2)
  freshGate.resolve()
  for (const value of await Promise.all([first, second, third])) assert.equal(value.catalogs[0].models[0].id, 'account-b')
  assert.equal(accounts, 2); assert.equal(discoveries, 2)
})

test('UI display caches remain bounded while each dispatch refreshes signed-in account and exact models', async () => {
  let currentModel = 'account-a', accountCalls = 0, discoveries = 0, fail = false
  const host = createAssistantCatalog(hostOptions({ providerStatus: async () => { accountCalls++; return [{ id: 'codex', installed: true, authenticated: true }] }, readCodexCatalog: async () => { discoveries++; if (fail) throw new Error('New account discovery failed.'); return sessionCatalog(currentModel) } }))
  assert.equal((await host.status({ wait: true })).catalogs[0].models[0].id, 'account-a')
  currentModel = 'account-b'
  for (let i = 0; i < 3; i++) assert.equal((await host.status({ wait: true })).catalogs[0].models[0].id, 'account-a')
  assert.equal(accountCalls, 1); assert.equal(discoveries, 1)
  const changed = await host.resolve(sessionPool, { text: 'Review the edit' })
  assert.equal(changed.ok, true); assert.equal(changed.model, 'account-b')
  assert.equal(accountCalls, 2); assert.equal(discoveries, 2)
  fail = true
  const failed = await host.resolve(sessionPool, { text: 'Review the edit' })
  assert.equal(failed.ok, false); assert.equal(failed.model, undefined)
  const afterFailure = await host.status({ wait: true })
  assert.equal(afterFailure.catalogs.length, 0); assert.match(afterFailure.providers[0].catalogReason, /New account discovery failed/)
  assert.equal(accountCalls, 3); assert.equal(discoveries, 3)
  fail = false
  assert.equal((await host.resolve(sessionPool, { text: 'Review the edit' })).model, 'account-b')
  assert.equal(accountCalls, 4); assert.equal(discoveries, 4)
  host.close()
})

test('dispatch account refresh detects sign-out and account-probe failure without falling back to old models', async () => {
  let authenticated = true, fail = false, discoveries = 0
  const host = createAssistantCatalog(hostOptions({ providerStatus: async () => { if (fail) throw new Error('Account probe timed out.'); return [{ id: 'codex', installed: true, authenticated }] }, readCodexCatalog: async () => { discoveries++; return sessionCatalog('account-a') } }))
  await host.status({ wait: true })
  authenticated = false
  assert.equal((await host.resolve(sessionPool, { text: 'Review the edit' })).ok, false)
  assert.equal(discoveries, 1); assert.equal((await host.status({ wait: true })).providers[0].authenticated, false)
  authenticated = true; fail = true
  assert.equal((await host.resolve(sessionPool, { text: 'Review the edit' })).ok, false)
  const failed = await host.status({ wait: true })
  assert.deepEqual(failed.providers, []); assert.deepEqual(failed.catalogs, []); assert.equal(discoveries, 1)
  host.close()
})

test('dispatch discoveries serialize behind older UI probes and status polls never spawn overlapping metadata', async () => {
  const gates = [deferred(), deferred(), deferred()], entered = [deferred(), deferred(), deferred()]
  let currentModel = 'account-a', accountCalls = 0, discoveries = 0, live = 0, maximumLive = 0
  const host = createAssistantCatalog(hostOptions({ providerStatus: async () => { accountCalls++; return [{ id: 'codex', installed: true, authenticated: true }] }, readCodexCatalog: async () => {
    const index = discoveries++, model = currentModel
    live++; maximumLive = Math.max(maximumLive, live); entered[index].resolve()
    try { await gates[index].promise; return sessionCatalog(model) } finally { live-- }
  } }))
  assert.equal((await host.status()).loading, true)
  await entered[0].promise
  const first = host.resolve(sessionPool, { text: 'Review the first edit' }), second = host.resolve(sessionPool, { text: 'Review the second edit' })
  assert.equal(discoveries, 1)
  gates[0].resolve(); await entered[1].promise
  currentModel = 'account-b'
  const waitingPolls = [host.status({ wait: true }), host.status({ wait: true })]
  assert.equal((await host.status()).loading, true); assert.equal(discoveries, 2)
  gates[1].resolve(); assert.equal((await first).model, 'account-a')
  await entered[2].promise; gates[2].resolve()
  assert.equal((await second).model, 'account-b'); await Promise.all(waitingPolls)
  assert.equal(accountCalls, 3); assert.equal(discoveries, 3); assert.equal(maximumLive, 1)
  host.close()
})

test('actual HTTP routed dispatch switches catalog with the account and rejects removed Manual models or discovery failures', async t => {
  let currentModel = 'account-a', fail = false, accountCalls = 0, discoveries = 0
  const prepared = []
  const bridge = await startBridge({ catalogOptions: hostOptions({ providerStatus: async () => { accountCalls++; return [{ id: 'codex', installed: true, authenticated: true }] }, readCodexCatalog: async () => { discoveries++; if (fail) throw new Error('New account model list unavailable.'); return sessionCatalog(currentModel) } }), prepareAdapter: async request => {
    prepared.push(structuredClone(request))
    return { command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({type:"done",text:"Account-switch fixture complete"})+"\\n")'], cwd: os.tmpdir(), env: {}, prompt: '', cleanup: async () => {} }
  } }); t.after(() => bridge.close())
  const displayed = await api(bridge, '/v1/status')
  assert.equal(displayed.body.catalogs[0].models[0].id, 'account-a')
  currentModel = 'account-b'
  const firstID = '2377b87f-89f8-4534-834f-91c9d5a2f6b0'
  assert.equal((await api(bridge, '/v1/runs', { id: firstID, provider: 'codex', text: 'Review the edit', routing: sessionPool, sharing: fixtureSharing(bridge.endpoint, [{provider:'codex',model:currentModel}]) })).code, 201)
  const firstPage = await until(async () => { const page = await api(bridge, `/v1/runs/${firstID}/events`); return page.body.events.some(event => event.type === 'done') && page.body })
  assert.equal(prepared.length, 1); assert.equal(prepared[0].model, 'account-b'); assert.equal(firstPage.events[0].routing.model, 'account-b')
  const manualID = 'ffce2c02-29ee-4734-8a4c-d18ab7f25a88'
  assert.equal((await api(bridge, '/v1/runs', { id: manualID, provider: 'codex', model: 'account-a', text: 'Review the edit', routing: { mode: 'manual', provider: 'codex', model: 'account-a', catalogBound: true } })).code, 201)
  const manualPage = await until(async () => { const page = await api(bridge, `/v1/runs/${manualID}/events`); return page.body.events.some(event => event.type === 'error') && page.body })
  assert.equal(prepared.length, 1); assert.deepEqual(manualPage.events.map(event => event.type), ['error']); assert.match(manualPage.events[0].message, /fresh verified catalog/)
  fail = true
  const failedID = 'e989bda9-d643-48c3-bf6d-fb74298106ae'
  assert.equal((await api(bridge, '/v1/runs', { id: failedID, provider: 'codex', text: 'Review the edit', routing: sessionPool, sharing: fixtureSharing(bridge.endpoint, [{provider:'codex',model:currentModel}]) })).code, 201)
  const failedPage = await until(async () => { const page = await api(bridge, `/v1/runs/${failedID}/events`); return page.body.events.some(event => event.type === 'error') && page.body })
  assert.equal(prepared.length, 1); assert.deepEqual(failedPage.events.map(event => event.type), ['error'])
  assert.equal((await api(bridge, '/v1/status')).body.catalogs.length, 0)
  assert.equal(accountCalls, 4); assert.equal(discoveries, 4)
})

test('actual HTTP status canonicalizes successful CLI account rows that omit available for native consumers', async t => {
  const root = temporary(t), previous = process.env.PATH
  fs.writeFileSync(path.join(root, 'claude'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claudeai-oauth',apiProvider:'firstParty'}))\n`, { mode: 0o700 })
  fs.writeFileSync(path.join(root, 'codex'), `#!${process.execPath}\nprocess.stdout.write('Logged in using ChatGPT\\n')\n`, { mode: 0o700 })
  process.env.PATH = root
  let sourceRows, preparations = 0
  try {
    const bridge = await startBridge({ catalogOptions: hostOptions({ providerStatus: async () => { sourceRows = await providerStatus(); return sourceRows } }), prepareAdapter: async () => { preparations++; throw new Error('Status must not launch inference.') } }); t.after(() => bridge.close())
    const result = await api(bridge, '/v1/status')
    assert.equal(result.code, 200); assert.equal(result.body.version, 1); assert.equal(result.body.routingSupported, true)
    for (const id of ['claude-code', 'codex']) {
      assert.equal(Object.hasOwn(sourceRows.find(row => row.id === id), 'available'), false)
      const row = result.body.providers.find(row => row.id === id)
      assert.equal(row.available, true); assert.equal(nativeReady(row), true)
      assert.equal(row.authentication, 'existing-cli-sign-in'); assert.equal(row.billingMode, 'subscription')
    }
    assert.equal(result.body.providers.find(row => row.id === 'antigravity').available, false)
    assert.equal(result.body.catalogs[0].provider, 'codex'); assert.equal(preparations, 0)
  } finally { process.env.PATH = previous }
})

test('actual HTTP status excludes signed-out, unknown, uninstalled, unsupported and rate-limited accounts', async t => {
  const cases = [
    { name: 'signed out', source: { id: 'codex', installed: true, authenticated: false }, available: false },
    { name: 'timed out account probe', source: { id: 'codex', installed: true, authenticated: null, available: false, reason: 'Account status could not be confirmed.' }, available: false },
    { name: 'unknown authentication', source: { id: 'codex', installed: true, authenticated: null }, available: null },
    { name: 'missing authentication', source: { id: 'codex', installed: true, available: true }, available: null, authenticated: null },
    { name: 'unknown installation', source: { id: 'codex', authenticated: true }, available: null },
    { name: 'uninstalled executable', source: { id: 'codex', installed: false, authenticated: true }, available: false },
    { name: 'explicit unavailable', source: { id: 'codex', installed: true, authenticated: true, available: false }, available: false },
    { name: 'explicit adapter disabled', source: { id: 'codex', installed: true, authenticated: true, adapterSupported: false }, available: false },
    { name: 'reported rate limit', source: { id: 'codex', installed: true, authenticated: true, rateLimited: true }, available: false },
    { name: 'unsupported Antigravity adapter', source: { id: 'antigravity', installed: true, authenticated: true }, available: false },
    { name: 'unsupported Gemini adapter', source: { id: 'gemini-cli', installed: true, authenticated: true }, available: false },
  ]
  for (const value of cases) await t.test(value.name, async child => {
    let discoveries = 0
    const bridge = await startBridge({ catalogOptions: hostOptions({ providerStatus: async () => [value.source], readCodexCatalog: async () => { discoveries++; return catalog() } }) }); child.after(() => bridge.close())
    const result = await api(bridge, '/v1/status'), row = result.body.providers[0]
    assert.equal(result.code, 200); assert.equal(row.available, value.available); assert.equal(nativeReady(row), false)
    assert.equal(row.authenticated, value.authenticated === undefined ? value.source.authenticated : value.authenticated)
    assert.equal(result.body.catalogs.length, 0); assert.equal(discoveries, 0)
  })
})

test('actual HTTP unregistered custom readiness remains unavailable with unknown configured authentication', async t => {
  const cases = [
    { name: 'configured with a synthetic auth flag', configured: true, authenticated: true, available: false },
    { name: 'configuration absent', configured: false, authenticated: true, expectedAuth: false, available: false },
    { name: 'configured but unknown authentication', configured: true, authenticated: null, available: false },
    { name: 'configured but signed out', configured: true, authenticated: false, available: false },
  ]
  for (const value of cases) await t.test(value.name, async child => {
    const custom = value.configured ? { executable: '/host-configured-agent', args: ['{model}'] } : undefined
    const bridge = await startBridge({ custom, catalogOptions: hostOptions({ providerStatus: async () => [{ id: 'custom', installed: true, authenticated: value.authenticated, authentication: 'custom-cli' }] }) }); child.after(() => bridge.close())
    const result = await api(bridge, '/v1/status'), row = result.body.providers[0]
    assert.equal(row.available, false); assert.equal(row.authenticated, value.configured ? null : false); assert.equal(row.adapterSupported, false)
    assert.equal(row.adapterManaged, value.configured); assert.equal(row.billingMode, 'unknown')
    assert.equal(nativeReady(row), value.available === true); assert.equal(row.authentication, 'custom-cli')
  })
})

test('host refresh coalesces account and metadata work; missing Claude discovery is explicit', async () => {
  const gate = deferred(); let accounts = 0, probes = 0
  const host = createAssistantCatalog(hostOptions({ providerStatus: async () => { accounts++; await gate.promise; return statuses() }, readCodexCatalog: async () => { probes++; return catalog() } }))
  assert.equal((await host.status()).loading, true)
  const first = host.status({ wait: true }), second = host.status({ wait: true }); gate.resolve()
  const values = await Promise.all([first, second])
  assert.equal(accounts, 1); assert.equal(probes, 1)
  assert.equal(values[0].catalogs[0].models.length, 3)
  assert.match(values[0].providers.find(row => row.id === 'claude-code').catalogReason, /no verified standalone/)
  assert.equal(values[0].providers.find(row => row.id === 'antigravity').adapterSupported, false)
  assert.equal(values[0].providers.find(row => row.id === 'claude-code').productLoginApproval, 'unverified')
  assert.equal((await host.resolve(prefs, { text: 'Rename this title', selectionCount: 1 })).model, 'swift')
  host.close(); await assert.rejects(host.status(), /closed/)
})

test('metadata failure cannot enable fake or previously unknown models', async () => {
  const host = createAssistantCatalog(hostOptions({ readCodexCatalog: async () => { throw new Error('The metadata process could not finish.') } }))
  const status = await host.status({ wait: true })
  assert.equal(status.catalogs.length, 0)
  assert.match(status.providers.find(row => row.id === 'codex').catalogReason, /metadata process/)
  assert.equal((await host.resolve(prefs, { text: 'Build a video' })).ok, false)
  host.close()
})

test('unregistered custom configuration cannot claim subscription readiness or discover an Auto catalog', async () => {
  let discoveries = 0
  const custom = { executable: '/custom', args: ['--model', '{model}', '--effort', '{effort}'], billingMode: 'subscription', discoverModels: async () => { discoveries++; return records } }
  const host = createAssistantCatalog(hostOptions({ custom, providerStatus: async () => [{ id: 'custom', installed: true, authenticated: true, authentication: 'custom-cli' }] }))
  const metadata = await host.status({ wait: true })
  assert.equal(metadata.providers[0].adapterManaged, true); assert.equal(metadata.providers[0].authenticated, null)
  assert.equal(metadata.providers[0].available, false); assert.equal(metadata.providers[0].adapterSupported, false); assert.equal(metadata.providers[0].billingMode, 'unknown')
  assert.deepEqual(metadata.catalogs, []); assert.equal(discoveries, 0)
  const result = await host.resolve({ mode: 'auto', enabledModels: [{ provider: 'custom', model: 'balanced' }], allowAPIBilling: true }, { text: 'Review the edit' })
  assert.equal(result.ok, false); assert.equal(discoveries, 0)
  host.close()
})

test('bridge dispatches the exact selected provider, model and advertised effort, with a route receipt', async t => {
  let prepared
  const bridge = await startBridge({ catalogOptions: hostOptions(), prepareAdapter: async request => {
    prepared = structuredClone(request)
    return { command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({type:"done",text:"Fixture complete"})+"\\n")'], cwd: os.tmpdir(), env: {}, prompt: '', cleanup: async () => {} }
  } }); t.after(() => bridge.close())
  const id = '7dc66c36-b5e6-4c91-9f42-021ca622f186'
  assert.equal((await api(bridge, '/v1/runs', { id, provider: 'claude-code', text: 'Rename this title', context: { selection: ['c1'] }, routing: prefs })).code, 201)
  const page = await until(async () => { const result = await api(bridge, `/v1/runs/${id}/events`); return result.body.events.some(row => row.type === 'done') && result.body })
  assert.equal(prepared.provider, 'codex'); assert.equal(prepared.model, 'swift'); assert.equal(prepared.effort, 'low')
  assert.equal(page.events[0].type, 'route'); assert.equal(page.events[0].routing.model, prepared.model)
  assert.equal(page.events[0].routing.billing.remainingAllowance, null)
})

test('Stop during model discovery owns the reserved UUID and never launches an agent afterwards', async t => {
  const gate = deferred(), entered = deferred(); let preparations = 0
  const bridge = await startBridge({ catalogOptions: hostOptions({ readCodexCatalog: async () => { entered.resolve(); await gate.promise; return catalog() } }), prepareAdapter: async () => { preparations++; throw new Error('Must never reach the editing adapter.') } }); t.after(() => bridge.close())
  const id = '37cc6d7d-aad8-4685-8212-92a6e0577d94'
  assert.equal((await api(bridge, '/v1/runs', { id, provider: 'claude-code', text: 'Build a video', routing: prefs })).code, 201)
  await entered.promise
  assert.equal((await api(bridge, `/v1/runs/${id}/cancel`, {})).body.cancelled, true)
  gate.resolve(); await sleep(30)
  assert.equal(preparations, 0)
  const page = await api(bridge, `/v1/runs/${id}/events`)
  assert.deepEqual(page.body.events.map(row => row.type), ['error'])
})

test('browser Auto settings persist the exact enabled pool and expose it in status', async t => {
  const root = temporary(t)
  const service = createBrowserAssistant({ root, now: () => at, getIdentity: () => 1, getOutline: () => ({ version: 1 }), catalogOptions: hostOptions() }); t.after(() => service.close())
  const status = await service.configure(prefs)
  assert.equal(status.configured, true); assert.equal(status.mode, 'auto'); assert.equal(status.providerName, 'Auto')
  assert.equal(status.catalogs[0].models.length, 3)
  assert.deepEqual(status.enabledModels, prefs.enabledModels)
  const stored = JSON.parse(fs.readFileSync(path.join(root, '.reel/assistant-settings.json')))
  assert.deepEqual(stored.enabledModels, prefs.enabledModels); assert.equal(stored.priority, 'balanced')
})

test('browser Stop while status is pending prevents late companion submission', async t => {
  const root = temporary(t), gate = deferred(), entered = deferred(); let bridges = 0
  const service = createBrowserAssistant({ root, getIdentity: () => 1, getOutline: () => ({ version: 1 }), catalogOptions: hostOptions({ providerStatus: async () => { entered.resolve(); await gate.promise; return statuses() } }), startBridge: async () => { bridges++; throw new Error('Must never start the companion after Stop.') } }); t.after(() => service.close())
  const sending = service.send({ text: 'Rename this title', ids: ['c1'] })
  await entered.promise
  assert.equal(service.snapshot().state, 'thinking')
  assert.equal((await service.cancel()).cancelled, true)
  gate.resolve(); await assert.rejects(sending, /no longer active/)
  assert.equal(bridges, 0); assert.equal(service.snapshot().state, 'cancelled')
})

test('actual Codex adapter argument construction binds exact model and effort while retaining permission isolation', async t => {
  const root = temporary(t), previous = process.env.PATH
  const fixture = path.join(root, 'codex'); fs.writeFileSync(fixture, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  process.env.PATH = root
  try {
    const adapter = await prepareAdapter({ id: 'b1', provider: 'codex', text: 'Fixture', model: 'balanced', effort: 'medium' }, { endpoint: 'http://127.0.0.1:1/', token: 'x'.repeat(64) })
    t.after(() => adapter.cleanup())
    assert.equal(adapter.command, fixture)
    assert.equal(adapter.args[adapter.args.indexOf('--model') + 1], 'balanced')
    assert.ok(adapter.args.includes('model_reasoning_effort="medium"'))
    assert.ok(adapter.args.includes('--strict-config')); assert.ok(adapter.args.includes('forced_login_method="chatgpt"'))
    assert.equal(adapter.env.OPENAI_API_KEY, undefined)
  } finally { process.env.PATH = previous }
})

test('failed provider status is unknown, while explicit signed-out JSON remains a sign-in recovery', async t => {
  const root = temporary(t), previous = process.env.PATH
  const command = path.join(root, 'claude')
  process.env.PATH = root
  try {
    fs.writeFileSync(command, `#!${process.execPath}\nprocess.stderr.write('private diagnostic should stay private');process.exit(2)\n`, { mode: 0o700 })
    const failed = (await providerStatus()).find(row => row.id === 'claude-code')
    assert.equal(failed.authenticated, null); assert.match(failed.reason, /does not establish that you are signed out/)
    assert.equal(failed.reason.includes('private diagnostic'), false)
    fs.writeFileSync(command, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({loggedIn:false}));process.exit(1)\n`, { mode: 0o700 })
    const signedOut = (await providerStatus()).find(row => row.id === 'claude-code')
    assert.equal(signedOut.authenticated, false); assert.match(signedOut.reason, /Sign in/)
  } finally { process.env.PATH = previous }
})

test('unknown Auto models or Manual efforts never replace saved valid preferences', async t => {
  const root = temporary(t)
  const service = createBrowserAssistant({ root, now: () => at, getIdentity: () => 1, getOutline: () => ({ version: 1 }), catalogOptions: hostOptions() }); t.after(() => service.close())
  await service.configure({ provider: 'codex', model: 'balanced' })
  const file = path.join(root, '.reel/assistant-settings.json'), before = fs.readFileSync(file, 'utf8')
  await assert.rejects(service.configure({ mode: 'auto', enabledModels: [{ provider: 'codex', model: 'not-reported-by-provider' }] }), /verified catalog/)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  await assert.rejects(service.configure({ provider: 'codex', model: 'swift', effort: 'ultra' }), /not available in a fresh verified catalog/)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  await assert.rejects(service.configure({ provider: 'codex', model: 'not-reported-by-provider', catalogBound: true }), /not available in a fresh verified catalog/)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(service.snapshot().model, 'balanced')
})

test('recorded real Codex model/list catalog yields different exact models for small edits, review and creative builds', () => {
  const recorded = JSON.parse(fs.readFileSync(new URL('./fixtures/codex-catalog-2026-10-03.json', import.meta.url)))
  const preferences = { mode: 'auto', enabledModels: recorded.models.map(model => ({ provider: 'codex', model: model.id })) }
  const base = { preferences, catalogs: [recorded], providers: [{ id: 'codex', authenticated: true, adapterSupported: true, modelSelectionSupported: true, billingMode: 'subscription' }], now: recorded.checkedAt }
  assert.equal(recorded.models.length, 8)
  const small = selectRoute({ ...base, request: { text: 'Rename this title', selectionCount: 1 } })
  const review = selectRoute({ ...base, request: { text: 'Review the pacing and suggest improvements' } })
  const creative = selectRoute({ ...base, request: { text: 'Build a video with motion and transitions from this screenplay', inputKind: 'screenplay' } })
  assert.equal(small.model, 'gpt-6-luna'); assert.equal(small.effort, 'low')
  assert.equal(review.model, 'gpt-6.1-sol'); assert.equal(review.effort, 'medium')
  assert.equal(creative.model, 'gpt-6-astra'); assert.equal(creative.effort, 'high')
  for (const route of [small, review, creative]) { assert.equal(route.policyVersion, 'provider-description-v1'); assert.equal(route.billing.estimatedCost, null) }
})

test('unregistered custom argv does not establish model dispatch capabilities or a catalog', async () => {
  const custom = { executable: '/custom', discoverModels: async () => records, billingMode: 'subscription' }
  const host = createAssistantCatalog(hostOptions({ custom, providerStatus: async () => [{ id: 'custom', installed: true, authenticated: true }] }))
  const metadata = await host.status({ wait: true })
  assert.equal(metadata.providers[0].modelSelectionSupported, false)
  assert.deepEqual(metadata.catalogs, [])
  const result = await host.resolve({ mode: 'auto', enabledModels: [{ provider: 'custom', model: 'balanced' }] }, { text: 'Review' })
  assert.equal(result.ok, false); assert.match(result.blocked[0].reason, /authentication or editing adapter/)
  host.close()
})

test('custom argv bindings transmit exact requested model and effort as literal process arguments', async t => {
  const adapter = await prepareAdapter({ id: 'c1', provider: 'custom', text: 'Fixture', model: 'balanced', effort: 'high' }, { endpoint: 'http://127.0.0.1:1/', token: 'x'.repeat(64) }, { executable: process.execPath, args: ['--model={model}', '--effort={effort}', '{context}'] })
  t.after(() => adapter.cleanup())
  assert.equal(adapter.args[0], '--model=balanced'); assert.equal(adapter.args[1], '--effort=high')
  assert.ok(adapter.args[2].endsWith('/context.json'))
})

test('legacy custom Manual refuses an unknown recipient before binding or launching its executable', async t => {
  const root = temporary(t), marker = path.join(root, 'launched'), script = path.join(root, 'custom.mjs')
  fs.writeFileSync(script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'launched');process.stdout.write(JSON.stringify({type:'done'})+'\\n')`)
  const bridge = await startBridge({ custom: { executable: process.execPath, args: [script] } }); t.after(() => bridge.close())
  const id = 'cdd5210e-6628-4745-98f2-3e829c45a6cd'
  const rejected = await api(bridge, '/v1/runs', { id, provider: 'custom', model: 'not-bound', text: 'Fixture', sharing: fixtureSharing(bridge.endpoint) })
  assert.equal(rejected.code, 403); assert.match(rejected.body.error, /no verified AI recipient/)
  assert.equal((await api(bridge, `/v1/runs/${id}/events`)).code, 404)
  assert.equal(fs.existsSync(marker), false)
  await assert.rejects(prepareAdapter({ provider: 'custom', model: 'not-bound' }, {}, { executable: process.execPath, args: [script] }), /cannot bind an exact/)
  await assert.rejects(prepareAdapter({ provider: 'custom', effort: 'high' }, {}, { executable: process.execPath, args: [script] }), /cannot bind the requested reasoning effort/)
})

test('unregistered custom discovery is not invoked or exposed', async () => {
  const custom = { executable: '/custom', args: ['{model}'], discoverModels: async () => { throw new Error('PRIVATE_CATALOG_DETAIL') } }
  const host = createAssistantCatalog(hostOptions({ custom, providerStatus: async () => [{ id: 'custom', installed: true, authenticated: true }] }))
  const metadata = await host.status({ wait: true })
  assert.equal(JSON.stringify(metadata).includes('PRIVATE_CATALOG_DETAIL'), false)
  assert.equal(metadata.providers[0].available, false); assert.deepEqual(metadata.catalogs, [])
  host.close()
})
