import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const editor = process.env.ARYA_LAYOUT_EDITOR_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(path.join(editor, 'package.json'))
const { h } = require('preact'), htm = require('htm')
const source = fs.readFileSync(path.join(editor, 'web/ui/layout.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
function fixture({ preferred = 360, outer = 360, client = 358, geometry = true } = {}) {
  let saved = { chat: preferred }, width = outer; const writes = [], properties = {}, events = new Map(), frames = new Map(); let frame = 0, capture = false
  const localStorage = { getItem: () => JSON.stringify(saved), setItem: (_key, value) => { saved = JSON.parse(value); writes.push(saved) } }
  const module = new Function('deps', `const { h,htm,useEffect,useReducer,useRef,useState,localStorage,requestAnimationFrame,cancelAnimationFrame }=deps;${source}\nreturn {Divider,editPaneSizes,editPaneResizePatch,layoutStyle}`)({ h, htm, useEffect() {}, useReducer: () => [0, () => {}], useRef: value => ({ current: value }), useState: value => [value, () => {}], localStorage, requestAnimationFrame: fn => { frames.set(++frame, fn); return frame }, cancelAnimationFrame: id => frames.delete(id) })
  const chat = { get clientWidth() { return width - (outer - client) }, ...(geometry ? { getBoundingClientRect: () => ({ width }) } : {}) }
  const app = { querySelector: selector => selector === '.chat' ? chat : null, style: { setProperty: (key, value) => { properties[key] = value; if (key === '--chat-width') width = parseFloat(value) } } }
  const handle = { closest: selector => selector === '.app' ? app : null, setPointerCapture() { capture = true }, hasPointerCapture: () => capture, releasePointerCapture() { capture = false }, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) }
  const divider = () => module.Divider({ field: 'chat', reverse: true })
  const key = value => { divider().props.onKeyDown({ key: value, currentTarget: handle, preventDefault() {}, stopPropagation() {} }); width = saved.chat }
  const begin = () => divider().props.onPointerDown({ button: 0, currentTarget: handle, pointerId: 1, clientX: 100, preventDefault() {} })
  const move = x => { events.get('pointermove')({ clientX: x }); for (const [id, run] of frames) { frames.delete(id); run() } }
  const finish = type => events.get(type)({ type })
  return { module, writes, properties, events, key, begin, move, finish, saved: () => saved, width: () => width }
}

test('assistant Right then Left restores the measured border width exactly', () => {
  const f = fixture(); f.key('ArrowRight'); assert.equal(f.saved().chat, 344); f.key('ArrowLeft'); assert.equal(f.saved().chat, 360)
})
test('assistant keyboard resize starts at the visible width when CSS caps the preference', () => {
  const f = fixture({ preferred: 700, outer: 400, client: 398 }); f.key('ArrowRight'); assert.equal(f.saved().chat, 384)
})
test('fractional assistant geometry survives inverse keyboard steps', () => {
  const f = fixture({ preferred: 360.5, outer: 360.5, client: 358 }); f.key('ArrowRight'); f.key('ArrowLeft'); assert.equal(f.saved().chat, 360.5)
})
test('assistant drag uses visible border width as the starting point', () => {
  const f = fixture(); f.begin(); f.move(110); f.finish('pointerup'); assert.equal(f.saved().chat, 350); assert.equal(f.width(), 350); assert.equal(f.events.size, 0)
})
for (const type of ['pointercancel', 'lostpointercapture']) test(`${type} restores the preferred assistant width after preview`, () => {
  const f = fixture(); f.begin(); f.move(120); f.finish(type); assert.equal(f.saved().chat, 360); assert.equal(f.width(), 360); assert.equal(f.events.size, 0)
})
test('dragging back to the origin retains the saved assistant preference', () => {
  const f = fixture(); f.begin(); f.move(120); f.move(100); f.finish('pointerup'); assert.equal(f.saved().chat, 360)
})
test('missing chat geometry falls back to the saved preference', () => {
  const f = fixture({ geometry: false }); f.key('ArrowRight'); assert.equal(f.saved().chat, 344)
})
test('invalid chat geometry falls back to the saved preference', () => {
  const f = fixture({ outer: NaN, client: NaN }); f.key('ArrowRight'); assert.equal(f.saved().chat, 344)
})
test('assistant resizing keeps its existing preference limits', () => {
  const small = fixture({ preferred: 160, outer: 160, client: 158 }); small.key('ArrowRight'); assert.equal(small.saved().chat, 160)
  const large = fixture({ preferred: 700, outer: 700, client: 698 }); large.key('ArrowLeft'); assert.equal(large.saved().chat, 700)
})
test('a crowded media resize intentionally budgets its inspector neighbor', () => {
  const f = fixture(), value = { media: 260, inspector: 300 }, sizes = f.module.editPaneSizes(value, 896), patch = f.module.editPaneResizePatch(value, 896, 'media', 276)
  assert.equal(sizes.media, 260); assert.equal(sizes.inspector, 300); assert.deepEqual(patch, { media: 276, inspector: 288 })
  assert.deepEqual(f.module.editPaneResizePatch({ ...value, ...patch }, 896, 'media', 260), { media: 260, inspector: 288 })
})
test('narrow pane calculation preserves user widths and maintains the viewer minimum', () => {
  const f = fixture(), value = Object.freeze({ media: 260, inspector: 300 }), sizes = f.module.editPaneSizes(value, 780)
  assert.equal(value.media, 260); assert.equal(value.inspector, 300); assert.ok(sizes.viewer + 1e-8 >= sizes.viewerMinimum); assert.ok(sizes.media >= 160); assert.ok(sizes.inspector >= 160)
})
