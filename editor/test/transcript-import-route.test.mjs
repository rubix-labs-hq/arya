// The assistant had no way to save word timings a person supplies. Seen on 2026-11-17: "Transcripts
// not saved. I found no route for importing word timings, and Preview mode blocks direct writes."
// POST /api/transcript/import is the Transcript panel's import (parseTimedTranscript, then the same
// save) in one call an agent can make.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import transcriptRoutes, { createTranscriptRoutes } from '../routes/transcript.mjs'
import { parseTimedTranscript } from '../core/transcript-edit.js'
import { TRANSCRIPT_IMPORT_GUIDE, WRITES, promptFor, validateCall } from '../agent/protocol.mjs'
import { stepLabel } from '../agent/step-labels.mjs'
import { applyOps, newProject } from '../core/project.js'

const SRC = 'media/speech.wav', DURATION = 90
const SRT = '1\n00:00:01,000 --> 00:00:03,000\nGood morning everyone\n\n2\n00:00:04,000 --> 00:00:05,000\nWelcome back\n'
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nGood morning everyone\n\n00:00:04.000 --> 00:00:05.000\nWelcome back\n'
const TIMED = [{ t: 1, end: 1.4, text: 'Good' }, { t: 1.5, end: 2.1, text: 'morning' }, { t: 4, end: 4.6, text: 'Welcome' }]

function fixture(t, { call } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-import-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'media'))
  fs.writeFileSync(path.join(root, SRC), 'generated-fixture')
  const model = path.join(root, 'ggml-base.en.bin'); fs.writeFileSync(model, 'fixture-model')
  const project = applyOps(newProject('Import'), [{ op: 'import', assets: { [SRC]: { hasAudio: true, hasVideo: false, duration: DURATION } } }]).project
  const jobs = []
  const service = createTranscriptRoutes({ root, resolveMedia: src => path.join(root, src), getProject: () => project, getVersion: () => 1, findWhisper: async () => 'fixture-whisper', modelPaths: [model],
    assertPublication: () => call?.(), newJob: (kind, spec) => { const job = { id: `j${jobs.length + 1}`, kind, spec, state: 'queued' }; jobs.push(job); return job }, publish: () => {},
    process: async (_command, args) => {
      if (args.includes('-of')) fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ transcription: [{ offsets: { from: 500, to: 900 }, text: 'Recognized' }] }))
      else fs.writeFileSync(args.at(-1), 'pcm-fixture')
    } })
  const routes = transcriptRoutes({ transcripts: service }).routes
  const read = () => routes['GET /api/transcript']({}, new URLSearchParams({ src: SRC }))
  return { root, service, routes, read, importTimed: body => routes['POST /api/transcript/import']({ src: SRC, ...body }) }
}

test('SRT, WebVTT and timed JSON save the words the Transcript panel import would save', async t => {
  for (const [format, text] of [['srt', SRT], ['vtt', VTT], ['json', JSON.stringify(TIMED)], ['json', JSON.stringify({ words: TIMED })]]) {
    const f = fixture(t), expected = parseTimedTranscript(text, `file.${format}`, DURATION)
    const reply = f.importTimed({ format, text })
    assert.deepEqual(f.read().words, expected.words, format)
    assert.deepEqual(reply, { saved: true, src: SRC, locale: 'en-US', revision: 1, status: 'complete', provider: 'manual', replaced: false, format, wordCount: expected.words.length, from: expected.from, to: expected.to, warnings: expected.warnings })
    assert.equal(Object.hasOwn(reply, 'words'), false, 'the answer never carries the words')
  }
  const f = fixture(t)
  // Cue timing only: three words share the first cue evenly, and the reply says so.
  const reply = f.importTimed({ format: 'SRT', text: SRT })
  assert.deepEqual(f.read().words.slice(0, 3), [{ t: 1, end: 1.6667, text: 'Good' }, { t: 1.6667, end: 2.3333, text: 'morning' }, { t: 2.3333, end: 3, text: 'everyone' }])
  assert.match(reply.warnings[0], /Word times are estimated evenly within each cue/)
  assert.deepEqual(fixture(t).importTimed({ format: 'json', text: JSON.stringify(TIMED) }).warnings, [])
})

