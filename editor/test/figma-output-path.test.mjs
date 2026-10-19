import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import figmaRoutes from '../routes/figma.mjs'
import { applyOps, newProject } from '../core/project.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64')
const dataURL = `data:image/png;base64,${png.toString('base64')}`
const xml = '<frame id="1:1" name="Asset fixture" x="0" y="0" width="320" height="180"><rectangle id="1:2" name="Image" x="0" y="0" width="100" height="100" /></frame>'

function fixture(t, extra = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-figma-output-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'project'), outside = path.join(temporary, 'outside')
  fs.mkdirSync(root); fs.mkdirSync(outside)
  let project = newProject('Confined Figma assets'), version = 0
  const ctx = { ROOT: root, CACHE: path.join(root, '.reel', 'cache'), getProject: () => project, probe: async () => ({ width: 1, height: 1, hasVideo: true }), editOps: async ops => { extra.assertCurrent?.(); const result = applyOps(project, ops); project = result.project; return { ...result, version: ++version } }, log: () => {}, ...extra }
  return { root, outside, routes: figmaRoutes(ctx).routes }
}

test('Figma asset imports reject linked project output directories', async t => {
  const f = fixture(t)
  fs.symlinkSync(f.outside, path.join(f.root, 'media'))
  const result = await f.routes['POST /api/figma/import-mcp']({ xml, assets: { '1:2': dataURL } })
  assert.ok(result.warnings.some(message => /symbolic links/.test(message)))
  assert.deepEqual(fs.readdirSync(f.outside), [])
})

test('Figma asset imports cannot reuse a linked destination file', async t => {
  const f = fixture(t), sentinel = path.join(f.outside, 'original.png')
  fs.writeFileSync(sentinel, 'original bytes')
  const directory = path.join(f.root, 'media', 'figma', 'mcp')
  fs.mkdirSync(directory, { recursive: true })
  const destination = path.join(directory, `1-2-${createHash('sha1').update(png).digest('hex').slice(0, 10)}.png`)
  fs.symlinkSync(sentinel, destination)
  const result = await f.routes['POST /api/figma/import-mcp']({ xml, assets: { '1:2': dataURL } })
  assert.ok(result.warnings.some(message => /symbolic links/.test(message)))
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'original bytes')
})

test('agent file checks run at the actual local Figma image read', async t => {
  const seen = []
  const f = fixture(t, { checkAgentFile(file) { seen.push(file); throw new Error('Outside the agent project') } })
  const image = path.join(f.outside, 'private.png')
  fs.writeFileSync(image, png)
  const result = await f.routes['POST /api/figma/import-mcp']({ xml, assets: { '1:2': image } })
  assert.deepEqual(seen, [image])
  assert.ok(result.warnings.some(message => /Outside the agent project/.test(message)))
  assert.equal(fs.existsSync(path.join(f.root, 'media')), false)
})

test('cancelled Figma agent work checks the run before publishing asset bytes', async t => {
  const f = fixture(t, { assertCurrent() { throw new Error('This run was cancelled') } })
  await assert.rejects(f.routes['POST /api/figma/import-mcp']({ xml, assets: { '1:2': dataURL } }), /cancelled/)
  assert.equal(fs.existsSync(path.join(f.root, 'media')), false)
  assert.deepEqual(fs.readdirSync(f.outside), [])
})
