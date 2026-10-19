import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'
import { applyOps, newProject } from '../core/project.js'
import { libraryLUTDependencies, libraryPlacesObject, describeLibraryItem, validateLibraryItem } from '../core/library.js'
import { prepareLibraryOps, verifyLibraryInputs } from '../core/library-resources.js'
import colorRoutes from '../routes/color.mjs'

const editor = new URL('../', import.meta.url)
registerHooks({ resolve(specifier, context, next) { return next(specifier.startsWith('/core/') ? new URL(`.${specifier}`, editor).href : specifier, context) } })
const { captureLibrarySource, libraryApplyPlan, libraryItemFacts, librarySaveChoices, librarySourceStatus } = await import('../web/ui/library/model.js')
const owned = process.env.ARYA_LUT_FIXTURE_ROOT ?? fileURLToPath(new URL('../../../evidence/lut-fixtures/', import.meta.url))
fs.mkdirSync(owned, { recursive: true })
const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'
const lut = 'luts/look.cube'
const resource = { type: 'lut', size: 2, sourceHash: createHash('sha256').update(cube).digest('hex') }
const run = (p, ops) => applyOps(p, ops).project
const saveOp = (extra = {}) => ({ op: 'library_save', comp: null, category: 'effect', name: 'Reusable look', source: { clip: 'c1' }, ...extra })
function scene() {
  return run(newProject('LUT component'), [
    { op: 'add_color', start: 0, dur: 4, color: '#223344' },
    { op: 'update', id: 'c1', set: { grade: { lut, lutMix: 0.7 } } },
    { op: 'add_color', start: 6, dur: 4, color: '#667788' },
  ])
}
function files(t) {
  const root = fs.mkdtempSync(path.join(owned, 'case-'))
  fs.mkdirSync(path.join(root, 'luts'))
  fs.writeFileSync(path.join(root, lut), cube)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const service = colorRoutes({ ROOT: root, getProject: () => scene(), getVersion: () => 7, editOps: () => { throw new Error('Unexpected color edit') } })
  return { root, inspect: value => service.routes['POST /api/luts/inspect']({ path: value }) }
}
async function saved(p, inspect) { return run(p, (await prepareLibraryOps(p, [saveOp()], inspect)).ops) }

