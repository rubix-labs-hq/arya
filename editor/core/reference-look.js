/** Trim the outer 2% of each display-RGB channel before measuring its distribution. */
export function referenceStatistics(pixels) {
  if (!(pixels instanceof Uint8Array) || pixels.length !== 64 * 64 * 4) throw new Error('Look sampling needs one 64 by 64 RGBA frame')
  const channels = [[], [], []]
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 13) continue
    for (let channel = 0; channel < 3; channel++) channels[channel].push(pixels[i + channel] / 255)
  }
  if (channels[0].length < 32) throw new Error('The reference image has too few visible pixels')
  const mean = [], deviation = []
  for (const values of channels) {
    values.sort((a, b) => a - b)
    const tail = Math.floor(values.length / 50), trimmed = values.slice(tail, values.length - tail)
    const average = trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length
    mean.push(average)
    deviation.push(Math.sqrt(trimmed.reduce((sum, value) => sum + (value - average) ** 2, 0) / trimmed.length))
  }
  return { mean, deviation, samples: channels[0].length }
}

/** The same bounded global RGB distribution transfer used by the native look generator. */
export function referenceTransfer(source, reference, strength = 0.75) {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Look strength must be between zero and one')
  for (const stats of [source, reference]) {
    if (['mean', 'deviation'].some(key => !Array.isArray(stats?.[key]) || stats[key].length !== 3 || stats[key].some(value => !Number.isFinite(value) || value < 0 || value > 1))) throw new Error('Invalid reference statistics')
  }
  const ratio = source.deviation.map((value, i) => Math.max(0.25, Math.min(4, reference.deviation[i] / Math.max(0.04, value))))
  return { gain: ratio.map(value => 1 + (value - 1) * strength), offset: ratio.map((value, i) => (reference.mean[i] - source.mean[i] * value) * strength) }
}
