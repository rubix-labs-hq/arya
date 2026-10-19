const text = (value, limit = 180) => String(value ?? '').slice(0, limit)
const clipsOf = timeline => (timeline?.tracks ?? []).flatMap(track => (track.clips ?? []).map(clip => ({ clip, track })))
const byteLength = value => { let n = 0; for (const char of value) { const point = char.codePointAt(0); n += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4 } return n }

// Synchronous SHA-256 keeps the existing browser callback API and bounds reference IDs.
const digestWords = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const rotate = (word, bits) => word >>> bits | word << (32 - bits)
function selectionDigest(value) {
  const bytes = []
  for (const char of value) {
    const point = char.codePointAt(0)
    if (point <= 0x7f) bytes.push(point)
    else if (point <= 0x7ff) bytes.push(0xc0 | point >>> 6, 0x80 | point & 63)
    else if (point <= 0xffff) bytes.push(0xe0 | point >>> 12, 0x80 | point >>> 6 & 63, 0x80 | point & 63)
    else bytes.push(0xf0 | point >>> 18, 0x80 | point >>> 12 & 63, 0x80 | point >>> 6 & 63, 0x80 | point & 63)
  }
  const bits = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bits / 2 ** (i * 8)) & 255)
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const words = new Uint32Array(64)
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) { const at = offset + i * 4; words[i] = bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3] }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2]
      words[i] = (words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ x >>> 3) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ y >>> 10)) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = state
    for (let i = 0; i < 64; i++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + digestWords[i] + words[i]) >>> 0
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0
    }
    const block = [a, b, c, d, e, f, g, h]
    for (let i = 0; i < 8; i++) state[i] = (state[i] + block[i]) >>> 0
  }
  return state.map(word => word.toString(16).padStart(8, '0')).join('')
}

function sourceNode(clip) {
  const note = String(clip.note ?? '')
  const match = /^figma\s+(\S+)(?:\s|$)/.exec(note)
  const nodeId = typeof clip.figma?.nodeId === 'string' ? clip.figma.nodeId : match?.[1]
  if (!nodeId) return null
  return { nodeId, ...(typeof clip.figma?.fileKey === 'string' ? { fileKey: clip.figma.fileKey } : {}) }
}

function layerContext(clip, track, composition) {
  const animated = Object.entries(clip.anim ?? {}).filter(([, keys]) => Array.isArray(keys) && keys.length)
  const source = sourceNode(clip)
  return {
    id: clip.id,
    composition,
    track: track.id,
    kind: clip.kind,
    label: text(clip.label ?? clip.title?.text ?? track.name ?? clip.kind),
    start: clip.start,
    duration: clip.dur,
    ...(source ? { figma: source } : {}),
    ...(clip.kind === 'comp' ? { childComposition: clip.comp } : {}),
    ...(clip.parent ? { parent: clip.parent } : {}),
    ...(clip.matte ? { matte: structuredClone(clip.matte) } : {}),
    ...(clip.title ? { text: text(clip.title.text, 500), font: text(clip.title.font), textAnimator: clip.title.anim ?? 'none' } : {}),
    ...(clip.shape ? { shape: clip.shape.type, hasStroke: Boolean(clip.shape.stroke) } : {}),
    animated: animated.map(([property, keys]) => ({ property, keys: keys.length })),
    expressions: Object.keys(clip.expr ?? {}),
  }
}

