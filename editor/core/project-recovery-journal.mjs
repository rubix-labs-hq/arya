import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TEXT_LIMIT = 64 * 1024 ** 2, META_LIMIT = 8192
const u64 = value => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes }
function exact(count) {
  const bytes = Buffer.alloc(count); let position = 0
  while (position < count) { const next = fs.readSync(0, bytes, position, count - position, null); if (!next) throw new Error('Incomplete journal packet'); position += next }
  return bytes
}
function number(maximum) { const value = exact(8).readBigUInt64BE(); if (value > BigInt(maximum)) throw new Error('Journal packet exceeds its bounds'); return Number(value) }
function readJournalPacket() {
  const encoded = exact(number(META_LIMIT)), decoded = encoded.toString('utf8')
  if (!Buffer.from(decoded).equals(encoded)) throw new Error('Journal metadata must be UTF8')
  const metadata = JSON.parse(decoded), count = number(2), texts = []
  for (let i = 0; i < count; i++) { const bytes = exact(number(TEXT_LIMIT)), text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) throw new Error('Journal text must be UTF8'); texts.push(text) }
  if (fs.readSync(0, Buffer.alloc(1), 0, 1, null)) throw new Error('Trailing journal bytes')
  return { metadata, texts }
}
function encodeJournalPacket(metadata, texts = []) {
  const meta = Buffer.from(JSON.stringify(metadata)), parts = [u64(meta.length), meta, u64(texts.length)]
  if (meta.length > META_LIMIT || texts.length > 2) throw new Error('Journal packet exceeds its bounds')
  for (const text of texts) { const bytes = Buffer.from(text); if (bytes.length > TEXT_LIMIT) throw new Error('Journal text exceeds its bounds'); parts.push(u64(bytes.length), bytes) }
  return Buffer.concat(parts)
}
function verifyDependencies(dependencies) {
  const directory = path.dirname(fileURLToPath(import.meta.url)), names = ['project-recovery.mjs', 'output-path.js', 'native-recovery-policy.js', 'transcript-draft-store.mjs']
  if (!dependencies || Object.keys(dependencies).sort().join('|') !== [...names].sort().join('|')) throw new Error('Invalid journal dependency manifest')
  for (const name of names) {
    const file = path.join(directory, name)
    if (fs.realpathSync(file) !== file || !/^[a-f0-9]{64}$/.test(dependencies[name])) throw new Error('Invalid journal dependency path')
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      const before = fs.fstatSync(fd), buffer = Buffer.alloc(Math.min(before.size, 256 * 1024) + 1)
      if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > 256 * 1024 || before.mode & 0o022) throw new Error('Unsafe journal dependency')
      let count = 0, next
      while (count < buffer.length && (next = fs.readSync(fd, buffer, count, buffer.length - count, null)) > 0) count += next
      const after = fs.fstatSync(fd), named = fs.lstatSync(file), stamp = st => [st.dev, st.ino, st.size, st.mode, st.mtimeMs, st.ctimeMs].join(':')
      if (count !== before.size || stamp(before) !== stamp(after) || stamp(before) !== stamp(named) || createHash('sha256').update(buffer.subarray(0, count)).digest('hex') !== dependencies[name]) throw new Error('Journal dependency changed')
    } finally { fs.closeSync(fd) }
  }
  return pathToFileURL(path.join(directory, 'project-recovery.mjs')).href
}

