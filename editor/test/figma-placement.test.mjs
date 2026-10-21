import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { applyOps, newProject } from '../core/project.js'
import { placeCompOps } from '../core/figma.js'
import { nativeFigmaImport } from '../core/figma-native.js'
import figmaRoutes from '../routes/figma.mjs'

const frame = { id: '1:1', type: 'FRAME', name: 'Editable frame', absoluteBoundingBox: { x: 0, y: 0, width: 240, height: 180 }, children: [{ id: '1:2', type: 'TEXT', name: 'Heading', characters: 'Keep this editable', absoluteBoundingBox: { x: 20, y: 30, width: 200, height: 40 }, style: { fontFamily: 'Inter', fontSize: 24 }, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] }] }
const xml = '<frame id="1:1" name="Editable frame" x="0" y="0" width="240" height="180"><text id="1:2" name="Heading" x="20" y="30" width="200" height="40" text="Keep this editable" /></frame>'
function fixture() {
  return applyOps(newProject('Main', { width: 1920, height: 1080 }), [
    { op: 'add_title', text: 'Main stays here', start: 0, dur: 10 },
    { op: 'add_comp', name: 'Portrait destination', width: 480, height: 720, fps: 25, duration: 12 },
    { op: 'add_comp', name: 'Imported frame', width: 240, height: 180, duration: 5 },
  ]).project
}
const placements = canvas => canvas.tracks.flatMap(t => t.clips).filter(c => c.kind === 'comp')

test('composition placement uses the selected canvas, dimensions and frame rate', () => {
  const p = fixture(), original = structuredClone(p)
  const ops = placeCompOps(p, p.comps.k2, { comp: 'k1', start: 1.021 })
  const q = applyOps(p, ops).project
  assert.deepEqual(q.tracks, original.tracks)
  assert.equal(placements(q.comps.k1)[0].comp, 'k2')
  assert.equal(placements(q.comps.k1)[0].start, 1.04)
  assert.equal(placements(q.comps.k1)[0].scale, 0.5)
  assert.deepEqual(p, original)
})

test('a full nested canvas creates its own track without using or changing main tracks', () => {
  let p = fixture()
  for (const track of p.comps.k1.tracks.filter(t => t.kind === 'video')) p = applyOps(p, [{ op: 'add_color', comp: 'k1', track: track.id, start: 0, dur: 10 }]).project
  const before = structuredClone(p), ops = placeCompOps(p, p.comps.k2, { comp: 'k1', start: 2 })
  assert.equal(ops[0].op, 'add_track')
  const q = applyOps(p, ops).project
  assert.equal(q.comps.k1.tracks.length, before.comps.k1.tracks.length + 1)
  assert.deepEqual(q.comps.k1.tracks.filter(t => before.comps.k1.tracks.some(old => old.id === t.id)), before.comps.k1.tracks)
  assert.deepEqual(q.tracks, before.tracks)
  assert.equal(placements(q.comps.k1)[0].start, 2)
})

test('invalid destinations, locked tracks and audio tracks reject before placement', () => {
  const p = fixture()
  assert.throws(() => placeCompOps(p, p.comps.k2, { comp: 'gone' }), /composition/)
  assert.throws(() => placeCompOps(p, p.comps.k2, { comp: 'k1', track: 'gone' }), /track/)
  p.comps.k1.tracks[0].locked = true
  assert.throws(() => placeCompOps(p, p.comps.k2, { comp: 'k1', track: p.comps.k1.tracks[0].id }), /locked/)
  const audio = p.tracks.find(t => t.kind === 'audio')
  assert.throws(() => placeCompOps(p, p.comps.k2, { comp: null, track: audio.id }), /video/)
})

test('explicit main placement stays on main and cyclic nested placement remains atomic', () => {
  const p = fixture(), before = structuredClone(p)
  const q = applyOps(p, placeCompOps(p, p.comps.k2, { comp: null, start: 3 })).project
  assert.equal(placements(q)[0].start, 3)
  assert.deepEqual(q.comps.k1, p.comps.k1)
  assert.throws(() => applyOps(p, placeCompOps(p, p.comps.k1, { comp: 'k1' })), /contain itself/)
  assert.deepEqual(p, before)
})

test('native shared import atomically places editable layers in the captured composition', () => {
  const p = fixture(), before = structuredClone(p)
  const result = nativeFigmaImport(p, frame, { placeOnTimeline: true, comp: 'k1', start: 2, duration: 6 })
  const q = applyOps(p, result.ops).project
  assert.deepEqual(q.tracks, before.tracks)
  assert.equal(placements(q.comps.k1)[0].comp, result.comp)
  const title = q.comps[result.comp].tracks.flatMap(t => t.clips).find(c => c.kind === 'title')
  assert.equal(title.title.text, 'Keep this editable')
  assert.equal(title.note, 'figma 1:2')
  assert.deepEqual(p, before)
})

