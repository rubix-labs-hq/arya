import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { newProject } from '../core/project.js'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(read, accepts, description, assertAlive) {
  const deadline = Date.now() + 12000
  let value
  while (Date.now() < deadline) {
    assertAlive()
    try { value = await read(); if (accepts(value)) return value } catch {}
    assertAlive()
    await pause(40)
  }
  assert.fail(`${description}: ${JSON.stringify(value)}`)
}
async function boundedWait(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds) })])
  } finally { clearTimeout(timer) }
}
async function availablePort() {
  const listener = net.createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  assert.ok(![4870, 4881].includes(port))
  return port
}

test('default prepared writer preserves HTTP state on failure and reconciles watcher recovery with undo and redo', { timeout: 45000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'arya-http-save-')))
  const file = path.join(root, 'reel.project.json'), link = path.join(root, 'retained-project.json')
  let child, stopped, ended = false, childError, exit, ready = false
  const lifetime = new AbortController()
  t.after(async () => {
    if (child && !ended && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      if (!await boundedWait(stopped, 3000)) {
        if (!ended && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        assert.ok(await boundedWait(stopped, 3000), `Owned child ${child.pid} did not stop; disposable project retained at ${root}`)
      }
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  const port = await availablePort(), base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), '--root', root, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
  stopped = new Promise(resolve => {
    child.once('exit', (code, signal) => {
      ended = true; exit = { code, signal }
      lifetime.abort(new Error(`Owned server exited: ${JSON.stringify(exit)}`))
      resolve()
    })
    child.on('error', error => {
      childError = error
      lifetime.abort(error)
      if (!child.pid) { ended = true; resolve() }
    })
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const assertAlive = () => {
    assert.ifError(childError)
    assert.ok(!ended && child.exitCode === null && child.signalCode === null && child.pid, `Owned server unavailable: ${JSON.stringify(exit)} ${output}`)
  }
  const request = async (route, body) => {
    assertAlive()
    assert.ok(body === undefined || ready, 'Refuse mutation before verifying the owned server receipt and project root')
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(5000), lifetime.signal]) })
    return { status: response.status, body: await response.json() }
  }
  const state = async () => (await request('/api/project')).body
  await eventually(async () => {
    const receipt = JSON.parse(await fs.readFile(path.join(root, '.reel/server.json'), 'utf8'))
    const project = await state()
    return { receipt, project }
  }, value => value.receipt.pid === child.pid && value.receipt.port === port && value.receipt.root === root && value.project.root === root && value.project.version === 0, 'owned disposable server starts', assertAlive)
  assertAlive()
  ready = true
  assert.equal((await request('/api/new', { name: 'First' })).status, 200, output)
  const first = await state()
  assert.equal(first.project.name, 'First')
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).name, 'First')
  const stale = await request('/api/new', { name: 'Stale', expectedVersion: first.version - 1 })
  assert.equal(stale.status, 500); assert.match(stale.body.error, /project changed/)
  assert.equal((await state()).version, first.version)
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).name, 'First')
  const edit = name => ({ expectedVersion: undefined, ops: [{ op: 'replace', project: newProject(name) }] })
  assert.equal((await request('/api/ops', edit('Second'))).status, 200)
  const before = await state(), bytes = await fs.readFile(file, 'utf8')
  await fs.link(file, link)
  for (const [route, body] of [['/api/ops', edit('Must not publish')], ['/api/undo', {}]]) {
    const failed = await request(route, body)
    assert.equal(failed.status, 500)
    assert.equal(failed.body.error, 'The project cannot be safely read for recovery')
    const after = await state()
    assert.equal(after.version, before.version)
    assert.deepEqual(after.project, before.project)
    assert.deepEqual(after.activity, before.activity)
    assert.equal(await fs.readFile(file, 'utf8'), bytes)
    assert.equal(await fs.readFile(link, 'utf8'), bytes)
  }
  await fs.unlink(link)
  assert.equal((await request('/api/undo', {})).body.project.name, 'First')
  const undone = await state()
  await fs.link(file, link)
  assert.equal((await request('/api/redo', {})).status, 500)
  assert.equal((await state()).version, undone.version)
  await fs.unlink(link)
  assert.equal((await request('/api/redo', {})).body.project.name, 'Second')

  const redone = await state()
  await fs.writeFile(file, '{"incomplete":')
  await pause(900)
  assert.equal((await state()).version, redone.version)
  const conflict = await request('/api/ops', edit('Cannot overwrite malformed external data'))
  assert.equal(conflict.status, 500)
  assert.equal(await fs.readFile(file, 'utf8'), '{"incomplete":')
  assert.equal((await state()).version, redone.version)
  await fs.writeFile(file, JSON.stringify(newProject('Watcher recovered')) + '\n')
  const watched = await eventually(state, value => value.project?.name === 'Watcher recovered', 'watcher accepts repaired external project', assertAlive)
  assert.equal(watched.version, redone.version + 1)
  assert.equal((await request('/api/undo', {})).body.project.name, 'Second')
  assert.equal((await request('/api/redo', {})).body.project.name, 'Watcher recovered')
  assert.equal((await request('/api/ops', edit('Saved after recovery'))).status, 200)
  const final = await state()
  assert.equal(final.project.name, 'Saved after recovery')
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), final.project)
  const receipt = JSON.parse(await fs.readFile(path.join(root, '.reel/server.json'), 'utf8'))
  assert.equal(receipt.pid, child.pid)
  assert.equal(receipt.port, port)
  assert.equal(receipt.root, root)
  t.diagnostic(JSON.stringify({ root, port, pid: child.pid, defaultWriter: true, successfulSave: true, rejectedTarget: true, failedUndoRedoRetainedHistory: true, malformedExternalSaveRejected: true, watcherRecovered: true, finalVersion: final.version }))
})
