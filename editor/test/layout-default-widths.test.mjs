import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'
import { defaultWidth, effectiveLayout, keepDefaults, migrateLegacyLayout } from '../web/ui/layout.js'

const follow = { media: null, inspector: null, chat: null, upper: 52, showMedia: true, showInspector: true, showTimeline: true, mediaSide: 'left' }

test('default pane widths hold at 1440 and grow on wider windows', () => {
  for (const [viewport, media, inspector, chat] of [[1280, 260, 300, 360], [1440, 260, 300, 360], [1680, 290, 330, 380], [1920, 320, 360, 400], [2560, 360, 400, 440], [3840, 360, 400, 440]]) {
    assert.deepEqual([defaultWidth('media', viewport), defaultWidth('inspector', viewport), defaultWidth('chat', viewport)], [media, inspector, chat], `${viewport}`)
  }
})

test('a null width follows the window and any number stays as set, including the old defaults', () => {
  assert.deepEqual(effectiveLayout(follow, 1920), { ...follow, media: 320, inspector: 360, chat: 400 })
  assert.deepEqual(effectiveLayout({ ...follow, chat: 360 }, 2560).chat, 360, 'a dragged 360 pixel Assistant stays 360 on a 2560 window')
  assert.deepEqual(effectiveLayout({ ...follow, media: 260 }, 1920).media, 260)
  assert.equal(effectiveLayout(follow, 1920).upper, 52, 'non-width fields pass through')
})

test('a v1 layout turns its untouched fixed defaults into follow-the-window once', () => {
  assert.deepEqual(migrateLegacyLayout({ media: 260, inspector: 300, chat: 360, upper: 60 }), { media: null, inspector: null, chat: null, upper: 60 })
  assert.deepEqual(migrateLegacyLayout({ media: 280, inspector: 300, chat: 410 }), { media: 280, inspector: null, chat: 410 })
})

test('a resize keeps an untouched neighbour following the window, but saves one the resize changed', () => {
  const shown = effectiveLayout(follow, 1920)
  assert.deepEqual(keepDefaults({ media: 380, inspector: 360 }, 'media', follow, shown), { media: 380 })
  assert.deepEqual(keepDefaults({ media: 380, inspector: 330 }, 'media', follow, shown), { media: 380, inspector: 330 })
  assert.deepEqual(keepDefaults({ media: 380, inspector: 360 }, 'media', { ...follow, inspector: 360 }, shown), { media: 380, inspector: 360 }, 'a width the user set is saved as it is')
  assert.deepEqual(keepDefaults({ chat: 344 }, 'chat', follow, shown), { chat: 344 })
})

// The real Divider and storage, on a 2560 pixel window, with the measured Assistant width.
const source = fs.readFileSync(new URL('../web/ui/layout.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
function wide(stored, legacy) {
  const saved = new Map(Object.entries({ ...(stored ? { 'reel.workspace.v2': JSON.stringify(stored) } : {}), ...(legacy ? { 'reel.workspace.v1': JSON.stringify(legacy) } : {}) }))
  const localStorage = { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) }
  const previous = globalThis.innerWidth
  globalThis.innerWidth = 2560
  const module = new Function('deps', `const { h,htm,useEffect,useReducer,useRef,useState,localStorage,requestAnimationFrame,cancelAnimationFrame }=deps;${source}\nreturn {Divider,useLayout}`)({ h, htm, useEffect() {}, useReducer: () => [0, () => {}], useRef: value => ({ current: value }), useState: value => [value, () => {}], localStorage, requestAnimationFrame: fn => { fn(); return 1 }, cancelAnimationFrame() {} })
  let width = module.useLayout().chat
  const events = new Map()
  const chat = { getBoundingClientRect: () => ({ width }) }
  const app = { querySelector: selector => selector === '.chat' ? chat : null, style: { setProperty: (name, value) => { if (name === '--chat-width') width = parseFloat(value) } } }
  let capture = false
  const handle = { closest: selector => selector === '.app' ? app : null, setPointerCapture() { capture = true }, hasPointerCapture: () => capture, releasePointerCapture() { capture = false }, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) }
  const divider = () => module.Divider({ field: 'chat', reverse: true })
  return {
    restore: () => { globalThis.innerWidth = previous },
    stored: () => JSON.parse(saved.get('reel.workspace.v2') ?? 'null'),
    shown: () => module.useLayout().chat,
    key: name => { divider().props.onKeyDown({ key: name, currentTarget: handle, preventDefault() {}, stopPropagation() {} }); width = module.useLayout().chat },
    drag: dx => { divider().props.onPointerDown({ button: 0, currentTarget: handle, pointerId: 1, clientX: 100, preventDefault() {} }); events.get('pointermove')({ clientX: 100 + dx }); events.get('pointerup')({ type: 'pointerup' }); width = module.useLayout().chat },
    reset: () => { divider().props.onDblClick(); width = module.useLayout().chat },
  }
}

test('keyboard steps on the Assistant divider at 2560 keep shrinking past the old 360 default', () => {
  const f = wide({})
  try {
    assert.equal(f.shown(), 440)
    const seen = []
    for (let i = 0; i < 7; i++) { f.key('ArrowRight'); seen.push(f.shown()) }
    assert.deepEqual(seen, [424, 408, 392, 376, 360, 344, 328])
    assert.equal(f.stored().chat, 328)
  } finally { f.restore() }
})

test('a drag that ends on exactly 360 stays 360 at 2560, and double-click returns to the growing default', () => {
  const f = wide({})
  try {
    f.drag(80)
    assert.equal(f.stored().chat, 360)
    assert.equal(f.shown(), 360)
    f.reset()
    assert.equal(f.stored().chat, null)
    assert.equal(f.shown(), 440)
  } finally { f.restore() }
})

test('an old v1 layout with the fixed defaults grows on wide windows after it loads', () => {
  const f = wide(null, { media: 260, inspector: 300, chat: 360, upper: 60 })
  try {
    assert.equal(f.shown(), 440)
    f.key('ArrowRight')
    assert.equal(f.stored().chat, 424)
    assert.equal(f.stored().upper, 60, 'the rest of the v1 layout carries over')
  } finally { f.restore() }
})
