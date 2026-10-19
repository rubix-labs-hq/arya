import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createProcessingAdmission, captureProcessingIdentity, processingCancelled } from '../core/processing-admission.mjs'
import { applyOps, newProject } from '../core/project.js'
import { ProjectRecovery, recoveryProject } from '../core/project-recovery.mjs'
import { prepareLibraryOps, verifyLibraryInputs } from '../core/library-resources.js'
import { musicAssetRecord, validateMusicScore } from '../core/music-score.js'
import { renderMusicWAV } from '../music/render-score.mjs'
import { confinedFile } from '../agent/browser-assistant.mjs'
import { createToolOutcomes, recordToolOutcome, unresolvedToolOutcome } from '../agent/tool-outcomes.mjs'
import musicRoutes from '../routes/music.mjs'
import { recoveryDouble } from './support/recovery-double.mjs'

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
const score = { version: 1, title: 'Retained cue', bpm: 120, lengthBeats: 2, seed: 17, room: 0, parts: [{ id: 'bass', instrument: 'bass', gainDb: -12, pan: 0, notes: [{ at: 0.5, duration: 0.5, pitch: 69, velocity: 0.7 }] }] }
const request = { score, track: 'A3', start: 0, expectedVersion: 7 }
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve } }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const functionBody = name => {
  const plain = `function ${name}(`, async = `async ${plain}`
  const start = server.includes(async) ? server.indexOf(async) : server.indexOf(plain), firstLine = server.indexOf('\n', start)
  assert.ok(start >= 0 && firstLine > start, `The actual ${name} function must exist`)
  if (server.slice(start, firstLine).trimEnd().endsWith('}')) return server.slice(start, firstLine)
  const end = server.indexOf('\n}\n', start)
  assert.ok(end > start, `The actual ${name} function must be complete`)
  return server.slice(start, end + 2)
}
const routeBody = name => {
  const start = server.indexOf(`'${name}':`), end = server.indexOf('\n  },', start)
  assert.ok(start >= 0 && end > start, `The actual ${name} handler must exist`)
  return server.slice(start, end + 4)
}

