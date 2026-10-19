// Op builders for the Motion page that need no DOM: writing a property, finding a
// free layer track, layer order, solo, and duplicating a composition.
// Pure: runs in the browser and under node --test.

import { clipEnd, compDuration, round } from '/core/project.js'
import { parse as parseExpression } from '/core/expr.js'

/** A keyframe at timeline time t when the property is animated, else a plain update. */
export function setValueOp(c, prop, value, t) {
  if (c.anim?.[prop]?.length) return { op: 'keyframe', id: c.id, prop, at: t, value }
  const parts = prop.split('.')
  if (parts[0] === 'mask') return { op: 'update_mask', id: c.id, mask: parts[1], set: nestedSet(parts.slice(2), value) }

  return { op: 'update', id: c.id, set: nestedSet(parts, value) }
}

/** { a: { b: value } } for the path ['a', 'b']. */
export const nestedSet = (parts, value) => parts.reduceRight((acc, k) => ({ [k]: acc }), value)

/**
 * Scopes an op to the view's composition. The store scopes ops without an id, but an op
 * naming a track by id (update_track) would otherwise land on the main timeline.
 */
export const inView = (view, op) => (view.compId && !op.comp ? { ...op, comp: view.compId } : op)

/** Layers of a timeline view, top to bottom: tracks from the top, clips by start within a track. */
export function layerRows(view) {
  const video = view.tracks.filter(t => t.kind === 'video').reverse()

  return video.flatMap(track => [...track.clips].sort((a, b) => a.start - b.start).map(clip => ({ track, clip })))
}

/**
 * Where a new layer spanning [start, start + dur) goes: the top video track when it is
 * free there, else a new track on top. Returns { ops, track } (ops add the track).
 */
export function layerTrack(view, start, dur) {
  const video = view.tracks.filter(t => t.kind === 'video')
  const top = video.at(-1)
  const free = top && !top.locked && !top.clips.some(c => c.start < start + dur - 1e-6 && clipEnd(c) > start + 1e-6)
  if (free) return { ops: [], track: top.id }
  let n = 1
  while (view.tracks.some(t => t.id === `V${n}`)) n++

  return { ops: [inView(view, { op: 'add_track', kind: 'video', name: `Layer ${video.length + 1}` })], track: `V${n}` }
}

/** The time span a new layer covers: the whole composition, or 5 s at the playhead on the main timeline. */
export function newLayerSpan(view, t) {
  if (view.compId) {
    const comp = view.comps?.[view.compId]

    return { start: 0, dur: compDuration(comp) }
  }

  return { start: round(Math.max(0, t), 4), dur: 5 }
}

/**
 * Solo for layers. The renderer has no per-clip solo, so soloing hides the tracks that
 * hold no soloed layer and marks them `soloHidden`; clearing the last solo unhides
 * exactly those tracks. Returns the ops that toggle `clipId`.
 */
export function soloOps(view, clipId) {
  const clips = view.tracks.flatMap(t => t.clips)
  const target = clips.find(c => c.id === clipId)
  if (!target) return []
  const on = !target.solo
  const soloed = new Set(clips.filter(c => (c.id === clipId ? on : c.solo)).map(c => c.id))
  const ops = [{ op: 'update', id: clipId, set: { solo: on ? true : null } }]
  for (const track of view.tracks) {
    if (track.kind !== 'video') continue
    const keep = soloed.size === 0 || track.clips.some(c => soloed.has(c.id))
    if (keep && track.soloHidden) ops.push(inView(view, { op: 'update_track', id: track.id, set: { hidden: null, soloHidden: null } }))
    else if (!keep && !track.hidden) ops.push(inView(view, { op: 'update_track', id: track.id, set: { hidden: true, soloHidden: true } }))
  }

  return ops
}

/** The highest numbered clip id in the project (the next one is c<max + 1>), as core nextId counts. */
export function maxClipNumber(p) {
  let max = 0
  const scan = id => {
    if (typeof id === 'string' && id.startsWith('c')) {
      const n = Number(id.slice(1))
      if (Number.isFinite(n)) max = Math.max(max, n)
    }
  }
  for (const t of [...p.tracks, ...Object.values(p.comps ?? {}).flatMap(k => k.tracks ?? [])]) {
    for (const c of t.clips) {
      scan(c.id)
      for (const m of c.masks ?? []) scan(m.id)
      for (const n of c.nodes?.list ?? []) scan(n.id)
    }
  }
  for (const m of [...(p.__rootMarkers ?? p.markers ?? []), ...(p.markers ?? []), ...Object.values(p.comps ?? {}).flatMap(c => c.markers ?? [])]) scan(m.id)
  for (const k of Object.keys(p.comps ?? {})) scan(k)

  return max
}

/** The id core nextId gives the next composition. */
export function nextCompId(p) {
  let max = 0
  const scan = id => {
    if (typeof id === 'string' && id.startsWith('k')) {
      const n = Number(id.slice(1))
      if (Number.isFinite(n)) max = Math.max(max, n)
    }
  }
  for (const t of [...p.tracks, ...Object.values(p.comps ?? {}).flatMap(k => k.tracks ?? [])]) for (const c of t.clips) scan(c.id)
  for (const m of [...(p.__rootMarkers ?? p.markers ?? []), ...(p.markers ?? []), ...Object.values(p.comps ?? {}).flatMap(c => c.markers ?? [])]) scan(m.id)
  for (const k of Object.keys(p.comps ?? {})) scan(k)

  return `k${max + 1}`
}

