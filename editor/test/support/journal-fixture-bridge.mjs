import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRecoveryJournal } from '../../core/project-persistence.mjs'
import { CAPABILITY } from '../../core/project-writer-manifest.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => a.dev === b.dev && a.ino === b.ino

// This gate replaces flock only in fixtures. The journal child and its filesystem operations are real.
export function fixtureJournal(binary, script, hook = () => {}) {
  return createRecoveryJournal({ binary, sha256: hash(fs.readFileSync(binary)), platform: 'darwin', script,
    scriptSHA256: hash(fs.readFileSync(script)), run(executable, args, options) {
      if (args[0] === 'info') return { stdout: JSON.stringify(CAPABILITY), status: 0 }
      assert.ok(['journal-exec', 'journal-exec-drafts'].includes(args[0]))
      const root = args[1], node = args[2], source = args[3], input = options.input
      const ids = [fs.statSync(root, { bigint: true }), fs.statSync(node, { bigint: true }), fs.statSync(source, { bigint: true })]
      for (let i = 0; i < ids.length; i++) {
        assert.equal(input.readBigUInt64BE(i * 16), ids[i].dev)
        assert.equal(input.readBigUInt64BE(i * 16 + 8), ids[i].ino)
      }
      assert.equal(input.subarray(48, 80).toString('hex'), hash(fs.readFileSync(source)))
      const gate = path.join(root, '.fixture-journal-gate')
      let ownedGate, gateFD
      for (let n = 0; n < 500; n++) {
        try { gateFD = fs.openSync(gate, 'wx', 0o600); ownedGate = fs.fstatSync(gateFD); break }
        catch (error) { if (error.code !== 'EEXIST') throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5) }
      }
      assert.ok(ownedGate, 'The injected serialization gate timed out')
      let lockFD, draftFD, stageFD, stageFile, ownedStage
      try {
        const directory = path.join(root, '.reel/recovery'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
        lockFD = fs.openSync(path.join(directory, 'project-write.lock'), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
        assert.equal(fs.fstatSync(lockFD).size, 0)
        let stageArgs = [], inherited = [lockFD]
        if (args[0] === 'journal-exec-drafts') {
          const draftDirectory = path.join(root, '.reel/transcript-drafts'); fs.mkdirSync(draftDirectory, { recursive: true, mode: 0o700 })
          assert.ok(fs.readdirSync(draftDirectory).length <= 62)
          const name = `draft-${randomUUID().replaceAll('-', '')}.part`; stageFile = path.join(draftDirectory, name)
          draftFD = fs.openSync(draftDirectory, 'r'); stageFD = fs.openSync(stageFile, 'wx+', 0o600); ownedStage = fs.fstatSync(stageFD, { bigint: true })
          const snapshot = { device: String(ownedStage.dev), inode: String(ownedStage.ino), mode: String(ownedStage.mode), uid: String(ownedStage.uid), gid: String(ownedStage.gid), mtimeSec: String(ownedStage.mtimeNs / 1000000000n), mtimeNsec: String(ownedStage.mtimeNs % 1000000000n), ctimeSec: String(ownedStage.ctimeNs / 1000000000n), ctimeNsec: String(ownedStage.ctimeNs % 1000000000n) }
          stageArgs = ['4', '5', name, JSON.stringify(snapshot)]; inherited.push(draftFD, stageFD)
        }
        const transport = { root, node, script: source, lockFD, stageFD, stageFile, input: input.subarray(80), expectedRootIdentity: ids[0] }
        hook(transport)
        return spawnSync(node, [source, root, '3', String(transport.expectedRootIdentity.dev), String(transport.expectedRootIdentity.ino), ...stageArgs], {
          input: transport.input, maxBuffer: options.maxBuffer, timeout: 5000,
          env: options.env, stdio: ['pipe', 'pipe', 'pipe', ...inherited]
        })
      } finally {
        if (lockFD !== undefined) fs.closeSync(lockFD)
        if (stageFD !== undefined) fs.closeSync(stageFD)
        if (draftFD !== undefined) fs.closeSync(draftFD)
        try { if (ownedStage && same(ownedStage, fs.lstatSync(stageFile, { bigint: true }))) fs.unlinkSync(stageFile) } catch {}
        fs.closeSync(gateFD)
        if (same(ownedGate, fs.lstatSync(gate))) fs.unlinkSync(gate)
      }
    } })
}
