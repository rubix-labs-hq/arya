import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { newProject } from '../core/project.js'

// A Finder duplicate, a move to another volume or a backup restore gives the project folder a
// new inode while .reel/recovery still names the old one. Recovery snapshots are a safety copy:
// the copy must keep saving, report the recovery warning, and leave the original untouched.

async function unusedPort() { const l = net.createServer(); l.listen(0, '127.0.0.1'); await once(l, 'listening'); const { port } = l.address(); await new Promise(r => l.close(r)); return port }

async function server(root) {
  const port = await unusedPort(), base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), '--root', root, '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', d => { output += d }); child.stderr.on('data', d => { output += d })
  const ended = new Promise(r => child.once('exit', r))
  const request = async (route, body) => {
    const response = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  const close = async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([ended, new Promise(r => setTimeout(r, 3000))]) } }
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    try { if ((await request('/api/project')).status === 200) return { request, close, output: () => output } } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  await close(); throw new Error(`server did not start: ${output}`)
}

const scaleOf = async (root, id) => JSON.parse(await fs.readFile(path.join(root, 'reel.project.json'), 'utf8')).tracks.flatMap(t => t.clips).find(c => c.id === id)?.scale

// The atomic project writer is the macOS helper, so this real-server test runs on macOS only.
test('a copied project folder keeps saving and reports the recovery warning', { skip: process.platform !== 'darwin' }, async t => {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'arya-copy-')))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const original = path.join(parent, 'original'), copy = path.join(parent, 'copy')
  await fs.mkdir(original)
  const project = newProject({ name: 'Copy fixture' })
  project.tracks[0].clips.push({ id: 't1', kind: 'title', start: 0, dur: 2, title: { text: 'Copied title' } })
  await fs.writeFile(path.join(original, 'reel.project.json'), JSON.stringify(project, null, 2))

  // One save in the original creates its recovery identity.
  let owned = await server(original)
  try {
    const first = await owned.request('/api/ops', { ops: [{ op: 'update', ids: ['t1'], set: { scale: 0.5 } }], summary: 'original edit' })
    assert.equal(first.status, 200, JSON.stringify(first.data))
  } finally { await owned.close() }
  await fs.access(path.join(original, '.reel/recovery'))
  assert.equal(await scaleOf(original, 't1'), 0.5)

  await fs.cp(original, copy, { recursive: true })
  owned = await server(copy)
  try {
    const edit = await owned.request('/api/ops', { ops: [{ op: 'update', ids: ['t1'], set: { scale: 0.75 } }], summary: 'copy edit' })
    assert.equal(edit.status, 200, `the copy refused to save: ${JSON.stringify(edit.data)}`)
    assert.equal(await scaleOf(copy, 't1'), 0.75, 'the edit reached the copied project file')
    const state = await owned.request('/api/project')
    assert.match(state.data.recovery?.warning ?? '', /another project folder/, 'the recovery problem is reported, not hidden')
    const undo = await owned.request('/api/undo', {})
    assert.equal(undo.status, 200)
    assert.equal(await scaleOf(copy, 't1'), 0.5, 'Undo restores the copied project')
    // Once the copy has its own recovery folder, the next save stops reporting the old problem.
    await fs.rm(path.join(copy, '.reel/recovery'), { recursive: true })
    const fresh = await owned.request('/api/ops', { ops: [{ op: 'update', ids: ['t1'], set: { scale: 0.6 } }], summary: 'copy edit after reset' })
    assert.equal(fresh.status, 200, JSON.stringify(fresh.data))
    assert.equal((await owned.request('/api/project')).data.recovery?.warning ?? null, null, 'a cleared recovery problem is no longer reported')
  } finally { await owned.close() }
  assert.equal(await scaleOf(original, 't1'), 0.5, 'the original folder is untouched')
})
