import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

// Colour emoji ignore the theme and the interface icon set. The Assistant panel (chat.js) is
// owned elsewhere and is not checked here.
const EMOJI = /[\u{1F300}-\u{1FAFF}]/u
const files = ['inspector.js', 'color.js', 'browser.js', 'timeline.js', 'store.js', 'viewer.js', 'plugins/captions.js', 'mixer.js', 'deliver.js', 'media-page.js', 'motion/page.js', 'motion/layers.js', 'plugins/audio-fx.js']

test('editor interface files draw icons instead of colour emoji', () => {
  for (const file of files) {
    const lines = fs.readFileSync(new URL(`../web/ui/${file}`, import.meta.url), 'utf8').split('\n')
    const found = lines.map((line, i) => [i + 1, line.match(EMOJI)?.[0]]).filter(([, hit]) => hit)
    assert.deepEqual(found, [], `${file} has emoji at ${found.map(([n, hit]) => `${n} ${hit}`).join(', ')}`)
  }
})

test('the inspector and Color reference buttons use the attach icon with a name', () => {
  const inspector = fs.readFileSync(new URL('../web/ui/inspector.js', import.meta.url), 'utf8')
  assert.match(inspector, /aria-label="Reference this clip to the Assistant"[^\n]*><\$\{Icon\} name="attach" \/><\/button>/)
  const color = fs.readFileSync(new URL('../web/ui/color.js', import.meta.url), 'utf8')
  assert.match(color, /<\$\{Icon\} name="attach" size=\$\{14\} \/>Reference to Assistant<\/button>/)
})

test('media placeholders and file rows use drawn outlines', () => {
  const browser = fs.readFileSync(new URL('../web/ui/browser.js', import.meta.url), 'utf8')
  assert.match(browser, /const MEDIA_ICON = \{ video: 'video', audio: 'audio', image: 'image' \}/)
  const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8')
  for (const name of ['media-kind-video', 'media-kind-image', 'media-kind-audio', 'file-kind.dir', 'file-kind.file']) assert.match(css, new RegExp(`\\.${name.replace('.', '\\.')} \\{ --glyph: url\\("data:image/svg\\+xml,`))
})
