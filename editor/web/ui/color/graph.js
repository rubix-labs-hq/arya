// Node graph logic for the Color page: numbering, layout, the ops behind every node
// panel action, presets, qualifier (eyedropper) math and power-window geometry.
// No DOM and no preact here, so `node --test` runs it against applyOps and nodeOrder.
// The relative import resolves to /core/project.js in the browser (URLs clamp at /).

import { applyOps, defaultNodes, findClip, layoutNodes, NODE_COL, NODE_ROW, nodeOrder } from '../../../core/project.js'

// ---------------------------------------------------------------- graph basics

/** Node box size and layout grid, in graph units (node x, y are the box's top-left). */
export const NODE_W = 112
export const NODE_H = 56
export const COL = NODE_COL
export const ROW = NODE_ROW

export const TYPE_LABEL = {
  source: 'Input',
  primary: 'Primary',
  corrector: 'Corrector',
  parallel: 'Parallel',
  layerMixer: 'Layer',
  key: 'Key',
  lut: 'LUT',
  blur: 'Blur',
  sharpen: 'Sharpen',
  glow: 'Glow',
  output: 'Output',
}

/** Node types the panel can add on their own (serially, after the selected node). */
export const ADDABLE = ['corrector', 'key', 'lut', 'blur', 'sharpen', 'glow']

export const MULTI_INPUT = new Set(['parallel', 'layerMixer'])

/** Parameters a fresh node of each type starts with (the renderer's own defaults). */
export const NODE_DEFAULTS = {
  corrector: {},
  key: { color: '#00ff00', similarity: 0.4, smoothness: 0.08, spill: 0.5 },
  lut: { mix: 1 },
  blur: { radius: 8 },
  sharpen: { amount: 0.5 },
  glow: { amount: 0.5, threshold: 0.7, radius: 12 },
}

/** The graph a clip renders through: its own, or the implicit source → primary → output. */
export function graphOf(clip) {
  return clip?.nodes ?? defaultNodes()
}

const idNum = id => Number(String(id).slice(1)) || 0

/** Ids node_add will hand out next (it numbers n<max+1>, n<max+2>, …). */
export function nextIds(graph, count = 1) {
  const max = Math.max(0, ...graph.list.map(n => idNum(n.id)))

  return Array.from({ length: count }, (_, i) => `n${max + 1 + i}`)
}

/** Resolve-style node numbers: 01, 02, … in creation order; Input and Output have none. */
export function nodeNumbers(graph) {
  const nums = new Map()
  const numbered = graph.list.filter(n => n.type !== 'source' && n.type !== 'output').sort((a, b) => idNum(a.id) - idNum(b.id))
  numbered.forEach((n, i) => nums.set(n.id, String(i + 1).padStart(2, '0')))

  return nums
}

export function nodeTitle(n) {
  return n.label || TYPE_LABEL[n.type] || n.type
}

/** The node feeding `id` at `input`, or undefined. */
export function feedOf(graph, id, input = 0) {
  return graph.links.find(l => l.to === id && (l.input ?? 0) === input)?.from
}

/** Input sockets a node shows: none for the source, one free extra slot on mixers. */
export function inputSlots(graph, n) {
  if (n.type === 'source') return 0
  if (!MULTI_INPUT.has(n.type)) return 1
  const used = graph.links.filter(l => l.to === n.id).map(l => l.input ?? 0)

  return Math.max(2, used.length ? Math.max(...used) + 2 : 2)
}

/** Nodes the output can reach (the ones that render); the rest draw dimmed. */
export function liveNodes(graph) {
  try {
    return new Set(nodeOrder(graph).map(n => n.id))
  } catch {
    return new Set()
  }
}

/** Where a new serial or parallel node goes for selection `sel`: never after the output. */
export function insertAfter(graph, sel) {
  const n = graph.list.find(x => x.id === sel)
  const out = graph.list.find(x => x.type === 'output')
  if (!n || n.type === 'output') return feedOf(graph, out.id) ?? graph.list.find(x => x.type === 'source')?.id

  return n.id
}

// ---------------------------------------------------------------- layout

/** The tidy left-to-right layout (the core's, which node_add also applies). Returns Map id → { x, y }. */
export function layoutGraph(graph) {
  return layoutNodes(graph)
}

/** Ops that move every node of the clip's graph (after `ops`) to the tidy layout. */
export function layoutOps(project, clipId, ops = []) {
  const after = ops.length ? applyOps(project, ops).project : project
  const clip = findClip(after, clipId)?.clip
  if (!clip?.nodes) return []
  const pos = layoutGraph(clip.nodes)

  return clip.nodes.list
    .filter(n => pos.get(n.id).x !== n.x || pos.get(n.id).y !== n.y)
    .map(n => ({ op: 'node_update', id: clipId, node: n.id, set: pos.get(n.id) }))
}

