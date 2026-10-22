import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridge } from '../agent/bridge.mjs'
import { prepareAdapter, providerStatus, outputEvent } from '../agent/adapters.mjs'
import { GEMINI_POLICY, GEMINI_QUOTA_MESSAGE, GEMINI_SIGN_IN_MESSAGE, geminiCatalogRecords, geminiEnvironment, geminiExitMessage, geminiSignedIn } from '../agent/gemini.mjs'
import { createAssistantCatalog } from '../agent/assistant-catalog.mjs'
import { fixtureBridgeOptions, fixtureSharing } from './fixtures/sharing-fixture.mjs'
import { newProject } from '../core/project.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const fake = path.join(dir, 'fixtures/gemini-cli.mjs')
const transport = { endpoint: 'http://127.0.0.1:12345/', token: 'a'.repeat(64) }

// A fake `gemini` on PATH and a temporary HOME, so no real CLI or sign-in is touched.
async function fakeGemini(t, env = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arya-gemini-test-'))
  const bin = path.join(root, 'bin'), home = path.join(root, 'home')
  await fs.mkdir(bin); await fs.mkdir(home)
  await fs.writeFile(path.join(bin, 'gemini'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 })
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, ...Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])) }
  process.env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`; process.env.HOME = home
  Object.assign(process.env, env)
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await fs.rm(root, { recursive: true, force: true })
  })
  return { root, bin, home }
}

test('Gemini adapter writes private settings, an admin policy and a Google sign-in environment', async t => {
  const { bin } = await fakeGemini(t)
  const adapter = await prepareAdapter({ id: randomUUID(), provider: 'gemini-cli', text: 'Edit', model: 'gemini-3-pro-preview' }, transport)
  let cwd
  try {
    cwd = adapter.cwd
    assert.equal(adapter.command, path.join(bin, 'gemini'))
    const policy = path.join(cwd, 'arya-policy.toml')
    assert.deepEqual(adapter.args, ['-p', 'Complete the request above with the reel tools.', '-o', 'stream-json', '--skip-trust', '--approval-mode', 'default',
      '--admin-policy', policy, '--allowed-mcp-server-names', 'reel', '-e', 'none', '-m', 'gemini-3-pro-preview'])
    assert.ok(!adapter.args.join(' ').includes(transport.token), 'The run token is never on the command line')
    assert.equal(await fs.readFile(policy, 'utf8'), GEMINI_POLICY)
    assert.match(GEMINI_POLICY, /toolName = "\*"\ndecision = "deny"\npriority = 100/)
    assert.match(GEMINI_POLICY, /mcpName = "reel"\ntoolName = \["reel_api", "reel_frame"\]\ndecision = "allow"\npriority = 900/)
    const settings = JSON.parse(await fs.readFile(path.join(cwd, '.gemini/settings.json'), 'utf8'))
    assert.equal(settings.security.disableYoloMode, true)
    assert.equal(settings.billing.overageStrategy, 'never')
    assert.deepEqual(settings.tools.core, [])
    assert.deepEqual(settings.mcp.allowed, ['reel'])
    assert.deepEqual(Object.keys(settings.mcpServers), ['reel'])
    assert.deepEqual(settings.mcpServers.reel.includeTools, ['reel_api', 'reel_frame'])
    assert.equal(settings.mcpServers.reel.trust, false)
    assert.equal(settings.hooksConfig.enabled, false); assert.equal(settings.skills.enabled, false); assert.equal(settings.experimental.enableAgents, false)
    assert.equal(settings.context.fileFiltering.enableRecursiveFileSearch, false)
    assert.ok(JSON.stringify(settings.mcpServers.reel.env).includes(transport.token), 'Gemini CLI redacts inherited TOKEN variables, so the MCP env is explicit')
    assert.equal(await fs.readFile(path.join(cwd, '.geminiignore'), 'utf8'), '*\n.*\n')
    for (const file of [policy, path.join(cwd, '.gemini/settings.json'), path.join(cwd, '.geminiignore')]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(path.join(cwd, '.gemini'))).mode & 0o777, 0o700)
    assert.equal(adapter.env.GEMINI_CLI_AUTH_OVERRIDE, 'oauth-personal'); assert.equal(adapter.env.NO_BROWSER, 'true')
    assert.equal(adapter.exitMessage(41, ''), GEMINI_SIGN_IN_MESSAGE)
  } finally { await adapter.cleanup() }
  await assert.rejects(fs.stat(cwd), { code: 'ENOENT' })
  const plain = await prepareAdapter({ id: randomUUID(), provider: 'gemini-cli', text: 'Edit' }, transport)
  try { assert.ok(!plain.args.includes('-m')) } finally { await plain.cleanup() }
  await assert.rejects(prepareAdapter({ id: randomUUID(), provider: 'gemini-cli', text: 'Edit', agent: 'editor' }, transport))
})

test('Gemini environment strips API keys, endpoints, settings overrides and IDE state', () => {
  const env = geminiEnvironment({ HOME: '/user', PATH: '/bin', GEMINI_API_KEY: 'x', GOOGLE_API_KEY: 'x', GOOGLE_GEMINI_BASE_URL: 'https://example.invalid', GOOGLE_VERTEX_BASE_URL: 'x',
    GOOGLE_APPLICATION_CREDENTIALS: '/c.json', GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_GENAI_USE_GCA: 'true', CODE_ASSIST_ENDPOINT: 'x', GEMINI_CLI_HOME: '/other',
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/s.json', GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_CLI_IDE_SERVER_PORT: '1', GEMINI_CLI_IDE_WORKSPACE_PATH: '/w', GEMINI_SYSTEM_MD: '/m.md', GEMINI_MODEL: 'm',
    GEMINI_SANDBOX: 'docker', GEMINI_CLI_AUTH_OVERRIDE: 'gemini-api-key' })
  assert.deepEqual(env, { HOME: '/user', PATH: '/bin', GEMINI_CLI_AUTH_OVERRIDE: 'oauth-personal', NO_BROWSER: 'true' })
})

test('Gemini stream-json maps to bridge text, done and failure events', () => {
  const line = value => outputEvent('gemini-cli', JSON.stringify(value))
  assert.equal(line({ type: 'init', session_id: 's', model: 'gemini-3-pro-preview' }), null)
  assert.equal(line({ type: 'message', role: 'user', content: 'prompt' }), null)
  assert.deepEqual(line({ type: 'message', role: 'assistant', content: 'Hello', delta: true }), { type: 'text', text: 'Hello' })
  assert.equal(line({ type: 'tool_use', tool_name: 'reel_api', tool_id: '1', parameters: {} }), null)
  assert.equal(line({ type: 'tool_result', tool_id: '1', status: 'success', output: '{}' }), null)
  assert.match(line({ type: 'tool_result', tool_id: '1', status: 'error', error: { type: 'POLICY_VIOLATION', message: 'denied' } }).message, /A tool call failed or was denied\. denied/)
  assert.equal(line({ type: 'error', severity: 'warning', message: 'Loop warning' }), null)
  assert.deepEqual(line({ type: 'error', severity: 'error', message: 'RESOURCE_EXHAUSTED: quota' }), { type: 'error', message: GEMINI_QUOTA_MESSAGE })
  assert.deepEqual(line({ type: 'result', status: 'success', stats: {} }), { type: 'done' })
  assert.match(line({ type: 'result', status: 'error', error: { type: 'Error', message: 'Server failed' } }).message, /^Gemini CLI stopped: Server failed/)
  assert.equal(geminiExitMessage(41, ''), GEMINI_SIGN_IN_MESSAGE)
  assert.equal(geminiExitMessage(1, 'You exceeded your current quota (429)'), GEMINI_QUOTA_MESSAGE)
  assert.match(geminiExitMessage(53, ''), /turn limit/)
  assert.equal(geminiExitMessage(1, 'other'), null)
})

async function catalogFor(row) {
  const host = createAssistantCatalog({ providerStatus: async () => [row] })
  try { return await host.status({ wait: true }) } finally { host.close() }
}

test('Gemini status reports signed-out and signed-in from the sign-in file only', async t => {
  const { home } = await fakeGemini(t)
  const status = async () => (await providerStatus()).find(item => item.id === 'gemini-cli')
  const signedOut = await status()
  assert.equal(signedOut.installed, true); assert.equal(signedOut.authenticated, false)
  assert.match(signedOut.reason, /Sign in once by running gemini in Terminal/)
  const models = await catalogFor(signedOut)
  assert.equal(models.providers.find(item => item.id === 'gemini-cli').available, false)
  assert.equal(models.catalogs.length, 0)
  await fs.mkdir(path.join(home, '.gemini')); await fs.writeFile(path.join(home, '.gemini/oauth_creds.json'), '{}', { mode: 0o600 })
  assert.equal(await geminiSignedIn(home), true)
  const signedIn = await status()
  assert.equal(signedIn.authenticated, true); assert.match(signedIn.reason, /checks only that it exists/)
  const catalog = await catalogFor(signedIn)
  assert.equal(catalog.providers.find(item => item.id === 'gemini-cli').available, true)
  const listed = catalog.catalogs.find(item => item.provider === 'gemini-cli')
  assert.equal(listed.source.kind, 'provider-docs'); assert.match(listed.source.label, /Not checked against your account/)
  assert.deepEqual(listed.models.map(item => item.id), geminiCatalogRecords().map(item => item.model))
})

async function runGemini(t, mode) {
  await fakeGemini(t, { FAKE_GEMINI_MODE: mode, GEMINI_API_KEY: 'should-be-removed', GOOGLE_CLOUD_PROJECT: 'should-be-removed', GEMINI_CLI_IDE_SERVER_PORT: '9' })
  const bridge = await startBridge(fixtureBridgeOptions({ prepareAdapter, catalogOptions: { providerStatus: async () => [{ id: 'gemini-cli', installed: true, authenticated: true }] } }))
  t.after(() => bridge.close())
  const call = async (method, route, body) => {
    const response = await fetch(new URL(route, bridge.endpoint), { method, headers: { authorization: `Bearer ${bridge.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, body: await response.json() }
  }
  const id = randomUUID()
  const started = await call('POST', '/v1/runs', { id, provider: 'gemini-cli', text: 'Read the project', sharing: fixtureSharing(bridge.endpoint, [{ provider: 'gemini-cli', model: '' }]) })
  assert.equal(started.status, 201, JSON.stringify(started.body))
  const events = []
  let cursor = 0
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    for (const event of (await call('GET', `/v1/runs/${id}/events?after=${cursor}`)).body.events) {
      cursor = event.seq; events.push(event)
      if (event.type === 'tool') assert.equal((await call('POST', `/v1/runs/${id}/tools/${event.callID}`, { result: { project: newProject() } })).status, 200)
      if (event.type === 'done' || event.type === 'error') return events
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('Gemini fixture timed out')
}

