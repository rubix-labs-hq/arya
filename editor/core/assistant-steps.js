// Processing an assistant may propose in Preview changes: what each step will produce and
// where it lands, checked against the project the preview would create. Nothing renders
// until the user applies the preview. The browser server and the native app share this.

import { musicPlacementOps } from './music-score.js'
import { timecode } from './project.js'

export const PREVIEW_STEP_ROUTES = ['/api/stabilize/render', '/api/retime', '/api/video/denoise', '/api/audio/clean', '/api/audio/compose', '/api/audio/compose/place']
/** Routes that return a job; the runner asks them to finish before it starts the next step. */
export const PREVIEW_STEP_WAITS = ['/api/stabilize/render', '/api/retime', '/api/video/denoise']

const fail = message => { throw new Error(message) }
const seconds = value => `${Math.round(value * 100) / 100} s`
const fileName = src => String(src ?? '').split('/').pop()

function scopeOf(project, comp) {
  if (comp == null) return project
  return Object.hasOwn(project.comps ?? {}, comp) ? project.comps[comp] : fail(`no composition ${comp}`)
}

/** The clip a step targets: by id, in the named composition or anywhere when it is unique. */
function target(project, body, { clipOnly = false } = {}) {
  const id = clipOnly ? body.clip : body.clip ?? body.id
  if (typeof id !== 'string' || !id) return null
  const scopes = Object.hasOwn(body, 'comp') ? [[body.comp ?? null, scopeOf(project, body.comp ?? null)]] : [[null, project], ...Object.entries(project.comps ?? {})]
  const hits = scopes.flatMap(([comp, scope]) => (scope.tracks ?? []).flatMap(track => (track.clips ?? []).filter(clip => clip.id === id).map(clip => ({ comp, scope, track, clip }))))
  if (hits.length !== 1) fail(hits.length ? `clip ${id} is in more than one composition; name its comp` : `no clip ${id}`)
  return hits[0]
}

// A step that names only its clip runs over that clip's whole source range, as the editor sends
// it; the render routes replace a clip's picture only when they process its complete range.
function completeBody(project, path, body) {
  if (path === '/api/video/denoise') {
    const hit = Object.hasOwn(body, 'comp') ? target(project, body) : null
    return hit ? { ...body, src: body.src ?? hit.clip.src, in: body.in ?? hit.clip.in ?? 0, dur: body.dur ?? hit.clip.dur * (hit.clip.speed ?? 1) } : body
  }
  if ((path === '/api/stabilize/render' || path === '/api/retime') && body.in === undefined && body.dur === undefined && typeof body.clip === 'string' && body.clip) {
    const hit = target(project, body, { clipOnly: true })
    if (hit.clip.src === body.src) return { ...body, in: hit.clip.in ?? 0, dur: hit.clip.dur * (hit.clip.speed ?? 1) }
  }
  return body
}

const near = (a, b) => Math.abs(a - b) <= 1e-5
/** Placement replaces a clip's media only with a render of the clip's complete source range. */
function completeRange(path, hit, from, dur) {
  const clipIn = hit.clip.in ?? 0, length = hit.clip.dur * (hit.clip.speed ?? 1)
  if (!near(from, clipIn) || !near(dur, length)) fail(`${path} replaces clip ${hit.clip.id} only with its complete source range (in ${clipIn}, dur ${Math.round(length * 1e6) / 1e6}). Leave in and dur out to use it.`)
}

const label = (hit, fps) => `${hit.clip.label ?? fileName(hit.clip.src) ?? hit.clip.id} (${hit.clip.id}) on ${hit.track.id} at ${timecode(hit.clip.start, fps)}`

/**
 * A preview step's plain description, { title, produces, lands, body }, where body is the
 * request that runs on Apply with the clip's source range filled in. Throws when the step
 * cannot run against this project, so the assistant learns before the user applies.
 */
export function describeStep(project, step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) fail('Each step needs a path and a body.')
  const { path } = step
  if (!PREVIEW_STEP_ROUTES.includes(path)) fail(`${path} cannot be a preview step. Steps are ${PREVIEW_STEP_ROUTES.join(', ')}.`)
  if (!step.body || typeof step.body !== 'object' || Array.isArray(step.body)) fail(`${path} needs a body object.`)
  if (Object.hasOwn(step.body, 'apply') && step.body.apply !== true && path !== '/api/audio/compose' && path !== '/api/audio/compose/place') fail(`${path} in a preview applies when the user applies; leave apply out.`)
  const body = completeBody(project, path, step.body)
  return { ...described(project, path, body), body }
}

