import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { antigravityAccount, antigravityEnvironment, antigravityHome, prepareAntigravityProfile, writeAntigravityWorkspace, antigravityArgs, antigravityPrompt, antigravityOutputEvent } from '../agent/antigravity.mjs'
import { createAssistantCatalog } from '../agent/assistant-catalog.mjs'

async function temporary(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'arya-agy-test-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  return home
}

test('Arya profile leaves normal MCP settings untouched and permits only its project tools', async t => {
  const home = await temporary(t)
  await fs.mkdir(path.join(home, '.gemini'))
  const existing = path.join(home, '.gemini', 'settings.json')
  await fs.writeFile(existing, 'unrelated settings')
  const profile = await prepareAntigravityProfile(home)
  assert.equal(profile, antigravityHome(home))
  assert.equal(await fs.readFile(existing, 'utf8'), 'unrelated settings')
  const settings = JSON.parse(await fs.readFile(path.join(profile, '.gemini', 'antigravity-cli', 'settings.json')))
  assert.equal(settings.useG1Credits, false)
  assert.deepEqual(settings.permissions.allow, ['mcp(reel/reel_api)', 'mcp(reel/reel_frame)'])
  for (const action of ['command', 'unsandboxed', 'read_file', 'write_file', 'read_url', 'execute_url']) assert.ok(settings.permissions.deny.includes(`${action}(*)`))
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile, '.gemini', 'config', 'mcp_config.json'))), { mcpServers: {} })
  assert.equal((await fs.stat(profile)).mode & 0o777, 0o700)
  assert.equal((await fs.stat(path.join(profile, '.gemini', 'antigravity-cli', 'settings.json'))).mode & 0o777, 0o600)
})

test('profile creation rejects links instead of modifying an unrelated directory', async t => {
  const home = await temporary(t), target = await temporary(t)
  await fs.symlink(target, path.join(home, '.arya'))
  await assert.rejects(prepareAntigravityProfile(home), /private directory/)
  assert.deepEqual(await fs.readdir(target), [])
})

test('child environment isolates the profile and strips inherited billing, endpoint and plugin overrides', () => {
  const original = { HOME: '/real', PATH: '/bin', GEMINI_API_KEY: 'fixture', GOOGLE_APPLICATION_CREDENTIALS: 'fixture', OPENAI_API_KEY: 'fixture', AGY_ACCOUNT: 'fixture', AGY_LLM_GATEWAY_URL: 'fixture', ANTIGRAVITY_PERM_GRANTS: 'fixture', XDG_CONFIG_HOME: '/unrelated' }
  const env = antigravityEnvironment(original, '/real')
  assert.deepEqual(env, { HOME: '/real/.arya/antigravity', PATH: '/bin', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' })
  assert.equal(original.HOME, '/real')
})

test('run workspace exposes the private Reel server and no built-in agent tools', async t => {
  const cwd = await temporary(t), server = { command: '/node', args: ['/mcp.mjs'], env: { REEL_AGENT_RUN_TOKEN: 'fixture' } }
  await writeAntigravityWorkspace(cwd, server)
  const config = JSON.parse(await fs.readFile(path.join(cwd, '.agents', 'mcp_config.json')))
  assert.deepEqual(Object.keys(config.mcpServers), ['reel'])
  assert.deepEqual(config.mcpServers.reel.enabledTools, ['reel_api', 'reel_frame'])
  assert.match(await fs.readFile(path.join(cwd, '.agents', 'agents', 'arya.md'), 'utf8'), /tools: \[\]\ninheritMcp: true\ninheritCustomizations: false/)
  const args = antigravityArgs('exact-slug', 'medium')
  assert.ok(!args.includes('--dangerously-skip-permissions'))
  assert.ok(args.includes('--disable-slash-commands'))
  assert.deepEqual(args.slice(-4), ['--model', 'exact-slug', '--effort', 'medium'])
  assert.deepEqual(JSON.parse(antigravityPrompt('private request')), { event: 'user', message: { content: 'private request' } })
  assert.ok(!args.includes('private request'))
})

test('account access comes from authenticated CLI model discovery, never cached credential files', async t => {
  const home = await temporary(t), command = path.join(home, 'agy')
  await fs.writeFile(command, '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.6; else printf "fixture-model\\tFixture model\\n"; fi\n', { mode: 0o700 })
  const account = await antigravityAccount(command, home)
  assert.equal(account.authenticated, true)
  assert.deepEqual(account.models, [{ id: 'fixture-model', displayName: 'Fixture model', inputModalities: ['text'] }])
  const host = createAssistantCatalog({ providerStatus: async () => [{ id: 'antigravity', installed: true, ...account }] })
  try {
    const value = await host.status({ wait: true })
    assert.equal(value.providers[0].available, true)
    assert.equal(value.providers[0].billingMode, 'subscription')
    assert.equal(value.catalogs[0].models[0].id, 'fixture-model')
    assert.deepEqual(value.catalogs[0].models[0].inputModalities, ['text'])
  } finally { host.close() }
})

test('old CLI and unreadable model lists cannot claim account readiness', async t => {
  const home = await temporary(t), command = path.join(home, 'agy')
  await fs.writeFile(command, '#!/bin/sh\necho 1.2.17\n', { mode: 0o700 })
  assert.equal((await antigravityAccount(command, home)).available, false)
  await fs.writeFile(command, '#!/bin/sh\nif [ "$1" = --version ]; then echo 1.4.6; else echo invalid-list; fi\n')
  assert.equal((await antigravityAccount(command, home)).available, false)
})

test('Antigravity errors do not leak provider diagnostics and quota errors never request billing fallback', () => {
  const event = antigravityOutputEvent({ event: 'result', result: { status: 'ERROR', error: 'quota reached: fixture-private-detail' } })
  assert.equal(event.type, 'error')
  assert.match(event.message, /does not enable extra AI credits/)
  assert.ok(!event.message.includes('fixture-private-detail'))
  assert.deepEqual(antigravityOutputEvent({ event: 'step_update', step_update: { text_delta: 'Hello' } }), { type: 'text', text: 'Hello' })
  assert.equal(antigravityOutputEvent({ event: 'step_update', step_update: { step_type: 'tool', state: 'ERROR', tool_info: { error: 'Invalid argument; the model can retry.' } } }), null)
  assert.deepEqual(antigravityOutputEvent({ event: 'result', result: { status: 'SUCCESS', response: 'Corrected the call.' } }), { type: 'done', text: 'Corrected the call.' })
})
