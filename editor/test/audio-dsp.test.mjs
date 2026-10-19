// node --test editor/test
// The pure DSP behind Reel's audio worklets: K-weighting, loudness gating, true peak, dynamics,
// and the effect catalog.
import assert from 'node:assert/strict'
import test from 'node:test'

import { Compressor, compressorGain, DeEsser, dynamicsLatency, Gate, Interpolator, kWeighting, Limiter, LoudnessMeter, measure, peaks, reverbImpulse, TruePeak } from '../web/engine/audio-worklets/dsp.js'
import { activeFx, chainLatency, eqBands, FX_TYPES, fxParams, legacyEqBands, loudnessGain, masterChain, newFx, PRESETS } from '../web/engine/audio-worklets/fx.js'

const FS = 48000
const db = v => 20 * Math.log10(v)
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`)

function sine(freq, amp, seconds, phase = 0, fs = FS) {
  const out = new Float32Array(Math.round(seconds * fs))
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs + phase)

  return out
}

const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }

  return out
}

/** Deterministic white noise. */
function noise(amp, seconds, seed = 1) {
  let s = seed
  const out = new Float32Array(Math.round(seconds * FS))
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = amp * (s / 2 ** 32 - 0.5) * 2
  }

  return out
}

const rms = (a, from = 0, to = a.length) => {
  const [f, t] = [Math.round(from), Math.round(to)]
  let s = 0
  for (let i = f; i < t; i++) s += a[i] * a[i]

  return Math.sqrt(s / (t - f))
}

const peak = (a, from = 0, to = a.length) => {
  let m = 0
  for (let i = Math.round(from); i < Math.round(to); i++) m = Math.max(m, Math.abs(a[i]))

  return m
}

/** Runs a stereo processor over copies of a mono signal (both sides equal); returns the left side. */
function run(proc, x) {
  const L = Float32Array.from(x)
  const R = Float32Array.from(x)
  for (let i = 0; i < L.length; i += 128) proc.process(L.subarray(i, i + 128), R.subarray(i, i + 128), Math.min(128, L.length - i))

  return L
}

test('K-weighting reproduces the BS.1770-4 coefficients at 48 kHz', () => {
  const [shelf, hp] = kWeighting(48000)
  const want = [
    [shelf, { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 }],
    [hp, { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 }],
  ]
  for (const [got, exp] of want) for (const k of Object.keys(exp)) near(got[k], exp[k], 1e-10, k)
})

test('loudness: a 997 Hz sine at -20 dBFS on both channels reads -20 LUFS; on one channel at 0 dBFS, -3.01', () => {
  const x = sine(997, 0.1, 5)
  const m = measure([x, x], FS)
  near(m.integrated, -20, 0.05, 'integrated')
  near(m.momentaryMax, -20, 0.05, 'momentary')
  near(m.shortTermMax, -20, 0.05, 'short-term')
  const one = measure([sine(997, 1, 5), new Float32Array(5 * FS)], FS)
  near(one.integrated, -3.01, 0.05, 'mono in stereo')
})

test('loudness gating: silence and material 20 LU down do not pull the integrated value', () => {
  const tone = sine(997, 0.1, 5)
  // Ungated, half silence would read -23.0 and the quiet half -22.96. Blocks straddling the
  // change still count (they pass both gates), so the result sits a little under -20.
  const withSilence = concat(tone, new Float32Array(5 * FS))
  near(measure([withSilence, withSilence], FS).integrated, -20, 0.2, 'absolute gate')
  const quiet = concat(tone, sine(997, 0.01, 5))
  near(measure([quiet, quiet], FS).integrated, -20, 0.2, 'relative gate')
})

test('loudness meter: momentary follows the last 400 ms, short-term the last 3 s, reset clears', () => {
  const m = new LoudnessMeter(FS, 2)
  const loud = sine(997, 0.1, 4)
  const soft = sine(997, 0.01, 1)
  m.push([loud, loud])
  m.push([soft, soft])
  near(m.momentary(), -40, 0.1, 'momentary')
  assert.ok(m.shortTerm() > -30 && m.shortTerm() < -20, `short-term ${m.shortTerm()}`)
  m.reset()
  assert.equal(m.integrated(), -Infinity)
})

test('true peak: a quarter-rate sine at 45 degrees reads 0 dBTP while its samples peak at -3 dB', () => {
  const x = sine(12000, 1, 0.5, Math.PI / 4)
  const p = peaks([x])
  near(db(p.sample), -3.01, 0.02, 'sample peak')
  near(db(p.truePeak), 0, 0.2, 'true peak')
  const tp = new TruePeak(1)
  let best = 0
  for (const v of sine(1000, 0.5, 0.1)) best = Math.max(best, tp.next(0, v))
  near(db(best), db(0.5), 0.05, 'low frequency true peak equals the amplitude')
})

test('the limiter interpolator reconstructs inter-sample peaks', () => {
  // Steady state only: an abrupt start really does overshoot (Gibbs), which the limiter must see.
  const ip = new Interpolator(1)
  let best = 0
  sine(12000, 0.8, 0.2, Math.PI / 4).forEach((v, i) => {
    const y = ip.next(0, v)
    if (i > 64) best = Math.max(best, y)
  })
  near(db(best), db(0.8), 0.02)
})

test('compressor: the static curve and soft knee', () => {
  assert.equal(compressorGain(-30, -20, 4, 0), 0)
  near(compressorGain(-8, -20, 4, 0), -9, 1e-9, 'hard knee above threshold')
  // The soft knee joins both lines continuously.
  near(compressorGain(-23, -20, 4, 6), 0, 1e-9, 'knee start')
  near(compressorGain(-17, -20, 4, 6), compressorGain(-17 + 1e-9, -20, 4, 0), 1e-6, 'knee end')
  // A steady tone settles at threshold + (level - threshold) / ratio + makeup.
  const out = run(new Compressor(FS, { threshold: -20, ratio: 4, knee: 0, attack: 1, release: 50, makeup: 2 }), sine(1000, 0.5, 1))
  near(db(peak(out, FS / 2)), -20 + 14 / 4 + 2, 0.5, 'settled level')
})

test('compressor narrows the gap between loud and quiet passages', () => {
  const x = concat(sine(300, 0.5, 1), sine(300, 0.05, 1))
  const out = run(new Compressor(FS, { threshold: -30, ratio: 4, knee: 0, attack: 5, release: 80 }), x)
  const before = db(rms(x, 0.3 * FS, FS)) - db(rms(x, 1.3 * FS, 2 * FS))
  const after = db(rms(out, 0.3 * FS, FS)) - db(rms(out, 1.3 * FS, 2 * FS))
  near(before, 20, 0.1)
  assert.ok(after < 8, `spread after compression ${after}`)
})

test('gate: attenuates noise between bursts by its range and passes the bursts', () => {
  const burst = sine(200, 0.3, 0.5)
  const floor = noise(0.002, 0.5)
  const x = concat(burst, floor, burst, floor)
  const out = run(new Gate(FS, { threshold: -40, attack: 1, hold: 20, release: 50, range: -60 }), x)
  const gapIn = db(rms(x, 0.7 * FS, FS))
  const gapOut = db(rms(out, 0.7 * FS, FS))
  assert.ok(gapIn - gapOut > 50, `gap attenuation ${gapIn - gapOut} dB`)
  near(db(rms(out, 1.1 * FS, 1.5 * FS)), db(rms(x, 1.1 * FS, 1.5 * FS)), 0.2, 'open gate passes the burst')
})

test('de-esser: cuts 4–9 kHz bursts and leaves a low tone alone', () => {
  const hiss = noise(0.5, 0.4, 3).map((v, i) => v * Math.sin((2 * Math.PI * 6500 * i) / FS))
  const tone = sine(300, 0.2, 0.6)
  const x = concat(hiss, tone)
  const out = run(new DeEsser(FS, { threshold: -30, ratio: 6, range: 12 }), x)
  const cut = db(rms(x, 0.05 * FS, 0.35 * FS)) - db(rms(out, 0.05 * FS, 0.35 * FS))
  assert.ok(cut > 6, `sibilance cut ${cut} dB`)
  near(db(rms(out, 0.6 * FS, FS)), db(rms(x, 0.6 * FS, FS)), 0.3, 'tone untouched')
})

test('limiter: holds the true-peak ceiling and delays audio by exactly its latency', () => {
  // A dense, hot signal: three sines and a 9 kHz component, peaking well above 0 dBFS.
  const n = FS
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = 0.9 * Math.sin(i * 0.013) + 0.6 * Math.sin(i * 0.071 + 1) + 0.5 * Math.sin((2 * Math.PI * 9000 * i) / FS)
  const lim = new Limiter(FS, { ceiling: -1, release: 50, lookahead: 5 })
  const out = run(lim, x)
  const p = peaks([out])
  assert.ok(db(p.truePeak) <= -1 + 0.02, `true peak ${db(p.truePeak)}`)
  assert.ok(db(p.sample) <= -1 + 1e-6, `sample peak ${db(p.sample)}`)
  assert.equal(lim.latencySamples, dynamicsLatency('limiter', FS, { lookahead: 5 }))
  // An impulse comes out latencySamples later, at the ceiling.
  const imp = new Float32Array(4000)
  imp[1000] = 1
  const lim2 = new Limiter(FS, { ceiling: -6, lookahead: 5 })
  const y = run(lim2, imp)
  let at = 0
  for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[at])) at = i
  assert.equal(at, 1000 + lim2.latencySamples)
  near(db(Math.abs(y[at])), -6, 0.01)
})

test('reverb impulse: seeded, decaying and stereo-decorrelated', () => {
  const a = reverbImpulse(FS, { size: 0.5, decay: 1 }, 1)
  const b = reverbImpulse(FS, { size: 0.5, decay: 1 }, 1)
  assert.deepEqual(a[0], b[0])
  assert.notDeepEqual(a[0].slice(0, 2000), a[1].slice(0, 2000))
  const early = rms(a[0], 0, 0.1 * FS)
  const late = rms(a[0], 0.9 * FS, FS)
  assert.ok(db(early) - db(late) > 40, `decay ${db(early) - db(late)} dB over 0.8 s`)
})

test('effect catalog: defaults, sanitizing, bands and chain latency', () => {
  const c = newFx('compressor', { ratio: 6 })
  assert.equal(c.enabled, true)
  assert.equal(c.params.ratio, 6)
  assert.equal(c.params.threshold, FX_TYPES.compressor.params.threshold.default)
  assert.deepEqual(fxParams({ type: 'gain', params: { gain: 'loud' } }), { gain: 0 })
  assert.deepEqual(fxParams({ type: 'nope' }), {})
  assert.throws(() => newFx('flanger'))
  const bands = eqBands({ type: 'eq', params: { bands: Array.from({ length: 9 }, (_, i) => ({ type: i ? 'peaking' : 'bogus', freq: 99999, gain: 3 })) } })
  assert.equal(bands.length, 6)
  assert.equal(bands[0].type, 'peaking')
  assert.equal(bands[0].freq, 22000)
  assert.deepEqual(legacyEqBands({ low: 0, mid: 0, high: 0 }), [])
  assert.deepEqual(legacyEqBands({ low: -6 }).map(b => [b.type, b.freq, b.gain]), [['lowshelf', 220, -6], ['peaking', 1400, 0], ['highshelf', 5200, 0]])
  const chain = [newFx('gain'), { ...newFx('limiter'), enabled: false }, { type: 'mystery' }, newFx('limiter', { lookahead: 5 })]
  assert.deepEqual(activeFx(chain).map(a => a.index), [0, 3])
  near(chainLatency(chain, FS), (240 + 15) / FS, 1e-12)
  assert.equal(masterChain({ limiter: { enabled: false } }).limiter, null)
  assert.equal(masterChain({ limiter: { ceiling: -2 } }).limiter.params.ceiling, -2)
  assert.equal(loudnessGain(-18, -14, 1), 5)
  assert.equal(loudnessGain(-Infinity, -14, 1), 1)
})

test('presets build valid chains and master settings', () => {
  for (const [id, preset] of Object.entries(PRESETS)) {
    if (preset.scope === 'chain') {
      const fx = preset.fx()
      assert.ok(fx.length > 0, id)
      for (const f of fx) assert.ok(FX_TYPES[f.type], `${id}: ${f.type}`)
    } else {
      const m = preset.master()
      assert.equal(m.target, preset.target)
      assert.equal(m.limiter.enabled, true)
    }
  }
})