/**
 * Ops that copy composition `id` into a new one named `name`. Pasted clips get new
 * ids in order. Internal layer references and sync links follow the copies.
 * Nested composition clips continue to reference their existing compositions.
 */
export function duplicateCompOps(p, id, name) {
  const src = p.comps?.[id]
  if (!src) throw new Error(`no composition ${id}`)
  const newId = nextCompId(p)
  const ops = [{ op: 'add_comp', name: name ?? `${src.name} copy`, width: src.width, height: src.height, fps: src.fps, ...(src.duration ? { duration: src.duration } : {}), background: src.background ?? 'transparent' }]
  const { id: _id, name: _name, tracks: _tracks, markers: _markers, ...settings } = src
  ops.push({ op: 'update_comp', target: newId, set: structuredClone(settings) })
  if (src.markers?.length) ops.push({ op: 'markers', comp: newId, markers: src.markers.map(({ id: _id, ...marker }) => structuredClone(marker)) })
  // add_comp makes V1 V2 V3 and A1; map the source tracks onto them by kind and order.
  const made = { video: ['V1', 'V2', 'V3'], audio: ['A1'], caption: [] }
  const trackIds = new Set(Object.values(made).flat())
  const map = new Map()
  const counters = { video: 0, audio: 0, caption: 0 }
  for (const track of src.tracks) {
    const kind = track.kind
    const i = counters[kind]++
    if (i >= made[kind].length) {
      const prefix = kind === 'audio' ? 'A' : 'V'
      let n = 1
      while (trackIds.has(`${prefix}${n}`)) n++
      made[kind].push(`${prefix}${n}`)
      trackIds.add(`${prefix}${n}`)
      ops.push({ op: 'add_track', comp: newId, kind })
    }
    map.set(track.id, made[kind][i])
  }
  // Paste every clip in one op; the k-th pasted clip becomes c<max + k>.
  let next = maxClipNumber(p)
  const items = []
  const ids = new Map()
  for (const track of src.tracks) {
    for (const clip of track.clips) ids.set(clip.id, `c${++next}`)
  }
  const links = new Map()
  for (const track of src.tracks) {
    for (const clip of track.clips) {
      const copy = structuredClone(clip)
      if (copy.parent) copy.parent = ids.get(copy.parent) ?? undefined
      if (copy.matte?.source) copy.matte.source = ids.get(copy.matte.source) ?? copy.matte.source
      if (copy.parent === undefined) {
        delete copy.parent
        delete copy.parentRef
      }
      if (copy.source?.clip && ids.has(copy.source.clip)) copy.source.clip = ids.get(copy.source.clip)
      if (copy.expr) copy.expr = Object.fromEntries(Object.entries(copy.expr).map(([property, expression]) => [property, copiedExpression(expression, ids)]))
      if (clip.link) {
        if (!links.has(clip.link)) links.set(clip.link, [])
        links.get(clip.link).push(ids.get(clip.id))
      }
      items.push({ track: map.get(track.id), clip: copy, offset: clip.start })
    }
  }
  if (items.length) ops.push({ op: 'paste', comp: newId, at: 0, clips: items })
  // paste removes old links. Rebuild each copied sync group before locking tracks.
  for (const group of links.values()) if (group.length > 1) ops.push({ op: 'link', comp: newId, ids: group })
  // Track settings last: paste skips locked tracks.
  for (const track of src.tracks) {
    const { id: _id, kind: _kind, clips: _clips, ...settings } = track
    ops.push({ op: 'update_track', comp: newId, id: map.get(track.id), set: structuredClone(settings) })
  }

  return { ops, id: newId, ids }
}

function copiedExpression(expression, ids) {
  const tree = parseExpression(expression)
  const strings = []
  const replacements = new Map()
  const names = node => {
    if (node?.k === 'str' && ids.has(node.v)) replacements.set(node, ids.get(node.v))
    else if (node?.k === 'cond') { names(node.a); names(node.b) }
  }
  const visit = node => {
    if (node.k === 'str') strings.push(node)
    else if (node.k === 'bin') { visit(node.left); visit(node.right) }
    else if (node.k === 'un') visit(node.arg)
    else if (node.k === 'cond') { visit(node.test); visit(node.a); visit(node.b) }
    else if (node.k === 'member') visit(node.obj)
    else if (node.k === 'call') {
      if (node.name === 'layer') names(node.args[0])
      node.args.forEach(visit)
    }
  }
  visit(tree)
  // The expression grammar has raw quoted strings and no escapes. Keep all other
  // source bytes, including parentheses and numeric spelling, within its length cap.
  let index = 0
  const copied = expression.replace(/(["'])([\s\S]*?)\1/g, (literal, quote) => {
    const node = strings[index++]
    return replacements.has(node) ? `${quote}${replacements.get(node)}${quote}` : literal
  })
  parseExpression(copied)
  return copied
}

/** Composition clips (anywhere) that place composition `id`. */
export function compUsers(p, id) {
  return [...p.tracks, ...Object.values(p.comps ?? {}).flatMap(k => k.tracks ?? [])].flatMap(t => t.clips).filter(c => c.kind === 'comp' && c.comp === id)
}
