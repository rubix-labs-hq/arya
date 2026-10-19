import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { runProcessingProcess } from '../core/processing-process.mjs'
import { buildShortsOps, captionItems, framingKeys, proposeShorts, subjectCenters, transcriptDeleteOps, validateWords } from '../core/shorts.js'
import { guardedOutput } from '../core/output-path.js'
import { findClip } from '../core/project.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024
const cancelled = () => { const error = new Error('cancelled'); error.name = 'AbortError'; return error }
const check = signal => { if (signal?.aborted) throw cancelled() }

function sourceStamp(stat) {
  let seconds = stat.mtimeNs / 1000000000n, nanoseconds = stat.mtimeNs % 1000000000n
  if (nanoseconds < 0n) { seconds--; nanoseconds += 1000000000n }
  return { size: stat.size, seconds, nanoseconds, text: `v2|${stat.size}|${seconds}|${nanoseconds}` }
}

function matchesFingerprint(saved, stamp) {
  if (saved === stamp.text) return true
  if (typeof saved !== 'string' || saved.length > 100) return false
  const match = /^(0|[1-9][0-9]*)\|(-?(?:0|[1-9][0-9]*))\.([0-9]{3})$/.exec(saved)
  if (!match || match[0].length !== saved.length || BigInt(match[1]) !== stamp.size) return false
  const milliseconds = BigInt(match[2]), fraction = BigInt(match[3])
  const micros = milliseconds * 1000n + (match[2].startsWith('-') ? -fraction : fraction)
  let seconds = micros / 1000000n, remainder = micros % 1000000n
  if (remainder < 0n) { seconds--; remainder += 1000000n }
  // Legacy records rounded milliseconds to three decimals after floating-point conversion.
  const distance = (stamp.seconds - seconds) * 1000000000n + stamp.nanoseconds - remainder * 1000n
  return distance >= -1000n && distance <= 1000n
}

export function runTranscriptProcess(command, args, options = {}) { return runProcessingProcess(command, args, { ...options, timeout: options.timeout ?? 1800000 }) }

