// Compare a synthetic imported text box with its expected line breaks through Chrome.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { figmaToOps } from '../core/figma.js'
import { newProject } from '../core/project.js'

const EDITOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = fs.mkdtempSync('/private/tmp/reel-figma-text-smoke-')
const W = 1080
const H = 1350
const node = {
  id: '1:1', name: 'Synthetic text', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: W, height: H },
  children: [{
    id: '1:2', name: 'Heading', type: 'TEXT', characters: 'Plan 43 makes it harder to build',
    absoluteBoundingBox: { x: 72, y: 758, width: 936, height: 150 },
    style: { fontFamily: 'Inter', fontWeight: 800, fontSize: 80, lineHeightPx: 75.2, letterSpacing: -0.5, textCase: 'UPPER', textAlignHorizontal: 'LEFT' },
    fills: [{ type: 'SOLID', color: { r: 206 / 255, g: 234 / 255, b: 1 / 255 } }],
  }],
}
const reservation = net.createServer()
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const BASE = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, [path.join(EDITOR, 'server.mjs'), '--root', ROOT, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
server.stdout.on('data', chunk => { log += chunk })
server.stderr.on('data', chunk => { log += chunk })

async function post(route, body) {
  const res = await fetch(`${BASE}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw new Error(`${route}: ${data.error}`)

  return data
}

async function render(ops, name) {
  await post('/api/new', { name, width: W, height: H, fps: 30 })
  await post('/api/ops', { ops, returnProject: false })
  const result = await post('/api/frame', { comp: 'k1', at: 0, width: W })
  const rgb = execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', result.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 16e6 })
  assert.equal(rgb.length, W * H * 3)

  return rgb
}

try {
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(log)
    try { if ((await fetch(`${BASE}/api/state`)).ok) { ready = true; break } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(ready, log)
  const mapped = figmaToOps(node, { project: newProject('Text'), duration: 2 })
  const actual = await render(mapped.ops, 'Imported')
  let minX = W
  let maxX = 0
  for (let y = 750; y < 920; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3
    if (actual[i] > 150 && actual[i + 1] > 180 && actual[i + 2] < 40) { minX = Math.min(minX, x); maxX = Math.max(maxX, x) }
  }
  assert.ok(minX >= 72 && minX <= 82, `imported text starts at its declared left edge: ${minX}`)
  assert.ok(maxX <= 1008, `imported text stays inside its declared right edge: ${maxX}`)
  const expected = await render([
    { op: 'add_comp', name: 'Expected', width: W, height: H, duration: 2 },
    { op: 'add_title', comp: 'k1', track: 'V1', start: 0, dur: 2, text: 'PLAN 43 MAKES IT\nHARDER TO BUILD', title: { font: 'Inter', weight: 800, size: 64, color: '#ceea01', align: 'left', lineHeight: 0.94, tracking: -0.4, anim: 'none', shadow: null, box: { width: 748.8, height: 120, wrap: true, alignY: 'top' } }, set: { x: 540, y: 833 } },
  ], 'Expected')
  assert.deepEqual(actual, expected, 'imported wrapping matches expected line breaks at the actual font metrics')
  console.log(`ok Figma text bounds ${minX}..${maxX}, expected measured line breaks, exact rendered pixels`)
  const autoNode = JSON.parse(JSON.stringify(node))
  Object.assign(autoNode.children[0], { characters: 'Vote on 43', textAutoResize: 'WIDTH_AND_HEIGHT' })
  autoNode.children[0].absoluteBoundingBox = { x: 72, y: 1230, width: 202, height: 38 }
  Object.assign(autoNode.children[0].style, { fontSize: 38, lineHeightPx: 45.6, letterSpacing: 2.66 })
  const autoMapped = figmaToOps(autoNode, { project: newProject('Auto width'), duration: 2 })
  const autoActual = await render(autoMapped.ops, 'Auto width')
  let autoRight = 0
  for (let y = 1220; y < 1300; y++) for (let x = 72; x < W; x++) {
    const i = (y * W + x) * 3
    if (autoActual[i] > 150 && autoActual[i + 1] > 180 && autoActual[i + 2] < 40) autoRight = Math.max(autoRight, x)
  }
  assert.ok(autoRight > 274, `uppercase glyphs extend beyond the original box: ${autoRight}`)
  const wideOps = JSON.parse(JSON.stringify(autoMapped.ops))
  const wideTitle = wideOps.find(op => op.op === 'add_title')
  wideTitle.title.box.width = 320
  wideTitle.set.x = 272
  const autoExpected = await render(wideOps, 'Auto width expected')
  assert.ok(autoActual.equals(autoExpected), 'auto-width uppercase text stays on one line and may extend beyond its declared box')
  console.log('ok Figma auto-width uppercase text, exact pixels against an unclipped single-line reference')
} finally {
  await post('/api/shutdown', {}).catch(() => {})
  await new Promise(resolve => {
    if (server.exitCode !== null) return resolve()
    const timeout = setTimeout(() => server.kill(), 2000)
    server.once('exit', () => { clearTimeout(timeout); resolve() })
  })
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
