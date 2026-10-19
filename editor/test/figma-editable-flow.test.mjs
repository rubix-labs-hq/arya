import assert from 'node:assert/strict'
import test from 'node:test'
import { mcpToNodes } from '../core/figma.js'
import { nativeFigmaImport } from '../core/figma-native.js'
import { applyOps, newProject, valueAt } from '../core/project.js'
import { selectionMotionContext } from '../core/selection-ai.js'

const white = { type: 'SOLID', color: { r: 1, g: 1, b: 1 } }
const image = src => ({ src, width: 640, height: 360, scale: 2 })
const measured = { width: 640, height: 360, hasVideo: true, hasAudio: false, still: true }
const title = (id = '1:2', x = 20, size = 24) => ({
  id, name: 'Editable heading', type: 'TEXT', characters: 'Keep my font',
  absoluteBoundingBox: { x, y: 30, width: 220, height: 48 },
  fills: [white], style: { fontFamily: 'Inter', fontWeight: 700, fontSize: size, textAlignHorizontal: 'LEFT' },
})
const card = (id = '1:3') => ({
  id, name: 'Editable card', type: 'RECTANGLE',
  absoluteBoundingBox: { x: 10, y: 20, width: 260, height: 100 },
  fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.6 } }], cornerRadius: 12,
})
const frame = (children, id = '1:1') => ({
  id, name: 'Editable lower third', type: 'FRAME', clipsContent: true,
  absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 180 }, fills: [], children,
})
const clips = comp => comp.tracks.flatMap(track => track.clips)

test('MCP full source text retains editable text and font despite a supplied screenshot', () => {
  const original = title()
  const before = structuredClone(original)
  const p = newProject('Editable MCP')
  const result = nativeFigmaImport(p, frame([original]), {
    mcp: true, duration: 4,
    images: { '1:2': image('media/figma/text.png') },
    assets: { 'media/figma/text.png': measured },
  })
  const next = applyOps(p, result.ops).project
  const imported = clips(next.comps[result.comp]).find(c => c.note === 'figma 1:2')
  assert.equal(imported.kind, 'title')
  assert.equal(imported.title.text, 'Keep my font')
  assert.equal(imported.title.font, 'Inter')
  assert.equal(imported.title.weight, 700)
  assert.deepEqual(next.assets['media/figma/text.png'], measured)
  assert.deepEqual(original, before)
  assert.deepEqual(p.assets, {})
})

test('a root screenshot does not discard fully described editable descendants', () => {
  const p = newProject('Editable subtree')
  const result = nativeFigmaImport(p, frame([card(), title()]), {
    mcp: true, images: { '1:1': image('media/figma/frame.png') },
    assets: { 'media/figma/frame.png': measured },
  })
  const next = applyOps(p, result.ops).project
  const layers = clips(next.comps[result.comp])
  assert.equal(layers.find(c => c.note === 'figma 1:2')?.kind, 'title')
  assert.equal(layers.find(c => c.note === 'figma 1:3')?.kind, 'shape')
  assert.equal(layers.find(c => c.note === 'figma 1:3').shape.radius, 12)
  assert.ok(next.assets['media/figma/frame.png'])
})

