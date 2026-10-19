import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// Compile current source into disposable fixtures. Never install a test-hook helper.
export function compileFixtureWriters(test) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-writer-regression-')))
  test.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const source = fileURLToPath(new URL('../../core/project-writer.c', import.meta.url))
  const productionBinary = path.join(temporary, 'production-writer')
  const testBinary = path.join(temporary, 'fault-writer')
  const flags = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', '-mmacosx-version-min=14.0']
  for (const [binary, testing] of [[productionBinary, false], [testBinary, true]]) {
    execFileSync('/usr/bin/clang', [...flags, ...(testing ? ['-DARYA_PERSISTENCE_TESTING'] : []), source, '-o', binary], { timeout: 30000 })
  }
  return { productionBinary, testBinary }
}
