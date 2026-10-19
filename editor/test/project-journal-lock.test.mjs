import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { JOURNAL_DEPENDENCIES } from '../core/project-writer-manifest.mjs'
import { ProjectRecovery, RECOVERY_LIMITS } from '../core/project-recovery.mjs'
import { decodeJournalPacket, encodeJournalPacket } from '../core/recovery-journal-packet.mjs'

// Root supplies both binaries built from this exact C candidate. No fixture compiles them.
const production = process.env.ARYA_LOCK_PRODUCTION_BINARY, testing = process.env.ARYA_LOCK_TEST_BINARY
const enabled = Boolean(production && testing), core = fileURLToPath(new URL('../core/', import.meta.url))
const script = path.join(core, 'project-recovery-journal.mjs'), node = fs.realpathSync(process.execPath)
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes }
function folder(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-journal-flock-')))
  fs.writeFileSync(path.join(root, 'reel.project.json'), 'old')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function journalInput(root, operation, texts) {
  const ids = [fs.statSync(root, { bigint: true }), fs.statSync(node, { bigint: true }), fs.statSync(script, { bigint: true })]
  return Buffer.concat([...ids.flatMap(st => [u64(st.dev), u64(st.ino)]), createHash('sha256').update(fs.readFileSync(script)).digest(), encodeJournalPacket({ ...operation, trustedDependencies: JOURNAL_DEPENDENCIES }, texts)])
}
function writeInput(root, next, previous) {
  const st = fs.statSync(root, { bigint: true }), main = fs.statSync(path.join(root, 'reel.project.json'), { bigint: true })
  return Buffer.concat([u64(st.dev), u64(st.ino), u64(Buffer.byteLength(next)), u64(Buffer.byteLength(previous)), u64(main.dev), u64(main.ino), Buffer.from(next), Buffer.from(previous)])
}
function journal(root, operation, texts) {
  return spawnSync(production, ['journal-exec', root, node, script], { input: journalInput(root, operation, texts), timeout: 5000 })
}
async function held(t, root, mode) {
  const ready = path.join(root, 'ready'), release = path.join(root, 'release')
  const args = mode === 'journal' ? ['journal-exec', root, node, script] : ['write', root]
  const input = mode === 'journal' ? journalInput(root, { operation: 'capture', phase: 'published' }, ['{"name":"journal"}']) : writeInput(root, 'winner', 'old')
  const child = spawn(testing, args, { env: { ...process.env, ARYA_TEST_FAULT: 'lock-hold', ARYA_TEST_LOCK_READY: ready, ARYA_TEST_LOCK_RELEASE: release } })
  t.after(() => child.kill('SIGKILL'))
  const chunks = []; child.stdout.on('data', bytes => chunks.push(bytes))
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout: Buffer.concat(chunks) })) })
  child.stdin.end(input)
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(fs.existsSync(ready), 'The helper did not acquire the common lock')
  return { release: () => fs.writeFileSync(release, ''), done }
}

test('actual C journal lock excludes main publication until its Node child exits', { skip: !enabled }, async t => {
  const root = folder(t), first = await held(t, root, 'journal')
  const busy = spawnSync(production, ['write', root], { input: writeInput(root, 'candidate', 'old'), encoding: 'utf8', timeout: 5000 })
  assert.equal(JSON.parse(busy.stdout).stage, 'lock'); assert.equal(JSON.parse(busy.stdout).ok, false)
  first.release(); const done = await first.done
  assert.equal(decodeJournalPacket(done.stdout).metadata.ok, true)
  const winner = spawnSync(production, ['write', root], { input: writeInput(root, 'candidate', 'old'), encoding: 'utf8', timeout: 5000 })
  assert.equal(JSON.parse(winner.stdout).ok, true)
  assert.equal(fs.readFileSync(path.join(root, 'reel.project.json'), 'utf8'), 'candidate')
})

