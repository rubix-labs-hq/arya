// Keep unresolved edit receipts separate from the agent's prose. A later music placement
// can recover its own saved asset, but cannot erase another target or processing failure.
const ownedMusicPath = /^media\/generated\/music\/[0-9a-f-]{36}\/score\.wav$/
const identifier = /^[a-zA-Z0-9_-]{1,128}$/

export function createToolOutcomes() {
  return { musicPlacements: new Map(), otherPlacementFailed: false, otherAssetReady: false, unconfirmedCompletedFailure: false }
}

function musicPlacement(call, result) {
  if (call?.method !== 'POST' || !['/api/audio/compose', '/api/audio/compose/place'].includes(call.path)) return null
  const path = result?.path, track = call.body?.track, comp = call.body?.comp ?? null
  if (typeof path !== 'string' || !ownedMusicPath.test(path) || typeof track !== 'string' || !identifier.test(track)
      || comp !== null && (typeof comp !== 'string' || !identifier.test(comp))) return null
  if (call.path === '/api/audio/compose/place' && call.body?.path !== path) return null
  if (result.track !== undefined && result.track !== track || result.comp !== undefined && result.comp !== comp) return null
  if (result.asset?.generated?.kind !== 'original-music' || result.asset.generated.renderer !== 'arya-score-synth/1') return null
  // The reviewed retry may move within the same track to an empty gap. Composition and
  // track remain part of the operation scope; a placement elsewhere does not recover it.
  return { key: JSON.stringify([path, comp, track]), path, comp, track }
}

export function recordToolOutcome(outcomes, call, result) {
  // A staged edit intentionally waits for the user's Apply action.
  if (call?.method === 'POST' && call.path === '/api/assistant/propose'
      && result?.previewed === true && typeof result.proposal === 'string' && identifier.test(result.proposal)) return
  const music = musicPlacement(call, result)
  const unapplied = result?.applied === false || result?.state === 'asset_ready'
  if (unapplied) {
    if (music) outcomes.musicPlacements.set(music.key, music)
    else {
      outcomes.otherPlacementFailed = true
      if (result?.state === 'asset_ready' || result?.assetRegistered === true) outcomes.otherAssetReady = true
    }
  } else if (music && result?.state === 'complete') {
    outcomes.musicPlacements.delete(music.key)
  }
}

export function unresolvedToolOutcome(outcomes) {
  if (outcomes.unconfirmedCompletedFailure) return 'A processing result was not applied. Review the result before retrying.'
  if (outcomes.musicPlacements.size || (outcomes.otherPlacementFailed && outcomes.otherAssetReady)) return 'Generated media is saved in Media, but its requested edit was not applied. Retry placement without regenerating.'
  if (outcomes.otherPlacementFailed) return 'A processing result was not applied. Review the result before retrying.'
  return null
}

// A completed render can still fail its requested placement. Missing applied state
// also covers saved-only processing, so it is not itself a failure.
export function recordCompletedJobOutcome(outcomes, result) {
  if (result?.state !== 'done') return
  if (result.applied !== false && !(typeof result.applyError === 'string' && result.applyError.trim())) return
  if (result.assetRegistered !== true) outcomes.unconfirmedCompletedFailure = true
  recordToolOutcome(outcomes, null, { applied: false, assetRegistered: result.assetRegistered === true })
}
