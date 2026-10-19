import { createProcessingAdmission } from '../core/processing-admission.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeProjectAtomic } from './support/trusted-fixture-writer.mjs'
import { recoveryDouble } from './support/recovery-double.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(HERE, '../server.mjs'), 'utf8')
const originalWrite = fs.writeFileSync.bind(fs)
const originalFsync = fs.fsyncSync.bind(fs)
const originalRename = fs.renameSync.bind(fs)
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-save-test-'))
  const file = path.join(root, 'reel.project.json')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  originalWrite(file, '{"name":"old"}\n', { mode: 0o640 })
  return { root, file }
}
function failure(code = 'EIO') { return Object.assign(new Error('Injected fixture I/O failure'), { code }) }
function saved(file) { return JSON.parse(fs.readFileSync(file, 'utf8')) }
function functionText(name) {
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n}\\n`))
  assert.ok(match, name)
  return match[0]
}
function routeText(name) {
  const match = source.match(new RegExp(`'POST /api/${name}': \\(\\) => \\{([^]*?)\\n  \\},`))
  assert.ok(match, name)
  return `function ${name}() {${match[1]}\n}`
}
function server(root, writer = writeProjectAtomic, disk = fs) {
  const context = vm.createContext({ ROOT: root, FILE: path.join(root, 'reel.project.json'), fs: disk,
    clients: new Set(), structuredClone, probe: async () => ({ codec: 'test-codec' }), project: null, lastText: '', projectEpoch: 0, version: 0, past: [], future: [], events: [], lines: [], warnings: [],
    migrate: value => value, writeProjectAtomic: writer, recoveryProject: JSON.parse, recovery: recoveryDouble(root, disk), recoveryState: null,
    processing: createProcessingAdmission(), assistantCalls: { getStore: () => undefined }, assistantReview: { commitBy() {} },
    log: (...args) => context.warnings.push(args),
    broadcast: (...args) => context.events.push(args),
    pushActivity: (...args) => context.lines.push(args) })
  vm.runInContext(['loadFromDisk', 'rememberProject', 'persist', 'assertAssistantPublication', 'commit', 'broadcast'].map(functionText).join('\n') + '\n' + ['undo', 'redo'].map(routeText).join('\n') + '\n' + 'async ' + functionText('refreshAssets'), context)
  context.clients.add({ res: { write: line => { const event = line.match(/^event: ([^\n]+)/)[1]; const data = JSON.parse(line.match(/\ndata: ([^\n]+)/)[1]); context.events.push([event, data]) } } })
  context.loadFromDisk()
  return context
}

for (const stage of ['write', 'flush', 'rename']) {
  test(`pre-publication ${stage} failure preserves exact prior bytes and removes temporary file`, t => {
    const { root, file } = fixture(t), before = fs.readFileSync(file)
    if (stage === 'write') t.mock.method(fs, 'writeFileSync', (...args) => { if (typeof args[0] === 'number') { fs.writeSync(args[0], '{"partial":'); throw failure() } return originalWrite(...args) })
    if (stage === 'flush') t.mock.method(fs, 'fsyncSync', fd => { if (fs.fstatSync(fd).isFile()) throw failure(); return originalFsync(fd) })
    if (stage === 'rename') t.mock.method(fs, 'renameSync', () => { throw failure() })
    assert.throws(() => writeProjectAtomic(root, '{"name":"new"}\n'))
    assert.deepEqual(fs.readFileSync(file), before)
    assert.deepEqual(fs.readdirSync(root), ['reel.project.json'])
  })
}

test('successful replacement preserves permission bits and emits complete JSON', t => {
  const { root, file } = fixture(t)
  const result = writeProjectAtomic(root, '{"name":"new"}\n')
  assert.equal(saved(file).name, 'new')
  assert.equal(fs.statSync(file).mode & 0o777, 0o640)
  assert.equal(typeof result.directorySynced, 'boolean')
  assert.deepEqual(fs.readdirSync(root), ['reel.project.json'])
})

test('new project creation respects umask', t => {
  const { root, file } = fixture(t); fs.unlinkSync(file)
  writeProjectAtomic(root, '{"name":"new"}\n')
  assert.equal(fs.statSync(file).mode & 0o777, 0o666 & ~process.umask())
})

test('post-publication directory flush failure returns a warning and retains published JSON', t => {
  const { root, file } = fixture(t)
  t.mock.method(fs, 'fsyncSync', fd => { if (fs.fstatSync(fd).isDirectory()) throw failure(); return originalFsync(fd) })
  const result = writeProjectAtomic(root, '{"name":"new"}\n')
  assert.deepEqual(result, { directorySynced: false, warningCode: 'EIO' })
  assert.equal(saved(file).name, 'new')
})

for (const type of ['file', 'root']) {
  test(`rejects ${type} symlink without changing target`, t => {
    const { root, file } = fixture(t), outside = path.join(root, 'outside.json')
    originalWrite(outside, '{"outside":true}')
    const before = fs.readFileSync(outside)
    if (type === 'file') { fs.unlinkSync(file); fs.symlinkSync(outside, file); assert.throws(() => writeProjectAtomic(root, '{}')) }
    else { const link = path.join(root, 'linked-root'); fs.symlinkSync(root, link); assert.throws(() => writeProjectAtomic(link, '{}')) }
    assert.deepEqual(fs.readFileSync(outside), before)
  })
}

test('rejects hard-linked target without replacing either name', t => {
  const { root, file } = fixture(t), link = path.join(root, 'copy.json'); fs.linkSync(file, link)
  assert.throws(() => writeProjectAtomic(root, '{}'))
  assert.equal(saved(file).name, 'old'); assert.equal(saved(link).name, 'old')
})

test('rejects project target directory', t => {
  const { root, file } = fixture(t); fs.unlinkSync(file); fs.mkdirSync(file)
  assert.throws(() => writeProjectAtomic(root, '{}'))
  assert.ok(fs.statSync(file).isDirectory())
})

test('observed concurrent target replacement aborts without overwriting external edits', t => {
  const { root, file } = fixture(t)
  t.mock.method(fs, 'fsyncSync', fd => { originalFsync(fd); if (fs.fstatSync(fd).isFile()) { const other = path.join(root, 'external.tmp'); originalWrite(other, '{"name":"external"}'); originalRename(other, file) } })
  assert.throws(() => writeProjectAtomic(root, '{"name":"new"}'))
  assert.equal(saved(file).name, 'external')
  assert.deepEqual(fs.readdirSync(root), ['reel.project.json'])
})

test('observed target link swap aborts without writing outside project', t => {
  const { root, file } = fixture(t), outside = path.join(root, 'outside.json'); originalWrite(outside, '{"outside":true}')
  t.mock.method(fs, 'fsyncSync', fd => { originalFsync(fd); if (fs.fstatSync(fd).isFile()) { fs.unlinkSync(file); fs.symlinkSync(outside, file) } })
  assert.throws(() => writeProjectAtomic(root, '{"name":"new"}'))
  assert.deepEqual(saved(outside), { outside: true })
})

test('browser failed commit preserves version, epoch, last text, history and all events', t => {
  const { root } = fixture(t), state = server(root, () => { throw failure() })
  state.future.push({ name: 'redo' })
  const before = JSON.stringify({ project: state.project, version: state.version, projectEpoch: state.projectEpoch, lastText: state.lastText, past: state.past, future: state.future })
  assert.throws(() => state.commit({ name: 'new' }, 'you', ['new'], { projectChanged: true }))
  assert.equal(JSON.stringify({ project: state.project, version: state.version, projectEpoch: state.projectEpoch, lastText: state.lastText, past: state.past, future: state.future }), before)
  assert.equal(state.events.length, 0); assert.equal(state.lines.length, 0)
})

test('browser retries failed save and publishes one version with one history entry', t => {
  const { root, file } = fixture(t); let fail = true
  const state = server(root, (...args) => { if (fail) throw failure(); return writeProjectAtomic(...args) })
  assert.throws(() => state.commit({ name: 'new' }, 'you', ['new']))
  fail = false; state.commit({ name: 'new' }, 'you', ['new'])
  assert.equal(state.version, 2); assert.equal(state.past.length, 1); assert.equal(saved(file).name, 'new')
  assert.equal(state.lastText, fs.readFileSync(file, 'utf8')); assert.equal(state.events.length, 1)
})

for (const route of ['undo', 'redo']) {
  test(`browser failed ${route} preserves both stacks and current project`, t => {
    const { root } = fixture(t), state = server(root, () => { throw failure() })
    state.past.push({ name: 'previous' }); state.future.push({ name: 'later' })
    const before = JSON.stringify({ project: state.project, version: state.version, past: state.past, future: state.future })
    assert.throws(() => state[route]())
    assert.equal(JSON.stringify({ project: state.project, version: state.version, past: state.past, future: state.future }), before)
  })
}

test('250 external edits retain exactly 200 undos, preserve latest entries and clear redo on branch', t => {
  const { root, file } = fixture(t), state = server(root)
  for (let i = 1; i <= 250; i++) { originalWrite(file, JSON.stringify({ name: String(i) })); state.loadFromDisk() }
  assert.equal(state.past.length, 200); assert.equal(state.past[0].name, '50')
  for (let i = 0; i < 200; i++) state.undo()
  assert.equal(state.project.name, '50'); const version = state.version; state.undo(); assert.equal(state.version, version)
  for (let i = 0; i < 200; i++) state.redo()
  assert.equal(state.project.name, '250'); assert.equal(state.past.length, 200)
  state.undo(); state.commit({ name: 'branch' }, 'you', [])
  assert.equal(state.future.length, 0); assert.equal(state.past.length, 200)
})

test('unchanged and malformed external JSON do not consume history or version', t => {
  const { root, file } = fixture(t), state = server(root), version = state.version
  state.loadFromDisk(); originalWrite(file, '{partial'); state.loadFromDisk()
  assert.equal(state.version, version); assert.equal(state.past.length, 0); assert.equal(state.project.name, 'old')
})

test('assistant identity and version change only after successful publication', t => {
  const { root } = fixture(t); let fail = true; const accepted = []
  const state = server(root, (...args) => { if (fail) throw failure(); return writeProjectAtomic(...args) })
  const call = { version: state.version, assertCurrent() {}, acceptIdentity(epoch) { accepted.push(epoch) } }
  state.assistantCalls.getStore = () => call
  assert.throws(() => state.commit({ name: 'agent' }, 'you', [], { projectChanged: true }))
  assert.equal(call.version, 1); assert.equal(accepted.length, 0)
  fail = false; state.commit({ name: 'agent' }, 'you', [], { projectChanged: true })
  assert.equal(call.version, 2); assert.deepEqual(accepted, [2]); assert.equal(state.events[0][1].who, 'agent')
})

for (const stage of ['partial-write', 'file-flush', 'replacement']) {
  test(`fixture subprocess exits at ${stage} and leaves a complete live project`, t => {
    const { root, file } = fixture(t)
    const script = `
      import fs from 'node:fs';
      import { writeProjectAtomic } from ${JSON.stringify(new URL('./support/trusted-fixture-writer.mjs', import.meta.url).href)};
      const stage = process.argv[1], root = process.argv[2];
      if (stage === 'partial-write') {
        fs.writeFileSync = (fd) => { fs.writeSync(fd, '{"partial":'); process.exit(73) };
      } else if (stage === 'file-flush') {
        const original = fs.fsyncSync;
        fs.fsyncSync = fd => { original(fd); if (fs.fstatSync(fd).isFile()) process.exit(73) };
      } else {
        const original = fs.renameSync;
        fs.renameSync = (...args) => { original(...args); process.exit(73) };
      }
      writeProjectAtomic(root, '{"name":"new"}\\n');
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, stage, root], { encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 73, child.stderr)
    assert.equal(saved(file).name, stage === 'replacement' ? 'new' : 'old')
  })
}

