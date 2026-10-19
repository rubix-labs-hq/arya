import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'

const file = process.env.ARYA_CAPTION_INPUT_SOURCE ?? new URL('../web/ui/plugins/captions.js', import.meta.url)
const source = fs.readFileSync(file, 'utf8')
const start = source.indexOf('function tc('), end = source.indexOf('const setStart =')
assert(start >= 0 && end > start, 'Load the actual caption field components')
const factory = new Function('deps', `const { html, useState, useRef, useEffect, edit, toast } = deps; ${source.slice(start, end)}; return { TimeInput, TextBox }`)

function field(name, props, { renderBeforeBlur = false } = {}) {
  const slots = [], pending = new Map(), edits = [], notices = []
  let cursor = 0, node, blurs = 0
  const hooks = {
    html: htm.bind(h),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], value => pending.set(index, value)]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect() {},
    edit: (...args) => edits.push(args),
    toast: (...args) => notices.push(args),
  }
  const components = factory(hooks)
  const render = () => {
    for (const [index, value] of pending) slots[index] = value
    pending.clear()
    cursor = 0
    node = components[name](props)
    target.value = node.props.value
    return node
  }
  const target = {
    value: '', select() {},
    blur() {
      blurs++
      if (renderBeforeBlur) render()
      node.props.onBlur()
    },
  }
  render()
  const input = value => {
    node.props.onFocus?.({ target })
    render()
    target.value = value
    node.props.onInput({ target })
    render()
  }
  const key = (name, options = {}) => {
    const event = { key: name, shiftKey: false, target, prevented: false, stopped: false,
      preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, ...options }
    node.props.onKeyDown(event)
    render()
    return event
  }
  return { input, key, blur: () => { target.blur(); render() }, edits, notices, get node() { return node }, get blurs() { return blurs } }
}

for (const renderBeforeBlur of [false, true]) {
  test(`Caption Escape discards the text draft with ${renderBeforeBlur ? 'an intervening render' : 'synchronous blur'}`, () => {
    const c = field('TextBox', { clip: { id: 'c11', text: 'Saved caption' } }, { renderBeforeBlur })
    c.input('Escape should cancel this')
    const event = c.key('Escape')
    assert.equal(c.edits.length, 0)
    assert.equal(c.node.props.value, 'Saved caption')
    assert.equal(c.blurs, 1)
    assert.equal(event.prevented, true)
    assert.equal(event.stopped, true)
  })

  test(`Caption time Escape discards a valid draft with ${renderBeforeBlur ? 'an intervening render' : 'synchronous blur'}`, () => {
    const commits = [], c = field('TimeInput', { value: 2, fps: 30, onCommit: value => commits.push(value) }, { renderBeforeBlur })
    c.input('9.5')
    c.key('Escape')
    assert.deepEqual(commits, [])
    assert.equal(c.node.props.value, '00:02:00')
    assert.equal(c.notices.length, 0)
  })
}

test('Caption time Escape does not validate or report a discarded invalid draft', () => {
  const commits = [], c = field('TimeInput', { value: 2, fps: 30, onCommit: value => commits.push(value) })
  c.input('not a time')
  const event = c.key('Escape')
  assert.deepEqual(commits, [])
  assert.deepEqual(c.notices, [])
  assert.equal(event.prevented, true)
  assert.equal(event.stopped, true)
  assert.equal(c.node.props.value, '00:02:00')
})

test('Caption text Enter still saves once through the same synchronous blur handler', () => {
  const c = field('TextBox', { clip: { id: 'c11', text: 'Saved caption' } })
  c.input('Updated caption')
  c.key('Enter')
  assert.deepEqual(c.edits, [[{ op: 'update', id: 'c11', set: { text: 'Updated caption' } }, 'edited a caption']])
  assert.equal(c.blurs, 1)
})

test('Caption text Shift-Enter retains the draft without a blur or edit', () => {
  const c = field('TextBox', { clip: { id: 'c11', text: 'Saved caption' } })
  c.input('Two\nlines')
  const event = c.key('Enter', { shiftKey: true })
  assert.equal(c.edits.length, 0)
  assert.equal(c.blurs, 0)
  assert.equal(event.prevented, false)
  assert.equal(c.node.props.value, 'Two\nlines')
})

test('Caption text ordinary blur still commits its draft', () => {
  const c = field('TextBox', { clip: { id: 'c11', text: 'Saved caption' } })
  c.input('Saved on blur')
  c.blur()
  assert.equal(c.edits.length, 1)
  assert.equal(c.edits[0][0].set.text, 'Saved on blur')
})

test('Caption time Enter still commits frame timecode through the same blur handler', () => {
  const commits = [], c = field('TimeInput', { value: 2, fps: 30, onCommit: value => commits.push(value) })
  c.input('00:03:15')
  c.key('Enter')
  assert.deepEqual(commits, [3.5])
})

test('Caption time ordinary blur still validates an invalid active draft', () => {
  const commits = [], c = field('TimeInput', { value: 2, fps: 30, onCommit: value => commits.push(value) })
  c.input('not a time')
  c.blur()
  assert.deepEqual(commits, [])
  assert.equal(c.notices.length, 1)
  assert.equal(c.notices[0][1], 'error')
})

test('Caption text can commit a new draft after cancelling the previous draft', () => {
  const c = field('TextBox', { clip: { id: 'c11', text: 'Saved caption' } })
  c.input('Discard me')
  c.key('Escape')
  c.input('Keep me')
  c.key('Enter')
  assert.equal(c.edits.length, 1)
  assert.equal(c.edits[0][0].set.text, 'Keep me')
})

test('Caption time can commit a new draft after cancelling the previous draft', () => {
  const commits = [], c = field('TimeInput', { value: 2, fps: 30, onCommit: value => commits.push(value) })
  c.input('9.5')
  c.key('Escape')
  c.input('4')
  c.blur()
  assert.deepEqual(commits, [4])
})
