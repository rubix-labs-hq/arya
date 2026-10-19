import { MUSIC_RENDERER, isAryaMusicAsset, hasMusicByteIdentity, musicPlacementOps, validateMusicScore } from '/core/music-score.js'

import { snapToFrame } from '/core/project.js'

const json = value => JSON.stringify(value)
const ownedPath = path => typeof path === 'string' && /^media\/generated\/music\/[0-9a-f-]{36}\/score\.wav$/.test(path)

export function musicVariation(score, changes) {
  const allowed = ['title', 'bpm', 'lengthBeats', 'seed', 'masterDb', 'room', 'parts']
  if (!changes || Object.keys(changes).some(key => !allowed.includes(key))) throw new Error('Unsupported score change')
  return validateMusicScore({ ...score, ...changes })
}

// A small editable phrase. The existing local renderer creates the actual audio.
export function newMusicScore() {
  return validateMusicScore({ version: 1, title: 'Original cue', bpm: 120, lengthBeats: 8, seed: 17, masterDb: -6, room: 0.08,
    parts: [{ id: 'melody', instrument: 'keys', gainDb: -12, pan: 0,
      notes: [60, 64, 67, 72].map((pitch, index) => ({ at: index * 2, duration: 1.5, pitch, velocity: 0.7 })) }],
  })
}

export function resizeMusicScore(score, seconds) {
  if (!score || !Number.isFinite(score.bpm) || score.bpm < 40 || score.bpm > 220 || !Number.isFinite(score.lengthBeats) || score.lengthBeats <= 0 || !Array.isArray(score.parts)) throw new Error('Enter a valid tempo and score length before changing duration')
  const original = score
  if (!Number.isFinite(seconds) || seconds < 0.25 || seconds > 60) throw new Error('Duration must be between 0.25 and 60 seconds')
  const lengthBeats = seconds * original.bpm / 60, ratio = lengthBeats / original.lengthBeats
  return validateMusicScore({ ...original, lengthBeats,
    parts: original.parts.map(part => ({ ...part, notes: part.notes.map(note => ({ ...note, at: note.at * ratio, duration: note.duration * ratio })) })),
  })
}

