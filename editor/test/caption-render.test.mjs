import assert from 'node:assert/strict'
import test from 'node:test'
import { captionTitle } from '../core/caption-render.js'
import { framePlan } from '../core/render-plan.js'
import { applyOps, newProject } from '../core/project.js'

test('active caption words preserve Unicode offsets, repeated words and clip-local timing', () => {
  const clip = { text: 'Go 🟡 go\nagain', words: [
    { text: 'Go', t: 0, end: 0.2 }, { text: '🟡', t: 0.2, end: 0.4 },
    { text: 'go', t: 0.4, end: 0.6 }, { text: 'again', t: 0.6, end: 0.8 },
  ] }
  assert.deepEqual(captionTitle(clip, { preset: 'karaoke' }, 0.3).highlight, { start: 3, end: 5, color: '#ffe600' })
  assert.deepEqual(captionTitle(clip, { preset: 'karaoke' }, 0.5).highlight, { start: 6, end: 8, color: '#ffe600' })
  assert.deepEqual(captionTitle(clip, { preset: 'karaoke' }, 0.7).highlight, { start: 9, end: 14, color: '#ffe600' })
  assert.equal(captionTitle(clip, { preset: 'karaoke' }, 0.8).highlight, undefined)
  const p = newProject('Caption', 320, 180)
  p.tracks.push({ id: 'C1', kind: 'caption', burnIn: true, style: { preset: 'karaoke' }, clips: [{ ...clip, id: 'c100', kind: 'caption', start: 12, dur: 1 }] })
  assert.deepEqual(framePlan(p, 12.5).captions[0].title.highlight, captionTitle(clip, { preset: 'karaoke' }, 0.5).highlight)
  p.tracks.at(-1).clips[0].enabled = false
  assert.equal(framePlan(p, 12.5).captions.length, 0)
})

test('caption styles can override one clip and highlight a phrase across manual line breaks', () => {
  const clip = { text: '🟡 New\n  York  🟡', words: [
    { text: '🟡', t: 0, end: 1 }, { text: 'New York', t: 1, end: 2 }, { text: '🟡', t: 2, end: 3 },
  ], style: { color: '#ff0000', highlightColor: '#00ff00', size: 70, y: 0.25 } }
  const result = captionTitle(clip, { preset: 'karaoke', color: '#ffffff', size: 52 }, 1.5)
  assert.equal(result.color, '#ff0000'); assert.equal(result.size, 70)
  assert.deepEqual(result.highlight, { start: 3, end: 13, color: '#00ff00' })
  assert.deepEqual(captionTitle(clip, { preset: 'karaoke' }, 2.5).highlight, { start: 15, end: 17, color: '#00ff00' })
  const p = newProject('Per clip style')
  p.tracks.push({ id: 'C1', kind: 'caption', burnIn: true, style: { preset: 'karaoke', y: 0.9 }, clips: [{ ...clip, id: 'c100', kind: 'caption', start: 10, dur: 3 }] })
  assert.equal(framePlan(p, 11.5).captions[0].style.y, 0.25)
  const oneWord = captionTitle({ ...clip, style: { preset: 'word' } }, { preset: 'karaoke' }, 1.5)
  assert.equal(oneWord.text, 'New York'); assert.equal(oneWord.highlight, undefined)
})

test('a long caption without a preset wraps inside a 9:16 frame; a short one keeps its layout', () => {
  const vertical = { width: 1080, height: 1920 }
  const long = captionTitle({ text: 'Pack the blue tent, the spare lantern and two folding chairs before the ferry leaves at noon.' }, { size: 52 }, 0, vertical)
  assert.equal(long.box.wrap, true)
  assert.equal(long.box.autoHeight, true)
  assert.ok(Math.abs(long.box.width - 1080 * 1080 / 1920 * 0.9) < 1e-9, 'wraps at 90% of the frame width in title units')
  assert.equal(captionTitle({ text: 'The ferry leaves at noon.' }, { size: 52 }, 0, { width: 1920, height: 1080 }).box, undefined)
  assert.equal(captionTitle({ text: 'Short line' }, { size: 52 }, 0, vertical).box, undefined)
  // The render plan the native app draws from carries the same box.
  const p = newProject('Vertical', { width: 1080, height: 1920 })
  p.tracks.push({ id: 'C1', kind: 'caption', burnIn: true, style: { size: 52 }, clips: [{ id: 'c100', kind: 'caption', start: 0, dur: 2, text: long.text }] })
  assert.equal(framePlan(p, 1).captions[0].title.box.wrap, true)
})

