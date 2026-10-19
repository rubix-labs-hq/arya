import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadPrepared, digest } from '../core/project-writer-manifest.mjs'
import { validatePrepared } from '../scripts/prepare-project-writer.mjs'

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const relativeVendor = ['preact/dist/preact.module.js', 'preact/hooks/dist/hooks.module.js', 'preact/LICENSE', 'htm/dist/htm.module.js', 'htm/LICENSE', 'mediabunny/dist/bundles/mediabunny.min.mjs', 'mediabunny/LICENSE']
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-writer-resource-copy-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo')
  function write(relative, text) { const file = path.join(repo, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
  write('THIRD_PARTY_NOTICES.md', fs.readFileSync(path.join(HERE, 'THIRD_PARTY_NOTICES.md')))
  write('LICENSE', fs.readFileSync(path.join(HERE, 'LICENSE')))
  write('editor/web/index.html', '<!doctype html>fixture')
  write('editor/core/project.js', 'export const fixture = true')
  write('editor/core/project-writer', 'generated standalone Mach-O placeholder; must never be copied')
  write('editor/core/project-writer.prepared.json', '{"private":"standalone 0600 generated manifest"}')
  fs.chmodSync(path.join(repo, 'editor/core/project-writer.prepared.json'), 0o600)
  write('editor/agent/bridge.mjs', 'fixture')
  for (const file of relativeVendor) write('editor/node_modules/' + file, 'fixture-vendor')
  for (const file of ['project-writer.c', 'project-writer-manifest.mjs', 'project-persistence.mjs']) write('editor/core/' + file, fs.readFileSync(path.join(HERE, 'editor/core', file)))
  write('editor/scripts/prepare-project-writer.mjs', fs.readFileSync(path.join(HERE, 'editor/scripts/prepare-project-writer.mjs')))
  write('native/scripts/bundle-editor.sh', fs.readFileSync(path.join(HERE, 'native/scripts/bundle-editor.sh')))
  write('native/scripts/bundle-music.mjs', fs.readFileSync(path.join(HERE, 'native/scripts/bundle-music.mjs')))
  write('editor/core/music-score.js', fs.readFileSync(path.join(HERE, 'editor/core/music-score.js')))
  // This fixture exercises resource copying and real helper preparation. Shared
  // JSCore bundling is already tested independently, and is stubbed here.
  write('native/scripts/bundle-core.mjs', "import fs from 'node:fs';fs.writeFileSync(process.argv[process.argv.indexOf('--out')+1], 'fixture JSCore bundle')")
  return { root, repo }
}
for (const platform of ['iphonesimulator', 'iphoneos', 'macosx']) test(`${platform} resource copy removes generated standalone helper and private pin`, t => {
  const { root, repo } = setup(t)
  const app = path.join(root, 'Arya.app')
  const destination = platform === 'macosx' ? path.join(app, 'Contents/Resources/editor') : path.join(app, 'editor')
  const core = path.join(destination, 'core')
  fs.mkdirSync(core, { recursive: true })
  for (const file of ['project-writer', 'project-writer.prepared.json', 'project-writer.signed.json', 'project-writer.c']) fs.writeFileSync(path.join(core, file), 'stale prior build product')
  if (platform === 'macosx') {
    fs.mkdirSync(path.join(app, 'Contents/Helpers'))
    fs.writeFileSync(path.join(app, 'Contents/Helpers/project-writer'), 'stale generated helper')
  }
  const result = spawnSync('/bin/sh', [path.join(repo, 'native/scripts/bundle-editor.sh'), destination], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 128 * 1024,
    env: { PATH: '/usr/bin:/bin', TMPDIR: os.tmpdir(), NODE: process.execPath, PLATFORM_NAME: platform }
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(fs.readFileSync(path.join(destination, 'THIRD_PARTY_NOTICES.md')), fs.readFileSync(path.join(HERE, 'THIRD_PARTY_NOTICES.md')))
  assert.deepEqual(fs.readFileSync(path.join(destination, 'LICENSE')), fs.readFileSync(path.join(HERE, 'LICENSE')))
  assert.equal(fs.existsSync(path.join(core, 'project-writer')), false)
  assert.equal(fs.existsSync(path.join(core, 'project-writer.c')), false)
  assert.equal(fs.existsSync(path.join(core, 'project-writer.signed.json')), false)
  assert.equal(fs.readFileSync(path.join(core, 'project.js'), 'utf8'), 'export const fixture = true')
  const music = vm.runInNewContext(fs.readFileSync(path.join(destination, 'arya-music.js'), 'utf8') + '\nAryaMusic')
  assert.equal(typeof music.startJSON, 'function')
  assert.equal(typeof music.exports.validateMusicScore, 'function')
  assert.equal(music.exports.MUSIC_RATE, 48000)
  if (platform !== 'macosx') {
    assert.equal(fs.existsSync(path.join(core, 'project-writer.prepared.json')), false)
    assert.equal(fs.existsSync(path.join(app, 'Contents/Helpers/project-writer')), false)
  } else {
    const prepared = loadPrepared(core)
    assert.equal(prepared.binary, path.join(app, 'Contents/Helpers/project-writer'))
    assert.equal(digest(fs.readFileSync(prepared.binary)), prepared.sha256)
    assert.equal(fs.statSync(prepared.binary).mode & 0o777, 0o755)
    assert.equal(fs.statSync(path.join(core, 'project-writer.prepared.json')).mode & 0o777, 0o644)
    assert.deepEqual(validatePrepared(core, { probe: false }).architectures, ['arm64', 'x86_64'])
  }
})
