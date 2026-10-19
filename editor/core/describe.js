// Plain-language descriptions of a project for assistants: the selection, what is under the
// playhead, and each clip's timing, transform, grade, effects, keyframes and text, in the
// terms an editor uses. outline() lists every clip in one line; this explains the clips in focus.

import { clipEnd, compDuration, duration, round, timecode } from './project.js'

const DEFAULT_LIMIT = 24 * 1024
const MAX_CLIPS = 24
const MAX_KEYS = 12

const num = value => typeof value === 'number' && Number.isFinite(value) ? String(round(value, 3)) : JSON.stringify(value)
const signed = value => value > 0 ? `+${num(value)}` : num(value)
const quote = text => `"${String(text ?? '').replace(/\s+/g, ' ').slice(0, 120)}"`
const fileName = src => String(src ?? '').split('/').pop()
const list = items => items.filter(Boolean).join(', ')

function timeline(p, comp) {
  if (!comp) return { name: 'Main timeline', tracks: p.tracks ?? [], width: p.width, height: p.height, fps: p.fps, markers: p.markers ?? [], length: duration(p) }
  const k = Object.hasOwn(p.comps ?? {}, comp) ? p.comps[comp] : null
  if (!k) return null
  return { name: `Composition ${quote(k.name ?? comp)} (${comp})`, tracks: k.tracks ?? [], width: k.width ?? p.width, height: k.height ?? p.height, fps: k.fps ?? p.fps, markers: k.markers ?? [], length: compDuration(k) }
}

function locate(p, id) {
  for (const [comp, scope] of [[null, p], ...Object.entries(p.comps ?? {})]) {
    for (const track of scope.tracks ?? []) {
      const clip = (track.clips ?? []).find(c => c.id === id)
      if (clip) return { clip, track, comp }
    }
  }
  return null
}

/** A short human name for a clip: its label, title text, media file or kind. */
export function clipName(p, c) {
  if (c.label) return c.label
  if (c.kind === 'title') return c.title?.text ?? 'Title'
  if (c.kind === 'caption') return c.text ?? 'Caption'
  if (c.kind === 'comp') return (Object.hasOwn(p.comps ?? {}, c.comp) ? p.comps[c.comp].name : null) ?? c.comp
  if (c.kind === 'color') return `Color ${c.color ?? ''}`.trim()
  if (c.kind === 'adjustment') return 'Adjustment layer'
  if (c.kind === 'shape') return `${c.shape?.type ?? 'Shape'} shape`
  if (c.src) return fileName(c.src)
  return c.kind
}

function trackName(track) {
  return track.name ? `${track.id} ${track.name}` : track.id
}

function gradeLine(grade) {
  if (!grade || typeof grade !== 'object') return ''
  const parts = []
  for (const key of ['exposure', 'contrast', 'pivot', 'saturation', 'hue', 'temperature', 'tint', 'highlights', 'shadows', 'whites', 'blacks']) {
    if (typeof grade[key] === 'number') parts.push(`${key} ${['exposure', 'temperature', 'tint', 'hue', 'highlights', 'shadows', 'whites', 'blacks'].includes(key) ? signed(grade[key]) : num(grade[key])}`)
  }
  for (const key of ['lift', 'gamma', 'gain', 'offset']) if (Array.isArray(grade[key])) parts.push(`${key} [${grade[key].map(num).join(', ')}]`)
  if (grade.curves && typeof grade.curves === 'object') {
    const channels = Object.entries(grade.curves).filter(([, points]) => Array.isArray(points) && points.length)
    if (channels.length) parts.push(`curves on ${channels.map(([channel, points]) => `${channel} (${points.length} points)`).join(', ')}`)
  }
  if (grade.look && grade.look !== 'none') parts.push(`look ${grade.look}`)
  if (grade.lut) parts.push(`LUT ${fileName(grade.lut)}${typeof grade.lutMix === 'number' && grade.lutMix !== 1 ? ` at ${Math.round(grade.lutMix * 100)}%` : ''}`)
  return parts.join(', ')
}

function keyframeLine(p, c, prop, keys, fps) {
  const sorted = [...keys].sort((a, b) => a[0] - b[0])
  const shown = sorted.slice(0, MAX_KEYS).map(([t, value, ease]) => {
    const at = timecode(c.start + t, fps)
    const display = prop === 'scale' || prop === 'scaleX' || prop === 'scaleY' || prop === 'opacity' ? `${num(value * 100)}%` : prop === 'rotation' ? `${num(value)}°` : prop === 'volume' ? `${num(value)} dB` : num(value)
    return `${at} ${display}${ease && ease !== 'linear' ? ` (${Array.isArray(ease) ? 'custom curve' : ease})` : ''}`
  })
  return `${prop}: ${shown.join(' → ')}${sorted.length > MAX_KEYS ? ` and ${sorted.length - MAX_KEYS} more` : ''}`
}

