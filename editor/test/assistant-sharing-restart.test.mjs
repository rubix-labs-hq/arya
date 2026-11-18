// The sharing review came back after every server restart. Seen on 2026-11-17: three reviews for
// Claude Code in one project within ten minutes. The saved permission was tied to the bridge's
// random port and random token, so it could never match a new server process. It is now tied to
// the recipients, the project folder, the signed-in provider account and a key kept on this computer.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBrowserAssistant } from '../agent/browser-assistant.mjs'
import { claudeAccountFingerprint, codexAccountFingerprint, createAccountFingerprint } from '../agent/account-fingerprint.mjs'
import { readCodexAccount } from '../agent/catalog-discovery.mjs'
import { normalizeCatalog } from '../core/assistant-routing.mjs'
import { SHARING_CLASSES, sameSharingRecipients, sameSharingScope } from '../core/assistant-sharing.mjs'
import { runningServer } from './fixtures/running-server.mjs'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const accounts = async () => [{ id: 'claude-code', installed: true, authenticated: true }, { id: 'codex', installed: true, authenticated: true }]
const records = [{ id: 'one', description: 'Everyday workhorse', requiresUsageCredits: false }, { id: 'two', description: 'Fast simple work', requiresUsageCredits: false }]
const catalogOptions = () => ({ providerStatus: accounts, executable: async () => '/fixture-only', readCodexCatalog: async () => normalizeCatalog({ provider: 'codex', records, checkedAt: Date.now(), source: { kind: 'provider-cli', label: 'Inert fixture' } }) })
const waitFor = async predicate => { for (let i = 0; i < 300; i++) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)) } assert.fail('Fixture did not reach expected state.') }
const scopeOf = (companion, models = [{ provider: 'claude-code', model: '' }]) => ({ providers: [...new Set(models.map(item => item.provider))], models, companion, classes: [...SHARING_CLASSES] })

/** A project folder, a home folder for the host key and the accounts the CLIs would report. */
function world(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-sharing-restart-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'project'), keyFile = path.join(base, 'home', '.arya', 'assistant-host-key')
  fs.mkdirSync(root)
  const state = { fingerprints: { 'claude-code': A, codex: B }, reads: [], adapters: 0, states: [] }
  const start = (additions = {}) => {
    const service = createBrowserAssistant({ root: additions.root ?? root, providerStatus: accounts, catalogOptions: catalogOptions(), hostKeyFile: keyFile,
      accountFingerprint: async provider => { state.reads.push(provider); const value = state.fingerprints[provider]; if (value instanceof Error) throw value; return typeof value === 'function' ? value() : value },
      getIdentity: () => 1, getOutline: () => ({ version: 1, outline: 'x' }), dispatch: async () => ({}), onState: value => state.states.push(value),
      bridgeOptions: { catalogOptions: catalogOptions(), prepareAdapter: async () => { state.adapters++; return { command: process.execPath, args: ['-e', "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'done',text:'Inert fixture finished.'})))"], cwd: additions.root ?? root, env: {}, prompt: 'Inert fixture prompt', cleanup: async () => {} } } }, ...additions.options })
    t.after(() => service.close())
    return service
  }
  const allow = async service => {
    const review = await service.sharing()
    assert.equal(review.approved, false)
    const granted = await service.grantSharing({ reviewID: review.reviewID, sharing: { version: 1, approved: true, scope: review.scope } })
    assert.equal(granted.approved, true)
    return granted.sharing
  }
  const saved = () => JSON.parse(fs.readFileSync(path.join(root, '.reel', 'assistant-sharing.json'), 'utf8'))
  const finished = async service => { const from = state.states.length; return waitFor(() => state.states.slice(from).find(value => ['done', 'error'].includes(value.state)) ?? (['done', 'error'].includes(service.snapshot().state) && service.snapshot())) }
  return { base, root, keyFile, state, start, allow, saved, finished }
}

