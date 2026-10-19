// Audio engine: decodes clip audio from the server, plans what sounds when (clips inside
// compositions and the audio angle of multicam clips included), builds the mixing graph and
// plays it live against the AudioContext clock. renderWav builds the same graph in an
// OfflineAudioContext, so an export sounds exactly like playback.
//
// Signal flow, each chain in this order:
//   clip   source → legacy eq {low, mid, high} → clip.fx → volume (keyframes, fades) → pan
//   comp   (its tracks' buses) → the comp clip's own chain, as above
//   track  sum → track.fx → volume → pan → [meters] → master
//   master sum → master.fx → master.volume → master.limiter → output
// Effects are { type, enabled, params } (see audio-worklets/fx.js). The limiter's lookahead is
// compensated: sources start early by the latency below them, and the master's latency is
// absorbed by `when` (live) or trimmed (offline), so timeline time t sounds at `when + t - t0`.

import { clipEnd, compView, gainAt, hasAudio, valueAt } from '/core/project.js'
import { host } from '../host.js'
import { dbToLin, measure as measureChannels, reverbImpulse } from './audio-worklets/dsp.js'
import { activeFx, chainLatency, DYNAMICS, eqBands, FX_TYPES, fxLatency, fxParams, legacyEqBands, masterChain } from './audio-worklets/fx.js'

const WHOLE_LIMIT = 300 // seconds; longer sources are fetched per clip range
const RATE = 48000
const STEP = 1 / 50 // automation sampling, timeline seconds
const MAX_DEPTH = 16
const WORKLETS = new URL('./audio-worklets/processors.js', import.meta.url).href
const DYNAMIC_PARAMS = ['threshold', 'ratio', 'attack', 'release', 'knee', 'makeup', 'hold', 'range', 'lo', 'hi', 'ceiling']

// ---------------------------------------------------------------- planning (pure)

/** Whether a track is audible given mute/solo across the tracks of its timeline. */
export function audible(p, track) {
  const solo = p.tracks.some(t => t.kind === 'audio' && t.solo)
  if (track.muted) return false
  if (solo && track.kind === 'audio' && !track.solo) return false

  return true
}

/**
 * Whether a clip makes sound. A comp clip does when anything audible inside its composition does,
 * at any depth (video clips with embedded sound included, as on the main timeline).
 */
export function sounds(p, c, depth = 0) {
  if (c.enabled === false) return false
  if (c.kind !== 'comp') return hasAudio(p, c)
  if (c.mute || depth >= MAX_DEPTH || !p.comps?.[c.comp]) return false
  const view = compView(p, c.comp)

  return view.tracks.some(t => audible(view, t) && t.clips.some(x => sounds(view, x, depth + 1)))
}

/** The media a sounding clip reads: its source, the source second at clip time 0, and source seconds per clip second. */
export function leafSource(c) {
  if (c.kind === 'multicam') {
    const angle = c.angles?.[c.audioAngle ?? 0]
    if (!angle?.src) return null

    return { src: angle.src, srcIn: (c.in ?? 0) + (angle.offset ?? 0), speed: c.speed ?? 1 }
  }
  if (!c.src) return null

  return { src: c.src, srcIn: c.in ?? 0, speed: c.speed ?? 1 }
}

/**
 * The sounding clips of a timeline scope, grouped by track. Scope time τ maps to main-timeline
 * time T = A + B·τ, and only [w0, w1) of the main timeline is wanted. A comp clip becomes a
 * `comp` item holding its composition's buses, mapped by the clip's start, in and speed.
 */
