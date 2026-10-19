import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { ProjectRecovery, RECOVERY_LIMITS } from '../core/project-recovery.mjs'
import { encodeJournalPacket } from '../core/recovery-journal-packet.mjs'
import { fixtureJournal } from './support/journal-fixture-bridge.mjs'

const core = fileURLToPath(new URL('../core/', import.meta.url))
function folder(t, hook) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-journal-node-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'reel.project.json'), '{"name":"main"}')
  const binary = path.join(root, 'fixture-helper'); fs.writeFileSync(binary, 'fixture-only', { mode: 0o700 })
  const journal = fixtureJournal(binary, path.join(core, 'project-recovery-journal.mjs'), hook)
  return { root, binary, journal, recovery: new ProjectRecovery(root, { journal }) }
}

test('actual journal child publishes exact bytes and returns an identity-bound restore packet', t => {
  const { root, recovery } = folder(t), original = '{"name":"exact", "unknown":{"x":1}}\n'
  recovery.capture(original)
  const listing = recovery.list(); assert.equal(listing.snapshots.length, 1)
  fs.writeFileSync(path.join(root, 'reel.project.json'), '{corrupt')
  const prepared = recovery.prepareRestore({ snapshotID: listing.snapshots[0].id, familyID: listing.familyID, observedToken: recovery.observe().token })
  assert.equal(prepared.text, original); assert.equal(prepared.expectedText, '{corrupt')
  assert.equal(prepared.expectedIdentity.inode, String(fs.statSync(path.join(root, 'reel.project.json'), { bigint: true }).ino))
  assert.equal(recovery.list().preservedOriginals, 1)
})

test('actual child rejects root identity mismatch after exec before journal writes', t => {
  const { recovery } = folder(t, state => { state.expectedRootIdentity = { ...state.expectedRootIdentity, ino: state.expectedRootIdentity.ino + 1n } })
  assert.throws(() => recovery.capture('{}'), /folder changed before journal execution/)
  assert.equal(fs.existsSync(path.join(recovery.directory, 'project-identity.json')), false)
})

test('actual child rejects a displaced retained lock before journal writes', t => {
  const { recovery } = folder(t, state => {
    const file = path.join(state.root, '.reel/recovery/project-write.lock')
    fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
  })
  assert.throws(() => recovery.capture('{}'), /publication lock changed/)
  assert.equal(fs.existsSync(path.join(recovery.directory, 'project-identity.json')), false)
})

test('actual child rejects malformed, oversized and trailing request packets without publication', t => {
  for (const input of [Buffer.alloc(8, 255), Buffer.concat([encodeJournalPacket({ operation: 'family' }), Buffer.from([1])]), encodeJournalPacket({ operation: 'unknown' })]) {
    const { recovery } = folder(t, state => { state.input = input })
    assert.throws(() => recovery.capture('{}'), /journal/i)
    assert.equal(fs.existsSync(path.join(recovery.directory, 'project-identity.json')), false)
  }
})

test('dependency replacement after parent verification cannot run in the actual child', t => {
  const { root, binary } = folder(t), copied = path.join(root, 'core'); fs.mkdirSync(copied)
  for (const name of ['project-recovery-journal.mjs', 'project-recovery.mjs', 'output-path.js', 'native-recovery-policy.js', 'transcript-draft-store.mjs']) fs.copyFileSync(path.join(core, name), path.join(copied, name))
  const journal = fixtureJournal(binary, path.join(copied, 'project-recovery-journal.mjs'), () => {
    fs.appendFileSync(path.join(copied, 'native-recovery-policy.js'), '\nthrow new Error("UNTRUSTED MODULE RAN")\n')
  })
  assert.throws(() => new ProjectRecovery(root, { journal }).capture('{}'), /Journal dependency changed/)
  assert.equal(fs.existsSync(path.join(root, '.reel/recovery/project-identity.json')), false)
})

async function actors(t, root, binary, phase, limits) {
  const fixture = new URL('./support/journal-fixture-bridge.mjs', import.meta.url).href
  const store = new URL('../core/project-recovery.mjs', import.meta.url).href
  const source = `import {fixtureJournal} from ${JSON.stringify(fixture)}; import {ProjectRecovery} from ${JSON.stringify(store)};
const [root,binary,script,phase,encoded,label]=process.argv.slice(1), limits=JSON.parse(encoded), recovery=new ProjectRecovery(root,{journal:fixtureJournal(binary,script),limits});
let success=0,rejected=0; for(let i=0;i<4;i++){try{recovery.capture(phase==='published'?JSON.stringify({name:label+i}):label+i+'x'.repeat(300),phase);success++}catch(e){if(!/full/.test(e.message))throw e;rejected++}} process.stdout.write(JSON.stringify({success,rejected}));`
  const started = ['A', 'B'].map(label => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, binary, path.join(core, 'project-recovery-journal.mjs'), phase, JSON.stringify(limits), label])
    t.after(() => child.kill('SIGKILL'))
    let output = '', error = ''; child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { error += b })
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)))
  }))
  return Promise.all(started)
}

test('two actual Node journal actors share the injected gate and bounded published retention', async t => {
  const { root, binary } = folder(t), limits = { ...RECOVERY_LIMITS, published: 2, totalBytes: 4096 }
  const results = await actors(t, root, binary, 'published', limits)
  const recovery = new ProjectRecovery(root), inventory = recovery.inventory(recovery.family(false))
  assert.equal(results.reduce((n, r) => n + r.success, 0), 8)
  assert.equal(inventory.records.length, 2); assert.ok(inventory.bytes <= limits.totalBytes)
})

test('two actual Node journal actors preserve originals and reject a shared full byte budget', async t => {
  const { root, binary } = folder(t), limits = { ...RECOVERY_LIMITS, totalBytes: 2000 }
  const results = await actors(t, root, binary, 'preserved-original', limits)
  const recovery = new ProjectRecovery(root), inventory = recovery.inventory(recovery.family(false))
  const successes = results.reduce((n, r) => n + r.success, 0), rejected = results.reduce((n, r) => n + r.rejected, 0)
  assert.ok(successes > 0); assert.ok(rejected > 0)
  assert.equal(inventory.records.length, successes); assert.ok(inventory.bytes <= limits.totalBytes)
  assert.ok(inventory.records.every(record => record.phase === 'preserved-original'))
})