test('an actual CUBE inspection admits a separate resource without inventing a Media asset', async t => {
  const f = files(t), p = scene(), before = structuredClone(p)
  const prepared = await prepareLibraryOps(p, [saveOp()], f.inspect)
  verifyLibraryInputs(prepared.inputs, f.inspect)
  const q = run(p, prepared.ops), item = q.library.items[0]
  assert.deepEqual(item.body.resources, { [lut]: resource })
  assert.deepEqual(item.body.assets, {})
  assert.deepEqual(q.assets, p.assets)
  assert.equal(item.body.settings.grade.lut, lut)
  assert.deepEqual(p, before)
  assert.equal(fs.readFileSync(path.join(f.root, lut), 'utf8'), cube)
})
test('save still refuses a LUT without inspected resource metadata in the pure core', () => {
  assert.throws(() => run(scene(), [saveOp()]), /inspect LUT dependency/)
})
test('a saved LUT component reloads and applies independently after its source layer is removed', async t => {
  const f = files(t), p = scene()
  let q = JSON.parse(JSON.stringify(await saved(p, f.inspect)))
  q = run(q, [{ op: 'delete', id: 'c1' }])
  const before = structuredClone(q)
  const prepared = await prepareLibraryOps(q, [{ op: 'library_apply', item: q.library.items[0].id, id: 'c2' }], f.inspect)
  const result = run(q, prepared.ops)
  assert.equal(result.tracks[0].clips.find(c => c.id === 'c2').nodes.list.find(n => n.type === 'corrector').grade.lut, lut)
  assert.deepEqual(result.assets, before.assets)
  assert.deepEqual(q, before)
  assert.deepEqual(result.library, before.library)
})
test('composition closure captures nested LUT nodes and distinct Media dependencies', async t => {
  const f = files(t)
  let p = run(newProject('Nested LUT'), [
    { op: 'add_comp', name: 'Nested', duration: 4 },
    { op: 'add_color', comp: 'k1', start: 0, dur: 4, color: '#445566' },
    { op: 'update', comp: 'k1', id: 'c1', set: { grade: { lut } } },
    { op: 'add_comp', name: 'Outer', duration: 4 },
    { op: 'comp_clip', comp: 'k2', target: 'k1', start: 0, dur: 4 },
  ])
  const op = saveOp({ source: { composition: 'k2' }, comp: 'k2' })
  const q = run(p, (await prepareLibraryOps(p, [op], f.inspect)).ops)
  assert.deepEqual(q.library.items[0].body.resources, { [lut]: resource })
  assert.deepEqual(Object.keys(q.library.items[0].body.comps).sort(), ['k1', 'k2'])
  assert.deepEqual(q.assets, p.assets)
})
test('a batch can save and apply the resulting component using the same inspected closure', async t => {
  const f = files(t), p = scene()
  const prepared = await prepareLibraryOps(p, [saveOp(), { op: 'library_apply', item: 'lib1', id: 'c2' }], f.inspect)
  assert.equal(prepared.inputs.length, 1)
  const q = run(p, prepared.ops)
  assert.equal(q.library.items[0].id, 'lib1')
  assert.equal(q.tracks[0].clips[1].nodes.list.find(n => n.type === 'corrector').grade.lut, lut)
})
for (const [label, change] of [
  ['missing', f => fs.unlinkSync(path.join(f.root, lut))],
  ['changed', f => fs.writeFileSync(path.join(f.root, lut), '# changed\n' + cube)],
  ['invalid', f => fs.writeFileSync(path.join(f.root, lut), 'not a CUBE')],
  ['symlink', f => { fs.unlinkSync(path.join(f.root, lut)); fs.writeFileSync(path.join(f.root, 'other.cube'), cube); fs.symlinkSync('../other.cube', path.join(f.root, lut)) }],
]) test(`${label} actual LUT file refuses component application without a project mutation`, async t => {
  const f = files(t), p = await saved(scene(), f.inspect), before = structuredClone(p)
  change(f)
  await assert.rejects(prepareLibraryOps(p, [{ op: 'library_apply', item: 'lib1', id: 'c2' }], f.inspect))
  assert.deepEqual(p, before)
})
test('a file changed after preparation fails the final publication check', async t => {
  const f = files(t), prepared = await prepareLibraryOps(scene(), [saveOp()], f.inspect)
  fs.writeFileSync(path.join(f.root, lut), '# changed\n' + cube)
  assert.throws(() => verifyLibraryInputs(prepared.inputs, f.inspect), /changed/)
})
for (const [label, value] of [
  ['wrong type', { ...resource, type: 'video' }],
  ['missing hash', { type: 'lut', size: 2 }],
  ['invalid size', { ...resource, size: 1 }],
  ['extra property', { ...resource, text: 'executable data' }],
]) test(`${label} resource metadata is refused before host inspection`, async () => {
  let calls = 0
  await assert.rejects(prepareLibraryOps(scene(), [saveOp({ resources: { [lut]: value } })], () => { calls++; return resource }))
  assert.equal(calls, 0)
})
test('a caller-supplied hash must match the actual LUT rather than getting silently replaced', async t => {
  const f = files(t)
  await assert.rejects(prepareLibraryOps(scene(), [saveOp({ resources: { [lut]: { ...resource, sourceHash: '0'.repeat(64) } } })], f.inspect), /changed/)
})
for (const kind of ['library_register', 'library_apply', 'library_save']) test(`${kind} refuses a declared LUT size that differs from actual inspection`, async t => {
  const f = files(t), p = await saved(scene(), f.inspect)
  p.library.items[0].body.resources[lut].size = 3
  const before = structuredClone(p)
  const op = kind === 'library_register' ? { op: kind, item: p.library.items[0] } : kind === 'library_apply' ? { op: kind, item: 'lib1', id: 'c2' } : saveOp({ resources: { [lut]: { ...resource, size: 3 } } })
  await assert.rejects(prepareLibraryOps(p, [op], f.inspect), /size does not match inspection/)
  assert.deepEqual(p, before)
})
test('LUT resources cannot replace Media dependencies or admit unreferenced files', async t => {
  const f = files(t), p = await saved(scene(), f.inspect), item = structuredClone(p.library.items[0])
  item.body.assets[lut] = { type: 'image' }
  assert.throws(() => validateLibraryItem(item), /unreferenced/)
  delete item.body.assets[lut]
  item.body.resources['luts/other.cube'] = resource
  assert.throws(() => validateLibraryItem(item), /unreferenced/)
})
for (const value of ['../outside.cube', '/absolute.cube', 'file:///look.cube', 'luts/look.png']) test(`unsafe or non-CUBE dependency ${value} refuses before file inspection`, async () => {
  const p = scene(); p.tracks[0].clips[0].grade.lut = value
  let calls = 0
  await assert.rejects(prepareLibraryOps(p, [saveOp()], () => { calls++; return resource }))
  assert.equal(calls, 0)
})
test('a registered component verifies its pinned actual LUT hash before admission', async t => {
  const f = files(t), p = await saved(scene(), f.inspect), item = structuredClone(p.library.items[0]); delete item.id
  const q = run(newProject('Reuse'), (await prepareLibraryOps(newProject('Reuse'), [{ op: 'library_register', item }], f.inspect)).ops)
  assert.deepEqual(q.library.items[0].body.resources, item.body.resources)
  fs.writeFileSync(path.join(f.root, lut), '# modified\n' + cube)
  await assert.rejects(prepareLibraryOps(newProject('Reuse'), [{ op: 'library_register', item }], f.inspect), /changed/)
})

