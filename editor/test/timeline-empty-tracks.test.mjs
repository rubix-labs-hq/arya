import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'
import * as core from '../core/project.js'

const source = fs.readFileSync(new URL('../web/ui/timeline.js', import.meta.url), 'utf8')
const body = source.replace(/^import .*$/gm, '').replace(/^export function /gm, 'function ').replace(/^export \{.*\}\s*$/gm, '')
const factory = new Function('deps', 'matchMedia', `const {h,htm,useEffect,useLayoutEffect,useRef,useState,applyOps,clipEnd,duration,hasAudio,snapToFrame,timecode,MARKER_COLORS,addRef,api,edit,onTime,set,store,subscribe,time,toast,useStore,useTime,viewProject,openMenu,player,registry,devicePixelRatio,ResizeObserver,requestAnimationFrame}=deps;${body};return {rowsOf,TrackHeader,drawClip,hitAt,drawAll}`)

function fixture(trackHeight = {}) {
  const project = core.newProject('Empty tracks', { width: 1920, height: 1080, fps: 30 })
  const store = { project, trackHeight, selection: [], selTrack: null, tool: 'select', highlight: new Map(), scroll: 0, zoom: 100 }
  const pointer = { matches: false, addEventListener() {}, removeEventListener() {} }
  const menus = []
  const deps = { ...core, h, htm, store, useStore: () => store, viewProject: () => project, useTime: () => 0, time: { t: 0 }, useRef: value => ({ current: value }), useState: value => [value, () => {}], useEffect() {}, useLayoutEffect() {}, subscribe: () => () => {}, onTime: () => () => {}, set: patch => Object.assign(store, typeof patch === 'function' ? patch(store) : patch), edit() {}, api() {}, addRef() {}, toast() {}, openMenu: (x, y, items) => menus.push(items), player: {}, registry: { clipMenus: [] }, devicePixelRatio: 1, ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 1 }
  return { module: factory(deps, () => pointer), project, store, pointer, menus }
}
const heights = f => Object.fromEntries(f.module.rowsOf(f.project).rows.map(row => [row.track.id, row.h]))

test('empty tracks sit at a compact height and tracks with clips keep the full one', () => {
  const f = fixture()
  for (const h of Object.values(heights(f))) assert.equal(h, 34)
  f.project.tracks.find(t => t.id === 'V1').clips.push({ id: 'c1', kind: 'color', color: '#000000', start: 0, dur: 2 })
  f.project.tracks.find(t => t.id === 'A1').clips.push({ id: 'c2', kind: 'audio', src: 'tone.wav', start: 0, dur: 2 })
  const rows = heights(f)
  assert.equal(rows.V1, 66)
  assert.equal(rows.A1, 54)
  assert.equal(rows.V2, 34)
  assert.equal(rows.A2, 34)
})

test('a height chosen with Taller or Shorter wins over the empty default, and touch keeps 70 pixels', () => {
  const f = fixture({ V2: 90, A1: 40 })
  const rows = heights(f)
  assert.equal(rows.V2, 90)
  assert.equal(rows.A1, 40)
  f.pointer.matches = true
  for (const h of Object.values(heights(f))) assert.ok(h >= 70)
})

test('row positions stay contiguous with mixed heights', () => {
  const f = fixture()
  f.project.tracks.find(t => t.id === 'V1').clips.push({ id: 'c1', kind: 'color', color: '#000000', start: 0, dur: 2 })
  let y = 30
  for (const row of f.module.rowsOf(f.project).rows) { assert.equal(row.y, y); y += row.h + 2 }
  assert.equal(f.module.rowsOf(f.project).height, y + 40)
})

test('track headers draw eye and lock icons instead of emoji and keep their names and states', () => {
  const f = fixture()
  const walk = (node, out = []) => { if (Array.isArray(node)) node.forEach(n => walk(n, out)); else if (node && typeof node === 'object') { out.push(node); walk(node.props?.children, out) } return out }
  const strings = node => walk(node).flatMap(n => [n.props?.children].flat()).filter(c => typeof c === 'string').join('')
  for (const [id, set, label, pressed] of [['V1', {}, 'Hide V1', false], ['V2', { hidden: true }, 'Hide V2', true], ['V3', { locked: true }, 'Lock V3', true]]) {
    Object.assign(f.project.tracks.find(t => t.id === id), set)
    const row = f.module.rowsOf(f.project).rows.find(r => r.track.id === id)
    const header = f.module.TrackHeader({ row, p: f.project })
    const button = walk(header).find(n => n.type === 'button' && n.props['aria-label'] === label)
    assert.ok(button, label)
    assert.equal(button.props['aria-pressed'], pressed)
    assert.equal(walk(button).filter(n => n.type === 'svg').length, 1, `${label} draws one icon`)
    assert.doesNotMatch(strings(header), /[🔒🔓◉◌]/u)
  }
})

