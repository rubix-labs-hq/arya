import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Execute the real store and library component against deferred, local host replies.
// Hooks retain component state without a DOM; this does not test browser geometry.
globalThis.innerWidth = 1000
let state = [], cursor = 0, apiHandler
globalThis.__aryaLibraryEntryFixture = {
  useState(initial) {
    const index = cursor++
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
  },
  api: (...args) => apiHandler(...args),
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'preact/hooks') return { url: 'arya-entry-fixture:hooks', shortCircuit: true }
    if (specifier.startsWith('/core/')) return next(new URL(`../core/${specifier.slice(6)}`, import.meta.url).href, context)
    const url = new URL(specifier, context.parentURL ?? import.meta.url).href
    if (url.endsWith('/web/host.js')) return { url: 'arya-entry-fixture:host', shortCircuit: true }
    if (url.endsWith('/web/ui/registry.js')) return { url: 'arya-entry-fixture:registry', shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'arya-entry-fixture:hooks') return { format: 'module', shortCircuit: true, source: `
      export const useState = (...args) => globalThis.__aryaLibraryEntryFixture.useState(...args)
      export const useRef = value => useState({ current: value })[0]
      export const useEffect = () => {}
      export const useReducer = () => [0, () => {}]
    ` }
    if (url === 'arya-entry-fixture:host') return { format: 'module', shortCircuit: true, source: `
      export const api = (...args) => globalThis.__aryaLibraryEntryFixture.api(...args)
      export const host = {}
    ` }
    if (url === 'arya-entry-fixture:registry') return { format: 'module', shortCircuit: true, source: `
      export const registerBrowserSection = () => {}
      export const registerBrowserTab = () => {}
      export const registerClipMenu = () => {}
      export const registerInspector = () => {}
      export const registerInspectorAction = () => {}
    ` }
    return next(url, context)
  },
})
const { applyOps, newProject } = await import('../core/project.js')
const { edit, editRecoveryStatus, hasPendingEdits, set, store, subscribe } = await import('../web/ui/store.js')
const { SaveLibrarySelection } = await import('../web/ui/plugins/library.js')
const { librarySourceStatus } = await import('../web/ui/library/model.js')

function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object') return []
  return [value, ...nodes(value.props?.children)]
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join('')
  return value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '')
}
function render() { cursor = 0; return SaveLibrarySelection({ category: 'title' }) }
function entry(tree) { return nodes(tree).find(node => node.type === 'button' && node.props.class === 'ghost reel-library-save-button') }
function sourceStatus(capture = state[1]) {
  return librarySourceStatus(store.project, capture, { root: store.root, version: store.version, selection: store.selection, composition: store.openComp })
}
function setup() {
  assert.equal(hasPendingEdits(), false)
  state = []
  const original = applyOps(newProject('Library entry'), [{ op: 'add_title', track: 'V1', start: 0, dur: 4, text: 'Original title' }]).project
  set({ project: original, version: 1, root: '/fixture/arya-project', openComp: null, selection: ['c1'], toasts: [] })
  let tree = render()
  const unsubscribe = subscribe(() => queueMicrotask(() => { tree = render() }))
  return { original, tree: () => tree, unsubscribe }
}

test('a deferred title acknowledgement blocks entry and its captured click, then uses acknowledged source data', async () => {
  const f = setup(), renderedClick = entry(f.tree()).props.onClick
  let acknowledge
  apiHandler = path => {
    assert.equal(path, '/api/ops')
    return new Promise(resolve => { acknowledge = resolve })
  }
  try {
    const pending = edit({ op: 'update', id: 'c1', set: { title: { text: 'Edited title' } } }, 'Edit title')
    await Promise.resolve()
    assert.equal(hasPendingEdits(), true)
    assert.equal(entry(f.tree()).props.disabled, true)
    assert.equal(text(entry(f.tree())), 'Saving your edit…')
    assert.ok(nodes(f.tree()).some(node => node.props?.role === 'status'))
    renderedClick()
    assert.equal(state[0], false)
    assert.equal(state[1], null)
    const acknowledgedProject = structuredClone(store.project)
    acknowledge({ project: acknowledgedProject, version: 2 })
    await pending
    await Promise.resolve()
    assert.equal(hasPendingEdits(), false)
    assert.equal(entry(f.tree()).props.disabled, false)
    entry(f.tree()).props.onClick()
    assert.equal(state[0], true)
    assert.equal(state[1].version, 2)
    assert.equal(state[1].clip.title.text, 'Edited title')
    assert.equal(sourceStatus().ok, true)
  } finally { f.unsubscribe() }
})