const server = fs.readFileSync(new URL('server.mjs', editor), 'utf8')
function serverHelperImport(name) {
  const imports = [...server.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)]
  const declaration = imports.find(([, bindings]) => bindings.split(',').map(value => value.trim()).includes(name))
  assert.ok(declaration, `The actual server module must import ${name}`)
  return new URL(declaration[2], editor)
}
const serverResourceHelpers = await import(serverHelperImport('prepareLibraryOps'))
assert.equal(serverHelperImport('verifyLibraryInputs').href, serverHelperImport('prepareLibraryOps').href)
test('the actual server import declarations resolve both resource helpers', () => {
  assert.equal(typeof serverResourceHelpers.prepareLibraryOps, 'function')
  assert.equal(typeof serverResourceHelpers.verifyLibraryInputs, 'function')
})
const routeBody = server.slice(server.indexOf("  'POST /api/ops': async body => {") + "  'POST /api/ops': async body => {".length, server.indexOf("\n  'POST /api/undo':" )).replace(/\n  },\s*$/, '')
function routeController(project, inspect) {
  const factory = new Function('project', 'inspect', 'applyOps', 'prepareLibraryOps', 'verifyLibraryInputs', `
    let version = 7;
    const past = [], future = [], commits = [];
    const routes = { 'POST /api/luts/inspect': ({path}) => inspect(path) };
    const probe = () => { throw new Error('Unexpected Media probe') };
    const ensureProxy = () => Promise.resolve(), log = () => {};
    const commit = next => { past.push(project); project = next; version++; future.length = 0; commits.push(next) };
    return {
      action: async body => { ${routeBody} },
      get: () => ({project, version, past, future, commits}),
      changed: () => { version++ },
      undo: () => { future.push(project); project = past.pop(); version++ },
      redo: () => { past.push(project); project = future.pop(); version++ }
    };
  `)
  return factory(project, inspect, applyOps, serverResourceHelpers.prepareLibraryOps, serverResourceHelpers.verifyLibraryInputs)
}
test('the actual server edit handler saves and applies LUT components without a Media probe', async t => {
  const f = files(t), c = routeController(scene(), f.inspect)
  await c.action({ ops: [saveOp()], expectedVersion: 7 })
  await c.action({ ops: [{ op: 'library_apply', item: 'lib1', id: 'c2' }], expectedVersion: 8 })
  const after = structuredClone(c.get().project)
  assert.equal(c.get().commits.length, 2)
  assert.deepEqual(after.assets, {})
  c.undo(); assert.equal(c.get().project.tracks[0].clips[1].nodes, undefined)
  c.redo(); assert.deepEqual(c.get().project, after)
})
test('the actual server handler refuses a changed file before committing', async t => {
  const f = files(t); let calls = 0
  const c = routeController(scene(), value => { if (++calls === 2) fs.writeFileSync(path.join(f.root, lut), '# changed\n' + cube); return f.inspect(value) })
  await assert.rejects(c.action({ ops: [saveOp()], expectedVersion: 7 }), /changed/)
  assert.equal(c.get().commits.length, 0)
})
test('the actual server handler refuses a project changed during asynchronous preparation', async t => {
  const f = files(t); let c
  c = routeController(scene(), value => { c.changed(); return f.inspect(value) })
  await assert.rejects(c.action({ ops: [saveOp()], expectedVersion: 7 }), /project changed/)
  assert.equal(c.get().commits.length, 0)
})
test('the actual server handler refuses a registered resource with the wrong inspected CUBE size', async t => {
  const f = files(t), p = await saved(scene(), f.inspect), item = structuredClone(p.library.items[0]); delete item.id
  item.body.resources[lut].size = 3
  const c = routeController(scene(), f.inspect)
  await assert.rejects(c.action({ ops: [{ op: 'library_register', item }], expectedVersion: 7 }), /size does not match inspection/)
  assert.equal(c.get().commits.length, 0)
})
test('the actual server handler rejects a stale expected version before inspecting files', async () => {
  const c = routeController(scene(), () => { throw new Error('Unexpected inspection') })
  await assert.rejects(c.action({ ops: [saveOp()], expectedVersion: 6 }), /project changed/)
  assert.equal(c.get().commits.length, 0)
})

