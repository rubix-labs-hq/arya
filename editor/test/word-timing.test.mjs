// Word timings from the recognizer are corrected before a transcript is saved. Seen on a 20 s
// generated speech clip: whisper.cpp timed the last word 0.24 s past the end of the file, which
// failed the whole transcription, and timed 8 of 49 words inside measured pauses, so captions made
// after the pauses were cut lost those words. The timings below are that run's; the words are invented.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { applyOps, newProject } from '../core/project.js'
import { captionItems, validateWords } from '../core/shorts.js'
import { PAUSE_DBFS, PAUSE_SECONDS, wavPauses } from '../core/wav-signal.mjs'
import { clampWordsToDuration, keepWordsInSpeech, speechRanges } from '../core/word-timing.js'

const SRC = 'media/talk.mp4', DURATION = 20
// [start ms, end ms, word]. Three sentences with a pause after each.
const TIMED = [[190, 300, 'Red'], [300, 520, 'kites'], [520, 770, 'climb'], [770, 1030, 'over'], [1030, 1350, 'quiet'], [1350, 1610, 'hills'], [1610, 2060, 'whenever'], [2060, 2580, 'northern'], [2580, 2810, 'winds'], [2810, 3330, 'arrive,'], [3330, 3540, 'and'], [3540, 3650, 'we'], [3650, 3980, 'watch'], [3980, 4230, 'them'], [4230, 6280, 'rise.'],
  [6280, 6860, 'Painted'], [6860, 7100, 'sails'], [7100, 7430, 'catch'], [7430, 7760, 'warm'], [7760, 8500, 'afternoon'], [8500, 8830, 'air'], [8830, 9150, 'above'], [9150, 10290, 'seventeen'], [10290, 10510, 'old'], [10510, 11350, 'lighthouses'], [11350, 11680, 'along'], [11680, 11920, 'the'], [11920, 12250, 'rocky'], [12250, 12750, 'east'], [12750, 13080, 'shore.'],
  [13080, 13380, 'So'], [13380, 13470, 'when'], [13470, 13730, 'your'], [13730, 14120, 'ribbon'], [14120, 14580, 'tangles'], [14580, 14840, 'this'], [14840, 15230, 'week,'], [15230, 15490, 'wind'], [15490, 15680, 'it'], [15680, 15900, 'in'], [15900, 16380, 'slow,'], [16380, 16440, 'and'], [16440, 16760, 'ask'], [16760, 17080, 'your'], [17080, 17820, 'neighbour'], [17820, 17980, 'to'], [17980, 18140, 'do'], [18140, 18380, 'the'], [18380, 19000, 'same.']]
const recognized = () => TIMED.map(([from, to, text]) => ({ t: from / 1000, end: to / 1000, text }))
// The pauses measured in that clip at the two levels used: the silence analysis default, and a lower one.
const PAUSES = [[4.28, 6.47], [11.08, 13.27], [17.97, 20]]
const PAUSES_LOW = [[4.4625, 6.467], [11.2658, 13.2668], [18.1548, 20]]

const middle = word => (word.t + word.end) / 2
const inPause = (words, pauses) => words.filter(word => pauses.some(([from, to]) => middle(word) >= from && middle(word) < to))

/** A timeline that plays the source with the given pauses cut out, as delete_range leaves it. */
function cutProject(pauses) {
  let project = applyOps(newProject('Talk', { fps: 30 }), [{ op: 'import', assets: { [SRC]: { hasAudio: true, hasVideo: true, duration: DURATION, width: 1920, height: 1080, fps: 30 } } }, { op: 'add_clip', src: SRC, start: 0, track: 'V1' }]).project
  for (const [from, to] of [...pauses].reverse()) project = applyOps(project, [{ op: 'delete_range', from, to, ripple: true }]).project
  return project
}