// This fixture uses the actual server wrapper, route context, probe, processing child,
// publication and history functions. It renders real owned WAVs. The ffprobe process
// returns metadata read from the WAV header; the writer and recovery journal are doubles.
function fixture(t, { held = false, assistant = true, afterImport } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-compose-admission-'))
  const initial = newProject('Original project'), file = path.join(root, 'reel.project.json')
  fs.writeFileSync(file, JSON.stringify(initial), { mode: 0o600 })
  const entered = deferred(), released = deferred(), pending = new Set(), controls = { held, entered, released, afterImport, probeCount: 0, probeAsset: null, cancelled: false, writeFailure: false }
  const contextStart = server.indexOf('const routeCtx = {'), contextEnd = server.indexOf('\n}\n', contextStart)
  assert.ok(contextStart >= 0 && contextEnd > contextStart)
  const context = server.slice(contextStart, contextEnd + 2)
  const wrapper = server.match(/^        routes\[key\] = key === 'POST \/api\/audio\/compose'[^]*? : fn$/m)
  assert.ok(wrapper, 'Exercise the compose-only wrapper and strict placement wrapper from the actual loader')
  assert.match(wrapper[0], /compose\/place' \? \(\.\.\.args\) => admit\(/)
  const projectRoute = server.match(/^  'GET \/api\/project': .*$/m)
  assert.ok(projectRoute)
  const make = new Function('AsyncLocalStorage', 'createProcessingAdmission', 'captureProcessingIdentity', 'processingCancelled', 'applyOps', 'newProject', 'ProjectRecovery', 'recoveryProject', 'recoveryDouble', 'prepareLibraryOps', 'verifyLibraryInputs', 'musicAssetRecord', 'confinedFile', 'musicRoutes', 'fs', 'path', 'ROOT', 'initial', 'controls', `
    const FILE = path.join(ROOT, 'reel.project.json'), DOT = path.join(ROOT, '.reel'), CACHE = path.join(DOT, 'cache'), HERE = ROOT, CHROME = '/missing-fixture-chrome';
    let project = initial, version = 7, projectEpoch = 2, lastText = JSON.stringify(initial), recoveryState = {status:'valid'};
    const assistantCalls = new AsyncLocalStorage(), processing = createProcessingAdmission(), musicCompositions = new WeakMap(), assistantReview = { commitBy() {} };
    const past = [], future = [], activity = [], chat = [], jobs = new Map(), writes = [], calls = [], origins = [], scopes = [];
    const chatHistory = {status:()=>({})}, claude = {}, transcriptService = {}, assistantService = {};
    const broadcast = () => {}, pushActivity = () => {}, log = () => {}, once = (_key, fn) => fn(), jobPublic = job => job;
    const readBody = () => {}, readJson = () => {}, send = () => {}, serveFile = () => {};
    const cacheKey = () => {throw new Error('Music must not create video proxies')}, ensureProxy = async () => {};
    const loadFromDisk = () => {throw new Error('Unexpected disk refresh in the music boundary fixture')};
    const recovery = recoveryDouble(ROOT, fs);
    const rootRecovery = new ProjectRecovery(ROOT); recovery.assertRoot = () => rootRecovery.assertRoot();
    const writeProjectAtomic = (_root, text, expected) => {
      if (controls.writeFailure) throw new Error('Fixture writer refused publication');
      if (fs.readFileSync(FILE, 'utf8') !== expected) throw new Error('Fixture disk changed before publication');
      fs.writeFileSync(FILE, text); writes.push(JSON.parse(text)); return {directorySynced:true};
    };
    const runProcessingProcess = async (command, argv, options) => {
      assertProbe(command, argv);
      const source = argv.at(-1); controls.probeCount++; controls.source = source; controls.entered.resolve();
      const bytes = fs.readFileSync(source), metadata = {streams:[{codec_type:'audio',codec_name:'pcm_s24le',channels:bytes.readUInt16LE(22),sample_rate:String(bytes.readUInt32LE(24))}],format:{duration:String((bytes.length-44)/6/48000),size:String(bytes.length)}};
      if (controls.held) await controls.released.promise;
      if (options.signal.aborted) throw processingCancelled();
      if (controls.probeAsset === 'bad') metadata.streams=[];
      if (controls.probeAsset === 'size') metadata.format.size=String(bytes.length+1);
      return {stdout:JSON.stringify(metadata),stderr:''};
    };
    function assertProbe(command, argv) {if(command!=='ffprobe' || argv[0]!=='-v' || !argv.at(-1).startsWith(ROOT+path.sep)) throw new Error('Only the owned generated WAV may be probed')}
    ${['rememberProject', 'persist', 'captureProcessing', 'admit', 'admitMusicCompose', 'musicComposeContext', 'assertAssistantPublication', 'commit', 'resolveMedia', 'run', 'probe'].map(functionBody).join('\n')}
    const routes = {${projectRoute[0].trim().replace(/,$/, '')}, ${['POST /api/ops', 'POST /api/undo', 'POST /api/redo'].map(routeBody).join(',\n')}};
    const actualOps = routes['POST /api/ops'];
    routes['POST /api/ops'] = async body => {
      calls.push(structuredClone(body)); const result = await actualOps(body);
      if (body.ops?.[0]?.op==='import') await controls.afterImport?.(body, result);
      return result;
    };
    ${context}
    const raw = musicRoutes(routeCtx).routes;
    for (const [key,fn] of Object.entries(raw)) {${wrapper[0]}}
    const origin = () => {
      const generation = projectEpoch, call = {version,assertCurrent(){if(controls.cancelled) throw new Error('Assistant run cancelled'); if(projectEpoch!==generation) throw new Error('Assistant project replaced')},acceptIdentity(next){if(next!==generation) throw new Error('Unexpected accepted project identity')}};
      origins.push(call); return call;
    };
    return {root:ROOT,file:FILE,controls,writes,calls,origins,
      state:()=>({project,version,generation:projectEpoch,past:[...past],future:[...future]}), snapshot:()=>processing.snapshot(),
      invoke(key, body, assistant) {return assistantCalls.run(assistant?origin():undefined,()=>routes[key](body))},
      external(ops) {return assistantCalls.run(undefined,()=>actualOps({ops,expectedVersion:version}))},
      staleWrite(call) {return assistantCalls.run(call,()=>actualOps({ops:[{op:'project',set:{name:'Forbidden stale edit'}}],expectedVersion:version}))},
      undo:()=>assistantCalls.run(undefined,()=>routes['POST /api/undo']()),
      strict(work) {return admit(work)},
      scoped(work) {return assistantCalls.run(origin(),()=>admitMusicCompose(()=>work(musicComposeContext())))},
      replace() {project=newProject('Replacement project');version++;projectEpoch++;lastText=JSON.stringify(project);fs.writeFileSync(FILE,lastText)},
      close:()=>processing.close()
    };
  `)
  const f = make(AsyncLocalStorage, createProcessingAdmission, captureProcessingIdentity, processingCancelled, applyOps, newProject, ProjectRecovery, recoveryProject, recoveryDouble, prepareLibraryOps, verifyLibraryInputs, musicAssetRecord, confinedFile, musicRoutes, fs, path, root, initial, controls)
  const invoke = f.invoke
  f.invoke = (...args) => { const promise = Promise.resolve().then(() => invoke(...args)); pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}); return promise }
  f.compose = body => f.invoke('POST /api/audio/compose', body ?? request, assistant)
  f.place = body => f.invoke('POST /api/audio/compose/place', body, assistant)
  f.started = entered.promise; f.release = () => { controls.held = false; released.resolve() }
  t.after(async () => { f.release(); f.close(); await Promise.allSettled([...pending]); fs.rmSync(root, { recursive: true, force: true }) })
  return f
}

