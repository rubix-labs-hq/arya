import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const editor = process.env.ARYA_TEST_EDITOR_ROOT ? pathToFileURL(process.env.ARYA_TEST_EDITOR_ROOT + '/') : new URL('../', import.meta.url)
const source = fs.readFileSync(new URL('web/ui/keys.js', editor), 'utf8')
const moduleBody = source.replace(/^import .*\n/gm, '').replace(/^export const /gm, 'const ').replace(/^export function /gm, 'function ').replace(/^export \{.*\}\s*$/gm, '')
const install = new Function('store', 'set', 'viewProject', 'window', moduleBody + '\nreturn installKeys')

function keyboard(patch = {}) {
  const state = { project: { fps: 30 }, showKeys: true, settingsOpen: false, selection: ['clip'], selMarker: 'marker', ...patch }
  const updates = []
  let handler
  install(state, update => { updates.push(update); Object.assign(state, update) }, () => state.project, {
    addEventListener(name, callback) { assert.equal(name, 'keydown'); handler = callback },
  })()
  const dispatch = (key = 'Escape', options = {}) => {
    const event = { key, metaKey: false, ctrlKey: false, defaultPrevented: false, target: { closest: () => null }, preventDefault() { this.defaultPrevented = true }, ...options }
    handler(event)
    return event
  }
  return { state, updates, dispatch }
}

for (const project of [{ fps: 30 }, null]) test(`Escape closes keyboard help ${project ? 'in an open project' : 'on the welcome screen'} without changing selection`, () => {
  const c = keyboard({ project })
  const event = c.dispatch()
  assert.equal(c.state.showKeys, false)
  assert.deepEqual(c.state.selection, ['clip'])
  assert.equal(c.state.selMarker, 'marker')
  assert.deepEqual(c.updates, [{ showKeys: false }])
  assert.equal(event.defaultPrevented, true)
})

test('Escape closes keyboard help when its opener leaves focus in a text field', () => {
  const c = keyboard()
  c.dispatch('Escape', { target: { closest: () => ({}) } })
  assert.equal(c.state.showKeys, false)
  assert.deepEqual(c.state.selection, ['clip'])
})

test('keyboard help respects an Escape event already consumed by a draft or dialog', () => {
  const c = keyboard()
  c.dispatch('Escape', { defaultPrevented: true })
  assert.equal(c.state.showKeys, true)
  assert.deepEqual(c.updates, [])
})

test('Settings retains Escape ownership while it is open', () => {
  const c = keyboard({ settingsOpen: true })
  assert.equal(c.dispatch().defaultPrevented, false)
  assert.equal(c.state.showKeys, true)
  assert.deepEqual(c.updates, [])
})

test('ordinary Escape still clears the selection when keyboard help is closed', () => {
  const c = keyboard({ showKeys: false })
  assert.equal(c.dispatch().defaultPrevented, true)
  assert.deepEqual(c.state.selection, [])
  assert.equal(c.state.selMarker, null)
})

test('ordinary Escape leaves a text draft and its selection untouched', () => {
  const c = keyboard({ showKeys: false })
  assert.equal(c.dispatch('Escape', { target: { closest: () => ({}) } }).defaultPrevented, false)
  assert.deepEqual(c.state.selection, ['clip'])
  assert.deepEqual(c.updates, [])
})

test('the existing question-mark shortcut can still close keyboard help', () => {
  const c = keyboard()
  assert.equal(c.dispatch('?').defaultPrevented, true)
  assert.equal(c.state.showKeys, false)
  assert.deepEqual(c.state.selection, ['clip'])
})
