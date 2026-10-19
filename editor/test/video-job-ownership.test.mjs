import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const sourceRoot = path.resolve(process.env.REEL_VIDEO_JOB_FIXTURE_ROOT ?? path.join(import.meta.dirname, '../..'))
const read = file => fs.readFileSync(path.join(sourceRoot, file), 'utf8')
const protocol = await import(pathToFileURL(path.join(sourceRoot, 'editor/agent/protocol.mjs')))
const outcomes = await import(pathToFileURL(path.join(sourceRoot, 'editor/agent/tool-outcomes.mjs')))
const { applyOps, newProject } = await import(pathToFileURL(path.join(sourceRoot, 'editor/core/project.js')))
const { captureProcessingProject, currentProcessingProject, processedVideoAsset, admitProcessedOutput } = await import(pathToFileURL(path.join(sourceRoot, 'editor/processing-output-admission.mjs')))
const service = read('editor/agent/browser-assistant.mjs'), server = read('editor/server.mjs'), video = read('editor/routes/video-processing.mjs')
const failure = message => new Error(message)
const between = (source, start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first)
  assert.ok(first >= 0 && last > first, 'The actual source extraction markers must exist')
  return source.slice(first, last)
}
const registerSource = between(service, '  const registerJob =', '  const cancelJobs =')
const cancelSource = between(service, '  const cancelJobs =', '  const loadProviders =')
const toolSource = between(service, '  const tool =', '  const drive =')
const driveSource = between(service, '  const drive =', '  const send =')
const broadcastSource = between(server, '  broadcast: (event, data, role) => {', '  pushActivity, cacheKey, once, log,')
const callbackSource = between(server, '  cancelJob: job =>', '  onState: next =>')
const evaluate = (source, bindings, ending) => new Function(...Object.keys(bindings), source + '\n' + ending)(...Object.values(bindings))
const denied = () => { throw new Error('No real command, worker, filesystem, or network operation is allowed') }

