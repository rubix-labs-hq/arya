import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import transcriptEndpoints, { createTranscriptRoutes, runTranscriptProcess } from '../routes/transcript.mjs'
import { applyOps, newProject } from '../core/project.js'

const words = [{ t: 1, end: 2, text: 'A' }, { t: 2.1, end: 3, text: 'complete' }, { t: 3.1, end: 4, text: 'sentence.' }, { t: 4.6, end: 6, text: 'Another' }, { t: 6.1, end: 8, text: 'sentence.' }]
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture(t, process) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel transcript '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'media'))
  fs.writeFileSync(path.join(root, 'media', 'speech.wav'), 'original-media')
  const model = path.join(root, 'ggml-base.en.bin'); fs.writeFileSync(model, 'fixture-model')
  let project = applyOps(newProject('Transcript test'), [{ op: 'import', assets: { 'media/speech.wav': { hasAudio: true, hasVideo: false, duration: 90 } } }]).project
  let version = 1
  const history = [], jobs = [], events = []
  const routes = createTranscriptRoutes({ root, resolveMedia: src => path.join(root, src), getProject: () => project, getVersion: () => version, findWhisper: async () => 'fixture-whisper', modelPaths: [model],
    newJob: (kind, spec) => { const job = { id: `j${jobs.length + 1}`, kind, spec, state: 'queued', progress: 0 }; jobs.push(job); return job },
    publish: job => events.push({ ...job }), process: process ?? (async (_command, args) => {
      if (args.includes('-of')) fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ transcription: words.map(w => ({ offsets: { from: w.t * 1000, to: w.end * 1000 }, text: w.text })) }))
      else fs.writeFileSync(args.at(-1), 'pcm-fixture')
    }),
    apply: (ops, summary) => { history.push(project); project = applyOps(project, ops).project; version++; return { project, version, applied: true, summary } },
  })
  const get = () => routes.get({}, new URLSearchParams({ src: 'media/speech.wav', locale: 'en-US' }))
  return { root, routes, get, jobs, events, history, project: () => project, version: () => version }
}

test('saved corrections survive a project move and reject a stale revision or replaced source', async t => {
  const f = fixture(t)
  assert.equal(f.get().status, 'missing')
  const first = f.routes.save({ src: 'media/speech.wav', locale: 'en-US', words, revision: 0 })
  const corrected = words.map((w, i) => i === 1 ? { ...w, text: 'corrected' } : w)
  const second = f.routes.save({ src: 'media/speech.wav', locale: 'en-US', words: corrected, revision: first.revision })
  assert.equal(second.revision, first.revision + 1)
  assert.equal(f.get().words[1].text, 'corrected')
  assert.throws(() => f.routes.save({ src: 'media/speech.wav', words, revision: first.revision }), /transcript changed/)
  assert.equal(fs.readFileSync(path.join(f.root, 'media/speech.wav'), 'utf8'), 'original-media')
  const moved = f.root + ' moved'; t.after(() => fs.rmSync(moved, { recursive: true, force: true })); fs.renameSync(f.root, moved)
  const reader = createTranscriptRoutes({ root: moved, resolveMedia: src => path.join(moved, src), getProject: f.project })
  const movedValue = reader.get({}, new URLSearchParams({ src: 'media/speech.wav', locale: 'en-US' }))
  assert.equal(movedValue.words[1].text, 'corrected')
  fs.appendFileSync(path.join(moved, 'media/speech.wav'), 'replacement')
  const stale = reader.get({}, new URLSearchParams({ src: 'media/speech.wav', locale: 'en-US' }))
  assert.equal(stale.status, 'stale'); assert.equal(stale.revision, second.revision); assert.deepEqual(stale.words, [])
  const storedFile = path.join(moved, '.reel/transcripts', fs.readdirSync(path.join(moved, '.reel/transcripts'))[0])
  const savedBytes = fs.readFileSync(storedFile)
  assert.throws(() => reader.save({ src: 'media/speech.wav', words: corrected, revision: second.revision }), /source changed/)
  assert.deepEqual(fs.readFileSync(storedFile), savedBytes)
})

