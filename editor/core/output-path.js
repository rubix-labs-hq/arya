import fs from 'node:fs'
import path from 'node:path'

// Check missing descendants too, so a linked cache directory cannot redirect output.
export function guardedOutput(root, file) {
  const base = path.resolve(root), target = path.resolve(file)
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('Output is outside the project')
  for (let current = target; ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Output paths cannot use symbolic links') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (current === base) break
  }
  return target
}