test('loopback companions on different ports are the same recipient, and nothing else is loosened', () => {
  const base = scopeOf('http://127.0.0.1:5001/')
  assert.ok(sameSharingRecipients(base, scopeOf('http://127.0.0.1:6002/')))
  assert.ok(sameSharingRecipients(base, scopeOf('http://localhost:7003/')))
  assert.ok(sameSharingRecipients(scopeOf('http://[::1]:5001/'), scopeOf('http://127.0.0.1:6002/')))
  assert.equal(sameSharingScope(base, scopeOf('http://127.0.0.1:6002/')), false, 'the exact comparison still sees the port')
  assert.ok(sameSharingRecipients(scopeOf('https://companion.example/'), scopeOf('https://companion.example/')))
  for (const other of [scopeOf('https://companion.example/'), scopeOf('https://127.0.0.1:5001/'), scopeOf('http://127.0.0.1:5001/', [{ provider: 'codex', model: '' }]), scopeOf('http://127.0.0.1:5001/', [{ provider: 'claude-code', model: 'other' }]),
    scopeOf('http://127.0.0.1:5001/', [{ provider: 'claude-code', model: '' }, { provider: 'codex', model: '' }]), { ...base, classes: base.classes.slice(1) }, { ...base, companion: 'http://remote.example:5001/' }, null]) assert.equal(sameSharingRecipients(base, other), false, JSON.stringify(other))
  assert.equal(sameSharingRecipients(scopeOf('https://companion.example/'), scopeOf('https://companion.example:8443/')), false, 'an HTTPS companion is compared exactly')
  assert.equal(sameSharingRecipients(scopeOf('https://localhost:1/'), scopeOf('https://localhost:2/')), false)
})

test('a restart with the same account, recipients and project keeps the permission', async t => {
  const w = world(t)
  const first = w.start(), granted = await w.allow(first)
  // What is stored: the envelope, one digest and its kind. No account, token or key.
  const file = w.saved()
  assert.deepEqual(Object.keys(file).sort(), ['binding', 'credentialDigest', 'sharing']); assert.equal(file.binding, 2); assert.match(file.credentialDigest, /^[a-f0-9]{64}$/)
  const key = fs.readFileSync(w.keyFile, 'utf8').trim()
  assert.match(key, /^[a-f0-9]{64}$/); assert.equal(fs.statSync(w.keyFile).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(w.keyFile)).mode & 0o077, 0)
  assert.equal(JSON.stringify(file).includes(A), false); assert.equal(JSON.stringify(file).includes(key), false)
  await first.close()

  const next = w.start()
  const review = await next.sharing()
  assert.equal(review.approved, true); assert.equal(review.required, false)
  assert.notEqual(review.scope.companion, granted.scope.companion, 'the new server listens on another port')
  assert.equal(review.sharing.scope.companion, review.scope.companion, 'the page gets an envelope for the current companion')
  assert.equal(fs.readFileSync(w.keyFile, 'utf8').trim(), key, 'the key is not replaced')
  // The real bridge accepts the envelope the host rebuilt, and the run finishes.
  await next.send({ text: 'Draft', sharing: review.sharing })
  assert.equal((await w.finished(next)).state, 'done'); assert.equal(w.state.adapters, 1)
  await next.close()

  // A page left open across the restart still holds the envelope with the old port.
  const third = w.start()
  await third.send({ text: 'Draft again', sharing: granted })
  assert.equal((await w.finished(third)).state, 'done'); assert.equal(w.state.adapters, 2)
  assert.equal((await third.sharing()).approved, true)
})

test('a different provider, model or account after the restart asks again', async t => {
  const codexOne = async service => { await service.configure({ provider: 'codex', model: 'one' }) }
  for (const [name, setup, change] of [
    ['provider', null, async (w, next) => { await next.configure({ provider: 'codex' }) }],
    ['model', codexOne, async (w, next) => { await next.configure({ provider: 'codex', model: 'two' }) }],
    ['account', null, async w => { w.state.fingerprints['claude-code'] = C }],
    ['Codex account', codexOne, async w => { w.state.fingerprints.codex = C }],
  ]) {
    const w = world(t), first = w.start()
    if (setup) await setup(first)
    const granted = await w.allow(first)
    assert.equal(w.saved().binding, 2, name)
    await first.close()
    const next = w.start()
    await change(w, next)
    const review = await next.sharing()
    assert.equal(review.approved, false, name); assert.equal(review.sharing, null, name)
    await assert.rejects(next.send({ text: 'Draft', sharing: granted }), /permission.*required/, name)
    await assert.rejects(next.send({ text: 'Draft', sharing: { version: 1, approved: true, scope: review.scope } }), /permission.*required/, `${name}: an envelope the page builds itself is not a grant`)
    assert.equal(w.state.adapters, 0, name)
  }
})

