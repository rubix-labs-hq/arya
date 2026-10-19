import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createProjectWriter } from '../core/project-persistence.mjs'
const INFO = { stdout: '{"ok":true,"protocol":1,"testHooks":false,"platform":"darwin","metadata":"acl-xattr-mode-owner-group","publicationLock":"recovery-flock-v1","expectedIdentity":"main-device-inode-v1"}' }
const hash = text => createHash('sha256').update(text).digest('hex')
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-writer-protocol-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'reel.project.json'), 'old')
  const binary = path.join(root, 'fixture-binary'); fs.writeFileSync(binary, 'fixture-only', { mode: 0o700 })
  return { root, binary, sha256: hash('fixture-only'), platform: 'darwin' }
}
test('unprepared default helper fails closed without writing', t => {
  const { root } = fixture(t); fs.unlinkSync(path.join(root, 'reel.project.json')); assert.throws(() => createProjectWriter({ coreDirectory: path.join(root, 'unprepared') })(root, '{}', null), /helper preparation|unsupported platform/)
  assert.ok(!fs.existsSync(path.join(root, 'reel.project.json')))
})
test('verifies helper bytes before transport and passes selected directory identity and exact snapshots', t => {
  const config = fixture(t); let called = false
  const writer = createProjectWriter({ ...config, run(binary, args, options) {
    if (args[0] === 'info') return INFO
    called = true; assert.equal(binary, fs.realpathSync(config.binary))
    assert.equal(fs.readFileSync(binary, 'utf8'), 'fixture-only')
    assert.equal(args[0], 'write'); assert.equal(args[1], fs.realpathSync(config.root))
    const bytes = options.input, st = fs.statSync(config.root, { bigint: true })
    assert.equal(bytes.readBigUInt64BE(0), st.dev); assert.equal(bytes.readBigUInt64BE(8), st.ino)
    assert.equal(bytes.readBigUInt64BE(16), 3n); assert.equal(bytes.readBigUInt64BE(24), 3n)
    const main = fs.statSync(path.join(config.root, 'reel.project.json'), { bigint: true })
    assert.equal(bytes.readBigUInt64BE(32), main.dev); assert.equal(bytes.readBigUInt64BE(40), main.ino)
    assert.equal(bytes.subarray(48).toString(), 'newold')
    return { status: 0, stdout: '{"ok":true,"protocol":1,"testHooks":false,"directorySynced":true,"errno":0}' }
  } })
  assert.deepEqual(writer(config.root, 'new', 'old'), { directorySynced: true }); assert.ok(called)
})
test('modified helper cannot reach transport', t => {
  const config = fixture(t); fs.appendFileSync(config.binary, 'modified'); let called = false
  const writer = createProjectWriter({ ...config, run() { called = true } })
  assert.throws(() => writer(config.root, '{}', null)); assert.equal(called, false)
})
test('missing receipt after helper exit recovers a confirmed publication by descriptor-relative inspection', t => {
  const config = fixture(t), commands = []
  const writer = createProjectWriter({ ...config, run(binary, args, options) {
    if (args[0] === 'info') return INFO
    commands.push(args[0]); return args[0] === 'write' ? { status: 73, stdout: '' } : { status: 0, stdout: JSON.stringify({ ok: true, protocol: 1, testHooks: false, sha256: hash('new') }) }
  } })
  assert.deepEqual(writer(config.root, 'new', 'old'), { directorySynced: false, warningCode: 'RECEIPT_RECOVERED' })
  assert.deepEqual(commands, ['write', 'inspect'])
})
test('failed helper metadata operation is a redacted error without a recovery publication claim', t => {
  const config = fixture(t); let count = 0
  const writer = createProjectWriter({ ...config, run(binary,args) { if (args[0] === 'info') return INFO; count++; return { status: 1, stdout: '{"ok":false,"stage":"metadata","errno":13}', stderr: 'sensitive path ignored' } } })
  assert.throws(() => writer(config.root, 'new', 'old'), error => error.code === 'ARYA_SAVE_FAILED' && error.message === 'Project save failed during metadata')
  assert.equal(count, 1)
})
test('unconfirmed publication stays an error and cannot infer success from provider stderr', t => {
  const config = fixture(t)
  const writer = createProjectWriter({ ...config, run(binary, args) { if (args[0] === 'info') return INFO; return args[0] === 'write' ? { status: null, stdout: '', stderr: 'success!' } : { status: 0, stdout: JSON.stringify({ ok: true, protocol: 1, testHooks: false, sha256: hash('other') }) } } })
  assert.throws(() => writer(config.root, 'new', 'old'), /unconfirmed publication/)
})
test('new project uses missing-file sentinel and rejects absent snapshot arguments', t => {
  const config = fixture(t); fs.unlinkSync(path.join(config.root, 'reel.project.json'))
  const writer = createProjectWriter({ ...config, run(binary, args, options) { if (args[0] === 'info') return INFO; assert.equal(options.input.readBigUInt64BE(24), 0xffffffffffffffffn); assert.equal(options.input.readBigUInt64BE(32), 0xffffffffffffffffn); assert.equal(options.input.readBigUInt64BE(40), 0xffffffffffffffffn); return { stdout: '{"ok":true,"protocol":1,"testHooks":false,"directorySynced":true,"errno":0}' } } })
  assert.deepEqual(writer(config.root, '{}', null), { directorySynced: true })
  assert.throws(() => writer(config.root, '{}'), /missing expected/)
})


