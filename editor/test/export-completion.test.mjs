import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url))
const WIDTH = 16, HEIGHT = 16, FPS = 30

// These tests act as the renderer through SSE and frame/audio uploads. Keep the
// server's worker as an owned child, without launching a second renderer.
function fixtureServer(root, workerReady) {
  const workerFile = path.join(root, 'completion-worker.mjs')
  fs.writeFileSync(workerFile, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(workerReady)},JSON.stringify({pid:process.pid,parent:process.ppid}));process.on('disconnect',()=>process.exit(0));setInterval(()=>{},1000);\n`)
  let source = fs.readFileSync(SERVER, 'utf8')
  const spawnImport = "import { spawn } from 'node:child_process'"
  assert.equal(source.split(spawnImport).length, 2, 'the actual server has one process-launch import')
  source = source.replace(spawnImport, `import { spawn as realSpawn } from 'node:child_process'
function spawn(command, args, options) {
  if (command === CHROME) return realSpawn(process.execPath, [${JSON.stringify(workerFile)}], { ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  return realSpawn(command, args, options)
}`)
  const here = 'const HERE = path.dirname(fileURLToPath(import.meta.url))'
  assert.equal(source.split(here).length, 2, 'the copied server retains its actual route and asset directory')
  source = source.replace(here, `const HERE = ${JSON.stringify(path.dirname(SERVER))}`)
  source = source.replace(/^(import .+ from )'(\.\/?[^']+)'/gm, (_all, prefix, relative) => `${prefix}${JSON.stringify(new URL(relative, pathToFileURL(SERVER)).href)}`)
  const serverFile = path.join(root, 'completion-server.mjs')
  fs.writeFileSync(serverFile, source)
  return serverFile
}

async function startServer(t, { controlledEncoder = false, hardStopEncoder = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-export-completion-'))
  const workerReady = path.join(root, 'worker-started.json')
  const serverFile = fixtureServer(root, workerReady)
  const marker = path.join(root, 'encoder-finishing')
  const startedMarker = path.join(root, 'encoder-started'), release = path.join(root, 'encoder-release')
  const stopEncoder = path.join(root, 'encoder-stop'), encoderExited = path.join(root, 'encoder-exited')
  let env = process.env
  if (controlledEncoder) {
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'ffmpeg'), `#!${process.execPath}\nimport fs from 'node:fs';const out=process.argv.at(-1);fs.writeFileSync(out,'encoding');fs.watchFile(${JSON.stringify(release)},{interval:10},()=>{if(fs.existsSync(${JSON.stringify(release)}))fs.appendFileSync(out,'late write')});fs.watchFile(${JSON.stringify(stopEncoder)},{interval:10},()=>{if(fs.existsSync(${JSON.stringify(stopEncoder)}))process.exit(0)});process.on('exit',()=>fs.writeFileSync(${JSON.stringify(encoderExited)},'exited'));process.on('SIGTERM',()=>${hardStopEncoder ? "process.kill(process.pid,'SIGKILL')" : 'process.exit(0)'});if(fs.existsSync(${JSON.stringify(stopEncoder)}))process.exit(0);process.stdin.resume();process.stdin.once('end',()=>fs.writeFileSync(${JSON.stringify(marker)},'ready'));fs.writeFileSync(${JSON.stringify(startedMarker)},JSON.stringify({pid:process.pid,out}));\n`, { mode: 0o700 })
    env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }
  }
  const reservation = net.createServer()
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [serverFile, '--root', root, '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const connections = [], logWaiters = []
  let log = ''
  const capture = chunk => {
    log += chunk
    for (const waiter of logWaiters.splice(0)) {
      if (log.includes(waiter.text)) { clearTimeout(waiter.timer); waiter.resolve() }
      else logWaiters.push(waiter)
    }
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const serverLogged = text => {
    if (log.includes(text)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = { text, resolve, reject }
      waiter.timer = setTimeout(() => reject(new Error(`Missing server message ${text}: ${log}`)), 10000)
      logWaiters.push(waiter)
    })
  }
  const logged = async text => {
    await serverLogged(text)
    if (text === 'starting the render worker') {
      await fileAppears(workerReady)
      const worker = JSON.parse(fs.readFileSync(workerReady, 'utf8'))
      assert.equal(worker.parent, child.pid, 'the fixture worker belongs to this server child')
      assert.doesNotThrow(() => process.kill(worker.pid, 0), 'the owned worker child is alive before its SSE connection')
    }
  }
  t.after(async () => {
    for (const connection of connections) connection.destroy()
    for (const waiter of logWaiters) clearTimeout(waiter.timer)
    try {
      if (controlledEncoder && fs.existsSync(startedMarker) && !fs.existsSync(encoderExited)) {
        fs.writeFileSync(stopEncoder, 'stop owned fixture')
        const { pid } = JSON.parse(fs.readFileSync(startedMarker, 'utf8'))
        // Cancellation may use SIGKILL, which cannot run the fixture's exit handler.
        await processExited(pid)
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
    }
  })
  await logged('Reel editor at')
  const api = async (route, body, raw = false) => {
    const response = await fetch(base + route, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json' },
      body: raw ? body : JSON.stringify(body),
    })
    return { status: response.status, data: await response.json() }
  }
  async function worker() {
    const events = [], waiters = []
    const connection = http.get(base + '/api/events?role=worker')
    connections.push(connection)
    const response = await new Promise((resolve, reject) => { connection.once('response', resolve); connection.once('error', reject) })
    assert.equal(response.statusCode, 200)
    let buffer = ''
    response.setEncoding('utf8')
    response.on('data', chunk => {
      buffer += chunk
      for (let end; (end = buffer.indexOf('\n\n')) >= 0;) {
        const text = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const name = /^event: (.+)$/m.exec(text)?.[1], data = /^data: (.+)$/m.exec(text)?.[1]
        if (!name || !data) continue
        const event = { name, data: JSON.parse(data) }
        events.push(event)
        for (const waiter of waiters.splice(0)) {
          if (waiter.matches(event)) { clearTimeout(waiter.timer); waiter.resolve(event) }
          else waiters.push(waiter)
        }
      }
    })
    t.after(() => { for (const waiter of waiters) clearTimeout(waiter.timer) })
    const event = matches => {
      const found = events.find(matches)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        const waiter = { matches, resolve }
        waiter.timer = setTimeout(() => reject(new Error(`Missing worker event: ${JSON.stringify(events)}`)), 10000)
        waiters.push(waiter)
      })
    }
    await event(item => item.name === 'hello')
    return { events, event }
  }
  assert.equal((await api('/api/new', { name: 'Completion', width: WIDTH, height: HEIGHT, fps: FPS })).status, 200)
  return { root, api, worker, logged, marker, startedMarker, release }
}

