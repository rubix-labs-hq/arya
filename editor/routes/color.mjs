import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parseCube } from '../core/cube-lut.js'
import { lookLUT } from '../core/look-lut.js'
import { referenceStatistics, referenceTransfer } from '../core/reference-look.js'
import { applyOps, compView, duration } from '../core/project.js'
import { guardedOutput } from '../core/output-path.js'

const MAX_CUBE = 16 * 1024 * 1024, MAX_IMAGE = 32 * 1024 * 1024
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
function executable(name) {
  return (process.env.PATH ?? '').split(path.delimiter).some(dir => { try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return fs.statSync(path.join(dir, name)).isFile() } catch { return false } })
}
export function colorCapabilities({ renderer = false, ffmpeg = executable('ffmpeg') } = {}) {
  return { cubeImport: true, lutInspect: true, lutApply: true, lutExport: true, referenceMatch: Boolean(renderer && ffmpeg), referenceEngine: 'local-render-and-ffmpeg-display-rgb', maxCubeBytes: MAX_CUBE, maxReferenceBytes: MAX_IMAGE }
}
function cubeInfo(text) {
  const cube = parseCube(text)
  return { size: cube.size, domainMin: cube.domainMin, domainMax: cube.domainMax, sourceHash: hash(Buffer.from(text, 'utf8')) }
}
function safeName(name, suffix) {
  const clean = String(name ?? 'Arya look').trim().replace(/[^\w. -]+/g, '-').replace(/\.+$/g, '').slice(0, 80)
  return `${clean && clean !== '.' && clean !== '..' ? clean.replace(/\.(cube|png|jpg|jpeg)$/i, '') : 'Arya-look'}-${suffix}`
}

