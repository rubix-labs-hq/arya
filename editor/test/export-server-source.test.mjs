import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createProcessingAdmission } from '../core/processing-admission.mjs'
import { frameJobDeadline, queuedJobWait, reserveProcessingWorker } from '../core/processing-worker.mjs'
import { validateExportSpec, exportFileName } from '../core/processing-export.js'
import { captureExportSources, prepareExportCohort, createExportDestination } from '../core/export-cohort.mjs'
import { guardedOutput } from '../core/output-path.js'
import interchangeRoutes from '../routes/interchange.mjs'
import { DeliveryHistory } from '../core/delivery-history.js'
import { parseLoudness } from '../core/analysis-parse.js'

const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
const exportSource = source.slice(source.indexOf('const PRESETS ='), source.indexOf('// ---------------------------------------------------------------- routes'))
const turn = () => new Promise(resolve => setImmediate(resolve))
// Time-bounded, not turn-bounded: file work takes more event-loop turns on a loaded machine.
async function until(predicate) { const deadline = Date.now() + 10000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Source fixture did not settle'); await turn() } }

function fixture(t, overrides = {}) {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-export-server-source-'))
  t.after(() => fs.rmSync(ROOT, { recursive: true, force: true }))
  const DOT = path.join(ROOT, '.reel'); fs.mkdirSync(DOT)
  fs.mkdirSync(path.join(ROOT, 'media')); fs.writeFileSync(path.join(ROOT, 'media/source.mp4'), 'accepted source bytes')
  const project = { name: 'Source fixture', width: 320, height: 180, fps: 30, assets: { 'media/source.mp4': {} }, tracks: [{ clips: [{ kind: 'video', src: 'media/source.mp4', start: 0, dur: 1 }] }] }
  const events = [], encoders = [], admission = createProcessingAdmission()
  const values = { ROOT, DOT, fs, path, createProcessingAdmission, reserveProcessingWorker, validateExportSpec, exportFileName, captureExportSources, prepareExportCohort, createExportDestination, guardedOutput, initialProject: project, processing: admission,
    armProcessingWorkerCancellation: () => () => {}, ensureWorker: async () => {}, touchWorker: () => {}, assistantCalls: { getStore: () => null },
    queuedJobWait, frameJobDeadline, parseLoudness, workerConnected: () => true, exportCopyDigests: new Map(), log: () => {}, ...overrides,
    duration: overrides.duration ?? (() => 1), compView: (p, name) => p.comps?.[name], pushActivity: () => {}, deliveries: new DeliveryHistory(ROOT),
    broadcast: (type, data) => events.push({ type, data }), spawn: (_cmd, args) => {
      const ff = new EventEmitter(); ff.stderr = new EventEmitter(); ff.stdin = new EventEmitter(); ff.stdin.end = () => {}; ff.kills = []; ff.kill = signal => ff.kills.push(signal); ff.argv = args; encoders.push(ff); return ff
    } }
  const f = new Function(...Object.keys(values), `let project = initialProject, version = 1; const jobs = new Map(), worker = {}; function captureProcessing() { const initial = project, revision = version; return { assertCurrent() { if (project !== initial || version !== revision) throw new Error('The project changed') } } }\n${exportSource}\nreturn { startExport, startEncoder, finishExport, startMixMeasure, finishMixMeasure, failJob, jobPublic, renderFrame, jobs, changeProject() { project = {...project}; version++ } }`)(...Object.values(values))
  return { ROOT, project, f, events, encoders, admission, exportCopyDigests: values.exportCopyDigests }
}

test('actual server export methods dispatch backend snapshot copies and publish a new destination', async t => {
  const { ROOT, project, f, events, encoders, admission } = fixture(t)
  const job = await f.startExport({ name: 'new-result' })
  await until(() => events.some(e => e.type === 'render'))
  const payload = events.find(e => e.type === 'render').data
  assert.notEqual(payload.project.tracks[0].clips[0].src, project.tracks[0].clips[0].src)
  assert.equal(fs.readFileSync(path.join(ROOT, payload.project.tracks[0].clips[0].src), 'utf8'), 'accepted source bytes')
  assert.match(payload.job.spec.sourceCohort.projectSHA256, /^[a-f0-9]{64}$/)
  assert.match(payload.job.spec.sourceCohort.sourcesSHA256, /^[a-f0-9]{64}$/)
  assert.equal(payload.job.spec.sourceCohort.count, 1)
  assert.equal('exportSources' in f.jobPublic(job), false); assert.equal('exportDestination' in f.jobPublic(job), false)
  assert.equal(job.exportCopies.length, 1, 'the server keeps the copy paths for the audio cache')
  assert.equal('exportCopies' in f.jobPublic(job), false); assert.equal('exportCopies' in payload.job, false); assert.equal('frameDeadline' in f.jobPublic(job), false)
  f.startEncoder(job); assert.equal(encoders.length, 1); assert.ok(encoders[0].argv.includes('-n')); assert.notEqual(encoders[0].argv.at(-1), job.spec.out)
  fs.writeFileSync(encoders[0].argv.at(-1), 'synthetic encoded bytes'); encoders[0].emit('close', 0)
  await f.finishExport(job); assert.equal(job.state, 'done'); assert.equal(job.outputState, 'published')
  assert.equal(fs.readFileSync(job.spec.out, 'utf8'), 'synthetic encoded bytes')
  const receipt = new DeliveryHistory(ROOT).read()[0]
  assert.deepEqual(receipt.sourceCohort, job.spec.sourceCohort)
  assert.deepEqual(new DeliveryHistory(ROOT).list().deliveries[0].sourceCohort, job.spec.sourceCohort)
  job.processing.acknowledge(); await until(() => admission.snapshot().active === 0)
  assert.equal(fs.existsSync(path.join(ROOT, payload.project.tracks[0].clips[0].src)), false)
})

for (const mutation of ['source', 'destination', 'project']) test(`actual server methods refuse late ${mutation} changes before final publication`, async t => {
  const { ROOT, f, events, encoders, admission } = fixture(t)
  const job = await f.startExport({ name: 'refuse-result' }); await until(() => events.some(e => e.type === 'render'))
  f.startEncoder(job); fs.writeFileSync(encoders[0].argv.at(-1), 'synthetic encoded bytes'); encoders[0].emit('close', 0)
  if (mutation === 'source') fs.writeFileSync(path.join(ROOT, 'media/source.mp4'), 'changed source bytes')
  if (mutation === 'destination') fs.writeFileSync(job.spec.out, 'late destination sentinel')
  if (mutation === 'project') f.changeProject()
  await assert.rejects(f.finishExport(job), /changed|appeared/)
  f.failJob(job, new Error('Refused current source or destination'))
  assert.equal(job.state, 'failed'); assert.equal(job.outputState, 'staged'); assert.deepEqual(job.partialOutputs, [])
  assert.equal(fs.existsSync(job.spec.out), mutation === 'destination')
  if (mutation === 'destination') assert.equal(fs.readFileSync(job.spec.out, 'utf8'), 'late destination sentinel')
  job.processing.acknowledge(); await until(() => admission.snapshot().active === 0)
})

for (const target of ['original', 'copy']) test(`actual finishExport refuses a changed ${target} after its asynchronous source check`, async t => {
  const { ROOT, f, events, encoders, admission } = fixture(t)
  const job = await f.startExport({ name: 'final-source-refusal' })
  await until(() => events.some(e => e.type === 'render'))
  f.startEncoder(job)
  fs.writeFileSync(encoders[0].argv.at(-1), 'synthetic encoded bytes')
  encoders[0].emit('close', 0)
  const originalCheck = job.exportSources.assertCurrent.bind(job.exportSources)
  job.exportSources.assertCurrent = async check => {
    await originalCheck(check)
    const payload = events.find(e => e.type === 'render').data
    const file = target === 'original' ? path.join(ROOT, 'media/source.mp4') : path.join(ROOT, payload.project.tracks[0].clips[0].src)
    fs.chmodSync(file, 0o600)
    fs.writeFileSync(file, 'changed after asynchronous validation')
  }
  await assert.rejects(f.finishExport(job), /changed/)
  assert.equal(fs.existsSync(job.spec.out), false)
  assert.notEqual(job.state, 'done')
  f.failJob(job, new Error('Refused final source identity'))
  assert.deepEqual(job.partialOutputs, [])
  job.processing.acknowledge()
  await until(() => admission.snapshot().active === 0)
})

test('a frame job starts its 30 s render limit when the worker is given the frame, not before', async t => {
  const calls = []
  const { f, events, admission } = fixture(t, { frameJobDeadline: (fail, options) => { const real = frameJobDeadline(fail, options); return { dispatched() { calls.push('dispatched'); real.dispatched() }, clear() { calls.push('clear'); real.clear() } } } })
  const frame = f.renderFrame(0.5, 320); frame.catch(() => {})
  assert.deepEqual(calls, [], 'the limit is not running while the sources are copied')
  await until(() => events.some(e => e.type === 'render'))
  assert.deepEqual(calls, ['dispatched'])
  const job = [...f.jobs.values()][0]
  assert.equal(job.kind, 'frame'); assert.equal(job.waiting, undefined)
  f.failJob(job, 'stopped by the test'); await assert.rejects(frame, /stopped by the test/)
  assert.deepEqual(calls, ['dispatched', 'clear'])
  job.processing.acknowledge(); await until(() => admission.snapshot().active === 0)
})

test('a frame whose worker goes away is rendered once more, and a second loss says the renderer restarted', async t => {
  const { f, events, admission } = fixture(t)
  const renders = () => events.filter(e => e.type === 'render')
  // What the worker host does when the worker process exits under a dispatched job.
  const lose = job => { job.workerLost = true; f.failJob(job, 'The render worker exited'); job.processing.acknowledge() }
  const frame = f.renderFrame(0.5, 320)
  await until(() => renders().length === 1)
  const first = [...f.jobs.values()].at(-1)
  lose(first)
  await until(() => renders().length === 2)
  const second = [...f.jobs.values()].at(-1)
  assert.notEqual(second.id, first.id); assert.equal(second.kind, 'frame'); assert.equal(second.spec.at, first.spec.at); assert.equal(second.spec.width, first.spec.width)
  second.state = 'done'; second.resolve({ file: 'frame.png', id: second.id }); second.processing.acknowledge()
  assert.deepEqual(await frame, { file: 'frame.png', id: second.id }, 'the caller gets the frame and never sees the first failure')
  await until(() => admission.snapshot().active === 0)

  // The worker goes away twice: no third try, and the text says that asking again works.
  const count = renders().length, twice = f.renderFrame(0.5, 320); twice.catch(() => {})
  await until(() => renders().length === count + 1); lose([...f.jobs.values()].at(-1))
  await until(() => renders().length === count + 2); lose([...f.jobs.values()].at(-1))
  await assert.rejects(twice, { message: 'The preview renderer restarted. Try again.' })
  await until(() => admission.snapshot().active === 0)
  assert.equal(renders().length, count + 2)

  // Any other failure is reported as it is, without a retry.
  const other = f.renderFrame(0.5, 320); other.catch(() => {})
  await until(() => renders().length === count + 3)
  const plain = [...f.jobs.values()].at(-1); f.failJob(plain, 'The render worker did not finish this frame in 30 s. Try again.'); plain.processing.acknowledge()
  await assert.rejects(other, /did not finish this frame in 30 s/)
  await until(() => admission.snapshot().active === 0)
  assert.equal(renders().length, count + 3)

  // An assistant frame that has used its wait is not started again.
  const late = f.renderFrame(0.5, 320, null, { queueMs: 900 }); late.catch(() => {})
  await until(() => renders().length === count + 4); lose([...f.jobs.values()].at(-1))
  await assert.rejects(late, { message: 'The preview renderer restarted. Try again.' })
  await until(() => admission.snapshot().active === 0)
  assert.equal(renders().length, count + 4)
})

test('a frame of an assistant preview draws the previewed project, with its media copied, and saves nothing', async t => {
  const { ROOT, project, f, events, admission } = fixture(t)
  const saved = structuredClone(project), file = fs.readdirSync(ROOT).sort()
  // What a preview would make: the saved project with a title over it.
  const preview = structuredClone(project)
  preview.tracks.push({ id: 'V9', kind: 'video', name: 'Preview titles', clips: [{ id: 'p1', kind: 'title', start: 0, dur: 1, title: { text: 'PREVIEWED' } }] })
  const frame = f.renderFrame(0.5, 320, null, { preview }); frame.catch(() => {})
  await until(() => events.some(e => e.type === 'render'))
  const sent = events.find(e => e.type === 'render').data
  assert.equal(sent.job.kind, 'frame'); assert.equal(sent.job.preview, true)
  assert.deepEqual(sent.project.tracks.at(-1).clips.map(clip => clip.title?.text), ['PREVIEWED'], 'the worker is given the previewed project')
  // The media is the copy made for this job, as for any frame, not the project file.
  assert.notEqual(sent.project.tracks[0].clips[0].src, project.tracks[0].clips[0].src); assert.ok(fs.existsSync(path.join(ROOT, sent.project.tracks[0].clips[0].src)))
  assert.deepEqual(project, saved, 'the open project is not changed')
  assert.deepEqual(fs.readdirSync(ROOT).sort(), file, 'nothing is added beside the project')
  const job = [...f.jobs.values()].at(-1); f.failJob(job, 'stopped by the test'); job.processing.acknowledge()
  await assert.rejects(frame, /stopped by the test/)
  await until(() => admission.snapshot().active === 0)
  // Without a preview the same call draws the saved project.
  const plain = f.renderFrame(0.5, 320); plain.catch(() => {})
  await until(() => events.filter(e => e.type === 'render').length === 2)
  const second = events.filter(e => e.type === 'render')[1].data
  assert.equal(second.project.tracks.some(track => track.id === 'V9'), false); assert.equal(second.job.preview, undefined)
  const last = [...f.jobs.values()].at(-1); f.failJob(last, 'stopped by the test'); last.processing.acknowledge()
  await until(() => admission.snapshot().active === 0)
})

test('the digests of an export\'s source copies are dropped when the job has left the queue', async t => {
  const { ROOT, f, events, admission, exportCopyDigests } = fixture(t)
  const job = await f.startExport({ name: 'digest-result' })
  await until(() => events.some(e => e.type === 'render'))
  const copy = path.join(ROOT, events.find(e => e.type === 'render').data.project.tracks[0].clips[0].src)
  assert.deepEqual([...exportCopyDigests.keys()], [copy]); assert.match(exportCopyDigests.get(copy), /^[a-f0-9]{64}$/)
  f.failJob(job, 'stopped by the test')
  job.processing.acknowledge(); await until(() => admission.snapshot().active === 0)
  await until(() => job.exportCopies === undefined)
  assert.equal(exportCopyDigests.size, 0, 'nothing is left for a finished job')
})

test('actual interchange route writes a new file and refuses repeated basename/source references', async t => {
  const { ROOT, project } = fixture(t), routes = interchangeRoutes({ ROOT, getProject: () => project, assertCurrent: () => {}, pushActivity: () => {} }).routes
  const route = routes['POST /api/interchange/export']
  const first = await route({ format: 'otio', name: 'timeline' }); const before = fs.readFileSync(path.join(ROOT, first.path))
  await assert.rejects(route({ format: 'otio', name: 'timeline' }), /already exists/)
  assert.deepEqual(fs.readFileSync(path.join(ROOT, first.path)), before)
  project.assets['renders/source-reference.otio'] = {}
  await assert.rejects(route({ format: 'otio', name: 'source-reference' }), /source media/)
  assert.equal(fs.existsSync(path.join(ROOT, 'renders/source-reference.otio')), false)
})

for (const key of ['src', 'proxy', 'lut']) test(`actual interchange route protects a missing nested ${key} reference outside assets`, async t => {
  const { ROOT, project } = fixture(t)
  const source = `renders/missing-${key}.otio`
  project.comps = { nested: { tracks: [{ clips: [{ kind: 'image', src: 'media/source.mp4', node: { [key]: source } }] }] } }
  const route = interchangeRoutes({ ROOT, getProject: () => project, assertCurrent: () => {}, pushActivity: () => {} }).routes['POST /api/interchange/export']
  await assert.rejects(route({ format: 'otio', name: `missing-${key}` }), /source media/)
  assert.equal(fs.existsSync(path.join(ROOT, source)), false)
})

test('browser receipt writes preserve native accepted identities and browser cohort metadata', t => {
  const { ROOT } = fixture(t), history = new DeliveryHistory(ROOT)
  fs.mkdirSync(path.join(ROOT, 'renders'))
  for (const name of ['native-first.mp4', 'browser-second.mp4', 'browser-third.mp4']) fs.writeFileSync(path.join(ROOT, 'renders', name), 'synthetic completed bytes')
  const accepted = { acceptedVersion: 7, acceptedGeneration: 'A0123456-1234-5678-9ABC-0123456789AB', acceptedProjectSHA256: 'a'.repeat(64), sourceCohortID: 'b'.repeat(64) }
  fs.writeFileSync(path.join(ROOT, '.reel/deliveries.json'), JSON.stringify({ version: 1, entries: [{ output: 'renders/native-first.mp4', finished: 1, preset: 'hevc', ...accepted }] }))
  const sourceCohort = { id: '01234567-1234-5678-9abc-0123456789ab', projectSHA256: 'c'.repeat(64), sourcesSHA256: 'd'.repeat(64), count: 1 }
  history.record('renders/browser-second.mp4', { preset: 'h264-high', sourceCohort }, 2)
  history.record('renders/browser-third.mp4', {}, 3)
  const entries = history.read()
  for (const [key, value] of Object.entries(accepted)) assert.equal(entries[0][key], value)
  assert.deepEqual(entries[1].sourceCohort, sourceCohort)
  const listed = history.list().deliveries.find(value => value.output === entries[0].output)
  assert.equal(listed.sourceCohortID, accepted.sourceCohortID)
  const before = fs.readFileSync(path.join(ROOT, '.reel/deliveries.json'))
  assert.throws(() => history.record('renders/browser-third.mp4', { sourceCohort: { ...sourceCohort, id: '-'.repeat(36) } }), /cohort receipt/)
  assert.deepEqual(fs.readFileSync(path.join(ROOT, '.reel/deliveries.json')), before)
})

test('an export name that is taken gets the next free number instead of failing', async t => {
  const { ROOT, f } = fixture(t)
  fs.mkdirSync(path.join(ROOT, 'renders'))
  fs.writeFileSync(path.join(ROOT, 'renders', 'cut.mp4'), 'an earlier export')
  fs.writeFileSync(path.join(ROOT, 'renders', 'cut-2.mp4'), 'another earlier export')
  const job = await f.startExport({ name: 'cut' })
  assert.equal(path.basename(job.spec.out), 'cut-3.mp4')
  assert.equal(fs.readFileSync(path.join(ROOT, 'renders', 'cut.mp4'), 'utf8'), 'an earlier export')
  // Two queued exports with one default name get different files before either has rendered.
  const first = await f.startExport({ name: 'queued' }), second = await f.startExport({ name: 'queued' })
  assert.deepEqual([path.basename(first.spec.out), path.basename(second.spec.out)], ['queued.mp4', 'queued-2.mp4'])
  const fresh = await f.startExport({ name: 'fresh', preset: 'png-seq' })
  assert.equal(path.relative(ROOT, fresh.spec.out), path.join('renders', 'fresh-frames', 'frame_%05d.png'))
})

// Seen on 2026-11-17: asked "How loud is it?", the assistant exported the mix to
// renders/check-loudness.wav to measure it, and the file stayed in the project.
const SUMMARY = '[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -16.4 LUFS\n    Threshold: -26.4 LUFS\n\n  Loudness range:\n    LRA:         3.2 LU\n\n  True peak:\n    Peak:       -1.7 dBFS\n'
// Every file and folder under the project and what each file holds. The one thing left out is
// .reel/export-cohorts, the folder Arya keeps for the media copies of every frame and export; it
// is checked to be empty.
function everyFile(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1).flatMap(entry => {
    const name = path.join(relative, entry.name)
    if (name === path.join('.reel', 'export-cohorts')) { assert.deepEqual(fs.readdirSync(path.join(root, name)), [], 'no media copy is left'); return [] }
    return entry.isDirectory() ? [`${name}/`, ...everyFile(root, name)] : [`${name} ${fs.readFileSync(path.join(root, name)).toString('hex')}`]
  })
}
// What the worker does for a mix measurement: upload the mix, then say start.
async function measuring(f, events, body) {
  const job = await f.startMixMeasure(body)
  await until(() => events.some(e => e.type === 'render' && e.data.job.id === job.id))
  fs.writeFileSync(job.audioFile, 'synthetic mix'); job.audioUploaded = true; job.state = 'running'
  return job
}

