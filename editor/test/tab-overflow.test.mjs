import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fitTabs } from '../web/ui/scroll-tabs.js'
import { cls, loadScrollTabs, Scope, walk } from './fixtures/scroll-tabs-harness.mjs'

const source = fs.readFileSync(new URL('../web/ui/scroll-tabs.js', import.meta.url), 'utf8')

test('every tab stays visible when the strip is wide enough or not measured yet', () => {
  assert.deepEqual(fitTabs([50, 60, 70], 180, 0, 60), { visible: [0, 1, 2], overflow: [] })
  assert.deepEqual(fitTabs([50, 60, 70], 0, 2, 60), { visible: [0, 1, 2], overflow: [] })
  assert.deepEqual(fitTabs([50, 60, 70], Number.NaN, 2, 60), { visible: [0, 1, 2], overflow: [] })
})

test('tabs that do not fit beside More move to its menu in order', () => {
  // The 1440 x 900 Inspector: nine tabs in a 296 pixel panel, measured in Chromium.
  const widths = [49.03, 57.33, 57.03, 47.92, 65.28, 53.64, 62.64, 55.38, 39.05].map(w => w + 2)
  const { visible, overflow } = fitTabs(widths, 288, 0, 65.42)
  assert.deepEqual(visible, [0, 1, 2, 3])
  assert.deepEqual(overflow, [4, 5, 6, 7, 8])
  const used = visible.reduce((sum, index) => sum + widths[index], 0)
  assert.ok(used + 65.42 <= 288, 'the visible tabs and More fit the strip')
})

test('an active tab from the menu takes the place of the last tabs that fit', () => {
  const widths = [50, 60, 60, 50, 70, 55]
  const { visible, overflow } = fitTabs(widths, 260, 4, 60)
  assert.ok(visible.includes(4), 'the active tab is visible')
  assert.deepEqual(visible, [0, 1, 4])
  assert.deepEqual(overflow, [2, 3, 5])
  assert.ok(visible.reduce((sum, index) => sum + widths[index], 0) + 60 <= 260)
})

test('an active tab wider than the strip is still the one visible tab', () => {
  assert.deepEqual(fitTabs([40, 300, 40], 200, 1, 60), { visible: [1], overflow: [0, 2] })
})

test('arrow keys reveal a tab listed under More before moving focus to it', () => {
  const tabs = [['video', 'Video'], ['effects', 'Effects'], ['speed', 'Speed']]
  const selected = [], focused = []
  const elements = tabs.map(([id], index) => ({ id, hidden: index === 2, focus() { focused.push(this.hidden ? `${id} while hidden` : id) } }))
  const body = source.match(/  const keyboard = \(event, index\) => \{([\s\S]*?)\n  \}/)[1]
  const strip = { current: { querySelectorAll: () => elements } }
  const onKey = new Function('tabs', 'onChange', 'strip', `return (event, index) => {${body}\n}`)(tabs, id => selected.push(id), strip)
  onKey({ key: 'ArrowRight', preventDefault() {}, stopPropagation() {} }, 1)
  assert.deepEqual(selected, ['speed'])
  assert.equal(elements[2].hidden, false)
  assert.deepEqual(focused, ['speed'])
})

test('the media and inspector strips use the More menu and the page strip keeps scrolling', () => {
  const browser = fs.readFileSync(new URL('../web/ui/browser.js', import.meta.url), 'utf8')
  const inspector = fs.readFileSync(new URL('../web/ui/inspector.js', import.meta.url), 'utf8')
  const app = fs.readFileSync(new URL('../web/ui/app.js', import.meta.url), 'utf8')
  assert.match(browser, /label="Media tabs" overflow="menu"/)
  assert.match(inspector, /label="Inspector tabs" small=\$\{true\} overflow="menu"/)
  assert.doesNotMatch(app.match(/<\$\{ScrollTabs\}[^\n]*label="Workflow"[^\n]*/)[0], /overflow=/)
})

