import { createProcessingAdmission, captureProcessingIdentity } from '../core/processing-admission.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import vm from 'node:vm'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { applyOps, newProject, compView, defaultNodes } from '../core/project.js'
import { parseCube } from '../core/cube-lut.js'
import { lookLUT } from '../core/look-lut.js'

const here = path.dirname(fileURLToPath(import.meta.url)), editor = path.resolve(here, '..')
const source = path.resolve(process.env.ARYA_COLOR_SOURCE ?? editor)
const url = file => pathToFileURL(file).href
const data = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
const load = async relative => fs.existsSync(path.join(source, relative)) ? import(url(path.join(source, relative))) : {}
const routeModule = await load('routes/color.mjs'), statsModule = await load('core/reference-look.js'), uploadModule = await load('core/media-upload.mjs')
const workflowSource = path.join(source, 'web/ui/color/workflows.js')
const workflowURL = fs.existsSync(workflowSource) ? data(fs.readFileSync(workflowSource, 'utf8').replace("'/core/cube-lut.js'", JSON.stringify(url(path.join(editor, 'core/cube-lut.js'))))) : null
const workflow = workflowURL ? await import(workflowURL) : {}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'
function fixture() {
  const p = newProject('Color fixture'); p.comps = {}
  const clip = { id: 'same', kind: 'color', color: '#808080', start: 0, dur: 4, grade: { exposure: 0.4 }, nodes: defaultNodes() }
  clip.nodes.list.splice(2, 0, { id: 'n4', type: 'corrector', inputs: ['n2'], grade: { saturation: 0.8 } }, { id: 'n5', type: 'lut', inputs: ['n4'], mix: 1 })
  p.tracks[0].clips = [structuredClone(clip)]
  p.comps.k1 = { id: 'k1', width: 640, height: 480, fps: 24, tracks: [{ id: 'V1', kind: 'video', clips: [structuredClone(clip)] }] }
  return p
}
function pixels(offset = 0) {
  const p = Buffer.alloc(64 * 64 * 4)
  for (let i = 0; i < 4096; i++) { p[i * 4] = 30 + i % 128 + offset; p[i * 4 + 1] = 50 + i % 96; p[i * 4 + 2] = 80 + i % 64 - offset; p[i * 4 + 3] = 255 }
  return p
}
function backend(t, overrides = {}) {
  assert.equal(typeof routeModule.default, 'function', 'actual color routes must exist')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-color-fixture-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'luts')); fs.mkdirSync(path.join(root, 'media'))
  fs.writeFileSync(path.join(root, 'luts/original.cube'), cube)
  fs.writeFileSync(path.join(root, 'media/reference.png'), 'original reference bytes')
  fs.writeFileSync(path.join(root, 'media/frame.png'), 'rendered snapshot bytes')
  const state = { project: fixture(), version: 7, edits: [], renders: [], decodes: [] }
  const ctx = {
    ROOT: root, getProject: () => state.project, getVersion: () => state.version, referenceAvailable: () => true,
    editOps: async (ops, who, summary, options) => { assert.equal(options.expectedVersion, state.version); state.project = applyOps(state.project, ops).project; state.version++; state.edits.push(ops); return { project: state.project, version: state.version } },
    probe: async () => ({ width: 512, height: 512 }),
    run: async (command, args, options) => { state.decodes.push({ command, args, options }); return { stdout: pixels(args[args.indexOf('-i') + 1].endsWith('reference.png') ? 25 : 0) } },
    callAPI: async (method, route, body) => { assert.equal(method, 'POST'); assert.equal(route, '/api/frame'); state.renders.push(body); return { path: path.join(root, 'media/frame.png') } },
    ...overrides,
  }
  const routes = routeModule.default(ctx).routes
  const request = (route, body) => { assert.equal(typeof routes[`POST ${route}`], 'function'); return routes[`POST ${route}`](body) }
  return { root, state, ctx, request }
}
const applyBody = hash => ({ path: 'luts/original.cube', expectedInputHash: hash, expectedVersion: 7, comp: 'k1', targets: [{ id: 'same', kind: 'clipGrade' }] })

