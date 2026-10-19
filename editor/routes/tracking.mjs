// Motion tracking and stabilization analysis on the server, so assistants get measured data
// instead of guessing keyframes. ffmpeg decodes grayscale frames; the browser's pure tracker
// (web/engine/tracker.js) does the math. POST /api/analysis/track follows the native app's
// contract and also returns the keyframe ops; /api/analyze {kind:'stabilization'} returns
// the native measurements plus stabilization keyframe ops for the clip.

import { baseValue } from '../core/project.js'
import {
  accumulate, buildPyramid, corrections, coverZoom, estimateMotion, fitScale, image, keyframeOps, levelsFor, PointTracker, smoothPath, stabilizeValues,
} from '../web/engine/tracker.js'

const WINDOW_BYTES = 48 * 1024 * 1024
// The math runs on the server's event loop: it yields between small batches of frames so other
// requests keep flowing, and stops at an overall deadline.
const FRAMES_PER_YIELD = 4
const DEADLINE_MS = 120000
const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve))
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback
const fail = message => { throw Object.assign(new Error(message), { status: 400 }) }

/** The single clip a request targets, in the named composition or anywhere when unique. */
export function analysisTarget(project, body) {
  const id = body.clip ?? body.id
  if (id === undefined) return null
  if (typeof id !== 'string' || !id) fail('clip must be a clip ID.')
  const scopes = Object.hasOwn(body, 'comp') ? [[body.comp ?? null, body.comp == null ? project : Object.hasOwn(project.comps ?? {}, body.comp) ? project.comps[body.comp] : null]] : [[null, project], ...Object.entries(project.comps ?? {})]
  if (scopes.some(([, scope]) => !scope)) fail(`no composition ${body.comp}`)
  const hits = scopes.flatMap(([comp, scope]) => (scope.tracks ?? []).flatMap(track => (track.clips ?? []).filter(clip => clip.id === id).map(clip => ({ comp, scope, track, clip }))))
  if (hits.length !== 1) fail(hits.length ? `clip ${id} is ambiguous; name its comp` : `no clip ${id}`)
  return hits[0]
}

/** Keyframe ops for tracked positions: the clip's base position plus the measured motion. */
export function trackOps(project, hit, from, samples, asset) {
  const clip = hit.clip, speed = clip.speed ?? 1, clipIn = clip.in ?? 0
  if (clip.reverse || clip.freeze !== undefined || !(speed > 0)) fail('Apply tracking to a forward clip without freeze frames.')
  const scope = hit.comp == null ? project : { ...project, width: hit.scope.width ?? project.width, height: hit.scope.height ?? project.height }
  const fit = fitScale(asset.width, asset.height, scope.width, scope.height)
  const baseX = baseValue(scope, clip, 'x'), baseY = baseValue(scope, clip, 'y')
  const first = samples[0]
  const keyed = samples.map(sample => ({ local: (from - clipIn + sample.t) / speed, values: { x: baseX + (sample.x - first.x) * fit, y: baseY + (sample.y - first.y) * fit } }))
    .filter(sample => sample.local >= 0 && sample.local <= clip.dur + 1e-6)
  return keyframeOps(clip.id, keyed, { x: 0.25, y: 0.25 })
}