function timedCaption() {
  return applyOps(newProject('Editable caption'), [{ op: 'captions', style: { preset: 'karaoke' }, burnIn: true, items: [{ t: 10, end: 13, text: 'go go again', words: [
    { t: 10, end: 10.8, text: 'go', sourceT: 20, sourceEnd: 20.8 },
    { t: 11, end: 11.8, text: 'go', sourceT: 21, sourceEnd: 21.8 },
    { t: 12, end: 12.8, text: 'again', sourceT: 22, sourceEnd: 22.8 },
  ] }] }]).project
}
const captions = p => p.tracks.find(track => track.kind === 'caption').clips

test('correcting cue text updates matching word labels without changing their timings', () => {
  const p = timedCaption(), before = captions(p)[0]
  const changed = applyOps(p, [{ op: 'update', id: before.id, set: { text: 'Go 🟡 again!' } }]).project
  const clip = captions(changed)[0]
  assert.deepEqual(clip.words.map(word => word.text), ['Go', '🟡', 'again!'])
  assert.deepEqual(clip.words.map(({ text, ...word }) => word), before.words.map(({ text, ...word }) => word))
  assert.deepEqual(framePlan(changed, 11.4).captions[0].title.highlight, { start: 3, end: 5, color: '#ffe600' })
  const differentCount = applyOps(changed, [{ op: 'update', id: clip.id, set: { text: 'A fully rewritten caption' } }]).project
  assert.equal(captions(differentCount)[0].words, undefined)
  assert.equal(framePlan(differentCount, 11.4).captions[0].title.text, 'A fully rewritten caption')
  assert.equal(framePlan(differentCount, 11.4).captions[0].title.highlight, undefined)
})

test('caption blade partitions repeated words and keeps source times on each new clip', () => {
  const p = timedCaption()
  const q = applyOps(p, [{ op: 'blade', id: captions(p)[0].id, at: 11 }]).project
  const [head, tail] = captions(q)
  assert.equal(head.text, 'go'); assert.equal(tail.text, 'go again')
  assert.deepEqual(head.words.map(word => [word.t, word.end, word.sourceT]), [[0, 0.8, 20]])
  assert.deepEqual(tail.words.map(word => [word.t, word.end, word.sourceT]), [[0, 0.8, 21], [1, 1.8, 22]])
  assert.deepEqual(framePlan(q, 11.4).captions[0].title.highlight, { start: 0, end: 2, color: '#ffe600' })
  assert.equal(captions(p)[0].text, 'go go again')
})

test('left and right caption trims remove hidden words and preserve the remaining word phase', () => {
  const p = timedCaption(), id = captions(p)[0].id
  const left = applyOps(p, [{ op: 'trim', id, edge: 'left', to: 11 }]).project
  assert.equal(captions(left)[0].text, 'go again')
  assert.deepEqual(captions(left)[0].words.map(word => [word.t, word.end, word.sourceT]), [[0, 0.8, 21], [1, 1.8, 22]])
  const right = applyOps(p, [{ op: 'trim', id, edge: 'right', to: 11.5 }]).project
  assert.equal(captions(right)[0].text, 'go go')
  assert.equal(captions(right)[0].words[1].end, 1.5)
  assert.equal(captions(right)[0].words[1].sourceEnd, 21.8)
  assert.deepEqual(framePlan(right, 11.4).captions[0].title.highlight, { start: 3, end: 5, color: '#ffe600' })
})

test('a caption range deletion leaves accurate text and words on each side of the gap', () => {
  const p = timedCaption()
  const q = applyOps(p, [{ op: 'delete_range', tracks: ['C1'], from: 11, to: 12, ripple: false }]).project
  assert.deepEqual(captions(q).map(clip => [clip.start, clip.text]), [[10, 'go'], [12, 'again']])
  assert.equal(captions(q)[1].words[0].sourceT, 22)
  assert.equal(captions(q)[1].words[0].t, 0)
  assert.equal(framePlan(q, 11.5).captions.length, 0)
  assert.deepEqual(framePlan(q, 12.4).captions[0].title.highlight, { start: 0, end: 5, color: '#ffe600' })
})