test('capability availability requires both local renderer and decoder', () => {
  assert.equal(typeof routeModule.colorCapabilities, 'function')
  assert.equal(routeModule.colorCapabilities({ renderer: true, ffmpeg: false }).referenceMatch, false)
  assert.equal(routeModule.colorCapabilities({ renderer: false, ffmpeg: true }).referenceMatch, false)
  assert.equal(routeModule.colorCapabilities({ renderer: true, ffmpeg: true }).referenceMatch, true)
})
test('CUBE import preserves the existing file, inspects a project copy and never edits', t => {
  const b = backend(t), imported = b.request('/api/luts/import', { name: '../original.cube', text: cube })
  assert.notEqual(imported.path, 'luts/original.cube'); assert.equal(imported.imported, true)
  assert.deepEqual(b.request('/api/luts/inspect', { path: imported.path }), { path: imported.path, size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1], sourceHash: digest(cube) })
  assert.equal(fs.readFileSync(path.join(b.root, 'luts/original.cube'), 'utf8'), cube); assert.equal(b.state.edits.length, 0)
})
test('CUBE import rejects invalid/oversize/non-CUBE text before writing', t => {
  const b = backend(t)
  for (const body of [{ name: 'a.cube', text: 'not a cube' }, { name: 'a.txt', text: cube }, { name: 'a.cube', text: ' '.repeat(16777217) }]) assert.throws(() => b.request('/api/luts/import', body))
  assert.deepEqual(fs.readdirSync(path.join(b.root, 'luts')), ['original.cube'])
})
test('inspection rejects outside paths and linked LUTs', t => {
  const b = backend(t); fs.symlinkSync(path.join(b.root, 'luts/original.cube'), path.join(b.root, 'luts/link.cube'))
  for (const file of ['../original.cube', 'luts/link.cube']) assert.throws(() => b.request('/api/luts/inspect', { path: file }))
})
for (const target of [{ kind: 'clipGrade' }, { kind: 'nodeGrade', node: 'n4' }, { kind: 'lutNode', node: 'n5' }]) test(`apply ${target.kind} scopes duplicate clip IDs to the displayed comp and keeps grade fields`, async t => {
  const b = backend(t), info = b.request('/api/luts/inspect', { path: 'luts/original.cube' })
  const result = await b.request('/api/luts/apply', { ...applyBody(info.sourceHash), targets: [{ id: 'same', ...target }], mix: 0.6 })
  assert.equal(result.applied, true); assert.equal(result.version, 8); assert.equal(b.state.edits.length, 1)
  assert.deepEqual(result.project.tracks[0].clips[0], fixture().tracks[0].clips[0])
  const clip = result.project.comps.k1.tracks[0].clips[0], applied = target.kind === 'clipGrade' ? clip.grade : clip.nodes.list.find(n => n.id === target.node)
  assert.equal(target.kind === 'lutNode' ? applied.lut : (applied.grade ?? applied).lut, 'luts/original.cube')
  assert.equal(clip.grade.exposure, 0.4); assert.equal(clip.nodes.list.find(n => n.id === 'n4').grade.saturation, 0.8)
})
test('apply requires inspection hash, explicit version/scope, and unchanged LUT bytes', async t => {
  const b = backend(t), body = applyBody(digest(cube))
  for (const changed of [{ expectedInputHash: undefined }, { expectedInputHash: 'bad' }, { expectedVersion: 6 }, { comp: undefined }, { mix: Infinity }]) await assert.rejects(Promise.resolve().then(() => b.request('/api/luts/apply', { ...body, ...changed })))
  fs.appendFileSync(path.join(b.root, body.path), '# changed\n')
  await assert.rejects(b.request('/api/luts/apply', body), /changed/); assert.equal(b.state.edits.length, 0)
})
test('invalid, duplicate and locked targets cannot partially commit', async t => {
  const b = backend(t), body = applyBody(digest(cube))
  for (const targets of [[...body.targets, { id: 'missing', kind: 'clipGrade' }], [...body.targets, ...body.targets], [{ id: 'same', kind: 'lutNode', node: 'n4' }]]) await assert.rejects(b.request('/api/luts/apply', { ...body, targets }))
  b.state.project.comps.k1.tracks[0].locked = true
  await assert.rejects(b.request('/api/luts/apply', body), /unlocked/); assert.equal(b.state.edits.length, 0)
})
test('reference match uses rendered captured comp plus real deterministic statistics and LUT generation', async t => {
  const b = backend(t), original = fs.readFileSync(path.join(b.root, 'media/reference.png'))
  const result = await b.request('/api/looks/match', { reference: 'media/reference.png', name: 'Warm fixture', comp: 'k1', expectedVersion: 7, clip: 'same', at: 1.25, size: 17, apply: false })
  assert.deepEqual(b.state.renders, [{ at: 1.25, width: 512, comp: 'k1' }]); assert.equal(b.state.decodes.length, 2)
  for (const decode of b.state.decodes) { assert.equal(decode.command, 'ffmpeg'); assert.equal(decode.options.encoding, 'buffer'); assert.ok(decode.args.includes('scale=64:64:flags=area,format=rgba')) }
  const generated = parseCube(fs.readFileSync(path.join(b.root, result.lut), 'utf8'))
  assert.equal(generated.size, 17); assert.notEqual(fs.readFileSync(path.join(b.root, result.lut), 'utf8'), lookLUT({ size: 17 }).text)
  assert.ok(result.measurements.reference.mean[0] > result.measurements.source.mean[0]); assert.equal(result.measurements.referenceHash, digest(original))
  const record = JSON.parse(fs.readFileSync(path.join(b.root, result.manifest)))
  assert.equal(record.lut, result.lut); assert.equal(record.options.strength, 0.75); assert.equal(record.warnings.length, 2)
  assert.equal(b.state.edits.length, 0); assert.deepEqual(fs.readFileSync(path.join(b.root, 'media/reference.png')), original)
})
test('reference route refuses unavailable worker before requesting a render', async t => {
  const b = backend(t, { referenceAvailable: () => false })
  await assert.rejects(b.request('/api/looks/match', { reference: 'media/reference.png', comp: null, expectedVersion: 7, size: 17 }), /requires/)
  assert.equal(b.state.renders.length, 0)
})
test('invalid requested LUT size rejects before rendering', async t => {
  const b = backend(t)
  await assert.rejects(b.request('/api/looks/match', { reference: 'media/reference.png', comp: null, expectedVersion: 7, size: 1000 }))
  assert.equal(b.state.renders.length, 0)
})
test('reference matching rejects project or image drift before publishing LUT files', async t => {
  for (const drift of ['version', 'reference']) {
    const b = backend(t)
    b.ctx.callAPI = async () => { if (drift === 'version') b.state.version++; else fs.appendFileSync(path.join(b.root, 'media/reference.png'), 'changed'); return { path: 'media/frame.png' } }
    await assert.rejects(b.request('/api/looks/match', { reference: 'media/reference.png', comp: null, expectedVersion: 7, size: 17 }), /changed/)
    assert.deepEqual(fs.readdirSync(path.join(b.root, 'luts')), ['original.cube']); assert.equal(b.state.edits.length, 0)
  }
})
test('statistics omit transparent pixels, trim outliers, and bound zero-deviation transfer', () => {
  assert.equal(typeof statsModule.referenceStatistics, 'function')
  const p = Buffer.alloc(4096 * 4); for (let i = 0; i < 100; i++) { p[i * 4] = i < 2 ? 0 : i >= 98 ? 255 : 128; p[i * 4 + 3] = 255 }
  const stats = statsModule.referenceStatistics(p); assert.equal(stats.samples, 100); assert.ok(Math.abs(stats.mean[0] - 128 / 255) < 1e-12)
  const transfer = statsModule.referenceTransfer(stats, { mean: [0.8, 0.1, 0.2], deviation: [1, 0, 0] }, 1)
  assert.equal(transfer.gain[0], 4); assert.equal(transfer.gain[1], 0.25); assert.deepEqual(statsModule.referenceTransfer(stats, stats, 0), { gain: [1, 1, 1], offset: [0, 0, 0] })
  assert.throws(() => statsModule.referenceStatistics(Buffer.alloc(4))); assert.throws(() => statsModule.referenceStatistics(Buffer.alloc(16384)))
})
test('upload helper confines paths, refuses symlinks and preserves existing bytes', async t => {
  assert.equal(typeof uploadModule.storeMediaUpload, 'function')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-upload-fixture-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'media')); fs.writeFileSync(path.join(root, 'media/reference.png'), 'original')
  const upload = (name, directory) => uploadModule.storeMediaUpload(root, Readable.from(['new bytes']), new URLSearchParams({ name, ...(directory === undefined ? {} : { dir: directory }) }))
  assert.deepEqual(await upload('reference.png', 'media'), { path: 'media/reference-1.png' }); assert.equal(fs.readFileSync(path.join(root, 'media/reference.png'), 'utf8'), 'original')
  assert.deepEqual(await upload('..', 'media'), { path: 'media/upload.bin' })
  await assert.rejects(upload('a.png', '../escape'), /project media folder/)
  fs.symlinkSync(path.join(root, 'media'), path.join(root, 'media/linked'))
  await assert.rejects(upload('a.png', 'media/linked'), /symbolic/)
})
function controller(overrides = {}) {
  assert.equal(typeof workflow.createColorWorkflows, 'function', 'actual browser color controller must exist')
  const state = { project: fixture(), version: 7, root: '/fixture', openComp: 'k1', selection: ['same'], clip: fixture().comps.k1.tracks[0].clips[0], node: { id: 'n4', type: 'corrector' }, at: 1.5, caps: { color: { cubeImport: true, lutInspect: true, lutApply: true, referenceMatch: true } } }
  const calls = [], uploads = [], commits = [], inspection = { path: 'luts/copied.cube', size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1], sourceHash: digest(cube) }
  const request = async (route, body) => { calls.push({ route, body }); if (route === '/api/looks/match') return { lut: inspection.path, warnings: ['Review on scopes'] }; if (route === '/api/luts/apply') return { applied: true, project: structuredClone(state.project), version: 8 }; return inspection }
  const ui = workflow.createColorWorkflows({ getState: () => state, request, upload: async file => { uploads.push(file); return { path: 'media/copied.png' } }, commit: patch => { commits.push(patch); Object.assign(state, patch) }, ...overrides })
  return { state, calls, uploads, commits, inspection, ui }
}
const file = (name, bytes = cube) => ({ name, size: Buffer.byteLength(bytes), arrayBuffer: async () => Uint8Array.from(Buffer.from(bytes)).buffer })
test('browser importer sends validated UTF-8 text and applies the captured corrector in one request', async () => {
  const c = controller(); await c.ui.importCube(file('original.cube')); await c.ui.apply({ mix: 0.4 })
  assert.deepEqual(c.calls[0], { route: '/api/luts/import', body: { name: 'original.cube', text: cube } })
  assert.deepEqual(c.calls[1].body.targets, [{ id: 'same', kind: 'nodeGrade', node: 'n4' }]); assert.equal(c.calls[1].body.comp, 'k1'); assert.equal(c.calls[1].body.expectedVersion, 7); assert.equal(c.calls[1].body.expectedInputHash, digest(cube)); assert.equal(c.commits.length, 1)
})
test('browser reference workflow copies original image, generates without applying, then inspects', async () => {
  const c = controller(), original = file('original.png', 'reference')
  await c.ui.match(original, { name: 'Manual warm', strength: 0.6 })
  assert.equal(c.uploads[0], original); assert.deepEqual(c.calls.map(x => x.route), ['/api/looks/match', '/api/luts/inspect'])
  assert.deepEqual(c.calls[0].body, { reference: 'media/copied.png', name: 'Manual warm', strength: 0.6, at: 1.5, comp: 'k1', clip: 'same', expectedVersion: 7, apply: false }); assert.equal(c.commits.length, 0)
})
test('browser refuses unavailable capabilities and invalid bytes before uploading or requesting', async () => {
  const c = controller(); c.state.caps = {}
  await assert.rejects(c.ui.importCube(file('a.cube')), /support/); await assert.rejects(c.ui.match(file('a.png', 'png')), /unavailable/)
  c.state.caps = { color: { cubeImport: true, referenceMatch: true } }
  await assert.rejects(c.ui.importCube(file('a.cube', 'broken'))); await assert.rejects(c.ui.importCube({ name: 'a.cube', size: 2, arrayBuffer: async () => Uint8Array.of(255, 255).buffer }))
  assert.equal(c.calls.length, 0); assert.equal(c.uploads.length, 0)
})
for (const drift of ['root', 'openComp', 'selection', 'node', 'version', 'project', 'at']) test(`browser rejects ${drift} drift after inspection before applying`, async () => {
  const c = controller(); await c.ui.inspect('luts/copied.cube')
  if (drift === 'project') c.state.project = structuredClone(c.state.project)
  else if (drift === 'selection') c.state.selection = ['other']
  else if (drift === 'node') c.state.node = { id: 'n5', type: 'lut' }
  else c.state[drift] = drift === 'version' ? 8 : drift === 'at' ? 2 : 'changed'
  await assert.rejects(c.ui.apply(), /changed/); assert.equal(c.calls.length, 1); assert.equal(c.commits.length, 0)
})
test('Stop waiting never applies and a late reply cannot clear newer request state', async () => {
  let finish, calls = 0
  const c = controller({ request: async () => { calls++; if (calls === 1) return new Promise(resolve => { finish = resolve }); return c.inspection } })
  const late = c.ui.inspect('luts/old.cube'); c.ui.cancel(); await c.ui.inspect('luts/new.cube'); finish(c.inspection)
  await assert.rejects(late, /Stopped/); assert.equal(c.ui.state.inspected.path, c.inspection.path); assert.equal(c.ui.state.error, ''); assert.equal(c.commits.length, 0)
})
test('browser accepts only the matching success broadcast while applying', async () => {
  let c
  c = controller({ request: async (route) => { if (route !== '/api/luts/apply') return c.inspection; const project = structuredClone(c.state.project); c.state.project = structuredClone(project); c.state.version = 8; return { applied: true, version: 8, project } } })
  await c.ui.inspect('luts/copied.cube'); await c.ui.apply(); assert.equal(c.commits.length, 1)
})
test('browser refuses failed apply receipts instead of reporting success', async () => {
  let c; c = controller({ request: async route => route === '/api/luts/apply' ? { error: 'Version conflict' } : c.inspection })
  await c.ui.inspect('luts/copied.cube'); await assert.rejects(c.ui.apply(), /Version conflict/); assert.equal(c.commits.length, 0)
})
test('actual color state resolves nested duplicate clip IDs and emits explicit composition ops', async () => {
  const store = { project: fixture(), openComp: 'k1', selection: ['same'] }
  const stub = data('export const store = globalThis.__aryaColorStore; export const time={t:1}; export const set=()=>{}; export const viewProject=()=>globalThis.__aryaColorView();')
  globalThis.__aryaColorStore = store; globalThis.__aryaColorView = () => compView(store.project, store.openComp)
  let text = fs.readFileSync(path.join(source, 'web/ui/color/state.js'), 'utf8').replace("'/core/project.js'", JSON.stringify(url(path.join(editor, 'core/project.js')))).replace("'../store.js'", JSON.stringify(stub)).replace("'./graph.js'", JSON.stringify(url(path.join(editor, 'web/ui/color/graph.js'))))
  const state = await import(data(text)), clip = state.gradedClip()
  assert.equal(clip, store.project.comps.k1.tracks[0].clips[0])
  assert.equal(state.gradeTarget(clip, { id: 'n4', type: 'corrector' }).ops({ exposure: 0.2 })[0].comp, 'k1')
})
let panelSerial = 0
async function panelFixture(caps) {
  const localData = text => data(text + `\n// isolated panel ${++panelSerial}\n`)
  const file = path.join(source, 'web/ui/color/workflow-panel.js')
  assert.ok(fs.existsSync(file), 'actual LUT workflow component must exist')
  const c = controller(), values = []; let cursor = 0
  c.state.caps = { color: caps }
  const hooks = { useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next }] }, useRef(initial) { const index = cursor++; if (!(index in values)) values[index] = { current: initial }; return values[index] }, useEffect() {} }
  globalThis.__aryaPanelHooks = hooks; globalThis.__aryaPanelState = c.state
  globalThis.__aryaPanelAPI = async (route, body) => { c.calls.push({ route, body }); if (route === '/api/luts/apply') return { applied: true, project: applyOps(c.state.project, body.targets.map(target => ({ op: 'node_update', id: target.id, comp: body.comp, node: target.node, set: { grade: { lut: body.path } } }))).project, version: c.state.version + 1 }; return c.inspection }
  globalThis.__aryaPanelUpload = async picked => { c.uploads.push(picked); return { path: 'media/copied.png' } }
  const hookURL = localData('export const {useState,useRef,useEffect} = globalThis.__aryaPanelHooks;')
  const storeURL = localData('export const store=globalThis.__aryaPanelState; export const time={t:1.5}; export const useStore=()=>store; export const set=patch=>Object.assign(store,patch); export const api=(...args)=>globalThis.__aryaPanelAPI(...args);')
  const hostURL = localData('export const host={upload:(...args)=>globalThis.__aryaPanelUpload(...args)};')
  const stateURL = localData('export const gradedClip=()=>globalThis.__aryaPanelState.clip; export const selectedNode=()=>globalThis.__aryaPanelState.node;')
  const imports = { preact: url(path.join(editor, 'node_modules/preact/dist/preact.module.js')), 'preact/hooks': hookURL, htm: url(path.join(editor, 'node_modules/htm/dist/htm.module.js')), '../../host.js': hostURL, '../store.js': storeURL, './state.js': stateURL, './workflows.js': workflowURL }
  let text = fs.readFileSync(file, 'utf8')
  for (const [name, replacement] of Object.entries(imports)) text = text.replace(`from '${name}'`, `from ${JSON.stringify(replacement)}`)
  const module = await import(localData(text))
  const render = () => { cursor = 0; return module.LUTWorkflowPanel({ clip: c.state.clip, node: c.state.node }) }
  const nodes = vnode => { if (vnode == null || typeof vnode !== 'object') return []; if (Array.isArray(vnode)) return vnode.flatMap(nodes); return [vnode, ...nodes(vnode.props?.children)] }
  const textOf = vnode => { if (vnode == null) return ''; if (typeof vnode !== 'object') return String(vnode); return Array.isArray(vnode) ? vnode.map(textOf).join('') : textOf(vnode.props?.children) }
  return { c, render, nodes, textOf }
}
test('actual browser panel capability-gates picker and action controls with an explanation', async () => {
  const f = await panelFixture({}), rendered = f.render(), nodes = f.nodes(rendered)
  for (const input of nodes.filter(n => n.type === 'input' && n.props.type === 'file')) assert.equal(input.props.disabled, true)
  assert.equal(nodes.find(n => n.type === 'button' && f.textOf(n) === 'Create reference LUT').props.disabled, true)
  assert.match(f.textOf(rendered), /unavailable on this backend/)
})
test('actual browser CUBE picker callback imports and displays the inspected result', async () => {
  const f = await panelFixture({ cubeImport: true, lutInspect: true, lutApply: true, referenceMatch: true }), rendered = f.render()
  const picker = f.nodes(rendered).find(n => n.type === 'input' && n.props.accept === '.cube')
  assert.equal(picker.props.disabled, false)
  const event = { target: { files: [file('picked.cube')], value: 'picked.cube' } }; picker.props.onChange(event)
  for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(event.target.value, ''); assert.deepEqual(f.c.calls[0], { route: '/api/luts/import', body: { name: 'picked.cube', text: cube } })
  assert.match(f.textOf(f.render()), /luts\/copied.cube/)
  const apply = f.nodes(f.render()).find(n => n.type === 'button' && f.textOf(n) === 'Apply inspected LUT')
  assert.equal(apply.props.disabled, false)
  apply.props.onClick(); for (let i = 0; i < 8; i++) await Promise.resolve()
  assert.equal(f.c.calls[1].route, '/api/luts/apply'); assert.equal(f.c.calls[1].body.comp, 'k1'); assert.deepEqual(f.c.calls[1].body.targets, [{ id: 'same', kind: 'nodeGrade', node: 'n4' }])
  assert.match(f.textOf(f.render()), /one undo step/)
})
test('color page actually mounts the new palette and uses the visible composition strip', () => {
  const text = fs.readFileSync(path.join(source, 'web/ui/color.js'), 'utf8')
  assert.match(text, /\['look-tools', 'LUT & reference'\]/); assert.match(text, /<\$\{LUTWorkflowPanel\} clip=\$\{clip\} node=\$\{node\}/)
  assert.match(text, /function ClipStrip\(\)[\s\S]*?const p = viewProject\(\)/)
})
test('native source exposes matching import/capability routes with bounded nonoverwriting writes', () => {
  const native = path.join(source, '../native/ReelKit/Sources/ReelKit/ReelBackend.swift')
  const text = fs.readFileSync(native, 'utf8')
  assert.match(text, /case \("POST", "\/api\/luts\/import"\): return try importLUT\(b\)/)
  assert.match(text, /\("color", .object\(\[\("cubeImport", true\)/)
  const start = text.indexOf('private func importLUT('), end = text.indexOf('private func inspectLUT(', start), fn = text.slice(start, end)
  assert.match(fn, /ReelLUTInspection.inspect\(text: text\)/); assert.match(fn, /text.utf8.count <= 16 \* 1024 \* 1024/); assert.match(fn, /\.withoutOverwriting/); assert.match(fn, /folder.output/)
})
test('actual server route adapter forwards guarded edit version and returns project snapshots', async () => {
  const text = fs.readFileSync(path.join(source, 'server.mjs'), 'utf8'), start = text.indexOf('const routeCtx = {'), end = text.indexOf('\nasync function loadRouteModules()', start)
  const musicContext = text.match(/^function musicComposeContext\(\) \{[^]*?^\}/m)
  assert.ok(musicContext, 'extract actual music reservation context')
  const processing = createProcessingAdmission(), calls = [], noop = () => {}, scope = { ROOT: '/fixture', DOT: '', CACHE: '', HERE: '', processing, musicCompositions: new Map(), admit: (operation, context) => processing.run(operation, context), captureProcessing: captureProcessingIdentity, project: fixture(), version: 7, CHROME: '/missing/chrome', fs, colorCapabilities: routeModule.colorCapabilities }
  for (const name of ['run', 'probe', 'resolveMedia', 'readBody', 'readJson', 'send', 'serveFile', 'broadcast', 'pushActivity', 'cacheKey', 'once', 'log', 'applyOps', 'assertAssistantPublication', 'confinedFile', 'commit']) scope[name] = noop
  Object.assign(scope, { transcriptService: {}, assistantService: {}, jobs: new Map(), assistantCalls: { getStore: () => null }, routes: { 'POST /api/ops': body => { calls.push(body); return { version: 8 } } } })
  const ctx = vm.runInNewContext(musicContext[0] + '\n' + text.slice(start, end) + '\nrouteCtx', scope)
  assert.throws(() => ctx.musicComposeContext(), /no owned processing reservation/)
  ctx.assertCapacity(); assert.equal(processing.snapshot().active, 0); assert.equal(typeof ctx.getVersion, 'function'); assert.equal(ctx.getVersion(), 7)
  await ctx.editOps([], 'you', 'LUT fixture', { expectedVersion: 7, returnProject: true })
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { ops: [], who: 'you', summary: 'LUT fixture', expectedVersion: 7, returnProject: true })
  await ctx.editOps([], 'legacy', 'Old caller'); assert.equal(calls[1].returnProject, false); assert.equal(Object.hasOwn(calls[1], 'expectedVersion'), false)
})
test('actual server upload branch uses the confined helper and preserves original file bytes', async t => {
  const text = fs.readFileSync(path.join(source, 'server.mjs'), 'utf8'), marker = "if (url.pathname === '/api/upload' && req.method === 'POST') {", start = text.indexOf(marker), end = text.indexOf("    if (url.pathname === '/api/audio')", start)
  const block = text.slice(start + marker.length, end).trim().replace(/\}\s*$/, '')
  assert.equal(typeof uploadModule.storeMediaUpload, 'function')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-upload-adapter-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'media')); fs.writeFileSync(path.join(root, 'media/reference.png'), 'original')
  const req = Readable.from(['copy']), res = {}, query = new URL('http://fixture/api/upload?name=reference.png'), sent = []
  const handler = vm.runInNewContext(`(async function(){${block}})`, { ROOT: root, url: query, req, res, path, fs, storeMediaUpload: uploadModule.storeMediaUpload, send: (res, status, body) => sent.push({ status, body }) })
  await handler(); assert.equal(sent[0].status, 200); assert.equal(sent[0].body.path, 'media/reference-1.png'); assert.equal(fs.readFileSync(path.join(root, 'media/reference.png'), 'utf8'), 'original')
})
test('browser controller completes the real local route match-inspect-apply contract', async t => {
  const b = backend(t); assert.equal(typeof workflow.createColorWorkflows, 'function')
  const uiState = { root: b.root, openComp: 'k1', selection: ['same'], node: { id: 'n4', type: 'corrector' }, at: 1, caps: { color: routeModule.colorCapabilities({ renderer: true, ffmpeg: true }) } }
  const getState = () => ({ ...uiState, project: b.state.project, version: b.state.version, clip: b.state.project.comps.k1.tracks[0].clips[0] })
  const original = Buffer.from('picked original image bytes')
  const ui = workflow.createColorWorkflows({ getState, request: b.request, upload: picked => uploadModule.storeMediaUpload(b.root, Readable.from([original]), new URLSearchParams({ name: picked.name })), commit: receipt => { assert.equal(receipt.project, b.state.project); assert.equal(receipt.version, 8) } })
  const inspected = await ui.match(file('reference.png', original), { name: 'Contract look', strength: 0.6 })
  assert.equal(inspected.size, 33); assert.equal(b.state.edits.length, 0)
  await ui.apply({ mix: 0.55, space: 'srgb' }); assert.equal(b.state.edits.length, 1)
  assert.equal(b.state.project.comps.k1.tracks[0].clips[0].nodes.list.find(node => node.id === 'n4').grade.lut, inspected.path)
  assert.equal(b.state.project.tracks[0].clips[0].nodes.list.find(node => node.id === 'n4').grade.lut, undefined)
  assert.deepEqual(fs.readFileSync(path.join(b.root, 'media/reference-1.png')), original)
  assert.equal(ui.state.inspected, null); assert.match(ui.state.notice, /one undo step/)
})