function runContext() {
  const run = { id: 'run1', identity: 1, sharingGeneration: 1, initialVersion: 7, jobs: new Map(), outcomes: outcomes.createToolOutcomes(), cancelled: false, terminal: false }
  const assertRun = value => { assert.equal(value, run); if (value.cancelled || value.terminal) throw failure('This assistant run is no longer active.') }
  // Keep the captured run in the same lexical closure as the actual registration function.
  const register = evaluate(registerSource, { assertRun, identifier: protocol.identifier, failure, fixtureRun: run }, 'return job => registerJob(fixtureRun, job)')
  return { run, assertRun, register }
}
function serverCallbacks(routes, core = new Map()) {
  return evaluate('return ({' + callbackSource + '})', { routes, jobs: core }, '')
}
function videoFixture({ mode = 'hold', register, rejectPublication = false, rejectApply = false, rejectImport = false } = {}) {
  const broadcasts = [], operations = [], virtualFiles = new Map(), editBodies = []
  const source = 'media/input.mp4', clip = { id: 'c1', kind: 'video', src: source, start: 0, dur: 2 }
  let project = newProject('Video ownership fixture', { width: 100, height: 100, fps: 30 })
  project.tracks[0].clips = [clip]
  project.assets[source] = { hasVideo: true, duration: 2, width: 100, height: 100, fps: 30 }
  let release, renderCalls = 0, currentVersion = 7, probeCalls = 0, edits = 0
  const generation = 1
  let startedResolve
  const started = new Promise(resolve => startedResolve = resolve)
  const vfs = { statSync: () => ({ isFile: () => true, dev: 1n, ino: 2n, size: 100n, mtimeNs: 3n, ctimeNs: 4n }),
    realpathSync: value => value, mkdirSync: file => operations.push(['mkdir', file]),
    renameSync: (from, to) => { operations.push(['rename', from, to]); virtualFiles.set(to, virtualFiles.get(from)); virtualFiles.delete(from) },
    rmSync: file => { operations.push(['remove', file]); virtualFiles.delete(file) } }
  const broadcast = evaluate('return (' + broadcastSource.replace(/^  broadcast: /, '').trim().replace(/,$/, '') + ')',
    { jobs: new Map(), assistantCalls: { getStore: () => ({ registerJob: register ?? (() => { if (rejectPublication) throw failure('Registration rejected') }) }) },
      broadcast: (_event, value) => broadcasts.push(structuredClone(value)) }, '')
  const ctx = { ROOT: 'virtual-project', getProject: () => project, getVersion: () => currentVersion, getProjectGeneration: () => generation, resolveMedia: value => value, broadcast,
    run: async command => command === 'ffmpeg' ? { stdout: 'hqdn3d' } : command === 'ffprobe' ? { stdout: JSON.stringify({ streams: [{ codec_type: 'video', pix_fmt: 'yuv420p', index: 0 }], format: { duration: 2 } }) } : denied(),
    assertCurrent: () => {}, checkAgentFile: () => {},
    videoRender: async (argv, signal, progress) => {
      renderCalls++; virtualFiles.set(argv.at(-1), 'fixture output bytes'); startedResolve()
      if (mode === 'hold') await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }) })
      if (signal.aborted) throw failure('Processing cancelled.')
      if (mode === 'fail') throw failure('Injected worker failed.')
      progress(1)
    },
    probe: async () => { probeCalls++; return { hasVideo: true, duration: 2, width: 100, height: 100 } },
    callAPI: async (method, route, body) => {
      assert.equal(method, 'POST'); assert.equal(route, '/api/ops'); assert.equal(body.expectedVersion, currentVersion)
      assert.equal(body.ops.length, 1); assert.ok(['import', 'update'].includes(body.ops[0].op))
      if (rejectImport && body.ops[0].op === 'import') throw failure('Injected Media admission failed.')
      if (rejectApply && body.ops[0].op === 'update') throw failure('Injected placement failed.')
      project = applyOps(project, body.ops).project
      editBodies.push(structuredClone(body)); edits++
      return { version: ++currentVersion }
    } }
  const factory = evaluate(video.replace(/^import .*$/gm, '').replace(/^export /gm, '').replace('default function', 'function'),
    { fs: vfs, path, randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', spawn: denied, guardedOutput: (_root, value) => value,
      captureProcessingProject, currentProcessingProject, processedVideoAsset, admitProcessedOutput }, 'return videoProcessing')
  const routes = factory(ctx).routes
  const body = { comp: null, expectedVersion: 7, id: 'c1', src: source, in: 0, dur: 2 }
  const id = 'vaaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa'
  return { routes, body, id, broadcasts, operations, virtualFiles, editBodies, started, finish: () => release?.(),
    drift: () => { project = applyOps(project, [{ op: 'project', set: { name: 'Ordinary edit during processing' } }]).project; currentVersion++ },
    project: () => project,
    facts: () => ({ renderCalls, probeCalls, edits, currentVersion, generation,
      imports: editBodies.filter(body => body.ops[0].op === 'import').length, placements: editBodies.filter(body => body.ops[0].op === 'update').length }) }
}
const start = fixture => fixture.routes['POST /api/video/denoise'](fixture.body)
const wait = (fixture, timeout = 0) => fixture.routes['GET /api/video/jobs/wait']({}, new URLSearchParams({ id: fixture.id, timeout: String(timeout) }))
function actualTool(fixture, dispatch) {
  return evaluate(toolSource, { assertRun: fixture.assertRun, validateCall: protocol.validateCall, image: denied,
    checkFiles: () => {}, confinedFile: denied, root: 'virtual-project', options: { dispatch }, registerJob: (_run, job) => fixture.register(job),
    recordToolOutcome: outcomes.recordToolOutcome, bounded: value => value, failure }, 'return tool')
}
function actualCancel(run, callbacks) {
  return evaluate(cancelSource, { options: callbacks, failure }, 'return cancelJobs')(run)
}

test('protocol admits exactly the video job family and supplies matching polling guidance', () => {
  for (const route of ['/api/video/jobs', '/api/video/jobs/wait?id=owned&timeout=0']) assert.equal(protocol.validateCall('reel_api', { method: 'GET', path: route }).path, route)
  assert.equal(protocol.validateCall('reel_api', { method: 'POST', path: '/api/video/jobs/cancel', body: { id: 'owned' } }).path, '/api/video/jobs/cancel')
  assert.match(protocol.INSTRUCTIONS, /video\/jobs\/cancel uses GET \/api\/video\/jobs\/wait/)
  for (const route of ['/api/jobs/wait?id=x', '/api/analysis/jobs/wait?id=x']) assert.equal(protocol.validateCall('reel_api', { method: 'GET', path: route }).path, route)
  for (const route of ['/api/jobs/cancel', '/api/analysis/jobs/cancel']) assert.equal(protocol.validateCall('reel_api', { method: 'POST', path: route, body: { id: 'x' } }).path, route)
  for (const route of ['/api/assistant/config', '/api/video/jobs/start']) assert.throws(() => protocol.validateCall('reel_api', { method: 'POST', path: route, body: {} }), /unavailable/)
})

