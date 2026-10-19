import { figmaAssets, figmaToOps, mcpToNodes, placeCompOps, smartAnimateOps } from './figma.js'

const sourceClaimFields = ['generated', 'contentSHA256', 'origin', 'provenance']
const hasSourceClaims = asset => asset !== null && typeof asset === 'object' && sourceClaimFields.some(key => Object.hasOwn(asset, key))

export function nativeFigmaAssets(nodes, options = {}) {
  return figmaAssets(nodes, { flatten: options.mode === 'smartAnimate' })
}

/** Builds one atomic import, including downloaded asset metadata and timeline placement. */
export function nativeFigmaImport(project, nodes, body = {}) {
  if (!project || typeof project !== 'object') throw new Error('Open a Reel project first')
  const smart = body.mode === 'smartAnimate'
  const images = body.images ?? {}
  const from = body.mcp ? mcpToNodes(nodes, images, { coords: body.coords }) : nodes
  const toInput = body.toNodes ?? body.toXml
  const to = body.mcp && smart ? mcpToNodes(toInput, images, { coords: body.coords }) : toInput
  if (smart && !to) throw new Error('Smart Animate needs a second frame')
  const positive = (value, name) => {
    if (value === undefined || value === null) return undefined
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`)
    return number
  }
  const common = { project, images, compName: body.compName ?? body.name, fps: positive(body.fps, 'Frame rate') }
  const result = smart
    ? smartAnimateOps(from, to, { ...common, duration: positive(body.transition ?? body.duration, 'Transition'), delay: body.delay, hold: body.hold, ease: body.ease })
    : figmaToOps(from, { ...common, duration: positive(body.duration, 'Duration') })
  const assets = body.assets ?? {}
  const sources = new Set([...Object.keys(assets), ...result.ops.filter(op => op.op === 'add_clip').map(op => op.src)])
  for (const src of sources) {
    // Figma probes supply media facts, without a byte identity receipt for source claims.
    if (hasSourceClaims(project.assets?.[src])) throw new Error(`Figma cannot verify the saved source attribution for ${src}. The Media entry was kept unchanged. Import the image under a new media path, then retry.`)
    if (hasSourceClaims(assets[src])) throw new Error(`Figma cannot verify source attribution supplied for ${src}. Use probed image metadata without source claims.`)
  }
  const ops = [...(Object.keys(assets).length ? [{ op: 'import', assets }] : []), ...result.ops]
  if (body.placeOnTimeline) {
    const start = Number(body.start ?? 0)
    if (!Number.isFinite(start) || start < 0) throw new Error('Start must be zero or greater')
    ops.push(...placeCompOps(project, { id: result.comp, ...result }, { start, track: body.track, ...(Object.hasOwn(body, 'comp') ? { comp: body.comp } : {}) }))
  }
  return { ...result, ops }
}
