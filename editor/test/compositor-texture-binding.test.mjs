import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const editor = process.env.REEL_COMPOSITOR_EDITOR_ROOT
  ? pathToFileURL(path.resolve(process.env.REEL_COMPOSITOR_EDITOR_ROOT) + path.sep)
  : new URL('../', import.meta.url)
const compositorURL = process.env.REEL_COMPOSITOR_SOURCE
  ? pathToFileURL(path.resolve(process.env.REEL_COMPOSITOR_SOURCE))
  : new URL('web/engine/compositor.js', editor)
const moduleURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const gradeSource = (await fs.readFile(new URL('web/engine/grade.js', editor), 'utf8'))
  .replace("'/core/render-grade.js'", JSON.stringify(new URL('core/render-grade.js', editor).href))
const source = (await fs.readFile(compositorURL, 'utf8')).replace(/from (['"])([^'"]+)\1/g, (match, quote, specifier) => {
  if (specifier === './grade.js') return `from ${JSON.stringify(moduleURL(gradeSource))}`
  const url = specifier.startsWith('/core/')
    ? new URL(specifier.slice(1), editor)
    : new URL(specifier, new URL('web/engine/', editor))
  return `from ${JSON.stringify(url.href)}`
})
const { Compositor } = await import(moduleURL(source))

function fixture() {
  let active = 0
  const bindings = new Map(), uniforms = new Map(), draws = []
  const gl = {
    TEXTURE0: 100, TEXTURE_2D: 2, TEXTURE_3D: 3,
    activeTexture(value) { active = value - this.TEXTURE0 },
    bindTexture(target, texture) { bindings.set(`${active}:${target}`, texture) },
    createTexture() { return {} },
    texImage2D(target, level, format, width, height, border, layout, type, data) {
      Object.assign(bindings.get(`${active}:${target}`), { width, height, data: new Uint8Array(data) })
    },
    uniform1i(location, value) { uniforms.set(location, value) },
    drawArrays() {
      const texture = bindings.get(`${uniforms.get('uSrc')}:${this.TEXTURE_2D}`)
      const samples = [0.25, 0.75].map(u => {
        const offset = Math.min(texture.width - 1, Math.floor(u * texture.width)) * 4
        return [...texture.data.slice(offset, offset + 4)]
      })
      draws.push({ texture, samples, curves: bindings.get(`${uniforms.get('uCurves')}:${this.TEXTURE_2D}`) })
    },
  }
  for (const name of ['texParameteri', 'deleteTexture', 'bindFramebuffer', 'viewport', 'useProgram', 'enable',
    'disable', 'blendFunc', 'uniformMatrix3fv', 'uniform1f', 'uniform2f', 'uniform3f', 'uniform3fv',
    'uniform4f', 'bindVertexArray']) gl[name] = () => {}
  const compositor = Object.assign(Object.create(Compositor.prototype), {
    gl, curveTextures: new Map(), luts: new Map(), size: [2, 1],
    programs: { layer: { p: {}, u: new Proxy({}, { get: (_, name) => name }) } },
    blankLut: { tex: {}, size: 2 }, vao: {},
  })
  compositor.blankCurves = compositor.makeCurveTexture(null)
  const pixels = [[255, 32, 16, 255], [16, 96, 240, 255]]
  const texture = { width: 2, height: 1, data: Uint8Array.from(pixels.flat()) }
  const draw = grade => {
    compositor.drawLayer(null, { tex: texture, w: 2, h: 1 },
      { w: 2, h: 1, x: 1, y: 0.5, rotation: 0, opacity: 1, grade }, { width: 2, height: 1 }, 0)
    return draws.at(-1)
  }
  return { compositor, texture, pixels, draw }
}

function assertSourcePixels(f, draw) {
  assert.deepEqual(draw.samples, f.pixels, 'uSrc must sample source pixels at draw time, not the curve ramp')
  assert.equal(draw.texture, f.texture)
  assert.notEqual(draw.curves, f.texture)
}

test('an ungraded layer samples its source pixels', () => {
  const f = fixture()
  assertSourcePixels(f, f.draw(null))
})

test('empty curves preserve source pixels on the first frame after a cache miss', () => {
  const f = fixture()
  assert.equal(f.compositor.curveTextures.size, 0)
  assertSourcePixels(f, f.draw({ curves: {} }))
  assert.equal(f.compositor.curveTextures.size, 1)
})

test('cached curves preserve source pixels on a later frame', () => {
  const f = fixture()
  f.compositor.curveTexture({})
  assertSourcePixels(f, f.draw({ curves: {} }))
  assert.equal(f.compositor.curveTextures.size, 1)
})

test('editing curves preserves source pixels on the first frame for the new curve', () => {
  const f = fixture()
  f.compositor.curveTexture({})
  assertSourcePixels(f, f.draw({ curves: { master: [[0, 0.1], [1, 0.9]] } }))
  assert.equal(f.compositor.curveTextures.size, 2)
})
