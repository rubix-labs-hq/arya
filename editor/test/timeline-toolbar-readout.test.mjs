import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { registerHooks } from 'node:module'
import test from 'node:test'

const editor = new URL('../', import.meta.url)
registerHooks({ resolve(specifier, context, next) { return next(specifier.startsWith('/core/') ? new URL('.' + specifier, editor).href : specifier, context) } })
const { newProject } = await import('../core/project.js')
const moduleURL = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')

async function loadToolbar(tag) {
  let source = await fs.readFile(new URL('../web/ui/timeline-toolbar.js', import.meta.url), 'utf8')
  const imports = {
    preact: import.meta.resolve('preact'), htm: import.meta.resolve('htm'),
    '/core/project.js': new URL('../core/project.js', import.meta.url).href,
    './icons.js': new URL('../web/ui/icons.js', import.meta.url).href,
    './store.js': moduleURL('export const set=v=>globalThis.__readoutCalls.push(v);export const useStore=()=>globalThis.__readoutState;export const viewProject=()=>globalThis.__readoutProject;'),
    './registry.js': moduleURL("export const registry={tools:[{id:'m-shape',label:'Shape tool: rectangle, ellipse, polygon, star',icon:'▭',key:'Q on the Motion page'},{id:'track',label:'Track: drag a box on the viewer',icon:'⌖'}],pages:[]};"),
  }
  for (const [specifier, target] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(target))
  return import(moduleURL(`${source}\n// ${tag}`))
}

function expand(node) {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node == null || typeof node !== 'object') return [node]
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return [{ ...node, props: { ...node.props, children: expand(node.props.children) } }]
}
const walk = (nodes, out = []) => { for (const n of nodes) if (n && typeof n === 'object') { out.push(n); walk(n.props.children, out) } return out }
const text = node => walk([node]).flatMap(n => n.props.children).filter(c => typeof c === 'string').join('')
const hasClass = (node, name) => String(node.props?.class ?? '').split(' ').includes(name)

test('tool titles give a short name and a shortcut', async () => {
  const { toolNameAndKey } = await loadToolbar('names')
  assert.deepEqual(toolNameAndKey('Select (A)'), { name: 'Select', shortcut: 'A', where: '' })
  assert.deepEqual(toolNameAndKey('Trim: ripple edges, roll edit points, slip bodies, ⌥ slide (T)'), { name: 'Trim', shortcut: 'T', where: '' })
  assert.deepEqual(toolNameAndKey('Shape tool: rectangle, ellipse, polygon, star (Q on the Motion page)'), { name: 'Shape tool', shortcut: 'Q', where: 'on the Motion page' })
  assert.deepEqual(toolNameAndKey('Track: drag a box on the viewer'), { name: 'Track', shortcut: '', where: '' })
})

