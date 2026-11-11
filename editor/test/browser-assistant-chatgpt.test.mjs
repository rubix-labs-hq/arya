import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBrowserAssistant } from '../agent/browser-assistant.mjs'
import { createChatGPTAccount } from '../agent/chatgpt-account.mjs'
import { approveFixture } from './fixtures/sharing-fixture.mjs'
import { startChatGPTFake } from './fixtures/chatgpt-fake.mjs'

// The page-facing layer: what the editor shows and allows around Sign in with ChatGPT.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, ms = 15000) => {
  const deadline = Date.now() + ms
  do { const value = await predicate(); if (value) return value; await sleep(15) } while (Date.now() < deadline)
  assert.fail('The ChatGPT browser assistant fixture did not reach the expected state.')
}
const statuses = async () => [{ id: 'claude-code', installed: true, authenticated: true, reason: 'Fixture account login.' }]
const completed = () => ({ type: 'response.completed', response: { status: 'completed', output: [] } })

async function setup(t, { chatgpt = true, clock } = {}) {
  const fake = await startChatGPTFake(clock ? { now: () => clock.now } : {})
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-browser-chatgpt-'))
  const project = path.join(root, 'project'); fs.mkdirSync(project)
  const account = chatgpt ? createChatGPTAccount({ directory: path.join(root, 'account'), endpoints: fake.endpoints, retryDelays: [1, 1, 1], ...(clock ? { now: () => clock.now } : {}), openURL: async url => { await fake.browser(url); return true } }) : undefined
  const service = createBrowserAssistant({ root: project, platform: 'darwin', providerStatus: statuses, getIdentity: () => 1, getOutline: () => ({ version: 1 }), dispatch: async () => ({ ok: true }),
    renderFrame: async () => ({ path: path.join(project, 'frame.png') }), chatgpt: account, bridgeOptions: { catalogOptions: { providerStatus: statuses } } })
  t.after(async () => { await service.close(); account?.close(); await fake.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { fake, account, service, project, accountDirectory: path.join(root, 'account') }
}
async function signIn(service, body = {}) {
  const started = await service.chatgptSignIn(body)
  assert.equal(started.started, true)
  return waitFor(async () => { const value = (await service.status()).chatgpt; return ['done', 'failed', 'cancelled', 'expired'].includes(value.attempt.state) && value })
}
const finished = service => waitFor(() => ['done', 'error', 'cancelled'].includes(service.snapshot().state) && service.snapshot())

test('sharing follows the saved account and session across editor processes', async t => {
  const { fake, account, service, accountDirectory } = await setup(t)
  await signIn(service)
  await waitFor(async () => (await service.status()).provider === 'chatgpt')
  await service.status({ wait: true, refresh: true })
  await approveFixture(service)
  const stale = await service.sharing()
  const initialIdentity = account.sharingIdentity()
  const other = createChatGPTAccount({ directory: accountDirectory, endpoints: fake.endpoints, retryDelays: [1, 1, 1], openURL: async url => { await fake.browser(url); return true } })
  t.after(() => other.close())
  fake.consent.push({ subject: 'second-account', email: 'second@example.com' })
  await other.signIn({ newAccount: true })
  await waitFor(() => other.status().attempt.state === 'done')
  assert.notEqual(account.sharingIdentity(), initialIdentity)
  assert.equal((await service.sharing()).approved, false)
  await assert.rejects(service.grantSharing({ reviewID: stale.reviewID, sharing: { version: 1, approved: true, scope: stale.scope } }), /changed|review/i)
  await assert.rejects(service.send({ text: 'Must not send through the other account' }), /sharing/i)
  assert.equal(fake.responseBodies.length, 0)
  await approveFixture(service)
  assert.equal((await service.sharing()).approved, true)
  const selectedIdentity = account.sharingIdentity()
  await other.signIn()
  await waitFor(() => other.status().attempt.state === 'done' && account.sharingIdentity() !== selectedIdentity)
  assert.equal((await service.sharing()).approved, false, 'reauthorizing the same account also needs a new review')
})

test('an editor without a ChatGPT host offers no ChatGPT sign-in', async t => {
  const { service } = await setup(t, { chatgpt: false })
  const status = await service.status({ wait: true })
  assert.deepEqual(status.chatgpt, { supported: false })
  assert.equal(status.providers.some(row => row.id === 'chatgpt'), false)
  await assert.rejects(service.chatgptSignIn({}), /not available/)
  await assert.rejects(service.configure({ provider: 'chatgpt' }))
})

test('first ChatGPT sign-in becomes the assistant, keeps tokens out of status and validates input', async t => {
  const { fake, service, project } = await setup(t)
  const before = await service.status({ wait: true })
  assert.equal(before.chatgpt.supported, true); assert.equal(before.chatgpt.signedIn, false)
  const row = before.providers.find(item => item.id === 'chatgpt')
  assert.equal(row.authenticated, false); assert.match(row.reason, /Continue with ChatGPT/)
  for (const body of [{ password: 'secret' }, { account: '../../x' }, { newAccount: 'yes' }]) await assert.rejects(service.chatgptSignIn(body))
  await assert.rejects(service.chatgptSignOut({ account: 5 }))

  const signed = await signIn(service)
  assert.equal(signed.attempt.state, 'done', signed.attempt.message)
  assert.equal(signed.planUsage, true); assert.equal(signed.welcome, true)
  // No assistant was chosen yet, so ChatGPT becomes the assistant. Sharing still needs review.
  await waitFor(async () => (await service.status()).provider === 'chatgpt')
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.reel', 'assistant-settings.json'), 'utf8')).provider, 'chatgpt')
  assert.equal((await service.sharing()).approved, false)
  const ready = await service.status({ wait: true, refresh: true })
  assert.equal(ready.configured, true)
  const published = JSON.stringify(ready)
  for (const secret of [...fake.access.keys(), ...fake.refresh.keys()]) assert.equal(published.includes(secret), false)
  assert.equal(published.includes('oaiapp_'), false); assert.equal(/eyJ[A-Za-z0-9_-]{10,}\./.test(published), false)
  assert.equal((await service.chatgptWelcome()).chatgpt.welcome, false)
})

test('a ChatGPT sign-in never replaces a chosen assistant or its sharing permission', async t => {
  const { service } = await setup(t)
  await service.status({ wait: true })
  await service.configure({ provider: 'claude-code' })
  await approveFixture(service)
  assert.equal((await service.sharing()).approved, true)
  assert.equal((await signIn(service)).attempt.state, 'done')
  await sleep(100)
  assert.equal((await service.status()).provider, 'claude-code')
  assert.equal((await service.sharing()).approved, true)
})

test('ChatGPT requests run from the editor, report plan errors by code, and need new sharing after an account change', async t => {
  const { fake, service, project } = await setup(t)
  assert.equal((await signIn(service)).attempt.state, 'done')
  await waitFor(async () => (await service.status()).provider === 'chatgpt')
  await service.status({ wait: true, refresh: true })
  await approveFixture(service)

  fake.responses.push(() => [{ type: 'response.output_text.delta', delta: 'Hello from ChatGPT.' }, completed()])
  await service.send({ text: 'Say hello' })
  const done = await finished(service)
  assert.equal(done.state, 'done', done.text); assert.equal(done.text, 'Hello from ChatGPT.'); assert.equal(done.errorCode, null)
  assert.equal(done.routing.provider, 'chatgpt')

  fake.responses.push(() => [{ type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Limit' } } }])
  await service.send({ text: 'Say hello again' })
  const limited = await finished(service)
  assert.equal(limited.state, 'error'); assert.equal(limited.errorCode, 'chatgpt_usage_limit')
  assert.match(limited.text, /usage limit/i)

  // Sharing named the first ChatGPT account. Another account needs a new review.
  fake.consent.push({ subject: 'user-second', email: 'sam@example.com' })
  const second = await signIn(service, { newAccount: true })
  assert.equal(second.attempt.state, 'done'); assert.equal(second.email, 'sam@example.com'); assert.equal(second.accounts.length, 2)
  assert.equal((await service.sharing()).approved, false)
  assert.equal(fs.existsSync(path.join(project, '.reel', 'assistant-sharing.json')), false)
})

test('signing out stops a running ChatGPT request before the tokens are revoked', async t => {
  const { fake, service } = await setup(t)
  assert.equal((await signIn(service)).attempt.state, 'done')
  await waitFor(async () => (await service.status()).provider === 'chatgpt')
  await service.status({ wait: true, refresh: true })
  await approveFixture(service)
  let release
  const held = new Promise(resolve => { release = resolve })
  t.after(() => release())
  fake.responses.push(async () => { await held; return [completed()] })
  await service.send({ text: 'Wait for me' })
  await waitFor(() => fake.responseBodies.length === 1)
  const result = await service.chatgptSignOut({})
  assert.equal(result.signedOut, true); assert.equal(result.revocationConfirmed, true)
  assert.equal(result.chatgpt.signedIn, false)
  assert.equal(fake.revocations.length, 1)
  const stopped = await finished(service)
  assert.notEqual(stopped.state, 'done')
  release()
  const row = (await service.status({ wait: true, refresh: true })).providers.find(item => item.id === 'chatgpt')
  assert.equal(row.authenticated, false)
})

test('no token, code or authorize parameter reaches status, run output, logs or project files', async t => {
  const clock = { now: Date.now() }
  const { fake, service, project } = await setup(t, { clock })
  // Everything the page, the console and the project folder can see during one full session.
  const published = []
  const record = value => { published.push(typeof value === 'string' ? value : JSON.stringify(value)) }
  const methods = ['log', 'info', 'warn', 'error', 'debug']
  const originals = Object.fromEntries(methods.map(name => [name, console[name]]))
  const stderrWrite = process.stderr.write
  for (const name of methods) console[name] = (...args) => { record(args.map(String).join(' ')); return originals[name].apply(console, args) }
  process.stderr.write = function (chunk, ...rest) { record(String(chunk)); return stderrWrite.call(this, chunk, ...rest) }
  const restore = () => { for (const name of methods) console[name] = originals[name]; process.stderr.write = stderrWrite }
  t.after(restore)
  const issued = new Set()
  try {
    record(await service.status({ wait: true }))
    record(await service.chatgptSignIn({}))
    const signed = await waitFor(async () => { const value = (await service.status()).chatgpt; record(value); return ['done', 'failed', 'cancelled', 'expired'].includes(value.attempt.state) && value })
    assert.equal(signed.attempt.state, 'done', signed.attempt.message)
    await waitFor(async () => (await service.status()).provider === 'chatgpt')
    record(await service.status({ wait: true, refresh: true }))
    await approveFixture(service)
    record(await service.sharing())

    // 56 minutes later the hour-long token is near expiry, so the run's token request refreshes it.
    clock.now += 56 * 60 * 1000
    fake.responses.push(() => [{ type: 'response.output_text.delta', delta: 'Hello from ChatGPT.' }, completed()])
    await service.send({ text: 'Say hello' })
    const done = await finished(service)
    record(done)
    assert.equal(done.state, 'done', done.text)
    assert.equal(fake.refreshGrants, 1, 'the run exercised a token refresh')

    fake.responses.push(() => [{ type: 'response.failed', response: { status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Limit' } } }])
    await service.send({ text: 'Say hello again' })
    const limited = await finished(service)
    record(limited)
    assert.equal(limited.errorCode, 'chatgpt_usage_limit')

    // Revocation removes access tokens from the fake, so collect them before signing out.
    for (const key of fake.access.keys()) issued.add(key)
    record(await service.chatgptSignOut({}))
    record(await service.status({ wait: true, refresh: true }))
    record(service.snapshot())
  } finally { restore() }

  const filesUnder = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesUnder(path.join(folder, entry.name)) : [path.join(folder, entry.name)])
  const projectFiles = filesUnder(project)
  assert.ok(projectFiles.length > 0, 'the session wrote project settings to scan')
  for (const file of projectFiles) record(fs.readFileSync(file, 'utf8'))

  const authorize = fake.lastAuthorize
  const secrets = [...issued, ...fake.refresh.keys(), ...fake.codes.keys(), ...fake.registrations.keys(), authorize.state, authorize.nonce, authorize.code_challenge].filter(value => typeof value === 'string' && value.length >= 8)
  assert.ok(issued.size >= 2 && fake.refresh.size >= 2 && fake.codes.size >= 1 && fake.registrations.size >= 1, `the fake issued the tokens and code this test looks for (${issued.size} access, ${fake.refresh.size} refresh, ${fake.codes.size} code, ${fake.registrations.size} client)`)
  for (const [index, text] of published.entries()) {
    assert.equal(secrets.some(secret => text.includes(secret)), false, `Published item ${index} contains a ChatGPT token, code, client ID or authorize parameter.`)
    assert.equal(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(text), false, `Published item ${index} contains an ID token.`)
    assert.equal(/[?&](?:code|state|nonce|code_challenge|id_token_hint|login_hint)=/.test(text), false, `Published item ${index} contains an authorize or callback query.`)
  }
})