test('legacy transcript fingerprints stay readable without rewriting and upgrade on correction save', t => {
  const f = fixture(t), source = path.join(f.root, 'media/speech.wav')
  const saved = f.routes.save({ src: 'media/speech.wav', locale: 'en-US', words, revision: 0 })
  assert.match(saved.fingerprint, /^v2\|\d+\|-?\d+\|\d+$/)
  const record = path.join(f.root, '.reel/transcripts', fs.readdirSync(path.join(f.root, '.reel/transcripts'))[0])
  const stat = fs.statSync(source, { bigint: true }), micros = (stat.mtimeNs + 500n) / 1000n
  const legacyTime = `${micros / 1000n}.${String(micros % 1000n).padStart(3, '0')}`
  const legacy = Buffer.from(JSON.stringify({ ...saved, fingerprint: `${stat.size}|${legacyTime}`, status: 'partial', provider: 'apple-speech', warnings: ['Review ending'] }))
  fs.writeFileSync(record, legacy)
  assert.equal(f.get().status, 'partial')
  assert.deepEqual(f.get().words, words)
  assert.deepEqual(fs.readFileSync(record), legacy)
  const upgraded = f.routes.save({ src: 'media/speech.wav', locale: 'en-US', words, revision: 1 })
  assert.equal(upgraded.revision, 2)
  assert.equal(upgraded.status, 'partial')
  assert.equal(upgraded.provider, 'apple-speech')
  assert.deepEqual(upgraded.warnings, ['Review ending'])
  assert.match(upgraded.fingerprint, /^v2\|/)
})

test('legacy compatibility rejects malformed fingerprints and same-size changes inside one millisecond', t => {
  const f = fixture(t), source = path.join(f.root, 'media/speech.wav')
  const anchor = 1800000000.1233
  fs.utimesSync(source, anchor, anchor)
  const saved = f.routes.save({ src: 'media/speech.wav', locale: 'en-US', words, revision: 0 })
  const record = path.join(f.root, '.reel/transcripts', fs.readdirSync(path.join(f.root, '.reel/transcripts'))[0])
  const stat = fs.statSync(source, { bigint: true })
  const micros = (stat.mtimeNs + 500n) / 1000n
  const time = `${micros / 1000n}.${String(micros % 1000n).padStart(3, '0')}`
  for (const fingerprint of [`0${stat.size}|${time}`, `${stat.size}|${time}\n`, `${stat.size}|${time.slice(0, -1)}`, `${stat.size}|${time}0`, `${stat.size}|NaN`, 'v3|14|1800000000|123000000']) {
    fs.writeFileSync(record, JSON.stringify({ ...saved, fingerprint }))
    assert.equal(f.get().status, 'stale', fingerprint)
  }
  const legacy = Buffer.from(JSON.stringify({ ...saved, fingerprint: `${stat.size}|${time}` }))
  fs.writeFileSync(record, legacy)
  assert.equal(f.get().status, 'complete')
  fs.writeFileSync(source, 'replaced-media')
  fs.utimesSync(source, anchor + .0002, anchor + .0002)
  const replaced = fs.statSync(source, { bigint: true })
  assert.equal(replaced.size, stat.size)
  assert.equal(replaced.mtimeNs / 1000000n, stat.mtimeNs / 1000000n)
  assert.equal(f.get().status, 'stale')
  assert.throws(() => f.routes.save({ src: 'media/speech.wav', locale: 'en-US', words, revision: 1 }), /source changed/)
  assert.deepEqual(fs.readFileSync(record), legacy)
})

