import './fixtures/browser-host-imports.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { transcriptRecoverySession } from '../web/ui/transcript-drafts.js'

const require = createRequire(path.join(process.cwd(), 'editor/package.json'))
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const saved = src => ({ src, locale: 'en-US', revision: 1, fingerprint: `${src}-fingerprint`, status: 'complete', words: [{ t: 0, end: 1, text: `${src}-saved` }] })
const basis = src => ({ revision: 1, fingerprint: `${src}-fingerprint` })

async function panel(t, handler) {
  const id = `draft-panel-${crypto.randomUUID()}`
  const c = { s: { root: id, project: { fps: 24, assets: { a: { hasAudio: true, duration: 2 }, b: { hasAudio: true, duration: 2 } }, tracks: [] }, caps: { whisper: true }, selection: [], version: 1, openComp: null }, values: [], effects: [], pending: [], index: 0, calls: [], edits: [], notes: [] }
  c.handler = handler
  c.state = value => { const i = c.index++; if (!(i in c.values)) c.values[i] = value; return [c.values[i], next => { c.values[i] = typeof next === 'function' ? next(c.values[i]) : next }] }
  c.ref = value => { const i = c.index++; if (!(i in c.values)) c.values[i] = { current: value }; return c.values[i] }
  c.memo = fn => { c.index++; return fn() }
  c.effect = (fn, deps) => { const i = c.index++, old = c.effects[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) c.pending.push(() => { old?.cleanup?.(); c.effects[i] = { deps, cleanup: fn() } }) }
  c.api = async (route, body) => {
    c.calls.push({ route, body })
    if (c.handler) { const result = c.handler(route, body); if (result !== undefined) return result }
    const src = body?.src ?? new URL(route, 'http://fixture').searchParams.get('src') ?? 'a'
    if (route.startsWith('/api/transcript/drafts?')) return { basis: basis(src), offers: [{ id: `${src}-offer`, recoverable: true, createdAt: 1, wordCount: 1 }] }
    if (route === '/api/transcript/drafts/checkpoint') return { id: crypto.randomUUID(), sequence: body.sequence }
    if (route === '/api/transcript/drafts/discard') return {}
    return saved(src)
  }
  globalThis[id] = c
  const hooks = data(`const c=globalThis[${JSON.stringify(id)}]; export const useState=x=>c.state(x);export const useRef=x=>c.ref(x);export const useMemo=f=>c.memo(f);export const useEffect=(f,d)=>c.effect(f,d);`)
  const shim = data(`const c=globalThis[${JSON.stringify(id)}];export const store=c.s;export const useStore=()=>store;export const api=(...a)=>c.api(...a);export const set=p=>Object.assign(store,p);export const toast=x=>c.notes.push(x);export const edit=(...a)=>c.edits.push(a);export const time={t:0};export const addRef=()=>{};export const viewProject=()=>store.project;`)
  let source = await fs.readFile(new URL('../web/ui/transcript.js', import.meta.url), 'utf8')
  for (const [old, replacement] of [['preact', pathToFileURL(require.resolve('preact')).href], ['htm', pathToFileURL(require.resolve('htm')).href], ['preact/hooks', hooks], ['./store.js', shim], ['/core/project.js', data('export const timecode=t=>String(t);')], ['/core/shorts.js', data('export const transcriptDeleteOps=()=>({ops:[]});')], ['/core/transcript-edit.js', new URL('../core/transcript-edit.js', import.meta.url).href], ['./transcript-jobs.js', data('export const runTranscriptJob=()=>{throw Error("Unexpected analysis");};')], ['./transcript-drafts.js', new URL('../web/ui/transcript-drafts.js', import.meta.url).href]]) source = source.replace(`'${old}'`, JSON.stringify(replacement))
  const { Transcript } = await import(data(source))
  const render = (runEffects = true) => { c.index = 0; const view = Transcript(); const tree = typeof view.type === 'function' ? view.type(view.props) : view; if (runEffects) c.pending.splice(0).forEach(fn => fn()); return tree }
  const walk = (node, out = []) => { if (Array.isArray(node)) node.forEach(value => walk(value, out)); else if (node && typeof node === 'object') { out.push(node); walk(node.props?.children, out) }; return out }
  const text = node => [node?.props?.children].flat(Infinity).filter(value => typeof value === 'string').join('')
  const nodes = () => walk(render())
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label)
  const input = () => nodes().find(node => node.type === 'input' && node.props['aria-label'] === 'Correct selected word')
  const words = () => nodes().filter(node => node.type === 'button' && node.props.class?.startsWith('tr-word')).map(text)
  const settle = async () => { for (let i = 0; i < 30; i++) { render(); await Promise.resolve() }; render() }
  const select = () => { nodes().find(node => node.type === 'button' && node.props.class?.startsWith('tr-word'))?.props.onClick({ shiftKey: false }); render() }
  const switchSource = async src => { c.s.transcript = { src }; await settle(); select() }
  t.after(() => { c.effects.forEach(effect => effect?.cleanup?.()); delete globalThis[id] })
  await settle(); select()
  return { c, render, button, input, words, settle, switchSource, nodes, text }
}

