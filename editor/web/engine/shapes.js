// Shape layers and masks, rasterized with Canvas2D (Path2D) into textures.
// Both are cached by their resolved parameters, so static shapes draw once.

import { valueAt } from '/core/project.js'
import { rasterSize } from './render-resolution.js'

/** The shape with any animated `shape.*` properties resolved at clip-local time. */
export function resolvedShape(p, c, local) {
  const shape = structuredClone(c.shape ?? {})
  for (const prop of Object.keys(c.anim ?? {})) {
    if (!prop.startsWith('shape.')) continue
    const path = prop.split('.').slice(1)
    let obj = shape
    for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]] ??= {}
    obj[path[path.length - 1]] = valueAt(p, c, prop, local)
  }
  for (const [prop] of Object.entries(c.expr ?? {})) {
    if (!prop.startsWith('shape.') || c.anim?.[prop]) continue
    const path = prop.split('.').slice(1)
    let obj = shape
    for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]] ??= {}
    obj[path[path.length - 1]] = valueAt(p, c, prop, local)
  }

  return shape
}

/** A Path2D for a shape, centered on (0, 0) in layer pixels, and its half extents. */
export function shapePath(shape) {
  const path = new Path2D()
  const type = shape.type ?? 'rect'
  if (type === 'rect') {
    const w = shape.width ?? 400
    const h = shape.height ?? 240
    path.roundRect(-w / 2, -h / 2, w, h, Math.min(shape.radius ?? 0, w / 2, h / 2))

    return { path, hw: w / 2, hh: h / 2 }
  }
  if (type === 'ellipse') {
    const w = shape.width ?? 300
    const h = shape.height ?? 300
    path.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2)

    return { path, hw: w / 2, hh: h / 2 }
  }
  if (type === 'polygon' || type === 'star') {
    const n = Math.max(3, Math.round(type === 'star' ? shape.points ?? 5 : shape.sides ?? 6))
    const r = shape.radius ?? 180
    const ri = type === 'star' ? shape.innerRadius ?? r * 0.45 : r
    const steps = type === 'star' ? n * 2 : n
    for (let i = 0; i < steps; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / steps
      const rr = type === 'star' && i % 2 === 1 ? ri : r
      const x = Math.cos(a) * rr
      const y = Math.sin(a) * rr
      if (i === 0) path.moveTo(x, y)
      else path.lineTo(x, y)
    }
    path.closePath()

    return { path, hw: r, hh: r }
  }
  if (type === 'line') {
    const w = shape.width ?? 600
    path.moveTo(-w / 2, 0)
    path.lineTo(w / 2, 0)

    return { path, hw: w / 2, hh: 1 }
  }
  // Bezier path: vertices with in/out tangents relative to each vertex.
  const pts = shape.path?.vertices ?? []
  const ins = shape.path?.in ?? []
  const outs = shape.path?.out ?? []
  let hw = 1
  let hh = 1
  pts.forEach(([x, y], i) => {
    hw = Math.max(hw, Math.abs(x))
    hh = Math.max(hh, Math.abs(y))
    if (i === 0) path.moveTo(x, y)
    else {
      const [px, py] = pts[i - 1]
      const o = outs[i - 1] ?? [0, 0]
      const n = ins[i] ?? [0, 0]
      path.bezierCurveTo(px + o[0], py + o[1], x + n[0], y + n[1], x, y)
    }
  })
  if (shape.path?.closed !== false && pts.length > 2) {
    const [px, py] = pts[pts.length - 1]
    const [x, y] = pts[0]
    const o = outs[pts.length - 1] ?? [0, 0]
    const n = ins[0] ?? [0, 0]
    path.bezierCurveTo(px + o[0], py + o[1], x + n[0], y + n[1], x, y)
    path.closePath()
  }

  return { path, hw, hh }
}

