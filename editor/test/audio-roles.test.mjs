// Ducking finds music by role and dips it around speech, not under whole dialogue clips.
import assert from 'node:assert/strict'
import test from 'node:test'

import { audioRole, duckOps, mixRoles, speechSpans } from '../core/audio-roles.js'
import { applyOps, hasAudio, newProject, valueAt } from '../core/project.js'

function interview() {
  const p = newProject('mix')
  p.assets = {
    'talk.mp4': { duration: 60, width: 1920, height: 1080, hasVideo: true, hasAudio: true },
    'bed.m4a': { duration: 60, hasVideo: false, hasAudio: true },
  }
  return applyOps(p, [
    { op: 'append', src: 'talk.mp4', in: 10, out: 30 },
    { op: 'add_clip', src: 'bed.m4a', track: 'A2', start: 0, dur: 20 },
  ]).project
}

test('picture sound is dialogue and an audio-only file is music, whatever the track is called', () => {
  const p = interview()
  const { music, dialogue } = mixRoles(p, hasAudio)
  assert.deepEqual(music.map(x => x.clip.src), ['bed.m4a'])
  assert.deepEqual(dialogue.map(x => x.clip.id), ['c1a'])
  assert.equal(audioRole(p, music[0].clip, music[0].track).stated, false)
})

test('a stated role or a track named Music wins over inference', () => {
  let p = interview()
  p = applyOps(p, [{ op: 'update', id: 'c2', set: { role: 'dialogue' } }]).project
  assert.equal(mixRoles(p, hasAudio).music.length, 0, 'a voice-over file marked dialogue is not music')
  p = applyOps(interview(), [{ op: 'update_track', id: 'A3', set: { name: 'Music' } }, { op: 'add_clip', src: 'bed.m4a', track: 'A3', start: 0, dur: 5 }]).project
  const { music, dialogue } = mixRoles(p, hasAudio)
  assert.deepEqual(music.map(x => x.track.id), ['A3'], 'once a Music track exists, other audio-only files count as dialogue')
  assert.deepEqual(dialogue.map(x => x.clip.id).sort(), ['c1a', 'c2'])
})

test('speech spans skip the silences of each source, mapped through in point and speed', () => {
  const dialogue = [{ clip: { src: 'talk.mp4', start: 0, dur: 10, in: 10, speed: 2 } }]
  // Source 14..18 is silent: at 2x that is timeline 2..4.
  assert.deepEqual(speechSpans(dialogue, new Map([['talk.mp4', [[14, 18], [40, 50]]]])), [[0, 2], [4, 10]])
  assert.deepEqual(speechSpans(dialogue, new Map([['talk.mp4', null]])), [[0, 10]], 'unknown silences keep the whole clip')
  // Pauses shorter than the merge gap do not release the music.
  assert.deepEqual(speechSpans([{ clip: { src: 'x', start: 0, dur: 10, in: 0 } }], new Map([['x', [[3, 3.4]]]])), [[0, 10]])
})

test('music comes back up in a long pause and stays down while people talk', () => {
  const p = interview()
  const { music, dialogue } = mixRoles(p, hasAudio)
  const spans = speechSpans(dialogue, new Map([['talk.mp4', [[16, 22]]]]))
  assert.deepEqual(spans, [[0, 6], [12, 20]])
  const ducked = applyOps(p, duckOps(music, spans, -12)).project
  const bed = ducked.tracks.find(t => t.id === 'A2').clips[0]
  assert.equal(valueAt(ducked, bed, 'volume', 3), -12)
  assert.equal(valueAt(ducked, bed, 'volume', 9), 0, 'the pause from 6 s to 12 s lets the music back up')
  assert.equal(valueAt(ducked, bed, 'volume', 15), -12)
})