test('actual extracted panel claims discard synchronously and refuses edits and timeline dispatch until retirement finishes', async t => {
  const f = await panel(t)
  f.input().props.onInput({ target: { value: 'correction' } }); await f.settle()
  const held = deferred(); f.c.handler = route => route === '/api/transcript/drafts/discard' ? held.promise : undefined
  f.button('Discard unsaved corrections').props.onClick(); f.render()
  const staleInput = f.input().props.onInput, staleSave = f.button('Save corrections').props.onClick, staleAppend = f.button('Append selection').props.onClick
  const done = f.button('Discard corrections').props.onClick()
  staleInput({ target: { value: 'later-edit' } }); staleSave(); staleAppend()
  assert.deepEqual(f.words(), ['correction']); assert.equal(f.input().props.disabled, true)
  assert.equal(f.c.edits.length, 0); assert.equal(f.c.calls.filter(call => call.route === '/api/transcript' && call.body).length, 0)
  held.resolve({}); await done; await f.settle()
  assert.deepEqual(f.words(), ['a-saved'])
})

test('actual extracted panel blocks edits during recover and ignores its late response after a source switch', async t => {
  const f = await panel(t), held = deferred()
  f.c.handler = route => route === '/api/transcript/drafts/recover' ? held.promise : undefined
  const oldInput = f.input().props.onInput, oldAppend = f.button('Append selection').props.onClick
  const done = f.button('Recover corrections').props.onClick()
  oldInput({ target: { value: 'must-not-race' } }); oldAppend()
  assert.deepEqual(f.words(), ['a-saved']); assert.equal(f.input().props.disabled, true); assert.equal(f.c.edits.length, 0)
  await f.switchSource('b'); f.input().props.onInput({ target: { value: 'b-current' } }); await f.settle()
  held.resolve({ basis: basis('a'), words: [{ t: 20, end: 21, text: 'old-recovery' }] }); await done; await f.settle()
  assert.deepEqual(f.words(), ['b-current']); assert.equal(f.input().props.disabled, false)
  assert.equal(f.c.s.transcript.src, 'b'); assert.equal(f.c.s.transcript.words[0].t, 0)
})

for (const boundary of ['flush', 'retire']) test(`actual extracted panel ignores old save ${boundary} errors after a source switch`, async t => {
  const f = await panel(t), held = deferred()
  f.c.handler = (route, body) => {
    if (boundary === 'flush' && route === '/api/transcript/drafts/checkpoint') return held.promise
    if (boundary === 'retire' && route === '/api/transcript/drafts/discard') return held.promise
    if (route === '/api/transcript' && body) return { ...saved(body.src), revision: 2, words: body.words }
  }
  f.input().props.onInput({ target: { value: 'a-correction' } }); await f.settle()
  const done = f.button('Save corrections').props.onClick(); await f.settle()
  await f.switchSource('b')
  held.reject(new Error(`old-${boundary}-failure`)); await done; await f.settle()
  assert.deepEqual(f.words(), ['b-saved']); assert.equal(f.input().props.disabled, false)
  assert.ok(!f.nodes().some(node => f.text(node).includes(`old-${boundary}-failure`)))
  if (boundary === 'flush') assert.equal(f.c.calls.filter(call => call.route === '/api/transcript' && call.body).length, 0)
})

