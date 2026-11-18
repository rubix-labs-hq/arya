// The assistant learned that transcription was unavailable only by trying. Seen on 2026-11-17: one
// request ran for 601 s and ended "Arya's local transcriber is unavailable", with no install step.
// A run from the browser editor now starts with the fact, the reason and the commands.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EXPORT_GUIDE, FOCUS_GUIDE, INSTRUCTIONS, TRANSCRIPTION_UNAVAILABLE_GUIDE, TRANSCRIPT_IMPORT_GUIDE, promptFor } from '../agent/protocol.mjs'
import { createTranscriptRoutes, WHISPER_INSTALL_COMMAND, WHISPER_MODEL_COMMAND } from '../routes/transcript.mjs'
import { applyOps, newProject } from '../core/project.js'
import { promptContext, runningServer } from './fixtures/running-server.mjs'

const unavailable = { available: false, provider: 'whisper.cpp', reason: 'Install whisper.cpp to transcribe locally.', install: [WHISPER_INSTALL_COMMAND, WHISPER_MODEL_COMMAND] }

function service(t, { binary = 'fixture-whisper', model = true, saved = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-transcription-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'media')); fs.writeFileSync(path.join(root, 'media/talk.wav'), 'generated-fixture')
  const file = path.join(root, 'ggml-base.en.bin'); if (model) fs.writeFileSync(file, 'fixture-model')
  const project = applyOps(newProject('Guide'), [{ op: 'import', assets: { 'media/talk.wav': { hasAudio: true, hasVideo: false, duration: 30 } } }, { op: 'append', track: 'A1', src: 'media/talk.wav', dur: 30 }]).project
  const runs = [], jobs = []
  const routes = createTranscriptRoutes({ root, resolveMedia: src => path.join(root, src), getProject: () => project, getVersion: () => 1, findWhisper: async () => binary, modelPaths: [file],
    newJob: (kind, spec) => { const job = { id: 'j1', kind, spec, state: 'queued' }; jobs.push(job); return job }, publish: () => {}, process: async command => { runs.push(command) }, apply: () => ({}) })
  if (saved) routes.save({ src: 'media/talk.wav', words: [{ t: 1, end: 1.5, text: 'Hello' }, { t: 1.6, end: 2, text: 'there' }] })
  return { routes, runs, jobs }
}

test('the guide and the import guide follow the other guides only when the outline says so', () => {
  const outline = { outline: 'x', focus: 'Open: Main timeline', exportFolder: 'renders' }
  const none = promptFor({ text: 'Caption it.', context: {}, outline })
  assert.ok(none.startsWith(`${INSTRUCTIONS}\n${FOCUS_GUIDE}\n${EXPORT_GUIDE}\n\n<immutable_reel_context>`), 'a host that sends no transcription field keeps its prompt')
  const ready = promptFor({ text: 'Caption it.', context: {}, outline: { ...outline, transcription: { available: true, provider: 'whisper.cpp' } } })
  assert.ok(ready.startsWith(`${INSTRUCTIONS}\n${FOCUS_GUIDE}\n${EXPORT_GUIDE}\n${TRANSCRIPT_IMPORT_GUIDE}\n\n<immutable_reel_context>`))
  assert.equal(ready.includes(TRANSCRIPTION_UNAVAILABLE_GUIDE), false); assert.equal(ready.includes('brew install'), false)
  const missing = promptFor({ text: 'Caption it.', context: {}, outline: { ...outline, transcription: unavailable } })
  assert.ok(missing.startsWith(`${INSTRUCTIONS}\n${FOCUS_GUIDE}\n${EXPORT_GUIDE}\n${TRANSCRIPTION_UNAVAILABLE_GUIDE}\n${TRANSCRIPT_IMPORT_GUIDE}\n\n<immutable_reel_context>`))
  // The commands reach the agent in the run context, exactly as the server wrote them.
  const context = promptContext(missing)
  assert.deepEqual(context.outline.transcription.install, ['brew install whisper-cpp', 'mkdir -p ~/.reel/models && curl -L -o ~/.reel/models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'])
  for (const value of [null, 'no', true]) assert.equal(promptFor({ text: 'x', outline: { transcription: value } }).includes(TRANSCRIPT_IMPORT_GUIDE), false)
})

test('the capability names only what is missing, and the file the README names', async t => {
  assert.deepEqual((await service(t).routes.capability()).install, undefined)
  assert.equal((await service(t).routes.capability()).available, true)
  const noBinary = await service(t, { binary: null }).routes.capability()
  assert.deepEqual({ available: noBinary.available, reason: noBinary.reason, install: noBinary.install }, { available: false, reason: 'Install whisper.cpp to transcribe locally.', install: [WHISPER_INSTALL_COMMAND] })
  const noModel = await service(t, { model: false }).routes.capability()
  assert.deepEqual({ available: noModel.available, reason: noModel.reason, install: noModel.install }, { available: false, reason: 'Download a whisper.cpp model to ~/.reel/models/ggml-base.en.bin.', install: [WHISPER_MODEL_COMMAND] })
  assert.deepEqual((await service(t, { binary: null, model: false }).routes.capability()).install, [WHISPER_INSTALL_COMMAND, WHISPER_MODEL_COMMAND])
  // The model command writes the path the lookup reads, and the README names the same file.
  const routes = fs.readFileSync(new URL('../routes/transcript.mjs', import.meta.url), 'utf8')
  assert.match(routes, /path\.join\(globalThis\.process\.env\.HOME \?\? '', '\.reel\/models\/ggml-base\.en\.bin'\)/)
  assert.match(WHISPER_MODEL_COMMAND, /-o ~\/\.reel\/models\/ggml-base\.en\.bin /)
  const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  assert.match(readme, /brew install whisper-cpp/); assert.match(readme, /~\/\.reel\/models\/ggml-base\.en\.bin/)
})