export default function colorRoutes(ctx) {
  const { ROOT, getProject, getVersion, editOps } = ctx
  function fileInput(relative, maximum) {
    if (typeof relative !== 'string' || !relative) throw new Error('Choose a project file')
    const file = guardedOutput(ROOT, path.resolve(ROOT, relative))
    const initial = fs.lstatSync(file)
    if (!initial.isFile() || initial.size <= 0 || initial.size > maximum) throw new Error(`Choose a nonempty regular file of at most ${maximum / 1048576} MiB`)
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      const before = fs.fstatSync(fd)
      if (!before.isFile() || before.size <= 0 || before.size > maximum) throw new Error(`Choose a nonempty regular file of at most ${maximum / 1048576} MiB`)
      if (stamp(initial) !== stamp(before)) throw new Error('The input file changed before it was opened')
      const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd)
      if (bytes.length > maximum || stamp(before) !== stamp(after)) throw new Error('The input file changed while it was read')
      return { file, path: path.relative(ROOT, file), bytes, signature: stamp(after), sourceHash: hash(bytes), byteHash: hash(bytes) }
    } finally { fs.closeSync(fd) }
  }
  function verify(input, maximum) {
    const current = fileInput(input.path, maximum)
    if (current.file !== input.file || current.signature !== input.signature || current.byteHash !== input.byteHash) throw new Error('The input file changed. Inspect or match it again')
  }
  function readLUT(relative, expectedHash) {
    if (!/\.cube$/i.test(String(relative))) throw new Error('Choose a standalone .cube LUT')
    const input = fileInput(relative, 128 * 1024 * 1024)
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.bytes)
    const info = cubeInfo(text)
    if (expectedHash !== undefined && (typeof expectedHash !== 'string' || expectedHash !== info.sourceHash)) throw new Error('The LUT changed after inspection. Inspect it again')
    verify(input, 128 * 1024 * 1024)
    return { ...input, ...info, text }
  }
  function capture(body) {
    const project = getProject(), version = getVersion()
    if (!project) throw new Error('Open a project before using color tools')
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion !== version) throw new Error('The project changed. Refresh it before applying color changes')
    if (!Object.hasOwn(body, 'comp') || body.comp !== null && (typeof body.comp !== 'string' || !body.comp)) throw new Error('Specify a composition ID or null for the main timeline')
    return { project, version, composition: body.comp, view: compView(project, body.comp) }
  }
  function current(capture) {
    ctx.assertCurrent?.()
    if (getProject() !== capture.project || getVersion() !== capture.version) throw new Error('The project changed during color processing. Start again')
  }
  function targets(capture, items, settings) {
    if (!Array.isArray(items) || !items.length || items.length > 256) throw new Error('Choose between 1 and 256 visual LUT targets')
    const seen = new Set(), visual = new Set(['video', 'image', 'title', 'shape', 'color', 'comp', 'adjustment', 'multicam'])
    return items.map(item => {
      const track = capture.view.tracks.find(t => t.clips.some(c => c.id === item?.id)), clip = track?.clips.find(c => c.id === item?.id)
      if (!clip || track.locked || !visual.has(clip.kind)) throw new Error('Choose an unlocked visual clip in the captured composition')
      const identity = JSON.stringify([item.id, item.kind, item.node ?? null])
      if (seen.has(identity)) throw new Error('A LUT target was repeated')
      seen.add(identity)
      const grade = { lut: settings.path, lutMix: settings.mix, lutSpace: settings.space }
      if (item.kind === 'clipGrade' && item.node === undefined) return { op: 'update', id: clip.id, comp: capture.composition, set: { grade } }
      const node = clip.nodes?.list?.find(node => node.id === item.node)
      if (item.kind === 'nodeGrade' && node?.type === 'corrector') return { op: 'node_update', id: clip.id, comp: capture.composition, node: node.id, set: { grade } }
      if (item.kind === 'lutNode' && node?.type === 'lut') return { op: 'node_update', id: clip.id, comp: capture.composition, node: node.id, set: { lut: settings.path, mix: settings.mix, lutSpace: settings.space } }
      throw new Error('Choose a primary, corrector or LUT node that matches the captured target')
    })
  }
  function inspect(body) {
    const input = readLUT(body.path)
    return { path: input.path, size: input.size, domainMin: input.domainMin, domainMax: input.domainMax, sourceHash: input.sourceHash }
  }
  function exportCube(body) {
    if (typeof body.expectedInputHash !== 'string') throw new Error('Inspect the LUT before exporting it')
    const input = readLUT(body.path, body.expectedInputHash)
    return { path: input.path, text: input.text, size: input.size, domainMin: input.domainMin, domainMax: input.domainMax, sourceHash: input.sourceHash }
  }
  function importCube(body) {
    if (typeof body.name !== 'string' || !/\.cube$/i.test(body.name) || typeof body.text !== 'string' || Buffer.byteLength(body.text, 'utf8') > MAX_CUBE) throw new Error('Choose a UTF-8 CUBE file of at most 16 MiB')
    const info = cubeInfo(body.text)
    ctx.assertCurrent?.()
    const directory = guardedOutput(ROOT, path.join(ROOT, 'luts'))
    fs.mkdirSync(directory, { recursive: true })
    const relative = path.join('luts', `${safeName(body.name, randomUUID().slice(0, 8))}.cube`)
    fs.writeFileSync(guardedOutput(ROOT, path.join(ROOT, relative)), body.text, { encoding: 'utf8', flag: 'wx' })
    return { ...info, path: relative, imported: true }
  }
  async function apply(body) {
    if (typeof body.expectedInputHash !== 'string') throw new Error('Inspect the LUT before applying it')
    const captured = capture(body), input = readLUT(body.path, body.expectedInputHash)
    const mix = body.mix ?? 1, space = body.space ?? 'srgb'
    if (!Number.isFinite(mix) || mix < 0 || mix > 1 || !['srgb', 'working'].includes(space)) throw new Error('Choose a valid LUT mix and color space')
    const ops = targets(captured, body.targets, { path: input.path, mix, space })
    applyOps(captured.project, ops)
    current(captured); verify(input, 128 * 1024 * 1024)
    const result = await editOps(ops, body.who ?? 'you', `Applied LUT to ${body.targets.length} targets`, { expectedVersion: captured.version, returnProject: true })
    return { ...result, applied: true, path: input.path, sourceHash: input.sourceHash }
  }
  async function sample(input) {
    const metadata = await ctx.probe(input.path)
    if (!(metadata.width > 0 && metadata.height > 0) || metadata.width > 30000 || metadata.height > 30000 || metadata.width * metadata.height > 64_000_000) throw new Error('Choose a readable image of at most 64 million pixels')
    const result = await ctx.run('ffmpeg', ['-nostdin', '-v', 'error', '-i', input.file, '-map', '0:v:0', '-an', '-frames:v', '1', '-vf', 'scale=64:64:flags=area,format=rgba', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer', timeout: 15000 })
    verify(input, MAX_IMAGE)
    return referenceStatistics(result.stdout)
  }
  async function match(body) {
    const captured = capture(body), at = body.at ?? 0, mix = body.mix ?? 1, strength = body.strength ?? 0.75
    if (!Number.isFinite(at) || at < 0 || !Number.isFinite(mix) || mix < 0 || mix > 1) throw new Error('Choose a valid frame time and LUT mix')
    if (!body.reference && !Object.keys(body.grade ?? {}).length) throw new Error('Provide grade controls or a reference image')
    // Validate transform settings before starting the composition renderer.
    lookLUT({ name: body.name, size: body.size ?? 33, grade: body.grade })
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Look strength must be between zero and one')
    if (body.clip) targets(captured, [{ id: body.clip, kind: 'clipGrade' }], { path: '', mix, space: 'srgb' })
    let transfer, measurements = {}, warnings = []
    if (body.reference) {
      if (!ctx.referenceAvailable?.()) throw new Error('Reference matching requires a local composition renderer and ffmpeg')
      if (!/\.(png|jpe?g|webp)$/i.test(body.reference)) throw new Error('Choose a PNG, JPEG or WebP reference image')
      const reference = fileInput(body.reference, MAX_IMAGE)
      const frame = await ctx.callAPI('POST', '/api/frame', { at, width: 512, comp: captured.composition })
      current(captured); verify(reference, MAX_IMAGE)
      const source = fileInput(frame.path, MAX_IMAGE)
      const [from, to] = await Promise.all([sample(source), sample(reference)])
      current(captured); verify(reference, MAX_IMAGE); verify(source, MAX_IMAGE)
      transfer = referenceTransfer(from, to, strength)
      measurements = { source: from, reference: to, strength, method: 'trimmed-rgb-mean-deviation', colorSpace: 'display-rgb', referenceHash: reference.sourceHash, sourceFrameHash: source.sourceHash }
      warnings = ['Matching transfers overall RGB color and contrast. Scene content affects the result. Check the scopes and adjust the LUT mix.', 'The local browser sampler uses 8-bit ffmpeg display RGB. Embedded ICC profiles and HDR equivalence require separate output review.']
    }
    current(captured)
    const generated = lookLUT({ name: body.name, size: body.size ?? 33, grade: body.grade, transfer })
    const directory = guardedOutput(ROOT, path.join(ROOT, 'luts'))
    fs.mkdirSync(directory, { recursive: true })
    const stem = safeName(body.name, randomUUID().slice(0, 8)), relative = `luts/${stem}.cube`, manifest = `luts/${stem}.look.json`
    const cubeFile = guardedOutput(ROOT, path.join(ROOT, relative)), manifestFile = guardedOutput(ROOT, path.join(ROOT, manifest))
    fs.writeFileSync(cubeFile, generated.text, { encoding: 'utf8', flag: 'wx' })
    try { fs.writeFileSync(manifestFile, JSON.stringify({ version: 1, lut: relative, colorSpace: 'srgb', reference: body.reference ?? null, measurements, options: { grade: body.grade ?? {}, transfer, strength }, warnings }, null, 2) + '\n', { flag: 'wx' }) }
    catch (error) { fs.rmSync(guardedOutput(ROOT, cubeFile)); throw error }
    const grade = { lut: relative, lutMix: mix, lutSpace: 'srgb' }
    const ops = body.clip ? [{ op: 'update', id: body.clip, comp: captured.composition, set: { grade } }] : [{ op: 'adjustment', comp: captured.composition, start: 0, dur: Math.max(1, duration(captured.view)), set: { label: 'Reference look', grade } }]
    const response = { lut: relative, path: relative, manifest, ops, measurements, warnings }
    if (body.apply === true) {
      current(captured)
      response.edit = await editOps(ops, body.who ?? 'you', 'Apply generated look', { expectedVersion: captured.version, returnProject: true })
      response.version = response.edit.version
    }
    return response
  }
  return { routes: { 'POST /api/luts/import': importCube, 'POST /api/luts/inspect': inspect, 'POST /api/luts/export': exportCube, 'POST /api/luts/apply': apply, 'POST /api/looks/match': match } }
}
