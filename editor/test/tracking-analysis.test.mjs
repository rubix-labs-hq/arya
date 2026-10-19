import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import trackingRoutes, { stabilizationPlan, trackOps } from '../routes/tracking.mjs'
import { runProcessingProcess } from '../core/processing-process.mjs'
import { applyOps, newProject } from '../core/project.js'

const hasFFmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()

// A synthetic 2-second clip: a white square moving right 40 px per second over gray.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-tracking-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'media'))
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x404040:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=white:s=40x40:r=30:d=2', '-filter_complex', "[0][1]overlay=x='60+40*t':y=70,drawbox=x=250:y=20:w=30:h=30:color=0x909090:t=fill",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(root, 'media', 'moving.mp4')])
  let project = newProject('Tracking', { width: 320, height: 180, fps: 30 })
  project.assets['media/moving.mp4'] = { duration: 2, width: 320, height: 180, fps: 30, hasVideo: true, hasAudio: false }
  project = applyOps(project, [{ op: 'append', src: 'media/moving.mp4', track: 'V1', dur: 2, audio: false }]).project
  const edits = []
  const routes = trackingRoutes({
    getProject: () => project, getVersion: () => 7, resolveMedia: rel => path.join(root, rel), probe: async () => { throw new Error('not probed') },
    run: (command, argv, options) => runProcessingProcess(command, argv, options),
    editOps: async (ops, who, summary, options) => { edits.push({ ops, who, summary, options }); project = applyOps(project, ops).project; return { version: 8 } },
  }).routes
  return { routes, edits, get project() { return project } }
}

test('server tracking follows a moving square and returns the native response shape with keyframe ops', { skip: !hasFFmpeg && 'ffmpeg is not installed' }, async t => {
  const f = fixture(t)
  const result = await f.routes['POST /api/analysis/track']({ clip: 'c1', rect: { x: 60 / 320, y: 70 / 180, width: 40 / 320, height: 40 / 180 }, fps: 10, dur: 1.5 })
  assert.equal(result.kind, 'track'); assert.equal(result.width, 320); assert.equal(result.height, 180)
  assert.equal(result.lostAt, undefined)
  assert.equal(result.samples.length, 16)
  const first = result.samples[0], last = result.samples.at(-1)
  assert.ok(Math.abs(first.x - 79.5) < 2 && Math.abs(first.y - 89.5) < 2, JSON.stringify(first))
  assert.ok(Math.abs(last.x - first.x - 60) < 4, `moved ${last.x - first.x} px in 1.5 s`)
  assert.ok(Math.abs(last.y - first.y) < 2)
  assert.ok(result.samples.every(sample => sample.confidence >= 0.5))
  const xKeys = result.ops.filter(op => op.op === 'keyframe' && op.prop === 'x')
  assert.deepEqual(result.ops.slice(0, 1), [{ op: 'clear_keyframes', id: 'c1', prop: 'x' }])
  assert.ok(xKeys.length >= 2 && xKeys.at(-1).value - xKeys[0].value > 55)
  assert.equal(f.edits.length, 0, 'tracking without apply changes nothing')
  const applied = await f.routes['POST /api/analysis/track']({ clip: 'c1', rect: { x: 60 / 320, y: 70 / 180, width: 40 / 320, height: 40 / 180 }, fps: 10, dur: 1, apply: true, expectedVersion: 7 })
  assert.equal(applied.applied, true); assert.equal(f.edits.length, 1)
  assert.ok(f.project.tracks[0].clips[0].anim.x.length >= 2)
})

test('server stabilization analysis measures motion and plans keyframes for the clip', { skip: !hasFFmpeg && 'ffmpeg is not installed' }, async t => {
  const f = fixture(t)
  const result = await f.routes['POST /api/analysis/stabilize']({ clip: 'c1' })
  assert.equal(result.kind, 'stabilization'); assert.equal(result.sampleFrames, 60)
  assert.equal(result.recommendation.route, '/api/stabilize/render')
  assert.ok(result.measurements.zoom >= 1 && result.measurements.zoom <= 1.5)
  assert.ok(result.ops.some(op => op.op === 'keyframe' && op.prop === 'x'))
  assert.deepEqual(result.target, { clip: 'c1', comp: null })
  await assert.rejects(f.routes['POST /api/analysis/stabilize']({}), /needs the clip/)
})

