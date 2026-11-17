import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'
import { Icon } from '../web/ui/icons.js'
import { assistantState } from '../web/ui/assistant-state.js'
import { assistantActivity } from '../web/ui/assistant-activity.js'

const app = fs.readFileSync(new URL('../web/ui/app.js', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8')
const nodes = (value, output = []) => { if (Array.isArray(value)) value.forEach(child => nodes(child, output)); else if (value && typeof value === 'object') { output.push(value); nodes(value.props?.children, output) } return output }
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : typeof value === 'string' ? value : ''
const cls = (node, name) => String(node.props?.class ?? '').split(/\s+/).includes(name)
const LayoutMenu = function LayoutMenu() {}

function shell(project, kind = 'http', focus = () => {}) {
  const store = { project, version: 7, root: '/selected', recovery: { status: 'valid' }, jobs: [], caps: {}, claude: { state: 'idle' }, connected: true, refs: [], page: 'edit' }
  const context = vm.createContext({ html: htm.bind(h), h, Icon, assistantState, assistantActivity, store, host: { kind }, queueMicrotask: callback => callback(), globalThis: { document: { querySelector: () => ({ focus }) } }, useStore: () => store, useState: value => [value, () => {}], useRef: value => ({ current: value }), showRecovery() {}, api: async () => ({}), set: value => Object.assign(store, value), toast() {}, PAGES: [['edit', 'Edit', '⇧2', 20]], registry: { pages: [] }, ScrollTabs() {}, LayoutMenu })
  for (const name of ['Welcome', 'TopBar']) vm.runInContext(app.match(new RegExp(`function ${name}\\([^]*?\\n}\\n`))[0], context)
  return context
}
const project = { name: 'Ferry', width: 1080, height: 1920, fps: 30 }

test('undo and redo form one history group ahead of the workspace and app actions', () => {
  const tree = shell(project).TopBar(), all = nodes(tree)
  const list = all.find(node => node.props?.id === 'editor-action-list')
  const history = all.find(node => cls(node, 'topbar-history'))
  assert.equal(history.props.role, 'group')
  assert.equal(history.props['aria-label'], 'History')
  assert.deepEqual(nodes(history).filter(node => node.type === 'button').map(node => node.props['aria-label']), ['Undo', 'Redo'])
  const order = nodes(list).filter(node => node.type === 'button' || node.type === LayoutMenu || cls(node, 'topbar-sep')).map(node => node.props['aria-label'] ?? (node.type === LayoutMenu ? 'Layout' : cls(node, 'topbar-sep') ? '|' : text(node)))
  assert.deepEqual(order, ['Undo', 'Redo', '|', 'Layout', 'Recovery', 'Keyboard shortcuts', 'Settings', 'Close actions'])
  assert.ok(all.some(node => cls(node, 'before-assistant')), 'a divider separates the Assistant')
})

test('icon actions keep a text name for the compact menu and assistive technology', () => {
  const all = nodes(shell(project).TopBar())
  for (const [label, name] of [['Undo', 'Undo'], ['Redo', 'Redo'], ['Keyboard shortcuts', 'Shortcuts']]) {
    const button = all.find(node => node.type === 'button' && node.props['aria-label'] === label)
    assert.equal(text(nodes(button).find(node => cls(node, 'action-label'))), name)
  }
  const settings = all.find(node => node.type === 'button' && cls(node, 'settings-entry'))
  assert.equal(text(settings), 'Settings')
  assert.match(css, /\.topbar-actions \.action-label \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset\(50%\);/)
  assert.match(css, /\.topbar-action-list\.open \.action-label \{ position: static;/)
})

test('with no project the top bar drops page tabs, history, layout and the placeholder name but keeps recovery', () => {
  const all = nodes(shell(null).TopBar())
  assert.equal(all.find(node => cls(node, 'workflow-pages')).props.hidden, true)
  assert.equal(all.some(node => cls(node, 'proj')), false)
  assert.equal(all.some(node => cls(node, 'topbar-history')), false)
  assert.equal(all.some(node => node.type === LayoutMenu), false)
  for (const label of ['Recovery', 'Settings']) assert.ok(all.some(node => node.type === 'button' && text(node) === label), label)
  assert.equal(nodes(shell(project).TopBar()).find(node => cls(node, 'workflow-pages')).props.hidden, false)
})

test('the welcome screen marks New 1080p project as the primary action', () => {
  const store = shell(null)
  store.store.recovery = { status: 'missing', history: false }
  const buttons = nodes(store.Welcome()).filter(node => node.type === 'button')
  assert.equal(cls(buttons.find(node => text(node) === 'New 1080p project'), 'primary'), true)
  assert.equal(cls(buttons.find(node => text(node) === 'New 9:16 project'), 'primary'), false)
})


test('Ask Arya is outside More and reports setup, ready, run, refresh and connection states', () => {
  const context = shell(project)
  const check = (state, label) => {
    Object.assign(context.store, state)
    const tree = nodes(context.TopBar())
    const entry = tree.find(node => node.props?.id === 'ask-arya')
    assert.equal(entry.type, 'button')
    assert.match(text(entry), /Ask Arya/)
    assert.equal(text(nodes(entry).find(node => cls(node, 'assistant-entry-state'))), label)
    assert.equal(nodes(tree.find(node => node.props?.id === 'editor-action-list')).includes(entry), false)
  }
  check({}, 'Not set up')
  check({ assistantStatus: { provider: 'codex', configured: true } }, 'Ready')
  check({ claude: { state: 'working' } }, 'Working')
  check({ claude: { state: 'idle' }, assistantSharingReviewOpen: true }, 'Working')
  check({ assistantSharingReviewOpen: false, connected: false }, 'Reconnecting')
  check({ connected: true, assistantStatus: { provider: 'codex', configured: false, mode: 'auto',
    autoPreview: { ok: false, blocked: [{ reason: 'The model catalog needs a refresh.' }] } } }, 'Needs refresh')
  const hosted = nodes(shell(project, 'browser-local').TopBar()).find(node => node.props?.id === 'ask-arya')
  assert.match(text(hosted), /Unavailable in beta/)
})

test('Ask Arya opens and focuses the composer and keeps sharing review in control', () => {
  let focusCount = 0
  const context = shell(project, 'http', () => focusCount++)
  const entry = () => nodes(context.TopBar()).find(node => node.props?.id === 'ask-arya')
  assert.equal(entry().props['aria-expanded'], false)
  entry().props.onClick()
  assert.equal(entry().props['aria-expanded'], true)
  assert.equal(entry().props['aria-controls'], 'editor-assistant')
  assert.equal(focusCount, 1)
  context.store.assistantSharingReviewOpen = true
  assert.equal(entry().props.disabled, true)
  entry().props.onClick()
  assert.equal(entry().props['aria-expanded'], true)
  context.store.assistantSharingReviewOpen = false
  entry().props.onClick()
  assert.equal(entry().props['aria-expanded'], true)
  assert.equal(focusCount, 2, 'an already open conversation returns focus to its composer')
})