test('measuring the mix returns its loudness in the job and leaves the project folder as it was', async t => {
  const { ROOT, f, events, encoders, admission } = fixture(t)
  const before = everyFile(ROOT)
  const job = await measuring(f, events)
  const payload = events.find(e => e.type === 'render').data.job
  assert.equal(payload.kind, 'measure-mix'); assert.equal(payload.spec.preset, 'audio-wav', 'the worker mixes it as it mixes an audio export')
  assert.deepEqual(payload.spec.range, { in: 0, out: 1 }); assert.equal('out' in payload.spec, false, 'no output path')
  const finished = f.finishMixMeasure(job)
  assert.equal(encoders.length, 1)
  assert.deepEqual(encoders[0].argv, ['-nostdin', '-i', job.audioFile, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'])
  encoders[0].stderr.emit('data', SUMMARY); encoders[0].emit('close', 0)
  await finished
  assert.equal(job.state, 'done')
  assert.deepEqual(job.result, { lufs: -16.4, lra: 3.2, truePeak: -1.7, from: 0, to: 1, dur: 1 })
  assert.deepEqual(f.jobPublic(job).result, job.result); assert.equal(job.output, undefined)
  assert.equal(fs.existsSync(job.audioFile), false, 'the mix is removed as soon as it has been measured')
  job.processing.acknowledge(); await until(() => admission.snapshot().active === 0)
  assert.deepEqual(everyFile(ROOT), before, 'no file is added, changed or left behind')
  assert.equal(fs.existsSync(path.join(ROOT, 'renders')), false)
  assert.deepEqual(new DeliveryHistory(ROOT).read(), [], 'a measurement is not a delivery')
})

test('a mix measurement takes a part of the timeline, and refuses a part with nothing in it', async t => {
  const { f, events, admission } = fixture(t, { duration: () => 12 })
  const job = await measuring(f, events, { from: 2.5, to: 40 })
  assert.deepEqual(job.spec.range, { in: 2.5, out: 12 }, 'to is cut at the end of the timeline')
  f.failJob(job, 'cancelled'); job.processing.acknowledge(); await until(() => admission.snapshot().active === 0)
  await assert.rejects(f.startMixMeasure({ from: 12 }), /Nothing to measure from 12 s to 12 s: the timeline is 12 s long/)
  await assert.rejects(f.startMixMeasure({ from: -1 }), /from must be a time on the timeline in seconds/)
  await assert.rejects(f.startMixMeasure({ to: '3' }), /to must be a time on the timeline in seconds/)
  await assert.rejects(f.startMixMeasure({ comp: 'none' }), /no such composition/)
  const empty = fixture(t, { duration: () => 0 })
  await assert.rejects(empty.f.startMixMeasure(), /There is nothing on the timeline to measure\./)
  assert.equal(f.jobs.size, 1, 'a refused measurement queues no job')
})

test('with no from and no to, a mix measurement covers the export range', async t => {
  const { f, events, project, admission } = fixture(t, { duration: () => 12 })
  project.range = { in: 3, out: 9 }
  const job = await measuring(f, events)
  assert.deepEqual(job.spec.range, { in: 3, out: 9 })
  f.failJob(job, 'cancelled'); job.processing.acknowledge(); await until(() => admission.snapshot().active === 0)
  const whole = await measuring(f, events, { from: 0 })
  assert.deepEqual(whole.spec.range, { in: 0, out: 12 }, 'a given from measures to the end of the timeline')
  f.failJob(whole, 'cancelled'); whole.processing.acknowledge(); await until(() => admission.snapshot().active === 0)
})

test('a mix measurement that fails or is cancelled also leaves the project folder as it was', async t => {
  const { ROOT, f, events, encoders, admission } = fixture(t)
  const before = everyFile(ROOT)
  // ffmpeg fails.
  const failed = await measuring(f, events)
  const refused = f.finishMixMeasure(failed)
  encoders[0].stderr.emit('data', 'Invalid data found when processing input'); encoders[0].emit('close', 1)
  await assert.rejects(refused, /ffmpeg: Invalid data found/)
  f.failJob(failed, 'ffmpeg: Invalid data found'); failed.processing.acknowledge(); await until(() => admission.snapshot().active === 0)
  assert.equal(failed.state, 'failed'); assert.equal(failed.result, undefined)
  assert.deepEqual(everyFile(ROOT), before)
  // Cancelled while ffmpeg measures: the process is stopped and the mix removed.
  const cancelled = await measuring(f, events)
  const stopped = f.finishMixMeasure(cancelled)
  f.failJob(cancelled, 'cancelled')
  assert.deepEqual(encoders[1].kills, ['SIGTERM'])
  encoders[1].emit('close', null)
  await stopped
  assert.equal(cancelled.state, 'failed'); assert.equal(cancelled.result, undefined)
  cancelled.processing.acknowledge(); await until(() => admission.snapshot().active === 0)
  assert.deepEqual(everyFile(ROOT), before)
  // Cancelled before the worker has it, with the mix never uploaded.
  const early = await f.startMixMeasure()
  f.failJob(early, 'cancelled'); await until(() => admission.snapshot().active === 0)
  assert.deepEqual(everyFile(ROOT), before)
  // The project changes while it is measured: no numbers for a mix that is no longer the project's.
  const stale = await measuring(f, events)
  f.changeProject()
  await assert.rejects(f.finishMixMeasure(stale), /changed/)
  f.failJob(stale, 'The project changed'); stale.processing.acknowledge(); await until(() => admission.snapshot().active === 0)
  assert.deepEqual(everyFile(ROOT), before)
})
