import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The viewer treats a new viewProject() object as a project change and restarts playback.
// Playback start writes to the store, so an unstable composition view restarted itself forever.
globalThis.innerWidth = 1000
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'preact/hooks') return { url: 'arya-view-fixture:hooks', shortCircuit: true }
    if (specifier.startsWith('/core/')) return next(new URL(`../core/${specifier.slice(6)}`, import.meta.url).href, context)
    const url = new URL(specifier, context.parentURL ?? import.meta.url).href
    if (url.endsWith('/web/host.js')) return { url: 'arya-view-fixture:host', shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'arya-view-fixture:hooks') return { format: 'module', shortCircuit: true, source: 'export const useEffect = () => {}; export const useReducer = () => [0, () => {}]' }
    if (url === 'arya-view-fixture:host') return { format: 'module', shortCircuit: true, source: 'export const api = async () => ({}); export const host = {}' }
    return next(url, context)
  },
})
const { applyOps, newProject } = await import('../core/project.js')
const { set, store, subscribe, viewProject } = await import('../web/ui/store.js')

test('an open composition keeps one view until the project or composition changes', () => {
  const project = applyOps(newProject('Main', { fps: 30 }), [{ op: 'add_comp', name: 'Scene', duration: 5 }, { op: 'add_comp', name: 'Other', duration: 4 }]).project
  set({ project, openComp: 'k1' })
  const view = viewProject()
  assert.equal(view.compId, 'k1')
  set({ playing: true, rate: 1, viewerMode: 'timeline' })
  assert.equal(viewProject(), view, 'playback state must not look like a project change')

  set({ openComp: 'k2' })
  assert.equal(viewProject().compId, 'k2')
  set({ openComp: 'k1' })
  assert.notEqual(viewProject(), view, 'switching compositions gives a fresh view')

  const changed = applyOps(store.project, [{ op: 'range', comp: 'k1', in: 1, out: 2 }]).project
  set({ project: changed })
  assert.deepEqual(viewProject().range, { in: 1, out: 2 }, 'a project edit is visible in the view')
  set({ openComp: null })
  assert.equal(viewProject(), store.project)
})

test('a subscriber that restarts playback on view changes settles inside a composition', () => {
  set({ project: applyOps(newProject('Main', { fps: 30 }), [{ op: 'add_comp', name: 'Scene', duration: 5 }]).project, openComp: 'k1', playing: false })
  let last = viewProject(), restarts = 0
  const stop = subscribe(() => {
    const p = viewProject()
    if (p === last) return
    last = p
    if (++restarts > 5) throw new Error('playback restart loop')
    set({ playing: true, rate: 1 })
  })
  try {
    set({ playing: true, rate: 1 })
    set({ hover: 'clip' })
    assert.equal(restarts, 0)
  } finally { stop() }
})
