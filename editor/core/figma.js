// Figma → Reel. Maps Figma REST nodes (GET /v1/files/:key/nodes?ids=…&geometry=paths) and
// Figma MCP metadata to Reel ops (docs/format.md, section 4). Pure functions with no Node,
// DOM or web APIs (no URL, structuredClone, Buffer, DOMParser), so the native app can run
// this file in JavaScriptCore beside project.js.
//
// How a Figma node becomes Reel layers:
// - The imported node becomes a composition sized to it. Its local space (top-left origin,
//   unrotated) is the composition's pixel space. Reel x/y are layer centers.
// - Each visible layer gets its own video track (one clip shows per track), bottom to top in
//   Figma's child order (children[0] is the bottom layer in both).
// - RECTANGLE and ELLIPSE with at most one solid, linear or radial fill and at most one solid
//   stroke become shape layers. Mixed corner radii become a bezier path. INSIDE and OUTSIDE
//   strokes are drawn as a centered stroke on a shape grown or shrunk by the stroke weight,
//   which matches Figma exactly for opaque strokes.
// - TEXT becomes a title layer. Titles size in 1080p units scaled to the composition height,
//   so size, tracking, stroke and shadow are multiplied by 1080 / composition height.
// - VECTOR, BOOLEAN_OPERATION, STAR, REGULAR_POLYGON, LINE, image fills on shapes, shapes with
//   shadows or several fills, text with mixed styles, and groups that hold a mask become
//   image layers from PNG renders (opts.images[nodeId]). A render already contains the
//   node's own rotation and opacity, so those are not applied again.
// - FRAME, COMPONENT and INSTANCE with clipsContent become a nested composition placed with
//   comp_clip; the composition bounds clip, and rounded corners add a path mask on the clip.
//   GROUP, SECTION and frames without clipping flatten into the parent composition, and a
//   group's opacity multiplies into its children. There is no parenting: a parent link needs
//   clip ids that only exist after the ops run.
// - Frame fills become layers under the children (solid, linear, radial, and image fills
//   placed from the original image with FILL, FIT or STRETCH); frame strokes go on top.
//
// Gradients: `angle` is degrees clockwise from +x in the y-down layer space (0 runs left to
// right, 90 top to bottom), the same sense as Reel `rotation`. `from`/`to` (linear) and
// `center`/`radius` (radial) are the exact handle positions in layer pixels around the
// layer center, so a renderer can reproduce Figma's handles rather than only the angle.

const EPS = 1e-6
const RENDER_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'REGULAR_POLYGON', 'LINE'])
const CONTAINERS = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION'])
const FRAMES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'])
const FLAT = new Set(['GROUP', 'SECTION', 'TRANSFORM_GROUP'])
const SKIP_TYPES = new Set(['SLICE', 'CANVAS', 'DOCUMENT', 'CONNECTOR'])

const BLEND = {
  PASS_THROUGH: 'normal', NORMAL: 'normal', MULTIPLY: 'multiply', SCREEN: 'screen', OVERLAY: 'overlay',
  SOFT_LIGHT: 'softLight', LIGHTEN: 'lighten', DARKEN: 'darken', DIFFERENCE: 'difference',
  COLOR_DODGE: 'colorDodge', LINEAR_DODGE: 'add',
}
const JOIN = { MITER: 'miter', BEVEL: 'bevel', ROUND: 'round' }
const CAP = { NONE: 'butt', ROUND: 'round', SQUARE: 'square' }
const ALIGN = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'left' }
// Keys in a text style override that change how the characters look.
const STYLE_KEYS = ['fontFamily', 'fontWeight', 'fontSize', 'italic', 'fills', 'letterSpacing', 'textCase', 'lineHeightPx', 'fontPostScriptName']

const KAPPA = 0.5523
const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places
const deg = rad => (rad * 180) / Math.PI
const clone = x => JSON.parse(JSON.stringify(x))
const normAngle = a => {
  let r = ((a % 360) + 360) % 360
  if (r > 180) r -= 360

  return Math.abs(r) < 1e-4 ? 0 : r
}

// ---------------------------------------------------------------- Figma links

/**
 * Reads a Figma link: https://www.figma.com/design/<key>/<title>?node-id=12-3 (also /file/,
 * /proto/, /board/, and /design/<key>/branch/<branchKey>/…). Node ids in links use "-" for ":".
 * Returns { fileKey, nodeId } (nodeId null when the link names no node), or null.
 */
export function parseFigmaUrl(text) {
  const s = String(text ?? '').trim()
  const m = /^(?:https?:\/\/)?(?:[\w-]+\.)?figma\.com\/(?:file|design|proto|board|slides|make)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?([^?#]*)(\?[^#]*)?/.exec(s)
  if (!m) return null
  let nodeId = null
  const q = /[?&]node-id=([^&#]+)/.exec(m[4] ?? '')
  if (q) nodeId = decodeURIComponent(q[1].replace(/\+/g, ' ')).replace(/-/g, ':')

  return { fileKey: m[2] ?? m[1], nodeId }
}

// ---------------------------------------------------------------- geometry

const IDENTITY = [[1, 0, 0], [0, 1, 0]]

function mul(a, b) {
  return [
    [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1], a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
    [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1], a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]],
  ]
}

const linear = m => [[m[0][0], m[0][1], 0], [m[1][0], m[1][1], 0]]
const det = m => m[0][0] * m[1][1] - m[0][1] * m[1][0]

/**
 * Reel rotation (degrees, clockwise on screen) of a Figma transform. Figma's own rotation is
 * atan2(-m10, m00) and counter-clockwise, so Reel's is atan2(m10, m00). A mirrored transform
 * is read as R(angle) · scaleX(-1).
 */
function angleOf(m) {
  return det(m) < 0 ? normAngle(deg(Math.atan2(-m[1][0], -m[0][0]))) : normAngle(deg(Math.atan2(m[1][0], m[0][0])))
}

function sizeOf(n) {
  if (n.size && Number.isFinite(n.size.x)) return { w: n.size.x, h: n.size.y }
  const b = n.absoluteBoundingBox

  return { w: b?.width ?? 0, h: b?.height ?? 0 }
}

const centerOf = b => [b.x + b.width / 2, b.y + b.height / 2]

/** A composition's space: the absolute center and rotation of its root node, and its size. */
function spaceFor(root, lin, width, height) {
  const box = root.absoluteBoundingBox ?? { x: 0, y: 0, width, height }

  return { c: centerOf(box), rot: angleOf(lin), W: width, H: height, k: 1080 / height }
}

/** Absolute (page) point → composition pixels. */
function toComp(space, p) {
  const dx = p[0] - space.c[0]
  const dy = p[1] - space.c[1]
  const a = (-space.rot * Math.PI) / 180

  return [dx * Math.cos(a) - dy * Math.sin(a) + space.W / 2, dx * Math.sin(a) + dy * Math.cos(a) + space.H / 2]
}

/** Fills in absoluteBoundingBox from relativeTransform when a node tree lacks it (hand-built nodes). */
function ensureBoxes(root) {
  const visit = (n, container) => {
    const m = mul(container, n.relativeTransform ?? IDENTITY)
    if (!n.absoluteBoundingBox) {
      const { w, h } = sizeOf(n)
      const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]])
      const xs = pts.map(p => p[0])
      const ys = pts.map(p => p[1])
      n.absoluteBoundingBox = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
    }
    for (const c of n.children ?? []) visit(c, CONTAINERS.has(n.type) ? m : container)
  }
  visit(root, IDENTITY)
}

// ---------------------------------------------------------------- paints

function hexOf(c, opacity = 1) {
  if (!c) return '#000000'
  const to = v => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
  const a = (c.a ?? 1) * opacity

  return `#${to(c.r ?? 0)}${to(c.g ?? 0)}${to(c.b ?? 0)}${a < 0.998 ? to(a) : ''}`
}

