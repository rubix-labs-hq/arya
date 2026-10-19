// The persistence helper, its prepared manifest and the journal it runs are read through
// readRegular. A file another user can rewrite must not be trusted.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readRegular } from '../core/project-writer-manifest.mjs'

test('persistence files writable by group or other users are refused', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-persistence-mode-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'project-writer.prepared.json')
  fs.writeFileSync(file, '{}')
  for (const mode of [0o600, 0o644, 0o755]) { fs.chmodSync(file, mode); assert.equal(readRegular(file, 64).toString(), '{}') }
  for (const mode of [0o620, 0o602, 0o666, 0o775]) { fs.chmodSync(file, mode); assert.throws(() => readRegular(file, 64), /writable by other users \(mode 6\d\d\)|writable by other users \(mode 7\d\d\)/) }
})
