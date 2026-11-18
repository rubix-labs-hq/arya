import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { transcriptNotes, transcriptionSetup } from '../web/ui/transcript-jobs.js'

const panel = fs.readFileSync(new URL('../web/ui/transcript.js', import.meta.url), 'utf8')

test('a finished transcript shows its warnings and says when it holds no words', () => {
  const warning = 'Invented warning: three words were left out.'
  assert.deepEqual(transcriptNotes({ status: 'complete', words: [] }), ['No words were recognized.'])
  assert.deepEqual(transcriptNotes({ status: 'complete', words: [], warnings: [warning] }), [warning, 'No words were recognized.'])
  assert.deepEqual(transcriptNotes({ status: 'complete', words: [{ t: 0, end: 1, text: 'sample' }], warnings: [warning] }), [warning])
  assert.deepEqual(transcriptNotes({ status: 'ready', words: [{ t: 0, end: 1, text: 'sample' }] }), [])
  // The panel counts its draft words, which can differ from the saved record.
  assert.deepEqual(transcriptNotes({ status: 'complete', words: [] }, 4), [])
  assert.deepEqual(transcriptNotes({ status: 'partial', words: [], warnings: [warning] }), [warning])
  for (const record of [null, undefined, { status: 'missing', words: [] }, { status: 'stale', words: [], warnings: [warning] }]) assert.deepEqual(transcriptNotes(record), [])
  assert.deepEqual(transcriptNotes({ status: 'complete', words: [], warnings: [7, '', null] }), ['No words were recognized.'])
})

test('the setup text says transcription is not installed and carries the server next step', () => {
  assert.deepEqual(transcriptionSetup({ transcription: { available: false, reason: 'Install whisper.cpp to transcribe locally.', install: ['brew install whisper-cpp', 7, ''] } }),
    { text: 'Transcription is not installed on this computer. Install whisper.cpp to transcribe locally.', commands: ['brew install whisper-cpp'] })
  assert.deepEqual(transcriptionSetup({ transcription: { available: false } }), { text: 'Transcription is not installed on this computer.', commands: [] })
  for (const caps of [undefined, {}, { whisper: false }, { transcriber: 'speech' }, { transcription: { available: true, reason: 'unused' } }]) assert.equal(transcriptionSetup(caps), null)
})

test('the transcript panel renders the notes and the setup text, and keeps the wording of other hosts', () => {
  assert.match(panel, /const setup = available \? null : transcriptionSetup\(s\.caps\)/)
  assert.match(panel, /const notes = record\?\.status === 'partial' \|\| loading \|\| busy \? \[\] : transcriptNotes\(record, words\.length\)/)
  assert.match(panel, /\$\{notes\.map\(note => html`<div class="tr-status" role="status">\$\{note\}<\/div>`\)\}/)
  assert.match(panel, /setup \? `\$\{setup\.text\} You can also import a transcript file above\.`/)
  assert.match(panel, /Run in Terminal: <code>\$\{command\}<\/code>/)
  assert.match(panel, /Speech recognition is unavailable here\. Import a transcript file above\./)
  assert.match(panel, /This transcript is partial\. \$\{record\.warnings\?\.join\(' '\)/)
})
