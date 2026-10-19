export function captureProcessingProject(ctx) {
  ctx.assertCurrent?.()
  const project = ctx.getProject(), version = ctx.getVersion?.(), generation = ctx.getProjectGeneration?.()
  if (!project || !Number.isSafeInteger(version) || version < 0 || !Number.isSafeInteger(generation) || generation < 0) throw new Error('Refresh the open project before processing media.')
  return { project, version, generation }
}

export function currentProcessingProject(ctx, capture) {
  const current = captureProcessingProject(ctx)
  if (current.generation !== capture.generation) throw new Error('The original project was replaced. The processed copy was not added to Media.')
  return current
}

export function processingSourceFingerprint(files, file) {
  const stat = files.statSync(file, { bigint: true })
  if (!stat.isFile()) throw new Error('Choose a regular video source.')
  return [files.realpathSync(file), stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('|')
}

export function processedVideoAsset(asset, { output, kind, src, input, duration, outputDuration = duration, engine, settings, fps = asset?.fps || 30 }) {
  const tolerance = Math.max(0.002, 1 / fps)
  if (!asset || asset.hasVideo !== true || asset.still || typeof src !== 'string' || !src || ![asset.width, asset.height, asset.duration, input, duration, outputDuration, fps].every(Number.isFinite) || asset.width < 1 || asset.height < 1 || asset.duration <= 0 || input < 0 || duration <= 0 || outputDuration <= 0 || fps <= 0 || Math.abs(asset.duration - outputDuration) > tolerance) throw new Error('The processed output is not a complete video source for the requested range. The original clip was retained.')
  const processing = { version: 1, kind: `video-${kind}`, source: src, range: { in: input, dur: duration }, output, engine, compute: 'cpu', settings: structuredClone(settings) }
  return { ...asset, processing }
}

export async function admitProcessedOutput(ctx, capture, output, asset, { cancelled = () => false, validateSource = () => {}, who = 'reel' } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (cancelled()) throw new Error('Processing cancelled.')
    validateSource()
    const current = currentProcessingProject(ctx, capture), existing = current.project.assets?.[output]
    if (existing?.processing && JSON.stringify(existing.processing) !== JSON.stringify(asset.processing)) throw new Error('This output path has different processing provenance. The existing Media entry was retained.')
    if (existing?.processing) return { asset: existing, added: false, version: current.version, placementCurrent: current.version === capture.version }
    const stored = existing ? { ...existing, ...asset } : asset
    try {
      const ops = [{ op: 'import', assets: { [output]: stored } }], summary = `Added processed ${asset.processing.kind} copy to Media; original source retained`
      const result = ctx.editOps ? await ctx.editOps(ops, who, summary, { expectedVersion: current.version, returnProject: false }) : await ctx.callAPI('POST', '/api/ops', { ops, who, summary, expectedVersion: current.version, returnProject: false })
      const now = currentProcessingProject(ctx, capture)
      if (!Number.isSafeInteger(result.version) || !now.project.assets?.[output]?.processing || JSON.stringify(now.project.assets[output].processing) !== JSON.stringify(asset.processing)) throw new Error('Media admission was not confirmed. The processed file was retained.')
      return { asset: now.project.assets[output], added: !existing, version: result.version, placementCurrent: current.version === capture.version }
    } catch (error) {
      const now = currentProcessingProject(ctx, capture)
      if (attempt === 0 && now.version !== current.version) continue
      throw error
    }
  }
}
