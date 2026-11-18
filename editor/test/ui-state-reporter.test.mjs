import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// engine-host.js builds a canvas when it loads, so the reporter is taken from its source.
const source = readFileSync(new URL('../web/ui/engine-host.js', import.meta.url), 'utf8')
const body = /export function createUiStateReporter\([\s\S]*?\n}\n/.exec(source)?.[0]
assert.ok(body, 'engine-host.js still has createUiStateReporter')
const createUiStateReporter = new Function(`${body.replace('export ', '')}\nreturn createUiStateReporter`)()

function fixture(initial = { playhead: 0, selection: [], marker: null, track: null, page: 'edit', openComp: null }) {
  const sent = [], state = { ...initial }
  let clock = 0, fail = false
  const tick = createUiStateReporter({ read: () => ({ ...state }), now: () => clock, post: value => { sent.push({ at: clock, value }); return fail ? Promise.reject(new Error('offline')) : Promise.resolve({}) } })
  return { sent, state, tick, advance: ms => { clock += ms }, failing: value => { fail = value } }
}

test('sixty ticks with nothing changed post twice at most', () => {
  const f = fixture()
  for (let second = 0; second < 60; second++) { f.tick(); f.advance(1000) }
  assert.deepEqual(f.sent.map(post => post.at), [0, 30000])
  assert.deepEqual(f.sent[0].value, { playhead: 0, selection: [], marker: null, track: null, page: 'edit', openComp: null })
})

test('a change is posted on the next tick, and the 30 s resend counts from it', () => {
  const f = fixture()
  f.tick(); f.advance(1000)
  f.tick(); f.advance(1000)
  f.state.selection = ['c4']
  f.tick(); f.advance(1000)
  f.state.playhead = 2.5
  f.tick()
  assert.deepEqual(f.sent.map(post => post.at), [0, 2000, 3000])
  assert.deepEqual(f.sent[1].value.selection, ['c4'])
  assert.equal(f.sent[2].value.playhead, 2.5)
  for (let second = 0; second < 29; second++) { f.advance(1000); f.tick() }
  assert.equal(f.sent.length, 3)
  f.advance(1000); f.tick()
  assert.deepEqual(f.sent.map(post => post.at), [0, 2000, 3000, 33000])
})

test('nothing is posted more often than every 900 ms, even when every tick differs', () => {
  const f = fixture()
  for (let step = 0; step < 20; step++) { f.state.playhead = step; f.tick(); f.advance(300) }
  assert.deepEqual(f.sent.map(post => post.at), [0, 900, 1800, 2700, 3600, 4500, 5400])
})

test('a post that fails is sent again on the next tick', async () => {
  const f = fixture()
  f.failing(true)
  f.tick()
  await new Promise(resolve => setImmediate(resolve))
  f.failing(false)
  f.advance(1000); f.tick()
  await new Promise(resolve => setImmediate(resolve))
  f.advance(1000); f.tick()
  assert.deepEqual(f.sent.map(post => post.at), [0, 1000])
})

test('the page posts through the reporter and keeps no second timer', () => {
  assert.match(source, /setInterval\(createUiStateReporter\(\{/)
  assert.equal(source.match(/\/api\/ui-state/g).length, 1)
  assert.equal(source.match(/setInterval\(/g).length, 1)
})
