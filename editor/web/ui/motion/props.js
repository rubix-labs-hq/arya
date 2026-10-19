// The property tree the layer timeline shows for each layer: groups (Transform, Shape,
// Masks, Text) of rows. A row with `anim` gets a stopwatch, keyframes and an expression;
// rows without it edit a stored value. Pure: runs in the browser and under node --test.

import { valueAt } from '/core/project.js'

const TRANSFORM = [
  { prop: 'anchorX', label: 'Anchor X', step: 1, digits: 1, unit: 'px' },
  { prop: 'anchorY', label: 'Anchor Y', step: 1, digits: 1, unit: 'px' },
  { prop: 'x', label: 'Position X', step: 1, digits: 1, unit: 'px' },
  { prop: 'y', label: 'Position Y', step: 1, digits: 1, unit: 'px' },
  { prop: 'scale', label: 'Scale', step: 1, digits: 1, unit: '%', scale: 100 },
  { prop: 'scaleX', label: 'Scale X', step: 1, digits: 1, unit: '%', scale: 100 },
  { prop: 'scaleY', label: 'Scale Y', step: 1, digits: 1, unit: '%', scale: 100 },
  { prop: 'rotation', label: 'Rotation', step: 1, digits: 1, unit: '°' },
  { prop: 'opacity', label: 'Opacity', step: 1, digits: 0, unit: '%', scale: 100, min: 0, max: 100 },
]

/** Defaults for nested shape values the format leaves out (baseValue would read 0). */
export const SHAPE_DEFAULTS = { 'shape.trim.start': 0, 'shape.trim.end': 1, 'shape.trim.offset': 0, 'shape.stroke.width': 0 }

function shapeRows(shape) {
  const type = shape?.type ?? 'rect'
  const rows = []
  if (type === 'rect' || type === 'ellipse' || type === 'line') rows.push({ prop: 'shape.width', label: 'Width', step: 1, digits: 1, unit: 'px', min: 0 })
  if (type === 'rect' || type === 'ellipse') rows.push({ prop: 'shape.height', label: 'Height', step: 1, digits: 1, unit: 'px', min: 0 })
  if (type === 'rect') rows.push({ prop: 'shape.radius', label: 'Roundness', step: 1, digits: 1, unit: 'px', min: 0 })
  if (type === 'polygon') rows.push({ prop: 'shape.sides', label: 'Sides', step: 1, digits: 0, min: 3 })
  if (type === 'star') rows.push({ prop: 'shape.points', label: 'Points', step: 1, digits: 0, min: 3 })
  if (type === 'polygon' || type === 'star') rows.push({ prop: 'shape.radius', label: 'Radius', step: 1, digits: 1, unit: 'px', min: 0 })
  if (type === 'star') rows.push({ prop: 'shape.innerRadius', label: 'Inner radius', step: 1, digits: 1, unit: 'px', min: 0 })
  rows.push(
    { prop: 'shape.stroke.width', label: 'Stroke width', step: 0.5, digits: 1, unit: 'px', min: 0 },
    { prop: 'shape.trim.start', label: 'Trim start', step: 1, digits: 1, unit: '%', scale: 100, min: 0, max: 100 },
    { prop: 'shape.trim.end', label: 'Trim end', step: 1, digits: 1, unit: '%', scale: 100, min: 0, max: 100 },
    { prop: 'shape.trim.offset', label: 'Trim offset', step: 1, digits: 1, unit: '%', scale: 100 },
  )

  return rows.map(r => ({ ...r, anim: true }))
}

function maskRows(m) {
  const base = `mask.${m.id}`

  return [
    { kind: 'mask-type', mask: m.id, label: 'Shape' },
    { kind: 'mask-mode', mask: m.id, label: 'Mode' },
    { prop: `${base}.feather`, label: 'Feather', step: 1, digits: 1, unit: 'px', min: 0, anim: true },
    { prop: `${base}.expansion`, label: 'Expansion', step: 1, digits: 1, unit: 'px', anim: true },
    { prop: `${base}.opacity`, label: 'Opacity', step: 1, digits: 0, unit: '%', scale: 100, min: 0, max: 100, anim: true, fallback: 1 },
  ]
}

/**
 * Property groups for a clip: [{ id, label, rows }]. Text size and tracking are stored
 * values: the renderer reads `title` as is, so keyframes on them would not draw.
 */
export function propertyGroups(c) {
  const groups = []
  if (c.kind !== 'audio' && c.kind !== 'caption') groups.push({ id: 'transform', label: 'Transform', rows: TRANSFORM.map(r => ({ ...r, anim: true })) })
  if (c.kind === 'shape') groups.push({ id: 'shape', label: 'Contents', rows: shapeRows(c.shape) })
  if (c.kind === 'title') {
    groups.push({
      id: 'text',
      label: 'Text',
      rows: [
        { path: 'title.size', label: 'Size', step: 1, digits: 0, unit: 'px', min: 1, fallback: 96 },
        { path: 'title.tracking', label: 'Tracking', step: 0.5, digits: 1, unit: 'px', fallback: 0 },
        { kind: 'title-anim', label: 'Animator' },
      ],
    })
  }
  for (const m of c.masks ?? []) groups.push({ id: `mask:${m.id}`, label: `Mask ${m.id.slice(2)}`, mask: m.id, rows: maskRows(m) })

  return groups
}

/** Every animatable property of a clip, in display order. */
export function animatableProps(c) {
  return propertyGroups(c).flatMap(g => g.rows.filter(r => r.anim).map(r => r.prop))
}

/** The value a property shows now: keyframes and expression applied, nested defaults filled. */
export function propValue(p, c, prop, local, fallback) {
  if (!c.anim?.[prop]?.length && !c.expr?.[prop] && prop.includes('.')) {
    const stored = storedValue(c, prop)

    return stored ?? SHAPE_DEFAULTS[prop] ?? fallback ?? 0
  }

  return valueAt(p, c, prop, local)
}

/** A nested number stored on the clip (masks by id), or undefined. */
export function storedValue(c, prop) {
  const parts = prop.split('.')
  let v = c
  for (let i = 0; i < parts.length && v != null; i++) {
    if (parts[0] === 'mask' && i === 0) v = c.masks
    else if (parts[0] === 'mask' && i === 1) v = v.find?.(m => m.id === parts[1])
    else v = v[parts[i]]
  }

  return typeof v === 'number' ? v : undefined
}

/** Short names for the reveal keys After Effects uses (P, S, R, T, A). */
export const REVEAL = {
  p: ['x', 'y'],
  s: ['scale', 'scaleX', 'scaleY'],
  r: ['rotation'],
  t: ['opacity'],
  a: ['anchorX', 'anchorY'],
}
