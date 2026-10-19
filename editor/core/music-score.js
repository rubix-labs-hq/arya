// A bounded, deterministic synthesizer for original structured scores. No recordings,
// model downloads, network requests or generated executable code. Shared by Node and JSC.
export const MUSIC_RENDERER = 'arya-score-synth/1'
export const MUSIC_RATE = 48000
export const MUSIC_INSTRUMENTS = ['keys', 'pluck', 'pad', 'bass', 'bell', 'kick', 'snare', 'hat']
const TAU = 2 * Math.PI
const DRUMS = new Set(['kick', 'snare', 'hat'])
const RELEASE = { keys: 0.22, pluck: 0.16, pad: 0.4, bass: 0.12, bell: 0.35, kick: 0.05, snare: 0.05, hat: 0.03 }

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}
function keys(value, allowed, name) {
  object(value, name)
  for (const k of Object.keys(value)) if (!allowed.includes(k)) throw new Error(`${name}: unsupported field ${k}`)
}
function number(value, name, lo, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) throw new Error(`${name} must be a number between ${lo} and ${hi}`)
  return value
}
function text(value, name, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f]/.test(value)) throw new Error(`${name} must be nonempty text of at most ${limit} characters`)
  return value.trim()
}
function uint(value) {
  const n = number(value, 'seed', 0, 0xffffffff)
  if (!Number.isInteger(n)) throw new Error('seed must be an unsigned integer')
  return n >>> 0
}
function hash(value) {
  value = Math.imul(value ^ value >>> 16, 0x7feb352d)
  value = Math.imul(value ^ value >>> 15, 0x846ca68b)
  return (value ^ value >>> 16) >>> 0
}
function noise(frame, seed) { return hash((frame + seed) >>> 0) / 2147483648 - 1 }

/** Normalize data and reject scores that are silent, unbounded or over voice budget. */
export function validateMusicScore(input) {
  keys(input, ['version', 'title', 'bpm', 'lengthBeats', 'seed', 'masterDb', 'room', 'parts'], 'score')
  if (input.version !== 1) throw new Error('score.version must be 1')
  const bpm = number(input.bpm, 'bpm', 40, 220)
  const lengthBeats = number(input.lengthBeats, 'lengthBeats', 0.25, 220)
  const seconds = lengthBeats * 60 / bpm
  if (seconds < 0.25 || seconds > 60) throw new Error('score length must be between 0.25 and 60 seconds')
  if (!Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > 8) throw new Error('use between 1 and 8 instrument parts')
  let count = 0
  const ids = new Set(), edges = []
  const parts = input.parts.map((p, i) => {
    keys(p, ['id', 'instrument', 'gainDb', 'pan', 'notes'], `part ${i}`)
    const id = text(p.id, 'part id', 64)
    if (ids.has(id)) throw new Error(`duplicate part id ${id}`)
    ids.add(id)
    if (!MUSIC_INSTRUMENTS.includes(p.instrument)) throw new Error(`unsupported instrument ${p.instrument}`)
    if (!Array.isArray(p.notes) || !p.notes.length) throw new Error(`${id} needs at least one note`)
    const notes = p.notes.map((n, j) => {
      if (++count > 1024) throw new Error('use at most 1024 notes')
      keys(n, ['at', 'duration', 'pitch', 'velocity'], `${id} note ${j}`)
      const at = number(n.at, 'note at (beats)', 0, lengthBeats)
      const duration = number(n.duration, 'note duration (beats)', 0.025, lengthBeats)
      if (at + duration > lengthBeats + 1e-9) throw new Error('every note must fit within lengthBeats')
      const pitch = number(n.pitch ?? (DRUMS.has(p.instrument) ? 60 : undefined), 'MIDI pitch', 24, 96)
      if (!Number.isInteger(pitch)) throw new Error('MIDI pitch must be an integer')
      const velocity = number(n.velocity ?? 0.7, 'velocity', 0.01, 1)
      const start = Math.round(at * 60 / bpm * MUSIC_RATE)
      const end = Math.min(Math.round(seconds * MUSIC_RATE), Math.ceil(start + (duration * 60 / bpm + RELEASE[p.instrument]) * MUSIC_RATE))
      if (start >= end) throw new Error('note must have audible duration')
      edges.push([start, 1], [end, -1])
      return { at, duration, pitch, velocity }
    })
    return { id, instrument: p.instrument, gainDb: number(p.gainDb ?? -12, 'part gainDb', -48, 0), pan: number(p.pan ?? 0, 'part pan', -1, 1), notes }
  })
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let voices = 0
  for (const [, d] of edges) if ((voices += d) > 24) throw new Error('score exceeds 24 simultaneous voices including release tails')
  return { version: 1, title: text(input.title, 'title', 120), bpm, lengthBeats, seed: uint(input.seed ?? 0), masterDb: number(input.masterDb ?? -3, 'masterDb', -24, 0), room: number(input.room ?? 0.12, 'room', 0, 0.3), parts }
}

