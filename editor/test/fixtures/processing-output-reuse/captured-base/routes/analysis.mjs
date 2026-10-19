// Analysis and media-processing routes: multicam audio sync, optical-flow retiming and
// ffmpeg deshake stabilization. Loaded by server.mjs (every editor/routes/*.mjs).
//
//   POST /api/multicam/sync      { srcs, window?, rate?, maxSeconds? }
//        → { offsets, lags, confidence, sharpness, inverted, rate, window, warnings }
//        offsets are ready for make_multicam: angle a reads its source at multicam time + offsets[a],
//        and the smallest offset is 0 (multicam time 0 is where the last camera to roll starts).
//        lags[a] is the raw lag against the first angle: the first angle's moment t is at t + lags[a] in angle a.
//   POST /api/retime             { src, in, dur, speed, fps?, clip?, wait? }   → job
//        renders source [in, in + dur] slowed to `speed` with minterpolate into media/retimed/;
//        with `clip`, the finished render replaces that clip's src/in/speed (one undoable edit).
//   POST /api/stabilize/render   { src, in, dur, zoom?, clip?, wait? }        → job
//        renders source [in, in + dur] through deshake into media/stabilized/; with `clip`, replaces its src/in.
//   GET  /api/analysis/jobs                                                   → { jobs }
//   GET  /api/analysis/jobs/wait?id=&timeout=                                  → the job when it ends or times out
//   POST /api/analysis/jobs/cancel { id }                                      → { ok }
//
// Jobs are broadcast as `job` events ({ id, kind: retime|stabilize, state, progress, output }),
// so the editor's job pill shows them.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { findClip } from '../core/project.js'
import { guardedOutput } from '../core/output-path.js'

// ---------------------------------------------------------------- FFT and cross-correlation

export const nextPow2 = n => 2 ** Math.ceil(Math.log2(Math.max(2, n)))

const twiddles = new Map()
function twiddleTable(n) {
  let t = twiddles.get(n)
  if (!t) {
    const cos = new Float64Array(n / 2)
    const sin = new Float64Array(n / 2)
    for (let k = 0; k < n / 2; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / n)
      sin[k] = Math.sin((2 * Math.PI * k) / n)
    }
    t = { cos, sin }
    twiddles.clear()
    twiddles.set(n, t)
  }

  return t
}

/** In-place iterative radix-2 FFT of (re, im); the length must be a power of two. The inverse divides by n. */
export function fft(re, im, inverse = false) {
  const n = re.length
  if (n & (n - 1)) throw new Error('fft length must be a power of two')
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  const { cos, sin } = twiddleTable(n)
  const sign = inverse ? 1 : -1
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = n / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]
        const wi = sign * sin[k * step]
        const a = i + k
        const b = a + half
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

/**
 * r[L] = Σn a[n]·b[n + L] for L in [-maxLag, maxLag], computed with one zero-padded FFT
 * product. Returns a Float64Array of length 2·maxLag + 1 (index L + maxLag).
 */
export function crossCorrelate(a, b, maxLag) {
  const n = nextPow2(a.length + b.length)
  const ar = new Float64Array(n)
  const ai = new Float64Array(n)
  ar.set(a)
  fft(ar, ai)
  let br = new Float64Array(n)
  let bi = new Float64Array(n)
  br.set(b)
  fft(br, bi)
  // conj(A)·B
  for (let k = 0; k < n; k++) {
    const re = ar[k] * br[k] + ai[k] * bi[k]
    const im = ar[k] * bi[k] - ai[k] * br[k]
    ar[k] = re
    ai[k] = im
  }
  br = bi = null
  fft(ar, ai, true)
  const out = new Float64Array(2 * maxLag + 1)
  for (let L = -maxLag; L <= maxLag; L++) out[L + maxLag] = ar[(L + n) % n]

  return out
}

/** Zero mean and a pre-emphasis filter, so broadband detail (not hum or rumble) decides the lag. */
export function prepare(x) {
  let mean = 0
  for (let i = 0; i < x.length; i++) mean += x[i]
  mean /= x.length || 1
  const out = new Float64Array(x.length)
  let prev = 0
  for (let i = 0; i < x.length; i++) {
    const v = x[i] - mean
    out[i] = v - 0.95 * prev
    prev = v
  }

  return out
}

/**
 * The lag of b against a, in seconds: a's moment t sounds at t + lag in b.
 * confidence is the correlation coefficient at that lag over the overlap (0…1);
 * sharpness is 1 − (the best peak elsewhere / the chosen peak), near 0 when the match is ambiguous.
 */
