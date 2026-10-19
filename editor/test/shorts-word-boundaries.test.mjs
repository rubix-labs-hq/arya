import assert from 'node:assert/strict'
import test from 'node:test'
import { proposeShorts } from '../core/shorts.js'

const continuous = count => Array.from({ length: count }, (_, index) => ({ t: index, end: index + 0.8, text: index === 42 ? 'topic' : 'word' }))

test('a continuous transcript without punctuation still offers bounded query passages', () => {
  const words = continuous(90), result = proposeShorts(words, { minDur: 15, maxDur: 30, count: 3, query: 'topic' })
  assert.ok(result.candidates.length)
  assert.ok(result.candidates.every(c => c.evidence.includes('topic') && c.to - c.from >= 15 && c.to - c.from <= 30))
  assert.ok(result.candidates.every(c => c.reason.includes('word-aligned')))
  assert.ok(result.warnings.some(w => w.includes('No sentence or pause range matched')))
  assert.equal(result.scoring, 'transcript-structure')
})

test('fallback preserves no-match and short-source results without inventing clip evidence', () => {
  assert.equal(proposeShorts(continuous(90), { minDur: 15, maxDur: 30, query: 'absent' }).candidates.length, 0)
  assert.equal(proposeShorts(continuous(5), { minDur: 15, maxDur: 30 }).candidates.length, 0)
  assert.equal(proposeShorts([], { minDur: 15, maxDur: 30 }).candidates.length, 0)
})

test('existing sentence proposals retain speech-boundary reasons without fallback warnings', () => {
  const words = continuous(90).map((word, index) => ({ ...word, text: index % 10 === 9 ? word.text + '.' : word.text }))
  const result = proposeShorts(words, { minDur: 15, maxDur: 30, count: 3 })
  assert.ok(result.candidates.length)
  assert.ok(result.candidates.every(c => c.reason === 'Starts and ends at speech boundaries'))
  assert.ok(!result.warnings.some(w => w.includes('word boundaries')))
})

test('long unpunctuated transcripts use bounded sampled starts and source-valid ranges', () => {
  const words = continuous(10000), result = proposeShorts(words, { minDur: 15, maxDur: 30, count: 4 })
  assert.equal(result.candidates.length, 4)
  assert.ok(result.warnings.some(w => w.includes('Word-boundary starts were sampled')))
  assert.ok(result.candidates.every(c => c.from >= 0 && c.to <= words.at(-1).end && c.to - c.from <= 30))
})

test('long-transcript sampling retains rare query matches between uniform starts', () => {
  const words = continuous(100000)
  for (const index of [42, 99998]) {
    const input = words.map((word, i) => ({ ...word, text: i === index ? 'rare-topic' : 'word' }))
    const result = proposeShorts(input, { minDur: 15, maxDur: 30, query: 'rare-topic' })
    assert.ok(result.candidates.length, `a valid passage around ${index} remains discoverable`)
    assert.ok(result.candidates.every(c => c.evidence.includes('rare-topic') && c.from <= index && c.to >= index + .8 && c.to - c.from >= 15 && c.to - c.from <= 30))
  }
})