test('short rows put the track name and buttons on one line', () => {
  const f = fixture()
  const [slim] = f.module.rowsOf(f.project).rows
  assert.match(f.module.TrackHeader({ row: slim, p: f.project }).props.class, /\bslim\b/)
  const tall = { ...slim, h: 66 }
  assert.doesNotMatch(f.module.TrackHeader({ row: tall, p: f.project }).props.class, /\bslim\b/)
  const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.th\.slim \{ flex-direction: row;/)
})

test('a title clip shows its text once, in the label bar, unless the clip has its own name', () => {
  const f = fixture()
  const draw = clip => {
    const texts = []
    const ctx = new Proxy({ measureText: value => ({ width: String(value).length * 6 }), fillText: text => texts.push(text) }, { get(target, key) { return target[key] ?? (() => {}) }, set(target, key, value) { target[key] = value; return true } })
    const row = f.module.rowsOf(f.project).rows[0]
    f.module.drawClip(ctx, f.project, clip, row, { width: 800, height: 300, scrollY: 0, hover: null, drag: null })
    return texts.filter(text => text.includes('Morning'))
  }
  const title = { id: 'c1', kind: 'title', start: 0, dur: 4, title: { text: 'Morning walk' } }
  assert.deepEqual(draw(title), ['T  Morning walk'])
  assert.deepEqual(draw({ ...title, label: 'Opening card' }), ['Morning walk'])
})

test('rows keep their committed heights while a drag preview moves the only clip to an empty track', () => {
  const f = fixture()
  f.project.tracks.find(t => t.id === 'V1').clips.push({ id: 'c1', kind: 'color', color: '#000000', start: 0, dur: 2 })
  const committed = f.module.rowsOf(f.project).rows.map(r => [r.track.id, r.y, r.h])
  // The preview the timeline draws mid-drag: c1 now sits on V2 and V1 is empty.
  const preview = core.applyOps(f.project, [{ op: 'move', id: 'c1', track: 'V2', start: 0 }]).project
  assert.equal(preview.tracks.find(t => t.id === 'V2').clips.length, 1)
  assert.equal(preview.tracks.find(t => t.id === 'V1').clips.length, 0)
  assert.deepEqual(f.module.rowsOf(preview).rows.map(r => [r.track.id, r.y, r.h]), committed)
  // The lane under the pointer is the drop track at every height of the committed rows.
  const state = { scrollY: 0 }
  for (const [id, y, h] of committed) for (const at of [y + 1, y + h / 2, y + h - 1]) assert.equal(f.module.hitAt(f.project, 40, at, state).row?.track.id, id, `${id} at ${at}`)
})

test('Taller and Shorter on an empty track step from its full height', () => {
  const f = fixture()
  const menuOf = id => {
    const row = f.module.rowsOf(f.project).rows.find(r => r.track.id === id)
    f.module.TrackHeader({ row, p: f.project }).props.onContextMenu({ preventDefault() {}, clientX: 0, clientY: 0 })
    return Object.fromEntries(f.menus.at(-1).filter(item => item.label).map(item => [item.label, item.run]))
  }
  menuOf('V2').Taller()
  assert.equal(f.store.trackHeight.V2, 90)
  menuOf('V3').Shorter()
  assert.equal(f.store.trackHeight.V3, 42)
  menuOf('A2').Shorter()
  assert.equal(f.store.trackHeight.A2, 30)
  menuOf('V2').Taller()
  assert.equal(f.store.trackHeight.V2, 114, 'a set height steps from itself')
})

test('clip labels draw with the alphabetic baseline on every frame, not the top baseline the ruler leaves', () => {
  const f = fixture()
  f.project.tracks.find(t => t.id === 'V1').clips.push({ id: 'c1', kind: 'color', color: '#000000', start: 0, dur: 2, label: 'Plate' })
  const labels = []
  const ctx = new Proxy({ measureText: value => ({ width: String(value).length * 6 }), fillText(text) { if (text === 'Plate') labels.push(this.textBaseline ?? 'alphabetic') } }, { get(target, key) { return target[key] ?? (() => {}) }, set(target, key, value) { target[key] = value; return true } })
  const canvas = { getContext: () => ctx }
  const state = { width: 800, height: 300, scrollY: 0, hover: null, drag: null }
  f.module.drawAll(canvas, state)
  f.module.drawAll(canvas, state)
  assert.deepEqual(labels, ['alphabetic', 'alphabetic'])
})
