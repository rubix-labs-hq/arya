// When Arya may ask, once in a while, for an optional tip. The Swift twin is
// native/ReelKit/Sources/ReelKit/SupportPrompt.swift; keep the two rules the same.
//
// The prompt appears only right after an export the person started finishes successfully,
// never on the first one, at most three times ever and at least 60 days apart. Opening the
// tip page from the prompt or choosing "Don't ask again" ends it for good. The state records
// only these counts and dates. It never records whether anyone paid.

export const FIRST_EXPORT = 2
export const MAXIMUM_SHOWS = 3
export const MINIMUM_GAP_MS = 60 * 24 * 60 * 60 * 1000

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0

/** A clean copy of saved state. Damaged or missing data starts fresh. */
export function supportPromptState(value) {
  const saved = value && typeof value === 'object' ? value : {}
  return {
    successfulExports: count(saved.successfulExports),
    timesShown: count(saved.timesShown),
    lastShown: Number.isFinite(saved.lastShown) ? saved.lastShown : null,
    finished: saved.finished === true,
  }
}

/** Counts one successful export. Returns { state, show }; when show is true the showing is recorded. */
export function successfulExport(value, { now, channelAvailable }) {
  const state = supportPromptState(value)
  state.successfulExports += 1
  const waited = state.lastShown === null || now - state.lastShown >= MINIMUM_GAP_MS
  const show = Boolean(channelAvailable) && !state.finished && state.successfulExports >= FIRST_EXPORT && state.timesShown < MAXIMUM_SHOWS && waited
  if (show) { state.timesShown += 1; state.lastShown = now }
  return { state, show }
}

/** choice: 'support' (opened the tip page), 'notNow' or 'never'. */
export function recordSupportChoice(value, choice) {
  const state = supportPromptState(value)
  if (choice === 'support' || choice === 'never') state.finished = true
  return state
}

/** True when an export this editor saw in progress (beforeState) has just saved its file. */
export function exportJustFinished(beforeState, job) {
  return job?.kind === 'export' && job.state === 'done' && !job.error && Boolean(job.output) && typeof beforeState === 'string' && beforeState !== 'done'
}
