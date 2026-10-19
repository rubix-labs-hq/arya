import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { applyOps, newProject } from '../core/project.js'

const require = createRequire(path.join(process.cwd(), 'editor/package.json'))
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

async function fixture(kind = 'native', saved = false) {
  const key = `video-ui-${Math.random()}`, project = newProject('subject', { width: 100, height: 200, fps: 2 })
  const clip = { id: 'c1', kind: 'video', src: 'source.mov', start: 0, in: 1, dur: 2, speed: 2 }
  project.assets[clip.src] = { hasVideo: true, width: 400, height: 200, fps: 24, duration: 10 }
  project.tracks[0].clips = [structuredClone(clip)]
  project.comps = { portrait: { id: 'portrait', name: 'Portrait', width: 100, height: 200, fps: 2, tracks: [{ id: 'V1', kind: 'video', clips: [clip] }] } }
  if (saved) {
    const c = project.comps.portrait.tracks[0].clips[0]
    c.src = 'media/denoised/old.mp4'; c.in = 0.5
    c.noiseReduction = { src: 'source.mov', in: 1, dur: 5, output: c.src, settings: { quality: 'high', strength: 0.3, spatial: 0.6, temporal: 0.4, detail: 0.8, sigma: 0.08 } }
    project.assets[c.src] = { hasVideo: true, duration: 5, width: 400, height: 200, fps: 24 }
  }
  const context = { s: { project, version: 4, root: '/original', openComp: 'portrait', selection: ['c1'], caps: { processing: { videoDenoise: true }, analysis: { autoReframe: kind === 'native' } } }, layoutStored: { showInspector: false, media: 220, inspector: 340, showMedia: false }, calls: [], edits: [], notes: [], seeks: [], values: [], effects: [], index: 0, pending: [] }
  context.state = initial => { const i = context.index++; if (!(i in context.values)) context.values[i] = initial; return [context.values[i], value => context.values[i] = value] }
  context.effect = (fn, deps) => { const i = context.index++, old = context.effects[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) context.pending.push(() => { old?.cleanup?.(); context.effects[i] = { deps, cleanup: fn() } }) }
  context.api = async (route, body) => { context.calls.push({ route, body }); if (route === '/api/video/caps') return { videoDenoise: true }; if (route === '/api/analysis/autoreframe') return { samples: [{ t: 0, x: 50, y: 100 }, { t: 2, x: 30, y: 100 }] }; return { id: 'd', state: 'done', applied: true, output: 'media/denoised/output.mp4' } }
  context.edit = async (ops, summary, options) => { context.edits.push({ ops, summary, options }); assert.equal(options.expectedVersion, context.s.version); context.s.project = applyOps(context.s.project, ops).project; context.s.version++; return { version: context.s.version } }
  globalThis[key] = context
  const shim = url(`const c=globalThis[${JSON.stringify(key)}];export const store=c.s;export const useStore=()=>store;export const api=(...a)=>c.api(...a);export const edit=(...a)=>c.edit(...a);export const set=p=>Object.assign(store,typeof p==='function'?p(store):p);export const toast=(...a)=>c.notes.push(a);export const viewProject=()=>store.openComp?{...store.project,...store.project.comps[store.openComp],assets:store.project.assets}:store.project;`)
  const hooks = url(`const c=globalThis[${JSON.stringify(key)}];export const useState=x=>c.state(x);export const useEffect=(f,d)=>c.effect(f,d);`)
  const layoutHooks = url('export const useReducer=()=>[0,()=>{}];export const useRef=x=>({current:x});export const useState=x=>[x,()=>{}];export const useEffect=f=>f();')
  let layoutSource = await fs.readFile(new URL('../web/ui/layout.js', import.meta.url), 'utf8')
  layoutSource = layoutSource.replace("'preact'", JSON.stringify(pathToFileURL(require.resolve('preact')).href)).replace("'preact/hooks'", JSON.stringify(layoutHooks)).replace("'htm'", JSON.stringify(pathToFileURL(require.resolve('htm')).href))
  layoutSource = `const taskStorage={getItem:()=>JSON.stringify(globalThis[${JSON.stringify(key)}].layoutStored),setItem:(_key,value)=>globalThis[${JSON.stringify(key)}].layoutStored=JSON.parse(value)};\n` + layoutSource.replaceAll('localStorage', 'taskStorage')
  const layoutURL = url(layoutSource)
  const file = new URL('../web/ui/plugins/video-processing.js', import.meta.url)
  let source = await fs.readFile(file, 'utf8')
  for (const [old, replacement] of [
    ['preact', pathToFileURL(require.resolve('preact')).href], ['htm', pathToFileURL(require.resolve('htm')).href], ['preact/hooks', hooks], ['../../host.js', url(`export const host={kind:${JSON.stringify(kind)}};`)],
    ['../engine-host.js', url(`export const player={seek:t=>globalThis[${JSON.stringify(key)}].seeks.push(t)};`)], ['../layout.js', layoutURL], ['../registry.js', new URL('../web/ui/registry.js', import.meta.url).href], ['../store.js', shim], ['../processing-workflows.js', new URL('../web/ui/processing-workflows.js', import.meta.url).href],
  ]) source = source.replace(JSON.stringify(old), JSON.stringify(replacement)).replace(`'${old}'`, JSON.stringify(replacement))
  const { VideoProcessing } = await import(url(source))
  const render = () => { context.index = 0; const tree = VideoProcessing({ clip: context.s.project.comps.portrait.tracks[0].clips[0] }); const effects = context.pending.splice(0); effects.forEach(fn => fn()); return tree }
  const walk = (node, out = []) => { if (Array.isArray(node)) node.forEach(n => walk(n, out)); else if (node && typeof node === 'object') { out.push(node); walk(node.props?.children, out) }; return out }
  const text = node => [node.props.children].flat(Infinity).filter(v => typeof v === 'string').join('')
  const button = label => walk(render()).find(n => n.type === 'button' && text(n) === label)
  render(); await tick(); render()
  return { context, render, walk, button, cleanup() { context.effects.forEach(e => e?.cleanup?.()); delete globalThis[key] } }
}

