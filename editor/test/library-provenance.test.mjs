import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { applyOps, newProject } from '../core/project.js'
import { validateLibraryItem } from '../core/library.js'

const clone = value => structuredClone(value)
const run = (project, ops) => applyOps(project, ops).project
const hash = value => createHash('sha256').update(value).digest('hex')

function source() {
  return run(newProject('Original project'), [
    { op: 'add_title', track: 'V1', start: 0, dur: 4, text: 'Original heading', title: { font: 'Inter' }, set: { note: 'figma 10:5' } },
    { op: 'library_save', category: 'title', name: 'Heading', description: 'Original description', source: { clip: 'c1' } },
  ])
}

function receipt(item, prior = []) {
  const itemJSON = JSON.stringify(item)
  const itemSHA256 = hash(itemJSON)
  const packageJSON = JSON.stringify({ format: 'arya-component', version: 1, itemJSON, itemSHA256, origin: { projectName: 'Original project', projectVersion: 8, exportedAt: '2026-10-04T01:00:00.000Z' } })
  return { format: 'arya-component', version: 1, imports: [...clone(prior), {
    sourceItemID: item.id, sourceProjectName: 'Original project', sourceProjectVersion: 8,
    exportedAt: '2026-10-04T01:00:00.000Z', itemSHA256, packageSHA256: hash(packageJSON),
  }] }
}

function registeredItem(item, prior = []) {
  const result = clone(item)
  delete result.id
  result.provenance = receipt(item, prior)
  return result
}

function expectAtomicFailure(project, candidate, pattern) {
  const before = clone(project)
  assert.throws(() => run(project, [{ op: 'library_register', item: candidate }]), pattern)
  assert.deepEqual(project, before)
}

test('component import preserves the source body and provenance while allocating a fresh ID', () => {
  const original = source()
  const sourceBefore = clone(original)
  const item = original.library.items[0]
  const candidate = registeredItem(item)
  const destination = source()
  const destinationBefore = clone(destination)
  const imported = run(destination, [{ op: 'library_register', item: candidate }])
  const saved = imported.library.items.at(-1)
  assert.notEqual(saved.id, item.id)
  assert.deepEqual(saved.body, item.body)
  assert.equal(saved.name, item.name)
  assert.equal(saved.description, item.description)
  assert.deepEqual(saved.provenance, candidate.provenance)
  assert.deepEqual(destination, destinationBefore)
  assert.deepEqual(original, sourceBefore)
  candidate.provenance.imports[0].sourceProjectName = 'Caller changed'
  candidate.body.clip.title.text = 'Caller changed'
  assert.equal(saved.provenance.imports[0].sourceProjectName, 'Original project')
  assert.equal(saved.body.clip.title.text, 'Original heading')
})

test('imported title placement remaps colliding clip IDs and leaves provenance and original layers intact', () => {
  const destination = source()
  const imported = run(destination, [{ op: 'library_register', item: registeredItem(destination.library.items[0]) }])
  const saved = clone(imported.library.items.at(-1))
  const placed = run(imported, [{ op: 'library_apply', item: saved.id, track: 'V2', start: 6 }])
  const copy = placed.tracks.find(track => track.id === 'V2').clips[0]
  assert.notEqual(copy.id, saved.body.clip.id)
  assert.equal(copy.start, 6)
  assert.equal(copy.title.text, 'Original heading')
  assert.equal(copy.title.font, 'Inter')
  assert.equal(copy.note, 'figma 10:5')
  assert.deepEqual(placed.tracks[0].clips, destination.tracks[0].clips)
  assert.deepEqual(placed.library.items.at(-1), saved)
})

test('provenance survives repeated imports, rename, placement, and JSON roundtrip without changing prior receipts', () => {
  const item = source().library.items[0]
  const first = run(newProject('First copy'), [{ op: 'library_register', item: registeredItem(item) }])
  const previous = clone(first.library.items[0].provenance.imports)
  const second = run(newProject('Second copy'), [{ op: 'library_register', item: registeredItem(first.library.items[0], previous) }])
  const saved = second.library.items[0]
  assert.equal(saved.provenance.imports.length, 2)
  assert.deepEqual(saved.provenance.imports.slice(0, -1), previous)
  const renamed = run(JSON.parse(JSON.stringify(second)), [{ op: 'library_rename', item: saved.id, name: 'Reused heading', description: 'Edited description' }])
  assert.deepEqual(renamed.library.items[0].provenance, saved.provenance)
  const applied = run(renamed, [{ op: 'library_apply', item: saved.id, track: 'V1', start: 0 }])
  const removed = run(applied, [{ op: 'library_remove', item: saved.id }])
  assert.equal(removed.library.items.length, 0)
  assert.equal(removed.tracks[0].clips[0].title.text, 'Original heading')
  assert.deepEqual(second.library.items[0], saved)
})

