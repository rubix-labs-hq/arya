// The export guide is added to the assistant prompt only for the browser editor, and what it says
// about names and deletion is what the server does.
// Seen on 2026-11-16: the assistant exported the whole mix to measure its loudness and left a 10 MB
// renders/Vertical.wav behind without telling the user.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { EXPORT_GUIDE, FOCUS_GUIDE, INSTRUCTIONS, REVIEW_GUIDE, WRITES, promptFor } from '../agent/protocol.mjs'

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
  assert.match(server, /if \(kind === 'loudness'\) \{\n[^\n]*'-i', abs, '-vn', '-af', 'ebur128=framelog=quiet'/)
})
