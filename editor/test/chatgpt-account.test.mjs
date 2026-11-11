import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChatGPTAccount } from '../agent/chatgpt-account.mjs'
import { startChatGPTFake, DOC_MODEL } from './fixtures/chatgpt-fake.mjs'

async function setup(t, { clock, account: accountOptions = {} } = {}) {
  const fake = await startChatGPTFake(clock ? { now: () => clock.now } : {})
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-chatgpt-test-'))
  const directory = path.join(root, 'chatgpt')
  const opened = []
  const instances = []
  const make = (more = {}) => {
    const instance = createChatGPTAccount({ directory, endpoints: fake.endpoints, retryDelays: [1, 1, 1], ...(clock ? { now: () => clock.now } : {}),
      openURL: async url => { opened.push(url); await fake.browser(url); return true }, ...accountOptions, ...more })
    instances.push(instance)
    return instance
  }
  const account = make()
  t.after(async () => { for (const item of instances) item.close(); await fake.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { fake, account, make, directory, opened }
}
async function settle(account) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const current = account.status()
    if (['done', 'failed', 'cancelled', 'expired'].includes(current.attempt.state)) return current
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`sign-in did not settle: ${JSON.stringify(account.status().attempt)}`)
}
const signIn = async (account, options) => { await account.signIn(options); return settle(account) }
const secrets = fake => [...fake.access.keys(), ...fake.refresh.keys()]
const tokenRequests = fake => fake.requests.filter(item => item.path === '/token')
const refused = url => fetch(url).then(() => false, () => true)

test('first sign-in registers Arya with the documented parameters and keeps tokens owner-only', async t => {
  const { fake, account, directory, opened } = await setup(t)
  const status = await signIn(account)
  assert.equal(status.attempt.state, 'done', status.attempt.message)
  assert.deepEqual(fake.violations, [])
  const authorize = fake.lastAuthorize
  assert.equal(authorize.client_id, 'dynamic_agent_client')
  assert.equal(authorize.agent_name_hint, 'Arya')
  assert.equal(authorize.id_token_hint, undefined)
  assert.match(authorize.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
  assert.deepEqual(tokenRequests(fake).map(item => item.keys), [['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri', 'resource']])
  assert.equal(status.signedIn, true)
  assert.equal(status.planUsage, true)
  assert.equal(status.email, 'alex@example.com')
  assert.equal(status.welcome, true)
  assert.match(status.active, /^[A-Za-z0-9_-]{16}$/)
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(directory, 'accounts.json')).mode & 0o777, 0o600)
  assert.match(JSON.parse(fs.readFileSync(path.join(directory, 'host.json'), 'utf8')).ext_agent_host_id, /^urn:uuid:/)
  const published = JSON.stringify(status)
  for (const secret of secrets(fake)) assert.equal(published.includes(secret), false)
  assert.equal(published.includes('oaiapp_'), false)
  assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+\/auth\/start\?attempt=[A-Za-z0-9_-]+$/)
  assert.match(fake.lastPage.headers['content-security-policy'], /default-src 'none'/)
  assert.match(fake.lastPage.text, /Return to Arya/)
  assert.equal(await refused(opened[0]), true, 'the loopback listener stops after one callback')
  assert.equal((await account.acknowledgeWelcome()).welcome, false)
  assert.equal(account.status().welcome, false)
})

test('a returning sign-in reuses the issued client and host ID, with hints only in the OpenAI redirect', async t => {
  const { fake, account, make, opened } = await setup(t)
  await signIn(account)
  const host = fake.lastAuthorize.ext_agent_host_id
  const [issued] = fake.registrations.keys()
  const status = await signIn(make())
  assert.equal(status.attempt.state, 'done', status.attempt.message)
  assert.deepEqual(fake.violations, [])
  assert.equal(fake.lastAuthorize.client_id, issued)
  assert.equal(fake.lastAuthorize.agent_name_hint, undefined)
  assert.equal(fake.lastAuthorize.ext_agent_host_id, host)
  assert.equal(fake.lastAuthorize.login_hint, 'alex@example.com')
  assert.ok(fake.lastAuthorize.id_token_hint?.split('.').length === 3)
  assert.equal(opened[1].includes('id_token_hint'), false)
  assert.equal(JSON.stringify(status).includes(fake.lastAuthorize.id_token_hint), false)
  assert.equal(fake.registrations.size, 1)
})

