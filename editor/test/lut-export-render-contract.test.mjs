import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHash, webcrypto } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const source = path.resolve(process.env.ARYA_COLOR_CANDIDATE ?? fileURLToPath(new URL('..', import.meta.url)))
const url = relative => pathToFileURL(path.join(source, relative)).href
const data = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
const { newProject, applyOps, findClip } = await import(url('core/project.js'))
const { framePlan } = await import(url('core/render-plan.js'))
const { lookLUT, lookTransform } = await import(url('core/look-lut.js'))
const { parseCube } = await import(url('core/cube-lut.js'))
const { default: colorRoutes, colorCapabilities } = await import(url('routes/color.mjs'))
const workflowSource = fs.readFileSync(path.join(source, 'web/ui/color/workflows.js'), 'utf8').replace("'/core/cube-lut.js'", JSON.stringify(url('core/cube-lut.js')))
const { createColorWorkflows } = await import(data(workflowSource))
let frameSource = fs.readFileSync(path.join(source, 'web/engine/frame.js'), 'utf8')
const stubs = { '/core/project.js': url('core/project.js'), '/core/caption-render.js': url('core/caption-render.js'), './compositor.js': data('export const hexToRgb=()=>[0.5,0.5,0.5]'), './media.js': data('export const mediaUrl=(p,s)=>s'), './shapes.js': data('export const maskCanvas=()=>null; export const resolvedShape=()=>null; export const shapeCanvas=()=>null;'), './render-resolution.js': url('web/engine/render-resolution.js') }
for (const [name, replacement] of Object.entries(stubs)) frameSource = frameSource.replace(`from '${name}'`, `from ${JSON.stringify(replacement)}`)
const { drawFrame } = await import(data(frameSource))
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')
const cube = 'TITLE "Exact file"\r\nLUT_3D_SIZE 2\r\nDOMAIN_MIN -1 0 0\r\nDOMAIN_MAX 2 1 1\r\n0 0 0\r\n1 0 0\r\n0 1 0\r\n1 1 0\r\n0 0 1\r\n1 0 1\r\n0 1 1\r\n1 1 1\r\n'
function fixture(t, text = cube) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-lut-export-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'luts')); fs.writeFileSync(path.join(root, 'luts/exact.cube'), text)
  const state = { root, project: newProject('LUT', 160, 90, 30), version: 3, openComp: null, at: 0, selection: [], caps: { color: colorCapabilities({ renderer: false, ffmpeg: false }) } }
  const routes = colorRoutes({ ROOT: root, getProject: () => state.project, getVersion: () => state.version, editOps: () => { throw new Error('Export must not edit') } }).routes
  const downloads = [], calls = []
  const request = async (route, body) => { calls.push({ route, body }); return routes[`POST ${route}`](body) }
  const workflow = createColorWorkflows({ getState: () => state, request, download: value => downloads.push(value), commit: () => { throw new Error('Export must not commit') } })
  return { root, state, routes, request, downloads, calls, workflow }
}

for (const bom of ['', '\uFEFF']) test(`LUT export retains original UTF-8${bom ? ' BOM' : ''}, CRLF, headers and domain`, async t => {
  const f = fixture(t, bom + cube)
  assert.equal(f.state.caps.color.lutExport, true)
  const inspected = await f.workflow.inspect('luts/exact.cube')
  assert.equal(inspected.sourceHash, hash(bom + cube))
  const result = await f.workflow.exportCube()
  assert.equal(result.text, bom + cube)
  assert.deepEqual(f.downloads, [{ name: 'exact.cube', text: bom + cube }])
  assert.equal(f.state.version, 3)
  assert.equal(fs.readFileSync(path.join(f.root, 'luts/exact.cube'), 'utf8'), bom + cube)
  assert.deepEqual(parseCube(result.text).domainMin, [-1, 0, 0])
})

test('export rejects absent inspection and changed file bytes before download', async t => {
  const f = fixture(t)
  await assert.rejects(f.workflow.exportCube(), /Inspect/)
  await f.workflow.inspect('luts/exact.cube')
  fs.appendFileSync(path.join(f.root, 'luts/exact.cube'), '# changed\n')
  await assert.rejects(f.workflow.exportCube(), /changed/)
  assert.deepEqual(f.downloads, [])
  assert.throws(() => f.routes['POST /api/luts/export']({ path: 'luts/exact.cube' }), /Inspect/)
})

test('export rejects captured project drift and unavailable capability', async t => {
  const f = fixture(t)
  await f.workflow.inspect('luts/exact.cube')
  f.state.version++
  await assert.rejects(f.workflow.exportCube(), /changed/)
  await f.workflow.inspect('luts/exact.cube')
  f.state.caps.color.lutExport = false
  await assert.rejects(f.workflow.exportCube(), /unavailable/)
  assert.deepEqual(f.downloads, [])
})

