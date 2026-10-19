// node --test editor/test
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CAPTION_ROLE, captionItems, fileURL, fromFCPXML, fromOTIO, parseSRT, parseTime, parseVTT, parseXML, rateOf, toFCPXML, toOTIO, toSRT, toVTT,
  transcriptToCaptions, wordsToCaptions,
} from '../core/interchange.js'
import { applyOps, newProject } from '../core/project.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'fixtures')
const ROOT = '/arya-test/Mod Systems/Launch film'
const FCP_DTD = '/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_11.dtd'

const ASSETS = {
  'media/a.mp4': { duration: 20, width: 1920, height: 1080, fps: 29.97, codec: 'h264', hasVideo: true, hasAudio: true, channels: 2 },
  'media/b roll.mov': { duration: 15, width: 3840, height: 2160, fps: 25, codec: 'prores', hasVideo: true, hasAudio: true, channels: 2, proxy: '.reel/proxies/x.mp4' },
  'media/music.wav': { duration: 60, codec: 'pcm_s16le', hasVideo: false, hasAudio: true, channels: 2 },
  'media/still.png': { width: 800, height: 600, codec: 'png', hasVideo: true, hasAudio: false, still: true },
  '/Volumes/Archive/old.mov': { duration: 30, width: 1920, height: 1080, fps: 23.976, codec: 'h264', hasVideo: true, hasAudio: false },
}

/** A project with gaps, connected clips, a title, a transition, markers, speed changes and captions. */
function sample(fps) {
  let p = applyOps(newProject('Launch film', { fps }), [{ op: 'import', assets: structuredClone(ASSETS) }]).project
  p = applyOps(p, [
    { op: 'add_clip', src: 'media/a.mp4', track: 'V1', start: 0, in: 2, dur: 4 },
    { op: 'add_clip', src: 'media/b roll.mov', track: 'V1', start: 5, in: 1, dur: 3 },
    { op: 'add_clip', src: 'media/a.mp4', track: 'V1', start: 8, in: 10, dur: 2 },
    { op: 'add_clip', src: 'media/b roll.mov', track: 'V1', start: 10, in: 6, dur: 4 },
    { op: 'add_clip', src: '/Volumes/Archive/old.mov', track: 'V1', start: 12, in: 3, dur: 2 },
    { op: 'add_clip', src: 'media/still.png', track: 'V2', start: 1, dur: 2, set: { opacity: 0.5, scale: 1.2 } },
    { op: 'add_color', track: 'V2', start: 6, dur: 1, color: '#336699' },
    { op: 'add_clip', src: 'media/a.mp4', track: 'V2', start: 8.5, in: 4, dur: 1.5, audio: false },
    { op: 'add_title', track: 'V3', start: 2, dur: 3, text: 'Hello & <World>\n"quoted"', title: { font: 'Futura', weight: 900, color: '#f5b942' } },
    { op: 'add_shape', track: 'V3', start: 6, dur: 2, shape: { type: 'star' } },
    { op: 'add_clip', src: 'media/music.wav', track: 'A3', start: 0, dur: 12, set: { volume: -6, fadeIn: 1 } },
    { op: 'captions', items: [{ t: 0.5, end: 2, text: 'First caption' }, { t: 2.5, end: 4, text: 'Second, two\nlines' }, { t: 9, end: 11, text: 'Third & last' }] },
    { op: 'marker', t: 1.5, label: 'beat', color: '#58a6ff' },
    { op: 'marker', t: 9, label: 'Chapter 2', kind: 'chapter' },
    { op: 'marker', t: 11, label: 'fix this', kind: 'todo', note: 'too long' },
    { op: 'range', in: 1, out: 9 },
  ]).project
  const v1 = p.tracks.find(t => t.id === 'V1').clips
  const v2 = p.tracks.find(t => t.id === 'V2').clips

  return applyOps(p, [
    { op: 'transition', id: v1[2].id, type: 'crossDissolve', dur: 1 },
    { op: 'speed', id: v1[3].id, speed: 2 },
    { op: 'speed', id: v2[2].id, speed: 0.5, reverse: true },
    { op: 'update', id: v1[0].id, set: { grade: { exposure: 0.3 }, label: 'Opening', note: 'keep the breath' } },
    { op: 'keyframe', id: v1[1].id, prop: 'opacity', at: 5, value: 0 },
    { op: 'keyframe', id: v1[1].id, prop: 'opacity', at: 6, value: 1 },
    { op: 'update_track', id: 'C1', set: { burnIn: true, style: { size: 60 } } },
  ]).project
}