test('recovery retirement removes only its exact session and preserves a replacement at the same key', async () => {
  const key = crypto.randomUUID(), held = deferred(), calls = []
  const api = async (route, body) => { calls.push({ route, body }); return route.endsWith('/discard') ? held.promise : { id: crypto.randomUUID(), sequence: body.sequence } }
  const first = transcriptRecoverySession(key, api, { src: 'a', locale: 'en-US' })
  first.capture({ basis: basis('a') }, saved('a')); first.update(saved('a').words); await first.flush()
  const done = first.retire(), next = transcriptRecoverySession(key, api, { src: 'a', locale: 'en-US' })
  assert.notEqual(first, next); next.capture({ basis: basis('a') }, saved('a')); next.update(saved('a').words); await next.flush()
  held.resolve({}); await done
  assert.equal(transcriptRecoverySession(key, api, { src: 'a', locale: 'en-US' }), next)
  next.update([{ t: 0, end: 1, text: 'replacement-continues' }]); await next.flush()
  assert.equal(calls.filter(call => call.route.endsWith('/checkpoint')).at(-1).body.sequence, 2)
})

test('actual extracted panel rejects an old recovery result when the live source key changes before its effect runs', async t => {
  const f = await panel(t), held = deferred()
  f.c.handler = route => route === '/api/transcript/drafts/recover' ? held.promise : undefined
  const sourceControl = f.nodes().find(node => node.type === 'select' && node.props['aria-label'] === 'Transcript media')
  const done = f.button('Recover corrections').props.onClick()
  // A parent can update the source while an action is pending. Run the new render
  // without effects to exercise the gap before generation invalidation.
  sourceControl.props.onChange({ target: { value: 'b' } }); f.render(false)
  held.resolve({ basis: basis('a'), words: [{ t: 20, end: 21, text: 'old-before-effect' }] }); await done
  assert.ok(!f.c.s.transcript.words?.some(word => word.text === 'old-before-effect'))
  const tree = f.render(false)
  const inputs = []; const walk = node => { if (Array.isArray(node)) node.forEach(walk); else if (node && typeof node === 'object') { if (node.type === 'input') inputs.push(node); walk(node.props?.children) } }; walk(tree)
  assert.equal(inputs.find(node => node.props['aria-label'] === 'Correct selected word').props.disabled, true, 'The old release must not reset the new-key action status before effects')
  await f.settle(); assert.deepEqual(f.words(), ['b-saved'])
})

for (const retirementFails of [false, true]) test(`actual extracted panel reloads the newly saved basis after retirement ${retirementFails ? 'failure' : 'success'} before checkpointing the next correction`, async t => {
  const f = await panel(t); let current = saved('a')
  f.c.handler = (route, body) => {
    if (route.startsWith('/api/transcript/drafts?')) return { basis: { revision: current.revision, fingerprint: current.fingerprint }, offers: [] }
    if (route.startsWith('/api/transcript?')) return current
    if (route === '/api/transcript' && body) { current = { ...current, revision: 2, words: body.words }; return current }
    if (route === '/api/transcript/drafts/discard' && retirementFails) return Promise.reject(new Error('fixture old recovery discard unavailable'))
  }
  f.input().props.onInput({ target: { value: 'first-saved' } }); await f.settle()
  await f.button('Save corrections').props.onClick(); await f.settle()
  assert.deepEqual(f.words(), ['first-saved']); assert.equal(f.button('Save corrections').props.disabled, true)
  f.nodes().find(node => node.type === 'button' && node.props.class?.startsWith('tr-word')).props.onClick({ shiftKey: false }); f.render()
  f.input().props.onInput({ target: { value: 'next-unsaved' } }); await f.settle()
  const copies = f.c.calls.filter(call => call.route === '/api/transcript/drafts/checkpoint')
  assert.equal(copies.length, 2); assert.equal(copies[1].body.basis.revision, 2); assert.equal(copies[1].body.words[0].text, 'next-unsaved')
})

for (const callback of ['listener', 'context']) test(`actual extracted panel keeps the old recovery ${callback} callback outside a new render key before effects`, async t => {
  const f = await panel(t), held = deferred()
  f.c.handler = route => route === '/api/transcript/drafts/checkpoint' && callback === 'listener' || route.startsWith('/api/transcript/drafts?') && callback === 'context' ? held.promise : undefined
  f.input().props.onInput({ target: { value: 'a-edited' } }); await f.settle()
  if (callback === 'context') { f.button('Recheck saved transcript').props.onClick(); await f.settle() }
  const control = f.nodes().find(node => node.type === 'select' && node.props['aria-label'] === 'Transcript media')
  control.props.onChange({ target: { value: 'b' } }); f.render(false)
  held.resolve(callback === 'listener' ? { id: crypto.randomUUID(), sequence: 1, warning: 'old-key-warning' } : { basis: basis('a'), reason: 'old-key-warning', offers: [{ id: 'old-offer', createdAt: 1, wordCount: 9876, recoverable: true }] })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  const tree = f.render(false), texts = []; const walk = node => { if (Array.isArray(node)) node.forEach(walk); else if (typeof node === 'string') texts.push(node); else if (node && typeof node === 'object') walk(node.props?.children) }; walk(tree)
  assert.ok(!texts.some(text => text.includes('old-key-warning') || text.includes('9876 words')))
  f.c.handler = undefined; await f.settle(); assert.deepEqual(f.words(), ['b-saved'])
})

