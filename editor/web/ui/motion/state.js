// Motion page UI state, kept in the editor store under `store.motion` so every panel
// (layer timeline, graph editor, viewer tools) reads one source.

import { edit, set, store, toast } from '../store.js'

export const MOTION_TOOLS = ['m-shape', 'm-pen', 'm-mask', 'm-anchor']

const DEFAULT = {
  keySel: [], // selected keyframes, ids from keyframes.js keyId
  open: {}, // clipId → layer twirled open
  groups: {}, // `${clipId}:${groupId}` → group twirled open (Transform defaults open)
  reveal: null, // { props: [...] } shows only these properties (P, S, R, T, A, U)
  graph: false, // graph editor instead of keyframe rows
  graphMode: 'value', // value | speed
  graphProps: [], // `${clipId}|${prop}` shown in the graph editor
  exprOpen: {}, // `${clipId}|${prop}` → expression field shown
  zoom: 0, // px per second in the layer timeline (0 = fit)
  scroll: 0, // seconds at the left edge
  shapeKind: 'rect', // rect | ellipse | polygon | star
  maskKind: 'rect', // rect | ellipse | path
  fill: '#f5b942',
  fillOn: true,
  stroke: '#ffffff',
  strokeWidth: 0,
  sides: 6,
  points: 5,
  keyClipboard: null,
  lastCopy: null, // 'keys' | 'clips'
  leftTab: 'comps',
}

export function ms() {
  if (!store.motion) store.motion = structuredClone(DEFAULT)

  return store.motion
}

export function mset(patch) {
  set({ motion: { ...ms(), ...(typeof patch === 'function' ? patch(ms()) : patch) } })
}

/** Edits and reports what the server said went wrong; resolves the server's answer. */
export async function run(ops, summary) {
  if (!ops?.length) return null

  return edit(ops, summary)
}

/** Runs a builder that may throw (a preset that does not fit, say) and shows the reason. */
export function attempt(fn) {
  try {
    return fn()
  } catch (error) {
    toast(error.message, 'error')

    return null
  }
}

export const isMotionTool = tool => MOTION_TOOLS.includes(tool)
