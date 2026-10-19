import assert from 'node:assert/strict'
import test from 'node:test'
import { captionPlate, captionWordUpdate } from '../web/ui/caption-word-edit.js'
import { applyOps, newProject } from '../core/project.js'
import { framePlan } from '../core/render-plan.js'

function fixture(comp = null) {
  let p = newProject('Editable caption')
  if (comp) p = applyOps(p, [{ op: 'add_comp', name: 'Portrait', width: 1080, height: 1920 }]).project
  return applyOps(p, [{ op: 'captions', comp, burnIn: true, style: { preset: 'karaoke' }, items: [{
    t: 10, end: 13, text: 'go 🟡 go\nagain', source: { src: 'speech.mov', clip: 'c99' }, words: [
      { t: 10, end: 10.5, text: 'go', sourceT: 20, sourceEnd: 20.5 },
      { t: 10.5, end: 11, text: '🟡', sourceT: 20.5, sourceEnd: 21 },
      { t: 11, end: 11.8, text: 'go', sourceT: 21, sourceEnd: 21.8 },
      { t: 12, end: 12.8, text: 'again', sourceT: 22, sourceEnd: 22.8 },
    ],
  }] }]).project
}
const cue = (p, comp = null) => (comp ? p.comps[comp] : p).tracks.find(track => track.kind === 'caption').clips[0]

test('cue-local timing changes the actual renderer highlight and retains source provenance', () => {
  const p = fixture(), before = structuredClone(p), c = cue(p)
  const q = applyOps(p, [captionWordUpdate(c, 2, { t: 1.2, end: 1.6 })]).project
  assert.equal(framePlan(q, 11.1).captions[0].title.highlight, undefined)
  assert.deepEqual(framePlan(q, 11.3).captions[0].title.highlight, { start: 6, end: 8, color: '#ffe600' })
  assert.equal(framePlan(q, 11.7).captions[0].title.highlight, undefined)
  assert.equal(cue(q).words[2].sourceT, 21)
  assert.equal(cue(q).words[2].sourceEnd, 21.8)
  assert.deepEqual(cue(q).source, c.source)
  assert.deepEqual(p, before)
})

test('word text changes the chosen repeated token while preserving Unicode and line breaks', () => {
  const p = fixture(), c = cue(p)
  const q = applyOps(p, [captionWordUpdate(c, 2, { text: 'GO!' })]).project
  assert.equal(cue(q).text, 'go 🟡 GO!\nagain')
  assert.deepEqual(framePlan(q, 11.2).captions[0].title.highlight, { start: 6, end: 9, color: '#ffe600' })
  assert.deepEqual(cue(q).words.map(({ text, ...word }) => word), c.words.map(({ text, ...word }) => word))
})

test('an explicitly scoped update leaves a same-ID cue in the main timeline untouched', () => {
  const p = fixture('k1'), c = cue(p, 'k1')
  p.tracks.push({ id: 'C1', kind: 'caption', clips: [{ ...structuredClone(c), text: 'Main caption' }] })
  const q = applyOps(p, [captionWordUpdate(c, 2, { text: 'nested' }, 'k1')]).project
  assert.equal(cue(q).text, 'Main caption')
  assert.equal(cue(q, 'k1').text, 'go 🟡 nested\nagain')
  const reopened = JSON.parse(JSON.stringify(q))
  assert.deepEqual(cue(reopened, 'k1'), cue(q, 'k1'))
})

test('bad word timings reject before producing an operation or changing the cue', () => {
  const c = cue(fixture()), before = structuredClone(c)
  for (const patch of [{ t: -0.1 }, { t: NaN }, { end: Infinity }, { end: 1 }, { end: 3.1 }, { t: 0.2 }, { t: 2.1, end: 2.4 }, { text: '' }, { text: 'x'.repeat(1001) }, { sourceT: 99 }]) {
    assert.throws(() => captionWordUpdate(c, 2, patch))
    assert.deepEqual(c, before)
  }
  assert.throws(() => captionWordUpdate(c, -1, { t: 0 }))
  assert.throws(() => captionWordUpdate({ ...c, dur: NaN }, 2, { t: 1.2 }))
})

test('unmatched cue text reports a correction error without replacing unrelated glyphs', () => {
  const c = cue(fixture()); c.text = 'A rewritten cue'
  assert.throws(() => captionWordUpdate(c, 2, { text: 'GO!' }), /no longer matches/)
})

test('plain captions keep a transparent plate when its color changes', () => {
  assert.deepEqual(captionPlate('transparent'), { color: '#000000', alpha: 0 })
  assert.deepEqual(captionPlate('#12345680'), { color: '#123456', alpha: 128 / 255 })
  assert.deepEqual(captionPlate('#123456'), { color: '#123456', alpha: 1 })
})

test('editing a frame-snapped edge word normalizes only its cue edge and retains source times', () => {
  const p = applyOps(newProject('Frame edge'), [{ op: 'captions', style: { preset: 'karaoke' }, burnIn: true, items: [{ t: 0.025, end: 1.008, text: 'Edge', words: [{ t: 0.025, end: 1.008, text: 'Edge', sourceT: 2.025, sourceEnd: 3.008 }] }] }]).project
  const c = cue(p)
  assert.ok(c.words[0].t < 0)
  const q = applyOps(p, [captionWordUpdate(c, 0, { text: 'EDGE' }, null, 30)]).project
  assert.equal(cue(q).words[0].t, 0)
  assert.equal(cue(q).words[0].end, c.dur)
  assert.equal(cue(q).words[0].sourceT, 2.025)
  assert.equal(cue(q).words[0].sourceEnd, 3.008)
  assert.deepEqual(framePlan(q, 0.04).captions[0].title.highlight, { start: 0, end: 4, color: '#ffe600' })
})