const visiblePaints = paints => (paints ?? []).filter(p => p && p.visible !== false && (p.opacity ?? 1) > 0)
const visibleEffects = n => (n.effects ?? []).filter(e => e && e.visible !== false)

function gradientHandles(p) {
  if (p.gradientHandlePositions?.length >= 2) return p.gradientHandlePositions
  const points = p.type === 'GRADIENT_RADIAL'
    ? [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }]
    : [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }]
  const m = p.gradientTransform
  if (!Array.isArray(m) || m.length !== 2 || m.some(row => !Array.isArray(row) || row.length !== 3 || row.some(v => !Number.isFinite(v)))) return points
  const determinant = det(m)
  if (Math.abs(determinant) < EPS) return points

  // Plugin API transforms map node coordinates to gradient coordinates.
  return points.map(({ x, y }) => ({
    x: (m[1][1] * (x - m[0][2]) - m[0][1] * (y - m[1][2])) / determinant,
    y: (-m[1][0] * (x - m[0][2]) + m[0][0] * (y - m[1][2])) / determinant,
  }))
}

function fillOf(p, w, h) {
  if (p.type === 'SOLID') return { color: hexOf(p.color, p.opacity ?? 1) }
  const stops = (p.gradientStops ?? []).map(s => [round(s.position, 4), hexOf(s.color, p.opacity ?? 1)])
  const handles = gradientHandles(p)
    .map(v => [round(v.x * w - w / 2), round(v.y * h - h / 2)])
  const [h0, h1, h2 = h0] = handles
  const angle = round(normAngle(deg(Math.atan2(h1[1] - h0[1], h1[0] - h0[0]))))
  if (p.type === 'GRADIENT_RADIAL') {
    return { gradient: { type: 'radial', stops, angle, center: h0, radius: [round(Math.hypot(h1[0] - h0[0], h1[1] - h0[1])), round(Math.hypot(h2[0] - h0[0], h2[1] - h0[1]))] } }
  }

  return { gradient: { type: 'linear', stops, angle, from: h0, to: h1 } }
}

function strokeOf(n, scale = 1) {
  const p = visiblePaints(n.strokes)[0]
  if (!p || !(n.strokeWeight > 0)) return null
  const stroke = { color: hexOf(p.color, p.opacity ?? 1), width: round(n.strokeWeight * scale) }
  if (n.strokeJoin && JOIN[n.strokeJoin]) stroke.join = JOIN[n.strokeJoin]
  if (n.strokeCap && CAP[n.strokeCap]) stroke.cap = CAP[n.strokeCap]
  if (n.strokeDashes?.length) stroke.dash = [n.strokeDashes[0], n.strokeDashes[1] ?? n.strokeDashes[0]]

  return stroke
}

/** A rounded rectangle as a closed bezier path around its center; radii are [tl, tr, br, bl]. */
export function roundedRectPath(w, h, radii) {
  const lim = Math.min(w, h) / 2
  const [tl, tr, br, bl] = radii.map(r => Math.max(0, Math.min(lim, r ?? 0)))
  const x0 = -w / 2
  const x1 = w / 2
  const y0 = -h / 2
  const y1 = h / 2
  const vertices = []
  const ins = []
  const outs = []
  const add = (p, i, o) => {
    vertices.push(p.map(v => round(v)))
    ins.push(i.map(v => round(v)))
    outs.push(o.map(v => round(v)))
  }
  const corner = (r, pin, pinTan, pout, poutTan, sharp) => {
    if (r > EPS) {
      add(pin, [0, 0], pinTan)
      add(pout, poutTan, [0, 0])
    } else add(sharp, [0, 0], [0, 0])
  }
  corner(tl, [x0, y0 + tl], [0, -KAPPA * tl], [x0 + tl, y0], [-KAPPA * tl, 0], [x0, y0])
  corner(tr, [x1 - tr, y0], [KAPPA * tr, 0], [x1, y0 + tr], [0, -KAPPA * tr], [x1, y0])
  corner(br, [x1, y1 - br], [0, KAPPA * br], [x1 - br, y1], [KAPPA * br, 0], [x1, y1])
  corner(bl, [x0 + bl, y1], [-KAPPA * bl, 0], [x0, y1 - bl], [0, KAPPA * bl], [x0, y1])

  return { closed: true, vertices, in: ins, out: outs }
}

function radiiOf(n) {
  if (Array.isArray(n.rectangleCornerRadii) && n.rectangleCornerRadii.length === 4) return n.rectangleCornerRadii.map(r => r ?? 0)
  const r = n.cornerRadius ?? 0

  return [r, r, r, r]
}

const blendOf = (n, ctx) => {
  const mode = n.blendMode ?? 'PASS_THROUGH'
  if (BLEND[mode]) return BLEND[mode]
  ctx.warn(`"${n.name}": blend mode ${mode} has no Reel equivalent, used normal`)

  return 'normal'
}

// ---------------------------------------------------------------- classification

const hasMaskChild = n => (n.children ?? []).some(c => c.isMask && c.visible !== false)

function arcIsPartial(arc) {
  if (!arc) return false

  return (arc.innerRadius ?? 0) > EPS || Math.abs((arc.endingAngle ?? 2 * Math.PI) - (arc.startingAngle ?? 0)) < 2 * Math.PI - 1e-3
}

function shapeIsSimple(n) {
  const fills = visiblePaints(n.fills)
  if (fills.length > 1 || fills.some(p => !['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL'].includes(p.type))) return false
  const strokes = visiblePaints(n.strokes)
  if (strokes.length > 1 || strokes.some(p => p.type !== 'SOLID')) return false
  if (strokes.length && n.individualStrokeWeights) return false
  if (visibleEffects(n).some(e => e.type !== 'LAYER_BLUR')) return false

  return !(n.type === 'ELLIPSE' && arcIsPartial(n.arcData))
}

function mixedTextStyles(n) {
  const used = new Set((n.characterStyleOverrides ?? []).filter(id => id))
  for (const id of used) {
    const o = n.styleOverrideTable?.[id] ?? n.styleOverrideTable?.[String(id)]
    if (o && STYLE_KEYS.some(k => k in o)) return true
  }

  return false
}

function textIsSimple(n) {
  const fills = visiblePaints(n.fills)
  if (fills.length > 1 || fills.some(p => p.type !== 'SOLID' && p.type !== 'GRADIENT_LINEAR')) return false
  const effects = visibleEffects(n)
  if (effects.some(e => e.type !== 'DROP_SHADOW' && e.type !== 'LAYER_BLUR')) return false
  if (effects.filter(e => e.type === 'DROP_SHADOW').length > 1) return false
  if (visiblePaints(n.strokes).some(p => p.type !== 'SOLID')) return false

  return !mixedTextStyles(n) && typeof n.characters === 'string'
}

/** What a node becomes: skip | image | shape | title | comp (nested composition) | flatten. */
function kindOf(n, options = {}) {
  if (!n || n.visible === false || SKIP_TYPES.has(n.type)) return 'skip'
  if (n.isMask) return 'skip' // reached only when its parent is the import root; see buildComp
  if (n._image) return 'image'
  if (n._mcp) {
    if (n.type === 'TEXT' && typeof n.characters === 'string') return 'title'
    if (n._placeholder === 'shape') return 'shape'
    if (CONTAINERS.has(n.type) || FLAT.has(n.type)) return 'flatten'

    return 'skip'
  }
  if (n.type === 'TEXT') return textIsSimple(n) ? 'title' : 'image'
  if (n.type === 'RECTANGLE' || n.type === 'ELLIPSE') return shapeIsSimple(n) ? 'shape' : 'image'
  if (FRAMES.has(n.type)) {
    if (hasMaskChild(n)) return 'image'

    return n.clipsContent && !options.flatten ? 'comp' : 'flatten'
  }
  if (FLAT.has(n.type)) return hasMaskChild(n) ? 'image' : 'flatten'
  if (RENDER_TYPES.has(n.type)) return 'image'

  return 'image'
}

