// Local SDR video denoise. Native hosts use their existing HDR/alpha processor.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { guardedOutput } from '../core/output-path.js'
import { captureProcessingProject, currentProcessingProject, processedVideoAsset, admitProcessedOutput } from '../processing-output-admission.mjs'

export function denoiseFilter(body) {
  const options = { quality: body.quality ?? 'balanced', strength: body.strength ?? 0.65, spatial: body.spatial ?? 0.5, temporal: body.temporal ?? 0.8, detail: body.detail ?? 0.7, sigma: body.sigma ?? 0.06 }
  if (!['fast', 'balanced', 'high'].includes(options.quality) || !['strength', 'spatial', 'temporal', 'detail'].every(k => Number.isFinite(options[k]) && options[k] >= 0 && options[k] <= 1) || !Number.isFinite(options.sigma) || options.sigma < 0.002 || options.sigma > 0.25) throw new Error('Choose valid denoise controls and noise sigma from 0.002 to 0.25.')
  const factor = { fast: 3, balanced: 4, high: 6 }[options.quality]
  const spatial = factor * options.strength * options.spatial * (options.sigma / 0.06) * (1 - 0.8 * options.detail)
  const temporal = factor * 1.5 * options.strength * options.temporal * (options.sigma / 0.06)
  // hqdn3d treats zero values as defaults, so bypass for a zero-strength job.
  return { options, filter: options.strength === 0 || spatial === 0 && temporal === 0 ? 'null' : `hqdn3d=${Math.max(0.000001, spatial)}:${Math.max(0.000001, spatial * 0.75)}:${Math.max(0.000001, temporal)}:${Math.max(0.000001, temporal * 0.75)}` }
}

