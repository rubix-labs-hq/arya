import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { createMusicRenderer, musicMeasurement, musicPCM24, musicWAVHeader } from '../core/music-score.js'
import { musicFileIdentity } from './file-identity.mjs'

// No caller-controlled output paths. Each render owns one exclusive namespace and creates
// a final file without replacing anything. Reject linked output components, even missing
// descendants. This is confinement, not immunity to concurrent external directory swaps.
function safe(root, target) {
  const base = path.resolve(root), file = path.resolve(target)
  if (file === base || !file.startsWith(base + path.sep)) throw new Error('Music output is outside the project')
  for (let p = file; ; p = path.dirname(p)) {
    try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('Music output cannot use symbolic links') }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    if (p === base) break
  }
  return file
}

function checkpoint(signal, assertCurrent) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Music composition cancelled')
  assertCurrent?.()
}

/** Two passes, bounded chunk memory, exact-duration 48 kHz stereo PCM24 WAV. */
export async function renderMusicWAV(root, input, { signal, assertCurrent, onProgress } = {}) {
  checkpoint(signal, assertCurrent)
  const first = createMusicRenderer(input), measure = musicMeasurement()
  let done = 0, chunk
  while ((chunk = first.renderChunk()).length) {
    measure.add(chunk); done += chunk.length / 2
    checkpoint(signal, assertCurrent)
    onProgress?.(0.5 * done / first.frames)
    await yieldEventLoop()
  }
  const measurement = measure.result()
  checkpoint(signal, assertCurrent)
  const relativeDir = `media/generated/music/${randomUUID()}`
  const relativePath = `${relativeDir}/score.wav`, dir = safe(root, path.join(root, relativeDir))
  const partial = safe(root, path.join(dir, 'score.part.wav')), final = safe(root, path.join(root, relativePath))
  fs.mkdirSync(safe(root, path.dirname(dir)), { recursive: true })
  safe(root, dir)
  fs.mkdirSync(dir, { recursive: false })
  let fd, published = false
  try {
    fd = fs.openSync(safe(root, partial), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    const write = bytes => {
      const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      let offset = 0
      while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset)
    }
    write(musicWAVHeader(first.frames))
    const second = createMusicRenderer(first.score)
    done = 0
    while ((chunk = second.renderChunk()).length) {
      checkpoint(signal, assertCurrent)
      write(musicPCM24(chunk, measurement.gain)); done += chunk.length / 2
      onProgress?.(0.5 + 0.5 * done / second.frames)
      await yieldEventLoop()
    }
    checkpoint(signal, assertCurrent)
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
    if (fs.statSync(safe(root, partial)).size !== 44 + first.frames * 6) throw new Error('Music WAV is incomplete')
    fs.linkSync(safe(root, partial), safe(root, final)) // exclusive publication, no overwrite
    published = true
    fs.unlinkSync(safe(root, partial))
    const identity = await musicFileIdentity(root, relativePath, { assertCurrent: () => checkpoint(signal, assertCurrent) })
    checkpoint(signal, assertCurrent)
    return { path: relativePath, absolutePath: final, score: first.score, measurement, frames: first.frames, sampleRate: first.sampleRate, channels: 2, contentSHA256: identity.contentSHA256, validateIdentity: identity.validate }
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(safe(root, partial)) } catch {}
    if (published) { try { fs.unlinkSync(safe(root, final)) } catch {} }
    try { fs.rmdirSync(safe(root, dir)) } catch {}
    throw error
  }
}

/** Remove only our completed unregistered WAV; no recursive deletion of user content. */
export function discardMusicWAV(root, rendered, isRegistered = () => false) {
  if (!rendered || isRegistered(rendered.path)) return
  if (!/^media\/generated\/music\/[0-9a-f-]{36}\/score\.wav$/.test(rendered.path)) throw new Error('Invalid owned music output')
  fs.unlinkSync(safe(root, path.join(root, rendered.path)))
  try { fs.rmdirSync(safe(root, path.dirname(path.join(root, rendered.path)))) } catch {}
}
