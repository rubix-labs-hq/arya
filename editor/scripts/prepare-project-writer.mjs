// Build-time only. The installed writer and its Node wrapper need no Python or compiler.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CAPABILITY, SOURCE_SHA256, JOURNAL_SHA256, JOURNAL_DEPENDENCIES, digest, readRegular, validateManifest, loadPrepared } from '../core/project-writer-manifest.mjs'

const SOURCE = fileURLToPath(new URL('../core/project-writer.c', import.meta.url))
const ARCHITECTURES = ['arm64', 'x86_64']
export function execute(file, args = []) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 128 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: os.tmpdir() }, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error || result.status !== 0) throw Error(`Persistence preparation tool failed (${path.basename(file)}, ${result.status ?? 'transport'})`)
  return { stdout: result.stdout, stderr: result.stderr }
}
function canonicalDirectory(directory) {
  const absolute = path.resolve(directory)
  if (fs.realpathSync(absolute) !== absolute || !fs.lstatSync(absolute).isDirectory()) throw Error('Preparation directory must be canonical')
  return absolute
}
export function validateBinary(binary, runner = execute, { probe = true } = {}) {
  if (runner('/usr/bin/lipo', ['-archs', binary]).stdout.trim().split(/\s+/).sort().join(',') !== ARCHITECTURES.join(',')) throw Error('Universal persistence helper required')
  for (const architecture of ARCHITECTURES) {
    const headers = runner('/usr/bin/otool', ['-arch', architecture, '-l', binary]).stdout
    const minimums = [], platforms = []
    for (const block of headers.split(/Load command \d+/)) {
      if (/\bcmd LC_BUILD_VERSION\b/.test(block)) {
        minimums.push(...[...block.matchAll(/\bminos (\d+\.\d+(?:\.\d+)?)/g)].map(m => m[1]))
        platforms.push(...[...block.matchAll(/\bplatform (\S+)/g)].map(m => m[1]))
      } else if (/\bcmd LC_VERSION_MIN_MACOSX\b/.test(block)) minimums.push(...[...block.matchAll(/\bversion (\d+\.\d+(?:\.\d+)?)/g)].map(m => m[1]))
    }
    if (minimums.length !== 1 || !/^14\.0(?:\.0)?$/.test(minimums[0]) || platforms.some(p => !['1', 'macos'].includes(p.toLowerCase()))) throw Error('Persistence helper must target macOS 14.0')
  }
  if (probe) {
    const capability = JSON.parse(runner(binary, ['info']).stdout)
    for (const [key, value] of Object.entries(CAPABILITY)) if (capability[key] !== value) throw Error('Production persistence capabilities required')
  }
}
export function validateDevelopmentSignature(binary, runner = execute) {
  runner('/usr/bin/codesign', ['--verify', '--strict', binary])
  const details = runner('/usr/bin/codesign', ['-dvv', binary]).stderr
  const flags = /^CodeDirectory\b.*\bflags=0x([a-fA-F0-9]+)/m.exec(details)
  if (!flags || !(parseInt(flags[1], 16) & 0x10000) || !details.split('\n').includes('Signature=adhoc')) throw Error('Development persistence helper requires an ad hoc hardened signature')
}
export function validateSignature(binary, team, runner = execute) {
  if (!/^[A-Z0-9]{10}$/.test(team ?? '')) throw Error('Valid Developer ID team required')
  const requirement = `anchor apple generic and certificate leaf[subject.OU] = "${team}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`
  // codesign reads -R as a file path unless the requirement text follows "=".
  runner('/usr/bin/codesign', ['--verify', '--strict', `-R=${requirement}`, binary])
  const details = runner('/usr/bin/codesign', ['-dvv', binary]).stderr
  const flags = /^CodeDirectory\b.*\bflags=0x([a-fA-F0-9]+)/m.exec(details)
  if (!flags || !(parseInt(flags[1], 16) & 0x10000) || !details.includes('Authority=Developer ID Application:') || !details.split('\n').includes(`TeamIdentifier=${team}`)) throw Error('Developer ID hardened runtime required')
  const entitlements = runner('/usr/bin/codesign', ['-d', '--entitlements', ':-', binary]).stdout
  if (/<key>/.test(entitlements)) throw Error('Persistence helper must not request entitlements')
}
export function validatePrepared(core, { official = false, team, runner = execute, probe = true } = {}) {
  const prepared = loadPrepared(core)
  const bytes = readRegular(prepared.binary, 32 * 1024 * 1024)
  if (!(fs.statSync(prepared.binary).mode & 0o111) || digest(bytes) !== prepared.sha256) throw Error('Prepared helper byte mismatch')
  // Validate architecture metadata before invoking the verified capability probe.
  validateBinary(prepared.binary, runner, { probe })
  if (official && prepared.manifest.signatureMode !== 'developer-id') throw Error('Official persistence helper must be signed')
  if (official && team !== prepared.manifest.teamIdentifier) throw Error('Persistence signing team mismatch')
  if (prepared.manifest.signatureMode === 'development') validateDevelopmentSignature(prepared.binary, runner)
  if (prepared.manifest.signatureMode === 'developer-id') validateSignature(prepared.binary, prepared.manifest.teamIdentifier, runner)
  return { architectures: ARCHITECTURES, minimumMacOS: '14.0', binarySHA256: prepared.sha256,
    manifestSHA256: digest(readRegular(path.join(core, 'project-writer.prepared.json'), 8192)), signatureMode: prepared.manifest.signatureMode,
    ...(prepared.manifest.teamIdentifier ? { teamIdentifier: prepared.manifest.teamIdentifier } : {}) }
}
export function prepare(coreDirectory, { native = false, source = SOURCE, runner = execute, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw Error('Persistence helper preparation supports macOS only')
  const core = canonicalDirectory(coreDirectory)
  const relative = native ? '../../../Helpers/project-writer' : 'project-writer'
  if (native && (!core.endsWith('/Contents/Resources/editor/core'))) throw Error('Native preparation requires the app resource core directory')
  const binary = path.resolve(core, relative), manifestPath = path.join(core, 'project-writer.prepared.json')
  if (fs.existsSync(binary) || fs.existsSync(manifestPath) || fs.lstatSync(core).isSymbolicLink()) throw Error('Prepared persistence output already exists')
  if (digest(readRegular(source, 256 * 1024)) !== SOURCE_SHA256) throw Error('Persistence source changed; review before preparing')
  if (native) { const helpers = path.dirname(binary); if (!fs.existsSync(helpers)) fs.mkdirSync(helpers); canonicalDirectory(helpers) }
  const staging = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-writer-build-')))
  try {
    const slices = ARCHITECTURES.map(arch => path.join(staging, arch))
    for (let i = 0; i < ARCHITECTURES.length; i++) runner('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', '-mmacosx-version-min=14.0', '-arch', ARCHITECTURES[i], source, '-o', slices[i]])
    const merged = path.join(staging, 'project-writer')
    runner('/usr/bin/lipo', ['-create', ...slices, '-output', merged])
    // Seal both slices consistently for local nested-code use, without any credential.
    runner('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', merged])
    validateDevelopmentSignature(merged, runner)
    const bytes = readRegular(merged, 32 * 1024 * 1024)
    validateBinary(merged, runner)
    if (digest(readRegular(source, 256 * 1024)) !== SOURCE_SHA256) throw Error('Persistence source changed during preparation')
    const manifest = validateManifest({ schemaVersion: 1, name: 'Arya Project Writer', protocol: 1, metadata: CAPABILITY.metadata, publicationLock: CAPABILITY.publicationLock, expectedIdentity: CAPABILITY.expectedIdentity, journalExec: CAPABILITY.journalExec, journalPrivacy: CAPABILITY.journalPrivacy, draftJournalPrivacy: CAPABILITY.draftJournalPrivacy, journalSHA256: JOURNAL_SHA256, journalDependencies: JOURNAL_DEPENDENCIES,
      sourceSHA256: SOURCE_SHA256, minimumMacOS: '14.0', architectures: ARCHITECTURES, binaryRelativePath: relative,
      binarySHA256: digest(bytes), signatureMode: 'development' })
    fs.writeFileSync(binary, bytes, { flag: 'wx', mode: 0o755 })
    fs.chmodSync(binary, 0o755)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: native ? 0o644 : 0o600 })
    fs.chmodSync(manifestPath, native ? 0o644 : 0o600)
    return validatePrepared(core, { runner, probe: false })
  } finally { fs.rmSync(staging, { recursive: true, force: true }) }
}
export function signPrepared(coreDirectory, identity, team, runner = execute) {
  if (typeof identity !== 'string' || !identity.trim() || identity === '-' || !/^[A-Z0-9]{10}$/.test(team ?? '')) throw Error('Developer ID identity and team required')
  const core = canonicalDirectory(coreDirectory), before = loadPrepared(core)
  if (before.manifest.signatureMode !== 'development') throw Error('Only prepared development helpers can be signed')
  validatePrepared(core, { runner, probe: false })
  runner('/usr/bin/codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', before.binary])
  validateSignature(before.binary, team, runner)
  validateBinary(before.binary, runner, { probe: false })
  const finalBytes = readRegular(before.binary, 32 * 1024 * 1024)
  const current = loadPrepared(core)
  if (JSON.stringify(current.manifest) !== JSON.stringify(before.manifest)) throw Error('Persistence manifest changed during signing')
  // The app is not sealed yet. Probe the exact signed bytes in a private staging
  // directory outside its bundle, then validate the installed path after app sealing.
  const startupProbes = {}, staging = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-writer-probe-')))
  try {
    const staged = path.join(staging, 'project-writer')
    fs.writeFileSync(staged, finalBytes, { flag: 'wx', mode: 0o700 })
    validateSignature(staged, team, runner)
    validateBinary(staged, runner)
    for (const arch of ARCHITECTURES) {
      const probe = JSON.parse(runner('/usr/bin/arch', ['-' + arch, staged, 'info']).stdout)
      for (const [key, value] of Object.entries(CAPABILITY)) if (probe[key] !== value) throw Error('Signed architecture startup probe failed')
      startupProbes[arch] = probe
    }
    if (digest(readRegular(before.binary, 32 * 1024 * 1024)) !== digest(finalBytes) || digest(readRegular(staged, 32 * 1024 * 1024)) !== digest(finalBytes)) throw Error('Signed persistence helper changed during probing')
  } finally { fs.rmSync(staging, { recursive: true, force: true }) }
  const manifest = validateManifest({ ...before.manifest, binarySHA256: digest(finalBytes), signatureMode: 'developer-id', teamIdentifier: team, startupProbes })
  const target = path.join(core, 'project-writer.prepared.json'), temporary = path.join(core, 'project-writer.signed.json')
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: before.manifest.binaryRelativePath === 'project-writer' ? 0o600 : 0o644 })
  fs.chmodSync(temporary, before.manifest.binaryRelativePath === 'project-writer' ? 0o600 : 0o644)
  fs.renameSync(temporary, target)
  return validatePrepared(core, { official: true, team, runner, probe: false })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, core, ...options] = process.argv.slice(2)
  try {
    if (command === 'prepare' && core && options.every(value => value === '--native') && options.length <= 1) console.log(JSON.stringify(prepare(core, { native: options.includes('--native') })))
    else if (command === 'sign' && core && options.length === 2) console.log(JSON.stringify(signPrepared(core, options[0], options[1])))
    else if (command === 'validate' && core && (options.length === 0 || options.length === 2 && options[0] === '--official')) console.log(JSON.stringify(validatePrepared(core, { official: options.length === 2, team: options[1] })))
    else throw Error('Use prepare CORE [--native], sign CORE IDENTITY TEAM, or validate CORE [--official TEAM]')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
