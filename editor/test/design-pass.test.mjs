// The browser editor design pass: rules that keep the assistant panel, top bar and dialogs consistent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { h } from 'preact'
import { readFileSync, readdirSync } from 'node:fs'
import { Icon, hasIcon } from '../web/ui/icons.js'

const read = path => readFileSync(new URL(`../web/${path}`, import.meta.url), 'utf8')
const mediaBlock = (css, query) => { const start = css.indexOf(`@media ${query} {`); assert.notEqual(start, -1, query); let depth = 0; for (let i = css.indexOf('{', start); i < css.length; i++) { if (css[i] === '{') depth++; if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1) } }
// The pixel size of each font or font-size declaration, shorthand included.
const pxSizes = css => [...css.matchAll(/(?:^|[\s;{])font(?:-size)?:\s*(?:[a-z0-9-]+\s+)*?(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]))
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

test('between 901 and 1439px an open assistant takes the inspector column and the compact picker waits for 900px and under', () => {
  const app = read('ui/app.js'), store = read('ui/store.js')
  const shared = new Function(`${app.match(/const sideColumnShared = [^\n]+/)[0]}; return sideColumnShared`)()
  assert.deepEqual([900, 901, 1024, 1099, 1100, 1280, 1439, 1440].map(width => shared(true, width)), [false, true, true, true, true, true, true, false])
  assert.equal(shared(false, 1280), false); assert.equal(shared(true, undefined), false)
  assert.match(app, /const l = sideTab \? \{ \.\.\.saved, showInspector: sideTab === 'inspector' \} : saved/, 'the Inspector tab shows the inspector even when the saved layout hides it')
  assert.match(app, /const shared = !phone && host\.kind !== 'browser-local' && sideColumnShared\(s\.chatOpen\)/)
  assert.match(app, /if \(s\.chatOpen && !s\.chatCollapsed && store\.sideTab !== 'inspector'\) focus\(\)/, 'Ask Arya brings the assistant forward from the Inspector tab')
  assert.match(app, /const compact = !phone && !shared && Number\.isFinite\(workspace\.width\) && workspace\.width < 900/)
  assert.match(store, /if \(next\.chatOpen === true && !Object\.hasOwn\(next, 'sideTab'\)\) store\.sideTab = 'assistant'/)
  assert.match(chat, /<div class="side-tabs" role="tablist" aria-label="Side panel">/)
  const mid = mediaBlock(assistantCSS, '(min-width: 901px) and (max-width: 1439px)')
  assert.match(mid, /\.main:has\(> \.page\.edit\) > \.chat\.panel \{ width: 320px; \}/)
  assert.match(mid, /\.main:has\(> \.page\.edit\.side-inspector\) > :is\(\.chat, \.workspace-divider\.divider-chat\) \{ display: none; \}/, 'the assistant stays mounted behind the Inspector tab')
  assert.match(mid, /\.tl-toolbar \{ flex-wrap: nowrap; \}/, 'the timeline toolbar keeps to one row')
  assert.match(assistantCSS, /\n\.side-tabs \{ display: none; \}/)
  // The panel is a fixed overlay at 900px and under, so the shared column starts one pixel above that.
  assert.match(assistantCSS, /@media \(max-width: 900px\) \{\s*\.main > \.chat\.panel \{ position: fixed;/)
  assert.match(mediaBlock(assistantCSS, '(min-width: 901px) and (max-width: 1099px)'), /\.tl-zoom input\[type=range\] \{ display: none; \}/, 'the zoom slider gives way first')
  assert.match(mediaBlock(assistantCSS, '(min-width: 901px) and (max-width: 999px)'), /\.tl-toolbar \{ flex-wrap: wrap; \}/, 'then the zoom buttons take a second row')
})

test('a narrow composer puts the input options above Preview first and Send, so the model name is not cut', () => {
  const narrow = assistantCSS.slice(assistantCSS.indexOf('@container composer (max-width: 409px) {')); assert.ok(narrow.startsWith('@container'))
  const block = narrow.slice(0, narrow.indexOf('\n}\n'))
  assert.match(block, /\.chat \.assistant-field-bar \{ flex-wrap: wrap;/)
  assert.match(block, /\.chat \.assistant-input-tools \{ flex: 1 1 100%; \}/)
  assert.match(block, /\.chat \.assistant-primary-action \{ flex: 1 1 100%; justify-content: flex-end;/)
  assert.match(block, /\.chat \.assistant-primary-action > \.assistant-preview-toggle \{ margin-right: auto; \}/)
  // Nothing hides the word or the tips button to make room any more, except in a window too short for two rows.
  assert.doesNotMatch(assistantCSS, /\.assistant-model-menu \{ min-width: 34px; \}/)
  assert.doesNotMatch(mediaBlock(assistantCSS, '(min-width: 901px) and (max-width: 1439px)'), /assistant-preview-first|assistant-input-help/)
})

test('on a phone the open assistant button shows an inset fill and no frame', () => {
  const phone = assistantCSS.slice(assistantCSS.lastIndexOf('@media (max-width: 480px) {'))
  const block = phone.slice(0, phone.indexOf('\n}\n'))
  assert.match(block, /\.topbar \.assistant-entry, \.topbar \.assistant-entry\.on, \.topbar \.assistant-entry\[data-state="working"\], \.topbar \.assistant-entry:hover:not\(:disabled\) \{ border-color: transparent; background: transparent; isolation: isolate; \}/)
  assert.match(block, /\.topbar \.assistant-entry:is\(\.on, \[data-state="working"\]\)::before \{ content: ''; position: absolute; z-index: -1; inset: 4px;/)
})

test('type, focus, motion and disabled text come from root tokens, and nothing is set below 11px', () => {
  for (const token of ['--text-caption: 11px', '--text-label: 12px', '--text-body: 13px', '--text-title: 15px', '--text-dialog: 18px', '--text-display: 21px', '--mono-small: 11px', '--mono: 12px', '--focus-ring: 2px solid var(--accent)', '--focus-offset: 2px', '--focus-inset: -2px', '--motion-fast: 120ms', '--motion-base: 180ms', '--disabled-text: #8a8e83']) assert.ok(styles.includes(`  ${token};`), token)
  // Every stylesheet under web/, and the size inside a font shorthand such as "font: 600 10px/1.5 monospace".
  const sheets = readdirSync(new URL('../web/', import.meta.url), { recursive: true }).filter(name => name.endsWith('.css'))
  assert.ok(sheets.includes('styles.css') && sheets.some(name => name.endsWith('motion.css')) && sheets.some(name => name.endsWith('library.css')) && sheets.length >= 8, sheets.join(', '))
  assert.deepEqual(pxSizes('a { font: 600 10px/1.5 ui-monospace; } b { font-size: 9.5px } c { font: italic 700 12px x } d { font: var(--mono-small) x; line-height: 4px }'), [10, 9.5, 12])
  for (const name of sheets) for (const size of pxSizes(read(name))) assert.ok(size >= 11, `${name}: ${size}px`)
  // Plugins carry their own style blocks; the same floor holds there.
  for (const file of readdirSync(new URL('../web/ui/plugins/', import.meta.url)).filter(name => name.endsWith('.js'))) for (const size of pxSizes(read(`ui/plugins/${file}`))) assert.ok(size >= 11, `${file}: ${size}px`)
  // Inputs keep the browser ring until the shared one replaces it: no blanket outline: none.
  assert.doesNotMatch(styles, /\nselect, input[^{]*\{[^}]*outline: none/)
  assert.match(styles, /select:focus-visible, input:focus-visible, textarea:focus-visible \{ outline: var\(--focus-ring\); outline-offset: var\(--focus-offset\); \}/)
  assert.match(styles, /button:focus-visible, a:focus-visible, \[tabindex\]:focus-visible, summary:focus-visible \{ outline: var\(--focus-ring\); outline-offset: var\(--focus-offset\); \}/)
  assert.match(styles, /\.seg button:focus-visible, \[role=tab\]:focus-visible \{ outline-offset: var\(--focus-inset\); \}/)
  // The global reduced-motion block turns every animation and transition off.
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

test('F6 and Shift+F6 walk the regions in order: top bar, media, viewer, inspector, timeline, assistant', () => {
  const keys = read('ui/keys.js'), app = read('ui/app.js')
  const source = keys.slice(keys.indexOf('export const LANDMARKS'), keys.indexOf('function sel()')).replace(/export /g, '')
  const { LANDMARKS, landmarkStep, cycleLandmark } = new Function(`${source}; return { LANDMARKS, landmarkStep, cycleLandmark }`)()
  assert.deepEqual([landmarkStep(6, -1), landmarkStep(6, -1, true), landmarkStep(6, 0), landmarkStep(6, 5), landmarkStep(6, 0, true), landmarkStep(0, -1)], [0, 5, 1, 0, 5, -1])
  assert.match(LANDMARKS, /^\.topbar, .*#editor-assistant$/)
  // A document with the Edit page's regions in source order. One is hidden, as a closed panel is.
  const focused = []
  const region = (name, { shown = true, field = true } = {}) => { const el = { name, id: name === 'assistant' ? 'editor-assistant' : '', attrs: {}, getClientRects: () => shown ? [1] : [], contains: other => other === el || other === el.inner, hasAttribute: key => key in el.attrs, setAttribute: (key, value) => { el.attrs[key] = value }, focus: () => { doc.activeElement = el; focused.push(name) }, querySelector: () => null, querySelectorAll: () => field ? [el.inner] : [] }; el.inner = { getClientRects: () => [1], focus: () => { doc.activeElement = el.inner; focused.push(name) } }; return el }
  const regions = [region('top bar'), region('media'), region('viewer', { field: false }), region('inspector', { shown: false }), region('timeline'), region('assistant')]
  // A labelled section nested in the media panel is not a stop of its own.
  const nested = region('nested'); const mediaContains = regions[1].contains; regions[1].contains = other => other === nested || other === nested.inner || mediaContains(other); regions.splice(2, 0, nested)
  let modal = []
  const doc = { activeElement: null, querySelectorAll: selector => { if (selector === '[aria-modal="true"]') return modal; assert.equal(selector, LANDMARKS); return regions } }
  modal = [{ getClientRects: () => [1] }]; assert.equal(cycleLandmark(false, doc), null, 'an open dialog keeps focus'); assert.deepEqual(focused, []); modal = []
  for (let i = 0; i < 6; i++) cycleLandmark(false, doc)
  assert.deepEqual(focused, ['top bar', 'media', 'viewer', 'timeline', 'assistant', 'top bar'], 'hidden regions are skipped and the walk wraps')
  assert.equal(regions[3].attrs.tabindex, '-1', 'a region with nothing to focus takes focus itself')
  cycleLandmark(true, doc); cycleLandmark(true, doc)
  assert.deepEqual(focused.slice(-2), ['assistant', 'timeline'])
  // The Edit page names its regions in that order, and the key works from a field.
  const order = ['class="topbar" role="banner" aria-label="Top bar"', "'Media browser' : 'Inspector'", 'role="region" aria-label="Viewer"', "aria-label=${phone ? undefined : 'Timeline'}"].map(part => app.indexOf(part))
  assert.ok(order.every(at => at > 0), String(order))
  assert.match(keys, /if \(e\.key !== 'F6' \|\| e\.defaultPrevented[^\n]*\) return\n    e\.preventDefault\(\); cycleLandmark\(e\.shiftKey\)\n  \}, true\)/, 'on capture, so a field that stops its own keys still lets F6 through')
  assert.match(keys, /globalThis\.document\?\.addEventListener\?\.\('keydown', e => \{\n    if \(e\.key !== 'F6'/)
  assert.match(keys, /\['F6 \/ ⇧F6', 'Next \/ previous panel'\]/)
})

test('phone panels use 44px targets, whole-label checkboxes and 16px field text', () => {
  const phone = read('ui/phone.css')
  const block = phone.slice(phone.indexOf('/* Phone widths: every field and button in a panel is a 44px target'))
  assert.match(block, /@media \(max-width: 720px\) \{\s*\.page :is\(\.inspector, \.browser, \.field\) :is\(select, textarea, input:not\(\[type=checkbox\], \[type=radio\], \[type=range\], \[type=color\]\)\) \{ min-height: 44px; font-size: 16px; \}/)
  assert.match(block, /\.page :is\(\.inspector, \.browser\) button \{ min-height: 44px; min-width: 44px; \}/)
  assert.match(block, /label:has\(> input:is\(\[type=checkbox\], \[type=radio\]\)\) \{ display: inline-flex; align-items: center; gap: 8px; min-height: 44px; \}/)
  // Outside the panels too. This reads the rule; the heights were measured in a browser at 390px.
  const outside = block.match(/\.page :is\(([^)]*)\) :is\(button, select, summary, input:not\(\[type=checkbox\], \[type=radio\], \[type=range\], \[type=color\]\)\) \{ min-height: 44px; \}/)
  assert.ok(outside, 'one rule for the controls outside the panels')
  for (const place of ['.viewer-bar', '.audio-tools', '.mixer .strip', '.phone-switch', '.deliver-settings', '.deliver-queue', '.deliver-viewer-tools', '.transcript-panel', '.th-add', '.tl-toolbar']) assert.ok(outside[1].split(', ').includes(place), place)
})

test('panel headings share one sentence-case style', () => {
  assert.match(styles, /\nh3, \.panel-heading \{ margin: 4px 0 10px; font-size: var\(--text-body\); font-weight: 600; letter-spacing: 0; color: var\(--text\); \}/)
  for (const css of [styles, assistantCSS, read('ui/phone.css')]) assert.doesNotMatch(css, /text-transform:\s*uppercase/)
  for (const file of ['ui/deliver.js', 'ui/media-page.js', 'ui/browser.js']) for (const [, heading] of read(file).matchAll(/<h3[^>]*>([A-Za-z][^<$]*)<\/h3>/g)) assert.match(heading, /^[A-Z][^A-Z]*$|^[A-Z][a-z]+ [a-z]/, `${file}: ${heading}`)
})

test('dialogs share one shell, and Captions from a transcript leads with the task', () => {
  assert.match(styles, /\.modal > header :is\(h2, h3\), \.modal > :is\(h2, h3\):first-child, \.settings-head h2, \.assistant-sharing-dialog > h2 \{ margin: 0; font-size: var\(--text-dialog\); font-weight: 600;/)
  assert.match(styles, /\.dialog-subtitle, \.settings-head p \{ margin: 3px 0 0; font-size: var\(--text-label\); color: var\(--muted\); \}/)
  assert.match(styles, /\.modal \{ max-height: min\(80vh, calc\(100dvh - 32px\)\); overflow-y: auto; \}/)
  const captions = read('ui/plugins/captions.js')
  assert.match(captions, /<div class="modal cap-dialog" role="dialog" aria-modal="true" aria-labelledby="cap-transcript-title"/)
  assert.match(captions, /<h3 id="cap-transcript-title">Captions from a transcript<\/h3><p class="dialog-subtitle">Pick a clip and a style, then preview the captions before they are added\.<\/p>/)
  // A missing transcriber is a neutral note with one command to copy and a link, not a stack of warnings.
  assert.match(captions, /<div class="cap-note" role="note">/); assert.match(captions, /<code>\$\{setup\.commands\[0\]\}<\/code><button type="button" class="ghost tiny"[^\n]*>Copy<\/button>/)
  assert.match(captions, /<a href="https:\/\/editwitharya\.app\/install\/" target="_blank" rel="noopener noreferrer">How to install<\/a>/)
  assert.doesNotMatch(captions, /Run in Terminal/)
  assert.match(captions, /<button class="primary" disabled=\$\{busy \|\| !src\} title=\$\{!src \? 'Put a clip with sound on the timeline first' : undefined\}/)
  assert.match(captions, /Only the selected clip<\/label>/); assert.doesNotMatch(captions, /Only selected clip \$\{selected\.id\}/)
})

test('the hosted media panel says where Create music works instead of showing a disabled button', () => {
  const browser = read('ui/browser.js')
  assert.match(browser, /host\.kind === 'browser-local' \? html`<p class="muted small hosted-note">Create music is available in Arya for Mac\.<\/p>` : html`<button type="button" class="ghost"[^\n]*>Create music…<\/button>`/)
  assert.doesNotMatch(browser, /Music generation (?:requires|needs)/, 'said once, in one line')
})

test('the hosted project picker has one primary, Create project, and ghost backup actions', () => {
  const picker = read('browser-local/workspace.js')
  assert.equal(picker.match(/class="primary"/g).length, 1)
  assert.match(picker, /<button type="submit" class="primary" disabled=\$\{blocked\}>Create project<\/button>/)
  assert.match(picker, /<button class="ghost" disabled=\$\{blocked \|\| !state\.project\}[^\n]*>Download project and media backup<\/button>/)
  assert.match(picker, /<h2 id="browser-project-title">Your browser projects<\/h2><p class="dialog-subtitle">Saved on this device, not uploaded\.<\/p>/)
})

test('the Color page names the clip, with its id in a tooltip', async () => {
  const { shownClipName, clipIdTitle } = await import('../web/ui/clip-name.js')
  const project = { assets: {}, comps: { k1: { name: 'Lower third' } } }
  assert.equal(shownClipName(project, { id: 'c5', kind: 'title', title: { text: 'Meet the team\nSeason two' } }), 'Meet the team', 'the first line of a title')
  assert.equal(shownClipName(project, { id: 'c1', kind: 'video', src: 'media/interview-wide.mp4' }), 'interview-wide.mp4')
  assert.equal(shownClipName(project, { id: 'c2', kind: 'video', src: 'media/a.mp4', label: 'Opening' }), 'Opening')
  assert.equal(shownClipName(project, { id: 'c3', kind: 'comp', comp: 'k1' }), 'Lower third')
  assert.equal(shownClipName(null, { id: 'c4', kind: 'adjustment' }), 'Adjustment layer')
  assert.equal(clipIdTitle({ id: 'c6' }), 'Clip id c6')
  const color = read('ui/color.js'), editor = read('ui/color/node-editor.js'), workflow = read('ui/color/workflow-panel.js')
  assert.match(color, /<b title=\$\{clipIdTitle\(clip\)\}>\$\{shownClipName\(viewProject\(\), clip\)\}<\/b>/)
  assert.match(editor, /<span class="muted" title=\$\{clipIdTitle\(clip\)\}>\$\{shownClipName\(viewProject\(\), clip\)\}/)
  // No Color header or hint prints the stored id as its text.
  for (const [name, source] of [['color.js', color], ['node-editor.js', editor], ['workflow-panel.js', workflow]]) assert.doesNotMatch(source, />\$\{clip\.id\}|`\$\{clip\.id\} · /, name)
})

test('a dialog keeps Tab inside it, takes focus back from outside and closes on Escape', async () => {
  const { dialogControls, dialogKey } = await import('../web/ui/dialog-focus.js')
  const control = (name, { disabled = false, shown = true } = {}) => ({ name, matches: () => disabled, getClientRects: () => shown ? [{}] : [], focus() { doc.activeElement = this } })
  const first = control('Media'), hidden = control('Hidden', { shown: false }), off = control('Off', { disabled: true }), last = control('Preview captions')
  const element = { querySelectorAll: () => [first, hidden, off, last], contains: node => [first, hidden, off, last].includes(node), focus() { doc.activeElement = element } }
  const doc = { activeElement: null }
  const press = (key, shiftKey = false) => { const event = { key, shiftKey, prevented: false, preventDefault() { this.prevented = true }, stopPropagation() {} }; return [dialogKey(event, element, () => { closed++ }, doc), event.prevented] }
  let closed = 0
  assert.deepEqual(dialogControls(element), [first, last], 'hidden and disabled controls are skipped')
  doc.activeElement = { name: 'page behind' }
  assert.deepEqual(press('Tab'), [true, true]); assert.equal(doc.activeElement, first, 'Tab from outside lands on the first control')
  doc.activeElement = last; press('Tab'); assert.equal(doc.activeElement, first, 'Tab wraps from the last control')
  press('Tab', true); assert.equal(doc.activeElement, last, 'Shift+Tab wraps from the first control')
  doc.activeElement = first; assert.deepEqual(press('Tab'), [false, false], 'between controls the browser moves focus')
  assert.deepEqual(press('a'), [false, false])
  assert.deepEqual(press('Escape'), [true, true]); assert.equal(closed, 1)
  assert.equal(dialogKey({ key: 'Escape' }, null, () => { closed++ }, doc), false); assert.equal(closed, 1)
  const captions = read('ui/plugins/captions.js')
  assert.match(captions, /if \(element\) \(dialogControls\(element\)\[0\] \?\? element\)\.focus\(\)/, 'focus moves into the dialog when it opens')
  assert.match(captions, /doc\.addEventListener\('keydown', key, true\)/)
  assert.match(captions, /if \(opener\?\.isConnected\) opener\.focus\?\.\(\)/, 'and returns to what opened it')
})