const plugin = fs.readFileSync(new URL('web/ui/plugins/library.js', editor), 'utf8')
const between = (a, b) => plugin.slice(plugin.indexOf(a), plugin.indexOf(b)).replace('export function', 'function')
function browserController(project, inspect, kind = 'save') {
  const store = { project, root: '/fixture', version: 7, selection: [kind === 'save' ? 'c1' : 'c2'], openComp: null }
  const states = [], refs = [], calls = [], notices = []; let cursor = 0, refCursor = 0
  const useState = value => { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], next => { states[i] = next }] }
  const useRef = value => { const i = refCursor++; return refs[i] ??= { current: value } }
  const edit = async (ops, _summary, options) => { calls.push({ ops, options }); const result = applyOps(store.project, ops); store.project = result.project; return result }
  const api = async (_route, body) => inspect(body.path)
  const shared = { useStore: () => store, useState, useRef, useEffect: () => {}, librarySaveChoices, librarySourceStatus, captureLibrarySource, libraryItemFacts, libraryApplyPlan, describeLibraryItem, libraryPlacesObject, prepareLibraryOps, store, time: { t: 1 }, api, edit, set: () => {}, toast: value => notices.push(value), labelFor: value => value, html: htm.bind(h), hasPendingEdits: () => false, editRecoveryStatus: () => null, retryEditRecovery: () => {} }
  const source = kind === 'save' ? between('export function SaveLibrarySelection(', 'export function LibraryItem(') : between('export function LibraryItem(', 'export function SavedLibrarySection(')
  const component = new Function(...Object.keys(shared), `${source}; return ${kind === 'save' ? 'SaveLibrarySelection' : 'LibraryItem'}`)(...Object.values(shared))
  const render = () => { cursor = 0; refCursor = 0; return component(kind === 'save' ? { category: 'effect' } : { item: project.library.items[0] }) }
  function find(node, predicate) { if (!node || typeof node !== 'object') return null; if (predicate(node)) return node; for (const child of [node.props?.children].flat(Infinity)) { const result = find(child, predicate); if (result) return result } return null }
  const save = async () => { find(render(), n => n.type === 'button' && n.props.onClick).props.onClick(); return find(render(), n => n.type === 'form').props.onSubmit({ preventDefault() {} }) }
  const apply = () => find(render(), n => n.type === 'button' && n.props.title?.startsWith('Apply')).props.onClick()
  return { store, states, calls, notices, save, apply }
}
test('the actual browser save callback inspects the LUT and dispatches a captured version', async t => {
  const f = files(t), c = browserController(scene(), f.inspect)
  await c.save()
  assert.equal(c.calls.length, 1)
  assert.deepEqual(c.calls[0].ops[0].resources, { [lut]: resource })
  assert.equal(c.calls[0].options.expectedVersion, 7)
})
test('the actual browser save callback refuses a source changed during LUT inspection', async t => {
  const f = files(t); let c
  c = browserController(scene(), async value => { c.store.version++; return f.inspect(value) })
  await c.save()
  assert.equal(c.calls.length, 0)
  assert.ok(c.states.some(value => typeof value === 'string' && /changed|version|stale/i.test(value)))
})
test('the actual browser apply callback refuses changed file content', async t => {
  const f = files(t), p = await saved(scene(), f.inspect), c = browserController(p, f.inspect, 'apply')
  fs.writeFileSync(path.join(f.root, lut), '# changed\n' + cube)
  await c.apply()
  assert.equal(c.calls.length, 0)
  assert.match(c.notices[0], /changed/)
})
test('the actual browser apply callback refuses a target changed during inspection', async t => {
  const f = files(t), p = await saved(scene(), f.inspect); let c
  c = browserController(p, async value => { c.store.selection = []; return f.inspect(value) }, 'apply')
  await c.apply()
  assert.equal(c.calls.length, 0)
  assert.match(c.notices[0], /selection changed/)
})
test('the native JSON bridge reports the same pinned LUT dependency as the shared core', async t => {
  const f = files(t), p = await saved(scene(), f.inspect), out = path.join(f.root, 'reel-core.js')
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../native/scripts/bundle-core.mjs', editor)), '--out', out], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(out, 'utf8'), context)
  const op = { op: 'library_apply', item: 'lib1', id: 'c2' }
  assert.deepEqual(JSON.parse(context.ReelCore.bridge.libraryLUTDependencies(JSON.stringify(p), JSON.stringify(op))), libraryLUTDependencies(p, op))
})
test('native admission and JSON transfer retain the real file guard and transfer refusal', () => {
  const native = fs.readFileSync(new URL('../native/ReelKit/Sources/ReelKit/ReelBackend.swift', editor), 'utf8')
  assert.match(native, /prepareLibraryOperations\(project: current, ops: all\)/)
  assert.match(native, /inputs\.append\(contentsOf: prepared\.inputs\)/)
  assert.match(native, /readLUTInput\(path, expectedHash: dependency\["sourceHash"\] as\? String\)/)
  assert.match(native, /ReelLUTInspection\.inspect\(text: input\.text\)/)
  assert.ok(native.includes('if let expectedSize = dependency["size"] as? Int, expectedSize != size'))
  assert.ok(native.indexOf('try verifyLUTInputs(inputs)', native.indexOf('private func applyOps')) < native.indexOf('try commit(result.project', native.indexOf('private func applyOps')))
  const transfer = fs.readFileSync(new URL('../native/App/Shared/NativeEditor/NativeLibraryModel.swift', editor), 'utf8')
  assert.match(transfer, /\["src", "lut"\]\.contains\(key\)/)
  for (const guard of [
    "static let packageLimit = 8 * 1024 * 1024",
    "guard packageVersion == 2 || envelope[\"resources\"] == nil",
    "Version 1 packages cannot contain resource files.",
    "try inspect(item, allowLUT: packageVersion == 2)",
    "try validateResources(resources, item: item)",
    "map.isEmpty else",
    "Media files are not bundled in LUT component packages. Transfer those files separately.",
    "guard paths.isEmpty || allowLUT && paths == luts else",
    "guard luts.count <= 32",
    "Set(resources.keys) == luts",
    "parts.allSatisfy({ !$0.isEmpty && $0 != \".\" && $0 != \"..\" })",
    "guard !data.isEmpty, data.count <= 2 * 1024 * 1024, total <= 4 * 1024 * 1024,",
    "digest(data) == hash",
    "integer(inspection[\"size\"]) == size else",
    "O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC",
    "named.st_dev == after.st_dev, named.st_ino == after.st_ino, named.st_mode & S_IFMT == S_IFREG,"
  ]) {
    assert.ok(transfer.includes(guard), `Missing portable transfer guard: ${guard}`)
  }
})