test('a rejected title edit re-enables entry and captures the reconciled source instead of optimistic text', async () => {
  const f = setup(), actualTimeout = globalThis.setTimeout
  const renderedClick = entry(f.tree()).props.onClick
  let rejectEdit, reconcile
  // Toast expiry is irrelevant to this queue test; avoid a six-second worker wait.
  globalThis.setTimeout = () => ({})
  apiHandler = path => {
    if (path === '/api/ops') return new Promise((resolve, reject) => { rejectEdit = reject })
    assert.equal(path, '/api/project')
    return new Promise(resolve => { reconcile = resolve })
  }
  try {
    const pending = edit({ op: 'update', id: 'c1', set: { title: { text: 'Rejected title' } } }, 'Edit title')
    await Promise.resolve()
    assert.equal(entry(f.tree()).props.disabled, true)
    rejectEdit(new Error('Fixture edit rejected'))
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(typeof reconcile, 'function')
    assert.equal(hasPendingEdits(), true)
    assert.equal(entry(f.tree()).props.disabled, true)
    assert.equal(text(entry(f.tree())), 'Saving your edit…')
    assert.equal(store.project.tracks[0].clips[0].title.text, 'Rejected title')
    renderedClick()
    assert.equal(state[0], false)
    assert.equal(state[1], null)
    reconcile({ project: f.original, version: 1 })
    assert.equal(await pending, null)
    await Promise.resolve()
    assert.equal(hasPendingEdits(), false)
    assert.equal(entry(f.tree()).props.disabled, false)
    entry(f.tree()).props.onClick()
    assert.equal(state[1].clip.title.text, 'Original title')
    assert.equal(sourceStatus().ok, true)
    assert.equal(store.toasts.at(-1).text, 'Fixture edit rejected')
  } finally { globalThis.setTimeout = actualTimeout; f.unsubscribe() }
})

test('acknowledging one of two edits keeps library entry disabled until the final reply', async () => {
  const f = setup(), replies = []
  apiHandler = path => {
    assert.equal(path, '/api/ops')
    const project = structuredClone(store.project)
    return new Promise(resolve => { replies.push({ resolve, project }) })
  }
  try {
    const first = edit({ op: 'update', id: 'c1', set: { title: { text: 'First edit' } } }, 'Edit title')
    const second = edit({ op: 'project', set: { name: 'Second edit' } }, 'Name project')
    await Promise.resolve()
    assert.equal(entry(f.tree()).props.disabled, true)
    replies[0].resolve({ project: replies[0].project, version: 2 })
    await first
    await Promise.resolve()
    assert.equal(hasPendingEdits(), true)
    assert.equal(entry(f.tree()).props.disabled, true)
    replies[1].resolve({ project: replies[1].project, version: 3 })
    await second
    await Promise.resolve()
    assert.equal(hasPendingEdits(), false)
    assert.equal(entry(f.tree()).props.disabled, false)
    entry(f.tree()).props.onClick()
    assert.equal(state[1].version, 3)
    assert.equal(state[1].clip.title.text, 'First edit')
    assert.equal(sourceStatus().ok, true)
  } finally { f.unsubscribe() }
})

