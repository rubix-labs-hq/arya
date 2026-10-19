// Layers created without a named track (the assistant, the title browser, "Add title here")
// go on top without covering a layer that is already there at that time.
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyOps, newProject } from '../core/project.js'

const where = (p, id) => p.tracks.find(t => t.clips.some(c => c.id === id))

test('a shape added over a title at the same time gets a new track on top', () => {
  let p = applyOps(newProject('layers'), [{ op: 'add_title', text: 'Title', start: 0, dur: 2 }]).project
  const title = p.tracks.find(t => t.id === 'V3').clips[0].id
  p = applyOps(p, [{ op: 'add_shape', shape: { type: 'rect' }, start: 0, dur: 2 }, { op: 'add_null', start: 1, dur: 2 }]).project
  const tracks = ['c1', 'c2', 'c3'].map(id => where(p, id).id)
  assert.equal(new Set(tracks).size, 3, 'each overlapping layer has its own track')
  assert.equal(where(p, title).id, 'V3')
  const video = p.tracks.filter(t => t.kind === 'video').map(t => t.id)
  assert.deepEqual(video, ['V1', 'V2', 'V3', 'V4', 'V5'])
  assert.equal(where(p, 'c3').id, 'V5', 'the newest layer is the top one')
})

test('a layer at a free time reuses the top track; a named track is used as given', () => {
  let p = applyOps(newProject('layers'), [{ op: 'add_title', text: 'One', start: 0, dur: 2 }, { op: 'add_title', text: 'Two', start: 3, dur: 2 }]).project
  assert.equal(p.tracks.filter(t => t.kind === 'video').length, 3)
  assert.deepEqual(p.tracks.find(t => t.id === 'V3').clips.map(c => c.title.text), ['One', 'Two'])
  p = applyOps(p, [{ op: 'add_shape', shape: { type: 'rect' }, start: 0, dur: 2, track: 'V3' }]).project
  assert.equal(p.tracks.find(t => t.id === 'V3').clips.length, 3)
})

test('inside a composition the new track is added to that composition', () => {
  let p = applyOps(newProject('layers'), [{ op: 'add_comp', name: 'Card' }]).project
  p = applyOps(p, [{ op: 'add_title', comp: 'k1', text: 'A', start: 0, dur: 2 }, { op: 'add_title', comp: 'k1', text: 'B', start: 0, dur: 2 }]).project
  assert.deepEqual(p.comps.k1.tracks.filter(t => t.kind === 'video').map(t => t.id), ['V1', 'V2', 'V3', 'V4'])
  assert.deepEqual(p.tracks.filter(t => t.kind === 'video').map(t => t.id), ['V1', 'V2', 'V3'])
})