test('the resize observer fits tabs for the current active tab, not the one from when it was created', async () => {
  const { ScrollTabs } = await loadScrollTabs('observer')
  const tabs = [['video', 'Video'], ['effects', 'Effects'], ['motion', 'Motion'], ['track', 'Track'], ['stabilize', 'Stabilize'], ['info', 'Info']]
  // Measured widths: every tab is 50 pixels plus a 2 pixel gap and More is 60, so 300 pixels hold four tabs and More.
  const ruler = { children: [...tabs.map(() => ({ getBoundingClientRect: () => ({ width: 50 }) })), { getBoundingClientRect: () => ({ width: 60 }) }] }
  const box = { clientWidth: 300 }
  const observers = []
  Object.assign(globalThis, {
    ResizeObserver: class { constructor(callback) { observers.push(callback) } observe() {} disconnect() {} },
    getComputedStyle: () => ({ columnGap: '2px', paddingLeft: '0px', paddingRight: '0px', marginLeft: '0px', marginRight: '0px' }),
    CSS: { escape: value => value }, document: { activeElement: null, addEventListener() {}, removeEventListener() {} },
  })
  const tablist = { querySelectorAll: () => [], querySelector: () => ({ scrollIntoView() {} }), scrollLeft: 0, scrollWidth: 0, clientWidth: 0 }
  const scope = new Scope()
  const render = value => {
    const tree = scope.render(ScrollTabs, { tabs, value, onChange() {}, label: 'Inspector tabs', overflow: 'menu' })
    for (const node of walk(tree)) if (node.ref) node.ref.current = node.props.role === 'tablist' ? tablist : cls(node, 'tab-scroll') ? box : cls(node, 'tab-ruler') ? ruler : null
    scope.flush()
    return tree
  }
  const hidden = () => scope.slots.find(slot => typeof slot?.value === 'string').value.split('|').filter(Boolean)
  render('video')
  assert.deepEqual(hidden(), ['stabilize', 'info'])
  assert.equal(observers.length, 1, 'the observer is created once')
  render('info')
  assert.equal(hidden().includes('info'), false, 'the newly active tab is shown')
  // The window resizes after the tab changed: the first observer's callback must fit for Info.
  box.clientWidth = 280
  observers[0]()
  assert.equal(hidden().includes('info'), false, 'a resize keeps the active tab out of the menu')
  assert.ok(hidden().length >= 2, 'the narrower strip still overflows')
  scope.unmount()
})

test('More is a named menu button whose items are menu items, and hidden tabs leave the tab order', () => {
  assert.match(source, /aria-haspopup="menu" aria-expanded=\$\{open\}/)
  assert.match(source, /aria-label=\$\{`More \$\{label\.toLowerCase\(\)\}: \$\{overflowed\.map\(t => t\[1\]\)\.join\(', '\)\}`\}/)
  assert.match(source, /role="menuitem" tabIndex="-1"/)
  assert.match(source, /hidden=\$\{hiddenIds\.has\(id\) && value !== id\}/)
  assert.match(source, /aria-hidden="true" inert/)
})

test('resizing a workflow strip reveals its unchanged selected tab', async () => {
  const { ScrollTabs } = await loadScrollTabs('workflow-resize-regression')
  const callbacks = []
  globalThis.ResizeObserver = class { constructor(callback) { callbacks.push(callback) } observe() {} disconnect() {} }
  const strip = { scrollLeft: 0, scrollWidth: 360, clientWidth: 600,
    querySelector: () => ({scrollIntoView() { strip.scrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth) }}) }
  const scope = new Scope()
  const tree = scope.render(ScrollTabs, {tabs: [['edit','Edit'], ['deliver','Deliver']],value:'deliver',onChange() {},label:'Workflow'})
  for (const node of walk(tree)) if (node.ref) node.ref.current = node.props.role === 'tablist' ? strip : null
  scope.flush()
  assert.equal(strip.scrollLeft, 0)
  strip.clientWidth = 280
  callbacks[0]()
  assert.equal(strip.scrollLeft, 80, 'the active tab must scroll into the narrowed viewport without another selection')
  scope.unmount()
})