/** A project with every time as whole frames, so files can be compared to the frame. */
function frames(p) {
  const f = t => Math.round(t * p.fps)
  const clip = c => {
    const out = structuredClone(c)
    out.start = f(c.start)
    out.dur = f(c.dur)
    if (c.in !== undefined) out.in = f(c.in)
    if (c.freeze !== undefined) out.freeze = f(c.freeze)
    if (c.transitionIn) out.transitionIn = { ...c.transitionIn, dur: f(c.transitionIn.dur) }

    return out
  }

  // Through JSON, as the project file is stored: keys holding undefined are the same as absent.
  return JSON.parse(JSON.stringify({ ...p, tracks: p.tracks.map(t => ({ ...t, clips: t.clips.map(clip) })), markers: p.markers.map(m => ({ ...m, t: f(m.t) })) }))
}

/** What a format can carry on its own: per non-empty track, each clip's kind, source and frames. */
function structure(p, keep = () => true, rename = c => c.kind) {
  const f = t => Math.round(t * p.fps)

  return p.tracks
    .map(t => [t.kind, [...t.clips].filter(keep).sort((a, b) => a.start - b.start).map(c => [
      rename(c), c.src ?? c.title?.text ?? c.text ?? '', f(c.start), f(c.dur), c.in !== undefined ? f(c.in) : '-', c.speed ?? 1, c.reverse ? 'rev' : '', c.transitionIn ? `tr${f(c.transitionIn.dur)}` : '',
    ].join('/'))])
    .filter(([, clips]) => clips.length)
}

