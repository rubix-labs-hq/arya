import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { approveFixture } from './fixtures/sharing-fixture.mjs'
import { createBrowserAssistant } from '../agent/browser-assistant.mjs'
import { createToolOutcomes, recordToolOutcome, unresolvedToolOutcome } from '../agent/tool-outcomes.mjs'
import { newProject, applyOps, outline } from '../core/project.js'
import musicRoutes from '../routes/music.mjs'

const exec = promisify(execFile)
const cue = { version: 1, title: 'Retry fixture cue', bpm: 120, lengthBeats: 2, room: 0, parts: [{ id: 'bass', instrument: 'bass', notes: [{ at: 0.5, duration: 0.5, pitch: 69, velocity: 0.7 }] }] }
const temporary = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya music boundary ')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root }
const waitFor = async predicate => { for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) } assert.fail('Fixture did not settle') }
async function probe(root, src) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(root, src)])
  const data = JSON.parse(stdout), audio = data.streams.find(stream => stream.codec_type === 'audio')
  return { hasAudio: !!audio, hasVideo: data.streams.some(stream => stream.codec_type === 'video'), channels: audio?.channels, codec: audio?.codec_name, duration: Number(data.format.duration), sampleRate: Number(audio?.sample_rate), size: Number(data.format.size) }
}
function projectContext(root) {
  let project = newProject('Music boundary fixture'), version = 7
  const history = [], receipts = []
  const ctx = { ROOT: root, getProject: () => project, getVersion: () => version, getProjectGeneration: () => 0, probe: src => probe(root, src), history, receipts,
    callAPI: async (method, route, body) => {
      if (method === 'GET') return route === '/api/outline' ? { outline: outline(project), version } : { project, version }
      assert.equal(route, '/api/ops'); assert.equal(body.expectedVersion, version)
      if (ctx.rejectPlacement && body.ops.some(op => op.op === 'add_clip')) throw new Error('Fixture target changed before placement')
      const next = applyOps(project, body.ops); history.push(project); project = next.project; version++
      fs.writeFileSync(path.join(root, 'reel.project.json'), JSON.stringify(project))
      return { version, created: next.created }
    },
  }
  return ctx
}

const media = path => ({ path, asset: { generated: { kind: 'original-music', renderer: 'arya-score-synth/1' } } })
const sourceA = 'media/generated/music/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/score.wav'
const sourceB = 'media/generated/music/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/score.wav'
const failedMusic = path => ({ ...media(path), state: 'asset_ready' })
const placedMusic = path => ({ ...media(path), state: 'complete', created: ['c100'] })
const compose = (track = 'A3', comp = null) => ({ method: 'POST', path: '/api/audio/compose', body: { track, comp, start: 0 } })
const retry = (path, track = 'A3', comp = null, start = 2) => ({ method: 'POST', path: '/api/audio/compose/place', body: { path, track, comp, start } })

test('a valid staged preview waits for approval without creating or clearing a processing failure', () => {
  const outcomes = createToolOutcomes()
  const call = { method: 'POST', path: '/api/assistant/propose' }
  const receipt = { previewed: true, applied: false, proposal: 'review-123' }
  recordToolOutcome(outcomes, call, receipt)
  assert.equal(unresolvedToolOutcome(outcomes), null)
  recordToolOutcome(outcomes, compose(), failedMusic(sourceA))
  recordToolOutcome(outcomes, call, receipt)
  assert.match(unresolvedToolOutcome(outcomes), /Generated media.*not applied/)
})

test('unconfirmed previews and other routes cannot disguise unapplied processing results', () => {
  for (const [call, receipt] of [
    [{ method: 'POST', path: '/api/assistant/propose' }, { applied: false, previewed: true }],
    [{ method: 'POST', path: '/api/assistant/propose' }, { applied: false, previewed: true, proposal: '../invalid' }],
    [{ method: 'POST', path: '/api/assistant/propose' }, { applied: false, proposal: 'review-123' }],
    [compose(), { applied: false, previewed: true, proposal: 'review-123' }],
  ]) {
    const outcomes = createToolOutcomes()
    recordToolOutcome(outcomes, call, receipt)
    assert.match(unresolvedToolOutcome(outcomes), /not applied/)
  }
})

