// Drives the real ScrollTabs More menu through open, arrow keys, Escape, picking a tab and an
// outside click, with small stand-ins for Preact's hooks and the DOM nodes its refs point at.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

const moduleURL = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const hooksURL = moduleURL(['useState', 'useRef', 'useEffect', 'useLayoutEffect'].map(name => `export const ${name}=(...a)=>globalThis.__tabHooks.${name}(...a);`).join(''))
let source = await fs.readFile(new URL('../web/ui/scroll-tabs.js', import.meta.url), 'utf8')
for (const [from, to] of [['preact/hooks', hooksURL], ['preact', import.meta.resolve('preact')], ['htm', import.meta.resolve('htm')], ['./icons.js', new URL('../web/ui/icons.js', import.meta.url).href]]) source = source.replaceAll(`'${from}'`, JSON.stringify(to))
const { ScrollTabs } = await import(moduleURL(source))

// One hook scope per component instance: slots in call order, effects run after "commit".
class Scope {
  slots = []; index = 0; queue = []
  useState = initial => { const slot = this.slot(() => ({ value: initial })); return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next }] }
  useRef = initial => this.slot(() => ({ current: initial }))
  useEffect = (run, deps) => {
    const slot = this.slot(() => ({}))
    if (!deps || !slot.deps || deps.some((d, k) => d !== slot.deps[k])) { slot.deps = deps; this.queue.push(() => { slot.cleanup?.(); slot.cleanup = run() }) }
  }
  useLayoutEffect = (run, deps) => this.useEffect(run, deps)
  slot(make) { const i = this.index++; return (this.slots[i] ??= make()) }
  unmount() { for (const slot of this.slots) slot?.cleanup?.() }
}
const walk = (node, out = []) => { if (Array.isArray(node)) node.forEach(n => walk(n, out)); else if (node && typeof node === 'object') { out.push(node); walk(node.props?.children, out) } return out }
const cls = (node, name) => String(node.props?.class ?? '').split(/\s+/).includes(name)

function fixture() {
  const listeners = new Map()
  const document = { activeElement: null, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type) }, getElementById: id => (id === 'inspector-tabs-more' ? menu?.list ?? null : null) }
  const focusable = name => ({ name, hidden: false, focus() { document.activeElement = this } })
  const tabs = [['video', 'Video'], ['effects', 'Effects'], ['speed', 'Speed'], ['process', 'Process'], ['info', 'Info']]
  const tabElements = tabs.map(([id]) => ({ ...focusable(id), id, scrollIntoView() {} }))
  const elements = {
    tablist: { querySelectorAll: () => tabElements, querySelector: selector => tabElements.find(el => selector === `[data-tab="${el.id}"]` || (selector === '[aria-selected="true"]' && el.id === state.value)) ?? null, scrollLeft: 0, scrollWidth: 0, clientWidth: 0 },
    box: { clientWidth: 0 },
    ruler: { children: [] },
    more: { ...focusable('More'), getBoundingClientRect: () => ({ right: 300, bottom: 40 }), contains: target => target === elements.more },
  }
  Object.assign(globalThis, { document, ResizeObserver: class { observe() {} disconnect() {} }, CSS: { escape: value => value }, innerWidth: 1440, innerHeight: 900 })
  const state = { value: 'video', changes: [] }
  const strip = new Scope()
  let menu = null, menuItems = []
  const bind = tree => {
    for (const node of walk(tree)) {
      if (!node.ref) continue
      node.ref.current = node.props.role === 'tablist' ? elements.tablist : cls(node, 'tab-scroll') ? elements.box : cls(node, 'tab-ruler') ? elements.ruler : cls(node, 'tab-more') ? elements.more : node.props.role === 'menu' ? menu.list : null
    }
  }
  const render = () => {
    globalThis.__tabHooks = strip; strip.index = 0
    const tree = ScrollTabs({ tabs, value: state.value, onChange: id => { state.changes.push(id); state.value = id }, label: 'Inspector tabs', small: true, overflow: 'menu' })
    bind(tree)
    const queued = strip.queue.splice(0); queued.forEach(run => run())
    return tree
  }
  // Renders the menu the strip asks for, if any, as its own component instance.
  const renderMenu = tree => {
    const node = walk(tree).find(n => typeof n.type === 'function' && n.type.name === 'MoreMenu')
    if (!node) { menu?.scope.unmount(); menu = null; return null }
    if (!menu) {
      menuItems = node.props.items.map(([id]) => ({ ...focusable(id), id }))
      menu = { scope: new Scope(), list: { querySelector: () => menuItems[0], querySelectorAll: () => menuItems, contains: target => menuItems.includes(target) } }
    }
    globalThis.__tabHooks = menu.scope; menu.scope.index = 0
    const out = node.type(node.props)
    bind(out)
    const queued = menu.scope.queue.splice(0); queued.forEach(run => run())
    return out
  }
  const overflow = ids => { strip.slots.find(slot => typeof slot?.value === 'string').value = ids.join('|') }
  const moreButton = tree => walk(tree).find(n => n.type === 'button' && n.props['aria-haspopup'] === 'menu')
  const key = (menuTree, name) => walk(menuTree)[0].props.onKeyDown({ key: name, preventDefault() {}, stopPropagation() {} })
  return { document, listeners, elements, tabElements, state, render, renderMenu, overflow, moreButton, key, items: () => menuItems }
}

