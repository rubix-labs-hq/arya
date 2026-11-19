// Says whether a 16-bit PCM WAV has any sample above a level. whisper.cpp returns an invented word
// ("You") for digital silence, so the transcript route checks the audio it extracted before it
// runs recognition.
import fsp from 'node:fs/promises'
import os from 'node:os'

export const SILENCE_DBFS = -60

/** Where the sample data starts in a RIFF/WAVE header, with its rate and channels, or null when it is not 16-bit PCM. */
function pcm16Format(header) {
  if (header.length < 12 || header.toString('latin1', 0, 4) !== 'RIFF' || header.toString('latin1', 8, 12) !== 'WAVE') return null
  let offset = 12, format = null
  while (offset + 8 <= header.length) {
    const id = header.toString('latin1', offset, offset + 4), size = header.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      if (offset + 24 > header.length) return null
      format = header.readUInt16LE(offset + 8) === 1 && header.readUInt16LE(offset + 22) === 16 ? { channels: header.readUInt16LE(offset + 10), rate: header.readUInt32LE(offset + 12) } : null
    } else if (id === 'data') return format ? { ...format, start: offset + 8 } : null
    offset += 8 + size + (size % 2)
  }
  return null
}
const pcm16DataOffset = header => pcm16Format(header)?.start ?? null

/**
 * true when a sample reaches `thresholdDb` (dBFS, peak), false when every sample is below it, and
 * null when the file is missing, is not 16-bit PCM WAV or has no samples. A caller treats null as
 * "unknown" and must not treat it as silence. Reading stops at the first loud sample.
 */
export async function wavHasSignal(file, { thresholdDb = SILENCE_DBFS, signal } = {}) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
    const header = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const start = pcm16DataOffset(header.subarray(0, bytesRead))
    if (start === null) return null
    const limit = 32768 * 10 ** (thresholdDb / 20)
    // Its own ArrayBuffer at offset 0, so the samples can be read as an Int16Array.
    const buffer = Buffer.allocUnsafeSlow(1024 * 1024), little = os.endianness() === 'LE'
    let position = start, samples = 0, carry = 0
    for (;;) {
      if (signal?.aborted) return null
      const { bytesRead: count } = await handle.read(buffer, carry, buffer.length - carry, position)
      if (count <= 0) break
      position += count
      const usable = carry + count, pairs = usable >> 1
      if (little) {
        const view = new Int16Array(buffer.buffer, 0, pairs)
        for (let i = 0; i < pairs; i++) { const value = view[i]; if (value >= limit || -value >= limit) return true }
      } else {
        for (let i = 0; i < pairs; i++) { const value = buffer.readInt16LE(i * 2); if (value >= limit || -value >= limit) return true }
      }
      samples += pairs
      // An odd byte left over starts the next read.
      carry = usable & 1
      if (carry) buffer[0] = buffer[usable - 1]
    }
    return samples ? false : null
  } catch { return null }
  finally { await handle?.close().catch(() => {}) }
}

// The defaults of the silence analysis (POST /api/analyze kind silence in server.mjs), so the pauses
// found here are the ones a cut made from that analysis removes.
export const PAUSE_DBFS = -32
export const PAUSE_SECONDS = 0.45
const PAUSE_WINDOW = 0.01
// A quiet recording peaks well below full scale. Its pauses are found this far below its own peak.
const PAUSE_BELOW_PEAK_DB = 26

/**
 * The pauses in a 16-bit PCM WAV as [start, end] pairs in seconds: every stretch of at least
 * `minSeconds` whose samples stay below `thresholdDb` (dBFS, peak), measured in 10 ms steps. For a
 * recording whose own peak is low, the level is 26 dB below that peak instead. Returns
 * { pauses, duration }, or null when the file is missing, is not 16-bit PCM WAV, has no samples or
 * has no sound at all. A caller treats null as "unknown".
 */
export async function wavPauses(file, { thresholdDb = PAUSE_DBFS, minSeconds = PAUSE_SECONDS, signal } = {}) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
    const header = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const format = pcm16Format(header.subarray(0, bytesRead))
    if (!format || !(format.rate > 0) || !(format.channels > 0)) return null
    const perWindow = Math.max(1, Math.round(format.rate * PAUSE_WINDOW)) * format.channels
    const size = (await handle.stat()).size - format.start
    if (!(size >= 2)) return null
    // One peak for every 10 ms: four hours of sound is 1.4 million numbers.
    const peaks = new Uint16Array(Math.ceil(size / 2 / perWindow))
    const buffer = Buffer.allocUnsafeSlow(1024 * 1024)
    let position = format.start, sample = 0, carry = 0, top = 0
    for (;;) {
      if (signal?.aborted) return null
      const { bytesRead: count } = await handle.read(buffer, carry, buffer.length - carry, position)
      if (count <= 0) break
      position += count
      const usable = carry + count, pairs = usable >> 1
      for (let i = 0; i < pairs; i++, sample++) {
        const value = Math.abs(buffer.readInt16LE(i * 2)), index = Math.floor(sample / perWindow)
        if (index < peaks.length && value > peaks[index]) { peaks[index] = Math.min(65535, value); if (value > top) top = value }
      }
      carry = usable & 1
      if (carry) buffer[0] = buffer[usable - 1]
    }
    if (!sample || !top) return null
    const peakDb = 20 * Math.log10(top / 32768)
    const limit = 32768 * 10 ** (Math.min(thresholdDb, peakDb - PAUSE_BELOW_PEAK_DB) / 20)
    const windows = Math.ceil(sample / perWindow), seconds = perWindow / format.channels / format.rate, duration = sample / format.channels / format.rate
    const pauses = []
    let quietFrom = -1
    for (let index = 0; index <= windows; index++) {
      const quiet = index < windows && peaks[index] < limit
      if (quiet && quietFrom < 0) quietFrom = index
      else if (!quiet && quietFrom >= 0) {
        const from = quietFrom * seconds, to = Math.min(duration, index * seconds)
        if (to - from >= minSeconds) pauses.push([Math.round(from * 1000) / 1000, Math.round(to * 1000) / 1000])
        quietFrom = -1
      }
    }
    return { pauses, duration }
  } catch { return null }
  finally { await handle?.close().catch(() => {}) }
}
