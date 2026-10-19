import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { musicFileIdentity, MAX_MUSIC_WAV_BYTES } from '../music/file-identity.mjs'
import { reimportMusicAsset, prepareMusicReimport } from '../music/reimport.mjs'
import { musicAssetRecord, isAryaMusicAsset, musicImportDecision } from '../core/music-score.js'
import { renderMusicWAV } from '../music/render-score.mjs'
import { newProject, applyOps } from '../core/project.js'
import musicRoutes from '../routes/music.mjs'
import { importMediaPaths } from '../web/ui/media-import.js'
import { bundleMusic } from '../../native/scripts/bundle-music.mjs'

const exec = promisify(execFile)
const score = { version: 1, title: 'Wistful Crossing', bpm: 120, lengthBeats: 2, seed: 17, room: 0, parts: [{ id: 'keys', instrument: 'keys', gainDb: -12, pan: 0, notes: [{ at: 0.25, duration: 1.5, pitch: 62, velocity: 0.7 }] }] }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function owned(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-score-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root
}
async function probe(root, src) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(root, src)])
  const p = JSON.parse(stdout), audio = p.streams.find(s => s.codec_type === 'audio')
  return { hasAudio: !!audio, hasVideo: p.streams.some(s => s.codec_type === 'video'), channels: audio?.channels, codec: audio?.codec_name, duration: Number(p.format.duration), sampleRate: Number(audio?.sample_rate), size: Number(p.format.size) }
}
async function rendered(t) {
  const root = owned(t), output = await renderMusicWAV(root, score), technical = await probe(root, output.path)
  return { root, output, asset: musicAssetRecord(score, { ...output, asset: technical }), technical, file: path.join(root, output.path) }
}
function mutate(file) {
  const fd = fs.openSync(file, 'r+')
  try { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, 44 + 8000 * 6); b[0] ^= 1; fs.writeSync(fd, b, 0, 1, 44 + 8000 * 6) } finally { fs.closeSync(fd) }
}
const routeSource = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
function harness(root, initial = newProject('Identity QA')) {
  const history = [], state = vm.createContext({ ROOT: root, fs, path, project: initial, version: 0,
    newProject, applyOps, isAryaMusicAsset, reimportMusicAsset, prepareMusicReimport, assertAssistantPublication() {},
    probe: src => probe(root, src), ensureProxy: async () => {}, filmstrip: async () => {}, log() {},
  })
  state.commit = next => { history.push(state.project); state.project = next; state.version++ }
  const body = routeSource.match(/'POST \/api\/import': async body => \{([^]*?)\n  \},/)
  assert.ok(body, 'exercise actual server import handler without launching a server')
  const mediaExtensions = routeSource.match(/^const MEDIA_EXT = .*$/m)
  vm.runInContext(`${mediaExtensions[0]}\nglobalThis.importRoute = async body => {${body[1]}\n}`, state)
  const music = musicRoutes({ ROOT: root, getProject: () => state.project, getVersion: () => state.version, getProjectGeneration: () => 0, probe: state.probe, callAPI: async (method, route, body) => {
    if (method === 'GET') return { project: state.project, version: state.version }
    assert.equal(route, '/api/ops'); assert.equal(body.expectedVersion, state.version)
    const result = applyOps(state.project, body.ops); state.commit(result.project)
    return { version: state.version, created: result.created }
  } }).routes
  return { state, history, music, import: paths => state.importRoute({ paths }) }
}

test('new generation hashes final WAV bytes and records byte identity with native bridge parity', async t => {
  const { output, asset, file, technical } = await rendered(t)
  assert.equal(output.contentSHA256, hash(fs.readFileSync(file)))
  assert.equal(asset.generated.contentSHA256, output.contentSHA256)
  assert.equal(asset.generated.contentBytes, fs.statSync(file).size)
  const engine = vm.createContext({}); vm.runInContext(bundleMusic(fs.readFileSync(new URL('../core/music-score.js', import.meta.url), 'utf8')), engine)
  const receipt = { ...output, asset: technical }
  assert.deepEqual(JSON.parse(engine.AryaMusic.assetRecordJSON(JSON.stringify(score), JSON.stringify(receipt))), asset)
  for (const identity of [{ contentSHA256: output.contentSHA256 }, { contentSHA256: '0'.repeat(64) }, null]) assert.deepEqual(JSON.parse(engine.AryaMusic.importDecisionJSON(JSON.stringify(asset), JSON.stringify(technical), identity ? JSON.stringify(identity) : '')), musicImportDecision(asset, technical, identity))
  for (const digest of [null, 42, 'BAD', 'A'.repeat(64)]) assert.throws(() => musicAssetRecord(score, { ...receipt, contentSHA256: digest }), /digest/)
})