/** `ops` followed by the layout fix-up, as one batch (one undo step). */
export function withLayout(project, clipId, ops) {
  return [...ops, ...layoutOps(project, clipId, ops)]
}

// ---------------------------------------------------------------- the panel's actions as ops

/** A clip without `nodes` renders the default graph; edits that name its nodes need it stored first. */
export function ensureGraph(clip) {
  return clip.nodes ? [] : [{ op: 'update', id: clip.id, set: { nodes: defaultNodes() } }]
}

/** Add Serial Node (Alt-S): a node of `type` after the selection. */
export function planSerial(project, clip, sel, type = 'corrector') {
  const g = graphOf(clip)
  const [id] = nextIds(g)
  const ops = [{ op: 'node_add', id: clip.id, node: { type, ...structuredClone(NODE_DEFAULTS[type] ?? {}) }, after: insertAfter(g, sel) }]

  return { ops: withLayout(project, clip.id, ops), select: id }
}

/**
 * Add Parallel Node (Alt-P) or Add Layer Node (Alt-L): a mixer after the selection and
 * a new corrector fed from the selection's own input, wired into the mixer's input 1.
 */
export function planBranch(project, clip, sel, mixer = 'parallel') {
  const g = graphOf(clip)
  const after = insertAfter(g, sel)
  const [mix, branch] = nextIds(g, 2)
  const ops = [
    { op: 'node_add', id: clip.id, node: mixer === 'layerMixer' ? { type: 'layerMixer', blends: ['normal', 'normal'] } : { type: 'parallel' }, after },
    { op: 'node_add', id: clip.id, node: { type: 'corrector' }, after, parallel: true },
    { op: 'node_link', id: clip.id, from: branch, to: mix, input: 1 },
  ]

  return { ops: withLayout(project, clip.id, ops), select: branch }
}

export function planDelete(clip, nodeId) {
  const n = graphOf(clip).list.find(x => x.id === nodeId)
  if (!n || n.type === 'source' || n.type === 'output') return null

  return [{ op: 'node_delete', id: clip.id, node: nodeId }]
}

/** Cmd-D: bypass a node (`enabled: false`) or turn it back on (the key goes away). */
export function planBypass(clip, nodeId) {
  const n = graphOf(clip).list.find(x => x.id === nodeId)
  if (!n || n.type === 'source' || n.type === 'output') return null

  return [...ensureGraph(clip), { op: 'node_update', id: clip.id, node: nodeId, set: { enabled: n.enabled === false ? null : false } }]
}

export function planLink(clip, from, to, input = 0) {
  return [...ensureGraph(clip), { op: 'node_link', id: clip.id, from, to, input }]
}

/** Moves a link's end: unlink the old input, link the new one. */
export function planRelink(clip, from, oldTo, oldInput, to, input) {
  return [...ensureGraph(clip), { op: 'node_unlink', id: clip.id, to: oldTo, input: oldInput }, { op: 'node_link', id: clip.id, from, to, input }]
}

export function planUnlink(clip, to, input = 0) {
  return [...ensureGraph(clip), { op: 'node_unlink', id: clip.id, to, input }]
}

/** Dragged positions { id: { x, y } } as node_update ops. */
export function planMove(clip, positions) {
  return [...ensureGraph(clip), ...Object.entries(positions).map(([node, p]) => ({ op: 'node_update', id: clip.id, node, set: { x: Math.round(p.x), y: Math.round(p.y) } }))]
}

export function planRename(clip, nodeId, label) {
  return [...ensureGraph(clip), { op: 'node_update', id: clip.id, node: nodeId, set: { label: label.trim() || null } }]
}

// ---------------------------------------------------------------- presets

/** Throws unless `graph` is a renderable node graph (one output, acyclic, links between known nodes). */
export function checkGraph(graph) {
  if (!graph || !Array.isArray(graph.list) || !Array.isArray(graph.links)) throw new Error('a node graph needs list and links')
  const ids = new Set(graph.list.map(n => n.id))
  if (ids.size !== graph.list.length) throw new Error('node ids repeat')
  if (graph.list.filter(n => n.type === 'output').length !== 1) throw new Error('a node graph needs exactly one output')
  for (const l of graph.links) if (!ids.has(l.from) || !ids.has(l.to)) throw new Error(`link ${l.from} → ${l.to} names a missing node`)
  nodeOrder(graph)

  return graph
}

