// Live drags: while a drag runs, its ops are applied to a copy of the project the drag
// started from (the viewer redraws, nothing is saved); on release the original comes
// back and the ops go through edit() once, so the server and undo see one change.

import { applyOps } from '/core/project.js'
import { edit, set, store } from '../store.js'

let base = null

/** Shows ops applied to the project as it was when the drag began. */
export function preview(ops) {
  base ??= store.project
  try {
    set({ project: applyOps(base, scope(ops)).project })
  } catch {
    // An op that does not apply mid-drag shows nothing new; the release reports errors.
  }
}

/** Puts the pre-drag project back and commits ops through edit(). */
export function commit(ops, summary) {
  if (base) set({ project: base })
  base = null

  return ops?.length ? edit(ops, summary) : null
}

/** Ends a drag without saving anything. */
export function cancel() {
  if (base) set({ project: base })
  base = null
}

// edit() scopes ops to the open composition; the preview has to do the same.
function scope(ops) {
  if (!store.openComp) return ops

  return ops.map(op => (op.comp || op.id || op.ids || op.target ? op : { ...op, comp: store.openComp }))
}
