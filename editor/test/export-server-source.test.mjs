import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createProcessingAdmission } from '../core/processing-admission.mjs'
import { reserveProcessingWorker } from '../core/processing-worker.mjs'
import { validateExportSpec } from '../core/processing-export.js'
import { captureExportSources, prepareExportCohort, createExportDestination } from '../core/export-cohort.mjs'
import { guardedOutput } from '../core/output-path.js'
import interchangeRoutes from '../routes/interchange.mjs'
import { DeliveryHistory } from '../core/delivery-history.js'

const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
const exportSource = source.slice(source.indexOf('const PRESETS ='), source.indexOf('// ---------------------------------------------------------------- routes'))
const turn = () => new Promise(resolve => setImmediate(resolve))
// Time-bounded, not turn-bounded: file work takes more event-loop turns on a loaded machine.
async function until(predicate) { const deadline = Date.now() + 10000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Source fixture did not settle'); await turn() } }

function fixture(t) {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-export-server-source-'))
  t.after(() => fs.rmSync(ROOT, { recursive: true, force: true }))
  const DOT = path.join(ROOT, '.reel'); fs.mkdirSync(DOT)
  fs.mkdirSync(path.join(ROOT, 'media')); fs.writeFileSync(path.join(ROOT, 'media/source.mp4'), 'accepted source bytes')
  const project = { name: 'Source fixture', width: 320, height: 180, fps: 30, assets: { 'media/source.mp4': {} }, tracks: [{ clips: [{ kind: 'video', src: 'media/source.mp4', start: 0, dur: 1 }] }] }
  const events = [], encoders = [], admission = createProcessingAdmission()
  const values = { ROOT, DOT, fs, path, createProcessingAdmission, reserveProcessingWorker, validateExportSpec, captureExportSources, prepareExportCohort, createExportDestination, guardedOutput, initialProject: project, processing: admission,
    armProcessingWorkerCancellation: () => () => {}, ensureWorker: async () => {}, touchWorker: () => {}, assistantCalls: { getStore: () => null },
    duration: () => 1, compView: (p, name) => p.comps?.[name], pushActivity: () => {}, deliveries: new DeliveryHistory(ROOT),
    broadcast: (type, data) => events.push({ type, data }), spawn: (_cmd, args) => {
      const ff = new EventEmitter(); ff.stderr = new EventEmitter(); ff.stdin = new EventEmitter(); ff.stdin.end = () => {}; ff.kills = []; ff.kill = signal => ff.kills.push(signal); ff.argv = args; encoders.push(ff); return ff
    } }
  const f = new Function(...Object.keys(values), `let project = initialProject, version = 1; const jobs = new Map(), worker = {}; function captureProcessing() { const initial = project, revision = version; return { assertCurrent() { if (project !== initial || version !== revision) throw new Error('The project changed') } } }\n${exportSource}\nreturn { startExport, startEncoder, finishExport, failJob, jobPublic, jobs, changeProject() { project = {...project}; version++ } }`)(...Object.values(values))
  return { ROOT, project, f, events, encoders, admission }
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