test('actual server broadcast registers the video job before its injected worker starts', async () => {
  const context = runContext(), fixture = videoFixture({ register: context.register })
  const job = await start(fixture)
  assert.equal(job.id, fixture.id); assert.equal(job.state, 'running')
  assert.equal(context.run.jobs.get('/api/video/jobs/cancel:' + job.id).id, job.id)
  assert.equal(fixture.facts().renderCalls, 1); assert.equal(fixture.broadcasts[0].cancelPath, '/api/video/jobs/cancel')
  assert.equal((await wait(fixture)).state, 'running')
  await fixture.routes['POST /api/video/jobs/cancel']({ id: job.id }); await wait(fixture, 100)
})

test('initial registration rejection rolls back the job without starting a worker', async () => {
  const fixture = videoFixture({ rejectPublication: true })
  await assert.rejects(start(fixture), /Registration rejected/)
  await assert.rejects(wait(fixture), /unavailable/)
  assert.deepEqual(fixture.routes['GET /api/video/jobs'](), { jobs: [] })
  assert.equal(fixture.facts().renderCalls, 0); assert.deepEqual(fixture.operations, [])
})

test('late Stop and ownership capacity rejection cannot leave an unowned video job', async () => {
  for (const reason of ['stopped', 'capacity']) {
    const context = runContext()
    if (reason === 'stopped') context.run.cancelled = true
    else for (let n = 0; n < 128; n++) context.run.jobs.set('/api/jobs/cancel:j' + n, { id: 'j' + n, path: '/api/jobs/cancel' })
    const fixture = videoFixture({ register: context.register })
    await assert.rejects(start(fixture), reason === 'stopped' ? /no longer active/ : /too many/)
    await assert.rejects(wait(fixture), /unavailable/)
    assert.equal(fixture.facts().renderCalls, 0)
  }
})

test('video wait reports running then done with a public snapshot that excludes worker internals', async () => {
  const context = runContext(), fixture = videoFixture({ register: context.register })
  await start(fixture); await fixture.started
  const running = await wait(fixture)
  assert.equal(running.state, 'running'); assert.equal('promise' in running, false); assert.equal('abort' in running, false)
  fixture.finish()
  const done = await wait(fixture, 100)
  assert.equal(done.state, 'done'); assert.equal(done.applied, true); assert.equal(fixture.facts().edits, 2)
  assert.equal(fixture.facts().imports, 1); assert.equal(fixture.facts().placements, 1); assert.equal(fixture.facts().generation, 1)
  assert.deepEqual(fixture.editBodies.map(body => body.ops[0].op), ['import', 'update'])
  assert.deepEqual(fixture.editBodies.map(body => body.expectedVersion), [7, 8])
  assert.equal(fixture.editBodies[1].ops[0].comp, null); assert.equal(fixture.editBodies[1].ops[0].id, 'c1')
  assert.equal(done.assetRegistered, true); assert.equal(done.admissionVersion, 8); assert.equal(done.version, 9)
  assert.equal(fixture.project().tracks[0].clips[0].src, done.output)
  assert.deepEqual(fixture.project().assets[done.output].processing, {
    version: 1, kind: 'video-denoise', source: 'media/input.mp4', range: { in: 0, dur: 2 }, output: done.output,
    engine: 'ffmpeg-hqdn3d', compute: 'cpu', settings: { quality: 'balanced', strength: 0.65, spatial: 0.5, temporal: 0.8, detail: 0.7, sigma: 0.06, codec: 'h264' }
  })
  const listed = fixture.routes['GET /api/video/jobs']().jobs[0]
  assert.deepEqual(listed, done); assert.equal('promise' in listed, false); assert.equal('abort' in listed, false)
  assert.equal(serverCallbacks(fixture.routes).jobState({ id: fixture.id, path: '/api/video/jobs/cancel' }), 'done')
})

