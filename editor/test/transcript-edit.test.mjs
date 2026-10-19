import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseTimedTranscript, updateTranscriptTiming } from '../core/transcript-edit.js'
import { createTranscriptRoutes } from '../routes/transcript.mjs'

const words = [{ t: 1, end: 2, text: 'First' }, { t: 2.2, end: 3.2, text: 'sentence.' }, { t: 5, end: 7, text: 'Next.' }]
const srt = '1\r\n00:00:01,000 --> 00:00:03,000\r\nFirst <b>sentence.</b>\r\n\r\n2\r\n00:00:05,000 --> 00:00:07,000\r\nNext.\r\n'

test('JSON import retains exact word timing and strips unrelated record identity', () => {
  const result = parseTimedTranscript(JSON.stringify({ src: 'another-source', revision: 200, words }), 'speech.JSON', 9)
  assert.deepEqual(result.words, words)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.from, 1); assert.equal(result.to, 7)
  assert.equal(result.src, undefined); assert.equal(result.revision, undefined)
})

test('SRT import keeps cue bounds and estimates each word inside its cue', () => {
  const result = parseTimedTranscript(srt, 'speech.srt', 9)
  assert.deepEqual(result.words, [{ t: 1, end: 2, text: 'First' }, { t: 2, end: 3, text: 'sentence.' }, { t: 5, end: 7, text: 'Next.' }])
  assert.match(result.warnings[0], /estimated evenly/)
})

test('WebVTT import skips metadata, retains speech text and orders overlapping cues', () => {
  const text = '\uFEFFWEBVTT\n\nNOTE metadata\nignore me\n\ncue one\n00:01.000 --> 00:04.000 align:start\n<v Narrator>First &amp; last.</v>\n\n00:02.000 --> 00:03.000\nOverlap.\n'
  const result = parseTimedTranscript(text, 'speech.vtt', 5)
  assert.deepEqual(result.words.map(word => word.text), ['First', '&', 'Overlap.', 'last.'])
  assert.deepEqual(result.words.map(word => word.t), [1, 2, 2, 3])
  assert.equal(result.to, 4)
})

test('imports reject malformed, empty, unsorted and out-of-source timing without partial success', () => {
  for (const [text, filename] of [
    ['words only', 'script.txt'],
    ['WEBVTT\n00:00.000 --> 00:01.000\nNo separator', 'bad.vtt'],
    ['1\n00:80:00,000 --> 00:80:01,000\nBad seconds', 'bad.srt'],
    ['1\n00:00:01,000 --> 00:00:02,000\nValid\n\n2\nwrong timing\nInvalid', 'bad.srt'],
    ['1\n00:00:02,000 --> 00:00:01,000\nReversed', 'bad.srt'],
    ['WEBVTT\n\n00:00.000 --> 00:01.000\n', 'empty.vtt'],
    ['[]', 'empty.json'],
    [JSON.stringify([{ t: '', end: 1, text: 'Coerced' }]), 'bad.json'],
    [JSON.stringify([...words].reverse()), 'unordered.json'],
    [JSON.stringify([{ t: 0, end: 9.01, text: 'Past end' }]), 'long.json'],
    [JSON.stringify([{ t: 0, end: 0.00001, text: 'Rounded away' }]), 'small.json'],
  ]) assert.throws(() => parseTimedTranscript(text, filename, 9), undefined, filename)
})

test('word timing edits preserve neighbors and reject invalid or reordered ranges', () => {
  const corrected = updateTranscriptTiming(words, 1, { t: '2.12345', end: '3.7' }, 9)
  assert.deepEqual(corrected[0], words[0]); assert.deepEqual(corrected[2], words[2])
  assert.deepEqual(corrected[1], { t: 2.1235, end: 3.7, text: 'sentence.' })
  assert.deepEqual(words[1], { t: 2.2, end: 3.2, text: 'sentence.' })
  for (const changes of [{ t: '' }, { t: '-1' }, { t: 'NaN' }, { t: 0.5 }, { t: 5.1 }, { end: 2 }, { end: 9.001 }, { end: 2.20001 }]) assert.throws(() => updateTranscriptTiming(words, 1, changes, 9))
  assert.throws(() => updateTranscriptTiming(words, -1, { t: 1 }, 9), /Select one/)
})

test('imported revisions and timing edits survive reopen and feed captions and shorts without recognition', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya timed transcript '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'speech.wav'), 'synthetic-source-no-codec')
  const project = { width: 640, height: 360, fps: 30, assets: { 'speech.wav': { hasAudio: true, duration: 9 } }, tracks: [{ id: 'A1', kind: 'audio', clips: [{ id: 'audio', src: 'speech.wav', in: 0, start: 0, dur: 9 }] }] }
  let recognitionCalls = 0
  const config = { root, resolveMedia: src => path.join(root, src), getProject: () => project, getVersion: () => 1, findWhisper: async () => { recognitionCalls++; throw new Error('Recognition must not run') }, process: async () => { recognitionCalls++; throw new Error('Codec must not run') } }
  const routes = createTranscriptRoutes(config)
  const imported = parseTimedTranscript(srt, 'speech.srt', 9)
  const saved = routes.save({ src: 'speech.wav', words: imported.words, revision: 0 })
  assert.equal(saved.revision, 1)
  const edited = updateTranscriptTiming(saved.words, 1, { t: '2.1', end: '3.1' }, 9)
  const second = routes.save({ src: 'speech.wav', words: edited, revision: saved.revision })
  assert.equal(second.revision, 2)
  const reopened = createTranscriptRoutes(config)
  assert.deepEqual(reopened.get({}, new URLSearchParams({ src: 'speech.wav' })).words, edited)
  assert.throws(() => reopened.save({ src: 'speech.wav', words: imported.words, revision: 1 }), /transcript changed/)
  const captions = await reopened.captions({ src: 'speech.wav', style: 'word' })
  assert.ok(captions.items.some(item => item.text === 'sentence.' && item.t === 2.1 && item.end === 3.1))
  const shorts = await reopened.propose({ src: 'speech.wav', minDur: 1, maxDur: 8, count: 1 })
  assert.ok(shorts.candidates.length > 0)
  assert.equal(recognitionCalls, 0)
  assert.equal(fs.readFileSync(path.join(root, 'speech.wav'), 'utf8'), 'synthetic-source-no-codec')
})