test('recognition source guards stay exact even when a legacy record has microsecond compatibility', async t => {
  const anchor = 1800000000.1233
  let f
  f = fixture(t, async (_command, args) => {
    if (!args.includes('-of')) return fs.writeFileSync(args.at(-1), 'pcm-fixture')
    fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ transcription: [{ offsets: { from: 100, to: 300 }, text: 'Late result' }] }))
    fs.utimesSync(path.join(f.root, 'media/speech.wav'), anchor + .0000004, anchor + .0000004)
  })
  const source = path.join(f.root, 'media/speech.wav')
  fs.utimesSync(source, anchor, anchor)
  const saved = f.routes.save({ src: 'media/speech.wav', words, revision: 0 })
  const record = path.join(f.root, '.reel/transcripts', fs.readdirSync(path.join(f.root, '.reel/transcripts'))[0])
  const before = fs.statSync(source, { bigint: true }).mtimeNs, micros = (before + 500n) / 1000n
  const legacy = Buffer.from(JSON.stringify({ ...saved, fingerprint: `14|${micros / 1000n}.${String(micros % 1000n).padStart(3, '0')}` }))
  fs.writeFileSync(record, legacy)
  await assert.rejects(f.routes.transcribe({ src: 'media/speech.wav' }), /source changed while transcribing/)
  const distance = fs.statSync(source, { bigint: true }).mtimeNs - before
  assert.ok(distance > 0n && distance < 1000n)
  assert.deepEqual(fs.readFileSync(record), legacy)
  assert.equal(f.jobs[0].state, 'failed')
  assert.equal(f.events.some(event => event.state === 'done'), false)
})

test('caption and shorts previews do not mutate the project and apply as one undoable edit', async t => {
  const f = fixture(t)
  f.routes.save({ src: 'media/speech.wav', words, revision: 0 })
  const before = JSON.stringify(f.project()), version = f.version()
  const preview = await f.routes.build({ src: 'media/speech.wav', ranges: [{ from: 1, to: 8, name: 'Editable speech' }], captions: true, captionStyle: 'karaoke' })
  assert.equal(JSON.stringify(f.project()), before)
  assert.equal(preview.comps.length, 1)
  const applied = await f.routes.build({ src: 'media/speech.wav', ranges: [{ from: 1, to: 8, name: 'Editable speech' }], captions: true, captionStyle: 'karaoke', apply: true, expectedVersion: version })
  assert.equal(f.history.length, 1)
  const comp = f.project().comps[applied.comps[0].id]
  assert.ok(comp.tracks.some(track => track.kind === 'caption' && track.clips.some(clip => clip.words?.length)))
  assert.equal(JSON.stringify(f.history[0]), before)
  await assert.rejects(f.routes.build({ src: 'media/speech.wav', ranges: [{ from: 1, to: 8 }], apply: true, expectedVersion: version }), /project changed/)
  assert.equal(f.history.length, 1)
})

test('fresh recognition can replace a stale transcript without carrying its source warning', async t => {
  const f = fixture(t)
  f.routes.save({ src: 'media/speech.wav', words, revision: 0 })
  fs.appendFileSync(path.join(f.root, 'media/speech.wav'), 'replacement')
  assert.equal(f.get().status, 'stale')
  const fresh = await f.routes.transcribe({ src: 'media/speech.wav' })
  assert.equal(fresh.status, 'complete'); assert.equal(fresh.revision, 2)
  assert.equal(fresh.warning, undefined)
  assert.deepEqual(f.get().words, words)
})

test('recognition requests whole-word segments and preserves their source timestamps', async t => {
  const segments = [
    { offsets: { from: 0, to: 20 }, text: '' },
    { offsets: { from: 930, to: 1410 }, text: ' built-in' },
    { offsets: { from: 3400, to: 3910 }, text: ' editable' },
    { offsets: { from: 5480, to: 6480 }, text: ' timestamps,' },
    { offsets: { from: 10670, to: 11320 }, text: ' recording.' },
  ]
  const f = fixture(t, async (_command, args) => {
    if (!args.includes('-of')) return fs.writeFileSync(args.at(-1), 'pcm-fixture')
    assert.equal(args[args.indexOf('-ml') + 1], '1')
    assert.ok(args.includes('-sow'), 'Whisper must split on words rather than subword tokens')
    fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ transcription: segments }))
  })
  const result = await f.routes.transcribe({ src: 'media/speech.wav' })
  assert.deepEqual(result.words, [
    { t: 0.93, end: 1.41, text: 'built-in' },
    { t: 3.4, end: 3.91, text: 'editable' },
    { t: 5.48, end: 6.48, text: 'timestamps,' },
    { t: 10.67, end: 11.32, text: 'recording.' },
  ])
  assert.equal(f.get().words.length, 4)
})

