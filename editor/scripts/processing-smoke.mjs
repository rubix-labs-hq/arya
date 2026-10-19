// Exercise processing and export over HTTP with deterministic disposable media.
// Requires ffmpeg, ffprobe, and the Chrome worker used by server.mjs.

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyOps, findClip } from '../core/project.js'

const EDITOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = fs.mkdtempSync('/private/tmp/reel-processing-smoke-')
const RATE = 48000
const WIDTH = 320
const HEIGHT = 180
const KEEP = process.argv.includes('--keep')
const SELECT = process.argv.find(a => a.startsWith('--case='))?.slice(7)
let BASE
let denoised

function ff(args, options = {}) {
  return execFileSync('ffmpeg', ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 128e6, ...options })
}

function probe(rel) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(ROOT, rel)], { encoding: 'utf8' }))
}

function pcm(rel, options = []) {
  const bytes = ff([...options, '-i', path.join(ROOT, rel), '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'])

  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
}

function rms(samples, from = 0, to = samples.length / RATE) {
  let sum = 0
  const A = Math.floor(from * RATE)
  const B = Math.min(samples.length, Math.floor(to * RATE))
  for (let i = A; i < B; i++) sum += samples[i] ** 2

  return Math.sqrt(sum / (B - A))
}

function lufs(rel, options = []) {
  const { stderr } = spawnResult('ffmpeg', ['-nostdin', '-hide_banner', ...options, '-i', path.join(ROOT, rel), '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'])
  const match = /I:\s*([-\d.]+) LUFS/.exec(stderr.split('Summary:').pop())
  assert.ok(match, 'ffmpeg reported integrated loudness')

  return Number(match[1])
}

function spawnResult(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128e6 })
  if (result.error || result.status !== 0) throw new Error(`${command}: ${String(result.stderr || result.error?.message).slice(-1500)}`)

  return result
}

function near(actual, expected, tolerance, message) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`)
}

function random(seed) {
  let state = seed >>> 0

  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 31 - 1 }
}

function writeWav(rel, samples) {
  const raw = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)
  ff(['-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0', '-c:a', 'pcm_s24le', path.join(ROOT, rel)], { input: raw })
}

function makeMedia() {
  fs.mkdirSync(path.join(ROOT, 'media'), { recursive: true })
  const noise = random(17)
  const audio = Float32Array.from({ length: RATE * 5 }, (_, i) => {
    const t = i / RATE

    return 0.002 * noise() + (t >= 1 && t < 4 ? 0.08 * Math.sin(2 * Math.PI * 440 * t) : 0)
  })
  writeWav('media/noisy.wav', audio)
  const events = random(73)
  writeWav('media/sync-master.wav', Float32Array.from({ length: RATE * 5 }, (_, i) => {
    const t = i / RATE
    const pulse = Math.abs(t - 1.3) < 0.08 || Math.abs(t - 2.2) < 0.04 || Math.abs(t - 3.6) < 0.12 ? 0.35 : 0.03

    return 0.09 * events() + pulse * Math.sin(2 * Math.PI * (400 * t + 30 * t * t))
  }))
  for (const [i, start] of [0.3, 0.8, 0].entries()) {
    ff(['-ss', String(start), '-t', '3.5', '-i', path.join(ROOT, 'media/sync-master.wav'), ...(i === 2 ? ['-af', 'volume=-0.7'] : []), '-c:a', 'pcm_s24le', path.join(ROOT, `media/cam${i}.wav`)])
  }
  const margin = 24
  const tw = WIDTH + margin * 2
  const th = HEIGHT + margin * 2
  const textureNoise = random(31)
  const noiseField = Uint8Array.from({ length: tw * th }, () => Math.round(128 + 110 * textureNoise()))
  const texture = new Uint8Array(tw * th)
  for (let y = 1; y < th - 1; y++) for (let x = 1; x < tw - 1; x++) {
    const i = y * tw + x
    texture[i] = Math.round((noiseField[i] * 4 + noiseField[i - 1] + noiseField[i + 1] + noiseField[i - tw] + noiseField[i + tw]) / 8)
  }
  const frames = Buffer.alloc(WIDTH * HEIGHT * 3 * 60)
  for (let k = 0; k < 60; k++) {
    const dx = Math.round(7 * Math.sin(k * 2.1) + 2 * Math.sin(k * 0.53))
    const dy = Math.round(5 * Math.sin(k * 1.9))
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const gray = texture[(y + margin + dy) * tw + x + margin + dx]
      const i = (k * WIDTH * HEIGHT + y * WIDTH + x) * 3
      frames[i] = gray
      frames[i + 1] = Math.round(gray * 0.8)
      frames[i + 2] = Math.min(255, Math.round(gray * 1.1))
    }
  }
  ff(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${WIDTH}x${HEIGHT}`, '-r', '30', '-i', 'pipe:0', '-i', path.join(ROOT, 'media/noisy.wav'), '-t', '2', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', path.join(ROOT, 'media/shaky.mp4')], { input: frames })
}