test('actual assistant compose wrapper saves complete WAV after an ordinary edit without stale placement', async t => {
  const f = fixture(t, { held: true }), composing = f.compose()
  await f.started
  assert.equal(f.snapshot().active, 1)
  const bytes = fs.readFileSync(f.controls.source)
  await f.external([{ op: 'project', set: { name: 'User changed project' } }])
  f.release()
  const result = await composing, state = f.state(), asset = state.project.assets[result.path]
  assert.equal(result.state, 'asset_ready'); assert.equal(result.placement.state, 'failed')
  assert.equal(state.project.name, 'User changed project'); assert.equal(state.version, 9); assert.equal(state.generation, 2)
  assert.deepEqual(Object.keys(state.project.assets), [result.path]); assert.equal(state.project.tracks.find(track => track.id === 'A3').clips.length, 0)
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].expectedVersion, 8); assert.deepEqual(f.calls[0].ops.map(op => op.op), ['import'])
  assert.deepEqual(asset.generated.score, validateMusicScore(score)); assert.equal(asset.generated.contentSHA256, hash(bytes)); assert.equal(asset.generated.contentBytes, bytes.length)
  assert.deepEqual(fs.readFileSync(f.controls.source), bytes); assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).assets[result.path], JSON.parse(JSON.stringify(asset)))
  assert.equal(f.origins[0].version, 7, 'Ordinary edits never advance the original assistant write guard')
  await assert.rejects(f.staleWrite(f.origins[0]), /project changed while the assistant tool ran/)
  assert.equal(f.state().project.name, 'User changed project'); assert.equal(f.state().version, 9)
  const outcomes = createToolOutcomes(); recordToolOutcome(outcomes, { method: 'POST', path: '/api/audio/compose', body: request }, result)
  assert.match(unresolvedToolOutcome(outcomes), /saved in Media.*requested edit was not applied/)
  const placed = await f.place({ path: result.path, track: 'A3', start: 2, expectedVersion: 9 })
  assert.equal(placed.state, 'complete'); assert.equal(f.controls.probeCount, 2); assert.equal(Object.keys(f.state().project.assets).length, 1)
  assert.deepEqual(fs.readFileSync(f.controls.source), bytes); assert.equal(f.state().project.tracks.find(track => track.id === 'A3').clips[0].src, result.path)
  f.undo(); assert.ok(f.state().project.assets[result.path]); assert.equal(f.state().project.name, 'User changed project')
  assert.equal(f.state().project.tracks.find(track => track.id === 'A3').clips.length, 0)
  assert.deepEqual(f.snapshot(), { capacity: 8, concurrency: 1, active: 0, queued: 0, draining: 0 })
})