test('requests are validated and the Vision-only routes explain the browser alternative', async () => {
  const project = applyOps(newProject('V', { width: 320, height: 180 }), [{ op: 'add_title', text: 'T', track: 'V3', dur: 1 }]).project
  const routes = trackingRoutes({ getProject: () => project, getVersion: () => 1, resolveMedia: rel => rel, probe: async () => ({ hasVideo: false }) }).routes
  await assert.rejects(routes['POST /api/analysis/track']({ clip: 'c9' }), /no clip c9/)
  await assert.rejects(routes['POST /api/analysis/track']({ src: 'media/x.mp4', wait: false }), /runs while the request waits/)
  await assert.rejects(routes['POST /api/analysis/track']({ src: 'media/x.mp4' }), /is not a video/)
  for (const route of ['saliency', 'autoreframe', 'person-mask']) {
    assert.throws(() => routes[`POST /api/analysis/${route}`]({}), /needs the Arya app's Vision analysis and is unavailable in the browser editor\. .*POST \/api\/analysis\/track/)
  }
})

test('track and stabilization plans key positions relative to the clip and its fit', () => {
  const project = applyOps(newProject('P', { width: 1920, height: 1080, fps: 30 }), []).project
  project.assets['media/a.mp4'] = { width: 960, height: 540, duration: 4, hasVideo: true }
  const p = applyOps(project, [{ op: 'append', src: 'media/a.mp4', track: 'V1', dur: 2, in: 1, audio: false }]).project
  const hit = { comp: null, scope: p, track: p.tracks[0], clip: p.tracks[0].clips[0] }
  const ops = trackOps(p, hit, 1, [{ t: 0, x: 100, y: 100 }, { t: 1, x: 150, y: 100 }], p.assets['media/a.mp4'])
  const x = ops.filter(op => op.prop === 'x' && op.op === 'keyframe')
  assert.deepEqual(x.map(op => [op.at, op.value]), [[0, 960], [1, 1060]], 'fit 2: 50 source px move 100 canvas px')
  const plan = stabilizationPlan(p, hit, [{ a: 1, b: 0, tx: 0, ty: 0 }, { a: 1, b: 0, tx: 4, ty: 0 }, { a: 1, b: 0, tx: -4, ty: 0 }], p.assets['media/a.mp4'], { smoothing: 0.1 })
  assert.ok(plan.measurements.sourceMotionRMS > 3)
  assert.ok(plan.ops.filter(op => op.op === 'clear_keyframes').length >= 2)
})

test('analysis yields to the event loop between frames and stops at its deadline', async () => {
  let project = newProject('Yield', { width: 64, height: 36, fps: 30 })
  project.assets['media/flat.mp4'] = { duration: 2, width: 64, height: 36, fps: 30, hasVideo: true, hasAudio: false }
  project = applyOps(project, [{ op: 'append', src: 'media/flat.mp4', track: 'V1', dur: 2, audio: false }]).project
  // A stand-in decoder: every requested frame, flat gray, without running ffmpeg.
  const timeouts = []
  const run = async (command, argv, options) => { timeouts.push(options.timeout); return { stdout: Buffer.alloc(Number(argv[argv.indexOf('-frames:v') + 1]) * 64 * 36, 64) } }
  const routes = deadline => trackingRoutes({ getProject: () => project, getVersion: () => 1, resolveMedia: rel => rel, run, analysisDeadlineMs: deadline }).routes
  let done = false, turns = 0
  const spin = () => { turns++; if (!done) setImmediate(spin) }
  setImmediate(spin)
  const result = await routes(undefined)['POST /api/analysis/stabilize']({ clip: 'c1' })
  done = true
  assert.equal(result.sampleFrames, 60)
  assert.ok(turns >= 60 / 4 - 2, `other work ran ${turns} times while 60 frames were analyzed`)
  assert.ok(timeouts.length && timeouts.every(ms => ms > 0 && ms <= 120000), `each decode gets only the time left: ${timeouts}`)
  timeouts.length = 0
  await routes(5000)['POST /api/analysis/stabilize']({ clip: 'c1' })
  assert.ok(timeouts.every(ms => ms > 0 && ms <= 5000), `a shorter deadline bounds each decode: ${timeouts}`)
  await assert.rejects(routes(-1)['POST /api/analysis/stabilize']({ clip: 'c1' }), error => error.status === 408 && /Analysis stopped after 0 s\. Analyze a shorter range or a lower fps\./.test(error.message))
})