/** Validates FCPXML: against Final Cut Pro's own DTD when it is installed, else for well-formedness. */
function validateFCPXML(xml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-fcpxml-'))
  const file = path.join(dir, 'out.fcpxml')
  fs.writeFileSync(file, xml)
  try {
    if (fs.existsSync(FCP_DTD)) {
      // Resolve the copied DTD by filename because the temporary folder can contain spaces.
      fs.copyFileSync(FCP_DTD, path.join(dir, 'fcpxml.dtd'))
      execFileSync('xmllint', ['--noout', '--dtdvalid', 'fcpxml.dtd', file], { cwd: dir, stdio: 'pipe' })

      return 'dtd'
    }
    try {
      execFileSync('xmllint', ['--noout', file], { stdio: 'pipe' })

      return 'well-formed'
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      parseXML(xml)

      return 'parsed'
    }
  } catch (error) {
    throw new Error(`invalid FCPXML: ${String(error.stderr ?? error.message).slice(0, 2000)}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- time and XML basics

test('frame rates map to FCPXML frame durations', () => {
  assert.deepEqual(rateOf(29.97), { num: 1001, den: 30000 })
  assert.deepEqual(rateOf(23.976), { num: 1001, den: 24000 })
  assert.deepEqual(rateOf(59.94), { num: 1001, den: 60000 })
  assert.deepEqual(rateOf(25), { num: 100, den: 2500 })
  assert.deepEqual(rateOf(30), { num: 100, den: 3000 })
  assert.equal(parseTime('1001/30000s'), 1001 / 30000)
  assert.equal(parseTime('5s'), 5)
  assert.equal(parseTime('86486400/24000s'), 3603.6)
  assert.equal(parseTime('nonsense'), undefined)
})

test('XML parser: entities, CDATA, comments, DOCTYPE subsets and mismatched tags', () => {
  const doc = parseXML('﻿<?xml version="1.0"?><!DOCTYPE x [ <!ENTITY a "b"> ]><!-- c --><x a=\'1 &amp; 2\' b="&#10;&#x41;"><y>t &lt;3 <![CDATA[<raw>]]></y><z/></x>')
  const x = doc.children.find(n => n.name === 'x')
  assert.equal(x.attrs.a, '1 & 2')
  assert.equal(x.attrs.b, '\nA')
  assert.equal(x.children[0].children.map(n => n.text).join(''), 't <3 <raw>')
  assert.equal(x.children[1].name, 'z')
  assert.throws(() => parseXML('<a><b></a>'), /does not close/)
  assert.throws(() => parseXML('<a>'), /not closed/)
})

test('media URLs percent-encode spaces and come back relative to the project folder', () => {
  assert.equal(fileURL('/Users/me/Mod Systems/a#1.mp4'), 'file:///Users/me/Mod%20Systems/a%231.mp4')
  const xml = toFCPXML(sample(29.97), ROOT)
  assert.match(xml, /src="file:\/\/\/arya-test\/Mod%20Systems\/Launch%20film\/media\/b%20roll\.mov"/)
  assert.match(xml, /src="file:\/\/\/Volumes\/Archive\/old\.mov"/)
  const back = fromFCPXML(xml, ROOT)
  assert.deepEqual(Object.keys(back.assets).sort(), Object.keys(ASSETS).sort())
})

// ---------------------------------------------------------------- captions

test('SRT: parses numbering, CRLF, BOM, tags and unordered cues; round trips a caption track', () => {
  const srt = '﻿2\r\n00:00:04,500 --> 00:00:06,000\r\n<i>Second</i> {\\an8}line\r\n\r\n1\r\n00:00:01,000 --> 00:00:03,250\r\nFirst\r\nand more\r\n\r\n3\r\n00:00:07,000 --> 00:00:07,000\r\nzero length is dropped\r\n'
  assert.deepEqual(parseSRT(srt), [
    { t: 1, end: 3.25, text: 'First\nand more' },
    { t: 4.5, end: 6, text: 'Second line' },
  ])
  const p = sample(29.97)
  const out = toSRT(p)
  assert.match(out, /^1\n00:00:00,500 --> 00:00:02,002\nFirst caption\n\n2\n/)
  const items = captionItems(p)
  const back = parseSRT(out)
  assert.equal(back.length, items.length)
  back.forEach((c, i) => {
    assert.equal(c.text, items[i].text)
    assert.ok(Math.abs(c.t - items[i].t) < 0.0006 && Math.abs(c.end - items[i].end) < 0.0006)
  })
  assert.throws(() => toSRT(p, 'C9'), /no caption track C9/)
})

test('WebVTT: skips NOTE/STYLE blocks and cue settings, unescapes; round trips with escaping', () => {
  const vtt = 'WEBVTT - made by hand\n\nSTYLE\n::cue { color: red }\n\nNOTE a comment\nover lines\n\nintro\n00:01.000 --> 00:02.500 align:start position:10%\n<v Ann>Hi &amp; welcome</v>\n\n01:00:00.000 --> 01:00:01.000\n<c.loud>Late</c> <00:00:00.500>cue\n'
  assert.deepEqual(parseVTT(vtt), [
    { t: 1, end: 2.5, text: 'Hi & welcome' },
    { t: 3600, end: 3601, text: 'Late cue' },
  ])
  const p = sample(25)
  const out = toVTT(p)
  assert.ok(out.startsWith('WEBVTT\n\n00:00:00.520 --> 00:00:02.040\nFirst caption\n'), out)
  assert.match(out, /Third &amp; last/)
  assert.deepEqual(parseVTT(out).map(c => c.text), captionItems(p).map(c => c.text))
})

test('wordsToCaptions: punctuation joins words, sentences and pauses break, lines stay within limits', () => {
  const words = []
  let t = 0
  const say = (text, gap = 0.05) => {
    words.push({ t, end: t + 0.3, text })
    t += 0.3 + gap
  }
  for (const w of ['Hello', ',', 'world', '.', 'This', 'is', 'a', 'much', 'longer', 'sentence', 'that', 'keeps', 'going', 'well', 'past', 'what', 'one', 'caption', 'line', 'can', 'hold', 'on', 'screen', 'and', 'then', 'some']) say(w)
  say('more', 1.2)
  say('after', 0.05)
  say('the', 0.05)
  say('pause', 0.05)
  say('?')
  const cues = wordsToCaptions(words)
  assert.equal(cues[0].text, 'Hello, world.')
  assert.equal(cues.at(-1).text, 'after the pause?')
  for (const c of cues) {
    const lines = c.text.split('\n')
    assert.ok(lines.length <= 2, c.text)
    assert.ok(lines.every(l => l.length <= 42), c.text)
    assert.ok(c.end - c.t <= 6.001, `${c.text} lasts ${c.end - c.t}`)
  }
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].t - cues[i - 1].end >= 0.0799, 'captions keep a gap')
  // A two-line caption is balanced, not a full line and a stub.
  const two = cues.find(c => c.text.includes('\n'))
  const [l1, l2] = two.text.split('\n')
  assert.ok(Math.abs(l1.length - l2.length) <= 12, two.text)
  // Short words get a readable minimum duration, without running into the next caption.
  const short = wordsToCaptions([{ t: 0, end: 0.2, text: 'Hi.' }, { t: 0.5, end: 0.8, text: 'Bye.' }])
  assert.equal(short[0].end, 0.42)
  assert.equal(short[1].end, 1.2)
  // Contractions and options.
  assert.equal(wordsToCaptions([{ t: 0, end: 0.2, text: 'don' }, { t: 0.2, end: 0.3, text: "'t" }, { t: 0.3, end: 0.5, text: 'go' }])[0].text, "don't go")
  assert.ok(wordsToCaptions(words, { maxChars: 20, maxLines: 1 }).every(c => !c.text.includes('\n') && c.text.length <= 20))
  // whisper.cpp tokens keep a leading space at word starts; without it a token continues the word.
  const tokens = [[' Wel', 1.1, 1.4], ['come', 1.4, 1.6], [' to', 1.65, 1.8], [' Reel', 1.8, 2.1], ['.', 2.1, 2.15]].map(([text, t0, t1]) => ({ t: t0, end: t1, text }))
  assert.equal(wordsToCaptions(tokens)[0].text, 'Welcome to Reel.')
  assert.equal(wordsToCaptions(tokens.map(w => ({ ...w, text: w.text.trim() })))[0].text, 'Wel come to Reel.')
})

test('transcriptToCaptions maps source words to each clip that plays them', () => {
  let p = applyOps(newProject('t', { fps: 25 }), [{ op: 'import', assets: { 'v.mp4': { duration: 30, hasVideo: true, hasAudio: true } } }]).project
  p = applyOps(p, [
    { op: 'add_clip', src: 'v.mp4', track: 'V1', start: 10, in: 2, dur: 3 },
    { op: 'add_clip', src: 'v.mp4', track: 'V1', start: 20, in: 20, dur: 2 },
  ]).project
  p = applyOps(p, [{ op: 'speed', id: 'c1', speed: 2 }]).project // plays source 2..5 over 10..11.5
  const words = [
    { t: 1, end: 1.5, text: 'before.' },
    { t: 2.2, end: 2.6, text: 'Hello' },
    { t: 2.8, end: 3.4, text: 'there.' },
    { t: 4.6, end: 5.2, text: 'edge' },
    { t: 20.5, end: 21, text: 'Later' },
    { t: 21.1, end: 21.5, text: 'on.' },
  ]
  const r = transcriptToCaptions(p, 'v.mp4', words)
  assert.equal(r.placed, true)
  assert.deepEqual(r.clips, ['c1', 'c2']) // the linked audio clips count once
  assert.deepEqual(r.items.map(c => c.text), ['Hello there.', 'edge', 'Later on.'])
  assert.equal(r.items[0].t, 10.1)
  assert.equal(r.items[1].t, 11.3)
  assert.equal(r.items[1].end, 11.5, 'a word cut by the edit ends at the cut, even below the minimum duration')
  assert.equal(r.items[2].t, 20.5)
  assert.deepEqual(transcriptToCaptions(p, 'v.mp4', words, { id: 'c2' }).items.map(c => c.text), ['Later on.'])
  assert.equal(transcriptToCaptions(p, 'other.mp4', words).placed, false)
  assert.throws(() => transcriptToCaptions(p, 'v.mp4', words, { id: 'c9' }), /does not play/)
})

// ---------------------------------------------------------------- FCPXML

for (const fps of [29.97, 25]) {
  test(`FCPXML at ${fps} fps: valid against Final Cut's DTD and lossless through Reel metadata`, () => {
    const p = sample(fps)
    const warnings = []
    const xml = toFCPXML(p, ROOT, { warnings })
    assert.deepEqual(warnings, [])
    const how = validateFCPXML(xml)
    if (fs.existsSync(FCP_DTD)) assert.equal(how, 'dtd')
    assert.match(xml, fps === 29.97 ? /frameDuration="1001\/30000s"/ : /frameDuration="100\/2500s"/)
    const back = fromFCPXML(xml, ROOT)
    assert.deepEqual(frames(back), frames(p))
  })

  test(`FCPXML at ${fps} fps: the structure alone keeps sources, in points, starts, durations, speed and transitions`, () => {
    const p = sample(fps)
    const xml = toFCPXML(p, ROOT, { metadata: false })
    validateFCPXML(xml)
    assert.doesNotMatch(xml, /reel\./)
    const back = fromFCPXML(xml, ROOT)
    assert.equal(back.fps, fps)
    // Without metadata: a linked A/V pair is one clip that plays its own sound, the
    // compound placeholders (color, shape) are empty, and lanes map to tracks in order.
    const linked = new Set(p.tracks.flatMap(t => t.clips).filter(c => c.kind === 'audio' && c.link).map(c => c.id))
    assert.deepEqual(structure(back), structure(p, c => !['color', 'shape'].includes(c.kind) && !linked.has(c.id)))
    const title = back.tracks.flatMap(t => t.clips).find(c => c.kind === 'title')
    assert.equal(title.title.text, 'Hello & <World>\n"quoted"')
    assert.equal(title.title.font, 'Futura')
    assert.equal(title.title.color, '#f5b942')
    const still = back.tracks.flatMap(t => t.clips).find(c => c.kind === 'image')
    assert.equal(still.opacity, 0.5)
    assert.equal(still.scale, 1.2)
    assert.equal(back.tracks.flatMap(t => t.clips).find(c => c.src === 'media/music.wav').volume, -6)
    assert.deepEqual(back.markers.map(m => [Math.round(m.t * fps), m.label, m.kind]), p.markers.map(m => [Math.round(m.t * fps), m.label, m.kind]))
    assert.equal(back.tracks.find(t => t.kind === 'caption').clips.length, 3)
  })
}

