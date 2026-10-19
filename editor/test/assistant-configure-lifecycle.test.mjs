import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceRoot = process.env.ARYA_CATALOG_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const dependencyRoot = process.env.ARYA_CATALOG_DEPENDENCY_ROOT ?? sourceRoot
const source = fs.readFileSync(path.join(sourceRoot, 'agent/browser-assistant.mjs'), 'utf8')
// Snapshot runs redirect imports to the recorded dependency tree. The service
// body is the actual source; injected callbacks never launch a provider or bridge.
const executableSource = source.replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_, prefix, specifier, suffix) => `${prefix}${pathToFileURL(path.resolve(dependencyRoot, 'agent', specifier)).href}${suffix}`)
const { createBrowserAssistant } = await import(`data:text/javascript;base64,${Buffer.from(executableSource).toString('base64')}`)
const { normalizeCatalog } = await import(pathToFileURL(path.join(dependencyRoot, 'core/assistant-routing.mjs')).href)
const at = 1791080014819
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya offline configure lifecycle ')), entered = deferred(), gate = deferred(), publications = []
  let accountCalls = 0, discoveryCalls = 0
  const service = createBrowserAssistant({ root, now: () => at, getIdentity: () => 1, getOutline: () => ({ version: 1 }), onState: value => publications.push(value),
    startBridge: async () => { assert.fail('Configuration must not start a bridge.') },
    executable: async () => { assert.fail('Use only injected catalog callbacks.') },
    providerStatus: async () => { assert.fail('Use only injected catalog callbacks.') },
    catalogOptions: { now: () => at, providerStatus: async () => { accountCalls++; entered.resolve(); await gate.promise; return [{ id: 'codex', installed: true, authenticated: true }] },
      executable: async name => { assert.equal(name, 'codex'); return '/offline/fixture/codex' },
      readCodexCatalog: async () => { discoveryCalls++; return normalizeCatalog({ provider: 'codex', records: ['older', 'newer'].map(id => ({ id, inputModalities: ['text', 'image'] })), checkedAt: at, source: { kind: 'provider-cli', label: 'Offline injected lifecycle fixture' } }) } } })
  t.after(async () => { gate.resolve(); await service.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { service, entered, gate, publications, saved: () => JSON.parse(fs.readFileSync(path.join(root, '.reel', 'assistant-settings.json'), 'utf8')), counts: () => ({ accountCalls, discoveryCalls }) }
}

const superseded = error => error.status === 409 && /newer assistant preference request/i.test(error.message)

test('a delayed verified Manual save cannot overwrite a newer advanced Manual save', async t => {
  const f = fixture(t)
  const older = f.service.configure({ provider: 'codex', model: 'older', catalogBound: true })
  const rejected = assert.rejects(older, superseded)
  await f.entered.promise
  const newer = f.service.configure({ provider: 'codex', model: 'newer' })
  assert.equal(f.service.snapshot().model, 'newer')
  assert.equal(f.saved().model, 'newer')
  f.gate.resolve()
  await rejected
  assert.equal((await newer).model, 'newer')
  assert.equal(f.service.snapshot().model, 'newer')
  assert.deepEqual(f.saved(), { provider: 'codex', model: 'newer', agent: '' })
  assert.equal(f.publications.length, 1)
  assert.deepEqual(f.counts(), { accountCalls: 1, discoveryCalls: 1 })
})

test('a delayed Auto pool save cannot replace a newer Manual intent or clear its state', async t => {
  const f = fixture(t)
  const older = f.service.configure({ mode: 'auto', provider: 'codex', enabledModels: [{ provider: 'codex', model: 'older' }] })
  const rejected = assert.rejects(older, superseded)
  await f.entered.promise
  const newer = f.service.configure({ provider: 'codex', model: 'newer', mode: 'manual', priority: 'quality' })
  f.gate.resolve()
  await rejected
  const current = await newer
  assert.equal(current.mode, 'manual'); assert.equal(current.model, 'newer'); assert.equal(current.priority, 'quality')
  assert.equal(f.saved().mode, 'manual'); assert.equal(f.saved().model, 'newer'); assert.equal(f.saved().priority, 'quality')
  assert.deepEqual(f.saved().enabledModels, [])
  assert.equal(f.publications.length, 1)
})

test('two verified saves sharing a metadata wait commit only the latest admitted intent', async t => {
  const f = fixture(t)
  const older = f.service.configure({ provider: 'codex', model: 'older', catalogBound: true })
  const rejected = assert.rejects(older, superseded)
  await f.entered.promise
  const newer = f.service.configure({ provider: 'codex', model: 'newer', catalogBound: true })
  f.gate.resolve()
  await rejected
  assert.equal((await newer).model, 'newer')
  assert.equal(f.saved().model, 'newer'); assert.equal(f.saved().catalogBound, true)
  assert.equal(f.publications.length, 1)
  assert.deepEqual(f.counts(), { accountCalls: 1, discoveryCalls: 1 })
})

test('an invalid later request does not supersede a valid waiting save', async t => {
  const f = fixture(t)
  const older = f.service.configure({ provider: 'codex', model: 'older', catalogBound: true })
  await f.entered.promise
  await assert.rejects(f.service.configure({ provider: 'codex', agent: 'unsupported' }), /Agent selector/)
  await assert.rejects(f.service.configure({ provider: 'custom' }), /server starts/)
  f.gate.resolve()
  assert.equal((await older).model, 'older')
  assert.equal(f.saved().model, 'older'); assert.equal(f.saved().catalogBound, true)
  assert.equal(f.publications.length, 1)
})
