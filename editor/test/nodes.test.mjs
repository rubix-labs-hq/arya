// node --test editor/test
// The Color page's node panel: every action is plain ops, checked here with applyOps + nodeOrder.
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyOps, defaultNodes, findClip, newProject, nodeOrder } from '../core/project.js'
import {
  checkGraph, defaultWindow, dragWindow, expandQualifier, graphOf, inHueArc, insertAfter, layoutGraph, nextIds, nodeNumbers,
  planBranch, planBypass, planDelete, planLink, planMove, planPreset, planRelink, planSerial, planUnlink, presetFromClip,
  qualifierAround, qualifierMatte, rgbToHsl, toWindowLocal, windowHandles, NODE_H, NODE_W,
} from '../web/ui/color/graph.js'
import { BUILTIN_PRESETS } from '../web/ui/color/presets.js'

function project() {
  const p = newProject('nodes')
  p.assets = { 'a.mp4': { duration: 10, width: 1920, height: 1080, hasVideo: true } }

  return applyOps(p, [{ op: 'append', src: 'a.mp4', track: 'V1', dur: 4 }]).project
}

const clipOf = p => findClip(p, 'c1').clip
const run = (p, ops) => applyOps(p, ops).project
const types = p => nodeOrder(clipOf(p).nodes).map(n => n.type)

function noOverlap(graph) {
  const list = graph.list
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]
      const b = list[j]
      const apart = Math.abs(a.x - b.x) >= NODE_W || Math.abs(a.y - b.y) >= NODE_H
      assert.ok(apart, `${a.id} (${a.x},${a.y}) overlaps ${b.id} (${b.x},${b.y})`)
    }
  }
}

test('serial nodes go after the selection, in one batch, laid out without overlaps', () => {
  let p = project()
  // A clip with no stored graph still has the implicit one; the first add stores it.
  assert.equal(clipOf(p).nodes, undefined)
  let plan = planSerial(p, clipOf(p), 'n2')
  assert.equal(plan.select, 'n4')
  p = run(p, plan.ops)
  assert.deepEqual(types(p), ['source', 'primary', 'corrector', 'output'])
  // Selecting the output inserts before it, never after.
  plan = planSerial(p, clipOf(p), 'n3', 'blur')
  p = run(p, plan.ops)
  assert.deepEqual(types(p), ['source', 'primary', 'corrector', 'blur', 'output'])
  assert.equal(clipOf(p).nodes.list.find(n => n.id === 'n5').radius, 8)
  noOverlap(clipOf(p).nodes)
  // Columns follow the chain left to right on one row.
  const xs = nodeOrder(clipOf(p).nodes).map(n => n.x)
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b))
  assert.ok(nodeOrder(clipOf(p).nodes).every(n => n.y === 0))
})