/** Fills of a container drawn as layers under its children. */
const backgroundFills = n => visiblePaints(n.fills)

/**
 * The renders and original images an import needs, for the server to fetch before mapping:
 * { renders: [nodeId] } via GET /v1/images (PNG), { fills: [imageRef] } via GET /v1/files/:key/images.
 * Pass the same nodes (and `flatten` for Smart Animate) as the mapping call.
 */
export function figmaAssets(nodes, options = {}) {
  const renders = new Set()
  const fills = new Set()
  const visitContainer = n => {
    for (const p of backgroundFills(n)) if (p.type === 'IMAGE' && p.imageRef) fills.add(p.imageRef)
    for (const c of n.children ?? []) visit(c)
  }
  const visit = n => {
    const kind = kindOf(n, options)
    if (kind === 'image') renders.add(n.id)
    else if (kind === 'comp' || kind === 'flatten') visitContainer(n)
  }
  for (const root of [].concat(nodes)) {
    if (!root) continue
    const kind = kindOf(root, options)
    if (kind === 'comp' || kind === 'flatten') visitContainer(root)
    else if (kind !== 'skip') visit(root)
  }

  return { renders: [...renders], fills: [...fills] }
}

// ---------------------------------------------------------------- layers

function context(options) {
  const warnings = []

  return {
    images: options.images ?? {},
    flatten: Boolean(options.flatten),
    font: options.font ?? 'Inter',
    textColor: options.textColor ?? '#ffffff',
    warnings,
    warn: text => {
      if (!warnings.includes(text)) warnings.push(text)
    },
  }
}

function imageEntry(ctx, key) {
  const v = ctx.images[key]
  if (!v) return null

  return typeof v === 'string' ? { src: v } : v
}

/** Reel scale that shows a source of iw × ih pixels at tw × th composition pixels (contain fit first). */
function imageScale(space, entry, tw, th) {
  if (!(entry.width > 0 && entry.height > 0)) return { scale: Math.max(tw / space.W, th / space.H) }
  const fit = Math.min(space.W / entry.width, space.H / entry.height)
  const k = entry.scale ? 1 / entry.scale : Math.min(tw / entry.width, th / entry.height)

  return { scale: k / fit }
}

function baseLayer(n, ctx, space, center, rotation, opacity) {
  const layer = { name: n.name ?? n.id, nodeId: n.id, x: round(center[0]), y: round(center[1]), rotation: round(normAngle(rotation)), opacity: round(opacity, 4) }
  const blend = blendOf(n, ctx)
  if (blend !== 'normal') layer.blend = blend

  return layer
}

function shapeLayer(n, lin, space, ctx, opacity) {
  const { w, h } = sizeOf(n)
  const strokes = visiblePaints(n.strokes)
  const stroke = strokes.length ? strokeOf(n) : null
  const grow = stroke ? (n.strokeAlign === 'INSIDE' ? -stroke.width : n.strokeAlign === 'OUTSIDE' ? stroke.width : 0) : 0
  const sw = Math.max(0, w + grow)
  const sh = Math.max(0, h + grow)
  let shape
  if (n.type === 'ELLIPSE') shape = { type: 'ellipse', width: round(sw), height: round(sh) }
  else {
    const radii = radiiOf(n).map(r => (r > EPS ? Math.max(0, r + grow / 2) : 0))
    if (radii.every(r => Math.abs(r - radii[0]) < 1e-3)) shape = { type: 'rect', width: round(sw), height: round(sh), radius: round(Math.min(radii[0], Math.min(sw, sh) / 2)) }
    else shape = { type: 'path', width: round(sw), height: round(sh), path: roundedRectPath(sw, sh, radii) }
    if ((n.cornerSmoothing ?? 0) > 0) ctx.warn(`"${n.name}": corner smoothing is drawn as plain rounded corners`)
  }
  const fill = visiblePaints(n.fills)[0]
  shape.fill = fill ? fillOf(fill, w, h) : { color: '#00000000' }
  if (stroke) shape.stroke = stroke
  const layer = { type: 'shape', ...baseLayer(n, ctx, space, toComp(space, centerOf(n.absoluteBoundingBox)), angleOf(lin) - space.rot, opacity * (n.opacity ?? 1)), shape, w: sw, h: sh }
  if (det(lin) < 0) layer.scaleX = -1
  const blur = visibleEffects(n).find(e => e.type === 'LAYER_BLUR')
  if (blur) layer.effects = [{ type: 'blur', enabled: true, params: { radius: round(blur.radius ?? 0) } }]

  return layer
}

/** Applies Figma's text case while preserving whitespace and explicit line breaks. */
function caseOf(text, textCase) {
  if (textCase === 'UPPER' || textCase === 'SMALL_CAPS' || textCase === 'SMALL_CAPS_FORCED') return text.toUpperCase()
  if (textCase === 'LOWER') return text.toLowerCase()
  if (textCase === 'TITLE') return text.replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase())

  return text
}

function titleLayer(n, lin, space, ctx, opacity) {
  const st = n.style ?? {}
  const { w, h } = sizeOf(n)
  const guessed = !n.style
  let text = String(n.characters ?? '').replace(/\r\n?|\u2028|\u2029/g, '\n')
  const explicitLines = text.split('\n').length
  const fontSize = st.fontSize ?? Math.max(1, h / explicitLines / 1.2)
  const lineH = st.lineHeightPx ?? fontSize * 1.2
  text = caseOf(text, st.textCase)
  if (st.textCase === 'SMALL_CAPS' || st.textCase === 'SMALL_CAPS_FORCED') ctx.warn(`"${n.name}": small caps are set as capitals`)
  const hug = (n.textAutoResize ?? st.textAutoResize) === 'WIDTH_AND_HEIGHT' || guessed
  const k = space.k
  const align = ALIGN[st.textAlignHorizontal] ?? 'left'
  const fill = visiblePaints(n.fills)[0]
  const title = {
    text,
    font: st.fontFamily ?? ctx.font,
    weight: st.fontWeight ?? 400,
    size: round(fontSize * k),
    color: fill ? (fill.type === 'SOLID' ? hexOf(fill.color, fill.opacity ?? 1) : hexOf(fill.gradientStops?.[0]?.color, fill.opacity ?? 1)) : guessed ? ctx.textColor : '#00000000',
    align,
    lineHeight: round(lineH / fontSize, 3),
    tracking: round((st.letterSpacing ?? 0) * k),
    italic: Boolean(st.italic),
    shadow: null,
    anim: 'none',
    box: { width: round(w * k), height: round(h * k), wrap: !hug, alignY: (n.textAlignVertical ?? st.textAlignVertical ?? 'TOP').toLowerCase() },
  }
  if (fill?.type === 'GRADIENT_LINEAR') {
    const stops = fill.gradientStops ?? []
    title.gradient = [hexOf(stops[0]?.color, fill.opacity ?? 1), hexOf(stops[stops.length - 1]?.color, fill.opacity ?? 1)]
  }
  if (visiblePaints(n.strokes).length) {
    const s = strokeOf(n, k)
    if (s) title.stroke = { color: s.color, width: s.width }
  }
  const shadow = visibleEffects(n).find(e => e.type === 'DROP_SHADOW')
  if (shadow) title.shadow = { color: hexOf(shadow.color), blur: round((shadow.radius ?? 0) * k), x: round((shadow.offset?.x ?? 0) * k), y: round((shadow.offset?.y ?? 0) * k) }
  if (st.textDecoration && st.textDecoration !== 'NONE') ctx.warn(`"${n.name}": text decoration is not supported`)
  if (guessed) ctx.warn(`"${n.name}": no text style in the source, so font, size and color are estimates`)
  if (!guessed && title.font !== 'Inter') ctx.warn(`"${n.name}": install "${title.font}" to match Figma's text metrics`)

  // The renderer measures the text within this box, including its alignment.
  const rotation = angleOf(lin) - space.rot
  const boxCenter = centerOf(n.absoluteBoundingBox)
  const center = toComp(space, boxCenter)
  const layer = { type: 'title', ...baseLayer(n, ctx, space, center, rotation, opacity * (n.opacity ?? 1)), title, w, h, fontSize }
  const blur = visibleEffects(n).find(e => e.type === 'LAYER_BLUR')
  if (blur) layer.effects = [{ type: 'blur', enabled: true, params: { radius: round(blur.radius ?? 0) } }]

  return layer
}

