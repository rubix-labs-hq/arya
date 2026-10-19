// The latest assistant change and the pending preview. A request's edits can be undone as
// one step when nothing else changed the project meanwhile. In preview mode the assistant
// proposes ops and processing steps instead of committing them; the user applies or
// discards the proposal, and applying runs the steps in order.

import { randomUUID } from 'node:crypto'
import { PREVIEW_STEP_ROUTES } from '../core/assistant-steps.js'

const ACTIVE = new Set(['thinking', 'working', 'running', 'queued', 'cancelling'])
const TERMINAL = new Set(['done', 'error', 'cancelled'])
const MAX_OPS = 2000
const MAX_STEPS = 16
const MAX_SUMMARY = 240

export const PROPOSAL_EXCLUDED_OPS = new Set(['replace', 'import', 'library_save', 'library_register', 'library_apply', 'library_rename', 'library_remove'])

const invalid = message => Object.assign(new Error(message), { status: 400 })

export function createAssistantReview({ getVersion, getEpoch, getProject, onChange = () => {}, now = Date.now } = {}) {
  let run = null, change = null, proposal = null, applying = null
  const version = () => getVersion(), epoch = () => getEpoch()
  const publicChange = () => {
    if (!change) return null
    // Undo and redo restore the same project objects, so identity survives a round trip.
    const current = getProject() === change.after && epoch() === change.epoch
    const reason = !change.safe ? 'You or another tool edited the project while the assistant change was being made. Use Undo step by step.'
      : !current ? 'The project changed after this assistant change. Use Undo step by step.' : ''
    return { id: change.id, kind: change.kind, runId: change.runId, label: change.label, beforeVersion: change.beforeVersion, afterVersion: change.afterVersion, edits: change.afterVersion - change.beforeVersion, at: change.at, undoable: change.safe && current, reason }
  }
  const publicProposal = () => proposal && { id: proposal.id, runId: proposal.runId, replaced: proposal.replaced ?? '', baseVersion: proposal.baseVersion, ops: proposal.ops, steps: proposal.steps.map(({ path, body, preview }) => ({ path, body, preview })), assets: proposal.assets ?? {}, summary: proposal.summaries.join('; '), at: proposal.at, stale: version() !== proposal.baseVersion || epoch() !== proposal.epoch }
  const publicApplying = () => applying && { id: applying.id, summary: applying.summary, total: applying.total, index: applying.index, title: applying.title, finished: applying.finished, error: applying.error ?? '' }
  const snapshot = () => ({ change: publicChange(), proposal: publicProposal(), applying: publicApplying(), running: !!run && !run.finished, runId: run?.runId ?? null })
  const changed = () => { try { onChange(snapshot()) } catch { /* A failed notification does not undo state. */ } }

  return {
    snapshot,
    /** Every assistant state publication passes through here with the project it saw. */
    observe(state, project) {
      if (!state?.runId) return
      if (ACTIVE.has(state.state) && run?.runId !== state.runId) {
        run = { runId: state.runId, before: project, beforeVersion: version(), epoch: epoch(), foreign: false, finished: false }
        if (applying?.finished) applying = null
        changed()
      } else if (TERMINAL.has(state.state) && run?.runId === state.runId && !run.finished) {
        run.finished = true
        const edits = version() - run.beforeVersion
        if (edits > 0) change = { id: randomUUID(), kind: 'request', runId: run.runId, label: 'Assistant request', before: run.before, after: project, beforeVersion: run.beforeVersion, afterVersion: version(), epoch: run.epoch, safe: !run.foreign && epoch() === run.epoch, at: now() }
        changed()
      }
    },
    /** Every commit reports its owner: the request's run, a preview apply, or nobody (the user or a background job). */
    commitBy(call) {
      if (run && !run.finished && call?.runId !== run.runId) run.foreign = true
      if (applying && !applying.finished && call?.applyId !== applying.id) applying.foreign = true
    },
    active: () => !!run && !run.finished || !!applying && !applying.finished,
    applying: () => !!applying && !applying.finished,
    /** Adds ops and steps to the run's preview, or starts a new one. Throws when they cannot be previewed. */
    propose({ runId = null, ops = [], steps = [], summary, reset = false }) {
      if (!Array.isArray(ops) || !Array.isArray(steps)) throw invalid('ops and steps must be arrays.')
      if (!ops.length && !steps.length) throw invalid('Send nonempty ops or steps to preview.')
      for (const op of ops) {
        if (!op || typeof op !== 'object' || Array.isArray(op) || typeof op.op !== 'string') throw invalid('Each op must be an object with an op name.')
        if (PROPOSAL_EXCLUDED_OPS.has(op.op)) throw invalid(`${op.op} cannot be previewed. Library actions, imports and project replacement apply only with Preview changes turned off.`)
      }
      for (const step of steps) {
        if (!step || typeof step !== 'object' || Array.isArray(step) || !PREVIEW_STEP_ROUTES.includes(step.path) || !step.body || typeof step.body !== 'object' || Array.isArray(step.body)) {
          throw invalid(`Each step is {path, body} with path one of ${PREVIEW_STEP_ROUTES.join(', ')}.`)
        }
      }
      const sameRequest = proposal && !reset && proposal.runId === runId
      if (sameRequest && (proposal.baseVersion !== version() || proposal.epoch !== epoch())) {
        throw Object.assign(new Error(`The project changed after this request's earlier preview (${proposal.ops.length} ops, ${proposal.steps.length} steps). Send the complete edit again with reset:true.`), { status: 409 })
      }
      const keep = sameRequest
      const all = [...(keep ? proposal.ops : []), ...structuredClone(ops)]
      // Earlier steps go back to the agent's own request, so the route fills their source range
      // again from the project this call's ops would make.
      const queued = [...(keep ? proposal.steps.map(({ path, request, body }) => ({ path, body: request ?? body })) : []), ...structuredClone(steps.map(({ path, body }) => ({ path, body })))]
      if (all.length > MAX_OPS) throw invalid(`A preview holds at most ${MAX_OPS} ops.`)
      if (queued.length > MAX_STEPS) throw invalid(`A preview holds at most ${MAX_STEPS} processing steps.`)
      const text = typeof summary === 'string' ? summary.trim().slice(0, MAX_SUMMARY) : ''
      return { runId, baseVersion: version(), epoch: epoch(), ops: all, steps: queued, assets: { ...(keep ? proposal.assets : {}) }, summaries: [...(keep ? proposal.summaries : []), ...(text ? [text] : [])] }
    },
    /** Stores a preview the route has checked against the current project. */
    stage(next) {
      const replaced = proposal && proposal.runId !== next.runId ? proposal.summaries.join('; ') || `${proposal.ops.length + proposal.steps.length} earlier edits` : proposal?.replaced
      proposal = { ...next, id: randomUUID(), at: now(), ...(replaced ? { replaced } : {}) }
      changed()
      return publicProposal()
    },
    proposal: () => proposal,
    /** Drops the pending preview, or dismisses a finished preview's failure notice. */
    discard(id) {
      if (applying?.finished && applying.id === id) { applying = null; changed(); return true }
      if (!proposal || proposal.id !== id) return false
      proposal = null
      if (applying?.finished) applying = null
      changed()
      return true
    },
    /** The preview leaves the card and its edits start; steps report progress until it finishes. */
    beginApply(next, before) {
      if (proposal?.id === next.id) proposal = null
      applying = { id: next.id, summary: next.summaries.join('; '), before, beforeVersion: version(), epoch: epoch(), foreign: false, finished: false, total: next.steps.length, index: -1, title: '' }
      changed()
    },
    applyProgress(index, title) {
      if (!applying || applying.finished) return
      applying.index = index; applying.title = title
      changed()
    },
    /** Records what the preview changed as one undoable assistant change. A failed step stays visible. */
    finishApply(project, error = '') {
      if (!applying || applying.finished) return publicChange()
      const done = applying
      done.finished = true
      if (version() > done.beforeVersion) {
        change = { id: randomUUID(), kind: 'preview', runId: null, label: 'Applied assistant preview', before: done.before, after: project, beforeVersion: done.beforeVersion, afterVersion: version(), epoch: done.epoch, safe: !done.foreign && epoch() === done.epoch, at: now() }
      }
      if (error) done.error = String(error).slice(0, 600)
      else applying = null
      changed()
      return publicChange()
    },
    /** The change to revert, or a reason it cannot be reverted in one step. */
    undoTarget(id) {
      if (!change || change.id !== id) return { reason: 'That assistant change is no longer the latest one.' }
      const value = publicChange()
      return value.undoable ? { change } : { reason: value.reason }
    },
    undone(id) {
      if (change?.id === id) { change = null; if (applying?.finished) applying = null; changed() }
    },
  }
}
