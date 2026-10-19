import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const editor = process.env.ARYA_COMPACT_EDITOR_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const candidate = process.env.ARYA_COMPACT_CANDIDATE_ROOT ?? editor
const require = createRequire(path.join(editor, 'package.json'))
const { h } = require('preact'), htm = require('htm')
const { Icon } = await import(pathToFileURL(path.join(candidate, 'web/ui/icons.js')))
const appSource = fs.readFileSync(path.join(candidate, 'web/ui/app.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
const phoneSource = fs.readFileSync(path.join(candidate, 'web/ui/phone.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
const layoutSource = fs.readFileSync(path.join(candidate, 'web/ui/layout.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
const { newProject, duration, timecode, applyOps, TITLE_ANIMS } = await import(pathToFileURL(path.join(editor, 'core/project.js')))
const { openProjectRecovery } = await import(pathToFileURL(path.join(editor, 'web/ui/project-recovery.js')))
const settingsSource = fs.readFileSync(path.join(editor, 'web/ui/settings.js'), 'utf8')
const settingsFocusEffects = settingsSource.match(/  useEffect\(\(\) => \{\n    const previous = document\.activeElement\n[\s\S]*?\n  \}, \[\]\)/g)
assert.equal(settingsFocusEffects?.length, 1, 'Use the exact current Settings opener capture and restoration effect')
const copy = value => structuredClone(value)
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : []
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : String(tree ?? '')
const cls = (node, name) => String(node.props?.class ?? '').split(/\s+/).includes(name)
const defaults = { media: 310, inspector: 340, chat: 370, upper: 61, showMedia: true, showInspector: true, showTimeline: true, mediaSide: 'right' }

// Actual shell/layout functions and Preact VNodes. DOM sizing and focus are owned fixtures;
// CSS geometry, mounted child behavior and real browser input remain Root acceptance.
function fixture(t, { saved = defaults, width = 1200, focusDocument = null, openRecovery = () => {}, onSettingsOpen = () => {}, viewportWidth = 1200, viewportHeight = 900, requestOverride } = {}) {
  let persisted = copy(saved), active, index = 0, focusCount = 0
  const groups = new Map(), pending = [], writes = [], mutations = [], requests = [], observers = [], cleanups = []
  const state = { project: newProject('A long project name that must remain accessible'), version: 7, page: 'edit', selection: ['c1'], openComp: null,
    selMarker: null, viewerMode: 'source', source: { src: 'owned.png', in: 1, out: 3 }, tool: 'm-pen', scroll: 51, zoom: 32,
    jobs: [], chatOpen: false, claude: { state: 'idle' }, refs: [], connected: true, showKeys: false, settingsOpen: false, assistantSharingReviewOpen: false }
  state.project.tracks[0].clips.push({ id: 'c1', kind: 'title', start: 0, dur: 2, title: { text: 'Ferry title\nSecond line' } })
  state.project.comps = { nested: { tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'nested-title', kind: 'title', title: { text: 'Nested title' }, start: 0, dur: 2 }] }], markers: [], fps: 30 } }
  const element = { clientWidth: width }
  const queries = new Map(), documentListeners = new Map()
  const document = focusDocument ?? { activeElement: null }
  document.addEventListener ??= (type, fn) => { if (!documentListeners.has(type)) documentListeners.set(type, new Set()); documentListeners.get(type).add(fn) }
  document.removeEventListener ??= (type, fn) => documentListeners.get(type)?.delete(fn)
  const matchMedia = query => {
    if (!queries.has(query)) queries.set(query, { listeners: new Set(), get matches() { return query.startsWith('(max-width:') ? viewportWidth <= 720 || (viewportHeight <= 500 && viewportWidth <= 1000) : viewportHeight <= 600 && viewportHeight >= viewportWidth }, addEventListener(_type, fn) { this.listeners.add(fn) }, removeEventListener(_type, fn) { this.listeners.delete(fn) } })
    return queries.get(query)
  }
  const moreTrigger = focusDocument?.createElement('button') ?? {}
  if (focusDocument) focusDocument.body.append(moreTrigger)
  moreTrigger.getClientRects = () => element.clientWidth <= 720 ? [{}] : []
  const focusTrigger = moreTrigger.focus?.bind(moreTrigger)
  moreTrigger.focus = () => { focusCount++; focusTrigger?.() }
  const useState = initial => {
    const at = index++; if (!active[at]) active[at] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = active[at]; return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
  }
  const useReducer = (reduce, initial) => { const [value, setValue] = useState(initial); return [value, action => setValue(old => reduce(old, action))] }
  const useRef = initial => { const at = index++; return (active[at] ??= { ref: { current: initial } }).ref }
  const useEffect = (run, dependencies) => {
    const at = index++, old = active[at]
    if (old && dependencies.every((value, i) => Object.is(value, old.dependencies[i]))) return
    const slots = active; pending.push(() => { old?.cleanup?.(); const cleanup = run(); slots[at] = { dependencies, cleanup }; if (cleanup) cleanups.push(cleanup) })
  }
  class ResizeObserver {
    constructor(run) { this.run = run; this.connected = false; observers.push(this) }
    observe(target) { assert.equal(target, element); this.connected = true }
    disconnect() { this.connected = false }
  }
  const localStorage = { getItem: () => JSON.stringify(persisted), setItem: (_key, value) => { persisted = JSON.parse(value); writes.push(copy(persisted)) } }
  const layout = new Function('deps', `const { h, htm, useState, useReducer, useRef, useEffect, ResizeObserver, localStorage } = deps;\n${layoutSource}\nreturn { useLayout, useCompactEditPanel, useWorkspaceWidth, editPaneSizes, editGridColumns, Divider, LayoutMenu, revealInspector };`)(
    { h, htm, useState, useReducer, useRef, useEffect, ResizeObserver, localStorage })
  const components = Object.fromEntries(['Browser', 'Inspector', 'Viewer', 'Timeline', 'Toolbar', 'ScrollTabs'].map(name => [name, function component() {}]))
  const set = patch => { mutations.push(copy(patch)); Object.assign(state, patch); if (patch.settingsOpen === true) onSettingsOpen() }
  const api = async (route, body) => { requests.push({ route, body }); if (requestOverride) return requestOverride(route, body, state); return route === '/api/recovery' ? { protocol: 1, version: state.version, observed: { status: 'valid', writable: true }, snapshots: [] } : { project: state.project, version: state.version + 1 } }
  const registry = { pages: [{ id: 'motion', label: 'Motion', order: 30, key: '⇧3', component: () => null }] }
  const phone = new Function('deps', `const { h, htm, useState, useRef, useEffect, matchMedia, useStore, viewProject } = deps;\n${phoneSource}\nreturn { PhonePanelControls, usePhoneLayout, compactPanelToPhone, phonePanelToCompact };`)(
    { h, htm, useState, useRef, useEffect, matchMedia, useStore: () => state, viewProject: () => state.openComp == null ? state.project : state.project.comps[state.openComp] })
  const app = new Function('deps', `const { Icon, h, htm, useState, useRef, useEffect, matchMedia, document, PhonePanelControls, usePhoneLayout, compactPanelToPhone, phonePanelToCompact, useStore, store, set, api, duration, timecode, registry, host, openProjectRecovery, useLayout, useCompactEditPanel, useWorkspaceWidth, editPaneSizes, editGridColumns, Divider, LayoutMenu, Browser, Inspector, Viewer, Timeline, Toolbar, ScrollTabs } = deps;\n${appSource}\nreturn { TopBar, EditPage };`)(
    { Icon, h, htm, useState, useRef, useEffect, matchMedia, document, ...phone, useStore: () => state, store: state, set, api, duration, timecode, registry, host: { kind: 'http' }, openProjectRecovery: openRecovery, ...layout, ...components })
  function render(name) {
    if (!groups.has(name)) groups.set(name, [])
    active = groups.get(name); index = 0
    const tree = (app[name] ?? layout[name])()
    if (name === 'EditPage') nodes(tree).find(node => node.props?.id === 'edit-upper').ref.current = element
    if (name === 'TopBar') nodes(tree).find(node => node.props?.['aria-controls'] === 'editor-action-list' && node.type === 'button').ref.current = moreTrigger
    pending.splice(0).forEach(run => run())
    return tree
  }
  const edit = () => { render('EditPage'); return render('EditPage') }
  const top = () => render('TopBar')
  const resize = value => { element.clientWidth = value; observers.filter(observer => observer.connected).forEach(observer => observer.run()); return edit() }
  const pick = label => { const node = nodes(edit()).find(node => node.type === 'button' && text(node) === label); assert(node, label); node.props.onClick(); return edit() }
  const button = label => { const node = nodes(top()).find(node => node.type === 'button' && (node.props['aria-label'] === label || node.props['aria-label']?.startsWith(label + ', ') || text(node) === label)); assert(node, label); return node }
  t.after(() => cleanups.forEach(run => run()))
  const viewport = (w, h) => { viewportWidth = w; viewportHeight = h; for (const query of queries.values()) for (const listener of [...query.listeners]) listener(); return edit() }
  const controls = () => {
    const props = nodes(edit()).find(n => n.type === phone.PhonePanelControls).props
    active = groups.get('PhonePanelControls') ?? []; groups.set('PhonePanelControls', active); index = 0
    return phone.PhonePanelControls(props)
  }
  const phonePick = label => { const n = nodes(controls()).find(n => n.type === 'button' && text(n) === label); assert(n, label); n.props.onClick(); return edit() }
  const focusInspector = () => { document.activeElement = { closest: selector => selector === '.edit-inspector-pane' ? {} : null }; for (const listener of documentListeners.get('focusin') ?? []) listener(); return edit() }
  return { viewport, controls, phonePick, focusInspector, document, phone, state, writes, mutations, requests, layout, components, edit, top, menu: () => render('LayoutMenu'), resize, pick, button, persisted: () => persisted, focusCount: () => focusCount, moreTrigger }
}
const upper = tree => nodes(tree).find(node => node.props?.id === 'edit-upper')
const componentCount = (tree, type) => nodes(tree).filter(node => node.type === type).length
const actionGroup = tree => nodes(tree).find(node => cls(node, 'topbar-action-tools'))
const actionList = tree => nodes(tree).find(node => node.props?.id === 'editor-action-list')

test('desktop keeps saved side order, widths, timeline and a single viewer', t => {
  const f = fixture(t), tree = f.edit()
  assert.equal(upper(tree).props.style.gridTemplateColumns, '340px 6px minmax(160px, 1fr) 6px 310px')
  assert.equal(cls(tree, 'compact-edit'), false)
  const children = upper(tree).props.children.flat(Infinity).filter(Boolean)
  assert.equal(nodes(tree).find(n => n.props?.id === 'edit-panel-inspector').props.style.gridColumn, 1); assert.equal(nodes(tree).find(n => n.props?.id === 'edit-panel-media').props.style.gridColumn, 5)
  assert.equal(componentCount(tree, f.components.Viewer), 1); assert.equal(componentCount(tree, f.components.Timeline), 1)
  assert.deepEqual(f.persisted(), defaults); assert.deepEqual(f.writes, [])
})
for (const width of [320, 378, 600, 719, 748, 899]) test(`compact Edit at ${width} gives each existing panel the full upper area`, t => {
  const f = fixture(t, { width }), before = copy(f.state)
  const initial = f.edit(); assert.equal(cls(initial, 'compact-edit'), true); assert.equal(upper(initial).props.style.gridTemplateColumns, 'minmax(0, 1fr)')
  for (const [label, id] of [['Viewer', 'viewer'], ['Media', 'media'], ['Inspector', 'inspector'], ['Viewer', 'viewer']]) {
    const tree = f.pick(label); assert.equal(tree.props['data-compact-panel'], id)
    for (const type of [f.components.Viewer, f.components.Browser, f.components.Inspector, f.components.Timeline]) assert.equal(componentCount(tree, type), 1)
    const controls = nodes(tree).filter(node => node.type === 'button' && node.props['aria-controls'] === 'edit-upper')
    assert.equal(controls.length, 3); assert.deepEqual(controls.filter(node => node.props['aria-pressed']).map(text), [label])
    assert.equal(nodes(tree).find(node => node.type === f.components.Viewer).key, 'viewer')
  }
  assert.deepEqual(f.state, before); assert.deepEqual(f.writes, []); assert.deepEqual(f.mutations, []); assert.deepEqual(f.requests, [])
})
test('compact access overrides hidden desktop panels without changing their saved visibility', t => {
  const saved = { ...defaults, showMedia: false, showInspector: false, showTimeline: false }, f = fixture(t, { saved })
  const wide = f.edit(); assert.equal(componentCount(wide, f.components.Browser), 1); assert.equal(componentCount(wide, f.components.Inspector), 1); assert.equal(componentCount(wide, f.components.Timeline), 1); for (const id of ['media', 'inspector', 'timeline']) assert.equal(nodes(wide).find(n => n.props?.id === `edit-panel-${id}`).props.hidden, true)
  f.resize(378); f.pick('Media'); const compact = f.pick('Inspector')
  assert.equal(componentCount(compact, f.components.Browser), 1); assert.equal(componentCount(compact, f.components.Inspector), 1); assert.equal(componentCount(compact, f.components.Timeline), 1)
  const restored = f.resize(1200)
  assert.equal(componentCount(restored, f.components.Browser), 1); assert.equal(componentCount(restored, f.components.Inspector), 1); assert.equal(componentCount(restored, f.components.Timeline), 1); for (const id of ['media', 'inspector', 'timeline']) assert.equal(nodes(restored).find(n => n.props?.id === `edit-panel-${id}`).props.hidden, true)
  assert.equal(upper(restored).props.style.gridTemplateColumns, 'minmax(160px, 1fr)'); assert.deepEqual(f.persisted(), saved); assert.deepEqual(f.writes, [])
})
test('resizing back restores custom desktop dimensions and keeps the chosen compact panel', t => {
  const f = fixture(t), first = f.edit(), before = copy(f.state)
  f.resize(390); f.pick('Inspector'); const restored = f.resize(1200)
  assert.equal(upper(restored).props.style.gridTemplateColumns, upper(first).props.style.gridTemplateColumns)
  assert.equal(f.resize(390).props['data-compact-panel'], 'inspector'); assert.deepEqual(f.state, before); assert.deepEqual(f.writes, [])
})
test('the compact threshold uses workspace width and leaves width 900 in desktop mode', t => {
  const f = fixture(t, { width: 900 }); assert.equal(cls(f.edit(), 'compact-edit'), false)
  assert.equal(cls(f.resize(899), 'compact-edit'), true); assert.equal(cls(f.resize(900), 'compact-edit'), false)
  assert.deepEqual(f.writes, [])
})
test('a focused Inspector field stays shown when the workspace becomes compact', t => {
  const f = fixture(t, { width: 1200 }), pane = (tree, id) => nodes(tree).find(node => node.props?.id === id)
  assert.equal(cls(f.edit(), 'compact-edit'), false)
  f.document.activeElement = { closest: selector => selector === '.edit-inspector-pane' ? {} : null }
  const narrowed = f.resize(880)
  assert.equal(cls(narrowed, 'compact-edit'), true)
  assert.equal(pane(narrowed, 'edit-panel-inspector').props.hidden, false, 'the focused Inspector is not hidden')
  assert.equal(pane(narrowed, 'edit-viewer').props.hidden, true)
  assert.equal(narrowed.props['data-compact-panel'], 'inspector', 'the choice is recorded for later renders')
  f.document.activeElement = null
  const viewer = f.pick('Viewer')
  assert.equal(pane(viewer, 'edit-viewer').props.hidden, false, 'an explicit pick still switches')
  assert.equal(pane(viewer, 'edit-panel-inspector').props.hidden, true)
  assert.deepEqual(f.writes, [])
})
test('after the compact transition an explicit pick wins even while Inspector focus remains', t => {
  const f = fixture(t, { width: 1200 }), pane = (tree, id) => nodes(tree).find(node => node.props?.id === id)
  assert.equal(cls(f.edit(), 'compact-edit'), false)
  f.document.activeElement = { closest: selector => selector === '.edit-inspector-pane' ? {} : null }
  assert.equal(f.resize(880).props['data-compact-panel'], 'inspector')
  // Keyboard or assistive activation can choose a panel without moving DOM focus.
  const viewer = f.pick('Viewer')
  assert.equal(pane(viewer, 'edit-viewer').props.hidden, false)
  assert.equal(pane(viewer, 'edit-panel-inspector').props.hidden, true)
  assert.equal(f.edit().props['data-compact-panel'], 'viewer', 'the choice survives later renders')
})
test('without Inspector focus the compact workspace keeps its chosen panel', t => {
  const f = fixture(t, { width: 1200 }), pane = (tree, id) => nodes(tree).find(node => node.props?.id === id)
  f.document.activeElement = { closest: () => null }
  const narrowed = f.resize(880)
  assert.equal(narrowed.props['data-compact-panel'], 'viewer')
  assert.equal(pane(narrowed, 'edit-viewer').props.hidden, false)
  assert.equal(pane(narrowed, 'edit-panel-inspector').props.hidden, true)
})
test('the existing processing action can reveal the compact Inspector', t => {
  const f = fixture(t, { width: 390, saved: { ...defaults, showInspector: false } }); f.pick('Media'); const before = copy(f.state)
  f.layout.revealInspector(); const tree = f.edit()
  assert.equal(tree.props['data-compact-panel'], 'inspector'); assert.equal(componentCount(tree, f.components.Inspector), 1)
  assert.deepEqual(f.persisted(), { ...defaults, showInspector: true }); assert.equal(f.writes.length, 1); assert.deepEqual(f.state, before)
})
test('selection context follows the current composition without editing the selected title', t => {
  const f = fixture(t, { width: 390 })
  assert.equal(text(nodes(f.edit()).find(node => cls(node, 'compact-edit-selection'))), 'Ferry title')
  f.state.openComp = 'nested'; f.state.selection = ['nested-title']; const before = copy(f.state)
  assert.equal(text(nodes(f.edit()).find(node => cls(node, 'compact-edit-selection'))), 'Nested title')
  f.pick('Inspector'); f.pick('Viewer'); assert.deepEqual(f.state, before)
})
test('More exposes existing actions and keeps the project name available', t => {
  const f = fixture(t), tree = f.top(), button = f.button('Editor actions')
  assert.equal(button.props['aria-expanded'], false); assert.equal(nodes(tree).find(node => cls(node, 'proj')).props.title, f.state.project.name)
  button.props.onClick(); assert.equal(f.button('Editor actions').props['aria-expanded'], true)
  const list = actionList(f.top()); assert.equal(cls(list, 'open'), true)
  for (const label of ['Recovery', 'Undo', 'Redo', 'Keyboard shortcuts', 'Settings', 'Close actions']) assert(nodes(list).some(node => node.type === 'button' && (node.props['aria-label'] === label || node.props['aria-label']?.startsWith(label + ', ') || text(node) === label)), label)
  assert.equal(nodes(list).filter(node => node.type === f.layout.LayoutMenu).length, 1)
  assert.deepEqual(f.requests, []); assert.deepEqual(f.mutations, [])
})
test('Escape closes More and restores its trigger while other keys keep native behavior', t => {
  const f = fixture(t, { width: 390 }); f.button('Editor actions').props.onClick(); let prevented = 0, stopped = 0
  const event = key => ({ key, preventDefault: () => prevented++, stopPropagation: () => stopped++ })
  actionGroup(f.top()).props.onKeyDown(event(' ')); assert.equal(prevented, 0); assert.equal(f.button('Editor actions').props['aria-expanded'], true)
  actionGroup(f.top()).props.onKeyDown(event('Escape')); assert.equal(prevented, 1); assert.equal(stopped, 1); assert.equal(f.focusCount(), 1); assert.equal(f.button('Editor actions').props['aria-expanded'], false)
  actionGroup(f.top()).props.onKeyDown(event('Escape')); assert.equal(prevented, 1)
})
test('focus within More keeps it open; leaving closes it without stealing focus', t => {
  const f = fixture(t, { width: 390 }); f.button('Editor actions').props.onClick()
  actionGroup(f.top()).props.onFocusOut({ currentTarget: { contains: () => true }, relatedTarget: {} }); assert.equal(f.button('Editor actions').props['aria-expanded'], true)
  actionGroup(f.top()).props.onFocusOut({ currentTarget: { contains: () => false }, relatedTarget: {} }); assert.equal(f.button('Editor actions').props['aria-expanded'], false); assert.equal(f.focusCount(), 0)
  f.button('Editor actions').props.onClick(); f.button('Close actions').props.onClick(); assert.equal(f.focusCount(), 1); assert.equal(f.button('Editor actions').props['aria-expanded'], false)
})
test('Undo and Redo retain the existing API and project update behavior', async t => {
  const f = fixture(t); await f.button('Undo').props.onClick(); await f.button('Redo').props.onClick()
  assert.deepEqual(f.requests.map(call => call.route), ['/api/undo', '/api/redo']); assert.equal(f.state.version, 9); assert.deepEqual(f.state.selection, ['c1'])
})
test('Settings and recovery still respect sharing review ownership', t => {
  const f = fixture(t); f.state.assistantSharingReviewOpen = true
  assert.equal(f.button('Settings').props.disabled, true); assert.equal(f.button('Recovery').props.disabled, true)
  f.button('Settings').props.onClick(); assert.equal(f.state.settingsOpen, false)
  f.state.assistantSharingReviewOpen = false; f.button('Settings').props.onClick(); assert.equal(f.state.settingsOpen, true)
})
test('queued delivery progress stays visible on More and routes through the existing action', t => {
  const f = fixture(t); f.state.jobs = [{ state: 'queued', progress: 0.12 }]
  assert.equal(text(f.button('Editor actions')), 'More 12%'); assert.equal(f.button('Editor actions').props['aria-label'], 'Editor actions, delivery 12%'); f.button('Open delivery progress').props.onClick(); assert.equal(f.state.page, 'deliver')
})
test('Assistant and keyboard controls keep their existing state transitions', t => {
  const f = fixture(t), before = copy(f.state.project)
  const assistant = nodes(f.top()).find(node => node.type === 'button' && cls(node, 'claude-btn')); assistant.props.onClick()
  assert.equal(f.state.chatOpen, true); f.button('Keyboard shortcuts').props.onClick(); assert.equal(f.state.showKeys, true)
  assert.deepEqual(f.state.project, before); assert.deepEqual(f.state.selection, ['c1']); assert.deepEqual(f.requests, [])
})
test('workflow selection preserves the registered Motion page and current edit context', t => {
  const f = fixture(t), tree = f.top(), tabs = nodes(tree).find(node => node.type === f.components.ScrollTabs), before = copy(f.state)
  assert.deepEqual(tabs.props.tabs.map(row => row[0]), ['media', 'edit', 'motion', 'color', 'audio', 'deliver'])
  tabs.props.onChange('motion'); assert.deepEqual(f.state, { ...before, page: 'motion' })
  assert.deepEqual(f.requests, []); assert.deepEqual(f.writes, [])
})

test('compact Layout explains and saves wide-screen visibility without hiding compact access', t => {
  const f = fixture(t, { width: 390 }), before = copy(f.state)
  nodes(f.menu()).find(node => node.type === 'button' && node.props['aria-label'] === 'Customize workspace').props.onClick()
  const menu = f.menu(); assert.match(text(menu), /layout settings below apply to wider workspaces/)
  const media = nodes(menu).find(node => node.type === 'label' && text(node).trim() === 'Media bin')
  nodes(media).find(node => node.type === 'input').props.onChange({ target: { checked: false } })
  assert.equal(f.persisted().showMedia, false); assert.equal(componentCount(f.pick('Media'), f.components.Browser), 1)
  const restored = f.resize(1200); assert.equal(componentCount(restored, f.components.Browser), 1); assert.equal(pane(restored, 'media').props.hidden, true); assert.deepEqual(f.state, before)
})

// The existing Recovery DOM fixture pattern, with hidden-opener focus refusal.
class FocusElement {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.handlers = {}; this.disabled = false; this.visible = () => true; this._text = '' }
  set textContent(value) { this._text = String(value); this.replaceChildren() }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child) } }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null }
  setAttribute() {}
  addEventListener(name, run) { (this.handlers[name] ??= []).push(run) }
  focus() { if (!this.disabled && this.visible() && this.isConnected) this.ownerDocument.activeElement = this }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parent?.isConnected) }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector.split(',').includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
}
function focusDocument() {
  const document = { createElement: tag => new FocusElement(tag, document) }
  document.body = document.createElement('body'); document.activeElement = document.body
  return document
}
function modalFixture(t) {
  const document = focusDocument(), settingsPanel = document.createElement('div'), firstSettingsButton = document.createElement('button')
  settingsPanel.append(firstSettingsButton)
  let settingsCleanup, settingsCaptured, recoveryCaptured, recoveryDialog, settingsRefreshes = 0
  const mounted = { current: true }
  const f = fixture(t, { width: 390, focusDocument: document,
    onSettingsOpen() {
      settingsCaptured = document.activeElement; document.body.append(settingsPanel)
      new Function('document', 'dialog', 'mounted', 'refreshAssistantStatus', 'useEffect', settingsFocusEffects[0])(
        document, { current: settingsPanel }, mounted, () => { settingsRefreshes++; return Promise.resolve() }, effect => { settingsCleanup = effect() })
    },
    openRecovery(options) { recoveryCaptured = document.activeElement; recoveryDialog = openProjectRecovery({ document, ...options }); return recoveryDialog },
  })
  const originalTrigger = document.createElement('button'); document.body.append(originalTrigger)
  originalTrigger.visible = () => !f.moreTrigger.getClientRects().length || f.button('Editor actions').props['aria-expanded']
  t.after(() => { settingsCleanup?.(); if (recoveryDialog && !recoveryDialog.controller.state.busy) recoveryDialog.close() })
  const enter = action => { originalTrigger.focus(); const value = f.button(action).props.onClick(); actionGroup(f.top()).props.onFocusOut({ currentTarget: { contains: () => false }, relatedTarget: document.activeElement }); return value }
  const close = action => {
    if (action === 'Recovery') { const closed = recoveryDialog.close(); if (closed) recoveryDialog = null; return closed }
    assert.equal(typeof settingsCleanup, 'function'); settingsCleanup(); settingsCleanup = null; settingsPanel.remove(); return true
  }
  return { f, document, originalTrigger, enter, close, mounted, captured: action => action === 'Recovery' ? recoveryCaptured : settingsCaptured, settingsRefreshes: () => settingsRefreshes }
}

