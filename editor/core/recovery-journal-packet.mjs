import fs from 'node:fs'

export const JOURNAL_TEXT_LIMIT = 64 * 1024 ** 2
export const JOURNAL_META_LIMIT = 8192
export const JOURNAL_PACKET_LIMIT = 2 * JOURNAL_TEXT_LIMIT + JOURNAL_META_LIMIT + 32
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes }
export function encodeJournalPacket(metadata, texts = []) {
  const meta = Buffer.from(JSON.stringify(metadata)), parts = [u64(meta.length), meta, u64(texts.length)]
  if (meta.length > JOURNAL_META_LIMIT || texts.length > 2) throw new Error('Recovery journal packet exceeds its bounds')
  for (const text of texts) {
    const bytes = Buffer.from(text)
    if (bytes.length > JOURNAL_TEXT_LIMIT) throw new Error('Recovery journal text exceeds its bounds')
    parts.push(u64(bytes.length), bytes)
  }
  return Buffer.concat(parts)
}
function parse(read) {
  const number = maximum => { const value = read(8).readBigUInt64BE(); if (value > BigInt(maximum)) throw new Error('Recovery journal packet exceeds its bounds'); return Number(value) }
  const encoded = read(number(JOURNAL_META_LIMIT)), decoded = encoded.toString('utf8')
  if (!Buffer.from(decoded).equals(encoded)) throw new Error('Recovery journal metadata must be UTF8')
  const metadata = JSON.parse(decoded), count = number(2), texts = []
  for (let i = 0; i < count; i++) {
    const bytes = read(number(JOURNAL_TEXT_LIMIT)), text = bytes.toString('utf8')
    if (!Buffer.from(text).equals(bytes)) throw new Error('Recovery journal text must be UTF8')
    texts.push(text)
  }
  return { metadata, texts }
}
export function decodeJournalPacket(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > JOURNAL_PACKET_LIMIT) throw new Error('Recovery journal response exceeds its bounds')
  let position = 0
  const result = parse(count => { if (position + count > bytes.length) throw new Error('Incomplete recovery journal packet'); const value = bytes.subarray(position, position + count); position += count; return value })
  if (position !== bytes.length) throw new Error('Trailing recovery journal bytes')
  return result
}
export function readJournalPacket(fd = 0) {
  const result = parse(count => {
    const bytes = Buffer.alloc(count); let position = 0
    while (position < count) { const next = fs.readSync(fd, bytes, position, count - position, null); if (!next) throw new Error('Incomplete recovery journal packet'); position += next }
    return bytes
  })
  if (fs.readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error('Trailing recovery journal bytes')
  return result
}