test('observed project root replacement aborts without publishing into its link target', t => {
  const { root: outer } = fixture(t), root = path.join(outer, 'project'), moved = path.join(outer, 'moved'), outside = path.join(outer, 'outside')
  fs.mkdirSync(root); fs.mkdirSync(outside); originalWrite(path.join(root, 'reel.project.json'), '{"name":"old"}')
  originalWrite(path.join(outside, 'reel.project.json'), '{"name":"outside"}')
  t.mock.method(fs, 'fsyncSync', fd => { originalFsync(fd); if (fs.fstatSync(fd).isFile()) { originalRename(root, moved); fs.symlinkSync(outside, root) } })
  assert.throws(() => writeProjectAtomic(root, '{"name":"new"}'))
  assert.equal(saved(path.join(outside, 'reel.project.json')).name, 'outside')
  assert.equal(saved(path.join(moved, 'reel.project.json')).name, 'old')
})


test('read-only target stays read-only and unchanged', t => {
  if (process.getuid?.() === 0) { t.skip('Superuser bypasses target write permission checks'); return }
  const { root, file } = fixture(t); fs.chmodSync(file, 0o440)
  assert.throws(() => writeProjectAtomic(root, '{"name":"new"}'))
  assert.equal(saved(file).name, 'old'); assert.equal(fs.statSync(file).mode & 0o777, 0o440)
  assert.deepEqual(fs.readdirSync(root), ['reel.project.json'])
})