export function planScope(p, A, B, w0, w1, depth = 0) {
  const buses = []
  for (const track of p.tracks) {
    if (!audible(p, track)) continue
    const items = []
    for (const c of track.clips) {
      if (!sounds(p, c, depth)) continue
      const from = Math.max(w0, A + B * c.start)
      const to = Math.min(w1, A + B * clipEnd(c))
      if (!(to > from + 1e-9)) continue
      if (c.kind === 'comp') {
        const s = c.speed > 0 ? c.speed : 1
        const inner = planScope(compView(p, c.comp), A + B * (c.start - (c.in ?? 0) / s), B / s, from, to, depth + 1)
        if (inner.length) items.push({ kind: 'comp', clip: c, view: p, A, B, from, to, buses: inner })
        continue
      }
      const leaf = leafSource(c)
      if (!leaf || !(leaf.speed > 0)) continue
      // A source has nothing before its first sample: an angle with a negative offset starts late.
      const first = leaf.srcIn < 0 ? A + B * (c.start - leaf.srcIn / leaf.speed) : -Infinity
      const f = Math.max(from, first)
      if (!(to > f + 1e-9)) continue
      items.push({ kind: 'leaf', clip: c, view: p, A, B, from: f, to, ...leaf })
    }
    if (items.length) buses.push({ track, items })
  }

  return buses
}

/** What sounds in [t0, end) of the main timeline, and the master settings. */
export function planAudio(p, t0, end = Infinity) {
  return { master: masterChain(p.master), buses: planScope(p, 0, 1, t0, end) }
}

/** Every leaf (playing source) of a plan. */
export function planLeaves(plan) {
  const out = []
  const walk = buses => {
    for (const b of buses) for (const it of b.items) it.kind === 'comp' ? walk(it.buses) : out.push(it)
  }
  walk(plan.buses)

  return out
}

/** Clip-local seconds and source seconds of a plan item at main-timeline time T. */
export const itemLocal = (item, T) => (T - item.A) / item.B - item.clip.start
export const itemSource = (item, T) => item.srcIn + itemLocal(item, T) * item.speed

/**
 * How a leaf's buffer source plays: the context time it starts (`latency` early, so it is heard
 * at the right time after the effects below it), the buffer offset and duration (buffer
 * seconds), and the playback rate. `bufferFrom` is the source second the buffer starts at;
 * a start before `now` is moved to now and the offset advanced to match.
 */
export function leafTiming(item, { t0, when, rate = 1, latency = 0, bufferFrom = 0, now = -Infinity }) {
  const playbackRate = (item.speed / item.B) * rate
  let at = when + (item.from - t0) / rate - latency
  let offset = itemSource(item, item.from) - bufferFrom
  let dur = ((item.to - item.from) * item.speed) / item.B
  if (at < now) {
    const skip = (now - at) * playbackRate
    at = now
    offset += skip
    dur -= skip
  }

  return { at, offset, dur, playbackRate }
}

/** The processing steps of a clip (or comp clip), in order. */
export function clipSteps(c) {
  const steps = []
  const legacy = legacyEqBands(c.eq)
  if (legacy.length) steps.push({ kind: 'eq', bands: legacy })
  for (const { fx, index } of activeFx(c.fx)) steps.push({ kind: 'fx', fx, index })
  steps.push({ kind: 'volume' }, { kind: 'pan' })

  return steps
}

export function trackSteps(track) {
  return [...activeFx(track.fx).map(({ fx, index }) => ({ kind: 'fx', fx, index })), { kind: 'volume', db: track.volume ?? 0 }, { kind: 'pan', value: track.pan ?? 0 }]
}

export function masterSteps(master) {
  const steps = activeFx(master.fx).map(({ fx, index }) => ({ kind: 'fx', fx, index }))
  steps.push({ kind: 'volume', db: master.volume ?? 0 })
  if (master.limiter) steps.push({ kind: 'fx', fx: master.limiter, index: -1 })

  return steps
}

/** Latency (s) of the master chain, and the largest latency of any source path including it. */
export function planLatency(plan, fs = RATE) {
  const master = chainLatency(plan.master.fx, fs) + (plan.master.limiter ? fxLatency(plan.master.limiter, fs) : 0)
  const walk = (buses, down) => {
    let max = down
    for (const b of buses) {
      const d = down + chainLatency(b.track.fx, fs)
      for (const it of b.items) {
        const own = d + chainLatency(it.clip.fx, fs)
        max = Math.max(max, it.kind === 'comp' ? walk(it.buses, own) : own)
      }
    }

    return max
  }

  return { master, max: master + walk(plan.buses, 0) }
}

// ---------------------------------------------------------------- graph building

const workletLoads = new WeakMap()