function described(project, path, body) {
  const fps = project.fps ?? 30
  if (path === '/api/stabilize/render' || path === '/api/retime') {
    if (typeof body.src !== 'string' || !body.src) fail(`${path} needs src.`)
    if (!project.assets?.[body.src]) fail(`${body.src} is not in Media.`)
    // These renders place their output only on body.clip.
    if (body.clip === undefined && body.id !== undefined) fail(`${path} names its clip with clip, not id.`)
    const hit = target(project, body, { clipOnly: true })
    if (hit && hit.clip.src !== body.src) fail(`clip ${hit.clip.id} does not play ${body.src}.`)
    const from = Number(body.in ?? 0), dur = Number(body.dur ?? (project.assets[body.src].duration ?? 0) - from)
    if (!Number.isFinite(from) || !Number.isFinite(dur) || dur <= 0) fail(`${path} needs a positive source range.`)
    if (hit) completeRange(path, hit, from, dur)
    if (path === '/api/retime') {
      const speed = Number(body.speed)
      if (!(speed >= 0.05 && speed < 1)) fail('Optical-flow retiming is for slow motion: speed 0.05 to 0.99.')
      return { title: `Slow motion at ${Math.round(speed * 100)}% with optical flow`, produces: `A new ${seconds(dur / speed)} video in media/retimed from ${fileName(body.src)} ${timecode(from, fps)} to ${timecode(from + dur, fps)}.`,
        lands: hit ? `Replaces the picture of ${label(hit, fps)}, which plays at ${Math.round(speed * 100)}% and becomes ${seconds(hit.clip.dur / speed)} long.` : 'Saved in Media only.' }
    }
    const zoom = Math.max(1, Math.min(1.5, Number(body.zoom ?? 1)))
    return { title: 'Stabilize (deshake render)', produces: `A steadied ${seconds(dur)} copy of ${fileName(body.src)} in media/stabilized${zoom > 1 ? `, zoomed ${zoom}x to hide moving edges` : ''}.`,
      lands: hit ? `Replaces the picture of ${label(hit, fps)}. Timing stays the same.` : 'Saved in Media only.' }
  }
  if (path === '/api/video/denoise') {
    if (!Object.hasOwn(body, 'comp')) fail('/api/video/denoise needs comp (null for the main timeline).')
    const hit = target(project, body) ?? fail('/api/video/denoise needs the clip to denoise.')
    if (hit.clip.kind !== 'video' || hit.track.locked) fail('Denoise needs an unlocked video clip.')
    if (body.src !== hit.clip.src) fail(`clip ${hit.clip.id} does not play ${body.src}.`)
    completeRange(path, hit, Number(body.in), Number(body.dur))
    return { title: 'Video noise reduction', produces: `A denoised copy of ${fileName(hit.clip.src)} for the clip's ${seconds(hit.clip.dur * (hit.clip.speed ?? 1))} source range in media/denoised.`,
      lands: `Replaces the picture of ${label(hit, fps)}. Timing stays the same.` }
  }
  if (path === '/api/audio/clean') {
    if (typeof body.src !== 'string' || !body.src) fail('/api/audio/clean needs src.')
    const mode = body.mode ?? 'denoise'
    if (!['denoise', 'voice'].includes(mode)) fail('Cleanup mode is denoise or voice.')
    const hit = target(project, body)
    if (hit && (hit.clip.kind !== 'audio' || hit.track.locked || hit.clip.src !== body.src)) fail(`Cleanup needs the unlocked audio clip that plays ${body.src}.`)
    return { title: mode === 'voice' ? 'Voice cleanup' : 'Audio noise reduction', produces: `A cleaned WAV of ${fileName(body.src)} in media/cleaned.`,
      lands: hit ? `Replaces the sound of ${label(hit, fps)}.` : 'Saved in Media only.' }
  }
  if (path === '/api/audio/compose') {
    const placement = musicPlacementOps(project, { ...body, expectedVersion: 0 })
    const parts = placement.score.parts.map(part => part.instrument).join(', ')
    return { title: `Original music: ${placement.score.title}`, produces: `Stereo music, ${seconds(placement.dur)} at ${placement.score.bpm} BPM (${parts}), synthesized locally and saved in Media.`,
      lands: `A new clip on ${placement.track}${placement.comp ? ` in ${placement.comp}` : ''} from ${timecode(placement.start, fps)} to ${timecode(placement.start + placement.dur, fps)}.` }
  }
  const asset = project.assets?.[body.path]
  if (asset?.generated?.kind !== 'original-music') fail('/api/audio/compose/place needs a generated music asset path.')
  const placement = musicPlacementOps(project, { score: asset.generated.score, track: body.track, start: body.start, comp: body.comp ?? null, volume: body.volume, expectedVersion: 0 })
  return { title: `Place ${asset.name ?? fileName(body.path)}`, produces: 'Nothing new: the music already exists in Media.',
    lands: `A new clip on ${placement.track} from ${timecode(placement.start, fps)} to ${timecode(placement.start + placement.dur, fps)}.` }
}
