import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { h } from 'preact'
import htm from 'htm'

const editor = process.env.ARYA_TIMELINE_SCROLL_EDITOR ? pathToFileURL(process.env.ARYA_TIMELINE_SCROLL_EDITOR + '/') : new URL('../', import.meta.url)
const core = await import(new URL('core/project.js', editor))
const source = fs.readFileSync(new URL('web/ui/timeline.js', editor), 'utf8')
const css = fs.readFileSync(new URL('web/styles.css', editor), 'utf8')
const storeSource = fs.readFileSync(new URL('web/ui/store.js', editor), 'utf8')
const moduleBody = source.replace(/^import .*$/gm, '').replace(/^export function /gm, 'function ').replace(/^export \{.*\}\s*$/gm, '')
const factory = new Function('deps', `const { h, htm, useEffect, useLayoutEffect, useRef, useState, applyOps, clipEnd, duration, hasAudio, snapToFrame, timecode, MARKER_COLORS, addRef, api, edit, onTime, set, store, subscribe, time, toast, useStore, useTime, viewProject, openMenu, player, registry, devicePixelRatio, ResizeObserver, requestAnimationFrame } = deps; ${moduleBody}\nreturn { Timeline, TrackHeader, rowsOf, hitAt, drawAll, RULER, HEADER }`)
const scopedBody = storeSource.match(/^function scoped\(ops\) \{[\s\S]*?^\}/m)?.[0]
assert(scopedBody, 'Load the actual store composition scope function')
const scopedFactory = new Function('store', scopedBody + '\nreturn scoped')
const flatten = values => Array.isArray(values) ? values.flatMap(flatten) : values == null || values === false ? [] : [values]
const text = node => flatten(node.props?.children).map(child => typeof child === 'object' ? text(child) : String(child)).join('')
const nodes = node => {
  if (!node || typeof node !== 'object') return []
  if (typeof node.type === 'function') return nodes(node.type(node.props))
  return [node, ...flatten(node.props?.children).flatMap(nodes)]
}
const rule = selector => css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]+)\\}'))?.[1] ?? ''

// Native scroll bounds and focus reveal use controlled elements. Actual browser layout belongs to Root.
function fixture(t, { viewport = 220, nested = false, heights = {} } = {}) {
  const project = core.newProject('Shared scroll')
  if (nested) project.comps = { k1: { id: 'k1', name: 'Nested tracks', tracks: structuredClone(project.tracks) } }
  const store = { root: '/synthetic', project, openComp: nested ? 'k1' : null, trackHeight: heights, selTrack: null, selection: [], refs: [], highlight: new Map(), tool: 'select', scroll: 0, zoom: 100, snapping: false, playing: false }
  const scoped = scopedFactory(store), slots = [], effects = [], layouts = [], frames = [], drawCalls = [], refs = [], edits = [], menus = [], apiCalls = []
  let index = 0, tree, rendered, resize, forceCount = 0
  const useRef = initial => { const id = index++; return (slots[id] ??= { current: initial }) }
  const useState = initial => { const id = index++; slots[id] ??= { value: initial }; return [slots[id].value, next => { slots[id].value = typeof next === 'function' ? next(slots[id].value) : next; forceCount++ }] }
  const useEffect = (run, deps) => { const id = index++; if (!slots[id]) { slots[id] = { deps }; effects.push(() => { slots[id].cleanup = run() }) } }
  const useLayoutEffect = run => { index++; layouts.push(run) }
  const set = patch => Object.assign(store, typeof patch === 'function' ? patch(store) : patch)
  const viewProject = () => core.compView(store.project, store.openComp)
  const edit = op => { const ops = Array.isArray(op) ? op : [op]; edits.push(structuredClone(ops)); store.project = core.applyOps(store.project, scoped(ops)).project }
  const ctx = new Proxy({ measureText: value => ({ width: String(value).length * 6 }) }, { get(target, key) { return target[key] ?? ((...args) => drawCalls.push([key, ...args])) }, set(target, key, value) { target[key] = value; return true } })
  const canvas = { style: {}, getContext: () => ctx, getBoundingClientRect: () => ({ left: 168, top: 400 }), setPointerCapture() {} }
  const wrap = { clientWidth: 700, clientHeight: viewport }
  let nativeY = 0
  const scroller = { get scrollTop() { return nativeY }, set scrollTop(value) { nativeY = Math.max(0, Math.min(Math.max(0, module.rowsOf(viewProject()).height - wrap.clientHeight), value)) } }
  const module = factory({ h, htm, useEffect, useLayoutEffect, useRef, useState, ...core, addRef: ref => { refs.push(ref); store.refs.push(ref); store.chatOpen = true }, api: (...args) => { apiCalls.push(args); throw Error('No endpoint calls are allowed') }, edit, onTime: () => () => {}, set, store, subscribe: () => () => {}, time: { t: 1 }, toast: () => {}, useStore: () => store, useTime: () => 1, viewProject, openMenu: (...args) => menus.push(args), player: { seek() {} }, registry: { clipMenus: [] }, devicePixelRatio: 1, ResizeObserver: class { constructor(callback) { resize = callback } observe() {} disconnect() {} }, requestAnimationFrame: callback => { frames.push(callback); return frames.length } })
  const render = () => {
    index = 0; tree = module.Timeline(); rendered = nodes(tree)
    rendered.find(node => node.type === 'canvas').ref.current = canvas
    rendered.find(node => node.props?.class === 'tl-canvas').ref.current = wrap
    const scrollNode = rendered.find(node => node.props?.class === 'th-scroll')
    if (scrollNode) scrollNode.ref.current = scroller
    scroller.scrollTop = nativeY
    layouts.splice(0).forEach(run => run())
    return tree
  }
  const find = name => rendered.find(node => node.props?.class === name)
  const state = () => slots.find(slot => slot?.current && typeof slot.current.scrollY === 'number').current
  const wheel = (options = {}, overHeader = false) => {
    const event = { deltaY: 48, deltaX: 0, clientX: overHeader ? 80 : 268, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() { this.prevented = true }, ...options }
    const callback = tree.props.onWheel ?? (!overHeader && rendered.find(node => node.type === 'canvas').props.onWheel)
    callback?.(event); render(); return event
  }
  const nativeScroll = value => { scroller.scrollTop = value; find('th-scroll')?.props.onScroll?.({ currentTarget: scroller }); render() }
  const header = id => rendered.find(node => node.props?.class?.startsWith('th ') && nodes(node).some(child => child.type === 'b' && text(child) === id))
  render(); effects.splice(0).forEach(run => run()); resize()
  t.after(() => { slots.forEach(slot => slot?.cleanup?.()); assert.deepEqual(apiCalls, []) })
  return { module, store, viewProject, render, wheel, nativeScroll, find, header, scroller, state, refs, edits, menus, canvas, wrap, drawCalls, frames, forceCount: () => forceCount,
    draw() { drawCalls.length = 0; module.drawAll(canvas, state()); return drawCalls },
    resize(height) { wrap.clientHeight = height; scroller.scrollTop = nativeY; resize(); render() },
    focus(id, title) {
      const row = module.rowsOf(viewProject()).rows.find(row => row.track.id === id)
      const button = nodes(header(id)).find(node => node.type === 'button' && node.props.title === title)
      assert(button, 'The focused track control remains present')
      const top = row.y - module.RULER + Math.max(0, row.h / 2), bottom = top + 20
      const available = wrap.clientHeight - module.RULER
      if (top < nativeY) nativeScroll(top)
      else if (bottom > nativeY + available) nativeScroll(bottom - available)
      return button
    },
  }
}

