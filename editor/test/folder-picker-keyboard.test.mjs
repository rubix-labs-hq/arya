import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

let repo = path.dirname(fileURLToPath(import.meta.url))
while (!fs.existsSync(path.join(repo, 'editor/server.mjs'))) {
  if (repo === path.dirname(repo)) throw Error('Cannot locate the editor dependencies')
  repo = path.dirname(repo)
}
const htm = createRequire(path.join(repo, 'editor/package.json'))('htm')
const source = fs.readFileSync(new URL('../web/ui/browser.js', import.meta.url), 'utf8')
const body = source.slice(source.indexOf('function FolderPicker('), source.indexOf('\nfunction MediaTab('))
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const nodes = value => value && typeof value === 'object' ? [value, ...flatten(value.children).flatMap(nodes)] : []
const text = value => typeof value === 'object' ? flatten(value.children).map(text).join(' ').replace(/\s+/g, ' ').trim() : String(value)
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve() }

// This fixture executes the component's hooks and handlers. Real browser acceptance is separate.
function fixture({ request = async () => ({ dir: '', entries: [] }) } = {}) {
  const slots = [], notices = [], requests = []
  let index = 0, pendingLayout = [], pendingEffects = [], tree, controls = [], closed = 0
  const document = { activeElement: null }
  const opener = { isConnected: true, focus() { document.activeElement = this } }
  opener.focus()
  const dialog = {
    isConnected: true, focus() { document.activeElement = this },
    contains(element) { return element === this || controls.includes(element) },
    querySelectorAll() { return controls.filter(control => !control.props.disabled) },
    querySelector() { return this.querySelectorAll()[0] ?? null },
  }
  const useState = initial => {
    const id = index++
    slots[id] ??= { value: initial }
    return [slots[id].value, next => { slots[id].value = typeof next === 'function' ? next(slots[id].value) : next }]
  }
  const useRef = initial => { const id = index++; return (slots[id] ??= { ref: { current: initial } }).ref }
  const effect = (queue, phase) => (run, deps) => {
    const id = index++, previous = slots[id]
    if (!previous || deps.some((value, at) => !Object.is(value, previous.deps[at]))) {
      queue.push(() => { previous?.cleanup?.(); slots[id] = { deps, cleanup: run(), phase } })
    }
  }
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: flatten(children) })
  const component = new Function('html', 'useState', 'useRef', 'useLayoutEffect', 'useEffect', 'document', 'api', 'toast', 'importFolder', `${body}\nreturn FolderPicker`)(
    htm.bind(h), useState, useRef,
    (run, deps) => effect(pendingLayout, 'layout')(run, deps), (run, deps) => effect(pendingEffects, 'passive')(run, deps),
    document, route => { requests.push(route); return request(route) }, (message, kind) => notices.push({ message, kind }),
    async (paths, expectedCount) => { requests.push({ paths, expectedCount }); return { count: paths.length } },
  )
  function render() {
    index = 0; pendingLayout = []; pendingEffects = []
    tree = component({ onClose() { closed++ } })
    const all = nodes(tree), node = all.find(item => item.props.role === 'dialog')
    assert.ok(node, 'The dialog stays mounted while loading or after an error')
    node.props.ref.current = dialog
    controls.forEach(control => { control.isConnected = false })
    controls = all.filter(item => item.type === 'button').map(item => ({
      ...item, isConnected: true, hidden: false,
      focus() { document.activeElement = this }, getClientRects() { return this.hidden ? [] : [1] },
    }))
    pendingLayout.forEach(run => run())
    return tree
  }
  function key(key, shiftKey = false) {
    const event = { key, shiftKey, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
    nodes(tree).find(item => item.props.role === 'dialog').props.onKeyDown(event)
    return event
  }
  return {
    render, key, document, opener, dialog, notices, requests,
    get tree() { return tree }, get controls() { return controls }, get closed() { return closed },
    get state() { return slots.filter(slot => 'value' in slot).map(slot => slot.value) },
    flushEffects() { pendingEffects.forEach(run => run()); pendingEffects = [] },
    takeEffects() { const pending = pendingEffects; pendingEffects = []; return () => pending.forEach(run => run()) },
    unmountLayout() { slots.filter(slot => slot.phase === 'layout').forEach(slot => slot.cleanup?.()); dialog.isConnected = false },
    unmount() { slots.forEach(slot => slot.cleanup?.()); dialog.isConnected = false; controls.forEach(control => { control.isConnected = false }) },
  }
}

