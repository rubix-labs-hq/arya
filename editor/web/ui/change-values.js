// Receipt values as a person reads them. A receipt stores each value as bounded JSON text; this turns
// it into words at display time: seconds with a timecode, one line per keyframe, a colour with its
// swatch, and plain lists for objects. It never shows JSON, and a value cut short says so.

import { timecode } from '../../core/project.js'

const TIMES = new Set(['start', 'dur', 'in', 'duration'])
const WHOLE = { layer: 'Layer', track: 'Track', composition: 'Composition' }
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const CUT = 'Too long to show here'
const MAX_FIELDS = 6

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
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

function plain(value, depth = 0) {
  if (value === null) return 'None'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (typeof value === 'number') return Number.isFinite(value) ? number(value) : String(value)
  if (typeof value === 'string') return value === '' ? 'Empty' : value
  if (Array.isArray(value)) {
    if (!value.length) return 'None'
    if (value.every(item => item === null || typeof item !== 'object')) return value.map(item => plain(item)).join(', ')
    if (value.every(item => typeof item?.type === 'string')) return value.map(item => item.type).join(', ')
    return plural(value.length, 'item')
  }
  if (depth > 1) return '…'
  const entries = Object.entries(value)
  if (!entries.length) return 'None'
  const shown = entries.slice(0, MAX_FIELDS).map(([key, item]) => {
    const text = plain(item, depth + 1)
    return item !== null && typeof item === 'object' && !Array.isArray(item) ? `${key} (${text})` : `${key} ${text}`
  })
  return `${shown.join(', ')}${entries.length > MAX_FIELDS ? `, ${plural(entries.length - MAX_FIELDS, 'more setting')}` : ''}`
}

const isKeys = value => Array.isArray(value) && value.length > 0 && value.every(key => Array.isArray(key) && key.length >= 2 && key.length <= 3 && Number.isFinite(key[0]))
const easeName = ease => ease == null ? 'linear' : Array.isArray(ease) ? 'custom curve' : String(ease)

/** Before and after keyframes paired by time, so one added key does not mark every later key changed. */
function keyRows(before, after) {
  const index = keys => new Map((keys ?? []).map(key => [number(key[0]), key]))
  const old = index(before), next = index(after)
  const times = [...new Set([...old.keys(), ...next.keys()])].sort((a, b) => Number(a) - Number(b))
  const rows = []
  for (const time of times) {
    const a = old.get(time), b = next.get(time)
    const value = key => `${plain(key[1])}, ${easeName(key[2])}`
    if (a && b && value(a) === value(b)) continue
    rows.push({ time: `at ${seconds(Number(time))}`, before: a ? value(a) : '', after: b ? value(b) : '', status: !a ? 'added' : !b ? 'removed' : 'changed' })
  }
  return rows
}

function side(parsed, property, fps) {
  if (parsed.missing) return { text: 'None' }
  if (parsed.cut) return { text: CUT }
  const value = parsed.value
  if (typeof value === 'number' && Number.isFinite(value) && TIMES.has(property)) return { text: `${seconds(value)} · ${timecode(value, fps)}` }
  if (typeof value === 'string' && HEX.test(value)) return { text: value, swatch: value }
  return { text: plain(value) }
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
  if (keyed && (before.cut || after.cut)) return { property, label: property, only: `Keyframes ${CUT.toLowerCase()}` }
  if (keyed && (before.missing || isKeys(before.value)) && (after.missing || isKeys(after.value))) {
    return { property, label: property, keys: keyRows(before.value, after.value) }
  }
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30
  const old = side(before, property, rate), next = side(after, property, rate)
  return { property, label: property, before: old.text, after: next.text, swatches: old.swatch || next.swatch ? [old.swatch ?? null, next.swatch ?? null] : null }
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