function tone(v, t, frame) {
  const phase = TAU * v.frequency * t
  let s = 0
  switch (v.instrument) {
    case 'keys':
      // Soft FM electric keys, not a sampled acoustic piano.
      return 0.7 * Math.sin(phase + 1.6 * Math.exp(-2.6 * t) * Math.sin(2 * phase)) * Math.exp(-0.85 * t)
    case 'pluck':
      for (let h = 1; h <= 8 && h * v.frequency < MUSIC_RATE * 0.4; h++) s += Math.sin(h * phase) * Math.exp(-t * (2.4 + h * 0.42)) / (h * h)
      return s * 0.72
    case 'pad':
      return (Math.sin(phase) + 0.35 * Math.sin(phase * 1.0037 + 0.3) + 0.3 * Math.sin(phase * 0.9963 - 0.3) + 0.12 * Math.sin(2 * phase)) * 0.4
    case 'bass': return (Math.sin(phase) + 0.23 * Math.sin(2 * phase) + 0.07 * Math.sin(3 * phase)) * 0.75
    case 'bell': return (Math.sin(phase) * Math.exp(-1.3 * t) + 0.35 * Math.sin(phase * 2.76) * Math.exp(-3.1 * t) + 0.12 * Math.sin(phase * 5.4) * Math.exp(-5.5 * t)) * 0.6
    case 'kick': return Math.sin(TAU * (46 * t + 65 * 0.018 * (1 - Math.exp(-t / 0.018)))) * Math.exp(-13 * t) * 0.9
    case 'snare': {
      const high = (noise(frame, v.seed) - noise(frame - 1, v.seed)) * 0.5
      return (0.7 * high * Math.exp(-22 * t) + 0.2 * Math.sin(TAU * 185 * t) * Math.exp(-28 * t)) * 0.9
    }
    case 'hat': {
      const high = (noise(frame, v.seed) - noise(frame - 1, v.seed)) * 0.5
      return (0.75 * high + 0.1 * Math.sin(TAU * 7331 * t) + 0.1 * Math.sin(TAU * 10453 * t)) * Math.exp(-48 * t) * 0.5
    }
  }
  throw new Error('Unknown instrument')
}
function envelope(v, t) {
  const attack = v.instrument === 'pad' ? Math.min(0.18, v.duration / 3) : DRUMS.has(v.instrument) ? 0.0008 : 0.005
  const a = Math.min(1, t / attack)
  const release = t <= v.duration ? 1 : Math.max(0, 1 - (t - v.duration) / RELEASE[v.instrument])
  return (0.5 - 0.5 * Math.cos(Math.PI * a)) * (0.5 - 0.5 * Math.cos(Math.PI * release))
}

/** Streaming stereo Float32 PCM. Each instance owns its scheduling and room buffers. */
export function createMusicRenderer(input) {
  const score = validateMusicScore(input), frames = Math.round(score.lengthBeats * 60 / score.bpm * MUSIC_RATE)
  const master = 10 ** (score.masterDb / 20)
  const events = []
  let noteNumber = 0
  for (const p of score.parts) for (const n of p.notes) {
    const start = Math.round(n.at * 60 / score.bpm * MUSIC_RATE), duration = n.duration * 60 / score.bpm
    events.push({ start, end: Math.min(frames, Math.ceil(start + (duration + RELEASE[p.instrument]) * MUSIC_RATE)), duration, frequency: 440 * 2 ** ((n.pitch - 69) / 12), instrument: p.instrument, seed: hash(score.seed + ++noteNumber), gain: n.velocity * 10 ** (p.gainDb / 20), l: Math.cos((p.pan + 1) * Math.PI / 4), r: Math.sin((p.pan + 1) * Math.PI / 4) })
  }
  events.sort((a, b) => a.start - b.start)
  // Two short, decorrelated stereo delay taps form a restrained synthesized room.
  const left = new Float64Array(6241), right = new Float64Array(7639)
  let cursor = 0, next = 0, active = []
  return {
    score, frames, sampleRate: MUSIC_RATE, channels: 2,
    renderChunk(size = 4096) {
      if (!Number.isInteger(size) || size < 1 || size > 16384) throw new Error('chunk size must be between 1 and 16384 frames')
      const len = Math.min(size, frames - cursor), pcm = new Float32Array(len * 2)
      for (let i = 0; i < len; i++, cursor++) {
        while (next < events.length && events[next].start <= cursor) active.push(events[next++])
        active = active.filter(v => v.end > cursor)
        let l = 0, r = 0
        for (const v of active) {
          const t = (cursor - v.start) / MUSIC_RATE
          const s = tone(v, t, cursor - v.start) * envelope(v, t) * v.gain
          l += s * v.l; r += s * v.r
        }
        const li = cursor % left.length, ri = cursor % right.length
        const dl = left[li], dr = right[ri]
        left[li] = l + dr * 0.28; right[ri] = r + dl * 0.28
        l += dl * score.room; r += dr * score.room
        const endFade = Math.min(1, (frames - cursor - 1) / (MUSIC_RATE * 0.02))
        const fade = 0.5 - 0.5 * Math.cos(Math.PI * endFade)
        pcm[i * 2] = l * master * fade; pcm[i * 2 + 1] = r * master * fade
      }
      return pcm
    },
  }
}

