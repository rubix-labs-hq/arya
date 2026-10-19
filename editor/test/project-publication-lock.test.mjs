import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

// Root supplies disposable binaries built from this exact candidate. This fixture never compiles or installs them.
const production = process.env.ARYA_LOCK_PRODUCTION_BINARY, testing = process.env.ARYA_LOCK_TEST_BINARY
const enabled = Boolean(production && testing)
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes }
function input(root, text, previous, expectedIdentity) {
  const stat = fs.statSync(root, { bigint: true })
  const target = expectedIdentity ?? (previous === null ? null : fs.statSync(path.join(root, 'reel.project.json'), { bigint: true }))
  return Buffer.concat([u64(stat.dev), u64(stat.ino), u64(Buffer.byteLength(text)), u64(previous === null ? 0xffffffffffffffffn : Buffer.byteLength(previous)), u64(target?.dev ?? 0xffffffffffffffffn), u64(target?.ino ?? 0xffffffffffffffffn), Buffer.from(text), ...(previous === null ? [] : [Buffer.from(previous)])])
}
function folder(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-lock-race-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'reel.project.json'), 'old')
  return root
}
const write = (root, text, previous = 'old', expectedIdentity) => spawnSync(production, ['write', root], { input: input(root, text, previous, expectedIdentity), encoding: 'utf8', timeout: 5000 })
const receipt = result => JSON.parse(result.stdout)
async function held(t, root) {
  const ready = path.join(root, 'ready'), release = path.join(root, 'release')
  const child = spawn(testing, ['write', root], { env: { ...process.env, ARYA_TEST_FAULT: 'lock-hold', ARYA_TEST_LOCK_READY: ready, ARYA_TEST_LOCK_RELEASE: release } })
  t.after(() => child.kill('SIGKILL'))
  let stdout = ''; child.stdout.on('data', bytes => { stdout += bytes })
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout })) })
  child.stdin.end(input(root, 'winner', 'old'))
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(fs.existsSync(ready), 'The first writer did not acquire the lock')
  return { release: () => fs.writeFileSync(release, ''), done }
}

test('shared lock excludes a second writer, then rejects its stale expected bytes after release', { skip: !enabled }, async t => {
  const root = folder(t), first = await held(t, root), busy = receipt(write(root, 'loser'))
  assert.equal(busy.ok, false); assert.equal(busy.stage, 'lock')
  assert.equal(fs.readFileSync(path.join(root, 'reel.project.json'), 'utf8'), 'old')
  first.release(); const finished = await first.done
  assert.equal(receipt(finished).ok, true)
  const stale = receipt(write(root, 'loser'))
  assert.equal(stale.ok, false); assert.equal(stale.stage, 'target')
  assert.equal(fs.readFileSync(path.join(root, 'reel.project.json'), 'utf8'), 'winner')
  assert.equal(fs.statSync(path.join(root, '.reel/recovery/project-write.lock')).size, 0)
})

test('displacing the held lock inode prevents publication', { skip: !enabled }, async t => {
  const root = folder(t), first = await held(t, root), lock = path.join(root, '.reel/recovery/project-write.lock')
  fs.renameSync(lock, `${lock}.retained`); fs.writeFileSync(lock, '', { flag: 'wx', mode: 0o600 })
  first.release(); const finished = await first.done
  assert.equal(receipt(finished).ok, false)
  assert.equal(fs.readFileSync(path.join(root, 'reel.project.json'), 'utf8'), 'old')
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.reel-project-')), false)
})

test('symlink, hardlinked and nonempty publication locks cannot reach publication', { skip: !enabled }, t => {
  for (const kind of ['symlink', 'hardlink', 'nonempty']) {
    const root = folder(t), directory = path.join(root, '.reel/recovery'), lock = path.join(directory, 'project-write.lock'), target = path.join(root, 'foreign')
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(target, '')
    if (kind === 'symlink') fs.symlinkSync(target, lock)
    if (kind === 'hardlink') fs.linkSync(target, lock)
    if (kind === 'nonempty') fs.writeFileSync(lock, 'owned elsewhere')
    assert.equal(receipt(write(root, 'candidate')).ok, false)
    assert.equal(fs.readFileSync(path.join(root, 'reel.project.json'), 'utf8'), 'old')
    assert.equal(fs.readFileSync(target, 'utf8'), '')
  }
})

test('same bytes in a replacement inode cannot satisfy an earlier observed publication identity', { skip: !enabled }, t => {
  const root = folder(t), file = path.join(root, 'reel.project.json'), observed = fs.statSync(file, { bigint: true }), replacement = path.join(root, 'same-bytes')
  fs.writeFileSync(replacement, 'old'); fs.renameSync(replacement, file)
  const failed = receipt(write(root, 'candidate', 'old', observed))
  assert.equal(failed.ok, false); assert.equal(failed.stage, 'target')
  assert.equal(fs.readFileSync(file, 'utf8'), 'old')
})

test('validated temporary content, size, mode and link changes fail before replacement', { skip: !enabled }, t => {
  for (const fault of ['temp-byte-swap', 'temp-append', 'temp-mode-swap', 'temp-link']) {
    const root = folder(t)
    const failed = spawnSync(testing, ['write', root], { input: input(root, 'candidate', 'old'), encoding: 'utf8', timeout: 5000,
      env: { ...process.env, ARYA_TEST_FAULT: fault } })
    assert.equal(receipt(failed).ok, false)
    assert.equal(fs.readFileSync(path.join(root, 'reel.project.json'), 'utf8'), 'old')
    assert.equal(fs.readdirSync(root).some(name => name.startsWith('.reel-project-')), false)
  }
})
