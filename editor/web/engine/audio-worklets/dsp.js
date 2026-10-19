// Pure DSP for Reel's audio: biquads, ITU-R BS.1770-4 K-weighting and loudness (EBU R128
// momentary, short-term, integrated, LRA), BS.1770-4 Annex 2 true peak, and stereo-linked
// dynamics (compressor, noise gate, de-esser, lookahead limiter), plus a seeded reverb impulse.
// No imports and no Web Audio objects: the same code runs in AudioWorkletGlobalScope, on the
// main thread (offline measurement) and in Node (tests).

export const dbToLin = db => 10 ** (db / 20)
export const linToDb = v => (v > 0 ? 20 * Math.log10(v) : -Infinity)

// ---------------------------------------------------------------- biquads

/** RBJ cookbook coefficients, normalized so a0 = 1. `q` is a linear Q for every type (shelves use slope 1). */
export function biquadCoefs(type, fs, freq, q = Math.SQRT1_2, gainDb = 0) {
  const A = 10 ** (gainDb / 40)
  const w = (2 * Math.PI * Math.max(1, Math.min(freq, fs * 0.499))) / fs
  const cos = Math.cos(w)
  const sin = Math.sin(w)
  const alpha = sin / (2 * Math.max(1e-4, q))
  let b0, b1, b2, a0, a1, a2
  switch (type) {
    case 'lowpass':
      ;[b0, b1, b2, a0, a1, a2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha]
      break
    case 'highpass':
      ;[b0, b1, b2, a0, a1, a2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha]
      break
    case 'bandpass':
      ;[b0, b1, b2, a0, a1, a2] = [alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha]
      break
    case 'notch':
      ;[b0, b1, b2, a0, a1, a2] = [1, -2 * cos, 1, 1 + alpha, -2 * cos, 1 - alpha]
      break
    case 'peaking':
      ;[b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A]
      break
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2
      ;[b0, b1, b2] = [A * (A + 1 - (A - 1) * cos + s), 2 * A * (A - 1 - (A + 1) * cos), A * (A + 1 - (A - 1) * cos - s)]
      ;[a0, a1, a2] = [A + 1 + (A - 1) * cos + s, -2 * (A - 1 + (A + 1) * cos), A + 1 + (A - 1) * cos - s]
      break
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2
      ;[b0, b1, b2] = [A * (A + 1 + (A - 1) * cos + s), -2 * A * (A - 1 + (A + 1) * cos), A * (A + 1 + (A - 1) * cos - s)]
      ;[a0, a1, a2] = [A + 1 - (A - 1) * cos + s, 2 * (A - 1 - (A + 1) * cos), A + 1 - (A - 1) * cos - s]
      break
    }
    default:
      return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** Magnitude in dB of a normalized biquad at `freq`. */
export function biquadMagnitudeDb(c, fs, freq) {
  const w = (2 * Math.PI * freq) / fs
  const cr = Math.cos(w)
  const ci = -Math.sin(w)
  const c2r = Math.cos(2 * w)
  const c2i = -Math.sin(2 * w)
  const nr = c.b0 + c.b1 * cr + c.b2 * c2r
  const ni = c.b1 * ci + c.b2 * c2i
  const dr = 1 + c.a1 * cr + c.a2 * c2r
  const di = c.a1 * ci + c.a2 * c2i

  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
}

/** One channel of a biquad, transposed direct form II. */
export class Biquad {
  constructor(c) {
    this.c = c
    this.z1 = 0
    this.z2 = 0
  }

  next(x) {
    const { b0, b1, b2, a1, a2 } = this.c
    const y = b0 * x + this.z1
    this.z1 = b1 * x - a1 * y + this.z2
    this.z2 = b2 * x - a2 * y

    return y
  }

  reset() {
    this.z1 = this.z2 = 0
  }
}

// ---------------------------------------------------------------- loudness (BS.1770-4, EBU R128)

/**
 * The two K-weighting stages for a sample rate: the head-related high shelf and the RLB high-pass.
 * At 48 kHz they reproduce the coefficient table in BS.1770-4.
 */
export function kWeighting(fs) {
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan((Math.PI * f0) / fs)
  const Vh = 10 ** (G / 20)
  const Vb = Vh ** 0.4996667741545416
  let a0 = 1 + K / Q + K * K
  const shelf = { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 }
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan((Math.PI * f0) / fs)
  a0 = 1 + K / Q + K * K
  const highpass = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 }

  return [shelf, highpass]
}

