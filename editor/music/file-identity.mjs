import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { guardedOutput } from '../core/output-path.js'

export const MAX_MUSIC_WAV_BYTES = 44 + 2_880_000 * 6
const ownedPath = /^media\/generated\/music\/[0-9a-f-]{36}\/score\.wav$/
const same = (a, b) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key])
const file = (root, src) => {
  if (typeof src !== 'string' || !ownedPath.test(src)) throw new Error('Music identity requires an owned generated WAV path')
  return guardedOutput(root, path.resolve(root, src))
}
function checkOwned(stat) {
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.geteuid()) || (stat.mode & 0o022n) !== 0n || stat.size < 44n) throw new Error('Music identity requires an owned regular file without links or shared write access')
}
async function verifyPath(root, src, captured) {
  const current = await fsp.lstat(file(root, src), { bigint: true })
  checkOwned(current)
  if (!same(current, captured)) throw new Error('The generated music file changed during verification')
}

/** Stable descriptor, 64 KiB streaming memory and <=17.3 MB of content. Oversized
 * replacements are known mismatches without hashing. This does not promise namespace
 * atomicity against another process with the same user privileges. */
export async function musicFileIdentity(root, src, { allowOversized = false, assertCurrent, afterDescriptorValidation } = {}) {
  assertCurrent?.()
  const handle = await fsp.open(file(root, src), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const before = await handle.stat({ bigint: true }); checkOwned(before)
    await verifyPath(root, src, before)
    await afterDescriptorValidation?.()
    const oversized = before.size > BigInt(MAX_MUSIC_WAV_BYTES)
    if (oversized && !allowOversized) throw new Error('Generated music exceeds its supported byte limit')
    let digest = null
    if (!oversized) {
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(65_536)
      let total = 0
      while (total < Number(before.size)) {
        assertCurrent?.()
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - total), total)
        if (!bytesRead) throw new Error('The generated music file ended during verification')
        hash.update(buffer.subarray(0, bytesRead)); total += bytesRead
      }
      const { bytesRead } = await handle.read(buffer, 0, 1, total)
      if (bytesRead) throw new Error('The generated music file grew during verification')
      digest = hash.digest('hex')
    }
    assertCurrent?.()
    if (!same(before, await handle.stat({ bigint: true }))) throw new Error('The generated music file changed during verification')
    await verifyPath(root, src, before)
    return { contentSHA256: digest, contentBytes: Number(before.size), validate: () => verifyPath(root, src, before) }
  } finally { await handle.close() }
}
