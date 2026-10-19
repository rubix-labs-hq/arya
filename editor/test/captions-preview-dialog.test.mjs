import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(path.join(process.cwd(), 'editor/package.json'))
const html = require('htm').bind(require('preact').h)
const source = fs.readFileSync(new URL('../web/ui/plugins/captions.js', import.meta.url), 'utf8')
const begin = source.indexOf('function TranscriptDialog('), end = source.indexOf('\n// ---------------------------------------------------------------- the Captions tab', begin)
const component = source.slice(begin, end)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const walk = (node, out = []) => { if (Array.isArray(node)) node.forEach(value => walk(value, out)); else if (node && typeof node === 'object') { out.push(node); walk(node.props?.children, out) }; return out }
const text = node => [node?.props?.children].flat(Infinity).filter(value => typeof value === 'string').join('')
async function fixture(t, configure) {
  const saved = { src: 'synthetic.wav', locale: 'fr-FR', status: 'complete', revision: 1, fingerprint: 'synthetic-fingerprint', words: [{ t: .2, end: .8, text: 'Saved' }] }
  const c = { s: { root: 'synthetic-project', version: 1, openComp: null, selection: [], caps: {}, transcript: { ...saved, ownerRoot: 'synthetic-project' }, project: { fps: 30, assets: { 'synthetic.wav': { hasAudio: true, duration: 3 } }, tracks: [{ id: 'A1', kind: 'audio', clips: [{ id: 'a1', src: 'synthetic.wav', start: 0, dur: 3 }] }] } }, saved, values: [], effects: [], pending: [], index: 0, calls: [], notes: [], updates: [], closed: 0 }
  configure?.(c)
  const state = value => { const i = c.index++; if (!(i in c.values)) c.values[i] = value; return [c.values[i], next => { c.values[i] = typeof next === 'function' ? next(c.values[i]) : next }] }
  const ref = value => { const i = c.index++; if (!(i in c.values)) c.values[i] = { current: value }; return c.values[i] }
  const memo = (fn, deps) => { const i = c.index++, prior = c.values[i]; if (!prior || deps.some((value, j) => value !== prior.deps[j])) c.values[i] = { deps, value: fn() }; return c.values[i].value }
  const effect = (fn, deps) => { const i = c.index++, prior = c.effects[i]; if (!prior || deps.some((value, j) => value !== prior.deps[j])) c.pending.push(() => { prior?.cleanup?.(); c.effects[i] = { deps, cleanup: fn() } }) }
  const api = async (route, body) => {
    c.calls.push({ route, body, root: c.s.root })
    if (c.handler) { const value = c.handler(route, body); if (value !== undefined) return value }
    if (route.startsWith('/api/transcript?')) return c.saved
    if (body?.apply) return { project: structuredClone(c.s.project), version: c.s.version + 1 }
    return { items: [{ t: .2, end: .8, text: 'Saved' }], clips: ['a1'], warnings: [], version: c.s.version, sourceFingerprint: body.expectedSourceFingerprint, transcriptRevision: body.expectedTranscriptRevision }
  }
  c.Confirm = function CaptionsConfirm() {}
  const Dialog = new Function('html', 'useStore', 'viewProject', 'store', 'useState', 'useRef', 'useMemo', 'useEffect', 'api', 'runTranscriptJob', 'toast', 'set', 'CaptionsConfirm', 'Num', `${component}; return TranscriptDialog;`)(html, () => c.s, () => c.s.project, c.s, state, ref, memo, effect, api, async () => { throw new Error('Unexpected transcription') }, value => c.notes.push(value), value => { c.updates.push(value); Object.assign(c.s, value) }, c.Confirm, function Num() {})
  const render = (effects = true) => { c.index = 0; const tree = Dialog({ onClose: () => c.closed++ }); if (effects) c.pending.splice(0).forEach(fn => fn()); return tree }
  const nodes = () => walk(render())
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label)
  const confirm = () => nodes().find(node => node.type === c.Confirm)
  const settle = async () => { for (let i = 0; i < 20; i++) { render(); await Promise.resolve() }; render() }
  const preview = async () => { await button('Preview captions').props.onClick(); await settle(); return confirm() }
  t.after(() => c.effects.forEach(effect => effect?.cleanup?.()))
  await settle()
  return { c, render, nodes, button, confirm, settle, preview }
}