for (const callback of ['listener', 'context']) test(`actual extracted panel ignores a recovery ${callback} callback after the global folder switches before rendering`, async t => {
  const f = await panel(t), held = deferred()
  f.c.handler = route => route === '/api/transcript/drafts/checkpoint' && callback === 'listener' || route.startsWith('/api/transcript/drafts?') && callback === 'context' ? held.promise : undefined
  f.input().props.onInput({ target: { value: 'a-edited' } }); await f.settle()
  if (callback === 'context') { f.button('Recheck saved transcript').props.onClick(); await f.settle() }
  f.c.s.root = `${f.c.s.root}-new-folder`
  held.resolve(callback === 'listener' ? { id: crypto.randomUUID(), sequence: 1, warning: 'old-folder-warning' } : { basis: basis('a'), reason: 'old-folder-warning', offers: [{ id: 'old-folder-offer', createdAt: 1, wordCount: 9876, recoverable: true }] })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  // Inspect actual hook state before any render can update the key or generation.
  assert.ok(!f.c.values.includes('old-folder-warning'))
  assert.ok(!f.c.values.some(value => Array.isArray(value) && value.some(item => item?.id === 'old-folder-offer')))
  f.c.handler = undefined; await f.settle()
})

const importControl = f => f.nodes().find(node => node.type === 'input' && node.props['aria-label'] === 'Import timed transcript')
const timingControl = (f, edge) => f.nodes().find(node => node.type === 'input' && node.props['aria-label'] === `Selected word ${edge} seconds`)
const fileEvent = (text, name = 'speech.json') => ({ target: { value: name, files: [{ name, size: 100, text: async () => text }] } })

test('extracted panel commits timing corrections to retained drafts and rejects invalid timing', async t => {
  const f = await panel(t)
  timingControl(f, 'start').props.onChange({ target: { value: '0.25' } }); await f.settle()
  assert.equal(f.c.s.transcript.words[0].t, 0.25)
  assert.equal(f.button('Save corrections').props.disabled, false)
  timingControl(f, 'end').props.onChange({ target: { value: '0.2' } }); await f.settle()
  assert.equal(f.c.s.transcript.words[0].end, 1)
  assert.ok(f.nodes().some(node => node.props?.role === 'alert'))
  timingControl(f, 'end').props.onChange({ target: { value: '0.85' } }); await f.settle()
  assert.equal(f.c.s.transcript.words[0].end, 0.85)
  const checkpoint = f.c.calls.filter(call => call.route === '/api/transcript/drafts/checkpoint').at(-1)
  assert.equal(checkpoint.body.words[0].t, 0.25); assert.equal(checkpoint.body.words[0].end, 0.85)
})

test('extracted panel previews imports before replacing a dirty draft and saves an imported revision', async t => {
  const f = await panel(t); let current = saved('a')
  f.c.handler = (route, body) => {
    if (route.startsWith('/api/transcript?')) return current
    if (route.startsWith('/api/transcript/drafts?')) return { basis: { revision: current.revision, fingerprint: current.fingerprint }, offers: [] }
    if (route === '/api/transcript' && body) { current = { ...current, revision: current.revision + 1, words: body.words }; return current }
  }
  f.input().props.onInput({ target: { value: 'kept-until-confirmation' } }); await f.settle()
  const event = fileEvent('1\n00:00:00,200 --> 00:00:01,200\nImported sentence.\n', 'speech.srt')
  await importControl(f).props.onChange(event); await f.settle()
  assert.equal(event.target.value, '')
  assert.deepEqual(f.words(), ['kept-until-confirmation'])
  assert.equal(f.c.calls.filter(call => call.route === '/api/transcript' && call.body).length, 0)
  assert.ok(f.nodes().some(node => f.text(node).includes('estimated evenly')))
  f.button('Replace unsaved draft with import').props.onClick(); await f.settle()
  assert.deepEqual(f.words(), ['Imported', 'sentence.'])
  assert.equal(f.c.s.transcript.words[0].t, 0.2)
  assert.equal(f.c.s.transcript.words[1].end, 1.2)
  assert.equal(f.button('Make captions').props.disabled, true)
  await f.button('Save corrections').props.onClick(); await f.settle()
  assert.deepEqual(f.words(), ['Imported', 'sentence.'])
  assert.equal(current.revision, 2)
  assert.equal(f.button('Make captions').props.disabled, false)
  assert.equal(f.c.calls.filter(call => call.route === '/api/transcript' && call.body).at(-1).body.revision, 1)
})

