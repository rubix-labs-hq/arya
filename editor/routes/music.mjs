// Local structured-score composition. A successful response means a validated stereo WAV
// was probed and registered durably in Media. Placement requires the original target
// capture to remain current. Undo placement retains the reusable asset.
import { musicPlacementOps, musicAssetRecord, hasMusicByteIdentity, MUSIC_RENDERER, MUSIC_INSTRUMENTS } from '../core/music-score.js'
import { renderMusicWAV, discardMusicWAV } from '../music/render-score.mjs'
import { musicFileIdentity } from '../music/file-identity.mjs'

export default function musicRoutes(ctx) {
  const { ROOT, getProject, probe, callAPI } = ctx
  let rendering = false
  async function compose(body) {
    if (rendering) throw new Error('Another score is composing. Wait for it to finish before starting another.')
    const composing = ctx.musicComposeContext?.(), generation = ctx.getProjectGeneration?.()
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Review the open project before composing music')
    const admitted = await callAPI('GET', '/api/project')
    if (rendering) throw new Error('Another score is composing. Wait for it to finish before starting another.')
    if (!admitted.project || body?.expectedVersion !== admitted.version || ctx.getVersion?.() !== admitted.version || getProject() !== admitted.project) throw new Error('Review the current project version before composing music')
    const placement = musicPlacementOps(admitted.project, body)
    const check = () => {
      if (composing) composing.assertCurrent(); else ctx.assertCurrent?.()
      if (!getProject() || ctx.getProjectGeneration() !== generation) throw new Error('The original project was replaced while music was composing')
    }
    let rendered, committed = false
    rendering = true
    try {
      check()
      rendered = await renderMusicWAV(ROOT, placement.score, { assertCurrent: check })
      check()
      await rendered.validateIdentity()
      const asset = await (composing ? composing.probe(rendered) : probe(rendered.path))
      await rendered.validateIdentity()
      check()
      const receipt = { ...rendered, asset }, registered = musicAssetRecord(placement.score, receipt)
      if (!registered.generated.contentSHA256 || asset.size !== registered.generated.contentBytes) throw new Error('Register only the complete owned WAV bytes')
      const currentVersion = ctx.getVersion()
      if (!Number.isSafeInteger(currentVersion) || currentVersion < 0) throw new Error('Review the current project version before saving music')
      if (getProject().assets?.[rendered.path] !== undefined) throw new Error('This generated path already belongs to a Media asset')
      const registration = composing ? await composing.register(rendered, placement.score, asset)
        : { ...await callAPI('POST', '/api/ops', { ops: [{ op: 'import', assets: { [rendered.path]: registered } }], expectedVersion: currentVersion, who: 'agent', summary: `Created ${placement.score.title} in Media`, returnProject: false }), placementCurrent: currentVersion === admitted.version }
      committed = true
      const ready = { path: rendered.path, asset: registered, renderer: MUSIC_RENDERER }
      try {
        // Revalidate target after registration. Failure leaves real audio in Media and
        // returns a retry receipt instead of throwing away the result or regenerating.
        check()
        if (!registration.placementCurrent) throw new Error('The project changed while music was composing; the original placement needs review')
        const nextBody = { ...body, expectedVersion: registration.version }
        const ops = musicPlacementOps(getProject(), nextBody, receipt)
        await rendered.validateIdentity()
        const result = await callAPI('POST', '/api/ops', { ops, expectedVersion: registration.version, who: 'agent', summary: `Placed ${placement.score.title} on ${placement.track}`, returnProject: false })
        return { state: 'complete', ...ready, track: placement.track, comp: placement.comp, start: placement.start, dur: placement.dur, created: result.created, version: result.version }
      } catch (error) {
        ctx.log?.(`Music is saved in Media; placement needs review: ${error.message}`)
        return { state: 'asset_ready', ...ready, version: registration.version, placement: { state: 'failed', error: 'Music is saved in Media. Review the target and retry placement without regenerating.', retry: 'POST /api/audio/compose/place with this path and a reviewed target/version' } }
      }
    } finally {
      rendering = false
      if (rendered && !committed) {
        try { composing?.assertRoot(); await rendered.validateIdentity(); discardMusicWAV(ROOT, rendered, src => !!getProject()?.assets?.[src]) } catch {}
      }
    }
  }
  async function place(body) {
    if (!body || Object.keys(body).some(k => !['path', 'track', 'start', 'comp', 'expectedVersion', 'volume'].includes(k))) throw new Error('Unsupported music placement request')
    const snapshot = await callAPI('GET', '/api/project'), asset = snapshot.project?.assets?.[body.path]
    if (body.expectedVersion !== snapshot.version || asset?.generated?.kind !== 'original-music') throw new Error('Choose a generated music asset and review the current project version')
    const { path, ...target } = body
    const identity = hasMusicByteIdentity(asset) ? await musicFileIdentity(ROOT, path, { allowOversized: true, assertCurrent: ctx.assertCurrent }) : null
    if (identity && identity.contentSHA256 !== asset.generated.contentSHA256) throw new Error('This generated music file changed. Re-import it as a replacement before placing it. The saved Media entry was left unchanged.')
    const verified = await probe(path)
    await identity?.validate()
    ctx.assertCurrent?.()
    if (getProject() !== snapshot.project) throw new Error('The project changed. Review it before placing this music.')
    const score = asset.generated.score, receipt = { path, asset: verified, measurement: asset.generated.measurement }
    const ops = musicPlacementOps(snapshot.project, { ...target, score }, receipt)
    await identity?.validate()
    const result = await callAPI('POST', '/api/ops', { ops, expectedVersion: body.expectedVersion, who: 'agent', summary: `Placed ${asset.name} on ${body.track}`, returnProject: false })
    return { state: 'complete', path, asset, created: result.created, version: result.version }
  }
  return {
    routes: {
      'POST /api/audio/compose': compose,
      'POST /api/audio/compose/place': place,
      'GET /api/audio/compose/capabilities': () => ({ available: true, renderer: MUSIC_RENDERER, instruments: MUSIC_INSTRUMENTS, sampleRate: 48000, channels: 2, encoding: 'pcm_s24le', maximumSeconds: 60, maximumParts: 8, maximumNotes: 1024, maximumVoices: 24, externalMusicModel: false, source: 'Original structured notes, synthesized locally. No sampled instruments or vocals.' }),
    },
  }
}
