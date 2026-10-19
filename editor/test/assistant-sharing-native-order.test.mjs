import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { SHARING_CLASSES, assertSharingRoute, normalizeSharingScope, normalizeSharingEnvelope, sameSharingScope, sharingScopeForRoute } from '../core/assistant-sharing.mjs'

const runtime = new URL('../web/ui/assistant-sharing.js', import.meta.url)
const { createAssistantSharingGate } = await import(fs.existsSync(runtime) ? runtime : new URL('./fixtures/assistant-sharing-gate.fixture.mjs', import.meta.url))
const companion = 'https://companion.example.test/'
// Literal expected arrays match native provider/model String< ordering for valid ASCII IDs.
const nativeFixtures = [
  { name: 'mixed case', providers: ['codex'], models: [
    { provider: 'codex', model: 'Alpha' }, { provider: 'codex', model: 'Beta' }, { provider: 'codex', model: 'alpha' }, { provider: 'codex', model: 'beta' },
  ] },
  { name: 'punctuation', providers: ['codex'], models: [
    { provider: 'codex', model: 'a+b' }, { provider: 'codex', model: 'a-b' }, { provider: 'codex', model: 'a.b' }, { provider: 'codex', model: 'a/b' },
    { provider: 'codex', model: 'a:b' }, { provider: 'codex', model: 'a@b' }, { provider: 'codex', model: 'a[b]' }, { provider: 'codex', model: 'a_b' },
  ] },
  { name: 'multiple providers and defaults', providers: ['anthropic', 'claude-code', 'codex'], models: [
    { provider: 'anthropic', model: '' }, { provider: 'anthropic', model: 'Alpha' }, { provider: 'anthropic', model: 'a-b' }, { provider: 'anthropic', model: 'a_b' },
    { provider: 'claude-code', model: '' }, { provider: 'claude-code', model: 'Alpha' }, { provider: 'claude-code', model: 'alpha' },
    { provider: 'codex', model: '' }, { provider: 'codex', model: 'a-b' }, { provider: 'codex', model: 'a_b' },
  ] },
]
const scopeFor = fixture => ({ providers: [...fixture.providers], models: fixture.models.map(item => ({ ...item })), companion, classes: [...SHARING_CLASSES] })
const envelopeFor = scope => ({ version: 1, approved: true, scope })
const permutations = values => [values, [...values].reverse(), ...values.map((_, index) => [...values.slice(index), ...values.slice(0, index)]), ...values.slice(1).map((_, index) => { const next = [...values]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return next })]
// Native canonical JSON sorts object keys and preserves recipient array order.
const nativeCanonical = value => Array.isArray(value) ? value.map(nativeCanonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, nativeCanonical(value[key])])) : value

test('sharing policy matches native lexical recipient arrays under input permutations', async t => {
  for (const fixture of nativeFixtures) await t.test(fixture.name, () => {
    const expected = scopeFor(fixture)
    for (const models of permutations(fixture.models)) {
      const input = { ...expected, providers: [...fixture.providers].reverse(), models, classes: [...SHARING_CLASSES].reverse() }
      const normalized = normalizeSharingScope(input)
      assert.deepEqual(normalized, expected)
      assert.deepEqual(normalizeSharingEnvelope(envelopeFor(input)), envelopeFor(expected))
      assert.equal(sameSharingScope(input, expected), true)
      assert.equal(sameSharingScope(expected, input), true)
    }
  })
})

test('actual browser Allow preserves the native canonical envelope for case, punctuation and default pools', async t => {
  for (const fixture of nativeFixtures) await t.test(fixture.name, async child => {
    const nativeScope = scopeFor(fixture), nativeEnvelope = envelopeFor(nativeScope)
    let shown, posted
    const gate = createAssistantSharingGate({ busy: () => {}, present: review => { if (review) shown = review }, api: async (route, body) => {
      if (route === '/api/assistant/sharing') return { version: 1, approved: false, required: true, scope: nativeScope, sharing: null, reviewID: 'native-review-capability' }
      assert.equal(route, '/api/assistant/sharing/grant'); assert.equal(body.reviewID, 'native-review-capability')
      posted = body.sharing
      assert.equal(JSON.stringify(nativeCanonical(posted)), JSON.stringify(nativeCanonical(nativeEnvelope)), 'Native grant must receive its identical model array, including ASCII case and punctuation order.')
      return { version: 1, approved: true, required: false, scope: nativeScope, sharing: nativeEnvelope }
    } })
    child.after(() => gate.dispose())
    const result = gate.request().then(value => ({ value }), error => ({ error }))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(shown.scope.models, fixture.models)
    await gate.allow()
    const resolved = await result
    assert.equal(resolved.error, undefined)
    assert.deepEqual(posted, nativeEnvelope); assert.deepEqual(resolved.value.sharing, nativeEnvelope); assert.equal(resolved.value.valid(), true)
  })
})

test('actual browser reuses a saved native envelope without a false grant mismatch', async t => {
  for (const fixture of nativeFixtures) await t.test(fixture.name, async child => {
    const nativeScope = scopeFor(fixture), nativeEnvelope = envelopeFor(nativeScope)
    const gate = createAssistantSharingGate({ busy: () => {}, present: () => {}, api: async (route, body) => {
      assert.equal(route, '/api/assistant/sharing'); assert.equal(body, undefined)
      return { version: 1, approved: true, scope: nativeScope, sharing: nativeEnvelope }
    } })
    child.after(() => gate.dispose())
    const result = await gate.request()
    assert.deepEqual(result.sharing, nativeEnvelope); assert.equal(result.valid(), true)
  })
})

test('lexical ordering keeps provider defaults, exact model identity and strict scope checks', () => {
  const route = { ok: true, mode: 'manual', provider: 'claude-code', model: null }
  const defaultScope = sharingScopeForRoute(route, companion)
  assert.deepEqual(defaultScope.models, [{ provider: 'claude-code', model: '' }])
  assert.deepEqual(assertSharingRoute(envelopeFor(defaultScope), route, companion), envelopeFor(defaultScope))
  const upper = { ...defaultScope, models: [{ provider: 'claude-code', model: 'Alpha' }] }, lower = { ...defaultScope, models: [{ provider: 'claude-code', model: 'alpha' }] }
  assert.equal(sameSharingScope(upper, lower), false)
  const dash = { ...defaultScope, models: [{ provider: 'claude-code', model: 'a-b' }] }, underscore = { ...defaultScope, models: [{ provider: 'claude-code', model: 'a_b' }] }
  assert.equal(sameSharingScope(dash, underscore), false)
  assert.throws(() => assertSharingRoute(envelopeFor(upper), route, companion), /model pool changed/)
  for (const invalid of [{ ...upper, models: [...upper.models, ...upper.models] }, { ...upper, classes: ['prompt'] }, { ...upper, providers: ['custom'], models: [{ provider: 'custom', model: 'Alpha' }] }, { ...upper, models: [{ provider: 'claude-code', model: 'non-ASCII-é' }] }]) assert.throws(() => normalizeSharingScope(invalid))
})
