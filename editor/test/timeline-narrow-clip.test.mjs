import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The timeline's rounded rectangle, taken from the source so the test follows the drawing code.
const source = readFileSync(new URL('../web/ui/timeline.js', import.meta.url), 'utf8')
const body = /function roundRect\(ctx, x, y, w, hgt, r\) \{[\s\S]*?\n\}/.exec(source)?.[0]
assert.ok(body, 'timeline.js still has roundRect')
const roundRect = new Function(`${body}\nreturn roundRect`)()

// A canvas refuses a negative radius, as the browser does.
function canvas() {
  const calls = []
  return { calls, beginPath() {}, roundRect(x, y, w, h, r) { if (!(r >= 0)) throw new RangeError(`radius ${r} is negative`); calls.push({ x, y, w, h, r }) } }
}

test('a clip narrower than its border still draws', () => {
  for (const width of [-1, -0.9998, -0.5, 0, 0.0004, 1, 3]) {
    const ctx = canvas()
    assert.doesNotThrow(() => roundRect(ctx, 10, 4, width, 40, 5), `width ${width}`)
    assert.ok(ctx.calls[0].r >= 0 && ctx.calls[0].r <= 5)
    assert.ok(ctx.calls[0].w >= 1)
  }
})

test('an ordinary clip keeps its corner radius, and a short one gets half its width', () => {
  const wide = canvas(), short = canvas()
  roundRect(wide, 0, 0, 120, 40, 5)
  roundRect(short, 0, 0, 6, 40, 5)
  assert.equal(wide.calls[0].r, 5)
  assert.equal(short.calls[0].r, 3)
})
