// One echoed MCP image can contain 5,592,408 base64 bytes. Keep its JSON envelope
// bounded separately from retained events and from cumulative provider output.
export const OUTPUT_RECORD_BYTES = 8 * 1024 * 1024
export const OUTPUT_TOTAL_BYTES = 64 * 1024 * 1024

export function createOutputStream(onRecord, { maxRecordBytes = OUTPUT_RECORD_BYTES, maxTotalBytes = OUTPUT_TOTAL_BYTES } = {}) {
  let storage = Buffer.alloc(0), pending = 0, total = 0, ended = false
  const discard = () => { storage = Buffer.alloc(0); pending = 0; ended = true }
  const append = bytes => {
    const needed = pending + bytes.length
    if (needed > maxRecordBytes) throw Error('Agent output record exceeded its limit')
    if (needed > storage.length) {
      const next = Buffer.allocUnsafe(Math.min(maxRecordBytes, Math.max(65536, storage.length * 2, needed)))
      storage.copy(next, 0, 0, pending); storage = next
    }
    bytes.copy(storage, pending); pending = needed
  }
  const emit = () => {
    // Decode only complete records, so split UTF-8 code points remain intact.
    const line = storage.toString('utf8', 0, pending)
    pending = 0
    if (onRecord(line) === false) discard()
  }
  return {
    push(chunk) {
      if (ended) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += bytes.length
      if (total > maxTotalBytes) throw Error('Agent output exceeded its cumulative byte limit')
      let offset = 0
      while (offset < bytes.length && !ended) {
        const boundary = bytes.indexOf(10, offset)
        const end = boundary < 0 ? bytes.length : boundary
        append(bytes.subarray(offset, end))
        if (boundary < 0) break
        emit(); offset = boundary + 1
      }
    },
    finish() { if (!ended) { if (pending) emit(); discard() } },
    discard,
    get pendingBytes() { return pending },
    get totalBytes() { return total },
  }
}