const energyToLufs = z => (z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity)

// Gated measurements keep 0.01 LU histograms from -70 to +10 LUFS (count and energy per bin),
// so integrated loudness and LRA cost the same after an hour as after a second.
const H_MIN = -70
const H_STEP = 0.01
const H_BINS = 8000

class Histogram {
  constructor() {
    this.count = new Uint32Array(H_BINS)
    this.energy = new Float64Array(H_BINS)
    this.total = 0
  }

  add(z) {
    const l = energyToLufs(z)
    if (!(l > H_MIN)) return
    const b = Math.min(H_BINS - 1, Math.floor((l - H_MIN) / H_STEP))
    this.count[b]++
    this.energy[b] += z
    this.total++
  }

  /** Mean energy of the blocks above a loudness gate, with their count. */
  above(gate) {
    const from = Math.max(0, Math.ceil((gate - H_MIN) / H_STEP))
    let sum = 0
    let n = 0
    for (let b = from; b < H_BINS; b++) {
      sum += this.energy[b]
      n += this.count[b]
    }

    return { mean: n ? sum / n : 0, n, from }
  }
}

/**
 * A loudness meter: momentary (400 ms), short-term (3 s), integrated (gated at -70 LUFS
 * absolute and -10 LU relative) and loudness range (EBU Tech 3342). Feed it with push().
 * Stereo channels weigh 1.0 each.
 */
export class LoudnessMeter {
  constructor(fs, channels = 2) {
    this.fs = fs
    this.channels = channels
    this.subLen = Math.round(fs / 10)
    const [shelf, hp] = kWeighting(fs)
    this.filters = Array.from({ length: channels }, () => [new Biquad(shelf), new Biquad(hp)])
    this.reset()
  }

  reset() {
    for (const f of this.filters) for (const b of f) b.reset()
    this.acc = 0
    this.count = 0
    this.subs = new Float64Array(30) // energy sums of the last 30 sub-blocks of 100 ms
    this.subCount = 0
    this.blocks = new Histogram() // every 400 ms block, one per 100 ms
    this.shorts = new Histogram() // every 3 s block, one per 100 ms
  }

  /** Adds n frames; `chans` is an array of per-channel Float32Arrays. */
  push(chans, n = chans[0].length) {
    for (let i = 0; i < n; i++) {
      let e = 0
      for (let c = 0; c < this.channels; c++) {
        const f = this.filters[c]
        const x = (chans[c] ?? chans[0])[i]
        const y = f[1].next(f[0].next(x))
        e += y * y
      }
      this.acc += e
      if (++this.count === this.subLen) this.closeSub()
    }
  }

  closeSub() {
    this.subs[this.subCount % 30] = this.acc
    this.subCount++
    this.acc = 0
    this.count = 0
    if (this.subCount >= 4) this.blocks.add(this.windowEnergy(4))
    if (this.subCount >= 30) this.shorts.add(this.windowEnergy(30))
  }

  windowEnergy(nSubs) {
    let sum = 0
    for (let k = 1; k <= nSubs; k++) sum += this.subs[(this.subCount - k + 30 * 4) % 30]

    return sum / (nSubs * this.subLen)
  }

  /** Momentary loudness (LUFS) of the last 400 ms. */
  momentary() {
    return this.subCount >= 4 ? energyToLufs(this.windowEnergy(4)) : -Infinity
  }

