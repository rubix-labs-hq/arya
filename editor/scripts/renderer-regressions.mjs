// Render focused scenes through the same worker used by the viewer and exports.
// Requires ffmpeg and Chrome, as the golden-frame suite does.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { figmaToOps } from '../core/figma.js'
import { newProject } from '../core/project.js'

const EDITOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = fs.mkdtempSync('/private/tmp/reel-renderer-regressions-')
const PORT = 5030 + Math.floor(Math.random() * 100)
const BASE = `http://127.0.0.1:${PORT}`
const WIDTH = 256
const HEIGHT = 128
const SELECT = process.argv.find(a => a.startsWith('--case='))?.slice(7)

async function post(route, body) {
  const res = await fetch(`${BASE}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw new Error(`${route}: ${data.error}`)

  return data
}

async function scene(ops) {
  await post('/api/new', { name: 'Renderer regression', width: WIDTH, height: HEIGHT, fps: 30 })
  await post('/api/ops', { ops, returnProject: false })
}

const ops = batch => post('/api/ops', { ops: batch, returnProject: false })
const color = color => ({ op: 'add_color', track: 'V1', color, start: 2, dur: 3 })
const corrector = node => ({ op: 'node_add', id: 'c1', node: { type: 'corrector', ...node } })
const updateNode = set => ({ op: 'node_update', id: 'c1', node: 'n4', set })

async function frame(at = 2, width = WIDTH, height = HEIGHT) {
  const { path: file } = await post('/api/frame', { at, width })
  const rgb = execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-frames:v', '1', 'pipe:1'])
  assert.equal(rgb.length, width * height * 3)

  return (x, y) => [...rgb.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)]
}

function near(actual, expected, message, tolerance = 3) {
  assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance), `${message}: expected ${expected}, got ${actual}`)
}

function gray(actual, message) {
  assert.ok(Math.max(...actual) - Math.min(...actual) <= 3, `${message}: expected gray, got ${actual}`)
}

const red = [192, 32, 32]
const qualifier = { hue: [340, 20], sat: [0.4, 1], lum: [0, 1], soft: 0.01 }
const window = { type: 'rect', x: 0.25, y: 0.5, w: 0.3, h: 0.8, softness: 0.001 }

function figmaGradient(type, handles, gradientTransform) {
  const document = {
    id: '1:1', type: 'FRAME', name: 'Gradient', absoluteBoundingBox: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    children: [{
      id: '1:2', type: 'RECTANGLE', name: 'Paint', absoluteBoundingBox: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      fills: [{ type, gradientHandlePositions: handles?.map(([x, y]) => ({ x, y })), gradientTransform, gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] }],
    }],
  }
  const mapped = figmaToOps(document, { project: newProject('Gradient', WIDTH, HEIGHT), duration: 3, fps: 30 })

  return [...mapped.ops, { op: 'comp_clip', target: mapped.comp, track: 'V1', start: 2, dur: 3 }]
}

const cases = {
  async coverFit() {
    await scene([
      { op: 'add_comp', width: 80, height: 20, duration: 1 },
      { op: 'add_shape', comp: 'k1', track: 'V1', dur: 1, shape: { type: 'rect', width: 80, height: 20, fill: { color: '#ff0000' } } },
      { op: 'comp_clip', target: 'k1', track: 'V1', dur: 1 },
    ])
    near((await frame(0))(128, 5), [0, 0, 0], 'contain fit keeps the wide composition inside the canvas')
    await ops([{ op: 'update', id: 'c2', set: { fit: 'cover' } }])
    near((await frame(0))(128, 5), [255, 0, 0], 'cover fit fills the canvas with nested composition pixels')
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=80x20', '-frames:v', '1', path.join(ROOT, 'wide.png')])
    await scene([{ op: 'import', assets: { 'wide.png': { width: 80, height: 20, hasVideo: false, duration: 1 } } }, { op: 'add_clip', src: 'wide.png', track: 'V1', dur: 1, kind: 'image', set: { fit: 'cover' } }])
    near((await frame(0))(128, 5), [255, 0, 0], 'cover fit fills the canvas with image pixels', 5)
  },
  async karaokeCaptions() {
    await scene([{ op: 'captions', burnIn: true, items: [{ t: 0, end: 1, text: 'ONE\nTWO', words: [{ text: 'ONE', t: 0, end: 0.5 }, { text: 'TWO', t: 0.5, end: 1 }] }], style: { preset: 'karaoke', size: 168, y: 0.5, plate: '#00000000', highlightColor: '#ff0000' } }])
    const first = await frame(0.25), second = await frame(0.75)
    const colored = image => {
      const rows = []
      for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
        const [r, g, b] = image(x, y)
        if (r > 180 && g < 100 && b < 100) { rows.push(y); break }
      }
      return rows
    }
    const a = colored(first), b = colored(second)
    assert.ok(a.length > 6 && a.every(y => y < HEIGHT / 2), `first-word red rows: ${a}`)
    assert.ok(b.length > 6 && b.every(y => y >= HEIGHT / 2), `second-word red rows: ${b}`)
    await ops([{ op: 'move', id: 'c1', start: 2 }])
    assert.deepEqual(colored(await frame(2.25)), a, 'moving a caption preserves its active word')
  },
  async portraitWrappedCaptions() {
    await post('/api/new', { name: 'Portrait caption', width: 180, height: 320, fps: 30 })
    await ops([{ op: 'captions', burnIn: true, items: [{ t: 0, end: 2, text: 'FIRST one two three four five six seven eight nine LAST', words: [{ text: 'FIRST', t: 0, end: 0.5 }, { text: 'LAST', t: 1, end: 1.5 }] }], style: { preset: 'karaoke', size: 84, y: 0.95, plate: '#00000000', highlightColor: '#ff0000' } }])
    const colored = image => {
      const rows = []
      for (let y = 0; y < 320; y++) for (let x = 0; x < 180; x++) {
        const [r, g, b] = image(x, y)
        if (r > 180 && g < 100 && b < 100) { rows.push(y); break }
      }
      return rows
    }
    const a = colored(await frame(0.25, 180, 320)), b = colored(await frame(1.25, 180, 320))
    assert.ok(a.length > 8, `first-word red rows: ${a}`)
    assert.ok(b.length > 8, `last-word red rows: ${b}`)
    assert.ok(Math.max(...a) < Math.min(...b), 'first and last words retain their positions through measured wrapping')
    assert.ok(b.every(y => y < 312), 'caption stays inside the portrait canvas')
  },
  async cubeDomain() {
    const rows = Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`).join('\n')
    fs.writeFileSync(path.join(ROOT, 'domain.cube'), `LUT_3D_SIZE 2\nDOMAIN_MIN 0.25 0.25 0.25\nDOMAIN_MAX 0.75 0.75 0.75\n${rows}\n`)
    await scene([color('#606060'), { op: 'update', id: 'c1', set: { grade: { lut: 'domain.cube' } } }])
    near((await frame())(128, 64), [64, 64, 64], 'LUT domain maps the source input into the table')
    fs.writeFileSync(path.join(ROOT, 'precision.cube'), `LUT_3D_SIZE 2\n${Array(8).fill('0.12345 0.12345 0.12345').join('\n')}\n`)
    await ops([{ op: 'update', id: 'c1', set: { grade: { lut: 'precision.cube' } } }])
    near((await frame())(128, 64), [31, 31, 31], 'half precision LUT table is sampled without 8-bit input quantization', 1)
  },
  async bypass() {
    await scene([color('#c02020'), corrector({ grade: { saturation: 0 } })])
    gray((await frame())(128, 64), 'enabled corrector applies its grade')
    await ops([updateNode({ enabled: false })])
    near((await frame())(128, 64), red, 'disabled corrector passes its input through')
    await ops([{ op: 'update', id: 'c1', set: { grade: { saturation: 0 } } }, { op: 'node_update', id: 'c1', node: 'n2', set: { enabled: false } }])
    near((await frame())(128, 64), red, 'disabled primary passes its input through')
    await ops([{ op: 'node_add', id: 'c1', node: { type: 'key', color: '#c02020', similarity: 1, smoothness: 0.1, enabled: false } }])
    near((await frame())(128, 64), red, 'disabled key passes its input through')
    for (const type of ['parallel', 'layerMixer']) {
      await scene([color('#c02020'), { op: 'update', id: 'c1', set: { nodes: {
        list: [{ id: 'n1', type: 'source' }, { id: 'n4', type: 'corrector', grade: { saturation: 0 } }, { id: 'n5', type }, { id: 'n3', type: 'output' }],
        links: [{ from: 'n1', to: 'n4', input: 0 }, { from: 'n1', to: 'n5', input: 0 }, { from: 'n4', to: 'n5', input: 1 }, { from: 'n5', to: 'n3', input: 0 }],
      } } }])
      const active = (await frame())(128, 64)
      assert.ok(Math.abs(active[0] - red[0]) > 20, `enabled ${type} combines its inputs`)
      await ops([{ op: 'node_update', id: 'c1', node: 'n5', set: { enabled: false } }])
      near((await frame())(128, 64), red, `disabled ${type} passes its first input through`)
    }
  },
  async highlight() {
    await scene([color('#c02020'), corrector({ grade: { saturation: 0 }, qualifier })])
    gray((await frame())(128, 64), 'normal qualifier applies its grade')
    await ops([updateNode({ qualifier: { show: true } })])
    near((await frame())(128, 64), [255, 255, 255], 'Highlight displays the selected matte')
    await ops([updateNode({ qualifier: { invert: true } })])
    near((await frame())(128, 64), [0, 0, 0], 'Highlight respects qualifier inversion')
    await ops([updateNode({ qualifier: { invert: false }, window })])
    const rendered = await frame()
    near(rendered(64, 64), [255, 255, 255], 'Highlight includes the power window')
    near(rendered(192, 64), [0, 0, 0], 'Highlight excludes pixels outside the power window')
    await ops([updateNode({ qualifier: { show: null } })])
    near((await frame())(192, 64), red, 'leaving Highlight restores the input outside the window')
  },
  async tracking() {
    await scene([
      color('#c02020'), corrector({ grade: { saturation: 0 }, window }),
      { op: 'keyframe', id: 'c1', prop: 'node.n4.window.x', at: 0, value: 0.25, local: true },
      { op: 'keyframe', id: 'c1', prop: 'node.n4.window.x', at: 1, value: 0.75, local: true },
    ])
    const start = await frame(2)
    gray(start(64, 64), 'window begins at the first local key')
    near(start(192, 64), red, 'window leaves the opposite side unchanged')
    const end = await frame(3)
    near(end(64, 64), red, 'tracked window leaves its old position')
    gray(end(192, 64), 'tracked window reaches its final position')
    const middle = await frame(2.5)
    gray(middle(128, 64), 'tracked window interpolates at clip-local time')
    near(middle(64, 64), red, 'interpolated window leaves the first position')
  },
  async windowGeometry() {
    await scene([
      color('#c02020'), corrector({ grade: { saturation: 0 }, window: { ...window, x: 0.5, y: 0.25, w: 0.2, h: 0.2 } }),
      ...Object.entries({ y: [0.25, 0.75], w: [0.2, 0.6], h: [0.2, 0.4] }).flatMap(([prop, values]) => values.map((value, at) => ({ op: 'keyframe', id: 'c1', prop: `node.n4.window.${prop}`, at, value, local: true }))),
    ])
    const start = await frame(2)
    gray(start(128, 32), 'window begins at its first y key')
    near(start(192, 96), red, 'initial window excludes its later extent')
    const end = await frame(3)
    near(end(128, 32), red, 'tracked window leaves its first y position')
    gray(end(192, 96), 'tracked window uses its final width')
    gray(end(128, 112), 'tracked window uses its final height')
    await scene([
      color('#c02020'), corrector({ grade: { saturation: 0 }, window: { ...window, x: 0.5, w: 0.6, h: 0.2 } }),
      { op: 'keyframe', id: 'c1', prop: 'node.n4.window.rotation', at: 0, value: 0, local: true },
      { op: 'keyframe', id: 'c1', prop: 'node.n4.window.rotation', at: 1, value: 90, local: true },
    ])
    gray((await frame(2))(192, 64), 'unrotated window includes its horizontal extent')
    const rotated = await frame(3)
    near(rotated(192, 64), red, 'tracked rotation moves the horizontal extent')
    gray(rotated(128, 24), 'tracked rotation includes its vertical extent')
  },
  async expressions() {
    await scene([
      color('#c02020'), corrector({ grade: { saturation: 0 }, window }),
      { op: 'expression', id: 'c1', prop: 'node.n4.window.x', expr: 'value + time * 0.5' },
    ])
    gray((await frame(2))(64, 64), 'window expression reads its stored base value')
    const moved = await frame(3)
    near(moved(64, 64), red, 'window expression moves at clip-local time')
    gray(moved(192, 64), 'window expression uses its stored value and local time')
    await scene([
      color('#c02020'), { op: 'add_mask', id: 'c1', mask: { type: 'rect', x: -64, y: -24, w: 32, h: 24 } },
      { op: 'expression', id: 'c1', prop: 'mask.mk1.x', expr: 'value + 128' },
      { op: 'expression', id: 'c1', prop: 'mask.mk1.y', expr: 'value + 48' },
    ])
    near((await frame())(192, 88), red, 'mask expressions read their stored base position')
  },
  async maskTracking() {
    await scene([
      color('#c02020'), { op: 'add_mask', id: 'c1', mask: { type: 'rect', x: -64, y: -24, w: 32, h: 24 } },
      ...Object.entries({ x: [-64, 64], y: [-24, 24], w: [32, 96], h: [24, 64] }).flatMap(([prop, values]) => values.map((value, at) => ({ op: 'keyframe', id: 'c1', prop: `mask.mk1.${prop}`, at, value, local: true }))),
    ])
    const start = await frame(2)
    near(start(64, 40), red, 'mask begins at its first local position')
    near(start(192, 88), [0, 0, 0], 'mask excludes its later position')
    const end = await frame(3)
    near(end(64, 40), [0, 0, 0], 'tracked mask leaves its old position')
    near(end(192, 88), red, 'tracked mask reaches its final x and y')
    near(end(224, 88), red, 'tracked mask uses its final width')
    near(end(192, 108), red, 'tracked mask uses its final height')
    near((await frame(2.5))(128, 64), red, 'tracked mask interpolates at clip-local time')
    await scene([
      color('#c02020'), { op: 'add_mask', id: 'c1', mask: { type: 'path', x: -64, y: -24, path: { vertices: [[-16, -12], [16, -12], [16, 12], [-16, 12]] } } },
      ...Object.entries({ x: [-64, 64], y: [-24, 24] }).flatMap(([prop, values]) => values.map((value, at) => ({ op: 'keyframe', id: 'c1', prop: `mask.mk1.${prop}`, at, value, local: true }))),
    ])
    near((await frame(2))(64, 40), red, 'path mask uses its stored position')
    near((await frame(3))(192, 88), red, 'tracked path mask uses its final position')
  },
  async linearGradient() {
    await scene(figmaGradient('GRADIENT_LINEAR', [[0.25, 0.5], [0.75, 0.5], [0.25, 1]]))
    const rendered = await frame()
    near(rendered(32, 64), [255, 0, 0], 'Figma linear gradient starts at its first handle')
    near(rendered(224, 64), [0, 0, 255], 'Figma linear gradient ends at its second handle')
    near(rendered(128, 64), [126, 0, 129], 'Figma linear gradient midpoint', 4)
  },
  async pluginGradient() {
    await scene(figmaGradient('GRADIENT_LINEAR', null, [[0, 1, 0], [-1, 0, 1]]))
    const rendered = await frame()
    near(rendered(128, 16), [222, 0, 33], 'Plugin API gradientTransform preserves the vertical start', 4)
    near(rendered(128, 112), [31, 0, 224], 'Plugin API gradientTransform preserves the vertical end', 4)
  },
  async radialGradient() {
    await scene(figmaGradient('GRADIENT_RADIAL', [[0.25, 0.5], [0.5, 0.5], [0.25, 0.75]]))
    const rendered = await frame()
    near(rendered(64, 64), [252, 0, 3], 'Figma radial gradient uses its imported center', 4)
    near(rendered(128, 64), [0, 0, 255], 'Figma radial gradient uses its horizontal radius', 4)
    near(rendered(64, 80), [124, 0, 131], 'Figma radial gradient uses its vertical radius', 4)
  },
  async radialRotation() {
    await scene(figmaGradient('GRADIENT_RADIAL', [[0.25, 0.5], [0.25, 0.875], [0.15625, 0.5]]))
    const rendered = await frame()
    near(rendered(64, 88), [125, 0, 130], 'Figma radial gradient rotates its major axis', 4)
    near(rendered(76, 64), [122, 0, 133], 'Figma radial gradient rotates its minor axis', 4)
  },
}

if (SELECT && !Object.hasOwn(cases, SELECT)) throw new Error(`unknown renderer regression case: ${SELECT}`)

const server = spawn(process.execPath, [path.join(EDITOR, 'server.mjs'), '--root', ROOT, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
server.stdout.on('data', chunk => { log += chunk })
server.stderr.on('data', chunk => { log += chunk })
let failed = 0
try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}\n${log}`)
    try {
      const res = await fetch(`${BASE}/api/state`)
      if (res.ok) { ready = true; break }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(ready, `server did not start\n${log}`)
  for (const [name, run] of Object.entries(cases)) {
    if (SELECT && name !== SELECT) continue
    try {
      await run()
      console.log(`ok ${name}`)
    } catch (error) {
      failed++
      console.error(`FAIL ${name}: ${error.message}`)
    }
  }
  console.log(`${Object.keys(cases).filter(name => !SELECT || name === SELECT).length - failed} passed, ${failed} failed`)
  if (failed) process.exitCode = 1
} finally {
  await fetch(`${BASE}/api/shutdown`, { method: 'POST' }).catch(() => {})
  server.kill()
  await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve))
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