/** A copy of the clip's graph and primary grade, ready to store as a preset. */
export function presetFromClip(clip, name) {
  const nodes = structuredClone(graphOf(clip))
  for (const n of nodes.list) if (n.qualifier) delete n.qualifier.show

  return { name, nodes, grade: clip.grade ? structuredClone(clip.grade) : null }
}

/**
 * Ops that put a preset on a clip: its graph replaces the clip's (one `update`, which
 * swaps the list and links arrays), laid out when the preset has no positions, and,
 * when the preset carries one (`grade` key present), its primary grade replaces the clip's.
 */
export function planPreset(clip, preset) {
  const nodes = checkGraph(structuredClone(preset.nodes))
  if (nodes.list.some(n => n.x === undefined || n.y === undefined)) {
    const pos = layoutGraph(nodes)
    for (const n of nodes.list) Object.assign(n, pos.get(n.id))
  }
  const ops = [{ op: 'update', id: clip.id, set: { nodes } }]
  if ('grade' in preset) ops.push({ op: 'update', id: clip.id, set: { grade: null } }, ...(preset.grade ? [{ op: 'update', id: clip.id, set: { grade: preset.grade } }] : []))

  return ops
}

// ---------------------------------------------------------------- qualifier (eyedropper)

const clamp01 = v => Math.max(0, Math.min(1, v))
const r3 = v => Math.round(v * 1000) / 1000

/** RGB (0…1) → [hue 0…360, saturation, lightness], the same HSL the shader keys on. */
export function rgbToHsl([r, g, b]) {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  const d = mx - mn
  let h = 0
  let s = 0
  if (d > 1e-5) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }

  return [h, s, l]
}

/** Below this saturation a pixel's hue means nothing: the pick keeps every hue. */
export const NEUTRAL_SAT = 0.08

export const FULL_QUALIFIER = { hue: [0, 360], sat: [0, 1], lum: [0, 1], soft: 0.05 }

/** Qualifier ranges centred on a sampled colour (RGB 0…1). */
export function qualifierAround(rgb, { hueHalf = 18, satHalf = 0.2, lumHalf = 0.18, soft = 0.05 } = {}) {
  const [h, s, l] = rgbToHsl(rgb)
  const hue = s < NEUTRAL_SAT ? [0, 360] : [r3((h - hueHalf + 360) % 360), r3((h + hueHalf) % 360)]

  return { hue, sat: [r3(clamp01(s - satHalf)), r3(clamp01(s + satHalf))], lum: [r3(clamp01(l - lumHalf)), r3(clamp01(l + lumHalf))], soft }
}

const arcLen = (lo, hi) => (hi - lo + 360) % 360 || (hi === lo ? 0 : 360)

/** Shift-click with the eyedropper: widen the ranges just enough to take in another sample. */
export function expandQualifier(q, rgb, margin = { hue: 6, sat: 0.05, lum: 0.05 }) {
  const [h, s, l] = rgbToHsl(rgb)
  const out = structuredClone({ ...FULL_QUALIFIER, ...q })
  out.sat = [r3(clamp01(Math.min(out.sat[0], s - margin.sat))), r3(clamp01(Math.max(out.sat[1], s + margin.sat)))]
  out.lum = [r3(clamp01(Math.min(out.lum[0], l - margin.lum))), r3(clamp01(Math.max(out.lum[1], l + margin.lum)))]
  const [lo, hi] = out.hue
  const full = lo === 0 && hi === 360
  if (!full && s >= NEUTRAL_SAT && !inHueArc(h, lo, hi)) {
    // Grow whichever end is closer, going around the wheel.
    const growHi = (h - hi + 360) % 360
    const growLo = (lo - h + 360) % 360
    if (arcLen(lo, hi) + Math.min(growHi, growLo) + margin.hue >= 360) out.hue = [0, 360]
    else if (growHi <= growLo) out.hue = [lo, r3((h + margin.hue) % 360)]
    else out.hue = [r3((h - margin.hue + 360) % 360), hi]
  }

  return out
}

/** True when hue `h` lies on the arc from lo clockwise to hi (hi < lo wraps through 0). */
export function inHueArc(h, lo, hi) {
  if (lo === 0 && hi === 360) return true

  return hi >= lo ? h >= lo && h <= hi : h >= lo || h <= hi
}

const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a || 1e-9))

  return t * t * (3 - 2 * t)
}

/** The matte (0…1) the shader's qualifier gives a pixel; mirrors compositor.js. */
export function qualifierMatte(rgb, q) {
  const [h, s, l] = rgbToHsl(rgb.map(clamp01))
  const soft = q.soft ?? 0.05
  const band = (x, [lo, hi]) => smoothstep(lo - soft, lo, x) * (1 - smoothstep(hi, hi + soft, x))
  const hueSoft = soft * 360
  let [lo, hi] = q.hue ?? [0, 360]
  if (hi < lo) hi += 360
  const hh = h < lo - hueSoft ? h + 360 : h
  const hb = smoothstep(lo - hueSoft, lo, hh) * (1 - smoothstep(hi, hi + hueSoft, hh))
  const m = hb * band(s, q.sat ?? [0, 1]) * band(l, q.lum ?? [0, 1])

  return q.invert ? 1 - m : m
}

