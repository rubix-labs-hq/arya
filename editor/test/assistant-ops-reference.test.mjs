import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { applyOps, newProject, OPS_DOC } from '../core/project.js'
import { captionTitle } from '../core/caption-render.js'
import { framePlan, resolveTracks } from '../core/render-plan.js'
import { describeFocus } from '../core/describe.js'
import { CAPTION_STYLE_KEYS } from '../core/edit-notes.js'

// Each sentence the operation reference gained is checked here against what the edit model and
// the shared render plan do, so the reference cannot drift from the behaviour it describes.
const source = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const line = start => OPS_DOC.split('\n').find(text => text.startsWith(start))

test('the reference states title units and the frame width they give', () => {
  const titles = line('- add_title')
  assert.match(titles, /title\.size is in 1080-high units, so the frame is width\*1080\/height units wide \(607 on 1080x1920\)/)
  // The renderer scales title units by frame height over 1080, on both renderers' shared plan.
  assert.match(source('web/engine/frame.js'), /const scale = \(view\.height \/ 1080\) \* rs/)
  assert.equal(Math.floor(1080 * 1080 / 1920), 607)
})

test('the reference names the box a title needs to wrap, in the shape the renderer reads', () => {
  const titles = line('- add_title')
  assert.match(titles, /a title breaks only at \\n unless title\.box \{width, height, wrap:true, autoHeight:true\} is set, in the same units/)
  // drawTitle multiplies box.height, so a box without height has no height to draw in.
  const draw = source('web/engine/media.js')
  assert.match(draw, /box\?\.wrap \? wrapTitleLines\(ctx, value, boxWidth\) : value\.split\('\\n'\)/)
  assert.match(draw, /Math\.max\(1, box\.height \* scale, box\.autoHeight \? fullLines \* lineH : 0\)/)
  // Captions use the same box, which is how they stay inside the frame.
  const box = captionTitle({ text: 'x'.repeat(80) }, { size: 52 }, 0, { width: 1080, height: 1920 }).box
  for (const key of ['width', 'height', 'wrap', 'autoHeight']) assert.ok(Object.hasOwn(box, key), key)
  assert.equal(Math.round(box.width), Math.round(607.5 * 0.9))
})

test('the reference says a track shows one clip at a time, and omitting track gives a free one', () => {
  assert.match(line('- add_title'), /A track shows one clip at a time: omit track and the title gets a free track\./)
  const named = applyOps(newProject('Named'), [0, 1].map(start => ({ op: 'add_title', text: `T${start}`, track: 'V2', start, dur: 3 }))).project
  const shown = resolveTracks(named, 1.5).filter(entry => entry.track.id === 'V2')
  assert.equal(shown.length, 1); assert.equal(shown[0].c.title.text, 'T0')
  const free = applyOps(newProject('Free'), [0, 1].map(start => ({ op: 'add_title', text: `T${start}`, start, dur: 3 }))).project
  assert.equal(resolveTracks(free, 1.5).filter(entry => entry.c?.kind === 'title').length, 2)
})

test('the reference says what speed changes and how to hit a length instead', () => {
  const speed = line('- speed')
  assert.match(speed, /speed plays picture and sound faster or slower; to hit a target length, trim or cut unless the user asked for a speed change/)
  assert.match(speed, /a slower clip pushes later clips/, 'the ripple rule stays')
})

test('the reference documents caption word timings and what a cut does with and without them', () => {
  const captions = line('- add_caption')
  assert.match(captions, /captions \{items:\[\{t, end, text, words\?:\[\{t,end,text\}\]\}\], track\?, replace\?, style\?, burnIn\?\}/)
  assert.match(captions, /words are timeline seconds/)
  assert.match(captions, /Use captions for subtitles, not titles/)
  assert.match(captions, /caption tracks draw when burnIn is true/)
  const words = [{ t: 9, end: 9.5, text: 'saved' }, { t: 9.5, end: 10, text: 'for' }, { t: 10, end: 11, text: 'later.' }]
  const p = applyOps(newProject('Words'), [{ op: 'captions', items: [{ t: 9, end: 11, text: 'saved for later.', words }], style: { size: 60 }, burnIn: true }, { op: 'add_title', text: 'saved for later.', track: 'V3', start: 9, dur: 2 }]).project
  const track = p.tracks.find(item => item.kind === 'caption')
  assert.deepEqual([track.style.size, track.burnIn, track.clips[0].words[2].t], [60, true, 1], 'style and burnIn are accepted, and words are stored clip-local')
  const cut = applyOps(p, [{ op: 'delete_range', from: 10, to: 11 }]).project
  assert.equal(cut.tracks.find(item => item.kind === 'caption').clips[0].text, 'saved for')
  assert.equal(cut.tracks.find(item => item.id === 'V3').clips[0].title.text, 'saved for later.', 'a title keeps its text')
})

