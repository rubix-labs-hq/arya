import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { guardedOutput } from './output-path.js'

const DEFAULT_LIMIT = 64 * 1024 ** 3
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino

/** Streams into owned staging, then publishes a complete file without replacing one. */
export async function storeMediaUpload(root, request, query, { maxBytes = DEFAULT_LIMIT } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid upload size limit')
  const rawName = query.get('name') ?? 'upload.bin', relative = query.get('dir') ?? 'media'
  if (rawName.length > 4096 || rawName.includes('\0') || relative.length > 1024 || relative.includes('\0') || relative.includes('\\') || !/^media(?:\/[^/.][^/]*)*$/.test(relative) || relative.split('/').some(part => part === '..')) throw new Error('Uploads must use the project media folder')
  let name = path.basename(rawName).replace(/[^\w.\- ]+/g, '_').trim()
  if (!name || name === '.' || name === '..') name = 'upload.bin'
  const parsed = path.parse(name)
  name = parsed.name.slice(0, 160) + parsed.ext.slice(0, 40)
  const declared = request.headers?.['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) throw new Error('The upload exceeds the project media size limit')
  const base = path.resolve(root), rootInfo = fs.lstatSync(base)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('The project folder is unavailable')
  const directory = guardedOutput(base, path.join(base, relative))
  fs.mkdirSync(directory, { recursive: true })
  const directoryInfo = fs.lstatSync(guardedOutput(base, directory))
  if (!directoryInfo.isDirectory()) throw new Error('The media folder is unavailable')
  const currentDirectory = () => {
    if (!sameFile(rootInfo, fs.lstatSync(base)) || !sameFile(directoryInfo, fs.lstatSync(guardedOutput(base, directory)))) throw new Error('The project media folder changed during upload')
  }
  const temporary = guardedOutput(base, path.join(directory, `.upload-${randomUUID()}.part`))
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  const owned = fs.fstatSync(descriptor)
  let bytes = 0, published = null, confirmed = false
  const removeOwned = file => {
    try { if (sameFile(owned, fs.lstatSync(guardedOutput(base, file)))) fs.unlinkSync(file) } catch {}
  }
  try {
    const limiter = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length
      callback(bytes > maxBytes ? new Error('The upload exceeds the project media size limit') : null, chunk)
    } })
    await pipeline(request, limiter, fs.createWriteStream(temporary, { fd: descriptor, autoClose: false }))
    if (!bytes) throw new Error('The uploaded file is empty')
    if (declared !== undefined && bytes !== Number(declared)) throw new Error('The upload ended before all bytes arrived')
    fs.fsyncSync(descriptor)
    currentDirectory()
    const before = fs.lstatSync(guardedOutput(base, temporary))
    if (!before.isFile() || !sameFile(owned, before) || before.nlink !== 1 || before.size !== bytes) throw new Error('The upload staging file changed')
    const parts = path.parse(name)
    for (let i = 0; i < 1000; i++) {
      const candidate = guardedOutput(base, path.join(directory, i ? `${parts.name}-${i}${parts.ext}` : name))
      currentDirectory()
      try { fs.linkSync(temporary, candidate); published = candidate; break }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    if (!published) throw new Error('There are too many uploads with this name')
    currentDirectory()
    if (!sameFile(owned, fs.lstatSync(guardedOutput(base, published)))) throw new Error('The uploaded file changed before publication')
    confirmed = true
    return { path: path.relative(base, published) }
  } finally {
    try { fs.closeSync(descriptor) } catch {}
    removeOwned(temporary)
    if (!confirmed && published) removeOwned(published)
  }
}
