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

const MAX_CHANGES = 30
// The label of a request that only made edits. A card titles it by its count of edits.
export const REQUEST_LABEL = 'Assistant request'
const plural = (count, one) => `${count} ${one}${count === 1 ? '' : 's'}`

// A run that ended behind where it started, or whose own commits were all Undo or Redo, moved
// through history. Its change is named for that move, so a card never calls an undo an edit.
function historyLabel({ undo, redo }) {
  return redo === 0 ? `Undid ${plural(undo, 'edit')}` : undo === 0 ? `Redid ${plural(redo, 'edit')}` : 'Moved through the undo history'
}

// A request that made edits and also called Undo or Redo, but did not end behind its start, is
// named for each kind of step, so an undo is never counted as an edit.
function mixedLabel({ edit, undo, redo }) {
  const parts = [`Made ${plural(edit, 'edit')}`, ...(undo ? [`undid ${undo}`] : []), ...(redo ? [`redid ${redo}`] : [])]
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]
}

/**
 * `redoDepth(project)` is how many Redo moves from the current project end on `project`, or 0 when
 * Redo never reaches it. Without it a history change cannot be reversed from its card.
 */
export function createAssistantReview({ getVersion, getEpoch, getProject, redoDepth = () => 0, onChange = () => {}, onRestore = () => {}, now = Date.now } = {}) {
  let run = null, change = null, proposal = null, applying = null
  // Every recent change in order, with whether it is undone now, so older cards keep their name and
  // state. Undo and Redo restore the same project objects, so a change is undone while the project
  // is the one from before it and applied again when Redo returns to the one after it, whoever moved.
  const changes = []
  let published = null
  const version = () => getVersion(), epoch = () => getEpoch()
  const remember = next => { changes.push(next); if (changes.length > MAX_CHANGES) changes.shift() }
  const publicChange = () => {
    if (!change) return null
    // Undo and redo restore the same project objects, so identity survives a round trip.
    const current = getProject() === change.after && epoch() === change.epoch
    // A run that undid edits is reversed by Redo, and only when Redo leads exactly back.
    const history = change.kind === 'history', back = history && change.moves.redo === 0
    const depth = back ? redoDepth(change.before) : 0, redoable = back && depth === change.moves.undo
    const changedProject = 'The project changed after this assistant change. Use Undo step by step.'
    const reason = !change.safe ? 'You or another tool edited the project while the assistant change was being made. Use Undo step by step.'
      : back && !redoable ? depth > 0 ? 'Use Redo in the toolbar to bring back the edits the assistant undid.' : changedProject
      : history && !back ? 'Use Undo and Redo in the toolbar to move through these steps.'
      : !current ? changedProject
      : change.before === change.after ? 'This change left the project as it was before.' : ''
    return { id: change.id, kind: change.kind, runId: change.runId, label: change.label, ...(change.moves ? { moves: { ...change.moves } } : {}), beforeVersion: change.beforeVersion, afterVersion: change.afterVersion, edits: change.afterVersion - change.beforeVersion, at: change.at, undoable: !reason, reason }
  }
  const publicProposal = () => proposal && { id: proposal.id, runId: proposal.runId, replaced: proposal.replaced ?? '', baseVersion: proposal.baseVersion, ops: proposal.ops, steps: proposal.steps.map(({ path, body, preview }) => ({ path, body, preview })), assets: proposal.assets ?? {}, summary: proposal.summaries.join('; '), at: proposal.at, stale: version() !== proposal.baseVersion || epoch() !== proposal.epoch }
  const publicApplying = () => applying && { id: applying.id, summary: applying.summary, total: applying.total, index: applying.index, title: applying.title, finished: applying.finished, error: applying.error ?? '' }
  const publicChanges = () => changes.map(item => ({ id: item.id, kind: item.kind, runId: item.runId, label: item.label, beforeVersion: item.beforeVersion, afterVersion: item.afterVersion, undone: item.undone === true }))
  const snapshot = () => ({ change: publicChange(), changes: publicChanges(), proposal: publicProposal(), applying: publicApplying(), running: !!run && !run.finished, runId: run?.runId ?? null })
  const publication = () => JSON.stringify([publicChange(), publicChanges()])
  const changed = () => { published = publication(); try { onChange(snapshot()) } catch { /* A failed notification does not undo state. */ } }
  // Follows the project to each change's before or after, and returns the changes this commit
  // brought back. A replaced project can never hold a change's projects again, so that change
  // keeps its state for good.
  const follow = () => {
    const project = getProject(), back = []
    for (const item of changes) {
      if (item.forgotten || item.before === item.after) continue
      if (epoch() !== item.epoch) item.forgotten = true
      else if (project === item.after) { if (item.undone) back.push(item); item.undone = false }
      else if (project === item.before) item.undone = true
    }
    return back
  }

  return {
    snapshot,
    /** Every assistant state publication passes through here with the project it saw. */
    observe(state, project) {
      if (!state?.runId) return
      if (ACTIVE.has(state.state) && run?.runId !== state.runId) {
        run = { runId: state.runId, before: project, beforeVersion: version(), epoch: epoch(), foreign: false, finished: false, moves: { undo: 0, redo: 0, edit: 0 } }
        if (applying?.finished) applying = null
        changed()
      } else if (TERMINAL.has(state.state) && run?.runId === state.runId && !run.finished) {
        run.finished = true
        const edits = version() - run.beforeVersion
        // A run that ends behind where it started is undone by as many Redo moves, whatever it did between.
        const { moves } = run, depth = edits > 0 ? redoDepth(run.before) : 0
        const steps = depth > 0 ? { undo: depth, redo: 0 } : moves.edit === 0 && moves.undo + moves.redo > 0 ? { undo: moves.undo, redo: moves.redo } : null
        const mixed = !steps && moves.edit > 0 && moves.undo + moves.redo > 0
        if (edits > 0) {
          change = { id: randomUUID(), kind: steps ? 'history' : 'request', runId: run.runId, label: steps ? historyLabel(steps) : mixed ? mixedLabel(moves) : REQUEST_LABEL, ...(steps ? { moves: steps } : mixed ? { moves: { ...moves } } : {}),
            before: run.before, after: project, beforeVersion: run.beforeVersion, afterVersion: version(), epoch: run.epoch, safe: !run.foreign && epoch() === run.epoch, at: now() }
          remember(change)
        }
        changed()
      }
    },
    /**
     * Every commit reports its owner: the request's run, a preview apply, or nobody (the user or a
     * background job). `move` is 'undo' or 'redo' for a step through the undo history.
     */
    commitBy(call, move = null) {
      if (run && !run.finished && call?.runId !== run.runId) run.foreign = true
      else if (run && !run.finished) run.moves[move === 'undo' || move === 'redo' ? move : 'edit']++
      if (applying && !applying.finished && call?.applyId !== applying.id) applying.foreign = true
      const back = follow()
      // Redo restored a change that was undone, while no newer change is in effect: it is the latest one again.
      const restored = !change || change.undone ? back.at(-1) : null
      if (restored) {
        change = restored
        changed()
        try { onRestore(change) } catch { /* A failed notification does not undo state. */ }
        return
      }
      // Whether the latest change can still be undone in one step, and which changes are undone, follow every commit.
      if (publication() !== published) changed()
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
      // The summaries join into the title the user reads, so a summary the preview already has is not added again.
      const held = keep ? proposal.summaries : []
      return { runId, baseVersion: version(), epoch: epoch(), ops: all, steps: queued, assets: { ...(keep ? proposal.assets : {}) }, summaries: [...held, ...(text && !held.includes(text) ? [text] : [])] }
    },
    /** Stores a preview the route has checked against the current project. */
    stage(next) {
      const replaced = proposal && proposal.runId !== next.runId ? proposal.summaries.join('; ') || `${proposal.ops.length + proposal.steps.length} earlier edits` : proposal?.replaced
      proposal = { ...next, id: randomUUID(), at: now(), ...(replaced ? { replaced } : {}) }
      changed()
      return publicProposal()
    },
    proposal: () => proposal,
    /**
     * The project the run's own pending preview would make, built in memory by `apply`
     * (core applyOps) and never saved. Null when that run has no ops waiting, so a frame then
     * shows the saved project. Another run's preview is never shown. A preview made from an
     * older project is refused when `strict` (a Preview changes request, which cannot edit the
     * project itself), and otherwise counts as no preview.
     */
    trial(runId, apply, { strict = true } = {}) {
      if (!runId || !proposal || proposal.runId !== runId || !proposal.ops.length) return null
      const stale = proposal.baseVersion !== version() || proposal.epoch !== epoch()
      if (stale && !strict) return null
      if (stale) throw Object.assign(new Error('The project changed after this preview was made, so a frame of the preview cannot be drawn. Read the outline, propose again, then ask for the frame.'), { status: 409 })
      const imports = Object.keys(proposal.assets ?? {}).length ? [{ op: 'import', assets: proposal.assets }] : []
      return apply(getProject(), [...imports, ...proposal.ops]).project
    },
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
        remember(change)
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
      const item = changes.find(entry => entry.id === id)
      if (item) item.undone = true
      if (change?.id === id) { change = null; if (applying?.finished) applying = null }
      if (item) changed()
    },
  }
}