/** Report digital sample peak/RMS only. This is not LUFS or intersample true peak. */
export function musicMeasurement() {
  let peak = 0, square = 0, count = 0
  return {
    add(pcm) {
      for (const s of pcm) {
        if (!Number.isFinite(s)) throw new Error('Renderer produced nonfinite audio')
        peak = Math.max(peak, Math.abs(s)); square += s * s; count++
      }
    },
    result() {
      if (!count || !peak || square / count < 1e-14) throw new Error('Score produced inaudible audio; no asset created')
      const gain = Math.min(1, 10 ** (-3 / 20) / peak)
      return { samplePeakDb: 20 * Math.log10(peak * gain), rmsDb: 10 * Math.log10(square / count) + 20 * Math.log10(gain), gain, samples: count }
    },
  }
}

export function musicWAVHeader(frames) {
  if (!Number.isInteger(frames) || frames < 1 || frames > MUSIC_RATE * 60) throw new Error('Invalid WAV frame count')
  const bytes = new Uint8Array(44), view = new DataView(bytes.buffer)
  const str = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i) }
  str(0, 'RIFF'); view.setUint32(4, 36 + frames * 6, true); str(8, 'WAVE'); str(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true)
  view.setUint32(24, MUSIC_RATE, true); view.setUint32(28, MUSIC_RATE * 6, true); view.setUint16(32, 6, true); view.setUint16(34, 24, true)
  str(36, 'data'); view.setUint32(40, frames * 6, true)
  return bytes
}

export function musicPCM24(pcm, gain = 1) {
  number(gain, 'render gain', 0, 1)
  const out = new Uint8Array(pcm.length * 3)
  for (let i = 0; i < pcm.length; i++) {
    if (!Number.isFinite(pcm[i]) || Math.abs(pcm[i] * gain) > 0.708) throw new Error('Invalid or unclamped PCM')
    const v = Math.round(pcm[i] * gain * 8388607)
    out[i * 3] = v & 255; out[i * 3 + 1] = v >> 8 & 255; out[i * 3 + 2] = v >> 16 & 255
  }
  return out
}

/** Portable byte transport for JavaScriptCore; neither Buffer nor WebCore is required. */
export function musicBase64(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2], n = a << 16 | (b ?? 0) << 8 | (c ?? 0)
    result += chars[n >>> 18] + chars[n >>> 12 & 63] + (b === undefined ? '=' : chars[n >>> 6 & 63]) + (c === undefined ? '=' : chars[n & 63])
  }
  return result
}