test('recovering one saved cue leaves another saved cue unresolved', () => {
  const outcomes = createToolOutcomes()
  recordToolOutcome(outcomes, compose(), failedMusic(sourceA))
  recordToolOutcome(outcomes, compose(), failedMusic(sourceB))
  recordToolOutcome(outcomes, retry(sourceA), placedMusic(sourceA))
  assert.match(unresolvedToolOutcome(outcomes), /Generated media.*not applied/)
  recordToolOutcome(outcomes, retry(sourceB), placedMusic(sourceB))
  assert.equal(unresolvedToolOutcome(outcomes), null)
})

test('a different composition/track or mismatched returned path cannot clear the requested placement', () => {
  const outcomes = createToolOutcomes()
  recordToolOutcome(outcomes, compose('A3', 'sceneA'), failedMusic(sourceA))
  for (const [call, receipt] of [
    [retry(sourceA, 'A2', 'sceneA'), placedMusic(sourceA)],
    [retry(sourceA, 'A3', 'sceneB'), placedMusic(sourceA)],
    [retry(sourceA, 'A3', 'sceneA'), placedMusic(sourceB)],
    [retry(sourceA, 'A3', 'sceneA'), { ...placedMusic(sourceA), track: 'A1' }],
    [retry(sourceA, 'A3', 'sceneA'), { ...placedMusic(sourceA), comp: null }],
    [retry(sourceA, 'A3', 'sceneA'), { ...placedMusic(sourceA), applied: false }],
    [retry(sourceA, 'A3', 'sceneA'), { ...placedMusic(sourceA), state: 'running' }],
  ]) {
    recordToolOutcome(outcomes, call, receipt)
    assert.match(unresolvedToolOutcome(outcomes), /not applied/)
  }
  // Start can change when the same reviewed track needs another gap.
  recordToolOutcome(outcomes, retry(sourceA, 'A3', 'sceneA', 4), placedMusic(sourceA))
  assert.equal(unresolvedToolOutcome(outcomes), null)
})

test('successful music recovery cannot hide an unrelated failed edit or another generated-media failure', () => {
  for (const receipt of [{ applied: false }, { state: 'asset_ready', path: 'media/other.png', assetRegistered: true }]) {
    const outcomes = createToolOutcomes()
    recordToolOutcome(outcomes, { method: 'POST', path: '/api/video/denoise', body: {} }, receipt)
    recordToolOutcome(outcomes, compose(), failedMusic(sourceA))
    recordToolOutcome(outcomes, retry(sourceA), placedMusic(sourceA))
    assert.match(unresolvedToolOutcome(outcomes), /not applied/)
    if (receipt.assetRegistered) assert.match(unresolvedToolOutcome(outcomes), /Generated media/)
    else assert.match(unresolvedToolOutcome(outcomes), /^A processing result/)
  }
})

test('incomplete music receipts stay conservatively unresolved and later unrelated completions do not clear them', () => {
  const outcomes = createToolOutcomes()
  recordToolOutcome(outcomes, compose(), { state: 'asset_ready', path: sourceA })
  recordToolOutcome(outcomes, retry(sourceA), placedMusic(sourceA))
  assert.match(unresolvedToolOutcome(outcomes), /not applied/)
  recordToolOutcome(outcomes, { method: 'GET', path: '/api/outline' }, { state: 'complete' })
  assert.match(unresolvedToolOutcome(outcomes), /not applied/)
})