export function createTranscriptRoutes({ root, resolveMedia, getProject, getVersion, apply, newJob, publish, findWhisper, process = runTranscriptProcess, modelPaths, assertPublication, admit, captureProcessing, assertCapacity }) {
  const directory = path.join(root, '.reel', 'transcripts')
  const running = new Map()
  const cleanLocale = value => {
    const locale = String(value ?? 'en-US')
    if (locale.length > 64 || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(locale)) throw new Error('Use a language tag such as en-US or es-ES')
    return Intl.getCanonicalLocales(locale)[0]
  }
  const source = (src, locale) => {
    src = String(src ?? '')
    const asset = getProject()?.assets?.[src]
    if (!asset?.hasAudio || !Number.isFinite(asset.duration) || asset.duration <= 0) throw new Error('Import a finite-duration source with audio first')
    if (asset.duration > 14400) throw new Error('Transcription supports recordings up to four hours')
    const file = resolveMedia(src), stat = fs.statSync(file, { bigint: true })
    if (!stat.isFile()) throw new Error('The transcript source is not a file')
    const stamp = sourceStamp(stat), fingerprint = stamp.text
    const jobKey = digest(JSON.stringify([fs.realpathSync(file), fingerprint, locale]))
    const key = createHash('sha1').update([src, locale].join('|')).digest('hex').slice(0, 16)
    return { src, locale, file, duration: asset.duration, fingerprint, stamp, jobKey, output: path.join(directory, `${key}.json`) }
  }
  const ensure = () => fs.mkdirSync(guardedOutput(root, directory), { recursive: true })
  const unchanged = info => {
    const now = source(info.src, info.locale)
    if (now.fingerprint !== info.fingerprint) throw new Error('The source changed while transcribing. Transcribe it again.')
  }
  const read = info => {
    const file = guardedOutput(root, info.output)
    if (!fs.existsSync(file)) return { src: info.src, locale: info.locale, words: [], revision: 0, status: 'missing', onDevice: true, provider: 'whisper.cpp' }
    if (fs.statSync(file).size > MAX_TRANSCRIPT_BYTES) throw new Error('The saved transcript is larger than 16 MB')
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (value.src !== info.src || value.locale !== info.locale || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('The saved transcript does not match this source and language')
    if (!matchesFingerprint(value.fingerprint, info.stamp)) return { src: info.src, locale: info.locale, words: [], revision: value.revision, status: 'stale', warning: 'The source changed. Transcribe it again before using the saved words.' }
    return { ...value, src: info.src, locale: info.locale, words: validateWords(value.words, info.duration) }
  }
  const save = (info, words, revision, metadata = {}, allowStale = false) => {
    ensure(); unchanged(info)
    const previous = read(info)
    if (previous.status === 'stale' && !allowStale) throw new Error('The source changed. Transcribe it again before saving corrections.')
    if (revision !== undefined && revision !== previous.revision) throw new Error('The transcript changed. Reload it before saving corrections.')
    const valid = validateWords(words, info.duration)
    const value = { ...previous, ...(previous.status === 'missing' ? { provider: 'manual' } : {}), ...metadata, src: info.src, locale: info.locale, words: valid, revision: previous.revision + 1, fingerprint: info.fingerprint, status: metadata.status ?? (['missing', 'stale'].includes(previous.status) ? 'complete' : previous.status), updatedAt: Date.now() }
    if (previous.status === 'stale') delete value.warning
    const encoded = JSON.stringify(value)
    if (Buffer.byteLength(encoded) > MAX_TRANSCRIPT_BYTES) throw new Error('The transcript is larger than 16 MB')
    const temp = path.join(directory, `${randomUUID()}.json.part`)
    try {
      fs.writeFileSync(guardedOutput(root, temp), encoded, { flag: 'wx', mode: 0o600 })
      unchanged(info)
      assertPublication?.()
      fs.renameSync(guardedOutput(root, temp), guardedOutput(root, info.output))
      return value
    } finally { try { fs.rmSync(guardedOutput(root, temp), { force: true }) } catch {} }
  }
  const model = () => (modelPaths ?? [processEnvModel(), path.join(globalThis.process.env.HOME ?? '', '.reel/models/ggml-base.bin'), path.join(globalThis.process.env.HOME ?? '', '.reel/models/ggml-base.en.bin'), '/opt/homebrew/share/whisper-cpp/ggml-base.bin', '/opt/homebrew/share/whisper-cpp/ggml-base.en.bin']).filter(Boolean).find(file => fs.existsSync(file) && fs.statSync(file).isFile())
  const capability = async () => {
    const binary = await findWhisper(), file = model()
    return { available: Boolean(binary && file), durable: true, jobs: true, provider: 'whisper.cpp', onDevice: true, locales: file?.endsWith('.en.bin') ? ['en-US', 'en-GB'] : [], reason: !binary ? 'Install whisper.cpp to transcribe locally.' : !file ? 'Download a whisper.cpp model to ~/.reel/models/ggml-base.bin.' : undefined }
  }
  const transcribe = async body => {
    const guard = captureProcessing?.() ?? {}
    const locale = cleanLocale(body.locale), info = source(body.src, locale)
    const active = running.get(info.jobKey)
    if (active) return body.wait === false ? publicJob(active.job) : active.promise
    const binary = await findWhisper(), modelFile = model()
    const startedMeanwhile = running.get(info.jobKey)
    if (startedMeanwhile) return body.wait === false ? publicJob(startedMeanwhile.job) : startedMeanwhile.promise
    if (!binary) throw new Error('Transcription needs whisper.cpp. Install whisper-cpp and a model first.')
    if (!modelFile) throw new Error('Download a whisper.cpp model to ~/.reel/models/ggml-base.bin first.')
    if (modelFile.endsWith('.en.bin') && !locale.toLowerCase().startsWith('en')) throw new Error('The installed English model only recognizes English. Install a multilingual whisper.cpp model for this language.')
    guard.assertCurrent?.(); assertCapacity?.()
    const job = newJob('transcript', { src: info.src, locale }), controller = new AbortController()
    Object.defineProperty(job, 'cancel', { value: () => controller.abort() })
    const previousRevision = read(info).revision
    const temp = path.join(directory, `job-${randomUUID()}`)
    const work = async () => {
      try {
        check(controller.signal)
        ensure(); fs.mkdirSync(guardedOutput(root, temp), { mode: 0o700 })
        job.state = 'running'; job.progress = 0; job.message = 'Preparing audio'; publish(job)
        const wav = path.join(temp, 'speech.wav'), prefix = path.join(temp, 'words')
        guardedOutput(root, wav)
        await process('ffmpeg', ['-nostdin', '-n', '-loglevel', 'error', '-i', info.file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { signal: controller.signal })
        check(controller.signal); guardedOutput(root, wav); guardedOutput(root, `${prefix}.json`)
        job.message = 'Recognizing speech'; publish(job)
        await process(binary, ['-m', modelFile, '-f', wav, '-l', locale.split('-')[0].toLowerCase(), '-oj', '-ml', '1', '-sow', '-of', prefix], { signal: controller.signal })
        check(controller.signal); unchanged(info)
        const recognized = guardedOutput(root, `${prefix}.json`)
        if (fs.statSync(recognized).size > MAX_TRANSCRIPT_BYTES) throw new Error('The recognized transcript is larger than 16 MB')
        const raw = JSON.parse(fs.readFileSync(recognized, 'utf8'))
        const words = (raw.transcription ?? []).map(segment => ({ t: Number(segment.offsets?.from) / 1000, end: Number(segment.offsets?.to) / 1000, text: String(segment.text ?? '').trim() })).filter(word => word.text && word.end > word.t)
        check(controller.signal)
        if (job.state === 'failed') throw cancelled()
        const result = save(info, words, previousRevision, { status: 'complete', onDevice: true, provider: 'whisper.cpp', warnings: [] }, true)
        job.state = 'done'; job.progress = 1; job.finished = Date.now(); job.result = result; job.message = 'Transcript saved'; publish(job)
        return result
      } catch (error) {
        if (job.state !== 'done') { job.state = 'failed'; job.error = error.message; job.finished = Date.now(); publish(job) }
        throw error
      } finally {
        running.delete(info.jobKey)
        try { fs.rmSync(guardedOutput(root, temp), { recursive: true, force: true }) } catch {}
      }
    }
    const promise = (admit ? admit(work, { ...guard, signal: controller.signal, onState: state => { job.admissionState = state; publish(job) } }) : work()).catch(error => { if (job.state !== 'done') { job.state = 'failed'; job.error = error.message; job.finished = Date.now(); publish(job) }; running.delete(info.jobKey); throw error })
    running.set(info.jobKey, { job, promise })
    promise.catch(() => {})
    return body.wait === false ? publicJob(job) : promise
  }
  const wordsFor = async (body, allowTranscribe = false) => {
    const info = source(body.src, cleanLocale(body.locale))
    if (body.words !== undefined) return { ...info, words: validateWords(body.words, info.duration) }
    const saved = read(info)
    if (!['complete', 'ready', 'partial'].includes(saved.status)) {
      if (allowTranscribe) return { ...info, words: (await transcribe({ src: info.src, locale: info.locale })).words }
      throw new Error('Transcribe this source first, then generate captions or shorts.')
    }
    return { ...info, words: saved.words }
  }
  // Samples each range at up to 4 frames a second as small grayscale frames and finds where the
  // subject is (subjectCenters), for a crop narrower than the source. Undefined when the crop
  // already shows the full width.
  const subjectFraming = async (info, body) => {
    const asset = getProject()?.assets?.[info.src]
    const width = Number(body.width ?? 1080), height = Number(body.height ?? 1920)
    if (!asset?.hasVideo || !(asset.width > 0 && asset.height > 0)) return undefined
    const visible = (width / height) / (asset.width / asset.height)
    if (!(visible < 0.98)) return undefined
    const W = 96, H = Math.max(16, Math.round((W * asset.height) / asset.width / 2) * 2)
    const out = []
    for (const range of body.ranges) {
      const from = Number(range.from), to = Number(range.to)
      const fps = Math.min(4, Math.max(0.5, 120 / (to - from)))
      let stdout
      // A source that cannot be sampled keeps the centre crop for that range.
      try { ({ stdout } = await process('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(from), '-t', String(to - from), '-i', info.file, '-map', '0:v:0', '-an', '-vf', `fps=${fps},scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', timeout: 120000 })) } catch { out.push(null); continue }
      const frames = []
      for (let o = 0; o + W * H <= stdout.length; o += W * H) frames.push(stdout.subarray(o, o + W * H))
      const { centers } = subjectCenters(frames, W, H, visible)
      out.push(centers.length ? framingKeys(centers, centers.map((_, i) => i / fps), asset, { width, height }) : null)
    }
    return out
  }
  const checkVersion = body => {
    if (body.expectedVersion !== undefined && Number(body.expectedVersion) !== getVersion()) throw new Error('The project changed. Review the result again before applying it.')
  }
  // Short reviews bind source identity and saved corrections independently of project edits.
  const shortsSource = (body, captions = true) => {
    checkVersion(body)
    const info = source(body.src, cleanLocale(body.locale)), saved = read(info)
    if (body.expectedSourceFingerprint !== undefined && (typeof body.expectedSourceFingerprint !== 'string' || !matchesFingerprint(body.expectedSourceFingerprint, info.stamp))) throw new Error('The source changed. Reload the transcript and review the short compositions again.')
    if (body.expectedTranscriptRevision !== undefined && (!Number.isSafeInteger(body.expectedTranscriptRevision) || body.expectedTranscriptRevision <= 0 || !['complete', 'ready', 'partial'].includes(saved.status) || body.expectedTranscriptRevision !== saved.revision)) throw new Error('The transcript changed. Reload it and review the short compositions again.')
    let words = []
    if (captions) {
      if (body.words === undefined && !['complete', 'ready', 'partial'].includes(saved.status)) throw new Error('Transcribe this source first, then generate captions or shorts.')
      words = validateWords(body.words ?? saved.words, info.duration)
      if (body.expectedTranscriptRevision !== undefined && body.words !== undefined) {
        const textAndTiming = list => list.map(({ t, end, text }) => ({ t, end, text }))
        if (JSON.stringify(textAndTiming(words)) !== JSON.stringify(textAndTiming(saved.words))) throw new Error('The reviewed transcript words changed. Save and review them again.')
      }
    }
    return { ...info, words, sourceFingerprint: saved.fingerprint ?? info.fingerprint, transcriptRevision: saved.revision }
  }
  return {
    capability, transcribe,
    get: (_body, query) => {
      const record = read(source(query.get('src'), cleanLocale(query.get('locale') ?? undefined)))
      if (!query.has('offset') && !query.has('limit')) return record
      const offset = Number(query.get('offset') ?? 0), requested = Number(query.get('limit') ?? 500)
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requested) || requested < 1) throw new Error('Transcript pages need a nonnegative offset and a positive integer limit')
      const limit = Math.min(1000, requested), totalWords = record.words.length
      const end = Math.min(totalWords, offset + limit)
      return { ...record, words: record.words.slice(offset, end), offset, totalWords, nextOffset: end < totalWords ? end : null }
    },
    save: body => save(source(body.src, cleanLocale(body.locale)), body.words, body.revision),
    edit: body => {
      const result = transcriptDeleteOps(getProject(), body)
      if (body.apply) { checkVersion(body); return { ...result, ...apply(result.ops, 'Lifted the transcript passage from the selected clip') } }
      return { ...result, version: getVersion() }
    },
    captions: async body => {
      const src = body.src ?? (body.id ? findClip(getProject(), body.id)?.clip?.src : undefined)
      if (!src) throw new Error('give src or id for a clip that plays media')
      body = { ...body, src }
      const guarded = body.expectedSourceFingerprint !== undefined || body.expectedTranscriptRevision !== undefined
      const info = guarded ? shortsSource(body) : await wordsFor(body, true), project = getProject()
      const result = captionItems(project, info.src, info.words, body)
      if (!result.items.length) throw new Error('The transcript has no words inside the selected timeline clips')
      const ops = [{ op: 'captions', ...(result.comp ? { comp: result.comp } : {}), items: result.items, track: body.track, replace: body.replace, style: result.style, burnIn: body.burnIn !== false }]
      const basis = guarded ? { sourceFingerprint: info.sourceFingerprint, transcriptRevision: info.transcriptRevision } : {}
      if (guarded) { unchanged(info); shortsSource(body) }
      if (body.apply) { checkVersion(body); return { ...result, ...basis, ops, src: info.src, words: info.words.length, ...apply(ops, 'Made captions from the transcript') } }
      return { ...result, ...basis, ops, src: info.src, words: info.words.length, version: getVersion() }
    },
    propose: async body => {
      const info = shortsSource(body)
      return { ...proposeShorts(info.words, body), src: info.src, locale: info.locale, version: getVersion(), sourceFingerprint: info.sourceFingerprint, transcriptRevision: info.transcriptRevision }
    },
    build: async body => {
      const info = shortsSource(body, body.captions !== false)
      // reframe: 'subject' keeps the moving subject in a narrower crop instead of the centre.
      let framing
      if (body.reframe === 'subject') {
        buildShortsOps(getProject(), { ...body, words: info.words })
        framing = await subjectFraming(info, body)
        checkVersion(body)
      }
      const result = { ...buildShortsOps(getProject(), { ...body, words: info.words, framing }), sourceFingerprint: info.sourceFingerprint, transcriptRevision: info.transcriptRevision, reframed: (framing ?? []).map(f => (f ? (f.keys ? f.keys.length : 1) : 0)) }
      unchanged(info); checkVersion(body)
      if (body.apply) return { ...result, ...apply(result.ops, `Made ${result.comps.length} short compositions`) }
      return { ...result, version: getVersion() }
    },
  }
}

function processEnvModel() { return globalThis.process.env.REEL_WHISPER_MODEL }
function publicJob(job) {
  return { id: job.id, kind: job.kind, state: job.state, progress: job.progress, message: job.message, error: job.error, result: job.result, spec: job.spec, created: job.created }
}

export default ctx => ({ routes: {
  'GET /api/transcript': ctx.transcripts.get,
  'POST /api/transcript': ctx.transcripts.save,
  'POST /api/transcript/edit': ctx.transcripts.edit,
  'POST /api/shorts/propose': ctx.transcripts.propose,
  'POST /api/shorts/build': ctx.transcripts.build,
} })
