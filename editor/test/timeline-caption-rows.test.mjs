// Caption tracks get a timeline row above the picture, so their cues can be seen and edited.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'
import * as core from '../core/project.js'

const source = fs.readFileSync(new URL('../web/ui/timeline.js', import.meta.url), 'utf8')
const body = source.replace(/^import .*$/gm, '').replace(/^export function /gm, 'function ').replace(/^export \{.*\}\s*$/gm, '')
const factory = new Function('deps', 'matchMedia', `const {h,htm,useEffect,useLayoutEffect,useRef,useState,applyOps,clipEnd,duration,hasAudio,snapToFrame,timecode,MARKER_COLORS,addRef,api,edit,onTime,set,store,subscribe,time,toast,useStore,useTime,viewProject,openMenu,player,registry,devicePixelRatio,ResizeObserver,requestAnimationFrame}=deps;${body};return {rowsOf}`)

test('caption tracks have a row above the video tracks', () => {
  const project = core.applyOps(core.newProject('Captions'), [{ op: 'captions', items: [{ t: 0, end: 2, text: 'Hello' }] }]).project
  const store = { project, trackHeight: {}, selection: [], selTrack: null, tool: 'select' }
  const deps = { ...core, h, htm, store, useStore: () => store, viewProject: () => project, useTime: () => 0, time: { t: 0 }, useRef: value => ({ current: value }), useState: () => [0, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, subscribe: () => () => {}, onTime: () => () => {}, set: () => {}, edit: () => {}, api: () => {}, addRef: () => {}, toast: () => {}, openMenu: () => {}, player: {}, registry: { clipMenus: [] }, devicePixelRatio: 1, ResizeObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 1 }
  const { rowsOf } = factory(deps, () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const rows = rowsOf(project).rows
  assert.deepEqual(rows.map(r => r.track.id), ['C1', 'V3', 'V2', 'V1', 'A1', 'A2', 'A3'])
  assert.equal(rows[0].h, 40)
  assert.equal(rows[0].track.clips[0].text, 'Hello')
})
