// Audio roles for mixing decisions: which clips are dialogue and which are music, and the volume
// keys that duck music under the moments people actually speak.

export const AUDIO_ROLES = ['dialogue', 'music', 'effects']

const MUSIC_NAME = /music|score|song/i
const DIALOGUE_NAME = /dialog|voice|\bvo\b|interview|speech/i

/**
 * A clip's role and whether someone stated it. An explicit `role` on the clip or its track wins,
 * then the track name (a track named Music, Score or Dialogue). Otherwise picture sound (video,
 * multicam, compositions, linked audio, cleaned dialogue) is dialogue and an audio-only file is
 * music.
 */
export function audioRole(p, clip, track) {
  if (AUDIO_ROLES.includes(clip?.role)) return { role: clip.role, stated: true }
  if (AUDIO_ROLES.includes(track?.role)) return { role: track.role, stated: true }
  const name = String(track?.name ?? '')
  if (MUSIC_NAME.test(name)) return { role: 'music', stated: true }
  if (DIALOGUE_NAME.test(name)) return { role: 'dialogue', stated: true }
  if (clip.kind !== 'audio' || clip.link || clip.audioCleanup) return { role: 'dialogue', stated: false }
  const asset = p.assets?.[clip.src]
  return { role: asset && asset.hasVideo === false ? 'music' : 'dialogue', stated: false }
}

/**
 * Music and dialogue clips of a timeline view, given which clips sound. When any clip is music by
 * a stated role or track name, every other sounding clip counts as dialogue (a music track was
 * set up on purpose); otherwise audio-only files are taken as music.
 */
export function mixRoles(p, sounds) {
  const all = p.tracks.filter(t => t.kind !== 'caption').flatMap(track => track.clips.filter(c => sounds(p, c)).map(clip => ({ clip, track, ...audioRole(p, clip, track) })))
  const statedMusic = all.some(x => x.role === 'music' && x.stated)
  const music = all.filter(x => x.role === 'music' && (x.stated || !statedMusic))
  const dialogue = all.filter(x => !music.includes(x) && x.role !== 'effects')
  return { music, dialogue }
}

/**
 * Timeline spans where dialogue clips have speech: each clip's span minus the silences found in
 * its source (`silences` maps a source path to [[from, to]] source seconds, or null when unknown,
 * which keeps the whole clip). Spans closer than `merge` seconds join, so music does not pump in
 * short pauses.
 */
export function speechSpans(dialogue, silences = new Map(), merge = 0.6) {
  const spans = []
  for (const { clip } of dialogue) {
    const start = clip.start, end = clip.start + clip.dur, speed = clip.speed ?? 1, from = clip.in ?? 0
    const quiet = (silences.get(clip.src) ?? [])
      .map(([a, b]) => [start + (a - from) / speed, start + (b - from) / speed])
      .map(([a, b]) => [Math.max(start, a), Math.min(end, b)])
      .filter(([a, b]) => b > a)
      .sort((x, y) => x[0] - y[0])
    let cursor = start
    for (const [a, b] of quiet) {
      if (a > cursor) spans.push([cursor, a])
      cursor = Math.max(cursor, b)
    }
    if (end > cursor) spans.push([cursor, end])
  }
  return spans.sort((a, b) => a[0] - b[0]).reduce((acc, s) => {
    const last = acc[acc.length - 1]
    if (last && s[0] <= last[1] + merge) last[1] = Math.max(last[1], s[1])
    else acc.push([...s])
    return acc
  }, [])
}

/** Volume keys that dip each music clip by `amount` dB under the speech spans, with smooth ramps. */
export function duckOps(music, spans, amount = -12) {
  const ops = []
  for (const { clip: c } of music) {
    const end = c.start + c.dur
    const overlaps = spans.filter(([a, b]) => a < end && b > c.start)
    if (!overlaps.length) continue
    const base = c.volume ?? 0
    ops.push({ op: 'clear_keyframes', id: c.id, prop: 'volume' })
    const keys = [[0, overlaps.some(([a]) => a <= c.start) ? base + amount : base]]
    for (const [a, b] of overlaps) {
      const la = a - c.start
      const lb = b - c.start
      if (lb < 0 || la > c.dur) continue
      keys.push([Math.max(0, la - 0.35), base], [Math.max(0, la), base + amount], [Math.min(c.dur, lb), base + amount], [Math.min(c.dur, lb + 0.5), base])
    }
    keys.push([c.dur, base])
    const seen = new Set()
    for (const [t, v] of keys.sort((x, y) => x[0] - y[0])) {
      const k = t.toFixed(3)
      if (seen.has(k)) continue
      seen.add(k)
      ops.push({ op: 'keyframe', id: c.id, prop: 'volume', at: t, local: true, value: v, ease: 'smooth' })
    }
  }
  return ops
}
