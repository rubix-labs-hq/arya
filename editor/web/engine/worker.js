// Render worker: runs in a headless Chrome the server starts. It takes export and
// frame jobs and renders them with the same compositor and audio graph as the editor.

import { AudioEngine } from './audio.js'
import { Compositor } from './compositor.js'
import { frameCenter, Media, parseCube } from './media.js'
import { neededVideos } from './frame.js'
import { compView, duration } from '/core/project.js'
import { framePlan } from '/core/render-plan.js'
import { createRenderQueue } from '/core/render-queue.js'
import { buildDecoderPlans, validateExportSpec } from '/core/processing-export.js'
import { Player } from './player.js'

const LUT_SOURCE_LIMIT = 128 * 1024 * 1024

export function lutPaths(p, { at = 0, comp = null, from, frames, fps = p.fps } = {}) {
  const paths = new Set()
  if (!(p.tracks ?? []).length && !comp) return paths
  function clip(c) {
    if (!c || ['null', 'audio', 'caption'].includes(c.kind)) return
    const add = grade => { if (grade?.lut) paths.add(grade.lut) }
    if (c.kind === 'adjustment' || !c.nodes?.list?.length) add(c.grade)
    else {
      const completed = new Set()
      for (const node of c.nodes.list) {
        const hasInput = c.nodes.links.some(link => link.to === node.id && completed.has(link.from))
        if (node.enabled !== false && hasInput && ['primary', 'corrector', 'lut'].includes(node.type)) add(node.grade)
        completed.add(node.id)
      }
    }
    if (c.composition) plan(c.composition)
  }
  function plan(value) {
    for (const layer of value.layers ?? []) { clip(layer.clip); clip(layer.a); clip(layer.b) }
  }
  const count = from === undefined ? 1 : frames
  for (let i = 0; i < count; i++) plan(framePlan(p, from === undefined ? at : from + (i + 0.0001) / fps, comp))
  return paths
}

async function readLut(path, remaining, signal, sourceRevision) {
  if (signal.aborted) throw new Error('LUT load was superseded')
  const response = await fetch(`/media?path=${encodeURIComponent(path)}${sourceRevision ? `&sourceRevision=${encodeURIComponent(sourceRevision)}` : ''}`, { cache: 'no-store', signal })
  if (signal.aborted) throw new Error('LUT load was superseded')
  if (!response.ok) throw new Error(`LUT ${path}: HTTP ${response.status}`)
  const declared = Number(response.headers?.get('content-length'))
  if (declared > remaining) throw new Error('LUT sources exceed 128 MiB')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('LUT response has no readable body')
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (signal.aborted) throw new Error('LUT load was superseded')
      if (done) break
      length += value.byteLength
      if (length > remaining) throw new Error('LUT sources exceed 128 MiB')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sourceHash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  return { path, sourceHash, length, text }
}

async function readLuts(paths, expected, signal, sourceRevision) {
  const inputs = []
  let bytes = 0
  for (const path of paths) {
    const input = await readLut(path, LUT_SOURCE_LIMIT - bytes, signal, sourceRevision)
    bytes += input.length
    if (expected && expected.get(path) !== input.sourceHash) throw new Error(`LUT ${path} changed during this render`)
    inputs.push(input)
  }
  return inputs
}

/** Fresh bytes identify textures. A receipt rechecks them after asynchronous decoding. */
export async function loadLuts(comp, p, { pin = false, signal, ...range } = {}) {
  signal?.throwIfAborted()
  const sourceRevision = p.__aryaExportSourceRevision
  const paths = lutPaths(p, range)
  const generation = comp.lutGeneration = (comp.lutGeneration ?? 0) + 1
  const current = () => generation === comp.lutGeneration
  comp.lutAbort?.abort()
  const controller = new AbortController()
  comp.lutAbort = controller
  const abort = () => controller.abort(signal.reason)
  if (signal) {
    signal.addEventListener('abort', abort, { once: true })
    controller.signal.addEventListener('abort', () => signal.removeEventListener('abort', abort), { once: true })
    if (signal.aborted) abort()
  }
  try {
    const inputs = await readLuts(paths, comp.lutExpected, controller.signal, sourceRevision)
    if (!current()) throw new Error('LUT load was superseded')
    for (const input of inputs) input.lut = parseCube(input.text)
    if (inputs.length || comp.commitLuts) comp.commitLuts(inputs, generation)
    const hashes = new Map(inputs.map(input => [input.path, input.sourceHash]))
    inputs.length = 0
    if (pin) comp.lutExpected = new Map(hashes)
    return {
      hashes: new Map(hashes),
      async validate() {
        if (!current()) throw new Error('LUT render was superseded')
        try {
          await readLuts(paths, hashes, controller.signal, sourceRevision)
          if (!current()) throw new Error('LUT render was superseded')
        } catch (error) {
          if (current()) comp.clearLuts(true)
          throw error
        }
      },
    }
  } catch (error) {
    if (current()) comp.clearLuts(true)
    throw error
  }
}