for (const action of ['Settings', 'Recovery']) test(`${action} opened from compact More restores the visible More trigger`, async t => {
  const m = modalFixture(t), { f, document } = m
  f.button('Editor actions').props.onClick(); m.enter(action)
  assert.equal(m.captured(action), f.moreTrigger, 'The actual modal capture must occur after the visible-trigger handoff')
  assert.notEqual(document.activeElement, f.moreTrigger, 'The actual modal must receive focus')
  assert.equal(f.button('Editor actions').props['aria-expanded'], false); assert.equal(m.originalTrigger.visible(), false)
  await Promise.resolve()
  assert.equal(m.close(action), true); assert.equal(document.activeElement, f.moreTrigger); assert.equal(f.moreTrigger.getClientRects().length, 1)
  if (action === 'Settings') { assert.equal(m.mounted.current, false); assert.equal(m.settingsRefreshes(), 1) }
  else assert.deepEqual(f.requests.map(call => call.route), ['/api/recovery'])
})
for (const action of ['Settings', 'Recovery']) test(`${action} on desktop keeps its original visible opener after resizing out of More`, async t => {
  const m = modalFixture(t), { f, document } = m
  f.button('Editor actions').props.onClick(); f.resize(1200); m.enter(action)
  assert.equal(f.moreTrigger.getClientRects().length, 0); assert.equal(m.captured(action), m.originalTrigger); assert.equal(f.focusCount(), 0)
  await Promise.resolve()
  assert.equal(m.close(action), true); assert.equal(document.activeElement, m.originalTrigger); assert.equal(m.originalTrigger.visible(), true); assert.equal(f.focusCount(), 0)
})
test('stale modal actions do not move focus or open a dialog during sharing review', t => {
  const m = modalFixture(t), { f, document } = m
  f.button('Editor actions').props.onClick()
  const staleSettings = f.button('Settings').props.onClick, staleRecovery = f.button('Recovery').props.onClick
  m.originalTrigger.focus(); f.state.assistantSharingReviewOpen = true
  staleSettings(); staleRecovery()
  assert.equal(document.activeElement, m.originalTrigger); assert.equal(f.focusCount(), 0)
  assert.equal(f.button('Editor actions').props['aria-expanded'], true); assert.equal(f.state.settingsOpen, false)
  assert.equal(m.captured('Settings'), undefined); assert.equal(m.captured('Recovery'), undefined); assert.deepEqual(f.requests, []); assert.deepEqual(f.mutations, [])
})

