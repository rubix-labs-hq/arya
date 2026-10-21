import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridge as startRealBridge } from '../agent/bridge.mjs'
import { prepareAdapter, subscriptionEnvironment, outputEvent } from '../agent/adapters.mjs'
import { newProject, applyOps } from '../core/project.js'
import { framePlan } from '../core/render-plan.js'
import { validateCall } from '../agent/protocol.mjs'

import { fixtureBridgeOptions, fixtureSharing } from './fixtures/sharing-fixture.mjs'
const startBridge = options => startRealBridge(fixtureBridgeOptions(options))

const dir = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(dir, 'fixtures/agent-cli.mjs'), mcp = path.join(dir, '../agent/mcp.mjs')
const adversarial = path.join(dir, 'fixtures/agent-adversarial.mjs')
async function request(bridge, method, route, body, headers = {}) {
  if (route === '/v1/runs' && body) body = { ...body, sharing: fixtureSharing(bridge.endpoint) }
  const response = await fetch(new URL(route, bridge.endpoint), { method, headers: { authorization: `Bearer ${bridge.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}
async function drive(bridge, body, state) {
  const started = await request(bridge, 'POST', '/v1/runs', body); assert.equal(started.status, 201)
  assert.equal((await request(bridge, 'POST', '/v1/runs', body)).status, 200)
  assert.equal((await request(bridge, 'POST', '/v1/runs', { ...body, text: 'different' })).status, 409)
  let cursor = 0, toolCalls = 0
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const batch = (await request(bridge, 'GET', `/v1/runs/${body.id}/events?after=${cursor}`)).body.events
    for (const event of batch) {
      assert.ok(event.seq > cursor); cursor = event.seq
      if (event.type === 'error') assert.fail(event.message)
      if (event.type === 'done') return toolCalls
      if (event.type !== 'tool') continue
      toolCalls++
      let result
      if (event.frame) {
        const plan = framePlan(state.project, event.frame.at)
        state.frames.push(plan)
        result = { image: { mediaType: 'image/png', data: 'iVBORw0KGgo=' } }
      } else if (event.path === '/api/ops') {
        state.project = applyOps(state.project, event.body.ops).project; state.edits++
        result = { result: { version: state.edits, created: [] } }
      } else result = { result: event.path === '/api/caps' ? { renderer: 'metal', editable: true } : { project: state.project } }
      assert.equal((await request(bridge, 'POST', `/v1/runs/${body.id}/tools/${event.callID}`, result)).status, 200)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('bridge fixture timed out')
}

test('stdio agent plan creates editable comp/title/audio/motion, then tweaks its selected title', async () => {
  const bridge = await startBridge({ custom: { executable: process.execPath, args: [fixture, mcp] } })
  try {
    const state = { project: newProject('Agent fixture', 160, 90, 30), edits: 0, frames: [] }
    assert.equal(await drive(bridge, { id: randomUUID(), provider: 'claude-code', text: 'Build a three-second editable scene.', context: { projectID: 'fixture' } }, state), 5)
    assert.equal(state.edits, 1)
    assert.equal(Object.keys(state.project.comps).length, 1)
    const comp = state.project.comps.k1
    const title = comp.tracks.flatMap(track => track.clips).find(clip => clip.title)
    assert.equal(title.title.text, 'EDITABLE SCENE')
    assert.equal(comp.tracks.find(track => track.kind === 'audio').clips[0].volume, 0.5)
    const shape = comp.tracks.flatMap(track => track.clips).find(clip => clip.shape)
    const before = JSON.stringify(shape)
    assert.equal(await drive(bridge, { id: randomUUID(), provider: 'claude-code', text: 'Change only the selected title.', context: { projectID: 'fixture', selection: [title.id], comp: 'k1' } }, state), 5)
    assert.equal(state.project.comps.k1.tracks.flatMap(track => track.clips).find(clip => clip.title).title.text, 'SELECTED TWEAK')
    assert.equal(JSON.stringify(state.project.comps.k1.tracks.flatMap(track => track.clips).find(clip => clip.shape)), before)
    assert.equal(state.frames.length, 4)
    const first = state.frames[0].layers[0].clip.composition.layers.find(layer => layer.clip.kind === 'shape')
    const moved = state.frames[1].layers[0].clip.composition.layers.find(layer => layer.clip.kind === 'shape')
    assert.notEqual(first.clip.matrix[4], moved.clip.matrix[4])
  } finally { await bridge.close() }
})

test('bridge enforces bearer auth, loopback Origin and owned cancellation', async () => {
  const bridge = await startBridge({ custom: { executable: process.execPath, args: [fixture, mcp, 'hold'] }, pairNonce: 'a'.repeat(64) })
  try {
    assert.ok(bridge.pairing.pairURL.endsWith('&nonce=' + 'a'.repeat(64)))
    assert.equal((await request(bridge, 'GET', '/v1/status', undefined, { authorization: 'Bearer wrong' })).status, 401)
    assert.equal((await request(bridge, 'GET', '/v1/status', undefined, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await request(bridge, 'GET', '/v1/status', undefined, { origin: 'null' })).status, 403)
    const ids = [randomUUID(), randomUUID()]
    for (const id of ids) assert.equal((await request(bridge, 'POST', '/v1/runs', { id, provider: 'claude-code', text: 'Wait' })).status, 201)
    assert.equal((await request(bridge, 'POST', '/v1/shutdown', {})).status, 409)
    assert.equal(bridge.server.listening, true)
    assert.equal((await request(bridge, 'POST', `/v1/runs/${ids[0]}/cancel`, {})).status, 200)
    assert.equal((await request(bridge, 'GET', `/v1/runs/${ids[0]}/events`)).body.events.at(-1).type, 'error')
    assert.equal((await request(bridge, 'GET', `/v1/runs/${ids[1]}/events`)).body.events.some(event => ['done', 'error'].includes(event.type)), false)
    assert.equal((await request(bridge, 'POST', `/v1/runs/${randomUUID()}/cancel`, {})).status, 404)
  } finally { await bridge.close() }
})

test('subscription adapters remove API overrides and preserve explicit model/agent settings', async () => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-adapter-bin-'))
  const originalPath = process.env.PATH
  await fs.symlink(process.execPath, path.join(bin, 'claude'))
  await fs.symlink(process.execPath, path.join(bin, 'codex'))
  process.env.PATH = bin
  try {
    const env = subscriptionEnvironment({ ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'x', GEMINI_API_KEY: 'x', HOME: '/user', PATH: '/bin' })
    assert.deepEqual(env, { HOME: '/user', PATH: '/bin' })
    const request = { id: randomUUID(), provider: 'claude-code', text: 'Edit', model: 'sonnet', agent: 'editor' }
    const adapter = await prepareAdapter(request, { endpoint: 'http://127.0.0.1:12345/', token: 'a'.repeat(64) })
    try {
      assert.equal(adapter.command, path.join(bin, 'claude'))
      assert.ok(adapter.args.includes('--strict-mcp-config'))
      assert.ok(adapter.args.includes('sonnet')); assert.ok(adapter.args.includes('editor'))
      assert.equal(adapter.args[adapter.args.indexOf('--tools') + 1], '')
      assert.ok(!adapter.args.join(' ').includes('a'.repeat(64)))
    } finally { await adapter.cleanup() }
    const codex = await prepareAdapter({ id: randomUUID(), provider: 'codex', text: 'Edit', model: 'gpt-6' }, { endpoint: 'http://127.0.0.1:12345/', token: 'a'.repeat(64) })
    try {
      assert.equal(codex.command, path.join(bin, 'codex'))
      assert.ok(codex.args.includes('--strict-config'))
      for (const name of ['shell_tool', 'view_image', 'hooks', 'apps', 'plugins', 'memories', 'multi_agent', 'browser_use', 'computer_use']) assert.ok(codex.args.some((value, index) => value === '--disable' && codex.args[index + 1] === name))
      assert.ok(!codex.args.some((value, index) => value === '--disable' && codex.args[index + 1] === 'code_mode_host'))
      assert.ok(codex.args.includes('web_search="disabled"'))
      assert.ok(codex.args.includes('mcp_servers.reel.enabled_tools=["reel_api","reel_frame"]'))
      assert.ok(!codex.args.join(' ').includes('a'.repeat(64)))
    } finally { await codex.cleanup() }
    assert.deepEqual(outputEvent('antigravity', JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Done' } })), { type: 'done', text: 'Done' })
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await fs.rm(bin, { recursive: true, force: true })
  }
})

test('Google editing adapters reject without launching a provider or granting permissions', async () => {
  for (const provider of ['antigravity', 'gemini-cli']) {
    await assert.rejects(prepareAdapter({ id: randomUUID(), provider, text: 'Edit' }, { endpoint: 'http://127.0.0.1:12345/', token: 'a'.repeat(64) }), /Google subscription editing is unavailable in Arya.*have not been verified.*does not change global permissions or use an API fallback/)
  }
})

test('agent tools allow Figma imports and project reference images while blocking account and external paths', () => {
  for (const route of ['/api/figma/import', '/api/figma/import-mcp', '/api/figma/frames', '/api/video/denoise', '/api/analysis/track', '/api/analysis/saliency', '/api/analysis/autoreframe', '/api/analysis/person-mask']) assert.equal(validateCall('reel_api', { method: 'POST', path: route, body: {} }).path, route)
  assert.equal(validateCall('reel_api', { method: 'GET', path: '/api/figma/status' }).path, '/api/figma/status')
  for (const route of ['/api/figma/token', '/api/figma/disconnect', '/api/figma/oauth/start', '/api/assistant/config']) assert.throws(() => validateCall('reel_api', { method: 'POST', path: route, body: {} }))
  assert.deepEqual(validateCall('reel_frame', { src: 'references/look one.png' }), { frame: { src: 'references/look one.png' } })
  for (const src of ['/tmp/private.png', '../private.png', 'references/../../private.png', 'https://example.test/look.png', 'references\\private.png']) assert.throws(() => validateCall('reel_frame', { src }))
  assert.throws(() => validateCall('reel_frame', { src: 'look.png', at: 0 }))
})

async function externalBridge(mode, marker) {
  const child = spawn(process.execPath, [path.join(dir, 'fixtures/sharing-bridge-runner.mjs'), adversarial, mode, marker, mcp], { stdio: ['ignore', 'pipe', 'pipe'] })
  let buffer = ''
  const pair = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.stdout.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0])) })
    child.once('exit', () => reject(new Error('Companion exited before pairing')))
  })
  return { endpoint: `http://127.0.0.1:${pair.port}/`, token: pair.token, child, close: async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }
  } }
}
const exists = async file => { try { return await fs.readFile(file, 'utf8') } catch { return null } }
const alive = pid => { try { process.kill(Number(pid), 0); return true } catch { return false } }

test('oversized output finalizes within bounds and keeps the companion responsive', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-agent-limit-')), marker = path.join(folder, 'pid')
  const bridge = await externalBridge('flood', marker), id = randomUUID()
  try {
    assert.equal((await request(bridge, 'POST', '/v1/runs', { id, provider: 'claude-code', text: 'Flood' })).status, 201)
    let terminal, cursor = 0
    for (let i = 0; i < 200 && !terminal; i++) {
      const answer = await request(bridge, 'GET', `/v1/runs/${id}/events?after=${cursor}`)
      assert.equal(answer.status, 200)
      for (const event of answer.body.events) { cursor = event.seq; if (event.type === 'error') terminal = event }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.match(terminal?.message ?? '', /limit/)
    assert.ok(cursor <= 4096)
  } finally { await bridge.close(); await fs.rm(folder, { recursive: true, force: true }) }
})

test('provider completion stops its owned live CLI and its stdio MCP', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-agent-finish-')), marker = path.join(folder, 'pid')
  const bridge = await externalBridge('done', marker)
  try {
    assert.equal((await request(bridge, 'POST', '/v1/runs', { id: randomUUID(), provider: 'claude-code', text: 'Finish' })).status, 201)
    let pid, mcpPID
    for (let i = 0; i < 80; i++) { pid = await exists(marker); mcpPID = await exists(marker + '.mcp'); if (pid && mcpPID) break; await new Promise(resolve => setTimeout(resolve, 25)) }
    assert.ok(pid && mcpPID)
    for (let i = 0; i < 160 && (alive(pid) || alive(mcpPID)); i++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(alive(pid), false, 'Completed CLI must exit within its five-second grace and termination deadline')
    assert.equal(alive(mcpPID), false, 'Its MCP must exit after the CLI closes its input pipe')
  } finally { await bridge.close(); await fs.rm(folder, { recursive: true, force: true }) }
})

test('undelivered frame results have a per-run retained-memory cap', async () => {
  const bridge = await startBridge({ custom: { executable: process.execPath, args: [adversarial, 'calls'] } }), id = randomUUID()
  try {
    await request(bridge, 'POST', '/v1/runs', { id, provider: 'claude-code', text: 'Frames' })
    let calls = []
    for (let i = 0; i < 100 && calls.length < 8; i++) { calls = (await request(bridge, 'GET', `/v1/runs/${id}/events`)).body.events.filter(event => event.type === 'tool'); await new Promise(resolve => setTimeout(resolve, 20)) }
    assert.equal(calls.length, 8)
    const body = { image: { mediaType: 'image/png', data: 'A'.repeat(4 * 1024 * 1024) } }
    assert.equal((await request(bridge, 'POST', `/v1/runs/${id}/tools/${calls[0].callID}`, body)).status, 200)
    assert.equal((await request(bridge, 'POST', `/v1/runs/${id}/tools/${calls[1].callID}`, body)).status, 200)
    assert.equal((await request(bridge, 'POST', `/v1/runs/${id}/tools/${calls[2].callID}`, body)).status, 413)
  } finally { await bridge.close() }
})

test('owned bridge shutdown closes admission before an already reading HTTP body can finish', async t => {
  let preparations = 0
  const bridge = await startBridge({ prepareAdapter: async () => { preparations++; throw new Error('A closed bridge must not prepare a CLI.') } })
  t.after(() => bridge.close())
  const body = JSON.stringify({ id: randomUUID(), provider: 'claude-code', text: 'Delayed body must never launch.' })
  let resolveStarted
  const started = new Promise(resolve => { resolveStarted = resolve })
  bridge.server.once('request', resolveStarted)
  let resolveFinished
  const finished = new Promise(resolve => { resolveFinished = resolve })
  const client = http.request(new URL('/v1/runs', bridge.endpoint), { method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
    response.resume(); response.once('end', resolveFinished); response.once('error', resolveFinished)
  })
  client.once('error', resolveFinished); client.once('close', resolveFinished)
  client.write(body.slice(0, -1))
  await started
  const closing = bridge.close()
  assert.equal(bridge.close(), closing, 'Concurrent closure shares the same owned cleanup')
  client.end(body.slice(-1))
  await closing; await finished
  assert.equal(preparations, 0)
  await assert.rejects(fetch(new URL('/v1/runs', bridge.endpoint), { method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }, body }), /fetch failed/)
})


test('helper restart requires master authentication and closes only an idle owned bridge', async () => {
  const bridge = await startBridge({})
  try {
    assert.equal((await request(bridge, 'POST', '/v1/shutdown', {}, { authorization: 'Bearer wrong' })).status, 401)
    assert.equal(bridge.server.listening, true)
    const closed = new Promise(resolve => bridge.server.once('close', resolve))
    assert.deepEqual(await request(bridge, 'POST', '/v1/shutdown', {}), { status: 200, body: { stopped: true } })
    await closed
    assert.equal(bridge.server.listening, false)
  } finally { await bridge.close() }
})
