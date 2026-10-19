import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { applyOps, newProject } from '../../editor/core/project.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.resolve(process.argv[2] ?? path.join(repo, 'build/native-render-fixtures'))
fs.mkdirSync(path.join(out, 'media'), { recursive: true })
const ff = args => execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args])
for (const [name, source, size] of [['test', 'testsrc2', '1280x720'], ['bars', 'smptehdbars', '1280x720'], ['fractal', 'mandelbrot', '640x360']]) {
  const file = path.join(out, 'media', `${name}.mp4`)
  if (!fs.existsSync(file)) ff(['-f', 'lavfi', '-i', `${source}=s=${size}:r=30`, '-t', '8', '-c:v', 'libx264', '-g', '15', '-pix_fmt', 'yuv420p', file])
}
const golden = fs.readFileSync(path.join(repo, 'editor/scripts/golden.mjs'), 'utf8')
const scenes = vm.runInNewContext(golden.slice(golden.indexOf('const SCENES = ') + 15, golden.indexOf('\nasync function post')))
const assets = Object.fromEntries(['test', 'bars', 'fractal'].map(name => [`media/${name}.mp4`, { duration: 8, width: name === 'fractal' ? 640 : 1280, height: name === 'fractal' ? 360 : 720, fps: 30, hasVideo: true, hasAudio: false, codec: 'h264', assetKind: 'video' }]))
const frames = []
for (const scene of scenes) {
  const project = applyOps(newProject(scene.name, { width: 1280, height: 720, fps: 30 }), [{ op: 'import', assets }, ...scene.ops]).project
  const file = `${scene.name}.json`
  fs.writeFileSync(path.join(out, file), JSON.stringify(project))
  for (const at of scene.times) frames.push({ project: file, at, reference: path.join(repo, 'editor/test/golden', `${scene.name}-${at}.png`), output: `${scene.name}-${at}.png` })
}
fs.writeFileSync(path.join(out, 'frames.json'), JSON.stringify(frames))
console.log(out)