test('FCPXML: transitions overlap both clips in the file and land back on the cut', () => {
  const p = sample(29.97)
  const xml = toFCPXML(p, ROOT, { metadata: false })
  const spine = parseXML(xml).children.find(n => n.name === 'fcpxml')
  const seq = (function find(n) {
    for (const c of n.children ?? []) {
      if (c.name === 'spine') return c
      const r = c.name && find(c)
      if (r) return r
    }

    return null
  })(spine)
  const items = seq.children.filter(c => c.name)
  const tr = items.findIndex(c => c.name === 'transition')
  const [before, after] = [items[tr - 1], items[tr + 1]]
  const end = parseTime(before.attrs.offset) + parseTime(before.attrs.duration)
  // 1 s at 29.97 is 30 frames: the previous clip runs 15 frames past the cut, the next starts 15 before.
  assert.equal(Math.round(parseTime(items[tr].attrs.duration) * 30000 / 1001), 30)
  assert.equal(Math.round((end - parseTime(after.attrs.offset)) * 30000 / 1001), 30)
  assert.equal(parseTime(items[tr].attrs.offset), parseTime(after.attrs.offset))
})

test('FCPXML: retimed, reversed and frozen clips survive; transitions without media handles shrink and say so', () => {
  let p = applyOps(newProject('t', { fps: 29.97 }), [{ op: 'import', assets: { 'v.mp4': { duration: 10, width: 1920, height: 1080, fps: 29.97, hasVideo: true, hasAudio: false } } }]).project
  p = applyOps(p, [
    { op: 'add_clip', src: 'v.mp4', track: 'V1', start: 0, in: 6, dur: 4 }, // ends at the end of the media: no handle after
    { op: 'add_clip', src: 'v.mp4', track: 'V1', start: 4, in: 1, dur: 2 },
    { op: 'add_clip', src: 'v.mp4', track: 'V1', start: 6, in: 2, dur: 2 },
    { op: 'add_clip', src: 'v.mp4', track: 'V2', start: 1, in: 0, dur: 3 },
  ]).project
  p = applyOps(p, [
    { op: 'transition', id: 'c2', type: 'dipBlack', dur: 1 },
    { op: 'speed', id: 'c3', speed: 1.5, reverse: true },
    { op: 'speed', id: 'c4', speed: 0.25 },
  ]).project
  p = applyOps(p, [{ op: 'update', id: 'c4', set: { freeze: 0.5 } }]).project
  const warnings = []
  const xml = toFCPXML(p, '/x', { warnings })
  validateFCPXML(xml)
  assert.ok(warnings.some(w => /transition into c2 has no media to overlap/.test(w)), warnings.join('\n'))
  const back = fromFCPXML(xml, '/x')
  assert.deepEqual(frames(back), frames(p))
  const plain = fromFCPXML(toFCPXML(p, '/x', { metadata: false }), '/x')
  const c3 = plain.tracks[0].clips[2]
  assert.equal(c3.speed, 1.5)
  assert.equal(c3.reverse, true)
  assert.equal(Math.round(c3.in * 29.97), Math.round(2 * 29.97))
  assert.equal(plain.tracks[1].clips[0].freeze, 0.5)
  assert.equal(plain.tracks[0].clips[1].transitionIn, undefined)
})

