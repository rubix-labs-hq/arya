import { validateLibraryItem } from '../../core/library.js'
import { EQ_BAND_TYPES, FX_TYPES } from '../../core/audio-fx.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw new Error(`Backup project: ${message}`) }
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const finite = value => typeof value === 'number' && Number.isFinite(value)
const clips = scope => scope.tracks.flatMap(track => track.clips)
const path = value => typeof value === 'string' && value.startsWith('media/') && value.length <= 2048 && !/[\u0000-\u001f\\]|(^|\/)\.\.?($|\/)/.test(value)
function keys(value, allowed, label) {
  if (!object(value)) fail(`${label} must be an object`)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unsupported ${label} field ${key}`)
}
function plain(value, depth = 0, count = { n: 0 }) {
  if (++count.n > 100000 || depth > 32) fail('project is too large or deeply nested')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') { if (!finite(value)) fail('numbers must be finite'); return }
  if (typeof value === 'string') { if (value.length > 200000) fail('text is too long'); return }
  if (Array.isArray(value)) { value.forEach(entry => plain(entry, depth + 1, count)); return }
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('only native JSON is supported')
  for (const [key, entry] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('unsafe object key')
    plain(entry, depth + 1, count)
  }
}
function range(value) {
  if (value === undefined || value === null) return
  keys(value, ['in', 'out'], 'range')
  if (!finite(value.in) || !finite(value.out) || value.in < 0 || value.out <= value.in || value.out >= 1000000) fail('invalid range')
}
function fx(list) {
  if (list === undefined) return
  if (!Array.isArray(list) || list.length > 64) fail('invalid audio effects')
  for (const effect of list) {
    keys(effect, ['type', 'enabled', 'params'], 'audio effect')
    const spec = FX_TYPES[effect.type]
    if (!spec || effect.enabled !== undefined && typeof effect.enabled !== 'boolean') fail('unsupported audio effect')
    keys(effect.params, effect.type === 'eq' ? ['bands'] : Object.keys(spec.params), 'audio parameters')
    for (const [key, value] of Object.entries(effect.params)) {
      if (key === 'bands') {
        if (!Array.isArray(value) || value.length > 6) fail('invalid EQ bands')
        for (const band of value) {
          keys(band, ['type', 'freq', 'gain', 'q'], 'EQ band')
          if (!EQ_BAND_TYPES.includes(band.type) || !['freq', 'gain', 'q'].every(key => band[key] === undefined || finite(band[key]))) fail('invalid EQ band')
        }
      } else if (!finite(value) || value < spec.params[key].min || value > spec.params[key].max) fail('audio parameter outside its supported range')
    }
  }
}
function dependencies(value, project, owned, assets) {
  if (Array.isArray(value)) { value.forEach(entry => dependencies(entry, project, owned, assets)); return }
  if (!object(value)) return
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'lut' && entry) fail('LUT files need a supported native or local connection')
    if (key === 'src' && entry) {
      if (!path(entry) || !owned.has(entry) || !object(project.assets[entry])) fail('unresolved project media reference')
      assets[entry] = project.assets[entry]
    } else if (object(entry) || Array.isArray(entry)) dependencies(entry, project, owned, assets)
  }
}

/** Admission is read-only and precedes every archive copy. Validators receive clones. */
export function admitBackupProject(project, ownedPaths) {
  plain(project)
  keys(project, ['version', 'name', 'width', 'height', 'fps', 'sampleRate', 'background', 'colorSpace', 'tracks', 'comps', 'markers', 'assets', 'library', 'range', 'master', 'nodePresets'], 'project')
  if (project.version !== 3) fail('unsupported native project version; use a version 3 browser backup')
  if (typeof project.name !== 'string' || !project.name.trim() || project.name.length > 512) fail('invalid project name')
  if (![project.width, project.height].every(value => Number.isSafeInteger(value) && value >= 2 && value <= 8192) || !finite(project.fps) || project.fps <= 0 || project.fps > 120 || ![44100, 48000, 96000].includes(project.sampleRate)) fail('invalid dimensions, frame rate or sample rate')
  if (typeof project.background !== 'string' || !['rec709', 'srgb', 'linear', 'rec2020', 'display-p3'].includes(project.colorSpace)) fail('invalid project color settings')
  range(project.range)
  if (!Array.isArray(project.markers) || project.markers.length > 2000) fail('invalid project markers')
  if (!object(project.assets) || Object.keys(project.assets).length > 1000 || !object(project.comps) || Object.keys(project.comps).length > 64) fail('invalid project dependency maps')
  const owned = new Set(ownedPaths), ids = new Set(), scopes = new Map()
  for (const [src, asset] of Object.entries(project.assets)) {
    if (!path(src) || !owned.has(src) || !object(asset)) fail('asset is not a project-owned backup file')
    if (asset.proxy !== undefined && (!path(asset.proxy) || !owned.has(asset.proxy))) fail('unresolved proxy media')
    for (const key of ['duration', 'width', 'height', 'fps', 'size']) if (asset[key] !== undefined && (!finite(asset[key]) || asset[key] < 0)) fail('invalid media metadata')
    for (const key of ['hasVideo', 'hasAudio']) if (asset[key] !== undefined && typeof asset[key] !== 'boolean') fail('invalid media capability metadata')
  }
  let rootID = 'arya_backup_root'
  const existingClipIDs = new Set([project, ...Object.values(project.comps)].flatMap(scope => (scope.tracks ?? []).flatMap(track => Array.isArray(track.clips) ? track.clips.map(clip => clip.id) : [])))
  while (project.comps[rootID] || existingClipIDs.has(rootID)) rootID += '_'
  scopes.set(rootID, { id: rootID, name: project.name, width: project.width, height: project.height, fps: project.fps, background: project.background, colorSpace: project.colorSpace, tracks: project.tracks, markers: project.markers })
  for (const [key, scope] of Object.entries(project.comps)) {
    if (!id(key) || scope.id !== key) fail('invalid composition identity')
    keys(scope, ['id', 'name', 'width', 'height', 'fps', 'duration', 'background', 'tracks', 'colorSpace', 'note', 'markers', 'range'], 'composition')
    if (![scope.width, scope.height].every(value => Number.isSafeInteger(value) && value >= 2 && value <= 8192) || !finite(scope.fps) || scope.fps <= 0 || scope.fps > 120) fail('invalid composition format')
    range(scope.range); const { range: ignored, ...native } = scope; scopes.set(key, native)
  }
  let clipCount = 0
  for (const [scopeID, scope] of scopes) {
    if (!Array.isArray(scope.tracks) || scope.tracks.length > 128 || !Array.isArray(scope.markers ?? [])) fail('invalid tracks or markers')
    const local = new Set()
    for (const track of scope.tracks) {
      keys(track, ['id', 'kind', 'name', 'muted', 'hidden', 'locked', 'volume', 'pan', 'solo', 'burnIn', 'style', 'clips', 'fx'], 'track')
      if (!id(track.id) || local.has(track.id) || !Array.isArray(track.clips)) fail('invalid or duplicate track')
      local.add(track.id); fx(track.fx)
      for (const key of ['muted', 'hidden', 'locked', 'solo', 'burnIn']) if (track[key] !== undefined && typeof track[key] !== 'boolean') fail('invalid track flag')
      for (const key of ['volume', 'pan']) if (track[key] !== undefined && !finite(track[key])) fail('invalid track mix')
      for (const clip of track.clips) {
        if (++clipCount > 2000 || !id(clip.id) || ids.has(clip.id)) fail('invalid, duplicate or excessive clips')
        ids.add(clip.id); fx(clip.fx)
        if (clip.source?.clip && !clips(scope).some(candidate => candidate.id === clip.source.clip)) fail('unresolved caption clip reference')
      }
    }
    if (scopeID !== rootID && ids.has(scopeID)) fail('composition and clip identities collide')
  }
  for (const key of scopes.keys()) if (key !== rootID && ids.has(key)) fail('composition and clip identities collide')
  const nativeGraph = graph => {
    for (const node of graph?.list ?? []) {
      if (node.label !== undefined && typeof node.label !== 'string') fail('invalid node label')
      delete node.label
      if (node.qualifier?.show !== undefined && typeof node.qualifier.show !== 'boolean') fail('invalid qualifier visibility')
      if (node.qualifier) delete node.qualifier.show
    }
  }
  for (const root of scopes.keys()) {
    const reachable = {}, visiting = new Set()
    function visit(key, depth = 0) {
      if (depth > 32 || visiting.has(key)) fail('composition cycle or excessive nesting')
      if (reachable[key]) return
      const scope = scopes.get(key)
      if (!scope || key === rootID && root !== rootID) fail('unresolved composition reference')
      visiting.add(key); reachable[key] = structuredClone(scope)
      for (const clip of clips(scope)) if (clip.kind === 'comp') visit(clip.comp, depth + 1)
      visiting.delete(key)
    }
    visit(root)
    const assets = {}
    dependencies(reachable, project, owned, assets)
    for (const scope of Object.values(reachable)) for (const track of scope.tracks) {
      delete track.fx
      for (const clip of track.clips) { delete clip.fx; nativeGraph(clip.nodes) }
    }
    validateLibraryItem({ name: 'Backup admission', category: 'composition', body: { composition: root, comps: reachable, assets } })
  }
  keys(project.library, ['version', 'items'], 'library')
  if (project.library.version !== 1 || !Array.isArray(project.library.items) || project.library.items.length > 256) fail('unsupported library')
  const libraryIDs = new Set()
  for (const item of project.library.items) {
    if (!id(item.id) || libraryIDs.has(item.id)) fail('invalid or duplicate library item')
    libraryIDs.add(item.id); validateLibraryItem(structuredClone(item)); dependencies(item.body, project, owned, {})
  }
  if (project.master !== undefined) {
    keys(project.master, ['volume', 'fx', 'limiter', 'target'], 'master'); fx(project.master.fx)
    if (project.master.target !== undefined && !finite(project.master.target)) fail('invalid loudness target')
    if (project.master.volume !== undefined && !finite(project.master.volume)) fail('invalid master volume')
    if (project.master.limiter !== undefined) {
      keys(project.master.limiter, ['enabled', 'ceiling', 'release', 'lookahead'], 'master limiter')
      const { enabled, ...params } = project.master.limiter
      fx([{ type: 'limiter', ...(enabled === undefined ? {} : { enabled }), params }])
    }
  }
  if (project.nodePresets !== undefined) {
    if (!object(project.nodePresets) || Object.keys(project.nodePresets).length > 128) fail('invalid node presets')
    for (const preset of Object.values(project.nodePresets)) {
      if (preset === null) continue
      keys(preset, ['name', 'nodes', 'grade'], 'node preset')
      const settings = structuredClone(preset); delete settings.name; nativeGraph(settings.nodes)
      dependencies(settings, project, owned, {})
      validateLibraryItem({ name: 'Backup node preset', category: 'effect', body: { settings } })
    }
  }
  return project
}