test('a word that ends after the file is cut at its end, and one that starts after it is left out', () => {
  const words = [{ t: 18.2, end: 19.1, text: 'nearly' }, { t: 19.1, end: 20.3, text: 'done' }, { t: 20.3, end: 20.6, text: 'extra', confidence: 0.4 }]
  assert.throws(() => validateWords(words, DURATION), /ordered, finite source timings/, 'the save refuses these timings as they are')
  const { words: clamped, dropped } = clampWordsToDuration(words, DURATION)
  assert.deepEqual(clamped, [{ t: 18.2, end: 19.1, text: 'nearly' }, { t: 19.1, end: 20, text: 'done' }])
  assert.equal(dropped, 1)
  assert.equal(clamped[0], words[0], 'a word inside the file is not copied or changed')
  assert.equal(validateWords(clamped, DURATION).length, 2)
  // The run that failed: the last word ended 0.24 s past a 20.0 s file.
  const run = clampWordsToDuration([...recognized().slice(0, -1), { t: 19.6, end: 20.24, text: 'same.' }], DURATION)
  assert.equal(run.words.at(-1).end, 20); assert.equal(run.dropped, 0)
  assert.equal(validateWords(run.words, DURATION).length, 49)
  assert.deepEqual(clampWordsToDuration(words, Infinity), { words, dropped: 0 }, 'an unknown duration changes nothing')
})

test('words timed inside pauses move into the speech beside them, in order, with their text', () => {
  const before = recognized()
  // The eight words the session lost, and "So", which is centred 0.04 s inside the second pause.
  assert.deepEqual(inPause(before, PAUSES_LOW).map(word => word.text), ['rise.', 'along', 'the', 'rocky', 'east', 'shore.', 'So', 'the', 'same.'])
  for (const pauses of [PAUSES, PAUSES_LOW]) {
    const { words, moved, trimmed } = keepWordsInSpeech(before, pauses, DURATION)
    assert.deepEqual(words.map(word => word.text), before.map(word => word.text))
    assert.deepEqual(inPause(words, pauses), [], 'no word is centred in a pause')
    const ranges = speechRanges(pauses, DURATION)
    for (const word of words) assert.ok(ranges.some(([from, to]) => word.t >= from - 1e-4 && word.end <= to + 1e-4), `${word.text} ${word.t}-${word.end} lies in speech`)
    words.forEach((word, index) => { assert.ok(word.end - word.t >= 0.02, word.text); if (index) assert.ok(word.t >= words[index - 1].t, word.text) })
    assert.equal(validateWords(words, DURATION).length, 49)
    assert.ok(moved > 0 && trimmed > 0)
  }
  const { words } = keepWordsInSpeech(before, PAUSES_LOW, DURATION)
  const at = text => words.findLast(word => word.text === text)
  // The sentence that ran on into the pause now ends with the speech before the pause.
  assert.equal(at('shore.').end, 11.2658); assert.equal(at('same.').end, 18.1548)
  // A word that began in speech and ran on through the pause is cut at the edge of the speech.
  assert.deepEqual(at('rise.'), { t: 4.23, end: 4.4625, text: 'rise.' })
  // A word that began in the pause and ran into the next sentence starts with that sentence.
  assert.deepEqual(at('So'), { t: 13.2668, end: 13.38, text: 'So' })
  // Only the words next to a moved one give up time. The start of each sentence is untouched.
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 18, 19, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]) assert.equal(words[index], before[index], before[index].text)
})

test('captions made after the pauses are cut keep every word, where the recognizer timings lost eight', () => {
  for (const pauses of [PAUSES, PAUSES_LOW]) {
    const project = cutProject(pauses)
    const raw = captionItems(project, SRC, recognized(), { style: 'karaoke' })
    const lost = 49 - raw.items.flatMap(item => item.words).length
    assert.ok(lost >= 8, `${lost} words lost with the recognizer timings`)
    // The loss between the first and last second played is reported, not silent. The words after
    // the last second played are outside the edit, as they are when a clip uses part of a source.
    const shown = new Set(raw.items.flatMap(item => item.words.map(word => word.sourceT))), end = project.tracks.find(track => track.id === 'V1').clips.map(clip => clip.in + clip.dur).sort((a, b) => b - a)[0]
    const cut = recognized().filter(word => !shown.has(word.t) && middle(word) < end)
    assert.ok(cut.length >= 6 && cut.length <= lost)
    assert.deepEqual(raw.dropped, cut); assert.equal(raw.droppedCount, cut.length)
    assert.ok(raw.warnings.at(-1).startsWith(`${cut.length} transcript words are in source time the timeline cuts out, so no caption shows them: "rise." at 4.23s, `), raw.warnings.at(-1))
    const { words } = keepWordsInSpeech(recognized(), PAUSES, DURATION)
    const fixed = captionItems(project, SRC, words, { style: 'karaoke' })
    assert.deepEqual(fixed.items.flatMap(item => item.words.map(word => word.text)), TIMED.map(([, , text]) => text), '49 of 49')
    assert.equal(fixed.dropped, undefined); assert.equal(fixed.droppedCount, undefined); assert.deepEqual(fixed.warnings, [])
  }
})