test('the reference lists the caption style keys the renderer reads, with the right highlight key', () => {
  const tracks = line('- add_track')
  assert.match(tracks, /update_track \{id, set:\{name,muted,hidden,locked,solo,volume,pan,fx\}\}/, 'the pinned prefix stays')
  assert.match(tracks, /highlightColor \(preset karaoke only\)/)
  assert.match(tracks, /preset \(word: one word at a time; karaoke: the spoken word in highlightColor; both need word timings\)/)
  assert.match(tracks, /Other style keys draw nothing\./)
  assert.doesNotMatch(tracks, /highlight[,}]/)
  for (const key of CAPTION_STYLE_KEYS) assert.match(tracks, new RegExp(`\\b${key}\\b`), key)
  // The keys are the ones caption-render.js and the frame renderer read, and no others.
  const reader = source('core/caption-render.js')
  for (const key of CAPTION_STYLE_KEYS.filter(key => key !== 'y')) assert.match(reader, new RegExp(`style\\.${key}\\b`), key)
  assert.deepEqual([...new Set([...reader.matchAll(/style\.([a-zA-Z]+)/g)].map(match => match[1]))].filter(key => !CAPTION_STYLE_KEYS.includes(key)), [])
  assert.match(source('web/engine/frame.js'), /st\.y \?\? 0\.88/)
  const clip = { text: 'one two', words: [{ t: 0, end: 1, text: 'one' }, { t: 1, end: 2, text: 'two' }] }
  const canvas = { width: 1920, height: 1080 }
  assert.equal(captionTitle(clip, { preset: 'karaoke', highlightColor: '#00ff00' }, 0.5, canvas).highlight.color, '#00ff00')
  assert.equal(captionTitle(clip, { preset: 'karaoke', highlight: '#00ff00' }, 0.5, canvas).highlight.color, '#ffe600', 'style.highlight is not read')
  assert.equal(captionTitle(clip, { preset: 'word', highlightColor: '#00ff00' }, 0.5, canvas).highlight, undefined, 'the word preset draws no highlight')
  assert.equal(captionTitle(clip, { preset: 'word' }, 1.5, canvas).text, 'two')
  // maxLines reserves height under a preset; the box still grows, so it is not a limit.
  const tall = captionTitle(clip, { preset: 'boxed', maxLines: 3, size: 50, lineHeight: 1 }, 0, canvas).box
  assert.deepEqual([tall.height, tall.autoHeight], [150, true])
  assert.match(tracks, /maxLines \(lines of height reserved under a preset, not a limit\)/)
  assert.match(tracks, /Captions wrap inside 90% of the frame width on their own/)
  const wrapped = framePlan(applyOps(newProject('Tall', { width: 1080, height: 1920 }), [{ op: 'captions', burnIn: true, items: [{ t: 0, end: 2, text: 'a caption far too long to sit on one line of a vertical frame' }] }]).project, 1).captions[0].title.box
  assert.equal(wrapped.wrap, true); assert.equal(Math.round(wrapped.width), 547)
})

test('a track update logs each changed setting with its old and new value', () => {
  const p = applyOps(newProject('Log'), [{ op: 'captions', items: [{ t: 0, end: 1, text: 'one' }] }]).project
  const styled = applyOps(p, [{ op: 'update_track', id: 'C1', set: { burnIn: true, style: { size: 104, plate: 'transparent', fit: 'shrink', color: null } } }])
  assert.deepEqual(styled.log, ['updated track C1: burnIn false to true, style.size 52 to 104, style.plate #000000aa to transparent, style.fit set to shrink, style.color removed'])
  const mixed = applyOps(p, [{ op: 'update_track', id: 'A1', set: { volume: -3, muted: true, name: 'Voice', fx: [{ type: 'gain', enabled: true, params: { gain: 2 } }] } }])
  assert.deepEqual(mixed.log, ['updated track A1: volume 0 to -3, muted set to true, name Audio 1 to Voice, fx'])
  assert.deepEqual(applyOps(p, [{ op: 'update_track', id: 'A1', set: { volume: 0 } }]).log, ['updated track A1: volume (unchanged)'])
  const many = applyOps(p, [{ op: 'update_track', id: 'C1', set: { style: Object.fromEntries('abcdefghijkl'.split('').map(key => [key, 1])) } }])
  assert.match(many.log[0], /^updated track C1: style\.a set to 1, .*style\.h set to 1 and 4 more$/)
  // The native status line reads this prefix.
  assert.match(styled.log[0], /^updated track (\S+): (.*)$/)
})

test('a described title or caption gives its size as a number in title units, not pixels', () => {
  let p = applyOps(newProject('Describe', { width: 1080, height: 1920 }), [{ op: 'add_title', text: 'Meet Dana', title: { size: 96 } }, { op: 'captions', items: [{ t: 0, end: 2, text: 'Hello there' }] }]).project
  p = applyOps(p, [{ op: 'update_track', id: 'C1', set: { burnIn: true, style: { font: 'Inter', size: 48, highlightColor: '#00ff00', preset: 'karaoke' } } }]).project
  const text = describeFocus(p, { selection: ['c1'] })
  assert.match(text, /Title: "Meet Dana"; .*size 96,/)
  assert.doesNotMatch(text, /96 px/)
  assert.match(text, /C1 Captions \(caption\): burned in, style Inter, size 48, #ffffff, preset karaoke, highlight #00ff00, plate #000000aa, at 88% height/)
})
