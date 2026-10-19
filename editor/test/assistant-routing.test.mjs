import test from 'node:test'
import assert from 'node:assert/strict'
import { CATALOG_MAX_AGE_MS, normalizeCatalog, modelFit, taskFit, selectRoute, validateRoutingPreferences } from '../core/assistant-routing.mjs'

const now = 1_800_000_000_000
const status = id => ({ id, authenticated: true, billingMode: 'subscription', modelSelectionSupported: true, adapterSupported: true, available: true })
const raw = (id, description, extra = {}) => ({ model: id, displayName: id, description, inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'medium', ...extra })
const catalog = (provider, records, extras = {}) => normalizeCatalog({ provider, records, checkedAt: now, source: { kind: 'provider-cli', label: 'Fixture read-only provider catalog' }, ...extras })
const pool = [{ provider: 'codex', model: 'fixture-fast' }, { provider: 'claude-code', model: 'fixture-daily' }, { provider: 'codex', model: 'fixture-deep' }]
const catalogs = [catalog('codex', [raw('fixture-fast', 'Fast and efficient for simple tasks'), raw('fixture-deep', 'Most capable for complex and demanding tasks')]), catalog('claude-code', [raw('fixture-daily', 'A workhorse for everyday tasks')])]
const providers = [status('codex'), status('claude-code')]
const route = (overrides = {}) => selectRoute({ now, catalogs, providers, preferences: { mode: 'auto', enabledModels: pool }, ...overrides })

test('balanced Auto adapts to actual task scope instead of always picking the deepest model', () => {
  const quick = route({ request: { text: 'Rename this title to Arrival', selectionCount: 1 } })
  const daily = route({ request: { text: 'Review the current pacing and suggest improvements', selectionCount: 2 } })
  const deep = route({ request: { text: 'Build an animated opening sequence', selectionCount: 0 } })
  assert.equal(quick.model, 'fixture-fast'); assert.equal(quick.effort, 'low')
  assert.equal(daily.provider, 'claude-code'); assert.equal(daily.model, 'fixture-daily'); assert.equal(daily.effort, 'medium')
  assert.equal(deep.model, 'fixture-deep'); assert.equal(deep.effort, 'high')
  assert.match(daily.rationale, /provider describes/)
})

test('Speed and Quality change selection among the enabled compatible pool', () => {
  assert.equal(route({ preferences: { mode: 'auto', enabledModels: pool, priority: 'quick' } }).model, 'fixture-fast')
  assert.equal(route({ preferences: { mode: 'auto', enabledModels: pool, priority: 'quality' } }).model, 'fixture-deep')
})

test('available models that the user did not enable cannot participate', () => {
  const result = route({ preferences: { mode: 'auto', enabledModels: pool.slice(0, 1), priority: 'quality' } })
  assert.equal(result.model, 'fixture-fast'); assert.deepEqual(result.considered, [pool[0]])
  assert.match(result.rationale, /No exact task-fit description matched/)
})

test('provider login is insufficient without a supported editing adapter', () => {
  const agy = catalog('antigravity', [raw('fixture-agy', 'Most capable for demanding work')])
  const result = route({ catalogs: [...catalogs, agy], providers: [...providers, { ...status('antigravity'), adapterSupported: false }], preferences: { mode: 'auto', priority: 'quality', enabledModels: [{ provider: 'antigravity', model: 'fixture-agy' }, ...pool] } })
  assert.equal(result.model, 'fixture-deep'); assert.equal(result.blocked[0].provider, 'antigravity')
})

test('missing or unauthenticated providers and explicit throttles are excluded', () => {
  const result = route({ providers: [{ ...status('codex'), rateLimited: true }, { ...status('claude-code'), authenticated: null }] })
  assert.equal(result.ok, false); assert.equal(result.blocked.length, 3)
})

test('future and stale catalogs fail closed with a refresh recovery', () => {
  for (const checkedAt of [now - CATALOG_MAX_AGE_MS - 1, now + 1]) {
    const result = route({ catalogs: catalogs.map(item => ({ ...item, checkedAt })) })
    assert.equal(result.ok, false); assert.equal(result.recovery, 'refresh-and-select-models')
    assert.ok(result.blocked.every(item => /refresh/.test(item.reason)))
  }
})

test('Auto does not use a model absent, hidden, unavailable or retired in the current list', () => {
  const cases = [{ records: [] }, { records: [raw('fixture-fast', 'Fast', { hidden: true })] }, { records: [raw('fixture-fast', 'Fast', { available: false })] }, { records: [raw('fixture-fast', 'Fast', { upgradeInfo: { retirementAt: now / 1000 } })] }]
  for (const entry of cases) assert.equal(route({ catalogs: [catalog('codex', entry.records)], preferences: { mode: 'auto', enabledModels: [pool[0]] } }).ok, false)
})

