import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

// The hosted editor ships only the files browser-public-files.json lists. A module it ships that
// imports an unlisted one stops the whole editor loading there, while the local server still works.
const editor = new URL('../', import.meta.url)

test('every module the hosted editor ships can load the modules it imports', () => {
  const rows = JSON.parse(fs.readFileSync(new URL('browser-public-files.json', editor), 'utf8'))
  const targets = new Set(rows.map(row => row.target)), missing = []
  for (const row of rows.filter(row => row.source.endsWith('.js'))) {
    const text = fs.readFileSync(new URL(row.source, editor), 'utf8')
    for (const [, specifier] of text.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)) {
      const target = specifier.startsWith('/core/') ? `core/${specifier.slice(6)}`
        : specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(row.target), specifier)) : null
      if (target && !targets.has(target)) missing.push(`${row.source} imports ${specifier}`)
    }
  }
  assert.deepEqual(missing, [])
})