  /** Short-term loudness of the last 3 s (shorter windows at the start). */
  shortTerm() {
    const n = Math.min(30, this.subCount)

    return n >= 4 ? energyToLufs(this.windowEnergy(n)) : -Infinity
  }

  integrated() {
    const all = this.blocks.above(H_MIN)
    if (!all.n) return -Infinity
    const gated = this.blocks.above(energyToLufs(all.mean) - 10)

    return gated.n ? energyToLufs(gated.mean) : -Infinity
  }

  /** Loudness range (LU): 10th to 95th percentile of short-term loudness, gated at -70 and -20 LU. */
  lra() {
    const h = this.shorts
    const all = h.above(H_MIN)
    if (all.n < 2) return 0
    const { n, from } = h.above(energyToLufs(all.mean) - 20)
    if (n < 2) return 0
    const pct = q => {
      const want = Math.round((n - 1) * q)
      let seen = 0
      for (let b = from; b < H_BINS; b++) {
        seen += h.count[b]
        if (seen > want) return H_MIN + (b + 0.5) * H_STEP
      }

      return H_MIN + H_BINS * H_STEP
    }

    return pct(0.95) - pct(0.1)
  }
}

/** Integrated loudness of block energies with the -70 LUFS absolute and a relative gate (LU). */
export function gatedLoudness(blocks, relative = -10) {
  let sum = 0
  let n = 0
  for (const z of blocks) {
    if (energyToLufs(z) > -70) {
      sum += z
      n++
    }
  }
  if (!n) return -Infinity
  const gate = energyToLufs(sum / n) + relative
  sum = 0
  n = 0
  for (const z of blocks) {
    const l = energyToLufs(z)
    if (l > -70 && l > gate) {
      sum += z
      n++
    }
  }

  return n ? energyToLufs(sum / n) : -Infinity
}

// ---------------------------------------------------------------- true peak (BS.1770-4 Annex 2)

/** The 48-tap, 4-phase interpolation filter of BS.1770-4 Annex 2 (12 taps per phase). */
export const TRUE_PEAK_PHASES = [
  [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625, 0.97216796875, -0.102294921875, 0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500],
  [-0.0291748046875, 0.029296875, -0.0517578125, 0.0891113281250, -0.166503906250, 0.4650878906250, 0.7797851562500, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375],
  [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.7797851562500, 0.4650878906250, -0.166503906250, 0.0891113281250, -0.0517578125, 0.029296875, -0.0291748046875],
  [-0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750, -0.102294921875, 0.97216796875, 0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375],
]

/**
 * Per-channel 4x oversampling. next(ch, x) returns the largest absolute value of the four
 * interpolated points, which lie between the samples that arrived 6 and 5 samples ago.
 */
const PHASES_FLAT = Float64Array.from(TRUE_PEAK_PHASES.flat())

export class TruePeak {
  constructor(channels = 2) {
    // Each history is stored twice in a row so the 12 newest samples are always contiguous.
    this.hist = Array.from({ length: channels }, () => new Float64Array(24))
    this.pos = new Int32Array(channels)
  }

  next(ch, x) {
    const h = this.hist[ch]
    const p = this.pos[ch]
    h[p] = x
    h[p + 12] = x
    // Newest sample at h[p + 12], the one before at h[p + 11], ...
    const base = p + 12
    let best = 0
    for (let k = 0; k < 48; k += 12) {
      let y = 0
      for (let j = 0; j < 12; j++) y += PHASES_FLAT[k + j] * h[base - j]
      const a = y < 0 ? -y : y
      if (a > best) best = a
    }
    this.pos[ch] = p === 11 ? 0 : p + 1

    return best
  }

  reset() {
    for (const h of this.hist) h.fill(0)
    this.pos.fill(0)
  }
}

function besselI0(x) {
  let sum = 1
  let term = 1
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) ** 2
    sum += term
  }

  return sum
}