test('actual main writer lock excludes snapshot mutation until publication and directory sync finish', { skip: !enabled }, async t => {
  const root = folder(t), first = await held(t, root, 'write')
  const busy = journal(root, { operation: 'capture', phase: 'published' }, ['{}'])
  assert.equal(JSON.parse(busy.stdout).stage, 'lock')
  assert.equal(fs.existsSync(path.join(root, '.reel/recovery/project-identity.json')), false)
  first.release(); assert.equal(JSON.parse((await first.done).stdout).ok, true)
  assert.equal(decodeJournalPacket(journal(root, { operation: 'capture', phase: 'published' }, ['{}']).stdout).metadata.ok, true)
})

test('displacing the journal lock after flock prevents the child from mutating snapshots', { skip: !enabled }, async t => {
  const root = folder(t), first = await held(t, root, 'journal'), lock = path.join(root, '.reel/recovery/project-write.lock')
  fs.renameSync(lock, `${lock}.old`); fs.writeFileSync(lock, '', { flag: 'wx', mode: 0o600 })
  first.release(); assert.equal(JSON.parse((await first.done).stdout).ok, false)
  assert.equal(fs.existsSync(path.join(root, '.reel/recovery/project-identity.json')), false)
})

test('a recovery directory with an extended inherited ACL fails before populated journal files exist', { skip: !enabled }, t => {
  const root = folder(t), directory = path.join(root, '.reel/recovery'); fs.mkdirSync(directory, { recursive: true })
  const result = spawnSync('/bin/chmod', ['+a', 'everyone allow read,write,file_inherit', directory], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  const failed = journal(root, { operation: 'capture', phase: 'published' }, ['{}'])
  assert.equal(JSON.parse(failed.stdout).ok, false); assert.equal(JSON.parse(failed.stdout).stage, 'lock')
  assert.equal(fs.existsSync(path.join(directory, 'project-identity.json')), false)
  assert.equal(fs.readdirSync(directory).length, 0)
})

test('a recovery directory with no extended ACL permits actual journal publication', { skip: !enabled }, t => {
  const root = folder(t), directory = path.join(root, '.reel/recovery'); fs.mkdirSync(directory, { recursive: true })
  const cleared = spawnSync('/bin/chmod', ['-N', directory], { encoding: 'utf8', timeout: 5000 })
  assert.equal(cleared.status, 0, cleared.stderr)
  assert.equal(decodeJournalPacket(journal(root, { operation: 'capture', phase: 'published' }, ['{}']).stdout).metadata.ok, true)
  assert.equal(new ProjectRecovery(root).list().snapshots.length, 1)
})

test('two actual C journal actors retain a bounded published inventory and preserved-original budget', { skip: !enabled }, async t => {
  for (const phase of ['published', 'preserved-original']) {
    const root = folder(t), limits = { ...RECOVERY_LIMITS, published: 2, totalBytes: phase === 'published' ? 4096 : 2000 }
    let accepted = 0, rejected = 0
    async function actor(label) {
      for (let i = 0; i < 4; i++) {
        const text = phase === 'published' ? JSON.stringify({ name: label + i }) : label + i + 'x'.repeat(300)
        for (let retry = 0; retry < 100; retry++) {
          const child = spawn(production, ['journal-exec', root, node, script])
          const chunks = []; child.stdout.on('data', bytes => chunks.push(bytes))
          const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve(Buffer.concat(chunks))) })
          child.stdin.end(journalInput(root, { operation: 'capture', phase, limits }, [text]))
          const bytes = await done
          if (bytes[0] === 123) { assert.equal(JSON.parse(bytes).stage, 'lock'); await new Promise(resolve => setTimeout(resolve, 10)); continue }
          const response = decodeJournalPacket(bytes).metadata
          if (response.ok) accepted++; else { assert.match(response.error, /full/); rejected++ }
          break
        }
      }
    }
    await Promise.all([actor('browser-'), actor('peer-')])
    const recovery = new ProjectRecovery(root), inventory = recovery.inventory(recovery.family(false))
    assert.equal(accepted + rejected, 8); assert.ok(inventory.bytes <= limits.totalBytes)
    if (phase === 'published') { assert.equal(accepted, 8); assert.equal(inventory.records.length, 2) }
    else { assert.ok(rejected > 0); assert.equal(inventory.records.length, accepted); assert.ok(inventory.records.every(record => record.phase === 'preserved-original')) }
  }
})