const saved = () => applyOps(newProject('Saved'), [{ op: 'captions', track: 'C1', items: [{ t: 9, end: 11, text: 'we already saved for later.', words: [
  { t: 9, end: 9.2, text: 'we' }, { t: 9.2, end: 9.6, text: 'already' }, { t: 9.6, end: 9.9, text: 'saved' }, { t: 9.9, end: 10.05, text: 'for' }, { t: 10.05, end: 11, text: 'later.' },
] }] }]).project

test('a cut that leaves a sliver of a word removes that word from the caption', () => {
  // The cut asks for 10.05 and frame snapping at 30 fps lands it at 10.0667, half a frame into "later.".
  const sliver = captions(applyOps(saved(), [{ op: 'delete_range', from: 10.05, to: 11 }]).project)[0]
  assert.equal(sliver.dur, 1.0667)
  assert.equal(sliver.text, 'we already saved for')
  assert.deepEqual(sliver.words.map(word => word.text), ['we', 'already', 'saved', 'for'])
  // The same sliver left at the head of a caption, and by a right trim.
  const head = captions(applyOps(saved(), [{ op: 'delete_range', from: 9, to: 9.18 }]).project)[0]
  assert.equal(head.text, 'already saved for later.')
  const trimmed = captions(applyOps(saved(), [{ op: 'trim', id: captions(saved())[0].id, edge: 'right', to: 10.0667 }]).project)[0]
  assert.equal(trimmed.text, 'we already saved for')
})

test('a word with a frame and a half or more left stays, and a short word split in two is never lost', () => {
  const kept = captions(applyOps(saved(), [{ op: 'delete_range', from: 10.1, to: 11 }]).project)[0]
  assert.equal(kept.text, 'we already saved for later.', '0.05 s of the word is a frame and a half at 30 fps')
  assert.equal(kept.words.at(-1).end, kept.dur)
  // "for" lasts 0.15 s. A split two frames in leaves 0.0667 s and 0.0833 s: both sides keep it, as before.
  const split = captions(applyOps(saved(), [{ op: 'split', at: 9.9667 }]).project)
  assert.deepEqual(split.map(clip => clip.text), ['we already saved for', 'for later.'])
  // A word two frames long, split in the middle, has one frame on each side and stays on both.
  const short = applyOps(newProject('Short'), [{ op: 'captions', items: [{ t: 0, end: 1, text: 'a to b', words: [{ t: 0, end: 0.4, text: 'a' }, { t: 0.4, end: 0.4667, text: 'to' }, { t: 0.4667, end: 1, text: 'b' }] }] }]).project
  assert.deepEqual(captions(applyOps(short, [{ op: 'split', at: 0.4333 }]).project).map(clip => clip.text), ['a to', 'to b'])
  // Split a frame into a three-frame word: the side with two frames keeps it, the side with one does not.
  const three = applyOps(newProject('Three'), [{ op: 'captions', items: [{ t: 0, end: 1, text: 'a the b', words: [{ t: 0, end: 0.4, text: 'a' }, { t: 0.4, end: 0.5, text: 'the' }, { t: 0.5, end: 1, text: 'b' }] }] }]).project
  assert.deepEqual(captions(applyOps(three, [{ op: 'split', at: 0.4333 }]).project).map(clip => clip.text), ['a', 'the b'])
})

test('the sliver rule uses the frame rate of the composition the caption is in', () => {
  const p = applyOps(newProject('Comp'), [{ op: 'add_comp', name: 'Slow', fps: 10, duration: 4 }, { op: 'captions', comp: 'k1', items: [{ t: 0, end: 2, text: 'one two', words: [{ t: 0, end: 1, text: 'one' }, { t: 1, end: 2, text: 'two' }] }] }]).project
  // At 10 fps a frame and a half is 0.15 s, so 0.1 s of "two" is a sliver here and would not be at 30 fps.
  const cut = applyOps(p, [{ op: 'delete_range', comp: 'k1', from: 1.1, to: 2 }]).project
  assert.equal(cut.comps.k1.tracks.find(track => track.kind === 'caption').clips[0].text, 'one')
})
