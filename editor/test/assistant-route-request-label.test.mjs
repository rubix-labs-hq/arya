import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

// Isolated copies use existing offline dependencies. Integrated tests use editor's own package.
const dependencyRoot = process.env.ARYA_OUTCOME_DEPENDENCY_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(path.join(dependencyRoot, 'package.json'))
const { h } = require('preact')
const htm = require('htm')
const { providerName } = await import(pathToFileURL(path.join(dependencyRoot, 'web/ui/assistant-state.js')))
const treeRoot = process.env.ARYA_OUTCOME_SOURCE_ROOT
const source = relative => readFileSync(treeRoot ? path.join(treeRoot, relative) : new URL(`../../${relative}`, import.meta.url), 'utf8')

const bridgeSource = source('editor/agent/browser-assistant.mjs')
const routeMarker = "          } else if (event.type === 'route') {"
const routeStart = bridgeSource.indexOf(routeMarker)
const routeEnd = bridgeSource.indexOf("          } else if (event.type === 'text') {", routeStart)
assert.ok(routeStart >= 0 && routeEnd > routeStart)
const routeBody = bridgeSource.slice(routeStart + routeMarker.length, routeEnd)
const names = bridgeSource.match(/^const names = .*$/m)?.[0]
assert.ok(names)
// Execute the actual route-event body without starting a bridge, process or network request.
const receiveRoute = new Function('event', 'run', 'publish', `${names}\n${routeBody}`)

const receiptSource = source('editor/web/ui/provider-controls.js')
const receiptStart = receiptSource.indexOf('export function RoutingReceipt(')
assert.ok(receiptStart >= 0)
const RoutingReceipt = new Function('h', 'htm', 'providerName', `const html = htm.bind(h);\n${receiptSource.slice(receiptStart).replace('export function', 'function')}\nreturn RoutingReceipt`)(h, htm, providerName)
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const children = value => flatten(value?.props?.children)
const nodes = value => value && typeof value === 'object' ? [value, ...children(value).flatMap(nodes)] : []
const text = value => children(value).map(child => typeof child === 'object' ? text(child) : child).join(' ').replace(/\s+/g, ' ').trim()

test('a browser route event reports the requested model before execution is known', () => {
  for (const [routing, label] of [
    [{ provider: 'codex', mode: 'manual', model: 'exact-id', modelName: 'Readable model' }, 'Readable model'],
    [{ provider: 'codex', mode: 'auto', model: 'exact-id', modelName: 'Readable model' }, 'Readable model'],
    [{ provider: 'codex', model: 'exact-id' }, 'exact-id'],
    [{ provider: 'claude-code', model: null }, 'Claude Code'],
  ]) {
    const run = {}, updates = []
    receiveRoute({ routing }, run, value => updates.push(value))
    assert.equal(run.routing, routing)
    assert.deepEqual(updates, [{ routing, phase: `Requested route: ${label}` }])
    assert.equal(routing.executedModel, undefined)
  }
})

test('the real Manual receipt headline calls named, exact and default models requested', () => {
  for (const [identity, label] of [[{ model: 'exact-id', modelName: 'Readable model' }, 'Readable model'], [{ model: 'exact-id' }, 'exact-id'], [{ model: null }, 'provider default']]) {
    const tree = RoutingReceipt({ value: { ok: true, mode: 'manual', provider: 'claude-code', ...identity } })
    const summary = nodes(tree).find(node => node.type === 'summary')
    assert.equal(text(summary), `Requested ${label}`)
    assert.match(text(tree), /Requested model:/)
    assert.match(text(tree), /CLI has not reported an executed model identifier/)
  }
})

test('Auto still reports its requested route choice and preserves the execution disclaimer', () => {
  const tree = RoutingReceipt({ value: { ok: true, mode: 'auto', provider: 'codex', model: 'exact-id', modelName: 'Readable model', effort: 'high', rationale: 'The enabled pool chose this request route.' } })
  assert.equal(text(nodes(tree).find(node => node.type === 'summary')), 'Auto chose Readable model · high')
  assert.match(text(tree), /Requested model: exact-id/)
  assert.match(text(tree), /CLI has not reported an executed model identifier/)
  assert.equal(RoutingReceipt({ value: { ok: false } }), null)
})

test('native route progress source labels the received route as requested', () => {
  const native = source('native/App/Shared/NativeAssistant.swift')
  const start = native.indexOf('    private func receiveRoute(')
  const end = native.indexOf('    private func recordLocalDiagnostic(', start)
  assert.ok(start >= 0 && end > start)
  const received = native.slice(start, end)
  assert.match(received, /guard activeID != nil, self\.clientID == clientID else \{ return \}/)
  assert.ok(received.includes('progress = "Requested model: \\(route.string("modelName", route.string("model", "the selected model")))"'))
  assert.ok(received.includes('updatedAt = Date(); publish()'))
})