test('directory flush warning leaves browser version and in-memory text matching published project', t => {
  const { root, file } = fixture(t), state = server(root)
  t.mock.method(fs, 'fsyncSync', fd => { if (fs.fstatSync(fd).isDirectory()) throw failure(); return originalFsync(fd) })
  state.commit({ name: 'new' }, 'you', [])
  assert.equal(state.version, 2); assert.equal(state.project.name, 'new')
  assert.equal(state.lastText, fs.readFileSync(file, 'utf8')); assert.equal(state.warnings.length, 1)
})


test('asset refresh persists successfully before updating memory and version', async t => {
  const { root, file } = fixture(t); originalWrite(file, JSON.stringify({ name: 'old', assets: { 'clip.mp4': { duration: 2 } } }))
  const state = server(root); await state.refreshAssets()
  assert.equal(saved(file).assets['clip.mp4'].codec, 'test-codec'); assert.equal(state.project.assets['clip.mp4'].codec, 'test-codec')
  assert.equal(state.version, 2); assert.equal(state.past.length, 0); assert.equal(state.events.length, 1)
})

test('asset refresh publication failure preserves prior project, version and disk', async t => {
  const { root, file } = fixture(t); originalWrite(file, JSON.stringify({ name: 'old', assets: { 'clip.mp4': { duration: 2 } } }))
  const state = server(root, () => { throw failure() }), before = fs.readFileSync(file, 'utf8')
  await assert.rejects(state.refreshAssets())
  assert.equal(state.version, 1); assert.equal(state.project.assets['clip.mp4'].codec, undefined)
  assert.equal(fs.readFileSync(file, 'utf8'), before); assert.equal(state.events.length, 0)
})

