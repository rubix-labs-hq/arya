import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { h } from 'preact'
import htm from 'htm'
import { CATALOG_MAX_AGE_MS, normalizeCatalog, selectRoute } from '../core/assistant-routing.mjs'
import { assistantState } from '../web/ui/assistant-state.js'

const now = 1_000_000
const provider = { id: 'codex', installed: true, authenticated: true, available: true, adapterSupported: true, modelSelectionSupported: true, billingMode: 'subscription', reason: 'Signed in.' }
const fixture = (mode, age) => {
  const catalogs = [normalizeCatalog({ provider: 'codex', records: [{ id: 'exact', isDefault: true, reasoningEfforts: ['medium'] }], checkedAt: now - age, source: { kind: 'provider-cli' } })]
  const preferences = { provider: 'codex', mode, model: 'exact', effort: 'medium', catalogBound: true, enabledModels: [{ provider: 'codex', model: 'exact' }] }
  const route = selectRoute({ preferences, catalogs, providers: [provider], now })
  return { ...preferences, providers: [provider], catalogs, configured: route.ok, reason: route.reason, [mode === 'auto' ? 'autoPreview' : 'manualPreview']: route }
}

test('expiry classification follows the unchanged dispatch freshness boundary', t => {
  t.mock.method(Date, 'now', () => now)
  for (const mode of ['manual', 'auto']) {
    const fresh = fixture(mode, CATALOG_MAX_AGE_MS), stale = fixture(mode, CATALOG_MAX_AGE_MS + 1)
    assert.equal(assistantState(fresh).ready, true)
    assert.equal(assistantState(fresh).refreshRequired, false)
    assert.equal(stale.configured, false)
    assert.equal(assistantState(stale).ready, false)
    assert.equal(assistantState(stale).refreshRequired, true)
    assert.equal(assistantState(stale).label, 'Model availability needs a refresh')
    assert.match(assistantState(stale).reason, /expired/)
  }
})

test('provider check time cannot renew the model catalog', t => {
  t.mock.method(Date, 'now', () => now)
  const stale = fixture('manual', CATALOG_MAX_AGE_MS + 1)
  stale.checkedAt = now
  assert.equal(assistantState(stale).refreshRequired, true)
})

test('inactive, signed-out and unverified catalogs keep their existing account recovery', t => {
  t.mock.method(Date, 'now', () => now)
  const stale = fixture('manual', CATALOG_MAX_AGE_MS + 1)
  assert.equal(assistantState(stale, 'claude-code').refreshRequired, false)
  for (const change of [status => { status.providers = [{ ...provider, authenticated: false, available: false }] },
    status => { status.catalogs = [] }, status => { status.catalogs[0].complete = false },
    status => { status.catalogs[0].source.kind = 'untrusted' }, status => { status.catalogs[0].checkedAt = now + 1 }]) {
    const status = structuredClone(stale); change(status)
    assert.equal(assistantState(status).refreshRequired, false)
    assert.equal(assistantState(status).ready, false)
  }
})

test('mixed Auto blockers retain the exact routing rejection', t => {
  t.mock.method(Date, 'now', () => now)
  const stale = fixture('auto', CATALOG_MAX_AGE_MS + 1)
  stale.autoPreview.blocked.push({ provider: 'claude-code', model: 'other', reason: 'Sign in.' })
  assert.equal(assistantState(stale).refreshRequired, false)
  assert.equal(assistantState(stale).ready, false)
  assert.equal(assistantState(stale).reason, stale.reason)
})

test('a fresh removed Manual model shows routing recovery rather than successful account status', t => {
  t.mock.method(Date, 'now', () => now)
  const catalogs = [normalizeCatalog({ provider: 'codex', records: [{ id: 'remaining-model', inputModalities: ['text', 'image'] }], checkedAt: now, source: { kind: 'provider-cli' } })]
  const preferences = { mode: 'manual', provider: 'codex', model: 'removed-model', catalogBound: true }
  const route = selectRoute({ preferences, catalogs, providers: [provider], now })
  const view = assistantState({ ...preferences, providers: [provider], catalogs, configured: route.ok, reason: route.reason, manualPreview: route })
  assert.equal(route.ok, false)
  assert.equal(view.ready, false)
  assert.equal(view.refreshRequired, false)
  assert.equal(view.label, 'Setup needed')
  assert.equal(view.reason, route.reason)
  assert.match(view.reason, /Refresh status/)
})

test('selected native readiness recovery takes precedence over a signed-in provider detail', () => {
  for (const reason of ['Choose an exact Codex model in Assistant settings.', 'Native AI sharing does not support this recipient.']) {
    const view = assistantState({ provider: 'codex', mode: 'manual', configured: false, providers: [provider], reason })
    assert.equal(view.ready, false)
    assert.equal(view.reason, reason)
  }
})

test('an unselected provider keeps its own account recovery instead of the saved route reason', () => {
  const unselected = { ...provider, id: 'claude-code', available: false, authenticated: false, reason: 'Sign in with Claude.' }
  const view = assistantState({ provider: 'codex', mode: 'manual', configured: false, reason: 'Choose an exact Codex model.', providers: [provider, unselected] }, 'claude-code')
  assert.equal(view.label, 'Sign-in needed')
  assert.equal(view.reason, unselected.reason)
})

test('ready providers and missing route reasons retain existing account status and fallback', () => {
  const ready = assistantState({ provider: 'codex', mode: 'manual', configured: true, providers: [provider], reason: 'Your verified Manual model is ready.' })
  assert.equal(ready.ready, true)
  assert.equal(ready.reason, provider.reason)
  const noRouteReason = assistantState({ provider: 'codex', configured: false, providers: [provider] })
  assert.equal(noRouteReason.reason, provider.reason)
  assert.equal(assistantState(null).reason, 'Refresh status to check this provider.')
})

test('welcome describes current assistant context without a fixed provider', () => {
  const source = readFileSync(new URL('../web/ui/app.js', import.meta.url), 'utf8').replaceAll('import.meta.url', JSON.stringify(new URL('../web/ui/app.js', import.meta.url).href)).replace(/^import .*$/gm, '').replace('export async function mountApp', 'async function mountApp')
  const tree = new Function('h', 'htm', 'useState', 'useStore', 'host', `${source}\nreturn Welcome()`)(h, htm, value => [value, () => {}], () => ({}), { kind: 'http' })
  const text = node => node == null ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props?.children) : String(node)
  assert.match(text(tree), /connected assistant.*current selection and references/)
  assert.match(text(tree), /Review its changes with undo/)
  assert.doesNotMatch(text(tree), /Claude/)
})