test('Gemini run streams text and reports Reel tool calls through the bridge', async t => {
  const events = await runGemini(t, 'edit')
  assert.deepEqual(events.filter(item => item.type === 'tool').map(item => item.path), ['/api/project'])
  assert.equal(events.filter(item => item.type === 'text').map(item => item.text).join(''), 'Read the project with reel_api and reel_frame. Done.')
  assert.equal(events.at(-1).type, 'done')
})

test('Gemini run with a denied tool fails even when the CLI exits 0', async t => {
  const events = await runGemini(t, 'denied')
  assert.equal(events.at(-1).type, 'error')
  assert.match(events.at(-1).message, /A tool call failed or was denied\. Arya allows only the reel_api and reel_frame tools\./)
  assert.ok(!events.some(item => item.type === 'done'))
})

test('Gemini exit 41 asks the user to sign in', async t => {
  const events = await runGemini(t, 'auth')
  assert.deepEqual(events.at(-1), { ...events.at(-1), type: 'error', message: GEMINI_SIGN_IN_MESSAGE })
})

test('Gemini launch passes a stripped environment and the request on stdin', async t => {
  const record = path.join(os.tmpdir(), `arya-gemini-record-${randomUUID()}.json`)
  t.after(() => fs.rm(record, { force: true }))
  process.env.FAKE_GEMINI_RECORD = record
  t.after(() => { delete process.env.FAKE_GEMINI_RECORD })
  await runGemini(t, 'edit')
  const seen = JSON.parse(await fs.readFile(record, 'utf8'))
  assert.equal(seen.env.GEMINI_API_KEY, null); assert.equal(seen.env.GOOGLE_CLOUD_PROJECT, null); assert.equal(seen.env.GEMINI_CLI_IDE_SERVER_PORT, null)
  assert.equal(seen.env.GEMINI_CLI_AUTH_OVERRIDE, 'oauth-personal'); assert.equal(seen.env.NO_BROWSER, 'true')
  assert.equal(seen.request, true)
  assert.equal(seen.policy, GEMINI_POLICY)
  assert.ok(seen.argv.includes('--skip-trust'))
  // Cleanup runs after the terminal event, so allow it a moment under load.
  let removed = false
  for (let i = 0; i < 100 && !removed; i++) { removed = await fs.stat(seen.cwd).then(() => false, error => error.code === 'ENOENT'); if (!removed) await new Promise(resolve => setTimeout(resolve, 50)) }
  assert.ok(removed, 'The private run folder is removed after the run')
})

test('a system Gemini policy folder with .toml files blocks the run', async () => {
  const { geminiSystemPolicyBlocks } = await import('../agent/gemini.mjs')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arya-gemini-policy-'))
  try {
    assert.equal(await geminiSystemPolicyBlocks(dir), false)
    await fs.writeFile(path.join(dir, 'org.toml'), '')
    assert.equal(await geminiSystemPolicyBlocks(dir), true)
    assert.equal(await geminiSystemPolicyBlocks(path.join(dir, 'missing')), false)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
