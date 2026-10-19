export const CLEAN_DEFAULTS = Object.freeze({ strength: 0.75, detail: 0.7, quality: 'balanced' })

export function cleanSettings(input = {}, duration) {
  const settings = { strength: input.strength ?? CLEAN_DEFAULTS.strength, detail: input.detail ?? CLEAN_DEFAULTS.detail, quality: input.quality ?? CLEAN_DEFAULTS.quality }
  for (const key of ['strength', 'detail']) {
    if (typeof settings[key] !== 'number' || !Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 1) throw new Error(`${key} must be a number from zero to one`)
  }
  if (!['fast', 'balanced', 'high'].includes(settings.quality)) throw new Error('quality must be fast, balanced or high')
  if (input.noiseFrom != null || input.noiseTo != null) {
    const { noiseFrom: from, noiseTo: to } = input
    if (![from, to].every(value => typeof value === 'number' && Number.isFinite(value)) || from < 0 || to - from < 0.1 || duration != null && to > duration) throw new Error('Choose at least 0.1 seconds of noise-only audio inside the source')
    settings.noiseFrom = from; settings.noiseTo = to
  }
  return settings
}

// Keep the original source available when another cleanup replaces the rendered copy.
export function cleanSource(clip, assets) {
  const recipe = clip.audioCleanup
  if (recipe?.version !== 1 || recipe.output !== clip.src) return clip.src
  const asset = assets?.[recipe.source]
  if (typeof recipe.source !== 'string' || !recipe.source.trim() || recipe.source === recipe.output || !asset || typeof asset !== 'object' || Array.isArray(asset) || asset.hasAudio !== true) throw new Error('Restore the original audio asset before adjusting this cleanup. The saved cleanup recipe has been retained.')
  return recipe.source
}

export function cleanRecipe(source, output, mode, settings, engine) {
  if (!['voice', 'denoise'].includes(mode)) throw new Error('mode must be denoise or voice')
  return { version: 1, source, output, mode, engine: engine ?? 'unspecified', settings: { ...cleanSettings(settings), noiseFrom: settings.noiseFrom ?? null, noiseTo: settings.noiseTo ?? null } }
}

// Copy only audio fields and their automation when video audio gets its own clip.
export function detachedAudioSettings(clip) {
  const fields = ['speed', 'volume', 'pan', 'eq', 'fx', 'fadeIn', 'fadeOut', 'enabled', 'mute']
  const result = Object.fromEntries(fields.filter(key => clip[key] !== undefined).map(key => [key, structuredClone(clip[key])]))
  for (const kind of ['anim', 'expr']) {
    const values = Object.fromEntries(Object.entries(clip[kind] ?? {}).filter(([key]) => fields.includes(key) || key.startsWith('eq.') || key.startsWith('fx.')))
    if (Object.keys(values).length) result[kind] = structuredClone(values)
  }
  return result
}
