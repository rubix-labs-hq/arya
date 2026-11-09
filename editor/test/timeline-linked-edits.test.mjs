// The timeline's edge gestures follow the Linked selection toggle, and the roll gesture starts.
// These drive the real Timeline pointer handlers and keys.js with synthetic events. Before this
// change, pressing on an edit point with the trim tool threw in onDown, and with Linked selection
// off a roll of the audio edit still moved the picture cut.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'
import * as core from '../core/project.js'

const source = fs.readFileSync(new URL('../web/ui/timeline.js', import.meta.url), 'utf8')
const body = source.replace(/^import .*$/gm, '').replace(/^export function /gm, 'function ').replace(/^export \{.*\}\s*$/gm, '')
const factory = new Function('deps', 'matchMedia', `const {h,htm,useEffect,useLayoutEffect,useRef,useState,applyOps,clipEnd,duration,hasAudio,snapToFrame,timecode,MARKER_COLORS,addRef,api,edit,onTime,set,store,subscribe,time,toast,useStore,useTime,viewProject,openMenu,player,registry,devicePixelRatio,ResizeObserver,requestAnimationFrame,mediaDisplayName}=deps;${body};return {rowsOf,Timeline}`)

function project() {
  const p = core.newProject('Gestures')
  p.assets = { 'a.mp4': { duration: 60, width: 1920, height: 1080, hasVideo: true, hasAudio: true } }
  return core.applyOps(p, [{ op: 'append', src: 'a.mp4', in: 0, out: 4 }, { op: 'append', src: 'a.mp4', in: 10, out: 14 }]).project
}

function timeline({ linked, tool, locked = [], setup = () => {} }) {
  let p = project()
  setup(p)
  for (const track of p.tracks) if (locked.includes(track.id)) track.locked = true
  const edits = [], notices = []
  const store = { project: p, trackHeight: {}, selection: [], selTrack: null, tool, linked, zoom: 100, scroll: 0, snapping: false, highlight: new Map(), root: 'r', version: 1 }
  const deps = {
    ...core, h, htm, store, useStore: () => store, viewProject: () => p, useTime: () => 0, time: { t: 0 }, useRef: value => ({ current: value }), useState: () => [0, () => {}],
    useEffect: () => {}, useLayoutEffect: () => {}, subscribe: () => () => {}, onTime: () => () => {}, set: patch => Object.assign(store, typeof patch === 'function' ? patch(store) : patch),
    edit: ops => { edits.push(structuredClone(ops)); p = core.applyOps(p, ops).project }, api: () => {}, addRef: () => {}, toast: text => notices.push(text), openMenu: () => {}, player: { beginScrub() {}, endScrub() {} },
    registry: { clipMenus: [] }, devicePixelRatio: 1, ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 1, mediaDisplayName: s => s,
  }
  const { Timeline, rowsOf } = factory(deps, () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const find = node => {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'canvas') return node
    for (const child of [node.props?.children].flat()) { const found = find(child); if (found) return found }
    return null
  }
  const canvasNode = find(Timeline())
  canvasNode.ref.current = { getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {}, style: {} }
  const row = id => rowsOf(p).rows.find(r => r.track.id === id)
  const drag = (x0, y, x1, mods = {}) => {
    const event = (x, extra = {}) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, altKey: false, shiftKey: false, metaKey: false, ...mods, ...extra })
    canvasNode.props.onPointerDown(event(x0))
    for (let i = 1; i <= 5; i++) canvasNode.props.onPointerMove(event(x0 + ((x1 - x0) * i) / 5))
    canvasNode.props.onPointerMove(event(x1))
    canvasNode.props.onPointerUp(event(x1))
  }
  return { edits, notices, drag, row, project: () => p }
}

const span = (p, id) => { const c = p.tracks.flatMap(t => t.clips).find(x => x.id === id); return [c.start, c.dur, c.in] }

test('with Linked selection off, rolling the audio edit makes a J cut and leaves the picture cut', () => {
  const t = timeline({ linked: false, tool: 'trim' })
  const y = t.row('A1').y + 20
  t.drag(400, y, 300)
  assert.deepEqual(t.edits, [[{ op: 'roll', a: 'c1a', b: 'c2a', to: 3, unlinked: true }]])
  assert.deepEqual(span(t.project(), 'c1'), [0, 4, 0])
  assert.deepEqual(span(t.project(), 'c1a'), [0, 3, 0])
  assert.deepEqual(span(t.project(), 'c2a'), [3, 5, 9])
})

test('with Linked selection on, the same roll moves both cuts', () => {
  const t = timeline({ linked: true, tool: 'trim' })
  t.drag(400, t.row('A1').y + 20, 300)
  assert.deepEqual(t.edits, [[{ op: 'roll', a: 'c1a', b: 'c2a', to: 3 }]])
  assert.deepEqual(span(t.project(), 'c1'), [0, 3, 0])
  assert.deepEqual(span(t.project(), 'c2'), [3, 5, 9])
})

test('edge trims and slides send unlinked only when Linked selection is off', () => {
  const off = timeline({ linked: false, tool: 'select' })
  off.drag(395, off.row('A1').y + 20, 350) // the right edge of c1a with the select tool
  assert.equal(off.edits[0][0].op, 'trim')
  assert.equal(off.edits[0][0].unlinked, true)
  const slide = timeline({ linked: true, tool: 'slide' })
  slide.drag(150, slide.row('V1').y + 30, 200)
  assert.equal(slide.edits[0][0].op, 'slide')
  assert.equal('unlinked' in slide.edits[0][0], false)
})

test('the Blade tool on a locked clip explains instead of failing', () => {
  const t = timeline({ linked: true, tool: 'blade', locked: ['V1'] })
  t.drag(200, t.row('V1').y + 20, 200)
  assert.deepEqual(t.edits, [])
  assert.match(t.notices.at(-1), /Video 1 is locked/)
})

test('a locked linked partner neither clamps nor cancels a drag or Option-drag', () => {
  // c2a starts at 0 on a locked track; the unlocked c2 (4 to 8 s) drags 1 s left.
  const setup = p => {
    const audio = p.tracks.find(t => t.id === 'A1')
    audio.clips = audio.clips.filter(c => c.id !== 'c1a')
    audio.clips.find(c => c.id === 'c2a').start = 0
  }
  const move = timeline({ linked: true, tool: 'select', locked: ['A1'], setup })
  move.drag(600, move.row('V1').y + 20, 500)
  assert.deepEqual(move.edits.at(-1), [{ op: 'move', id: 'c2', start: 3, track: undefined, unlinked: false }])
  assert.equal(move.project().tracks.find(t => t.id === 'A1').clips.find(c => c.id === 'c2a').start, 0, 'the locked audio stays')
  const copy = timeline({ linked: true, tool: 'select', locked: ['A1'], setup })
  copy.drag(600, copy.row('V1').y + 20, 1000, { altKey: true, shiftKey: true }) // Option-click alone references the clip
  assert.deepEqual(copy.edits.at(-1).map(op => [op.op, op.id]), [['duplicate', 'c2']], 'the locked audio is not named')
  assert.equal(copy.project().tracks.find(t => t.id === 'V1').clips.length, 3)
})