test('actual LUT inspection rejects a FIFO promptly without blocking the server worker', t => {
  assert.equal(typeof routeModule.default, 'function')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-color-fifo-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const fifo = path.join(root, 'blocked.cube'); execFileSync('mkfifo', [fifo])
  const script = `import colorRoutes from ${JSON.stringify(url(path.join(source, 'routes/color.mjs')))};
const routes = colorRoutes({ ROOT: ${JSON.stringify(root)} }).routes;
try { await routes['POST /api/luts/inspect']({path:'blocked.cube'}); process.exitCode = 2 }
catch (error) { process.stdout.write(JSON.stringify({rejected:true,message:error.message})) }`
  const started = performance.now(), result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 1000 })
  assert.equal(result.error, undefined, 'FIFO inspection must return instead of timing out')
  assert.equal(result.status, 0); assert.ok(performance.now() - started < 1000)
  const response = JSON.parse(result.stdout); assert.equal(response.rejected, true); assert.match(response.message, /nonempty|regular/)
})


function inputRaceWitness(t, route, attack) {
  assert.equal(typeof routeModule.default, 'function')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-color-input-race-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const relative = route === 'lut' ? 'blocked.cube' : 'reference.png', target = path.join(root, relative), incoming = path.join(root, 'replacement')
  const bytes = route === 'lut' ? cube : 'original reference bytes'
  if (attack === 'fifo') execFileSync('mkfifo', [target])
  else {
    fs.writeFileSync(target, attack === 'empty' ? '' : bytes)
    if (attack === 'oversize') fs.truncateSync(target, (route === 'lut' ? 128 : 32) * 1048576 + 1)
    if (attack === 'swap-fifo') execFileSync('mkfifo', [incoming])
    if (attack === 'swap-regular') {
      const initial = fs.statSync(target)
      fs.writeFileSync(incoming, bytes); fs.utimesSync(incoming, initial.atime, initial.mtime)
    }
  }
  const body = route === 'lut' ? { path: relative } : { reference: relative, comp: null, expectedVersion: 7, size: 17 }
  const script = `import fs from 'node:fs';
import colorRoutes from ${JSON.stringify(url(path.join(source, 'routes/color.mjs')))};
const target = ${JSON.stringify(target)}, incoming = ${JSON.stringify(incoming)}, attack = ${JSON.stringify(attack)};
const counts = { opens: 0, reads: 0, renders: 0, decodes: 0, edits: 0, flags: [] }, descriptors = new Set();
const originalOpen = fs.openSync, originalRead = fs.readFileSync;
fs.openSync = function(file, flags, ...args) {
  if (file !== target) return originalOpen.call(this, file, flags, ...args);
  counts.opens++; counts.flags.push(flags);
  if (counts.opens === 1 && attack.startsWith('swap-')) fs.renameSync(incoming, target);
  const fd = originalOpen.call(this, file, flags, ...args); descriptors.add(fd); return fd;
};
fs.readFileSync = function(file, ...args) { if (descriptors.has(file)) counts.reads++; return originalRead.call(this, file, ...args) };
const project = { tracks: [], assets: {}, comps: {}, fps: 24 };
const routes = colorRoutes({ ROOT: ${JSON.stringify(root)}, getProject: () => project, getVersion: () => 7, referenceAvailable: () => true,
  callAPI: async () => { counts.renders++; throw new Error('Unexpected render') },
  probe: async () => { counts.decodes++; throw new Error('Unexpected probe') },
  run: async () => { counts.decodes++; throw new Error('Unexpected decoder') },
  editOps: async () => { counts.edits++; throw new Error('Unexpected edit') } }).routes;
let rejected = false, message = '';
try { await routes[${JSON.stringify(route === 'lut' ? 'POST /api/luts/inspect' : 'POST /api/looks/match')}](${JSON.stringify(body)}) }
catch (error) { rejected = true; message = error.message }
process.stdout.write(JSON.stringify({ rejected, message, counts, targetIsFIFO: fs.lstatSync(target).isFIFO() }));`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 1000 })
  assert.equal(result.error, undefined, 'Input rejection must finish promptly rather than block in file open')
  assert.equal(result.status, 0, result.stderr)
  const response = JSON.parse(result.stdout)
  t.diagnostic(JSON.stringify({ route, attack, ...response }))
  assert.equal(response.rejected, true, 'Changed or nonregular input must be rejected')
  assert.match(response.message, /nonempty|regular|changed/)
  if (attack.startsWith('swap-')) {
    assert.equal(response.counts.opens, 1, 'One race-safe descriptor open must be rejected before reading')
    assert.equal(response.counts.flags[0] & fs.constants.O_NONBLOCK, fs.constants.O_NONBLOCK)
    assert.equal(response.counts.flags[0] & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW)
  } else assert.equal(response.counts.opens, 0, 'Known invalid input must be rejected before target openSync is called')
  assert.equal(response.counts.reads, 0, 'Invalid descriptor must not be read')
  assert.deepEqual([response.counts.renders, response.counts.decodes, response.counts.edits], [0, 0, 0], 'No renderer, decoder or edit may run')
  assert.equal(response.targetIsFIFO, attack === 'fifo' || attack === 'swap-fifo')
  assert.equal(fs.existsSync(path.join(root, 'luts')), false, 'No output may be generated')
}
for (const route of ['lut', 'reference']) {
  for (const attack of ['fifo', 'empty', 'oversize']) test(`actual ${route} route rejects ${attack} input before target openSync`, t => inputRaceWitness(t, route, attack))
  test(`actual ${route} route rejects regular-to-FIFO replacement without blocking or processing`, t => inputRaceWitness(t, route, 'swap-fifo'))
  test(`actual ${route} route rejects a different regular descriptor before reading or processing`, t => inputRaceWitness(t, route, 'swap-regular'))
}


