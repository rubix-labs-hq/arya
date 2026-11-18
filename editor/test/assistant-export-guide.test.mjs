// The export guide is added to the assistant prompt only for the browser editor, and what it says
// about names and deletion is what the server does.
// Seen on 2026-11-16: the assistant exported the whole mix to measure its loudness and left a 10 MB
// renders/Vertical.wav behind without telling the user.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { EXPORT_GUIDE, FOCUS_GUIDE, INSTRUCTIONS, REVIEW_GUIDE, WRITES, promptFor } from '../agent/protocol.mjs'
import { ANALYSIS_HELP, parseLoudness } from '../core/analysis-parse.js'

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')

test('the guide follows the other guides, and a request without the export folder keeps its prompt', () => {
  const outline = { outline: 'x', focus: 'Open: Main timeline' }
  const without = promptFor({ text: 'Cut it.', context: {}, outline })
  assert.equal(without.includes(EXPORT_GUIDE), false)
  assert.ok(without.startsWith(`${INSTRUCTIONS}\n${FOCUS_GUIDE}\n\n<immutable_reel_context>`))
  const browser = promptFor({ text: 'Cut it.', context: {}, outline: { ...outline, exportFolder: 'renders' } })
  assert.ok(browser.startsWith(`${INSTRUCTIONS}\n${FOCUS_GUIDE}\n${EXPORT_GUIDE}\n\n<immutable_reel_context>`))
  const preview = promptFor({ text: 'Cut it.', context: { review: true }, outline: { ...outline, exportFolder: 'renders' } })
  assert.ok(preview.startsWith(`${INSTRUCTIONS}\n${FOCUS_GUIDE}\n${REVIEW_GUIDE}\n${EXPORT_GUIDE}\n\n<immutable_reel_context>`))
  assert.equal(promptFor({ text: 'Cut it.', outline: { exportFolder: 'elsewhere' } }).includes(EXPORT_GUIDE), false)
})

