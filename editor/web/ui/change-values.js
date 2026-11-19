// Receipt values as a person reads them. A receipt stores each value as bounded JSON text; this turns
// it into words at display time: seconds with a timecode, one line per keyframe, a colour with its
// swatch, and plain lists for objects. It never shows JSON, and a value cut short says so.

import { timecode } from '../../core/project.js'

const TIMES = new Set(['start', 'dur', 'in', 'duration'])
// Lists of ids read as a count; the rows beside them name what was added or removed.
const ORDERS = { 'Object order': 'clip', markers: 'marker' }
const WHOLE = { layer: 'Layer', track: 'Track', composition: 'Composition' }
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const CUT = 'Too long to show here'
const MAX_FIELDS = 6

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

// The names the inspector and the timeline use, so a card never shows a stored property name.
const LABELS = {
  start: 'Start', dur: 'Duration', in: 'Source start', duration: 'Length', speed: 'Speed', reverse: 'Reverse',
  x: 'Position X', y: 'Position Y', scale: 'Scale', scaleX: 'Stretch X', scaleY: 'Stretch Y', rotation: 'Rotation',
  anchorX: 'Anchor X', anchorY: 'Anchor Y', opacity: 'Opacity', blend: 'Blend mode', blur: 'Blur', blurAmount: 'Blur',
  volume: 'Volume', pan: 'Pan', fadeIn: 'Fade in', fadeOut: 'Fade out', mute: 'Muted', muted: 'Muted', solo: 'Solo',
  enabled: 'Enabled', hidden: 'Hidden', locked: 'Locked', label: 'Name', name: 'Name', note: 'Note', color: 'Color', role: 'Role',
  src: 'Source file', track: 'Track', text: 'Text', link: 'Linked clip', parent: 'Parent layer', fx: 'Effects', grade: 'Grade', nodes: 'Color nodes',
  width: 'Width', height: 'Height', fps: 'Frame rate', background: 'Background', markers: 'Markers', range: 'In and out range',
  transitionIn: 'Transition in', 'transitionIn.type': 'Transition in', 'transitionIn.dur': 'Transition in length',
  'title.text': 'Title text', 'title.size': 'Title size', 'title.font': 'Font', 'title.weight': 'Font weight', 'title.color': 'Text color',
  'title.align': 'Alignment', 'title.tracking': 'Tracking', 'title.lineHeight': 'Line height', 'title.anim': 'Title animation',
  'title.plate': 'Text plate', 'title.padding': 'Plate padding', 'title.radius': 'Corner radius',
  'title.stroke.color': 'Outline color', 'title.stroke.width': 'Outline width', 'title.shadow.color': 'Shadow color', 'title.shadow.blur': 'Shadow blur',
  'title.shadow.x': 'Shadow X', 'title.shadow.y': 'Shadow Y',
  'crop.l': 'Crop left', 'crop.r': 'Crop right', 'crop.t': 'Crop top', 'crop.b': 'Crop bottom',
  'eq.low': 'EQ low', 'eq.mid': 'EQ mid', 'eq.high': 'EQ high', 'key.color': 'Key color', 'key.similarity': 'Key similarity',
  'key.smoothness': 'Key softness', 'key.spill': 'Key spill', burnIn: 'Burn in',
  'Object order': 'Clips on this track', 'Track order': 'Tracks',
}
const TRANSITIONS = { crossDissolve: 'Cross dissolve', dipBlack: 'Dip to black', dipWhite: 'Dip to white', wipeLeft: 'Wipe left', wipeRight: 'Wipe right', wipeUp: 'Wipe up', wipeDown: 'Wipe down',
  slideLeft: 'Slide left', slideRight: 'Slide right', pushLeft: 'Push left', pushRight: 'Push right', zoomIn: 'Zoom in', iris: 'Iris', blurDissolve: 'Blur dissolve', none: 'None' }
