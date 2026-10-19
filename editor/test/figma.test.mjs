// node --test editor/test
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { figmaAssets, figmaToOps, mcpToNodes, nextCompId, parseFigmaUrl, placeCompOps, smartAnimateOps } from '../core/figma.js'
import { applyOps, findClip, newProject, valueAt } from '../core/project.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures', 'figma')
const load = name => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'))
const frameA = load('lower-third-a.nodes.json').nodes['12:3'].document
const frameB = load('lower-third-b.nodes.json').nodes['12:40'].document
const near = (a, b, eps = 0.01, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b}, got ${a}`)

// What the server hands the mapper for each render: the saved PNG and its probed size at @2x.
function rendersFor(nodes) {
  const images = {}
  const index = new Map()
  const walk = n => {
    index.set(n.id, n)
    for (const c of n.children ?? []) walk(c)
  }
  for (const n of [].concat(nodes)) walk(n)
  for (const id of figmaAssets(nodes, { flatten: Array.isArray(nodes) }).renders) {
    const b = index.get(id).absoluteRenderBounds ?? index.get(id).absoluteBoundingBox
    images[id] = { src: `media/figma/KEY/${id.replace(/\W/g, '-')}.png`, width: Math.round(b.width * 2), height: Math.round(b.height * 2), scale: 2 }
  }

  return images
}

function project() {
  const p = newProject('t')
  p.comps = {}

  return p
}

function compClips(p, compId) {
  const comp = p.comps[compId]

  return comp.tracks.filter(t => t.kind === 'video').flatMap(t => t.clips.map(c => ({ track: t, clip: c })))
}

const byLabel = (p, compId, label) => compClips(p, compId).find(x => x.clip.label === label)?.clip

test('parseFigmaUrl reads design, file, proto and branch links', () => {
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/AbC123xyz/Lower-thirds?node-id=12-3&t=abc-1'), { fileKey: 'AbC123xyz', nodeId: '12:3' })
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/file/AbC123xyz/Lower-thirds?type=design&node-id=12%3A3&mode=design'), { fileKey: 'AbC123xyz', nodeId: '12:3' })
  assert.deepEqual(parseFigmaUrl('figma.com/proto/AbC123xyz/Deck?node-id=I5-6;7-8'), { fileKey: 'AbC123xyz', nodeId: 'I5:6;7:8' })
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/AbC123xyz/branch/BrAnCh9/Lower-thirds?node-id=0-1'), { fileKey: 'BrAnCh9', nodeId: '0:1' })
  assert.deepEqual(parseFigmaUrl('https://figma.com/design/AbC123xyz'), { fileKey: 'AbC123xyz', nodeId: null })
  assert.equal(parseFigmaUrl('https://example.com/design/AbC123xyz'), null)
  assert.equal(parseFigmaUrl('not a link'), null)
})

test('figmaAssets asks for renders of vectors and image-filled shapes, nothing hidden', () => {
  const { renders, fills } = figmaAssets(frameA)
  assert.deepEqual(renders.sort(), ['12:10', '12:7'])
  assert.deepEqual(fills, [])
})

test('a lower-third frame maps to a composition: shapes, titles, images, a nested clipping frame', () => {
  const p0 = project()
  const images = rendersFor(frameA)
  const r = figmaToOps(frameA, { images, project: p0, fps: 30, duration: 8 })
  assert.equal(r.comp, 'k1')
  assert.deepEqual(r.comps, ['k1', 'k2'])
  const { project: p, created } = applyOps(p0, r.ops)
  assert.ok(created.includes('k1') && created.includes('k2'))
  const k1 = p.comps.k1
  assert.equal(k1.name, 'Lower Third / A')
  assert.deepEqual([k1.width, k1.height, k1.fps, k1.duration, k1.background], [1920, 1080, 30, 8, 'transparent'])
  // One layer per track, bottom to top in Figma order, tracks named after layers; Guides is hidden.
  const video = k1.tracks.filter(t => t.kind === 'video')
  assert.deepEqual(video.map(t => t.name), ['Glow', 'Card', 'Avatar Ring', 'Avatar', 'Name', 'Role', 'Icon / Play', 'Badge BG', 'Badge Label', 'Ticker', 'Accent Bar'])
  assert.ok(video.every(t => t.clips.length === 1 && t.clips[0].start === 0 && t.clips[0].dur === 8))

  // Card: rounded rectangle, linear gradient, 2px inside stroke drawn centered on a 2px smaller shape.
  const card = byLabel(p, 'k1', 'Card')
  assert.equal(card.kind, 'shape')
  assert.deepEqual([card.x, card.y], [536, 910])
  assert.deepEqual(card.shape, {
    type: 'rect', width: 878, height: 178, radius: 23,
    fill: { gradient: { type: 'linear', stops: [[0, '#1e2a78'], [1, '#6c5ce7eb']], angle: 0, from: [-440, 0], to: [440, 0] } },
    stroke: { color: '#ffffff2e', width: 2, join: 'miter' },
  })
  // Glow: radial gradient ellipse with a layer blur and node opacity.
  const glow = byLabel(p, 'k1', 'Glow')
  assert.equal(glow.shape.type, 'ellipse')
  assert.equal(glow.shape.fill.gradient.type, 'radial')
  assert.deepEqual(glow.shape.fill.gradient.center, [0, 0])
  assert.deepEqual(glow.shape.fill.gradient.radius, [380, 110])
  assert.deepEqual(glow.shape.fill.gradient.stops, [[0, '#6c5ce78c'], [1, '#6c5ce700']])
  assert.equal(glow.opacity, 0.8)
  assert.deepEqual(glow.effects, [{ type: 'blur', enabled: true, params: { radius: 40 } }])
  // Avatar ring: stroke only.
  const ring = byLabel(p, 'k1', 'Avatar Ring')
  assert.deepEqual([ring.shape.type, ring.shape.width, ring.shape.height], ['ellipse', 132, 132])
  assert.deepEqual(ring.shape.fill, { color: '#00000000' })
  assert.deepEqual(ring.shape.stroke, { color: '#f5b942', width: 4 })
  assert.deepEqual([ring.x, ring.y], [186, 910])

  // Avatar (image fill) renders as a PNG; @2x 224px shown at 112px after Reel's contain fit.
  const avatar = byLabel(p, 'k1', 'Avatar')
  assert.equal(avatar.kind, 'image')
  assert.equal(avatar.src, images['12:7'].src)
  assert.equal(avatar.dur, 8, 'image clips keep the composition length, not the 5 s still default')
  const fit = Math.min(1920 / 224, 1080 / 224)
  near(224 * fit * avatar.scale, 112, 0.01, 'avatar width')
  assert.deepEqual([avatar.x, avatar.y], [186, 910])
  // The vector icon renders with its stroke: render bounds 42px, centered on the 40px box.
  const icon = byLabel(p, 'k1', 'Icon / Play')
  near(84 * Math.min(1920 / 84, 1080 / 84) * icon.scale, 42, 0.01, 'icon width')
  assert.deepEqual([icon.x, icon.y], [920, 910])

  // Name: hug text, centered on its box, drop shadow, sizes in 1080p title units (1:1 at 1080 high).
  const name = byLabel(p, 'k1', 'Name')
  assert.equal(name.kind, 'title')
  assert.deepEqual([name.x, name.y], [486, 882])
  assert.deepEqual(name.title, {
    text: 'Ada Lovelace', font: 'Inter', weight: 700, size: 56, color: '#ffffff', align: 'left', lineHeight: 1.21, tracking: -0.56, italic: false,
    shadow: { color: '#00000059', blur: 12, x: 0, y: 4 }, anim: 'none',
    box: { width: 420, height: 68, wrap: false, alignY: 'top' },
  })
  // Role: the renderer wraps the original text within its declared box using font metrics.
  const role = byLabel(p, 'k1', 'Role')
  assert.equal(role.title.text, 'Head of Motion Design at Reel Studios')
  assert.deepEqual(role.title.box, { width: 360, height: 72, wrap: true, alignY: 'top' })
  assert.equal(role.title.color, '#c9d2e3e6')
  assert.equal(role.title.lineHeight, 1.286)
  assert.deepEqual([role.x, role.y], [456, 956])

  // Badge: a flattened group; its rotated, mixed-radius rectangle becomes a path, its label a title.
  const bg = byLabel(p, 'k1', 'Badge BG')
  assert.equal(bg.rotation, -8, 'Figma rotates counter-clockwise; Reel rotation is clockwise')
  assert.equal(bg.shape.type, 'path')
  assert.equal(bg.shape.path.vertices.length, 7, 'three rounded corners (2 vertices) and one sharp corner')
  assert.deepEqual(bg.shape.path.vertices[0], [-70, -10])
  assert.deepEqual(bg.shape.path.out[0], [0, -6.63])
  const bgBox = frameA.children.find(c => c.name === 'Badge').children[0].absoluteBoundingBox
  near(bg.x, bgBox.x - 2400 + bgBox.width / 2, 0.01, 'badge x')
  near(bg.y, bgBox.y + 1200 + bgBox.height / 2, 0.01, 'badge y')
  const label = byLabel(p, 'k1', 'Badge Label')
  assert.equal(label.title.text, 'LIVE')
  assert.equal(label.title.align, 'center')
  assert.equal(label.rotation, -8)
  near(label.x, bg.x, 0.05, 'label centered on badge x')
  near(label.y, bg.y, 0.05, 'label centered on badge y')

  // Accent bar: rotated 90° counter-clockwise in Figma → -90 in Reel, at the box center.
  const bar = byLabel(p, 'k1', 'Accent Bar')
  assert.deepEqual([bar.x, bar.y, bar.rotation], [93, 940, -90])
  assert.deepEqual([bar.shape.width, bar.shape.height], [120, 6])

  // Ticker: a clipping frame becomes a nested composition placed at 1:1 with a rounded mask.
  const ticker = byLabel(p, 'k1', 'Ticker')
  assert.equal(ticker.kind, 'comp')
  assert.equal(ticker.comp, 'k2')
  assert.deepEqual([ticker.x, ticker.y], [536, 1032])
  near(880 * Math.min(1920 / 880, 1080 / 44) * ticker.scale, 880, 0.01, 'ticker width')
  assert.equal(ticker.masks[0].type, 'path')
  assert.equal(ticker.masks[0].id, 'mk1')
  const k2 = p.comps.k2
  assert.deepEqual([k2.width, k2.height], [880, 44])
  assert.deepEqual(k2.tracks.filter(t => t.kind === 'video' && t.clips.length).map(t => t.name), ['Ticker fill', 'Ticker Text'])
  const tickerFill = byLabel(p, 'k2', 'Ticker fill')
  assert.deepEqual(tickerFill.shape.fill, { color: '#0b1020d9' })
  assert.deepEqual([tickerFill.x, tickerFill.y, tickerFill.shape.radius], [440, 22, 12])
  const tickerText = byLabel(p, 'k2', 'Ticker Text')
  assert.deepEqual([tickerText.x, tickerText.y], [474, 22])
  near(tickerText.title.size * (44 / 1080), 20, 1e-3, 'title size scales with the composition height')
  assert.equal(r.warnings.length, 0, r.warnings.join('\n'))
})

test('compositions number after existing ones and place on a free track', () => {
  let p = project()
  p = applyOps(p, [{ op: 'add_comp', name: 'One' }, { op: 'add_comp', name: 'Two' }]).project
  assert.equal(nextCompId(p), 'k3')
  const r = figmaToOps(frameA, { images: rendersFor(frameA), project: p })
  assert.deepEqual(r.comps, ['k3', 'k4'])
  p = applyOps(p, r.ops).project
  assert.equal(p.comps.k3.name, 'Lower Third / A')
  assert.equal(p.comps.k3.tracks.find(t => t.name === 'Ticker').clips[0].comp, 'k4')

  // Place: the top video track (V3) is free at 0, so it goes there at 1:1.
  let ops = placeCompOps(p, { id: 'k3', ...p.comps.k3 }, { start: 0 })
  assert.deepEqual(ops, [{ op: 'comp_clip', target: 'k3', track: 'V3', start: 0, dur: 5, set: {} }])
  p = applyOps(p, ops).project
  // Every track busy at 1s: a new track is added on top.
  p = applyOps(p, [{ op: 'add_color', track: 'V1', start: 0, dur: 10 }, { op: 'add_color', track: 'V2', start: 0, dur: 10 }]).project
  ops = placeCompOps(p, { id: 'k4', ...p.comps.k4 }, { start: 1 })
  assert.equal(ops[0].op, 'add_track')
  assert.equal(ops[1].track, 'V4')
  near(ops[1].set.scale, 880 / 1920, 1e-4, '1:1 scale for a smaller composition')
  p = applyOps(p, ops).project
  const placed = p.tracks.find(t => t.id === 'V4').clips[0]
  assert.equal(placed.kind, 'comp')
  assert.equal(placed.comp, 'k4')
})

test('Smart Animate keyframes matched layers, cross-fades color changes, fades the rest', () => {
  const images = rendersFor([frameA, frameB])
  const r = smartAnimateOps(frameA, frameB, { images, project: project(), fps: 30 })
  const { project: p } = applyOps(project(), r.ops)
  const comp = p.comps[r.comp]
  assert.equal(comp.duration, 2.8)
  const clip = label => byLabel(p, r.comp, label)
  const at = (c, prop, t) => valueAt({ ...p, width: comp.width, height: comp.height }, c, prop, t)

  // Card: one layer whose size, radius and position keyframe (no color change).
  const card = clip('Card')
  assert.deepEqual(card.anim['shape.width'], [[0.5, 878, 'smooth'], [1.3, 1038]])
  assert.deepEqual(card.anim['shape.radius'], [[0.5, 23, 'smooth'], [1.3, 31]])
  assert.deepEqual(card.anim.x, [[0.5, 536, 'smooth'], [1.3, 616]])
  assert.equal(card.anim.y, undefined)
  assert.equal(at(card, 'shape.width', 0), 878)
  assert.equal(at(card, 'shape.width', 2), 1038)
  const mid = at(card, 'shape.width', 0.9)
  assert.ok(mid > 878 && mid < 1038)
  assert.equal(compClips(p, r.comp).filter(x => x.clip.label?.startsWith('Card')).length, 1)

  // Name grows from 56 to 64 px through scale; Role fades to 60%.
  const name = clip('Name')
  near(name.anim.scale[1][1], 64 / 56, 1e-4, 'name scale')
  assert.deepEqual(name.anim.x, [[0.5, 486, 'smooth'], [1.3, 540]])
  const role = clip('Role')
  assert.deepEqual(role.anim.opacity, [[0.5, 1, 'smooth'], [1.3, 0.6]])

  // Badge straightens: rotation -8 → 0.
  assert.deepEqual(clip('Badge BG').anim.rotation, [[0.5, -8, 'smooth'], [1.3, 0]])

  // Accent bar changes color: B's version under A's, A's fades out, both on their own tracks.
  const under = clip('Accent Bar')
  const over = clip('Accent Bar (from)')
  assert.equal(under.shape.fill.color, '#3ddc97')
  assert.equal(over.shape.fill.color, '#f5b942')
  const tracks = comp.tracks.filter(t => t.kind === 'video').map(t => t.name)
  assert.ok(tracks.indexOf('Accent Bar') < tracks.indexOf('Accent Bar (from)'), 'from-layer sits above')
  assert.deepEqual(over.anim.opacity, [[0.5, 1, 'smooth'], [1.3, 0]])
  assert.equal(at(over, 'opacity', 0), 1)
  assert.equal(at(over, 'opacity', 2), 0)

  // Glow only exists in A: fades out from 0.8. Live Dot only in B: fades in.
  assert.deepEqual(clip('Glow').anim.opacity, [[0.5, 0.8, 'smooth'], [1.3, 0]])
  assert.deepEqual(clip('Live Dot').anim.opacity, [[0.5, 0, 'smooth'], [1.3, 1]])
  assert.ok(tracks.indexOf('Glow') < tracks.indexOf('Card'), 'A-only layers keep their stacking place')

  // Avatar renders differ between frames: cross-fade, both scaling from 112 to 128 px.
  const avatarUnder = clip('Avatar')
  const avatarOver = clip('Avatar (from)')
  assert.notEqual(avatarUnder.src, avatarOver.src)
  const shown = (c, t) => {
    const a = images[c.note.slice(6)]

    return a.width * Math.min(1920 / a.width, 1080 / a.height) * at(c, 'scale', t)
  }
  near(shown(avatarOver, 0), 112, 0.01)
  near(shown(avatarOver, 2), 128, 0.01)
  near(shown(avatarUnder, 0), 112, 0.01)
  near(shown(avatarUnder, 2), 128, 0.01)

  // Unchanged layers carry no keyframes.
  assert.equal(clip('Ticker Text').anim, undefined)
})

test('MCP metadata plus per-node screenshots import as image layers in the right places', () => {
  const xml = fs.readFileSync(path.join(FIX, 'lower-third-a.metadata.xml'), 'utf8')
  const assets = {}
  for (const id of ['12:4', '12:5', '12:6', '12:7', '12:9', '12:10', '12:11', '12:14', '12:16']) assets[id] = { src: `media/figma/mcp/${id.replace(':', '-')}.png` }
  const root = mcpToNodes(xml, assets)
  assert.equal(root.type, 'FRAME')
  const r = figmaToOps(root, { images: assets, project: project() })
  const { project: p } = applyOps(project(), r.ops)
  const card = byLabel(p, r.comp, 'Card')
  assert.equal(card.kind, 'image')
  assert.deepEqual([card.x, card.y], [536, 910])
  near(card.scale, 880 / 1920, 1e-4, 'no pixel size known: scaled from the box')
  // The badge group has an asset and its children do not: the whole group is one image.
  const badge = byLabel(p, r.comp, 'Badge')
  near(badge.x, 840 + 144.7668 / 2, 0.01)
  // Name has neither an asset nor text in the metadata: its layer name becomes editable text, and the warning says so.
  const name = byLabel(p, r.comp, 'Name')
  assert.equal(name.kind, 'title')
  assert.equal(name.title.text, 'Name')
  assert.ok(r.warnings.some(w => w.startsWith('"Name": the MCP metadata has no text')))
  assert.deepEqual(r.images, ['Glow', 'Card', 'Avatar Ring', 'Avatar', 'Role', 'Icon / Play', 'Badge', 'Ticker', 'Accent Bar'], 'the report names the layers that came in as pictures')
  // Hidden layers stay out without a warning.
  assert.equal(byLabel(p, r.comp, 'Guides'), undefined)
  assert.ok(!r.warnings.some(w => w.includes('Guides')))
  assert.deepEqual(compClips(p, r.comp).map(x => x.clip.label), ['Glow', 'Card', 'Avatar Ring', 'Avatar', 'Name', 'Role', 'Icon / Play', 'Badge', 'Ticker', 'Accent Bar'])
})

test('MCP metadata alone imports editable grey shapes and named text instead of nothing', () => {
  const xml = fs.readFileSync(path.join(FIX, 'lower-third-a.metadata.xml'), 'utf8')
  const r = figmaToOps(mcpToNodes(xml, {}), { images: {}, project: project() })
  const { project: p } = applyOps(project(), r.ops)
  const labels = compClips(p, r.comp).map(x => `${x.clip.label}:${x.clip.kind}`)
  assert.ok(labels.includes('Card:shape') && labels.includes('Glow:shape') && labels.includes('Accent Bar:shape'), labels.join(' '))
  assert.ok(labels.includes('Name:title') && labels.includes('Role:title') && labels.includes('Badge Label:title'), labels.join(' '))
  const card = byLabel(p, r.comp, 'Card')
  assert.deepEqual([card.shape.type, card.shape.width, card.shape.height, card.x, card.y], ['rect', 880, 180, 536, 910])
  assert.equal(byLabel(p, r.comp, 'Glow').shape.type, 'ellipse')
  assert.ok(r.warnings.some(w => w.startsWith('"Card": the MCP metadata has no fill')))
  assert.ok(r.warnings.some(w => w.startsWith('"Icon / Play": no asset and no text')), 'vectors still need an asset')
  assert.deepEqual(r.images, [])
  assert.equal(byLabel(p, r.comp, 'Guides'), undefined, 'hidden layers stay out')
})

test('MCP text with characters becomes a title; coords modes', () => {
  const xml = `<?xml version="1.0"?><!-- metadata -->
