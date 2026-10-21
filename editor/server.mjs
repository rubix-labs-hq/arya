// Reel media server: serves the editor, owns the project file, generates media
// derivatives with ffmpeg, runs render jobs, and hosts separate assistant CLI runs.
//
// node server.mjs --root <project folder> [--port 4870]

import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareLibraryOps, verifyLibraryInputs } from './core/library-resources.js'
import { applyOps, compView, duration, migrate, newProject, outline, OPS_DOC } from './core/project.js'
import { describeFocus } from './core/describe.js'
import { thumbnailPlan } from './core/thumbnail-plan.js'
import { guardedOutput } from './core/output-path.js'
import { captureExportSources, prepareExportCohort, createExportDestination } from './core/export-cohort.mjs'
import { DeliveryHistory, deliveryOpenArguments } from './core/delivery-history.js'
import { writeProjectAtomic } from './core/project-persistence.mjs'
import { storeMediaUpload } from './core/media-upload.mjs'
import { colorCapabilities } from './routes/color.mjs'
import { createProcessingAdmission, captureProcessingIdentity, processingCancelled } from './core/processing-admission.mjs'
import { runProcessingProcess } from './core/processing-process.mjs'
import { reserveProcessingWorker, armProcessingWorkerCancellation, acknowledgeProcessingWorkerExit, processingWorkerConnected, retireProcessingWorkerClients, createWorkerWatchdog, noteWorkerActivity, workerClock, WORKER_CHECK_MS } from './core/processing-worker.mjs'
import { validateExportSpec } from './core/processing-export.js'
import { ProjectRecovery, recoveryProject } from './core/project-recovery.mjs'
import { runRecoveryJournal } from './core/project-recovery-bridge.mjs'
import { createTranscriptRoutes } from './routes/transcript.mjs'
import { createBrowserAssistant, confinedFile } from './agent/browser-assistant.mjs'
import { createChatHistory } from './agent/chat-history.mjs'
import { createAssistantReview } from './agent/assistant-review.mjs'
import { isAryaMusicAsset, musicAssetRecord } from './core/music-score.js'
import { prepareMusicReimport } from './music/reimport.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const ROOT = path.resolve(args.root ?? process.cwd())
const PORT = Number(args.port ?? process.env.PORT ?? 4870)
const FILE = path.join(ROOT, 'reel.project.json')
const DOT = path.join(ROOT, '.reel')
const CACHE = path.join(DOT, 'cache')
let pluginSession = args.plugin === 'true'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

fs.mkdirSync(guardedOutput(ROOT, CACHE), { recursive: true })

// ---------------------------------------------------------------- state

let project = null
let version = 0
let projectEpoch = 0
const assistantCalls = new AsyncLocalStorage()
const processing = createProcessingAdmission()
const musicCompositions = new WeakMap()
let lastText = ''
const recovery = new ProjectRecovery(ROOT, { journal: runRecoveryJournal })
let recoveryState = null
const past = []
const future = []
const activity = []
const clients = new Set()
const bridgeQueue = []
const chatHistory = createChatHistory({ root: ROOT, diagnostic: message => log('assistant history', message) })
const chat = chatHistory.messages()
let claude = { state: 'idle', text: '' }
let uiState = { playhead: 0, selection: [], page: 'edit' }
// The latest assistant change for one-step undo, and the pending preview in Preview changes mode.
const assistantReview = createAssistantReview({ getVersion: () => version, getEpoch: () => projectEpoch, getProject: () => project, onChange: value => broadcast('assistantReview', value, 'ui') })
let lastPoll = 0
const jobs = new Map()
const deliveries = new DeliveryHistory(ROOT, () => Object.entries(project?.assets ?? {}).flatMap(([src, asset]) => [src, asset?.proxy].filter(v => typeof v === 'string')))
let worker = null
let workerIdleTimer = null

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a)
}

// Restore display messages only. Run state and plugin queues always start fresh.
function appendChat(message) {
  try { const next = chatHistory.append(message); chat.splice(0, chat.length, ...next) }
  catch { log('assistant history', 'A message could not be retained because its display history shape or size was invalid.') }
  broadcast('chatHistory', chatHistory.status(), 'ui')
}

function loadFromDisk() {
  const observed = recovery.observe()
  if (observed.status !== 'valid') {
    if (project && (observed.token !== recoveryState?.token || observed.status !== recoveryState?.status)) projectEpoch++
    recoveryState = observed
    return
  }
  recoveryState = observed
  const text = observed.text
  if (text === lastText) return
  try {
    const next = migrate(recoveryProject(text))
    if (project) {
      rememberProject(project)
      future.length = 0
    }
    project = next
    projectEpoch++
    lastText = text
    version++
    recovery.warning = null
    try { recovery.capture(text, 'published', [], observed.sha256) }
    catch (error) { recovery.warning = error.message; log('project recovery:', error.message) }
  } catch (error) {
    log('project file is not valid JSON:', error.message)
  }
}

function rememberProject(previous) {
  past.push(previous)
  if (past.length > 200) past.splice(0, past.length - 200)
}

function persist(next) {
  const text = `${JSON.stringify(next, null, 2)}\n`
  recoveryProject(text)
  const observed = recovery.assertExpected(lastText || null)
  // The snapshot of the previous file is a safety copy, not a condition for saving. A copied or
  // moved project folder, or full recovery storage, still saves and reports the warning instead.
  // The warning describes the latest save, so a condition that has cleared stops being reported.
  recovery.warning = null
  let prior = null
  if (observed.text !== null) {
    try { prior = recovery.capture(observed.text, 'published', [], observed.sha256) }
    catch (error) { recovery.warning = error.message; log('project recovery:', error.message) }
  }
  const receipt = writeProjectAtomic(ROOT, text, observed.text, observed.fileIdentity)
  try { recovery.capture(text, 'published', prior ? [prior.id] : [], observed.sha256) }
  catch (error) { recovery.warning = error.message; log('project recovery:', error.message) }
  return { text, ...receipt }
}

function publishRecovery(prepared) {
  const observed = recovery.assertExpected(prepared.expectedText, { allowInvalid: true })
  if (observed.token !== prepared.observedToken) throw new Error('The project changed before recovery publication')
  recoveryProject(prepared.text)
  const receipt = writeProjectAtomic(ROOT, prepared.text, prepared.expectedText, prepared.expectedIdentity)
  return { text: prepared.text, ...receipt }
}

function restoreRecovery(body) {
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion !== version) throw new Error('The project changed. Refresh recovery before restoring it')
  const prepared = recovery.prepareRestore(body)
  const publication = commit(migrate(prepared.project), 'you', ['restored a recovery snapshot'], { recoveryPrepared: prepared, projectChanged: true })
  recoveryState = recovery.observe()
  return { project, version, publication, recovery: { ...recovery.list(), version } }
}

function broadcast(event, data, role) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const c of clients) {
    if (role && c.role !== role) continue
    try { c.res.write(line) } catch { clients.delete(c) }
  }
}

function pushActivity(who, text) {
  const entry = { who, text, at: Date.now() }
  activity.push(entry)
  if (activity.length > 200) activity.shift()
  broadcast('activity', entry)
}