test('actual owned cancellation aborts only its video worker and wait retains cancelled truth', async () => {
  const context = runContext(), fixture = videoFixture({ register: context.register })
  await start(fixture); await fixture.started
  const callbacks = serverCallbacks(fixture.routes)
  assert.equal(callbacks.jobState({ id: fixture.id, path: '/api/video/jobs/cancel' }), 'running')
  assert.equal(await actualCancel(context.run, callbacks), true)
  assert.equal(context.run.jobs.size, 0)
  const cancelled = await wait(fixture, 100)
  assert.equal(cancelled.state, 'cancelled'); assert.equal(fixture.facts().edits, 0)
  assert.ok(fixture.operations.some(([kind, file]) => kind === 'remove' && file.endsWith('.part.mp4')))
})

test('actual tool guard rejects foreign and cross-family cancellation before dispatch', async () => {
  const context = runContext(); let dispatched = 0
  const tool = actualTool(context, async () => { dispatched++; return { ok: true } })
  context.register({ id: 'owned', path: '/api/video/jobs/cancel' })
  for (const [route, id] of [['/api/video/jobs/cancel', 'foreign'], ['/api/jobs/cancel', 'owned'], ['/api/analysis/jobs/cancel', 'owned']]) {
    await assert.rejects(tool({ method: 'POST', path: route, body: { id } }, context.run), /own run/)
  }
  assert.equal(dispatched, 0)
  await tool({ method: 'POST', path: '/api/video/jobs/cancel', body: { id: 'owned' } }, context.run)
  assert.equal(dispatched, 1)
})

test('core and analysis owned registration, cancellation and string state contracts stay intact', async () => {
  const core = new Map([['core', { state: 'running' }]]), analysis = [{ id: 'analysis', state: 'running' }], calls = []
  const routes = { 'GET /api/analysis/jobs': () => ({ jobs: analysis }), 'GET /api/video/jobs': () => ({ jobs: [] }),
    'POST /api/jobs/cancel': body => { calls.push('core'); core.get(body.id).state = 'cancelled'; return { ok: true } },
    'POST /api/analysis/jobs/cancel': body => { calls.push('analysis'); analysis[0].state = 'cancelled'; return { ok: true } } }
  const context = runContext(), callbacks = serverCallbacks(routes, core)
  context.register({ id: 'core', path: '/api/jobs/cancel' }); context.register({ id: 'analysis', path: '/api/analysis/jobs/cancel' })
  assert.equal(callbacks.jobState({ id: 'core', path: '/api/jobs/cancel' }), 'running')
  assert.equal(callbacks.jobState({ id: 'analysis', path: '/api/analysis/jobs/cancel' }), 'running')
  assert.equal(await actualCancel(context.run, callbacks), true)
  assert.deepEqual(calls, ['core', 'analysis']); assert.equal(context.run.jobs.size, 0)
  assert.equal(callbacks.jobState({ id: 'core', path: '/api/jobs/cancel' }), 'cancelled')
  assert.equal(callbacks.jobState({ id: 'analysis', path: '/api/analysis/jobs/cancel' }), 'cancelled')
  assert.throws(() => context.register({ id: 'unknown', path: '/api/other/jobs/cancel' }), /Invalid owned/)
})

test('completed video placement failure retains the exact minimal receipt facts', async () => {
  const context = runContext(), fixture = videoFixture({ mode: 'success', register: context.register, rejectApply: true })
  await start(fixture); const done = await wait(fixture, 100)
  assert.equal(done.state, 'done'); assert.equal(done.applied, false)
  const receipt = serverCallbacks(fixture.routes).jobOutcome({ id: fixture.id, path: '/api/video/jobs/cancel' })
  assert.deepEqual(receipt, { state: 'done', applied: false, applyError: 'Injected placement failed.', assetRegistered: true })
  assert.deepEqual(Object.keys(receipt).sort(), ['applied', 'applyError', 'assetRegistered', 'state'])
  outcomes.recordCompletedJobOutcome(context.run.outcomes, receipt)
  assert.equal(outcomes.unresolvedToolOutcome(context.run.outcomes), 'Generated media is saved in Media, but its requested edit was not applied. Retry placement without regenerating.')
  assert.equal(fixture.facts().edits, 1); assert.equal(fixture.facts().imports, 1); assert.equal(fixture.facts().placements, 0)
  assert.deepEqual(fixture.editBodies.map(body => body.ops[0].op), ['import'])
  assert.equal(fixture.project().assets[done.output].processing.source, 'media/input.mp4')
  assert.equal(fixture.project().tracks[0].clips[0].src, 'media/input.mp4')
  assert.equal(done.assetRegistered, true); assert.equal(done.admissionVersion, 8); assert.equal(done.version, 8)
  assert.equal(fixture.facts().currentVersion, 8); assert.equal(fixture.facts().generation, 1)
  assert.deepEqual(fixture.editBodies.map(body => body.expectedVersion), [7])
  assert.equal(fixture.project().tracks[0].clips.length, 1); assert.equal(Object.keys(fixture.project().assets).length, 2)
  assert.equal(fixture.project().assets[done.output].processing.kind, 'video-denoise')
  assert.deepEqual(fixture.project().assets[done.output].processing.range, { in: 0, dur: 2 })
  assert.equal(fixture.project().assets[done.output].processing.output, done.output)
})