/** Loads the processors into a context once; resolves false when AudioWorklet is unavailable. */
export function loadWorklets(ctx) {
  if (!workletLoads.has(ctx)) {
    const load = ctx.audioWorklet
      ? ctx.audioWorklet.addModule(WORKLETS).then(
          () => true,
          error => {
            console.warn('audio worklets failed to load; dynamics effects are bypassed', error)

            return false
          },
        )
      : Promise.resolve(false)
    workletLoads.set(ctx, load)
  }

  return workletLoads.get(ctx)
}

const impulses = new WeakMap()

function impulseBuffer(ctx, params) {
  if (!impulses.has(ctx)) impulses.set(ctx, new Map())
  const cache = impulses.get(ctx)
  const key = `${params.size.toFixed(3)}|${params.decay.toFixed(3)}`
  if (!cache.has(key)) {
    const [l, r] = reverbImpulse(ctx.sampleRate, params, 1)
    const buffer = ctx.createBuffer(2, l.length, ctx.sampleRate)
    buffer.copyToChannel(l, 0)
    buffer.copyToChannel(r, 1)
    cache.set(key, buffer)
  }

  return cache.get(key)
}

let warnedBypass = false

/**
 * Builds one effect after `input` and returns { out, params }. `params` maps a parameter path
 * (as in `fx.<i>.params.<path>` keyframes) to [AudioParam, value → param value] pairs.
 */
function buildFx(env, fx, input) {
  const { ctx } = env
  const P = fxParams(fx)
  const node = n => (env.nodes.push(n), n)
  const params = {}
  switch (fx.type) {
    case 'gain': {
      const g = node(ctx.createGain())
      g.gain.value = dbToLin(P.gain)
      input.connect(g)
      params.gain = [[g.gain, dbToLin]]

      return { out: g, params }
    }
    case 'eq': {
      let out = input
      eqBands(fx).forEach((b, k) => {
        out = biquad(env, out, b)
        params[`bands.${k}.gain`] = [[out.gain, v => v]]
        params[`bands.${k}.freq`] = [[out.frequency, v => v]]
        params[`bands.${k}.q`] = [[out.Q, b.type === 'lowpass' || b.type === 'highpass' ? v => 20 * Math.log10(Math.max(1e-3, v)) : v => v]]
      })

      return { out, params }
    }
    case 'reverb': {
      const out = node(ctx.createGain())
      const dry = node(ctx.createGain())
      const wet = node(ctx.createGain())
      const pre = node(ctx.createDelay(1))
      const conv = node(ctx.createConvolver())
      dry.gain.value = 1 - P.mix
      wet.gain.value = P.mix
      pre.delayTime.value = P.predelay / 1000
      conv.buffer = impulseBuffer(ctx, P)
      input.connect(dry).connect(out)
      input.connect(pre).connect(conv).connect(wet).connect(out)
      params.mix = [[wet.gain, v => v], [dry.gain, v => 1 - v]]

      return { out, params }
    }
    case 'delay': {
      const out = node(ctx.createGain())
      const dry = node(ctx.createGain())
      const wet = node(ctx.createGain())
      const d = node(ctx.createDelay(2.5))
      const fb = node(ctx.createGain())
      dry.gain.value = 1 - P.mix
      wet.gain.value = P.mix
      d.delayTime.value = P.time / 1000
      fb.gain.value = Math.min(0.95, P.feedback)
      input.connect(dry).connect(out)
      input.connect(d)
      d.connect(fb).connect(d)
      d.connect(wet).connect(out)
      params.time = [[d.delayTime, v => v / 1000]]
      params.feedback = [[fb.gain, v => Math.min(0.95, v)]]
      params.mix = [[wet.gain, v => v], [dry.gain, v => 1 - v]]

      return { out, params }
    }
    default: {
      if (!DYNAMICS.has(fx.type)) return { out: input, params }
      if (!env.worklets) {
        if (!warnedBypass) console.warn(`audio worklets unavailable: ${fx.type} bypassed`)
        warnedBypass = true

        return { out: input, params }
      }
      const parameterData = Object.fromEntries(DYNAMIC_PARAMS.filter(k => k in P).map(k => [k, P[k]]))
      const w = new AudioWorkletNode(ctx, 'reel-dynamics', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { type: fx.type, params: P },
        parameterData,
      })
      node(w)
      env.workletNodes.push(w)
      input.connect(w)
      for (const k of Object.keys(parameterData)) params[k] = [[w.parameters.get(k), v => v]]

      return { out: w, params }
    }
  }
}

