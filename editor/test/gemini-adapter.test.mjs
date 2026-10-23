import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareAdapter } from '../agent/adapters.mjs'
import { createAssistantCatalog } from '../agent/assistant-catalog.mjs'

test('retired Gemini individual sign-in cannot launch an editing run', async () => {
  await assert.rejects(prepareAdapter({ provider: 'gemini-cli', text: 'Edit' }, {}), /retired.*Choose Google Antigravity/)
})

test('saved Gemini login cannot make the retired adapter available or advertise its old catalog', async () => {
  const host = createAssistantCatalog({ providerStatus: async () => [{ id: 'gemini-cli', installed: true, authenticated: true }] })
  try {
    const value = await host.status({ wait: true })
    assert.equal(value.providers[0].adapterSupported, false)
    assert.equal(value.providers[0].available, false)
    assert.deepEqual(value.catalogs, [])
  } finally { host.close() }
})
