const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const bytes = value => new TextEncoder().encode(value).length
const MAX_RECEIPT_BYTES = 128 * 1024
const MAX_ENTRIES = 80
const MAX_CHANGES = 50
const validIdentifier = value => typeof value === 'string' && value.length > 0 && bytes(value) <= 512

function same(a, b) {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => same(value, b[i]))
  if (!record(a) || !record(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && same(a[key], b[key]))
}

function bounded(value, limit) {
  const text = String(value)
  if (bytes(text) <= limit) return { text, truncated: false }
  let result = '', size = 0
  for (const character of text) {
    const length = bytes(character)
    if (size + length > limit - 3) break
    result += character; size += length
  }
  return { text: `${result}…`, truncated: true }
}

function timelines(project) {
  return [[null, project], ...Object.entries(project?.comps ?? {})]
}

function indexClips(project) {
  const result = new Map()
  for (const [comp, timeline] of timelines(project)) {
    for (const track of timeline?.tracks ?? []) for (const clip of track.clips ?? []) {
      result.set(JSON.stringify([comp, clip.id]), { clip, comp, track: track.id, compositionName: comp == null ? 'Main timeline' : timeline.name ?? comp })
    }
  }
  return result
}

function preview(value) {
  return bounded(value === undefined ? 'Absent' : JSON.stringify(value), 1024)
}

function propertyPath(path, key) {
  return /^[a-zA-Z_$][\w$]*$/.test(key) ? path ? `${path}.${key}` : key : `${path}[${JSON.stringify(key)}]`
}

function differences(before, after, path = '', depth = 0, result = { changes: [], truncated: false }) {
  if (same(before, after)) return result
  if (result.changes.length >= MAX_CHANGES) { result.truncated = true; return result }
  if (depth < 8 && record(before) && record(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    if (keys.every(key => bytes(propertyPath(path, key)) <= 512)) {
      for (const key of keys) differences(own(before, key) ? before[key] : undefined, own(after, key) ? after[key] : undefined, propertyPath(path, key), depth + 1, result)
      return result
    }
    result.truncated = true
  }
  if (depth >= 8 && record(before) && record(after)) result.truncated = true
  const previous = preview(before), current = preview(after)
  result.changes.push({ property: path || 'layer', before: previous.text, after: current.text })
  result.truncated ||= previous.truncated || current.truncated
  return result
}

const metadata = (value, excluded) => value === undefined ? undefined : Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.includes(key)))

function appendOrder(before, after, property, result) {
  if (same(before, after)) return
  if (result.changes.length >= MAX_CHANGES) { result.truncated = true; return }
  const previous = preview(before), current = preview(after)
  result.changes.push({ property, before: previous.text, after: current.text })
  result.truncated ||= previous.truncated || current.truncated
}

