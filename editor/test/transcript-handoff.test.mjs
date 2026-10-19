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


for (const action of ['Make captions', 'Make shorts']) test(`${action} retains transcript owner root, locale and saved revision`, async t => {
  const f = await panel(t, (route, body) => {
    if (!route.startsWith('/api/transcript?')) return undefined
    const query = new URL(route, 'http://fixture').searchParams
    return { ...saved(query.get('src')), locale: query.get('locale') }
  })
  f.nodes().find(node => node.type === 'input' && node.props.id === 'transcript-locale').props.onChange({ target: { value: 'fr-FR' } }); await f.settle()
  f.button(action).props.onClick()
  assert.equal(f.c.s.transcript.ownerRoot, f.c.s.root)
  assert.equal(f.c.s.transcript.locale, 'fr-FR')
  assert.equal(f.c.s.transcript.revision, 1)
  assert.equal(f.c.s.transcript.fingerprint, 'a-fingerprint')
  assert.deepEqual(f.c.s.transcript.words, saved('a').words)
  assert.equal(f.c.s.browserTab, action === 'Make captions' ? 'captions' : 'shorts')
})

for (const action of ['Make captions', 'Make shorts']) test(`${action} refuses a stale root handoff callback`, async t => {
  const f = await panel(t), callback = f.button(action).props.onClick
  const previous = f.c.s.transcript
  f.c.s.root += '-changed'
  callback()
  assert.equal(f.c.s.transcript, previous)
  assert.equal(f.c.s.browserTab, undefined)
})