test('old components remain valid without provenance and the provenance receipt limit is enforced', () => {
  const item = source().library.items[0]
  assert.equal(validateLibraryItem(clone(item)).id, item.id)
  const candidate = registeredItem(item)
  candidate.provenance.imports = Array.from({ length: 32 }, () => clone(candidate.provenance.imports[0]))
  assert.equal(validateLibraryItem(clone(candidate)).provenance.imports.length, 32)
  candidate.provenance.imports.push(clone(candidate.provenance.imports[0]))
  expectAtomicFailure(newProject('Destination'), candidate, /1 to 32 import receipts/)
})

test('malformed provenance is rejected atomically rather than silently discarded', () => {
  const candidate = registeredItem(source().library.items[0])
  const cases = [
    value => { value.provenance = null },
    value => { value.provenance.version = 2 },
    value => { value.provenance.format = 'other' },
    value => { value.provenance.extra = true },
    value => { value.provenance.imports = [] },
    value => { value.provenance.imports = {} },
    value => { value.provenance.imports[0].extra = true },
    value => { delete value.provenance.imports[0].packageSHA256 },
    value => { value.provenance.imports[0].sourceItemID = '../lib1' },
    value => { value.provenance.imports[0].sourceProjectName = ' ' },
    value => { value.provenance.imports[0].sourceProjectName = 'a'.repeat(513) },
    value => { value.provenance.imports[0].sourceProjectVersion = -1 },
    value => { value.provenance.imports[0].sourceProjectVersion = 1.5 },
    value => { value.provenance.imports[0].sourceProjectVersion = Number.MAX_SAFE_INTEGER + 1 },
    value => { value.provenance.imports[0].exportedAt = '2026-02-31T01:00:00.000Z' },
    value => { value.provenance.imports[0].exportedAt = '2026-10-04T01:00:00+00:00' },
    value => { value.provenance.imports[0].itemSHA256 = 'a'.repeat(63) },
    value => { value.provenance.imports[0].packageSHA256 = 'A'.repeat(64) },
  ]
  for (const mutate of cases) {
    const broken = clone(candidate)
    mutate(broken)
    expectAtomicFailure(newProject('Destination'), broken, /Library:/)
  }
})

test('HTTP component imports retain provenance on disk and use one undoable operation', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arya-component-provenance-'))
  let child
  t.after(async () => {
    if (child && child.exitCode === null) {
      const ended = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGTERM')
      await ended
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  const file = path.join(root, 'reel.project.json')
  const original = source()
  await fs.writeFile(file, JSON.stringify(original))
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  assert.ok(![4874, 4881, 4173].includes(port))
  child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), '--root', root, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output = (output + data).slice(-12000) })
  child.stderr.on('data', data => { output = (output + data).slice(-12000) })
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const api = async (route, body) => {
    const response = await request(route, body)
    assert.equal(response.status, 200, response.body.error)
    return response.body
  }
  const deadline = Date.now() + 10000
  while (true) {
    try { if ((await request('/api/project')).status === 200) break } catch {}
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Isolated component server did not start\n${output}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const before = await api('/api/project')
  const incoming = registeredItem(original.library.items[0])
  const imported = await api('/api/ops', { ops: [{ op: 'library_register', item: incoming }] })
  assert.notEqual(imported.project.library.items.at(-1).id, original.library.items[0].id)
  assert.deepEqual(imported.project.library.items.at(-1).provenance, incoming.provenance)
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), imported.project)
  assert.deepEqual((await api('/api/undo', {})).project, before.project)
  assert.deepEqual((await api('/api/redo', {})).project, imported.project)
  const malformed = clone(incoming)
  malformed.provenance.imports[0].packageSHA256 = 'invalid'
  const invalid = await request('/api/ops', { ops: [{ op: 'library_register', item: malformed }] })
  assert.ok(invalid.status >= 400 && invalid.status < 600)
  const after = await api('/api/project')
  assert.equal(after.version, imported.version + 2)
  assert.deepEqual(after.project, imported.project)
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), imported.project)
})
