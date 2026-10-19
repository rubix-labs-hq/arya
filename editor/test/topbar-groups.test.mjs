import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'
import { Icon } from '../web/ui/icons.js'

const app = fs.readFileSync(new URL('../web/ui/app.js', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8')
const nodes = (value, output = []) => { if (Array.isArray(value)) value.forEach(child => nodes(child, output)); else if (value && typeof value === 'object') { output.push(value); nodes(value.props?.children, output) } return output }
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : typeof value === 'string' ? value : ''
const cls = (node, name) => String(node.props?.class ?? '').split(/\s+/).includes(name)
const LayoutMenu = function LayoutMenu() {}

function shell(project) {
  const store = { project, version: 7, root: '/selected', recovery: { status: 'valid' }, jobs: [], claude: { state: 'idle' }, refs: [], page: 'edit' }
  const context = vm.createContext({ html: htm.bind(h), h, Icon, store, host: { kind: 'http' }, useStore: () => store, useState: value => [value, () => {}], useRef: value => ({ current: value }), showRecovery() {}, api: async () => ({}), set: value => Object.assign(store, value), toast() {}, PAGES: [['edit', 'Edit', '⇧2', 20]], registry: { pages: [] }, ScrollTabs() {}, LayoutMenu })
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