async function processExited(pid) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') return; throw error }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Owned encoder ${pid} did not stop`)
}

async function fileAppears(file) {
  if (fs.existsSync(file)) return
  await new Promise((resolve, reject) => {
    fs.watchFile(file, { interval: 10 }, () => {
      if (fs.existsSync(file)) { fs.unwatchFile(file); clearTimeout(timer); resolve() }
    })
    const timer = setTimeout(() => { fs.unwatchFile(file); reject(new Error(`Encoder did not finish reading ${file}`)) }, 5000)
    if (fs.existsSync(file)) { fs.unwatchFile(file); clearTimeout(timer); resolve() }
  })
}

const spec = { preset: 'h264-high', name: 'completion', range: { in: 0, out: 1 / FPS } }
const upload = (server, id, action, body = Buffer.alloc(0)) => server.api(`/api/job/${id}/${action}`, body, true)
async function complete(server, worker, id) {
  await worker.event(event => event.name === 'render' && event.data.job.id === id)
  assert.equal((await upload(server, id, 'start')).status, 200)
  assert.equal((await upload(server, id, 'frames?done=1', Buffer.alloc(WIDTH * HEIGHT * 4, 128))).status, 200)
  assert.equal((await upload(server, id, 'done')).status, 200)
  await worker.event(event => event.name === 'job' && event.data.id === id && event.data.state === 'done')
  const { status, data } = await server.api(`/api/jobs/wait?id=${id}&timeout=1000`)
  assert.equal(status, 200)
  assert.equal(data.state, 'done')
  assert.equal(data.progress, 1)
  const output = path.join(server.root, data.output)
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' }))
  assert.equal(probe.streams[0].codec_name, 'h264')
  const frame = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', output, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
  assert.equal(frame.length, WIDTH * HEIGHT * 3)
  assert.equal((await upload(server, id, 'drained')).status, 200)
  return { job: data, output, hash: createHash('sha256').update(fs.readFileSync(output)).digest('hex') }
}

test('worker startup delivers one export and publishes a decodable file before done', { timeout: 15000 }, async t => {
  const server = await startServer(t)
  const exported = server.api('/api/export', spec)
  await server.logged('starting the render worker')
  const worker = await server.worker()
  const { status, data: job } = await exported
  assert.equal(status, 200)
  await worker.event(event => event.name === 'render' && event.data.job.id === job.id)
  await complete(server, worker, job.id)
  assert.equal(worker.events.filter(event => event.name === 'render' && event.data.job.id === job.id).length, 1, 'connection replay and explicit dispatch cannot deliver the same export twice')
  assert.equal(worker.events.filter(event => event.name === 'job' && event.data.id === job.id && event.data.state === 'done').length, 1)
})