test('cancelling a pending recognition cannot save or publish late words', async t => {
  const gate = deferred()
  const f = fixture(t, async (_command, args) => {
    if (!args.includes('-of')) return fs.writeFileSync(args.at(-1), 'pcm-fixture')
    await gate.promise
    fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ transcription: words.map(w => ({ offsets: { from: w.t * 1000, to: w.end * 1000 }, text: w.text })) }))
  })
  const job = await f.routes.transcribe({ src: 'media/speech.wav', wait: false })
  assert.equal(job.id, 'j1')
  f.jobs[0].cancel()
  gate.resolve()
  for (let i = 0; i < 10 && f.jobs[0].state !== 'failed'; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.jobs[0].state, 'failed')
  assert.equal(f.get().status, 'missing')
  assert.equal(f.events.filter(event => event.state === 'done').length, 0)
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.reel/transcripts')), [])
})

test('linked transcript outputs cannot overwrite an outside file', async t => {
  const f = fixture(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'reel transcript outside ')); t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'sentinel'), 'preserved')
  fs.mkdirSync(path.join(f.root, '.reel'))
  fs.symlinkSync(outside, path.join(f.root, '.reel/transcripts'))
  assert.throws(() => f.get(), /symbolic links/)
  assert.throws(() => f.routes.save({ src: 'media/speech.wav', words }), /symbolic links/)
  await assert.rejects(f.routes.transcribe({ src: 'media/speech.wav' }), /symbolic links/)
  assert.deepEqual(fs.readdirSync(outside), ['sentinel'])
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'preserved')
})

test('source replacement during recognition discards its stale transcript', async t => {
  const gate = deferred()
  const f = fixture(t, async (_command, args) => {
    if (!args.includes('-of')) return fs.writeFileSync(args.at(-1), 'pcm-fixture')
    await gate.promise
    fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ transcription: words.map(w => ({ offsets: { from: w.t * 1000, to: w.end * 1000 }, text: w.text })) }))
  })
  const work = f.routes.transcribe({ src: 'media/speech.wav' })
  await new Promise(resolve => setImmediate(resolve))
  fs.appendFileSync(path.join(f.root, 'media/speech.wav'), 'changed')
  gate.resolve()
  await assert.rejects(work, /source changed/)
  assert.equal(f.get().status, 'missing')
  assert.equal(f.events.filter(event => event.state === 'done').length, 0)
})

test('owned transcription processes cancel without leaving a running child', async () => {
  const controller = new AbortController()
  const work = runTranscriptProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal })
  controller.abort()
  await assert.rejects(work, error => error.name === 'AbortError')
})

test('transcript saves and raw recognition enforce the 16 MB limit before publication', async t => {
  const f = fixture(t)
  const tooLarge = Array.from({ length: 18000 }, () => ({ t: 0, end: 0.5, text: 'a'.repeat(1000) }))
  assert.throws(() => f.routes.save({ src: 'media/speech.wav', words: tooLarge }), /larger than 16 MB/)
  assert.equal(f.get().status, 'missing')
  const recognition = fixture(t, async (_command, args) => {
    if (!args.includes('-of')) return fs.writeFileSync(args.at(-1), 'pcm-fixture')
    const file = args[args.indexOf('-of') + 1] + '.json'
    fs.writeFileSync(file, '')
    fs.truncateSync(file, 16 * 1024 * 1024 + 1)
  })
  await assert.rejects(recognition.routes.transcribe({ src: 'media/speech.wav' }), /recognized transcript is larger than 16 MB/)
  assert.equal(recognition.get().status, 'missing')
  assert.equal(recognition.events.some(event => event.state === 'done'), false)
})

test('transcript word pages are bounded and retain the complete saved record', async t => {
  const f = fixture(t)
  const list = Array.from({ length: 1500 }, (_, i) => ({ t: i / 100, end: i / 100 + 0.005, text: `Word${i}` }))
  f.routes.save({ src: 'media/speech.wav', words: list, revision: 0 })
  const page = f.routes.get({}, new URLSearchParams({ src: 'media/speech.wav', limit: '999999' }))
  assert.equal(page.words.length, 1000); assert.equal(page.totalWords, 1500); assert.equal(page.nextOffset, 1000)
  const last = f.routes.get({}, new URLSearchParams({ src: 'media/speech.wav', offset: '1000' }))
  assert.equal(last.words.length, 500); assert.equal(last.words[0].text, 'Word1000'); assert.equal(last.nextOffset, null)
  assert.equal(f.get().words.length, 1500)
  assert.throws(() => f.routes.get({}, new URLSearchParams({ src: 'media/speech.wav', offset: '-1' })), /nonnegative offset/)
})