test('unchanged assistant composition retains separate import and explicit scoped placement', async t => {
  const f = fixture(t), result = await f.compose()
  assert.equal(result.state, 'complete'); assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls.map(call => call.ops.map(op => op.op)), [['import'], ['add_clip']])
  assert.deepEqual(f.calls.map(call => call.expectedVersion), [7, 8]); assert.equal(f.origins[0].version, 9)
  assert.equal(f.state().project.tracks.find(track => track.id === 'A3').clips[0].src, result.path)
  f.undo(); assert.ok(f.state().project.assets[result.path]); assert.equal(f.state().project.tracks.find(track => track.id === 'A3').clips.length, 0)
})

test('an ordinary edit after import prevents automatic placement and retains the saved WAV', async t => {
  let f
  f = fixture(t, { afterImport: () => f.external([{ op: 'project', set: { name: 'Edited after import' } }]) })
  const result = await f.compose()
  assert.equal(result.state, 'asset_ready'); assert.equal(f.state().project.name, 'Edited after import')
  assert.equal(f.state().version, 9); assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls.map(call => call.ops.map(op => op.op)), [['import'], ['add_clip']])
  assert.equal(f.calls[1].expectedVersion, 8); assert.equal(f.writes.length, 2, 'Only the import and user edit publish')
  assert.equal(f.state().project.tracks.find(track => track.id === 'A3').clips.length, 0)
  assert.ok(f.state().project.assets[result.path]); assert.ok(fs.existsSync(path.join(f.root, result.path)))
  assert.equal(f.origins[0].version, 8, 'The own import never grants the later user edit version')
  await assert.rejects(f.staleWrite(f.origins[0]), /project changed while the assistant tool ran/)
})

test('manual compose uses the same retention guard after an ordinary edit', async t => {
  const f = fixture(t, { held: true, assistant: false }), composing = f.compose()
  await f.started; await f.external([{ op: 'project', set: { name: 'Manual edit' } }]); f.release()
  const result = await composing
  assert.equal(result.state, 'asset_ready'); assert.equal(f.state().project.name, 'Manual edit')
  assert.ok(f.state().project.assets[result.path]); assert.equal(f.state().project.tracks.find(track => track.id === 'A3').clips.length, 0)
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].expectedVersion, 8)
})

for (const boundary of ['replacement', 'root replacement', 'disk change', 'missing disk', 'cancellation', 'lease cancellation']) test(`compose wrapper refuses ${boundary} before registration and drains its probe child`, async t => {
  const f = fixture(t, { held: true }), composing = f.compose()
  await f.started
  const original = fs.readFileSync(f.controls.source)
  let detached, foreign
  if (boundary === 'replacement') f.replace()
  if (boundary === 'root replacement') {
    detached = f.root + '.original'; fs.renameSync(f.root, detached); fs.mkdirSync(f.root)
    foreign = Buffer.from(original); foreign[44] ^= 1
    fs.mkdirSync(path.dirname(f.controls.source), { recursive: true }); fs.writeFileSync(f.controls.source, foreign, { mode: 0o600 })
    fs.writeFileSync(f.file, JSON.stringify(newProject('Foreign root')))
    t.after(() => fs.rmSync(detached, { recursive: true, force: true }))
  }
  if (boundary === 'disk change') fs.writeFileSync(f.file, JSON.stringify(newProject('External disk project')))
  if (boundary === 'missing disk') fs.unlinkSync(f.file)
  if (boundary === 'cancellation') f.controls.cancelled = true
  if (boundary === 'lease cancellation') f.close()
  assert.equal(f.snapshot().active, 1); assert.equal(f.calls.length, 0)
  assert.equal(f.snapshot().draining, boundary === 'lease cancellation' ? 1 : 0)
  f.release()
  await assert.rejects(composing, boundary === 'root replacement'
    ? /The generated music file changed during verification|project folder changed/
    : /replaced|project folder changed|changed on disk|cancelled/)
  assert.deepEqual(f.state().project.assets, {}); assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0)
  if (boundary === 'root replacement') {
    assert.deepEqual(fs.readFileSync(f.controls.source), foreign)
    assert.deepEqual(fs.readFileSync(path.join(detached, path.relative(f.root, f.controls.source))), original)
  } else assert.equal(fs.existsSync(f.controls.source), false)
  assert.ok(original.length > 44)
  assert.equal(f.state().project.tracks.find(track => track.id === 'A3').clips.length, 0)
  assert.deepEqual(f.snapshot(), { capacity: 8, concurrency: 1, active: 0, queued: 0, draining: 0 })
})