/** A PNG render of a node, placed unrotated at its render bounds (the render holds rotation and opacity). */
function renderLayer(n, space, ctx, opacity) {
  const entry = imageEntry(ctx, n.id) ?? (n._asset ? (typeof n._asset === 'string' ? { src: n._asset } : n._asset) : null)
  if (!entry) {
    ctx.warn(`"${n.name}" (${n.type}) needs a rendered image and none was given; skipped`)

    return null
  }
  const box = n.absoluteRenderBounds ?? n.absoluteBoundingBox
  const layer = { type: 'image', ...baseLayer(n, ctx, space, toComp(space, centerOf(box)), -space.rot, opacity), src: entry.src, ...imageScale(space, entry, box.width, box.height), w: box.width, h: box.height }
  layer.scale = round(layer.scale, 5)

  return layer
}

/** An image fill of a container, from the original image, fitted like Figma's scaleMode. */
function fillImageLayer(n, paint, index, lin, space, ctx, opacity) {
  const entry = imageEntry(ctx, paint.imageRef)
  if (!entry) {
    ctx.warn(`"${n.name}": image fill ${paint.imageRef} was not downloaded; skipped`)

    return null
  }
  const { w, h } = sizeOf(n)
  const layer = { type: 'image', ...baseLayer(n, ctx, space, toComp(space, centerOf(n.absoluteBoundingBox)), angleOf(lin) - space.rot, opacity * (paint.opacity ?? 1)), src: entry.src, w, h }
  layer.name = `${n.name} image${index ? ` ${index + 1}` : ''}`
  layer.part = `fill${index + 1}`
  delete layer.blend
  if (BLEND[paint.blendMode] && BLEND[paint.blendMode] !== 'normal') layer.blend = BLEND[paint.blendMode]
  if (!(entry.width > 0 && entry.height > 0)) {
    layer.scale = round(Math.max(w / space.W, h / space.H), 5)

    return layer
  }
  const fit = Math.min(space.W / entry.width, space.H / entry.height)
  const mode = paint.scaleMode ?? 'FILL'
  if (mode === 'FIT') layer.scale = round(Math.min(w / entry.width, h / entry.height) / fit, 5)
  else if (mode === 'STRETCH' || mode === 'TILE') {
    layer.scale = 1
    layer.scaleX = round(w / entry.width / fit, 5)
    layer.scaleY = round(h / entry.height / fit, 5)
    if (mode === 'TILE') ctx.warn(`"${n.name}": tiled image fill is stretched`)
  } else {
    const s = Math.max(w / entry.width, h / entry.height)
    layer.scale = round(s / fit, 5)
    const cx = (entry.width * s - w) / (2 * entry.width * s)
    const cy = (entry.height * s - h) / (2 * entry.height * s)
    if (cx > 1e-4 || cy > 1e-4) layer.crop = { l: round(cx, 5), r: round(cx, 5), t: round(cy, 5), b: round(cy, 5) }
  }
  if (paint.rotation) ctx.warn(`"${n.name}": image fill rotation is not applied`)
  if (paint.filters && Object.values(paint.filters).some(v => v)) ctx.warn(`"${n.name}": image fill adjustments are not applied`)

  return layer
}

/** A container's own fills (under its children) as layers sized to it. */
function paintLayers(n, lin, space, ctx, opacity, { asRoot = false } = {}) {
  const out = []
  const { w, h } = sizeOf(n)
  const radii = radiiOf(n)
  const fills = backgroundFills(n)
  fills.forEach((p, i) => {
    if (p.type === 'IMAGE') {
      const layer = fillImageLayer(n, p, i, lin, space, ctx, opacity * (asRoot ? 1 : n.opacity ?? 1))
      if (layer) out.push(layer)
      if (layer && !asRoot && radii.some(r => r > EPS) && !n.clipsContent) ctx.warn(`"${n.name}": rounded corners of the image fill are not clipped`)

      return
    }
    if (!['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL'].includes(p.type)) {
      ctx.warn(`"${n.name}": ${p.type} fill is not supported; skipped`)

      return
    }
    const shape = radii.every(r => Math.abs(r - radii[0]) < 1e-3)
      ? { type: 'rect', width: round(w), height: round(h), radius: round(Math.min(radii[0], Math.min(w, h) / 2)) }
      : { type: 'path', width: round(w), height: round(h), path: roundedRectPath(w, h, radii) }
    shape.fill = fillOf(p, w, h)
    const layer = { type: 'shape', ...baseLayer(n, ctx, space, toComp(space, centerOf(n.absoluteBoundingBox)), angleOf(lin) - space.rot, opacity * (asRoot ? 1 : n.opacity ?? 1)), shape, w, h }
    layer.name = fills.length > 1 ? `${n.name} fill ${i + 1}` : `${n.name} fill`
    layer.part = `fill${i + 1}`
    delete layer.blend
    if (BLEND[p.blendMode] && BLEND[p.blendMode] !== 'normal') layer.blend = BLEND[p.blendMode]
    out.push(layer)
  })

  return out
}

function strokeLayer(n, lin, space, ctx, opacity, { asRoot = false } = {}) {
  const strokes = visiblePaints(n.strokes)
  if (!strokes.length || !(n.strokeWeight > 0)) return null
  if (strokes.length > 1 || strokes[0].type !== 'SOLID') ctx.warn(`"${n.name}": only the first solid stroke is imported`)
  const stroke = strokeOf(n)
  if (!stroke) return null
  const { w, h } = sizeOf(n)
  const grow = n.strokeAlign === 'INSIDE' ? -stroke.width : n.strokeAlign === 'OUTSIDE' ? stroke.width : 0
  const radii = radiiOf(n).map(r => (r > EPS ? Math.max(0, r + grow / 2) : 0))
  const sw = Math.max(0, w + grow)
  const sh = Math.max(0, h + grow)
  const shape = radii.every(r => Math.abs(r - radii[0]) < 1e-3)
    ? { type: 'rect', width: round(sw), height: round(sh), radius: round(Math.min(radii[0], Math.min(sw, sh) / 2)) }
    : { type: 'path', width: round(sw), height: round(sh), path: roundedRectPath(sw, sh, radii) }
  shape.fill = { color: '#00000000' }
  shape.stroke = stroke
  const layer = { type: 'shape', ...baseLayer(n, ctx, space, toComp(space, centerOf(n.absoluteBoundingBox)), angleOf(lin) - space.rot, opacity * (asRoot ? 1 : n.opacity ?? 1)), shape, w: sw, h: sh }
  layer.name = `${n.name} stroke`
  layer.part = 'stroke'
  delete layer.blend

  return layer
}

const linOf = n => linear(n.relativeTransform ?? IDENTITY)