test('completed video Media registration failure cannot claim the output is saved in Media', async () => {
  const context = runContext(), fixture = videoFixture({ mode: 'success', register: context.register, rejectImport: true })
  await start(fixture); const done = await wait(fixture, 100)
  assert.equal(done.state, 'done'); assert.equal(done.applied, false); assert.equal(done.assetRegistered, false)
  assert.equal(done.registrationError, 'Injected Media admission failed.'); assert.equal(done.applyError, done.registrationError)
  assert.equal(done.admissionVersion, undefined); assert.equal(done.version, undefined)
  const receipt = serverCallbacks(fixture.routes).jobOutcome({ id: fixture.id, path: '/api/video/jobs/cancel' })
  assert.deepEqual(receipt, { state: 'done', applied: false, applyError: 'Injected Media admission failed.', assetRegistered: false })
  assert.deepEqual(Object.keys(receipt).sort(), ['applied', 'applyError', 'assetRegistered', 'state'])
  outcomes.recordCompletedJobOutcome(context.run.outcomes, receipt)
  assert.equal(outcomes.unresolvedToolOutcome(context.run.outcomes), 'A processing result was not applied. Review the result before retrying.')
  assert.equal(context.run.outcomes.otherAssetReady, false); assert.equal(context.run.outcomes.unconfirmedCompletedFailure, true)
  assert.deepEqual(fixture.facts(), { renderCalls: 1, probeCalls: 1, edits: 0, currentVersion: 7, generation: 1, imports: 0, placements: 0 })
  assert.deepEqual(fixture.editBodies, []); assert.equal(fixture.project().assets[done.output], undefined)
  assert.deepEqual(Object.keys(fixture.project().assets), ['media/input.mp4'])
  assert.equal(fixture.project().tracks[0].clips.length, 1); assert.equal(fixture.project().tracks[0].clips[0].src, 'media/input.mp4')
  assert.equal(fixture.virtualFiles.get(path.join('virtual-project', done.output)), 'fixture output bytes')
  assert.equal(done.asset.processing.source, 'media/input.mp4'); assert.equal(done.asset.processing.kind, 'video-denoise')
  assert.deepEqual(done.asset.processing.range, { in: 0, dur: 2 }); assert.equal(done.asset.processing.output, done.output)
})

test('failed video worker and project drift report their real terminal states without a fabricated edit', async () => {
  for (const kind of ['worker', 'drift']) {
    const context = runContext(), fixture = videoFixture({ mode: kind === 'worker' ? 'fail' : 'hold', register: context.register })
    await start(fixture)
    if (kind === 'drift') { fixture.drift(); fixture.finish() }
    const result = await wait(fixture, 100)
    assert.equal(result.state, kind === 'worker' ? 'failed' : 'done')
    if (kind === 'drift') {
      assert.equal(result.applied, false); assert.match(result.applyError, /changed/); assert.equal(result.assetRegistered, true)
      assert.equal(fixture.project().assets[result.output].processing.source, 'media/input.mp4')
      assert.equal(fixture.project().tracks[0].clips[0].src, 'media/input.mp4')
      assert.deepEqual(fixture.editBodies.map(body => body.ops[0].op), ['import'])
      assert.equal(fixture.editBodies[0].expectedVersion, 8)
    }
    assert.equal(fixture.facts().edits, kind === 'drift' ? 1 : 0)
    assert.equal(fixture.facts().imports, kind === 'drift' ? 1 : 0); assert.equal(fixture.facts().placements, 0)
    assert.equal(serverCallbacks(fixture.routes).jobState({ id: fixture.id, path: '/api/video/jobs/cancel' }), result.state)
  }
})

