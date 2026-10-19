import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const editor = process.env.ARYA_SCRIPT_EDITOR ?? fileURLToPath(new URL('../', import.meta.url))
const source = fs.readFileSync(path.join(editor, 'agent/browser-assistant.mjs'), 'utf8')
const sendSource = source.slice(source.indexOf('  const send = async body =>'), source.indexOf('  const cancel = async () =>'))
const { taskFit } = await import(pathToFileURL(path.join(editor, 'core/assistant-routing.mjs')))
const { normalizeSharingEnvelope, sharingScopeForRoute, sameSharingScope } = await import(pathToFileURL(path.join(editor, 'core/assistant-sharing.mjs')))
assert.ok(sendSource.startsWith('  const send = async body =>') && sendSource.endsWith('  }\n'))

function fixture() {
  const requests = [], calls = [], states = [], state = {}, route = { ok: true, mode: 'manual', provider: 'codex', model: 'exact' }
  const owner = { endpoint: 'http://127.0.0.1:4900/', token: 'offline-fixture' }
  const scope = sharingScopeForRoute(route, owner.endpoint), sharing = { version: 1, approved: true, scope }
  const injected = { assertOpen: () => {}, failure: message => new Error(message), object: value => value && typeof value === 'object' && !Array.isArray(value),
    bounded: (value, limit, message) => { if (Buffer.byteLength(JSON.stringify(value)) > limit) throw new Error(message); return value },
    identifier: value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value),
    randomUUID, options: { getIdentity: () => 'owned-epoch', getOutline: () => ({ version: 3 }), onPrompt: (...value) => calls.push(['prompt', ...value]) },
    createToolOutcomes: () => ({}), publish: value => { states.push(value); Object.assign(state, value) },
    status: async () => { calls.push(['status']); return { configured: true } }, assertRun: () => {},
    companion: async () => { calls.push(['companion']); return owner }, catalogHost: { resolve: async (settings, request) => { calls.push(['resolve', request]); return route } },
    settings: { provider: 'codex', model: 'exact', mode: 'manual' }, sharingScopeForRoute, normalizeSharingEnvelope, sameSharingScope,
    approvedScope: () => true, credentialDigest: () => 'fixture-digest', root: '/owned/project',
    request: async (...value) => { requests.push(value); return {} }, drive: async () => {}, cancelRemote: async () => {}, cancelJobs: async () => {}, state,
    redact: value => value,
  }
  const send = new Function(...Object.keys(injected), `let active = null, sharingGeneration = 0, closed = false; ${sendSource}\nreturn send`)(...Object.values(injected))
  return { send, requests, calls, states, sharing }
}

for (const kind of [undefined, 'prompt', 'script', 'screenplay']) test(`actual service carries ${kind ?? 'default Prompt'} into companion context and host task classification`, async () => {
  const f = fixture(), body = { text: 'Rename this title', ids: ['c1', 'tr:c2'], comp: 'k1', playhead: 2, refs: [], sharing: f.sharing, ...(kind === undefined ? {} : { inputKind: kind }) }
  await f.send(body)
  assert.equal(f.requests.length, 1)
  const request = f.requests[0][3], expected = kind ?? 'prompt'
  assert.equal(request.context.inputKind, expected)
  assert.equal(f.calls.find(call => call[0] === 'resolve')[1].inputKind, expected)
  assert.deepEqual(request.context, { inputKind: expected, projectRoot: '/owned/project', projectID: 'owned-epoch', projectEpoch: 'owned-epoch', version: 3, selection: ['c1', 'tr:c2'], selectedTransitions: [{ id: 'tr:c2', clip: 'c2' }], comp: 'k1', playhead: 2, refs: [] })
  assert.equal(taskFit({ text: request.text, selectionCount: 2, inputKind: request.context.inputKind }).tier, ['script', 'screenplay'].includes(expected) ? 'deep' : 'quick')
  assert.deepEqual(request.sharing, f.sharing)
  assert.equal(request.provider, 'codex'); assert.equal(request.model, 'exact')
})

for (const kind of [null, false, 7, {}, [], '', 'Script', 'other']) test(`actual service rejects invalid kind ${JSON.stringify(kind)} before run, status, callback or request`, async () => {
  const f = fixture()
  await assert.rejects(f.send({ text: 'Title', inputKind: kind, sharing: f.sharing }), /Choose Prompt/)
  assert.deepEqual(f.states, []); assert.deepEqual(f.calls, []); assert.deepEqual(f.requests, [])
})

test('actual service retains request text and serialized byte bounds', async () => {
  for (const text of ['', ' '.repeat(3), 'x'.repeat(128001), '界'.repeat(100000)]) {
    const f = fixture(); await assert.rejects(f.send({ text, inputKind: 'script', sharing: f.sharing }))
    assert.deepEqual(f.requests, []); assert.deepEqual(f.states, [])
  }
})

test('native source validates per-request kind before admission and preserves stored native kind and absent-body behavior', () => {
  const native = fs.readFileSync(path.resolve(editor, '../native/App/Shared/NativeAssistant.swift'), 'utf8')
  const handler = native.slice(native.indexOf('    func handle(method:'), native.indexOf('    private func ', native.indexOf('    func handle(method:')))
  assert.match(handler, /if let supplied = b\["inputKind"\]/)
  assert.match(handler, /guard let value = supplied as\? String, \["prompt", "script", "screenplay"\]\.contains\(value\) else \{ throw Assistant\.Failure\.invalidPrompt \}/)
  assert.match(handler, /else \{ inputKind = nil \}/)
  assert.match(handler, /try send\(text, refs: b\["refs"\], inputKind: inputKind\)/)
  assert.ok(handler.indexOf('supplied as? String') < handler.indexOf('try send(text'))
  const send = native.slice(native.indexOf('    func send(_ text:'), native.indexOf('    private func ', native.indexOf('    func send(_ text:')))
  assert.match(send, /inputKind: String\? = nil/)
  assert.ok(send.indexOf('if let inputKind') < send.indexOf('refreshConfiguration()'))
  assert.match(send, /\("inputKind", \.string\(inputKind \?\? editor\.assistantInputKind\)\)/)
  assert.doesNotMatch(handler + send, /assistantInputKind\s*=|assistantDraft\s*=/)
  // The actual Swift enum literals and String admission predicate are extracted.
  // Node executes the predicate only; this is not Swift or hosted app execution.
  const values = JSON.parse(handler.match(/(\["prompt", "script", "screenplay"\])\.contains\(value\)/)[1])
  const admitted = value => typeof value === 'string' && values.includes(value)
  for (const value of ['prompt', 'script', 'screenplay']) assert.equal(admitted(value), true)
  for (const value of [null, false, 7, [], {}, '', 'Script', 'other']) assert.equal(admitted(value), false)
})

test('host re-resolution already consumes context inputKind; native status does not advertise its limit', () => {
  const bridge = fs.readFileSync(path.join(editor, 'agent/bridge.mjs'), 'utf8')
  assert.match(bridge, /inputKind: run\.request\.context\?\.inputKind/)
  const native = fs.readFileSync(path.resolve(editor, '../native/App/Shared/NativeAssistant.swift'), 'utf8')
  const snapshot = native.slice(native.indexOf('    var snapshot: JSON'), native.indexOf('    var claude: JSON'))
  assert.doesNotMatch(snapshot, /inputCharacterLimit/)
  assert.match(native, /text\.count <= inputCharacterLimit/)
})
