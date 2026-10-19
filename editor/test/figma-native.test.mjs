import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeFigmaAssets, nativeFigmaImport } from '../core/figma-native.js'
import { applyOps, newProject } from '../core/project.js'

const frame = (id = '1:1', x = 0) => ({
  id, type: 'FRAME', name: 'Native frame', absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 180 },
  fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.1, b: 0.5 } }],
  children: [{ id: `${id}:text`, type: 'TEXT', name: 'Heading', characters: 'Editable title', absoluteBoundingBox: { x: 20 + x, y: 30, width: 280, height: 50 }, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }], style: { fontFamily: 'Inter', fontWeight: 800, fontSize: 24, textAlignHorizontal: 'LEFT' } }],
})

test('native Figma import creates editable layers and places the comp in one operation batch', () => {
  const p = newProject('Figma native')
  const result = nativeFigmaImport(p, frame(), { duration: 12, placeOnTimeline: true, start: 2, assets: { 'media/figma/a.png': { width: 10, height: 10, hasVideo: true, still: true } } })
  const restored = applyOps(p, result.ops).project
  assert.ok(restored.assets['media/figma/a.png'])
  assert.equal(restored.comps.k1.tracks.flatMap(t => t.clips).find(c => c.kind === 'title').title.text, 'Editable title')
  assert.equal(restored.tracks.flatMap(t => t.clips).find(c => c.kind === 'comp').dur, 12)
  assert.equal(restored.tracks.flatMap(t => t.clips).find(c => c.kind === 'comp').start, 2)
  assert.equal(p.comps?.k1, undefined)
})

test('native Figma Smart Animate uses the shared animation mapping', () => {
  const result = nativeFigmaImport(newProject('Smart'), frame(), { mode: 'smartAnimate', toNodes: frame('2:1', 10), transition: 1, delay: 0, hold: 1 })
  const restored = applyOps(newProject('Smart'), result.ops).project
  assert.ok(restored.comps[result.comp].tracks.flatMap(t => t.clips).some(c => c.anim?.x?.length))
  assert.deepEqual(nativeFigmaAssets(frame()), { renders: [], fills: [] })
})

test('native Figma MCP text import needs no connected account and rejects invalid timing', () => {
  const xml = '<frame id="1:1" name="Frame" x="0" y="0" width="320" height="180"><text id="2:1" name="Title" x="20" y="20" width="200" height="30" text="Copied title" /></frame>'
  const result = nativeFigmaImport(newProject('MCP'), xml, { mcp: true, duration: 6 })
  assert.ok(applyOps(newProject('MCP'), result.ops).project.comps[result.comp])
  assert.throws(() => nativeFigmaImport(newProject('Bad'), frame(), { duration: Infinity }), /Duration/)
  assert.throws(() => nativeFigmaImport(newProject('Bad'), frame(), { mode: 'smartAnimate' }), /second frame/)
})


const localXML = '<frame id="40:1" name="Local media" x="0" y="0" width="320" height="180"><image id="40:2" name="Local image" x="20" y="20" width="80" height="60" /></frame>'
const localSrc = 'media/original-image.png'
const probe = { width: 80, height: 60, size: 240, codec: 'png', hasVideo: true, hasAudio: false, still: true }
const localOptions = assets => ({ mcp: true, duration: 6, placeOnTimeline: true, start: 2, images: { '40:2': { src: localSrc, width: 80, height: 60 } }, ...(assets === undefined ? {} : { assets }) })
const withAsset = asset => applyOps(newProject('Existing image'), [{ op: 'import', assets: { [localSrc]: asset } }]).project
const expectUnchangedRefusal = (project, options, pattern) => {
  const before = structuredClone(project)
  assert.throws(() => nativeFigmaImport(project, localXML, options), pattern)
  assert.deepEqual(project, before)
}