function captureProcessing() {
  const origin = assistantCalls.getStore()
  const disk = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null
  if (disk !== (lastText || null)) throw new Error('The project changed on disk. Reload before starting processing.')
  return captureProcessingIdentity(() => ({ epoch: projectEpoch, version, disk: fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null }), () => {
    if (origin && (fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') !== lastText : !!lastText)) {
      loadFromDisk()
      throw new Error('The project changed on disk while the assistant tool ran. Review the latest outline before retrying.')
    }
    origin?.assertCurrent()
  })
}

function admit(work, options = {}) { return processing.run(work, { ...captureProcessing(), ...options }) }
// Filmstrips, waveform peaks and preview audio are cached by source content and never written
// into the project. An edit made while one renders must not discard it; capacity still applies.
function admitSourceDerivative(work) { return processing.run(work) }

// Only composition may retain a completed asset after an ordinary edit. Its private
// scope cannot place clips or change the generic processing/assistant write policy.
function admitMusicCompose(work) {
  if (processing.current()) throw new Error('Music composition requires its own processing reservation')
  const origin = assertAssistantPublication(), generation = projectEpoch, originalVersion = version
  const assertCurrent = () => {
    origin?.assertCurrent()
    recovery.assertRoot()
    if (!project || projectEpoch !== generation) throw new Error('The original project was replaced while music was composing')
    if ((fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null) !== (lastText || null)) throw new Error('The project changed on disk while music was composing')
  }
  assertCurrent()
  return processing.run(async lease => {
    const check = () => {
      if (lease.closed || processing.current() !== lease || musicCompositions.get(lease) !== scope) throw new Error('This music composition reservation has drained')
      lease.check()
    }
    const currentCall = () => origin ? { ...origin, version } : undefined
    let owned
    const assertOwned = rendered => {
      if (!owned || rendered !== owned.receipt || rendered.path !== owned.path || rendered.contentSHA256 !== owned.digest ||
          rendered.validateIdentity !== owned.validateIdentity || JSON.stringify(rendered.score) !== owned.score) throw new Error('Register only the WAV probed by this composition')
    }
    const scope = {
      assertCurrent: check,
      assertRoot: () => recovery.assertRoot(),
      async probe(rendered) {
        check()
        if (owned || typeof rendered?.validateIdentity !== 'function' ||
            typeof rendered.path !== 'string' || !/^media\/generated\/music\/[0-9a-f-]{36}\/score\.wav$/.test(rendered.path)) throw new Error('Probe only the owned WAV from this composition')
        const captured = Object.freeze({ receipt: rendered, path: rendered.path, digest: rendered.contentSHA256, score: JSON.stringify(rendered.score), validateIdentity: rendered.validateIdentity })
        await rendered.validateIdentity()
        check()
        owned = captured
        return assistantCalls.run(currentCall(), () => probe(rendered.path))
      },
      async register(rendered, score, asset) {
        check()
        assertOwned(rendered)
        await owned.validateIdentity()
        check()
        assertOwned(rendered)
        const registered = musicAssetRecord(score, { ...rendered, asset })
        if (typeof rendered.contentSHA256 !== 'string' || rendered.contentSHA256 !== registered.generated.contentSHA256 ||
            rendered.sampleRate !== 48000 || rendered.channels !== 2 || rendered.frames * 6 + 44 !== registered.generated.contentBytes ||
            asset.size !== registered.generated.contentBytes || JSON.stringify(rendered.score) !== JSON.stringify(registered.generated.score)) throw new Error('Register only a complete owned WAV for this score')
        if (project.assets?.[rendered.path] !== undefined) throw new Error('This generated path already belongs to a Media asset')
        const expectedVersion = version
        const result = await assistantCalls.run(currentCall(), () => routes['POST /api/ops']({ ops: [{ op: 'import', assets: { [rendered.path]: registered } }],
          expectedVersion, who: 'agent', summary: `Created ${registered.name} in Media`, returnProject: false }))
        if (origin && expectedVersion === originalVersion && origin.version === originalVersion && result.version === expectedVersion + 1) origin.version = result.version
        return { ...result, asset: registered, placementCurrent: expectedVersion === originalVersion }
      },
    }
    musicCompositions.set(lease, scope)
    try { return await work() }
    finally { musicCompositions.delete(lease) }
  }, { assertCurrent, accept: assertCurrent })
}

function musicComposeContext() {
  const lease = processing.current(), scope = lease && musicCompositions.get(lease)
  if (!scope) throw new Error('Music composition has no owned processing reservation')
  scope.assertCurrent()
  return scope
}

function assertAssistantPublication() {
  processing.current()?.check()
  const call = assistantCalls.getStore()
  if (call && (fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') !== lastText : !!lastText)) {
    loadFromDisk()
    throw new Error('The project changed on disk while the assistant tool ran. Review the latest outline before retrying.')
  }
  call?.assertCurrent()
  if (call && call.version !== version) throw new Error('The project changed while the assistant tool ran. Review the latest outline before retrying.')
  return call
}

function commit(next, who, lines, options = {}) {
  const call = assertAssistantPublication()
  if (call?.review) throw new Error('Preview changes is on, so this request cannot change the project directly. Send the edit to POST /api/assistant/propose {ops, summary} for the user to review.')
  if (call) who = 'agent'
  const publication = options.recoveryPrepared ? publishRecovery(options.recoveryPrepared) : persist(next)
  const previous = project
  if (options.historyMove === 'undo') {
    past.pop()
    future.push(previous)
  } else if (options.historyMove === 'redo') {
    future.pop()
    rememberProject(previous)
  } else if (project && options.history !== false) {
    rememberProject(project)
    future.length = 0
  }
  project = next
  if (options.projectChanged) projectEpoch++
  version++
  if (call) { call.version = version; call.acceptIdentity(projectEpoch) }
  lastText = publication.text
  // A commit outside the active request or preview apply makes that change unsafe to undo whole.
  assistantReview.commitBy(call)
  processing.current()?.accept()
  try {
    if (!publication.directorySynced) log('Project saved, but the directory flush failed:', publication.warningCode)
    broadcast('project', { project, version, who })
    for (const line of lines.slice(-8)) pushActivity(who, line)
  } catch { /* Notification failure does not reverse a published edit. */ }
  return { directorySynced: publication.directorySynced, ...(publication.warningCode ? { warningCode: publication.warningCode } : {}) }
}

loadFromDisk()
fs.watchFile(FILE, { interval: 700 }, () => {
  const before = version
  loadFromDisk()
  if (version !== before) {
    broadcast('project', { project, version, who: 'disk' })
    pushActivity('claude', 'reel.project.json changed on disk')
  }
})

// ---------------------------------------------------------------- helpers

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4',
  '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.cube': 'text/plain',
}

const MEDIA_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mxf|mts|mp3|m4a|wav|aac|aif|aiff|flac|ogg|png|jpe?g|gif|webp|heic|tiff?|bmp)$/i
// Not .ts: TypeScript source shares that extension; MPEG transport streams use .m2ts or .mts here.
const EXTERNAL_FILE_EXT = new RegExp(`${MEDIA_EXT.source.slice(0, -2)}|mpe?g|m2ts|3gp|3g2|wmv|dng|exr|cube|ttf|otf|woff2?)$`, 'i')
// Open hands a file to macOS, which would also run scripts, Terminal settings, installers and
// links. Only the kinds of file Arya itself makes or imports are opened.
const OPENABLE_EXT = new RegExp(`${MEDIA_EXT.source.slice(0, -2)}|srt|vtt|otio|fcpxml|cube)$`, 'i')
const UNTRUSTED_FILE_HEADERS = { 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'" }

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json' : 'text/plain', 'cache-control': 'no-store', ...headers })
  res.end(data)
}

async function readBody(req, limit = 1e9) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

async function readJson(req) {
  const buf = await readBody(req, 50e6)

  return buf.length ? JSON.parse(buf.toString('utf8')) : {}
}

// .mts names both AVCHD transport streams and TypeScript modules. Outside the project an .mts
// file must carry two packet sync bytes (0x47): 188-byte packets at 0 and 188, or 192-byte
// packets at 4 and 196.
function transportStreamOrOther(file) {
  if (!/\.mts$/i.test(file)) return true
  const head = Buffer.alloc(200), fd = fs.openSync(file, 'r')
  let count = 0
  try { count = fs.readSync(fd, head, 0, 200, 0) } finally { fs.closeSync(fd) }
  return count === 200 && (head[0] === 0x47 && head[188] === 0x47 || head[4] === 0x47 && head[196] === 0x47)
}

function resolveMedia(rel) {
  if (assistantCalls.getStore()) { assertAssistantPublication(); return confinedFile(ROOT, rel) }
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel)
  const norm = path.resolve(abs)
  // Inside the project folder, or a path the project already references.
  if (!norm.startsWith(ROOT + path.sep) && !(project && Object.keys(project.assets).some(k => path.resolve(path.isAbsolute(k) ? k : path.join(ROOT, k)) === norm))) throw new Error(`media outside the project: ${rel}`)
  // Resolve symlinks. A missing file is placed under its nearest existing folder's real path,
  // so it is held to the same rule as an existing one when it is created later.
  let real = null
  for (let folder = norm; real === null; folder = path.dirname(folder)) {
    try { real = path.join(fs.realpathSync(folder), path.relative(folder, norm)) }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' || path.dirname(folder) === folder) throw new Error(`media outside the project: ${rel}`) }
  }
  const root = fs.realpathSync(ROOT)
  if (real === root || real.startsWith(root + path.sep)) return norm
  // A registered path or a symlink may reach media, LUTs or fonts elsewhere, but never another kind of file.
  // Return the checked real path, so a symlink swapped in afterwards is not followed.
  if (EXTERNAL_FILE_EXT.test(real) && (!fs.existsSync(real) || fs.statSync(real).isFile() && transportStreamOrOther(real))) return real
  throw new Error(`media outside the project: ${rel}`)
}

// A cache entry is served only when its real path stays inside the real cache folder, so a
// symlink placed in a shared project's .reel/cache cannot expose another file.
function cacheFile(rel) {
  try {
    const file = path.join(CACHE, path.normalize(decodeURIComponent(rel)).replace(/^(\.\.[/\\])+/, ''))
    const root = fs.realpathSync(CACHE), real = fs.realpathSync(file)
    if (real.startsWith(root + path.sep)) return real
  } catch {}
  return null
}