test('Smart Animate and native property edits keep text editable with screenshot assets', () => {
  const p = newProject('Editable animation')
  const result = nativeFigmaImport(p, frame([title()]), {
    mcp: true, mode: 'smartAnimate', toNodes: frame([title('2:2', 60, 32)], '2:1'),
    transition: 1, delay: 0, hold: 1,
    images: { '1:2': image('media/figma/from.png'), '2:2': image('media/figma/to.png') },
    assets: { 'media/figma/from.png': measured, 'media/figma/to.png': measured },
  })
  let next = applyOps(p, result.ops).project
  const imported = clips(next.comps[result.comp]).find(c => c.kind === 'title')
  assert.ok(imported, 'the animated source must remain a native title')
  assert.ok(imported.anim?.x?.length)
  assert.ok(imported.anim?.scale?.length)
  next = applyOps(next, [
    { op: 'keyframe', comp: result.comp, id: imported.id, prop: 'opacity', at: 0, local: true, value: 0 },
    { op: 'keyframe', comp: result.comp, id: imported.id, prop: 'opacity', at: 0.5, local: true, value: 1 },
    { op: 'keyframe', comp: result.comp, id: imported.id, prop: 'title.size', at: 0, local: true, value: 144 },
    { op: 'keyframe', comp: result.comp, id: imported.id, prop: 'title.size', at: 1, local: true, value: 192 },
    { op: 'update', comp: result.comp, id: imported.id, set: { title: { text: 'Edited after import' } } },
  ]).project
  const edited = clips(next.comps[result.comp]).find(c => c.id === imported.id)
  assert.equal(edited.title.text, 'Edited after import')
  assert.equal(valueAt(next, edited, 'opacity', 0), 0)
  assert.equal(valueAt(next, edited, 'opacity', 0.5), 1)
  assert.equal(valueAt(next, edited, 'title.size', 0), 144)
  assert.equal(valueAt(next, edited, 'title.size', 1), 192)
  assert.deepEqual(Object.keys(next.assets).sort(), ['media/figma/from.png', 'media/figma/to.png'])
  assert.deepEqual(JSON.parse(JSON.stringify(next)), next)
})

test('metadata XML screenshots keep their existing fallback behavior', () => {
  const root = mcpToNodes('<frame id="1:1" name="Metadata" x="0" y="0" width="320" height="180"><text id="1:2" name="Unknown font" x="20" y="30" width="220" height="48" text="Metadata text" /></frame>', { '1:2': image('media/figma/metadata.png') })
  assert.equal(root.children[0]._image, true)
  assert.equal(root.children[0]._asset.src, 'media/figma/metadata.png')
})

for (const [name, mutate] of [
  ['missing font metadata', node => { delete node.style.fontFamily }],
  ['missing font size', node => { delete node.style.fontSize }],
  ['mixed text styles', node => { node.characterStyleOverrides = [1]; node.styleOverrideTable = { 1: { fontFamily: 'Other font' } } }],
  ['missing solid color', node => { node.fills = [{ type: 'SOLID' }] }],
  ['incomplete gradient', node => { node.fills = [{ type: 'GRADIENT_LINEAR' }] }],
  ['multiple text strokes', node => { node.strokes = [white, white]; node.strokeWeight = 2 }],
  ['text decoration', node => { node.style.textDecoration = 'UNDERLINE' }],
  ['small caps', node => { node.style.textCase = 'SMALL_CAPS' }],
  ['justified text', node => { node.style.textAlignHorizontal = 'JUSTIFIED' }],
]) {
  test(`incomplete or unsupported text retains its screenshot for ${name}`, () => {
    const node = title(); mutate(node)
    const mapped = mcpToNodes(frame([node]), { '1:2': image('media/fallback.png') })
    assert.equal(mapped.children[0]._image, true)
  })
}

const vector = { id: '1:4', name: 'Unsupported vector', type: 'VECTOR', absoluteBoundingBox: { x: 5, y: 5, width: 20, height: 20 }, fills: [white] }
for (const [name, mutate] of [
  ['missing child render', root => { root.children.push(structuredClone(vector)) }],
  ['container shadow', root => { root.effects = [{ type: 'DROP_SHADOW', visible: true, radius: 8 }] }],
  ['container blend', root => { root.blendMode = 'MULTIPLY' }],
  ['missing image fill', root => { root.fills = [{ type: 'IMAGE', imageRef: 'missing-fill' }] }],
  ['multiple container strokes', root => { root.strokes = [white, white]; root.strokeWeight = 2 }],
  ['per-side container stroke widths', root => { root.strokes = [white]; root.individualStrokeWeights = { top: 1, bottom: 3, left: 2, right: 4 } }],
  ['incomplete container gradient', root => { root.fills = [{ type: 'GRADIENT_LINEAR' }] }],
  ['zero container dimensions', root => { root.absoluteBoundingBox.width = 0 }],
  ['missing container dimensions', root => { delete root.absoluteBoundingBox.width }],
]) {
  test(`a root screenshot remains the fallback for ${name}`, () => {
    const root = frame([title()]); mutate(root)
    const mapped = mcpToNodes(root, { '1:1': image('media/root-fallback.png') })
    assert.equal(mapped._image, true)
    assert.equal(mapped.children, undefined)
    assert.equal(mapped._asset.src, 'media/root-fallback.png')
  })
}