test('manual POST on a missing saved transcript reloads as manual and supplies QA Shorts suggestions', async t => {
 const f=fixture(t),endpoints=transcriptEndpoints({transcripts:f.routes}).routes
 const qa=[{t:.5,end:1.25,text:'Look'},{t:2,end:2.75,text:'closer.'},{t:4.5,end:5.25,text:'Keep'},{t:6,end:6.75,text:'it editable.'},{t:8.5,end:9.25,text:'Ready'},{t:10,end:10.75,text:'to deliver.'}]
 const query=new URLSearchParams({src:'media/speech.wav',locale:'en-US'})
 const missing=endpoints['GET /api/transcript']({},query);assert.equal(missing.status,'missing');assert.equal(missing.revision,0)
 const saved=endpoints['POST /api/transcript']({src:'media/speech.wav',locale:'en-US',revision:missing.revision,words:qa})
 assert.equal(saved.provider,'manual');assert.equal(saved.status,'complete');assert.equal(saved.revision,1);assert.match(saved.fingerprint,/^v2\|/)
 const loaded=endpoints['GET /api/transcript']({},query);assert.deepEqual(loaded.words,qa);assert.equal(loaded.provider,'manual');assert.equal(loaded.revision,saved.revision);assert.equal(loaded.fingerprint,saved.fingerprint)
 const proposed=await endpoints['POST /api/shorts/propose']({src:'media/speech.wav',locale:'en-US',minDur:1,maxDur:8,count:1})
 assert.equal(proposed.candidates.length,1);assert.equal(f.jobs.length,0);assert.equal(f.history.length,0)
 assert.equal(fs.readFileSync(path.join(f.root,'media/speech.wav'),'utf8'),'original-media')
})
test('manual correction keeps recognized provenance while retaining status, source identity and revision guards', async t => {
 const f=fixture(t),endpoints=transcriptEndpoints({transcripts:f.routes}).routes
 const recognized=await f.routes.transcribe({src:'media/speech.wav',locale:'en-US'})
 assert.equal(recognized.provider,'whisper.cpp');assert.equal(recognized.status,'complete')
 const corrected=words.map((w,i)=>i===0?{...w,text:'Edited'}:w)
 const manual=endpoints['POST /api/transcript']({src:'media/speech.wav',locale:'en-US',words:corrected,revision:recognized.revision,provider:'apple-speech',status:'partial',fingerprint:'forged',warnings:['forged']})
 assert.equal(manual.provider,recognized.provider);assert.equal(manual.status,recognized.status);assert.equal(manual.revision,recognized.revision+1);assert.equal(manual.fingerprint,recognized.fingerprint);assert.deepEqual(manual.warnings,recognized.warnings)
 assert.equal(f.get().provider,recognized.provider);assert.equal(f.get().words[0].text,'Edited')
 assert.throws(()=>endpoints['POST /api/transcript']({src:'media/speech.wav',locale:'en-US',words:corrected,revision:recognized.revision}),/transcript changed/)
 fs.appendFileSync(path.join(f.root,'media/speech.wav'),'changed source')
 assert.equal(f.get().status,'stale');assert.throws(()=>endpoints['POST /api/transcript']({src:'media/speech.wav',locale:'en-US',words:corrected,revision:manual.revision}),/source changed/)
})
test('manual POST body cannot claim recognition provider or replace persisted status/source metadata', t => {
 const f=fixture(t),post=transcriptEndpoints({transcripts:f.routes}).routes['POST /api/transcript']
 const saved=post({src:'media/speech.wav',locale:'en-US',words,revision:0,provider:'whisper.cpp',status:'recognized-by-paid-provider',fingerprint:'forged-source'})
 assert.equal(saved.provider,'manual');assert.equal(saved.status,'complete');assert.notEqual(saved.fingerprint,'forged-source');assert.equal(saved.revision,1)
 assert.equal(f.get().provider,'manual')
})
