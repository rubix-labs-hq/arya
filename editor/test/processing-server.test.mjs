import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { processingWorkerConnected, retireProcessingWorkerClients } from '../core/processing-worker.mjs'
import { runProcessingProcess } from '../core/processing-process.mjs'
import { newProject } from '../core/project.js'

const turn = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate) { const deadline = Date.now() + 10000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture event did not arrive'); await turn() } }
function child() { const value = new EventEmitter(); value.stderr = new EventEmitter(); value.stdout = new EventEmitter(); value.stdin = new EventEmitter(); value.stdin.write = () => true; value.stdin.end = () => {}; value.kills = []; value.kill = signal => value.kills.push(signal); return value }

// The real server routes run against a temporary project and port 0. Only process,
// provider, persistence-helper and lifetime hooks are replaced; no media tool runs.
async function fixture(t, { sources = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-server-admission-'))
  const project = newProject('Fixture'); project.tracks[0].clips.push({ id: 'c1', kind: 'video', src: 'media/source.mp4', start: 0, dur: 10, in: 0 }); project.assets['media/source.mp4'] = { hasVideo: true, hasAudio: false, duration: 10, codec: 'h264', width: 1920, height: 1080, fps: 30 }
  fs.mkdirSync(path.join(root, 'media')); fs.writeFileSync(path.join(root, 'media', 'source.mp4'), 'source')
  for (let index = 0; index < sources; index++) { project.assets[`media/import-${index}.mp4`] = { ...project.assets['media/source.mp4'] }; fs.writeFileSync(path.join(root, 'media', `import-${index}.mp4`), `import ${index}`) }
  const file = path.join(root, 'reel.project.json'); fs.writeFileSync(file, JSON.stringify(project))
  const children = [], workers = [], fixtureKey = '__reelAdmissionServerFixture'
  globalThis[fixtureKey] = { spawn(command, args) { const value = child(); value.argv = args; if (command === 'ffmpeg') children.push(value); else { assert.equal(command, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'); workers.push(value) } return value }, process(command, args, options) { return runProcessingProcess(command, args, { ...options, spawn: this.spawn }) }, root }
  const serverFile = fileURLToPath(new URL('../server.mjs', import.meta.url)); let source = fs.readFileSync(serverFile, 'utf8')
  source = source.replace("import { spawn } from 'node:child_process'", `const spawn = (...args) => globalThis.${fixtureKey}.spawn(...args)`)
  source = source.replace("import { runProcessingProcess } from './core/processing-process.mjs'", `const runProcessingProcess = (...args) => globalThis.${fixtureKey}.process(...args)`)
  source = source.replace(/import \{ (createBrowserAssistant, confinedFile|createChatHistory|prepareMusicReimport) \} from '[^']+'\n/g, '')
  source = source.replace("import { writeProjectAtomic } from './core/project-persistence.mjs'", 'const writeProjectAtomic = () => { throw Error("Unexpected fixture project save") }')
  source = source.replace("const HERE = path.dirname(fileURLToPath(import.meta.url))", `const HERE = ${JSON.stringify(path.dirname(serverFile))}`)
  source = source.replace("const ROOT = path.resolve(args.root ?? process.cwd())", `const ROOT = globalThis.${fixtureKey}.root`)
  source = source.replace('const PORT = Number(args.port ?? process.env.PORT ?? 4870)', 'const PORT = 0')
  source = source.replace("fs.watchFile(FILE, { interval: 700 }, () => {", 'const fixtureWatch = () => {}; fixtureWatch(FILE, { interval: 700 }, () => {')
  source = source.replace(/process.on\('SIG(?:TERM|INT)', shutdown\)\n/g, '')
  source = source.replace('await loadRouteModules()', '')
  source = source.replace(/function touchWorker\(\) \{[\s\S]*?\n\}\n\nconst PRESETS/, 'function touchWorker() {}\n\nconst PRESETS')
  source = source.replace(/from '(\.\/?[^']+)'/g, (_all, relative) => `from '${new URL(relative, pathToFileURL(serverFile)).href}'`)
  source = `const createBrowserAssistant = () => ({snapshot:()=>({}),close:async()=>{}}), confinedFile=()=>{}, prepareMusicReimport=()=>{}; const createChatHistory=()=>({messages:()=>[],status:()=>({}),append:()=>[]});\n${source}\nexport { server };`
  const instrumented = path.join(root, 'server-instrumented.mjs'); fs.writeFileSync(instrumented, source)
  const module = await import(pathToFileURL(instrumented).href)
  if (!module.server.listening) await once(module.server, 'listening')
  const port = module.server.address().port
  globalThis[Symbol.for('arya.verification.registerOwnedEphemeralHTTP')]?.(module.server)
  t.after(async () => { module.server.closeAllConnections(); await new Promise(resolve => module.server.close(resolve)); delete globalThis[fixtureKey]; fs.rmSync(root, { recursive: true, force: true }) })
  function api(route, body, binary = false) { return new Promise((resolve, reject) => { const bytes = body === undefined ? null : binary ? body : Buffer.from(JSON.stringify(body)); const request = http.request({ hostname: '127.0.0.1', port, path: route, method: body === undefined ? 'GET' : 'POST', headers: { host: '127.0.0.1:0', ...(bytes ? { 'content-length': bytes.length } : {}) } }, response => { let data = ''; response.on('data', value => { data += value }); response.on('end', () => resolve({ status: response.statusCode, body: String(response.headers['content-type']).includes('json') ? JSON.parse(data) : Buffer.from(data) })) }); request.on('error', reject); request.end(bytes) }) }
  async function worker() {
    // A real worker page can only connect after Chrome starts. Export source
    // staging is asynchronous, so even several admitted jobs do not prove that.
    await until(() => workers.length > 0)
    const events = []; const request = http.get({ hostname: '127.0.0.1', port, path: '/api/events?role=worker', headers: { host: '127.0.0.1:0' } }); const [response] = await once(request, 'response'); let text = ''; response.on('data', bytes => { text += bytes; let end; while ((end = text.indexOf('\n\n')) >= 0) { const event = text.slice(0, end); text = text.slice(end + 2); const match = /event: (\S+)\ndata: ([\s\S]*)/.exec(event); if (match) events.push({ type: match[1], data: JSON.parse(match[2]) }) } }); t.after(() => request.destroy()); await turn(); return { request, events }
  }
  return { root, file, project, children, workers, api, worker, port }
}

test('server refuses invalid allocations, bounds queue, replays admitted snapshot and holds Stop until drained plus encoder close', async t => {
  const f = await fixture(t)
  const invalid = await f.api('/api/export', { width: 8192, height: 8192, range: { in: 0, out: 10 } })
  assert.equal(invalid.status, 500); assert.match(invalid.body.error, /dimensions/); assert.equal(f.children.length, 0)
  const jobs = []
  for (let index = 0; index < 8; index++) { const response = await f.api('/api/export', { preset: 'h264-high', name: `queue-${index}` }); assert.equal(response.status, 200); jobs.push(response.body) }
  const connection = await f.worker(); await until(() => connection.events.some(event => event.type === 'render')); assert.equal(connection.events.filter(event => event.type === 'render').length, 1)
  const overflow = await f.api('/api/export', {}); assert.equal(overflow.status, 429)
  const audio = f.api(`/api/audio?src=media%2Fsource.mp4&dur=1&processingJob=${jobs[0].id}`)
  while (!f.children.length) await turn()
  assert.equal((await f.api('/api/state')).body.processing.active, 1)
  assert.equal((await f.api('/api/audio?src=media%2Fsource.mp4&dur=1')).status, 429)
  fs.writeFileSync(f.children[0].argv.at(-1), 'fixture-pcm'); f.children[0].emit('close', 0)
  assert.equal((await audio).status, 200)
  assert.equal((await f.api('/api/state')).body.processing.queued, 7)
  const queuedStop = await f.api('/api/jobs/cancel', { id: jobs[7].id }); assert.equal(queuedStop.status, 200)
  assert.equal((await f.api('/api/state')).body.processing.queued, 6)
  connection.request.destroy(); await turn(); const reconnect = await f.worker(); await until(() => reconnect.events.some(event => event.type === 'render'))
  const replay = reconnect.events.filter(event => event.type === 'render'); assert.equal(replay.length, 1); assert.equal(replay[0].data.job.id, jobs[0].id); assert.equal(replay[0].data.version, jobs[0].projectVersion)
  assert.equal((await f.api(`/api/job/${jobs[1].id}/start`, {})).status, 409)
  assert.equal((await f.api(`/api/job/${jobs[0].id}/start`, {})).status, 200); assert.equal(f.children.length, 2)
  await f.api('/api/jobs/cancel', { id: jobs[0].id })
  assert.equal((await f.api(`/api/job/${jobs[0].id}/frames`, Buffer.from('late'), true)).status, 410)
  await f.api(`/api/job/${jobs[0].id}/drained`, {})
  assert.equal((await f.api('/api/state')).body.processing.active, 1)
  assert.equal(reconnect.events.filter(event => event.type === 'render').length, 1)
  f.children[1].emit('close', null); await until(() => reconnect.events.filter(event => event.type === 'render').length === 2)
  assert.equal(reconnect.events.filter(event => event.type === 'render').length, 2)
  // Replacing the on-disk project prevents publication and subsequent queued dispatch.
  fs.writeFileSync(f.file, JSON.stringify({ ...f.project, name: 'Changed composition' }))
  const stale = await f.api(`/api/job/${jobs[1].id}/start`, {}); assert.equal(stale.status, 500); assert.match(stale.body.error, /project changed/)
  await f.api(`/api/job/${jobs[1].id}/drained`, {}); await turn(); await turn()
  const state = (await f.api('/api/state')).body.processing
  assert.equal(state.active, 0); assert.equal(state.queued, 0); assert.equal(f.children.length, 2)
})

test('the job routes record worker progress for the stall watchdog', async t => {
  const f = await fixture(t)
  const job = (await f.api('/api/export', { preset: 'png-seq', name: 'watched', range: { in: 0, out: 1 } })).body
  // The server spawns the worker process first; a worker page that connects after that serves it.
  let connection
  for (let attempt = 0; attempt < 50 && !connection?.events.some(event => event.type === 'render'); attempt++) {
    connection?.request.destroy()
    await new Promise(r => setTimeout(r, 100))
    connection = await f.worker()
    await new Promise(r => setTimeout(r, 50))
  }
  await until(() => connection.events.some(event => event.type === 'render'))
  const read = async () => (await f.api('/api/jobs')).body.jobs.find(j => j.id === job.id)
  const dispatched = await read()
  assert.ok(Number.isFinite(dispatched.workerDispatchedAt) && dispatched.lastWorkerActivity === dispatched.workerDispatchedAt)
  await new Promise(r => setTimeout(r, 5))
  assert.equal((await f.api(`/api/job/${job.id}/alive`, {})).status, 200)
  const setup = await read()
  assert.ok(setup.lastWorkerActivity > dispatched.lastWorkerActivity, 'a heartbeat during setup counts')
  // The heartbeat body names the setup step; anything else is ignored.
  assert.equal(setup.workerStep, undefined)
  assert.equal((await f.api(`/api/job/${job.id}/alive`, Buffer.from('audio'), true)).status, 200)
  assert.equal((await read()).workerStep, 'audio')
  assert.equal((await f.api(`/api/job/${job.id}/alive`, Buffer.from('x'.repeat(200)), true)).status, 200)
  assert.equal((await read()).workerStep, 'audio', 'an oversized or unknown body changes nothing')
  assert.equal((await f.api(`/api/job/${job.id}/start`, {})).status, 200)
  const started = await read()
  assert.ok(Number.isFinite(started.workerStartedAt))
  assert.equal((await f.api(`/api/job/${job.id}/frames?done=1`, Buffer.from('frame'), true)).status, 200)
  const rendering = await read()
  assert.equal(rendering.workerFramesSeen, true)
  await new Promise(r => setTimeout(r, 5))
  await f.api(`/api/job/${job.id}/alive`, {})
  assert.equal((await read()).lastWorkerActivity, rendering.lastWorkerActivity, 'heartbeats stop counting once frames flow')
  await f.api('/api/jobs/cancel', { id: job.id }); await f.api(`/api/job/${job.id}/drained`, {})
  for (const child of f.children) child.emit('close', null)
})

test('a worker page that closes mid-export fails the job within seconds and the next export gets a new worker', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const job = (await f.api('/api/export', { preset: 'png-seq', name: 'closed', range: { in: 0, out: 1 } })).body
  const connection = await f.worker()
  await until(() => connection.events.some(event => event.type === 'render'))
  assert.equal((await f.api(`/api/job/${job.id}/start`, {})).status, 200)
  assert.equal((await f.api('/api/state')).body.worker, true)
  // The page dies: its event stream closes and nothing reconnects.
  connection.request.destroy()
  const read = async id => (await f.api('/api/jobs')).body.jobs.find(j => j.id === id)
  await new Promise(resolve => setTimeout(resolve, 3000))
  assert.equal((await read(job.id)).state, 'running', 'the page gets 5 s to reconnect')
  const deadline = Date.now() + 8000
  while ((await read(job.id)).state !== 'failed') { assert.ok(Date.now() < deadline, 'the job must fail soon after the grace period'); await new Promise(resolve => setTimeout(resolve, 100)) }
  assert.equal((await read(job.id)).error, 'The render worker closed while this export was running. Export again.')
  assert.deepEqual(f.workers[0].kills.slice(0, 1), ['SIGTERM'], 'the browser without a page is stopped')
  for (const child of f.children) child.emit('close', null)
  // The next export does not wait behind the dead worker: a new browser is started for it.
  const next = (await f.api('/api/export', { preset: 'png-seq', name: 'after', range: { in: 0, out: 1 } })).body
  await until(() => f.workers.length === 2)
  const replacement = await f.worker()
  await until(() => replacement.events.some(event => event.type === 'render' && event.data.job.id === next.id))
  assert.match(f.workers[1].argv.at(-1), /\?worker=1&id=[0-9a-f-]{36}$/)
  assert.notEqual(f.workers[1].argv.at(-1), f.workers[0].argv.at(-1), 'each browser gets its own token')
  await f.api('/api/jobs/cancel', { id: next.id }); await f.api(`/api/job/${next.id}/drained`, {})
})

test('a page that presents a replaced worker\'s token is refused', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const job = (await f.api('/api/export', { preset: 'png-seq', name: 'token', range: { in: 0, out: 1 } })).body
  await until(() => f.workers.length === 1)
  const token = new URL(f.workers[0].argv.at(-1)).searchParams.get('id')
  const stale = await f.api('/api/events?role=worker&worker=00000000-0000-4000-8000-000000000000')
  assert.equal(stale.status, 204, 'an EventSource stops reconnecting on 204')
  assert.equal((await f.api('/api/state')).body.worker, false)
  const request = http.get({ hostname: '127.0.0.1', port: f.port, path: `/api/events?role=worker&worker=${token}`, headers: { host: '127.0.0.1:0' } })
  const [response] = await once(request, 'response'); t.after(() => request.destroy())
  assert.equal(response.statusCode, 200)
  await until(() => true); assert.equal((await f.api('/api/state')).body.worker, true)
  await f.api('/api/jobs/cancel', { id: job.id }); await f.api(`/api/job/${job.id}/drained`, {})
})

test('a job that has not reached the worker says why it is waiting', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const first = (await f.api('/api/export', { preset: 'png-seq', name: 'first', range: { in: 0, out: 1 } })).body
  const second = (await f.api('/api/export', { preset: 'png-seq', name: 'second', range: { in: 0, out: 1 } })).body
  const read = async id => (await f.api('/api/jobs')).body.jobs.find(j => j.id === id)
  // No worker page is connected yet: the first job has the queue and waits for the worker.
  const deadline = Date.now() + 10000
  while ((await read(first.id)).waiting?.reason !== 'worker-starting') { assert.ok(Date.now() < deadline, 'the first job must report the worker start'); await new Promise(resolve => setTimeout(resolve, 20)) }
  const behind = (await read(second.id)).waiting
  assert.equal(behind.reason, 'behind-job'); assert.equal(behind.job, first.id); assert.ok(Number.isFinite(behind.since))
  assert.ok(Number.isFinite((await read(first.id)).sourceCopyMs), 'the source copy time is recorded')
  const connection = await f.worker()
  await until(() => connection.events.some(event => event.type === 'render'))
  assert.equal('waiting' in connection.events.find(event => event.type === 'render').data.job, false, 'the dispatched job waits for nothing')
  assert.equal((await read(first.id)).waiting, undefined)
  assert.equal((await read(second.id)).waiting.job, first.id)
  await f.api('/api/jobs/cancel', { id: first.id }); await f.api(`/api/job/${first.id}/drained`, {})
  await until(() => connection.events.filter(event => event.type === 'render').length === 2)
  assert.equal((await read(second.id)).waiting, undefined)
  await f.api('/api/jobs/cancel', { id: second.id }); await f.api(`/api/job/${second.id}/drained`, {})
})

test('a second export of the same media reuses the audio the first one decoded', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const connection = await (async () => { const pending = f.api('/api/export', { preset: 'png-seq', name: 'one', range: { in: 0, out: 1 } }); const value = await f.worker(); value.first = (await pending).body; return value })()
  await until(() => connection.events.some(event => event.type === 'render'))
  const copyOf = id => connection.events.find(event => event.type === 'render' && event.data.job.id === id).data.project.tracks[0].clips[0].src
  const first = connection.first, firstCopy = copyOf(first.id)
  const decoded = f.api(`/api/audio?src=${encodeURIComponent(firstCopy)}&in=0&dur=1&processingJob=${first.id}`)
  await until(() => f.children.length === 1)
  fs.writeFileSync(f.children[0].argv.at(-1), 'decoded once'); f.children[0].emit('close', 0)
  assert.equal((await decoded).status, 200)
  await f.api('/api/jobs/cancel', { id: first.id }); await f.api(`/api/job/${first.id}/drained`, {})
  const second = (await f.api('/api/export', { preset: 'png-seq', name: 'two', range: { in: 0, out: 1 } })).body
  await until(() => connection.events.some(event => event.type === 'render' && event.data.job.id === second.id))
  const secondCopy = copyOf(second.id)
  assert.notEqual(secondCopy, firstCopy, 'every export reads its own copy of the source')
  const reused = await f.api(`/api/audio?src=${encodeURIComponent(secondCopy)}&in=0&dur=1&processingJob=${second.id}`)
  assert.equal(reused.status, 200); assert.equal(reused.body.toString(), 'decoded once')
  assert.equal(f.children.length, 1, 'the second export must not decode the same bytes again')
  assert.equal(fs.readdirSync(path.join(f.root, '.reel', 'cache', 'audio')).filter(name => name.endsWith('.wav')).length, 1, 'and it must not add a cache file')
  await f.api('/api/jobs/cancel', { id: second.id }); await f.api(`/api/job/${second.id}/drained`, {})
})

test('16 filmstrips asked for at once all arrive, an export still gets a slot, and a cached strip needs none', { timeout: 30000 }, async t => {
  const f = await fixture(t, { sources: 16 })
  const strip = index => f.api(`/api/strip?src=${encodeURIComponent(`media/import-${index}.mp4`)}&quality=high`)
  const pending = Array.from({ length: 16 }, (_, index) => strip(index))
  await until(() => f.children.length === 1)
  // The import is still in progress: 1 strip runs, 3 wait in the processing queue, 12 wait in front of it.
  const during = (await f.api('/api/state')).body.processing
  assert.equal(during.active + during.queued, 4)
  const exported = await f.api('/api/export', { preset: 'png-seq', name: 'during-import', range: { in: 0, out: 1 } })
  assert.equal(exported.status, 200, 'an export started during the import is admitted')
  await f.api('/api/jobs/cancel', { id: exported.body.id })
  // Each ffmpeg run writes its filmstrip and exits.
  let served = 0
  const serve = setInterval(() => { for (; served < f.children.length; served++) { const child = f.children[served]; fs.writeFileSync(child.argv.at(-1), `strip ${served}`); child.emit('close', 0) } }, 5)
  t.after(() => clearInterval(serve))
  const answers = await Promise.all(pending)
  assert.deepEqual(answers.map(answer => answer.status), Array(16).fill(200))
  assert.equal(new Set(answers.map(answer => answer.body.url)).size, 16)
  assert.equal(f.children.length, 16)
  clearInterval(serve)
  // An export now holds the queue (it waits for a worker page). A strip that is cached still answers.
  const holding = (await f.api('/api/export', { preset: 'png-seq', name: 'holding', range: { in: 0, out: 1 } })).body
  await until(() => f.workers.length === 1)
  const cached = await strip(3)
  assert.equal(cached.status, 200); assert.equal(cached.body.url, answers[3].body.url)
  assert.equal(f.children.length, 16, 'and it starts no ffmpeg')
  await f.api('/api/jobs/cancel', { id: holding.id })
})

test('stopping worker connections cannot advertise replacement readiness', () => {
  const old = {}, replacement = {}, closed = []
  const oldClient = { role: 'worker', worker: old, res: { end: () => closed.push('old') } }
  const nextClient = { role: 'worker', worker: replacement, res: { end: () => closed.push('next') } }
  const clients = new Set([oldClient, nextClient, { role: 'ui' }])
  assert.equal(processingWorkerConnected(old, clients), true)
  old.processingStopping = true
  assert.equal(processingWorkerConnected(old, clients), false)
  assert.equal(processingWorkerConnected(null, clients), false)
  retireProcessingWorkerClients(clients, old)
  assert.deepEqual(closed, ['old']); assert.equal(clients.has(nextClient), true)
  assert.equal(processingWorkerConnected(replacement, clients), true)
})

test('a throwing retired subscriber cannot prevent the other worker clients from closing', () => {
  const worker = {}, closed = []
  const clients = new Set([{ role: 'worker', worker, res: { end: () => { throw new Error('closed socket') } } }, { role: 'worker', worker, res: { end: () => closed.push('closed') } }])
  assert.doesNotThrow(() => retireProcessingWorkerClients(clients, worker))
  assert.equal(clients.size, 0); assert.deepEqual(closed, ['closed'])
})


test('audio ranges ignore legacy cross-platform cache entries', async t => {
  const f = await fixture(t)
  const source = path.join(f.root, 'media', 'source.mp4'), stat = fs.statSync(source)
  const key = createHash('sha1').update([source, stat.size, stat.mtimeMs, 'wav', '0.000', '1.000'].join('|')).digest('hex').slice(0, 16)
  const legacy = path.join(f.root, '.reel', 'cache', 'audio', `${key}.wav`)
  fs.mkdirSync(path.dirname(legacy), { recursive: true })
  fs.writeFileSync(legacy, 'legacy native level')
  let reply
  const pending = f.api('/api/audio?src=media%2Fsource.mp4&in=0&dur=1').then(value => { reply = value; return value })
  await until(() => f.children.length || reply)
  assert.equal(f.children.length, 1, 'The decoder must run instead of serving a legacy derivative')
  const encoder = f.children[0]
  fs.writeFileSync(encoder.argv.at(-1), 'fresh browser level')
  encoder.emit('close', 0)
  const response = await pending
  assert.equal(response.status, 200)
  assert.equal(response.body.toString(), 'fresh browser level')
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy native level')
  assert.equal(fs.readFileSync(source, 'utf8'), 'source')
})