test('complete nested geometry and measured image dependencies coexist without flattening', () => {
  const nested = frame([card(), title()], '1:5'); nested.name = 'Nested editable card'
  const p = newProject('Mixed native geometry')
  const result = nativeFigmaImport(p, frame([nested, vector]), {
    mcp: true,
    images: { '1:1': image('media/root.png'), '1:4': image('media/vector.png') },
    assets: { 'media/root.png': measured, 'media/vector.png': measured },
  })
  const next = applyOps(p, result.ops).project
  const top = clips(next.comps[result.comp])
  const wrapper = top.find(c => c.note === 'figma 1:5')
  assert.equal(wrapper.kind, 'comp')
  assert.equal(clips(next.comps[wrapper.comp]).find(c => c.note === 'figma 1:2').kind, 'title')
  assert.equal(clips(next.comps[wrapper.comp]).find(c => c.note === 'figma 1:3').kind, 'shape')
  assert.equal(top.find(c => c.note === 'figma 1:4').src, 'media/vector.png')
  assert.deepEqual(next.assets['media/vector.png'], measured)
  assert.deepEqual(next.assets['media/root.png'], measured)
})

test('a child screenshot cannot hide an unsupported sibling from the root fallback', () => {
  const root = frame([title(), vector])
  const mapped = mcpToNodes(root, { '1:1': image('media/root.png'), '1:2': image('media/title.png') })
  assert.equal(mapped._image, true)
  assert.equal(mapped.children, undefined)
  assert.equal(mapped._asset.src, 'media/root.png')
})

test('smoothed rectangle corners retain a supplied screenshot', () => {
  const node = card(); node.cornerSmoothing = 0.6
  assert.equal(mcpToNodes(frame([node]), { '1:3': image('media/smoothing.png') }).children[0]._image, true)
})

test('gradient text retains its screenshot instead of reducing its paint to two colors', () => {
  const node = title(); node.fills = [{ type: 'GRADIENT_LINEAR', gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0 } }, { position: 0.5, color: { r: 0, g: 1, b: 0 } }, { position: 1, color: { r: 0, g: 0, b: 1 } }] }]
  assert.equal(mcpToNodes(frame([node]), { '1:2': image('media/gradient.png') }).children[0]._image, true)
})

function authored() {
  const original = newProject('Library flow')
  const result = nativeFigmaImport(original, frame([title(), card(), vector]), {
    mcp: true, duration: 2,
    images: { '1:2': image('media/title.png'), '1:4': image('media/vector.png') },
    assets: { 'media/title.png': measured, 'media/vector.png': measured },
  })
  let p = applyOps(original, result.ops).project
  const heading = clips(p.comps[result.comp]).find(c => c.kind === 'title')
  assert.ok(heading, 'the source must include editable text')
  const selection = selectionMotionContext(p, [heading.id], result.comp)
  assert.equal(selection.layers[0].kind, 'title')
  assert.equal(selection.layers[0].font, 'Inter')
  assert.equal(selection.layers[0].figma.nodeId, '1:2')
  p = applyOps(p, [
    { op: 'keyframe', comp: result.comp, id: heading.id, prop: 'opacity', at: 0, local: true, value: 0 },
    { op: 'keyframe', comp: result.comp, id: heading.id, prop: 'opacity', at: 0.5, local: true, value: 1 },
    { op: 'keyframe', comp: result.comp, id: heading.id, prop: 'title.size', at: 0, local: true, value: 144 },
    { op: 'keyframe', comp: result.comp, id: heading.id, prop: 'title.size', at: 1, local: true, value: 192 },
  ]).project
  return { original, project: p, composition: result.comp, heading: heading.id }
}

