import assert from 'node:assert/strict'
import test from 'node:test'

import { applyOps, newProject } from '../core/project.js'

function withMedia() {
  return applyOps(newProject('still durations', { fps: 30 }), [{ op: 'import', assets: {
    'logo.png': { width: 200, height: 100, hasVideo: true, still: true },
    'probed-still.png': { duration: 1, hasVideo: true, still: true },
    'take.mp4': { duration: 10, hasVideo: true },
  } }]).project
}

test('still clips honor explicit durations and out points beyond five seconds', () => {
  const p = applyOps(withMedia(), [
    { op: 'add_clip', src: 'logo.png', track: 'V1', dur: 12 },
    { op: 'append', src: 'probed-still.png', track: 'V1', dur: 6 },
    { op: 'append', src: 'logo.png', track: 'V1', in: 2, out: 10 },
    { op: 'add_comp', name: 'End card', duration: 6 },
    { op: 'add_clip', src: 'logo.png', comp: 'k1', track: 'V1', dur: 6 },
  ]).project
  assert.deepEqual(p.tracks.find(t => t.id === 'V1').clips.map(c => c.dur), [12, 6, 8])
  assert.equal(p.comps.k1.tracks.find(t => t.id === 'V1').clips[0].dur, 6)
})

test('still clips default to five seconds while video clips retain source limits', () => {
  const p = applyOps(withMedia(), [
    { op: 'add_clip', src: 'logo.png', track: 'V1' },
    { op: 'append', src: 'probed-still.png', track: 'V1' },
    { op: 'append', src: 'take.mp4', track: 'V1', in: 2, dur: 12 },
  ]).project
  assert.deepEqual(p.tracks.find(t => t.id === 'V1').clips.map(c => c.dur), [5, 5, 8])
  assert.ok(p.tracks.find(t => t.id === 'V1').clips.every(c => Number.isFinite(c.dur)))
})