test('FCPXML: overlapping V1 clips, an empty main track and an empty project still export valid files', () => {
  let p = applyOps(newProject('t', { fps: 25 }), [{ op: 'import', assets: { 'v.mp4': { duration: 10, width: 1280, height: 720, fps: 25, hasVideo: true } } }]).project
  p = applyOps(p, [{ op: 'add_clip', src: 'v.mp4', track: 'V1', start: 0, dur: 4 }, { op: 'add_clip', src: 'v.mp4', track: 'V1', start: 6, dur: 2 }]).project
  p = applyOps(p, [{ op: 'move', id: 'c2', start: 2 }]).project
  const warnings = []
  const xml = toFCPXML(p, '/x', { warnings })
  validateFCPXML(xml)
  assert.ok(warnings.some(w => /c2 overlaps/.test(w)))
  assert.deepEqual(frames(fromFCPXML(xml, '/x')), frames(p))

  const upper = applyOps(applyOps(newProject('u', { fps: 25 }), [{ op: 'import', assets: { 'v.mp4': { duration: 10, hasVideo: true } } }]).project, [{ op: 'add_clip', src: 'v.mp4', track: 'V2', start: 3, dur: 2 }]).project
  validateFCPXML(toFCPXML(upper, '/x'))
  assert.deepEqual(frames(fromFCPXML(toFCPXML(upper, '/x'), '/x')), frames(upper))

  const empty = newProject('empty', { fps: 30 })
  validateFCPXML(toFCPXML(empty, '/x'))
  assert.equal(fromFCPXML(toFCPXML(empty, '/x'), '/x').tracks.flatMap(t => t.clips).length, 0)
})

