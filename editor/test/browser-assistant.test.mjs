import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createBrowserAssistant, confinedFile } from '../agent/browser-assistant.mjs'
import { startBridge as startRealBridge } from '../agent/bridge.mjs'
import interchangeRoutes from '../routes/interchange.mjs'
import { applyOps, migrate, newProject, outline } from '../core/project.js'

import { fixtureBridgeOptions, approveFixture, fixtureSharing, forwardedFixtureBody } from './fixtures/sharing-fixture.mjs'
const startBridge = options => startRealBridge(fixtureBridgeOptions(options))

const exec = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const statuses = async () => [
  { id: 'claude-code', installed: true, authenticated: true, reason: 'Fixture account login.' },
  { id: 'codex', installed: true, authenticated: false, reason: 'Sign in to Codex with ChatGPT.' },
  { id: 'antigravity', installed: true, authenticated: true, available: false, reason: 'Per-run permissions are unavailable.' },
  { id: 'custom', installed: true, authenticated: true },
]
const alive = pid => { try { process.kill(Number(pid), 0); return true } catch { return false } }
// A deadline rather than a fixed count of polls: child CLIs exit through grace periods that run
// longer than 5 s when the whole suite loads the machine. The assertions are unchanged.
const waitFor = async (predicate, ms = 20000) => {
  const deadline = Date.now() + ms
  do { const value = await predicate(); if (value) return value; await sleep(20) } while (Date.now() < deadline)
  assert.fail('The browser assistant fixture did not reach the expected state.')
}
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel browser assistant ')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root }
function options(root, additions = {}) {
  return { root, platform: 'darwin', providerStatus: statuses, getIdentity: () => 1, getOutline: () => ({ version: 1 }), dispatch: async () => ({}), renderFrame: async () => ({ path: path.join(root, 'frame.png') }), bridgeOptions: fixtureBridgeOptions({ catalogOptions: { providerStatus: statuses } }), ...additions }
}

test('provider status coalesces refreshes, keeps unknown values and saves only bounded preferences', async t => {
  const root = temporary(t), gate = deferred(); let refreshes = 0
  const service = createBrowserAssistant(options(root, { providerStatus: async () => { refreshes++; await gate.promise; return statuses() } }))
  t.after(() => service.close())
  const initial = await service.status()
  assert.equal(initial.provider, 'claude-code'); assert.equal(initial.loading, true)
  assert.equal(initial.providers[0].authenticated, null); assert.equal(initial.usage, null)
  await Promise.all([service.status(), service.status(), service.status()])
  assert.equal(refreshes, 1)
  gate.resolve()
  const ready = await service.status({ wait: true })
  assert.equal(ready.configured, true); assert.equal(ready.providers.find(row => row.id === 'custom').authenticated, null)
  assert.equal(ready.providers.find(row => row.id === 'antigravity').available, false)
  assert.equal(ready.providers[0].canLogin, true); assert.equal(typeof ready.checkedAt, 'number')
  await assert.rejects(service.configure({ provider: 'claude-code', apiKey: 'sk-ant-private-secret' }), /only provider/)
  await assert.rejects(service.configure({ provider: 'custom', executable: '/bin/sh' }), /only provider/)
  await assert.rejects(service.configure({ provider: 'custom' }), /server starts/)
  await assert.rejects(service.configure({ provider: 'codex', agent: 'editor' }), /Agent selector/)
  await assert.rejects(service.configure({ model: 'a'.repeat(129) }), /model/)
  const configured = await service.configure({ provider: 'claude-code', model: 'sonnet', agent: 'editor' })
  assert.equal(configured.model, 'sonnet'); assert.equal(configured.agent, 'editor')
  const file = path.join(root, '.reel', 'assistant-settings.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { provider: 'claude-code', model: 'sonnet', agent: 'editor' })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const reader = createBrowserAssistant(options(root)); t.after(() => reader.close())
  assert.equal(reader.snapshot().model, 'sonnet')
  assert.equal((await reader.configure({ provider: 'codex' })).configured, false)
})

test('preferences and reference files reject linked external paths without touching the target', async t => {
  const root = temporary(t), external = temporary(t), target = path.join(external, 'assistant-settings.json')
  fs.mkdirSync(path.join(root, '.reel')); fs.writeFileSync(target, 'private-original')
  fs.symlinkSync(target, path.join(root, '.reel', 'assistant-settings.json'))
  fs.symlinkSync(external, path.join(root, 'references'))
  const service = createBrowserAssistant(options(root)); t.after(() => service.close())
  await assert.rejects(service.configure({ provider: 'codex' }), /symbolic links/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'private-original')
  assert.throws(() => confinedFile(root, 'references/assistant-settings.json'), /link outside/)
  assert.throws(() => confinedFile(root, '../private'), /inside the project/)
})

test('sign-in launches only fixed installed CLI arguments and removes subscription API overrides', async t => {
  const root = temporary(t), marker = path.join(root, 'login-result.json'), cli = path.join(root, "a'b-cli")
  fs.writeFileSync(cli, `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(process.env.REEL_TEST_LOGIN_MARKER,JSON.stringify({args:process.argv.slice(2),api:process.env.ANTHROPIC_API_KEY,openai:process.env.OPENAI_API_KEY}));\n`, { mode: 0o700 })
  let calls = 0
  const service = createBrowserAssistant(options(root, { executable: async name => { assert.equal(name, 'claude'); return cli }, launchLogin: async (command, argv, env) => {
    calls++; assert.equal(command, '/usr/bin/open'); assert.deepEqual(argv.slice(0, 2), ['-a', 'Terminal'])
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(fs.statSync(argv[2]).mode & 0o777, 0o700)
    const script = fs.readFileSync(argv[2], 'utf8')
    assert.match(script, /-u 'ANTHROPIC_API_KEY'/); assert.match(script, /'auth' 'login'/)
    await exec('/bin/sh', [argv[2]], { env: { ...process.env, ANTHROPIC_API_KEY: 'blocked', OPENAI_API_KEY: 'blocked', REEL_TEST_LOGIN_MARKER: marker } })
  } }))
  t.after(() => service.close())
  const result = await service.login({ provider: 'claude-code' })
  assert.equal(result.started, true); assert.equal(result.authenticated, false); assert.equal(calls, 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(marker)), { args: ['auth', 'login', '--claudeai'] })
  await assert.rejects(service.login({ provider: 'claude-code', command: 'rm -rf /' }), /only a provider/)
  await assert.rejects(service.login({ provider: 'antigravity' }), /macOS/)
  const unsupported = createBrowserAssistant(options(root, { platform: 'linux' })); t.after(() => unsupported.close())
  await assert.rejects(unsupported.login({ provider: 'codex' }), /macOS/)
})