test('timings outside the source, out of order or without text are refused with the panel message and save nothing', async t => {
  const f = fixture(t)
  const bad = [
    [[{ t: 1, end: 91, text: 'late' }], /Transcript words need ordered, finite source timings and nonempty text/],
    [[{ t: 5, end: 6, text: 'second' }, { t: 1, end: 2, text: 'first' }], /Transcript words need ordered, finite source timings and nonempty text/],
    [[{ t: 2, end: 1, text: 'backwards' }], /Transcript words need ordered, finite source timings and nonempty text/],
    [[{ t: 1, end: 2, text: '  ' }], /Transcript words need ordered, finite source timings and nonempty text/],
    [[{ t: '1', end: 2, text: 'text time' }], /Timed JSON needs words with numeric t and end in source seconds and a text string/],
    [[], /no timed transcript words/],
  ]
  for (const [words, message] of bad) {
    assert.throws(() => f.importTimed({ format: 'json', text: JSON.stringify(words) }), message)
    assert.throws(() => parseTimedTranscript(JSON.stringify(words), 'file.json', DURATION), message, 'the panel refuses it the same way')
  }
  assert.throws(() => f.importTimed({ format: 'srt', text: 'Good morning everyone, no timings here' }), /Each subtitle cue needs a valid start and end time/)
  assert.throws(() => f.importTimed({ format: 'vtt', text: SRT }), /must begin with WEBVTT/)
  assert.throws(() => f.importTimed({ format: 'txt', text: 'x' }), /format must be srt, vtt or json/)
  assert.throws(() => f.importTimed({ format: 'json' }), /text must hold the whole/)
  assert.throws(() => f.importTimed({ format: 'json', text: JSON.stringify(TIMED), revision: '0' }), /revision must be/)
  assert.throws(() => f.importTimed({ src: 'media/missing.wav', format: 'json', text: JSON.stringify(TIMED) }), /Import a finite-duration source with audio first/)
  assert.equal(f.read().status, 'missing'); assert.equal(f.read().revision, 0)
})

test('a first import is labelled manual, and replacing a transcript needs its revision and keeps its provider', async t => {
  const f = fixture(t)
  const recognized = await f.service.transcribe({ src: SRC })
  assert.equal(recognized.provider, 'whisper.cpp'); assert.equal(recognized.revision, 1)
  assert.throws(() => f.importTimed({ format: 'json', text: JSON.stringify(TIMED) }), /already has a saved transcript \(revision 1, 1 words\)\. Importing replaces all of it and cannot be undone\. To replace it, send revision 1\./)
  assert.throws(() => f.importTimed({ format: 'json', text: JSON.stringify(TIMED), revision: 0 }), /The transcript changed\. Reload it before saving corrections\./)
  assert.deepEqual(f.read().words, recognized.words, 'a refused import leaves the saved words alone')
  const reply = f.importTimed({ format: 'json', text: JSON.stringify(TIMED), revision: 1 })
  assert.equal(reply.replaced, true); assert.equal(reply.revision, 2)
  assert.equal(reply.provider, 'whisper.cpp', 'as with a correction in the panel, the recognized provider is kept')
  assert.deepEqual(f.read().words, TIMED)
  const fresh = fixture(t)
  assert.equal(fresh.importTimed({ format: 'json', text: JSON.stringify(TIMED), revision: 0 }).provider, 'manual')
})

test('a transcript made stale by a changed source can be replaced by an import', async t => {
  const f = fixture(t)
  f.importTimed({ format: 'json', text: JSON.stringify(TIMED) })
  fs.appendFileSync(path.join(f.root, SRC), 'changed')
  assert.equal(f.read().status, 'stale')
  const reply = f.importTimed({ format: 'json', text: JSON.stringify(TIMED.slice(0, 1)) })
  assert.deepEqual({ status: reply.status, provider: reply.provider, replaced: reply.replaced, revision: reply.revision }, { status: 'complete', provider: 'manual', replaced: false, revision: 2 })
  assert.equal(f.read().warning, undefined); assert.deepEqual(f.read().words, TIMED.slice(0, 1))
})