/** Layers for the children of a container; `lin` is the container's absolute linear transform. */
function walk(parent, lin, space, ctx, opacity, out) {
  const kids = [...(parent.children ?? [])]
  if (parent.itemReverseZIndex) kids.reverse()
  for (const n of kids) {
    const kind = kindOf(n, ctx)
    if (kind === 'skip') {
      if (n._mcp && n.visible !== false && !SKIP_TYPES.has(n.type)) ctx.warn(`"${n.name}": no asset and no text for this layer in the MCP data; skipped`)
      continue
    }
    const nl = mul(lin, linOf(n))
    if (kind === 'flatten') {
      const op = opacity * (n.opacity ?? 1)
      if (n.blendMode && n.blendMode !== 'PASS_THROUGH' && n.blendMode !== 'NORMAL') ctx.warn(`"${n.name}": the group blend mode is not applied to its flattened layers`)
      if (visibleEffects(n).length) ctx.warn(`"${n.name}": effects on a ${n.type.toLowerCase()} are not imported`)
      if (n.type !== 'GROUP') out.push(...paintLayers(n, nl, space, ctx, opacity))
      walk(n, CONTAINERS.has(n.type) ? nl : lin, space, ctx, op, out)
      if (n.type !== 'GROUP') {
        const s = strokeLayer(n, nl, space, ctx, opacity)
        if (s) out.push(s)
      }
      continue
    }
    if (kind === 'comp') {
      out.push(compLayer(n, nl, space, ctx, opacity))
      continue
    }
    const layer = kind === 'shape' ? shapeLayer(n, nl, space, ctx, opacity) : kind === 'title' ? titleLayer(n, nl, space, ctx, opacity) : renderLayer(n, space, ctx, opacity)
    if (layer) out.push(layer)
    if (layer && n._placeholder === 'shape') ctx.warn(`"${n.name}": the MCP metadata has no fill, so this is an editable grey ${n.type === 'ELLIPSE' ? 'ellipse' : 'rectangle'}; set its color in Arya or pass an asset`)
    if (layer && n._placeholder === 'text') ctx.warn(`"${n.name}": the MCP metadata has no text, so the layer name is the editable text with an estimated size`)
  }
}

function compIR(root, lin, ctx, name) {
  const { w, h } = sizeOf(root)
  const W = Math.max(1, Math.round(w))
  const H = Math.max(1, Math.round(h))
  const space = spaceFor(root, lin, W, H)
  const ir = { name: name ?? root.name ?? 'Figma', nodeId: root.id, width: W, height: H, background: 'transparent', layers: [], w, h }
  const kind = kindOf(root, ctx)
  if (kind === 'comp' || kind === 'flatten') {
    const fills = backgroundFills(root)
    const mode = fills[0]?.blendMode
    const opaque = fills.length === 1 && fills[0].type === 'SOLID' && (fills[0].color?.a ?? 1) * (fills[0].opacity ?? 1) >= 0.998
    if (opaque && radiiOf(root).every(r => r <= EPS) && (!mode || mode === 'NORMAL' || mode === 'PASS_THROUGH')) ir.background = hexOf(fills[0].color)
    else ir.layers.push(...paintLayers(root, lin, space, ctx, 1, { asRoot: true }))
    walk(root, CONTAINERS.has(root.type) ? lin : linear(IDENTITY), space, ctx, 1, ir.layers)
    const s = strokeLayer(root, lin, space, ctx, 1, { asRoot: true })
    if (s) ir.layers.push(s)
    if (visibleEffects(root).length) ctx.warn(`"${root.name}": effects on the imported ${root.type.toLowerCase()} itself are not imported`)
  } else if (kind !== 'skip') {
    const layer = kind === 'shape' ? shapeLayer(root, lin, space, ctx, 1) : kind === 'title' ? titleLayer(root, lin, space, ctx, 1) : renderLayer(root, space, ctx, 1)
    if (layer) {
      // The root's own opacity and blend belong to wherever the composition is placed.
      layer.opacity = 1
      delete layer.blend
      ir.layers.push(layer)
    }
  }
  if (kind === 'image' && hasMaskChild(root)) ctx.warn(`"${root.name}" holds a mask, so it was imported as one image`)

  return ir
}

function compLayer(n, lin, space, ctx, opacity) {
  const child = compIR(n, lin, ctx)
  const { w, h } = sizeOf(n)
  const fit = Math.min(space.W / child.width, space.H / child.height)
  const layer = { type: 'comp', ...baseLayer(n, ctx, space, toComp(space, centerOf(n.absoluteBoundingBox)), angleOf(lin) - space.rot, opacity * (n.opacity ?? 1)), comp: child, scale: round(w / child.width / fit, 5), w, h }
  const radii = radiiOf(n)
  if (radii.some(r => r > EPS)) layer.masks = [{ type: 'path', path: roundedRectPath(child.width, child.height, radii), mode: 'add', feather: 0, expansion: 0, opacity: 1, inverted: false }]
  if (det(lin) < 0) layer.scaleX = -1

  return layer
}

// ---------------------------------------------------------------- ops

/** The id the next add_comp will get (same rule as nextId in project.js). */
export function nextCompId(project) {
  let max = 0
  for (const k of Object.keys(project?.comps ?? {})) {
    const n = Number(k.slice(1))
    if (k.startsWith('k') && Number.isFinite(n)) max = Math.max(max, n)
  }

  return `k${max + 1}`
}

function idsFrom(project) {
  let next = Number(nextCompId(project).slice(1))

  return () => `k${next++}`
}

function clipSet(layer) {
  const set = { x: layer.x, y: layer.y }
  if (layer.rotation) set.rotation = layer.rotation
  if (Math.abs(layer.opacity - 1) > 1e-4) set.opacity = layer.opacity
  if (layer.blend) set.blend = layer.blend
  if (layer.scale !== undefined && Math.abs(layer.scale - 1) > 1e-6) set.scale = layer.scale
  if (layer.scaleX !== undefined && layer.scaleX !== 1) set.scaleX = layer.scaleX
  if (layer.scaleY !== undefined && layer.scaleY !== 1) set.scaleY = layer.scaleY
  if (layer.crop) set.crop = layer.crop
  if (layer.effects) set.effects = layer.effects
  if (layer.masks) set.masks = layer.masks.map((m, i) => ({ id: `mk${i + 1}`, ...m }))
  if (layer.anim && Object.keys(layer.anim).length) set.anim = layer.anim
  set.note = `figma ${layer.nodeId}`

  return set
}

function emitComp(ir, out, opts) {
  const id = out.nextComp()
  out.comps.push(id)
  out.ops.push({ op: 'add_comp', name: ir.name, width: ir.width, height: ir.height, fps: opts.fps, duration: opts.duration, background: ir.background })
  ir.layers.forEach((layer, i) => {
    if (i < 3) out.ops.push({ op: 'update_track', comp: id, id: `V${i + 1}`, set: { name: layer.name } })
    else out.ops.push({ op: 'add_track', comp: id, kind: 'video', name: layer.name })
  })
  ir.layers.forEach((layer, i) => {
    const base = { comp: id, track: `V${i + 1}`, start: 0, dur: opts.duration }
    const set = clipSet(layer)
    if (layer.type === 'shape') out.ops.push({ op: 'add_shape', ...base, name: layer.name, shape: layer.shape, set })
    else if (layer.type === 'title') out.ops.push({ op: 'add_title', ...base, text: layer.title.text, title: layer.title, set: { ...set, label: layer.name } })
    else if (layer.type === 'image') {
      out.ops.push({ op: 'add_clip', ...base, kind: 'image', src: layer.src, set: { ...set, dur: opts.duration, label: layer.name } })
      out.images.push(layer.name)
    }
    else if (layer.type === 'comp') {
      const target = emitComp(layer.comp, out, opts)
      out.ops.push({ op: 'comp_clip', ...base, target, set: { ...set, label: layer.name } })
    }
    out.layers++
  })

  return id
}