test('header rows scroll below a fixed ruler without an independent translated offset', t => {
  const c = fixture(t)
  assert(c.find('th-scroll'))
  assert.equal(c.find('th-rows').props.style?.transform, undefined)
  assert.match(rule('.track-headers'), /overflow:\s*clip/)
  assert.match(rule('.th-scroll'), /inset:\s*30px 0 0/)
  assert.match(rule('.th-scroll'), /overflow-y:\s*auto/)
  assert.match(rule('.th-rows'), /position:\s*relative/)
  assert(c.find('track-headers').props.children.some(node => node.props?.class === 'th-ruler'))
})

test('native focus scroll updates the same canvas offset and hit testing', t => {
  const c = fixture(t), before = c.forceCount()
  c.focus('A3', 'Mute')
  assert(c.scroller.scrollTop > 0)
  assert.equal(c.state().scrollY, c.scroller.scrollTop)
  assert(c.forceCount() > before)
  assert(c.draw().some(call => call[0] === 'translate' && call[1] === 0 && call[2] === -c.scroller.scrollTop))
  const row = c.module.rowsOf(c.viewProject()).rows.find(row => row.track.id === 'A3')
  assert.equal(c.module.hitAt(c.viewProject(), 40, row.y + row.h / 2 - c.state().scrollY, c.state()).row.track.id, 'A3')
})

test('header and canvas wheel input share one vertical offset', t => {
  // Empty tracks are compact, so a shorter viewport keeps 80 pixels of scroll range.
  const c = fixture(t, { viewport: 120 })
  assert(c.wheel({ deltaY: 48 }, true).prevented)
  assert.equal(c.state().scrollY, 48)
  assert.equal(c.scroller.scrollTop, 48)
  c.wheel({ deltaY: 32 })
  assert.equal(c.state().scrollY, 80)
  assert.equal(c.scroller.scrollTop, 80)
  assert.equal(c.find('th-rows').props.style?.transform, undefined)
})

test('wheel input clamps to native bounds and a short timeline stays at zero', t => {
  const c = fixture(t), max = c.module.rowsOf(c.viewProject()).height - c.wrap.clientHeight
  c.wheel({ deltaY: 10000 }); assert.equal(c.scroller.scrollTop, max); assert.equal(c.state().scrollY, max)
  c.wheel({ deltaY: -10000 }); assert.equal(c.scroller.scrollTop, 0); assert.equal(c.state().scrollY, 0)
  c.resize(1000); c.wheel({ deltaY: 100 }); assert.equal(c.scroller.scrollTop, 0); assert.equal(c.state().scrollY, 0)
})

