// The clip menu on a locked clip offers only what can work, and Detach audio puts the clip's
// own audio under it with the same timing and direction instead of at the end of the track.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'
import * as core from '../core/project.js'

const source = fs.readFileSync(new URL('../web/ui/timeline.js', import.meta.url), 'utf8')
const body = source.replace(/^import .*$/gm, '').replace(/^export function /gm, 'function ').replace(/^export \{.*\}\s*$/gm, '')
const factory = new Function('deps', 'matchMedia', `const {h,htm,useEffect,useLayoutEffect,useRef,useState,applyOps,clipEnd,duration,hasAudio,snapToFrame,timecode,MARKER_COLORS,addRef,api,edit,onTime,set,store,subscribe,time,toast,useStore,useTime,viewProject,openMenu,player,registry,devicePixelRatio,ResizeObserver,requestAnimationFrame,mediaDisplayName}=deps;${body};return {clipMenu,detachAudio}`)

function menu(p, selection) {
  const edits = [], notices = []
  const store = { project: p, selection, linked: true, root: 'r', version: 1, caps: { host: 'browser-local' } }
  const deps = {
    ...core, h, htm, store, set: patch => Object.assign(store, patch), time: { t: 3 }, edit: ops => edits.push(structuredClone(ops)),
    toast: text => notices.push(text), addRef() {}, registry: { clipMenus: [] }, mediaDisplayName: s => s,
  }
  return { ...factory(deps, () => ({ matches: false })), edits, notices }
}

function fixture() {
  const p = core.newProject('Menu')
  p.assets['m.mp4'] = { hasVideo: true, hasAudio: true, duration: 30, fps: 30 }
  p.tracks = [
    { id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'video', src: 'm.mp4', start: 2, dur: 4, in: 3, speed: 1, reverse: true }] },
    { id: 'A1', kind: 'audio', clips: [{ id: 'x', kind: 'audio', src: 'm.mp4', start: 10, dur: 2, in: 0 }] },
  ]
  return p
}

test('the clip menu on a locked clip says it is locked and offers no edits', () => {
  const p = fixture()
  p.tracks[0].locked = true
  const m = menu(p, ['c1'])
  const items = m.clipMenu(p, { clip: p.tracks[0].clips[0] }, 3)
  assert.match(items[0].label, /V1 is locked/)
  assert.equal(items[0].disabled, true)
  assert.deepEqual(items.filter(it => it.label).map(it => it.label).slice(1), ['Copy'])
})

test('Detach audio places matching reversed audio under the clip and mutes the picture', () => {
  const p = fixture()
  const m = menu(p, ['c1'])
  const item = m.clipMenu(p, { clip: p.tracks[0].clips[0] }, 3).find(it => it.label === 'Detach audio')
  item.run()
  const after = core.applyOps(p, m.edits[0]).project
  const audio = after.tracks[1].clips.find(c => c.id !== 'x')
  assert.deepEqual({ kind: audio.kind, start: audio.start, dur: audio.dur, in: audio.in, reverse: audio.reverse }, { kind: 'audio', start: 2, dur: 4, in: 3, reverse: true })
  assert.equal(after.tracks[0].clips.length, 1, 'no extra video clip')
  assert.equal(after.tracks[0].clips[0].audioDetached, true)
  assert.equal(m.clipMenu(after, { clip: after.tracks[0].clips[0] }, 3).some(it => it.label === 'Detach audio'), false)
})