function emit(ir, options, warnings) {
  const out = { ops: [], comps: [], layers: 0, images: [], nextComp: idsFrom(options.project) }
  const opts = { fps: options.fps ?? options.project?.fps ?? 30, duration: options.duration ?? 5 }
  const comp = emitComp(ir, out, opts)

  return { ops: out.ops, comp, comps: out.comps, width: ir.width, height: ir.height, duration: opts.duration, name: ir.name, layers: out.layers, images: out.images, warnings }
}

/**
 * Ops that build a Reel composition from a Figma node (FRAME, COMPONENT, INSTANCE, GROUP or a
 * single layer) as returned by GET /v1/files/:key/nodes?ids=…&geometry=paths.
 *
 * options: images { [nodeId | imageRef]: path | { src, width, height, scale } } (renders from
 * figmaAssets; `scale` is the render scale, 2 for @2x), compName, fps, duration (seconds,
 * default 5), project (to number new compositions after existing ones).
 * Returns { ops, comp, comps, width, height, duration, name, layers, images, warnings }; `comp`
 * is the id the top composition gets when the ops apply to `project`, and `images` names the
 * layers that came in as pictures rather than editable shapes or text.
 */
export function figmaToOps(node, options = {}) {
  if (!node || typeof node !== 'object') throw new Error('figmaToOps needs a Figma node')
  const root = clone(node)
  ensureBoxes(root)
  const ctx = context(options)
  const ir = compIR(root, linOf(root), ctx, options.compName)
  if (!ir.layers.length && ir.background === 'transparent') ctx.warn(`"${root.name}" has no visible layers to import`)

  return emit(ir, options, ctx.warnings)
}

// ---------------------------------------------------------------- Smart Animate

function flatLayers(root, ctx) {
  const node = clone(root)
  ensureBoxes(node)
  const lin = linOf(node)
  const ir = compIR(node, lin, ctx)
  // Name paths identify layers across frames the way Smart Animate matches them.
  const paths = new Map()
  const index = (n, prefix) => {
    for (const c of n.children ?? []) {
      const path = prefix ? `${prefix}/${c.name}` : c.name
      paths.set(c.id, path)
      index(c, path)
    }
  }
  index(node, '')
  const counts = new Map()
  for (const layer of ir.layers) {
    const base = layer.nodeId === node.id ? '#root' : paths.get(layer.nodeId) ?? layer.name
    const key = layer.part ? `${base}#${layer.part}` : base
    const n = counts.get(key) ?? 0
    counts.set(key, n + 1)
    layer.key = n ? `${key}#${n}` : key
    layer.leaf = layer.name
  }

  return ir
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function fillLook(fill) {
  if (!fill) return null
  if (fill.color) return { color: fill.color }

  return { type: fill.gradient.type, stops: fill.gradient.stops, angle: fill.gradient.angle }
}

/** Whether one layer can morph from a to b with numeric keyframes alone. */
function morphable(a, b) {
  if (a.type !== b.type) return false
  if (a.type === 'image') return a.src === b.src
  if (a.type === 'title') {
    const pick = t => ({ text: t.text, font: t.font, weight: t.weight, color: t.color, gradient: t.gradient, align: t.align, italic: t.italic, lineHeight: t.lineHeight })

    return sameJson(pick(a.title), pick(b.title))
  }
  if (a.type === 'shape') {
    if (a.shape.type !== b.shape.type) return false
    if (a.shape.type === 'path' && !sameJson(a.shape.path, b.shape.path)) return false
    if (!sameJson(fillLook(a.shape.fill), fillLook(b.shape.fill))) return false
    const sa = a.shape.stroke
    const sb = b.shape.stroke
    if (Boolean(sa) !== Boolean(sb)) return false

    return !sa || (sa.color === sb.color && sameJson(sa.dash, sb.dash))
  }

  return false
}

function keys(from, to, t0, t1, ease, places = 3) {
  if (Math.abs(to - from) < 1e-3) return null

  return [[t0, round(from, places), ease], [t1, round(to, places)]]
}

/** Size and placement keys that carry `layer` from geometry `from` to geometry `to`. */
function morphKeys(layer, from, to, t) {
  const anim = {}
  const put = (prop, k) => {
    if (k) anim[prop] = k
  }
  put('x', keys(from.x, to.x, t.t0, t.t1, t.ease, 2))
  put('y', keys(from.y, to.y, t.t0, t.t1, t.ease, 2))
  const turn = normAngle(to.rotation - from.rotation)
  put('rotation', keys(from.rotation, from.rotation + turn, t.t0, t.t1, t.ease, 2))
  const rw = layer.w > EPS ? 1 / layer.w : 0
  const rh = layer.h > EPS ? 1 / layer.h : 0
  if (layer.type === 'shape' && layer.shape.type !== 'path') {
    put('shape.width', keys(from.w, to.w, t.t0, t.t1, t.ease, 2))
    put('shape.height', keys(from.h, to.h, t.t0, t.t1, t.ease, 2))
    if (layer.shape.type === 'rect' && from.radius !== undefined && to.radius !== undefined) put('shape.radius', keys(from.radius, to.radius, t.t0, t.t1, t.ease, 2))
    if (layer.shape.stroke && from.strokeWidth !== undefined && to.strokeWidth !== undefined) put('shape.stroke.width', keys(from.strokeWidth, to.strokeWidth, t.t0, t.t1, t.ease, 2))
  } else if (layer.type === 'title' && from.fontSize && to.fontSize && layer.fontSize) {
    put('scale', keys(from.fontSize / layer.fontSize, to.fontSize / layer.fontSize, t.t0, t.t1, t.ease, 4))
  } else {
    const base = layer.scale ?? 1
    const sx0 = from.w * rw
    const sx1 = to.w * rw
    const sy0 = from.h * rh
    const sy1 = to.h * rh
    if (Math.abs(sx0 - sy0) < 0.01 && Math.abs(sx1 - sy1) < 0.01) put('scale', keys(base * sx0, base * sx1, t.t0, t.t1, t.ease, 5))
    else {
      put('scaleX', keys(sx0, sx1, t.t0, t.t1, t.ease, 4))
      put('scaleY', keys(sy0, sy1, t.t0, t.t1, t.ease, 4))
    }
  }

  return anim
}

const geometry = l => ({ x: l.x, y: l.y, rotation: l.rotation, w: l.w, h: l.h, radius: l.shape?.radius, strokeWidth: l.shape?.stroke?.width, fontSize: l.fontSize })

/**
 * Ops for one composition that animates frame A into frame B, matching layers by name like
 * Figma Smart Animate. Matched layers keyframe position, size (shape.width/height, or scale
 * for titles and images), rotation, opacity, corner radius and stroke width. Keyframes cannot
 * hold colors, so a layer whose color, text or image changes cross-fades: B's version sits
 * under A's, both follow the same motion, and A's fades out. Layers only in A fade out; layers
 * only in B fade in. Nested frames flatten (their clipping is not kept).
 *
 * options: images, compName, fps, duration (animation seconds, default 0.8), delay (default
 * 0.5, the hold on A), hold (default 1.5, the hold on B), ease (default 'smooth'), project.
 */
export function smartAnimateOps(frameA, frameB, options = {}) {
  if (!frameA || !frameB) throw new Error('smartAnimateOps needs two frames')
  const ctx = context({ ...options, flatten: true })
  const A = flatLayers(frameA, ctx)
  const B = flatLayers(frameB, ctx)
  if (Math.abs(A.width - B.width) > 0.5 || Math.abs(A.height - B.height) > 0.5) ctx.warn(`the frames differ in size (${A.width}x${A.height} and ${B.width}x${B.height}); the composition uses the first`)
  const delay = options.delay ?? 0.5
  const dur = options.duration ?? 0.8
  const hold = options.hold ?? 1.5
  const t = { t0: round(delay, 4), t1: round(delay + dur, 4), ease: options.ease ?? 'smooth' }

  // Match by name path, then by layer name.
  const usedB = new Set()
  const pair = new Map()
  for (const a of A.layers) {
    const b = B.layers.find(x => !usedB.has(x) && x.key === a.key) ?? B.layers.find(x => !usedB.has(x) && x.leaf === a.leaf && x.type === a.type)
    if (b) {
      usedB.add(b)
      pair.set(a, b)
    }
  }
  const pairOfB = new Map([...pair].map(([a, b]) => [b, a]))
  const merged = B.layers.map(b => ({ a: pairOfB.get(b), b }))
  let last = -1
  for (const a of A.layers) {
    const at = merged.findIndex(m => m.a === a)
    if (at >= 0) {
      last = at
      continue
    }
    merged.splice(last + 1, 0, { a })
    last++
  }

  const layers = []
  const fade = (from, to) => keys(from, to, t.t0, t.t1, t.ease, 4)
  for (const { a, b } of merged) {
    if (a && b && morphable(a, b)) {
      const anim = morphKeys(a, geometry(a), geometry(b), t)
      const o = fade(a.opacity, b.opacity)
      if (o) anim.opacity = o
      layers.push({ ...a, anim })
    } else if (a && b) {
      // Cross-fade: B under A, both following A's motion into B's.
      const under = { ...b, anim: morphKeys(b, geometry(a), geometry(b), t), name: b.name }
      const ou = fade(a.opacity, b.opacity)
      if (ou) under.anim.opacity = ou
      Object.assign(under, { x: a.x, y: a.y, rotation: a.rotation, opacity: a.opacity })
      const over = { ...a, anim: morphKeys(a, geometry(a), geometry(b), t), name: `${a.name} (from)` }
      over.anim.opacity = fade(a.opacity, 0) ?? [[t.t0, 0], [t.t1, 0]]
      layers.push(under, over)
    } else if (a) {
      layers.push({ ...a, anim: { opacity: fade(a.opacity, 0) ?? [[t.t0, 0], [t.t1, 0]] } })
    } else {
      layers.push({ ...b, anim: { opacity: fade(0, b.opacity) ?? [[t.t0, 0], [t.t1, 0]] } })
    }
  }
  const ir = { name: options.compName ?? `${A.name} → ${B.name}`, width: A.width, height: A.height, background: A.background, layers }

  return emit(ir, { ...options, duration: round(delay + dur + hold, 4) }, ctx.warnings)
}

// ---------------------------------------------------------------- Figma MCP

const TAG_TYPES = {
  frame: 'FRAME', group: 'GROUP', section: 'SECTION', instance: 'INSTANCE', symbol: 'COMPONENT', component: 'COMPONENT',
  'component-set': 'COMPONENT_SET', componentset: 'COMPONENT_SET', text: 'TEXT', rectangle: 'RECTANGLE', 'rounded-rectangle': 'RECTANGLE',
  rect: 'RECTANGLE', ellipse: 'ELLIPSE', vector: 'VECTOR', 'boolean-operation': 'BOOLEAN_OPERATION', star: 'STAR', line: 'LINE',
  'regular-polygon': 'REGULAR_POLYGON', polygon: 'REGULAR_POLYGON', slice: 'SLICE', canvas: 'CANVAS', page: 'CANVAS',
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m))