/**
 * 8x reconstruction for the limiter's detector: Kaiser-windowed sinc (32 taps, beta 7) at the
 * seven points between two samples. It reads closer to an ideal reconstruction than the
 * BS.1770 meter filter at high frequencies, so the limiter holds its ceiling on any meter.
 * next(ch, x) returns the largest absolute interpolated value between the samples that arrived
 * 16 and 15 samples ago.
 */
export class Interpolator {
  static TAPS = 32
  static PHASES = 8

  static table() {
    if (Interpolator.cached) return Interpolator.cached
    const { TAPS, PHASES } = Interpolator
    const half = TAPS / 2
    const t = new Float64Array((PHASES - 1) * TAPS)
    let worst = 0
    for (let k = 1; k < PHASES; k++) {
      const d = k / PHASES
      let sum = 0
      let abs = 0
      for (let j = 0; j < TAPS; j++) {
        const u = d - (j - half + 1)
        const sinc = Math.abs(u) < 1e-12 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)
        const r = u / half
        const w = Math.abs(r) >= 1 ? 0 : besselI0(7 * Math.sqrt(1 - r * r)) / besselI0(7)
        t[(k - 1) * TAPS + j] = sinc * w
        sum += sinc * w
      }
      for (let j = 0; j < TAPS; j++) {
        t[(k - 1) * TAPS + j] /= sum
        abs += Math.abs(t[(k - 1) * TAPS + j])
      }
      worst = Math.max(worst, abs)
    }
    Interpolator.cached = { table: t, gain: worst }

    return Interpolator.cached
  }

  constructor(channels = 2) {
    const { table, gain } = Interpolator.table()
    this.table = table
    this.gain = gain // the largest a point can be relative to the largest nearby sample
    this.hist = Array.from({ length: channels }, () => new Float64Array(64))
    this.pos = new Int32Array(channels)
    this.quiet = new Int32Array(channels).fill(64)
  }

  /** With skipBelow > 0, windows whose samples are all too small to reach it return 0 without interpolating. */
  next(ch, x, skipBelow = 0) {
    const h = this.hist[ch]
    const p = this.pos[ch]
    h[p] = x
    h[p + 32] = x
    this.pos[ch] = p === 31 ? 0 : p + 1
    if (skipBelow > 0) {
      this.quiet[ch] = Math.abs(x) * this.gain < skipBelow ? this.quiet[ch] + 1 : 0
      if (this.quiet[ch] >= 32) return 0
    }
    // Window oldest → newest: h[p + 1 .. p + 32].
    const base = p + 1
    const t = this.table
    let best = 0
    for (let k = 0; k < t.length; k += 32) {
      let y = 0
      for (let j = 0; j < 32; j++) y += t[k + j] * h[base + j]
      const a = y < 0 ? -y : y
      if (a > best) best = a
    }

    return best
  }
}

/** Sample peak and true peak (linear) of whole channels. */
export function peaks(chans) {
  const tp = new TruePeak(chans.length)
  let sample = 0
  let truePeak = 0
  chans.forEach((data, c) => {
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i])
      if (a > sample) sample = a
      const t = tp.next(c, data[i])
      if (t > truePeak) truePeak = t
    }
    for (let i = 0; i < 12; i++) {
      const t = tp.next(c, 0)
      if (t > truePeak) truePeak = t
    }
  })

  return { sample, truePeak: Math.max(sample, truePeak) }
}

/** Integrated loudness, LRA, momentary and short-term maxima, and peaks of whole channels. */
export function measure(chans, fs) {
  const m = new LoudnessMeter(fs, chans.length)
  const block = Math.round(fs / 10)
  let maxM = -Infinity
  let maxS = -Infinity
  for (let i = 0; i < chans[0].length; i += block) {
    const n = Math.min(block, chans[0].length - i)
    m.push(chans.map(c => c.subarray(i, i + n)), n)
    maxM = Math.max(maxM, m.momentary())
    maxS = Math.max(maxS, m.shortTerm())
  }
  const pk = peaks(chans)

  return { integrated: m.integrated(), lra: m.lra(), momentaryMax: maxM, shortTermMax: maxS, samplePeak: linToDb(pk.sample), truePeak: linToDb(pk.truePeak) }
}