test('the browser server names its export folder in the outline it sends with a request', () => {
  assert.match(server, /getOutline: focus => \(\{[^\n]*focus && project \? \{ focus: describeFocus\(project, focus\), exportFolder: 'renders' \} : \{\}/)
  assert.match(server, /const outDir = guardedOutput\(ROOT, path\.join\(ROOT, 'renders'\)\)/)
})

test('what the guide says about names and deletion is what the server does', () => {
  // "renders/NAME plus the extension of the preset, or the folder renders/NAME-frames for the png-seq preset"
  assert.match(server, /const named = n => preset\.sequence \? path\.join\(outDir, `\$\{n\}-frames`, 'frame_%05d\.png'\) : path\.join\(outDir, `\$\{n\}\.\$\{preset\.ext\}`\)/)
  assert.match(server, /'png-seq': \{[^}]*sequence: true/)
  assert.match(server, /'audio-wav': \{ ext: 'wav'/)
  // "Each run of characters other than A-Z, a-z, 0-9, dot, dash and underscore becomes one dash."
  const clean = server.match(/const base = String\(spec\.name \?\? selected\.name\)\.replace\((\/[^/]+\/g), '-'\)/)
  assert.ok(clean)
  const pattern = new Function(`return ${clean[1]}`)()
  assert.equal('check loudness (mix).v2'.replace(pattern, '-'), 'check-loudness-mix-.v2')
  assert.equal('check-loudness.wav'.replace(pattern, '-'), 'check-loudness.wav', 'an extension in the name is kept, so the file would end .wav.wav')
  // "If the name is taken, Arya adds -2, -3 and so on"
  assert.match(server, /for \(let i = 2; !spec\.out && i <= 1000 && taken\(free\); i\+\+\) free = `\$\{base\}-\$\{i\}`/)
  // "read the real path from the output field of the finished job"
  assert.match(server, /job\.output = path\.relative\(ROOT, job\.spec\.out\)/)
  // "no route available to you deletes one"
  assert.deepEqual([...WRITES].filter(route => /delete|remove|trash|unlink|clean-?up/i.test(route)), [])
  // "POST /api/analyze with kind loudness measures one media file"
  assert.match(server, /async function analyze\(rel, kind, options = \{\}\) \{\n  const abs = resolveMedia\(rel\)/)
  // The one input is the media file, with an optional part of it (in and dur) and no timeline mix.
  assert.match(server, /if \(kind === 'loudness'\) \{\n[^\n]*\n[^\n]*\['-nostdin', \.\.\.range\.args, '-i', abs, '-vn', '-af', 'ebur128=peak=true:framelog=quiet'/)
})

// Seen again on 2026-11-17: asked "How loud is it?", the assistant followed the guide, exported
// renders/check-loudness.wav and left it. The guide now names a measurement that writes no file.
test('the guide sends a loudness question to the mix measurement, which writes no file', () => {
  assert.match(EXPORT_GUIDE, /Never export to measure loudness\. POST \/api\/audio\/measure-mix \{from\?, to\?, comp\?\} measures the timeline mix with its volumes and effects and writes no file\./)
  for (const text of [EXPORT_GUIDE, ANALYSIS_HELP.mix]) {
    assert.doesNotMatch(text, /export it with the audio-wav preset|check-loudness/)
    assert.match(text, /POST \/api\/audio\/measure-mix \{from\?, to\?, comp\?\}/)
    assert.match(text, /GET \/api\/jobs\/wait\?id=ID/)
  }
  assert.ok(WRITES.has('/api/audio/measure-mix'), 'the agent may call it')
  assert.match(server, /'POST \/api\/audio\/measure-mix': body => startMixMeasure\(body\)\.then\(jobPublic\)/)
  // "writes no file": the function has no output path, no destination and no delivery record.
  const measure = server.slice(server.indexOf('async function startMixMeasure'), server.indexOf('function cleanupExportAudio'))
  assert.ok(measure.length > 500)
  assert.doesNotMatch(measure, /renders|createExportDestination|deliveries\.|checkExportOutput|saveProject|commit\(/)
  // "with neither, it measures what an export with no range would render"
  assert.match(measure, /!given\('from'\) && !given\('to'\) && selected\.range \? selected\.range : \{ in: 0, out: end \}/)
  assert.match(server, /range: spec\.range \?\? selected\.range \?\? \{ in: 0, out: duration\(selected\) \}/)
  // "lufs ... lra ... truePeak ... or silent:true with no truePeak": what the measurement returns.
  assert.match(measure, /job\.result = \{ \.\.\.parseLoudness\(err\), from, to, dur:/)
  assert.deepEqual(Object.keys(parseLoudness('Summary:\n I: -16.4 LUFS\n LRA: 3.2 LU\n Peak: -1.7 dBFS')), ['lufs', 'lra', 'truePeak'])
  assert.deepEqual(parseLoudness('Summary:\n I: -70.0 LUFS\n LRA: 0.0 LU\n Peak: -inf dBFS'), { lufs: -70, lra: 0, truePeak: undefined, silent: true })
  // The worker's uploads are accepted for a measurement, and its end runs the measurement.
  assert.match(server, /if \(!\['export', 'measure-mix'\]\.includes\(job\.kind\) \|\| job\.state !== 'queued' \|\| job\.audioUploaded\)/)
  assert.match(server, /await \(job\.kind === 'export' \? finishExport\(job\) : finishMixMeasure\(job\)\)/)
  // The worker reads source audio for the mix through the job, as it does for an export. Without
  // this a real measurement failed with "audio 410".
  assert.match(server, /!\['export', 'measure-mix'\]\.includes\(job\.kind\) \|\| job\.state !== 'queued' \|\| !job\.processing\?\.dispatched \|\| job\.processing\.drained\) return send\(res, 410, \{ error: 'This worker job cannot request audio' \}\)/)
})