test('an acknowledgement older than current state still notifies and re-enables entry', async () => {
  const f = setup()
  let acknowledge, settlementNotifications = 0
  const unsubscribe = subscribe(() => { settlementNotifications++ })
  apiHandler = path => {
    assert.equal(path, '/api/ops')
    return new Promise(resolve => { acknowledge = resolve })
  }
  try {
    const pending = edit({ op: 'update', id: 'c1', set: { title: { text: 'Local edit' } } }, 'Edit title')
    await Promise.resolve()
    assert.equal(entry(f.tree()).props.disabled, true)
    const newerProject = applyOps(f.original, [{ op: 'update', id: 'c1', set: { title: { text: 'Newer acknowledged title' } } }]).project
    set({ project: newerProject, version: 5 })
    await Promise.resolve()
    assert.equal(entry(f.tree()).props.disabled, true)
    settlementNotifications = 0
    acknowledge({ project: f.original, version: 2 })
    await pending
    await Promise.resolve()
    assert.equal(settlementNotifications, 1)
    assert.equal(hasPendingEdits(), false)
    assert.equal(entry(f.tree()).props.disabled, false)
    assert.equal(store.version, 5)
    assert.equal(store.project, newerProject)
    entry(f.tree()).props.onClick()
    assert.equal(state[1].version, 5)
    assert.equal(state[1].clip.title.text, 'Newer acknowledged title')
    assert.equal(sourceStatus().ok, true)
  } finally { unsubscribe(); f.unsubscribe() }
})

test('undo and redo version changes invalidate an open capture even when source bytes return', async () => {
  const f = setup(), calls = [], actualTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => ({})
  apiHandler = async (path, body) => { calls.push([path, body]); return { project: store.project, version: store.version + 1 } }
  try {
    entry(f.tree()).props.onClick()
    const capture = state[1], originalFingerprint = capture.fingerprint
    // Model the acknowledged snapshots returned by Undo and Redo, without server I/O.
    const changed = applyOps(store.project, [{ op: 'update', id: 'c1', set: { title: { text: 'Changed title' } } }]).project
    set({ project: changed, version: 2 })
    await Promise.resolve()
    assert.equal(sourceStatus(capture).ok, false)
    set({ project: structuredClone(f.original), version: 3 })
    await Promise.resolve()
    assert.equal(capture.fingerprint, originalFingerprint)
    assert.equal(sourceStatus(capture).ok, false)
    const form = nodes(f.tree()).find(node => node.type === 'form')
    await form.props.onSubmit({ preventDefault() {} })
    assert.equal(calls.length, 0)
    assert.equal(state[1], capture)
    assert.match(state[7], /project changed/i)
    assert.equal(await edit({ op: 'library_save', category: 'title', name: 'Stale', source: { clip: 'c1' } }, 'Stale save', { expectedVersion: capture.version }), null)
    assert.equal(calls.length, 0)
    assert.equal(store.project.library?.items?.length ?? 0, 0)
  } finally { globalThis.setTimeout = actualTimeout; f.unsubscribe() }
})


test('failed recovery keeps library entry blocked until an explicit verified retry', async () => {
  const f = setup(), actualTimeout = globalThis.setTimeout
  const renderedClick = entry(f.tree()).props.onClick
  let rejectEdit, rejectRecovery, retryReply, rejectRetry
  let projectReads = 0
  globalThis.setTimeout = () => ({})
  apiHandler = path => {
    if (path === '/api/ops') return new Promise((resolve, reject) => { rejectEdit = reject })
    assert.equal(path, '/api/project')
    projectReads++
    return projectReads === 1 ? new Promise((resolve, reject) => { rejectRecovery = reject }) : new Promise((resolve, reject) => { retryReply = resolve; rejectRetry = reject })
  }
  try {
    const pending = edit({ op: 'update', id: 'c1', set: { title: { text: 'Rejected optimistic title' } } }, 'Edit title')
    const rejected = assert.rejects(pending, /Recovery unavailable/)
    rejectEdit(new Error('Edit rejected'))
    await Promise.resolve()
    await Promise.resolve()
    rejectRecovery(new Error('Recovery unavailable'))
    await rejected
    await Promise.resolve()
    assert.equal(hasPendingEdits(), true)
    assert.equal(editRecoveryStatus().canRetry, true)
    assert.equal(entry(f.tree()).props.disabled, true)
    assert.equal(text(entry(f.tree())), 'Project sync required')
    assert.equal(store.project.tracks[0].clips[0].title.text, 'Rejected optimistic title')
    renderedClick()
    assert.equal(state[0], false)
    assert.equal(state[1], null)
    const retry = nodes(f.tree()).find(node => node.type === 'button' && text(node) === 'Retry project sync')
    assert.equal(retry.props.disabled, false)
    const syncing = retry.props.onClick()
    await Promise.resolve()
    assert.equal(editRecoveryStatus().retrying, true)
    assert.equal(entry(f.tree()).props.disabled, true)
    assert.ok(nodes(f.tree()).some(node => node.type === 'button' && text(node) === 'Syncing project…' && node.props.disabled))
    renderedClick()
    assert.equal(state[1], null)
    rejectRetry(new Error('Retry still unavailable'))
    assert.equal(await syncing, false)
    await Promise.resolve()
    assert.equal(hasPendingEdits(), true)
    assert.equal(editRecoveryStatus().canRetry, true)
    assert.match(editRecoveryStatus().reason, /Retry still unavailable/)
    assert.equal(entry(f.tree()).props.disabled, true)
    renderedClick()
    assert.equal(state[1], null)
    const retryAgain = nodes(f.tree()).find(node => node.type === 'button' && text(node) === 'Retry project sync').props.onClick()
    retryReply({ project: structuredClone(f.original), version: 1 })
    assert.equal(await retryAgain, true)
    await Promise.resolve()
    assert.equal(editRecoveryStatus(), null)
    assert.equal(hasPendingEdits(), false)
    assert.equal(entry(f.tree()).props.disabled, false)
    entry(f.tree()).props.onClick()
    assert.equal(state[1].clip.title.text, 'Original title')
    assert.equal(sourceStatus().ok, true)
  } finally { globalThis.setTimeout = actualTimeout; f.unsubscribe() }
})