test('unknown frame-inspection capability is explicit; text-only requests can still route', () => {
  const unknown = catalog('custom', [{ id: 'fixture-custom', description: 'Fast' }])
  const args = { catalogs: [unknown], providers: [status('custom')], preferences: { mode: 'auto', enabledModels: [{ provider: 'custom', model: 'fixture-custom' }] } }
  assert.equal(route(args).ok, false)
  assert.equal(route({ ...args, request: { requiresImage: false } }).model, 'fixture-custom')
  assert.equal(unknown.models[0].modalitiesSource, 'unknown')
})

test('Codex legacy missing modality field follows its documented compatibility default', () => {
  const old = catalog('codex', [{ model: 'fixture-old' }])
  assert.deepEqual(old.models[0].inputModalities, ['text', 'image'])
  assert.equal(old.models[0].modalitiesSource, 'documented-legacy-default')
})

test('known additional-credit models require the user spending preference', () => {
  const credit = catalog('codex', [raw('fixture-deep', 'Most capable for complex work', { requiresUsageCredits: true })])
  const args = { catalogs: [credit], preferences: { mode: 'auto', priority: 'quality', enabledModels: [pool[2]] } }
  assert.equal(route(args).ok, false)
  const accepted = route({ ...args, preferences: { ...args.preferences, allowAdditionalSpend: true } })
  assert.equal(accepted.model, 'fixture-deep'); assert.equal(accepted.billing.additionalSpend, true)
})

test('catalog and receipts do not invent token prices or remaining allowance', () => {
  const result = route()
  assert.equal(result.billing.estimatedCost, null); assert.equal(result.billing.remainingAllowance, null)
  assert.equal(result.billing.additionalSpend, null)
  assert.match(result.billing.note, /unknown/)
  for (const model of catalogs.flatMap(item => item.models)) { assert.equal(model.price, null); assert.equal(model.remainingAllowance, null) }
})

test('Manual keeps the exact model and named Claude agent, including an explicit provider default', () => {
  const manual = route({ preferences: { mode: 'manual', provider: 'claude-code', model: 'user-pinned-model', agent: 'user-designer' } })
  assert.equal(manual.provider, 'claude-code'); assert.equal(manual.model, 'user-pinned-model'); assert.equal(manual.agent, 'user-designer'); assert.equal(manual.effort, null)
  const fallback = route({ preferences: { provider: 'codex' } })
  assert.equal(fallback.mode, 'manual'); assert.equal(fallback.model, null)
})

test('Auto respects a named Claude agent instead of silently dropping it on another provider', () => {
  const result = route({ preferences: { mode: 'auto', provider: 'claude-code', agent: 'story-editor', enabledModels: pool, priority: 'quality' } })
  assert.equal(result.provider, 'claude-code'); assert.equal(result.agent, 'story-editor'); assert.equal(result.blocked.length, 2)
})

test('only advertised effort IDs are dispatched', () => {
  const unique = catalog('codex', [raw('fixture-unique', 'Most capable', { supportedReasoningEfforts: [{ reasoningEffort: 'adaptive' }], defaultReasoningEffort: 'adaptive' })])
  const result = route({ catalogs: [unique], preferences: { mode: 'auto', priority: 'quality', enabledModels: [{ provider: 'codex', model: 'fixture-unique' }] } })
  assert.equal(result.effort, 'adaptive')
})

test('unknown fit metadata does not claim comparative speed or quality', () => {
  const unknown = catalog('codex', [raw('fixture-unknown', ''), raw('fixture-default', '', { isDefault: true })])
  const result = route({ catalogs: [unknown], preferences: { mode: 'auto', enabledModels: unknown.models.map(item => ({ provider: 'codex', model: item.id })) } })
  assert.equal(result.model, 'fixture-default'); assert.equal(result.fitEvidence.source, 'unknown')
  assert.match(result.rationale, /No exact task-fit description matched/)
  assert.match(result.scope, /no automatic mid-run fallback/)
})

test('model family names do not manufacture capabilities', () => {
  assert.equal(modelFit('').tier, 'unknown')
  const row = catalog('codex', [raw('imaginary-ultra-super-expensive', '')]).models[0]
  assert.equal(row.fit.tier, 'unknown')
  assert.equal(taskFit({ text: 'Rename this motion layer', selectionCount: 1 }).tier, 'quick')
})

test('incomplete discovery and untrusted provenance are rejected rather than partially enabled', () => {
  assert.throws(() => catalog('codex', [], { complete: false }), /complete/)
  assert.throws(() => catalog('codex', [], { source: { kind: 'marketing-page' } }), /provider-reported/)
})

test('routing input rejects control characters, CLI-flag-shaped model IDs, unknown providers and malformed pools', () => {
  for (const value of [{ model: '--dangerously-skip-permissions' }, { model: 'fixture\nother' }, { provider: 'invented' }, { mode: 'pretend' }, { provider: 'codex', agent: 'designer' }, { enabledModels: [{ provider: 'codex', model: 'valid', forgedAvailability: true }] }, { allowAdditionalSpend: 'yes' }]) assert.throws(() => validateRoutingPreferences(value))
  assert.throws(() => catalog('codex', [{ model: '--bad' }]), /invalid model ID/)
})