test('loading dialog has an accessible name, takes focus and closes with Escape', () => {
  const f = fixture({ request: () => new Promise(() => {}) }), tree = f.render()
  const all = nodes(tree), modal = all.find(node => node.props.role === 'dialog')
  assert.equal(modal.props['aria-modal'], 'true')
  assert.equal(all.find(node => node.props.id === modal.props['aria-labelledby']).type, 'h3')
  assert.equal(f.document.activeElement.props['aria-label'], 'Project folder')
  assert.ok(all.some(node => node.props.role === 'status' && text(node) === 'Loading folder…'))
  assert.equal(all.find(node => node.props.class === 'file-list').props['aria-busy'], true)
  const event = f.key('Escape')
  assert.equal(event.prevented, true); assert.equal(event.stopped, true); assert.equal(f.closed, 1)
  f.unmount()
  assert.equal(f.document.activeElement, f.opener)
})

test('Tab and Shift-Tab stay inside the loading dialog and skip disabled controls', () => {
  const f = fixture(); f.render()
  const [home, bulk, close] = f.controls
  assert.equal(bulk.props.disabled, true)
  home.focus()
  assert.equal(f.key('Tab', true).prevented, true)
  assert.equal(f.document.activeElement, close)
  assert.equal(f.key('Tab').prevented, true)
  assert.equal(f.document.activeElement, home)
  assert.equal(f.key('Tab').prevented, false, 'The browser handles interior Tab moves')
  f.dialog.focus()
  assert.equal(f.key('Tab', true).prevented, true)
  assert.equal(f.document.activeElement, close)
  f.opener.focus()
  assert.equal(f.key('Tab').prevented, true)
  assert.equal(f.document.activeElement, home)
})

test('folder and file entries are named native buttons; navigation retains dialog focus', async () => {
  const pending = deferred()
  const f = fixture({ request: () => pending.promise })
  f.render(); f.flushEffects()
  pending.resolve({ dir: '', entries: [{ dir: true, path: 'shots', name: 'shots' }, { dir: false, path: 'a.wav', name: 'a.wav' }] })
  await settle(); f.render()
  const folder = f.controls.find(node => node.props['aria-label'] === 'Open folder shots')
  const file = f.controls.find(node => node.props['aria-label'] === 'Import a.wav')
  assert.equal(folder.type, 'button'); assert.equal(folder.props.type, 'button')
  assert.equal(file.type, 'button'); assert.equal(file.props.type, 'button')
  await file.props.onClick()
  assert.deepEqual(f.requests.at(-1), { paths: ['a.wav'], expectedCount: 1 })
  assert.equal(f.closed, 0, 'Individual imports preserve the picker')
  folder.focus(); folder.props.onClick()
  assert.equal(f.document.activeElement, f.dialog)
  f.render(); f.flushEffects()
  assert.equal(f.document.activeElement, f.dialog)
  assert.equal(f.requests.at(-1), '/api/files?dir=shots')
  assert.ok(nodes(f.tree).some(node => node.props.role === 'status'))
})

test('loaded dialog excludes hidden controls and blocks editor shortcuts', async () => {
  const f = fixture(); f.render(); f.flushEffects(); await settle(); f.render()
  const home = f.controls[0], close = f.controls.at(-1)
  close.hidden = true; home.focus()
  assert.equal(f.key('Tab').prevented, true)
  assert.equal(f.document.activeElement, home)
  assert.equal(f.key(' ').stopped, true)
  assert.equal(f.key('ArrowRight').stopped, true)
  assert.equal(f.key('Delete').stopped, true)
})

test('late responses from a previous directory cannot replace the current listing', async () => {
  const first = deferred(), second = deferred(), third = deferred()
  let call = 0
  const f = fixture({ request: () => [first, second, third][call++].promise })
  f.render(); f.flushEffects()
  first.resolve({ dir: '', entries: [{ dir: true, path: 'shots', name: 'shots' }] })
  await settle(); f.render()
  f.controls.find(node => node.props['aria-label'] === 'Open folder shots').props.onClick()
  f.render(); f.flushEffects()
  f.controls.find(node => text(node) === '↑ up').props.onClick()
  f.render(); f.flushEffects()
  third.resolve({ dir: '', entries: [{ dir: false, path: 'current.wav', name: 'current.wav' }] })
  await settle(); f.render()
  second.resolve({ dir: 'shots', entries: [{ dir: false, path: 'shots/stale.wav', name: 'stale.wav' }] })
  await settle(); f.render()
  assert.ok(f.controls.some(node => node.props['aria-label'] === 'Import current.wav'))
  assert.ok(!f.controls.some(node => node.props['aria-label'] === 'Import stale.wav'))
  assert.deepEqual(f.notices, [])
})