<frame id="1:1" name="Card &amp; Title" x="100" y="50" width="400" height="200">
  <group id="1:2" name="Row" x="20" y="30" width="200" height="40">
    <text id="1:3" name="Heading" x="20" y="30" width="200" height="40">Hello &lt;world&gt;</text>
  </group>
</frame>`
  const root = mcpToNodes(xml, {})
  assert.equal(root.name, 'Card & Title')
  const text = root.children[0].children[0]
  assert.equal(text.characters, 'Hello <world>')
  assert.deepEqual(text.absoluteBoundingBox, { x: 120, y: 80, width: 200, height: 40 })
  const parentMode = mcpToNodes(xml, {}, { coords: 'parent' }).children[0].children[0]
  assert.deepEqual(parentMode.absoluteBoundingBox, { x: 140, y: 110, width: 200, height: 40 })
  const r = figmaToOps(root, { project: project() })
  const { project: p } = applyOps(project(), r.ops)
  const t = byLabel(p, r.comp, 'Heading')
  assert.equal(t.title.text, 'Hello <world>')
  assert.deepEqual([t.x, t.y], [120, 50])
  near(t.title.size * 200 / 1080, 40 / 1.2, 0.01, 'size estimated from the box height')
  assert.ok(r.warnings.some(w => w.includes('estimates')))
})

// Hand-built nodes for the cases the fixture does not cover.
const box = (x, y, w, h) => ({ absoluteBoundingBox: { x, y, width: w, height: h }, size: { x: w, y: h }, relativeTransform: [[1, 0, x], [0, 1, y]] })
const frame = (props, children) => ({ id: '1:1', name: 'Frame', type: 'FRAME', clipsContent: true, fills: [], strokes: [], ...box(0, 0, 400, 200), ...props, children })
const solid = (r, g, b, opacity) => ({ type: 'SOLID', color: { r, g, b, a: 1 }, ...(opacity !== undefined ? { opacity } : {}) })

function mapOne(node, options = {}) {
  const r = figmaToOps(node, { project: project(), ...options })
  const { project: p } = applyOps(project(), r.ops)

  return { r, p, comp: p.comps[r.comp] }
}

test('root fills: opaque solid becomes the background; rounded or translucent becomes a layer', () => {
  let { comp } = mapOne(frame({ fills: [solid(1, 0, 0)] }, []))
  assert.equal(comp.background, '#ff0000')
  ;({ comp } = mapOne(frame({ fills: [solid(1, 0, 0)], cornerRadius: 16 }, [])))
  assert.equal(comp.background, 'transparent')
  assert.equal(comp.tracks[0].clips[0].shape.radius, 16)
  ;({ comp } = mapOne(frame({ fills: [solid(0, 0, 1, 0.5)] }, [])))
  assert.equal(comp.tracks[0].clips[0].shape.fill.color, '#0000ff80')
})

test('strokes, radii, gradients, rotation, flips and blend modes', () => {
  const rot = (deg, x, y, w, h) => {
    const a = (deg * Math.PI) / 180

    return { relativeTransform: [[Math.cos(a), Math.sin(a), x], [-Math.sin(a), Math.cos(a), y]], size: { x: w, y: h } }
  }
  const kids = [
    { id: '2:1', name: 'Outside', type: 'RECTANGLE', ...box(10, 10, 100, 50), cornerRadius: 10, fills: [solid(1, 1, 1)], strokes: [solid(0, 0, 0)], strokeWeight: 4, strokeAlign: 'OUTSIDE', strokeDashes: [6, 3], strokeCap: 'ROUND' },
    { id: '2:2', name: 'Diagonal', type: 'RECTANGLE', ...box(150, 0, 200, 100), fills: [{ type: 'GRADIENT_LINEAR', gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } }] }], strokes: [], blendMode: 'MULTIPLY' },
    { id: '2:3', name: 'Turned', type: 'ELLIPSE', ...rot(30, 100, 150, 60, 20), fills: [solid(0, 1, 0)], strokes: [], blendMode: 'HUE' },
    { id: '2:4', name: 'Mirrored', type: 'RECTANGLE', relativeTransform: [[-1, 0, 300], [0, 1, 120]], size: { x: 40, y: 40 }, fills: [solid(0, 0, 0)], strokes: [] },
  ]
  const { p, r, comp } = mapOne(frame({}, kids))
  const clip = label => comp.tracks.flatMap(t => t.clips).find(c => c.label === label)
  const outside = clip('Outside')
  assert.deepEqual(outside.shape, { type: 'rect', width: 104, height: 54, radius: 12, fill: { color: '#ffffff' }, stroke: { color: '#000000', width: 4, cap: 'round', dash: [6, 3] } })
  const diag = clip('Diagonal')
  near(diag.shape.fill.gradient.angle, 26.57, 0.01, 'angle follows the handles in pixels, not normalized space')
  assert.deepEqual(diag.shape.fill.gradient.from, [-100, -50])
  assert.equal(diag.blend, 'multiply')
  const turned = clip('Turned')
  assert.equal(turned.rotation, -30)
  assert.equal(turned.blend, undefined)
  assert.ok(r.warnings.some(w => w.includes('HUE')))
  // Rotated about its top-left: the center moves with the rotation.
  const a = (30 * Math.PI) / 180
  near(turned.x, 100 + Math.cos(a) * 30 + Math.sin(a) * 10, 1e-3)
  near(turned.y, 150 - Math.sin(a) * 30 + Math.cos(a) * 10, 1e-3)
  const mirrored = clip('Mirrored')
  assert.equal(mirrored.scaleX, -1)
  assert.equal(mirrored.rotation ?? 0, 0)
  assert.deepEqual([mirrored.x, mirrored.y], [280, 140])
  assert.ok(p)
})

test('masks, mixed text styles and image-filled frames', () => {
  const masked = {
    id: '3:1', name: 'Masked', type: 'GROUP', ...box(0, 0, 100, 100), children: [
      { id: '3:2', name: 'Mask', type: 'ELLIPSE', isMask: true, ...box(0, 0, 100, 100), fills: [solid(1, 1, 1)] },
      { id: '3:3', name: 'Photo', type: 'RECTANGLE', ...box(0, 0, 100, 100), fills: [solid(1, 0, 0)] },
    ],
  }
  const mixed = {
    id: '3:4', name: 'Mixed', type: 'TEXT', ...box(120, 0, 200, 40), characters: 'Ada Lovelace', style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 32, lineHeightPx: 40, textAutoResize: 'WIDTH_AND_HEIGHT' },
    characterStyleOverrides: [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1], styleOverrideTable: { 1: { fontWeight: 700 } }, fills: [solid(1, 1, 1)],
  }
  const hero = {
    id: '3:5', name: 'Hero', type: 'FRAME', clipsContent: false, ...box(0, 100, 400, 100),
    fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageRef: 'abc123' }, solid(0, 0, 0, 0.4)], strokes: [],
    children: [{ id: '3:6', name: 'Caption', type: 'TEXT', ...box(20, 120, 100, 30), characters: 'Hi', style: { fontFamily: 'Inter', fontWeight: 600, fontSize: 24, lineHeightPx: 30, textAutoResize: 'WIDTH_AND_HEIGHT' }, fills: [solid(1, 1, 1)] }],
  }
  const root = frame({}, [masked, mixed, hero])
  const assets = figmaAssets(root)
  assert.deepEqual(assets.renders.sort(), ['3:1', '3:4'])
  assert.deepEqual(assets.fills, ['abc123'])
  const images = {
    '3:1': { src: 'm/masked.png', width: 200, height: 200, scale: 2 },
    '3:4': { src: 'm/mixed.png', width: 400, height: 80, scale: 2 },
    abc123: { src: 'm/photo.jpg', width: 1600, height: 900 },
  }
  const { comp } = mapOne(root, { images })
  const clips = comp.tracks.filter(t => t.kind === 'video').map(t => t.clips[0]).filter(Boolean)
  assert.deepEqual(clips.map(c => c.label), ['Masked', 'Mixed', 'Hero image', 'Hero fill 2', 'Caption'])
  const photo = clips[2]
  // FILL: cover 400x100 with a 16:9 image, crop top and bottom evenly.
  const fit = Math.min(400 / 1600, 200 / 900)
  near(1600 * fit * photo.scale, 400, 1e-3, 'photo covers the frame width')
  // Shown 400 x 225; 62.5 px trimmed top and bottom = 0.2778 of the height each side.
  near(photo.crop.t, 62.5 / 225, 1e-4)
  near(photo.crop.b, 62.5 / 225, 1e-4)
  near(photo.crop.l, 0, 1e-9)
  assert.deepEqual([photo.x, photo.y], [200, 150])
  assert.equal(clips[3].shape.fill.color, '#00000066')
  assert.equal(clips[4].kind, 'title')
})

test('fixed text boxes preserve their alignment and source text for measured wrapping', () => {
  const text = (id, chars, w, h) => ({ id, name: id, type: 'TEXT', ...box(0, 0, w, h), characters: chars, style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 20, lineHeightPx: 24, textAutoResize: 'NONE', textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP' }, fills: [solid(1, 1, 1)] })
  const { comp } = mapOne(frame({}, [text('tall', 'Hello world', 400, 120), text('narrow', 'one two three four five six', 120, 120)]))
  const clip = id => comp.tracks.flatMap(t => t.clips).find(c => c.label === id)
  assert.equal(clip('tall').title.text, 'Hello world')
  assert.equal(clip('tall').y, 60)
  assert.equal(clip('tall').title.box.alignY, 'top')
  assert.equal(clip('narrow').title.text, 'one two three four five six')
  assert.equal(clip('narrow').title.box.wrap, true)
})

test('itemReverseZIndex draws the first child on top; non-clipping frames flatten', () => {
  const a = { id: '4:2', name: 'A', type: 'RECTANGLE', ...box(0, 0, 10, 10), fills: [solid(1, 0, 0)] }
  const b = { id: '4:3', name: 'B', type: 'RECTANGLE', ...box(20, 0, 10, 10), fills: [solid(0, 1, 0)] }
  const row = { id: '4:1', name: 'Row', type: 'FRAME', clipsContent: false, itemReverseZIndex: true, layoutMode: 'HORIZONTAL', ...box(50, 50, 100, 40), fills: [], strokes: [solid(1, 1, 1)], strokeWeight: 1, strokeAlign: 'INSIDE', children: [a, b] }
  const { comp } = mapOne(frame({}, [row]))
  assert.deepEqual(comp.tracks.filter(t => t.kind === 'video' && t.clips.length).map(t => t.name), ['B', 'A', 'Row stroke'])
})

test('core/figma.js stays free of Node, DOM and web-only APIs (it runs in JavaScriptCore)', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'core', 'figma.js'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const word of ['structuredClone', 'new URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Buffer', 'DOMParser', 'atob', 'btoa', 'fetch(', 'require(', 'process.', 'window.', 'document.']) {
    assert.ok(!src.includes(word), `figma.js uses ${word}`)
  }
  assert.ok(!/^import /m.test(src), 'figma.js imports nothing')
})