test('done, failed and cancelled jobs are skipped during Stop while cancellation errors remain unconfirmed', async () => {
  for (const state of ['done', 'failed', 'cancelled']) {
    const context = runContext(); context.register({ id: 'video', path: '/api/video/jobs/cancel' })
    assert.equal(await actualCancel(context.run, { jobState: () => state, cancelJob: denied }), true)
    assert.equal(context.run.jobs.size, 0)
  }
  const context = runContext(); context.register({ id: 'video', path: '/api/video/jobs/cancel' })
  assert.equal(await actualCancel(context.run, { jobState: () => 'running', cancelJob: async () => { throw failure('Injected cancellation failed') } }), false)
  assert.equal(context.run.stopUnconfirmed, true); assert.equal(context.run.jobs.size, 1)
})

async function terminalFixture(kind) {
  const context = runContext(), fixture = videoFixture({ mode: kind === 'running' ? 'hold' : kind === 'failed' ? 'fail' : 'success', register: job => context.run.jobs.set(job.path + ':' + job.id, job), rejectApply: kind === 'unapplied', rejectImport: kind === 'unregistered' })
  await start(fixture)
  if (kind !== 'running') await wait(fixture, 100)
  const callbacks = serverCallbacks(fixture.routes), states = [], replies = [], state = {}
  const cancelJobs = run => actualCancel(run, callbacks)
  const bindings = { assertRun: context.assertRun, request: async () => ({ events: [{ seq: 1, type: 'done', text: 'Agent claims completion.' }] }),
    tool: denied, state, publish: next => { Object.assign(state, next); states.push({ ...state }) }, options: { ...callbacks, getOutline: () => ({ version: fixture.facts().currentVersion }), onReply: (...reply) => replies.push(reply) },
    recordCompletedJobOutcome: outcomes.recordCompletedJobOutcome, unresolvedToolOutcome: outcomes.unresolvedToolOutcome,
    redact: value => value, failure, sleep: denied, cancelJobs, cancelRemote: async () => true, closed: false, active: context.run }
  const drive = evaluate(driveSource, bindings, 'return drive')
  await drive({ token: 'fixture-only' }, context.run)
  if (kind === 'running') await wait(fixture, 100)
  return { fixture, states, replies, run: context.run }
}
test('actual terminal driver rejects a done event while video remains running and cancels the owned job', async () => {
  const f = await terminalFixture('running')
  assert.equal(f.states.at(-1).state, 'error'); assert.match(f.states.at(-1).text, /before its processing jobs finished/)
  assert.equal((await wait(f.fixture)).state, 'cancelled'); assert.equal(f.replies[0][1], true)
})
test('actual terminal driver preserves video placement and worker failure feedback', async () => {
  const unapplied = await terminalFixture('unapplied')
  assert.equal(unapplied.states.at(-1).outcome, 'Generated media is saved in Media, but its requested edit was not applied. Retry placement without regenerating.')
  const savedJob = await wait(unapplied.fixture)
  assert.deepEqual(serverCallbacks(unapplied.fixture.routes).jobOutcome({ id: unapplied.fixture.id, path: '/api/video/jobs/cancel' }),
    { state: 'done', applied: false, applyError: 'Injected placement failed.', assetRegistered: true })
  assert.equal(savedJob.admissionVersion, 8); assert.equal(savedJob.version, 8)
  assert.equal(unapplied.fixture.facts().currentVersion, 8); assert.equal(unapplied.fixture.facts().generation, 1)
  assert.equal(unapplied.fixture.facts().imports, 1); assert.equal(unapplied.fixture.facts().placements, 0)
  assert.deepEqual(unapplied.fixture.editBodies.map(body => body.expectedVersion), [7])
  assert.equal(unapplied.fixture.project().assets[savedJob.output].processing.output, savedJob.output)
  assert.equal(unapplied.fixture.project().tracks[0].clips.length, 1); assert.equal(unapplied.fixture.project().tracks[0].clips[0].src, 'media/input.mp4')
  const unregistered = await terminalFixture('unregistered'), missingJob = await wait(unregistered.fixture)
  assert.equal(unregistered.states.at(-1).outcome, 'A processing result was not applied. Review the result before retrying.')
  assert.deepEqual(serverCallbacks(unregistered.fixture.routes).jobOutcome({ id: unregistered.fixture.id, path: '/api/video/jobs/cancel' }),
    { state: 'done', applied: false, applyError: 'Injected Media admission failed.', assetRegistered: false })
  assert.equal(missingJob.registrationError, 'Injected Media admission failed.')
  assert.equal(missingJob.admissionVersion, undefined); assert.equal(missingJob.version, undefined)
  assert.deepEqual(unregistered.fixture.facts(), { renderCalls: 1, probeCalls: 1, edits: 0, currentVersion: 7, generation: 1, imports: 0, placements: 0 })
  assert.deepEqual(unregistered.fixture.editBodies, []); assert.equal(unregistered.fixture.project().assets[missingJob.output], undefined)
  assert.deepEqual(Object.keys(unregistered.fixture.project().assets), ['media/input.mp4'])
  assert.equal(unregistered.fixture.project().tracks[0].clips.length, 1); assert.equal(unregistered.fixture.project().tracks[0].clips[0].src, 'media/input.mp4')
  assert.equal(unregistered.run.outcomes.otherAssetReady, false); assert.equal(unregistered.run.outcomes.unconfirmedCompletedFailure, true)
  outcomes.recordCompletedJobOutcome(unregistered.run.outcomes, serverCallbacks(unapplied.fixture.routes).jobOutcome({ id: unapplied.fixture.id, path: '/api/video/jobs/cancel' }))
  assert.equal(unregistered.run.outcomes.otherAssetReady, true)
  assert.equal(outcomes.unresolvedToolOutcome(unregistered.run.outcomes), 'A processing result was not applied. Review the result before retrying.')
  const failed = await terminalFixture('failed')
  assert.match(failed.states.at(-1).outcome, /1 processing job did not finish/)
  const done = await terminalFixture('done')
  assert.doesNotMatch(done.states.at(-1).outcome, /not applied|did not finish/)
  assert.match(done.states.at(-1).outcome, /project changed during this request/i)
})

