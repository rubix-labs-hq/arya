// The Shorts picker offers the aspect ratios the platforms ask for, including 4:5 for feeds.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { buildShortsOps } from '../core/shorts.js'
import { newProject } from '../core/project.js'

const source = fs.readFileSync(new URL('../web/ui/plugins/shorts.js', import.meta.url), 'utf8')

test('the format picker offers 9:16, 4:5, 1:1 and 16:9 with matching sizes', () => {
  for (const label of ['9:16 vertical', '4:5 portrait', '1:1 square', '16:9 landscape']) assert.ok(source.includes(`>${label}</option>`), label)
  assert.match(source, /format === 'portrait' \? \[1080, 1350\]/)
})

test('a 4:5 short builds a 1080x1350 composition', () => {
  const p = newProject('shorts')
  p.assets = { 'talk.mp4': { duration: 30, width: 1920, height: 1080, hasVideo: true, hasAudio: true } }
  const { comps, ops } = buildShortsOps(p, { src: 'talk.mp4', ranges: [{ from: 1, to: 5 }], width: 1080, height: 1350, captions: false })
  assert.equal(comps.length, 1)
  assert.deepEqual([ops[0].width, ops[0].height], [1080, 1350])
})
