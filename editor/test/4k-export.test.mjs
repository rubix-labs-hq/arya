import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { captureExportSources, prepareExportCohort } from '../core/export-cohort.mjs'

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const deliver = read('web/ui/deliver.js')
const presets = deliver.slice(deliver.indexOf('const PRESETS ='), deliver.indexOf('// The tip card'))
const dimensions = deliver.slice(deliver.indexOf('  const outW ='), deliver.indexOf('  const range ='))
function master(width, height) {
  return new Function('p', `${presets}; const choice = PRESETS.find(p => p.id === '4k'), width = null; ${dimensions}; return [outW, outH]`)({ width, height })
}
for (const [w, h, expected] of [[1920, 1080, [3840, 2160]], [1080, 1920, [2160, 3840]], [1080, 1080, [2160, 2160]], [1000, 3000, [1280, 3840]], [3000, 1000, [3840, 1280]]]) {
  test(`4K master fits ${w}x${h} in the oriented UHD bounds`, () => assert.deepEqual(master(w, h), expected))
}
test('Deliver offers a 2160-wide vertical output', () => {
  assert.match(deliver, /\[p\.width,[^\]]*\b2160\b/)
})
test('both new-project surfaces and both inspectors offer UHD and vertical 4K', () => {
  const app = read('web/ui/app.js'), workspace = read('web/browser-local/workspace.js'), inspector = read('web/ui/inspector.js')
  for (const source of [app, workspace]) {
    assert.match(source, /width: 3840, height: 2160/)
    assert.match(source, /width: 2160, height: 3840/)
  }
  assert.equal((inspector.match(/\['2160x3840',/g) ?? []).length, 2)
})
function encoder(preset, width, height, fps) {
  const server = read('server.mjs')
  const definitions = server.slice(server.indexOf('const PRESETS ='), server.indexOf('function newJob'))
  const fn = server.slice(server.indexOf('function startEncoder'), server.indexOf('async function finishExport'))
  let argv
  new Function('fs', 'checkExportOutput', 'spawn', `${definitions}\n${fn}\nstartEncoder(arguments[3])`)(
    { existsSync: () => false }, () => {}, (_cmd, args) => {
      argv = args
      const ff = new EventEmitter(); ff.stderr = new EventEmitter(); ff.stdin = new EventEmitter(); return ff
    }, { spec: { preset, width, height, fps, out: 'test.mp4' }, exportDestination: { assertCurrent() {}, output: 'test.mp4' } })
  return flag => argv[argv.indexOf(flag) + 1]
}
for (const [preset, base] of [['hevc', 16e6], ['h264-fast', 20e6]]) {
  for (const [w, h, fps, factor] of [[1920, 1080, 30, 1], [3840, 2160, 30, 4], [2160, 3840, 60, 8]]) {
    test(`${preset} bitrate scales at ${w}x${h} ${fps}fps`, () => {
      const value = encoder(preset, w, h, fps)('-b:v')
      const bits = value.endsWith('M') ? parseFloat(value) * 1e6 : Number(value)
      assert.equal(bits, base * factor)
    })
  }
}
for (const [fps, level] of [[30, '5.1'], [60, '5.2']]) test(`server 4K${fps} selects AVC level ${level}`, () => {
  assert.equal(encoder('h264-fast', 3840, 2160, fps)('-level:v'), level)
})
function webConfig(width, height, fps, vendor = 'Google Inc.') {
  const source = read('web/engine/export-webcodecs.js')
  const setup = source.slice(source.indexOf('    const codec ='), source.indexOf('    if (!audioOnly'))
  const Quality = class { constructor(value) { Object.assign(this, value) } }
  return new Function('width', 'height', 'fps', 'navigator', 'Quality', `const preset = 'h264-high'; ${setup}; return typeof encoderOptions === 'undefined' ? {} : encoderOptions`)(width, height, fps, { vendor, userAgent: '' }, Quality)
}
test('WebCodecs requests level 5.2 for 4K60 in capability probe and encoder', () => {
  assert.equal(webConfig(3840, 2160, 60).fullCodecString, 'avc1.640034')
  assert.equal(webConfig(2160, 3840, 60, 'Apple Computer, Inc.').fullCodecString, 'avc1.424034')
  assert.equal(webConfig(3840, 2160, 30).fullCodecString, undefined)
  const source = read('web/engine/export-webcodecs.js')
  assert.match(source, /canEncodeVideo\(codec, \{[^\n]*\.\.\.encoderOptions/)
  assert.match(source, /new CanvasSource\([^\n]*\.\.\.encoderOptions/)
})
const mediaFunction = read('web/engine/media.js').match(/export function mediaUrl\(project, src\) \{[\s\S]*?\n\}/)[0].replace('export ', '')
const mediaUrl = new Function('host', `${mediaFunction}; return mediaUrl`)({ url: value => value })
test('preview uses a proxy; WebCodecs export resolves original media', () => {
  const project = { assets: { 'original.mp4': { proxy: 'proxy.mp4' } } }
  assert.equal(new URL(mediaUrl(project, 'original.mp4'), 'http://test').searchParams.get('path'), 'proxy.mp4')
  project.__aryaExportSourceRevision = 'accepted-job'
  assert.equal(new URL(mediaUrl(project, 'original.mp4'), 'http://test').searchParams.get('path'), 'original.mp4')
})
test('server export cohort renders the original and leaves preview project intact', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-4k-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'original.mp4'), 'original pixels')
  fs.writeFileSync(path.join(root, 'proxy.mp4'), 'proxy pixels')
  const project = { assets: { 'original.mp4': { proxy: 'proxy.mp4' } }, tracks: [{ clips: [{ src: 'original.mp4' }] }] }
  const cohort = await prepareExportCohort(root, captureExportSources(root, project))
  try {
    const clip = cohort.project.tracks[0].clips[0]
    const rendered = new URL(mediaUrl(cohort.project, clip.src), 'http://test').searchParams.get('path')
    assert.equal(fs.readFileSync(path.join(root, rendered), 'utf8'), 'original pixels')
    assert.equal(project.assets['original.mp4'].proxy, 'proxy.mp4')
  } finally { cohort.cleanup() }
})