async function clipStripFixture({ populated = false, composition = false } = {}) {
  const { h } = await import('preact'), { default: htm } = await import('htm')
  const { clipEnd } = await import('../core/project.js')
  const project = newProject('Compact Color strip')
  const clips = [{ id: 'title', kind: 'title', title: { text: 'Opening' }, start: 0, dur: 4 }, { id: 'solid', kind: 'color', color: '#000000', start: 0, dur: 4 }]
  if (populated) clips.push({ id: 'video', kind: 'video', src: 'media/video.mov', start: 5, dur: 2 }, { id: 'image', kind: 'image', src: 'media/still.png', start: 0, dur: 0.5 }, { id: 'adjustment', kind: 'adjustment', start: 2, dur: 8 })
  const tracks = [{ id: 'V1', kind: 'video', clips }, { id: 'A1', kind: 'audio', clips: [{ id: 'audio', kind: 'audio', src: 'media/audio.wav', start: 0, dur: 4 }] }]
  project.tracks = composition ? [{ id: 'V1', kind: 'video', clips: [{ id: 'outside', kind: 'video', src: 'media/outside.mov', start: 0, dur: 5 }] }] : tracks
  project.comps = composition ? { k1: { id: 'k1', tracks } } : {}
  const state = { project, openComp: composition ? 'k1' : null, selection: [populated ? 'video' : 'title'] }
  const before = structuredClone(project), patches = [], seeks = [], hooks = [], time = { t: 0 }
  const viewProject = () => compView(state.project, state.openComp)
  const extract = (file, start, end) => {
    const text = fs.readFileSync(path.join(source, file), 'utf8')
    assert.equal(text.split(start).length, 2)
    const a = text.indexOf(start), b = text.indexOf(end, a + start.length)
    assert.ok(b > a)
    return text.slice(a, b).replace(/^export /, '')
  }
  const gradedBody = extract('web/ui/color/state.js', 'export function gradedClip()', '/** The clip\'s selected node id:')
  const gradedClip = new Function('viewProject', 'store', 'time', 'clipEnd', `${gradedBody}\nreturn gradedClip`)(viewProject, state, time, clipEnd)
  const body = extract('web/ui/color.js', 'function ClipStrip()', 'function StripThumb(')
  const StripThumb = () => null
  const render = new Function('html', 'useStore', 'useTime', 'viewProject', 'gradedClip', 'set', 'player', 'StripThumb', `${body}\nreturn ClipStrip`)(htm.bind(h), () => { hooks.push('store'); return state }, () => { hooks.push('time'); return time.t }, viewProject, gradedClip, patch => { patches.push(patch); Object.assign(state, patch) }, { seek: at => seeks.push(at) }, StripThumb)
  const nodes = value => value == null || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]
  return { state, before, patches, seeks, hooks, render, nodes, StripThumb, gradedClip }
}