test('an already open save form blocks submission while recovery is unavailable', async () => {
  const f = setup(), actualTimeout = globalThis.setTimeout, calls = []
  globalThis.setTimeout = () => ({})
  apiHandler = path => { calls.push(path); return Promise.reject(new Error(path === '/api/ops' ? 'Edit rejected' : 'Recovery unavailable')) }
  try {
    entry(f.tree()).props.onClick()
    const staleSubmit = nodes(render()).find(node => node.type === 'form').props.onSubmit
    const capture = state[1]
    await assert.rejects(edit({ op: 'project', set: { name: 'Rejected name' } }, 'Rename project'), /Recovery unavailable/)
    await Promise.resolve()
    const submit = nodes(f.tree()).find(node => node.type === 'button' && node.props.type === 'submit')
    assert.equal(submit.props.disabled, true)
    const requestCount = calls.length
    await staleSubmit({ preventDefault() {} })
    assert.equal(calls.length, requestCount)
    assert.equal(state[1], capture)
    assert.match(state[7], /Project sync failed/)
    apiHandler = async path => { assert.equal(path, '/api/project'); return { project: f.original, version: 1 } }
    assert.equal(await nodes(render()).find(node => node.type === 'button' && text(node) === 'Retry project sync').props.onClick(), true)
  } finally { globalThis.setTimeout = actualTimeout; f.unsubscribe() }
})

test('retry cannot replace a different project opened while sync is deferred', async () => {
  const f = setup(), actualTimeout = globalThis.setTimeout
  let retryReply, projectReads = 0
  globalThis.setTimeout = () => ({})
  apiHandler = path => {
    if (path === '/api/ops') return Promise.reject(new Error('Edit rejected'))
    assert.equal(path, '/api/project')
    return ++projectReads === 1 ? Promise.reject(new Error('Recovery unavailable')) : new Promise(resolve => { retryReply = resolve })
  }
  try {
    await assert.rejects(edit({ op: 'update', id: 'c1', set: { title: { text: 'Rejected title' } } }, 'Edit title'), /Recovery unavailable/)
    await Promise.resolve()
    const retry = nodes(f.tree()).find(node => node.type === 'button' && text(node) === 'Retry project sync')
    const syncing = retry.props.onClick()
    const other = applyOps(newProject('Other project'), [{ op: 'add_title', track: 'V1', start: 0, dur: 4, text: 'Other title' }]).project
    set({ root: '/fixture/other-project', project: other, version: 9 })
    retryReply({ project: f.original, version: 1 })
    assert.equal(await syncing, false)
    await Promise.resolve()
    assert.equal(store.root, '/fixture/other-project')
    assert.equal(store.version, 9)
    assert.equal(store.project, other)
    assert.equal(editRecoveryStatus(), null)
    assert.equal(hasPendingEdits(), false)
  } finally { globalThis.setTimeout = actualTimeout; f.unsubscribe() }
})
