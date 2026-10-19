import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

// Splits a stylesheet into rules with the at-rule they sit in ('' at top level).
function rules(text) {
  const out = []
  let depth = 0, start = 0, context = ['']
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      const head = text.slice(start, i).trim()
      if (head.startsWith('@')) context.push(head)
      else out.push({ selector: head, at: context.at(-1), body: text.slice(i + 1, text.indexOf('}', i)) })
      depth++; start = i + 1
    } else if (text[i] === '}') {
      if (context.length > 1 && depth === context.length - 1) context.pop()
      depth--; start = i + 1
    }
  }
  return out
}

test('no rule outside a pointer query shrinks track header buttons below the touch target', () => {
  const all = rules(css)
  const coarse = all.filter(r => r.at === '@media (pointer: coarse)' && /\.th-btns button/.test(r.selector))
  assert.ok(coarse.some(r => /min-width: 44px/.test(r.body) && /min-height: 44px/.test(r.body)), 'touch keeps 44 pixel track buttons')
  const coarseIndex = all.indexOf(coarse.at(-1))
  for (const rule of all.slice(coarseIndex + 1)) {
    if (!/(^|,\s*)\.th-btns button(\s*,|$)/.test(rule.selector) || rule.at === '@media (pointer: fine)') continue
    assert.doesNotMatch(rule.body, /min-(width|height)/, `${rule.at || 'top level'} ${rule.selector} would override the touch size`)
  }
  assert.ok(all.some(r => r.at === '@media (pointer: fine)' && r.selector === '.th-btns button' && /min-width: 22px/.test(r.body)))
})

test('one-line Deliver presets keep a 44 pixel touch target', () => {
  const all = rules(css)
  const coarse = all.filter(r => r.at === '@media (pointer: coarse)' && r.selector === '.deliver-preset')
  assert.ok(coarse.some(r => /min-height: 44px/.test(r.body)), 'touch presets are 44 pixels tall')
  const last = all.indexOf(coarse.at(-1))
  for (const rule of all.slice(last + 1)) {
    if (rule.selector !== '.deliver-preset' || rule.at === '@media (pointer: fine)') continue
    assert.doesNotMatch(rule.body, /min-height/, `${rule.at || 'top level'} .deliver-preset would override the touch height`)
  }
})

test('the history pair drops its frame on touch so 44 pixel buttons fit the top bar', () => {
  assert.ok(rules(css).some(r => r.at === '@media (pointer: coarse)' && r.selector === '.topbar-history' && /padding: 0/.test(r.body)))
})