test('an account that cannot be read is never accepted, at the grant or after the restart', async t => {
  // Unreadable when the permission is given: it is stored as before and lasts for this server only.
  for (const unreadable of [null, undefined, '', 'not-a-digest', A.slice(1), new Error('The CLI did not answer.')]) {
    const w = world(t)
    w.state.fingerprints['claude-code'] = unreadable
    const first = w.start(), granted = await w.allow(first)
    assert.equal(Object.hasOwn(w.saved(), 'binding'), false); assert.equal(fs.existsSync(w.keyFile), false, 'no key is made for a permission that cannot outlast the server')
    assert.equal((await first.sharing()).approved, true, 'it still holds in this server, as before')
    await first.close()
    w.state.fingerprints['claude-code'] = A
    const next = w.start()
    assert.equal((await next.sharing()).approved, false)
    await assert.rejects(next.send({ text: 'Draft', sharing: granted }), /permission.*required/)
  }
  // Readable at the grant, unreadable after the restart.
  for (const unreadable of [null, 'not-a-digest', new Error('The CLI did not answer.')]) {
    const w = world(t), first = w.start(), granted = await w.allow(first)
    await first.close()
    w.state.fingerprints['claude-code'] = unreadable
    const next = w.start()
    assert.equal((await next.sharing()).approved, false)
    await assert.rejects(next.send({ text: 'Draft', sharing: granted }), /permission.*required/)
    // Signed in again as the same account: the same saved permission is accepted.
    w.state.fingerprints['claude-code'] = A
    const later = w.start()
    assert.equal((await later.sharing()).approved, true)
  }
})

test('a changed, missing or exposed host key asks again, and only a grant creates one', async t => {
  for (const [name, damage] of [
    ['changed', w => fs.writeFileSync(w.keyFile, `${'9'.repeat(64)}\n`, { mode: 0o600 })],
    ['missing', w => fs.rmSync(w.keyFile)],
    ['readable by others', w => fs.chmodSync(w.keyFile, 0o644)],
    ['not a key', w => fs.writeFileSync(w.keyFile, 'short\n', { mode: 0o600 })],
    ['a link', w => { const target = path.join(w.base, 'elsewhere'); fs.renameSync(w.keyFile, target); fs.symlinkSync(target, w.keyFile) }],
  ]) {
    const w = world(t), first = w.start(), granted = await w.allow(first)
    await first.close()
    damage(w)
    const before = fs.existsSync(w.keyFile) ? fs.lstatSync(w.keyFile).mode : null
    const next = w.start()
    assert.equal((await next.sharing()).approved, false, name)
    await assert.rejects(next.send({ text: 'Draft', sharing: granted }), /permission.*required/, name)
    assert.equal(fs.existsSync(w.keyFile) ? fs.lstatSync(w.keyFile).mode : null, before, `${name}: a review or a send never writes the key`)
  }
})

test('a saved permission copied to another project folder, or edited on disk, asks again', async t => {
  const w = world(t), first = w.start(), granted = await w.allow(first)
  await first.close()
  const copy = path.join(w.base, 'copy'); fs.mkdirSync(path.join(copy, '.reel'), { recursive: true })
  fs.copyFileSync(path.join(w.root, '.reel', 'assistant-sharing.json'), path.join(copy, '.reel', 'assistant-sharing.json'))
  const elsewhere = w.start({ root: copy })
  assert.equal((await elsewhere.sharing()).approved, false)
  await assert.rejects(elsewhere.send({ text: 'Draft', sharing: granted }), /permission.*required/)
  await elsewhere.close()
  // The stored scope is rewritten to name Codex, and the editor is set to Codex. The digest was made for Claude Code.
  const file = path.join(w.root, '.reel', 'assistant-sharing.json'), stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const edit of [
    value => { value.sharing.scope = scopeOf(value.sharing.scope.companion, [{ provider: 'codex', model: 'one' }]) },
    value => { value.sharing.scope = scopeOf('https://companion.example/') },
    value => { value.binding = 3 },
    value => { delete value.binding },
    value => { value.credentialDigest = A },
  ]) {
    const value = structuredClone(stored); edit(value); fs.writeFileSync(file, JSON.stringify(value))
    const next = w.start()
    await next.configure({ provider: 'codex', model: 'one' })
    assert.equal((await next.sharing()).approved, false)
    await next.configure({ provider: 'claude-code' })
    assert.equal((await next.sharing()).approved, false)
    await next.close()
  }
  fs.writeFileSync(file, JSON.stringify(stored))
  assert.equal((await w.start().sharing()).approved, true, 'the untouched file is still accepted')
})

test('an account that changes between the review and Allow is refused', async t => {
  const w = world(t), service = w.start({ options: { accountCacheMs: 0 } })
  const review = await service.sharing()
  w.state.fingerprints['claude-code'] = C
  await assert.rejects(service.grantSharing({ reviewID: review.reviewID, sharing: { version: 1, approved: true, scope: review.scope } }), /changed during review/)
  assert.equal(fs.existsSync(path.join(w.root, '.reel', 'assistant-sharing.json')), false); assert.equal(fs.existsSync(w.keyFile), false)
})