function biquad(env, input, b) {
  const f = env.ctx.createBiquadFilter()
  f.type = b.type
  f.frequency.value = b.freq
  // Web Audio takes the low/high-pass Q as a resonance in dB; the project stores a linear Q.
  f.Q.value = b.type === 'lowpass' || b.type === 'highpass' ? 20 * Math.log10(b.q) : b.q
  f.gain.value = b.gain
  input.connect(f)
  env.nodes.push(f)

  return f
}

/** Builds a chain of steps after `input`; returns its output, the volume and pan nodes and the fx params. */
function buildChain(env, input, steps) {
  let out = input
  let volume = null
  let pan = null
  const fx = {}
  for (const s of steps) {
    if (s.kind === 'eq') for (const b of s.bands) out = biquad(env, out, b)
    else if (s.kind === 'fx') {
      const built = buildFx(env, s.fx, out)
      out = built.out
      fx[s.index] = built.params
    } else if (s.kind === 'volume') {
      volume = env.ctx.createGain()
      volume.gain.value = dbToLin(s.db ?? 0)
      out.connect(volume)
      env.nodes.push(volume)
      out = volume
    } else if (s.kind === 'pan') {
      pan = env.ctx.createStereoPanner()
      pan.pan.value = s.value ?? 0
      out.connect(pan)
      env.nodes.push(pan)
      out = pan
    }
  }

  return { out, volume, pan, fx }
}