test('actual same-run music retry clears its own failed outcome without regenerating the saved WAV', async t => {
  const root = temporary(t), ctx = projectContext(root), routes = musicRoutes(ctx).routes
  let phase = 0, seq = 0, readyPath, runID
  const calls = [], transportReplies = [], previousFetch = globalThis.fetch
  const events = () => {
    const tool = (callID, method, path, body) => ({ seq: ++seq, type: 'tool', callID, method, path, ...(body ? { body } : {}) })
    if (phase === 0) return tool('caps', 'GET', '/api/audio/compose/capabilities')
    if (phase === 1) return tool('project', 'GET', '/api/project')
    if (phase === 2) { ctx.rejectPlacement = true; return tool('compose', 'POST', '/api/audio/compose', { score: cue, track: 'A3', start: 0, expectedVersion: ctx.getVersion() }) }
    if (phase === 3) { ctx.rejectPlacement = false; return tool('retry', 'POST', '/api/audio/compose/place', { path: readyPath, track: 'A3', start: 2, expectedVersion: ctx.getVersion() }) }
    if (phase === 4) return tool('verify', 'GET', '/api/outline')
    return { seq: ++seq, type: 'done', text: 'Placed the saved cue successfully.' }
  }
  globalThis.fetch = async (url, options) => {
    const route = new URL(url).pathname
    assert.equal(new URL(url).hostname, 'fixture.invalid', 'no actual network is permitted by this fixture')
    let result
    if (options.method === 'POST' && route === '/v1/runs') { runID = JSON.parse(options.body).id; result = { id: runID } }
    else if (options.method === 'GET' && route.endsWith('/events')) result = { events: [events()] }
    else if (options.method === 'POST' && route.includes('/tools/')) {
      const reply = JSON.parse(options.body); assert.equal(reply.error, undefined); transportReplies.push(reply)
      if (route.endsWith('/compose')) { assert.equal(reply.result.state, 'asset_ready'); readyPath = reply.result.path }
      phase++; result = { ok: true }
    } else if (route.endsWith('/cancel')) result = { cancelled: true }
    else assert.fail('Unexpected transport route ' + route)
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = previousFetch })
  const service = createBrowserAssistant({ root, providerStatus: async () => [{ id: 'claude-code', installed: true, authenticated: true }],
    startBridge: async () => ({ endpoint: 'https://fixture.invalid/', token: 'fixture-only', close: async () => {} }),
    getIdentity: () => 1, getOutline: () => ({ outline: outline(ctx.getProject()), version: ctx.getVersion() }),
    dispatch: async (call, assertCurrent) => {
      assertCurrent(); calls.push(call.path)
      const route = routes[`${call.method} ${call.path}`]
      const result = route ? await route(call.body) : await ctx.callAPI(call.method, call.path, call.body)
      assertCurrent(); ctx.receipts.push(result); return result
    },
  })
  t.after(() => service.close())
  await approveFixture(service)
  await service.send({ text: 'Generate some good music for this.' })
  await waitFor(() => service.snapshot().state === 'done')
  const clip = ctx.getProject().tracks.find(track => track.id === 'A3').clips[0]
  assert.equal(clip.src, readyPath); assert.equal(clip.start, 2)
  assert.equal(ctx.receipts.find(value => value.state === 'asset_ready').path, readyPath)
  assert.equal(ctx.receipts.findLast(value => value.state === 'complete').path, readyPath)
  assert.equal(Object.keys(ctx.getProject().assets).length, 1)
  assert.equal(ctx.history.length, 2, 'retry produces one registration and one successful placement')
  assert.ok(fs.existsSync(path.join(root, readyPath)))
  assert.deepEqual(calls, ['/api/audio/compose/capabilities', '/api/project', '/api/audio/compose', '/api/audio/compose/place', '/api/outline'])
  assert.doesNotMatch(service.snapshot().outcome, /not applied|Retry placement/)
  assert.match(service.snapshot().outcome, /project changed.*Review edits/i)
})
