// The checks that run before an assistant request are timed, without adding a check.
// Seen on 2026-11-16: "Preparing your request" took 2 to 11 s and nothing said which step was slow.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { createAssistantCatalog } from '../agent/assistant-catalog.mjs'
import { createProbeTiming } from '../agent/probe-timing.mjs'

function fixture() {
  const clock = { now: 0 }, lines = [], calls = { accounts: 0, models: 0 }
  const timing = createProbeTiming({ log: line => lines.push(line), now: () => clock.now })
  const accounts = async () => { calls.accounts++; clock.now += 2038; return [{ id: 'codex', name: 'Codex', available: true, configured: true, reason: 'secret account detail' }] }
  const models = async () => { calls.models++; clock.now += 618; return { provider: 'codex', models: [{ id: 'm1', name: 'Model', default: true }], fetchedAt: Date.now() } }
  return { clock, lines, calls, timing, accounts, models }
}

test('one sharing review and one send log two route checks with their steps, and make no extra check', async () => {
  const f = fixture()
  const catalog = f.timing.catalog(createAssistantCatalog({ providerStatus: f.timing.probe('editor', 'accounts', f.accounts), readCodexCatalog: f.timing.probe('editor', 'models', f.models), executable: async () => '/fixture/codex' }))
  await catalog.resolve({ provider: 'codex', mode: 'manual' }, { requiresImage: true }).catch(() => {})
  await catalog.resolve({ provider: 'codex', mode: 'manual' }, { text: 'Cut it.', requiresImage: true }).catch(() => {})
  assert.equal(f.calls.accounts, 2, 'one account check per route check, as before')
  assert.ok(f.calls.models <= 2)
  assert.equal(f.lines.length, 2)
  assert.match(f.lines[0], /^sharing review route check took \d+ ms \(account check 2038 ms in 1 call, Codex model list (618 ms in 1 call|0 ms in 0 calls)\)$/)
  assert.match(f.lines[1], /^send route check took \d+ ms \(account check 2038 ms in 1 call, Codex model list (618 ms in 1 call|0 ms in 0 calls)\)$/)
  assert.ok(!f.lines.join('\n').includes('secret'), 'only durations are logged')
  assert.equal(typeof catalog.status, 'function'); assert.equal(typeof catalog.invalidate, 'function'); catalog.close()
})

test('the agent process reports a slow check of its own and stays quiet about a fast one', async () => {
  const f = fixture()
  await f.timing.probe('agent', 'accounts', f.accounts)()
  await f.timing.probe('agent', 'models', f.models)()
  assert.deepEqual(f.lines, ['agent account check took 2038 ms'])
  const failing = f.timing.probe('agent', 'models', async () => { f.clock.now += 15000; throw new Error('private failure text') })
  await assert.rejects(failing(), /private failure text/, 'a failure is passed on unchanged')
  assert.deepEqual(f.lines.at(-1), 'agent Codex model list took 15000 ms')
})

test('a log hook that throws cannot fail a check', async () => {
  const timing = createProbeTiming({ log: () => { throw new Error('log closed') }, now: (() => { let t = 0; return () => (t += 2000) })() })
  assert.equal(await timing.probe('agent', 'accounts', async () => 'rows')(), 'rows')
  assert.equal(await timing.catalog({ resolve: async () => 'route' }).resolve({}, {}), 'route')
})

test('the browser assistant times its own catalog and the agent process it starts', () => {
  const source = fs.readFileSync(new URL('../agent/browser-assistant.mjs', import.meta.url), 'utf8')
  assert.match(source, /const catalogHost = probeTiming\.catalog\(createAssistantCatalog\(\{[^\n]*providerStatus: probeTiming\.probe\('editor', 'accounts', [^\n]*readCodexCatalog: probeTiming\.probe\('editor', 'models', /)
  assert.match(source, /catalogOptions: \{[^\n]*providerStatus: probeTiming\.probe\('agent', 'accounts', [^\n]*readCodexCatalog: probeTiming\.probe\('agent', 'models', /)
})
