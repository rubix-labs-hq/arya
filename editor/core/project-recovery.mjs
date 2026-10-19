import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { guardedOutput } from './output-path.js'
import { validateRecoveryProject } from './native-recovery-policy.js'

export const RECOVERY_LIMITS = Object.freeze({ projectBytes: 64 * 1024 ** 2, totalBytes: 128 * 1024 ** 2, published: 12, files: 512 })
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const same = (a, b) => a.dev === b.dev && a.ino === b.ino
const identity = stat => ({ device: String(stat.dev), inode: String(stat.ino) })
const sameIdentity = (a, b) => a?.device === b?.device && a?.inode === b?.inode
const failure = message => Object.assign(new Error(message), { code: 'ARYA_RECOVERY_FAILED' })
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value))

export function recoveryProject(text) {
  validateRecoveryProject(text)
  return JSON.parse(text)
}

export class ProjectRecovery {
  constructor(root, { disk = fs, limits = RECOVERY_LIMITS, now = Date.now, makeID = randomUUID, journal = null, publicationLockHeld = null, expectedRootIdentity = null } = {}) {
    this.disk = disk; this.root = path.resolve(root); this.file = path.join(this.root, 'reel.project.json')
    this.directory = path.join(this.root, '.reel/recovery'); this.limits = limits; this.now = now; this.makeID = makeID
    this.rootInfo = disk.lstatSync(this.root, { bigint: true })
    if (!this.rootInfo.isDirectory() || this.rootInfo.isSymbolicLink()) throw failure('The selected project folder is unsafe')
    this.rootIdentity = identity(this.rootInfo)
    if (expectedRootIdentity && !sameIdentity(this.rootIdentity, expectedRootIdentity)) throw failure('The selected project folder changed before journal execution')
    this.warning = null
    this.journal = journal; this.publicationLockHeld = publicationLockHeld
  }

  assertJournalLock() {
    this.assertRoot()
    if (!Number.isSafeInteger(this.publicationLockHeld) || this.publicationLockHeld < 0) throw failure('Recovery journal requires the shared publication lock')
    const file = guardedOutput(this.root, path.join(this.directory, 'project-write.lock'))
    const held = this.disk.fstatSync(this.publicationLockHeld, { bigint: true }), named = this.disk.lstatSync(file, { bigint: true })
    if (!held.isFile() || !named.isFile() || named.isSymbolicLink() || held.nlink !== 1n || named.nlink !== 1n || held.size !== 0n || named.size !== 0n || !same(held, named)) throw failure('The retained recovery publication lock changed')
  }

  assertRoot() {
    const stat = this.disk.lstatSync(this.root, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(stat, this.rootInfo)) throw failure('The selected project folder changed')
  }