test('an actual stdio CLI builds native editable layers, selection context, frame tools and undo', async t => {
  const root = temporary(t), fixture = path.join(here, 'fixtures', 'agent-cli.mjs'), mcp = path.join(here, '../agent/mcp.mjs')
  fs.copyFileSync(path.join(here, 'golden', 'basics-1.png'), path.join(root, 'frame.png'))
  let project = newProject('Browser subscription fixture', { width: 160, height: 90 }), version = 1
  const past = [], replies = [], frames = [], states = []
  const service = createBrowserAssistant(options(root, { custom: { executable: process.execPath, args: [fixture, mcp] },
    getOutline: () => ({ outline: outline(project), version }),
    dispatch: async (call, assertCurrent) => {
      assertCurrent()
      if (call.method === 'GET') return call.path === '/api/caps' ? { host: 'browser', editable: true } : { outline: outline(project), version }
      if (call.path === '/api/ops') { past.push(project); const result = applyOps(project, call.body.ops); project = result.project; return { version: ++version, created: result.created } }
      throw new Error('Unexpected fixture route')
    }, renderFrame: async frame => { frames.push(frame); return { path: path.join(root, 'frame.png') } }, onReply: reply => replies.push(reply), onState: state => states.push(state),
  }))
  t.after(() => service.close())
  await service.configure({ provider: 'claude-code' }); await approveFixture(service)
  const run = await service.send({ text: 'Build a three-second scene.', refs: [], ids: [], comp: null, playhead: 0 })
  assert.match(run.runId, /^[0-9a-f-]{36}$/)
  await waitFor(() => service.snapshot().state === 'done')
  assert.ok(states.some(value => value.state === 'working' && value.phase === 'Inspecting a rendered frame'))
  const started=states.find(value => value.runId === run.runId), finished=service.snapshot()
  assert.ok(Number.isFinite(started.startedAt));assert.equal(finished.startedAt,started.startedAt)
  assert.ok(finished.finishedAt >= finished.startedAt);assert.equal(finished.updatedAt,finished.finishedAt)
  const title = project.comps.k1.tracks.flatMap(track => track.clips).find(clip => clip.title)
  assert.equal(title.title.text, 'EDITABLE SCENE')
  assert.equal(project.comps.k1.tracks.find(track => track.kind === 'audio').clips[0].volume, 0.5)
  assert.equal(frames.length, 2); assert.match(replies[0], /editable scene/)
  const shape = JSON.stringify(project.comps.k1.tracks.flatMap(track => track.clips).find(clip => clip.shape))
  await service.send({ text: 'Change the selected title.', ids: [title.id], comp: 'k1', playhead: 1.25, refs: [] })
  await waitFor(() => service.snapshot().state === 'done')
  assert.equal(project.comps.k1.tracks.flatMap(track => track.clips).find(clip => clip.title).title.text, 'SELECTED TWEAK')
  assert.equal(JSON.stringify(project.comps.k1.tracks.flatMap(track => track.clips).find(clip => clip.shape)), shape)
  project = past.pop()
  assert.equal(project.comps.k1.tracks.flatMap(track => track.clips).find(clip => clip.title).title.text, 'EDITABLE SCENE')
})

test('cancellation stops only the owned CLI and leaves another companion running', async t => {
  const root = temporary(t), otherRoot = temporary(t), fixture = path.join(here, 'fixtures', 'agent-adversarial.mjs')
  const marker = path.join(root, 'pid'), otherMarker = path.join(otherRoot, 'pid')
  const first = createBrowserAssistant(options(root, { custom: { executable: process.execPath, args: [fixture, 'hold', marker] } }))
  const second = createBrowserAssistant(options(otherRoot, { custom: { executable: process.execPath, args: [fixture, 'hold', otherMarker] } }))
  t.after(async () => { await Promise.all([first.close(), second.close()]) })
  await first.configure({ provider: 'claude-code' }); await second.configure({ provider: 'claude-code' }); await approveFixture(first); await approveFixture(second)
  await first.send({ text: 'Wait.' }); await second.send({ text: 'Wait.' })
  await waitFor(() => fs.existsSync(marker) && fs.existsSync(otherMarker))
  const pid = fs.readFileSync(marker, 'utf8'), otherPID = fs.readFileSync(otherMarker, 'utf8')
  await assert.rejects(first.send({ text: 'Duplicate.' }), /still working/)
  await assert.rejects(first.configure({ provider: 'codex' }), /finish the current/)
  const cancellation=first.cancel()
  assert.equal(first.snapshot().state,'cancelling','the request remains visibly active while owned cancellation settles')
  assert.equal((await cancellation).cancelled, true)
  assert.ok(first.snapshot().finishedAt >= first.snapshot().startedAt)
  await waitFor(() => !alive(pid))
  assert.equal(first.snapshot().state, 'cancelled'); assert.equal(alive(otherPID), true)
  assert.equal(second.snapshot().state, 'thinking')
})

