import assert from 'node:assert/strict'
import fs from 'node:fs'
import { applyOps } from '../../editor/core/project.js'

const fixtures = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
let assertions = 0
for (const fixture of fixtures) {
  const before = structuredClone(fixture.project)
  const result = applyOps(fixture.project, fixture.operations).project
  assert.deepEqual(fixture.project, before, `${fixture.name} does not mutate its input`)
  assertions++
  const tracks = fixture.composition ? result.comps[fixture.composition].tracks : result.tracks
  for (const [id, expected] of Object.entries(fixture.expected)) {
    const track = tracks.find(track => track.clips.some(clip => clip.id === id))
    const clip = track?.clips.find(clip => clip.id === id)
    assert.ok(clip, `${fixture.name} retains ${id}`)
    assertions++
    for (const [property, value] of Object.entries(expected)) {
      if (property === 'track') assert.equal(track.id, value, `${fixture.name} ${id} destination`)
      else assert.ok(Math.abs(clip[property] - value) < 0.00011, `${fixture.name} ${id}.${property}: ${clip[property]} vs ${value}`)
      assertions++
    }
  }
  const beforeTracks = fixture.composition ? before.comps[fixture.composition].tracks : before.tracks
  for (const [id, changes] of Object.entries(fixture.preview)) {
    const clip = tracks.flatMap(track => track.clips).find(clip => clip.id === id)
    for (const [property, value] of Object.entries(changes)) {
      assert.ok(Math.abs(clip[property] - value) < 0.00011, `${fixture.name} preview ${id}.${property} matches core`)
      assertions++
    }
  }
  for (const [id, delta] of Object.entries(fixture.offsets)) {
    const clip = tracks.flatMap(track => track.clips).find(clip => clip.id === id)
    const original = beforeTracks.flatMap(track => track.clips).find(clip => clip.id === id)
    assert.ok(Math.abs(clip.start - original.start - delta) < 0.00011, `${fixture.name} offset ${id} matches core`)
    assertions++
  }
  for (const track of tracks) {
    for (const clip of track.clips) {
      assert.ok(clip.start >= 0 && clip.dur > 0 && Number.isFinite(clip.start + clip.dur), `${fixture.name} preserves timing`)
      if (clip.in !== undefined) assert.ok(clip.in >= 0 && clip.in + clip.dur * (clip.speed ?? 1) <= result.assets[clip.src].duration + 0.00011, `${fixture.name} preserves source bounds`)
      assertions++
    }
  }
  if (fixture.composition) {
    assert.deepEqual(result.tracks, before.tracks, `${fixture.name} preserves main timeline`)
    assertions++
  }
}
console.log(`Shared core: ${fixtures.length} production plans, ${assertions} assertions passed`)