for (const change of ['PCM mutation', 'inode replacement']) test(`completed output ${change} rejects admission and cleanup preserves the changed file`, async t => {
  const f = fixture(t, { held: true }), composing = f.compose()
  await f.started
  const file = f.controls.source, bytes = fs.readFileSync(file); bytes[44 + 8000 * 6] ^= 1
  if (change === 'inode replacement') { fs.renameSync(file, file + '.original'); fs.writeFileSync(file, bytes, { mode: 0o600 }) }
  else fs.writeFileSync(file, bytes)
  f.release()
  await assert.rejects(composing, /generated music file changed/)
  assert.deepEqual(fs.readFileSync(file), bytes); assert.deepEqual(f.state().project.assets, {})
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0)
})

for (const probeAsset of ['bad', 'size']) test(`invalid completed ${probeAsset} probe cannot register music`, async t => {
  const f = fixture(t); f.controls.probeAsset = probeAsset
  await assert.rejects(f.compose(), /probe|complete owned WAV/)
  assert.deepEqual(f.state().project.assets, {}); assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0)
  assert.equal(fs.existsSync(f.controls.source), false)
})

for (const failure of ['read-only project', 'writer refusal']) test(`music admission preserves publication checks for ${failure}`, async t => {
  const f = fixture(t, { held: true }), composing = f.compose()
  await f.started
  if (failure === 'read-only project') fs.chmodSync(f.file, 0o400)
  else f.controls.writeFailure = true
  f.release()
  await assert.rejects(composing, /read-only|writer refused/)
  assert.deepEqual(f.state().project.assets, {}); assert.equal(f.state().version, 7); assert.equal(f.writes.length, 0)
  assert.equal(fs.existsSync(f.controls.source), false)
})

for (const boundary of ['assistant', 'lease']) test(`${boundary} cancellation after Media publication preserves the committed WAV and refuses placement`, async t => {
  let f
  f = fixture(t, { afterImport: () => { if (boundary === 'assistant') f.controls.cancelled = true; else f.close() } })
  await assert.rejects(f.compose(), /cancelled/i)
  const assets = f.state().project.assets, paths = Object.keys(assets)
  assert.equal(paths.length, 1); assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].ops.map(op => op.op), ['import'])
  assert.equal(f.state().project.tracks.find(track => track.id === 'A3').clips.length, 0)
  const bytes = fs.readFileSync(path.join(f.root, paths[0])); assert.equal(hash(bytes), assets[paths[0]].generated.contentSHA256)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).assets, JSON.parse(JSON.stringify(assets)))
  assert.deepEqual(f.snapshot(), { capacity: 8, concurrency: 1, active: 0, queued: 0, draining: 0 })
})

test('place-existing keeps strict admission when an edit arrives during its own probe', async t => {
  const f = fixture(t), composed = await f.compose()
  f.undo(); const before = f.state().version, bytes = fs.readFileSync(path.join(f.root, composed.path))
  f.controls.held = true
  const entered = deferred(); f.controls.entered = entered
  const placing = f.place({ path: composed.path, track: 'A3', start: 2, expectedVersion: before })
  await entered.promise
  await f.external([{ op: 'project', set: { name: 'Edit while placing' } }])
  f.release(); await assert.rejects(placing, /project changed/)
  assert.equal(f.state().project.name, 'Edit while placing'); assert.ok(f.state().project.assets[composed.path])
  assert.equal(f.state().project.tracks.find(track => track.id === 'A3').clips.length, 0)
  assert.deepEqual(fs.readFileSync(path.join(f.root, composed.path)), bytes); assert.equal(f.calls.length, 2)
})

test('generic processing identity still rejects ordinary version drift', async t => {
  const f = fixture(t), entered = deferred(), released = deferred()
  t.after(() => released.resolve())
  const processing = f.strict(async () => { entered.resolve(); await released.promise })
  await entered.promise; await f.external([{ op: 'project', set: { name: 'Generic edit' } }]); released.resolve()
  await assert.rejects(processing, /project changed while processing/)
  assert.equal(f.state().project.name, 'Generic edit'); assert.equal(f.calls.length, 0)
})