test('exact bytes retain authored name/score/provenance; ordinary and unknown renderer imports remain ordinary', async t => {
  const { root, output, asset, technical } = await rendered(t), changedProbe = { ...technical, bitrate: 2304000 }
  const decision = await reimportMusicAsset(root, output.path, asset, changedProbe)
  assert.equal(decision.disposition, 'unchanged'); assert.equal(decision.asset.name, score.title)
  assert.deepEqual(decision.asset.generated, asset.generated); assert.equal(decision.asset.bitrate, 2304000); await decision.validate()
  for (const ordinary of [undefined, { name: 'Old file' }, { generated: { ...asset.generated, renderer: 'someone-else/1' } }]) assert.deepEqual(await reimportMusicAsset(root, 'ordinary.wav', ordinary, technical), { asset: technical, disposition: 'ordinary' })
})

test('changed PCM bytes with identical probe shape use ordinary replacement metadata, never old score attribution', async t => {
  const { root, output, asset, technical, file } = await rendered(t)
  mutate(file); const afterProbe = await probe(root, output.path)
  assert.deepEqual(afterProbe, technical, 'duration, codec, size and channels cannot establish byte identity')
  const decision = await reimportMusicAsset(root, output.path, asset, afterProbe)
  assert.equal(decision.disposition, 'replaced'); assert.deepEqual(decision.asset, technical)
  assert.equal(decision.asset.generated, undefined); assert.equal(decision.asset.name, undefined); assert.match(decision.message, /removed its saved score/)
})

test('actual import route keeps legacy-only Media/version/history unchanged and admits other files in mixed batch', async t => {
  const { root, output, asset, file } = await rendered(t), legacy = structuredClone(asset)
  delete legacy.generated.contentSHA256; delete legacy.generated.contentBytes
  const h = harness(root, { ...newProject('Legacy QA'), assets: { [output.path]: legacy } }), before = JSON.stringify(h.state.project)
  const receipt = await h.import([output.path])
  assert.equal(Object.keys(receipt.assets).length, 0); assert.equal(receipt.failures.length, 1)
  assert.equal(receipt.failures[0].stage, 'identity'); assert.match(receipt.failures[0].error, /kept unchanged/)
  assert.equal(JSON.stringify(h.state.project), before); assert.equal(h.state.version, 0); assert.equal(h.history.length, 0)
  fs.copyFileSync(file, path.join(root, 'ordinary.wav')); const mixed = await h.import([output.path, 'ordinary.wav'])
  assert.deepEqual(Object.keys(mixed.assets), ['ordinary.wav']); assert.equal(mixed.failures.length, 1)
  assert.deepEqual(h.state.project.assets[output.path], legacy); assert.equal(h.history.length, 1)
})

test('actual import route and UI surface replacement warnings and preserve exact-byte generation on mixed imports', async t => {
  const { root, output, asset, file } = await rendered(t); fs.copyFileSync(file, path.join(root, 'ordinary.wav'))
  const h = harness(root, { ...newProject('Reimport QA'), assets: { [output.path]: asset } }), exact = await h.import([output.path, 'ordinary.wav'])
  assert.equal(exact.failures.length, 0); assert.equal(exact.warnings.length, 0); assert.deepEqual(h.state.project.assets[output.path].generated, asset.generated)
  mutate(file); const messages = []
  const result = await importMediaPaths([output.path], { request: async () => h.import([output.path]), notify: (text, kind) => messages.push({ text, kind }) })
  assert.equal(result.count, 1); assert.equal(h.state.project.assets[output.path].generated, undefined)
  assert.ok(messages.some(item => item.kind === 'info' && /removed its saved score/.test(item.text)))
  assert.equal(h.state.project.assets['ordinary.wav'].generated, undefined)
})

