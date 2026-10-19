import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepare, validatePrepared, signPrepared, validateBinary, validateSignature, execute } from '../scripts/prepare-project-writer.mjs'
import { CAPABILITY, digest, validateManifest } from '../core/project-writer-manifest.mjs'
import { createProjectWriter } from '../core/project-persistence.mjs'

let compiled, original, preparedTemporary
test.before(() => {
  const available = fileURLToPath(new URL('../core', import.meta.url))
  if (fs.existsSync(path.join(available, 'project-writer')) && fs.existsSync(path.join(available, 'project-writer.prepared.json'))) compiled = available
  else {
    preparedTemporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-writer-preparation-tests-')))
    compiled = path.join(preparedTemporary, 'core'); fs.mkdirSync(compiled)
    prepare(compiled)
  }
  original = JSON.parse(fs.readFileSync(path.join(compiled, 'project-writer.prepared.json')))
})
test.after(() => { if (preparedTemporary) fs.rmSync(preparedTemporary, { recursive: true, force: true }) })
function fixture(t, native = false) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arya-prepared-writer-')))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const core = native ? path.join(temporary, 'Arya.app/Contents/Resources/editor/core') : path.join(temporary, 'core')
  fs.mkdirSync(core, { recursive: true })
  const relative = native ? '../../../Helpers/project-writer' : 'project-writer'
  const binary = path.resolve(core, relative)
  fs.mkdirSync(path.dirname(binary), { recursive: true })
  fs.copyFileSync(path.join(compiled, 'project-writer'), binary)
  const manifest = { ...original, binaryRelativePath: relative }
  const save = value => fs.writeFileSync(path.join(core, 'project-writer.prepared.json'), JSON.stringify(value))
  save(manifest)
  const project = path.join(temporary, 'project'); fs.mkdirSync(project)
  return { core, binary, manifest, save, project }
}
test('actual universal helper metadata and development manifest are validated', () => {
  const receipt = validatePrepared(compiled)
  assert.deepEqual(receipt.architectures, ['arm64', 'x86_64'])
  assert.equal(receipt.minimumMacOS, '14.0'); assert.equal(receipt.signatureMode, 'development')
})
test('generated default binding writes, replaces and rejects stale content through real C', t => {
  const { core, project } = fixture(t)
  const writer = createProjectWriter({ coreDirectory: core })
  assert.equal(writer(project, 'first', null).directorySynced, true)
  writer(project, 'second', 'first')
  assert.equal(fs.readFileSync(path.join(project, 'reel.project.json'), 'utf8'), 'second')
  assert.throws(() => writer(project, 'third', 'first'), /target|conflict/)
  assert.equal(fs.readFileSync(path.join(project, 'reel.project.json'), 'utf8'), 'second')
})
test('native bundle helper binding targets Contents/Helpers and performs a real write', t => {
  const { core, project } = fixture(t, true)
  validatePrepared(core)
  createProjectWriter({ coreDirectory: core })(project, 'native-resource-binding', null)
  assert.equal(fs.readFileSync(path.join(project, 'reel.project.json'), 'utf8'), 'native-resource-binding')
})
test('actual native preparation finishes before app sealing and installs readable resources', t => {
  const f = fixture(t, true), app = path.resolve(f.core, '../../../..')
  fs.unlinkSync(f.binary); fs.unlinkSync(path.join(f.core, 'project-writer.prepared.json'))
  fs.mkdirSync(path.join(app, 'Contents/MacOS'))
  fs.copyFileSync('/usr/bin/true', path.join(app, 'Contents/MacOS/Arya'))
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Arya</string><key>CFBundleIdentifier</key><string>test.arya.persistence</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
  const receipt = prepare(f.core, { native: true })
  assert.equal(receipt.signatureMode, 'development')
  assert.equal(fs.statSync(f.binary).mode & 0o777, 0o755)
  assert.equal(fs.statSync(path.join(f.core, 'project-writer.prepared.json')).mode & 0o777, 0o644)
  execute('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', app])
  validatePrepared(f.core)
  createProjectWriter({ coreDirectory: f.core })(f.project, 'sealed-native-helper', null)
  assert.equal(fs.readFileSync(path.join(f.project, 'reel.project.json'), 'utf8'), 'sealed-native-helper')
})
for (const mutation of ['missing', 'hash', 'binary-path', 'source', 'cpu', 'minimum', 'capability', 'linked-manifest', 'linked-binary']) test(`default writer rejects ${mutation} before transport`, t => {
  const { core, binary, project, manifest, save } = fixture(t)
  const target = path.join(core, 'project-writer.prepared.json')
  if (mutation === 'missing') fs.unlinkSync(target)
  else if (mutation === 'hash') fs.appendFileSync(binary, 'changed')
  else if (mutation === 'binary-path') save({ ...manifest, binaryRelativePath: '/usr/bin/true' })
  else if (mutation === 'source') save({ ...manifest, sourceSHA256: '0'.repeat(64) })
  else if (mutation === 'cpu') save({ ...manifest, architectures: ['arm64'] })
  else if (mutation === 'minimum') save({ ...manifest, minimumMacOS: '15.0' })
  else if (mutation === 'capability') save({ ...manifest, protocol: 2 })
  else { const selected = mutation === 'linked-manifest' ? target : binary; fs.renameSync(selected, selected + '.real'); fs.symlinkSync(selected + '.real', selected) }
  let called = false
  assert.throws(() => createProjectWriter({ coreDirectory: core, run() { called = true } })(project, 'never', null), /helper preparation|helper verification/)
  assert.equal(called, false); assert.equal(fs.existsSync(path.join(project, 'reel.project.json')), false)
})
test('official validation rejects a development helper before signing commands', t => {
  const { core } = fixture(t)
  assert.throws(() => validatePrepared(core, { official: true, team: 'ABCDEFGHIJ' }), /must be signed/)
})
test('preparation refuses existing output and changed source', t => {
  const { core } = fixture(t)
  assert.throws(() => prepare(core), /already exists/)
  const empty = path.join(core, 'empty'); fs.mkdirSync(empty)
  const source = path.join(core, 'changed.c'); fs.writeFileSync(source, 'int main(){}')
  let called = false
  assert.throws(() => prepare(empty, { source, runner() { called = true } }), /source changed/)
  assert.equal(called, false)
})
test('preparation refuses non macOS and invalid native locations', t => {
  const { core } = fixture(t)
  assert.throws(() => prepare(core, { platform: 'linux' }), /macOS only/)
  assert.throws(() => prepare(core, { native: true }), /app resource/)
})
for (const invalid of ['cpu', 'minimum', 'platform', 'test-hooks']) test(`build validation rejects ${invalid}`, t => {
  const { binary } = fixture(t)
  const runner = (file, args) => {
    if (file === '/usr/bin/lipo') return { stdout: invalid === 'cpu' ? 'arm64' : 'arm64 x86_64' }
    if (file === '/usr/bin/otool') return { stdout: `Load command 0\n cmd LC_BUILD_VERSION\n platform ${invalid === 'platform' ? '2' : '1'}\n minos ${invalid === 'minimum' ? '15.0' : '14.0'}\n` }
    return { stdout: JSON.stringify({ ...CAPABILITY, testHooks: invalid === 'test-hooks' }) }
  }
  assert.throws(() => validateBinary(binary, runner))
})
function fakeSigner(fixture, options = {}) {
  let signed = false
  return (file, args) => {
    if (file === '/usr/bin/codesign') {
      if (args.includes('--sign')) { signed = true; fs.appendFileSync(fixture.binary, 'simulated signature bytes'); return { stdout: '', stderr: '' } }
      if (!signed) return execute(file, args)
      if (args.includes('-dvv')) return { stdout: '', stderr: `CodeDirectory v=20500 flags=0x10000(runtime)\nAuthority=Developer ID Application: Test\nTeamIdentifier=${options.wrongTeam ? 'ZZZZZZZZZZ' : 'ABCDEFGHIJ'}\n` }
      if (args.includes('--entitlements')) return { stdout: options.entitlements ? '<key>com.apple.security.network.client</key>' : '', stderr: '' }
      return { stdout: '', stderr: '' }
    }
    if (file === '/usr/bin/arch') return { stdout: JSON.stringify({ ...CAPABILITY, testHooks: !!options.badProbe }), stderr: '' }
    return execute(file, args)
  }
}
test('final generated pin binds post-sign bytes and both architecture probe receipts', t => {
  const f = fixture(t), unsigned = digest(fs.readFileSync(f.binary)), runner = fakeSigner(f)
  const receipt = signPrepared(f.core, 'Developer ID Application: Fixture', 'ABCDEFGHIJ', runner)
  assert.notEqual(receipt.binarySHA256, unsigned)
  assert.equal(receipt.binarySHA256, digest(fs.readFileSync(f.binary)))
  const signed = JSON.parse(fs.readFileSync(path.join(f.core, 'project-writer.prepared.json')))
  assert.deepEqual(signed.startupProbes, { arm64: CAPABILITY, x86_64: CAPABILITY })
  assert.equal(validatePrepared(f.core, { official: true, team: 'ABCDEFGHIJ', runner }).signatureMode, 'developer-id')
  assert.throws(() => validatePrepared(f.core, { official: true, team: 'ZZZZZZZZZZ', runner }), /team mismatch/)
})
for (const option of ['wrongTeam', 'entitlements', 'badProbe']) test(`signing failure ${option} leaves development pin and fails closed`, t => {
  const f = fixture(t)
  assert.throws(() => signPrepared(f.core, 'Developer ID Application: Fixture', 'ABCDEFGHIJ', fakeSigner(f, { [option]: true })))
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.core, 'project-writer.prepared.json'))).signatureMode, 'development')
  assert.throws(() => createProjectWriter({ coreDirectory: f.core })(f.project, 'never', null), /helper verification/)
})
test('manifest requires signed startup probes and rejects ad hoc identity', t => {
  const f = fixture(t)
  assert.throws(() => validateManifest({ ...f.manifest, signatureMode: 'developer-id', teamIdentifier: 'ABCDEFGHIJ' }), /startup probe/)
  assert.throws(() => signPrepared(f.core, '-', 'ABCDEFGHIJ'), /identity and team/)
})

test('signature validation passes codesign its requirement as literal text', () => {
  const calls = []
  const runner = (file, args) => {
    calls.push(args)
    if (args.includes('-dvv')) return { stdout: '', stderr: 'CodeDirectory v=20500 size=1 flags=0x10000(runtime)\nAuthority=Developer ID Application: Fixture (ABCDE12345)\nTeamIdentifier=ABCDE12345\n' }
    return { stdout: '', stderr: '' }
  }
  validateSignature('/fixture/project-writer', 'ABCDE12345', runner)
  const requirement = calls[0].find(arg => arg.startsWith('-R'))
  assert.match(requirement, /^-R=anchor apple generic and certificate leaf\[subject\.OU\] = "ABCDE12345"/)
})
