// The browser editor design pass: rules that keep the assistant panel, top bar and dialogs consistent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { h } from 'preact'
import { readFileSync } from 'node:fs'
import { Icon, hasIcon } from '../web/ui/icons.js'

const read = path => readFileSync(new URL(`../web/${path}`, import.meta.url), 'utf8')
const styles = read('styles.css'), assistantCSS = read('ui/assistant.css'), chat = read('ui/chat.js')
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const nodes = node => node && typeof node === 'object' ? [node, ...flatten(node.props?.children).flatMap(nodes)] : []

test('work in progress is a drawn spinner that stays still with reduced motion', () => {
  const spinner = Icon({ name: 'spinner', size: 14 })
  assert.equal(spinner.type, 'svg'); assert.equal(spinner.props.class, 'spinner'); assert.equal(spinner.props['aria-hidden'], 'true')
  assert.ok(nodes(spinner).some(node => node.type === 'path'))
  assert.match(assistantCSS, /\.spinner \{[^}]*animation: assistant-spin/)
  assert.match(assistantCSS, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.spinner \{ animation: none; \}/)
  // No text glyph stands in for a state: the run line, the checking line and the failure card draw icons.
  assert.doesNotMatch(chat, /['"`>][◌↻↵■]['"`<]/u)
  for (const name of ['alert', 'check', 'eye', 'layout', 'recovery', 'render', 'help', 'more', 'download']) assert.ok(hasIcon(name), name)
  assert.equal(h(Icon, { name: 'alert' }).props.name, 'alert')
})

test('the run line shows one step label while working, with the elapsed time in tabular figures', () => {
  assert.match(assistantCSS, /\.chat-list \.assistant-run\.active \.assistant-run-heading:has\(\.assistant-run-stage\) b \{[^}]*clip-path: inset\(50%\)/, 'the state word is kept for screen readers only')
  assert.doesNotMatch(assistantCSS, /\.assistant-run\.active[^{]*b \{[^}]*display:\s*none/)
  assert.match(assistantCSS, /\.assistant-run-time \{ font-variant-numeric: tabular-nums; \}/)
  assert.match(assistantCSS, /\.assistant-stop \{[^}]*min-width: 86px;/, 'Stop and Stopping take the same room, so the button does not jump')
})

test('a finished turn with a result card has no separate Done line, and Edit request waits for hover or focus', () => {
  assert.match(chat, /turn\.updates\.length && \(failed \|\| !turn\.receipts\.length\) \? RunLine\(/)
  assert.match(assistantCSS, /@media \(hover: hover\) \{\s*\.chat-list \.msg\.user \.assistant-edit-request \{ opacity: 0; \}\s*\.chat-list \.msg\.user:is\(:hover, :focus-within\) \.assistant-edit-request \{ opacity: 1; \}/)
  assert.match(assistantCSS, /@media \(hover: none\) \{ \.chat-list \.msg\.user:not\(\[data-last\]\) \.assistant-edit-request \{ display: none; \} \}/, 'touch keeps it on the last request only')
  assert.match(chat, /data-last=\$\{latest && \['user', 'you'\]\.includes\(m\.role\) \? '' : undefined\}/)
})

test('composer tools stay in place while a run works, and a disabled Send is a quiet well', () => {
  assert.doesNotMatch(assistantCSS, /assistant-field-bar:has\(\.assistant-stop\) \.assistant-script-import \{ display: none; \}/)
  assert.match(assistantCSS, /\.assistant-primary-action \.send:disabled \{ background: var\(--panel-2\); color: var\(--muted\); opacity: 1; \}/)
  assert.match(assistantCSS, /\.assistant-preview-toggle:has\(input:focus-visible\) \{ outline: 2px solid var\(--accent\);/)
  assert.match(styles, /--accent:/)
})