async function freePort() {
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}
async function runningServer(t, mode = 'normal') {
  const root = temporary(t), bin = path.join(root, 'bin'), marker = path.join(root, 'probe-ready'), release = path.join(root, 'probe-release')
  fs.mkdirSync(bin); fs.mkdirSync(path.join(root, 'media')); fs.writeFileSync(path.join(root, 'media', 'tone.wav'), 'preserved-source')
  const initialProject = newProject('Original project')
  if (mode === 'transcript') initialProject.assets['media/tone.wav'] = { hasAudio: true, hasVideo: false, duration: 1, codec: 'pcm_s16le' }
  fs.writeFileSync(path.join(root, 'reel.project.json'), JSON.stringify(initialProject))
  const script = path.join(root, 'fixture.mjs')
  const edit = mode === 'transcript' ? "const job=await call({method:'POST',path:'/api/analyze',body:{kind:'transcript',src:'media/tone.wav',locale:'en-US',force:true,wait:false}});await call({method:'GET',path:'/api/jobs/wait?id='+job.id+'&timeout=20000'});" : `await call({method:'POST',path:'/api/ops',body:{ops:[${mode === 'probe' ? "{op:'append',track:'A1',src:'media/tone.wav',dur:1}" : "{op:'add_title',track:'V3',text:'Browser native title',dur:2}"}]}});`
  fs.writeFileSync(script, `for await(const chunk of process.stdin){}\nconst base=process.env.REEL_AGENT_ENDPOINT,id=process.env.REEL_AGENT_RUN_ID;const headers={authorization:'Bearer '+process.env.REEL_AGENT_RUN_TOKEN,'content-type':'application/json'};const call=async(body)=>{const{callID}=await(await fetch(new URL('/v1/runs/'+id+'/calls',base),{method:'POST',headers,body:JSON.stringify(body)})).json();for(let i=0;i<200;i++){const r=await(await fetch(new URL('/v1/runs/'+id+'/calls/'+callID,base),{headers})).json();if(!r.pending){if(r.error)throw Error(r.error);return r.result;}await new Promise(r=>setTimeout(r,20));}throw Error('Fixture tool timed out')};try{${edit}console.log(JSON.stringify({type:'done',text:'Edited native layers.'}));}catch(e){console.log(JSON.stringify({type:'error',message:e.message}));}\n`)
  fs.writeFileSync(path.join(bin, 'ffprobe'), `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ready');while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,20));console.log(JSON.stringify({streams:[{codec_type:'audio',codec_name:'pcm_s16le',sample_rate:'48000',channels:1}],format:{duration:'1'}}));\n`, { mode: 0o700 })
  const model = path.join(root, 'ggml-base.en.bin'); fs.writeFileSync(model, 'fixture-model')
  fs.writeFileSync(path.join(bin, 'ffmpeg'), `#!${process.execPath}\nconst fs=require('node:fs');(async()=>{fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,20));fs.writeFileSync(process.argv.at(-1),'fixture-pcm');})();\n`, { mode: 0o700 })
  fs.writeFileSync(path.join(bin, 'whisper-cli'), `#!${process.execPath}\nconst fs=require('node:fs');const prefix=process.argv[process.argv.indexOf('-of')+1];fs.writeFileSync(prefix+'.json',JSON.stringify({transcription:[{offsets:{from:0,to:500},text:'Fixture.'}]}));\n`, { mode: 0o700 })
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nif(process.argv[2]==='auth'&&process.argv[3]==='status')console.log(JSON.stringify({loggedIn:true,authMethod:'oauth',apiProvider:'anthropic'}));else import(${JSON.stringify(script)});\n`, { mode: 0o700 })
  const port = await freePort(), url = `http://127.0.0.1:${port}`, child = spawn(process.execPath, [path.join(here, '../server.mjs'), '--root', root, '--port', String(port)], { env: { ...process.env, PATH: bin, REEL_WHISPER_MODEL: model }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  t.after(async () => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(release, 'done'); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) } fs.rmSync(root, { recursive: true, force: true }) })
  await waitFor(async () => { if (child.exitCode !== null) assert.fail(output); try { return (await fetch(url + '/api/state')).ok } catch { return false } })
  let sharing
  const api = async (method, route, body, headers = {}) => { if (route === '/api/bridge/send' && body.mode !== 'plugin') body = { ...body, sharing }; const response = await fetch(url + route, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() } }
  const configured = await api('POST', '/api/assistant/config', { provider: 'claude-code' })
  assert.equal(configured.status, 200, JSON.stringify({ configured, output }))
  const review = (await api('GET', '/api/assistant/sharing')).body
  const granted = await api('POST', '/api/assistant/sharing/grant', { reviewID: review.reviewID, sharing: fixtureSharing(review.scope.companion, review.scope.models) })
  assert.equal(granted.status, 200, JSON.stringify(granted)); sharing = granted.body.sharing
  return { root, api, marker, release, child, output: () => output }
}

