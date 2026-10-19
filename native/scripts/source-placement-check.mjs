import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyOps, newProject } from '../../editor/core/project.js'
const operations = JSON.parse(readFileSync(process.argv[2], 'utf8'))
for (const operation of operations) {
  let project = newProject('Source placement')
  project.assets['media/source.mov'] = { duration: 10, fps: 30, width: 1920, height: 1080, hasVideo: true, hasAudio: true }
  project = applyOps(project, [{ op: 'add_title', text: 'Existing cut', track: 'V1', start: 0, dur: 8 }]).project
  const original = JSON.stringify(project)
  const result = applyOps(project, [operation]).project
  assert.equal(JSON.stringify(project), original, 'Source placement must not mutate its captured project')
  const track = result.tracks.find(t => t.id === operation.track)
  const video = track.clips.find(c => c.src === operation.src)
  const audio = result.tracks.find(t => t.id === (operation.audioTrack ?? 'A1')).clips.find(c => c.src === operation.src)
  assert.equal(video.in, 2)
  assert.equal(video.dur, 4)
  assert.equal(video.start, operation.op === 'append' ? 8 : 3)
  assert.equal(audio.in, 2)
  assert.equal(audio.dur, 4)
  assert.equal(audio.start, video.start)
  assert.equal(audio.link, video.link)
  if (operation.track === 'V2') assert.deepEqual(result.tracks[0], project.tracks[0])
  if (operation.op === 'insert') assert.equal(track.clips.find(c => c.kind === 'title' && c.start > 0).start, 7)
}
console.log('Passed four native source placements through the shared editing core, including linked audio.')