test('parallel and layer nodes add a mixer and a branch fed from the selection input', () => {
  let p = project()
  p = run(p, planSerial(p, clipOf(p), 'n2').ops) // n4 corrector
  const plan = planBranch(p, clipOf(p), 'n4', 'parallel')
  assert.equal(plan.select, 'n6')
  p = run(p, plan.ops)
  const g = clipOf(p).nodes
  const mixer = g.list.find(n => n.id === 'n5')
  assert.equal(mixer.type, 'parallel')
  // n4 (the selection) and n6 (the new branch) both read n2 and meet in the mixer.
  assert.deepEqual(g.links.filter(l => l.to === 'n5').sort((a, b) => a.input - b.input).map(l => [l.from, l.input]), [['n4', 0], ['n6', 1]])
  assert.equal(g.links.find(l => l.to === 'n6').from, 'n2')
  assert.equal(g.links.find(l => l.to === 'n3').from, 'n5')
  assert.deepEqual(nodeOrder(g).map(n => n.id).sort(), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
  noOverlap(g)
  // The branch sits on its own row below the main chain.
  assert.ok(g.list.find(n => n.id === 'n6').y > 0)

  const layer = planBranch(p, clipOf(p), 'n6', 'layerMixer')
  p = run(p, layer.ops)
  const g2 = clipOf(p).nodes
  const lm = g2.list.find(n => n.type === 'layerMixer')
  assert.deepEqual(lm.blends, ['normal', 'normal'])
  assert.equal(nodeOrder(g2).length, g2.list.length)
  noOverlap(g2)
})

test('parallel on the source node branches from the source itself', () => {
  const p = project()
  const out = run(p, planBranch(p, clipOf(p), 'n1').ops)
  const g = clipOf(out).nodes
  assert.equal(g.links.find(l => l.to === 'n5').from, 'n1')
  assert.equal(nodeOrder(g).length, 5)
})

test('delete, bypass, link, relink and unlink', () => {
  let p = project()
  p = run(p, planSerial(p, clipOf(p), 'n2').ops)
  p = run(p, planSerial(p, clipOf(p), 'n4', 'glow').ops) // n5
  assert.equal(planDelete(clipOf(p), 'n1'), null)
  assert.equal(planDelete(clipOf(p), 'n3'), null)
  p = run(p, planDelete(clipOf(p), 'n4'))
  assert.deepEqual(types(p), ['source', 'primary', 'glow', 'output'])

  p = run(p, planBypass(clipOf(p), 'n5'))
  assert.equal(clipOf(p).nodes.list.find(n => n.id === 'n5').enabled, false)
  p = run(p, planBypass(clipOf(p), 'n5'))
  assert.equal('enabled' in clipOf(p).nodes.list.find(n => n.id === 'n5'), false)

  // Bypass on a clip without a stored graph stores the default graph first.
  const fresh = project()
  const bypassed = run(fresh, planBypass(clipOf(fresh), 'n2'))
  assert.equal(clipOf(bypassed).nodes.list.find(n => n.id === 'n2').enabled, false)

  // Feeding the output straight from the source skips the glow; relinking puts it back.
  p = run(p, planLink(clipOf(p), 'n1', 'n3', 0))
  assert.deepEqual(types(p), ['source', 'output'])
  p = run(p, planRelink(clipOf(p), 'n5', 'n3', 0, 'n3', 0))
  assert.deepEqual(types(p), ['source', 'primary', 'glow', 'output'])
  assert.throws(() => applyOps(p, planLink(clipOf(p), 'n5', 'n2', 0)), /loop/)
  p = run(p, planUnlink(clipOf(p), 'n3', 0))
  assert.deepEqual(types(p), ['output'])
  // Unlinking on the implicit graph stores it first, then cuts the link.
  const fresh2 = project()
  const cut = run(fresh2, planUnlink(clipOf(fresh2), 'n3', 0))
  assert.deepEqual(clipOf(cut).nodes.links, [{ from: 'n1', to: 'n2', input: 0 }])
})

test('moving nodes stores positions, storing the default graph when needed', () => {
  const p = project()
  const moved = run(p, planMove(clipOf(p), { n2: { x: 170.4, y: 40.6 } }))
  const n2 = clipOf(moved).nodes.list.find(n => n.id === 'n2')
  assert.deepEqual([n2.x, n2.y], [170, 41])
  assert.deepEqual(clipOf(moved).nodes.links, defaultNodes().links)
})

test('numbers and ids follow Resolve: 01, 02 … in creation order, Input and Output unnumbered', () => {
  let p = project()
  p = run(p, planSerial(p, clipOf(p), 'n2').ops)
  p = run(p, planBranch(p, clipOf(p), 'n4').ops)
  const g = clipOf(p).nodes
  assert.deepEqual([...nodeNumbers(g)], [['n2', '01'], ['n4', '02'], ['n5', '03'], ['n6', '04']])
  assert.deepEqual(nextIds(g, 2), ['n7', 'n8'])
  assert.equal(insertAfter(g, 'n3'), 'n5')
})

test('layout separates branches and dangling nodes', () => {
  const g = {
    list: [{ id: 'n1', type: 'source' }, { id: 'n2', type: 'primary' }, { id: 'n3', type: 'output' }, { id: 'n4', type: 'corrector' }, { id: 'n5', type: 'blur' }],
    links: [{ from: 'n1', to: 'n2', input: 0 }, { from: 'n2', to: 'n3', input: 0 }, { from: 'n4', to: 'n5', input: 0 }],
  }
  const pos = layoutGraph(g)
  const placed = { list: g.list.map(n => ({ ...n, ...pos.get(n.id) })) }
  noOverlap(placed)
  assert.equal(pos.get('n4').y, pos.get('n5').y)
  assert.ok(pos.get('n4').y > 0)
})

test('every built-in preset applies as valid ops and renders through primary', () => {
  assert.deepEqual(BUILTIN_PRESETS.map(pr => pr.name), ['Teal & orange', 'Skin isolate', 'Vignette window', 'Day for night', 'Bleach bypass'])
  for (const preset of BUILTIN_PRESETS) {
    JSON.parse(JSON.stringify(preset)) // plain JSON
    let p = project()
    p = run(p, [{ op: 'update', id: 'c1', set: { grade: { exposure: 0.3 } } }])
    // Applying over an existing graph replaces it.
    p = run(p, planSerial(p, clipOf(p), 'n2', 'blur').ops)
    p = run(p, planPreset(clipOf(p), preset))
    const g = clipOf(p).nodes
    checkGraph(g)
    const order = nodeOrder(g)
    assert.equal(order.length, preset.nodes.list.length, `${preset.name}: every node renders`)
    assert.ok(order.some(n => n.type === 'primary'), `${preset.name} keeps the primary`)
    assert.ok(!g.list.some(n => n.type === 'blur'), `${preset.name} replaced the old graph`)
    assert.ok(g.list.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)))
    noOverlap(g)
    assert.deepEqual(clipOf(p).grade, { exposure: 0.3 }, `${preset.name} keeps the clip grade`)
    // The preset object itself is untouched.
    assert.ok(preset.nodes.list.every(n => n.x === undefined))
  }
})

