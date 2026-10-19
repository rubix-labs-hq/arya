// Processing actions keep the selected composition and source mapping fixed.
export function processingCapture(s, p, clip) {
  const hit = p?.tracks?.flatMap(track => track.clips.map(c => ({ track, clip: c }))).find(x => x.clip.id === clip.id)
  if (!hit || JSON.stringify(hit.clip) !== JSON.stringify(clip) || s.selection.length !== 1 || s.selection[0] !== clip.id) throw new Error('Select this video clip again before processing.')
  if (hit.track.locked || clip.enabled === false || clip.kind !== 'video' || !clip.src) throw new Error('Choose an enabled video clip on an unlocked track.')
  const speed = clip.speed ?? 1, input = clip.in ?? 0
  if (!Number.isFinite(speed) || speed <= 0 || clip.reverse || clip.freeze !== undefined || clip.timeMap !== undefined) throw new Error('Processing requires forward video with a constant positive speed.')
  if (!Number.isFinite(input) || input < 0 || !Number.isFinite(clip.dur) || clip.dur <= 0 || clip.dur * speed > 3600) throw new Error('Choose a source range of at most one hour.')
  const asset = s.project.assets?.[clip.src]
  if (!asset?.hasVideo || asset.still || !Number.isFinite(asset.duration) || input + clip.dur * speed > asset.duration + 1e-5) throw new Error('Wait for a complete video source probe before processing.')
  if (!Number.isSafeInteger(s.version) || s.version < 0 || !(p.width > 0 && p.height > 0 && p.fps > 0)) throw new Error('Refresh the project before processing.')
  const scope = s.openComp ?? null
  return { root: s.root, version: s.version, project: s.project, scope, id: clip.id, clip: structuredClone(clip), width: p.width, height: p.height, fps: p.fps, asset: structuredClone(asset), track: JSON.stringify({ ...hit.track, clips: undefined }) }
}

export function sourceKey(capture) {
  return JSON.stringify([capture.root, capture.scope, capture.clip, capture.asset, capture.width, capture.height, capture.fps, capture.track])
}

export function captureMatches(capture, s, p) {
  if (s.root !== capture.root || s.project !== capture.project || s.version !== capture.version || (s.openComp ?? null) !== capture.scope) return false
  try { return sourceKey(processingCapture(s, p, capture.clip)) === sourceKey(capture) } catch { return false }
}

export function processingBody(capture, options = {}) {
  const sourceFPS = capture.asset.fps
  return { ...options, fps: options.fps ?? (Number.isFinite(sourceFPS) && sourceFPS >= 1 && sourceFPS <= 240 ? sourceFPS : capture.fps), src: capture.clip.src, clip: capture.id, id: capture.id, comp: capture.scope, in: capture.clip.in ?? 0, dur: capture.clip.dur * (capture.clip.speed ?? 1), expectedVersion: capture.version, wait: false }
}

// A derived source keeps enough information to restore or render revised settings.
export function denoiseSource(capture) {
  const c = capture.clip, record = c.noiseReduction
  if (!record || record.output !== c.src || typeof record.src !== 'string' || record.src === c.src) return null
  const original = capture.project.assets?.[record.src], offset = c.in ?? 0, input = record.in + offset, duration = c.dur * (c.speed ?? 1)
  if (![record.in, record.dur, offset, input, duration].every(Number.isFinite) || record.in < 0 || offset < 0 || offset + duration > record.dur + 1e-5 || !original?.hasVideo || original.still || !Number.isFinite(original.duration) || input + duration > original.duration + 1e-5) throw new Error('The saved denoise source range is unavailable. Restore it with Undo or choose the original source in Media.')
  return { src: record.src, in: input, dur: duration, settings: record.settings ?? {} }
}

export function restoreDenoiseOps(capture) {
  const original = denoiseSource(capture)
  if (!original) throw new Error('This clip has no matching saved denoise source.')
  return [{ op: 'update', id: capture.id, comp: capture.scope, set: { src: original.src, in: original.in, noiseReduction: null } }]
}

const properties = ['x', 'y', 'scale']
export function reframeOps(capture, samples) {
  const c = capture.clip
  if (c.parent || (c.rotation ?? 0) !== 0 || (c.scaleX ?? 1) !== 1 || (c.scaleY ?? 1) !== 1 || (c.anchorX ?? 0) !== 0 || (c.anchorY ?? 0) !== 0 || ['rotation', 'scaleX', 'scaleY', 'anchorX', 'anchorY'].some(key => c.anim?.[key]?.length || c.expr?.[key])) throw new Error('Reframe an unparented clip with default rotation, anchors and axis scales.')
  if (!Array.isArray(samples) || !samples.length || samples.length > 20000) throw new Error('No bounded subject path was returned.')
  const speed = c.speed ?? 1
  let previous = -1
  const ops = properties.flatMap(prop => [{ op: 'clear_keyframes', id: c.id, prop, comp: capture.scope }, { op: 'expression', id: c.id, prop, expr: null, comp: capture.scope }])
  ops.push({ op: 'update', id: c.id, comp: capture.scope, set: { fit: 'cover', scale: 1, x: capture.width / 2, y: capture.height / 2 } })
  for (const sample of samples) {
    if (![sample.t, sample.x, sample.y].every(Number.isFinite) || sample.t < 0 || sample.t <= previous || sample.t > c.dur * speed + 1e-5) throw new Error('The subject path has invalid timing or positions.')
    previous = sample.t
    for (const prop of ['x', 'y']) ops.push({ op: 'keyframe', id: c.id, comp: capture.scope, prop, at: sample.t / speed, value: sample[prop], local: true, ease: 'linear' })
  }
  return ops
}