export function findLag(a, b, rate, maxLagSeconds = 30) {
  const pa = prepare(a)
  const pb = prepare(b)
  const maxLag = Math.max(1, Math.min(Math.round(maxLagSeconds * rate), pa.length + pb.length - 2))
  const r = crossCorrelate(pa, pb, maxLag)
  let best = maxLag
  for (let i = 0; i < r.length; i++) if (Math.abs(r[i]) > Math.abs(r[best])) best = i
  const L = best - maxLag
  // Sub-sample peak by a parabola through the three samples around it.
  let delta = 0
  if (best > 0 && best < r.length - 1) {
    const y0 = r[best - 1]
    const y1 = r[best]
    const y2 = r[best + 1]
    const den = y0 - 2 * y1 + y2
    if (Math.abs(den) > 1e-12) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den))
  }
  // Correlation coefficient over the overlap at the integer lag.
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = Math.max(0, -L); i < pa.length && i + L < pb.length; i++) {
    const x = pa[i]
    const y = pb[i + L]
    sab += x * y
    saa += x * x
    sbb += y * y
  }
  const confidence = saa > 0 && sbb > 0 ? Math.abs(sab) / Math.sqrt(saa * sbb) : 0
  const guard = Math.round(rate * 0.05)
  let second = 0
  for (let i = 0; i < r.length; i++) if (Math.abs(i - best) > guard) second = Math.max(second, Math.abs(r[i]))
  const peak = Math.abs(r[best])

  return { lag: (L + delta) / rate, confidence, sharpness: peak > 0 ? 1 - second / peak : 0, inverted: r[best] < 0 }
}

/** Offsets for make_multicam from lags against the first angle: shifted so the smallest is 0. */
export function offsetsFromLags(lags) {
  const min = Math.min(...lags)

  return lags.map(l => Math.round((l - min) * 10000) / 10000)
}

// ---------------------------------------------------------------- media helpers

function atempoChain(speed) {
  const parts = []
  let s = speed
  while (s < 0.5) {
    parts.push('atempo=0.5')
    s /= 0.5
  }
  parts.push(`atempo=${s.toFixed(6)}`)

  return parts.join(',')
}

const safeName = rel => path.parse(rel).name.replace(/[^\w.-]+/g, '-').slice(0, 48) || 'clip'