/** Samples a clip's volume, pan and effect keyframes onto its nodes over the item's span. */
function automate(env, item, built, down) {
  const { when, t0, rate } = env
  const c = item.clip
  const view = item.view
  const at = T => when + (T - t0) / rate - down
  const props = []
  props.push({ param: [[built.volume.gain, v => v]], value: l => gainAt(view, c, l), animated: Boolean(c.fadeIn || c.fadeOut || c.anim?.volume || c.expr?.volume) })
  props.push({ param: [[built.pan.pan, v => Math.max(-1, Math.min(1, v))]], value: l => valueAt(view, c, 'pan', l), animated: Boolean(c.anim?.pan || c.expr?.pan) })
  const animatedFx = new Set([...Object.keys(c.anim ?? {}), ...Object.keys(c.expr ?? {})].filter(k => k.startsWith('fx.')))
  for (const prop of animatedFx) {
    const m = /^fx\.(\d+)\.params\.(.+)$/.exec(prop)
    const param = m && built.fx[Number(m[1])]?.[m[2]]
    if (param) props.push({ param, value: l => valueAt(view, c, prop, l), animated: true })
  }
  const t1 = at(item.from)
  for (const pr of props) for (const [ap, f] of pr.param) ap.setValueAtTime(f(pr.value(itemLocal(item, item.from))), Math.max(0, t1))
  const moving = props.filter(pr => pr.animated)
  if (!moving.length) return
  for (let T = item.from + STEP; T < item.to; T += STEP) {
    const l = itemLocal(item, T)
    for (const pr of moving) for (const [ap, f] of pr.param) ap.linearRampToValueAtTime(f(pr.value(l)), at(T))
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = null
    this.buffers = new Map() // key → Promise<AudioBuffer>
    this.previewRetryMs = 5000
    this.live = null
    this.meters = new Map() // track id → analyser (peak/RMS)
    this.trackPeaks = new Map() // track id → { truePeak [l, r], samplePeak [l, r], hold [l, r] } (dBTP via TruePeak)
    this.loudness = null // master { momentary, shortTerm, integrated, lra, truePeak, truePeakMax }
    this.master = null
  }

  context() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' })
      this.master = this.ctx.createGain()
      this.masterAnalyser = this.ctx.createAnalyser()
      this.masterAnalyser.fftSize = 2048
      this.splitter = this.ctx.createChannelSplitter(2)
      this.masterL = this.ctx.createAnalyser()
      this.masterR = this.ctx.createAnalyser()
      this.masterL.fftSize = this.masterR.fftSize = 1024
      this.master.connect(this.masterAnalyser)
      this.master.connect(this.splitter)
      this.splitter.connect(this.masterL, 0)
      this.splitter.connect(this.masterR, 1)
      this.master.connect(this.ctx.destination)
    }

    return this.ctx
  }

  /** Loads the worklets into the live context and puts the loudness meter after the master. */
  ready() {
    const ctx = this.context()
    this.readyPromise ??= loadWorklets(ctx).then(ok => {
      if (!ok) return false
      const meter = new AudioWorkletNode(ctx, 'reel-meter', { outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { loudness: true } })
      meter.port.onmessage = e => (this.loudness = e.data)
      this.master.disconnect(ctx.destination)
      this.master.connect(meter).connect(ctx.destination)
      this.masterMeter = meter

      return true
    })

    return this.readyPromise
  }

  /** Clears the integrated loudness and the peak holds. */
  resetMeters() {
    this.masterMeter?.port.postMessage({ type: 'reset' })
    this.loudness = null
    for (const n of this.live?.trackMeters ?? []) n.port.postMessage({ type: 'reset' })
    this.trackPeaks.clear()
  }

  /** Where a clip's audio comes from: the whole source when short, else its range. */
  bufferKey(p, c) {
    const a = p.assets[c.src] ?? {}
    if ((a.duration ?? 0) <= WHOLE_LIMIT) return { key: `${c.src}|all`, from: 0, dur: a.duration ?? 600, whole: true }
    const speed = c.speed ?? 1
    const from = Math.max(0, (c.in ?? 0) - 2)
    const dur = c.dur * speed + 4

    return { key: `${c.src}|${from.toFixed(2)}|${dur.toFixed(2)}`, from, dur, whole: false }
  }

  load(p, c, signal, processingJob) {
    const { key: sourceKey, from, dur } = this.bufferKey(p, c)
    const revision = p.__aryaExportSourceRevision
    const localKey = host.kind === 'browser-local' ? `${host.browser.root()}|${host.browser.generation}|${sourceKey}` : sourceKey
    const key = revision ? `${localKey}|export=${revision}` : localKey
    if (!this.buffers.has(key)) {
      const ctx = this.context()
      const url = `/api/audio?src=${encodeURIComponent(c.src)}&in=${from}&dur=${dur}${processingJob ? `&processingJob=${encodeURIComponent(processingJob)}` : ''}${revision ? `&sourceRevision=${encodeURIComponent(revision)}` : ''}`
      const pending = (host.kind === 'browser-local' ? host.audioBuffer(c.src, from, dur, ctx, signal, revision) : fetch(url, { signal })
        .then(r => { signal?.throwIfAborted(); return r.ok ? r.arrayBuffer() : Promise.reject(new Error(`audio ${r.status}`)) })
        .then(b => { signal?.throwIfAborted(); return ctx.decodeAudioData(b) }))
        .then(buffer => { signal?.throwIfAborted(); return buffer })
        .catch(error => {
          if (host.kind === 'browser-local' || signal?.aborted || processingJob) { this.buffers.delete(key); throw error }
          // Preview plays this attempt without the clip's sound. A later load retries, since
          // the server answers 429 while busy and the clip must not stay silent all session.
          setTimeout(() => { if (this.buffers.get(key) === pending) this.buffers.delete(key) }, this.previewRetryMs)
          return null
        })
      this.buffers.set(key, pending)
    }

    return this.buffers.get(key).then(buffer => ({ buffer, from }))
  }

  /** The buffer of a plan leaf (comp and multicam leaves read their own sources). */
  loadLeaf(item, signal, processingJob) {
    return this.load(item.view, { src: item.src, in: Math.max(0, item.srcIn), dur: item.clip.dur, speed: item.speed }, signal, processingJob)
  }

  preload(p) {
    for (const item of planLeaves(planAudio(p, 0))) { const pending = this.loadLeaf(item); if (host.kind === 'browser-local') pending.catch(error => host.browser.emit('import', { state: 'failed', error: `Audio preview: ${error.message}` })) }
  }

  /** Whether a track is audible given mute/solo across tracks. */
  static audible(p, track) {
    return audible(p, track)
  }

  /**
   * Builds the graph on ctx so that timeline time t0 is heard at context time `when`, through
   * `destination`. Returns { nodes, workletNodes, trackMeters }.
   */
  async schedule(ctx, destination, p, t0, when, rate, options = {}) {
    const plan = options.plan ?? planAudio(p, t0, options.end ?? Infinity)
    const worklets = await loadWorklets(ctx)
    const leaves = planLeaves(plan)
    const loaded = new Map(), batch = options.processingJob ? 4 : Math.max(1, leaves.length)
    for (let offset = 0; offset < leaves.length; offset += batch) {
      options.signal?.throwIfAborted()
      const results = await Promise.allSettled(leaves.slice(offset, offset + batch).map(async it => [it, await this.loadLeaf(it, options.signal, options.processingJob)]))
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
      for (const result of results) loaded.set(...result.value)
    }
    options.signal?.throwIfAborted()
    const env = { ctx, t0, when, rate, nodes: [], workletNodes: [], trackMeters: [], worklets, now: options.now ?? 0 }
    const fs = ctx.sampleRate
    // Master: sum → master fx → volume → limiter → destination.
    const masterIn = ctx.createGain()
    env.nodes.push(masterIn)
    buildChain(env, masterIn, masterSteps(plan.master)).out.connect(destination)
    const masterLatency = planLatency(plan, fs).master

    const buildLeaf = (item, dest, down) => {
      const got = loaded.get(item)
      if (!got?.buffer) return
      const lat = chainLatency(item.clip.fx, fs)
      const tm = leafTiming(item, { t0, when, rate, latency: down + lat, bufferFrom: got.from, now: env.now })
      if (tm.dur <= 1e-6 || tm.offset >= got.buffer.duration) return
      const src = ctx.createBufferSource()
      src.buffer = got.buffer
      src.playbackRate.value = tm.playbackRate
      env.nodes.push(src)
      const built = buildChain(env, src, clipSteps(item.clip))
      built.out.connect(dest)
      automate(env, item, built, down)
      src.start(Math.max(env.now, tm.at), Math.max(0, tm.offset), tm.dur)
    }

    const buildBuses = (buses, dest, down, main) => {
      for (const bus of buses) {
        const input = ctx.createGain()
        env.nodes.push(input)
        let out = buildChain(env, input, trackSteps(bus.track)).out
        if (main && options.meters) out = this.trackMeter(env, bus.track, out)
        out.connect(dest)
        const d = down + chainLatency(bus.track.fx, fs)
        for (const item of bus.items) {
          if (item.kind === 'leaf') buildLeaf(item, input, d)
          else {
            const cin = ctx.createGain()
            env.nodes.push(cin)
            const built = buildChain(env, cin, clipSteps(item.clip))
            built.out.connect(input)
            automate(env, item, built, d)
            buildBuses(item.buses, cin, d + chainLatency(item.clip.fx, fs), false)
          }
        }
      }
    }
    buildBuses(plan.buses, masterIn, masterLatency, true)

    return env
  }

  /** Analyser (peak/RMS) and true-peak meter for a main-timeline track, in line after its pan. */
  trackMeter(env, track, out) {
    const an = env.ctx.createAnalyser()
    an.fftSize = 1024
    out.connect(an)
    env.nodes.push(an)
    this.meters.set(track.id, an)
    if (!env.worklets) return out
    const m = new AudioWorkletNode(env.ctx, 'reel-meter', { outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { loudness: false } })
    m.port.onmessage = e => {
      const prev = this.trackPeaks.get(track.id)
      const hold = (prev?.hold ?? [0, 0]).map((v, i) => Math.max(v, e.data.truePeak[i]))
      this.trackPeaks.set(track.id, { ...e.data, hold })
    }
    out.connect(m)
    env.nodes.push(m)
    env.workletNodes.push(m)
    env.trackMeters.push(m)

    return m
  }

  /**
   * Starts the mix at timeline t0 and returns the AudioContext time t0 is heard at, which the
   * player uses as its clock origin.
   */
  async play(p, t0, rate = 1) {
    const fresh = !this.live
    this.stop()
    const ctx = this.context()
    if (ctx.state !== 'running') await ctx.resume()
    const token = {}
    this.live = { token, nodes: [], workletNodes: [], trackMeters: [] }
    if (rate <= 0) return ctx.currentTime
    const plan = planAudio(p, t0)
    // Decode first, so scheduling does not lag behind the clock.
    await Promise.all([this.ready(), ...planLeaves(plan).map(it => this.loadLeaf(it))])
    if (this.live?.token !== token) return ctx.currentTime
    if (fresh) this.resetMeters()
    const when = ctx.currentTime + 0.05 + planLatency(plan, ctx.sampleRate).max
    const env = await this.schedule(ctx, this.master, p, t0, when, rate, { meters: true, plan, now: ctx.currentTime })
    if (this.live?.token !== token) {
      AudioEngine.release(env)

      return when
    }
    Object.assign(this.live, { nodes: env.nodes, workletNodes: env.workletNodes, trackMeters: env.trackMeters })

    return when
  }

  static release(env) {
    for (const w of env.workletNodes) w.port.postMessage({ type: 'dispose' })
    for (const n of env.nodes) {
      try {
        n.stop?.()
      } catch {}
      try {
        n.disconnect()
      } catch {}
    }
  }

  stop() {
    if (!this.live) return
    AudioEngine.release(this.live)
    this.live = null
    this.meters.clear()
  }

  /** Mixes [from, to) offline into channel data, latency-compensated. */
  async renderBuffer(p, from, to, { signal, processingJob } = {}) {
    signal?.throwIfAborted()
    const plan = planAudio(p, from, to)
    const { max } = planLatency(plan, RATE)
    const pre = Math.ceil(max * RATE)
    const length = Math.max(1, Math.ceil((to - from) * RATE))
    const ctx = new OfflineAudioContext(2, length + pre, RATE)
    const env = await this.schedule(ctx, ctx.destination, p, from, pre / RATE, 1, { end: to, plan, now: 0, signal, processingJob })
    try {
      signal?.throwIfAborted()
      const rendered = await ctx.startRendering()
      signal?.throwIfAborted()
      return [0, 1].map(c => rendered.getChannelData(c).slice(pre, pre + length))
    } finally { AudioEngine.release(env) }
  }

  /** Mixes [from, to) offline and returns a 16-bit stereo WAV. */
  async renderWav(p, from, to, options) {
    const chans = await this.renderBuffer(p, from, to, options)

    return encodeWav({ numberOfChannels: 2, length: chans[0].length, sampleRate: RATE, getChannelData: c => chans[c] })
  }

  /** Renders [from, to) offline and measures it: integrated loudness, LRA, maxima and peaks. */
  async measure(p, from, to) {
    return measureChannels(await this.renderBuffer(p, from, to), RATE)
  }

  /** Peak and RMS (linear) of an analyser, for meters. */
  static level(an) {
    if (!an) return { peak: 0, rms: 0 }
    const data = new Float32Array(an.fftSize)
    an.getFloatTimeDomainData(data)
    let peak = 0
    let sum = 0
    for (const v of data) {
      const a = Math.abs(v)
      if (a > peak) peak = a
      sum += v * v
    }

    return { peak, rms: Math.sqrt(sum / data.length) }
  }
}

export { FX_TYPES }

export function encodeWav(buffer) {
  const ch = buffer.numberOfChannels
  const len = buffer.length
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2))
  const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  out.setUint32(4, 36 + len * ch * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true)
  out.setUint16(22, ch, true)
  out.setUint32(24, buffer.sampleRate, true)
  out.setUint32(28, buffer.sampleRate * ch * 2, true)
  out.setUint16(32, ch * 2, true)
  out.setUint16(34, 16, true)
  str(36, 'data')
  out.setUint32(40, len * ch * 2, true)
  const chans = Array.from({ length: ch }, (_, i) => buffer.getChannelData(i))
  let o = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]))
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      o += 2
    }
  }

  return new Blob([out.buffer], { type: 'audio/wav' })
}