/** Stabilization keyframe ops from per-frame motion, as the Stabilize inspector writes them. */
export function stabilizationPlan(project, hit, steps, asset, options = {}) {
  const scope = hit.comp == null ? project : { ...project, width: hit.scope.width ?? project.width, height: hit.scope.height ?? project.height, fps: hit.scope.fps ?? project.fps }
  const fps = scope.fps ?? 30
  const raw = accumulate(steps.map(step => ({ a: step.a, b: step.b, tx: step.tx, ty: step.ty })))
  const path = options.rotation === false ? raw.map(step => ({ a: 1, b: 0, tx: step.tx, ty: step.ty })) : raw
  const smooth = smoothPath(path, finite(options.smoothing, 0.8) * fps, { lock: options.lock === true })
  const corrs = corrections(path, smooth)
  const requiredZoom = coverZoom(corrs, asset.width, asset.height, 4)
  const maxZoom = Math.max(1, Math.min(1.5, finite(options.maxZoom, 1.5)))
  const zoom = options.crop === false ? 1 : Math.min(requiredZoom, maxZoom)
  const base = Object.fromEntries(['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'anchorX', 'anchorY'].map(key => [key, baseValue(scope, hit.clip, key)]))
  const fit = fitScale(asset.width, asset.height, scope.width, scope.height)
  const values = stabilizeValues(corrs, () => base, fit, zoom)
  const samples = values.map((value, k) => ({ local: k / fps, values: options.rotation === false ? { x: value.x, y: value.y, ...(zoom > 1 ? { scale: value.scale } : {}) } : value }))
  const rms = list => Math.sqrt(list.reduce((sum, v) => sum + v * v, 0) / Math.max(1, list.length))
  const sourceMotion = rms(steps.slice(1).map(step => Math.hypot(step.tx, step.ty)))
  const residual = rms(smooth.slice(1).map((s, k) => Math.hypot(s.tx - smooth[k].tx, s.ty - smooth[k].ty)))
  return {
    ops: keyframeOps(hit.clip.id, samples, { x: 0.05, y: 0.05, rotation: 0.005, scale: 0.0002 }),
    measurements: { sourceMotionRMS: Math.round(sourceMotion * 100) / 100, outputMotionRMS: Math.round(residual * 100) / 100, zoom: Math.round(zoom * 1e4) / 1e4, requiredZoom: Math.round(requiredZoom * 1e4) / 1e4, cropLimited: requiredZoom > zoom + 1e-4, maxShift: Math.round(Math.max(0, ...corrs.map(c => Math.hypot(c.tx, c.ty))) * 10) / 10 },
  }
}

export default ctx => {
  /** Grayscale frames at `rate` per source second from `from`, `count` of them, in windows. */
  async function decode(abs, from, rate, count, width, height, onFrame) {
    const bytes = width * height, perWindow = Math.max(1, Math.floor(WINDOW_BYTES / bytes))
    const limit = ctx.analysisDeadlineMs ?? DEADLINE_MS, deadline = Date.now() + limit
    const late = () => Object.assign(new Error(`Analysis stopped after ${Math.round(limit / 1000)} s. Analyze a shorter range or a lower fps.`), { status: 408 })
    for (let start = 0; start < count; start += perWindow) {
      if (Date.now() > deadline) throw late()
      const n = Math.min(perWindow, count - start)
      const at = from + start / rate
      // Each decode gets only the time left before the deadline.
      const { stdout } = await ctx.run('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(at), '-i', abs, '-t', String((n + 1) / rate), '-an',
        '-vf', `fps=${rate},scale=${width}:${height}:flags=area`, '-frames:v', String(n), '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: n * bytes + 1024 * 1024, timeout: Math.max(1, deadline - Date.now()) })
        .catch(error => { throw Date.now() >= deadline ? late() : error })
      const got = Math.floor(stdout.length / bytes)
      for (let i = 0; i < got; i++) {
        if (i % FRAMES_PER_YIELD === FRAMES_PER_YIELD - 1) {
          await yieldToEventLoop()
          if (Date.now() > deadline) throw late()
        }
        const data = new Float32Array(bytes)
        for (let j = 0; j < bytes; j++) data[j] = stdout[i * bytes + j]
        if (await onFrame(start + i, image(width, height, data)) === false) return
      }
      if (got < n) return
    }
  }

  async function source(body, hit) {
    const src = body.src ?? hit?.clip.src
    if (typeof src !== 'string' || !src) fail('src or a clip with media is required.')
    if (hit && hit.clip.src !== src) fail(`clip ${hit.clip.id} does not play ${src}.`)
    const abs = ctx.resolveMedia(src)
    ctx.checkAgentFile?.(abs)
    const asset = ctx.getProject()?.assets?.[src] ?? await ctx.probe(src)
    if (!asset?.hasVideo || asset.still || !(asset.width > 0) || !(asset.height > 0) || !(asset.duration > 0)) fail(`${src} is not a video.`)
    return { src, abs, asset }
  }

  async function track(body) {
    const project = ctx.getProject()
    if (!project) fail('Open a project first.')
    if (body.expectedVersion !== undefined && body.expectedVersion !== ctx.getVersion()) fail('The project changed. Read it again before tracking.')
    if (body.wait === false) fail('Browser tracking runs while the request waits. Omit wait.')
    const hit = analysisTarget(project, body)
    const { src, abs, asset } = await source(body, hit)
    const clipSource = hit ? hit.clip.in ?? 0 : 0
    const from = Math.max(0, finite(body.in ?? body.from, clipSource))
    const to = finite(body.to, NaN)
    const duration = Math.min(asset.duration - from, finite(body.dur, Number.isFinite(to) ? to - from : hit ? hit.clip.dur * (hit.clip.speed ?? 1) : 1))
    const fps = Math.min(120, Math.max(1, finite(body.fps, 15)))
    const count = Math.floor(duration * fps + 1e-6) + 1
    if (!(duration > 0) || count > 3000) fail('Track a positive range of at most 3000 samples (duration times fps).')
    const rect = body.rect ?? {}
    const r = { x: finite(rect.x, 0.375), y: finite(rect.y, 0.375), w: finite(rect.width ?? rect.w, 0.25), h: finite(rect.height ?? rect.h, 0.25) }
    if (![r.x, r.y, r.w, r.h].every(v => v >= 0 && v <= 1) || r.w <= 0 || r.h <= 0 || r.x + r.w > 1.0001 || r.y + r.h > 1.0001) fail('rect is {x, y, width, height} from 0 to 1, top-left origin, inside the frame.')
    const width = Math.min(asset.width, 960), height = Math.max(2, Math.round(asset.height * width / asset.width)), s = width / asset.width
    const tw = Math.max(9, r.w * width), th = Math.max(9, r.h * height)
    const levels = levelsFor(tw, th)
    const samples = []
    let tracker = null, lostAt
    await decode(abs, from, fps, count, width, height, (k, img) => {
      const pyr = buildPyramid(img, levels)
      const t = k / fps
      if (!tracker) {
        tracker = new PointTracker(pyr, (r.x + r.w / 2) * width, (r.y + r.h / 2) * height, tw, th, { minScore: finite(body.minScore, 0.5) })
        samples.push({ t: 0, sourceTime: from, x: tracker.x / s, y: tracker.y / s, width: tw / s, height: th / s, confidence: 1 })
        return true
      }
      const step = tracker.step(pyr)
      if (step.lost) { lostAt = Math.round((from + t) * 1e4) / 1e4; return false }
      samples.push({ t: Math.round(t * 1e4) / 1e4, sourceTime: Math.round((from + t) * 1e4) / 1e4, x: step.x / s, y: step.y / s, width: tw / s, height: th / s, confidence: Math.round(step.score * 1000) / 1000 })
      return true
    })
    if (!samples.length) fail('No frames could be decoded for that range.')
    const result = { kind: 'track', samples, ...(lostAt !== undefined ? { lostAt } : {}), width: asset.width, height: asset.height, engine: 'arya-ncc-lk' }
    if (hit) {
      result.ops = trackOps(project, hit, from, samples, asset)
      result.target = { clip: hit.clip.id, comp: hit.comp }
      if (body.apply === true) {
        const edit = await ctx.editOps(result.ops, 'reel', `tracked ${hit.clip.id}`, { expectedVersion: body.expectedVersion ?? ctx.getVersion() })
        result.applied = true; result.version = edit.version
      }
    } else if (body.apply === true) fail('Name the clip to apply tracking to.')
    return result
  }

  async function stabilization(body) {
    const project = ctx.getProject()
    if (!project) fail('Open a project first.')
    const hit = analysisTarget(project, body) ?? fail('Stabilization analysis needs the clip to stabilize.')
    if (hit.clip.kind !== 'video' || hit.clip.reverse || hit.clip.freeze !== undefined) fail('Analyze a forward video clip without freeze frames.')
    const { abs, asset } = await source({ src: hit.clip.src }, hit)
    const fps = (hit.comp == null ? project.fps : hit.scope.fps ?? project.fps) ?? 30
    const speed = hit.clip.speed ?? 1
    const count = Math.max(1, Math.round(hit.clip.dur * fps))
    if (count > 1800) fail('Stabilization analysis covers at most 1800 clip frames. Split the clip or render deshake with /api/stabilize/render.')
    const width = Math.min(asset.width, 640), height = Math.max(2, Math.round(asset.height * width / asset.width)), s = width / asset.width
    const steps = []
    let previous = null
    await decode(abs, hit.clip.in ?? 0, fps / speed, count, width, height, (k, img) => {
      const pyr = buildPyramid(img, 3)
      if (!previous) steps.push({ k, a: 1, b: 0, tx: 0, ty: 0, inliers: 0 })
      else {
        const m = estimateMotion(previous, pyr, { radius: Math.round(width * 0.08) })
        steps.push({ k, a: m.a, b: m.b, tx: m.tx / s, ty: m.ty / s, inliers: m.inliers })
      }
      previous = pyr
    })
    if (steps.length < 2) fail('Too few frames decoded to measure motion.')
    const plan = stabilizationPlan(project, hit, steps, asset, body)
    const weak = steps.filter((step, i) => i > 0 && step.inliers < 6).length
    const result = {
      kind: 'stabilization', measurements: plan.measurements, sampleFrames: steps.length, analysisWidth: width, analysisHeight: height,
      recommendation: { route: '/api/stabilize/render', zoom: Math.max(1, Math.min(1.5, plan.measurements.requiredZoom)) },
      warnings: weak ? [`${weak} of ${steps.length} frames had few trackable points; check the result in the viewer.`] : [],
      ops: plan.ops, target: { clip: hit.clip.id, comp: hit.comp }, engine: 'arya-grid-similarity',
    }
    if (body.apply === true) {
      const edit = await ctx.editOps(plan.ops, 'reel', `stabilized ${hit.clip.id} with keyframes`, { expectedVersion: body.expectedVersion ?? ctx.getVersion() })
      result.applied = true; result.version = edit.version
    }
    return result
  }

  const admitted = work => body => ctx.admit ? ctx.admit(() => work(body ?? {})) : work(body ?? {})
  // These need Apple Vision and run only in the Arya app. /api/caps reports them false here.
  const appOnly = (what, instead) => () => { throw Object.assign(new Error(`${what} needs the Arya app's Vision analysis and is unavailable in the browser editor. ${instead}`), { status: 501 }) }
  return {
    routes: {
      'POST /api/analysis/track': admitted(track),
      'POST /api/analysis/stabilize': admitted(stabilization),
      'POST /api/analysis/saliency': appOnly('Saliency detection', 'Track the subject with POST /api/analysis/track and an explicit rect instead.'),
      'POST /api/analysis/autoreframe': appOnly('Auto reframe', 'Track the subject with POST /api/analysis/track, then key x and y from its samples, or apply its ops.'),
      'POST /api/analysis/person-mask': appOnly('Person masks', 'Draw a mask with add_mask and track it with POST /api/analysis/track.'),
    },
  }
}