test('legacy UI receipt explains saved score retained without claiming successful import', async t => {
  const { root, output, asset } = await rendered(t), legacy = structuredClone(asset); delete legacy.generated.contentSHA256
  const h = harness(root, { ...newProject('Legacy UI QA'), assets: { [output.path]: legacy } }), messages = []
  const result = await importMediaPaths([output.path], { request: async () => h.import([output.path]), notify: (text, kind) => messages.push({ text, kind }) })
  assert.equal(result.count, 0); assert.ok(messages.some(item => item.kind === 'error' && /kept unchanged/.test(item.text)))
  assert.ok(messages.every(item => !item.text.startsWith('Imported ')))
})

test('changed digest music is rejected before placement without rewriting Media; old no-digest score stays placeable', async t => {
  const { root, output, asset, file } = await rendered(t), h = harness(root, { ...newProject('Place identity QA'), assets: { [output.path]: asset } })
  mutate(file); const before = JSON.stringify(h.state.project), place = h.music['POST /api/audio/compose/place']
  await assert.rejects(place({ path: output.path, track: 'A3', comp: null, start: 2, expectedVersion: 0 }), /changed.*Re-import/)
  assert.equal(JSON.stringify(h.state.project), before); assert.equal(h.state.version, 0); assert.equal(h.history.length, 0)
  const legacy = structuredClone(asset); delete legacy.generated.contentSHA256; delete legacy.generated.contentBytes
  h.state.project = { ...h.state.project, assets: { [output.path]: legacy } }
  const result = await place({ path: output.path, track: 'A3', comp: null, start: 2, expectedVersion: 0 })
  assert.equal(result.state, 'complete'); assert.deepEqual(h.state.project.assets[output.path], legacy)
})

test('compose validates owned bytes again after registration before placement', async t => {
  const root = owned(t), h = harness(root), routes = musicRoutes({ ROOT: root, getProject: () => h.state.project, getVersion: () => h.state.version, getProjectGeneration: () => 0, probe: h.state.probe, callAPI: async (method, route, body) => {
    if (method === 'GET') return { project: h.state.project, version: h.state.version }
    const result = applyOps(h.state.project, body.ops); h.state.commit(result.project)
    if (body.ops[0].op === 'import') mutate(path.join(root, Object.keys(body.ops[0].assets)[0]))
    return { version: h.state.version, created: result.created }
  } }).routes
  const result = await routes['POST /api/audio/compose']({ score, track: 'A3', comp: null, start: 0, expectedVersion: 0 })
  assert.equal(result.state, 'asset_ready'); assert.equal(h.history.length, 1)
  assert.equal(h.state.project.tracks.find(track => track.id === 'A3').clips.length, 0)
  assert.equal(h.state.project.assets[result.path].generated.contentSHA256.length, 64)
})

for (const boundary of ['final symlink', 'parent symlink', 'hardlink', 'shared-write', 'FIFO', 'outside path']) test(`owned identity rejects ${boundary} without reading/modifying its target`, async t => {
  const { root, output, file } = await rendered(t), original = fs.readFileSync(file), foreign = path.join(root, 'foreign.wav')
  fs.writeFileSync(foreign, original, { mode: 0o600 }); let src = output.path
  if (boundary === 'final symlink') { fs.unlinkSync(file); fs.symlinkSync(foreign, file) }
  if (boundary === 'parent symlink') { const dir = path.dirname(file); fs.renameSync(dir, dir + '-old'); fs.symlinkSync(dir + '-old', dir) }
  if (boundary === 'hardlink') fs.linkSync(file, path.join(root, 'second.wav'))
  if (boundary === 'shared-write') fs.chmodSync(file, 0o666)
  if (boundary === 'FIFO') { fs.unlinkSync(file); await exec('mkfifo', [file]) }
  if (boundary === 'outside path') src = '../foreign.wav'
  await assert.rejects(musicFileIdentity(root, src), /symbolic|owned|regular|generated/i); assert.deepEqual(fs.readFileSync(foreign), original)
})
for (const change of ['mutate', 'truncate', 'grow', 'replace inode']) test(`stable descriptor rejects ${change} during bounded read`, async t => {
  const { root, output, file } = await rendered(t)
  await assert.rejects(musicFileIdentity(root, output.path, { afterDescriptorValidation: () => {
    if (change === 'mutate') mutate(file)
    if (change === 'truncate') fs.truncateSync(file, 44)
    if (change === 'grow') fs.appendFileSync(file, Buffer.from([1]))
    if (change === 'replace inode') { fs.renameSync(file, file + '.old'); fs.copyFileSync(file + '.old', file); fs.chmodSync(file, 0o600) }
  } }), /changed|ended|grew/)
})