test('Escape after resizing More to desktop keeps focus on the visible desktop action', t => {
  const m = modalFixture(t), { f, document } = m
  f.button('Editor actions').props.onClick(); f.resize(1200); m.originalTrigger.focus()
  let prevented = 0, stopped = 0
  actionGroup(f.top()).props.onKeyDown({ key: 'Escape', preventDefault: () => prevented++, stopPropagation: () => stopped++ })
  assert.equal(prevented, 1); assert.equal(stopped, 1); assert.equal(f.button('Editor actions').props['aria-expanded'], false)
  assert.equal(document.activeElement, m.originalTrigger); assert.equal(f.focusCount(), 0); assert.equal(f.moreTrigger.getClientRects().length, 0)
})

const pane = (tree, id) => nodes(tree).find(n => n.props?.id === `edit-panel-${id}`)
for (const [w, h, expected] of [[390, 844, true], [720, 900, true], [721, 900, false], [1000, 500, true], [1001, 500, false], [900, 501, false]]) test(`phone admission at ${w}x${h}`, t => {
  const f = fixture(t, { viewportWidth: w, viewportHeight: h }); assert.equal(cls(f.edit(), 'phone-edit'), expected)
})
test('phone Timeline maps to shared Viewer state and displays the actual timeline', t => {
  const f = fixture(t, { viewportWidth: 390 }); const before = copy(f.state)
  for (const [label, shared] of [['Media', 'media'], ['Inspector', 'inspector'], ['Timeline', 'viewer']]) {
    const tree = f.phonePick(label); assert.equal(tree.props['data-compact-panel'], shared)
    assert.equal(pane(tree, 'timeline').props.hidden, label !== 'Timeline')
    assert.equal(pane(tree, 'media').props.hidden, label !== 'Media'); assert.equal(pane(tree, 'inspector').props.hidden, label !== 'Inspector')
    assert.equal(nodes(tree).find(n => n.props?.id === 'edit-viewer').props.hidden, false)
    assert.equal(nodes(f.controls()).filter(n => n.props?.role === 'tab' && n.props['aria-selected']).map(text).join(), label)
  }
  assert.deepEqual(f.state, before); assert.deepEqual(f.writes, []); assert.deepEqual(f.requests, [])
})
test('actual revealInspector changes phone routing without an independent phone panel state', t => {
  const f = fixture(t, { viewportWidth: 390, saved: { ...defaults, showInspector: false } }); f.phonePick('Timeline'); f.layout.revealInspector()
  const tree = f.edit(); assert.equal(pane(tree, 'inspector').props.hidden, false); assert.equal(pane(tree, 'timeline').props.hidden, true)
  assert.equal(tree.props['data-compact-panel'], 'inspector'); assert.equal(f.persisted().showInspector, true)
})
for (const [w, h] of [[390, 900], [950, 450]]) test(`focused Inspector survives ${w < 720 ? 'width' : 'height'}-only phone admission`, t => {
  const f = fixture(t); f.focusInspector(); const before = copy(f.state); const tree = f.viewport(w, h)
  assert.equal(cls(tree, 'phone-edit'), true); assert.equal(pane(tree, 'inspector').props.hidden, false)
  assert.equal(tree.props['data-compact-panel'], 'inspector'); assert.deepEqual(f.state, before); assert.deepEqual(f.requests, [])
  const restored = f.viewport(1200, 900); assert.equal(cls(restored, 'phone-edit'), false)
  for (const type of [f.components.Browser, f.components.Viewer, f.components.Inspector, f.components.Timeline]) assert.equal(componentCount(restored, type), 1)
})
test('short portrait focus closes preview and preserves the same Inspector instance', t => {
  const f = fixture(t, { viewportWidth: 390, viewportHeight: 844 }); f.phonePick('Inspector'); const initial = f.edit()
  f.phonePick('Show preview'); assert.equal(cls(f.edit(), 'phone-preview-open'), true)
  const tree = f.viewport(390, 560); f.focusInspector(); const focused = f.edit()
  assert.equal(cls(focused, 'phone-preview-open'), false); assert.equal(pane(focused, 'inspector').key, pane(initial, 'inspector').key)
  assert.equal(nodes(focused).find(n => n.type === f.components.Viewer).key, 'viewer'); assert.deepEqual(f.requests, [])
  assert.equal(nodes(f.controls()).find(n => n.type === 'button' && text(n) === 'Show preview').props['aria-expanded'], false)
})
test('phone tab arrow keys select shared state and focus the selected tab', t => {
  const f = fixture(t, { viewportWidth: 390 }); let prevented = 0, focused
  nodes(f.controls()).find(n => n.props?.role === 'tablist').props.onKeyDown({ key: 'ArrowRight', preventDefault: () => prevented++, currentTarget: { querySelector: selector => ({ focus: () => focused = selector }) } })
  assert.equal(prevented, 1); assert.equal(f.edit().props['data-compact-panel'], 'media'); assert.equal(focused, '[data-panel="media"]')
})
test('phone CSS keeps all Source placement controls reachable with coarse44px targets', () => {
  const css = fs.readFileSync(path.join(candidate, 'web/ui/phone.css'), 'utf8')
  assert.match(css, /\.page\.phone-edit \.viewer\.compact \.transport \.buttons\.right \{ display: flex; \}/)
  assert.match(css, /\.phone-edit \.transport button \{ min-height: 44px; min-width: 44px; \}/)
  assert.match(css, /@media \(max-height: 500px\) and \(max-width: 1000px\) and \(orientation: landscape\)/)
  const source = fs.readFileSync(path.join(candidate, 'web/ui/viewer.js'), 'utf8'); assert.match(source, /SourceViewer} compact=\$\{compact\}/)
  for (const text of ["place('append')", "place('insert')", "place('overwrite')", "place('connect')", 'expectedVersion: sourceContext.version']) assert(source.includes(text))
})

