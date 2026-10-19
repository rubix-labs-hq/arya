import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { newProject } from '../core/project.js'

// Preview audio, waveform peaks and filmstrips are cached by source content and never
// written into the project. Importing media starts them, and editing right away is normal,
// so an edit made while one renders must not turn it into a failed request.

async function unusedPort() { const l = net.createServer(); l.listen(0, '127.0.0.1'); await once(l, 'listening'); const { port } = l.address(); await new Promise(r => l.close(r)); return port }
const pause = ms => new Promise(r => setTimeout(r, ms))
async function appears(file) { for (let i = 0; i < 200; i++) { try { await fs.access(file); return } catch {} await pause(25) } throw new Error(`missing ${file}`) }

// The atomic project writer is the macOS helper, so this real-server test runs on macOS only.
test('an edit made while preview audio renders does not fail the preview request', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'arya-derivative-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'media')); await fs.writeFile(path.join(root, 'media/source.mp4'), 'source bytes')
  const project = newProject({ name: 'Derivative fixture' })
  project.assets['media/source.mp4'] = { hasVideo: false, hasAudio: true, duration: 4, codec: 'aac' }
  project.tracks[0].clips.push({ id: 't1', kind: 'title', start: 0, dur: 2, title: { text: 'Title' } })
  await fs.writeFile(path.join(root, 'reel.project.json'), JSON.stringify(project, null, 2))

  // A stand-in ffmpeg holds the preview render open until the edit has been saved.
  const bin = path.join(root, 'bin'), started = path.join(root, 'ffmpeg-started'), release = path.join(root, 'ffmpeg-release')
  const realFFmpeg = execFileSync('/usr/bin/which', ['ffmpeg'], { encoding: 'utf8' }).trim()
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, 'ffmpeg'), `#!${process.execPath}
import fs from 'node:fs'; import { spawnSync } from 'node:child_process'
const out = process.argv.at(-1)
if (!out.endsWith('.part.wav')) process.exit(spawnSync(${JSON.stringify(realFFmpeg)}, process.argv.slice(2), { stdio: 'inherit' }).status ?? 1)
fs.writeFileSync(${JSON.stringify(started)}, 'started')
const wait = () => fs.existsSync(${JSON.stringify(release)}) ? (fs.writeFileSync(out, 'RIFF preview'), process.exit(0)) : setTimeout(wait, 20)
wait()
`, { mode: 0o700 })

  const port = await unusedPort(), base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), '--root', root, '--port', String(port)], { cwd: root, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', d => { output += d }); child.stderr.on('data', d => { output += d })
  const ended = new Promise(r => child.once('exit', r))
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([ended, pause(3000)]) } })
  const post = async (route, body) => { const r = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() } }
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/project')).ok) break } catch {}
    if (i > 120) assert.fail(`server did not start: ${output}`)
    await pause(100)
  }

  const preview = fetch(`${base}/api/audio?src=media%2Fsource.mp4&in=0&dur=1`)
  await appears(started)
  const edit = await post('/api/ops', { ops: [{ op: 'update', ids: ['t1'], set: { scale: 0.5 } }], summary: 'edit during preview' })
  assert.equal(edit.status, 200, JSON.stringify(edit.data))
  await fs.writeFile(release, 'go')
  const response = await preview
  assert.equal(response.status, 200, `${await response.clone().text()} ${output}`)
  assert.equal(await response.text(), 'RIFF preview')
})