test('saved presets round-trip the graph and the primary grade, without highlight state', () => {
  let p = project()
  p = run(p, planBranch(p, clipOf(p), 'n2', 'layerMixer').ops)
  p = run(p, [
    { op: 'update', id: 'c1', set: { grade: { saturation: 1.4 } } },
    { op: 'node_update', id: 'c1', node: 'n5', set: { qualifier: { hue: [0, 30], sat: [0.2, 1], lum: [0, 1], soft: 0.05, show: true } } },
  ])
  const preset = presetFromClip(clipOf(p), 'Mine')
  assert.equal(preset.nodes.list.find(n => n.id === 'n5').qualifier.show, undefined)
  assert.equal(clipOf(p).nodes.list.find(n => n.id === 'n5').qualifier.show, true)
  let q = project()
  q = run(q, planPreset(clipOf(q), JSON.parse(JSON.stringify(preset))))
  assert.deepEqual(clipOf(q).grade, { saturation: 1.4 })
  assert.deepEqual(nodeOrder(clipOf(q).nodes).map(n => n.id), nodeOrder(preset.nodes).map(n => n.id))
  // Stored in the project as JSON and read back.
  q = run(q, [{ op: 'project', set: { nodePresets: { Mine: preset } } }])
  assert.equal(q.nodePresets.Mine.name, 'Mine')
  q = run(q, [{ op: 'project', set: { nodePresets: { Mine: null } } }])
  assert.deepEqual(q.nodePresets, {})
  assert.throws(() => planPreset(clipOf(q), { name: 'bad', nodes: { list: [{ id: 'n1', type: 'source' }], links: [] } }), /one output/)
})

test('eyedropper ranges centre on the sample, wrap hue through 0 and key it in', () => {
  const red = [0.816, 0.125, 0.125]
  const green = [0.188, 0.627, 0.25]
  assert.deepEqual(rgbToHsl([1, 0, 0]), [0, 1, 0.5])
  assert.deepEqual(rgbToHsl([0, 0, 1]).map(v => Math.round(v * 1000) / 1000), [240, 1, 0.5])
  const q = qualifierAround(red)
  assert.deepEqual(q.hue, [342, 18])
  assert.ok(inHueArc(0, ...q.hue) && inHueArc(350, ...q.hue) && !inHueArc(40, ...q.hue))
  assert.equal(qualifierMatte(red, q), 1)
  assert.equal(qualifierMatte(green, q), 0)
  assert.equal(qualifierMatte(green, { ...q, invert: true }), 1)
  // Grey has no hue: every hue stays in, saturation keeps it to greys.
  const grey = qualifierAround([0.5, 0.5, 0.5])
  assert.deepEqual(grey.hue, [0, 360])
  assert.equal(qualifierMatte([0.5, 0.5, 0.5], grey), 1)
  assert.equal(qualifierMatte([1, 0, 0], grey), 0)
  // Shift-click widens to take in an orange sample, growing the near end.
  const orange = [0.9, 0.6, 0.1] // hue 37.5°, just outside the soft edge
  assert.equal(qualifierMatte(orange, q), 0)
  const wider = expandQualifier(q, orange)
  assert.equal(wider.hue[0], 342)
  assert.ok(wider.hue[1] > 30 && wider.hue[1] < 45)
  assert.equal(qualifierMatte(orange, wider), 1)
  assert.equal(qualifierMatte(red, wider), 1)
  // A blue sample is nearer the low end going backwards round the wheel.
  const blueish = expandQualifier(q, [0.6, 0.1, 0.8])
  assert.ok(blueish.hue[0] < 342 && blueish.hue[0] > 270)
})