async function request(route, body) {
  const res = await fetch(`${BASE}${route}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw new Error(`${route}: ${data.error}`)

  return data
}

async function scene(ops) {
  await request('/api/new', { name: 'Processing smoke', width: WIDTH, height: HEIGHT, fps: 30 })
  await request('/api/ops', { ops, returnProject: false })

  return request('/api/project')
}

async function waitJob(job, analysis = false) {
  const until = Date.now() + 60000
  while (job.state === 'running' || job.state === 'queued') {
    if (Date.now() >= until) {
      await request(`${analysis ? '/api/analysis' : '/api'}/jobs/cancel`, { id: job.id })
      throw new Error(`${job.kind} job exceeded its timeout`)
    }
    job = await request(`${analysis ? '/api/analysis' : '/api'}/jobs/wait?id=${job.id}&timeout=10000`)
  }
  assert.equal(job.state, 'done', `${job.kind} job: ${job.error ?? job.state}`)
  assert.equal(job.progress, 1)
  assert.ok(!job.applyError, job.applyError)

  return job
}

// A processed copy is saved in Media, then placed. One undo removes the placement and keeps
// the copy in Media; a second undo restores the project as it was before processing.
async function undoPlacementThenMedia(before, output, original) {
  const unplaced = (await request('/api/undo', {})).project
  assert.equal(findClip(unplaced, 'c1').clip.src, original, 'one undo restores the original clip')
  assert.ok(unplaced.assets[output], 'the processed copy stays in Media after its placement is undone')
  assert.deepEqual((await request('/api/undo', {})).project, before.project, 'a second undo restores the project before processing')
}

function mediaAssertions(rel, duration, width = WIDTH, height = HEIGHT) {
  const info = probe(rel)
  const video = info.streams.find(s => s.codec_type === 'video')
  const audio = info.streams.find(s => s.codec_type === 'audio')
  assert.equal(video?.codec_name, 'h264')
  assert.equal(video.width, width)
  assert.equal(video.height, height)
  near(Number(info.format.duration), duration, 0.07, `${rel} duration`)
  assert.equal(audio?.codec_name, 'aac')
  assert.ok(rms(pcm(rel)) > 0.01, `${rel} contains real audio`)

  return info
}

function displacementSpread(rel, from, dur) {
  const bytes = ff(['-ss', String(from), '-t', String(dur), '-i', path.join(ROOT, rel), '-an', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'])
  const size = WIDTH * HEIGHT
  const count = Math.floor(bytes.length / size)
  const positions = []
  for (let frame = 1; frame < count; frame++) {
    let best = Infinity
    let pose
    for (let dy = -20; dy <= 20; dy++) for (let dx = -20; dx <= 20; dx++) {
      let error = 0
      for (let y = 48; y < 132; y += 4) for (let x = 96; x < 224; x += 4) {
        const delta = bytes[y * WIDTH + x] - bytes[frame * size + (y + dy) * WIDTH + x + dx]
        error += delta * delta
      }
      if (error < best) { best = error; pose = [dx, dy] }
    }
    positions.push(pose)
  }
  assert.ok(positions.length >= 15, 'enough frames to measure stabilization')
  const mean = [0, 1].map(i => positions.reduce((sum, p) => sum + p[i], 0) / positions.length)

  return Math.sqrt(positions.reduce((sum, p) => sum + (p[0] - mean[0]) ** 2 + (p[1] - mean[1]) ** 2, 0) / positions.length)
}

const cases = {
  async clean() {
    // Cleanup registers its output in Media, so it needs an open project.
    await request('/api/new', { name: 'Processing smoke', width: WIDTH, height: HEIGHT, fps: 30 })
    const original = pcm('media/noisy.wav')
    for (const mode of ['denoise', 'voice']) {
      const clean = await request('/api/audio/clean', { src: 'media/noisy.wav', mode })
      const info = probe(clean.path)
      assert.equal(info.streams[0].codec_name, 'pcm_s24le')
      assert.equal(clean.asset.hasAudio, true)
      assert.equal(clean.asset.hasVideo, false)
      near(Number(info.format.duration), 5, 0.01, `${mode} duration`)
      const processed = pcm(clean.path)
      const quiet = rms(processed, 0.2, 0.8)
      const before = rms(original, 0.2, 0.8)
      assert.ok(quiet < before * 0.8, `${mode} reduces noise: ${quiet} vs ${before}`)
      assert.ok(rms(processed, 1.5, 3.5) > 0.01, `${mode} retains the signal`)
      const cached = await request('/api/audio/clean', { src: 'media/noisy.wav', mode })
      assert.equal(cached.cached, true)
      assert.equal(cached.path, clean.path)
      console.log(`${mode} quiet RMS ${before.toFixed(6)} to ${quiet.toFixed(6)}`)
      if (mode === 'denoise') denoised = clean.path
    }
    const before = await scene([{ op: 'append', src: 'media/noisy.wav', track: 'A1', in: 1, dur: 2 }])
    const cleaned = await request('/api/audio/clean', { src: 'media/noisy.wav', mode: 'voice', id: 'c1' })
    const after = await request('/api/project')
    assert.equal(cleaned.applied, true, cleaned.applyError ?? cleaned.registrationError)
    assert.equal(after.version, before.version + 2, 'saving to Media and placing are two edits')
    const clip = findClip(after.project, 'c1').clip
    assert.equal(clip.src, cleaned.path)
    assert.equal(clip.in, 1)
    assert.equal(clip.dur, 2)
    assert.equal(after.project.assets[cleaned.path].hasAudio, true)
    assert.equal(after.project.assets[cleaned.path].hasVideo, false)
    const appended = applyOps(after.project, [{ op: 'append', src: cleaned.path, track: 'A2', dur: 0.2 }])
    assert.equal(findClip(appended.project, appended.created[0]).clip.kind, 'audio', 'cleaned asset infers an audio clip')
    await undoPlacementThenMedia(before, cleaned.path, 'media/noisy.wav')
  },
  async loudnorm() {
    const before = await scene([{ op: 'append', src: 'media/noisy.wav', track: 'A1', in: 1, dur: 2 }])
    const result = await request('/api/audio/loudnorm', { src: 'media/noisy.wav', target: -23, in: 1, dur: 2, id: 'c1' })
    const actualInput = lufs('media/noisy.wav', ['-ss', '1', '-t', '2'])
    near(result.input.i, actualInput, 0.1, 'loudnorm input measurement')
    near(result.output.i, -23, 0.5, 'loudnorm second-pass measurement')
    assert.equal(result.linear, true)
    assert.equal(result.peakOver, 0)
    ff(['-ss', '1', '-t', '2', '-i', path.join(ROOT, 'media/noisy.wav'), '-af', `volume=${result.gain}dB`, '-c:a', 'pcm_s24le', path.join(ROOT, 'media/normalized.wav')])
    near(lufs('media/normalized.wav'), -23, 0.2, 'reported gain produces the target loudness')
    assert.equal(findClip((await request('/api/project')).project, 'c1').clip.volume, Math.round(result.gain * 10) / 10)
    assert.deepEqual((await request('/api/undo', {})).project, before.project)
    console.log(`loudnorm ${actualInput} LUFS, gain ${result.gain} dB, measured ${lufs('media/normalized.wav')} LUFS`)
  },
  async multicam() {
    const result = await request('/api/multicam/sync', { srcs: ['media/cam0.wav', 'media/cam1.wav', 'media/cam2.wav'], rate: 8000, window: 2, maxSeconds: 7 })
    result.offsets.forEach((value, i) => near(value, [0.5, 0, 0.8][i], 1 / 30, `multicam offset ${i}`))
    result.lags.forEach((value, i) => near(value, [0, -0.5, 0.3][i], 1 / 30, `multicam lag ${i}`))
    assert.ok(result.confidence.every(v => v > 0.85), `confidence ${result.confidence}`)
    assert.equal(result.inverted[2], true)
    assert.deepEqual(result.warnings, [])
    console.log(`multicam offsets ${result.offsets}, confidence ${result.confidence}`)
  },
  async stabilize() {
    const before = await scene([{ op: 'append', src: 'media/shaky.mp4', track: 'V1', audio: false, in: 0.5, dur: 1 }])
    const job = await waitJob(await request('/api/stabilize/render', { src: 'media/shaky.mp4', in: 0.5, dur: 1, clip: 'c1', zoom: 1 }), true)
    mediaAssertions(job.output, 1)
    assert.equal(job.applied, true)
    assert.ok(job.version > before.version)
    const project = (await request('/api/project')).project
    const clip = findClip(project, 'c1').clip
    assert.equal(clip.src, job.output)
    assert.equal(clip.in, 0)
    assert.equal(clip.dur, 1)
    assert.equal(clip.deshake.src, 'media/shaky.mp4')
    assert.equal(project.assets[job.output].hasAudio, true)
    const inputShake = displacementSpread('media/shaky.mp4', 0.5, 1)
    const outputShake = displacementSpread(job.output, 0, 1)
    assert.ok(outputShake < inputShake * 0.8, `stabilization reduces displacement: ${outputShake} vs ${inputShake}`)
    await undoPlacementThenMedia(before, job.output, 'media/shaky.mp4')
    await request('/api/redo', {})
    assert.equal(findClip((await request('/api/redo', {})).project, 'c1').clip.src, job.output)
    console.log(`stabilize displacement RMS ${inputShake.toFixed(2)} to ${outputShake.toFixed(2)} px`)
  },
  async retime() {
    const before = await scene([{ op: 'append', src: 'media/shaky.mp4', track: 'V1', audio: false, in: 0.5, dur: 1 }])
    const job = await waitJob(await request('/api/retime', { src: 'media/shaky.mp4', in: 0.5, dur: 1, speed: 0.5, fps: 30, clip: 'c1' }), true)
    const info = mediaAssertions(job.output, 2)
    near(Number(info.streams.find(s => s.codec_type === 'video').nb_frames), 60, 1, 'retime output frame count')
    const project = (await request('/api/project')).project
    const clip = findClip(project, 'c1').clip
    assert.equal(clip.src, job.output)
    assert.equal(clip.in, 0)
    assert.equal(clip.speed, 1)
    assert.equal(clip.dur, 2)
    assert.equal(clip.retime.src, 'media/shaky.mp4')
    assert.equal(clip.retime.speed, 0.5)
    assert.equal(project.assets[job.output].hasAudio, true)
    await undoPlacementThenMedia(before, job.output, 'media/shaky.mp4')
    await request('/api/redo', {})
    assert.equal(findClip((await request('/api/redo', {})).project, 'c1').clip.src, job.output)
    console.log(`retime ${info.streams.find(s => s.codec_type === 'video').nb_frames} frames, ${info.format.duration}s`)
  },
  async export() {
    denoised ??= (await request('/api/audio/clean', { src: 'media/noisy.wav', mode: 'denoise' })).path
    await scene([
      { op: 'append', src: 'media/shaky.mp4', track: 'V1', audio: false, in: 0.5, dur: 1, set: { mute: true } },
      { op: 'append', src: denoised, track: 'A1', in: 1, dur: 1 },
    ])
    await request('/api/audio/loudnorm', { src: denoised, target: -23, in: 1, dur: 1, id: 'c2' })
    const job = await waitJob(await request('/api/export', { preset: 'h264-high', name: 'processing-smoke', width: 160, height: 90, fps: 30, range: { in: 0, out: 1 } }))
    const output = path.join(ROOT, job.output)
    const hash = createHash('sha256').update(fs.readFileSync(output)).digest('hex')
    const info = mediaAssertions(job.output, 1, 160, 90)
    assert.equal(info.streams.find(s => s.codec_type === 'audio').channels, 2)
    near(lufs(job.output), -23, 0.6, 'exported mix has the normalized loudness')
    const rgb = ff(['-ss', '0.5', '-i', path.join(ROOT, job.output), '-an', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
    assert.equal(rgb.length, 160 * 90 * 3)
    assert.ok(Math.max(...rgb) - Math.min(...rgb) > 80, 'export contains decoded video texture')
    const completed = await request(`/api/jobs/wait?id=${job.id}&timeout=1000`)
    assert.equal(completed.state, 'done', 'a consumed export stays complete')
    assert.equal(completed.finished, job.finished, 'an export completes once')
    assert.equal(completed.output, job.output)
    assert.equal(createHash('sha256').update(fs.readFileSync(output)).digest('hex'), hash, 'a completed export stays unchanged while consumers decode it')
    assert.equal(fs.existsSync(path.join(ROOT, '.reel', `${job.id}.wav`)), false, 'completed export removes its temporary mix')
    console.log(`export h264 160x90, ${info.format.duration}s, stereo AAC, ${lufs(job.output)} LUFS`)
  },
}

if (SELECT && !Object.hasOwn(cases, SELECT)) throw new Error(`unknown processing smoke case: ${SELECT}`)
const reservation = net.createServer()
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
assert.notEqual(port, 4870)
BASE = `http://127.0.0.1:${port}`
makeMedia()
const server = spawn(process.execPath, [path.join(EDITOR, 'server.mjs'), '--root', ROOT, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
server.stdout.on('data', chunk => { log = (log + chunk).slice(-12000) })
server.stderr.on('data', chunk => { log = (log + chunk).slice(-12000) })
let failed = 0
try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}\n${log}`)
    try { if ((await fetch(`${BASE}/api/state`)).ok) { ready = true; break } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(ready, `server did not start\n${log}`)
  for (const [name, run] of Object.entries(cases)) {
    if (SELECT && name !== SELECT) continue
    try {
      await run()
      console.log(`ok ${name}`)
    } catch (error) {
      failed++
      console.error(`FAIL ${name}: ${error.message}`)
    }
  }
  console.log(`${Object.keys(cases).filter(name => !SELECT || name === SELECT).length - failed} passed, ${failed} failed`)
  if (failed) process.exitCode = 1
} finally {
  await request('/api/shutdown', {}).catch(() => {})
  await new Promise(resolve => {
    if (server.exitCode !== null) return resolve()
    const timeout = setTimeout(() => server.kill(), 2000)
    server.once('exit', () => { clearTimeout(timeout); resolve() })
  })
  if (KEEP) console.log(`artifacts ${ROOT}`)
  else fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
