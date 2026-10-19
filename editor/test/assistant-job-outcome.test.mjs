import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const editor = process.env.ARYA_OUTCOME_EDITOR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const helper = await import(pathToFileURL(path.join(editor, 'agent/tool-outcomes.mjs')))
const service = fs.readFileSync(path.join(editor, 'agent/browser-assistant.mjs'), 'utf8')
const server = fs.readFileSync(path.join(editor, 'server.mjs'), 'utf8')
const driveSource = service.slice(service.indexOf('  const drive = async'), service.indexOf('  const send = async'))
assert.ok(driveSource.startsWith('  const drive = async') && driveSource.endsWith('  }\n'))

// Execute the actual polling and completion function. Its requests and job facts
// are injected, so no companion, provider, server or external process starts.
async function complete(receipts, { version = 5, initialVersion = 5, event = 'done', callback = true, outcomes = helper.createToolOutcomes() } = {}) {
  const jobs = new Map(receipts.map((receipt, index) => [`j${index}`, receipt]))
  const run = { id: 'fixture', jobs: new Map([...jobs.keys()].map(id => [id, { id, path: '/api/jobs/cancel' }])), initialVersion, outcomes }
  const states = [], replies = [], calls = [], state = {}
  const options = {
    jobState: job => jobs.get(job.id)?.state,
    ...(callback ? { jobOutcome: job => jobs.get(job.id) } : {}),
    getOutline: () => ({ version }), onReply: (...value) => replies.push(value),
  }
  const injected = { options, assertRun: () => {}, request: async () => ({ events: [{ seq: 1, type: event, text: 'Render finished.' }] }),
    state, publish: next => { Object.assign(state, next); states.push(next) }, redact: text => text, unresolvedToolOutcome: helper.unresolvedToolOutcome,
    recordCompletedJobOutcome: helper.recordCompletedJobOutcome, cancelJobs: async () => calls.push('cancelJobs'),
    cancelRemote: async () => calls.push('cancelRemote'), tool: () => { throw new Error('Unexpected fixture tool') }, names: {},
    sleep: () => { throw new Error('Unexpected fixture wait') }, run }
  const drive = new Function(...Object.keys(injected), `let active = run, closed = false; ${driveSource}\nreturn drive`)(...Object.values(injected))
  await drive({ token: 'fixture-redaction-only' }, run)
  assert.equal(states.length, 1)
  return { ...states[0], replies, calls, outcomes }
}

for (const receipt of [
  { state: 'done', applied: false },
  { state: 'done', applyError: 'The target changed while rendering.' },
]) test(`done ${JSON.stringify(receipt)} reports an unapplied result without inventing Media registration`, async () => {
  const result = await complete([receipt], { version: 6 })
  assert.equal(result.state, 'done')
  assert.equal(result.outcome, 'A processing result was not applied. Review the result before retrying.')
  assert.doesNotMatch(result.outcome, /saved in Media/)
})

test('only an explicit registration receipt supports saved Media recovery wording', async () => {
  const result = await complete([{ state: 'done', applied: false, assetRegistered: true }])
  assert.equal(result.outcome, 'Generated media is saved in Media, but its requested edit was not applied. Retry placement without regenerating.')
})

test('nonboolean registration values do not confirm Media registration', async () => {
  for (const assetRegistered of [undefined, false, 1, 'true', {}]) {
    const result = await complete([{ state: 'done', applied: false, assetRegistered }])
    assert.match(result.outcome, /^A processing result/)
  }
})

test('saved-only and successful done jobs do not invent application failure', async () => {
  for (const receipt of [{ state: 'done' }, { state: 'done', applied: true }, { state: 'done', applied: 0 }, { state: 'done', applied: 6 }, { state: 'done', applyError: '' }, { state: 'done', applyError: '  ' }]) {
    const result = await complete([receipt], { version: 6 })
    assert.equal(result.state, 'done')
    assert.equal(result.outcome, 'The project changed during this request. Review edits in the timeline.')
  }
})

test('no-op completion and hosts without the optional callback retain their prior outcome', async () => {
  for (const callback of [true, false]) {
    assert.equal((await complete([], { callback })).outcome, 'No project edits were applied during this request.')
  }
})

test('failed and cancelled jobs keep their failure count', async () => {
  const result = await complete([{ state: 'failed' }, { state: 'cancelled' }])
  assert.equal(result.outcome, '2 processing jobs did not finish. Review any committed edits.')
})

