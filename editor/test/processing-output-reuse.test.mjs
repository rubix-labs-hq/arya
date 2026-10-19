import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { createProcessingAdmission } from '../core/processing-admission.mjs'
import { recoveryProject } from '../core/project-recovery.mjs'
import { recoveryDouble } from './support/recovery-double.mjs'
import { prepareLibraryOps, verifyLibraryInputs } from '../core/library-resources.js'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const editor = fileURLToPath(new URL('../', import.meta.url))
const capturedBaseDirectory = fileURLToPath(new URL('./fixtures/processing-output-reuse/captured-base/', import.meta.url))
const capturedBasePins = JSON.parse(fs.readFileSync(path.join(capturedBaseDirectory, 'provenance.json'), 'utf8')).files
const { newProject, applyOps, findClip } = await import(pathToFileURL(path.join(repo, 'editor/core/project.js')))
const { createToolOutcomes, recordToolOutcome, unresolvedToolOutcome } = await import(pathToFileURL(path.join(repo, 'editor/agent/tool-outcomes.mjs')))
const { processingCapture, createProcessingRuns } = await import(pathToFileURL(path.join(repo, 'editor/web/ui/processing-workflows.js')))
const clone = structuredClone, input = 'media/input.mp4'
const metadata = { width: 320, height: 180, duration: 10, fps: 30, hasVideo: true, hasAudio: false, still: false }
const server = fs.readFileSync(path.join(editor, 'server.mjs'), 'utf8')
let serial = 0
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve } }
const turn = () => new Promise(resolve => setImmediate(resolve))
const outcome = (kind, job) => {
  const outcomes = createToolOutcomes()
  recordToolOutcome(outcomes, { method: 'POST', path: kind === 'denoise' ? '/api/video/denoise' : kind === 'retime' ? '/api/retime' : '/api/stabilize/render' }, job)
  return unresolvedToolOutcome(outcomes)
}
const functionBody = name => {
  const start = server.indexOf(`function ${name}(`), end = server.indexOf('\n}\n', start)
  assert.ok(start >= 0 && end > start)
  return server.slice(start, end + 2)
}
const routeBody = route => {
  const start = server.indexOf(`'${route}':`), end = server.indexOf('\n  },', start)
  assert.ok(start >= 0 && end > start)
  return server.slice(start, end + 4)
}

function publication(initial, options) {
  const accessor = server.match(/getProjectGeneration: \(\) => projectEpoch,/)
  assert.ok(accessor, 'The actual route context exposes projectEpoch')
  const make = new Function('applyOps', 'initial', 'options', 'processing', 'recoveryProject', 'recoveryDouble', 'prepareLibraryOps', 'verifyLibraryInputs', `
    let project = initial, version = 7, projectEpoch = 2, lastText = JSON.stringify(initial), assistant = null;
    const ROOT = '/fixture', FILE = '/fixture/reel.project.json', past = [], future = [], publications = [], calls = [];
    const fs = { existsSync: () => true, readFileSync: () => lastText, statSync: () => ({ mode: 0o600 }) };
    const recovery = recoveryDouble(ROOT, fs);
    const assistantCalls = { getStore: () => assistant }, assistantReview = { commitBy() {} };
    const writeProjectAtomic = (_root, text) => { publications.push(text); return { directorySynced: true } };
    const loadFromDisk = () => { throw new Error('Unexpected disk refresh in a data fixture') };
    const broadcast = () => {}, pushActivity = () => {}, log = () => {}, ensureProxy = async () => {};
    const probe = async () => { throw new Error('Placement must use the separately admitted asset') };
    ${['rememberProject', 'persist', 'assertAssistantPublication', 'commit'].map(functionBody).join('\n')}
    const routes = { ${['POST /api/ops', 'POST /api/undo', 'POST /api/redo'].map(routeBody).join(',\n')} };
    const context = { getProject: () => project, getVersion: () => version, ${accessor[0]} assertCurrent: assertAssistantPublication };
    return { ...context, calls, state: () => ({ project, version, generation: projectEpoch, publications: publications.map(JSON.parse), past: [...past] }),
      async editOps(ops, who, summary, settings = {}) {
        calls.push(structuredClone({ ops, who, summary, settings }));
        if (options.refuseAdmission && ops.every(o => o.op === 'import')) throw new Error('Admission publication refused');
        if (options.refusePlacement && ops.some(o => o.op !== 'import')) throw new Error('Placement publication refused');
        return routes['POST /api/ops']({ ops, who, summary, ...settings });
      },
      async external(ops) { const saved = assistant; assistant = null; try { return await routes['POST /api/ops']({ ops }) } finally { assistant = saved } },
      assistant() { assistant = { version, assertCurrent() {}, acceptIdentity() {} } },
      undo: routes['POST /api/undo'], redo: routes['POST /api/redo'] };
  `)
  return make(applyOps, initial, options, createProcessingAdmission(), recoveryProject, recoveryDouble, prepareLibraryOps, verifyLibraryInputs)
}

