import { libraryCompatibility, libraryPlacesObject } from '/core/library.js'

export const LIBRARY_CATEGORIES = [
  ['title', 'Title'], ['composition', 'Composition'], ['effect', 'Effect'], ['transition', 'Transition'], ['motion', 'Motion'],
]

export function selectedLibraryClip(project, ids, composition = null) {
  const selected = [...new Set((ids ?? []).map(id => id.startsWith('tr:') ? id.slice(3) : id))]
  if (selected.length !== 1) return null
  const timeline = composition === null ? project : project.comps?.[composition]
  const clips = (timeline?.tracks ?? []).flatMap(track => track.clips ?? []).filter(clip => clip.id === selected[0])
  return clips.length === 1 ? clips[0] : null
}

export function librarySaveChoices(project, ids, composition) {
  const clip = selectedLibraryClip(project, ids, composition ?? null)
  if (ids?.length && !clip) return []
  const sourceComp = clip?.kind === 'comp' ? clip.comp : composition
  const choices = []
  if (clip?.kind === 'title') choices.push({ category: 'title', label: 'Title', source: { clip: clip.id }, name: clip.label ?? clip.title?.text?.split('\n')[0] ?? 'Title' })
  if (sourceComp && project.comps?.[sourceComp]) {
    const name = project.comps[sourceComp].name
    const source = clip?.kind === 'comp' ? { clip: clip.id } : { composition: sourceComp }
    choices.push({ category: 'composition', label: 'Composition', source, name })
    choices.push({ category: 'title', label: 'Title composition', source, name })
    choices.push({ category: 'transition', label: 'Transition composition', source, name })
  }
  if (clip?.effects?.length || clip?.nodes || (clip?.grade && Object.keys(clip.grade).length)) choices.push({ category: 'effect', label: 'Effects and color nodes', source: { clip: clip.id }, name: `${clip.label ?? clip.id} effect` })
  if (sourceComp && project.comps?.[sourceComp]) {
    const source = clip?.kind === 'comp' ? { clip: clip.id, type: 'composition' } : { composition: sourceComp }
    choices.push({ category: 'effect', label: 'Effect composition', source, name: project.comps[sourceComp].name })
  }
  if (clip?.transitionIn) choices.push({ category: 'transition', label: 'Incoming transition', source: { clip: clip.id }, name: `${clip.transitionIn.type} transition` })
  if (Object.values(clip?.anim ?? {}).some(keys => Array.isArray(keys) && keys.length)) choices.push({ category: 'motion', label: 'Keyframe motion', source: { clip: clip.id }, name: `${clip.label ?? clip.id} motion` })
  return choices
}

function sourceData(project, source, composition) {
  const timeline = composition === null ? project : project.comps?.[composition]
  const matches = source.clip ? (timeline?.tracks ?? []).flatMap(track => (track.clips ?? []).filter(clip => clip.id === source.clip).map(clip => ({ clip, track: track.id, owner: composition }))) : []
  if (source.clip && matches.length !== 1) throw new Error('The source clip is missing or ambiguous in the selected composition')
  const found = matches[0]
  const comps = {}
  const copy = id => {
    if (Object.hasOwn(comps, id)) return
    const comp = project.comps?.[id]
    if (!comp) throw new Error('The source composition no longer exists')
    comps[id] = comp
    for (const clip of (comp.tracks ?? []).flatMap(track => track.clips ?? [])) if (clip.kind === 'comp') copy(clip.comp)
  }
  const comp = source.composition ?? (found?.clip.kind === 'comp' ? found.clip.comp : null)
  if (comp) copy(comp)
  return { source, ...(found ? { ...found } : {}), comps, assets: project.assets ?? {} }
}

export function captureLibrarySource(project, choice, { root, version, selection = [], composition = null }) {
  const data = sourceData(project, choice.source, composition)
  return { choice: structuredClone(choice), root, version, selection: [...selection], composition, fingerprint: JSON.stringify(data), clip: data.clip ? structuredClone(data.clip) : null }
}