test('header row extents and the add controls match canvas layout for custom heights', t => {
  const c = fixture(t, { heights: { V3: 92, A2: 120 } })
  let y = c.module.RULER
  for (const row of c.module.rowsOf(c.viewProject()).rows) {
    assert.equal(row.y, y)
    const headerHeight = parseFloat(c.header(row.track.id).props.style.height)
    assert.equal(headerHeight, row.h + 2)
    y += headerHeight
  }
  assert.equal(y + 40, c.module.rowsOf(c.viewProject()).height)
  assert.match(rule('.th-add'), /height:\s*40px/)
})

test('the add-track controls remain reachable after native focus reveal', t => {
  const c = fixture(t)
  c.nativeScroll(10000)
  const buttons = nodes(c.find('th-add')).filter(node => node.type === 'button')
  assert.deepEqual(buttons.map(text), ['+ Video', '+ Audio'])
  buttons[1].props.onClick()
  assert.deepEqual(c.edits[0], [{ op: 'add_track', kind: 'audio' }])
})

test('Alt-click tags the visible scrolled track and leaves its control state intact', t => {
  const c = fixture(t)
  c.focus('A3', 'Solo')
  const before = structuredClone(c.viewProject().tracks)
  c.header('A3').props.onClick({ altKey: true })
  assert.deepEqual(c.refs, [{ kind: 'track', id: 'A3', label: 'track A3 Music' }])
  assert.equal(c.store.chatOpen, true)
  assert.deepEqual(c.viewProject().tracks, before)
  assert.equal(c.state().scrollY, c.scroller.scrollTop)
})

for (const [id, title, property] of [['A3', 'Solo', 'solo'], ['A3', 'Mute', 'muted'], ['A3', 'Lock track', 'locked'], ['V1', 'Hide track', 'hidden']]) test(`focused ${id} ${title} control still applies only its track operation`, t => {
  const c = fixture(t), button = c.focus(id, title)
  let stopped = false
  button.props.onClick({ stopPropagation() { stopped = true } })
  assert(stopped)
  assert.deepEqual(c.edits, [[{ op: 'update_track', id, set: { [property]: true } }]])
  assert.equal(c.viewProject().tracks.find(track => track.id === id)[property], true)
  assert.deepEqual(c.refs, [])
})

test('scrolling and tagging a nested track preserves the main timeline', t => {
  const c = fixture(t, { nested: true }), root = structuredClone(c.store.project.tracks)
  c.focus('A3', 'Mute')
  c.header('A3').props.onClick({ altKey: true })
  assert.equal(c.scroller.scrollTop, c.state().scrollY)
  assert.deepEqual(c.store.project.tracks, root)
  assert.equal(c.edits.length, 0)
  assert.equal(c.refs[0].id, 'A3')
})

test('resize adopts the clamped native scroll position and keeps the ruler fixed', t => {
  const c = fixture(t)
  c.nativeScroll(10000)
  c.resize(430)
  assert.equal(c.state().scrollY, c.scroller.scrollTop)
  assert.equal(c.scroller.scrollTop, Math.max(0, c.module.rowsOf(c.viewProject()).height - 430))
  assert.equal(c.find('th-ruler').props.style?.transform, undefined)
})

test('track deletion clamps to the new native content extent before drawing', t => {
  const c = fixture(t)
  c.nativeScroll(10000)
  c.store.project.tracks = c.store.project.tracks.filter(track => ['V1', 'A1'].includes(track.id))
  c.render()
  assert.equal(c.scroller.scrollTop, 0)
  assert.equal(c.state().scrollY, 0)
  assert(c.draw().some(call => call[0] === 'translate' && call[2] === 0))
})

test('fractional viewport sizes keep the exact shared native scroll offset', t => {
  const c = fixture(t, { viewport: 219.742, heights: { A3: 58.578 } })
  c.nativeScroll(10000)
  const expected = c.module.rowsOf(c.viewProject()).height - c.wrap.clientHeight
  assert.equal(c.scroller.scrollTop, expected)
  assert.equal(c.state().scrollY, expected)
  c.resize(320.125)
  assert.equal(c.state().scrollY, c.scroller.scrollTop)
})

test('header modified wheel input preserves horizontal scroll and anchors zoom at the canvas edge', t => {
  const c = fixture(t)
  c.wheel({ deltaY: 100, shiftKey: true }, true)
  assert.equal(c.store.scroll, 1)
  assert.equal(c.state().scrollY, 0)
  c.wheel({ deltaY: -40, ctrlKey: true }, true)
  assert(c.store.zoom > 100)
  assert.equal(c.store.scroll, 1)
  assert.equal(c.state().scrollY, 0)
})

test('native scroll changes request a redraw while repeated unchanged events do not', t => {
  const c = fixture(t), before = c.forceCount()
  c.nativeScroll(48)
  assert.equal(c.forceCount(), before + 1)
  c.nativeScroll(48)
  assert.equal(c.forceCount(), before + 1)
  assert(c.frames.length > 0)
})
