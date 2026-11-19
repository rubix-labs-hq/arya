// The browser editor design pass: rules that keep the assistant panel, top bar and dialogs consistent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { h } from 'preact'
import { readFileSync } from 'node:fs'
import { Icon, hasIcon } from '../web/ui/icons.js'

const read = path => readFileSync(new URL(`../web/${path}`, import.meta.url), 'utf8')
const mediaBlock = (css, query) => { const start = css.indexOf(`@media ${query} {`); assert.notEqual(start, -1, query); let depth = 0; for (let i = css.indexOf('{', start); i < css.length; i++) { if (css[i] === '{') depth++; if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1) } }
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

test('Layout and Recovery are icon buttons that keep their names when the label hides', () => {
  const app = read('ui/app.js'), layout = read('ui/layout.js')
  assert.match(app, /class="ghost recovery-entry" aria-label="Recovery"[^\n]*<\$\{Icon\} name="recovery" \/><span class="entry-text">Recovery<\/span>/)
  assert.match(layout, /<span class="entry-text">Layout<\/span>/)
  assert.doesNotMatch(layout, /from '\.\/icons\.js'/, 'layout.js draws its own icon so its test harnesses keep loading it alone')
  assert.match(styles, /@media \(min-width: 900px\) and \(max-width: 1279px\) \{[^@]*\.entry-text \{[^}]*clip-path: inset\(50%\)/)
})

test('between 1100 and 1439px an open assistant takes the inspector column and the compact picker waits for under 900px', () => {
  const app = read('ui/app.js'), store = read('ui/store.js')
  const shared = new Function(`${app.match(/const sideColumnShared = [^\n]+/)[0]}; return sideColumnShared`)()
  assert.deepEqual([1099, 1100, 1280, 1439, 1440].map(width => shared(true, width)), [false, true, true, true, false])
  assert.equal(shared(false, 1280), false); assert.equal(shared(true, undefined), false)
  assert.match(app, /const l = sideTab === 'assistant' \? \{ \.\.\.saved, showInspector: false \} : saved/)
  assert.match(app, /const compact = !phone && !shared && Number\.isFinite\(workspace\.width\) && workspace\.width < 900/)
  assert.match(store, /if \(next\.chatOpen === true && !Object\.hasOwn\(next, 'sideTab'\)\) store\.sideTab = 'assistant'/)
  assert.match(chat, /<div class="side-tabs" role="tablist" aria-label="Side panel">/)
  const mid = mediaBlock(assistantCSS, '(min-width: 1100px) and (max-width: 1439px)')
  assert.match(mid, /\.main:has\(> \.page\.edit\) > \.chat\.panel \{ width: 320px; \}/)
  assert.match(mid, /\.main:has\(> \.page\.edit\.side-inspector\) > :is\(\.chat, \.workspace-divider\.divider-chat\) \{ display: none; \}/, 'the assistant stays mounted behind the Inspector tab')
  assert.match(mid, /\.tl-toolbar \{ flex-wrap: nowrap; \}/, 'the timeline toolbar keeps to one row')
  assert.match(assistantCSS, /\n\.side-tabs \{ display: none; \}/)
})

test('type, focus, motion and disabled text come from root tokens, and nothing is set below 11px', () => {
  for (const token of ['--text-caption: 11px', '--text-label: 12px', '--text-body: 13px', '--text-title: 15px', '--text-dialog: 18px', '--text-display: 21px', '--mono-small: 11px', '--mono: 12px', '--focus-ring: 2px solid var(--accent)', '--focus-offset: 2px', '--focus-inset: -2px', '--motion-fast: 120ms', '--motion-base: 180ms', '--disabled-text: #8a8e83']) assert.ok(styles.includes(`  ${token};`), token)
  for (const [name, css] of [['styles.css', styles], ['assistant.css', assistantCSS], ['phone.css', read('ui/phone.css')], ['icons.css', read('ui/icons.css')]]) {
    for (const [rule, size] of css.matchAll(/font(?:-size)?:\s*(\d+(?:\.\d+)?)px/g)) assert.ok(Number(size) >= 11, `${name}: ${rule}`)
  }
  // Inputs keep the browser ring until the shared one replaces it: no blanket outline: none.
  assert.doesNotMatch(styles, /\nselect, input[^{]*\{[^}]*outline: none/)
  assert.match(styles, /select:focus-visible, input:focus-visible, textarea:focus-visible \{ outline: var\(--focus-ring\); outline-offset: var\(--focus-offset\); \}/)
  assert.match(styles, /button:focus-visible, a:focus-visible, \[tabindex\]:focus-visible, summary:focus-visible \{ outline: var\(--focus-ring\); outline-offset: var\(--focus-offset\); \}/)
  assert.match(styles, /\.seg button:focus-visible, \[role=tab\]:focus-visible \{ outline-offset: var\(--focus-inset\); \}/)
  // One reduced-motion block turns every animation and transition off.
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important;/)
  assert.doesNotMatch(`${styles}${assistantCSS}`, /transition: [^;]*\b(?:\.12s|\.18s|120ms|180ms)/)
  assert.match(styles, /button:disabled:is\(\.ghost, \.tiny\):not\(\.primary\) \{ opacity: 1; color: var\(--disabled-text\); \}/)
})

test('chrome names clips by name and place, and the hosted entry and settings say what they are', () => {
  const inspector = read('ui/inspector.js')
  assert.doesNotMatch(inspector, /<span class="muted">\$\{clip\.id\}/, 'the inspector header does not print the stored id')
  assert.match(inspector, /\$\{s\.selection\.length > 1 \? `\$\{s\.selection\.length\} clips selected` : clipName\(clip\)\}/)
  assert.match(inspector, /`\$\{track\.id\} at \$\{timecode\(clip\.start, p\.fps\)\}`/)
  assert.match(inspector, /<b>Transition<\/b><span class="muted" title=\$\{`Clip id \$\{clip\.id\}`\}> into \$\{clipName\(clip\)\}<\/span>/)
  assert.match(inspector, /<b>Marker<\/b><span class="muted" title=\$\{`Marker id \$\{m\.id\}`\}> at \$\{timecode\(m\.t, p\.fps\)\}<\/span>/)
  assert.match(inspector, /<div class="kv"><span>ID<\/span><b>\$\{clip\.id\}<\/b><\/div>/, 'the id stays on the Info tab')
  assert.match(read('ui/settings.js'), /settings-theme-note">Arya has one theme, a dark one/)
  assert.match(assistantCSS, /\.topbar \.assistant-entry\.hosted \{ min-width: 0; border-color: var\(--line\); background: transparent; color: var\(--muted\); \}/)
})