test('withdrawing while the account is being read does not bring the permission back', async t => {
  const w = world(t), first = w.start(), granted = await w.allow(first)
  await first.close()
  let release
  const held = new Promise(resolve => { release = resolve })
  w.state.fingerprints['claude-code'] = () => held.then(() => A)
  const next = w.start()
  const reviewing = next.sharing(), sending = next.send({ text: 'Draft', sharing: granted })
  reviewing.catch(() => {}); sending.catch(() => {})
  await waitFor(() => w.state.reads.length >= 2)
  const revoked = await next.revokeSharing()
  assert.equal(revoked.revoked, true)
  release()
  await assert.rejects(sending, /no longer active|permission/)
  await assert.rejects(reviewing, /changed during sharing review/)
  assert.equal((await next.sharing()).approved, false, 'the withdrawn permission stays withdrawn')
  assert.equal(fs.existsSync(path.join(w.root, '.reel', 'assistant-sharing.json')), false); assert.equal(w.state.adapters, 0)
})

test('signing in from Arya clears the permission and the remembered account', async t => {
  const w = world(t), service = w.start({ options: { launchLogin: async () => {}, executable: async () => process.execPath } })
  await w.allow(service)
  const reads = w.state.reads.length
  await service.login({ provider: 'claude-code' })
  w.state.fingerprints['claude-code'] = C
  const review = await service.sharing()
  assert.equal(review.approved, false)
  assert.ok(w.state.reads.length > reads, 'the account is read again after a sign-in')
})

test('account fingerprints need real identifiers and never contain them', async t => {
  const claude = { loggedIn: true, authMethod: 'claude.ai', email: 'Person@Example.test', orgId: 'org-1' }
  const one = claudeAccountFingerprint(claude)
  assert.match(one, /^[a-f0-9]{64}$/)
  assert.equal(claudeAccountFingerprint({ ...claude, email: ' person@example.test ' }), one, 'letter case and spaces around an address do not make a new account')
  assert.notEqual(claudeAccountFingerprint({ ...claude, email: 'other@example.test' }), one); assert.notEqual(claudeAccountFingerprint({ ...claude, orgId: 'org-2' }), one)
  assert.match(claudeAccountFingerprint({ loggedIn: true, email: 'person@example.test' }), /^[a-f0-9]{64}$/)
  for (const value of [null, {}, { loggedIn: true }, { loggedIn: true, email: '' }, { loggedIn: true, email: '   ' }, { loggedIn: false, email: 'person@example.test' }, { loggedIn: true, email: 7 }, { loggedIn: true, email: 'person@example.test', orgId: 7 }, { loggedIn: true, email: 'x'.repeat(400) }]) assert.equal(claudeAccountFingerprint(value), null, JSON.stringify(value))
  const codex = { account: { type: 'chatgpt', email: 'person@example.test', planType: 'plus' }, userId: 'user-1', workspaceRouting: { chatgptAccountId: 'acct-1' } }
  const two = codexAccountFingerprint(codex)
  assert.match(two, /^[a-f0-9]{64}$/); assert.notEqual(two, one)
  assert.notEqual(codexAccountFingerprint({ ...codex, userId: 'user-2' }), two); assert.notEqual(codexAccountFingerprint({ ...codex, workspaceRouting: { chatgptAccountId: 'acct-2' } }), two)
  assert.equal(codexAccountFingerprint({ ...codex, account: { ...codex.account, email: 'renamed@example.test' } }), two, 'the user and workspace IDs identify the account')
  for (const value of [null, {}, { ...codex, userId: '' }, { ...codex, userId: undefined }, { ...codex, account: null }, { ...codex, account: { type: 'apiKey' } }, { ...codex, workspaceRouting: { chatgptAccountId: 7 } }]) assert.equal(codexAccountFingerprint(value), null, JSON.stringify(value))

  // The reader runs the installed CLIs with the subscription environment and swallows every failure.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-fingerprint-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fake = path.join(dir, 'claude')
  // Like Claude Code 2.1, it names the account only when it is not run from inside a Claude Code session.
  fs.writeFileSync(fake, `#!${process.execPath}\nconst inside = process.env.CLAUDECODE || process.env.ANTHROPIC_API_KEY;\nconsole.log(JSON.stringify(inside ? { loggedIn: true, authMethod: 'claude.ai' } : { loggedIn: true, authMethod: 'claude.ai', email: 'person@example.test', orgId: 'org-1' }))\n`, { mode: 0o700 })
  const calls = []
  const read = createAccountFingerprint({ executable: async name => name === 'claude' ? fake : name === 'codex' ? '/fixture/codex' : null, environment: () => ({ ...process.env, CLAUDECODE: undefined, ANTHROPIC_API_KEY: undefined }),
    readAccount: async options => { calls.push(options); return codex } })
  assert.equal(await read('claude-code'), one); assert.equal(await read('codex'), two)
  assert.equal(calls[0].executable, '/fixture/codex'); assert.ok(calls[0].env)
  assert.equal(await read('antigravity'), null); assert.equal(await read('anthropic'), null); assert.equal(await read('chatgpt'), null)
  const inside = createAccountFingerprint({ executable: async () => fake, environment: () => ({ ...process.env, CLAUDECODE: '1' }), readAccount: async () => { throw new Error('closed') } })
  assert.equal(await inside('claude-code'), null, 'no address reported, no fingerprint'); assert.equal(await inside('codex'), null)
  assert.equal(await createAccountFingerprint({ executable: async () => null })('claude-code'), null)
  assert.equal(await createAccountFingerprint({ executable: async () => path.join(dir, 'missing') })('claude-code'), null)
})

