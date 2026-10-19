import { createProcessingAdmission } from '../core/processing-admission.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import vm from 'node:vm'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { ProjectRecovery as ActualProjectRecovery, RECOVERY_LIMITS, recoveryProject } from '../core/project-recovery.mjs'
import { migrate, newProject } from '../core/project.js'
import { writeProjectAtomic as fixtureWriter } from './support/trusted-fixture-writer.mjs'
import { createRecoveryController } from '../web/ui/project-recovery.js'

const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const text = (name = 'Original') => JSON.stringify(newProject(name), null, 2) + '\n'
class ProjectRecovery extends ActualProjectRecovery {
  constructor(root, options = {}) {
    const journal = (selected, packet, texts = []) => {
      const directory = path.join(selected, '.reel/recovery'); fs.mkdirSync(directory, { recursive: true })
      const file = path.join(directory, 'project-write.lock'), fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
      try {
        const locked = new ActualProjectRecovery(selected, { ...options, publicationLockHeld: fd })
        if (packet.operation === 'family') return { result: locked.family(true), texts: [] }
        if (packet.operation === 'capture') return { result: locked.capture(texts[0], packet.phase, packet.protectedIDs, packet.sourceSHA256), texts: [] }
        const result = locked.prepareRestore(packet.selection)
        return { result: { ...result, expectedMissing: result.expectedText === null }, texts: result.expectedText === null ? [result.text] : [result.text, result.expectedText] }
      } finally { fs.closeSync(fd) }
    }
    super(root, { ...options, journal: options.journal ?? journal })
  }
}
function folder(t, value = text()) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-recovery-'))), file = path.join(root, 'reel.project.json')
  if (value !== null) fs.writeFileSync(file, value)
  t.after(() => { fs.chmodSync(root, 0o700); fs.rmSync(root, { recursive: true, force: true }) })
  return { root, file, recovery: new ProjectRecovery(root) }
}
const selection = store => { const listing = store.list(); return { snapshotID: listing.snapshots[0].id, familyID: listing.familyID, observedToken: listing.observed.token } }
function serverState(root, { writer } = {}) {
  const recovery = new ProjectRecovery(root), file = path.join(root, 'reel.project.json')
  const context = vm.createContext({ ROOT: root, FILE: file, fs, recovery, recoveryState: null, recoveryProject, migrate,
    project: null, lastText: '', projectEpoch: 0, version: 0, past: [], future: [], clients: new Set(), warnings: [], structuredClone,
    processing: createProcessingAdmission(), assistantCalls: { getStore: () => undefined }, assistantReview: { commitBy() {} }, log: (...args) => context.warnings.push(args), pushActivity() {},
    writeProjectAtomic: writer ?? ((root, next, expected, expectedIdentity) => {
      const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, stat = fs.existsSync(file) ? fs.statSync(file, { bigint: true }) : null
      if (actual !== expected || (stat ? expectedIdentity?.device !== String(stat.dev) || expectedIdentity?.inode !== String(stat.ino) : expectedIdentity !== null)) throw new Error('Fixture expected-byte or inode conflict')
      return fixtureWriter(root, next)
    }) })
  const functions = ['loadFromDisk', 'rememberProject', 'persist', 'publishRecovery', 'restoreRecovery', 'assertAssistantPublication', 'commit', 'broadcast']
  vm.runInContext(functions.map(name => { const match = source.match(new RegExp(`function ${name}\\([^]*?\\n}\\n`)); assert.ok(match, name); return match[0] }).join('\n'), context)
  const routeLines = source.split('\n').filter(line => /^  '(GET \/api\/recovery|POST \/api\/recovery\/restore)'/.test(line))
  assert.equal(routeLines.length, 2)
  vm.runInContext(`globalThis.fixtureRoutes = {${routeLines.join('\n')}}`, context)
  context.loadFromDisk()
  return context
}