test('More opens a keyboard menu, Escape returns to More, and a picked tab gets focus', () => {
  const f = fixture()
  let tree = f.render()
  assert.equal(f.moreButton(tree), undefined, 'no More button while every tab fits')
  f.overflow(['speed', 'process', 'info'])
  tree = f.render()
  const more = f.moreButton(tree)
  assert.equal(more.props['aria-expanded'], false)
  assert.equal(more.props['aria-label'], 'More inspector tabs: Speed, Process, Info')

  more.props.onClick()
  tree = f.render()
  assert.equal(f.moreButton(tree).props['aria-expanded'], true)
  let menu = f.renderMenu(tree)
  assert.equal(walk(menu)[0].props.role, 'menu')
  assert.deepEqual(walk(menu).filter(n => n.props?.role === 'menuitem').map(n => n.props.children), ['Speed', 'Process', 'Info'])
  assert.equal(f.document.activeElement, f.items()[0], 'opening focuses the first item')
  for (const [name, expected] of [['ArrowDown', 1], ['ArrowDown', 2], ['ArrowDown', 0], ['ArrowUp', 2], ['Home', 0], ['End', 2]]) {
    f.key(menu, name)
    assert.equal(f.document.activeElement, f.items()[expected], name)
  }
  f.key(menu, 'Escape')
  tree = f.render(); f.renderMenu(tree)
  assert.equal(f.moreButton(tree).props['aria-expanded'], false)
  assert.equal(f.document.activeElement, f.elements.more, 'Escape returns focus to More')
  assert.equal(f.listeners.has('pointerdown'), false, 'a closed menu stops listening for outside clicks')

  f.moreButton(tree).props.onClick()
  tree = f.render(); menu = f.renderMenu(tree)
  walk(menu).find(n => n.props?.role === 'menuitem' && n.props.children === 'Process').props.onClick()
  assert.deepEqual(f.state.changes, ['process'])
  tree = f.render(); f.renderMenu(tree)
  assert.equal(f.document.activeElement, f.tabElements.find(el => el.id === 'process'), 'focus lands on the picked tab')
  assert.equal(walk(tree).find(n => n.props?.['data-tab'] === 'process').props.hidden, false, 'the picked tab is shown in the strip')
  assert.equal(f.moreButton(tree).props['aria-expanded'], false)
})

test('a click outside closes the menu without moving focus, and the menu closes when nothing overflows', () => {
  const f = fixture()
  f.render(); f.overflow(['speed', 'process', 'info'])
  let tree = f.render()
  f.moreButton(tree).props.onClick()
  tree = f.render(); f.renderMenu(tree)
  const focused = f.document.activeElement
  f.listeners.get('pointerdown')({ target: { outside: true } })
  tree = f.render(); f.renderMenu(tree)
  assert.equal(f.moreButton(tree).props['aria-expanded'], false)
  assert.equal(f.document.activeElement, focused, 'an outside click leaves focus where the user put it')

  f.listeners.get('pointerdown')?.({ target: f.elements.more })
  f.moreButton(tree).props.onClick()
  tree = f.render(); f.renderMenu(tree)
  assert.equal(f.document.activeElement, f.items()[0], 'focus is inside the open menu')
  f.overflow([])
  tree = f.render(); f.renderMenu(tree)
  assert.equal(f.moreButton(tree), undefined)
  assert.equal(f.document.activeElement, f.tabElements.find(el => el.id === f.state.value), 'focus moves to the active tab instead of dropping to the page')
  f.overflow(['info'])
  tree = f.render()
  assert.equal(f.moreButton(tree).props['aria-expanded'], false, 'the menu does not reopen when the strip narrows again')
  assert.equal(f.renderMenu(tree), null)
})