/** A small, forgiving XML reader: elements, attributes, text; comments and declarations skipped. */
export function parseXml(src) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>/]+))?)*)\s*(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(String(src)))) {
    const top = stack[stack.length - 1]
    if (m[2]) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === m[2]) {
          stack.length = i
          break
        }
      }
    } else if (m[3]) {
      const attrs = {}
      const ar = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g
      let a
      while ((a = ar.exec(m[4] ?? ''))) attrs[a[1]] = decode(a[2] ?? a[3] ?? a[4] ?? '')
      const el = { tag: m[3], attrs, children: [], text: '' }
      top.children.push(el)
      if (!m[5]) stack.push(el)
    } else if (m[6] !== undefined) top.text += decode(m[6])
    else if (m[1] !== undefined) top.text += m[1]
  }

  return root
}

const num = v => {
  const n = Number(v)

  return Number.isFinite(n) ? n : 0
}

function elementToNode(el) {
  const a = el.attrs
  const type = a.type ? String(a.type).toUpperCase().replace(/-/g, '_') : TAG_TYPES[el.tag.toLowerCase()] ?? el.tag.toUpperCase().replace(/-/g, '_')
  const node = { id: a.id ?? a['node-id'] ?? a.nodeId, name: a.name ?? a.id ?? el.tag, type, x: num(a.x), y: num(a.y), size: { x: num(a.width), y: num(a.height) } }
  if (a.hidden === 'true' || a.visible === 'false') node.visible = false
  if (type === 'TEXT') {
    const text = a.characters ?? a.text ?? el.text.trim()
    if (text) node.characters = text
  }
  const kids = el.children.map(elementToNode)
  if (kids.length) node.children = kids

  return node
}

/**
 * Turns what Claude can fetch through the Figma MCP connector into a node tree figmaToOps
 * accepts. `input` is get_metadata XML (elements with id, name, x, y, width, height; the tag or
 * a `type` attribute names the node type) or a node object in REST shape. `assets` maps node
 * ids to downloaded images ({ src, width, height } or a path). Full node objects retain
 * supported native text and shape properties, including their editable descendants.
 * Metadata-only or unsupported nodes can use supplied images when no descendant has an
 * image or supported native properties. Text without an asset becomes a title with
 * estimated style, using the layer name when the metadata has no characters. Rectangles and
 * ellipses without an asset become grey native shapes. Other layers without an asset are
 * skipped (the metadata has no paints or paths).
 *
 * options.coords: 'container' (default: x/y relative to the nearest frame, component,
 * instance or section, as Figma's plugin API reports them), 'parent' (relative to the direct
 * parent element) or 'absolute'.
 */