test('what the guide says about refused and working routes is what the routes do', async t => {
  const guide = TRANSCRIPTION_UNAVAILABLE_GUIDE
  // "POST /api/analyze with kind transcript is refused": before a job exists, so there is nothing to wait for.
  assert.match(guide, /POST \/api\/analyze with kind transcript is refused, so do not start, retry or wait for a transcript job/)
  for (const options of [{ binary: null }, { model: false }]) {
    const f = service(t, options)
    await assert.rejects(f.routes.transcribe({ src: 'media/talk.wav' }), /Transcription needs whisper\.cpp|Download a whisper\.cpp model to ~\/\.reel\/models\/ggml-base\.en\.bin first/)
    assert.deepEqual(f.jobs, []); assert.deepEqual(f.runs, [])
  }
  // "A transcript that is already saved still reads with GET /api/transcript, and captions and shorts still work from it."
  assert.match(guide, /already saved still reads with GET \/api\/transcript, and captions and shorts still work from it/)
  const saved = service(t, { binary: null, model: false, saved: true })
  assert.equal(saved.routes.get({}, new URLSearchParams({ src: 'media/talk.wav' })).words.length, 2)
  assert.equal((await saved.routes.captions({ src: 'media/talk.wav' })).words, 2)
  assert.equal((await saved.routes.propose({ src: 'media/talk.wav' })).src, 'media/talk.wav')
  // Without a saved transcript, captions would have to transcribe, and that is refused too.
  await assert.rejects(service(t, { binary: null }).routes.captions({ src: 'media/talk.wav' }), /Transcription needs whisper\.cpp/)
  // "Arya needs no restart afterwards": the binary and the model are looked up on every call.
  assert.match(guide, /say that Arya needs no restart afterwards/)
  let binary = null
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-transcription-live-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const model = path.join(root, 'ggml-base.en.bin')
  const live = createTranscriptRoutes({ root, resolveMedia: src => path.join(root, src), getProject: () => null, getVersion: () => 1, findWhisper: async () => binary, modelPaths: [model] })
  assert.equal((await live.capability()).available, false)
  binary = 'whisper-cli'; fs.writeFileSync(model, 'fixture-model')
  assert.deepEqual({ available: (await live.capability()).available, install: (await live.capability()).install }, { available: true, install: undefined })
  // "which you save with POST /api/transcript/import" is test/transcript-import-route.test.mjs.
  assert.match(guide, /POST \/api\/transcript\/import/)
})

test('the server tells a run that transcription is missing, with the commands', async t => {
  // An empty HOME and a PATH without whisper: both steps are missing.
  const server = await runningServer(t, [{ method: 'GET', path: '/api/caps' }], { env: root => { fs.mkdirSync(path.join(root, 'home')); return { HOME: path.join(root, 'home'), REEL_WHISPER_MODEL: '' } } })
  const agent = await server.ask('Add captions from what is said.')
  const { outline } = promptContext(agent.prompt)
  assert.deepEqual(outline.transcription, unavailable)
  assert.ok(agent.prompt.includes(TRANSCRIPTION_UNAVAILABLE_GUIDE)); assert.ok(agent.prompt.includes(TRANSCRIPT_IMPORT_GUIDE))
  assert.equal(agent.results[0].whisper, false); assert.deepEqual(agent.results[0].transcription.install, unavailable.install)
})

test('the server tells a run that transcription works once the binary and model exist, without a restart', async t => {
  const server = await runningServer(t, [], { env: root => { fs.mkdirSync(path.join(root, 'home')); return { HOME: path.join(root, 'home'), REEL_WHISPER_MODEL: path.join(root, 'model.bin') } } })
  const before = promptContext((await server.ask('Add captions from what is said.')).prompt).outline.transcription
  assert.equal(before.available, false); assert.deepEqual(before.install, unavailable.install)
  // Installed while the server runs.
  fs.writeFileSync(path.join(server.root, 'bin', 'whisper-cli'), `#!${process.execPath}\n`, { mode: 0o700 }); fs.writeFileSync(path.join(server.root, 'model.bin'), 'fixture-model')
  const agent = await server.ask('Add captions from what is said.')
  assert.deepEqual(promptContext(agent.prompt).outline.transcription, { available: true, provider: 'whisper.cpp' })
  assert.equal(agent.prompt.includes(TRANSCRIPTION_UNAVAILABLE_GUIDE), false); assert.ok(agent.prompt.includes(TRANSCRIPT_IMPORT_GUIDE))
})