// ---------------------------------------------------------------- power windows

/** A new window of `type`, with every field written so the overlay and the shader agree. */
export function defaultWindow(type = 'circle') {
  if (type === 'linear') return { type, x: 0.5, y: 0.5, w: 1, h: 0.5, rotation: 0, softness: 0.3, invert: false }

  return { type, x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, softness: 0.15, invert: false }
}

export const fullWindow = win => ({ ...defaultWindow(win?.type ?? 'circle'), ...win })

const rad = d => (d * Math.PI) / 180

/** Plane pixels (fw × fh is the clip's source plane) → the window's own unrotated frame. */
export function toWindowLocal(win, px, py, fw, fh) {
  const w = fullWindow(win)
  const dx = px - w.x * fw
  const dy = py - w.y * fh
  const c = Math.cos(rad(w.rotation))
  const s = Math.sin(rad(w.rotation))

  return [dx * c + dy * s, -dx * s + dy * c]
}

/** The window's handles in plane pixels: center, w, h, corner, rotate and softness. */
export function windowHandles(win, fw, fh) {
  const w = fullWindow(win)
  const ax = (w.w * fw) / 2
  const ay = (w.h * fh) / 2
  const cx = w.x * fw
  const cy = w.y * fh
  const c = Math.cos(rad(w.rotation))
  const s = Math.sin(rad(w.rotation))
  const at = (lx, ly) => [cx + lx * c - ly * s, cy + lx * s + ly * c]
  const k = 1 + w.softness
  if (w.type === 'linear') {
    // The softness handle sits off to the side so a hard edge (softness near 0) still leaves the center grabbable.
    return { center: [cx, cy], rotate: at(0, -Math.max(40, ay) - 30), soft: at(Math.min(ax, fw * 0.12), w.softness * ay), ax, ay }
  }

  return {
    center: [cx, cy],
    w: at(ax, 0),
    h: at(0, ay),
    corner: w.type === 'rect' ? at(ax, ay) : at(ax * Math.SQRT1_2, ay * Math.SQRT1_2),
    rotate: at(0, -ay - 30),
    // On the outer softness ring, below and left of center (rarely off screen when the window is large).
    soft: w.type === 'rect' ? at(-ax * 0.5, ay * k) : at(-ax * k * Math.SQRT1_2, ay * k * Math.SQRT1_2),
    ax,
    ay,
  }
}

/**
 * A window after dragging `handle` to plane point (px, py). `start` is the window and
 * pointer when the drag began (the center handle moves by the pointer's delta).
 */
export function dragWindow(handle, start, px, py, fw, fh, { snap = false } = {}) {
  const w = fullWindow(start.win)
  const out = { ...w }
  const [lx, ly] = toWindowLocal(w, px, py, fw, fh)
  const minSize = 0.01
  if (handle === 'center') {
    out.x = r3(w.x + (px - start.px) / fw)
    out.y = r3(w.y + (py - start.py) / fh)
  } else if (handle === 'w' || handle === 'corner') {
    out.w = r3(Math.max(minSize, (2 * Math.abs(lx) * (handle === 'corner' && w.type === 'circle' ? Math.SQRT2 : 1)) / fw))
  }
  if (handle === 'h' || handle === 'corner') {
    out.h = r3(Math.max(minSize, (2 * Math.abs(ly) * (handle === 'corner' && w.type === 'circle' ? Math.SQRT2 : 1)) / fh))
  }
  if (handle === 'rotate') {
    let r = (Math.atan2(py - w.y * fh, px - w.x * fw) * 180) / Math.PI + 90
    if (snap) r = Math.round(r / 15) * 15
    r = ((r + 540) % 360) - 180
    out.rotation = Math.round(r * 10) / 10
  }
  if (handle === 'soft') {
    const ax = (w.w * fw) / 2
    const ay = (w.h * fh) / 2
    let k
    if (w.type === 'linear') k = Math.abs(ly) / Math.max(1e-6, ay)
    else if (w.type === 'rect') k = Math.max(Math.abs(lx) / ax, Math.abs(ly) / ay) - 1
    else k = Math.hypot(lx / ax, ly / ay) - 1
    out.softness = r3(Math.max(0.001, Math.min(w.type === 'linear' ? 4 : 1, k)))
  }

  return out
}
