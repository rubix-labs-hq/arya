import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'

const media = fs.readFileSync(new URL('../web/ui/media-page.js', import.meta.url), 'utf8')
const transcript = fs.readFileSync(new URL('../web/ui/transcript.js', import.meta.url), 'utf8')

test('Details with nothing selected says what to click', () => {
  const body = media.slice(media.indexOf('function Details()'), media.indexOf('export function MediaPage'))
  const Details = new Function('html', 'useStore', 'timecode', 'analyzeMenu', `${body}\nreturn Details`)(htm.bind(h), () => ({ source: null, project: { assets: {} }, caps: {} }), () => '', () => [])
  const tree = Details()
  assert.equal(tree.props.class, 'empty-hint')
  assert.equal(tree.props.children, 'Click a clip in the media list to see its format, codec and audio.')
})

test('an empty transcript shows one next step, and the import details sit in the disclosure', () => {
  const editor = transcript.slice(transcript.indexOf('<section class="tr-editor"'))
  const next = editor.match(/<div class="tr-status tr-next">\$\{([^\n]*)\}<\/div>/)[1]
  for (const line of ['Import media with audio to transcribe it.', 'Press Transcribe to search, correct and caption this source.', 'Install whisper.cpp and a model to transcribe, or import a transcript file above.']) {
    assert.ok(next.includes(`'${line}'`), line)
    assert.ok(line.split(' ').length <= 14, `${line} stays one short line`)
  }
  const disclosure = editor.slice(editor.indexOf('<details>'), editor.indexOf('</details>'))
  assert.match(disclosure, /SRT and WebVTT imports estimate word times/)
  assert.equal(editor.split('SRT and WebVTT imports estimate word times').length, 3, 'once in the disclosure and once as the import tooltip')
  assert.doesNotMatch(editor, /Transcribe the source or import a timed transcript to search it/)
})
