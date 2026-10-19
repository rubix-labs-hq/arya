// Golden frames: renders fixed scenes through the real renderer (headless Chrome via a
// throwaway server) and compares them with committed references by PSNR.
//
//   node editor/scripts/golden.mjs            compare (exit 1 on a mismatch)
//   node editor/scripts/golden.mjs --update   rewrite the references
//
// Media is generated with deterministic ffmpeg sources, so every machine renders the same input.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EDITOR = path.resolve(HERE, '..')
const REFS = path.join(EDITOR, 'test', 'golden')
const UPDATE = process.argv.includes('--update')
const MIN_PSNR = 38
const PORT = 4960 + Math.floor(Math.random() * 30)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-golden-'))
const A = `http://127.0.0.1:${PORT}`

const ff = args => execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args])

function makeMedia() {
  fs.mkdirSync(path.join(ROOT, 'media'), { recursive: true })
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=440:d=8', '-shortest', '-c:v', 'libx264', '-g', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(ROOT, 'media', 'test.mp4')])
  ff(['-f', 'lavfi', '-i', 'smptehdbars=s=1280x720:r=30:d=8', '-c:v', 'libx264', '-g', '15', '-pix_fmt', 'yuv420p', path.join(ROOT, 'media', 'bars.mp4')])
  ff(['-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=30', '-t', '8', '-c:v', 'libx264', '-g', '15', '-pix_fmt', 'yuv420p', path.join(ROOT, 'media', 'fractal.mp4')])
}

// Each scene: ops on a fresh 1280x720 project, then the times to render.
const SCENES = [
  {
    name: 'basics',
    ops: [
      { op: 'append', src: 'media/test.mp4', track: 'V1', dur: 4, audio: false },
      { op: 'append', src: 'media/bars.mp4', track: 'V1', dur: 4 },
      { op: 'transition', id: 'c2', type: 'crossDissolve', dur: 1 },
      { op: 'add_title', track: 'V3', start: 0, dur: 8, text: 'Golden', title: { font: 'Helvetica Neue', weight: 700, size: 120, anim: 'none', shadow: null } },
      { op: 'update', id: 'c1', set: { grade: { saturation: 0.3, contrast: 1.2 } } },
    ],
    times: [1, 4, 6],
  },
  {
    name: 'motion',
    ops: [
      { op: 'append', src: 'media/bars.mp4', track: 'V1', dur: 8 },
      { op: 'add_shape', track: 'V2', start: 0, dur: 8, shape: { type: 'star', points: 5, radius: 150, innerRadius: 60, fill: { gradient: { type: 'linear', angle: 45, stops: [[0, '#ffcc00'], [1, '#ff3366']] } }, stroke: { color: '#ffffff', width: 8 } }, set: { x: 400, y: 300 } },
      { op: 'add_null', track: 'V3', start: 0, dur: 8, name: 'Rig' },
      { op: 'keyframe', id: 'c3', prop: 'x', at: 0, value: 640, local: true, ease: 'inOut' },
      { op: 'keyframe', id: 'c3', prop: 'x', at: 4, value: 900, local: true },
      { op: 'parent', id: 'c2', parent: 'c3' },
      { op: 'keyframe', id: 'c2', prop: 'rotation', at: 0, value: 0, local: true },
      { op: 'keyframe', id: 'c2', prop: 'rotation', at: 8, value: 180, local: true },
      { op: 'add_mask', id: 'c1', mask: { type: 'ellipse', w: 1000, h: 600, feather: 60 } },
    ],
    times: [0.5, 3],
  },
  {
    name: 'comps-nodes-matte',
    ops: [
      { op: 'append', src: 'media/test.mp4', track: 'V1', dur: 8, audio: false },
      { op: 'add_comp', name: 'Badge', width: 1280, height: 720, duration: 8 },
      { op: 'add_shape', comp: 'k1', track: 'V1', start: 0, dur: 8, shape: { type: 'rect', width: 500, height: 140, radius: 24, fill: { color: '#2255ff' } }, set: { x: 400, y: 600 } },
      { op: 'comp_clip', target: 'k1', track: 'V2', start: 0, dur: 8 },
      { op: 'node_add', id: 'c1', node: { type: 'corrector', grade: { saturation: 0 }, window: { type: 'circle', x: 0.5, y: 0.5, w: 0.5, h: 0.5, softness: 0.2, invert: true } } },
      { op: 'add_track', kind: 'video' },
      { op: 'append', src: 'media/fractal.mp4', track: 'V3', dur: 8 },
      { op: 'add_title', track: 'V4', start: 0, dur: 8, text: 'MATTE', title: { font: 'Helvetica Neue', weight: 900, size: 260, anim: 'none', shadow: null } },
      { op: 'matte', id: 'c4', matte: { mode: 'alpha' } },
    ],
    times: [2],
  },
]

async function post(p, body) {
  const res = await fetch(`${A}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw new Error(`${p}: ${data.error}`)

  return data
}

function psnrOf(a, b) {
  const r = spawnSyncText('ffmpeg', ['-nostdin', '-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'])
  const m = /average:(inf|[\d.]+)/.exec(r)

  return m ? (m[1] === 'inf' ? Infinity : Number(m[1])) : 0
}

function spawnSyncText(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })

  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

async function main() {
  makeMedia()
  const server = spawn('node', [path.join(EDITOR, 'server.mjs'), '--root', ROOT, '--port', String(PORT)], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`${A}/api/state`)
        break
      } catch {
        await new Promise(r => setTimeout(r, 100))
      }
    }
    fs.mkdirSync(REFS, { recursive: true })
    let failed = 0
    for (const scene of SCENES) {
      await post('/api/new', { name: scene.name, width: 1280, height: 720, fps: 30 })
      await post('/api/ops', { ops: scene.ops, returnProject: false })
      for (const t of scene.times) {
        const { path: frame } = await post('/api/frame', { at: t, width: 640 })
        const ref = path.join(REFS, `${scene.name}-${t}.png`)
        if (UPDATE || !fs.existsSync(ref)) {
          fs.copyFileSync(frame, ref)
          console.log(`wrote ${path.relative(EDITOR, ref)}`)
          continue
        }
        const score = psnrOf(frame, ref)
        const ok = score >= MIN_PSNR
        if (!ok) {
          failed++
          fs.copyFileSync(frame, ref.replace(/\.png$/, '.actual.png'))
        }
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${scene.name} @${t}s  PSNR ${score === Infinity ? 'inf' : score.toFixed(1)} dB`)
      }
    }
    if (failed) {
      console.log(`${failed} frame(s) differ; see *.actual.png next to the references`)
      process.exitCode = 1
    }
  } finally {
    await fetch(`${A}/api/shutdown`, { method: 'POST' }).catch(() => {})
    server.kill()
  }
}


await main()