test('queued and running jobs keep the unfinished error and cancellation path', async () => {
  for (const state of ['queued', 'running']) {
    const result = await complete([{ state, applied: false }])
    assert.equal(result.state, 'error')
    assert.match(result.text, /before its processing jobs finished/)
    assert.deepEqual(result.calls, ['cancelJobs'])
  }
})

test('an unrelated successful job cannot erase the unapplied completion', async () => {
  const result = await complete([{ state: 'done', applied: false }, { state: 'done', applied: true }])
  assert.match(result.outcome, /^A processing result was not applied/)
})

test('a resolved music retry cannot erase a completed processing failure', async () => {
  const outcomes = helper.createToolOutcomes(), source = 'media/generated/music/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/score.wav'
  const asset = { generated: { kind: 'original-music', renderer: 'arya-score-synth/1' } }
  helper.recordToolOutcome(outcomes, { method: 'POST', path: '/api/audio/compose', body: { track: 'A3' } }, { state: 'asset_ready', path: source, asset })
  helper.recordToolOutcome(outcomes, { method: 'POST', path: '/api/audio/compose/place', body: { path: source, track: 'A3' } }, { state: 'complete', path: source, asset })
  assert.equal(helper.unresolvedToolOutcome(outcomes), null)
  const result = await complete([{ state: 'done', applyError: 'Target is no longer present.' }], { outcomes })
  assert.match(result.outcome, /^A processing result was not applied/)
})

test('the actual server projects only terminal facts from owned core and analysis jobs', () => {
  const match = server.match(/  jobOutcome: ([\s\S]*?),\n  onState:/)
  assert.ok(match, 'The server must wire the separate outcome callback.')
  const core = { id: 'core', state: 'done', applied: false, assetRegistered: true, output: 'private-source', ffmpeg: 'private-process' }
  const analysis = { id: 'analysis', state: 'done', applied: 8, applyError: 'Target changed', spec: { src: 'private-source' } }
  const jobs = new Map([['core', core]]), routes = { 'GET /api/analysis/jobs': () => ({ jobs: [analysis] }) }
  const outcome = new Function('jobs', 'routes', `return (${match[1]})`)(jobs, routes)
  assert.deepEqual(outcome({ id: 'core', path: '/api/jobs/cancel' }), { state: 'done', applied: false, applyError: undefined, assetRegistered: true })
  assert.deepEqual(outcome({ id: 'analysis', path: '/api/analysis/jobs/cancel' }), { state: 'done', applied: 8, applyError: 'Target changed', assetRegistered: undefined })
  assert.equal(outcome({ id: 'missing', path: '/api/jobs/cancel' }), undefined)
})

test('jobState retains its string result for cancellation and unfinished checks', () => {
  const match = server.match(/  jobState: (.*),\n/)
  assert.ok(match)
  const jobs = new Map([['one', { state: 'done', applied: false }]])
  const state = new Function('jobs', 'routes', `return (${match[1]})`)(jobs, {})
  assert.equal(state({ id: 'one', path: '/api/jobs/cancel' }), 'done')
})

// Execute the current finish function and render callback with inert dependencies.
// Registration and placement are separate receipts in the current producer.
test('actual completed analysis render with failed application survives into the terminal receipt', async () => {
  const sourceEditor = process.env.ARYA_ASSET_SOURCE_EDITOR ?? editor
  const analysis = fs.readFileSync(path.join(sourceEditor, 'routes/analysis.mjs'), 'utf8')
  const finishStart = analysis.indexOf('  async function finish(job, work) {')
  const finishEnd = analysis.indexOf('\n  }\n', finishStart) + 5
  const marker = 'const work = async () => finish(job, async () => {'
  const markerStart = analysis.indexOf(marker)
  assert.ok(markerStart >= 0)
  const workStart = markerStart + marker.length
  const workEnd = analysis.indexOf('\n    })\n    const options =', workStart)
  assert.ok(finishStart >= 0 && finishEnd > finishStart && workEnd > workStart)
  for (const registered of [true, false]) {
    const job = { state: 'running', kind: 'stabilize', spec: { clip: 'c1' }, placementRequested: true }
    let placements = 0
    const target = { clip: 'c1', src: 'virtual/source.mp4' }
    const bindings = { ctx: { assertCurrent: () => {}, pushActivity: () => {}, probe: async () => ({ src: 'media/stabilized/virtual.mp4' }) }, fs: { existsSync: () => true },
      out: 'virtual-existing-output', rel: 'media/stabilized/virtual.mp4', kind: 'stabilize', spec: job.spec, job,
      abs: 'virtual/source.mp4', sourceFingerprint: 'fixture-fingerprint', processingSourceFingerprint: () => 'fixture-fingerprint',
      src: 'virtual/source.mp4', from: 0, dur: 1, outSeconds: 1, asset: { fps: 30 }, p: { fps: 30 }, capture: {},
      processedVideoAsset: () => ({ src: 'media/stabilized/virtual.mp4' }),
      admitProcessedOutput: async (_ctx, _capture, _rel, asset) => {
        if (!registered) throw new Error('clip c1 changed while rendering')
        return { asset, version: 5, placementCurrent: true }
      },
      currentProcessingProject: () => ({ project: {}, version: 5 }), initialTarget: target, targetIdentity: JSON.stringify(target), renderTarget: () => target,
      applyRender: async () => { placements++; throw new Error('clip c1 changed while rendering') }, publish: () => {} }
    await new Function(...Object.keys(bindings), `${analysis.slice(finishStart, finishEnd)}\nreturn finish(job, async () => {${analysis.slice(workStart, workEnd)}})`)(...Object.values(bindings))
    assert.equal(job.state, 'done'); assert.equal(job.applied, false); assert.equal(job.assetRegistered, registered)
    assert.equal(job.applyError, 'clip c1 changed while rendering')
    assert.equal(placements, registered ? 1 : 0)
    const result = await complete([job])
    if (registered) {
      assert.equal(job.registrationError, undefined)
      assert.equal(result.outcome, 'Generated media is saved in Media, but its requested edit was not applied. Retry placement without regenerating.')
    } else {
      assert.equal(job.registrationError, 'clip c1 changed while rendering')
      assert.equal(result.outcome, 'A processing result was not applied. Review the result before retrying.')
      assert.doesNotMatch(result.outcome, /saved in Media/)
    }
  }
})