function transformLine(p, c, view) {
  const parts = []
  if (typeof c.x === 'number' && round(c.x, 2) !== round(view.width / 2, 2)) parts.push(`x ${num(c.x)} px`)
  if (typeof c.y === 'number' && round(c.y, 2) !== round(view.height / 2, 2)) parts.push(`y ${num(c.y)} px`)
  if (typeof c.scale === 'number' && c.scale !== 1) parts.push(`scale ${num(c.scale * 100)}%`)
  if (typeof c.scaleX === 'number' && c.scaleX !== 1) parts.push(`stretch x ${num(c.scaleX * 100)}%`)
  if (typeof c.scaleY === 'number' && c.scaleY !== 1) parts.push(`stretch y ${num(c.scaleY * 100)}%`)
  if (typeof c.rotation === 'number' && c.rotation !== 0) parts.push(`rotation ${num(c.rotation)}°`)
  if (typeof c.anchorX === 'number' && c.anchorX !== 0) parts.push(`anchor x ${num(c.anchorX)}`)
  if (typeof c.anchorY === 'number' && c.anchorY !== 0) parts.push(`anchor y ${num(c.anchorY)}`)
  if (typeof c.opacity === 'number' && c.opacity !== 1) parts.push(`opacity ${num(c.opacity * 100)}%`)
  if (c.blend && c.blend !== 'normal') parts.push(`blend ${c.blend}`)
  if (c.crop && Object.values(c.crop).some(v => v)) parts.push(`crop ${['l', 'r', 't', 'b'].map(side => `${side} ${num((c.crop[side] ?? 0) * 100)}%`).join(' ')}`)
  if (c.parent) parts.push(`parented to ${c.parent}`)
  return parts.join(', ')
}

function audioLine(c) {
  const parts = []
  if (typeof c.volume === 'number' && c.volume !== 0) parts.push(`volume ${signed(c.volume)} dB`)
  if (typeof c.pan === 'number' && c.pan !== 0) parts.push(`pan ${num(c.pan)}`)
  if (c.eq && Object.values(c.eq).some(v => v)) parts.push(`EQ ${Object.entries(c.eq).map(([band, gain]) => `${band} ${signed(gain)} dB`).join(' ')}`)
  if (c.fadeIn) parts.push(`fade in ${num(c.fadeIn)} s`)
  if (c.fadeOut) parts.push(`fade out ${num(c.fadeOut)} s`)
  if (c.mute) parts.push('muted')
  const chain = fxLine(c.fx)
  if (chain) parts.push(`effects ${chain}`)
  return parts.join(', ')
}

