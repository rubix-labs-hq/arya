// Audio routes: cleaned copies of a source's sound and two-pass EBU R128 loudness measurement.
//
//   POST /api/audio/clean    { src, strength?, detail?, quality?, noiseFrom?, noiseTo?, mode: 'denoise' | 'voice', id? }
//        → { path, asset, mode, cached }   path is project-relative, under media/cleaned/
//   POST /api/audio/loudnorm { src, target = -23, tp = -1, lra = 11, in?, dur?, id?, expectedVersion? }
//        → { gain, target, input { i, tp, lra, thresh, loudnormI }, output { i, tp, lra }, linear, peakOver }
//        Two loudnorm passes (measure, then linear normalization) report true peak, LRA and
//        whether linear gain fits; `gain` is target minus the ebur128 integrated loudness.
//
// With `id`, clean also points that audio clip at the cleaned file and loudnorm sets its volume
// to `gain`. Cleanup saves Media before a separate undoable placement.
// The cleaned file covers the whole source, so the clip's
// in point and duration stay valid.
//
// Both modes first measure the source's noise floor and set afftdn's floor from it. Voice
// cleanup adds band limits and gentle compression. ffmpeg's arnndn would need an RNNoise
// model file shipped in the repo, and none is bundled.

import fs from 'node:fs'
import path from 'node:path'
import { guardedOutput } from '../core/output-path.js'
import { cleanRecipe, cleanSettings } from '../core/audio-cleanup.js'

const CHAIN_VERSION = 5

/** CPU FFT cleanup. Native cleanup uses a different spectral subtraction algorithm. */
export function cleanChain(mode, floorDb, input = {}) {
  if (!['denoise', 'voice'].includes(mode)) return null
  const options = cleanSettings(input)
  const nf = Math.round(Math.max(-80, Math.min(-30, floorDb + 30 - options.detail * 12)))
  const nr = Math.max(0.01, options.strength * 30)
  const gs = { fast: 0, balanced: 3, high: 6 }[options.quality]
  const denoise = options.strength === 0 ? 'anull' : `afftdn=nr=${nr}:nf=${nf}:gs=${gs}`
  return mode === 'voice' ? `${denoise},highpass=f=80,lowpass=f=12000,acompressor=threshold=-24dB:ratio=2.5:attack=10:release=150:makeup=1.258925` : denoise
}

function sourceTimeline(duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The video source timeline needs a finite positive duration')
  return `aresample=48000:async=1:first_pts=0:min_hard_comp=0,apad,atrim=duration=${duration.toFixed(6)},asetpts=PTS-STARTPTS`
}

export function cleanFilter(mode, floorDb, options, videoDuration) {
  const chain = cleanChain(mode, floorDb, options)
  if (!chain) throw new Error('mode must be denoise or voice')
  const prefix = videoDuration == null ? '' : `${sourceTimeline(videoDuration)},`
  const span = videoDuration == null ? '' : `,apad,atrim=duration=${videoDuration.toFixed(6)}`
  if (options.noiseFrom == null || options.strength === 0) return ['-af', `${prefix}${chain}${span}`]
  // Normalize video PTS before profile selection, then remove the priming segment.
  const seconds = value => value.toFixed(6)
  const length = options.noiseTo - options.noiseFrom
  const profile = `[0:a]${prefix}asplit=2[noiseInput][sourceInput];[noiseInput]atrim=start=${seconds(options.noiseFrom)}:end=${seconds(options.noiseTo)},asetpts=PTS-STARTPTS[noise];[sourceInput]asetpts=PTS-STARTPTS[source];[noise][source]concat=n=2:v=0:a=1,asendcmd=c='0 afftdn sn start;${seconds(length)} afftdn sn stop',${chain},atrim=start=${seconds(length)},asetpts=PTS-STARTPTS${span}[clean]`
  return ['-filter_complex', profile, '-map', '[clean]']
}

/** The noise floor (dB RMS) of a source: the 10th percentile of its 100 ms windows, ignoring digital silence. */
export function floorOf(levels) {
  const usable = levels.filter(v => Number.isFinite(v) && v > -110).sort((a, b) => a - b)

  return usable.length ? usable[Math.floor(usable.length * 0.1)] : -80
}

/** The last JSON object ffmpeg printed (loudnorm's print_format=json). */
export function lastJson(text) {
  const end = text.lastIndexOf('}')
  const start = text.lastIndexOf('{', end)
  if (start < 0 || end < 0) throw new Error('loudnorm printed no measurement')

  return JSON.parse(text.slice(start, end + 1))
}

