import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { exportJustFinished, FIRST_EXPORT, MAXIMUM_SHOWS, MINIMUM_GAP_MS, recordSupportChoice, successfulExport, supportPromptState } from '../core/support-prompt.js'

const DAY = 24 * 60 * 60 * 1000
const START = 1_800_000_000_000
const run = (state, offsetDays, channelAvailable = true) => successfulExport(state, { now: START + offsetDays * DAY, channelAvailable })

test('the first export never prompts and the second does', () => {
  const first = run(null, 0)
  assert.equal(first.show, false)
  const second = run(first.state, 0)
  assert.equal(second.show, true)
  assert.deepEqual(second.state, { successfulExports: 2, timesShown: 1, lastShown: START, finished: false })
})

test('Not now waits 60 days and the prompt stops after three showings', () => {
  let state = { successfulExports: 1 }
  const shown = []
  for (const day of [0, 10, 59, 60, 61, 125, 200, 400]) {
    const next = run(state, day)
    state = next.show ? recordSupportChoice(next.state, 'notNow') : next.state
    if (next.show) shown.push(day)
  }
  assert.deepEqual(shown, [0, 60, 125])
  assert.equal(state.finished, false)
})

test('opening the tip page or choosing never ends the prompt', () => {
  for (const choice of ['support', 'never']) {
    const shown = run({ successfulExports: 1 }, 0)
    assert.equal(shown.show, true)
    const later = run(recordSupportChoice(shown.state, choice), 400)
    assert.equal(later.show, false, choice)
    assert.equal(later.state.timesShown, 1)
  }
})

test('an unavailable channel counts exports without showing', () => {
  let state = null
  for (let i = 0; i < 3; i++) { const next = run(state, 0, false); assert.equal(next.show, false); state = next.state }
  assert.equal(state.successfulExports, 3)
  assert.equal(run(state, 0).show, true)
})

test('damaged saved state starts fresh', () => {
  const fresh = { successfulExports: 0, timesShown: 0, lastShown: null, finished: false }
  for (const value of [null, 'x', [], { successfulExports: -1, timesShown: 1.5, lastShown: 'yesterday', finished: 'yes' }]) assert.deepEqual(supportPromptState(value), fresh)
})

test('the Swift and JavaScript rules use the same numbers', async () => {
  const swift = await readFile(new URL('../../native/ReelKit/Sources/ReelKit/SupportPrompt.swift', import.meta.url), 'utf8')
  assert.match(swift, new RegExp(`firstExport = ${FIRST_EXPORT}\\b`))
  assert.match(swift, new RegExp(`maximumShows = ${MAXIMUM_SHOWS}\\b`))
  assert.equal(MINIMUM_GAP_MS, 60 * DAY)
  assert.match(swift, /minimumGap: TimeInterval = 60 \* 24 \* 60 \* 60\b/)
})

test('only an export seen in progress that saved a file counts', () => {
  const done = { kind: 'export', state: 'done', output: 'renders/a.mp4' }
  assert.equal(exportJustFinished('running', done), true)
  assert.equal(exportJustFinished('committing', done), true)
  assert.equal(exportJustFinished(undefined, done), false, 'history loaded with the project')
  assert.equal(exportJustFinished('done', done), false, 'repeated update')
  assert.equal(exportJustFinished('running', { ...done, output: '' }), false)
  assert.equal(exportJustFinished('running', { ...done, error: 'disk full' }), false)
  assert.equal(exportJustFinished('running', { ...done, state: 'failed' }), false)
  assert.equal(exportJustFinished('running', { ...done, kind: 'proxy' }), false)
})

test('browser editors load the card only after a website link resolves, and it never records a payment', async () => {
  const main = await readFile(new URL('../web/main.js', import.meta.url), 'utf8')
  assert.match(main, /if \(!supportURL\) return\n\s+set\(\{ supportURL \}\)\n\s+const \{ mountSupportPrompt \} = await import\('\.\/ui\/support-prompt\.js'\)/)
  const source = await readFile(new URL('../web/ui/support-prompt.js', import.meta.url), 'utf8')
  assert.match(source, /if \(!s\.supportPromptOpen \|\| !s\.supportURL\) return null/)
  assert.doesNotMatch(source, /editwitharya|https?:\/\/|paid|purchase/i)
  assert.match(source, /if \(globalThis\.navigator\?\.webdriver\) return/, 'automation never sees the card')
  const css = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8')
  const layer = Number(css.match(/\.support-prompt \{[^}]*z-index: (\d+)/)[1])
  const dialogs = Number(css.match(/\.modal-back \{[^}]*z-index: (\d+)/)[1])
  assert.ok(layer < dialogs, 'the card stays under dialogs and menus')
})