/** Approximate outline length, for trim paths. */
function pathLength(shape) {
  const type = shape.type ?? 'rect'
  if (type === 'rect') return 2 * ((shape.width ?? 400) + (shape.height ?? 240))
  if (type === 'ellipse') {
    const a = (shape.width ?? 300) / 2
    const b = (shape.height ?? 300) / 2

    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))
  }
  if (type === 'line') return shape.width ?? 600
  if (type === 'polygon' || type === 'star') {
    const r = shape.radius ?? 180
    const n = type === 'star' ? (shape.points ?? 5) * 2 : shape.sides ?? 6

    return n * 2 * r * Math.sin(Math.PI / n) * (type === 'star' ? 0.8 : 1)
  }
  const pts = shape.path?.vertices ?? []
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])

  return len * 1.1
}

function paint(ctx, fill, hw, hh) {
  if (!fill) return null
  if (fill.gradient) {
    const g = fill.gradient
    let grad
    let field
    if (g.type === 'radial') {
      const [x, y] = g.center ?? [0, 0]
      const radii = Array.isArray(g.radius) ? g.radius : [g.radius ?? Math.max(hw, hh), g.radius ?? Math.max(hw, hh)]
      const rx = Math.max(1e-6, radii[0])
      const ry = Math.max(1e-6, radii[1] ?? radii[0])
      if (rx === ry) grad = ctx.createRadialGradient(x, y, 0, x, y, rx)
      else {
        // Rasterize the ellipse as a pattern so a stroke keeps its own width.
        const canvas = document.createElement('canvas')
        canvas.width = ctx.canvas.width
        canvas.height = ctx.canvas.height
        field = canvas.getContext('2d')
        field.rect(0, 0, canvas.width, canvas.height)
        field.setTransform(ctx.getTransform())
        field.translate(x, y)
        field.rotate(((g.angle ?? 0) * Math.PI) / 180)
        field.scale(rx, ry)
        grad = field.createRadialGradient(0, 0, 0, 0, 0, 1)
      }
    } else if (g.from && g.to) grad = ctx.createLinearGradient(...g.from, ...g.to)
    else {
      const a = ((g.angle ?? 90) * Math.PI) / 180
      const dx = Math.cos(a) * hw
      const dy = Math.sin(a) * hh
      grad = ctx.createLinearGradient(-dx, -dy, dx, dy)
    }
    for (const [pos, color] of g.stops ?? [[0, '#ffffff'], [1, '#000000']]) grad.addColorStop(Math.max(0, Math.min(1, pos)), color)
    if (field) {
      field.fillStyle = grad
      field.fill()
      const pattern = ctx.createPattern(field.canvas, 'no-repeat')
      pattern.setTransform(ctx.getTransform().inverse())

      return pattern
    }

    return grad
  }

  return fill.color ?? '#ffffff'
}

const shapeCache = new Map()

/**
 * A canvas holding the shape drawn at `scale` (layer px → canvas px), plus the layer
 * size in layer pixels (the canvas size divided by scale).
 */
export function shapeCanvas(key, shape, scale) {
  const sig = JSON.stringify([shape, scale])
  const cached = shapeCache.get(key)
  if (cached?.sig === sig) return cached
  const { path, hw, hh } = shapePath(shape)
  const sw = shape.stroke?.width ?? 0
  const pad = sw / 2 + 2
  const w = (hw + pad) * 2
  const h = (hh + pad) * 2
  const k = scale
  const size = rasterSize(w, h, k, { surfaces: 2 })
  const canvas = cached?.canvas ?? document.createElement('canvas')
  canvas.width = size.w
  canvas.height = size.h
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(k, 0, 0, k, canvas.width / 2, canvas.height / 2)
  const fill = paint(ctx, shape.fill, hw, hh)
  if (fill && shape.type !== 'line') {
    ctx.fillStyle = fill
    ctx.fill(path)
  }
  if (shape.stroke && sw > 0) {
    ctx.lineWidth = sw
    ctx.strokeStyle = paint(ctx, shape.stroke, hw, hh) ?? '#ffffff'
    ctx.lineJoin = shape.stroke.join ?? 'round'
    ctx.lineCap = shape.stroke.cap ?? 'round'
    const trim = shape.trim
    if (trim && (trim.start > 0 || (trim.end ?? 1) < 1 || trim.offset)) {
      const len = pathLength(shape)
      const s = Math.max(0, Math.min(1, trim.start ?? 0))
      const e = Math.max(s, Math.min(1, trim.end ?? 1))
      ctx.setLineDash([(e - s) * len, len * 2])
      ctx.lineDashOffset = -((s + (trim.offset ?? 0)) * len)
    } else if (shape.stroke.dash) ctx.setLineDash(shape.stroke.dash)
    ctx.stroke(path)
  }
  canvas.dirty = true
  const entry = { sig, canvas, w: canvas.width / k, h: canvas.height / k }
  shapeCache.set(key, entry)

  return entry
}