for (const category of ['title', 'composition', 'transition']) {
  test(`imported editable layers save and reuse independently as ${category}`, () => {
    const source = authored()
    const unchangedSource = structuredClone(source.project)
    let p = applyOps(source.project, [{ op: 'library_save', category, name: `Native ${category}`, source: { composition: source.composition } }]).project
    assert.deepEqual(source.project, unchangedSource)
    const item = p.library.items.find(item => item.name === `Native ${category}`)
    assert.ok(item)
    assert.deepEqual(item.body.assets['media/vector.png'], measured)
    const serialized = JSON.stringify(p)
    const reopened = JSON.parse(serialized)
    assert.equal(JSON.stringify(reopened), serialized)
    reopened.comps = {}; reopened.assets = {}
    if (category === 'transition') {
      p = applyOps(reopened, [
        { op: 'add_shape', track: 'V1', start: 0, dur: 4, shape: { type: 'rect', width: 100, height: 50, fill: { color: '#ffffff' } } },
        { op: 'add_shape', track: 'V1', start: 4, dur: 4, shape: { type: 'rect', width: 100, height: 50, fill: { color: '#ffffff' } } },
      ]).project
    } else p = reopened
    const beforeReuse = structuredClone(p)
    const target = category === 'transition' ? clips(p).find(c => c.start === 4).id : undefined
    const result = applyOps(p, [{ op: 'library_apply', item: item.id, ...(target ? { id: target } : { start: 8, track: 'V2' }) }])
    const next = result.project
    assert.deepEqual(p, beforeReuse)
    const wrapper = clips(next).find(c => c.kind === 'comp')
    assert.ok(wrapper)
    assert.notEqual(next.comps[wrapper.comp], item.body.comps[source.composition])
    const copied = clips(next.comps[wrapper.comp]).find(c => c.kind === 'title')
    assert.notEqual(copied, clips(item.body.comps[source.composition]).find(c => c.kind === 'title'))
    assert.equal(copied.title.text, 'Keep my font')
    assert.equal(copied.title.font, 'Inter')
    assert.equal(copied.note, 'figma 1:2')
    assert.equal(valueAt(next, copied, 'title.size', 1), 192)
    assert.equal(valueAt(next, copied, 'opacity', 0.5), 1)
    assert.deepEqual(next.assets['media/vector.png'], measured)
    assert.deepEqual(JSON.parse(JSON.stringify(next)), next)
  })
}

test('reuse beside existing source layers allocates independent composition and clip IDs', () => {
  const source = authored()
  const saved = applyOps(source.project, [{ op: 'library_save', category: 'composition', name: 'Alive source', source: { composition: source.composition } }]).project
  const item = saved.library.items.find(item => item.name === 'Alive source')
  const p = applyOps(saved, [{ op: 'library_apply', item: item.id, start: 8, track: 'V2' }]).project
  const wrapper = clips(p).find(c => c.kind === 'comp')
  const copied = clips(p.comps[wrapper.comp]).find(c => c.kind === 'title')
  assert.notEqual(wrapper.comp, source.composition)
  assert.notEqual(copied.id, source.heading)
  const changed = applyOps(p, [{ op: 'update', comp: wrapper.comp, id: copied.id, set: { title: { text: 'Independent copy' } } }]).project
  assert.equal(clips(changed.comps[source.composition]).find(c => c.id === source.heading).title.text, 'Keep my font')
  assert.equal(clips(changed.comps[wrapper.comp]).find(c => c.id === copied.id).title.text, 'Independent copy')
})

for (const [name, paint] of [
  ['tiled image fill', { type: 'IMAGE', imageRef: 'fill', scaleMode: 'TILE' }],
  ['rotated image fill', { type: 'IMAGE', imageRef: 'fill', rotation: 30 }],
  ['filtered image fill', { type: 'IMAGE', imageRef: 'fill', filters: { exposure: 0.2 } }],
  ['cropped image transform', { type: 'IMAGE', imageRef: 'fill', scaleMode: 'CROP' }],
]) {
  test(`root screenshots retain unsupported ${name}`, () => {
    const root = frame([title()]); root.fills = [paint]
    const mapped = mcpToNodes(root, { '1:1': image('media/root.png'), fill: image('media/fill.png') })
    assert.equal(mapped._image, true)
    assert.equal(mapped.children, undefined)
  })
}