/** An explicit placement in a gap. Never overwrite, ripple or select another track. */
export function musicPlacementOps(project, body, receipt) {
  keys(body, ['score', 'track', 'start', 'comp', 'expectedVersion', 'volume'], 'compose request')
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) throw new Error('expectedVersion is required')
  const score = validateMusicScore(body.score)
  const comp = body.comp == null ? null : text(body.comp, 'composition', 120)
  const scope = comp === null ? project : project?.comps?.[comp]
  if (!scope) throw new Error('Create a project and choose an existing composition first')
  const trackID = text(body.track, 'requested audio track', 64), track = scope.tracks?.find(t => t.id === trackID)
  if (!track || track.kind !== 'audio') throw new Error('Choose an existing audio track explicitly')
  if (track.locked) throw new Error(`Track ${trackID} is locked`)
  const fps = number(scope.fps ?? project.fps, 'project fps', 1, 240)
  const start = Math.round(number(body.start, 'start (seconds)', 0, 14400) * fps) / fps
  const seconds = score.lengthBeats * 60 / score.bpm
  // Floor duration to avoid extending past the rendered source on frame quantization.
  const dur = Math.floor((seconds + 1e-8) * fps) / fps
  if (dur < 1 / fps) throw new Error('Score is shorter than one timeline frame')
  if ((track.clips ?? []).some(c => c.start < start + dur - 1e-7 && c.start + c.dur > start + 1e-7)) throw new Error('Requested music range overlaps existing clips. Choose a gap or move the existing clips first.')
  const volume = number(body.volume ?? 0, 'clip volume', -60, 6)
  if (!receipt) return { score, comp, track: trackID, start, dur, volume }
  const { path } = receipt, registered = musicAssetRecord(score, receipt)
  const existing = project.assets?.[path]
  if (existing && (existing.generated?.renderer !== MUSIC_RENDERER || JSON.stringify(validateMusicScore(existing.generated.score)) !== JSON.stringify(score))) throw new Error('That path belongs to a different Media asset')
  return [
    ...(existing ? [] : [{ op: 'import', assets: { [path]: registered } }]),
    { op: 'add_clip', kind: 'audio', src: path, track: trackID, comp, start, dur, in: 0, audio: false, set: { label: score.title, volume } },
  ]
}

/** Register only after complete render+probe. This can be retained independently of placement. */
export function musicAssetRecord(input, receipt) {
  const score = validateMusicScore(input), seconds = score.lengthBeats * 60 / score.bpm
  const { path, asset, measurement } = receipt
  if (typeof path !== 'string' || !/^media\/generated\/music\/[0-9a-f-]{36}\/score\.wav$/.test(path)) throw new Error('Generated audio needs an owned Media path')
  if (!asset || asset.hasAudio !== true || asset.hasVideo !== false || asset.channels !== 2 || !Number.isFinite(asset.duration) || Math.abs(asset.duration - Math.round(seconds * MUSIC_RATE) / MUSIC_RATE) > 0.002 || asset.codec !== 'pcm_s24le') throw new Error('Rendered audio failed its stereo PCM duration/codec probe')
  if (!measurement || !Number.isFinite(measurement.samplePeakDb) || !Number.isFinite(measurement.rmsDb) || measurement.samplePeakDb > -2.99 || measurement.samples !== Math.round(seconds * MUSIC_RATE) * 2) throw new Error('Rendered audio has no valid completed measurement')
  if (receipt.contentSHA256 !== undefined && (typeof receipt.contentSHA256 !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.contentSHA256))) throw new Error('Generated music has an invalid byte digest')
  const identity = receipt.contentSHA256 ? { contentSHA256: receipt.contentSHA256, contentBytes: 44 + Math.round(seconds * MUSIC_RATE) * 6 } : {}
  return { ...asset, name: score.title, generated: { kind: 'original-music', renderer: MUSIC_RENDERER, score, measurement: { samplePeakDb: measurement.samplePeakDb, rmsDb: measurement.rmsDb, samples: measurement.samples }, provenance: 'Locally synthesized from an original structured score; no external music model or recordings.', ...identity } }
}

export function isAryaMusicAsset(asset) { return asset?.generated?.kind === 'original-music' && asset.generated.renderer === MUSIC_RENDERER }
export function hasMusicByteIdentity(asset) { return isAryaMusicAsset(asset) && typeof asset.generated.contentSHA256 === 'string' && /^[0-9a-f]{64}$/.test(asset.generated.contentSHA256) }

/** A fresh technical probe cannot establish that saved generation metadata still
 * describes these bytes. Legacy entries are kept unchanged, without regeneration. */
export function musicImportDecision(existing, probed, identity) {
  if (!isAryaMusicAsset(existing)) return { asset: probed, disposition: 'ordinary' }
  if (!hasMusicByteIdentity(existing)) return { asset: null, disposition: 'unverified', message: 'This earlier generated music has no saved byte identity. Its Media entry and score were kept unchanged. Import a replacement as a new file to replace it explicitly.' }
  if (!identity || identity.contentSHA256 !== existing.generated.contentSHA256) return { asset: probed, disposition: 'replaced', message: 'The music file changed. Imported it as a replacement and removed its saved score and generation attribution.' }
  return { asset: { ...existing, ...probed, name: existing.name, generated: existing.generated }, disposition: 'unchanged' }
}
