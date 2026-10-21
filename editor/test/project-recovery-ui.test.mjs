import { Icon } from '../web/ui/icons.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createRecoveryController, openProjectRecovery } from '../web/ui/project-recovery.js'
import { assistantDraft, assistantDraftContext, assistantDraftIsCurrent } from '../web/ui/assistant-script.js'
import { assistantPrompt } from '../web/ui/assistant-state.js'

const family = '11111111-1111-4111-8111-111111111111', copyID = '22222222-2222-4222-8222-222222222222'
const listing = patch => ({ protocol: 1, familyID: family, version: 7, rootIdentity: { device: '1', inode: '2' }, observed: { status: 'invalid', token: 'a'.repeat(64), writable: true }, snapshots: [{ id: copyID, host: 'browser', name: 'Saved project', createdAt: '2026-10-04T00:00:00Z', bytes: 900, sha256: 'c'.repeat(64) }], preservedOriginals: 0, warning: null, ...patch })
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

class Element {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.handlers = {}; this.attributes = {}; this.disabled = false; this._text = '' }
  set textContent(value) { this._text = String(value); this.replaceChildren() }
  get textContent() { return this._text + this.children.map(child => child.textContent).join('') }
  set innerHTML(value) { throw new Error('Fixture forbids HTML interpolation') }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  replaceChildren(...nodes) { for (const node of this.children) node.parent = null; this.children = []; this.append(...nodes) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null }
  setAttribute(key, value) { this.attributes[key] = String(value) }
  addEventListener(name, fn) { (this.handlers[name] ??= []).push(fn) }
  dispatch(name, event = {}) { return Promise.all((this.handlers[name] ?? []).map(fn => fn({ target: this, preventDefault() {}, ...event }))) }
  click() { return this.disabled ? Promise.resolve() : this.dispatch('click') }
  focus() { if (!this.disabled) this.ownerDocument.activeElement = this }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parent?.isConnected) }
  querySelectorAll(selector) { const tags = selector.split(','), result = []; for (const child of this.children) { if (tags.includes(child.tagName)) result.push(child); result.push(...child.querySelectorAll(selector)) } return result }
}
class Document {
  constructor() { this.body = new Element('body', this); this.activeElement = this.body }
  createElement(tag) { return new Element(tag, this) }
}
function fixture(t, { initial = listing(), respond } = {}) {
  const document = new Document(), trigger = document.createElement('button'); document.body.append(trigger); trigger.focus()
  const context = { root: '/selected', version: 7, project: null }, calls = [], applied = [], statuses = []
  const request = async (route, body) => {
    calls.push({ route, body })
    if (respond) return respond(route, body, calls.length)
    if (route === '/api/recovery') return initial
    return { project: { name: 'Restored' }, version: 8, publication: { directorySynced: true }, recovery: listing({ version: 8, observed: { status: 'valid', token: 'b'.repeat(64), writable: true }, preservedOriginals: 1 }) }
  }
  const dialog = openProjectRecovery({ document, request, context: () => context, apply: result => { applied.push(result); Object.assign(context, result) }, updateStatus: value => statuses.push(value) })
  t.after(() => { dialog.controller.state.busy = false; dialog.close() })
  const button = label => document.body.querySelectorAll('button').find(node => node.textContent === label)
  return { document, trigger, context, calls, applied, statuses, dialog, button, radio: () => document.body.querySelectorAll('input')[0] }
}

test('damaged startup chooser loads verified copies without automatic selection or restore', async t => {
  const f = fixture(t); await tick()
  assert.equal(f.dialog.controller.state.selected, null); assert.equal(f.button('Restore selected copy').disabled, true)
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].route, '/api/recovery')
  assert.match(f.document.body.textContent, /damaged/); assert.match(f.document.body.textContent, /Saved project/)
})

test('actual DOM choice restores only the selected copy with its exact disk token and version', async t => {
  const f = fixture(t); await tick(); await f.radio().dispatch('change'); await f.button('Restore selected copy').click(); await tick()
  assert.deepEqual(f.calls[1], { route: '/api/recovery/restore', body: { snapshotID: copyID, familyID: family, observedToken: 'a'.repeat(64), expectedVersion: 7 } })
  assert.equal(f.applied.length, 1); assert.equal(f.context.version, 8); assert.equal(f.dialog.controller.state.selected, null)
  assert.match(f.document.body.textContent, /previous file was preserved/); assert.equal(f.statuses.at(-1).status, 'valid')
})