test('late worker uploads and cancellation cannot reopen or change a completed export', { timeout: 15000 }, async t => {
  const server = await startServer(t)
  const exported = server.api('/api/export', spec)
  await server.logged('starting the render worker')
  const worker = await server.worker()
  const { status, data: job } = await exported
  assert.equal(status, 200)
  const completed = await complete(server, worker, job.id)
  for (const [action, body] of [
    ['audio', Buffer.from('stale audio')], ['start', Buffer.alloc(0)],
    ['frames?done=1', Buffer.alloc(WIDTH * HEIGHT * 4, 64)], ['done', Buffer.alloc(0)],
    ['fail', Buffer.from(JSON.stringify({ error: 'stale worker failure' }))],
  ]) {
    const response = await upload(server, job.id, action, body)
    assert.equal(response.status, 410, `${action} rejects uploads to a terminal job`)
  }
  assert.equal((await server.api('/api/jobs/cancel', { id: job.id })).status, 200)
  const { data: current } = await server.api(`/api/jobs/wait?id=${job.id}&timeout=1000`)
  assert.equal(current.state, 'done')
  assert.equal(current.finished, completed.job.finished)
  assert.equal(current.output, completed.job.output)
  assert.equal(createHash('sha256').update(fs.readFileSync(completed.output)).digest('hex'), completed.hash)
  assert.equal(fs.existsSync(path.join(server.root, '.reel', `${job.id}.wav`)), false, 'late audio cannot recreate the completed job mix')
  assert.equal(worker.events.filter(event => event.name === 'job' && event.data.id === job.id && event.data.state === 'done').length, 1)
})

test('cancellation during encoder shutdown cannot publish a completed export after a zero exit', { timeout: 15000 }, async t => {
  const server = await startServer(t, { controlledEncoder: true })
  const exported = server.api('/api/export', spec)
  await server.logged('starting the render worker')
  const worker = await server.worker()
  const { status, data: job } = await exported
  assert.equal(status, 200)
  await worker.event(event => event.name === 'render' && event.data.job.id === job.id)
  assert.equal((await upload(server, job.id, 'start')).status, 200)
  assert.equal((await upload(server, job.id, 'frames?done=1', Buffer.alloc(WIDTH * HEIGHT * 4, 128))).status, 200)
  const finishing = upload(server, job.id, 'done')
  await fileAppears(server.marker)
  const before = (await server.api('/api/jobs')).data.jobs.find(item => item.id === job.id)
  assert.equal(before.state, 'running')
  assert.equal(before.output, undefined, 'encoder shutdown must finish before publication')
  assert.equal((await upload(server, job.id, 'start')).status, 409)
  assert.equal((await upload(server, job.id, 'done')).status, 409)
  assert.equal((await upload(server, job.id, 'frames?done=1', Buffer.alloc(WIDTH * HEIGHT * 4, 64))).status, 409)
  assert.equal((await server.api('/api/jobs/cancel', { id: job.id })).status, 200)
  assert.equal((await finishing).status, 410)
  const { data: cancelled } = await server.api(`/api/jobs/wait?id=${job.id}&timeout=1000`)
  assert.equal(cancelled.state, 'failed')
  assert.equal(cancelled.error, 'cancelled')
  assert.equal(cancelled.output, undefined)
  assert.equal(cancelled.finished, undefined)
  await worker.event(event => event.name === 'job' && event.data.id === job.id && event.data.state === 'failed')
  assert.equal(worker.events.some(event => event.name === 'job' && event.data.id === job.id && event.data.state === 'done'), false)
  assert.equal((await upload(server, job.id, 'drained')).status, 200)
})

test('audio-only cancellation stops its encoder before any further destination write', { timeout: 15000 }, async t => {
  // A forceful encoder exit cannot write encoder-exited. Cleanup must still finish.
  const server = await startServer(t, { controlledEncoder: true, hardStopEncoder: true })
  const exported = server.api('/api/export', { ...spec, preset: 'audio-wav' })
  await server.logged('starting the render worker')
  const worker = await server.worker()
  const { status, data: job } = await exported
  assert.equal(status, 200)
  await worker.event(event => event.name === 'render' && event.data.job.id === job.id)
  assert.equal((await upload(server, job.id, 'audio', Buffer.from('controlled audio mix'))).status, 200)
  assert.equal((await upload(server, job.id, 'start')).status, 200)
  const finishing = upload(server, job.id, 'done')
  await fileAppears(server.startedMarker)
  const { pid, out } = JSON.parse(fs.readFileSync(server.startedMarker, 'utf8'))
  assert.equal((await server.api('/api/jobs/cancel', { id: job.id })).status, 200)
  const result = await finishing
  assert.equal(result.status, 410)
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'the owned audio encoder has exited')
  const before = fs.readFileSync(out)
  fs.writeFileSync(server.release, 'release destination writer')
  assert.deepEqual(fs.readFileSync(out), before, 'the cancelled encoder cannot write after release')
  const { data: cancelled } = await server.api(`/api/jobs/wait?id=${job.id}&timeout=1000`)
  assert.equal(cancelled.state, 'failed')
  assert.equal(cancelled.error, 'cancelled')
  assert.equal(cancelled.output, undefined)
  assert.equal(fs.existsSync(path.join(server.root, '.reel', `${job.id}.wav`)), false)
  await worker.event(event => event.name === 'job' && event.data.id === job.id && event.data.state === 'failed')
  assert.equal(worker.events.some(event => event.name === 'job' && event.data.id === job.id && event.data.state === 'done'), false)
  assert.equal((await upload(server, job.id, 'drained')).status, 200)
})

