import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'
import { createProcessingAdmission, captureProcessingIdentity } from '../core/processing-admission.mjs'
import { migrate, newProject } from '../core/project.js'
import { recoveryProject } from '../core/project-recovery.mjs'

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
const functionBody = name => {
  const start = server.indexOf(`function ${name}(`), end = server.indexOf('\n}\n', start)
  assert.ok(start >= 0 && end > start, `The actual ${name} function must exist`)
  return server.slice(start, end + 2)
}
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve } }

function fixture({ assistant = true } = {}) {
  const initial = newProject('Original project'), text = JSON.stringify(initial)
  const disk = { text }, captures = [], checks = { origin: 0 }, cancellation = new Error('The assistant run was cancelled')
  const make = new Function('captureProcessingIdentity', 'migrate', 'recoveryProject', 'createHash', 'initial', 'disk', 'captures', 'checks', 'cancellation', 'assistant', `
    const FILE = '/fixture/reel.project.json';
    let project = initial, version = 7, projectEpoch = 2, lastText = JSON.stringify(initial), recoveryState = null, cancelled = false;
    const past = [], future = [initial];
    const fs = { existsSync: () => disk.text !== null, readFileSync: () => disk.text };
    const origin = assistant ? { assertCurrent() {
      checks.origin++;
      if (cancelled) throw cancellation;
      if (projectEpoch !== 2) throw new Error('The assistant project was replaced');
    } } : undefined;
    const assistantCalls = { getStore: () => origin };
    const recovery = { warning: null, observe() {
      let status = 'valid';
      try { recoveryProject(disk.text); } catch { status = 'invalid'; }
      const digest = createHash('sha256').update(disk.text ?? '').digest('hex');
      return { status, text: disk.text, token: digest, sha256: digest };
    }, capture(...args) { captures.push(args); } };
    const log = () => {};
    ${['rememberProject', 'loadFromDisk', 'captureProcessing'].map(functionBody).join('\n')}
    return { capture: captureProcessing, cancel: () => { cancelled = true; }, advanceVersion: () => { version++; },
      state: () => ({ project, version, generation: projectEpoch, lastText, past: [...past], future: [...future], recoveryStatus: recoveryState?.status }) };
  `)
  return { ...make(captureProcessingIdentity, migrate, recoveryProject, createHash, initial, disk, captures, checks, cancellation, assistant), initial, disk, captures, checks, cancellation }
}

test('a completed processing lease refreshes a disk replacement before rejecting assistant publication', async t => {
  const f = fixture(), entered = deferred(), released = deferred(), admission = createProcessingAdmission()
  t.after(() => admission.close())
  const ticket = admission.submit(async () => { entered.resolve(); await released.promise; return 'fixture probe metadata' }, f.capture())
  await entered.promise
  const replacement = newProject('External replacement'), replacementText = JSON.stringify(replacement)
  f.disk.text = replacementText
  released.resolve()
  await assert.rejects(ticket.promise, /project changed on disk while the assistant tool ran/)
  const state = f.state()
  assert.deepEqual(state.project, migrate(replacement))
  assert.equal(state.version, 8); assert.equal(state.generation, 3)
  assert.equal(state.lastText, replacementText); assert.equal(f.disk.text, replacementText)
  assert.deepEqual(state.past, [f.initial]); assert.deepEqual(state.future, [])
  assert.equal(f.captures.length, 1); assert.equal(f.captures[0][0], replacementText); assert.equal(f.captures[0][1], 'published')
  assert.deepEqual(admission.snapshot(), { capacity: 8, concurrency: 1, active: 0, queued: 0, draining: 0 })
  assert.equal(f.checks.origin, 1, 'The initial lease check validates the actual origin before work')
})

test('an unchanged processing identity keeps the original project and validates its assistant origin', () => {
  const f = fixture(), before = f.state(), guard = f.capture()
  guard.assertCurrent()
  assert.deepEqual(f.state(), before)
  assert.equal(f.checks.origin, 1); assert.deepEqual(f.captures, [])
})

test('assistant cancellation retains its error and leaves the original project unchanged', () => {
  const f = fixture(), before = f.state(), guard = f.capture()
  f.cancel()
  assert.throws(() => guard.assertCurrent(), error => error === f.cancellation)
  assert.deepEqual(f.state(), before)
  assert.equal(f.checks.origin, 1); assert.deepEqual(f.captures, [])
})

test('a version change still rejects the captured processing identity without accepting it', () => {
  const f = fixture(), guard = f.capture()
  f.advanceVersion()
  const before = f.state()
  assert.throws(() => guard.assertCurrent(), /project changed while processing was queued or running/)
  assert.throws(() => guard.assertCurrent(), /project changed while processing was queued or running/)
  assert.deepEqual(f.state(), before)
  assert.equal(f.checks.origin, 2); assert.deepEqual(f.captures, [])
})

test('an invalid disk replacement retains valid project data and rejects assistant publication', () => {
  const f = fixture(), guard = f.capture()
  f.disk.text = '{'
  assert.throws(() => guard.assertCurrent(), /project changed on disk while the assistant tool ran/)
  const state = f.state()
  assert.deepEqual(state.project, f.initial)
  assert.equal(state.version, 7); assert.equal(state.generation, 3)
  assert.equal(state.lastText, JSON.stringify(f.initial)); assert.equal(f.disk.text, '{')
  assert.equal(state.recoveryStatus, 'invalid')
  assert.deepEqual(state.past, []); assert.deepEqual(state.future, [f.initial]); assert.deepEqual(f.captures, [])
  assert.equal(f.checks.origin, 0)
})

test('processing without an assistant retains the original disk identity rejection', () => {
  const f = fixture({ assistant: false }), guard = f.capture(), before = f.state()
  f.disk.text = JSON.stringify(newProject('External replacement'))
  assert.throws(() => guard.assertCurrent(), /project changed while processing was queued or running/)
  assert.deepEqual(f.state(), before)
  assert.equal(f.checks.origin, 0); assert.deepEqual(f.captures, [])
})