test('capture retains exact original-format bytes and identity-bound ISO receipts', t => {
  const { recovery, file } = folder(t), original = fs.readFileSync(file, 'utf8')
  const captured = recovery.capture(original, 'published', [], null), listing = recovery.list()
  assert.equal(fs.readFileSync(captured.snapshotFile, 'utf8'), original)
  const receipt = JSON.parse(fs.readFileSync(captured.receiptFile))
  assert.equal(receipt.bytes, Buffer.byteLength(original)); assert.equal(receipt.sha256, digest(original)); assert.equal(receipt.sourceSHA256, null)
  assert.equal(receipt.host, 'browser'); assert.match(receipt.createdAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(receipt.rootIdentity, recovery.rootIdentity); assert.equal(receipt.familyID, listing.familyID)
  assert.equal(listing.snapshots.length, 1)
})

test('invalid envelopes cannot become published recovery choices', t => {
  const { recovery } = folder(t)
  for (const value of ['{"tracks":"wrong"}', 'null', JSON.stringify({ ...newProject(), fps: -1 }), JSON.stringify({ ...newProject(), version: 99 }), JSON.stringify({ ...newProject(), tracks: [{ id: 'V1', kind: 'video', clips: [null] }] })]) assert.throws(() => recovery.capture(value))
  assert.equal(recovery.list().snapshots.length, 0)
})

test('restart offers durable snapshots without replacing a corrupt project automatically', t => {
  const { root, file } = folder(t), before = serverState(root)
  assert.equal(before.version, 1); fs.writeFileSync(file, '{truncated')
  const after = serverState(root)
  assert.equal(after.project, null); assert.equal(after.version, 0)
  assert.equal(after.recovery.list().snapshots.length, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), '{truncated')
})

test('corrupt and missing external edits preserve the last valid memory and block ordinary publication', t => {
  const { root, file } = folder(t), state = serverState(root), original = state.lastText, version = state.version
  fs.writeFileSync(file, '{truncated'); state.loadFromDisk()
  assert.equal(state.project.name, 'Original'); assert.equal(state.lastText, original); assert.equal(state.version, version)
  assert.throws(() => state.commit(newProject('Unsafe'), 'you', [])); assert.equal(state.past.length, 0)
  fs.unlinkSync(file); state.loadFromDisk()
  assert.equal(state.project.name, 'Original'); assert.equal(state.version, version)
  assert.throws(() => state.commit(newProject('Unsafe'), 'you', [])); assert.equal(fs.existsSync(file), false)
})

test('explicit restore preserves corrupt bytes and changes history/version once after publication', t => {
  const { root, file } = folder(t), state = serverState(root)
  fs.writeFileSync(file, '{broken'); state.loadFromDisk()
  const version = state.version, chosen = selection(state.recovery), restored = state.restoreRecovery({ ...chosen, expectedVersion: version })
  assert.equal(restored.version, version + 1); assert.equal(state.past.length, 1); assert.equal(state.future.length, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), text())
  const originals = state.recovery.inventory(state.recovery.family(false)).records.filter(record => record.phase === 'preserved-original')
  assert.equal(originals.length, 1); assert.equal(originals[0].text, '{broken')
})

test('missing main can be restored only with the observed missing token and expected version', t => {
  const { root, file } = folder(t), state = serverState(root)
  fs.unlinkSync(file); state.loadFromDisk()
  const chosen = selection(state.recovery)
  assert.equal(state.recovery.list().observed.status, 'missing')
  state.restoreRecovery({ ...chosen, expectedVersion: state.version })
  assert.equal(fs.readFileSync(file, 'utf8'), text()); assert.equal(state.recovery.list().preservedOriginals, 0)
})

