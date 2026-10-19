import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { applyOps, BLEND_MODES, clipEnd, compView, MATTE_MODES, newProject, round } from '../core/project.js'

let dependencyRoot = path.dirname(fileURLToPath(import.meta.url))
while (!fs.existsSync(path.join(dependencyRoot, 'editor/node_modules/htm/package.json'))) {
  if (dependencyRoot === path.dirname(dependencyRoot)) throw Error('Cannot locate the installed editor dependencies')
  dependencyRoot = path.dirname(dependencyRoot)
}
const htm = createRequire(path.join(dependencyRoot, 'editor/package.json'))('htm')
const source = fs.readFileSync(new URL('../web/ui/motion/layers.js', import.meta.url), 'utf8')
const body = source.slice(source.indexOf('function LayerRow('), source.indexOf('\nfunction GroupRow('))
assert.ok(body.startsWith('function LayerRow('), 'The fixture executes the actual layer component')
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const nodes = value => value && typeof value === 'object' ? [value, ...flatten(value.children).flatMap(nodes)] : []
const layerName = c => c.label ?? c.kind
const MATTE_LABEL = { alpha: 'Alpha', alphaInverted: 'Alpha inv', luma: 'Luma', lumaInverted: 'Luma inv' }

function fixture(comp = null) {
  const project = newProject('Layer choices')
  const tracks = [
    { id: 'V1', kind: 'video', clips: [{ id: 'child', kind: 'null', label: 'Child', start: 0, dur: 4 }] },
    { id: 'V2', kind: 'video', clips: [{ id: 'parent', kind: 'null', label: 'A long parent label', start: 0, dur: 4, x: 21 }] },
    { id: 'A1', kind: 'audio', clips: [{ id: 'sound', kind: 'audio', label: 'Audio', start: 0, dur: 4 }] },
  ]
  if (comp) project.comps = { [comp]: { id: comp, width: 1080, height: 1920, fps: 30, tracks } }
  else project.tracks = tracks
  const store = { project, selection: ['parent'] }, time = { t: 1 }
  const edits = [], history = []
  const edit = (op, label) => {
    const scoped = comp ? { ...op, comp } : op
    const next = applyOps(store.project, [scoped]).project
    history.push(structuredClone(store.project))
    edits.push({ op: scoped, label })
    store.project = next
  }
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: flatten(children) })
  const state = { open: {} }
  const component = new Function('html', 'store', 'time', 'ms', 'mset', 'useState', 'edit', 'set', 'layerName', 'BLEND_MODES', 'MATTE_MODES', 'MATTE_LABEL', 'ROW', 'KIND_ICON', 'clipEnd', 'round', 'viewProject', 'inView', 'soloOps', 'openComposition', `${body}\nreturn LayerRow`)(
    htm.bind(h), store, time, () => state, value => Object.assign(state, value), value => [value, () => {}], edit,
    value => Object.assign(store, value), layerName, BLEND_MODES, MATTE_MODES, MATTE_LABEL, 22, {}, clipEnd, round,
    () => compView(store.project, comp), (view, op) => view.compId ? { ...op, comp: view.compId } : op, () => [], () => {},
  )
  const view = () => compView(store.project, comp)
  const clip = () => view().tracks[0].clips[0]
  function render() {
    const v = view()
    return component({ row: { clip: clip(), track: v.tracks[0], n: 1 }, view: v, X: t => t * 80, zoom: 80, marquee: () => {}, setWhip: () => {} })
  }
  const choice = name => nodes(render()).find(node => node.type === 'select' && node.props.class.split(' ').includes(name))
  return { store, edits, history, clip, view, render, choice, change: (name, value) => choice(name).props.onChange({ target: { value } }), undo: () => { store.project = history.pop() } }
}

