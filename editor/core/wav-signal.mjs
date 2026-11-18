// Says whether a 16-bit PCM WAV has any sample above a level. whisper.cpp returns an invented word
// ("You") for digital silence, so the transcript route checks the audio it extracted before it
// runs recognition.
import fsp from 'node:fs/promises'
import os from 'node:os'

export const SILENCE_DBFS = -60

/** The offset of the sample data in a RIFF/WAVE header, or null when it is not 16-bit PCM. */
function pcm16DataOffset(header) {
  if (header.length < 12 || header.toString('latin1', 0, 4) !== 'RIFF' || header.toString('latin1', 8, 12) !== 'WAVE') return null
  let offset = 12, pcm16 = false
  while (offset + 8 <= header.length) {
    const id = header.toString('latin1', offset, offset + 4), size = header.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      if (offset + 24 > header.length) return null
      pcm16 = header.readUInt16LE(offset + 8) === 1 && header.readUInt16LE(offset + 22) === 16
    } else if (id === 'data') return pcm16 ? offset + 8 : null
    offset += 8 + size + (size % 2)
  }
  return null
}

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
