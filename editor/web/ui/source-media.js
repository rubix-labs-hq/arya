export function sourceAudioWindow(src, duration, time, windowSeconds = 300) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(windowSeconds) || windowSeconds <= 0) throw new Error('Audio preview needs a finite duration and window')
  const target = Math.max(0, Math.min(duration, Number.isFinite(time) ? time : 0))
  const from = Math.floor(Math.min(target, Math.max(0, duration - 0.001)) / windowSeconds) * windowSeconds
  const length = Math.min(windowSeconds, duration - from)
  return { from, duration: length, time: target - from, url: `/api/audio?src=${encodeURIComponent(src)}&in=${from}&dur=${length}` }
}

export function sourcePlacementPlan(project, source, mode, time) {
  if (!['append', 'insert', 'overwrite', 'connect'].includes(mode)) throw new Error('Choose a supported source placement.')
  const asset = project.assets?.[source?.src]
  if (!asset || !asset.hasVideo && !asset.hasAudio) throw new Error('This source is no longer available. Open a current media source.')
  const image = asset.hasVideo && (asset.still || asset.duration === undefined)
  const duration = image ? 5 : asset.duration
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('This source has no valid duration. Reimport it before placing it.')
  const input = source.in ?? 0, markedOut = source.out ?? duration
  if (!Number.isFinite(input) || !Number.isFinite(markedOut) || input < 0 || markedOut <= input || markedOut > duration) throw new Error('Choose source In and Out marks within the available source.')
  const range = project.range
  if (range && (!Number.isFinite(range.in) || !Number.isFinite(range.out) || range.in < 0 || range.out <= range.in)) throw new Error('Choose a valid timeline range before placing this source.')
  const length = range ? range.out - range.in : markedOut - input
  const output = input + length
  if (!image && output > duration + 1e-6) throw new Error('The selected timeline range exceeds the remaining source. Shorten the range or move the source In mark.')
  const start = range ? range.in : time
  if (mode !== 'append' && (!Number.isFinite(start) || start < 0)) throw new Error('Choose a valid timeline position before placing this source.')
  const kind = asset.hasVideo ? 'video' : 'audio'
  const tracks = project.tracks.filter(track => track.kind === kind)
  const candidates = mode === 'connect' ? tracks.slice(1) : tracks
  const target = candidates.find(track => !track.locked)
  if (!target) throw new Error(mode === 'connect' ? `Connect needs an unlocked upper ${kind} track.` : `Choose an unlocked ${kind} track before placing this source.`)
  const operation = { op: mode === 'connect' ? 'overwrite' : mode, src: source.src, track: target.id, ...(mode !== 'append' ? { start } : {}), in: image ? 0 : input, ...(image ? { dur: length } : { out: output }) }
  if (source.audio === false) {
    operation.audio = false
    if (kind === 'video' && !image) operation.set = { mute: true }
  }
  if (kind === 'video' && !image && asset.hasAudio && source.audio !== false) {
    const audioTracks = project.tracks.filter(track => track.kind === 'audio')
    const audio = (mode === 'connect' ? audioTracks.slice(1) : audioTracks).find(track => !track.locked)
    if (!audio) throw new Error(mode === 'connect' ? 'Connect needs an unlocked upper audio track to preserve the primary audio bed.' : 'Choose an unlocked audio track before placing video with sound.')
    operation.audioTrack = audio.id
  }
  return operation
}
