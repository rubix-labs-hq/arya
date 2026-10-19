// Test-only filesystem fault model. Production modules must never import this file.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const sameFile = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino
const unchanged = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
const noFollow = fs.constants.O_NOFOLLOW ?? 0
const nonblock = fs.constants.O_NONBLOCK ?? 0

// Publish a complete sibling file before callers change their in-memory state.
export function writeProjectAtomic(root, text) {
  const requested = path.resolve(root)
  const rootStat = fs.lstatSync(requested)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('The project directory must be a real directory')
  const base = fs.realpathSync(requested)
  const rootFD = fs.openSync(base, fs.constants.O_RDONLY | noFollow | (fs.constants.O_DIRECTORY ?? 0))
  const file = path.join(base, 'reel.project.json')
  const temporary = path.join(base, `.reel-project-${randomUUID()}.tmp`)
  let oldFD, tempFD, oldStat, tempStat, published = false
  const assertRoot = () => {
    const current = fs.lstatSync(requested)
    if (current.isSymbolicLink() || fs.realpathSync(requested) !== base || !sameFile(current, rootStat) || !sameFile(fs.lstatSync(base), fs.fstatSync(rootFD))) throw new Error('The project directory changed during saving')
  }
  const assertTarget = () => {
    let current
    try { current = fs.lstatSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (oldStat ? !unchanged(current, oldStat) || !unchanged(fs.fstatSync(oldFD), oldStat) : current) throw new Error('The project file changed during saving')
  }
  try {
    assertRoot()
    try {
      oldFD = fs.openSync(file, fs.constants.O_RDONLY | noFollow | nonblock)
      oldStat = fs.fstatSync(oldFD)
      if (!oldStat.isFile() || oldStat.nlink !== 1 || !sameFile(fs.lstatSync(file), oldStat)) throw new Error('The project file must be a regular file with one link')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (oldStat) fs.accessSync(file, fs.constants.W_OK)
    tempFD = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600)
    tempStat = fs.fstatSync(tempFD)
    if (oldStat && (oldStat.uid !== tempStat.uid || oldStat.gid !== tempStat.gid)) fs.fchownSync(tempFD, oldStat.uid, oldStat.gid)
    fs.fchmodSync(tempFD, oldStat ? oldStat.mode & 0o777 : 0o666 & ~process.umask())
    fs.writeFileSync(tempFD, text, 'utf8')
    fs.fsyncSync(tempFD)
    fs.closeSync(tempFD); tempFD = undefined
    assertRoot(); assertTarget()
    if (!sameFile(fs.lstatSync(temporary), tempStat)) throw new Error('The temporary project file changed during saving')
    fs.renameSync(temporary, file)
    published = true
    // Replacement has succeeded. A directory flush failure cannot undo publication.
    try { fs.fsyncSync(rootFD); return { directorySynced: true } }
    catch (error) { return { directorySynced: false, warningCode: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'UNKNOWN' } }
  } finally {
    for (const fd of [tempFD, oldFD]) if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
    if (!published && tempStat) {
      try { assertRoot(); if (sameFile(fs.lstatSync(temporary), tempStat)) fs.unlinkSync(temporary) } catch {}
    }
    try { fs.closeSync(rootFD) } catch {}
  }
}