test('fetch failure leaves an accessible closable dialog and never imports', async () => {
  const f = fixture({ request: async () => { throw Error('Folder unavailable') } })
  f.render(); f.flushEffects(); await settle(); f.render()
  assert.ok(nodes(f.tree).some(node => node.props.role === 'alert' && text(node).includes('Folder unavailable')))
  assert.equal(nodes(f.tree).find(node => node.props.class === 'file-list').props['aria-busy'], false)
  assert.equal(f.controls.find(node => text(node).startsWith('Import all')).props.disabled, true)
  assert.deepEqual(f.notices, [{ message: 'Folder unavailable', kind: 'error' }])
  assert.equal(f.closed, 0)
  f.controls.find(node => text(node) === 'Close').props.onClick()
  assert.equal(f.closed, 1)
})

test('requests settled after unmount do not update state or report a stale error', async () => {
  for (const fail of [false, true]) {
    const pending = deferred(), f = fixture({ request: () => pending.promise })
    f.render(); f.flushEffects()
    const before = f.state
    f.unmount()
    if (fail) pending.reject(Error('Stale failure'))
    else pending.resolve({ dir: '', entries: [] })
    await settle()
    assert.deepEqual(f.state, before); assert.deepEqual(f.notices, [])
  }
})

test('focus restoration skips a disconnected opener', () => {
  const f = fixture(); f.render()
  f.opener.isConnected = false
  const focused = f.document.activeElement
  f.unmount()
  assert.equal(f.document.activeElement, focused)
})

for (const fails of [false, true]) test(`navigation invalidates an old ${fails ? 'failure' : 'success'} before passive cleanup`, async () => {
  const root = deferred(), shots = deferred(), current = deferred()
  let requests = 0
  const f = fixture({ request: () => [root, shots, current][requests++].promise })
  f.render(); f.flushEffects()
  root.resolve({ dir: '', entries: [{ dir: true, path: 'shots', name: 'shots' }] })
  await settle(); f.render()
  f.controls.find(node => node.props['aria-label'] === 'Open folder shots').props.onClick()
  f.render(); f.flushEffects()
  f.controls.find(node => node.props['aria-label'] === 'Project folder').props.onClick()
  f.render()
  if (fails) shots.reject(Error('Old folder failed'))
  else shots.resolve({ dir: 'shots', entries: [{ dir: false, path: 'shots/stale.wav', name: 'stale.wav' }] })
  await settle()
  assert.equal(f.state[0], '.'); assert.equal(f.state[1], null); assert.equal(f.state[2], '')
  assert.deepEqual(f.notices, [])
})

for (const fails of [false, true]) test(`close invalidates a pending ${fails ? 'failure' : 'success'} before unmount`, async () => {
  const pending = deferred(), f = fixture({ request: () => pending.promise })
  f.render(); f.flushEffects()
  const before = f.state
  f.controls.find(node => text(node) === 'Close').props.onClick()
  assert.equal(f.closed, 1)
  if (fails) pending.reject(Error('Late closed folder failure'))
  else pending.resolve({ dir: '', entries: [{ dir: false, path: 'late.wav', name: 'late.wav' }] })
  await settle()
  assert.deepEqual(f.state, before); assert.deepEqual(f.notices, [])
  f.key('Escape')
  assert.equal(f.closed, 1, 'Close is idempotent until unmount')
})

for (const fails of [false, true]) test(`layout cleanup invalidates a pending ${fails ? 'failure' : 'success'} before passive cleanup`, async () => {
  const pending = deferred(), f = fixture({ request: () => pending.promise })
  f.render(); f.flushEffects()
  const before = f.state
  f.unmountLayout()
  assert.equal(f.document.activeElement, f.opener)
  if (fails) pending.reject(Error('Late unmounted folder failure'))
  else pending.resolve({ dir: '', entries: [] })
  await settle()
  assert.deepEqual(f.state, before); assert.deepEqual(f.notices, [])
})

test('a departed directory effect cannot start late with the next generation', async () => {
  const root = deferred()
  const f = fixture({ request: () => root.promise })
  f.render(); f.flushEffects()
  root.resolve({ dir: '', entries: [{ dir: true, path: 'shots', name: 'shots' }] })
  await settle(); f.render()
  f.controls.find(node => node.props['aria-label'] === 'Open folder shots').props.onClick()
  f.render()
  const startDepartedEffect = f.takeEffects()
  f.controls.find(node => node.props['aria-label'] === 'Project folder').props.onClick()
  f.render()
  startDepartedEffect()
  assert.deepEqual(f.requests, ['/api/files?dir=.'])
  assert.equal(f.state[1], null)
})

test('a pending effect cannot start a request after close', () => {
  const f = fixture(); f.render()
  f.key('Escape'); f.flushEffects()
  assert.deepEqual(f.requests, [])
  assert.equal(f.closed, 1)
})

test('Enter and Space preserve default button activation while stopping editor propagation', () => {
  const f = fixture(); f.render()
  for (const key of ['Enter', ' ']) {
    const event = f.key(key)
    assert.equal(event.stopped, true); assert.equal(event.prevented, false)
  }
})
