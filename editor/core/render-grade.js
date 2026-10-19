// Turns a clip's grade object (plus its look preset) into shader uniforms.

export const LOOK_PRESETS = {
  none: {},
  mono: { saturation: 0 },
  warm: { temperature: 0.35, saturation: 1.08 },
  cool: { temperature: -0.4, tint: 0.05 },
  punch: { contrast: 1.18, saturation: 1.32 },
  film: { contrast: 0.92, lift: [0.035, 0.03, 0.045], saturation: 0.86, highlightTint: [0.03, 0.015, -0.02], curves: { master: [[0, 0.03], [0.25, 0.22], [0.75, 0.8], [1, 0.97]] } },
  fade: { lift: [0.12, 0.12, 0.12], gain: [-0.06, -0.06, -0.06], saturation: 0.8 },
  'teal-orange': { shadowTint: [-0.05, 0.03, 0.07], highlightTint: [0.08, 0.03, -0.06], saturation: 1.12, contrast: 1.08 },
  bleach: { saturation: 0.42, contrast: 1.3, gamma: [-0.05, -0.05, -0.05] },
  noir: { saturation: 0, contrast: 1.45, pivot: 0.42 },
}

const v3 = (x, fallback = 0) => (Array.isArray(x) ? [x[0] ?? fallback, x[1] ?? fallback, x[2] ?? fallback] : typeof x === 'number' ? [x, x, x] : [fallback, fallback, fallback])
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

/** Returns uniforms, or null when the grade changes nothing. */
export function gradeUniforms(grade) {
  if (!grade) return null
  const look = LOOK_PRESETS[grade.look ?? 'none'] ?? {}
  const g = { ...look, ...grade }
  const u = {
    exposure: (g.exposure ?? 0) + (g.brightness !== undefined ? Math.log2(1 + g.brightness) : 0),
    contrast: (look.contrast ?? 1) * (grade.contrast ?? 1),
    pivot: g.pivot ?? 0.435,
    saturation: (look.saturation ?? 1) * (grade.saturation ?? 1),
    hue: g.hue ?? 0,
    temperature: (look.temperature ?? 0) + (typeof grade.temperature === 'number' && Math.abs(grade.temperature) <= 1 ? grade.temperature : 0),
    tint: (look.tint ?? 0) + (grade.tint ?? 0),
    lift: add3(v3(look.lift), v3(grade.lift)),
    gamma: add3(add3(v3(look.gamma), v3(grade.gamma)), grade.gammaV1 ? v3(grade.gammaV1 - 1) : [0, 0, 0]),
    gain: add3(v3(look.gain), v3(grade.gain)),
    offset: add3(v3(look.offset), v3(grade.offset)),
    shadowTint: add3(v3(look.shadowTint), v3(grade.shadowTint)),
    highlightTint: add3(v3(look.highlightTint), v3(grade.highlightTint)),
    curves: grade.curves ?? look.curves ?? null,
    lut: grade.lut ?? null,
    lutMix: grade.lutMix ?? 1,
    lutSpace: grade.lutSpace ?? 'srgb',
  }
  // v1 projects stored temperature in Kelvin; map 2000K..10000K onto -1..1 (6500K neutral).
  if (typeof grade.temperature === 'number' && Math.abs(grade.temperature) > 1) u.temperature += Math.max(-1, Math.min(1, (6500 - grade.temperature) / 4000))
  if (grade.gamma !== undefined && typeof grade.gamma === 'number' && !Array.isArray(grade.gamma)) {
    // v1 gamma is the eq filter's (1 = neutral)
    u.gamma = add3(v3(look.gamma), v3(grade.gamma - 1))
  }
  const neutral =
    u.exposure === 0 && u.contrast === 1 && u.saturation === 1 && u.hue === 0 && u.temperature === 0 && u.tint === 0 &&
    [u.lift, u.gamma, u.gain, u.offset, u.shadowTint, u.highlightTint].every(a => a.every(x => x === 0)) && !u.curves && !u.lut

  return neutral ? null : u
}