// ---------------------------------------------------------------- dynamics

const coef = (ms, fs) => (ms > 0 ? Math.exp(-1 / ((ms / 1000) * fs)) : 0)

// The limiter judges sample m once the interpolator has seen 16 samples past it.
const LIMITER_DETECT_DELAY = 16

/** Static gain curve of a soft-knee compressor: gain change (dB, <= 0) for an input level (dB). */
export function compressorGain(x, threshold, ratio, knee) {
  const over = x - threshold
  if (knee > 0 && 2 * Math.abs(over) <= knee) return ((1 / ratio - 1) * (over + knee / 2) ** 2) / (2 * knee)
  if (over > 0) return over / ratio - over

  return 0
}

/** Feed-forward, stereo-linked compressor with a peak detector smoothed in the log domain. */
export class Compressor {
  constructor(fs, params = {}) {
    this.fs = fs
    this.gr = 0 // smoothed gain change, dB (<= 0)
    this.set(params)
  }

  set(p) {
    this.threshold = p.threshold ?? -18
    this.ratio = Math.max(1, p.ratio ?? 3)
    this.knee = Math.max(0, p.knee ?? 6)
    this.makeup = p.makeup ?? 0
    this.aA = coef(p.attack ?? 10, this.fs)
    this.aR = coef(p.release ?? 150, this.fs)
    this.maxReduction = p.range !== undefined ? -Math.abs(p.range) : -Infinity
  }

  /** Gain (linear) for a detector level (linear). */
  step(level) {
    let target = compressorGain(20 * Math.log10(level + 1e-12), this.threshold, this.ratio, this.knee)
    if (target < this.maxReduction) target = this.maxReduction
    const a = target < this.gr ? this.aA : this.aR
    this.gr = a * this.gr + (1 - a) * target

    return 10 ** ((this.gr + this.makeup) / 20)
  }

  process(L, R, n) {
    for (let i = 0; i < n; i++) {
      const g = this.step(Math.max(Math.abs(L[i]), Math.abs(R[i])))
      L[i] *= g
      R[i] *= g
    }
  }

  get latency() {
    return 0
  }
}

/** Broadband de-esser: a compressor keyed by the 4–9 kHz band (high-pass then low-pass sidechain). */
export class DeEsser {
  constructor(fs, params = {}) {
    this.fs = fs
    this.comp = new Compressor(fs)
    this.set(params)
  }

  set(p) {
    this.comp.set({ threshold: p.threshold ?? -30, ratio: p.ratio ?? 4, knee: 2, attack: p.attack ?? 1, release: p.release ?? 60, makeup: 0, range: p.range ?? 12 })
    const lo = p.lo ?? 4000
    const hi = Math.max(lo * 1.2, p.hi ?? 9000)
    const make = () => [new Biquad(biquadCoefs('highpass', this.fs, lo)), new Biquad(biquadCoefs('lowpass', this.fs, hi))]
    this.side = [make(), make()]
  }

  process(L, R, n) {
    const [sl, sr] = this.side
    for (let i = 0; i < n; i++) {
      const a = sl[1].next(sl[0].next(L[i]))
      const b = sr[1].next(sr[0].next(R[i]))
      const g = this.comp.step(Math.max(Math.abs(a), Math.abs(b)))
      L[i] *= g
      R[i] *= g
    }
  }

  get reduction() {
    return -this.comp.gr
  }

  get latency() {
    return 0
  }
}

/**
 * Noise gate with hysteresis and hold. It opens when the peak envelope reaches the threshold
 * and closes 4 dB below it after the hold time; attack and release are the times to travel the
 * whole range, linear in dB. `range` is the attenuation when closed (dB, negative).
 */
