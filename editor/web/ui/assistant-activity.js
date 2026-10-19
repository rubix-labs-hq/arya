const ACTIVE = new Set(['sending', 'thinking', 'working', 'queued', 'running', 'cancelling'])
const TERMINAL = new Set(['done', 'cancelled', 'error'])

export function elapsedLabel(milliseconds) {
  const seconds = Math.floor(Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0) / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

export function assistantActivity(run = {}, { connected = true, pending = false, stopping = false, now = Date.now() } = {}) {
  const preparing = pending && !stopping && !ACTIVE.has(run.state)
  const state = stopping ? 'cancelling' : preparing ? 'sending' : run.state ?? 'idle'
  const active = ACTIVE.has(state), terminal = TERMINAL.has(state)
  const start = !preparing && Number.isFinite(run.startedAt) ? run.startedAt : null
  const end = terminal && Number.isFinite(run.finishedAt) ? run.finishedAt : now
  const elapsed = start == null ? '' : elapsedLabel(end - start)
  const label = !connected && !terminal ? 'Reconnecting' : run.stopUnconfirmed ? 'Stop unconfirmed' : ({ sending: 'Sending request', queued: 'Queued', thinking: 'Thinking', running: 'Working', working: 'Using tools', cancelling: 'Stopping', done: 'Response finished', cancelled: 'Stopped', error: 'Failed' })[state] ?? 'Ready'
  const quiet = active && !preparing && Number.isFinite(run.updatedAt) && now - run.updatedAt >= 20000
  const detail = !connected && !terminal ? 'Live status is unavailable. The request may still be running.'
    : run.stopUnconfirmed ? 'Stopping could not be confirmed. Review processing jobs before retrying.'
    : state === 'cancelling' ? 'Waiting for the agent and its processing to stop.'
    : active ? preparing ? 'Preparing your request.' : quiet ? `No update for ${elapsedLabel(now - run.updatedAt)}. Last confirmed stage: ${run.phase || 'Working'}.` : run.phase || 'Your request is in progress.'
    : state === 'done' ? run.outcome || 'Response finished. Edit results have not been verified.'
    : state === 'cancelled' ? 'Request stopped. Committed edits remain available to review and undo.'
    : state === 'error' ? 'The request could not finish. Review the error and any committed edits before retrying.' : ''
  return { state, active, terminal, label, detail, connectionNotice: !connected && terminal ? 'Reconnecting. Showing the last confirmed result.' : '', elapsed, canStop: connected && active && !['sending', 'cancelling'].includes(state) }
}