test('audio-only exports complete with real WAV and AAC encoders', { timeout: 15000 }, async t => {
  const server = await startServer(t)
  const mix = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.1', '-ac', '2', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'])
  let worker
  for (const [preset, codec] of [['audio-wav', 'pcm_s24le'], ['audio-m4a', 'aac']]) {
    const exported = server.api('/api/export', { ...spec, name: preset, preset, range: { in: 0, out: 0.1 } })
    if (!worker) {
      await server.logged('starting the render worker')
      worker = await server.worker()
    }
    const { status, data: job } = await exported
    assert.equal(status, 200)
    await worker.event(event => event.name === 'render' && event.data.job.id === job.id)
    assert.equal((await upload(server, job.id, 'audio', mix)).status, 200)
    assert.equal((await upload(server, job.id, 'start')).status, 200)
    assert.equal((await upload(server, job.id, 'done')).status, 200)
    assert.equal((await upload(server, job.id, 'drained')).status, 200)
    const { data: done } = await server.api(`/api/jobs/wait?id=${job.id}&timeout=1000`)
    assert.equal(done.state, 'done')
    assert.equal(done.progress, 1)
    const output = path.join(server.root, done.output)
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' }))
    assert.equal(probe.streams[0].codec_name, codec)
    assert.equal(probe.streams[0].channels, 2)
    const samples = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', output, '-f', 'f32le', 'pipe:1'])
    assert.ok(samples.length > 0, `${preset} has decoded audio`)
    assert.equal(fs.existsSync(path.join(server.root, '.reel', `${job.id}.wav`)), false)
  }
  assert.equal(worker.events.some(event => event.name === 'job' && event.data.state === 'failed'), false)
})

test('exports preserve referenced media and reject linked image sequence destinations', { timeout: 15000 }, async t => {
  const server = await startServer(t), worker = await server.worker()
  const source = 'renders/source.mp4', sourceFile = path.join(server.root, source)
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true })
  fs.writeFileSync(sourceFile, 'referenced source bytes')
  assert.equal((await server.api('/api/ops', { ops: [{ op: 'import', assets: { [source]: { duration: 1, width: WIDTH, height: HEIGHT, hasVideo: true } } }] })).status, 200)
  const before = (await server.api('/api/project')).data
  const overwritten = await server.api('/api/export', { ...spec, out: source })
  assert.equal(overwritten.status, 500)
  assert.match(overwritten.data.error, /source|referenced|media/i)
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), 'referenced source bytes')
  assert.deepEqual((await server.api('/api/project')).data.project, before.project)
  const sequence = path.join(server.root, 'renders', 'sequence-frames')
  fs.mkdirSync(sequence)
  const original = path.join(server.root, 'untouched-image.png')
  fs.writeFileSync(original, 'original image bytes')
  fs.symlinkSync(original, path.join(sequence, 'frame_00001.png'))
  // An explicit destination is never renamed, so a linked sequence folder is still refused.
  const linked = await server.api('/api/export', { ...spec, out: 'renders/sequence-frames/frame_%05d.png', preset: 'png-seq' })
  assert.equal(linked.status, 500)
  assert.match(linked.data.error, /symbolic links|symlink/i)
  assert.equal(fs.readFileSync(original, 'utf8'), 'original image bytes')
  assert.equal(worker.events.filter(event => event.name === 'render').length, 0)
  // A name whose folder exists gets the next free number and leaves the linked folder alone.
  const numbered = await server.api('/api/export', { ...spec, name: 'sequence', preset: 'png-seq' })
  assert.equal(numbered.status, 200)
  assert.equal(path.relative(server.root, numbered.data.spec.out), path.join('renders', 'sequence-2-frames', 'frame_%05d.png'))
  assert.equal(fs.readFileSync(original, 'utf8'), 'original image bytes')
})