test('actual browser HTTP dispatch applies native edits with undo and refuses unverified plugin recipients', async t => {
  const server = await runningServer(t)
  const before = (await server.api('GET', '/api/project')).body
  const run = await server.api('POST', '/api/bridge/send', { text: 'Make an editable title.', ids: [], comp: null, playhead: 0 })
  assert.equal(run.status, 200)
  const done = await waitFor(async () => { const status = (await server.api('GET', '/api/state')).body.assistant; return status.state === 'done' ? status : false })
  assert.equal(done.provider, 'claude-code'); assert.equal(done.usage, null)
  // A newly attached UI receives terminal state and chat without waiting for another prompt.
  const url = 'http://127.0.0.1:'+server.child.spawnargs[server.child.spawnargs.indexOf('--port')+1]
  const controller = new AbortController()
  const timeout = setTimeout(()=>controller.abort(),5000)
  try {
    const stream=await fetch(url+'/api/events?role=ui',{signal:controller.signal}), reader=stream.body.getReader()
    let content=''
    while(content.split('\n\n').length<4){const {value,done}=await reader.read();assert.equal(done,false);content+=new TextDecoder().decode(value)}
    const events=content.split('\n\n').slice(0,3).map(record=>{const lines=record.split('\n');return {name:lines[0].slice(7),data:JSON.parse(lines[1].slice(6))}})
    assert.deepEqual(events.map(event=>event.name),['hello','claude','chat'])
    assert.equal(events[1].data.state,'done');assert.equal(events[1].data.runId,run.body.runId)
    assert.equal(events[2].data.at(-1).text,'Edited native layers.')
  } finally {clearTimeout(timeout);controller.abort()}
  const edited = (await server.api('GET', '/api/project')).body
  assert.equal(edited.project.tracks.flatMap(track => track.clips).find(clip => clip.title).title.text, 'Browser native title')
  assert.equal(edited.activity.at(-1).who, 'agent')
  const stale = await server.api('POST', '/api/ops', { expectedVersion: before.version, ops: [{ op: 'add_title', track: 'V3', text: 'Stale edit', dur: 1 }] })
  assert.equal(stale.status, 500); assert.match(stale.body.error, /project changed/)
  assert.equal((await server.api('POST', '/api/ops', { expectedVersion: '1', ops: [] })).status, 500)
  assert.deepEqual((await server.api('GET', '/api/project')).body.project, edited.project)
  const undone = (await server.api('POST', '/api/undo', {})).body
  assert.deepEqual(undone.project, before.project)
  const plugin = await server.api('POST', '/api/bridge/send', { mode: 'plugin', text: 'Legacy plugin prompt.' })
  assert.equal(plugin.status, 403); assert.match(plugin.body.error, /no verified AI recipient/)
  assert.equal((await server.api('GET', '/api/bridge/poll')).status, 403)
  assert.equal((await server.api('POST', '/api/assistant/config', { provider: 'custom', apiKey: 'secret' }, { origin: 'https://evil.example' })).status, 403)
  const publicJSON = JSON.stringify([done, edited, run.body, (await server.api('GET', '/api/assistant/status')).body])
  assert.equal(/"token"|"endpoint"|"pairURL"|Bearer [a-f0-9]{64}/.test(publicJSON), false)
})

test('interchange export refuses linked final files and directories without changing external bytes', async t => {
  const server = await runningServer(t), external = temporary(t), privateFile = path.join(external, 'private.otio')
  fs.writeFileSync(privateFile, 'preserved-outside')
  const renders = path.join(server.root, 'renders'); fs.mkdirSync(renders)
  fs.symlinkSync(privateFile, path.join(renders, 'destination.otio'))
  const finalFile = await server.api('POST', '/api/interchange/export', { format: 'otio', name: 'destination' })
  assert.equal(finalFile.status, 500); assert.match(finalFile.body.error, /symbolic links/)
  fs.renameSync(renders, path.join(server.root, 'saved-renders')); fs.symlinkSync(external, renders)
  const directory = await server.api('POST', '/api/interchange/export', { format: 'otio', name: 'another' })
  assert.equal(directory.status, 500); assert.match(directory.body.error, /symbolic links/)
  assert.equal(fs.readFileSync(privateFile, 'utf8'), 'preserved-outside')
  assert.equal(fs.existsSync(path.join(external, 'another.otio')), false)
})

test('agent interchange reads check the actual child inside an fcpxmld bundle', async t => {
  const root = temporary(t), external = temporary(t), bundle = path.join(root, 'reference.fcpxmld'), privateFile = path.join(external, 'private.fcpxml')
  fs.mkdirSync(bundle); fs.writeFileSync(privateFile, 'preserved-private-reference'); fs.symlinkSync(privateFile, path.join(bundle, 'Info.fcpxml'))
  const routes = interchangeRoutes({ ROOT: root, getProject: () => newProject('Read guard'), checkAgentFile: file => confinedFile(root, file) }).routes
  await assert.rejects(routes['POST /api/interchange/import']({ path: 'reference.fcpxmld', apply: false }), /link outside/)
  assert.equal(fs.readFileSync(privateFile, 'utf8'), 'preserved-private-reference')
})

test('durable transcript publication preserves corrected words after intervening edits or replacement', async t => {
  for (const mode of ['edit', 'replace', 'disk']) await t.test(mode, async childTest => {
    const server = await runningServer(childTest, 'transcript')
    await server.api('POST', '/api/transcript', { src: 'media/tone.wav', locale: 'en-US', revision: 0, words: [{ t: 0, end: 0.5, text: 'Corrected.' }] })
    const directory = path.join(server.root, '.reel', 'transcripts'), record = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json'))), original = fs.readFileSync(record)
    await server.api('POST', '/api/bridge/send', { text: 'Recognize this source again.' })
    await waitFor(() => fs.existsSync(server.marker))
    if (mode === 'edit') await server.api('POST', '/api/ops', { ops: [{ op: 'add_title', track: 'V3', text: 'User title', dur: 1 }] })
    else {
      const replacement = newProject('New owner project'); replacement.assets['media/tone.wav'] = { hasAudio: true, hasVideo: false, duration: 1, codec: 'pcm_s16le' }
      if (mode === 'replace') await server.api('POST', '/api/ops', { ops: [{ op: 'replace', project: replacement }] })
      else fs.writeFileSync(path.join(server.root, 'reel.project.json'), JSON.stringify(replacement))
    }
    fs.writeFileSync(server.release, 'done')
    await waitFor(async () => (await server.api('GET', '/api/jobs')).body.jobs.some(job => job.kind === 'transcript' && job.state === 'failed'))
    assert.deepEqual(fs.readFileSync(record), original)
    assert.equal((await server.api('GET', '/api/transcript?src=media%2Ftone.wav&locale=en-US')).body.words[0].text, 'Corrected.')
    assert.equal(fs.readFileSync(path.join(server.root, 'media', 'tone.wav'), 'utf8'), 'preserved-source')
  })
})

