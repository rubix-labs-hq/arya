import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { JOURNAL_DEPENDENCIES, JOURNAL_SHA256, loadPrepared, readRegular } from './project-writer-manifest.mjs'
import { decodeJournalPacket, encodeJournalPacket, JOURNAL_PACKET_LIMIT } from './recovery-journal-packet.mjs'
const CORE = fileURLToPath(new URL('.', import.meta.url))
const LIMIT = 64 * 1024 * 1024
const hash = value => createHash('sha256').update(value).digest('hex')
const u64 = value => { const data = Buffer.alloc(8); data.writeBigUInt64BE(BigInt(value)); return data }
const cleanFailure = stage => Object.assign(new Error(`Project save failed during ${stage}`), { code: 'ARYA_SAVE_FAILED' })

export function createProjectWriter({ binary: configuredBinary, sha256: configuredHash, coreDirectory = CORE, run = spawnSync, platform = process.platform } = {}) {
  return (root, text, expectedText, expectedIdentity) => {
    if (platform !== 'darwin') throw cleanFailure('unsupported platform')
    let binary = configuredBinary, sha256 = configuredHash
    if (binary === undefined && sha256 === undefined) {
      try { ({ binary, sha256 } = loadPrepared(coreDirectory)) } catch { throw cleanFailure('helper preparation') }
    }
    if (typeof binary !== 'string' || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw cleanFailure('helper preparation')
    if (expectedText !== null && typeof expectedText !== 'string') throw cleanFailure('missing expected project snapshot')
    let executable
    try { executable = fs.openSync(binary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK) }
    catch { throw cleanFailure('helper verification') }
    try {
      const stat = fs.fstatSync(executable)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024 || !(stat.mode & 0o111) || hash(fs.readFileSync(executable)) !== sha256) throw cleanFailure('helper verification')
    } catch { fs.closeSync(executable); throw cleanFailure('helper verification') }
    try {
    const selected = path.resolve(root), before = fs.lstatSync(selected, { bigint: true })
    if (before.isSymbolicLink() || !before.isDirectory()) throw cleanFailure('directory selection')
    const canonical = fs.realpathSync(selected)
    const identity = Buffer.concat([u64(before.dev), u64(before.ino)])
    const candidate = Buffer.from(text, 'utf8')
    if (candidate.length > LIMIT || expectedText !== null && Buffer.byteLength(expectedText, 'utf8') > LIMIT) throw cleanFailure('project size')
    const previous = expectedText === null ? null : Buffer.from(expectedText, 'utf8')
    if (expectedIdentity === undefined && expectedText !== null) {
      const observed = fs.lstatSync(path.join(canonical, 'reel.project.json'), { bigint: true })
      if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1n) throw cleanFailure('target identity')
      expectedIdentity = { device: String(observed.dev), inode: String(observed.ino) }
    }
    const identityNumber = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < 0xffffffffffffffffn
    if (expectedText === null ? expectedIdentity != null : !identityNumber(expectedIdentity?.device) || !identityNumber(expectedIdentity?.inode)) throw cleanFailure('target identity')
    const targetIdentity = expectedText === null ? Buffer.concat([u64(0xffffffffffffffffn), u64(0xffffffffffffffffn)]) : Buffer.concat([u64(expectedIdentity.device), u64(expectedIdentity.inode)])
    const input = Buffer.concat([identity, u64(candidate.length), u64(previous ? previous.length : 0xffffffffffffffffn), targetIdentity, candidate, ...(previous ? [previous] : [])])
    const executablePath = fs.realpathSync(binary)
    const preparedStat = fs.fstatSync(executable)
    const runPrepared = (args, options) => {
      const current = fs.lstatSync(executablePath)
      if (current.isSymbolicLink() || current.dev !== preparedStat.dev || current.ino !== preparedStat.ino || current.size !== preparedStat.size || current.mtimeMs !== preparedStat.mtimeMs || current.ctimeMs !== preparedStat.ctimeMs) throw cleanFailure('helper identity')
      return run(executablePath, args, options)
    }
    const options = input => ({ input, encoding: 'utf8', maxBuffer: 4096, timeout: 30000, windowsHide: true,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] })
    const decode = result => { try { return JSON.parse(result.stdout ?? '') } catch { return undefined } }
    const capability = decode(runPrepared(['info'], options(Buffer.alloc(0))))
    if (capability?.ok !== true || capability.protocol !== 1 || capability.testHooks !== false || capability.platform !== 'darwin' || capability.metadata !== 'acl-xattr-mode-owner-group' || capability.publicationLock !== 'recovery-flock-v1' || capability.expectedIdentity !== 'main-device-inode-v1') throw cleanFailure('helper capabilities')
    const result = runPrepared(['write', canonical], options(input)), receipt = decode(result)
    if (receipt?.ok === true && receipt.protocol === 1 && receipt.testHooks === false && typeof receipt.directorySynced === 'boolean' && Number.isSafeInteger(receipt.errno) && receipt.errno >= 0) {
      return { directorySynced: receipt.directorySynced, ...(receipt.directorySynced ? {} : { warningCode: `ERRNO_${receipt.errno}` }) }
    }
    // A missing receipt can follow a helper exit after replacement. Read by directory identity.
    if (!receipt || receipt.ok !== false) {
      const inspected = decode(runPrepared(['inspect', canonical], options(identity)))
      if (inspected?.ok === true && inspected.protocol === 1 && inspected.testHooks === false && inspected.sha256 === hash(candidate)) return { directorySynced: false, warningCode: 'RECEIPT_RECOVERED' }
    }
    throw cleanFailure(['input', 'directory', 'lock', 'target', 'temporary', 'write', 'metadata', 'flush', 'conflict', 'rename'].includes(receipt?.stage) ? receipt.stage : 'unconfirmed publication')
    } catch (error) { if (error.code === 'ARYA_SAVE_FAILED') throw error; throw cleanFailure('filesystem or helper transport') }
    finally { try { fs.closeSync(executable) } catch {} }
  }
}

