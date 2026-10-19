import assert from 'node:assert/strict'
import fs from 'node:fs'
import { applyOps } from '../../editor/core/project.js'
const plans = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
let checks = 0
for (const plan of plans) {
  const result = applyOps(plan.project, plan.operations).project
  const tracks = plan.comp ? result.comps[plan.comp].tracks : result.tracks
  if (plan.kind === 'markers') {
    // A nested action's markers belong to that composition, not the main timeline.
    const markers = plan.comp ? result.comps[plan.comp].markers : result.markers
    assert.deepEqual(markers.map(marker => marker.t), [11, 12, 14], `${plan.name} preserves captured source-to-timeline mapping`)
    checks++
    if (plan.comp) { assert.deepEqual(result.markers, plan.project.markers ?? [], 'Nested marker action leaves main timeline markers intact'); checks++ }
    assert.deepEqual(result.tracks, plan.project.tracks, 'Marker batch leaves clip state intact')
    checks++
    if (plan.comp) { assert.deepEqual(result.comps[plan.comp].tracks, plan.project.comps[plan.comp].tracks, 'Nested marker action leaves nested clips intact'); checks++ }
    continue
  }
  for (const track of tracks) {
    assert.deepEqual(track.clips.map(clip => [clip.start, clip.dur]), [[10, 1], [11, 1], [12, 2]], `${plan.name} splits every captured linked target`)
    checks++
    assert.deepEqual(track.clips.map(clip => clip.in), [2, 4, 6], `${plan.name} retains source mapping`)
    checks++
  }
  if (plan.comp) { assert.deepEqual(result.tracks, plan.project.tracks, 'Nested explicit scope does not touch reused main IDs'); checks++ }
}
console.log(`Inspector shared core: ${checks} assertions passed`)
