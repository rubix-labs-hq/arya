// Restoration copies an explicitly selected original to its absent project path. It is
// deliberately stricter than substitution: references, JSON and Undo remain unchanged.
export const MEDIA_RESTORE_MAX_BYTES = 64 * 1024 ** 3

function mediaKind(value) {
  return value.still === true || value.kind === 'image' ? 'image' : value.hasVideo === true || value.kind === 'video' ? 'video' : value.hasAudio === true || value.kind === 'audio' ? 'audio' : null
}

export function mediaRestoreSource(project, source) {
  const fail = message => { throw new Error(message) }
  if (typeof source !== 'string' || source.length > 4096 || !source || source.includes('\0') || source.includes('\\') || source.startsWith('/')) fail('Choose a project-relative missing media path.')
  const parts = source.split('/')
  if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || parts[0] === 'renders' || source === 'reel.project.json') fail('This media path is not eligible for original restoration.')
  const assets = project?.assets
  if (!assets || !Object.hasOwn(assets, source) || !assets[source] || typeof assets[source] !== 'object' || Array.isArray(assets[source])) fail('This asset is no longer in the captured project.')
  const kind = mediaKind(assets[source])
  if (!kind) fail('This asset has no recognized media type. Reimport it instead.')
  return { source, kind }
}

export function mediaRestorePlan(project, source, candidate, contentSHA256) {
  const fail = message => { throw new Error(message) }
  const eligibility = mediaRestoreSource(project, source), original = project.assets[source]
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail('The selected original could not be read as media.')
  if (!Number.isSafeInteger(candidate.size) || candidate.size <= 0 || candidate.size > MEDIA_RESTORE_MAX_BYTES) fail('Original restoration supports nonempty media files up to 64 GiB.')
  if (eligibility.kind !== mediaKind(candidate)) fail('The selected file has a different media type. Choose the original file.')
  for (const key of ['size', 'width', 'height', 'channels', 'rotation']) {
    if (original[key] === undefined) continue
    const expected = original[key], actual = candidate[key] ?? (key === 'rotation' ? 0 : undefined)
    if (typeof expected !== 'number' || !Number.isFinite(expected) || typeof actual !== 'number' || actual !== expected) fail(`The selected file has a different ${key}. Choose the original file.`)
  }
  for (const key of ['hasAudio', 'hasVideo', 'still']) {
    if (original[key] !== undefined && (typeof original[key] !== 'boolean' || Boolean(candidate[key]) !== original[key])) fail(`The selected file has different ${key} information. Choose the original file.`)
  }
  for (const key of ['duration', 'fps']) {
    if (original[key] === undefined) continue
    const expected = original[key], actual = candidate[key]
    if (typeof expected !== 'number' || !Number.isFinite(expected) || expected <= 0 || typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(expected - actual) > 0.002) fail(`The selected file has a different ${key}. Choose the original file.`)
  }
  // Codec/pixel-format reports differ by host. Compare only facts both readers supply.
  for (const key of ['codec', 'pixFmt']) if (original[key] != null && candidate[key] != null && original[key] !== candidate[key]) fail(`The selected file has a different ${key}. Choose the original file.`)
  // Ordinary imported files may have only measured facts. When an original byte digest
  // exists, final native admission supplies the staged digest and requires an exact match.
  const recorded = original.generated?.contentSHA256 ?? original.contentSHA256
  if (recorded !== undefined && contentSHA256 !== undefined && (typeof recorded !== 'string' || !/^[0-9a-f]{64}$/.test(recorded) || recorded !== contentSHA256)) fail('The selected file has different bytes from the recorded original.')
  return { source, bytes: candidate.size, kind: eligibility.kind }
}