test('FCPXML from Final Cut: timecode starts, overlapping transitions, storylines, compounds, retimes', () => {
  const xml = fs.readFileSync(path.join(FIXTURES, 'fcp-native.fcpxml'), 'utf8')
  validateFCPXML(xml)
  const warnings = []
  const p = fromFCPXML(xml, '/arya-test/Film', { warnings })
  assert.deepEqual(warnings, [])
  assert.equal(p.fps, 23.976)
  assert.equal(p.name, 'Cut 1')
  const f = t => Math.round(t * 24000 / 1001)
  const row = c => [c.id, c.kind, c.src ?? c.title?.text ?? c.text, f(c.start), f(c.dur), c.in === undefined ? null : f(c.in), c.speed ?? 1]
  const track = id => p.tracks.find(t => t.id === id).clips.map(row)
  const interview = '/Volumes/Media/Shoot Day 1/Interview.mov'
  assert.deepEqual(track('V1'), [
    ['c1', 'video', interview, 0, 120, 240, 1], // 1 h timecode start removed from the in point
    ['c2', 'video', 'media/broll.mp4', 120, 96, 48, 1], // the dissolve's 12-frame overlaps trimmed back to the cut
    ['c3', 'video', 'media/broll.mp4', 264, 96, 240, 1], // inside the compound clip
    ['c4', 'video', interview, 360, 48, 480, 0.5],
    ['c5', 'video', 'media/broll.mp4', 408, 48, 0, 1],
  ])
  assert.deepEqual(track('V2'), [
    ['c6', 'title', 'Jane Doe', 24, 48, null, 1],
    ['c7', 'video', 'media/broll.mp4', 228, 24, 0, 1], // connected storyline
    ['c8', 'video', 'media/broll.mp4', 252, 24, 120, 1],
  ])
  assert.deepEqual(track('A1'), [
    ['c9', 'audio', 'media/music.m4a', 0, 360, 0, 1],
    ['c10', 'audio', 'media/broll.mp4', 408, 48, 0, 1],
  ])
  assert.deepEqual(track('C1'), [['c11', 'caption', 'Hello there', 0, 48, null, 1]])
  const clips = p.tracks.flatMap(t => t.clips)
  assert.deepEqual(clips.find(c => c.id === 'c2').transitionIn, { type: 'crossDissolve', dur: 1.001 })
  assert.equal(clips.find(c => c.id === 'c9').volume, -12)
  assert.equal(clips.find(c => c.id === 'c5').mute, true) // the old-style clip's video element carries no sound
  assert.deepEqual(clips.find(c => c.id === 'c6').title, { font: 'Helvetica', weight: 700, size: 63, color: '#ffcc00', align: 'left', anim: 'none', text: 'Jane Doe' })
  assert.deepEqual(p.markers.map(m => [f(m.t), m.label, m.kind]), [[12, 'Beat', 'marker'], [240, 'Act Two', 'chapter']])
  assert.deepEqual(p.assets[interview], { duration: 50.05, width: 1920, height: 1080, fps: 23.976, hasVideo: true, hasAudio: true, channels: 2 })
  assert.equal(p.tracks.find(t => t.kind === 'caption').name, 'Captions en')
})

