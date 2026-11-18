import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { messageHTML, shortenPaths } from '../web/ui/message-text.js'
import { assistantPanel } from '../web/ui/assistant-panel.js'

const root = '/Users/sample/Sample Projects/Demo Reel'

test('reply text is escaped before any markup is added', () => {
  const html = messageHTML('<img src=x onerror=alert(1)> & "quoted" <script>bad()</script>')
  assert.doesNotMatch(html, /<img|<script/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quoted&quot;/)
  assert.equal(messageHTML('Line one\nLine **two** and `a<b`'), 'Line one<br>Line <b>two</b> and <code>a&lt;b</code>')
})

test('only https links become anchors, and a label cannot carry markup', () => {
  const html = messageHTML('Read [the guide](https://example.com/guide?a=1&b=2) first.')
  assert.equal(html, 'Read <a href="https://example.com/guide?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">the guide</a> first.')
  for (const target of ['javascript:alert(1)', 'http://example.com', 'data:text/html,hi', '/Users/sample/notes.txt']) {
    const unsafe = messageHTML(`Open [this one](${target}) now`)
    assert.doesNotMatch(unsafe, /<a /, target)
    assert.match(unsafe, /this one/)
  }
  assert.doesNotMatch(messageHTML('[<b onclick=x>hi</b>](https://example.com)'), /<b onclick/)
  assert.equal(messageHTML('See https://example.com/a.'), 'See <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a>.')
  assert.doesNotMatch(messageHTML('https://example.com/"onmouseover="x'), /href="[^"]*"onmouseover/)
})

test('a local path never shows whole: inside the project it is relative, outside it is the file name', () => {
  assert.equal(shortenPaths(`Saved ${root}/renders/cut one.mp4.`, root), 'Saved renders/cut one.mp4.')
  assert.equal(shortenPaths(`Opened ${root}.`, root), 'Opened the project folder.')
  assert.equal(shortenPaths(`${root} 2/other.mp4`, root).includes('/Users/'), false)
  assert.equal(shortenPaths('Wrote /Users/sample/Desktop/notes.txt, done', root), 'Wrote notes.txt, done')
  assert.equal(shortenPaths('From ~/Movies/sample/take.mov', root), 'From take.mov')
  assert.equal(shortenPaths('Temp at /private/tmp/sample/x.wav;', root), 'Temp at x.wav;')
  assert.equal(shortenPaths(`file://${encodeURI(root)}/renders/a%20b.mp4`, root), 'renders/a b.mp4')
  assert.equal(shortenPaths('Plain 1/2 and and/or stay', root), 'Plain 1/2 and and/or stay')
  const html = messageHTML(`Saved \`${root}/renders/cut.mp4\` and **/Volumes/Sample/clip.mov**`, { root })
  assert.equal(html, 'Saved <code>renders/cut.mp4</code> and <b>clip.mov</b>')
  assert.doesNotMatch(messageHTML(`[the render](${root}/renders/cut.mp4)`, { root }), /Users|<a /)
})

test('a simple pipe table and lists render, with blank lines around them dropped', () => {
  const html = messageHTML('Shots:\n\n| Shot | Length |\n|---|--:|\n| One | **1.5s** |\n| Two |\n\n- first\n- second\n\n1. alpha\n2. beta\nDone')
  assert.equal(html, 'Shots:<div class="msg-table"><table><thead><tr><th>Shot</th><th>Length</th></tr></thead>'
    + '<tbody><tr><td>One</td><td><b>1.5s</b></td></tr><tr><td>Two</td><td></td></tr></tbody></table></div>'
    + '<ul><li>first</li><li>second</li></ul><ol><li>alpha</li><li>beta</li></ol>Done')
  assert.doesNotMatch(messageHTML('| <i>x</i> |\n|---|\n| <u>y</u> |'), /<i>|<u>/)
  assert.equal(messageHTML('1. alpha\n\n2. beta\nmore about beta\n3. gamma'),
    '<ol><li>alpha</li></ol><ol start="2"><li>beta</li></ol>more about beta<ol start="3"><li>gamma</li></ol>')
})

test('half a streamed table or link stays text and never throws', () => {
  const full = 'Intro [a link](https://example.com/x) and `code`\n| A | B |\n|---|---|\n| 1 | 2 |\n- item'
  for (let end = 0; end <= full.length; end++) assert.equal(typeof messageHTML(full.slice(0, end), { root }), 'string')
  assert.equal(messageHTML('| A | B'), '| A | B')
  assert.equal(messageHTML(undefined), '')
  assert.equal(messageHTML('a\u0000b'), 'ab')
  const long = `${'| x '.repeat(4000)}|\n${'[y](z '.repeat(4000)}`
  const started = performance.now()
  messageHTML(long, { root })
  assert.ok(performance.now() - started < 1000)
})

const link = href => `<a href="${href}" target="_blank" rel="noopener noreferrer">`

test('a link label may be a code span or bold, and no internal marker ever reaches the page', () => {
  assert.equal(messageHTML('See [`notes.md`](https://example.com/notes) and [`out.mp4`](/Users/sample/proj/renders/out.mp4)', { root: '/Users/sample/proj' }),
    `See ${link('https://example.com/notes')}<code>notes.md</code></a> and <code>out.mp4</code>`)
  assert.equal(messageHTML('[**Read** this](https://example.com)'), `${link('https://example.com')}<b>Read</b> this</a>`)
  const cases = ['[`a`](https://example.com/`b`)', 'https://example.com/`c`', '**https://example.com/a**', '[`x` and `y`](https://example.com)',
    'Intro [`a link`](https://example.com/x) and `code` **bold https://example.com/y**']
  for (const text of cases) for (let end = 0; end <= text.length; end++) {
    const html = messageHTML(text.slice(0, end))
    assert.doesNotMatch(html, /\u0000/, text.slice(0, end))
    assert.doesNotMatch(html, /href="[^"]*[<*`]/, text.slice(0, end))
  }
})

test('a bare address leaves out bold marks and an unopened bracket, and keeps one it opened', () => {
  assert.equal(messageHTML('**https://example.com/a**'), `<b>${link('https://example.com/a')}https://example.com/a</a></b>`)
  assert.equal(messageHTML('https://example.com/path_(x)'), `${link('https://example.com/path_(x)')}https://example.com/path_(x)</a>`)
  assert.equal(messageHTML('(see https://example.com/a).'), `(see ${link('https://example.com/a')}https://example.com/a</a>).`)
})

test('a local path after a comma, semicolon or dash is shortened, while web addresses and relative paths stay', () => {
  assert.equal(shortenPaths('Saved to folder,/Users/sample/secret/a.mov'), 'Saved to folder,a.mov')
  assert.equal(shortenPaths('one;/tmp/sample/b.wav and two-~/Movies/c.mov'), 'one;b.wav and two-c.mov')
  for (const text of ['http://example.com/Users/a/b', 'docs/tmp/a.txt', 'see ./Users/x/y.txt']) assert.equal(shortenPaths(text), text)
})

test('the chat renders reply text through the safe renderer with the project folder', () => {
  assert.equal(assistantPanel.messageHTML, messageHTML)
  const chat = readFileSync(new URL('../web/ui/chat.js', import.meta.url), 'utf8')
  assert.match(chat, /assistantPanel\.messageHTML\(text, \{ root: store\.root \}\)/)
  // The hosted editor ships each UI module from this list.
  const files = JSON.parse(readFileSync(new URL('../browser-public-files.json', import.meta.url), 'utf8'))
  assert.ok(files.some(row => row.source === 'web/ui/message-text.js' && row.target === 'editor/ui/message-text.js'))
})
