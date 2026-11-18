import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// The real store.js, loaded with a fake host. Its event handlers are the ones the editor runs.
const editor = process.env.ARYA_TEST_EDITOR_ROOT ? pathToFileURL(process.env.ARYA_TEST_EDITOR_ROOT + '/') : new URL('../', import.meta.url)
const key = Symbol.for('arya.store-history-events.fixture')
const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const hooks = moduleURL('export const useEffect = () => {}; export const useReducer = () => [0, () => {}]')
const host = moduleURL(`const f = () => globalThis[Symbol.for('arya.store-history-events.fixture')]
export const host = { get kind() { return f().kind }, events: handlers => { f().handlers = handlers; return () => {} } }
export const api = (...args) => f().api(...args)`)
let source = fs.readFileSync(new URL('web/ui/store.js', editor), 'utf8')
for (const [from, to] of Object.entries({ 'preact/hooks': hooks, '/core/project.js': new URL('core/project.js', editor).href, '/core/proposal-ops.js': new URL('core/proposal-ops.js', editor).href, '../host.js': host, './change-receipt.js': new URL('web/ui/change-receipt.js', editor).href })) source = source.replaceAll(`'${from}'`, JSON.stringify(to))
const fixture = globalThis[key] = { kind: 'http', handlers: null, api: async () => ({}) }
globalThis.performance ??= { now: () => 0 }
globalThis.innerWidth ??= 1440
const { store, set, connect } = await import(moduleURL(source))
const { newProject } = await import(new URL('core/project.js', editor))

const project = name => {
  const p = newProject('Store history')
  p.tracks = [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'title', start: 0, dur: 2, title: { text: name } }] }]
  return p
}

function reset(kind) {
  fixture.kind = kind
  set({ project: project('Opening card'), version: 1, root: 'browser:one', history: null, session: null, receipts: [], highlight: new Map(), toasts: [] })
  connect()
  return fixture.handlers
}

test('hello takes the undo depth and the server session', () => {
  const events = reset('http')
  events.hello({ role: 'ui', history: { undo: 3, redo: 1 }, session: { id: 'session-a', startedAt: 10 } })
  assert.deepEqual(store.history, { undo: 3, redo: 1 })
  assert.deepEqual(store.session, { id: 'session-a', startedAt: 10 })
})

test('a project event replaces the depth and attaches its notes to the receipt', () => {
  const events = reset('http')
  events.project({ project: project('Second card'), version: 2, who: 'agent', history: { undo: 4, redo: 0 }, notes: ['The title is wider than the frame.', '', 7] })
  assert.deepEqual(store.history, { undo: 4, redo: 0 })
  assert.deepEqual(store.receipts.at(-1).notes, ['The title is wider than the frame.'])
  events.project({ project: project('Third card'), version: 3, who: 'agent', history: { undo: 5, redo: 0 } })
  assert.equal(store.receipts.at(-1).notes, undefined, 'an edit without notes carries none')
})

test('in the hosted editor a new edit after Undo leaves Undo enabled even when the event has no depth', async () => {
  const events = reset('browser-local')
  // Undo back to the start: keys.js moveHistory stores the reply's depth, so nothing is left to undo.
  set({ version: 2, history: { undo: 0, redo: 1 } })
  // A later edit arrives as a project event shaped like an older browser-local snapshot, with no depth.
  events.project({ project: project('Edited card'), version: 3, root: 'browser:one', chat: [], activity: [], jobs: [], who: 'you' })
  // keys.js and the toolbar treat only a depth of exactly 0 as nothing to undo.
  assert.equal(store.history, null, 'a stale depth must not keep Undo disabled')
  assert.notEqual(store.history?.undo, 0)
})

test('Undo and Redo send nothing only when the depth is exactly 0', () => {
  const keys = fs.readFileSync(new URL('web/ui/keys.js', editor), 'utf8'), app = fs.readFileSync(new URL('web/ui/app.js', editor), 'utf8')
  assert.match(keys, /if \(store\.history\?\.\[direction\] === 0\) \{ toast\(nothing\)/)
  assert.match(app, /disabled=\$\{s\.history\?\.undo === 0\}/)
  assert.match(app, /disabled=\$\{s\.history\?\.redo === 0\}/)
})

test('a pending own edit still takes the depth from its event', () => {
  const events = reset('http')
  set({ history: { undo: 0, redo: 2 } })
  events.project({ project: project('Edited card'), version: 2, who: 'you', history: { undo: 1, redo: 0 } })
  assert.deepEqual(store.history, { undo: 1, redo: 0 })
})