function serveFile(req, res, file, headers = {}) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return send(res, 404, 'not found')
  }
  // A directory or device would make the read stream fail after the headers are sent.
  if (!stat.isFile()) return send(res, 404, 'not found')
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  const stream = options => fs.createReadStream(file, options).on('error', () => res.destroy()).pipe(res)
  // One satisfiable "bytes=a-b", "bytes=a-" or "bytes=-n" range; anything else gets the whole file.
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim())
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]))
    const end = m[1] && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1
    if (!(start <= end) || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}`, ...headers })
      return res.end()
    }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'accept-ranges': 'bytes', ...headers })
    stream({ start, end })

    return
  }
  res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes', 'cache-control': type.startsWith('text/javascript') || type.startsWith('text/html') || type.startsWith('text/css') ? 'no-cache' : 'max-age=3600', ...headers })
  stream()
}

function run(cmd, argv, options = {}) {
  return admit(lease => lease.child(() => runProcessingProcess(cmd, argv, { ...options, signal: lease.signal })))
}

const hashOf = (...parts) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)

async function cacheKey(abs, ...extra) {
  const st = await fsp.stat(abs)

  return hashOf(abs, st.size, st.mtimeMs, ...extra)
}

const inflight = new Map()
function once(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)))

  return inflight.get(key)
}

// ---------------------------------------------------------------- media analysis

const PLAYABLE = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1'])

async function probe(rel) {
  const abs = resolveMedia(rel)
  const { stdout } = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', abs])
  const info = JSON.parse(stdout)
  const v = info.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const a = info.streams?.find(s => s.codec_type === 'audio')
  const fmtDur = Number(info.format?.duration ?? 0)
  const still = Boolean(v) && (!fmtDur || /image2|png_pipe|jpeg_pipe|webp_pipe|gif|tiff_pipe|bmp_pipe/.test(info.format?.format_name ?? '') && Number(v.nb_frames ?? 1) <= 1)
  const [fn, fd] = String(v?.avg_frame_rate ?? v?.r_frame_rate ?? '0/1').split('/').map(Number)
  const rotation = Number(v?.tags?.rotate ?? v?.side_data_list?.find(s => s.rotation !== undefined)?.rotation ?? 0)
  const asset = {
    duration: still ? undefined : Math.round(fmtDur * 1000) / 1000,
    width: v?.width,
    height: v?.height,
    fps: fd ? Math.round((fn / fd) * 1000) / 1000 : undefined,
    codec: v?.codec_name ?? a?.codec_name,
    pixFmt: v?.pix_fmt,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    channels: a?.channels,
    still: still || undefined,
    rotation: rotation || undefined,
    size: Number(info.format?.size ?? 0),
  }
  if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) [asset.width, asset.height] = [asset.height, asset.width]
  const needsProxy = v && !still && (!PLAYABLE.has(v.codec_name) || /422|444|12le/.test(v.pix_fmt ?? '') && v.codec_name === 'h264')
  if (needsProxy) asset.proxy = `.reel/proxies/${await cacheKey(abs)}.mp4`
  if (v && still && !/png|mjpeg|jpeg|webp|gif|bmp/.test(v.codec_name ?? '')) asset.proxy = `.reel/proxies/${await cacheKey(abs)}.png`

  return asset
}

async function ensureProxy(rel, asset) { return processing.submit(() => makeProxy(rel, asset), captureProcessing()).promise }

async function makeProxy(rel, asset) {
  if (!asset.proxy) return
  const out = path.join(ROOT, asset.proxy)
  if (fs.existsSync(out)) return
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const abs = resolveMedia(rel)
  await once(`proxy:${out}`, async () => {
    pushActivity('reel', `making a playable proxy for ${rel}`)
    const tmp = `${out}.part${path.extname(out)}`
    if (out.endsWith('.png')) await run('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', abs, '-frames:v', '1', tmp])
    else {
      await run('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', abs, '-map', '0:v:0', '-map', '0:a?', '-vf', "scale='min(1920,iw)':-2", '-c:v', 'h264_videotoolbox', '-b:v', '12M', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp])
    }
    assertAssistantPublication()
    fs.renameSync(tmp, out)
    broadcast('media', { src: rel, proxy: asset.proxy })
    pushActivity('reel', `proxy ready for ${rel}`)
  })
}

async function filmstrip(rel, high = false) {
  const asset = project?.assets[rel] ?? (await probe(rel))
  const abs = resolveMedia(asset.proxy && asset.proxy.endsWith('.mp4') && fs.existsSync(path.join(ROOT, asset.proxy)) ? asset.proxy : rel)
  const key = await cacheKey(abs, high ? 'strip4-high' : 'strip4')
  const dir = guardedOutput(ROOT, path.join(CACHE, key))
  const meta = guardedOutput(ROOT, path.join(dir, 'strip.json'))
  const jpeg = guardedOutput(ROOT, path.join(dir, 'strip.jpg'))
  if (fs.existsSync(meta)) return JSON.parse(fs.readFileSync(meta, 'utf8'))

  return once(`strip:${key}`, async () => {
    fs.mkdirSync(guardedOutput(ROOT, dir), { recursive: true })
    const part = guardedOutput(ROOT, path.join(dir, `strip-${randomUUID()}.part.jpg`))
    const publish = data => {
      assertAssistantPublication()
      fs.renameSync(guardedOutput(ROOT, part), guardedOutput(ROOT, jpeg))
      const temporary = guardedOutput(ROOT, path.join(dir, `strip-${randomUUID()}.part.json`))
      try {
        fs.writeFileSync(temporary, JSON.stringify(data), { flag: 'wx' })
        fs.renameSync(guardedOutput(ROOT, temporary), guardedOutput(ROOT, meta))
      } finally { try { fs.unlinkSync(guardedOutput(ROOT, temporary)) } catch {} }
      return data
    }
    try {
    const { w, h, count, interval } = thumbnailPlan(asset, high)
    if (asset.still || !interval) {
      await run('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', abs, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=lanczos`, '-q:v', high ? '2' : '4', part])
      const data = { url: `/cache/${key}/strip.jpg`, interval: 0, count: 1, w, h }
      return publish(data)
    }
    const filter = `fps=1/${interval.toFixed(6)},scale=${w}:${h}:flags=lanczos,tile=${count}x1`
    await run('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', ...high ? [] : ['-skip_frame', 'nokey'], '-i', abs, '-an', '-vf', filter, '-frames:v', '1', '-q:v', high ? '2' : '5', part], { allowFail: true })
    if (!fs.existsSync(guardedOutput(ROOT, part))) {
      await run('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', abs, '-an', '-vf', filter, '-frames:v', '1', '-q:v', high ? '2' : '5', part])
    }
    const data = { url: `/cache/${key}/strip.jpg`, interval, count, w, h }
    return publish(data)
    } finally { try { fs.unlinkSync(guardedOutput(ROOT, part)) } catch {} }
  })
}

async function peaks(rel) {
  const abs = resolveMedia(rel)
  const key = await cacheKey(abs, 'peaks2')
  const file = path.join(CACHE, key, 'peaks.json')
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))

  return once(`peaks:${key}`, async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const rate = 16000
    const perSec = 100
    const { stdout } = await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', abs, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'], { encoding: 'buffer' })
    const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2))
    const bucket = rate / perSec
    const n = Math.ceil(samples.length / bucket)
    const out = new Array(n)
    for (let i = 0; i < n; i++) {
      let max = 0
      const end = Math.min(samples.length, (i + 1) * bucket)
      for (let j = i * bucket; j < end; j++) {
        const v = Math.abs(samples[j])
        if (v > max) max = v
      }
      out[i] = Math.round((max / 32768) * 255)
    }
    const data = { perSec, peaks: out }
    assertAssistantPublication()
    fs.writeFileSync(file, JSON.stringify(data))

    return data
  })
}

async function audioRange(rel, from, dur) {
  if (!Number.isFinite(from) || from < 0 || !Number.isFinite(dur) || dur <= 0 || dur > 3600) throw new Error('Audio range must be finite, nonnegative and at most one hour')
  const abs = resolveMedia(rel)
  const key = await cacheKey(abs, 'wav-stereo-energy-v2', from.toFixed(3), dur.toFixed(3))
  const file = path.join(CACHE, 'audio', `${key}.wav`)
  if (fs.existsSync(file)) return file
  fs.mkdirSync(path.dirname(file), { recursive: true })

  return once(`wav:${key}`, async () => {
    await run('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-ss', String(Math.max(0, from)), '-t', String(dur), '-i', abs, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', `${file}.part.wav`])
    assertAssistantPublication()
    fs.renameSync(`${file}.part.wav`, file)

    return file
  })
}

// Analysis settings become part of an ffmpeg filter string, so only bounded finite numbers pass.
function analysisNumber(value, fallback, min, max, name) {
  const number = value === undefined || value === null ? fallback : typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${name} must be a number from ${min} to ${max}`)
  return number
}

async function analyze(rel, kind, options = {}) {
  const abs = resolveMedia(rel)
  if (kind === 'scenes') {
    const threshold = analysisNumber(options.threshold, 10, 0, 100, 'threshold')
    const { stderr } = await run('ffmpeg', ['-nostdin', '-i', abs, '-an', '-vf', `scale=320:-2,scdet=t=${threshold}`, '-f', 'null', '-'], { allowFail: true })
    const times = [...stderr.matchAll(/lavfi\.scd\.time:\s*([\d.]+)/g)].map(m => Number(m[1]))

    return { kind, times }
  }
  if (kind === 'silence') {
    const noise = analysisNumber(options.noise, -32, -90, 0, 'noise')
    const min = analysisNumber(options.min, 0.45, 0.01, 60, 'min')
    const { stderr } = await run('ffmpeg', ['-nostdin', '-i', abs, '-vn', '-af', `silencedetect=n=${noise}dB:d=${min}`, '-f', 'null', '-'], { allowFail: true })
    const ranges = []
    let open = null
    for (const line of stderr.split('\n')) {
      const s = /silence_start:\s*([-\d.]+)/.exec(line)
      const e = /silence_end:\s*([\d.]+)/.exec(line)
      if (s) open = Math.max(0, Number(s[1]))
      if (e && open !== null) {
        ranges.push([open, Number(e[1])])
        open = null
      }
    }

    return { kind, ranges }
  }
  if (kind === 'beats') {
    // Onset detection on a low-passed energy envelope: peaks of rising energy.
    const rate = 11025
    const { stdout } = await run('ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', abs, '-vn', '-ac', '1', '-ar', String(rate), '-af', 'lowpass=f=180', '-f', 's16le', 'pipe:1'], { encoding: 'buffer' })
    const s = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2))
    const hop = 256
    const env = []
    for (let i = 0; i + hop <= s.length; i += hop) {
      let e = 0
      for (let j = i; j < i + hop; j++) e += (s[j] / 32768) ** 2
      env.push(Math.sqrt(e / hop))
    }
    const flux = env.map((v, i) => Math.max(0, v - (env[i - 1] ?? 0)))
    const win = 43
    const times = []
    let last = -1
    for (let i = 0; i < flux.length; i++) {
      let mean = 0
      let n = 0
      for (let j = Math.max(0, i - win); j < Math.min(flux.length, i + win); j++) {
        mean += flux[j]
        n++
      }
      mean /= n
      const isPeak = flux[i] > mean * 2.2 && flux[i] >= (flux[i - 1] ?? 0) && flux[i] >= (flux[i + 1] ?? 0) && flux[i] > 0.004
      const t = (i * hop) / rate
      if (isPeak && t - last > 0.22) {
        times.push(Math.round(t * 1000) / 1000)
        last = t
      }
    }
    const intervals = times.slice(1).map((t, i) => t - times[i]).filter(d => d > 0.25 && d < 1.5).sort((a, b) => a - b)
    const med = intervals[Math.floor(intervals.length / 2)]

    return { kind, times, bpm: med ? Math.round(60 / med) : undefined }
  }
  if (kind === 'loudness') {
    const { stderr } = await run('ffmpeg', ['-nostdin', '-i', abs, '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { allowFail: true })
    const i = /I:\s*([-\d.]+) LUFS/.exec(stderr.split('Summary:').pop() ?? '')
    const lra = /LRA:\s*([-\d.]+) LU/.exec(stderr.split('Summary:').pop() ?? '')

    return { kind, lufs: i ? Number(i[1]) : undefined, lra: lra ? Number(lra[1]) : undefined }
  }
  if (kind === 'transcript') return transcribe(rel)
  throw new Error(`unknown analysis ${kind}`)
}

async function whisperBinary() {
  for (const b of ['whisper-cli', 'whisper-cpp']) {
    const { code } = await run('/usr/bin/which', [b], { allowFail: true })
    if (code === 0) return b
  }

  return null
}

async function transcribe(rel) {
  return transcriptService.transcribe({ src: rel })
}

// ---------------------------------------------------------------- render worker (headless Chrome)

function workerConnected() {
  return processingWorkerConnected(worker, clients)
}

async function ensureWorker(signal) {
  const until = Date.now() + 20000
  while (!workerConnected()) {
    if (signal?.aborted) throw processingCancelled()
    if (!worker) {
      log('starting the render worker')
      worker = spawn(CHROME, [
        '--headless=new', '--use-angle=metal', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--mute-audio', '--no-first-run',
        `--user-data-dir=${path.join(DOT, 'chrome')}`, '--window-size=1280,800', `http://127.0.0.1:${PORT}/?worker=1`,
      ], { stdio: 'ignore' })
      const ownedWorker = worker
      ownedWorker.on('exit', () => {
        retireProcessingWorkerClients(clients, ownedWorker)
        if (worker === ownedWorker) worker = null
        acknowledgeProcessingWorkerExit(jobs.values(), ownedWorker, failJob)
      })
    }
    if (Date.now() > until) throw new Error('the render worker did not start')
    await new Promise(r => setTimeout(r, 150))
  }
}

