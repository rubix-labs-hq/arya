const ACTIVE = new Set(['sending', 'thinking', 'working', 'queued', 'running', 'cancelling'])
const TERMINAL = new Set(['done', 'cancelled', 'error'])

export function elapsedLabel(milliseconds) {
  const seconds = Math.floor(Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0) / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

// The browser server's outcome for a finished request that ran with Preview changes on.
export const PREVIEW_OUTCOME = 'Preview mode was on. Proposed edits are applied only when you choose Apply.'

// The phase the browser server and the Mac app publish with each piece of reply text.
export const WRITING_PHASE = 'Generating a response'

// A run that has said nothing for this long shows that it is quiet, as the Mac and iPad apps do.
const QUIET_MS = 20000

// One run as one quiet line: a label, a stage and the elapsed time. `detail` is the sentence the
// line expands to. The words are the ones the Mac, iPad and iPhone apps use, except that a stop
// that changed nothing says so here before the native panel does.
// `proposal` and `edits` say whether this request left a preview to apply or committed edits.
// `unchanged` says the project did not move at all during it. Leave them out when that is not
// known, and the full sentences are kept.
export function assistantActivity(run = {}, { connected = true, pending = false, stopping = false, now = Date.now(), proposal, edits, unchanged = false } = {}) {
  const preparing = pending && !stopping && !ACTIVE.has(run.state)
  const state = stopping ? 'cancelling' : preparing ? 'sending' : run.state ?? 'idle'
  const active = ACTIVE.has(state), terminal = TERMINAL.has(state)
  const start = !preparing && Number.isFinite(run.startedAt) ? run.startedAt : null
  const end = terminal && Number.isFinite(run.finishedAt) ? run.finishedAt : now
  const elapsed = start == null ? '' : elapsedLabel(end - start)
  // Writing only while reply text is what arrived last. The server names that phase; a tool step or
  // a wait after it is Working again, so the label does not flip between the two on every step.
  const writing = state === 'thinking' && typeof run.text === 'string' && run.text.length > 0 && (!run.phase || run.phase === WRITING_PHASE)
  const label = !connected && !terminal ? 'Reconnecting'
    : state === 'cancelling' ? 'Stopping…' : run.stopUnconfirmed ? 'Failed' : writing ? 'Writing…' : active ? 'Working'
    : ({ done: 'Done', cancelled: 'Stopped', error: 'Failed' })[state] ?? 'Ready'
  const quiet = active && !preparing && state !== 'cancelling' && Number.isFinite(run.updatedAt) && now - run.updatedAt >= QUIET_MS
  const phase = run.phase || ''
  const stage = !connected && !terminal ? 'Live status is unavailable'
    : run.stopUnconfirmed ? 'Stopping could not be confirmed'
    : state === 'cancelling' ? 'Waiting for the agent and its processing to stop'
    : preparing ? 'Preparing your request'
    : active ? quiet ? 'No update for 20 seconds' : phase || 'Thinking about your request'
    : state === 'done' ? run.outcome === PREVIEW_OUTCOME && proposal === false ? '' : run.outcome || 'Results not verified'
    : state === 'cancelled' ? unchanged ? 'Nothing was changed.' : edits === false ? '' : 'Review or undo any committed edits.'
    : ''
  const detail = !connected && !terminal ? active ? 'Live status is unavailable. The request may still be running.' : 'Live status is unavailable.'
    : run.stopUnconfirmed ? 'Stopping could not be confirmed. Review processing jobs before retrying.'
    : state === 'cancelling' ? 'Waiting for the agent and its processing to stop.'
    : preparing ? 'Preparing your request.'
    : active ? quiet ? `No update for 20 seconds. Last confirmed stage: ${phase || 'Working'}.` : phase || 'Thinking about your request'
    : state === 'done' ? run.outcome === PREVIEW_OUTCOME && proposal === false ? '' : run.outcome || 'Edit results have not been verified.'
    : state === 'cancelled' ? unchanged ? 'Stopped. Nothing was changed.' : edits === false ? '' : 'Stopped. Review or undo any committed edits.'
    : state === 'error' ? 'Request failed. Review the error before retrying.' : ''
  return { state, active, terminal, writing, quiet, label, stage, detail, connectionNotice: !connected && terminal ? 'Reconnecting. Showing the last confirmed result.' : '', elapsed, canStop: connected && active && !['sending', 'cancelling'].includes(state) }
}

/**
 * The one status word the Ask Arya entry and the panel header both show, in the order the Mac,
 * iPad and iPhone apps use. `hosted` is the beta browser editor, where the assistant is not offered.
 */
export function assistantStatusWord({ hosted = false, connected = true, run = {}, pending = false, ready = false, checking = false, proposal = false } = {}) {
  if (hosted) return 'Mac app'
  if (!connected) return 'Reconnecting'
  const { state, active } = assistantActivity(run, { connected, pending })
  if (state === 'cancelling') return 'Stopping'
  if (active) return 'Working'
  if (state === 'error') return 'Failed'
  if (proposal) return 'Preview ready'
  if (!ready) return checking ? 'Checking' : 'Not set up'
  return 'Ready'
}
// The status word travels with the activity, so a page that already has the one has the other.
assistantActivity.statusWord = assistantStatusWord
