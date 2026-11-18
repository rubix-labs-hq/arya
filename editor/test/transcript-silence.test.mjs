// whisper.cpp answers digital silence with an invented word. Seen on 2026-11-17: a 10 s clip with
// no sound came back as [{t:0,end:2,text:"You"}], with and without --suppress-nst.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createTranscriptRoutes, SILENT_SOURCE_WARNING } from '../routes/transcript.mjs'
import { wavHasSignal } from '../core/wav-signal.mjs'
import { applyOps, newProject } from '../core/project.js'

/** A 16 kHz mono 16-bit WAV as ffmpeg writes it, with a LIST chunk before the samples. */
function wav(samples, { list = true, bits = 16 } = {}) {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((value, i) => data.writeInt16LE(value, i * 2))
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'latin1'); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(16000, 12); fmt.writeUInt32LE(32000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(bits, 22)
  const info = Buffer.from('INFOISFT\x0e\0\0\0Lavf61.7.100\0\0', 'latin1'), listChunk = Buffer.concat([Buffer.from('LIST', 'latin1'), Buffer.alloc(4), info])
  listChunk.writeUInt32LE(info.length, 4)
  const head = Buffer.alloc(8); head.write('data', 0, 'latin1'); head.writeUInt32LE(data.length, 4)
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), fmt, ...(list ? [listChunk] : []), head, data])
  const riff = Buffer.alloc(8); riff.write('RIFF', 0, 'latin1'); riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}
const silence = seconds => new Array(16000 * seconds).fill(0)
const tone = seconds => Array.from({ length: 16000 * seconds }, (_, i) => Math.round(8000 * Math.sin(i * 2 * Math.PI * 440 / 16000)))

function fixture(t, audio) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-silence-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'media'))
  fs.writeFileSync(path.join(root, 'media', 'clip.mp4'), 'generated-fixture')
  const model = path.join(root, 'ggml-base.en.bin'); fs.writeFileSync(model, 'fixture-model')
  const project = applyOps(newProject('Silence'), [{ op: 'import', assets: { 'media/clip.mp4': { hasAudio: true, hasVideo: true, duration: 10 } } }]).project
  const jobs = [], runs = []
  const routes = createTranscriptRoutes({ root, resolveMedia: src => path.join(root, src), getProject: () => project, getVersion: () => 1, findWhisper: async () => 'fixture-whisper', modelPaths: [model],
    newJob: (kind, spec) => { const job = { id: `j${jobs.length + 1}`, kind, spec, state: 'queued', progress: 0 }; jobs.push(job); return job }, publish: () => {},
    process: async (command, args) => {
      runs.push(command)
      // The recognizer answers every input the way whisper.cpp answers silence.
      if (args.includes('-of')) fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ transcription: [{ offsets: { from: 0, to: 2000 }, text: ' You' }] }))
      else if (audio !== null) fs.writeFileSync(args.at(-1), audio)
    } })
  return { root, routes, jobs, runs }
}

test('a level check reads 16-bit PCM WAV and says unknown for anything else', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-wav-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (name, bytes) => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file }
  assert.equal(await wavHasSignal(write('silent.wav', wav(silence(2)))), false)
  assert.equal(await wavHasSignal(write('tone.wav', wav(tone(2)))), true)
  assert.equal(await wavHasSignal(write('plain.wav', wav(tone(1), { list: false }))), true)
  // -60 dBFS is 32.77 of 32768: 32 is below it, 33 and -33 reach it.
  assert.equal(await wavHasSignal(write('floor.wav', wav([...silence(1), 32, -32]))), false)
  assert.equal(await wavHasSignal(write('above.wav', wav([...silence(1), 33]))), true)
  assert.equal(await wavHasSignal(write('below.wav', wav([...silence(1), -33]))), true)
  // The last sample of a long file is still read: one loud sample after 70 s of silence.
  assert.equal(await wavHasSignal(write('late.wav', wav([...silence(70), 12000]))), true)
  for (const [name, bytes] of [['text.wav', Buffer.from('pcm-fixture')], ['empty.wav', wav([])], ['wide.wav', wav(tone(1), { bits: 24 })], ['cut.wav', wav(tone(1)).subarray(0, 30)]]) assert.equal(await wavHasSignal(write(name, bytes)), null, name)
  assert.equal(await wavHasSignal(path.join(root, 'missing.wav')), null)
})

test('a source with no audible sound saves no words, says why and never runs the recognizer', async t => {
  const f = fixture(t, wav(silence(10)))
  const result = await f.routes.transcribe({ src: 'media/clip.mp4' })
  assert.deepEqual(result.words, [])
  assert.equal(result.status, 'complete'); assert.equal(result.revision, 1)
  assert.deepEqual(result.warnings, [SILENT_SOURCE_WARNING])
  assert.match(SILENT_SOURCE_WARNING, /^No audible audio in this clip\./)
  assert.deepEqual(f.runs, ['ffmpeg'], 'only the audio extraction ran')
  assert.equal(f.jobs[0].state, 'done'); assert.equal(f.jobs[0].message, 'No audible audio found')
  const saved = f.routes.get({}, new URLSearchParams({ src: 'media/clip.mp4' }))
  assert.deepEqual(saved.words, []); assert.deepEqual(saved.warnings, [SILENT_SOURCE_WARNING])
})

test('a source with sound still runs the recognizer and keeps its words', async t => {
  const f = fixture(t, wav([...silence(3), ...tone(2)]))
  const result = await f.routes.transcribe({ src: 'media/clip.mp4' })
  assert.deepEqual(f.runs, ['ffmpeg', 'fixture-whisper'])
  assert.deepEqual(result.words, [{ t: 0, end: 2, text: 'You' }]); assert.deepEqual(result.warnings, [])
})

test('audio whose level cannot be read is recognized as before', async t => {
  for (const audio of [Buffer.from('pcm-fixture'), null]) {
    const f = fixture(t, audio)
    const result = await f.routes.transcribe({ src: 'media/clip.mp4' })
    assert.deepEqual(f.runs, ['ffmpeg', 'fixture-whisper'])
    assert.equal(result.words.length, 1); assert.deepEqual(result.warnings, [])
  }
})