function touchWorker() {
  clearTimeout(workerIdleTimer)
  workerIdleTimer = setTimeout(() => {
    if (processing.snapshot().active || [...jobs.values()].some(j => j.state === 'running' || j.state === 'queued')) return touchWorker()
    if (worker) { worker.processingStopping = true; worker.kill() }
  }, 5 * 60 * 1000)
}

const PRESETS = {
  'h264-high': { ext: 'mp4', v: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high'], a: ['-c:a', 'aac', '-b:a', '320k'] },
  'h264-web': { ext: 'mp4', v: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p'], a: ['-c:a', 'aac', '-b:a', '192k'] },
  'h264-fast': { ext: 'mp4', v: ['-c:v', 'h264_videotoolbox', '-b:v', '20M', '-pix_fmt', 'yuv420p'], a: ['-c:a', 'aac', '-b:a', '256k'] },
  'hevc': { ext: 'mp4', v: ['-c:v', 'hevc_videotoolbox', '-b:v', '16M', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'], a: ['-c:a', 'aac', '-b:a', '256k'] },
  'prores-422': { ext: 'mov', v: ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le'], a: ['-c:a', 'pcm_s24le'] },
  'prores-422hq': { ext: 'mov', v: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'], a: ['-c:a', 'pcm_s24le'] },
  'prores-4444': { ext: 'mov', v: ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le'], a: ['-c:a', 'pcm_s24le'] },
  'gif': { ext: 'gif', v: ['-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer'], a: null },
  'audio-wav': { ext: 'wav', v: null, a: ['-c:a', 'pcm_s24le'] },
  'audio-m4a': { ext: 'm4a', v: null, a: ['-c:a', 'aac', '-b:a', '256k'] },
  'png-seq': { ext: 'png', v: ['-c:v', 'png'], a: null, sequence: true },
}

function newJob(kind, spec) {
  const id = `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const job = { id, kind, spec, state: 'queued', progress: 0, created: Date.now() }
  if (jobs.size >= 128) for (const [previousID, previous] of jobs) { if (['done', 'failed'].includes(previous.state) && (!previous.processing || previous.admissionState === 'drained')) { jobs.delete(previousID); if (jobs.size < 128) break } }
  jobs.set(id, job)
  assistantCalls.getStore()?.registerJob?.({ id, path: '/api/jobs/cancel' })

  return job
}

function jobPublic(job) {
  const { ffmpeg: _f, resolve: _r, reject: _j, exportSources: _s, exportDestination: _d, ...rest } = job

  return rest
}

function checkExportOutput(file, sequence = false) {
  const out = guardedOutput(ROOT, file), directory = path.dirname(out)
  if (!out.startsWith(path.join(ROOT, 'renders') + path.sep)) throw new Error('Export outputs must stay inside the project renders folder.')
  for (const [src, asset] of Object.entries(project?.assets ?? {})) for (const value of [src, asset.proxy].filter(value => typeof value === 'string')) {
    const source = path.resolve(ROOT, value)
    if (source === out || sequence && source.startsWith(directory + path.sep)) throw new Error('An export cannot overwrite source media referenced by the project.')
  }
  if (sequence && fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) guardedOutput(ROOT, path.join(directory, name))
  return out
}

function queueWorkerJob(job, snapshot, guard) {
  const state = reserveProcessingWorker(processing, job, {
    ...guard, ensureWorker: async signal => {
      const check = () => { guard.assertCurrent(); if (signal.aborted) throw new Error('Export cancelled') }
      const cohort = await prepareExportCohort(ROOT, job.exportSources, check)
      job.exportSources = cohort
      job.spec.sourceCohort = cohort.receipt
      for (const key of Object.keys(snapshot)) delete snapshot[key]
      Object.assign(snapshot, cohort.project)
      await ensureWorker(signal)
      check()
    },
    dispatch: (_job, reservation) => {
      guard.assertCurrent()
      touchWorker()
      if (job.kind === 'export') job.exportDestination.assertCurrent()
      reservation.worker = worker
      job.lastWorkerActivity = job.workerDispatchedAt = performance.now()
      reservation.payload = { job: jobPublic(job), project: snapshot, version: job.projectVersion }
      broadcast('render', reservation.payload, 'worker')
    },
    cancel: () => {
      broadcast('cancel', { id: job.id }, 'worker')
      const ownedWorker = worker
      if (ownedWorker) job.processing.cancelWorker = armProcessingWorkerCancellation(ownedWorker, { isCurrent: () => worker === ownedWorker, isDrained: () => job.processing.drained })
    },
    waitEncoder: () => job.done ?? Promise.resolve(),
    onState: state => { job.admissionState = state; if (job.kind !== 'export' || job.state !== 'done') broadcast('job', jobPublic(job)) },
  })
  state.ticket.promise.catch(error => failJob(job, error)).finally(() => {
    state.cancelWorker?.(); state.cancelWorker = null
    state.worker = null; state.payload = null; state.ticket = null; state.assertCurrent = () => { throw new Error('This worker reservation has drained') }
    delete job.ffmpeg; delete job.done
    for (const owned of [job.exportSources, job.exportDestination]) try { owned?.cleanup?.() } catch { job.cleanupWarning = 'An export stage changed or could not be removed. Its files were retained.' }
    delete job.exportSources; delete job.exportDestination
    cleanupExportAudio(job)
  })
}

async function startExport(spec) {
  if (!project) throw new Error('no project')
  const preset = PRESETS[spec.preset ?? 'h264-high']
  if (!preset) throw new Error(`unknown preset ${spec.preset}`)
  processing.assertCapacity()
  const guard = captureProcessing()
  const selected = spec.comp ? compView(project, spec.comp) : project
  if (!selected) throw new Error('no such composition')
  const validated = validateExportSpec({ ...spec, range: spec.range ?? selected.range ?? { in: 0, out: duration(selected) } }, selected)
  delete validated.sourceCohort
  const base = String(spec.name ?? selected.name).replace(/[^\w.-]+/g, '-') || 'reel'
  const outDir = guardedOutput(ROOT, path.join(ROOT, 'renders'))
  // A name that is already taken gets the next free number (clip-2.mp4, clip-3.mp4), as Final Cut
  // and Resolve do, instead of failing. An explicit `out` path is never renamed.
  const named = n => preset.sequence ? path.join(outDir, `${n}-frames`, 'frame_%05d.png') : path.join(outDir, `${n}.${preset.ext}`)
  // Names held by queued or running exports count as taken too, so two queued exports with the
  // same default name do not both render to one file and fail the second at the end.
  const held = new Set([...jobs.values()].filter(j => j.kind === 'export' && ['queued', 'running'].includes(j.state)).map(j => j.spec.out))
  const taken = n => held.has(named(n)) || fs.existsSync(preset.sequence ? path.dirname(named(n)) : named(n))
  let free = base
  for (let i = 2; !spec.out && i <= 1000 && taken(free); i++) free = `${base}-${i}`
  const out = checkExportOutput(spec.out ? path.resolve(ROOT, spec.out) : named(free), preset.sequence)
  guard.assertCurrent()
  const captured = captureExportSources(ROOT, project)
  const destination = createExportDestination(ROOT, out, { sequence: !!preset.sequence, references: Object.entries(project.assets ?? {}).flatMap(([src, asset]) => [src, asset?.proxy].filter(value => typeof value === 'string')) })
  const snapshot = structuredClone(project)
  const job = newJob('export', { ...validated, preset: spec.preset ?? 'h264-high', out })
  job.projectVersion = version
  job.exportSources = captured
  job.exportDestination = destination
  job.audioFile = path.join(DOT, `${job.id}.wav`)
  try { queueWorkerJob(job, snapshot, guard) } catch (error) { destination.cleanup(); jobs.delete(job.id); throw error }
  pushActivity('reel', `export queued: ${path.relative(ROOT, out)}`)
  return job
}

function cleanupExportAudio(job) {
  if (!job.audioFile || job.processing?.audioCleaned) return
  try {
    fs.rmSync(guardedOutput(ROOT, job.audioFile), { force: true })
    if (job.processing) job.processing.audioCleaned = true
  } catch { job.cleanupWarning = 'The temporary export audio could not be removed. Its file was retained.' }
}

function startEncoder(job) {
  const preset = PRESETS[job.spec.preset]
  const { width, height, fps, out } = job.spec
  checkExportOutput(out, preset.sequence)
  job.exportDestination.assertCurrent()
  const argv = ['-nostdin', '-n', '-loglevel', 'error']
  if (preset.v) argv.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0')
  const hasAudio = preset.a && fs.existsSync(job.audioFile)
  if (hasAudio) argv.push('-i', job.audioFile)
  if (preset.v) {
    const vf = ['vflip']
    const custom = preset.v.indexOf('-vf')
    const vargs = [...preset.v]
    if (custom >= 0) {
      vf.push(vargs[custom + 1])
      vargs.splice(custom, 2)
    }
    argv.push('-vf', vf.join(','), ...vargs)
  }
  if (hasAudio) argv.push(...preset.a, '-shortest')
  if (preset.v && hasAudio) argv.push('-map', '0:v', '-map', '1:a')
  if (preset.ext === 'mp4' || preset.ext === 'mov' || preset.ext === 'm4a') argv.push('-movflags', '+faststart')
  argv.push(job.exportDestination.output)
  const ff = spawn('ffmpeg', argv, { stdio: ['pipe', 'ignore', 'pipe'] })
  let err = ''
  ff.stderr.on('data', d => (err = (err + d).slice(-1024 * 1024)))
  ff.stdin.on('error', () => {})
  job.ffmpeg = ff
  job.done = new Promise(resolve => {
    ff.once('error', error => { err = error.message })
    ff.once('close', code => {
      if (job.processing) { clearTimeout(job.processing.encoderKillTimer); job.processing.encoderKillTimer = null; job.processing.encoderClosed = true }
      cleanupExportAudio(job)
      resolve({ code, err })
    })
  })
}

async function finishExport(job) {
  if (job.state === 'done' || job.state === 'failed') return
  if (job.finishing) return
  job.finishing = true
  job.processing?.assertCurrent()
  job.ffmpeg.stdin.end()
  const { code, err } = await job.done
  if (job.state === 'done' || job.state === 'failed') return
  if (code !== 0) throw new Error(`ffmpeg: ${err.slice(-500)}`)
  if (job.state === 'done' || job.state === 'failed') return
  job.processing?.assertCurrent()
  await job.exportSources.assertCurrent(() => job.processing.assertCurrent())
  job.processing.assertCurrent()
  checkExportOutput(job.spec.out, PRESETS[job.spec.preset].sequence)
  job.exportSources.assertCurrentSync(() => job.processing.assertCurrent())
  job.exportDestination.publish(job.spec.frames)
  job.outputState = job.exportDestination.state
  cleanupExportAudio(job)
  job.state = 'done'
  job.progress = 1
  job.finished = Date.now()
  job.output = path.relative(ROOT, job.spec.out)
  try { deliveries.record(job.output, job.spec, job.finished) }
  catch { job.deliveryWarning = 'Export saved, but its completion receipt could not be recorded. Refresh delivery history to find the existing output.' }
  broadcast('job', jobPublic(job))
  pushActivity('reel', `exported ${job.output} in ${((job.finished - job.created) / 1000).toFixed(1)}s`)
}

function failJob(job, error) {
  if (job.state === 'done' || job.state === 'failed') return
  job.cancel?.()
  job.processing?.ticket?.cancel()
  job.state = 'failed'
  job.error = String(error?.message ?? error)
  if (job.exportDestination) { job.outputState = job.exportDestination.state; job.partialOutputs = job.exportDestination.published }
  if (job.ffmpeg && !job.processing?.encoderClosed) {
    const encoder = job.ffmpeg
    encoder.kill('SIGTERM')
    if (job.processing) job.processing.encoderKillTimer = setTimeout(() => encoder.kill('SIGKILL'), 1500)
  }
  broadcast('job', jobPublic(job))
  pushActivity('reel', `job failed: ${job.error}`)
  job.reject?.(new Error(job.error))
}

async function renderFrame(at, width = 1280, comp = null) {
  if (!project) throw new Error('no project')
  processing.assertCapacity()
  const guard = captureProcessing()
  if (comp && !project.comps?.[comp]) throw new Error(`no composition ${comp}`)
  const selected = comp ? compView(project, comp) : project
  const spec = validateExportSpec({ at, width, comp, range: { in: 0, out: Math.max(duration(selected), 1 / selected.fps) } }, selected, { frame: true })
  guard.assertCurrent()
  const captured = captureExportSources(ROOT, project)
  const snapshot = structuredClone(project)
  const job = newJob('frame', spec)
  job.projectVersion = version
  job.exportSources = captured
  const done = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject })
  queueWorkerJob(job, snapshot, guard)
  const timeout = setTimeout(() => failJob(job, 'frame render timed out'), 30000)
  return done.finally(() => clearTimeout(timeout))
}

// ---------------------------------------------------------------- routes

const transcriptService = createTranscriptRoutes({
  root: ROOT, resolveMedia, getProject: () => project, getVersion: () => version,
  findWhisper: whisperBinary, newJob, admit, captureProcessing, assertCapacity: () => processing.assertCapacity(),
  process: (command, args, options) => run(command, args, { ...options, timeout: options?.timeout ?? 1800000 }),
  assertPublication: assertAssistantPublication,
  publish: job => broadcast('job', jobPublic(job)),
  apply: (ops, summary) => {
    const result = applyOps(project, ops)
    commit(result.project, 'you', [summary])
    return { project, version, applied: true, created: result.created }
  },
})

const customExecutable = args['custom-executable']
const customArguments = process.argv.slice(2).flatMap((value, index, values) => value === '--custom-arg' ? [values[index + 1]] : [])
if (customArguments.length > 64 || customArguments.some(value => typeof value !== 'string' || value.length > 4096 || value.includes('\0'))) throw new Error('Invalid startup custom-agent arguments')
const assistantService = createBrowserAssistant({
  root: ROOT, custom: customExecutable ? { executable: customExecutable, args: customArguments } : undefined,
  getIdentity: () => projectEpoch,
  getOutline: focus => ({ outline: project ? outline(project) : 'no project', opsDoc: OPS_DOC, uiState, version, projectEpoch, ...(focus && project ? { focus: describeFocus(project, focus) } : {}) }),
  renderFrame: (frame, assertCurrent, registerJob) => assistantCalls.run({ assertCurrent, registerJob }, () => { assertCurrent(); return renderFrame(frame.at, frame.width ?? 1280, frame.comp ?? null) }),
  dispatch: (call, assertCurrent, acceptIdentity, registerJob, run = {}) => {
    assertCurrent()
    const url = new URL(call.path, 'http://127.0.0.1')
    const route = routes[`${call.method} ${url.pathname}`]
    if (!route) throw new Error('This browser editor does not support that Arya tool route.')
    const guard = { assertCurrent, acceptIdentity, registerJob, version, runId: run.runId ?? null, ...(run.review === true ? { review: true } : {}) }
    return assistantCalls.run(guard, async () => {
      assertCurrent()
      const result = await route(call.body ?? {}, url.searchParams, { headers: {} })
      assertCurrent()
      return result
    })
  },
  cancelJob: job => routes[`POST ${job.path}`]?.({ id: job.id }),
  jobState: job => job.path === '/api/jobs/cancel' ? jobs.get(job.id)?.state : routes[job.path === '/api/video/jobs/cancel' ? 'GET /api/video/jobs' : 'GET /api/analysis/jobs']?.().jobs.find(value => value.id === job.id)?.state,
  jobOutcome: job => {
    const result = job.path === '/api/jobs/cancel' ? jobs.get(job.id) : routes[job.path === '/api/video/jobs/cancel' ? 'GET /api/video/jobs' : 'GET /api/analysis/jobs']?.().jobs.find(value => value.id === job.id)
    return result ? { state: result.state, applied: result.applied, applyError: result.applyError, assetRegistered: result.assetRegistered } : undefined
  },
  onState: next => { claude = next; assistantReview.observe(next, project); broadcast('claude', claude) },
  onPrompt: (text, refs) => { appendChat({ role: 'user', text, refs, at: Date.now() }); broadcast('chat', chat.slice(-100)) },
  onReply: (text, error) => { const snapshot = assistantService.snapshot(); appendChat({ role: 'claude', text, error, provider: snapshot.routing?.provider ?? snapshot.provider, at: Date.now() }); broadcast('chat', chat.slice(-100)) },
  diagnostic: message => log('assistant', message),
})

const routes = {
  'GET /api/project': () => ({ project, version, root: ROOT, recovery: { status: recoveryState?.status, warning: recovery.warning, history: fs.existsSync(path.join(ROOT, '.reel', 'recovery')) }, activity: activity.slice(-40), chat: chat.slice(-100), chatHistory: chatHistory.status(), claude, jobs: [...jobs.values()].map(jobPublic).slice(-20) }),
  'GET /api/recovery': () => ({ ...recovery.list(), version }),
  'POST /api/recovery/restore': body => restoreRecovery(body),

  'GET /api/outline': () => ({ outline: project ? outline(project) : 'no project', opsDoc: OPS_DOC, uiState, version, ...(project ? { focus: describeFocus(project, { selection: uiState.selection, playhead: uiState.playhead, comp: uiState.openComp ?? null }) } : {}) }),

  'POST /api/ops': async body => {
    if (!project) throw new Error('No project yet: create one first')
    if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)) throw new Error('expectedVersion must be a nonnegative safe integer')
    const checkVersion = () => { if (body.expectedVersion !== undefined && body.expectedVersion !== version) throw new Error('The project changed. Review the current version before applying these edits.') }
    checkVersion()
    const ops = body.ops ?? []
    // Probe any media the ops reference that the project has not seen.
    const srcs = new Set(ops.flatMap(o => [o.src, o.set?.src, ...(Array.isArray(o.srcs) ? o.srcs : [])].filter(s => typeof s === 'string')))
    const assets = {}
    for (const src of srcs) if (!project.assets[src]) assets[src] = await probe(src)
    checkVersion()
    const all = Object.keys(assets).length ? [{ op: 'import', assets }, ...ops] : ops
    const capturedProject = project, capturedVersion = version
    const assertLibraryCurrent = () => {
      checkVersion()
      if (project !== capturedProject || version !== capturedVersion) throw new Error('The project changed while inspecting component resources. Reopen the library action.')
    }
    const inspectLibraryLUT = path => {
      const inspect = routes['POST /api/luts/inspect']
      if (!inspect) throw new Error('LUT inspection is unavailable')
      return inspect({ path })
    }
    const prepared = all.some(op => ['library_save', 'library_register', 'library_apply'].includes(op?.op))
      ? await prepareLibraryOps(capturedProject, all, inspectLibraryLUT, assertLibraryCurrent) : { ops: all, inputs: [] }
    assertLibraryCurrent()
    const result = applyOps(project, prepared.ops)
    verifyLibraryInputs(prepared.inputs, inspectLibraryLUT)
    assertLibraryCurrent()
    commit(result.project, body.who ?? 'you', body.summary ? [body.summary] : result.log.filter(l => !l.startsWith('imported')), { projectChanged: all.some(op => op.op === 'replace') })
    for (const [src, asset] of Object.entries(assets)) ensureProxy(src, asset).catch(e => log(e.message))

    return { version, log: result.log, created: result.created, project: body.returnProject === false ? undefined : project }
  },

  'POST /api/undo': () => {
    const prev = past.at(-1)
    if (!prev) return { version, project }
    commit(prev, 'you', ['undo'], { history: false, historyMove: 'undo' })

    return { version, project }
  },

  'POST /api/redo': () => {
    const next = future.at(-1)
    if (!next) return { version, project }
    commit(next, 'you', ['redo'], { history: false, historyMove: 'redo' })

    return { version, project }
  },

  'POST /api/new': async body => {
    if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0)) throw new Error('expectedVersion must be a nonnegative safe integer')
    if (body.expectedVersion !== undefined && body.expectedVersion !== version) throw new Error('The project changed. Review the current version before replacing it.')
    const p = newProject(body.name ?? 'Untitled', body)
    commit(p, body.who ?? 'you', [`new project ${p.name} ${p.width}x${p.height}@${p.fps}`], { projectChanged: true })

    return { version, project }
  },

  'POST /api/import': async body => {
    if (!project) commit(newProject(path.basename(ROOT)), 'reel', ['new project'], { projectChanged: true })
    const paths = []
    for (const p of body.paths ?? []) {
      const abs = path.resolve(ROOT, p)
      if (fs.statSync(abs).isDirectory()) {
        for (const f of fs.readdirSync(abs)) if (MEDIA_EXT.test(f)) paths.push(path.relative(ROOT, path.join(abs, f)))
      } else paths.push(path.relative(ROOT, abs).startsWith('..') ? abs : path.relative(ROOT, abs))
    }
    const assets = {}, failures = [], warnings = [], identities = []
    let sawGeneratedMusic = false
    for (const p of paths) {
      const existing = project.assets?.[p], generated = isAryaMusicAsset(existing)
      sawGeneratedMusic ||= generated
      try {
        const prepared = generated ? await prepareMusicReimport(ROOT, p, existing, { assertCurrent: assertAssistantPublication }) : null
        const admission = prepared?.decide(null)
        if (admission?.disposition === 'unverified') {
          failures.push({ path: p, name: path.basename(p), stage: 'identity', error: admission.message })
          continue
        }
        const probed = await probe(p)
        await prepared?.validate?.()
        const decision = prepared ? prepared.decide(probed) : { asset: probed, disposition: 'ordinary' }
        if (generated && JSON.stringify(project.assets?.[p]) !== JSON.stringify(existing)) throw new Error('The saved music entry changed during import. Review Media and retry.')
        assets[p] = decision.asset
        if (decision.disposition === 'replaced') warnings.push({ path: p, name: path.basename(p), stage: 'identity', message: decision.message })
        if (prepared?.validate) identities.push({ src: p, existing: JSON.stringify(existing), validate: prepared.validate })
      } catch (error) {
        log('probe failed', p, error.message)
        failures.push({ path: p, name: path.basename(p), stage: generated ? 'identity' : 'probe', error: error.message })
      }
    }
    for (const item of identities) {
      try {
        await item.validate()
        if (JSON.stringify(project.assets?.[item.src]) !== item.existing) throw new Error('The saved music entry changed during import. Review Media and retry.')
      } catch (error) {
        delete assets[item.src]
        failures.push({ path: item.src, name: path.basename(item.src), stage: 'identity', error: error.message })
      }
    }
    if (Object.keys(assets).length || !sawGeneratedMusic) {
      const result = applyOps(project, [{ op: 'import', assets }])
      commit(result.project, body.who ?? 'you', [`imported ${Object.keys(assets).length} media`])
    }
    for (const [src, asset] of Object.entries(assets)) {
      ensureProxy(src, asset).catch(e => log(e.message))
      if (asset.hasVideo && !asset.proxy) filmstrip(src).catch(() => {})
    }

    return { assets, version, failures, warnings: warnings.filter(item => assets[item.path]) }
  },

  'POST /api/forget': async body => {
    const p = structuredClone(project)
    for (const src of body.paths ?? []) delete p.assets[src]
    commit(p, 'you', [`removed ${body.paths?.length ?? 0} media from the project`])

    return { version }
  },

  'GET /api/files': async (_b, q) => {
    const dir = path.resolve(ROOT, q.get('dir') ?? '.')
    const root = fs.realpathSync(ROOT), real = fs.realpathSync(dir)
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('that folder is outside the project')
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
    const rel = path.relative(ROOT, dir)

    return {
      dir: rel,
      entries: entries.filter(e => e.isDirectory() || MEDIA_EXT.test(e.name)).map(e => ({ name: e.name, dir: e.isDirectory(), path: path.join(rel, e.name) })),
    }
  },

  'GET /api/strip': (_b, q) => admitSourceDerivative(() => filmstrip(q.get('src'), q.get('quality') === 'high')),
  'GET /api/peaks': (_b, q) => admitSourceDerivative(() => peaks(q.get('src'))),

  'POST /api/analyze': body => body.kind === 'transcript' ? transcriptService.transcribe(body) : body.kind === 'stabilization' && routes['POST /api/analysis/stabilize'] ? routes['POST /api/analysis/stabilize'](body) : admit(() => analyze(body.src, body.kind, body)),

  'GET /api/caps': async () => {
    const transcription = await transcriptService.capability()
    const whisper = transcription.available
    const chrome = fs.existsSync(CHROME)
    const presets = Object.keys(PRESETS)
    return {
      host: 'browser', whisper, chrome, presets,
      transcriber: 'whisper.cpp', transcription,
      shorts: { available: true, scoring: 'transcript-structure' },
      captionStyles: ['plain', 'boxed', 'karaoke', 'word'],
      export: { renderer: 'chrome', presets, still: chrome },
      // Saliency, auto reframe and person masks need the Arya app's Vision analysis.
      analysis: { transcript: whisper, scenes: true, silence: true, beats: true, loudness: true, opticalFlow: true, tracking: Boolean(routes['POST /api/analysis/track']), stabilization: Boolean(routes['POST /api/analysis/stabilize']), saliency: false, autoReframe: false, personMask: false },
      color: colorCapabilities({ renderer: chrome }),
      processing: { audioClean: true, multicamSync: true, deshake: true },
      music: routes['GET /api/audio/compose/capabilities']?.() ?? { available: false },
      figma: { available: true }, assistant: { available: true, pluginSession }, interchange: { available: true },
    }
  },

  'GET /api/luts': () => {
    const dirs = [path.join(ROOT, 'luts'), path.join(ROOT, 'LUTs'), ROOT]
    const out = []
    for (const d of dirs) if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (/\.cube$/i.test(f)) out.push(path.relative(ROOT, path.join(d, f)))

    return { luts: [...new Set(out)] }
  },

  'POST /api/ui-state': body => {
    uiState = { ...uiState, ...body }

    return { ok: true }
  },

  // Built-in sends use consent guards. Legacy plugins cannot identify their recipients.
  'POST /api/bridge/send': body => {
    if (body.mode !== 'plugin' && assistantReview.applying()) throw Object.assign(new Error('Wait for the preview to finish applying before sending another request.'), { status: 409 })
    if (body.mode !== 'plugin') return assistantService.send({ ...body, ids: body.ids ?? uiState.selection ?? [], comp: Object.hasOwn(body, 'comp') ? body.comp : uiState.openComp ?? null, playhead: body.playhead ?? uiState.playhead ?? 0 })
    throw Object.assign(new Error('This plugin connection has no verified AI recipient. Choose a built-in assistant provider and review sharing permission before sending.'), { status: 403 })
  },

  'GET /api/bridge/poll': () => {
    throw Object.assign(new Error('This plugin connection has no verified AI recipient. Choose a built-in assistant provider and review sharing permission before sending.'), { status: 403 })
  },

  'POST /api/bridge/claude': body => {
    pluginSession = true
    claude = { state: body.state ?? claude.state, text: body.text ?? '' }
    broadcast('claude', claude)

    return { ok: true }
  },

  // Rendering.
  'POST /api/export': body => startExport(body).then(jobPublic),
  'POST /api/frame': async body => renderFrame(body.at ?? uiState.playhead ?? 0, body.width ?? 1280, body.comp ?? null),
  'GET /api/jobs': () => ({ jobs: [...jobs.values()].map(jobPublic) }),

  // Long-poll: answers when the job ends or after `timeout` ms, whichever is first.
  'GET /api/jobs/wait': async (_b, q) => {
    const id = q.get('id')
    const until = Date.now() + Math.min(60000, Number(q.get('timeout') ?? 25000))
    while (Date.now() < until) {
      const job = jobs.get(id)
      if (!job) throw new Error(`no job ${id}`)
      if (job.state === 'done' || job.state === 'failed') return jobPublic(job)
      await new Promise(r => setTimeout(r, 250))
    }

    return jobPublic(jobs.get(id))
  },
  'POST /api/jobs/cancel': body => {
    const job = jobs.get(body.id)
    if (job && job.state !== 'done') failJob(job, 'cancelled')
    broadcast('cancel', { id: body.id }, 'worker')

    return { ok: true }
  },

  'GET /api/deliveries': () => ({ ...deliveries.list(), actions: ['open', 'reveal'] }),
  'POST /api/deliveries/access': async body => {
    if (!['open', 'reveal'].includes(body.action)) throw new Error('Unsupported delivery action')
    const file = deliveries.resolve(body.id, body.root)
    // A frame sequence is a folder of frame_NNNNN.png files that delivery history already checked.
    if (body.action === 'open' && !fs.statSync(file).isDirectory() && !OPENABLE_EXT.test(file)) throw new Error('Arya opens only media, caption and timeline files')
    await run('/usr/bin/open', deliveryOpenArguments(file, body.action))
    return { ok: true }
  },

  'POST /api/reveal': async body => {
    const abs = path.resolve(ROOT, body.path)
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error('outside the project')
    // A symlink must not reach outside the project, and Open must not launch an app or script.
    // Reveal may show the project folder itself.
    const real = fs.realpathSync(abs), root = fs.realpathSync(ROOT)
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('outside the project')
    if (body.open) {
      const stat = fs.statSync(real)
      if (!stat.isFile() || !OPENABLE_EXT.test(real)) throw new Error('Only a project file can be opened')
    }
    await run('/usr/bin/open', body.open ? [real] : ['-R', real])

    return { ok: true }
  },

  'GET /api/state': () => ({ bridgeAlive: Date.now() - lastPoll < 6000, assistant: assistantService.snapshot(), chatHistory: chatHistory.status(), version, editors: [...clients].filter(c => c.role === 'ui').length, worker: workerConnected(), processing: processing.snapshot(), root: ROOT, pid: process.pid }),

  'POST /api/shutdown': () => {
    setTimeout(() => shutdown(), 50)

    return { ok: true }
  },
}

async function handleJobUpload(req, res, url) {
  // /api/job/<id>/<audio|frames|frame|done|fail|progress>
  const [, , , id, what] = url.pathname.split('/')
  const job = jobs.get(id)
  if (!job) return send(res, 404, { error: 'no such job' })
  if (what === 'drained') {
    if (!job.processing?.dispatched) return send(res, 409, { error: 'This job was not dispatched' })
    job.processing.acknowledge()
    return send(res, 200, { ok: true })
  }
  if (job.state === 'failed' || job.state === 'done') return send(res, 410, { error: job.error ?? 'This job has finished.' })
  try {
    if (!job.processing?.dispatched || job.processing.drained) return send(res, 409, { error: 'This job has no active worker reservation' })
    job.processing.assertCurrent()
    if (what === 'start') {
      if (job.kind !== 'export' || job.state !== 'queued') return send(res, 409, { error: 'This export job has already started.' })
      job.state = 'running'
      noteWorkerActivity(job, workerClock(), 'setup')
      if (job.kind === 'export') startEncoder(job)
      broadcast('job', jobPublic(job))

      return send(res, 200, { ok: true })
    }
    if (what === 'alive') {
      noteWorkerActivity(job, workerClock(), 'heartbeat')

      return send(res, 200, { ok: true })
    }
    if (what === 'audio') {
      noteWorkerActivity(job, workerClock(), 'setup')
      if (job.kind !== 'export' || job.state !== 'queued' || job.audioUploaded) return send(res, 409, { error: 'Audio must arrive once before the export starts.' })
      const buf = await readBody(req, Math.min(1024 ** 3, Math.ceil((job.spec.range.out - job.spec.range.in) * 48000 * 8 + 4096)))
      job.processing.assertCurrent()
      if (job.state !== 'queued' || job.audioUploaded) return send(res, 410, { error: 'The export changed while audio was uploading.' })
      fs.writeFileSync(guardedOutput(ROOT, job.audioFile), buf)
      job.audioUploaded = true
      noteWorkerActivity(job, workerClock(), 'setup')

      return send(res, 200, { ok: true })
    }
    if (what === 'frames') {
      noteWorkerActivity(job, workerClock(), 'batch')
      if (job.kind !== 'export' || job.state !== 'running' || job.finishing) return send(res, 409, { error: 'The export is not accepting frames.' })
      const buf = await readBody(req, Math.max(job.spec.width * job.spec.height * 4, 32000000))
      job.processing.assertCurrent()
      if (job.state !== 'running' || job.finishing) return send(res, 410, { error: 'The export stopped while frames were uploading.' })
      const ok = job.ffmpeg.stdin.write(buf)
      if (!ok) await new Promise((resolve, reject) => {
        const cleanup = () => { job.ffmpeg.stdin.removeListener('drain', drained); job.ffmpeg.removeListener('close', closed); job.ffmpeg.stdin.removeListener('error', failed) }
        const drained = () => { cleanup(); resolve() }, closed = () => { cleanup(); reject(new Error('The encoder exited before accepting the batch')) }, failed = error => { cleanup(); reject(error) }
        job.ffmpeg.stdin.once('drain', drained); job.ffmpeg.once('close', closed); job.ffmpeg.stdin.once('error', failed)
      })
      if (job.state !== 'running' || job.finishing) return send(res, 410, { error: 'The export stopped while frames were encoding.' })
      job.progress = Number(url.searchParams.get('done') ?? 0) / job.spec.frames
      if (!job.lastBroadcast || Date.now() - job.lastBroadcast > 300) {
        job.lastBroadcast = Date.now()
        broadcast('job', jobPublic(job))
      }
      touchWorker()

      return send(res, 200, { ok: true })
    }
    if (what === 'frame') {
      if (job.kind !== 'frame' || job.state !== 'queued') return send(res, 409, { error: 'The frame job has already been delivered.' })
      const buf = await readBody(req, job.spec.width * job.spec.height * 4 + 1024 * 1024)
      job.processing.assertCurrent()
      if (job.state !== 'queued') return send(res, 410, { error: 'The frame job stopped while its image was uploading.' })
      await job.exportSources.assertCurrent(() => job.processing.assertCurrent())
      job.processing.assertCurrent()
      const dir = guardedOutput(ROOT, path.join(DOT, 'frames'))
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `frame-${job.id}-${job.spec.comp ? `${job.spec.comp}-` : ''}${job.spec.at.toFixed(3)}.png`)
      job.exportSources.assertCurrentSync(() => job.processing.assertCurrent())
      fs.writeFileSync(guardedOutput(ROOT, file), buf, { flag: 'wx', mode: 0o600 })
      job.state = 'done'
      job.output = file
      job.resolve?.({ path: file, at: job.spec.at })

      return send(res, 200, { ok: true })
    }
    if (what === 'done') {
      if (job.kind !== 'export' || job.state !== 'running' || job.finishing) return send(res, 409, { error: 'The export is already finishing or has not started.' })
      await finishExport(job)
      if (job.state === 'failed') return send(res, 410, { error: job.error })

      return send(res, 200, { ok: true })
    }
    if (what === 'fail') {
      const body = await readJson(req)
      if (job.state === 'failed' || job.state === 'done') return send(res, 410, { error: 'This job has finished.' })
      failJob(job, body.error ?? 'worker failed')

      return send(res, 200, { ok: true })
    }
  } catch (error) {
    failJob(job, error)

    return send(res, 500, { error: String(error.message) })
  }
  send(res, 404, { error: 'unknown job route' })
}

// A hung render worker would otherwise hold the export queue forever (limits in processing-worker.mjs).
setInterval(createWorkerWatchdog({ jobs: () => jobs.values(), failJob }), WORKER_CHECK_MS).unref()

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  // Only the editor itself (same origin) and local tools with no Origin (the mod, curl)
  // may write. A page on another site could otherwise post edits or inject prompts.
  const origin = req.headers.origin
  // The bridge poll drains Claude's queue, so only the mod (which sends no Origin) may call it.
  if (url.pathname === '/api/bridge/poll' && origin) return send(res, 403, { error: 'the bridge is for the Claude Code mod' })
  if (req.method !== 'GET' && origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) {
    return send(res, 403, { error: 'cross-origin request refused' })
  }
  // Reject DNS-rebinding hosts: the server answers only to its loopback names.
  const host = String(req.headers.host ?? '')
  if (host && host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'unknown host' })
  // Browsers label every request with Sec-Fetch-Site. Another site may only open the editor
  // page or Figma's OAuth callback in a tab; it may not load media, run processing or call the API.
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') {
    const navigation = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document'
    // A query string can turn the page into something else, such as ?worker=1 (a render worker).
    const page = url.pathname === '/api/figma/callback' || !url.search && !url.pathname.startsWith('/api/') && url.pathname !== '/media' && !url.pathname.startsWith('/cache/')
    if (!navigation || !page) return send(res, 403, { error: 'cross-site request refused' })
  }
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      const client = { res, role: url.searchParams.get('role') ?? 'ui' }
      if (client.role === 'worker') client.worker = worker
      clients.add(client)
      res.write(`event: hello\ndata: ${JSON.stringify({ version, role: client.role })}\n\n`)
      if (client.role === 'ui') {
        // Reconnects must recover terminal status even if an event was missed.
        res.write(`event: claude\ndata: ${JSON.stringify(claude)}\n\n`)
        res.write(`event: chat\ndata: ${JSON.stringify(chat.slice(-100))}\n\n`)
        res.write(`event: chatHistory\ndata: ${JSON.stringify(chatHistory.status())}\n\n`)
        res.write(`event: assistantReview\ndata: ${JSON.stringify(assistantReview.snapshot())}\n\n`)
      }
      const ping = setInterval(() => res.write(': ping\n\n'), 15000)
      req.on('close', () => {
        clearInterval(ping)
        clients.delete(client)
      })
      if (client.role === 'worker' && workerConnected() && client.worker === worker) {
        for (const job of jobs.values()) if (job.processing?.dispatched && !job.processing.drained && job.state === 'queued') res.write(`event: render\ndata: ${JSON.stringify(job.processing.payload)}\n\n`)
      }

      return
    }
    for (const raw of rawHandlers) if (await raw(req, res, url)) return
    if (url.pathname === '/ui/plugins-index.js') return send(res, 200, pluginIndex(), { 'content-type': 'text/javascript; charset=utf-8' })
    if (url.pathname.startsWith('/api/job/')) return handleJobUpload(req, res, url)
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      return send(res, 200, await storeMediaUpload(ROOT, req, url.searchParams))
    }
    if (url.pathname === '/api/audio') {
      const audioWork = () => audioRange(url.searchParams.get('src'), Number(url.searchParams.get('in') ?? 0), Number(url.searchParams.get('dur') ?? 10))
      const owner = url.searchParams.get('processingJob')
      let file
      if (owner) {
        const job = jobs.get(owner)
        if (!job || job.kind !== 'export' || job.state !== 'queued' || !job.processing?.dispatched || job.processing.drained) return send(res, 410, { error: 'This worker job cannot request audio' })
        job.processing.assertCurrent()
        file = await processing.within(job.processing.lease, audioWork)
      } else file = await admitSourceDerivative(audioWork)

      return serveFile(req, res, file)
    }
    // Project files are data. A page or SVG in the project must not run as the editor.
    if (url.pathname === '/media') return serveFile(req, res, resolveMedia(url.searchParams.get('path')), UNTRUSTED_FILE_HEADERS)
    if (url.pathname.startsWith('/cache/')) {
      const file = cacheFile(url.pathname.slice(7))
      return file ? serveFile(req, res, file, UNTRUSTED_FILE_HEADERS) : send(res, 404, 'not found')
    }
    if (url.pathname.startsWith('/vendor/')) return serveFile(req, res, path.join(HERE, 'node_modules', path.normalize(url.pathname.slice(8)).replace(/^(\.\.[/\\])+/, '')))
    if (url.pathname.startsWith('/core/')) return serveFile(req, res, path.join(HERE, 'core', path.basename(url.pathname)))
    const key = `${req.method} ${url.pathname}`
    const route = routes[key]
    if (route) {
      const body = req.method === 'POST' ? await readJson(req) : {}
      const result = await route(body, url.searchParams, req)

      return send(res, 200, result ?? {})
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').slice(1)

      return serveFile(req, res, path.join(HERE, 'web', rel), { 'x-content-type-options': 'nosniff', 'content-security-policy': "frame-ancestors 'none'" })
    }
    send(res, 404, { error: 'not found' })
  } catch (error) {
    log('error', req.method, url.pathname, error.message)
    if (!res.headersSent) send(res, error.status ?? 500, { error: String(error.message) })
  }
})

// ---------------------------------------------------------------- route modules
// Every editor/routes/*.mjs exports default (ctx) => ({ routes?: { 'GET /api/x': (body, query, req) => result },
// raw?: (req, res, url) => boolean }). raw handlers see requests first and return true when they answered.

const rawHandlers = []
const routeCtx = {
  ROOT, DOT, CACHE, HERE, run, admit, captureProcessing, musicComposeContext, assertCapacity: () => processing.assertCapacity(), probe, resolveMedia, readBody, readJson, send, serveFile,
  broadcast: (event, data, role) => {
    if (event === 'job' && (data.state === 'running' || data.state === 'queued') && data.progress === 0 && data.created && data.id && !jobs.has(data.id)) assistantCalls.getStore()?.registerJob?.({ id: data.id, path: data.cancelPath ?? '/api/analysis/jobs/cancel' })
    broadcast(event, data, role)
  },
  pushActivity, cacheKey, once, log,
  applyOps,
  transcripts: transcriptService,
  assistant: assistantService,
  getProject: () => project,
  getVersion: () => version,
  getProjectGeneration: () => projectEpoch,
  getAssistantReview: () => assistantReview,
  // Runs a preview's apply as its own owner, so its commits and jobs count as the assistant change.
  asAssistantApply: (id, work) => assistantCalls.run({ applyId: id, get version() { return version }, set version(_) {}, assertCurrent() {}, acceptIdentity() {}, registerJob() {} }, work),
  referenceAvailable: () => colorCapabilities({ renderer: fs.existsSync(CHROME) }).referenceMatch,
  assertCurrent: assertAssistantPublication,
  checkAgentFile: file => { if (assistantCalls.getStore()) { assertAssistantPublication(); confinedFile(ROOT, file) } },
  callAPI: (method, route, body = {}) => {
    const handler = routes[`${method} ${route}`]
    if (!handler) throw new Error('Unknown internal Reel route')
    return handler(body, new URLSearchParams(), { headers: {} })
  },
  commit: (next, who, lines) => commit(next, who, lines),
  editOps: async (ops, who = 'reel', summary, options = {}) => routes['POST /api/ops']({ ops, who, summary, returnProject: options.returnProject ?? false, ...(options.expectedVersion === undefined ? {} : { expectedVersion: options.expectedVersion }) }),
}

async function loadRouteModules() {
  const dir = path.join(HERE, 'routes')
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.mjs')).sort()) {
    try {
      const mod = await import(path.join(dir, f))
      const made = (await mod.default(routeCtx)) ?? {}
      for (const [key, fn] of Object.entries(made.routes ?? {})) {
        if (routes[key]) throw new Error(`${f} redefines ${key}`)
        routes[key] = key === 'POST /api/audio/compose' ? (...args) => admitMusicCompose(() => fn(...args))
          : key === 'POST /api/audio/compose/place' ? (...args) => admit(() => fn(...args)) : fn
      }
      if (made.raw) rawHandlers.push(made.raw)
      log(`routes: ${f}`)
    } catch (error) {
      log(`routes: ${f} failed to load: ${error.message}`)
    }
  }
}

// The editor's UI plugins: one module that imports every web/ui/plugins/*.js.
function pluginIndex() {
  const dir = path.join(HERE, 'web', 'ui', 'plugins')
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.js')).sort() : []

  return `${files.map(f => `import './plugins/${f}'`).join('\n')}\nexport const loaded = ${JSON.stringify(files)}\n`
}

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  await assistantService.close()
  worker?.kill()
  for (const job of jobs.values()) job.ffmpeg?.kill()
  try {
    fs.rmSync(path.join(DOT, 'server.json'), { force: true })
  } catch {}
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Media probed by an older Reel lacks codec and frame rate: fill them in quietly.
async function refreshAssets() {
  if (!project) return
  const original = project, originalVersion = version
  const stale = Object.entries(original.assets).filter(([, a]) => !a.codec)
  if (!stale.length) return
  const next = structuredClone(original)
  for (const [src] of stale) {
    try {
      next.assets[src] = { ...next.assets[src], ...(await probe(src)) }
    } catch {}
  }
  if (project !== original || version !== originalVersion) return
  commit(next, 'reel', [], { history: false })
}

await loadRouteModules()

server.listen(PORT, '127.0.0.1', () => {
  refreshAssets().catch(e => log('refresh', e.message))
  fs.writeFileSync(path.join(DOT, 'server.json'), JSON.stringify({ port: PORT, pid: process.pid, root: ROOT, started: Date.now() }))
  log(`Arya editor at http://127.0.0.1:${PORT}/ for ${ROOT}`)
})