// A value the project leaves out reads as what the editor shows for it, not as "Not set".
const DEFAULTS = { opacity: 1, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, volume: 0, pan: 0, speed: 1, fadeIn: 0, fadeOut: 0, anchorX: 0, anchorY: 0, blur: 0 }
// Units as the inspector shows them: a share of 1 as a percentage, level in dB, rotation in degrees.
const UNITS = {
  opacity: value => `${number(value * 100)}%`, scale: value => `${number(value * 100)}%`, scaleX: value => `${number(value * 100)}%`, scaleY: value => `${number(value * 100)}%`,
  volume: value => `${value > 0 ? '+' : ''}${number(value)} dB`, 'eq.low': value => `${number(value)} dB`, 'eq.mid': value => `${number(value)} dB`, 'eq.high': value => `${number(value)} dB`,
  rotation: value => `${number(value)}°`, speed: value => `${number(value * 100)}%`, fadeIn: value => `${number(value)} s`, fadeOut: value => `${number(value)} s`, 'transitionIn.dur': value => `${number(value)} s`,
}
const words = text => { const plainText = text.replace(/\["?([^\]"]+)"?\]/g, '.$1').split('.').filter(Boolean).map(part => part.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()).join(' '); return plainText ? `${plainText[0].toUpperCase()}${plainText.slice(1)}` : text }

/** The label a card shows for a stored property path: "dur" is Duration, "anim.opacity" is Opacity keyframes. */
export function propertyLabel(property) {
  const path = String(property ?? '')
  if (Object.hasOwn(LABELS, path)) return LABELS[path]
  const keyed = path.match(/^anim(?:\.([\w$.]+)|\["(.+)"\])$/)
  if (keyed) return `${propertyLabel(keyed[1] ?? keyed[2])} keyframes`
  const asset = path.match(/^assets(?:\.[\w$]+|\["[^"]+"\])(?:\.(.+))?$/)
  if (asset) return asset[1] ? propertyLabel(asset[1]) : 'Media file'
  return words(path)
}
const number = value => String(Number(value.toFixed(3)))
const seconds = value => `${value.toFixed(2)} s`

/** The receipt text parsed, or `{ missing }` for Absent and `{ cut }` for text that is not whole JSON. */
function parse(text) {
  if (text === 'Absent' || text === undefined) return { missing: true }
  try { return { value: JSON.parse(text) } } catch {
    // A long string was cut: its start is still readable.
    return typeof text === 'string' && /^"[^"\\]*…$/.test(text) ? { value: text.slice(1) } : { cut: true }
  }
}

function plain(value, depth = 0, exact = false) {
  if (value === null) return 'None'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (typeof value === 'number') return Number.isFinite(value) && !exact ? number(value) : String(value)
  if (typeof value === 'string') return value === '' ? 'Empty' : value
  if (Array.isArray(value)) {
    if (!value.length) return 'Empty list'
    if (value.every(item => item === null || typeof item !== 'object')) return value.map(item => plain(item, depth, exact)).join(', ')
    if (value.every(item => typeof item?.type === 'string')) return value.map(item => item.type).join(', ')
    return plural(value.length, 'item')
  }
  if (depth > 1) return '…'
  const entries = Object.entries(value)
  if (!entries.length) return 'No settings'
  const shown = entries.slice(0, MAX_FIELDS).map(([key, item]) => {
    const text = plain(item, depth + 1, exact)
    return item !== null && typeof item === 'object' && !Array.isArray(item) ? `${key} (${text})` : `${key} ${text}`
  })
  return `${shown.join(', ')}${entries.length > MAX_FIELDS ? `, ${plural(entries.length - MAX_FIELDS, 'more setting')}` : ''}`
}

const isKeys = value => Array.isArray(value) && value.length > 0 && value.every(key => Array.isArray(key) && key.length >= 2 && key.length <= 3 && Number.isFinite(key[0]))
const easeName = (ease, exact = false) => ease == null ? 'linear' : Array.isArray(ease) ? (exact ? `custom curve ${ease.join(', ')}` : 'custom curve') : String(ease)
const same = (a, b) => JSON.stringify([a[1], a[2] ?? null]) === JSON.stringify([b[1], b[2] ?? null])

/**
 * Before and after keyframes paired by their exact time, so one added key does not mark every later
 * key changed. A change too small for the rounded text shows every digit, as a single value does.
 */
function keyRows(before, after) {
  const index = keys => new Map((keys ?? []).map(key => [key[0], key]))
  const old = index(before), next = index(after)
  const times = [...new Set([...old.keys(), ...next.keys()])].sort((a, b) => a - b)
  const text = (key, exact) => `${plain(key[1], 0, exact)}, ${easeName(key[2], exact)}`
  const rows = []
  for (const time of times) {
    const a = old.get(time), b = next.get(time)
    if (a && b && same(a, b)) continue
    const exact = Boolean(a && b && text(a) === text(b))
    rows.push({ at: time, before: a ? text(a, exact) : '', after: b ? text(b, exact) : '', status: !a ? 'added' : !b ? 'removed' : 'changed' })
  }
  // Two times that round alike are written out in full, so no two lines read the same.
  const rounded = rows.map(row => seconds(row.at))
  return rows.map(({ at, ...row }, index) => ({ time: `at ${rounded.indexOf(rounded[index]) === rounded.lastIndexOf(rounded[index]) ? rounded[index] : `${at} s`}`, ...row }))
}

// `exact` shows every digit, for when rounding would make a real change read the same on both sides.
function side(parsed, property, fps, exact = false) {
  if (parsed.missing && Object.hasOwn(DEFAULTS, property)) parsed = { value: DEFAULTS[property] }
  if (parsed.missing && property === 'transitionIn.type') return { text: 'None' }
  if (parsed.missing) return { text: ORDERS[property] ? `No ${ORDERS[property]}s` : 'Not set' }
  if (parsed.cut) return { text: CUT }
  const value = parsed.value
  if (!exact && typeof value === 'number' && Number.isFinite(value) && UNITS[property]) return { text: UNITS[property](value) }
  if (!exact && property === 'transitionIn.type' && typeof value === 'string' && TRANSITIONS[value]) return { text: TRANSITIONS[value] }
  if (ORDERS[property] && Array.isArray(value)) return { text: plural(value.length, ORDERS[property]) }
  if (typeof value === 'number' && Number.isFinite(value) && TIMES.has(property)) return { text: `${exact ? `${value} s` : seconds(value)} · ${timecode(value, fps)}` }
  if (typeof value === 'string' && HEX.test(value)) return { text: value, swatch: value }
  return { text: plain(value, 0, exact) }
}

/**
 * One receipt change as display text. `property` is the receipt path; `fps` is the frame rate of the
 * layer's own timeline. A whole layer, track or composition added or removed reads as one word.
 */
export function readableChange(change, { fps = 30 } = {}) {
  const property = String(change?.property ?? '')
  const before = parse(change?.before), after = parse(change?.after)
  if (WHOLE[property] && (before.missing || after.missing)) {
    return { property, label: WHOLE[property], only: before.missing ? 'Added' : 'Removed' }
  }
  const keyed = /(^|\.)anim(\.|\[)/.test(property)
  if (keyed && (before.cut || after.cut)) return { property, label: propertyLabel(property), only: `Keyframes ${CUT.toLowerCase()}` }
  if (keyed && (before.missing || isKeys(before.value)) && (after.missing || isKeys(after.value))) {
    return { property, label: propertyLabel(property), keys: keyRows(before.value, after.value) }
  }
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30
  let old = side(before, property, rate), next = side(after, property, rate)
  if (old.text === next.text && ORDERS[property]) return { property, label: propertyLabel(property), only: 'Reordered' }
  if (old.text === next.text) { old = side(before, property, rate, true); next = side(after, property, rate, true) }
  return { property, label: propertyLabel(property), before: old.text, after: next.text, swatches: old.swatch || next.swatch ? [old.swatch ?? null, next.swatch ?? null] : null }
}

/**
 * A value that appears or disappears as a whole object becomes one change per property, so a new
 * grade reads as its settings and a new set of keyframes reads one property at a time.
 */
export function splitChanges(changes = []) {
  return changes.flatMap(change => {
    if (WHOLE[change.property]) return [change]
    const before = parse(change.before), after = parse(change.after)
    const whole = before.missing ? after : after.missing ? before : null
    const value = whole?.value
    if (!whole || value === null || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return [change]
    return Object.entries(value).map(([key, item]) => {
      const property = /^[a-zA-Z_$][\w$]*$/.test(key) ? `${change.property}.${key}` : `${change.property}[${JSON.stringify(key)}]`
      return before.missing ? { property, before: 'Absent', after: JSON.stringify(item) } : { property, before: JSON.stringify(item), after: 'Absent' }
    })
  })
}

const trackOf = scope => scope.track != null

/**
 * The settings a preview changes, in one short phrase. A composition added with its tracks is one
 * item, tracks are counted, and media files are counted, so the line never lists internal names.
 */
export function settingsSummary(settings = []) {
  const added = new Set(settings.filter(scope => scope.comp != null && !trackOf(scope) && scope.asset == null && scope.status !== 'changed').map(scope => scope.comp))
  const parts = []
  for (const scope of settings) {
    if (scope.asset != null || trackOf(scope) || scope.comp == null) continue
    parts.push(scope.status === 'added' ? `new composition ${scope.name}` : scope.status === 'deleted' ? `removed composition ${scope.name}` : `${scope.name} settings`)
  }
  const main = settings.find(scope => scope.comp == null && !trackOf(scope) && scope.asset == null)
  if (main) parts.unshift(main.name === 'Timeline length' ? 'timeline length' : 'project settings')
  const tracks = settings.filter(scope => trackOf(scope) && !added.has(scope.comp))
  if (tracks.length) parts.push(plural(tracks.length, 'track'))
  const media = settings.filter(scope => scope.asset != null)
  if (media.length) parts.push(plural(media.length, 'media file'))
  const text = parts.join(', ')
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : ''
}

const KINDS = [
  [/^(start)$/, 'move'], [/^(dur|in)$/, 'trim'], [/^transitionIn/, 'transition'], [/^anim/, 'keyframes'], [/^title/, 'title'], [/^text$|^words/, 'caption'],
  [/^(volume|pan|eq|fadeIn|fadeOut|mute|afx)/, 'sound'], [/^(grade|nodes|key)/, 'grade'], [/^fx/, 'effect'], [/^speed|^reverse/, 'speed'],
  [/^(x|y|scale|scaleX|scaleY|rotation|opacity|crop|anchorX|anchorY|blend)/, 'transform'], [/^track$/, 'move'],
]

/**
 * What a run changed, as a count and a few plain words for the card title: "4 changes: trim,
 * transition, title, marker". A clip trimmed from its left edge moves and shortens; that is a trim.
 */
export function changeKinds(receipts = []) {
  const kinds = []
  let count = 0
  const add = kind => { if (!kinds.includes(kind)) kinds.push(kind) }
  for (const receipt of receipts) {
    for (const clip of receipt.clips ?? []) {
      count++
      if (clip.status !== 'changed') {
        const whole = parse(clip.changes?.[0]?.[clip.status === 'added' ? 'after' : 'before'])
        const kind = whole.value?.kind === 'title' || /"kind":"title"/.test(clip.changes?.[0]?.after ?? clip.changes?.[0]?.before ?? '') ? 'title' : /"kind":"caption"/.test(clip.changes?.[0]?.after ?? clip.changes?.[0]?.before ?? '') ? 'caption' : 'clip'
        add(clip.status === 'added' ? `new ${kind}` : `removed ${kind}`)
        continue
      }
      const found = new Set((clip.changes ?? []).map(change => KINDS.find(([pattern]) => pattern.test(change.property))?.[1] ?? 'clip'))
      if (found.has('trim')) found.delete('move')
      for (const kind of found) add(kind)
    }
    for (const scope of receipt.scopes ?? []) {
      const changes = (scope.changes ?? []).filter(change => change.property !== 'Object order')
      // A timeline that only got longer or shorter follows from the clips already counted.
      if (!changes.length || changes.every(change => change.property === 'duration')) continue
      count++
      if (scope.asset != null || changes.every(change => /^assets\b/.test(change.property))) add('media')
      else if (scope.track != null) add(scope.status === 'added' ? 'new track' : scope.status === 'deleted' ? 'removed track' : 'track')
      else if (scope.comp != null && scope.status !== 'changed') add(scope.status === 'added' ? 'new composition' : 'removed composition')
      else if (changes.every(change => change.property === 'markers')) add('marker')
      else add('settings')
    }
  }
  const shown = kinds.slice(0, 4)
  return { count, kinds, text: count ? `${plural(count, 'change')}${shown.length ? `: ${shown.join(', ')}${kinds.length > shown.length ? ' and more' : ''}` : ''}` : '' }
}

/** Seconds as the ruler reads them: 0:01, 1:05. */
export function clock(seconds) {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