test('test-hook-enabled binary is rejected before any write request', t => {
  const config = fixture(t), commands = []
  const writer = createProjectWriter({ ...config, run(binary,args) { commands.push(args[0]); return { stdout: '{"ok":true,"protocol":1,"testHooks":true,"platform":"darwin","metadata":"acl-xattr-mode-owner-group","publicationLock":"recovery-flock-v1","expectedIdentity":"main-device-inode-v1"}' } } })
  assert.throws(() => writer(config.root, '{}', null), /helper capabilities/)
  assert.deepEqual(commands, ['info'])
})

test('legacy helper without the shared publication lock is rejected before write', t => {
  const config = fixture(t), commands = []
  const writer = createProjectWriter({ ...config, run(binary, args) { commands.push(args[0]); return { stdout: JSON.stringify({ ok: true, protocol: 1, testHooks: false, platform: 'darwin', metadata: 'acl-xattr-mode-owner-group' }) } } })
  assert.throws(() => writer(config.root, '{}', null), /helper capabilities/)
  assert.deepEqual(commands, ['info'])
})

test('busy shared publication lock fails without claiming a save or inspecting a candidate', t => {
  const config = fixture(t), commands = []
  const writer = createProjectWriter({ ...config, run(binary, args) { commands.push(args[0]); return args[0] === 'info' ? INFO : { status: 1, stdout: JSON.stringify({ ok: false, stage: 'lock', errno: 35 }) } } })
  assert.throws(() => writer(config.root, '{}', null), /during lock/)
  assert.deepEqual(commands, ['info', 'write'])
})

test('an explicit earlier main inode is transported unchanged after a same-bytes replacement', t => {
  const config = fixture(t), file = path.join(config.root, 'reel.project.json'), observed = fs.statSync(file, { bigint: true })
  const replacement = path.join(config.root, 'replacement'); fs.writeFileSync(replacement, 'old'); fs.renameSync(replacement, file)
  let attempted = false
  const writer = createProjectWriter({ ...config, run(binary, args, options) {
    if (args[0] === 'info') return INFO
    attempted = true
    assert.equal(options.input.readBigUInt64BE(32), observed.dev); assert.equal(options.input.readBigUInt64BE(40), observed.ino)
    assert.notEqual(options.input.readBigUInt64BE(40), fs.statSync(file, { bigint: true }).ino)
    return { stdout: JSON.stringify({ ok: false, stage: 'target', errno: 22 }) }
  } })
  assert.throws(() => writer(config.root, 'new', 'old', { device: String(observed.dev), inode: String(observed.ino) }), /during target/)
  assert.equal(attempted, true); assert.equal(fs.readFileSync(file, 'utf8'), 'old')
})

test('malformed explicit identity cannot enter the transport', t => {
  const config = fixture(t); let called = false
  const writer = createProjectWriter({ ...config, run() { called = true } })
  for (const identity of [null, { device: '-1', inode: '1' }, { device: '1', inode: '18446744073709551615' }]) assert.throws(() => writer(config.root, 'new', 'old', identity), /target identity/)
  assert.equal(called, false)
})