for (const [kind, make] of [['text', title], ['shape', card]]) {
  for (const [paint, mutate] of [
    ['fill', node => { node.fills[0].blendMode = 'MULTIPLY' }],
    ['stroke', node => { node.strokes = [{ ...white, blendMode: 'MULTIPLY' }]; node.strokeWeight = 2 }],
  ]) {
    test(`${kind} with a ${paint} blend keeps its screenshot`, () => {
      const node = structuredClone(make()); mutate(node)
      const mapped = mcpToNodes(frame([node]), { [node.id]: image('media/paint-fallback.png') })
      assert.equal(mapped.children[0]._image, true)
    })
  }
}

for (const mode of ['MULTIPLY', 'HUE']) {
  for (const paint of ['fills', 'strokes']) {
    test(`container ${paint} with ${mode} keep the root screenshot`, () => {
      const node = frame([title()]); node[paint] = [{ ...white, blendMode: mode }]
      if (paint === 'strokes') node.strokeWeight = 2
      const mapped = mcpToNodes(node, { [node.id]: image('media/container-paint-fallback.png') })
      assert.equal(mapped._image, true)
      assert.equal(mapped.children, undefined)
    })
  }
}

const completeShadow = { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.5 }, radius: 8, offset: { x: 2, y: 3 } }
const blur = { type: 'LAYER_BLUR', radius: 4 }
for (const [name, make, effects] of [
  ['missing shadow color', title, [{ type: 'DROP_SHADOW', radius: 8, offset: { x: 2, y: 3 } }]],
  ['invalid shadow color', title, [{ ...completeShadow, color: { r: 0, g: 0, b: NaN } }]],
  ['missing shadow offset', title, [{ ...completeShadow, offset: undefined }]],
  ['shadow spread', title, [{ ...completeShadow, spread: 4 }]],
  ['shadow blend', title, [{ ...completeShadow, blendMode: 'MULTIPLY' }]],
  ['missing blur radius', title, [{ type: 'LAYER_BLUR' }]],
  ['multiple text blurs', title, [blur, { ...blur, radius: 12 }]],
  ['multiple shape blurs', card, [blur, { ...blur, radius: 12 }]],
  ['negative blur radius', card, [{ ...blur, radius: -1 }]],
  ['infinite blur radius', card, [{ ...blur, radius: Infinity }]],
]) {
  test(`incomplete or unsupported ${name} keeps the leaf screenshot`, () => {
    const node = structuredClone(make()); node.effects = effects
    const mapped = mcpToNodes(frame([node]), { [node.id]: image('media/effect-fallback.png') })
    assert.equal(mapped.children[0]._image, true)
  })
}

for (const [name, make, effects] of [
  ['complete text shadow', title, [completeShadow]],
  ['single text blur', title, [blur]],
  ['single shape blur', card, [blur]],
]) {
  test(`${name} stays editable with a supplied screenshot`, () => {
    const node = structuredClone(make()); node.effects = effects
    const mapped = mcpToNodes(frame([node]), { [node.id]: image('media/unused-effect.png') })
    assert.equal(mapped.children[0]._image, undefined)
    const p = newProject(name)
    const plan = nativeFigmaImport(p, frame([node]), { mcp: true, images: { [node.id]: image('media/unused-effect.png') }, assets: { 'media/unused-effect.png': measured } })
    const next = applyOps(p, plan.ops).project
    const imported = clips(next.comps[plan.comp]).find(c => c.note === `figma ${node.id}`)
    assert.equal(imported.kind, node.type === 'TEXT' ? 'title' : 'shape')
    if (effects[0].type === 'DROP_SHADOW') assert.deepEqual(imported.title.shadow, { color: '#00000080', blur: 48, x: 12, y: 18 })
    else assert.deepEqual(imported.effects, [{ type: 'blur', enabled: true, params: { radius: 4 } }])
  })
}

for (const [kind, make] of [['text', title], ['shape', card]]) {
  test(`explicit NORMAL ${kind} paints stay editable`, () => {
    const node = structuredClone(make()); node.fills[0].blendMode = 'NORMAL'; node.strokes = [{ ...white, blendMode: 'NORMAL' }]; node.strokeWeight = 2
    const mapped = mcpToNodes(frame([node]), { [node.id]: image('media/unused-normal.png') })
    assert.equal(mapped.children[0]._image, undefined)
  })
}