test('stale choice token and stale expectedVersion never overwrite a newer external edit', t => {
  const { root, file } = folder(t), state = serverState(root), chosen = selection(state.recovery)
  fs.writeFileSync(file, text('External'))
  assert.throws(() => state.restoreRecovery({ ...chosen, expectedVersion: state.version }), /changed/)
  const current = selection(state.recovery)
  assert.throws(() => state.restoreRecovery({ ...current, expectedVersion: state.version + 1 }), /changed/)
  assert.equal(fs.readFileSync(file, 'utf8'), text('External')); assert.equal(state.past.length, 0)
})

test('expected-byte conflict at the writer preserves session history and the external winner', t => {
  const { root, file } = folder(t), state = serverState(root, { writer: (root, next, expected) => { fs.writeFileSync(file, text('Winner')); assert.notEqual(fs.readFileSync(file, 'utf8'), expected); throw new Error('Fixture final CAS failed') } })
  fs.writeFileSync(file, '{broken'); const chosen = selection(state.recovery), before = state.version
  assert.throws(() => state.restoreRecovery({ ...chosen, expectedVersion: before }), /final CAS/)
  assert.equal(state.version, before); assert.equal(state.past.length, 0); assert.equal(state.project.name, 'Original')
  assert.equal(fs.readFileSync(file, 'utf8'), text('Winner')); assert.equal(state.recovery.list().preservedOriginals, 1)
})

test('read-only main and a root made read-only block publication and restore', t => {
  const { root, file } = folder(t), state = serverState(root), chosen = selection(state.recovery)
  fs.chmodSync(file, 0o400)
  assert.throws(() => state.commit(newProject('Unsafe'), 'you', []), /read-only/)
  assert.throws(() => state.restoreRecovery({ ...selection(state.recovery), expectedVersion: state.version }), /read-only/)
  fs.chmodSync(file, 0o600); fs.chmodSync(root, 0o500)
  assert.equal(state.recovery.observe().writable, false)
  assert.throws(() => state.restoreRecovery({ ...selection(state.recovery), expectedVersion: state.version }), /read-only/)
  assert.equal(fs.readFileSync(file, 'utf8'), text())
})

test('digest-tampered snapshot is excluded and cannot be restored', t => {
  const { recovery } = folder(t), captured = recovery.capture(text()), chosen = selection(recovery)
  fs.writeFileSync(captured.snapshotFile, text('Tampered'))
  assert.equal(recovery.list().snapshots.length, 0); assert.throws(() => recovery.prepareRestore(chosen))
})

test('a forged receipt for invalid JSON is excluded despite matching bytes and digest', t => {
  const { recovery } = folder(t), captured = recovery.capture(text()), receipt = JSON.parse(fs.readFileSync(captured.receiptFile)), broken = '{"width":"wrong"}'
  fs.writeFileSync(captured.snapshotFile, broken); receipt.bytes = Buffer.byteLength(broken); receipt.sha256 = digest(broken)
  fs.writeFileSync(captured.receiptFile, JSON.stringify(receipt))
  assert.equal(recovery.list().snapshots.length, 0)
})

test('another folder cannot use copied family identity and snapshot pairs', t => {
  const first = folder(t), second = folder(t)
  first.recovery.capture(text()); fs.mkdirSync(path.join(second.root, '.reel'), { recursive: true })
  fs.cpSync(first.recovery.directory, path.join(second.root, '.reel/recovery'), { recursive: true })
  assert.equal(second.recovery.list().snapshots.length, 0); assert.throws(() => second.recovery.capture(text()))
})

test('native published pairs using the shared protocol appear as explicit choices', t => {
  const { recovery } = folder(t), captured = recovery.capture(text()), receipt = JSON.parse(fs.readFileSync(captured.receiptFile)), id = randomUUID()
  receipt.host = 'native'; receipt.id = id; receipt.sourceSHA256 = null
  fs.writeFileSync(path.join(recovery.directory, `native-${id}.project.json`), captured.text)
  fs.writeFileSync(path.join(recovery.directory, `native-${id}.receipt.json`), JSON.stringify(receipt))
  const native = recovery.list().snapshots.find(snapshot => snapshot.host === 'native')
  assert.ok(native)
  assert.equal(recovery.prepareRestore({ snapshotID: native.id, familyID: receipt.familyID, observedToken: recovery.observe().token }).text, captured.text)
})

