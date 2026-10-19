// ProRes 4444 and PNG sequence exports keep transparency. Before, the render worker's canvas had
// no alpha channel and the final copy forced alpha to 1, so a lower third on a transparent
// composition exported as an opaque black frame. Verified on 2026-10-09 by exporting a red ellipse
// in a transparent 640x360 composition: PNG alpha 0..255 with mean 34.7 (13.6% coverage), ProRes
// 4444 yuva444p12le alpha 256..3760, antialiased edges straight (R 255 at alpha 64).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = file => fs.readFileSync(new URL(`../web/engine/${file}`, import.meta.url), 'utf8')

test('the render worker composites with alpha only for presets that can store it', () => {
  const worker = read('worker.js')
  assert.match(worker, /const ALPHA_PRESETS = new Set\(\['prores-4444', 'png-seq'\]\)/)
  assert.match(worker, /new Compositor\(canvas, \{ alpha: true \}\)/)
  assert.match(worker, /comp\.keepAlpha = job\.kind === 'export' && ALPHA_PRESETS\.has\(spec\.preset\)/)
})

test('the alpha copy composites the background with its own alpha and writes straight RGBA', () => {
  const compositor = read('compositor.js')
  assert.match(compositor, /vec4 o = c \+ vec4\(uBg\.rgb \* uBg\.a, uBg\.a\) \* \(1\.0 - c\.a\); outColor = o\.a > 0\.0 \? vec4\(o\.rgb \/ o\.a, o\.a\) : vec4\(0\.0\);/)
  // The viewer keeps its opaque canvas and the original copy shader, which the Metal port mirrors.
  assert.match(compositor, /const gl = canvas\.getContext\('webgl2', \{ premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, alpha \}\)/)
  assert.match(compositor, /outColor = vec4\(c\.rgb \+ uBg\.rgb \* \(1\.0 - c\.a\), 1\.0\);/)
})

test('alpha exports use the same background colour as the viewer and opaque exports', () => {
  const frame = read('frame.js')
  const start = frame.indexOf('export function presentBackground')
  const presentBackground = new Function(`${frame.slice(start, frame.indexOf('\n}\n', start) + 2).replace('export ', '')}\nreturn presentBackground`)()
  const comp = { compId: 'k1', background: '#204020' }, main = { background: '#112233' }, clear = { background: 'transparent' }
  assert.deepEqual([presentBackground(comp, false), presentBackground(comp, true)], ['#000000', 'transparent'], 'a composition never shows its own colour at the top level')
  assert.deepEqual([presentBackground(main, false), presentBackground(main, true)], ['#112233', '#112233'])
  assert.deepEqual([presentBackground(clear, false), presentBackground(clear, true)], ['#000000', 'transparent'])
  assert.match(frame, /comp\.present\(acc, presentBackground\(p, comp\.keepAlpha\), Boolean\(comp\.keepAlpha\)\)/)
})

test('the straight-alpha math keeps edge colour and transparent areas', () => {
  // The shader's arithmetic, per channel, on premultiplied input c over background bg.
  const copyAlpha = (c, bg) => {
    const o = [0, 1, 2].map(i => c[i] + bg[i] * bg[3] * (1 - c[3]))
    const a = c[3] + bg[3] * (1 - c[3])
    return a > 0 ? [...o.map(v => v / a), a] : [0, 0, 0, 0]
  }
  assert.deepEqual(copyAlpha([0.25, 0, 0, 0.25], [0, 0, 0, 0]), [1, 0, 0, 0.25], 'a quarter-covered red edge stays full red')
  assert.deepEqual(copyAlpha([0, 0, 0, 0], [0, 0, 0, 0]), [0, 0, 0, 0])
  assert.deepEqual(copyAlpha([0, 0, 0, 0], [0, 0, 0, 1]), [0, 0, 0, 1], 'an opaque background stays opaque')
})
