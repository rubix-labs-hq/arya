// Native exports use the viewer's compositor and audio graph. Mediabunny encodes
// and muxes the result; the app writes each chunk to its temporary export file.
import { AudioBufferSource, CanvasSource, Mp4OutputFormat, Output, Quality, StreamTarget, canEncodeAudio, canEncodeVideo } from '/vendor/mediabunny/dist/bundles/mediabunny.min.mjs'
import { api, host } from '../host.js'
import { AudioEngine } from './audio.js'
import { Compositor } from './compositor.js'
import { Media } from './media.js'
import { Player } from './player.js'
import { loadLuts } from './worker.js'
import { NativeExportDrain, waitNativeAdmission } from './native-export-admission.js'

const RATE = 48000
let queue = Promise.resolve()

function renderer(project, width, height) {
  const canvas = document.createElement('canvas')
  const comp = new Compositor(canvas)
  comp.resize(width, height)
  const media = new Media()
  media.headless = true
  media.useDecoders = true
  const audio = new AudioEngine()
  const player = new Player({ comp, media, audio, getProject: () => project })
  return {
    canvas, comp, media, audio, player,
    async close() {
      media.closeDecoders()
      for (const v of media.videos.values()) { v.el.pause(); v.el.removeAttribute('src'); v.el.load() }
      audio.stop()
      await audio.ctx?.close().catch(() => {})
      comp.clearLuts()
      comp.gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}

/** Starts a native job immediately; its completion can also be awaited by automation. */
export async function startNativeExport(project, spec) {
  const job = await api('/api/export', { ...spec, renderer: 'webcodecs', expectedProject: JSON.stringify(project) })
  if (!job.acceptedProject || !Array.isArray(job.sourceCohort)) {
    const error = new Error('The native backend did not bind the accepted export sources.')
    await api('/api/export/finish', { id: job.id, error: error.message, drained: true }).catch(() => {})
    throw error
  }
  const snapshot = structuredClone(job.acceptedProject)
  const completion = queue.then(() => runNativeExport(snapshot, job))
  queue = completion.catch(() => {})
  return { job, completion }
}

/** Renders a registered job and finishes it only after all file writes succeed. */
export async function runNativeExport(project, job) {
  if (!job.acceptedProject || !Array.isArray(job.sourceCohort)) {
    const error = new Error('The native backend did not bind the accepted export sources.')
    await api('/api/export/finish', { id: job.id, error: error.message, drained: true }).catch(() => {})
    throw error
  }
  project = structuredClone(job.acceptedProject)
  project.__aryaExportSourceRevision = job.sourceCohortID
  const { preset, width, height, fps, range, frames } = job.spec
  let output, r, failure, receipt
  const drain = new NativeExportDrain()
  let progress = 0, lastCheck = -Infinity
  let rejectCancellation, pollBusy = false
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject })
  const wait = operation => drain.wait(operation, cancellation)
  // Poll separately from encoding so Cancel also interrupts an encoder's pending add.
  const poll = setInterval(async () => {
    if (pollBusy) return
    pollBusy = true
    try {
      const status = await api('/api/export/progress', { id: job.id, progress })
      if (status.cancelled) rejectCancellation(new Error('cancelled'))
    } catch (error) { rejectCancellation(error) }
    finally { pollBusy = false }
  }, 300)
  cancellation.catch(() => {})
  const check = async (next = progress, force = false) => {
    progress = next
    if (!force && performance.now() - lastCheck < 250) return
    lastCheck = performance.now()
    const status = await api('/api/export/progress', { id: job.id, progress })
    if (status.cancelled) throw new Error('cancelled')
  }
  const write = async (data, position) => {
    const status = await host.save(data, { job: job.id, position })
    if (status.cancelled) throw new Error('cancelled')
  }
  try {
    await waitNativeAdmission(api, job.id)
    await check(0, true)
    const audioOnly = preset.startsWith('audio')
    const wavOnly = preset === 'audio-wav'
    const codec = preset === 'hevc' ? 'hevc' : 'avc'
    const quality = new Quality({ bitrate: Math.max(1_000_000, Math.round(width * height * fps * (preset === 'h264-web' ? 0.08 : 0.18))) })
    const audioQuality = new Quality({ bitrate: 256_000 })
    if (!audioOnly && !(await canEncodeVideo(codec, { width, height, frameRate: fps, quality, latencyMode: 'realtime' }))) {
      throw new Error(`${preset === 'hevc' ? 'HEVC' : 'H.264'} encoding is unavailable at ${width}×${height}. Choose another preset or resolution.`)
    }
    if (!wavOnly && !(await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: RATE, quality: audioQuality }))) throw new Error('AAC encoding is unavailable on this device. Use the WAV audio preset.')
    r = renderer(project, width, height)
    drain.trackMedia(r.media)
    r.lutSnapshot = await wait(loadLuts(r.comp, project, { pin: true, from: range.in, frames: audioOnly ? 0 : frames, fps }))
    // The shared mixer applies clip, track and master processing, including latency.
    if (wavOnly) {
      const wav = await wait(r.audio.renderWav(project, range.in, range.out, { processingJob: job.id }))
      await check(0.9, true)
      await write(new Uint8Array(await wav.arrayBuffer()), 0)
    } else {
      const target = new StreamTarget(new WritableStream({ write: chunk => write(chunk.data, chunk.position) }), { chunked: true, chunkSize: 1024 * 1024 })
      output = new Output({ target, format: new Mp4OutputFormat({ fastStart: false }) })
      // WebKit's quality-mode H.264 encoder can stall without producing packets.
      const video = !audioOnly ? new CanvasSource(r.canvas, { codec, quality, keyFrameInterval: 2, latencyMode: 'realtime' }) : null
      const audio = new AudioBufferSource({ codec: 'aac', quality: audioQuality })
      if (video) output.addVideoTrack(video, { frameRate: fps })
      output.addAudioTrack(audio)
      await output.start()
      const channels = await wait(r.audio.renderBuffer(project, range.in, range.out, { processingJob: job.id }))
      await check(0.1, true)
      let audioOffset = 0
      // Interleave one second of audio with the corresponding video. The muxer can
      // flush packets instead of retaining a complete encoded soundtrack in memory.
      const addAudioThrough = async seconds => {
        const end = Math.min(channels[0].length, Math.ceil(seconds * RATE))
        while (audioOffset < end) {
          await check()
          const length = Math.min(RATE, end - audioOffset)
          const buffer = new AudioBuffer({ numberOfChannels: 2, length, sampleRate: RATE })
          channels.forEach((channel, i) => buffer.copyToChannel(channel.subarray(audioOffset, audioOffset + length), i))
          await wait(audio.add(buffer))
          audioOffset += length
          if (audioOnly) await check(0.1 + 0.85 * audioOffset / channels[0].length)
        }
      }
      if (video) {
        for (let i = 0; i < frames; i++) {
          await check(0.1 + 0.85 * i / frames)
          await wait(r.player.renderExact(range.in + (i + 0.0001) / fps))
          await wait(video.add(i / fps, Math.min(1 / fps, range.out - range.in - i / fps)))
          if (i % Math.max(1, Math.round(fps)) === 0) await addAudioThrough((i + fps) / fps)
        }
      }
      await addAudioThrough(Infinity)
      await check(0.96, true)
      await wait(r.lutSnapshot.validate())
      await wait(output.finalize())
    }
    await wait(r.lutSnapshot.validate())
    await check(1, true)
  } catch (error) {
    failure = error
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {})
    throw error
  } finally {
    clearInterval(poll)
    try { receipt = await drain.finish(api, job.id, async () => { await r?.close() }, failure) }
    catch (error) { if (!failure) throw error }
  }
  return receipt
}

/** Saves a native still through the backend's shared processing admission. */
export async function saveNativeFrame(project, { at, width = project.width, comp } = {}) {
  return api('/api/frame', { at: at ?? 0, width, comp, expectedProject: JSON.stringify(project), name: `frame-${Date.now()}-${crypto.randomUUID()}.png` })
}

/** The host awaits this before invalidating the current page's message session. */
export async function drainNativePageExports() { await queue }