test('words outside the part of the source the timeline plays are not reported as cut', () => {
  const project = applyOps(newProject('Part', { fps: 30 }), [{ op: 'import', assets: { [SRC]: { hasAudio: true, hasVideo: true, duration: DURATION, width: 1920, height: 1080, fps: 30 } } }, { op: 'add_clip', src: SRC, start: 0, in: 7, dur: 3, track: 'V1' }]).project
  const result = captionItems(project, SRC, keepWordsInSpeech(recognized(), PAUSES, DURATION).words, { style: 'boxed' })
  assert.ok(result.items.length > 0)
  assert.equal(result.dropped, undefined); assert.deepEqual(result.warnings, [])
})

test('timings with no pause, or already in speech, come back unchanged', () => {
  const words = recognized()
  assert.equal(keepWordsInSpeech(words, [], DURATION).words, words)
  assert.equal(keepWordsInSpeech(words, null, DURATION).words, words)
  assert.equal(keepWordsInSpeech(words, [[0, DURATION]], DURATION).words, words, 'a file that is one long pause has no speech to move words to')
  const clean = [{ t: 0.5, end: 0.9, text: 'Bright', confidence: 0.9 }, { t: 0.9, end: 1.4, text: 'morning.' }, { t: 3, end: 3.4, text: 'Calm' }, { t: 3.4, end: 3.9, text: 'sea.' }]
  const kept = keepWordsInSpeech(clean, [[1.6, 2.8], [4.2, 6]], 6)
  assert.deepEqual(kept, { words: clean, moved: 0, trimmed: 0 })
  kept.words.forEach((word, index) => assert.equal(word, clean[index]))
})

test('a word in a pause goes before it when it ends a sentence, after it when the sentence had ended, else to the nearer side', () => {
  const pauses = [[2, 4]], place = words => keepWordsInSpeech(words, pauses, 6).words
  const spoken = [{ t: 1, end: 1.5, text: 'Slow' }, { t: 1.5, end: 2, text: 'tide' }], later = [{ t: 4, end: 4.5, text: 'Then' }, { t: 4.5, end: 5, text: 'gulls.' }]
  const ends = place([...spoken, { t: 3.2, end: 3.6, text: 'turns.', confidence: 0.7 }, ...later])
  assert.ok(ends[2].end <= 2 + 1e-4, 'the word that ends the sentence goes back, even from late in the pause')
  assert.equal(ends[2].confidence, 0.7, 'other fields stay')
  const starts = place([{ t: 1, end: 1.5, text: 'Slow' }, { t: 1.5, end: 2, text: 'tide.' }, { t: 2.2, end: 2.6, text: 'Soon' }, ...later])
  assert.equal(starts[2].t, 4, 'a word after a finished sentence opens the next one')
  assert.ok(starts[3].t >= starts[2].end - 1e-4 && starts[4].end === 5, 'the words it joins make room and still end where they did')
  assert.ok(place([...spoken, { t: 2.2, end: 2.6, text: 'rolls' }, ...later])[2].end <= 2 + 1e-4, 'nearer the speech before')
  assert.equal(place([...spoken, { t: 3.4, end: 3.8, text: 'rolls' }, ...later])[2].t, 4, 'nearer the speech after')
  // Before the first sound and after the last there is only one side.
  // Before the first sound and after the last there is only one side. With room to spare the word
  // sits against the spoken word beside it, for as long as it takes to say (0.1 s + 0.07 s a letter).
  assert.deepEqual(keepWordsInSpeech([{ t: 0.2, end: 0.9, text: 'Hush' }, { t: 3, end: 3.5, text: 'now' }], [[0, 2.5]], 6).words[0], { t: 2.62, end: 3, text: 'Hush' })
  assert.deepEqual(keepWordsInSpeech([{ t: 1, end: 1.5, text: 'Hush' }, { t: 4.2, end: 4.8, text: 'now' }], [[2, 6]], 6).words[1], { t: 1.5, end: 1.81, text: 'now' })
})

