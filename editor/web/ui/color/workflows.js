import { parseCube } from '/core/cube-lut.js'

const visual = new Set(['video', 'image', 'title', 'shape', 'color', 'comp', 'adjustment', 'multicam'])
const signature = state => JSON.stringify([state.root, state.openComp ?? null, [...state.selection].sort(), state.clip?.id, state.node?.id ?? null, state.at])
export function lutTarget(clip, node) {
  if (!clip || !visual.has(clip.kind) || clip.kind === 'adjustment' && node && node.type !== 'primary') return null
  if (!node || node.type === 'primary') return { id: clip.id, kind: 'clipGrade' }
  if (node.type === 'corrector') return { id: clip.id, kind: 'nodeGrade', node: node.id }
  if (node.type === 'lut') return { id: clip.id, kind: 'lutNode', node: node.id }
  return null
}

// The backend owns parsing, provenance checks and the single version-checked edit.
// Async UI actions retain the exact displayed composition, node and input snapshot.
export function createColorWorkflows({ getState, request, upload, commit, download, onState = () => {} }) {
  let generation = 0, operation = 0, panel = { busy: false, inspected: null, error: '', notice: '' }
  const publish = patch => { panel = { ...panel, ...patch }; onState(panel) }
  const ask = async (route, body) => { const result = await request(route, body); if (!result || result.error) throw new Error(result?.error ?? 'The color request did not complete'); return result }
  function capture(flag, targetRequired = false) {
    const state = getState()
    if (!state.project || !Number.isSafeInteger(state.version)) throw new Error('Open a project before using color tools')
    if (state.caps?.color?.[flag] !== true) throw new Error(flag === 'referenceMatch' ? 'Reference matching is unavailable on this backend. The standalone editor requires local Chrome and ffmpeg.' : 'This backend does not support this LUT operation')
    const target = lutTarget(state.clip, state.node)
    if (targetRequired && !target) throw new Error('Choose a primary, corrector or LUT node on a visual clip')
    return { project: state.project, version: state.version, signature: signature(state), comp: state.openComp ?? null, at: state.at, target, caps: state.caps.color, token: ++generation }
  }
  function current(captured) {
    const state = getState()
    if (captured.token !== generation) throw new Error('Stopped waiting for color processing')
    if (state.project !== captured.project || state.version !== captured.version || signature(state) !== captured.signature) throw new Error('The project, composition, selection, node or frame changed. Start again')
  }
  function inspection(result, captured, details = {}) {
    if (typeof result.path !== 'string' || !/\.cube$/i.test(result.path) || !Number.isInteger(result.size) || !/^[a-f0-9]{64}$/.test(result.sourceHash ?? '') || ![result.domainMin, result.domainMax].every(a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite))) throw new Error('The backend returned an invalid LUT inspection')
    return { ...result, ...details, captured }
  }
  async function operate(fn, phase = 'processing') {
    if (panel.busy) throw new Error('Wait for the current color request or stop waiting')
    const owned = ++operation
    publish({ busy: true, phase, error: '', notice: '' })
    try { return await fn() }
    catch (error) { if (owned === operation) publish({ error: error.message }); throw error }
    finally { if (owned === operation) publish({ busy: false }) }
  }
  return {
    get state() { return panel },
    dispose() { generation++; operation++ },
    cancel() { generation++; operation++; publish({ busy: false, inspected: null, notice: 'Stopped waiting. Uploaded or generated project copies may remain.' }) },
    inspect(path) { return operate(async () => {
      const captured = capture('lutInspect'), result = await ask('/api/luts/inspect', { path }); current(captured)
      const inspected = inspection(result, captured); publish({ inspected }); return inspected
    }) },
    importCube(file) { return operate(async () => {
      const captured = capture('cubeImport')
      if (!file || !/\.cube$/i.test(file.name) || file.size <= 0 || file.size > (captured.caps.maxCubeBytes ?? 16777216)) throw new Error('Choose a UTF-8 CUBE file of at most 16 MiB')
      const bytes = await file.arrayBuffer(); current(captured)
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      parseCube(text)
      const result = await ask('/api/luts/import', { name: file.name, text }); current(captured)
      const inspected = inspection(result, captured); publish({ inspected, notice: 'Imported a new project copy. Your original LUT is unchanged.' }); return inspected
    }) },
    match(file, { name = 'Reference look', strength = 0.75 } = {}) { return operate(async () => {
      const captured = capture('referenceMatch', true)
      if (!file || !/\.(png|jpe?g|webp)$/i.test(file.name) || file.size <= 0 || file.size > (captured.caps.maxReferenceBytes ?? 33554432)) throw new Error('Choose a PNG, JPEG or WebP reference of at most 32 MiB')
      if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Look strength must be between zero and one')
      const copied = await upload(file); current(captured)
      if (!copied?.path || copied.error) throw new Error(copied?.error ?? 'The reference could not be copied into the project')
      const generated = await ask('/api/looks/match', { reference: copied.path, name, strength, at: captured.at, comp: captured.comp, clip: captured.target.id, expectedVersion: captured.version, apply: false })
      current(captured)
      const result = await ask('/api/luts/inspect', { path: generated.lut ?? generated.path }); current(captured)
      const inspected = inspection(result, captured, { manifest: generated.manifest, measurements: generated.measurements, warnings: generated.warnings ?? [] })
      publish({ inspected, notice: 'Reference LUT created. Review its measurements and apply it to the captured node when ready.' }); return inspected
    }) },
    exportCube() { return operate(async () => {
      const inspected = panel.inspected
      if (!inspected) throw new Error('Inspect a LUT before exporting it')
      const captured = inspected.captured; current(captured)
      if (getState().caps?.color?.lutExport !== true || typeof download !== 'function') throw new Error('LUT export is unavailable in this editor')
      const result = await ask('/api/luts/export', { path: inspected.path, expectedInputHash: inspected.sourceHash }); current(captured)
      if (typeof result.text !== 'string' || result.path !== inspected.path || result.sourceHash !== inspected.sourceHash) throw new Error('The exported LUT does not match its inspection')
      const cube = parseCube(result.text)
      if (cube.size !== inspected.size || JSON.stringify(cube.domainMin) !== JSON.stringify(inspected.domainMin) || JSON.stringify(cube.domainMax) !== JSON.stringify(inspected.domainMax)) throw new Error('The exported LUT properties changed')
      const bytes = new TextEncoder().encode(result.text)
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes); current(captured)
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      if (hash !== inspected.sourceHash) throw new Error('The exported LUT bytes changed')
      await download({ name: inspected.path.split(/[\\/]/).at(-1), text: result.text })
      current(captured)
      publish({ notice: 'Downloaded the inspected CUBE file.' }); return result
    }, 'exporting') },
    apply({ mix = 1, space = 'srgb' } = {}) { return operate(async () => {
      const inspected = panel.inspected
      if (!inspected) throw new Error('Inspect a LUT before applying it')
      const captured = inspected.captured; current(captured)
      if (getState().caps?.color?.lutApply !== true || !captured.target) throw new Error('Choose a supported primary, corrector or LUT node')
      if (!Number.isFinite(mix) || mix < 0 || mix > 1 || !['srgb', 'working'].includes(space)) throw new Error('Choose a valid LUT mix and color space')
      const result = await ask('/api/luts/apply', { path: inspected.path, expectedInputHash: inspected.sourceHash, expectedVersion: captured.version, comp: captured.comp, targets: [captured.target], mix, space, who: 'you' })
      if (!result.applied || !result.project || result.version !== captured.version + 1) throw new Error('The backend did not confirm the LUT edit')
      const state = getState()
      if (generation !== captured.token || signature(state) !== captured.signature || (state.project !== captured.project || state.version !== captured.version) && (state.version !== result.version || JSON.stringify(state.project) !== JSON.stringify(result.project))) throw new Error('The editor changed while the LUT was applying. Refresh the project to review its result')
      commit({ project: result.project, version: result.version })
      publish({ inspected: null, notice: 'Applied the inspected LUT in one undo step.' }); return result
    }, 'applying') },
  }
}