test('oversized replacement has no content hash and post-read mutation invalidates publication', async t => {
  const { root, output, file } = await rendered(t), captured = await musicFileIdentity(root, output.path)
  mutate(file); await assert.rejects(captured.validate(), /changed/)
  fs.truncateSync(file, MAX_MUSIC_WAV_BYTES + 1); await assert.rejects(musicFileIdentity(root, output.path), /byte limit/)
  const oversized = await musicFileIdentity(root, output.path, { allowOversized: true })
  assert.equal(oversized.contentSHA256, null); assert.equal(oversized.contentBytes, MAX_MUSIC_WAV_BYTES + 1)
})

test('cancellation interrupts verification and actual import final validation catches a later file mutation', async t => {
  const { root, output, asset, file } = await rendered(t); let checks = 0
  await assert.rejects(musicFileIdentity(root, output.path, { assertCurrent: () => { if (++checks === 2) throw Error('Run cancelled') } }), /cancelled/)
  const h = harness(root, { ...newProject('Changed during batch'), assets: { [output.path]: asset } })
  fs.copyFileSync(file, path.join(root, 'later.wav')); h.state.probe = async src => { const result = await probe(root, src); if (src === 'later.wav') mutate(file); return result }
  const receipt = await h.import([output.path, 'later.wav'])
  assert.deepEqual(Object.keys(receipt.assets), ['later.wav']); assert.equal(receipt.failures[0].stage, 'identity'); assert.deepEqual(h.state.project.assets[output.path], asset)
})

for (const boundary of ['legacy', 'FIFO', 'hardlink']) test(`actual import admission rejects ${boundary} before invoking the media probe`, async t => {
  const { root, output, asset, file } = await rendered(t), saved = structuredClone(asset)
  if (boundary === 'legacy') delete saved.generated.contentSHA256
  if (boundary === 'FIFO') { fs.unlinkSync(file); await exec('mkfifo', [file]) }
  if (boundary === 'hardlink') fs.linkSync(file, path.join(root, 'linked.wav'))
  const h = harness(root, { ...newProject('Early admission'), assets: { [output.path]: saved } }); let probes = 0
  h.state.probe = async () => { probes++; throw Error('The media probe must not be invoked') }
  const before = JSON.stringify(h.state.project), receipt = await h.import([output.path])
  assert.equal(probes, 0); assert.equal(Object.keys(receipt.assets).length, 0); assert.equal(receipt.failures.length, 1)
  assert.equal(receipt.failures[0].stage, 'identity'); assert.equal(JSON.stringify(h.state.project), before); assert.equal(h.history.length, 0)
})

test('digest-bearing placement admission rejects a FIFO before invoking its media probe', async t => {
  const { root, output, asset, file } = await rendered(t), h = harness(root, { ...newProject('Early placement'), assets: { [output.path]: asset } })
  fs.unlinkSync(file); await exec('mkfifo', [file]); let probes = 0
  const routes = musicRoutes({ ROOT: root, getProject: () => h.state.project, probe: async () => { probes++; throw Error('Probe must not read a FIFO') }, callAPI: async () => ({ project: h.state.project, version: 0 }) }).routes
  await assert.rejects(routes['POST /api/audio/compose/place']({ path: output.path, track: 'A3', start: 2, comp: null, expectedVersion: 0 }), /owned regular/)
  assert.equal(probes, 0); assert.equal(h.history.length, 0)
})