test('a click between two pauses is not a place for words, and timings that cannot be fitted stay as they were', () => {
  assert.deepEqual(speechRanges([[1, 3], [3.05, 5]], 6), [[0, 1], [5, 6]])
  // Sixty words in a pause beside 0.2 s of sound cannot fit there at 0.02 s each.
  const crowd = Array.from({ length: 60 }, (_, index) => ({ t: 1 + index * 0.05, end: 1.05 + index * 0.05, text: `w${index}` }))
  const result = keepWordsInSpeech(crowd, [[0.2, 6]], 6)
  assert.deepEqual(result.words, crowd); assert.equal(result.moved, 0)
  assert.deepEqual(keepWordsInSpeech([{ t: Number.NaN, end: 1, text: 'x' }], [[2, 4]], 6).words.length, 1, 'bad input never throws')
})

function wav(samples, { rate = 16000, bits = 16 } = {}) {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((value, index) => data.writeInt16LE(value, index * 2))
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8, 'latin1'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(bits, 34); head.write('data', 36, 'latin1'); head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}
const tone = (seconds, level, rate = 16000) => Array.from({ length: Math.round(rate * seconds) }, (_, index) => Math.round(level * Math.sin(index * 2 * Math.PI * 440 / rate)))
const hiss = (seconds, level, rate = 16000) => Array.from({ length: Math.round(rate * seconds) }, (_, index) => (index * 7919 % 2 ? level : -level))

test('pauses are read from the extracted WAV at the level and length the silence analysis uses', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-pauses-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const write = (name, buffer) => { const file = path.join(dir, name); fs.writeFileSync(file, buffer); return file }
  assert.equal(PAUSE_DBFS, -32); assert.equal(PAUSE_SECONDS, 0.45)
  // 1 s of speech level, 1 s of room noise at -50 dBFS, 0.3 s of speech, a 0.3 s gap, 1 s of speech, 2 s of nothing.
  const loud = 12000, noise = Math.round(32768 * 10 ** (-50 / 20))
  const found = await wavPauses(write('talk.wav', wav([...tone(1, loud), ...hiss(1, noise), ...tone(0.3, loud), ...hiss(0.3, noise), ...tone(1, loud), ...hiss(2, 0)])))
  assert.equal(found.duration, 5.6)
  assert.deepEqual(found.pauses, [[1, 2], [3.6, 5.6]], 'the 0.3 s gap is too short to be a pause')
  // The same recording 30 dB quieter peaks below -32 dBFS. Its pauses are still found, below its own peak.
  const quiet = await wavPauses(write('quiet.wav', wav([...tone(1, loud / 32), ...hiss(1, 3), ...tone(1, loud / 32)])))
  assert.deepEqual(quiet.pauses, [[1, 2]])
  // Other sample rates are read from the header.
  assert.deepEqual((await wavPauses(write('rate.wav', wav([...tone(1, loud, 48000), ...hiss(1, 0, 48000), ...tone(0.5, loud, 48000)], { rate: 48000 })))).pauses, [[1, 2]])
  assert.deepEqual((await wavPauses(write('steady.wav', wav(tone(2, loud))))).pauses, [], 'steady sound has no pause')
  // Unknown answers are null, and the caller leaves the timings alone.
  assert.equal(await wavPauses(write('silent.wav', wav(hiss(2, 0)))), null)
  assert.equal(await wavPauses(write('float.wav', wav(tone(1, loud), { bits: 32 }))), null)
  assert.equal(await wavPauses(write('text.wav', Buffer.from('pcm-fixture'))), null)
  assert.equal(await wavPauses(path.join(dir, 'missing.wav')), null)
})
