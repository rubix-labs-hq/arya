import test from 'node:test'
import assert from 'node:assert/strict'
import { newProject, applyOps } from '../core/project.js'
import { buildShortsOps, captionItems, proposeShorts, transcriptDeleteOps, validateWords } from '../core/shorts.js'
const base = () => { const p = newProject('Talk'); p.assets['talk.mov'] = { duration: 120, hasVideo: true, hasAudio: true }; return p }
const words = Array.from({ length: 100 }, (_, i) => ({ t: i, end: i + 0.8, text: i % 10 === 9 ? 'sentence.' : `word${i}` }))
test('short proposals use speech boundaries and query evidence without overlapping most of a range', () => {
  const { candidates, scoring } = proposeShorts(words, { minDur: 15, maxDur: 30, count: 3, query: 'word25' })
  assert.equal(scoring, 'transcript-structure'); assert.ok(candidates.length)
  assert.ok(candidates.every(c => c.evidence.includes('word25') && c.to - c.from >= 15 && c.to - c.from <= 30))
})
test('short build creates actual vertical comps, linked audio and source-safe local caption words', () => {
  const p = base(), result = buildShortsOps(p, { src: 'talk.mov', ranges: [{ from: 20, to: 40 }, { from: 60, to: 80 }], words, captionStyle: 'karaoke' })
  const applied = applyOps(p, result.ops).project
  assert.equal(Object.keys(p.comps ?? {}).length, 0); assert.equal(result.comps.length, 2)
  for (const { id, from } of result.comps) {
    const c = applied.comps[id]; assert.equal(c.width, 1080); assert.equal(c.height, 1920)
    const video = c.tracks.find(t => t.kind === 'video').clips[0], audio = c.tracks.find(t => t.kind === 'audio').clips[0]
    assert.equal(video.in, from); assert.equal(video.fit, 'cover'); assert.equal(video.link, audio.link)
    const captions = c.tracks.find(t => t.kind === 'caption'); assert.equal(captions.burnIn, true); assert.equal(captions.style.preset, 'karaoke')
    const cue = captions.clips[0]; assert.equal(cue.words[0].sourceT, from); assert.ok(Math.abs(cue.words[0].t) < 0.02)
  }
})
test('portrait caption grouping retains every source word in readable short cues', () => {
  const p = base(); p.width = 1080; p.height = 1920
  const q = applyOps(p, [{ op: 'add_clip', src: 'talk.mov', in: 20, dur: 10, start: 0 }]).project
  const result = captionItems(q, 'talk.mov', words, { style: 'karaoke' })
  assert.ok(result.items.length > 2)
  assert.ok(result.items.every(cue => cue.text.split('\n').every(line => line.length <= 15)))
  assert.deepEqual(result.items.flatMap(cue => cue.words.map(word => word.sourceT)), words.slice(20, 30).map(word => word.t))
})
test('caption mapping honors nested comp scalar speed and rejects reverse/freeze/time maps', () => {
  const p = applyOps(base(), [{ op: 'add_comp', name: 'Nested' }, { op: 'add_clip', comp: 'k1', src: 'talk.mov', in: 10, dur: 5, start: 3, set: { speed: 2 } }]).project
  const result = captionItems(p, 'talk.mov', words, { comp: 'k1', id: 'c1', style: 'word' })
  assert.equal(result.items[0].t, 3); assert.equal(result.items[0].words[0].sourceT, 10)
  assert.equal(result.items[0].end, 3.4)
  for (const set of [{ reverse: true }, { freeze: 10 }, { timeMap: [[0,10],[1,12]] }]) {
    const q = applyOps(p, [{ op: 'update', id: 'c1', set }]).project
    assert.throws(() => captionItems(q, 'talk.mov', words, { comp: 'k1', id: 'c1' }), /forward/)
  }
})
test('source transcript deletion changes only chosen and linked tracks unless ripple explicitly requested', () => {
  const p = applyOps(base(), [{ op: 'add_clip', src: 'talk.mov', in: 10, dur: 10, start: 5, set: { speed: 2 } }, { op: 'add_title', text: 'Keep', start: 8, dur: 4 }]).project
  const { ops, ranges } = transcriptDeleteOps(p, { id: 'c1', ranges: [{ from: 14, to: 16 }] })
  assert.equal(ranges[0].from, 7); assert.equal(ranges[0].to, 8); assert.equal(ops.at(-1).op, 'delete')
  const q = applyOps(p, ops).project
  assert.equal(q.tracks.flatMap(t => t.clips).find(c => c.kind === 'title').start, 8)
  assert.equal(q.tracks.find(t => t.id === 'V1').clips.length, 2)
})
test('validation fails before invalid ops can mutate project and caption moves retain local timing', () => {
  const p = base(); assert.throws(() => buildShortsOps(p, { src: 'talk.mov', ranges: [{ from: 119, to: 121 }] }), /inside/)
  assert.throws(() => validateWords([{ t: NaN, end: 2, text: 'bad' }]), /finite/)
  const q = applyOps(p, [{ op: 'captions', items: [{ t: 5, end: 7, text: 'Hello', words: [{ t: 5, end: 6, text: 'Hello', sourceT: 30, sourceEnd: 31 }] }] }]).project
  const moved = applyOps(q, [{ op: 'move', id: 'c1', start: 10 }]).project.tracks.find(t => t.kind === 'caption').clips[0]
  assert.equal(moved.start, 10); assert.equal(moved.words[0].t, 0); assert.equal(moved.words[0].sourceT, 30)
})

test('transcript passage lift preserves unrelated overlapping media on the selected track', () => {
  const p = applyOps(base(), [{ op: 'add_clip', src: 'talk.mov', in: 10, dur: 10, start: 5 }, { op: 'add_clip', src: 'talk.mov', in: 40, dur: 3, start: 7 }]).project
  const unrelated = structuredClone(p.tracks.find(t => t.id === 'V1').clips.find(c => c.in === 40))
  const { ops } = transcriptDeleteOps(p, { id: 'c1', ranges: [{ from: 12, to: 14 }] })
  const q = applyOps(p, ops).project
  assert.deepEqual(q.tracks.find(t => t.id === 'V1').clips.find(c => c.id === unrelated.id), unrelated)
  assert.equal(q.tracks.find(t => t.id === 'A1').clips.filter(c => c.in === 40).length, 1)
})