for (const comp of [null, 'nested']) {
  const context = comp ? 'nested composition' : 'root timeline'
  test(`${context}: native choices retain names, values and the complete valid option lists`, () => {
    const f = fixture(comp)
    assert.equal(f.choice('mode').props['aria-label'], 'Blend mode for Child')
    assert.equal(f.choice('matte').props['aria-label'], 'Track matte for Child')
    assert.equal(f.choice('parent').props['aria-label'], 'Parent for Child')
    assert.deepEqual(nodes(f.choice('mode')).filter(n => n.type === 'option').map(n => n.props.value), BLEND_MODES)
    assert.deepEqual(nodes(f.choice('matte')).filter(n => n.type === 'option').map(n => n.props.value), ['', ...MATTE_MODES])
    assert.deepEqual(nodes(f.choice('parent')).filter(n => n.type === 'option').map(n => n.props.value), ['', 'parent'])
    assert.equal(f.choice('mode').props.value, 'normal')
    assert.equal(f.choice('matte').props.value, '')
    assert.equal(f.choice('parent').props.value, '')
    assert.deepEqual(f.edits, [])
  })
  test(`${context}: every blend mode commits one actual operation and one undo restores it`, () => {
    const f = fixture(comp)
    for (const mode of BLEND_MODES) {
      const before = structuredClone(f.store.project), count = f.edits.length
      f.change('mode', mode)
      assert.equal(f.edits.length, count + 1)
      assert.equal(f.clip().blend ?? 'normal', mode)
      assert.equal(f.choice('mode').props.value, mode)
      assert.equal(f.edits.at(-1).op.set.blend, mode === 'normal' ? null : mode)
      if (comp) assert.deepEqual(f.store.project.tracks, before.tracks)
      f.undo()
      assert.deepEqual(f.store.project, before)
    }
  })
  test(`${context}: every matte mode and clearing retain the existing actual operation`, () => {
    const f = fixture(comp)
    for (const mode of [...MATTE_MODES, '']) {
      const before = structuredClone(f.store.project), count = f.edits.length
      f.change('matte', mode)
      assert.equal(f.edits.length, count + 1)
      assert.equal(f.clip().matte?.mode ?? '', mode)
      assert.equal(f.choice('matte').props.value, mode)
      assert.deepEqual(f.edits.at(-1).op.matte, mode ? { mode } : null)
      f.undo()
      assert.deepEqual(f.store.project, before)
    }
  })
  test(`${context}: clearing an active matte removes it and one undo restores its mode`, () => {
    const f = fixture(comp)
    f.change('matte', 'alphaInverted')
    const before = structuredClone(f.store.project), count = f.edits.length
    f.change('matte', '')
    assert.equal(f.edits.length, count + 1)
    assert.equal(f.clip().matte, undefined)
    assert.equal(f.choice('matte').props.value, '')
    f.undo()
    assert.deepEqual(f.store.project, before)
    assert.equal(f.choice('matte').props.value, 'alphaInverted')
  })
  test(`${context}: assigning and clearing a parent retain its reference pose and full name`, () => {
    const f = fixture(comp), before = structuredClone(f.store.project)
    f.change('parent', 'parent')
    assert.equal(f.clip().parent, 'parent')
    assert.equal(f.clip().parentRef.x, 21)
    assert.equal(f.choice('parent').props.value, 'parent')
    assert.equal(f.choice('parent').props.title, 'Parent: A long parent label')
    f.change('parent', '')
    assert.equal(f.clip().parent, undefined)
    assert.equal(f.clip().parentRef, undefined)
    f.undo()
    assert.equal(f.clip().parent, 'parent')
    f.undo()
    assert.deepEqual(f.store.project, before)
  })
  test(`${context}: invalid parent and matte edits preserve the last valid project`, () => {
    const f = fixture(comp)
    f.view().tracks[1].clips[0].parent = 'child'
    const before = structuredClone(f.store.project)
    assert.throws(() => f.change('parent', 'parent'), /loop/)
    assert.throws(() => f.change('matte', 'invalid'), /matte mode/)
    assert.deepEqual(f.store.project, before)
    assert.deepEqual(f.edits, [])
  })
  test(`${context}: selecting a choice does not change the layer selection`, () => {
    const f = fixture(comp), before = [...f.store.selection]
    const left = nodes(f.render()).find(node => node.props.class === 'mt-l mt-grid')
    left.props.onPointerDown({ target: { closest: () => f.choice('mode') } })
    assert.deepEqual(f.store.selection, before)
    assert.deepEqual(f.edits, [])
  })
  test(`${context}: locked-track validation still rejects each edit without mutation`, () => {
    const f = fixture(comp)
    f.view().tracks[0].locked = true
    const before = structuredClone(f.store.project)
    for (const [name, value] of [['mode', 'multiply'], ['matte', 'alpha'], ['parent', 'parent']]) assert.throws(() => f.change(name, value), /locked/)
    assert.deepEqual(f.store.project, before)
    assert.deepEqual(f.edits, [])
  })
}