test('late export replies after cancellation do not download', async t => {
  const f = fixture(t), inspection = await f.request('/api/luts/inspect', { path: 'luts/exact.cube' })
  let finish
  const workflow = createColorWorkflows({ getState: () => f.state, request: async route => route === '/api/luts/inspect' ? inspection : new Promise(resolve => { finish = resolve }), download: value => f.downloads.push(value) })
  await workflow.inspect(inspection.path)
  const pending = workflow.exportCube(); workflow.cancel()
  finish({ ...inspection, text: cube })
  await assert.rejects(pending, /Stopped/)
  assert.deepEqual(f.downloads, [])
})

test('export verifies text bytes instead of trusting a matching receipt hash', async t => {
  const f = fixture(t), inspection = await f.request('/api/luts/inspect', { path: 'luts/exact.cube' })
  const workflow = createColorWorkflows({ getState: () => f.state, request: async route => route === '/api/luts/inspect' ? inspection : { ...inspection, text: cube + '# different bytes\n' }, download: value => f.downloads.push(value) })
  await workflow.inspect(inspection.path)
  await assert.rejects(workflow.exportCube(), /bytes changed/)
  assert.deepEqual(f.downloads, [])
})

test('cancel while the digest is pending prevents the download', async t => {
  const f = fixture(t)
  await f.workflow.inspect('luts/exact.cube')
  let finish, started
  const ready = new Promise(resolve => { started = resolve })
  const saved = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async (...args) => { started(); await new Promise(resolve => { finish = resolve }); return webcrypto.subtle.digest(...args) } } } })
  try {
    const pending = f.workflow.exportCube(); await ready; f.workflow.cancel(); finish()
    await assert.rejects(pending, /Stopped/)
    assert.deepEqual(f.downloads, [])
  } finally { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: saved }) }
})

test('rendered LUT node retains space and animated mix after project save/reopen', () => {
  for (const space of ['srgb', 'working', undefined]) {
    const ops = [{ op: 'add_color', track: 'V1', dur: 4, color: '#808080' }, { op: 'node_add', id: 'c1', node: { type: 'lut', lut: 'luts/exact.cube', mix: 0.25, ...(space ? { lutSpace: space } : {}) } }, { op: 'keyframe', id: 'c1', prop: 'node.n4.mix', at: 0, value: 0.25, local: true }, { op: 'keyframe', id: 'c1', prop: 'node.n4.mix', at: 2, value: 0.75, local: true }]
    const project = JSON.parse(JSON.stringify(applyOps(newProject('Render', 160, 90, 30), ops).project))
    const draws = [], compositor = { size: [160, 90], pooled: (key, w, h) => ({ tex: key, w, h }), clear() {}, drawLayer: (target, source, layer) => draws.push(layer), blendOnto() {}, present() {}, copyInto() {} }
    drawFrame(compositor, {}, project, 1)
    const drawn = draws.find(layer => layer.grade?.lut === 'luts/exact.cube').grade
    const planned = framePlan(project, 1).layers[0].clip.nodes.list.find(node => node.type === 'lut').grade
    assert.equal(drawn.lutSpace, space ?? 'srgb')
    assert.equal(drawn.lutSpace, planned.lutSpace)
    assert.equal(drawn.lutMix, 0.5)
    assert.equal(drawn.lutMix, planned.lutMix)
    assert.equal(findClip(project, 'c1').clip.nodes.list.find(node => node.type === 'lut').lutSpace, space)
  }
})

test('LUT generation rejects parameter shapes that change renderer semantics', () => {
  for (const grade of [[], null, { exposure: [1] }, { temperature: [0.4] }, { saturation: [] }, { lift: [0.1] }, { gain: [1, 2, 3, 4] }, { gain: [1, , 1] }, { curves: [] }, { curves: { red: [[0, 0], [1, 1]] } }, { curves: { master: false } }, { curves: { master: 0 } }, { curves: { master: '' } }, { look: ['warm'] }]) assert.throws(() => lookLUT({ grade }))
  for (const grade of [{ gamma: 1 }, { gamma: [0.1, 0.2, 0.3] }, { lift: 0.1 }, { lift: [0.1, 0.2, 0.3] }, { temperature: 6500 }, { exposure: 1 }]) assert.doesNotThrow(() => lookLUT({ grade, size: 17 }))
  assert.throws(() => lookLUT({ grade: { exposure: 10000 } }), /invalid|nonfinite/)
  assert.throws(() => lookLUT({ transfer: [] }), /object/)
  assert.deepEqual(lookTransform({ exposure: 1 })([0.1, 0.2, 0.3]), [0.2, 0.4, 0.6])
})

