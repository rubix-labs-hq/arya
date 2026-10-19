// Recovery validates known collection and numeric fields without changing original text.
export const RECOVERY_MAX_BYTES = 64 * 1024 * 1024
export function validateRecoveryProject(text) {
  if (typeof text !== 'string' || !text.length) throw new Error('The recovery project is empty.')
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const n = text.charCodeAt(i)
    if (n < 0x80) bytes++
    else if (n < 0x800) bytes += 2
    else if (n >= 0xd800 && n <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++ }
    else bytes += 3
    if (bytes > RECOVERY_MAX_BYTES) throw new Error('The recovery project exceeds 64 MiB.')
  }
  const p = JSON.parse(text)
  const object = value => value && typeof value === 'object' && !Array.isArray(value)
  if (!object(p)) throw new Error('The recovery project must be a JSON object.')
  if (p.version !== undefined && (!Number.isInteger(p.version) || p.version < 1 || p.version > 3)) throw new Error('The recovery format is unsupported.')
  const positive = (value, name) => { if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) throw new Error(`Invalid recovery ${name}.`) }
  for (const key of ['width', 'height', 'fps', 'sampleRate']) positive(p[key], key)
  for (const key of ['assets', 'comps']) if (p[key] !== undefined && !object(p[key])) throw new Error(`Invalid recovery ${key}.`)
  if (Object.keys(p.assets ?? {}).length > 100000 || Object.keys(p.comps ?? {}).length > 10000) throw new Error('The recovery project has too many records.')
  let count = 0
  const tracks = rows => {
    if (rows === undefined) return
    if (!Array.isArray(rows) || rows.length > 10000) throw new Error('Invalid recovery tracks.')
    for (const track of rows) {
      if (!object(track) || (track.clips !== undefined && !Array.isArray(track.clips))) throw new Error('Invalid recovery track.')
      for (const clip of track.clips ?? []) {
        if (!object(clip) || ++count > 100000) throw new Error('Invalid recovery clips.')
        for (const key of ['start', 'in', 'dur']) if (clip[key] !== undefined && (typeof clip[key] !== 'number' || !Number.isFinite(clip[key]) || clip[key] < 0)) throw new Error(`Invalid recovery clip ${key}.`)
      }
    }
  }
  tracks(p.tracks)
  for (const comp of Object.values(p.comps ?? {})) { if (!object(comp)) throw new Error('Invalid recovery composition.'); tracks(comp.tracks) }
  return {bytes, clips: count, format: p.version ?? null}
}