export function mcpToNodes(input, assets = {}, options = {}) {
  let root
  if (typeof input === 'string') {
    const doc = parseXml(input)
    const els = doc.children.filter(e => e.tag)
    if (!els.length) throw new Error('the metadata has no elements')
    const nodes = els.map(elementToNode)
    root = nodes.length === 1 ? nodes[0] : { id: 'mcp-root', name: 'Figma', type: 'GROUP', children: nodes, x: 0, y: 0 }
    const coords = options.coords ?? 'container'
    const place = (n, parentAbs, containerAbs) => {
      const base = coords === 'absolute' ? [0, 0] : coords === 'parent' ? parentAbs : containerAbs
      const abs = [base[0] + n.x, base[1] + n.y]
      n.absoluteBoundingBox = { x: abs[0], y: abs[1], width: n.size.x, height: n.size.y }
      const nextContainer = CONTAINERS.has(n.type) ? abs : containerAbs
      for (const c of n.children ?? []) place(c, abs, nextContainer)
      delete n.x
      delete n.y
    }
    if (root.id === 'mcp-root') {
      for (const c of root.children) place(c, [0, 0], [0, 0])
      const boxes = root.children.map(c => c.absoluteBoundingBox)
      const x0 = Math.min(...boxes.map(b => b.x))
      const y0 = Math.min(...boxes.map(b => b.y))
      const x1 = Math.max(...boxes.map(b => b.x + b.width))
      const y1 = Math.max(...boxes.map(b => b.y + b.height))
      root.absoluteBoundingBox = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      root.size = { x: x1 - x0, y: y1 - y0 }
      delete root.x
      delete root.y
    } else place(root, [0, 0], [0, 0])
    const mark = n => {
      n._mcp = true
      for (const c of n.children ?? []) mark(c)
    }
    mark(root)
  } else root = clone(input)
  if (!root.absoluteBoundingBox) ensureBoxes(root)
  const has = id => Boolean(assets[id])
  // get_metadata XML has geometry but no paints or text. Without an asset, rectangles and ellipses
  // become editable grey shapes and text layers use their name (Figma names text layers after
  // their content), so a metadata-only import still gives layers to edit.
  if (typeof input === 'string') {
    const placeholders = n => {
      if (n.visible === false) return
      if (!has(n.id) && (n.type === 'RECTANGLE' || n.type === 'ELLIPSE') && !n.children?.length) {
        n.fills = [{ type: 'SOLID', color: { r: 0.55, g: 0.57, b: 0.6, a: 1 } }]
        n._placeholder = 'shape'
      } else if (!has(n.id) && n.type === 'TEXT' && typeof n.characters !== 'string' && String(n.name ?? '').trim()) {
        n.characters = String(n.name).trim()
        n._placeholder = 'text'
      }
      for (const c of n.children ?? []) placeholders(c)
    }
    placeholders(root)
  }
  const colorComplete = color => color && ['r', 'g', 'b'].every(key => Number.isFinite(color[key])) && (color.a === undefined || Number.isFinite(color.a))
  const paintComplete = paint => {
    if (paint.blendMode && paint.blendMode !== 'NORMAL') return false
    if (paint.type === 'SOLID') return colorComplete(paint.color)
    if (paint.type === 'IMAGE') return has(paint.imageRef) && (!paint.scaleMode || ['FILL', 'FIT', 'STRETCH'].includes(paint.scaleMode)) &&
      !paint.rotation && !Object.values(paint.filters ?? {}).some(Boolean)
    if (!['GRADIENT_LINEAR', 'GRADIENT_RADIAL'].includes(paint.type)) return false
    return Array.isArray(paint.gradientStops) && paint.gradientStops.length >= 2 &&
      paint.gradientStops.every(stop => Number.isFinite(stop.position) && colorComplete(stop.color)) &&
      Array.isArray(paint.gradientHandlePositions) && paint.gradientHandlePositions.length >= (paint.type === 'GRADIENT_RADIAL' ? 3 : 2) &&
      paint.gradientHandlePositions.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))
  }
  const effectsComplete = n => {
    const effects = visibleEffects(n)
    if (effects.filter(effect => effect.type === 'LAYER_BLUR').length > 1) return false
    return effects.every(effect => {
      if (!Number.isFinite(effect.radius) || effect.radius < 0) return false
      if (effect.blendMode && effect.blendMode !== 'NORMAL') return false
      if (effect.type === 'LAYER_BLUR') return true
      return effect.type === 'DROP_SHADOW' && colorComplete(effect.color) &&
        Number.isFinite(effect.offset?.x) && Number.isFinite(effect.offset?.y) && !effect.spread
    })
  }
  const editable = n => {
    if (n._mcp || !Array.isArray(n.fills)) return false
    if (n.blendMode && !BLEND[n.blendMode]) return false
    if (!effectsComplete(n)) return false
    if (!visiblePaints(n.fills).every(paintComplete) || !visiblePaints(n.strokes).every(paintComplete)) return false
    if (visiblePaints(n.strokes).length > 1) return false
    const { w, h } = sizeOf(n)
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false
    const kind = kindOf(n)
    if (kind === 'shape') return !(n.cornerSmoothing > 0)
    return kind === 'title' && visiblePaints(n.fills).every(p => p.type === 'SOLID') &&
      (!n.style?.textDecoration || n.style.textDecoration === 'NONE') &&
      !['SMALL_CAPS', 'SMALL_CAPS_FORCED'].includes(n.style?.textCase) && n.style?.textAlignHorizontal !== 'JUSTIFIED' &&
      typeof n.style?.fontFamily === 'string' && n.style.fontFamily.trim().length > 0 && Number.isFinite(n.style.fontSize) && n.style.fontSize > 0
  }
  const container = n => {
    const { w, h } = sizeOf(n)
    return !n._mcp && ['comp', 'flatten'].includes(kindOf(n)) && Array.isArray(n.children) && Array.isArray(n.fills) &&
      Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
  }
  const containerAppearance = n => !visibleEffects(n).length && !(n.cornerSmoothing > 0) && (!n.blendMode || ['NORMAL', 'PASS_THROUGH'].includes(n.blendMode)) &&
    visiblePaints(n.fills).every(paintComplete) && visiblePaints(n.strokes).every(paintComplete) &&
    !visiblePaints(n.fills).some(p => !['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL'].includes(p.type) && !(p.type === 'IMAGE' && has(p.imageRef))) &&
    visiblePaints(n.strokes).length <= 1 && !visiblePaints(n.strokes).some(p => p.type !== 'SOLID') && !n.individualStrokeWeights &&
    !(!n.clipsContent && radiiOf(n).some(radius => radius > EPS) && visiblePaints(n.fills).some(p => p.type === 'IMAGE'))
  const covered = n => {
    if (kindOf(n) === 'skip' || editable(n) || has(n.id)) return true
    if (!container(n) || !containerAppearance(n)) return false
    return n.children.every(covered)
  }
  const editableBelow = n => editable(n) || container(n) && n.children.some(editableBelow)
  const nativeContainer = n => container(n) && containerAppearance(n) && n.children.every(covered) && n.children.some(editableBelow)
  const markImages = n => {
    let below = false
    for (const c of n.children ?? []) below = markImages(c) || below
    const native = editable(n) || nativeContainer(n)
    const incomplete = container(n) && (!containerAppearance(n) || !n.children.every(covered))
    if (has(n.id) && (incomplete || !below && !native)) {
      n._image = true
      n._asset = assets[n.id]
      delete n.children
    }

    return below || has(n.id)
  }
  markImages(root)

  return root
}

// ---------------------------------------------------------------- placing

/**
 * Ops that place composition `comp` ({ id, name, width, height, duration }) on the selected
 * timeline at `start`, on the top video track free for its length (a new track when none is),
 * at 1:1 pixel size and centered.
 */
export function placeCompOps(project, comp, options = {}) {
  if (!comp?.id) throw new Error('placeCompOps needs a composition')
  const scope = Object.hasOwn(options, 'comp') ? options.comp : project.compId ?? null
  if (scope !== null && (typeof scope !== 'string' || !project.comps?.[scope])) throw new Error(`no composition ${scope}`)
  const canvas = scope === null ? project : project.comps[scope]
  const tracks = canvas.tracks
  const dur = comp.duration ?? options.duration ?? 5
  const start = Math.max(0, options.start ?? 0)
  const W = canvas.width ?? project.width ?? 1920
  const H = canvas.height ?? project.height ?? 1080
  const scale = Math.max((comp.width ?? W) / W, (comp.height ?? H) / H)
  const ops = []
  let track = options.track
  if (track) {
    const destination = tracks.find(tr => tr.id === track)
    if (!destination) throw new Error(`no track ${track}`)
    if (destination.kind !== 'video') throw new Error(`track ${track} must be a video track`)
    if (destination.locked) throw new Error(`track ${track} is locked`)
  }
  if (!track) {
    const free = [...tracks].reverse().find(tr => tr.kind === 'video' && !tr.locked && !tr.clips.some(c => c.start < start + dur - 1e-6 && c.start + c.dur > start + 1e-6))
    if (free) track = free.id
    else {
      let n = 1
      while (tracks.some(tr => tr.id === `V${n}`)) n++
      track = `V${n}`
      ops.push({ op: 'add_track', kind: 'video', name: comp.name ?? 'Figma' })
    }
  }
  const set = {}
  if (Math.abs(scale - 1) > 1e-6) set.scale = round(scale, 5)
  ops.push({ op: 'comp_clip', target: comp.id, track, start, dur, set })

  return scope !== null || Object.hasOwn(options, 'comp') ? ops.map(op => ({ ...op, comp: scope })) : ops
}