export const writeProjectAtomic = createProjectWriter()

export function createRecoveryJournal({ binary: configuredBinary, sha256: configuredHash, coreDirectory = CORE, run = spawnSync, platform = process.platform, script = path.join(coreDirectory, 'project-recovery-journal.mjs'), scriptSHA256 = JOURNAL_SHA256 } = {}) {
  return (root, metadata, texts = []) => {
    if (platform !== 'darwin') throw cleanFailure('unsupported platform')
    let binary = configuredBinary, sha256 = configuredHash
    try {
      if (binary === undefined && sha256 === undefined) ({ binary, sha256 } = loadPrepared(coreDirectory))
      if (!/^[a-f0-9]{64}$/.test(sha256 ?? '') || hash(readRegular(binary, 32 * 1024 ** 2)) !== sha256) throw cleanFailure('helper verification')
      const helper = fs.lstatSync(binary), node = fs.realpathSync(process.execPath), nodeStat = fs.lstatSync(node, { bigint: true })
      if (!(helper.mode & 0o111) || !nodeStat.isFile() || nodeStat.nlink !== 1n) throw cleanFailure('helper verification')
      const journal = fs.realpathSync(script)
      if (journal !== path.resolve(script) || path.basename(journal) !== 'project-recovery-journal.mjs' || hash(readRegular(journal, 256 * 1024)) !== scriptSHA256) throw cleanFailure('journal verification')
      const journalStat = fs.lstatSync(journal, { bigint: true }), selected = path.resolve(root), rootStat = fs.lstatSync(selected, { bigint: true })
      for (const [name, expected] of Object.entries(JOURNAL_DEPENDENCIES)) if (hash(readRegular(path.join(path.dirname(journal), name), 256 * 1024)) !== expected) throw cleanFailure('journal dependencies')
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw cleanFailure('directory selection')
      const canonical = fs.realpathSync(selected)
      const invoke = (args, input, encoding) => {
        const current = fs.lstatSync(binary)
        if (current.dev !== helper.dev || current.ino !== helper.ino || current.size !== helper.size || current.mtimeMs !== helper.mtimeMs || current.ctimeMs !== helper.ctimeMs) throw cleanFailure('helper identity')
        return run(binary, args, { input, encoding, maxBuffer: JOURNAL_PACKET_LIMIT, timeout: 30000, windowsHide: true,
          env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] })
      }
      const capability = JSON.parse(invoke(['info'], Buffer.alloc(0), 'utf8').stdout ?? '')
      if (capability.ok !== true || capability.protocol !== 1 || capability.testHooks !== false || capability.platform !== 'darwin' || capability.publicationLock !== 'recovery-flock-v1' || capability.expectedIdentity !== 'main-device-inode-v1' || capability.journalExec !== 'recovery-flock-v1' || capability.journalPrivacy !== 'empty-directory-acl-v1' || capability.draftJournalPrivacy !== 'retained-private-stage-v1') throw cleanFailure('helper capabilities')
      const input = Buffer.concat([u64(rootStat.dev), u64(rootStat.ino), u64(nodeStat.dev), u64(nodeStat.ino), u64(journalStat.dev), u64(journalStat.ino), Buffer.from(scriptSHA256, 'hex'), encodeJournalPacket({ ...metadata, trustedDependencies: JOURNAL_DEPENDENCIES }, texts)])
      const result = invoke([metadata.operation === 'transcriptDrafts' ? 'journal-exec-drafts' : 'journal-exec', canonical, node, journal], input)
      const response = decodeJournalPacket(result.stdout)
      if (response.metadata.ok !== true) throw new Error(response.metadata.error ?? 'Recovery journal failed')
      return { result: response.metadata.result, texts: response.texts }
    } catch (error) {
      if (error.code === 'ARYA_SAVE_FAILED' || error.code === 'ARYA_RECOVERY_FAILED') throw error
      throw Object.assign(new Error(`Recovery journal failed: ${String(error.message).slice(0, 512)}`), { code: 'ARYA_RECOVERY_FAILED' })
    }
  }
}
