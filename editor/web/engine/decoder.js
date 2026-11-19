// Sequential frame access for exports: WebCodecs decoding through Mediabunny, so
// consecutive frames cost one decode each instead of a seek from the last keyframe.

import { ALL_FORMATS, BlobSource, Input, UrlSource, VideoSampleSink } from '/vendor/mediabunny/dist/bundles/mediabunny.min.mjs'

import { host } from '../host.js'

export class FrameReader {
  constructor(url) {
    this.url = url
    this.plan = null
    this.generation = 0
    this.ready = this.open()
  }

  async open() {
    const file = host.fileForURL(this.url)
    const input = this.input = new Input({ source: file ? new BlobSource(file) : new UrlSource(new URL(this.url, location.href).href), formats: ALL_FORMATS })
    try {
      const track = await input.getPrimaryVideoTrack()
      if (this.closed || !track || !(await track.canDecode())) throw new Error(`cannot decode ${this.url}`)
      if (this.closed) throw new Error('Decoder closed')
      this.sink = new VideoSampleSink(track)
      this.rotation = track.rotation // clockwise; toVideoFrame() returns unrotated pixels
      this.width = track.displayWidth
      this.height = track.displayHeight
    } catch (error) { this.disposeInput(); throw error }
  }

  /** The source times this clip will be asked for, in order (an export's frames). */
  setPlan(times) {
    if (this.closed) throw new Error('Decoder closed')
    this.endPlan()
    this.generation++
    this.plan = { times, index: 0, iter: null }
  }

  /** The decoded frame at source time t (a VideoFrame the caller must close). */
  async frameAt(t) {
    await this.ready
    if (this.closed) throw new Error('Decoder closed')
    const generation = this.generation
    const plan = this.plan
    let sample
    if (plan && plan.index < plan.times.length && Math.abs(plan.times[plan.index] - t) < 1e-4) {
      if (!plan.iter || plan.index >= plan.batchEnd) {
        // Mediabunny keeps a few hundred bytes per requested time until its iterator ends,
        // so a long export reads its plan in batches. Each new batch starts at a key frame.
        // return() ends a pending next() at once, so the old batch closes after its last read.
        const old = plan.iter
        if (old) Promise.resolve(plan.last).finally(() => closeIterator(old)).catch(() => {})
        plan.batchEnd = Math.min(plan.times.length, plan.index + PLAN_BATCH)
        plan.iter = this.sink.samplesAtTimestamps(plan.times.slice(plan.index, plan.batchEnd))
      }
      plan.index++
      const read = plan.last = plan.iter.next()
      const { value } = await read
      sample = value
    } else sample = await this.sink.getSample(t)
    if (this.closed || generation !== this.generation) {
      sample?.close()
      throw new Error('Decoder request is no longer current')
    }
    return sample ? sampleToFrame(sample) : null
  }

  endPlan() {
    closeIterator(this.plan?.iter)
    this.plan = null
  }

  disposeInput() {
    if (this.inputDisposed || !this.input) return
    this.inputDisposed = true
    this.input.dispose()
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.generation++
    this.endPlan()
    this.disposeInput()
  }
}

/** Planned times per Mediabunny iterator: about 1.4 MB of its bookkeeping at most. */
export const PLAN_BATCH = 4096

function closeIterator(iter) {
  try { Promise.resolve(iter?.return?.()).catch(() => {}) } catch {}
}

function sampleToFrame(sample) {
  try { return sample.toVideoFrame() }
  finally { sample.close() }
}