test('actual Process inspector and clip-menu route exposes native denoise with selected options', async t => {
  const f = await fixture(); t.after(f.cleanup)
  const registry = (await import('../web/ui/registry.js')).registry
  assert.equal(registry.inspectors.find(s => s.id === 'processing').label, 'Process')
  const control = f.walk(f.render()).find(n => n.type === 'input' && n.props['aria-label'] === 'Strength')
  control.props.onInput({ target: { value: '0.2' } }); f.render()
  assert.equal(f.button('Denoise selected clip').props.disabled, false)
  f.button('Denoise selected clip').props.onClick(); await tick()
  const request = f.context.calls.find(c => c.route === '/api/video/denoise')
  assert.equal(request.body.strength, 0.2); assert.equal(request.body.comp, 'portrait'); assert.equal(request.body.in, 1); assert.equal(request.body.dur, 4); assert.equal(request.body.fps, 24); assert.equal(request.body.expectedVersion, 4)
  const menu = registry.clipMenus.at(-1)(null, { clip: f.context.s.project.comps.portrait.tracks[0].clips[0] }); menu[0].run(); assert.equal(f.context.s.inspectorTab, 'processing'); assert.equal(f.context.layoutStored.showInspector, true); assert.equal(f.context.layoutStored.showMedia, false); assert.equal(f.context.layoutStored.media, 220); assert.equal(f.context.s.page, 'edit'); assert.equal(f.context.s.viewerMode, 'timeline')
})

test('actual native detect button applies one editable scoped reframe and refuses stale captured dispatch', async t => {
  const f = await fixture(); t.after(f.cleanup)
  f.button('Detect subject and reframe').props.onClick(); await tick()
  assert.equal(f.context.calls[0].body.apply, false); assert.equal(f.context.calls[0].body.fps, 2); assert.equal(f.context.edits.length, 1)
  assert(f.context.edits[0].ops.every(op => op.comp === 'portrait'))
  const stale = f.button('Denoise selected clip').props.onClick; f.context.s.version++; stale(); await tick()
  assert.equal(f.context.calls.filter(c => c.route === '/api/video/denoise').length, 0)
})

test('actual standalone inspector checks local denoise capability and exposes complete tracked-subject route', async t => {
  const f = await fixture('http'); t.after(f.cleanup)
  assert.equal(f.context.calls[0].route, '/api/video/caps'); assert.equal(f.button('Detect subject and reframe'), undefined)
  f.button('Draw subject for local tracking').props.onClick(); assert.equal(f.context.s.inspectorTab, 'tracking'); assert.equal(f.context.seeks[0], 0)
  f.context.s.trk.results = { 0: { pts: [[50, 100]] }, 1: { pts: [[100, 100]] }, 2: { pts: [[200, 100]] }, 3: { pts: [[300, 100]] } }
  await f.button('Reframe tracked subject').props.onClick(); assert.equal(f.context.edits.length, 1)
  assert.equal(f.context.s.project.tracks[0].clips[0].fit, undefined); assert.equal(f.context.s.project.comps.portrait.tracks[0].clips[0].fit, 'cover')
})


test('reopened denoise controls load saved settings, revise original source, and restore trimmed source', async t => {
  const f = await fixture('browser', true); t.after(f.cleanup)
  const controls = f.walk(f.render())
  assert.equal(controls.find(n => n.type === 'select' && n.props['aria-label'] === 'Denoise quality').props.value, 'high')
  assert.equal(controls.find(n => n.type === 'input' && n.props['aria-label'] === 'Strength').props.value, 0.3)
  f.button('Denoise selected clip').props.onClick(); await tick()
  assert.equal(f.context.calls.find(c => c.route === '/api/video/denoise').body.useOriginal, true)
  assert.equal(f.context.calls.find(c => c.route === '/api/video/denoise').body.sigma, 0.08)
  f.button('Restore source before denoise').props.onClick(); await tick()
  const c = f.context.s.project.comps.portrait.tracks[0].clips[0]
  assert.equal(c.src, 'source.mov'); assert.equal(c.in, 1.5); assert.equal(c.noiseReduction, undefined)
  assert.equal(f.context.s.project.tracks[0].clips[0].src, 'source.mov')
})
