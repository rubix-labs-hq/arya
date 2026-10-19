// The audio effect catalog: types, parameters with ranges and defaults, presets, and the pure
// helpers the engine, the UI and the tests share. An effect in a project is
// { type, enabled, params }; missing params take their defaults.

const dynamicsLatency = (type, fs, params = {}) => type === 'limiter' ? Math.max(1, Math.round(((params.lookahead ?? 5) / 1000) * fs)) + 15 : 0

export const EQ_BAND_TYPES = ['lowshelf', 'peaking', 'highshelf', 'lowpass', 'highpass', 'notch']
export const MAX_EQ_BANDS = 6

const P = (label, min, max, step, unit, def) => ({ label, min, max, step, unit, default: def })

export const FX_TYPES = {
  eq: { label: 'Parametric EQ', params: {} },
  compressor: {
    label: 'Compressor',
    params: {
      threshold: P('Threshold', -60, 0, 0.5, 'dB', -18),
      ratio: P('Ratio', 1, 20, 0.1, ':1', 3),
      attack: P('Attack', 0.1, 200, 0.5, 'ms', 10),
      release: P('Release', 5, 2000, 5, 'ms', 150),
      knee: P('Knee', 0, 24, 0.5, 'dB', 6),
      makeup: P('Makeup', -12, 24, 0.5, 'dB', 0),
    },
  },
  gate: {
    label: 'Noise gate',
    params: {
      threshold: P('Threshold', -90, 0, 0.5, 'dB', -45),
      attack: P('Attack', 0.1, 100, 0.1, 'ms', 1),
      hold: P('Hold', 0, 1000, 5, 'ms', 50),
      release: P('Release', 5, 3000, 5, 'ms', 150),
      range: P('Range', -90, 0, 1, 'dB', -60),
    },
  },
  deesser: {
    label: 'De-esser',
    params: {
      threshold: P('Threshold', -60, 0, 0.5, 'dB', -30),
      ratio: P('Ratio', 1, 20, 0.1, ':1', 4),
      range: P('Max cut', 0, 24, 0.5, 'dB', 12),
      lo: P('Band low', 2000, 12000, 100, 'Hz', 4000),
      hi: P('Band high', 3000, 16000, 100, 'Hz', 9000),
      attack: P('Attack', 0.1, 20, 0.1, 'ms', 1),
      release: P('Release', 5, 500, 5, 'ms', 60),
    },
  },
  limiter: {
    label: 'Limiter',
    params: {
      ceiling: P('Ceiling', -24, 0, 0.1, 'dBTP', -1),
      release: P('Release', 1, 1000, 1, 'ms', 60),
      lookahead: P('Lookahead', 1, 20, 0.5, 'ms', 5),
    },
  },
  reverb: {
    label: 'Reverb',
    params: {
      size: P('Size', 0, 1, 0.01, '', 0.5),
      decay: P('Decay', 0.1, 10, 0.05, 's', 1.8),
      predelay: P('Pre-delay', 0, 250, 1, 'ms', 20),
      mix: P('Mix', 0, 1, 0.01, '', 0.2),
    },
  },
  delay: {
    label: 'Delay',
    params: {
      time: P('Time', 1, 2000, 1, 'ms', 350),
      feedback: P('Feedback', 0, 0.95, 0.01, '', 0.35),
      mix: P('Mix', 0, 1, 0.01, '', 0.25),
    },
  },
  gain: { label: 'Gain', params: { gain: P('Gain', -48, 24, 0.5, 'dB', 0) } },
}

/** Effect types processed by the dynamics AudioWorklet. */
export const DYNAMICS = new Set(['compressor', 'gate', 'deesser', 'limiter'])

export const BAND_DEFAULTS = { type: 'peaking', freq: 1000, gain: 0, q: 1 }

/** A new effect of a type with default parameters. */
export function newFx(type, params = {}) {
  const spec = FX_TYPES[type]
  if (!spec) throw new Error(`unknown audio effect ${type}`)
  const base = Object.fromEntries(Object.entries(spec.params).map(([k, d]) => [k, d.default]))
  if (type === 'eq') base.bands = []

  return { type, enabled: true, params: { ...base, ...structuredClone(params) } }
}

/** An effect's parameters with defaults filled in and non-numbers replaced by defaults. */
export function fxParams(fx) {
  const spec = FX_TYPES[fx?.type]
  if (!spec) return {}
  const out = {}
  for (const [k, d] of Object.entries(spec.params)) {
    const v = Number(fx.params?.[k])
    out[k] = Number.isFinite(v) && fx.params?.[k] !== null && fx.params?.[k] !== '' ? v : d.default
  }

  return out
}

/** The usable bands of an eq effect: known types, finite numbers, at most six. */
export function eqBands(fx) {
  const list = Array.isArray(fx?.params?.bands) ? fx.params.bands : []

  return list.slice(0, MAX_EQ_BANDS).map(b => {
    const type = EQ_BAND_TYPES.includes(b?.type) ? b.type : 'peaking'
    const num = (v, d) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : d)

    return { type, freq: Math.max(10, Math.min(22000, num(b?.freq, 1000))), gain: num(b?.gain, 0), q: Math.max(0.05, Math.min(30, num(b?.q, type === 'lowpass' || type === 'highpass' ? Math.SQRT1_2 : 1))) }
  })
}