test('browser import keeps a BOM in the copied CUBE text and its export hash', async t => {
  const f = fixture(t), text = '\uFEFF' + cube, bytes = new TextEncoder().encode(text)
  const inspected = await f.workflow.importCube({ name: 'imported.cube', size: bytes.length, arrayBuffer: async () => bytes.buffer })
  assert.equal(inspected.sourceHash, hash(text))
  const exported = await f.workflow.exportCube()
  assert.equal(exported.text, text)
  assert.equal(hash(f.downloads[0].text), inspected.sourceHash)
})

test('invalid manual grade controls reject before any reference rendering or output publication', async t => {
  const f = fixture(t), calls = []
  const routes = colorRoutes({ ROOT: f.root, getProject: () => f.state.project, getVersion: () => f.state.version, referenceAvailable: () => true, callAPI: async (...args) => calls.push(args) }).routes
  for (const grade of [{ exposure: [1] }, { curves: { red: [[0, 0], [1, 1]] } }, { curves: { master: false } }, { curves: { master: 0 } }, { curves: { master: '' } }]) await assert.rejects(routes['POST /api/looks/match']({ reference: 'missing.png', comp: null, expectedVersion: 3, grade }))
  assert.deepEqual(calls, [])
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'luts')), ['exact.cube'])
})

test('actual color component exports through its button callback and revokes the object URL', async t => {
  const f = fixture(t), values = [], clicks = [], blobs = [], revoked = [], timers = []
  let cursor = 0
  const hooks = { useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value }] }, useRef(initial) { const index = cursor++; if (!(index in values)) values[index] = { current: initial }; return values[index] }, useEffect() {} }
  globalThis.__aryaExportPanelHooks = hooks; globalThis.__aryaExportPanelState = f.state; globalThis.__aryaExportPanelRequest = f.request
  const nodeModules = path.resolve(process.env.ARYA_EDITOR_NODE_MODULES ?? fileURLToPath(new URL('../node_modules', import.meta.url)))
  const imports = { preact: pathToFileURL(path.join(nodeModules, 'preact/dist/preact.module.js')).href, 'preact/hooks': data('export const { useState,useRef,useEffect }=globalThis.__aryaExportPanelHooks;'), htm: pathToFileURL(path.join(nodeModules, 'htm/dist/htm.module.js')).href, '../../host.js': data('export const host={kind:"http"};'), '../store.js': data('export const store=globalThis.__aryaExportPanelState; export const time={t:0}; export const useStore=()=>store; export const api=(...args)=>globalThis.__aryaExportPanelRequest(...args); export const set=patch=>Object.assign(store,patch);'), './state.js': data('export const gradedClip=()=>null; export const selectedNode=()=>null;'), './workflows.js': data(workflowSource) }
  let text = fs.readFileSync(path.join(source, 'web/ui/color/workflow-panel.js'), 'utf8')
  for (const [name, replacement] of Object.entries(imports)) text = text.replace(`from '${name}'`, `from ${JSON.stringify(replacement)}`)
  const { LUTWorkflowPanel } = await import(data(text))
  const nodes = vnode => { if (vnode == null || typeof vnode !== 'object') return []; if (Array.isArray(vnode)) return vnode.flatMap(nodes); return [vnode, ...nodes(vnode.props?.children)] }
  const textOf = vnode => vnode == null ? '' : typeof vnode !== 'object' ? String(vnode) : Array.isArray(vnode) ? vnode.map(textOf).join('') : textOf(vnode.props?.children)
  const render = () => { cursor = 0; return LUTWorkflowPanel({ clip: null, node: null }) }
  const button = () => nodes(render()).find(node => node.type === 'button' && textOf(node) === 'Export inspected LUT')
  assert.equal(button().props.disabled, true)
  await values.find(value => value?.current?.inspect).current.inspect('luts/exact.cube')
  assert.equal(button().props.disabled, false)
  const saved = { document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL, setTimeout: globalThis.setTimeout }
  globalThis.document = { body: { appendChild() {} }, createElement: () => ({ click() { clicks.push({ href: this.href, download: this.download }) }, remove() {} }) }
  URL.createObjectURL = blob => { blobs.push(blob); return 'blob:arya-export' }
  URL.revokeObjectURL = url => revoked.push(url)
  globalThis.setTimeout = callback => { timers.push(callback); return 1 }
  try {
    button().props.onClick()
    for (let i = 0; i < 20 && values.find(value => typeof value?.busy === 'boolean')?.busy; i++) await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(clicks, [{ href: 'blob:arya-export', download: 'exact.cube' }])
    assert.equal(await blobs[0].text(), cube)
    assert.match(textOf(render()), /Downloaded/)
    timers.forEach(callback => callback()); assert.deepEqual(revoked, ['blob:arya-export'])
  } finally {
    globalThis.document = saved.document; URL.createObjectURL = saved.create; URL.revokeObjectURL = saved.revoke; globalThis.setTimeout = saved.setTimeout
    delete globalThis.__aryaExportPanelHooks; delete globalThis.__aryaExportPanelState; delete globalThis.__aryaExportPanelRequest
  }
})