// Presets whose encoders keep an alpha channel (yuva444p10le ProRes, RGBA PNG).
const ALPHA_PRESETS = new Set(['prores-4444', 'png-seq'])

export function startWorker() {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  const comp = new Compositor(canvas, { alpha: true })
  const media = new Media()
  media.headless = true
  media.useDecoders = true
  let project = null
  const player = new Player({ comp, media, audio: { stop() {} }, getProject: () => project })
  const cancelled = new Set()
  const finished = new Map()
  let active = null
  for (const name of ['decodeFrame', 'seek']) {
    if (!media[name]) continue
    const operation = media[name].bind(media)
    media[name] = (...args) => {
      const scope = active, result = operation(...args)
      if (result?.then) scope?.track(result)
      return result
    }
  }
  const image = media.image?.bind(media)
  if (image) media.image = (...args) => {
    const result = image(...args)
    if (result.promise) active?.track(result.promise)
    return result
  }

  const post = (scope, url, body, type = 'application/octet-stream') => scope.wait(() => fetch(url, { method: 'POST', body, headers: { 'content-type': type }, signal: scope.controller.signal })).then(r => {
    if (!r.ok) throw new Error(`${url} → ${r.status}`)

    return r
  })

  function retire(scope) {
    if (scope.retired) return
    scope.retired = true
    player.frameEpoch = (player.frameEpoch ?? 0) + 1
    player.exactToken = (player.exactToken ?? 0) + 1
    media.reset()
    scope.audio.stop?.()
    scope.audio.buffers?.clear()
    const closing = scope.audio.ctx?.close?.()
    if (closing) scope.track(closing)
    for (const key of comp.textures.keys()) comp.dropTexture(key)
    comp.clearLuts()
    project = null
  }

  function jobScope(id) {
    const controller = new AbortController(), pending = new Set()
    const scope = { id, controller, pending, audio: new AudioEngine(), retired: false }
    const cancellation = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
    cancellation.catch(() => {})
    scope.track = operation => {
      const promise = Promise.resolve(operation)
      pending.add(promise)
      promise.then(() => pending.delete(promise), () => pending.delete(promise))
      return promise
    }
    scope.wait = operation => {
      const promise = scope.track(Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation() }))
      return Promise.race([promise, cancellation])
    }
    scope.abort = reason => {
      if (!controller.signal.aborted) controller.abort(Object.assign(new Error(reason), { name: 'AbortError' }))
      retire(scope)
    }
    return scope
  }

  async function notify(url, body = '') {
    const controller = new AbortController()
    let timer
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Worker notification timed out')) }, 2000) })
    try { return await Promise.race([fetch(url, { method: 'POST', body, signal: controller.signal }), timeout]) }
    catch { return null }
    finally { clearTimeout(timer) }
  }

  async function drained(scope) {
    // A retired display can advance the queue while an uncooperative operation finishes.
    // Keep its server reservation until all tracked operations have settled.
    await Promise.allSettled([...scope.pending])
    await notify(`/api/job/${scope.id}/drained`)
    finished.delete(scope.id)
  }

  async function runJob({ job, project: full }) {
    const scope = jobScope(job.id)
    active = scope
    // While this job prepares or renders, tell the server the page is alive; the server only
    // trusts this before the first frame batch, so a stuck render still counts as stalled.
    const heartbeat = setInterval(() => { void notify(`/api/job/${job.id}/alive`) }, 5000)
    try {
      if (cancelled.has(job.id)) scope.abort('cancelled')
      scope.controller.signal.throwIfAborted()
      // A frame job may name a composition: render it on its own, at its own size.
      const p = job.spec.comp ? compView(full, job.spec.comp) : full
      const spec = validateExportSpec(job.spec, { ...p, duration: Math.max(duration(p), 1 / p.fps) }, { frame: job.kind === 'frame' })
      project = p
      const lutSnapshot = await scope.wait(() => loadLuts(comp, full, { signal: scope.controller.signal, pin: true, ...(job.kind === 'frame' ? { at: spec.at, comp: job.spec.comp } : { from: spec.range.in, frames: spec.preset.startsWith('audio') ? 0 : spec.frames, fps: spec.fps, comp: job.spec.comp }) }))
      const base = `/api/job/${job.id}`
      comp.keepAlpha = job.kind === 'export' && ALPHA_PRESETS.has(spec.preset)
      if (job.kind === 'frame') {
        comp.resize(spec.width, spec.height)
        await scope.wait(() => player.renderExact(spec.at))
        const blob = await scope.wait(() => new Promise(r => canvas.toBlob(r, 'image/png')))
        await scope.wait(() => lutSnapshot.validate())
        await post(scope, `${base}/frame`, blob, 'image/png')
        scope.completed = true

        return
      }
      const { width, height, fps, range, frames, preset } = spec
      comp.resize(width, height)
      const audioOnly = preset.startsWith('audio')
      const noAudio = preset === 'gif' || preset === 'png-seq'
      if (!noAudio) {
        const wav = await scope.wait(() => scope.audio.renderWav(p, range.in, range.out, { signal: scope.controller.signal, processingJob: job.id }))
        await post(scope, `${base}/audio`, wav, 'audio/wav')
      }
      await post(scope, `${base}/start`, '')
      if (!audioOnly) {
        const plans = await scope.wait(() => buildDecoderPlans(spec, p, neededVideos, frameCenter, { check: () => scope.controller.signal.throwIfAborted() }))
        await scope.wait(() => media.planDecoders(plans))
        const frameBytes = width * height * 4
        const batch = Math.max(1, Math.min(4, Math.floor(32e6 / frameBytes)))
        let buf = new Uint8Array(frameBytes * batch)
        let n = 0
        for (let i = 0; i < frames; i++) {
          scope.controller.signal.throwIfAborted()
          await scope.wait(() => player.renderExact(range.in + (i + 0.0001) / fps))
          comp.readPixels(buf.subarray(n * frameBytes, (n + 1) * frameBytes))
          n++
          if (n === batch || i === frames - 1) {
            await post(scope, `${base}/frames?done=${i + 1}`, buf.subarray(0, n * frameBytes))
            n = 0
          }
        }
        buf = null
      }
      await scope.wait(() => lutSnapshot.validate())
      await post(scope, `${base}/done`, '')
      scope.completed = true
    } finally {
      clearInterval(heartbeat)
      if (!scope.completed && !scope.controller.signal.aborted) scope.controller.abort(Object.assign(new Error('Worker job ended'), { name: 'AbortError' }))
      retire(scope)
      finished.set(job.id, scope)
      if (active === scope) active = null
      cancelled.delete(job.id)
      if (scope.completed) void drained(scope)
    }
  }

  const enqueue = createRenderQueue(runJob, async (item, error) => {
    if (error.name !== 'AbortError') console.error(error)
    await notify(`/api/job/${item.job.id}/fail`, JSON.stringify({ error: String(error.message ?? error) }))
    const scope = finished.get(item.job.id)
    if (scope) void drained(scope)
  })

  const es = new EventSource('/api/events?role=worker')
  es.addEventListener('render', e => {
    const data = JSON.parse(e.data)
    enqueue(data)
  })
  es.addEventListener('cancel', e => {
    const { id } = JSON.parse(e.data)
    cancelled.add(id)
    if (active?.id === id) active.abort('cancelled')
  })
  es.addEventListener('error', () => active?.abort('Worker connection lost'))
  document.title = 'Arya render worker'
}