let retainedStage
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino
const stageStamp = stat => `${stat.dev}|${stat.ino}|${stat.size}|${stat.mode}|${stat.uid}|${stat.gid}|${stat.mtimeNs}|${stat.ctimeNs}`
function readPrivateStage(root) {
  const directoryFD = Number(process.argv[6]), fd = Number(process.argv[7]), name = process.argv[8]
  if (!Number.isSafeInteger(directoryFD) || directoryFD < 0 || !Number.isSafeInteger(fd) || fd < 0 || !/^draft-[a-f0-9]{32}\.part$/.test(name ?? '')) throw new Error('Transcript draft writes require the retained private stage gate')
  const expected = JSON.parse(process.argv[9]), directory = path.join(root, '.reel/transcript-drafts')
  const heldDirectory = fs.fstatSync(directoryFD, { bigint: true }), namedDirectory = fs.lstatSync(directory, { bigint: true })
  if (!heldDirectory.isDirectory() || !namedDirectory.isDirectory() || !sameInode(heldDirectory, namedDirectory)) throw new Error('The retained private transcript directory changed')
  const held = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(path.join(directory, name), { bigint: true })
  const stamp = `${BigInt(expected.device)}|${BigInt(expected.inode)}|0|${BigInt(expected.mode)}|${BigInt(expected.uid)}|${BigInt(expected.gid)}|${BigInt(expected.mtimeSec) * 1000000000n + BigInt(expected.mtimeNsec)}|${BigInt(expected.ctimeSec) * 1000000000n + BigInt(expected.ctimeNsec)}`
  if (!held.isFile() || held.dev !== BigInt(expected.device) || held.ino !== BigInt(expected.inode)) throw new Error('The retained private staging file identity changed')
  retainedStage = { fd, name, expectedStamp: stamp, directoryIdentity: `${heldDirectory.dev}|${heldDirectory.ino}`, directory, directoryFD, heldDirectory, held }
  if (!named.isFile() || held.nlink !== 1n || named.nlink !== 1n || (held.mode & 0o7777n) !== 0o600n || held.uid !== BigInt(process.getuid()) || stageStamp(held) !== stamp || stageStamp(named) !== stamp) throw new Error('The retained private staging file changed before writing')
  return retainedStage
}
try {
  const root = process.argv[2], descriptor = Number(process.argv[3])
  if (process.argv[7]) retainedStage = readPrivateStage(root)
  const { metadata, texts } = readJournalPacket()
  if (retainedStage && metadata.operation !== 'transcriptDrafts') throw new Error('The retained private draft mode only supports transcript draft actions')
  const dependencyURL = verifyDependencies(metadata.trustedDependencies)
  const { ProjectRecovery, RECOVERY_LIMITS } = await import(dependencyURL)
  const limits = metadata.limits ?? RECOVERY_LIMITS
  for (const key of Object.keys(RECOVERY_LIMITS)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > RECOVERY_LIMITS[key]) throw new Error('Invalid recovery journal limits')
  const expectedRootIdentity = { device: process.argv[4], inode: process.argv[5] }
  const recovery = new ProjectRecovery(root, { limits, publicationLockHeld: descriptor, expectedRootIdentity })
  recovery.assertJournalLock()
  let result, output = []
  if (metadata.operation === 'transcriptDrafts' && texts.length === 1) {
    const action = metadata.action
    if (!['checkpoint', 'discard'].includes(action) || Buffer.byteLength(texts[0]) > 16 * 1024 * 1024) throw new Error('Invalid transcript draft journal operation')
    if (!retainedStage) throw new Error('Transcript draft writes require the retained private stage gate')
    const draftDescriptor = retainedStage.directoryFD, namedDirectory = retainedStage.directory
    const held = fs.fstatSync(draftDescriptor, { bigint: true }), named = fs.lstatSync(namedDirectory, { bigint: true })
    if (!held.isDirectory() || !named.isDirectory() || held.dev !== named.dev || held.ino !== named.ino) throw new Error('The retained private transcript directory changed')
    const moduleURL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'transcript-draft-store.mjs')).href
    const { createTranscriptDraftStore } = await import(moduleURL)
    const store = createTranscriptDraftStore({ root, publicationLockHeld: descriptor, privateStage: retainedStage, assertPublication: () => {
      recovery.assertJournalLock()
      const current = fs.lstatSync(namedDirectory, { bigint: true })
      if (!current.isDirectory() || current.dev !== held.dev || current.ino !== held.ino) throw new Error('The transcript draft directory changed before publication')
    } })
    result = store[action](JSON.parse(texts[0]))
  } else if (metadata.operation === 'capture'  && texts.length === 1) {
    const record = recovery.capture(texts[0], metadata.phase, metadata.protectedIDs, metadata.sourceSHA256)
    const { text, receiptStat, snapshotStat, ...receipt } = record
    result = receipt
  } else if (metadata.operation === 'family' && !texts.length) result = recovery.family(true)
  else if (metadata.operation === 'prepareRestore' && !texts.length) {
    const prepared = recovery.prepareRestore(metadata.selection)
    const { text, expectedText, project, ...receipt } = prepared
    result = { ...receipt, expectedMissing: expectedText === null }
    output = expectedText === null ? [text] : [text, expectedText]
  } else throw new Error('Invalid recovery journal operation')
  fs.writeFileSync(1, encodeJournalPacket({ ok: true, result }, output))
} catch (error) {
  fs.writeFileSync(1, encodeJournalPacket({ ok: false, error: String(error.message).slice(0, 512) }))
  process.exitCode = 1
} finally {
  if (retainedStage) {
    // Keep a displaced directory or replacement name. Only this stage inode is ours.
    try {
      const directory = fs.lstatSync(retainedStage.directory, { bigint: true }), file = fs.lstatSync(path.join(retainedStage.directory, retainedStage.name), { bigint: true })
      if (directory.isDirectory() && sameInode(directory, retainedStage.heldDirectory) && file.isFile() && sameInode(file, retainedStage.held)) fs.unlinkSync(path.join(retainedStage.directory, retainedStage.name))
    } catch {}
    fs.closeSync(retainedStage.fd)
  }
}