/** Reads editable selection context. It never creates keyframes or changes imported layers. */
export function selectionMotionContext(project, ids = [], composition = null) {
  if (!project || !Array.isArray(project.tracks)) throw new Error('Open a project first')
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Use a list of selected layer IDs')
  if (composition && !Object.hasOwn(project.comps ?? {}, composition)) throw new Error('The selected composition no longer exists')
  const unique = [...new Set(ids.filter(id => !id.startsWith('tr:')))]
  const all = new Map()
  for (const [comp, timeline] of [[null, project], ...Object.entries(project.comps ?? {})]) {
    const scope = new Map()
    for (const { clip, track } of clipsOf(timeline)) {
      if (!scope.has(clip.id)) scope.set(clip.id, [])
      scope.get(clip.id).push({ clip, track, composition: comp })
    }
    all.set(comp, scope)
  }
  const active = all.get(composition || null)
  const resolve = id => {
    const found = active.get(id)
    if (!found) {
      if ([...all.values()].some(scope => scope.has(id))) throw new Error(`Selected layer ${id} is outside the open composition`)
      throw new Error(`Selected layer ${id} no longer exists`)
    }
    if (found.length !== 1) throw new Error(`Selected layer ${id} is ambiguous in the open composition`)
    return found[0]
  }
  const selected = unique.length ? unique.map(resolve) : composition ? [...active.keys()].map(resolve) : []
  if (!selected.length) throw new Error('Select a layer or open a composition first')
  const layers = [], comps = new Map(), seenLayers = new Set(), seenComps = new Set()
  const add = found => {
    if (all.get(found.composition).get(found.clip.id).length !== 1) throw new Error(`Layer ${found.clip.id} is ambiguous in composition ${found.composition ?? 'main'}`)
    const key = JSON.stringify([found.composition, found.clip.id])
    if (seenLayers.has(key)) return
    seenLayers.add(key)
    layers.push(layerContext(found.clip, found.track, found.composition))
    if (found.clip.kind === 'comp') addComp(found.clip.comp)
  }
  const addComp = id => {
    if (seenComps.has(id)) return
    const comp = project.comps?.[id]
    if (!comp) throw new Error(`Composition ${id} no longer exists`)
    seenComps.add(id)
    comps.set(id, { id, name: text(comp.name), width: comp.width, height: comp.height, duration: comp.duration })
    clipsOf(comp).forEach(layer => add({ ...layer, composition: id }))
  }
  if (composition) {
    const comp = project.comps[composition]
    comps.set(composition, { id: composition, name: text(comp.name), width: comp.width, height: comp.height, duration: comp.duration })
  }
  selected.forEach(add)
  const visual = layers.filter(layer => layer.kind !== 'audio')
  const suggestions = []
  if (visual.length > 1) suggestions.push({ id: 'stagger', label: 'Subtle layer stagger', intent: 'Stagger the selected visual layers with short fades. Preserve their hierarchy and final positions.' })
  if (visual.some(layer => layer.kind === 'title')) suggestions.push({ id: 'readable', label: 'Readable entrance', intent: 'Give the selected text a restrained fade and small rise. Keep the text readable and preserve its font and imported text box.' })
  if (visual.some(layer => layer.kind === 'shape' && layer.shape === 'path' && layer.hasStroke)) suggestions.push({ id: 'draw', label: 'Draw the path', intent: 'Reveal the selected stroked path with editable trim keyframes. Preserve its path points and stroke.' })
  if (visual.length && !suggestions.length) suggestions.push({ id: 'settle', label: 'Gentle entrance', intent: 'Give the selected visual layer a short fade into its current position. Keep its final scale and geometry.' })
  if (visual.some(layer => layer.animated.length || layer.expressions.length)) suggestions.unshift({ id: 'refine', label: 'Refine existing motion', intent: 'Inspect and refine the selected layers\' existing motion. Preserve their expressions and keyframes unless a change is needed for my request.' })
  return { composition, selected: selected.map(layer => layer.clip.id), compositions: [...comps.values()], layers, suggestions: suggestions.slice(0, 3) }
}

/** An attached intent for the existing assistant reference channel. */
export function selectionMotionReference(project, ids, composition, intent) {
  const context = selectionMotionContext(project, ids, composition)
  if (typeof intent !== 'string' || !intent.trim() || intent.length > 4000) throw new Error('Describe the motion in at most 4000 characters')
  const ref = {
    kind: 'motion',
    id: `selection:sha256:${selectionDigest(JSON.stringify([context.composition == null ? ['main'] : ['composition', context.composition], context.selected]))}`,
    label: `Animate ${context.selected.length === 1 ? context.layers[0].label : `${context.selected.length} selected layers`}`,
    intent: intent.trim(),
    context,
  }
  if (byteLength(JSON.stringify(ref)) > 48000) throw new Error('This selection is too large for one assistant reference. Select fewer layers.')
  return ref
}