export class Gate {
  constructor(fs, params = {}) {
    this.fs = fs
    this.env = 0
    this.open = false
    this.hold = 0
    this.gdb = 0
    this.envDecay = coef(10, fs)
    this.set(params)
    this.gdb = this.range
  }

  set(p) {
    this.openAt = dbToLin(p.threshold ?? -45)
    this.closeAt = dbToLin((p.threshold ?? -45) - 4)
    this.range = -Math.abs(p.range ?? 60)
    const span = Math.max(1, -this.range)
    this.up = span / Math.max(1, ((p.attack ?? 1) / 1000) * this.fs)
    this.down = span / Math.max(1, ((p.release ?? 150) / 1000) * this.fs)
    this.holdLen = Math.round(((p.hold ?? 50) / 1000) * this.fs)
  }

  process(L, R, n) {
    for (let i = 0; i < n; i++) {
      const lvl = Math.max(Math.abs(L[i]), Math.abs(R[i]))
      this.env = lvl > this.env ? lvl : this.env * this.envDecay
      if (this.env >= this.openAt) {
        this.open = true
        this.hold = this.holdLen
      } else if (this.env < this.closeAt) {
        if (this.hold > 0) this.hold--
        else this.open = false
      }
      const target = this.open ? 0 : this.range
      if (this.gdb < target) this.gdb = Math.min(target, this.gdb + this.up)
      else if (this.gdb > target) this.gdb = Math.max(target, this.gdb - this.down)
      const g = this.gdb <= -120 ? 0 : 10 ** (this.gdb / 20)
      L[i] *= g
      R[i] *= g
    }
  }

  get latency() {
    return 0
  }
}

/**
 * Lookahead brickwall limiter with a true-peak detector. The required gain of each sample
 * (ceiling over the larger of the sample and the 8x-interpolated points on either side) passes
 * through a sliding minimum over the lookahead and a box filter of the same length, so the gain
 * reaches its minimum exactly at the peak; release is a one-pole rise. The audio is delayed by
 * lookahead + 15 samples (latencySamples).
 */
export class Limiter {
  constructor(fs, params = {}) {
    this.fs = fs
    this.set(params)
  }

  set(p) {
    const L = Math.max(1, Math.round(((p.lookahead ?? 5) / 1000) * this.fs))
    this.ceiling = dbToLin(Math.min(0, p.ceiling ?? -1))
    this.aR = coef(p.release ?? 60, this.fs)
    if (L === this.L) return
    this.L = L
    this.D = L + LIMITER_DETECT_DELAY - 1
    this.size = this.D + 24
    this.delay = [new Float64Array(this.size), new Float64Array(this.size)]
    this.tp = new Interpolator(2)
    this.ipPrev = 0
    this.n = 0
    // Sliding-minimum deque over the last L required gains.
    this.dqIdx = new Float64Array(L + 1)
    this.dqVal = new Float64Array(L + 1)
    this.dqHead = 0
    this.dqLen = 0
    this.box = new Float64Array(L).fill(1)
    this.boxSum = L
    this.g = 1
    this.minGain = 1
  }

  get latencySamples() {
    return this.D
  }