/** The clip's legacy three-band eq { low, mid, high } as fixed bands (220 Hz shelf, 1.4 kHz bell, 5.2 kHz shelf). */
export function legacyEqBands(eq) {
  if (!eq || !(eq.low || eq.mid || eq.high)) return []

  return [
    { type: 'lowshelf', freq: 220, gain: eq.low ?? 0, q: Math.SQRT1_2 },
    { type: 'peaking', freq: 1400, gain: eq.mid ?? 0, q: 0.8 },
    { type: 'highshelf', freq: 5200, gain: eq.high ?? 0, q: Math.SQRT1_2 },
  ]
}

/** The effects of a chain that process audio, in order: known types, not bypassed. */
export function activeFx(list) {
  return (Array.isArray(list) ? list : []).map((fx, index) => ({ fx, index })).filter(({ fx }) => fx && FX_TYPES[fx.type] && fx.enabled !== false)
}

/** Latency (seconds) an effect adds; only the limiter's lookahead delays audio. */
export function fxLatency(fx, fs) {
  return DYNAMICS.has(fx.type) ? dynamicsLatency(fx.type, fs, fxParams(fx)) / fs : 0
}

export function chainLatency(list, fs) {
  return activeFx(list).reduce((sum, { fx }) => sum + fxLatency(fx, fs), 0)
}

/** The master limiter as an effect, or null when it is off. */
export function masterLimiter(master) {
  const l = master?.limiter
  if (!l || l.enabled === false) return null

  return { type: 'limiter', enabled: true, params: { ceiling: l.ceiling ?? -1, release: l.release ?? 60, lookahead: l.lookahead ?? 5 } }
}

/** The master chain in processing order: master effects, then the limiter. Volume sits between them. */
export function masterChain(master) {
  return { fx: Array.isArray(master?.fx) ? master.fx : [], volume: Number(master?.volume) || 0, limiter: masterLimiter(master) }
}

// ---------------------------------------------------------------- presets

const band = (type, freq, gain = 0, q) => ({ type, freq, gain, q: q ?? (type === 'lowpass' || type === 'highpass' ? 0.71 : 1) })

/**
 * Chains for clips and tracks, and loudness targets for the master. A master preset sets the
 * master effects and limiter; the editor then matches the mix to `target` LUFS with master volume.
 */
export const PRESETS = {
  dialogue: {
    label: 'Dialogue',
    scope: 'chain',
    fx: () => [
      newFx('eq', { bands: [band('highpass', 80), band('peaking', 250, -2, 1), band('peaking', 3000, 2.5, 0.9), band('highshelf', 10000, 1.5)] }),
      newFx('deesser', { threshold: -28, ratio: 4, range: 8 }),
      newFx('compressor', { threshold: -20, ratio: 3, attack: 8, release: 120, knee: 6, makeup: 3 }),
    ],
  },
  podcast: {
    label: 'Podcast',
    scope: 'chain',
    fx: () => [
      newFx('gate', { threshold: -50, attack: 2, hold: 80, release: 200, range: -18 }),
      newFx('eq', { bands: [band('highpass', 70), band('peaking', 200, -2.5, 1), band('peaking', 3500, 3, 1), band('highshelf', 9000, 2)] }),
      newFx('compressor', { threshold: -24, ratio: 4, attack: 5, release: 150, knee: 6, makeup: 6 }),
      newFx('deesser', { threshold: -30, ratio: 5, range: 10 }),
      newFx('limiter', { ceiling: -1, release: 60, lookahead: 5 }),
    ],
  },
  musicBed: {
    label: 'Music bed',
    scope: 'chain',
    fx: () => [
      newFx('eq', { bands: [band('highpass', 35), band('peaking', 2500, -3, 0.8), band('highshelf', 12000, 1)] }),
      newFx('compressor', { threshold: -26, ratio: 2, attack: 30, release: 300, knee: 8, makeup: 2 }),
      newFx('gain', { gain: -8 }),
    ],
  },
  broadcast: {
    label: 'Broadcast −23 LUFS',
    scope: 'master',
    target: -23,
    master: () => ({ fx: [newFx('compressor', { threshold: -18, ratio: 2, attack: 20, release: 250, knee: 8, makeup: 0 })], limiter: { enabled: true, ceiling: -1, release: 80 }, target: -23 }),
  },
  social: {
    label: 'Social −14 LUFS',
    scope: 'master',
    target: -14,
    master: () => ({ fx: [newFx('compressor', { threshold: -20, ratio: 2.5, attack: 15, release: 200, knee: 8, makeup: 0 })], limiter: { enabled: true, ceiling: -1, release: 60 }, target: -14 }),
  },
}

/** Master volume (dB) that moves a measured mix to a loudness target, keeping the change sane. */
export function loudnessGain(measured, target, current = 0) {
  if (!Number.isFinite(measured)) return current

  return Math.round(Math.max(-40, Math.min(40, current + (target - measured))) * 10) / 10
}