test('the toolbar names the active tool and its shortcut, and groups edit tools apart from drawing tools', async () => {
  globalThis.__readoutCalls = []
  globalThis.__readoutProject = newProject('Readout', { width: 640, height: 360, fps: 30 })
  try {
    for (const [tool, name, key, where] of [['blade', 'Blade', 'B', null], ['trim', 'Trim', 'T', null], ['m-shape', 'Shape tool', 'Q', 'on the Motion page'], ['track', 'Track', null, null]]) {
      globalThis.__readoutState = { tool, snapping: true, linked: false, selection: [], zoom: 10, openComp: null }
      const { Toolbar } = await loadToolbar(`active-${tool}`)
      const tree = walk(expand(Toolbar()))
      const readout = tree.find(node => hasClass(node, 'tool-readout'))
      assert.ok(readout, 'the toolbar has a readout')
      assert.equal(readout.props.role, undefined)
      assert.equal(walk([readout]).find(node => hasClass(node, 'tool-current')).props.role, 'status', 'tool changes from the keyboard are announced')
      const preview = walk([readout]).find(node => hasClass(node, 'tool-preview'))
      assert.equal(preview.props['aria-hidden'], 'true', 'hover previews are not announced')
      assert.equal(walk([preview]).length, 1, 'the preview element has no Preact children')
      assert.equal(text(walk([readout]).find(node => hasClass(node, 'tool-name'))), name)
      assert.equal(walk([readout]).find(node => node.type === 'kbd') ? text(walk([readout]).find(node => node.type === 'kbd')) : null, key)
      assert.equal(walk([readout]).find(node => hasClass(node, 'tool-where')) ? text(walk([readout]).find(node => hasClass(node, 'tool-where'))) : null, where)
      const groups = tree.filter(node => node.props?.role === 'group')
      assert.deepEqual(groups.map(group => group.props['aria-label']), ['Edit tools', 'Drawing and tracking tools'])
      assert.deepEqual(walk([groups[0]]).filter(node => node.type === 'button').map(button => button.props['aria-label']), ['Select', 'Trim: ripple edges, roll edit points, slip bodies, ⌥ slide', 'Blade', 'Slip', 'Slide', 'Hand'])
      const pressed = tree.filter(node => node.type === 'button' && node.props['aria-pressed'] === true && node.props.title)
      assert.equal(pressed.filter(button => !['Snapping', 'Linked selection'].includes(button.props['aria-label'])).length, 1, 'one tool is pressed')
    }
  } finally { delete globalThis.__readoutCalls; delete globalThis.__readoutState; delete globalThis.__readoutProject }
})

test('hovering or focusing a tool previews its name in the readout and leaving restores the active tool', async () => {
  globalThis.__readoutCalls = []
  globalThis.__readoutProject = newProject('Preview', { width: 640, height: 360, fps: 30 })
  globalThis.__readoutState = { tool: 'select', snapping: false, linked: false, selection: [], zoom: 10, openComp: null }
  try {
    const { Toolbar } = await loadToolbar('preview')
    const blade = walk(expand(Toolbar())).find(node => node.type === 'button' && node.props['aria-label'] === 'Blade')
    const readout = { dataset: {} }
    const event = { currentTarget: { closest: selector => (selector === '.tl-toolbar' ? { querySelector: query => (query === '.tool-preview' ? readout : null) } : null) } }
    blade.props.onPointerEnter(event)
    assert.deepEqual(readout.dataset, { previewName: 'Blade', previewKey: 'B' })
    blade.props.onPointerLeave(event)
    assert.deepEqual(readout.dataset, {})
    blade.props.onFocus(event)
    assert.equal(readout.dataset.previewName, 'Blade')
    blade.props.onBlur(event)
    assert.deepEqual(readout.dataset, {})
    blade.props.onPointerEnter(event)
    blade.props.onClick(event)
    assert.deepEqual(readout.dataset, {}, 'clicking a tool clears its preview')
    assert.deepEqual(globalThis.__readoutCalls, [{ tool: 'blade' }])
    blade.props.onClick()
    assert.deepEqual(globalThis.__readoutCalls, [{ tool: 'blade' }, { tool: 'blade' }], 'a click without an event still selects the tool')
  } finally { delete globalThis.__readoutCalls; delete globalThis.__readoutState; delete globalThis.__readoutProject }
})

test('a long tool name widens the preview box instead of painting past it', async () => {
  const css = await fs.readFile(new URL('../web/styles.css', import.meta.url), 'utf8')
  const rule = css.match(/^\.tool-preview \{ ([^}]*) \}/m)[1]
  assert.match(rule, /inset: 0 auto 0 0;/, 'the right edge follows the content')
  assert.match(rule, /min-width: 100%;/, 'the preview still covers the active tool name')
  assert.match(rule, /white-space: nowrap;/)
  assert.match(rule, /background: var\(--panel\);/)
  assert.match(rule, /pointer-events: none;/, 'a wider preview never blocks the buttons beside it')
})