test('deferred asset refresh discards stale metadata when an edit intervenes', async t => {
  const { root, file } = fixture(t); originalWrite(file, JSON.stringify({ name: 'old', assets: { 'clip.mp4': { duration: 2 } } }))
  const state = server(root); let release
  state.probe = () => new Promise(resolve => { release = resolve })
  const refreshing = state.refreshAssets(); state.commit({ name: 'user edit', assets: {} }, 'you', [])
  release({ codec: 'stale-codec' }); await refreshing
  assert.equal(saved(file).name, 'user edit'); assert.equal(state.project.name, 'user edit'); assert.equal(state.version, 2)
})

for (const move of ['undo', 'redo']) {
  test(`throwing SSE subscriber does not interrupt ${move} history finalization`, t => {
    const { root, file } = fixture(t), state = server(root)
    state.commit({ name: 'new' }, 'you', []); if (move === 'redo') state.undo()
    const dead = { res: { write() { throw failure('EPIPE') } } }; state.clients.add(dead)
    const version = state.version; state[move]()
    assert.equal(state.version, version + 1); assert.equal(state.clients.has(dead), false)
    assert.equal(saved(file).name, move === 'undo' ? 'old' : 'new')
    assert.equal(state.project.name, saved(file).name)
    assert.equal(state.past.length, move === 'undo' ? 0 : 1); assert.equal(state.future.length, move === 'undo' ? 1 : 0)
    if (move === 'undo') { const v = state.version; state.undo(); assert.equal(state.version, v) }
  })
}


for (const move of ['undo', 'redo']) {
  test(`throwing notification function cannot turn a published ${move} into a failed request`, t => {
    const { root, file } = fixture(t), state = server(root)
    state.commit({ name: 'new' }, 'you', []); if (move === 'redo') state.undo()
    state.broadcast = () => { throw failure('EPIPE') }
    const version = state.version; assert.doesNotThrow(() => state[move]())
    assert.equal(state.version, version + 1); assert.equal(state.project.name, saved(file).name)
    assert.equal(state.past.length, move === 'undo' ? 0 : 1); assert.equal(state.future.length, move === 'undo' ? 1 : 0)
  })
}