test('dialog rereads saved words and binds preview/apply to locale, source, revision and project version', async t => {
  const f = await fixture(t), preview = await f.preview()
  assert.ok(preview)
  const post = f.c.calls.find(call => call.route === '/api/captions/from-transcript')
  assert.equal(f.c.calls[0].route, '/api/transcript?src=synthetic.wav&locale=fr-FR')
  assert.equal(post.body.locale, 'fr-FR'); assert.equal(post.body.comp, null)
  assert.equal(post.body.expectedVersion, 1); assert.equal(post.body.expectedTranscriptRevision, 1)
  assert.equal(post.body.expectedSourceFingerprint, f.c.saved.fingerprint)
  await preview.props.onApply('C1', false)
  assert.equal(f.c.calls.at(-1).body.apply, true)
  assert.equal(f.c.updates.length, 1)
})

test('dialog demands Save before previewing current-root dirty words', async t => {
  const f = await fixture(t, c => { c.s.transcript.words = [{ ...c.saved.words[0], text: 'Unsaved' }] })
  await f.preview()
  assert.equal(f.c.calls.filter(call => call.route === '/api/captions/from-transcript').length, 0)
  assert.match(f.c.notes[0], /Save transcript corrections/)
})

test('dialog ignores transcript data owned by another project', async t => {
  const f = await fixture(t, c => { c.s.transcript = { ...c.s.transcript, ownerRoot: 'another-root', words: [{ t: .2, end: .8, text: 'Other root' }] }; c.saved.locale = 'en-US' })
  const preview = await f.preview(); assert.ok(preview)
  assert.equal(f.c.calls[0].route, '/api/transcript?src=synthetic.wav&locale=en-US')
  assert.deepEqual(f.c.calls[1].body.words, f.c.saved.words)
})

for (const field of ['root', 'project', 'openComp', 'version']) test(`dialog rejects a delayed saved transcript read after ${field} changes`, async t => {
  const f = await fixture(t), held = deferred()
  f.c.handler = route => route.startsWith('/api/transcript?') ? held.promise : undefined
  const done = f.button('Preview captions').props.onClick()
  f.c.s[field] = field === 'project' ? structuredClone(f.c.s.project) : field === 'version' ? 2 : 'changed'
  held.resolve(f.c.saved); await done; await f.settle()
  assert.equal(f.c.calls.filter(call => call.route === '/api/captions/from-transcript').length, 0)
  assert.equal(f.confirm(), undefined)
})

test('dialog rejects old preview apply after a project object replacement before effects', async t => {
  const f = await fixture(t), preview = await f.preview()
  f.c.s.project = structuredClone(f.c.s.project)
  await assert.rejects(preview.props.onApply('C1', false), /caption preview changed/)
  assert.equal(f.c.calls.filter(call => call.body?.apply).length, 0)
})

test('dialog ignores a late apply response after project navigation', async t => {
  const f = await fixture(t), preview = await f.preview(), held = deferred()
  f.c.handler = (_route, body) => body?.apply ? held.promise : undefined
  const done = preview.props.onApply('C1', false)
  f.c.s.root = 'new-project'
  held.resolve({ project: { wrong: true }, version: 2 })
  assert.equal(await done, null)
  assert.equal(f.c.updates.length, 0)
})

test('dialog rejects duplicate apply dispatch while its first apply waits', async t => {
  const f = await fixture(t), preview = await f.preview(), held = deferred()
  f.c.handler = (_route, body) => body?.apply ? held.promise : undefined
  const done = preview.props.onApply('C1', false)
  await assert.rejects(preview.props.onApply('C1', false), /caption preview changed/)
  assert.equal(f.c.calls.filter(call => call.body?.apply).length, 1)
  held.resolve({ project: structuredClone(f.c.s.project), version: 2 }); await done
})

test('dialog refuses a preview response bound to another transcript revision', async t => {
  const f = await fixture(t)
  f.c.handler = (route, body) => route === '/api/captions/from-transcript' ? { items: [], clips: [], version: 1, sourceFingerprint: body.expectedSourceFingerprint, transcriptRevision: 2 } : undefined
  await f.preview()
  assert.equal(f.confirm(), undefined)
  assert.match(f.c.notes[0], /changed during caption preview/)
})