test('empty Color media strips occupy no row and retain the selected title in the current composition', async () => {
  for (const composition of [false, true]) {
    const f = await clipStripFixture({ composition })
    assert.equal(f.render(), null)
    assert.deepEqual(f.hooks, ['store', 'time'])
    assert.equal(f.gradedClip().id, 'title')
    assert.deepEqual(f.state.selection, ['title']); assert.deepEqual(f.state.project, f.before)
    assert.deepEqual(f.patches, []); assert.deepEqual(f.seeks, [])
  }
})

test('populated Color strips retain sorted media, active selection and exact owned seek callbacks', async () => {
  for (const composition of [false, true]) {
    const f = await clipStripFixture({ populated: true, composition }), tree = f.render()
    assert.equal(tree.props.class, 'clip-strip')
    const cards = f.nodes(tree).filter(node => node.props?.class?.startsWith('strip-clip'))
    assert.deepEqual(cards.map(card => f.nodes(card).find(node => node.type === f.StripThumb).props.clip.id), ['image', 'adjustment', 'video'])
    assert.deepEqual(cards.map(card => card.props.class), ['strip-clip ', 'strip-clip ', 'strip-clip on'])
    for (const card of cards) card.props.onClick()
    assert.deepEqual(f.patches, [{ selection: ['image'] }, { selection: ['adjustment'] }, { selection: ['video'] }])
    assert.deepEqual(f.seeks, [0.25, 3, 6])
    assert.equal(f.gradedClip().id, 'video'); assert.deepEqual(f.state.project, f.before)
  }
})