test('retention prunes only verified published pairs and keeps every preserved original', t => {
  const { root } = folder(t), recovery = new ProjectRecovery(root, { limits: { ...RECOVERY_LIMITS, published: 2 }, now: (() => { let n = 0; return () => ++n })() })
  const original = recovery.capture('{corrupt', 'preserved-original')
  for (let i = 0; i < 5; i++) recovery.capture(text(`Version ${i}`))
  assert.equal(recovery.list().snapshots.length, 2); assert.equal(recovery.list().preservedOriginals, 1)
  assert.equal(fs.readFileSync(original.snapshotFile, 'utf8'), '{corrupt')
  assert.equal(recovery.inventory(recovery.family(false)).records.some(record => record.text === text('Version 4')), true)
})

test('unknown files and preserved originals exhaust the budget without being deleted', t => {
  const { root } = folder(t), recovery = new ProjectRecovery(root, { limits: { ...RECOVERY_LIMITS, totalBytes: 4096 } })
  recovery.family(true)
  const unknown = path.join(recovery.directory, 'unowned.dat'); fs.writeFileSync(unknown, Buffer.alloc(4096, 7))
  assert.throws(() => recovery.capture(text()), /full/)
  assert.deepEqual(fs.readFileSync(unknown), Buffer.alloc(4096, 7)); assert.equal(recovery.list().snapshots.length, 0)
})

test('an incomplete snapshot has no restore choice and is never auto-deleted', t => {
  const { recovery } = folder(t); recovery.family(true)
  const file = path.join(recovery.directory, `browser-${randomUUID()}.project.json`); fs.writeFileSync(file, text())
  assert.equal(recovery.list().snapshots.length, 0); assert.equal(fs.readFileSync(file, 'utf8'), text())
})

test('symlink and hardlinked recovery entries fail closed without touching their targets', t => {
  for (const kind of ['symlink', 'hardlink']) {
    const { recovery, root } = folder(t); recovery.family(true)
    const target = path.join(root, 'foreign'); fs.writeFileSync(target, 'keep')
    if (kind === 'symlink') fs.symlinkSync(target, path.join(recovery.directory, 'unowned'))
    else fs.linkSync(target, path.join(recovery.directory, 'unowned'))
    assert.equal(recovery.list().snapshots.length, 0); assert.throws(() => recovery.capture(text()))
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep')
  }
})

test('empty corrupt originals are preserved exactly during recovery preparation', t => {
  const { recovery, file } = folder(t); recovery.capture(text()); fs.writeFileSync(file, '')
  recovery.prepareRestore(selection(recovery))
  const preserved = recovery.inventory(recovery.family(false)).records.find(record => record.phase === 'preserved-original')
  assert.equal(preserved.bytes, 0); assert.equal(fs.statSync(preserved.snapshotFile).size, 0)
})

test('non-UTF8 original fails closed because the existing writer accepts expected UTF8 text', t => {
  const { recovery, file } = folder(t); recovery.capture(text()); fs.writeFileSync(file, Buffer.from([255, 0, 128]))
  assert.throws(() => recovery.prepareRestore(selection(recovery)), /safely read/)
  assert.deepEqual(fs.readFileSync(file), Buffer.from([255, 0, 128]))
})

test('snapshot fsync failure keeps the main and deletes only owned incomplete files', t => {
  const { root, file } = folder(t), original = fs.readFileSync(file), recovery = new ProjectRecovery(root)
  recovery.family(true)
  const fsync = fs.fsyncSync.bind(fs), disk = { ...fs, fsyncSync(fd) { if (fs.fstatSync(fd).isFile()) throw new Error('Fixture fsync failed'); return fsync(fd) } }
  const failing = new ProjectRecovery(root, { disk })
  assert.throws(() => failing.capture(text()), /fsync/)
  assert.deepEqual(fs.readFileSync(file), original)
  assert.deepEqual(fs.readdirSync(recovery.directory).sort(), ['project-identity.json', 'project-write.lock'])
})