test('read-only recovery displays the restriction and cannot dispatch a selected restore', async t => {
  const f = fixture(t, { initial: listing({ observed: { status: 'valid', token: 'a'.repeat(64), writable: false } }) }); await tick()
  await f.radio().dispatch('change'); assert.equal(f.button('Restore selected copy').disabled, true)
  await f.button('Restore selected copy').click(); assert.equal(f.calls.length, 1)
  assert.match(f.document.body.textContent, /read-only/)
})

test('a stale server choice refreshes state, clears selection and keeps its conflict visible', async t => {
  let gets = 0
  const f = fixture(t, { respond: route => {
    if (route === '/api/recovery') return ++gets === 1 ? listing() : listing({ version: 8, observed: { status: 'valid', token: 'd'.repeat(64), writable: true } })
    throw new Error('The project changed after the recovery choice was shown')
  } }); await tick(); await f.radio().dispatch('change'); await f.button('Restore selected copy').click(); await tick()
  assert.equal(gets, 2); assert.equal(f.applied.length, 0); assert.equal(f.dialog.controller.state.selected, null)
  assert.equal(f.dialog.controller.state.listing.version, 8); assert.match(f.document.body.textContent, /changed after the recovery choice/)
})

test('a changed local version blocks dispatch and refreshes the chooser', async t => {
  const f = fixture(t); await tick(); await f.radio().dispatch('change'); f.context.version = 8
  await f.button('Restore selected copy').click(); await tick()
  assert.equal(f.calls.filter(call => call.route.includes('/restore')).length, 0)
  assert.match(f.document.body.textContent, /project changed after recovery was shown/)
})

test('a late result from a different folder never replaces the current editor project', async t => {
  const pending = deferred()
  const f = fixture(t, { respond: route => route === '/api/recovery' ? listing() : pending.promise }); await tick(); await f.radio().dispatch('change')
  const done = f.button('Restore selected copy').click(); f.context.root = '/other'
  pending.resolve({ project: { name: 'Wrong folder' }, version: 8, recovery: listing({ version: 8 }) }); await done; await tick()
  assert.equal(f.applied.length, 0); assert.match(f.document.body.textContent, /folder changed/)
})

test('a newer editor version survives a late restore response', async t => {
  const pending = deferred()
  const f = fixture(t, { respond: route => route === '/api/recovery' ? listing() : pending.promise }); await tick(); await f.radio().dispatch('change')
  const done = f.button('Restore selected copy').click(); f.context.version = 9
  pending.resolve({ project: { name: 'Older result' }, version: 8, recovery: listing({ version: 8 }) }); await done; await tick()
  assert.equal(f.applied.length, 0); assert.equal(f.context.version, 9); assert.match(f.document.body.textContent, /newer project edit/)
})

test('late sync warning and recovery storage warning remain visible after a successful restore', async t => {
  const f = fixture(t, { respond: route => route === '/api/recovery' ? listing() : { project: { name: 'Restored' }, version: 8, publication: { directorySynced: false, warningCode: 'ERRNO_5' }, recovery: listing({ version: 8, warning: 'Some copies could not be verified' }) } }); await tick(); await f.radio().dispatch('change')
  await f.button('Restore selected copy').click(); await tick()
  assert.equal(f.applied.length, 1); assert.match(f.document.body.textContent, /folder sync could not be confirmed/)
  assert.match(f.document.body.textContent, /Some copies could not be verified/)
  assert.match(f.document.body.textContent, /ERRNO_5/)
  await f.button('Refresh').click(); await tick()
  assert.match(f.document.body.textContent, /folder sync could not be confirmed/)
  assert.match(f.document.body.textContent, /ERRNO_5/)
})

