import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { portableLibraryPlan, remapPortableLibraryItem } from '../core/library-portable.js'
import { applyOps, newProject } from '../core/project.js'
import { prepareLibraryOps } from '../core/library-resources.js'
import { parseCube } from '../core/cube-lut.js'
import { bundle } from '../../native/scripts/bundle-core.mjs'

const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'
const hash = crypto.createHash('sha256').update(cube).digest('hex')
const sourcePath = 'luts/Original.cube', destination = `luts/Component-${hash}.cube`
const receipt = { type: 'lut', size: 2, sourceHash: hash }
const item = () => ({ id: 'lib1', category: 'effect', name: 'Editable look', body: { assets: {}, resources: { [sourcePath]: receipt }, settings: { grade: { lut: sourcePath, lutMix: 0.65, saturation: 0.9 } } } })
const resources = () => ({ [sourcePath]: { ...receipt, text: cube } })

test('exported resources rebind and apply as independent editable native grade data', async () => {
  const original = item(), untouched = structuredClone(original)
  const exported = JSON.parse(JSON.stringify({ item: original, resources: resources() }))
  const plan = portableLibraryPlan(exported.item, exported.resources)
  assert.equal(plan.files[0].text, cube)
  assert.equal(plan.files[0].path, destination)
  const imported = remapPortableLibraryItem(exported.item, { [sourcePath]: destination })
  delete imported.id
  const base = applyOps(newProject('Destination'), [{ op: 'add_color', dur: 2 }]).project
  const inspect = path => { assert.equal(path, destination); return receipt }
  const prepared = await prepareLibraryOps(base, [{ op: 'library_register', item: imported }], inspect)
  const saved = applyOps(base, prepared.ops).project
  const reopened = JSON.parse(JSON.stringify(saved))
  const applied = applyOps(reopened, [{ op: 'library_apply', item: 'lib1', id: 'c1' }]).project
  const grade = applied.tracks[0].clips[0].nodes.list.find(node => node.grade?.lut === destination).grade
  assert.equal(grade.lutMix, 0.65); assert.equal(grade.saturation, 0.9)
  assert.deepEqual(applied.assets, {})
  grade.saturation = 0.4
  assert.equal(reopened.library.items[0].body.settings.grade.saturation, 0.9)
  assert.deepEqual(original, untouched)
})

test('actual native JavaScript bridge uses the portable validator and rebind function', () => {
  const context = vm.createContext({}); vm.runInContext(bundle(), context)
  const bridge = context.ReelCore.bridge
  const planned = JSON.parse(bridge.portableLibraryPlan(JSON.stringify(item()), JSON.stringify(resources())))
  assert.equal(planned.files[0].path, destination)
  const mapped = JSON.parse(bridge.remapPortableLibraryItem(JSON.stringify(item()), JSON.stringify({ [sourcePath]: destination })))
  assert.equal(mapped.body.settings.grade.lut, destination)
})

for (const [name, mutate] of [
  ['missing', value => delete value[sourcePath]],
  ['extra', value => value['luts/extra.cube'] = value[sourcePath]],
  ['wrong hash', value => value[sourcePath].sourceHash = '0'.repeat(64)],
  ['wrong grid', value => value[sourcePath].text = cube.replace('SIZE 2', 'SIZE 3')],
  ['malformed CUBE', value => value[sourcePath].text = 'invalid'],
  ['unknown resource field', value => value[sourcePath].file = '/tmp/file'],
  ['BOM', value => value[sourcePath].text = '\ufeff' + cube],
  ['NUL', value => value[sourcePath].text = cube + '\0'],
  ['unpaired surrogate', value => value[sourcePath].text = cube + '\ud800'],
  ['oversized', value => value[sourcePath].text = '#'.repeat(2 * 1024 * 1024 + 1)],
]) test(`portable validation refuses ${name} resources`, () => {
  const value = resources(); mutate(value)
  assert.throws(() => portableLibraryPlan(item(), value))
})

for (const path of ['../escape.cube', '/outside.cube', 'luts/../escape.cube', 'luts//look.cube', 'C:/look.cube', 'luts\\look.cube']) {
  test(`portable validation refuses escaping source path ${path}`, () => {
    const value = item(); value.body.settings.grade.lut = path; value.body.resources = { [path]: receipt }
    assert.throws(() => portableLibraryPlan(value, { [path]: { ...receipt, text: cube } }))
  })
}

test('unadmitted destination remapping and media dependencies are refused', () => {
  assert.throws(() => remapPortableLibraryItem(item(), { [sourcePath]: 'luts/changed.cube' }))
  assert.throws(() => remapPortableLibraryItem(item(), {}))
  const value = item(); value.body.assets['media/input.png'] = { width: 1, height: 1 }
  assert.throws(() => portableLibraryPlan(value, resources()), /media|unreferenced/i)
})

test('file-free version 1 data retains its original editable fields', () => {
  const value = item(); delete value.body.resources; delete value.body.settings.grade.lut
  assert.deepEqual(portableLibraryPlan(value, {}), { files: [] })
  assert.deepEqual(remapPortableLibraryItem(value, {}), value)
  assert.equal(parseCube(cube).size, 2)
})