test('extracted panel refuses timing edits while reading a file and ignores its late result after a source switch', async t => {
  const f = await panel(t), held = deferred()
  const nodes = f.nodes()
  const oldTiming = nodes.find(node => node.props?.['aria-label'] === 'Selected word start seconds').props.onChange
  const oldImport = nodes.find(node => node.props?.['aria-label'] === 'Import timed transcript').props.onChange
  const done = oldImport({ target: { value: 'speech.json', files: [{ name: 'speech.json', size: 100, text: () => held.promise }] } })
  oldTiming({ target: { value: '0.5' } })
  assert.equal(f.c.s.transcript.words[0].t, 0)
  await f.switchSource('b')
  held.resolve(JSON.stringify([{ t: 0.2, end: 0.8, text: 'old-import' }]))
  await done; await f.settle()
  assert.deepEqual(f.words(), ['b-saved'])
  assert.equal(f.button('Use imported transcript'), undefined)
  assert.equal(importControl(f).props.disabled, false)
})

test('extracted panel rejects invalid imports without replacing the draft or writing a revision', async t => {
  const f = await panel(t)
  f.input().props.onInput({ target: { value: 'retained' } }); await f.settle()
  await importControl(f).props.onChange(fileEvent(JSON.stringify([{ t: 0.5, end: 2.1, text: 'outside-source' }]))); await f.settle()
  assert.deepEqual(f.words(), ['retained'])
  assert.ok(f.nodes().some(node => node.props?.role === 'alert'))
  assert.equal(f.button('Use imported transcript'), undefined)
  assert.equal(f.c.calls.filter(call => call.route === '/api/transcript' && call.body).length, 0)
})

const missingHandler = route => {
  if (route.startsWith('/api/transcript/drafts?')) return { basis: { revision: 0, fingerprint: '' }, offers: [] }
  if (route.startsWith('/api/transcript?')) return { src: 'a', locale: 'en-US', status: 'missing', revision: 0, words: [] }
}

for (const replacement of ['project', 'asset']) test(`extracted first-import panel rejects a delayed file result after same-root ${replacement} replacement`, async t => {
  const f = await panel(t, missingHandler), held = deferred()
  assert.deepEqual(f.words(), [])
  const done = importControl(f).props.onChange({ target: { value: 'speech.json', files: [{ name: 'speech.json', size: 100, text: () => held.promise }] } })
  if (replacement === 'project') { f.c.s.project = { ...f.c.s.project }; f.c.s.version++ }
  else f.c.s.project.assets.a = { ...f.c.s.project.assets.a }
  held.resolve(JSON.stringify([{ t: 0.2, end: 0.8, text: 'stale-import' }]))
  await done; await f.settle()
  assert.deepEqual(f.words(), [])
  assert.equal(f.button('Use imported transcript'), undefined)
  assert.ok(f.nodes().some(node => f.text(node).includes('changed while reading')))
  assert.equal(f.c.calls.filter(call => call.route === '/api/transcript' && call.body).length, 0)
})

for (const replacement of ['version', 'duration']) test(`extracted first-import panel rejects preview acceptance after same-root ${replacement} change`, async t => {
  const f = await panel(t, missingHandler)
  await importControl(f).props.onChange(fileEvent(JSON.stringify([{ t: 0.2, end: 0.8, text: 'stale-preview' }]))); await f.settle()
  assert.ok(f.button('Use imported transcript'))
  if (replacement === 'version') f.c.s.version++
  else f.c.s.project.assets.a.duration = 1
  await f.settle()
  f.button('Use imported transcript').props.onClick(); await f.settle()
  assert.deepEqual(f.words(), [])
  assert.equal(f.button('Use imported transcript'), undefined)
  assert.ok(f.nodes().some(node => f.text(node).includes('changed after the import preview')))
  assert.equal(f.c.calls.filter(call => call.route === '/api/transcript' && call.body).length, 0)
})