const stamp = file => {
  const s = fs.statSync(file, { bigint: true })
  if (!s.isFile()) throw new Error('Choose a regular video source.')
  return [fs.realpathSync(file), s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join('|')
}

export default function videoProcessing(ctx) {
  const jobs = new Map()
  let capabilities
  const caps = () => capabilities ??= ctx.run('ffmpeg', ['-hide_banner', '-filters']).then(({ stdout, stderr }) => /\bhqdn3d\b/.test(stdout + (stderr ?? '')) ? { videoDenoise: true, engine: 'ffmpeg-hqdn3d', compute: 'cpu', preservesHDR: false, preservesAlpha: false, maxDurationSeconds: 3600 } : { videoDenoise: false, reason: 'This ffmpeg installation lacks hqdn3d.' }).catch(() => ({ videoDenoise: false, reason: 'Local ffmpeg video processing is unavailable.' }))
  const state = () => captureProcessingProject(ctx)
  const publicJob = ({ abort, promise, ...job }) => job
  const publish = job => ctx.broadcast('job', publicJob(job))
  const target = (project, comp, id) => {
    const canvas = comp === null ? project : project?.comps?.[comp]
    if (!canvas) throw new Error('The requested composition is gone.')
    const found = canvas.tracks.flatMap(track => track.clips.map(clip => ({ track, clip }))).filter(x => x.clip.id === id)
    if (found.length !== 1) throw new Error('Choose an unambiguous clip in this composition.')
    return { canvas, ...found[0] }
  }
  const execute = (argv, signal, progress) => ctx.videoRender ? ctx.videoRender(argv, signal, progress) : new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', argv, { signal }), errors = []
    proc.stderr.on('data', bytes => { errors.push(String(bytes)); if (errors.join('').length > 8192) errors.shift() })
    proc.stdout.on('data', bytes => {
      for (const line of String(bytes).split('\n')) if (line.startsWith('out_time_us=')) progress(Number(line.slice(12)) / 1e6)
    })
    proc.on('error', reject)
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(signal.aborted ? 'Processing cancelled.' : `ffmpeg: ${errors.join('').trim().split('\n').slice(-3).join(' ')}`)))
  })
  async function start(body) {
    const { options, filter } = denoiseFilter(body)
    if (!(await caps()).videoDenoise) throw new Error('Local video denoise is unavailable.')
    if (!Object.hasOwn(body, 'comp') || body.comp !== null && (typeof body.comp !== 'string' || !body.comp)) throw new Error('Specify the destination composition or null.')
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) throw new Error('Refresh the project before denoising.')
    const snapshot = await state(), hit = target(snapshot.project, body.comp, body.clip ?? body.id), c = hit.clip
    if (snapshot.version !== body.expectedVersion || hit.track.locked || c.enabled === false || c.kind !== 'video' || c.reverse || c.freeze !== undefined || c.timeMap !== undefined) throw new Error('Choose an unlocked, unchanged forward video clip.')
    const speed = c.speed ?? 1, clipInput = c.in ?? 0, duration = c.dur * speed
    let src = c.src, input = clipInput
    if (![speed, clipInput, duration, body.in, body.dur].every(Number.isFinite) || speed <= 0 || clipInput < 0 || duration <= 0 || duration > 3600 || body.src !== c.src || Math.abs(body.in - clipInput) > 1e-5 || Math.abs(body.dur - duration) > 1e-5) throw new Error('Denoise the complete source range of the selected clip.')
    if (![undefined, 'auto', 'h264'].includes(body.codec)) throw new Error('The browser denoiser supports automatic SDR H.264 output.')
    if (body.useOriginal === true) {
      const record = c.noiseReduction
      if (!record || record.output !== c.src || typeof record.src !== 'string' || record.src === c.src || ![record.in, record.dur].every(Number.isFinite) || record.in < 0 || clipInput + duration > record.dur + 1e-5) throw new Error('The saved original denoise range is unavailable.')
      src = record.src; input = record.in + clipInput
    }
    const source = ctx.resolveMedia(src); ctx.checkAgentFile?.(source)
    const fingerprint = stamp(source), identity = JSON.stringify({ track: hit.track, clip: c })
    const metadata = await ctx.run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', source])
    const details = JSON.parse(metadata.stdout), video = details.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
    if (!video || !['yuv420p', 'yuv422p', 'yuv444p', 'nv12'].includes(video.pix_fmt) || ['smpte2084', 'arib-std-b67'].includes(video.color_transfer) || video.color_primaries === 'bt2020') throw new Error('Use the native processor for HDR, alpha or high bit-depth video.')
    if (!Number.isSafeInteger(video.index) || video.index < 0) throw new Error('The source video stream could not be identified.')
    const length = Number(details.format?.duration)
    if (!Number.isFinite(length) || input + duration > length + 0.001) throw new Error('The source range exceeds the video.')
    const validate = async (expectedVersion = snapshot.version) => {
      const now = currentProcessingProject(ctx, snapshot), current = target(now.project, body.comp, c.id)
      if (now.version !== expectedVersion || stamp(source) !== fingerprint || JSON.stringify({ track: current.track, clip: current.clip }) !== identity) throw new Error('The project or source changed. The processed copy was not applied.')
    }
    await validate()
    if ([...jobs.values()].filter(j => j.state === 'running').length >= 4) throw new Error('Wait for a video-processing job to finish.')
    const id = `v${randomUUID().replaceAll('-', '')}`, rel = `media/denoised/${id}.mp4`
    const output = guardedOutput(ctx.ROOT, path.join(ctx.ROOT, rel)), part = guardedOutput(ctx.ROOT, `${output}.part.mp4`)
    const abort = new AbortController(), job = { id, kind: 'denoise', state: 'running', progress: 0, created: Date.now(), output: rel, placementRequested: body.apply !== false, cancelPath: '/api/video/jobs/cancel', spec: { ...options, codec: 'h264', engine: 'ffmpeg-hqdn3d', compute: 'cpu', src, in: input, dur: duration, clip: c.id, comp: body.comp }, abort }
    jobs.set(id, job)
    try { publish(job) } catch (error) { jobs.delete(id); throw error }
    job.promise = (async () => {
      try {
        fs.mkdirSync(guardedOutput(ctx.ROOT, path.dirname(output)), { recursive: true })
        const audio = details.streams?.some(s => s.codec_type === 'audio')
        const argv = ['-nostdin', '-y', '-loglevel', 'error', '-ss', String(input), '-t', String(duration), '-i', source, '-map', `0:${video.index}`, ...(audio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k'] : ['-an']), '-vf', filter, '-c:v', 'libx264', '-preset', options.quality === 'fast' ? 'veryfast' : options.quality === 'high' ? 'slow' : 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', part]
        await execute(argv, abort.signal, seconds => { job.progress = Math.min(0.99, Math.max(0, seconds / duration)); publish(job) })
        if (abort.signal.aborted) throw new Error('Processing cancelled.')
        guardedOutput(ctx.ROOT, part); guardedOutput(ctx.ROOT, output); fs.renameSync(part, output)
        const probed = await ctx.probe(rel)
        if (abort.signal.aborted) throw new Error('Processing cancelled.')
        if (stamp(source) !== fingerprint) throw new Error('The original input changed while processing. The copy was not added to Media.')
        const asset = processedVideoAsset(probed, { output: rel, kind: 'denoise', src, input, duration, engine: 'ffmpeg-hqdn3d', settings: { ...options, codec: 'h264' }, fps: snapshot.project.assets?.[c.src]?.fps || 30 })
        job.asset = asset; job.assetRegistered = false
        if (job.placementRequested) job.applied = false
        let admission
        try {
          admission = await admitProcessedOutput(ctx, snapshot, rel, asset, { cancelled: () => abort.signal.aborted, validateSource: () => { if (stamp(source) !== fingerprint) throw new Error('The original input changed while processing. The copy was not added to Media.') }, who: 'you' })
          job.asset = admission.asset; job.assetRegistered = true; job.admissionVersion = admission.version; job.version = admission.version
        } catch (error) { job.registrationError = error.message; job.applied = false }
        if (abort.signal.aborted) throw new Error('Processing cancelled.')
        if (job.placementRequested) {
          try {
            if (!admission) throw new Error(job.registrationError)
            if (!admission.placementCurrent) throw new Error('The project changed. The processed copy was added to Media but was not applied.')
            await validate(admission.version)
            if (abort.signal.aborted) throw new Error('Processing cancelled.')
            const result = await ctx.callAPI('POST', '/api/ops', { expectedVersion: admission.version, ops: [{ op: 'update', id: c.id, comp: body.comp, set: { src: rel, in: 0, noiseReduction: { src, in: input, dur: duration, output: rel, engine: 'ffmpeg-hqdn3d', compute: 'cpu', settings: { ...options, codec: 'h264' } } } }], who: 'you', summary: `Denoised ${c.id}; original source retained`, returnProject: false })
            job.applied = true; job.version = result.version
          } catch (error) { job.applied = false; job.applyError = error.message }
        }
        job.state = 'done'; job.progress = 1
      } catch (error) { job.state = abort.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message }
      finally { try { fs.rmSync(guardedOutput(ctx.ROOT, part), { force: true }) } catch {} job.finished = Date.now(); publish(job) }
      return publicJob(job)
    })()
    if (body.wait) await job.promise
    return publicJob(job)
  }
  return { routes: {
    'GET /api/video/caps': caps,
    'POST /api/video/denoise': start,
    'GET /api/video/jobs': () => ({ jobs: [...jobs.values()].map(publicJob) }),
    'GET /api/video/jobs/wait': async (_body, query) => {
      const job = jobs.get(query.get('id'))
      if (!job) throw new Error('This video-processing job is unavailable.')
      const timeout = Number(query.get('timeout') ?? 25000)
      if (!Number.isFinite(timeout) || timeout < 0) throw new Error('Choose a finite job wait timeout.')
      if (!job.finished) {
        let timer
        try { await Promise.race([job.promise, new Promise(resolve => { timer = setTimeout(resolve, Math.min(60000, timeout)) })]) } finally { clearTimeout(timer) }
      }
      return publicJob(job)
    },
    'POST /api/video/jobs/cancel': body => {
      const job = jobs.get(body.id)
      if (job?.state === 'running') { job.abort.abort(); job.state = 'cancelled'; publish(job) }
      return { ok: true }
    },
  } }
}