test('with Preview changes on, a first import is saved and replacing a saved transcript is refused', async t => {
  const f = fixture(t, { call: () => ({ review: true }) })
  assert.equal(f.importTimed({ format: 'json', text: JSON.stringify(TIMED) }).saved, true)
  assert.throws(() => f.importTimed({ format: 'json', text: JSON.stringify(TIMED.slice(0, 1)), revision: 1 }), error => error.status === 409 && /Preview changes is on, and replacing a saved transcript has no preview or undo/.test(error.message))
  assert.deepEqual(f.read().words, TIMED)
})

test('an agent may call the import route, and each run from the browser editor is told how', () => {
  assert.ok(WRITES.has('/api/transcript/import'))
  const body = { src: SRC, format: 'srt', text: SRT }
  assert.deepEqual(validateCall('reel_api', { method: 'POST', path: '/api/transcript/import', body }), { method: 'POST', path: '/api/transcript/import', body })
  assert.deepEqual(stepLabel({ method: 'POST', path: '/api/transcript/import', body }), { doing: 'Saving a supplied transcript', done: 'saved a supplied transcript' })
  const browser = promptFor({ text: 'Save these timings.', outline: { transcription: { available: true, provider: 'whisper.cpp' } } })
  assert.ok(browser.includes(TRANSCRIPT_IMPORT_GUIDE))
  assert.equal(promptFor({ text: 'Save these timings.', outline: { outline: 'x' } }).includes(TRANSCRIPT_IMPORT_GUIDE), false, 'a host that does not serve the route is not told about it')
})

test('every sentence of the import guide is what the route does', async t => {
  const guide = TRANSCRIPT_IMPORT_GUIDE
  // "POST /api/transcript/import {src, locale?, format, text, revision?}" and the three formats.
  assert.match(guide, /POST \/api\/transcript\/import \{src, locale\?, format:"srt"\|"vtt"\|"json", text, revision\?\}/)
  // "locale defaults to en-US"
  assert.match(guide, /locale defaults to en-US/); assert.equal(fixture(t).importTimed({ format: 'json', text: JSON.stringify(TIMED) }).locale, 'en-US')
  // "an array, or {words:[...]}, of {t, end, text} with t and end in source seconds" is the first test.
  assert.match(guide, /an array, or \{words:\[\.\.\.\]\}, of \{t, end, text\}/)
  // "the reply has a warning that says so"
  assert.match(guide, /spreads the words of each cue evenly across that cue, and the reply has a warning that says so/)
  // "the reply gives wordCount, from, to and the new revision, not the words"
  assert.match(guide, /The reply gives wordCount, from, to and the new revision, not the words/)
  // "one call carries at most 512 KiB": the bridge reads a tool call with that limit.
  const bridge = fs.readFileSync(new URL('../agent/bridge.mjs', import.meta.url), 'utf8')
  assert.match(bridge, /match\[2\] === 'calls' && !match\[3\]\) \{[\s\S]{0,400}readBody\(request, 512 \* 1024\)/)
  assert.match(guide, /One tool call carries at most 512 KiB/)
  // "Import an SRT, VTT or timed JSON transcript" is the panel's own label.
  const panel = fs.readFileSync(new URL('../web/ui/transcript.js', import.meta.url), 'utf8')
  assert.ok(panel.includes('Import an SRT, VTT or timed JSON transcript')); assert.ok(guide.includes('Import an SRT, VTT or timed JSON transcript'))
  // The rest is the revision and Preview tests above.
  assert.match(guide, /replaces the whole saved transcript for that source and locale, with no undo/)
  assert.match(guide, /With Preview changes on, a first import is saved and replacing a saved transcript is refused/)
})
