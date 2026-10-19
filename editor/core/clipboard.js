// Shared paste admission. Clip payloads keep editable metadata; links get a fresh
// identity per paste so editing a pasted pair never edits the original pair.
import { parse } from './expr.js'

const fail = message => { throw new Error(`paste: ${message}`) }
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
function json(value, depth = 0) {
  if (depth > 64) fail('clip metadata is too deeply nested')
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('clip metadata contains a nonfinite number'); return }
  if (value === undefined || value === null || ['string', 'boolean'].includes(typeof value)) return
  if (Array.isArray(value)) { for (const item of value) json(item, depth + 1); return }
  if (!plain(value)) fail('clip metadata must be plain JSON')
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('clip metadata has an unsafe key')
    json(item, depth + 1)
  }
}
function expression(source, resolve) {
  const tree = parse(source), strings = [], replacements = new Map()
  const names = node => {
    if (node?.k === 'str') replacements.set(node, resolve(node.v))
    else if (node?.k === 'cond') { names(node.a); names(node.b) }
    else fail('layer expressions need a literal or conditional layer name')
  }
  const visit = node => {
    if (node.k === 'str') strings.push(node)
    else if (node.k === 'bin') { visit(node.left); visit(node.right) }
    else if (node.k === 'un') visit(node.arg)
    else if (node.k === 'cond') { visit(node.test); visit(node.a); visit(node.b) }
    else if (node.k === 'member') visit(node.obj)
    else if (node.k === 'call') { if (node.name === 'layer') names(node.args[0]); node.args.forEach(visit) }
  }
  visit(tree)
  let i = 0
  const remapped = source.replace(/(["'])([\s\S]*?)\1/g, literal => {
    const node = strings[i++]
    return replacements.has(node) && replacements.get(node) !== node.v ? JSON.stringify(replacements.get(node)) : literal
  })
  parse(remapped)
  return remapped
}

export function pasteClips(p, op, nextId) {
  const at = op.at ?? 0, items = op.clips
  if (!Number.isFinite(at) || at < 0 || !Array.isArray(items) || items.length > 1000) fail('choose a finite playhead and at most 1000 clips')
  json(items)
  if (JSON.stringify(items).length > 4 * 1024 * 1024) fail('clip metadata exceeds 4 MB')
  if (!Number.isFinite(p.fps) || p.fps <= 0) fail('timeline frame rate is invalid')
  const strict = op.clipboard === true
  const plans = items.map(raw => {
    if (!plain(raw) || !plain(raw.clip)) fail('each item needs a clip object')
    const kind = raw.clip.kind === 'audio' ? 'audio' : raw.clip.kind === 'caption' ? 'caption' : 'video'
    const matching = p.tracks.find(t => t.id === raw.track && t.kind === kind)
    const track = matching && !matching.locked ? matching : strict ? null : p.tracks.find(t => t.kind === kind && !t.locked)
    if (!track) fail('choose an unlocked destination track for every clip')
    if (!Number.isFinite(raw.offset) || raw.offset < 0 || !Number.isFinite(raw.clip.dur) || raw.clip.dur < 1 / p.fps - .0001 || at + raw.offset + raw.clip.dur >= 1_000_000) fail('clip timing is invalid')
    if (!['video', 'audio', 'image', 'title', 'shape', 'null', 'adjustment', 'comp', 'multicam', 'caption'].includes(raw.clip.kind)) fail('clip kind is invalid')
    if (strict) {
      const sources = [raw.clip.src, ...(raw.clip.angles ?? []).map(a => a.src)].filter(Boolean)
      if (sources.some(src => typeof src !== 'string' || !Object.hasOwn(p.assets, src))) fail('a copied media source was removed')
      if (raw.clip.kind === 'comp') {
        const seen = new Set()
        const contains = id => {
          if (id === op.scope) return true
          if (seen.has(id)) return false
          seen.add(id)
          const comp = p.comps?.[id]
          if (!comp) fail('a copied composition was removed')
          return (comp.tracks ?? []).some(t => (t.clips ?? []).some(c => c.kind === 'comp' && contains(c.comp)))
        }
        if (typeof raw.clip.comp !== 'string' || contains(raw.clip.comp)) fail('pasting this composition would make a cycle')
      }
    }
    return { track, clip: structuredClone(raw.clip), offset: raw.offset }
  })
  const first = Number(nextId(p, 'c').slice(1))
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(first + plans.length)) fail('clip IDs are exhausted')
  const ids = new Map(), links = new Map(), usedLinks = new Set([...(p.__rootTracks ?? p.tracks), ...Object.values(p.comps ?? {}).flatMap(c => c.tracks ?? [])].flatMap(t => t.clips.map(c => c.link)).filter(Boolean))
  plans.forEach(({ clip }, i) => {
    if (strict && (typeof clip.id !== 'string' || !clip.id || ids.has(clip.id))) fail('copied clip IDs must be unique')
    ids.set(clip.id, `c${first + i}`)
  })
  const originals = items.map(i => i.clip), current = p.tracks.flatMap(t => t.clips)
  const resolveID = id => {
    if (ids.has(id)) return ids.get(id)
    if (current.filter(c => c.id === id).length !== 1) fail(`layer dependency ${id} is missing or ambiguous`)
    return id
  }
  const resolve = name => {
    const matches = clip => clip.id === name || clip.label === name || clip.title?.text === name
    // Core layerValues accepts all three aliases in track order. Refuse ambiguous
    // names instead of preferring an ID and silently changing the original binding.
    const copied = originals.filter(matches)
    const retained = current.filter(c => !ids.has(c.id) && matches(c))
    if (copied.length + retained.length !== 1) fail(`layer dependency ${name} is missing or ambiguous`)
    return copied.length ? ids.get(copied[0].id) : name
  }
  plans.forEach(({ clip, offset }, i) => {
    if (strict) {
      if (clip.parent) clip.parent = resolveID(clip.parent)
      if (clip.matte?.source) clip.matte.source = resolveID(clip.matte.source)
      if (clip.source?.clip) clip.source.clip = resolveID(clip.source.clip)
      if (clip.expr) clip.expr = Object.fromEntries(Object.entries(clip.expr).map(([key, value]) => [key, expression(value, resolve)]))
    }
    if (clip.link) {
      if (!links.has(clip.link)) { let link = `Lc${first + i}`; while (usedLinks.has(link)) link += '_'; links.set(clip.link, link); usedLinks.add(link) }
      clip.link = links.get(clip.link)
    }
    clip.id = `c${first + i}`
    clip.start = Math.round(Math.round((at + offset) * p.fps) / p.fps * 100000) / 100000
  })
  if (strict) {
    const byID = new Map([...current, ...plans.map(p => p.clip)].map(c => [c.id, c]))
    for (const { clip } of plans) {
      const seen = new Set([clip.id])
      for (let id = clip.parent; id; id = byID.get(id)?.parent) {
        if (seen.has(id) || seen.size > 64) fail('parenting would make a cycle')
        seen.add(id)
      }
    }
  }
  for (const { track, clip } of plans) { track.clips.push(clip); track.clips.sort((a, b) => a.start - b.start) }
  return plans.map(p => p.clip.id)
}
