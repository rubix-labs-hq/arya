import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { applyOps, newProject } from '../core/project.js'
import { assistantState, assistantPrompt, safeInstallURL } from '../web/ui/assistant-state.js'

test('an installed subscription CLI still needs actual authentication', () => {
  const state = assistantState({ provider: 'claude-code', configured: false, providers: [{ id: 'claude-code', available: false, installed: true, authenticated: false, canLogin: true }] })
  assert.equal(state.ready, false)
  assert.equal(state.label, 'Sign-in needed')
})

test('an unavailable provider cannot become ready from stale configured state', () => {
  const state = assistantState({ provider: 'antigravity', configured: true, providers: [{ id: 'antigravity', installed: true, authenticated: true, available: false, reason: 'Unattended permissions unavailable.' }] })
  assert.equal(state.ready, false)
  assert.equal(state.label, 'Unavailable')
  assert.equal(state.reason, 'Unattended permissions unavailable.')
})

test('an installed unauthenticated Codex CLI needs sign-in even when unavailable to run', () => {
  const state = assistantState({ provider: 'claude-code', configured: false, providers: [{ id: 'codex', available: false, installed: true, authenticated: false, canLogin: true, reason: 'Sign in with ChatGPT.' }] }, 'codex')
  assert.equal(state.ready, false)
  assert.equal(state.label, 'Sign-in needed')
  assert.equal(state.reason, 'Sign in with ChatGPT.')
})

test('previewing another provider does not inherit the active provider account', () => {
  assert.equal(assistantState({ provider: 'codex', configured: true, providers: [{ id: 'claude-code', installed: true, authenticated: false }] }, 'claude-code').ready, false)
  assert.equal(assistantState(null).label, 'Status unavailable')
})

test('a native configured provider works without a browser-only login action', () => {
  assert.equal(assistantState({ provider: 'codex', configured: true, reason: 'Paired bridge ready.' }).ready, true)
})

test('a server-configured custom adapter does not invent authenticated status', () => {
  const state = assistantState({ provider: 'custom', configured: true, providers: [{ id: 'custom', available: true, authenticated: null, reason: 'Authentication is managed by the adapter.' }] })
  assert.equal(state.ready, true)
  assert.equal(state.detail.authenticated, null)
  assert.equal(state.reason, 'Authentication is managed by the adapter.')
})

test('assistant requests carry exact selection, composition, playhead and references', () => {
  const refs = [{ kind: 'clip', id: 'c9', label: 'Selected title' }]
  assert.deepEqual(assistantPrompt('Refine this title.', { refs, selection: ['c9', 'tr:c2'], openComp: 'k3' }, 1.25), { type: 'prompt', text: 'Refine this title.', refs, ids: ['c9', 'tr:c2'], comp: 'k3', playhead: 1.25 })
  assert.equal(assistantPrompt('Review.', {}, NaN).playhead, 0)
})

test('authenticated inactive providers need explicit activation', () => {
  assert.equal(assistantState({ provider: 'claude-code', configured: true, providers: [{ id: 'codex', available: true, installed: true, authenticated: true }] }, 'codex').label, 'Signed in, not selected')
})

test('provider install links reject executable URLs and embedded credentials', () => {
  assert.equal(safeInstallURL('javascript:alert(1)'), null)
  assert.equal(safeInstallURL('https://secret@example.com/install'), null)
  assert.equal(safeInstallURL('https://example.com/install'), 'https://example.com/install')
})


test('captured form versions guard the actual store before optimistic edits', async t => {
  const previousWidth = globalThis.innerWidth
  const key = Symbol.for('reel.browser-settings.store-test')
  globalThis.innerWidth = 1440
  t.mock.method(globalThis, 'setTimeout', () => 0)
  const requests = []
  let backend = applyOps(newProject('Guarded form'), [{ op: 'add_title', text: 'Keep this title', track: 'V1', start: 0, dur: 2 }]).project
  let version = 5
  globalThis[key] = { api: async (route, body) => {
    requests.push({ route, body })
    backend = applyOps(backend, body.ops).project
    return { project: backend, version: ++version }
  } }
  const host = 'data:text/javascript;base64,' + Buffer.from("export const api = (...args) => globalThis[Symbol.for('reel.browser-settings.store-test')].api(...args); export const host = {events: () => () => {}};").toString('base64')
  // Browser module URLs need file URLs in this isolated Node test.
  let source = await readFile(new URL('../web/ui/store.js', import.meta.url), 'utf8')
  source = source.replace("from 'preact/hooks'", `from '${import.meta.resolve('preact/hooks')}'`)
    .replace("from '/core/project.js'", `from '${new URL('../core/project.js', import.meta.url).href}'`)
    .replace("from '../host.js'", `from '${host}'`)
    .replace("from './change-receipt.js'", `from '${new URL('../web/ui/change-receipt.js', import.meta.url).href}'`)
  try {
    const { edit, set, store } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
    set({ project: backend, version })
    const initial = store.project
    for (const expectedVersion of [4, 1.5, -1, Infinity, '5']) {
      assert.equal(await edit({ op: 'update', id: 'c1', set: { label: 'Wrong title' } }, 'stale form', { expectedVersion }), null)
      assert.equal(store.project, initial)
      assert.equal(store.version, 5)
      assert.equal(requests.length, 0)
    }
    await edit({ op: 'update', id: 'c1', set: { label: 'Current form' } }, 'current form', { expectedVersion: 5 })
    assert.equal(requests[0].body.expectedVersion, 5)
    assert.equal(store.version, 6)
    await edit({ op: 'update', id: 'c1', set: { label: 'Ordinary edit' } }, 'ordinary edit')
    assert.equal(Object.hasOwn(requests[1].body, 'expectedVersion'), false)
    let release
    globalThis[key].api = (route, body) => { requests.push({ route, body }); return new Promise(resolve => { release = resolve }) }
    const pending = edit({ op: 'update', id: 'c1', set: { label: 'Pending edit' } }, 'pending edit')
    const optimistic = store.project
    assert.equal(await edit({ op: 'update', id: 'c1', set: { label: 'Stale optimistic form' } }, 'pending form', { expectedVersion: store.version }), null)
    assert.equal(store.project, optimistic)
    assert.equal(requests.length, 3)
    release({ project: optimistic, version: 8 })
    await pending
  } finally {
    delete globalThis[key]
    if (previousWidth === undefined) delete globalThis.innerWidth
    else globalThis.innerWidth = previousWidth
  }
})
