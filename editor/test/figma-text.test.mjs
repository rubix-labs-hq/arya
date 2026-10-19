import assert from 'node:assert/strict'
import test from 'node:test'

import { figmaToOps } from '../core/figma.js'
import { applyOps, newProject } from '../core/project.js'

export function textFrame() {
  return {
    id: '1:1', name: 'Text layout', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 1080, height: 1350 },
    children: [{
      id: '1:2', name: 'Heading', type: 'TEXT', characters: 'Plan 43 makes it harder to build',
      absoluteBoundingBox: { x: 72, y: 758, width: 936, height: 150 },
      style: { fontFamily: 'Inter', fontWeight: 800, fontSize: 80, lineHeightPx: 75.2, letterSpacing: -0.5, textCase: 'UPPER', textAlignHorizontal: 'LEFT' },
      fills: [{ type: 'SOLID', color: { r: 206 / 255, g: 234 / 255, b: 1 / 255 } }],
    }],
  }
}

test('Figma titles retain source text and declared bounds for renderer measurement', () => {
  const p = newProject('Text layout')
  const mapped = figmaToOps(textFrame(), { project: p, duration: 2 })
  const project = applyOps(p, mapped.ops).project
  const clip = project.comps[mapped.comp].tracks.flatMap(t => t.clips).find(c => c.kind === 'title')
  assert.equal(clip.title.text, 'PLAN 43 MAKES IT HARDER TO BUILD')
  assert.deepEqual(clip.title.box, { width: 748.8, height: 120, wrap: true, alignY: 'top' })
  assert.deepEqual([clip.x, clip.y], [540, 833])
  assert.equal(clip.title.size, 64)
  assert.equal(clip.title.font, 'Inter')
  assert.equal(clip.title.weight, 800)
})

test('explicit newlines survive import and auto-width text does not wrap', () => {
  const node = textFrame()
  node.children[0].characters = 'A line\nAnother line'
  node.children[0].style.textAutoResize = 'WIDTH_AND_HEIGHT'
  const mapped = figmaToOps(node, { duration: 2 })
  const title = mapped.ops.find(op => op.op === 'add_title').title
  assert.equal(title.text, 'A LINE\nANOTHER LINE')
  assert.equal(title.box.wrap, false)
})

test('Plugin API sizing overrides style metadata for uppercase auto-width text', () => {
  const node = textFrame()
  Object.assign(node.children[0], { characters: 'Go on 43', textAutoResize: 'WIDTH_AND_HEIGHT', textAlignVertical: 'CENTER' })
  Object.assign(node.children[0].style, { textAutoResize: 'HEIGHT', fontSize: 38, letterSpacing: 2.66 })
  node.children[0].absoluteBoundingBox = { x: 72, y: 1230, width: 202, height: 38 }
  const mapped = figmaToOps(node, { duration: 2 })
  const title = mapped.ops.find(op => op.op === 'add_title').title
  assert.equal(title.text, 'GO ON 43')
  assert.equal(title.box.wrap, false)
  assert.equal(title.box.alignY, 'center')
})