test('a publication warning code is visible even when the directory sync field is true', async t => {
  const f = fixture(t, { respond: route => route === '/api/recovery' ? listing() : { project: { name: 'Restored' }, version: 8, publication: { directorySynced: true, warningCode: 'RECEIPT_WARNING' }, recovery: listing({ version: 8 }) } }); await tick(); await f.radio().dispatch('change')
  await f.button('Restore selected copy').click(); await tick()
  assert.match(f.document.body.textContent, /RECEIPT_WARNING/)
  assert.match(f.statuses.at(-1).warning, /RECEIPT_WARNING/)
})

test('disposing the client ignores a deferred refresh response', async () => {
  const pending = deferred(), updates = []
  const controller = createRecoveryController({ request: () => pending.promise, context: () => ({ root: '/selected' }), apply() {}, updateStatus: value => updates.push(value) })
  const done = controller.refresh(); controller.dispose(); pending.resolve(listing()); await done
  assert.equal(updates.length, 0); assert.equal(controller.state.listing, null)
})

test('close is disabled during publication and restores trigger focus after the result settles', async t => {
  const pending = deferred()
  const f = fixture(t, { respond: route => route === '/api/recovery' ? listing() : pending.promise }); await tick(); await f.radio().dispatch('change')
  const done = f.button('Restore selected copy').click(); assert.equal(f.button('Close').disabled, true); assert.equal(f.dialog.close(), false)
  pending.resolve({ project: { name: 'Restored' }, version: 8, recovery: listing({ version: 8 }) }); await done
  assert.equal(f.dialog.close(), true); assert.equal(f.document.activeElement, f.trigger)
})

test('dialog traps Tab at both ends and Escape closes an idle chooser', async t => {
  const f = fixture(t); await tick()
  const panel = f.document.body.children.at(-1).children[0], radio = f.radio(), close = f.button('Close'), refresh = f.button('Refresh')
  refresh.focus(); await panel.dispatch('keydown', { key: 'Tab' }); assert.equal(f.document.activeElement, radio)
  radio.focus(); await panel.dispatch('keydown', { key: 'Tab', shiftKey: true }); assert.equal(f.document.activeElement, refresh)
  await panel.dispatch('keydown', { key: 'Escape' }); assert.equal(f.document.activeElement, f.trigger)
  assert.equal(panel.isConnected, false); assert.ok(close)
})

test('copy names use DOM text and cannot interpolate markup', async t => {
  const f = fixture(t, { initial: listing({ snapshots: [{ ...listing().snapshots[0], name: '<img src=x onerror=steal()>' }] }) }); await tick()
  assert.match(f.document.body.textContent, /<img src=x onerror=steal\(\)>/)
  assert.equal(f.document.body.querySelectorAll('img').length, 0)
})

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
function publicationFixture(writer) {
  const prepared = { project: { name: 'Original format' }, text: '{"name":"Original format"}', expectedText: '{corrupt', expectedIdentity: { device: '1', inode: '2' }, observedToken: 'a' }
  const context = vm.createContext({ version: 7, projectEpoch: 0, project: null, lastText: '{corrupt', past: [], future: [], ROOT: '/fixture', assistantCalls: { getStore: () => undefined }, assistantReview: { commitBy() {} }, processing: { current: () => undefined }, assertAssistantPublication: () => undefined, migrate: value => value, recoveryProject() {}, rememberProject() {}, log() {}, broadcast() {}, pushActivity() {}, writeProjectAtomic: writer, recovery: { prepareRestore: () => prepared, assertExpected: () => ({ token: 'a' }), observe: () => ({ status: 'valid' }), list: () => listing({ version: context.version }) } })
  for (const name of ['publishRecovery', 'restoreRecovery', 'commit']) vm.runInContext(server.match(new RegExp(`function ${name}\\([^]*?\\n}\\n`))[0], context)
  return context
}

test('actual restore functions return the small late-warning receipt without duplicating project text', () => {
  const state = publicationFixture(() => ({ directorySynced: false, warningCode: 'ERRNO_5' }))
  const result = state.restoreRecovery({ expectedVersion: 7 })
  assert.equal(result.version, 8); assert.equal(result.publication.directorySynced, false)
  assert.equal(result.publication.warningCode, 'ERRNO_5'); assert.equal(Object.hasOwn(result.publication, 'text'), false)
})