test('tools reject unowned cancellation and external Figma asset values before dispatch', async t => {
  const root = temporary(t), outside = temporary(t), script = path.join(root, 'restricted-tools.mjs')
  fs.writeFileSync(path.join(outside, 'private.png'), 'preserved-private'); fs.symlinkSync(outside, path.join(root, 'references'))
  const calls = [
    { method: 'POST', path: '/api/jobs/cancel', body: { id: 'userJob' } },
    { method: 'POST', path: '/api/analysis/jobs/cancel', body: { id: 'userAnalysis' } },
    { method: 'POST', path: '/api/figma/import-mcp', body: { xml: '<frame />', assets: { 'n1:1': 'references/private.png' } } },
    { method: 'POST', path: '/api/assistant/login', body: { provider: 'codex' } },
    { method: 'POST', path: '/api/figma/import-mcp', body: { xml: '<frame />', assets: { 'n1:2': 'https://collector.example/pixel.png?d=project' } } },
    { method: 'POST', path: '/api/figma/import-mcp', body: { xml: '<frame />', assets: { 'n1:3': 'http://127.0.0.1:4870/api/project' } } },
    { method: 'POST', path: '/api/figma/import-mcp', body: { xml: '<frame />', assets: { 'n1:4': ['https://collector.example/pixel.png?d=project'] } } },
  ]
  fs.writeFileSync(script, `for await(const chunk of process.stdin){}const base=process.env.REEL_AGENT_ENDPOINT,id=process.env.REEL_AGENT_RUN_ID;const headers={authorization:'Bearer '+process.env.REEL_AGENT_RUN_TOKEN,'content-type':'application/json'};const errors=[];for(const body of ${JSON.stringify(calls)}){const response=await fetch(new URL('/v1/runs/'+id+'/calls',base),{method:'POST',headers,body:JSON.stringify(body)});const first=await response.json();if(first.error){errors.push(first.error);continue;}for(let i=0;i<200;i++){const r=await(await fetch(new URL('/v1/runs/'+id+'/calls/'+first.callID,base),{headers})).json();if(!r.pending){errors.push(r.error??'DISPATCHED');break;}await new Promise(r=>setTimeout(r,20));}}console.log(JSON.stringify({type:'done',text:JSON.stringify(errors)+' Bearer '+process.env.REEL_AGENT_RUN_TOKEN+' sk-ant-supersecret123456789'}));\n`)
  let dispatched = 0
  const service = createBrowserAssistant(options(root, { custom: { executable: process.execPath, args: [script] }, dispatch: async () => { dispatched++; return {} } })); t.after(() => service.close())
  await service.configure({ provider: 'claude-code' }); await approveFixture(service); await service.send({ text: 'Try the restricted fixtures.' })
  await waitFor(() => service.snapshot().state === 'done')
  const reply = service.snapshot().text
  assert.equal(dispatched, 0); assert.match(reply, /own run/); assert.match(reply, /link outside/); assert.match(reply, /unavailable to agents/)
  assert.equal(reply.match(/only from Figma or the Figma desktop app/g)?.length, 2); assert.match(reply, /asset values must be URLs/)
  assert.match(reply, /\[redacted\]/); assert.equal(/Bearer [a-f0-9]{64}|sk-ant-supersecret/.test(reply), false)
  assert.equal(fs.readFileSync(path.join(outside, 'private.png'), 'utf8'), 'preserved-private')
})

test('failed or cancelled in-flight registration stops the actual accepted owned CLI', async t => {
  for (const mode of ['project changed', 'cancel', 'lost response']) await t.test(mode, async childTest => {
    const root = temporary(childTest), marker = path.join(root, 'pid'), accepted = deferred(), release = deferred(); let identity = 1
    const service = createBrowserAssistant(options(root, { getIdentity: () => identity, custom: { executable: process.execPath, args: [path.join(here, 'fixtures', 'agent-adversarial.mjs'), 'hold', marker] }, startBridge: async settings => {
      const owned = await startBridge(settings)
      const proxy = http.createServer(async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk)
        const response = await fetch(new URL(req.url, owned.endpoint), { method: req.method, headers: { authorization: `Bearer ${owned.token}`, 'content-type': 'application/json' }, body: req.method === 'POST' ? forwardedFixtureBody(Buffer.concat(chunks), owned.endpoint) : undefined })
        const text = await response.text()
        if (req.method === 'POST' && req.url === '/v1/runs') { accepted.resolve(); await release.promise; if (mode === 'lost response') { res.destroy(); return } }
        res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(text)
      })
      await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
      return { ...owned, endpoint: `http://127.0.0.1:${proxy.address().port}/`, close: async () => { await owned.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)) } }
    } }))
    childTest.after(() => service.close())
    await service.configure({ provider: 'claude-code' }); await approveFixture(service)
    const sent = service.send({ text: 'Wait in an owned CLI.' }).then(value => value, error => error)
    await accepted.promise; await waitFor(() => fs.existsSync(marker))
    const pid = fs.readFileSync(marker, 'utf8')
    if (mode === 'project changed') identity++
    if (mode === 'cancel') assert.equal((await service.cancel()).cancelled, true)
    release.resolve()
    const result = await sent
    assert.equal(result instanceof Error, true)
    await waitFor(() => !alive(pid))
    assert.equal(service.snapshot().state, mode === 'cancel' ? 'cancelled' : 'error')
    await service.configure({ provider: 'claude-code' }); await approveFixture(service)
  })
})