test('cancelled queued composition starts no render and cannot outlive the occupying reservation', async t => {
  const f = fixture(t), entered = deferred(), released = deferred()
  t.after(() => released.resolve())
  const occupying = f.strict(async () => { entered.resolve(); await released.promise })
  await entered.promise
  const composing = f.compose(); await Promise.resolve(); await Promise.resolve()
  assert.equal(f.snapshot().active, 1); assert.equal(f.snapshot().queued, 1)
  f.controls.cancelled = true
  assert.equal(f.controls.probeCount, 0)
  released.resolve(); await occupying; await assert.rejects(composing, /Assistant run cancelled/)
  assert.equal(f.controls.probeCount, 0); assert.equal(f.calls.length, 0); assert.deepEqual(f.state().project.assets, {})
  assert.equal(fs.existsSync(path.join(f.root, 'media')), false)
  assert.deepEqual(f.snapshot(), { capacity: 8, concurrency: 1, active: 0, queued: 0, draining: 0 })
})

test('composition refuses a nested generic reservation instead of weakening its identity', async t => {
  const f = fixture(t)
  await assert.rejects(f.strict(() => f.scoped(() => {})), /requires its own processing reservation/)
  assert.equal(f.controls.probeCount, 0); assert.equal(f.calls.length, 0); assert.deepEqual(f.state().project.assets, {})
  assert.deepEqual(f.snapshot(), { capacity: 8, concurrency: 1, active: 0, queued: 0, draining: 0 })
})

test('private composition capability refuses another receipt and cannot survive reservation drain', async t => {
  const f = fixture(t); let captured
  await f.scoped(async scope => {
    captured = scope
    const rendered = await renderMusicWAV(f.root, score, { assertCurrent: scope.assertCurrent }), asset = await scope.probe(rendered)
    await assert.rejects(scope.register({ ...rendered }, score, asset), /WAV probed by this composition/)
    assert.equal(f.calls.length, 0)
  })
  assert.throws(() => captured.assertCurrent(), /reservation has drained/)
  await assert.rejects(captured.register({}, score, {}), /reservation has drained/)
  assert.equal(f.calls.length, 0); assert.deepEqual(f.state().project.assets, {})
})

for (const field of ['frames', 'sampleRate', 'channels', 'score', 'contentSHA256', 'path', 'validateIdentity']) test(`private admission rejects a mismatched completed ${field} receipt`, async t => {
  const f = fixture(t)
  await f.scoped(async scope => {
    const rendered = await renderMusicWAV(f.root, score, { assertCurrent: scope.assertCurrent }), asset = await scope.probe(rendered)
    if (field === 'frames') rendered.frames++
    if (field === 'sampleRate') rendered.sampleRate = 44100
    if (field === 'channels') rendered.channels = 1
    if (field === 'score') rendered.score = { ...rendered.score, title: 'Another score' }
    if (field === 'contentSHA256') rendered.contentSHA256 = '0'.repeat(64)
    if (field === 'path') rendered.path = rendered.path.replace('score.wav', 'another.wav')
    if (field === 'validateIdentity') rendered.validateIdentity = async () => {}
    await assert.rejects(scope.register(rendered, score, asset), /complete owned WAV|WAV probed by this composition/)
    assert.equal(f.calls.length, 0); assert.deepEqual(f.state().project.assets, {})
  })
})

test('private music admission refuses an occupied Media path without changing its existing entry', async t => {
  const f = fixture(t)
  await f.scoped(async scope => {
    const rendered = await renderMusicWAV(f.root, score, { assertCurrent: scope.assertCurrent }), asset = await scope.probe(rendered)
    const existing = { ...asset, name: 'Existing user entry' }
    await f.external([{ op: 'import', assets: { [rendered.path]: existing } }])
    await assert.rejects(scope.register(rendered, score, asset), /already belongs to a Media asset/)
    assert.deepEqual(f.state().project.assets[rendered.path], existing); assert.equal(f.calls.length, 0)
    assert.equal(f.state().version, 8); assert.equal(f.writes.length, 1)
  })
})
