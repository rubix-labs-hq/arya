import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import analysisRoutes from '../routes/analysis.mjs'
import audioRoutes from '../routes/audio.mjs'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-processing-output-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'project'), outside = path.join(directory, 'outside')
  fs.mkdirSync(root); fs.mkdirSync(outside); fs.mkdirSync(path.join(root, 'media'))
  const source = path.join(root, 'media', 'source.mp4')
  fs.writeFileSync(source, 'unchanged source')
  const project = { fps: 30, tracks: [], assets: { 'media/source.mp4': { hasVideo: true, hasAudio: true, duration: 1, width: 16, height: 16, fps: 30 } } }
  const calls = [], ctx = { ROOT: root, resolveMedia: () => source, getProject: () => project, getVersion: () => 0, getProjectGeneration: () => 0, cacheKey: async () => '0123456789', run: async (...args) => { calls.push(args); return { stdout: 'RMS_level=-60' } }, once: async (_key, work) => work(), pushActivity: () => {}, broadcast: (...args) => calls.push(args), probe: async src => {
    if (src === 'media/source.mp4') return project.assets[src]
    throw new Error('No output should be probed')
  } }
  return { root, outside, ctx, calls, source }
}

test('retime and stabilization reject linked output directories before starting an encoder', async t => {
  for (const [route, folder] of [['/api/retime', 'retimed'], ['/api/stabilize/render', 'stabilized']]) {
    const f = fixture(t)
    fs.symlinkSync(f.outside, path.join(f.root, 'media', folder))
    const routes = analysisRoutes(f.ctx).routes
    await assert.rejects(routes[`POST ${route}`]({ src: 'media/source.mp4', speed: 0.5, wait: true }), /symbolic links/)
    assert.deepEqual(f.calls, [])
    assert.deepEqual(fs.readdirSync(f.outside), [])
    assert.equal(fs.readFileSync(f.source, 'utf8'), 'unchanged source')
  }
})

test('audio cleaning rejects linked output directories and cached destination files', async t => {
  const f = fixture(t)
  fs.symlinkSync(f.outside, path.join(f.root, 'media', 'cleaned'))
  await assert.rejects(audioRoutes(f.ctx).routes['POST /api/audio/clean']({ src: 'media/source.mp4' }), /symbolic links/)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(fs.readdirSync(f.outside), [])
  fs.unlinkSync(path.join(f.root, 'media', 'cleaned'))
  fs.mkdirSync(path.join(f.root, 'media', 'cleaned'))
  const original = path.join(f.outside, 'original.wav')
  fs.writeFileSync(original, 'original audio')
  fs.symlinkSync(original, path.join(f.root, 'media', 'cleaned', 'source-denoise-01234567.wav'))
  await assert.rejects(audioRoutes(f.ctx).routes['POST /api/audio/clean']({ src: 'media/source.mp4' }), /symbolic links/)
  assert.equal(fs.readFileSync(original, 'utf8'), 'original audio')
  assert.deepEqual(f.calls, [])
})

test('cancelled audio work refuses durable publication and removes its temporary file', async t => {
  const f = fixture(t)
  let cancelled = false
  f.ctx.assertCurrent = () => { if (cancelled) throw new Error('The owned run was cancelled') }
  f.ctx.run = async (_command, args) => {
    if (args.includes('pcm_s24le')) { fs.writeFileSync(args.at(-1), 'temporary audio'); cancelled = true; return {} }
    return { stdout: 'RMS_level=-60' }
  }
  await assert.rejects(audioRoutes(f.ctx).routes['POST /api/audio/clean']({ src: 'media/source.mp4' }), /cancelled/)
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'media', 'cleaned')), [])
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'unchanged source')
})