test('actual suspended probe cannot commit after cancel, concurrent edits, replacement or a disk change', async t => {
  for (const mode of ['cancel', 'edit', 'new', 'disk']) await t.test(mode, async childTest => {
    const server = await runningServer(childTest, 'probe')
    const initial = (await server.api('GET', '/api/project')).body
    await server.api('POST', '/api/bridge/send', { text: 'Append the audio source.' })
    await waitFor(() => fs.existsSync(server.marker))
    let expected = initial.project
    if (mode === 'cancel') assert.equal((await server.api('POST', '/api/assistant/cancel', {})).body.cancelled, true)
    if (mode === 'edit') expected = (await server.api('POST', '/api/ops', { ops: [{ op: 'add_title', track: 'V3', text: 'User change', dur: 1 }] })).body.project
    if (mode === 'new') expected = (await server.api('POST', '/api/new', { name: 'User replacement' })).body.project
    if (mode === 'disk') { const replacement = newProject('External replacement'); expected = migrate(replacement); fs.writeFileSync(path.join(server.root, 'reel.project.json'), JSON.stringify(replacement)) }
    const expectedDisk = fs.readFileSync(path.join(server.root, 'reel.project.json'))
    fs.writeFileSync(server.release, 'done')
    await waitFor(async () => ['error', 'cancelled'].includes((await server.api('GET', '/api/state')).body.assistant.state))
    await sleep(150)
    const actual = (await server.api('GET', '/api/project')).body
    assert.deepEqual(actual.project, expected)
    assert.deepEqual(fs.readFileSync(path.join(server.root, 'reel.project.json')), expectedDisk)
    assert.equal(fs.readFileSync(path.join(server.root, 'media', 'tone.wav'), 'utf8'), 'preserved-source')
    assert.equal(actual.project.tracks.flatMap(track => track.clips).some(clip => clip.src === 'media/tone.wav'), false)
    assert.equal(actual.version, initial.version + (mode === 'cancel' ? 0 : 1))
  })
})

test('explicit operation versions reject a stale suspended probe and a fresh retry commits atomically', async t => {
  const server = await runningServer(t, 'probe')
  const initial = (await server.api('GET', '/api/project')).body
  const ops = [{ op: 'append', track: 'A1', src: 'media/tone.wav', dur: 1 }]
  const pending = server.api('POST', '/api/ops', { expectedVersion: initial.version, ops })
  await waitFor(() => fs.existsSync(server.marker))
  const edited = (await server.api('POST', '/api/ops', { ops: [{ op: 'add_title', track: 'V3', text: 'Intervening title', dur: 1 }] })).body
  const editedBytes = fs.readFileSync(path.join(server.root, 'reel.project.json'))
  fs.writeFileSync(server.release, 'done')
  const stale = await pending
  assert.equal(stale.status, 500); assert.match(stale.body.error, /project changed/)
  assert.deepEqual((await server.api('GET', '/api/project')).body.project, edited.project)
  assert.deepEqual(fs.readFileSync(path.join(server.root, 'reel.project.json')), editedBytes)
  const retry = await server.api('POST', '/api/ops', { expectedVersion: edited.version, ops })
  assert.equal(retry.status, 200)
  assert.equal(retry.body.project.tracks.find(track => track.id === 'A1').clips[0].src, 'media/tone.wav')
  const undo = (await server.api('POST', '/api/undo', {})).body
  assert.deepEqual(undo.project, edited.project)
  assert.equal(fs.readFileSync(path.join(server.root, 'media', 'tone.wav'), 'utf8'), 'preserved-source')
})

test('cancelling an assistant aborts its own transcript process but preserves a reused user job', async t => {
  for (const reused of [false, true]) await t.test(reused ? 'reused user job' : 'owned job', async childTest => {
    const server = await runningServer(childTest, 'transcript')
    const initial = (await server.api('GET', '/api/project')).body
    if (reused) await server.api('POST', '/api/analyze', { src: 'media/tone.wav', kind: 'transcript', locale: 'en-US', wait: false })
    await server.api('POST', '/api/bridge/send', { text: 'Transcribe the source.' })
    await waitFor(() => fs.existsSync(server.marker))
    const pid = fs.readFileSync(server.marker, 'utf8')
    await sleep(150)
    assert.equal((await server.api('POST', '/api/assistant/cancel', {})).body.cancelled, true)
    if (reused) {
      assert.equal(alive(pid), true)
      fs.writeFileSync(server.release, 'done')
      await waitFor(async () => (await server.api('GET', '/api/jobs')).body.jobs.some(job => job.kind === 'transcript' && job.state === 'done'))
      assert.equal((await server.api('GET', '/api/transcript?src=media%2Ftone.wav&locale=en-US')).body.words[0].text, 'Fixture.')
    } else {
      await waitFor(() => !alive(pid))
      const jobs = (await server.api('GET', '/api/jobs')).body.jobs
      assert.equal(jobs.find(job => job.kind === 'transcript').state, 'failed')
      assert.equal((await server.api('GET', '/api/transcript?src=media%2Ftone.wav&locale=en-US')).body.status, 'missing')
    }
    const actual = (await server.api('GET', '/api/project')).body
    assert.deepEqual(actual.project, initial.project); assert.equal(actual.version, initial.version)
    assert.equal(fs.readFileSync(path.join(server.root, 'media/tone.wav'), 'utf8'), 'preserved-source')
  })
})


