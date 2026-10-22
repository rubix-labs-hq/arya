import { gradeUniforms, LOOK_PRESETS } from './render-grade.js'

const clamp = x => Math.max(0, Math.min(1, x))
const luma = c => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t) }
function curve(input) {
  if (input == null) return x => x
  if (!Array.isArray(input) || input.length < 2 || input.length > 256 || input.some(p => !Array.isArray(p) || p.length !== 2 || p.some(x => !Number.isFinite(x) || x < 0 || x > 1))) throw new Error('Curves need at least two finite points between zero and one')
  const points = input.map(p => [...p]).sort((a, b) => a[0] - b[0])
  if (points.some((p, i) => i > 0 && p[0] <= points[i - 1][0])) throw new Error('Curve input positions must be distinct')
  if (points[0][0] > 0) points.unshift([0, 0])
  if (points.at(-1)[0] < 1) points.push([1, 1])
  const slopes = points.slice(1).map((p, i) => (p[1] - points[i][1]) / (p[0] - points[i][0]))
  const tangents = [slopes[0], ...slopes.slice(1).map((s, i) => s * slopes[i] <= 0 ? 0 : (s + slopes[i]) / 2), slopes.at(-1)]
  return x => {
    if (x <= points[0][0]) return points[0][1]
    if (x >= points.at(-1)[0]) return points.at(-1)[1]
    let i = 0
    while (x > points[i + 1][0]) i++
    const h = points[i + 1][0] - points[i][0], t = (x - points[i][0]) / h
    return clamp((2 * t ** 3 - 3 * t ** 2 + 1) * points[i][1] + (t ** 3 - 2 * t ** 2 + t) * h * tangents[i] + (-2 * t ** 3 + 3 * t ** 2) * points[i + 1][1] + (t ** 3 - t ** 2) * h * tangents[i + 1])
  }
}

/** A reusable color transform. Spatial effects and existing LUTs cannot be baked into it. */
export function lookTransform(grade = {}, transfer = {}) {
  if (!grade || typeof grade !== 'object' || Array.isArray(grade)) throw new Error('Grade controls must be an object')
  if (!transfer || typeof transfer !== 'object' || Array.isArray(transfer)) throw new Error('Reference transfer must be an object')
  if (grade.look != null && typeof grade.look !== 'string') throw new Error('Look preset must be a name')
  if (grade.look && !Object.hasOwn(LOOK_PRESETS, grade.look)) throw new Error('Choose a known look preset or provide grade controls')
  const allowed = new Set(['look', 'exposure', 'brightness', 'contrast', 'pivot', 'saturation', 'hue', 'temperature', 'tint', 'lift', 'gamma', 'gammaV1', 'gain', 'offset', 'shadowTint', 'highlightTint', 'curves'])
  const vectors = new Set(['lift', 'gamma', 'gain', 'offset', 'shadowTint', 'highlightTint'])
  for (const [key, value] of Object.entries(grade)) {
    if (!allowed.has(key)) throw new Error(`Cannot bake ${key} into a color LUT`)
    if (key === 'look' || key === 'curves') continue
    if (Array.isArray(value) && (!vectors.has(key) || value.length !== 3)) throw new Error(`Grade ${key} needs ${vectors.has(key) ? 'a number or three RGB numbers' : 'one number'}`)
    const numbers = Array.isArray(value) ? [...value] : [value]
    if (numbers.some(x => !Number.isFinite(x) || Math.abs(x) > 10000)) throw new Error(`Invalid grade ${key}`)
  }
  if (grade.curves != null && (typeof grade.curves !== 'object' || Array.isArray(grade.curves) || Object.keys(grade.curves).some(key => !['master', 'r', 'g', 'b'].includes(key)))) throw new Error('Curves must use master, r, g or b channels')
  const u = gradeUniforms(grade)
  if (u && Object.values(u).flat().some(x => typeof x === 'number' && !Number.isFinite(x))) throw new Error('The grade has invalid values')
  const gains = transfer.gain ?? [1, 1, 1], offsets = transfer.offset ?? [0, 0, 0]
  if ([gains, offsets].some(v => !Array.isArray(v) || v.length !== 3 || v.some(x => !Number.isFinite(x) || Math.abs(x) > 16))) throw new Error('Invalid reference color transfer')
  const master = curve(u?.curves?.master), channels = ['r', 'g', 'b'].map(c => curve(u?.curves?.[c]))
  return input => {
    let c = input.map((x, i) => x * gains[i] + offsets[i])
    if (u) {
      const balance = [1 + 0.25 * u.temperature + 0.08 * u.tint, 1 - 0.18 * u.tint, 1 - 0.25 * u.temperature + 0.08 * u.tint]
      c = c.map((x, i) => {
        x = x * 2 ** u.exposure * balance[i] + u.offset[i]
        x = (x * (1 - u.lift[i]) + u.lift[i]) * (1 + u.gain[i])
        x = Math.max(0, x) ** (1 / Math.max(0.05, 1 + u.gamma[i]))
        return (x - u.pivot) * u.contrast + u.pivot
      })
      const y = luma(c)
      c = c.map(x => y + (x - y) * u.saturation)
      if (u.hue) {
        const yiq = [0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2], 0.596 * c[0] - 0.274 * c[1] - 0.322 * c[2], 0.211 * c[0] - 0.523 * c[1] + 0.312 * c[2]]
        const angle = u.hue * Math.PI / 180, cs = Math.cos(angle), sn = Math.sin(angle)
        const i = cs * yiq[1] - sn * yiq[2], q = sn * yiq[1] + cs * yiq[2]
        c = [yiq[0] + 0.956 * i + 0.621 * q, yiq[0] - 0.272 * i - 0.647 * q, yiq[0] - 1.106 * i + 1.703 * q]
      }
      const yy = clamp(luma(c)), shadows = 1 - smooth(0, 0.55, yy), highlights = smooth(0.45, 1, yy)
      c = c.map((x, i) => channels[i](master(clamp(x + u.shadowTint[i] * shadows + u.highlightTint[i] * highlights))))
    }
    if (c.some(x => !Number.isFinite(x))) throw new Error('The grade produced nonfinite LUT colors. Reduce its controls')
    return c.map(clamp)
  }
}

export function lookLUT(options = {}) {
  const size = options.size ?? 33
  if (![17, 33, 65].includes(size)) throw new Error('LUT size must be 17, 33 or 65')
  const transform = lookTransform(options.grade, options.transfer)
  const title = String(options.name ?? 'Arya look').replace(/["\r\n\0]/g, '').slice(0, 100)
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1']
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) lines.push(transform([r / (size - 1), g / (size - 1), b / (size - 1)]).map(x => x.toFixed(7)).join(' '))
  return { text: lines.join('\n') + '\n', size, colorSpace: 'srgb', grade: options.grade ?? {}, transfer: options.transfer ?? {} }
}
