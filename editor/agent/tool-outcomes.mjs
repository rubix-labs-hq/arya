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

const JOB_REASON_LIMIT = 160
const jobLabel = failure => failure.kind === 'export' ? `The export${failure.name ? ` ${failure.name}` : ''}` : failure.kind === 'frame' ? 'The frame render' : `The ${failure.kind} job`

function jobReason(failure) {
  if (typeof failure?.kind !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(failure.kind)) return null
  const error = typeof failure.error === 'string' ? failure.error.replace(/\s+/g, ' ').trim() : ''
  if (failure.state === 'cancelled' || /^(export |processing )?cancelled\.?$/i.test(error)) return `${jobLabel(failure)} was cancelled.`
  if (!error) return null
  const short = error.length > JOB_REASON_LIMIT ? `${error.slice(0, JOB_REASON_LIMIT - 3).trimEnd()}...` : error
  return `${jobLabel(failure)} failed: ${short}${/[.!?]$/.test(short) ? '' : '.'}`
}

// The sentence a request ends with when jobs it started failed or were cancelled. Each failure is
// { state, kind?, name?, error? }. The count is always kept. Up to two jobs also say what happened,
// in the server's own words, so the user does not have to find the job to learn why.
export function unfinishedJobsOutcome(failures) {
  const count = failures.length
  const reasons = failures.map(jobReason).filter(Boolean)
  const shown = reasons.slice(0, 2), more = reasons.length - shown.length
  return [`${count} processing job${count === 1 ? '' : 's'} did not finish.`, ...shown, ...(more ? [`${more} more ${more === 1 ? 'is' : 'are'} not listed here.`] : []), 'Review any committed edits.'].join(' ')
}
