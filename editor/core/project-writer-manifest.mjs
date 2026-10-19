import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const SOURCE_SHA256 = 'bceb89c07c47bcc7894defae89b8b83c4c8fa3873547eb37484043b1d258c0ff'
export const JOURNAL_SHA256 = 'f44fb747dc2b3dbc357d6cb3a5235004ea6718b8c14d7c6aaf215eb3849efa4a'
export const JOURNAL_DEPENDENCIES = {"project-recovery.mjs": "d25de3f5c63d75440ce660517276d539d48e13110af75839df85342b890a60f3", "output-path.js": "b0379597c9b7526f99f05f2d28754637e579eefb0f78bdfe05b5e27f6d6d1822", "native-recovery-policy.js": "1d7dee6285505d333599b317259f79a18788c0ffef2e59f9641fb5cd32be3175", "transcript-draft-store.mjs": "1026617d3ce23116c082ddcfacc6aab72d358c951915212f7dee326e69bf8b1f"}
export const CAPABILITY = { ok: true, protocol: 1, testHooks: false, platform: 'darwin', metadata: 'acl-xattr-mode-owner-group', publicationLock: 'recovery-flock-v1', expectedIdentity: 'main-device-inode-v1', journalExec: 'recovery-flock-v1', journalPrivacy: 'empty-directory-acl-v1', draftJournalPrivacy: 'retained-private-stage-v1' }
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export function readRegular(file, limit) {
  const absolute = path.resolve(file)
  if (fs.realpathSync(absolute) !== absolute) throw Error('Persistence files require canonical paths')
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const before = fs.fstatSync(fd)
    // Another user must not be able to rewrite the helper, its manifest or the journal it runs.
    if (!before.isFile() || before.nlink !== 1 || before.size > limit || before.size <= 0) throw Error('Invalid persistence file')
    if (before.mode & 0o022) throw Error(`Persistence file ${path.basename(absolute)} is writable by other users (mode ${(before.mode & 0o777).toString(8)}); run chmod go-w on it`)
    const buffer = Buffer.alloc(before.size + 1)
    let count = 0, next
    while (count < buffer.length && (next = fs.readSync(fd, buffer, count, buffer.length - count, null)) > 0) count += next
    const bytes = buffer.subarray(0, count), after = fs.fstatSync(fd), current = fs.lstatSync(absolute)
    const identity = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
    if (bytes.length !== before.size || identity(before) !== identity(after) || identity(before) !== identity(current)) throw Error('Persistence file changed')
    return bytes
  } finally { fs.closeSync(fd) }
}
export function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.name !== 'Arya Project Writer' || manifest.protocol !== 1 || manifest.metadata !== CAPABILITY.metadata || manifest.publicationLock !== CAPABILITY.publicationLock || manifest.expectedIdentity !== CAPABILITY.expectedIdentity || manifest.journalExec !== CAPABILITY.journalExec || manifest.journalPrivacy !== CAPABILITY.journalPrivacy || manifest.draftJournalPrivacy !== CAPABILITY.draftJournalPrivacy || manifest.journalSHA256 !== JOURNAL_SHA256 || JSON.stringify(manifest.journalDependencies) !== JSON.stringify(JOURNAL_DEPENDENCIES) || manifest.sourceSHA256 !== SOURCE_SHA256 || manifest.minimumMacOS !== '14.0' || JSON.stringify(manifest.architectures) !== '["arm64","x86_64"]' || !/^[a-f0-9]{64}$/.test(manifest.binarySHA256 ?? '')) throw Error('Invalid prepared persistence manifest')
  if (!['project-writer', '../../../Helpers/project-writer'].includes(manifest.binaryRelativePath)) throw Error('Invalid prepared helper path')
  if (!['development', 'developer-id'].includes(manifest.signatureMode)) throw Error('Invalid prepared signature mode')
  if (manifest.signatureMode === 'developer-id' && !/^[A-Z0-9]{10}$/.test(manifest.teamIdentifier ?? '')) throw Error('Invalid helper signing team')
  if (manifest.signatureMode === 'development' && manifest.teamIdentifier !== undefined) throw Error('Unsigned helper cannot declare a team')
  if (manifest.signatureMode === 'developer-id') {
    for (const arch of manifest.architectures) for (const [key, value] of Object.entries(CAPABILITY)) if (manifest.startupProbes?.[arch]?.[key] !== value) throw Error('Missing signed helper startup probe')
  }
  return manifest
}
export function loadPrepared(coreDirectory) {
  const core = path.resolve(coreDirectory)
  const manifest = validateManifest(JSON.parse(readRegular(path.join(core, 'project-writer.prepared.json'), 8192)))
  if (manifest.binaryRelativePath !== 'project-writer' && path.basename(core) !== 'core') throw Error('Invalid native helper layout')
  if (manifest.binaryRelativePath !== 'project-writer' && path.basename(path.dirname(core)) !== 'editor') throw Error('Invalid native helper layout')
  if (manifest.binaryRelativePath !== 'project-writer' && path.basename(path.dirname(path.dirname(core))) !== 'Resources') throw Error('Invalid native helper layout')
  return { manifest, binary: path.resolve(core, manifest.binaryRelativePath), sha256: manifest.binarySHA256 }
}