// Owns one dialog's reviewed requests. The backend owns rendering and Media registration.
export function createGeneratedMusicSession({ source = null, read, request, changed = () => {} }) {
  const initial = read(), original = source === null ? null : initial.project?.assets?.[source]
  if (source !== null && !isAryaMusicAsset(original)) throw new Error('Choose a locally synthesized music asset')
  const origin = { root: initial.root, comp: initial.comp ?? null, sourceJSON: json(original) }
  const state = { original: original === null ? null : JSON.parse(origin.sourceJSON), capabilities: null, busy: false, checking: false, error: '', message: '', review: '', retained: null }
  let open = true, reviewed = null
  const notify = () => { if (open) changed() }
  function sourceCurrent() {
    const now = read()
    return open && !!now.project && now.connected === true && now.root === origin.root && (now.comp ?? null) === origin.comp && (source === null || json(now.project.assets?.[source]) === origin.sourceJSON)
  }
  function requireSource() {
    if (!sourceCurrent()) throw new Error(source === null ? 'The project or composition changed, or the editor disconnected. Reopen Create music for the current project.' : 'The project, composition or source changed, or the editor disconnected. Reopen its current music details.')
  }
  function available() { return state.capabilities?.available === true && state.capabilities.renderer === MUSIC_RENDERER }
  function invalidate() { reviewed = null; state.review = ''; notify() }
  function currentReview() {
    const now = read()
    return sourceCurrent() && available() && !!reviewed && now.version === reviewed.version && json(now.project) === reviewed.projectJSON
  }
  function idle() { if (state.busy) throw new Error('Wait for the current music request to finish') }
  async function loadCapabilities() {
    if (!open || state.checking || state.busy) return
    requireSource(); state.checking = true; state.capabilities = null; invalidate(); state.error = ''; notify()
    try {
      const result = await request('/api/audio/compose/capabilities')
      if (!open) return
      requireSource(); state.capabilities = result
      if (!available()) state.error = `This backend does not currently offer the supported local music composer. ${state.original ? 'The saved score remains available to inspect.' : 'The starting score is available to inspect, but creation is unavailable.'}`
    } catch (error) { if (open) state.error = error.message }
    finally { state.checking = false; notify() }
  }
  async function review({ mode, track, start, score }) {
    idle(); requireSource()
    if (!available()) throw new Error('Check local composer availability before reviewing placement')
    if (!['place', 'variation', 'create'].includes(mode) || (mode === 'create' && source !== null) || (mode === 'variation' && source === null)) throw new Error('Choose a supported creation or reuse action')
    state.busy = true; state.error = ''; state.message = ''; invalidate(); notify()
    try {
      const snapshot = await request('/api/project')
      if (!open) return null
      requireSource()
      const now = read()
      if (snapshot.root !== origin.root || !Number.isSafeInteger(snapshot.version) || snapshot.version < 0 || snapshot.version !== now.version || json(snapshot.project) !== json(now.project)) throw new Error('The project is still changing. Wait for pending edits, then review the target again.')
      const path = mode === 'place' && state.retained ? state.retained.path : source
      const asset = snapshot.project.assets?.[path]
      if (mode === 'place' && (!isAryaMusicAsset(asset) || (state.retained && json(asset) !== state.retained.assetJSON))) throw new Error('The saved music changed. Reopen its current Media entry before placing it.')
      const normalized = validateMusicScore(mode === 'place' ? asset.generated.score : score)
      const body = { score: normalized, track, start, comp: origin.comp, expectedVersion: snapshot.version }
      const placement = musicPlacementOps(snapshot.project, body)
      const scope = origin.comp === null ? snapshot.project : snapshot.project.comps[origin.comp]
      const target = scope.tracks.find(item => item.id === track)
      const payload = mode === 'place' ? { path, track, start, comp: origin.comp, expectedVersion: snapshot.version } : body
      reviewed = { mode, version: snapshot.version, projectJSON: json(snapshot.project), usedPaths: new Set(Object.keys(snapshot.project.assets ?? {})), path, score: normalized, placement, clipStart: snapToFrame(placement.start, scope.fps ?? snapshot.project.fps), clipDuration: snapToFrame(placement.dur, scope.fps ?? snapshot.project.fps), payload }
      state.review = `${target.name || target.id} (${target.id}) · ${placement.start.toFixed(2)}–${(placement.start + placement.dur).toFixed(2)} s · version ${snapshot.version}`
      return state.review
    } catch (error) { if (open) state.error = error.message; throw error }
    finally { state.busy = false; notify() }
  }
  async function run() {
    idle(); requireSource()
    if (!currentReview()) throw new Error('Review the current target before placing music')
    const capture = reviewed
    state.busy = true; state.error = ''; state.message = ''; invalidate(); notify()
    try {
      const result = await request(capture.mode === 'place' ? '/api/audio/compose/place' : '/api/audio/compose', capture.payload)
      if (!open) return null
      requireSource()
      if (!result || !['complete', 'asset_ready'].includes(result.state) || !Number.isSafeInteger(result.version) || result.version < capture.version || !ownedPath(result.path) || !isAryaMusicAsset(result.asset)) throw new Error('The response did not confirm saved music. Review Media before retrying.')
      if (capture.mode === 'place' ? result.path !== capture.path || result.state !== 'complete' : capture.usedPaths.has(result.path) || !hasMusicByteIdentity(result.asset)) throw new Error('The response did not identify the requested new or reused music source. Review Media before retrying.')
      if (json(validateMusicScore(result.asset.generated.score)) !== json(capture.score)) throw new Error('The saved score differs from the reviewed request. Review Media before retrying.')
      const snapshot = await request('/api/project')
      if (!open) return null
      requireSource()
      if (snapshot.root !== origin.root || !Number.isSafeInteger(snapshot.version) || snapshot.version < result.version || json(snapshot.project?.assets?.[result.path]) !== json(result.asset)) throw new Error('The saved music receipt no longer matches Media. Reopen its current source before retrying.')
      if (capture.mode !== 'place') state.retained = { path: result.path, name: result.asset.name || capture.score.title, assetJSON: json(result.asset) }
      if (result.state === 'asset_ready') {
        state.message = `Music is saved in Media. Review a current target and place this saved ${capture.mode === 'create' ? 'music' : 'variation'} without rendering again.`
      } else {
        const scope = origin.comp === null ? snapshot.project : snapshot.project?.comps?.[origin.comp]
        const clips = scope?.tracks?.find(track => track.id === capture.payload.track)?.clips ?? []
        const ids = result.created
        const confirmed = snapshot.version === result.version && Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' && clips.some(clip => clip.id === id && clip.kind === 'audio' && clip.src === result.path && clip.start === capture.clipStart && clip.dur === capture.clipDuration))
        state.message = confirmed ? 'Music is saved in Media and placed on the reviewed track. Undo removes placement and keeps the source.' : 'Music is saved in Media, but the timeline changed or placement could not be confirmed. Inspect the timeline before placing again.'
      }
      return { state: result.state, path: result.path }
    } catch (error) { if (open) state.error = `${error.message} Any completed music may already be in Media; review it before retrying.`; throw error }
    finally { state.busy = false; notify() }
  }
  return { state, sourceCurrent, available, currentReview, loadCapabilities, review, run, invalidate,
    useOriginal() { idle(); if (!state.original) throw new Error('This dialog has no original Media source'); state.retained = null; invalidate() },
    close() { open = false; reviewed = null },
  }
}