test('FCPXML import refuses what it cannot read', () => {
  assert.throws(() => fromFCPXML('<xmeml version="5"><sequence/></xmeml>'), /not an FCPXML document/)
  assert.throws(() => fromFCPXML('<fcpxml version="1.11"><resources/><event/></fcpxml>'), /no project/)
  assert.throws(() => fromFCPXML('<fcpxml version="1.11"><resources></fcpxml>'), /does not close/)
})

test('FCPXML captions use the iTT role Final Cut expects', () => {
  const xml = toFCPXML(sample(25), ROOT)
  assert.equal((xml.match(new RegExp(`role="${CAPTION_ROLE.replace(/[?.]/g, '\\$&')}"`, 'g')) ?? []).length, 3)
})

// ---------------------------------------------------------------- OpenTimelineIO

for (const fps of [29.97, 25]) {
  test(`OTIO at ${fps} fps: schema shape, exact rational rates, lossless through Reel metadata`, () => {
    const p = sample(fps)
    const otio = toOTIO(p, ROOT)
    assert.equal(otio.OTIO_SCHEMA, 'Timeline.1')
    assert.equal(otio.tracks.OTIO_SCHEMA, 'Stack.1')
    const rate = fps === 29.97 ? 30000 / 1001 : 25
    const times = []
    const walk = n => {
      if (!n || typeof n !== 'object') return
      if (n.OTIO_SCHEMA === 'RationalTime.1') times.push(n)
      for (const v of Object.values(n)) walk(v)
    }
    walk(otio.tracks)
    assert.ok(times.length > 20)
    assert.ok(times.every(t => t.rate === rate && Number.isInteger(t.value)), 'whole frames at the exact rate')
    const kinds = otio.tracks.children.map(t => `${t.OTIO_SCHEMA}:${t.kind}`)
    assert.deepEqual(kinds, ['Track.1:Video', 'Track.1:Video', 'Track.1:Video', 'Track.1:Audio', 'Track.1:Audio', 'Track.1:Audio'])
    const v1 = otio.tracks.children[0].children.map(c => c.OTIO_SCHEMA)
    assert.deepEqual(v1, ['Clip.2', 'Gap.1', 'Clip.2', 'Transition.1', 'Clip.2', 'Clip.2', 'Clip.2'])
    const retimed = otio.tracks.children[0].children[5]
    assert.deepEqual(retimed.effects.map(e => [e.OTIO_SCHEMA, e.time_scalar]), [['LinearTimeWarp.1', 2]])
    assert.match(otio.tracks.children[0].children[0].media_references.DEFAULT_MEDIA.target_url, /^file:\/\/\/arya-test\/Mod%20Systems\//)
    const back = fromOTIO(JSON.stringify(otio), ROOT)
    assert.deepEqual(frames(back), frames(p))
  })

  test(`OTIO at ${fps} fps: the structure alone keeps sources, in points, starts, durations, speed and transitions`, () => {
    const p = sample(fps)
    const back = fromOTIO(toOTIO(p, ROOT, { metadata: false }), ROOT)
    // Without metadata OTIO keeps every track (no captions: OTIO has none) and links the A/V pairs it can see.
    // A shape has no OTIO form, so without metadata it comes back as a placeholder color.
    assert.deepEqual(structure(back), structure(p, c => c.kind !== 'caption', c => (c.kind === 'shape' ? 'color' : c.kind)))
    const v1 = back.tracks.find(t => t.id === 'V1').clips
    const a1 = back.tracks.find(t => t.id === 'A1').clips
    assert.equal(v1[0].link, a1[0].link)
    assert.ok(v1[0].audioDetached)
    assert.equal(back.tracks.flatMap(t => t.clips).find(c => c.kind === 'title').title.text, 'Hello & <World>\n"quoted"')
    assert.equal(back.tracks.flatMap(t => t.clips).find(c => c.kind === 'color').color, '#336699')
    assert.deepEqual(back.markers.map(m => [Math.round(m.t * fps), m.label, m.note ?? '']), p.markers.map(m => [Math.round(m.t * fps), m.label, m.note ?? '']))
  })
}

test('OTIO from another application: timecode-based ranges, transitions, time warps, markers, offline clips', () => {
  const warnings = []
  const p = fromOTIO(fs.readFileSync(path.join(FIXTURES, 'resolve.otio'), 'utf8'), '/arya-test/Film', { warnings })
  assert.deepEqual(warnings, ['clip "Offline graphic" has no media and is imported as a placeholder color'])
  assert.equal(p.fps, 24)
  const row = c => [c.kind, c.src ?? c.label, c.start * 24, c.dur * 24, c.in === undefined ? null : Math.round(c.in * 24), c.speed ?? 1]
  assert.deepEqual(p.tracks.map(t => [t.id, t.clips.map(row)]), [
    ['V1', [['video', 'media/A001 C002.mov', 0, 96, 48, 1], ['video', 'media/broll.mp4', 96, 72, 24, 1], ['video', '/Volumes/Other/fast.mov', 192, 48, 100, 2]]],
    ['V2', [['color', 'Offline graphic', 24, 48, null, 1]]],
    ['A1', [['audio', 'media/A001 C002.mov', 0, 96, 48, 1]]],
  ])
  assert.deepEqual(p.tracks[0].clips[1].transitionIn, { type: 'crossDissolve', dur: 1 })
  assert.equal(p.tracks[0].clips[0].link, p.tracks[2].clips[0].link)
  assert.deepEqual(p.markers.map(m => [Math.round(m.t * 24), m.label, m.color, m.note]), [[12, 'look here', '#3fb950', 'focus pull'], [200, 'end', '#ff5f57', undefined]])
})

test('OTIO import refuses what is not a timeline', () => {
  assert.throws(() => fromOTIO('{"OTIO_SCHEMA":"Clip.2"}'), /not an OpenTimelineIO timeline/)
  assert.throws(() => fromOTIO('not json'), /JSON/)
})