test('an existing filename collision remains untouched when exclusive capture fails', t => {
  const { root } = folder(t), recovery = new ProjectRecovery(root); recovery.family(true)
  const id = randomUUID(), foreign = path.join(recovery.directory, `browser-${id}.project.json`)
  fs.writeFileSync(foreign, 'unowned')
  const collision = new ProjectRecovery(root, { makeID: () => id })
  assert.throws(() => collision.capture(text())); assert.equal(fs.readFileSync(foreign, 'utf8'), 'unowned')
})

test('file-size and directory-entry caps fail closed before publication', t => {
  const { root } = folder(t), small = new ProjectRecovery(root, { limits: { ...RECOVERY_LIMITS, projectBytes: 16 } })
  assert.throws(() => small.capture(text()), /bounds/)
  const limited = new ProjectRecovery(root, { limits: { ...RECOVERY_LIMITS, files: 1 } }); limited.family(true)
  fs.writeFileSync(path.join(limited.directory, 'unknown'), '')
  assert.throws(() => limited.capture(text()), /too many/)
})

test('actual extracted recovery routes list choices and restore through an ephemeral HTTP server', async t => {
  const { root, file } = folder(t), state = serverState(root)
  fs.writeFileSync(file, '{HTTP-corrupt'); state.loadFromDisk()
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk
      const route = state.fixtureRoutes[`${req.method} ${req.url}`]
      if (!route) throw new Error('No fixture route')
      const result = await route(raw ? JSON.parse(raw) : {})
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result))
    } catch (error) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  globalThis[Symbol.for('arya.verification.registerOwnedEphemeralHTTP')]?.(server)
  const url = `http://127.0.0.1:${server.address().port}`, listing = await (await fetch(`${url}/api/recovery`)).json()
  assert.equal(listing.observed.status, 'invalid'); assert.equal(listing.snapshots.length, 1)
  const body = { snapshotID: listing.snapshots[0].id, familyID: listing.familyID, observedToken: listing.observed.token, expectedVersion: listing.version }
  const restored = await fetch(`${url}/api/recovery/restore`, { method: 'POST', body: JSON.stringify(body) })
  assert.equal(restored.status, 200)
  const receipt = await restored.json()
  assert.equal(receipt.version, listing.version + 1)
  assert.equal(receipt.recovery.version, receipt.version, 'the refreshed listing carries the restored version')
  assert.equal(fs.readFileSync(file, 'utf8'), text())
  const stale = await fetch(`${url}/api/recovery/restore`, { method: 'POST', body: JSON.stringify(body) })
  assert.equal(stale.status, 409)
})

test('the recovery controller accepts the production restore receipt and permits another selection', async t => {
  const { root, file } = folder(t), state = serverState(root)
  fs.writeFileSync(file, '{controller-corrupt'); state.loadFromDisk()
  const context = { root, version: state.version }, calls = []
  const controller = createRecoveryController({
    context: () => context,
    request: async (path, body) => {
      calls.push(path)
      const result = await state.fixtureRoutes[`${body ? 'POST' : 'GET'} ${path}`](body)
      return JSON.parse(JSON.stringify(result))
    },
    apply: result => Object.assign(context, result),
  })
  t.after(() => controller.dispose())
  await controller.refresh()
  const chosen = controller.state.listing.snapshots[0].id
  controller.choose(chosen)
  await controller.restore()
  assert.equal(controller.state.error, '')
  assert.match(controller.state.message, /selected copy was restored/)
  assert.equal(controller.state.listing.version, context.version)
  assert.deepEqual(calls, ['/api/recovery', '/api/recovery/restore'], 'a successful restore does not fall back to an error refresh')
  controller.choose(chosen)
  assert.equal(controller.canRestore(), true)
  assert.equal(fs.readFileSync(file, 'utf8'), text())
})

