import assert from 'node:assert/strict'
import test from 'node:test'
import { applyOps, compView, newProject } from '../core/project.js'
import { magneticOps, mediaDropPosition } from '../web/ui/magnetic.js'

function fixture(nested) {
  const root = newProject('Cuts', { fps: 30 })
  const video = [0, 2, 4].map((start, i) => ({ id: 'shot' + i, kind: 'color', start, dur: 2, link: 'pair' + i }))
  const tracks = [
    { id: 'V1', kind: 'video', clips: video }, { id: 'V2', kind: 'video', clips: [] },
    { id: 'A1', kind: 'audio', clips: video.map(c => ({ ...c, kind: 'audio', id: c.id + 'a', start: c.start + 0.5 })) },
    { id: 'A2', kind: 'audio', locked: true, clips: [{ id: 'locked', kind: 'audio', start: 1, dur: 1, link: 'pair1' }] },
  ]
  if (nested) root.comps = { sequence: { tracks, fps: 30, width: 1280, height: 720 } }
  else root.tracks = tracks
  root.assets['still.png'] = { hasVideo: true, still: true }
  return root
}

for (const scope of [null, 'sequence']) {
  test(`Magnetic edits pack the primary track and preserve sync in ${scope ?? 'main'}`, () => {
    const p = fixture(scope)
    const view = compView(p, scope)
    const check = (op, at, expected) => {
      const plan = magneticOps(view, [op], { at, applyOps, project: p })
      const result = applyOps(p, plan).project
      if (scope) assert.deepEqual(result.tracks, p.tracks)
      const [video, , audio, locked] = compView(result, scope).tracks
      assert.deepEqual(video.clips.map(c => c.id), expected)
      let cursor = 0
      for (const c of video.clips) {
        assert.equal(c.start, cursor)
        if (c.link) assert.equal(audio.clips.find(a => a.link === c.link).start, cursor + 0.5)
        cursor += c.dur
      }
      assert.deepEqual(locked.clips, view.tracks[3].clips)
    }
    check({ op: 'move', id: 'shot0', start: 3 }, 3.5, ['shot1', 'shot0', 'shot2'])
    check({ op: 'move', id: 'shot2', start: 0 }, 0, ['shot2', 'shot0', 'shot1'])
    check({ op: 'move', id: 'shot1', track: 'V2', start: 3 }, 3, ['shot0', 'shot2'])
    check({ op: 'lift', ids: ['shot1'] }, null, ['shot0', 'shot2'])
    check({ op: 'trim', id: 'shot1', edge: 'right', to: 3, ripple: true }, null, ['shot0', 'shot1', 'shot2'])
    check({ op: 'add_clip', src: 'still.png', track: 'V1', start: 2 }, 2, ['shot0', 'c1', 'shot1', 'shot2'])
  })
}

test('drop marker and commit share the insertion position, including the last cut and locked tracks', () => {
  const p = fixture(null)
  const [primary, upper, audio, locked] = p.tracks
  for (const [cursor, expected] of [[0.1, 0], [1.8, 2], [3.4, 4], [12, 6]]) {
    assert.deepEqual(mediaDropPosition(p, 'video', primary, cursor, true), { track: primary, at: expected })
  }
  assert.deepEqual(mediaDropPosition(p, 'video', primary, 1.8, false), { track: primary, at: 1.8 })
  assert.deepEqual(mediaDropPosition(p, 'video', upper, 1.8, true), { track: upper, at: 1.8 })
  assert.deepEqual(mediaDropPosition(p, 'audio', primary, 1.8, true), { track: audio, at: 1.8 })
  assert.equal(mediaDropPosition(p, 'audio', locked, 1, true), null)
})