test('actual failed publication returns no success receipt and keeps version and history unchanged', () => {
  const state = publicationFixture(() => { throw new Error('CAS failed') })
  assert.throws(() => state.restoreRecovery({ expectedVersion: 7 }), /CAS failed/)
  assert.equal(state.version, 7); assert.equal(state.past.length, 0); assert.equal(state.project, null)
})

const require = createRequire(path.join(process.cwd(), 'editor/package.json'))
const { h } = require('preact'), htm = require('htm')
const app = fs.readFileSync(new URL('../web/ui/app.js', import.meta.url), 'utf8')
const storeSource = fs.readFileSync(new URL('../web/ui/store.js', import.meta.url), 'utf8')
const nodes = (value, output = []) => { if (Array.isArray(value)) value.forEach(child => nodes(child, output)); else if (value && typeof value === 'object') { output.push(value); nodes(value.props?.children, output) } return output }
const nodeText = node => [node.props.children].flat(Infinity).filter(value => typeof value === 'string').join('')
function shell(status, kind = 'http', history) {
  const store = { project: null, version: 7, root: '/selected', recovery: { status, history }, jobs: [], claude: { state: 'idle' }, refs: [] }, requests = [], opened = []
  const context = vm.createContext({ html: htm.bind(h), h, Icon, store, host: { kind }, useStore: () => store, useState: value => [value, () => {}], useRef: value => ({ current: value }), showRecovery: () => opened.push(true), api: async route => { requests.push(route); return {} }, set: value => Object.assign(store, value), toast() {}, PAGES: [], registry: { pages: [] }, ScrollTabs() {}, LayoutMenu() {} })
  vm.runInContext(storeSource.match(/export function chatHistoryStatus\([^]*?\n}\n/)[0].replace('export ', ''), context)
  for (const name of ['Welcome', 'TopBar']) vm.runInContext(app.match(new RegExp(`function ${name}\\([^]*?\\n}\\n`))[0], context)
  return { context, store, requests, opened }
}

test('actual cold welcome disables new projects for damaged files and exposes the explicit chooser', () => {
  const f = shell('invalid'), controls = nodes(f.context.Welcome()).filter(node => node.type === 'button')
  assert.equal(controls.find(node => nodeText(node) === 'New 1080p project').props.disabled, true)
  assert.equal(controls.find(node => nodeText(node) === 'New 9:16 project').props.disabled, true)
  controls.find(node => nodeText(node) === 'Choose a recovery copy').props.onClick()
  assert.equal(f.opened.length, 1); assert.equal(f.requests.length, 0)
})

test('actual missing-file welcome offers both explicit recovery and new project creation', () => {
  const f = shell('missing'), controls = nodes(f.context.Welcome()).filter(node => node.type === 'button')
  assert.equal(controls.find(node => nodeText(node) === 'New 1080p project').props.disabled, false)
  assert.ok(controls.find(node => nodeText(node) === 'Choose a recovery copy'))
})

test('actual welcome in a new folder offers creation without a missing-file warning or chooser', () => {
  const fresh = shell('missing', 'http', false), returning = shell('missing', 'http', true)
  const texts = f => nodes(f.context.Welcome()).map(nodeText).join(' ')
  const chooser = f => nodes(f.context.Welcome()).some(node => node.type === 'button' && nodeText(node) === 'Choose a recovery copy')
  assert.equal(chooser(fresh), false); assert.doesNotMatch(texts(fresh), /project file is missing/)
  assert.equal(nodes(fresh.context.Welcome()).find(node => node.type === 'button' && nodeText(node) === 'New 1080p project').props.disabled, false)
  assert.equal(chooser(returning), true); assert.match(texts(returning), /project file is missing/)
})

test('actual normal top bar exposes browser recovery while native retains its own chooser', () => {
  const browser = shell('valid'), native = shell('valid', 'native')
  assert.ok(nodes(browser.context.TopBar()).find(node => node.type === 'button' && nodeText(node) === 'Recovery'))
  assert.equal(nodes(native.context.TopBar()).some(node => node.type === 'button' && nodeText(node) === 'Recovery'), false)
})