export function librarySourceStatus(project, capture, { root, version, selection = [], composition = null }) {
  if (!capture) return { ok: false, reason: 'Choose a source selection first.' }
  if (capture.root !== root || capture.version !== version) return { ok: false, reason: 'The project changed. Refresh source selection before saving.' }
  if (capture.composition !== composition || JSON.stringify([...capture.selection].sort()) !== JSON.stringify([...selection].sort())) return { ok: false, reason: 'The selected source changed. Refresh source selection before saving.' }
  try {
    if (capture.fingerprint !== JSON.stringify(sourceData(project, capture.choice.source, composition))) return { ok: false, reason: 'The source data changed. Refresh source selection before saving.' }
    return { ok: true, reason: '' }
  } catch (error) { return { ok: false, reason: error.message } }
}

export function libraryApplyPlan(project, item, ids, { start = 0, comp = null } = {}) {
  const current = project.library?.items?.find(candidate => candidate.id === item.id)
  if (!current || current.category !== item.category || current.body !== item.body && JSON.stringify(current.body) !== JSON.stringify(item.body)) return { ok: false, reason: 'This saved component changed. Choose it again from the current project library.', ops: [] }
  const placement = libraryPlacesObject(item)
  const timeline = comp === null ? project : project.comps?.[comp]
  if (!timeline) return { ok: false, reason: 'The destination composition no longer exists', ops: [] }
  if (placement) {
    if (!(timeline.tracks ?? []).some(track => track.kind === 'video' && !track.locked)) return { ok: false, reason: 'The destination needs an unlocked video track', ops: [] }
  }
  const targets = placement ? [undefined] : [...new Set((ids ?? []).map(id => id.startsWith('tr:') ? id.slice(3) : id))]
  if (!targets.length) return { ok: false, reason: 'Select a compatible clip first', ops: [] }
  for (const id of targets) {
    const compatibility = libraryCompatibility(project, item, id, comp)
    if (!compatibility.ok) return { ...compatibility, ops: [] }
  }
  return { ok: true, reason: '', ops: targets.map(id => ({ op: 'library_apply', item: item.id, comp, ...(id ? { id } : { start }) })) }
}

export function libraryItemFacts(item) {
  const body = item.body ?? {}
  if (item.category === 'title' && body.clip?.kind === 'title') {
    const title = body.clip.title ?? {}
    return { text: title.text ?? '', details: [title.font, `${body.clip.dur} s`, title.anim && title.anim !== 'none' ? title.anim : null].filter(Boolean).join(' · ') }
  }
  if (body.composition || body.clip?.kind === 'comp') {
    const comp = body.comps?.[body.composition ?? body.clip.comp]
    const layers = Object.values(body.comps ?? {}).flatMap(c => c.tracks ?? []).flatMap(t => t.clips ?? [])
    return { details: `${layers.length} editable layer${layers.length === 1 ? '' : 's'}${comp ? ` · ${comp.width}×${comp.height} · ${body.clip?.dur ?? comp.duration ?? '?'} s` : ''}${item.category === 'transition' ? ' · overlay across the selected cut' : item.category === 'effect' ? ' · overlay at the playhead' : ''}`, text: layers.find(layer => layer.kind === 'title')?.title?.text ?? '' }
  }
  const settings = body.settings ?? {}
  if (item.category === 'motion') {
    const keys = Object.values(settings.anim ?? {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0)
    return { details: `${keys} editable keyframes · ${Object.keys(settings.anim ?? {}).join(', ')} · timing fits target length` }
  }
  if (item.category === 'transition') return { details: `${settings.transitionIn?.type ?? 'Transition'} · ${settings.transitionIn?.dur ?? '?'} s incoming transition` }
  if (item.category === 'effect') {
    const effects = settings.effects ?? []
    const nodes = settings.nodes?.list?.filter(node => !['source', 'output'].includes(node.type)) ?? []
    const keys = Object.values(settings.anim ?? {}).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0)
    return { details: [...effects.map(effect => effect.type), ...nodes.map(node => `${node.type} node`), settings.grade && Object.keys(settings.grade).length ? 'color grade' : null, keys ? `${keys} editable node keyframes` : null].filter(Boolean).join(' · ') || 'Effect settings' }
  }
  return { details: item.category }
}
