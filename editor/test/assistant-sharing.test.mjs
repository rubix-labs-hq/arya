import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createBrowserAssistant } from '../agent/browser-assistant.mjs'
import { startBridge } from '../agent/bridge.mjs'
import assistantRoutes from '../routes/assistant.mjs'
import { normalizeCatalog } from '../core/assistant-routing.mjs'
import { SHARING_CLASSES, canonicalCompanion, normalizeSharingEnvelope, normalizeSharingScope, sameSharingScope, sharingScopeForRoute } from '../core/assistant-sharing.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const accounts = async () => [{ id: 'claude-code', installed: true, authenticated: true }, { id: 'codex', installed: true, authenticated: true }]
const scope = (companion, models = [{ provider: 'claude-code', model: '' }]) => ({ providers: [...new Set(models.map(item => item.provider))], models, companion, classes: [...SHARING_CLASSES] })
const envelope = (companion, models) => ({ version: 1, approved: true, scope: scope(companion, models) })
const records = [{ id: 'one', description: 'Everyday workhorse', requiresUsageCredits: false }, { id: 'two', description: 'Fast simple work', requiresUsageCredits: false }]
const catalogOptions = (additions = {}) => ({ providerStatus: accounts, executable: async () => '/fixture-only', readCodexCatalog: async () => normalizeCatalog({ provider: 'codex', records, checkedAt: Date.now(), source: { kind: 'provider-cli', label: 'Inert fixture' } }), ...additions })
const waitFor = async predicate => { for (let i = 0; i < 150; i++) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)) }; assert.fail('Fixture did not reach expected state.') }
async function api(owner, route, body) {
  const response = await fetch(new URL(route, owner.endpoint), { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${owner.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}
function fixture(t, additions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-sharing-consent-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const counters = { outlines: 0, prompts: 0, adapters: 0, tools: 0 }
  const service = createBrowserAssistant({ root, providerStatus: accounts, catalogOptions: catalogOptions({ providerStatus: additions.providerStatus ?? accounts }), getIdentity: () => 1, getOutline: () => { counters.outlines++; return { version: 1, privateTitle: 'PRIVATE_PROJECT_CONTENT' } }, dispatch: async () => { counters.tools++; return {} }, onPrompt: () => counters.prompts++, bridgeOptions: { catalogOptions: catalogOptions(), prepareAdapter: async () => { counters.adapters++; return { command: process.execPath, args: ['-e', "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'done',text:'Inert fixture finished.'})))"], cwd: root, env: {}, prompt: 'Inert fixture', cleanup: async () => {} } } }, ...additions })
  t.after(() => service.close())
  return { root, service, counters }
}
async function allow(service) {
  const review = await service.sharing()
  const granted = await service.grantSharing({ reviewID: review.reviewID, sharing: { version: 1, approved: true, scope: review.scope } })
  assert.equal(granted.approved, true)
  return granted.sharing
}

test('canonical sharing scope requires exact known recipients and every data category', () => {
  assert.equal(canonicalCompanion('http://LOCALHOST:80/'), 'http://127.0.0.1/')
  assert.equal(canonicalCompanion('https://EXAMPLE.test:443/'), 'https://example.test/')
  for (const value of ['http://remote.test/', 'https://user:secret@example.test/', 'https://example.test/path', 'https://example.test/?token=x', 'https://example.test/#x']) assert.throws(() => canonicalCompanion(value))
  const valid = envelope('http://127.0.0.1:9000/')
  assert.equal(normalizeSharingEnvelope(valid).scope.classes.length, 7)
  for (const value of [null, { ...valid, approved: false }, { ...valid, version: 2 }, { ...valid, token: 'secret' }]) assert.throws(() => normalizeSharingEnvelope(value))
  for (const value of [{ ...valid.scope, providers: ['custom'], models: [{ provider: 'custom', model: '' }] }, { ...valid.scope, classes: ['prompt'] }, { ...valid.scope, classes: [...SHARING_CLASSES, 'prompt'] }, { ...valid.scope, models: [{ provider: 'claude-code', model: '' }, { provider: 'claude-code', model: '' }] }, { ...valid.scope, credentials: 'secret' }]) assert.throws(() => normalizeSharingScope(value))
  assert.ok(sameSharingScope(valid.scope, { ...valid.scope, classes: [...valid.scope.classes].reverse() }))
})

test('review and grant endpoints disclose broad classes without reading a project or launching inference', async t => {
  const { service, counters, root } = fixture(t), routes = assistantRoutes({ assistant: service }).routes
  const review = await routes['GET /api/assistant/sharing']()
  assert.equal(review.version, 1); assert.equal(review.approved, false); assert.equal(review.required, true)
  assert.deepEqual(review.scope.classes, [...SHARING_CLASSES]); assert.match(review.disclosure.classes.find(item => item.id === 'project_content').description, /Whole-project.*transcripts/)
  assert.deepEqual(counters, { outlines: 0, prompts: 0, adapters: 0, tools: 0 })
  const response = await routes['POST /api/assistant/sharing/grant']({ reviewID: review.reviewID, sharing: { version: 1, approved: true, scope: review.scope } })
  assert.ok(sameSharingScope(response.scope, review.scope)); assert.equal(response.version, 1); assert.equal(response.sharing.approved, true)
  const saved = fs.readFileSync(path.join(root, '.reel', 'assistant-sharing.json'), 'utf8')
  assert.equal(fs.statSync(path.join(root, '.reel', 'assistant-sharing.json')).mode & 0o777, 0o600)
  assert.equal(/PRIVATE_PROJECT_CONTENT|Bearer|"token"/.test(saved + JSON.stringify(review)), false)
  assert.match(JSON.parse(saved).credentialDigest, /^[a-f0-9]{64}$/)
})

test('missing approval or invented envelope cannot call onPrompt, getOutline or an adapter', async t => {
  const { service, counters } = fixture(t)
  await assert.rejects(service.send({ text: 'PRIVATE_DRAFT' }), /permission.*required/)
  const review = await service.sharing()
  await assert.rejects(service.send({ text: 'PRIVATE_DRAFT', sharing: { version: 1, approved: true, scope: review.scope } }), /permission.*required/)
  assert.deepEqual(counters, { outlines: 0, prompts: 0, adapters: 0, tools: 0 })
  await assert.rejects(service.grantSharing({ sharing: envelope(review.scope.companion) }), /Review/)
  await assert.rejects(service.grantSharing({ reviewID: review.reviewID, sharing: envelope(review.scope.companion, [{ provider: 'codex', model: 'one' }]) }), /exact recipients/)
})

test('explicit grant admits one inert known-provider run and survives status polls', async t => {
  const { service, counters } = fixture(t), sharing = await allow(service)
  assert.equal((await service.sharing()).approved, true)
  const result = await service.send({ text: 'Fixture', sharing })
  assert.match(result.runId, /^[a-f0-9-]{36}$/)
  await waitFor(() => service.snapshot().state === 'done')
  assert.equal(counters.prompts, 1); assert.equal(counters.adapters, 1); assert.equal(service.snapshot().sharingConsentVersion, 1)
})

test('a pending grant cannot restore permission after withdrawal', async t => {
  const blocked = deferred(), started = deferred(); let wait = false
  const { service } = fixture(t, { providerStatus: async () => { if (wait) { started.resolve(); await blocked.promise }; return accounts() } })
  const review = await service.sharing(); wait = true
  const granting = service.grantSharing({ reviewID: review.reviewID, sharing: { version: 1, approved: true, scope: review.scope } })
  await started.promise
  assert.equal((await service.revokeSharing()).revoked, true)
  blocked.resolve(); wait = false
  await assert.rejects(granting, /changed|withdrawn/)
  assert.equal((await service.sharing()).approved, false)
  await assert.rejects(service.grantSharing({ reviewID: review.reviewID, sharing: { version: 1, approved: true, scope: review.scope } }), /expired|withdrawn/)
})

test('configuration and project identity invalidate review capabilities', async t => {
  let identity = 1
  const { service } = fixture(t, { getIdentity: () => identity })
  const review = await service.sharing(); identity = 2
  await assert.rejects(service.grantSharing({ reviewID: review.reviewID, sharing: envelope(review.scope.companion) }), /expired|withdrawn/)
  const next = await service.sharing(); await service.configure({ provider: 'claude-code', model: 'sonnet' })
  await assert.rejects(service.grantSharing({ reviewID: next.reviewID, sharing: envelope(next.scope.companion) }), /expired|withdrawn/)
})

test('withdrawal during send metadata prevents late outline or provider submission', async t => {
  const blocked = deferred(), started = deferred(); let wait = false
  const { service, counters } = fixture(t, { providerStatus: async () => { if (wait) { started.resolve(); await blocked.promise }; return accounts() } })
  const sharing = await allow(service); wait = true
  const sending = service.send({ text: 'Draft preserved', sharing })
  await started.promise
  const revoked = await service.revokeSharing()
  assert.equal(revoked.cancelled, true)
  blocked.resolve(); wait = false
  await assert.rejects(sending, /no longer active|permission changed/)
  assert.deepEqual(counters, { outlines: 0, prompts: 0, adapters: 0, tools: 0 })
})

test('saved permission does not cover a new companion credential identity', async t => {
  const first = fixture(t), sharing = await allow(first.service)
  await first.service.close()
  const next = createBrowserAssistant({ root: first.root, providerStatus: accounts, catalogOptions: catalogOptions(), getIdentity: () => 1, getOutline: () => { assert.fail('No project content may be read') } })
  t.after(() => next.close())
  assert.equal((await next.sharing()).approved, false)
  await assert.rejects(next.send({ text: 'Draft', sharing }), /permission.*required/)
})

test('unknown custom recipients fail before outline, history or preparation', async t => {
  const { service, counters } = fixture(t, { custom: { executable: process.execPath, args: [] }, providerStatus: async () => [{ id: 'custom', installed: true, authenticated: true }] })
  await service.configure({ provider: 'custom' })
  const status = await service.status({ wait: true })
  const custom = status.providers.find(row => row.id === 'custom')
  assert.deepEqual({ installed: custom.installed, authenticated: custom.authenticated, available: custom.available, adapterSupported: custom.adapterSupported },
    { installed: true, authenticated: null, available: false, adapterSupported: false })
  assert.equal(status.configured, false)
  await assert.rejects(service.sharing(), /This provider is not ready for an editing request\./)
  await assert.rejects(service.send({ text: 'Draft', sharing: envelope('http://127.0.0.1:1/') }), /Custom editing is unavailable on this host/)
  assert.throws(() => normalizeSharingScope(scope('http://127.0.0.1:1/', [{ provider: 'custom', model: '' }])), /recipient.*unknown/)
  assert.deepEqual(counters, { outlines: 0, prompts: 0, adapters: 0, tools: 0 })
})

test('fresh Auto pool changes require a new review before any content is read', async t => {
  let pool = records.slice(0, 1)
  const { service, counters } = fixture(t, { catalogOptions: catalogOptions({ readCodexCatalog: async () => normalizeCatalog({ provider: 'codex', records: pool, checkedAt: Date.now(), source: { kind: 'provider-cli', label: 'Fixture' } }) }) })
  await service.configure({ mode: 'auto', enabledModels: [{ provider: 'codex', model: 'one' }] })
  const sharing = await allow(service)
  pool = records.slice(1)
  await assert.rejects(service.send({ text: 'Draft', sharing }), /No enabled|permission|unavailable/)
  assert.deepEqual(counters, { outlines: 0, prompts: 0, adapters: 0, tools: 0 })
})

test('bridge rejects old clients, unknown recipients and wrong companions before storing or preparing a run', async t => {
  let preparations = 0
  const bridge = await startBridge({ catalogOptions: catalogOptions(), prepareAdapter: async () => { preparations++; throw new Error('Must not launch') } })
  t.after(() => bridge.close())
  const status = await api(bridge, '/v1/status')
  assert.equal(status.body.sharingConsentVersion, 1); assert.equal(status.body.sharingCompanion, bridge.endpoint)
  const id = randomUUID(), body = { id, provider: 'claude-code', text: 'PRIVATE_DRAFT' }
  assert.equal((await api(bridge, '/v1/runs', body)).status, 403)
  assert.equal((await api(bridge, `/v1/runs/${id}/events`)).status, 404)
  assert.equal((await api(bridge, '/v1/runs', { ...body, sharing: envelope('https://unknown.test/') })).status, 403)
  assert.equal((await api(bridge, '/v1/runs', { ...body, provider: 'custom', sharing: envelope(bridge.endpoint) })).status, 403)
  assert.equal(preparations, 0)
})

test('bridge verifies the complete fresh eligible Auto pool before adapter preparation', async t => {
  let preparations = 0
  const bridge = await startBridge({ catalogOptions: catalogOptions(), prepareAdapter: async () => { preparations++; throw new Error('Must not launch') } })
  t.after(() => bridge.close())
  const id = randomUUID(), body = { id, provider: 'claude-code', text: 'Draft', routing: { mode: 'auto', enabledModels: [{ provider: 'codex', model: 'one' }, { provider: 'codex', model: 'two' }] }, sharing: envelope(bridge.endpoint, [{ provider: 'codex', model: 'one' }]) }
  assert.equal((await api(bridge, '/v1/runs', body)).status, 201)
  const events = await waitFor(async () => { const value = (await api(bridge, `/v1/runs/${id}/events`)).body.events; return value.some(item => item.type === 'error') ? value : false })
  assert.match(events.find(item => item.type === 'error').message, /pool changed/); assert.equal(preparations, 0)
})

test('Stop during bridge discovery preserves ownership and prevents a later launch', async t => {
  const gate = deferred(), started = deferred(); let preparations = 0
  const bridge = await startBridge({ catalogOptions: catalogOptions({ providerStatus: async () => { started.resolve(); await gate.promise; return accounts() } }), prepareAdapter: async () => { preparations++; throw new Error('Must not launch') } })
  t.after(() => bridge.close())
  const id = randomUUID()
  assert.equal((await api(bridge, '/v1/runs', { id, provider: 'claude-code', text: 'Draft', sharing: envelope(bridge.endpoint) })).status, 201)
  await started.promise
  assert.equal((await api(bridge, `/v1/runs/${id}/cancel`, {})).body.cancelled, true)
  gate.resolve()
  await waitFor(async () => (await api(bridge, `/v1/runs/${id}/events`)).body.events.some(item => item.type === 'error'))
  assert.equal(preparations, 0)
})

test('declared local and public companion identities both admit their exact scopes', async t => {
  let preparations = 0
  const bridge = await startBridge({ publicEndpoint: 'https://COMPANION.example:443/', catalogOptions: catalogOptions(), prepareAdapter: async () => {
    preparations++
    return { command: process.execPath, args: ['-e', 'console.log(JSON.stringify({type:"done"}))'], cwd: os.tmpdir(), env: {}, prompt: '', cleanup: async () => {} }
  } })
  t.after(() => bridge.close())
  const status = (await api(bridge, '/v1/status')).body
  assert.equal(status.sharingCompanion, 'https://companion.example/'); assert.equal(status.localCompanion, bridge.endpoint)
  for (const destination of [status.localCompanion, status.sharingCompanion]) {
    const id = randomUUID()
    assert.equal((await api(bridge, '/v1/runs', { id, provider: 'claude-code', text: 'Fixture', sharing: envelope(destination) })).status, 201)
    await waitFor(async () => (await api(bridge, `/v1/runs/${id}/events`)).body.events.some(item => item.type === 'done'))
  }
  assert.equal(preparations, 2)
  assert.equal((await api(bridge, '/v1/runs', { id: randomUUID(), provider: 'claude-code', text: 'Draft', sharing: envelope('https://other.example/') })).status, 403)
})

test('a narrowed class list cannot authorize tools or frame inspection', () => {
  const approved = envelope('http://127.0.0.1:1/')
  for (const id of ['rendered_frames', 'reference_images', 'conversation_history', 'tool_results', 'project_content']) assert.throws(() => normalizeSharingEnvelope({ ...approved, scope: { ...approved.scope, classes: approved.scope.classes.filter(value => value !== id) } }))
  assert.deepEqual(sharingScopeForRoute({ ok: true, mode: 'manual', provider: 'claude-code', model: null }, approved.scope.companion).models, [{ provider: 'claude-code', model: '' }])
})

test('withdrawal blocks in-flight project JSON and frame results before they reach the companion', async t => {
  const { default: http } = await import('node:http')
  for (const kind of ['project JSON', 'frame image']) await t.test(kind, async child => {
    const entered = deferred(), release = deferred(); let emitted = false, forwarded = 0
    const listener = http.createServer(async (request, response) => {
      for await (const chunk of request) {}
      const reply = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
      if (request.url === '/v1/runs') return reply({ id: 'fixture' })
      if (request.url.endsWith('/cancel')) return reply({ id: request.url.split('/')[3], cancelled: true })
      if (request.url.includes('/tools/')) { forwarded++; return reply({ accepted: true }) }
      if (!emitted) { emitted = true; return reply({ events: [{ seq: 1, type: 'tool', callID: 'private', ...(kind === 'frame image' ? { frame: { at: 0, width: 320 } } : { method: 'GET', path: '/api/project' }) }] }) }
      return reply({ events: [] })
    })
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${listener.address().port}/`
    const { service } = fixture(child, { startBridge: async () => ({ endpoint, token: 'inert-fixture-token', close: async () => {} }),
      dispatch: async () => { entered.resolve(); await release.promise; return { wholeProject: 'PRIVATE_TOOL_RESULT' } },
      renderFrame: async () => { entered.resolve(); await release.promise; assert.fail('A withdrawn frame must not be read or forwarded') },
    })
    child.after(async () => { release.resolve(); await service.close(); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)) })
    const sharing = await allow(service)
    await service.send({ text: 'Inert inspection', sharing })
    await entered.promise
    assert.equal((await service.revokeSharing()).cancelled, true)
    release.resolve()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(forwarded, 0); assert.equal(service.snapshot().state, 'cancelled')
  })
})

test('sharing grant persistence rejects a linked target without replacing external bytes', async t => {
  const { root, service } = fixture(t), external = path.join(root, 'private-external'), file = path.join(root, '.reel', 'assistant-sharing.json')
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(external, 'PRIVATE_ORIGINAL'); fs.symlinkSync(external, file)
  const review = await service.sharing(), sharing = { version: 1, approved: true, scope: review.scope }
  await assert.rejects(service.grantSharing({ reviewID: review.reviewID, sharing }), /symbolic links/)
  assert.equal(fs.readFileSync(external, 'utf8'), 'PRIVATE_ORIGINAL')
  await assert.rejects(service.send({ text: 'Draft', sharing }), /permission.*required/)
})

test('expired review capabilities cannot grant saved sharing permission', async t => {
  const { service } = fixture(t), review = await service.sharing(), previous = Date.now
  Date.now = () => previous() + 5 * 60 * 1000 + 1
  try { await assert.rejects(service.grantSharing({ reviewID: review.reviewID, sharing: { version: 1, approved: true, scope: review.scope } }), /expired|withdrawn/) }
  finally { Date.now = previous }
})

test('actual bridge CLI advertises explicit HTTPS identity while listening only on loopback', async t => {
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-sharing-empty-path-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../agent/bridge.mjs', import.meta.url)), '--port', '0', '--public-endpoint', 'https://COMPANION.example:443/'], { env: { ...process.env, PATH: bin }, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exit }; fs.rmSync(bin, { recursive: true, force: true }) })
  let output = ''
  const pairing = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.stdout.on('data', bytes => { output += bytes; if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0])) })
    child.once('exit', () => reject(new Error('CLI exited before publishing its local pairing.')))
  })
  const owner = { endpoint: `http://127.0.0.1:${pairing.port}/`, token: pairing.token }, status = (await api(owner, '/v1/status')).body
  assert.equal(status.sharingCompanion, 'https://companion.example/'); assert.equal(status.localCompanion, owner.endpoint)
  assert.equal(status.sharingConsentVersion, 1); assert.equal(new URL(pairing.pairURL).searchParams.get('port'), String(pairing.port))
  assert.equal(status.providers.every(row => row.installed === false), true, 'An empty fixture PATH prevents real provider metadata or inference')
})