test('mixed confirmed and unconfirmed completed failures keep conservative wording in both orders', async () => {
  const saved = { state: 'done', applied: false, assetRegistered: true }
  const unknown = { state: 'done', applied: false, assetRegistered: false, applyError: 'The target changed.' }
  for (const receipts of [[saved, unknown], [unknown, saved]]) {
    const result = await complete(receipts)
    assert.equal(result.outcome, 'A processing result was not applied. Review the result before retrying.')
    assert.doesNotMatch(result.outcome, /saved in Media|without regenerating/)
  }
})

test('unconfirmed application error alone keeps precedence over confirmed registration in both orders', async () => {
  const saved = { state: 'done', applied: false, assetRegistered: true }
  const unknown = { state: 'done', applyError: 'The source was removed.' }
  for (const receipts of [[saved, unknown], [unknown, saved]]) {
    const result = await complete(receipts)
    assert.equal(result.outcome, 'A processing result was not applied. Review the result before retrying.')
  }
})

test('unresolved saved music cannot extend its registration claim to another completed failure', () => {
  const path = 'media/generated/music/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/score.wav'
  const music = () => ({ method: 'POST', path: '/api/audio/compose', body: { track: 'A3' } })
  const receipt = { state: 'asset_ready', path, asset: { generated: { kind: 'original-music', renderer: 'arya-score-synth/1' } } }
  for (const order of ['music-first', 'unknown-first']) {
    const outcomes = helper.createToolOutcomes()
    const failUnknown = () => helper.recordCompletedJobOutcome(outcomes, { state: 'done', applied: false, assetRegistered: false })
    if (order === 'unknown-first') failUnknown()
    helper.recordToolOutcome(outcomes, music(), receipt)
    if (order === 'music-first') failUnknown()
    assert.equal(helper.unresolvedToolOutcome(outcomes), 'A processing result was not applied. Review the result before retrying.')
    assert.equal(outcomes.musicPlacements.size, 1)
  }
})

test('a later confirmed result or resolved music placement cannot clear unknown completed failure', () => {
  const outcomes = helper.createToolOutcomes(), path = 'media/generated/music/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/score.wav'
  const asset = { generated: { kind: 'original-music', renderer: 'arya-score-synth/1' } }
  helper.recordCompletedJobOutcome(outcomes, { state: 'done', applied: false })
  helper.recordToolOutcome(outcomes, { method: 'POST', path: '/api/audio/compose', body: { track: 'A3' } }, { state: 'asset_ready', path, asset })
  helper.recordCompletedJobOutcome(outcomes, { state: 'done', applied: false, assetRegistered: true })
  helper.recordToolOutcome(outcomes, { method: 'POST', path: '/api/audio/compose/place', body: { path, track: 'A3' } }, { state: 'complete', path, asset })
  assert.equal(outcomes.musicPlacements.size, 0)
  assert.equal(helper.unresolvedToolOutcome(outcomes), 'A processing result was not applied. Review the result before retrying.')
})