  read(file, maximum = this.limits.projectBytes) {
    this.assertRoot(); guardedOutput(this.root, file)
    const fd = this.disk.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      const before = this.disk.fstatSync(fd, { bigint: true })
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum) || !same(before, this.disk.lstatSync(file, { bigint: true }))) throw failure('Recovery requires a bounded regular file with one link')
      const buffer = Buffer.alloc(Number(before.size) + 1)
      let count = 0, next
      while (count < buffer.length && (next = this.disk.readSync(fd, buffer, count, buffer.length - count, null)) > 0) count += next
      const bytes = buffer.subarray(0, count), after = this.disk.fstatSync(fd, { bigint: true }), named = this.disk.lstatSync(file, { bigint: true })
      const stamp = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
      if (BigInt(count) !== before.size || stamp(before) !== stamp(after) || stamp(before) !== stamp(named)) throw failure('The recovery file changed while reading')
      this.assertRoot(); return { bytes, stat: after }
    } finally { this.disk.closeSync(fd) }
  }

  observe() {
    try {
      const { bytes, stat } = this.read(this.file), text = bytes.toString('utf8'), digest = hash(bytes)
      const token = hash(JSON.stringify({ rootIdentity: this.rootIdentity, device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode), size: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), sha256: digest }))
      let status = 'valid'
      try { if (!Buffer.from(text).equals(bytes)) throw failure('Invalid UTF-8'); recoveryProject(text) } catch { status = 'invalid' }
      return { status, text, sha256: digest, token, fileIdentity: identity(stat), writable: !!(stat.mode & 0o222n) && !!(this.disk.lstatSync(this.root, { bigint: true }).mode & 0o222n), utf8: Buffer.from(text).equals(bytes) }
    } catch (error) {
      if (error.code === 'ENOENT') {
        try { this.assertRoot(); return { status: 'missing', text: null, sha256: null, fileIdentity: null, token: hash(JSON.stringify({ rootIdentity: this.rootIdentity, missing: true })), writable: !!(this.disk.lstatSync(this.root).mode & 0o222) } } catch {}
      }
      return { status: 'unavailable', text: undefined, sha256: null, token: null, writable: false }
    }
  }

  assertExpected(expectedText, { allowInvalid = false } = {}) {
    const observed = this.observe()
    if (observed.status === 'unavailable' || !observed.utf8 && observed.status !== 'missing') throw failure('The project cannot be safely read for recovery')
    if (observed.text !== expectedText) throw failure('The project changed on disk. Refresh recovery before continuing')
    if (!observed.writable) throw failure('The project is read-only')
    if (!allowInvalid && observed.status === 'invalid') throw failure('The project is invalid. Choose an explicit recovery snapshot or repair the original')
    return observed
  }

  syncDirectory(directory = this.directory) {
    this.assertJournalLock()
    this.assertRoot(); guardedOutput(this.root, directory)
    const fd = this.disk.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY)
    try { this.disk.fsyncSync(fd) } finally { this.disk.closeSync(fd) }
  }

  writeExclusive(file, bytes) {
    this.assertJournalLock()
    this.assertRoot(); guardedOutput(this.root, file)
    const fd = this.disk.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    const owned = this.disk.fstatSync(fd, { bigint: true })
    try { this.disk.writeFileSync(fd, bytes); this.disk.fsyncSync(fd) }
    catch (error) { try { if (same(owned, this.disk.lstatSync(file, { bigint: true }))) this.disk.unlinkSync(file) } catch {}; throw error }
    finally { this.disk.closeSync(fd) }
    return owned
  }

  family(create = false) {
    if (create && this.publicationLockHeld === null) return this.journal(this.root, { operation: 'family', limits: this.limits }).result
    if (create) this.assertJournalLock()
    this.assertRoot(); const file = guardedOutput(this.root, path.join(this.directory, 'project-identity.json'))
    let value
    try { value = JSON.parse(this.read(file, 4096).bytes) }
    catch (error) {
      if (error.code !== 'ENOENT') throw failure('The recovery identity cannot be verified')
      if (!create) return null
      if (!(this.disk.lstatSync(this.root).mode & 0o222)) throw failure('The project is read-only')
      this.disk.mkdirSync(guardedOutput(this.root, this.directory), { recursive: true })
      this.syncDirectory(path.dirname(this.directory)); this.syncDirectory(this.root)
      value = { protocol: 1, familyID: this.makeID(), rootIdentity: this.rootIdentity, createdAt: new Date(this.now()).toISOString() }
      try { this.writeExclusive(file, JSON.stringify(value) + '\n'); this.syncDirectory() }
      catch (error) { if (error.code === 'EEXIST') return this.family(false); throw error }
    }
    if (value?.protocol !== 1 || !uuid.test(value.familyID ?? '') || !sameIdentity(value.rootIdentity, this.rootIdentity) || !timestamp(value.createdAt)) throw failure('The recovery identity belongs to another project folder')
    return value
  }

  inventory(family) {
    if (!family) return { records: [], bytes: 0, files: 0 }
    guardedOutput(this.root, this.directory)
    const directory = this.disk.opendirSync(this.directory)
    let bytes = 0, files = 0; const records = []
    try { for (let entry; (entry = directory.readSync()) !== null;) {
      if (++files > this.limits.files) throw failure('Recovery storage has too many files to inspect safely')
      const name = entry.name
      const file = guardedOutput(this.root, path.join(this.directory, name)), stat = this.disk.lstatSync(file, { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw failure('Recovery storage contains an unsafe entry')
      bytes += Number(stat.size)
      if (bytes > this.limits.totalBytes) throw failure('Recovery storage is full; its byte budget must be reviewed before continuing')
      const matched = /^(browser|native)-([0-9a-f-]+)\.receipt\.json$/.exec(name)
      if (!matched) continue
      let receipt, snapshot
      try {
        receipt = JSON.parse(this.read(file, 8192).bytes)
        if (receipt.protocol !== 1 || receipt.kind !== 'arya-project-recovery' || receipt.host !== matched[1] || receipt.id !== matched[2] || !uuid.test(receipt.id) || receipt.familyID !== family.familyID || !sameIdentity(receipt.rootIdentity, this.rootIdentity) || !['published', 'preserved-original'].includes(receipt.phase) || !timestamp(receipt.createdAt) || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < (receipt.phase === 'published' ? 1 : 0) || receipt.bytes > this.limits.projectBytes || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '') || receipt.sourceSHA256 !== null && !/^[a-f0-9]{64}$/.test(receipt.sourceSHA256 ?? '')) throw failure('Invalid recovery receipt')
        const snapshotFile = path.join(this.directory, `${receipt.host}-${receipt.id}.project.json`)
        snapshot = this.read(snapshotFile)
        if (snapshot.bytes.length !== receipt.bytes || hash(snapshot.bytes) !== receipt.sha256) throw failure('Recovery snapshot digest mismatch')
        const text = snapshot.bytes.toString('utf8')
        if (!Buffer.from(text).equals(snapshot.bytes)) throw failure('Recovery snapshot is not UTF-8')
        if (receipt.phase === 'published') recoveryProject(text)
        records.push({ ...receipt, text, receiptFile: file, snapshotFile, receiptStat: stat, snapshotStat: snapshot.stat })
      } catch { this.warning = 'Some recovery files could not be verified and are excluded from recovery choices' }
    }
    } finally { directory.closeSync() }
    return { files, records: records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id)), bytes }
  }

  removeRecord(record) {
    this.assertJournalLock()
    for (const [file, expected] of [[record.receiptFile, record.receiptStat], [record.snapshotFile, record.snapshotStat]]) {
      this.assertRoot(); guardedOutput(this.root, file)
      const current = this.disk.lstatSync(file, { bigint: true })
      if (!same(current, expected) || current.size !== expected.size || current.mtimeNs !== expected.mtimeNs || current.ctimeNs !== expected.ctimeNs || current.nlink !== 1n) throw failure('Recovery retention encountered a changed file')
    }
    this.assertJournalLock()
    this.disk.unlinkSync(record.receiptFile); this.disk.unlinkSync(record.snapshotFile); this.syncDirectory()
  }

  capture(text, phase = 'published', protectedIDs = [], sourceSHA256 = hash(text)) {
    if (this.publicationLockHeld === null) {
      const response = this.journal(this.root, { operation: 'capture', phase, protectedIDs, sourceSHA256, limits: this.limits }, [text])
      return { ...response.result, text }
    }
    this.assertJournalLock()
    if (typeof text !== 'string' || phase === 'published' && !text.length || Buffer.byteLength(text) > this.limits.projectBytes || !['published', 'preserved-original'].includes(phase) || sourceSHA256 !== null && !/^[a-f0-9]{64}$/.test(sourceSHA256 ?? '')) throw failure('The recovery snapshot exceeds supported bounds')
    if (phase === 'published') recoveryProject(text)
    const family = this.family(true), digest = hash(text), inventory = this.inventory(family)
    const existing = inventory.records.find(record => record.phase === phase && record.sha256 === digest)
    if (existing) return existing
    const id = this.makeID(), createdAt = new Date(this.now()).toISOString()
    const receipt = { protocol: 1, kind: 'arya-project-recovery', host: 'browser', familyID: family.familyID, rootIdentity: this.rootIdentity, id, createdAt, phase, sha256: digest, bytes: Buffer.byteLength(text), sourceSHA256 }
    const encoded = JSON.stringify(receipt) + '\n', needed = receipt.bytes + Buffer.byteLength(encoded)
    let bytes = inventory.bytes, files = inventory.files, count = inventory.records.filter(record => record.phase === 'published').length
    for (const record of [...inventory.records].reverse()) {
      if (bytes + needed <= this.limits.totalBytes && files + 2 <= this.limits.files && (phase !== 'published' || count < this.limits.published)) break
      if (record.phase !== 'published' || protectedIDs.includes(record.id)) continue
      this.removeRecord(record); bytes -= record.bytes + Number(record.receiptStat.size); files -= 2; count--
    }
    if (files + 2 > this.limits.files) throw failure('Recovery storage has too many files for a new snapshot pair')
    if (bytes + needed > this.limits.totalBytes || phase === 'published' && count >= this.limits.published) throw failure('Recovery storage is full; preserved originals are kept for review')
    const snapshotFile = guardedOutput(this.root, path.join(this.directory, `browser-${id}.project.json`)), receiptFile = guardedOutput(this.root, path.join(this.directory, `browser-${id}.receipt.json`))
    let snapshotStat, receiptStat
    try {
      snapshotStat = this.writeExclusive(snapshotFile, text)
      receiptStat = this.writeExclusive(receiptFile, encoded)
      this.syncDirectory()
    } catch (error) {
      for (const [file, owned] of [[receiptFile, receiptStat], [snapshotFile, snapshotStat]]) if (owned) { try { if (same(owned, this.disk.lstatSync(guardedOutput(this.root, file), { bigint: true }))) this.disk.unlinkSync(file) } catch {} }
      throw error
    }
    return { ...receipt, text, receiptFile, snapshotFile, receiptStat, snapshotStat }
  }

  list() {
    const observed = this.observe()
    try {
      const family = this.family(false), inventory = this.inventory(family)
      return { protocol: 1, familyID: family?.familyID ?? null, rootIdentity: this.rootIdentity, observed: { status: observed.status, token: observed.token, sha256: observed.sha256, writable: observed.writable, utf8: observed.utf8 ?? true }, snapshots: inventory.records.filter(record => record.phase === 'published').map(({ id, host, createdAt, sha256, bytes, text }) => ({ id, host, createdAt, sha256, bytes, name: recoveryProject(text).name })), preservedOriginals: inventory.records.filter(record => record.phase === 'preserved-original').length, warning: this.warning }
    } catch { return { protocol: 1, familyID: null, rootIdentity: this.rootIdentity, observed: { status: observed.status, token: observed.token, writable: observed.writable }, snapshots: [], preservedOriginals: 0, warning: 'Recovery storage cannot be safely read' } }
  }

  prepareRestore({ snapshotID, familyID, observedToken }) {
    if (this.publicationLockHeld === null) {
      const response = this.journal(this.root, { operation: 'prepareRestore', selection: { snapshotID, familyID, observedToken }, limits: this.limits })
      const text = response.texts[0], expectedText = response.result.expectedMissing ? null : response.texts[1]
      return { ...response.result, text, expectedText, project: recoveryProject(text) }
    }
    this.assertJournalLock()
    if (!uuid.test(snapshotID ?? '') || !uuid.test(familyID ?? '') || typeof observedToken !== 'string') throw failure('Choose a verified recovery snapshot and refresh the current project first')
    const family = this.family(false)
    if (family?.familyID !== familyID) throw failure('The recovery selection belongs to another project')
    const observed = this.observe()
    if (!observed.token || observed.token !== observedToken) throw failure('The project changed after the recovery choice was shown')
    this.assertExpected(observed.text, { allowInvalid: true })
    const snapshot = this.inventory(family).records.find(record => record.id === snapshotID && record.phase === 'published')
    if (!snapshot) throw failure('The chosen recovery snapshot is unavailable or invalid')
    if (observed.text !== null) this.capture(observed.text, 'preserved-original', [snapshotID])
    const current = this.observe()
    if (current.token !== observed.token) throw failure('The project changed while its original was being preserved')
    const verified = this.inventory(family).records.find(record => record.id === snapshotID && record.phase === 'published' && record.sha256 === snapshot.sha256)
    if (!verified) throw failure('The chosen recovery snapshot changed while its original was being preserved')
    return { project: recoveryProject(verified.text), text: verified.text, expectedText: observed.text, expectedIdentity: observed.fileIdentity, observedToken: observed.token, snapshotID }
  }
}
