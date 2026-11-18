// Result cards drifted from the server's history, and the open composition went stale after Undo
// and Redo (round 2, B02 and B21). These drive the store through the events the server sends.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

globalThis.innerWidth = 1000
globalThis.performance ??= { now: () => 0 }
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'preact/hooks') return { url: 'arya-history-fixture:hooks', shortCircuit: true }
    if (specifier.startsWith('/core/')) return next(new URL(`../core/${specifier.slice(6)}`, import.meta.url).href, context)
    const url = new URL(specifier, context.parentURL ?? import.meta.url).href
    if (url.endsWith('/web/host.js')) return { url: 'arya-history-fixture:host', shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'arya-history-fixture:hooks') return { format: 'module', shortCircuit: true, source: 'export const useEffect = () => {}; export const useReducer = () => [0, () => {}]' }
    if (url === 'arya-history-fixture:host') return { format: 'module', shortCircuit: true, source: 'export const api = async () => ({}); export const host = { kind: "local", events: handlers => { globalThis.aryaHistoryHandlers = handlers; return () => {} } }' }
    return next(url, context)
  },
})
const { applyOps, newProject } = await import('../core/project.js')
const { compParentsIn, connect, set, stampedReceipts, store } = await import('../web/ui/store.js')

test('receipts are named for the change the server announces, once and only in its own session', () => {
  const receipts = [{ version: 3, session: 's1' }, { version: 5, session: 's1' }, { version: 5, session: 'old' }]
  const changes = [{ id: 'p1', kind: 'preview', label: 'Applied assistant preview', beforeVersion: 4, afterVersion: 5 }]
  const stamped = stampedReceipts(receipts, changes, 's1')
  assert.equal(stamped[0], receipts[0], 'outside the range')
  assert.deepEqual(stamped[1], { version: 5, session: 's1', changeId: 'p1', changeKind: 'preview', changeLabel: 'Applied assistant preview' })
  assert.equal(stamped[2], receipts[2], 'versions start again in each server session')
  // A later list, even one that no longer holds the change, leaves the name alone.
  const again = stampedReceipts(stamped, [{ id: 'r2', kind: 'request', label: 'Assistant request', beforeVersion: 0, afterVersion: 9 }], 's1')
  assert.equal(again[1], stamped[1])
  assert.equal(stampedReceipts(receipts, [], 's1'), receipts)
})

test('the store stamps receipts from project and review events in order', () => {
  connect()
  const on = globalThis.aryaHistoryHandlers
  const before = newProject('Cards')
  const after = applyOps(before, [{ op: 'add_title', track: 'V3', text: 'Sample', dur: 2 }]).project
  set({ project: before, version: 4, receipts: [], session: { id: 's1' } })
  on.project({ project: after, version: 5, who: 'agent' })
  assert.equal(store.receipts.length, 1); assert.equal(store.receipts[0].session, 's1')
  on.assistantReview({ change: { id: 'p1', kind: 'preview' }, changes: [{ id: 'p1', kind: 'preview', label: 'Applied assistant preview', beforeVersion: 4, afterVersion: 5, undone: false }] })
  assert.equal(store.receipts[0].changeKind, 'preview')
  // A later request takes the latest slot. The earlier receipt keeps its change.
  on.assistantReview({ change: { id: 'r2', kind: 'request' }, changes: [{ id: 'p1', kind: 'preview', beforeVersion: 4, afterVersion: 5, undone: false }, { id: 'r2', kind: 'request', beforeVersion: 5, afterVersion: 6, undone: false }] })
  assert.equal(store.receipts[0].changeId, 'p1')
})

test('a project without the open composition returns the editor to Main and drops stale parents', () => {
  const base = applyOps(newProject('Comps', { fps: 30 }), [{ op: 'add_comp', name: 'Outer', duration: 5 }, { op: 'add_comp', name: 'Inner', duration: 4 }]).project
  const nested = applyOps(base, [{ op: 'comp_clip', comp: 'k1', target: 'k2' }]).project
  assert.deepEqual(compParentsIn(nested, { k1: null, k2: 'k1' }), { k1: null, k2: 'k1' })
  assert.deepEqual(compParentsIn(base, { k1: null, k2: 'k1' }), { k1: null }, 'Outer no longer holds Inner')
  set({ project: nested, openComp: 'k2', compParents: { k1: null, k2: 'k1' }, selection: ['x'] })
  // Undo leaves Inner but takes it out of Outer: the breadcrumb no longer nests it.
  set({ project: base })
  assert.equal(store.openComp, 'k2'); assert.deepEqual(store.compParents, { k1: null }); assert.deepEqual(store.selection, ['x'])
  // Undo removes Inner itself: back to Main.
  const without = structuredClone(base); delete without.comps.k2
  set({ project: without })
  assert.equal(store.openComp, null); assert.deepEqual(store.selection, []); assert.deepEqual(store.compParents, { k1: null })
  // Choosing a composition without a project change is left alone.
  set({ openComp: 'k1' })
  assert.equal(store.openComp, 'k1')
})