function findClip(p, id) {
  const scopes = [p.tracks, ...Object.values(p.comps ?? {}).map(k => k.tracks ?? [])]
  for (const tracks of scopes) for (const t of tracks) for (const c of t.clips) if (c.id === id) return c

  return null
}

export default function audioRoutes(ctx) {
  const { ROOT, run, probe, resolveMedia, cacheKey, editOps, getProject, once, pushActivity } = ctx

  async function noiseFloor(abs, options, videoDuration) {
    const probeChain = 'asetnsamples=n=4800:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-'
    const profileTrim = options.noiseFrom == null ? '' : `atrim=start=${options.noiseFrom.toFixed(6)}:end=${options.noiseTo.toFixed(6)},asetpts=PTS-STARTPTS,`
    const filter = videoDuration == null ? probeChain : `${sourceTimeline(videoDuration)},${profileTrim}${probeChain}`
    const input = videoDuration == null ? (options.noiseFrom == null ? [] : ['-ss', String(options.noiseFrom), '-t', String(options.noiseTo - options.noiseFrom)]) : ['-copyts', '-start_at_zero']
    const { stdout } = await run('ffmpeg', ['-nostdin', '-loglevel', 'error', ...input, '-i', abs, '-vn', '-ac', '1', '-ar', '48000', '-af', filter, '-f', 'null', '-'])
    return floorOf([...String(stdout).matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map(m => Number(m[1])))
  }

  async function clean(body) {
    const mode = body.mode ?? 'denoise'
    if (!['denoise', 'voice'].includes(mode)) throw new Error(`unknown clean mode ${mode} (denoise, voice)`)
    let options = cleanSettings(body)
    if (typeof body.src !== 'string' || !body.src) throw new Error('src must be a nonempty string')
    if (body.apply !== undefined && typeof body.apply !== 'boolean') throw new Error('apply must be a Boolean')
    if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)) throw new Error('expectedVersion must be a nonnegative safe integer')
    const initial = getProject(), initialVersion = ctx.getVersion(), generation = ctx.getProjectGeneration()
    if (!initial) throw new Error('Open a project before processing audio')
    if (body.expectedVersion !== undefined && body.expectedVersion !== initialVersion) throw new Error('The project changed. Review the current version before cleanup.')
    const requestedID = body.clip ?? body.id
    if (requestedID !== undefined && (typeof requestedID !== 'string' || !requestedID)) throw new Error('id must be a nonempty string')
    if (body.comp !== undefined && body.comp !== null && (typeof body.comp !== 'string' || !body.comp)) throw new Error('comp must be a composition ID or null')
    const scopes = Object.hasOwn(body, 'comp') ? [[body.comp ?? null, body.comp == null ? initial : initial.comps?.[body.comp]]] : [[null, initial], ...Object.entries(initial.comps ?? {})]
    if (scopes.some(([, scope]) => !scope)) throw new Error(`no composition ${body.comp}`)
    const matches = scopes.flatMap(([comp, scope]) => (scope.tracks ?? []).flatMap(track => (track.clips ?? []).filter(clip => clip.id === requestedID).map(clip => ({ comp, track, clip }))))
    if (requestedID && matches.length !== 1) throw new Error(matches.length ? 'Clip ID is ambiguous. Specify comp, using null for the main timeline.' : `no clip ${requestedID}`)
    const target = requestedID && body.apply !== false ? matches[0] : null
    if (target && (target.clip.kind !== 'audio' || target.track.locked)) throw new Error('Cleanup placement needs an unlocked audio clip')
    if (target && target.clip.src !== body.src) throw new Error('The cleanup source does not match the requested clip')
    const assertOriginalProject = () => {
      ctx.assertCurrent?.()
      if (ctx.getProjectGeneration() !== generation || !getProject()) throw new Error('The project was replaced during cleanup. The output was not registered in the new project.')
    }
    const abs = resolveMedia(body.src)
    const stamp = () => { const info = fs.statSync(abs, { bigint: true }); return `${info.dev}|${info.ino}|${info.size}|${info.mtimeNs}|${info.ctimeNs}` }
    const sourceStamp = stamp()
    const assertInput = () => {
      assertOriginalProject()
      if (resolveMedia(body.src) !== abs || stamp() !== sourceStamp) throw new Error('The cleanup input source changed. The output was not registered in Media.')
    }
    const input = await probe(body.src)
    assertInput()
    if (input?.hasAudio !== true || !Number.isFinite(input.duration) || input.duration <= 0) throw new Error('The cleanup source has no valid audio duration. The output was not registered in Media.')
    const sourceDuration = input.duration
    const videoDuration = input.hasVideo === true ? sourceDuration : undefined
    // Compressed source timestamps can include codec padding that PCM conversion removes.
    const durationTolerance = Math.max(0.05, 2 / 48000)
    options = cleanSettings(options, sourceDuration)
    const key = await cacheKey(abs, 'clean', mode, CHAIN_VERSION, sourceStamp, JSON.stringify({ sourceDuration, timeline: videoDuration == null ? 'decoded-stream-origin' : 'container-origin-silence-padded' }), JSON.stringify(options))
    const name = `${path.parse(abs).name.replace(/[^\w.-]+/g, '-')}-${mode}-${key.slice(0, 8)}.wav`
    const rel = path.join('media', 'cleaned', name)
    assertInput()
    const out = guardedOutput(ROOT, path.join(ROOT, rel))
    const cached = fs.existsSync(out)
    let floor
    if (!cached) {
      await once(`clean:${out}`, async () => {
        assertInput()
        fs.mkdirSync(guardedOutput(ROOT, path.dirname(out)), { recursive: true })
        pushActivity('reel', `cleaning ${body.src} (${mode})`)
        if (options.strength > 0) floor = await noiseFloor(abs, options, videoDuration)
        assertInput()
        const tmp = guardedOutput(ROOT, `${out}.part.wav`)
        try {
          await run('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', ...(videoDuration == null ? [] : ['-copyts', '-start_at_zero']), '-i', abs, '-vn', ...cleanFilter(mode, floor ?? -80, options, videoDuration), '-ar', '48000', '-c:a', 'pcm_s24le', tmp])
          assertInput()
          fs.renameSync(guardedOutput(ROOT, tmp), guardedOutput(ROOT, out))
        } finally { try { fs.rmSync(guardedOutput(ROOT, tmp), { force: true }) } catch {} }
      })
    }
    assertInput()
    const measured = await probe(rel)
    if (measured?.hasAudio !== true || !Number.isFinite(measured.duration) || measured.duration <= 0) throw new Error('The cleaned output has no valid audio duration. It was not registered in Media.')
    if (Math.abs(measured.duration - sourceDuration) > durationTolerance) throw new Error('The cleaned output duration does not match the complete source. It was not registered in Media.')
    const recipe = cleanRecipe(body.src, rel, mode, options, 'ffmpeg-afftdn-cpu')
    const existing = getProject()?.assets?.[rel]
    const asset = { ...(existing ?? {}), ...measured, processing: { kind: 'audio-cleanup', ...recipe, compute: 'cpu', sourceStamp } }
    const result = { path: rel, asset, mode, cached, settings: options, engine: recipe.engine, recipe, placementRequested: !!target, ...(target ? { applied: false } : {}), assetRegistered: false, ...(floor !== undefined ? { noiseFloor: Math.round(floor * 10) / 10 } : {}) }
    try {
      assertInput()
      const beforeVersion = ctx.getVersion()
      const placementCurrent = beforeVersion === initialVersion && getProject() === initial
      let admissionVersion = beforeVersion
      if (JSON.stringify(existing) !== JSON.stringify(asset)) {
        const registered = await editOps([{ op: 'import', assets: { [rel]: asset } }], 'reel', `Saved cleaned audio in Media`, { expectedVersion: beforeVersion })
        admissionVersion = registered.version
      }
      result.assetRegistered = true; result.admissionVersion = admissionVersion; result.version = admissionVersion
      if (!target) return result
      try {
        assertInput()
        if (!placementCurrent || ctx.getVersion() !== admissionVersion) throw new Error('The target changed during cleanup. The output is saved in Media; review it before placing it.')
        const placed = await editOps([
          { op: 'update', id: requestedID, comp: target.comp, set: { audioCleanup: null } },
          { op: 'update', id: requestedID, comp: target.comp, set: { src: rel, audioCleanup: recipe } },
        ], 'reel', `cleaned ${requestedID} (${mode})`, { expectedVersion: admissionVersion })
        result.applied = true; result.version = placed.version
      } catch (error) { result.applyError = error.message }
    } catch (error) { result.registrationError = error.message; result.applied = false }
    return result
  }

  async function loudnorm(body) {
    if (!body.src) throw new Error('src is required')
    if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)) throw new Error('expectedVersion must be a nonnegative safe integer')
    if (body.expectedVersion !== undefined && body.expectedVersion !== ctx.getVersion?.()) throw new Error('The project changed. Review the current version before normalizing.')
    const abs = resolveMedia(body.src)
    const target = Number(body.target ?? -23)
    const tp = Number(body.tp ?? -1)
    const lra = Number(body.lra ?? 11)
    if (!Number.isFinite(tp) || tp < -9 || tp > 0 || !Number.isFinite(lra) || lra < 1 || lra > 50) throw new Error('True peak must be -9 to 0 dB and LRA must be 1 to 50 LU')
    if (body.in !== undefined && (!Number.isFinite(Number(body.in)) || Number(body.in) < 0) || body.dur !== undefined && (!Number.isFinite(Number(body.dur)) || Number(body.dur) <= 0 || Number(body.dur) > 3600)) throw new Error('Use a finite nonnegative audio range of at most one hour')
    if (!(target >= -70 && target <= -5)) throw new Error('target must be between -70 and -5 LUFS')
    const range = []
    if (body.in !== undefined) range.push('-ss', String(Math.max(0, Number(body.in))))
    if (body.dur !== undefined) range.push('-t', String(Math.max(0.1, Number(body.dur))))
    const pass = async filter => {
      const { stderr } = await run('ffmpeg', ['-nostdin', '-hide_banner', ...range, '-i', abs, '-vn', '-af', filter, '-f', 'null', '-'], { allowFail: true })

      return lastJson(String(stderr))
    }
    const integrated = async () => {
      const { stderr } = await run('ffmpeg', ['-nostdin', '-hide_banner', ...range, '-i', abs, '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { allowFail: true })
      const m = /I:\s*([-\d.]+) LUFS/.exec(String(stderr).split('Summary:').pop() ?? '')

      return m ? Number(m[1]) : -Infinity
    }
    const [first, i] = await Promise.all([pass(`loudnorm=I=${target}:TP=${tp}:LRA=${lra}:print_format=json`), integrated()])
    if (!Number.isFinite(i) || i < -70) throw new Error(`${body.src} is silent (${first.input_i} LUFS)`)
    const second = await pass(
      `loudnorm=I=${target}:TP=${tp}:LRA=${lra}:measured_I=${first.input_i}:measured_TP=${first.input_tp}:measured_LRA=${first.input_lra}:measured_thresh=${first.input_thresh}:offset=${first.target_offset}:linear=true:print_format=json`,
    )
    // loudnorm's own meter can read a few tenths of an LU off BS.1770 (it measures at 192 kHz),
    // so the gain comes from ebur128, the meter exports are judged by.
    // The gain never lifts the true peak over the ceiling (tp, default -1 dBTP), as the native app
    // does. Peaky material then lands below the LUFS target; peakLimited says so, and the master
    // limiter can take it the rest of the way.
    const requestedGain = Math.round((target - i) * 100) / 100
    const inputTp = Number(first.input_tp)
    const safeGain = Number.isFinite(inputTp) ? Math.min(requestedGain, tp - inputTp) : requestedGain
    const gain = Math.round(safeGain * 100) / 100
    const result = {
      gain,
      requestedGain,
      target,
      input: { i, tp: inputTp, lra: Number(first.input_lra), thresh: Number(first.input_thresh), loudnormI: Number(first.input_i) },
      output: { i: Math.round((i + gain) * 100) / 100, tp: Math.round((inputTp + gain) * 100) / 100, lra: Number(second.output_lra) },
      linear: true,
      // How far the true peak would have passed the ceiling at the requested gain (dB, 0 when it fits).
      peakOver: Math.max(0, Math.round((inputTp + requestedGain - tp) * 100) / 100),
      peakLimited: gain < requestedGain,
    }
    if (body.id) {
      const clip = findClip(getProject() ?? { tracks: [] }, body.id)
      if (!clip) throw new Error(`no clip ${body.id}`)
      // Measuring takes several ffmpeg passes. Set the gain only on a clip that still plays the measured source.
      const measured = (() => { try { return resolveMedia(clip.src) === abs } catch { return false } })()
      if (!measured) throw new Error(`${body.id} no longer plays ${body.src}. Measure it again before normalizing.`)
      // A caller that named a version gets that version or a conflict, never a later one.
      await editOps([{ op: 'update', id: body.id, set: { volume: Math.round(gain * 10) / 10 } }], 'reel', `${body.id} to ${target} LUFS`, body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion })
    }

    return result
  }

  return {
    routes: {
      'POST /api/audio/clean': body => ctx.admit ? ctx.admit(() => clean(body)) : clean(body),
      'POST /api/audio/loudnorm': body => ctx.admit ? ctx.admit(() => loudnorm(body)) : loudnorm(body),
    },
  }
}