/** A factual receipt for one committed project event. It cannot undo a historical batch. */
export function changeReceipt(before, after, { version, who, at = Date.now() } = {}) {
  if (!before || !after || !['agent', 'claude'].includes(who)) return null
  const oldClips = indexClips(before), newClips = indexClips(after)
  const clips = [], scopes = [], projectChanges = []
  let total = 0, totalScopes = 0, totalAssets = 0, truncated = false
  let remaining = MAX_RECEIPT_BYTES - 18 * 1024
  for (const key of new Set([...oldClips.keys(), ...newClips.keys()])) {
    const old = oldClips.get(key), next = newClips.get(key)
    if (old && next && old.track === next.track && same(old.clip, next.clip)) continue
    total++
    const source = next ?? old
    if (clips.length >= MAX_ENTRIES || !validIdentifier(source.clip.id) || source.comp != null && !validIdentifier(source.comp)) { truncated = true; continue }
    const diff = differences(old?.clip, next?.clip)
    if (old && next && old.track !== next.track) {
      const previous = preview(old.track), current = preview(next.track)
      diff.changes.unshift({ property: 'track', before: previous.text, after: current.text })
      if (diff.changes.length > MAX_CHANGES) { diff.changes.pop(); diff.truncated = true }
      diff.truncated ||= previous.truncated || current.truncated
    }
    const name = bounded(source.clip.label ?? source.clip.title?.text ?? source.clip.id, 160)
    const compositionName = bounded(source.compositionName, 160)
    const clip = { id: source.clip.id, comp: source.comp, compositionName: compositionName.text, name: name.text,
      status: !old ? 'added' : !next ? 'deleted' : 'changed', start: source.clip.start, changes: diff.changes }
    const size = bytes(JSON.stringify(clip)) + 1
    if (size > remaining) { truncated = true; continue }
    clips.push(clip); remaining -= size
    truncated ||= diff.truncated || name.truncated || compositionName.truncated
  }
  function summary(text) {
    if (projectChanges.length >= MAX_ENTRIES) { truncated = true; return }
    const value = bounded(text, 160)
    projectChanges.push(value.text); truncated ||= value.truncated
  }
  function appendScope(diff, comp, name, status, track = null, asset = null) {
    if (!diff.changes.length) return
    totalScopes++
    if (scopes.length >= MAX_ENTRIES || comp != null && !validIdentifier(comp) || track != null && !validIdentifier(track) || asset != null && !validIdentifier(asset)) { truncated = true; return }
    const label = bounded(name, 160)
    const scope = { comp, track, name: label.text, status, changes: diff.changes, ...(asset == null ? {} : { asset }) }
    const size = bytes(JSON.stringify(scope)) + 1
    if (size > remaining) { truncated = true; return }
    scopes.push(scope); remaining -= size
    truncated ||= diff.truncated || label.truncated
  }
  const assetMaps = [before.assets, after.assets].every(value => value === undefined || record(value))
  const compositionIDs = new Set([...Object.keys(before.comps ?? {}), ...Object.keys(after.comps ?? {})])
  for (const comp of [null, ...compositionIDs]) {
    const previous = comp == null ? before : own(before.comps, comp) ? before.comps[comp] : undefined
    const current = comp == null ? after : own(after.comps, comp) ? after.comps[comp] : undefined
    const name = comp == null ? 'Main timeline' : (current ?? previous)?.name ?? comp
    const excluded = comp == null && assetMaps ? ['tracks', 'comps', 'assets'] : ['tracks', 'comps']
    const oldMetadata = metadata(previous, excluded), newMetadata = metadata(current, excluded)
    const diff = differences(oldMetadata, newMetadata, comp != null && (!previous || !current) ? 'composition' : '')
    if (comp != null && (!previous || !current)) summary(`${current ? 'Added' : 'Deleted'} composition ${name}`)
    else for (const property of new Set([...Object.keys(oldMetadata ?? {}), ...Object.keys(newMetadata ?? {})])) {
      if (!same(own(oldMetadata, property) ? oldMetadata[property] : undefined, own(newMetadata, property) ? newMetadata[property] : undefined)) summary(comp == null ? property : `${name}.${property}`)
    }
    const oldTracks = previous?.tracks ?? [], newTracks = current?.tracks ?? []
    appendOrder(oldTracks.map(track => track.id), newTracks.map(track => track.id), 'Track order', diff)
    if (!same(oldTracks.map(track => track.id), newTracks.map(track => track.id))) summary(`Track order · ${name}`)
    appendScope(diff, comp, name, !previous ? 'added' : !current ? 'deleted' : 'changed')
    const oldByID = new Map(oldTracks.map(track => [track.id, track])), newByID = new Map(newTracks.map(track => [track.id, track]))
    for (const id of new Set([...oldByID.keys(), ...newByID.keys()])) {
      const old = oldByID.get(id), next = newByID.get(id)
      const trackDiff = differences(metadata(old, ['clips']), metadata(next, ['clips']), !old || !next ? 'track' : '')
      appendOrder((old?.clips ?? []).map(clip => clip.id), (next?.clips ?? []).map(clip => clip.id), 'Object order', trackDiff)
      if (trackDiff.changes.length) {
        const trackName = `Track ${id} · ${(next ?? old)?.name ?? id} · ${name}`
        summary(trackName)
        appendScope(trackDiff, comp, trackName, !old ? 'added' : !next ? 'deleted' : 'changed', id)
      }
    }
  }
  if (assetMaps) for (const path of new Set([...Object.keys(before.assets ?? {}), ...Object.keys(after.assets ?? {})])) {
    const old = own(before.assets, path) ? before.assets[path] : undefined, next = own(after.assets, path) ? after.assets[path] : undefined
    if (same(old, next)) continue
    totalAssets++
    const property = propertyPath('assets', path)
    if (bytes(`${property}.generated`) > 512) { totalScopes++; truncated = true; continue }
    let diff
    if ((old === undefined || record(old)) && (next === undefined || record(next))) {
      diff = differences(metadata(old ?? {}, ['generated']), metadata(next ?? {}, ['generated']), property)
      const previous = old?.generated, current = next?.generated
      if (!same(previous, current)) {
        const generated = (previous === undefined || record(previous)) && (current === undefined || record(current))
          ? differences(previous ?? {}, current ?? {}, `${property}.generated`) : differences(previous, current, `${property}.generated`)
        if (!generated.changes.length) differences(previous, current, `${property}.generated`, 0, generated)
        for (const change of generated.changes) {
          if (diff.changes.length >= MAX_CHANGES) { diff.truncated = true; break }
          diff.changes.push(change)
        }
        diff.truncated ||= generated.truncated
      }
      if (!diff.changes.length) diff = differences(old, next, property)
    } else diff = differences(old, next, property)
    appendScope(diff, null, `Media asset · ${(next ?? old)?.name ?? path}`, !own(before.assets, path) ? 'added' : !own(after.assets, path) ? 'deleted' : 'changed', null, path)
  }
  if (totalAssets) summary('assets')
  if (!total && !totalScopes) return null
  const receipt = { version, who, at: Number.isFinite(at) ? at : 0, total, clips, totalScopes, totalAssets, scopes, projectChanges, truncated }
  while (bytes(JSON.stringify(receipt, null, 2)) > MAX_RECEIPT_BYTES) {
    receipt.truncated = true
    if (scopes.length) scopes.pop()
    else if (clips.length) clips.pop()
    else if (projectChanges.length) projectChanges.pop()
    else return null
  }
  return receipt
}

/** Only surviving layers in one composition can be selected together. */
export function receiptSelection(receipt, project, comp) {
  comp ??= null
  const timeline = comp == null ? project : own(project?.comps, comp) ? project.comps[comp] : undefined
  if (!timeline) return null
  const eligible = new Set(receipt.clips.filter(clip => clip.comp === comp && clip.status !== 'deleted').map(clip => clip.id))
  const current = new Map()
  for (const track of timeline.tracks ?? []) for (const clip of track.clips ?? []) {
    if (eligible.has(clip.id) && !current.has(clip.id)) current.set(clip.id, clip)
  }
  const ids = [...eligible].filter(id => current.has(id))
  const start = Math.min(...ids.map(id => Number.isFinite(current.get(id).start) ? Math.max(0, current.get(id).start) : 0))
  return ids.length ? { ids, comp, start } : null
}