test('declining consent stops without a code exchange and leaves manual editing available', async t => {
  const { fake, account, directory } = await setup(t)
  fake.consent.push({ deny: true })
  const status = await signIn(account)
  assert.equal(status.attempt.state, 'cancelled')
  assert.match(status.attempt.message, /Manual editing still works/)
  assert.equal(status.signedIn, false)
  assert.equal(tokenRequests(fake).length, 0)
  assert.equal(fs.existsSync(path.join(directory, 'accounts.json')), false)
  assert.deepEqual(fake.violations, [])
})

test('a callback with another state is refused, and Cancel closes the listener', async t => {
  const { fake, account, opened } = await setup(t)
  fake.consent.push({ state: 'forged-state' })
  await account.signIn()
  assert.equal(fake.lastPage.status, 400)
  assert.equal(account.status().attempt.state, 'waiting')
  assert.match(account.status().attempt.startURL, /\/auth\/start\?attempt=/)
  assert.deepEqual(account.cancelSignIn(), { cancelled: true })
  assert.equal(account.status().attempt.state, 'cancelled')
  assert.equal(account.status().attempt.startURL, null)
  assert.equal(await refused(opened[0]), true)
  assert.equal(tokenRequests(fake).length, 0)
  assert.deepEqual(account.cancelSignIn(), { cancelled: false })
})

test('an unanswered sign-in expires and stops listening', async t => {
  const { fake, account, opened } = await setup(t, { account: { attemptTimeout: 40 } })
  fake.consent.push({ hold: true })
  const status = await signIn(account)
  assert.equal(status.attempt.state, 'expired')
  assert.match(status.attempt.message, /timed out/)
  assert.equal(await refused(opened[0]), true)
})

test('a same-length Unicode callback state is refused without crashing the editor', async t => {
  const { account } = await setup(t, { account: { openURL: async () => true } })
  const { startURL } = await account.signIn()
  const callback = new URL('/auth/callback', startURL)
  callback.searchParams.set('state', 'é'.repeat(43))
  callback.searchParams.set('code', 'not-an-authorization-code')
  const response = await fetch(callback)
  assert.equal(response.status, 400)
  assert.equal(account.status().attempt.state, 'waiting')
  assert.equal(account.status().signedIn, false)
})