const maskCache = new Map()

/**
 * The combined alpha of a clip's masks over a layer of w × h layer pixels, as a canvas
 * (white with alpha), or null when the clip has no masks.
 */
export function maskCanvas(p, c, key, local, w, h, scale) {
  const masks = c.masks ?? []
  if (!masks.length) return null
  const resolved = masks.map(m => {
    const out = {
      ...m,
      feather: valueAt(p, c, `mask.${m.id}.feather`, local),
      expansion: valueAt(p, c, `mask.${m.id}.expansion`, local),
      opacity: valueAt(p, c, `mask.${m.id}.opacity`, local),
    }
    for (const field of ['x', 'y', 'w', 'h', 'radius']) {
      const prop = `mask.${m.id}.${field}`
      if (c.anim?.[prop]?.length || c.expr?.[prop]) out[field] = valueAt(p, c, prop, local)
    }

    return out
  })
  const k = scale
  const size = rasterSize(w, h, k, { surfaces: 3 })
  const sig = JSON.stringify([resolved, w, h, k])
  const cached = maskCache.get(key)
  if (cached?.sig === sig) return cached.canvas
  const canvas = cached?.canvas ?? document.createElement('canvas')
  canvas.width = size.w
  canvas.height = size.h
  const ctx = canvas.getContext('2d')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (resolved[0].mode === 'subtract' || resolved[0].mode === 'intersect') {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  const tmp = document.createElement('canvas')
  tmp.width = canvas.width
  tmp.height = canvas.height
  const tctx = tmp.getContext('2d')
  for (const m of resolved) {
    tctx.setTransform(1, 0, 0, 1, 0, 0)
    tctx.clearRect(0, 0, tmp.width, tmp.height)
    tctx.filter = m.feather > 0 ? `blur(${(m.feather * k) / 2}px)` : 'none'
    tctx.setTransform(k, 0, 0, k, tmp.width / 2, tmp.height / 2)
    tctx.translate(m.x ?? 0, m.y ?? 0)
    let path
    if (m.type === 'path' && m.path) path = shapePath({ type: 'path', path: m.path }).path
    else {
      path = new Path2D()
      const mw = m.w ?? w
      const mh = m.h ?? h
      if (m.type === 'ellipse') path.ellipse(0, 0, mw / 2, mh / 2, 0, 0, Math.PI * 2)
      else path.roundRect(-mw / 2, -mh / 2, mw, mh, m.radius ?? 0)
    }
    tctx.fillStyle = '#fff'
    tctx.fill(path)
    if (m.expansion) {
      tctx.lineWidth = Math.abs(m.expansion) * 2
      tctx.lineJoin = 'round'
      tctx.globalCompositeOperation = m.expansion > 0 ? 'source-over' : 'destination-out'
      tctx.strokeStyle = '#fff'
      tctx.stroke(path)
      tctx.globalCompositeOperation = 'source-over'
    }
    if (m.inverted) {
      tctx.setTransform(1, 0, 0, 1, 0, 0)
      tctx.globalCompositeOperation = 'xor'
      tctx.filter = 'none'
      tctx.fillRect(0, 0, tmp.width, tmp.height)
      tctx.globalCompositeOperation = 'source-over'
    }
    ctx.globalAlpha = Math.max(0, Math.min(1, m.opacity ?? 1))
    ctx.globalCompositeOperation = m.mode === 'subtract' ? 'destination-out' : m.mode === 'intersect' ? 'destination-in' : 'source-over'
    ctx.drawImage(tmp, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }
  canvas.dirty = true
  maskCache.set(key, { sig, canvas })

  return canvas
}