test('pool duplicates normalize once and decisions do not mutate their inputs', () => {
  const preferences = { mode: 'auto', enabledModels: [...pool, pool[0]] }
  const before = JSON.stringify({ catalogs, providers, preferences })
  const one = route({ preferences }), two = route({ preferences })
  assert.deepEqual(one, two); assert.equal(one.considered.length, 3)
  assert.equal(JSON.stringify({ catalogs, providers, preferences }), before)
})

test('balanced ties can prefer provider-described lower usage without asserting a price', () => {
  const rows = [raw('fixture-daily', 'Balanced everyday workhorse', { isDefault: true }), raw('fixture-efficient', 'Balanced and efficient everyday workhorse')]
  const c = catalog('codex', rows)
  const result = route({ catalogs: [c], preferences: { mode: 'auto', enabledModels: rows.map(item => ({ provider: 'codex', model: item.model })) } })
  assert.equal(result.model, 'fixture-efficient')
  assert.equal(result.billing.estimatedCost, null)
  assert.match(result.billing.note, /description explicitly supports/)
})

test('Auto excludes API and unverified custom billing until explicitly allowed', () => {
  const custom = catalog('custom', [raw('fixture-custom', 'Workhorse for everyday work')])
  const args = { catalogs: [custom], providers: [{ ...status('custom'), adapterManaged: true, billingMode: 'unknown' }], preferences: { mode: 'auto', enabledModels: [{ provider: 'custom', model: 'fixture-custom' }] } }
  const blocked = route(args)
  assert.equal(blocked.ok, false); assert.match(blocked.blocked[0].reason, /API or unverified billing/)
  const allowed = route({ ...args, preferences: { ...args.preferences, allowAPIBilling: true } })
  assert.equal(allowed.model, 'fixture-custom'); assert.equal(allowed.billing.estimatedCost, null)
})

test('spending opt-in cannot verify unknown adapter-managed authentication in Manual or Auto', () => {
  const custom = catalog('custom', [raw('fixture-custom', 'Workhorse for everyday work')])
  const providers = [{ ...status('custom'), authenticated: null, adapterManaged: true, billingMode: 'unknown' }]
  const auto = route({ catalogs: [custom], providers, preferences: { mode: 'auto', enabledModels: [{ provider: 'custom', model: 'fixture-custom' }], allowAPIBilling: true } })
  assert.equal(auto.ok, false); assert.match(auto.blocked[0].reason, /authentication or editing adapter/)
  const manual = route({ providers, preferences: { mode: 'manual', provider: 'custom', allowAPIBilling: true } })
  assert.equal(manual.ok, false)
})

test('Manual effort binds the advertised exact model and never substitutes an unavailable effort', () => {
  const args = { preferences: { mode: 'manual', provider: 'codex', model: 'fixture-fast', effort: 'low' } }
  const chosen = route(args)
  assert.equal(chosen.model, 'fixture-fast'); assert.equal(chosen.effort, 'low')
  assert.equal(route({ preferences: { ...args.preferences, effort: 'ultra' } }).ok, false)
  assert.equal(route({ ...args, now: now + CATALOG_MAX_AGE_MS + 1 }).ok, false)
  const defaults = catalog('codex', [raw('fixture-default', 'Everyday workhorse', { isDefault: true })])
  assert.equal(route({ catalogs: [defaults], preferences: { mode: 'manual', provider: 'codex', effort: 'high' } }).model, 'fixture-default')
})

test('catalog-selected Manual models fail closed on removal, stale discovery or retirement without choosing a substitute', () => {
  const preferences = { mode: 'manual', provider: 'codex', model: 'fixture-fast', catalogBound: true }
  const selected = route({ preferences })
  assert.equal(selected.ok, true); assert.equal(selected.model, 'fixture-fast'); assert.equal(selected.catalogBound, true)
  const removed = catalog('codex', [raw('new-default', 'Workhorse', { isDefault: true })])
  for (const overrides of [{ catalogs: [removed] }, { now: now + CATALOG_MAX_AGE_MS + 1 }, { catalogs: [] }, { catalogs: [catalog('codex', [raw('fixture-fast', 'Fast', { upgradeInfo: { retirementAt: Math.floor(now / 1000) - 1 } })])] }]) {
    const result = route({ preferences, ...overrides })
    assert.equal(result.ok, false); assert.match(result.reason, /fresh verified catalog/)
    assert.equal(result.model, undefined)
  }
  // A deliberate advanced raw ID is a separate, explicitly unverified choice.
  const advanced = route({ preferences: { mode: 'manual', provider: 'codex', model: 'custom-unverified-id', catalogBound: false } })
  assert.equal(advanced.model, 'custom-unverified-id')
})

test('Manual exact selection requires a binding-capable adapter while an explicit custom default remains available', () => {
  const providers = [{ ...status('custom'), modelSelectionSupported: false }]
  const unbound = route({ providers, preferences: { mode: 'manual', provider: 'custom', model: 'explicit-model' } })
  assert.equal(unbound.ok, false); assert.match(unbound.reason, /cannot bind an exact/)
  const defaults = route({ providers, preferences: { mode: 'manual', provider: 'custom' } })
  assert.equal(defaults.ok, true); assert.equal(defaults.model, null)
})
