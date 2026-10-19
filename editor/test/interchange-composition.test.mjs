import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import interchangeRoutes from '../routes/interchange.mjs'
import { parseSRT, parseVTT } from '../core/interchange.js'
import { newProject } from '../core/project.js'

test('caption export resolves composition-local tracks and timestamps without changing the main edit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reel captions export '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = newProject('Main edit')
  project.comps = {}
  project.tracks.push({ id: 'C1', kind: 'caption', clips: [{ id: 'c1', start: 12, dur: 2, text: 'Main timeline cue' }] })
  project.comps.k1 = { id: 'k1', name: 'Portrait short', width: 1080, height: 1920, fps: 30, tracks: [{ id: 'C1', kind: 'caption', clips: [{ id: 'c2', start: 0.2, dur: 1.5, text: 'Short\ncomposition cue' }] }] }
  const before = structuredClone(project)
  const { routes } = interchangeRoutes({ ROOT: root, getProject: () => project, pushActivity: () => {} })
  const exportFile = routes['POST /api/interchange/export']
  for (const format of ['srt', 'vtt']) {
    const result = await exportFile({ format, comp: 'k1', track: 'C1' })
    assert.equal(result.path, `renders/Portrait-short.${format}`)
    const text = fs.readFileSync(path.join(root, result.path), 'utf8')
    const cues = (format === 'srt' ? parseSRT : parseVTT)(text)
    assert.deepEqual(cues, [{ t: 0.2, end: 1.7, text: 'Short\ncomposition cue' }])
    assert.equal(text.includes('Main timeline cue'), false)
  }
  const main = await exportFile({ format: 'srt' })
  assert.match(fs.readFileSync(path.join(root, main.path), 'utf8'), /00:00:12,000 --> 00:00:14,000/)
  await assert.rejects(exportFile({ format: 'srt', comp: 'missing' }), /no composition/)
  assert.deepEqual(project, before)
})