test('actual app bootstrap retains cold recovery status without dispatching restoration', async () => {
  const f = shell('invalid'), routes = [], bootstrap = { project: null, version: 0, root: '/cold', recovery: { status: 'invalid', warning: 'Original file preserved' } }
  Object.assign(f.context, { api: async route => { routes.push(route); return route === '/api/project' ? bootstrap : {} }, connect() {}, installKeys() {}, installDropImport() {}, render() {}, App() {}, player: {}, window: {} })
  const source = app.match(/export async function mountApp\([^]*?\n}\n/)[0].replace('export ', '')
  vm.runInContext(source, f.context); await f.context.mountApp({})
  assert.equal(f.store.project, null); assert.equal(f.store.version, 0); assert.equal(f.store.root, '/cold')
  assert.equal(f.store.recovery.status, 'invalid'); assert.equal(f.store.recovery.warning, 'Original file preserved')
  assert.equal(routes.includes('/api/recovery/restore'), false)
})

test('actual merged route context registers queued Creative jobs with their cancel path and analysis fallback', () => {
  const calls = [], pushes = [], jobs = new Map()
  const source = server.match(/  broadcast: \(event, data, role\) => \{([^]*?)\n  },/)[1]
  const context = vm.createContext({ jobs, assistantCalls: { getStore: () => ({ registerJob: value => calls.push(value) }) }, broadcast: (...args) => pushes.push(args) })
  vm.runInContext(`globalThis.routeBroadcast=(event,data,role)=>{${source}\n}`, context)
  context.routeBroadcast('job', { id: 'color-job', state: 'queued', progress: 0, created: 1, cancelPath: '/api/color/jobs/cancel' })
  context.routeBroadcast('job', { id: 'analysis-job', state: 'running', progress: 0, created: 1 })
  jobs.set('already-owned', {})
  context.routeBroadcast('job', { id: 'already-owned', state: 'queued', progress: 0, created: 1 })
  assert.equal(calls[0].path, '/api/color/jobs/cancel'); assert.equal(calls[1].path, '/api/analysis/jobs/cancel')
  assert.equal(calls.length, 2); assert.equal(pushes.length, 3)
})

test('actual pending assistant send blocks both recovery entries and their stale click closures before consent renders', async () => {
  const f = shell('valid'), pending = deferred(), opened = []
  Object.assign(f.context, { openProjectRecovery: () => opened.push(true), player: { pause() {} },
    time: { t: 0 }, sending: { current: false }, dispatching: { current: false }, activity: { active: false },
    sharingGate: { current: { request: () => pending.promise } }, setPending() {}, setText() {}, setNow() {},
    assistantDraftIsCurrent, assistantPrompt, draftContext: assistantDraftContext(f.store), draft: assistantDraft(f.store), native: false, connection: null })
  f.store.connected = true
  f.context.s = f.store
  vm.runInContext(app.match(/function showRecovery\([^]*?\n}\n/)[0], f.context)
  const controls = () => [f.context.TopBar(), f.context.Welcome()].flatMap(value => nodes(value))
    .filter(node => node.type === 'button' && ['Recovery', 'Choose a recovery copy'].includes(nodeText(node)))
  const staleClicks = controls().map(node => node.props.onClick)
  assert.equal(staleClicks.length, 2)
  const chat = fs.readFileSync(new URL('../web/ui/chat.js', import.meta.url), 'utf8')
  const inputLimit = chat.match(/^  const inputLimit = .+$/m)
  assert.ok(inputLimit, 'Extract the current ChatPanel input limit expression')
  vm.runInContext(inputLimit[0], f.context)
  const body = chat.match(/  const send = async \(msg = text\) => \{([^]*?)\n  }\n  const stop/)[1]
  vm.runInContext(`globalThis.send = async (msg) => {${body}\n}`, f.context)
  const sending = f.context.send('Fixture prompt')
  assert.equal(f.store.assistantSharingReviewOpen, true)
  assert.equal(f.store.assistantSharingReview, undefined)
  for (const click of staleClicks) click()
  assert.equal(opened.length, 0)
  assert.equal(controls().every(node => node.props.disabled === true), true)
  pending.resolve(null)
  await sending
  assert.equal(f.store.assistantSharingReviewOpen, false)
  staleClicks[0]()
  assert.equal(opened.length, 1)
})