test('known-field validation preserves legacy default omissions and exact original format', t => {
  const legacy = '{"name":"Legacy","tracks":[{"id":"V1","kind":"video"}]}\n'
  const { root, file } = folder(t, legacy), state = serverState(root)
  assert.equal(state.project.name, 'Legacy'); assert.deepEqual(Array.from(state.project.tracks[0].clips), [])
  assert.equal(state.recovery.list().snapshots.length, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), legacy)
  const captured = state.recovery.inventory(state.recovery.family(false)).records[0]
  assert.equal(captured.text, legacy)
  state.commit({ ...state.project, name: 'Edited legacy' }, 'you', [])
  assert.equal(JSON.parse(fs.readFileSync(file)).name, 'Edited legacy')
})

test('growing source reads stay bounded to the initial size plus one byte and fail closed', t => {
  const { root, file } = folder(t), initial = fs.statSync(file).size
  let reads = 0, maximumBuffer = 0
  const disk = { ...fs, readSync(fd, buffer, offset, length, position) {
    maximumBuffer = Math.max(maximumBuffer, buffer.length)
    if (!reads++) fs.appendFileSync(file, Buffer.alloc(1024 * 1024, 32))
    return fs.readSync(fd, buffer, offset, length, position)
  } }
  const recovery = new ProjectRecovery(root, { disk })
  assert.throws(() => recovery.read(file), /changed while reading/)
  assert.equal(maximumBuffer, initial + 1); assert.equal(fs.statSync(file).size, initial + 1024 * 1024)
})

test('prepared restore carries the observed inode so a same-bytes invocation swap can fail', t => {
  const { root, file } = folder(t), state = serverState(root), original = text()
  state.writeProjectAtomic = (root, next, expected, expectedIdentity) => {
    const replacement = path.join(root, 'external.json'); fs.writeFileSync(replacement, expected); fs.renameSync(replacement, file)
    const actual = fs.statSync(file, { bigint: true })
    assert.equal(fs.readFileSync(file, 'utf8'), expected)
    assert.notEqual(expectedIdentity.inode, String(actual.ino))
    throw new Error('Fixture expected inode changed')
  }
  const before = state.version
  assert.throws(() => state.restoreRecovery({ ...selection(state.recovery), expectedVersion: before }), /inode changed/)
  assert.equal(state.version, before); assert.equal(state.past.length, 0); assert.equal(fs.readFileSync(file, 'utf8'), original)
})

test('real recovery journaling preserves undo and redo state after a restore', t => {
  const { root, file } = folder(t), state = serverState(root)
  state.commit(newProject('Edited'), 'you', [])
  const original = state.recovery.list().snapshots.find(snapshot => snapshot.name === 'Original'), listing = state.recovery.list()
  fs.writeFileSync(file, '{damaged')
  state.restoreRecovery({ snapshotID: original.id, familyID: listing.familyID, observedToken: state.recovery.observe().token, expectedVersion: state.version })
  assert.equal(state.project.name, 'Original'); assert.equal(state.past.at(-1).name, 'Edited')
  state.commit(state.past.at(-1), 'you', ['undo'], { history: false, historyMove: 'undo' })
  assert.equal(state.project.name, 'Edited'); assert.equal(state.future.at(-1).name, 'Original')
  state.commit(state.future.at(-1), 'you', ['redo'], { history: false, historyMove: 'redo' })
  assert.equal(state.project.name, 'Original'); assert.equal(state.future.length, 0)
  assert.equal(state.lastText, fs.readFileSync(file, 'utf8')); assert.equal(state.recovery.list().preservedOriginals, 1)
})

