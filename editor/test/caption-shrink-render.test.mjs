// Auto-wrapped captions must not change how existing one-line captions look. At f66c4f3 a caption
// without a style preset had no box, so its plate hugged the text; the wrap box now shrinks to the
// longest line, so the same caption draws the same canvas, plate and text.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { captionTitle } from '../core/caption-render.js'

// The real drawTitle and wrapTitleLines from the engine, without the module's font loading.
const source = fs.readFileSync(new URL('../web/engine/media.js', import.meta.url), 'utf8')
const body = source.slice(source.indexOf('const FONT_FALLBACK'), source.indexOf("export { parseCube }")).replace(/^export /gm, '')
const { drawTitle } = new Function('interFontError', 'signatureFontError', `${body}\nreturn { drawTitle, wrapTitleLines }`)(undefined, undefined)

function canvas() {
  const calls = []
  let font = '', size = 52
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key === 'measureText') return text => ({ width: [...String(text)].length * size * 0.55 })
      if (key in target) return target[key]
      return (...args) => calls.push([key, ...args.map(v => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v))])
    },
    set(target, key, value) {
      target[key] = value
      if (key === 'font') { font = value; size = Number(/(\d+(?:\.\d+)?)px/.exec(value)?.[1] ?? 52) }
      calls.push(['set', key, value])
      return true
    },
  })
  return { width: 0, height: 0, getContext: () => ctx, calls, font: () => font }
}

function draw(title, scale = 1920 / 1080) {
  const c = canvas()
  drawTitle(c, title, scale)
  return { width: c.width, height: c.height, calls: c.calls }
}

test('a one-line caption in an old 9:16 project draws exactly as before the wrap box', () => {
  const clip = { text: 'Sixteen chars ok' }
  const style = { size: 52 }
  const now = captionTitle(clip, style, 0, { width: 1080, height: 1920 })
  assert.equal(now.box?.shrink, true, 'the estimate gives this caption a wrap box')
  const { box: _box, ...before } = now // f66c4f3: the same title without a box
  assert.deepEqual(draw(now), draw(before))
  assert.notDeepEqual(draw({ ...now, box: { ...now.box, shrink: false } }), draw(before), 'a full-width box would have widened the plate')
})

// The real caption placement from frame.js.
const frameSource = fs.readFileSync(new URL('../web/engine/frame.js', import.meta.url), 'utf8')
const placementStart = frameSource.indexOf('export function captionPlacement')
const captionPlacement = new Function(`${frameSource.slice(placementStart, frameSource.indexOf('\n}\n', placementStart) + 2).replace('export ', '')}\nreturn captionPlacement`)()

test('a one-line caption at y 0.97 lands where it did before automatic wrapping', () => {
  const view = { width: 1080, height: 1920 }, rs = 1
  const now = captionTitle({ text: 'Sixteen chars ok' }, { size: 52, y: 0.97 }, 0, view)
  const { box: _box, ...before } = now
  const canvasNow = canvas(), canvasBefore = canvas()
  drawTitle(canvasNow, now, 1920 / 1080)
  drawTitle(canvasBefore, before, 1920 / 1080)
  assert.equal(canvasNow.titleWrapped, false, 'one line: wrapping added nothing')
  const placedNow = captionPlacement(now, canvasNow, view, rs, 0.97, canvasNow.titleWrapped)
  const placedBefore = captionPlacement(before, canvasBefore, view, rs, 0.97, canvasBefore.titleWrapped)
  assert.deepEqual(placedNow, placedBefore)
  assert.equal(placedNow.y, 0.97 * 1920, 'not pulled up into the safe area')
  // Once it wraps, the safe-area clamp applies again and keeps the lines inside the frame.
  const long = captionTitle({ text: 'Pack the blue tent, the spare lantern and two folding chairs before the ferry leaves at noon.' }, { size: 52, y: 0.97 }, 0, view)
  const wrapped = canvas()
  drawTitle(wrapped, long, 1920 / 1080)
  assert.equal(wrapped.titleWrapped, true)
  const placed = captionPlacement(long, wrapped, view, rs, 0.97, true)
  assert.ok(placed.y + placed.h / 2 <= 1920 * 0.975 + 1e-9)
})

test('a long caption wraps and its plate is as wide as its longest line, not the frame', () => {
  const title = captionTitle({ text: 'Pack the blue tent, the spare lantern and two folding chairs before the ferry leaves at noon.' }, { size: 52 }, 0, { width: 1080, height: 1920 })
  const drawn = draw(title)
  const plate = drawn.calls.find(c => c[0] === 'roundRect')
  const lines = drawn.calls.filter(c => c[0] === 'fillText').map(c => c[1])
  assert.ok(lines.length >= 3, `wrapped into ${lines.length} lines`)
  const scale = 1920 / 1080, longest = Math.max(...lines.map(l => [...l].length * title.size * scale * 0.55))
  assert.ok(Math.abs(plate[3] - (longest + 2 * title.padding * scale)) < 0.01, 'plate width follows the longest line')
  assert.ok(plate[3] < title.box.width * scale + 2 * title.padding * scale)
})
