// Keyframe selection and the ops that edit selected keys: retime (drag), delete,
// copy and paste, and ease presets through keyframe_ease.
// A key is named by clip, property and clip-local time, never by index: indexes shift
// whenever keys move. Pure: runs in the browser and under node --test.

import { findClip, round, sortedKeys } from '/core/project.js'
import { easeEdits } from './ease.js'

const SEP = '|'
const T = t => round(t, 4)

/** The selection id of a key. */
export const keyId = (clipId, prop, t) => `${clipId}${SEP}${prop}${SEP}${T(t)}`

/** { clipId, prop, t } from a selection id (properties may contain dots, not bars). */
export function parseKey(id) {
  const [clipId, prop, t] = id.split(SEP)

  return { clipId, prop, t: Number(t) }
}

/** The stored key [t, v, ease?] a selection id names, or null. */
export function keyOf(p, id) {
  const { clipId, prop, t } = parseKey(id)
  const clip = findClip(p, clipId)?.clip

  return sortedKeys(clip?.anim?.[prop]).find(k => Math.abs(k[0] - t) < 1e-3) ?? null
}

/** Selected keys grouped by clip and property: Map<clipId, Map<prop, Set<t>>>. */
function grouped(ids) {
  const out = new Map()
  for (const id of ids) {
    const { clipId, prop, t } = parseKey(id)
    if (!out.has(clipId)) out.set(clipId, new Map())
    const props = out.get(clipId)
    if (!props.has(prop)) props.set(prop, new Set())
    props.get(prop).add(t)
  }

  return out
}

const keyOp = (id, prop, t, value, ease) => ({ op: 'keyframe', id, prop, at: t, local: true, value, ...(ease !== undefined ? { ease } : {}) })

/**
 * Ops that move the selected keys by dt seconds, snapped to frames and kept inside
 * their clip. Every moved key is removed first, then written at its new time, so moves
 * that cross other keys stay correct; a key landing on an unselected key replaces it.
 * Returns { ops, selection } with the selection at the new times.
 */
export function retimeOps(p, ids, dt, fps) {
  const ops = []
  const adds = []
  const selection = []
  for (const [clipId, props] of grouped(ids)) {
    const clip = findClip(p, clipId)?.clip
    if (!clip) continue
    for (const [prop, times] of props) {
      for (const k of sortedKeys(clip.anim?.[prop])) {
        if (![...times].some(t => Math.abs(t - k[0]) < 1e-3)) continue
        const nt = T(Math.max(0, Math.min(clip.dur, Math.round((k[0] + dt) * fps) / fps)))
        ops.push({ op: 'keyframe', id: clipId, prop, at: k[0], local: true, remove: true })
        adds.push(keyOp(clipId, prop, nt, k[1], k[2]))
        selection.push(keyId(clipId, prop, nt))
      }
    }
  }

  return { ops: [...ops, ...adds], selection: [...new Set(selection)] }
}

/** Ops that delete the selected keys. */
export function deleteOps(ids) {
  return ids.map(parseKey).map(({ clipId, prop, t }) => ({ op: 'keyframe', id: clipId, prop, at: t, local: true, remove: true }))
}

/**
 * Copies the selected keys: { items: [{ prop, dt, value, ease }] } with dt relative to
 * the earliest key, so a paste lands the first key at the playhead.
 */
export function copyKeys(p, ids) {
  const items = []
  for (const id of ids) {
    const k = keyOf(p, id)
    if (!k) continue
    const { prop, t } = parseKey(id)
    items.push({ prop, t, value: k[1], ease: k[2] })
  }
  if (!items.length) return null
  const t0 = Math.min(...items.map(x => x.t))

  return { items: items.map(({ prop, t, value, ease }) => ({ prop, dt: T(t - t0), value, ease })) }
}

/**
 * Ops that paste copied keys into clip c with the first key at timeline time `at`.
 * When one property was copied and `onto` names another, the keys go there instead.
 */
export function pasteOps(clipboard, c, at, fps, onto) {
  const props = new Set(clipboard.items.map(x => x.prop))
  const ops = []
  const selection = []
  for (const { prop, dt, value, ease } of clipboard.items) {
    const target = props.size === 1 && onto ? onto : prop
    const local = T(Math.max(0, Math.round((at - c.start + dt) * fps) / fps))
    ops.push(keyOp(c.id, target, local, value, ease))
    selection.push(keyId(c.id, target, local))
  }

  return { ops, selection }
}

/**
 * keyframe_ease ops applying an ease preset to the selected keys.
 * mode: 'easy' (F9), 'in' (Shift-F9), 'out' (Cmd-Shift-F9), 'linear', 'hold', or a
 * named ease (core EASES) for the segments leaving the selected keys.
 */
export function easeOps(p, ids, mode) {
  const ops = []
  for (const [clipId, props] of grouped(ids)) {
    const clip = findClip(p, clipId)?.clip
    if (!clip) continue
    for (const [prop, times] of props) {
      const keys = sortedKeys(clip.anim?.[prop])
      const picked = keys.map((k, i) => ([...times].some(t => Math.abs(t - k[0]) < 1e-3) ? i : -1)).filter(i => i >= 0)
      const edits = new Map()
      for (const i of picked) {
        if (mode === 'easy' || mode === 'in' || mode === 'out' || mode === 'linear') {
          // Apply on top of earlier edits so two selected neighbours share one segment.
          const view = keys.map((k, j) => (edits.has(j) ? [k[0], k[1], edits.get(j)] : k))
          for (const e of easeEdits(view, i, mode)) edits.set(e.index, e.ease)
        } else if (i < keys.length - 1 || mode === 'hold') edits.set(i, mode)
      }
      for (const [index, ease] of [...edits].sort((a, b) => a[0] - b[0])) ops.push({ op: 'keyframe_ease', id: clipId, prop, index, ease })
    }
  }

  return ops
}

/** Ops that set one key's value (for a drag in the value graph). Its time and ease stay. */
export function setKeyValueOps(p, id, value) {
  const k = keyOf(p, id)
  if (!k) return []
  const { clipId, prop } = parseKey(id)

  return [keyOp(clipId, prop, k[0], value, k[2])]
}

/** Every key of the given clips as selection ids, for select-all and box selection. */
export function allKeyIds(clips, props) {
  const out = []
  for (const c of clips) for (const [prop, keys] of Object.entries(c.anim ?? {})) if (!props || props.includes(prop)) for (const k of keys) out.push(keyId(c.id, prop, k[0]))

  return out
}