  process(Lc, Rc, n) {
    const { L, D, size, delay, ceiling } = this
    const [dl, dr] = delay
    const cap = L + 1
    for (let i = 0; i < n; i++) {
      const idx = this.n
      const w = idx % size
      dl[w] = Lc[i]
      dr[w] = Rc[i]
      const ip = Math.max(this.tp.next(0, Lc[i], ceiling), this.tp.next(1, Rc[i], ceiling))
      // Peak around sample m = idx - 16: the sample itself and the interpolated points on either side.
      const m = idx - LIMITER_DETECT_DELAY
      const mw = (m + size * 4) % size
      const pk = Math.max(m >= 0 ? Math.max(Math.abs(dl[mw]), Math.abs(dr[mw])) : 0, this.ipPrev, ip)
      this.ipPrev = ip
      const req = pk > ceiling ? ceiling / pk : 1
      // Push onto the monotonic deque, drop entries that left the window [m - L + 1, m].
      while (this.dqLen > 0 && this.dqVal[(this.dqHead + this.dqLen - 1) % cap] >= req) this.dqLen--
      const tail = (this.dqHead + this.dqLen) % cap
      this.dqIdx[tail] = m
      this.dqVal[tail] = req
      this.dqLen++
      while (this.dqIdx[this.dqHead] <= m - L) {
        this.dqHead = (this.dqHead + 1) % cap
        this.dqLen--
      }
      const h = this.dqVal[this.dqHead]
      // Box filter of length L over the windowed minimum.
      const b = idx % L
      this.boxSum += h - this.box[b]
      this.box[b] = h
      const s = Math.min(1, this.boxSum / L)
      this.g = s < this.g ? s : this.g + (s - this.g) * (1 - this.aR)
      if (this.g < this.minGain) this.minGain = this.g
      const r = (idx - D + size * 4) % size
      const out = idx >= D
      Lc[i] = out ? dl[r] * this.g : 0
      Rc[i] = out ? dr[r] * this.g : 0
      this.n++
    }
    // Keep the running sum exact over long runs.
    if (this.n % 65536 < n) this.boxSum = this.box.reduce((a, v) => a + v, 0)
  }

  get reduction() {
    return -linToDb(this.g)
  }

  get latency() {
    return this.D
  }
}

/** Builds the dynamics processor for an effect type, or null. */
export function makeDynamics(type, fs, params) {
  if (type === 'compressor') return new Compressor(fs, params)
  if (type === 'gate') return new Gate(fs, params)
  if (type === 'deesser') return new DeEsser(fs, params)
  if (type === 'limiter') return new Limiter(fs, params)

  return null
}

/** Latency in samples a dynamics type adds at a sample rate. */
export function dynamicsLatency(type, fs, params = {}) {
  return type === 'limiter' ? Math.max(1, Math.round(((params.lookahead ?? 5) / 1000) * fs)) + LIMITER_DETECT_DELAY - 1 : 0
}

// ---------------------------------------------------------------- reverb impulse

/** A small, fast, seeded PRNG (mulberry32): the same seed gives the same impulse everywhere. */
export function rng(seed) {
  let a = seed >>> 0

  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A stereo room impulse: early reflections spread over 4–90 ms by `size` (0–1), then decorrelated
 * noise decaying 60 dB over `decay` seconds and darkening as it fades.
 */
export function reverbImpulse(fs, { size = 0.5, decay = 1.8 } = {}, seed = 1) {
  const d = Math.max(0.1, Math.min(10, decay))
  const sz = Math.max(0, Math.min(1, size))
  const len = Math.max(64, Math.round(fs * Math.min(12, d * 1.1 + 0.05)))
  const out = [new Float32Array(len), new Float32Array(len)]
  const rand = rng(seed)
  const k = Math.log(1000) / d
  const taps = Math.round(6 + sz * 12)
  for (let i = 0; i < taps; i++) {
    for (const ch of out) {
      const t = 0.004 + rand() * (0.012 + 0.08 * sz)
      const at = Math.min(len - 1, Math.round(t * fs))
      ch[at] += (0.7 - (0.5 * i) / taps) * (rand() < 0.5 ? -1 : 1) * Math.exp(-k * t)
    }
  }
  const build = 0.004 + sz * 0.05
  const lp = [0, 0]
  for (let i = 0; i < len; i++) {
    const t = i / fs
    const env = Math.exp(-k * t) * Math.min(1, t / build)
    const a = 1 - Math.min(0.92, (0.15 + 0.85 * (t / d)) * 0.9)
    for (let c = 0; c < 2; c++) {
      lp[c] += a * (rand() * 2 - 1 - lp[c])
      out[c][i] += lp[c] * env * 0.5
    }
  }

  return out
}