test('cancelling while waiting for the credential lock never saves the new session', async t => {
  const { fake, account, directory } = await setup(t, { account: { openURL: async () => true } })
  const { startURL } = await account.signIn()
  const lock = path.join(directory, 'refresh.lock')
  fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  let contended = false
  const writeFile = fs.writeFileSync
  t.mock.method(fs, 'writeFileSync', function (file, ...args) {
    try { return writeFile.call(this, file, ...args) }
    catch (error) { if (file === lock && error.code === 'EEXIST') contended = true; throw error }
  })
  await fake.browser(startURL)
  assert.equal(account.status().attempt.state, 'exchanging')
  const deadline = Date.now() + 5000
  while (!contended && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(contended, true, 'the exchange reached the held credential lock')
  assert.ok(fake.access.size > 0, 'OpenAI issued credentials before cancellation')
  account.cancelSignIn()
  fs.unlinkSync(lock)
  while (!account.status().signedIn && fake.revocations.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(account.status().attempt.state, 'cancelled')
  assert.equal(account.status().signedIn, false)
  assert.equal(fake.revocations.length, 1, 'cancelled credentials were revoked')
  assert.equal(fs.existsSync(path.join(directory, 'accounts.json')), false)
})

test('a new registration without an issued client ID is incomplete', async t => {
  const { fake, account } = await setup(t)
  fake.consent.push({ callbackClient: '' })
  const status = await signIn(account)
  assert.equal(status.attempt.state, 'failed')
  assert.match(status.attempt.message, /did not finish registering/)
  assert.equal(tokenRequests(fake).length, 0)
  assert.equal(status.signedIn, false)
})

test('a reauthorization that returns another client ID is rejected', async t => {
  const { fake, account } = await setup(t)
  await signIn(account)
  fake.consent.push({ callbackClient: 'oaiapp_someone_else' })
  const status = await signIn(account)
  assert.equal(status.attempt.state, 'failed')
  assert.match(status.attempt.message, /different app registration/)
  assert.equal(tokenRequests(fake).length, 1)
  assert.equal(status.signedIn, true)
})

test('ID tokens with a bad signature, nonce, audience, issuer or expiry are rejected', async t => {
  const { fake, account } = await setup(t)
  const cases = [[{ badSignature: true }, /signature is invalid/], [{ nonce: 'other-nonce' }, /did not match this attempt/], [{ audience: 'oaiapp_other' }, /not issued to Arya/], [{ issuer: 'https://auth.example.com' }, /not issued to Arya/], [{ expired: true }, /expired/]]
  for (const [consent, message] of cases) {
    fake.consent.push(consent)
    const status = await signIn(account)
    assert.equal(status.attempt.state, 'failed', JSON.stringify(consent))
    assert.match(status.attempt.message, message)
    assert.equal(status.signedIn, false)
  }
  assert.deepEqual(fake.violations, [])
})

test('a returning sign-in that comes back as another account keeps the saved connection', async t => {
  const { fake, account } = await setup(t)
  await signIn(account)
  fake.consent.push({ subject: 'sub-someone-else' })
  const status = await signIn(account)
  assert.equal(status.attempt.state, 'failed')
  assert.match(status.attempt.message, /different account/)
  assert.equal(status.signedIn, true)
  assert.equal(status.email, 'alex@example.com')
})

test('a rotated signing key is fetched from the JWKS', async t => {
  const { fake, account } = await setup(t)
  await signIn(account)
  fake.consent.push({ rotateKeyBeforeToken: true })
  const status = await signIn(account)
  assert.equal(status.attempt.state, 'done', status.attempt.message)
})

test('declined plan usage keeps the sign-in, and turning it on repeats OAuth with prompt=consent', async t => {
  const { fake, account } = await setup(t)
  fake.consent.push({ grantPlan: false })
  let status = await signIn(account)
  assert.equal(status.attempt.state, 'done')
  assert.match(status.attempt.message, /plan usage was not allowed/)
  assert.equal(status.signedIn, true)
  assert.equal(status.planUsage, false)
  assert.equal(status.welcome, false)
  await assert.rejects(account.models(), error => error.code === 'chatgpt_plan_disabled')
  const [issued] = fake.registrations.keys()
  status = await signIn(account, { enablePlan: true })
  assert.equal(fake.lastAuthorize.prompt, 'consent')
  assert.equal(fake.lastAuthorize.client_id, issued)
  assert.equal(status.planUsage, true)
  assert.equal(status.welcome, true)
  assert.deepEqual(fake.violations, [])
})

test('models keep the listed entries in the server order and send slugs', async t => {
  const { account } = await setup(t)
  await signIn(account)
  assert.deepEqual(await account.models(), [{ slug: DOC_MODEL, display_name: 'GPT-6.1 Sol' }, { slug: 'gpt-6.1-sol-mini', display_name: 'GPT-6.1 Sol mini' }])
})

test('tokens refresh near expiry once across two editor processes, and rotation is saved', async t => {
  const clock = { now: Date.now() }
  const { fake, account, make } = await setup(t, { clock })
  await signIn(account)
  const first = await account.accessToken()
  const approvedIdentity = account.sharingIdentity()
  assert.equal(fake.refreshGrants, 0)
  clock.now += 56 * 60 * 1000
  const other = make()
  const [a, b] = await Promise.all([account.accessToken(), other.accessToken()])
  assert.equal(fake.refreshGrants, 1)
  assert.equal(a.accessToken, b.accessToken)
  assert.notEqual(a.accessToken, first.accessToken)
  assert.equal(a.identity, approvedIdentity)
  assert.equal(b.identity, approvedIdentity)
  assert.equal(other.sharingIdentity(), approvedIdentity)
  assert.deepEqual(tokenRequests(fake).at(-1).keys, ['client_id', 'grant_type', 'refresh_token', 'resource'])
  clock.now += 56 * 60 * 1000
  await account.accessToken()
  assert.equal(fake.refreshGrants, 2, 'the rotated refresh token was saved and accepted')
  assert.deepEqual(fake.violations, [])
})

test('an unusable refresh token ends the session but keeps the registration and hint', async t => {
  const clock = { now: Date.now() }
  const { fake, account } = await setup(t, { clock })
  await signIn(account)
  const [issued] = fake.registrations.keys()
  clock.now += 56 * 60 * 1000
  fake.refreshFailures.push({ status: 400, body: { error: 'refresh_token_expired' } })
  await assert.rejects(account.accessToken(), error => error.code === 'chatgpt_sign_in_required' && /sign in again/i.test(error.message))
  const status = account.status()
  assert.equal(status.signedIn, false)
  assert.equal(status.accounts.length, 1)
  await signIn(account)
  assert.equal(fake.lastAuthorize.client_id, issued)
  assert.ok(fake.lastAuthorize.id_token_hint)
  assert.equal(account.status().signedIn, true)
})

test('temporary refresh failures keep the credentials', async t => {
  const clock = { now: Date.now() }
  const { fake, account } = await setup(t, { clock })
  await signIn(account)
  const before = await account.accessToken()
  clock.now += 56 * 60 * 1000
  fake.refreshFailures.push({ status: 503, body: { error: 'temporarily_unavailable' } })
  assert.equal((await account.accessToken()).accessToken, before.accessToken, 'a still-valid token is used while OpenAI is unavailable')
  clock.now += 3.5 * 60 * 1000
  fake.refreshFailures.push({ status: 503, body: { error: 'temporarily_unavailable' } })
  await assert.rejects(account.accessToken(), error => error.code === 'chatgpt_refresh_unavailable')
  assert.equal(account.status().signedIn, true)
  assert.notEqual((await account.accessToken()).accessToken, before.accessToken)
})

test('invalid_client starts a new registration on the next sign-in', async t => {
  const clock = { now: Date.now() }
  const { fake, account } = await setup(t, { clock })
  await signIn(account)
  clock.now += 56 * 60 * 1000
  fake.refreshFailures.push({ status: 401, body: { error: 'invalid_client' } })
  await assert.rejects(account.accessToken(), error => error.code === 'chatgpt_sign_in_required' && /register Arya again/.test(error.message))
  const status = await signIn(account)
  assert.equal(fake.lastAuthorize.client_id, 'dynamic_agent_client')
  assert.equal(status.signedIn, true)
  assert.equal(status.accounts.length, 1)
})

test('sign-out revokes with retries, clears tokens and keeps the registration and host', async t => {
  const { fake, account, directory } = await setup(t)
  await signIn(account)
  const [issued] = fake.registrations.keys()
  fake.revokeFailures = 2
  assert.deepEqual(await account.signOut(), { signedOut: true, revocationConfirmed: true, email: 'alex@example.com' })
  assert.deepEqual(fake.revocations, [issued])
  const saved = fs.readFileSync(path.join(directory, 'accounts.json'), 'utf8')
  for (const key of ['access_token', 'refresh_token', 'id_token']) assert.equal(saved.includes(key), false)
  assert.equal(account.status().signedIn, false)
  assert.ok(fs.existsSync(path.join(directory, 'host.json')))
  await assert.rejects(account.accessToken(), error => error.code === 'chatgpt_sign_in_required')
  await signIn(account)
  assert.equal(fake.lastAuthorize.client_id, issued)
  assert.equal(fake.lastAuthorize.id_token_hint, undefined, 'no ID token hint after sign-out')
  assert.equal(fake.lastAuthorize.login_hint, 'alex@example.com')
  fake.revokeFailures = 10
  const result = await account.signOut()
  assert.equal(result.signedOut, true)
  assert.equal(result.revocationConfirmed, false)
  assert.equal(account.status().signedIn, false)
  assert.deepEqual(await account.signOut(), { signedOut: false, revocationConfirmed: true, email: '' })
  assert.deepEqual(fake.violations, [])
})

test('another account can be added, chosen and signed out separately', async t => {
  const { fake, account } = await setup(t)
  await signIn(account)
  const alex = account.status().active
  fake.consent.push({ subject: 'sub-sam', email: 'sam@example.com' })
  let status = await signIn(account, { newAccount: true })
  assert.equal(fake.lastAuthorize.client_id, 'dynamic_agent_client')
  assert.equal(status.email, 'sam@example.com')
  assert.equal(status.accounts.length, 2)
  assert.equal(status.accounts.find(item => item.id === alex).signedIn, true)
  assert.equal((await account.signOut({ account: alex })).email, 'alex@example.com')
  status = account.status()
  assert.equal(status.email, 'sam@example.com')
  assert.equal(status.signedIn, true)
  status = await signIn(account, { account: alex })
  assert.equal(status.email, 'alex@example.com')
  assert.equal(fake.registrations.size, 2)
  await assert.rejects(account.signIn({ account: 'missing' }), /no longer saved/)
})

test('an unreadable saved connection is reported and replaced by the next sign-in', async t => {
  const { account, directory } = await setup(t)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(directory, 'accounts.json'), '{not json', { mode: 0o600 })
  assert.match(account.status().error, /unreadable/)
  await assert.rejects(account.accessToken(), /unreadable/)
  const status = await signIn(account)
  assert.equal(status.signedIn, true)
  assert.equal(status.error, undefined)
})