test('browser MCP route returns the actual nested placement ID and editable composition', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-figma-placement-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let project = fixture(), version = 0
  const before = structuredClone(project)
  const ctx = { ROOT: root, getProject: () => project, log() {}, editOps: async ops => { const result = applyOps(project, ops); project = result.project; return { ...result, version: ++version } } }
  const result = await figmaRoutes(ctx).routes['POST /api/figma/import-mcp']({ xml, comp: 'k1', placeOnTimeline: true, start: 4, duration: 6 })
  assert.deepEqual(project.tracks, before.tracks)
  assert.equal(result.clip, placements(project.comps.k1)[0].id)
  assert.equal(placements(project.comps.k1)[0].comp, result.comp)
  assert.ok(project.comps[result.comp].tracks.flatMap(t => t.clips).some(c => c.kind === 'title'))
})

// Execute the production Compositions component and handler with real HTM/Preact.
// Only the browser store and imported navigation/account dependencies are replaced.
const require = createRequire(process.env.ARYA_TEST_EDITOR_DEPS || new URL('../package.json', import.meta.url))
const { h } = require('preact'), htm = require('htm')
const children = value => [value?.props?.children].flat(Infinity).filter(v => v != null && v !== false)
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...children(value).flatMap(nodes)] : []
const label = value => children(value).map(v => typeof v === 'object' ? label(v) : v).join(' ')
test('actual browser Place handler sends the selected canvas explicitly to the planner', async () => {
  const project = fixture(), state = { project, root: '/fixture', version: 7, openComp: 'k1' }
  const calls = []
  const source = fs.readFileSync(new URL('../web/ui/plugins/figma.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
  const components = new Function('h', 'htm', 'useEffect', 'useRef', 'useState', 'placeCompOps', 'attachMotionIntent', 'registerBrowserTab', 'registerSettings', 'api', 'edit', 'set', 'store', 'time', 'toast', 'useStore', 'openComposition', `${source}\nreturn {Compositions};`)(h, htm, () => {}, v => ({ current: v }), v => [v, () => {}], placeCompOps, () => {}, () => {}, () => {}, () => {}, async ops => { calls.push(ops); return applyOps(project, ops) }, () => {}, state, { t: 3 }, () => {}, () => state, () => {})
  const tree = components.Compositions({ project }), rows = nodes(tree).filter(v => v.props?.class === 'comp')
  await nodes(rows.find(row => label(row).includes('Imported frame'))).find(v => v.type === 'button' && label(v) === 'Place').props.onClick()
  assert.equal(calls.length, 1)
  assert.ok(calls[0].every(op => op.comp === 'k1'))
  const q = applyOps(project, calls[0]).project
  assert.equal(placements(q.comps.k1)[0].comp, 'k2')
  assert.deepEqual(q.tracks, project.tracks)
})

test('actual browser import handler includes the selected composition or explicit main scope', async () => {
  for (const scope of ['k1', null]) {
    const state = { project: fixture(), root: '/fixture', version: 7, openComp: scope }
    const calls = [], overrides = new Map([[1, { fileKey: 'FrameFile', target: { name: 'Page', type: 'CANVAS' }, frames: [{ id: '1:1', name: 'Editable frame', type: 'FRAME' }] }], [2, ['1:1']]])
    let hook = 0
    const source = fs.readFileSync(new URL('../web/ui/plugins/figma.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
    const components = new Function('h', 'htm', 'useEffect', 'useRef', 'useState', 'placeCompOps', 'attachMotionIntent', 'registerBrowserTab', 'registerSettings', 'api', 'edit', 'set', 'store', 'time', 'toast', 'useStore', 'openComposition', `${source}\nreturn {Frames};`)(h, htm, () => {}, v => ({ current: v }), v => [overrides.has(hook) ? overrides.get(hook++) : (hook++, v), () => {}], placeCompOps, () => {}, () => {}, () => {}, async (route, body) => { calls.push({ route, body }); return { name: 'Editable frame', warnings: [] } }, () => {}, () => {}, state, { t: 3 }, () => {}, () => state, () => {})
    const button = nodes(components.Frames()).find(v => v.type === 'button' && label(v) === 'Import as composition')
    await button.props.onClick()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].route, '/api/figma/import')
    assert.equal(calls[0].body.comp, scope)
    assert.ok(Object.hasOwn(calls[0].body, 'comp'))
    assert.equal(calls[0].body.start, 3)
  }
})
