import assert from 'node:assert/strict'
import test from 'node:test'
import { applyOps, newProject } from '../core/project.js'
import { describeStep, PREVIEW_STEP_ROUTES, PREVIEW_STEP_WAITS } from '../core/assistant-steps.js'

const score = { version: 1, title: 'Warm bed', bpm: 120, lengthBeats: 16, parts: [{ id: 'p1', instrument: 'pad', notes: [{ at: 0, duration: 4, pitch: 60 }] }] }

function project() {
  const p = newProject('Steps', { width: 1920, height: 1080, fps: 30 })
  p.assets['media/a.mp4'] = { duration: 20, width: 1920, height: 1080, hasVideo: true, hasAudio: true }
  p.assets['media/voice.wav'] = { duration: 20, hasVideo: false, hasAudio: true }
  return applyOps(p, [
    { op: 'append', src: 'media/a.mp4', track: 'V1', dur: 10, audio: false },
    { op: 'append', src: 'media/voice.wav', track: 'A1', dur: 10 },
  ]).project
}

test('every preview step route names what it produces and where it lands', () => {
  const p = project()
  assert.deepEqual(PREVIEW_STEP_WAITS.filter(path => !PREVIEW_STEP_ROUTES.includes(path)), [])
  const stabilize = describeStep(p, { path: '/api/stabilize/render', body: { src: 'media/a.mp4', clip: 'c1', dur: 10, zoom: 1.2 } })
  assert.deepEqual(stabilize, { title: 'Stabilize (deshake render)', produces: 'A steadied 10 s copy of a.mp4 in media/stabilized, zoomed 1.2x to hide moving edges.', lands: 'Replaces the picture of a.mp4 (c1) on V1 at 00:00:00:00. Timing stays the same.',
    body: { src: 'media/a.mp4', clip: 'c1', dur: 10, zoom: 1.2 } })
  const retime = describeStep(p, { path: '/api/retime', body: { src: 'media/a.mp4', clip: 'c1', dur: 10, speed: 0.25 } })
  assert.match(retime.produces, /A new 40 s video in media\/retimed from a\.mp4 00:00:00:00 to 00:00:10:00\./)
  assert.match(retime.lands, /plays at 25% and becomes 40 s long/)
  const denoise = describeStep(p, { path: '/api/video/denoise', body: { clip: 'c1', comp: null } })
  assert.match(denoise.lands, /Replaces the picture of a\.mp4 \(c1\)/)
  const clean = describeStep(p, { path: '/api/audio/clean', body: { src: 'media/voice.wav', clip: 'c2', mode: 'voice' } })
  assert.equal(clean.title, 'Voice cleanup'); assert.match(clean.lands, /Replaces the sound of voice\.wav \(c2\) on A1/)
  assert.equal(describeStep(p, { path: '/api/audio/clean', body: { src: 'media/voice.wav' } }).lands, 'Saved in Media only.')
  const music = describeStep(p, { path: '/api/audio/compose', body: { score, track: 'A3', start: 2, comp: null } })
  assert.deepEqual(music, { title: 'Original music: Warm bed', produces: 'Stereo music, 8 s at 120 BPM (pad), synthesized locally and saved in Media.', lands: 'A new clip on A3 from 00:00:02:00 to 00:00:10:00.', body: { score, track: 'A3', start: 2, comp: null } })
})

test('a step that names only its clip runs over the clip\u2019s whole source range', () => {
  const p = project()
  const clip = p.tracks.find(track => track.id === 'V1').clips[0]
  Object.assign(clip, { in: 2, dur: 6 })
  // The browser denoiser refuses anything but the complete range, with src, in and dur.
  assert.deepEqual(describeStep(p, { path: '/api/video/denoise', body: { clip: 'c1', comp: null } }).body, { clip: 'c1', comp: null, src: 'media/a.mp4', in: 2, dur: clip.dur })
  const stabilize = describeStep(p, { path: '/api/stabilize/render', body: { src: 'media/a.mp4', clip: 'c1', comp: null } })
  assert.deepEqual([stabilize.body.in, stabilize.body.dur], [2, clip.dur])
  assert.match(stabilize.produces, new RegExp(`A steadied ${clip.dur} s copy`))
  const slowed = describeStep(p, { path: '/api/retime', body: { src: 'media/a.mp4', clip: 'c1', speed: 0.5, in: 2, dur: 6 } })
  assert.deepEqual([slowed.body.in, slowed.body.dur], [2, 6], 'an explicit complete range is kept')
  // Placement replaces a clip only with its complete source range, so a partial one fails now, not at Apply.
  assert.throws(() => describeStep(p, { path: '/api/retime', body: { src: 'media/a.mp4', clip: 'c1', speed: 0.5, in: 3, dur: 1 } }), /replaces clip c1 only with its complete source range \(in 2, dur 6\)\. Leave in and dur out/)
  assert.throws(() => describeStep(p, { path: '/api/stabilize/render', body: { src: 'media/a.mp4', clip: 'c1', dur: 4 } }), /complete source range/)
  assert.throws(() => describeStep(p, { path: '/api/video/denoise', body: { clip: 'c1', comp: null, in: 0 } }), /complete source range/)
  assert.throws(() => describeStep(p, { path: '/api/video/denoise', body: { clip: 'c1', comp: null, src: 'media/voice.wav' } }), /does not play media\/voice\.wav/)
  assert.equal(describeStep(p, { path: '/api/stabilize/render', body: { src: 'media/a.mp4', in: 3, dur: 1 } }).body.dur, 1, 'a Media-only render may take any range')
  assert.equal(describeStep(p, { path: '/api/stabilize/render', body: { src: 'media/a.mp4' } }).body.in, undefined, 'a Media-only render keeps the asset range')
})

test('steps that cannot run are refused with the reason', () => {
  const p = project()
  assert.throws(() => describeStep(p, { path: '/api/ops', body: {} }), /cannot be a preview step/)
  assert.throws(() => describeStep(p, { path: '/api/stabilize/render', body: { src: 'media/missing.mp4' } }), /not in Media/)
  assert.throws(() => describeStep(p, { path: '/api/stabilize/render', body: { src: 'media/a.mp4', id: 'c1' } }), /names its clip with clip, not id/)
  assert.throws(() => describeStep(p, { path: '/api/retime', body: { src: 'media/voice.wav', clip: 'c1', speed: 0.5 } }), /does not play media\/voice\.wav/)
  assert.throws(() => describeStep(p, { path: '/api/audio/clean', body: { src: 'media/a.mp4', clip: 'c1' } }), /unlocked audio clip/)
  assert.throws(() => describeStep(p, { path: '/api/audio/compose', body: { score, track: 'A1', start: 0, comp: null } }), /overlaps existing clips/)
  assert.throws(() => describeStep(p, { path: '/api/audio/compose/place', body: { path: 'media/voice.wav', track: 'A3', start: 0 } }), /generated music asset/)
})
