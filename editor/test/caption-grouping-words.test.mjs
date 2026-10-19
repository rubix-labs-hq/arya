import assert from 'node:assert/strict'
import test from 'node:test'
import { applyOps, newProject } from '../core/project.js'
import { captionItems, buildShortsOps } from '../core/shorts.js'
import { captionWordRanges, captionTitle } from '../core/caption-render.js'
import { wordsToCaptions } from '../core/interchange.js'

function sourceProject() {
  const p = newProject('Caption overlap')
  p.assets['test.mov'] = { duration: 4, hasVideo: true, hasAudio: true }
  return applyOps(p, [{ op: 'add_clip', src: 'test.mov', start: 0, dur: 4 }]).project
}

test('overlapping speech retains each word only in the caption containing its text', () => {
  const p = sourceProject(), words = [{ t: 0, end: 1, text: 'First.' }, { t: 0.5, end: 0.8, text: 'Next.' }]
  const { items } = captionItems(p, 'test.mov', words, { style: 'karaoke' })
  assert.deepEqual(items.map(cue => cue.words.map(word => word.text)), [['First.'], ['Next.']])
  assert.deepEqual(items.flatMap(cue => cue.words.map(word => word.sourceT)), [0, 0.5])
  const q = applyOps(p, [{ op: 'captions', items, style: { preset: 'karaoke' }, burnIn: true }]).project
  const cues = q.tracks.find(track => track.kind === 'caption').clips
  assert.deepEqual(captionTitle(cues[0], { preset: 'karaoke' }, 0.2).highlight, { start: 0, end: 6, color: '#ffe600' })
  assert.deepEqual(captionTitle(cues[1], { preset: 'karaoke' }, 0.2).highlight, { start: 0, end: 5, color: '#ffe600' })
})

test('grouping preserves punctuation tokens and source provenance without midpoint reassignment', () => {
  const p = sourceProject(), words = [
    { t: 0, end: 0.1, text: '(' }, { t: 0.1, end: 0.5, text: 'Hello' }, { t: 0.4, end: 0.7, text: ')' },
    { t: 0.6, end: 0.8, text: '.' }, { t: 0.75, end: 1.1, text: 'Next' }, { t: 1.1, end: 1.2, text: '(' },
  ]
  const { items } = captionItems(p, 'test.mov', words, { style: 'karaoke' })
  assert.deepEqual(items.flatMap(cue => cue.words.map(word => word.sourceT)), words.map(word => word.t))
  assert.ok(items.every(cue => captionWordRanges(cue).every(Boolean)))
  assert.ok(items.every(cue => cue.words.every(word => word.t >= cue.t && word.end <= cue.end && word.end > word.t)))
})

test('direct legacy subtitle grouping keeps its original shape without the opt-in word data', () => {
  const words = [{ t: 0, end: 0.4, text: 'Legacy' }, { t: 0.5, end: 0.8, text: 'cue.' }]
  assert.deepEqual(wordsToCaptions(words), [{ t: 0, end: 0.8, text: 'Legacy cue.' }])
  assert.equal(wordsToCaptions(words)[0].words, undefined)
})

test('short composition captions retain source words across clipped cue boundaries', () => {
  const p = sourceProject(), words = [{ t: 1, end: 2, text: 'First.' }, { t: 1.5, end: 1.8, text: 'Next.' }]
  const plan = buildShortsOps(p, { src: 'test.mov', ranges: [{ from: 1, to: 3, name: 'Overlap' }], words, captionStyle: 'karaoke' })
  const q = applyOps(p, plan.ops).project, comp = q.comps[plan.comps[0].id]
  const cues = comp.tracks.find(track => track.kind === 'caption').clips
  assert.deepEqual(cues.flatMap(cue => cue.words.map(word => word.sourceT)), [1, 1.5])
  assert.ok(cues.every(cue => captionWordRanges(cue).every(Boolean)))
  assert.equal(p.comps?.[plan.comps[0].id], undefined)
})

test('opening punctuation before a continuation retains source order and matching glyphs', () => {
  const words = [{ t: 0, end: 0.3, text: ' Hello', id: 1 }, { t: 0.4, end: 0.5, text: ' (', id: 2 }, { t: 0.5, end: 0.8, text: 'world', id: 3 }]
  const cues = wordsToCaptions(words, { includeWords: true })
  assert.deepEqual(cues.flatMap(cue => cue.words.map(word => word.id)), [1, 2, 3])
  assert.equal(cues[0].text, 'Hello (world')
  assert.ok(captionWordRanges(cues[0]).every(Boolean))
  assert.deepEqual(cues[0].words.map(word => word.t), [0, 0.4, 0.5])
})

test('deterministic raw-token overlaps retain every source word in order with valid glyph ranges', () => {
  let seed = 1034
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const tokens = ['go', '🟡', '(', ')', '.', "'t", '“', '”', 'New York', 'hello!']
  for (let trial = 0; trial < 150; trial++) {
    const words = Array.from({ length: 40 }, (_, id) => ({ id, t: id * 0.15, end: id * 0.15 + 0.1 + random() * 0.4, text: (random() > 0.5 ? ' ' : '') + tokens[Math.floor(random() * tokens.length)] }))
    const cues = wordsToCaptions(words, { includeWords: true, maxChars: 16, maxLines: 2 })
    assert.deepEqual(cues.flatMap(cue => cue.words.map(word => word.id)), words.map(word => word.id), `source order in trial ${trial}`)
    for (const cue of cues) {
      assert.ok(captionWordRanges(cue).every(Boolean), `glyphs in trial ${trial}`)
      assert.ok(cue.words.every(word => word.t >= cue.t && word.end <= cue.end && word.end > word.t), `bounds in trial ${trial}`)
    }
  }
})