export default function analysisRoutes(ctx) {
  const jobs = new Map()

  async function pcm(src, rate, maxSeconds) {
    const abs = ctx.resolveMedia(src)
    const { stdout } = await ctx.run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', abs, '-vn', '-ac', '1', '-ar', String(rate), '-t', String(maxSeconds), '-f', 's16le', 'pipe:1'], { encoding: 'buffer' })
    const s16 = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2))
    const out = new Float64Array(s16.length)
    for (let i = 0; i < s16.length; i++) out[i] = s16[i] / 32768

    return out
  }

  async function sync(body) {
    const srcs = body.srcs ?? []
    if (srcs.length < 2) throw new Error('multicam sync needs at least two sources')
    const rate = Math.max(4000, Math.min(16000, Number(body.rate ?? 8000)))
    const window = Math.max(1, Math.min(120, Number(body.window ?? 30)))
    const maxSeconds = Math.max(window + 5, Math.min(600, Number(body.maxSeconds ?? 120)))
    const signals = await Promise.all(srcs.map(src => pcm(src, rate, maxSeconds).catch(() => new Float64Array(0))))
    const warnings = []
    const ref = signals.findIndex(s => s.length > rate)
    if (ref < 0) throw new Error('none of these sources has audio to sync by')
    const lags = []
    const confidence = []
    const sharpness = []
    const inverted = []
    for (let i = 0; i < srcs.length; i++) {
      if (i === ref) {
        lags.push(0)
        confidence.push(1)
        sharpness.push(1)
        inverted.push(false)
        continue
      }
      if (signals[i].length <= rate) {
        warnings.push(`${srcs[i]} has no usable audio; left at offset 0`)
        lags.push(0)
        confidence.push(0)
        sharpness.push(0)
        inverted.push(false)
        continue
      }
      const r = findLag(signals[ref], signals[i], rate, window)
      lags.push(Math.round(r.lag * 100000) / 100000)
      confidence.push(Math.round(r.confidence * 1000) / 1000)
      sharpness.push(Math.round(r.sharpness * 1000) / 1000)
      inverted.push(r.inverted)
      if (r.confidence < 0.2 || r.sharpness < 0.1) warnings.push(`${srcs[i]}: weak match (confidence ${r.confidence.toFixed(2)}); check its offset`)
    }
    // Lags were measured against the reference angle; express them against angle 0.
    const base = lags[0]
    const rel = lags.map(l => Math.round((l - base) * 100000) / 100000)

    return { offsets: offsetsFromLags(rel), lags: rel, confidence, sharpness, inverted, rate, window, analyzed: maxSeconds, warnings }
  }

  // ---------------------------------------------------------------- jobs

  const publicJob = job => {
    const { proc: _p, waiters: _w, ...rest } = job

    return rest
  }

  function publish(job) {
    ctx.broadcast('job', publicJob(job))
  }

  function newJob(kind, spec) {
    const job = { id: `${kind[0]}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, kind, spec, state: 'running', progress: 0, created: Date.now() }
    jobs.set(job.id, job)
    if (jobs.size > 60) jobs.delete(jobs.keys().next().value)
    publish(job)

    return job
  }

  function ffmpegJob(job, argv, outSeconds) {
    return new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [...argv.slice(0, -1), '-progress', 'pipe:1', '-nostats', argv.at(-1)], { stdio: ['ignore', 'pipe', 'pipe'] })
      job.proc = proc
      let err = ''
      let buf = ''
      let last = 0
      proc.stderr.on('data', d => (err = (err + d).slice(-4000)))
      proc.stdout.on('data', d => {
        buf += d
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line)
          if (m && outSeconds > 0) {
            job.progress = Math.min(0.99, Number(m[1]) / 1e6 / outSeconds)
            if (Date.now() - last > 250) {
              last = Date.now()
              publish(job)
            }
          }
        }
      })
      proc.on('close', code => {
        job.proc = null
        if (job.state === 'cancelled') reject(new Error('cancelled'))
        else if (code === 0) resolve()
        else reject(new Error(`ffmpeg: ${err.trim().split('\n').slice(-3).join(' ')}`))
      })
    })
  }

  async function finish(job, work) {
    try {
      await work()
      if (job.state === 'cancelled') throw new Error('cancelled')
      ctx.assertCurrent?.()
      job.state = 'done'
      job.progress = 1
    } catch (error) {
      if (job.state !== 'cancelled') job.state = 'failed'
      job.error = String(error.message ?? error)
      ctx.pushActivity('reel', `${job.kind} failed: ${job.error}`)
    }
    job.finished = Date.now()
    publish(job)
  }

  function clipFor(id) {
    const p = ctx.getProject()
    const found = p ? findClip(p, id) : null
    if (!found) throw new Error(`clip ${id} is gone`)

    return found.clip
  }

  async function startRender(kind, body) {
    const p = ctx.getProject()
    const src = body.src
    if (!src) throw new Error('src is required')
    const abs = ctx.resolveMedia(src)
    ctx.checkAgentFile?.(abs)
    const asset = p?.assets?.[src] ?? (await ctx.probe(src))
    ctx.assertCurrent?.()
    if (!asset.hasVideo || asset.still || !asset.duration) throw new Error(`${src} is not a video`)
    const from = Math.max(0, Number(body.in ?? 0))
    const dur = Math.min(Number(body.dur ?? asset.duration - from), asset.duration - from)
    if (!(dur > 0)) throw new Error('nothing to render: dur must be positive')
    const dir = kind === 'retime' ? 'retimed' : 'stabilized'
    let argv
    let outSeconds
    let rel
    let spec
    if (kind === 'retime') {
      const speed = Number(body.speed)
      if (!(speed >= 0.05 && speed < 1)) throw new Error('optical-flow retiming is for slow motion: speed must be 0.05 to 0.99')
      const fps = Number(body.fps ?? p?.fps ?? asset.fps ?? 30)
      outSeconds = dur / speed
      const key = await ctx.cacheKey(abs, 'retime2', from.toFixed(3), dur.toFixed(3), speed, fps)
      rel = path.join('media', dir, `${safeName(src)}-${Math.round(speed * 100)}pct-${key.slice(0, 8)}.mp4`)
      spec = { src, in: from, dur, speed, fps, clip: body.clip ?? null }
      // Read two source frames past the range (cloned at the source's end) so the last
      // interpolated frames have a frame to blend toward, then cut the output to dur / speed.
      const srcFps = asset.fps || fps
      argv = [
        '-nostdin', '-y', '-loglevel', 'error', '-ss', String(from), '-t', String(dur + 2 / srcFps), '-i', abs,
        '-map', '0:v:0', ...(asset.hasAudio ? ['-map', '0:a:0', '-af', atempoChain(speed), '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
        '-vf', `tpad=stop_mode=clone:stop=2,setpts=(PTS-STARTPTS)/${speed},minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`,
        '-t', String(outSeconds), '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      ]
    } else {
      const zoom = Math.max(1, Math.min(1.5, Number(body.zoom ?? 1)))
      outSeconds = dur
      const key = await ctx.cacheKey(abs, 'deshake1', from.toFixed(3), dur.toFixed(3), zoom)
      rel = path.join('media', dir, `${safeName(src)}-stab-${key.slice(0, 8)}.mp4`)
      spec = { src, in: from, dur, zoom, clip: body.clip ?? null }
      const vf = ['deshake=rx=64:ry=64:edge=mirror']
      if (zoom > 1) vf.push(`crop=iw/${zoom}:ih/${zoom}`, `scale=${asset.width}:${asset.height}`)
      argv = [
        '-nostdin', '-y', '-loglevel', 'error', '-ss', String(from), '-t', String(dur), '-i', abs,
        '-map', '0:v:0', ...(asset.hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
        '-vf', vf.join(','), '-t', String(dur), '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      ]
    }
    ctx.assertCurrent?.()
    const out = guardedOutput(ctx.ROOT, path.join(ctx.ROOT, rel))
    const job = newJob(kind, spec)
    job.output = rel
    const done = finish(job, async () => {
      if (!fs.existsSync(out)) {
        ctx.assertCurrent?.()
        fs.mkdirSync(guardedOutput(ctx.ROOT, path.dirname(out)), { recursive: true })
        const part = guardedOutput(ctx.ROOT, `${out}.part.mp4`)
        try {
          await ffmpegJob(job, [...argv, part], outSeconds)
          if (job.state === 'cancelled') throw new Error('cancelled')
          ctx.assertCurrent?.()
          fs.renameSync(guardedOutput(ctx.ROOT, part), guardedOutput(ctx.ROOT, out))
        } finally {
          try { fs.rmSync(guardedOutput(ctx.ROOT, part), { force: true }) } catch {}
        }
      }
      ctx.pushActivity('reel', `${kind === 'retime' ? `optical-flow ${Math.round(spec.speed * 100)}%` : 'stabilized'} render ready: ${rel}`)
      if (spec.clip) {
        try {
          await applyRender(kind, job, rel)
        } catch (error) {
          job.applyError = String(error.message ?? error)
          ctx.pushActivity('reel', `${rel} rendered but not applied: ${job.applyError}`)
        }
      }
    })
    if (body.wait) await done

    return publicJob(job)
  }

  /** Swaps the rendered file into the clip as one edit (so one undo restores it). */
  async function applyRender(kind, job, rel) {
    const { spec } = job
    const c = clipFor(spec.clip)
    const ops = []
    if (kind === 'retime') {
      // Back to the original media first when the clip already shows an earlier render.
      const orig = c.retime ? { src: c.retime.src, in: c.retime.in, speed: c.retime.speed } : { src: c.src, in: c.in ?? 0, speed: c.speed ?? 1 }
      if (orig.src !== spec.src || Math.abs(orig.in - spec.in) > 1e-3) throw new Error(`clip ${c.id} changed while rendering`)
      if (c.retime) ops.push({ op: 'update', id: c.id, set: { src: orig.src, in: orig.in, speed: orig.speed, retime: null } })
      if (Math.abs(orig.speed - spec.speed) > 1e-6) ops.push({ op: 'speed', id: c.id, speed: spec.speed })
      ops.push({ op: 'update', id: c.id, set: { src: rel, in: 0, speed: 1, retime: { mode: 'opticalFlow', src: orig.src, in: orig.in, speed: spec.speed } } })
    } else {
      const orig = c.deshake ? { src: c.deshake.src, in: c.deshake.in } : { src: c.src, in: c.in ?? 0 }
      if (orig.src !== spec.src || Math.abs(orig.in - spec.in) > 1e-3) throw new Error(`clip ${c.id} changed while rendering`)
      ops.push({ op: 'update', id: c.id, set: { src: rel, in: 0, deshake: { src: orig.src, in: orig.in, zoom: spec.zoom } } })
    }
    const r = await ctx.editOps(ops, 'reel', kind === 'retime' ? `optical-flow slow motion ${Math.round(spec.speed * 100)}% on ${c.id}` : `stabilized ${c.id} (deshake)`)
    job.applied = r.version
  }

  return {
    routes: {
      'POST /api/multicam/sync': body => sync(body),
      'POST /api/retime': body => startRender('retime', body),
      'POST /api/stabilize/render': body => startRender('stabilize', body),
      'GET /api/analysis/jobs': () => ({ jobs: [...jobs.values()].map(publicJob) }),
      'GET /api/analysis/jobs/wait': async (_b, q) => {
        const id = q.get('id')
        const until = Date.now() + Math.min(60000, Number(q.get('timeout') ?? 25000))
        for (;;) {
          const job = jobs.get(id)
          if (!job) throw new Error(`no job ${id}`)
          if (job.state !== 'running' || Date.now() >= until) return publicJob(job)
          await new Promise(r => setTimeout(r, 200))
        }
      },
      'POST /api/analysis/jobs/cancel': body => {
        const job = jobs.get(body.id)
        if (job && job.state === 'running') {
          job.state = 'cancelled'
          job.proc?.kill('SIGKILL')
          publish(job)
        }

        return { ok: true }
      },
    },
  }
}