/** An audio effect chain in order: type and parameters, EQ as its bands. */
export function fxLine(fx) {
  if (!Array.isArray(fx) || !fx.length) return ''
  return fx.map((effect, i) => {
    const off = effect?.enabled === false ? ' off' : ''
    const params = effect?.params ?? {}
    if (effect?.type === 'eq') return `[${i}] EQ${off} (${(params.bands ?? []).map(b => `${b.type} ${num(b.freq)} Hz${b.gain ? ` ${signed(b.gain)} dB` : ''}`).join(', ') || 'flat'})`
    const values = Object.entries(params).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${num(v)}`)
    return `[${i}] ${effect?.type ?? 'effect'}${off}${values.length ? ` (${values.join(', ')})` : ''}`
  }).join('; ')
}

/** Tracks with settings beyond their defaults, caption styling, and the master bus. */
function mixLines(p, scope) {
  const lines = []
  for (const track of scope.tracks ?? []) {
    const parts = []
    if (track.muted) parts.push('muted'); if (track.solo) parts.push('solo'); if (track.hidden) parts.push('hidden'); if (track.locked) parts.push('locked')
    if (typeof track.volume === 'number' && track.volume !== 0) parts.push(`volume ${signed(track.volume)} dB`)
    if (typeof track.pan === 'number' && track.pan !== 0) parts.push(`pan ${num(track.pan)}`)
    const chain = fxLine(track.fx)
    if (chain) parts.push(`effects ${chain}`)
    if (track.kind === 'caption') {
      const style = track.style ?? {}
      parts.push(track.burnIn ? 'burned in' : 'not burned in')
      const look = list([style.font, style.weight && `weight ${style.weight}`, typeof style.size === 'number' && `${num(style.size)} px`, style.color, style.highlight && `highlight ${style.highlight}`, style.plate && `plate ${style.plate}`, typeof style.y === 'number' && `at ${Math.round(style.y * 100)}% height`])
      if (look) parts.push(`style ${look}`)
    }
    if (parts.length) lines.push(`- ${trackName(track)} (${track.kind}): ${parts.join(', ')}`)
  }
  const master = p.master
  if (master && typeof master === 'object') {
    const parts = []
    if (typeof master.volume === 'number' && master.volume !== 0) parts.push(`volume ${signed(master.volume)} dB`)
    const chain = fxLine(master.fx)
    if (chain) parts.push(`effects ${chain}`)
    const limiter = master.limiter
    if (limiter && limiter.enabled !== false) parts.push(`limiter ceiling ${num(limiter.ceiling ?? -1)} dBTP, release ${num(limiter.release ?? 60)} ms`)
    if (typeof master.target === 'number') parts.push(`loudness target ${num(master.target)} LUFS`)
    if (parts.length) lines.push(`- Master: ${parts.join(', ')}`)
  }
  return lines
}

function titleLine(t) {
  if (!t) return ''
  const style = list([t.font, t.weight && `weight ${t.weight}`, typeof t.size === 'number' && `${num(t.size)} px`, t.color, t.align && `${t.align} aligned`, t.plate && `plate ${t.plate}`, t.stroke && `stroke ${t.stroke.color ?? ''} ${num(t.stroke.width ?? 0)} px`.trim(), t.shadow && 'shadow', t.anim && t.anim !== 'none' && `animation ${t.anim}`])
  return `${quote(t.text)}${style ? `; ${style}` : ''}`
}

function shapeLine(s) {
  if (!s) return ''
  const fill = s.fill?.color ? `fill ${s.fill.color}` : s.fill?.gradient ? `${s.fill.gradient.type ?? 'linear'} gradient fill` : ''
  return list([s.type, typeof s.width === 'number' && `${num(s.width)}x${num(s.height ?? 0)} px`, typeof s.radius === 'number' && s.radius && `radius ${num(s.radius)}`, fill, s.stroke && `stroke ${s.stroke.color ?? ''} ${num(s.stroke.width ?? 0)} px`.trim(), s.trim && `trim ${num((s.trim.start ?? 0) * 100)}% to ${num((s.trim.end ?? 1) * 100)}%`])
}

/** Every detail an editor would read in the inspector for one clip, as indented lines. */
export function describeClipDetail(p, id, { comp: requested } = {}) {
  const found = locate(p, id)
  if (!found) return [`${id}: not found in this project`]
  const { clip: c, track, comp } = found
  const view = timeline(p, comp) ?? timeline(p, null)
  const fps = view.fps
  const where = comp ? ` in ${view.name}` : requested ? ' on the main timeline' : ''
  const lines = [`${c.id} ${c.kind} ${quote(clipName(p, c))} on ${trackName(track)}${where}, ${timecode(c.start, fps)} to ${timecode(clipEnd(c), fps)} (${num(c.dur)} s)${c.enabled === false ? ', disabled' : ''}`]
  const add = (label, text) => { if (text) lines.push(`  ${label}: ${text}`) }
  if (c.src) {
    const asset = p.assets?.[c.src]
    const speed = c.speed && c.speed !== 1 ? `, speed ${num(c.speed * 100)}%` : ''
    add('Source', `${c.src} from ${timecode(c.in ?? 0, fps)} to ${timecode((c.in ?? 0) + c.dur * (c.speed ?? 1), fps)}${speed}${c.reverse ? ', reversed' : ''}${c.freeze !== undefined ? `, frozen at ${num(c.freeze)} s` : ''}`)
    if (asset) add('Media', list([asset.width && `${asset.width}x${asset.height}`, asset.fps && `${num(asset.fps)} fps`, typeof asset.duration === 'number' && `${num(asset.duration)} s long`, asset.codec, asset.hasAudio ? 'has audio' : asset.hasVideo === false ? '' : 'no audio']))
  }
  if (c.link) {
    const linked = [p, ...Object.values(p.comps ?? {})].flatMap(scope => (scope.tracks ?? []).flatMap(t => (t.clips ?? []).filter(other => other.link === c.link && other.id !== c.id).map(other => `${other.id} (${other.kind} on ${t.id})`)))
    add('Linked with', linked.join(', '))
  }
  if (c.kind === 'comp') add('Composition', `${c.comp} ${quote((Object.hasOwn(p.comps ?? {}, c.comp) ? p.comps[c.comp].name : null) ?? c.comp)}`)
  if (c.kind === 'title') add('Title', titleLine(c.title))
  if (c.kind === 'caption') add('Caption', `${quote(c.text)}${Array.isArray(c.words) ? `, ${c.words.length} timed words` : ''}`)
  if (c.kind === 'shape') add('Shape', shapeLine(c.shape))
  if (c.kind === 'color') add('Color', c.color)
  if (c.kind === 'multicam') add('Multicam', `${(c.angles ?? []).map((angle, i) => `${i}: ${angle.label ?? fileName(angle.src)}`).join(', ')}; ${(c.cuts ?? []).length} cuts`)
  add('Transform', transformLine(p, c, view))
  add('Audio', audioLine(c))
  add('Grade', gradeLine(c.grade))
  if (c.key) add('Keyer', list([c.key.color && `key color ${c.key.color}`, typeof c.key.similarity === 'number' && `similarity ${num(c.key.similarity)}`, typeof c.key.smoothness === 'number' && `smoothness ${num(c.key.smoothness)}`, typeof c.key.spill === 'number' && `spill ${num(c.key.spill)}`]))
  const nodes = (c.nodes?.list ?? []).filter(n => !['source', 'primary', 'output'].includes(n.type))
  if (nodes.length) add('Color nodes', nodes.map(n => `${n.id} ${n.type}${n.grade ? ` (${gradeLine(n.grade)})` : ''}${n.qualifier ? ' with qualifier' : ''}${n.window ? ` with ${n.window.type ?? ''} window`.replace('  ', ' ') : ''}`).join('; '))
  if (Array.isArray(c.effects) && c.effects.length) add('Effects', c.effects.map((e, i) => `[${i}] ${e.type}${e.enabled === false ? ' (off)' : ''}${e.params && Object.keys(e.params).length ? ` (${Object.entries(e.params).map(([k, v]) => `${k} ${num(v)}`).join(', ')})` : ''}`).join('; '))
  if (c.transitionIn) add('Transition in', `${c.transitionIn.type}, ${num(c.transitionIn.dur)} s centered on ${timecode(c.start, fps)}`)
  if (Array.isArray(c.masks) && c.masks.length) add('Masks', c.masks.map(m => list([`${m.id} ${m.type}`, m.mode && m.mode !== 'add' && m.mode, m.inverted && 'inverted', typeof m.feather === 'number' && m.feather && `feather ${num(m.feather)}`])).join('; '))
  if (c.matte) add('Track matte', `${c.matte.mode}${c.matte.source ? ` from ${c.matte.source}` : ' from the layer above'}`)
  for (const [prop, keys] of Object.entries(c.anim ?? {})) if (Array.isArray(keys) && keys.length) add('Keyframes', keyframeLine(p, c, prop, keys, fps))
  for (const [prop, expr] of Object.entries(c.expr ?? {})) if (expr) add('Expression', `${prop} = ${expr}`)
  if (c.note) add('Note', quote(c.note))
  return lines
}

/** The layers at timeline time t in a timeline, top track first, with the source frame shown. */
export function describeAt(p, t, { comp = null } = {}) {
  const view = timeline(p, comp) ?? timeline(p, null)
  const lines = []
  const tracks = [...view.tracks]
  const video = tracks.filter(track => track.kind === 'video').reverse()
  for (const track of [...video, ...tracks.filter(track => track.kind !== 'video')]) {
    const flags = [track.hidden && 'hidden', track.muted && 'muted', track.locked && 'locked', track.solo && 'solo'].filter(Boolean)
    const hits = (track.clips ?? []).filter(c => c.start <= t && clipEnd(c) > t)
    if (!hits.length) continue
    for (const c of hits) {
      const local = t - c.start
      const source = c.src ? `, source frame ${timecode((c.in ?? 0) + local * (c.speed ?? 1), view.fps)}` : ''
      lines.push(`- ${trackName(track)}${flags.length ? ` (${flags.join(', ')})` : ''}: ${c.id} ${c.kind} ${quote(clipName(p, c))}, ${num(local)} s into the clip${source}${c.enabled === false ? ', disabled' : ''}`)
    }
  }
  return lines
}

/**
 * What the editor is looking at: the open timeline, the playhead and the layers under it,
 * nearby markers, every selected clip in detail, and the compositions in the project.
 */
export function describeFocus(p, { selection = [], playhead = 0, comp = null, limit = DEFAULT_LIMIT } = {}) {
  if (!p) return 'No project is open.'
  const scope = comp && Object.hasOwn(p.comps ?? {}, comp) ? comp : null
  const view = timeline(p, scope)
  const t = Number.isFinite(playhead) ? Math.max(0, playhead) : 0
  const lines = [`Open: ${view.name}, ${view.width}x${view.height} at ${num(view.fps)} fps, ${timecode(view.length, view.fps)} long (${num(view.length)} s).`]
  lines.push(`Playhead: ${timecode(t, view.fps)} (${num(t)} s).`)
  const under = describeAt(p, t, { comp: scope })
  lines.push(under.length ? 'Under the playhead, top layer first:' : 'Under the playhead: nothing (a gap or past the end).', ...under)
  const near = (view.markers ?? []).filter(m => Math.abs(m.t - t) <= 2)
  if (near.length) lines.push(`Markers within 2 s: ${near.map(m => `${m.id} ${quote(m.label)} at ${timecode(m.t, view.fps)}`).join(', ')}`)
  if (p.range && !scope) lines.push(`In and out range: ${timecode(p.range.in, view.fps)} to ${timecode(p.range.out, view.fps)}.`)
  const ids = [...new Set((selection ?? []).map(id => String(id)))]
  const clipIds = ids.filter(id => !id.startsWith('tr:'))
  const transitions = ids.filter(id => id.startsWith('tr:')).map(id => id.slice(3))
  if (!ids.length) lines.push('Selection: nothing selected. Edits without a named target apply to the whole open timeline.')
  else lines.push(`Selection: ${clipIds.length} ${clipIds.length === 1 ? 'clip' : 'clips'}${transitions.length ? ` and ${transitions.length} ${transitions.length === 1 ? 'transition' : 'transitions'}` : ''}.`)
  for (const id of clipIds.slice(0, MAX_CLIPS)) lines.push(...describeClipDetail(p, id, { comp: scope }))
  if (clipIds.length > MAX_CLIPS) lines.push(`(${clipIds.length - MAX_CLIPS} more selected clips. Use GET /api/describe?ids=... for them.)`)
  for (const id of transitions) {
    const found = locate(p, id)
    lines.push(found?.clip.transitionIn ? `Transition into ${id}: ${found.clip.transitionIn.type}, ${num(found.clip.transitionIn.dur)} s` : `Transition into ${id}: none`)
  }
  const mix = mixLines(p, scope ? p.comps[scope] : p)
  if (mix.length) lines.push('Tracks and mix (settings that differ from the defaults):', ...mix)
  const comps = Object.entries(p.comps ?? {})
  if (comps.length) {
    lines.push('Compositions:')
    for (const [id, k] of comps) {
      const clips = (k.tracks ?? []).flatMap(track => track.clips ?? [])
      const users = [p, ...Object.values(p.comps ?? {})].flatMap(scope => (scope.tracks ?? []).flatMap(track => (track.clips ?? []).filter(c => c.kind === 'comp' && c.comp === id).map(c => c.id)))
      lines.push(`- ${id} ${quote(k.name ?? id)}: ${k.width ?? p.width}x${k.height ?? p.height}, ${num(compDuration(k))} s, ${(k.tracks ?? []).length} ${(k.tracks ?? []).length === 1 ? 'track' : 'tracks'}, ${clips.length} ${clips.length === 1 ? 'layer' : 'layers'}${clips.length ? ` (${clips.slice(0, 8).map(c => `${c.id} ${c.kind} ${quote(clipName(p, c))}`).join(', ')}${clips.length > 8 ? ', …' : ''})` : ''}; ${users.length ? `placed as ${users.join(', ')}` : 'not placed on a timeline'}`)
    }
  }
  return bound(lines.join('\n'), limit)
}

function bound(text, limit) {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit - 80)
  return `${cut.slice(0, cut.lastIndexOf('\n'))}\n(Shortened. Use GET /api/describe?ids=...&at=... for the rest.)`
}

/** The /api/describe answer: named clips in detail and, optionally, the layers at a time. */
export function describeRequest(p, { ids = [], at, comp = null } = {}) {
  if (!p) return 'No project is open.'
  if (comp && !Object.hasOwn(p.comps ?? {}, comp)) throw new Error(`no composition ${comp}`)
  const lines = []
  if (Number.isFinite(at)) {
    const view = timeline(p, comp)
    const under = describeAt(p, at, { comp })
    lines.push(`At ${timecode(at, view.fps)} (${num(at)} s) in ${view.name}:`, ...(under.length ? under : ['- nothing']))
  }
  for (const id of ids.slice(0, MAX_CLIPS * 2)) lines.push(...describeClipDetail(p, id, { comp }))
  if (!lines.length) return describeFocus(p, { comp })
  return bound(lines.join('\n'), DEFAULT_LIMIT * 2)
}