test('shared validation rejects invalid clip times, sample rates and record count overflow', t => {
  const { recovery } = folder(t)
  for (const [key, value] of [['start', -1], ['in', '0'], ['dur', -1]]) {
    assert.throws(() => recovery.capture(JSON.stringify({ tracks: [{ clips: [{ [key]: value }] }] })), /clip/)
  }
  assert.throws(() => recovery.capture('{"sampleRate":0}'), /sampleRate/)
  assert.throws(() => recovery.capture(JSON.stringify({ tracks: [{ clips: Array.from({ length: 100001 }, () => ({})) }] })), /clips/)
  assert.throws(() => recovery.capture(JSON.stringify({ comps: Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [i, {}])) })), /records/)
  assert.equal(recovery.list().snapshots.length, 0)
})

test('inventory reads only the capped number of directory entries plus one sentinel', t => {
  const { root, recovery } = folder(t); recovery.family(true)
  let reads = 0, closed = false
  const disk = { ...fs, readdirSync() { throw new Error('Unbounded directory listing is forbidden') }, opendirSync() {
    return { readSync() { reads++; return { name: 'project-write.lock' } }, closeSync() { closed = true } }
  } }
  const limited = new ProjectRecovery(root, { disk, limits: { ...RECOVERY_LIMITS, files: 3 } })
  assert.throws(() => limited.inventory(limited.family(false)), /too many/)
  assert.equal(reads, 4); assert.equal(closed, true)
})

test('capture reserves both incoming files and keeps unowned entries at the cap', t => {
  const { root, recovery } = folder(t); recovery.family(true)
  fs.writeFileSync(path.join(recovery.directory, 'unowned'), '')
  const limited = new ProjectRecovery(root, { limits: { ...RECOVERY_LIMITS, files: 4 } })
  assert.throws(() => limited.capture('{}'), /too many files for a new snapshot pair/)
  assert.equal(fs.readdirSync(recovery.directory).length, 3)
  assert.equal(fs.readFileSync(path.join(recovery.directory, 'unowned'), 'utf8'), '')
})

test('a verified old pair can be pruned to reserve the two incoming names', t => {
  const { root } = folder(t), limited = new ProjectRecovery(root, { limits: { ...RECOVERY_LIMITS, files: 4 } })
  limited.capture('{"name":"first"}')
  limited.capture('{"name":"second"}')
  assert.equal(limited.list().snapshots.length, 1)
  assert.equal(limited.list().snapshots[0].name, 'second')
  assert.equal(fs.readdirSync(limited.directory).length, 4)
})


test('combined admission capture advances only after its own saved publication', async t => {
  const f=folder(t), state=serverState(f.root)
  let captured=state.version, accepts=0
  await state.processing.run(async () => {
    state.commit(newProject('Own first save'), 'fixture', [])
    assert.equal(accepts,1); assert.equal(captured,state.version)
    state.commit(newProject('Own second save'), 'fixture', [])
    assert.equal(accepts,2); assert.equal(captured,state.version)
  }, { assertCurrent: () => assert.equal(state.version,captured), accept: () => { captured=state.version; accepts++ } })
  assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).name,'Own second save')
  assert.equal(state.past.length,2)
})
test('combined failed saved publication does not accept a new capture or mutate history', async t => {
  const f=folder(t), state=serverState(f.root, { writer: () => { throw Error('Publication fixture failure') } })
  const prior=fs.readFileSync(f.file), version=state.version, history=state.past.length
  let accepts=0
  await assert.rejects(state.processing.run(async () => state.commit(newProject('Rejected save'), 'fixture', []), {
    assertCurrent: () => assert.equal(state.version,version), accept: () => { accepts++ }
  }), /Publication fixture failure/)
  assert.equal(accepts,0); assert.equal(state.version,version); assert.equal(state.past.length,history)
  assert.deepEqual(fs.readFileSync(f.file),prior)
})