for (const kind of ['number', 'title']) test(`actual Inspector ${kind} draft commits on blur after phone resize, then actual Undo restores`, async t => {
  let history, commits = 0
  const f = fixture(t, { requestOverride: (_route, _body, state) => ({ project: history, version: state.version + 1 }) })
  let value = null
  const useState = initial => [value ?? initial, next => value = next]
  const inspectorSource = fs.readFileSync(path.join(candidate, 'web/ui/inspector.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const edit = op => { commits++; history = copy(f.state.project); f.state.project = applyOps(f.state.project, [op]).project }
  const actual = new Function('h', 'htm', 'useState', 'edit', 'TITLE_ANIMS', `${inspectorSource}\nreturn { Num, TitleTab }`)(h, htm, useState, edit, TITLE_ANIMS)
  const render = () => kind === 'number' ? actual.Num({ label: 'Scale', value: 100, onCommit: scale => edit({ op: 'update', id: 'c1', set: { scale: scale / 100 } }) }) : actual.TitleTab({ clip: f.state.project.tracks[0].clips[0] })
  const input = () => nodes(render()).find(n => n.type === (kind === 'number' ? 'input' : 'textarea'))
  const old = copy(f.state.project), identity = pane(f.edit(), 'inspector').key
  if (kind === 'number') input().props.onFocus({ target: { select() {} } })
  input().props.onInput({ target: { value: kind === 'number' ? '83' : 'A preserved draft' } })
  f.focusInspector(); for (const size of [[390, 844], [950, 450], [390, 560], [1200, 900]]) { const tree = f.viewport(...size); assert.equal(pane(tree, 'inspector').key, identity) }
  assert.equal(commits, 0); assert.deepEqual(f.state.project, old)
  assert.equal(input().props.value, kind === 'number' ? '83' : 'A preserved draft')
  input().props.onBlur(); assert.equal(commits, 1)
  assert.equal(kind === 'number' ? f.state.project.tracks[0].clips[0].scale : f.state.project.tracks[0].clips[0].title.text, kind === 'number' ? .83 : 'A preserved draft')
  await f.button('Undo').props.onClick(); assert.deepEqual(f.state.project, old); assert.deepEqual(f.requests.map(r => r.route), ['/api/undo'])
})