test('stopping reserves the conversation until owned cancellation settles, even after the event loop ends', async t => {
  const root=temporary(t), gate=deferred();let cancelRequests=0
  const fixture=http.createServer(async (req,res)=>{
    const reply=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value))}
    if(req.url==='/v1/runs') {let text='';for await(const part of req)text+=part;return reply({id:JSON.parse(text).id})}
    if(req.url.endsWith('/cancel')) {cancelRequests++;await gate.promise;return reply({id:req.url.split('/')[3],cancelled:true})}
    return reply({events:[]})
  })
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve))
  const service=createBrowserAssistant(options(root,{startBridge:async()=>({endpoint:'http://127.0.0.1:'+fixture.address().port+'/',token:'fixture-token',close:async()=>{}})}))
  t.after(async()=>{gate.resolve();await service.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve))})
  await approveFixture(service)
  const first=await service.send({text:'Wait for the current request.'})
  const stopping=service.cancel(), duplicateStop=service.cancel()
  await waitFor(()=>cancelRequests===1);await sleep(150)
  assert.equal(service.snapshot().state,'cancelling')
  await assert.rejects(service.send({text:'Another request.'}),/still working/)
  gate.resolve();assert.equal((await stopping).runId,first.runId);assert.equal((await duplicateStop).runId,first.runId)
  assert.equal(cancelRequests,1);assert.equal(service.snapshot().state,'cancelled')
  const second=await service.send({text:'New request after acknowledged stop.'})
  assert.notEqual(second.runId,first.runId);await sleep(150)
  assert.equal(service.snapshot().runId,second.runId);assert.equal(service.snapshot().state,'thinking')
  await service.cancel()
})

test('failed cancellation acknowledgements never produce a confirmed Stopped result', async t => {
  for (const mode of ['processing', 'companion']) await t.test(mode, async childTest => {
    const root=temporary(childTest);let sentTool=false,registered=false
    const fixture=http.createServer(async (req,res)=>{
      const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}
      if(req.url==='/v1/runs') {let text='';for await(const part of req)text+=part;return reply(200,{id:JSON.parse(text).id})}
      if(req.url.endsWith('/cancel')) return mode==='companion' ? reply(503,{error:'Stop could not be acknowledged'}) : reply(200,{id:req.url.split('/')[3],cancelled:true})
      if(req.url.includes('/tools/')) return reply(200,{ok:true})
      if(!sentTool) {sentTool=true;return reply(200,{events:[{seq:1,type:'tool',callID:'processing',method:'POST',path:'/api/analyze',body:{src:'media/take.mp4'}}]})}
      return reply(200,{events:[]})
    })
    await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve))
    const service=createBrowserAssistant(options(root,{
      startBridge:async()=>({endpoint:'http://127.0.0.1:'+fixture.address().port+'/',token:'fixture-token',close:async()=>{}}),
      dispatch:async(_call,_assert,_identity,register)=>{register({id:'owned',path:'/api/jobs/cancel'});registered=true;return{id:'owned',state:'running'}},
      jobState:()=> 'running',cancelJob:async()=>{if(mode==='processing')throw Error('No stop acknowledgement');return{cancelled:true}},
    }))
    childTest.after(async()=>{await service.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve))})
    await approveFixture(service)
    await service.send({text:'Start analysis.'});await waitFor(()=>registered)
    const stopped=await service.cancel()
    assert.equal(stopped.cancelled,false);assert.equal(stopped.stopUnconfirmed,true)
    assert.equal(service.snapshot().state,'error');assert.equal(service.snapshot().stopUnconfirmed,true)
  })
})

async function delayedAdmission(t, { timeout = 15000, failedClose = false } = {}) {
  const root = temporary(t), marker = path.join(root, 'pid'), arrived = deferred(), release = deferred(), forwarded = deferred()
  const counters = { cancellations: [], closes: 0, dispatches: 0, frames: 0 }, project = newProject('Cancellation fixture')
  let owned, proxy, first = true
  const service = createBrowserAssistant(options(root, {
    requestTimeoutMs: timeout, cleanupTimeoutMs: 100,
    getOutline: () => ({ version: 1, project }),
    custom: { executable: process.execPath, args: [path.join(here, 'fixtures', 'agent-adversarial.mjs'), 'calls', marker] },
    dispatch: async () => { counters.dispatches++; return {} }, renderFrame: async () => { counters.frames++; return { path: path.join(root, 'frame.png') } },
    startBridge: async settings => {
      owned = await startBridge(settings)
      proxy = http.createServer(async (req, res) => {
        const reply = (status, text) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(text) } }
        try {
          const chunks = []; for await (const chunk of req) chunks.push(chunk)
          const delayed = req.method === 'POST' && req.url === '/v1/runs' && first
          if (delayed) { first = false; arrived.resolve(); await release.promise }
          const response = await fetch(new URL(req.url, owned.endpoint), { method: req.method, headers: { authorization: `Bearer ${owned.token}`, 'content-type': 'application/json' }, body: req.method === 'POST' ? forwardedFixtureBody(Buffer.concat(chunks), owned.endpoint) : undefined })
          const text = await response.text()
          if (req.url.endsWith('/cancel')) counters.cancellations.push(response.status)
          if (delayed) {
            if (response.ok) await waitFor(() => fs.existsSync(marker))
            forwarded.resolve(response.status)
          }
          reply(response.status, text)
        } catch (error) { forwarded.resolve('closed'); reply(503, JSON.stringify({ error: 'The owned fixture bridge closed.' })) }
      })
      await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
      return { ...owned, endpoint: `http://127.0.0.1:${proxy.address().port}/`, close: async () => {
        counters.closes++
        if (failedClose) await new Promise(() => {})
        await owned.close(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve))
      } }
    },
  }))
  t.after(async () => {
    if (owned) await owned.close()
    release.resolve()
    await service.close()
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)) }
  })
  await service.configure({ provider: 'claude-code' }); await approveFixture(service)
  const initial = JSON.stringify(project)
  return { service, marker, arrived, release, forwarded, counters, project, initial, bridge: () => owned }
}