test('video state lookup remains a string for every lifecycle state and keeps receipt facts separate', () => {
  for (const state of ['running', 'done', 'failed', 'cancelled']) {
    const videoJob = { id: 'video', state, applied: false, applyError: 'Target changed', assetRegistered: false, output: 'private/output', spec: { src: 'private/source' } }
    const callbacks = serverCallbacks({ 'GET /api/video/jobs': () => ({ jobs: [videoJob] }), 'GET /api/analysis/jobs': () => ({ jobs: [{ id: 'video', state: 'analysis-same-id' }] }) })
    assert.equal(callbacks.jobState({ id: 'video', path: '/api/video/jobs/cancel' }), state)
    assert.deepEqual(callbacks.jobOutcome({ id: 'video', path: '/api/video/jobs/cancel' }), { state, applied: false, applyError: 'Target changed', assetRegistered: false })
    assert.equal(callbacks.jobState({ id: 'video', path: '/api/analysis/jobs/cancel' }), 'analysis-same-id')
  }
})

test('a foreign assistant run cannot cancel an existing video worker owned by another run', async () => {
  const owner = runContext(), foreign = runContext(); foreign.run.id = 'run2'
  const fixture = videoFixture({ register: owner.register })
  await start(fixture); let dispatched = 0
  const dispatch = async call => { dispatched++; return fixture.routes[call.method + ' ' + call.path](call.body) }
  const foreignTool = actualTool(foreign, dispatch)
  await assert.rejects(foreignTool({ method: 'POST', path: '/api/video/jobs/cancel', body: { id: fixture.id } }, foreign.run), /own run/)
  assert.equal(dispatched, 0); assert.equal((await wait(fixture)).state, 'running')
  await actualTool(owner, dispatch)({ method: 'POST', path: '/api/video/jobs/cancel', body: { id: fixture.id } }, owner.run)
  assert.equal(dispatched, 1); assert.equal((await wait(fixture, 100)).state, 'cancelled')
  assert.equal(fixture.facts().edits, 0)
})