test('the Codex account is read with a client that can only initialize and read the account', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-codex-account-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const audit = path.join(dir, 'audit.jsonl'), fake = path.join(dir, 'codex')
  fs.writeFileSync(fake, `#!${process.execPath}\nconst fs = require('node:fs'), readline = require('node:readline')\nfs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n')\nreadline.createInterface({ input: process.stdin }).on('line', line => { const input = JSON.parse(line); fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify(input) + '\\n'); if (input.method === 'initialized') return; const result = input.method === 'account/read' ? (process.env.FIXTURE_SIGNED_OUT ? { account: null, requiresOpenaiAuth: true } : { account: { type: 'chatgpt', email: 'person@example.test' }, userId: 'user-1', workspaceRouting: { chatgptAccountId: 'acct-1' } }) : {}; process.stdout.write(JSON.stringify({ id: input.id, result }) + '\\n') })\n`, { mode: 0o700 })
  const result = await readCodexAccount({ executable: fake, env: { ...process.env } })
  assert.equal(result.userId, 'user-1')
  const lines = fs.readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines[0], { argv: ['app-server', '--stdio'] })
  assert.deepEqual(lines.slice(1).map(line => line.method), ['initialize', 'initialized', 'account/read'], 'no thread, turn, login or model method is sent')
  assert.deepEqual(lines[3].params, { refreshToken: false })
  assert.equal(codexAccountFingerprint(await readCodexAccount({ executable: fake, env: { ...process.env, FIXTURE_SIGNED_OUT: '1' } })), null)
  await assert.rejects(readCodexAccount({ executable: path.join(dir, 'missing'), env: { ...process.env }, timeoutMs: 2000 }))
  await assert.rejects(readCodexAccount({ executable: fake }), /installed CLI/)
})

test('the server reads the account from the installed CLI and keeps its key under the home folder', async t => {
  // A CLI that names its account, and a home folder of the test's own.
  const named = await runningServer(t, [], { env: root => {
    fs.mkdirSync(path.join(root, 'home'))
    fs.writeFileSync(path.join(root, 'bin', 'claude'), `#!${process.execPath}\nif(process.argv[2]==='auth'&&process.argv[3]==='status')console.log(JSON.stringify({loggedIn:true,authMethod:'oauth',apiProvider:'anthropic',email:'person@example.test',orgId:'org-1'}));else import(${JSON.stringify(path.join(root, 'agent.mjs'))});\n`, { mode: 0o700 })
    return { HOME: path.join(root, 'home') }
  } })
  await named.ask('Say hello.')
  const saved = JSON.parse(fs.readFileSync(path.join(named.root, '.reel', 'assistant-sharing.json'), 'utf8'))
  assert.equal(saved.binding, 2)
  const key = path.join(named.root, 'home', '.arya', 'assistant-host-key')
  assert.match(fs.readFileSync(key, 'utf8').trim(), /^[a-f0-9]{64}$/); assert.equal(fs.statSync(key).mode & 0o777, 0o600)
  assert.equal(/person@example\.test|org-1/.test(JSON.stringify(saved) + named.output()), false, 'the account is neither stored nor logged')
  // A CLI that does not name its account, which is every other server fixture: stored as before, and no key.
  const unnamed = await runningServer(t, [], { env: root => { fs.mkdirSync(path.join(root, 'home')); return { HOME: path.join(root, 'home') } } })
  await unnamed.ask('Say hello.')
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(unnamed.root, '.reel', 'assistant-sharing.json'), 'utf8')), 'binding'), false)
  assert.equal(fs.existsSync(path.join(unnamed.root, 'home', '.arya')), false)
})