// The local tracker supplies source-pixel points for every timeline frame.
export function trackedReframe(capture, track, smoothing = 0.5) {
  if (track?.clipId !== capture.id || track.reframeSourceKey !== sourceKey(capture) || track.busy || track.lostAt != null) throw new Error('Track this unchanged clip from its first frame to its last frame before reframing.')
  const count = Math.max(1, Math.round(capture.clip.dur * capture.fps))
  if (count > 20000 || !Number.isFinite(smoothing) || smoothing < 0 || smoothing > 2) throw new Error('Reframe needs up to 20000 tracked frames and smoothing from 0 to 2 seconds.')
  const points = Array.from({ length: count }, (_, k) => track.results?.[k]?.pts?.[0])
  if (points.some(p => !Array.isArray(p) || p.length < 2 || !p.slice(0, 2).every(Number.isFinite))) throw new Error('The track must cover every frame of this clip.')
  const W = capture.asset.width, H = capture.asset.height
  if (!(Number.isFinite(W) && W > 0 && Number.isFinite(H) && H > 0)) throw new Error('Wait for source dimensions before reframing.')
  const scale = Math.max(capture.width / W, capture.height / H)
  const maxX = Math.max(0, (W * scale - capture.width) / 2), maxY = Math.max(0, (H * scale - capture.height) / 2)
  const radius = Math.round(smoothing * capture.fps), prefix = [[0, 0]]
  for (const p of points) prefix.push([prefix.at(-1)[0] + p[0], prefix.at(-1)[1] + p[1]])
  const samples = points.map((_, k) => {
    const a = Math.max(0, k - radius), b = Math.min(count, k + radius + 1)
    const center = [0, 1].map(axis => (prefix[b][axis] - prefix[a][axis]) / (b - a))
    return { t: k / capture.fps * (capture.clip.speed ?? 1), x: capture.width / 2 + Math.max(-maxX, Math.min(maxX, (W / 2 - center[0]) * scale)), y: capture.height / 2 + Math.max(-maxY, Math.min(maxY, (H / 2 - center[1]) * scale)) }
  })
  return reframeOps(capture, samples)
}

// Admission is synchronous, including a cancel pressed before the backend returns an ID.
export function createProcessingRuns({ api, current, edit, notify, changed = () => {} }) {
  const runs = new Map()
  const key = (capture, kind) => JSON.stringify([capture.root, capture.scope, capture.id, kind])
  const sameRoot = capture => current().s.root === capture.root
  const cancel = async run => {
    run.cancelRequested = true; changed()
    if (run.id && sameRoot(run.capture)) await api(run.cancelPath, { id: run.id })
  }
  const start = (capture, kind, path, body, { jobPrefix = '/api/analysis/jobs', applyReframe = false } = {}) => {
    const token = key(capture, kind), prior = runs.get(token)
    if (prior?.state === 'running') return prior
    const { s, p } = current()
    if (!captureMatches(capture, s, p)) throw new Error('The project or selection changed. Choose the clip again.')
    const run = { capture, kind, state: 'running', id: null, cancelPath: `${jobPrefix}/cancel`, cancelRequested: false }
    runs.set(token, run); changed()
    run.promise = (async () => {
      try {
        let job = await api(path, body)
        if (job?.id) {
          run.id = job.id; changed()
          if (run.cancelRequested) await cancel(run)
          while (['running', 'queued'].includes(job.state)) {
            if (!sameRoot(capture)) throw new Error('The project changed while processing.')
            job = await api(`${jobPrefix}/wait?id=${encodeURIComponent(job.id)}&timeout=25000`)
            run.progress = job.progress; changed()
          }
          if (job.state !== 'done') throw new Error(job.state === 'cancelled' ? 'Processing cancelled.' : job.error ?? 'Processing failed.')
        }
        if (run.cancelRequested && job.applied !== true) throw new Error('Processing cancelled.')
        if (job.applyError || job.applied === false) throw new Error(job.applyError ?? 'The processed output was saved without changing the clip.')
        if (applyReframe) {
          const { s, p } = current()
          if (!captureMatches(capture, s, p)) throw new Error('The project, clip or selection changed. The reframe was not applied.')
          const result = job.result ?? job
          if (result.warnings?.length) throw new Error(result.warnings.join(' '))
          const response = await edit(reframeOps(capture, result.samples), 'Reframed selected video', { expectedVersion: capture.version })
          if (!response) throw new Error('The reframe edit was rejected.')
        }
        run.state = 'done'; run.output = job.output
        if (sameRoot(capture)) notify(`${kind === 'denoise' ? 'Denoise' : 'Reframe'} ${run.cancelRequested ? 'completed before cancellation' : 'complete'}${job.output ? `: ${job.output}` : ''}`)
      } catch (error) {
        run.state = run.cancelRequested ? 'cancelled' : 'failed'; run.error = error.message
        if (sameRoot(capture)) notify(error.message, 'error')
      } finally { changed() }
      return run
    })()
    return run
  }
  return { runs, key, start, cancel }
}
