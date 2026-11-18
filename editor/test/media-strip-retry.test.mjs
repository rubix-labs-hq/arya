import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The media card's filmstrip request, taken from browser.js so the test follows the page's code.
const source = readFileSync(new URL('../web/ui/browser.js', import.meta.url), 'utf8')
const slice = /const STRIP_RETRY_MS = [\s\S]*?\nasync function requestStrip\([\s\S]*?\n}\n/.exec(source)?.[0]
assert.ok(slice, 'browser.js still has requestStrip')
const requestStrip = new Function('api', `${slice}\nreturn requestStrip`)(() => { throw new Error('the page api is not used in this test') })

const busy = () => Object.assign(new Error('Too many filmstrips are waiting.'), { status: 429 })
const offline = () => new TypeError('Failed to fetch')
function fixture(answers) {
  const waits = [], asked = []
  const request = async url => { asked.push(url); const next = answers.shift(); if (next instanceof Error) throw next; return next }
  return { waits, asked, options: { request, wait: async ms => { waits.push(ms) } } }
}
const strip = { url: '/strips/a.jpg', w: 160, h: 90, count: 12 }

test('a busy server is asked again after 1, 2, 4 and 8 seconds, five tries in all', async () => {
  const f = fixture([busy(), busy(), busy(), busy(), busy(), strip])
  assert.equal(await requestStrip('/api/strip?src=a', () => true, f.options), null)
  assert.deepEqual(f.waits, [1000, 2000, 4000, 8000])
  assert.equal(f.asked.length, 5)
})

test('the strip arrives as soon as one try succeeds, after a refusal or a network error', async () => {
  const f = fixture([busy(), offline(), strip])
  assert.deepEqual(await requestStrip('/api/strip?src=a', () => true, f.options), strip)
  assert.deepEqual(f.waits, [1000, 2000])
  assert.deepEqual(f.asked, ['/api/strip?src=a', '/api/strip?src=a', '/api/strip?src=a'])
})

test('any other answer is final and is not asked for again', async () => {
  const f = fixture([Object.assign(new Error('No such media'), { status: 404 }), strip])
  assert.equal(await requestStrip('/api/strip?src=missing', () => true, f.options), null)
  assert.deepEqual(f.waits, [])
  assert.equal(f.asked.length, 1)
})

test('an error without a status that is not a network failure is final', async () => {
  // The Mac app and the hosted editor throw plain errors, such as a failed strip or a refused source.
  const f = fixture([new Error('Choose a picture source.'), strip])
  assert.equal(await requestStrip('/api/strip?src=a', () => true, f.options), null)
  assert.deepEqual(f.waits, [])
  assert.equal(f.asked.length, 1)
})

test('a card that unmounts stops the retries', async () => {
  let mounted = true
  const f = fixture([busy(), busy(), strip])
  f.options.wait = async ms => { f.waits.push(ms); if (f.waits.length === 2) mounted = false }
  assert.equal(await requestStrip('/api/strip?src=a', () => mounted, f.options), null)
  assert.deepEqual(f.waits, [1000, 2000])
  assert.equal(f.asked.length, 2, 'no request goes out after the card is gone')
  const gone = fixture([strip])
  assert.equal(await requestStrip('/api/strip?src=a', () => false, gone.options), null)
  assert.equal(gone.asked.length, 0)
})

test('the media card asks through the retrying request and checks it is still mounted', () => {
  assert.match(source, /if \(asset\.hasVideo\) requestStrip\(`\/api\/strip\?quality=high&src=\$\{encodeURIComponent\(src\)\}`, \(\) => active\)\.then\(d => \{ if \(active && d && !d\.error\) setStrip\(d\) \}\)/)
})
