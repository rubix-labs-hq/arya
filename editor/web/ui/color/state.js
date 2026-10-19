// Color page state shared by the page, the node panel and the viewer overlays: which clip
// is graded, which of its nodes is selected, and the grade a control edits.
//
// Store keys this feature adds: nodeSel { clipId: nodeId }, colorTab, eyedropper
// ('set' | 'add' | null), lastPick, stills [], wipe { id, pos } | null.

import { applyOps, clipEnd, valueAt } from '/core/project.js'
import { set, store, time, viewProject } from '../store.js'
import { graphOf } from './graph.js'

/** Live preview of ops without a server round trip; edit() commits them. */
export function preview(ops) {
  try {
    set({ project: applyOps(store.project, ops).project })
  } catch {}
}

/** The selected visual clip, else the topmost visual clip under the playhead. */
export function gradedClip() {
  const p = viewProject()
  if (!p) return null
  const id = store.selection.find(x => !x.startsWith('tr:'))
  const all = p.tracks.flatMap(t => t.clips)
  const c = all.find(x => x.id === id && x.kind !== 'audio' && x.kind !== 'caption')
  if (c) return c
  for (const t of [...p.tracks].reverse()) {
    if (t.kind !== 'video') continue
    const under = t.clips.find(x => x.start <= time.t && time.t < clipEnd(x) && x.kind !== 'title')
    if (under) return under
  }

  return null
}

/** The clip's selected node id: the remembered one if it still exists, else the primary. */
export function selectedNodeId(clip) {
  const g = graphOf(clip)
  const id = store.nodeSel?.[clip.id]
  if (id && g.list.some(n => n.id === id)) return id

  return (g.list.find(n => n.type === 'primary') ?? g.list.find(n => n.type !== 'source' && n.type !== 'output') ?? g.list[0]).id
}

export function selectedNode(clip) {
  if (!clip) return null
  const id = selectedNodeId(clip)

  return graphOf(clip).list.find(n => n.id === id) ?? null
}

export function selectNode(clip, id) {
  set({ nodeSel: { ...store.nodeSel, [clip.id]: id } })
}

/**
 * What the wheels, sliders, curves, look and LUT edit: the clip's grade for the primary
 * node, a corrector's own grade otherwise. Both ops deep-merge, so null clears a field.
 * Null for nodes without a grade (mixers, key, LUT, blur…).
 */
export function gradeTarget(clip, node) {
  if (!clip) return null
  const composition = store.openComp ?? null
  if (!node || node.type === 'primary') {
    return {
      kind: 'primary',
      key: `${clip.id}:primary`,
      clip,
      node,
      grade: clip.grade ?? {},
      ref: field => ({ kind: 'property', id: `${clip.id}.grade.${field}`, label: `${clip.id} ${field}` }),
      ops: patch => [{ op: 'update', id: clip.id, comp: composition, set: { grade: patch } }],
      replace: grade => [{ op: 'update', id: clip.id, comp: composition, set: { grade: null } }, ...(grade ? [{ op: 'update', id: clip.id, comp: composition, set: { grade: structuredClone(grade) } }] : [])],
      name: `${clip.id} primary`,
    }
  }
  if (node.type !== 'corrector') return null

  return {
    kind: 'node',
    key: `${clip.id}:${node.id}`,
    clip,
    node,
    grade: node.grade ?? {},
    ref: field => ({ kind: 'property', id: `${clip.id}.nodes.${node.id}.grade.${field}`, label: `${clip.id} node ${node.id} ${field}` }),
    ops: patch => [{ op: 'node_update', id: clip.id, comp: composition, node: node.id, set: { grade: patch } }],
    replace: grade => [{ op: 'node_update', id: clip.id, comp: composition, node: node.id, set: { grade: null } }, ...(grade ? [{ op: 'node_update', id: clip.id, comp: composition, node: node.id, set: { grade: structuredClone(grade) } }] : [])],
    name: `${clip.id} node ${node.id}`,
  }
}

/** The ops that change one field of a node (node_update deep-merges `set`). */
export const nodeOps = (clip, node, setPatch) => [{ op: 'node_update', id: clip.id, comp: store.openComp ?? null, node: node.id, set: setPatch }]

/**
 * The clip's source plane on screen at time t: its center, rotation and fitted size in
 * project pixels, and the scale from plane pixels to project pixels. Node graphs (and so
 * power windows) work in this plane, before the clip's transform.
 */
export function clipPlane(p, c, t) {
  const local = t - c.start
  let fw = p.width
  let fh = p.height
  if (c.kind === 'video' || c.kind === 'image') {
    const a = p.assets?.[c.src] ?? {}
    const aw = a.width ?? p.width
    const ah = a.height ?? p.height
    const fit = Math.min(p.width / aw, p.height / ah)
    fw = aw * fit
    fh = ah * fit
  }
  const s = valueAt(p, c, 'scale', local)

  return {
    x: valueAt(p, c, 'x', local),
    y: valueAt(p, c, 'y', local),
    r: valueAt(p, c, 'rotation', local),
    fw,
    fh,
    sx: s * valueAt(p, c, 'scaleX', local),
    sy: s * valueAt(p, c, 'scaleY', local),
  }
}