test('window handles and drags agree with the shader geometry', () => {
  const fw = 1920
  const fh = 1080
  const win = defaultWindow('circle')
  const hd = windowHandles(win, fw, fh)
  assert.deepEqual(hd.center, [960, 540])
  assert.deepEqual(hd.w.map(Math.round), [960 + 480, 540])
  assert.deepEqual(hd.h.map(Math.round), [960, 540 + 270])
  // Dragging each handle to where it already is changes nothing.
  for (const handle of ['w', 'h', 'corner', 'rotate', 'soft']) {
    const out = dragWindow(handle, { win, px: 0, py: 0 }, ...hd[handle], fw, fh)
    for (const k of ['x', 'y', 'w', 'h', 'rotation', 'softness']) assert.ok(Math.abs(out[k] - win[k]) < 0.002, `${handle} moved ${k}: ${out[k]} vs ${win[k]}`)
  }
  // Center drag moves by the pointer delta in plane fractions.
  const moved = dragWindow('center', { win, px: 100, py: 100 }, 292, 208, fw, fh)
  assert.deepEqual([moved.x, moved.y], [0.6, 0.6])
  // Rotation: clockwise on screen (y down) is positive, as the shader turns it.
  const rot = dragWindow('rotate', { win, px: 0, py: 0 }, 960 + 300, 540, fw, fh)
  assert.equal(rot.rotation, 90)
  const rotated = { ...win, rotation: 90 }
  const [lx, ly] = toWindowLocal(rotated, 960, 540 + 100, fw, fh)
  assert.ok(Math.abs(lx - 100) < 1e-9 && Math.abs(ly) < 1e-9)
  // Linear softness is the band half-width over half the window height.
  const lin = defaultWindow('linear')
  const soft = dragWindow('soft', { win: lin, px: 0, py: 0 }, 960, 540 + 0.25 * 270, fw, fh)
  assert.equal(soft.softness, 0.25)
})

test('graphOf falls back to the default graph', () => {
  assert.deepEqual(graphOf({}), defaultNodes())
})

test('correctors added by plain ops (the assistant path) never stack on each other or the output', () => {
  const p = applyOps(project(), [
    { op: 'node_add', id: 'c1', node: { type: 'corrector', grade: { exposure: 0.2 } } },
    { op: 'node_add', id: 'c1', node: { type: 'corrector', grade: { saturation: 1.2 } } },
    { op: 'node_add', id: 'c1', node: { type: 'corrector' }, after: 'n2' },
  ]).project
  const g = findClip(p, 'c1').clip.nodes
  const cells = g.list.map(n => `${n.x},${n.y}`)
  assert.equal(new Set(cells).size, cells.length, `distinct positions: ${cells.join(' ')}`)
  for (const [id, pos] of layoutGraph(g)) assert.deepEqual({ x: g.list.find(n => n.id === id).x, y: g.list.find(n => n.id === id).y }, pos)
  // An explicit position is kept as given.
  const placed = applyOps(project(), [{ op: 'node_add', id: 'c1', node: { type: 'corrector', x: 999, y: 7 } }]).project
  const corrector = findClip(placed, 'c1').clip.nodes.list.find(n => n.type === 'corrector')
  assert.deepEqual([corrector.x, corrector.y], [999, 7])
})