test('Stop before HTTP admission reserves the request until its actual owned CLI is stopped', async t => {
  const fixture = await delayedAdmission(t), { service, counters } = fixture
  let submissionSettled = false
  const sent = service.send({ text: 'Inspect an editable project.' }).catch(error => error).finally(() => { submissionSettled = true })
  await fixture.arrived.promise
  const stopping = service.cancel(), duplicate = service.cancel()
  await waitFor(() => counters.cancellations.length === 1)
  assert.deepEqual(counters.cancellations, [404])
  assert.equal(service.snapshot().state, 'cancelling'); assert.equal(submissionSettled, false)
  await assert.rejects(service.send({ text: 'A second request must wait.' }), /still working/)
  await assert.rejects(service.configure({ provider: 'custom' }), /Cancel or finish/)
  fixture.release.resolve()
  assert.equal(await fixture.forwarded.promise, 201)
  const stopped = await stopping
  assert.equal(stopped.cancelled, true); assert.equal(stopped.stopUnconfirmed, false)
  assert.equal((await duplicate).runId, stopped.runId)
  assert.equal((await sent) instanceof Error, true)
  await waitFor(() => !alive(fs.readFileSync(fixture.marker, 'utf8')))
  assert.deepEqual(counters.cancellations, [404, 200]); assert.equal(counters.closes, 0)
  assert.equal(counters.dispatches, 0); assert.equal(counters.frames, 0)
  assert.equal(JSON.stringify(fixture.project), fixture.initial)
  assert.equal(service.snapshot().state, 'cancelled')
  // Even a late tool directly reaching the companion cannot re-open this UUID.
  const owner = fixture.bridge()
  const lateTool = await fetch(new URL(`/v1/runs/${stopped.runId}/calls`, owner.endpoint), { method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ frame: { at: 0, width: 320 } }) })
  assert.equal(lateTool.status, 410)
  await service.configure({ provider: 'claude-code' }); await approveFixture(service)
})

test('ambiguous pending submission closes only its owned companion before confirming Stop', async t => {
  const fixture = await delayedAdmission(t, { timeout: 300 }), { service, counters } = fixture
  const sent = service.send({ text: 'Hold this submission before admission.' }).catch(error => error)
  await fixture.arrived.promise
  const started = Date.now(), stopping = service.cancel()
  await waitFor(() => counters.cancellations.length === 1)
  assert.equal(service.snapshot().state, 'cancelling')
  await assert.rejects(service.send({ text: 'Still reserved.' }), /still working/)
  const stopped = await stopping
  assert.equal(stopped.cancelled, true); assert.equal(stopped.stopUnconfirmed, false)
  assert.equal((await sent) instanceof Error, true); assert.equal(counters.closes, 1)
  assert.ok(Date.now() - started < 1500, 'The pending submission and owned cleanup are bounded')
  fixture.release.resolve()
  assert.equal(await fixture.forwarded.promise, 'closed')
  assert.equal(fs.existsSync(fixture.marker), false)
  assert.equal(counters.dispatches, 0); assert.equal(counters.frames, 0)
  assert.equal(JSON.stringify(fixture.project), fixture.initial)
  await service.configure({ provider: 'claude-code' }); await approveFixture(service)
})

test('failed bounded shutdown never confirms Stop or admits another request after a pending submission', async t => {
  const fixture = await delayedAdmission(t, { timeout: 300, failedClose: true }), { service, counters } = fixture
  const sent = service.send({ text: 'Hold this submission while shutdown fails.' }).catch(error => error)
  await fixture.arrived.promise
  const started = Date.now(), stopped = await service.cancel()
  assert.equal(stopped.cancelled, false); assert.equal(stopped.stopUnconfirmed, true)
  assert.equal((await sent) instanceof Error, true); assert.equal(counters.closes, 1)
  assert.ok(Date.now() - started < 1500, 'A stuck close cannot block the Stop response indefinitely')
  assert.equal(service.snapshot().state, 'error'); assert.match(service.snapshot().text, /shutdown could not be confirmed/)
  await assert.rejects(service.send({ text: 'Unsafe second request.' }), /still working/)
  await assert.rejects(service.configure({ provider: 'custom' }), /Cancel or finish/)
  assert.equal(counters.dispatches, 0); assert.equal(counters.frames, 0)
  assert.equal(JSON.stringify(fixture.project), fixture.initial)
})

test('actual browser HTTP withdrawal invalidates previous envelopes and stale review grants', async t => {
  const server = await runningServer(t)
  const before = (await server.api('GET', '/api/project')).body
  const oldReview = (await server.api('GET', '/api/assistant/sharing')).body
  assert.equal(oldReview.approved, true)
  const revoked = await server.api('POST', '/api/assistant/sharing/revoke', {})
  assert.equal(revoked.status, 200); assert.equal(revoked.body.approved, false)
  const denied = await server.api('POST', '/api/bridge/send', { text: 'PRIVATE_UNAPPROVED_DRAFT' })
  assert.equal(denied.status, 403); assert.match(denied.body.error, /permission.*required/)
  const after = (await server.api('GET', '/api/project')).body
  assert.deepEqual(after.project, before.project)
  assert.equal(after.chat.some(row => row.role === 'user' && row.text === 'PRIVATE_UNAPPROVED_DRAFT'), false)
  const stale = await server.api('POST', '/api/assistant/sharing/grant', { reviewID: oldReview.reviewID, sharing: oldReview.sharing })
  assert.equal(stale.status, 403)
  const fresh = (await server.api('GET', '/api/assistant/sharing')).body
  assert.equal(fresh.approved, false); assert.deepEqual(fresh.scope.classes, oldReview.scope.classes)
  const allowed = await server.api('POST', '/api/assistant/sharing/grant', { reviewID: fresh.reviewID, sharing: fixtureSharing(fresh.scope.companion, fresh.scope.models) })
  assert.equal(allowed.status, 200); assert.equal(allowed.body.approved, true)
})