async function routeModule(name, files, capturedBase = false) {
  const key = `__outputReuse${++serial}`; globalThis[key] = files
  const directory = capturedBase ? capturedBaseDirectory : editor
  const source = fs.readFileSync(path.join(directory, 'routes', name))
  if (capturedBase) assert.equal(createHash('sha256').update(source).digest('hex'), capturedBasePins[name].sha256, 'The captured route must match its authentic baseline')
  let code = source.toString('utf8')
    .replace("import fs from 'node:fs'", `const fs = globalThis[${JSON.stringify(key)}]`)
    .replace("import { spawn } from 'node:child_process'", "const spawn = () => { throw new Error('A real codec must never execute in this test') }")
    .replace("import { guardedOutput } from '../core/output-path.js'", 'const guardedOutput = (_root, file) => file')
  code = code.replace(/from '(\.\.[^']+)'/g, (_, relative) => `from ${JSON.stringify(pathToFileURL(path.resolve(relative.startsWith('../core/') ? path.join(repo, 'editor') : editor, 'routes', relative)).href)}`)
  try { return await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`) }
  finally { delete globalThis[key] }
}

async function fixture(kind, options = {}) {
  let p = newProject('Output reuse fixture', { width: 320, height: 180, fps: 30 })
  p.assets[input] = clone(metadata)
  const clip = { id: 'v', kind: 'video', src: input, start: 0, in: 1, dur: 3, speed: 1 }
  if (options.nested) p.comps = { nested: { id: 'nested', name: 'Nested', width: 320, height: 180, fps: 30, tracks: [{ id: 'V1', kind: 'video', clips: [clip] }] } }
  else p.tracks[0].clips.push(clip)
  const pub = publication(p, options), held = deferred(), started = deferred(), probeStarted = deferred()
  const artifacts = new Set(), commands = [], sourceStamp = { value: 1n }
  const files = { statSync: () => { if (sourceStamp.missing) throw new Error('Original input is missing'); return { dev: 1n, ino: 2n, size: 10n, mtimeNs: sourceStamp.value, ctimeNs: sourceStamp.value, isFile: () => true } }, realpathSync: x => x,
    existsSync: () => true, mkdirSync() {}, renameSync: (_part, out) => { assert.notEqual(out, `/fixture/${input}`); artifacts.add(out) }, rmSync: file => assert.notEqual(file, `/fixture/${input}`) }
  const ctx = { ...pub, ROOT: '/fixture', resolveMedia: src => `/fixture/${src}`, broadcast() {}, pushActivity() {}, cacheKey: async () => '0123456789abcdef',
    run: async (command, argv) => { commands.push({ command, argv }); return { stdout: command === 'ffmpeg' ? ' hqdn3d ' : JSON.stringify({ streams: [{ codec_type: 'video', index: 0, pix_fmt: options.hdr ? 'yuv420p10le' : 'yuv420p' }], format: { duration: '10' } }) } },
    videoRender: async (argv, signal) => { commands.push({ command: 'render', argv }); assert.notEqual(argv.at(-1), `/fixture/${input}`); started.resolve(); if (options.holdRender) await held.promise; if (signal.aborted) throw new Error('cancelled') },
    probe: async src => {
      assert.notEqual(src, input, 'Processed output metadata comes from its own probe')
      probeStarted.resolve(); if (options.holdProbe) await held.promise
      if (options.missing) throw new Error('Processed file is missing')
      return options.invalid ?? { ...metadata, duration: kind === 'retime' ? 6 : 3 }
    },
    callAPI: async (method, route, body) => { assert.equal(method, 'POST'); assert.equal(route, '/api/ops'); return pub.editOps(body.ops, body.who, body.summary, { expectedVersion: body.expectedVersion, returnProject: body.returnProject }) },
  }
  const mod = await routeModule(kind === 'denoise' ? 'video-processing.mjs' : 'analysis.mjs', files, options.capturedBase), routes = mod.default(ctx).routes
  const body = { src: input, in: 1, dur: 3, speed: 0.5, clip: options.noTarget ? undefined : 'v', comp: options.nested ? 'nested' : null, expectedVersion: 7, apply: options.apply ?? true, wait: false }
  const endpoint = kind === 'denoise' ? 'POST /api/video/denoise' : kind === 'retime' ? 'POST /api/retime' : 'POST /api/stabilize/render'
  const start = () => routes[endpoint](body)
  const wait = job => routes[kind === 'denoise' ? 'GET /api/video/jobs/wait' : 'GET /api/analysis/jobs/wait']({}, new URLSearchParams({ id: job.id }))
  return { kind, body, routes, pub, ctx, start, wait, release: held.resolve, started: started.promise, probeStarted: probeStarted.promise, commands, artifacts, sourceStamp }
}

for (const kind of ['denoise', 'retime', 'stabilize']) {
  test(`${kind} apply:false independently admits a reusable copy with persistent provenance`, async () => {
    const f = await fixture(kind, { apply: false }), job = await f.wait(await f.start()), state = f.pub.state()
    assert.equal(job.state, 'done'); assert.equal(job.assetRegistered, true); assert.equal(job.placementRequested, false); assert.equal(Object.hasOwn(job, 'applied'), false)
    assert.equal(outcome(kind, job), null, 'The actual assistant classifier accepts intentional result-only output')
    assert.equal(f.pub.calls.length, 1); assert.deepEqual(f.pub.calls[0].ops.map(o => o.op), ['import']); assert.equal(f.pub.calls[0].settings.expectedVersion, 7)
    assert.equal(findClip(state.project, 'v').clip.src, input); assert.deepEqual(state.project.assets[input], metadata)
    const reopened = JSON.parse(JSON.stringify(state.project)), processing = reopened.assets[job.output].processing
    assert.equal(processing.kind, `video-${kind}`); assert.equal(processing.source, input); assert.deepEqual(processing.range, { in: 1, dur: 3 })
    assert.equal(processing.output, job.output); assert.equal(processing.compute, 'cpu'); assert.equal(processing.version, 1)
    assert.equal(reopened.assets[job.output].generated, undefined); assert.deepEqual(processing.settings, job.asset.processing.settings)
    await f.pub.external([{ op: 'replace', project: reopened }])
    await f.pub.external([{ op: 'add_clip', src: job.output, track: 'V2', start: 5, dur: kind === 'retime' ? 6 : 3, audio: false }])
    assert.equal(f.pub.state().project.tracks.find(t => t.id === 'V2').clips[0].src, job.output)
    f.pub.undo(); assert.equal(f.pub.state().project.tracks.find(t => t.id === 'V2').clips.length, 0); assert.deepEqual(f.pub.state().project.assets[job.output].processing, processing)
  })

  test(`${kind} placement Undo preserves admission and a second Undo removes only the Media entry`, async () => {
    const f = await fixture(kind, { nested: true }), job = await f.wait(await f.start())
    assert.equal(job.assetRegistered, true); assert.equal(job.placementRequested, true); assert.equal(job.applied, true); assert.equal(f.pub.calls.length, 2)
    assert.equal(outcome(kind, job), null)
    assert.deepEqual(f.pub.calls[0].ops.map(o => o.op), ['import']); assert.ok(f.pub.calls[1].ops.every(o => o.op !== 'import' && o.comp === 'nested'))
    assert.equal(f.pub.calls[1].settings.expectedVersion, job.admissionVersion)
    assert.equal(findClip(f.pub.state().project, 'v').clip.src, job.output)
    const undo = f.pub.undo().project
    assert.equal(findClip(undo, 'v').clip.src, input); assert.deepEqual(undo.assets[job.output], job.asset)
    assert.deepEqual(f.pub.state().publications.at(-1), undo)
    f.pub.undo(); assert.equal(f.pub.state().project.assets[job.output], undefined)
    f.pub.redo(); f.pub.redo(); assert.equal(findClip(f.pub.state().project, 'v').clip.src, job.output)
  })

  test(`${kind} placement refusal retains an independently admitted result`, async () => {
    const f = await fixture(kind, { refusePlacement: true }), job = await f.wait(await f.start())
    assert.equal(job.state, 'done'); assert.equal(job.applied, false); assert.equal(job.assetRegistered, true); assert.match(job.applyError, /Placement publication refused/)
    assert.equal(job.placementRequested, true); assert.match(outcome(kind, job), /saved in Media.*requested edit was not applied/)
    assert.ok(f.pub.state().project.assets[job.output]); assert.equal(findClip(f.pub.state().project, 'v').clip.src, input)
  })

  test(`${kind} ordinary target edits admit output at the new version but refuse stale placement`, async () => {
    const f = await fixture(kind, { holdProbe: true }), job = await f.start(); await f.probeStarted
    await f.pub.external([{ op: 'update', id: 'v', set: { name: 'Edited while rendering' } }]); const generation = f.pub.state().generation
    f.release(); const done = await f.wait(job)
    assert.equal(done.state, 'done'); assert.equal(done.assetRegistered, true); assert.equal(done.applied, false); assert.match(done.applyError, /changed/)
    assert.equal(f.pub.calls[0].settings.expectedVersion, 8); assert.equal(f.pub.state().generation, generation)
    assert.equal(findClip(f.pub.state().project, 'v').clip.name, 'Edited while rendering')
  })

  test(`${kind} project replacement prevents cross-project Media admission`, async () => {
    for (const intent of [{}, { apply: false }, ...(kind === 'denoise' ? [] : [{ noTarget: true }])]) {
      const f = await fixture(kind, { holdProbe: true, ...intent }), job = await f.start(); await f.probeStarted
      await f.pub.external([{ op: 'replace', project: newProject('Different project') }]); f.release(); const done = await f.wait(job)
      assert.equal(done.assetRegistered, false); assert.match(done.registrationError, /original project was replaced/)
      assert.equal(done.placementRequested, intent.apply !== false && !intent.noTarget); assert.equal(done.applied, false)
      assert.match(outcome(kind, done), /A processing result was not applied/)
      assert.equal(f.pub.calls.length, 0); assert.equal(f.pub.state().project.name, 'Different project'); assert.equal(f.pub.state().project.assets[done.output], undefined)
    }
  })

  test(`${kind} missing, short or overlong output cannot enter Media`, async () => {
    for (const options of [{ missing: true }, { invalid: { ...metadata, duration: 0.1 } }, { invalid: { ...metadata, duration: 100 } }, { invalid: { ...metadata, hasVideo: false } }]) {
      const f = await fixture(kind, options), done = await f.wait(await f.start())
      assert.equal(done.state, 'failed'); assert.equal(f.pub.calls.length, 0); assert.equal(findClip(f.pub.state().project, 'v').clip.src, input)
    }
  })

  test(`${kind} cancellation during output probe refuses admission`, async () => {
    const f = await fixture(kind, { holdProbe: true }), job = await f.start(); await f.probeStarted
    f.routes[kind === 'denoise' ? 'POST /api/video/jobs/cancel' : 'POST /api/analysis/jobs/cancel']({ id: job.id }); f.release()
    const done = await f.wait(job); assert.equal(done.state, 'cancelled'); assert.equal(f.pub.calls.length, 0)
  })

  test(`${kind} stale assistant version retains the publication guard`, async () => {
    const f = await fixture(kind, { holdProbe: true }); f.pub.assistant(); const job = await f.start(); await f.probeStarted
    await f.pub.external([{ op: 'update', id: 'v', set: { name: 'Other caller' } }]); f.release(); const done = await f.wait(job)
    assert.equal(done.assetRegistered, false); assert.match(done.registrationError, /project changed while the assistant tool ran/)
    assert.equal(f.pub.calls.length, 0); assert.equal(findClip(f.pub.state().project, 'v').clip.src, input)
  })

  test(`${kind} changed or missing original input refuses Media admission independently of target version`, async () => {
    for (const missing of [false, true]) {
      const f = await fixture(kind, { holdProbe: true }), job = await f.start(); await f.probeStarted
      if (missing) f.sourceStamp.missing = true; else f.sourceStamp.value++
      f.release(); const done = await f.wait(job)
      assert.equal(done.state, 'failed'); assert.match(done.error, missing ? /input is missing/ : /original input changed/)
      assert.equal(f.pub.calls.length, 0); assert.equal(findClip(f.pub.state().project, 'v').clip.src, input)
    }
  })

  test(`${kind} deletion of the target retains the valid processed Media copy`, async () => {
    const f = await fixture(kind, { holdProbe: true }), job = await f.start(); await f.probeStarted
    await f.pub.external([{ op: 'delete', id: 'v' }]); f.release(); const done = await f.wait(job)
    assert.equal(done.assetRegistered, true); assert.equal(done.applied, false); assert.match(done.applyError, /changed/)
    assert.equal(findClip(f.pub.state().project, 'v'), null); assert.ok(f.pub.state().project.assets[done.output])
  })
}

for (const kind of ['retime', 'stabilize']) {
  test(`${kind} no target and missing target still admit the valid output`, async () => {
    for (const noTarget of [true, false]) {
      const f = await fixture(kind, { noTarget }); if (!noTarget) f.body.clip = 'missing'; else delete f.body.expectedVersion
      const done = await f.wait(await f.start())
      assert.equal(done.state, 'done'); assert.equal(done.assetRegistered, true); assert.equal(done.placementRequested, !noTarget)
      if (!noTarget) { assert.equal(done.applied, false); assert.match(done.applyError, /changed/); assert.match(outcome(kind, done), /requested edit was not applied/) }
      else { assert.equal(Object.hasOwn(done, 'applied'), false); assert.equal(outcome(kind, done), null) }
      assert.equal(f.pub.calls.length, 1); assert.ok(f.pub.state().project.assets[done.output])
    }
  })

  test(`${kind} cached duplicate admission is idempotent after JSON reopen`, async () => {
    const f = await fixture(kind, { noTarget: true }), first = await f.wait(await f.start())
    await f.pub.external([{ op: 'replace', project: JSON.parse(JSON.stringify(f.pub.state().project)) }]); const before = f.pub.state().version
    f.body.expectedVersion = before; const second = await f.wait(await f.start())
    assert.equal(second.output, first.output); assert.equal(f.pub.calls.length, 1); assert.equal(f.pub.state().version, before)
    assert.deepEqual(JSON.parse(JSON.stringify(f.pub.state().project)).assets[second.output].processing, first.asset.processing)
  })
}

test('denoise retains SDR restrictions and original-source rerender provenance', async () => {
  const hdr = await fixture('denoise', { hdr: true }); await assert.rejects(hdr.start, /native processor/); assert.equal(hdr.pub.calls.length, 0)
  const f = await fixture('denoise'); await f.pub.external([{ op: 'import', assets: { 'media/previous.mp4': { ...metadata, duration: 3 } } }]); await f.pub.external([{ op: 'update', id: 'v', set: { src: 'media/previous.mp4', in: 0, noiseReduction: { src: input, in: 1, dur: 3, output: 'media/previous.mp4' } } }])
  Object.assign(f.body, { src: 'media/previous.mp4', in: 0, expectedVersion: 9, useOriginal: true }); const job = await f.wait(await f.start())
  assert.equal(job.asset.processing.source, input); assert.deepEqual(job.asset.processing.range, { in: 1, dur: 3 }); assert.equal(job.asset.processing.engine, 'ffmpeg-hqdn3d')
  const argv = f.commands.find(c => c.command === 'render').argv
  assert.equal(argv[argv.indexOf('-i') + 1], `/fixture/${input}`); assert.equal(argv[argv.indexOf('-ss') + 1], '1')
})

test('admission publication refusal keeps output available and reports registration failure', async () => {
  for (const kind of ['denoise', 'retime', 'stabilize']) {
    for (const intent of [{ apply: false }, ...(kind === 'denoise' ? [] : [{ noTarget: true }])]) {
      const f = await fixture(kind, { ...intent, refuseAdmission: true }), job = await f.wait(await f.start())
      assert.equal(job.state, 'done'); assert.equal(job.assetRegistered, false); assert.match(job.registrationError, /Admission publication refused/)
      assert.equal(job.placementRequested, false); assert.equal(job.applied, false)
      assert.match(outcome(kind, job), /A processing result was not applied/)
      assert.ok(job.output); assert.equal(f.pub.state().project.assets[job.output], undefined); assert.equal(f.pub.state().version, 7)
    }
  }
})

test('actual browser processing controller still rejects refused requested placement receipts', async () => {
  for (const kind of ['denoise', 'retime', 'stabilize']) {
    const f = await fixture(kind, { refusePlacement: true }), job = await f.wait(await f.start())
    const state = f.pub.state(), s = { root: '/fixture', project: state.project, version: state.version, selection: ['v'], openComp: null }, p = state.project
    const capture = processingCapture(s, p, findClip(p, 'v').clip)
    const controller = createProcessingRuns({ api: async () => job, current: () => ({ s, p }), edit: () => { throw new Error('A refused server placement must never cause a caller edit') }, notify() {} })
    const run = await controller.start(capture, kind, '/fixture/processing', {}).promise
    assert.equal(run.state, 'failed'); assert.match(run.error, /Placement publication refused/)
  }
})

test('cancellation after Media admission preserves that committed entry and refuses placement', async () => {
  const f = await fixture('denoise', { holdProbe: true }), job = await f.start(); await f.probeStarted
  const edit = f.ctx.editOps
  f.ctx.editOps = async (...args) => { const receipt = await edit(...args); f.routes['POST /api/video/jobs/cancel']({ id: job.id }); return receipt }
  f.release(); const done = await f.wait(job)
  assert.equal(done.state, 'cancelled'); assert.equal(done.assetRegistered, true); assert.equal(done.applied, false)
  assert.ok(f.pub.state().project.assets[done.output]); assert.equal(findClip(f.pub.state().project, 'v').clip.src, input)
  f.pub.undo(); assert.equal(f.pub.state().project.assets[done.output], undefined)
})

for (const kind of ['retime', 'stabilize']) test(`${kind} concurrent cached jobs admit their shared path only once`, async () => {
  const f = await fixture(kind, { noTarget: true }); delete f.body.expectedVersion
  const jobs = await Promise.all([f.start(), f.start()]), completed = await Promise.all(jobs.map(f.wait))
  assert.equal(completed[0].output, completed[1].output); assert.ok(completed.every(job => job.assetRegistered))
  assert.equal(f.pub.calls.length, 1); assert.equal(f.pub.state().version, 8)
})

test('cached legacy Media admission adds provenance once and retains user annotations', async () => {
  const f = await fixture('retime', { noTarget: true }); delete f.body.expectedVersion
  const first = await f.wait(await f.start()); f.pub.undo()
  await f.pub.external([{ op: 'import', assets: { [first.output]: { ...metadata, duration: 100, name: 'User name', note: 'User note' } } }])
  const second = await f.wait(await f.start()); assert.equal(second.asset.name, 'User name'); assert.equal(second.asset.note, 'User note'); assert.equal(second.asset.duration, 6); assert.deepEqual(second.asset.processing, first.asset.processing)
  const before = f.pub.state().version; await f.wait(await f.start()); assert.equal(f.pub.state().version, before); assert.equal(f.pub.calls.length, 2)
})

test('captured bases reproduce the apply:false and no-target Media admission gaps', async () => {
  for (const kind of ['denoise', 'retime', 'stabilize']) {
    const f = await fixture(kind, { capturedBase: true, apply: false, noTarget: kind !== 'denoise' }), done = await f.wait(await f.start())
    assert.equal(done.state, 'done'); assert.equal(f.pub.calls.length, 0); assert.equal(f.pub.state().project.assets[done.output], undefined)
  }
})