test('native Figma refreshes ordinary unclaimed image metadata and retains its source path and node note', () => {
  const project = withAsset({ ...probe, width: 79, size: 200 }), before = structuredClone(project)
  const result = nativeFigmaImport(project, localXML, localOptions({ [localSrc]: probe }))
  const applied = applyOps(project, result.ops).project
  assert.deepEqual(applied.assets[localSrc], probe)
  const image = applied.comps[result.comp].tracks.flatMap(t => t.clips).find(c => c.src === localSrc)
  assert.ok(image); assert.equal(image.note, 'figma 40:2')
  assert.equal(applied.tracks.flatMap(t => t.clips).find(c => c.comp === result.comp).start, 2)
  assert.deepEqual(project, before)
})

test('an unsupported persisted image generated field is refused instead of silently removed or reclassified', () => {
  // This is an opaque imported record, not a claim that Arya has an image generator.
  const project = withAsset({ ...probe, generated: { kind: 'legacy-image', provider: 'opaque-source', contentSHA256: 'a'.repeat(64) } })
  expectUnchangedRefusal(project, localOptions({ [localSrc]: probe }), /saved source attribution.*new media path/)
})

test('recorded byte identity is not established by equal probe facts or a matching caller-supplied digest', () => {
  const digest = 'a'.repeat(64), project = withAsset({ ...probe, contentSHA256: digest })
  expectUnchangedRefusal(project, localOptions({ [localSrc]: probe }), /saved source attribution/)
  expectUnchangedRefusal(project, localOptions({ [localSrc]: { ...probe, contentSHA256: digest } }), /saved source attribution/)
})

test('changed probe facts cannot inherit saved source attribution for the same path', () => {
  const project = withAsset({ ...probe, contentSHA256: 'a'.repeat(64) })
  expectUnchangedRefusal(project, localOptions({ [localSrc]: { ...probe, width: 160, size: 400 } }), /saved source attribution/)
})

test('existing source claims cannot bypass refusal by omitting the prepared asset map', () => {
  const project = withAsset({ ...probe, contentSHA256: 'a'.repeat(64) })
  expectUnchangedRefusal(project, localOptions(), /saved source attribution/)
})

test('manual Figma does not accept newly supplied unverifiable source claims', () => {
  for (const fields of [{ generated: { kind: 'image' } }, { contentSHA256: 'a'.repeat(64) }, { origin: { fileKey: 'opaque' } }, { provenance: { imports: [] } }]) {
    expectUnchangedRefusal(newProject('Fresh manual import'), localOptions({ [localSrc]: { ...probe, ...fields } }), /source attribution supplied/)
  }
})

test('empty or malformed legacy source claim fields are refused without rewriting the existing record', () => {
  for (const value of [null, {}, [], 'opaque']) {
    const project = withAsset({ ...probe, generated: value })
    expectUnchangedRefusal(project, localOptions({ [localSrc]: probe }), /saved source attribution/)
  }
})

test('a claimed existing image refuses the whole Figma batch before any new media or composition is imported', () => {
  const project = withAsset({ ...probe, contentSHA256: 'a'.repeat(64) })
  expectUnchangedRefusal(project, localOptions({ 'media/new-image.png': probe, [localSrc]: probe }), /saved source attribution/)
  assert.equal(project.assets['media/new-image.png'], undefined)
  assert.equal(Object.keys(project.comps ?? {}).length, 0)
})

test('Smart Animate refuses unverifiable existing source claims in either imported frame', () => {
  const project = withAsset({ ...probe, contentSHA256: 'a'.repeat(64) })
  expectUnchangedRefusal(project, { ...localOptions({ [localSrc]: probe }), mode: 'smartAnimate', toXml: localXML, transition: 1, hold: 1 }, /saved source attribution/)
})

test('owned music metadata is never treated as image byte verification by the Figma planner', () => {
  // Native image probing refuses audio-only WAVs before this shared planner runs.
  const project = withAsset({ ...probe, generated: { kind: 'original-music', renderer: 'arya-score-synth/1', contentSHA256: 'a'.repeat(64) } })
  expectUnchangedRefusal(project, localOptions({ [localSrc]: probe }), /saved source attribution/)
})
